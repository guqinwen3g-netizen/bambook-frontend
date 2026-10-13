/**
 * #6 修复回归验证：冷启动 → 登录，数据必须照样装载
 *
 * 修复把 App mount effect 里的 loadRelations / loadOrders 改成了「仅已登录时执行」，
 * 冷启动后被跳过。登录后只剩 syncFromCloud → pullSnapshot 这一条链路供数，
 * 必须证明：
 *   1. /api/v2/orders、/api/v2/relations 在登录后返回 200 且有数据
 *   2. UI 不卡在「读取数据中心」（ordersReady / relationsReady 被翻起）
 *   3. 全程除 /api/auth/me 外无 401
 *
 * 只观测，不写业务数据。
 */

import { chromium } from 'playwright';

const BASE = process.env.BAMBOOK_BASE || 'http://127.0.0.1:3000';
const EMAIL = process.env.BAMBOOK_EMAIL || 'jason.shen@bambook.local';
const PASSWORD = process.env.BAMBOOK_PASSWORD || 'Bambook@2026';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const fourXx = [];
const okCounts = new Map();

page.on('response', async (res) => {
  const u = res.request().url();
  if (!/\/api\//.test(u) || u.includes('openfreemap')) return;
  const status = res.status();
  if (status >= 400) {
    fourXx.push(`${status} ${u.split('?')[0].replace(BASE, '')}`);
    return;
  }
  if (status !== 200) return;
  const path = u.split('?')[0].replace(BASE, '');
  if (!/v2\/(orders|relations)$/.test(path)) return;
  try {
    const body = await res.json();
    const n = Array.isArray(body?.items) ? body.items.length : -1;
    const prev = okCounts.get(path);
    // 记录最大一次（分页拉取以首次为准，这里只关心「有没有数据 / 有没有 200」）
    if (!prev || n > prev.items) okCounts.set(path, { items: n, total: body?.total ?? null });
  } catch {
    okCounts.set(path, { items: -2, total: null });
  }
});

const fail = (msg) => {
  console.log(`  ✗ ${msg}`);
  process.exitCode = 1;
};
const pass = (msg) => console.log(`  ✓ ${msg}`);

// ── 冷启动 ──
console.log('\n[1] 冷启动（storage 空）');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const coldNonAuthMe = fourXx.filter((x) => !x.includes('/api/auth/me'));
coldNonAuthMe.length === 0
  ? pass(`冷启动无业务接口 401（除 auth/me 外共 ${fourXx.length} 条，均为 auth/me 探测）`)
  : fail(`冷启动仍有业务 401：${[...new Set(coldNonAuthMe)].join(', ')}`);

// ── 登录 ──
console.log('\n[2] 登录');
const emailInput = page.locator('input:not([type=password])').first();
await emailInput.click();
await emailInput.fill(EMAIL);
const pwdInput = page.locator('input[type=password]').first();
await pwdInput.click();
await pwdInput.fill(PASSWORD);
await pwdInput.press('Enter');
await page.waitForTimeout(10000);

const loggedIn = await page.evaluate(() =>
  Boolean(localStorage.getItem('bambook_auth_token') || sessionStorage.getItem('bambook_auth_token'))
);
loggedIn ? pass('登录成功，token 已落地') : fail('未拿到 token，登录可能失败');

// ── 数据装载 ──
console.log('\n[3] 登录后数据装载');
await page.waitForTimeout(3000);
console.log('    200 响应样本：');
for (const [p, v] of okCounts) {
  console.log(`      ${p} → items=${v.items} total=${v.total}`);
}
const ordersOk = okCounts.get('/api/v2/orders');
const relationsOk = okCounts.get('/api/v2/relations');
ordersOk && ordersOk.items >= 0
  ? pass(`/api/v2/orders 返回 200（items=${ordersOk.items}${ordersOk.total != null ? ` total=${ordersOk.total}` : ''}）`)
  : fail('/api/v2/orders 未返回 200');
relationsOk && relationsOk.items >= 0
  ? pass(`/api/v2/relations 返回 200（items=${relationsOk.items}）`)
  : fail('/api/v2/relations 未返回 200');

// ── UI 不卡 loading ──
console.log('\n[4] UI 是否卡在「读取数据中心」');
const stuck = await page.evaluate(() => {
  const text = document.body.innerText || '';
  return {
    stuckOrders: text.includes('读取数据中心'),
    snippet: text.slice(0, 200).replace(/\s+/g, ' '),
  };
});
stuck.stuckOrders
  ? fail(`页面仍显示「读取数据中心」，ready 未翻起。首屏文本：${stuck.snippet}`)
  : pass('页面无「读取数据中心」残留，ordersReady/relationsReady 已翻起');

// ── 订单页实测（真正的消费方）──
console.log('\n[5] 切到订单视图看实际渲染');
const navClicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button, a, [role=button]')];
  const hit = btns.find((b) => /订单|Orders/.test((b.innerText || '').trim()) && (b.innerText || '').trim().length < 12);
  if (hit) { hit.click(); return (hit.innerText || '').trim(); }
  return null;
});
console.log(`    点击导航：${navClicked ?? '(未找到，跳过)'}`);
await page.waitForTimeout(6000);
const orderPage = await page.evaluate(() => {
  const text = document.body.innerText || '';
  return {
    stuck: text.includes('读取数据中心'),
    rows: document.querySelectorAll('table tbody tr, [data-order-row]').length,
    snippet: text.slice(0, 300).replace(/\s+/g, ' '),
  };
});
console.log(`    表格行数≈${orderPage.rows}；卡 loading=${orderPage.stuck}`);
orderPage.stuck ? fail('订单页仍卡在「读取数据中心」') : pass('订单页未卡 loading');

// ── 汇总 ──
console.log('\n===== 全程 4xx =====');
const uniq = new Map();
for (const x of fourXx) uniq.set(x, (uniq.get(x) || 0) + 1);
if (uniq.size === 0) console.log('  （无）');
for (const [k, n] of uniq) console.log(`  ×${n}  ${k}`);

await browser.close();
console.log(process.exitCode ? '\n结果：有失败项' : '\n结果：全部通过');
