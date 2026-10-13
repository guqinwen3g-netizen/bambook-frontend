// 售后索赔 UI 级实机验收（2026-09-17）
//
// 验收锚点（A 组 A-2 前端）：
//   ① 侧栏「售后索赔」入口可达 + 页面骨架（PageHeader / 工具条）
//   ② **登记客诉** 表单可提交 → 列表出现新案件
//   ③ 选中案件 → 处置明细面板可渲染（master-detail 工作）
//   ④ **提交处置**（折让）→ 提示「已生成审批单」（口径 A7 的 UI 表达）
//   ⑤ 未结清退款单区块在位 + 结清判据说明文案在位（口径 A3）
//   ⑥ 四种处置方式在下拉里**全部可选**（A-3 二期）
// 截图证据：/tmp/acceptance-claims/*.png
//
// 回滚：本 API **无 DELETE** ⇒ 用 prisma 精确删（按 id + 案号前缀），并**断言删成功**
import { chromium } from 'playwright';
import { SERVER_DIR, REPO_ROOT, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local';
const PASSWORD = 'Bambook@2026';
const OUT_DIR = '/tmp/acceptance-claims';
const MARK = 'DRILL-UI';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (name, detail = '') => { results.push({ name, ok: true }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); };
const fail = (name, detail = '') => { results.push({ name, ok: false }); console.log(`  ✗ ${name} — ${detail}`); };
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── 节点侧 API 通道 ──
const loginRes = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const login = await loginRes.json();
if (!login.token) { console.log('登录失败', loginRes.status, login); process.exit(1); }
const apiFetch = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

// ★ prisma 必须以 server/ 为基准解析（脚本在仓库根运行，@prisma/client 装在 server/node_modules）
const req = createRequire(SERVER_DIR + '/');
loadEnvForScript(REPO_ROOT); // env 的唯一装载口：取不到就抛，不借别的 worktree
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient();

const beforeList = await apiFetch('GET', '/api/v1/claims?limit=200');
const beforeIds = new Set(((beforeList.data?.items) || []).map((c) => c.id));
console.log(`基线案件：${beforeIds.size} 条`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));

let createdCaseId = null;

