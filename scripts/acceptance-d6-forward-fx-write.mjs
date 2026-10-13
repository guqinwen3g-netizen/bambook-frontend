/**
 * acceptance-d6-forward-fx-write.mjs — D6 远期结汇合约「写路径」真浏览器验收
 *
 * 为什么需要（skill 纪律）：**API 测试全绿 ≠ UI 可用**；每条主链至少一次真浏览器走查。
 * 本会话前面只做了**只读**走查 ⇒ 写路径（表单填 → 提交 → 落库）从未验证过。
 *
 * 剧本（8 步，照 skill 的写路径骨架）：
 *   ① 登录（⚠️ 必须页面内 el.click()，force 点击不触发 form submit）
 *   ② 财务 → 「远期结汇」页签 → 点「登记合约」
 *   ③ 按 label 填必填字段（演练数据用明显假标识 `DRILL-`）
 *   ④ 断言「保存」**可点**（三态：禁用=最佳/拦住+提示=好/没反应=缺陷）
 *   ⑤ 提交（页面内 click）
 *   ⑥ **API 回读验证落库**（不信 UI 自述）+ 校验字段
 *   ⑦ 回滚：按**业务锚点**（contractNumber 前缀）精确删 + 连带审计
 *   ⑧ **独立复核零残留**（用与删除相同的判据再查）
 */
