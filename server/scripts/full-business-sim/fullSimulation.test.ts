import { describe, expect, it } from 'vitest';
import { planScenarioMasterData } from './masterData';
import { createScenarioCashResolver } from './fullSimulation';
import type { ScenarioCommandRecord, ScenarioDriverDependencies } from './driverContract';

const master = planScenarioMasterData({ namespace: 'cash-opening', nowMs: Date.parse('2026-10-08T00:18:00Z') });
function boundary() {
  const records = new Map<string, ScenarioCommandRecord>(), calls: any[] = [];
  let account: any, opening: any, lost = false, created = 0, opened = 0, counterfeit = false;
  const deps: ScenarioDriverDependencies = {
    runtimeId: 'native-cash-test', actorIds: Object.fromEntries(Object.entries(master.cast).map(([key, row]) => [key, row.id])) as any,
    verifyActor: async () => {}, journal: { read: async key => records.get(key) ?? null, write: async row => { records.set(row.key, structuredClone(row)); } },
    invoke: async (actor, method, url, body: any) => {
      calls.push({ actor, method, url, body: structuredClone(body) });
      if (method === 'post' && url === '/api/v1/finance/cash-accounts') {
        created++; account = { ...body, id: `CASH-${body.currency}`, revision: 1 }; return { status: 201, body: { ok: true, account: structuredClone(account) } };
      }
      if (method === 'post' && url === `/api/v1/finance/cash-accounts/${account.id}/commands`) {
        if (!opening) { opened++; opening = { id: 'OPENING', ...body, amount: body.amount.replace(/\.0+$/, ''), kind: 'Opening', signedAmount: body.amount.replace(/\.0+$/, '') }; account.revision++; }
        const ack = { account, entry: opening, financeCommand: { kind: 'cash_account.opening', actorId: master.cast.financeAccountant.id, targetId: account.id, auditId: 'AUDIT' } };
        if (lost) { lost = false; throw Error('opening committed; ACK lost'); }
        return { status: 201, body: structuredClone(ack) };
      }
      if (method === 'get' && url === `/api/v1/finance/cash-accounts/${account.id}`) return { status: 200, body: { account, opening,
        balance: opening ? opening.amount : counterfeit ? '0.0000' : null, balanceStatus: opening || counterfeit ? 'verified' : 'unknown', sourcesAvailable: true, entries: opening ? [opening] : [] } };
      throw Error('Unexpected cash command');
    },
  };
  return { deps, calls, get created() { return created; }, get opened() { return opened; }, lose: () => { lost = true; }, counterfeit: () => { counterfeit = true; } };
}
describe('scenario bank opening authority', () => {
  it('records a distinct evidenced opening through the actual accountant command, independently of AR/AP', async () => {
    const f = boundary(), resolve = createScenarioCashResolver(master, f.deps);
    expect(await resolve('CNY')).toEqual({ id: 'CASH-CNY' }); await resolve('CNY');
    expect(f.created).toBe(1); expect(f.opened).toBe(1);
    const command = f.calls.find(row => row.url.endsWith('/commands'));
    expect(command).toMatchObject({ actor: 'financeAccountant', body: { action: 'opening', amount: '800000.0000', occurredDate: '2026-09-01', expectedRevision: 1, bankReference: 'SIM-BANK-OPENING-20260901-CNY' } });
    expect(command.body.evidenceNote).toContain('不包含9月1日及以后的收支');
  });
  it('retries an unknown opening acknowledgement with the exact original key and revision', async () => {
    const f = boundary(), resolve = createScenarioCashResolver(master, f.deps); f.lose();
    await expect(resolve('USD')).rejects.toThrow('ACK lost'); expect(await resolve('USD')).toEqual({ id: 'CASH-USD' });
    const writes = f.calls.filter(row => row.url.endsWith('/commands')); expect(writes[1].body).toEqual(writes[0].body);
    expect(f.created).toBe(1); expect(f.opened).toBe(1);
  });
  it('keeps the unverified EUR opening explicitly unknown and refuses a counterfeit zero balance', async () => {
    const f = boundary(), resolve = createScenarioCashResolver(master, f.deps); await resolve('EUR');
    expect(f.opened).toBe(0); f.counterfeit(); await expect(resolve('EUR')).rejects.toThrow('UNKNOWN_OPENING_INVENTED');
  });
});
