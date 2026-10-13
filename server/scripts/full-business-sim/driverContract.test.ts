import { describe, expect, it, vi } from 'vitest';
import { scenarioCommand, type ScenarioCommandRecord, type ScenarioDriverDependencies } from './driverContract';
import { planScenarioMasterData } from './masterData';

function harness() {
  const records = new Map<string, ScenarioCommandRecord>();
  const invoke = vi.fn<ScenarioDriverDependencies['invoke']>(async () => ({ status: 201, body: { ok: true, id: 'native-created' } }));
  const deps: ScenarioDriverDependencies = { invoke, journal: { read: async key => records.get(key) ?? null,
    write: async record => { records.set(record.key, structuredClone(record)); } }, runtimeId: 'isolated-test-runtime',
    actorIds: Object.fromEntries(Object.entries(planScenarioMasterData({ namespace: 'command-test', nowMs: 0 }).cast).map(([key, actor]) => [key, actor.id])) as ScenarioDriverDependencies['actorIds'],
    verifyActor: vi.fn(async () => {}) };
  return { deps, invoke, records };
}
const input = { key: 'actual-create', actor: 'fabric1Sales' as const, method: 'post' as const, url: '/api/v2/orders', body: { quantity: '1000' } };
describe('business scenario command recovery', () => {
  it('persists the original intent before sending, including the immutable payload', async () => {
    const h = harness(); h.invoke.mockImplementationOnce(async () => {
      expect(h.records.get(input.key)).toMatchObject({ state: 'intent', body: input.body, actor: input.actor });
      return { status: 201, body: { ok: true, id: 'real-receipt' } };
    });
    expect(await scenarioCommand(h.deps, input)).toMatchObject({ id: 'real-receipt' });
    expect(h.records.get(input.key)?.state).toBe('acknowledged');
  });
  it('returns an acknowledged create instead of issuing another create on resume', async () => {
    const h = harness(); await scenarioCommand(h.deps, input);
    await scenarioCommand(h.deps, input); expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it('stops a non-idempotent create after the transaction committed but its acknowledgement was lost', async () => {
    const h = harness(); let committed = 0;
    h.invoke.mockImplementationOnce(async () => { committed++; throw Error('lost acknowledgement'); });
    await expect(scenarioCommand(h.deps, input)).rejects.toThrow('lost acknowledgement');
    await expect(scenarioCommand(h.deps, input)).rejects.toThrow('RECONCILE_REQUIRED');
    expect(committed).toBe(1); expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it('recovers a native idempotent command with the same actor and original payload', async () => {
    const h = harness(), command = { ...input, idempotent: true, body: { requestKey: input.key, expectedUpdatedAt: 'original-epoch' } };
    h.invoke.mockRejectedValueOnce(Error('lost acknowledgement'));
    await expect(scenarioCommand(h.deps, command)).rejects.toThrow('lost acknowledgement');
    await scenarioCommand(h.deps, command);
    expect(h.invoke.mock.calls[1][3]).toEqual(command.body);
  });
  it('refuses changed CAS facts and actor switches for an original command key', async () => {
    const h = harness(); await scenarioCommand(h.deps, input);
    await expect(scenarioCommand(h.deps, { ...input, body: { quantity: '2000' } })).rejects.toThrow('COMMAND_CHANGED');
    await expect(scenarioCommand(h.deps, { ...input, actor: 'fabric2Sales' })).rejects.toThrow('COMMAND_CHANGED');
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it('does not record a failed gate as an earned receipt', async () => {
    const h = harness(); h.invoke.mockResolvedValueOnce({ status: 409, body: { ok: false, error: 'QC_REQUIRED' } });
    await expect(scenarioCommand(h.deps, input)).rejects.toThrow('QC_REQUIRED');
    expect(h.records.get(input.key)?.state).toBe('intent');
  });
  it('cannot flip a non-idempotent intent into an idempotent retry after a lost create acknowledgement', async () => {
    const h = harness(); h.invoke.mockRejectedValueOnce(Error('committed then ACK lost'));
    await expect(scenarioCommand(h.deps, input)).rejects.toThrow('ACK lost');
    await expect(scenarioCommand(h.deps, { ...input, idempotent: true })).rejects.toThrow('COMMAND_CHANGED');
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it('binds receipts to the actual runtime and account identity', async () => {
    const h = harness(); await scenarioCommand(h.deps, input);
    h.deps.runtimeId = 'another-database-reset-instance';
    await expect(scenarioCommand(h.deps, input)).rejects.toThrow('COMMAND_CHANGED');
    h.deps.runtimeId = 'isolated-test-runtime'; h.deps.actorIds.fabric1Sales = 'different-actual-account';
    await expect(scenarioCommand(h.deps, input)).rejects.toThrow('COMMAND_CHANGED');
  });
  it('checks the current actor even when recovering a previously acknowledged historical ID', async () => {
    const h = harness(); await scenarioCommand(h.deps, input);
    h.deps.verifyActor = async () => { throw Error('CURRENT_ACCOUNT_DISABLED'); };
    await expect(scenarioCommand(h.deps, input)).rejects.toThrow('CURRENT_ACCOUNT_DISABLED');
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it('never caches a current GET projection in the command journal', async () => {
    const h = harness(), read = { ...input, method: 'get' as const, body: undefined };
    h.invoke.mockResolvedValueOnce({ status: 200, body: { status: 'pending' } }).mockResolvedValueOnce({ status: 200, body: { status: 'approved' } });
    expect(await scenarioCommand(h.deps, read)).toEqual({ status: 'pending' });
    expect(await scenarioCommand(h.deps, read)).toEqual({ status: 'approved' }); expect(h.records.size).toBe(0);
  });
});
