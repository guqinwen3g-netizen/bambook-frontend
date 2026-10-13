import { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { currentProformaActor, ProformaAccessError } from '../finance/proformaInvoiceAccess';
import { createInvoice, updateInvoice, type InvoiceMutationErrorCode } from '../finance/invoiceMutationService';
import { computeProcessDraftHash } from './processDraftHash';
import type { ProcessDraft, SubOperation } from './toolRegistry';

export type InvoiceMutationFlowErrorCode = 'APPROVAL_ID_MISSING'|'APPROVAL_NOT_FOUND'|'APPROVAL_MODIFIED_UNSUPPORTED'|'PROCESS_DRAFT_MISSING'|'PROCESS_DRAFT_HASH_MISMATCH'|'SEMANTIC_VALIDATION_FAILED'|InvoiceMutationErrorCode;
export interface InvoiceMutationFlowError { code: InvoiceMutationFlowErrorCode; message: string; userAction: string; }
export interface InvoiceMutationCommitted { status: 'committed'; invoiceId: string; auditId: string; idempotencyKey: string; }

export function buildInvoiceMutationError(code: InvoiceMutationFlowErrorCode, message: string): InvoiceMutationFlowError {
  const map: Record<InvoiceMutationFlowErrorCode, string> = {
    UNAUTHORIZED: '请使用有效的用户会话重新执行开票操作',
    ACCOUNT_DISABLED: '当前账号不可用，请重新登录或联系管理员',
    FORBIDDEN: '当前账号没有本次开票权限',
    AUTHORIZATION_UNAVAILABLE: '暂时无法核验当前权限，请稍后用原请求重试',
    ORDER_NOT_FOUND: '来源订单不存在或不在当前可操作范围',
    CONFLICT: '发票或实际来源已变化，请刷新后重新核对',
    REVIEW_STALE: '整案费用依据已变化，请重新核齐后办理发票',
    REVIEW_REQUIRED: '请先完成整案费用核齐，再办理发票',
    COVERAGE_CONFLICT: '请核对收费事项与原费用覆盖范围，再办理发票',
    INVALID_BILLING_SOURCE: '请核对收费事项所属开发案和费用核齐依据',
    HANDOFF_CONFLICT: '请核对原财务接手记录与收费决定，再办理发票',
    SOURCE_CLAIM_CONFLICT: '供应商索赔与贷项关联不一致，请先核对源索赔和发票记录',
    HAS_ALLOCATIONS: '发票存在核销记录，请先撤销核销再作废',
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程', APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批', APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批', PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整', PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起', SEMANTIC_VALIDATION_FAILED: '发票 draft 语义校验失败，请检查输入', INVALID_STATUS: '发票状态非法', INVALID_TRANSITION: '发票状态流转非法', INVALID_CURRENT_STATUS: '发票当前状态非法', INVALID_AMOUNT: '金额/汇率格式非法', INVALID_CURRENCY: '币种必须在白名单内（USD/EUR/CNY/GBP/JPY/HKD/AUD/CAD），请修正后重试', NOT_FOUND: '发票不存在或已删除', STATUS_NOT_MANUAL_SETTABLE: '该状态只能由核销/分配操作设置，不可手动修改', CREATE_FAILED: '发票创建结果暂不可确认，请先核对原发票记录后重试', UPDATE_FAILED: '发票更新结果暂不可确认，请先刷新核对原发票记录后重试', LINE_ALREADY_ALLOCATED: '费用行已被其他发票占用（一费用行最多一张票），请先作废原发票或改用未占用费用行', INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH: '所选订单分属不同客户，一张发票只能开给同一个客户（应收/账龄/授信按客户记账），请拆票或取消勾选其他客户的订单', INVOICE_CUSTOMER_MISMATCH: '发票客户与订单签约客户不一致（会挂错人、应收/账龄/授信全错），请改正客户或改选该客户的订单', AMOUNT_BELOW_ALLOCATED: '新金额低于该发票已核销的合计（会造成超额核销、净额为负），请先撤销核销再改金额', LC_GATE_BLOCKED: '该订单以信用证（L/C）结算，但尚未登记可用信用证或已过有效期：请先登记/核对信用证再开票', LC_EXCEPTION_CHECK_FAILED: '信用证条款未通过且例外状态查不出来：请先排查例外/审批服务，再按 DR-013 处理',
  };
  return { code, message, userAction: map[code] };
}

/** Same current-account/Invoice capability policy as native PI writes.
 * Standalone invoices do not borrow an Order-read requirement here; actual
 * source/order capabilities and L2 remain the canonical producer's boundary.
 * Identity/ceiling come only from an in-process credential, never a draft. */
export async function checkCurrentInvoiceToolActor(prisma: PrismaClient, trustedActor?: TokenPayload | null): Promise<
  { ok: true } | { ok: false; error: InvoiceMutationFlowError }
> {
  if (!trustedActor?.userId) return { ok: false, error: buildInvoiceMutationError('UNAUTHORIZED', '开票操作需要当前有效的用户主体。') };
  try {
    await currentProformaActor(prisma, trustedActor.userId, trustedActor);
    return { ok: true };
  } catch (error) {
    if (error instanceof ProformaAccessError && (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN'))
      return { ok: false, error: buildInvoiceMutationError(error.code, error.message) };
    return { ok: false, error: buildInvoiceMutationError('AUTHORIZATION_UNAVAILABLE', '当前开票权限暂时无法核对，请稍后用原请求重试。') };
  }
}

function verifyHash(draft: ProcessDraft) {
  const { idempotencyKey, ...content } = draft;
  const expected = computeProcessDraftHash(content);
  const actual = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: expected === actual, expected, actual };
}

export function buildInvoiceCreateDraft(input: { input: Record<string, unknown> }): ProcessDraft {
  const body = input.input || {};
  const invoiceNumber = String((body as any).invoiceNumber || '');
  const subOperations: SubOperation[] = [{ toolId: 'invoice.create', entityId: invoiceNumber || 'new', action: 'create_invoice', before: {}, after: { ...body } }];
  const beforeAfterDiff = Object.entries(body).map(([field, after]) => ({ entity: 'invoice', entityId: invoiceNumber || 'new', field, before: null, after }));
  const content = { subOperations, beforeAfterDiff, impactScope: ['finance','entity-links','audit'], irreversible: false, postCommitHooks: [] as any[] };
  return { ...content, idempotencyKey: `invoice.create:${invoiceNumber || 'new'}:${computeProcessDraftHash(content)}` };
}

export function buildInvoiceUpdateDraft(input: { invoiceId: string; patch: Record<string, unknown>; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { invoiceId, patch, currentSnapshot = {} } = input;
  const subOperations: SubOperation[] = [{ toolId: 'invoice.update', entityId: invoiceId, action: 'update_invoice', before: currentSnapshot, after: { invoiceId, patch } }];
  const beforeAfterDiff = Object.keys(patch).map((field) => ({ entity: 'invoice', entityId: invoiceId, field, before: (currentSnapshot as any)[field] ?? null, after: (patch as any)[field] }));
  const content = { subOperations, beforeAfterDiff, impactScope: ['finance','entity-links','audit'], irreversible: false, postCommitHooks: [] as any[] };
  return { ...content, idempotencyKey: `invoice.update:${invoiceId}:${computeProcessDraftHash(content)}` };
}

export function validateInvoiceCreateDraftSemantics(draft: any) {
  const after = draft?.subOperations?.[0]?.after as any;
  for (const f of ['invoiceNumber','type','amount','currency','issueDate']) if (after?.[f] === undefined || after?.[f] === null || after?.[f] === '') return { ok: false, error: buildInvoiceMutationError('SEMANTIC_VALIDATION_FAILED', `draft must contain ${f}`) };
  return { ok: true };
}
export function validateInvoiceUpdateDraftSemantics(draft: any) {
  const after = draft?.subOperations?.[0]?.after as any;
  if (!after?.invoiceId) return { ok: false, error: buildInvoiceMutationError('SEMANTIC_VALIDATION_FAILED', 'draft must contain invoiceId') };
  if (!after.patch || typeof after.patch !== 'object' || Object.keys(after.patch).length === 0) return { ok: false, error: buildInvoiceMutationError('SEMANTIC_VALIDATION_FAILED', 'draft must contain non-empty patch') };
  return { ok: true };
}

export async function commitInvoiceCreate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string; trustedActor?: TokenPayload | null;}): Promise<{ ok: true; feedback: InvoiceMutationCommitted } | { ok: false; feedback: { status: 'failed'; error: InvoiceMutationFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params; const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildInvoiceMutationError('PROCESS_DRAFT_MISSING','processDraft not found'), approvalId } };
  const hash = verifyHash(draft); if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildInvoiceMutationError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateInvoiceCreateDraftSemantics(draft); if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  if (params.actorId !== undefined && params.actorId !== params.trustedActor?.userId)
    return { ok: false, feedback: { status: 'failed', error: buildInvoiceMutationError('UNAUTHORIZED', '开票主体与当前凭据不一致。'), approvalId } };
  const authority = await checkCurrentInvoiceToolActor(prisma, params.trustedActor);
  if (!authority.ok) return { ok: false, feedback: { status: 'failed', error: authority.error, approvalId } };
  const r = await createInvoice({ prisma, input: draft.subOperations[0].after,
    actorId: params.trustedActor!.userId, actor: params.trustedActor });
  if (!r.ok) return { ok: false, feedback: { status: 'failed', error: buildInvoiceMutationError(r.error!.code, r.error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', invoiceId: r.data!.invoice.id, auditId: r.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}

export async function commitInvoiceUpdate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string; trustedActor?: TokenPayload | null;}): Promise<{ ok: true; feedback: InvoiceMutationCommitted } | { ok: false; feedback: { status: 'failed'; error: InvoiceMutationFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params; const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildInvoiceMutationError('PROCESS_DRAFT_MISSING','processDraft not found'), approvalId } };
  const hash = verifyHash(draft); if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildInvoiceMutationError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateInvoiceUpdateDraftSemantics(draft); if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  if (params.actorId !== undefined && params.actorId !== params.trustedActor?.userId)
    return { ok: false, feedback: { status: 'failed', error: buildInvoiceMutationError('UNAUTHORIZED', '开票主体与当前凭据不一致。'), approvalId } };
  const authority = await checkCurrentInvoiceToolActor(prisma, params.trustedActor);
  if (!authority.ok) return { ok: false, feedback: { status: 'failed', error: authority.error, approvalId } };
  const r = await updateInvoice({ prisma, invoiceId: after.invoiceId, input: after.patch,
    actorId: params.trustedActor!.userId, actor: params.trustedActor });
  if (!r.ok) return { ok: false, feedback: { status: 'failed', error: buildInvoiceMutationError(r.error!.code, r.error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', invoiceId: r.data!.invoice.id, auditId: r.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}
