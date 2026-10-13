// 作废发票 → 批次结算快照回冲 —— 真库演练验收（走真实 API 写路径 + 自回滚）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// 为什么必须做演练（而不是只跑单测）：
//   单测用的是内存 prisma，验的是 service 内部逻辑；演练额外证明三件单测看不到的事：
//     ① 路由接线：POST /api/v1/finance/invoices/:id/cancel 真的走到 cancelInvoice
//     ② 运行中的服务端确实加载了新代码（后端由 launchd 托管，ts-node 无 watch，不重启不生效）
//     ③ 真 Prisma 语义（Decimal / $transaction / 软删过滤）下快照数值真的收敛
//
// 验的口径不变量（S1–S9）：
//   S1 建票挂批次（走 POST /invoices）→ 批次 invoicedAmount 回写为该批开票额（基线）
//   S2 作废（POST /invoices/:id/cancel）→ 200
//   S3 发票 status = Cancelled
//   S4 ★ 批次 invoicedAmount 归零（recalcSettlement 排除 Cancelled 发票）—— **本演练的承重断言**
//   S5 批次 settleStatus 仍为 unsettled（方向性护栏：防重算把状态改错方向。
//      注：作废路径下 paid 必为 0（有核销的票根本不让作废，见 S7），所以本 fixture 里
//      settleStatus 在证伪态也是 unsettled —— S5 **不具区分度**，真库证伪时只有 S4 转红。
//      保留它只为挡住"重算写反方向"这类新错，不要把它当回冲是否生效的证据。）
//   S6 作废留痕：AuditLog 有 cancel_invoice 且 targetId 指向该票
//   S7 有核销记录的票作废 → 409 HAS_ALLOCATIONS（门禁不被本次改动破坏）
//   S8 被拒后批次快照未被改动（拒绝路径零副作用）
//   S9 回滚后独立复核零残留
//
// 演练数据全部带 DRILL-SETTLE 前缀 / 精确 id，finally 里按精确 ID 硬删 + 独立复核。
// 用法：NO_PROXY=127.0.0.1,localhost node scripts/acceptance-cancel-settle-recalc.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';

