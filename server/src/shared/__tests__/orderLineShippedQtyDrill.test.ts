/**
 * orderLineShippedQtyDrill.test.ts — ★ C3 真库守卫：溢短装条款面板必须真的活着
 *
 * 为什么要有这个测试（零基础障碍清单 C3，实测比清单描述更严重）：
 *   `OrderLine.shipmentQuantity`（订单详情「溢短装条款」面板的唯一数据源）
 *   **只被 internalTrade 写过，出运模块从不写它** ⇒ 面板永远显示「未发货」，
 *   短装/溢装判定从不触发 —— 一块**永远绿的假面板**（比没有更糟：让人以为条款校验过了）。
 *
 * 判据（真库 + 真服务 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ★ 2026-09-29：容差改走**标准链**（① 行级覆盖 → ② 客户标准 P0 → ③ 内部标准辅助 → ④ 未判定）。
 *     本演练统一用**① 行级覆盖**（行上带 `toleranceSource='line_override'`）。
 *   ① 建票分配 6000/10000（行级覆盖 5%，下限 9500）→ 行快照 = 6000，容差面板 = **短装超限**
 *   ② 补到 10000 → 快照 = 10000，面板 = **限额内**
 *   ③ 阳性对照：分配到 10600（+6% > 5%）→ **出运上限校验拒绝**（ORDER_LINE_OVER_ALLOCATED）
 *      ⇒ 说明「出运侧硬上限」与「容差面板」是同一批数、两个视角
 *   ④ 改量 10000→7000 → 快照跟上（update 路径）
 *   ⑤ 删分配 → 快照回落（delete 路径）
 *   ⑥ 整单分配（orderLineId=null）9000 → 两行按行量比例 6000 / 3000
 *   ⑦ 取消运单 → 该票不再计入 ⇒ 快照归 0，面板回到「未发货」
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';
import { PrismaClient } from '@prisma/client';
import { createAllocationService } from '../../shipping/allocationService';
import { updateShipment } from '../../shipping/shipmentMutationService';
import { getOrderToleranceStatus } from '../../orders/toleranceService';

const MARK = 'TEST_C3QTY_';
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
/**
 * ★ B35 第三刀采纳点 9/12（v2.86）：客户端由**触碰记录壳**给 ⇒ 该数哪几张表由运行时写过的模型决定。
 *   这个文件原来 `cleanup()` 删 7 张表而 `residual()` 只数 5 张 ⇒ `shipmentEvent` / `orderStatusTransition`
 *   属于“只删不数”（B94 形状），本批一并并入零残留等式。id 仍在 TEST_C3QTY_ 族内 ⇒ 认领口径不换。
 */
const svc = createAllocationService(prisma);

const ACTOR = ctx.actor;

let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function ensureActor() {
  const existing = await prisma.userAccount.findUnique({ where: { id: ACTOR } });
  if (existing) return;
  await prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'C3 Qty Test', email: `${ACTOR}@bambook.test`, passwordHash: '' },
  });
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.shipmentOrderAllocation.deleteMany({ where: { shipmentId: { startsWith: ctx.mark } } });
  await prisma.shipmentEvent.deleteMany({ where: { shipmentId: { startsWith: ctx.mark } } });
  await prisma.shipment.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.orderStatusTransition.deleteMany({ where: { orderId: { startsWith: ctx.mark } } });
  await prisma.orderLine.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.order.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
  /**
   * ★ B103 在**第二个家族**上重现：`createAllocationService` 在 `$transaction` 里写 `EntityLink` / `EntityReference`
   *   ⇒ 自 v2.81（壳记得到事务内的写）之后，本演练的零残留判据当场把这两张表报脏。
   *   定向判据同 v2.80：任一引用列带**本次 run** 标记（两表 id 由服务生成 ⇒ startsWith 族前缀够不到）。
   */
  const has = { contains: ctx.mark };
  const from = { startsWith: ctx.mark };
  await prisma.entityLink.deleteMany({ where: { OR: [{ id: has }, { fromId: from }, { toId: from }] } });
  await prisma.entityReference.deleteMany({ where: { OR: [{ id: has }, { ownerId: from }, { targetId: from }] } });
}

