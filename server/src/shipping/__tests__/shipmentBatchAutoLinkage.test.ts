/**
 * W-B 断层④挂接点接线回归 — Shipment→Shipped 各路径自动推进批次的接线断言
 *
 * 与 orderShipmentBatchService.test.ts 的分工：
 *   - 该文件测联动执行体（autoAdvanceOnShipmentShipped）的行为语义；
 *   - 本文件测「挂接点是否接线」——createShipment / updateShipment 到达 Shipped 时
 *     必须调用联动（Agent 两条路径的接线断言见 agent/__tests__/toolRuntimeBatchLinkage.test.ts）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const autoAdvanceSpy = vi.hoisted(() => vi.fn().mockResolvedValue({ advanced: [], failed: [] }));

vi.mock('../orderShipmentBatchService', () => ({
  createOrderShipmentBatchService: vi.fn(() => ({ autoAdvanceOnShipmentShipped: autoAdvanceSpy })),
}));
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../entities/sync', () => ({
  syncShipmentReferences: vi.fn().mockResolvedValue(undefined),
  deactivateEntityLinks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../orderLinkService', () => ({
  linkOrderStatusFromShipment: vi.fn().mockResolvedValue({ ok: true, skipped: true }),
}));
vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: vi.fn().mockResolvedValue('AUDIT__TEST'),
  // ★ D5：updateShipment 现在还会逐字段留痕（改期/换船/改港），必须一并 mock。
  //   ⓘ 模块 mock 缺导出时 `writeFieldAuditDiff(...)` 会**同步抛 TypeError**
  //     （`.catch()` 还没接上就炸了）⇒ 表现为「updateShipment 返回 ok:false」，
  //     看起来像业务坏了。**修 mock，不要给业务代码加兜底**。
  writeFieldAuditDiff: vi.fn().mockResolvedValue(['AUDIT__FIELD__TEST']),
}));
vi.mock('../../events/businessEventBus', () => ({
  publishBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../shipmentPackingService', () => ({
  mapOrderLinesToShipmentLineInputs: vi.fn(() => []),
  replaceShipmentLinesTx: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../shipmentEligibilityGate', () => ({
  evaluateShipmentReleaseGate: vi.fn().mockResolvedValue({ ok: true, data: { orders: [] } }),
}));

import { createShipment, updateShipment } from '../shipmentMutationService';

/** tx mock：Shipment 存一行 Booked，可按需种子化 */
function makePrisma(seed: { shipment?: any } = {}) {
  let shipmentRow = seed.shipment ?? null;
  const tx: any = {
    // Original legacy source: real source/parent locking helpers run against
    // empty actual batch/release/sample tables, without approval substitutes.
    $queryRaw: vi.fn(async () => []),
    sample: { findMany: vi.fn(async () => []) },
    releaseScope: { findMany: vi.fn(async () => []) },
    productionBatch: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    shipmentProductionAllocation: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    // Complete source-detection seam: these original cases are ordinary shipments.
    claimDisposition: { findMany: async () => [] },
    repairWorkOrder: { findMany: async () => [] },
    shipment: {
      findUnique: async () => shipmentRow,
      create: async ({ data }: any) => { shipmentRow = { ...data }; return shipmentRow; },
      update: async ({ where, data }: any) => { shipmentRow = { ...shipmentRow, ...data, id: where.id }; return shipmentRow; },
      findMany: async () => [], // ★ 2026-09-29 晚：短装门禁问"该行还有没有未发运的票"
    },
    /**
     * ★★ 2026-09-29 晚：**出运数量完整性门禁**（使用方口径：不知道数量就不该能确认出运）。
     * 本组用例要把票推到 Shipped ⇒ 必须有一条**已填实际量**的明细，否则会被
     * 409 `SHIPMENT_NO_ALLOCATION_DETAIL` 拦住（那是刻意的，另有专门用例覆盖）。
     */
    shipmentOrderAllocation: {
      findMany: async () => [{ orderLineId: 'L1', shipmentId: 'SHP-1', actualQty: 1000 }],
    },
    shipmentLine: { findMany: async () => [] }, // T3 H9 出运扣库存：空装运行 → 跳过留痕
    stockMovement: { findFirst: async () => null, findMany: async () => [], create: async () => ({}) },
    shipmentEvent: { create: async ({ data }: any) => ({ ...data }) },
    orderLine: {
      findMany: async () => [],
      // 短装/数量门禁：本行 1000 米全发 ⇒ 落出厂默认 1000–3000 档（±3%）也不短装
      findUnique: async () => ({
        id: 'L1', orderId: 'O-1', itemNo: '001', unit: null, quantity: 1000,
        shipmentQuantity: 1000, tolerancePercent: null, toleranceSource: null,
      }),
    },
    systemConfig: { findUnique: async () => null }, // ⇒ 落出厂默认
    relation: { findUnique: async () => null },
    order: { findUnique: async () => ({ businessLine: 'fabric', customerRelationId: null }) }, // T2/D8-Q3: createShipment 品类派生查订单
  };
  const prisma: any = { $transaction: async (fn: any) => fn(tx) };
  return { prisma, tx };
}

