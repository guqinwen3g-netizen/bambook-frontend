vi.mock('../developmentQcRouting', async () => ({ ...await vi.importActual<any>('../developmentQcRouting'), resolveDevelopmentQcRouting: vi.fn(async()=>({})) }));
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ audit: vi.fn(), guard: vi.fn(async () => undefined), businessNow: vi.fn(() => Date.parse('2026-10-08T00:18:00.000Z')) }));
vi.mock('../../shared/businessClock', async () => ({ ...await vi.importActual<object>('../../shared/businessClock'), businessNowMs: mocks.businessNow }));
afterEach(() => vi.restoreAllMocks());
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: mocks.audit }));
vi.mock('../developmentConversionAuthority', () => ({ authorizeDevelopmentSource: vi.fn(async () => ({ actor: { userId: 'sales' }, development: { type: 'fabric' } })) }));
vi.mock('../developmentOperationalGuard', async () => {
  const actual: any = await vi.importActual('../developmentOperationalGuard');
  return { ...actual, assertDevelopmentOperationalWrite: mocks.guard };
});
import { recordDevelopmentSampleReturnResults, requestDevelopmentSampleQualityReview } from '../developmentSampleQualityService';

function fixture(sampleType = 'yardage') {
  mocks.audit.mockClear(); mocks.guard.mockClear();
  const batch: any = { id: 'batch-1', batchCode: 'SB-1', developmentCaseId: 'case-1', supplierRelationId: 'factory-1', supplierName: 'F',
    round: 1, sampleType, versionLabel: 'R1-A', sampleVersionId: 'version-1', status: 'making', updatedAt: 10n,
    returnedAt: null, deletedAt: null, attachments: null };
  const cards: any[] = []; const tx: any = { notification: {create:vi.fn()}, sampleBatch: {
    findFirst: vi.fn(async () => batch), update: vi.fn(async ({ data }: any) => Object.assign(batch, data)),
  }, developmentCase: { findFirst: vi.fn(async () => ({ id: 'case-1', code: 'DEV-1', type: sampleType === 'garment-round' ? 'garment' : 'fabric', deletedAt: null })) },
    developmentSampleQualityReview: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: any) => data) },
    developmentSampleVersion: { findFirst: vi.fn(async () => ({ id: 'version-1', developmentCaseId: 'case-1', supplierRelationId: 'factory-1', roundId: 'round-1', versionLabel: 'R1-A', versionKind: 'major' })) }, sampleCardItem: {
      create: vi.fn(async ({ data }: any) => { const row = { ...data, code: `SC-${cards.length + 1}` }; cards.push(row); return row; }),
      findMany: vi.fn(async () => cards.map(card => ({ ...card, physicalLengthQty: card.physicalLengthQty ?? null }))),
    },
    warehouse: { findUnique: vi.fn(async () => ({ id: 'warehouse-1', isActive: true, deletedAt: null })) },
    $queryRaw: vi.fn(async () => [{ id: batch.id }]) };
  const prisma: any = { $transaction: async (run: any) => run(tx) };
  return { batch, cards, tx, prisma };
}

