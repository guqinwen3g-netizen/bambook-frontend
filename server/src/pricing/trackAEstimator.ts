import { pricingInputError } from './pricingError';
/**
 * 阶段 P2 — 轨道 A 系统推荐估算器（PRD 8.1/8.6）
 *
 * 职责：
 *   1. 纯函数 calculateTrackA：按品类（garment/fabric）汇总成本拆解行，
 *      输出成本中位 + 估算售价区间（下限/中位/上限，含行业利润基准）。
 *   2. 逐项可调：调用方可回传 lines 覆盖默认拆解（PRD 8.6「逐项可调，实时重算；
 *      任何一项被手动改过后标记已调整，重算仅更新未调整项」——覆盖行原样保留）。
 *   3. 纯函数 calculatePriceDeviation：轨道 B 终价 vs 轨道 A 估算售价中位的
 *      偏差分级（ok | warn | block），供报价编辑器黄/红标与发送门禁复用。
 *
 * 口径说明（规则制，PRD 8.1 明确 AI 校准学习属 Phase 4）：
 *   - 成本数据来源三级：price_history（MaterialPriceHistory 命中）>
 *     manual（手工录入/工厂报价）> industry_benchmark（行业基准默认值）。
 *   - 区间系数按命中度：主材行命中价格历史或手工价 → ±8%；
 *     部分基准 → ±12%；全部基准 → ±15%。
 *   - 估算售价 = 成本中位 × (1 + 行业利润基准)，与轨道 B 终价同为对外口径，
 *     使偏差校验同口径可比（均换算 USD 后比较）。
 *   - 行业基准常量集中于 INDUSTRY_BENCHMARKS，为 Phase 4 AI 校准前的
 *     人工可调默认口径（羊毛精纺正装线经验值）。
 */

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export type TrackACategory = 'garment' | 'fabric';
export type TrackASource = 'price_history' | 'industry_benchmark' | 'manual';
export type TrackAComplexity = 'simple' | 'standard' | 'complex';
export type TrackAWeaveType = 'plain' | 'twill' | 'jacquard';
export type TrackADataQuality = 'full_history' | 'partial' | 'benchmark_only';
export type DeviationLevel = 'ok' | 'warn' | 'block';

export interface TrackACostLine {
  key: string; // fabric | trimming | cmt | packaging | yarn | weaving | dyeing
  label: string;
  amountCny: number; // ¥/件（garment）或 ¥/米（fabric）
  source: TrackASource;
  adjusted?: boolean; // 手工改过的行（PRD 8.6「已调整」标记）
}

export interface TrackAInput {
  category: TrackACategory;
  // ── 成衣输入（¥/件口径）──
  fabricPriceCny?: number; // 面料单价 ¥/米；缺省行业基准
  fabricConsumptionM?: number; // 单件用量 米/件；缺省 1.5
  fabricLossRate?: number; // 损耗率 %；缺省 3
  trimmingCostCny?: number; // 辅料 ¥/件；缺省行业基准
  cmtCostCny?: number; // CMT 加工费 ¥/件；缺省 基准 × 复杂度系数
  complexity?: TrackAComplexity; // 缺省 standard
  packagingCostCny?: number; // 包装 ¥/件；缺省行业基准
  // ── 面料输入（¥/米口径）──
  yarnPriceCnyPerKg?: number; // 纱线价 ¥/kg；缺省行业基准
  weightGsm?: number; // 克重 g/m²；缺省 280
  widthM?: number; // 幅宽 m；缺省 1.5
  weavingCostCny?: number; // 织造费 ¥/米；缺省 基准 × 织法系数
  weaveType?: TrackAWeaveType; // 缺省 twill（精纺正装主力）
  dyeingCostCny?: number; // 染整费 ¥/米；缺省行业基准
  // ── 通用 ──
  profitBenchmark?: number; // 行业利润基准 %；缺省 garment 25 / fabric 15
  exchangeRate?: number; // CNY per USD；提供时输出美元估算售价区间
  quantity?: number; // 数量（仅透传展示，不参与单价计算）
  lines?: TrackACostLine[]; // 逐项覆盖：提供时以 lines 为真源重算合计
  // ── 来源提示（服务层命中价格历史后注入）──
  sources?: Partial<Record<'fabric' | 'yarn', TrackASource>>;
}

