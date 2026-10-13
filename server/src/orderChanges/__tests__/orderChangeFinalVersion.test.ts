import { describe, expect, it } from 'vitest';
import {
  buildOrderChangeFinalVersion,
  captureOrderChangeReviewBasis,
  orderChangeAmendmentProposalFingerprint,
  OrderChangeFinalVersionError,
} from '../orderChangeFinalVersion';

const order = { id: 'O1', status: 'Confirmed', updatedAt: 7n, quoteAmount: '100.0000', contractAmount: '100.0000', totalNet: '100.0000', quantity: '10.0000', dueDate: '2026-11-01', clientDate: null };
const line = { id: 'L1', orderId: 'O1', lineNumber: 1, quantity: '10.0000', unit: 'pcs', unitPrice: '10.0000', netValue: '100.0000', confirmedSourceType: 'Asset', confirmedSourceId: 'A1', confirmedAt: 1n, confirmedBy: 'u1', specSnapshot: { styleNo: 'ST1' } };
const cr = { id: 'CR1', orderId: 'O1', requestNumber: 'OCR-1', changeTypes: ['unitPrice'], requesterId: 'u1', approvalRequestId: 'AR1', deletedAt: null, status: 'Approved', beforeSnapshot: { unitPrice: '100.0000' }, afterDelta: { unitPrice: '120.0000' }, changeReason: '客户要求调整本订单价格', notes: '需更新客户确认与收款金额' };
const payload = { changeType: 'price', hitChangeTypes: ['unitPrice'], beforeSnapshot: cr.beforeSnapshot, afterDelta: cr.afterDelta, changeReason: cr.changeReason, impactSummary: cr.notes };
const approval = { id: 'AR1', requesterId: 'u1', reviewerId: 'u2', actionType: 'order:change', targetType: 'OrderChangeRequest', targetId: 'O1', status: 'approved', decidedAt: new Date('2026-10-01T01:00:00Z'), payload };

describe('order change customer-confirmation final version', () => {
  it('binds approved before/after facts, order and line source versions, approval id, and explicit scope', () => {
    const basis = captureOrderChangeReviewBasis(order, [line]);
    const final = buildOrderChangeFinalVersion({ changeRequest: cr, order, orderLines: [line], approval: { ...approval, payload: { ...payload, orderChangeReviewBasis: basis } } });
    expect(final.finalContentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(final.scopeFingerprint).toBe(final.finalContentFingerprint);
    expect(final.scope).toMatchObject({ targetId: 'CR1', orderId: 'O1', changeType: 'price', fields: ['unitPrice'], lineIds: ['L1'], lineQuantityPlanHash: null });
  });

  it('refuses a source row changed after approval instead of producing a new confirmable version', () => {
    const basis = captureOrderChangeReviewBasis(order, [line]);
    expect(() => buildOrderChangeFinalVersion({ changeRequest: cr, order, orderLines: [{ ...line, netValue: '101.0000' }], approval: { ...approval, payload: { ...payload, orderChangeReviewBasis: basis } } }))
      .toThrowError(OrderChangeFinalVersionError);
  });

  it('refuses approvals with a different requester, target, or approved content', () => {
    const basis = captureOrderChangeReviewBasis(order, [line]);
    const exact = { ...approval, payload: { ...payload, orderChangeReviewBasis: basis } };
    for (const invalid of [
      { ...exact, requesterId: 'other' },
      { ...exact, targetId: 'other-order' },
      { ...exact, payload: { ...exact.payload, afterDelta: { unitPrice: '999' } } },
      { ...exact, status: 'pending' },
    ]) {
      expect(() => buildOrderChangeFinalVersion({ changeRequest: cr, order, orderLines: [line], approval: invalid })).toThrowError(OrderChangeFinalVersionError);
    }
  });
});

describe('order change amendment final proposal fingerprint', () => {
  const source = { ...cr, status: 'Pending', notes: cr.notes, finalContentFingerprint: 'c'.repeat(64) };
  const pendingApproval = { ...approval, status: 'pending', decidedAt: null };
  const proposal = { changeType: 'price', hitChangeTypes: ['unitPrice'], beforeSnapshot: { unitPrice: '100' },
    afterDelta: { unitPrice: '120' }, changeReason: '客户要求调整本订单价格', impactSummary: '需更新客户确认与收款金额' };
  const version = captureOrderChangeReviewBasis(order, [line]);
  const fingerprint = (override: Partial<Parameters<typeof orderChangeAmendmentProposalFingerprint>[0]> = {}) =>
    orderChangeAmendmentProposalFingerprint({ sourceChangeRequest: source, sourceApproval: pendingApproval,
      sourceApprovalReviewVersion: 'a'.repeat(64), currentSourceBasis: version, proposal, ...override });

  it('binds the old signed approval, current native source, normalized delta, reason and impact without a successor id', () => {
    const expected = fingerprint();
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint()).toBe(expected);
    expect(fingerprint({ sourceApprovalReviewVersion: 'b'.repeat(64) })).not.toBe(expected);
    expect(fingerprint({ currentSourceBasis: captureOrderChangeReviewBasis({ ...order, updatedAt: 8n }, [line]) })).not.toBe(expected);
    expect(fingerprint({ proposal: { ...proposal, afterDelta: { unitPrice: '121' } } })).not.toBe(expected);
    expect(fingerprint({ proposal: { ...proposal, changeReason: '客户重新核对后要求调整本订单价格' } })).not.toBe(expected);
    expect(fingerprint({ proposal: { ...proposal, impactSummary: '同步核对更新后的合同价和订单净额' } })).not.toBe(expected);
  });
});
