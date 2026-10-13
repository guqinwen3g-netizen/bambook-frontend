/**
 * quotationPricingService 单测
 * 覆盖：applyTrackPricing 校验链 / Track A-B 桥接 / 偏差分级（ok/warn/block）/
 *       快照写入 / getPricingCheck 门禁读取
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── mock createPricingService（桥接层依赖）──
vi.mock('../../pricing/pricingService', () => ({
  createPricingService: vi.fn(() => ({
    estimateTrackA: vi.fn(),
    calculateTrackB: vi.fn(),
    latestUsdRate: vi.fn(),
    lookupRefundRate: vi.fn(),
  })),
}));

import { createQuotationPricingService } from '../quotationPricingService';
import { createPricingService } from '../../pricing/pricingService';

// ── helpers ──
function dec(v: number | string) {
  return { toString: () => String(v) };
}

function makeQuotation(overrides: any = {}) {
  return {
    id: 'QUO__1',
    quotationNumber: 'QUO-2026-0001',
    currency: 'USD',
    exchangeRate: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeTrackAResult(overrides: any = {}) {
  return {
    priceLowUsd: 10,
    priceMedianUsd: 12,
    priceHighUsd: 14,
    unit: 'YD',
    breakdown: {},
    ...overrides,
  };
}

function makeTrackBResult(overrides: any = {}) {
  return {
    finalUnitPrice: 13,
    costBreakdown: {},
    ...overrides,
  };
}

function makePrisma(overrides: {
  quotation?: any;
  commissionRule?: any;
  pricingServiceOverrides?: Record<string, any>;
} = {}) {
  const quotationData = overrides.quotation === undefined ? makeQuotation() : overrides.quotation;
  const pricingSvcMock = {
    estimateTrackA: vi.fn().mockResolvedValue(makeTrackAResult()),
    calculateTrackB: vi.fn().mockReturnValue(makeTrackBResult()),
    latestUsdRate: vi.fn().mockResolvedValue(7.1),
    lookupRefundRate: vi.fn().mockResolvedValue({ rate: 13 }),
    ...overrides.pricingServiceOverrides,
  };
  (createPricingService as any).mockReturnValue(pricingSvcMock);

  const prisma = {
    quotation: {
      findFirst: vi.fn().mockResolvedValue(quotationData),
      update: vi.fn().mockResolvedValue({}),
    },
    commissionRule: {
      findUnique: vi.fn().mockResolvedValue(overrides.commissionRule ?? null),
    },
  } as any;
  return { prisma, pricingSvcMock };
}

beforeEach(() => { vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════
// applyTrackPricing
// ═══════════════════════════════════════════════════════════════

describe('applyTrackPricing 输入校验', () => {
  it('报价单不存在 → NOT_FOUND', async () => {
    const { prisma } = makePrisma({ quotation: null });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('NOPE', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('汇率缺失且无最新 USD 汇率 → EXCHANGE_RATE_MISSING', async () => {
    const { prisma, pricingSvcMock } = makePrisma({
      pricingServiceOverrides: { latestUsdRate: vi.fn().mockResolvedValue(null) },
    });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      // no exchangeRate, no hsCode → will fail at refundRate first? No, exchangeRate resolved first
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('EXCHANGE_RATE_MISSING');
  });
});

describe('applyTrackPricing 退税率解析', () => {
  it('退税率缺失且无 HS Code → PRICING_FAILED', async () => {
    const { prisma } = makePrisma();
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      // no refundRate, no hsCode
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PRICING_FAILED');
    expect(r.error!.message).toContain('HS Code');
  });

  it('HS Code 无退税率映射 → PRICING_FAILED', async () => {
    const { prisma, pricingSvcMock } = makePrisma({
      pricingServiceOverrides: { lookupRefundRate: vi.fn().mockResolvedValue(null) },
    });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      hsCode: '5208110000',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PRICING_FAILED');
    expect(r.error!.message).toContain('5208110000');
  });
});

describe('applyTrackPricing 佣金规则校验', () => {
  it('佣金规则不存在 → PRICING_FAILED', async () => {
    const { prisma } = makePrisma({ commissionRule: null });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      refundRate: 13,
      commissionRuleId: 'COM__1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PRICING_FAILED');
    expect(r.error!.message).toContain('佣金规则');
  });

  it('佣金规则已停用 → PRICING_FAILED', async () => {
    const { prisma } = makePrisma({
      commissionRule: { id: 'COM__1', rate: dec(0.05), isActive: false, deletedAt: null },
    });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      refundRate: 13,
      commissionRuleId: 'COM__1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PRICING_FAILED');
  });

  it('佣金规则已删除 → PRICING_FAILED', async () => {
    const { prisma } = makePrisma({
      commissionRule: { id: 'COM__1', rate: dec(0.05), isActive: true, deletedAt: '2026-01-01' },
    });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      refundRate: 13,
      commissionRuleId: 'COM__1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PRICING_FAILED');
  });
});

describe('applyTrackPricing 偏差分级', () => {
  it('偏差 < 15% → ok，canSend=true', async () => {
    // TrackA median=12, TrackB final=13 → deviation = (13-12)/12*100 = 8.33% → ok
    const { prisma, pricingSvcMock } = makePrisma({
      pricingServiceOverrides: {
        estimateTrackA: vi.fn().mockResolvedValue(makeTrackAResult({ priceMedianUsd: 12 })),
        calculateTrackB: vi.fn().mockReturnValue(makeTrackBResult({ finalUnitPrice: 13 })),
      },
    });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      refundRate: 13,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.deviationLevel).toBe('ok');
      expect(r.data.canSend).toBe(true);
      expect(r.data.deviationPercent).toBeCloseTo(8.3333, 1);
    }
  });

  it('偏差 = 15% → warn，canSend=true', async () => {
    // TrackA median=10, TrackB final=11.5 → deviation = 15% → warn
    const { prisma } = makePrisma({
      pricingServiceOverrides: {
        estimateTrackA: vi.fn().mockResolvedValue(makeTrackAResult({ priceMedianUsd: 10 })),
        calculateTrackB: vi.fn().mockReturnValue(makeTrackBResult({ finalUnitPrice: 11.5 })),
      },
    });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      refundRate: 13,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.deviationLevel).toBe('warn');
      expect(r.data.canSend).toBe(true);
    }
  });

  it('偏差 > 30% → block，canSend=false', async () => {
    // TrackA median=10, TrackB final=15 → deviation = 50% → block
    const { prisma } = makePrisma({
      pricingServiceOverrides: {
        estimateTrackA: vi.fn().mockResolvedValue(makeTrackAResult({ priceMedianUsd: 10 })),
        calculateTrackB: vi.fn().mockReturnValue(makeTrackBResult({ finalUnitPrice: 15 })),
      },
    });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      refundRate: 13,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.deviationLevel).toBe('block');
      expect(r.data.canSend).toBe(false);
    }
  });

  it('负偏差 > 30% → block（取绝对值）', async () => {
    // TrackA median=10, TrackB final=5 → deviation = -50% → |−50%| > 30% → block
    const { prisma } = makePrisma({
      pricingServiceOverrides: {
        estimateTrackA: vi.fn().mockResolvedValue(makeTrackAResult({ priceMedianUsd: 10 })),
        calculateTrackB: vi.fn().mockReturnValue(makeTrackBResult({ finalUnitPrice: 5 })),
      },
    });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      refundRate: 13,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.deviationLevel).toBe('block');
      expect(r.data.deviationPercent).toBe(-50);
    }
  });
});

describe('applyTrackPricing 快照写入', () => {
  it('成功路径写入 Quotation 快照字段', async () => {
    const { prisma } = makePrisma();
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      refundRate: 13,
    });
    expect(r.ok).toBe(true);
    expect(prisma.quotation.update).toHaveBeenCalledTimes(1);
    const updateCall = prisma.quotation.update.mock.calls[0][0];
    expect(updateCall.where.id).toBe('QUO__1');
    expect(updateCall.data.trackAMedianUsd).toBeDefined();
    expect(updateCall.data.trackAUnit).toBe('YD');
    expect(updateCall.data.trackBFinalUsd).toBeDefined();
    expect(updateCall.data.priceDeviationLevel).toBeDefined();
    expect(updateCall.data.exchangeRate).toBe(7.1);
    expect(updateCall.data.updatedAt).toBeDefined();
  });

  it('TrackA priceMedianUsd 为 null → PRICING_FAILED', async () => {
    const { prisma } = makePrisma({
      pricingServiceOverrides: {
        estimateTrackA: vi.fn().mockResolvedValue(makeTrackAResult({ priceMedianUsd: null })),
      },
    });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      refundRate: 13,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PRICING_FAILED');
  });

  it('佣金规则合法时使用规则费率', async () => {
    const { prisma, pricingSvcMock } = makePrisma({
      commissionRule: { id: 'COM__1', rate: dec(0.05), isActive: true, deletedAt: null },
    });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.applyTrackPricing('QUO__1', {
      category: 'fabric',
      purchaseCostCny: 50,
      profitMargin: 0.1,
      exchangeRate: 7.1,
      refundRate: 13,
      commissionRuleId: 'COM__1',
    });
    expect(r.ok).toBe(true);
    // calculateTrackB 应被调用，且 commissionRate=0.05（来自规则）
    expect(pricingSvcMock.calculateTrackB).toHaveBeenCalledWith(
      expect.objectContaining({ commissionRate: 0.05 }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// getPricingCheck
// ═══════════════════════════════════════════════════════════════

describe('getPricingCheck 门禁读取', () => {
  it('报价单不存在 → NOT_FOUND', async () => {
    const { prisma } = makePrisma({ quotation: null });
    const svc = createQuotationPricingService(prisma);
    const r = await svc.getPricingCheck('NOPE');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('block 级别 → canSend=false', async () => {
    const prisma = {
      quotation: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'QUO__1',
          quotationNumber: 'QUO-1',
          trackAMedianUsd: dec(10),
          trackAUnit: 'YD',
          trackBFinalUsd: dec(15),
          priceDeviationPercent: dec(50),
          priceDeviationLevel: 'block',
        }),
      },
    } as any;
    const svc = createQuotationPricingService(prisma);
    const r = await svc.getPricingCheck('QUO__1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.deviationLevel).toBe('block');
      expect(r.data.canSend).toBe(false);
      expect(r.data.deviationPercent).toBe(50);
    }
  });

  it('未应用双轨定价（null 字段）→ canSend=true（兼容老数据）', async () => {
    const prisma = {
      quotation: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'QUO__1',
          quotationNumber: 'QUO-1',
          trackAMedianUsd: null,
          trackAUnit: null,
          trackBFinalUsd: null,
          priceDeviationPercent: null,
          priceDeviationLevel: null,
        }),
      },
    } as any;
    const svc = createQuotationPricingService(prisma);
    const r = await svc.getPricingCheck('QUO__1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.canSend).toBe(true);
      expect(r.data.deviationLevel).toBe('ok');
    }
  });

  it('ok 级别 → canSend=true', async () => {
    const prisma = {
      quotation: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'QUO__1',
          quotationNumber: 'QUO-1',
          trackAMedianUsd: dec(12),
          trackAUnit: 'YD',
          trackBFinalUsd: dec(13),
          priceDeviationPercent: dec(8.33),
          priceDeviationLevel: 'ok',
        }),
      },
    } as any;
    const svc = createQuotationPricingService(prisma);
    const r = await svc.getPricingCheck('QUO__1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.deviationLevel).toBe('ok');
      expect(r.data.canSend).toBe(true);
    }
  });
});