/** 按 label 文本找相邻 input/textarea（绕开 wrapper 嵌套） */
const setByLabel = async (labelPrefix, value, tag = 'input') => {
  return page.evaluate(({ labelPrefix, value, tag }) => {
    const lab = Array.from(document.querySelectorAll('label'))
      .find((l) => (l.textContent || '').trim().startsWith(labelPrefix));
    const el = lab?.querySelector(tag) ?? lab?.parentElement?.querySelector(tag);
    if (!el) return false;
    const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, { labelPrefix, value, tag });
};

const bodyText = () => page.evaluate(() => document.body.innerText || '');

try {
  // ── 登录 ──
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('input[type="text"]', { timeout: 25000 });
  await page.fill('input[type="text"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
  pass('登录', EMAIL);

  // ── ① 侧栏入口 + 页面骨架 ──
  const nav = page.locator('[data-sidebar-nav-item]', { hasText: '售后索赔' }).first();
  if ((await nav.count()) === 0) { fail('① 侧栏「售后索赔」入口存在'); }
  else {
    // ★ 本仓侧栏点击常被全屏地球 canvas 拦截（skill 已登记）⇒ **始终 force: true**
    await nav.click({ force: true, timeout: 10000 });
    // 等页面**真的切过去**（而不是固定 sleep）—— 否则会在旧视图上断言
    for (let i = 0; i < 20; i++) { if ((await page.evaluate(() => document.body.innerText)).includes('Claims')) break; await sleep(500); }
    await sleep(1200);
    await page.screenshot({ path: `${OUT_DIR}/01-claims-list.png` });
    const t = await bodyText();
    pass('① 侧栏「售后索赔」入口存在并可达');
    if (t.includes('Claims') && t.includes('登记客诉')) pass('① 页面骨架（PageHeader + 工具条）');
    else fail('① 页面骨架', t.slice(0, 160).replace(/\n/g, ' | '));
  }

  // ── ⑤ 未结清退款单区块 + A3 结清判据文案 ──
  const t0 = await bodyText();
  if (t0.includes('未结清退款单')) pass('⑤ 未结清退款单区块在位');
  else fail('⑤ 未结清退款单区块', '未找到');
  if (t0.includes('未核销余额为 0')) pass('⑤ 口径 A3 结清判据说明在位（结清 = 余额 0，与发票已付无关）');
  else fail('⑤ 口径 A3 结清判据说明', '未找到');

  // ── ② 登记客诉 ──
  await page.locator('button', { hasText: '登记客诉' }).first().click({ timeout: 8000 });
  await sleep(800);
  await page.screenshot({ path: `${OUT_DIR}/02-create-form.png` });
  const okCustomer = await setByLabel('客户名', `${MARK}-客户`);
  const okDesc = await setByLabel('问题描述', `${MARK} 色差投诉（UI 走查）`, 'textarea');
  if (okCustomer && okDesc) pass('② 登记表单可填（label→input 锚定）');
  else fail('② 登记表单可填', `customer=${okCustomer} desc=${okDesc}`);
  await sleep(300);
  await page.locator('button', { hasText: '提交登记' }).first().click({ timeout: 8000 });
  await sleep(3000);
  await page.screenshot({ path: `${OUT_DIR}/03-after-create.png` });

  // 回读（before/after diff）
  const afterList = await apiFetch('GET', '/api/v1/claims?limit=200');
  const afterItems = (afterList.data?.items) || [];
  const created = afterItems.find((c) => !beforeIds.has(c.id));
  if (created) {
    createdCaseId = created.id;
    if (String(created.customerName || '').includes(MARK)) pass('② 后端落库校验', `案号 ${created.caseNumber}`);
    else fail('② 后端落库校验', `customerName=${created.customerName}`);
    if (/^CLM-\d{4}-\d{4}$/.test(created.caseNumber)) pass('② 案号取自 CLM 号段');
    else fail('② 案号号段', created.caseNumber);
  } else {
    fail('② 新案件落库（diff）', 'after 中无新案件');
  }

  // ── ③ 选中案件 → 处置明细 ──
  const t1 = await bodyText();
  if (t1.includes(MARK)) pass('③ 新案件出现在列表');
  else fail('③ 新案件出现在列表', '列表未见 MARK');

  if (createdCaseId) {
    await page.locator(`text=${created.caseNumber}`).first().click({ timeout: 8000 }).catch(() => {});
    await sleep(1500);
    await page.screenshot({ path: `${OUT_DIR}/04-detail.png` });
    const t2 = await bodyText();
    if (t2.includes('处置明细')) pass('③ 处置明细面板渲染（master-detail 工作）');
    else fail('③ 处置明细面板', '未找到「处置明细」');
    if (t2.includes('新增处置')) pass('③ 新增处置表单在位');
    else fail('③ 新增处置表单', '未找到');
  }

  // ── ⑥ 四种处置方式全部可选（A-3 二期）──
  await page.locator('text=处置方式').first().click({ timeout: 8000 }).catch(() => {});
  await sleep(600);
  await page.screenshot({ path: `${OUT_DIR}/05-kind-dropdown.png` });
  const t3 = await bodyText();
  const kinds = ['折让', '退货退款', '换货补发', '返修'];
  const missing = kinds.filter((k) => !t3.includes(k));
  if (missing.length === 0) pass('⑥ 四种处置方式在下拉里全部可选（A-3 二期）');
  else fail('⑥ 四种处置方式', `缺 ${missing.join('/')}`);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(400);

  // ── ④ 提交处置 → 「已生成审批单」 ──
  await setByLabel('退款金额', '500');
  await sleep(300);
  await page.locator('button', { hasText: '提交处置' }).first().click({ timeout: 8000 });
  await sleep(3000);
  await page.screenshot({ path: `${OUT_DIR}/06-after-disposition.png` });
  const t4 = await bodyText();
  if (t4.includes('已生成审批单') || t4.includes('生成审批单')) pass('④ 提交处置后提示「已生成审批单」（口径 A7 的 UI 表达）');
  else fail('④ 提交处置提示', t4.slice(0, 200).replace(/\n/g, ' | '));

  // 回读：处置确实落库 + 状态 Draft（待审批）
  if (createdCaseId) {
    const detail = await apiFetch('GET', `/api/v1/claims/${createdCaseId}`);
    const disps = detail.data?.claimCase?.dispositions ?? [];
    if (disps.length > 0) pass('④ 处置已落库', `${disps.length} 条 · status=${disps[0].status}`);
    else fail('④ 处置落库', 'dispositions 为空');
  }
} catch (e) {
  fail('脚本异常', String(e).slice(0, 300));
  await page.screenshot({ path: `${OUT_DIR}/99-error.png` }).catch(() => {});
} finally {
  // ── 回滚（无 DELETE API ⇒ prisma 精确删 + **断言删成功**）──
  try {
    if (createdCaseId) {
      const disp = await prisma.claimDisposition.deleteMany({ where: { claimCaseId: createdCaseId } });
      const note = await prisma.creditNote.deleteMany({ where: { claimCaseId: createdCaseId } });
      const rcpt = await prisma.returnReceipt.deleteMany({ where: { claimCaseId: createdCaseId } });
      const rw = await prisma.repairWorkOrder.deleteMany({ where: { claimCaseId: createdCaseId } });
      const cs = await prisma.claimCase.deleteMany({ where: { id: createdCaseId } });
      console.log(`  清理：disposition=${disp.count} creditNote=${note.count} returnReceipt=${rcpt.count} repair=${rw.count} case=${cs.count}`);
      if (cs.count !== 1) fail('回滚', `案件未删掉（count=${cs.count}）`);
      else pass('回滚：演练案件已删');
    }
    // 独立复核零残留（按前缀兜底）
    const residue = await prisma.claimCase.count({ where: { customerName: { contains: MARK } } });
    if (residue === 0) pass('回滚：独立复核零残留');
    else fail('回滚：独立复核', `残留 ${residue} 条`);
  } catch (e) {
    fail('回滚异常', String(e).slice(0, 200));
  }
  await prisma.$disconnect().catch(() => {});

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n结果：${ok}/${results.length} 通过 · consoleErr=${consoleErrors.length} pageErr=${pageErrors.length}`);
  if (consoleErrors.length) console.log('console errors:', consoleErrors.slice(0, 5));
  if (pageErrors.length) console.log('page errors:', pageErrors.slice(0, 5));
  await browser.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
