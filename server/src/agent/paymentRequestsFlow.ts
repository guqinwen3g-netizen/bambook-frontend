/**
 * Agent-Phase2-payment-requests-flow-contract
 * payment_requests.create / payment_requests.cancel draft→approval→commit 流程契约。
 *
 * commit 复用 paymentRequestService（DR-017 先申请后付款唯一入口，与路由同一真源），
 * service 工厂经 await import 惰性加载（newDomainQueryTools 先例，免疫既有测试模块级 total-mock
 * 的导入链耦合），不在 Agent path 手写 DB mutation。
 * 幂等三层：ProcessDraft hash + AgentCommitReceipt（registerCommitTool 收口）+ service 层状态机守卫。
 *
 * 注意：createPaymentRequest 内部会创建 DR-017 业务审批单（createBusinessApproval），
 * Agent 审批是「用户确认 Agent 动作」门禁，两者语义独立、串联生效。
 */

import { PrismaClient } from '@prisma/client';
import { computeProcessDraftHash, type ProcessDraft, type SubOperation } from './toolRegistry';
import { registerCommitTool } from './toolDispatchRegistry';
import type { PaymentRequestErrorCode } from '../paymentRequests/paymentRequestService';

export type PaymentRequestsFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | PaymentRequestErrorCode;

export interface PaymentRequestsFlowError {
  code: PaymentRequestsFlowErrorCode;
  message: string;
  userAction: string;
}

export interface PaymentRequestsFlowCommitted {
  status: 'committed';
  paymentRequestId: string;
  requestNumber?: string;
  /** DR-017 业务审批单 ID（由 service 内部创建，非 Agent 审批单） */
  domainApprovalId?: string;
  idempotencyKey: string;
}

/** 付款性质枚举（与 PaymentVoucher.voucherCategory 同一真源；本地固化避免运行时耦合） */
const PAYMENT_CATEGORIES_LOCAL = ['normal', 'advance', 'deposit', 'sample_express', 'customer_reimburse', 'business_cost'] as const;

export function buildPaymentRequestsFlowError(code: PaymentRequestsFlowErrorCode, message: string): PaymentRequestsFlowError {
  const userActionMap: Record<PaymentRequestsFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查付款申请输入',
    MISSING_PAYEE: '付款对象必填：supplierId 或 supplierName 至少提供其一',
    INVALID_AMOUNT: '金额必须为合法十进制数且 > 0',
    MISSING_CURRENCY: '币种 currency 必填',
    INVALID_PAYMENT_CATEGORY: '付款性质必须是 normal/advance/deposit/sample_express/customer_reimburse/business_cost 之一',
    INVALID_DATE: '日期格式必须为 YYYY-MM-DD',
    PAYMENT_REQUEST_NOT_FOUND: '付款申请不存在或已删除，请确认 paymentRequestId',
    PAYMENT_REQUEST_NOT_APPROVED: '付款申请未批准，无法生成付款凭证',
    PAYMENT_REQUEST_NOT_CANCELLABLE: '仅 Draft/Pending 状态的付款申请可作废',
    CANCEL_NOT_BY_APPLICANT: '仅申请人本人可作废付款申请',
    VOUCHER_ISSUE_FAILED: '付款凭证生成失败，请重试或联系财务',
    CREATE_FAILED: '创建/作废事务失败已回滚，请重试',
    NO_REVIEWER_RESOLVED: '无法解析审批人（部门无主管），请联系管理员配置审批路由',
  };
  return { code, message, userAction: userActionMap[code] };
}

function verifyHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const expected = computeProcessDraftHash(content);
  const actual = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: expected === actual, expected, actual };
}

/** 依赖 approvalCreateService 的域服务构造（与路由/newDomainQueryTools 同一线路；惰性加载） */
async function makePaymentRequestService(prisma: PrismaClient) {
  const { createApprovalRoutingService } = await import('../approvals/approvalRoutingService');
  const { createApprovalCreateService } = await import('../approvals/approvalCreateService');
  const { createPaymentRequestService } = await import('../paymentRequests/paymentRequestService');
  const routingService = createApprovalRoutingService({ prisma });
  const approvalCreateService = createApprovalCreateService({ prisma, routingService });
  return createPaymentRequestService({ prisma, approvalCreateService });
}

