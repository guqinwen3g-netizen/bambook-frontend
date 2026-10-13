// 合并开票「同客户」硬门禁 —— 真库演练验收（走真实 API 写路径 + 自回滚）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// 为什么必须做演练（而不是只读验收）：
//   「一张票只能开给同一个客户」是**写路径**上的门禁：要真的发 POST/PATCH 建票改票，
//   才能确认拦得住、且拦在**写库之前**（不留半成品）。只读验收看不到这些。
//
// 验的口径不变量（R1–R10）：
//   R1 跨客户合并开票（两个客户的订单挂一张票）→ 409 INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH
//      且**库里不产生任何发票行**（拦在写之前，不是先写后回滚留下垃圾）
//   R2 同客户两单合并 → 201，且 InvoiceOrderAllocation 落 2 行（不误拦）
//   R3 票头客户 ≠ 订单签约客户 → 409 INVOICE_CUSTOMER_MISMATCH，同样零落库
//   R4 Payable 票头是**供应商**（口径不同）→ 不校票头，201（不误拦）
//   R5 PATCH 只改票头客户、不动分配 → 409；且库里该票客户**没被改掉**（事务回滚）
//   R6 PATCH 同一次改客户 + 换分配为同客户 → 200（最终态一致即放行）
//   R7 PATCH 把分配换成跨客户 → 409；且旧分配**没被软删**（★事务原子性：
//      软删发生在校验之前，若事务不回滚就会留下「分配被清空」的残局）
//   R8 订单无客户档案（旧数据）→ 不误拦，201
//   R9 双方都无档案 → 名称兜底：两个不同客户名合并 → 409
//   R10 档案优先：一单有档案 + 一单只有名称（异名）→ 只比档案，不误拦，201
//
// 演练数据全部带 DRILL-CUST 前缀 / 精确 id（脚本显式提供），
// finally 里按精确 ID 硬删 + 独立复核零残留（含 EntityLink / AuditLog 联动副作用）。
// 用法：node scripts/acceptance-invoice-customer-gate.mjs
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

// ── 演练常量 ──────────────────────────────────────────────────────────
const TS = Date.now();
const REL_A = `REL__DRILL_CUST_A_${TS}`;
const REL_B = `REL__DRILL_CUST_B_${TS}`;
const NAME_A = `DRILL-CUST-A-${TS}`;
const NAME_B = `DRILL-CUST-B-${TS}`;

const ORD = {
  A1: `ORD__DRILL_CA1_${TS}`,
  A2: `ORD__DRILL_CA2_${TS}`,
  B1: `ORD__DRILL_CB1_${TS}`,
  N1: `ORD__DRILL_CN1_${TS}`, // 无档案，名称同 A
  N2: `ORD__DRILL_CN2_${TS}`, // 无档案，名称同 B
};
const ORD_CODE = (k) => `DRILL-CUST-${k}-${TS}`;

const INV_NO = (k) => `DRILL-CUSTINV-${k}-${TS}`;
// 所有走 POST 建单的用例 key（R5/R7 是 PATCH R2 那张票，不新建发票号）
// —— 回滚与残留复核都按这批号**无条件**扫，不依赖 API 是否返回 201：
//    证伪跑（守卫关掉）时 R1/R3/R9 会真的落库，只清 createdInvoices 会漏。
const POST_INV_KEYS = ['R1', 'R2', 'R3', 'R4', 'R8', 'R9', 'R10'];

