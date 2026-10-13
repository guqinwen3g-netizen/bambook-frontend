/**
 * Agent-Phase2-credit-flow-contract
 * credit.freeze / credit.thaw draft→approval→commit 流程契约。
 *
 * commit 复用 creditService（Track F 信用控制唯一入口，与路由同一真源），
 * service 工厂经 await import 惰性加载（newDomainQueryTools 先例，免疫既有测试模块级 total-mock
 * 的导入链耦合），不在 Agent path 手写 DB mutation。
 * 幂等三层：ProcessDraft hash + AgentCommitReceipt（registerCommitTool 收口）+ service 层状态机守卫
 * （CREDIT_ALREADY_FROZEN / CREDIT_NOT_FROZEN 防重复迁移）。
 *
 * 铁律对齐（creditService 头部注释）：
 *   - 人工冻结/解冻必填理由（审计强制，语义校验层 fail-closed）；
 *   - 自动冻结（system_credit_scan）只能自动解冻，人工冻结必须人工解冻 —— 本 Flow 只覆盖人工路径；
 *   - 冻结即新单门禁（CreditLimit.status='Frozen' 唯一真源），Agent 审批是「用户确认 Agent 动作」门禁。
 */

import { PrismaClient } from '@prisma/client';
import { computeProcessDraftHash, type ProcessDraft, type SubOperation } from './toolRegistry';
import { registerCommitTool } from './toolDispatchRegistry';
import type { CreditErrorCode } from '../credit/creditService';

export type CreditFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | CreditErrorCode;

export interface CreditFlowError {
  code: CreditFlowErrorCode;
  message: string;
  userAction: string;
}

export interface CreditFlowCommitted {
  status: 'committed';
  relationId: string;
  /** 完成状态迁移的 CreditLimit IDs（freeze→frozen / thaw→thawed） */
  transitionedLimitIds: string[];
  idempotencyKey: string;
}

export function buildCreditFlowError(code: CreditFlowErrorCode, message: string): CreditFlowError {
  const userActionMap: Record<CreditFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查信用冻结/解冻输入（relationId/reason/actorId 均必填）',
    RELATION_REQUIRED: '客户 relationId 必填，请确认目标客户档案',
    CREDIT_REASON_REQUIRED: '人工冻结/解冻必须填写理由（审计强制），请补充 reason',
    CREDIT_LIMIT_NOT_FOUND: '客户无 Active 信用额度，无法冻结，请先在信用模块建档',
    CREDIT_ALREADY_FROZEN: '该客户信用额度已冻结，防重复冻结，无需重复操作',
    CREDIT_NOT_FROZEN: '该客户无 Frozen 信用额度，无需解冻',
    INVALID_AMOUNT: '金额必须为合法数值',
    CREDIT_WRITE_FAILED: '冻结/解冻事务失败已回滚，请重试',
  };
  return { code, message, userAction: userActionMap[code] };
}

function verifyHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const expected = computeProcessDraftHash(content);
  const actual = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: expected === actual, expected, actual };
}

/** creditService 工厂（与路由/newDomainQueryTools 同一线路；惰性加载） */
async function makeCreditService(prisma: PrismaClient) {
  const { createCreditService } = await import('../credit/creditService');
  return createCreditService({ prisma });
}

// ─── FREEZE ────────────────────────────────────────────────────────
export function buildCreditFreezeDraft(input: { relationId: string; reason: string; actorId: string; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { relationId, reason, actorId, currentSnapshot = {} } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'credit.freeze',
    entityId: relationId,
    action: 'freeze_credit',
    before: currentSnapshot,
    after: { relationId, reason, actorId },
  }];
  const beforeAfterDiff = [
    { entity: 'creditLimit', entityId: relationId, field: 'status', before: (currentSnapshot as any).status ?? 'Active', after: 'Frozen' },
    { entity: 'creditLimit', entityId: relationId, field: 'frozenBy', before: (currentSnapshot as any).frozenBy ?? null, after: actorId },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['credit', 'orders', 'risk', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `credit.freeze:${relationId}:${hash}` };
}

export function validateCreditFreezeDraftSemantics(draft: any): { ok: boolean; error?: CreditFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildCreditFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.relationId || !String(after.relationId).trim()) return { ok: false, error: buildCreditFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain relationId') };
  if (!after?.reason || !String(after.reason).trim()) return { ok: false, error: buildCreditFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain non-empty reason (人工冻结理由必填)') };
  if (!after?.actorId || !String(after.actorId).trim()) return { ok: false, error: buildCreditFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain actorId') };
  return { ok: true };
}

export function verifyCreditFreezeDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitCreditFreeze(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any }): Promise<{ ok: true; feedback: CreditFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: CreditFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildCreditFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildCreditFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateCreditFreezeDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const svc = await makeCreditService(prisma);
  const result = await svc.freezeCredit({ relationId: after.relationId, reason: after.reason, actorId: after.actorId, triggerId: approvalId });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildCreditFlowError((result as any).error!.code, (result as any).error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', relationId: after.relationId, transitionedLimitIds: result.data!.frozen, idempotencyKey: draft.idempotencyKey } };
}

// ─── THAW ──────────────────────────────────────────────────────────
export function buildCreditThawDraft(input: { relationId: string; reason: string; actorId: string; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { relationId, reason, actorId, currentSnapshot = {} } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'credit.thaw',
    entityId: relationId,
    action: 'thaw_credit',
    before: currentSnapshot,
    after: { relationId, reason, actorId },
  }];
  const beforeAfterDiff = [
    { entity: 'creditLimit', entityId: relationId, field: 'status', before: (currentSnapshot as any).status ?? 'Frozen', after: 'Active' },
    { entity: 'creditLimit', entityId: relationId, field: 'thawedReason', before: (currentSnapshot as any).thawedReason ?? null, after: reason },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['credit', 'orders', 'risk', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `credit.thaw:${relationId}:${hash}` };
}

export function validateCreditThawDraftSemantics(draft: any): { ok: boolean; error?: CreditFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildCreditFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.relationId || !String(after.relationId).trim()) return { ok: false, error: buildCreditFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain relationId') };
  if (!after?.reason || !String(after.reason).trim()) return { ok: false, error: buildCreditFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain non-empty reason (人工解冻理由必填，记录 thawedReason)') };
  if (!after?.actorId || !String(after.actorId).trim()) return { ok: false, error: buildCreditFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain actorId') };
  return { ok: true };
}

export function verifyCreditThawDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitCreditThaw(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any }): Promise<{ ok: true; feedback: CreditFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: CreditFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildCreditFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildCreditFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateCreditThawDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const svc = await makeCreditService(prisma);
  const result = await svc.thawCredit({ relationId: after.relationId, reason: after.reason, actorId: after.actorId, triggerId: approvalId });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildCreditFlowError((result as any).error!.code, (result as any).error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', relationId: after.relationId, transitionedLimitIds: result.data!.thawed, idempotencyKey: draft.idempotencyKey } };
}

// ─── 自注册（主控在 toolRuntime 复合 commit 注册区调用一次）─────────
export function registerCreditFlowTools(): void {
  registerCommitTool('credit.freeze', async (ctx) => {
    const result = await commitCreditFreeze({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
  registerCommitTool('credit.thaw', async (ctx) => {
    const result = await commitCreditThaw({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
}