// ─── CREATE ────────────────────────────────────────────────────────
export function buildPaymentRequestCreateDraft(input: { input: Record<string, unknown> }): ProcessDraft {
  const body = input.input || {};
  const payee = String((body as any).supplierId || (body as any).supplierName || 'new');
  const subOperations: SubOperation[] = [{
    toolId: 'payment_requests.create',
    entityId: payee,
    action: 'create_payment_request',
    before: {},
    after: { ...body },
  }];
  const beforeAfterDiff = [
    ...Object.entries(body).map(([field, after]) => ({
      entity: 'paymentRequest', entityId: payee, field, before: null, after,
    })),
    { entity: 'paymentRequest', entityId: payee, field: 'status', before: null, after: 'Pending' },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['finance', 'approvals', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `payment_requests.create:${payee}:${hash}` };
}

export function validatePaymentRequestCreateDraftSemantics(draft: any): { ok: boolean; error?: PaymentRequestsFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildPaymentRequestsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.supplierId && !after?.supplierName) return { ok: false, error: buildPaymentRequestsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain supplierId or supplierName') };
  if (after?.totalAmount === undefined || after?.totalAmount === null || after?.totalAmount === '') {
    return { ok: false, error: buildPaymentRequestsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain totalAmount') };
  }
  if (!after?.currency || !String(after.currency).trim()) return { ok: false, error: buildPaymentRequestsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain currency') };
  if (after?.paymentCategory !== undefined && !(PAYMENT_CATEGORIES_LOCAL as readonly string[]).includes(String(after.paymentCategory))) {
    return { ok: false, error: buildPaymentRequestsFlowError('SEMANTIC_VALIDATION_FAILED', `draft must contain valid paymentCategory (${PAYMENT_CATEGORIES_LOCAL.join('/')})`) };
  }
  if (!after?.applicantId || !String(after.applicantId).trim()) return { ok: false, error: buildPaymentRequestsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain applicantId') };
  return { ok: true };
}

export function verifyPaymentRequestCreateDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitPaymentRequestCreate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any }): Promise<{ ok: true; feedback: PaymentRequestsFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: PaymentRequestsFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildPaymentRequestsFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildPaymentRequestsFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validatePaymentRequestCreateDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const svc = await makePaymentRequestService(prisma);
  const result = await svc.createPaymentRequest({
    supplierId: after.supplierId,
    supplierName: after.supplierName,
    totalAmount: after.totalAmount,
    currency: after.currency,
    paymentCategory: after.paymentCategory,
    requestDate: after.requestDate,
    expectedPaymentDate: after.expectedPaymentDate,
    sourceType: after.sourceType,
    sourceId: after.sourceId,
    remark: after.remark,
    attachments: after.attachments,
    applicantId: after.applicantId,
  });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildPaymentRequestsFlowError((result as any).error!.code, (result as any).error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', paymentRequestId: result.data!.paymentRequest.id, requestNumber: result.data!.paymentRequest.requestNumber, domainApprovalId: result.data!.approvalRequestId, idempotencyKey: draft.idempotencyKey } };
}

// ─── CANCEL ────────────────────────────────────────────────────────
export function buildPaymentRequestCancelDraft(input: { paymentRequestId: string; actorId: string; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { paymentRequestId, actorId, currentSnapshot = {} } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'payment_requests.cancel',
    entityId: paymentRequestId,
    action: 'cancel_payment_request',
    before: currentSnapshot,
    after: { paymentRequestId, actorId },
  }];
  const beforeAfterDiff = [{
    entity: 'paymentRequest', entityId: paymentRequestId, field: 'status',
    before: (currentSnapshot as any).status ?? null, after: 'Cancelled',
  }];
  const content = { subOperations, beforeAfterDiff, impactScope: ['finance', 'approvals', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `payment_requests.cancel:${paymentRequestId}:${hash}` };
}

export function validatePaymentRequestCancelDraftSemantics(draft: any): { ok: boolean; error?: PaymentRequestsFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildPaymentRequestsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.paymentRequestId) return { ok: false, error: buildPaymentRequestsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain paymentRequestId') };
  if (!after?.actorId || !String(after.actorId).trim()) return { ok: false, error: buildPaymentRequestsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain actorId') };
  return { ok: true };
}

export function verifyPaymentRequestCancelDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitPaymentRequestCancel(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any }): Promise<{ ok: true; feedback: PaymentRequestsFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: PaymentRequestsFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildPaymentRequestsFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildPaymentRequestsFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validatePaymentRequestCancelDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const svc = await makePaymentRequestService(prisma);
  const result = await svc.cancelPaymentRequest({ paymentRequestId: after.paymentRequestId, actorId: after.actorId });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildPaymentRequestsFlowError((result as any).error!.code, (result as any).error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', paymentRequestId: result.data!.paymentRequest.id, requestNumber: result.data!.paymentRequest.requestNumber, idempotencyKey: draft.idempotencyKey } };
}

// ─── 自注册（主控在 toolRuntime 复合 commit 注册区调用一次）─────────
export function registerPaymentRequestsFlowTools(): void {
  registerCommitTool('payment_requests.create', async (ctx) => {
    const result = await commitPaymentRequestCreate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
  registerCommitTool('payment_requests.cancel', async (ctx) => {
    const result = await commitPaymentRequestCancel({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
}
