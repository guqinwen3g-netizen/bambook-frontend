/**
 * Agent-P4-quotation-flow-contract
 * quotation.create / quotation.update draft→approval→commit 流程契约。
 *
 * commit 复用 quotationService（createQuotation / updateQuotation），与 HTTP route 同一真源，
 * MOQ writeOnce 快照、双轨偏差审批、EntityLink 同步均由 service 完成，Agent path 不手写 DB mutation。
 * 域 service 在 commit 内 await import 惰性加载（避免与既有测试的模块级 total-mock 产生导入链耦合）。
 */

import type { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import { computeProcessDraftHash, type ProcessDraft, type SubOperation } from './toolRegistry';
import { registerCommitTool } from './toolDispatchRegistry';

export type QuotationFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'DUPLICATE_QUOTATION_NUMBER'
  | 'NOT_EDITABLE'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED';

export interface QuotationFlowError {
  code: QuotationFlowErrorCode;
  message: string;
  userAction: string;
}

export interface QuotationFlowCommitted {
  status: 'committed';
  quotationId: string;
  quotationNumber: string;
  idempotencyKey: string;
}

export function buildQuotationFlowError(code: QuotationFlowErrorCode, message: string): QuotationFlowError {
  const userActionMap: Record<QuotationFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查报价单输入（币种/报价日期/行明细）',
    INVALID_INPUT: '输入包含不可写字段（双轨快照与 MOQ 快照为 writeOnce，不可 patch），请移除后重新发起',
    NOT_FOUND: '目标报价单不存在或已删除',
    DUPLICATE_QUOTATION_NUMBER: '报价号已存在，请更换报价号或留空由系统自动生成',
    NOT_EDITABLE: '报价单仅 Draft 状态可编辑，请确认当前状态',
    CREATE_FAILED: '创建事务失败已回滚，请重试',
    UPDATE_FAILED: '更新事务失败已回滚，请重试',
  };
  return { code, message, userAction: userActionMap[code] };
}

/** 域 service 抛错（throw-based 契约，与 route 同口径）→ Flow 错误码 */
function mapQuotationError(e: any, fallback: 'CREATE_FAILED' | 'UPDATE_FAILED'): QuotationFlowError {
  const msg: string = e?.message || '';
  if (e?.code === 'P2002') return buildQuotationFlowError('DUPLICATE_QUOTATION_NUMBER', msg || 'quotationNumber unique constraint violated');
  if (msg.includes('不存在')) return buildQuotationFlowError('NOT_FOUND', msg);
  if (msg.includes('已存在')) return buildQuotationFlowError('DUPLICATE_QUOTATION_NUMBER', msg);
  if (msg.includes('仅 Draft')) return buildQuotationFlowError('NOT_EDITABLE', msg);
  return buildQuotationFlowError(fallback, msg || 'operation failed');
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

function validateLines(lines: unknown): { ok: boolean; error?: QuotationFlowError } {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { ok: false, error: buildQuotationFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain non-empty lines') };
  }
  for (const [i, line] of lines.entries()) {
    if (!line?.description || !line?.unit || !isFiniteNumber(line?.quantity) || !isFiniteNumber(line?.unitPrice)) {
      return { ok: false, error: buildQuotationFlowError('SEMANTIC_VALIDATION_FAILED', `line[${i}] must contain description/unit and finite quantity/unitPrice`) };
    }
  }
  return { ok: true };
}

// ─── quotation.create ──────────────────────────────────────────────
export function buildQuotationCreateDraft(input: { input: Record<string, unknown> }): ProcessDraft {
  const body = input.input || {};
  const quotationNumber = String((body as any).quotationNumber || '');
  const subOperations: SubOperation[] = [{
    toolId: 'quotation.create',
    entityId: quotationNumber || 'new',
    action: 'create_quotation',
    before: {},
    after: { ...body },
  }];
  const beforeAfterDiff = Object.entries(body).map(([field, after]) => ({
    entity: 'quotation', entityId: quotationNumber || 'new', field, before: null, after,
  }));
  const content = { subOperations, beforeAfterDiff, impactScope: ['quotations', 'entity-links', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `quotation.create:${quotationNumber || 'new'}:${hash}` };
}

export function validateQuotationCreateDraftSemantics(draft: any): { ok: boolean; error?: QuotationFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildQuotationFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  for (const field of ['currency', 'issueDate']) {
    if (after?.[field] === undefined || after?.[field] === null || after?.[field] === '') {
      return { ok: false, error: buildQuotationFlowError('SEMANTIC_VALIDATION_FAILED', `draft must contain ${field}`) };
    }
  }
  return validateLines(after?.lines);
}

export function verifyQuotationCreateDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitQuotationCreate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string }): Promise<{ ok: true; feedback: QuotationFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: QuotationFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildQuotationFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildQuotationFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateQuotationCreateDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const body = draft.subOperations[0].after as Record<string, unknown>;
  const { createQuotationService, QUOTATION_CREATE_FIELDS } = await import('../quotations/quotationService');
  const illegalFields = Object.keys(body).filter((k) => !(QUOTATION_CREATE_FIELDS as readonly string[]).includes(k));
  if (illegalFields.length > 0) {
    return { ok: false, feedback: { status: 'failed', error: buildQuotationFlowError('INVALID_INPUT', `input contains non-writable fields: ${illegalFields.join(', ')}`), approvalId } };
  }
  try {
    const svc = createQuotationService(prisma);
    const quotation = await svc.createQuotation(body as any, auditActorFrom(params));
    return { ok: true, feedback: { status: 'committed', quotationId: quotation.id, quotationNumber: quotation.quotationNumber, idempotencyKey: draft.idempotencyKey } };
  } catch (e: any) {
    return { ok: false, feedback: { status: 'failed', error: mapQuotationError(e, 'CREATE_FAILED'), approvalId } };
  }
}

