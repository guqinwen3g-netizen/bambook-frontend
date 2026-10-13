import type { TokenPayload } from '../auth/service';
/**
 * Agent-P1-payment-voucher-mutation-flow-contract
 * payment_voucher.create / update draft→approval→commit 流程契约。
 * commit 复用 paymentVoucherMutationService，不在 Agent path 手写 DB mutation。
 */

import { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import {
  createPaymentVoucher,
  updatePaymentVoucher,
  type PaymentVoucherMutationErrorCode,
} from '../finance/paymentVoucherMutationService';
import { computeProcessDraftHash, type ProcessDraft, type SubOperation } from './toolRegistry';

export type PaymentVoucherFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | PaymentVoucherMutationErrorCode;

export interface PaymentVoucherFlowError {
  code: PaymentVoucherFlowErrorCode;
  message: string;
  userAction: string;
}

export interface PaymentVoucherFlowCommitted {
  status: 'committed';
  voucherId: string;
  auditId: string;
  idempotencyKey: string;
}

export function buildPaymentVoucherFlowError(code: PaymentVoucherFlowErrorCode, message: string): PaymentVoucherFlowError {
  const userActionMap: Record<PaymentVoucherFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查凭证输入',
    VALIDATION_ERROR: '凭证必填字段缺失（type/amount/currency/paymentMethod），请补全后重试',
    INVALID_STATUS: '凭证核销状态非法，请使用 unreconciled/partially_reconciled/reconciled',
    INVALID_VOUCHER_CATEGORY: '凭证分类非法，请使用 normal/advance/deposit/sample_express/customer_reimburse/business_cost',
    INVALID_CURRENCY: '币种必须在白名单内（USD/EUR/CNY/GBP/JPY/HKD/AUD/CAD），请修正后重试',
    // OUR=汇款方承担全部；BEN=收款方承担全部；SHA=各自承担己方费用。
    // 「我方」是谁取决于凭证类型（收款时我方=收款方，付款时我方=汇款方）⇒ 此处只给枚举，不替调用方判断承担方
    INVALID_FEE_BEARER: '银行手续费承担方非法，请使用 OUR / BEN / SHA（OUR=汇款方承担，BEN=收款方承担，SHA=各自承担己方费用）',
    INVALID_AMOUNT: '金额格式非法，请使用 Decimal 字符串',
    NOT_FOUND: '目标收付款凭证不存在或已删除',
    CREATE_FAILED: '创建事务失败已回滚，请重试',
    UPDATE_FAILED: '更新事务失败已回滚，请重试',
    INVALID_STATE: '凭证已有核销，请先撤销原核销，再修正金额、币种或交易方并重新核销',
    STATUS_NOT_MANUAL_SETTABLE: '凭证状态只能由核销/分配操作设置，不可手动修改',
    PAYMENT_REQUEST_REQUIRED: '付款（Disbursement）凭证须先经付款申请并获批（DR-017），请携带 paymentRequestId 重试',
    PAYMENT_REQUEST_ALREADY_LINKED: '该付款申请已关联凭证，请刷新申请并核对现有凭证后再重试',
  };
  return { code, message, userAction: userActionMap[code] };
}

function verifyHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const expected = computeProcessDraftHash(content);
  const actual = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: expected === actual, expected, actual };
}

// ─── CREATE ────────────────────────────────────────────────────────
export function buildPaymentVoucherCreateDraft(input: { input: Record<string, unknown> }): ProcessDraft {
  const body = input.input || {};
  const voucherNumber = String((body as any).voucherNumber || '');
  const subOperations: SubOperation[] = [{
    toolId: 'payment_voucher.create',
    entityId: voucherNumber || 'new',
    action: 'create_payment_voucher',
    before: {},
    after: { ...body },
  }];
  const beforeAfterDiff = Object.entries(body).map(([field, after]) => ({
    entity: 'paymentVoucher', entityId: voucherNumber || 'new', field, before: null, after,
  }));
  const content = { subOperations, beforeAfterDiff, impactScope: ['finance', 'entity-links', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `payment_voucher.create:${voucherNumber || 'new'}:${hash}` };
}

export function validatePaymentVoucherCreateDraftSemantics(draft: any): { ok: boolean; error?: PaymentVoucherFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildPaymentVoucherFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  for (const field of ['voucherNumber', 'type', 'amount', 'currency', 'paymentDate', 'paymentMethod']) {
    if (after?.[field] === undefined || after?.[field] === null || after?.[field] === '') {
      return { ok: false, error: buildPaymentVoucherFlowError('SEMANTIC_VALIDATION_FAILED', `draft must contain ${field}`) };
    }
  }
  return { ok: true };
}

export function verifyPaymentVoucherCreateDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitPaymentVoucherCreate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string; actor?: TokenPayload | null;}): Promise<{ ok: true; feedback: PaymentVoucherFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: PaymentVoucherFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildPaymentVoucherFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildPaymentVoucherFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validatePaymentVoucherCreateDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: (sem as any).error!, approvalId } };
  const result = await createPaymentVoucher({ prisma, input: draft.subOperations[0].after, actorId: params.actor?.userId, actor: params.actor });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildPaymentVoucherFlowError((result as any).error!.code, (result as any).error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', voucherId: result.data!.voucher.id, auditId: result.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}

// ─── UPDATE ────────────────────────────────────────────────────────
export function buildPaymentVoucherUpdateDraft(input: { voucherId: string; patch: Record<string, unknown>; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { voucherId, patch, currentSnapshot = {} } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'payment_voucher.update',
    entityId: voucherId,
    action: 'update_payment_voucher',
    before: currentSnapshot,
    after: { voucherId, patch },
  }];
  const beforeAfterDiff = Object.keys(patch).map((field) => ({
    entity: 'paymentVoucher', entityId: voucherId, field, before: (currentSnapshot as any)[field] ?? null, after: (patch as any)[field],
  }));
  const content = { subOperations, beforeAfterDiff, impactScope: ['finance', 'entity-links', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `payment_voucher.update:${voucherId}:${hash}` };
}

export function validatePaymentVoucherUpdateDraftSemantics(draft: any): { ok: boolean; error?: PaymentVoucherFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildPaymentVoucherFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.voucherId) return { ok: false, error: buildPaymentVoucherFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain voucherId') };
  if (!after?.patch || typeof after.patch !== 'object' || Object.keys(after.patch).length === 0) return { ok: false, error: buildPaymentVoucherFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain non-empty patch') };
  return { ok: true };
}

export function verifyPaymentVoucherUpdateDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitPaymentVoucherUpdate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string; actor?: TokenPayload | null;}): Promise<{ ok: true; feedback: PaymentVoucherFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: PaymentVoucherFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildPaymentVoucherFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildPaymentVoucherFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validatePaymentVoucherUpdateDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: (sem as any).error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const result = await updatePaymentVoucher({ prisma, voucherId: after.voucherId, input: after.patch, actorId: params.actor?.userId, actor: params.actor });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildPaymentVoucherFlowError((result as any).error!.code, (result as any).error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', voucherId: result.data!.voucher.id, auditId: result.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}
