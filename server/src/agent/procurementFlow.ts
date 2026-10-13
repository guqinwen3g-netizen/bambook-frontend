/**
 * Agent-P4-procurement-flow-contract
 * procurement.create / procurement.update_status draft→approval→commit 流程契约。
 *
 * commit 复用 procurementService（createPurchaseOrder / transitionPurchaseOrderStatus），
 * 与 HTTP route 同一真源，不在 Agent path 手写 DB mutation。
 * 域 service 在 commit 内 await import 惰性加载（避免与既有测试的模块级 total-mock 产生导入链耦合）。
 */

import type { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import { computeProcessDraftHash, type ProcessDraft, type SubOperation } from './toolRegistry';
import { registerCommitTool } from './toolDispatchRegistry';

export type ProcurementFlowErrorCode =
  | 'NATIVE_SUPPLIER_COMMAND_REQUIRED'
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'DUPLICATE_PO_NUMBER'
  | 'SUPPLIER_BLACKLISTED'
  | 'NOT_EDITABLE'
  | 'INVALID_STATUS_TRANSITION'
  | 'STATUS_NOT_MANUAL_SETTABLE'
  | 'CREATE_FAILED'
  | 'TRANSITION_FAILED';

export interface ProcurementFlowError {
  code: ProcurementFlowErrorCode;
  message: string;
  userAction: string;
}

export interface ProcurementFlowCommitted {
  status: 'committed';
  purchaseOrderId: string;
  poNumber: string;
  idempotencyKey: string;
}

export function buildProcurementFlowError(code: ProcurementFlowErrorCode, message: string): ProcurementFlowError {
  const userActionMap: Record<ProcurementFlowErrorCode, string> = {
    NATIVE_SUPPLIER_COMMAND_REQUIRED: '请进入采购与加工工作区，以准确来源创建独立合同并走供应商承诺审批；通用工具审批不能代批供应商承诺',
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查采购单输入（币种/下单日期/行明细/目标状态）',
    INVALID_INPUT: '输入包含不可写字段，请移除后重新发起',
    NOT_FOUND: '目标采购单不存在或已删除',
    DUPLICATE_PO_NUMBER: '采购单号已存在，请更换单号或留空由系统自动生成',
    SUPPLIER_BLACKLISTED: '该供应商已被拉黑，禁止新建采购单，请先解除拉黑或更换供应商',
    NOT_EDITABLE: '采购单仅 Draft 状态可编辑/流转起点，请确认当前状态',
    INVALID_STATUS_TRANSITION: '当前状态不允许流转到目标状态，请检查采购单状态机（Draft→Sent→Confirmed→PartiallyReceived/Received→Closed）',
    STATUS_NOT_MANUAL_SETTABLE: '目标状态不可手动设置（PartiallyReceived/Received 由来料检验驱动，Draft 为初始态）',
    CREATE_FAILED: '创建事务失败已回滚，请重试',
    TRANSITION_FAILED: '状态流转事务失败已回滚，请重试',
  };
  return { code, message, userAction: userActionMap[code] };
}

/** 域 service 抛错（throw-based 契约，与 route 同口径）→ Flow 错误码 */
function mapProcurementError(e: any, fallback: 'CREATE_FAILED' | 'TRANSITION_FAILED'): ProcurementFlowError {
  const msg: string = e?.message || '';
  if (e?.code === 'NATIVE_SUPPLIER_COMMAND_REQUIRED') return buildProcurementFlowError('NATIVE_SUPPLIER_COMMAND_REQUIRED', msg);
  if (e?.code === 'P2002') return buildProcurementFlowError('DUPLICATE_PO_NUMBER', msg || 'poNumber unique constraint violated');
  if (msg.includes('不存在')) return buildProcurementFlowError('NOT_FOUND', msg);
  if (msg.includes('已存在')) return buildProcurementFlowError('DUPLICATE_PO_NUMBER', msg);
  if (msg.includes('已被拉黑')) return buildProcurementFlowError('SUPPLIER_BLACKLISTED', msg);
  if (msg.includes('不可手动流转')) return buildProcurementFlowError('STATUS_NOT_MANUAL_SETTABLE', msg);
  if (msg.includes('非法状态转换')) return buildProcurementFlowError('INVALID_STATUS_TRANSITION', msg);
  if (msg.includes('仅 Draft')) return buildProcurementFlowError('NOT_EDITABLE', msg);
  return buildProcurementFlowError(fallback, msg || 'operation failed');
}

function verifyHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const expected = computeProcessDraftHash(content);
  const actual = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: expected === actual, expected, actual };
}

