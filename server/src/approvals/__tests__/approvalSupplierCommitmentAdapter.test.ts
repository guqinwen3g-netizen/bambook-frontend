import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SupplierContractError } from '../../procurement/supplierContractPolicy';
import { assertSupplierApprovalCenterRead, readSupplierApprovalReviewDetail, readSupplierApprovalSyncStatus } from '../approvalSupplierCommitmentAdapter';
import { approvalReviewContentVersion } from '../approvalReviewContent';

const gates = vi.hoisted(() => ({ read: vi.fn(), contract: vi.fn(), actor: vi.fn(), sources: vi.fn(), authority: vi.fn(), sourceProof: vi.fn() }));
vi.mock('../../procurement/supplierCommitmentService', () => ({ SUPPLIER_COMMITMENT_APPROVAL_ACTION: 'supplier:commitment',
  assertSupplierCommitmentApprovalRead: gates.read, authorizeSupplierContract: gates.contract }));
vi.mock('../../procurement/supplierContractAccess', () => ({ freshSupplierActor: gates.actor, authorizeSupplierSources: gates.sources }));
vi.mock('../../procurement/supplierCommitmentAuthority', () => ({ resolveSupplierApprovers: gates.authority }));
vi.mock('../../procurement/supplierContractStore', () => ({ supplierSnapshot: (snapshot: unknown) => snapshot, assertSupplierSourceProof: gates.sourceProof }));

const actor: any = { userId: 'qualified', roles: ['manager'], permissions: ['procurement:read', 'procurement:approve'], departmentIds: [] };
const snapshot = { schemaVersion: 1, contractKind: 'purchase', currency: 'USD', supplierRelationId: 'supplier', paymentTerms: 'Net 30',
  mainDeliveryLocation: { kind: 'external', name: 'Accurate receiving party', address: 'Actual receiving address' },
  totalAmount: '2.7501', lines: [{ id: 'PL-1', orderLineId: 'OL-1', description: 'Exact material requirement', quantity: '2.7501', unit: 'M', unitPrice: '1', amount: '2.7501', requestedDeliveryDate: '2099-01-01' }],
  sourceProofs: [{ orderId: 'O-1', orderLineId: 'OL-1' }], businessOwnerId: 'requester' };
const approval = (): any => ({ id: 'A-1', requesterId: 'requester', reviewerId: 'qualified', status: 'pending',
  actionType: 'supplier:commitment', targetType: 'SupplierCommitmentRevision', targetId: 'REV-1',
  eligibleReviewerIds: ['qualified'], payload: { contractKind: 'purchase', contractId: 'PO-1', revisionId: 'REV-1', documentSnapshot: snapshot }, createdAt: new Date('2026-10-01T00:00:00Z') });
function db() {
  return { supplierCommitmentRevision: { findUniqueOrThrow: vi.fn(async () => ({ id: 'REV-1', purchaseOrderId: 'PO-1', revision: 1, snapshot })),
    findUnique: vi.fn(async () => ({ id: 'REV-1', approvalRequestId: 'A-1', status: 'superseded', decidedAt: BigInt(1) })) },
    approvalRequest: { findMany: vi.fn(async () => []) } } as any;
}
beforeEach(() => {
  vi.clearAllMocks(); gates.read.mockResolvedValue(undefined); gates.actor.mockResolvedValue(actor);
  gates.authority.mockResolvedValue({ eligibleReviewerIds: ['qualified'] });
  gates.contract.mockResolvedValue({ contract: { number: 'PO-20261007-001', approvedCommitmentRevisionId: null }, latest: { revision: 1 } });
  gates.sources.mockResolvedValue({ sources: snapshot.sourceProofs }); gates.sourceProof.mockReturnValue(undefined);
});

describe('supplier approval center native adapter', () => {
  it('shows the full frozen commercial lines and actual delivery party while binding the original review version', async () => {
    const row = approval(), detail = await readSupplierApprovalReviewDetail(db(), row, actor);
    const values = detail.frozen.fields.map(field => field.value);
    expect(values).toContain('2.7501'); expect(values).toContain('Exact material requirement'); expect(values).toContain('Actual receiving address');
    expect(values).toContain('Net 30'); expect(detail.reviewContentVersion).toBe(approvalReviewContentVersion(row));
    expect(detail.frozen.sourceReference).toMatchObject({ kind: 'purchase_order', id: 'PO-1' });
    expect(detail.canApprove).toBe(true);
    expect(gates.sources).toHaveBeenCalledWith(expect.anything(), actor, ['OL-1'], { mode: 'approve', formal: true });
    expect(gates.sourceProof).toHaveBeenCalledWith(snapshot, snapshot.sourceProofs);
  });
  it('refuses a previously frozen candidate after the live configuration removes their qualification', async () => {
    gates.authority.mockResolvedValue({ eligibleReviewerIds: ['another-qualified-user'] });
    await expect(assertSupplierApprovalCenterRead(db(), approval(), actor)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
  it('propagates source authorization failure and hides inaccessible historical decision notes', async () => {
    const tx = db(); gates.read.mockRejectedValueOnce(new SupplierContractError('NOT_FOUND', 'Exact source is inaccessible', 404));
    await expect(readSupplierApprovalReviewDetail(tx, approval(), actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(tx.approvalRequest.findMany).not.toHaveBeenCalled();
    tx.approvalRequest.findMany.mockResolvedValue([{ ...approval(), id: 'PAST', status: 'approved', decisionNote: 'Secret old source', reviewer: { displayName: 'Old reviewer' } }]);
    gates.read.mockImplementation(async (_db: unknown, row: any) => { if (row.id === 'PAST') throw new SupplierContractError('NOT_FOUND', 'Old source removed from current scope', 404); });
    const detail = await readSupplierApprovalReviewDetail(tx, approval(), actor);
    expect(detail.decisionHistory).toEqual([]); expect(detail.decisionHistoryStatus).toBe('unavailable');
  });
  it('reads an actually committed superseded revision as history and never invents a completed projection for an absent fact', async () => {
    const tx = db(), row = { ...approval(), status: 'approved' };
    await expect(readSupplierApprovalSyncStatus(tx, row)).resolves.toBe('completed');
    tx.supplierCommitmentRevision.findUnique.mockResolvedValue(null);
    await expect(readSupplierApprovalSyncStatus(tx, row)).resolves.toBe('unknown');
  });
});
