import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertMatchingScenarioRuntimeIdentity, isScenarioLoopbackCaller, readScenarioDatabaseIdentity, readScenarioRuntimeIdentity } from '../scenarioIdentity';
import { createDevPanelRouter } from '../route';

const state = vi.hoisted(() => ({ active: 'panda_hub_dev', clock: {
  mode: 'fixed', database: 'panda_hub_dev', timeZone: 'Asia/Shanghai', nowIso: '2026-10-08T00:18:00.000Z',
} }));
vi.mock('../activeDb', () => ({ getActiveDb: () => state.active, setActiveDb: vi.fn() }));
vi.mock('../../shared/businessClock', () => ({ BUSINESS_CLOCK_DATABASE: 'panda_hub_dev', BUSINESS_TIME_ZONE: 'Asia/Shanghai',
  FIXED_BUSINESS_TIME_ISO: '2026-10-08T00:18:00.000Z', getBusinessClock: () => state.clock }));
vi.mock('../../auth/service', () => ({ createAuthService: () => ({ signToken: () => 'unused' }) }));
const originalEnv = { nodeEnv: process.env.NODE_ENV, devPanel: process.env.BAMBOOK_DEV_PANEL };
const requestKey = 'original-rebuild-command';
function fixture() {
  const db = { name: 'panda_hub_dev', port: 5432, address: '127.0.0.1', readOnly: 'on', instanceFingerprint: 'a'.repeat(64),
    data_directory: '/must-not-escape/private-postgres' };
  const receipt = { protocolVersion: 1, phase: 'master_provisioned', namespace: 'identity-review', requestKey,
    planSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64), credentialsSha256: 'd'.repeat(64), transactionId: '123',
    master: { passwords: 'must-not-escape' } };
  const audit = { id: 'AUDIT-ORIGINAL', actorId: 'system', detail: { source: 'script:dev-scenario-rebuild', after: receipt } };
  let readOnly = false;
  const tx = {
    $executeRaw: vi.fn(async () => { readOnly = true; return 0; }),
    $queryRaw: vi.fn(async (_sql: unknown) => { expect(readOnly).toBe(true); return [db]; }),
    auditLog: { findMany: vi.fn(async (_input: unknown) => [audit]) },
  };
  const prisma: any = { $transaction: vi.fn(async (run: any) => run(tx)) };
  return { prisma, tx, db, receipt, audit };
}
beforeEach(() => {
  process.env.NODE_ENV = 'test'; process.env.BAMBOOK_DEV_PANEL = '1'; state.active = 'panda_hub_dev';
  state.clock = { mode: 'fixed', database: 'panda_hub_dev', timeZone: 'Asia/Shanghai', nowIso: '2026-10-08T00:18:00.000Z' };
});
afterEach(() => {
  if (originalEnv.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnv.nodeEnv;
  if (originalEnv.devPanel === undefined) delete process.env.BAMBOOK_DEV_PANEL; else process.env.BAMBOOK_DEV_PANEL = originalEnv.devPanel;
});

describe('scenario HTTP/SQL original runtime identity', () => {
  it('uses the protected no-argument physical hash without reading privileged settings as the app role', async () => {
    const f = fixture();
    f.tx.$queryRaw.mockImplementation(async (sql: unknown) => {
      const query = Array.isArray(sql) ? sql.join('') : String(sql);
      if (/data_directory|pg_control_system\s*\(/.test(query)) throw Object.assign(new Error('app setting access denied'), { code: 'P2010', meta: { code: '42501' } });
      expect(query).toContain('bambook_runtime_identity.physical_fingerprint()');
      return [f.db];
    });
    await expect(readScenarioDatabaseIdentity(f.prisma, 5432)).resolves.toMatchObject({ database: { instanceFingerprint: 'a'.repeat(64) } });
    expect(f.tx.auditLog.findMany).not.toHaveBeenCalled();
  });
  it.each(['42501', '42883', '3F000'])('fails closed with a safe prerequisite error when the physical helper is unavailable (%s)', async code => {
    const f = fixture();
    f.tx.$queryRaw.mockRejectedValue(Object.assign(new Error('/private/postgres password=must-not-escape'), { code: 'P2010', meta: { code } }));
    await expect(readScenarioDatabaseIdentity(f.prisma)).rejects.toMatchObject({ code: 'SCENARIO_PHYSICAL_IDENTITY_UNAVAILABLE', statusCode: 409 });
    expect(f.tx.auditLog.findMany).not.toHaveBeenCalled();
  });
  it('offers a database-only identity before any original master receipt exists without weakening the receipt endpoint', async () => {
    const f = fixture(); f.tx.auditLog.findMany.mockResolvedValue([]);
    const router: any = createDevPanelRouter({ prisma: f.prisma });
    const route = router.stack.find((layer: any) => layer.route?.path === '/database-identity');
    expect(route).toBeDefined();
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    await route.route.stack[0].handle({ socket: { remoteAddress: '127.0.0.1' }, query: {} }, res);
    expect(res.json).toHaveBeenLastCalledWith({ ok: true, identity: expect.objectContaining({ protocolVersion: 1,
      database: expect.objectContaining({ port: 5432, instanceFingerprint: 'a'.repeat(64) }) }) });
    expect(f.tx.auditLog.findMany).not.toHaveBeenCalled();
    await expect(readScenarioRuntimeIdentity(f.prisma, requestKey)).rejects.toThrow('SCENARIO_RUNTIME_ORIGINAL_RECEIPT_CHANGED');
  });
  it('reads SQL identity and the unique original receipt in one read-only transaction without exposing paths or credentials', async () => {
    const f = fixture(), proof = await readScenarioRuntimeIdentity(f.prisma, requestKey, 5432);
    expect(proof).toMatchObject({ protocolVersion: 1, database: { name: 'panda_hub_dev', port: 5432, instanceFingerprint: 'a'.repeat(64) },
      receipt: { requestKey, transactionId: '123', credentialsSha256: 'd'.repeat(64) } });
    expect(JSON.stringify(proof)).not.toContain('must-not-escape');
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.tx.auditLog.findMany.mock.calls[0][0]).toMatchObject({ where: { action: 'dev_scenario_master_provisioned', targetType: 'ScenarioDevRebuild', targetId: requestKey }, take: 2 });
  });
  it('rejects unknown or changed actual SQL identity, rather than trusting the environment database name', async () => {
    for (const change of [{ name: 'panda_hub_empty' }, { port: 55432 }, { readOnly: 'off' }, { instanceFingerprint: '' }, { address: '10.0.0.1' }]) {
      const f = fixture(); Object.assign(f.db, change);
      await expect(readScenarioRuntimeIdentity(f.prisma, requestKey, 5432)).rejects.toThrow('SCENARIO_RUNTIME_IDENTITY_CHANGED');
    }
  });
  it('requires the exact unique original system receipt, not merely matching account IDs', async () => {
    for (const kind of ['missing', 'ambiguous', 'actor', 'source', 'request']) {
      const f = fixture();
      if (kind === 'missing') f.tx.auditLog.findMany.mockResolvedValue([]);
      if (kind === 'ambiguous') f.tx.auditLog.findMany.mockResolvedValue([f.audit, f.audit]);
      if (kind === 'actor') f.audit.actorId = 'owner';
      if (kind === 'source') f.audit.detail.source = 'other-script';
      if (kind === 'request') f.receipt.requestKey = 'different-rebuild-command';
      await expect(readScenarioRuntimeIdentity(f.prisma, requestKey)).rejects.toThrow('SCENARIO_RUNTIME_ORIGINAL_RECEIPT_CHANGED');
    }
  });
  it('refuses a company or fixed-clock change while the active transaction is reading', async () => {
    const switched = fixture(); switched.tx.auditLog.findMany.mockImplementation(async () => { state.active = 'panda_hub_empty'; return [switched.audit]; });
    await expect(readScenarioRuntimeIdentity(switched.prisma, requestKey)).rejects.toThrow('SCENARIO_RUNNING_DEV_TARGET_CHANGED');
    state.active = 'panda_hub_dev';
    const clock = fixture(); clock.tx.auditLog.findMany.mockImplementation(async () => { state.clock.nowIso = '2026-10-09T00:00:00.000Z'; return [clock.audit]; });
    await expect(readScenarioRuntimeIdentity(clock.prisma, requestKey)).rejects.toThrow('SCENARIO_RUNNING_DEV_TARGET_CHANGED');
  });
  it('rejects disabled dev guards and malformed or repeated request keys before any SQL access', async () => {
    const f = fixture(); process.env.NODE_ENV = 'production';
    await expect(readScenarioRuntimeIdentity(f.prisma, requestKey)).rejects.toThrow('SCENARIO_RUNNING_DEV_TARGET_CHANGED');
    process.env.NODE_ENV = 'test'; delete process.env.BAMBOOK_DEV_PANEL;
    await expect(readScenarioRuntimeIdentity(f.prisma, requestKey)).rejects.toThrow('SCENARIO_RUNNING_DEV_TARGET_CHANGED');
    process.env.BAMBOOK_DEV_PANEL = '1';
    for (const value of ['', ['original-rebuild-command', 'other-command'], '../private'])
      await expect(readScenarioRuntimeIdentity(f.prisma, value)).rejects.toMatchObject({ statusCode: 400 });
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('compares the physical cluster, port and all original receipt fields while accepting both local address families', async () => {
    const f = fixture(), proof = await readScenarioRuntimeIdentity(f.prisma, requestKey);
    expect(() => assertMatchingScenarioRuntimeIdentity({ ...proof, database: { ...proof.database, address: '::1' } }, proof)).not.toThrow();
    for (const changed of [{ database: { ...proof.database, port: 55432 } }, { database: { ...proof.database, instanceFingerprint: 'e'.repeat(64) } },
      { receipt: { ...proof.receipt, sourceSha256: 'f'.repeat(64) } }, { receipt: { ...proof.receipt, transactionId: '124' } }])
      expect(() => assertMatchingScenarioRuntimeIdentity({ ...proof, ...changed }, proof)).toThrow('SCENARIO_RUNTIME_IDENTITY_CHANGED');
  });
  it('uses the actual socket for the local-only identity route and ignores forwarded loopback claims', async () => {
    const f = fixture(), router: any = createDevPanelRouter({ prisma: f.prisma });
    const handler = router.stack.find((layer: any) => layer.route?.path === '/scenario-identity').route.stack[0].handle;
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    await handler({ socket: { remoteAddress: '192.0.2.5' }, ip: '127.0.0.1', headers: { 'x-forwarded-for': '127.0.0.1' }, query: { requestKey } }, res);
    expect(res.status).toHaveBeenCalledWith(404); expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(isScenarioLoopbackCaller('::ffff:127.0.0.1')).toBe(true); expect(isScenarioLoopbackCaller(undefined)).toBe(false);
    await handler({ socket: { remoteAddress: '127.0.0.1' }, query: { requestKey } }, res);
    expect(res.json).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, identity: expect.objectContaining({ receipt: expect.objectContaining({ requestKey }) }) }));
  });
});
