/**
 * T3 · H8 成品入库联动（L11）单元测试
 *
 * 覆盖：
 *   - ProductionCompleted → 按订单行写 Inbound 流水（referenceType='Order'，referenceId=orderId）
 *   - 缺库存项时自动建行（lockedQuantity=0 初值，与 L8 范式一致）
 *   - 幂等：已有该订单 Inbound 流水 → 跳过
 *   - 无 active 仓库 / 订单不存在 → 失败返回
 *
 * 触发方式：与 linkages.test.ts 同款 —— publishBusinessEvent + 延时等待异步订阅者。
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { businessEventBus, publishBusinessEvent } from '../../businessEventBus';
import { registerL11FinishedGoodsStockIn } from '../L11FinishedGoodsStockIn';

function makeMockPrisma(overrides: Record<string, any> = {}) {
  const movements: any[] = [];
  const items: any[] = [];

  const prisma: any = {
    stockMovement: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        const row = { ...data, id: `SM_${movements.length + 1}` };
        movements.push(row);
        return row;
      }),
    },
    order: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    warehouse: {
      findFirst: vi.fn().mockResolvedValue({ id: 'WH_MAIN', type: 'Main', isActive: true, deletedAt: null }),
      findUnique: vi.fn().mockResolvedValue({ id: 'WH_MAIN', type: 'Main', isActive: true, deletedAt: null }),
    },
    inventoryItem: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => items.find((it) => it.id === where.id) ?? null),
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        const row = { ...data, id: `INV_${items.length + 1}` };
        items.push(row);
        return row;
      }),
      updateMany: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const row = items.find((it) => it.id === where.id);
        if (!row) return { count: 0 };
        if (Number(where.quantity) !== Number(row.quantity)) return { count: 0 };
        if (Number(where.lockedQuantity ?? 0) !== Number(row.lockedQuantity ?? 0)) return { count: 0 };
        if (typeof data?.quantity?.increment === 'number') row.quantity = Number(row.quantity) + data.quantity.increment;
        if (typeof data?.lockedQuantity?.increment === 'number') row.lockedQuantity = Number(row.lockedQuantity ?? 0) + data.lockedQuantity.increment;
        return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'AL_1' }) },
    agentJob: { create: vi.fn().mockResolvedValue({}) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    ...overrides,
  };
  (prisma as any).__movements = movements;
  (prisma as any).__items = items;
  return prisma;
}

const orderWithLines = {
  id: 'ord_1',
  poNumber: 'PO-2026-001',
  deletedAt: null,
  lines: [
    { id: 'OL_1', lineNumber: 1, materialCode: 'FAB-001', itemNo: null, description: '面料A', category: 'Fabric', specification: '120g', unit: 'M', quantity: 500 },
    { id: 'OL_2', lineNumber: 2, materialCode: 'FAB-002', itemNo: null, description: '面料B', category: 'Fabric', specification: '160g', unit: 'M', quantity: 300 },
  ],
};

async function publishProductionCompleted(orderId = 'ord_1') {
  await publishBusinessEvent({
    type: 'ProductionCompleted',
    sourceEntityType: 'ProductionStage',
    sourceEntityId: 'pst_1',
    orderId,
    payload: { stageKey: 'qc_shipped', stageLabel: '验货发货' },
    actorId: 'test',
  });
  await new Promise((r) => setTimeout(r, 50));
}

describe('L11: ProductionCompleted → 成品按订单行入库', () => {
  let prisma: any;

  beforeEach(() => {
    vi.clearAllMocks();
    businessEventBus.reset();
    prisma = makeMockPrisma();
    businessEventBus.setPrisma(prisma);
    registerL11FinishedGoodsStockIn();
  });

  it('按订单行写 Inbound 流水，referenceType=Order、referenceId=orderId；缺项自动建行', async () => {
    prisma.order.findUnique.mockResolvedValue(orderWithLines);

    await publishProductionCompleted();

    const movements = prisma.__movements as any[];
    expect(movements).toHaveLength(2);
    for (const m of movements) {
      expect(m.type).toBe('Inbound');
      expect(m.referenceType).toBe('Order');
      expect(m.referenceId).toBe('ord_1');
    }
    expect(Number(movements[0].quantity)).toBe(500);
    expect(Number(movements[1].quantity)).toBe(300);
    // 自动建了两个库存项，初始 quantity=0、lockedQuantity=0，随后经流水入账
    const items = prisma.__items as any[];
    expect(items).toHaveLength(2);
    expect(Number(items[0].quantity)).toBe(500);
    expect(items[0].lockedQuantity).toBe(0);
    expect(items[0].materialCode).toBe('FAB-001');
  });

  it('同仓同身份复用既有库存项，不重复建行', async () => {
    prisma.order.findUnique.mockResolvedValue(orderWithLines);
    // 已有项同时放进可变行数组，让 CAS findUnique/updateMany 能读写它
    (prisma.__items as any[]).push({ id: 'INV_EXISTING', warehouseId: 'WH_MAIN', materialCode: 'FAB-001', quantity: 100, lockedQuantity: 0, unit: 'M', deletedAt: null });
    prisma.inventoryItem.findFirst.mockImplementation(async ({ where }: any) =>
      where.materialCode === 'FAB-001'
        ? (prisma.__items as any[]).find((it) => it.materialCode === 'FAB-001')
        : null);

    await publishProductionCompleted();

    // 只有 FAB-002 需要新建（findFirst 固定返回已有项，只对第一行生效性断言不跨行）
    expect(prisma.inventoryItem.create).toHaveBeenCalledTimes(1);
    const movements = prisma.__movements as any[];
    expect(movements[0].itemId).toBe('INV_EXISTING');
  });

  it('幂等：已有该订单的成品入库流水 → 跳过（不重复入库）', async () => {
    prisma.stockMovement.findFirst.mockResolvedValue({ id: 'SM_prior' });

    await publishProductionCompleted();

    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect((prisma.__movements as any[])).toHaveLength(0);
  });

  it('订单不存在 → 返回失败（可重试）', async () => {
    prisma.order.findUnique.mockResolvedValue(null);

    await publishProductionCompleted('ord_missing');

    expect((prisma.__movements as any[])).toHaveLength(0);
  });

  it('无 active 仓库 → 返回失败', async () => {
    prisma.order.findUnique.mockResolvedValue(orderWithLines);
    prisma.warehouse.findFirst.mockResolvedValue(null);

    await publishProductionCompleted();

    expect((prisma.__movements as any[])).toHaveLength(0);
  });
});