let prisma = null;
const createdInvoices = [];   // { id, number }
const createdOrders = [];

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
  const rows = [
    { id: ORD.A1, code: ORD_CODE('A1'), customerRelationId: REL_A, customer: NAME_A },
    { id: ORD.A2, code: ORD_CODE('A2'), customerRelationId: REL_A, customer: NAME_A },
    { id: ORD.B1, code: ORD_CODE('B1'), customerRelationId: REL_B, customer: NAME_B },
    { id: ORD.N1, code: ORD_CODE('N1'), customerRelationId: null, customer: NAME_A },
    { id: ORD.N2, code: ORD_CODE('N2'), customerRelationId: null, customer: NAME_B },
  ];
  for (const r of rows) {
    await prisma.order.create({
      data: {
        id: r.id, code: r.code, customer: r.customer, customerRelationId: r.customerRelationId,
        product: 'DRILL-CUST-PRODUCT', type: 'Export', quantity: 1, status: 'InProduction',
        dueDate: '2026-12-31', quoteAmount: 1000, currency: 'USD', updatedAt: now,
      },
    });
    createdOrders.push(r.id);
  }
}

async function purgeInvoices(numbers) {
  const gone = [];
  const invs = await prisma.invoice.findMany({ where: { invoiceNumber: { in: numbers } }, select: { id: true, invoiceNumber: true } });
  for (const inv of invs) {
    const ioa = await prisma.invoiceOrderAllocation.deleteMany({ where: { invoiceId: inv.id } });
    if (ioa.count) gone.push(`IOA(${ioa.count})`);
    const links = await prisma.entityLink.deleteMany({ where: { OR: [{ fromId: inv.id }, { toId: inv.id }] } });
    if (links.count) gone.push(`entityLink(${links.count})`);
    const audit = await prisma.auditLog.deleteMany({ where: { targetId: inv.id } });
    if (audit.count) gone.push(`auditLog(${audit.count})`);
    await prisma.invoice.delete({ where: { id: inv.id } });
    gone.push(`invoice(${inv.invoiceNumber})`);
  }
  return gone;
}

async function rollback() {
  try {
    const gone = [];
    // ① 按发票号无条件扫（含「被门禁拦下但意外落库」的）——证伪跑靠这一步兜底
    gone.push(...await purgeInvoices(POST_INV_KEYS.map(INV_NO)));
    // ② 再按 API 返回的真实 id 扫一遍（幂等，覆盖任何号外情况）
    const ids = createdInvoices.map(i => i.id).filter(id => id && id !== 'unknown');
    if (ids.length) {
      const invs = await prisma.invoice.findMany({ where: { id: { in: ids } }, select: { invoiceNumber: true } });
      gone.push(...await purgeInvoices(invs.map(i => i.invoiceNumber)));
    }
    const ords = await prisma.order.deleteMany({ where: { id: { in: createdOrders } } });
    gone.push(`order(${ords.count})`);
    pass('回滚：硬删演练行', gone.join(' / ') || '（无）');
  } catch (e) {
    fail('回滚失败', `${e?.message} —— 需手工清理 orders=${createdOrders.join(',')} invoices=${createdInvoices.map(i => i.id).join(',')}`);
  }
}

/** 独立复核零残留（不信回滚自述，按精确标识回查） */
async function verifyNoResidue() {
  const checks = [];
  // ★ 每个 POST 用例的发票号都必须查不到（既证「拒绝的不落库」，也证「清理干净」）
  for (const k of POST_INV_KEYS) {
    const n = INV_NO(k);
    const rows = await prisma.invoice.findMany({ where: { invoiceNumber: n }, select: { id: true } });
    checks.push([`invoice:${k}`, rows.length]);
    for (const r of rows) {
      checks.push([`IOA:${k}`, await prisma.invoiceOrderAllocation.count({ where: { invoiceId: r.id } })]);
      checks.push([`entityLink:${k}`, await prisma.entityLink.count({ where: { OR: [{ fromId: r.id }, { toId: r.id }] } })]);
      checks.push([`auditLog:${k}`, await prisma.auditLog.count({ where: { targetId: r.id } })]);
    }
  }
  checks.push(['order', await prisma.order.count({ where: { id: { in: createdOrders } } })]);
  checks.push(['creditLimit', await prisma.creditLimit.count({ where: { relationId: { in: [REL_A, REL_B] } } })]);
  checks.push(['creditLimitHistory', await prisma.creditLimitHistory.count({ where: { relationId: { in: [REL_A, REL_B] } } })]);
  const dirty = checks.filter(([, n]) => n > 0);
  if (dirty.length === 0) pass('回滚复核：零残留', `${checks.length} 项全为 0`);
  else fail('回滚复核：仍有残留', dirty.map(([k, n]) => `${k}=${n}`).join(' '));
}

