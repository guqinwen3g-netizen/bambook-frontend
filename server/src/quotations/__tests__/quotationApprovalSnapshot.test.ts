import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ACTION_LINE_APPROVE, ACTION_TOTAL_APPROVE, buildQuotationApprovalSnapshot,
  buildQuotationSnapshot, canonicalQuotationJson, quotationApprovalSourceState, readQuotationApprovalState,
  assertQuotationApprovalConsumption } from '../quotationApprovalSnapshot';
const quote = () => ({ id: 'Q1', quotationNumber: 'QT-1', version: 3, currency: 'USD', totalAmount: '100.0100',
  customerRelationId: 'C1', customerName: 'Actual customer', issueDate: '2026-10-01', exchangeRate: '7.0001',
  notes: null,
  lines: [{ id: 'L1', lineNumber: 1, description: 'Actual cloth', quantity: '10', unit: 'M', unitPrice: '10.001', amount: '100.01' }] });
function fact(q = quote(), action = ACTION_LINE_APPROVE, status = 'approved') {
  const targetId = action === ACTION_LINE_APPROVE ? 'L1' : 'Q1';
  return { id: 'A-' + action, actionType: action, targetType: action === ACTION_LINE_APPROVE ? 'QuotationLine' : 'Quotation',
    targetId, status, reviewerId: 'R1', decidedAt: new Date('2026-10-02T00:00:00.000Z'),
    payload: { quotationId: q.id, ...buildQuotationApprovalSnapshot(q, action, targetId) } };
}
function db(history: any[], validAudit = true) {
  return { approvalRequest: { findMany: vi.fn().mockResolvedValue(history) }, auditLog: { findMany: vi.fn().mockImplementation(async () => validAudit
    ? history.map(row => ({ actorId: row.reviewerId, action:row.status==='approved'?'approve_business_request':'reject_business_request', detail: { source:'api:approvals', decisionActorAuthority:{userId:row.reviewerId,roles:[],roleIds:[],authorizationLoaded:true}, approvalDecisionFact: { schemaVersion: 1, status: row.status,
      actionType: row.actionType, targetType: row.targetType, targetId: row.targetId, decisionActorId: row.reviewerId,
      contentFingerprint: row.payload.contentFingerprint, decidedAt: row.decidedAt.toISOString() } } })) : []) } };
}
describe('quotation approval source truth', () => {
  it('exact decimal strings and complete native commercial source are stable', () => {
    const q = quote(), approval = fact(q);
    expect(approval.payload.quotationSnapshot.schemaVersion).toBe(2);
    expect(approval.payload.quotationSnapshot).toHaveProperty('notes', null);
    expect(approval.payload.quotationSnapshot.lines[0].amount).toBe('100.01');
    expect(quotationApprovalSourceState(approval, { ...q, updatedAt: 1, status: 'Sent', sentAt: 9 })).toBe('current');
    expect(quotationApprovalSourceState(approval, { ...q, totalAmount: '100.010000' })).toBe('current');
  });
  it.each(['version', 'currency', 'customerRelationId', 'exchangeRate', 'deliveryTerms', 'developmentCaseId', 'notes'])(
    '%s is an approval boundary even when the line IDs survive', field => {
      const q = quote(), approval = fact(q);
      expect(quotationApprovalSourceState(approval, { ...q, [field]: field === 'version' ? 4 : 'changed' })).toBe('stale');
      expect(approval.payload.quotationSnapshot.currency).toBe('USD');
    });
  it('quantity/unit/price and stable line identity cannot inherit another snapshot', () => {
    const q = quote(), approval = fact(q);
    for (const changed of [{ quantity: '11' }, { unit: 'YD' }, { unitPrice: '9.99' }, { id: 'L2' }])
      expect(quotationApprovalSourceState(approval, { ...q, lines: [{ ...q.lines[0], ...changed }] })).toBe('stale');
  });
  it('missing/tampered historical snapshots are explicitly unverified', () => {
    const q = quote(), approval = fact(q);
    expect(quotationApprovalSourceState({ ...approval, payload: { quotationId: q.id } }, q)).toBe('legacy_unverified');
    expect(quotationApprovalSourceState({ ...approval, payload: { ...approval.payload, quotationSnapshot: { ...approval.payload.quotationSnapshot, schemaVersion: 1 } } }, q)).toBe('legacy_unverified');
    const noSourceNotes = { ...q }; delete (noSourceNotes as any).notes;
    expect(() => buildQuotationApprovalSnapshot(noSourceNotes, ACTION_LINE_APPROVE, 'L1')).toThrow();
    expect(quotationApprovalSourceState({ ...approval, payload: { ...approval.payload, contentFingerprint: '0'.repeat(64) } }, q)).toBe('legacy_unverified');
  });
  it('no requested whole-version approval blocks issuance', async () => {
    await expect(assertQuotationApprovalConsumption(db([]), quote())).rejects.toMatchObject({ code: 'QUOTATION_APPROVAL_UNVERIFIED' });
  });
  it('a current line approval never replaces a whole-version decision', async () => {
    const q = quote(), row = fact(q);
    await expect(assertQuotationApprovalConsumption(db([row]), q)).rejects.toMatchObject({ code: 'QUOTATION_APPROVAL_STALE' });
    await expect(assertQuotationApprovalConsumption(db([row], false), q)).rejects.toMatchObject({ code: 'QUOTATION_APPROVAL_UNVERIFIED' });
  });

  it('accepts a revised final source only when the decision and amendment audits bind the current version', async () => {
    const original = quote(), approval = fact(original, ACTION_TOTAL_APPROVE);
    const current = { ...original, version: 4, notes: 'signed final note' };
    const finalSnapshot = buildQuotationSnapshot(current);
    const finalHash = createHash('sha256').update(canonicalQuotationJson(finalSnapshot)).digest('hex');
    const amendmentId = 'amend-1', decisionId = 'decision-1';
    const authority = { userId: 'R1', roles: ['manager'], roleIds: ['manager'], authorizationLoaded: true };
    const decisionAudit = { id: decisionId, actorId: 'R1', action: 'approve_business_request', targetType: 'ApprovalRequest', targetId: approval.id,
      detail: { source: 'api:approvals', decisionActorAuthority: authority, quotationAmendmentAuditId: amendmentId,
        approvalDecisionFact: { schemaVersion: 1, status: 'approved', actionType: approval.actionType,
          targetType: approval.targetType, targetId: approval.targetId, contentFingerprint: approval.payload.contentFingerprint,
          decisionActorId: 'R1', decidedAt: approval.decidedAt.toISOString(), finalContentVersion: finalHash,
          finalQuotationFingerprint: finalHash, finalQuotationVersion: 4, quotationAmendmentAuditId: amendmentId } } };
    const amendmentAudit = { id: amendmentId, actorId: 'R1', action: 'quotation_approval_amended', targetType: 'ApprovalRequest', targetId: approval.id,
      detail: { schemaVersion: 1, approvalId: approval.id, quotationId: current.id, requesterId: approval.requesterId,
        decisionActorId: 'R1', sourceVersion: original.version, sourceFingerprint: approval.payload.contentFingerprint,
        finalVersion: 4, finalContentVersion: finalHash, finalFingerprint: finalHash, finalSnapshot } };
    const revisedApproval = { ...approval, status: 'approved', decidedAt: approval.decidedAt };
    const dbWith = (extra: any[] = []) => ({
      approvalRequest: { findMany: vi.fn().mockResolvedValue([revisedApproval]) },
      auditLog: { findMany: vi.fn().mockResolvedValue([decisionAudit, amendmentAudit, ...extra]) },
    });
    expect(await readQuotationApprovalState(dbWith(), revisedApproval, current)).toBe('approved');
    await expect(assertQuotationApprovalConsumption(dbWith(), current)).resolves.toBeUndefined();
    const changed = { ...current, notes: 'changed after signature' };
    expect(await readQuotationApprovalState(dbWith(), revisedApproval, changed)).toBe('stale');
    const duplicate = { ...decisionAudit, id: 'decision-2' };
    expect(await readQuotationApprovalState(dbWith([duplicate]), revisedApproval, current)).toBe('stale');
  });
  it.each(['pending', 'rejected'])('current total %s is not erased by all approved lines', async status => {
    const q = quote(), rows = [fact(q, ACTION_TOTAL_APPROVE, status), fact(q)];
    await expect(assertQuotationApprovalConsumption(db(rows), q)).rejects.toMatchObject({
      code: status === 'pending' ? 'QUOTATION_APPROVAL_PENDING' : 'QUOTATION_APPROVAL_REJECTED',
    });
  });
});
