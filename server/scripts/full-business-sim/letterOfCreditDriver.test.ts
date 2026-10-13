import { describe, expect, it } from 'vitest';
import { planScenarioMasterData } from './masterData';
import { buildBusinessScenarios } from './scenarios';
import { prepareScenarioFinancialInstrument } from './letterOfCreditDriver';
import type { ScenarioCommandRecord, ScenarioDriverDependencies } from './driverContract';

function fixture() {
  const master = planScenarioMasterData({ namespace: 'lc-native-script', nowMs: Date.parse('2026-10-08T00:18:00.000Z') });
  const scenario = buildBusinessScenarios(master).orders.find(row => row.stopAfter === 'document_return')!;
  const records = new Map<string, ScenarioCommandRecord>();
  let created: any, count = 0, revoked = false, loseAck = false, instrument = 'L/C';
  const deps: ScenarioDriverDependencies = { runtimeId: 'fresh-native-instance',
    actorIds: Object.fromEntries(Object.values(master.cast).map(actor => [actor.key, actor.id])) as any,
    verifyActor: async () => { if (revoked) throw Error('actor revoked'); },
    journal: { read: async key => records.get(key) ?? null, write: async record => { records.set(record.key, record); } },
    invoke: async (_actor, method, url, body) => {
      if (method === 'post') { count++; created = { ...(body as any), id: 'native-lc', status: 'Issued' }; if (loseAck) throw Error('transport ACK lost'); return { status: 201, body: { item: created } }; }
      if (url.startsWith('/api/v2/orders/')) return { status: 200, body: { order: { id: 'native-order', customerRelationId: scenario.customerId,
        currency: scenario.currency, lines: [{ id: 'native-line' }], paymentInstrument: instrument } } };
      if (url.endsWith('/events')) return { status: 200, body: { items: [{ toNode: 'Issued', actorId: master.cast[scenario.logistics].id, eventDate: '2026-10-08' }] } };
      if (url.includes('?')) return { status: 200, body: { items: created ? [created] : [] } };
      return { status: 200, body: { item: created } };
    } };
  return { master, scenario, deps, run: () => prepareScenarioFinancialInstrument({ master, scenario, deps, orderId: 'native-order', lineId: 'native-line' }),
    count: () => count, revoke: () => { revoked = true; }, lose: () => { loseAck = true; }, nonLc: () => { instrument = 'T/T'; },
    alter: () => { created.amount = '1'; } };
}
describe('real LC registration orchestration', () => {
  it('registers through the logistics actor once, reads its actual terms and issue timeline and preserves non-LC contracts', async () => {
    const f = fixture(); await f.run(); await f.run(); expect(f.count()).toBe(1);
    const other = fixture(); other.nonLc(); await other.run(); expect(other.count()).toBe(0);
  });
  it('reconciles an unknown non-idempotent create by exact LC number, source, terms and actual issue actor without resending', async () => {
    const f = fixture(); f.lose(); await expect(f.run()).rejects.toThrow('ACK lost'); await f.run(); expect(f.count()).toBe(1); await f.run(); expect(f.count()).toBe(1);
  });
  it('blocks altered current terms and a revoked actor even with a saved original acknowledgement', async () => {
    const f = fixture(); await f.run(); f.alter(); await expect(f.run()).rejects.toThrow('TERMS_MISMATCH'); expect(f.count()).toBe(1);
    const other = fixture(); await other.run(); other.revoke(); await expect(other.run()).rejects.toThrow('actor revoked'); expect(other.count()).toBe(1);
  });
});
