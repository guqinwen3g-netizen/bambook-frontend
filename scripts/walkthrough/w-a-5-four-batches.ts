/**
 * w-a-5-four-batches.ts — W-A-5 切片卡「四批次新功能专项」代码级模拟操作走查
 *
 * 走查范围（v0.8 四批次新功能，从未被真人点过）：
 *   域1 分批出运尾款（P0-1）：批次计划合计约束 / 超量门禁 / 末批唯一 / 尾款门禁 fail-closed /
 *        skipGate 豁免留痕 / 结算自动触发挂接（87cd361：核销→批次 invoiced/paid 回写）
 *   域2 催款分级（P0-2）：账龄自动定级 reminder→firm→urgent→legal / 人工钉住 / 穿透规则 /
 *        非法入参被拒 / DunningRecord 留痕
 *   域3 客户专属面料（P1-3）：FabricCustomerCode.isExclusive 属主绑定 / 四入口（订单行/报价/样品/装箱）
 *        一致生效 / 非属主 409 EXCLUSIVE_FABRIC_BLOCKED / 违规尝试审计留痕
 *   域4 物料退换货（P1-4）：pending→shipped→confirmed→settled 状态机 / 库存 Outbound/Inbound 对称 /
 *        claim 负向 Payable 发票 / 额度与非法跳转门禁
 *
 * 执行方式说明：
 *   - 直调后端 service 层（路由层为薄透传，写路由挂 requireRole 需 JWT；service 是 route+Agent 双通道共用契约）。
 *   - 连接真实 pandahub 库（server/.env DATABASE_URL）；夹具经 Prisma 直插并显式标注；
 *     业务动作一律走真实 service 函数，每步断言返回值 + 数据库落点。
 *   - 结算挂接（87cd361）经 createAllocation（POST /allocations 的真实入口）触发，
 *     其事务内调 applyAllocation → notifyShipmentBatchSettlementRecalc，链路保真。
 *   - 全程演员 actorId 使用库内真实 UserAccount（AuditLog.actorId 有 FK，'api' 哨兵无账号会 FK 违约）。
 *   - 走查结束清理全部业务夹具（AuditLog 留痕保留——审计线索本身即证据）。
 *
 * 运行：node server/node_modules/.bin/tsx scripts/walkthrough/w-a-5-four-batches.ts
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ────────────────────────────────────────────────────────────────────
// 环境装配：server/.env DATABASE_URL + server 侧 @prisma/client
// ────────────────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '../../server');
try {
  const envText = readFileSync(path.join(SERVER_DIR, '.env'), 'utf8');
  for (const raw of envText.split('\n')) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* 依赖外部环境变量 */ }

const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const { PrismaClient } = serverRequire('@prisma/client');

// ────────────────────────────────────────────────────────────────────
// 走查记录框架
// ────────────────────────────────────────────────────────────────────
type Verdict = 'PASS' | 'FAIL';
interface StepRec {
  domain: string;
  step: string;
  call: string;
  params?: any;
  returned?: any;
  asserts: string[];
  verdict: Verdict;
  note?: string;
}
const records: StepRec[] = [];
let cur: StepRec | null = null;

/** 深序列化（BigInt/Decimal → number，截断长串），保证可打印 */
function safe(v: any, depth = 0): any {
  if (v == null) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 220 ? `${v.slice(0, 220)}…` : v;
  if (v instanceof Date) return v.toISOString();
  if (depth > 4) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 12).map((x) => safe(x, depth + 1));
  if (typeof v === 'object') {
    // Prisma Decimal：有 toFixed/dpe 标识
    if (typeof v.toFixed === 'function' && v.constructor?.name === 'Decimal') return Number(v.toString());
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'function') continue;
      out[k] = safe(val, depth + 1);
    }
    return out;
  }
  return String(v);
}

function begin(domain: string, step: string, call: string, params?: any) {
  cur = { domain, step, call, params: safe(params), asserts: [], verdict: 'PASS' };
}
function assert(cond: any, label: string) {
  const pass = !!cond;
  cur?.asserts.push(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) throw new Error(`断言失败: ${label}`);
}
function done(returned?: any, note?: string) {
  if (!cur) return;
  cur.returned = safe(returned);
  if (note) cur.note = note;
  records.push(cur);
  cur = null;
}
function failStep(err: any, returned?: any) {
  if (!cur) return;
  cur.verdict = 'FAIL';
  cur.returned = safe(returned);
  cur.note = String(err?.message ?? err);
  records.push(cur);
  cur = null;
}

const TAG = `WA5${Date.now().toString(36).toUpperCase()}`;
const TODAY = new Date().toISOString().slice(0, 10);
const nowBig = () => BigInt(Date.now());

// 夹具登记（清理用）
const fx: Record<string, string[]> = {
  relations: [], orders: [], shipments: [], invoices: [], vouchers: [], ioa: [], allocations: [],
  batches: [], dunningRecords: [], quotations: [], samples: [], materialReturns: [], stockMovements: [],
  purchaseOrders: [], receipts: [], inventoryItems: [], warehouses: [], productAssets: [],
  fabricProfiles: [], fabricCustomerCodes: [], dunningProfiles: [], orderLines: [], shipmentLines: [],
  claimInvoices: [],
};
const fixtureIds = () => Object.values(fx).flat();

