/**
 * Agent-P4-customs-flow-contract
 * customs.register_lc / customs.update_declaration draft→approval→commit 流程契约。
 *
 * commit 复用 customsService（createLetterOfCredit / updateDeclaration），与 HTTP route 同一真源，
 * LC 首节点事件（lcEvent Issued）/ EntityLink 同步 / 审计日志均由 service 完成，Agent path 不手写 DB mutation。
 * 域 service 在 commit 内 await import 惰性加载（避免与既有测试的模块级 total-mock 产生导入链耦合）。
 */

import type { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import { computeProcessDraftHash, type ProcessDraft, type SubOperation } from './toolRegistry';
import { registerCommitTool } from './toolDispatchRegistry';

export type CustomsFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'INVALID_INPUT'
  | 'INVALID_LC_TYPE'
  | 'INVALID_CUSTOMS_TYPE'
  | 'EXTERNAL_DECLARATION_REQUIRED'
  | 'NOT_FOUND'
  | 'DUPLICATE_LC_NUMBER'
  | 'NOT_EDITABLE'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED';

export interface CustomsFlowError {
  code: CustomsFlowErrorCode;
  message: string;
  userAction: string;
}

export interface CustomsFlowCommitted {
  status: 'committed';
  entityId: string;
  documentNumber: string;
  idempotencyKey: string;
}

export function buildCustomsFlowError(code: CustomsFlowErrorCode, message: string): CustomsFlowError {
  const userActionMap: Record<CustomsFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查信用证/报关单输入（类型/金额/关键日期）',
    INVALID_INPUT: '输入包含不可写字段，请移除后重新发起',
    INVALID_LC_TYPE: '信用证类型非法，请使用 Irrevocable/Revocable/Standby/Transferable',
    INVALID_CUSTOMS_TYPE: '报关类型非法，请使用 Export/Import',
    EXTERNAL_DECLARATION_REQUIRED: '实际申报在系统外办理；请在出口运单详情登记外部申报完成信息，不能在此编辑历史记录。',
    NOT_FOUND: '目标报关单不存在或已删除',
    DUPLICATE_LC_NUMBER: '信用证号已存在，请更换证号或留空由系统自动生成',
    NOT_EDITABLE: '单据当前状态不可编辑（信用证仅 Issued、报关单仅 Draft 可编辑），请确认状态',
    CREATE_FAILED: '创建事务失败已回滚，请重试',
    UPDATE_FAILED: '更新事务失败已回滚，请重试',
  };
  return { code, message, userAction: userActionMap[code] };
}

/** 域 service 抛错（throw-based 契约，与 route 同口径）→ Flow 错误码 */
function mapCustomsError(e: any, fallback: 'CREATE_FAILED' | 'UPDATE_FAILED'): CustomsFlowError {
  const msg: string = e?.message || '';
  if (e?.code === 'P2002') return buildCustomsFlowError('DUPLICATE_LC_NUMBER', msg || 'unique constraint violated');
  if (msg.includes('非法信用证类型')) return buildCustomsFlowError('INVALID_LC_TYPE', msg);
  if (msg.includes('非法报关类型')) return buildCustomsFlowError('INVALID_CUSTOMS_TYPE', msg);
  if (msg.includes('已存在')) return buildCustomsFlowError('DUPLICATE_LC_NUMBER', msg);
  if (msg.includes('不可编辑')) return buildCustomsFlowError('NOT_EDITABLE', msg);
  if (msg.includes('不存在')) return buildCustomsFlowError('NOT_FOUND', msg);
  return buildCustomsFlowError(fallback, msg || 'operation failed');
}

function verifyHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const expected = computeProcessDraftHash(content);
  const actual = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: expected === actual, expected, actual };
}

