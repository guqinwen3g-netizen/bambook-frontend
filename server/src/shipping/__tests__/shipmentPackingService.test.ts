/**
 * C4 发货深化 — 装箱明细服务（行级 + 逐箱级）单元测试
 *
 * 覆盖口径：
 *   1. 行级整组替换：校验（负数量/非整数箱数）、编辑窗口（Shipped 锁定 409 语义）
 *   2. 汇总派生：有箱 → 箱级合计；无箱有行 → 行级合计；皆无 → 不动
 *   3. 逐箱装箱：箱号必填、分配引用本运单行、累计分配 ≤ 行数量、体积推导（L×W×H÷1e6）
 *   4. 行移除级联清理箱内分配
 *   5. OrderLine → ShipmentLineInput 预填映射
 *   6. 运输方式统计：分组 / 在途 / 准点率 / 区间过滤
 */

import { describe, expect, it } from 'vitest';
import { storageReader, storageRowLocks, storageWhere } from './shippingSourceStorageFixture';
import {
  replaceShipmentLines,
  replaceShipmentCartons,
  pullLinesFromOrder,
  mapOrderLinesToShipmentLineInputs,
} from '../shipmentPackingService';
import { getMethodStats } from '../shipmentStatsService';

// ────────────────────────────────────────────────────────────────
// 内存 mock prisma（$transaction 透传同一 store）
// ────────────────────────────────────────────────────────────────

function makeStore() {
  return {
    shipment: null as any,
    lines: [] as any[],
    cartons: [] as any[],
    cartonItems: [] as any[],
    order: null as any,
    auditLogs: [] as any[],
    allocations: [] as any[], physicalAllocations: [] as any[], productionBatches: [] as any[],
    releaseScopes: [] as any[], samples: [] as any[], locks: [] as any[],
    // P1-3 专属面料校验依赖的产品档案侧数据（默认空 = 无专属规则命中）
    fabricCustomerCodes: [] as any[],
    fabricProfiles: [] as any[],
    productAssets: [] as any[],
    relations: [] as any[],
  };
}

