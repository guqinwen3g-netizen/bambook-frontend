/** Exact original-command receipts and irreversible retirement. The existing
 * WFR AuditLog primary key is the singleton applied-or-retired fact; no list
 * absence, error status or elapsed time proves that an in-flight writer ended. */
import type { WorkflowAcknowledgement } from './workflowTypes';
import type { TokenPayload } from '../auth/service';
import { WorkflowError, workflowEntityType, workflowHash, workflowJson, workflowReject, workflowText, type WorkflowEntityType } from './workflowAccess';

export type WorkflowRequestAction = WorkflowAcknowledgement['action'];
export type WorkflowRecoveryParent = { entityType: WorkflowEntityType; entityId: string; instanceId: string | null };
export type WorkflowOriginalRequestInput = { action: WorkflowRequestAction; originalClientRequestId: string; originalPayload: Record<string, unknown> };
export type WorkflowRetirementInput = WorkflowOriginalRequestInput & { retirementClientRequestId: string; reason: string };
export type WorkflowRetirementAcknowledgement = {
  schemaVersion: 1; action: WorkflowRequestAction; actorId: string; parent: WorkflowRecoveryParent;
  originalClientRequestId: string; originalParameterHash: string; retirementClientRequestId: string;
  reason: string; retirementParameterHash: string; fenceAuditId: string; retiredAt: string;
};
export type WorkflowRecoveryResult = {
  schemaVersion: 1; decisionScope: 'workflow_only'; nativeBusinessApplied: false;
  action: WorkflowRequestAction; originalClientRequestId: string; originalParameterHash: string;
  actorId: string; parent: WorkflowRecoveryParent; state: 'applied' | 'retired' | 'not_applied_at_check';
  acknowledgement?: WorkflowAcknowledgement; retirement?: WorkflowRetirementAcknowledgement;
};
export type WorkflowOriginalRequest = {
  action: WorkflowRequestAction; clientRequestId: string; parameterHash: string; command: any;
  source?: { entityType: WorkflowEntityType; entityId: string }; instanceId?: string;
};
function optionalText(value: unknown, label: string): string {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') workflowReject('INVALID_INPUT', `${label}须为文字`, 400);
  // Normalize independently of the writer's length/state validation: a
  // rejected long note/title can be retired under its real business parent.
  return value.trim();
}
export function normalizeWorkflowOriginal(input: WorkflowOriginalRequestInput): WorkflowOriginalRequest {
  if (!input || !['create', 'approve', 'reject', 'cancel'].includes(input.action)) workflowReject('INVALID_INPUT', '原请求动作无效', 400);
  const clientRequestId = workflowText(input.originalClientRequestId, '原请求标识'), body = input.originalPayload;
  if (!body || typeof body !== 'object' || Array.isArray(body)) workflowReject('INVALID_INPUT', '须提供完整原请求', 400);
  const action = input.action;
  if (action === 'create') {
    const entityType = workflowEntityType(body.entityType), entityId = workflowText(body.entityId, '原来源');
    const command = { definitionId: workflowText(body.definitionId, '原定义'), entityType, entityId, title: optionalText(body.title, '原标题') };
    return { action, clientRequestId, command, parameterHash: workflowHash(command), source: { entityType, entityId } };
  }
  const instanceId = workflowText(body.instanceId, '原流程');
  const step = { instanceId, expectedStepId: body.expectedStepId ?? null, expectedStepIndex: body.expectedStepIndex ?? null, sourceFingerprint: body.sourceFingerprint ?? null };
  const command: Record<string, unknown> = action === 'cancel' ? { ...step, reason: optionalText(body.reason, '原取消说明') }
    : { ...step, decision: action === 'approve' ? 'approved' : 'rejected', note: optionalText(body.note, '原补充说明') };
  if (action === 'approve' || action === 'reject') {
    if (Object.prototype.hasOwnProperty.call(body, 'confirmedReviewedContent')) {
      if (typeof body.confirmedReviewedContent !== 'boolean') workflowReject('INVALID_INPUT', '原审阅确认标记无效', 400);
      command.confirmedReviewedContent = body.confirmedReviewedContent;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'rejectionReason')) command.rejectionReason = optionalText(body.rejectionReason, '原驳回原因');
    if (Object.prototype.hasOwnProperty.call(body, 'requestedChanges')) command.requestedChanges = optionalText(body.requestedChanges, '原修改要求');
  }
  return { action, clientRequestId, instanceId, command: workflowJson(command), parameterHash: workflowHash(command) };
}
export const workflowRequestParentKey = (parent: WorkflowRecoveryParent): string => parent.instanceId ? `instance:${parent.instanceId}` : `${parent.entityType}:${parent.entityId}`;
export const workflowRequestAuditId = (actorId: string, parent: WorkflowRecoveryParent, clientRequestId: string): string => `WFR_${workflowHash({ actorId, parent: workflowRequestParentKey(parent), clientRequestId })}`;
const retirementHash = (value: Pick<WorkflowRetirementAcknowledgement, 'action' | 'actorId' | 'parent' | 'originalClientRequestId' | 'originalParameterHash' | 'retirementClientRequestId' | 'reason'>) => workflowHash({
  action: value.action, actorId: value.actorId, parent: value.parent, originalClientRequestId: value.originalClientRequestId,
  originalParameterHash: value.originalParameterHash, retirementClientRequestId: value.retirementClientRequestId, reason: value.reason,
});
export function validateWorkflowRetirement(row: any, actorId: string, parent: WorkflowRecoveryParent, clientRequestId: string): WorkflowRetirementAcknowledgement {
  const fact = row?.detail, ack = fact?.acknowledgement;
  const fail = (): never => workflowReject('CONFLICT', '原请求封存记录不完整，请保留请求并核对历史');
  if (!row || row.id !== workflowRequestAuditId(actorId, parent, clientRequestId) || row.actorId !== actorId || row.action !== 'workflow_request_retired'
    || row.targetType !== 'WorkflowRequest' || row.targetId !== workflowRequestParentKey(parent) || fact?.schemaVersion !== 1
    || fact.actorId !== actorId || fact.originalClientRequestId !== clientRequestId || workflowHash(fact.parent) !== workflowHash(parent)
    || fact.decisionActorAuthority?.userId !== actorId || fact.decisionActorAuthority?.authorizationLoaded !== true || !Array.isArray(fact.decisionActorAuthority?.roleIds)
    || !['create', 'approve', 'reject', 'cancel'].includes(fact.action) || workflowHash(fact.originalCommand) !== fact.originalParameterHash
    || !ack || ack.schemaVersion !== 1 || ack.action !== fact.action || ack.actorId !== actorId || ack.fenceAuditId !== row.id
    || ack.originalClientRequestId !== clientRequestId || ack.originalParameterHash !== fact.originalParameterHash
    || workflowHash(ack.parent) !== workflowHash(parent) || ack.retirementClientRequestId !== fact.retirementClientRequestId || ack.reason !== fact.reason
    || typeof ack.retirementClientRequestId !== 'string' || !ack.retirementClientRequestId.trim() || typeof ack.reason !== 'string' || !ack.reason.trim()
    || typeof ack.retiredAt !== 'string' || !Number.isFinite(Date.parse(ack.retiredAt)) || workflowJson(row.createdAt) !== ack.retiredAt || ack.retirementParameterHash !== fact.retirementParameterHash
    || retirementHash(ack) !== ack.retirementParameterHash || workflowHash(ack) !== fact.acknowledgementHash) return fail();
  // Canonical command/parent binding is checked independently of the stored
  // digest. A mutated fact must not become an excuse to declare non-application.
  let original: WorkflowOriginalRequest;
  try { original = normalizeWorkflowOriginal({ action: fact.action, originalClientRequestId: clientRequestId, originalPayload: fact.originalCommand }); }
  catch (error) { if (error instanceof WorkflowError) return fail(); throw error; }
  if (original.parameterHash !== fact.originalParameterHash || (original.action === 'create'
    ? parent.instanceId !== null || original.source!.entityType !== parent.entityType || original.source!.entityId !== parent.entityId
    : original.instanceId !== parent.instanceId)) return fail();
  return ack;
}
/** Must be called after the same current source/instance locks used by the
 * writer and BEFORE its semantic command validation or mutation. */
