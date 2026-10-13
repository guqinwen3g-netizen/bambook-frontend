import { describe, expect, it, vi } from 'vitest';
import { normalizeExternalPoNumber, resolveOrderId } from '../orderIdentity';

type Row = { id: string; code: string | null; poNumber: string | null; businessLine: string; customerRelationId: string; ownerId: string; deletedAt: bigint | null };
const rows: Row[] = [
  { id: 'fabric-id', code: 'ORD-2026-0001', poNumber: 'CUSTOMER-PO', businessLine: 'fabric', customerRelationId: 'customer-1', ownerId: 'owner', deletedAt: null },
  { id: 'garment-id', code: 'ORD-2026-0002', poNumber: 'CUSTOMER-PO', businessLine: 'garment', customerRelationId: 'customer-1', ownerId: 'owner', deletedAt: null },
  { id: 'internal-id', code: 'ORD-2026-0003', poNumber: null, businessLine: 'fabric', customerRelationId: 'internal', ownerId: 'owner', deletedAt: null },
  { id: 'other-id', code: 'ORD-2026-0004', poNumber: 'PRIVATE-PO', businessLine: 'fabric', customerRelationId: 'customer-2', ownerId: 'other', deletedAt: null },
];
function matches(row: Row, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, value]) => key === 'AND'
    ? (Array.isArray(value) ? value : [value]).every((item: any) => matches(row, item))
    : (row as any)[key] === value);
}
function db(items = rows) {
  return { order: { findMany: vi.fn(async ({ where, take }: any) => items.filter(row => matches(row, where)).slice(0, take).map(row => ({ id: row.id }))) } };
}

describe('internal order identity and shared external PO references', () => {
  it('keeps an absent external PO absent for internal orders', () => {
    expect(normalizeExternalPoNumber(undefined)).toBeNull();
    expect(normalizeExternalPoNumber('   ')).toBeNull();
    expect(normalizeExternalPoNumber(' CUSTOMER-PO ')).toBe('CUSTOMER-PO');
  });
  it('resolves the precise internal id even when the external PO is shared', async () => {
    expect(await resolveOrderId(db(), { orderId: 'garment-id' })).toBe('garment-id');
  });
  it('supports a unique internal number without requiring an external PO', async () => {
    expect(await resolveOrderId(db(), 'ORD-2026-0003')).toBe('internal-id');
  });
  it('rejects a shared external PO instead of selecting the first order', async () => {
    await expect(resolveOrderId(db(), { poNumber: 'CUSTOMER-PO' })).rejects.toMatchObject({ code: 'AMBIGUOUS_ORDER_REFERENCE', statusCode: 409 });
  });
  it('can resolve an explicitly qualified external PO', async () => {
    expect(await resolveOrderId(db(), { poNumber: 'CUSTOMER-PO', businessLine: 'garment', customerRelationId: 'customer-1' })).toBe('garment-id');
  });
  it('applies the same data scope to id, internal number and legacy PO lookup', async () => {
    const database = db();
    for (const reference of ['other-id', 'ORD-2026-0004', 'PRIVATE-PO']) {
      expect(await resolveOrderId(database, reference, { ownerId: 'owner' })).toBeNull();
    }
    expect(database.order.findMany.mock.calls.every(([args]) => args.where.AND[0].ownerId === 'owner')).toBe(true);
  });
  it('does not fall back from an explicit missing id to a coincidentally equal PO', async () => {
    expect(await resolveOrderId(db([{ ...rows[0], poNumber: 'missing-id' }]), { orderId: 'missing-id' })).toBeNull();
  });
  it('does not swallow an unavailable identity store as not found', async () => {
    const unavailable = { order: { findMany: vi.fn().mockRejectedValue(new Error('storage unavailable')) } };
    await expect(resolveOrderId(unavailable, 'CUSTOMER-PO')).rejects.toThrow('storage unavailable');
  });
  it('rejects non-text client references before querying the identity store', async () => {
    const database = db();
    await expect(resolveOrderId(database, { orderId: 42 } as any)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(database.order.findMany).not.toHaveBeenCalled();
  });
});
