import { describe, expect, it, vi } from 'vitest';
import { freezeProductionLineIdentity, parseProductionLineChoice, productionLineCoverageMatches, readBatchProductionLineIdentity } from '../productionLineIdentity';
const now = new Date('2026-10-07T05:00:00.000Z');
describe('actual production organization identity', () => {
  it('retains unknown history and refuses virtual single-factory IDs', async () => {
    expect(await readBatchProductionLineIdentity({}, { factoryRelationId: 'FACTORY' })).toBeNull();
    expect(parseProductionLineChoice(undefined)).toBeUndefined();
    expect(() => parseProductionLineChoice({ mode: 'factory_single', productionLineId: 'FACTORY' })).toThrow();
  });
  it('freezes the explicit single-factory declaration without creating a named line', async () => {
    const read = vi.fn(); const identity = await freezeProductionLineIdentity({ factoryProductionLine: { findUnique: read } }, 'FACTORY', { mode: 'factory_single' }, 'ACTUAL-ACTOR', now);
    expect(identity).toMatchObject({ productionLineId: null, lineRevision: null, declaredBy: 'ACTUAL-ACTOR', declaredAt: now.toISOString() }); expect(read).not.toHaveBeenCalled();
    expect(await readBatchProductionLineIdentity({}, { factoryRelationId: 'FACTORY', productionLineSnapshot: identity })).toEqual(identity);
  });
  it('requires a real active line under the same actual factory', async () => {
    const db = { factoryProductionLine: { findUnique: vi.fn().mockResolvedValue({ id: 'LINE', factoryRelationId: 'OTHER', name: '实际线', state: 'active', revision: 1 }) } };
    await expect(freezeProductionLineIdentity(db, 'FACTORY', { mode: 'named_line', productionLineId: 'LINE' }, 'ACTOR', now)).rejects.toMatchObject({ code: 'CONFLICT' });
    db.factoryProductionLine.findUnique.mockResolvedValue({ id: 'LINE', factoryRelationId: 'FACTORY', name: '实际线', state: 'inactive', revision: 1 });
    await expect(freezeProductionLineIdentity(db, 'FACTORY', { mode: 'named_line', productionLineId: 'LINE' }, 'ACTOR', now)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rejects changed actual line revisions and tampered frozen identity', async () => {
    const row = { id: 'LINE', factoryRelationId: 'FACTORY', name: '实际线', location: null, state: 'active', revision: 1 };
    const db = { factoryProductionLine: { findUnique: vi.fn().mockResolvedValue(row) } };
    const identity = await freezeProductionLineIdentity(db, 'FACTORY', { mode: 'named_line', productionLineId: 'LINE' }, 'ACTOR', now);
    db.factoryProductionLine.findUnique.mockResolvedValue({ ...row, revision: 2 });
    await expect(readBatchProductionLineIdentity(db, { factoryRelationId: 'FACTORY', productionLineId: 'LINE', productionLineSnapshot: identity })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(readBatchProductionLineIdentity(db, { factoryRelationId: 'FACTORY', productionLineId: 'LINE', productionLineSnapshot: { ...identity, declaredBy: 'OTHER' } })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('does not let a whole-line PP or another line fingerprint stand in for a named actual line', async () => {
    const single = { productionLineMode: 'factory_single', productionLineFingerprint: 'a'.repeat(64) };
    expect(productionLineCoverageMatches({ scopeKind: 'order_line' }, single)).toBe(true);
    expect(productionLineCoverageMatches({ scopeKind: 'order_line' }, { ...single, productionLineMode: 'named_line' })).toBe(false);
    expect(productionLineCoverageMatches({ scopeKind: 'production_batch' }, single)).toBe(false);
  });
});
