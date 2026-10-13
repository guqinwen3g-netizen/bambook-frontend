// 核对工作台 UI 级实机验收（2026-09-16）
// 验收锚点：
//   ① 财务模块「核对」tab 可达（侧栏 财务管理 → 核对）
//   ② 订单路径：选订单 → 开始核对 → 收汇↔报关 FOB 卡片渲染
//   ③ 运单路径：切运单 → 开始核对 → 三单一致卡片渲染（含单据齐备行）
//   ④ 报关单路径：切报关单 → 开始核对 → 退税报缺 + 成交方式两张卡片渲染（并行取数）
//   ⑤ 差异/缺项卡片渲染为 warning 色阶（**不出现阻断性红**——口径：只预警不阻断）
//   ⑥ 控制台 error 不异常增长
// 截图证据：/tmp/acceptance-consistency-workbench/*.png
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local';
const PASSWORD = 'Bambook@2026';
const OUT_DIR = '/tmp/acceptance-consistency-workbench';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (name, detail = '') => { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); };
const fail = (name, detail = '') => { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); };
fs.mkdirSync(OUT_DIR, { recursive: true });

/** 点精确文本的 button（避免 hasText 子串误匹配，如「核对」撞「开始核对」） */
async function clickExactText(page, text) {
  return page.evaluate((t) => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => (b.innerText || '').trim() === t);
    if (!btn) return false;
    btn.click();
    return true;
  }, text);
}

/** 找最内层「精确包含某段文本」的元素是否存在（skill 提示：别用 locator('text=')，会匹配最外层容器） */
async function hasInnerText(page, needle) {
  return page.evaluate((n) => {
    const cands = Array.from(document.querySelectorAll('div,span'))
      .filter(d => (d.innerText || '').includes(n));
    if (!cands.length) return false;
    // 取最内层（无子元素含同样文本）
    return cands.some(d => !Array.from(d.children).some(c => (c.innerText || '').includes(n)));
  }, needle);
}

const loginRes = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const login = await loginRes.json();
if (!login.token) { console.log('登录失败', loginRes.status, login); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));

