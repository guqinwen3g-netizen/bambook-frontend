/**
 * Agent-Phase2-internal-trade-flow-contract
 * internal_trade.create / internal_trade.confirm draft→approval→commit 流程契约。
 *
 * commit 复用 internalTransferService（DR-033 内部供料单唯一入口，与路由同一真源），
 * service 工厂经 await import 惰性加载（newDomainQueryTools 先例，免疫既有测试模块级 total-mock
 * 的导入链耦合），不在 Agent path 手写 DB mutation。
 * 幂等三层：ProcessDraft hash + AgentCommitReceipt（registerCommitTool 收口）+ service 层守卫
 * （TRANSFER_ALREADY_EXISTS 方向唯一 / 状态机非法迁移 fail-closed）。
 *
 * 注意：createInternalTransfer 内部会创建 DR-006 内部结算价业务审批单（createBusinessApproval），
 * confirm 生效门槛①即该审批单必须 approved（SETTLEMENT_PRICE_NOT_APPROVED fail-closed）。
 * Agent 审批是「用户确认 Agent 动作」门禁，两者语义独立、串联生效。
 */

import { PrismaClient } from '@prisma/client';
import { computeProcessDraftHash, type ProcessDraft, type SubOperation } from './toolRegistry';
import { registerCommitTool } from './toolDispatchRegistry';
import type { InternalTransferErrorCode } from '../internalTrade/internalTransferService';
import type { TokenPayload } from '../auth/service';
import { toolActorToken } from './toolActorContext';

export type InternalTradeFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'FORBIDDEN'
  | InternalTransferErrorCode;

export interface InternalTradeFlowError {
  code: InternalTradeFlowErrorCode;
  message: string;
  userAction: string;
}

