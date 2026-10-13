/**
 * unitConversion.ts — REQ2-03 面料单位换算库（单一真源）
 *
 * 设计真源：需求池 REQ2-03 ·「单位换算工具函数库（供报价/订单/单据/报表共用——单一真源）」
 *
 * 覆盖：
 *   - 长度换算：M ↔ YD（1 yd = 0.9144 m 精确值，国际标准）；round4 截断漂移
 *   - 重量换算（公斤计价）：克重 g/m² × 门幅 cm × 长度 m → kg
 *     公式：kg = gsm × (widthCm / 100) × lengthM / 1000
 *
 * 纪律：全代码库长度/重量换算必须引用本模块，禁止各处散写 0.9144 魔数。
 */

/** 国际标准：1 yard = 0.9144 meter（精确值） */
export const METERS_PER_YARD = 0.9144;

// ── 克重（克/平方米 GSM 基准）───────────────────────────────────────
// 与 fabricCalculatorService 同源口径（DR-062 行业物理/贸易常量）：
//   1 oz/yd² = 33.9057 g/m²（28.3495g ÷ 0.836127m²）
//   1 g/yd²  = 1.196    g/m²（1 ÷ 0.836127m²）
/** 国际标准：1 oz/yd² = 33.9057 g/m²（盎司/平方码 → 克/平方米） */
export const GRAMS_PER_SQM_PER_OZ_PER_SQYD = 33.9057;
/** 1 g/yd² = 1.196 g/m²（克/平方码 → 克/平方米） */
export const GRAMS_PER_SQM_PER_G_PER_SQYD = 1.196;

export type WeightUnit = 'gsm' | 'oz/yd2' | 'g/yd2';

const WEIGHT_ALIASES: Record<string, WeightUnit> = {
  gsm: 'gsm', 'g/m2': 'gsm', 'g/m²': 'gsm', 'g/㎡': 'gsm', 'g/m': 'gsm', 'g/sqm': 'gsm', 'grams': 'gsm',
  ozyd: 'oz/yd2', 'oz/yd2': 'oz/yd2', 'oz/yd²': 'oz/yd2', 'oz/sqyd': 'oz/yd2', 'oz': 'oz/yd2', 'ounce': 'oz/yd2',
  'g/yd2': 'g/yd2', 'g/yd²': 'g/yd2', 'g/sqyd': 'g/yd2',
};

/** 归一化克重单位别名（表单/导入自由文本 → 标准 WeightUnit；null=无法识别） */
export function normalizeWeightUnit(raw: string | null | undefined): WeightUnit | null {
  if (!raw) return null;
  return WEIGHT_ALIASES[String(raw).trim().toLowerCase()] ?? null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * 克重统一换算 → g/m²（GSM 基准）。面料档案录入/导入后系统统一归一化，
 * 推荐、筛选、比较一律消费归一化值，避免「180 g/m²」与「12 oz/yd²」混用。
 * 单位无法识别返回 null（调用方决定兜底）；数值非法返回 null。
 */
export function weightToGsm(value: number, rawUnit: string | null | undefined): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = normalizeWeightUnit(rawUnit);
  if (unit == null) return null;
  if (unit === 'gsm') return round1(value);
  if (unit === 'oz/yd2') return round1(value * GRAMS_PER_SQM_PER_OZ_PER_SQYD);
  if (unit === 'g/yd2') return round1(value * GRAMS_PER_SQM_PER_G_PER_SQYD);
  return null;
}

export type LengthUnit = 'M' | 'YD';

const LENGTH_ALIASES: Record<string, LengthUnit> = {
  m: 'M', meter: 'M', meters: 'M', 米: 'M',
  yd: 'YD', yard: 'YD', yards: 'YD', 码: 'YD',
};

/** 归一化长度单位别名（报价/订单行 unit 字段自由文本 → M/YD；null=非长度单位） */
export function normalizeLengthUnit(raw: string | null | undefined): LengthUnit | null {
  if (!raw) return null;
  return LENGTH_ALIASES[String(raw).trim().toLowerCase()] ?? null;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * 长度换算（M ↔ YD 双向精确）。
 * 非长度单位（PC/SET/KG 等）返回 null——调用方决定回退策略。
 */
export function convertLength(value: number, from: string | null | undefined, to: string | null | undefined): number | null {
  const f = normalizeLengthUnit(from);
  const t = normalizeLengthUnit(to);
  if (f == null || t == null || f === t) return f === t && f != null ? value : null;
  if (f === 'M' && t === 'YD') return round4(value / METERS_PER_YARD);
  return round4(value * METERS_PER_YARD); // YD → M
}

/**
 * 面料重量（公斤计价）：克重 × 门幅 × 长度 → kg
 * @param gsm      克重 g/m²（如 240）
 * @param widthCm  门幅 cm（如 150）
 * @param lengthM  长度 m
 * 公式：kg = gsm × (widthCm/100) × lengthM / 1000（round4）
 */
export function fabricWeightKg(gsm: number, widthCm: number, lengthM: number): number {
  if (!Number.isFinite(gsm) || !Number.isFinite(widthCm) || !Number.isFinite(lengthM)) return 0;
  if (gsm <= 0 || widthCm <= 0 || lengthM < 0) return 0;
  return round4((gsm * (widthCm / 100) * lengthM) / 1000);
}

/**
 * 按公斤计价反推长度（kg → m）：已知克重与门幅，从重量反推米数。
 * 结算场景：客户按公斤订量时换算回生产米数。
 */
export function lengthFromWeightKg(gsm: number, widthCm: number, weightKg: number): number {
  const perMeterKg = (gsm * (widthCm / 100)) / 1000;
  if (!Number.isFinite(perMeterKg) || perMeterKg <= 0 || !Number.isFinite(weightKg)) return 0;
  return round4(weightKg / perMeterKg);
}
