import { describe, expect, it } from 'vitest';
import { planScenarioMasterData } from './masterData';
import { configureSimulationBusinessPolicy } from './scenarioConfiguration';
import type { ScenarioCommandRecord, ScenarioDriverDependencies } from './driverContract';
const master = planScenarioMasterData({ namespace: 'native-policy', nowMs: Date.parse('2026-10-08T00:18:00.000Z') });
function fixture() {
  const journal = new Map<string, ScenarioCommandRecord>(), writes: string[] = [];
  let company: any, moq: any, lost = false, revoked = false;
  const deps: ScenarioDriverDependencies = { runtimeId: 'private-policy-instance',
    actorIds: Object.fromEntries(Object.values(master.cast).map(actor => [actor.key, actor.id])) as any,
    journal: { read: async key => journal.get(key) ?? null, write: async row => { journal.set(row.key, row); } },
    verifyActor: async actor => { if (revoked || actor !== 'owner') throw Error('actor revoked'); },
    invoke: async (actor, method, url, input: any) => {
      if (method === 'get') return { status: 200, body: url.includes('exporterProfile') ? (company ?? { isDefault: true, value: {} }) : { item: moq ?? null } };
      writes.push(url);
      if (url.includes('exporterProfile')) company = { isDefault: false, value: input.value, updatedBy: master.cast[actor].id, version: 1 };
      else moq = { id: 'actual-config', ...input, changedBy: master.cast[actor].id };
      if (lost) { lost = false; throw Error('ACK lost'); }
      return { status: 200, body: url.includes('exporterProfile') ? company : { item: moq } };
    } };
  return { deps, writes, lose: () => { lost = true; }, revoke: () => { revoked = true; },
    alter: () => { moq.fabricDefaultMoq = 1; }, foreign: () => { moq = { fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20, changedBy: 'somebody-else', changeReason: 'Actual human policy' }; } };
}
describe('actual simulation company and MOQ configuration', () => {
  it('uses the owner native producers and reads policy back without reusing a previous company or unknown fallback', async () => {
    const f = fixture(), result = await configureSimulationBusinessPolicy(master, f.deps);
    expect(result.exporter.value.nameEn).toBe(master.catalog.company.englishName);
    expect(result.exporter.value.usdAccountNumber).toContain('SIMULATION');
    expect(result.moq).toMatchObject({ fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20, changedBy: master.cast.owner.id });
    await configureSimulationBusinessPolicy(master, f.deps); expect(f.writes).toHaveLength(2);
  });
  it('reconciles unknown configuration ACK by exact current original owner and values instead of writing again', async () => {
    const f = fixture(); f.lose(); await expect(configureSimulationBusinessPolicy(master, f.deps)).rejects.toThrow('ACK lost');
    await configureSimulationBusinessPolicy(master, f.deps); expect(f.writes).toHaveLength(2);
  });
  it('rejects changed, foreign and revoked policies rather than silently restoring them on resume', async () => {
    const f = fixture(); await configureSimulationBusinessPolicy(master, f.deps); f.alter();
    await expect(configureSimulationBusinessPolicy(master, f.deps)).rejects.toThrow('POLICY_CHANGED');
    const other = fixture(); other.foreign(); await expect(configureSimulationBusinessPolicy(master, other.deps)).rejects.toThrow('POLICY_CHANGED');
    const revoked = fixture(); await configureSimulationBusinessPolicy(master, revoked.deps); revoked.revoke();
    await expect(configureSimulationBusinessPolicy(master, revoked.deps)).rejects.toThrow('actor revoked');
  });
});
