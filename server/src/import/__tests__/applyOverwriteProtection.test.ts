import { describe, it, expect } from 'vitest';
import {
  applyOverwriteProtection,
  parseFieldSources,
  type FieldSourceTag,
} from '../persistOrders';

describe('parseFieldSources', () => {
  it('returns an empty map for non-object input', () => {
    expect(parseFieldSources(null)).toEqual({});
    expect(parseFieldSources(undefined)).toEqual({});
    expect(parseFieldSources('not-json')).toEqual({});
    expect(parseFieldSources(42)).toEqual({});
    expect(parseFieldSources([])).toEqual({});
  });

  it('keeps only the three valid tag values and drops everything else', () => {
    const raw = {
      a: 'pdf',
      b: 'manual',
      c: 'imported-then-edited',
      d: 'something-else',
      e: null,
      f: 0,
    };
    expect(parseFieldSources(raw)).toEqual({
      a: 'pdf',
      b: 'manual',
      c: 'imported-then-edited',
    });
  });
});

describe('applyOverwriteProtection — overwrite-pdf-fields-only mode', () => {
  it('refreshes fields tagged "pdf" from a previous PDF import', () => {
    const previous: Record<string, FieldSourceTag> = { contactPerson: 'pdf', season: 'pdf' };
    const incoming = { contactPerson: 'New Buyer', season: 'SS27', poDate: '2026-04-20' };

    const out = applyOverwriteProtection(incoming, previous, 'overwrite-pdf-fields-only');

    expect(out.skippedFields).toEqual([]);
    expect(out.update).toEqual(incoming);
    expect(out.nextSources).toEqual({
      contactPerson: 'pdf',
      season: 'pdf',
      poDate: 'pdf',
    });
  });

  it('skips fields tagged "manual" and reports them as skipped', () => {
    const previous: Record<string, FieldSourceTag> = {
      contactPerson: 'manual',
      millName: 'manual',
      season: 'pdf',
    };
    const incoming = {
      contactPerson: 'OVERWRITE-ATTEMPT',
      millName: 'OVERWRITE-ATTEMPT',
      season: 'SS27',
    };

    const out = applyOverwriteProtection(incoming, previous, 'overwrite-pdf-fields-only');

    expect(out.skippedFields.sort()).toEqual(['contactPerson', 'millName']);
    expect(out.update).toEqual({ season: 'SS27' });
    // Manual tags must NOT be downgraded back to 'pdf'.
    expect(out.nextSources).toEqual({
      contactPerson: 'manual',
      millName: 'manual',
      season: 'pdf',
    });
  });

  it('skips fields tagged "imported-then-edited" exactly like "manual"', () => {
    const previous: Record<string, FieldSourceTag> = { purchasePrice: 'imported-then-edited' };
    const incoming = { purchasePrice: 999, season: 'SS27' };

    const out = applyOverwriteProtection(incoming, previous, 'overwrite-pdf-fields-only');

    expect(out.skippedFields).toEqual(['purchasePrice']);
    expect(out.update).toEqual({ season: 'SS27' });
    expect(out.nextSources.purchasePrice).toBe('imported-then-edited');
  });

  it('treats fields with no prior tag as fresh PDF writes', () => {
    const previous: Record<string, FieldSourceTag> = {};
    const incoming = { season: 'SS27', contactPerson: 'Alice' };

    const out = applyOverwriteProtection(incoming, previous, 'overwrite-pdf-fields-only');

    expect(out.skippedFields).toEqual([]);
    expect(out.update).toEqual(incoming);
    expect(out.nextSources).toEqual({ season: 'pdf', contactPerson: 'pdf' });
  });
});

describe('applyOverwriteProtection — force-overwrite mode', () => {
  it('overwrites every field regardless of previous tag', () => {
    const previous: Record<string, FieldSourceTag> = {
      contactPerson: 'manual',
      season: 'imported-then-edited',
    };
    const incoming = { contactPerson: 'FORCED', season: 'FORCED' };

    const out = applyOverwriteProtection(incoming, previous, 'force-overwrite');

    expect(out.skippedFields).toEqual([]);
    expect(out.update).toEqual(incoming);
    // Force-overwrite resets every touched field's tag to 'pdf'.
    expect(out.nextSources).toEqual({
      contactPerson: 'pdf',
      season: 'pdf',
    });
  });
});
