/**
 * 鉴权中间件改动后的真机冒烟（commit feb0112）
 *
 * 改动了 extractActorFromRequest（内部守卫补 token 类型校验）——它影响**每一个内部请求**。
 * 单元测试全绿不等于运行态没问题（「不会误伤」是靠读代码得出的结论，必须运行时验证）。
 *
 * 做法：真实浏览器登录 → 逐个点开主要模块 → 统计 4xx / 页面异常 / 数据是否渲染。
 *
 * 用法：先确保 8081 已用新代码重启（kill 旧 pid → npm run dev → 核对新 pid + health 响应体），
 * ts-node 无 watch。然后 node scripts/smoke-auth-middleware.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BAMBOOK_BASE || 'http://127.0.0.1:3000';
const EMAIL = process.env.BAMBOOK_EMAIL || 'jason.shen@bambook.local';
const PASSWORD = process.env.BAMBOOK_PASSWORD || 'Bambook@2026';

/** 主要模块：导航文案 → 用于判定「数据是否渲染」的关键词 */
const VIEWS = [
  { nav: '订单管理', expect: /PO-|订单/ },
  { nav: '客户关系管理', expect: /CUS-|客户|暂无/ },
  { nav: '财务管理', expect: /INV-|发票|暂无/ },
  { nav: '货运管理', expect: /运单|暂无|SHP/ },
  { nav: '供应商管理', expect: /供应商|暂无/ },
  { nav: '开发管理', expect: /开发|暂无/ },
];

const browser = await chromium.launch();
const page = await browser.newPage();

const fourXx = [];
const pageErrors = [];
page.on('response', (res) => {
  if (res.status() < 400) return;
  const u = res.request().url();
  if (!/\/api\//.test(u) || u.includes('openfreemap')) return;
  const h = res.request().headers();
  fourXx.push({
    status: res.status(),
    url: u.split('?')[0].replace(BASE, ''),
    auth: h.authorization ? 'Bearer' : '(none)',
  });
});
page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 160)));

// ── 登录 ──
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const emailInput = page.locator('input:not([type=password])').first();
await emailInput.click();
await emailInput.fill(EMAIL);
const pwdInput = page.locator('input[type=password]').first();
await pwdInput.click();
await pwdInput.fill(PASSWORD);
await pwdInput.press('Enter');
await page.waitForTimeout(9000);

const loggedIn = await page.evaluate(() =>
  Boolean(localStorage.getItem('bambook_auth_token') || sessionStorage.getItem('bambook_auth_token')));
console.log(loggedIn ? '✓ 登录成功（内部 token 已签发）' : '✗ 登录失败 —— 中间件可能误伤了内部 token');
if (!loggedIn) { await browser.close(); process.exit(1); }

// ── 逐模块 ──
let bad = 0;
for (const v of VIEWS) {
  const before = fourXx.length;
  const clicked = await page.evaluate((label) => {
    const hit = [...document.querySelectorAll('button, a, [role=button]')]
      .find((b) => (b.innerText || '').trim() === label);
    if (hit) { hit.click(); return true; }
    return false;
  }, v.nav);
  if (!clicked) { console.log(`  ? 未找到导航「${v.nav}」，跳过`); continue; }
  await page.waitForTimeout(3500);
  const added = fourXx.length - before;
  const text = await page.evaluate(() => document.body.innerText || '');
  const rendered = v.expect.test(text);
  const stuck = /读取数据中心/.test(text);
  const ok = added === 0 && rendered && !stuck;
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${v.nav.padEnd(8)} 4xx=${added} 数据渲染=${rendered} 卡loading=${stuck}`);
}

// ── 汇总 ──
console.log('\n===== 汇总 =====');
console.log(`4xx 总数：${fourXx.length}`);
if (fourXx.length) {
  const uniq = new Map();
  for (const f of fourXx) uniq.set(`${f.status} ${f.url} auth=${f.auth}`, (uniq.get(`${f.status} ${f.url} auth=${f.auth}`) || 0) + 1);
  for (const [k, n] of uniq) console.log(`  ×${n}  ${k}`);
}
console.log(`页面异常：${pageErrors.length}`);
for (const e of pageErrors.slice(0, 5)) console.log(`  ! ${e}`);
console.log(bad === 0 && fourXx.length === 0 ? '\n结果：通过（内部请求未被误伤）' : `\n结果：${bad} 个模块异常`);

await browser.close();
