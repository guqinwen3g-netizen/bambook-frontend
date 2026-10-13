/** Transactional generic workflow decisions. Domain approval/fulfillment is separate. */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, WorkflowDefinition, WorkflowStep } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import { createNotificationService } from '../notifications/notificationService';
import { logger } from '../lib/logger';
import { StepDef, CreateInstanceParams, DecideStepParams, WorkflowInstanceFilter, WorkflowInstanceDetail, WorkflowStepDetail, DefaultWorkflowDefinition, WorkflowCommandOptions, WorkflowAcknowledgement, WorkflowSourceFilter, WorkflowSourceCandidate } from './workflowTypes';
import { WORKFLOW_ENTITY_TYPES, WorkflowError, currentWorkflowActor, assertWorkflowScope, assertWorkflowReviewer, assertWorkflowDecisionScope, hasWorkflowDecisionScope,
  workflowCanCancel, workflowEntityType, workflowReviewerMatches, workflowSource, workflowText, workflowJson, workflowHash, workflowReject, workflowScope, canonicalWorkflowReviewer, workflowTriggerGap, workflowConcurrencyFailure } from './workflowAccess';
import { assertWorkflowRequestNotRetired, normalizeWorkflowOriginal, validateWorkflowRetirement, writeWorkflowRetirement, workflowRequestAuditId,
  type WorkflowOriginalRequestInput, type WorkflowRetirementInput, type WorkflowOriginalRequest, type WorkflowRecoveryParent, type WorkflowRecoveryResult } from './workflowRequestRecovery';
