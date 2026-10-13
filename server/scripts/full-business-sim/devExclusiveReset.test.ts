import { describe, expect, it } from 'vitest';
import { assertExclusiveDevObservation, buildDevClearStatement, buildReviewedTruncateGuardMaintenance } from './devExclusiveReset';

describe('exclusive current-dev rebuild boundaries', () => {
  const identity = { name: 'panda_hub_dev', port: 5432, address: '127.0.0.1', pid: 123, allowsNewConnections: false };
  it('requires the exact SQL target and no competing client, even if every existing row count is unchanged', () => {
    expect(() => assertExclusiveDevObservation(identity, [], 5432)).not.toThrow();
    expect(() => assertExclusiveDevObservation({ ...identity, name: 'panda_hub_empty' }, [], 5432)).toThrow('DEV_REBUILD_TARGET');
    expect(() => assertExclusiveDevObservation({ ...identity, address: '10.0.0.1' }, [], 5432)).toThrow('DEV_REBUILD_TARGET');
    expect(() => assertExclusiveDevObservation(identity, [{ pid: 234, state: 'idle' }], 5432)).toThrow('DEV_REBUILD_OTHER_SESSION');
    expect(() => assertExclusiveDevObservation({ ...identity, allowsNewConnections: true }, [], 5432)).toThrow('DEV_REBUILD_CONNECTION_FENCE');
  });
  it('preserves the original migration ledger and safely quotes the complete table inventory', () => {
    expect(buildDevClearStatement(['Order', 'UserAccount', '_prisma_migrations'])).toBe('TRUNCATE TABLE ONLY public."Order", ONLY public."UserAccount" RESTART IDENTITY RESTRICT');
    expect(buildDevClearStatement(['A"B', '_prisma_migrations'])).toContain('public."A""B"');
    expect(() => buildDevClearStatement(['Order'])).toThrow('DEV_REBUILD_TABLE_INVENTORY');
    expect(() => buildDevClearStatement(['Order', 'Order', '_prisma_migrations'])).toThrow('DEV_REBUILD_TABLE_INVENTORY');
    expect(() => buildDevClearStatement(['_prisma_migrations'])).toThrow('DEV_REBUILD_TABLE_INVENTORY');
  });
  it('suspends only the four reviewed TRUNCATE guards and restores their exact original modes', () => {
    const guards = ['OrderSampleSource', 'OrderSampleCoverage', 'OrderSampleEvent', 'OrderSampleCommandCancellation'].map((table, i) => ({
      table, name: `${table}_no_truncate`, state: ['O', 'A', 'R', 'D'][i], type: 34, args: '', argCount: 0,
      functionSchema: 'public', functionName: 'bambook_order_sample_immutable', qualification: null,
      functionBody: "\nBEGIN\n  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';\nEND;\n",
    }));
    const maintenance = buildReviewedTruncateGuardMaintenance(guards);
    expect(maintenance).toHaveLength(3);
    expect(maintenance[0].restore).toContain(' ENABLE TRIGGER ');
    expect(maintenance[1].restore).toContain(' ENABLE ALWAYS TRIGGER ');
    expect(maintenance[2].restore).toContain(' ENABLE REPLICA TRIGGER ');
    expect(() => buildReviewedTruncateGuardMaintenance([...guards, { ...guards[0], table: 'Unexpected' }])).toThrow('UNREVIEWED_TRUNCATE_GUARD');
    expect(() => buildReviewedTruncateGuardMaintenance(guards.slice(1))).toThrow('UNREVIEWED_TRUNCATE_GUARD');
    for (const mutation of [{ functionBody: 'BEGIN RETURN NULL; END;' }, { type: 35 }, { args: '01' }, { qualification: 'true' }, { name: 'other' }])
      expect(() => buildReviewedTruncateGuardMaintenance([{ ...guards[0], ...mutation }, ...guards.slice(1)])).toThrow('UNREVIEWED_TRUNCATE_GUARD');
  });
});