try {
  // ── ① 登录 + 导航到财务管理 ──
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('input[type="text"]', { timeout: 25000 });
  await page.fill('input[type="text"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
  pass('登录', EMAIL);

  const nav = page.locator('[data-sidebar-nav-item]', { hasText: '财务管理' }).first();
  // 地球底图 pointer-events:auto 会拦点击 → force 绕开（skill 已登记为 actionability 误报）
  await nav.click({ force: true, timeout: 15000 });
  await sleep(2500);
  await page.screenshot({ path: `${OUT_DIR}/01-finance.png` });

  // ── ① 切「核对」tab（精确文本，避免撞「开始核对」）──
  const tabOk = await clickExactText(page, '核对');
  await sleep(1500);
  await page.screenshot({ path: `${OUT_DIR}/02-consistency-tab.png` });
  if (tabOk && await hasInnerText(page, '选择对象后点')) pass('① 核对 tab 可达（空态提示可见）');
  else if (tabOk) pass('① 核对 tab 可达');
  else fail('① 核对 tab', '未找到精确文本为「核对」的按钮');

  // ── ② 订单路径：默认类型=订单 → 开始核对 → 收汇↔FOB 卡片 ──
  const runOk1 = await clickExactText(page, '开始核对');
  await sleep(4000);
  await page.screenshot({ path: `${OUT_DIR}/03-order-receipt-fob.png` });
  if (!runOk1) fail('② 开始核对按钮', '未找到');
  else if (await hasInnerText(page, '收汇 ↔ 报关 FOB')) pass('② 订单路径 → 收汇↔报关 FOB 卡片渲染');
  else fail('② 订单路径卡片', '未出现「收汇 ↔ 报关 FOB」卡片');

  // ── ③ 运单路径 ──
  const shipTab = await clickExactText(page, '运单');
  await sleep(3000); // 切类型会重载下拉列表
  const runOk2 = await clickExactText(page, '开始核对');
  await sleep(4000);
  await page.screenshot({ path: `${OUT_DIR}/04-shipment-triple.png` });
  if (shipTab && runOk2 && await hasInnerText(page, '三单一致')) pass('③ 运单路径 → 三单一致卡片渲染');
  else fail('③ 运单路径', `切tab=${shipTab} 核对=${runOk2}`);

  // ── ④ 报关单路径（退税报缺 + 成交方式，工作台内是 Promise.all 并行）──
  const declTab = await clickExactText(page, '报关单');
  await sleep(3000);
  const runOk3 = await clickExactText(page, '开始核对');
  await sleep(5000);
  await page.screenshot({ path: `${OUT_DIR}/05-declaration-two-cards.png` });
  const hasGaps = await hasInnerText(page, '退税报缺');
  const hasInc = await hasInnerText(page, '成交方式一致性');
  if (declTab && runOk3 && hasGaps && hasInc) pass('④ 报关单路径 → 退税报缺 + 成交方式 两张卡片同时渲染（并行取数）');
  else fail('④ 报关单路径', `切tab=${declTab} 核对=${runOk3} gaps=${hasGaps} incoterm=${hasInc}`);

  // ── ⑦ CustomSelect 下拉交互（切对象 → 选中生效 → 结果随之刷新）──
  //    首版走查用的是默认选中项，没验交互本身；此处补上（skill 清单要求的 CustomSelect 而非原生 select）
  const trigger = page.locator('[data-select-trigger][aria-label="选择核对对象"]');
  const beforeText = (await trigger.innerText().catch(() => '')).trim();
  await trigger.click();
  await sleep(700);
  const optionCount = await page.locator('[role="option"]').count();
  if (optionCount > 1) pass('⑦a 下拉可展开（CustomSelect）', `${optionCount} 个选项`);
  else fail('⑦a 下拉展开', `选项数 ${optionCount}`);
  await page.screenshot({ path: `${OUT_DIR}/07a-select-open.png` });

  // 选第 3 项（与默认第 1 项不同 → 验证「选中真的生效」而非仅高亮）
  if (optionCount > 2) {
    await page.locator('[role="option"]').nth(2).click();
    await sleep(900);
    const afterText = (await trigger.innerText().catch(() => '')).trim();
    if (afterText && afterText !== beforeText) pass('⑦b 选中生效（触发器文本变化）', `${beforeText.slice(0, 26)} → ${afterText.slice(0, 26)}`);
    else fail('⑦b 选中生效', `文本未变化：${afterText.slice(0, 40)}`);

    // 换对象后重新核对，结果区应能刷新（新对象也跑通）
    const runOk4 = await clickExactText(page, '开始核对');
    await sleep(5000);
    await page.screenshot({ path: `${OUT_DIR}/07b-after-reselect.png` });
    if (runOk4 && (await hasInnerText(page, '退税报缺') || await hasInnerText(page, '成交方式一致性'))) pass('⑦c 换对象后核对仍可用');
    else fail('⑦c 换对象后核对', `run=${runOk4}`);
  }

  // ── ⑤ 口径：差异用 warning 色阶，不出现阻断性红 ──
  // 判定方式：差异卡片区域不应出现 bds-alert danger / 红色语义类
  const dangerCount = await page.evaluate(() => {
    const zone = document.body;
    const alerts = zone.querySelectorAll('.bds-alert.danger').length;
    return alerts;
  });
  if (dangerCount === 0) pass('⑤ 无阻断性红（bds-alert danger = 0；差异走 warning 色阶）');
  else fail('⑤ 口径', `页面出现 ${dangerCount} 处 bds-alert.danger`);

  // ── ⑥ 控制台 ──
  await page.screenshot({ path: `${OUT_DIR}/06-final.png`, fullPage: false });
  if (consoleErrors.length <= 5) pass('⑥ 控制台 error 未异常增长', `${consoleErrors.length} 条`);
  else fail('⑥ 控制台 error', `${consoleErrors.length} 条：${consoleErrors.slice(0, 2).join(' | ')}`);
} catch (e) {
  fail('脚本异常', String(e).slice(0, 300));
  await page.screenshot({ path: `${OUT_DIR}/99-error.png` }).catch(() => {});
} finally {
  const ok = results.filter(r => r.ok).length;
  console.log(`\n结果：${ok}/${results.length} 通过 · consoleErr=${consoleErrors.length} pageErr=${pageErrors.length}`);
  if (pageErrors.length) console.log(`  pageErr: ${pageErrors.slice(0, 3).join(' | ')}`);
  console.log(`截图：${OUT_DIR}/`);
  await browser.close();
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
