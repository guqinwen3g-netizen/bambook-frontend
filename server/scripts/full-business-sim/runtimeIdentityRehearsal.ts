/** Native boundary rehearsal for the caller's already restored private dev PG.
 * No reset, master seeding, fabricated auth token, or business terminal write. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { createAuthRouter } from '../../src/auth/route';
import { createDevPanelRouter } from '../../src/devPanel/route';
import { assertMatchingScenarioDatabaseIdentity, assertMatchingScenarioRuntimeIdentity, readScenarioDatabaseIdentity,
  readScenarioRuntimeIdentity, type ScenarioRuntimeIdentity } from '../../src/devPanel/scenarioIdentity';
import type { ScenarioMasterData } from './masterData';
import type { DevMasterCommittedReceipt } from './provisionDevMaster';
import { createRunningDevTransport } from './runningDevTransport';
import { acquireScenarioPopulationLease } from './populationLease';

export interface RuntimeIdentityRehearsalInput {
  prisma: PrismaClient; master: ScenarioMasterData; receipt: DevMasterCommittedReceipt;
  expectedPort: number; sandbox: string; databaseUrl: string;
}
const LOCAL_ORIGIN = 'http://127.0.0.1:8081';
const POPULATION_KEY = 'bambook:current-dev-scenario-population';
const OTHER_KEY = 'bambook:runtime-identity-rehearsal-unrelated';
const refuse = (message: string): never => { throw Error(`PRIVATE_RUNTIME_IDENTITY_${message}`); };

async function assertPrivateRehearsalTarget(input: RuntimeIdentityRehearsalInput): Promise<string> {
  const suppliedSandbox = path.resolve(input.sandbox), stat = fs.lstatSync(suppliedSandbox), sandbox = fs.realpathSync(suppliedSandbox);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || !path.basename(sandbox).startsWith('bambook-dev-reset-rehearsal-') || (stat.mode & 0o777) !== 0o700
    || typeof process.getuid === 'function' && stat.uid !== process.getuid()) return refuse('SANDBOX_REQUIRED');
  const url = new URL(input.databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.pathname !== '/panda_hub_dev'
    || !Number.isInteger(input.expectedPort) || input.expectedPort === 5432 || Number(url.port) !== input.expectedPort
    || url.searchParams.get('connection_limit') !== '1' || [...url.searchParams.keys()].some(key =>
      ['host', 'hostaddr', 'dbname', 'database', 'service'].includes(key.toLowerCase()))
    || process.env.DATABASE_URL !== input.databaseUrl || process.env.NODE_ENV !== 'development'
    || process.env.BAMBOOK_NO_SCHEDULER !== '1') return refuse('EXACT_PRIVATE_URL_REQUIRED');
  // Inspect the supplied connection before constructing another client or
  // allowing the first real login mutation. Nothing can fall back to .env.
  const rows = await input.prisma.$queryRaw<Array<{ name: string; port: number; directory: string }>>`
    SELECT current_database() AS name, inet_server_port() AS port, current_setting('data_directory') AS directory`;
  if (rows.length !== 1 || rows[0].name !== 'panda_hub_dev' || rows[0].port !== input.expectedPort
    || fs.realpathSync(rows[0].directory) !== fs.realpathSync(path.join(sandbox, 'postgres'))) return refuse('ACTUAL_PRIVATE_CLUSTER_REQUIRED');
  return url.toString();
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

/** The parent runner creates/restores/stops PG. This function owns only its
 * ephemeral loopback HTTP app and one explicitly bounded secondary SQL client. */
