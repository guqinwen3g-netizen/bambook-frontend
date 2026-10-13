/**
 * Agent-P1-order-lifecycle-flow-contract
 *
 * order.status_transition / order.delete draft→approval→commit 流程契约。
 * 复用 orderLifecycleService（route + Agent flow 共用契约），不在 Agent path 手写 DB mutation。
 * ProcessDraft what-you-approve-is-what-you-commit。
 */

import { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import { isCreditExceptionConsumptionErrorCode, type CreditExceptionConsumptionErrorCode } from '../credit/creditExceptionGate';
import {
  deleteOrder,
  transitionOrderStatus,
  VALID_ORDER_STATUSES,
  type OrderLifecycleErrorCode,
  type OrderLifecycleExtensionErrorCode,
} from '../orders/orderLifecycleService';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

export type OrderLifecycleFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | OrderLifecycleErrorCode
  // DR-010 守卫态 / 已关闭终态：`transitionOrderStatus` 会 throw 这两个码，但它们
  // **刻意不在 OrderLifecycleErrorCode 联合类型里**（见 orderLifecycleService.ts:55-58）。
  // 此处显式纳入，否则 `userActionMap[code]` 取不到 → userAction 变成 undefined
  // （2026-09-17 真库演练发现；同一根因还让 V1 路由把 409 兜成了 500）。
  | OrderLifecycleExtensionErrorCode
  | 'UNKNOWN_ERROR';

export interface OrderLifecycleFlowError {
  code: OrderLifecycleFlowErrorCode | CreditExceptionConsumptionErrorCode;
  message: string;
  userAction: string;
}

export interface OrderLifecycleFlowCommitted {
  status: 'committed';
  orderId: string;
  auditId: string;
  idempotencyKey: string;
}

export type OrderLifecycleFlowFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | OrderLifecycleFlowCommitted
  | { status: 'failed'; error: OrderLifecycleFlowError; approvalId?: string };

export function buildOrderLifecycleError(code: OrderLifecycleFlowErrorCode | CreditExceptionConsumptionErrorCode, message: string): OrderLifecycleFlowError {
  // Actual bounded service outcomes have their own precise code; the older
  // Agent flow enum/exhaustive map remains the declared orchestration contract.
  // This builder alone cannot certify that a transaction has rolled back.
  if (isCreditExceptionConsumptionErrorCode(code)) {
    return { code, message, userAction: '请核对例外范围、有效期和剩余次数；服务故障请稍后重试或联系管理员。' };
  }
  const userActionMap: Record<OrderLifecycleFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查 orderId/toStatus',
    ORDER_NOT_FOUND: '订单不存在或已删除',
    ORDER_ALREADY_DELETED: '订单已删除，无需重复删除',
    INVALID_STATUS: '目标状态非法（只允许 Pending/Confirmed/Production/Shipping/Delivered/Alert）',
    INVALID_TRANSITION: '当前状态不允许流转到目标状态，请检查状态转换矩阵',
    ORDER_LINE_WORKFLOW_REQUIRED: '投产与出运状态由订单条目履约流程推进；请打开具体订单条目继续，不能修改订单主单状态',
    NO_CHANGE: '订单已在目标状态，无需流转',
    DELETE_FAILED: '删除事务失败已回滚，请重试',
    TRANSITION_FAILED: '状态流转事务失败已回滚，请重试',
    ORDER_MAIN_APPROVAL_REQUIRED: '订单主单尚未通过业务域审批；请先提交并完成订单审批，再继续确认订单',
    LC_GATE_BLOCKED: '该订单付款方式为信用证（L/C），但尚未登记可用信用证或信用证已过有效期：请先在「信用证」里登记并核对期限，再确认订单',
    LC_EXCEPTION_CHECK_FAILED: '信用证条款未通过且例外状态查不出来：请先排查例外/审批服务是否可用，再按 DR-013 处理',
    MOQ_VIOLATION: '订单数量低于 MOQ，须先完成 MOQ 豁免审批后重试',
    CREDIT_FROZEN_60_DAYS: '客户信用额度已冻结（≥60 天逾期或人工冻结），请财务解冻后再确认订单',
    CREDIT_REVOKED: '客户信用额度已吊销（坏账），禁止确认订单',
    OVERDUE_60_DAYS: '客户存在 ≥60 天逾期未结清应收，请财务处理后再确认订单',
    CREDIT_CHECK_FAILED: '信用门禁校验失败（fail-closed），请重试或联系管理员',
    // B14（refs G3-LA）：删除守卫的依赖计数查不出来 ⇒ 已拒删并回滚，什么都没改，可放心重试
    DEPENDENCY_CHECK_FAILED: '订单关联单据校验未能完成（fail-closed，删除已阻止、未做任何改动），请稍后重试或联系管理员',
    ORDER_LIFECYCLE_GUARDED: '订单存在进行中的变更/取消/暂停申请，请先完成或撤回该申请，再推进状态',
    ORDER_ALREADY_CLOSED: '订单已关闭（Cancelled 终态），不能再推进状态',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  return { code, message, userAction: userActionMap[code] };
}

// ────────────────────────────────────────────────────────────────
// order.status_transition draft
// ────────────────────────────────────────────────────────────────

export interface OrderStatusTransitionDraftInput {
  orderId: string;
  toStatus: string;
  currentStatus?: string; // 从真实 order 读
  note?: string;
  lineId?: string;
}

export function buildOrderStatusTransitionDraft(input: OrderStatusTransitionDraftInput): ProcessDraft {
  const { orderId, toStatus, currentStatus, note, lineId } = input;
  const afterPayload: Record<string, any> = { orderId, toStatus };
  if (note !== undefined) afterPayload.note = note;
  if (lineId !== undefined) afterPayload.lineId = lineId;

  const subOperations: SubOperation[] = [{
    toolId: 'order.status_transition',
    entityId: orderId,
    action: 'transition_order_status',
    before: {},
    after: afterPayload,
  }];

  const beforeAfterDiff = [{
    entity: 'order',
    entityId: orderId,
    field: 'status',
    before: (currentStatus || 'unknown') as any,
    after: toStatus as any,
  }];

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['orders'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `order.status_transition:${orderId}:${toStatus}:${hash}`;

  return { ...content, idempotencyKey };
}

export function validateOrderStatusTransitionDraftSemantics(draft: any): { ok: boolean; error?: OrderLifecycleFlowError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildOrderLifecycleError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!after?.orderId) {
    return { ok: false, error: buildOrderLifecycleError('SEMANTIC_VALIDATION_FAILED', 'draft must contain orderId') };
  }
  if (!after?.toStatus) {
    return { ok: false, error: buildOrderLifecycleError('SEMANTIC_VALIDATION_FAILED', 'draft must contain toStatus') };
  }
  if (!VALID_ORDER_STATUSES.includes(after.toStatus)) {
    return { ok: false, error: buildOrderLifecycleError('INVALID_STATUS', `Invalid toStatus: ${after.toStatus}`) };
  }
  return { ok: true };
}

export async function commitOrderStatusTransition(
  params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string;},
): Promise<{ ok: true; feedback: OrderLifecycleFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: OrderLifecycleFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildOrderLifecycleError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  }
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  if (recomputedHash !== actualHashPart) {
    return { ok: false, feedback: { status: 'failed', error: buildOrderLifecycleError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${recomputedHash} actual=${actualHashPart}`), approvalId } };
  }
  const semCheck = validateOrderStatusTransitionDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }
  const after = draft.subOperations[0].after as any;
  const result = await transitionOrderStatus({
    prisma, orderId: after.orderId, toStatus: after.toStatus,
    note: after.note, lineId: after.lineId, actorId: auditActorFrom(params),
  });
  if (!result.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildOrderLifecycleError(result.error!.code, result.error!.message), approvalId } };
  }
  return { ok: true, feedback: { status: 'committed', orderId: result.data!.order.id, auditId: result.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}

// ────────────────────────────────────────────────────────────────
// order.delete draft
// ────────────────────────────────────────────────────────────────

export interface OrderDeleteDraftInput {
  orderId: string;
}

export function buildOrderDeleteDraft(input: OrderDeleteDraftInput): ProcessDraft {
  const { orderId } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'order.delete',
    entityId: orderId,
    action: 'delete_order',
    before: {},
    after: { orderId },
  }];
  const beforeAfterDiff = [{
    entity: 'order',
    entityId: orderId,
    field: 'deletedAt',
    before: null,
    after: true as any,
  }];
  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['orders'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `order.delete:${orderId}:${hash}`;
  return { ...content, idempotencyKey };
}

export function validateOrderDeleteDraftSemantics(draft: any): { ok: boolean; error?: OrderLifecycleFlowError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildOrderLifecycleError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!after?.orderId) {
    return { ok: false, error: buildOrderLifecycleError('SEMANTIC_VALIDATION_FAILED', 'draft must contain orderId') };
  }
  return { ok: true };
}

export async function commitOrderDelete(
  params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string;},
): Promise<{ ok: true; feedback: OrderLifecycleFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: OrderLifecycleFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildOrderLifecycleError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  }
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  if (recomputedHash !== actualHashPart) {
    return { ok: false, feedback: { status: 'failed', error: buildOrderLifecycleError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${recomputedHash} actual=${actualHashPart}`), approvalId } };
  }
  const semCheck = validateOrderDeleteDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }
  const after = draft.subOperations[0].after as any;
  const result = await deleteOrder({ prisma, orderId: after.orderId, actorId: auditActorFrom(params) });
  if (!result.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildOrderLifecycleError(result.error!.code, result.error!.message), approvalId } };
  }
  return { ok: true, feedback: { status: 'committed', orderId: after.orderId, auditId: result.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}
