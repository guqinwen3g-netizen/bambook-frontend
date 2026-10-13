/**
 * lcGate.ts —— 信用证（L/C）门禁判定（G-4 批，M1/矩阵「L/C 做全套门禁」的接线）
 *
 * 拍板原文（`docs/业务变体矩阵-2026-09-16.md:134-141`，Kevin 2026-09-16）：
 *   1. 订单确认时若付款方式为 L/C ⇒ **必须已登记信用证**，否则不得确认；
 *   2. **装运前**核对 LC 条款：最迟装运期、有效期、金额溢短装 tolerance、单据要求；
 *   3. 不符点（Discrepant）**阻断发运**，走 H11 例外放行（**不另造一套例外机制**）。
 *   → 矩阵自评：「`LetterOfCredit` 模型完整…所以这是**接线活，不是建模活**」。
 *
 * ★ 接线而非新建：本模块**只产出 `GateEligibility`**，例外放行/留痕一律走既有 DR-013 SDK
 *   （`exceptions/exceptionGate.ts` 的 `assertGateOrThrow` + `bindExceptionChecker`），
 *   豁免类别用既有 `payment_term`（`exceptionGate.ts:58`）⇒ **零 schema 变更**
 *   （`Dr013ExceptionRequest.exceptionCategory` 是 String，无 DB 枚举约束）。
 *
 * ★★ 动手前查实的一处命名陷阱（不查就会做出一个永不触发的假门禁）：
 *   矩阵写的是 `paymentMethod='LC'`，但 **`Order` 上没有 `paymentMethod` 列**
 *   —— 真库 `information_schema` 实测 Order 只有 `paymentTerms`（自由文本）与
 *   `paymentInstrument`（`schema.prisma:159`，注释枚举 `T/T, L/C, O/A, D/P, D/A`）。
 *   `paymentMethod` 是 **`PaymentVoucher`** 的列（`schema.prisma:2747`，枚举 `TT|LC|OA|…`）。
 *   ⇒ 若照抄矩阵写 `order.paymentMethod === 'LC'`，条件恒为 false ⇒ 门禁永不阻断 = **静默 fail-open**。
 *   ⇒ 判据源取 `Order.paymentInstrument`，并把 `L/C`、`LC`、大小写与空格差异**归一**后再比
 *     （两张表的写法本来就不一致：Order 侧带斜杠、Voucher 侧不带）。
 *
 * ⚠️ 矩阵要求的四项里，本模块**只落地三项**，第四项按现状无法证明合规 ⇒ 明写在此、不假装做过：
 *   · 最迟装运期 ✅（`shipmentDeadline`）· 有效期 ✅（`expiryDate`）· 不符点 ✅（`status='Discrepant'`）
 *   · **金额溢短装 tolerance ✗**：`LetterOfCredit` **没有 tolerance 字段**（只有 amount / availableAmount，
 *     `schema.prisma:5953-5955`）⇒ 无判据源，不做（做了就是拿猜的阈值卡真业务）。
 *   · **单据要求核对 ✗**：`documentsRequired` 是 Json 清单（`:5968`），但与 `TradeDocument` 的
 *     齐套比对属另一件事，本批不接（列未覆盖）。
 *   ⇒ 这两条已登记进 §9（B49），**不得**据"LC 门禁已接线"声称矩阵 :137 的四项已全部落地。
 */

import type { GateEligibility } from '../exceptions/exceptionGate';
import { logger } from '../lib/logger';
import { createExceptionService } from '../exceptions/exceptionService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { businessNowDate } from '../shared/businessClock';
import { isValidLocalDateKey } from '../shared/localDate';



/** 三个接入点（与 DR-013 的 scope.action 一一对应） */
export type LcGateStage = 'order:confirm' | 'shipment:release' | 'invoice:issue';

export const LC_GATE = 'lc_term' as const;

/**
 * DR-013 例外的 scope.action。**刻意与信用门禁的 'order:confirm' 分开**：
 * 复用同一个 action 会让"已批准的信用豁免"顺带把信用证门禁也开了（跨门禁越权，且无人看得懂）。
 * 发运侧相反 —— 直接用既有的 'shipment:release'（矩阵 :141 原话"不另造一套例外机制"），
 * 代价是"一次出运例外连带豁免 LC 条款"，这是**拍板要求的**语义，不是本模块的选择。
 */
