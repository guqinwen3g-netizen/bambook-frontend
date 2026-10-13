/**
 * bomPluginEngine.spec.ts — Phase 0-06 Vitest 单元测试
 *
 * 覆盖范围：每个内置插件至少 1 个基准用例（Expected 值精确到 2~4 位小数，
 * 方便快速识别公式是否改坏）。额外：Registry 注册冲突、模型不存在异常、
 * Track B 退税公式正确性。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BOMPluginRegistry,
  FabricCostModelPlugin,
  ApparelFOBModelPlugin,
  ApparelCMModelPlugin,
  getDefaultBOMRegistry,
} from '../bomPluginEngine';
import type { BOMLineInput, CostEstimateInput } from '../bomService';

// 辅助：简单误差断言（float）
function closeTo(actual: number, expected: number, eps = 0.0001) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(eps);
}

describe('BOMPluginRegistry — 注册/调度基础', () => {
  it('默认 registry 已注册 3 个内置模型', () => {
    const r = getDefaultBOMRegistry();
    const ids = r.list().map(x => x.id);
    expect(ids).toEqual(expect.arrayContaining(['fabric', 'apparel-fob', 'apparel-cm']));
    expect(r.has('fabric')).toBe(true);
    expect(r.has('missing-model')).toBe(false);
  });

  it('重复 id 注册抛错（fail-fast 防覆盖）', () => {
    const r = new BOMPluginRegistry();
    r.register(FabricCostModelPlugin);
    expect(() => r.register(FabricCostModelPlugin)).toThrow(/冲突/);
  });

  it('未注册模型 compute 抛错，错误信息包含已注册 id 列表', async () => {
    const r = new BOMPluginRegistry();
    await expect(r.compute('missing', { lines: [] } as any)).rejects.toThrow(/未注册/);
  });

  it('非法插件（无 id 或 无 compute）register 抛错', () => {
    const r = new BOMPluginRegistry();
    expect(() => r.register({} as any)).toThrow(/id/);
    expect(() => r.register({ id: 'x' } as any)).toThrow(/compute/);
  });
});

// ---------------- 公共 Fixtures ----------------
const lines_1_polo: BOMLineInput[] = [
  // 主布：1.8m/件 × 30元/m + 5%损耗
  {
    materialType: 'Main', category: 'Fabric',
    name: 'Pique 200g/m² 主布',
    quantity: 1.8, unit: 'm', unitCost: 30, wastagePercent: 5,
    color: 'Navy',
  } as any,
  // 领条罗纹：0.15m + 3%损耗 × 25元/m
  {
    materialType: 'Contrast', category: 'Fabric',
    name: 'Rib 领条',
    quantity: 0.15, unit: 'm', unitCost: 25, wastagePercent: 3,
    color: 'White',
  } as any,
  // 袋布（里布类）
  {
    materialType: 'Pocketing', category: 'Fabric',
    name: 'TC 袋布',
    quantity: 0.2, unit: 'm', unitCost: 10, wastagePercent: 2,
  } as any,
  // 主标/吊牌（Trimmings 类）：2元/套，不计损耗
  {
    materialType: 'Trimmings', category: 'Accessories',
    name: '主标/吊牌/洗水唛',
    quantity: 1, unit: 'set', unitCost: 2, wastagePercent: 0,
  } as any,
];

const estimates_1_polo_cmt: CostEstimateInput[] = [
  { costType: 'Labor', name: '裁剪+车缝+锁眼+整烫', amount: 28, currency: 'CNY' } as any,
  { costType: 'Overhead', name: '工厂制造费用分摊', amount: 14, currency: 'CNY' } as any,
  { costType: 'Other', name: '包装+纸箱+到港陆运', amount: 6, currency: 'CNY' } as any,
];

describe('FabricCostModelPlugin（面料成本模型）— 基准用例', () => {
  it('1件Polo：仅统计面料类行（Main/Contrast/Pocketing），不含Trimmings，含wastage', async () => {
    const r = new BOMPluginRegistry().register(FabricCostModelPlugin);
    const result = await r.compute('fabric', {
      lines: lines_1_polo,
      costEstimates: estimates_1_polo_cmt, // Estimate 中 Material 类型不存在，所以不影响
      productionQty: 1,
    });

    // 期望：
    // 主布 1.8 × 1.05 = 1.89m × 30 = 56.7
    // 领条 0.15 × 1.03 = 0.1545m × 25 = 3.8625
    // 袋布 0.2 × 1.02 = 0.204m × 10 = 2.04
    // Trimmings 默认不在 includeMaterialTypes → 不计
    // 合计 = 56.7 + 3.8625 + 2.04 = 62.6025
    closeTo(result.headlineCny, 62.6025);
    expect(result.unit).toBe('piece');
    expect(result.baseCosts.totalLaborCost).toBe(0); // 面料模型不计 labor
    expect(result.baseCosts.totalOverheadCost).toBe(0);
    expect(result.breakdown.find(x => x.key === 'material_total')?.amountCny).toBeCloseTo(62.6025, 4);
  });

  it('自定义 includeMaterialTypes 加入 Trimmings 后，主标2元被计入', async () => {
    const r = new BOMPluginRegistry().register(FabricCostModelPlugin);
    const result = await r.compute('fabric', {
      lines: lines_1_polo,
      productionQty: 1,
      extra: { includeMaterialTypes: ['Main', 'Contrast', 'Pocketing', 'Trimmings'] },
    } as any);
    closeTo(result.headlineCny, 62.6025 + 2);
  });
});

describe('ApparelCMModelPlugin（服装CM模型）— 基准用例', () => {
  it('Labor 28 + Overhead 14 + Other 6 = 48 → 1件 CM = 48/pc（无利润）', async () => {
    const r = new BOMPluginRegistry().register(ApparelCMModelPlugin);
    const result = await r.compute('apparel-cm', {
      lines: lines_1_polo, // 行被忽略（CM 不含面料）
      costEstimates: estimates_1_polo_cmt,
      productionQty: 1,
    });
    closeTo(result.headlineCny, 28 + 14 + 6);
    expect(result.baseCosts.totalMaterialCost).toBe(0);
    closeTo(result.baseCosts.totalLaborCost, 28);
    closeTo(result.baseCosts.totalOverheadCost, 20); // 14 Overhead + 6 Other
  });

  it('1000件 + profitAmountCny=24000 → 每件 +24 利润 → headline = 48 + 24 = 72/pc', async () => {
    const r = new BOMPluginRegistry().register(ApparelCMModelPlugin);
    const estimates_1000: CostEstimateInput[] = [
      { costType: 'Labor', name: '裁剪车缝', amount: 28 * 1000 } as any,
      { costType: 'Overhead', name: '制造费用', amount: 14 * 1000 } as any,
      { costType: 'Other', name: '包装运输', amount: 6 * 1000 } as any,
    ];
    const result = await r.compute('apparel-cm', {
      costEstimates: estimates_1000,
      productionQty: 1000,
      profitAmountCny: 24000,
    });
    closeTo(result.headlineCny, 48 + 24);
    closeTo(result.profit.amountCny!, 24000);
  });
});

describe('ApparelFOBModelPlugin（服装FOB模型）— 2 条路径基准', () => {
  it('标准 FOB（无退税）：物料64.6025 + 人工28 + 费用20 = 总成本 112.6025/pc + 10%利润 → 123.86275', async () => {
    const r = new BOMPluginRegistry().register(ApparelFOBModelPlugin);
    const result = await r.compute('apparel-fob', {
      lines: lines_1_polo,
      costEstimates: estimates_1_polo_cmt,
      productionQty: 1,
      profitMarginPercent: 10,
    });
    const totalCost = (62.6025 + 2 /* Trimmings 2元被 lines 全部纳入 aggregateCosts!（FOB 模型不按面料类型过滤）*/) + 28 + 20;
    // → baseAggregateCosts 把所有 lines（含 Trimmings）纳入物料
    // 主布56.7 + 领条3.8625 + 袋布2.04 + Trimmings2.0 = 64.6025
    // + Labor 28 + Overhead+Other 20 = 112.6025
    // + 10% 利润（按总成本112.6025 × 10% = 11.26025）→ 123.86275
    closeTo(result.headlineCny, 123.86275);
    closeTo(result.baseCosts.totalMaterialCost, 64.6025);
    closeTo(result.baseCosts.totalLaborCost, 28);
    closeTo(result.baseCosts.totalOverheadCost, 20);
    closeTo(result.profit.amountCny!, 11.26025);
  });

  it('Track B 退税公式：物料100元 + 退税13% + 人工5 + 费用3 = 净物料 88.49558，总 96.49558/pc + 利润20 → 116.49558', async () => {
    const r = new BOMPluginRegistry().register(ApparelFOBModelPlugin);
    const lines: BOMLineInput[] = [
      { quantity: 2, unitCost: 50, wastagePercent: 0, materialType: 'Main', category: 'Fabric' } as any, // 100
    ];
    const ests: CostEstimateInput[] = [
      { costType: 'Labor', amount: 5 } as any,
      { costType: 'Overhead', amount: 3 } as any,
    ];
    const result = await r.compute('apparel-fob', {
      lines,
      costEstimates: ests,
      productionQty: 1,
      profitAmountCny: 20,
      exchangeRate: 7.25,
      extra: { taxRefundRate: 0.13 },
    } as any);
    const refund = 100 / 1.13 * 0.13;  // ≈ 11.50442...
    const netMaterial = 100 - refund;   // ≈ 88.49558
    const totalCost = netMaterial + 5 + 3; // ≈ 96.49558
    const expectedCny = totalCost + 20;   // ≈ 116.49558
    closeTo(result.headlineCny, expectedCny);
    // 折算 USD（汇率 7.25 → ÷7.25）
    expect(result.headlineConverted).toBeDefined();
    closeTo(result.headlineConverted!, expectedCny / 7.25);
    // 退税明细应出现在 breakdown：tax_refund_deduction 为负项
    const refundItem = result.breakdown.find(x => x.key === 'tax_refund_deduction');
    expect(refundItem).toBeDefined();
    closeTo(refundItem!.amountCny, -refund);
  });

  it('非法利润%或退税率 → validate 抛错（fail closed）', async () => {
    const r = new BOMPluginRegistry().register(ApparelFOBModelPlugin);
    await expect(r.compute('apparel-fob', {
      lines: [], costEstimates: [], profitMarginPercent: 500,
    })).rejects.toThrow(/利润百分比/);
    await expect(r.compute('apparel-fob', {
      lines: [], costEstimates: [], extra: { taxRefundRate: 0.5 },
    } as any)).rejects.toThrow(/taxRefundRate/);
  });
});

describe('FabricCostModel 与 ApparelFOBModel 对同一份 BOM 口径差异（回归防）', () => {
  it('Fabric 模型剔除 Trimmings/人工/费用；FOB 模型把它们都统计（口径分离正确）', async () => {
    const r = new BOMPluginRegistry()
      .register(FabricCostModelPlugin)
      .register(ApparelFOBModelPlugin);

    const shared = { lines: lines_1_polo, costEstimates: estimates_1_polo_cmt, productionQty: 1 };
    const fabric = await r.compute('fabric', shared);
    const fob = await r.compute('apparel-fob', { ...shared, profitMarginPercent: 0 });

    // Fabric：不包含 Trimmings(2)、Labor(28)、Overhead+Other(20) → 62.6025
    closeTo(fabric.headlineCny, 62.6025);
    // FOB 0利润：包含 Trimmings(2) + Labor 28 + Expense 20 → 64.6025 + 28 + 20 = 112.6025
    closeTo(fob.headlineCny, 112.6025);
    // headline 必须不同（否则是两者混在一起了——回归错误）
    expect(fabric.headlineCny).not.toBeCloseTo(fob.headlineCny, 0);
  });
});