// ─── customs.register_lc ───────────────────────────────────────────
export function buildCustomsRegisterLcDraft(input: { input: Record<string, unknown> }): ProcessDraft {
  const body = input.input || {};
  const lcNumber = String((body as any).lcNumber || '');
  const subOperations: SubOperation[] = [{
    toolId: 'customs.register_lc',
    entityId: lcNumber || 'new',
    action: 'create_letter_of_credit',
    before: {},
    after: { ...body },
  }];
  const beforeAfterDiff = Object.entries(body).map(([field, after]) => ({
    entity: 'letterOfCredit', entityId: lcNumber || 'new', field, before: null, after,
  }));
  const content = { subOperations, beforeAfterDiff, impactScope: ['customs', 'entity-links', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `customs.register_lc:${lcNumber || 'new'}:${hash}` };
}

export function validateCustomsRegisterLcDraftSemantics(draft: any): { ok: boolean; error?: CustomsFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildCustomsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.type) return { ok: false, error: buildCustomsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain type') };
  if (typeof after?.amount !== 'number' || !Number.isFinite(after.amount) || after.amount <= 0) {
    return { ok: false, error: buildCustomsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain finite amount > 0') };
  }
  return { ok: true };
}

export function verifyCustomsRegisterLcDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitCustomsRegisterLc(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string }): Promise<{ ok: true; feedback: CustomsFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: CustomsFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildCustomsFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildCustomsFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateCustomsRegisterLcDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const body = draft.subOperations[0].after as Record<string, unknown>;
  const { createCustomsService, LETTER_OF_CREDIT_CREATE_FIELDS } = await import('../customs/customsService');
  const illegalFields = Object.keys(body).filter((k) => !(LETTER_OF_CREDIT_CREATE_FIELDS as readonly string[]).includes(k));
  if (illegalFields.length > 0) {
    return { ok: false, feedback: { status: 'failed', error: buildCustomsFlowError('INVALID_INPUT', `input contains non-writable fields: ${illegalFields.join(', ')}`), approvalId } };
  }
  try {
    const svc = createCustomsService(prisma);
    const lc = await svc.createLetterOfCredit(body as any, auditActorFrom(params));
    return { ok: true, feedback: { status: 'committed', entityId: lc.id, documentNumber: lc.lcNumber, idempotencyKey: draft.idempotencyKey } };
  } catch (e: any) {
    return { ok: false, feedback: { status: 'failed', error: mapCustomsError(e, 'CREATE_FAILED'), approvalId } };
  }
}

// ─── customs.update_declaration ────────────────────────────────────
export function buildCustomsUpdateDeclarationDraft(input: { declarationId: string; patch: Record<string, unknown>; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { declarationId, patch, currentSnapshot = {} } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'customs.update_declaration',
    entityId: declarationId,
    action: 'update_customs_declaration',
    before: currentSnapshot,
    after: { declarationId, patch },
  }];
  const beforeAfterDiff = Object.keys(patch).map((field) => ({
    entity: 'customsDeclaration', entityId: declarationId, field, before: (currentSnapshot as any)[field] ?? null, after: (patch as any)[field],
  }));
  const content = { subOperations, beforeAfterDiff, impactScope: ['customs', 'entity-links', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `customs.update_declaration:${declarationId}:${hash}` };
}

export function validateCustomsUpdateDeclarationDraftSemantics(draft: any): { ok: boolean; error?: CustomsFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildCustomsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.declarationId) return { ok: false, error: buildCustomsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain declarationId') };
  if (!after?.patch || typeof after.patch !== 'object' || Object.keys(after.patch).length === 0) {
    return { ok: false, error: buildCustomsFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain non-empty patch') };
  }
  return { ok: false, error: buildCustomsFlowError('EXTERNAL_DECLARATION_REQUIRED', '实际申报在系统外办理；请在出口运单详情登记外部申报完成信息。') };
}

export function verifyCustomsUpdateDeclarationDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitCustomsUpdateDeclaration(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string }): Promise<{ ok: true; feedback: CustomsFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: CustomsFlowError; approvalId?: string } }> {
  const draft: any = params.approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildCustomsFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId: params.approvalId } };
  return { ok: false, feedback: { status: 'failed', error: buildCustomsFlowError('EXTERNAL_DECLARATION_REQUIRED', '实际申报在系统外办理；请在出口运单详情登记外部申报完成信息。'), approvalId: params.approvalId } };
}

// ─── 自注册入口（toolRuntime 一次性接线；与 registerNewDomainQueryTools 同模式）──
export function registerCustomsFlowTools(): void {
  registerCommitTool('customs.register_lc', async (ctx) => {
    const result = await commitCustomsRegisterLc({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
    const r = result as any;
    return r.ok ? { ok: true, ...r.feedback } : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
  registerCommitTool('customs.update_declaration', async (ctx) => {
    const result = await commitCustomsUpdateDeclaration({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
    const r = result as any;
    return r.ok ? { ok: true, ...r.feedback } : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
}
