import { describe, expect, it, vi } from 'vitest';
import { buildOrderChangeFinalVersion, captureOrderChangeReviewBasis } from '../orderChangeFinalVersion';

vi.mock('../../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => ({ id: 'ORD-1' })) }));

import { createOrderChangeCustomerConfirmationAdapter } from '../orderChangeCustomerConfirmationAdapter';

const actor: any = { userId: 'sales-1', roles: ['sales'], permissions: ['orders:read', 'order:change_request:apply'], authorizationLoaded: true };
const beforeOrder: any = { id: 'ORD-1', status: 'Confirmed', deletedAt: null, updatedAt: 7n,
  quantity: '10.0000', unit: 'pcs', quoteAmount: '100.0000', contractAmount: '100.0000', totalNet: '100.0000',
  dueDate: '2026-11-01', clientDate: null, customer: '客户A', customerRelationId: 'REL-1', customerCode: 'A', currency: 'CNY' };
const beforeLine: any = { id: 'LINE-1', orderId: 'ORD-1', lineNumber: 1, quantity: '10.0000', unit: 'pcs', unitPrice: '10.0000',
  netValue: '100.0000', internalTransferPrice: null, confirmedSourceType: 'Asset', confirmedSourceId: 'AS-1',
  confirmedAt: 1n, confirmedBy: 'sales-1', specSnapshot: { styleNo: 'ST1' } };

function makeFixture(options: { status?: string; approvalStatus?: string; accepted?: boolean; applyAudit?: boolean; stale?: boolean } = {}) {
  const order = options.stale ? { ...beforeOrder, updatedAt: 8n, quoteAmount: '120.0000', contractAmount: '120.0000', totalNet: '120.0000' } : beforeOrder;
  const line = options.stale ? { ...beforeLine, unitPrice: '12.0000', netValue: '120.0000' } : beforeLine;
  const reviewBasis = captureOrderChangeReviewBasis(beforeOrder, [beforeLine]);
  const payload: any = { changeType: 'price', hitChangeTypes: ['unitPrice'],
    beforeSnapshot: { unitPrice: '100.0000' }, afterDelta: { unitPrice: '120.0000' },
    changeReason: '客户提出本订单价格调整', impactSummary: '需要同步更新订单金额与确认条款',
    contentFingerprint: 'a'.repeat(64), orderChangeReviewBasis: reviewBasis };
  const approval: any = { id: 'APPROVAL-1', requesterId: 'requester-1', reviewerId: 'reviewer-1', actionType: 'order:change',
    targetType: 'OrderChangeRequest', targetId: 'ORD-1', status: options.approvalStatus ?? 'approved',
    decidedAt: (options.approvalStatus ?? 'approved') === 'approved' ? new Date('2026-10-04T09:00:00Z') : null, payload };
  const cr: any = { id: 'CR-1', requestNumber: 'OCR-20261004-001', orderId: 'ORD-1', status: options.status ?? 'Approved',
    changeTypes: ['unitPrice'], beforeSnapshot: payload.beforeSnapshot, afterDelta: payload.afterDelta,
    changeReason: payload.changeReason, notes: payload.impactSummary, requesterId: approval.requesterId,
    approvalRequestId: approval.id, deletedAt: null, appliedAt: null, appliedBy: null };
  const originalVersion = buildOrderChangeFinalVersion({ changeRequest: { ...cr, status: 'Approved' }, order: beforeOrder,
    orderLines: [beforeLine], approval: { ...approval, status: 'approved', decidedAt: new Date('2026-10-04T09:00:00Z') }, requireApproved: true });
  cr.finalContentFingerprint = originalVersion.finalContentFingerprint;
  if (cr.status === 'Applied') {
    cr.appliedAt = new Date('2026-10-04T10:00:00Z');
    cr.appliedBy = 'sales-1';
  }
  const approvalFact = { id: 'APPROVAL-AUDIT', actorId: approval.reviewerId, action: 'approve_business_request',
    targetType: 'ApprovalRequest', targetId: approval.id, detail: { approvalDecisionFact: {
      schemaVersion: 1, status: 'approved', actionType: approval.actionType, targetType: approval.targetType,
      targetId: approval.targetId, contentFingerprint: payload.contentFingerprint, decidedAt: approval.decidedAt?.toISOString() ?? null,
      decisionActorId: approval.reviewerId, reviewContentVersion: 'b'.repeat(64), reviewedContentConfirmed: true,
    } } };
  const confirmation: any = options.accepted ? { id: 'CONFIRMATION-1', targetType: 'OrderChangeRequest', targetId: cr.id,
    finalContentFingerprint: cr.finalContentFingerprint, internalApprovalId: approval.id,
    scopeFingerprint: originalVersion.scopeFingerprint, outcome: 'accepted', recordedBy: 'sales-1', recordedAt: 1_791_100_000_000n,
    auditId: 'CONFIRMATION-AUDIT', revision: 1 } : null;
  const confirmationAudit = confirmation ? { id: confirmation.auditId, actorId: confirmation.recordedBy,
    action: 'business_customer_confirmation_recorded', targetId: confirmation.id } : null;
  const evidenceLinks = confirmation ? [{ evidence: { sourceType: 'email_selection', sourceFingerprint: 'c'.repeat(64),
    sourceSnapshot: { body: 'Customer approved this exact price' }, files: [] } }] : [];
  const applyAudit = { id: 'APPLY-AUDIT', actorId: cr.appliedBy, action: 'order_change_approved', targetType: 'Order',
    targetId: cr.orderId, transactionId: approval.id, fieldPath: 'unitPrice', afterValue: '120.0000',
    detail: { changeRequestId: cr.id, changeType: 'price' } };
  const tx: any = {
    $queryRawUnsafe: vi.fn(async () => []),
    orderChangeRequest: { findUnique: vi.fn(async () => cr), findMany: vi.fn(async () => [{ id: cr.id }]) },
    order: { findFirst: vi.fn(async () => order), findMany: vi.fn(async () => [{ id: 'ORD-1' }]) },
    orderLine: { findMany: vi.fn(async () => [line]) },
    approvalRequest: { findUnique: vi.fn(async () => approval) },
    businessConfirmation: { findFirst: vi.fn(async () => confirmation) },
    businessConfirmationEvidence: { findMany: vi.fn(async () => evidenceLinks) },
    auditLog: {
      findUnique: vi.fn(async () => confirmationAudit),
      findMany: vi.fn(async ({ where }: any) => where?.action === 'order_change_approved'
        ? (options.applyAudit ? [applyAudit] : [])
        : ((options.approvalStatus ?? 'approved') === 'approved' ? [approvalFact] : [])),
    },
  };
  const prisma: any = { $transaction: vi.fn((callback: any) => callback(tx)) };
  const service: any = { applyChangeRequest: vi.fn(async () => ({ ok: false, error: { code: 'CONFLICT', message: 'no apply' } })) };
  const adapter = createOrderChangeCustomerConfirmationAdapter({ prisma, service } as any);
  return { adapter, tx, service, prisma, cr, approval, order, line, originalVersion };
}

describe('order change customer confirmation native readback', () => {
  it('discovers only exact linked order/customer targets and exact request-number searches', async () => {
    const fixture = makeFixture();
    await expect(fixture.adapter.searchTargetIds(fixture.tx, actor, {
      sourceEmail: { orderId: 'ORD-1', relationId: 'REL-1' },
    })).resolves.toEqual(['CR-1']);
    expect(fixture.tx.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ customerRelationId: 'REL-1', deletedAt: null }),
      take: 50,
    }));
    expect(fixture.tx.orderChangeRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { orderId: { in: ['ORD-1'] }, status: { in: ['Pending', 'Approved'] }, deletedAt: null }, take: 40,
    }));

    fixture.tx.orderChangeRequest.findMany.mockResolvedValueOnce([{ id: 'CR-EXACT' }]);
    await expect(fixture.adapter.searchTargetIds(fixture.tx, actor, {
      sourceEmail: {}, businessReference: ' OCR-20261004-001 ',
    })).resolves.toEqual(['CR-EXACT']);
    expect(fixture.tx.orderChangeRequest.findMany).toHaveBeenLastCalledWith({
      where: { requestNumber: 'OCR-20261004-001', deletedAt: null }, select: { id: true }, take: 5,
    });
  });

  it('requires current order read authority before searching native targets', async () => {
    const fixture = makeFixture();
    await expect(fixture.adapter.searchTargetIds(fixture.tx, { ...actor, permissions: [] }, {
      sourceEmail: { orderId: 'ORD-1' },
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.tx.orderChangeRequest.findMany).not.toHaveBeenCalled();
  });

  it('allows only the immutable pending proposal as a pre-approval customer confirmation and keeps it unapplied', async () => {
    const fixture = makeFixture({ status: 'Pending', approvalStatus: 'pending', accepted: true });
    const snapshot = await fixture.adapter.inspect(fixture.tx, 'CR-1', actor, 'read');
    expect(snapshot).toMatchObject({ eligible: true, businessLabel: '订单变更申请', businessReference: 'OCR-20261004-001',
      versionLabel: '待审批申请版本', scopeLabel: '价格变更 · 订单明细 #1', recommendation: { orderId: 'ORD-1', relationId: 'REL-1' }, nativeStatus: {
        changeRequestStatus: 'Pending', approvalStatus: 'pending', effect: 'awaiting_internal_approval',
      } });
    const continued = await fixture.adapter.continueAfterRecord({ targetId: 'CR-1', actor,
      command: { outcome: 'accepted' } as any, confirmation: {} });
    expect(continued.effect).toMatchObject({ status: 'pending' });
    expect(fixture.service.applyChangeRequest).not.toHaveBeenCalled();
  });

  it('reports an approved exact accepted version as awaiting native apply, not complete', async () => {
    const fixture = makeFixture({ accepted: true });
    const snapshot = await fixture.adapter.inspect(fixture.tx, 'CR-1', actor, 'read');
    expect(snapshot.nativeStatus).toMatchObject({ changeRequestStatus: 'Approved', effect: 'apply_pending' });
    expect(snapshot.eligible).toBe(true);
  });

  it('reconstructs the frozen signed fingerprint after apply and reports success only with exact customer and apply audit readback', async () => {
    const fixture = makeFixture({ status: 'Applied', accepted: true, applyAudit: true, stale: true });
    const snapshot = await fixture.adapter.inspect(fixture.tx, 'CR-1', actor, 'read');
    expect(snapshot).toMatchObject({ eligible: false, finalContentFingerprint: fixture.originalVersion.finalContentFingerprint,
      scopeFingerprint: fixture.originalVersion.scopeFingerprint, versionLabel: '已生效版本', nativeStatus: {
        changeRequestStatus: 'Applied', effect: 'applied', applyAuditValid: true,
        customerConfirmation: { outcome: 'accepted', evidenceAuditValid: true, matchesCurrentVersion: true },
      } });
    const continued = await fixture.adapter.continueAfterRecord({ targetId: 'CR-1', actor,
      command: { outcome: 'accepted' } as any, confirmation: {} });
    expect(continued.effect).toMatchObject({ status: 'applied', recovered: true });
    expect(fixture.service.applyChangeRequest).not.toHaveBeenCalled();
  });

  it('does not call an applied row successful when its apply audit is missing or malformed', async () => {
    const fixture = makeFixture({ status: 'Applied', accepted: true, applyAudit: false, stale: true });
    const snapshot = await fixture.adapter.inspect(fixture.tx, 'CR-1', actor, 'read');
    expect(snapshot.nativeStatus).toMatchObject({ changeRequestStatus: 'Applied', effect: 'applied_unverified', applyAuditValid: false });
  });

  it('distinguishes rejected and cancelled requests from an internal approval still pending', async () => {
    const rejected = makeFixture({ status: 'Rejected', approvalStatus: 'rejected', accepted: true });
    const cancelled = makeFixture({ status: 'Cancelled', approvalStatus: 'cancelled', accepted: true });
    await expect(rejected.adapter.inspect(rejected.tx, 'CR-1', actor, 'read')).resolves.toMatchObject({
      nativeStatus: { changeRequestStatus: 'Rejected', effect: 'rejected' },
    });
    await expect(cancelled.adapter.inspect(cancelled.tx, 'CR-1', actor, 'read')).resolves.toMatchObject({
      nativeStatus: { changeRequestStatus: 'Cancelled', effect: 'cancelled' },
    });
  });

  it('keeps an accepted confirmation pending when the approved source version has changed', async () => {
    const fixture = makeFixture({ accepted: true, stale: true });
    const snapshot = await fixture.adapter.inspect(fixture.tx, 'CR-1', actor, 'read');
    expect(snapshot.eligible).toBe(false);
    expect(snapshot.nativeStatus).toMatchObject({ changeRequestStatus: 'Approved', effect: 'version_changed' });
    const continued = await fixture.adapter.continueAfterRecord({ targetId: 'CR-1', actor,
      command: { outcome: 'accepted' } as any, confirmation: {} });
    expect(continued.effect).toMatchObject({ status: 'pending' });
    expect(fixture.service.applyChangeRequest).not.toHaveBeenCalled();
  });
});
