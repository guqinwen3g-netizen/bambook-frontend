import { describe, expect, it } from 'vitest';
import { applyMistCommand, createMistState, type MistCommand, type MistContext, type MistQc } from './mistWorkspace';

function fixture() {
  let id = 0;
  const context: MistContext = { id: () => `qc-${++id}`, now: '2026-10-13T08:00:00.000Z', actorName: '实际评审人' };
  const state = createMistState(context);
  const version = state.versions.find(item => item.qc && !item.archivedAt)!;
  const qc: MistQc = { result: 'pass', reviewer: 'QC', reviewedAt: context.now, report: 'QC-A', opinion: '人工独立结论' };
  return { state, context, version, qc };
}
function command(version: ReturnType<typeof fixture>['version'], qc: MistQc): MistCommand {
  return { type: 'development.recordQc', payload: { devId: version.devId, versionId: version.id, qc } };
}

describe('version-specific QC measurement persistence', () => {
  it.each(['pass', 'reject'] as const)('preserves independently selected %s regardless of measurement deviation', result => {
    const { state, context, version, qc } = fixture();
    const measurements = [{ point: '胸围', standard: 112, actual: result === 'pass' ? 120 : 112, tolerance: 1 }, { point: '肩宽', standard: 46, actual: 46, tolerance: 0 }];
    const saved = applyMistCommand(state, command(version, { ...qc, result, measurements, appearanceDefects: 0 }), context);
    expect(saved.state.versions.find(item => item.id === version.id)?.qc).toEqual({ ...qc, result, measurements, appearanceDefects: 0 });
    expect(saved.result).toEqual({ devId: version.devId, versionId: version.id });
    expect(saved.state.versions.filter(item => item.id !== version.id)).toEqual(state.versions.filter(item => item.id !== version.id));
  });

  it('accepts 200 measurements and rejects the 201st without changing the source', () => {
    const { state, context, version, qc } = fixture();
    const measurements = Array.from({ length: 200 }, (_, index) => ({ point: `点 ${index}`, standard: 0, actual: 0, tolerance: 0 }));
    expect(applyMistCommand(state, command(version, { ...qc, measurements }), context).state.versions.find(item => item.id === version.id)?.qc?.measurements).toHaveLength(200);
    const before = structuredClone(state);
    expect(() => applyMistCommand(state, command(version, { ...qc, measurements: [...measurements, measurements[0]] }), context)).toThrow(/200/);
    expect(state).toEqual(before);
  });

  it.each([
    null, {}, [null], [{ point: ' ', standard: 1, actual: 1, tolerance: 1 }],
    [{ point: '点', standard: Number.NaN, actual: 1, tolerance: 1 }],
    [{ point: '点', standard: 1, actual: Number.POSITIVE_INFINITY, tolerance: 1 }],
    [{ point: '点', standard: 1, actual: 1, tolerance: -1 }],
    [{ point: '点', standard: '1', actual: 1, tolerance: 1 }],
  ])('rejects malformed or nonfinite measurement facts: %j', measurements => {
    const { state, context, version, qc } = fixture();
    const before = structuredClone(state);
    expect(() => applyMistCommand(state, command(version, { ...qc, measurements } as MistQc), context)).toThrow();
    expect(state).toEqual(before);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0', null])('rejects invalid appearance defect count: %s', appearanceDefects => {
    const { state, context, version, qc } = fixture();
    expect(() => applyMistCommand(state, command(version, { ...qc, appearanceDefects } as MistQc), context)).toThrow(/非负整数/);
  });

  it('keeps old reports readable and distinguishes unknown defects from an explicit zero', () => {
    const { state, context, version, qc } = fixture();
    const saved = applyMistCommand(state, command(version, qc), context).state.versions.find(item => item.id === version.id)?.qc;
    expect(saved?.measurements).toEqual([]); expect(saved).not.toHaveProperty('appearanceDefects');
    const zero = applyMistCommand(state, command(version, { ...qc, appearanceDefects: 0 }), context).state.versions.find(item => item.id === version.id)?.qc;
    expect(zero?.appearanceDefects).toBe(0);
  });

  it('uses only the four explicit original reference measurements for the initial demo report', () => {
    const { state } = fixture();
    const dev = state.devs.find(item => item.id === 'DEV-G-2026-031')!;
    const qc = state.versions.find(item => item.id === dev.currentVersionId)?.qc;
    expect(qc?.measurements?.map(item => item.point)).toEqual(['胸围', '衣长', '袖长', '肩宽']);
    expect(qc?.appearanceDefects).toBe(0);
  });
});
