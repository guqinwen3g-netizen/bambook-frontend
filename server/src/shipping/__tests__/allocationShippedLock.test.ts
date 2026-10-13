/**
 * allocationShippedLock.test.ts — ★ A1 守卫：已发运后禁止改实际出运量（2026-09-18）
 *
 * 为什么要有这个测试：
 *   旧 `updateAllocation` **只校跨票累计上限**，既不回冲库存、也不联动已开票额
 *   ⇒ 货发走之后改一个数字，库存/开票/批次结算三处**静默不同步**（不报错，最高危）。
 *   与「订单金额口径分裂」同一类病：**改一处、其余不动**。
 *
 * 判据（含**阳性对照** —— 否则「守卫没跑」与「守卫跑对了」都是绿，无法区分）：
 *   ① Draft 运单改 actualQty → **通过**（证明守卫不误伤正常业务）
 *   ② Shipped 运单改 actualQty → **拒绝 SHIPMENT_ALREADY_SHIPPED**
 *   ③ Shipped 运单只改状态（不动数量）→ **通过**（只锁数量，不锁状态流转）
 *   ④ Shipped 运单改 unit（数量语义会变）→ **拒绝**
 *
 * 真库 + 前缀隔离（沿用 allocationService.test.ts 的范式）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createAllocationService } from '../allocationService';

const prisma = new PrismaClient();
const svc = createAllocationService(prisma);

const MARK = 'TEST_SHPLOCK_';
const ACTOR = 'TEST_ACTOR_SHPLOCK';

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.shipmentOrderAllocation.deleteMany({ where: { id: { startsWith: 'SHPA__' } } });
  await prisma.shipmentOrderAllocation.deleteMany({ where: { shipmentId: { startsWith: MARK } } });
  await prisma.shipment.deleteMany({ where: { id: { startsWith: MARK } } });
  await prisma.orderLine.deleteMany({ where: { id: { startsWith: MARK } } });
  await prisma.order.deleteMany({ where: { id: { startsWith: MARK } } });
  /**
   * ★ B119（v2.99 现场红实测）：必须先删**本演练执行者自己的通知**再删账号。
   *   `Notification.userId` 是必选关系且无 cascade ⇒ 00:00 的 briefing 任务给"当时还活着的每个账号"
   *   发了通知（实测单轮 84 行/账号）之后，`userAccount.deleteMany` 会被 FK 挡下，
   *   本文件从那一刻起**每一轮都红在 afterAll**（`Tests` 行 0 失败 ⇒ 只看那条汇总会漏报）。
   *   判据与本文件既有那条 `auditLog.deleteMany({ actorId: ACTOR })` **同形同范围**：
   *   只清"我这个身份收到的东西"，不碰任何服务生成的业务命名空间 ⇒ 不属于 §12.1 第 27 条那三处待批的收窄。
   */
  await prisma.notification.deleteMany({ where: { userId: ACTOR } });
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
}

async function ensureActor() {
  const existing = await prisma.userAccount.findUnique({ where: { id: ACTOR } });
  if (existing) return;
  // 字段按 allocationService.test.ts 的既有写法（UserAccount 用 displayName，无 role 字段）
  await prisma.userAccount.create({
    data: {
      id: ACTOR,
      displayName: 'ShippedLock Test',
      email: 'test-shplock-actor@bambook.test',
      passwordHash: '',
    },
  });
}

async function makeOrderAndLine(suffix: string) {
  const order = await prisma.order.create({
    data: {
      id: MARK + 'ORD_' + suffix, customer: 'TEST_CUST', product: 'P', type: 'Garment',
      quantity: 1000, status: 'Confirmed', dueDate: '2026-12-31', quoteAmount: 10000,
      updatedAt: BigInt(Date.now()),
    },
  });
  const line = await prisma.orderLine.create({
    data: { id: MARK + 'LINE_' + suffix, orderId: order.id, lineNumber: 1, quantity: 1000, unit: 'PCS' },
  });
  return { order, line };
}

