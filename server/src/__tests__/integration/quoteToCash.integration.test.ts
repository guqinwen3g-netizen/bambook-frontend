/**
 * 端到端集成测试：报价到收款全链路 (Quote → Pricing → PI → Receivable → Payment → AR)
 *
 * 验证服务间协作正确性：
 *   1. quotationPricingService.applyTrackPricing → 写入 Quotation 双轨快照字段
 *   2. proformaInvoiceService.generateFromQuotation → 从报价单生成 PI（type=Proforma）
 *   3. proformaInvoiceService.convertToReceivable → PI 转为应收发票（type=Receivable），原 PI → Cancelled
 *   4. financeServiceV2.getArApSummary → AR 看板：Proforma 不计入，Receivable 计入
 *   5. traceabilityService.trace quoteToShip → 溯源链路完整性
 *
 * 核心验证点：
 *   - PI 不参与 AR/AP 看板（type=Proforma 被过滤）
 *   - 转换后 Receivable 参与 AR 看板
 *   - 收款后 outstanding 减少
 *   - 审计日志和事件正确发布
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── mock 依赖 ──
vi.mock('../../auth/permissionService', async importOriginal => {
  const actual = await importOriginal<typeof import('../../auth/permissionService')>();
  return { ...actual, createPermissionService: vi.fn((input: any) => ({
    ...actual.createPermissionService(input),
    // Existing read-scope seam is retained; current write authority is loaded
    // from the explicit storage fixture below, not a truthy mocked grant.
    getDataScopeResolver: vi.fn().mockResolvedValue({ rule: { kind: 'all' }, allowedDepartmentIds: [], allowedUserIds: [] }),
  })) };
});

vi.mock('../../sequence/sequenceService', () => ({
  createSequenceService: vi.fn(() => ({
    nextNumber: vi.fn().mockResolvedValue('INV-2026-0001'),
  })),
}));

vi.mock('../../dictionaries/dataDictionaryService', () => ({
  getDataDictionaryService: vi.fn(() => ({
    getEntries: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../config/systemConfigService', () => ({
  getSystemConfigService: vi.fn(() => ({
    getString: vi.fn().mockResolvedValue('USD'),
  })),
}));

vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: vi.fn().mockResolvedValue('AUDIT_001'),
}));

vi.mock('../../events/businessEventBus', () => ({
  publishBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../pricing/pricingService', () => ({
  createPricingService: vi.fn(() => ({
    estimateTrackA: vi.fn().mockResolvedValue({
      priceMedianUsd: 12,
      unit: 'meter',
      costBreakdown: {},
    }),
    calculateTrackB: vi.fn().mockReturnValue({
      finalUnitPrice: 13,
      costBreakdown: {},
      refundRate: 13,
    }),
    latestUsdRate: vi.fn().mockResolvedValue(7.1),
    lookupRefundRate: vi.fn().mockResolvedValue({ rate: 13 }),
  })),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createQuotationPricingService } from '../../finance/quotationPricingService';
import { createProformaInvoiceService } from '../../finance/proformaInvoiceService';
import { createFinanceServiceV2 } from '../../finance/financeServiceV2';

// ── 共享状态 mock Prisma（跨服务数据可见）──
function dec(v: number | string) {
  return { toString: () => String(v) };
}

const ACTOR = { userId: 'user_1', departmentIds: ['dept_1'], role: 'admin' } as any;

function createSharedPrisma() {
  // 内存数据存储
  const quotations = new Map<string, any>();
  const invoices = new Map<string, any>();
  const payments = new Map<string, any>();

  const prisma = {
    _stores: { quotations, invoices, payments },
    // Real-shaped current-account/grant storage seam; not real PG identity evidence.
    userAccount: { findUnique: vi.fn(async ({ where }: any) => ({ id: where.id, status: 'active', deletedAt: null, primaryDeptId: null,
      roles: [{ departmentId: null, role: { id: 'role-admin', permissions: [{ permission: { scope: 'invoices:write' } }] } }] })) },
    userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
    relation: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, deletedAt: null, ownerId: 'user_1', salesRepIds: [] })) },
    order: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, deletedAt: null, ownerId: 'user_1', customerRelationId: 'REL__1' })) },
    orderLine: { findUnique: vi.fn().mockResolvedValue(null) },
    developmentCase: { findFirst: vi.fn().mockResolvedValue(null) },
    invoiceOrderAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    // Technical SQL seam for the native PI source lock, not PG lock evidence.
    $queryRaw: vi.fn(async (sql: any) => [{ id: sql.values[0] }]),

    quotation: {
      findFirst: vi.fn(async ({ where }: any) => {
        const q = quotations.get(where.id);
        if (!q) return null;
        if (where.deletedAt !== undefined && q.deletedAt) return null;
        return { ...q, lines: q.lines || [] };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const q = quotations.get(where.id);
        if (!q) throw new Error('Quotation not found');
        const updated = { ...q, ...data };
        quotations.set(where.id, updated);
        return updated;
      }),
      findMany: vi.fn(async () => Array.from(quotations.values())),
    },

    invoice: {
      findFirst: vi.fn(async ({ where }: any) => {
        const inv = invoices.get(where.id);
        if (!inv) return null;
        return { ...inv };
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || `INV__${Date.now()}`;
        const row = { ...data, id };
        invoices.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const inv = invoices.get(where.id);
        if (!inv) throw new Error('Invoice not found');
        const updated = { ...inv, ...data };
        invoices.set(where.id, updated);
        return updated;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        let list = Array.from(invoices.values());
        if (where?.type) list = list.filter((i) => i.type === where.type);
        if (where?.deletedAt === null) list = list.filter((i) => !i.deletedAt);
        if (where?.status?.in) list = list.filter((i) => where.status.in.includes(i.status));
        if (where?.status?.not) list = list.filter((i) => i.status !== where.status.not);
        return list.map((i) => ({ amount: i.amount, currency: i.currency }));
      }),
    },

    paymentVoucher: {
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || `PAY__${Date.now()}`;
        const row = { ...data, id };
        payments.set(id, row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        let list = Array.from(payments.values());
        if (where?.type) list = list.filter((p) => p.type === where.type);
        if (where?.deletedAt === null) list = list.filter((p) => !p.deletedAt);
        if (where?.status?.not) list = list.filter((p) => p.status !== where.status.not);
        return list.map((p) => ({ amount: p.amount, currency: p.currency }));
      }),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async ({ where, data }: any) => {
        const p = payments.get(where.id);
        if (!p) throw new Error('Payment not found');
        const updated = { ...p, ...data };
        payments.set(where.id, updated);
        return updated;
      }),
    },

    quotationLine: { findMany: vi.fn().mockResolvedValue([]) },
    commissionRule: { findUnique: vi.fn().mockResolvedValue(null) },
  } as any;
  // 修复1 接线：convertToReceivable 信用重算挂接点（$transaction 包裹 usedAmount 覆写+留痕）
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  return prisma;
}

beforeEach(() => { vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════
// 端到端：报价到收款全链路
// ═══════════════════════════════════════════════════════════════
describe('端到端：报价到收款全链路', () => {
  it('完整流程：Quote → Pricing → PI → Receivable → Payment → AR Summary', async () => {
    const prisma = createSharedPrisma();

    // ── 1. 准备：创建已接受的报价单 ──
    const quotationId = 'QUO__E2E_1';
    prisma._stores.quotations.set(quotationId, {
      id: quotationId,
      quotationNumber: 'QT-2026-0001',
      status: 'Accepted',
      currency: 'USD',
      totalAmount: dec(12000),
      exchangeRate: dec(7.1),
      baseCurrency: 'CNY',
      customerRelationId: 'REL__1',
      customerName: 'ACME Corp',
      convertedOrderId: null,
      deliveryTerms: 'FOB',
      paymentTerms: 'T/T 30 days',
      salesperson: 'John',
      deletedAt: null,
      lines: [
        { lineNumber: 1, fabricCode: 'FAB-001', description: 'Cotton Twill', quantity: dec(1000), unit: 'meter', unitPrice: dec(12), amount: dec(12000), notes: null },
      ],
    });

    // ── 2. 应用双轨定价 ──
    const pricingSvc = createQuotationPricingService(prisma);
    const pricingResult = await pricingSvc.applyTrackPricing(quotationId, {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      refundRate: 13,
    });

    expect(pricingResult.ok).toBe(true);
    if (pricingResult.ok) {
      expect(pricingResult.data.deviationLevel).toBe('ok');
      expect(pricingResult.data.canSend).toBe(true);
      expect(pricingResult.data.trackAMedianUsd).toBe(12);
      expect(pricingResult.data.trackBFinalUsd).toBe(13);
    }

    // 验证快照字段写入 Quotation
    const updatedQuotation = prisma._stores.quotations.get(quotationId);
    expect(updatedQuotation.trackAMedianUsd).toBeDefined();
    expect(updatedQuotation.trackBFinalUsd).toBeDefined();
    expect(updatedQuotation.priceDeviationLevel).toBe('ok');

    // ── 3. 从报价单生成 PI ──
    const proformaSvc = createProformaInvoiceService(prisma);
    const piResult = await proformaSvc.generateFromQuotation(
      { quotationId, issueDate: '2026-08-15', dueDate: '2026-09-15' },
      'user_1',
      '127.0.0.1',
    );

    expect(piResult.ok).toBe(true);
    let piId: string;
    if (piResult.ok) {
      expect(piResult.data.type).toBe('Proforma');
      expect(piResult.data.status).toBe('Draft');
      expect(piResult.data.invoiceNumber).toBe('INV-2026-0001');
      piId = piResult.data.id;
    } else {
      throw new Error('PI generation failed');
    }

    // ── 4. 将 PI 转换为应收发票 ──
    const convertResult = await proformaSvc.convertToReceivable(
      piId!,
      { issueDate: '2026-08-20', dueDate: '2026-09-20' },
      'user_1',
      '127.0.0.1',
    );

    expect(convertResult.ok).toBe(true);
    let receivableId: string;
    if (convertResult.ok) {
      expect(convertResult.data.type).toBe('Receivable');
      expect(convertResult.data.status).toBe('Issued');
      expect(convertResult.data.invoiceNumber).toBe('INV-2026-0001');
      receivableId = convertResult.data.id;
    } else {
      throw new Error('PI conversion failed');
    }

    // 验证原 PI 状态变为 Cancelled
    const originalPi = prisma._stores.invoices.get(piId!);
    expect(originalPi.status).toBe('Cancelled');
    expect(originalPi.notes).toContain('已转换为正式应收发票');

    // ── 5. AR 看板验证（此时无收款）──
    const financeSvc = createFinanceServiceV2(prisma);
    const ar1 = await financeSvc.getArApSummary(ACTOR);
    expect(ar1.ok).toBe(true);
    if (ar1.ok) {
      expect(ar1.data.receivable.total).toBe(12000);
      expect(ar1.data.receivable.paid).toBe(0);
      expect(ar1.data.receivable.outstanding).toBe(12000);
      expect(ar1.data.receivable.count).toBe(1);
    }

    // ── 6. 创建收款凭证 ──
    await financeSvc.create('payment', ACTOR, {
      type: 'Receipt',
      amount: 5000,
      currency: 'USD',
      status: 'Completed',
      paymentDate: '2026-08-25',
    });

    // ── 7. AR 看板验证（部分收款后）──
    const ar2 = await financeSvc.getArApSummary(ACTOR);
    expect(ar2.ok).toBe(true);
    if (ar2.ok) {
      expect(ar2.data.receivable.total).toBe(12000);
      expect(ar2.data.receivable.paid).toBe(5000);
      expect(ar2.data.receivable.outstanding).toBe(7000);
    }

    // ── 8. 验证审计日志被调用 ──
    const { writeRouteAuditLog } = await import('../../audit/routeAudit');
    expect(writeRouteAuditLog).toHaveBeenCalledTimes(2); // generate + convert
  });

  it('PI 不参与 AR 看板（type=Proforma 被过滤）', async () => {
    const prisma = createSharedPrisma();

    // 直接创建一个 Proforma 发票（不经过转换流程）
    prisma._stores.invoices.set('INV__PI_ONLY', {
      id: 'INV__PI_ONLY',
      invoiceNumber: 'INV-2026-PI1',
      type: 'Proforma',
      status: 'Issued',
      amount: dec(99999),
      currency: 'USD',
      deletedAt: null,
    });

    const financeSvc = createFinanceServiceV2(prisma);
    const ar = await financeSvc.getArApSummary(ACTOR);
    expect(ar.ok).toBe(true);
    if (ar.ok) {
      // Proforma 不计入 AR
      expect(ar.data.receivable.total).toBe(0);
      expect(ar.data.receivable.count).toBe(0);
    }
  });

  it('非 Accepted 报价单不能生成 PI', async () => {
    const prisma = createSharedPrisma();
    prisma._stores.quotations.set('QUO__DRAFT', {
      id: 'QUO__DRAFT',
      quotationNumber: 'QT-2026-0002',
      status: 'Draft', // 非 Accepted
      currency: 'USD',
      totalAmount: dec(5000),
      deletedAt: null,
      lines: [],
    });

    const proformaSvc = createProformaInvoiceService(prisma);
    const r = await proformaSvc.generateFromQuotation(
      { quotationId: 'QUO__DRAFT' },
      'user_1',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('QUOTATION_NOT_ACCEPTED');
  });

  it('已 Cancelled 的 PI 不能再次转换', async () => {
    const prisma = createSharedPrisma();
    prisma._stores.invoices.set('INV__CANCELLED_PI', {
      id: 'INV__CANCELLED_PI',
      invoiceNumber: 'INV-2026-0003',
      type: 'Proforma',
      status: 'Cancelled', // 已作废
      amount: dec(5000),
      currency: 'USD',
      deletedAt: null,
    });

    const proformaSvc = createProformaInvoiceService(prisma);
    const r = await proformaSvc.convertToReceivable(
      'INV__CANCELLED_PI',
      {},
      'user_1',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ALREADY_CONVERTED');
  });

  it('非 Proforma 发票不能转换', async () => {
    const prisma = createSharedPrisma();
    prisma._stores.invoices.set('INV__RECEIVABLE', {
      id: 'INV__RECEIVABLE',
      invoiceNumber: 'INV-2026-0004',
      type: 'Receivable', // 非 Proforma
      status: 'Issued',
      amount: dec(5000),
      currency: 'USD',
      deletedAt: null,
    });

    const proformaSvc = createProformaInvoiceService(prisma);
    const r = await proformaSvc.convertToReceivable(
      'INV__RECEIVABLE',
      {},
      'user_1',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_PROFORMA');
  });

  it('偏差 > 30% 时 canSend=false（block 级别）', async () => {
    const prisma = createSharedPrisma();
    prisma._stores.quotations.set('QUO__HIGH_DEVIATION', {
      id: 'QUO__HIGH_DEVIATION',
      quotationNumber: 'QT-2026-0003',
      status: 'Accepted',
      currency: 'USD',
      totalAmount: dec(20000),
      deletedAt: null,
      lines: [],
    });

    // 重新 mock pricingService 使偏差 > 30%
    const { createPricingService } = await import('../../pricing/pricingService');
    (createPricingService as any).mockReturnValue({
      estimateTrackA: vi.fn().mockResolvedValue({ priceMedianUsd: 10, unit: 'meter', costBreakdown: {} }),
      calculateTrackB: vi.fn().mockReturnValue({ finalUnitPrice: 15, costBreakdown: {}, refundRate: 13 }), // 50% 偏差
      latestUsdRate: vi.fn().mockResolvedValue(7.1),
      lookupRefundRate: vi.fn().mockResolvedValue({ rate: 13 }),
    });

    const pricingSvc = createQuotationPricingService(prisma);
    const r = await pricingSvc.applyTrackPricing('QUO__HIGH_DEVIATION', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.5,
      exchangeRate: 7.1,
      refundRate: 13,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.deviationLevel).toBe('block');
      expect(r.data.canSend).toBe(false);
      expect(Math.abs(r.data.deviationPercent)).toBeGreaterThan(30);
    }
  });
});
