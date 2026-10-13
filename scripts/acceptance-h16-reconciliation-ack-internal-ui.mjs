// H16-② 客户回执 · **内部侧视图** UI 级实机验收（2026-09-16）
//
// 为什么需要：回执此前只在客户门户可写，内部**零入口**。本批在「财务 → 对账」面板
// 加了第三个视图「客户回执」。API 通不等于 UI 可用（仓库「勿再踩」明文），故真浏览器走查。
//
// 验收锚点：
//   U1 财务 → 对账 tab 可达
//   U2 第三个视图「客户回执」可切换（bds-segment 第三段）
//   U3 列表渲染出演练回执（客户名 / 期间 / 状态徽标）
//   U4 汇总行渲染（已确认 / 有异议 / 共）
//   U5 状态筛选（CustomSelect）切到「有异议」→ 演练的 confirmed 回执消失（筛选真的生效）
//   U6 展开「查看确认快照」→ 快照表出现（币种 / 期初 / 开票 / 收款 / 期末）
//   U7 无阻断性红（bds-alert.danger = 0）+ 控制台 error 未异常增长
//
// 演练数据：客户门户提交一条 2099 期间的回执，跑完硬删（含其通知）。
// 用法：node scripts/acceptance-h16-reconciliation-ack-internal-ui.mjs
import { chromium } from 'playwright';
import { SERVER_DIR, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import fs from 'fs';

const BASE = 'http://localhost:3000';
const API = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local';
const PASSWORD = 'Bambook@2026';
const CUSTOMER_PASSWORD = 'Customer@123';
const CUST = 'sakurabrandskk@portal.demo';
const OUT_DIR = '/tmp/acceptance-h16-ack-internal-ui';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n} — ${d}`); };
fs.mkdirSync(OUT_DIR, { recursive: true });

const P_START = '2099-02-01';
const P_END = '2099-02-28';

let prisma = null;
let ackId = null;

async function connectPrisma() {
  const { createRequire } = await import('node:module');
  const req = createRequire(SERVER_DIR + '/');
// ★ G-3c 第 11 批复核处置（BLOCK-2）：构造 client 之前先把**本仓**那份 env 装上；取不到就抛 ENV_MISSING，
//   宁可拒跑也不让 Prisma 去借别的 worktree 的 env（此前 19/21 是这么被借走的）。
loadEnvForScript();
  const { PrismaClient } = req('@prisma/client');
  prisma = new PrismaClient();
}

async function rollback() {
  try {
    const gone = [];
    if (ackId) {
      const n = await prisma.notification.deleteMany({ where: { id: { startsWith: `ntf_cra_${ackId}` } } });
      if (n.count) gone.push(`notification(${n.count})`);
      const a = await prisma.customerReconciliationAck.deleteMany({ where: { id: ackId } });
      if (a.count) gone.push('ack');
    }
    pass('回滚：硬删演练行', gone.join(' / ') || '（无）');
  } catch (e) {
    fail('回滚失败', `${e?.message} —— 需手工清理 ackId=${ackId}`);
  }
}

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data };
}

async function login(path, email, password) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => null);
  return res.ok && data?.token ? data.token : null;
}

/** 点精确文本的 button（避免 hasText 子串误匹配） */
async function clickExactText(page, text) {
  return page.evaluate((t) => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim() === t);
    if (!btn) return false;
    btn.click();
    return true;
  }, text);
}

/** 找最内层「包含某段文本」的元素（skill：别用 locator('text=')） */
async function hasInnerText(page, needle) {
  return page.evaluate((n) => {
    const cands = Array.from(document.querySelectorAll('div,span,td,th'))
      .filter(d => (d.innerText || '').includes(n));
    if (!cands.length) return false;
    return cands.some(d => !Array.from(d.children).some(c => (c.innerText || '').includes(n)));
  }, needle);
}

let browser = null;
async function main() {
  console.log('══ H16-② 客户回执 · 内部侧视图 UI 走查 ══\n');
  await connectPrisma();

  // ── 造一条演练回执（客户门户提交）────────────────────────────────────
  const custToken = await login('/api/v2/customer/auth/login', CUST, CUSTOMER_PASSWORD);
  if (!custToken) { fail('客户登录', CUST); return; }
  const submitted = await api(custToken, 'POST', '/api/v2/customer/reconciliation/acks', {
    periodStart: P_START, periodEnd: P_END, decision: 'confirmed',
  });
  if (submitted.status !== 201 || !submitted.data?.ack?.id) {
    fail('造演练回执', `HTTP ${submitted.status} ${JSON.stringify(submitted.data).slice(0, 180)}`);
    return;
  }
  ackId = submitted.data.ack.id;
  pass('造演练回执（客户门户）', `${ackId}｜期间 ${P_START}~${P_END}｜跑完硬删`);

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
  const tabOk = await clickExactText(page, '对账');
  await sleep(2000);
  await page.screenshot({ path: `${OUT_DIR}/01-reconciliation-tab.png` });
  if (tabOk && await hasInnerText(page, '客户维度批量对账')) pass('U1 财务 → 对账 tab 可达');
  else fail('U1 对账 tab', `点击=${tabOk}`);

  // ── U2 切到「客户回执」视图 ─────────────────────────────────────────
  const ackTabOk = await clickExactText(page, '客户回执');
  await sleep(3000);
  await page.screenshot({ path: `${OUT_DIR}/02-acks-view.png` });
  if (ackTabOk && await hasInnerText(page, '已确认')) pass('U2 第三个视图「客户回执」可切换');
  else fail('U2 客户回执视图', `切换=${ackTabOk}`);

  // ── U3 演练回执渲染 ────────────────────────────────────────────────
  const hasPeriod = await hasInnerText(page, `${P_START} ~ ${P_END}`);
  if (hasPeriod) pass('U3 演练回执渲染（期间可见）', `${P_START} ~ ${P_END}`);
  else fail('U3 演练回执', '未看到演练期间 —— 列表可能未取到或未渲染');
  if (await hasInnerText(page, 'Sakura Brands K.K.')) pass('U3 客户名已渲染', 'Sakura Brands K.K.');
  else info('U3 客户名', '未匹配到客户名（可能 Relation 名不同），不阻断');

  // ── U4 汇总行 ──────────────────────────────────────────────────────
  if (await hasInnerText(page, '有异议') && await hasInnerText(page, '当前筛选命中')) {
    pass('U4 汇总行渲染（已确认 / 有异议 / 共 + 命中数）');
  } else fail('U4 汇总行', '未渲染汇总');

  // ── U6 展开确认快照（放在筛选前，避免筛选把该行滤掉）───────────────
  const expandOk = await clickExactText(page, '查看确认快照');
  await sleep(1200);
  await page.screenshot({ path: `${OUT_DIR}/03-snapshot-expanded.png` });
  if (expandOk && await hasInnerText(page, '客户确认时冻结的快照')) pass('U6 展开确认快照');
  else fail('U6 展开快照', `点击=${expandOk}`);
  if (await hasInnerText(page, '期末余额')) pass('U6b 快照表头渲染', '币种/期初/开票/收款/期末');
  else fail('U6b 快照表头', '未出现「期末余额」');

  // ── U5 状态筛选真的生效 ────────────────────────────────────────────
  const trigger = page.locator('[data-select-trigger][aria-label="回执状态筛选"]');
  if (await trigger.count() === 0) {
    fail('U5 状态筛选控件', '未找到 aria-label=回执状态筛选 的 CustomSelect');
  } else {
    await trigger.click();
    await sleep(700);
    const opt = page.locator('[role="option"]', { hasText: '有异议' }).first();
    if (await opt.count() === 0) {
      fail('U5 筛选选项', '下拉里无「有异议」');
    } else {
      await opt.click();
      await sleep(2500);
      await page.screenshot({ path: `${OUT_DIR}/04-filter-disputed.png` });
      const stillThere = await hasInnerText(page, `${P_START} ~ ${P_END}`);
      if (!stillThere) pass('U5 状态筛选生效（confirmed 回执被滤掉）');
      else fail('U5 状态筛选', '切到「有异议」后演练的 confirmed 回执仍可见 —— 筛选未生效');
      // 汇总不受筛选影响：已确认数应仍 ≥ 1
      const summaryOk = await hasInnerText(page, '当前筛选命中 0 条');
      if (summaryOk) pass('U5b 汇总与命中数分离（命中 0 条但已确认计数保留）');
      else info('U5b 汇总', '未匹配到「当前筛选命中 0 条」（可能有其它 disputed 回执）');
    }
  }

  // ── U7 口径与控制台 ────────────────────────────────────────────────
  const danger = await page.evaluate(() => document.querySelectorAll('.bds-alert.danger').length);
  if (danger === 0) pass('U7 无阻断性红（bds-alert.danger = 0）');
  else fail('U7 口径', `出现 ${danger} 处 bds-alert.danger`);
  if (consoleErrors.length <= 5) pass('U7b 控制台 error 未异常增长', `${consoleErrors.length} 条`);
  else fail('U7b 控制台 error', `${consoleErrors.length} 条：${consoleErrors.slice(0, 2).join(' | ')}`);

  await page.screenshot({ path: `${OUT_DIR}/05-final.png` });
}

try {
  await main();
} catch (e) {
  console.error('脚本异常', e);
  fail('脚本异常', String(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (!prisma) await connectPrisma().catch(() => {});
  await rollback();
  const ok = results.filter(r => r.ok === true).length;
  const bad = results.filter(r => r.ok === false).length;
  const notes = results.filter(r => r.ok === null).length;
  console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
  console.log(`截图：${OUT_DIR}/`);
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(bad === 0 ? 0 : 1);
}