export async function verifyRuntimeIdentityRehearsal(input: RuntimeIdentityRehearsalInput) {
  const { prisma, master, receipt, expectedPort } = input;
  const databaseUrl = await assertPrivateRehearsalTarget(input);
  const databaseIdentity = await readScenarioDatabaseIdentity(prisma, expectedPort);
  const expected = await readScenarioRuntimeIdentity(prisma, receipt.requestKey, expectedPort);
  assertMatchingScenarioRuntimeIdentity(expected, { ...expected, receipt });
  assert.equal(master.namespace, receipt.namespace);
  assert.equal(Object.keys(master.cast).length, 21);
  const other = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const checks: Record<string, boolean> = {};
  let server: Server | undefined;
  let lease: Awaited<ReturnType<typeof acquireScenarioPopulationLease>> | undefined;
  let otherLease: Awaited<ReturnType<typeof acquireScenarioPopulationLease>> | undefined;
  let unrelatedHeld = false;
  let loginRequests = 0, meRequests = 0;
  try {
    await other.$connect();
    assertMatchingScenarioDatabaseIdentity(await readScenarioDatabaseIdentity(other, expectedPort), databaseIdentity);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { if (req.path === '/api/auth/login') loginRequests++; if (req.path === '/api/auth/me') meRequests++; next(); });
    app.use('/api/dev', createDevPanelRouter({ prisma: other }));
    app.use('/api/auth', createAuthRouter({ prisma: other, loginRateLimit: false,
      email: { isReal: false, describe: () => 'Private identity rehearsal: no external email', send: async () => { throw Error('PRIVATE_REHEARSAL_EMAIL_FORBIDDEN'); } } }));
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res.status(500).json({ ok: false, error: 'PRIVATE_IDENTITY_HTTP_FAILED' }));
    server = await new Promise<Server>((resolve, reject) => {
      const created = app.listen(0, '127.0.0.1', () => resolve(created)); created.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') return refuse('PRIVATE_HTTP_BIND_REQUIRED');
    const privateOrigin = `http://127.0.0.1:${address.port}`;
    // Only the transport's fixed 8081 origin is remapped. Every response still
    // comes from a real Express route and this private database, not a fake body.
    const fetcher: typeof fetch = async (value, init) => {
      if (typeof value !== 'string' && !(value instanceof URL)) return refuse('TRANSPORT_REQUEST_REQUIRED');
      const original = new URL(String(value));
      if (original.origin !== LOCAL_ORIGIN || !original.pathname.startsWith('/api/') || original.hash) return refuse('TRANSPORT_ORIGIN_CHANGED');
      const destination = new URL(original.pathname + original.search, privateOrigin);
      return fetch(destination, { ...init, redirect: 'error' });
    };
    const httpIdentity = async (url: string) => {
      const response = await fetcher(`${LOCAL_ORIGIN}${url}`, { signal: AbortSignal.timeout(10000) });
      return { status: response.status, body: await response.json() };
    };
    const preMaster = await httpIdentity('/api/dev/database-identity');
    assert.equal(preMaster.status, 200); assert.equal(preMaster.body.ok, true);
    assertMatchingScenarioDatabaseIdentity(preMaster.body.identity, databaseIdentity);
    assert.equal('receipt' in preMaster.body.identity, false);
    assert.equal(JSON.stringify(preMaster.body).includes(input.sandbox), false);
    const noReceipt = await httpIdentity(`/api/dev/scenario-identity?requestKey=${encodeURIComponent(`unrecorded-${randomUUID()}`)}`);
    assert.equal(noReceipt.status, 409); assert.equal(noReceipt.body.error, 'SCENARIO_RUNTIME_ORIGINAL_RECEIPT_CHANGED');
    const actual = await httpIdentity(`/api/dev/scenario-identity?requestKey=${encodeURIComponent(receipt.requestKey)}`);
    assert.equal(actual.status, 200); assert.equal(actual.body.ok, true);
    assertMatchingScenarioRuntimeIdentity(actual.body.identity, expected);
    assert.equal(JSON.stringify(actual.body).includes('password'), false);
    assert.equal(loginRequests, 0);
    checks.httpDatabaseAndOriginalReceiptMatchActualSql = true;
    checks.databaseEndpointNeedsNoOriginalRequest = true;
    checks.missingOriginalReceiptStillRejected = true;
    const differentPort = expectedPort === 65535 ? 65534 : expectedPort + 1;
    const differentFingerprint = (expected.database.instanceFingerprint[0] === 'a' ? 'b' : 'a') + expected.database.instanceFingerprint.slice(1);
    const incorrect: Array<[string, ScenarioRuntimeIdentity]> = [
      ['wrongExpectedPortRejectedBeforeCredentials', { ...expected, database: { ...expected.database, port: differentPort } }],
      ['wrongExpectedPhysicalInstanceRejectedBeforeCredentials', { ...expected, database: { ...expected.database, instanceFingerprint: differentFingerprint } }],
      ['wrongOriginalReceiptRejectedBeforeCredentials', { ...expected, receipt: { ...expected.receipt, transactionId: String(BigInt(expected.receipt.transactionId) + BigInt(1)) } }],
    ];
    for (const [key, wrong] of incorrect) {
      await assert.rejects(createRunningDevTransport(master, { fetcher, verifyRuntimeAnchor: async () => wrong }), /SCENARIO_RUNTIME_IDENTITY_CHANGED/);
      assert.equal(loginRequests, 0); checks[key] = true;
    }
    let bound = expected;
    const transport = await createRunningDevTransport(master, { fetcher, verifyRuntimeAnchor: async () => {
      const current = await readScenarioRuntimeIdentity(prisma, receipt.requestKey, expectedPort);
      assertMatchingScenarioRuntimeIdentity(current, expected);
      // This is an explicit caller expectation for the negative drift case;
      // the immutable original Audit and actual HTTP response are never edited.
      return bound;
    } });
    assert.equal(loginRequests, Object.keys(master.cast).length);
    await transport.verifyActor('owner');
    const me = await transport.invoke('owner', 'get', '/api/auth/me');
    assert.equal(me.status, 200); assert.equal(me.body.user.id, master.cast.owner.id);
    checks.allActualCastLoginsAndCurrentMePassed = true;
    const beforeDriftMe = meRequests;
    bound = incorrect[2][1];
    await assert.rejects(transport.invoke('owner', 'get', '/api/auth/me'), /SCENARIO_RUNTIME_IDENTITY_CHANGED/);
    assert.equal(meRequests, beforeDriftMe); assert.equal(loginRequests, Object.keys(master.cast).length);
    checks.changedExpectedReceiptStopsSubsequentHttpCommand = true;
    await closeServer(server); server = undefined;

    // Session-level exclusion must work for two real one-connection pools.
    const firstPid = await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    const secondPid = await other.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    assert.notEqual(firstPid[0].pid, secondPid[0].pid);
    lease = await acquireScenarioPopulationLease(prisma); await lease.assertHeld();
    await assert.rejects(acquireScenarioPopulationLease(other), /SCENARIO_POPULATION_ALREADY_RUNNING/);
    checks.twoRealSessionsCannotPopulateConcurrently = true;
    await lease.release(); lease = undefined;
    otherLease = await acquireScenarioPopulationLease(other); await otherLease.assertHeld(); await otherLease.release(); otherLease = undefined;
    checks.originalLeaseReleaseAllowsNextSession = true;
    lease = await acquireScenarioPopulationLease(prisma);
    await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtextextended(${POPULATION_KEY},0))`;
    const unrelated = await prisma.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_lock(hashtextextended(${OTHER_KEY},0)) AS acquired`;
    assert.equal(unrelated[0]?.acquired, true); unrelatedHeld = true;
    await assert.rejects(lease.assertHeld(), /SCENARIO_POPULATION_LEASE_LOST/);
    otherLease = await acquireScenarioPopulationLease(other); await otherLease.assertHeld(); await otherLease.release(); otherLease = undefined;
    checks.unrelatedAdvisoryLockCannotMasqueradeAsPopulationLease = true;
    await lease.release(); lease = undefined;
    await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtextextended(${OTHER_KEY},0))`; unrelatedHeld = false;
    otherLease = await acquireScenarioPopulationLease(other); await otherLease.assertHeld();
    await other.$disconnect(); await other.$connect();
    await assert.rejects(otherLease.assertHeld(), /SCENARIO_POPULATION_LEASE_LOST/); otherLease = undefined;
    const replacementLease = await acquireScenarioPopulationLease(other); await replacementLease.assertHeld(); await replacementLease.release();
    checks.reconnectedBackendCannotReuseOldLease = true;
    assertMatchingScenarioRuntimeIdentity(await readScenarioRuntimeIdentity(prisma, receipt.requestKey, expectedPort), expected);
    return { protocolVersion: 1 as const, passed: true as const, databaseIdentity, checks, actualCastLoginCount: loginRequests,
      boundaries: { currentDevUntouched: true, originalReceiptUnmodified: true, businessFactsSeeded: false, privateHttpClosed: true } };
  } finally {
    await closeServer(server);
    await otherLease?.release(); await lease?.release();
    if (unrelatedHeld) await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtextextended(${OTHER_KEY},0))`;
    await other.$disconnect();
  }
}