export const LC_ORDER_CONFIRM_ACTION = 'lc:order:confirm' as const;
export const LC_INVOICE_ISSUE_ACTION = 'lc:invoice:issue' as const;

/**
 * 状态白名单。`LetterOfCredit.status` 是**普通 String 列**（`schema.prisma:5939`，
 * 那串 `Issued | Presented | …` 只是列注释，DB 层没有 CHECK/enum ⇒ 实测 0 条 CHECK 约束），
 * 所以"不认识的状态"是能真实出现的。三档处理，全部 fail-closed：
 *   · LIVE → 继续按条款判（有效期/装运期/不符点）
 *   · DEAD（Cancelled/Expired）→ 直接阻断（登记过 ≠ 可用）
 *   · 其余（含 Settled、拼错、任意文本）→ **不能证明可用就阻断**，原因 LC_STATUS_UNRECOGNIZED
 *     （Settled 是否该算"已用讫不可再用"属口径 ⇒ 已登记 §12.1，本批按最严的一档自处并留痕）
 */
const LC_LIVE_STATUSES = new Set(['Issued', 'Presented', 'Accepted', 'Discrepant']);
const LC_DEAD_STATUSES = new Set(['Cancelled', 'Expired']);

/**
 * 订单的结算方式里**是否含 L/C 成分**（本门禁的适用性判据）。
 * 归一规则：NFKC 转全角族（`ＬＣ`→`LC`、`／`→`/`、`－`→`-`、全角空格→半角）+ 大写 ⇒ `L/C`、`lc`、`L - C`、`L／C` 同判。
 *   为什么必须管全角：本字段的中文标签是"付款方式"（`lib/orderSchema.ts:246`），全角斜杠是中文输入法的默认产物；
 *   只去 ASCII `/` 会让 `L／C` 被判成"非信用证" ⇒ 门禁静默失效且没有任何信号。
 *
 * ★ **v3.91 就地收紧（D106，v3.90 登记自裁）：精确等值 → 词元级"含 L/C 成分"** ——
 *   原口径（`norm === 'LC'`）会把 **`T/T + L/C`、`30% T/T, 70% L/C`** 这类**混合结算**（本业务主流结构，
 *   且 L/C 常占大头）判成"非信用证" ⇒ 门禁对这类单**完全不设防**（fail-open）。
 *   新口径＝在**非字母数字边界**上匹配 `L` + 可选 `/`/`-` + `C`：
 *   · 漏卡侧：`T/T + L/C`、`70% L/C，其余 T/T`、`L/C + D/P` 都算含 L/C 成分；
 *   · 误卡侧：原注释点名的 `NOTLC`、`LCADJUSTED` **仍不算**（边界不成立），`LCL`（拼箱）、`ALC` 也不算
 *     ⇒ 既不漏混合单，也不退回 `includes` 那种子串误判。
 * ⚠️ 这条改的是**判据源本身**（`Order.paymentInstrument` 一列），**不**看凭证侧那一列（`PaymentVoucher.paymentMethod`）——
 *   后者由 §9 B50 单独记账，改它属另一条线。
 */
export function isLcInstrument(raw: string | null | undefined): boolean {
  // NFKC 一次覆盖整个全角族：ＬＣ→LC、／→/、－→-、全角空格→半角空格
  const norm = String(raw ?? '').normalize('NFKC').toUpperCase();
  return /(^|[^A-Z0-9])L\s*[/-]*\s*C(?![A-Z0-9])/.test(norm);
}

/**
 * ★ A19（拍板件 §2.2 硬条件 1）：**「未录」是独立一档**。
 *
 * `Order.paymentInstrument` / `Quotation.paymentInstrument` 都是**可空、无约束的自由文本**
 * （§9 B51）。`isLcInstrument(null) === false` ⇒「未录」与「录了 T/T」在本门禁里
 * **长得一模一样**，两者都被判 `via='not-applicable'` 静默放行。
 *
 * 拍板口径：**空 = 「不知道」，不是「非信用证」** ⇒
 *   · 不阻断（不知道 ≠ 有风险）；
 *   · 但**必须可见** —— 用本码在结构化回传里挂出来，让屏面/日志能提示"这单的结算方式没录"。
 *   ⇒ 凡门禁读可空列，**必须有第三个分支**；只有两个分支就是静默 fail-open。
 *
 * ⚠️ 只做 `trim()`，**不做任何字符串层面的猜测**（把「T/T 30%」解析成 T/T 属 NLP，不可复现）——
 *   拍板件明令「`paymentTerms` 自由文本不许解析」，正确做法是把信息引到正确的列（界面提示）。
 */
