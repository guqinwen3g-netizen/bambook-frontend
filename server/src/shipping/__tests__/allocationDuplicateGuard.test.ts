/**
 * A4 同票同行重复分配守卫；A1-b 已发运事实不得删除。
 * 当前订单履约以准确订单行为单位，新建整单分配一律拒绝。
 * 历史整单行只通过存储夹具复现，验证它不能与新行级分配混用；
 * 不再把 PostgreSQL 可空唯一键缺陷当作允许新增整单记录的依据。
 * 保留不同订单/不同行允许、重复行拒绝、删除后重建的正负对照。
 * 真库演练按本次 run 前缀清理并独立核对残留。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createAllocationService } from '../allocationService';
import { createDrillContext, withBackend } from '../../__tests__/lib/drillTouchLog';

const MARK = 'TEST_SHPDUP_';
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
/** 服务是**工厂 + 注入**（`createAllocationService(prisma)`）⇒ 传进去的就是壳的代理，它内部的写会被记到 */
const svc = createAllocationService(prisma);
/** ★ 执行者 run 唯一 ⇒ email 必须跟着走（写死会在第二轮撞 `UserAccount.email` 唯一约束） */
const ACTOR = ctx.actor;

let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.shipmentOrderAllocation.deleteMany({ where: { shipmentId: { startsWith: ctx.mark } } });
  await prisma.shipment.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.orderLine.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.order.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  /**
   * ★ 接壳当场量出来的漏表：本文件 `ensureActor()` 会建一条 `UserAccount`，
   *   而它自己的 cleanup 与 residual **两张清单里都没有这张表** ⇒ 那句"零残留"从来不含它
   *   （与 §9 **B112** 同形状，也正是壳立项时举的 `stockOwnershipDrill` 那一例）。
   *   判据按 run 唯一的 `id: ACTOR` 定向删 ⇒ 圈不到别人的账号。
   */
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
  await prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'DupGuard Test', email: `${ACTOR}@bambook.test`, passwordHash: '' },
  });
}

async function makeOrder(lines: number) {
  const order = await prisma.order.create({
    data: {
      id: ctx.id(`ORD_${n()}`), customer: 'TEST_CUST_DUP', consigneeName: 'TEST_RECIPIENT_DUP', businessLine: 'garment', product: 'P', type: 'Garment',
      quantity: 1000000, status: 'Confirmed', dueDate: '2026-12-31', quoteAmount: 10000,
      updatedAt: BigInt(Date.now()),
    },
  });
  const out = [];
  for (let i = 1; i <= lines; i++) {
    out.push(await prisma.orderLine.create({
      data: { id: ctx.id(`LINE_${n()}`), orderId: order.id, lineNumber: i, quantity: 1000000, unit: 'PCS' },
    }));
  }
  return { order, lines: out };
}

