/**
 * fabricCalculatorService.ts — REQ2-22 面料计算器（IND-07 L1→L3，DR-062）
 *
 * 设计真源：docs/design/04-模块设计/09-业务工具/BusinessTools-业务工具/面料计算器.md
 *
 * DR-062 三决策：
 *   ① 后端单一真源纯函数（派生值后端算，前端只展示——对齐外贸工具派生值单一真源原则）
 *   ② 六类计算 kind 判别：weight-convert / yarn-convert / theoretical-weight /
 *      width-usage / roll-length / container-loading
 *   ③ 行业公式固定常量（物理/贸易标准，不做配置化）
 *
 * 零 DB 依赖、零写路径；route 薄 service 厚。
 */

// ── 行业常量（DR-062-③，推导见设计文档 §2/§3）──────────────────────
const OZ_PER_SQM = 33.9057; // 1 oz/yd² = 33.9057 g/m²（28.3495g ÷ 0.836127m²）
const COTTON_NE_PER_DENIER = 590.5; // Ne = 590.5/D（棉纱英支↔旦尼尔）
const LB_PER_KG = 2.20462;
const M_PER_YD = 0.9144;
const PER_10CM_TO_PER_IN = 3.937; // 10cm = 3.937in
/** 理论克重系数：gsm = (EPI/NeW + PPI/NeF) × 该系数（36×16/840 × 33.9057 = 23.2496） */
const THEORETICAL_GSM_FACTOR = (36 * 16 / 840) * OZ_PER_SQM;

/** 集装箱规格（行业通用：内尺寸/标称容积/实用容积/载重） */
export interface ContainerSpec {
  code: '20GP' | '40GP' | '40HQ';
  internal: { lengthM: number; widthM: number; heightM: number };
  volumeM3: number;
  usableVolumeM3: number;
  payloadKg: number;
}
export const CONTAINER_SPECS: Record<ContainerSpec['code'], ContainerSpec> = {
  '20GP': { code: '20GP', internal: { lengthM: 5.898, widthM: 2.352, heightM: 2.393 }, volumeM3: 33.2, usableVolumeM3: 28, payloadKg: 21700 },
  '40GP': { code: '40GP', internal: { lengthM: 12.032, widthM: 2.352, heightM: 2.393 }, volumeM3: 67.7, usableVolumeM3: 58, payloadKg: 26700 },
  '40HQ': { code: '40HQ', internal: { lengthM: 12.032, widthM: 2.352, heightM: 2.698 }, volumeM3: 76.4, usableVolumeM3: 68, payloadKg: 26580 },
};

// ── 校验工具（fail-closed：字段级错误信息）────────────────────────
/**
 * 计算器入参校验失败（S0-A Task 4 核定：补齐透传契约）
 *
 * 本类**早就带 `code`**，缺的是 `statusCode` ⇒ 在 `safeRouteError` / `resolveError` 眼里它不是
 * 业务错误，「字段 gsm 须为正数」这类给业务员看的文案会被兜成通用 500。补 `statusCode`（400）。
 * ★ 当前无活路径：`fabricCalculatorRoute:32` 自己按 `instanceof` 答 400，本契约是给接了真源的
 *   路径用的（潜在修复，不是已发生的用户可见故障）。
 * `code` 保持 `VALIDATION_FAILED` 不改名：`fabricCalculatorService.test.ts:26` 已把该值钉成契约，
 * 且 fabricCalculatorRoute 响应体外发的就是这个字面量，注册表里 `VALIDATION_FAILED` 也正是 400 ——
 * 改成 brief 表里的 `FABRIC_CALC_VALIDATION_FAILED` 无收益、只会打断既有断言并新增一个表里没有的码。
 * 两个字段都 `readonly`：与另外四个业务类（`CrmValidationError` / `SealValidationError` /
 * `StageGateError` / `GateBlockedError`）口径一致（评审 M-3）—— 外发契约不该在抛出后被改写。
 */
export class FabricCalcValidationError extends Error {
  readonly code = 'VALIDATION_FAILED' as const;
  readonly statusCode = 400 as const;
  constructor(message: string) { super(message); this.name = 'FabricCalcValidationError'; }
}

