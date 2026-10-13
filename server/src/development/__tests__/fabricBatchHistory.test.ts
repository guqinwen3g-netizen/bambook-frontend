/** Pure eligibility and storage-bound audit checks. No PG execution claimed. */
import { describe, expect, it, vi } from 'vitest';
import { fabricBatchEligibility, checkFabricCommand, fabricCommandFingerprint, assertFabricBatchEvidence, assertFabricSealEligible } from '../fabricBatchHistory';
const batch = (patch: any = {}) => ({ id: 'B1', developmentCaseId: 'D1', sampleType: 'lab-dip', round: 1, status: 'approved', customerStatus: 'approved', approvedAt: 1n, approvedBy: 'u1', convertedProductAssetId: 'A1', ...patch });
const event = (kind: string, patch: any = {}) => ({ id: `event-${kind}`, auditId: `audit-${kind}`, actorId: 'u1', at: '1', kind, round: 1, requestKey: null, requestFingerprint: null, commandInput: null, before: {}, after: {}, ...patch });
const history = (...events: any[]) => ({ fabricHistory: { schemaVersion: 1, revision: events.length, events } });
describe('fabric permission is current while old facts are retained', () => {
  it.each(['needs_recast', 'rejected'])('current %s dominates a retained approved/converted projection', customerStatus => {
    expect(fabricBatchEligibility(batch({ customerStatus })).eligible).toBe(false);
    expect(fabricBatchEligibility(batch({ customerStatus })).assetCurrent).toBe(false);
  });
  it('status and design-confirmation tags without recorded legacy approval cannot authorize', () => {
    expect(fabricBatchEligibility(batch({ approvedAt: null, approvedBy: null, confirmStatus: 'confirmed' })).eligible).toBe(false);
  });
  it('new feedback requires renewed approval, and the old asset cannot borrow that renewed approval', () => {
    const approve = event('approve'), convert = event('convert', { after: { convertedProductAssetId: 'A1' } });
    expect(fabricBatchEligibility(batch({ attachments: history(approve, convert) })).assetCurrent).toBe(true);
    const feedback = event('feedback', { after: { customerStatus: 'approved' } });
    expect(fabricBatchEligibility(batch({ attachments: history(approve, convert, feedback) })).eligible).toBe(false);
    const renewed = event('approve', { id: 'renewed' });
    expect(fabricBatchEligibility(batch({ attachments: history(approve, convert, feedback, renewed) })).assetCurrent).toBe(false);
  });
  it('same request identity acknowledges exact original input; changed content and stale revision reject', () => {
    const input = { requestKey: 'original', expectedRevision: 0, expectedRound: 1, status: 'needs_recast' };
    const fact = event('feedback', { requestKey: input.requestKey, requestFingerprint: fabricCommandFingerprint('feedback', input) });
    const stored = batch({ attachments: history(fact) });
    expect(checkFabricCommand(stored, 'u1', 'feedback', input)).toBe(fact);
    expect(() => checkFabricCommand(stored, 'u1', 'feedback', { ...input, status: 'approved' })).toThrowError(expect.objectContaining({ code: 'REQUEST_CONFLICT' }));
    expect(() => checkFabricCommand(stored, 'u1', 'feedback', { ...input, requestKey: 'other' })).toThrowError(expect.objectContaining({ code: 'DEVELOPMENT_SOURCE_CHANGED' }));
    expect(() => checkFabricCommand(stored, 'u1', 'feedback', { ...input, expectedRevision: -1 })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
  it('PG JSON key ordering is irrelevant, but missing or altered approval audit cannot authorize', async () => {
    const approve = event('approve', { before: { round: 1, status: 'sent' }, after: { round: 1, status: 'approved' } });
    const db = { auditLog: { findFirst: vi.fn(async () => ({ detail: { after: { roundFact: { kind: 'approve', before: { status: 'sent', round: 1 }, after: { status: 'approved', round: 1 } } } } })) } };
    await expect(assertFabricBatchEvidence(db, batch({ attachments: history(approve) }))).resolves.toBeUndefined();
    db.auditLog.findFirst.mockResolvedValue(null as any);
    await expect(assertFabricBatchEvidence(db, batch({ attachments: history(approve) }))).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });
  it('an old seal does not become current after a later feedback and renewed approval in the same round', async () => {
    const approve = event('approve'), seal = event('seal', { after: { sealId: 'S1' } }), feedback = event('feedback'), renewed = event('approve', { id: 'renewed' });
    const db = { sampleBatch: { findMany: vi.fn(async () => [batch({ attachments: history(approve, seal, feedback, renewed) })]) }, sealSampleBatch: { findMany: vi.fn(async () => [{ sampleBatchId: 'B1' }]) },
      auditLog: { findFirst: vi.fn(async () => ({ detail: { after: { roundFact: { kind: 'approve', before: {}, after: {} } } } })) } };
    await expect(assertFabricSealEligible(db, { id: 'S1', status: 'sealed', developmentCaseId: 'D1' })).rejects.toMatchObject({ code: 'DEVELOPMENT_NOT_READY' });
  });
});