const invUrl = (id) => `/api/v1/finance/${encodeURIComponent(id)}`;

async function createInvoice(token, body) {
  return api(token, 'POST', '/api/v1/finance', body);
}

async function main() {
  // 需要 invoices:write —— 只有「财务」角色与超管有（后勤/业务员无，403 INSUFFICIENT_SCOPE）
  const token = await login('charlie.qian@bambook.local')
    ?? await login('melissa.zhao@bambook.local')
    ?? await login('jason.shen@bambook.local');
  if (!token) { fail('登录', 'charlie.qian / melissa.zhao / jason.shen 均失败'); return; }
  console.log('══ 合并开票「同客户」硬门禁 · 真库演练验收（真实 API 写路径 + 自回滚）══\n');
  console.log(`  客户档案 A=${REL_A}`);
  console.log(`  客户档案 B=${REL_B}`);
  console.log(`  订单：A1/A2→A档案  B1→B档案  N1(无档案,名A)  N2(无档案,名B)\n`);

  await connectPrisma();
  await seed();
  pass('建演练底账', `5 张订单（3 张有客户档案 / 2 张无档案）`);

  const base = (over) => ({
    type: 'Receivable', status: 'Draft', amount: '1000', currency: 'USD',
    issueDate: '2026-09-17', dueDate: '2026-12-31', ...over,
  });

  // ── R1 跨客户合并 → 409 且零落库 ──────────────────────────────────
  const r1 = await createInvoice(token, base({
    invoiceNumber: INV_NO('R1'), customerRelationId: REL_A, customerName: NAME_A,
    orderIds: [ORD.A1, ORD.B1],
  }));
  if (r1.status === 409 && r1.data?.error?.code === 'INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH') {
    pass('R1 跨客户合并开票被拒', `409 ${r1.data.error.code}`);
  } else fail('R1 跨客户合并开票被拒', `HTTP ${r1.status} ${JSON.stringify(r1.data).slice(0, 200)}`);
  const r1Rows = await prisma.invoice.count({ where: { invoiceNumber: INV_NO('R1') } });
  if (r1Rows === 0) pass('R1 拦在写之前（零落库）', 'invoice count = 0');
  else fail('R1 拦在写之前（零落库）', `库里已有 ${r1Rows} 行 —— 先写后拦，会留垃圾（由 finally 按发票号兜底清）`);

  // ── R2 同客户两单 → 201 + 2 行分配 ────────────────────────────────
  const r2 = await createInvoice(token, base({
    invoiceNumber: INV_NO('R2'), customerRelationId: REL_A, customerName: NAME_A,
    orderIds: [ORD.A1, ORD.A2],
  }));
  if (r2.status === 201 && r2.data?.id) {
    createdInvoices.push({ id: r2.data.id, number: INV_NO('R2') });
    const cnt = await prisma.invoiceOrderAllocation.count({ where: { invoiceId: r2.data.id, deletedAt: null } });
    if (cnt === 2) pass('R2 同客户两单合并放行', `201，InvoiceOrderAllocation = ${cnt} 行`);
    else fail('R2 同客户两单合并放行', `分配行数 = ${cnt}（期望 2）`);
  } else fail('R2 同客户两单合并放行', `HTTP ${r2.status} ${JSON.stringify(r2.data).slice(0, 200)}`);

  // ── R3 票头客户 ≠ 订单客户 → 409 且零落库 ─────────────────────────
  const r3 = await createInvoice(token, base({
    invoiceNumber: INV_NO('R3'), customerRelationId: REL_B, customerName: NAME_B,
    orderIds: [ORD.A1],
  }));
  if (r3.status === 409 && r3.data?.error?.code === 'INVOICE_CUSTOMER_MISMATCH') {
    pass('R3 票头客户与订单客户不符被拒', `409 ${r3.data.error.code}`);
  } else fail('R3 票头客户与订单客户不符被拒', `HTTP ${r3.status} ${JSON.stringify(r3.data).slice(0, 200)}`);
  const r3Rows = await prisma.invoice.count({ where: { invoiceNumber: INV_NO('R3') } });
  if (r3Rows === 0) pass('R3 拦在写之前（零落库）', 'invoice count = 0');
  else fail('R3 拦在写之前（零落库）', `库里已有 ${r3Rows} 行（由 finally 按发票号兜底清）`);

  // ── R4 Payable 不校票头 ──────────────────────────────────────────
  const r4 = await createInvoice(token, base({
    type: 'Payable', invoiceNumber: INV_NO('R4'), customerRelationId: REL_B, customerName: 'DRILL-SUPPLIER',
    orderIds: [ORD.A1],
  }));
  if (r4.status === 201 && r4.data?.id) {
    createdInvoices.push({ id: r4.data.id, number: INV_NO('R4') });
    pass('R4 Payable 票头是供应商 → 不校票头', '201（口径不同，不误拦）');
  } else fail('R4 Payable 票头是供应商 → 不校票头', `HTTP ${r4.status} ${JSON.stringify(r4.data).slice(0, 200)}`);

  // ── R5 PATCH 只改客户、不动分配 → 409 + 事务回滚 ──────────────────
  if (r2.data?.id) {
    const r5 = await api(token, 'PATCH', invUrl(r2.data.id), { customerRelationId: REL_B, customerName: NAME_B });
    if (r5.status === 409 && r5.data?.error?.code === 'INVOICE_CUSTOMER_MISMATCH') {
      pass('R5 只改票头客户（分配仍挂 A）被拒', `409 ${r5.data.error.code}`);
    } else fail('R5 只改票头客户（分配仍挂 A）被拒', `HTTP ${r5.status} ${JSON.stringify(r5.data).slice(0, 200)}`);
    const after = await prisma.invoice.findUnique({ where: { id: r2.data.id }, select: { customerRelationId: true } });
    if (after?.customerRelationId === REL_A) pass('R5 事务回滚：票头客户没被改掉', `仍是 A`);
    else fail('R5 事务回滚：票头客户没被改掉', `实际 = ${after?.customerRelationId}`);
  }

  // ── R6 同一次改客户 + 换分配（最终态一致）→ 200 ────────────────────
  if (r2.data?.id) {
    const r6 = await api(token, 'PATCH', invUrl(r2.data.id), {
      customerRelationId: REL_B, customerName: NAME_B, orderIds: [ORD.B1],
    });
    if (r6.status === 200) {
      const [inv, allocs] = await Promise.all([
        prisma.invoice.findUnique({ where: { id: r2.data.id }, select: { customerRelationId: true } }),
        prisma.invoiceOrderAllocation.findMany({ where: { invoiceId: r2.data.id, deletedAt: null }, select: { orderId: true } }),
      ]);
      const okCust = inv?.customerRelationId === REL_B;
      const okAlloc = allocs.length === 1 && allocs[0].orderId === ORD.B1;
      if (okCust && okAlloc) pass('R6 同一次 PATCH 改客户 + 换分配 → 放行', `客户=B，分配=1 行(B1)`);
      else fail('R6 同一次 PATCH 改客户 + 换分配 → 放行', `客户=${inv?.customerRelationId} 分配=${JSON.stringify(allocs)}`);
    } else fail('R6 同一次 PATCH 改客户 + 换分配 → 放行', `HTTP ${r6.status} ${JSON.stringify(r6.data).slice(0, 200)}`);
  }

  // ── R7 ★ 事务原子性：换分配为跨客户 → 409，旧分配不能被软删 ─────────
  if (r2.data?.id) {
    const r7 = await api(token, 'PATCH', invUrl(r2.data.id), { orderIds: [ORD.A1, ORD.B1] });
    if (r7.status === 409 && r7.data?.error?.code === 'INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH') {
      pass('R7 换分配为跨客户被拒', `409 ${r7.data.error.code}`);
    } else fail('R7 换分配为跨客户被拒', `HTTP ${r7.status} ${JSON.stringify(r7.data).slice(0, 200)}`);
    // ★ 软删发生在校验之前；若事务不回滚，这里会看到 0 行 → 票被「清空分配」
    const allocs = await prisma.invoiceOrderAllocation.findMany({ where: { invoiceId: r2.data.id, deletedAt: null }, select: { orderId: true } });
    if (allocs.length === 1 && allocs[0].orderId === ORD.B1) pass('R7 ★事务原子性：旧分配没被软删', `仍是 1 行(B1)`);
    else fail('R7 ★事务原子性：旧分配没被软删', `实际 ${JSON.stringify(allocs)} —— 校验前软删未回滚，票被清空`);
  }

  // ── R8 订单无客户档案 → 不误拦 ────────────────────────────────────
  const r8 = await createInvoice(token, base({
    invoiceNumber: INV_NO('R8'), customerRelationId: REL_A, customerName: NAME_A,
    orderIds: [ORD.N1],
  }));
  if (r8.status === 201 && r8.data?.id) {
    createdInvoices.push({ id: r8.data.id, number: INV_NO('R8') });
    pass('R8 订单无客户档案（旧数据）→ 不误拦', '201');
  } else fail('R8 订单无客户档案（旧数据）→ 不误拦', `HTTP ${r8.status} ${JSON.stringify(r8.data).slice(0, 200)}`);

  // ── R9 双方都无档案 → 名称兜底合并 → 409 ──────────────────────────
  const r9 = await createInvoice(token, base({
    invoiceNumber: INV_NO('R9'), customerRelationId: null, customerName: '',
    orderIds: [ORD.N1, ORD.N2],
  }));
  if (r9.status === 409 && r9.data?.error?.code === 'INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH') {
    pass('R9 无档案时按客户名兜底：两客户名合并被拒', `409 ${r9.data.error.code}`);
  } else fail('R9 无档案时按客户名兜底：两客户名合并被拒', `HTTP ${r9.status} ${JSON.stringify(r9.data).slice(0, 200)}`);

  // ── R10 档案优先：一单有档案 + 一单异名无档案 → 不误拦 ─────────────
  const r10 = await createInvoice(token, base({
    invoiceNumber: INV_NO('R10'), customerRelationId: REL_A, customerName: NAME_A,
    orderIds: [ORD.A1, ORD.N2],
  }));
  if (r10.status === 201 && r10.data?.id) {
    createdInvoices.push({ id: r10.data.id, number: INV_NO('R10') });
    pass('R10 档案优先（不比名称）→ 不误拦', '201');
  } else fail('R10 档案优先（不比名称）→ 不误拦', `HTTP ${r10.status} ${JSON.stringify(r10.data).slice(0, 200)}`);
}

console.log('');
try {
  await main();
} catch (e) {
  fail('演练异常', String(e?.stack || e));
} finally {
  console.log('\n── 回滚与复核 ──');
  if (prisma) { await rollback(); await verifyNoResidue(); }
  const failed = results.filter(r => r.ok === false).length;
  const okCount = results.filter(r => r.ok === true).length;
  console.log(`\n═══ 汇总：${okCount} 通过 / ${failed} 失败 ═══`);
  await prisma?.$disconnect?.();
  process.exit(failed === 0 ? 0 : 1);
}
