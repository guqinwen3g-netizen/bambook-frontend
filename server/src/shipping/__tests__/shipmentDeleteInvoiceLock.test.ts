/**
 * shipmentDeleteInvoiceLock.test.ts — ★ B4 守卫：已开票运单禁止删除（2026-09-18）
 *
 * 为什么要有这个测试（零基础障碍清单 B4，🔴 阻断级）：
 *   旧 deleteShipment 只查状态（Draft/Booked/Cancelled 可删）⇒ 能删掉已开票的运单。
 *   开票锚点链：InvoiceOrderAllocation.batchId → OrderShipmentBatch.shipmentId
 *   （P0-1 分批开票把发票金额锚在批次上）—— 删运单 = 发票的数量/批次依据悬空，
 *   与订单侧 deleteOrder 的 HAS_DEPENDENTS 五路校验不对称。
 *
 * 判据（真库 + 前缀隔离 + 自回滚，含**阳性对照**）：
 *   ① 阳性对照：Draft、无批次 → 删除成功（守卫不误伤正常业务）
 *   ② Draft + 批次 + 开票分摊 → 拒绝 INVOICE_LINKED 且无副作用（deletedAt 仍为 null）
 *   ③ Draft + 批次、但无开票分摊 → 删除成功（只有批次本身不挡删除）
 *   ④ Cancelled + 开票分摊 → 同样拒绝（取消≠财务事实消失）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { deleteShipment } from '../shipmentMutationService';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';

const MARK = 'TEST_SHIPDL_';
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
/** ★ 执行者 run 唯一 ⇒ email 必须跟着走（写死会在第二轮撞 `UserAccount.email` 唯一约束） */
const ACTOR = ctx.actor;

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  const orderIds = (await prisma.order.findMany({ where: { id: { startsWith: ctx.mark } }, select: { id: true } })).map(r => r.id);
  if (orderIds.length) {
    await prisma.invoiceOrderAllocation.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } });
  }
  await prisma.orderShipmentBatch.deleteMany({ where: { orderId: { startsWith: ctx.mark } } });
  await prisma.shipmentOrderAllocation.deleteMany({ where: { shipmentId: { startsWith: ctx.mark } } });
  await prisma.shipment.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.orderLine.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.order.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  /**
   * ★ B119：先删**本次执行者自己的通知**再删账号。`Notification.userId` 是必选关系且无 cascade
   *   ⇒ 00:00 的 briefing 任务给"当时还活着的每个账号"发通知（实测单轮 84 行/账号）之后，
   *   `userAccount.deleteMany` 会被 FK 挡下 ⇒ 演练只在"跨零点的门禁跑"里红，且红在 afterAll
   *   （`Tests` 行 0 失败 ⇒ 只看那条汇总会漏报）。判据按 run 唯一的 `userId: ACTOR`，圈不到别人的收件箱。
   */
  await prisma.notification.deleteMany({ where: { userId: ACTOR } });
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
}

/** AuditLog.actorId 有 FK → 测试执行者必须是真实 UserAccount（字段按 allocationService.test.ts：displayName，无 role） */
async function ensureActor() {
  const existing = await prisma.userAccount.findUnique({ where: { id: ACTOR } });
  if (existing) return;
  await prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'ShipmentDelete Test', email: `${ACTOR}@bambook.test`, passwordHash: '' },
  });
}

let seq = 0;
async function makeOrder() {
  return prisma.order.create({
    data: {
      id: ctx.id(`ORD_${++seq}`), customer: 'SHIPDL 守卫测试客户', product: 'P', type: 'Fabric',
      quantity: 1000, status: 'Confirmed', dueDate: '2026-12-31', quoteAmount: new Prisma.Decimal('10000'),
      updatedAt: BigInt(Date.now()),
    },
  });
}