/** ★ B151/v3.28：残留普查交给基座 `safeResidualCounts` ⇒ "没有读数"不再冒充"清干净"。
 *   ⚠️ v3.29 复核 E 项更正本注释（原来写"库不可达时报第三态 NO_BACKEND"是**说满了**）：
 *   真断库时先炸的是上一行 `cleanup()`——整条清理链仍在第三态之外（§12.1 第 27 条，不自采），
 *   所以本文件在断库时通常红在它身上；第三态本身由判据 ⑤⑨ 用真客户端证（那里没有 cleanup 挡前面）。
 *   键与 where 逐字搬自旧 `residual()`，一条未改。 */
const RESIDUAL_SPEC = [
  { key: 'shp', model: 'shipment', run: () => prisma.shipment.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'ord', model: 'order', run: () => prisma.order.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'line', model: 'orderLine', run: () => prisma.orderLine.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'alloc', model: 'shipmentOrderAllocation', run: () => prisma.shipmentOrderAllocation.count({ where: { shipmentId: { startsWith: ctx.mark } } }) },
  { key: 'audit', model: 'auditLog', run: () => prisma.auditLog.count({ where: { actorId: ACTOR } }) },
  { key: 'evt', model: 'shipmentEvent', run: () => prisma.shipmentEvent.count({ where: { shipmentId: { startsWith: ctx.mark } } }) },
  { key: 'trans', model: 'orderStatusTransition', run: () => prisma.orderStatusTransition.count({ where: { orderId: { startsWith: ctx.mark } } }) },
  { key: 'ua', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
];

async function makeOrder(lineQtys: Array<{ qty: number; tol?: number }>) {
  const order = await prisma.order.create({
    data: {
      id: ctx.id(`ORD_${n()}`), poNumber: ctx.id(`PO_${n()}`), customer: 'C3 测试客户',
      product: 'Fabric', type: 'Fabric', quantity: 1000000, status: 'Confirmed',
      dueDate: '2026-12-31', quoteAmount: 100000, updatedAt: BigInt(Date.now()),
    },
  });
  const lines = [];
  for (let i = 0; i < lineQtys.length; i++) {
    lines.push(await prisma.orderLine.create({
      data: {
        id: ctx.id(`LINE_${n()}`), orderId: order.id, lineNumber: i + 1,
        quantity: lineQtys[i].qty, unit: 'M',
        // ★ 2026-09-29：容差改走标准链后，**行上的数只有带 `toleranceSource='line_override'`
        //   才算「人定的」**（白名单）⇒ 本演练统一用**行级覆盖**这条路。
        //   （「内部标准」那条路在 `allocationService.test.ts` 里用真 SystemConfig 覆盖；
        //    本演练有零残留判据，不往共享的 systemConfig 表写东西。）
        tolerancePercent: lineQtys[i].tol ?? 5,
        toleranceSource: 'line_override',
      },
    }));
  }
  return { order, lines };
}

async function makeShipment() {
  return prisma.shipment.create({
    data: {
      id: ctx.id(`SHP_${n()}`), shipmentNumber: ctx.id(`NO_${n()}`),
      type: 'Export', status: 'Booked', shippingMethod: 'Sea',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

const lineQtyOf = async (lineId: string) =>
  Number((await prisma.orderLine.findUnique({ where: { id: lineId }, select: { shipmentQuantity: true } }))!.shipmentQuantity ?? 0);

const verdictOf = async (orderId: string, lineId: string) => {
  const st = await getOrderToleranceStatus(prisma, orderId);
  const row = st!.lines.find(l => l.orderLineId === lineId)!;
  // ★ 2026-09-29：`check` 现在**可能是 null**（未发货 / 未判定）——
  //   修前未发货会被伪造成一个 `verdict:'ok'` 的假结论，现在老实返回 null。
  return {
    verdict: row.check?.verdict ?? null,
    shippedQty: row.shippedQty,
    allowedMin: row.check?.allowedMin ?? null,
    allowedMax: row.check?.allowedMax ?? null,
  };
};

const create = (shipmentId: string, orderId: string, orderLineId: string | null, qty: number) =>
  svc.createAllocation(shipmentId, { orderId, orderLineId, actualQty: qty, unit: 'M' }, ACTOR);

describe('★ C3 真库守卫：出运事实 → 订单行已出运量（溢短装面板活起来）', () => {
  beforeEach(async () => { await cleanup(); await ensureActor(); });

  afterAll(async () => {
    await cleanup();
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ shp: 0, ord: 0, line: 0, alloc: 0, audit: 0, evt: 0, trans: 0, ua: 0 }); // 零残留（含原来“只删不数”的两张）
    const touched = ctx.touchedModels();
    expect(touched, '订单行是本演练的主对象 ⇒ OrderLine 必须在触碰集合里').toContain('OrderLine');
    await prisma.$disconnect();
  });

  it('① 分配 6000/10000（容差 5%）→ 行快照 = 6000 且面板判「短装超限」', async () => {
    const { order, lines } = await makeOrder([{ qty: 10000 }]);
    const sh = await makeShipment();
    expect((await create(sh.id, order.id, lines[0].id, 6000)).ok).toBe(true);

    expect(await lineQtyOf(lines[0].id)).toBe(6000);
    const v = await verdictOf(order.id, lines[0].id);
    expect(v.shippedQty).toBe(6000);
    expect(v.allowedMin).toBe(9500);
    expect(v.verdict).toBe('under_limit'); // ★ 改造前这里恒为「未发货」
  });

  it('② 补到 10000 → 面板「限额内」（条款判定真的会随出运变化）', async () => {
    const { order, lines } = await makeOrder([{ qty: 10000 }]);
    const sh = await makeShipment();
    const a = await create(sh.id, order.id, lines[0].id, 6000);
    await svc.updateAllocation(sh.id, a.data!.allocation.id, { actualQty: 10000 }, ACTOR);

    expect(await lineQtyOf(lines[0].id)).toBe(10000);
    expect((await verdictOf(order.id, lines[0].id)).verdict).toBe('ok');
  });

  it('③ 阳性对照：10600（+6% > 5%）被**出运上限校验**拒绝（说明两侧看的是同一批数）', async () => {
    const { order, lines } = await makeOrder([{ qty: 10000 }]);
    const sh = await makeShipment();
    const r = await create(sh.id, order.id, lines[0].id, 10600);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('ORDER_LINE_OVER_ALLOCATED');
    expect(await lineQtyOf(lines[0].id)).toBe(0); // 拒绝后无副作用
  });

  it('④ 改量 10000→7000 → 快照跟上（update 路径）', async () => {
    const { order, lines } = await makeOrder([{ qty: 10000 }]);
    const sh = await makeShipment();
    const a = await create(sh.id, order.id, lines[0].id, 10000);
    expect(await lineQtyOf(lines[0].id)).toBe(10000);

    await svc.updateAllocation(sh.id, a.data!.allocation.id, { actualQty: 7000 }, ACTOR);
    expect(await lineQtyOf(lines[0].id)).toBe(7000);
    expect((await verdictOf(order.id, lines[0].id)).verdict).toBe('under_limit');
  });

  it('⑤ 删分配 → 快照回落（delete 路径）', async () => {
    const { order, lines } = await makeOrder([{ qty: 10000 }]);
    const sh = await makeShipment();
    const a = await create(sh.id, order.id, lines[0].id, 10000);
    await svc.deleteAllocation(sh.id, a.data!.allocation.id, ACTOR);
    expect(await lineQtyOf(lines[0].id)).toBe(0);
  });

  it('⑥ 整单分配 9000（两行 10000/5000）→ 按行量比例 6000 / 3000', async () => {
    const { order, lines } = await makeOrder([{ qty: 10000 }, { qty: 5000 }]);
    const sh = await makeShipment();
    expect((await create(sh.id, order.id, null, 9000)).ok).toBe(true);

    expect(await lineQtyOf(lines[0].id)).toBe(6000);
    expect(await lineQtyOf(lines[1].id)).toBe(3000);
  });

  it('⑦ 取消运单 → 该票不再计入 ⇒ 快照归 0、面板回「未发货」', async () => {
    const { order, lines } = await makeOrder([{ qty: 10000 }]);
    const sh = await makeShipment();
    await create(sh.id, order.id, lines[0].id, 10000);
    expect(await lineQtyOf(lines[0].id)).toBe(10000);

    const r = await updateShipment({ prisma: prisma as any, shipmentId: sh.id, patch: { status: 'Cancelled' }, hasStatus: true, actorId: ACTOR });
    expect(r.ok).toBe(true);
    expect(await lineQtyOf(lines[0].id)).toBe(0);
    const v = await verdictOf(order.id, lines[0].id);
    expect(v.shippedQty).toBe(0);
    // ★ 2026-09-29：未发货**不判**（check=null）—— 修前会伪造一个 verdict:'ok'
    expect(v.verdict, '★ 未发货不是「合格」，是「还没判」').toBeNull();
  });
});
