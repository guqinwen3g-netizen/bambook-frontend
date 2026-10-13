import { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import { updateRelation, deleteRelation, type RelationMutationErrorCode } from '../relations/relationMutationService';
import { computeProcessDraftHash, type ProcessDraft, type SubOperation } from './toolRegistry';

export type RelationMutationFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | RelationMutationErrorCode;

export interface RelationMutationFlowError { code: RelationMutationFlowErrorCode; message: string; userAction: string; }
export interface RelationMutationCommitted { status: 'committed'; relationId: string; auditId: string; idempotencyKey: string; }

export function buildRelationMutationError(code: RelationMutationFlowErrorCode, message: string): RelationMutationFlowError {
  const actions: Record<RelationMutationFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: '关系资料 draft 语义校验失败，请检查输入',
    INVALID_CATEGORY: 'category 必须是 Customer/Supplier/Agent/Partner/Government/Internal/Other 之一',
    VALIDATION_FAILED: '输入校验失败，请补齐必填字段',
    NOT_FOUND: '关系资料不存在或已删除',
    CREATE_FAILED: '创建事务失败已回滚，请重试',
    UPDATE_FAILED: '更新事务失败已回滚，请重试',
    DELETE_FAILED: '删除事务失败已回滚，请重试',
  };
  return { code, message, userAction: actions[code] };
}

function verifyHash(draft: ProcessDraft) {
  const { idempotencyKey, ...content } = draft;
  const expected = computeProcessDraftHash(content);
  const actual = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey;
  return { ok: expected === actual, expected, actual };
}

export function buildRelationUpdateDraft(input: { relationId: string; patch: Record<string, unknown>; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { relationId, patch, currentSnapshot = {} } = input;
  const subOperations: SubOperation[] = [{ toolId: 'relation.update', entityId: relationId, action: 'update_relation', before: currentSnapshot, after: { relationId, patch } }];
  const beforeAfterDiff = Object.keys(patch).map((field) => ({ entity: 'relation', entityId: relationId, field, before: (currentSnapshot as any)[field] ?? null, after: (patch as any)[field] }));
  const content = { subOperations, beforeAfterDiff, impactScope: ['relations', 'entity-links', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `relation.update:${relationId}:${hash}` };
}

export function buildRelationDeleteDraft(input: { relationId: string; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { relationId, currentSnapshot = {} } = input;
  const subOperations: SubOperation[] = [{ toolId: 'relation.delete', entityId: relationId, action: 'delete_relation', before: currentSnapshot, after: { relationId } }];
  const beforeAfterDiff = [{ entity: 'relation', entityId: relationId, field: 'deletedAt', before: null, after: 'soft_delete' }];
  const content = { subOperations, beforeAfterDiff, impactScope: ['relations', 'entity-links', 'audit'], irreversible: true, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `relation.delete:${relationId}:${hash}` };
}

export function validateRelationUpdateDraftSemantics(draft: any): { ok: boolean; error?: RelationMutationFlowError } {
  const after = draft?.subOperations?.[0]?.after as any;
  if (!after?.relationId) return { ok: false, error: buildRelationMutationError('SEMANTIC_VALIDATION_FAILED', 'draft must contain relationId') };
  if (!after.patch || typeof after.patch !== 'object' || Object.keys(after.patch).length === 0) return { ok: false, error: buildRelationMutationError('SEMANTIC_VALIDATION_FAILED', 'draft must contain non-empty patch') };
  return { ok: true };
}

export function validateRelationDeleteDraftSemantics(draft: any): { ok: boolean; error?: RelationMutationFlowError } {
  const after = draft?.subOperations?.[0]?.after as any;
  if (!after?.relationId) return { ok: false, error: buildRelationMutationError('SEMANTIC_VALIDATION_FAILED', 'draft must contain relationId') };
  return { ok: true };
}

export function verifyRelationUpdateDraftHash(draft: ProcessDraft) { return verifyHash(draft); }
export function verifyRelationDeleteDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitRelationUpdate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string;}): Promise<{ ok: true; feedback: RelationMutationCommitted } | { ok: false; feedback: { status: 'failed'; error: RelationMutationFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildRelationMutationError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildRelationMutationError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateRelationUpdateDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const result = await updateRelation({ prisma, relationId: after.relationId, input: after.patch, actorId: auditActorFrom(params) });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildRelationMutationError(result.error!.code, result.error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', relationId: result.data!.relation.id, auditId: result.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}

export async function commitRelationDelete(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string;}): Promise<{ ok: true; feedback: RelationMutationCommitted } | { ok: false; feedback: { status: 'failed'; error: RelationMutationFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildRelationMutationError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildRelationMutationError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateRelationDeleteDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const result = await deleteRelation({ prisma, relationId: after.relationId, actorId: auditActorFrom(params) });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildRelationMutationError(result.error!.code, result.error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', relationId: result.data!.relation.id, auditId: result.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}
