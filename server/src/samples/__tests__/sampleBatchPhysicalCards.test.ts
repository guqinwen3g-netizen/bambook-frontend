/** Behavioral transaction seams. Real lock/CAS/audit rollback evidence belongs
 * to sampleBatchPhysicalCardRealDb.test.ts, not this in-memory transaction.
 * Independent rule: DR-D6/2026-09-16 keeps physical Int cards separate from
 * Decimal sample length; DR-054 receipt does not approve a design or QC gate.
 */
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createSampleRoomService } from '../sampleRoomService';
import { parseActualSampleBatchQuantity } from '../../development/fabricDevelopmentService';
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

function fixture(options: { actual?: string | null; legacy?: any; state?: string; auditFailure?: string; sampleType?: string; newWorkflow?: boolean } = {}) {
  const batch = { id: 'B1', batchCode: 'SB-TEST-1', developmentCaseId: 'D1', sampleType: options.sampleType ?? 'yardage',
    round: 1, supplierRelationId: 'F1', sampleVersionId: options.newWorkflow ? 'SV1' : null, returnedAt: options.newWorkflow ? BigInt(2) : null,
    status: options.newWorkflow ? 'making' : 'pending', confirmStatus: 'unconfirmed', approvedBy: null, approvedAt: null, qcStatus: null,
    actualQuantity: options.actual === null ? null : new Prisma.Decimal(options.actual ?? '8'), actualUnit: 'M',
    planQuantity: new Prisma.Decimal('20'), planUnit: 'M', updatedAt: BigInt(1), createdAt: BigInt(1), deletedAt: null };
  const state = { batch, items: options.legacy ? [{ ...options.legacy }] : [] as any[], audits: [] as any[] };
  const tx: any = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'D1' }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    developmentLifecycleEvent: { findFirst: vi.fn().mockResolvedValue(options.state ? { state: options.state } : null) },
    developmentCase: { findFirst: vi.fn().mockResolvedValue({ id: 'D1', code: 'DEV-1', name: 'Material', type: options.sampleType === 'garment-round' ? 'garment' : 'fabric' }) },
    sampleBatch: {
      findFirst: vi.fn(async () => state.batch),
      update: vi.fn(async ({ data }: any) => { Object.assign(state.batch, data); return state.batch; }),
    },
    sampleCardItem: {
      count: vi.fn(async () => state.items.length),
      findMany: vi.fn(async ({ where }: any) => state.items.filter(row => row.batchId === where.batchId).sort((a, b) => a.id.localeCompare(b.id))),
      findFirst: vi.fn(async ({ where }: any) => state.items.find(row => where.id ? row.id === where.id : row.batchId === where.batchId) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { ...data, deletedAt: null }; state.items.push(row); return row; }),
    },
    productAsset: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async ({ data }: any) => { if (data.action === options.auditFailure) throw Error('Injected audit storage failure'); state.audits.push(data); return data; }) },
  };
  const prisma: any = { ...tx, $transaction: vi.fn(async (action: any) => {
    const before = { batch: { ...state.batch }, items: state.items.map(row => ({ ...row })), audits: [...state.audits] };
    try { return await action(tx); } catch (error) { Object.assign(state, before); throw error; }
  }) };
  const service = createSampleRoomService(prisma);
  const input = { receiptVersion: 2 as const, cardType: (options.sampleType === 'garment-round' ? 'garment' : 'fabric') as 'garment' | 'fabric', expectedSourceRound: 1, expectedCaseId: 'D1', expectedFactoryId: 'F1', physicalCardCount: 3, actualQuantity: '2.75', actualUnit: 'M', expectedBatchUpdatedAt: '1' };
  return { state, tx, prisma, service, input, register: (patch: any = {}) => service.registerReceivedBatchCards('B1', { ...input, ...patch }, 'user1') };
}
describe('Explicit physical sample receipt', () => {
  it('2.75 metres and 3 cards remain independent facts in one transaction with both audits', async () => {
    const f = fixture(); const result = await f.register();
    expect(result).toMatchObject({ ok: true, data: { created: true, receiptStatus: 'verified', batch: { actualQuantity: '2.75', round: 1, supplierRelationId: 'F1', status: 'pending', confirmStatus: 'unconfirmed', qcStatus: null }, item: { quantity: 3, availableQty: 3, unit: 'PC' } } });
    expect(f.state.batch.actualQuantity?.toString()).toBe('2.75'); expect(f.state.batch.planQuantity.toString()).toBe('20');
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.state.items[0].receiptSnapshot).toMatchObject({ batchId: 'B1', initialPhysicalCardCount: 3, actualQuantity: '2.75', actualUnit: 'M', physicalUnit: 'PC', receivedBy: 'user1' });
    expect(f.state.audits.map(row => row.action)).toEqual(['update_sample_batch', 'sample_card_create']);
    expect(f.state.audits[1].detail.after.receiptSnapshot).toEqual(f.state.items[0].receiptSnapshot);
    const queries = f.tx.$queryRaw.mock.calls.map(([query]: any[]) => query.sql);
    expect(queries[0]).toContain('DevelopmentCase'); expect(queries[1]).toContain('SampleBatch');
  });
  it.each([null, '0', '0.75'])('actual length %s does not invent a card and explicit zero stays zero', async actual => {
    const f = fixture(); expect(await f.register({ physicalCardCount: 0, actualQuantity: actual })).toMatchObject({ ok: true, data: { item: { quantity: 0, availableQty: 0, unit: 'PC' }, batch: { actualQuantity: actual } } });
  });
  it('garment-round receipt creates one separately coded stock row for each physical piece', async () => {
    const f = fixture({ sampleType: 'garment-round' });
    const result = await f.register({ actualQuantity: null, actualUnit: null, physicalCardCount: 2 });
    expect(result).toMatchObject({ ok: true, data: { item: { cardType: 'garment', quantity: 1 }, items: [
      { cardType: 'garment', quantity: 1, availableQty: 1, receiptSnapshot: { physicalItemIndex: 1, physicalItemCount: 2, initialPhysicalCardCount: 1 } },
      { cardType: 'garment', quantity: 1, availableQty: 1, receiptSnapshot: { physicalItemIndex: 2, physicalItemCount: 2, initialPhysicalCardCount: 1 } },
    ], batch: { sampleType: 'garment-round', round: 1, supplierRelationId: 'F1', status: 'pending', confirmStatus: 'unconfirmed', qcStatus: null } } });
    expect(f.state.items).toHaveLength(2);
    expect(new Set(f.state.items.map(item => item.code)).size).toBe(2);
  });
  it('garment receipt cannot be misclassified as fabric', async () => {
    const f = fixture({ sampleType: 'garment-round' });
    expect(await f.register({ cardType: 'fabric' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(f.state.items).toHaveLength(0);
    expect(f.state.audits).toHaveLength(0);
  });
  it('garment receipt retry reads every original item and never recreates or restores pieces', async () => {
    const f = fixture({ sampleType: 'garment-round' });
    const receipt = { actualQuantity: null, actualUnit: null, physicalCardCount: 2 };
    await f.register(receipt);
    f.state.items.forEach(item => { item.availableQty = 0; item.status = 'shipped'; });
    f.state.batch.updatedAt += BigInt(10);
    const writes = [f.tx.sampleCardItem.create.mock.calls.length, f.tx.auditLog.create.mock.calls.length];
    const result = await f.register(receipt);
    expect(result).toMatchObject({ ok: true, data: { created: false, items: [
      { quantity: 1, availableQty: 0, status: 'shipped' },
      { quantity: 1, availableQty: 0, status: 'shipped' },
    ] } });
    expect(f.state.items).toHaveLength(2);
    expect([f.tx.sampleCardItem.create.mock.calls.length, f.tx.auditLog.create.mock.calls.length]).toEqual(writes);
  });
  it.each([undefined, null, '3', 2.75, -1, 2147483648, Number.NaN])('invalid physical count %s writes no source, card or audit', async count => {
    const f = fixture(); expect(await f.register({ physicalCardCount: count })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
    expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(f.tx.sampleBatch.update).not.toHaveBeenCalled(); expect(f.tx.sampleCardItem.create).not.toHaveBeenCalled(); expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('same substantive retry survives timestamp/stock changes and never restores borrowed stock', async () => {
    const f = fixture(); await f.register(); const snapshot = f.state.items[0].receiptSnapshot;
    f.state.items[0].availableQty = 1; f.state.items[0].quantity = 4; f.state.batch.updatedAt += BigInt(10);
    expect(await f.register()).toMatchObject({ ok: true, data: { created: false, item: { quantity: 4, availableQty: 1 } } });
    expect(f.state.items).toHaveLength(1); expect(f.state.audits).toHaveLength(2); expect(f.state.items[0].receiptSnapshot).toEqual(snapshot);
  });
  it.each([{ physicalCardCount: 4 }, { actualQuantity: '2.5' }, { actualUnit: 'YD' }])('different receipt fact %j cannot overwrite initial custody', async patch => {
    const f = fixture(); await f.register();
    expect(await f.register(patch)).toMatchObject({ ok: false, error: { code: 'BATCH_RECEIPT_CONFLICT', status: 409 } });
    expect(f.state.items).toHaveLength(1); expect(f.state.audits).toHaveLength(2); expect(f.state.batch.actualQuantity?.toString()).toBe('2.75');
  });
  it('source length changed after receipt is a conflict even when old request is replayed', async () => {
    const f = fixture(); await f.register(); f.state.batch.actualQuantity = new Prisma.Decimal('2.5');
    expect(await f.register()).toMatchObject({ ok: false, error: { code: 'BATCH_RECEIPT_CONFLICT' } }); expect(f.state.items[0].receiptSnapshot.actualQuantity).toBe('2.75');
  });
  it('legacy inferred and archived source rows remain explicitly unverified instead of recreating 1', async () => {
    const f = fixture({ legacy: { id: 'OLD', batchId: 'B1', quantity: 1, availableQty: 1, receiptSnapshot: null, deletedAt: BigInt(9) } });
    expect(await f.register()).toMatchObject({ ok: false, error: { code: 'BATCH_CARDS_LEGACY_UNVERIFIED', status: 409 } }); expect(f.state.items).toHaveLength(1); expect(f.state.audits).toHaveLength(0);
  });
  it('does not provide a second create path for new development samples before QC', async () => {
    const f = fixture({ newWorkflow: true });
    const result = await f.register();
    expect(result).toMatchObject({ ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED', status: 409 } });
    expect(f.state.items).toHaveLength(0);
    expect(f.tx.sampleCardItem.create).not.toHaveBeenCalled();
    expect(f.tx.sampleBatch.update).not.toHaveBeenCalled();
    expect(f.state.audits).toHaveLength(0);
  });
  it('stale version or source reassignment fails before any business mutation', async () => {
    const f = fixture(); expect(await f.register({ expectedBatchUpdatedAt: '0' })).toMatchObject({ ok: false, error: { code: 'BATCH_RECEIPT_STALE' } });
    f.tx.sampleBatch.findFirst.mockResolvedValueOnce({ ...f.state.batch }).mockResolvedValueOnce({ ...f.state.batch, developmentCaseId: 'OTHER' });
    expect(await f.register()).toMatchObject({ ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED' } }); expect(f.tx.sampleBatch.update).not.toHaveBeenCalled();
  });
  it.each(['paused', 'closed'])('the existing %s development operational gate stays intact', async state => {
    const f = fixture({ state }); expect(await f.register()).toMatchObject({ ok: false, error: { code: state === 'paused' ? 'DEVELOPMENT_PAUSED' : 'DEVELOPMENT_CLOSED' } });
    expect(f.tx.sampleBatch.update).not.toHaveBeenCalled(); expect(f.tx.sampleCardItem.create).not.toHaveBeenCalled(); expect(f.state.audits).toHaveLength(0);
  });
  it.each(['update_sample_batch', 'sample_card_create'])('mandatory %s audit failure aborts the outer operation', async action => {
    const f = fixture({ auditFailure: action }); expect(await f.register()).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', status: 500 } });
    expect(f.state.items).toEqual([]); expect(f.state.audits).toEqual([]); expect(f.state.batch.actualQuantity?.toString()).toBe('8');
    if (action === 'update_sample_batch') expect(f.tx.sampleCardItem.create).not.toHaveBeenCalled();
  });
  it('canonical source strings preserve all Decimal(18,4) digits; corrupt values are never clamped or unknown', () => {
    expect(parseActualSampleBatchQuantity('12345678901234.1234')?.toString()).toBe('12345678901234.1234');
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '-0.5', '', '1e3', '1.23456', '123456789012345', {}, true]) expect(() => parseActualSampleBatchQuantity(value)).toThrow('实际数量');
  });
  it('invalid native Decimal input remains400 without entering a transaction',async()=>{
    const f=fixture();expect(await f.register({actualQuantity:'-0.5'})).toMatchObject({ok:false,error:{code:'VALIDATION_FAILED',status:400}});expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(['NOT_FOUND','BATCH_RECEIPT_STALE','INVALID_INPUT'])('storage carrying %s with an arbitrary status cannot become a public receipt refusal',async code=>{
    const f=fixture();f.tx.sampleBatch.findFirst.mockRejectedValue(Object.assign(new Error('private-sql-diagnostic'),{code,status:400,statusCode:400}));
    const res=await f.register();expect(res).toMatchObject({ok:false,error:{code:'INTERNAL_ERROR',status:500}});expect(JSON.stringify(res)).not.toContain('private-sql');expect(f.state.items).toHaveLength(0);expect(f.state.audits).toHaveLength(0);
  });
});