const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n} — ${d}`); };

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await res.json().catch(() => null);
  return res.ok && data?.token ? data.token : null;
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data };
}

/** 轮询等待（invoice create 的批次重算是 fire-and-forget，不 await） */
async function waitFor(fn, { timeoutMs = 5000, everyMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return last;
}

// ── 演练常量 ──────────────────────────────────────────────────────────
const TS = Date.now();
const ORD_ID = `ORD__DRILL_SETTLE_${TS}`;
const ORD_CODE = `DRILL-SETTLE-ORD-${TS}`;
const OSB_ID = `OSB__DRILL_SETTLE_${TS}`;
const INV_A = `DRILL-SETTLE-INV-A-${TS}`;   // 走作废 → 验回冲
const INV_B = `DRILL-SETTLE-INV-B-${TS}`;   // 有核销 → 验 409
const CUST = `DRILL-SETTLE-CUST-${TS}`;
const AMT = 10000;

let prisma = null;

async function connectPrisma() {
  const { createRequire } = await import('node:module');
  const { SERVER_DIR } = await import('./lib/acceptance-selfcheck.mjs');
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
      id: ORD_ID, code: ORD_CODE, customer: CUST, customerRelationId: null,
      product: 'DRILL-SETTLE-PRODUCT', type: 'Export', quantity: 1, status: 'InProduction',
      dueDate: '2026-12-31', quoteAmount: AMT, currency: 'USD', updatedAt: now,
    },
  });
  await prisma.orderShipmentBatch.create({
    data: {
      id: OSB_ID, orderId: ORD_ID, batchNo: 1, currency: 'USD',
      amount: AMT, status: 'planned', settleStatus: 'unsettled',
      invoicedAmount: 0, paidAmount: 0, isFinalBatch: true,
      createdAt: now, updatedAt: now,
    },
  });
}

const readBatch = () => prisma.orderShipmentBatch.findUnique({ where: { id: OSB_ID } });

async function purge() {
  const gone = [];
  const invs = await prisma.invoice.findMany({
    where: { invoiceNumber: { in: [INV_A, INV_B] } },
    select: { id: true, invoiceNumber: true },
  });
  for (const inv of invs) {
    const ia = await prisma.invoiceAllocation.deleteMany({ where: { invoiceId: inv.id } });
    if (ia.count) gone.push(`invoiceAllocation(${ia.count})`);
    const ioa = await prisma.invoiceOrderAllocation.deleteMany({ where: { invoiceId: inv.id } });
    if (ioa.count) gone.push(`IOA(${ioa.count})`);
    const links = await prisma.entityLink.deleteMany({ where: { OR: [{ fromId: inv.id }, { toId: inv.id }] } });
    if (links.count) gone.push(`entityLink(${links.count})`);
    const refs = await prisma.entityReference.deleteMany({ where: { OR: [{ ownerId: inv.id }, { targetId: inv.id }] } });
    if (refs.count) gone.push(`entityReference(${refs.count})`);
    const audit = await prisma.auditLog.deleteMany({ where: { targetId: inv.id } });
    if (audit.count) gone.push(`auditLog(${audit.count})`);
    await prisma.invoice.delete({ where: { id: inv.id } });
    gone.push(`invoice(${inv.invoiceNumber})`);
  }
  const b = await prisma.orderShipmentBatch.deleteMany({ where: { id: OSB_ID } });
  if (b.count) gone.push(`batch(${OSB_ID})`);
  const o = await prisma.order.deleteMany({ where: { id: ORD_ID } });
  if (o.count) gone.push(`order(${ORD_ID})`);
  return gone;
}

/** 独立复核：不依赖上面的返回值，重新查一遍库 */
async function assertZeroResidue() {
  const invs = await prisma.invoice.count({ where: { invoiceNumber: { in: [INV_A, INV_B] } } });
  const osb = await prisma.orderShipmentBatch.count({ where: { id: OSB_ID } });
  const ord = await prisma.order.count({ where: { id: ORD_ID } });
  return { invs, osb, ord, clean: invs === 0 && osb === 0 && ord === 0 };
}

const invBody = (no) => ({
  type: 'Receivable', status: 'Issued', invoiceNumber: no,
  amount: AMT, currency: 'USD', issueDate: '2026-09-17',
  customerName: CUST, customerRelationId: null,
  orderAllocations: [{ orderId: ORD_ID, batchId: OSB_ID, allocatedAmount: String(AMT) }],
});

// ── 主流程 ────────────────────────────────────────────────────────────
let exitCode = 0;
try {
  await connectPrisma();

  let token = null;
  for (const email of ['charlie.qian@bambook.local', 'melissa.zhao@bambook.local', 'jason.shen@bambook.local']) {
    token = await login(email);
    if (token) { info('登录', email); break; }
  }
  if (!token) { fail('登录', '三个财务/超管账号都拿不到 token'); throw new Error('login failed'); }

  await seed();
  info('fixture', `order=${ORD_ID} batch=${OSB_ID} amount=${AMT} USD`);

  // ── S1 建票挂批次 → 批次 invoicedAmount 基线 ──
  const created = await api(token, 'POST', '/api/v1/finance/', invBody(INV_A));
  if (created.status !== 201 && created.status !== 200) {
    fail('S1 建票（挂批次）', `HTTP ${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
    throw new Error('create failed');
  }
  const invAId = created.data?.id || created.data?.invoice?.id;
  if (!invAId) { fail('S1 建票', '响应里拿不到 invoice id'); throw new Error('no id'); }
  pass('S1 建票（挂批次）', `HTTP ${created.status} id=${invAId}`);

  const b1 = await waitFor(async () => {
    const b = await readBatch();
    return b && Number(b.invoicedAmount) === AMT ? b : null;
  });
  if (b1) pass('S1b 建票后批次 invoicedAmount 回写', `${Number(b1.invoicedAmount)}`);
  else { const b = await readBatch(); fail('S1b 建票后批次 invoicedAmount 回写', `期望 ${AMT}，实得 ${b ? Number(b.invoicedAmount) : 'null'}`); }

  // ── S2/S3/S4/S5 作废 → 回冲 ──
  const cancelled = await api(token, 'POST', `/api/v1/finance/${invAId}/cancel`, { reason: 'DRILL-SETTLE 演练' });
  if (cancelled.status === 200 && (cancelled.data?.ok !== false)) pass('S2 作废接口', `HTTP ${cancelled.status}`);
  else fail('S2 作废接口', `HTTP ${cancelled.status} ${JSON.stringify(cancelled.data).slice(0, 200)}`);

  const invAfter = await prisma.invoice.findUnique({ where: { id: invAId }, select: { status: true } });
  if (invAfter?.status === 'Cancelled') pass('S3 发票 status = Cancelled');
  else fail('S3 发票 status', `实得 ${invAfter?.status}`);

  const b2 = await readBatch();
  if (Number(b2.invoicedAmount) === 0) pass('S4 ★ 批次 invoicedAmount 归零（回冲生效）', `${Number(b2.invoicedAmount)}`);
  else fail('S4 ★ 批次 invoicedAmount 归零', `期望 0，实得 ${Number(b2.invoicedAmount)} —— 作废未回冲批次快照`);

  if (b2.settleStatus === 'unsettled') pass('S5 批次 settleStatus = unsettled（方向性护栏，非承重断言）');
  else fail('S5 批次 settleStatus 方向', `实得 ${b2.settleStatus}`);

  // ── S6 留痕 ──
  const audit = await prisma.auditLog.count({ where: { targetId: invAId, action: 'cancel_invoice' } });
  if (audit > 0) pass('S6 作废留痕 auditLog.cancel_invoice', `${audit} 条`);
  else fail('S6 作废留痕', '找不到 cancel_invoice 审计行');

  // ── S7/S8 有核销 → 409 且零副作用 ──
  const created2 = await api(token, 'POST', '/api/v1/finance/', invBody(INV_B));
  const invBId = created2.data?.id || created2.data?.invoice?.id;
  if (!invBId) {
    fail('S7 建第二张票', `HTTP ${created2.status} ${JSON.stringify(created2.data).slice(0, 200)}`);
  } else {
    await prisma.invoiceAllocation.create({
      data: { id: `ALLOC__DRILL_SETTLE_${TS}`, invoiceId: invBId, voucherId: `DRILL-NO-VOUCHER-${TS}`, appliedAmount: 100, appliedDate: '2026-09-17', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) },
    }).catch(() => null);
    // 建票触发的批次重算是 fire-and-forget —— 先等它落定，再取 before 快照，
    // 否则会把"上一笔尚未完成的异步重算"误判成"被拒用例改了快照"。
    await waitFor(async () => {
      const b = await readBatch();
      return b && Number(b.invoicedAmount) === AMT && b.settleStatus === 'partially_settled' ? b : null;
    });
    const before = await readBatch();
    const rej = await api(token, 'POST', `/api/v1/finance/${invBId}/cancel`, { reason: 'DRILL-SETTLE 负向' });
    if (rej.status === 409 && rej.data?.error?.code === 'HAS_ALLOCATIONS') pass('S7 有核销的票作废 → 409 HAS_ALLOCATIONS');
    else fail('S7 有核销的票作废', `期望 409/HAS_ALLOCATIONS，实得 ${rej.status} ${JSON.stringify(rej.data).slice(0, 160)}`);

    const after = await readBatch();
    if (Number(after.invoicedAmount) === Number(before.invoicedAmount) && after.settleStatus === before.settleStatus) {
      pass('S8 被拒后批次快照未被改动', `invoicedAmount=${Number(after.invoicedAmount)} settleStatus=${after.settleStatus}`);
    } else {
      fail('S8 被拒后批次快照未被改动', `before=${Number(before.invoicedAmount)}/${before.settleStatus} after=${Number(after.invoicedAmount)}/${after.settleStatus}`);
    }
  }
} catch (e) {
  fail('演练异常', e?.message ?? String(e));
  exitCode = 1;
} finally {
  try {
    if (prisma) {
      const gone = await purge();
      info('回滚', gone.join(' ') || '（无）');
      const res = await assertZeroResidue();
      if (res.clean) pass('S9 回滚后独立复核零残留', `invoice=${res.invs} batch=${res.osb} order=${res.ord}`);
      else { fail('S9 回滚后独立复核零残留', JSON.stringify(res)); exitCode = 1; }
    }
  } catch (e) {
    fail('回滚失败', e?.message ?? String(e));
    exitCode = 1;
  }
  if (prisma) await prisma.$disconnect();
  const okN = results.filter((r) => r.ok === true).length;
  const failN = results.filter((r) => r.ok === false).length;
  console.log(`\n═══ 演练结果：${okN} 通过 / ${failN} 失败 ═══`);
  if (failN > 0) exitCode = 1;
  process.exit(exitCode);
}