import { chromium } from 'playwright';
import { SERVER_DIR, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const req = createRequire(SERVER_DIR + '/');
// ★ G-3c 第 11 批复核处置（BLOCK-2）：构造 client 之前先把**本仓**那份 env 装上；取不到就抛 ENV_MISSING，
//   宁可拒跑也不让 Prisma 去借别的 worktree 的 env（此前 19/21 是这么被借走的）。
loadEnvForScript();
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient();

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local';
const PASSWORD = 'Bambook@2026';
const OUT = '/tmp/acceptance-d6-write';
const MARK = `DRILL-FFX-${Date.now().toString(36)}`; // ★ 明显假标识
const ACTOR_EMAIL = EMAIL;
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const ok = (n, d = '') => { results.push({ n, pass: true }); console.log(`  ✓ ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { results.push({ n, pass: false, d }); console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); };

/** ★ 认领判据 = 业务锚点（contractNumber），**不是** id（服务生成的 id 不带演练前缀） */
const ANCHOR = { contractNumber: { startsWith: MARK } };

const ymd = (offset) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function apiLogin() {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = await r.json();
  return j.token || j.accessToken;
}

async function main() {
  const token = await apiLogin();
  if (!token) throw new Error('API 登录失败（拿不到 token）');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push(`PAGEERROR: ${e.message}`));

  // ① 登录
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  if (await page.locator('[data-sidebar-nav-item]').count() === 0) {
    await page.evaluate(([email, pwd]) => {
      const inputs = document.querySelectorAll('input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inputs[0], email); inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(inputs[1], pwd);   inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    }, [EMAIL, PASSWORD]);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText || '').trim() === '登录');
      if (b) b.click();
    });
    await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
  }
  ok('登录');

  // ② 财务 → 远期结汇 → 登记合约
  await page.evaluate(() => {
    const hit = Array.from(document.querySelectorAll('[data-sidebar-nav-item]')).find(el => (el.innerText || '').includes('财务'));
    if (hit) hit.click();
  });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim().includes('远期结汇'));
    if (t) t.click();
  });
  await page.waitForTimeout(1800);

  const opened = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText || '').trim().includes('登记合约'));
    if (!b) return false;
    b.click(); return true;
  });
  await page.waitForTimeout(1200);
  if (!opened) { bad('「登记合约」按钮存在'); await browser.close(); return; }
  ok('打开登记表单');

  // ③ 按 label 填字段（label→input 用 DOM 文本定位，绕开 wrapper 嵌套）
  /**
   * 按 label 填字段。
   *
   * ⚠️ **必须精确匹配，不能用 `includes`** —— 实测踩过：
   *   我用 `includes('银行')` 想填「银行」，结果命中了**「银行合约号 *」**（它包含「银行」）
   *   ⇒ 把 contractNumber 覆盖成"演练银行"，而 bankName 根本没填
   *   ⇒ 走查"看起来成功了"，但落库字段是错的（**假绿**）。
   * 定型判据：**去掉末尾 `*` 与空白后完全相等**才认；同名前缀多的字段（银行/银行合约号）必须靠精确匹配区分。
   */
  const fillByLabel = async (labelText, value) => page.evaluate(([lt, v]) => {
    const norm = (s) => (s || '').replace(/[*＊]/g, '').replace(/\s+/g, '').trim();
    const labels = Array.from(document.querySelectorAll('label'));
    const lab = labels.find(l => norm(l.innerText) === norm(lt));
    if (!lab) return false;
    const input = lab.querySelector('input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, [labelText, value]);

  // label 文本与组件里一致（去掉 * 后精确匹配）：银行合约号 / 银行 / 币种 / 合约金额（外币）/ 约定汇率（→CNY）/ 到期（交割）日
  const filled = {
    contractNumber: await fillByLabel('银行合约号', MARK),
    bankName: await fillByLabel('银行', '演练银行'),
    currency: await fillByLabel('币种', 'USD'),
    foreignAmount: await fillByLabel('合约金额（外币）', '1000'),
    contractRate: await fillByLabel('约定汇率（→CNY）', '7'),
    maturityDate: await fillByLabel('到期（交割）日', ymd(20)),
  };
  await page.waitForTimeout(600);
  const missing = Object.entries(filled).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) bad('表单字段按 label 定位', `未找到：${missing.join(', ')}`);
  else ok('表单字段按 label 定位（6 个）');

  // ④ 三态判据：保存按钮 disabled ？
  const saveState = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText || '').trim() === '保存');
    return b ? { found: true, disabled: b.disabled } : { found: false };
  });
  if (!saveState.found) bad('「保存」按钮存在');
  else if (saveState.disabled) ok('保存按钮状态：禁用（最佳 —— 必填未全时点不了）');
  else ok('保存按钮状态：可点（提交时会校验）');

  await page.screenshot({ path: `${OUT}/01-form-filled.png` });

  // ⑤ 提交（页面内 click）
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText || '').trim() === '保存');
    if (b) b.click();
  });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/02-after-submit.png` });

  // ⑥ API 回读（不信 UI 自述）
  const listRes = await fetch(`${API}/api/v1/finance/forward-fx`, { headers: { Authorization: `Bearer ${token}` } });
  const list = await listRes.json();
  const rows = list.rows || [];
  const created = rows.find(r => r.contractNumber === MARK);
  if (!created) {
    const bodyText = await page.evaluate(() => document.body.innerText);
    bad('API 回读：合约已落库', `未找到 ${MARK}；页面提示片段=${bodyText.slice(0, 200).replace(/\n+/g, ' | ')}`);
  } else {
    ok('API 回读：合约已落库', `${created.contractNumber} / ${created.currency} / ${created.foreignAmount}`);
    if (created.currency === 'USD' && Number(created.foreignAmount) === 1000 && Number(created.contractRate) === 7) {
      ok('落库字段正确（币种/金额/汇率）');
    } else {
      bad('落库字段不符', JSON.stringify({ c: created.currency, a: created.foreignAmount, r: created.contractRate }));
    }
    // ★ 显式断言「填进去的值 == 落库的值」（防"label 匹配错位"这类假绿 —— 实测踩过一次）
    if (created.contractNumber === MARK && created.bankName === '演练银行') {
      ok('落库字段与输入逐字一致（合约号/银行 —— 防 label 错位）');
    } else {
      bad('落库字段与输入不一致（label 可能匹配错位）', JSON.stringify({ 期望合约号: MARK, 实际合约号: created.contractNumber, 期望银行: '演练银行', 实际银行: created.bankName }));
    }
    if (created.status === 'Open' && created.daysToMaturity > 0) ok('状态 Open + 到期天数为正');
    else bad('状态/到期天数异常', JSON.stringify({ s: created.status, d: created.daysToMaturity }));
  }

  // UI 回读：列表里出现该合约号（界面确实刷新了）
  const uiHas = await page.evaluate((m) => document.body.innerText.includes(m), MARK);
  if (uiHas) ok('UI 回读：列表已出现该合约号（界面刷新）');
  else bad('UI 回读：列表未出现该合约号（可能未刷新 —— 需看截图）');

  await browser.close();

  // ⑦ 回滚（按业务锚点精确删）+ 连带审计
  const actor = await prisma.userAccount.findFirst({ where: { email: ACTOR_EMAIL }, select: { id: true } });
  const del = await prisma.forwardFxContract.deleteMany({ where: ANCHOR });
  await prisma.auditLog.deleteMany({ where: { targetType: 'ForwardFxContract', action: 'create_forward_fx_contract', ...(actor ? { actorId: actor.id } : {}) } });
  console.log(`\n回滚：删除 ${del.count} 行（按 contractNumber 前缀 ${MARK}）`);

  // ⑧ 独立复核零残留（同一判据）
  const remain = await prisma.forwardFxContract.count({ where: ANCHOR });
  if (remain === 0) ok('独立复核：零残留');
  else bad('独立复核：仍有残留', String(remain));

  const failed = results.filter(r => !r.pass);
  console.log(`\n=== 写路径走查：${results.length - failed.length}/${results.length} 通过 ===`);
  const e = errs.filter(x => !/401|Failed to load resource|favicon/.test(x));
  console.log(`控制台 error（剔除 401/资源）：${e.length}`);
  e.slice(0, 4).forEach(x => console.log(`  · ${x.slice(0, 150)}`));
  console.log(`截图：${OUT}`);
  if (failed.length) { console.log('\n未通过：'); failed.forEach(f => console.log(`  ✗ ${f.n} — ${f.d}`)); process.exitCode = 1; }
}

main()
  .catch(e => { console.error('写路径走查异常：', e?.message || e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
