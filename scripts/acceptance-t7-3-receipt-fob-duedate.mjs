// T7-3 收汇 ↔ 报关 FOB —— **应收到期日门槛**真库演练验收（写路径 + 自回滚）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// 为什么需要这个脚本：
//   只读验收跑真库 10 单，到期日全在 2026-08（已逾期）→ `notYetDue=true` 这条分支
//   **在真库里一次都没被走到**。只读验收因此无法证明「门槛真的会压」。
//   本脚本建一个自控演练单，用**因果对照**证明门槛行为：
//
//   A 无收汇 + 到期日=未来  → notYetDue=true  → discrepancies=[]（「收汇不足」被压）
//   B **同一单**只把到期日改成过去 → notYetDue=false → discrepancies=1（照报，且带「已逾期」）
//   C **同一单**到期日回未来 + 加一笔 **多于 FOB** 的收汇 → notYetDue=true 但 discrepancies=1
//     （门槛是**方向性**的：「多收」与到期日无关，不得被压掉）
//
//   B/C 与 A 的唯一差异分别是 dueDate 和收汇额 → 结果翻转即证明**因果**，而非相关。
//
// 自回滚：A/B/C 跑完在 finally 里按精确 ID 硬删演练行（模型 id 均为应用侧提供、无 FK 约束）。
//
// 用法：node scripts/acceptance-t7-3-receipt-fob-duedate.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.T7_DEBUG === '1';

const results = [];
function pass(name, detail = '') { results.push({ ok: true }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ ok: false }); console.log(`  ✗ ${name} — ${detail}`); }
function info(name, detail = '') { results.push({ ok: null }); console.log(`  ⓘ ${name} — ${detail}`); }

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await res.json().catch(() => null);
  return res.ok && data?.token ? data.token : null;
}

async function api(token, method, path) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (DEBUG && res.status >= 400) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, data };
}

const dayOffset = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return d.toISOString().slice(0, 10);
};
const TODAY = dayOffset(0);
const FUTURE = dayOffset(30);
const PAST = dayOffset(-30);

/** 演练行的 ID / 业务号（带 DRILL 前缀，便于识别与清理） */
const TS = Date.now();
const ORDER_ID = `ORD__DRILL_DUE_${TS}`;
const ORDER_CODE = `DRILL-DUE-${TS}`;
const CD_ID = `CD__DRILL_DUE_${TS}`;
const CD_NO = `DRILL-CD-${TS}`;
const INV_ID = `INV__DRILL_DUE_${TS}`;
const INV_NO = `DRILL-INV-${TS}`;
const PAY_ID = `PAY__DRILL_DUE_${TS}`;
const PAY_NO = `DRILL-PAY-${TS}`;
const FOB = 10000;

let prisma = null;
let created = { order: false, cd: false, invoice: false, voucher: false };

async function connectPrisma() {
  const { createRequire } = await import('node:module');
  const { SERVER_DIR } = await import('./lib/acceptance-selfcheck.mjs');
  // 本脚本在仓库根运行，而 @prisma/client 装在 server/ 下 —— 以 server 为基准解析
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
      id: ORDER_ID, code: ORDER_CODE, customer: 'DRILL-CUSTOMER', product: 'DRILL-PRODUCT',
      type: 'Export', quantity: 1, status: 'InProduction', dueDate: dayOffset(60),
      quoteAmount: FOB, currency: 'USD', updatedAt: now,
      // ⚠️ Order.createdAt 是 DateTime @default(now())（与其余模型的 BigInt 不同）→ 交给默认值
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
      orderId: ORDER_ID, customerName: 'DRILL-CUSTOMER', createdAt: now, updatedAt: now,
    },
  });
  created.invoice = true;
}

async function setDueDate(d) {
  await prisma.invoice.update({ where: { id: INV_ID }, data: { dueDate: d, updatedAt: BigInt(Date.now()) } });
}

