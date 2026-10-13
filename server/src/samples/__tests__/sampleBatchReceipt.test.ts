/** Actual custody service with transaction/storage seams. This is not native
 * PostgreSQL/API evidence; the fixture retains rollback and immutable receipts. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createSampleRoomService } from '../sampleRoomService';
import { readBatchReceiptSnapshot } from '../sampleBatchReceipt';
const clock = vi.hoisted(() => ({ businessNow: vi.fn(() => Date.parse('2026-10-08T00:18:00.000Z')) }));
vi.mock('../../shared/businessClock', async () => ({ ...await vi.importActual<object>('../../shared/businessClock'), businessNowMs: clock.businessNow }));
afterEach(() => vi.restoreAllMocks());
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

function fixture(garment = false) {
  const state = {
    development: { id: 'D1', code: 'DEV-1', type: garment ? 'garment' : 'fabric', deletedAt: null },
    batch: { id: 'B1', batchCode: 'SB-1', developmentCaseId: 'D1', supplierRelationId: 'F1', round: 1,
      sampleType: garment ? 'garment-round' : 'yardage', status: 'pending', qcStatus: null, confirmStatus: 'unconfirmed',
      actualQuantity: null as Prisma.Decimal | null, actualUnit: null as string | null, updatedAt: BigInt(1), deletedAt: null },
    items: [] as any[], audits: [] as any[],
  };
  const tx: any = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]), $executeRaw: vi.fn().mockResolvedValue(1),
    developmentLifecycleEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    sampleSource: { findMany: vi.fn().mockResolvedValue([]) },
    developmentCase: { findFirst: vi.fn(async () => state.development) },
    sampleBatch: { findFirst: vi.fn(async () => state.batch), update: vi.fn(async ({ data }: any) => Object.assign(state.batch, data)) },
    sampleCardItem: {
      count: vi.fn(async () => state.items.length),
      findMany: vi.fn(async ({ where }: any) => state.items.filter(row => row.batchId === where.batchId).sort((a, b) => a.id.localeCompare(b.id))),
      findFirst: vi.fn(async ({ where }: any) => state.items.find(row => where.id ? row.id === where.id : row.batchId === where.batchId) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { ...data, deletedAt: null }; state.items.push(row); return row; }),
    },
    productAsset: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async ({ data }: any) => { state.audits.push(data); return data; }) },
  };
  const prisma: any = { ...tx, $transaction: vi.fn(async (callback: any) => {
    const before = { development: { ...state.development }, batch: { ...state.batch }, items: state.items.map(row => ({ ...row })), audits: [...state.audits] };
    try { return await callback(tx); } catch (error) { Object.assign(state, before); throw error; }
  }) };
  const input: any = { receiptVersion: 2, physicalCardCount: 2, cardType: garment ? 'garment' : 'fabric', expectedSourceRound: 1, expectedCaseId: 'D1', expectedFactoryId: 'F1', expectedBatchUpdatedAt: '1', actualQuantity: null, actualUnit: null };
  const service = createSampleRoomService(prisma);
  return { state, tx, prisma, input, register: (patch: any = {}) => service.registerReceivedBatchCards('B1', { ...input, ...patch }, 'operator') };
}

describe('Precise batch custody receipt', () => {
  it.each(['2026-10-07T08:00:00.000Z', '2026-10-09T08:00:00.000Z'])('records a new legacy-entry receipt with separate occurrence/creation at wall time %s and never refreshes it on replay', async wallIso => {
    const wallMs = Date.parse(wallIso), wall = vi.spyOn(Date, 'now').mockReturnValue(wallMs), f = fixture();
    expect(await f.register()).toMatchObject({ ok: true, data: { item: { createdAt: BigInt(wallMs), updatedAt: BigInt(wallMs),
      receiptSnapshot: { receivedAt: String(clock.businessNow()), recordedAt: String(wallMs) } } } });
    const before = structuredClone(f.state.items), receipt = structuredClone(before[0].receiptSnapshot);
    expect(readBatchReceiptSnapshot(receipt)).toEqual(receipt);
    wall.mockReturnValue(wallMs + 60_000);
    expect(await f.register()).toMatchObject({ ok: true, data: { created: false } });
    expect(f.state.items).toEqual(before);
  });
  it('keeps the original V2 receipt without recordedAt unchanged and accepts its original proof time', async () => {
    const f = fixture(); await f.register();
    const original = { ...f.state.items[0].receiptSnapshot, receivedAt: String(f.state.items[0].createdAt) };
    delete original.recordedAt;
    const before = structuredClone(original);
    expect(readBatchReceiptSnapshot(original)).toEqual(before); expect(original).toEqual(before);
    expect(Object.prototype.hasOwnProperty.call(original, 'recordedAt')).toBe(false);
  });
  it.each([null, '', 10, true, {}, [], '-1', '1.5', 'NaN', '9007199254740992'])('rejects a present but invalid wall-clock receipt proof timestamp %j', async recordedAt => {
    const f = fixture(); await f.register();
    expect(readBatchReceiptSnapshot({ ...f.state.items[0].receiptSnapshot, recordedAt })).toBeNull();
  });
  it('receives separately coded garment pieces for an unapproved round without inventing a Sample or approval', async () => {
    const f = fixture(true); const r = await f.register();
    expect(r).toMatchObject({ ok: true, data: { created: true, item: { cardType: 'garment', quantity: 1, unit: 'PC', sampleId: null,
      receiptSnapshot: { version: 2, nativeFamily: 'garment-round', sourceRound: 1, factoryId: 'F1', developmentCaseId: 'D1', cardType: 'garment', physicalItemIndex: 1, physicalItemCount: 2 } },
      items: [
        { cardType: 'garment', quantity: 1, receiptSnapshot: { physicalItemIndex: 1, physicalItemCount: 2 } },
        { cardType: 'garment', quantity: 1, receiptSnapshot: { physicalItemIndex: 2, physicalItemCount: 2 } },
      ] } });
    expect(f.state.batch.status).toBe('pending'); expect(f.state.batch.qcStatus).toBeNull();
    expect(f.state.items).toHaveLength(2);
  });
  it('the same batch in a new round creates a new receipt even with identical observed quantities', async () => {
    const f = fixture(); await f.register(); const first = f.state.items[0];
    f.state.batch.round = 2; f.state.batch.updatedAt += BigInt(1);
    expect(await f.register({ expectedSourceRound: 2, expectedBatchUpdatedAt: f.state.batch.updatedAt.toString() })).toMatchObject({ ok: true, data: { created: true, item: { receiptSnapshot: { sourceRound: 2 } } } });
    expect(f.state.items).toHaveLength(2); expect(f.state.items[0]).toEqual(first);
  });
  it('approval/notes timestamp changes and current loans or stock do not mutate an identical original receipt', async () => {
    const f = fixture(); await f.register(); const original = structuredClone(f.state.items[0].receiptSnapshot);
    Object.assign(f.state.batch, { status: 'approved', updatedAt: f.state.batch.updatedAt + BigInt(10), notes: 'Current native note' });
    Object.assign(f.state.items[0], { availableQty: 0, quantity: 4, status: 'borrowed' });
    const writes = [f.tx.sampleBatch.update.mock.calls.length, f.tx.sampleCardItem.create.mock.calls.length, f.tx.auditLog.create.mock.calls.length];
    expect(await f.register()).toMatchObject({ ok: true, data: { created: false, item: { quantity: 4, availableQty: 0 } } });
    expect([f.tx.sampleBatch.update.mock.calls.length, f.tx.sampleCardItem.create.mock.calls.length, f.tx.auditLog.create.mock.calls.length]).toEqual(writes);
    expect(f.state.items[0].receiptSnapshot).toEqual(original);
  });
  it.each(['specNote', 'dyeLotNo', 'case-spec'])('changed original content %s refuses replay without another audit or inventory write', async key => {
    const f = fixture(); await f.register();
    if (key === 'case-spec') Object.assign(f.state.development, { specWeight: '250' });
    else Object.assign(f.state.batch, { [key]: 'changed actual content' });
    const before = structuredClone(f.state);
    expect(await f.register()).toMatchObject({ ok: false, error: { code: 'BATCH_RECEIPT_CONFLICT', status: 409 } });
    expect(f.state).toEqual(before);
  });
  it.each(['expectedCaseId', 'expectedFactoryId'])('an explicitly mismatched %s writes no native quantity, Card or audit', async key => {
    const f = fixture();
    expect(await f.register({ [key]: 'OTHER' })).toMatchObject({ ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED', status: 409 } });
    expect(f.tx.sampleBatch.update).not.toHaveBeenCalled(); expect(f.state.items).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it('a source factory changed while waiting on the Case lock is rejected before any business write', async () => {
    const f = fixture(); f.tx.$queryRaw.mockImplementation(async (query: any) => {
      if (query.sql.includes('DevelopmentCase')) f.state.batch.supplierRelationId = 'OTHER'; return [{ id: 'locked' }];
    });
    expect(await f.register()).toMatchObject({ ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED' } });
    expect(f.tx.sampleBatch.update).not.toHaveBeenCalled(); expect(f.state.items).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it.each([null, { version: 1, batchId: 'B1', initialPhysicalCardCount: 2 }])('legacy receipt %j is not upgraded even if deleted', async receiptSnapshot => {
    const f = fixture(); f.state.items.push({ id: 'OLD', batchId: 'B1', deletedAt: BigInt(7), receiptSnapshot });
    expect(await f.register()).toMatchObject({ ok: false, error: { code: 'BATCH_CARDS_LEGACY_UNVERIFIED', status: 409 } });
    expect(f.state.items).toHaveLength(1); expect(f.state.audits).toHaveLength(0);
  });
  it('explicit zero physical objects stays zero with accurate receipt, never an invented one', async () => {
    const f = fixture();
    expect(await f.register({ physicalCardCount: 0 })).toMatchObject({ ok: true, data: { item: { quantity: 0, availableQty: 0, receiptSnapshot: { initialPhysicalCardCount: 0 } } } });
  });
  it('Card audit failure rolls back native quantity, created Card and both audits', async () => {
    const f = fixture(); f.tx.auditLog.create.mockImplementation(async ({ data }: any) => {
      if (data.action === 'sample_card_create') throw new Error('injected mandatory audit failure'); f.state.audits.push(data); return data;
    });
    expect(await f.register({ actualQuantity: '2.75', actualUnit: 'M' })).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', status: 500 } });
    expect(f.state.batch.actualQuantity).toBeNull(); expect(f.state.items).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it.each(['receiptVersion', 'expectedSourceRound', 'expectedCaseId', 'expectedFactoryId', 'cardType'])('missing required observation/source field %s enters no transaction', async key => {
    const f = fixture(); expect(await f.register({ [key]: undefined })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('a stale source round or first-receipt version cannot be treated as new receipt', async () => {
    const f = fixture();
    expect(await f.register({ expectedSourceRound: 2 })).toMatchObject({ ok: false, error: { code: 'BATCH_RECEIPT_STALE' } });
    expect(await f.register({ expectedBatchUpdatedAt: '0' })).toMatchObject({ ok: false, error: { code: 'BATCH_RECEIPT_STALE' } });
    expect(f.tx.sampleBatch.update).not.toHaveBeenCalled(); expect(f.state.items).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it('the observed lab-dip rating is immutable and a changed replay cannot quietly succeed', async () => {
    const f = fixture(); Object.assign(f.state.batch, { sampleType: 'lab-dip' });
    expect(await f.register({ colorRating: 5 })).toMatchObject({ ok: true, data: { item: { receiptSnapshot: { colorRating: 5 } } } });
    const before = structuredClone(f.state);
    expect(await f.register({ colorRating: 3 })).toMatchObject({ ok: false, error: { code: 'BATCH_RECEIPT_CONFLICT' } }); expect(f.state).toEqual(before);
  });
  it.each([0, 6, 2.5, 'invalid'])('invalid observed rating %j cannot enter either first receipt or replay transaction', async colorRating => {
    const f = fixture();
    expect(await f.register({ colorRating })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    await f.register({ colorRating: 5 }); const before = structuredClone(f.state); f.prisma.$transaction.mockClear();
    expect(await f.register({ colorRating })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
    expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(f.state).toEqual(before);
  });
  it.each([undefined, null])('an unobserved rating %j remains null and cannot be replaced by a rated retry', async colorRating => {
    const f = fixture(); Object.assign(f.state.batch, { colorRating: 3 });
    expect(await f.register({ colorRating })).toMatchObject({ ok: true, data: { item: { receiptSnapshot: { colorRating: null } } } });
    const before = structuredClone(f.state);
    expect(await f.register({ colorRating: 5 })).toMatchObject({ ok: false, error: { code: 'BATCH_RECEIPT_CONFLICT' } }); expect(f.state).toEqual(before);
  });
  it('an explicit null rating cannot erase the immutable rated observation', async () => {
    const f = fixture(); await f.register({ colorRating: 5 }); const before = structuredClone(f.state);
    expect(await f.register({ colorRating: null })).toMatchObject({ ok: false, error: { code: 'BATCH_RECEIPT_CONFLICT' } }); expect(f.state).toEqual(before);
  });
  it('later QC rating metadata does not invalidate or get overwritten by identical original receipt retry', async () => {
    const f = fixture(); await f.register({ colorRating: 5 }); const original = structuredClone(f.state.items[0].receiptSnapshot);
    Object.assign(f.state.batch, { colorRating: 3, qcStatus: 'fail', updatedAt: f.state.batch.updatedAt + BigInt(10) });
    const before = structuredClone(f.state); const writes = [f.tx.sampleBatch.update.mock.calls.length, f.tx.auditLog.create.mock.calls.length];
    expect(await f.register({ colorRating: 5 })).toMatchObject({ ok: true, data: { created: false } });
    expect(await f.register()).toMatchObject({ ok: true, data: { created: false } });
    expect(f.state).toEqual(before); expect(f.state.items[0].receiptSnapshot).toEqual(original);
    expect([f.tx.sampleBatch.update.mock.calls.length, f.tx.auditLog.create.mock.calls.length]).toEqual(writes);
  });
  it('a native producer failure rolls back before any physical receipt or audit is retained', async () => {
    const f = fixture(); f.tx.sampleBatch.update.mockRejectedValueOnce(Error('injected native update failure'));
    expect(await f.register({ actualQuantity: '2.75', actualUnit: 'M' })).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', status: 500 } });
    expect(f.state.batch.actualQuantity).toBeNull(); expect(f.state.items).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it.each(['deleted', 'retired'])('a %s precise original is not replaced by a new receipt', async terminal => {
    const f = fixture(); await f.register();
    Object.assign(f.state.items[0], terminal === 'deleted' ? { deletedAt: BigInt(7) } : { status: 'retired' });
    const before = structuredClone(f.state);
    expect(await f.register()).toMatchObject({ ok: false, error: { code: 'BATCH_CARDS_ARCHIVED' } }); expect(f.state).toEqual(before);
  });
  it.each([true, false, [5], { rating: 5 }, '5', ''])('non-number rating %j never becomes an observed fact in first receipt or replay', async colorRating => {
    const f = fixture();
    expect(await f.register({ colorRating })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    await f.register({ colorRating: 5 }); const before = structuredClone(f.state); f.prisma.$transaction.mockClear();
    expect(await f.register({ colorRating })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } });
    expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(f.state).toEqual(before);
  });
});
