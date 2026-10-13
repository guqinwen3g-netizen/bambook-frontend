import { describe, expect, it } from 'vitest';
import { normalizeProductionSizeChecks, projectProductionQcSizeCoverage, assertProductionSizeRetest } from './productionQcSizeCoverage';

const check = (size: string, result: 'pass' | 'fail' = 'pass') => ({ size, result, inspectedUnits: 2, evidence: [`photo:${size}`] });
const facts = (sizes: string[], scopeComplete = false, checks = sizes.map(size => check(size))) => ({
  schemaVersion: 1 as const, actualSizes: sizes, scopeComplete, basis: 'QC 现场核对实际生产尺码', checks,
});
const report = (id: string, sequence: number, sizes: ReturnType<typeof facts> | null, result = 'pass') => ({
  id, createdAt: String(sequence), result, productionSizeChecks: sizes,
});
const project = (reports: ReturnType<typeof report>[], completionSizes?: Record<string, number> | null) =>
  projectProductionQcSizeCoverage({ reports, completionSizes });

describe('actual production size quality facts', () => {
  it('keeps historical missing facts unknown and never consumes a planned size matrix', () => {
    expect(normalizeProductionSizeChecks(undefined)).toBeNull();
    expect(project([report('OLD', 1, null)])).toMatchObject({ satisfied: false, scopeComplete: false, actualSizes: [] });
    expect(project([])).toMatchObject({ satisfied: false });
  });
  it('requires real inspected units and per-size evidence, and rejects duplicate or contradictory facts', () => {
    for (const value of [facts(['S', 'S']), facts(['S'], true, [{ ...check('S'), inspectedUnits: 0 }]),
      facts(['S'], true, [{ ...check('S'), evidence: [] }]), facts(['S'], true, [check('M')]),
      { ...facts(['S']), quantityTolerance: '3%' }]) {
      expect(() => normalizeProductionSizeChecks(value)).toThrow();
    }
  });
  it('accumulates independent inspections only after the actual production range is explicitly complete', () => {
    const partial = report('S', 1, facts(['S'], false));
    const complete = report('M', 2, facts(['S', 'M'], true, [check('M')]));
    expect(project([partial])).toMatchObject({ satisfied: false, missingSizes: [], scopeComplete: false });
    expect(project([partial, complete])).toMatchObject({ satisfied: true, actualSizes: ['M', 'S'], missingSizes: [], failedSizes: [] });
    expect(project([report('plan-only', 1, facts(['S', 'M'], true, [check('S')]))])).toMatchObject({
      satisfied: false, missingSizes: ['M'],
    });
  });
  it('never lets a later partial NOK reuse an earlier pass for the same size', () => {
    const first = report('FIRST', 1, facts(['S', 'M'], true));
    const failed = report('NOK', 2, facts(['M'], false, [check('M', 'fail')]), 'fail');
    const state = project([first, failed]);
    expect(state).toMatchObject({ satisfied: false, failedSizes: ['M'] });
    expect(state.checks.find(row => row.size === 'S')?.reportId).toBe('FIRST');
    expect(state.checks.find(row => row.size === 'M')?.reportId).toBe('NOK');
    expect(project([first, failed, report('RETEST', 3, facts(['M'], false))])).toMatchObject({ satisfied: true });
  });
  it('checks native actual completion sizes without treating zero or plan quantities as production', () => {
    const inspected = report('R', 1, facts(['S'], true));
    expect(project([inspected], { S: 8, M: 0 })).toMatchObject({ satisfied: true, actualSizes: ['S'] });
    expect(project([inspected], { S: 8, M: 3 })).toMatchObject({ satisfied: false, scopeComplete: false, missingSizes: ['M'] });
    expect(project([report('R', 1, facts(['S', 'M'], true))], { S: 8, M: 0 })).toMatchObject({ satisfied: false });
  });
  it('does not drop an actual size observed outside a later complete scope', () => {
    expect(project([report('S', 1, facts(['S'])), report('M', 2, facts(['M'], true))])).toMatchObject({
      satisfied: false, scopeComplete: false, actualSizes: ['M', 'S'],
    });
  });
  it('requires a named issue retest to inspect its failed sizes rather than an unrelated size or an old pass', () => {
    const failed = facts(['S', 'M'], false, [check('M', 'fail')]);
    expect(() => assertProductionSizeRetest(failed, facts(['S'], false), true)).toThrow(/M/);
    expect(() => assertProductionSizeRetest(failed, facts(['M'], false), true)).not.toThrow();
    expect(() => assertProductionSizeRetest(null, facts(['M'], false), true)).toThrow();
    expect(() => assertProductionSizeRetest(null, facts(['M'], true), true)).not.toThrow();
    expect(() => assertProductionSizeRetest(null, null, false)).not.toThrow();
  });
});
