/**
 * traceabilityService 单测
 * 覆盖：7 大溯源场景（customerPanorama/orderFulfillment/quoteToShip/supplierPanorama/productCostChain/taxRefundChain/purchaseToStock）
 *      + trace 统一分派入口 + scope 行级权限 + NOT_FOUND 处理 + bigint 序列化
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── mock 依赖 ──
vi.mock('../../auth/permissionService', () => ({
  createPermissionService: vi.fn(() => ({
    getDataScopeResolver: vi.fn().mockResolvedValue({ rule: { kind: 'all' }, allowedDepartmentIds: [], allowedUserIds: [] }),
  })),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createTraceabilityService } from '../traceabilityService';

// ── helpers ──
function dec(v: number | string) {
  return { toString: () => String(v) };
}

const ACTOR = { userId: 'user_1', departmentIds: ['dept_1'], role: 'admin' } as any;

function makeRelation(overrides: any = {}) {
  return {
    id: 'REL__1',
    name: 'ACME Corp',
    code: 'CUS-00001',
    deletedAt: null,
    contacts: [],
    followUpRecords: [],
    opportunities: [],
    ...overrides,
  };
}

function makeOrder(overrides: any = {}) {
  return {
    id: 'ORD__1', code: 'SO-202608-001', status: 'Confirmed', type: 'fabric',
    product: 'Cotton Fabric', quoteAmount: dec(10000), dueDate: '2026-09-30',
    createdAt: '2026-08-01', deletedAt: null, lines: [],
    ...overrides,
  };
}

function makeQuotation(overrides: any = {}) {
  return {
    id: 'QUO__1', quotationNumber: 'QT-2026-0001', status: 'Accepted',
    totalAmount: dec(12000), currency: 'USD', issueDate: '2026-07-15',
    orderId: 'ORD__1', deletedAt: null, lines: [],
    ...overrides,
  };
}

function makeInvoice(overrides: any = {}) {
  return {
    id: 'INV__1', invoiceNumber: 'INV-2026-0001', type: 'Receivable', status: 'Issued',
    amount: dec(8000), currency: 'USD', issueDate: '2026-08-10', dueDate: '2026-09-10',
    customerRelationId: 'REL__1', orderId: 'ORD__1', deletedAt: null,
    ...overrides,
  };
}

function makePayment(overrides: any = {}) {
  return {
    id: 'PAY__1', voucherNumber: 'PAY-2026-0001', type: 'Receipt', status: 'Completed',
    amount: dec(5000), currency: 'USD', paymentDate: '2026-08-20',
    customerRelationId: 'REL__1', orderId: 'ORD__1', deletedAt: null,
    ...overrides,
  };
}

function makePrisma(overrides: any = {}) {
  return {
    relation: { findFirst: overrides.relationFindFirst ?? vi.fn().mockResolvedValue(makeRelation()) },
    order: { findMany: overrides.orderFindMany ?? vi.fn().mockResolvedValue([makeOrder()]), findFirst: vi.fn().mockResolvedValue(makeOrder()) },
    orderLine: { findMany: vi.fn().mockResolvedValue([]) },
    quotation: { findFirst: overrides.quotationFindFirst ?? vi.fn().mockResolvedValue(makeQuotation()), findMany: vi.fn().mockResolvedValue([makeQuotation()]) },
    invoice: { findMany: overrides.invoiceFindMany ?? vi.fn().mockResolvedValue([makeInvoice()]) },
    paymentVoucher: { findMany: overrides.paymentFindMany ?? vi.fn().mockResolvedValue([makePayment()]) },
    productionStage: { findMany: overrides.stageFindMany ?? vi.fn().mockResolvedValue([]) },
    inspectionReport: { findMany: overrides.inspectionFindMany ?? vi.fn().mockResolvedValue([]) },
    shipment: { findMany: overrides.shipmentFindMany ?? vi.fn().mockResolvedValue([]) },
    customsDeclaration: { findMany: overrides.customsFindMany ?? vi.fn().mockResolvedValue([]) },
    tradeDocument: { findMany: overrides.tradeDocFindMany ?? vi.fn().mockResolvedValue([]) },
    product: { findFirst: overrides.productFindFirst ?? vi.fn().mockResolvedValue(null) },
    bom: { findMany: vi.fn().mockResolvedValue([]) },
    factoryProfile: {},
    factoryEvaluation: { findMany: vi.fn().mockResolvedValue([]) },
    taxRefund: { findFirst: overrides.taxRefundFindFirst ?? vi.fn().mockResolvedValue(null) },
    // W-C A1 采购库存链
    purchaseOrder: {
      findFirst: overrides.poFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: overrides.poFindMany ?? vi.fn().mockResolvedValue([]),
    },
    materialReceipt: { findMany: overrides.receiptFindMany ?? vi.fn().mockResolvedValue([]) },
    stockMovement: { findMany: overrides.movementFindMany ?? vi.fn().mockResolvedValue([]) },
    inventoryItem: {
      findFirst: overrides.itemFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: overrides.itemFindMany ?? vi.fn().mockResolvedValue([]),
    },
  } as any;
}

beforeEach(() => { vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════
// customerPanorama 客户全景
// ═══════════════════════════════════════════════════════════════
describe('customerPanorama 客户全景', () => {
  it('成功聚合 Relation + Orders + Invoices + Payments + Quotations', async () => {
    const prisma = makePrisma();
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'customerPanorama', 'REL__1');
    expect(r.scenario).toBe('customerPanorama');
    expect(r.rootId).toBe('REL__1');
    expect(r.rootType).toBe('Relation');
    expect(r.nodes.length).toBeGreaterThan(0);
    // 节点类型至少包含 Relation/Order/Invoice/Payment/Quotation
    const types = r.nodes.map((n) => n.type);
    expect(types).toContain('Relation');
    expect(types).toContain('Order');
    expect(types).toContain('Invoice');
    expect(types).toContain('Payment');
    expect(types).toContain('Quotation');
    // edges 至少 4 条
    expect(r.edges.length).toBeGreaterThanOrEqual(4);
    // summary 字段
    expect(r.summary.orderCount).toBe(1);
    expect(r.summary.arTotal).toBe(8000);
    expect(r.summary.receiptTotal).toBe(5000);
    expect(r.summary.outstanding).toBe(3000);
    expect(r.summary.orderTotal).toBe(10000);
  });

  it('Relation 不存在 → 抛 NOT_FOUND', async () => {
    const prisma = makePrisma({ relationFindFirst: vi.fn().mockResolvedValue(null) });
    const svc = createTraceabilityService(prisma);
    await expect(svc.trace(ACTOR, 'customerPanorama', 'NOPE')).rejects.toThrow('NOT_FOUND');
  });

  it('无 actor → L2 门禁直接拒绝（v2.2：业务层 fail-closed，不触达数据查询）', async () => {
    const prisma = makePrisma({ relationFindFirst: vi.fn().mockResolvedValue(null) });
    const svc = createTraceabilityService(prisma);
    await expect(svc.trace(null, 'customerPanorama', 'REL__1')).rejects.toThrow('NOT_FOUND');
    // v2.2（DR-042 §5.1 L2）：无 actor → hasBizReadAccess false → 在 relation 查询前短路
    expect(prisma.relation.findFirst).not.toHaveBeenCalled();
  });

  it('contacts/followUpRecords/opportunities 被 include', async () => {
    const prisma = makePrisma({
      relationFindFirst: vi.fn().mockResolvedValue(makeRelation({
        contacts: [{ id: 'CON__1', isPrimary: true }],
        followUpRecords: [{ id: 'FU__1' }],
        opportunities: [{ id: 'OPP__1', stage: 'Proposal' }, { id: 'OPP__2', stage: 'Won' }],
      })),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'customerPanorama', 'REL__1');
    expect(r.summary.contactCount).toBe(1);
    expect(r.summary.activeOpportunityCount).toBe(1); // Won 不算 active
  });

  it('AR 计算：仅 type=Receivable 发票计入', async () => {
    const prisma = makePrisma({
      invoiceFindMany: vi.fn().mockResolvedValue([
        makeInvoice({ id: 'INV__1', type: 'Receivable', amount: dec(8000) }),
        makeInvoice({ id: 'INV__2', type: 'Payable', amount: dec(3000) }),
      ]),
      paymentFindMany: vi.fn().mockResolvedValue([
        makePayment({ id: 'PAY__1', type: 'Receipt', amount: dec(5000) }),
        makePayment({ id: 'PAY__2', type: 'Disbursement', amount: dec(2000) }),
      ]),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'customerPanorama', 'REL__1');
    expect(r.summary.arTotal).toBe(8000);
    expect(r.summary.receiptTotal).toBe(5000);
  });
});

// ═══════════════════════════════════════════════════════════════
// orderFulfillment 订单履约链
// ═══════════════════════════════════════════════════════════════
describe('orderFulfillment 订单履约链', () => {
  it('成功聚合 Order + Stages + Inspections + Shipments + Customs', async () => {
    const prisma = makePrisma({
      stageFindMany: vi.fn().mockResolvedValue([
        { id: 'STG__1', stageKey: 'weaving', status: 'completed', seq: 1, startedAt: '2026-08-01', completedAt: '2026-08-10', signedBy: 'u1' },
        { id: 'STG__2', stageKey: 'dyeing', status: 'in_progress', seq: 2, startedAt: '2026-08-11', completedAt: null, signedBy: 'u2' },
      ]),
      inspectionFindMany: vi.fn().mockResolvedValue([
        { id: 'INS__1', result: 'PASS', passRate: 98, defectRate: 2, inspector: 'u3', inspectedAt: '2026-08-12' },
      ]),
      shipmentFindMany: vi.fn().mockResolvedValue([
        { id: 'SHP__1', shipmentNumber: 'SHP-202608-001', status: 'Pending', shipDate: null, eta: null, carrier: null, trackingNo: null },
      ]),
      customsFindMany: vi.fn().mockResolvedValue([]),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'orderFulfillment', 'ORD__1');
    expect(r.rootType).toBe('Order');
    expect(r.summary.totalStages).toBe(2);
    expect(r.summary.completedStages).toBe(1);
    expect(r.summary.currentStage).toBe('dyeing');
    expect(r.summary.inspectionCount).toBe(1);
    expect(r.summary.lastInspectionResult).toBe('PASS');
    expect(r.summary.shipmentCount).toBe(1);
  });

  it('Order 不存在 → 抛 NOT_FOUND', async () => {
    const prisma = makePrisma();
    (prisma.order.findFirst as any) = vi.fn().mockResolvedValue(null);
    const svc = createTraceabilityService(prisma);
    await expect(svc.trace(ACTOR, 'orderFulfillment', 'NOPE')).rejects.toThrow('NOT_FOUND');
  });

  it('无生产阶段 → currentStage=N/A', async () => {
    const prisma = makePrisma({ stageFindMany: vi.fn().mockResolvedValue([]) });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'orderFulfillment', 'ORD__1');
    expect(r.summary.currentStage).toBe('N/A');
    expect(r.summary.totalStages).toBe(0);
  });

  it('bigint 字段被序列化为 number', async () => {
    const prisma = makePrisma({
      stageFindMany: vi.fn().mockResolvedValue([
        { id: 'STG__1', stageKey: 'x', status: 'completed', seq: 1, startedAt: null, completedAt: null, signedBy: null, updatedAt: BigInt(12345) },
      ]),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'orderFulfillment', 'ORD__1');
    const stageNode = r.nodes.find((n) => n.type === 'ProductionStage');
    expect(stageNode).toBeDefined();
    expect(typeof stageNode!.data.updatedAt).toBe('number');
  });
});

// ═══════════════════════════════════════════════════════════════
// quoteToShip 报价到发货链
// ═══════════════════════════════════════════════════════════════
describe('quoteToShip 报价到发货链', () => {
  it('成功聚合 Quotation + Order + Invoice + Shipment + TradeDoc', async () => {
    const prisma = makePrisma({
      quotationFindFirst: vi.fn().mockResolvedValue(makeQuotation()),
      orderFindMany: vi.fn().mockResolvedValue([makeOrder()]),
      invoiceFindMany: vi.fn().mockResolvedValue([makeInvoice()]),
      shipmentFindMany: vi.fn().mockResolvedValue([
        { id: 'SHP__1', shipmentNumber: 'SHP-1', status: 'Shipped', shipDate: '2026-09-01', eta: '2026-09-15', carrier: 'MSK', trackingNo: 'TRK-1' },
      ]),
      tradeDocFindMany: vi.fn().mockResolvedValue([
        { id: 'TD__1', docType: 'CommercialInvoice' },
        { id: 'TD__2', docType: 'PackingList' },
      ]),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'quoteToShip', 'QUO__1');
    expect(r.rootType).toBe('Quotation');
    expect(r.summary.quotationNumber).toBe('QT-2026-0001');
    expect(r.summary.totalAmount).toBe(12000);
    expect(r.summary.orderCount).toBe(1);
    expect(r.summary.invoiceCount).toBe(1);
    expect(r.summary.shipmentCount).toBe(1);
    expect(r.summary.documentCount).toBe(2);
    expect(r.summary.docTypes).toEqual(expect.arrayContaining(['CommercialInvoice', 'PackingList']));
  });

  it('Quotation 不存在 → 抛 NOT_FOUND', async () => {
    const prisma = makePrisma({ quotationFindFirst: vi.fn().mockResolvedValue(null) });
    const svc = createTraceabilityService(prisma);
    await expect(svc.trace(ACTOR, 'quoteToShip', 'NOPE')).rejects.toThrow('NOT_FOUND');
  });

  it('Quotation 无 orderId → 下游全部空', async () => {
    const prisma = makePrisma({
      quotationFindFirst: vi.fn().mockResolvedValue(makeQuotation({ orderId: null })),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'quoteToShip', 'QUO__1');
    expect(r.summary.orderCount).toBe(0);
    expect(r.summary.invoiceCount).toBe(0);
    expect(r.summary.shipmentCount).toBe(0);
    expect(r.summary.documentCount).toBe(0);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// supplierPanorama 供应商全景
// ═══════════════════════════════════════════════════════════════
describe('supplierPanorama 供应商全景', () => {
  it('成功聚合 Supplier + PO + Payable + Disbursement + Evaluation', async () => {
    const prisma = makePrisma({
      relationFindFirst: vi.fn().mockResolvedValue(makeRelation({
        id: 'REL__SUP1', name: 'Supplier A', factoryProfile: { id: 'FP__1' },
      })),
      orderFindMany: vi.fn().mockResolvedValue([makeOrder({ id: 'PO__1', code: 'PO-2026-0001' })]),
      invoiceFindMany: vi.fn().mockResolvedValue([
        makeInvoice({ id: 'INV__P1', type: 'Payable', amount: dec(6000) }),
      ]),
      paymentFindMany: vi.fn().mockResolvedValue([
        makePayment({ id: 'PAY__D1', type: 'Disbursement', amount: dec(4000) }),
      ]),
    });
    (prisma.factoryEvaluation as any) = { findMany: vi.fn().mockResolvedValue([{ id: 'EVAL__1', kind: 'monthly', score: 85 }]) };
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'supplierPanorama', 'REL__SUP1');
    expect(r.summary.supplierName).toBe('Supplier A');
    expect(r.summary.hasFactoryProfile).toBe(true);
    expect(r.summary.orderCount).toBe(1);
    expect(r.summary.apTotal).toBe(6000);
    expect(r.summary.paidTotal).toBe(4000);
    expect(r.summary.outstanding).toBe(2000);
    expect(r.summary.evaluationCount).toBe(1);
    expect(r.summary.avgScore).toBe(85);
  });

  it('Relation 不存在 → 抛 NOT_FOUND', async () => {
    const prisma = makePrisma({ relationFindFirst: vi.fn().mockResolvedValue(null) });
    const svc = createTraceabilityService(prisma);
    await expect(svc.trace(ACTOR, 'supplierPanorama', 'NOPE')).rejects.toThrow('NOT_FOUND');
  });

  it('无 factoryProfile → 不查 Evaluation', async () => {
    const prisma = makePrisma({
      relationFindFirst: vi.fn().mockResolvedValue(makeRelation({ factoryProfile: null })),
    });
    (prisma.factoryEvaluation as any) = { findMany: vi.fn() };
    const svc = createTraceabilityService(prisma);
    await svc.trace(ACTOR, 'supplierPanorama', 'REL__1');
    expect((prisma.factoryEvaluation as any).findMany).not.toHaveBeenCalled();
  });

  it('无 Evaluation → avgScore=null', async () => {
    const prisma = makePrisma({
      relationFindFirst: vi.fn().mockResolvedValue(makeRelation({ factoryProfile: { id: 'FP__1' } })),
    });
    (prisma.factoryEvaluation as any) = { findMany: vi.fn().mockResolvedValue([]) };
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'supplierPanorama', 'REL__1');
    expect(r.summary.evaluationCount).toBe(0);
    expect(r.summary.avgScore).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// productCostChain 产品成本链
// ═══════════════════════════════════════════════════════════════
describe('productCostChain 产品成本链', () => {
  it('成功聚合 Product + BOM + Quotation + Order', async () => {
    const prisma = makePrisma({
      productFindFirst: vi.fn().mockResolvedValue({ id: 'PROD__1', name: 'Cotton Twill', sku: 'FAB-001', deletedAt: null }),
      quotationFindMany: undefined, // 用 findMany 默认
    });
    (prisma.bom as any) = { findMany: vi.fn().mockResolvedValue([
      { id: 'BOM__1', version: 1, totalCost: dec(50), deletedAt: null, lines: [] },
    ]) };
    prisma.quotation.findMany = vi.fn().mockResolvedValue([makeQuotation({ id: 'QUO__1', productId: 'PROD__1' })]);
    prisma.order.findMany = vi.fn().mockResolvedValue([makeOrder({ id: 'ORD__1', productId: 'PROD__1', quoteAmount: dec(10000) })]);
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'productCostChain', 'PROD__1');
    expect(r.rootType).toBe('Product');
    expect(r.summary.productName).toBe('Cotton Twill');
    expect(r.summary.productSku).toBe('FAB-001');
    expect(r.summary.bomCount).toBe(1);
    expect(r.summary.latestBomCost).toBe(50);
    expect(r.summary.quotationCount).toBe(1);
    expect(r.summary.orderCount).toBe(1);
    expect(r.summary.totalOrderValue).toBe(10000);
  });

  it('Product 不存在 → 抛 NOT_FOUND', async () => {
    const prisma = makePrisma({ productFindFirst: vi.fn().mockResolvedValue(null) });
    const svc = createTraceabilityService(prisma);
    await expect(svc.trace(ACTOR, 'productCostChain', 'NOPE')).rejects.toThrow('NOT_FOUND');
  });

  it('无 BOM → latestBomCost=null', async () => {
    const prisma = makePrisma({
      productFindFirst: vi.fn().mockResolvedValue({ id: 'P1', name: 'X', sku: 'S', deletedAt: null }),
    });
    (prisma.bom as any) = { findMany: vi.fn().mockResolvedValue([]) };
    prisma.quotation.findMany = vi.fn().mockResolvedValue([]);
    prisma.order.findMany = vi.fn().mockResolvedValue([]);
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'productCostChain', 'P1');
    expect(r.summary.bomCount).toBe(0);
    expect(r.summary.latestBomCost).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// taxRefundChain 退税链
// ═══════════════════════════════════════════════════════════════
describe('taxRefundChain 退税链', () => {
  it('成功聚合 TaxRefund + Customs + Invoice + Payment', async () => {
    const prisma = makePrisma({
      taxRefundFindFirst: vi.fn().mockResolvedValue({
        id: 'TR__1', refundNumber: 'TR-2026-0001', status: 'Processing',
        refundAmount: dec(1500), customsDeclarationId: 'CD__1', orderId: 'ORD__1', deletedAt: null,
      }),
      customsFindMany: vi.fn().mockResolvedValue([
        { id: 'CD__1', declarationNumber: 'CD-202608-001', status: 'Released', customsType: 'export' },
      ]),
      invoiceFindMany: vi.fn().mockResolvedValue([makeInvoice({ type: 'Receivable' })]),
      paymentFindMany: vi.fn().mockResolvedValue([makePayment({ type: 'Receipt', amount: dec(8000) })]),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'taxRefundChain', 'TR__1');
    expect(r.rootType).toBe('TaxRefund');
    expect(r.summary.refundNumber).toBe('TR-2026-0001');
    expect(r.summary.refundStatus).toBe('Processing');
    expect(r.summary.refundAmount).toBe(1500);
    expect(r.summary.customsStatus).toBe('Released');
    expect(r.summary.invoiceCount).toBe(1);
    expect(r.summary.receiptCount).toBe(1);
    expect(r.summary.receiptTotal).toBe(8000);
  });

  it('TaxRefund 不存在 → 抛 NOT_FOUND', async () => {
    const prisma = makePrisma({ taxRefundFindFirst: vi.fn().mockResolvedValue(null) });
    const svc = createTraceabilityService(prisma);
    await expect(svc.trace(ACTOR, 'taxRefundChain', 'NOPE')).rejects.toThrow('NOT_FOUND');
  });

  it('无 customsDeclarationId → customs 空', async () => {
    const prisma = makePrisma({
      taxRefundFindFirst: vi.fn().mockResolvedValue({
        id: 'TR__1', refundNumber: 'TR-1', status: 'Draft', refundAmount: dec(0),
        customsDeclarationId: null, orderId: 'ORD__1', deletedAt: null,
      }),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'taxRefundChain', 'TR__1');
    expect(r.summary.customsStatus).toBe('N/A');
  });

  it('无 orderId → invoice/payment 空', async () => {
    const prisma = makePrisma({
      taxRefundFindFirst: vi.fn().mockResolvedValue({
        id: 'TR__1', refundNumber: 'TR-1', status: 'Draft', refundAmount: dec(0),
        customsDeclarationId: null, orderId: null, deletedAt: null,
      }),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'taxRefundChain', 'TR__1');
    expect(r.summary.invoiceCount).toBe(0);
    expect(r.summary.receiptCount).toBe(0);
    expect(r.summary.receiptTotal).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// purchaseToStock 采购库存链（W-C A1 · S2 三击追溯铁律）
// 链路口径：PO → MaterialReceipt(purchaseOrderId)
//          → StockMovement(referenceType='PurchaseOrder', referenceId=receipt.id)
//          → InventoryItem(itemId)；root 兼容采购单/库存物料双入口
// ═══════════════════════════════════════════════════════════════
function makePurchaseOrder(overrides: any = {}) {
  return {
    id: 'PO__1', poNumber: 'PO-20260806-001', status: 'PartiallyReceived',
    supplierName: 'Panda Mill', deletedAt: null,
    ...overrides,
  };
}

function makeReceipt(overrides: any = {}) {
  return {
    id: 'MR__1', receiptNumber: 'RPT-001', purchaseOrderId: 'PO__1',
    status: 'Accepted', totalAccepted: dec(100), createdAt: 1724000000000,
    ...overrides,
  };
}

function makeMovement(overrides: any = {}) {
  return {
    id: 'SM__1', movementNumber: 'SM-20260810-AB12', type: 'Inbound',
    itemId: 'INV__1', warehouseId: 'WH__1',
    referenceType: 'PurchaseOrder', referenceId: 'MR__1',
    quantity: dec(100), createdAt: 1724000000000,
    ...overrides,
  };
}

function makeItem(overrides: any = {}) {
  return {
    id: 'INV__1', description: '主面料', materialCode: 'FAB-001',
    quantity: dec(100), deletedAt: null,
    ...overrides,
  };
}

describe('purchaseToStock 采购库存链', () => {
  it('采购单入口：PO → 收货 → 库存变动 → 库存物料 全链聚合', async () => {
    const prisma = makePrisma({
      poFindFirst: vi.fn().mockResolvedValue(makePurchaseOrder()),
      receiptFindMany: vi.fn().mockResolvedValue([makeReceipt()]),
      movementFindMany: vi.fn().mockResolvedValue([makeMovement()]),
      itemFindMany: vi.fn().mockResolvedValue([makeItem()]),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'purchaseToStock', 'PO__1');

    expect(r.scenario).toBe('purchaseToStock');
    expect(r.rootId).toBe('PO__1');
    expect(r.rootType).toBe('PurchaseOrder');
    const types = r.nodes.map((n) => n.type);
    expect(types).toContain('PurchaseOrder');
    expect(types).toContain('MaterialReceipt');
    expect(types).toContain('StockMovement');
    expect(types).toContain('InventoryItem');
    // 边：PO→收货、收货→变动、变动→物料
    expect(r.edges).toEqual(expect.arrayContaining([
      { from: 'PO__1', to: 'MR__1', relation: 'has_receipt' },
      { from: 'MR__1', to: 'SM__1', relation: 'has_stock_movement' },
      { from: 'SM__1', to: 'INV__1', relation: 'moves_item' },
    ]));
    // Native MaterialReceipt and historical PurchaseOrder receipt references.
    expect(prisma.stockMovement.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { referenceType: { in: ['MaterialReceipt', 'PurchaseOrder'] }, referenceId: { in: ['MR__1'] } },
    }));
    expect(r.summary.poNumber).toBe('PO-20260806-001');
    expect(r.summary.receiptCount).toBe(1);
    expect(r.summary.totalAccepted).toBe(100);
    expect(r.summary.movementCount).toBe(1);
    expect(r.summary.itemCount).toBe(1);
  });

  it('库存物料入口：物料 → 库存变动 → 收货 → 采购单 反向三击', async () => {
    const prisma = makePrisma({
      poFindFirst: vi.fn().mockResolvedValue(null), // rootId 不是 PO
      itemFindFirst: vi.fn().mockResolvedValue(makeItem()),
      movementFindMany: vi.fn().mockResolvedValue([makeMovement()]),
      receiptFindMany: vi.fn().mockResolvedValue([makeReceipt()]),
      poFindMany: vi.fn().mockResolvedValue([makePurchaseOrder()]),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'purchaseToStock', 'INV__1');

    expect(r.rootType).toBe('InventoryItem');
    const types = r.nodes.map((n) => n.type);
    expect(types).toContain('InventoryItem');
    expect(types).toContain('StockMovement');
    expect(types).toContain('MaterialReceipt');
    expect(types).toContain('PurchaseOrder');
    expect(r.edges).toEqual(expect.arrayContaining([
      { from: 'SM__1', to: 'INV__1', relation: 'moves_item' },
      { from: 'MR__1', to: 'SM__1', relation: 'has_stock_movement' },
      { from: 'PO__1', to: 'MR__1', relation: 'has_receipt' },
    ]));
    expect(r.summary.movementCount).toBe(1);
    expect(r.summary.receiptCount).toBe(1);
    expect(r.summary.poCount).toBe(1);
    expect(r.summary.currentQty).toBe(100);
  });

  it('rootId 既非采购单也非库存物料 → 抛 NOT_FOUND', async () => {
    const prisma = makePrisma({
      poFindFirst: vi.fn().mockResolvedValue(null),
      itemFindFirst: vi.fn().mockResolvedValue(null),
    });
    const svc = createTraceabilityService(prisma);
    await expect(svc.trace(ACTOR, 'purchaseToStock', 'NOPE')).rejects.toThrow('NOT_FOUND');
  });

  it('采购单无收货记录 → 仅 PO 节点，不查库存变动', async () => {
    const prisma = makePrisma({
      poFindFirst: vi.fn().mockResolvedValue(makePurchaseOrder()),
      receiptFindMany: vi.fn().mockResolvedValue([]),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'purchaseToStock', 'PO__1');
    expect(r.nodes).toHaveLength(1);
    expect(r.summary.receiptCount).toBe(0);
    expect(r.summary.movementCount).toBe(0);
    expect(prisma.stockMovement.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryItem.findMany).not.toHaveBeenCalled();
  });

  it('库存物料的手工变动（referenceType=Manual）不回溯收货链', async () => {
    const prisma = makePrisma({
      poFindFirst: vi.fn().mockResolvedValue(null),
      itemFindFirst: vi.fn().mockResolvedValue(makeItem()),
      movementFindMany: vi.fn().mockResolvedValue([
        makeMovement({ id: 'SM__M1', referenceType: 'Manual', referenceId: null }),
      ]),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'purchaseToStock', 'INV__1');
    expect(r.summary.receiptCount).toBe(0);
    expect(r.summary.poCount).toBe(0);
    expect(prisma.materialReceipt.findMany).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.findMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// trace 统一分派入口
// ═══════════════════════════════════════════════════════════════
describe('trace 统一分派入口', () => {
  it('未知 scenario → 抛 UNKNOWN_SCENARIO', async () => {
    const prisma = makePrisma();
    const svc = createTraceabilityService(prisma);
    await expect(svc.trace(ACTOR, 'unknown_scenario' as any, 'X')).rejects.toThrow(/UNKNOWN_SCENARIO/);
  });

  it('customerPanorama → 调用 customerPanorama 函数', async () => {
    const prisma = makePrisma();
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'customerPanorama', 'REL__1');
    expect(r.scenario).toBe('customerPanorama');
  });

  it('orderFulfillment → 调用 orderFulfillment 函数', async () => {
    const prisma = makePrisma();
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'orderFulfillment', 'ORD__1');
    expect(r.scenario).toBe('orderFulfillment');
  });

  it('logger.info 记录调用', async () => {
    const prisma = makePrisma();
    const svc = createTraceabilityService(prisma);
    await svc.trace(ACTOR, 'customerPanorama', 'REL__1');
    const { logger } = await import('../../lib/logger');
    expect((logger as any).info).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// bigint 序列化（ser 函数）
// ═══════════════════════════════════════════════════════════════
describe('bigint 序列化', () => {
  it('node.data 中 bigint 字段转为 number', async () => {
    const prisma = makePrisma({
      relationFindFirst: vi.fn().mockResolvedValue(makeRelation({ updatedAt: BigInt(99999) })),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'customerPanorama', 'REL__1');
    const relNode = r.nodes.find((n) => n.type === 'Relation');
    expect(relNode).toBeDefined();
    expect(typeof relNode!.data.updatedAt).toBe('number');
    expect(relNode!.data.updatedAt).toBe(99999);
  });

  it('_isBigNumber 字段转为 number', async () => {
    const prisma = makePrisma({
      relationFindFirst: vi.fn().mockResolvedValue(makeRelation({
        amount: { _isBigNumber: true, toString: () => '12345' },
      })),
    });
    const svc = createTraceabilityService(prisma);
    const r = await svc.trace(ACTOR, 'customerPanorama', 'REL__1');
    const relNode = r.nodes.find((n) => n.type === 'Relation');
    expect(relNode!.data.amount).toBe(12345);
  });
});