async function makeShipment(status: string) {
  return prisma.shipment.create({
    data: {
      id: ctx.id(`SHP_${++seq}`), shipmentNumber: `TEST-SHIPDL-${Date.now()}-${seq}`,
      type: 'Export', status, shippingMethod: 'Sea',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

async function makeBatch(orderId: string, shipmentId: string | null) {
  return prisma.orderShipmentBatch.create({
    data: {
      // ★ 原来写死 `OSB__TESTSHIPDL<n>`（**不含族标记**）：某轮崩溃留下它时，接壳后「清理只按本次标记删」
      //   ⇒ 下一轮 create 会永久撞主键。换成带 run 唯一标记的 id，顺带让壳也数得到它。
      id: ctx.id(`OSB_${++seq}`), orderId, shipmentId, batchNo: seq,
      currency: 'USD', status: shipmentId ? 'shipped' : 'planned',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

async function makeInvoicedAllocation(orderId: string, batchId: string) {
  const inv = await prisma.invoice.create({
    data: {
      id: ctx.id(`INV_${++seq}`), invoiceNumber: `TEST-SHIPDL-${Date.now()}-${seq}`,
      type: 'Receivable', status: 'Issued', amount: new Prisma.Decimal('500'),
      currency: 'USD', issueDate: '2026-09-18', orderId,
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
  return prisma.invoiceOrderAllocation.create({
    data: {
      id: ctx.id(`IOA_${seq}`), invoiceId: inv.id, orderId, batchId,
      allocatedAmount: new Prisma.Decimal('500'),
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

describe('★ B4 守卫：已开票运单禁止删除', () => {
  beforeAll(ensureActor);

  afterAll(async () => {
    await cleanup();
    /** ★ 本文件此前 afterAll 只有 cleanup（「清干净了」这句从未被数过）。`deleteShipment` 是**注入 prisma** 的服务 ⇒ 壳看得见它内部的写。 */
/** ★ v3.30（B151）：普查清单交给基座 ⇒ 库不可达时报第三态 NO_BACKEND，
 *   不再"抛裸 Prisma 栈"与"真有残留"共用一个读数。模型与 where 逐字搬自旧 Promise.all，
 *   顺序与条数不变；旧断言是"恰好 N 个 0"的位置字面量 ⇒ 换具名键等价且红话能点出表名。 */
const RESIDUAL_SPEC = [
  { key: 'order', model: 'order', run: () => prisma.order.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'orderline', model: 'orderLine', run: () => prisma.orderLine.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'shipment', model: 'shipment', run: () => prisma.shipment.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'shipmentorderAllocation', model: 'shipmentOrderAllocation', run: () => prisma.shipmentOrderAllocation.count({ where: { shipmentId: { startsWith: ctx.mark } } }) },
  { key: 'ordershipmentBatch', model: 'orderShipmentBatch', run: () => prisma.orderShipmentBatch.count({ where: { orderId: { startsWith: ctx.mark } } }) },
  { key: 'invoice', model: 'invoice', run: () => prisma.invoice.count({ where: { orderId: { startsWith: ctx.mark } } }) },
  { key: 'invoiceorderAllocation', model: 'invoiceOrderAllocation', run: () => prisma.invoiceOrderAllocation.count({ where: { orderId: { startsWith: ctx.mark } } }) },
  { key: 'auditlog', model: 'auditLog', run: () => prisma.auditLog.count({ where: { actorId: ACTOR } }) },
  { key: 'notification', model: 'notification', run: () => prisma.notification.count({ where: { userId: ACTOR } }) },
  { key: 'useraccount', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
];
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ order: 0, orderline: 0, shipment: 0, shipmentorderAllocation: 0, ordershipmentBatch: 0, invoice: 0, invoiceorderAllocation: 0, auditlog: 0, notification: 0, useraccount: 0 });
    await prisma.$disconnect();
  });

  it('① 阳性对照：Draft、无批次 → 删除成功', async () => {
    const sh = await makeShipment('Draft');
    const r = await deleteShipment({ prisma, shipmentId: sh.id, actorId: ACTOR });
    expect(r.ok).toBe(true);
    const after = await prisma.shipment.findUnique({ where: { id: sh.id } });
    expect(after!.deletedAt).not.toBeNull();
  });

  it('② Draft + 批次 + 开票分摊 → 拒绝 INVOICE_LINKED 且无副作用', async () => {
    const order = await makeOrder();
    const sh = await makeShipment('Draft');
    const batch = await makeBatch(order.id, sh.id);
    await makeInvoicedAllocation(order.id, batch.id);

    const r = await deleteShipment({ prisma, shipmentId: sh.id, actorId: ACTOR });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('INVOICE_LINKED');
    expect(r.error!.message).toContain('开票分摊');

    // 无副作用：运单没被删
    const after = await prisma.shipment.findUnique({ where: { id: sh.id } });
    expect(after!.deletedAt).toBeNull();
  });

  it('③ Draft + 批次、但无开票分摊 → 删除成功（批次本身不挡删除）', async () => {
    const order = await makeOrder();
    const sh = await makeShipment('Draft');
    await makeBatch(order.id, sh.id);

    const r = await deleteShipment({ prisma, shipmentId: sh.id, actorId: ACTOR });
    expect(r.ok).toBe(true);
  });

  it('④ Cancelled + 开票分摊 → 同样拒绝（取消≠财务事实消失）', async () => {
    const order = await makeOrder();
    const sh = await makeShipment('Cancelled');
    const batch = await makeBatch(order.id, sh.id);
    await makeInvoicedAllocation(order.id, batch.id);

    const r = await deleteShipment({ prisma, shipmentId: sh.id, actorId: ACTOR });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('INVOICE_LINKED');
  });
});
