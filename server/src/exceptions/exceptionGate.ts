/**
 * exceptionGate.ts — DR-013 门禁 SDK（其他业务域消费受控例外的纯函数契约）
 *
 * 设计真源：
 *   - docs/design/10-评审与决策/2026-08-16-设计评审决策记录.md DR-013（原则/例外申请/批准/审计与恢复）
 *   - docs/design/04-模块设计/07-AI助手/审批与human-in-the-loop.md §15（DR013-B1~B5/C1~C5）
 *   - docs/design/04-模块设计/03-订单与生产/Pricing-定价与成本/偏差校验与审批链.md §13（DEV-13-A1~A5/B1~B4）
 *
 * 定位：本文件是纯函数/纯类型模块，不依赖 Prisma、不感知 Express。
 *   各业务域（moq/orderChanges/samples/qc/pricing/shipment…）的资格判定函数
 *   （如 samples.computeShipmentEligibility、qc.checkShipmentEligibility）输出「不具备资格」，
 *   本 SDK 提供统一的「门禁阻断 → 查例外 → 放行或抛错」消费模式。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 其他域接入方式（README，契约即本文件，接入方无需改 exceptions 域任何文件）：
 *
 *   import { assertGateOrThrow, GATE_BLOCKED } from '../exceptions/exceptionGate';
 *
 *   // 1. 域内先做正常资格判定（既有逻辑，不感知例外）
 *   const eligibility = await fabricService.computeShipmentEligibility({ orderId });
 *   //    eligibility 形如 { eligibleForNormalShipment: boolean, blockingReasons: [...] }
 *
 *   // 2. 门禁点统一走 assertGateOrThrow：
 *   const pass = await assertGateOrThrow(
 *     { eligible: eligibility.eligibleForNormalShipment, blockingReasons: eligibility.blockingReasons, gate: 'shipment_release' },
 *     () => exceptionService.hasActiveException({
 *       targetType: 'Shipment',          // 受影响对象类型（与 EXC 创建时 scope.targetType 精确一致）
 *       targetId: shipment.id,           // 受影响对象 id（精确匹配，绝不模糊/批量）
 *       action: 'shipment:release',      // 被放行动作标识（与 EXC 创建时 scope.action 精确一致）
 *     }),
 *   );
 *
 *   // 3. 判定结果：
 *   //    - eligibility.eligible=true       → { passedVia: 'gate' }，正常放行
 *   //    - 不具备资格 + 有生效例外          → { passedVia: 'exception', exception }，放行并展示例外徽标
 *   //    - 不具备资格 + 无生效例外          → 抛 GateBlockedError（code=GATE_BLOCKED，statusCode=409，
 *   //                                         携带 blockingReasons + exceptionEntryHint 引导发起 DR-013 申请）
 *
 *   // 4. 动作真正执行时，域内调用 exceptionService.consumeException({...}) 核销一次性例外
 *   //    （EXCEPTION_ALREADY_CONSUMED / EXCEPTION_EXPIRED / EXCEPTION_NOT_FOR_THIS_ENTITY 均 fail-closed）。
 *
 * 铁律（DR-013 原则，接入方必须遵守）：
 *   1. 例外只对「指定对象 + 指定动作 + 指定时点」开放，不得把一张 EXC 泛化到整类对象；
 *   2. 例外不改变原门禁状态（S/S 未确认仍是未确认），只是动作接口内部放行一次；
 *   3. 隐藏开关禁止：不得提供 forceBypass/adminOverride 之类的旁路参数（DR013-B4）。
 * ────────────────────────────────────────────────────────────────────────────
 */

// ───────────────────────────────────────────────────────────────────
// 例外分类（与 Dr013ExceptionRequest.exceptionCategory 枚举一致，schema 注释真源）
// ───────────────────────────────────────────────────────────────────
export const EXCEPTION_CATEGORIES = [
  'moq_exemption',     // MOQ 豁免（MOQ 校验失败 / 原豁免审批被拒）
  'price_deviation',   // 价格偏差（双轨偏差超阈值 / 原价格审批被拒）
  'order_change',      // 订单变更（绕过变更控制 / 原变更审批被拒）
  'shipment_release',  // 出运放行（QC/S/S/RC 门禁缺失）
  'qc_fault',          // QC 瑕疵（缺陷率超标 / finalVerdict=Fail 仍推进）
  'payment_term',      // 付款条件例外
  'sample_skip',       // 样品环节跳过
  // 信用豁免（W-A 走查 DE-5 修复：信用门禁阻断的系统内例外入口；
  // schema 冻结仅扩代码枚举，Dr013ExceptionRequest.exceptionCategory 为 String 无 DB 枚举约束）
  'credit_exemption',
  'other',             // 其他（reason 必须说明清楚）
] as const;
export type ExceptionCategory = (typeof EXCEPTION_CATEGORIES)[number];

// ───────────────────────────────────────────────────────────────────
// 门禁资格判定输入（各域资格判定函数的输出适配为本结构）
// ───────────────────────────────────────────────────────────────────
export interface GateEligibility {
  /** 正常路径是否具备资格（不感知例外） */
  eligible: boolean;
  /** 门禁标识（用于错误消息与审计，如 shipment_release / price_deviation） */
  gate?: string;
  /** 阻断原因码列表（如 ['SS_NOT_CONFIRMED']），原样透传给调用方展示 */
  blockingReasons?: string[];
  /** 人类可读阻断消息（缺省时由 SDK 组装） */
  message?: string;
}

