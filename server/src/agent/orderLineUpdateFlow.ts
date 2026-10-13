/**
 * Agent-P1-order-line-update-flow-contract
 *
 * order.line_update draft→approval→commit 流程契约。
 * 复用 updateOrderLine service（route + Agent flow 共用契约），不在 Agent path 手写 DB mutation。
 * ProcessDraft what-you-approve-is-what-you-commit。
 */

import { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import type { TokenPayload } from '../auth/service';
import {
  updateOrderLine,
  type OrderLineMutationErrorCode,
} from '../orders/orderLineMutationService';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

export type OrderLineUpdateFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | OrderLineMutationErrorCode
  | 'UNKNOWN_ERROR';

export interface OrderLineUpdateFlowError {
  code: OrderLineUpdateFlowErrorCode;
  message: string;
  userAction: string;
}

export interface OrderLineUpdateFlowCommitted {
  status: 'committed';
  lineId: string;
  auditId: string;
  idempotencyKey: string;
}

export type OrderLineUpdateFlowFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | OrderLineUpdateFlowCommitted
  | { status: 'failed'; error: OrderLineUpdateFlowError; approvalId?: string };

export function buildOrderLineUpdateError(code: OrderLineUpdateFlowErrorCode, message: string): OrderLineUpdateFlowError {
  const userActionMap: Record<OrderLineUpdateFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查 lineId/patch',
    INVALID_INPUT: '输入非法（缺少 lineId 或 patch 为空）',
    ORDER_NOT_FOUND: '父订单不存在或已删除',
    ORDER_LINE_NOT_FOUND: '订单行不存在',
    DUPLICATE_ITEM_NO: '订单行 itemNo 重复',
    CREATE_LINE_FAILED: '订单行操作失败已回滚',
    UPDATE_LINE_FAILED: '订单行更新失败已回滚，请重试',
    UNAUTHORIZED: '请使用有效的用户会话重新执行订单行更新',
    ACCOUNT_DISABLED: '当前账号不可用，请联系管理员',
    FORBIDDEN: '当前账号没有该订单行的操作权限',
    AUTHORIZATION_UNAVAILABLE: '暂时无法核验当前权限，请稍后用原请求重试',
    CONFLICT: '订单行或授权范围已变化，请刷新后重新核对',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  return { code, message, userAction: userActionMap[code] };
}

export interface OrderLineUpdateDraftInput {
  lineId: string;
  patch: Record<string, unknown>;
  currentSnapshot?: Record<string, unknown>; // 从真实 orderLine 读（beforeAfterDiff before）
}

export function buildOrderLineUpdateDraft(input: OrderLineUpdateDraftInput): ProcessDraft {
  const { lineId, patch, currentSnapshot } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'order.line_update',
    entityId: lineId,
    action: 'update_order_line',
    before: currentSnapshot || {},
    after: { lineId, patch },
  }];

  const beforeAfterDiff = Object.keys(patch).map((field) => ({
    entity: 'orderLine',
    entityId: lineId,
    field,
    before: (currentSnapshot?.[field] ?? null) as any,
    after: patch[field] as any,
  }));

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['orders'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `order.line_update:${lineId}:${hash}`;
  return { ...content, idempotencyKey };
}

export function validateOrderLineUpdateDraftSemantics(draft: any): { ok: boolean; error?: OrderLineUpdateFlowError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildOrderLineUpdateError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!after?.lineId) {
    return { ok: false, error: buildOrderLineUpdateError('SEMANTIC_VALIDATION_FAILED', 'draft must contain lineId') };
  }
  if (!after?.patch || typeof after.patch !== 'object' || Object.keys(after.patch).length === 0) {
    return { ok: false, error: buildOrderLineUpdateError('INVALID_INPUT', 'draft patch must be a non-empty object') };
  }
  return { ok: true };
}

export function verifyOrderLineUpdateDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

export async function commitOrderLineUpdate(
  params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string; trustedActor?: TokenPayload; },
): Promise<{ ok: true; feedback: OrderLineUpdateFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: OrderLineUpdateFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildOrderLineUpdateError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  }
  const hashCheck = verifyOrderLineUpdateDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildOrderLineUpdateError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }
  const semCheck = validateOrderLineUpdateDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }
  const after = draft.subOperations[0].after as any;
  const result = await updateOrderLine({
    prisma, lineId: after.lineId, patch: after.patch, actorId: auditActorFrom(params), trustedActor: params.trustedActor,
  });
  if (!result.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildOrderLineUpdateError(result.error!.code as OrderLineUpdateFlowErrorCode, result.error!.message), approvalId } };
  }
  return { ok: true, feedback: { status: 'committed', lineId: result.data!.line.id, auditId: result.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}
