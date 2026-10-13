/**
 * toleranceStandardService.ts — 公差标准取数链 + 双重判定（2026-09-29）
 *
 * 设计真源：`docs/inventory/公差标准机制-设计-2026-09-29.md`
 * 使用方拍板：
 *   · **R6.1 客户标准 = P0 硬约束**  · **R6.2 我方标准 = 辅助**
 *   · **R6.3 顺序：先自检（我方）→ 再客户标准**  · **J-1/J-11 每客户一套 + 我方一套 + 双重判定**
 *   · ★★ **不自动扣款**（扣不扣、扣多少由人定）⇒ 本服务**只判定、只建议，绝不写任何财务凭证**
 *   · 存储 = **A**（照抄 MOQ 先例）：客户标准 → `Relation.customerAgreementTolerance` JSONB；
 *     我方标准 → `SystemConfig`（`global::tolerance.internal_standard`）
 *
 * ── 取数链（命中即返回，照抄 `moq/moqResolutionService.ts` 的范式）──
 *   ① 行级 override —— ★ **白名单**：只有 `toleranceSource === 'line_override'` 才算
 *   ② **客户标准**   —— ★ P0 硬约束
 *   ③ **我方标准**   —— 辅助；★ 分两档：
 *       ③a 已录入的（`SystemConfig`）
 *       ③b **出厂默认**（`INTERNAL_TOLERANCE_DEFAULT`，2026-09-29 晚 Kevin 口径新增）
 *   ④ **无标准**     —— ★ 报「未判定」，**绝不静默回退 5%**
 *
 * ── ★★ 2026-09-29 晚 · 使用方（Kevin）新口径：内部标准要有**出厂默认值** ──
 *   原话：「你可以有一个默认值，就是即使公司没有去设置这个内部值，你也直接用这个。
 *          目前来讲，也可以看到很多参考的数值，就是他们这套比较合适的数值当做默认值就可以了。
 *          后续想要调整，你公司也可以再去重新设置。」
 *
 *   ⇒ 由此**推翻**了同日上午的另一条拍板（"我方标准先留空，只建机制"）—— 旧口径的后果是：
 *     ①②③ 三层全空 ⇒ 每一行都落第 ④ 层 ⇒ **出运门禁把任何溢装一律卡死**，而业务侧没有任何自解手段。
 *   ⇒ 现在的行为：**公司没录 ⇒ 直接用出厂默认**（`source='internal_default'`，**显式标注**，不是静默）。
 *
 *   ★★ 三条不能省的边界（否则这条默认值会变成下一处"系统假设冒充合同条款"）：
 *     1. **必须与客户标准可区分**：出厂默认只能落在第 ③ 层，**永远不许**冒充客户的 P0 约束
 *        —— 客户那一轨的判定里**禁用**本默认（见 `evaluateToleranceDual` 里那个 `allowInternalDefault:false`，
 *        少写这一句，"客户侧合规"就会用我们自己编的数去判，正是本机制要修的病的同型）。
 *     2. **必须显式标注来源**：`source='internal_default'` 与会话里的 `notices` 都要点名"这是出厂默认，
 *        不是任何人录的标准、也不是客户的约定" ⇒ 界面据此显示，人才能发现"我该去调一下"。
 *     3. **"读不到"仍然不许套默认**：配置**存在但读失败/解析不出**时按「未判定」处理（不降级）——
 *        否则一次 DB 抖动就会把公司已录的更严标准**悄悄放宽**成出厂默认（方向是放行更多货）。
 *
 * ── 两条硬边界 ──
 *  1. ★★ **「没有标准」≠「读不到标准」**：客户标准是 P0，读不到时**不许降级**（降级＝当"没约束"
 *     ⇒ 可能放行超合同出运 ⇒ 数字错）。故本服务用 `*Unavailable` 标志把两者分开表达。
 *  2. ★★ **档位表有重叠时不许静默取第一档** —— 重叠是标准表本身的错，必须显式告知
 *     （`ambiguousBands`），否则就是"同时命中却静默丢一半"。
 */
