import type { ScenarioMasterData } from './masterData';
import { scenarioCommand, type ScenarioDriverDependencies } from './driverContract';

/** Real administrator policy configuration precedes business creation. This
 * never restores a policy altered or withdrawn after a simulation began. */
export async function configureSimulationBusinessPolicy(master: ScenarioMasterData, deps: ScenarioDriverDependencies) {
  if (deps.actorIds.owner !== master.cast.owner.id) throw Error('SCENARIO_CONFIGURATION_ACTOR_MISMATCH');
  const marker = `SIMULATION:${master.namespace}:native-policy`, company = master.catalog.company;
  const exporterValue = { nameEn: company.englishName, beneficiary: company.englishName, addressEn: company.address,
    bankName: 'SIMULATION BANK - NO REAL TRANSFER', swiftCode: '', bankAddress: 'SIMULATION ONLY', usdAccountNumber: 'SIMULATION-NO-REAL-ACCOUNT' };
  const moqValue = { fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20, changeReason: marker };
  async function policy<T>(key: string, url: string, body: object, absent: (row: any) => boolean, matches: (row: any) => boolean): Promise<T> {
    const previous = await deps.journal.read(key);
    if (previous && (previous.runtimeId !== deps.runtimeId || previous.actorId !== master.cast.owner.id
      || previous.actor !== 'owner' || previous.method !== 'put' || previous.url !== url || JSON.stringify(previous.body) !== JSON.stringify(body)))
      throw Error('SCENARIO_CONFIGURATION_COMMAND_CHANGED');
    let current = await scenarioCommand(deps, { key: `${key}:read`, actor: 'owner', method: 'get', url });
    if (matches(current)) {
      if (previous?.state === 'intent') await deps.journal.write({ ...previous, state: 'acknowledged', response: { status: 200, body: current } });
      return current as T;
    }
    if (!absent(current) || previous) throw Error('SCENARIO_POLICY_CHANGED');
    await scenarioCommand(deps, { key, actor: 'owner', method: 'put', url, body });
    current = await scenarioCommand(deps, { key: `${key}:readback`, actor: 'owner', method: 'get', url });
    if (!matches(current)) throw Error('SCENARIO_POLICY_NATIVE_READBACK_MISMATCH');
    return current as T;
  }
  const exporter = await policy<any>('policy:exporter', '/api/v1/config/company.exporterProfile', { value: exporterValue, reason: marker },
    row => row.isDefault === true, row => row.isDefault === false && row.updatedBy === master.cast.owner.id
      && Object.entries(exporterValue).every(([key, value]) => row.value?.[key] === value));
  const moqResponse = await policy<any>('policy:moq', '/api/v1/moq/config', moqValue,
    row => row.item === null, row => row.item?.changedBy === master.cast.owner.id && Object.entries(moqValue).every(([key, value]) => row.item[key] === value));
  return { exporter, moq: moqResponse.item, boundary: 'Administrator simulation policy only; not company cash, bank Opening, approval or trading facts.' };
}
