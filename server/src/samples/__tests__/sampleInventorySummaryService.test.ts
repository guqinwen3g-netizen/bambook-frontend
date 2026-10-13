import { describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn() } }));
const custody = vi.hoisted(() => ({ batch: vi.fn(), recheck: vi.fn() }));
vi.mock('../sampleCustodyAuthorization', async importActual => ({ ...(await importActual<any>()),
  authorizeSampleCustodyBatch: custody.batch, recheckSampleCustodyBatchAuthorization: custody.recheck }));
import { SampleCustodyAuthorizationError } from '../sampleCustodyAuthorization';
import { getSampleInventorySummary } from '../sampleInventorySummaryService';

const card = (id: string, extra: Record<string, unknown> = {}) => ({ id, sampleId: 'S1', cardType: 'fabric', unit: 'PC', status: 'in_stock', quantity: 1, availableQty: 1, deletedAt: null, ...extra });
function database(cards: any[] = [], loans: any[] = [], samples = [{ id: 'S1', deletedAt: null }]) {
  const state = { cards, loans, samples };
  custody.batch.mockReset(); custody.recheck.mockReset();
  custody.batch.mockImplementation(async ({ subjects }: any) => subjects.map((subject: any) => ({ subject, ok: true,
    authorization: { visibility: 'full', guard: { version: 1, subject, mode: 'read' } } })));
  custody.recheck.mockResolvedValue([]);
  const query = vi.fn(async (statement: any) => {
    const sql = statement.sql.replace(/\s+/g, ' ');
    // These checks cover the actual emitted query's bounded input and aggregation
    // structure. The independent fixture oracle below is not a PostgreSQL run.
    expect(sql).toContain('"SampleCardItem"'); expect(sql).toContain('"SampleCardLoan"');
    expect(sql).toContain('"deletedAt" IS NULL'); expect(sql).toContain('"loanType" = \'borrow\'');
    expect(sql).toContain('"returnedAt" IS NULL'); expect(sql).toMatch(/JOIN selected_cards/);
    expect(sql).toContain('card_totals'); expect(sql).toContain('borrow_totals');
    expect(sql).not.toMatch(/LIMIT|OFFSET|FOR UPDATE|UPDATE |INSERT |DELETE /i);
    expect(sql).toMatch(/::text/); expect(sql).not.toMatch(/"quantity"\s*-\s*.*"availableQty"/);
    const requested = new Set(statement.values);
    const groups = new Map<string, any>();
    for (const row of state.cards) {
      if (!requested.has(row.sampleId) || row.deletedAt != null) continue;
      const inventoryState = ['in_stock', 'borrowed'].includes(row.status) ? 'active' : ['shipped', 'retired'].includes(row.status) ? row.status : 'other';
      const key = JSON.stringify([row.sampleId, row.cardType, row.unit, inventoryState]);
      const group = groups.get(key) ?? { sampleId: row.sampleId, cardType: row.cardType, unit: row.unit, inventoryState, cardRows: 0n, quantity: 0n, availableQty: 0n, borrowedQty: 0n, invalidStock: false, invalidBorrow: false };
      group.cardRows++; group.quantity += BigInt(row.quantity); group.availableQty += BigInt(row.availableQty);
      group.invalidStock ||= row.quantity < 0 || row.availableQty < 0 || sql.includes('"availableQty" > "quantity"') && row.availableQty > row.quantity;
      let borrowed = 0n;
      for (const loan of state.loans) if (loan.itemId === row.id && loan.loanType === 'borrow' && loan.returnedAt == null) { group.borrowedQty += BigInt(loan.loanQuantity); group.invalidBorrow ||= loan.loanQuantity <= 0; }
      for (const loan of state.loans) if (loan.itemId === row.id && loan.loanType === 'borrow' && loan.returnedAt == null) borrowed += BigInt(loan.loanQuantity);
      if (inventoryState === 'active' && sql.includes('b."borrowedQty" + c."availableQty" > c."quantity"')) group.invalidBorrow ||= borrowed + BigInt(row.availableQty) > BigInt(row.quantity);
      groups.set(key, group);
    }
    return [...groups.values()].map(group => ({ ...group, ...Object.fromEntries(['cardRows', 'quantity', 'availableQty', 'borrowedQty'].map(key => [key, group[key].toString()])) }));
  });
  const tx: any = { sample: { findMany: vi.fn(async ({ where }: any) => state.samples.filter(row => where.id.in.includes(row.id) && row.deletedAt == null).map(row => ({ id: row.id }))) }, sampleCardItem: { findMany: vi.fn(async ({ where, cursor, take }: any) => {
    const rows = state.cards.filter(row => where.sampleId.in.includes(row.sampleId) && row.deletedAt == null).sort((a,b) => a.id.localeCompare(b.id));
    const start = cursor ? rows.findIndex(row => row.id === cursor.id) + 1 : 0;
    return rows.slice(start, start + take).map(row => ({ id: row.id }));
  }) }, $queryRaw: query };
  const db: any = { $transaction: vi.fn(async (run: any) => run(tx)), $queryRaw: vi.fn(() => { throw Error('must use snapshot tx'); }) };
  return { db, tx, query, state };
}
async function summary(fixture: ReturnType<typeof database>, ids: unknown = ['S1']) { const result = await getSampleInventorySummary(fixture.db, ids); expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.message); return result.data; }

