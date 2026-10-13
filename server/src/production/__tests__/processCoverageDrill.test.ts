/**
 * processCoverageDrill.test.ts — ★ D2 真库守卫：多工厂/多工位分批交货的合计核对
 *
 * 为什么要有这个测试（零基础障碍清单 D2「缺合计校验」）：
 *   一张订单可挂多条 `ProductionPlan`（多工位/多批次）与多张 `OutsourcingOrder`（多外协厂），
 *   系统**从不做合计核对** ⇒ 1000 件的订单可以排成 3000 件、也可以只排 200 件，
 *   两种都只有到交期才知道。
 *
 * 判据（真库 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 多工序各排全量 → **全部 ok**（★ 核心：不能把正常多工序排产判成超产）
 *   ② 同一工序跨工位合计超订单 → over + overBy 正确
 *   ③ 排产 + 外协**同一工序**合并计算（不同厂各 600 / 订单 1000 → 超产）
 *   ④ **已取消**的排产/外协不计入合计（Cancelled 不该算数）
 *   ⑤ 软删的不计入
 *   ⑥ 欠产只报 share（覆盖度），不判错
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';
import { getOrderProductionCoverage } from '../processCoverageService';

const MARK = 'TEST_D2PC_';
/**
 * ★ B35 第三刀采纳点 11/12（v2.88）：客户端由触碰记录壳给。
 *   另修一处“只删不数”：`cleanup()` 删 5 张表、`residual()` 只数 4 张（`orderLine` 不在内）⇒ 并入零残留等式。
 *   id/业务号仍留在 `TEST_D2PC_` 族内 ⇒ 认领口径不换；清理由“整族删”收窄为“只删本次 run”。
 */
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function cleanup() {
  await prisma.productionPlan.deleteMany({ where: { planNumber: { startsWith: ctx.mark } } });
  await prisma.outsourcingOrder.deleteMany({ where: { orderNumber: { startsWith: ctx.mark } } });
  await prisma.workStation.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.orderLine.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.order.deleteMany({ where: { id: { startsWith: ctx.mark } } });
}

/** ⓘ ProductionPlan.workStationId 是**真 FK**（不像别处是 snapshot FK）⇒ 演练必须先建工位 */
async function makeWorkStation(type = 'Sewing') {
  return prisma.workStation.create({
    data: {
      id: ctx.id(`WS_${n()}`), code: ctx.id(`WS-${n()}`), name: 'D2 测试工位', type,
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } as any,
  });
}

/** ★ B151：同一批计数，但**数不了的表**要单列成"没有读数"，不许冒充 0、也不许与"有残留"混成一条红。 */
const RESIDUAL_SPEC = [
  { key: 'plan', model: 'ProductionPlan', run: () => prisma.productionPlan.count({ where: { planNumber: { startsWith: ctx.mark } } }) },
  { key: 'oso', model: 'OutsourcingOrder', run: () => prisma.outsourcingOrder.count({ where: { orderNumber: { startsWith: ctx.mark } } }) },
  { key: 'ord', model: 'Order', run: () => prisma.order.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'ws', model: 'WorkStation', run: () => prisma.workStation.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'line', model: 'OrderLine', run: () => prisma.orderLine.count({ where: { id: { startsWith: ctx.mark } } }) },
];

async function makeOrder(quantity = 1000) {
  const order = await prisma.order.create({
    data: {
      id: ctx.id(`ORD_${n()}`), poNumber: ctx.id(`PO_${n()}`), customer: 'D2 客户',
      product: '成衣', type: 'Garment', quantity, status: 'Production',
      dueDate: '2026-12-31', quoteAmount: 100000, updatedAt: BigInt(Date.now()),
    },
  });
  await prisma.orderLine.create({
    data: { id: ctx.id(`LINE_${n()}`), orderId: order.id, lineNumber: 1, quantity, unit: 'PC' },
  });
  return order;
}

async function makePlan(orderId: string, processType: string, qty: number, over: Record<string, unknown> = {}) {
  const ws = await makeWorkStation(processType);
  return prisma.productionPlan.create({
    data: {
      id: ctx.id(`PP_${n()}`), planNumber: ctx.id(`PP-${n()}`), orderId,
      workStationId: ws.id, processType, plannedQuantity: new Prisma.Decimal(qty),
      unit: 'PC', plannedStartDate: '2026-10-01', plannedEndDate: '2026-10-20',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      ...over,
    } as any,
  });
}

async function makeOutsourcing(orderId: string, processType: string, qty: number, over: Record<string, unknown> = {}) {
  return prisma.outsourcingOrder.create({
    data: {
      id: ctx.id(`OSO_${n()}`), orderNumber: ctx.id(`OSO-${n()}`), orderId,
      supplierId: `SUP-${n()}`, processType, quantity: new Prisma.Decimal(qty),
      unit: 'PC', unitPrice: new Prisma.Decimal(1), totalAmount: new Prisma.Decimal(qty),
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      ...over,
    } as any,
  });
}

