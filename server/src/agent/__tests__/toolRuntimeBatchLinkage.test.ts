/**
 * W-B 断层④挂接点接线回归（Agent 直改路径）— toolRuntime 两条到 Shipped 的路径必须触发批次联动
 *
 * Agent 路径绕开 shipmentMutationService 且不发业务事件（走查发现的既有事实），
 * 因此联动采用服务层内联而非事件订阅；本文件锁定这两个内联点的接线不回归。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { legacySourceStorage, storageReader, storageRowLocks } from './shippingLegacyStorageFixture';

const autoAdvanceSpy = vi.hoisted(() => vi.fn().mockResolvedValue({ advanced: [], failed: [] }));

vi.mock('../../shipping/orderShipmentBatchService', () => ({
  createOrderShipmentBatchService: vi.fn(() => ({ autoAdvanceOnShipmentShipped: autoAdvanceSpy })),
}));
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shipping/shipmentEligibilityGate', () => ({
  evaluateShipmentReleaseGate: vi.fn().mockResolvedValue({ ok: true, data: { orders: [] } }),
}));
vi.mock('../../shipping/orderLinkService', () => ({
  linkOrderStatusFromShipment: vi.fn().mockResolvedValue({ ok: true, skipped: true }),
}));
vi.mock('../../audit/routeAudit', async (importOriginal) => {
  // ★ 用 importOriginal 做**部分** mock：整模块替换会让被测模块新引进的导出
  //   （B58 的 SYSTEM_AUDIT_ACTOR）在这里变成 undefined，测试红得毫无信息量。
  const actual = await importOriginal<any>();
  return { ...actual, writeRouteAuditLog: vi.fn().mockResolvedValue('AUDIT__TEST') };
});
vi.mock('../../entities/sync', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    syncShipmentReferences: vi.fn().mockResolvedValue(undefined),
    deactivateEntityLinks: vi.fn().mockResolvedValue(undefined),
  };
});

import { handleShippingCreateShipment, handleShippingUpdateTrackingStatus } from '../toolRuntime';
import { SYSTEM_AUDIT_ACTOR } from '../../audit/routeAudit';

function makePrisma(seed: { shipment?: any } = {}) {
  const shipmentRows = seed.shipment ? [{ ...seed.shipment }] : [];
  const source = legacySourceStorage();
  const allocations: any[] = [];
  if (seed.shipment) {
    source.rows.orderLines.push({ id: 'L-1', orderId: 'O-1', lineNumber: 1, itemNo: 'SKU-LEGACY-BATCH',
      quantity: '100', shipmentQuantity: 100, unit: 'pcs', tolerancePercent: '5', toleranceSource: null });
    allocations.push({ id: 'A-1', shipmentId: seed.shipment.id, orderId: 'O-1', orderLineId: 'L-1',
      plannedQty: '100', actualQty: '100', unit: 'pcs', status: 'Fulfilled', createdAt: 1n, updatedAt: 1n });
  }
  const orders = [{ id: 'O-1', status: 'Confirmed', deletedAt: null }];
  const tx: any = {
    ...source.models,
    order: storageReader(() => orders),
    auditLog: { create: vi.fn(async ({ data }: any) => ({ id: data.id, ...data })) },
    // No persisted claim source or stock entry belongs to these ordinary
    // shipments. The actual source guard still executes before deduction.
    claimDisposition: { findMany: vi.fn().mockResolvedValue([]) },
    repairWorkOrder: { findMany: vi.fn().mockResolvedValue([]) },
    shipment: {
      ...storageReader(() => shipmentRows),
      create: async ({ data }: any) => { const row = { ...data }; shipmentRows.push(row); return { ...row }; },
      update: async ({ where, data }: any) => { const row = shipmentRows.find(item => item.id === where.id);
        if (!row) throw new Error('Fixture update row not found'); Object.assign(row, data); return { ...row }; },
    },
    shipmentOrderAllocation: storageReader(() => allocations),
    systemConfig: { findUnique: async ({ where }: any) => {
      if (where.scope_key?.scope !== 'global' || where.scope_key?.key !== 'tolerance.internal_standard') throw Error('Unknown fixture config query'); return null;
    } },
    shipmentLine: { findMany: async () => [] }, // T3 H9 出运扣库存：空装运行 → 跳过留痕
    stockMovement: { findFirst: async () => null, findMany: async () => [], create: async () => ({}) },
    inventoryItem: { findMany: async () => [] },
    shipmentEvent: { create: async ({ data }: any) => ({ ...data }) },
  };
  tx.$queryRaw = storageRowLocks({ Order: () => orders, OrderLine: () => source.rows.orderLines, ReleaseScope: () => source.rows.releaseScopes,
    Shipment: () => shipmentRows, ShipmentOrderAllocation: () => allocations, ProductionBatch: () => source.rows.productionBatches,
    ShipmentProductionAllocation: () => source.rows.physicalAllocations }, source.rows.locks);
  const outerAuditRows: any[] = [];
  const auditLog = { ...storageReader(() => outerAuditRows), create: vi.fn(async ({ data }: any) => { const row = { ...data }; outerAuditRows.push(row); return { ...row }; }) };
  const prisma: any = { auditLog, outerAuditRows, $transaction: async (fn: any) => fn(tx) };
  return { prisma, tx };
}

beforeEach(() => { vi.clearAllMocks(); autoAdvanceSpy.mockResolvedValue({ advanced: [], failed: [] }); });

describe('Agent 直建运单（handleShippingCreateShipment）', () => {
  // ★ B58 补漏：批次联动的 actorId 会经 orderShipmentBatchService 写进 AuditLog.actorId（有外键）。
  //   这里原来钉的是 agent 字面量 —— 那正是「每次自动推进都静默失败」的形状：
  //   P2003 被 best-effort 的 catch 吞成 failed[]，运单显示 Shipped 而挂接批次永远停在 planned。
  it('直建 Shipped：触发批次自动联动（actorId=真账号）', async () => {
    const { prisma, tx } = makePrisma();
    const r = await handleShippingCreateShipment(prisma, {
      shipmentNumber: 'SH-2026-0010', type: 'FCL', shippingMethod: 'Sea', orderId: 'O-1', status: 'Shipped',
    });
    expect(r.ok, 'handler 返回：' + JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toBe(true);
    expect(autoAdvanceSpy).toHaveBeenCalledTimes(1);
    expect(autoAdvanceSpy.mock.calls[0][1]).toBe(SYSTEM_AUDIT_ACTOR);
    expect(tx.claimDisposition.findMany).toHaveBeenCalledWith({ where: { replacementShipmentId: r.created.id } });
    expect(tx.repairWorkOrder.findMany).toHaveBeenCalledWith({ where: { reshipmentId: r.created.id } });
  });

  it('默认 Booked 创建：不触发', async () => {
    const { prisma } = makePrisma();
    const r = await handleShippingCreateShipment(prisma, {
      shipmentNumber: 'SH-2026-0011', type: 'FCL', shippingMethod: 'Sea', orderId: 'O-1',
    });
    expect(r.ok, 'handler 返回：' + JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toBe(true);
    expect(autoAdvanceSpy).not.toHaveBeenCalled();
  });
});

describe('Agent 更新跟踪状态（handleShippingUpdateTrackingStatus）', () => {
  it('Booked→Shipped：触发批次自动联动', async () => {
    const { prisma, tx } = makePrisma({
      shipment: { id: 'SHP-1', status: 'Booked', orderId: 'O-1' },
    });
    const r = await handleShippingUpdateTrackingStatus(prisma, { shipmentId: 'SHP-1', status: 'Shipped' });
    expect(r.ok, 'handler 返回：' + JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toBe(true);
    expect(autoAdvanceSpy).toHaveBeenCalledTimes(1);
    expect(autoAdvanceSpy).toHaveBeenCalledWith('SHP-1', SYSTEM_AUDIT_ACTOR);
    expect(tx.claimDisposition.findMany).toHaveBeenCalledWith({ where: { replacementShipmentId: 'SHP-1' } });
    expect(tx.repairWorkOrder.findMany).toHaveBeenCalledWith({ where: { reshipmentId: 'SHP-1' } });
  });

  it('Booked→Loading：非 Shipped 不触发', async () => {
    const { prisma } = makePrisma({
      shipment: { id: 'SHP-1', status: 'Booked', orderId: 'O-1' },
    });
    const r = await handleShippingUpdateTrackingStatus(prisma, { shipmentId: 'SHP-1', status: 'Loading' });
    expect(r.ok, 'handler 返回：' + JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toBe(true);
    expect(autoAdvanceSpy).not.toHaveBeenCalled();
  });
});