describe('S3C complete physical stock snapshot contract', () => {
  it('all 351 cards are aggregated at the database without a take200 or card-id transport', async () => { const f = database(Array.from({ length: 351 }, (_, i) => card('C' + i))); const data = await summary(f); expect(data).toMatchObject({ complete: true, sampleIds: ['S1'], summaries: [{ sampleId: 'S1', groups: [{ cardRows: '351', quantity: '351', availableQty: '351', borrowedQty: '0' }] }] }); expect(f.query).toHaveBeenCalledTimes(1); expect(f.query.mock.calls[0][0].values).toEqual(['S1']); });
  it('material type and exact units stay separate even within a garment business Sample', async () => { const f = database([card('A', { unit: 'M', quantity: 3 }), card('B', { unit: 'YD', quantity: 4 }), card('C', { cardType: 'garment', quantity: 2 }), card('D', { unit: null })]); const data = await summary(f); expect(data.summaries[0].groups).toHaveLength(4); expect(data.summaries[0].groups.map((g: any) => [g.cardType, g.unit, g.quantity])).toEqual(expect.arrayContaining([['fabric', 'M', '3'], ['fabric', 'YD', '4'], ['garment', 'PC', '2'], ['fabric', null, '1']])); });
  it('borrow totals use every genuine unreturned borrow, excluding viewing, ship and returned rows', async () => { const f = database([card('A', { quantity: 9, availableQty: 3, status: 'borrowed' })], [{ itemId: 'A', loanType: 'borrow', loanQuantity: 2, returnedAt: null }, { itemId: 'A', loanType: 'borrow', loanQuantity: 3, returnedAt: null }, { itemId: 'A', loanType: 'borrow', loanQuantity: 7, returnedAt: 1 }, { itemId: 'A', loanType: 'viewing', loanQuantity: 20, returnedAt: null }, { itemId: 'A', loanType: 'ship', loanQuantity: 30, returnedAt: null }]); expect((await summary(f)).summaries[0].groups[0]).toMatchObject({ quantity: '9', availableQty: '3', borrowedQty: '5' }); });
  it('one card with 251 active loans never multiplies held quantity by the loan join', async () => { const f = database([card('A', { quantity: 300, availableQty: 49 })], Array.from({ length: 251 }, () => ({ itemId: 'A', loanType: 'borrow', loanQuantity: 1, returnedAt: null }))); expect((await summary(f)).summaries[0].groups[0]).toMatchObject({ cardRows: '1', quantity: '300', availableQty: '49', borrowedQty: '251' }); });
  it('historic ship ghost gap is not borrowed and terminal records never merge into active stock', async () => { const f = database([card('A', { quantity: 2, availableQty: 1 }), card('S', { status: 'shipped', quantity: 8, availableQty: 0 }), card('R', { status: 'retired', quantity: 4, availableQty: 4 }), card('U', { status: 'unknown', quantity: 7 })]); const groups = (await summary(f)).summaries[0].groups; expect(groups.find((g: any) => g.inventoryState === 'active')).toMatchObject({ quantity: '2', availableQty: '1', borrowedQty: '0', cardRows: '1' }); expect(groups.map((g: any) => g.inventoryState)).toEqual(expect.arrayContaining(['active', 'shipped', 'retired', 'other'])); });
  it('deleted cards, unrelated samples and their loans are excluded', async () => { const f = database([card('A'), card('D', { deletedAt: 1 }), card('X', { sampleId: 'OTHER' })], [{ itemId: 'D', loanType: 'borrow', loanQuantity: 8 }, { itemId: 'X', loanType: 'borrow', loanQuantity: 9 }]); expect((await summary(f)).summaries[0].groups[0]).toMatchObject({ cardRows: '1', quantity: '1', borrowedQty: '0' }); });
  it('requested live sample without cards has explicit complete empty groups', async () => { expect(await summary(database())).toEqual({ complete: true, snapshotAt: expect.any(String), sampleIds: ['S1'], summaries: [{ sampleId: 'S1', groups: [] }] }); });
  it.each([undefined, [], ['S1', 'S1'], [''], ['S1', 3], Array.from({ length: 201 }, (_, i) => 'S' + i)].map(input => [input]))('invalid or duplicate input refuses without a transaction: %j', async input => { const f = database(); const r = await getSampleInventorySummary(f.db, input); expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', status: 400 } }); expect(f.db.$transaction).not.toHaveBeenCalled(); });
  it('all requested Samples must be live; missing or archived cannot be claimed empty', async () => { for (const rows of [[], [{ id: 'S1', deletedAt: 1 }]]) { const f = database([], [], rows); expect(await getSampleInventorySummary(f.db, ['S1'])).toMatchObject({ ok: false, error: { code: 'SAMPLE_NOT_FOUND', status: 404 } }); expect(f.query).not.toHaveBeenCalled(); } });
  it('parent visibility and stock/loan aggregation use the same RepeatableRead snapshot', async () => { const f = database([card('A')]); await summary(f); expect(f.db.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead' })); expect(f.tx.sample.findMany).toHaveBeenCalledTimes(1); expect(f.db.$queryRaw).not.toHaveBeenCalled(); });
  it('a SQL error is unavailable, never complete zero', async () => { const f = database([card('A')]); f.query.mockRejectedValue(Error('synthetic query failure')); const r = await getSampleInventorySummary(f.db, ['S1']); expect(r).toMatchObject({ ok: false, error: { code: 'INVENTORY_SUMMARY_UNAVAILABLE', status: 500 } }); expect(r).not.toHaveProperty('data'); });
  it('unsafe totals stay exact decimal strings without Number conversion', async () => { const f = database(); f.query.mockResolvedValue([{ sampleId: 'S1', cardType: 'fabric', unit: 'PC', inventoryState: 'active', cardRows: '4194305', quantity: '9007199254740993', availableQty: '9007199254740992', borrowedQty: '1' }]); expect((await summary(f)).summaries[0].groups[0]).toMatchObject({ quantity: '9007199254740993', availableQty: '9007199254740992' }); });
  it('invalid aggregate quantities reject the complete claim', async () => { const f = database(); f.query.mockResolvedValue([{ sampleId: 'S1', cardType: 'fabric', unit: 'PC', inventoryState: 'active', cardRows: '1', quantity: '2', availableQty: '1', borrowedQty: '-1' }]); expect(await getSampleInventorySummary(f.db, ['S1'])).toMatchObject({ ok: false, error: { code: 'INVENTORY_SUMMARY_UNAVAILABLE', status: 500 } }); });
  it('available greater than owned on one Card cannot be hidden by another Card in the same group', async () => { const f = database([card('BAD', { quantity: 1, availableQty: 2 }), card('GOOD', { quantity: 100, availableQty: 0 })]); expect(await getSampleInventorySummary(f.db, ['S1'])).toMatchObject({ ok: false, error: { code: 'INVENTORY_SUMMARY_UNAVAILABLE' } }); });
  it('active borrow beyond owned is unavailable, never repaired or published as complete', async () => { const f = database([card('A', { quantity: 1, availableQty: 0 })], [{ itemId: 'A', loanType: 'borrow', loanQuantity: 2 }]); expect(await getSampleInventorySummary(f.db, ['S1'])).toMatchObject({ ok: false, error: { code: 'INVENTORY_SUMMARY_UNAVAILABLE' } }); });
  it('active available plus borrow beyond owned is rejected per Card even with spare group quantity', async () => { const f = database([card('BAD', { quantity: 3, availableQty: 2 }), card('GOOD', { quantity: 100, availableQty: 0 })], [{ itemId: 'BAD', loanType: 'borrow', loanQuantity: 2 }]); expect(await getSampleInventorySummary(f.db, ['S1'])).toMatchObject({ ok: false, error: { code: 'INVENTORY_SUMMARY_UNAVAILABLE' } }); });
  it('borrow may exceed available and a historical positive ghost gap is not blanket rejected', async () => { const f = database([card('A', { quantity: 3, availableQty: 1 }), card('GHOST', { quantity: 5, availableQty: 1 })], [{ itemId: 'A', loanType: 'borrow', loanQuantity: 2 }, { itemId: 'GHOST', loanType: 'borrow', loanQuantity: 1 }]); expect((await summary(f)).summaries[0].groups[0]).toMatchObject({ quantity: '8', availableQty: '2', borrowedQty: '3' }); });
  it('foreign-parent Card refuses the entire completeness claim before aggregate SQL', async () => {
    const f = database([card('A'), card('FOREIGN')]);
    custody.batch.mockImplementation(async ({ subjects }: any) => subjects.map((subject: any) => subject.id === 'FOREIGN'
      ? { subject, ok: false, error: { code: 'NOT_FOUND', status: 404 } }
      : { subject, ok: true, authorization: { visibility: 'full', guard: { version: 1, subject, mode: 'read' } } }));
    expect(await getSampleInventorySummary(f.db, ['S1'])).toMatchObject({ ok: false, error: { status: 404 } });
    expect(f.query).not.toHaveBeenCalled();
  });
  it('catalog authority never permits complete sample inventory', async () => {
    const f = database([card('A')]);
    custody.batch.mockImplementation(async ({ subjects }: any) => subjects.map((subject: any) => ({ subject, ok: true,
      authorization: { visibility: subject.kind === 'card' ? 'catalog' : 'full', guard: { version: 1, subject, mode: 'read' } } })));
    expect(await getSampleInventorySummary(f.db, ['S1'])).toMatchObject({ ok: false, error: { status: 404 } });
    expect(f.query).not.toHaveBeenCalled();
  });
  it('missing current authentication refuses before sample lookup', async () => {
    const f = database(); custody.batch.mockRejectedValue(new SampleCustodyAuthorizationError('UNAUTHORIZED', 401, 'login'));
    expect(await getSampleInventorySummary(f.db, ['S1'])).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED', status: 401 } });
    expect(f.tx.sample.findMany).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
  });
  it('final authority withdrawal discards already computed totals on root connection outside RR', async () => {
    const f = database([card('A')]); custody.recheck.mockRejectedValue(new SampleCustodyAuthorizationError('FORBIDDEN', 403, 'withdrawn'));
    const result = await getSampleInventorySummary(f.db, ['S1']);
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', status: 403 } }); expect(result).not.toHaveProperty('data');
    expect(custody.recheck).toHaveBeenCalledWith(expect.objectContaining({ currentPrisma: f.db, guards: expect.arrayContaining([
      expect.objectContaining({ subject: { kind: 'sample', id: 'S1' } }), expect.objectContaining({ subject: { kind: 'card', id: 'A' } })]) }));
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('complete card qualification traverses beyond the first 200 without transporting ids into aggregate SQL', async () => {
    const f = database(Array.from({ length: 401 }, (_, i) => card('C'+String(i).padStart(4,'0')))); await summary(f);
    const qualified = custody.batch.mock.calls.flatMap(([args]) => args.subjects.filter((s: any) => s.kind === 'card').map((s: any) => s.id));
    expect(new Set(qualified).size).toBe(401); expect(f.tx.sampleCardItem.findMany).toHaveBeenCalledTimes(3);
    expect(f.query.mock.calls[0][0].values).toEqual(['S1']);
  });

});