const coverageOf = async (orderId: string, tolerancePercent?: number) => {
  const r = await getOrderProductionCoverage(prisma, orderId, { tolerancePercent });
  if (!r) throw new Error('覆盖度查询返回 null（订单不存在？）');
  return r;
};

describe('★ D2 真库守卫：排产覆盖度（多工厂/多工位）', () => {
  beforeAll(async () => { await cleanup(); });

  afterAll(async () => {
    await cleanup();
    // ★ B151：以前这一行是 `expect(await residual()).toEqual({...0})` —— 数据库瞬断时它抛裸 Prisma 栈，
    //   报形变成"suite 失败但 0 个用例红"，和"真清出残留"共用同一个读数（2026-09-24 全量门禁实测撞上）。
    //   ⇒ 现在：先问"有没有读数"，再问"读数是不是零"。
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ plan: 0, oso: 0, ord: 0, ws: 0, line: 0 });
    const touched = ctx.touchedModels();
    expect(touched, '本演练建工位 ⇒ WorkStation 必须在触碰集合里').toContain('WorkStation');
    await prisma.$disconnect();
  });

  it('① ★ 多工序各排全量 → 全部 ok（不能把正常多工序排产判成超产）', async () => {
    const o = await makeOrder(1000);
    await makePlan(o.id, 'Cutting', 1000);
    await makePlan(o.id, 'Sewing', 1000);
    await makePlan(o.id, 'Packing', 1000);

    const c = await coverageOf(o.id);
    expect(c.processes).toHaveLength(3);
    expect(c.overProcessTypes).toEqual([]);
    expect(c.judged).toBe(true);
    expect(c.orderQuantity).toBe(1000);
    expect(c.unit).toBe('PC');
  });

  it('② 同一工序跨两工位合计 2000/1000 → over', async () => {
    const o = await makeOrder(1000);
    await makePlan(o.id, 'Sewing', 1000);
    await makePlan(o.id, 'Sewing', 1000);

    const c = await coverageOf(o.id);
    expect(c.overProcessTypes).toEqual(['Sewing']);
    expect(c.processes[0].plannedTotal).toBe(2000);
    expect(c.processes[0].overBy).toBe(1000);
    expect(c.processes[0].share).toBe(2);
  });

  it('③ 排产 + 外协同一工序合并计算（600 + 600 / 1000 → 超产）', async () => {
    const o = await makeOrder(1000);
    await makePlan(o.id, 'Sewing', 600);
    await makeOutsourcing(o.id, 'Sewing', 600);

    const c = await coverageOf(o.id);
    expect(c.processes).toHaveLength(1);
    expect(c.processes[0].plannedTotal).toBe(1200);
    expect(c.overProcessTypes).toEqual(['Sewing']);
    expect(c.planCount).toBe(1);
    expect(c.outsourcingCount).toBe(1);
  });

  it('④ 已取消的排产/外协**不计入**合计（Cancelled 不该算数）', async () => {
    const o = await makeOrder(1000);
    await makePlan(o.id, 'Sewing', 1000);
    await makePlan(o.id, 'Sewing', 5000, { status: 'Cancelled' });   // 取消的超产计划
    await makeOutsourcing(o.id, 'Sewing', 5000, { status: 'Cancelled' });

    const c = await coverageOf(o.id);
    expect(c.processes[0].plannedTotal).toBe(1000);
    expect(c.overProcessTypes).toEqual([]);
  });

  it('⑤ 软删的排产不计入合计', async () => {
    const o = await makeOrder(1000);
    await makePlan(o.id, 'Sewing', 1000);
    await makePlan(o.id, 'Sewing', 5000, { deletedAt: BigInt(Date.now()) });

    const c = await coverageOf(o.id);
    expect(c.processes[0].plannedTotal).toBe(1000);
    expect(c.overProcessTypes).toEqual([]);
  });

  it('⑥ 欠产只报 share（覆盖度），不判错', async () => {
    const o = await makeOrder(1000);
    await makePlan(o.id, 'Sewing', 200);

    const c = await coverageOf(o.id);
    expect(c.overProcessTypes).toEqual([]);
    expect(c.processes[0].verdict).toBe('ok');
    expect(c.processes[0].share).toBe(0.2);
  });

  it('⑦ 容差：tolerancePercent=3 时 1030 放行 / 1040 超产', async () => {
    const o1 = await makeOrder(1000);
    await makePlan(o1.id, 'Sewing', 1030);
    expect((await coverageOf(o1.id, 3)).overProcessTypes).toEqual([]);

    const o2 = await makeOrder(1000);
    await makePlan(o2.id, 'Sewing', 1040);
    expect((await coverageOf(o2.id, 3)).overProcessTypes).toEqual(['Sewing']);
  });
});
