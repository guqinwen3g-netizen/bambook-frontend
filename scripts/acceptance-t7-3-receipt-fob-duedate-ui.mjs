// T7-③ 到期日门槛 —— 核对工作台 UI 级实机验收（2026-09-16）
//
// 为什么需要：门槛会在「未到期」时**压掉**「收汇不足」的差异。若不显式说明，
// 界面上的「0 差异」会被读成「对账通过」——而真相是「还没到期，未判定」。
// 本脚本在真浏览器里证明这个说明**确实渲染**，且随到期日翻转而切换。
//
// 验收锚点：
//   U1 核对 tab 可达
//   U2 自建演练单（到期日在未来）出现在对象下拉里
//   U3 未到期 → 卡片显式提示「尚未到期，收汇不足暂不预警」
//   U4 未到期 → 差异区文案为「尚未到收款期 —— 收汇不足暂不预警（不等于「已一致」）」
//   U5 把到期日改为过去 → 同一单重跑 → 提示切换为「已到期，收汇不足照常预警」
//   U6 已到期 → 差异区出现「尚无收汇记录」预警（口径 D：severity 恒 warning，不出现阻断性红）
//
// 自回滚：finally 里按精确 ID 硬删演练行（createRequire 以 server/ 为基准解析）。
// 用法：node scripts/acceptance-t7-3-receipt-fob-duedate-ui.mjs
import { chromium } from 'playwright';
import { SERVER_DIR, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import fs from 'fs';

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local';
const PASSWORD = 'Bambook@2026';
const OUT_DIR = '/tmp/acceptance-t7-3-duedate-ui';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n} — ${d}`); };
fs.mkdirSync(OUT_DIR, { recursive: true });

const dayOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const TODAY = dayOffset(0);
const FUTURE = dayOffset(30);
const PAST = dayOffset(-30);

const TS = Date.now();
const ORDER_ID = `ORD__DRILL_DUEUI_${TS}`;
const ORDER_CODE = `DRILL-DUEUI-${TS}`;
const CD_ID = `CD__DRILL_DUEUI_${TS}`;
const CD_NO = `DRILL-CDUI-${TS}`;
const INV_ID = `INV__DRILL_DUEUI_${TS}`;
const INV_NO = `DRILL-INVUI-${TS}`;
const FOB = 10000;

let prisma = null;
const created = { order: false, cd: false, invoice: false };

async function connectPrisma() {
  const { createRequire } = await import('node:module');
  const req = createRequire(SERVER_DIR + '/');
// ★ G-3c 第 11 批复核处置（BLOCK-2）：构造 client 之前先把**本仓**那份 env 装上；取不到就抛 ENV_MISSING，
//   宁可拒跑也不让 Prisma 去借别的 worktree 的 env（此前 19/21 是这么被借走的）。
loadEnvForScript();
  const { PrismaClient } = req('@prisma/client');
  prisma = new PrismaClient();
}

async function seed() {
  const now = BigInt(Date.now());
  await prisma.order.create({
    data: {
      id: ORDER_ID, code: ORDER_CODE, customer: 'DRILL-DUEUI-CUSTOMER', product: 'DRILL-DUEUI-PRODUCT',
      type: 'Export', quantity: 1, status: 'InProduction', dueDate: dayOffset(60),
      quoteAmount: FOB, currency: 'USD', updatedAt: now,
      // Order.createdAt 是 DateTime @default(now())（与其它模型的 BigInt 不同）→ 交默认值
    },
  });
  created.order = true;
  await prisma.customsDeclaration.create({
    data: {
      id: CD_ID, declarationNumber: CD_NO, orderId: ORDER_ID,
      type: 'Export', status: 'Released', tradeTerms: 'FOB',
      totalValue: FOB, currency: 'USD', createdAt: now, updatedAt: now,
    },
  });
  created.cd = true;
  await prisma.invoice.create({
    data: {
      id: INV_ID, invoiceNumber: INV_NO, type: 'Receivable', status: 'Issued',
      amount: FOB, currency: 'USD', issueDate: TODAY, dueDate: FUTURE,
      orderId: ORDER_ID, customerName: 'DRILL-DUEUI-CUSTOMER', createdAt: now, updatedAt: now,
    },
  });
  created.invoice = true;
}

async function setDueDate(d) {
  await prisma.invoice.update({ where: { id: INV_ID }, data: { dueDate: d, updatedAt: BigInt(Date.now()) } });
}

async function rollback() {
  try {
    const gone = [];
    if (created.invoice) { await prisma.invoice.delete({ where: { id: INV_ID } }); gone.push('invoice'); }
    if (created.cd) { await prisma.customsDeclaration.delete({ where: { id: CD_ID } }); gone.push('cd'); }
    if (created.order) { await prisma.order.delete({ where: { id: ORDER_ID } }); gone.push('order'); }
    pass('回滚：硬删演练行', gone.join(' / ') || '（无）');
  } catch (e) {
    fail('回滚失败', `${e?.message} —— 需手工清理 ${ORDER_ID} / ${CD_ID} / ${INV_ID}`);
  }
}

/** 点精确文本的 button（避免 hasText 子串误匹配，如「核对」撞「开始核对」） */
async function clickExactText(page, text) {
  return page.evaluate((t) => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim() === t);
    if (!btn) return false;
    btn.click();
    return true;
  }, text);
}

/** 找最内层「包含某段文本」的元素（skill：别用 locator('text=')，会匹配最外层容器） */
async function hasInnerText(page, needle) {
  return page.evaluate((n) => {
    const cands = Array.from(document.querySelectorAll('div,span'))
      .filter(d => (d.innerText || '').includes(n));
    if (!cands.length) return false;
    return cands.some(d => !Array.from(d.children).some(c => (c.innerText || '').includes(n)));
  }, needle);
}

let browser = null;
async function main() {
  console.log('══ T7-③ 到期日门槛 · 核对工作台 UI 走查 ══\n');
  await connectPrisma();
  await seed();
  pass('建演练数据', `${ORDER_CODE}｜报关 FOB ${FOB} USD｜应收发票到期 ${FUTURE}｜今天 ${TODAY}`);

  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const login = await loginRes.json();
  if (!login.token) { fail('登录', `HTTP ${loginRes.status}`); return; }

  // 演练单必须出现在工作台对象下拉里（工作台取 /v1/orders?limit=50，默认按 updatedAt desc）
  const listRes = await fetch(`${API}/api/v1/orders?limit=50`, { headers: { Authorization: `Bearer ${login.token}` } });
  const listData = await listRes.json().catch(() => ({}));
  const rows = listData?.items ?? listData?.orders ?? listData?.data ?? [];
  const pos = rows.findIndex(r => r.id === ORDER_ID);
  if (pos >= 0) pass('U2 演练单在下拉数据源内', `第 ${pos + 1}/${rows.length} 位`);
  else { fail('U2 演练单不在下拉数据源', `前 ${rows.length} 条里找不到 ${ORDER_CODE} —— UI 无法选到，后续锚点会失败`); return; }

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('input[type="text"]', { timeout: 25000 });
  await page.fill('input[type="text"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-sidebar-nav-item]', { timeout: 30000 });
  pass('登录', EMAIL);

  // 地球底图 pointer-events:auto 会拦点击 → force 绕开（skill 已登记为 actionability 误报）
  await page.locator('[data-sidebar-nav-item]', { hasText: '财务管理' }).first().click({ force: true, timeout: 15000 });
  await sleep(2500);
  await clickExactText(page, '核对');
  await sleep(2000);
  await page.screenshot({ path: `${OUT_DIR}/01-consistency-tab.png` });
  if (await hasInnerText(page, '选择对象后点')) pass('U1 核对 tab 可达');
  else info('U1 核对 tab', '未看到空态提示（可能已有历史结果），继续');

  // ── 选演练单 ────────────────────────────────────────────────────────
  const trigger = page.locator('[data-select-trigger][aria-label="选择核对对象"]');
  await trigger.click();
  await sleep(800);
  const drillOpt = page.locator('[role="option"]', { hasText: ORDER_CODE }).first();
  if (await drillOpt.count() === 0) {
    fail('U2 下拉里选到演练单', `下拉中无 ${ORDER_CODE}`);
    await page.screenshot({ path: `${OUT_DIR}/02-select-open.png` });
  } else {
    await drillOpt.click();
    await sleep(900);
    const shown = (await trigger.innerText().catch(() => '')).trim();
    if (shown.includes(ORDER_CODE)) pass('U2 下拉里选到演练单', shown.slice(0, 40));
    else fail('U2 选中未生效', `触发器显示：${shown.slice(0, 40)}`);
  }

  // ── U3/U4 未到期 ────────────────────────────────────────────────────
  await clickExactText(page, '开始核对');
  await sleep(4000);
  await page.screenshot({ path: `${OUT_DIR}/03-not-yet-due.png` });
  if (await hasInnerText(page, '尚未到期，收汇不足暂不预警')) pass('U3 未到期提示已渲染');
  else fail('U3 未到期提示', '未出现「尚未到期，收汇不足暂不预警」');
  if (await hasInnerText(page, '尚未到收款期')) pass('U4 差异区文案正确（不等于「已一致」）');
  else fail('U4 差异区文案', '未出现「尚未到收款期」');
  const cardOk = await hasInnerText(page, '收汇 ↔ 报关 FOB');
  if (cardOk) pass('U3b 收汇↔FOB 卡片已渲染');
  else fail('U3b 卡片', '未出现「收汇 ↔ 报关 FOB」');

  // ── U5/U6 改为已到期后重跑（同一单，只动 dueDate → 因果对照）──────────
  await setDueDate(PAST);
  await clickExactText(page, '开始核对');
  await sleep(4000);
  await page.screenshot({ path: `${OUT_DIR}/04-past-due.png` });
  if (await hasInnerText(page, '已到期，收汇不足照常预警')) pass('U5 到期提示切换为「已到期」');
  else fail('U5 到期提示', '未出现「已到期，收汇不足照常预警」');
  if (await hasInnerText(page, '尚无收汇记录')) pass('U6 已到期 → 差异照报（「尚无收汇记录」）');
  else fail('U6 差异照报', '未出现「尚无收汇记录」');
  const danger = await page.evaluate(() => document.querySelectorAll('.bds-alert.danger').length);
  if (danger === 0) pass('U6b 无阻断性红（口径 D：只预警不阻断）');
  else fail('U6b 口径', `出现 ${danger} 处 bds-alert.danger`);

  await page.screenshot({ path: `${OUT_DIR}/05-final.png` });
  if (consoleErrors.length <= 5) pass('控制台 error 未异常增长', `${consoleErrors.length} 条`);
  else fail('控制台 error', `${consoleErrors.length} 条：${consoleErrors.slice(0, 2).join(' | ')}`);
}

try {
  await main();
} catch (e) {
  fail('脚本异常', String(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  await rollback();
  const ok = results.filter(r => r.ok === true).length;
  const bad = results.filter(r => r.ok === false).length;
  const notes = results.filter(r => r.ok === null).length;
  console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
  console.log(`截图：${OUT_DIR}/`);
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(bad === 0 ? 0 : 1);
}
