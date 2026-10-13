/**
 * dyeLotStockDrill.test.ts — ★ D1 真库守卫：库存按缸号归集 + 色差风险对撞
 *
 * 为什么要有这个测试（零基础障碍清单 D1「缺库存层 lot」· 真库实测驱动）：
 *   缸号/色差评级只存在于缸差登记（`SampleColorBatch`），与库存**零交集**（实测交集 0）
 *   ⇒ 业务员无法回答「这批货是哪个缸的、色差几级、能不能用来做这一单」。
 *
 * 判据（真库 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 库存 batchNumber 与已登记 dyeLotNo 对撞 → 带出评级与风险（low/medium/high）
 *   ② ★ 未登记缸号 → risk=unknown（**不是** low）并进 unregisteredLots
 *   ③ 无批次号的库存 → noBatchCount（不并入任何缸）
 *   ④ 同一缸号多条登记 → 取**最新**一条（按 createdAt 倒序）
 *   ⑤ category / warehouseId 过滤生效
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createDrillContext, withBackend } from '../../__tests__/lib/drillTouchLog';
import { getDyeLotStock } from '../dyeLotStockService';

const MARK = 'TEST_D1LOT_';
/**
 * ★ B35 第三刀采纳点 10/12（v2.87）：客户端由触碰记录壳给。
 *   缸号（`dyeLotNo`）在这个演练里既当业务值又当认领锚点 ⇒ 一并改成 `ctx.id(...)`（仍留在 `TEST_D1LOT_` 族内 ⇒ 认领口径不换），
 *   这样清理/断言才收窄得到**本次 run**，不再"整族删"。
 */
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function cleanup() {
  await prisma.sampleColorBatch.deleteMany({ where: { dyeLotNo: { startsWith: ctx.mark } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.warehouse.deleteMany({ where: { id: { startsWith: ctx.mark } } });
}

async function residual() {
  const [item, batch, wh] = await Promise.all([
    prisma.inventoryItem.count({ where: { id: { startsWith: ctx.mark } } }),
    prisma.sampleColorBatch.count({ where: { dyeLotNo: { startsWith: ctx.mark } } }),
    prisma.warehouse.count({ where: { id: { startsWith: ctx.mark } } }),
  ]);
  return { item, batch, wh };
}

async function makeWarehouse() {
  return prisma.warehouse.create({
    data: {
      id: ctx.id(`WH_${n()}`), code: ctx.id(`WH-${n()}`), name: 'D1 测试仓', type: 'Main',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } as any,
  });
}

async function makeItem(warehouseId: string, batchNumber: string | null, quantity = 100, category = 'Fabric') {
  return prisma.inventoryItem.create({
    data: {
      id: ctx.id(`ITEM_${n()}`), warehouseId, description: 'D1 面料', category,
      batchNumber, quantity: new Prisma.Decimal(quantity), unit: 'M',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } as any,
  });
}

/** 登记缸差（stage=bulk 挂订单）。createdAt 显式给值以便测「取最新」。 */
async function makeDyeLot(dyeLotNo: string, colorRating: number, createdAtOffsetMs = 0) {
  return prisma.sampleColorBatch.create({
    data: {
      id: ctx.id(`SCB_${n()}`), batchCode: ctx.id(`SCB-${n()}`),
      stage: 'bulk', dyeLotNo, colorRating, sideDiff: 5, endDiff: 5, defectCauses: [],
      customerStatus: 'pending',
      createdAt: BigInt(Date.now() + createdAtOffsetMs), updatedAt: BigInt(Date.now()),
    } as any,
  });
}

const lotOf = (r: Awaited<ReturnType<typeof getDyeLotStock>>, lot: string) => r.lots.find(l => l.lot === lot);

describe('★ D1 真库守卫：库存缸号配料核对', () => {
  beforeAll(async () => { await cleanup(); });

  afterAll(async () => {
    await cleanup();
    expect(await withBackend(`DyeLot 三张表`, residual)).toEqual({ item: 0, batch: 0, wh: 0 }); // 零残留（同一判据）
    /** ★ 壳那一半：触碰非空 + 含主对象 + 列无关 dirty=[] + 不许有数不到的表 */
    const touched = ctx.touchedModels();
    expect(touched, '库存项是本演练的主对象 ⇒ InventoryItem 必须在触碰集合里').toContain('InventoryItem');
    await prisma.$disconnect();
  });

  it('① 对撞已登记缸号 → 带出评级与风险', async () => {
    const wh = await makeWarehouse();
    const L1 = ctx.id(`L1`);
    await makeDyeLot(L1, 5);
    await makeItem(wh.id, L1, 300);
    await makeItem(wh.id, L1, 200);

    const r = await getDyeLotStock(prisma);
    const g = lotOf(r, L1)!;
    expect(g).toBeTruthy();
    expect(g.registered).toBe(true);
    expect(g.colorRating).toBe(5);
    expect(g.risk).toBe('low');
    expect(g.itemCount).toBe(2);
    expect(g.quantityByUnit).toEqual([{ unit: 'M', quantity: 500 }]);
  });

  it('② ★ 未登记缸号 → unknown（不是 low）且进 unregisteredLots', async () => {
    const wh = await makeWarehouse();
    const UNK = ctx.id(`UNREGISTERED`);
    await makeItem(wh.id, UNK, 100);

    const r = await getDyeLotStock(prisma);
    const g = lotOf(r, UNK)!;
    expect(g.registered).toBe(false);
    expect(g.risk).toBe('unknown');
    expect(r.unregisteredLots).toContain(UNK);
  });

  it('③ 无批次号的库存 → noBatchCount（不并入任何缸）', async () => {
    const wh = await makeWarehouse();
    await makeItem(wh.id, null, 50);
    await makeItem(wh.id, '   ', 50);

    const r = await getDyeLotStock(prisma);
    expect(r.noBatchCount).toBeGreaterThanOrEqual(2);
    expect(r.lots.every(l => l.lot.trim() !== '')).toBe(true);
  });

  it('④ 同一缸号多条登记 → 取最新（createdAt 更大者）', async () => {
    const wh = await makeWarehouse();
    const L2 = ctx.id(`L2`);
    await makeDyeLot(L2, 5, 0);              // 旧：评级 5
    await makeDyeLot(L2, 1, 60_000);         // 新：评级 1（重染后变差）
    await makeItem(wh.id, L2, 100);

    const r = await getDyeLotStock(prisma);
    const g = lotOf(r, L2)!;
    expect(g.colorRating).toBe(1); // 最新那条
    expect(g.risk).toBe('high');
  });

  it('⑤ category 过滤生效（非 Fabric 不计入）', async () => {
    const wh = await makeWarehouse();
    const L3 = ctx.id(`L3`);
    await makeDyeLot(L3, 5);
    await makeItem(wh.id, L3, 100, 'Fabric');
    await makeItem(wh.id, L3, 100, 'Trimmings');

    const fabric = await getDyeLotStock(prisma, { category: 'Fabric' });
    const gF = lotOf(fabric, L3)!;
    expect(gF.itemCount).toBe(1);

    const trim = await getDyeLotStock(prisma, { category: 'Trimmings' });
    const gT = lotOf(trim, L3)!;
    expect(gT.itemCount).toBe(1);
  });

  it('⑥ warehouseId 过滤生效', async () => {
    const whA = await makeWarehouse();
    const whB = await makeWarehouse();
    const L4 = ctx.id(`L4`);
    await makeItem(whA.id, L4, 100);
    await makeItem(whB.id, L4, 700);

    const onlyA = await getDyeLotStock(prisma, { warehouseId: whA.id });
    const g = lotOf(onlyA, L4)!;
    expect(g.itemCount).toBe(1);
    expect(g.quantityByUnit).toEqual([{ unit: 'M', quantity: 100 }]);
  });
});
