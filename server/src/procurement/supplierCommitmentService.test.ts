import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { supplierContractMemoryFixture } from './supplierContractMemoryFixture';
import { createSupplierCommitmentService, decideSupplierCommitmentApproval } from './supplierCommitmentService';
import { setSupplierApprovalAuthority } from './supplierCommitmentAuthority';
import { supplierObject } from './supplierContractPolicy';
import { approvalReviewContentVersion } from '../approvals/approvalReviewContent';

const auth = vi.hoisted(() => ({ permissions: ['procurement:read', 'procurement:write'], active: true }));
vi.mock('../auth/tokenHelpers', () => ({ loadUserWithRoles: vi.fn(async (_tx, id) => ({ id, status: auth.active ? 'active' : 'disabled', deletedAt: null })),
  buildLoadedAuthTokenPayload: vi.fn(async (_tx, user) => ({ userId: user.id, roles: user.id === 'admin' ? ['admin'] : ['sales'], departmentIds: [],
    permissions: user.id === 'reviewer' ? ['procurement:read', 'procurement:approve'] : user.id === 'admin' ? ['dictionary:write'] : [...auth.permissions], authorizationLoaded: true })) }));
vi.mock('../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => ({ ownerId: 'business' })) }));
const actor = (userId = 'business'): TokenPayload => ({ userId, permissions: [], roles: [], departmentIds: [] });
const purchase = (extra: Record<string, unknown> = {}) => ({ requestKey: 'first-purchase', contractNumber: 'PO-native-1', supplierRelationId: 'supplier-1', currency: 'CNY', paymentTerms: 'T/T 30 days',
  mainDeliveryLocation: { kind: 'supplier', relationId: 'processor-1', address: 'Actual processor address' }, orderDate: '2026-10-07',
  lines: [{ orderLineId: 'line-1', kind: 'Material', category: 'Fabric', materialCode: 'RAW-1', description: 'Raw cotton', specification: '100% cotton', quantity: '100', unit: 'M', unitPrice: '2.5', requestedDeliveryDate: '2026-11-01' }], ...extra });
beforeEach(() => { auth.permissions = ['procurement:read', 'procurement:write']; auth.active = true; });
describe('native supplier commitment lifecycle', () => {
  it('creates an exact-source draft and recovers the same successful command without a duplicate contract or revision', async () => {
    const f = supplierContractMemoryFixture(), service = createSupplierCommitmentService(f.db as unknown as PrismaClient);
    const first = await service.create('purchase', purchase(), actor());
    expect(first).toMatchObject({ ok: true, commandAck: { requestKey: 'first-purchase', contractKind: 'purchase', revisionId: expect.any(String) } });
    expect(first.item).toMatchObject({ contractKind: 'purchase', approvalState: 'draft', approvedRevision: null,
      draft: { lines: [{ orderLineId: 'line-1', quantity: '100', unitPrice: '2.5' }] } });
    expect(await service.create('purchase', purchase(), actor())).toEqual(first);
    expect(f.all('purchaseOrder')).toHaveLength(1); expect(f.all('supplierCommitmentRevision')).toHaveLength(1);
    expect(f.all('supplierContractCommandReceipt')).toHaveLength(1);
  });
  it('uses independent configured supplier approvers, freezes the exact snapshot, and publishes only the approved projection', async () => {
    const f = supplierContractMemoryFixture(), prisma = f.db as unknown as PrismaClient, service = createSupplierCommitmentService(prisma);
    await setSupplierApprovalAuthority({ prisma, actor: actor('admin'), kind: 'purchase', family: 'fabric', requestKey: 'configure-purchase', userIds: ['reviewer'], expectedConfigVersion: 0, reason: 'Explicit supplier commitment authority' });
    const created = await service.create('purchase', purchase(), actor());
    const submitted = await service.submit('purchase', created.commandAck.contractId, { requestKey: 'submit-first', expectedRevision: 1 }, actor());
    expect(submitted.commandAck.approvalId).toEqual(expect.any(String));
    const approval = f.all('approvalRequest').find(row => row.id === submitted.commandAck.approvalId)!;
    expect(approval).toMatchObject({ actionType: 'supplier:commitment', targetType: 'SupplierCommitmentRevision', eligibleReviewerIds: ['reviewer'], status: 'pending' });
    const frozen = JSON.stringify(f.all('supplierCommitmentRevision')[0].snapshot);
    const decided = await decideSupplierCommitmentApproval({ prisma, approvalId: approval.id, actor: actor('reviewer'), decision: 'approved',
      reviewContentVersion: approvalReviewContentVersion(approval), confirmedReviewedContent: true });
    expect(decided.item).toMatchObject({ id: approval.id, status: 'approved' });
    const view = supplierObject(await service.get('purchase', created.commandAck.contractId, actor()));
    expect(view.approvalState).toBe('approved');
    expect(view.approvedRevision).toMatchObject({ id: created.commandAck.revisionId, status: 'approved' });
    expect(f.all('purchaseOrder')[0].approvedCommitmentRevisionId).toBe(created.commandAck.revisionId);
    expect(JSON.stringify(f.all('supplierCommitmentRevision')[0].snapshot)).toBe(frozen);
  });
  it('freezes pending drafts and makes commercial amendments a new reviewed version without replacing the prior approved basis', async () => {
    const f = supplierContractMemoryFixture(), prisma = f.db as unknown as PrismaClient, service = createSupplierCommitmentService(prisma);
    await setSupplierApprovalAuthority({ prisma, actor: actor('admin'), kind: 'purchase', family: 'fabric', requestKey: 'configure-purchase', userIds: ['reviewer'], expectedConfigVersion: 0, reason: 'Explicit supplier authority' });
    const created = await service.create('purchase', purchase(), actor()), id = created.commandAck.contractId;
    const draft = supplierObject(created.item).draft as Record<string, unknown>;
    const pending = await service.submit('purchase', id, { requestKey: 'submit-first', expectedRevision: 1 }, actor());
    await expect(service.saveDraft('purchase', id, { ...draft, requestKey: 'forbidden-edit', expectedRevision: 1 }, actor())).rejects.toMatchObject({ code: 'CONTRACT_APPROVAL_PENDING' });
    const first = f.all('approvalRequest').find(row => row.id === pending.commandAck.approvalId)!;
    await decideSupplierCommitmentApproval({ prisma, approvalId: first.id, actor: actor('reviewer'), decision: 'approved', reviewContentVersion: approvalReviewContentVersion(first), confirmedReviewedContent: true });
    await expect(service.saveDraft('purchase', id, { ...draft, requestKey: 'approved-generic-edit', expectedRevision: 1 }, actor())).rejects.toMatchObject({ code: 'COMMITMENT_CHANGE_REQUIRED' });
    const changed = { ...draft, requestKey: 'amend-price', basedOnRevisionId: created.commandAck.revisionId, expectedRevision: 1, reason: 'Supplier price explicitly changed',
      lines: (draft.lines as Array<Record<string, unknown>>).map(line => ({ ...line, unitPrice: '3' })) };
    const amendment = await service.amend('purchase', id, changed, actor());
    expect(amendment.commandAck.revisionId).not.toBe(created.commandAck.revisionId);
    expect(f.all('purchaseLine')[0].unitPrice.toString()).toBe('2.5');
    expect(f.all('purchaseOrder')[0].approvedCommitmentRevisionId).toBe(created.commandAck.revisionId);
    const again = await service.submit('purchase', id, { requestKey: 'submit-amendment', expectedRevision: 2 }, actor());
    const second = f.all('approvalRequest').find(row => row.id === again.commandAck.approvalId)!;
    await decideSupplierCommitmentApproval({ prisma, approvalId: second.id, actor: actor('reviewer'), decision: 'approved', reviewContentVersion: approvalReviewContentVersion(second), confirmedReviewedContent: true });
    expect(f.all('purchaseLine')[0].unitPrice.toString()).toBe('3');
    expect(f.all('supplierCommitmentRevision')[0]).toMatchObject({ id: created.commandAck.revisionId, status: 'superseded' });
    expect(f.all('supplierCommitmentRevision')[0].snapshot.lines[0].unitPrice).toBe('2.5');
    expect(f.all('purchaseOrder')[0].approvedCommitmentRevisionId).toBe(amendment.commandAck.revisionId);
  });
  it('merges compatible rows with independent specifications/dates and preserves their exact amounts', async () => {
    const f = supplierContractMemoryFixture(), service = createSupplierCommitmentService(f.db as unknown as PrismaClient);
    const created = await service.create('purchase', purchase(), actor());
    const merged = await service.merge('purchase', created.commandAck.contractId, purchase({ requestKey: 'merge-second', expectedRevision: 1,
      lines: [{ orderLineId: 'line-1', kind: 'Material', category: 'Fabric', description: 'Other actual material', specification: 'linen', quantity: '12.125', unit: 'M', unitPrice: '2.5', requestedDeliveryDate: '2026-12-02' }] }), actor());
    expect(merged.item).toMatchObject({ latestRevision: 2, draft: { totalAmount: '280.3125', lines: [{ quantity: '100' }, { quantity: '12.125', amount: '30.3125' }] } });
    expect(f.all('purchaseLine')).toHaveLength(2);
  });
  it('records offline send and date feedback accurately, making a different date a reviewed amendment and preserving the original successful receipt', async () => {
    const f = supplierContractMemoryFixture(), prisma = f.db as unknown as PrismaClient, service = createSupplierCommitmentService(prisma);
    await setSupplierApprovalAuthority({ prisma, actor: actor('admin'), kind: 'purchase', family: 'fabric', requestKey: 'configure-purchase', userIds: ['reviewer'], expectedConfigVersion: 0, reason: 'Explicit supplier authority' });
    const created = await service.create('purchase', purchase(), actor()), id = created.commandAck.contractId, revisionId = created.commandAck.revisionId!;
    const submit = await service.submit('purchase', id, { requestKey: 'submit-first', expectedRevision: 1 }, actor());
    const approval = f.all('approvalRequest').find(row => row.id === submit.commandAck.approvalId)!;
    await decideSupplierCommitmentApproval({ prisma, approvalId: approval.id, actor: actor('reviewer'), decision: 'approved', reviewContentVersion: approvalReviewContentVersion(approval), confirmedReviewedContent: true });
    const send = { requestKey: 'offline-send', approvedRevisionId: revisionId, sentAt: '2026-10-07', evidence: ['offline email file'] };
    const sent = await service.recordOfflineSend('purchase', id, send, actor());
    const lineId = f.all('purchaseLine')[0].id;
    const feedback = await service.recordSupplierFeedback('purchase', id, { requestKey: 'actual-date-feedback', approvedRevisionId: revisionId,
      feedbackAt: '2026-10-08', lines: [{ lineId, supplierCommittedDeliveryDate: '2026-11-05' }], evidence: ['supplier response file'] }, actor());
    expect(feedback.item).toMatchObject({ requiresAmendment: true, proposedRevisionId: expect.any(String), recordedBy: 'business' });
    expect(f.all('purchaseLine')[0]).toMatchObject({ requestedDeliveryDate: '2026-11-01', supplierCommittedDeliveryDate: null });
    expect(f.all('purchaseOrder')[0].approvedCommitmentRevisionId).toBe(revisionId);
    expect(f.all('supplierCommitmentRevision')[1].snapshot.lines[0].requestedDeliveryDate).toBe('2026-11-05');
    expect(await service.recordOfflineSend('purchase', id, send, actor())).toEqual(sent);
    await expect(service.recordOfflineSend('purchase', id, { ...send, requestKey: 'new-send-while-amending' }, actor())).rejects.toMatchObject({ code: 'COMMITMENT_AMENDMENT_UNAPPROVED' });
  });
});