async function makeShipment(suffix: string, status: string) {
  return prisma.shipment.create({
    data: {
      id: MARK + 'SHP_' + suffix, shipmentNumber: 'TEST-SHPLOCK-' + suffix,
      type: 'Export', status, shippingMethod: 'Sea',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

/** 建一条分配并返回其 id（走真实 service，保证与生产同一路径） */
async function makeAllocation(shipmentId: string, orderId: string, orderLineId: string, qty = 300) {
  const r = await svc.createAllocation(shipmentId, { orderId, orderLineId, actualQty: qty, unit: 'PCS' }, ACTOR);
  if (!r.ok) throw new Error(`预置分配失败：${r.error?.code} ${r.error?.message}`);
  return r.data!.allocation.id;
}

describe('★ A1 守卫：已发运后禁止改实际出运量', () => {
  beforeEach(async () => {
    await cleanup();
    await ensureActor();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('① 阳性对照：Draft 运单改 actualQty → 通过（守卫不误伤正常业务）', async () => {
    const { order, line } = await makeOrderAndLine('A');
    const sh = await makeShipment('A', 'Draft');
    const allocId = await makeAllocation(sh.id, order.id, line.id, 300);

    const r = await svc.updateAllocation(sh.id, allocId, { actualQty: 500 }, ACTOR);
    expect(r.ok).toBe(true);
    expect(Number(r.data!.allocation.actualQty)).toBe(500);
  });

  it('② Shipped 运单改 actualQty → 拒绝 SHIPMENT_ALREADY_SHIPPED', async () => {
    const { order, line } = await makeOrderAndLine('B');
    const sh = await makeShipment('B', 'Draft');
    const allocId = await makeAllocation(sh.id, order.id, line.id, 300);

    // 发运（直接改运单状态，模拟已发运）
    await prisma.shipment.update({ where: { id: sh.id }, data: { status: 'Shipped' } });

    const r = await svc.updateAllocation(sh.id, allocId, { actualQty: 500 }, ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('SHIPMENT_ALREADY_SHIPPED');

    // 独立复核：库里**没变**（拒绝必须是无副作用的）
    const after = await prisma.shipmentOrderAllocation.findUnique({ where: { id: allocId } });
    expect(Number(after!.actualQty)).toBe(300);
  });

  it('③ Shipped 运单只改状态（不动数量）→ 通过（只锁数量，不锁状态流转）', async () => {
    const { order, line } = await makeOrderAndLine('C');
    const sh = await makeShipment('C', 'Shipped');
    const allocId = await makeAllocation(sh.id, order.id, line.id, 300);

    const r = await svc.updateAllocation(sh.id, allocId, { status: 'Fulfilled', batchOrCartonNote: '整柜' }, ACTOR);
    expect(r.ok).toBe(true);
    expect(r.data!.allocation.status).toBe('Fulfilled');
  });

  it('④ Shipped 运单改 unit → 拒绝（单位变了数量语义就变）', async () => {
    const { order, line } = await makeOrderAndLine('D');
    const sh = await makeShipment('D', 'Draft');
    const allocId = await makeAllocation(sh.id, order.id, line.id, 300);

    await prisma.shipment.update({ where: { id: sh.id }, data: { status: 'Delivered' } });

    const r = await svc.updateAllocation(sh.id, allocId, { unit: 'PCS' }, ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('SHIPMENT_ALREADY_SHIPPED');
  });

  it('⑤ 未发运的各态（Booked/Loading）都不受影响 —— 锁的边界是对的', async () => {
    for (const st of ['Booked', 'Loading']) {
      const { order, line } = await makeOrderAndLine('E' + st);
      const sh = await makeShipment('E' + st, st);
      const allocId = await makeAllocation(sh.id, order.id, line.id, 300);
      const r = await svc.updateAllocation(sh.id, allocId, { actualQty: 400 }, ACTOR);
      expect(r.ok, `${st} 状态应允许改数量`).toBe(true);
    }
  });
});