function isFiniteNumber(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

// ─── procurement.create ────────────────────────────────────────────
export function buildProcurementCreateDraft(input: { input: Record<string, unknown> }): ProcessDraft {
  const body = input.input || {};
  const poNumber = String((body as any).poNumber || '');
  const subOperations: SubOperation[] = [{
    toolId: 'procurement.create',
    entityId: poNumber || 'new',
    action: 'create_purchase_order',
    before: {},
    after: { ...body },
  }];
  const beforeAfterDiff = Object.entries(body).map(([field, after]) => ({
    entity: 'purchaseOrder', entityId: poNumber || 'new', field, before: null, after,
  }));
  const content = { subOperations, beforeAfterDiff, impactScope: ['procurement', 'entity-links', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `procurement.create:${poNumber || 'new'}:${hash}` };
}

export function validateProcurementCreateDraftSemantics(draft: any): { ok: boolean; error?: ProcurementFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildProcurementFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  for (const field of ['currency', 'orderDate']) {
    if (after?.[field] === undefined || after?.[field] === null || after?.[field] === '') {
      return { ok: false, error: buildProcurementFlowError('SEMANTIC_VALIDATION_FAILED', `draft must contain ${field}`) };
    }
  }
  if (!Array.isArray(after?.lines) || after.lines.length === 0) {
    return { ok: false, error: buildProcurementFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain non-empty lines') };
  }
  for (const [i, line] of after.lines.entries()) {
    if (!line?.description || !line?.unit || !isFiniteNumber(line?.quantity) || !isFiniteNumber(line?.unitPrice)) {
      return { ok: false, error: buildProcurementFlowError('SEMANTIC_VALIDATION_FAILED', `line[${i}] must contain description/unit and finite quantity/unitPrice`) };
    }
  }
  return { ok: true };
}

export function verifyProcurementCreateDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitProcurementCreate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string }): Promise<{ ok: true; feedback: ProcurementFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: ProcurementFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildProcurementFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildProcurementFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateProcurementCreateDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const body = draft.subOperations[0].after as Record<string, unknown>;
  const { createProcurementService, PURCHASE_ORDER_CREATE_FIELDS } = await import('../procurement/procurementService');
  const illegalFields = Object.keys(body).filter((k) => !(PURCHASE_ORDER_CREATE_FIELDS as readonly string[]).includes(k));
  if (illegalFields.length > 0) {
    return { ok: false, feedback: { status: 'failed', error: buildProcurementFlowError('INVALID_INPUT', `input contains non-writable fields: ${illegalFields.join(', ')}`), approvalId } };
  }
  try {
    const svc = createProcurementService(prisma);
    const po = await svc.createPurchaseOrder(body as any, auditActorFrom(params));
    return { ok: true, feedback: { status: 'committed', purchaseOrderId: po.id, poNumber: po.poNumber, idempotencyKey: draft.idempotencyKey } };
  } catch (e: any) {
    return { ok: false, feedback: { status: 'failed', error: mapProcurementError(e, 'CREATE_FAILED'), approvalId } };
  }
}

// ─── procurement.update_status ─────────────────────────────────────
export function buildProcurementUpdateStatusDraft(input: { purchaseOrderId: string; toStatus: string; currentStatus?: string; reason?: string }): ProcessDraft {
  const { purchaseOrderId, toStatus, currentStatus, reason } = input;
  const afterPayload: Record<string, unknown> = { purchaseOrderId, toStatus };
  if (reason !== undefined) afterPayload.reason = reason;
  const subOperations: SubOperation[] = [{
    toolId: 'procurement.update_status',
    entityId: purchaseOrderId,
    action: 'transition_purchase_order_status',
    before: currentStatus !== undefined ? { status: currentStatus } : {},
    after: afterPayload,
  }];
  const beforeAfterDiff = [{
    entity: 'purchaseOrder', entityId: purchaseOrderId, field: 'status', before: (currentStatus ?? 'unknown') as any, after: toStatus as any,
  }];
  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['procurement', 'entity-links', 'audit'],
    irreversible: toStatus === 'Cancelled' || toStatus === 'Closed',
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `procurement.update_status:${purchaseOrderId}:${toStatus}:${hash}` };
}

export function validateProcurementUpdateStatusDraftSemantics(draft: any): { ok: boolean; error?: ProcurementFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildProcurementFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.purchaseOrderId) return { ok: false, error: buildProcurementFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain purchaseOrderId') };
  if (!after?.toStatus) return { ok: false, error: buildProcurementFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain toStatus') };
  return { ok: true };
}

export function verifyProcurementUpdateStatusDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitProcurementUpdateStatus(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string }): Promise<{ ok: true; feedback: ProcurementFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: ProcurementFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildProcurementFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildProcurementFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateProcurementUpdateStatusDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const { createProcurementService, MANUAL_PURCHASE_ORDER_TRANSITION_TARGETS } = await import('../procurement/procurementService');
  if (!(MANUAL_PURCHASE_ORDER_TRANSITION_TARGETS as readonly string[]).includes(after.toStatus)) {
    return { ok: false, feedback: { status: 'failed', error: buildProcurementFlowError('STATUS_NOT_MANUAL_SETTABLE', `toStatus ${after.toStatus} is not manually settable`), approvalId } };
  }
  try {
    const svc = createProcurementService(prisma);
    const po = await svc.transitionPurchaseOrderStatus(after.purchaseOrderId, after.toStatus, auditActorFrom(params), after.reason);
    return { ok: true, feedback: { status: 'committed', purchaseOrderId: po.id, poNumber: po.poNumber, idempotencyKey: draft.idempotencyKey } };
  } catch (e: any) {
    return { ok: false, feedback: { status: 'failed', error: mapProcurementError(e, 'TRANSITION_FAILED'), approvalId } };
  }
}

// ─── 自注册入口（toolRuntime 一次性接线；与 registerNewDomainQueryTools 同模式）──
export function registerProcurementFlowTools(): void {
  registerCommitTool('procurement.create', async (ctx) => {
    const result = await commitProcurementCreate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
    const r = result as any;
    return r.ok ? { ok: true, ...r.feedback } : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
  registerCommitTool('procurement.update_status', async (ctx) => {
    const result = await commitProcurementUpdateStatus({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
    const r = result as any;
    return r.ok ? { ok: true, ...r.feedback } : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
}