async function addOverReceipt() {
  await prisma.paymentVoucher.create({
    data: {
      id: PAY_ID, voucherNumber: PAY_NO, type: 'Receipt', amount: FOB + 3000, currency: 'USD',
      paymentDate: TODAY, paymentMethod: 'TT', status: 'unreconciled',
      orderId: ORDER_ID, customerName: 'DRILL-CUSTOMER',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
  created.voucher = true;
}

async function rollback() {
  const gone = [];
  try {
    if (created.voucher) { await prisma.paymentVoucher.delete({ where: { id: PAY_ID } }); gone.push('voucher'); }
    if (created.invoice) { await prisma.invoice.delete({ where: { id: INV_ID } }); gone.push('invoice'); }
    if (created.cd) { await prisma.customsDeclaration.delete({ where: { id: CD_ID } }); gone.push('cd'); }
    if (created.order) { await prisma.order.delete({ where: { id: ORDER_ID } }); gone.push('order'); }
    pass('回滚：硬删演练行', gone.join(' / ') || '（无）');
  } catch (e) {
    fail('回滚失败', `${e?.message} —— 需手工清理：${ORDER_ID} / ${CD_ID} / ${INV_ID} / ${PAY_ID}`);
  }
}

async function main() {
  const token = await login('charlie.qian@bambook.local');
  if (!token) { console.log('登录失败（charlie.qian 财务）'); process.exit(1); }
  console.log('══ T7-3 应收到期日门槛 · 真库演练验收（自回滚）══\n');
  console.log(`  演练单 ${ORDER_CODE}｜报关 FOB ${FOB} USD｜今天 ${TODAY}\n`);

  await connectPrisma();
  await seed();
  pass('建演练数据', `订单 + 报关单(${FOB} USD FOB) + 应收发票(到期 ${FUTURE})`);

  const url = `/api/v1/reconciliation/orders/${encodeURIComponent(ORDER_ID)}/receipt-fob`;

  // ── A 无收汇 + 到期日在未来 → 门槛压住「收汇不足」 ──────────────────────
  const a = await api(token, 'GET', url);
  if (a.status !== 200) {
    fail('A 接口可用', `HTTP ${a.status} ${JSON.stringify(a.data).slice(0, 160)}`);
  } else {
    const d = a.data;
    if (d.notYetDue === true) pass('A 未到期判定', `notYetDue=true，到期日 ${d.paymentDueDate}`);
    else fail('A 未到期判定', `notYetDue=${d.notYetDue}，到期日 ${d.paymentDueDate}（期望 true/${FUTURE}）`);
    if (d.paymentDueDate === FUTURE) pass('A 到期日取值', d.paymentDueDate);
    else fail('A 到期日取值', `${d.paymentDueDate} ≠ ${FUTURE}`);
    if ((d.discrepancies ?? []).length === 0) pass('A 门槛压住「收汇不足」', 'discrepancies=[]');
    else fail('A 门槛未生效', `期望 0 条，实际 ${d.discrepancies.length}：${d.discrepancies[0]?.message?.slice(0, 120)}`);
    // 数据照旧算出来，只是不「报」
    const row = (d.byCurrency ?? [])[0];
    if (row && row.difference === -FOB && row.withinTolerance === false) {
      pass('A 数值照算（只是不报）', `差 ${row.difference} / 容差 ${row.tolerance} / withinTolerance=false`);
    } else fail('A 数值', JSON.stringify(row).slice(0, 160));
  }

  // ── B 同一单，只把到期日改成过去 → 照报 ──────────────────────────────
  await setDueDate(PAST);
  const b = await api(token, 'GET', url);
  if (b.status !== 200) {
    fail('B 接口可用', `HTTP ${b.status}`);
  } else {
    const d = b.data;
    if (d.notYetDue === false) pass('B 已逾期判定', `notYetDue=false，到期日 ${d.paymentDueDate}`);
    else fail('B 已逾期判定', `notYetDue=${d.notYetDue}（期望 false）`);
    if ((d.discrepancies ?? []).length === 1) pass('B 已逾期照报', 'discrepancies=1');
    else fail('B 已逾期未报', `期望 1 条，实际 ${(d.discrepancies ?? []).length}`);
    const msg = d.discrepancies?.[0]?.message ?? '';
    if (/尚无收汇记录|收汇少于报关 FOB/.test(msg) && msg.includes('已逾期')) {
      pass('B 报文含「已逾期」', msg.slice(0, 110));
    } else fail('B 报文', msg.slice(0, 160));
    if (d.discrepancies?.every(x => x.severity === 'warning')) pass('B severity 恒 warning', '口径 D');
    else fail('B severity', '出现非 warning');
  }

  // ── C 到期日回未来 + 加一笔「多于 FOB」的收汇 → 不被门槛压掉 ──────────
  await setDueDate(FUTURE);
  await addOverReceipt();
  const c = await api(token, 'GET', url);
  if (c.status !== 200) {
    fail('C 接口可用', `HTTP ${c.status}`);
  } else {
    const d = c.data;
    if (d.notYetDue === true) pass('C 仍未到期', 'notYetDue=true');
    else fail('C 未到期判定', `notYetDue=${d.notYetDue}`);
    if ((d.discrepancies ?? []).length === 1) pass('C 多收不被门槛压掉', 'discrepancies=1（方向性生效）');
    else fail('C 方向性失效', `期望 1 条「多收」，实际 ${(d.discrepancies ?? []).length} —— 门槛误压了多收方向`);
    const msg = d.discrepancies?.[0]?.message ?? '';
    if (msg.includes('收汇多于报关 FOB')) pass('C 报文方向正确', msg.slice(0, 110));
    else fail('C 报文方向', msg.slice(0, 160));
  }
}

/**
 * 跑 A/B/C + 汇总。
 * ⚠️ 回滚放 `finally`：演练数据一旦落库，**任何**提前返回/抛错都必须能回滚，
 *    否则真库静默留残留（skill 登记过的坑）。
 */
try {
  await main();
} catch (e) {
  console.error('脚本异常', e);
  fail('脚本异常', String(e).slice(0, 300));
} finally {
  if (created.order || created.cd || created.invoice || created.voucher) await rollback();
  const ok = results.filter(r => r.ok === true).length;
  const bad = results.filter(r => r.ok === false).length;
  const notes = results.filter(r => r.ok === null).length;
  console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(bad === 0 ? 0 : 1);
}
