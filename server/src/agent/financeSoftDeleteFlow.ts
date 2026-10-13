import type { TokenPayload } from '../auth/service';
/**
 * Agent-P1-finance-soft-delete-flow-contract
 *
 * invoice.delete / payment_voucher.delete draft→approval→commit 流程契约。
 * 复用 deleteInvoice/deleteVoucher service（route + Agent flow 共用契约），不在 Agent path 手写 DB mutation。
 * ProcessDraft what-you-approve-is-what-you-commit，beforeAfterDiff deletedAt null→true，impactScope 含 finance/entity-links/audit。
 */

import { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import {
  deleteInvoice,
  deleteVoucher,
  type FinanceVoidDeleteErrorCode,
} from '../finance/voidDeleteService';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

export type FinanceSoftDeleteFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | FinanceVoidDeleteErrorCode
  | 'UNKNOWN_ERROR';

export interface FinanceSoftDeleteFlowError {
  code: FinanceSoftDeleteFlowErrorCode;
  message: string;
  userAction: string;
}

export interface FinanceSoftDeleteFlowCommitted {
  status: 'committed';
  entityId: string;
  auditId: string;
  idempotencyKey: string;
}

export type FinanceSoftDeleteFlowFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | FinanceSoftDeleteFlowCommitted
  | { status: 'failed'; error: FinanceSoftDeleteFlowError; approvalId?: string };

export function buildFinanceSoftDeleteError(code: FinanceSoftDeleteFlowErrorCode, message: string): FinanceSoftDeleteFlowError {
  const userActionMap: Record<FinanceSoftDeleteFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起删除流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: '删除 draft 语义校验失败，请检查 entityId',
    INVOICE_NOT_FOUND: '发票不存在，请检查 invoiceId',
    VOUCHER_NOT_FOUND: '凭证不存在，请检查 voucherId',
    INVALID_STATUS: '状态不允许删除',
    HAS_ALLOCATIONS: '存在核销记录，请先撤销核销',
    SOURCE_CLAIM_CONFLICT: '供应商索赔与贷项关联不一致，请先核对源索赔和发票记录',
    HANDOFF_CONFLICT: '该财务记录受原商业发票来源约束，请返回业务单据核对',
    CANCEL_FAILED: '作废事务失败已回滚，请重试',
    DELETE_FAILED: '删除事务失败已回滚，请重试',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  return { code, message, userAction: userActionMap[code] };
}

// ────────────────────────────────────────────────────────────────
// invoice.delete draft + commit
// ────────────────────────────────────────────────────────────────

export interface InvoiceDeleteDraftInput {
  invoiceId: string;
}

export function buildInvoiceDeleteDraft(input: InvoiceDeleteDraftInput): ProcessDraft {
  const { invoiceId } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'invoice.delete',
    entityId: invoiceId,
    action: 'delete_invoice',
    before: {},
    after: { invoiceId },
  }];
  const beforeAfterDiff = [{
    entity: 'invoice',
    entityId: invoiceId,
    field: 'deletedAt',
    before: null,
    after: true as any,
  }];
  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['finance', 'entity-links', 'audit'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `invoice.delete:${invoiceId}:${hash}`;
  return { ...content, idempotencyKey };
}

export function validateInvoiceDeleteDraftSemantics(draft: any): { ok: boolean; error?: FinanceSoftDeleteFlowError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildFinanceSoftDeleteError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!after?.invoiceId) {
    return { ok: false, error: buildFinanceSoftDeleteError('SEMANTIC_VALIDATION_FAILED', 'draft must contain invoiceId') };
  }
  return { ok: true };
}

export function verifyInvoiceDeleteDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

export async function commitInvoiceDelete(
  params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string; actor?: TokenPayload | null;},
): Promise<{ ok: true; feedback: FinanceSoftDeleteFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: FinanceSoftDeleteFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildFinanceSoftDeleteError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  }
  const hashCheck = verifyInvoiceDeleteDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildFinanceSoftDeleteError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }
  const semCheck = validateInvoiceDeleteDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }
  const after = draft.subOperations[0].after as any;
  const result = await deleteInvoice({ prisma, invoiceId: after.invoiceId, requestKey: after.requestKey, expectedUpdatedAt: after.expectedUpdatedAt, actorId: params.actor?.userId, actor: params.actor });
  if (!result.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildFinanceSoftDeleteError(result.error!.code as FinanceSoftDeleteFlowErrorCode, result.error!.message), approvalId } };
  }
  return { ok: true, feedback: { status: 'committed', entityId: after.invoiceId, auditId: result.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}

// ────────────────────────────────────────────────────────────────
// payment_voucher.delete draft + commit
// ────────────────────────────────────────────────────────────────

export interface PaymentVoucherDeleteDraftInput {
  voucherId: string;
}

export function buildPaymentVoucherDeleteDraft(input: PaymentVoucherDeleteDraftInput): ProcessDraft {
  const { voucherId } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'payment_voucher.delete',
    entityId: voucherId,
    action: 'delete_voucher',
    before: {},
    after: { voucherId },
  }];
  const beforeAfterDiff = [{
    entity: 'paymentVoucher',
    entityId: voucherId,
    field: 'deletedAt',
    before: null,
    after: true as any,
  }];
  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['finance', 'entity-links', 'audit'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `payment_voucher.delete:${voucherId}:${hash}`;
  return { ...content, idempotencyKey };
}

export function validatePaymentVoucherDeleteDraftSemantics(draft: any): { ok: boolean; error?: FinanceSoftDeleteFlowError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildFinanceSoftDeleteError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!after?.voucherId) {
    return { ok: false, error: buildFinanceSoftDeleteError('SEMANTIC_VALIDATION_FAILED', 'draft must contain voucherId') };
  }
  return { ok: true };
}

export function verifyPaymentVoucherDeleteDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

export async function commitPaymentVoucherDelete(
  params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string; actor?: TokenPayload | null;},
): Promise<{ ok: true; feedback: FinanceSoftDeleteFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: FinanceSoftDeleteFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildFinanceSoftDeleteError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  }
  const hashCheck = verifyPaymentVoucherDeleteDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildFinanceSoftDeleteError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }
  const semCheck = validatePaymentVoucherDeleteDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }
  const after = draft.subOperations[0].after as any;
  const result = await deleteVoucher({ prisma, voucherId: after.voucherId, requestKey: after.requestKey, expectedUpdatedAt: after.expectedUpdatedAt, actorId: params.actor?.userId, actor: params.actor });
  if (!result.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildFinanceSoftDeleteError(result.error!.code as FinanceSoftDeleteFlowErrorCode, result.error!.message), approvalId } };
  }
  return { ok: true, feedback: { status: 'committed', entityId: after.voucherId, auditId: result.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}