export const LC_INSTRUMENT_NOT_RECORDED = 'LC_INSTRUMENT_NOT_RECORDED' as const;

/** 付款方式是否**已录**（`trim()` 后非空；全角空格经 NFKC 后也是空白 ⇒ 算未录）。 */
export function isInstrumentRecorded(raw: string | null | undefined): boolean {
  return String(raw ?? '').normalize('NFKC').trim().length > 0;
}

/**
 * 日期串解析（LC 的期限字段是 String，非 Date）。
 * 解析不出来 ⇒ 返回 null，调用方**必须按 fail-closed 处理**（不能"读不出来就当合规"）。
 *
 * ★ 两条本批实测撞出来的口径（不做的话就是"看着在卡、实际卡错地方"）：
 *   ① `Date.parse('2026-12-05')` 按 **UTC 零点**解析 ⇒ 在 +08 的办公地会比"当天结束"**早 8 小时**判过期，
 *      有效期最后一天的单据被误卡。信用证/最迟装运期的业务口径是"当天有效到日终" ⇒ 日期串按本地时区当天 23:59:59.999 计。
 *   ② `Date.parse('12/05/2026')` 在 V8 里是**月在前**（美式），而 `DD/MM/YYYY` 是外贸单据的常见写法 ——
 *      两种读法差整整一年，猜哪一边都可能把"已过期"读成"未过期"。
 *      ⇒ 带斜杠的纯数字日期**一律判不可读**（fail-closed + 明说要补成 YYYY-MM-DD），不做猜测。
 *   完整时刻串（带 `T` 或空格 + 时区）仍交给 `Date.parse`，那是显式无歧义的写法。
 */
function parseDate(raw: string | null | undefined): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    if (!isValidLocalDateKey(s)) return null;
    return Date.parse(`${s}T23:59:59.999+08:00`);
  }
  if (/^\d{1,4}[/.\d]+$/.test(s) && !/[T: ]/.test(s)) return null;   // 斜杠/点分纯数字 ⇒ 月日序不可判定
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** 证状态进对外文案前的白名单化：`status` 是无约束自由文本，不许原样拼给屏幕（也避免把任意 DB 文本当原因码）。 */
function lcStatusToken(status: string | null | undefined): string {
  const s = String(status ?? '').trim();
  return /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(s) ? `LC_${s.toUpperCase()}` : 'LC_STATUS_UNRECOGNIZED';
}

export interface LcRecordLite {
  id: string;
  lcNumber: string;
  status: string;
  amount?: any;
  currency?: string | null;
  expiryDate?: string | null;
  shipmentDeadline?: string | null;
  deletedAt?: bigint | number | null;
}

/**
 * 纯判定（不查库，便于逐条测试与探针）。
 * @param lc 该订单关联的信用证；null/undefined = 未登记
 * @param orderInstrument `Order.paymentInstrument` 原值
 *
 * ★ A19：返回值多了 `notices`（**非阻断但必须可见**的提示）。三档语义：
 *   ① 未录（空/空白）⇒ 放行 + `notices=['LC_INSTRUMENT_NOT_RECORDED']`
 *   ② 录了非 L/C（如 T/T）⇒ 放行 + `notices=[]`（明确知道不是信用证，无需提示）
 *   ③ 含 L/C 成分 ⇒ 走下方条款判定（阻断或放行）
 */