export async function assertWorkflowRequestNotRetired(tx: any, actorId: string, parent: WorkflowRecoveryParent, id: unknown): Promise<void> {
  const clientRequestId = workflowText(id, '请求标识'), row = await tx.auditLog.findUnique({ where: { id: workflowRequestAuditId(actorId, parent, clientRequestId) } });
  if (row?.action === 'workflow_request_retired') {
    validateWorkflowRetirement(row, actorId, parent, clientRequestId);
    workflowReject('CONFLICT', '原请求已永久封存，不能再次执行；请核对后使用新请求标识');
  }
}
/** Caller owns source/instance locks and has proved the WFR key has no applied
 * or retired fact. Primary-key uniqueness is an additional permanent fence. */
export async function writeWorkflowRetirement(tx: any, actor: TokenPayload, parent: WorkflowRecoveryParent, original: WorkflowOriginalRequest,
  retirementClientRequestId: string, reason: string): Promise<WorkflowRetirementAcknowledgement> {
  const actorId = actor.userId;
  const key = workflowRequestAuditId(actorId, parent, original.clientRequestId), retiredAt = new Date();
  const fields = { schemaVersion: 1 as const, action: original.action, actorId, parent, originalClientRequestId: original.clientRequestId,
    originalParameterHash: original.parameterHash, retirementClientRequestId: workflowText(retirementClientRequestId, '封存请求标识'), reason: workflowText(reason, '封存说明', false, 2000) };
  const ack: WorkflowRetirementAcknowledgement = { ...fields, retirementParameterHash: retirementHash(fields), fenceAuditId: key, retiredAt: retiredAt.toISOString() };
  await tx.auditLog.create({ data: { id: key, actorId, action: 'workflow_request_retired', targetType: 'WorkflowRequest', targetId: workflowRequestParentKey(parent), createdAt: retiredAt,
    detail: workflowJson({ ...fields, originalCommand: original.command, retirementParameterHash: ack.retirementParameterHash, acknowledgement: ack, acknowledgementHash: workflowHash(ack),
      decisionActorAuthority: { userId: actorId, roleIds: actor.roleIds, authorizationLoaded: true } }) } });
  return ack;
}