async function main() {
  const prisma = new PrismaClient();
  const db = prisma as any;

  // ── service 装配（动态导入，保证 env 先于模块加载） ──
  const { createOrderShipmentBatchService } = await import('../../server/src/shipping/orderShipmentBatchService');
  const { createDunningService } = await import('../../server/src/finance/dunningService');
  const { createDunningStageService, stageOfBuckets, scopeKeyOf } = await import('../../server/src/finance/dunningStageService');
  const { assertFabricAllowed, validateExclusiveCodes } = await import('../../server/src/products/fabricExclusivityService');
  const { createMaterialReturnService } = await import('../../server/src/procurement/materialReturnService');
  const { createAllocation } = await import('../../server/src/finance/allocationMutationService');
  const { createOrderLine } = await import('../../server/src/orders/orderLineMutationService');
  const { createQuotationService } = await import('../../server/src/quotations/quotationService');
  const { createFabricShipmentSampleService } = await import('../../server/src/samples/fabricShipmentSampleService');
  const { replaceShipmentLinesTx } = await import('../../server/src/shipping/shipmentPackingService');

  const batchService = createOrderShipmentBatchService(prisma);
  const dunningService = createDunningService(prisma);
  const dunningStageService = createDunningStageService(prisma);
  const returnService = createMaterialReturnService(prisma);
  const quotationService = createQuotationService(prisma);
  const sampleService = createFabricShipmentSampleService({ prisma });

  // 演员：AuditLog.actorId FK 要求真实 UserAccount
  const sysUser = await db.userAccount.findFirst({ where: { id: 'system' }, select: { id: true } });
  const anyUser = sysUser ?? (await db.userAccount.findFirst({ select: { id: true } }));
  if (!anyUser) throw new Error('库内无 UserAccount，审计 FK 无法满足，走查中止');
  const ACTOR: string = anyUser.id;

  console.log(`════════════════════════════════════════════════════════════════`);
  console.log(`W-A-5 四批次新功能专项走查  TAG=${TAG}  actor=${ACTOR}  date=${TODAY}`);
  console.log(`════════════════════════════════════════════════════════════════`);

  try {
    // ════════════════════════════════════════════════════════════════
    // 夹具：客户 A（专属面料属主）/ 客户 B（非属主）/ 供应商 S
    // ════════════════════════════════════════════════════════════════
    const relA = await db.relation.create({
      data: { id: `REL_${TAG}_A`, name: `WA5走查客户A-${TAG}`, category: 'Customer', type: 'organization', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: nowBig() },
    });
    const relB = await db.relation.create({
      data: { id: `REL_${TAG}_B`, name: `WA5走查客户B-${TAG}`, category: 'Customer', type: 'organization', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: nowBig() },
    });
    const relS = await db.relation.create({
      data: { id: `REL_${TAG}_S`, name: `WA5走查供应商S-${TAG}`, category: 'Supplier', type: 'organization', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: nowBig() },
    });
    fx.relations.push(relA.id, relB.id, relS.id);

    const mkOrder = async (id: string, customer: any, quoteAmount: number, paymentTerms: string | null) => {
      const o = await db.order.create({
        data: {
          id, customer: customer.name, customerRelationId: customer.id, product: 'WA5走查面料', type: 'Fabric',
          quantity: 1000, status: 'InProduction', dueDate: '2026-12-31', quoteAmount,
          salesCurrency: 'USD', paymentTerms, updatedAt: nowBig(),
        },
      });
      fx.orders.push(o.id);
      return o;
    };
    const orderA = await mkOrder(`ORD_${TAG}_A`, relA, 10000, 'T/T 30% deposit, 70% against B/L 30 days');
    const orderB = await mkOrder(`ORD_${TAG}_B`, relB, 8000, null);
    const orderC = await mkOrder(`ORD_${TAG}_C`, relA, 5000, null);

    const mkShipment = async (id: string, num: string, customer: any | null, status: string) => {
      const s = await db.shipment.create({
        data: {
          id, shipmentNumber: num, type: 'Export', status, shippingMethod: 'Sea',
          atd: TODAY, customerRelationId: customer?.id ?? null, customerName: customer?.name ?? null,
          createdAt: nowBig(), updatedAt: nowBig(),
        },
      });
      fx.shipments.push(s.id);
      return s;
    };
    const shipment1 = await mkShipment(`SHP_${TAG}_1`, `SHP-WA5-${TAG}-1`, relA, 'Booked');
    const shipmentB = await mkShipment(`SHP_${TAG}_B`, `SHP-WA5-${TAG}-2`, relB, 'Draft');
    const shipmentA2 = await mkShipment(`SHP_${TAG}_A2`, `SHP-WA5-${TAG}-3`, relA, 'Draft');

    // ╔════════════════════════════════════════════════════════════╗
    // ║ 域 1：分批出运尾款（P0-1）                                  ║
    // ╚════════════════════════════════════════════════════════════╝
    const D1 = '域1 分批出运尾款';
    let batch1: any, batch2: any;

    begin(D1, 'S01 首批批次登记 plannedRatio=60', 'orderShipmentBatchService.createBatch', { orderId: orderA.id, plannedRatio: 60, isFinalBatch: false });
    try {
      const r = await batchService.createBatch({ orderId: orderA.id, plannedRatio: 60, isFinalBatch: false, unit: 'M', plannedQty: 600 }, ACTOR);
      assert(r.ok === true, `createBatch ok（实际 ${JSON.stringify(safe(r.error ?? null))}）`);
      batch1 = r.data;
      fx.batches.push(batch1.id);
      assert(batch1.batchNo === 1, `batchNo=1（实际 ${batch1.batchNo}）`);
      assert(batch1.amount === 6000, `金额按订单额×占比推导=6000（实际 ${batch1.amount}）`);
      assert(batch1.status === 'planned' && batch1.settleStatus === 'unsettled', `初始状态 planned/unsettled（实际 ${batch1.status}/${batch1.settleStatus}）`);
      assert(batch1.isFinalBatch === false, '显式非末批生效');
      assert(batch1.currency === 'USD', '币种快照=订单销售币种 USD');
      done(batch1, '注：切片卡“plannedRatio=0.6”按 schema 百分比语义执行为 60（Decimal(5,2)，合计约束 100）');
    } catch (e) { failStep(e); }

    begin(D1, 'S02 末批登记 plannedRatio=40 + isFinalBatch=true', 'orderShipmentBatchService.createBatch', { orderId: orderA.id, plannedRatio: 40, isFinalBatch: true });
    try {
      const r = await batchService.createBatch({ orderId: orderA.id, plannedRatio: 40, isFinalBatch: true, unit: 'M', plannedQty: 400 }, ACTOR);
      assert(r.ok === true, `createBatch ok（实际 ${JSON.stringify(safe(r.error ?? null))}）`);
      batch2 = r.data;
      fx.batches.push(batch2.id);
      assert(batch2.batchNo === 2, `batchNo 自动递增=2（实际 ${batch2.batchNo}）`);
      assert(batch2.amount === 4000, `末批金额=4000（实际 ${batch2.amount}）`);
      assert(batch2.isFinalBatch === true, '末批锚点标记');
      done(batch2);
    } catch (e) { failStep(e); }

    begin(D1, 'S03 超量批次被门禁拒绝（60+40+50=150%>100%）', 'orderShipmentBatchService.createBatch', { plannedRatio: 50 });
    try {
      const r = await batchService.createBatch({ orderId: orderA.id, plannedRatio: 50 }, ACTOR);
      assert(r.ok === false, '返回 ok=false（被拒）');
      assert((r as any).error?.code === 'RATIO_EXCEEDED', `错误码 RATIO_EXCEEDED（实际 ${(r as any).error?.code}）`);
      assert((r as any).error?.status === 400, 'HTTP 语义 400');
      done((r as any).error, 'fail-closed：批次合计受订单总量约束');
    } catch (e) { failStep(e); }

    begin(D1, 'S04 末批唯一约束（第二末批被拒）', 'orderShipmentBatchService.createBatch', { plannedQty: 10, isFinalBatch: true });
    try {
      const r = await batchService.createBatch({ orderId: orderA.id, plannedQty: 10, isFinalBatch: true }, ACTOR);
      assert(r.ok === false, '返回 ok=false（被拒）');
      assert((r as any).error?.code === 'FINAL_BATCH_DUPLICATE', `错误码 FINAL_BATCH_DUPLICATE（实际 ${(r as any).error?.code}）`);
      assert((r as any).error?.status === 409, 'HTTP 语义 409');
      done((r as any).error);
    } catch (e) { failStep(e); }

    begin(D1, 'S05 批次合计=订单总额（listByOrder 全景）', 'orderShipmentBatchService.listByOrder', { orderId: orderA.id });
    try {
      const r = await batchService.listByOrder(orderA.id);
      assert(r.ok === true, 'listByOrder ok');
      const s = r.data.summary;
      assert(s.totalBatches === 2, `totalBatches=2（实际 ${s.totalBatches}）`);
      assert(s.totalPlannedAmount === 10000, `批次合计=订单总额 10000（实际 ${s.totalPlannedAmount}）`);
      assert(r.data.orderAmount === 10000, 'orderAmount=quoteAmount 口径');
      done(s);
    } catch (e) { failStep(e); }

    begin(D1, 'S06 未排船批次发运被拒', 'orderShipmentBatchService.markShipped（无 shipmentId）', { batchId: batch1?.id });
    try {
      const r = await batchService.markShipped(batch1.id, undefined, ACTOR);
      assert(r.ok === false, '返回 ok=false（被拒）');
      assert((r as any).error?.code === 'SHIPMENT_REQUIRED', `错误码 SHIPMENT_REQUIRED（实际 ${(r as any).error?.code}）`);
      done((r as any).error);
    } catch (e) { failStep(e); }

    begin(D1, 'S07 首批标记 shipped（排船回填）', 'orderShipmentBatchService.markShipped', { batchId: batch1?.id, shipmentId: shipment1.id });
    try {
      const r = await batchService.markShipped(batch1.id, { shipmentId: shipment1.id }, ACTOR);
      assert(r.ok === true, `markShipped ok（实际 ${JSON.stringify(safe(r.error ?? null))}）`);
      assert(r.data.status === 'shipped', `status=shipped（实际 ${r.data.status}）`);
      assert(Number(r.data.shippedAt) > 0, 'shippedAt 已回填（取运单 atd）');
      assert(r.data.shipmentId === shipment1.id, '运单关联落库');
      done(r.data);
    } catch (e) { failStep(e); }

    begin(D1, 'S08 已发运批次计划冻结（改占比被拒）', 'orderShipmentBatchService.updateBatch', { batchId: batch1?.id, plannedRatio: 70 });
    try {
      const r = await batchService.updateBatch(batch1.id, { plannedRatio: 70 }, ACTOR);
      assert(r.ok === false, '返回 ok=false（被拒）');
      assert((r as any).error?.code === 'PLAN_FROZEN', `错误码 PLAN_FROZEN（实际 ${(r as any).error?.code}）`);
      assert((r as any).error?.status === 409, 'HTTP 语义 409');
      done((r as any).error);
    } catch (e) { failStep(e); }

    begin(D1, 'S09 末批发运尾款门禁：未收款 fail-closed 阻断', 'orderShipmentBatchService.markShipped（末批，无收款）', { batchId: batch2?.id });
    try {
      const r = await batchService.markShipped(batch2.id, { shipmentId: shipment1.id }, ACTOR);
      assert(r.ok === false, '返回 ok=false（被拒）');
      assert((r as any).error?.code === 'FINAL_PAYMENT_GATE_BLOCKED', `错误码 FINAL_PAYMENT_GATE_BLOCKED（实际 ${(r as any).error?.code}）`);
      assert((r as any).error?.status === 409, 'HTTP 语义 409');
      const after = await db.orderShipmentBatch.findUnique({ where: { id: batch2.id } });
      assert(after.status === 'planned', '阻断后状态停留 planned（无部分写入）');
      done((r as any).error, `门禁线=（订单额 10000 − 末批 4000）×100% = 6000，已收 0 → 阻断`);
    } catch (e) { failStep(e); }

    // 结算挂接夹具：发票 7000（批次归属 6000）+ 收款凭证 7000，核销 6000
    // （刻意部分核销：发票/凭证均不全额 → 不触发 PaymentReceived/AllocationReconciled 业务事件，
    //    避免向运行中服务器投递 bev: AgentJob 噪音；批次侧 paid=6000 已足够验证门禁与挂接）
    const inv1 = await db.invoice.create({
      data: {
        id: `INV__${TAG}_1`, invoiceNumber: `INV-WA5-${TAG}-1`, type: 'Receivable', status: 'Issued',
        amount: 7000, currency: 'USD', issueDate: TODAY, orderId: orderA.id,
        customerRelationId: relA.id, customerName: relA.name, createdAt: nowBig(), updatedAt: nowBig(),
      },
    });
    fx.invoices.push(inv1.id);
    const voc1 = await db.paymentVoucher.create({
      data: {
        id: `PAY__${TAG}_1`, voucherNumber: `PAY-WA5-${TAG}-1`, type: 'Receipt', amount: 7000, currency: 'USD',
        paymentDate: TODAY, paymentMethod: 'TT', status: 'unreconciled',
        customerRelationId: relA.id, customerName: relA.name, orderId: orderA.id, createdAt: nowBig(), updatedAt: nowBig(),
      },
    });
    fx.vouchers.push(voc1.id);
    const ioa1 = await db.invoiceOrderAllocation.create({
      data: {
        id: `IOA__${TAG}_1`, invoiceId: inv1.id, orderId: orderA.id, batchId: batch1.id,
        allocatedAmount: 6000, createdAt: nowBig(), updatedAt: nowBig(),
      },
    });
    fx.ioa.push(ioa1.id);

    begin(D1, 'S10 尾款结算自动触发挂接（87cd361：核销→批次快照回写）', 'allocationMutationService.createAllocation（POST /allocations 真实入口）', { invoiceId: inv1.id, voucherId: voc1.id, appliedAmount: 6000 });
    try {
      const r = await createAllocation({ prisma, input: { invoiceId: inv1.id, voucherId: voc1.id, appliedAmount: 6000, appliedDate: TODAY }, actorId: ACTOR });
      assert(r.ok === true, `createAllocation ok（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      fx.allocations.push((r as any).data.allocation.id);
      const b1 = await db.orderShipmentBatch.findUnique({ where: { id: batch1.id } });
      assert(Number(b1.invoicedAmount) === 6000, `批次已开票回写=6000（实际 ${Number(b1.invoicedAmount)}）`);
      assert(Number(b1.paidAmount) === 6000, `批次已收款回写=6000（实际 ${Number(b1.paidAmount)}）`);
      assert(b1.settleStatus === 'settled', `settleStatus=settled（实际 ${b1.settleStatus}）`);
      assert(Number(b1.settledAt) > 0, 'settledAt 落库');
      const invAfter = await db.invoice.findUnique({ where: { id: inv1.id } });
      assert(invAfter.status === 'PartiallyPaid', `发票 7000 核销 6000 → PartiallyPaid（实际 ${invAfter.status}；刻意不全额以规避 bev 事件噪音）`);
      done({ invoicedAmount: Number(b1.invoicedAmount), paidAmount: Number(b1.paidAmount), settleStatus: b1.settleStatus }, 'hook 在核销事务内触发 recalcSettlement，同事务落库');
    } catch (e) { failStep(e); }

    begin(D1, 'S11 末批发运：收款达标后门禁放行 + 尾款到期日计算', 'orderShipmentBatchService.markShipped（末批，已收 6000）', { batchId: batch2?.id });
    try {
      const r = await batchService.markShipped(batch2.id, { shipmentId: shipment1.id }, ACTOR);
      assert(r.ok === true, `markShipped ok（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      assert(r.data.status === 'shipped', '末批 shipped');
      assert(r.data.finalPaymentDueDate === '2026-09-26', `尾款到期日=atd(2026-08-27)+paymentTerms 30 天=2026-09-26（实际 ${r.data.finalPaymentDueDate}）`);
      done(r.data);
    } catch (e) { failStep(e); }

    // skipGate 豁免夹具：orderC 两批（60/40 末批），零收款
    const bc1 = await batchService.createBatch({ orderId: orderC.id, plannedRatio: 60, isFinalBatch: false }, ACTOR);
    const bc2 = await batchService.createBatch({ orderId: orderC.id, plannedRatio: 40, isFinalBatch: true }, ACTOR);
    if (!bc1.ok || !bc2.ok) throw new Error('orderC 批次夹具创建失败');
    fx.batches.push(bc1.data.id, bc2.data.id);
    await batchService.markShipped(bc1.data.id, { shipmentId: shipment1.id }, ACTOR);

    begin(D1, 'S12 末批门禁再次阻断（orderC 零收款）', 'orderShipmentBatchService.markShipped（orderC 末批）', { batchId: bc2.data.id });
    try {
      const r = await batchService.markShipped(bc2.data.id, { shipmentId: shipment1.id }, ACTOR);
      assert(r.ok === false && (r as any).error?.code === 'FINAL_PAYMENT_GATE_BLOCKED', `FINAL_PAYMENT_GATE_BLOCKED（实际 ${(r as any).error?.code}）`);
      done((r as any).error, '门禁线=（5000−2000）=3000，已收 0 → 阻断');
    } catch (e) { failStep(e); }

    begin(D1, 'S13 skipGate 管理员豁免 + 审计留痕', 'orderShipmentBatchService.markShipped(skipGate=true)', { batchId: bc2.data.id });
    try {
      const r = await batchService.markShipped(bc2.data.id, { shipmentId: shipment1.id, skipGate: true }, ACTOR);
      assert(r.ok === true, `skipGate 放行（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      assert(r.data.status === 'shipped', '末批 shipped（豁免）');
      const audit = await db.auditLog.findFirst({ where: { targetId: bc2.data.id, action: 'mark_batch_shipped' }, orderBy: { createdAt: 'desc' } });
      assert(!!audit, '审计日志存在');
      assert((audit?.detail as any)?.after?.skipGate === true, `审计 after.skipGate=true 留痕（实际 ${JSON.stringify((audit?.detail as any)?.after?.skipGate)}）`);
      done({ status: r.data.status, auditId: audit?.id }, '豁免必须留痕——审计可查');
    } catch (e) { failStep(e); }

    begin(D1, 'S14 已发运批次不可取消', 'orderShipmentBatchService.updateBatch(status=cancelled)', { batchId: batch1?.id });
    try {
      const r = await batchService.updateBatch(batch1.id, { status: 'cancelled' }, ACTOR);
      assert(r.ok === false && (r as any).error?.code === 'ALREADY_SHIPPED', `ALREADY_SHIPPED（实际 ${(r as any).error?.code}）`);
      assert((r as any).error?.status === 409, 'HTTP 语义 409');
      done((r as any).error);
    } catch (e) { failStep(e); }

    // ╔════════════════════════════════════════════════════════════╗
    // ║ 域 2：催款分级（P0-2）                                      ║
    // ╚════════════════════════════════════════════════════════════╝
    const D2 = '域2 催款分级';
    // 夹具：逾期 17 天发票（d1_30 → reminder）
    const odInv1 = await db.invoice.create({
      data: {
        id: `INV__${TAG}_OD1`, invoiceNumber: `INV-WA5-${TAG}-OD1`, type: 'Receivable', status: 'Issued',
        amount: 2000, currency: 'USD', issueDate: '2026-07-20', dueDate: '2026-08-10',
        customerRelationId: relA.id, customerName: relA.name, createdAt: nowBig(), updatedAt: nowBig(),
      },
    });
    fx.invoices.push(odInv1.id);

    begin(D2, 'S01 账龄自动定级：逾期 17 天 → reminder 档催款函', 'dunningService.buildLetter', { customer: relA.name, currency: 'USD' });
    try {
      const r = await dunningService.buildLetter({ customerRelationId: relA.id, currency: 'USD', asOf: TODAY });
      assert(r.ok === true, `buildLetter ok（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      assert(r.data.stage === 'reminder', `stage=reminder（实际 ${r.data.stage}）`);
      assert(String(r.data.zh.subject).includes('【付款提醒】'), `中文提醒档模板（实际 ${r.data.zh.subject}）`);
      assert(r.data.summary.invoiceCount === 1, `逾期发票 1 张（实际 ${r.data.summary.invoiceCount}）`);
      assert(r.data.summary.totalOverdue === 2000, `逾期总额 2000（实际 ${r.data.summary.totalOverdue}）`);
      assert(String(r.data.zh.body).includes('INV-WA5-'), '函体注入账龄明细行');
      done({ stage: r.data.stage, subject: r.data.zh.subject });
    } catch (e) { failStep(e); }

    begin(D2, 'S02 人工升级钉住 reminder→urgent（留痕）', 'dunningStageService.setStageManual', { stage: 'urgent', reason: '走查：人工升级' });
    try {
      const r = await dunningStageService.setStageManual({ customerRelationId: relA.id, customerName: relA.name, currency: 'USD', stage: 'urgent', reason: '走查：人工升级严催', actorId: ACTOR });
      assert(r.ok === true, `setStageManual ok（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      fx.dunningProfiles.push(r.data.profile.scopeKey);
      assert(r.data.profile.stage === 'urgent', `stage=urgent（实际 ${r.data.profile.stage}）`);
      assert(r.data.profile.stageSource === 'manual', 'stageSource=manual');
      assert(Number(r.data.profile.escalatedAt) > 0, 'escalatedAt 升级时间戳落库');
      const audit = await db.auditLog.findFirst({ where: { targetId: r.data.profile.id, action: 'set_dunning_stage' } });
      assert(!!audit && (audit.detail as any)?.after?.reason, '升降级审计留痕（含 reason）');
      done(r.data.profile);
    } catch (e) { failStep(e); }

    begin(D2, 'S03 钉住生效：催款函按 urgent 档模板生成', 'dunningService.buildLetter（缺省 stage=钉住×账龄合成）', {});
    try {
      const r = await dunningService.buildLetter({ customerRelationId: relA.id, currency: 'USD', asOf: TODAY });
      assert(r.ok === true, 'buildLetter ok');
      assert(r.data.stage === 'urgent', `stage=urgent（实际 ${r.data.stage}）`);
      assert(String(r.data.zh.subject).includes('【严催函】'), `严催档模板（实际 ${r.data.zh.subject}）`);
      done({ stage: r.data.stage, subject: r.data.zh.subject });
    } catch (e) { failStep(e); }

    begin(D2, 'S04 非法分级值被拒', 'dunningStageService.setStageManual(stage=vip)', { stage: 'vip' });
    try {
      const r = await dunningStageService.setStageManual({ customerRelationId: relA.id, customerName: relA.name, currency: 'USD', stage: 'vip', reason: 'x', actorId: ACTOR });
      assert(r.ok === false && (r as any).error?.code === 'INVALID_STAGE', `INVALID_STAGE（实际 ${(r as any).error?.code}）`);
      done((r as any).error);
    } catch (e) { failStep(e); }

    begin(D2, 'S05 升降级缺原因被拒（留痕强制）', 'dunningStageService.setStageManual（无 reason）', { stage: 'firm' });
    try {
      const r = await dunningStageService.setStageManual({ customerRelationId: relA.id, customerName: relA.name, currency: 'USD', stage: 'firm', actorId: ACTOR });
      assert(r.ok === false && (r as any).error?.code === 'REASON_REQUIRED', `REASON_REQUIRED（实际 ${(r as any).error?.code}）`);
      done((r as any).error);
    } catch (e) { failStep(e); }

    // 夹具：逾期 109 天发票（d90plus → legal），验证穿透
    const odInv2 = await db.invoice.create({
      data: {
        id: `INV__${TAG}_OD2`, invoiceNumber: `INV-WA5-${TAG}-OD2`, type: 'Receivable', status: 'Issued',
        amount: 3000, currency: 'USD', issueDate: '2026-04-20', dueDate: '2026-05-10',
        customerRelationId: relA.id, customerName: relA.name, createdAt: nowBig(), updatedAt: nowBig(),
      },
    });
    fx.invoices.push(odInv2.id);

    begin(D2, 'S06 穿透规则：账龄烂到 90+ → 自动定级压过人工 urgent 钉住', 'dunningStageService.listBoard（只读零副作用）', {});
    try {
      const r = await dunningStageService.listBoard({ asOf: TODAY });
      assert(r.ok === true, `listBoard ok（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      const key = scopeKeyOf(relA.id, relA.name, 'USD');
      const row = r.data.rows.find((x: any) => x.scopeKey === key);
      assert(!!row, '看板行存在（relA×USD）');
      assert(row.autoStage === 'legal', `autoStage=legal（实际 ${row.autoStage}）`);
      assert(row.stage === 'legal', `生效分级=legal（实际 ${row.stage}）——aging 证据压过 urgent 钉住`);
      assert(row.stageSource === 'auto', `stageSource=auto 穿透标记（实际 ${row.stageSource}）`);
      assert(row.buckets.d1_30 === 2000 && row.buckets.d90plus === 3000, `五桶分布正确（实际 d1_30=${row.buckets.d1_30} d90plus=${row.buckets.d90plus}）`);
      done({ autoStage: row.autoStage, stage: row.stage, stageSource: row.stageSource });
    } catch (e) { failStep(e); }

    begin(D2, 'S07 人工降级留痕但生效分级仍被账龄穿透（防失真设计）', 'setStageManual(reminder) + buildLetter 合成', { stage: 'reminder', reason: '客户承诺下周付款' });
    try {
      const r = await dunningStageService.setStageManual({ customerRelationId: relA.id, customerName: relA.name, currency: 'USD', stage: 'reminder', reason: '走查：客户承诺下周付款，人工降级', actorId: ACTOR });
      assert(r.ok === true, '降级请求受理（留痕）');
      assert(r.data.profile.stage === 'reminder' && r.data.profile.stageSource === 'manual', '主档钉住 reminder/manual');
      assert(Number(r.data.profile.downgradedAt) > 0, 'downgradedAt 降级时间戳落库');
      const letter = await dunningService.buildLetter({ customerRelationId: relA.id, currency: 'USD', asOf: TODAY });
      assert(letter.ok === true, 'buildLetter ok');
      assert(letter.data.stage === 'legal', `生效分级仍=legal（实际 ${letter.data.stage}）——人工降级不能掩盖 90+ 账龄`);
      done({ pinned: 'reminder', effective: letter.data.stage }, '设计语义：非法跳级/倒退不入状态机矩阵，而是以“人工钉住+账龄穿透+全程留痕”防失真');
    } catch (e) { failStep(e); }

    begin(D2, 'S08 催款记录登记（stage 快照留痕）', 'dunningService.recordDunning', { channel: 'email', result: 'promised', stage: 'legal' });
    try {
      const r = await dunningService.recordDunning({
        customerRelationId: relA.id, customerName: relA.name, currency: 'USD',
        totalOverdue: 5000, invoiceCount: 2, agingBuckets: { current: 0, d1_30: 2000, d31_60: 0, d61_90: 0, d90plus: 3000 },
        channel: 'email', result: 'promised', stage: 'legal', note: '走查登记', operator: ACTOR,
      });
      assert(r.ok === true, `recordDunning ok（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      fx.dunningRecords.push(r.data.record.id);
      assert(r.data.record.stage === 'legal', `stage 快照=legal（实际 ${r.data.record.stage}）`);
      const list = await dunningService.listDunning({ customerRelationId: relA.id });
      assert(list.ok === true && list.data.items.length >= 1, '催款历史可查');
      assert(list.data.items[0].id === r.data.record.id, '历史倒序首条=本次登记');
      done(r.data.record);
    } catch (e) { failStep(e); }

    begin(D2, 'S09 非法催款渠道被拒', 'dunningService.recordDunning(channel=sms)', { channel: 'sms' });
    try {
      const r = await dunningService.recordDunning({ customerName: relA.name, currency: 'USD', totalOverdue: 1, channel: 'sms', result: 'sent' });
      assert(r.ok === false && (r as any).error?.code === 'INVALID_CHANNEL', `INVALID_CHANNEL（实际 ${(r as any).error?.code}）`);
      done((r as any).error);
    } catch (e) { failStep(e); }

    begin(D2, 'S10 账龄五桶→分级映射（纯函数四档）', 'stageOfBuckets', {});
    try {
      assert(stageOfBuckets({ d1_30: 1 }) === 'reminder', 'd1_30→reminder');
      assert(stageOfBuckets({ d31_60: 1 }) === 'firm', 'd31_60→firm');
      assert(stageOfBuckets({ d61_90: 1 }) === 'urgent', 'd61_90→urgent');
      assert(stageOfBuckets({ d90plus: 1 }) === 'legal', 'd90plus→legal');
      assert(stageOfBuckets({}) === 'none', '无逾期→none');
      done({ ok: true });
    } catch (e) { failStep(e); }

    // ╔════════════════════════════════════════════════════════════╗
    // ║ 域 3：客户专属面料（P1-3）                                  ║
    // ╚════════════════════════════════════════════════════════════╝
    const D3 = '域3 客户专属面料';
    const SKU = `WA5-FAB-${TAG}`;
    const ART = `WA5-ART-${TAG}`;
    const MQ = `WA5-MQ-${TAG}`;
    const CC = `WA5-CC-${TAG}`;
    const asset = await db.productAsset.create({
      data: { id: `PA_${TAG}`, sku: SKU, name: `WA5走查专属面料-${TAG}`, mainCategory: 'Fabric', subCategoryId: 'default', season: '26SS', cost: 10, status: 'active', updatedAt: nowBig() },
    });
    fx.productAssets.push(asset.id);
    const fabricProfile = await db.fabricProfile.create({
      data: { id: `FP_${TAG}`, productAssetId: asset.id, articleNo: ART, millQuality: MQ, updatedAt: nowBig() },
    });
    fx.fabricProfiles.push(fabricProfile.id);
    const fcc = await db.fabricCustomerCode.create({
      data: { id: `FCC_${TAG}`, productAssetId: asset.id, clientCode: CC, isExclusive: true, customerOrganizationId: relA.id, customerNameSnapshot: relA.name, updatedAt: nowBig() },
    });
    fx.fabricCustomerCodes.push(fcc.id);

    begin(D3, 'S01 专属规则建档（FabricCustomerCode.isExclusive，属主=客户A）', 'validateExclusiveCodes（建档校验）', { clientCode: CC, owner: relA.name });
    try {
      const bad = validateExclusiveCodes([{ isExclusive: true, clientCode: 'X-NO-OWNER' }]);
      assert(typeof bad === 'string' && bad.includes('必须绑定属主客户'), '无属主锚的专属行被拒（建档侧校验）');
      const good = validateExclusiveCodes([{ isExclusive: true, clientCode: CC, customerOrganizationId: relA.id }]);
      assert(good === null, '有属主锚放行');
      const row = await db.fabricCustomerCode.findUnique({ where: { id: fcc.id } });
      assert(row.isExclusive === true && row.customerOrganizationId === relA.id, '专属行落库（属主=客户A）');
      done({ clientCode: CC, owner: relA.name });
    } catch (e) { failStep(e); }

    begin(D3, 'S02 行级预检：非属主客户B选用专属面料 → 409 + 违规留痕', 'fabricExclusivityService.assertFabricAllowed', { customer: relB.name, clientCode: CC });
    try {
      const r = await assertFabricAllowed(prisma, {
        customer: { customerRelationId: relB.id, customerName: relB.name },
        productKeys: { clientCode: CC, clientCodeCustomerHint: relB.id },
        context: 'order-line:precheck', actorId: ACTOR, documentRef: { walkthrough: TAG },
      });
      assert(r.ok === false, '返回 ok=false（被拒）');
      assert((r as any).error?.code === 'EXCLUSIVE_FABRIC_BLOCKED', `错误码 EXCLUSIVE_FABRIC_BLOCKED（实际 ${(r as any).error?.code}）`);
      assert((r as any).error?.status === 409, 'HTTP 语义 409');
      assert(String((r as any).error?.message).includes('专属面料阻断'), '阻断文案含商业事故说明');
      const audit = await db.auditLog.findFirst({ where: { targetId: asset.id, action: 'exclusive_fabric_violation_attempt' }, orderBy: { createdAt: 'desc' } });
      assert(!!audit, '违规尝试审计留痕（即便被阻断也可审计）');
      done((r as any).error);
    } catch (e) { failStep(e); }

    begin(D3, 'S03 行级预检：属主客户A选用 → 放行', 'fabricExclusivityService.assertFabricAllowed', { customer: relA.name, clientCode: CC });
    try {
      const r = await assertFabricAllowed(prisma, {
        customer: { customerRelationId: relA.id, customerName: relA.name },
        productKeys: { clientCode: CC, clientCodeCustomerHint: relA.id },
        context: 'order-line:precheck', actorId: ACTOR,
      });
      assert(r.ok === true, `放行（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      assert((r as any).data?.checked === 1, `解析并校验 1 个产品档案（实际 ${(r as any).data?.checked}）`);
      done((r as any).data);
    } catch (e) { failStep(e); }

    begin(D3, 'S04 入口①订单行：客户B 订单创建专属面料行 → 阻断', 'orderLineMutationService.createOrderLine（真实入口）', { orderId: orderB.id, materialCode: CC });
    try {
      const r = await createOrderLine({ prisma, orderId: orderB.id, materialCode: CC, description: '走查行', quantity: 100, unit: 'M', actorId: ACTOR });
      assert(r.ok === false, '返回 ok=false（被拒）');
      assert((r as any).error?.code === 'EXCLUSIVE_FABRIC_BLOCKED', `错误码 EXCLUSIVE_FABRIC_BLOCKED（实际 ${(r as any).error?.code}）`);
      const lineCount = await db.orderLine.count({ where: { orderId: orderB.id } });
      assert(lineCount === 0, '订单行未落库（事务回滚，无脏数据）');
      done((r as any).error);
    } catch (e) { failStep(e); }

    begin(D3, 'S05 入口①订单行：属主客户A 订单创建专属面料行 → 放行', 'orderLineMutationService.createOrderLine（真实入口）', { orderId: orderA.id, materialCode: CC });
    try {
      const r = await createOrderLine({ prisma, orderId: orderA.id, materialCode: CC, description: '走查行', quantity: 100, unit: 'M', actorId: ACTOR });
      assert(r.ok === true, `放行（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      fx.orderLines.push((r as any).data.line.id);
      const line = await db.orderLine.findUnique({ where: { id: (r as any).data.line.id } });
      assert(!!line && line.materialCode === CC, '订单行落库（客供品号=专属码）');
      done({ lineId: (r as any).data.line.id });
    } catch (e) { failStep(e); }

    begin(D3, 'S06 入口②报价：客户B 报价行引用专属面料（sku 锚）→ 阻断', 'quotationService.createQuotation（真实入口）', { customer: relB.name, fabricCode: SKU });
    try {
      let thrown: any = null;
      try {
        await quotationService.createQuotation({
          currency: 'USD', customerRelationId: relB.id, customerName: relB.name, issueDate: TODAY,
          lines: [{ fabricCode: SKU, description: '走查报价行', quantity: 500, unit: 'M', unitPrice: 5 }],
        }, ACTOR);
      } catch (e: any) { thrown = e; }
      assert(!!thrown, 'createQuotation 抛错（fail-closed）');
      assert(thrown.code === 'EXCLUSIVE_FABRIC_BLOCKED', `错误码 EXCLUSIVE_FABRIC_BLOCKED（实际 ${thrown.code}）`);
      assert(thrown.statusCode === 409, `HTTP 语义 409（实际 ${thrown.statusCode}）`);
      const qCount = await db.quotation.count({ where: { customerRelationId: relB.id } });
      assert(qCount === 0, '报价单未落库（无脏数据）');
      done({ code: thrown.code, statusCode: thrown.statusCode }, 'fabricCode 语义宽泛：sku/厂号/品色号/客供品号多键并集解析');
    } catch (e) { failStep(e); }

    begin(D3, 'S07 入口②报价（边界语义）：客户B 用他司客供品号 → 范围化解析不误伤', 'assertFabricAllowed（quotation 入口调用形态：clientCodeGlobalFallback=false）', { clientCode: CC, hint: relB.id });
    try {
      const r = await assertFabricAllowed(prisma, {
        customer: { customerRelationId: relB.id, customerName: relB.name },
        productKeys: { sku: CC, articleNo: CC, millQuality: CC, clientCode: CC, clientCodeCustomerHint: relB.id, clientCodeGlobalFallback: false },
        context: 'quotation:create', actorId: ACTOR,
      });
      assert(r.ok === true, `放行（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      assert((r as any).data?.checked === 0, '范围化无命中→无产品锚不阻断（防异义碰撞误报设计）');
      done((r as any).data, '设计行为：报价入口客供品号仅认「本客户登记+无绑定通用码」，他司专属码须走 sku/品色号等全局锚才会被拦（S06 已证）');
    } catch (e) { failStep(e); }

    begin(D3, 'S08 入口③样品：客户B 面料订单登记 S/S 船样（专属面料）→ 阻断', 'fabricShipmentSampleService.registerShipmentSample（真实入口）', { orderId: orderB.id, fabricProfileId: fabricProfile.id });
    try {
      const r = await sampleService.registerShipmentSample({
        orderId: orderB.id,
        input: { fabricProfileId: fabricProfile.id, sampleQuantity: 2, sampleUnit: 'meter', cuttingDate: TODAY },
        actorId: ACTOR,
      });
      assert(r.ok === false, '返回 ok=false（被拒）');
      assert((r as any).error?.code === 'EXCLUSIVE_FABRIC_BLOCKED', `错误码 EXCLUSIVE_FABRIC_BLOCKED（实际 ${(r as any).error?.code}）`);
      assert((r as any).error?.status === 409, 'HTTP 语义 409');
      const sCount = await db.fabricShipmentSample.count({ where: { orderId: orderB.id } });
      assert(sCount === 0, '样品未落库');
      done((r as any).error, 'fabricProfileId → 产品档案直锚解析');
    } catch (e) { failStep(e); }

    begin(D3, 'S09 入口③样品：属主客户A 登记 S/S 船样 → 放行', 'fabricShipmentSampleService.registerShipmentSample（真实入口）', { orderId: orderA.id, fabricProfileId: fabricProfile.id });
    try {
      const r = await sampleService.registerShipmentSample({
        orderId: orderA.id,
        input: { fabricProfileId: fabricProfile.id, sampleQuantity: 2, sampleUnit: 'meter', cuttingDate: TODAY },
        actorId: ACTOR,
      });
      assert(r.ok === true, `放行（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      fx.samples.push(r.data.sample.id);
      assert(String(r.data.sample.sampleCode).startsWith('FSS-'), `样品业务号生成（实际 ${r.data.sample.sampleCode}）`);
      done({ sampleCode: r.data.sample.sampleCode });
    } catch (e) { failStep(e); }

    begin(D3, 'S10 入口④装箱：客户B 运单装入专属面料行 → 阻断且事务回滚', 'shipmentPackingService.replaceShipmentLinesTx（真实入口，事务内）', { shipmentId: shipmentB.id, productCode: CC });
    try {
      let thrown: any = null;
      try {
        await prisma.$transaction(async (t: any) => {
          await replaceShipmentLinesTx(t, shipmentB.id, [{ productCode: CC, productName: '走查装运行', quantity: 5, unit: 'M' }], ACTOR);
        });
      } catch (e: any) { thrown = e; }
      assert(!!thrown, '事务内抛错（fail-closed）');
      assert(thrown.code === 'EXCLUSIVE_FABRIC_BLOCKED', `错误码 EXCLUSIVE_FABRIC_BLOCKED（实际 ${thrown.code}）`);
      const lCount = await db.shipmentLine.count({ where: { shipmentId: shipmentB.id } });
      assert(lCount === 0, '装运行未落库（事务回滚）');
      done({ code: thrown.code });
    } catch (e) { failStep(e); }

    begin(D3, 'S11 入口④装箱：属主客户A 运单装入专属面料行 → 放行', 'shipmentPackingService.replaceShipmentLinesTx（真实入口，事务内）', { shipmentId: shipmentA2.id, productCode: CC });
    try {
      await prisma.$transaction(async (t: any) => {
        await replaceShipmentLinesTx(t, shipmentA2.id, [{ productCode: CC, productName: '走查装运行', quantity: 5, unit: 'M' }], ACTOR);
      });
      const lines = await db.shipmentLine.findMany({ where: { shipmentId: shipmentA2.id } });
      assert(lines.length === 1, `装运行落库 1 行（实际 ${lines.length}）`);
      fx.shipmentLines.push(...lines.map((l: any) => l.id));
      done({ lineId: lines[0].id });
    } catch (e) { failStep(e); }

    // ╔════════════════════════════════════════════════════════════╗
    // ║ 域 4：物料退换货（P1-4）                                    ║
    // ╚════════════════════════════════════════════════════════════╝
    const D4 = '域4 物料退换货';
    const MAT1 = `WA5-MAT-${TAG}-1`;
    const MAT2 = `WA5-MAT-${TAG}-2`;
    const MAT3 = `WA5-MAT-${TAG}-3`;
    const wh = await db.warehouse.create({
      data: { id: `WH_${TAG}`, code: `WA5WH${TAG}`, name: `WA5走查仓-${TAG}`, type: 'Main', createdAt: nowBig(), updatedAt: nowBig() },
    });
    fx.warehouses.push(wh.id);
    const item1 = await db.inventoryItem.create({
      data: { id: `IT_${TAG}_1`, warehouseId: wh.id, materialCode: MAT1, description: 'WA5走查物料1', category: 'Fabric', quantity: 90, unit: 'M', createdAt: nowBig(), updatedAt: nowBig() },
    });
    const item2 = await db.inventoryItem.create({
      data: { id: `IT_${TAG}_2`, warehouseId: wh.id, materialCode: MAT2, description: 'WA5走查物料2', category: 'Fabric', quantity: 2, unit: 'M', createdAt: nowBig(), updatedAt: nowBig() },
    });
    fx.inventoryItems.push(item1.id, item2.id);
    const po = await db.purchaseOrder.create({
      data: {
        id: `PO_${TAG}`, poNumber: `PO-WA5-${TAG}`, status: 'Received', supplierRelationId: relS.id, supplierName: relS.name,
        currency: 'CNY', totalAmount: 9000, orderDate: TODAY, createdAt: nowBig(), updatedAt: nowBig(),
      },
    });
    fx.purchaseOrders.push(po.id);
    const mr1 = await db.materialReceipt.create({
      data: {
        id: `MR_${TAG}_1`, receiptNumber: `MR-WA5-${TAG}-1`, purchaseOrderId: po.id, status: 'PartiallyAccepted',
        receivedDate: TODAY, warehouseId: wh.id, totalReceived: 100, totalAccepted: 90, totalRejected: 10,
        rejectionReason: '走查：色差', createdAt: nowBig(),
      },
    });
    const mr2 = await db.materialReceipt.create({
      data: {
        id: `MR_${TAG}_2`, receiptNumber: `MR-WA5-${TAG}-2`, purchaseOrderId: po.id, status: 'PartiallyAccepted',
        receivedDate: TODAY, warehouseId: wh.id, totalReceived: 20, totalAccepted: 15, totalRejected: 5,
        rejectionReason: '走查：疵点', createdAt: nowBig(),
      },
    });
    fx.receipts.push(mr1.id, mr2.id);

    let ret1: any, exc1: any, clm1: any;

    begin(D4, 'S01 发起退货（return，锚定已入库检验单）', 'materialReturnService.createReturn', { receiptId: mr1.id, type: 'return', materialCode: MAT1, quantity: 5 });
    try {
      const r = await returnService.createReturn({ receiptId: mr1.id, type: 'return', materialCode: MAT1, materialName: '走查物料1', quantity: 5, unit: 'M', amount: 450, currency: 'CNY', reason: '色差' }, ACTOR);
      assert(r.ok === true, `createReturn ok（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      ret1 = r.data.materialReturn;
      fx.materialReturns.push(ret1.id);
      assert(ret1.status === 'pending', `初始态 pending（实际 ${ret1.status}）`);
      assert(String(ret1.returnNumber).startsWith('RT-'), `业务单号 RT-YYYY-NNNN（实际 ${ret1.returnNumber}）`);
      assert(ret1.purchaseOrderId === po.id && ret1.supplierRelationId === relS.id, '采购单/供应商快照落库');
      done(ret1);
    } catch (e) { failStep(e); }

    begin(D4, 'S02 非法状态跳转：pending 直接 confirmed 被拒', 'materialReturnService.confirmReturn（pending 态）', { id: ret1?.id });
    try {
      const r = await returnService.confirmReturn(ret1.id, ACTOR);
      assert(r.ok === false && (r as any).error?.code === 'INVALID_STATUS', `INVALID_STATUS（实际 ${(r as any).error?.code}）`);
      assert((r as any).error?.status === 409, 'HTTP 语义 409');
      done((r as any).error);
    } catch (e) { failStep(e); }

    begin(D4, 'S03 退货发运：pending→shipped + 库存 Outbound 冲减', 'materialReturnService.markShipped', { id: ret1?.id });
    try {
      const before = await db.inventoryItem.findUnique({ where: { id: item1.id } });
      const r = await returnService.markShipped(ret1.id, ACTOR);
      assert(r.ok === true, `markShipped ok（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      assert(r.data.materialReturn.status === 'shipped', 'status=shipped');
      assert(r.data.skipStockReason == null, '库存联动未跳过（物料已入库）');
      const after = await db.inventoryItem.findUnique({ where: { id: item1.id } });
      assert(Number(before.quantity) - Number(after.quantity) === 5, `库存 90→85（实际 ${Number(before.quantity)}→${Number(after.quantity)}）`);
      const mv = await db.stockMovement.findFirst({ where: { referenceType: 'MaterialReturn', referenceId: ret1.id, type: 'Outbound' } });
      assert(!!mv && Number(mv.quantity) === 5, 'Outbound 流水落库（referenceType=MaterialReturn）');
      fx.stockMovements.push(mv.id);
      assert(Number(mv.balanceAfter) === Number(after.quantity), '流水 balanceAfter 与库存项一致');
      done({ status: 'shipped', stock: `${Number(before.quantity)}→${Number(after.quantity)}` });
    } catch (e) { failStep(e); }

    begin(D4, 'S04 非法状态跳转：shipped 取消被拒', 'materialReturnService.cancelReturn（shipped 态）', { id: ret1?.id });
    try {
      const r = await returnService.cancelReturn(ret1.id, ACTOR);
      assert(r.ok === false && (r as any).error?.code === 'INVALID_STATUS', `INVALID_STATUS（实际 ${(r as any).error?.code}）`);
      done((r as any).error);
    } catch (e) { failStep(e); }

    begin(D4, 'S05 供应商确认：shipped→confirmed（return 无二次库存动作）', 'materialReturnService.confirmReturn', { id: ret1?.id });
    try {
      const r = await returnService.confirmReturn(ret1.id, ACTOR);
      assert(r.ok === true, `confirmReturn ok（实际 ${JSON.stringify(safe((r as any).error ?? null))}）`);
      assert(r.data.materialReturn.status === 'confirmed', 'status=confirmed');
      const mvCount = await db.stockMovement.count({ where: { referenceType: 'MaterialReturn', referenceId: ret1.id } });
      assert(mvCount === 1, `return 仅 1 条 Outbound 流水（实际 ${mvCount}）`);
      done({ status: 'confirmed' });
    } catch (e) { failStep(e); }

    begin(D4, 'S06 结算完成：confirmed→settled；重复结算被拒', 'materialReturnService.settleReturn', { id: ret1?.id });
    try {
      const r = await returnService.settleReturn(ret1.id, ACTOR);
      assert(r.ok === true && r.data.materialReturn.status === 'settled', 'confirmed→settled');
      const again = await returnService.settleReturn(ret1.id, ACTOR);
      assert(again.ok === false && (again as any).error?.code === 'INVALID_STATUS', `重复结算 INVALID_STATUS（实际 ${(again as any).error?.code}）`);
      const auditCount = await db.auditLog.count({ where: { targetId: ret1.id } });
      assert(auditCount >= 4, `全程审计留痕 ≥4 条（实际 ${auditCount}：create/ship/confirm/settle）`);
      done({ status: 'settled', auditCount });
    } catch (e) { failStep(e); }

    begin(D4, 'S07 换货（exchange）：shipped 出库 + confirmed Inbound 对称回冲', 'createReturn → markShipped → confirmReturn', { type: 'exchange', quantity: 3 });
    try {
      const c = await returnService.createReturn({ receiptId: mr1.id, type: 'exchange', materialCode: MAT1, quantity: 3, unit: 'M', reason: '色差换新' }, ACTOR);
      assert(c.ok === true, 'exchange 登记 ok');
      exc1 = c.data.materialReturn;
      fx.materialReturns.push(exc1.id);
      const s = await returnService.markShipped(exc1.id, ACTOR);
      assert(s.ok === true, 'exchange shipped');
      let item = await db.inventoryItem.findUnique({ where: { id: item1.id } });
      assert(Number(item.quantity) === 82, `出库后库存 85-3=82（实际 ${Number(item.quantity)}）`);
      const cf = await returnService.confirmReturn(exc1.id, ACTOR);
      assert(cf.ok === true, `exchange confirmed（实际 ${JSON.stringify(safe((cf as any).error ?? null))}）`);
      item = await db.inventoryItem.findUnique({ where: { id: item1.id } });
      assert(Number(item.quantity) === 85, `Inbound 回冲后 82+3=85（实际 ${Number(item.quantity)}）——Out/In 对称`);
      const mvs = await db.stockMovement.findMany({ where: { referenceType: 'MaterialReturn', referenceId: exc1.id }, orderBy: { createdAt: 'asc' } });
      assert(mvs.length === 2 && mvs[0].type === 'Outbound' && mvs[1].type === 'Inbound', `流水对称（实际 ${mvs.map((m: any) => m.type).join('/')}）`);
      fx.stockMovements.push(...mvs.map((m: any) => m.id));
      assert(Number(mvs[0].quantity) === Number(mvs[1].quantity), '数量对称');
      done({ movements: mvs.map((m: any) => `${m.type}:${Number(m.quantity)}`) });
    } catch (e) { failStep(e); }

    begin(D4, 'S08 索赔（claim）：confirmed 生成负向 Payable 发票（不动库存）', 'createReturn(claim) → markShipped → confirmReturn', { type: 'claim', amount: 500 });
    try {
      const c = await returnService.createReturn({ receiptId: mr1.id, type: 'claim', quantity: 0, amount: 500, currency: 'CNY', reason: '色差折让' }, ACTOR);
      assert(c.ok === true, `claim 登记 ok（实际 ${JSON.stringify(safe((c as any).error ?? null))}）`);
      clm1 = c.data.materialReturn;
      fx.materialReturns.push(clm1.id);
      const stockBefore = await db.inventoryItem.findUnique({ where: { id: item1.id } });
      const s = await returnService.markShipped(clm1.id, ACTOR);
      assert(s.ok === true, 'claim shipped');
      const mvCount = await db.stockMovement.count({ where: { referenceType: 'MaterialReturn', referenceId: clm1.id } });
      assert(mvCount === 0, `claim 不产生库存流水（实际 ${mvCount}）`);
      const cf = await returnService.confirmReturn(clm1.id, ACTOR);
      assert(cf.ok === true, 'claim confirmed');
      const claimInvoiceId = cf.data.claimInvoiceId;
      assert(!!claimInvoiceId, 'claimInvoiceId 落库');
      fx.claimInvoices.push(claimInvoiceId);
      const inv = await db.invoice.findUnique({ where: { id: claimInvoiceId } });
      assert(inv.type === 'Payable' && Number(inv.amount) === -500, `负向应付发票 -500（实际 ${inv.type}/${Number(inv.amount)}）`);
      assert(String(inv.invoiceNumber).startsWith('CLM-'), `贷项单号 CLM-YYYY-NNNN（实际 ${inv.invoiceNumber}）`);
      const stockAfter = await db.inventoryItem.findUnique({ where: { id: item1.id } });
      assert(Number(stockBefore.quantity) === Number(stockAfter.quantity), '库存全程未动');
      done({ invoiceNumber: inv.invoiceNumber, amount: Number(inv.amount) });
    } catch (e) { failStep(e); }

    begin(D4, 'S09 实物额度门禁：超不合格数量被拒（QUOTA_EXCEEDED）', 'materialReturnService.createReturn', { receiptId: mr1.id, quantity: 6 });
    try {
      // mr1 totalRejected=10，已占 5(ret1)+3(exc1)=8，剩余 2
      const quota = await returnService.remainingQuota(mr1.id);
      assert(quota === 2, `剩余额度=2（实际 ${quota}）`);
      const r = await returnService.createReturn({ receiptId: mr1.id, type: 'return', materialCode: MAT1, quantity: 6, unit: 'M' }, ACTOR);
      assert(r.ok === false && (r as any).error?.code === 'QUOTA_EXCEEDED', `QUOTA_EXCEEDED（实际 ${(r as any).error?.code}）`);
      done((r as any).error);
    } catch (e) { failStep(e); }

    begin(D4, 'S10 入参校验：claim 缺金额 / return 缺物料编码 / 非法类型', 'materialReturnService.createReturn', {});
    try {
      const r1 = await returnService.createReturn({ receiptId: mr1.id, type: 'claim', quantity: 0 }, ACTOR);
      assert(r1.ok === false && (r1 as any).error?.code === 'AMOUNT_REQUIRED', `claim 缺金额 AMOUNT_REQUIRED（实际 ${(r1 as any).error?.code}）`);
      const r2 = await returnService.createReturn({ receiptId: mr1.id, type: 'return', quantity: 1 }, ACTOR);
      assert(r2.ok === false && (r2 as any).error?.code === 'MATERIAL_CODE_REQUIRED', `return 缺编码 MATERIAL_CODE_REQUIRED（实际 ${(r2 as any).error?.code}）`);
      const r3 = await returnService.createReturn({ receiptId: mr1.id, type: 'refund', quantity: 1, materialCode: MAT1 }, ACTOR);
      assert(r3.ok === false && (r3 as any).error?.code === 'INVALID_TYPE', `非法类型 INVALID_TYPE（实际 ${(r3 as any).error?.code}）`);
      done({ ok: true });
    } catch (e) { failStep(e); }

    begin(D4, 'S11 库存不足 fail-closed（不允许静默透支）', 'createReturn(qty4, mat2 库存2) → markShipped', { receiptId: mr2.id, materialCode: MAT2 });
    try {
      const c = await returnService.createReturn({ receiptId: mr2.id, type: 'return', materialCode: MAT2, quantity: 4, unit: 'M' }, ACTOR);
      assert(c.ok === true, '额度内登记 ok（mr2 rejected=5）');
      fx.materialReturns.push(c.data.materialReturn.id);
      const s = await returnService.markShipped(c.data.materialReturn.id, ACTOR);
      assert(s.ok === false && (s as any).error?.code === 'STOCK_INSUFFICIENT', `STOCK_INSUFFICIENT（实际 ${(s as any).error?.code}）`);
      assert((s as any).error?.status === 409, 'HTTP 语义 409');
      const row = await db.materialReturn.findUnique({ where: { id: c.data.materialReturn.id } });
      assert(row.status === 'pending', '失败后状态停留 pending（可重试）');
      const item = await db.inventoryItem.findUnique({ where: { id: item2.id } });
      assert(Number(item.quantity) === 2, '库存未被冲减（无部分写入）');
      // 清理该 pending 单，释放额度供 S12
      await returnService.cancelReturn(c.data.materialReturn.id, ACTOR);
      done((s as any).error);
    } catch (e) { failStep(e); }

    begin(D4, 'S12 次品未入库降级：无库存项 → 跳过联动并留痕', 'createReturn(mat3 无库存) → markShipped', { receiptId: mr2.id, materialCode: MAT3 });
    try {
      const c = await returnService.createReturn({ receiptId: mr2.id, type: 'return', materialCode: MAT3, quantity: 1, unit: 'M' }, ACTOR);
      assert(c.ok === true, '登记 ok');
      fx.materialReturns.push(c.data.materialReturn.id);
      const s = await returnService.markShipped(c.data.materialReturn.id, ACTOR);
      assert(s.ok === true, `shipped（实际 ${JSON.stringify(safe((s as any).error ?? null))}）`);
      assert(typeof s.data.skipStockReason === 'string' && s.data.skipStockReason.includes('无在库库存项'), `降级原因留痕（实际 ${s.data.skipStockReason}）`);
      const row = await db.materialReturn.findUnique({ where: { id: c.data.materialReturn.id } });
      assert(row.stockItemId === null, 'stockItemId=null（无联动锚）');
      const audit = await db.auditLog.findFirst({ where: { targetId: c.data.materialReturn.id, action: 'mark_shipped_material_return' } });
      assert((audit?.detail as any)?.after?.skipStockReason != null, '审计 detail 含 skipStockReason');
      done({ skipStockReason: s.data.skipStockReason });
    } catch (e) { failStep(e); }

    // ╔════════════════════════════════════════════════════════════╗
    // ║ 三否决项检查（四批次新功能零容忍）                          ║
    // ╚════════════════════════════════════════════════════════════╝
    const D5 = '三否决项';
    begin(D5, 'S01 四域 service 源码无占位文本/假数据标记', '源码扫描（TODO/FIXME/占位/假数据/mock/lorem）', {});
    try {
      const files = [
        'src/shipping/orderShipmentBatchService.ts',
        'src/finance/dunningService.ts',
        'src/finance/dunningStageService.ts',
        'src/finance/shipmentBatchSettlementHook.ts',
        'src/products/fabricExclusivityService.ts',
        'src/procurement/materialReturnService.ts',
      ];
      const hits: string[] = [];
      for (const f of files) {
        const text = readFileSync(path.join(SERVER_DIR, f), 'utf8');
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          if (/TODO|FIXME|占位|假数据|lorem|mock(?!ing)/i.test(line) && !/无占位|防回退|mock 测试/i.test(line)) {
            hits.push(`${f}:${i + 1} ${line.trim().slice(0, 80)}`);
          }
        });
      }
      assert(hits.length === 0, `无占位/假数据标记（命中 ${hits.length} 处）${hits.length ? '：' + hits.join(' | ') : ''}`);
      done({ scanned: files.length, hits: 0 });
    } catch (e) { failStep(e); }

    begin(D5, 'S02 全链路无跳系统手工断点（所有动作经 service 闭环落库）', '走查过程回顾', {});
    try {
      const allPass = records.every((r) => r.verdict === 'PASS');
      assert(allPass, '前述全部步骤 PASS（无函数抛异常/无字段缺失/无门禁未触发）');
      done({ steps: records.length });
    } catch (e) { failStep(e); }
  } finally {
    // ── 夹具清理（业务行全清；AuditLog 留痕保留） ──
    console.log(`\n── 夹具清理（TAG=${TAG}）──`);
    const sweeps: Array<[string, () => Promise<any>]> = [
      ['shipmentLine', () => db.shipmentLine.deleteMany({ where: { id: { in: fx.shipmentLines } } })],
      ['fabricShipmentSample', () => db.fabricShipmentSample.deleteMany({ where: { id: { in: fx.samples } } })],
      ['orderLine', () => db.orderLine.deleteMany({ where: { id: { in: fx.orderLines } } })],
      ['stockMovement', () => db.stockMovement.deleteMany({ where: { id: { in: fx.stockMovements } } })],
      ['materialReturn', () => db.materialReturn.deleteMany({ where: { id: { in: fx.materialReturns } } })],
      ['claimInvoice', () => db.invoice.deleteMany({ where: { id: { in: fx.claimInvoices } } })],
      ['invoiceAllocation', () => db.invoiceAllocation.deleteMany({ where: { id: { in: fx.allocations } } })],
      ['invoiceOrderAllocation', () => db.invoiceOrderAllocation.deleteMany({ where: { id: { in: fx.ioa } } })],
      ['invoice', () => db.invoice.deleteMany({ where: { id: { in: fx.invoices } } })],
      ['paymentVoucher', () => db.paymentVoucher.deleteMany({ where: { id: { in: fx.vouchers } } })],
      ['orderShipmentBatch', () => db.orderShipmentBatch.deleteMany({ where: { id: { in: fx.batches } } })],
      ['dunningRecord', () => db.dunningRecord.deleteMany({ where: { id: { in: fx.dunningRecords } } })],
      ['dunningProfile', () => db.dunningProfile.deleteMany({ where: { scopeKey: { in: fx.dunningProfiles } } })],
      ['materialReceipt', () => db.materialReceipt.deleteMany({ where: { id: { in: fx.receipts } } })],
      ['purchaseOrder', () => db.purchaseOrder.deleteMany({ where: { id: { in: fx.purchaseOrders } } })],
      ['inventoryItem', () => db.inventoryItem.deleteMany({ where: { id: { in: fx.inventoryItems } } })],
      ['warehouse', () => db.warehouse.deleteMany({ where: { id: { in: fx.warehouses } } })],
      ['fabricCustomerCode', () => db.fabricCustomerCode.deleteMany({ where: { id: { in: fx.fabricCustomerCodes } } })],
      ['fabricProfile', () => db.fabricProfile.deleteMany({ where: { id: { in: fx.fabricProfiles } } })],
      ['productAsset', () => db.productAsset.deleteMany({ where: { id: { in: fx.productAssets } } })],
      ['shipment', () => db.shipment.deleteMany({ where: { id: { in: fx.shipments } } })],
      ['order', () => db.order.deleteMany({ where: { id: { in: fx.orders } } })],
      ['relation', () => db.relation.deleteMany({ where: { id: { in: fx.relations } } })],
      ['entityLink(夹具引用)', () => db.entityLink.deleteMany({ where: { OR: [{ fromId: { in: fixtureIds() } }, { toId: { in: fixtureIds() } }] } })],
      ['entityReference(夹具引用)', () => db.entityReference.deleteMany({ where: { OR: [{ ownerId: { in: fixtureIds() } }, { targetId: { in: fixtureIds() } }] } })],
    ];
    for (const [label, fn] of sweeps) {
      try {
        const r = await fn();
        if (r?.count) console.log(`  清理 ${label}: ${r.count} 行`);
      } catch (e: any) {
        console.log(`  清理 ${label} 失败（不影响走查结论）: ${e?.message}`);
      }
    }
    await prisma.$disconnect();
  }

  // ── 输出走查报告 ──
  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`走查记录（${records.length} 步）`);
  console.log(`════════════════════════════════════════════════════════════════`);
  let lastDomain = '';
  for (const r of records) {
    if (r.domain !== lastDomain) {
      console.log(`\n■ ${r.domain}`);
      lastDomain = r.domain;
    }
    console.log(`  [${r.verdict}] ${r.step}`);
    console.log(`      调用: ${r.call}`);
    if (r.params && Object.keys(r.params).length) console.log(`      参数: ${JSON.stringify(r.params)}`);
    if (r.returned !== undefined) console.log(`      返回: ${JSON.stringify(r.returned)}`);
    for (const a of r.asserts) console.log(`      ${a}`);
    if (r.note) console.log(`      备注: ${r.note}`);
  }
  const failed = records.filter((r) => r.verdict === 'FAIL');
  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`汇总：${records.length} 步，PASS ${records.length - failed.length}，FAIL ${failed.length}`);
  if (failed.length) {
    console.log(`死胡同/失败清单：`);
    for (const f of failed) console.log(`  ✗ [${f.domain}] ${f.step} — ${f.note}`);
  } else {
    console.log(`死胡同清单：无`);
  }
  console.log(`════════════════════════════════════════════════════════════════`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('走查脚本自身异常中止：', e);
  process.exitCode = 2;
});
