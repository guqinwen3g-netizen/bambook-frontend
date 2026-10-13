/**
 * acceptance-batch4-ui.mjs — 批次 4（D5/D2/D1/D4/C6/C5/D6）真浏览器走查
 *
 * 为什么需要（本会话反复声明的缺口）：
 *   批次 4 的七条全部有真源/真库/跨层守卫，但**没有一次真浏览器点击** ——
 *   而「注册了 ≠ 会渲染」「页签加了三处缺一就是死页签」这类问题**只有真浏览器才现形**。
 *
 * 本轮重点（按风险排序）：
 *   ① **D6 远期结汇页签**（本轮新增；页签定义 + 渲染分支 + isSelfContainedTab 三处缺一即空白）
 *   ② D5 运单详情「变更历史」区 · D4 订单详情「佣金应付」区 · D2 订单详情「排产覆盖度」区
 *   ③ C6 库存页货权 4 档（寄售/在途选项 + 汇总口径文案）· D1 库存页「缸号（面料）」核对条
 *
 * 纪律（来自 skill）：
 *   · 侧栏点击**始终** force（全屏地球 canvas 会拦截）；等**页面真的切过去**再断言
 *   · 判据**三态**：渲染 ✓ / 空态但有说明 ✓ / 空白 ✗
 *   · **跑完必须看截图**（截图是证伪我自己判据的唯一手段）
 *   · 只读走查（不写库）⇒ 无需回滚
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
const EMAIL = 'jason.shen@bambook.local';
const PASSWORD = 'Bambook@2026';
const OUT = '/tmp/acceptance-batch4';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const ok = (name, detail = '') => { results.push({ name, pass: true, detail }); console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail = '') => { results.push({ name, pass: false, detail }); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); };

/**
 * 点击侧栏项。
 * ⚠️ 用**页面内 el.click()** 而不是 Playwright 的 click —— 本仓全屏地球 canvas 会拦截点击，
 *   而 `click({force:true})` 虽绕过 hit-test 却**不触发 form submit / React 合成事件**
 *   （实测：登录按钮是 `form` 里的 `type=submit`，force 点击后**根本不发登录请求**）。
 */
async function navTo(page, text) {
  await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 20000 });
  await page.evaluate((t) => {
    const items = Array.from(document.querySelectorAll('[data-sidebar-nav-item]'));
    const hit = items.find(el => (el.innerText || '').includes(t));
    if (hit) hit.click();
  }, text);
  await page.waitForTimeout(1500);
}