export function evaluateLcEligibility(params: {
  stage: LcGateStage;
  orderInstrument: string | null | undefined;
  lc: LcRecordLite | null | undefined;
  at?: Date;
}): GateEligibility & { notices: string[] } {
  const { stage, orderInstrument, lc } = params;
  const atMs = (params.at ?? businessNowDate()).getTime();

  // 非信用证结算 ⇒ 本门禁不适用（放行，但不是"已通过校验"）
  if (!isLcInstrument(orderInstrument)) {
    // ★ A19 第三分支：「未录」与「录了 T/T」必须分得开（此前两者都静默放行、屏面上毫无区别）
    return {
      eligible: true,
      gate: LC_GATE,
      blockingReasons: [],
      notices: isInstrumentRecorded(orderInstrument) ? [] : [LC_INSTRUMENT_NOT_RECORDED],
    };
  }

  const reasons: string[] = [];
  if (!lc || lc.deletedAt != null) {
    reasons.push('LC_NOT_REGISTERED');
  } else if (!LC_LIVE_STATUSES.has(String(lc.status ?? '').trim())) {
    // 已注销/已到期的证 = 没有可用的证；认不出的状态 = 无法证明可用 ⇒ 一律阻断（不猜）
    reasons.push(LC_DEAD_STATUSES.has(String(lc.status ?? '').trim()) ? lcStatusToken(lc.status) : 'LC_STATUS_UNRECOGNIZED');
  } else {
    const expiry = parseDate(lc.expiryDate);
    if (expiry == null) {
      // 读不出来就不能证明"未过期" ⇒ 阻断并说明要去补哪个字段（G3：不确定就不可判定）
      reasons.push('LC_EXPIRY_UNREADABLE');
    } else if (expiry < atMs) {
      reasons.push('LC_EXPIRED');
    }

    if (stage === 'shipment:release') {
      // ② 最迟装运期（仅发运侧要求）
      const shipDl = parseDate(lc.shipmentDeadline);
      if (shipDl == null) reasons.push('LC_SHIPMENT_DEADLINE_UNREADABLE');
      else if (shipDl < atMs) reasons.push('LC_SHIPMENT_DEADLINE_PASSED');
      // ③ 不符点阻断发运（矩阵 :141）
      if (lc.status === 'Discrepant') reasons.push('LC_DISCREPANT');
    }
  }

  return {
    eligible: reasons.length === 0,
    gate: LC_GATE,
    blockingReasons: reasons,
    // 走到这里 ⇒ 已确认「含 L/C 成分」⇒ 与"未录"无关，不许挂未录提示
    notices: [],
    message: reasons.length
      ? `信用证门禁未通过（${stage}）：${reasons.join(', ')}${lc ? `；信用证 ${lc.lcNumber}（${lc.status}）` : '；该订单未登记信用证'}`
      : undefined,
  };
}

/**
 * ★ 门禁 + DR-013 豁免查询的**唯一实现**（三个接入点都调它）。
 *   为什么必须收敛成一个：三处各写一遍"被阻断后去查例外"，就会有三份**不同的失败语义** ——
 *   本函数初版就把"例外查不出来"和"信用证查不出来"混成同一条消息，测试因此
 *   **通过了错误的原因**（mock 缺 delegate ⇒ 走 catch ⇒ 码仍是 LC_GATE_BLOCKED ⇒ 断言看不出来）。
 *
 * 三种结论，互不混淆（都 fail-closed，但消息要说准）：
 *  · allowed:true  via='not-applicable' —— 非信用证订单，本门禁不适用（放行）
 *  · allowed:true  via='gate'           —— 有证且条款满足
 *  · allowed:true  via='exception'      —— 条款不满足但有生效 DR-013 例外（留痕在例外侧）
 *  · allowed:false code='LC_GATE_BLOCKED'          —— 条款不满足且无生效例外
 *  · allowed:false code='LC_EXCEPTION_CHECK_FAILED' —— 条款不满足，且**例外状态查不出来**
 *    （不能因为查不了例外就当成"没例外"直接报门禁失败：那会让人以为补了证就行，
 *     实际可能是例外表/审批服务故障。两种"下一步"完全不同 ⇒ 分开报。）
 *
 * ★ A19：**放行分支多了 `notices`** —— 非阻断但必须可见的提示（当前只有
 *   `LC_INSTRUMENT_NOT_RECORDED`：「这单的付款方式没录」）。
 *   刻意**只回结构化码、不拼中文**：与下面 `reasons` 同一纪律
 *   （拼好的中文会被 `rawErrorLeakRatchet` 计成新的外泄站点）。
 */
