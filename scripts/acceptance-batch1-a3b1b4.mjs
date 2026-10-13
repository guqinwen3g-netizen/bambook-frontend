// 批次 1（A3/B1/B4）零基础障碍清障 —— 真实 API 演练（登录 + 真路由 + 读库复核 + 自清理）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// ── 本脚本要证的东西 ──
//   B1（097ed5d7）：Pending 订单「直接取消」入口从无到有 ——
//     旧三条路全堵（acceptance-pending-cancel-path.mjs S2/S3/S4 实测），
//     设计真源 订单变更规则.md §2A.1 要求「待审批订单业务员可直接取消」。
//     新路 = POST /api/v1/orders/:id/cancel（orders:write 权限门 + 服务层 fail-closed）。
//   B4（9ef23c80）：已开票运单删除被挡（INVOICE_LINKED 409），无批次运单不受影响。
//   A3（842be003）：贷项票抵扣落发票侧 —— CN 抵平 → 发票 Paid + 退出未结清应收
//     （API 层走 /api/v1/claims/credit-notes，真路由进真服务）。
//
// 断言清单：
//   S1 ★前置  登录 owner + sales；建 DRILL-B1- Pending 订单
//   S2 ★承重  sales 直接取消 Pending → 200，读库 status=Cancelled + 时间线 note=理由
//   S3 ★承重  Confirmed 订单直接取消 → 409 ORDER_NOT_PENDING（提示走 DR-010 链）
//   S4 ★承重  挂发票的 Pending 直接取消 → 409 ORDER_HAS_DEPENDENTS 且状态无副作用
//   S5  护栏  理由空白 → 400；不存在订单 → 404
//   S6 ★承重  Draft 运单 + 批次 + 开票分摊 → DELETE 409 INVOICE_LINKED（读库未删）
//   S7 ★承重  Draft 运单无批次 → DELETE 200
//   S8 ★承重  CN 抵平发票 → 200；读库发票 Paid + CN Closed + 退出 openReceivable
//   S9  护栏  CN 超发票剩余可抵 → 409/400 拒绝且 CN 余额未动
//   S10       回滚 + 独立复核零残留
//
// 用法：node scripts/acceptance-batch1-a3b1b4.mjs （需 8081 后端已加载新代码）
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';

const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n}${d ? ' — ' + d : ''}`); };

const TS = Date.now();
const PO = (k) => `DRILL-B1-${k}-${TS}`;
let prisma = null;
const trash = { orders: [], shipments: [], invoices: [], cnIds: [] };

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

async function makeOrder(token, key, status = 'Pending') {
  const r = await api(token, 'POST', '/api/v1/orders', {
    poNumber: PO(key), customer: `DRILL-B1-客户-${TS}`, millName: `DRILL-B1-工厂-${TS}`,
    product: 'TR 面料', type: 'Fabric', quantity: 1000000, status,
    dueDate: '2027-12-31', quoteAmount: 3000000, currency: 'USD',
  });
  const order = r.data?.order ?? r.data;
  if (!order?.id) throw new Error(`建单失败: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  trash.orders.push(order.id);
  return order;
}