beforeEach(() => { vi.clearAllMocks(); autoAdvanceSpy.mockResolvedValue({ advanced: [], failed: [] }); });

describe('updateShipment 挂接点', () => {
  it('Booked→Shipped：触发批次自动联动（shipmentId + actorId 透传）', async () => {
    const { prisma } = makePrisma({
      shipment: { id: 'SHP-1', status: 'Booked', shipmentNumber: 'SH-2026-0001', orderId: 'O-1', deletedAt: null },
    });
    const r = await updateShipment({
      prisma, shipmentId: 'SHP-1', patch: { status: 'Shipped', atd: '2026-10-07' }, hasStatus: true, actorId: 'actor-1',
    });
    expect(r.ok).toBe(true);
    expect(autoAdvanceSpy).toHaveBeenCalledTimes(1);
    expect(autoAdvanceSpy).toHaveBeenCalledWith('SHP-1', 'actor-1');
  });

  it('Booked→Loading：非 Shipped 不触发', async () => {
    const { prisma } = makePrisma({
      shipment: { id: 'SHP-1', status: 'Booked', shipmentNumber: 'SH-2026-0001', orderId: 'O-1', deletedAt: null },
    });
    const r = await updateShipment({
      prisma, shipmentId: 'SHP-1', patch: { status: 'Loading' }, hasStatus: true, actorId: 'actor-1',
    });
    expect(r.ok).toBe(true);
    expect(autoAdvanceSpy).not.toHaveBeenCalled();
  });

  it('Shipped→Arrived：历史到港状态不能从当前 MVP 流程写入', async () => {
    const { prisma } = makePrisma({
      shipment: { id: 'SHP-1', status: 'Shipped', shipmentNumber: 'SH-2026-0001', orderId: 'O-1', deletedAt: null },
    });
    const r = await updateShipment({
      prisma, shipmentId: 'SHP-1', patch: { status: 'Arrived' }, hasStatus: true, actorId: 'actor-1',
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_TRANSITION');
    expect(autoAdvanceSpy).not.toHaveBeenCalled();
  });
});

describe('createShipment 挂接点（补录场景直建 Shipped）', () => {
  it('直建 Shipped：触发批次自动联动', async () => {
    const { prisma } = makePrisma();
    const r = await createShipment({
      prisma,
      input: { orderId: 'O-1', status: 'Shipped', atd: '2026-10-07', shipmentNumber: 'SH-2026-0002', type: 'FCL', shippingMethod: 'Sea' },
      actorId: 'actor-1',
    });
    expect(r.ok).toBe(true);
    expect(autoAdvanceSpy).toHaveBeenCalledTimes(1);
    expect(autoAdvanceSpy.mock.calls[0][1]).toBe('actor-1');
    expect(typeof autoAdvanceSpy.mock.calls[0][0]).toBe('string'); // 服务端生成的 shipmentId
  });

  it('默认 Booked 创建：不触发', async () => {
    const { prisma } = makePrisma();
    const r = await createShipment({
      prisma,
      input: { orderId: 'O-1', shipmentNumber: 'SH-2026-0003', type: 'FCL', shippingMethod: 'Sea' },
      actorId: 'actor-1',
    });
    expect(r.ok).toBe(true);
    expect(autoAdvanceSpy).not.toHaveBeenCalled();
  });
});