// ─── quotation.update ──────────────────────────────────────────────
export function buildQuotationUpdateDraft(input: { quotationId: string; patch: Record<string, unknown>; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { quotationId, patch, currentSnapshot = {} } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'quotation.update',
    entityId: quotationId,
    action: 'update_quotation',
    before: currentSnapshot,
    after: { quotationId, patch },
  }];
  const beforeAfterDiff = Object.keys(patch).map((field) => ({
    entity: 'quotation', entityId: quotationId, field, before: (currentSnapshot as any)[field] ?? null, after: (patch as any)[field],
  }));
  const content = { subOperations, beforeAfterDiff, impactScope: ['quotations', 'entity-links', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `quotation.update:${quotationId}:${hash}` };
}

export function validateQuotationUpdateDraftSemantics(draft: any): { ok: boolean; error?: QuotationFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildQuotationFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.quotationId) return { ok: false, error: buildQuotationFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain quotationId') };
  if (!after?.patch || typeof after.patch !== 'object' || Object.keys(after.patch).length === 0) {
    return { ok: false, error: buildQuotationFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain non-empty patch') };
  }
  if (after.patch.lines !== undefined) {
    const lineCheck = validateLines(after.patch.lines);
    if (!lineCheck.ok) return lineCheck;
  }
  return { ok: true };
}

export function verifyQuotationUpdateDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitQuotationUpdate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string }): Promise<{ ok: true; feedback: QuotationFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: QuotationFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildQuotationFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildQuotationFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateQuotationUpdateDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const { createQuotationService, QUOTATION_UPDATE_PATCH_FIELDS } = await import('../quotations/quotationService');
  const illegalFields = Object.keys(after.patch).filter((k) => !(QUOTATION_UPDATE_PATCH_FIELDS as readonly string[]).includes(k));
  if (illegalFields.length > 0) {
    return { ok: false, feedback: { status: 'failed', error: buildQuotationFlowError('INVALID_INPUT', `patch contains non-writable fields: ${illegalFields.join(', ')}`), approvalId } };
  }
  try {
    const svc = createQuotationService(prisma);
    const quotation = await svc.updateQuotation(after.quotationId, after.patch, auditActorFrom(params));
    return { ok: true, feedback: { status: 'committed', quotationId: quotation.id, quotationNumber: quotation.quotationNumber, idempotencyKey: draft.idempotencyKey } };
  } catch (e: any) {
    return { ok: false, feedback: { status: 'failed', error: mapQuotationError(e, 'UPDATE_FAILED'), approvalId } };
  }
}

// ─── 自注册入口（toolRuntime 一次性接线；与 registerNewDomainQueryTools 同模式）──
export function registerQuotationFlowTools(): void {
  registerCommitTool('quotation.create', async (ctx) => {
    const result = await commitQuotationCreate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
    const r = result as any;
    return r.ok ? { ok: true, ...r.feedback } : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
  registerCommitTool('quotation.update', async (ctx) => {
    const result = await commitQuotationUpdate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
    const r = result as any;
    return r.ok ? { ok: true, ...r.feedback } : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
}