async function makeShipment(token, key, status = 'Draft') {
  const r = await api(token, 'POST', '/api/v1/shipping', {
    shipmentNumber: `DRILL-B1-SHP-${key}-${TS}`, type: 'Export', status, shippingMethod: 'Sea',
  });
  const sh = r.data?.shipment ?? r.data?.data?.shipment ?? r.data;
  if (!sh?.id) throw new Error(`建运单失败: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  trash.shipments.push(sh.id);
  return sh;
}

async function seedInvoicedBatch(orderId, shipmentId) {
  const { Prisma } = await require4Prisma();
  const D = Prisma.Decimal;
  const batch = await prisma.orderShipmentBatch.create({
    data: {
      id: `OSB__DRILLB1_${TS}_${shipmentId.slice(-6)}`, orderId, shipmentId, batchNo: 1,
      currency: 'USD', status: 'shipped', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
  const inv = await prisma.invoice.create({
    data: {
      id: `INV__DRILLB1_${TS}_${shipmentId.slice(-6)}`, invoiceNumber: `DRILL-B1-INV-${TS}-${shipmentId.slice(-6)}`,
      type: 'Receivable', status: 'Issued', amount: new D('500'), currency: 'USD',
      issueDate: '2026-09-18', orderId, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
  trash.invoices.push(inv.id);
  await prisma.invoiceOrderAllocation.create({
    data: {
      id: `IOA__DRILLB1_${TS}_${shipmentId.slice(-6)}`, invoiceId: inv.id, orderId, batchId: batch.id,
      allocatedAmount: new D('500'), createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
  return { batch, inv };
}

let _prismaMod = null;
async function require4Prisma() {
  if (!_prismaMod) {
    const { createRequire } = await import('node:module');
    const { SERVER_DIR } = await import('./lib/acceptance-selfcheck.mjs');
    _prismaMod = createRequire(SERVER_DIR + '/')('@prisma/client');
  }
  return _prismaMod;
}

async function seedCreditNote(key, amount) {
  const { Prisma } = await require4Prisma();
  const D = Prisma.Decimal;
  const id = `CN_DRILLB1_${TS}_${key}`;
  await prisma.creditNote.create({
    data: {
      id, creditNoteNumber: `CLM-DRILL-${TS}-${key}`,
      customerName: `DRILL-B1-客户-${TS}`, currency: 'USD',
      amount: new D(String(amount)), openAmount: new D(String(amount)),
      status: 'Open', issueDate: '2026-09-18', reason: `DRILL-B1-${TS}`,
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
  trash.cnIds.push(id);
  return id;
}

async function cleanup() {
  if (!prisma) return;
  for (const cnId of trash.cnIds) {
    await prisma.creditNoteAllocation.deleteMany({ where: { creditNoteId: cnId } }).catch(() => {});
    await prisma.creditNote.deleteMany({ where: { id: cnId } }).catch(() => {});
  }
  await prisma.invoiceOrderAllocation.deleteMany({ where: { invoiceId: { in: trash.invoices } } }).catch(() => {});
  await prisma.invoice.deleteMany({ where: { id: { in: trash.invoices } } }).catch(() => {});
  await prisma.orderShipmentBatch.deleteMany({ where: { orderId: { in: trash.orders } } }).catch(() => {});
  await prisma.shipment.updateMany({ where: { id: { in: trash.shipments } }, data: { deletedAt: null } }).catch(() => {});
  await prisma.shipment.deleteMany({ where: { id: { in: trash.shipments } } }).catch(() => {});
  for (const oid of trash.orders) {
    await prisma.orderStatusTransition.deleteMany({ where: { orderId: oid } }).catch(() => {});
  }
  await prisma.order.deleteMany({ where: { id: { in: trash.orders } } }).catch(() => {});
  // 兜底清扫：历史上途崩掉的演练运行残留（全部带 DRILL-B1- 前缀，非演练数据不含此前缀）
  const strayOrders = (await prisma.order.findMany({ where: { poNumber: { startsWith: 'DRILL-B1-' } }, select: { id: true } }).catch(() => [])).map(r => r.id);
  if (strayOrders.length) {
    await prisma.orderStatusTransition.deleteMany({ where: { orderId: { in: strayOrders } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: strayOrders } } }).catch(() => {});
  }
  await prisma.shipment.deleteMany({ where: { shipmentNumber: { startsWith: 'DRILL-B1-SHP-' } } }).catch(() => {});
  await prisma.creditNoteAllocation.deleteMany({ where: { creditNoteId: { startsWith: 'CN_DRILLB1_' } } }).catch(() => {});
  await prisma.creditNote.deleteMany({ where: { id: { startsWith: 'CN_DRILLB1_' } } }).catch(() => {});
  const strayInvs = (await prisma.invoice.findMany({ where: { invoiceNumber: { startsWith: 'DRILL-B1-INV-' } }, select: { id: true } }).catch(() => [])).map(r => r.id);
  if (strayInvs.length) {
    await prisma.invoiceOrderAllocation.deleteMany({ where: { invoiceId: { in: strayInvs } } }).catch(() => {});
    await prisma.creditNoteAllocation.deleteMany({ where: { invoiceId: { in: strayInvs } } }).catch(() => {});
    await prisma.invoice.deleteMany({ where: { id: { in: strayInvs } } }).catch(() => {});
  }
}

async function main() {
  console.log('\n═══ 批次 1（A3/B1/B4）真实 API 演练 ═══');
  await connectPrisma();

  // ── S1 前置：登录 + 建单 ──
  const owner = await login('jason.shen@bambook.local');
  const sales = await login('chloe.su@bambook.local');
  if (!owner || !sales) return fail('S1 登录', `owner=${!!owner} sales=${!!sales}`);
  pass('S1 前置 登录 owner+sales');

  const ordA = await makeOrder(owner, 'A'); // sales 直接取消（Pending）
  const ordB = await makeOrder(owner, 'B'); // 推到 Confirmed 后拒绝
  const ordC = await makeOrder(owner, 'C'); // 挂发票后拒绝
  pass('S1 前置 建 3 张 Pending 订单', `${PO('A')} / ${PO('B')} / ${PO('C')}`);

  // ── S2 ★承重：sales 直接取消 Pending ──
  const r2 = await api(sales, 'POST', `/api/v1/orders/${ordA.id}/cancel`, { reason: '客户改单，重下（DRILL-B1 演练）' });
  const dbA = await prisma.order.findUnique({ where: { id: ordA.id }, select: { status: true } });
  const tl = await prisma.orderStatusTransition.findFirst({ where: { orderId: ordA.id, toStatus: 'Cancelled' } });
  if (r2.status === 200 && dbA?.status === 'Cancelled' && tl?.note?.includes('客户改单')) {
    pass('S2 ★承重 sales 直接取消 Pending → 200 + Cancelled + 时间线留痕理由', `operator=${tl.operator}`);
  } else {
    fail('S2 ★承重 sales 直接取消 Pending', `HTTP ${r2.status} ${JSON.stringify(r2.data).slice(0, 160)} db=${dbA?.status} note=${tl?.note}`);
  }

  // ── S3 ★承重：Confirmed → 409 ORDER_NOT_PENDING ──
  const tr = await api(owner, 'POST', `/api/v1/orders/${ordB.id}/status-transition`, { toStatus: 'Confirmed', note: 'DRILL-B1 演练' });
  if (tr.status !== 200) return fail('S3 前置 推进 Confirmed', `HTTP ${tr.status} ${JSON.stringify(tr.data).slice(0, 160)}`);
  const r3 = await api(owner, 'POST', `/api/v1/orders/${ordB.id}/cancel`, { reason: '试试' });
  if (r3.status === 409 && r3.data?.error?.code === 'ORDER_NOT_PENDING' && r3.data?.error?.message?.includes('DR-010')) {
    pass('S3 ★承重 Confirmed 直接取消 → 409 ORDER_NOT_PENDING（提示走 DR-010 链）');
  } else {
    fail('S3 ★承重 Confirmed 直接取消', `HTTP ${r3.status} ${JSON.stringify(r3.data).slice(0, 160)}`);
  }

  // ── S4 ★承重：挂发票的 Pending → 409 ORDER_HAS_DEPENDENTS ──
  const pm = await require4Prisma();
  const D = pm.Prisma.Decimal;
  const invC = await prisma.invoice.create({
    data: {
      id: `INV__DRILLB1_C_${TS}`, invoiceNumber: `DRILL-B1-INV-C-${TS}`,
      type: 'Receivable', status: 'Issued', amount: new D('100'), currency: 'USD',
      issueDate: '2026-09-18', orderId: ordC.id, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
  trash.invoices.push(invC.id);
  const r4 = await api(sales, 'POST', `/api/v1/orders/${ordC.id}/cancel`, { reason: '试试' });
  const dbC = await prisma.order.findUnique({ where: { id: ordC.id }, select: { status: true } });
  if (r4.status === 409 && r4.data?.error?.code === 'ORDER_HAS_DEPENDENTS' && dbC?.status === 'Pending') {
    pass('S4 ★承重 挂发票的 Pending 直接取消 → 409 ORDER_HAS_DEPENDENTS（无副作用）');
  } else {
    fail('S4 ★承重 挂发票的 Pending 直接取消', `HTTP ${r4.status} ${JSON.stringify(r4.data).slice(0, 160)} db=${dbC?.status}`);
  }

  // ── S5 护栏：理由空白 / 不存在 ──
  const ordD = await makeOrder(owner, 'D');
  const r5a = await api(sales, 'POST', `/api/v1/orders/${ordD.id}/cancel`, { reason: '   ' });
  const r5b = await api(sales, 'POST', '/api/v1/orders/ORDER_MISSING_XYZ/cancel', { reason: '试试' });
  if (r5a.status === 400 && r5b.status === 404) pass('S5 护栏 理由空白→400；不存在→404');
  else fail('S5 护栏', `blank=${r5a.status} missing=${r5b.status}`);

  // ── S6 ★承重：已开票运单删除被挡 ──
  const sh6 = await makeShipment(owner, 'L');
  await seedInvoicedBatch(ordD.id, sh6.id);
  const r6 = await api(owner, 'DELETE', `/api/v1/shipping/${sh6.id}`);
  const dbSh6 = await prisma.shipment.findUnique({ where: { id: sh6.id }, select: { deletedAt: true } });
  if (r6.status === 409 && r6.data?.error?.code === 'INVOICE_LINKED' && dbSh6?.deletedAt === null) {
    pass('S6 ★承重 已开票运单 DELETE → 409 INVOICE_LINKED（未删）');
  } else {
    fail('S6 ★承重 已开票运单 DELETE', `HTTP ${r6.status} ${JSON.stringify(r6.data).slice(0, 160)}`);
  }

  // ── S7 ★承重：无批次运单删除不受影响 ──
  const sh7 = await makeShipment(owner, 'M');
  const r7 = await api(owner, 'DELETE', `/api/v1/shipping/${sh7.id}`);
  if (r7.status === 200) pass('S7 ★承重 无批次 Draft 运单 DELETE → 200');
  else fail('S7 ★承重 无批次运单 DELETE', `HTTP ${r7.status} ${JSON.stringify(r7.data).slice(0, 160)}`);

  // ── S8/S9：A3 贷项票抵扣（API 层）──
  const invE = await prisma.invoice.create({
    data: {
      id: `INV__DRILLB1_E_${TS}`, invoiceNumber: `DRILL-B1-INV-E-${TS}`,
      type: 'Receivable', status: 'Issued', amount: new D('300'), currency: 'USD',
      issueDate: '2026-09-18', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
  trash.invoices.push(invE.id);
  // ⓘ CN 无独立创建路由（创建走索赔处置 executeDisposition 收口）；本演练播种 CN、走真实 apply 路由。
  //   开单/作废路径已由 creditNoteService 单测（25）+ 真库守卫（6）覆盖。
  const cn1Id = await seedCreditNote('E1', 300);
  if (!cn1Id) return fail('S8 前置 播种 CN', '见上');
  const r8 = await api(sales, 'POST', `/api/v1/credit-notes/${cn1Id}/apply`, { appliedAmount: 300, toInvoiceId: invE.id });
  const invAfter = await prisma.invoice.findUnique({ where: { id: invE.id }, select: { status: true, settlementDate: true } });
  const cnAfter = await prisma.creditNote.findUnique({ where: { id: cn1Id }, select: { status: true, openAmount: true } });
  const cna = await prisma.creditNoteAllocation.findFirst({ where: { creditNoteId: cn1Id, invoiceId: invE.id } });
  const stillOpen = await prisma.invoice.findFirst({ where: { id: invE.id, type: 'Receivable', status: { in: ['Issued', 'PartiallyPaid'] }, deletedAt: null, amount: { gt: 0 } } });
  if (r8.status === 200 && invAfter?.status === 'Paid' && invAfter?.settlementDate && cnAfter?.status === 'Closed' && cna && !stillOpen) {
    pass('S8 ★承重 CN 抵平发票 → 发票 Paid + 明细落行 + 退出未结清应收');
  } else {
    fail('S8 ★承重 CN 抵平发票', `HTTP ${r8.status} ${JSON.stringify(r8.data).slice(0, 160)} inv=${invAfter?.status} cn=${cnAfter?.status} cna=${!!cna} open=${!!stillOpen}`);
  }

  // ── S9 护栏：超抵拒绝 ──
  const invF = await prisma.invoice.create({
    data: {
      id: `INV__DRILLB1_F_${TS}`, invoiceNumber: `DRILL-B1-INV-F-${TS}`,
      type: 'Receivable', status: 'Issued', amount: new D('100'), currency: 'USD',
      issueDate: '2026-09-18', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
  trash.invoices.push(invF.id);
  const cn2Id = await seedCreditNote('F1', 200);
  const r9 = await api(sales, 'POST', `/api/v1/credit-notes/${cn2Id}/apply`, { appliedAmount: 200, toInvoiceId: invF.id });
  const cn2After = await prisma.creditNote.findUnique({ where: { id: cn2Id }, select: { openAmount: true } });
  const code9 = r9.data?.error; // claims 路由错误体 = { error: 'CODE', message }
  if (r9.status === 409 && (code9 === 'OVER_APPLIED') && Number(cn2After?.openAmount) === 200) {
    pass('S9 护栏 CN 超发票剩余可抵 → 409 OVER_APPLIED（余额未动）');
  } else {
    fail('S9 护栏 CN 超抵', `HTTP ${r9.status} code=${code9} open=${cn2After?.openAmount}`);
  }

  // ── S10 清理 + 复核 ──
  await cleanup();
  const [lo, ls, li] = await Promise.all([
    prisma.order.count({ where: { poNumber: { startsWith: 'DRILL-B1-' } } }),
    prisma.shipment.count({ where: { shipmentNumber: { startsWith: 'DRILL-B1-SHP-' } } }),
    prisma.invoice.count({ where: { invoiceNumber: { startsWith: 'DRILL-B1-INV-' } } }),
  ]);
  if (lo === 0 && ls === 0 && li === 0) pass('S10 回滚 + 独立复核零残留');
  else fail('S10 残留', `orders=${lo} shipments=${ls} invoices=${li}`);

  // ── 汇总 ──
  const failed = results.filter(r => r.ok === false).length;
  console.log(`\n═══ 结果：${results.filter(r => r.ok === true).length} 通过 / ${failed} 失败 / ${results.filter(r => r.ok == null).length} 信息 ═══`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('脚本异常:', e);
  await cleanup().catch(() => {});
  process.exit(1);
});
