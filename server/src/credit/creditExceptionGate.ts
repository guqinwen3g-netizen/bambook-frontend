/**
 * creditExceptionGate.ts — 信用门禁 DR-013 受控例外闭环（W-A 走查 DE-5 修复）
 *
 * 设计真源：
 *   - docs/design/03-业务规则/信用控制规则.md §13（DR-013 受控例外）
 *   - server/src/exceptions/exceptionGate.ts（其他域接入方式契约：门禁阻断 → 查例外 → 放行或抛错）
 *
 * 铁律（fail-closed）：
 *   1. 信用门禁阻断时：生效例外（ReviewerApproved/BossFinalBypass + 未过期 + 未核销）
 *      精确命中（targetType+targetId+action）→ 放行；订单动作与 consumeCreditException 必须同事务提交
 *   2. 阻断且无生效例外 → 自动发起 credit_exemption 例外申请（DR-007 解析审批人）；
 *      已有 Pending 申请不重复发起（提示审批中）；发起失败保持阻断并提示手工入口
 *   3. 例外不改变原门禁状态（信用冻结/逾期事实不变），仅对指定对象+指定动作放行一次
 *
 * 消费点：orderLifecycleService（order:confirm）/ orderServiceV2（order:create）。
 *   例外查询置于门禁消费点而非 creditService.checkCreditAvailable 内部——
 *   遵循 exceptionGate SDK 契约（各域门禁点接入），避免 credit 域反向依赖 exceptions 域。
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createExceptionService, type ExceptionService } from '../exceptions/exceptionService';
import type { ActiveExceptionSummary, ExceptionScopeMatch } from '../exceptions/exceptionGate';
import { httpStatusOfCode } from '../shared/errorCodes';
import { businessNowMs } from '../shared/businessClock';

export const CREDIT_EXCEPTION_CATEGORY = 'credit_exemption' as const;

/** 信用例外默认生效窗口：7 天（一次性，maxUses=1；指定时点过期自动失效） */
const CREDIT_EXCEPTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 构造例外服务（审批人 DR-007 服务端解析；与 exceptionRoute 同一组装方式） */
export function createCreditExceptionService(prisma: PrismaClient): ExceptionService {
  return createExceptionService({
    prisma,
    approvalCreateService: createApprovalCreateService({
      prisma,
      routingService: createApprovalRoutingService({ prisma }),
    }),
  });
}

export type CreditExceptionGateOutcome =
  | { passed: true; exception: ActiveExceptionSummary }
  | { passed: false; approvalRequestId?: string; hint: string };

/** Actual consumeException failures, restricted to this business boundary. */
export const CREDIT_EXCEPTION_CONSUMPTION_CODES = [
  'INVALID_VALID_UNTIL', 'EXCEPTION_CONSUMER_REQUIRED', 'EXCEPTION_NOT_FOUND', 'EXCEPTION_SCOPE_INVALID',
  'EXCEPTION_NOT_FOR_THIS_ENTITY', 'EXCEPTION_ALREADY_CONSUMED', 'EXCEPTION_EXPIRED', 'EXCEPTION_NOT_ACTIVE',
  'EXCEPTION_CONSUME_CONFLICT', 'EXCEPTION_CONSUME_FAILED',
] as const;
export type CreditExceptionConsumptionErrorCode = typeof CREDIT_EXCEPTION_CONSUMPTION_CODES[number];
// Finite boundary declaration only. HTTP statuses come from the shared registry.
export const CREDIT_EXCEPTION_CONSUMPTION_HTTP_STATUS = CREDIT_EXCEPTION_CONSUMPTION_CODES.reduce((map, code) => {
  map[code] = httpStatusOfCode(code); return map;
}, {} as Record<CreditExceptionConsumptionErrorCode, number>);
export function isCreditExceptionConsumptionErrorCode(code: string): code is CreditExceptionConsumptionErrorCode {
  return Object.prototype.hasOwnProperty.call(CREDIT_EXCEPTION_CONSUMPTION_HTTP_STATUS, code);
}
export class CreditExceptionConsumptionError extends Error {
  readonly code: CreditExceptionConsumptionErrorCode;
  readonly statusCode: number;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CreditExceptionConsumptionError';
    this.code = isCreditExceptionConsumptionErrorCode(code) ? code : 'EXCEPTION_CONSUME_FAILED';
    this.statusCode = CREDIT_EXCEPTION_CONSUMPTION_HTTP_STATUS[this.code];
  }
}

/**
 * resolveCreditException — 信用门禁阻断后的例外裁决
 *   passed=true  → 生效例外命中，放行（调用方须在订单业务事务内 consumeCreditException 核销）
 *   passed=false → 保持阻断；hint 为人类可读指引（审批中 / 已自动发起 / 发起失败手工入口）；
 *                  approvalRequestId 在自动发起成功时透传（DE-6 统一透传契约）
 */
