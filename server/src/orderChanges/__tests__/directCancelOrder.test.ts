/**
 * directCancelOrder.test.ts — ★ B1 守卫：Pending 订单可直接取消（业务员路径，含留痕与依赖拦截）
 *
 * 为什么要有这个测试（零基础障碍清单 B1，🔴 阻断级）：
 *   「客户刚下单、还没投产就取消」是面料外贸最常见的取消场景，此前三条路全堵
 *   （DR-010 链拒 Pending / 6 态状态机无 Cancelled / DELETE 是高危角色门），
 *   accept脚本 S2/S3/S4 实测。设计真源 订单变更规则.md §2A.1 明确要求
 *   「草稿/待审批：取消/暂停业务员可直接取消/暂停」。
 *
 * 判据（真库 + 前缀隔离 + 自回滚，含**阳性对照**）：
 *   ① 阳性对照：Pending 无依赖 → 取消成功：status=Cancelled + 时间线 note=理由 + audit 留痕
 *   ② Confirmed → 拒绝 ORDER_NOT_PENDING（提示走 DR-010 取消审批链）
 *   ③ Alert → 拒绝（Alert 须先恢复 Pending，直接取消不留异常处置痕迹）
 *   ④ 挂发票的 Pending → 拒绝 ORDER_HAS_DEPENDENTS 且无副作用（状态仍 Pending）
 *   ⑤ 挂采购单的 Pending → 拒绝 ORDER_HAS_DEPENDENTS
 *   ⑥ 理由空白 → REASON_REQUIRED；不存在/已删 → 404/409
 *   ⑦⑧ ★ v2.49 复核 I-3 补的两路（这条守卫与 deleteOrder 是同一件事的两次手写，之前少两路）：
 *      挂**已出运批次**的 Pending → 拒绝；只挂 **planned 批次**的 Pending → **仍可取消**
 *      （口径与 deleteOrder 一致：已发生事实才算依赖，计划行不算。取消要不要级联 planned 批次属业务判断，挂给 Kevin）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { directCancelPendingOrder } from '../orderChangeRequestService';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';

const MARK = 'TEST_DCNL_';
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
/** ★ 执行者 run 唯一 ⇒ `ensureActor()` 的 email 必须跟着走，否则第二轮撞 `UserAccount.email` 唯一约束 */
const ACTOR = ctx.actor;

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  const orderIds = (await prisma.order.findMany({ where: { id: { startsWith: ctx.mark } }, select: { id: true } })).map(r => r.id);
  if (orderIds.length) {
    await prisma.orderStatusTransition.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.invoice.updateMany({ where: { orderId: { in: orderIds } }, data: { deletedAt: BigInt(Date.now()) } });
    await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { orderId: { in: orderIds } } });
    // ★ 本文件自己新写的批次行必须自己清干净（共享库 = 本机业务库，见 B35 的教训）
    await prisma.orderShipmentBatch.deleteMany({ where: { orderId: { in: orderIds } } });
    // ★ 复核 I-5 补的用例⑨会写 Shipment 行 ⇒ 同样自己清，不给 B35 那笔残留债添新行
    await prisma.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
  }
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

async function ensureActor() {
  const existing = await prisma.userAccount.findUnique({ where: { id: ACTOR } });
  if (existing) return;
  // 字段按 allocationService.test.ts 的既有写法（UserAccount 用 displayName，无 role 字段）
  await prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'DirectCancel Test', email: `${ACTOR}@bambook.test`, passwordHash: '' },
  });
}

let seq = 0;
async function makeOrder(status: string) {
  return prisma.order.create({
    data: {
      id: ctx.id(`ORD_${++seq}`), customer: 'DCNL 守卫测试客户', product: 'P', type: 'Fabric',
      quantity: 500, status, dueDate: '2026-12-31', quoteAmount: new Prisma.Decimal('8000'),
      updatedAt: BigInt(Date.now()),
    },
  });
}