async function makeShipment(status = 'Draft') {
  return prisma.shipment.create({
    data: {
      id: ctx.id(`SHP_${n()}`), shipmentNumber: ctx.id(`NO_${n()}`),
      type: 'Export', status, shippingMethod: 'Sea',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

const create = (shipmentId: string, orderId: string, orderLineId: string | null, qty = 100) =>
  svc.createAllocation(shipmentId, { orderId, orderLineId, actualQty: qty, unit: 'PCS' }, ACTOR);

/** 独立复核：不信任自己的回滚自述 —— 按前缀实查一遍 */
async function residual() {
  const [shp, ord, line, alloc, audit, notif, acct] = await Promise.all([
    prisma.shipment.count({ where: { id: { startsWith: ctx.mark } } }),
    prisma.order.count({ where: { id: { startsWith: ctx.mark } } }),
    prisma.orderLine.count({ where: { id: { startsWith: ctx.mark } } }),
    prisma.shipmentOrderAllocation.count({ where: { shipmentId: { startsWith: ctx.mark } } }),
    prisma.auditLog.count({ where: { actorId: ACTOR } }),
    prisma.notification.count({ where: { userId: ACTOR } }),
    prisma.userAccount.count({ where: { id: ACTOR } }),
  ]);
  return { shp, ord, line, alloc, audit, notif, acct };
}

describe('★ A4 守卫：同票同订单（行）重复分配', () => {
  beforeEach(async () => { await cleanup(); await ensureActor(); });

  afterAll(async () => {
    await cleanup();
    expect(await withBackend(`Allocation 七张表 #A4`, residual)).toEqual({ shp: 0, ord: 0, line: 0, alloc: 0, audit: 0, notif: 0, acct: 0 }); // 零残留
    await prisma.$disconnect();
  });

  it('① 阳性对照：同票不同订单 → 允许（合票主路径不误伤）', async () => {
    const sh = await makeShipment();
    const a = await makeOrder(1);
    const b = await makeOrder(1);
    expect((await create(sh.id, a.order.id, a.lines[0].id)).ok).toBe(true);
    expect((await create(sh.id, b.order.id, b.lines[0].id)).ok).toBe(true);
  });

  it('② 同票同订单同行 → 拒 ALLOCATION_DUPLICATE', async () => {
    const sh = await makeShipment();
    const { order, lines } = await makeOrder(1);
    expect((await create(sh.id, order.id, lines[0].id)).ok).toBe(true);
    const dup = await create(sh.id, order.id, lines[0].id);
    expect(dup.ok).toBe(false);
    expect(dup.error!.code).toBe('ALLOCATION_DUPLICATE');
  });

  it('③ 整单新分配被拒绝，不按主单数量推算行范围', async () => {
    const sh = await makeShipment();
    const { order } = await makeOrder(1);
    const result = await create(sh.id, order.id, null);
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(await prisma.shipmentOrderAllocation.count({ where: { shipmentId: sh.id, orderId: order.id } })).toBe(0);
  });

  it('④ 已有整单分配 + 插行级 → 拒（粒度混用 = 同一批货计两次）', async () => {
    const sh = await makeShipment();
    const { order, lines } = await makeOrder(1);
    // 只读兼容的历史整单行通过存储夹具复现；新建入口不得再产生它。
    await prisma.shipmentOrderAllocation.create({ data: {
      id: ctx.id(`LEGACY_${n()}`), shipmentId: sh.id, orderId: order.id,
      orderLineId: null, actualQty: 100, unit: 'PCS', status: 'Planned',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } });
    const r = await create(sh.id, order.id, lines[0].id);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('ALLOCATION_DUPLICATE');
  });

  it('⑤ 已有行级分配也不能新建整单分配 → 拒', async () => {
    const sh = await makeShipment();
    const { order, lines } = await makeOrder(1);
    expect((await create(sh.id, order.id, lines[0].id)).ok).toBe(true);
    const r = await create(sh.id, order.id, null);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('VALIDATION_FAILED');
  });

  it('⑥ 阳性对照：同票同订单**不同行** → 允许（拆行主路径不误伤）', async () => {
    const sh = await makeShipment();
    const { order, lines } = await makeOrder(2);
    expect((await create(sh.id, order.id, lines[0].id)).ok).toBe(true);
    expect((await create(sh.id, order.id, lines[1].id)).ok).toBe(true);
  });

  it('⑦ 出口验证：删掉后重建同一准确订单行 → 允许', async () => {
    const sh = await makeShipment();
    const { order, lines } = await makeOrder(1);
    const first = await create(sh.id, order.id, lines[0].id);
    const del = await svc.deleteAllocation(sh.id, first.data!.allocation.id, ACTOR);
    expect(del.ok).toBe(true);
    expect((await create(sh.id, order.id, lines[0].id)).ok).toBe(true);
  });
});

describe('★ A1-b 守卫：已发运后不得「删」带实际出运量的分配', () => {
  beforeEach(async () => { await cleanup(); await ensureActor(); });

  afterAll(async () => {
    await cleanup();
    expect(await withBackend(`Allocation 七张表 #A1b`, residual)).toEqual({ shp: 0, ord: 0, line: 0, alloc: 0, audit: 0, notif: 0, acct: 0 }); // 零残留
  });

  it('⑧-1 阳性对照：Draft 运单删分配 → 允许', async () => {
    const sh = await makeShipment('Draft');
    const { order, lines } = await makeOrder(1);
    const a = await create(sh.id, order.id, lines[0].id, 300);
    const r = await svc.deleteAllocation(sh.id, a.data!.allocation.id, ACTOR);
    expect(r.ok).toBe(true);
  });

  it('⑧-2 Shipped 运单删「带实际出运量」的分配 → 拒 SHIPMENT_ALREADY_SHIPPED', async () => {
    const sh = await makeShipment('Draft');
    const { order, lines } = await makeOrder(1);
    const a = await create(sh.id, order.id, lines[0].id, 300);
    await prisma.shipment.update({ where: { id: sh.id }, data: { status: 'Shipped' } });

    const r = await svc.deleteAllocation(sh.id, a.data!.allocation.id, ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('SHIPMENT_ALREADY_SHIPPED');
    // 坐实行还在（没有静默删掉）
    expect(await prisma.shipmentOrderAllocation.count({ where: { shipmentId: sh.id } })).toBe(1);
  });

  it('⑧-3 Shipped 但只是 planned 行（actualQty 为空）→ 允许删（不制造死锁）', async () => {
    const sh = await makeShipment('Draft');
    const { order, lines } = await makeOrder(1);
    const a = await svc.createAllocation(sh.id, { orderId: order.id, orderLineId: lines[0].id, plannedQty: 100, unit: 'PCS' }, ACTOR);
    expect(a.ok).toBe(true);
    await prisma.shipment.update({ where: { id: sh.id }, data: { status: 'Shipped' } });

    const r = await svc.deleteAllocation(sh.id, a.data!.allocation.id, ACTOR);
    expect(r.ok).toBe(true);
  });
});
