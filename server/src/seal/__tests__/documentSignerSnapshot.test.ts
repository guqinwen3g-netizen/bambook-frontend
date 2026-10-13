import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { buildApprovalSignDocumentSnapshot } from '../../approvals/approvalSignDocumentSnapshotService';
import { approvalReviewContentVersion } from '../../approvals/approvalReviewContent';
import { approvalReviewPreviewDigest } from '../../approvals/approvalReviewDetailService';
import { resolveDocumentSigner } from '../documentSigner';

async function fixture() {
  const order: any = { id: 'o1', poNumber: 'PO-1', customer: 'Original customer', status: 'Confirmed',
    currency: 'USD', createdAt: new Date('2026-10-01T00:00:00Z'), customerRelationId: null,
    lines: [{ id: 'l1', lineNumber: 1, description: 'Original fabric', quantity: new Prisma.Decimal('3'),
      unit: 'M', unitPrice: new Prisma.Decimal('4'), netValue: new Prisma.Decimal('12') }] };
  let approval: any;
  let audit: any;
  const prisma: any = { order: { findUnique: vi.fn(async () => order) },
    systemConfig: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    auditLog: { findMany: vi.fn(async () => audit ? [audit] : []) },
    approvalRequest: { findFirst: vi.fn(async () => approval) },
    userRole: { findFirst: vi.fn(async () => ({ roleId: 'role-admin' })) } };
  const snapshot = await buildApprovalSignDocumentSnapshot(prisma, { kind: 'OrderConfirmation', orderId: order.id });
  approval = { id: 'a1', requesterId: 'sales', reviewerId: 'leader', actionType: 'order:confirmation_sign',
    targetType: 'OrderConfirmation', targetId: order.id, status: 'approved', decidedAt: new Date('2026-10-01T01:00:00Z'), payload: { orderId: order.id, documentSnapshot: snapshot } };
  const reviewed = { ...approval, reviewerId: null };
  audit = { action: 'approve_business_request', actorId: 'leader', detail: { source: 'api:approvals',
    decisionActorAuthority: { userId: 'leader', authorizationLoaded: true },
    approvalDecisionFact: { schemaVersion: 1, status: 'approved', actionType: approval.actionType,
      targetType: approval.targetType, targetId: approval.targetId, decisionActorId: 'leader',
      decidedAt: approval.decidedAt.toISOString(), frozenReviewerId: null, reviewedContentConfirmed: true,
      reviewContentVersion: approvalReviewContentVersion(reviewed), reviewPreviewDigest: approvalReviewPreviewDigest(reviewed),
      documentSnapshot: { kind: snapshot.kind, sourceRef: snapshot.sourceRef, templateVersion: snapshot.templateVersion,
        sourceFingerprint: snapshot.sourceFingerprint, contentFingerprint: snapshot.contentFingerprint } } } };
  return { prisma, order, snapshot, audit };
}

describe('native order-confirmation signer snapshot', () => {
  it('refuses approved status without the matching reviewed decision fact', async () => {
    const { prisma, audit } = await fixture();
    audit.detail.approvalDecisionFact.documentSnapshot.contentFingerprint = '0'.repeat(64);
    expect(await resolveDocumentSigner(prisma, { targetType: 'OrderConfirmation', targetId: 'o1' })).toBeNull();
    expect(prisma.userRole.findFirst).not.toHaveBeenCalled();
  });

  it('returns the complete matching rendered snapshot with the actual signer', async () => {
    const { prisma, snapshot } = await fixture();
    const signer = await resolveDocumentSigner(prisma, { targetType: 'OrderConfirmation', targetId: 'o1' });
    expect(signer?.userId).toBe('leader');
    expect(signer?.documentSnapshot?.contentFingerprint).toBe(snapshot.contentFingerprint);
    expect(signer?.documentSnapshot?.exactSource.order.lines[0].unitPrice).toBe('4');
  });
  it('does not reuse an old signature after price changes', async () => {
    const { prisma, order } = await fixture();
    order.lines[0].unitPrice = new Prisma.Decimal('5');
    expect(await resolveDocumentSigner(prisma, { targetType: 'OrderConfirmation', targetId: 'o1' })).toBeNull();
    expect(prisma.userRole.findFirst).not.toHaveBeenCalled();
  });
  it('does not reuse an old signature for a changed customer', async () => {
    const { prisma, order } = await fixture();
    order.customer = 'Different customer';
    expect(await resolveDocumentSigner(prisma, { targetType: 'OrderConfirmation', targetId: 'o1' })).toBeNull();
  });
});
