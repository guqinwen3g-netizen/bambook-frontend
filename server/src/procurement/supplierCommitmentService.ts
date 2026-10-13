import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { approvalReviewContentVersion } from '../approvals/approvalReviewContent';
import { authorizeSupplierSources, freshSupplierActor, lockSupplierContracts, type SupplierContractTx, type SupplierSourceProof } from './supplierContractAccess';
import { beginSupplierCommand, persistSupplierCommand, replaySupplierCommand, supplierResponse, type SupplierCommand } from './supplierContractCommandReceipt';
import { assertSupplierCommonTermsReady, assertSupplierContractsCompatible, normalizeSupplierContractDraft, supplierDate, supplierFail, supplierFingerprint, supplierJson, SupplierContractError,
  supplierObject, supplierOptionalText, supplierText, type SupplierContractKind, type SupplierContractDraft } from './supplierContractPolicy';
import { assignSupplierLineIds, assertSupplierLineResponsibilities, assertSupplierSourceProof, latestSupplierRevision, projectSupplierContract, readSupplierContract, supplierAudit,
  supplierRevisionWhere, supplierSnapshot, validateSupplierAndLocation, writeSupplierRevision, type SupplierContractRecord, type SupplierSnapshot } from './supplierContractStore';
import { resolveSupplierApprovers } from './supplierCommitmentAuthority';
import { reconcileSupplierDemandPlan } from './supplierDemandAllocation';

export const SUPPLIER_COMMITMENT_APPROVAL_ACTION = 'supplier:commitment';
export const SUPPLIER_COMMITMENT_APPROVAL_TARGET = 'SupplierCommitmentRevision';