export async function resolveCreditException(params: {
  exceptionService: ExceptionService;
  scope: ExceptionScopeMatch;
  actorId: string;
  blockReason: string;
}): Promise<CreditExceptionGateOutcome> {
  const { exceptionService, scope, actorId, blockReason } = params;

  // 1. 生效例外精确命中 → 放行
  const check = await exceptionService.hasActiveException(scope).catch((e: any) => {
    logger.error('[CreditException] 例外查询异常（按无生效例外处理，保持阻断 fail-closed）', { error: e?.message });
    return { active: false } as any;
  });
  if (check.active && check.exception) {
    logger.warn('[CreditException] 信用门禁经生效例外放行', {
      exceptionId: check.exception.id, exceptionNumber: check.exception.exceptionNumber, scope,
    });
    return { passed: true, exception: check.exception };
  }

  // 2. 已有申请未获批 → 不重复发起（防重；审批惰性对账由 hasActiveException 完成）
  if (check.reason === 'EXCEPTION_NOT_APPROVED') {
    return { passed: false, hint: '信用例外申请已发起、审批中，审批通过后重试（可至审批中心查看进度）' };
  }

  // 3. 无申请 / 已过期 / 已核销 → 自动发起信用例外申请（DR-013 受控例外，DR-007 解析审批人）
  const created = await exceptionService.createExceptionRequest({
    exceptionCategory: CREDIT_EXCEPTION_CATEGORY,
    exceptionReason: `信用门禁自动发起：${blockReason}。现申请信用例外以推进受阻断动作，请审批人评估客户信用风险后决策`,
    riskMitigationPlan: '系统侧保持信用冻结/逾期事实不变，由审批人在例外审批中评估补救措施（如预付款、缩短账期、分批出运、财务主管担保）',
    targetType: scope.targetType,
    targetId: scope.targetId,
    action: scope.action,
    validUntil: new Date(businessNowMs() + CREDIT_EXCEPTION_WINDOW_MS),
    maxUses: 1,
    responsibleOwnerId: actorId,
    requesterId: actorId,
  }).catch((e: any) => {
    logger.error('[CreditException] 信用例外申请自动发起异常（保持阻断）', { error: e?.message });
    return null;
  });
  if (!created || !created.ok) {
    const errMsg = created && !created.ok ? created.error.message : '例外服务异常';
    logger.error('[CreditException] 信用例外申请自动发起失败（保持阻断，可手工发起）', { error: errMsg, scope });
    return {
      passed: false,
      hint: `信用例外申请自动发起失败（${errMsg}），可手工按 DR-013 发起受控例外申请：POST /api/v1/exceptions（exceptionCategory=credit_exemption）`,
    };
  }
  logger.warn('[CreditException] 信用门禁阻断，已自动发起信用例外申请', {
    exceptionId: created.data.exception.id,
    exceptionNumber: created.data.exception.exceptionNumber,
    approvalRequestId: created.data.approvalRequestId,
    scope,
  });
  return {
    passed: false,
    approvalRequestId: created.data.approvalRequestId,
    hint: `已自动发起信用例外申请（例外单 ${created.data.exception.exceptionNumber}，审批单 ${created.data.approvalRequestId}），审批通过后重试`,
  };
}

/**
 * Business mutation and consumption MUST use the same supplied transaction.
 * Any rejected quota/scope/deadline or failed mandatory audit throws so the
 * caller rolls back the order, transition and business projections together.
 */
export async function consumeCreditException(params: {
  exceptionService: ExceptionService;
  exceptionId: string;
  scope: ExceptionScopeMatch;
  actorId: string;
  note?: string;
  tx: Prisma.TransactionClient;
}): Promise<void> {
  const { exceptionService, exceptionId, scope, actorId, note, tx } = params;
  if (!tx) throw new CreditExceptionConsumptionError('EXCEPTION_CONSUME_FAILED', '信用例外核销缺少业务事务，订单动作未确认');
  const res = await exceptionService.consumeException({
    exceptionId,
    targetType: scope.targetType,
    targetId: scope.targetId,
    action: scope.action,
    consumedBy: actorId,
    note: note ?? '信用例外放行后动作执行核销',
    tx,
  }).catch((e: any) => {
    logger.error('[CreditException] 业务事务中的例外核销异常，订单动作保持未确认', { exceptionId, error: e?.message });
    throw new CreditExceptionConsumptionError('EXCEPTION_CONSUME_FAILED', '信用例外核销未能完成，订单动作未确认，请稍后重试');
  });
  if (!res.ok) {
    logger.error('[CreditException] 例外核销被拒绝，回滚订单业务事务', {
      exceptionId, error: res.error.code, message: res.error.message,
    });
    throw new CreditExceptionConsumptionError(res.error.code, res.error.message);
  }
}
