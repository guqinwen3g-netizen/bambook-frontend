import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureOrderChangeReviewBasis, buildOrderChangeFinalVersion } from '../orderChangeFinalVersion';

const auth = vi.hoisted(() => ({ actor: { userId: 'operator-1', roles: ['sales'], permissions: ['order:change_request:apply'], authorizationLoaded: true } }));
vi.mock('../../customerConfirmations/customerConfirmationService', async importOriginal => {
  const real = await importOriginal<typeof import('../../customerConfirmations/customerConfirmationService')>();
  return { ...real, currentCustomerConfirmationActor: vi.fn(async (_tx, prior) => ({ ...auth.actor, userId: prior?.userId ?? auth.actor.userId })) };
});
import { createOrderChangeRequestService, ORDER_CHANGE_ERRORS } from '../orderChangeRequestService';

const orderBase: any = { id: 'O1', status: 'Confirmed', deletedAt: null, updatedAt: 7n,
  quantity: '10.0000', unit: 'pcs', quoteAmount: '100.0000', contractAmount: '100.0000', totalNet: '100.0000',
  dueDate: '2026-11-01', clientDate: null, customer: '客户A', customerRelationId: 'REL-1', customerCode: 'A', currency: 'CNY' };
const lineBase: any = { id: 'L1', orderId: 'O1', lineNumber: 1, quantity: '10.0000', unit: 'pcs', unitPrice: '10.0000',
  netValue: '100.0000', internalTransferPrice: null, confirmedSourceType: 'Asset', confirmedSourceId: 'AS-1',
  confirmedAt: 1n, confirmedBy: 'requester-1', specSnapshot: { styleNo: 'ST1' } };
const actor = { userId: 'operator-1', roles: ['sales'], permissions: ['order:change_request:apply'], authorizationLoaded: true };

function makeFixture(currentLine: any = lineBase) {
  const order = { ...orderBase };
  const basis = captureOrderChangeReviewBasis(order, [lineBase]);
  const approvalPayload: any = { changeType: 'price', hitChangeTypes: ['unitPrice'],
    beforeSnapshot: { unitPrice: '100.0000' }, afterDelta: { unitPrice: '120.0000' },
    changeReason: '客户要求调整本订单价格', impactSummary: '需更新客户确认与收款金额', contentFingerprint: 'a'.repeat(64),
    orderChangeReviewBasis: basis };
  const approval: any = { id: 'AR1', requesterId: 'requester-1', reviewerId: 'reviewer-1', actionType: 'order:change',
    targetType: 'OrderChangeRequest', targetId: 'O1', status: 'approved', decidedAt: new Date('2026-10-01T01:00:00.000Z'), payload: approvalPayload };
  const changeRequest: any = { id: 'CR1', orderId: 'O1', requestNumber: 'OCR-1', status: 'Approved', changeTypes: ['unitPrice'],
    beforeSnapshot: approvalPayload.beforeSnapshot, afterDelta: approvalPayload.afterDelta, changeReason: approvalPayload.changeReason,
    notes: approvalPayload.impactSummary, requesterId: approval.requesterId, approvalRequestId: approval.id, deletedAt: null, attachments: null };
  const final = buildOrderChangeFinalVersion({ changeRequest, order, orderLines: [lineBase], approval: { ...approval, payload: approvalPayload } });
  changeRequest.finalContentFingerprint = final.finalContentFingerprint;
  const orderUpdate = vi.fn(async ({ data }: any) => ({ ...order, ...data }));
  const changeUpdate = vi.fn(async ({ data }: any) => ({ ...changeRequest, ...data }));
  const decisionAudit = { id: 'AUD-DECISION', actorId: approval.reviewerId, action: 'approve_business_request',
    targetType: 'ApprovalRequest', targetId: approval.id, detail: { approvalDecisionFact: {
      schemaVersion: 1, status: 'approved', actionType: approval.actionType, targetType: approval.targetType, targetId: approval.targetId,
      contentFingerprint: approvalPayload.contentFingerprint, decidedAt: approval.decidedAt.toISOString(), decisionActorId: approval.reviewerId,
      reviewContentVersion: 'b'.repeat(64), reviewedContentConfirmed: true,
    } } };
  const tx: any = {
    $queryRawUnsafe: vi.fn(async () => []),
    order: { findUnique: vi.fn(async () => order), update: orderUpdate },
    orderChangeRequest: { findUnique: vi.fn(async () => changeRequest), findUniqueOrThrow: vi.fn(async () => changeRequest), update: changeUpdate },
    orderLine: { findMany: vi.fn(async () => [currentLine]), update: vi.fn(async () => ({})) },
    approvalRequest: { findUnique: vi.fn(async () => approval) },
    auditLog: { findMany: vi.fn(async () => [decisionAudit]), findUnique: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    businessConfirmation: { findFirst: vi.fn(async () => null) },
  };
  tx.$transaction = vi.fn(async (callback: any) => callback(tx));
  const service = createOrderChangeRequestService({ prisma: tx, approvalCreateService: {} as any });
  return { service, tx, orderUpdate, changeUpdate, final };
}

beforeEach(() => { auth.actor = actor; });

describe('order change native apply customer gate', () => {
  it('rejects a missing accepted confirmation after validating the signed approval, before any order write', async () => {
    const fixture = makeFixture();
    const result = await fixture.service.applyChangeRequest({ changeRequestId: 'CR1', appliedBy: actor.userId, trustedActor: actor as any });
    expect(result).toMatchObject({ ok: false, error: { code: ORDER_CHANGE_ERRORS.CUSTOMER_CONFIRMATION_REQUIRED, statusCode: 409 } });
    expect(fixture.tx.businessConfirmation.findFirst).toHaveBeenCalledWith({ where: {
      targetType: 'OrderChangeRequest', targetId: 'CR1', finalContentFingerprint: fixture.final.finalContentFingerprint,
      scopeFingerprint: fixture.final.scopeFingerprint,
    }, orderBy: { revision: 'desc' } });
    expect(fixture.orderUpdate).not.toHaveBeenCalled();
    expect(fixture.changeUpdate).not.toHaveBeenCalled();
  });

  it('rejects a changed native order line version before looking for customer acceptance', async () => {
    const changedLine = { ...lineBase, netValue: '101.0000' };
    const fixture = makeFixture(changedLine);
    const result = await fixture.service.applyChangeRequest({ changeRequestId: 'CR1', appliedBy: actor.userId, trustedActor: actor as any });
    expect(result).toMatchObject({ ok: false, error: { code: ORDER_CHANGE_ERRORS.ORDER_CHANGE_VERSION_MISMATCH, statusCode: 409 } });
    expect(fixture.tx.businessConfirmation.findFirst).not.toHaveBeenCalled();
    expect(fixture.orderUpdate).not.toHaveBeenCalled();
  });
});
