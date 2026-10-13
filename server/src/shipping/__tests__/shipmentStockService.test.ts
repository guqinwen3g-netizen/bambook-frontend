/**
 * T3 · H9 出运扣库存 / 取消回冲单元测试（shipmentStockService）
 *
 * 覆盖：
 *   - 扣减：每行写 Lock → Outbound → Unlock 三条流水，referenceType='Shipment'
 *   - 扣减幂等：已有 Outbound 流水 → alreadyProcessed 跳过
 *   - 数量真源：ShipmentLine（orderLineId → OrderLine 身份）+ 分配行兜底
 *   - 库存项定位：主仓优先、可用量足够者优先
 *   - 无库存项 → 跳过留痕（不阻断出运）；可用量不足 → fail-closed 抛错
 *   - 回冲：按原 Outbound 流水逐条补反向 Inbound（原行不动）；幂等
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { storageReader, storageRowLocks } from './shippingSourceStorageFixture';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  deductShipmentStockInTx,
  reverseShipmentStockInTx,
  resolveOrderLineIdentity,
  STOCK_DEDUCTED_STATUSES,
} from '../shipmentStockService';

function makeDb(opts: {
  item?: any;
  extraItems?: any[];
  existingOutbound?: any;
  existingInbound?: any;
  shipmentLines?: any[];
  orderLines?: any[];
  allocations?: any[];
  outboundsForReverse?: any[];
  productionBatches?: any[];
  physicalAllocations?: any[];
} = {}) {
  const item = opts.item ?? null;
  const extraItems = opts.extraItems ?? [];

  const movements: any[] = [];
  // 可变行模型：findUnique 与 CAS updateMany 读写同一组行对象（模拟真实 DB）
  const rows: any[] = [item, ...extraItems].filter(Boolean).map((it: any) => ({ ...it }));
  const dbItem = rows[0] ?? null;

  const inventoryItemFindUnique = vi.fn().mockImplementation(async ({ where }: any) => {
    return rows.find((it: any) => it.id === where.id) ?? null;
  });
  const inventoryItemUpdateMany = vi.fn().mockImplementation(async ({ where, data }: any) => {
    const row = rows.find((it: any) => it.id === where.id);
    if (!row) return { count: 0 };
    if (Number(where.quantity) !== Number(row.quantity)) return { count: 0 };
    if (Number(where.lockedQuantity ?? 0) !== Number(row.lockedQuantity ?? 0)) return { count: 0 };
    if (typeof data?.quantity?.increment === 'number') row.quantity = Number(row.quantity) + data.quantity.increment;
    if (typeof data?.lockedQuantity?.increment === 'number') row.lockedQuantity = Number(row.lockedQuantity ?? 0) + data.lockedQuantity.increment;
    return { count: 1 };
  });
  const inventoryItemFindMany = vi.fn().mockImplementation(async ({ where }: any) => {
    const all = [item, ...extraItems].filter(Boolean);
    return all.filter((it: any) => where.materialCode ? it.materialCode === where.materialCode : true);
  });

  const source = { shipment: { id: 'SHP_1', shipmentNumber: 'SHP-001', orderId: null, status: 'Booked', deletedAt: null },
    lines: (opts.orderLines ?? []).map(row => ({ orderId: 'O_1', ...row })),
    allocations: (opts.allocations ?? []).map(row => ({ shipmentId: 'SHP_1', orderId: 'O_1', ...row })),
    batches: opts.productionBatches ?? [], physical: opts.physicalAllocations ?? [], locks: [] as any[] };
  const orders = [...new Set(source.allocations.map(row => row.orderId))].map(id => ({ id }));
  const prisma: any = {
    shipment: storageReader(() => [source.shipment]),
    releaseScope: storageReader(() => []),
    productionBatch: storageReader(() => source.batches),
    shipmentProductionAllocation: storageReader(() => source.physical),
    productAsset: storageReader(() => []),
    // Complete source-detection seam: these original cases are ordinary shipments.
    claimDisposition: { findMany: async () => [] },
    repairWorkOrder: { findMany: async () => [] },
    shipmentLine: { findMany: vi.fn().mockResolvedValue(opts.shipmentLines ?? []) },
    orderLine: storageReader(() => source.lines),
    shipmentOrderAllocation: storageReader(() => source.allocations),
    inventoryItem: {
      findUnique: inventoryItemFindUnique,
      findMany: inventoryItemFindMany,
      updateMany: inventoryItemUpdateMany,
    },
    warehouse: { findUnique: vi.fn().mockResolvedValue({ id: 'WH_1', code: 'WH-001', type: 'Main', isActive: true, deletedAt: null }) },
    stockMovement: {
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.type === 'Outbound') return opts.existingOutbound ?? null;
        if (where.type === 'Inbound') return opts.existingInbound ?? null;
        return null;
      }),
      findMany: vi.fn().mockResolvedValue(opts.outboundsForReverse ?? []),
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        const row = { ...data, id: `SM_${movements.length + 1}` };
        movements.push(row);
        return row;
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'AL_1' }) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  prisma.$queryRaw = storageRowLocks({ Shipment: () => [source.shipment], Order: () => orders,
    OrderLine: () => source.lines, ShipmentOrderAllocation: () => source.allocations }, source.locks);
  // 挂到 prisma 上便于断言（内存行/流水）
  (prisma as any).dbItem = dbItem;
  (prisma as any).movements = movements;
  return { prisma, movements, dbItem };
}

const baseItem = {
  id: 'INV_1', warehouseId: 'WH_1', materialCode: 'FAB-001', description: '面料A',
  quantity: 100, lockedQuantity: 0, unit: 'M', deletedAt: null,
  warehouse: { id: 'WH_1', type: 'Main', sortOrder: 0 },
};

const orderLine1 = { id: 'OL_1', lineNumber: 1, materialCode: 'FAB-001', itemNo: null, description: '面料A' };
const shipmentLine1 = { id: 'SHPL_1', lineNumber: 1, orderLineId: 'OL_1', productCode: 'FAB-001', quantity: 30, unit: 'M' };

describe('shipmentStockService: deductShipmentStockInTx', () => {
  beforeEach(() => vi.clearAllMocks());

  it('按装运行写单条 Outbound 流水，referenceType=Shipment（不写 Lock：同事务自锁死，见服务头注释）', async () => {
    const { prisma, movements } = makeDb({ item: baseItem, shipmentLines: [shipmentLine1], orderLines: [orderLine1] });

    const result = await deductShipmentStockInTx(prisma, prisma, 'SHP_1', 'SHP-001', 'tester');

    expect(result.alreadyProcessed).toBe(false);
    expect(result.movementCount).toBe(1);
    expect(result.deductedLines).toEqual([{ identity: 'FAB-001', quantity: 30, unit: 'M', itemId: 'INV_1' }]);
    expect(movements.map((m) => m.type)).toEqual(['Outbound']);
    for (const m of movements) {
      expect(m.referenceType).toBe('Shipment');
      expect(m.referenceId).toBe('SHP_1');
      expect(Number(m.quantity)).toBe(30);
    }
    // 余额净效果：quantity -30，locked 不变（其他订单的预留不被本票出库触碰）
    expect(Number(prisma.dbItem?.quantity)).toBe(70);
    expect(Number(prisma.dbItem?.lockedQuantity)).toBe(0);
  });

  it('整仓全量出运（行数量 == 全部库存）不因自身锁死——真库自锁缺陷的回归用例', async () => {
    // 该用例钉住 Lock→Outbound 序列被证伪后的口径：全量出运必须可行
    const { prisma, movements } = makeDb({
      item: { ...baseItem, quantity: 800, lockedQuantity: 0 },
      shipmentLines: [{ ...shipmentLine1, quantity: 800 }],
      orderLines: [orderLine1],
    });

    const result = await deductShipmentStockInTx(prisma, prisma, 'SHP_1', 'SHP-001', 'tester');

    expect(result.movementCount).toBe(1);
    expect(movements.map((m) => m.type)).toEqual(['Outbound']);
    expect(Number(prisma.dbItem?.quantity)).toBe(0);
  });

  it('幂等：已有该运单的 Outbound 流水 → alreadyProcessed，不重复扣', async () => {
    const { prisma, movements } = makeDb({
      item: baseItem, shipmentLines: [shipmentLine1], orderLines: [orderLine1],
      existingOutbound: { id: 'SM_prior' },
    });

    const result = await deductShipmentStockInTx(prisma, prisma, 'SHP_1', 'SHP-001', 'tester');

    expect(result.alreadyProcessed).toBe(true);
    expect(movements).toHaveLength(0);
  });

  it('无装运行 → 行级分配兜底（actualQty 优先于 plannedQty）；订单级分配跳过留痕', async () => {
    const { prisma, movements } = makeDb({
      item: baseItem,
      shipmentLines: [],
      allocations: [
        { id: 'SHPA_1', orderLineId: 'OL_1', plannedQty: 20, actualQty: 25, unit: 'M' },
        { id: 'SHPA_2', orderLineId: null, plannedQty: 50, unit: 'M' },
      ],
      orderLines: [orderLine1],
    });

    const result = await deductShipmentStockInTx(prisma, prisma, 'SHP_1', 'SHP-001', 'tester');

    expect(result.movementCount).toBe(1);
    expect(result.deductedLines[0].quantity).toBe(25);
    expect(result.skipped.some((s) => s.includes('SHPA_2'))).toBe(true);
    expect(movements.map((m) => m.type)).toEqual(['Outbound']);
  });

  it('无在库库存项 → 跳过留痕，不阻断出运（历史订单未入库场景）', async () => {
    const { prisma, movements } = makeDb({ item: null, shipmentLines: [shipmentLine1], orderLines: [orderLine1] });

    const result = await deductShipmentStockInTx(prisma, prisma, 'SHP_1', 'SHP-001', 'tester');

    expect(result.movementCount).toBe(0);
    expect(result.skipped.some((s) => s.includes('无在库成品库存项'))).toBe(true);
    expect(movements).toHaveLength(0);
  });

  it('可用量不足（含锁定量）→ fail-closed 抛错（与门禁同事务，整体回滚）', async () => {
    const { prisma } = makeDb({
      item: { ...baseItem, quantity: 10, lockedQuantity: 0 },
      shipmentLines: [shipmentLine1], orderLines: [orderLine1],
    });

    await expect(deductShipmentStockInTx(prisma, prisma, 'SHP_1', 'SHP-001', 'tester'))
      .rejects.toThrow(/库存不足|可锁定库存不足/);
  });

  it('库存项定位：可用量足够者优先于排序靠前但不足的项', async () => {
    const insufficient = { ...baseItem, id: 'INV_0', quantity: 5, lockedQuantity: 0 };
    const { prisma, movements } = makeDb({
      item: insufficient,
      extraItems: [baseItem],
      shipmentLines: [shipmentLine1], orderLines: [orderLine1],
    });

    const result = await deductShipmentStockInTx(prisma, prisma, 'SHP_1', 'SHP-001', 'tester');

    expect(result.deductedLines[0].itemId).toBe('INV_1');
    // 三条流水都落在足够量的库存项上
    expect(movements.every((m) => m.itemId === 'INV_1')).toBe(true);
  });

  it('身份解析对称：OrderLine 无 materialCode 时回退 itemNo', () => {
    expect(resolveOrderLineIdentity({ materialCode: 'FAB-001', itemNo: 'X-1' })).toBe('FAB-001');
    expect(resolveOrderLineIdentity({ materialCode: null, itemNo: 'X-1' })).toBe('X-1');
    expect(resolveOrderLineIdentity({ materialCode: '', itemNo: '' })).toBeNull();
  });

  it('STOCK_DEDUCTED_STATUSES 覆盖 Shipped 及其后的全部已扣账状态', () => {
    expect(STOCK_DEDUCTED_STATUSES.has('Shipped')).toBe(true);
    expect(STOCK_DEDUCTED_STATUSES.has('Arrived')).toBe(true);
    expect(STOCK_DEDUCTED_STATUSES.has('Cleared')).toBe(true);
    expect(STOCK_DEDUCTED_STATUSES.has('Delivered')).toBe(true);
    expect(STOCK_DEDUCTED_STATUSES.has('Loading')).toBe(false);
    expect(STOCK_DEDUCTED_STATUSES.has('Booked')).toBe(false);
  });
});

describe('shipmentStockService: reverseShipmentStockInTx', () => {
  it('按原 Outbound 流水逐条补反向 Inbound，notes 引用原流水号', async () => {
    const { prisma, movements } = makeDb({
      item: { ...baseItem, quantity: 70 },
      outboundsForReverse: [
        { id: 'SM_o1', itemId: 'INV_1', type: 'Outbound', quantity: 30, unit: 'M', movementNumber: 'SM-20260916-AAAA' },
      ],
    });

    const result = await reverseShipmentStockInTx(prisma, prisma, 'SHP_1', 'SHP-001', 'tester');

    expect(result.alreadyProcessed).toBe(false);
    expect(result.movementCount).toBe(1);
    expect(movements).toHaveLength(1);
    const reversal = movements[0];
    expect(reversal.type).toBe('Inbound');
    expect(reversal.referenceType).toBe('Shipment');
    expect(reversal.referenceId).toBe('SHP_1');
    expect(Number(reversal.quantity)).toBe(30);
    expect(reversal.notes).toContain('SM-20260916-AAAA');
  });

  it('幂等：已有回冲 Inbound → alreadyProcessed，不重复回冲', async () => {
    const { prisma, movements } = makeDb({
      existingInbound: { id: 'SM_prior' },
      outboundsForReverse: [
        { id: 'SM_o1', itemId: 'INV_1', type: 'Outbound', quantity: 30, unit: 'M', movementNumber: 'SM-1' },
      ],
    });

    const result = await reverseShipmentStockInTx(prisma, prisma, 'SHP_1', 'SHP-001', 'tester');

    expect(result.alreadyProcessed).toBe(true);
    expect(movements).toHaveLength(0);
  });

  it('无 Outbound 流水（未扣过账）→ 不产生任何回冲', async () => {
    const { prisma, movements } = makeDb({ outboundsForReverse: [] });

    const result = await reverseShipmentStockInTx(prisma, prisma, 'SHP_1', 'SHP-001', 'tester');

    expect(result.movementCount).toBe(0);
    expect(movements).toHaveLength(0);
  });
});


describe('Stock legacy seam cannot consume physical source history', () => {
  it('actual parent batch rejects before any inventory update or stock movement', async () => {
    const { prisma, movements, dbItem } = makeDb({ item: baseItem, orderLines: [orderLine1], shipmentLines: [shipmentLine1],
      allocations: [{ id: 'A1', orderLineId: 'OL_1', actualQty: '3' }],
      productionBatches: [{ id: 'PB1', orderId: 'O_1', state: 'active' }] });
    await expect(deductShipmentStockInTx(prisma, prisma, 'SHP_1', 'SHP-001', 'tester')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(movements).toEqual([]); expect(dbItem.quantity).toBe(100);
    expect(prisma.inventoryItem.updateMany).not.toHaveBeenCalled(); expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
  it('physical projection history also forbids a legacy reverse without rewriting original stock', async () => {
    const { prisma, movements, dbItem } = makeDb({ item: baseItem,
      physicalAllocations: [{ id: 'P1', shipmentId: 'SHP_1', state: 'reversed' }],
      outboundsForReverse: [{ id: 'OUT1', itemId: 'INV_1', quantity: '3', movementNumber: 'OUT-1' }] });
    await expect(reverseShipmentStockInTx(prisma, prisma, 'SHP_1', 'SHP-001', 'tester')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(movements).toEqual([]); expect(dbItem.quantity).toBe(100);
    expect(prisma.inventoryItem.updateMany).not.toHaveBeenCalled(); expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });
});
