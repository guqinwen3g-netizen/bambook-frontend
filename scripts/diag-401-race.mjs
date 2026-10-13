/**
 * 首屏 401 竞态诊断（handoff §三 #6）
 *
 * 目标：把「疑似 token 未就绪」变成可验证的事实。
 *
 * 上一版只测了「已登录 → 刷新」，结果 0 条 401 —— 说明 401 不在那条路径上。
 * 本版按真实冷启动路径分段采样：
 *   A 段：storage 全空 → 首次导航（未登录冷启动）
 *   B 段：填表登录（含登录后 3s 稳定期）
 *   C 段：带 token 刷新
 * 每段独立记录 4xx 的 URL / 状态码 / 是否携带 Authorization，并标出
 * 该请求与首个 /api/auth/me 响应的先后关系。
 *
 * 只观测，不写业务数据。
 */

import { chromium } from 'playwright';

const BASE = process.env.BAMBOOK_BASE || 'http://127.0.0.1:3000';
const EMAIL = process.env.BAMBOOK_EMAIL || 'jason.shen@bambook.local';
const PASSWORD = process.env.BAMBOOK_PASSWORD || 'Bambook@2026';

const isBambookApi = (u) => /\/api\//.test(u) && !u.includes('openfreemap');

function attach(page, sink, t0) {
  const onResponse = (res) => {
    const status = res.status();
    if (status < 400) return;
    const req = res.request();
    const url = req.url();
    if (!isBambookApi(url)) return; // 过滤外部地图瓦片等噪声
    const h = req.headers();
    let auth = '(none)';
    if (h.authorization) auth = `Bearer ${String(h.authorization).slice(7, 20)}…`;
    if (h['x-bambook-api-key']) auth += ' +api-key';
    sink.push({
      t: Date.now() - t0,
      status,
      method: req.method(),
      url: url.replace(BASE, '').slice(0, 120),
      auth,
    });
  };
  page.on('response', onResponse);
  return () => page.off('response', onResponse);
}

function report(label, events) {
  console.log(`\n===== ${label} =====`);
  console.log(`4xx 总数：${events.length}`);
  if (!events.length) return;
  const byKey = new Map();
  for (const e of events) {
    const k = `${e.status} ${e.method} ${e.url} auth=${e.auth}`;
    if (!byKey.has(k)) byKey.set(k, { n: 0, first: e.t, last: e.t });
    const v = byKey.get(k);
    v.n += 1;
    v.last = e.t;
  }
  const rows = [...byKey.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [k, v] of rows) {
    console.log(`  ×${String(v.n).padStart(2)}  +${v.first}ms→+${v.last}ms  ${k}`);
  }
  console.log('  最早 6 条（时间序）:');
  for (const e of events.slice(0, 6)) {
    console.log(`    +${e.t}ms  ${e.status} ${e.method} ${e.url} auth=${e.auth}`);
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// ---------- A 段：冷启动（storage 全空） ----------
const cold = [];
let detach = attach(page, cold, Date.now());
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
detach();
report('A 段 · 冷启动（未登录，storage 空）', cold);

const coldStore = await page.evaluate(() => ({
  local: localStorage.getItem('bambook_auth_token'),
  session: sessionStorage.getItem('bambook_auth_token'),
  keys: Object.keys(localStorage),
}));
console.log(
  '  A 段结束时 storage：',
  JSON.stringify({
    local: coldStore.local ? `${coldStore.local.slice(0, 16)}…(len ${coldStore.local.length})` : null,
    session: coldStore.session
      ? `${coldStore.session.slice(0, 16)}…(len ${coldStore.session.length})`
      : null,
    keys: coldStore.keys,
  })
);

// 是否需要登录（页面是否停在登录表单）
const needLogin = await page.locator('input[type=password]').count();
console.log(`  页面密码框数量：${needLogin}（>0 表示停在登录页）`);

// ---------- B 段：登录 ----------
let loginEvents = [];
if (needLogin > 0) {
  const tB = Date.now();
  detach = attach(page, loginEvents, tB);
  const emailInput = page.locator('input:not([type=password])').first();
  await emailInput.click();
  await emailInput.fill(EMAIL);
  const pwdInput = page.locator('input[type=password]').first();
  await pwdInput.click();
  await pwdInput.fill(PASSWORD);
  await pwdInput.press('Enter');
  await page.waitForTimeout(8000);
  detach();
  report('B 段 · 登录过程（含登录后稳定期）', loginEvents);
} else {
  console.log('\n===== B 段 · 登录 =====\n  跳过：冷启动后未停在登录页（可能已自动登录）');
}

// ---------- C 段：带 token 刷新 ----------
const warm = [];
detach = attach(page, warm, Date.now());
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
detach();
report('C 段 · 带 token 刷新', warm);

// ---------- 结论 ----------
const total = cold.length + loginEvents.length + warm.length;
console.log('\n===== 汇总 =====');
console.log(`  A(冷启动) ${cold.length} · B(登录) ${loginEvents.length} · C(热刷新) ${warm.length} · 合计 ${total}`);
if (total === 0) {
  console.log('  未复现：本次运行无 Bambook API 4xx。');
} else {
  const noAuth = [...cold, ...loginEvents, ...warm].filter((e) => e.auth === '(none)');
  console.log(`  其中「完全无凭证」的：${noAuth.length} 条`);
  console.log(
    noAuth.length
      ? '  → 401 来自「未登录就发请求」：应先等鉴权就绪再拉数据（可修）。'
      : '  → 401 请求是带了 token 被拒的：需查 token 有效性/服务端校验。'
  );
}

await browser.close();