function makePrisma(store: ReturnType<typeof makeStore>) {
  let seq = 0;
  const nextId = (p: string) => `${p}_mock_${++seq}`;

  const tx: any = {
    shipmentOrderAllocation: storageReader(() => store.allocations),
    shipmentProductionAllocation: storageReader(() => store.physicalAllocations),
    productionBatch: storageReader(() => store.productionBatches),
    releaseScope: storageReader(() => store.releaseScopes),
    sample: storageReader(() => store.samples),
    // Complete source-detection seam: these original cases are ordinary shipments.
    claimDisposition: { findMany: async () => [] },
    repairWorkOrder: { findMany: async () => [] },
    shipment: {
      findUnique: async ({ where, select }: any) => {
        if (!store.shipment || store.shipment.id !== where.id) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) out[k] = store.shipment[k];
          return out;
        }
        return store.shipment;
      },
      update: async ({ where, data }: any) => {
        if (store.shipment?.id === where.id) Object.assign(store.shipment, data);
        return store.shipment;
      },
    },
    shipmentLine: {
      findMany: async ({ where, select }: any) => {
        const rows = store.lines.filter((l) => l.shipmentId === where.shipmentId);
        if (select) return rows.map((r) => ({ id: r.id }));
        return rows;
      },
      deleteMany: async ({ where }: any) => {
        store.lines = store.lines.filter((l) => l.shipmentId !== where.shipmentId);
      },
      create: async ({ data }: any) => {
        const row = { ...data, id: data.id ?? nextId('SHPL') };
        store.lines.push(row);
        return row;
      },
    },
    shipmentCarton: {
      findMany: async ({ where }: any) => store.cartons.filter((c) => c.shipmentId === where.shipmentId),
      deleteMany: async ({ where }: any) => {
        const removed = store.cartons.filter((c) => c.shipmentId === where.shipmentId).map((c) => c.id);
        store.cartons = store.cartons.filter((c) => c.shipmentId !== where.shipmentId);
        store.cartonItems = store.cartonItems.filter((i) => !removed.includes(i.cartonId));
      },
      create: async ({ data }: any) => {
        const row = { ...data, id: data.id ?? nextId('SHPC') };
        store.cartons.push(row);
        return row;
      },
    },
    shipmentCartonItem: {
      deleteMany: async ({ where }: any) => {
        store.cartonItems = store.cartonItems.filter((i) => !where.shipmentLineId.in.includes(i.shipmentLineId));
      },
      create: async ({ data }: any) => {
        const row = { ...data, id: data.id ?? nextId('SHPCI') };
        store.cartonItems.push(row);
        return row;
      },
    },
    order: {
      findUnique: async ({ where }: any) => (store.order?.id === where.id ? store.order : null),
    },
    orderLine: {
      findMany: async ({ where }: any) =>
        (store.order?.lines ?? []).map((l: any) => ({ orderId: store.order.id, ...l })).filter((l: any) => storageWhere(l, where)),
    },
    relation: storageReader(() => store.relations),
    // P1-3 专属面料校验：产品档案侧模型（clientCode 精确匹配 + productAssetId 反查）
    fabricCustomerCode: {
      findMany: async ({ where }: any) => {
        let rows = store.fabricCustomerCodes.filter((c) => c.deletedAt == null);
        if (where?.clientCode !== undefined) rows = rows.filter((c) => c.clientCode === where.clientCode);
        if (where?.productAssetId?.in) rows = rows.filter((c) => where.productAssetId.in.includes(c.productAssetId));
        if (where?.isExclusive !== undefined) rows = rows.filter((c) => c.isExclusive === where.isExclusive);
        if (Array.isArray(where?.OR)) {
          rows = rows.filter((c) => (where.OR as any[]).some((sub: any) =>
            sub.customerOrganizationId === null ? c.customerOrganizationId == null : sub.customerOrganizationId === c.customerOrganizationId));
        }
        return rows;
      },
    },
    fabricProfile: {
      findMany: async () => store.fabricProfiles,
    },
    productAsset: {
      findUnique: async ({ where }: any) => store.productAssets.find(a => storageWhere(a, where)) ?? null,
      findMany: async ({ where }: any) =>
        store.productAssets.filter((a) => (where?.id?.in ? where.id.in.includes(a.id) : true)),
    },
    auditLog: {
      create: async ({ data }: any) => {
        store.auditLogs.push(data);
        return data;
      },
    },
  };
  tx.$queryRaw = storageRowLocks({ Shipment: () => store.shipment ? [store.shipment] : [],
    Order: () => store.order ? [store.order] : [], OrderLine: () => store.order?.lines ?? [],
    ReleaseScope: () => store.releaseScopes, ProductionBatch: () => store.productionBatches,
    ShipmentOrderAllocation: () => store.allocations, ShipmentProductionAllocation: () => store.physicalAllocations }, store.locks);
  // Original transparent transaction seam: audit assertions prove an attempt,
  // not persistence after a PostgreSQL rollback.
  tx.$transaction = async (fn: any) => fn(tx);
  return tx;
}

function draftShipment(over: any = {}) {
  return { id: 'SH1', status: 'Draft', deletedAt: null, orderId: null, updatedAt: 10n, totalPackages: null, grossWeight: null, netWeight: null, volume: null, ...over };
}

// ────────────────────────────────────────────────────────────────
// 行级整组替换
// ────────────────────────────────────────────────────────────────