const TX = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 };
const INCLUDE = { steps: { orderBy: { stepIndex: 'asc' as const } }, definition: true, initiator: { select: { displayName: true } } };
function generateId(prefix: string): string { return `${prefix}_${randomUUID()}`; }
function definitionSteps(value: any): StepDef[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) workflowReject('INVALID_INPUT', '工作流步骤配置无效', 400);
  return value.map(row => ({ name: workflowText(row?.name, '步骤名称'),
    ...(row.approverUserId ? { approverUserId: workflowText(row.approverUserId, '审批人') } : {}),
    ...(row.approverRole ? { approverRole: canonicalWorkflowReviewer(workflowText(row.approverRole, '审批角色')) } : {}),
    ...(row.description ? { description: workflowText(row.description, '步骤说明', false, 2000) } : {}) }));
}
function dtoStep(instance: any): string | null { return instance.steps.find((s: any) => s.stepIndex === instance.currentStepIndex)?.id ?? null; }
function workflowDecisionNote(decision: 'approved' | 'rejected', reason: string, requestedChanges: string, note: string): string | null {
  if (decision === 'approved') return note || null;
  return `驳回原因：${reason}\n需要修改的内容：${requestedChanges}${note ? `\n补充说明：${note}` : ''}`;
}
function workflowReviewProjection(entityType: string, source: any): Record<string, unknown> {
  const row = source?.row ?? {};
  const pick = (value: any, fields: string[]) => Object.fromEntries(fields.map(field => [field, value?.[field] ?? null]));
  if (entityType === 'Order') return {
    reference: row.poNumber ?? row.code ?? null,
    order: pick(row, ['customer', 'product', 'status', 'currency', 'quoteAmount', 'dueDate', 'season', 'deliveryDate']),
    lines: Array.isArray(source?.lines) ? source.lines.map((line: any) => pick(line,
      ['lineNumber', 'itemNo', 'description', 'materialCode', 'quantity', 'unit', 'unitPrice', 'netValue', 'deliveryDate', 'exMillDate', 'styleNo', 'colorName'])) : [],
  };
  if (entityType === 'Invoice') return {
    reference: row.invoiceNumber ?? null,
    invoice: pick(row, ['type', 'status', 'amount', 'currency', 'issueDate', 'dueDate', 'customerName', 'orderId']),
    lines: Array.isArray(source?.lines) ? source.lines.map((line: any) => pick(line, ['lineNumber', 'description', 'quantity', 'unit', 'amount', 'currency'])) : [],
    allocations: Array.isArray(source?.attachments) ? source.attachments.map((allocation: any) => pick(allocation, ['orderId', 'developmentCaseId', 'amount', 'currency', 'description'])) : [],
  };
  return {
    reference: row.code ?? row.name ?? null,
    developmentCase: pick(row, ['name', 'type', 'stage', 'customerName', 'productName', 'currentRound', 'sampleCategory', 'reviewStatus', 'targetDate']),
    batches: Array.isArray(source?.batches) ? source.batches.map((batch: any) => pick(batch,
      ['batchCode', 'sampleType', 'round', 'status', 'supplierName', 'specNote', 'qcStatus', 'customerStatus'])) : [],
  };
}
export class WorkflowEngine {
  constructor(private prisma: PrismaClient) {}
  private async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    try { return await this.prisma.$transaction(fn, TX); }
    catch (error) { if (workflowConcurrencyFailure(error)) workflowReject('CONFLICT', '工作流已被另一请求更新，请保留原请求并重试'); throw error; }
  }
  async listDefinitions(supplied?: TokenPayload | null): Promise<Array<WorkflowDefinition & { triggerStatus: 'manual' | 'disabled' | 'supported'; triggerGap: string | null; canStart: boolean }>> {
    const actor = await currentWorkflowActor(this.prisma, supplied);
    const types = WORKFLOW_ENTITY_TYPES.filter(type => hasScope(actor, workflowScope(type, 'read')));
    if (!types.length) workflowReject('FORBIDDEN', '当前无工作流读取权限', 403);
    const definitions = await this.prisma.workflowDefinition.findMany({ where: { isActive: true, entityType: { in: [...types] } }, orderBy: { createdAt: 'asc' } });
    return definitions.map(definition => ({ ...definition, triggerStatus: !definition.triggerEvent ? 'manual' : workflowTriggerGap(definition.entityType, definition.triggerEvent) ? 'disabled' : 'supported', triggerGap: workflowTriggerGap(definition.entityType, definition.triggerEvent),
      // Capability only: the selected real source's fresh L2/category and the
      // current definition/reviewer facts are still checked by createInstance.
      canStart: hasScope(actor, workflowScope(workflowEntityType(definition.entityType), 'start')) }));
  }
  async getDefinition(id: string, supplied?: TokenPayload | null): Promise<WorkflowDefinition | null> {
    const actor = await currentWorkflowActor(this.prisma, supplied);
    const definition = await this.prisma.workflowDefinition.findUnique({ where: { id } });
    if (definition) assertWorkflowScope(actor, workflowEntityType(definition.entityType), 'read');
    return definition;
  }
  async listSources(filter: WorkflowSourceFilter): Promise<{ items: WorkflowSourceCandidate[]; total: number; limit: number; offset: number }> {
    return this.transaction(async tx => {
      const actor = await currentWorkflowActor(tx, filter.actor), type = workflowEntityType(filter.entityType), limit = filter.limit ?? 50, offset = filter.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) workflowReject('INVALID_INPUT', '分页参数无效', 400);
      assertWorkflowScope(actor, type, 'read'); assertWorkflowScope(actor, type, 'start');
      const delegate = { Order: 'order', Invoice: 'invoice', DevelopmentCase: 'developmentCase' }[type];
      // One coherent DB snapshot. Current volumes permit exact server filtering
      // before count/page; no unscoped row labels are returned to the browser.
      const candidates = await tx[delegate].findMany({ where: { deletedAt: null, ...(type === 'DevelopmentCase' ? { sampleCategory: '5a' } : {}) }, select: { id: true }, orderBy: { id: 'asc' } });
      const visible: WorkflowSourceCandidate[] = [];
      for (const candidate of candidates) {
        try {
          const source = await workflowSource(tx, actor, type, candidate.id, 'start'), row = source.snapshot.row;
          if (type === 'DevelopmentCase' && row.sampleCategory !== '5a') continue;
          const parts = type === 'Order' ? [row.poNumber || row.code || '订单', row.customer, row.product]
            : type === 'Invoice' ? [row.invoiceNumber, row.customerName] : [row.code, row.name];
          const label = parts.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()).join(' · ').slice(0, 1000);
          visible.push({ id: row.id, label, type });
        } catch (error) {
          // Absent/foreign or explicitly unusable source graphs are not
          // candidates. SQL, current-permission and other dependency faults
          // propagate; an outage must never look like an empty company list.
          if (error instanceof WorkflowError && ['NOT_FOUND', 'CONFLICT'].includes(error.code)) continue;
          throw error;
        }
      }
      return { items: visible.slice(offset, offset + limit), total: visible.length, limit, offset };
    });
  }
  async createDefinition(params: { id?: string; name: string; description?: string; entityType: string; triggerEvent?: string; steps: StepDef[]; actor?: TokenPayload }): Promise<WorkflowDefinition> {
    return this.transaction(async tx => {
      const actor = await currentWorkflowActor(tx, params.actor);
      if (!actor.roleIds?.some(id => ['role-admin','role-super-admin'].includes(canonicalWorkflowReviewer(id)))) workflowReject('FORBIDDEN', '仅当前配置领导可创建工作流定义', 403);
      const type = workflowEntityType(params.entityType); assertWorkflowScope(actor, type, 'start');
      const steps = definitionSteps(params.steps); await this.checkReviewers(tx, steps);
      const definition = await tx.workflowDefinition.create({ data: { id: params.id || generateId('wf_def'), name: workflowText(params.name, '定义名称'), description: params.description || null, entityType: type, triggerEvent: params.triggerEvent || null, steps, isActive: true } });
      await tx.auditLog.create({ data: { id: generateId('WFDA'), actorId: actor.userId, action: 'create_workflow_definition', targetType: 'WorkflowDefinition', targetId: definition.id, detail: { schemaVersion: 1, definition: workflowJson(definition) } } });
      return definition;
    });
  }
  private async checkReviewers(tx: any, steps: StepDef[]) {
    for (const step of steps) {
      if (step.approverUserId) {
        if (!await tx.userAccount.findFirst({ where: { id: step.approverUserId, status: 'active', deletedAt: null }, select: { id: true } })) workflowReject('INVALID_INPUT', '指定审批人已失效，请配置后重新发起', 400);
      } else if (!step.approverRole || !await tx.role.findUnique({ where: { id: step.approverRole }, select: { id: true } })) workflowReject('INVALID_INPUT', '审批角色未配置，请配置后重新发起', 400);
    }
  }
  private request(actor: TokenPayload, parent: string, action: WorkflowAcknowledgement['action'], id: unknown, command: any) {
    const clientRequestId = workflowText(id, '请求标识');
    return { id: `WFR_${workflowHash({ actorId: actor.userId, parent, clientRequestId })}`, clientRequestId, action, parameterHash: workflowHash(command), command: workflowJson(command) };
  }
  private async replay(tx: any, request: any, actor: TokenPayload, instanceId?: string): Promise<WorkflowAcknowledgement | null> {
    const row = await tx.auditLog.findUnique({ where: { id: request.id } });
    if (!row) return null;
    const fact = row.detail;
    if (row.actorId !== actor.userId || row.targetType !== 'WorkflowInstance' || row.action !== `workflow_${request.action}`
      || fact?.schemaVersion !== 1 || fact.action !== request.action || fact.parameterHash !== request.parameterHash || workflowHash(fact.command) !== request.parameterHash
      || fact.acknowledgement?.auditId !== row.id || fact.acknowledgement?.actorId !== actor.userId || fact.acknowledgement?.clientRequestId !== request.clientRequestId
      || fact.acknowledgement?.instanceId !== row.targetId || fact.acknowledgement?.parameterHash !== request.parameterHash
      || fact.acknowledgement?.action !== request.action || workflowHash(fact.acknowledgement) !== fact.acknowledgementHash || (instanceId && row.targetId !== instanceId)) workflowReject('CONFLICT', '原请求记录不匹配，保留原请求并核对历史');
    return fact.acknowledgement;
  }
  private async receipt(tx: any, request: any, actor: TokenPayload, instance: any, sourceFingerprint: string, stepId: string | null, extra: any = {}): Promise<WorkflowAcknowledgement> {
    const acknowledgement: WorkflowAcknowledgement = { schemaVersion: 1, action: request.action, clientRequestId: request.clientRequestId,
      actorId: actor.userId, parameterHash: request.parameterHash, instanceId: instance.id, stepId,
      status: instance.status, currentStepIndex: instance.currentStepIndex, sourceFingerprint, auditId: request.id };
    await tx.auditLog.create({ data: { id: request.id, actorId: actor.userId, action: `workflow_${request.action}`, targetType: 'WorkflowInstance', targetId: instance.id,
      detail: workflowJson({ schemaVersion: 1, action: request.action, command: request.command, parameterHash: request.parameterHash, acknowledgement, acknowledgementHash: workflowHash(acknowledgement),
        decisionActorAuthority: { userId: actor.userId, roleIds: actor.roleIds, authorizationLoaded: true }, ...extra }) } });
    return acknowledgement;
  }
  private async creationFact(tx: any, instance: any) {
    const row = await tx.auditLog.findUnique({ where: { id: `WFC_${instance.id}` } });
    const fact = row?.detail;
    if (!row || row.action !== 'workflow_source_snapshot' || row.targetType !== 'WorkflowInstance' || row.targetId !== instance.id
      || row.actorId !== instance.initiatedById || fact?.schemaVersion !== 1 || fact.entityType !== instance.entityType || fact.entityId !== instance.entityId
      || fact.definitionId !== instance.definitionId || workflowHash(fact.sourceSnapshot) !== fact.sourceFingerprint
      || workflowHash(fact.definitionSnapshot) !== fact.definitionFingerprint) return null;
    const configured = fact.definitionSnapshot.steps;
    if (!Array.isArray(configured) || configured.length !== instance.steps.length || instance.steps.some((step: any, index: number) => step.stepIndex !== index || step.stepName !== configured[index]?.name
      || (step.approverUserId || null) !== (configured[index]?.approverUserId || null) || (step.approverRole || null) !== (configured[index]?.approverRole || null))) return null;
    if (!Number.isSafeInteger(instance.currentStepIndex) || instance.currentStepIndex < 0 || instance.currentStepIndex >= instance.steps.length) return null;
    for (const step of instance.steps) {
      if (step.stepIndex < instance.currentStepIndex && step.decision !== 'approved') return null;
      if (step.stepIndex > instance.currentStepIndex && step.decision !== null) return null;
      if (!step.decision) continue;
      const audits = await tx.auditLog.findMany({ where: { targetType: 'WorkflowInstance', targetId: instance.id, action: { in: ['workflow_approve','workflow_reject'] } } });
      const matching = audits.filter((audit: any) => {
        const snapshot = audit.detail?.decisionSnapshot;
        const base = { stepId: step.id, decision: step.decision, decisionNote: step.decisionNote, decidedById: step.decidedById, decidedAt: workflowJson(step.decidedAt) };
        const legacySnapshot = workflowHash(snapshot) === workflowHash(base);
        const modernFieldsValid = snapshot?.confirmedReviewedContent === true && snapshot.reviewedSourceFingerprint === fact.sourceFingerprint
          && (step.decision === 'approved' ? snapshot.rejectionReason == null && snapshot.requestedChanges == null
            : typeof snapshot.rejectionReason === 'string' && !!snapshot.rejectionReason.trim()
              && typeof snapshot.requestedChanges === 'string' && !!snapshot.requestedChanges.trim())
          && (snapshot.supplementalNote == null || typeof snapshot.supplementalNote === 'string')
          && base.decisionNote === workflowDecisionNote(step.decision,
            snapshot.rejectionReason ?? '', snapshot.requestedChanges ?? '', snapshot.supplementalNote ?? '');
        const modernSnapshot = modernFieldsValid && workflowHash(snapshot) === workflowHash({ ...base, confirmedReviewedContent: true,
          reviewedSourceFingerprint: fact.sourceFingerprint, rejectionReason: snapshot.rejectionReason ?? null,
          requestedChanges: snapshot.requestedChanges ?? null, supplementalNote: snapshot.supplementalNote ?? null });
        return audit.actorId === step.decidedById && snapshot?.stepId === step.id && (legacySnapshot || modernSnapshot)
        && audit.detail.decisionActorAuthority?.userId === step.decidedById && audit.detail.decisionActorAuthority?.authorizationLoaded === true
        && Array.isArray(audit.detail.decisionActorAuthority?.roleIds) && audit.detail.creationAuditId === row.id && audit.detail.acknowledgement?.sourceFingerprint === fact.sourceFingerprint
        && audit.detail.acknowledgement?.auditId === audit.id && workflowHash(audit.detail.acknowledgement) === audit.detail.acknowledgementHash;
      });
      if (matching.length !== 1) return null;
    }
    return fact;
  }
  private async detail(tx: any, instance: any, actor: TokenPayload, source: any, acknowledgement?: WorkflowAcknowledgement): Promise<WorkflowInstanceDetail> {
    const dto = this.toDetail(instance, instance.definition?.name || '', instance.steps);
    dto.initiatorName = instance.initiator?.displayName || null;
    const deciderIds = [...new Set<string>(instance.steps.map((s: any) => s.decidedById).filter(Boolean))];
    if (deciderIds.length) {
      const users = await tx.userAccount.findMany({ where: { id: { in: deciderIds } }, select: { id: true, displayName: true } });
      dto.steps.forEach(step => { step.deciderName = users.find((u: any) => u.id === step.decidedById)?.displayName || null; });
    }
    const fact = await this.creationFact(tx, instance);
    dto.definitionVersion = fact?.definitionSnapshot.version ?? null;
    dto.sourceFingerprint = fact?.sourceFingerprint ?? source.fingerprint;
    dto.blockedReason = !fact ? '此历史流程缺少完整来源依据，请保留历史并重新发起' : fact.sourceFingerprint !== source.fingerprint ? '来源内容已变化，请取消后重新发起' : null;
    dto.reviewBasis = fact ? { entityType: workflowEntityType(instance.entityType),
      frozen: workflowReviewProjection(instance.entityType, fact.sourceSnapshot), current: workflowReviewProjection(instance.entityType, source.snapshot) } : null;
    const step = instance.steps.find((s: any) => s.stepIndex === instance.currentStepIndex);
    const canDecide = !dto.blockedReason && instance.status === 'running' && step && !step.decision
      && actor.userId !== instance.initiatedById && hasWorkflowDecisionScope(actor, workflowEntityType(instance.entityType), step) && workflowReviewerMatches(actor, step);
    dto.allowedActions = { approve: !!canDecide, reject: !!canDecide, cancel: instance.status === 'running' && workflowCanCancel(actor, instance) && hasScope(actor, workflowScope(workflowEntityType(instance.entityType), 'start')) };
    if (acknowledgement) dto.acknowledgement = acknowledgement;
    return dto;
  }
  async createInstance(params: CreateInstanceParams): Promise<WorkflowInstanceDetail> {
    const type = workflowEntityType(params.entityType), entityId = workflowText(params.entityId, '来源'), definitionId = workflowText(params.definitionId, '定义');
    const result = await this.transaction(async tx => {
      const actor = await currentWorkflowActor(tx, params.actor); assertWorkflowScope(actor, type, 'start');
      const source = await workflowSource(tx, actor, type, entityId, 'start', true);
      await assertWorkflowRequestNotRetired(tx, actor.userId, { entityType: type, entityId, instanceId: null }, params.clientRequestId);
      const command = { definitionId, entityType: type, entityId, title: workflowText(params.title, '标题', true, 1000) };
      const request = this.request(actor, `${type}:${entityId}`, 'create', params.clientRequestId, command);
      const existing = await this.replay(tx, request, actor);
      if (existing) {
        const instance = await tx.workflowInstance.findUnique({ where: { id: existing.instanceId }, include: INCLUDE });
        if (!instance || instance.entityType !== type || instance.entityId !== entityId) workflowReject('CONFLICT', '原请求目标已不一致');
        return this.detail(tx, instance, actor, source, existing);
      }
      const definition = await tx.workflowDefinition.findUnique({ where: { id: definitionId } });
      if (!definition || !definition.isActive) workflowReject('NOT_FOUND', '工作流定义不存在或已停用', 404);
      if (definition.entityType !== type) workflowReject('INVALID_INPUT', '工作流定义与来源类型不匹配', 400);
      if (type === 'DevelopmentCase' && source.snapshot.row.sampleCategory !== '5a') workflowReject('INVALID_INPUT', '此评审仅适用5A开发案', 400);
      const steps = definitionSteps(definition.steps); await this.checkReviewers(tx, steps);
      const running = await tx.workflowInstance.findMany({ where: { definitionId, entityType: type, entityId, status: 'running' }, include: INCLUDE });
      if (running.length > 1) workflowReject('CONFLICT', '此来源有多个历史未结流程，请人工核对');
      if (running.length) {
        const fact = await this.creationFact(tx, running[0]);
        if (!fact || fact.sourceFingerprint !== source.fingerprint || running[0].initiatedById !== actor.userId) workflowReject('CONFLICT', '已有不同或旧版未结流程，请核对后续办');
        const acknowledgement = await this.receipt(tx, request, actor, running[0], source.fingerprint, null);
        return this.detail(tx, running[0], actor, source, acknowledgement);
      }
      const instance = await tx.workflowInstance.create({ data: { id: generateId('wf_inst'), definitionId, entityType: type, entityId, title: command.title || null,
        status: 'running', currentStepIndex: 0, initiatedById: actor.userId, steps: { create: steps.map((step, stepIndex) => ({ id: generateId('wf_step'), stepIndex,
          stepName: step.name, approverRole: step.approverRole || null, approverUserId: step.approverUserId || null, decision: null })) } }, include: INCLUDE });
      const definitionSnapshot = workflowJson({ id: definitionId, entityType: type, name: definition.name, version: definition.version, steps });
      await tx.auditLog.create({ data: { id: `WFC_${instance.id}`, actorId: actor.userId, action: 'workflow_source_snapshot', targetType: 'WorkflowInstance', targetId: instance.id,
        detail: { schemaVersion: 1, entityType: type, entityId, definitionId, sourceFingerprint: source.fingerprint, sourceSnapshot: source.snapshot,
          definitionSnapshot, definitionFingerprint: workflowHash(definitionSnapshot) } } });
      const acknowledgement = await this.receipt(tx, request, actor, instance, source.fingerprint, null);
      return this.detail(tx, instance, actor, source, acknowledgement);
    });
    if (result.acknowledgement?.status === 'running') await this.notifyCurrentApprover(result, result.definitionName);
    return result;
  }
  private async locked(tx: any, id: string, actor: TokenPayload, mode: 'start' | 'decide') {
    const hint = await tx.workflowInstance.findUnique({ where: { id } });
    if (!hint) workflowReject('NOT_FOUND', '工作流实例不存在', 404);
    const type = workflowEntityType(hint.entityType); assertWorkflowScope(actor, type, mode === 'decide' ? 'read' : mode);
    const source = await workflowSource(tx, actor, type, hint.entityId, mode, true);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "WorkflowInstance" WHERE "id"=${id} FOR UPDATE`);
    const instance = await tx.workflowInstance.findUnique({ where: { id }, include: INCLUDE });
    if (!instance || instance.entityType !== hint.entityType || instance.entityId !== hint.entityId) workflowReject('CONFLICT', '流程来源已变化');
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "WorkflowStep" WHERE "instanceId"=${id} ORDER BY "stepIndex", "id" FOR UPDATE`);
    const fresh = await tx.workflowInstance.findUnique({ where: { id }, include: INCLUDE });
    if (!fresh || fresh.entityType !== hint.entityType || fresh.entityId !== hint.entityId) workflowReject('CONFLICT', '流程来源已变化');
    return { instance: fresh, source };
  }
  private expectation(instance: any, source: any, fact: any, params: WorkflowCommandOptions, cancel = false) {
    const step = instance.steps.find((s: any) => s.stepIndex === instance.currentStepIndex);
    if (!step || params.expectedStepId !== step.id || params.expectedStepIndex !== instance.currentStepIndex) workflowReject('CONFLICT', '当前步骤已变化，请刷新后重试');
    if (!cancel && (!fact || params.sourceFingerprint !== fact.sourceFingerprint || source.fingerprint !== fact.sourceFingerprint)) workflowReject('CONFLICT', '批准依据缺失或来源内容已变化，请保留历史并重新发起');
    if (cancel && params.sourceFingerprint !== (fact?.sourceFingerprint || source.fingerprint)) workflowReject('CONFLICT', '取消依据已变化，请刷新后重试');
    return step;
  }
  async decideStep(params: DecideStepParams): Promise<WorkflowInstanceDetail> {
    const result = await this.transaction(async tx => {
      const actor = await currentWorkflowActor(tx, params.actor);
      if (params.decidedById !== actor.userId) workflowReject('FORBIDDEN', '决定主体不匹配', 403);
      const { instance, source } = await this.locked(tx, workflowText(params.instanceId, '流程'), actor, 'decide');
      await assertWorkflowRequestNotRetired(tx, actor.userId, { entityType: workflowEntityType(instance.entityType), entityId: instance.entityId, instanceId: instance.id }, params.clientRequestId);
      const command: Record<string, unknown> = { instanceId: instance.id, decision: params.decision, expectedStepId: params.expectedStepId ?? null,
        expectedStepIndex: params.expectedStepIndex ?? null, sourceFingerprint: params.sourceFingerprint ?? null,
        note: workflowText(params.note, '补充说明', true, 2000),
        ...(params.confirmedReviewedContent !== undefined ? { confirmedReviewedContent: params.confirmedReviewedContent } : {}),
        ...(params.rejectionReason !== undefined ? { rejectionReason: workflowText(params.rejectionReason, '驳回原因', true, 2000) } : {}),
        ...(params.requestedChanges !== undefined ? { requestedChanges: workflowText(params.requestedChanges, '需要修改的内容', true, 2000) } : {}) };
      if (!['approved','rejected'].includes(params.decision)) workflowReject('INVALID_INPUT', '审批决定无效', 400);
      const request = this.request(actor, `instance:${instance.id}`, params.decision === 'approved' ? 'approve' : 'reject', params.clientRequestId, command);
      const replay = await this.replay(tx, request, actor, instance.id);
      if (replay) {
        const originalStep = instance.steps.find((step: any) => step.id === replay.stepId);
        if (!originalStep) workflowReject('CONFLICT', '原决定步骤已不完整');
        assertWorkflowDecisionScope(actor, workflowEntityType(instance.entityType), originalStep);
        return this.detail(tx, instance, actor, source, replay);
      }
      if (instance.status !== 'running') workflowReject('INVALID_STATE', '当前流程无法审批');
      const fact = await this.creationFact(tx, instance), step = this.expectation(instance, source, fact, params);
      assertWorkflowReviewer(actor, instance, step);
      assertWorkflowDecisionScope(actor, workflowEntityType(instance.entityType), step);
      if (params.confirmedReviewedContent !== true) workflowReject('REVIEW_CONFIRMATION_REQUIRED', '请核对来源依据并明确确认后再办理', 400);
      const rejectionReason = params.decision === 'rejected' ? workflowText(params.rejectionReason, '驳回原因', false, 2000) : '';
      const requestedChanges = params.decision === 'rejected' ? workflowText(params.requestedChanges, '需要修改的内容', false, 2000) : '';
      const decisionNote = workflowDecisionNote(params.decision, rejectionReason, requestedChanges, String(command.note ?? ''));
      if (decisionNote && decisionNote.length > 5000) workflowReject('INVALID_INPUT', '驳回原因和修改要求合计过长', 400);
      const decidedAt = new Date();
      const changed = await tx.workflowStep.updateMany({ where: { id: step.id, instanceId: instance.id, stepIndex: instance.currentStepIndex, decision: null },
        data: { decision: params.decision, decisionNote, decidedById: actor.userId, decidedAt } });
      if (changed.count !== 1) workflowReject('CONFLICT', '当前步骤已被另一请求决定');
      const finished = params.decision === 'rejected' || instance.currentStepIndex === instance.steps.length - 1;
      const status = finished ? params.decision : 'running';
      const advanced = await tx.workflowInstance.updateMany({ where: { id: instance.id, status: 'running', currentStepIndex: instance.currentStepIndex },
        data: { status, currentStepIndex: finished ? instance.currentStepIndex : instance.currentStepIndex + 1, completedAt: finished ? decidedAt : null } });
      if (advanced.count !== 1) workflowReject('CONFLICT', '当前流程已被另一请求更新');
      const current = await tx.workflowInstance.findUnique({ where: { id: instance.id }, include: INCLUDE });
      const acknowledgement = await this.receipt(tx, request, actor, current, fact.sourceFingerprint, step.id, { creationAuditId: `WFC_${instance.id}`, definitionVersion: fact.definitionSnapshot.version,
        decisionSnapshot: { stepId: step.id, decision: params.decision, decisionNote, decidedById: actor.userId, decidedAt: decidedAt.toISOString(),
          confirmedReviewedContent: true, reviewedSourceFingerprint: fact.sourceFingerprint,
          rejectionReason: params.decision === 'rejected' ? rejectionReason : null,
          requestedChanges: params.decision === 'rejected' ? requestedChanges : null, supplementalNote: String(command.note ?? '') || null } });
      return this.detail(tx, current, actor, source, acknowledgement);
    });
    if (result.status === 'running') await this.notifyCurrentApprover(result, result.definitionName);
    else if (result.status === 'approved' || result.status === 'rejected') await this.notifyInitiator(result, result.definitionName, result.status);
    return result;
  }
  async cancelInstance(id: string, reason?: string, params: WorkflowCommandOptions = {}): Promise<WorkflowInstanceDetail> {
    return this.transaction(async tx => {
      const actor = await currentWorkflowActor(tx, params.actor);
      const { instance, source } = await this.locked(tx, id, actor, 'start');
      await assertWorkflowRequestNotRetired(tx, actor.userId, { entityType: workflowEntityType(instance.entityType), entityId: instance.entityId, instanceId: instance.id }, params.clientRequestId);
      if (!workflowCanCancel(actor, instance)) workflowReject('FORBIDDEN', '仅发起人或当前领导可取消可见的流程', 403);
      const command = { instanceId: id, expectedStepId: params.expectedStepId ?? null, expectedStepIndex: params.expectedStepIndex ?? null,
        sourceFingerprint: params.sourceFingerprint ?? null, reason: workflowText(reason, '取消说明', true, 2000) };
      const request = this.request(actor, `instance:${id}`, 'cancel', params.clientRequestId, command), replay = await this.replay(tx, request, actor, id);
      if (replay) return this.detail(tx, instance, actor, source, replay);
      if (instance.status !== 'running') workflowReject('INVALID_STATE', '当前流程无法取消');
      const fact = await this.creationFact(tx, instance); this.expectation(instance, source, fact, params, true);
      const changed = await tx.workflowInstance.updateMany({ where: { id, status: 'running', currentStepIndex: instance.currentStepIndex }, data: { status: 'cancelled', completedAt: new Date() } });
      if (changed.count !== 1) workflowReject('CONFLICT', '流程已被另一请求更新');
      const current = await tx.workflowInstance.findUnique({ where: { id }, include: INCLUDE });
      const acknowledgement = await this.receipt(tx, request, actor, current, fact?.sourceFingerprint || source.fingerprint, dtoStep(instance), { legacyMissingSnapshot: !fact });
      return this.detail(tx, current, actor, source, acknowledgement);
    });
  }
  private async recoveryParent(tx: any, actor: TokenPayload, original: WorkflowOriginalRequest) {
    if (original.action === 'create') {
      const { entityType, entityId } = original.source!;
      assertWorkflowScope(actor, entityType, 'read'); assertWorkflowScope(actor, entityType, 'start');
      await workflowSource(tx, actor, entityType, entityId, 'start', true);
      return { parent: { entityType, entityId, instanceId: null } as WorkflowRecoveryParent, instance: null as any };
    }
    const { instance } = await this.locked(tx, original.instanceId!, actor, original.action === 'cancel' ? 'start' : 'decide');
    const parent: WorkflowRecoveryParent = { entityType: workflowEntityType(instance.entityType), entityId: instance.entityId, instanceId: instance.id };
    if (original.action === 'cancel') {
      if (!workflowCanCancel(actor, instance)) workflowReject('FORBIDDEN', '仅发起人或当前领导可核对此取消请求', 403);
    } else {
      const step = instance.steps.find((row: any) => row.id === original.command.expectedStepId)
        || instance.steps.find((row: any) => row.stepIndex === instance.currentStepIndex);
      if (!step) workflowReject('CONFLICT', '原流程步骤不完整，请保留请求并核对历史');
      assertWorkflowDecisionScope(actor, parent.entityType, step);
    }
    return { parent, instance };
  }
  private async recoveryResult(tx: any, actor: TokenPayload, original: WorkflowOriginalRequest, locked: { parent: WorkflowRecoveryParent; instance: any }, retirement?: WorkflowRetirementInput): Promise<WorkflowRecoveryResult> {
    const { parent } = locked, key = workflowRequestAuditId(actor.userId, parent, original.clientRequestId);
    const base = { schemaVersion: 1 as const, decisionScope: 'workflow_only' as const, nativeBusinessApplied: false as const,
      action: original.action, originalClientRequestId: original.clientRequestId, originalParameterHash: original.parameterHash, actorId: actor.userId, parent };
    const row = await tx.auditLog.findUnique({ where: { id: key } });
    if (row?.action === 'workflow_request_retired') {
      const ack = validateWorkflowRetirement(row, actor.userId, parent, original.clientRequestId);
      if (ack.action !== original.action || ack.originalParameterHash !== original.parameterHash) workflowReject('CONFLICT', '原请求已用于其他内容，请保留原请求并核对历史');
      if (retirement && (ack.retirementClientRequestId !== workflowText(retirement.retirementClientRequestId, '封存请求标识') || ack.reason !== workflowText(retirement.reason, '封存说明', false, 2000))) workflowReject('CONFLICT', '封存请求已用于其他内容，请核对原封存回执');
      return { ...base, state: 'retired', retirement: ack };
    }
    if (row) {
      const request = this.request(actor, parent.instanceId ? `instance:${parent.instanceId}` : `${parent.entityType}:${parent.entityId}`, original.action, original.clientRequestId, original.command);
      const ack = await this.replay(tx, request, actor, parent.instanceId || undefined);
      if (!ack) workflowReject('CONFLICT', '原请求记录不完整，请核对历史');
      let instance = locked.instance;
      if (!instance) {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "WorkflowInstance" WHERE "id"=${ack.instanceId} FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "WorkflowStep" WHERE "instanceId"=${ack.instanceId} ORDER BY "stepIndex", "id" FOR UPDATE`);
        instance = await tx.workflowInstance.findUnique({ where: { id: ack.instanceId }, include: INCLUDE });
      }
      if (!instance || instance.id !== ack.instanceId || instance.entityType !== parent.entityType || instance.entityId !== parent.entityId) workflowReject('CONFLICT', '原请求的业务来源不完整，请核对历史');
      const fact = await this.creationFact(tx, instance);
      if (original.action !== 'cancel' && (!fact || ack.sourceFingerprint !== fact.sourceFingerprint)
        || original.action === 'cancel' && !fact && !row.detail?.legacyMissingSnapshot) workflowReject('CONFLICT', '原请求历史依据已损坏，请保留请求并核对历史');
      if (!fact && await tx.auditLog.findUnique({ where: { id: `WFC_${instance.id}` } })) workflowReject('CONFLICT', '原请求历史依据已损坏，请保留请求并核对历史');
      return { ...base, state: 'applied', acknowledgement: ack };
    }
    // Absence is meaningful only under this current parent lock. A read result
    // still cannot prevent a delayed writer; only the committed WFR fence can.
    if (locked.instance) {
      const fact = await this.creationFact(tx, locked.instance);
      if (!fact) {
        const stored = await tx.auditLog.findUnique({ where: { id: `WFC_${locked.instance.id}` } });
        if (original.action !== 'cancel' || stored) workflowReject('CONFLICT', '原流程历史依据缺失或损坏，请先核对历史');
      }
      if (original.action !== 'cancel') {
        const step = locked.instance.steps.find((item: any) => item.id === original.command.expectedStepId)
          || locked.instance.steps.find((item: any) => item.stepIndex === locked.instance.currentStepIndex);
        assertWorkflowReviewer(actor, locked.instance, step);
      }
    }
    if (!retirement) return { ...base, state: 'not_applied_at_check' };
    const ack = await writeWorkflowRetirement(tx, actor, parent, original, retirement.retirementClientRequestId, retirement.reason);
    return { ...base, state: 'retired', retirement: ack };
  }
  async getRequestResult(input: WorkflowOriginalRequestInput, supplied?: TokenPayload | null): Promise<WorkflowRecoveryResult> {
    const original = normalizeWorkflowOriginal(input);
    return this.transaction(async tx => {
      const actor = await currentWorkflowActor(tx, supplied), locked = await this.recoveryParent(tx, actor, original);
      return this.recoveryResult(tx, actor, original, locked);
    });
  }
  async retireRequest(input: WorkflowRetirementInput, supplied?: TokenPayload | null): Promise<WorkflowRecoveryResult> {
    const original = normalizeWorkflowOriginal(input);
    workflowText(input.retirementClientRequestId, '封存请求标识'); workflowText(input.reason, '封存说明', false, 2000);
    return this.transaction(async tx => {
      const actor = await currentWorkflowActor(tx, supplied), locked = await this.recoveryParent(tx, actor, original);
      return this.recoveryResult(tx, actor, original, locked, input);
    });
  }
  async getInstance(id: string, supplied?: TokenPayload | null): Promise<WorkflowInstanceDetail | null> {
    return this.transaction(async tx => {
      const actor = await currentWorkflowActor(tx, supplied);
      const instance = await tx.workflowInstance.findUnique({ where: { id }, include: INCLUDE });
      if (!instance) return null;
      const type = workflowEntityType(instance.entityType); assertWorkflowScope(actor, type, 'read');
      const source = await workflowSource(tx, actor, type, instance.entityId, 'read');
      return this.detail(tx, instance, actor, source);
    });
  }
  async listInstances(filter: WorkflowInstanceFilter = {}): Promise<{ items: WorkflowInstanceDetail[]; total: number }> {
    return this.transaction(async tx => {
      const actor = await currentWorkflowActor(tx, filter.actor), limit = filter.limit ?? 50, offset = filter.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) workflowReject('INVALID_INPUT', '分页参数无效', 400);
      if (filter.view && !['visible','mine','pending'].includes(filter.view)) workflowReject('INVALID_INPUT', '查询视图无效', 400);
      if (filter.status && !['running','approved','rejected','cancelled'].includes(filter.status)) workflowReject('INVALID_INPUT', '流程状态无效', 400);
      const types = filter.entityType ? [workflowEntityType(filter.entityType)] : WORKFLOW_ENTITY_TYPES.filter(type => hasScope(actor, workflowScope(type, 'read')));
      if (!types.length) workflowReject('FORBIDDEN', '当前无工作流读取权限', 403);
      for (const type of types) assertWorkflowScope(actor, type, 'read');
      if (filter.initiatedById && filter.initiatedById !== actor.userId || filter.pendingApproverUserId && filter.pendingApproverUserId !== actor.userId
        || filter.pendingApproverRole && !actor.roleIds?.some(id => canonicalWorkflowReviewer(id) === canonicalWorkflowReviewer(filter.pendingApproverRole!))) workflowReject('FORBIDDEN', '只能查询自己的参与视图', 403);
      const where: any = { entityType: { in: [...types] }, ...(filter.status ? { status: filter.status } : {}), ...(filter.entityId ? { entityId: filter.entityId } : {}),
        ...(filter.view === 'mine' || filter.initiatedById ? { initiatedById: actor.userId } : {}) };
      // Security filtering deliberately precedes count and pagination. Current
      // modest workflow volume uses one coherent snapshot, never take-then-filter.
      const candidates = await tx.workflowInstance.findMany({ where, include: INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
      const visible: WorkflowInstanceDetail[] = [];
      for (const instance of candidates) {
        try {
          const source = await workflowSource(tx, actor, workflowEntityType(instance.entityType), instance.entityId, 'read');
          const dto = await this.detail(tx, instance, actor, source);
          if ((filter.view === 'pending' || filter.pendingApproverRole || filter.pendingApproverUserId) && !dto.allowedActions.approve) continue;
          visible.push(dto);
        } catch (error) { if (error instanceof WorkflowError && error.code === 'NOT_FOUND') continue; throw error; }
      }
      return { items: visible.slice(offset, offset + limit), total: visible.length };
    });
  }
  async getInstancesForEntity(entityType: string, entityId: string, actor?: TokenPayload | null): Promise<WorkflowInstanceDetail[]> {
    const type = workflowEntityType(entityType);
    const current = await currentWorkflowActor(this.prisma, actor); assertWorkflowScope(current, type, 'read');
    await workflowSource(this.prisma, current, type, entityId, 'read');
    return (await this.listInstances({ entityType: type, entityId, actor, limit: 200 })).items;
  }
  // ── 通知当前步骤审批人 ──
  private async notifyCurrentApprover(instance: any, definitionName: string): Promise<void> {
    try {
      const currentStep = instance.steps?.find((s: any) => s.stepIndex === instance.currentStepIndex);
      if (!currentStep) return;

      const notificationService = createNotificationService(this.prisma);
      const title = `${definitionName}：${currentStep.stepName} 待审批`;
      const body = instance.title
        ? `「${instance.title}」需要您审批`
        : `${instance.entityType} ${instance.entityId} 需要您审批`;

      const candidates = currentStep.approverUserId ? [currentStep.approverUserId] : [...new Set<string>((await this.prisma.userRole.findMany({
        where: { roleId: currentStep.approverRole }, select: { userId: true } })).map(row => row.userId))];
      // Role names are presentation only; do not broadcast a source/title to
      // users lacking its current permissions and business visibility.
      for (const userId of candidates) {
        try {
          const actor = await currentWorkflowActor(this.prisma, { userId, roles: [], permissions: [], departmentIds: [] });
          const type = workflowEntityType(instance.entityType); assertWorkflowScope(actor, type, 'read'); assertWorkflowDecisionScope(actor, type, currentStep);
          assertWorkflowReviewer(actor, instance, currentStep);
          await workflowSource(this.prisma, actor, type, instance.entityId, 'read');
          await notificationService.sendToUser({ userId, type: 'workflow_pending', title, body, level: 'info', link: `/workflow?id=${instance.id}`,
            metadata: { instanceId: instance.id, stepIndex: instance.currentStepIndex, entityType: instance.entityType, entityId: instance.entityId, decisionScope: 'workflow_only' } });
        } catch (error) { if (!(error instanceof WorkflowError)) throw error; }
      }
    } catch (e: any) {
      // 通知失败不应阻断工作流推进
      logger.warn('[WorkflowEngine] notify approver failed', { error: e?.message });
    }
  }

  // ── 通知发起人结果 ──
  private async notifyInitiator(instance: any, definitionName: string, result: 'approved' | 'rejected'): Promise<void> {
    if (!instance.initiatedById) return;
    try {
      const actor = await currentWorkflowActor(this.prisma, { userId: instance.initiatedById, roles: [], permissions: [], departmentIds: [] });
      const type = workflowEntityType(instance.entityType); assertWorkflowScope(actor, type, 'read');
      await workflowSource(this.prisma, actor, type, instance.entityId, 'read');
      const notificationService = createNotificationService(this.prisma);
      const title = result === 'approved'
        ? `${definitionName} 已通过`
        : `${definitionName} 被驳回`;
      const body = instance.title
        ? `「${instance.title}」${result === 'approved' ? '审批通过' : '审批被驳回'}`
        : `${instance.entityType} ${instance.entityId} ${result === 'approved' ? '审批通过' : '审批被驳回'}`;

      await notificationService.sendToUser({
        userId: instance.initiatedById,
        type: result === 'approved' ? 'workflow_approved' : 'workflow_rejected',
        title,
        body,
        level: result === 'approved' ? 'info' : 'warning',
        link: `/workflow?id=${instance.id}`,
        metadata: {
          instanceId: instance.id,
          entityType: instance.entityType,
          entityId: instance.entityId,
        },
      });
    } catch (e: any) {
      logger.warn('[WorkflowEngine] notify initiator failed', { error: e?.message });
    }
  }

  // ── 映射函数 ──
  private toDetail(instance: any, definitionName: string, steps: WorkflowStep[] | null | undefined): WorkflowInstanceDetail {
    const stepList = Array.isArray(steps) ? steps : [];
    return {
      schemaVersion: 1, decisionScope: 'workflow_only', nativeBusinessApplied: false,
      definitionVersion: null, sourceFingerprint: null, reviewBasis: null, currentStepId: stepList.find(s => s.stepIndex === instance.currentStepIndex)?.id ?? null,
      allowedActions: { approve: false, reject: false, cancel: false }, blockedReason: '审批依据尚未核对',
      id: instance.id,
      definitionId: instance.definitionId,
      definitionName,
      entityType: instance.entityType,
      entityId: instance.entityId,
      status: instance.status,
      currentStepIndex: instance.currentStepIndex,
      title: instance.title,
      initiatedById: instance.initiatedById,
      initiatorName: null,
      completedAt: instance.completedAt,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      steps: stepList.map(s => this.toStepDetail(s)),
    };
  }

  private toDetailWithNames(
    instance: any,
    definitionName: string,
    steps: WorkflowStep[] | null | undefined,
    initiatorName: string | null,
    deciderMap: Map<string, string>,
  ): WorkflowInstanceDetail {
    const stepList = Array.isArray(steps) ? steps : [];
    return {
      schemaVersion: 1, decisionScope: 'workflow_only', nativeBusinessApplied: false,
      definitionVersion: null, sourceFingerprint: null, reviewBasis: null, currentStepId: stepList.find(s => s.stepIndex === instance.currentStepIndex)?.id ?? null,
      allowedActions: { approve: false, reject: false, cancel: false }, blockedReason: '审批依据尚未核对',
      id: instance.id,
      definitionId: instance.definitionId,
      definitionName,
      entityType: instance.entityType,
      entityId: instance.entityId,
      status: instance.status,
      currentStepIndex: instance.currentStepIndex,
      title: instance.title,
      initiatedById: instance.initiatedById,
      initiatorName,
      completedAt: instance.completedAt,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      steps: stepList.map(s => this.toStepDetail(s, deciderMap.get(s.decidedById || ''))),
    };
  }

  private toStepDetail(step: WorkflowStep, deciderName?: string): WorkflowStepDetail {
    return {
      id: step.id,
      stepIndex: step.stepIndex,
      stepName: step.stepName,
      approverRole: step.approverRole,
      approverUserId: step.approverUserId,
      decision: step.decision as WorkflowStepDetail['decision'],
      decisionNote: step.decisionNote,
      decidedById: step.decidedById,
      deciderName: deciderName || null,
      decidedAt: step.decidedAt,
      createdAt: step.createdAt,
    };
  }
}

// ── 默认工作流定义（首次启动时 seed）──
export const DEFAULT_WORKFLOW_DEFINITIONS: DefaultWorkflowDefinition[] = [
  {
    id: 'wf_def_order_approval',
    name: '订单确认审批',
    description: '订单确认前需经销售经理审批（大额订单可扩展为多步）',
    entityType: 'Order',
    steps: [
      { name: '销售经理审批', approverRole: 'role-sales-manager', description: '确认订单价格、交期、付款条款' },
    ],
  },
  {
    id: 'wf_def_invoice_issuance',
    name: '开票审批',
    description: '开具发票前需经财务审批',
    entityType: 'Invoice',
    // ShipmentCompleted exposes a Shipment, not its actual Invoice(s).
    // Automatic Invoice creation remains disabled until a durable native bridge exists.
    steps: [
      { name: '财务审批', approverRole: 'role-finance', description: '确认开票金额、税号、币种' },
    ],
  },
  {
    id: 'wf_def_devcase_5a_review',
    name: '5A 样衣评审',
    description: '5A 重点样衣需经生产部评审',
    entityType: 'DevelopmentCase',
    steps: [
      { name: '生产经理评审', approverRole: 'role-qc', description: '评审样衣质量、工艺可行性' },
    ],
  },
];

/** 首次启动时 seed 默认工作流定义（已存在则跳过） */
export async function seedDefaultWorkflowDefinitions(prisma: PrismaClient): Promise<void> {
  for (const def of DEFAULT_WORKFLOW_DEFINITIONS) {
    const existing = await prisma.workflowDefinition.findUnique({ where: { id: def.id } });
    if (existing) continue;
    await prisma.workflowDefinition.create({
      data: {
        id: def.id,
        name: def.name,
        description: def.description,
        entityType: def.entityType,
        triggerEvent: def.triggerEvent || null,
        steps: def.steps as any,
        isActive: true,
      },
    });
    logger.info('[WorkflowEngine] seeded default definition', { id: def.id, name: def.name });
  }
}
