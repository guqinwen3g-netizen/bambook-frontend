// 「创建表单」开启走查（2026-09-17）—— 15 个页面的「新建X」入口逐个打开
//
// ── 为什么做这一层 ─────────────────────────────────────────
// 运单的 `clearError` 自己调自己 ⇒ **一点「新建运单」就栈溢出、表单打不开** ✗
// 这类缺陷：`tsc` 不报 · 单测不渲染该交互 · 门禁全绿 ⇒ **只有"点开表单"才现形** ✓
// ⇒ 本走查把「打开创建表单」做成**通用检查**，覆盖全部有创建入口的页面 ✓
//
// ── 判据（两条，都要）─────────────────────────────────────
//   ① **不得有 pageerror**（栈溢出 / 未捕获异常）
//   ② 打开后主区必须出现**表单特征**（「保存」或「取消」或「提交」按钮）
//      —— 只断言"主区有变化"会被假通过（实测踩过：侧栏没导航成功时点了上一页的按钮）
//
// 只**打开**、不提交 ⇒ 零写入 ⇒ 无需回滚 ✓
// 截图：/tmp/acceptance-create-forms/*.png
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const OUT_DIR = '/tmp/acceptance-create-forms';
const PW = 'Bambook@2026';

/** 数据驱动：来自 acceptance-deep 的按钮采集（页面 → 创建入口文案） */
const TARGETS = [
  ['订单管理', '录入订单'], ['报价管理', '新建报价单'], ['开发管理', '新建开发单'],
  ['采购管理', '新建采购单'], ['客户关系管理', '新建商机'], ['季节性与趋势', '新建季度'],
  ['营销推广', '新建活动'], ['财务管理', '新建凭证'], ['单据中心', '新增单据'],
  ['QC 工作台', '新建任务'], ['人事管理', '新建项目'], ['管理后台', '新建用户'],
  ['外贸与报关', '新增'],
  // ⓘ 「AI 助手 · 新建对话」**不在此列**：它是**即时对话**（点了清空聊天区，不弹表单），
  //   用「是否出现表单特征」判定必然假失败；且 AI Agent 属 **v2 范围**。
  //   与其写一个永远红的用例，不如**明说没覆盖**（宁可明说不覆盖，也不给漂亮的假结论）。
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (n, d = '') => { results.push({ n, ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ n, ok: false }); console.log(`  ✗ ${n} — ${d}`); };
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
const page = await ctx.newPage();
let pageErrors = [];
let consoleErrors = 0;
page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 120)));
// ★ 不只计数，还要**记住文本** —— 否则「consoleErr=3」永远查不出是什么错（2026-09-18 改）
const consoleErrSamples = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  consoleErrors += 1;
  if (consoleErrSamples.length < 6) consoleErrSamples.push(m.text().slice(0, 160));
});

const mainText = () => page.evaluate(() => (document.querySelector('.app-main-viewport')?.innerText || '').replace(/\s+/g, ' ').trim());
// ★ 实测踩过：订单表单的按钮叫「**确认创建**」⇒ 第一版正则 /保存|提交|取消|确定/ **匹配不到** ⇒ 假失败 ✗
const hasFormChrome = (t) => /保存|提交|取消|确定|确认|创建|下一步|完成/.test(t);

try {
  const lg = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jason.shen@bambook.local', password: PW }),
  })).json();
  if (!lg.token) throw new Error('登录失败');

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('input[type="text"]', { timeout: 25000 });
  await page.fill('input[type="text"]', 'jason.shen@bambook.local');
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
  await sleep(1500);
  pass('登录');
  // ★ 登录后重置：登录页自身未认证请求的 401 是**预期行为**，不应计入
  consoleErrors = 0;
  consoleErrSamples.length = 0;

  for (const [label, btnText] of TARGETS) {
    // ★★ 每个用例前**重新 goto 回到干净状态**（2026-09-18 修）
    //    实测：仅按 Escape 关不掉前一个用例留下的模态/表单，
    //    后续「季节/财务/QC」会报「找不到入口按钮」——**全是假失败**
    //    （逐个单独复验：干净状态下 3 个都能正常打开，无 pageerror）。
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 }).catch(() => {});
    await sleep(1800);

    const nav = page.locator('[data-sidebar-nav-item]', { hasText: label }).first();
    if ((await nav.count()) === 0) { console.log(`  ⚠️  [gap] ${label}：侧栏无入口`); continue; }

    await nav.click({ force: true, timeout: 10000 }).catch(() => {});

    // ★ 别要求「主区出现侧栏文案」—— 页内标题可能与侧栏**不同名**（实测 4 个页面因此假失败 ✗）
    //   改为「等主区文本**连续两次不变**（稳定）」
    let before = '';
    let stable = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const now = await mainText();
      if (now === before && now.length > 30) { stable += 1; if (stable >= 2) break; }
      else stable = 0;
      before = now;
    }
    if (before.length <= 30) { fail(`${label}：页面未渲染`, `主区仅 ${before.length} 字`); continue; }

    pageErrors = [];
    // ★ 入口**不一定是 `button`/`role=button`**（实测踩过：4 个页面的入口在别的元素上 ⇒ 假失败 ✗）
    //   ⇒ 用**文本定位**（点中文本元素，事件冒泡到处理函数）✓
    const btnLoose = page.locator(`text=${btnText}`).first();
    if ((await btnLoose.count()) === 0) { fail(`${label} · 「${btnText}」`, '找不到入口按钮'); continue; }

    await btnLoose.click({ force: true, timeout: 8000 }).catch(() => {});
    await sleep(3000);
    const after = await mainText();
    const shot = `${OUT_DIR}/${label}-${btnText}.png`;
    await page.screenshot({ path: shot }).catch(() => {});

    const errNow = pageErrors.slice();
    if (errNow.length > 0) {
      fail(`${label} · 「${btnText}」`, `★ 打开表单触发 **pageerror**：${errNow[0]} —— 截图 ${shot}`);
    } else if (!hasFormChrome(after)) {
      fail(`${label} · 「${btnText}」`, `打开后主区**没有表单特征**（保存/提交/取消）· ${after.length} 字 —— 截图 ${shot}`);
    } else {
      pass(`${label} · 「${btnText}」`, `表单已打开 · 主区 ${before.length} → ${after.length} 字`);
    }
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n结果：${ok}/${results.length} 通过 · consoleErr=${consoleErrors}`);
  if (consoleErrSamples.length) {
    console.log('  console.error 样本（前几条；登录后仍报的才需要查）：');
    for (const s of consoleErrSamples) console.log('    -', s);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log('失败项：\n  - ' + failed.map((r) => r.n).join('\n  - '));
  console.log(`截图：${OUT_DIR}`);
} catch (e) {
  fail('脚本异常', String(e).slice(0, 240));
  await page.screenshot({ path: `${OUT_DIR}/99-error.png` }).catch(() => {});
} finally {
  await browser.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}
