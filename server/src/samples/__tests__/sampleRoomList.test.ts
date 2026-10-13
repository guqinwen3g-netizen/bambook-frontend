import { describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { createSampleRoomService } from '../sampleRoomService';

import { storage } from './sampleRoomListFixture';
const card = (id: string, caseId = 'F', createdAt = 100) => ({ id, code: id, name: id, devCaseId: caseId, cardType: 'fabric', status: 'in_stock', quantity: 2, availableQty: 2, minStock: null, createdAt, deletedAt: null });
const cases = [{ id: 'F', type: 'fabric', deletedAt: null }, { id: 'G', type: 'garment', deletedAt: null }];
// The service re-reads this user's current RBAC grants from the fixture DB.
// Supplying no actor only exercises the authentication denial path.
const reader: any = { userId: 'u_owner', roles: [], permissions: [], departmentIds: [], authorizationLoaded: true };
const result = async (store: ReturnType<typeof storage>, query: any) => createSampleRoomService(store.db).listItems(query, reader);

describe('Room authoritative scope and complete filtered pagination', () => {
  it('finds garment cards beyond the first 200 and reports the complete lane total', async () => {
    const s = storage({ cases, items: Array.from({ length: 251 }, (_, i) => card(`C${String(i).padStart(3, '0')}`, i < 201 ? 'F' : 'G', 1000 - i)) });
    const r: any = await result(s, { scope: 'garment', limit: 20, offset: 20 });
    expect(r.ok).toBe(true); expect(r.data.total).toBe(50); expect(r.data.items).toHaveLength(20);
    expect(r.data.items[0].id).toBe('C221'); expect(r.data.scope).toBe('garment');
  });
  it('lowStock matches beyond the first 200 before page/count, preserving null and zero thresholds', async () => {
    const items = Array.from({ length: 251 }, (_, i) => ({ ...card(`C${i}`, 'F', 1000 - i), minStock: i === 250 ? 0 : null, availableQty: i === 250 ? 0 : 2 }));
    const s = storage({ cases, items }); const r: any = await result(s, { scope: 'fabric', lowStock: true, limit: 50 });
    expect(r.data.total).toBe(1); expect(r.data.items.map((i: any) => i.id)).toEqual(['C250']);
  });
  it('limit zero returns no page but complete count and malformed parameters fail without reads', async () => {
    const s = storage({ cases, items: [card('A')] }); const r: any = await result(s, { scope: 'fabric', limit: 0 });
    expect(r.data.items).toEqual([]); expect(r.data.total).toBe(1);
    for (const q of [{ scope: 'wrong' }, { limit: 2.5 }, { offset: -1 }, { offset: true }, { limit: [2] }, { limit: null }]) expect(await result(s, q)).toMatchObject({ ok: false, error: { status: 400 } });
  });
  it('same createdAt uses id descending across adjacent pages, without duplicates', async () => {
    const s = storage({ cases, items: [card('A'), card('C'), card('B')] });
    const a: any = await result(s, { scope: 'fabric', limit: 2 }); const b: any = await result(s, { scope: 'fabric', limit: 2, offset: 2 });
    expect([...a.data.items, ...b.data.items].map((i: any) => i.id)).toEqual(['C', 'B', 'A']);
  });
  it('same snapshot owns page/count/source readback even when external state changes during the read', async () => {
    const s = storage({ cases, items: [card('A')] }); s.afterFirstCardRead(() => s.state.items.push(card('B')));
    const r: any = await result(s, { limit: 50 }); expect(r.data.total).toBe(1); expect(r.data.items).toHaveLength(1);
    expect(s.options).toEqual([expect.objectContaining({ isolationLevel: 'RepeatableRead' })]); expect(s.state.items).toHaveLength(2);
  });
  it('sampleId and sampleIds intersect rather than widen an anchored Sample', async () => {
    const s = storage({ cases, items: [{ ...card('A'), sampleId: 'S1' }, { ...card('B'), sampleId: 'S2' }], samples: [{ id: 'S1', sourceCaseId: 'F', deletedAt: null }, { id: 'S2', sourceCaseId: 'F', deletedAt: null }] });
    const r: any = await result(s, { sampleId: 'S1', sampleIds: ['S1', 'S2'] }); expect(r.data.items.map((i: any) => i.id)).toEqual(['A']);
    const empty: any = await result(s, { sampleIds: [] }); expect(empty.data.items).toEqual([]); expect(empty.data.total).toBe(0);
  });
  it('legacy low-stock endpoint scans the complete range and returns full count separately from its limit', async () => {
    const s = storage({ items: Array.from({ length: 251 }, (_, i) => ({ ...card(`C${i}`), availableQty: i, minStock: i === 250 ? 251 : 0 })) });
    const r: any = await createSampleRoomService(s.db).listLowStock(1, reader); expect(r.data.total).toBe(2); expect(r.data.items).toHaveLength(1);
  });
  it('garment owner keeps fabric-reference Card in garment; source ID conflicts and unknown go to review', async () => {
    const s = storage({ cases, items: [{ ...card('REF', 'G'), productAssetId: 'FABRIC-DESCRIPTOR' }, { ...card('CONFLICT', 'F'), sampleId: 'S' }, { ...card('UNKNOWN'), devCaseId: null }], samples: [{ id: 'S', sourceCaseId: 'G', deletedAt: null }] });
    const garment: any = await result(s, { scope: 'garment' }); expect(garment.data.items.map((i: any) => i.id)).toEqual(['REF']);
    const review: any = await result(s, { scope: 'review' }); expect(review.data.total).toBe(2); expect(review.data.items.map((i: any) => i.businessContext.status).sort()).toEqual(['conflict', 'unresolved']);
    expect(s.state.items.map((i: any) => [i.quantity, i.availableQty])).toEqual([[2, 2], [2, 2], [2, 2]]);
  });
  it('source SQL failures remain errors, never fabricated zero count success', async () => {
    const s = storage({ cases, items: [card('A')] }); s.fail('developmentCase'); expect(await result(s, { scope: 'fabric' })).toMatchObject({ ok: false, error: { status: 500 } });
  });
});