export async function supplierContractView(tx: SupplierContractTx, kind: SupplierContractKind, id: string) {
  const contract = await readSupplierContract(tx, kind, id), latest = await latestSupplierRevision(tx, kind, id);
  const approved = contract.approvedCommitmentRevisionId ? await tx.supplierCommitmentRevision.findUnique({ where: { id: contract.approvedCommitmentRevisionId } }) : null;
  const snapshot = latest ? supplierSnapshot(latest.snapshot, kind) : null;
  const facts = await tx.supplierFulfillmentFact.findMany({ where: kind === 'purchase' ? { purchaseLineId: { in: contract.lines.map(row => row.id) }, kind: 'purchase_delivery' }
    : { outsourcingLineId: { in: contract.lines.map(row => row.id) } }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] });
  const approvalState = !latest ? 'unknown' : approved && latest.id !== approved.id ? `amendment_${latest.status}` : latest.status;
  const commands = await tx.supplierContractCommandReceipt.findMany({ where: { contractKind: kind, contractId: id, operation: { in: ['record_offline_send', 'record_supplier_feedback', 'generate_document'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return supplierJson({ id, contractKind: kind, number: contract.number, status: contract.status, approvalState,
    latestRevisionId: latest?.id ?? null, latestRevision: latest?.revision ?? 0, draft: snapshot, approvedRevision: approved,
    fulfillments: facts, offlineHistory: commands.map(row => ({ id: row.id, operation: row.operation, recordedBy: row.actorId, recordedAt: row.createdAt, data: row.requestSnapshot })),
    businessOwnerId: contract.businessOwnerId, legacyBasisUnknown: !latest });
}
export async function authorizeSupplierContract(tx: SupplierContractTx, kind: SupplierContractKind, id: string, actor: TokenPayload,
  options: { mode: 'read' | 'write' | 'approve'; lock?: boolean; formal?: boolean; extraLineIds?: string[]; businessGates?: boolean } = { mode: 'read' }) {
  const before = await readSupplierContract(tx, kind, id), latest = await latestSupplierRevision(tx, kind, id);
  const draft = latest ? supplierSnapshot(latest.snapshot, kind) : null;
  const lineIds = [...new Set([...before.lines.flatMap(row => row.orderLineId ? [row.orderLineId] : []), ...(draft?.lines.map(row => row.orderLineId) ?? []), ...(options.extraLineIds ?? [])])];
  await authorizeSupplierSources(tx, actor, lineIds, { mode: options.mode, lock: options.lock, formal: options.formal, businessGates: options.businessGates });
  if (options.lock) await lockSupplierContracts(tx, [{ kind, id }]);
  const contract = await readSupplierContract(tx, kind, id), current = await latestSupplierRevision(tx, kind, id);
  if (supplierFingerprint(before.lines) !== supplierFingerprint(contract.lines) || latest?.id !== current?.id)
    return supplierFail('REVISION_CONFLICT', '合同及来源集合已变化，请刷新后重试。', 409);
  const after = await authorizeSupplierSources(tx, actor, lineIds, { mode: options.mode, formal: options.formal, businessGates: options.businessGates });
  return { ...after, contract, latest: current, snapshot: draft };
}
function snapshotFor(draft: SupplierContractDraft, sources: SupplierSourceProof[], actorId: string, basedOnRevisionId: string | null = null, changeReason: string | null = null, supplierParty?: Prisma.InputJsonValue): SupplierSnapshot {
  return { ...draft, schemaVersion: 1, businessOwnerId: actorId, sourceProofs: sources.filter(row => draft.lines.some(line => line.orderLineId === row.orderLineId)), basedOnRevisionId, changeReason,
    ...(supplierParty ? { supplierParty } : {}) };
}
/** The approved pointer, immutable contents and exact current source authority
 * are checked together. Actual old-basis fulfillment may continue while a
 * supplier amendment is pending; new commercial promises may not. */
export async function requireApprovedSupplierBasis(tx: SupplierContractTx, kind: SupplierContractKind, id: string,
  current: Awaited<ReturnType<typeof authorizeSupplierContract>>, approvedRevisionId: unknown, actor: TokenPayload, newPromise = false) {
  if (typeof approvedRevisionId !== 'string' || !approvedRevisionId || current.contract.approvedCommitmentRevisionId !== approvedRevisionId)
    return supplierFail('APPROVED_REVISION_CHANGED', '请核对当前准确批准版本。', 409);
  if (newPromise && current.latest?.id !== approvedRevisionId) return supplierFail('COMMITMENT_AMENDMENT_UNAPPROVED', '商业变更尚未获批，请先处理新版本，不能据未批提案对外发出或确认。', 409);
  if (['Cancelled', 'Closed'].includes(current.contract.status)) return supplierFail('CONTRACT_INACTIVE', '合同已取消或关闭。', 409);
  const revision = await tx.supplierCommitmentRevision.findUnique({ where: { id: approvedRevisionId } });
  if (!revision || revision.status !== 'approved' || (kind === 'purchase' ? revision.purchaseOrderId : revision.outsourcingOrderId) !== id
    || supplierFingerprint(revision.snapshot) !== revision.contentFingerprint) return supplierFail('SOURCE_PROOF_UNKNOWN', '准确已批合同依据无法核实。', 409);
  const snapshot = supplierSnapshot(revision.snapshot, kind);
  const fresh = await authorizeSupplierSources(tx, actor, snapshot.lines.map(line => line.orderLineId), { mode: 'write', formal: true });
  assertSupplierSourceProof(snapshot, fresh.sources);
  return { revision, snapshot, actor: fresh.actor };
}
export function supplierEvidence(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30) return supplierFail('INVALID_EVIDENCE', '请填写至多30条实际交接或线下反馈证据。');
  return value.map(entry => supplierText(entry, '真实证据', 2000));
}
export function createSupplierCommitmentService(prisma: PrismaClient) {
  const transaction = <T>(work: (tx: SupplierContractTx) => Promise<T>) => prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
  async function create(kind: SupplierContractKind, input: unknown, actor: TokenPayload) {
    const row = supplierObject(input), draft = normalizeSupplierContractDraft(kind, row);
    const contractNumber = supplierOptionalText(row.contractNumber, '合同内部编号', 150);
    if (kind === 'processing' && !contractNumber) return supplierFail('CONTRACT_NUMBER_REQUIRED', '请填写加工合同唯一内部编号。');
    const command: SupplierCommand = { actor, requestKey: supplierText(row.requestKey, '原请求标识', 150), operation: 'create_draft', kind, targetId: null, input: { draft, contractNumber: contractNumber ?? null } };
    return transaction(async tx => {
      const started = await beginSupplierCommand(tx, command);
      let auth = await authorizeSupplierSources(tx, actor, draft.lines.map(line => line.orderLineId), { mode: 'write', lock: true, businessGates: false });
      const replay = await replaySupplierCommand(tx, command, started.fingerprint); if (replay) return replay;
      auth = await authorizeSupplierSources(tx, actor, draft.lines.map(line => line.orderLineId), { mode: 'write' });
      const party = await validateSupplierAndLocation(tx, draft);
      await assertSupplierLineResponsibilities(tx, draft, auth.sources);
      const id = `${kind === 'purchase' ? 'PO' : 'OSO'}_${randomUUID()}`;
      const number = contractNumber ?? await nextBusinessNumber(tx, 'PO', undefined, { occupied: async poNumber => Boolean(await tx.purchaseOrder.findFirst({ where: { poNumber }, select: { id: true } })) });
      const normalized = assignSupplierLineIds(draft);
      const snapshot = snapshotFor(await reconcileSupplierDemandPlan(tx, kind, id, normalized, auth.actor.userId, { apply: true }), auth.sources, auth.actor.userId, null, null, party);
      await projectSupplierContract(tx, kind, id, snapshot, { createNumber: number });
      const revision = await writeSupplierRevision(tx, kind, id, 1, snapshot);
      await supplierAudit(tx, auth.actor.userId, 'create_supplier_contract', kind, id, null, { snapshot, revisionId: revision.id });
      return persistSupplierCommand(tx, command, started.fingerprint, supplierResponse(await supplierContractView(tx, kind, id), command, started.receiptId, id, { revisionId: revision.id }));
    });
  }
  async function get(kind: SupplierContractKind, id: string, actor: TokenPayload) {
    return transaction(async tx => { await authorizeSupplierContract(tx, kind, id, actor); return supplierContractView(tx, kind, id); });
  }
  async function list(kind: SupplierContractKind, actor: TokenPayload, options: { cursor?: string; limit?: number } = {}) {
    return transaction(async tx => {
      await freshSupplierActor(tx, actor, 'read');
      const limit = Math.min(Math.max(options.limit ?? 30, 1), 100), items: Prisma.InputJsonValue[] = [];
      let cursor = options.cursor, exhausted = false, scanned = 0;
      while (items.length < limit && scanned < 500) {
        const args = { where: { deletedAt: null, commitmentRevisions: { some: {} } }, orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
          select: { id: true }, take: Math.min(50, 500 - scanned), ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) };
        const candidates = kind === 'purchase' ? await tx.purchaseOrder.findMany(args) : await tx.outsourcingOrder.findMany(args);
        if (!candidates.length) { exhausted = true; break; }
        for (const row of candidates) {
          cursor = row.id; scanned++;
          try { await authorizeSupplierContract(tx, kind, row.id, actor, { mode: 'read', businessGates: false }); }
          catch (error) { if (error instanceof SupplierContractError && ['NOT_FOUND', 'FORBIDDEN'].includes(error.code)) continue; throw error; }
          items.push(await supplierContractView(tx, kind, row.id));
          if (items.length === limit) break;
        }
        if (candidates.length < Math.min(50, 500 - scanned + candidates.length) && items.length < limit) { exhausted = true; break; }
      }
      return { items, nextCursor: exhausted ? null : cursor ?? null, hasMore: !exhausted };
    });
  }
  async function editDraft(kind: SupplierContractKind, id: string, input: unknown, actor: TokenPayload, mode: 'save' | 'amend' | 'merge') {
    const row = supplierObject(input), incoming = normalizeSupplierContractDraft(kind, row);
    if (!Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 1) return supplierFail('REVISION_REQUIRED', '请明确当前单据版本。');
    const reason = mode === 'amend' ? supplierText(row.reason, '承诺变更原因', 2000) : null;
    const command: SupplierCommand = { actor, requestKey: supplierText(row.requestKey, '原请求标识', 150), operation: `${mode}_draft`, kind, targetId: id,
      input: { draft: incoming, expectedRevision: row.expectedRevision, basedOnRevisionId: row.basedOnRevisionId ?? null, reason } };
    return transaction(async tx => {
      const started = await beginSupplierCommand(tx, command);
      const current = await authorizeSupplierContract(tx, kind, id, actor, { mode: 'write', lock: true, businessGates: false, extraLineIds: incoming.lines.map(line => line.orderLineId) });
      const replay = await replaySupplierCommand(tx, command, started.fingerprint); if (replay) return replay;
      if (await tx.supplierCommitmentRevision.findFirst({ where: { ...supplierRevisionWhere(kind, id), status: 'pending' } }))
        return supplierFail('CONTRACT_APPROVAL_PENDING', '供应商承诺审批处理中，整单商业内容已冻结。', 409);
      if (!current.latest || !current.snapshot) return supplierFail('SOURCE_PROOF_UNKNOWN', '历史单据须明确建立准确来源的新承诺，不能推定旧状态为已审批。', 409);
      if (current.latest.revision !== row.expectedRevision) return supplierFail('REVISION_CONFLICT', '单据版本已变化，请刷新核对。', 409);
      if (current.contract.status === 'Cancelled' || current.contract.status === 'Closed') return supplierFail('CONTRACT_INACTIVE', '单据已取消或关闭。', 409);
      if (mode !== 'amend' && current.contract.approvedCommitmentRevisionId) return supplierFail('COMMITMENT_CHANGE_REQUIRED', '已批承诺不能通用编辑或合单，请发起商业变更并重新审批。', 409);
      if (mode === 'amend' && (!current.contract.approvedCommitmentRevisionId || row.basedOnRevisionId !== current.contract.approvedCommitmentRevisionId))
        return supplierFail('APPROVED_REVISION_CHANGED', '请基于当前准确已批版本发起变更。', 409);
      let nextDraft = incoming;
      if (mode === 'merge') {
        assertSupplierContractsCompatible(current.snapshot, incoming);
        nextDraft = normalizeSupplierContractDraft(kind, { ...current.snapshot, lines: [...current.snapshot.lines, ...incoming.lines] });
      }
      const identities = { ...current.contract, lines: [...current.contract.lines, ...current.snapshot.lines.map(line => ({ id: line.id!, orderLineId: line.orderLineId, retiredAt: null }))] };
      const normalized = assignSupplierLineIds(nextDraft, identities);
      const fresh = await authorizeSupplierSources(tx, actor, normalized.lines.map(line => line.orderLineId), { mode: 'write', formal: mode === 'amend' });
      const party = await validateSupplierAndLocation(tx, normalized);
      await assertSupplierLineResponsibilities(tx, normalized, fresh.sources);
      const demandPlan = await reconcileSupplierDemandPlan(tx, kind, id, normalized, fresh.actor.userId, { apply: !current.contract.approvedCommitmentRevisionId });
      const snapshot = snapshotFor(demandPlan, fresh.sources, fresh.actor.userId, mode === 'amend' ? current.contract.approvedCommitmentRevisionId : null, reason, party);
      if (!current.contract.approvedCommitmentRevisionId) await projectSupplierContract(tx, kind, id, snapshot, {});
      const revision = await writeSupplierRevision(tx, kind, id, current.latest.revision + 1, snapshot);
      await supplierAudit(tx, fresh.actor.userId, `${mode}_supplier_contract_draft`, kind, id, { snapshot: current.latest.snapshot, revisionId: current.latest.id }, { snapshot, revisionId: revision.id });
      return persistSupplierCommand(tx, command, started.fingerprint, supplierResponse(await supplierContractView(tx, kind, id), command, started.receiptId, id, { revisionId: revision.id }));
    });
  }
  const saveDraft = (kind: SupplierContractKind, id: string, input: unknown, actor: TokenPayload) => editDraft(kind, id, input, actor, 'save');
  const amend = (kind: SupplierContractKind, id: string, input: unknown, actor: TokenPayload) => editDraft(kind, id, input, actor, 'amend');
  const merge = (kind: SupplierContractKind, id: string, input: unknown, actor: TokenPayload) => editDraft(kind, id, input, actor, 'merge');
  async function submit(kind: SupplierContractKind, id: string, input: unknown, actor: TokenPayload) {
    const row = supplierObject(input), command: SupplierCommand = { actor, requestKey: supplierText(row.requestKey, '原请求标识', 150), operation: 'submit_commitment', kind, targetId: id,
      input: { expectedRevision: row.expectedRevision } };
    return transaction(async tx => {
      const started = await beginSupplierCommand(tx, command);
      const current = await authorizeSupplierContract(tx, kind, id, actor, { mode: 'write', lock: true, businessGates: false });
      const replay = await replaySupplierCommand(tx, command, started.fingerprint); if (replay) return replay;
      const revision = current.latest, snapshot = current.snapshot;
      if (!revision || !snapshot || revision.status !== 'draft' || revision.revision !== row.expectedRevision) return supplierFail('REVISION_CONFLICT', '仅当前准确草稿可提交，请刷新核对版本。', 409);
      if (supplierFingerprint(revision.snapshot) !== revision.contentFingerprint) return supplierFail('APPROVAL_CONTENT_CHANGED', '草稿依据无法准确核实，请重新保存。', 409);
      assertSupplierCommonTermsReady(snapshot);
      if (snapshot.lines.some(line => !line.requestedDeliveryDate)) return supplierFail('LINE_DATE_REQUIRED', '提交前须逐行明确要求交付日期。');
      const fresh = await authorizeSupplierSources(tx, actor, snapshot.lines.map(line => line.orderLineId), { mode: 'write', formal: true });
      assertSupplierSourceProof(snapshot, fresh.sources);
      await assertSupplierLineResponsibilities(tx, snapshot, fresh.sources, true);
      await reconcileSupplierDemandPlan(tx, kind, id, snapshot, snapshot.businessOwnerId, { frozen: true });
      await validateSupplierAndLocation(tx, snapshot);
      const authority = await resolveSupplierApprovers(tx, kind, fresh.sources), approvalId = `SCAP_${randomUUID()}`;
      const payload = { schemaVersion: 1, contractKind: kind, contractId: id, revisionId: revision.id, revision: revision.revision,
        contentFingerprint: revision.contentFingerprint, documentSnapshot: snapshot, sourceIds: [...new Set(snapshot.sourceProofs.map(source => source.orderId))].sort(),
        sourceOrderLineIds: snapshot.lines.map(line => line.orderLineId), approvalConfigVersions: authority.configVersions };
      const approval = await tx.approvalRequest.create({ data: { id: approvalId, requesterId: fresh.actor.userId, reviewerId: authority.eligibleReviewerIds[0],
        actionType: SUPPLIER_COMMITMENT_APPROVAL_ACTION, targetType: SUPPLIER_COMMITMENT_APPROVAL_TARGET, targetId: revision.id,
        status: 'pending', risk: 'high', payload: supplierJson(payload), eligibleReviewerIds: authority.eligibleReviewerIds, reviewerResolverRoute: 'SUPPLIER_EXPLICIT_AUTHORITY' } });
      await tx.supplierCommitmentRevision.update({ where: { id: revision.id }, data: { status: 'pending', approvalRequestId: approvalId, submittedAt: BigInt(Date.now()) } });
      await supplierAudit(tx, fresh.actor.userId, 'submit_supplier_commitment', kind, id, { status: 'draft', revisionId: revision.id }, { status: 'pending', approvalId, snapshot });
      return persistSupplierCommand(tx, command, started.fingerprint, supplierResponse({ ...approval, reviewContentVersion: approvalReviewContentVersion(approval) }, command, started.receiptId, id, { revisionId: revision.id, approvalId }));
    });
  }
  async function recordOfflineSend(kind: SupplierContractKind, id: string, input: unknown, actor: TokenPayload) {
    const row = supplierObject(input), data = { approvedRevisionId: supplierText(row.approvedRevisionId, '准确已批版本', 150), sentAt: supplierDate(row.sentAt, '实际线下发出日期'), evidence: supplierEvidence(row.evidence) };
    const command: SupplierCommand = { actor, requestKey: supplierText(row.requestKey, '原请求标识', 150), operation: 'record_offline_send', kind, targetId: id, input: data };
    return transaction(async tx => {
      const started = await beginSupplierCommand(tx, command), current = await authorizeSupplierContract(tx, kind, id, actor, { mode: 'write', lock: true, businessGates: false });
      const replay = await replaySupplierCommand(tx, command, started.fingerprint); if (replay) return replay;
      const basis = await requireApprovedSupplierBasis(tx, kind, id, current, data.approvedRevisionId, actor, true);
      if (kind === 'purchase') await tx.purchaseOrder.update({ where: { id }, data: { status: current.contract.status === 'Draft' ? 'Sent' : current.contract.status, updatedAt: BigInt(Date.now()) } });
      else await tx.outsourcingOrder.update({ where: { id }, data: { status: current.contract.status === 'Draft' ? 'Sent' : current.contract.status, updatedAt: BigInt(Date.now()) } });
      const item = { ...data, recordedBy: basis.actor.userId, recordedAt: Date.now().toString(), offlineOnly: true };
      await supplierAudit(tx, basis.actor.userId, 'record_supplier_contract_offline_send', kind, id, null, item);
      return persistSupplierCommand(tx, command, started.fingerprint, supplierResponse(item, command, started.receiptId, id, { revisionId: basis.revision.id }));
    });
  }
  async function recordSupplierFeedback(kind: SupplierContractKind, id: string, input: unknown, actor: TokenPayload) {
    const row = supplierObject(input);
    if (!Array.isArray(row.lines) || !row.lines.length || row.lines.length > 100) return supplierFail('LINES_REQUIRED', '请逐行明确实际供应商反馈。');
    const lines = row.lines.map(raw => { const line = supplierObject(raw); return { lineId: supplierText(line.lineId, '准确合同条目', 150), supplierCommittedDeliveryDate: supplierDate(line.supplierCommittedDeliveryDate, '实际供应商承诺日期') }; });
    if (new Set(lines.map(line => line.lineId)).size !== lines.length) return supplierFail('DUPLICATE_LINE', '同一次反馈不能重复登记相同行。');
    const data = { approvedRevisionId: supplierText(row.approvedRevisionId, '准确已批版本', 150), feedbackAt: supplierDate(row.feedbackAt, '实际反馈日期'), lines, evidence: supplierEvidence(row.evidence) };
    const command: SupplierCommand = { actor, requestKey: supplierText(row.requestKey, '原请求标识', 150), operation: 'record_supplier_feedback', kind, targetId: id, input: data };
    return transaction(async tx => {
      const started = await beginSupplierCommand(tx, command), current = await authorizeSupplierContract(tx, kind, id, actor, { mode: 'write', lock: true, businessGates: false });
      const replay = await replaySupplierCommand(tx, command, started.fingerprint); if (replay) return replay;
      const basis = await requireApprovedSupplierBasis(tx, kind, id, current, data.approvedRevisionId, actor, true);
      const sends = await tx.supplierContractCommandReceipt.findMany({ where: { contractKind: kind, contractId: id, operation: 'record_offline_send' } });
      if (!sends.some(send => supplierObject(send.requestSnapshot).approvedRevisionId === basis.revision.id)) return supplierFail('OFFLINE_SEND_REQUIRED', '请先记录当前批准合同的实际线下发出，再登记供应商反馈。', 409);
      if (lines.some(line => !basis.snapshot.lines.some(old => old.id === line.lineId))) return supplierFail('LINE_SOURCE_MISMATCH', '反馈行不属于当前准确已批版本。', 409);
      const changed = lines.some(line => basis.snapshot.lines.find(old => old.id === line.lineId)?.requestedDeliveryDate !== line.supplierCommittedDeliveryDate);
      let proposedRevisionId: string | null = null;
      if (changed) {
        const snapshot: SupplierSnapshot = { ...basis.snapshot, businessOwnerId: basis.actor.userId, basedOnRevisionId: basis.revision.id,
          changeReason: `供应商于 ${data.feedbackAt} 线下反馈交期变更`, supplierFeedbackReceiptId: started.receiptId,
          lines: basis.snapshot.lines.map(line => ({ ...line, requestedDeliveryDate: lines.find(entry => entry.lineId === line.id)?.supplierCommittedDeliveryDate ?? line.requestedDeliveryDate })) };
        proposedRevisionId = (await writeSupplierRevision(tx, kind, id, current.latest!.revision + 1, snapshot)).id;
      } else {
        for (const line of lines) {
          const args = { where: { id: line.lineId }, data: { supplierCommittedDeliveryDate: line.supplierCommittedDeliveryDate } };
          if (kind === 'purchase') await tx.purchaseLine.update(args); else await tx.outsourcingLine.update(args);
        }
        const allLines = kind === 'purchase' ? await tx.purchaseLine.findMany({ where: { purchaseOrderId: id, retiredAt: null } }) : await tx.outsourcingLine.findMany({ where: { outsourcingOrderId: id, retiredAt: null } });
        if (basis.snapshot.lines.every(line => allLines.some(actual => actual.id === line.id && actual.supplierCommittedDeliveryDate === line.requestedDeliveryDate))) {
          if (kind === 'purchase') await tx.purchaseOrder.update({ where: { id }, data: { status: 'Confirmed', updatedAt: BigInt(Date.now()) } });
          else await tx.outsourcingOrder.update({ where: { id }, data: { status: 'Confirmed', updatedAt: BigInt(Date.now()) } });
        }
      }
      const item = { ...data, requiresAmendment: changed, proposedRevisionId, recordedBy: basis.actor.userId, recordedAt: Date.now().toString(), offlineOnly: true };
      await supplierAudit(tx, basis.actor.userId, 'record_supplier_contract_feedback', kind, id, { approvedRevisionId: basis.revision.id, requestedDates: basis.snapshot.lines.map(line => ({ id: line.id, requestedDeliveryDate: line.requestedDeliveryDate })) }, item);
      return persistSupplierCommand(tx, command, started.fingerprint, supplierResponse(item, command, started.receiptId, id, { revisionId: proposedRevisionId ?? basis.revision.id }));
    });
  }
  return { create, get, list, saveDraft, amend, merge, submit, recordOfflineSend, recordSupplierFeedback };
}

export async function decideSupplierCommitmentApproval(params: { prisma: PrismaClient; approvalId: string; actor: TokenPayload; decision: 'approved' | 'rejected';
  note?: string; reviewContentVersion: string; confirmedReviewedContent?: boolean; requestKey?: string }) {
  if (params.decision !== 'approved' && params.decision !== 'rejected') return supplierFail('INVALID_INPUT', '供应商承诺只支持通过或驳回，修改须由经办重提。');
  if (params.decision === 'approved' && params.confirmedReviewedContent !== true) return supplierFail('REVIEW_CONFIRMATION_REQUIRED', '批准前请明确已核对当前冻结承诺。');
  if (params.decision === 'rejected' && !params.note?.trim()) return supplierFail('REASON_REQUIRED', '请明确驳回原因与需要修改内容。');
  const requestKey = params.requestKey ?? `supplier-decision:${supplierFingerprint({ id: params.approvalId, decision: params.decision, version: params.reviewContentVersion })}`;
  return params.prisma.$transaction(async tx => {
    await freshSupplierActor(tx, params.actor, 'approve');
    const initial = await tx.approvalRequest.findUnique({ where: { id: params.approvalId } });
    if (!initial || initial.actionType !== SUPPLIER_COMMITMENT_APPROVAL_ACTION || initial.targetType !== SUPPLIER_COMMITMENT_APPROVAL_TARGET || !initial.targetId)
      return supplierFail('NOT_FOUND', '准确供应商承诺审批不存在。', 404);
    const initialRevision = await tx.supplierCommitmentRevision.findUnique({ where: { id: initial.targetId } });
    if (!initialRevision) return supplierFail('NOT_FOUND', '准确承诺版本不存在。', 404);
    const kind: SupplierContractKind = initialRevision.purchaseOrderId ? 'purchase' : 'processing', id = initialRevision.purchaseOrderId ?? initialRevision.outsourcingOrderId!;
    const command: SupplierCommand = { actor: params.actor, requestKey, operation: 'decide_commitment', kind, targetId: id, mode: 'approve', input: {
      approvalId: params.approvalId, decision: params.decision, note: params.note?.trim() ?? null, reviewContentVersion: params.reviewContentVersion, confirmedReviewedContent: params.confirmedReviewedContent === true } };
    const started = await beginSupplierCommand(tx, command);
    const current = await authorizeSupplierContract(tx, kind, id, params.actor, { mode: 'approve', lock: true, businessGates: false });
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SupplierCommitmentRevision" WHERE "id" = ${initialRevision.id} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ApprovalRequest" WHERE "id" = ${initial.id} FOR UPDATE`);
    const revision = await tx.supplierCommitmentRevision.findUnique({ where: { id: initialRevision.id } });
    const approval = await tx.approvalRequest.findUnique({ where: { id: initial.id } });
    if (!revision || !approval) return supplierFail('NOT_FOUND', '审批依据已失效。', 404);
    const snapshot = supplierSnapshot(revision.snapshot, kind), authority = await resolveSupplierApprovers(tx, kind, snapshot.sourceProofs);
    const candidates = Array.isArray(approval.eligibleReviewerIds) ? approval.eligibleReviewerIds : [];
    if (!candidates.includes(started.actor.userId) || !authority.eligibleReviewerIds.includes(started.actor.userId)) return supplierFail('FORBIDDEN', '当前账号不具备本次供应商承诺的明确审批资格。', 403);
    await freshSupplierActor(tx, params.actor, 'approve');
    const replay = await replaySupplierCommand(tx, command, started.fingerprint); if (replay) return replay;
    if (approval.status !== 'pending' || revision.status !== 'pending' || revision.approvalRequestId !== approval.id || current.latest?.id !== revision.id)
      return supplierFail('APPROVAL_NOT_PENDING', '本次审批已处理或版本已变化，请刷新核对。', 409);
    if (params.reviewContentVersion !== approvalReviewContentVersion(approval) || supplierFingerprint(revision.snapshot) !== revision.contentFingerprint
      || supplierObject(approval.payload).contentFingerprint !== revision.contentFingerprint || supplierObject(approval.payload).revisionId !== revision.id
      || supplierObject(approval.payload).contractId !== id || supplierObject(approval.payload).contractKind !== kind
      || supplierFingerprint(supplierObject(approval.payload).documentSnapshot) !== revision.contentFingerprint)
      return supplierFail('APPROVAL_CONTENT_CHANGED', '冻结审批依据已变化，请重新加载并核对。', 409);
    const fresh = await authorizeSupplierSources(tx, params.actor, snapshot.lines.map(line => line.orderLineId), { mode: 'approve', formal: true });
    assertSupplierSourceProof(snapshot, fresh.sources);
    await assertSupplierLineResponsibilities(tx, snapshot, fresh.sources, true);
    await reconcileSupplierDemandPlan(tx, kind, id, snapshot, snapshot.businessOwnerId, { frozen: true });
    await validateSupplierAndLocation(tx, snapshot);
    if (params.decision === 'approved') {
      await reconcileSupplierDemandPlan(tx, kind, id, snapshot, snapshot.businessOwnerId, { frozen: true, apply: true });
      if (current.contract.approvedCommitmentRevisionId) await tx.supplierCommitmentRevision.update({ where: { id: current.contract.approvedCommitmentRevisionId }, data: { status: 'superseded' } });
      await projectSupplierContract(tx, kind, id, snapshot, { approvedRevisionId: revision.id });
      if (snapshot.supplierFeedbackReceiptId) {
        const feedback = await tx.supplierContractCommandReceipt.findUnique({ where: { id: snapshot.supplierFeedbackReceiptId } });
        if (!feedback || feedback.operation !== 'record_supplier_feedback' || feedback.contractId !== id || feedback.contractKind !== kind) return supplierFail('SOURCE_PROOF_UNKNOWN', '真实供应商反馈原回执无法核实。', 409);
        const rows = supplierObject(feedback.requestSnapshot).lines;
        if (!Array.isArray(rows)) return supplierFail('SOURCE_PROOF_UNKNOWN', '供应商原反馈缺少准确条目。', 409);
        for (const raw of rows) {
          const line = supplierObject(raw), approvedLine = snapshot.lines.find(item => item.id === line.lineId);
          if (!approvedLine || approvedLine.requestedDeliveryDate !== line.supplierCommittedDeliveryDate) return supplierFail('SOURCE_PROOF_CHANGED', '反馈日期与本次批准提案不一致。', 409);
          const args = { where: { id: approvedLine.id! }, data: { supplierCommittedDeliveryDate: approvedLine.requestedDeliveryDate } };
          if (kind === 'purchase') await tx.purchaseLine.update(args); else await tx.outsourcingLine.update(args);
        }
      }
    }
    const now = BigInt(Date.now());
    await tx.supplierCommitmentRevision.update({ where: { id: revision.id }, data: { status: params.decision, decidedAt: now } });
    const decided = await tx.approvalRequest.update({ where: { id: approval.id }, data: { status: params.decision, reviewerId: fresh.actor.userId,
      decidedAt: new Date(Number(now)), decisionNote: params.note?.trim() ?? null } });
    await supplierAudit(tx, fresh.actor.userId, `${params.decision}_supplier_commitment`, kind, id,
      { approvalId: approval.id, revisionId: revision.id, status: 'pending', previousApprovedRevisionId: current.contract.approvedCommitmentRevisionId },
      { approvalId: approval.id, revisionId: revision.id, status: params.decision, snapshot });
    return persistSupplierCommand(tx, command, started.fingerprint, supplierResponse({ ...decided, businessSyncStatus: params.decision === 'approved' ? 'completed' : 'not_applicable' },
      command, started.receiptId, id, { revisionId: revision.id, approvalId: approval.id }));
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

/** Shared approval-center source adapter. Unknown targets never use a permissive fallback. */
export async function assertSupplierCommitmentApprovalRead(tx: SupplierContractTx, approval: { actionType: string; targetType: string; targetId: string | null; payload: unknown }, actor: TokenPayload): Promise<void> {
  if (approval.actionType !== SUPPLIER_COMMITMENT_APPROVAL_ACTION || approval.targetType !== SUPPLIER_COMMITMENT_APPROVAL_TARGET || !approval.targetId)
    return supplierFail('NOT_FOUND', '准确供应商承诺审批不存在。', 404);
  const revision = await tx.supplierCommitmentRevision.findUnique({ where: { id: approval.targetId } });
  if (!revision) return supplierFail('NOT_FOUND', '准确承诺版本不存在。', 404);
  const kind = revision.purchaseOrderId ? 'purchase' : 'processing', id = revision.purchaseOrderId ?? revision.outsourcingOrderId!;
  const payload = supplierObject(approval.payload), snapshot = supplierSnapshot(revision.snapshot, kind);
  if (payload.revisionId !== revision.id || payload.contractId !== id || payload.contractKind !== kind
    || supplierFingerprint(revision.snapshot) !== revision.contentFingerprint || payload.contentFingerprint !== revision.contentFingerprint
    || supplierFingerprint(payload.documentSnapshot) !== revision.contentFingerprint)
    return supplierFail('SOURCE_PROOF_UNKNOWN', '审批目标与准确供应商单据不一致。', 409);
  const frozenIds = [...new Set([...snapshot.lines.map(line => line.orderLineId), ...snapshot.sourceProofs.map(source => source.orderLineId)])];
  await authorizeSupplierContract(tx, kind, id, actor, { mode: 'read', extraLineIds: frozenIds, businessGates: false });
}
