import type { TokenPayload } from '../auth/service';
/**
 * Agent-P1-invoice-cancel-flow-contract
 *
 * invoice.cancel draft→approval→commit 流程契约。
 * 复用 cancelInvoice service（route + Agent flow 共用契约），不在 Agent path 手写 DB mutation。
 * ProcessDraft what-you-approve-is-what-you-commit。
 */

import { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import { cancelInvoice, type FinanceVoidDeleteErrorCode } from '../finance/voidDeleteService';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

export type InvoiceCancelFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | FinanceVoidDeleteErrorCode
  | 'UNKNOWN_ERROR';

export interface InvoiceCancelFlowError {
  code: InvoiceCancelFlowErrorCode;
  message: string;
  userAction: string;
}

export interface InvoiceCancelFlowCommitted {
  status: 'committed';
  invoiceId: string;
  auditId: string;
  idempotencyKey: string;
}

export type InvoiceCancelFlowFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | InvoiceCancelFlowCommitted
  | { status: 'failed'; error: InvoiceCancelFlowError; approvalId?: string };

export function buildInvoiceCancelError(code: InvoiceCancelFlowErrorCode, message: string): InvoiceCancelFlowError {
  const userActionMap: Record<InvoiceCancelFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起作废流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: '作废 draft 语义校验失败，请检查 invoiceId',
    INVOICE_NOT_FOUND: '发票不存在，请检查 invoiceId',
    VOUCHER_NOT_FOUND: '凭证不存在',
    INVALID_STATUS: '发票状态不允许作废（可能是已 Cancelled）',
    HAS_ALLOCATIONS: '发票存在核销记录，请先撤销核销',
    SOURCE_CLAIM_CONFLICT: '供应商索赔与贷项关联不一致，请先核对源索赔和发票记录',
    HANDOFF_CONFLICT: '该财务记录受原商业发票来源约束，请返回业务单据核对',
    CANCEL_FAILED: '作废事务失败已回滚，请重试',
    DELETE_FAILED: '删除事务失败已回滚，请重试',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  return { code, message, userAction: userActionMap[code] };
}

export interface InvoiceCancelDraftInput {
  invoiceId: string;
  reason?: string;
  currentStatus?: string; // 从真实 invoice 读，避免 hardcode
}

export function buildInvoiceCancelDraft(input: InvoiceCancelDraftInput): ProcessDraft {
  const { invoiceId, reason, currentStatus } = input;
  const afterPayload: Record<string, any> = { invoiceId };
  if (reason !== undefined) afterPayload.reason = reason;

  const subOperations: SubOperation[] = [{
    toolId: 'invoice.cancel',
    entityId: invoiceId,
    action: 'cancel_invoice',
    before: {},
    after: afterPayload,
  }];

  const beforeAfterDiff = [{
    entity: 'invoice',
    entityId: invoiceId,
    field: 'status',
    before: (currentStatus || 'unknown') as any, // 从真实 invoice 读，不 hardcode
    after: 'Cancelled' as any,
  }];

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['finance'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `invoice.cancel:${invoiceId}:${hash}`;

  return { ...content, idempotencyKey };
}

export function validateInvoiceCancelDraftSemantics(draft: any): { ok: boolean; error?: InvoiceCancelFlowError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildInvoiceCancelError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!after?.invoiceId) {
    return { ok: false, error: buildInvoiceCancelError('SEMANTIC_VALIDATION_FAILED', 'draft must contain invoiceId in subOperations.after') };
  }
  return { ok: true };
}

export function verifyInvoiceCancelDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:')
    ? 'pd:' + idempotencyKey.split(':pd:')[1]
    : idempotencyKey;
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

export interface InvoiceCancelCommitParams {
  actor?: TokenPayload | null;
  /** ★ B58：审批请求人，由 `toolDispatchRegistry` 注入；缺省落 'system'（AuditLog.actorId 有外键） */
  actorId?: string;
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: any;
}

export async function commitInvoiceCancel(
  params: InvoiceCancelCommitParams,
): Promise<{ ok: true; feedback: InvoiceCancelFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: InvoiceCancelFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;

  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildInvoiceCancelError('PROCESS_DRAFT_MISSING', 'processDraft not found in approval payload'), approvalId } };
  }

  const hashCheck = verifyInvoiceCancelDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildInvoiceCancelError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }

  const semCheck = validateInvoiceCancelDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }

  const after = draft.subOperations[0].after as any;

  // 复用 cancelInvoice service（不绕 route，不手写 DB mutation）
  const result = await cancelInvoice({
    prisma,
    invoiceId: after.invoiceId,
    actorId: params.actor?.userId, actor: params.actor,
    reason: after.reason,
    requestKey: after.requestKey, expectedUpdatedAt: after.expectedUpdatedAt,
  });

  if (!result.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildInvoiceCancelError(result.error!.code as InvoiceCancelFlowErrorCode, result.error!.message), approvalId } };
  }

  return {
    ok: true,
    feedback: {
      status: 'committed',
      invoiceId: result.data!.invoice.id,
      auditId: result.data!.auditId,
      idempotencyKey: draft.idempotencyKey,
    },
  };
}
