import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { orderMainSnapshotFingerprint, verifyOrderMainFrozenEvidence } from '../orderMainApprovalEvidence';
const order = { id: 'order', ownerId: 'sales', status: 'Pending', lines: [{ id: 'line', quantity: '100', unit: 'M' }] };
const snapshot = { order, businessLine: 'fabric' };
const legacy = () => ({ targetId: order.id, payload: { snapshot, businessLine: 'fabric', contentFingerprint: crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') } });
describe('main approval immutable frozen evidence', () => {
  it('authenticates canonical snapshots after JSONB-style key reordering', () => {
    const approval = legacy();
    Object.assign(approval.payload, { contentFingerprintAlgorithm: 'canonical_v1', contentFingerprint: orderMainSnapshotFingerprint(snapshot),
      snapshot: { businessLine: 'fabric', order: { lines: [{ unit: 'M', quantity: '100', id: 'line' }], status: 'Pending', ownerId: 'sales', id: 'order' } } });
    expect(verifyOrderMainFrozenEvidence(approval, order)).toBe('verified');
    approval.payload.snapshot.order.lines[0].quantity = '101';
    expect(() => verifyOrderMainFrozenEvidence(approval, order)).toThrow('指纹不匹配');
  });
  it('verifies a legacy digest only when a precise reconstruction really matches', () => {
    const approval = legacy();
    approval.payload.snapshot = { businessLine: 'fabric', order: { lines: [{ unit: 'M', quantity: '100', id: 'line' }], status: 'Pending', ownerId: 'sales', id: 'order' } };
    expect(verifyOrderMainFrozenEvidence(approval, order)).toBe('legacy_verified');
    approval.payload.contentFingerprint = '0'.repeat(64);
    expect(verifyOrderMainFrozenEvidence(approval, order)).toBe('legacy_unverifiable');
  });
  it('rejects a source identity mismatch even in old history', () => {
    const approval = legacy(); approval.targetId = 'another-order';
    expect(() => verifyOrderMainFrozenEvidence(approval, order)).toThrow('原件不完整');
  });
});