export interface TrackAResult {
  category: TrackACategory;
  unit: 'PC' | 'M';
  lines: TrackACostLine[]; // 成本拆解（不含利润）
  costTotalCny: number; // 成本合计（中位）¥
  profitBenchmark: number; // %
  priceMedianCny: number; // 估算售价中位 ¥（含行业利润基准）
  priceLowCny: number;
  priceHighCny: number;
  priceMedianUsd: number | null; // 有汇率时输出
  priceLowUsd: number | null;
  priceHighUsd: number | null;
  spreadPercent: number; // 区间系数
  dataQuality: TrackADataQuality;
}

export interface PriceDeviation {
  deviationPercent: number; // 有符号百分比：(final - median) / median × 100
  level: DeviationLevel;
}

// ────────────────────────────────────────────────────────────────
// 行业基准常量（Phase 4 AI 校准前的人工可调默认口径）
// ────────────────────────────────────────────────────────────────

export const INDUSTRY_BENCHMARKS = {
  garment: {
    fabricPriceCnyPerM: 55, // 羊毛精纺面料基准价 ¥/米
    fabricConsumptionM: 1.5, // 西服类单件用量 米/件
    fabricLossRate: 3, // 损耗率 %
    trimmingCostCny: 8, // 辅料（拉链/纽扣/衬布/线/吊牌/包装袋）¥/件
    cmtBaseCny: 35, // CMT 基准（裁剪+缝制+整烫）¥/件（PRD 8.2 示例口径）
    packagingCostCny: 3, // 包装 ¥/件
    profitBenchmark: 25, // 行业利润基准 %（与轨道 B 默认利润率一致）
  },
  fabric: {
    yarnPriceCnyPerKg: 180, // 羊毛精纺纱线基准价 ¥/kg
    weightGsm: 280, // 克重 g/m²
    widthM: 1.5, // 幅宽 m
    weavingBaseCny: 8, // 织造费基准 ¥/米
    dyeingCostCny: 6, // 染整费 ¥/米
    profitBenchmark: 15, // 行业利润基准 %
  },
} as const;

const CMT_COMPLEXITY_FACTOR: Record<TrackAComplexity, number> = {
  simple: 0.85,
  standard: 1.0,
  complex: 1.3,
};

const WEAVE_TYPE_FACTOR: Record<TrackAWeaveType, number> = {
  plain: 1.0,
  twill: 1.15,
  jacquard: 1.4,
};

/** 区间系数（PRD 8.6 区间口径：命中度越高区间越窄） */
const SPREAD_BY_QUALITY: Record<TrackADataQuality, number> = {
  full_history: 8,
  partial: 12,
  benchmark_only: 15,
};

/** 偏差阈值（PRD 8.6：>15% 黄标审批；>30% 红标禁止直接发送） */
export const DEVIATION_WARN_PERCENT = 15;
export const DEVIATION_BLOCK_PERCENT = 30;

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function assertPositive(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw pricingInputError(`${name}必须大于 0`);
  }
}

function assertNonNegative(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw pricingInputError(`${name}非法`);
  }
}

// ────────────────────────────────────────────────────────────────
// 轨道 A 纯函数
// ────────────────────────────────────────────────────────────────