describe('shipmentPackingService · 行级整组替换', () => {
  it('Draft 运单替换装运行成功，行号自增，写审计日志', async () => {
    const store = makeStore();
    store.shipment = draftShipment();
    const prisma = makePrisma(store);

    const result = await replaceShipmentLines(prisma, 'SH1', [
      { productCode: 'F-001', productName: '全棉府绸', quantity: 1000.5, unit: 'm', cartons: 10, grossWeight: 120, netWeight: 110, volume: 1.2 },
      { productCode: 'F-002', productName: '涤纶斜纹', quantity: 500, unit: 'yd' },
    ], 'tester');

    expect(result.ok).toBe(true);
    expect(store.lines).toHaveLength(2);
    expect(store.lines[0].lineNumber).toBe(1);
    expect(store.lines[1].lineNumber).toBe(2);
    expect(Number(store.lines[0].quantity)).toBe(1000.5); // Decimal 精度
    expect(store.auditLogs.some((a) => a.action === 'PACKING_LINES_REPLACE')).toBe(true);
  });

  it('无箱有行时运单汇总由行级派生（箱数/毛净体合计）', async () => {
    const store = makeStore();
    store.shipment = draftShipment();
    const prisma = makePrisma(store);

    await replaceShipmentLines(prisma, 'SH1', [
      { productName: 'A', quantity: 100, cartons: 3, grossWeight: 30.5, netWeight: 28, volume: 0.6 },
      { productName: 'B', quantity: 200, cartons: 2, grossWeight: 20, netWeight: 18, volume: 0.4 },
    ], 'tester');

    expect(store.shipment.totalPackages).toBe(5);
    expect(Number(store.shipment.grossWeight)).toBeCloseTo(50.5);
    expect(Number(store.shipment.netWeight)).toBeCloseTo(46);
    expect(Number(store.shipment.volume)).toBeCloseTo(1.0);
  });

  it('Shipped 状态锁定：INVALID_CURRENT_STATUS', async () => {
    const store = makeStore();
    store.shipment = draftShipment({ status: 'Shipped' });
    const prisma = makePrisma(store);

    const result = await replaceShipmentLines(prisma, 'SH1', [{ productName: 'A' }], 'tester');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_CURRENT_STATUS');
  });

  it('负数量 / 非整数箱数被拒绝', async () => {
    const store = makeStore();
    store.shipment = draftShipment();
    const prisma = makePrisma(store);

    const neg = await replaceShipmentLines(prisma, 'SH1', [{ productName: 'A', quantity: -1 }], 'tester');
    expect(neg.error?.code).toBe('VALIDATION_FAILED');

    const badCartons = await replaceShipmentLines(prisma, 'SH1', [{ productName: 'A', cartons: 1.5 }], 'tester');
    expect(badCartons.error?.code).toBe('VALIDATION_FAILED');
  });

  it('行被移除时级联清理引用它的箱内分配', async () => {
    const store = makeStore();
    store.shipment = draftShipment();
    const prisma = makePrisma(store);

    // 先建两行 + 一箱分配引用 line1
    await replaceShipmentLines(prisma, 'SH1', [{ productName: 'A', quantity: 100 }, { productName: 'B', quantity: 50 }], 'tester');
    const line1 = store.lines[0];
    store.cartonItems.push({ id: 'CI1', cartonId: 'C1', shipmentLineId: line1.id, quantity: 10 });

    // 整组替换为空：旧行删除 → 箱内分配级联清理
    const result = await replaceShipmentLines(prisma, 'SH1', [], 'tester');
    expect(result.ok).toBe(true);
    expect(store.lines).toHaveLength(0);
    expect(store.cartonItems).toHaveLength(0);
  });

  it('运单不存在返回 NOT_FOUND', async () => {
    const store = makeStore();
    const prisma = makePrisma(store);
    const result = await replaceShipmentLines(prisma, 'NOPE', [], 'tester');
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

// ────────────────────────────────────────────────────────────────
// 逐箱装箱
// ────────────────────────────────────────────────────────────────

describe('shipmentPackingService · 逐箱装箱', () => {
  async function seedTwoLines() {
    const store = makeStore();
    store.shipment = draftShipment();
    const prisma = makePrisma(store);
    await replaceShipmentLines(prisma, 'SH1', [
      { productName: 'A', quantity: 100, unit: 'm' },
      { productName: 'B', quantity: 50, unit: 'm' },
    ], 'tester');
    return { store, prisma };
  }

  it('混装分配成功；有箱时运单汇总由箱级派生', async () => {
    const { store, prisma } = await seedTwoLines();
    const [lineA, lineB] = store.lines;

    const result = await replaceShipmentCartons(prisma, 'SH1', [
      {
        cartonNo: '1', grossWeight: 30, netWeight: 28, length: 60, width: 40, height: 50,
        items: [
          { shipmentLineId: lineA.id, quantity: 60 },
          { shipmentLineId: lineB.id, quantity: 20 },
        ],
      },
      { cartonNo: '2', grossWeight: 20, netWeight: 18, volume: 0.08, items: [{ shipmentLineId: lineA.id, quantity: 40 }] },
    ], 'tester');

    expect(result.ok).toBe(true);
    expect(store.cartons).toHaveLength(2);
    expect(store.cartonItems).toHaveLength(3);
    // 体积推导：60×40×50 cm³ = 0.12 CBM
    expect(Number(store.cartons[0].volume)).toBeCloseTo(0.12);
    // 汇总由箱级派生（覆盖行级）
    expect(store.shipment.totalPackages).toBe(2);
    expect(Number(store.shipment.grossWeight)).toBeCloseTo(50);
    expect(Number(store.shipment.volume)).toBeCloseTo(0.2);
  });

  it('累计分配超过行数量被拒绝', async () => {
    const { store, prisma } = await seedTwoLines();
    const lineA = store.lines[0];

    const result = await replaceShipmentCartons(prisma, 'SH1', [
      { cartonNo: '1', items: [{ shipmentLineId: lineA.id, quantity: 80 }] },
      { cartonNo: '2', items: [{ shipmentLineId: lineA.id, quantity: 30 }] }, // 80+30=110 > 100
    ], 'tester');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(result.error?.message).toContain('超过行数量');
  });

  it('分配引用不属于本运单的行被拒绝', async () => {
    const { prisma } = await seedTwoLines();
    const result = await replaceShipmentCartons(prisma, 'SH1', [
      { cartonNo: '1', items: [{ shipmentLineId: 'FOREIGN_LINE', quantity: 10 }] },
    ], 'tester');
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(result.error?.message).toContain('不属于本运单');
  });

  it('箱号必填 / 分配数量必须为正', async () => {
    const { store, prisma } = await seedTwoLines();
    const lineA = store.lines[0];

    const noNo = await replaceShipmentCartons(prisma, 'SH1', [{ cartonNo: '  ', items: [] }], 'tester');
    expect(noNo.error?.code).toBe('VALIDATION_FAILED');

    const zeroQty = await replaceShipmentCartons(prisma, 'SH1', [
      { cartonNo: '1', items: [{ shipmentLineId: lineA.id, quantity: 0 }] },
    ], 'tester');
    expect(zeroQty.error?.code).toBe('VALIDATION_FAILED');
  });

  it('整组替换幂等：同输入两次结果一致', async () => {
    const { store, prisma } = await seedTwoLines();
    const lineA = store.lines[0];
    const input = [{ cartonNo: '1', grossWeight: 10, items: [{ shipmentLineId: lineA.id, quantity: 10 }] }];

    await replaceShipmentCartons(prisma, 'SH1', input, 'tester');
    await replaceShipmentCartons(prisma, 'SH1', input, 'tester');
    expect(store.cartons).toHaveLength(1);
    expect(store.cartonItems).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// 从订单预填
// ────────────────────────────────────────────────────────────────

describe('shipmentPackingService · 从订单带出装运行', () => {
  it('OrderLine 映射：materialCode/description/quantity/unit', () => {
    const inputs = mapOrderLinesToShipmentLineInputs([
      { id: 'OL1', materialCode: 'MC-1', itemNo: 'IT-1', description: '全棉府绸', quantity: 1000, unit: 'm' },
      { id: 'OL2', materialCode: null, itemNo: 'IT-2', description: '涤纶斜纹', quantity: 500.25, unit: 'yd' },
    ]);
    expect(inputs[0]).toMatchObject({ orderLineId: 'OL1', productCode: 'MC-1', productName: '全棉府绸', quantity: '1000', unit: 'm' });
    expect(inputs[1].productCode).toBe('IT-2'); // materialCode 缺省回退 itemNo
  });

  it('pull-from-order：运单关联订单时带出行', async () => {
    const store = makeStore();
    store.shipment = draftShipment({ orderId: 'O1' });
    store.order = {
      id: 'O1', deletedAt: null,
      lines: [{ id: 'OL1', materialCode: 'MC-1', itemNo: null, description: '全棉府绸', quantity: 800, unit: 'm', lineNumber: 1 }],
    };
    const prisma = makePrisma(store);

    const result = await pullLinesFromOrder(prisma, 'SH1', 'tester');
    expect(result.ok).toBe(true);
    expect(store.lines).toHaveLength(1);
    expect(store.lines[0].orderLineId).toBe('OL1');
  });

  it('P1-3 专属面料：装运行引用他人独占面料 → EXCLUSIVE_FABRIC_BLOCKED（fail-closed）', async () => {
    const store = makeStore();
    store.shipment = draftShipment({ orderId: 'O1', customerRelationId: 'REL-B', customerName: '客户B' });
    store.order = {
      id: 'O1', deletedAt: null,
      lines: [{ id: 'OL1', materialCode: 'A-100', itemNo: null, description: '独家开发面料 X', quantity: 800, unit: 'm', lineNumber: 1 }],
    };
    // 面料 X 为客户 A 独占（客供品号 A-100）
    store.relations = ['REL-A', 'REL-B'].map(id => ({ id, category: 'Customer', isOrganization: true, deletedAt: null }));
    store.productAssets = [{ id: 'PA__X', sku: 'FAB-X', name: '独家开发面料 X', deletedAt: null }];
    store.fabricCustomerCodes = [{
      id: 'FCC-1', productAssetId: 'PA__X', clientCode: 'A-100',
      customerOrganizationId: 'REL-A', customerNameSnapshot: '客户A', isExclusive: true, deletedAt: null,
    }];
    const prisma = makePrisma(store);

    const result = await pullLinesFromOrder(prisma, 'SH1', 'tester');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('EXCLUSIVE_FABRIC_BLOCKED');
    expect(result.error?.message).toContain('客户A');
    // 违规尝试已留痕
    expect(store.auditLogs.some((log: any) => log.action === 'exclusive_fabric_violation_attempt')).toBe(true);
  });

  it('P1-3 专属面料：属主客户运单 → 放行带出', async () => {
    const store = makeStore();
    store.shipment = draftShipment({ orderId: 'O1', customerRelationId: 'REL-A', customerName: '客户A' });
    store.order = {
      id: 'O1', deletedAt: null,
      lines: [{ id: 'OL1', materialCode: 'A-100', itemNo: null, description: '独家开发面料 X', quantity: 800, unit: 'm', lineNumber: 1 }],
    };
    store.relations = ['REL-A', 'REL-B'].map(id => ({ id, category: 'Customer', isOrganization: true, deletedAt: null }));
    store.productAssets = [{ id: 'PA__X', sku: 'FAB-X', name: '独家开发面料 X', deletedAt: null }];
    store.fabricCustomerCodes = [{
      id: 'FCC-1', productAssetId: 'PA__X', clientCode: 'A-100',
      customerOrganizationId: 'REL-A', customerNameSnapshot: '客户A', isExclusive: true, deletedAt: null,
    }];
    const prisma = makePrisma(store);

    const result = await pullLinesFromOrder(prisma, 'SH1', 'tester');
    expect(result.ok).toBe(true);
    expect(store.lines).toHaveLength(1);
  });

  it.each(['missing', 'deleted', 'not-customer', 'not-organization'] as const)('an equal owner ID cannot authorize exclusive packing when the customer relation is %s', async invalid => {
    const store = makeStore();
    store.shipment = draftShipment({ orderId: 'O1', customerRelationId: 'REL-A', customerName: '客户A' });
    store.order = { id: 'O1', deletedAt: null, lines: [{ id: 'OL1', materialCode: 'A-100', description: '独家面料', quantity: 1, unit: 'm', lineNumber: 1 }] };
    store.productAssets = [{ id: 'PA-X', sku: 'FAB-X', name: '独家面料', deletedAt: null }];
    store.fabricCustomerCodes = [{ id: 'FCC-1', productAssetId: 'PA-X', clientCode: 'A-100', customerOrganizationId: 'REL-A', customerNameSnapshot: '客户A', isExclusive: true, deletedAt: null }];
    store.relations = invalid === 'missing' ? [] : [{ id: 'REL-A', category: invalid === 'not-customer' ? 'Supplier' : 'Customer', isOrganization: invalid !== 'not-organization', deletedAt: invalid === 'deleted' ? 1n : null }];
    const result = await pullLinesFromOrder(makePrisma(store), 'SH1', 'tester');
    expect(result.ok).toBe(false); expect(result.error?.code).toBe('EXCLUSIVE_FABRIC_BLOCKED');
    expect(store.lines).toEqual([]); expect(store.cartons).toEqual([]); expect(store.cartonItems).toEqual([]);
    expect(store.auditLogs.some((log: any) => log.action === 'exclusive_fabric_violation_attempt')).toBe(true);
  });

  it('未关联订单 / 订单不存在分别报 VALIDATION_FAILED / ORDER_NOT_FOUND', async () => {
    const store = makeStore();
    store.shipment = draftShipment({ orderId: null });
    const prisma = makePrisma(store);

    const noOrder = await pullLinesFromOrder(prisma, 'SH1', 'tester');
    expect(noOrder.error?.code).toBe('VALIDATION_FAILED');

    store.shipment = draftShipment({ orderId: 'GONE' });
    const missing = await pullLinesFromOrder(prisma, 'SH1', 'tester');
    expect(missing.error?.code).toBe('ORDER_NOT_FOUND');
  });
});

// ────────────────────────────────────────────────────────────────
// 运输方式统计
// ────────────────────────────────────────────────────────────────

describe('shipmentStatsService · 运输方式统计', () => {
  function statsPrisma(shipments: any[]) {
    return { shipment: { findMany: async () => shipments } } as any;
  }

  it('按方式分组：在途/已交付/取消归类，准点率 ata≤eta', async () => {
    const stats = await getMethodStats(statsPrisma([
      { shippingMethod: 'Sea', status: 'Shipped', eta: null, ata: null, etd: '2026-08-01' },
      { shippingMethod: 'Sea', status: 'Delivered', eta: '2026-08-10', ata: '2026-08-09', etd: '2026-07-20' },
      { shippingMethod: 'Sea', status: 'Delivered', eta: '2026-08-10', ata: '2026-08-12', etd: '2026-07-21' },
      { shippingMethod: 'Air', status: 'Delivered', eta: '2026-08-05', ata: '2026-08-05', etd: '2026-08-01' },
      { shippingMethod: null, status: 'Cancelled', eta: null, ata: null, etd: '2026-08-02' },
    ]), {});

    expect(stats.methods).toHaveLength(3);
    const sea = stats.methods.find((m) => m.method === 'Sea')!;
    expect(sea.total).toBe(3);
    expect(sea.inTransit).toBe(1);
    expect(sea.delivered).toBe(2);
    expect(sea.judged).toBe(2);
    expect(sea.onTime).toBe(1);
    expect(sea.onTimeRate).toBe(0.5);

    const air = stats.methods.find((m) => m.method === 'Air')!;
    expect(air.onTimeRate).toBe(1);

    const unknown = stats.methods.find((m) => m.method === 'Unknown')!;
    expect(unknown.cancelled).toBe(1);
    expect(unknown.onTimeRate).toBeNull(); // 无可判定样本
  });

  it('区间过滤按 etd（缺省回退 ata）；无日期运单在带区间时排除', async () => {
    const stats = await getMethodStats(statsPrisma([
      { shippingMethod: 'Sea', status: 'Shipped', eta: null, ata: null, etd: '2026-08-15' },
      { shippingMethod: 'Sea', status: 'Shipped', eta: null, ata: null, etd: '2026-09-02' },
      { shippingMethod: 'Air', status: 'Shipped', eta: null, ata: null, etd: null },
    ]), { from: '2026-08-01', to: '2026-08-31' });

    expect(stats.methods).toHaveLength(1);
    expect(stats.methods[0].method).toBe('Sea');
    expect(stats.methods[0].total).toBe(1);
  });
});


describe('Packing original storage with current physical sources', () => {
  it('an active source cannot use an untrusted scalar actor to replace lines or cartons', async () => {
    const store = makeStore(); store.shipment = draftShipment({ orderId: 'O1' });
    store.order = { id: 'O1', lines: [] };
    store.lines = [{ id: 'L1', shipmentId: 'SH1', quantity: '3' }];
    const prisma = makePrisma(store);
    expect((await replaceShipmentLines(prisma, 'SH1', [{ quantity: '3' }], 'tester')).ok).toBe(true);
    const before = store.lines.map(row => ({ ...row })), auditCount = store.auditLogs.length;
    store.productionBatches.push({ id: 'PB1', orderId: 'O1', orderLineId: 'OL1', state: 'active' });
    const lines = await replaceShipmentLines(prisma, 'SH1', [{ quantity: '5' }], 'tester');
    const cartons = await replaceShipmentCartons(prisma, 'SH1', [{ cartonNo: 'C1', items: [] }], 'tester');
    expect(lines.ok).toBe(false); expect(lines.error?.code).toBe('UNAUTHORIZED');
    expect(cartons.ok).toBe(false); expect(cartons.error?.code).toBe('UNAUTHORIZED');
    expect(store.lines).toEqual(before); expect(store.cartons).toEqual([]); expect(store.auditLogs).toHaveLength(auditCount);
    expect(store.locks.some(row => row.table === 'ProductionBatch' && row.rows.includes('PB1'))).toBe(true);
  });
  it('a source query failure rejects before line deletion or a packing audit', async () => {
    const store = makeStore(); store.shipment = draftShipment();
    store.lines = [{ id: 'L1', shipmentId: 'SH1', quantity: '3' }];
    const prisma = makePrisma(store), fault = new Error('physical-query-failed');
    prisma.shipmentProductionAllocation.findMany = async () => { throw fault; };
    const result = await replaceShipmentLines(prisma, 'SH1', [], 'tester');
    expect(result.ok).toBe(false); expect(result.error?.code).toBe('SAVE_FAILED');
    expect(store.lines).toEqual([{ id: 'L1', shipmentId: 'SH1', quantity: '3' }]); expect(store.auditLogs).toEqual([]);
  });
});
