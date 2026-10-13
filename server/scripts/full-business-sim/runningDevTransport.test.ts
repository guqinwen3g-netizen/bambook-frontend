import { describe, expect, it } from 'vitest';
import { planScenarioMasterData } from './masterData';
import { SCENARIO_BUSINESS_TIME } from './scenarios';
import { createRunningDevTransport } from './runningDevTransport';
import type { ScenarioRuntimeIdentity } from '../../src/devPanel/scenarioIdentity';
const master = planScenarioMasterData({ namespace: 'running-dev', nowMs: Date.parse(SCENARIO_BUSINESS_TIME) });
function originalProof(): ScenarioRuntimeIdentity {
  return { protocolVersion: 1, database: { name: 'panda_hub_dev', port: 5432, address: '127.0.0.1', instanceFingerprint: 'a'.repeat(64) },
    businessClock: { mode: 'fixed', database: 'panda_hub_dev', timeZone: 'Asia/Shanghai', nowIso: SCENARIO_BUSINESS_TIME },
    receipt: { protocolVersion: 1, phase: 'master_provisioned', namespace: 'running-dev', requestKey: 'original-command',
      planSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64), credentialsSha256: 'd'.repeat(64), transactionId: '1' } };
}

function fixture() {
  const calls: Array<{ url: string; input?: RequestInit }> = [];
  let database = 'panda_hub_dev', revoked = false, sqlProof = originalProof();
  const fetcher = async (input: string | URL, options?: RequestInit): Promise<Response> => {
    const url = String(input); calls.push({ url, input: options });
    if (url.includes('/api/dev/scenario-identity?')) return Response.json({ ok: true, identity: sqlProof });
    if (url.endsWith('/api/dev/status')) return Response.json({ ok: true, devPanelEnabled: true, currentDb: database,
      env: { nodeEnv: 'development' }, businessClock: { mode: 'fixed', database: 'panda_hub_dev', timeZone: 'Asia/Shanghai', nowIso: SCENARIO_BUSINESS_TIME } });
    if (url.endsWith('/api/auth/login')) {
      const body = JSON.parse(String(options?.body)), actor = Object.values(master.cast).find(row => row.email === body.identifier)!;
      return Response.json({ token: `token-${actor.id}`, user: { id: actor.id } });
    }
    if (url.endsWith('/api/auth/me')) {
      const auth = new Headers(options?.headers).get('Authorization')!;
      return revoked ? Response.json({ error: 'revoked' }, { status: 401 }) : Response.json({ user: { id: auth.slice('Bearer token-'.length) } });
    }
    if (url.endsWith('/download')) return new Response(Buffer.from('%PDF-1.4\nnative bytes'), { headers: { 'Content-Type': 'application/pdf' } });
    return Response.json({ ok: true, native: true });
  };
  return { fetcher: fetcher as typeof fetch, calls, switchTarget: () => { database = 'panda_hub_empty'; }, revoke: () => { revoked = true; },
    setSqlProof: (value: ScenarioRuntimeIdentity) => { sqlProof = value; } };
}
describe('running dev native transport boundary', () => {
  it('logs in each actual account and reads current target and identity before JSON and binary commands', async () => {
    const f = fixture(), transport = await createRunningDevTransport(master, { fetcher: f.fetcher });
    expect(f.calls.filter(row => row.url.endsWith('/api/auth/login'))).toHaveLength(Object.keys(master.cast).length);
    expect(await transport.invoke('fabric1Sales', 'post', '/api/v2/orders', { native: 'command' })).toMatchObject({ status: 200, body: { native: true } });
    const response = await transport.invoke('logistics1', 'get', '/api/v1/customs/trade-documents/doc/download');
    expect(Buffer.isBuffer(response.body)).toBe(true); expect(response.body.toString()).toMatch(/^%PDF/);
    expect(f.calls.every(row => row.input?.redirect === 'error')).toBe(true);
  });
  it('rejects target drift and revoked real sessions before another mutation', async () => {
    const f = fixture(), transport = await createRunningDevTransport(master, { fetcher: f.fetcher });
    f.switchTarget(); await expect(transport.invoke('fabric1Sales', 'post', '/api/v2/orders', {})).rejects.toThrow('TARGET_CHANGED');
    expect(f.calls.some(row => row.url.endsWith('/api/v2/orders'))).toBe(false);
    const other = fixture(), valid = await createRunningDevTransport(master, { fetcher: other.fetcher });
    other.revoke(); await expect(valid.invoke('financeAccountant', 'post', '/api/v1/finance/vouchers', {})).rejects.toThrow('ACTOR_REVOKED');
    expect(other.calls.some(row => row.url.endsWith('/api/v1/finance/vouchers'))).toBe(false);
  });
  it('rejects replacement of the original rebuild even when database, clock and account IDs remain the same', async () => {
    const f = fixture(); let original = true;
    const transport = await createRunningDevTransport(master, { fetcher: f.fetcher, verifyRuntimeAnchor: async () => {
      if (!original) throw Error('SCENARIO_RUNTIME_ORIGINAL_RECEIPT_CHANGED');
      return originalProof();
    } });
    original = false;
    await expect(transport.invoke('owner', 'post', '/api/v2/orders', {})).rejects.toThrow('ORIGINAL_RECEIPT_CHANGED');
    expect(f.calls.some(row => row.url.endsWith('/api/v2/orders'))).toBe(false);
    const beforeLogin = fixture();
    await expect(createRunningDevTransport(master, { fetcher: beforeLogin.fetcher,
      verifyRuntimeAnchor: async () => { throw Error('SCENARIO_RUNTIME_ORIGINAL_RECEIPT_CHANGED'); } })).rejects.toThrow('ORIGINAL_RECEIPT_CHANGED');
    expect(beforeLogin.calls.some(row => row.url.endsWith('/api/auth/login'))).toBe(false);
  });
  it('rejects same-name SQL clones before credentials even when their clocks and account IDs match', async () => {
    for (const changed of [{ port: 55432 }, { instanceFingerprint: 'e'.repeat(64) }]) {
      const f = fixture(), proof = originalProof();
      f.setSqlProof({ ...proof, database: { ...proof.database, ...changed } });
      await expect(createRunningDevTransport(master, { fetcher: f.fetcher, verifyRuntimeAnchor: async () => proof }))
        .rejects.toThrow('SCENARIO_RUNTIME_IDENTITY_CHANGED');
      expect(f.calls.some(row => row.url.endsWith('/api/auth/login'))).toBe(false);
    }
  });
  it('compares the HTTP original receipt and rechecks its own SQL instance before subsequent writes', async () => {
    const f = fixture(), proof = originalProof();
    const transport = await createRunningDevTransport(master, { fetcher: f.fetcher, verifyRuntimeAnchor: async () => proof });
    f.setSqlProof({ ...proof, receipt: { ...proof.receipt, transactionId: '2' } });
    await expect(transport.invoke('owner', 'post', '/api/v2/orders', {})).rejects.toThrow('SCENARIO_RUNTIME_IDENTITY_CHANGED');
    expect(f.calls.some(row => row.url.endsWith('/api/v2/orders'))).toBe(false);
    const missing = fixture();
    const fetcher = (async (url: string | URL, options?: RequestInit) => String(url).includes('/scenario-identity?')
      ? Response.json({ ok: false }, { status: 404 }) : missing.fetcher(url, options)) as typeof fetch;
    await expect(createRunningDevTransport(master, { fetcher, verifyRuntimeAnchor: async () => proof })).rejects.toThrow('SCENARIO_RUNTIME_IDENTITY_CHANGED');
    expect(missing.calls.some(row => row.url.endsWith('/api/auth/login'))).toBe(false);
  });
  it('never sends secrets or commands to a different origin, redirect target or non-API path', async () => {
    const f = fixture();
    await expect(createRunningDevTransport(master, { baseUrl: 'https://example.com', fetcher: f.fetcher })).rejects.toThrow('LOCAL_DEV_ORIGIN');
    expect(f.calls).toHaveLength(0);
    const transport = await createRunningDevTransport(master, { fetcher: f.fetcher }), count = f.calls.length;
    for (const url of ['https://example.com/api/v2/orders', '//example.com/api/auth/me', '/uploads/private', '/api/../../secret'])
      await expect(transport.invoke('owner', 'post', url, {})).rejects.toThrow('API_PATH_REQUIRED');
    expect(f.calls).toHaveLength(count);
  });
});