import type { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { createSystemConfigService } from '../config/systemConfigService';
import { checkTolerance, type ToleranceCheckResult, type ToleranceVerdict } from './toleranceCore';

// ───────────────────────────────────────────────────────────────────
// 类型
// ───────────────────────────────────────────────────────────────────

/** 标准对象：数量公差 / 幅宽扣款（同一分档形状，只是度量值不同） */
export type ToleranceSubject = 'qtyTolerance' | 'widthDeduction';

export interface ToleranceBand {
  /** 档位下界（**含**） */
  minQty: number;
  /** 档位上界（**含**）；`null` = 上不封顶 */
  maxQty: number | null;
  /** 该档的百分比（数量公差 = ±N% 的 N；幅宽扣款 = 扣款比例） */
  pct: number;
}

export interface ToleranceStandardSet {
  /** 数量公差分档（按合同量选档） */
  qtyTolerance?: ToleranceBand[];
  /**
   * 幅宽扣款比例分档（按**幅宽偏差 %** 选档）。
   *
   * ⚠️ 量纲口径（2026-09-29 晚更正，**修前是错的**）：修前这里写的是"按幅宽选档"，
   *   实现也按**幅宽绝对值**（cm）选档（见当时的测试 `measure:145` 配 `140–150` 档）。
   *   但客户标准的**原文**是按偏差分档：
   *   「可用幅宽 ≥147CM；窄幅索赔扣款：偏差 ≤3%→扣10% · ≤4.5%→扣25% · ≤6%→扣30%」
   *   ⇒ 按绝对值选档无法表达这条规则（各客户基准幅宽不同，147/150/…），
   *     而且录入时得先把每个客户的标准换算成 cm 区间 —— 换算一次就多一次错的机会。
   *   ⇒ **现在 = 偏差百分比**（0–3 → 扣 10；3–4.5 → 扣 25；4.5–6 → 扣 30）。
   *   ★ 界值归**较低扣款档**（"≤3%"的 ≤ 就是这个意思）：档位按升序录，引擎取第一档命中并报重叠提示。
   */
  widthDeduction?: ToleranceBand[];
  /** 约定日期（依据留痕） */
  agreementDate?: string;
  /** 依据（哪份 PO / 合同） */
  agreementRef?: string;
}

export type ToleranceSource =
  | 'line_override'      // ① 行级 override（人明确改过）
  | 'customer_standard'  // ② 客户标准（★ P0）
  | 'internal_standard'  // ③a 我方标准（辅助，**已录入**）
  | 'internal_default'   // ③b 我方标准（辅助，**出厂默认**，公司尚未录入）
  | 'none';              // ④ 无标准 ⇒ 未判定

/** ★ 唯一合法的 override 来源标记；其它值（含 NULL）一律不算 override */
export const LINE_OVERRIDE_SOURCE = 'line_override';

export const TOLERANCE_SOURCE_LABELS: Record<ToleranceSource, string> = {
  line_override: '行级覆盖',
  customer_standard: '客户标准',
  internal_standard: '我方标准',
  internal_default: '我方标准（出厂默认）',
  none: '无标准',
};

/** 我方标准在 SystemConfig 里的落点 */
export const INTERNAL_TOLERANCE_SCOPE = 'global';
export const INTERNAL_TOLERANCE_KEY = 'tolerance.internal_standard';

/**
 * ★★ **出厂默认**的内部公差标准（2026-09-29 晚 · Kevin 口径：「即使公司没有去设置这个内部值，
 *   你也直接用这个…拿他们这套比较合适的数值当做默认值就可以了」）。
 *
 * 数值来源：真实 PO 的分档（1–999m ±5% · 1000–3000m ±3% · 3001–5000m ±2% · 5001m+ ±1%）。
 * ★ **声明**：那一套是**某一个客户**的标准（R15）⇒ 它现在只是**我方的出厂假设**，
 *   不是任何客户的合同约定、也不是本公司已确认的内部制度；公司一旦在
 *   「设置 → 平台规则 → 内部公差标准」里录入，本默认**立即失效**（配置优先）。
 *
 * ★ 两处刻意的取舍（都不是手滑）：
 *   1. 首档下界取 **0**（PO 原文是 1）—— 否则数量 < 1 的行会落进"档位空档"⇒ 报未判定 ⇒ 又回到"按 0 卡"。
 *   2. **不设 `widthDeduction`** —— 幅宽扣款没有可引用的参考数值，宁可不给（报未判定）
 *      也不凭一个编的数去建议扣款（R6「扣不扣、扣多少由人定」）。
 */
export const INTERNAL_TOLERANCE_DEFAULT: ToleranceStandardSet = {
  qtyTolerance: [
    { minQty: 0, maxQty: 999, pct: 5 },
    { minQty: 1000, maxQty: 3000, pct: 3 },
    { minQty: 3001, maxQty: 5000, pct: 2 },
    { minQty: 5001, maxQty: null, pct: 1 },
  ],
};

/** 出厂默认的**人类可读**指纹（上屏时必须带上，别让人以为这是谁录的标准） */
export function describeInternalDefault(subject: ToleranceSubject): string | null {
  const bands = bandsOf(INTERNAL_TOLERANCE_DEFAULT, subject);
  if (!bands) return null;
  return bands
    .map((b) => `${b.minQty}–${b.maxQty == null ? '不限' : b.maxQty} → ±${b.pct}%`)
    .join(' · ');
}

// ───────────────────────────────────────────────────────────────────
// 纯函数：档位选择
// ───────────────────────────────────────────────────────────────────

export interface BandMatch {
  band: ToleranceBand | null;
  /** ★ 同时命中的**其它**档位（非空 ⇒ 标准表有重叠，调用方必须显式告知，不许静默取第一档） */
  ambiguous: ToleranceBand[];
}

/**
 * 按度量值选档（**纯函数**）。
 * ★ 落进空档（前后两档之间有缝）⇒ 返回 `band: null` —— 这是"标准表没覆盖到"，
 *   **不是**"没有标准"，调用方据此报未判定，**不许回退到某个默认百分比**。
 */
export function pickBand(bands: ToleranceBand[] | null | undefined, measure: number): BandMatch {
  if (!bands || !bands.length) return { band: null, ambiguous: [] };
  if (!Number.isFinite(measure)) return { band: null, ambiguous: [] };
  const hits = bands.filter(
    (b) =>
      Number.isFinite(b.minQty) &&
      Number.isFinite(b.pct) &&
      measure >= b.minQty &&
      (b.maxQty == null || measure <= b.maxQty),
  );
  if (!hits.length) return { band: null, ambiguous: [] };
  return { band: hits[0], ambiguous: hits.slice(1) };
}

// ───────────────────────────────────────────────────────────────────
// 纯函数：归一化（容错解析 JSON，绝不 throw）
// ───────────────────────────────────────────────────────────────────

function toPct(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeBands(raw: unknown): ToleranceBand[] | null {
  if (!Array.isArray(raw)) return null;
  const bands: ToleranceBand[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const r = it as Record<string, unknown>;
    const minQty = Number(r.minQty);
    const pct = Number(r.pct);
    if (!Number.isFinite(minQty) || !Number.isFinite(pct) || pct < 0) continue;
    const maxRaw = r.maxQty;
    const maxQty = maxRaw == null || maxRaw === '' ? null : Number(maxRaw);
    if (maxQty != null && !Number.isFinite(maxQty)) continue;
    bands.push({ minQty, maxQty, pct });
  }
  return bands.length ? bands : null;
}

/** 归一化标准集；**一个可用档位都没有** ⇒ 返回 `null`（= 没有标准），不是空壳对象 */
export function normalizeStandardSet(raw: unknown): ToleranceStandardSet | null {
  // ★★ 2026-09-29：`SystemConfig` 在 `valueType='json'` 时**把值存成 JSON 字符串**
  //   （见 `config/systemConfigService.ts` 的 `set()`：`JSON.stringify(value)`），
  //   而 `Relation.customerAgreementTolerance` 是真 JSONB（读出来就是对象）。
  //   ⇒ 两个来源的"落地形态"不同，这里按**各自真实的存储契约**都认，不是防某个 bug。
  let v: unknown = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: ToleranceStandardSet = {};
  const qt = normalizeBands(o.qtyTolerance);
  if (qt) out.qtyTolerance = qt;
  const wd = normalizeBands(o.widthDeduction);
  if (wd) out.widthDeduction = wd;
  if (typeof o.agreementDate === 'string') out.agreementDate = o.agreementDate;
  if (typeof o.agreementRef === 'string') out.agreementRef = o.agreementRef;
  return out.qtyTolerance || out.widthDeduction ? out : null;
}

function bandsOf(set: ToleranceStandardSet | null | undefined, subject: ToleranceSubject): ToleranceBand[] | null {
  const b = set?.[subject];
  return Array.isArray(b) && b.length ? b : null;
}

// ───────────────────────────────────────────────────────────────────
// 纯函数：取数链
// ───────────────────────────────────────────────────────────────────

export interface ResolveTolerancePctInput {
  subject: ToleranceSubject;
  /** 用于选档的度量值（数量公差 → 合同量；幅宽扣款 → 幅宽） */
  measure: number;
  /**
   * 行上的值与其来源。★ **只有 `source === 'line_override'` 才进取数第 ① 层**；
   * `source` 为 NULL（存量 106 行的常态）⇒ 视为「不是人定的」，**不进 override 层**。
   * 同时 `pct` 会被带回 `referencePct`，只作**参考**显示。
   */
  lineOverride?: { pct?: unknown; source?: string | null } | null;
  customerStandard?: ToleranceStandardSet | null;
  /** ★ 客户**有**标准但读取失败 ⇒ 必须显式传 `true`（本服务据此**拒绝降级**） */
  customerStandardUnavailable?: boolean;
  internalStandard?: ToleranceStandardSet | null;
  /** 我方标准读取失败（辅助项，不阻断，只记 notice） */
  internalStandardUnavailable?: boolean;
  /**
   * ★★ 是否允许「公司没录内部标准 ⇒ 用**出厂默认**」（`INTERNAL_TOLERANCE_DEFAULT`）。
   * 缺省 `true` —— 这是 2026-09-29 晚 Kevin 的口径（不让整个门禁因为"没人录"而一律卡死）。
   *
   * ⚠️ **唯一必须显式传 `false` 的地方**：`evaluateToleranceDual` 里算**客户侧**判定的那一遍。
   *   客户侧问的是"合不合**客户**的标准"；拿我方的出厂默认去回答它，
   *   就会让"客户标准未知"变成一句"合格" —— 那正是本机制要修的病的同型（系统假设冒充合同条款）。
   */
  allowInternalDefault?: boolean;
}

export interface ResolveTolerancePctResult {
  /** 命中的百分比；`null` = **未判定** */
  pct: number | null;
  source: ToleranceSource;
  /** 是否**硬约束**（客户标准 / 行级覆盖 = true；我方标准 = false） */
  hard: boolean;
  /** 命中的档位（override 时为 null） */
  band: ToleranceBand | null;
  /** ★ 同时命中的其它档位（非空 ⇒ 标准表重叠，界面必须提示） */
  ambiguousBands: ToleranceBand[];
  /** `pct === null` 的原因（说人话，可直接上屏） */
  unresolvedReason: string | null;
  /**
   * ★ **参考值**：取不到标准时，行上那个数是「**系统默认填的**」，仅作参照，**不是合同约定**。
   * 界面必须连同「非合同约定」四个字一起显示。
   */
  referencePct: number | null;
  /** 非致命的提示（重叠档位 / 我方标准读不到 / 空档 …） */
  notices: string[];
}

export function resolveTolerancePct(input: ResolveTolerancePctInput): ResolveTolerancePctResult {
  const notices: string[] = [];
  const ref = toPct(input.lineOverride?.pct);

  // ★★ 「读不到」是**输入的事实**，与"最终命中哪一层"无关 ⇒ **必须在最前面就记下来**。
  //   否则一旦第 ①/② 层命中就提前 return，调用方永远不知道标准其实没读全。
  if (input.customerStandardUnavailable) {
    notices.push('★ 该客户**已有**公差标准，但本次读取失败 —— 本项按「未判定」处理，**不降级**');
  }
  if (input.internalStandardUnavailable) {
    notices.push('我方标准**读取失败**（辅助项，不阻断判定）');
  }

  // ── 层 ①：行级 override（★ 白名单：只有 'line_override' 算） ──
  if (input.lineOverride?.source === LINE_OVERRIDE_SOURCE) {
    const ov = toPct(input.lineOverride.pct);
    if (ov != null) {
      return {
        pct: ov, source: 'line_override', hard: true, band: null, ambiguousBands: [],
        unresolvedReason: null, referencePct: null, notices,
      };
    }
  }

  // ── 层 ②：客户标准（★ P0 硬约束） ──
  if (input.customerStandardUnavailable) {
    // ★★ 有标准但读不到 ⇒ 拒绝降级（当"没约束"会放行超合同出运）
    return {
      pct: null, source: 'none', hard: false, band: null, ambiguousBands: [],
      unresolvedReason:
        '该客户已有公差标准，但本次**读取失败** —— 不能按「无标准」处理，请重试或联系管理员（★ 不降级是刻意的）',
      referencePct: ref, notices,
    };
  }
  const cBands = bandsOf(input.customerStandard, input.subject);
  if (cBands) {
    const m = pickBand(cBands, input.measure);
    if (m.band) {
      if (m.ambiguous.length) {
        notices.push(
          `★ 客户标准表**档位重叠**：本次同时命中 ${1 + m.ambiguous.length} 档，已取第一档（minQty=${m.band.minQty}）—— 请修标准表`,
        );
      }
      return {
        pct: m.band.pct, source: 'customer_standard', hard: true, band: m.band,
        ambiguousBands: m.ambiguous, unresolvedReason: null, referencePct: null, notices,
      };
    }
    notices.push('客户标准表存在，但本次度量值落在**档位空档**内');
  }

  // ── 层 ③：我方标准（辅助）──
  //   ③a 已录入的 ⇒ internal_standard；③b 没录 ⇒ 出厂默认 internal_default（Kevin 口径，见文件头）
  // ★ 「我方标准读不到」的 notice 已在函数开头统一记下，此处不再重复
  const allowDefault = input.allowInternalDefault !== false;
  if (!input.internalStandardUnavailable) {
    const configured = bandsOf(input.internalStandard, input.subject);
    const fallback = configured ? null : bandsOf(allowDefault ? INTERNAL_TOLERANCE_DEFAULT : null, input.subject);
    const iBands = configured ?? fallback;
    const isBuiltin = !configured && !!fallback;
    if (iBands) {
      const m = pickBand(iBands, input.measure);
      if (m.band) {
        if (m.ambiguous.length) {
          notices.push(`★ 我方标准表**档位重叠**：本次同时命中 ${1 + m.ambiguous.length} 档，已取第一档`);
        }
        if (isBuiltin) {
          // ★ 必须显式点名：这是**出厂默认**，既不是谁录的标准、更不是客户的约定
          notices.push(
            `★ 内部公差标准**尚未录入** ⇒ 本次按**出厂默认**取数（${describeInternalDefault(input.subject) ?? ''}）` +
              '；这是系统出厂假设，**不是客户约定** —— 可在「设置 → 平台规则 → 内部公差标准」里调整',
          );
        }
        return {
          pct: m.band.pct,
          source: isBuiltin ? 'internal_default' : 'internal_standard',
          hard: false,
          band: m.band,
          ambiguousBands: m.ambiguous,
          unresolvedReason: null,
          referencePct: null,
          notices,
        };
      }
      notices.push(
        isBuiltin
          ? '出厂默认标准表存在，但本次度量值落在**档位空档**内（请检查数量单位是否合理）'
          : '我方标准表存在，但本次度量值落在**档位空档**内',
      );
    }
  }

  // ── 层 ④：无标准 ⇒ **未判定**（★ 绝不静默取 5%） ──
  return {
    pct: null, source: 'none', hard: false, band: null, ambiguousBands: [],
    unresolvedReason: allowDefault
      ? '本项**无可用标准**（该客户未录；我方标准读不到或本次度量值落在档位空档内）—— 请复核标准表'
      : '本项**无客户标准**（该客户未录）—— 请补录客户标准',
    referencePct: ref, notices,
  };
}

// ───────────────────────────────────────────────────────────────────
// 双重判定
// ───────────────────────────────────────────────────────────────────

export type CombinedToleranceVerdict = 'hard_violation' | 'internal_warning' | 'ok' | 'undetermined';

export interface ToleranceDualVerdict {
  /** 辅助侧：**我方标准**（★ R6.3 要求**先自检**，故先算它） */
  internal: { resolved: ResolveTolerancePctResult; check: ToleranceCheckResult | null; verdict: ToleranceVerdict | null };
  /** ★ P0 侧：**客户标准** */
  customer: { resolved: ResolveTolerancePctResult; check: ToleranceCheckResult | null; verdict: ToleranceVerdict | null };
  combined: { verdict: CombinedToleranceVerdict; headline: string; detail: string };
  /** 两侧 notice 合并（去重保序） */
  notices: string[];
}

export interface EvaluateToleranceDualInput {
  contractQty: number;
  actualQty: number;
  unitPrice?: number | null;
  subject: ToleranceSubject;
  /** 选档用的度量值（数量公差 → 合同量；幅宽扣款 → 幅宽）。缺省用 `contractQty` */
  measure?: number;
  lineOverride?: { pct?: unknown; source?: string | null } | null;
  customerStandard?: ToleranceStandardSet | null;
  customerStandardUnavailable?: boolean;
  internalStandard?: ToleranceStandardSet | null;
  internalStandardUnavailable?: boolean;
  /** 见 `ResolveTolerancePctInput.allowInternalDefault`（★ 客户侧那一遍恒为 `false`，不受本字段影响） */
  allowInternalDefault?: boolean;
}

function runCheck(
  r: ResolveTolerancePctResult,
  contractQty: number,
  actualQty: number,
  unitPrice: number | null | undefined,
): ToleranceCheckResult | null {
  if (r.pct == null) return null;
  return checkTolerance({
    contractQty,
    actualQty,
    tolerancePercent: r.pct,
    unitPrice: unitPrice != null ? Number(unitPrice) : null,
  });
}

/**
 * **双重判定**（★ 两侧各自独立算，**不合取**）：
 *   · 「先自检」是**工作顺序**（先算我方），「客户 P0」是**约束力** —— 两个不同的轴。
 *   · ★ 客户标准**不许被我方标准放宽**（否则又放行超合同出运），也**不许被我方标准收紧**
 *     （我方是辅助，不能反过来卡客户）。
 */
export function evaluateToleranceDual(input: EvaluateToleranceDualInput): ToleranceDualVerdict {
  const measure = input.measure ?? input.contractQty;
  const base = {
    subject: input.subject,
    measure,
    lineOverride: input.lineOverride ?? null,
    customerStandard: input.customerStandard ?? null,
    customerStandardUnavailable: !!input.customerStandardUnavailable,
    internalStandard: input.internalStandard ?? null,
    internalStandardUnavailable: !!input.internalStandardUnavailable,
  };

  // ★ 顺序：**先自检**（我方）→ 再客户标准
  //   ★ 「自检」这一遍**允许**出厂默认：公司没录内部标准时，自检仍有可用的我方口径。
  const internalResolved = resolveTolerancePct({
    ...base,
    customerStandard: null,
    customerStandardUnavailable: false,
    allowInternalDefault: input.allowInternalDefault !== false,
  });
  const customerResolved = resolveTolerancePct({
    ...base,
    // ★ 自检那一遍**只**用我方标准；客户那一遍**只**用客户标准（两侧互不借用，才叫双重）
    internalStandard: null,
    internalStandardUnavailable: false,
    /**
     * ★★ `allowInternalDefault: false` —— 这一句**不能少**（2026-09-29 晚加默认值时必须同时加它）。
     *   起因：客户侧那一遍的 `internalStandard` 被显式置空（故意的，见上），
     *   于是③b 出厂默认会**兜底命中** ⇒ 客户侧拿到一个"我方编的数"并判成 `ok`
     *   ⇒ 「客户标准未知」被静默渲染成「合格」。那正是本机制要修的病的同型。
     *   ⇒ 客户侧判不了就必须老实说"判不了"（`cV === null` ⇒ combined 落 `undetermined`）。
     */
    allowInternalDefault: false,
  });

  const internalCheck = runCheck(internalResolved, input.contractQty, input.actualQty, input.unitPrice);
  const customerCheck = runCheck(customerResolved, input.contractQty, input.actualQty, input.unitPrice);

  const cV = customerCheck?.verdict ?? null;
  const iV = internalCheck?.verdict ?? null;

  let verdict: CombinedToleranceVerdict;
  let headline: string;
  let detail: string;

  if (cV === 'over_limit' || cV === 'under_limit') {
    verdict = 'hard_violation';
    headline = cV === 'over_limit' ? '硬违规：超出**客户标准**（溢装）' : '硬违规：超出**客户标准**（短装）';
    detail = customerCheck?.warning ?? '';
  } else if (iV === 'over_limit' || iV === 'under_limit') {
    verdict = 'internal_warning';
    // ★ 标明用的是哪一套（已录的我方标准 / 出厂默认）——「展示必须标明每一条用了哪套标准」
    headline =
      internalResolved.source === 'internal_default'
        ? '内部预警：超出**我方出厂默认标准**（客户标准未超）'
        : '内部预警：超出**我方标准**（客户标准未超）';
    detail = internalCheck?.warning ?? '';
  } else if (cV === 'ok') {
    verdict = 'ok';
    headline = '合格：客户标准与我方标准均未超限';
    detail = '';
  } else {
    /**
     * ★ 客户侧判不了 ⇒ **不许**声称合格（客户标准未知时"没超"是没依据的）。
     * ★ 2026-09-29 晚：出厂默认上线后，这里最常见的形态是「我方侧已通过、客户侧没录标准」——
     *   此时**仍然**只能是 `undetermined`，因为门禁按哪一套放行 ≠ 客户是否同意。
     *   两个问题分开回答：门禁问"能不能放行"，本判定问"合不合客户的标准"。
     */
    verdict = 'undetermined';
    headline = iV === 'ok' ? '未判定：**客户**标准未录（我方侧已通过，但客户侧无从判定）' : '未判定：无可用标准';
    detail = [customerResolved.unresolvedReason, internalResolved.unresolvedReason]
      .filter(Boolean)
      .join(' / ');
  }

  const notices = [...new Set([...internalResolved.notices, ...customerResolved.notices])];

  return {
    internal: { resolved: internalResolved, check: internalCheck, verdict: iV },
    customer: { resolved: customerResolved, check: customerCheck, verdict: cV },
    combined: { verdict, headline, detail },
    notices,
  };
}

// ───────────────────────────────────────────────────────────────────
// 门禁口径（★★ 唯一一处决定「未判定怎么办」）
// ───────────────────────────────────────────────────────────────────

/**
 * ★★ 「未判定」时门禁按多少百分比卡 —— **单一常量**，便于审计与讨论。
 *
 * ★ 2026-09-29 晚（出厂默认上线后）：正常情况**不该再走到这里** —— 客户没录 → 我方的已录/出厂默认兜底。
 * 剩下的三条路径都会落到这里（都不是"没人录"）：① 客户标准**存在但读不到**（不降级是刻意的）
 * ② 内部标准**配置损坏** ③ 本次数量落在我方标准表的**档位空档**外。
 * ⇒ 按 **0** 卡（= 上限就是合同量，不放溢装）—— 方向与 ① 类缺陷（不放出超合同货）一致。
 * ★ 反例：若在这里回退成 5%，就等于**继续用系统的默认假设冒充合同条款** —— 那正是要修的病。
 *   （注意与 `INTERNAL_TOLERANCE_DEFAULT` 的区别：那一条是**显式标注**的第③b 层，不是这里的静默回退。）
 */
export const UNRESOLVED_GATE_PCT = 0;

export interface GateTolerance {
  /** 用来算 allowedMax 的百分比 */
  pct: number;
  /** 是否硬约束（客户标准 / 行级覆盖 = true；内部标准 = false） */
  hard: boolean;
  source: ToleranceSource;
  /** 非空 ⇒ 本次是「未判定」降级（调用方**必须**把这句话带到界面/错误消息里） */
  unresolvedReason: string | null;
  notices: string[];
  /** 给错误消息用的中文说明；未判定时非空 */
  gateNote: string | null;
}

/**
 * ★★ **门禁唯一入口**：把取数结果落成"能算上限的百分比"。
 * 两个消费方（出运上限门禁 / 订单视图）都从这里取口径 ⇒ **不可能再各写各的回退值**
 * （修前：`allocationService` 空 → 0、`toleranceService` 空 → 5，同一字段两个结论）。
 */
export function gateToleranceOf(r: ResolveTolerancePctResult): GateTolerance {
  if (r.pct != null) {
    return { pct: r.pct, hard: r.hard, source: r.source, unresolvedReason: null, notices: r.notices, gateNote: null };
  }
  return {
    pct: UNRESOLVED_GATE_PCT,
    hard: false,
    source: 'none',
    unresolvedReason: r.unresolvedReason,
    notices: r.notices,
    gateNote:
      '★ 本订单行**没有可用的公差标准** ⇒ 已按**不放溢装**处理（上限 = 合同量）。' +
      '可能原因：① 该客户标准**存在但读不到**（不降级是刻意的）② 内部标准配置损坏 ' +
      '③ 本次数量落在我方标准表的档位空档外。' +
      '请到「设置 → 平台规则 → **内部公差标准**」核对本公司标准，并在**该客户档案**里补录/核对该客户的客户标准。',
  };
}

/** 订单行上"容差那两个字段"的最小形状（`OrderLine` 满足它） */
export interface ToleranceLineLike {
  tolerancePercent?: unknown;
  toleranceSource?: string | null;
}

/** 把「一行订单行 + 已加载的标准」解析成取数结果（消费方统一走这里） */
export function resolveLineTolerance(
  line: ToleranceLineLike,
  loaded: LoadedToleranceStandards,
  args: { subject?: ToleranceSubject; measure: number },
): ResolveTolerancePctResult {
  return resolveTolerancePct({
    subject: args.subject ?? 'qtyTolerance',
    measure: args.measure,
    lineOverride: { pct: line.tolerancePercent, source: line.toleranceSource ?? null },
    customerStandard: loaded.customerStandard,
    customerStandardUnavailable: loaded.customerStandardUnavailable,
    internalStandard: loaded.internalStandard,
    internalStandardUnavailable: loaded.internalStandardUnavailable,
  });
}

// ───────────────────────────────────────────────────────────────────
// 建议扣款额（★ 只建议，不落账）
// ───────────────────────────────────────────────────────────────────

/**
 * ★★ **本函数只算"建议"，不写任何东西** —— 使用方 R6 明确「扣不扣、扣多少由人定」。
 * 返回 `amount` 仅供人参考；落不落账、落多少，由人决定。
 */
export function suggestWidthDeduction(args: {
  /** 计算基数（如该行金额） */
  amount: number | null | undefined;
  /** 扣款比例（百分数，如 3 表示 3%） */
  pct: number | null | undefined;
}): { amount: number | null; basis: string } {
  const amt = args.amount != null && Number.isFinite(Number(args.amount)) ? Number(args.amount) : null;
  const pct = toPct(args.pct);
  if (amt == null || pct == null) {
    return { amount: null, basis: '缺基数或比例 ⇒ 无法建议（★ 不猜）' };
  }
  return {
    amount: Math.round(amt * (pct / 100) * 10000) / 10000,
    basis: `建议扣款 = 基数 ${amt} × ${pct}%（★ 仅供人参考，**不自动落账**）`,
  };
}

// ───────────────────────────────────────────────────────────────────
// 幅宽扣款（窄幅索赔）—— 偏差 + 比例 + 建议额（★ 只建议，不落账）
// ───────────────────────────────────────────────────────────────────

/** 幅宽偏差（%）：**正数 = 比基准窄**（我们关心的方向）；基准缺失/非法 ⇒ `null`（不猜） */
export function widthDeviationPct(
  basisWidthCm: unknown,
  measuredWidthCm: unknown,
): number | null {
  const b = Number(basisWidthCm);
  const m = Number(measuredWidthCm);
  if (!Number.isFinite(b) || !Number.isFinite(m) || b <= 0) return null;
  return Math.round(((b - m) / b) * 1000000) / 10000;
}

export type WidthDeductionVerdict =
  /** 够宽（偏差 ≤ 0）⇒ 不扣 */
  | 'ok'
  /** 窄了且算得出扣款比例 */
  | 'deduct'
  /** 算不出（缺数据 / 未录标准 / 落在档位空档）★ 不许当成 0 扣款 */
  | 'undetermined';

export interface WidthDeductionEvaluation {
  basisWidthCm: number | null;
  measuredWidthCm: number | null;
  /** 幅宽偏差 %（正数 = 窄于基准） */
  deviationPct: number | null;
  /** 扣款比例（%）；`null` = 算不出 */
  pct: number | null;
  source: ToleranceSource;
  /** ★ 建议扣款额（基数 = **该订单行的货款金额**，使用方 2026-09-29 拍）—— 仅供人参考，**不落账** */
  suggestedAmount: number | null;
  /** ★ 计算基数原值（订单行货款金额，`OrderLine.netValue` 真源） */
  baseAmount: number | null;
  verdict: WidthDeductionVerdict;
  /** 人话结论（可直接上屏） */
  headline: string;
  /** 算不出的原因（说人话 + 下一步）；`verdict !== 'undetermined'` 时为 `null` */
  unresolvedReason: string | null;
  notices: string[];
}

/**
 * ★ **纯函数**：幅宽扣款判定（口径唯一出处）。不写任何东西。
 *
 * 输入里的 `tolerance` 必须是**与数量公差同一套解析器**出来的结果
 * （`resolveLineTolerance(line, loaded, { subject: 'widthDeduction', measure: 偏差% })` → `gateToleranceOf(...)`）：
 * ★★ 幅宽扣款**没有出厂默认**（`INTERNAL_TOLERANCE_DEFAULT` 刻意不设 widthDeduction）⇒
 *    客户没录、我方也没录时**必须**报「未判定」，不许顺手给个"合理的"扣款比例。
 */
export function evaluateWidthDeduction(input: {
  basisWidthCm: unknown;
  measuredWidthCm: unknown;
  /** 计算基数 = 该订单行货款金额（`OrderLine.netValue`）；缺 ⇒ 只给比例不给金额 */
  lineNetValue?: unknown;
  /** 与数量公差共用同一条标准链的解析结果 */
  tolerance: GateTolerance;
}): WidthDeductionEvaluation {
  const basis = Number(input.basisWidthCm);
  const measured = Number(input.measuredWidthCm);
  const baseAmount =
    input.lineNetValue != null && Number.isFinite(Number(input.lineNetValue))
      ? Number(input.lineNetValue)
      : null;
  const notices = [...(input.tolerance.notices ?? [])];
  // ⓘ 刻意**不**把 `gateNote` 抄进来：那句话是**数量**口径的（"按不放溢装处理、上限 = 合同量"），
  //   挪到幅宽语境里就是另一件错事（本仓通病：文案跟着错误的语境走）。幅宽这边的下一步写在下面。

  const dev = widthDeviationPct(input.basisWidthCm, input.measuredWidthCm);
  if (dev == null) {
    return {
      basisWidthCm: Number.isFinite(basis) && basis > 0 ? basis : null,
      measuredWidthCm: Number.isFinite(measured) ? measured : null,
      deviationPct: null,
      pct: null,
      source: 'none',
      suggestedAmount: null,
      baseAmount,
      verdict: 'undetermined',
      headline: '未判定：缺幅宽数据',
      unresolvedReason:
        '缺少**基准幅宽**或**实测幅宽**（基准必须 > 0）⇒ 算不出偏差 —— 请先在 QC 查货记录里把这两个数填上（★ 不拿别处的默认幅宽替它猜）。',
      notices,
    };
  }

  // ── 够宽（偏差 ≤ 0）⇒ 无扣款。★ 此时**不需要**任何标准，也不该报「未判定」──
  if (dev <= 0) {
    return {
      basisWidthCm: basis,
      measuredWidthCm: measured,
      deviationPct: dev,
      pct: 0,
      source: 'none',
      suggestedAmount: 0,
      baseAmount,
      verdict: 'ok',
      headline: `幅宽不窄于基准（偏差 ${dev}%）⇒ 无扣款建议`,
      unresolvedReason: null,
      notices,
    };
  }

  // ── 窄了：扣款比例**走标准链**（客户 P0 → 我方已录 → 未判定；无出厂默认）──
  // ★★ 判据是 `unresolvedReason` **不是** `pct == null`：`gateToleranceOf` 在未判定时给的是
  //    `pct: 0`（数量口径下"按 0 卡"的语义）+ 非空的 `unresolvedReason`。
  //    若照 `pct == null` 判，未判定会被当成"扣 0%"静默放过去 —— 与"不拿默认假设冒充条款"正好相反。
  if (input.tolerance.unresolvedReason != null) {
    const gap = notices.some((n) => n.includes('空档'));
    return {
      basisWidthCm: basis,
      measuredWidthCm: measured,
      deviationPct: dev,
      pct: null,
      source: input.tolerance.source,
      suggestedAmount: null,
      baseAmount,
      verdict: 'undetermined',
      headline: `未判定：偏差 ${dev}% 算不出扣款比例`,
      unresolvedReason: gap
        ? '偏差落在**已录档位的空档里**（超出最后一档，或档位之间有缝）⇒ 请补一档，或本次由人判定。'
        : '该客户未录**幅宽扣款**标准、我方也未录 ⇒ 算不出扣款比例（★ 幅宽扣款**没有出厂默认**，不拿数量公差那套替它算）—— 请先在客户档案「溢短装标准」里录幅宽扣款档位（按**幅宽偏差 %**）。',
      notices,
    };
  }
  const pct = input.tolerance.pct;

  const sug = suggestWidthDeduction({ amount: baseAmount, pct });
  if (sug.amount == null) {
    notices.push('缺**订单行货款金额**（`netValue` 未算）⇒ 只给比例、不给金额（★ 不猜金额）');
  }
  return {
    basisWidthCm: basis,
    measuredWidthCm: measured,
    deviationPct: dev,
    pct,
    source: input.tolerance.source,
    suggestedAmount: sug.amount,
    baseAmount,
    verdict: 'deduct',
    headline:
      `偏差 ${dev}% ⇒ 按${TOLERANCE_SOURCE_LABELS[input.tolerance.source] ?? '标准'}扣 ${pct}%`
      + (sug.amount != null ? `，建议扣款 ${sug.amount}（★ 仅供人参考，不自动落账）` : ''),
    unresolvedReason: null,
    notices,
  };
}

// ───────────────────────────────────────────────────────────────────
// 读取：某订单的幅宽实测（QC 查货时登记）
// ───────────────────────────────────────────────────────────────────

export interface WidthMeasurementRecord {
  orderLineId: string;
  reportId: string;
  measuredWidthCm: number;
  basisWidthCm: number;
  note: string | null;
  createdAt: number | null;
}

/**
 * 读取某订单**每个订单行最新一条**幅宽实测（`InspectionWidthMeasurement`）。
 *
 * ★ 为什么取"最新一条"：同一行可能在**中期查货**与**装运前查货**各量一次；
 *   索赔看的是**出货前那次**（离交货最近的事实）⇒ 用 `createdAt` 取最新。
 *   历史不丢（都在表里），只是本视图按最新一条算 —— 要看历史直接读表。
 * ★ 读失败 ⇒ 抛（由调用方决定怎么报）；**不返回空 Map 冒充"没量过"**（那会让"读不到"看起来像"没这回事"）。
 */
export async function loadWidthMeasurements(
  prisma: any,
  orderId: string,
): Promise<Map<string, WidthMeasurementRecord>> {
  const rows: any[] = await prisma.inspectionWidthMeasurement.findMany({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
    select: { orderLineId: true, reportId: true, measuredWidthCm: true, basisWidthCm: true, note: true, createdAt: true },
  });
  const out = new Map<string, WidthMeasurementRecord>();
  for (const r of rows ?? []) {
    const lineId = String(r.orderLineId);
    if (out.has(lineId)) continue; // 已按 createdAt desc 排序 ⇒ 第一条就是最新
    out.set(lineId, {
      orderLineId: lineId,
      reportId: String(r.reportId),
      measuredWidthCm: Number(r.measuredWidthCm),
      basisWidthCm: Number(r.basisWidthCm),
      note: r.note ?? null,
      createdAt: r.createdAt != null ? Number(r.createdAt) : null,
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────
// 读取（★ 区分「没有」与「读不到」）
// ───────────────────────────────────────────────────────────────────

/**
 * 本服务只需要这两个模型 —— ★ `PrismaClient` 与**事务客户端 `tx`** 都满足它，
 * 所以出运门禁可以在事务内直接取标准（不必把标准预先塞进函数签名）。
 */
export interface TolerancePrismaLike {
  relation: { findUnique: (args: any) => Promise<any> };
  systemConfig: { findUnique: (args: any) => Promise<any> };
}

export interface LoadedToleranceStandards {
  customerStandard: ToleranceStandardSet | null;
  /** ★ 客户**有**标准但读取失败（≠ 没有标准） */
  customerStandardUnavailable: boolean;
  internalStandard: ToleranceStandardSet | null;
  internalStandardUnavailable: boolean;
}

export async function loadToleranceStandards(
  prisma: TolerancePrismaLike,
  opts: { customerRelationId?: string | null },
): Promise<LoadedToleranceStandards> {
  const db = prisma as any;
  const out: LoadedToleranceStandards = {
    customerStandard: null,
    customerStandardUnavailable: false,
    internalStandard: null,
    internalStandardUnavailable: false,
  };

  if (opts.customerRelationId) {
    try {
      const rel = await db.relation.findUnique({
        where: { id: opts.customerRelationId },
        select: { customerAgreementTolerance: true },
      });
      out.customerStandard = normalizeStandardSet(rel?.customerAgreementTolerance);
    } catch (e: any) {
      // ★★ 读不到 ≠ 没有 —— 客户标准是 P0，**不许静默降级**
      out.customerStandardUnavailable = true;
      logger.error('[ToleranceStandard] 客户公差标准读取失败（★ 不降级）', {
        error: e?.message,
        customerRelationId: opts.customerRelationId,
      });
    }
  }

  try {
    const row = await db.systemConfig.findUnique({
      where: { scope_key: { scope: INTERNAL_TOLERANCE_SCOPE, key: INTERNAL_TOLERANCE_KEY } },
      select: { value: true },
    });
    const configured = normalizeStandardSet(row?.value);
    /**
     * ★★ 三种"没拿到可用标准"必须分开（2026-09-29 晚加出厂默认时定的）：
     *   ① **行不存在** ⇒ 公司没录 ⇒ `internalStandard = null`（**不是** unavailable）
     *      ⇒ 解析器按本日口径落 **③b 出厂默认**（`internal_default`，显式标注）。
     *   ② **行存在但解析不出档位**（空对象 / 坏 JSON）⇒ 这是**读到了坏配置**，
     *      按「读不到」处理 ⇒ `unavailable = true` ⇒ 判「未判定」，
     *      ★ **不许**套出厂默认：否则一次配置损坏就会把公司已录的更严标准**悄悄放宽**。
     *   ③ **查询抛错** ⇒ 同上（`unavailable = true`），并记 error 日志。
     */
    if (configured) {
      out.internalStandard = configured;
    } else if (row) {
      out.internalStandardUnavailable = true;
      logger.error('[ToleranceStandard] 内部公差标准配置存在但解析不出档位（★ 不套出厂默认）', {
        rawType: typeof row.value,
      });
    }
  } catch (e: any) {
    out.internalStandardUnavailable = true;
    logger.error('[ToleranceStandard] 我方公差标准读取失败（辅助项，不阻断）', { error: e?.message });
  }

  return out;
}

/**
 * 端到端：读标准 + 双重判定。
 * ★ 只读不写；**不自动扣款**。
 */
export async function getLineToleranceVerdict(
  prisma: PrismaClient,
  args: {
    customerRelationId?: string | null;
    contractQty: number;
    actualQty: number;
    unitPrice?: number | null;
    subject?: ToleranceSubject;
    measure?: number;
    lineOverride?: { pct?: unknown; source?: string | null } | null;
  },
): Promise<ToleranceDualVerdict> {
  const loaded = await loadToleranceStandards(prisma, { customerRelationId: args.customerRelationId });
  return evaluateToleranceDual({
    contractQty: args.contractQty,
    actualQty: args.actualQty,
    unitPrice: args.unitPrice,
    subject: args.subject ?? 'qtyTolerance',
    measure: args.measure,
    lineOverride: args.lineOverride ?? null,
    ...loaded,
  });
}

// ───────────────────────────────────────────────────────────────────
// 写入内部公差标准（我方一套）—— ★ 使用方要"填"的那一处
// ───────────────────────────────────────────────────────────────────

/**
 * 写入 / 更新**内部公差标准**（我方一套），落到 `SystemConfig` 的
 * `global::tolerance.internal_standard`（`valueType: json`）。
 *
 * ★ 使用方 2026-09-29：「没有客户标准，就按内部标准，**内部标准会需要在系统里填好的**」
 * ⇒ 本函数就是那个「填」的落点。
 * ★ 走 `createSystemConfigService` ⇒ **自动写 `SystemConfigHistory`**（审计留痕），
 *   与 MOQ 配置同口径（理由 ≥5 字、版本号 +1）。
 * ★★ 本函数**只写标准**，不碰任何订单/出运数据。
 */
export async function writeInternalToleranceStandard(
  prisma: PrismaClient,
  standard: ToleranceStandardSet,
  opts: { actorId?: string | null; reason: string },
): Promise<{ ok: true; version: number } | { ok: false; message: string }> {
  const normalized = normalizeStandardSet(standard);
  if (!normalized) {
    return { ok: false, message: '标准至少要有一个可用档位（qtyTolerance 或 widthDeduction 非空，且每档 minQty/pct 为数字）' };
  }
  const reason = (opts.reason ?? '').trim();
  if (reason.length < 5) {
    return { ok: false, message: '变更理由至少 5 个字（与 MOQ 配置同口径）' };
  }
  const svc = createSystemConfigService(prisma);
  const r = await svc.set(INTERNAL_TOLERANCE_KEY, normalized as unknown, {
    group: 'custom',
    label: '内部公差标准（我方一套，辅助）',
    valueType: 'json',
    description:
      '数量公差 / 幅宽扣款的内部标准分档表（JSON）。★ 客户标准为 P0，本项为辅助；' +
      '客户未录标准时按本项取数。形状见 docs/inventory/公差标准机制-设计-2026-09-29.md',
    actorId: opts.actorId ?? null,
    reason,
  });
  return { ok: true, version: r.row.version };
}

// ───────────────────────────────────────────────────────────────────
// 写入客户公差标准（★ P0 那一轨）—— 2026-09-29 晚新增
// ───────────────────────────────────────────────────────────────────

/**
 * 客户标准的变更审计动作名。
 * ★ 这一列（`Relation.customerAgreementTolerance`）**没有历史表**（存储方案 A 的已知代价），
 *   所以审计行**同时**充当「变更历史」的唯一来源 ⇒ 读历史就是查这个 action。
 * ★ 也正因为它兼作历史，审计写入与标准写入**必须在同一个事务里**：
 *   否则会出现"标准改成了 ±1%，但没有任何一行说明谁改的、为什么改" —— 那是本仓
 *   "有列无写入方 / 无痕变更"那一族病的正反面（这次是"有变更无痕"）。
 */
export const RELATION_TOLERANCE_AUDIT_ACTION = 'relation_tolerance_standard_change';

/**
 * 写入 / 清空**客户公差标准**（★ P0 硬约束），落 `Relation.customerAgreementTolerance`。
 *
 * ★ 使用方 2026-09-29 全局原则（G1 双轨制）：「我们公司内部有个标准。然后假如说客户那边有客户的标准，
 *   那就是会有这个 **P0 级**的去处理客户的标准」⇒ 本函数就是**客户那一轨**唯一的写入通道。
 *   （修前该列**有列无任何写入方** ⇒ 客户标准只能靠写库，双轨制在系统里事实上只有一轨。）
 *
 * ★★ 四条边界：
 *   1. **客户标准没有"出厂默认"** —— 未录就是未录（`null`）。我们**不许**替客户编一套标准：
 *      客户的约定只能由客户给。所以这里 `standard = null` 表示**显式清空**，不是"用默认"。
 *   2. **必须留痕**：标准写 + 审计行同一事务（见上）。
 *   3. **必须校验形状**：形状不对（没有可用档位）⇒ 拒绝，**不许**把垃圾 JSON 落库
 *      —— 落进去之后取数链会当"有标准但读不出" ⇒ 反而卡死所有出运。
 *   4. **不碰订单/出运**：本函数只写标准。
 */
export async function writeCustomerToleranceStandard(
  prisma: PrismaClient,
  relationId: string,
  standard: ToleranceStandardSet | null,
  opts: { actorId?: string | null; reason: string },
): Promise<{ ok: true; cleared: boolean } | { ok: false; code: string; message: string }> {
  const rid = (relationId ?? '').trim();
  if (!rid) return { ok: false, code: 'RELATION_ID_REQUIRED', message: 'relationId 必填（客户标准挂在客户身上）' };
  const reason = (opts.reason ?? '').trim();
  if (reason.length < 5) return { ok: false, code: 'REASON_TOO_SHORT', message: '变更理由至少 5 个字（审计强制）' };
  /**
   * ★★ 审计必须有**真人**：`AuditLog.actorId` 是指向 `UserAccount` 的外键，
   *   而这次变更改的是**出运放行所依赖的 P0 约束** ⇒ 用 `'system'` 之类的占位符就等于
   *   "留了一条查不到人的痕"（比不留更坏：看起来有审计）。所以缺 actor 直接**拒绝写入**。
   */
  const actorId = (opts.actorId ?? '').trim();
  if (!actorId) return { ok: false, code: 'ACTOR_REQUIRED', message: '改客户标准必须带操作人（审计要求真人）' };

  const cleared = standard == null;
  const normalized = cleared ? null : normalizeStandardSet(standard);
  if (!cleared && !normalized) {
    return {
      ok: false,
      code: 'INVALID_VALUE',
      message:
        '标准至少要有一个可用档位（qtyTolerance 或 widthDeduction 非空，且每档 minQty/pct 为数字）；' +
        '要清空请显式传 value=null',
    };
  }

  const db = prisma as any;
  const existing = await db.relation.findUnique({
    where: { id: rid },
    select: { id: true, name: true, customerAgreementTolerance: true, deletedAt: true },
  });
  if (!existing || existing.deletedAt != null) {
    return { ok: false, code: 'RELATION_NOT_FOUND', message: `客户/关系 ${rid} 不存在（或已删除）` };
  }

  const before = normalizeStandardSet(existing.customerAgreementTolerance);

  // ★ 标准写 + 审计行同一事务：不许出现"改了 P0 约束却查不到是谁改的"
  await db.$transaction(async (tx: any) => {
    await tx.relation.update({
      where: { id: rid },
      data: { customerAgreementTolerance: normalized as any },
    });
    await tx.auditLog.create({
      data: {
        id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        actorId,
        action: RELATION_TOLERANCE_AUDIT_ACTION,
        targetType: 'Relation',
        targetId: rid,
        detail: { from: before, to: normalized, reason, relationName: existing.name } as any,
        operationType: 'update',
        fieldPath: 'customerAgreementTolerance',
        beforeValue: before as any,
        afterValue: normalized as any,
      },
    });
  });

  logger.info('[ToleranceStandard] 客户公差标准已写入', { relationId: rid, cleared, by: actorId });
  return { ok: true, cleared };
}

/** 读某个客户的公差标准（供界面展示；★ 与取数链同一个归一化器） */
export async function readCustomerToleranceStandard(
  prisma: PrismaClient,
  relationId: string,
): Promise<
  | { ok: true; relationId: string; customerName: string | null; value: ToleranceStandardSet | null; history: Array<{ id: string; at: Date; actorId: string; reason: string | null; from: unknown; to: unknown }> }
  | { ok: false; code: string; message: string }
> {
  const rid = (relationId ?? '').trim();
  if (!rid) return { ok: false, code: 'RELATION_ID_REQUIRED', message: 'relationId 必填' };
  const db = prisma as any;
  const rel = await db.relation.findUnique({
    where: { id: rid },
    select: { id: true, name: true, customerAgreementTolerance: true, deletedAt: true },
  });
  if (!rel || rel.deletedAt != null) {
    return { ok: false, code: 'RELATION_NOT_FOUND', message: `客户/关系 ${rid} 不存在（或已删除）` };
  }
  const rows = await db.auditLog.findMany({
    where: { action: RELATION_TOLERANCE_AUDIT_ACTION, targetId: rid },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, createdAt: true, actorId: true, detail: true },
  });
  return {
    ok: true,
    relationId: rid,
    customerName: rel.name ?? null,
    value: normalizeStandardSet(rel.customerAgreementTolerance),
    history: (rows ?? []).map((r: any) => ({
      id: r.id,
      at: r.createdAt,
      actorId: r.actorId,
      reason: (r.detail as any)?.reason ?? null,
      from: (r.detail as any)?.from ?? null,
      to: (r.detail as any)?.to ?? null,
    })),
  };
}