export type LcGateDecision =
  | { allowed: true; via: 'not-applicable' | 'gate' | 'exception'; reasons: string[]; notices: string[]; exceptionNumber?: string }
  /**
   * ★ 只回传**结构化片段**，不回传组装好的 message：
   *  ① 门禁层不知道调用方是订单页/发运页还是开票页，文案该由接入点定（与信用门禁的 blockReason/hint 同一范式）；
   *  ② 上一版 `message: decision.message` 这种"转发 .message"的形状，被本仓 rawErrorLeakRatchet
   *    当场计成新的外泄站点（`orderLifecycleService.ts: 基线 2 → 实际 3`）—— 它无法区分
   *    "拼好的中文"与"原始异常文本"，所以**必须走结构化**，而不是去改判据放过我。
   */
  | { allowed: false; code: 'LC_GATE_BLOCKED' | 'LC_EXCEPTION_CHECK_FAILED'; reasons: string[]; lcLabel: string | null };

export async function decideLcGate(params: {
  prisma: any;
  orderId: string;
  /** 见下方 `order === undefined` 的自取逻辑：手里有订单行就传（省一次读数），只有 orderId 就不传 */
  order?: { paymentInstrument?: string | null } | null;
  stage: LcGateStage;
  /** DR-013 scope.action：确认/开票用 LC 专属 action；发运侧传既有的 shipment:release（矩阵：不另造例外机制） */
  exceptionAction: string;
  at?: Date;
}): Promise<LcGateDecision> {
  const { prisma, orderId, stage, exceptionAction } = params;
  // `order` 省略 = 本入口自己查一次（开票/PI 转正这类"手里只有 orderId"的调用点）；
  // 传 null = 调用方已确认订单不存在，由它按各自的"对象不存在"语义处理，本门禁判不适用。
  let order = params.order;
  if (order === undefined) {
    order = await prisma.order.findUnique({ where: { id: orderId }, select: { paymentInstrument: true } });
  }
  let elig;
  try {
    elig = await evaluateLcGateForOrder({ prisma, orderId, order: order ?? null, stage, at: params.at });
  } catch (e: any) {
    // 兜底：正常情况下查询异常已在 evaluateLcGateForOrder 内收敛成 queryFailed，
    // 这里只剩"判定本身出错"（如日期解析实现被改坏）这一种形状，仍不许把原文带出去。
    logger.error('[LcGate] 信用证门禁判定异常（fail-closed 阻断）', { orderId, stage, error: e?.message ?? String(e) });
    return { allowed: false, code: 'LC_GATE_BLOCKED', reasons: ['LC_QUERY_FAILED'], lcLabel: null };
  }
  // ★ 查不出来 ≠ 没有例外 ⇒ 不因"有已批例外"就把一次**失败的查询**算成放行（例外管的是条款，不是故障）。
  if (elig.queryFailed) {
    return { allowed: false, code: 'LC_GATE_BLOCKED', reasons: elig.blockingReasons ?? ['LC_QUERY_FAILED'], lcLabel: null };
  }
  if (!elig.blockingReasons || elig.blockingReasons.length === 0) {
    return { allowed: true, via: elig.lc ? 'gate' : 'not-applicable', reasons: [], notices: elig.notices ?? [] };
  }
  try {
    const excSvc = createExceptionService({
      prisma,
      approvalCreateService: createApprovalCreateService({ prisma, routingService: createApprovalRoutingService({ prisma }) }),
    });
    const chk = await excSvc.hasActiveException({ targetType: 'Order', targetId: orderId, action: exceptionAction, at: params.at });
    if (chk.active && chk.exception) {
      return { allowed: true, via: 'exception', reasons: elig.blockingReasons, notices: elig.notices ?? [], exceptionNumber: chk.exception.exceptionNumber };
    }
  } catch (e: any) {
    logger.error('[LcGate] DR-013 例外状态查不出来（保持阻断）', { orderId, stage, error: e?.message ?? String(e) });
    return { allowed: false, code: 'LC_EXCEPTION_CHECK_FAILED', reasons: elig.blockingReasons ?? [], lcLabel: elig.lc?.lcNumber ?? null };
  }
  return { allowed: false, reasons: elig.blockingReasons ?? [], lcLabel: elig.lc?.lcNumber ?? null, code: 'LC_GATE_BLOCKED' };
}

/**
 * 已持有订单行时的判定入口（各接入点大多已经查过订单 ⇒ 用这个，**不再回查一次 order**，
 * 免得同一件事出现两份读数 / 白多一次查询）。
 */