describe('Development first physical sample registration', () => {
  it.each(['2026-10-07T08:00:00.000Z', '2026-10-09T08:00:00.000Z'])('separates actual return/receipt time from wall-clock creation/CAS, with the process clock at %s', async wallIso => {
    const wallMs = Date.parse(wallIso), businessMs = mocks.businessNow();
    const wall = vi.spyOn(Date, 'now').mockReturnValue(wallMs), f = fixture('garment-round');
    const input = { requestKey: 'return-clock-original', expectedBatchUpdatedAt: '10', actualQuantity: '2', actualUnit: '件' };
    const result = await recordDevelopmentSampleReturnResults({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', input });
    expect(result).toMatchObject({ ok: true, data: { batch: { returnedAt: businessMs, updatedAt: wallMs } } });
    expect(f.cards).toHaveLength(2);
    for (const card of f.cards) expect(card).toMatchObject({ createdAt: BigInt(wallMs), updatedAt: BigInt(wallMs),
      receiptSnapshot: { receivedAt: String(businessMs), recordedAt: String(wallMs), batchUpdatedAt: String(wallMs) } });
    const original = structuredClone(f.cards), count = mocks.audit.mock.calls.length;
    wall.mockReturnValue(wallMs + 60_000);
    expect(await recordDevelopmentSampleReturnResults({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', input })).toEqual(result);
    expect(f.cards).toEqual(original); expect(mocks.audit).toHaveBeenCalledTimes(count);
    expect(mocks.audit.mock.calls.find(([value]) => value.operation === 'record_development_sample_return')?.[0].after.returnedAt).toBe(String(businessMs));
  });
  it('creates one shared Sample Management card with exact decimal meters in the return transaction', async () => {
    const f = fixture();
    const result = await recordDevelopmentSampleReturnResults({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', input: {
      requestKey: 'return-1', expectedBatchUpdatedAt: '10', actualQuantity: '10.5', actualUnit: '米',
    } });
    expect(result.ok).toBe(true);
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0].batchId).toBe('batch-1'); expect(f.cards[0].devCaseId).toBe('case-1');
    expect(f.cards[0]).toMatchObject({ unit: '米', quantity: 1, availableQty: 1,
      receiptSnapshot: { version: 2, batchId: 'batch-1', actualQuantity: '10.5', actualUnit: '米' } });
    expect(f.cards[0].physicalLengthQty.toString()).toBe('10.5');
    expect(f.cards[0].availableLengthQty.toString()).toBe('10.5');
    expect(mocks.audit).toHaveBeenCalledTimes(2);
  });
  it('refuses an over-precise or missing meter receipt before changing the sample batch', async () => {
    const f = fixture();
    const result = await recordDevelopmentSampleReturnResults({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', input: {
      requestKey: 'return-2', expectedBatchUpdatedAt: '10', actualQuantity: '10.12345', actualUnit: '米',
    } });
    expect(result.ok).toBe(false);
    expect(f.tx.sampleBatch.update).not.toHaveBeenCalled();
    expect(f.tx.sampleCardItem.create).not.toHaveBeenCalled();
  });
  it('retains an explicitly supplied real warehouse and rack in the physical card and receipt', async () => {
    const f = fixture();
    const input = { requestKey: 'return-position', expectedBatchUpdatedAt: '10', actualQuantity: '10.5', actualUnit: '米',
      warehouseId: 'warehouse-1', location: ' 样品架 A-02 ', locationDetail: { zone: '样品间', shelf: 'A', bin: '02' } };
    const result = await recordDevelopmentSampleReturnResults({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', input });
    expect(result.ok).toBe(true);
    expect(f.tx.warehouse.findUnique).toHaveBeenCalledWith({ where: { id: 'warehouse-1' } });
    expect(f.cards[0]).toMatchObject({ warehouseId: 'warehouse-1', location: '样品架 A-02',
      locationDetail: { zone: '样品间', shelf: 'A', level: null, bin: '02' },
      receiptSnapshot: { warehouseId: 'warehouse-1', location: '样品架 A-02' } });
    const replay = await recordDevelopmentSampleReturnResults({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', input });
    expect(replay.ok).toBe(true); expect(f.cards).toHaveLength(1);
    const conflict = await recordDevelopmentSampleReturnResults({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', input: { ...input, location: 'B-03' } });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'RETURN_RESULTS_ALREADY_RECORDED' } });
  });
  it('leaves unknown placement null and refuses an unavailable warehouse before any return or stock fact', async () => {
    const f = fixture();
    f.tx.warehouse.findUnique.mockResolvedValue(null);
    const result = await recordDevelopmentSampleReturnResults({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', input: {
      requestKey: 'return-bad-position', expectedBatchUpdatedAt: '10', actualQuantity: '10.5', actualUnit: '米', warehouseId: 'missing',
    } });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.tx.sampleBatch.update).not.toHaveBeenCalled(); expect(f.cards).toHaveLength(0);
    const unknown = fixture();
    const saved = await recordDevelopmentSampleReturnResults({ prisma: unknown.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', input: {
      requestKey: 'return-unknown-position', expectedBatchUpdatedAt: '10', actualQuantity: '10.5', actualUnit: '米',
    } });
    expect(saved.ok).toBe(true); expect(unknown.cards[0]).toMatchObject({ warehouseId: null, location: null });
    expect(unknown.tx.warehouse.findUnique).not.toHaveBeenCalled();
  });
  it('creates one independently numbered sample-library record per returned garment', async () => {
    const f = fixture('garment-round');
    const result = await recordDevelopmentSampleReturnResults({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', input: {
      requestKey: 'garment-return-1', expectedBatchUpdatedAt: '10', actualQuantity: '2', actualUnit: '件',
    } });
    expect(result.ok).toBe(true);
    expect(f.cards).toHaveLength(2);
    expect(f.cards.map(card => card.quantity)).toEqual([1, 1]);
    expect(new Set(f.cards.map(card => card.id)).size).toBe(2);
    expect(new Set(f.cards.map(card => card.code)).size).toBe(2);
    expect(f.cards.map(card => card.receiptSnapshot.physicalItemIndex)).toEqual([1, 2]);
    expect(f.cards.map(card => card.receiptSnapshot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ physicalItemCount: 2, initialPhysicalCardCount: 1 }),
    ]));
    expect(mocks.audit).toHaveBeenCalledTimes(3); // batch fact + each physical garment
    const replay = await recordDevelopmentSampleReturnResults({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', input: {
      requestKey: 'garment-return-1', expectedBatchUpdatedAt: '10', actualQuantity: '2', actualUnit: '件',
    } });
    expect(replay.ok).toBe(true);
    expect(f.cards).toHaveLength(2);
    expect(mocks.audit).toHaveBeenCalledTimes(3);
  });
  it('binds the QC request to the exact physical SampleCardItem records', async () => {
    const f = fixture('garment-round');
    await recordDevelopmentSampleReturnResults({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', input: {
      requestKey: 'garment-return-qc', expectedBatchUpdatedAt: '10', actualQuantity: '2', actualUnit: '件',
    } });
    const result = await requestDevelopmentSampleQualityReview({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', requestKey: 'qc-request-1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.item.physicalItems).toEqual(f.cards.map(card => expect.objectContaining({ id: card.id, code: card.code })));
  });
  it('does not allow QC initiation when the synchronized physical record is missing', async () => {
    const f = fixture();
    Object.assign(f.batch, { returnedAt: 12n, returnRequestKey: 'return-existing' });
    const result = await requestDevelopmentSampleQualityReview({ prisma: f.prisma, caseId: 'case-1', batchId: 'batch-1', actorId: 'sales', requestKey: 'qc-request-missing' });
    expect(result).toMatchObject({ ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED' } });
    expect(f.tx.developmentSampleQualityReview.create).not.toHaveBeenCalled();
  });
});
