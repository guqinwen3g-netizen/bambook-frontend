import { beforeEach, describe, expect, it, vi } from 'vitest';
const facts = vi.hoisted(() => ({ actor: vi.fn(), scope: vi.fn(), completion: vi.fn(), quality: vi.fn(), final: vi.fn(), reportHash: vi.fn() }));
vi.mock('../shipping/shipmentDocumentSource', () => ({ currentDocumentActor: facts.actor, documentSourceFingerprint: (value: unknown) => JSON.stringify(value) }));
vi.mock('../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: facts.scope }));
vi.mock('./productionCompletionService', () => ({ readOrderLineProductionCompletion: facts.completion }));
vi.mock('../qc/productionQcSizeCoverage', () => ({ readProductionQcReleaseCoverage: facts.quality }));
vi.mock('../qc/qcPhysicalCoverage', () => ({ latestCurrentScopedFinal: facts.final }));
vi.mock('../qc/qcReportReadProjection', () => ({ reportContentFingerprint: facts.reportHash }));
import { readProductionProgressBoard } from './productionProgressService';

const actor = { userId: 'owner', roles: ['sales'], permissions: ['production:read', 'orders:read', 'qc:read'] } as any;
function database() {
  const order = { id: 'O', code: 'FAB-001', customer: 'Buyer', businessLine: 'fabric', dueDate: '2099-01-01' };
  const db: any = { order: { findMany: vi.fn(async () => [order]) }, orderLine: { findMany: vi.fn(async () => [{ id: 'L', orderId: 'O', description: 'Fabric' }]) },
    relation: { findFirst: vi.fn(async () => ({ name: 'Factory' })) }, productionStage: { upsert: vi.fn(), update: vi.fn() }, auditLog: { create: vi.fn() } };
  db.$transaction = async (work: any) => work(db); return db;
}
const branch = { productionBatchId: 'B', productionBatchRevision: 2, factoryRelationId: 'F', plannedQty: '100.0625', actualQty: null,
  unit: 'M', completionId: null, completedAt: null };
const completion = (branches: any[] = []) => ({ status: 'incomplete', productionComplete: false, actualQty: null, contractQty: '100.0625', unit: 'M',
  tolerance: { status: 'pending' }, blockers: [], branches });
const quality = { satisfied: true, failureReasons: [], sizeCoverage: { applicable: false, available: true, actualSizes: [], missingSizes: [], failedSizes: [] },
  productionQcIssues: { available: true, issues: [] } };
describe('actual production progress remains distinct from legacy stages and shipment/finance', () => {
  beforeEach(() => {
    vi.clearAllMocks(); facts.actor.mockResolvedValue(actor); facts.scope.mockResolvedValue({ ownerId: actor.userId });
    facts.completion.mockResolvedValue(completion()); facts.quality.mockResolvedValue(quality); facts.final.mockResolvedValue(null); facts.reportHash.mockResolvedValue('content-current');
  });
  it('does not turn missing batches into completed work or write stage skeletons', async () => {
    const db = database(), result = await readProductionProgressBoard(db, actor);
    expect(result.items[0].state).toBe('not_started'); expect(result.stats.fullyCompleted).toBe(0);
    expect(db.productionStage.upsert).not.toHaveBeenCalled(); expect(db.productionStage.update).not.toHaveBeenCalled(); expect(db.auditLog.create).not.toHaveBeenCalled();
  });
  it('keeps a fabric branch without a genuine current Final report at incomplete QC', async () => {
    facts.completion.mockResolvedValue(completion([branch]));
    const result = await readProductionProgressBoard(database(), actor);
    expect(result.items[0].lines[0].branches[0]).toMatchObject({ plannedQty: '100.0625', actualQty: null, qcState: 'incomplete' });
    expect(result.stats.completedBranchCount).toBe(0);
  });
  it('uses exact actual completion including explicit zero, while QC waits for the business resume fact', async () => {
    facts.completion.mockResolvedValue({ ...completion([{ ...branch, actualQty: '0', completionId: 'COMP', completedAt: '1' }]), productionComplete: true, actualQty: '0', status: 'out_of_tolerance', tolerance: { status: 'under_tolerance' } });
    facts.quality.mockResolvedValue({ ...quality, satisfied: false, productionQcIssues: { available: true, issues: [{ status: 'waiting_business_resume' }] }, failureReasons: ['复验已通过，等待业务明确恢复。'] });
    const result = await readProductionProgressBoard(database(), actor);
    expect(result.items[0].state).toBe('production_complete'); expect(result.items[0].lines[0].actualQty).toBe('0');
    expect(result.items[0].lines[0].branches[0].qcState).toBe('waiting_business_resume'); expect(result.stats.pausedBranchCount).toBe(1);
  });
  it('does not report changed or missing report contents as a current QC pass', async () => {
    facts.completion.mockResolvedValue(completion([branch])); facts.final.mockResolvedValue({ id: 'QC', result: 'pass', contentFingerprint: 'old-content' });
    const result = await readProductionProgressBoard(database(), actor);
    expect(result.items[0].lines[0].branches[0].qcState).toBe('unknown');
  });
  it('separates a current professional pass from the business decision', async () => {
    facts.completion.mockResolvedValue(completion([branch]));
    facts.final.mockResolvedValue({ id: 'QC', result: 'pass', contentFingerprint: 'content-current', approvedAt: null, approvedByBusiness: false });
    const result = await readProductionProgressBoard(database(), actor);
    expect(result.items[0].lines[0].branches[0]).toMatchObject({ qcState: 'clear', businessDecision: 'pending', qcReportId: 'QC' });
  });
  it('keeps restricted QC facts undisclosed and unknown for a production-only reader', async () => {
    facts.actor.mockResolvedValue({ ...actor, authorizationLoaded: true, permissions: ['production:read', 'orders:read'] });
    facts.completion.mockResolvedValue(completion([branch]));
    const result = await readProductionProgressBoard(database(), actor);
    expect(result.items[0].lines[0].branches[0]).toMatchObject({ qcState: 'unknown', businessDecision: 'unknown', qcReportId: null, qualityCoverage: null });
    expect(facts.quality).not.toHaveBeenCalled(); expect(facts.final).not.toHaveBeenCalled();
  });
  it('fails the whole read if current authority disappears before disclosure', async () => {
    facts.actor.mockResolvedValueOnce(actor).mockRejectedValueOnce(new Error('current account disabled'));
    await expect(readProductionProgressBoard(database(), actor)).rejects.toThrow('current account disabled');
  });
});
