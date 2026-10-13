/**
 * Agent-Phase2-order-changes-flow-contract
 * order_changes.create / order_changes.withdraw draft→approval→commit 流程契约。
 *
 * commit 复用 orderChangeRequestService（DR-010 订单变更/取消/暂停申请唯一入口，与路由同一真源），
 * service 工厂经 await import 惰性加载（newDomainQueryTools 先例，免疫既有测试模块级 total-mock
 * 的导入链耦合），不在 Agent path 手写 DB mutation。
 * 幂等三层：ProcessDraft hash + AgentCommitReceipt（registerCommitTool 收口）+ service 层状态机守卫。
 *
 * 注意：createChangeRequest 内部会创建 DR-010 业务审批单（createBusinessApproval），
 * Agent 审批是「用户确认 Agent 动作」门禁，两者语义独立、串联生效。
 */

import { PrismaClient } from '@prisma/client';
import { computeProcessDraftHash, type ProcessDraft, type SubOperation } from './toolRegistry';
import { registerCommitTool } from './toolDispatchRegistry';
import type { OrderChangeErrorCode } from '../orderChanges/orderChangeRequestService';
import type { ActorContext } from './types';
import { toolActorToken } from './toolActorContext';

export type OrderChangesFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'NO_REVIEWER_RESOLVED'
  | OrderChangeErrorCode;

export interface OrderChangesFlowError {
  code: OrderChangesFlowErrorCode;
  message: string;
  userAction: string;
}

export interface OrderChangesFlowCommitted {
  status: 'committed';
  changeRequestId: string;
  requestNumber?: string;
  /** DR-010 业务审批单 ID（由 service 内部创建，非 Agent 审批单） */
  domainApprovalId?: string;
  idempotencyKey: string;
}

/** DR-010 变更类型（与 orderChangeRequestService.ORDER_CHANGE_TYPES 同一真源；本地固化避免运行时耦合） */
const ORDER_CHANGE_TYPES_LOCAL = ['price', 'quantity', 'delivery', 'customer', 'product', 'cancel', 'pause'] as const;