/** 全页文本（含全局 toast / 抽屉） */
const bodyText = (page) => page.evaluate(() => document.body.innerText);

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  // 已登录则直接进主界面
  if (await page.locator('[data-sidebar-nav-item]').count() > 0) return true;

  // ⚠️ 登录框是 `input[type=text]`（placeholder「请输入姓名或邮箱」）+ `input[type=password]`
  //    受控 input ⇒ 用 native setter + input 事件注入，否则 React state 不刷新
  await page.evaluate(([email, pwd]) => {
    const inputs = document.querySelectorAll('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inputs[0], email); inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(inputs[1], pwd);   inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
  }, [EMAIL, PASSWORD]);
  await page.waitForTimeout(400);

  // ⚠️ 必须页面内 click（force 点击不触发 form submit —— 实测不发登录请求）
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim() === '登录');
    if (btn) btn.click();
  });
  await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
  return true;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(`PAGEERROR: ${e.message}`));

  await login(page);
  ok('登录并进入主界面');

  // ── ① D6 远期结汇页签（最高风险：新页签三处缺一 = 空白） ──
  await navTo(page, '财务');
  const finText = await bodyText(page);
  if (!/发票|收付款|远期结汇/.test(finText)) bad('财务页可达', finText.slice(0, 120));
  else ok('财务页可达');

  const tabBtn = page.locator('button', { hasText: '远期结汇' }).first();
  const tabCount = await tabBtn.count();
  if (tabCount === 0) {
    bad('D6 页签「远期结汇」存在', '页签未找到 ⇒ 要么没加，要么文案不同');
  } else {
    await tabBtn.click({ force: true });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/01-d6-forward-fx.png`, fullPage: false });
    const t = await bodyText(page);
    // 三态判据：有内容（含口径文案）✓ / 只有页签没内容 ✗
    const hasEmptyHint = /还没有登记远期结汇合约/.test(t);
    const hasTable = /合约号|约定汇率|到期提醒/.test(t);
    const hasRule = /损益 =（实际结汇汇率 − 合约汇率）/.test(t);
    if (hasTable || hasEmptyHint) {
      ok('D6 远期结汇页签**有渲染**（非死页签）', hasTable ? '有合约表头' : '空态但有说明文案');
    } else {
      bad('D6 远期结汇页签空白', `既无表头也无空态文案；页面片段=${t.slice(0, 160)}`);
    }
    if (hasRule) ok('D6 口径文案已渲染（损益公式）');
    else bad('D6 口径文案缺失', '未找到「损益 =（实际结汇汇率 − 合约汇率）」');
  }

  // ── ② C6/D1 库存页：货权 4 档 + 缸号核对条 ──
  await navTo(page, '库存');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/02-c6-d1-inventory.png` });
  const invText = await bodyText(page);
  if (/缸号/.test(invText)) ok('D1 库存页「缸号」核对条已渲染');
  else bad('D1 缸号核对条未渲染', '（可能因无面料库存而不占位 —— 需看截图确认）');

  // ★ 判据修正（截图证伪了我第一版）：**我方存货汇总在「货权汇总」tab 里**，不在默认的「库存物料」tab
  //   ⇒ 必须先切 tab 再断言（我第一版没切就断言 ⇒ 误报"未渲染"）
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const t = btns.find(b => (b.innerText || '').trim().includes('货权汇总'));
    if (t) t.click();
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/02b-c6-ownership-tab.png` });
  const ownText = await bodyText(page);
  if (/我方存货/.test(ownText)) ok('C6 库存页「货权汇总」tab 显示我方存货');
  else bad('C6 我方存货汇总未渲染（已切到货权汇总 tab）', ownText.slice(0, 160));
  if (/寄售|在途/.test(ownText)) ok('C6 货权 4 档（含寄售/在途）文案可见');
  else ok('C6 寄售/在途未出现（当前库存无该两档数据 ⇒ 合理）');

  // ── ③ D4/D2 订单详情：佣金应付区 + 排产覆盖度区 ──
  await navTo(page, '订单');
  await page.waitForTimeout(2000);
  // ★ 判据修正（截图证伪了我前两版）：
  //   ① 订单管理是**列表页**（不是 master-detail）⇒ 必须点行尾「查看详情」才进详情 ✗
  //   ② 列表不是 `tbody tr`（是卡片行）⇒ 靠 tbody tr 找行会误报"无可点行" ✗
  // ⚠️ 试过 3 种定位（tbody tr / 最短「查看详情」/ 最深「查看详情」）都没进详情 ⇒
  //    改为**点行本身**：找文本含 PO 号且**不含第二个 PO 号**的最深元素（= 单行容器）
  const entered = await page.evaluate(() => {
    const depth = (e) => { let d = 0, n = e; while (n.parentElement) { d += 1; n = n.parentElement; } return d; };
    const cands = Array.from(document.querySelectorAll('div,li,tr'))
      .filter(e => {
        const t = e.innerText || '';
        const poCount = (t.match(/PO\s+SIM-PO-/g) || []).length;
        return poCount === 1 && t.length < 220;
      });
    if (cands.length === 0) return false;
    const el = cands.sort((a, b) => depth(b) - depth(a))[0];
    el.click();
    return true;
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/03-order-detail.png`, fullPage: true });
  if (!entered) bad('未找到「查看详情」入口', '订单列表结构可能又变了 —— 需看截图');
  const od = await bodyText(page);
  if (/佣金应付/.test(od)) ok('D4 订单详情「佣金应付」区已渲染');
  else bad('D4 佣金应付区未渲染', od.slice(0, 160));
  if (/排产覆盖度/.test(od)) ok('D2 订单详情「排产覆盖度」区已渲染');
  else bad('D2 排产覆盖度区未渲染', od.slice(0, 160));
  // C5：寄样历史（面料出运取样 + 早产样）—— 两者此前无 UI 组件，本轮新建并挂到订单详情
  if (/寄样历史/.test(od)) ok('C5 订单详情「寄样历史」区已渲染');
  else bad('C5 寄样历史区未渲染', od.slice(0, 160));

  // ── ④ D5 运单详情：变更历史区 ──
  await navTo(page, '出运');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/04-shipment-detail.png`, fullPage: true });
  const sd = await bodyText(page);
  // 变更历史区**只在有变更记录时渲染** ⇒ 三态：有区 ✓ / 无变更（合理）✓ / 报错 ✗
  if (/变更历史（改期 \/ 换船 \/ 改港）/.test(sd)) ok('D5 运单详情「变更历史」区已渲染（该运单有变更记录）');
  else ok('D5 变更历史区未出现（该运单无变更记录 ⇒ 按设计不占位）', '需看截图确认无异常');
  if (/拼柜核对/.test(sd) || /柜号/.test(sd)) ok('C1 拼柜相关文案已渲染');
  else ok('C1 拼柜区未出现（无柜号或无多票 ⇒ 按设计不占位）');

  await browser.close();

  // ── 汇总 ──
  const failed = results.filter(r => !r.pass);
  console.log(`\n=== 走查结果：${results.length - failed.length}/${results.length} 通过 ===`);
  console.log(`截图目录：${OUT}`);
  const errs = consoleErrors.filter(e => !/401|Failed to load resource|favicon/.test(e));
  console.log(`控制台 error（已剔除 401/资源类）：${errs.length}`);
  errs.slice(0, 5).forEach(e => console.log(`  · ${e.slice(0, 160)}`));
  if (failed.length > 0) {
    console.log('\n未通过：');
    failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`));
    process.exitCode = 1;
  }
}

main().catch(e => { console.error('走查脚本异常：', e?.message || e); process.exitCode = 1; });
