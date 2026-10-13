/**
 * 轨道 A 估算器单测（PRD 8.1/8.6）
 *
 * 覆盖：
 *   1. calculateTrackA 纯函数 — 成衣/面料默认基准、显式输入、lines 覆盖、
 *      区间系数三档、美元换算、校验错误
 *   2. calculatePriceDeviation — ok/warn/block 三档（含负偏差）
 *   3. estimateTrackA 服务层 — 价格历史命中（fabric/yarn）与兜底
 */

import { describe, it, expect } from 'vitest';
import {
  calculateTrackA,
  calculatePriceDeviation,
  INDUSTRY_BENCHMARKS,
  DEVIATION_WARN_PERCENT,
  DEVIATION_BLOCK_PERCENT,
} from '../trackAEstimator';
import { createPricingService } from '../pricingService';

// ────────────────────────────────────────────────────────────────
// 1. 纯函数：成衣
// ────────────────────────────────────────────────────────────────

describe('calculateTrackA — garment', () => {
  it('全部缺省 → 行业基准拆解 + benchmark_only + ±15% 区间', () => {
    const r = calculateTrackA({ category: 'garment' });
    const g = INDUSTRY_BENCHMARKS.garment;
    expect(r.unit).toBe('PC');
    expect(r.lines.map(l => l.key)).toEqual(['fabric', 'trimming', 'cmt', 'packaging']);
    // 面料成本 = 55 × 1.5 × 1.03 = 85.0125
    expect(r.lines[0].amountCny).toBeCloseTo(g.fabricPriceCnyPerM * g.fabricConsumptionM * 1.03, 4);
    expect(r.lines[0].source).toBe('industry_benchmark');
    expect(r.lines[2].amountCny).toBeCloseTo(g.cmtBaseCny, 4); // standard ×1.0
    const expectedTotal = r.lines.reduce((s, l) => s + l.amountCny, 0);
    expect(r.costTotalCny).toBeCloseTo(expectedTotal, 4);
    expect(r.dataQuality).toBe('benchmark_only');
    expect(r.spreadPercent).toBe(15);
    // 中位售价 = 成本 × 1.25
    expect(r.priceMedianCny).toBeCloseTo(r.costTotalCny * 1.25, 4);
    expect(r.priceLowCny).toBeCloseTo(r.priceMedianCny * 0.85, 4);
    expect(r.priceHighCny).toBeCloseTo(r.priceMedianCny * 1.15, 4);
    expect(r.priceMedianUsd).toBeNull(); // 未给汇率
  });

  it('显式面料价 → manual 来源 + full_history + ±8% + 美元换算', () => {
    const r = calculateTrackA({
      category: 'garment',
      fabricPriceCny: 60,
      fabricConsumptionM: 2,
      fabricLossRate: 5,
      exchangeRate: 7.2,
    });
    expect(r.lines[0].amountCny).toBeCloseTo(60 * 2 * 1.05, 4); // 126
    expect(r.lines[0].source).toBe('manual');
    expect(r.lines[0].adjusted).toBe(true);
    expect(r.dataQuality).toBe('full_history');
    expect(r.spreadPercent).toBe(8);
    expect(r.priceMedianUsd).toBeCloseTo(r.priceMedianCny / 7.2, 4);
    expect(r.priceLowUsd).toBeCloseTo(r.priceLowCny / 7.2, 4);
    expect(r.priceHighUsd).toBeCloseTo(r.priceHighCny / 7.2, 4);
  });

  it('复杂度系数：complex CMT = 基准 × 1.3', () => {
    const r = calculateTrackA({ category: 'garment', complexity: 'complex' });
    const cmt = r.lines.find(l => l.key === 'cmt')!;
    expect(cmt.amountCny).toBeCloseTo(INDUSTRY_BENCHMARKS.garment.cmtBaseCny * 1.3, 4);
  });

  it('lines 覆盖为真源：重算合计且保留 adjusted 标记', () => {
    const r = calculateTrackA({
      category: 'garment',
      lines: [
        { key: 'fabric', label: '面料成本', amountCny: 100, source: 'manual', adjusted: true },
        { key: 'cmt', label: 'CMT 加工费', amountCny: 40, source: 'manual', adjusted: true },
      ],
    });
    expect(r.costTotalCny).toBe(140);
    expect(r.lines).toHaveLength(2);
    expect(r.dataQuality).toBe('full_history'); // 主材行 manual
  });

  it('利润基准可覆盖', () => {
    const r = calculateTrackA({ category: 'garment', fabricPriceCny: 60, profitBenchmark: 30 });
    expect(r.profitBenchmark).toBe(30);
    expect(r.priceMedianCny).toBeCloseTo(r.costTotalCny * 1.3, 4);
  });

  it('非法输入抛中文错误', () => {
    expect(() => calculateTrackA({ category: 'garment', fabricPriceCny: -1 })).toThrow('面料单价必须大于 0');
    expect(() => calculateTrackA({ category: 'garment', exchangeRate: 0 })).toThrow('汇率必须大于 0');
    expect(() => calculateTrackA({ category: 'x' as any })).toThrow('非法品类');
  });
});

// ────────────────────────────────────────────────────────────────
// 2. 纯函数：面料
// ────────────────────────────────────────────────────────────────