export async function evaluateLcGateForOrder(params: {
  prisma: any;
  orderId: string;
  order: { paymentInstrument?: string | null } | null;
  stage: LcGateStage;
  at?: Date;
}): Promise<GateEligibility & { lc: LcRecordLite | null; queryFailed?: boolean; notices: string[] }> {
  const { prisma, orderId, stage, order } = params;
  const instrument = order?.paymentInstrument;
  if (!order) {
    // 订单本身不存在 ⇒ 无可评之物（调用方按各自的"对象不存在"语义处理）。
    // ★ 这里**不挂** LC_INSTRUMENT_NOT_RECORDED：那是"订单在、但结算方式没录"的意思，
    //   订单都不在时说这句话是错的（会把 404 说成"付款方式没录"）。
    return { eligible: true, gate: LC_GATE, blockingReasons: [], lc: null, notices: [] };
  }
  if (!isLcInstrument(instrument)) {
    // ★ A19 第三分支：与 `evaluateLcEligibility` 同口径（未录 ⇒ 放行但可见；录了 T/T ⇒ 静默放行）
    return {
      eligible: true,
      gate: LC_GATE,
      blockingReasons: [],
      lc: null,
      notices: isInstrumentRecorded(instrument) ? [] : [LC_INSTRUMENT_NOT_RECORDED],
    };
  }
  // ★ 查询异常在**这一层**就收敛成「阻断 + 明确原因」，绝不把原始异常抛给调用方：
  //   发运侧（shipmentEligibilityGate）是直接调本函数的，一旦抛出，原始 Prisma 文本会经
  //   shipmentMutationService 的 `toMutationError` 兜底 `String(e?.message ?? e)` 进响应体
  //   （§9 B22 那一族），而"三个接入点共用一份失败语义"的承诺也就只剩两个点成立 ——
  //   这条是 2026-09-21 R4-T4 独立复核抓到的，文本棘轮（LEAK_RE 只认 `message: X.message` 形状）咬不住。
  let lcs: LcRecordLite[];
  try {
    lcs = await prisma.letterOfCredit.findMany({
      where: { orderId, deletedAt: null },
      select: { id: true, lcNumber: true, status: true, amount: true, currency: true, expiryDate: true, shipmentDeadline: true },
    });
  } catch (e: any) {
    logger.error('[LcGate] 信用证条款查询异常（fail-closed 阻断，原文只进日志）', { orderId, stage, error: e?.message ?? String(e) });
    return {
      eligible: false, gate: LC_GATE, blockingReasons: ['LC_QUERY_FAILED'], lc: null, queryFailed: true,
      notices: [],
      message: `信用证条款无法核对（订单 ${orderId} 的 L/C 查询失败），已按 fail-closed 保持阻断`,
    };
  }
  // ★ 0 张证必须显式判：`perLc` 为空时 `flatMap` 出空数组 ⇒ 会被误判成"没有原因 = 合格"，
  //   那正是本门禁最危险的形状（无证订单被放行）。故先短路回单证判定（lc=null ⇒ LC_NOT_REGISTERED）。
  if (lcs.length === 0) {
    return {
      ...evaluateLcEligibility({ stage, orderInstrument: instrument, lc: null, at: params.at }),
      lc: null,
    };
  }
  // 一单多证：逐张判、任一不满足即阻断（= 要求**所有**未软删的证都满足本阶段条款）。
  //   为什么不取「最早过期那张」也不取「最宽松那张」：前者过苛、后者会把该卡的挑掉 ——
  //   信用证是银行单据，「有一张不合规的证挂着」本身就必须暴露到屏面上。
  //   这仍是本批的自处判断 ⇒ 已登记 §12.1 待拍板，不自行放宽。
  const perLc = lcs.map((row) => evaluateLcEligibility({ stage, orderInstrument: instrument, lc: row, at: params.at }));
  const reasons = [...new Set(perLc.flatMap((r) => r.blockingReasons ?? []))];
  return {
    eligible: reasons.length === 0,
    gate: LC_GATE,
    blockingReasons: reasons,
    notices: [],
    message: reasons.length
      ? perLc.find((r) => !r.eligible)?.message
      : undefined,
    lc: lcs[0],
  };
}