export function calculateTrackA(input: TrackAInput): TrackAResult {
  if (input.category !== 'garment' && input.category !== 'fabric') {
    throw pricingInputError(`非法品类：${input.category}（允许 garment | fabric）`);
  }
  assertPositive('面料单价', input.fabricPriceCny);
  assertPositive('单件用量', input.fabricConsumptionM);
  assertNonNegative('损耗率', input.fabricLossRate);
  assertNonNegative('辅料成本', input.trimmingCostCny);
  assertNonNegative('CMT 加工费', input.cmtCostCny);
  assertNonNegative('包装成本', input.packagingCostCny);
  assertPositive('纱线价', input.yarnPriceCnyPerKg);
  assertPositive('克重', input.weightGsm);
  assertPositive('幅宽', input.widthM);
  assertNonNegative('织造费', input.weavingCostCny);
  assertNonNegative('染整费', input.dyeingCostCny);
  assertNonNegative('利润基准', input.profitBenchmark);
  assertPositive('汇率', input.exchangeRate);

  const bm = INDUSTRY_BENCHMARKS[input.category];

  // 1. 成本拆解行：lines 覆盖优先（逐项可调实时重算），否则按输入 + 基准构建
  let lines: TrackACostLine[];
  if (input.lines && input.lines.length > 0) {
    lines = input.lines.map(l => {
      if (!Number.isFinite(l.amountCny) || l.amountCny < 0) {
        throw pricingInputError(`成本行 ${l.key} 金额非法`);
      }
      return { ...l, amountCny: round4(l.amountCny) };
    });
  } else if (input.category === 'garment') {
    const g = INDUSTRY_BENCHMARKS.garment;
    const fabricPrice = input.fabricPriceCny ?? g.fabricPriceCnyPerM;
    const consumption = input.fabricConsumptionM ?? g.fabricConsumptionM;
    const lossRate = input.fabricLossRate ?? g.fabricLossRate;
    const fabricSource: TrackASource =
      input.sources?.fabric ?? (input.fabricPriceCny !== undefined ? 'manual' : 'industry_benchmark');
    const complexity = input.complexity ?? 'standard';
    lines = [
      {
        key: 'fabric',
        label: '面料成本',
        amountCny: round4(fabricPrice * consumption * (1 + lossRate / 100)),
        source: fabricSource,
        adjusted: input.fabricPriceCny !== undefined,
      },
      {
        key: 'trimming',
        label: '辅料成本',
        amountCny: round4(input.trimmingCostCny ?? g.trimmingCostCny),
        source: input.trimmingCostCny !== undefined ? 'manual' : 'industry_benchmark',
        adjusted: input.trimmingCostCny !== undefined,
      },
      {
        key: 'cmt',
        label: 'CMT 加工费',
        amountCny: round4(input.cmtCostCny ?? g.cmtBaseCny * CMT_COMPLEXITY_FACTOR[complexity]),
        source: input.cmtCostCny !== undefined ? 'manual' : 'industry_benchmark',
        adjusted: input.cmtCostCny !== undefined,
      },
      {
        key: 'packaging',
        label: '包装成本',
        amountCny: round4(input.packagingCostCny ?? g.packagingCostCny),
        source: input.packagingCostCny !== undefined ? 'manual' : 'industry_benchmark',
        adjusted: input.packagingCostCny !== undefined,
      },
    ];
  } else {
    const f = INDUSTRY_BENCHMARKS.fabric;
    const yarnPrice = input.yarnPriceCnyPerKg ?? f.yarnPriceCnyPerKg;
    const weight = input.weightGsm ?? f.weightGsm;
    const width = input.widthM ?? f.widthM;
    const yarnSource: TrackASource =
      input.sources?.yarn ?? (input.yarnPriceCnyPerKg !== undefined ? 'manual' : 'industry_benchmark');
    const weaveType = input.weaveType ?? 'twill';
    // 用纱量 kg/米 = 克重(g/m²) × 幅宽(m) ÷ 1000
    const yarnConsumptionKgPerM = (weight * width) / 1000;
    lines = [
      {
        key: 'yarn',
        label: '纱线成本',
        amountCny: round4(yarnPrice * yarnConsumptionKgPerM),
        source: yarnSource,
        adjusted: input.yarnPriceCnyPerKg !== undefined,
      },
      {
        key: 'weaving',
        label: '织造费',
        amountCny: round4(input.weavingCostCny ?? f.weavingBaseCny * WEAVE_TYPE_FACTOR[weaveType]),
        source: input.weavingCostCny !== undefined ? 'manual' : 'industry_benchmark',
        adjusted: input.weavingCostCny !== undefined,
      },
      {
        key: 'dyeing',
        label: '染整费',
        amountCny: round4(input.dyeingCostCny ?? f.dyeingCostCny),
        source: input.dyeingCostCny !== undefined ? 'manual' : 'industry_benchmark',
        adjusted: input.dyeingCostCny !== undefined,
      },
    ];
  }

  // 2. 合计与区间
  const costTotalCny = round4(lines.reduce((s, l) => s + l.amountCny, 0));
  if (costTotalCny <= 0) throw pricingInputError('成本合计必须大于 0');

  // 数据命中度：主材行（fabric/yarn）为 price_history/manual → full_history；
  // 全部行业基准 → benchmark_only；其余 → partial
  const mainKey = input.category === 'garment' ? 'fabric' : 'yarn';
  const mainLine = lines.find(l => l.key === mainKey);
  const allBenchmark = lines.every(l => l.source === 'industry_benchmark');
  const dataQuality: TrackADataQuality = allBenchmark
    ? 'benchmark_only'
    : mainLine && mainLine.source !== 'industry_benchmark'
      ? 'full_history'
      : 'partial';
  const spreadPercent = SPREAD_BY_QUALITY[dataQuality];

  const profitBenchmark = input.profitBenchmark ?? bm.profitBenchmark;
  const priceMedianCny = round4(costTotalCny * (1 + profitBenchmark / 100));
  const priceLowCny = round4(priceMedianCny * (1 - spreadPercent / 100));
  const priceHighCny = round4(priceMedianCny * (1 + spreadPercent / 100));

  const fx = input.exchangeRate;
  return {
    category: input.category,
    unit: input.category === 'garment' ? 'PC' : 'M',
    lines,
    costTotalCny,
    profitBenchmark,
    priceMedianCny,
    priceLowCny,
    priceHighCny,
    priceMedianUsd: fx ? round4(priceMedianCny / fx) : null,
    priceLowUsd: fx ? round4(priceLowCny / fx) : null,
    priceHighUsd: fx ? round4(priceHighCny / fx) : null,
    spreadPercent,
    dataQuality,
  };
}

// ────────────────────────────────────────────────────────────────
// 偏差分级纯函数（PRD 8.6 双轨联动校验）
//   |dev| > 30% → block（红标，禁止直接发送）
//   |dev| > 15% → warn（黄标，触发审批）
//   其余 → ok
// 低估（负偏差）同样分级：报价显著低于估算意味着亏损风险（PRD 9.2 报价低于成本价→管理层审批）。
// ────────────────────────────────────────────────────────────────

export function calculatePriceDeviation(finalPriceUsd: number, estimateMedianUsd: number): PriceDeviation {
  if (!Number.isFinite(finalPriceUsd) || finalPriceUsd <= 0) throw pricingInputError('终价必须大于 0');
  if (!Number.isFinite(estimateMedianUsd) || estimateMedianUsd <= 0) throw pricingInputError('估算中位必须大于 0');
  const deviationPercent = round4(((finalPriceUsd - estimateMedianUsd) / estimateMedianUsd) * 100);
  const abs = Math.abs(deviationPercent);
  const level: DeviationLevel =
    abs > DEVIATION_BLOCK_PERCENT ? 'block' : abs > DEVIATION_WARN_PERCENT ? 'warn' : 'ok';
  return { deviationPercent, level };
}