export interface InternalTradeFlowCommitted {
  status: 'committed';
  transferId: string;
  mirrorId?: string;
  transferStatus?: string;
  /** DR-006 内部结算价业务审批单 ID（由 service 内部创建，非 Agent 审批单） */
  domainApprovalId?: string;
  idempotencyKey: string;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function buildInternalTradeFlowError(code: InternalTradeFlowErrorCode, message: string): InternalTradeFlowError {
  const userActionMap: Record<InternalTradeFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查内部供料单输入（双方部门/订单/物料/数量/结算价/交期均必填）',
    FORBIDDEN: '请核对真实执行账号、凭证权限上限和原审批请求人；草稿不能指定授权主体',
    MISSING_REQUIRED_FIELD: '必填字段缺失（DR-033 核心内容：申请部门/供料部门/双方订单/物料/数量/结算价/交期）',
    GARMENT_ORDER_NOT_FOUND: '服装订单不存在或已删除，请确认 garmentOrderId',
    FABRIC_ORDER_NOT_FOUND: '面料订单不存在或已删除，请确认 fabricOrderId',
    FABRIC_ORDER_NOT_INTERNAL_TRADE: '面料订单未标记 isInternalFabricTrade=true，内部供料必须关联内部面料订单（DR-005）',
    GARMENT_ORDER_INTERNAL_CONFLICT: '服装订单被标记为内部面料交易订单，不得作为采购发起方',
    SAME_ORDER_CONFLICT: '服装订单与面料订单不得为同一订单',
    INVALID_QUANTITY: '数量必须为正有限数',
    INVALID_SETTLEMENT_PRICE: '内部结算价必须为正有限数（须走 DR-006 审批）',
    INVALID_DUE_DATE: '交期格式必须为 YYYY-MM-DD',
    TRANSFER_ALREADY_EXISTS: '该订单方向已存在内部供料单（一单每方向仅 1 条），请勿重复创建',
    TRANSFER_NOT_FOUND: '内部供料单不存在或已删除，请确认 transferId',
    INVALID_TRANSFER_STATE: '当前状态不允许该操作（仅 PendingConfirm 可确认生效）',
    SETTLEMENT_PRICE_NOT_APPROVED: '内部结算价审批未通过，不得生效（DR-006/DR-033），请先完成结算价审批',
    SHIPMENT_NOT_FOUND: '出运记录不存在，请确认 shipmentId',
    SHIPMENT_NOT_OF_FABRIC_ORDER: '出运记录不属于面料订单，请确认 shipmentId 与面料订单匹配',
    INVALID_DELIVERY_QUANTITY: '交付数量必须为正有限数',
    OVER_DELIVERY: '累计交付超过确认数量（超交 fail-closed），请核对交付量',
    NO_REVIEWER_RESOLVED: '无法解析审批人（部门无主管），请联系管理员配置审批路由',
    INTERNAL_ERROR: '内部供料单事务失败已回滚，请重试',
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
async function makeInternalTransferService(prisma: PrismaClient) {
  const { createApprovalRoutingService } = await import('../approvals/approvalRoutingService');
  const { createApprovalCreateService } = await import('../approvals/approvalCreateService');
  const { createInternalTransferService } = await import('../internalTrade/internalTransferService');
  const routingService = createApprovalRoutingService({ prisma });
  const approvalCreateService = createApprovalCreateService({ prisma, routingService });
  return createInternalTransferService({ prisma, approvalCreateService });
}

// ─── CREATE ────────────────────────────────────────────────────────
export function buildInternalTradeCreateDraft(input: { input: Record<string, unknown> }): ProcessDraft {
  const body = input.input || {};
  const entityKey = String((body as any).garmentOrderId || 'new');
  const subOperations: SubOperation[] = [{
    toolId: 'internal_trade.create',
    entityId: entityKey,
    action: 'create_internal_transfer',
    before: {},
    after: { ...body },
  }];
  const beforeAfterDiff = [
    { entity: 'orderInternalTransfer', entityId: entityKey, field: 'garmentOrderId', before: null, after: (body as any).garmentOrderId ?? null },
    { entity: 'orderInternalTransfer', entityId: entityKey, field: 'fabricOrderId', before: null, after: (body as any).fabricOrderId ?? null },
    { entity: 'orderInternalTransfer', entityId: entityKey, field: 'materialCode', before: null, after: (body as any).materialCode ?? null },
    { entity: 'orderInternalTransfer', entityId: entityKey, field: 'quantity', before: null, after: (body as any).quantity ?? null },
    { entity: 'orderInternalTransfer', entityId: entityKey, field: 'settlementPrice', before: null, after: (body as any).settlementPrice ?? null },
    { entity: 'orderInternalTransfer', entityId: entityKey, field: 'dueDate', before: null, after: (body as any).dueDate ?? null },
    { entity: 'orderInternalTransfer', entityId: entityKey, field: 'status', before: null, after: 'PendingConfirm' },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['internalTrade', 'orders', 'finance', 'approvals', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `internal_trade.create:${entityKey}:${hash}` };
}

export function validateInternalTradeCreateDraftSemantics(draft: any): { ok: boolean; error?: InternalTradeFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildInternalTradeFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  const required = ['requestDepartmentId', 'supplyDepartmentId', 'garmentOrderId', 'fabricOrderId', 'materialCode', 'dueDate', 'requesterId'];
  for (const f of required) {
    if (!after?.[f] || !String(after[f]).trim()) return { ok: false, error: buildInternalTradeFlowError('SEMANTIC_VALIDATION_FAILED', `draft must contain ${f}`) };
  }
  const quantity = Number(after?.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, error: buildInternalTradeFlowError('SEMANTIC_VALIDATION_FAILED', 'draft quantity must be positive finite number') };
  const price = Number(after?.settlementPrice);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: buildInternalTradeFlowError('SEMANTIC_VALIDATION_FAILED', 'draft settlementPrice must be positive finite number') };
  if (!YMD_RE.test(String(after.dueDate))) return { ok: false, error: buildInternalTradeFlowError('SEMANTIC_VALIDATION_FAILED', 'draft dueDate must be YYYY-MM-DD') };
  if (String(after.garmentOrderId) === String(after.fabricOrderId)) {
    return { ok: false, error: buildInternalTradeFlowError('SEMANTIC_VALIDATION_FAILED', 'draft garmentOrderId and fabricOrderId must differ') };
  }
  return { ok: true };
}

export function verifyInternalTradeCreateDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitInternalTradeCreate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; originalRequesterId?: string; trustedActor?: TokenPayload }): Promise<{ ok: true; feedback: InternalTradeFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: InternalTradeFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildInternalTradeFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildInternalTradeFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateInternalTradeCreateDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  // The immutable draft stays bound to the real approval requester. Execution
  // uses the verified runtime principal, which may be a permitted delegate;
  // draft/body identity never selects the account whose authority is checked.
  if (!params.trustedActor?.userId || !params.originalRequesterId || after.requesterId !== params.originalRequesterId) {
    return { ok: false, feedback: { status: 'failed', error: buildInternalTradeFlowError('FORBIDDEN', '内部供料草稿身份与原审批请求人或真实执行凭证不一致'), approvalId } };
  }
  const svc = await makeInternalTransferService(prisma);
  const result = await svc.createInternalTransfer({
    requestDepartmentId: after.requestDepartmentId,
    supplyDepartmentId: after.supplyDepartmentId,
    garmentOrderId: after.garmentOrderId,
    fabricOrderId: after.fabricOrderId,
    materialCode: after.materialCode,
    quantity: Number(after.quantity),
    unit: after.unit,
    settlementPrice: Number(after.settlementPrice),
    dueDate: after.dueDate,
    memo: after.memo,
    requesterId: params.trustedActor.userId,
    trustedActor: params.trustedActor,
  });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildInternalTradeFlowError((result as any).error!.code, (result as any).error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', transferId: result.data!.transfer.id, mirrorId: result.data!.mirror?.id, transferStatus: result.data!.payload?.status, domainApprovalId: result.data!.approvalRequestId, idempotencyKey: draft.idempotencyKey } };
}

// ─── CONFIRM ───────────────────────────────────────────────────────
export function buildInternalTradeConfirmDraft(input: { transferId: string; actorId: string; confirmedQuantity?: number; confirmedDueDate?: string; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { transferId, actorId, confirmedQuantity, confirmedDueDate, currentSnapshot = {} } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'internal_trade.confirm',
    entityId: transferId,
    action: 'confirm_internal_transfer',
    before: currentSnapshot,
    after: { transferId, actorId, ...(confirmedQuantity !== undefined ? { confirmedQuantity } : {}), ...(confirmedDueDate !== undefined ? { confirmedDueDate } : {}) },
  }];
  const beforeAfterDiff = [
    { entity: 'orderInternalTransfer', entityId: transferId, field: 'status', before: (currentSnapshot as any).status ?? 'PendingConfirm', after: 'Effective' },
    { entity: 'orderInternalTransfer', entityId: transferId, field: 'confirmedQuantity', before: null, after: confirmedQuantity ?? '<apply-requested>' },
    { entity: 'orderInternalTransfer', entityId: transferId, field: 'confirmedBy', before: null, after: actorId },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['internalTrade', 'orders', 'finance', 'audit'], irreversible: true, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `internal_trade.confirm:${transferId}:${hash}` };
}

