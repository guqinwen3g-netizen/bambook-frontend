/**
 * Agent-P1-development-convert-to-order-flow-contract
 *
 * development.convert_to_order draft→approval→commit 流程契约。
 * 复用 convertDevCaseToOrder service（route + Agent flow 共用契约），不在 Agent path 手写 DB mutation。
 * ProcessDraft what-you-approve-is-what-you-commit，覆盖 link existing order 与 autoCreate order。
 */

import { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { convertDevCaseToOrder, type DevConvertErrorCode } from '../development/convertService';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

export type DevConvertFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | DevConvertErrorCode
  | 'UNKNOWN_ERROR';

export interface DevConvertFlowError {
  approvalRequestId?: string|null;
  blockCode?: string|null;
  code: DevConvertFlowErrorCode;
  message: string;
  userAction: string;
}

export interface DevConvertFlowCommitted {
  status: 'committed';
  moqCheck?: unknown;
  caseId: string;
  orderId: string;
  auditId: string;
  idempotencyKey: string;
}

export type DevConvertFlowFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | DevConvertFlowCommitted
  | { status: 'failed'; error: DevConvertFlowError; approvalId?: string };

export function buildDevConvertError(code: DevConvertFlowErrorCode, message: string): DevConvertFlowError {
  const userActionMap: Record<DevConvertFlowErrorCode, string> = {
    CREDIT_FROZEN_60_DAYS: '请先由财务核对客户冻结或有效信用例外。',
    CREDIT_REVOKED: '请先由财务核对客户吊销状态或有效信用例外。',
    OVERDUE_60_DAYS: '请先核对客户逾期应收或有效信用例外。',
    INVALID_VALID_UNTIL: '请核对信用例外有效期。',
    EXCEPTION_CONSUMER_REQUIRED: '请核对原业务操作与信用例外。',
    EXCEPTION_NOT_FOUND: '请核对原信用例外。',
    EXCEPTION_SCOPE_INVALID: '请核对信用例外的客户和操作范围。',
    EXCEPTION_NOT_FOR_THIS_ENTITY: '请核对信用例外的客户和操作范围。',
    EXCEPTION_ALREADY_CONSUMED: '该信用例外已使用，请申请新的受控例外。',
    EXCEPTION_EXPIRED: '该信用例外已过期，请重新申请。',
    EXCEPTION_NOT_ACTIVE: '请核对信用例外审批与生效状态。',
    EXCEPTION_CONSUME_CONFLICT: '信用例外状态已变化，请核对后重试。',
    CREDIT_BLOCKED: '请先核对客户信用或获批的信用例外。',
    CREDIT_CHECK_FAILED: '信用核验暂不可用，请稍后重试。',
    EXCEPTION_CONSUME_FAILED: '信用例外核销失败，订单未确认，请核对后重试。',
    UNAUTHORIZED: '请登录后重试开发转单。',
    AUTHORIZATION_UNAVAILABLE: '暂时无法核验开发转单权限，请稍后重试。',
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起转换流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: '转换 draft 语义校验失败，请检查 caseId',
    DEV_CASE_NOT_FOUND: '开发单不存在，请检查 caseId',
    ORDER_NOT_FOUND: '订单不存在（link 模式），请检查 orderId',
    INVALID_INPUT: '输入参数无效',
    FORBIDDEN: '请核对当前执行身份与开发写入权限',
    SOURCE_CHANGED: '客户或信用例外来源已变化，请重新核对。',
    DEVELOPMENT_SOURCE_CHANGED: '样品轮次或开发来源已变化，请刷新并重新核对当前成果',
    CASE_CANCELLED: '开发单已取消，不可转换',
    INVALID_STAGE: '开发单尚未到已确认（approved）阶段，不可转大货订单，请先完成阶段流转',
    ASSET_REQUIRED: '面料开发案须先转面料档案（开发管理详情 → 转档），方可转大货订单',
    CONFIRMED_SOURCE_NOT_FOUND: '确认成果（封样/样品/档案）不存在，请检查',
    CONFIRMED_SOURCE_NOT_APPROVED: '确认成果尚未确认/封样，不可下单',
    MILL_MISMATCH: '所选工厂与确认成果归属工厂不一致',
    DEVELOPMENT_PAUSED: '开发已暂停，请先恢复后转单',
    DEVELOPMENT_CLOSED: '开发已终止结案，不能转单',
    INVALID_LIFECYCLE_STATE: '开发管理状态异常，请先核实',
    CONVERT_FAILED: '转换事务失败已回滚，请重试',
    DEVELOPMENT_NOT_READY: '请先完成样品认可及转档，再确认开发或转换订单',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  return { code, message, userAction: userActionMap[code] };
}

export interface DevConvertDraftInput {
  caseId: string;
  mode: 'link' | 'autoCreate';
  // link 模式
  orderId?: string;
  orderPo?: string;
  // autoCreate 模式（quantity/dueDate 必填：防 0 数量/无交期空心订单）
  customer?: string;
  millName?: string;
  dueDate?: string;
  productName?: string;
  quantity?: number;
  quoteAmount?: number;
}

export function buildDevConvertDraft(input: DevConvertDraftInput): ProcessDraft {
  const { caseId, mode, orderId, orderPo, customer, millName, dueDate, productName, quantity, quoteAmount } = input;
  const afterPayload: Record<string, any> = { caseId, mode };
  if (mode === 'link') {
    afterPayload.orderId = orderId || '';
    afterPayload.orderPo = orderPo || '';
  } else {
    if (customer !== undefined) afterPayload.customer = customer;
    if (millName !== undefined) afterPayload.millName = millName;
    if (dueDate !== undefined) afterPayload.dueDate = dueDate;
    if (productName !== undefined) afterPayload.productName = productName;
    if (quantity !== undefined) afterPayload.quantity = quantity;
    if (quoteAmount !== undefined) afterPayload.quoteAmount = quoteAmount;
  }

  const subOperations: SubOperation[] = [{
    toolId: 'development.convert_to_order',
    entityId: caseId,
    action: mode === 'link' ? 'link_existing_order' : 'auto_create_order',
    before: {},
    after: afterPayload,
  }];

  const beforeAfterDiff = [{
    entity: 'developmentCase',
    entityId: caseId,
    field: 'stage',
    before: 'developing' as any,
    after: 'approved' as any,
  }];

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['development', 'orders'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `dev.convert_to_order:${caseId}:${mode}:${hash}`;

  return { ...content, idempotencyKey };
}

export function validateDevConvertDraftSemantics(draft: any): { ok: boolean; error?: DevConvertFlowError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildDevConvertError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;

  if (!after?.caseId) {
    return { ok: false, error: buildDevConvertError('SEMANTIC_VALIDATION_FAILED', 'draft must contain caseId in subOperations.after') };
  }
  if (after?.mode !== 'link' && after?.mode !== 'autoCreate') {
    return { ok: false, error: buildDevConvertError('SEMANTIC_VALIDATION_FAILED', 'draft mode must be link or autoCreate') };
  }
  if (after.mode === 'link' && !after.orderId) {
    return { ok: false, error: buildDevConvertError('INVALID_INPUT', 'link mode requires orderId') };
  }
  return { ok: true };
}

export function verifyDevConvertDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:')
    ? 'pd:' + idempotencyKey.split(':pd:')[1]
    : idempotencyKey;
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

export interface DevConvertCommitParams {
  /** ★ B58：审批请求人，由 `toolDispatchRegistry` 注入；缺省落 'system'（AuditLog.actorId 有外键） */
  actorId?: string;
  trustedActor?: TokenPayload;
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: any;
}

export async function commitDevConvert(
  params: DevConvertCommitParams,
): Promise<{ ok: true; feedback: DevConvertFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: DevConvertFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;

  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildDevConvertError('PROCESS_DRAFT_MISSING', 'processDraft not found in approval payload'), approvalId } };
  }

  const hashCheck = verifyDevConvertDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildDevConvertError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }

  const semCheck = validateDevConvertDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }

  const after = draft.subOperations[0].after as any;

  if (!params.trustedActor?.userId) {
    return { ok: false, feedback: { status: 'failed', error: buildDevConvertError('FORBIDDEN', '请使用当前执行身份转单'), approvalId } };
  }

  // 复用 convertDevCaseToOrder service（不绕 route，不手写 DB mutation）
  const result = await convertDevCaseToOrder({
    prisma,
    caseId: after.caseId,
    mode: after.mode,
    orderId: after.orderId,
    orderPo: after.orderPo,
    customer: after.customer,
    millName: after.millName,
    dueDate: after.dueDate,
    productName: after.productName,
    quantity: after.quantity,
    quoteAmount: after.quoteAmount,
    actorId: params.trustedActor?.userId,
    trustedActor: params.trustedActor,
  });

  if (!result.ok) {
    return { ok: false, feedback: { status: 'failed', error: {...buildDevConvertError(result.error!.code as DevConvertFlowErrorCode, result.error!.message),...(result.error?.approvalRequestId?{approvalRequestId:result.error.approvalRequestId}:{}),...(result.error?.blockCode?{blockCode:result.error.blockCode}:{})}, approvalId } };
  }

  return {
    ok: true,
    feedback: {
      status: 'committed',
      caseId: result.data!.case.id,
      orderId: result.data!.case.linkedOrderId,
      auditId: result.data!.auditId,
      idempotencyKey: draft.idempotencyKey,
      moqCheck: result.data!.moqCheck ?? null,
    },
  };
}