describe('calculateTrackA — fabric', () => {
  it('默认基准：纱线成本 = 180 × (280×1.5/1000) = 75.6 ¥/米', () => {
    const r = calculateTrackA({ category: 'fabric' });
    expect(r.unit).toBe('M');
    expect(r.lines.map(l => l.key)).toEqual(['yarn', 'weaving', 'dyeing']);
    expect(r.lines[0].amountCny).toBeCloseTo(75.6, 4);
    // 织造默认 twill ×1.15
    expect(r.lines[1].amountCny).toBeCloseTo(INDUSTRY_BENCHMARKS.fabric.weavingBaseCny * 1.15, 4);
    expect(r.dataQuality).toBe('benchmark_only');
    // 面料利润基准 15%
    expect(r.priceMedianCny).toBeCloseTo(r.costTotalCny * 1.15, 4);
  });

  it('显式克重/幅宽/纱价 → manual + full_history', () => {
    const r = calculateTrackA({
      category: 'fabric',
      yarnPriceCnyPerKg: 200,
      weightGsm: 300,
      widthM: 1.5,
      exchangeRate: 7.2,
    });
    expect(r.lines[0].amountCny).toBeCloseTo(200 * 0.45, 4); // 90
    expect(r.lines[0].source).toBe('manual');
    expect(r.dataQuality).toBe('full_history');
    expect(r.priceMedianUsd).not.toBeNull();
  });

  it('织法系数：jacquard = 基准 × 1.4', () => {
    const r = calculateTrackA({ category: 'fabric', weaveType: 'jacquard' });
    const weaving = r.lines.find(l => l.key === 'weaving')!;
    expect(weaving.amountCny).toBeCloseTo(INDUSTRY_BENCHMARKS.fabric.weavingBaseCny * 1.4, 4);
  });

  it('sources 注入：price_history 优先于 manual 推断', () => {
    const r = calculateTrackA({
      category: 'fabric',
      yarnPriceCnyPerKg: 200,
      sources: { yarn: 'price_history' },
    });
    expect(r.lines[0].source).toBe('price_history');
  });
});

// ────────────────────────────────────────────────────────────────
// 3. 偏差分级（PRD 8.6 双轨联动校验）
// ────────────────────────────────────────────────────────────────

describe('calculatePriceDeviation', () => {
  it('≤15% → ok', () => {
    expect(calculatePriceDeviation(11, 10).level).toBe('ok'); // +10%
    expect(calculatePriceDeviation(10, 10).level).toBe('ok');
  });

  it('>15% → warn（含负偏差）', () => {
    const up = calculatePriceDeviation(12, 10); // +20%
    expect(up.level).toBe('warn');
    expect(up.deviationPercent).toBeCloseTo(20, 4);
    const down = calculatePriceDeviation(8, 10); // -20%
    expect(down.level).toBe('warn');
    expect(down.deviationPercent).toBeCloseTo(-20, 4);
  });

  it('>30% → block', () => {
    expect(calculatePriceDeviation(13.5, 10).level).toBe('block'); // +35%
    expect(calculatePriceDeviation(6.5, 10).level).toBe('block'); // -35%
  });

  it('阈值常量为 15/30', () => {
    expect(DEVIATION_WARN_PERCENT).toBe(15);
    expect(DEVIATION_BLOCK_PERCENT).toBe(30);
  });

  it('非法输入抛错', () => {
    expect(() => calculatePriceDeviation(0, 10)).toThrow('终价必须大于 0');
    expect(() => calculatePriceDeviation(10, 0)).toThrow('估算中位必须大于 0');
  });
});

// ────────────────────────────────────────────────────────────────
// 4. 服务层：价格历史命中解析
// ────────────────────────────────────────────────────────────────

function createMockPrisma(latestPrice: { price: number } | null) {
  return {
    materialPriceHistory: {
      findFirst: async () => latestPrice,
    },
  } as any;
}

describe('estimateTrackA（服务层）', () => {
  it('garment + fabricCode 命中价格历史 → price_history 来源', async () => {
    const svc = createPricingService(createMockPrisma({ price: 62.5 }));
    const r = await svc.estimateTrackA({ category: 'garment', fabricCode: 'FB-1001' });
    expect(r.lines[0].source).toBe('price_history');
    // 面料成本 = 62.5 × 1.5 × 1.03
    expect(r.lines[0].amountCny).toBeCloseTo(62.5 * 1.5 * 1.03, 4);
    expect(r.dataQuality).toBe('full_history');
  });

  it('fabric + yarnCode 命中价格历史 → price_history 来源', async () => {
    const svc = createPricingService(createMockPrisma({ price: 210 }));
    const r = await svc.estimateTrackA({ category: 'fabric', yarnCode: 'W100-32NM' });
    expect(r.lines[0].source).toBe('price_history');
    expect(r.lines[0].amountCny).toBeCloseTo(210 * 0.42, 4);
  });

  it('未命中 → 行业基准兜底（benchmark_only）', async () => {
    const svc = createPricingService(createMockPrisma(null));
    const r = await svc.estimateTrackA({ category: 'garment', fabricCode: 'NOPE' });
    expect(r.lines[0].source).toBe('industry_benchmark');
    expect(r.dataQuality).toBe('benchmark_only');
  });

  it('显式价格优先于价格历史（不查询也保持 manual）', async () => {
    const svc = createPricingService(createMockPrisma({ price: 62.5 }));
    const r = await svc.estimateTrackA({ category: 'garment', fabricCode: 'FB-1001', fabricPriceCny: 70 });
    expect(r.lines[0].source).toBe('manual');
    expect(r.lines[0].amountCny).toBeCloseTo(70 * 1.5 * 1.03, 4);
  });
});