describe('★ B1 守卫：Pending 订单可直接取消（业务员路径）', () => {
  beforeAll(async () => {
    await cleanup();
    await ensureActor();
  });

  afterAll(async () => {
    await cleanup();
    /**
     * ★ 本文件此前 afterAll **一句残留断言都没有**（cleanup 写完就 disconnect）⇒
     *   "这张表清没清"完全靠人自觉，而 cleanup 自己删 7 张表就是 7 次机会漏一张。
     *   下面这组 count 按**本次 run 的行标记**数（`orderId` 那几张能直接按标记数，不必再靠 orderIds 反查）。
     */
/** ★ v3.30（B151）：普查清单交给基座 ⇒ 库不可达时报第三态 NO_BACKEND，
 *   不再"抛裸 Prisma 栈"与"真有残留"共用一个读数。模型与 where 逐字搬自旧 Promise.all，
 *   顺序与条数不变；旧断言是"恰好 N 个 0"的位置字面量 ⇒ 换具名键等价且红话能点出表名。 */
const RESIDUAL_SPEC = [
  // ⚠️ 这两张**按自己的 id 标记**数，不按 `orderId in (本次的 order id)`：
  //   order 行已被上面删掉 ⇒ 那个 `in` 会是空数组 ⇒ 计数**恒为 0**（假绿，B116 同型）。
  { key: 'order', model: 'order', run: () => prisma.order.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'orderline', model: 'orderLine', run: () => prisma.orderLine.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'orderstatusTransition', model: 'orderStatusTransition', run: () => prisma.orderStatusTransition.count({ where: { orderId: { startsWith: ctx.mark } } }) },
  { key: 'ordershipmentBatch', model: 'orderShipmentBatch', run: () => prisma.orderShipmentBatch.count({ where: { orderId: { startsWith: ctx.mark } } }) },
  { key: 'shipment', model: 'shipment', run: () => prisma.shipment.count({ where: { orderId: { startsWith: ctx.mark } } }) },
  { key: 'invoice', model: 'invoice', run: () => prisma.invoice.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'purchaseorder', model: 'purchaseOrder', run: () => prisma.purchaseOrder.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'auditlog', model: 'auditLog', run: () => prisma.auditLog.count({ where: { actorId: ACTOR } }) },
  { key: 'notification', model: 'notification', run: () => prisma.notification.count({ where: { userId: ACTOR } }) },
  { key: 'useraccount', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
];
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ order: 0, orderline: 0, orderstatusTransition: 0, ordershipmentBatch: 0, shipment: 0, invoice: 0, purchaseorder: 0, auditlog: 0, notification: 0, useraccount: 0 });
    await prisma.$disconnect();
  });

  it('① 阳性对照：Pending 无依赖 → 取消成功（Cancelled + 时间线留痕理由 + audit）', async () => {
    const order = await makeOrder('Pending');
    const r = await directCancelPendingOrder(prisma, order.id, '客户改单，重下', ACTOR);
    expect(r.ok).toBe(true);

    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after!.status).toBe('Cancelled');

    // 留痕一：状态时间线（详情页可见，note = 取消理由）
    const timeline = await prisma.orderStatusTransition.findMany({ where: { orderId: order.id } });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].fromStatus).toBe('Pending');
    expect(timeline[0].toStatus).toBe('Cancelled');
    expect(timeline[0].note).toBe('客户改单，重下');
    expect(timeline[0].operator).toBe(ACTOR);

    // 留痕二：审计日志
    const audits = await prisma.auditLog.findMany({ where: { actorId: ACTOR, targetType: 'Order', targetId: order.id } });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits.some(a => a.action === 'cancel_order_direct')).toBe(true);
  });

  it('② Confirmed → 拒绝 ORDER_NOT_PENDING（提示走 DR-010 取消审批链）', async () => {
    const order = await makeOrder('Confirmed');
    const r = await directCancelPendingOrder(prisma, order.id, '试试', ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('ORDER_NOT_PENDING');
    expect(r.error!.message).toContain('DR-010');
    // 无副作用
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe('Confirmed');
  });

  it('③ Alert → 拒绝（须先恢复 Pending）', async () => {
    const order = await makeOrder('Alert');
    const r = await directCancelPendingOrder(prisma, order.id, '试试', ACTOR);
    expect(r.error!.code).toBe('ORDER_NOT_PENDING');
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe('Alert');
  });

  it('④ 挂发票的 Pending → 拒绝 ORDER_HAS_DEPENDENTS 且无副作用', async () => {
    const order = await makeOrder('Pending');
    await prisma.invoice.create({
      data: {
        id: ctx.id('INV_1'), invoiceNumber: `TEST-DCNL-${Date.now()}`,
        type: 'Receivable', status: 'Issued', amount: new Prisma.Decimal('100'),
        currency: 'USD', issueDate: '2026-09-18', orderId: order.id,
        createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      },
    });
    const r = await directCancelPendingOrder(prisma, order.id, '试试', ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('ORDER_HAS_DEPENDENTS');
    expect(r.error!.message).toContain('发票');
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe('Pending');
    expect(await prisma.orderStatusTransition.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('⑤ 挂采购单的 Pending → 拒绝 ORDER_HAS_DEPENDENTS（含草稿采购单）', async () => {
    const order = await makeOrder('Pending');
    await prisma.purchaseOrder.create({
      data: {
        id: ctx.id('PO_1'), poNumber: `TEST-DCNL-PO-${Date.now()}`, status: 'Draft',
        currency: 'CNY', totalAmount: new Prisma.Decimal('500'), orderId: order.id,
        orderDate: '2026-09-18',
        createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      },
    });
    const r = await directCancelPendingOrder(prisma, order.id, '试试', ACTOR);
    expect(r.error!.code).toBe('ORDER_HAS_DEPENDENTS');
    expect(r.error!.message).toContain('采购单');
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe('Pending');
  });

  /** ★ 复核 I-3：这条路径从前**完全没有批次这一路**，也没有 `shipment.count`。 */
  it('⑦ 挂 1 行**已出运**批次的 Pending → 拒绝 ORDER_HAS_DEPENDENTS（且不留状态变化）', async () => {
    const order = await makeOrder('Pending');
    await prisma.orderShipmentBatch.create({
      data: {
        id: ctx.id('OSB_S1'), orderId: order.id, batchNo: 1, currency: 'USD',
        status: 'shipped', shippedAt: BigInt(Date.now()),
        createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      },
    });
    const r = await directCancelPendingOrder(prisma, order.id, '试试', ACTOR);
    expect(r.ok, '挂着已出运批次的单被直接取消了 ⇒ 它还会被开票与催款继续读').toBe(false);
    expect(r.error!.code).toBe('ORDER_HAS_DEPENDENTS');
    expect(r.error!.message).toContain('已出运/已取消批次');
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe('Pending');
  });

  it('⑧ 只挂 1 行 planned 批次的 Pending → 仍可取消（守卫不许把最常见的取消场景锁死）', async () => {
    const order = await makeOrder('Pending');
    await prisma.orderShipmentBatch.create({
      data: { id: ctx.id('OSB_P1'), orderId: order.id, batchNo: 1, currency: 'USD', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) },
    });
    const r = await directCancelPendingOrder(prisma, order.id, '客户改单，重下', ACTOR);
    expect(r.ok, 'planned 批次不是已发生事实 ⇒ 拦下来就是把 B1 那条主路径又堵回去').toBe(true);
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe('Cancelled');
  });

  /**
   * ⑨ ★ v2.50 复核 I-5：上一批"补齐两路"里 **shipment.count 那一路一条用例都没有**（只有批次那一路有 ⑦⑧）
   *   ⇒ 手写清单的覆盖声称再次大于实际被钉住的形状。这一条补上：挂 1 张活运单的 Pending 必须被拒。
   *   为什么必须单独一条：`shipmentOrderAllocation` 那条既有路只认**分摊表**，单票直连（`Shipment.orderId`）
   *   在只有 shipment 路时才会被看见 ⇒ 删掉那一路，本文件其余 8 条全绿（= 判据恒真的那种洞）。
   */
  it('⑨ 挂 1 张活运单（只有 Shipment.orderId，没有分摊行）的 Pending → 拒绝 ORDER_HAS_DEPENDENTS', async () => {
    const order = await makeOrder('Pending');
    const n = `${Date.now()}_${seq}`;
    await prisma.shipment.create({
      data: {
        id: ctx.id(`SHP_${n}`), shipmentNumber: ctx.id(`SHPNO_${n}`),
        orderId: order.id, type: 'Export', status: 'Shipped', shippingMethod: 'Sea',
        createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      },
    });
    const r = await directCancelPendingOrder(prisma, order.id, '试试运单路', ACTOR);
    expect(r.ok, '挂着活运单的单被直接取消了 ⇒  shipment 那一路等于没接').toBe(false);
    expect(r.error!.code).toBe('ORDER_HAS_DEPENDENTS');
    expect(r.error!.message).toContain('出运单');
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe('Pending');
  });

  it('⑥ 理由空白 → REASON_REQUIRED；不存在 → 404；已删 → 409', async () => {
    const order = await makeOrder('Pending');
    const noReason = await directCancelPendingOrder(prisma, order.id, '   ', ACTOR);
    expect(noReason.error!.code).toBe('REASON_REQUIRED');
    expect((await directCancelPendingOrder(prisma, 'ORDER_MISSING_XYZ', '试试', ACTOR)).error!.code).toBe('ORDER_NOT_FOUND');

    await prisma.order.update({ where: { id: order.id }, data: { deletedAt: BigInt(Date.now()) } });
    expect((await directCancelPendingOrder(prisma, order.id, '试试', ACTOR)).error!.code).toBe('ORDER_ALREADY_DELETED');
  });
});