export function validateInternalTradeConfirmDraftSemantics(draft: any): { ok: boolean; error?: InternalTradeFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildInternalTradeFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.transferId || !String(after.transferId).trim()) return { ok: false, error: buildInternalTradeFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain transferId') };
  if (!after?.actorId || !String(after.actorId).trim()) return { ok: false, error: buildInternalTradeFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain actorId') };
  if (after?.confirmedQuantity !== undefined) {
    const q = Number(after.confirmedQuantity);
    if (!Number.isFinite(q) || q <= 0) return { ok: false, error: buildInternalTradeFlowError('SEMANTIC_VALIDATION_FAILED', 'draft confirmedQuantity must be positive finite number') };
  }
  if (after?.confirmedDueDate !== undefined && !YMD_RE.test(String(after.confirmedDueDate))) {
    return { ok: false, error: buildInternalTradeFlowError('SEMANTIC_VALIDATION_FAILED', 'draft confirmedDueDate must be YYYY-MM-DD') };
  }
  return { ok: true };
}

export function verifyInternalTradeConfirmDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitInternalTradeConfirm(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; originalRequesterId?: string; trustedActor?: TokenPayload }): Promise<{ ok: true; feedback: InternalTradeFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: InternalTradeFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildInternalTradeFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildInternalTradeFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateInternalTradeConfirmDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  if (!params.trustedActor?.userId || !params.originalRequesterId || after.actorId !== params.originalRequesterId) {
    return { ok: false, feedback: { status: 'failed', error: buildInternalTradeFlowError('FORBIDDEN', '内部供料草稿身份与原审批请求人或真实执行凭证不一致'), approvalId } };
  }
  const svc = await makeInternalTransferService(prisma);
  const result = await svc.confirmInternalTransfer({
    id: after.transferId,
    actorId: params.trustedActor.userId,
    trustedActor: params.trustedActor,
    confirmedQuantity: after.confirmedQuantity !== undefined ? Number(after.confirmedQuantity) : undefined,
    confirmedDueDate: after.confirmedDueDate,
  });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildInternalTradeFlowError((result as any).error!.code, (result as any).error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', transferId: result.data!.transfer.id, transferStatus: result.data!.payload?.status, idempotencyKey: draft.idempotencyKey } };
}

// ─── 自注册（主控在 toolRuntime 复合 commit 注册区调用一次）─────────
export function registerInternalTradeFlowTools(): void {
  registerCommitTool('internal_trade.create', async (ctx) => {
    const result = await commitInternalTradeCreate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, originalRequesterId: ctx.actorId, trustedActor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
  registerCommitTool('internal_trade.confirm', async (ctx) => {
    const result = await commitInternalTradeConfirm({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, originalRequesterId: ctx.actorId, trustedActor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
}