export function buildOrderChangesFlowError(code: OrderChangesFlowErrorCode, message: string): OrderChangesFlowError {
  const userActionMap: Record<OrderChangesFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查变更申请输入',
    NO_REVIEWER_RESOLVED: '无法解析审批人（部门无主管），请联系管理员配置审批路由',
    UNAUTHORIZED: '请使用有效的当前账号重新发起订单变更操作',
    FORBIDDEN: '当前账号无权对该订单或变更申请执行此操作',
    AUTHORIZATION_UNAVAILABLE: '当前账号权限或订单范围暂时无法核验，请稍后刷新重试',
    CUSTOMER_CONFIRMATION_REQUIRED: '请先登记与本次最终变更版本一致的客户接受证据',
    ORDER_CHANGE_VERSION_MISMATCH: '订单或审批版本已变化，请刷新并重新核对当前内容',
    REVISION_NOT_ALLOWED: '仅原申请人可按原申请修订，请核对申请归属和状态',
    AMENDMENT_NOT_ALLOWED: '当前审批状态或拟修改字段不支持修改并批准，请按原流程重新申请',
    ORDER_NOT_FOUND: '订单不存在或已删除，请确认 orderId',
    ORDER_NOT_APPROVED: '仅已批准订单（Confirmed/Production/Shipping/Delivered）可发起变更申请',
    ORDER_LIFECYCLE_GUARDED: '订单存在进行中的变更/取消/暂停申请，禁止并发发起，请先处理在途申请',
    MISSING_BEFORE_AFTER: 'beforeSnapshot 与 afterDelta 均必填且非空（DR-010 前后值留痕）',
    INVALID_CHANGE_TYPE: '变更类型非法，请使用 price/quantity/delivery/customer/product/cancel/pause',
    REASON_TOO_SHORT: '变更理由至少 15 字（审计强制），请补充说明',
    IMPACT_TOO_SHORT: '影响说明至少 10 字（DR-010 记录原因与影响），请补充说明',
    PAUSE_FIELDS_REQUIRED: '暂停申请必须记录原因、责任人和预计恢复日期（DR-010）',
    PAUSE_RESUME_DATE_INVALID: '预计恢复日期必须为 YYYY-MM-DD 且不早于今天',
    CHANGE_REQUEST_NOT_FOUND: '变更申请不存在或已删除，请确认 changeRequestId',
    CHANGE_REQUEST_NOT_PENDING: '仅 Pending 状态的变更申请可撤回',
    CHANGE_REQUEST_NOT_APPROVED: '变更申请未批准，无法应用',
    ALREADY_APPLIED: '变更申请已应用，不可重复操作',
    ORDER_SHIPPING_LOCKED: '订单已出运，交期/价格锁死，请先走状态回退 Confirmed 审批链',
    // ★ B3（2026-09-18）：改量后数量低于已出运量 —— 已发的货比订单还多，必须给出可执行的下一步
    ORDER_QTY_BELOW_SHIPPED: '改后数量低于已出运量：请改为不低于已出运量，或先把多出部分走退货/索赔流程',
    WITHDRAW_NOT_BY_REQUESTER: '仅申请人本人可撤回变更申请',
    ORDER_STATUS_CONFLICT: '订单状态冲突或事务失败，请刷新后重试',
    CLOSING_NOT_REQUIRED: '订单未处于结案流程，无需结案处理',
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
async function makeOrderChangeService(prisma: PrismaClient) {
  const { createApprovalRoutingService } = await import('../approvals/approvalRoutingService');
  const { createApprovalCreateService } = await import('../approvals/approvalCreateService');
  const { createOrderChangeRequestService } = await import('../orderChanges/orderChangeRequestService');
  const routingService = createApprovalRoutingService({ prisma });
  const approvalCreateService = createApprovalCreateService({ prisma, routingService });
  return createOrderChangeRequestService({ prisma, approvalCreateService });
}

// ─── CREATE ────────────────────────────────────────────────────────
export function buildOrderChangeCreateDraft(input: { input: Record<string, unknown> }): ProcessDraft {
  const body = input.input || {};
  const orderId = String((body as any).orderId || '');
  const beforeSnapshot = ((body as any).beforeSnapshot && typeof (body as any).beforeSnapshot === 'object'
    ? (body as any).beforeSnapshot : {}) as Record<string, unknown>;
  const afterDelta = ((body as any).afterDelta && typeof (body as any).afterDelta === 'object'
    ? (body as any).afterDelta : {}) as Record<string, unknown>;
  const subOperations: SubOperation[] = [{
    toolId: 'order_changes.create',
    entityId: orderId || 'new',
    action: 'create_order_change_request',
    before: { ...beforeSnapshot },
    after: { ...body },
  }];
  const beforeAfterDiff = [
    ...Object.keys(afterDelta).map((field) => ({
      entity: 'order', entityId: orderId || 'new', field, before: beforeSnapshot[field] ?? null, after: afterDelta[field],
    })),
    { entity: 'orderChangeRequest', entityId: orderId || 'new', field: 'status', before: null, after: 'Pending' },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['orders', 'approvals', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `order_changes.create:${orderId || 'new'}:${hash}` };
}

export function validateOrderChangeCreateDraftSemantics(draft: any): { ok: boolean; error?: OrderChangesFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildOrderChangesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.orderId) return { ok: false, error: buildOrderChangesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain orderId') };
  if (!after?.changeType || !(ORDER_CHANGE_TYPES_LOCAL as readonly string[]).includes(String(after.changeType))) {
    return { ok: false, error: buildOrderChangesFlowError('SEMANTIC_VALIDATION_FAILED', `draft must contain valid changeType (${ORDER_CHANGE_TYPES_LOCAL.join('/')})`) };
  }
  if (!after?.beforeSnapshot || typeof after.beforeSnapshot !== 'object' || Object.keys(after.beforeSnapshot).length === 0) {
    return { ok: false, error: buildOrderChangesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain non-empty beforeSnapshot') };
  }
  if (!after?.afterDelta || typeof after.afterDelta !== 'object' || Object.keys(after.afterDelta).length === 0) {
    return { ok: false, error: buildOrderChangesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain non-empty afterDelta') };
  }
  if (!after?.changeReason || !String(after.changeReason).trim()) return { ok: false, error: buildOrderChangesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain changeReason') };
  if (!after?.impactSummary || !String(after.impactSummary).trim()) return { ok: false, error: buildOrderChangesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain impactSummary') };
  if (!after?.requesterId || !String(after.requesterId).trim()) return { ok: false, error: buildOrderChangesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain requesterId') };
  return { ok: true };
}

export function verifyOrderChangeCreateDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitOrderChangeCreate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actor?: ActorContext }): Promise<{ ok: true; feedback: OrderChangesFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: OrderChangesFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload, actor } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildOrderChangesFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildOrderChangesFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateOrderChangeCreateDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  if (!actor?.userId) return { ok: false, feedback: { status: 'failed', error: buildOrderChangesFlowError('UNAUTHORIZED', '订单变更创建必须使用当前执行账号'), approvalId } };
  const after = draft.subOperations[0].after as any;
  if (after.requesterId !== actor.userId)
    return { ok: false, feedback: { status: 'failed', error: buildOrderChangesFlowError('FORBIDDEN', 'ProcessDraft 申请人必须与当前执行账号一致'), approvalId } };
  const svc = await makeOrderChangeService(prisma);
  const result = await svc.createChangeRequest({
    orderId: after.orderId,
    changeType: after.changeType,
    beforeSnapshot: after.beforeSnapshot,
    afterDelta: after.afterDelta,
    changeReason: after.changeReason,
    impactSummary: after.impactSummary,
    requesterId: actor.userId,
    trustedActor: toolActorToken(actor),
    pauseReason: after.pauseReason,
    pauseOwnerId: after.pauseOwnerId,
    expectedResumeDate: after.expectedResumeDate,
    attachments: after.attachments,
  });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildOrderChangesFlowError((result as any).error!.code, (result as any).error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', changeRequestId: result.data!.changeRequest.id, requestNumber: result.data!.changeRequest.requestNumber, domainApprovalId: result.data!.approvalRequestId, idempotencyKey: draft.idempotencyKey } };
}

// ─── WITHDRAW ──────────────────────────────────────────────────────
export function buildOrderChangeWithdrawDraft(input: { changeRequestId: string; actorId: string; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { changeRequestId, actorId, currentSnapshot = {} } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'order_changes.withdraw',
    entityId: changeRequestId,
    action: 'withdraw_order_change_request',
    before: currentSnapshot,
    after: { changeRequestId, actorId },
  }];
  const beforeAfterDiff = [{
    entity: 'orderChangeRequest', entityId: changeRequestId, field: 'status',
    before: (currentSnapshot as any).status ?? null, after: 'Cancelled',
  }];
  const content = { subOperations, beforeAfterDiff, impactScope: ['orders', 'approvals', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `order_changes.withdraw:${changeRequestId}:${hash}` };
}

export function validateOrderChangeWithdrawDraftSemantics(draft: any): { ok: boolean; error?: OrderChangesFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildOrderChangesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.changeRequestId) return { ok: false, error: buildOrderChangesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain changeRequestId') };
  if (!after?.actorId || !String(after.actorId).trim()) return { ok: false, error: buildOrderChangesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain actorId') };
  return { ok: true };
}

export function verifyOrderChangeWithdrawDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitOrderChangeWithdraw(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actor?: ActorContext }): Promise<{ ok: true; feedback: OrderChangesFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: OrderChangesFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload, actor } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildOrderChangesFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildOrderChangesFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateOrderChangeWithdrawDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  if (!actor?.userId) return { ok: false, feedback: { status: 'failed', error: buildOrderChangesFlowError('UNAUTHORIZED', '订单变更撤回必须使用当前执行账号'), approvalId } };
  const after = draft.subOperations[0].after as any;
  const svc = await makeOrderChangeService(prisma);
  // after.actorId is a signed draft detail only. The actual executor comes
  // from the trusted runtime context and is reauthorized by the domain service.
  const result = await svc.withdrawChangeRequest({ changeRequestId: after.changeRequestId, actorId: actor.userId,
    actorRoles: actor.roles, trustedActor: toolActorToken(actor) });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildOrderChangesFlowError((result as any).error!.code, (result as any).error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', changeRequestId: result.data!.changeRequest.id, requestNumber: result.data!.changeRequest.requestNumber, idempotencyKey: draft.idempotencyKey } };
}

// ─── 自注册（主控在 toolRuntime 复合 commit 注册区调用一次）─────────
export function registerOrderChangesFlowTools(): void {
  registerCommitTool('order_changes.create', async (ctx) => {
    const result = await commitOrderChangeCreate({ prisma: ctx.prisma, approvalId: ctx.approvalId,
      approvalPayload: ctx.approvalPayload, actor: ctx.actor });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
  registerCommitTool('order_changes.withdraw', async (ctx) => {
    const result = await commitOrderChangeWithdraw({ prisma: ctx.prisma, approvalId: ctx.approvalId,
      approvalPayload: ctx.approvalPayload, actor: ctx.actor });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
}