// ───────────────────────────────────────────────────────────────────
// 例外查询输入/输出（与 exceptionService.hasActiveException 契约一致）
// ───────────────────────────────────────────────────────────────────
export interface ExceptionScopeMatch {
  targetType: string;
  targetId: string;
  action: string;
  /** 判定时点（缺省=当前时间；服务端校验，绝不取前端值落库） */
  at?: Date;
}

export interface ActiveExceptionSummary {
  id: string;
  exceptionNumber: string;
  exceptionCategory: string;
  subCategory: string | null;
  status: string;
  /** true=BOSS 最终兜底特批（前端展示「BOSS 最终兜底特批放行」徽标） */
  bossFinalBypass: boolean;
  /** 生效窗口截止（ISO；null=无时间窗口，仅受 maxUses 一次性约束） */
  validUntil: string | null;
}

export type ExceptionInactiveReason =
  | 'NO_ACTIVE_EXCEPTION'        // 该对象+动作无任何例外申请记录
  | 'EXCEPTION_NOT_APPROVED'     // 有申请但未获批准（Pending/Rejected/Cancelled）→ 保持原门禁
  | 'EXCEPTION_EXPIRED'          // 生效窗口已过（指定时点失效）
  | 'EXCEPTION_ALREADY_CONSUMED' // 一次性例外已核销
  ;

export interface ExceptionCheckResult {
  active: boolean;
  exception?: ActiveExceptionSummary;
  /** active=false 时的原因（供门禁消息/审计使用） */
  reason?: ExceptionInactiveReason;
}

/** 例外查询函数签名（exceptionService.hasActiveException 直接满足该签名） */
export type ExceptionChecker = (scope: ExceptionScopeMatch) => Promise<ExceptionCheckResult>;

// ───────────────────────────────────────────────────────────────────
// 门禁阻断错误（fail-closed；消息必须引导 DR-013 申请入口，DEV-13-A1 反例：
// 只阻断无入口 = 系统成死规则）
// ───────────────────────────────────────────────────────────────────
export const GATE_BLOCKED = 'GATE_BLOCKED';

/** DR-013 受控例外申请入口提示（挂载路径建议值，与 exceptionRoute 头部注释一致） */
export const EXCEPTION_ENTRY_HINT =
  '可按 DR-013 发起受控例外申请：POST /api/v1/exceptions（scope exception:dr013:create）';

export class GateBlockedError extends Error {
  readonly code = GATE_BLOCKED;
  readonly statusCode = 409;
  readonly gate?: string;
  readonly blockingReasons: string[];
  readonly exceptionEntryHint = EXCEPTION_ENTRY_HINT;
  /** 例外查询结论（无申请/未批准/已过期/已核销），便于前端区分提示 */
  readonly exceptionReason?: ExceptionInactiveReason;

  constructor(eligibility: GateEligibility, check?: ExceptionCheckResult) {
    const reasons = eligibility.blockingReasons ?? [];
    const base =
      eligibility.message ??
      `门禁${eligibility.gate ? ` ${eligibility.gate}` : ''}未通过${reasons.length ? `（${reasons.join(', ')}）` : ''}，正常路径阻断`;
    const suffix =
      check?.reason === 'EXCEPTION_EXPIRED'
        ? '；原例外已过生效时点，请重新申请'
        : check?.reason === 'EXCEPTION_ALREADY_CONSUMED'
          ? '；原一次性例外已核销，请重新申请'
          : check?.reason === 'EXCEPTION_NOT_APPROVED'
            ? '；例外申请未获批准，原门禁保持'
            : '';
    super(`${base}${suffix}。${EXCEPTION_ENTRY_HINT}`);
    this.name = 'GateBlockedError';
    this.gate = eligibility.gate;
    this.blockingReasons = reasons;
    this.exceptionReason = check?.reason;
  }
}

// ───────────────────────────────────────────────────────────────────
// 核心模式：assertGateOrThrow(eligibility, exceptionCheck)
//   - 具备正常资格 → passedVia='gate'（不触碰例外，例外不被无意核销）
//   - 不具备资格 + 生效例外精确命中 → passedVia='exception'（携带例外摘要，供徽标展示）
//   - 不具备资格 + 无生效例外 → 抛 GateBlockedError（fail-closed）
// ───────────────────────────────────────────────────────────────────
export type GatePassResult =
  | { passedVia: 'gate' }
  | { passedVia: 'exception'; exception: ActiveExceptionSummary };

export async function assertGateOrThrow(
  eligibility: GateEligibility,
  exceptionCheck: ExceptionCheckResult | Promise<ExceptionCheckResult> | (() => Promise<ExceptionCheckResult>),
): Promise<GatePassResult> {
  if (eligibility.eligible) {
    return { passedVia: 'gate' };
  }
  const check =
    typeof exceptionCheck === 'function'
      ? await exceptionCheck()
      : await exceptionCheck;
  if (check.active && check.exception) {
    return { passedVia: 'exception', exception: check.exception };
  }
  throw new GateBlockedError(eligibility, check);
}

/**
 * 便捷绑定：把 hasActiveException 与固定 scope（targetType+action）绑定成
 * 「给个 targetId 就能查」的 checker，减少各接入方样板代码。
 *
 *   const checkShipmentRelease = bindExceptionChecker(
 *     exceptionService.hasActiveException, { targetType: 'Shipment', action: 'shipment:release' });
 *   await assertGateOrThrow(eligibility, () => checkShipmentRelease(shipment.id));
 */
export function bindExceptionChecker(
  hasActiveException: ExceptionChecker,
  fixed: { targetType: string; action: string },
): (targetId: string, at?: Date) => Promise<ExceptionCheckResult> {
  return (targetId, at) => hasActiveException({ targetType: fixed.targetType, targetId, action: fixed.action, at });
}