function reqNum(obj: Record<string, unknown>, field: string, opts: { min?: number; max?: number } = {}): number {
  const raw = obj[field];
  const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(v)) throw new FabricCalcValidationError(`字段 ${field} 必填且须为数字`);
  if (opts.min !== undefined && v < opts.min) throw new FabricCalcValidationError(`字段 ${field} 不得小于 ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new FabricCalcValidationError(`字段 ${field} 不得大于 ${opts.max}`);
  return v;
}

function optNum(obj: Record<string, unknown>, field: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const raw = obj[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  return reqNum(obj, field, opts);
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r1 = (v: number): number => Math.round(v * 10) / 10;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export type FabricCalcKind =
  | 'weight-convert'
  | 'yarn-convert'
  | 'theoretical-weight'
  | 'width-usage'
  | 'roll-length'
  | 'container-loading';

// ── ① 克重换算 ────────────────────────────────────────────────────
export interface WeightConvertInput { gsm?: number; ozyd?: number; widthCm?: number }
export interface WeightConvertResult {
  gsm: number; ozyd: number;
  gPerM: number | null; mPerKg: number | null; ydPerLb: number | null; widthCm: number | null;
}

export function calcWeightConvert(input: WeightConvertInput): WeightConvertResult {
  const widthCm = optNum(input as any, 'widthCm', { min: 0 });
  let gsm: number | null = null, ozyd: number | null = null;
  if (input.gsm !== undefined && input.gsm !== null && input.gsm !== ('' as any)) {
    gsm = reqNum(input as any, 'gsm', { min: 0 });
    ozyd = r2(gsm / OZ_PER_SQM);
  } else if (input.ozyd !== undefined && input.ozyd !== null && input.ozyd !== ('' as any)) {
    ozyd = reqNum(input as any, 'ozyd', { min: 0 });
    gsm = r1(ozyd * OZ_PER_SQM);
  } else {
    throw new FabricCalcValidationError('gsm 与 ozyd 至少提供一项');
  }
  if (widthCm !== undefined) {
    if (widthCm <= 0) throw new FabricCalcValidationError('字段 widthCm 须为正数');
    const widthM = widthCm / 100;
    const gPerM = gsm! * widthM;
    return {
      gsm: r1(gsm!), ozyd: ozyd!,
      gPerM: r1(gPerM), mPerKg: r2(1000 / gPerM), ydPerLb: r2(453.592 / (gPerM * M_PER_YD)),
      widthCm: r2(widthCm),
    };
  }
  return { gsm: r1(gsm!), ozyd: ozyd!, gPerM: null, mPerKg: null, ydPerLb: null, widthCm: null };
}

// ── ② 纱支换算（Ne 英支 / D 旦尼尔 / Nm 公支 / tex 特克斯）────────
export type YarnUnit = 'Ne' | 'D' | 'Nm' | 'tex';
const YARN_UNITS: YarnUnit[] = ['Ne', 'D', 'Nm', 'tex'];

/** 先归一到旦尼尔 D，再换算目标制 */
function yarnToDenier(value: number, from: YarnUnit): number {
  switch (from) {
    case 'D': return value;
    case 'Ne': return COTTON_NE_PER_DENIER / value; // D = 590.5/Ne
    case 'Nm': return 1000 / value; // D = 1000/Nm
    case 'tex': return 9 * value; // D = 9×tex
  }
}
function denierToYarn(d: number, to: YarnUnit): number {
  switch (to) {
    case 'D': return d;
    case 'Ne': return COTTON_NE_PER_DENIER / d;
    case 'Nm': return 1000 / d;
    case 'tex': return d / 9;
  }
}

export interface YarnConvertInput { value: number; from: YarnUnit; to?: YarnUnit }
export interface YarnConvertResult { from: YarnUnit; to?: YarnUnit; value: number; results: Record<YarnUnit, number> }

export function calcYarnConvert(input: YarnConvertInput): YarnConvertResult {
  const value = reqNum(input as any, 'value', { min: 0 });
  if (value <= 0) throw new FabricCalcValidationError('字段 value 须为正数');
  const from = input.from as YarnUnit;
  if (!YARN_UNITS.includes(from)) throw new FabricCalcValidationError(`字段 from 须为 ${YARN_UNITS.join('/')} 之一`);
  let to: YarnUnit | undefined = input.to as YarnUnit | undefined;
  if (to !== undefined && !YARN_UNITS.includes(to)) throw new FabricCalcValidationError(`字段 to 须为 ${YARN_UNITS.join('/')} 之一`);
  const d = yarnToDenier(value, from);
  const results = {
    Ne: r2(denierToYarnSafe(d, 'Ne')),
    D: r2(denierToYarnSafe(d, 'D')),
    Nm: r2(denierToYarnSafe(d, 'Nm')),
    tex: r2(denierToYarnSafe(d, 'tex')),
  };
  return { from, to, value, results };
}
// helper：极细纱（D→0）时公支/tex 可能爆 Infinity，防御性包装
function denierToYarnSafe(d: number, to: YarnUnit): number {
  const v = denierToYarn(d, to);
  return Number.isFinite(v) ? v : 0;
}

// ── ③ 理论克重 ────────────────────────────────────────────────────
export interface TheoreticalWeightInput {
  warpDensity: number; weftDensity: number; densityUnit?: 'per-in' | 'per-10cm';
  warpYarn: number; weftYarn: number; yarnUnit?: 'Ne' | 'D';
  shrinkFactor?: number;
}
export interface TheoreticalWeightResult {
  epi: number; ppi: number; warpNe: number; weftNe: number;
  theoreticalGsm: number; theoreticalOzyd: number; shrinkFactor: number;
}

export function calcTheoreticalWeight(input: TheoreticalWeightInput): TheoreticalWeightResult {
  const warpDensity = reqNum(input as any, 'warpDensity', { min: 0 });
  const weftDensity = reqNum(input as any, 'weftDensity', { min: 0 });
  if (warpDensity <= 0 || weftDensity <= 0) throw new FabricCalcValidationError('经纬密度须为正数');
  const densityUnit = input.densityUnit === 'per-10cm' ? 'per-10cm' : 'per-in';
  const warpYarn = reqNum(input as any, 'warpYarn', { min: 0 });
  const weftYarn = reqNum(input as any, 'weftYarn', { min: 0 });
  if (warpYarn <= 0 || weftYarn <= 0) throw new FabricCalcValidationError('经纬纱支须为正数');
  const yarnUnit = input.yarnUnit === 'D' ? 'D' : 'Ne';
  const shrinkFactor = optNum(input as any, 'shrinkFactor', { min: 0, max: 2 }) ?? 1;

  const epi = densityUnit === 'per-10cm' ? warpDensity / PER_10CM_TO_PER_IN : warpDensity;
  const ppi = densityUnit === 'per-10cm' ? weftDensity / PER_10CM_TO_PER_IN : weftDensity;
  const warpNe = yarnUnit === 'D' ? COTTON_NE_PER_DENIER / warpYarn : warpYarn;
  const weftNe = yarnUnit === 'D' ? COTTON_NE_PER_DENIER / weftYarn : weftYarn;

  const ozyd = (epi / warpNe + ppi / weftNe) * (24 / 35);
  const gsm = ozyd * OZ_PER_SQM * shrinkFactor;
  return {
    epi: r1(epi), ppi: r1(ppi), warpNe: r2(warpNe), weftNe: r2(weftNe),
    theoreticalGsm: r1(gsm), theoreticalOzyd: r2(ozyd), shrinkFactor: r2(shrinkFactor),
  };
}

// ── ④ 门幅与用料 ──────────────────────────────────────────────────
export interface WidthUsageInput {
  widthCm: number; edgeLossCm?: number; gsm: number; lengthPerPieceM: number; pieceAreaM2?: number;
}
export interface WidthUsageResult {
  widthCm: number; edgeLossCm: number; usableWidthCm: number;
  gPerM: number; mPerKg: number;
  pieceWeightKg: number; perThousandKg: number; perThousandM: number;
  utilizationPct: number | null;
}

export function calcWidthUsage(input: WidthUsageInput): WidthUsageResult {
  const widthCm = reqNum(input as any, 'widthCm', { min: 0 });
  if (widthCm <= 0) throw new FabricCalcValidationError('字段 widthCm 须为正数');
  const gsm = reqNum(input as any, 'gsm', { min: 0 });
  if (gsm <= 0) throw new FabricCalcValidationError('字段 gsm 须为正数');
  const lengthPerPieceM = reqNum(input as any, 'lengthPerPieceM', { min: 0 });
  if (lengthPerPieceM <= 0) throw new FabricCalcValidationError('字段 lengthPerPieceM 须为正数');
  const edgeLossCm = optNum(input as any, 'edgeLossCm', { min: 0 }) ?? 3;
  const pieceAreaM2 = optNum(input as any, 'pieceAreaM2', { min: 0 });

  const widthM = widthCm / 100;
  const gPerM = gsm * widthM;
  const usableWidthM = (widthCm - edgeLossCm) / 100;
  const utilizationPct = pieceAreaM2 !== undefined && usableWidthM > 0
    ? r1((pieceAreaM2 / (usableWidthM * lengthPerPieceM)) * 100)
    : null;
  return {
    widthCm: r2(widthCm), edgeLossCm: r2(edgeLossCm), usableWidthCm: r2(widthCm - edgeLossCm),
    gPerM: r1(gPerM), mPerKg: r2(1000 / gPerM),
    pieceWeightKg: r3(gPerM * lengthPerPieceM / 1000),
    perThousandKg: r1(gPerM * lengthPerPieceM), // 1000 件 × kg/件 = g/m × m（数值即得）
    perThousandM: r1(lengthPerPieceM * 1000),
    utilizationPct,
  };
}

// ── ⑤ 卷装匹长 ────────────────────────────────────────────────────
export interface RollLengthInput {
  gsm: number; widthCm: number;
  rollWeightKg?: number; lengthM?: number;
}
export interface RollLengthResult {
  mode: 'by-weight' | 'by-length';
  gsm: number; widthCm: number;
  lengthM: number; lengthYd: number;
  rollWeightKg: number; rollWeightLb: number;
  gPerM: number;
}

export function calcRollLength(input: RollLengthInput): RollLengthResult {
  const gsm = reqNum(input as any, 'gsm', { min: 0 });
  if (gsm <= 0) throw new FabricCalcValidationError('字段 gsm 须为正数');
  const widthCm = reqNum(input as any, 'widthCm', { min: 0 });
  if (widthCm <= 0) throw new FabricCalcValidationError('字段 widthCm 须为正数');
  const widthM = widthCm / 100;
  const gPerM = gsm * widthM;
  const rollWeightKg = optNum(input as any, 'rollWeightKg', { min: 0 });
  const lengthM = optNum(input as any, 'lengthM', { min: 0 });

  let mode: 'by-weight' | 'by-length';
  let weightKg: number, lenM: number;
  if (rollWeightKg !== undefined && lengthM === undefined) {
    mode = 'by-weight';
    weightKg = rollWeightKg;
    if (weightKg <= 0) throw new FabricCalcValidationError('字段 rollWeightKg 须为正数');
    lenM = (weightKg * 1000) / gPerM;
  } else if (lengthM !== undefined && rollWeightKg === undefined) {
    mode = 'by-length';
    lenM = lengthM;
    if (lenM <= 0) throw new FabricCalcValidationError('字段 lengthM 须为正数');
    weightKg = (gPerM * lenM) / 1000;
  } else {
    throw new FabricCalcValidationError('rollWeightKg 与 lengthM 须二选一（另一项留空由系统推算）');
  }
  return {
    mode, gsm: r1(gsm), widthCm: r2(widthCm),
    lengthM: r2(lenM), lengthYd: r2(lenM / M_PER_YD),
    rollWeightKg: r2(weightKg), rollWeightLb: r2(weightKg * LB_PER_KG),
    gPerM: r1(gPerM),
  };
}

// ── ⑥ 装柜计算 ────────────────────────────────────────────────────
export interface ContainerLoadingInput {
  containerType: ContainerSpec['code'];
  rollDiameterCm: number; rollWidthCm: number; rollWeightKg: number;
  gsm?: number; widthCm?: number;
  loadingEfficiency?: number; // 0-1，默认 0.9
}
export interface ContainerLoadingResult {
  container: ContainerSpec;
  rollVolumeM3: number;
  byVolume: number; byWeight: number;
  recommendedRolls: number; bindingConstraint: 'volume' | 'weight';
  rollLengthM: number | null;
  totalLengthM: number | null; totalLengthYd: number | null;
  totalWeightKg: number; totalVolumeM3: number;
  loadingEfficiency: number;
}

export function calcContainerLoading(input: ContainerLoadingInput): ContainerLoadingResult {
  const type = input.containerType;
  if (!(type in CONTAINER_SPECS)) throw new FabricCalcValidationError('字段 containerType 须为 20GP/40GP/40HQ 之一');
  const spec = CONTAINER_SPECS[type as ContainerSpec['code']];
  const rollDiameterCm = reqNum(input as any, 'rollDiameterCm', { min: 0 });
  const rollWidthCm = reqNum(input as any, 'rollWidthCm', { min: 0 });
  const rollWeightKg = reqNum(input as any, 'rollWeightKg', { min: 0 });
  if (rollDiameterCm <= 0 || rollWidthCm <= 0 || rollWeightKg <= 0) throw new FabricCalcValidationError('卷径/卷宽/卷重须为正数');
  const gsm = optNum(input as any, 'gsm', { min: 0 }) ?? undefined;
  const widthCm = optNum(input as any, 'widthCm', { min: 0 }) ?? undefined;
  if ((gsm !== undefined) !== (widthCm !== undefined)) throw new FabricCalcValidationError('推算匹长需同时提供 gsm 与 widthCm');
  const loadingEfficiency = optNum(input as any, 'loadingEfficiency', { min: 0, max: 1 }) ?? 0.9;

  const rollVolumeM3 = (Math.PI / 4) * (rollDiameterCm / 100) ** 2 * (rollWidthCm / 100);
  const byVolume = Math.floor((spec.usableVolumeM3 * loadingEfficiency) / rollVolumeM3);
  const byWeight = Math.floor(spec.payloadKg / rollWeightKg);
  const recommendedRolls = Math.min(byVolume, byWeight);
  const bindingConstraint: 'volume' | 'weight' = byVolume <= byWeight ? 'volume' : 'weight';

  const rollLengthM = gsm !== undefined && widthCm !== undefined && widthCm > 0
    ? r2((rollWeightKg * 1000) / (gsm * (widthCm / 100)))
    : null;

  return {
    container: spec,
    rollVolumeM3: r3(rollVolumeM3),
    byVolume, byWeight,
    recommendedRolls, bindingConstraint,
    rollLengthM,
    totalLengthM: rollLengthM !== null ? r1(recommendedRolls * rollLengthM) : null,
    totalLengthYd: rollLengthM !== null ? r1((recommendedRolls * rollLengthM) / M_PER_YD) : null,
    totalWeightKg: r1(recommendedRolls * rollWeightKg),
    totalVolumeM3: r2(recommendedRolls * rollVolumeM3),
    loadingEfficiency: r2(loadingEfficiency),
  };
}

// ── kind 判别总入口 ───────────────────────────────────────────────
export function calculateFabric(kind: string, input: Record<string, unknown>) {
  if (!input || typeof input !== 'object') throw new FabricCalcValidationError('input 必填');
  switch (kind) {
    case 'weight-convert': return calcWeightConvert(input as unknown as WeightConvertInput);
    case 'yarn-convert': return calcYarnConvert(input as unknown as YarnConvertInput);
    case 'theoretical-weight': return calcTheoreticalWeight(input as unknown as TheoreticalWeightInput);
    case 'width-usage': return calcWidthUsage(input as unknown as WidthUsageInput);
    case 'roll-length': return calcRollLength(input as unknown as RollLengthInput);
    case 'container-loading': return calcContainerLoading(input as unknown as ContainerLoadingInput);
    default: throw new FabricCalcValidationError(
      `kind 须为 weight-convert/yarn-convert/theoretical-weight/width-usage/roll-length/container-loading 之一，当前：${kind}`,
    );
  }
}
