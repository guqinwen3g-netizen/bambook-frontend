/**
 * Native manual-fee commands against the reviewed private PostgreSQL runner.
 * Only accounts, least-privilege roles/personal grants, Relation and team-share
 * configuration are technical seeds. Case/Sample/Cost/Billing/Invoice facts and
 * audits come from their actual services/HTTP routes; no approval, shipment,
 * stock, invoice or fee history is manufactured with SQL/Prisma.
 *
 * Proxy delegates below observe or schedule REAL interactive transactions and
 * forward every storage/auth/audit call unchanged. pg_blocking_pids proves the
 * database lock wait. The unique AuditLog trigger injects an actual SQL failure.
 * This is software/storage evidence with synthetic policy configuration, not
 * company-role UAT, whole-V1 acceptance, SMTP or a banking operation.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createBillingItemRouter, createCostRecordRouter } from '../src/finance/billingItemRoute';
import { createSceneInvoiceRouter } from '../src/finance/sceneInvoiceRoute';
import { createFinanceRouter } from '../src/finance/route';
import { createDevelopmentCase } from '../src/development/developmentCaseMutationService';
import { createSample, updateSample } from '../src/samples/sampleManageService';
import { businessEventBus, type BusinessEvent } from '../src/events/businessEventBus';

const prefix = `acceptance-manual-invoice-${randomUUID()}`;
const auth = createAuthService();
const billingPath = '/api/v1/billing-items';
const scenePath = '/api/v1/finance/scene-invoice';
let prisma: PrismaClient | undefined;
let sequence = 0;
function db(): PrismaClient {
  if (!prisma) throw Error('Reviewed private manual-invoice PostgreSQL identity is not verified');
  return prisma;
}
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value,
  (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const errorCode = (response: any) => response.body.error?.code ?? response.body.error;
function safeFailure(response: any) {
  expect(JSON.stringify(response.body)).not.toMatch(/P2003|P2010|23503|trigger|constraint|synthetic_manual_audit|CREATE FUNCTION|AuditLog/i);
  expect(response.body.ok).not.toBe(true);
}

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed isolated PG is required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);
  expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  // This physical identity check precedes every fixture/configuration write.
  expect(await db().$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
  businessEventBus.reset();
  businessEventBus.setPrisma(db());
});
afterAll(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  businessEventBus.reset();
  await prisma?.$disconnect();
});

type Notification = { entity: string; action: string; ids?: string[] };
function app(database: PrismaClient = db(), notifications: Notification[] = []) {
  const result = express(); result.use(express.json());
  // The application has BigInt JSON transport at its composition root. Keep
  // exact timestamps here without importing index.ts or patching prototypes.
  result.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
  result.use(createAccountStatusGuard(db()));
  result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  const options = { prisma: database, requireAuth: true, apiKeys: new Set<string>(),
    onDataChange: (event: Notification) => { notifications.push(event); } };
  result.use(billingPath, createBillingItemRouter(options));
  result.use('/api/v1/cost-records', createCostRecordRouter(options));
  result.use(scenePath, createSceneInvoiceRouter(options));
  result.use('/api/v1/finance', createFinanceRouter(options));
  return result;
}

async function fixture(label: string, options: { shared?: boolean; costs?: string[]; billing?: boolean;
  amount?: string; waived?: string; offset?: string; costSource?: boolean; omitAmount?: boolean; sampleType?: string } = {}) {
  const id = `${prefix}-${++sequence}-${label}`, userId = `${id}-user`, otherUserId = `${id}-owner`,
    customerId = `${id}-customer`, supplierId = `${id}-supplier`, roleId = `${id}-least-role`,
    teamId = `${id}-team`, shareId = `${id}-share`, now = BigInt(Date.now());
  const scopes = ['invoices:read', 'invoices:write', 'products:read', 'products:write'];
  await db().$transaction(async tx => {
    for (const uid of [userId, otherUserId]) await tx.userAccount.create({ data: { id: uid, displayName: 'Synthetic manual fee actor', status: 'active' } });
    await tx.role.create({ data: { id: roleId, name: 'Synthetic least-privilege fee role', isSystem: false } });
    await tx.userRole.create({ data: { id: `${id}-role-member`, userId, roleId } });
    await tx.userPermissionOverrides.createMany({ data: scopes.map(scope => ({ id: `${id}-${scope}`, userId, scope,
      isActive: true, grantedBy: userId, reason: 'Private technical capability; not a company finance approval policy' })) });
    for (const [relationId, category] of [[customerId, 'Customer'], [supplierId, 'Supplier']]) {
      await tx.relation.create({ data: { id: relationId, name: relationId, category, type: 'Company', isOrganization: true,
        ownerId: options.shared && category === 'Customer' ? otherUserId : userId,
        salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
    }
    if (options.shared) {
      await tx.team.create({ data: { id: teamId, name: 'Synthetic explicit L2 share', status: 'active' } });
      await tx.teamMember.create({ data: { id: `${id}-member`, teamId, userId } });
      await tx.teamDataGrant.create({ data: { id: shareId, teamId, entityType: 'relation', entityId: customerId,
        permission: 'read+followup', grantedBy: otherUserId } });
    }
  });
  const actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), userId));
  expect(actor.authorizationLoaded).toBe(true); expect(actor.roles).toEqual([]);
  expect([...actor.permissions!].sort()).toEqual([...scopes].sort());
  const token = auth.signToken(actor);
  const madeCase = await createDevelopmentCase({ prisma: db(), actorId: userId, input: {
    code: `${id}-case`, name: 'Native synthetic unapproved source', type: 'garment', stage: 'developing',
    owner: userId, customerRelationId: customerId, customerName: customerId, notes: 'Synthetic source; no production approval granted',
  } });
  expect(madeCase.ok, JSON.stringify(madeCase.error)).toBe(true);
  if (!madeCase.ok || !madeCase.data?.case) throw Error('Native case producer refused');
  const caseId = madeCase.data.case.id;
  const madeSample = await createSample({ prisma: db(), actorId: userId, input: { type: options.sampleType ?? 'ship',
    sourceCaseId: caseId, customerRelationId: customerId, notes: 'Native registered sample, no approval or stock facts' } });
  expect(madeSample.ok, JSON.stringify(madeSample)).toBe(true);
  if (!madeSample.ok) throw Error('Native sample producer refused');
  const sampleId = madeSample.data.sample.id;
  const f = { id, userId, otherUserId, customerId, supplierId, caseId, sampleId, actor, token, teamId, shareId, costIds: [] as string[], billingId: '' };
  const application = app();
  for (const amount of options.costs ?? ['120.0000']) {
    const cost = await request(application).post('/api/v1/cost-records').set('Authorization', `Bearer ${token}`).send({
      sourceType: 'Sample', sourceId: sampleId, costType: 'shipping', amount, currency: 'USD', incurredAt: '2026-10-02',
      bearerType: 'customer', bearerRelationId: customerId, notes: 'Explicit synthetic incurred fee, not a payment or approval',
    });
    expect(cost.status, JSON.stringify(cost.body)).toBe(201); expect(cost.body.ok).toBe(true);
    f.costIds.push(cost.body.costRecord.id);
  }
  if (options.billing !== false) {
    const bill = await request(application).post(billingPath).set('Authorization', `Bearer ${token}`).send({
      requestKey: `${id}-ordinary-billing-create`,
      sourceType: options.costSource ? 'CostRecord' : 'Sample', sourceId: options.costSource ? f.costIds[0] : sampleId,
      costRecordId: options.costSource ? undefined : f.costIds[0], chargeType: 'shipping_fee',
      ...(options.omitAmount ? {} : { amount: options.amount ?? '120.0000' }),
      waivedAmount: options.waived ?? '0', offsetAmount: options.offset ?? '0', currency: 'USD',
      bearerType: 'customer', bearerRelationId: customerId,
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201); expect(bill.body.ok).toBe(true);
    f.billingId = bill.body.billingItem.id;
  }
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function confirm(f: Fixture) {
  const result = await request(app()).post(`${billingPath}/${f.billingId}/confirm`).set('Authorization', `Bearer ${f.token}`).send({});
  expect(result.status, JSON.stringify(result.body)).toBe(200); expect(result.body.billingItem.status).toBe('confirmed');
}
function invoice(f: Fixture, database = db(), notifications: Notification[] = [], token = f.token) {
  return request(app(database, notifications)).post(`${billingPath}/${f.billingId}/invoice`)
    .set('Authorization', `Bearer ${token}`).send({});
}
function scene(f: Fixture, database = db(), notifications: Notification[] = [], input: Record<string, unknown> = {}) {
  return request(app(database, notifications)).post(`${scenePath}/create`).set('Authorization', `Bearer ${f.token}`).send({
    scene: 'sample', sourceId: f.sampleId, lineIds: f.costIds, status: 'Draft', invoiceNumber: `${f.id}-INV`, ...input,
  });
}

async function snapshot(f: Fixture, client: any = db()) {
  const invoices = await client.invoice.findMany({ where: { ownerId: f.userId }, orderBy: { id: 'asc' } });
  return normalized({ invoices,
    lines: await client.invoiceLine.findMany({ where: { OR: [{ sourceType: 'CostRecord', sourceId: { in: f.costIds } },
      { sourceType: 'BillingItem', sourceId: f.billingId }, { invoiceId: { in: invoices.map((row: any) => row.id) } }] }, orderBy: { id: 'asc' } }),
    bills: await client.billingItem.findMany({ where: { id: f.billingId }, orderBy: { id: 'asc' } }),
    costs: await client.costRecord.findMany({ where: { id: { in: f.costIds } }, orderBy: { id: 'asc' } }),
    sample: await client.sample.findUnique({ where: { id: f.sampleId } }),
    audits: await client.auditLog.findMany({ where: { actorId: f.userId }, orderBy: { id: 'asc' } }),
    jobs: await client.agentJob.findMany({ where: { payload: { path: ['actorId'], equals: f.userId } }, orderBy: { id: 'asc' } }),
  });
}
function transactionObserver(observe: (tx: any) => Promise<any>): PrismaClient {
  return new Proxy(db(), { get(target, key) {
    if (key === '$transaction') return (run: (tx: any) => Promise<any>, options?: any) =>
      target.$transaction(async tx => run(await observe(tx)), { ...options, maxWait: 10000, timeout: 15000 });
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

async function sqlAuditFailure(f: Fixture, action: string, run: (client: PrismaClient, staged: any[]) => Promise<void>) {
  const fn = `acceptance_manual_audit_${randomUUID().replaceAll('-', '')}`;
  expect(fn).toMatch(/^acceptance_manual_audit_[a-f0-9]+$/);
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const staged: any[] = [];
  const observer = transactionObserver(async tx => new Proxy(tx, { get(target, key) {
    if (key === 'auditLog') return new Proxy(target.auditLog, { get(delegate, method) {
      if (method === 'create') return async (args: any) => {
        if (args.data.action === action && args.data.actorId === f.userId) staged.push(await snapshot(f, tx));
        return delegate.create(args); // the native INSERT reaches the real PG trigger
      };
      const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
    } });
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } }));
  await db().$executeRawUnsafe(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action=${quote(action)} AND NEW."actorId"=${quote(f.userId)} THEN
      RAISE EXCEPTION 'synthetic_manual_audit_sql_failure'; END IF; RETURN NEW; END $$`);
  try {
    await db().$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
    try { await run(observer, staged); }
    finally { await db().$executeRawUnsafe(`DROP TRIGGER ${fn} ON "AuditLog"`); }
  } finally { await db().$executeRawUnsafe(`DROP FUNCTION public.${fn}()`); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean, description: string): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await read(); if (matches(value)) return value; await pause(20); }
  throw Error(`Actual private PG evidence timed out: ${description}`);
}
async function heldCase(f: Fixture, work: (holderPid: number) => Promise<void>) {
  const ready = deferred<number>(), release = deferred<void>();
  const held = db().$transaction(async tx => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    await tx.$queryRaw`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${f.caseId} FOR UPDATE`;
    ready.resolve(pid); await release.promise;
  }, { maxWait: 10000, timeout: 15000 });
  // Observe any rejected transaction even if the work fails before release.
  held.catch(() => undefined);
  const holderPid = await ready.promise;
  try { await work(holderPid); } finally { release.resolve(); await held; }
}
function pidObserver(pids: number[]) {
  return transactionObserver(async tx => {
    const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
    pids.push(pid); return tx;
  });
}
async function blockingEvidence(holderPid: number, pids: number[], count: number) {
  await until(async () => [...pids], value => value.length === count, 'native invoice transaction backend PIDs');
  return until(async () => {
    const rows: Array<{ pid: number; blockers: number[] }> = [];
    for (const pid of pids) rows.push(...await db().$queryRaw<Array<{ pid: number; blockers: number[] }>>
      `SELECT ${pid}::integer AS pid, pg_blocking_pids(${pid}::integer) AS blockers`);
    return rows;
  }, rows => {
    const byPid = new Map(rows.map(row => [row.pid, row.blockers]));
    const reachesHolder = (pid: number, seen = new Set<number>()): boolean => {
      if (pid === holderPid) return true;
      if (seen.has(pid)) return false; seen.add(pid);
      return (byPid.get(pid) ?? []).some(blocker => reachesHolder(blocker, new Set(seen)));
    };
    // PostgreSQL can report a soft blocker (the earlier row-lock waiter).
    // Require a real recorded blocking chain to the holder for each command.
    return rows.length === count && rows.every(row => reachesHolder(row.pid));
  }, 'pg_blocking_pids actual Case lock waits');
}

describe.sequential('native manual Invoice transaction / current authority / exact amounts', () => {
  it.each([
    ['MI01', 'create_invoice'], ['MI02', 'invoice_billing_item_link_backfill'],
  ])('%s Billing SQL audit failure rolls back canonical Invoice/Lines and source projections', async (_id, action) => {
    const f = await fixture(action); await confirm(f); const before = await snapshot(f), notifications: Notification[] = [];
    await sqlAuditFailure(f, action, async (client, staged) => {
      const result = await invoice(f, client, notifications);
      expect(result.status).toBe(500); safeFailure(result);
      expect(staged).toHaveLength(1); expect(staged[0].invoices).toHaveLength(1); expect(staged[0].lines).toHaveLength(1);
      if (action === 'invoice_billing_item_link_backfill') {
        expect(staged[0].bills[0].status).toBe('invoiced'); expect(staged[0].sample.invoiceId).toBe(staged[0].invoices[0].id);
      }
      expect(await snapshot(f)).toEqual(before); expect(notifications).toEqual([]);
    });
    const retry = await invoice(f); expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect((await snapshot(f)).invoices).toHaveLength(1);
  });

  it('MI03 Scene Draft mandatory audit SQL failure preserves pre-existing costs and leaves no invoice or lines', async () => {
    const f = await fixture('scene-rollback', { billing: false, costs: ['70.1234', '49.8766'] });
    const before = await snapshot(f), notifications: Notification[] = [];
    await sqlAuditFailure(f, 'create_scene_invoice', async (client, staged) => {
      const result = await scene(f, client, notifications);
      expect(result.status).toBe(500); safeFailure(result); expect(staged).toHaveLength(1);
      expect(staged[0].invoices).toHaveLength(1); expect(staged[0].lines).toHaveLength(2);
      expect(await snapshot(f)).toEqual(before); expect(notifications).toEqual([]);
    });
  });

  it('MI04 full waiver SQL audit failure rolls back completion; retry creates no receivable under the existing zero-charge rule', async () => {
    const f = await fixture('waiver', { waived: '120' }); await confirm(f); const before = await snapshot(f);
    const notifications: Notification[] = [];
    await sqlAuditFailure(f, 'invoice_billing_item_no_receivable', async (client, staged) => {
      const result = await invoice(f, client, notifications); expect(result.status).toBe(500); safeFailure(result);
      expect(staged).toHaveLength(1); expect(staged[0].bills[0].status).toBe('invoiced');
      expect(staged[0].invoices).toEqual([]); expect(await snapshot(f)).toEqual(before); expect(notifications).toEqual([]);
    });
    const retry = await invoice(f); expect(retry.status).toBe(201); expect(retry.body.noReceivable).toBe(true);
    const after = await snapshot(f); expect(after.invoices).toEqual([]); expect(after.lines).toEqual([]);
    expect(after.bills[0].status).toBe('invoiced'); expect(after.bills[0].invoiceId).toBeNull();
    expect(after.costs).toEqual(before.costs); expect(after.audits.filter((row: any) => row.action === 'invoice_billing_item_no_receivable')).toHaveLength(1);
  });

  it('MI05 Issued Scene rolls back before publishing real InvoiceIssued; native retry has exactly one durable event', async () => {
    const f = await fixture('issued-outbox', { billing: false }); const before = await snapshot(f);
    const observed: BusinessEvent[] = [], notifications: Notification[] = [];
    const unsubscribe = businessEventBus.subscribe('InvoiceIssued', event => { if (event.actorId === f.userId) observed.push(event); });
    try {
      await sqlAuditFailure(f, 'create_scene_invoice', async (client, staged) => {
        const result = await scene(f, client, notifications, { status: 'Issued' }); expect(result.status).toBe(500); safeFailure(result);
        expect(staged).toHaveLength(1); expect(staged[0].invoices[0].status).toBe('Issued');
        expect(staged[0].jobs).toEqual([]); expect(await snapshot(f)).toEqual(before);
        expect(observed).toEqual([]); expect(notifications).toEqual([]);
      });
      const retry = await scene(f, db(), notifications, { status: 'Issued' }); expect(retry.status, JSON.stringify(retry.body)).toBe(201);
      const jobs = await until(async () => (await snapshot(f)).jobs, rows => rows.length === 1 && rows[0].status === 'completed', 'real InvoiceIssued durable job');
      expect(observed).toHaveLength(1); expect(jobs[0].jobType).toBe('bev:InvoiceIssued');
      expect(jobs[0].payload.sourceEntityId).toBe(retry.body.invoice.id); expect(jobs[0].payload.actorId).toBe(f.userId);
      const audit = await db().auditLog.findUnique({ where: { id: jobs[0].payload.transactionId } });
      expect(audit?.action).toBe('create_invoice'); expect(audit?.targetId).toBe(retry.body.invoice.id);
    } finally { unsubscribe(); }
  });

  it.each(['withdrawn-write', 'disabled-user', 'signed-empty'] as const)('MI06 current %s refuses stale JWT/body actor without changing financial history', async mode => {
    const f = await fixture(mode); await confirm(f); const before = await snapshot(f);
    let token = f.token;
    if (mode === 'withdrawn-write') await db().userPermissionOverrides.update({ where: { id: `${f.id}-invoices:write` }, data: { isActive: false } });
    if (mode === 'disabled-user') await db().userAccount.update({ where: { id: f.userId }, data: { status: 'disabled' } });
    if (mode === 'signed-empty') token = auth.signToken({ ...f.actor, permissionCeiling: [] });
    const notifications: Notification[] = [];
    const result = await request(app(db(), notifications)).post(`${billingPath}/${f.billingId}/invoice`).set('Authorization', `Bearer ${token}`)
      .send({ actorId: f.otherUserId, actor: { roles: ['owner'], permissions: ['invoices:write'] }, permissionCeiling: ['invoices:write'] });
    expect(result.status).toBe(mode === 'disabled-user' ? 401 : 403); safeFailure(result);
    expect(errorCode(result)).toBe(mode === 'disabled-user' ? 'ACCOUNT_DISABLED' : 'FORBIDDEN');
    expect(await snapshot(f)).toEqual(before); expect(notifications).toEqual([]);
  });

  it('MI07 fresh L2 after a proved PG lock wait rejects a revoked shared customer while preserving source facts', async () => {
    const f = await fixture('revoked-share-lock', { shared: true }); await confirm(f); const before = await snapshot(f);
    const notifications: Notification[] = [], pids: number[] = [];
    let pending!: Promise<any>;
    await heldCase(f, async holderPid => {
      pending = invoice(f, pidObserver(pids), notifications).then(value => value);
      const blockers = await blockingEvidence(holderPid, pids, 1);
      expect(blockers[0].blockers).toContain(holderPid);
      console.info('[native manual invoice lock evidence]', normalized({ control: 'MI07', parent: f.caseId, holderPid, blockers }));
      await db().teamDataGrant.update({ where: { id: f.shareId }, data: { revokedAt: new Date(), revokedBy: f.otherUserId } });
    });
    const result = await pending; expect(result.status).toBe(404); expect(errorCode(result)).toBe('NOT_FOUND'); safeFailure(result);
    expect(await snapshot(f)).toEqual(before); expect(notifications).toEqual([]);
  });

  it('MI08 native sample reparent attempt is refused; original costs/source and approval-free history stay intact', async () => {
    const f = await fixture('reparent-refusal'); await confirm(f);
    const otherCase = await createDevelopmentCase({ prisma: db(), actorId: f.userId, input: { code: `${f.id}-other`, name: 'Native alternate source', type: 'garment',
      stage: 'developing', owner: f.userId, customerRelationId: f.customerId } });
    expect(otherCase.ok).toBe(true); const before = await snapshot(f);
    const result = await updateSample({ prisma: db(), sampleId: f.sampleId, actorId: f.userId, input: { sourceCaseId: otherCase.data!.case.id } });
    expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('SAMPLE_SOURCE_CHANGED');
    expect(await snapshot(f)).toEqual(before);
    const saved = await invoice(f); expect(saved.status).toBe(201);
    const after = await snapshot(f); expect(after.sample.sourceCaseId).toBe(f.caseId); expect(after.costs).toEqual(before.costs);
  });

  it('MI09 two same-source HTTP transactions have actual PG lock waits and one Invoice/Line/backfill fact', async () => {
    const f = await fixture('same-source-concurrent'); await confirm(f);
    const pids: number[] = [], client = pidObserver(pids), notifications: Notification[] = [];
    let pending!: Promise<any[]>;
    await heldCase(f, async holderPid => {
      pending = Promise.all([invoice(f, client, notifications).then(value => value), invoice(f, client, notifications).then(value => value)]);
      const blockers = await blockingEvidence(holderPid, pids, 2);
      expect(new Set(blockers.map(row => row.pid)).size).toBe(2);
      expect(blockers.some(row => row.blockers.includes(holderPid))).toBe(true);
      expect(blockers.every(row => row.blockers.length > 0)).toBe(true);
      console.info('[native manual invoice lock evidence]', normalized({ control: 'MI09', parent: f.caseId, holderPid, blockers }));
    });
    const results = await pending;
    expect(results.map(row => row.status).sort()).toEqual([200, 201]);
    expect(new Set(results.map(row => row.body.invoice.id)).size).toBe(1);
    expect(results.filter(row => row.body.recovered === true)).toHaveLength(1);
    const after = await snapshot(f); expect(after.invoices).toHaveLength(1); expect(after.lines).toHaveLength(1);
    expect(after.bills[0].invoiceId).toBe(after.invoices[0].id); expect(after.sample.invoiceId).toBe(after.invoices[0].id);
    for (const action of ['create_invoice', 'invoice_sample_link_backfill', 'invoice_billing_item_link_backfill'])
      expect(after.audits.filter((row: any) => row.action === action)).toHaveLength(1);
  });

  it('MI10 lost-response style source replay returns the original Invoice and never repeats fee projections/audits', async () => {
    const f = await fixture('replay-history'); await confirm(f); const saved = await invoice(f);
    expect(saved.status).toBe(201); const before = await snapshot(f);
    for (let i = 0; i < 2; i++) {
      const replay = await invoice(f); expect(replay.status).toBe(200); expect(replay.body.recovered).toBe(true);
      expect(replay.body.invoice.id).toBe(saved.body.invoice.id); expect(await snapshot(f)).toEqual(before);
    }
  });

  it('MI11 explicit 18,4 native Billing create/notes PATCH preserve exact money and immutable prior audits before Invoice', async () => {
    const exact = '90071992547409.1234', f = await fixture('high-billing', { amount: exact, costs: [exact], waived: '0.0001', offset: '0.0002' });
    const initial = await snapshot(f), bill = await db().billingItem.findUniqueOrThrow({ where: { id: f.billingId } });
    expect(bill.amount.toFixed(4)).toBe(exact); expect(bill.waivedAmount.toFixed(4)).toBe('0.0001'); expect(bill.offsetAmount.toFixed(4)).toBe('0.0002');
    const oldNumber = Prisma.Decimal.prototype.toNumber.call(new Prisma.Decimal(exact));
    expect(new Prisma.Decimal(String(oldNumber)).toFixed(4)).not.toBe(exact); // paired old Number precision mutant witness
    const createdAudit = initial.audits.find((row: any) => row.action === 'create_billing_item');
    expect(initial.audits.find((row: any) => row.action === 'create_cost_record').detail.after.amount).toBe(exact);
    expect(createdAudit.detail.after.amount).toBe(exact); expect(createdAudit.detail.after.waivedAmount).toBe('0.0001');
    const edited = await request(app()).patch(`${billingPath}/${f.billingId}`).set('Authorization', `Bearer ${f.token}`).send({ notes: 'Only native notes were edited' });
    expect(edited.status).toBe(200);
    const afterNotes = await snapshot(f);
    for (const field of ['amount', 'waivedAmount', 'offsetAmount']) expect(afterNotes.bills[0][field]).toBe(initial.bills[0][field]);
    for (const old of initial.audits) expect(afterNotes.audits.find((row: any) => row.id === old.id)).toEqual(old);
    const patchAudit = afterNotes.audits.find((row: any) => row.action === 'update_billing_item');
    expect(patchAudit.detail.before.amount).toBe(exact); expect(patchAudit.detail.after.amount).toBe(exact);
    const invalid = await request(app()).patch(`${billingPath}/${f.billingId}`).set('Authorization', `Bearer ${f.token}`).send({ amount: '-1' });
    expect(invalid.status).toBe(400); expect(errorCode(invalid)).toBe('INVALID_AMOUNT'); expect(await snapshot(f)).toEqual(afterNotes);
    await confirm(f); const saved = await invoice(f); expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const after = await snapshot(f); expect(after.invoices[0].amount).toBe('90071992547409.1231'); expect(after.lines[0].amount).toBe('90071992547409.1231');
  });

  it('MI12 real CostRecord default amount remains exact without explicit Billing amount', async () => {
    const exact = '90071992547409.1234', f = await fixture('default-cost-exact', { costs: [exact], costSource: true, omitAmount: true });
    const bill = await db().billingItem.findUniqueOrThrow({ where: { id: f.billingId } }); expect(bill.amount.toFixed(4)).toBe(exact);
    await confirm(f); const saved = await invoice(f); expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const after = await snapshot(f); expect(after.invoices[0].amount).toBe(exact); expect(after.lines[0].amount).toBe(exact);
  });

  it('MI13 two real 18,4 costs sum exactly into Scene header and keep each original line amount', async () => {
    const amounts = ['90071992547409.1234', '0.8765'], f = await fixture('scene-exact-sum', { billing: false, costs: amounts });
    const result = await scene(f); expect(result.status, JSON.stringify(result.body)).toBe(201);
    const after = await snapshot(f); expect(after.invoices[0].amount).toBe('90071992547409.9999');
    for (let i = 0; i < f.costIds.length; i++) expect(after.lines.find((row: any) => row.sourceId === f.costIds[i]).amount).toBe(amounts[i]);
    const oldNumberSum = amounts.reduce((sum, amount) => sum + Prisma.Decimal.prototype.toNumber.call(new Prisma.Decimal(amount)), 0);
    expect(new Prisma.Decimal(String(oldNumberSum)).toFixed(4)).not.toBe('90071992547409.9999');
    expect(after.audits.find((row: any) => row.action === 'create_scene_invoice').detail.after.amount).toBe('90071992547409.9999');
    const replay = await scene(f); expect(replay.status).toBe(409); expect(errorCode(replay)).toBe('LINES_OCCUPIED');
    expect(await snapshot(f)).toEqual(after);
  });

  it('MI14 default business date at UTC midnight uses real local-date policy and explicit date remains unchanged', async () => {
    const first = await fixture('local-date-default', { billing: false }), second = await fixture('local-date-explicit', { billing: false });
    const instant = new Date('2026-10-02T16:30:00.000Z'); expect(instant.getTimezoneOffset()).toBe(-480);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(instant);
    try {
      const firstResult = await scene(first); expect(firstResult.status, JSON.stringify(firstResult.body)).toBe(201);
      const secondResult = await scene(second, db(), [], { issueDate: '2026-09-25' }); expect(secondResult.status).toBe(201);
      expect((await snapshot(first)).invoices[0].issueDate).toBe('2026-10-03');
      expect((await snapshot(second)).invoices[0].issueDate).toBe('2026-09-25');
      expect(instant.toISOString().slice(0, 10)).toBe('2026-10-02'); // paired old UTC date projection
    } finally { vi.useRealTimers(); }
  });

  it('MI15 public JSON cannot impersonate a pricing CommissionPayable composer; ordinary manual AP still succeeds', async () => {
    const f = await fixture('public-source-guard', { billing: false }), before = await snapshot(f), notifications: Notification[] = [];
    const base = { type: 'Payable', status: 'Draft', amount: '13.1234', currency: 'USD', issueDate: '2026-10-02', customerRelationId: f.supplierId };
    const forged = await request(app(db(), notifications)).post('/api/v1/finance').set('Authorization', `Bearer ${f.token}`).send({
      ...base, invoiceNumber: `${f.id}-COMMISSION`, sourceType: 'CommissionPayable', sourceId: `${f.id}-invented-commission`,
      actorId: f.otherUserId, transaction: { tx: { invoice: { create: {} } }, deferAfterCommit: 'function' },
    });
    expect(forged.status).toBe(409); expect(errorCode(forged)).toBe('CONFLICT'); safeFailure(forged);
    expect(await snapshot(f)).toEqual(before); expect(notifications).toEqual([]);
    const manual = await request(app(db(), notifications)).post('/api/v1/finance').set('Authorization', `Bearer ${f.token}`).send({
      ...base, invoiceNumber: `${f.id}-MANUAL-AP`, notes: 'Native ordinary manual payable, not a pricing-derived commission',
    });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201); expect(manual.body.type).toBe('Payable');
    const actual = await db().invoice.findUniqueOrThrow({ where: { id: manual.body.id } });
    expect(actual.sourceType).toBeNull(); expect(actual.amount.toFixed(4)).toBe('13.1234'); expect(actual.ownerId).toBe(f.userId);
  });

  it('MI16 HTTP whole-case rule is retained for dev/fabric and development samples without manufacturing approval', async () => {
    const f = await fixture('whole-case-policy', { billing: false, sampleType: 'dev' }), before = await snapshot(f);
    for (const [sceneName, sourceId] of [['dev_cost', f.caseId], ['fabric', f.caseId], ['sample', f.sampleId]]) {
      const result = await request(app()).post(`${scenePath}/create`).set('Authorization', `Bearer ${f.token}`).send({
        scene: sceneName, sourceId, lineIds: f.costIds, status: 'Draft', invoiceNumber: `${f.id}-${sceneName}`,
      });
      expect(result.status).toBe(409); expect(errorCode(result)).toBe('WHOLE_CASE_BILLING_REQUIRED');
      expect(await snapshot(f)).toEqual(before);
    }
  });
});


// Billing create v2 native appendix: all business facts are native producers.
// Observers only pause after the real storage call and return its exact result.
import { createOrdersRouter } from '../src/orders/route';
import { billingCreateDigest } from '../src/finance/billingItemCreateCommand';

async function billingPeer<T>(work: (peer: PrismaClient) => Promise<T>): Promise<T> {
  db(); // original beforeAll has already verified the first physical database
  const url = process.env.DATABASE_URL;
  if (!url) throw Error('Reviewed private Billing PostgreSQL URL missing');
  const peer = new PrismaClient({ datasources: { db: { url } } });
  try {
    const identity = await peer.$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`;
    expect(identity).toEqual([{ name: process.env.BAMBOOK_ACCEPTANCE_DB_NAME,
      directory: process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port: Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) }]);
    expect(identity).toEqual(await db().$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`);
    return await work(peer);
  } finally { await peer.$disconnect(); }
}
function billingNativeObserver(client: PrismaClient, observe: (tx: any, pid: number) => Promise<any>): PrismaClient {
  return new Proxy(client, { get(target, key) {
    if (key === '$transaction') return (work: (tx: any) => Promise<any>, options?: any) =>
      target.$transaction(async tx => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        return work(await observe(tx, pid));
      }, { ...options, maxWait: 10000, timeout: 15000 });
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function billingCreateBody(f: Fixture, key = `${f.id}-ordinary-native`, extra: Record<string, unknown> = {}) {
  return { requestKey: key, sourceType: 'Sample', sourceId: f.sampleId, chargeType: 'shipping_fee', amount: '12.9999',
    currency: 'USD', bearerType: 'customer', bearerRelationId: f.customerId, ...extra };
}
function nativeBillingCreate(f: Fixture, body: Record<string, unknown>, client = db(), notifications: Notification[] = []) {
  return request(app(client, notifications)).post(billingPath).set('Authorization', `Bearer ${f.token}`).send(body).then(value => value);
}
function nativeBillingRetire(f: Fixture, body: Record<string, unknown>, client = db()) {
  const { requestKey, ...input } = body;
  return request(app(client)).post(`${billingPath}/create-requests/retire`).set('Authorization', `Bearer ${f.token}`)
    .send({ requestKey, input, retirementRequestKey: `${requestKey}-reconcile`, reason: 'Synthetic native original-request reconciliation' }).then(value => value);
}
async function billingNativeState(f: Fixture, client: any = db()) {
  return normalized({
    bills: await client.billingItem.findMany({ where: { OR: [{ sourceType: 'Sample', sourceId: f.sampleId },
      { sourceType: 'CostRecord', sourceId: { in: f.costIds } }] }, orderBy: { id: 'asc' } }),
    costs: await client.costRecord.findMany({ where: { sourceType: 'Sample', sourceId: f.sampleId }, orderBy: { id: 'asc' } }),
    audits: await client.auditLog.findMany({ where: { actorId: f.userId }, orderBy: { id: 'asc' } }),
    sample: await client.sample.findUnique({ where: { id: f.sampleId } }),
  });
}
async function nativeBillingAcknowledgement(f: Fixture, body: any, response: any) {
  expect(response.body.ok).toBe(true);
  const ack = response.body.acknowledgement;
  expect(ack).toMatchObject({ schemaVersion: 1, operation: 'create_billing_item', actorId: f.userId, requestKey: body.requestKey,
    billingItemId: response.body.billingItem.id });
  const { requestKey, ...input } = body;
  expect(ack.commandSnapshot).toEqual(input);
  expect(ack.commandHash).toBe(billingCreateDigest({ schemaVersion: 1, operation: 'create_billing_item', actorId: f.userId, requestKey, input }));
  const receipt = await db().auditLog.findUniqueOrThrow({ where: { id: ack.receiptAuditId } });
  const native = await db().auditLog.findUniqueOrThrow({ where: { id: ack.originalAuditId } });
  expect(native).toMatchObject({ actorId: f.userId, action: 'create_billing_item', targetType: 'BillingItem', targetId: ack.billingItemId,
    transactionId: ack.receiptAuditId });
  expect(ack.originalAuditHash).toBe(billingCreateDigest(native));
  expect(ack.billingItemHash).toBe(billingCreateDigest(response.body.billingItem));
  expect((receipt.detail as any).after.ack).toEqual({ billingItem: response.body.billingItem, replayed: false, acknowledgement: ack });
  expect((receipt.detail as any).after.ackHash).toBe(billingCreateDigest((receipt.detail as any).after.ack));
  expect(await db().auditLog.count({ where: { action: 'create_billing_item', targetId: ack.billingItemId } })).toBe(1);
  return { receipt, native };
}
function nativeBillingPause(f: Fixture, action: 'billing_item_create_receipt' | 'billing_item_create_retired' | 'read_original_ack', client = db(), billingId?: string) {
  const ready = deferred<{ pid: number; staged: any }>(), release = deferred<void>(); let observed = false;
  const database = billingNativeObserver(client, async (tx, pid) => new Proxy(tx, { get(target, key) {
    const model = action === 'read_original_ack' ? 'billingItem' : 'auditLog';
    if (key === model) return new Proxy(target[model], { get(delegate, method) {
      const storageMethod = action === 'read_original_ack' ? 'findUnique' : 'create';
      if (method === storageMethod) return async (args: any) => {
        const row = await delegate[storageMethod](args); // real PG storage completes BEFORE the pause
        if (!observed && (action === 'read_original_ack' ? args.where?.id === billingId : args.data.action === action && args.data.actorId === f.userId)) {
          observed = true; ready.resolve({ pid, staged: await billingNativeState(f, tx) }); await release.promise;
        }
        return row;
      };
      const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
    } });
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } }));
  return { database, ready, release };
}
async function nativeBillingPhase<T>(pending: Promise<any>, ready: Promise<T>, label: string): Promise<T> {
  return Promise.race([ready, pending.then(() => { throw Error(`Native Billing completed before controlled phase: ${label}`); }),
    pause(5000).then(() => { throw Error(`Native Billing phase timeout: ${label}`); })]);
}
async function billingBlockedBy(pid: number, holderPid: number) {
  return until(async () => db().$queryRaw<Array<{ pid: number; blockers: number[] }>>
    `SELECT ${pid}::integer AS pid, pg_blocking_pids(${pid}::integer) AS blockers`,
  rows => rows.length === 1 && rows[0].blockers.includes(holderPid), 'native Billing connection blocked by observed transaction');
}
async function billingPeerPid(peer: PrismaClient, work: (tx: any) => Promise<void>) {
  return peer.$transaction(async tx => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    await work(tx); return pid;
  });
}

// Native control titles are new. No original MI callback/assertion is altered.
describe.sequential('ordinary Billing create v2 / physical PostgreSQL HTTP appendix', () => {
  it('BC01 same-key two native connections create one fee/optional Cost/native audit/receipt and return the same original ACK', async () => {
    const f = await fixture('billing-create-same-key', { billing: false, costs: [] });
    const body = billingCreateBody(f, undefined, { registerCost: { costType: 'shipping', amount: '5.0001', currency: 'USD' } });
    await billingPeer(async peer => {
      const held = nativeBillingPause(f, 'billing_item_create_receipt');
      const first = nativeBillingCreate(f, body, held.database), pids: number[] = [];
      let second: Promise<any> | undefined; first.catch(() => undefined);
      try {
        const phase = await nativeBillingPhase(first, held.ready.promise, 'receipt INSERT');
        expect(phase.staged.bills).toHaveLength(1); expect(phase.staged.costs).toHaveLength(1);
        expect(phase.staged.audits.filter((row: any) => row.action === 'create_billing_item')).toHaveLength(1);
        expect(phase.staged.audits.filter((row: any) => row.action === 'billing_item_create_receipt')).toHaveLength(1);
        const client = billingNativeObserver(peer, async (tx, pid) => { pids.push(pid); return tx; });
        second = nativeBillingCreate(f, body, client); second.catch(() => undefined);
        await until(async () => pids, ids => ids.length === 1, 'second real create connection');
        expect(pids[0]).not.toBe(phase.pid);
        const blockers = await billingBlockedBy(pids[0], phase.pid);
        console.info('[native Billing create wait]', { control: 'BC01', holderPid: phase.pid, blockers });
      } finally { held.release.resolve(); await Promise.allSettled(second ? [first, second] : [first]); }
      if (!second) throw Error('Native second create transaction was not started');
      const [created, replay] = await Promise.all([first, second]);
      expect(created.status, JSON.stringify(created.body)).toBe(201); expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.replayed).toBe(true); expect(replay.body.billingItem).toEqual(created.body.billingItem);
      expect(replay.body.acknowledgement).toEqual(created.body.acknowledgement);
      await nativeBillingAcknowledgement(f, body, created);
      const state = await billingNativeState(f); expect(state.bills).toHaveLength(1); expect(state.costs).toHaveLength(1);
      for (const action of ['create_cost_record', 'create_billing_item', 'billing_item_create_receipt'])
        expect(state.audits.filter((row: any) => row.action === action)).toHaveLength(1);
    });
  });

  it('BC02 different keys on one real Sample are separate legitimate fees rather than a one-source-one-BI policy', async () => {
    const f = await fixture('billing-create-different-keys', { billing: false, costs: [] });
    await billingPeer(async peer => {
      const pids: number[] = [];
      const observer = (client: PrismaClient) => billingNativeObserver(client, async (tx, pid) => { pids.push(pid); return tx; });
      const a = billingCreateBody(f, `${f.id}-fee-a`), b = billingCreateBody(f, `${f.id}-fee-b`, { amount: '7.0001' });
      const results = await Promise.all([nativeBillingCreate(f, a, observer(db())), nativeBillingCreate(f, b, observer(peer))]);
      expect(results.map(result => result.status)).toEqual([201, 201]); expect(new Set(pids).size).toBe(2);
      expect(new Set(results.map(result => result.body.billingItem.id)).size).toBe(2);
      await nativeBillingAcknowledgement(f, a, results[0]); await nativeBillingAcknowledgement(f, b, results[1]);
      const state = await billingNativeState(f); expect(state.bills).toHaveLength(2); expect(state.costs).toHaveLength(0);
      expect(state.audits.filter((row: any) => row.action === 'create_billing_item')).toHaveLength(2);
      expect(state.audits.filter((row: any) => row.action === 'billing_item_create_receipt')).toHaveLength(2);
    });
  });

  it('BC03 real Decimal(18,4) and explicit zero preserve original exact ACK; five digits are rejected before PG rounding', async () => {
    const f = await fixture('billing-create-decimal', { billing: false, costs: [] }), exact = '90071992547409.1234';
    const body = billingCreateBody(f, `${f.id}-exact`, { amount: exact, waivedAmount: '0.0001', offsetAmount: '0.0002' });
    const created = await nativeBillingCreate(f, body); expect(created.status, JSON.stringify(created.body)).toBe(201);
    const row = await db().billingItem.findUniqueOrThrow({ where: { id: created.body.billingItem.id } });
    expect(row.amount.toFixed(4)).toBe(exact); expect(row.waivedAmount.toFixed(4)).toBe('0.0001'); expect(row.offsetAmount.toFixed(4)).toBe('0.0002');
    expect(created.body.billingItem.amount).toBe(exact); expect(created.body.billingItem.netAmountExact).toBe('90071992547409.1231');
    const facts = await nativeBillingAcknowledgement(f, body, created);
    expect((facts.native.detail as any).after.amount).toBe(exact);
    const zero = await nativeBillingCreate(f, billingCreateBody(f, `${f.id}-zero`, { amount: '0.0000' }));
    expect(zero.status, JSON.stringify(zero.body)).toBe(201);
    expect((await db().billingItem.findUniqueOrThrow({ where: { id: zero.body.billingItem.id } })).amount.toFixed(4)).toBe('0.0000');
    const before = await billingNativeState(f);
    const invalid = await nativeBillingCreate(f, billingCreateBody(f, `${f.id}-five`, { amount: '1.00001',
      registerCost: { costType: 'shipping', amount: '5.0001', currency: 'USD' } }));
    expect(invalid.status).toBe(400); expect(errorCode(invalid)).toBe('INVALID_AMOUNT'); safeFailure(invalid);
    expect(await billingNativeState(f)).toEqual(before);
    expect(new Prisma.Decimal(String(Prisma.Decimal.prototype.toNumber.call(new Prisma.Decimal(exact)))).toFixed(4)).not.toBe(exact);
  });

  it('BC04 actual confirm/cancel and notes edits leave old-key replay at its immutable first creation ACK', async () => {
    const f = await fixture('billing-create-mutable-later', { billing: false, costs: [] }), body = billingCreateBody(f);
    const created = await nativeBillingCreate(f, body); expect(created.status).toBe(201); f.billingId = created.body.billingItem.id;
    const native = await nativeBillingAcknowledgement(f, body, created);
    const edit = await request(app()).patch(`${billingPath}/${f.billingId}`).set('Authorization', `Bearer ${f.token}`).send({ notes: 'Native later BI edit' });
    expect(edit.status).toBe(200); await confirm(f);
    const cancelled = await request(app()).post(`${billingPath}/${f.billingId}/cancel`).set('Authorization', `Bearer ${f.token}`).send({ reason: 'Synthetic actual cancellation' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect((await db().billingItem.findUniqueOrThrow({ where: { id: f.billingId } })).status).toBe('cancelled');
    const before = await billingNativeState(f), replay = await nativeBillingCreate(f, body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true);
    expect(replay.body.billingItem).toEqual(created.body.billingItem); expect(replay.body.acknowledgement).toEqual(created.body.acknowledgement);
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: native.receipt.id } })).toEqual(native.receipt);
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: native.native.id } })).toEqual(native.native);
    expect(await billingNativeState(f)).toEqual(before);
  });

  it.each(['deleted-receipt', 'moved-receipt-pk-and-transaction'] as const)('BC05 %s with surviving original audit cannot recreate or declare safe retirement', async fault => {
    const f = await fixture(fault, { billing: false, costs: [] }), body = billingCreateBody(f);
    const created = await nativeBillingCreate(f, body); expect(created.status).toBe(201);
    const { receipt, native } = await nativeBillingAcknowledgement(f, body, created);
    // Deliberate corruption is limited to THIS synthetic command's own receipt.
    if (fault === 'deleted-receipt') await db().auditLog.delete({ where: { id: receipt.id } });
    else await db().auditLog.update({ where: { id: receipt.id }, data: { id: `${f.id}-moved-receipt`, transactionId: `${f.id}-moved-transaction` } });
    const before = await billingNativeState(f);
    for (const result of [await nativeBillingCreate(f, body), await nativeBillingRetire(f, body)]) {
      expect(result.status).toBe(409); expect(errorCode(result)).toBe('CONFLICT'); safeFailure(result);
    }
    expect(await db().auditLog.findUniqueOrThrow({ where: { id: native.id } })).toEqual(native);
    expect(await billingNativeState(f)).toEqual(before);
    expect(before.bills).toHaveLength(1); expect(before.audits.filter((row: any) => row.action === 'billing_item_create_retired')).toHaveLength(0);
  });

  it.each(['create-first', 'retire-first'] as const)('BC06 %s native create/retire race yields one permanent outcome under the same key', async order => {
    const f = await fixture(order, { billing: false, costs: [] }), body = billingCreateBody(f);
    await billingPeer(async peer => {
      const action = order === 'create-first' ? 'billing_item_create_receipt' : 'billing_item_create_retired';
      const held = nativeBillingPause(f, action), pids: number[] = [];
      const first = order === 'create-first' ? nativeBillingCreate(f, body, held.database) : nativeBillingRetire(f, body, held.database);
      const phase = await nativeBillingPhase(first, held.ready.promise, action);
      const client = billingNativeObserver(peer, async (tx, pid) => { pids.push(pid); return tx; });
      const second = order === 'create-first' ? nativeBillingRetire(f, body, client) : nativeBillingCreate(f, body, client); second.catch(() => undefined);
      try { await until(async () => pids, ids => ids.length === 1, 'native create/retire second PID'); expect(pids[0]).not.toBe(phase.pid); await billingBlockedBy(pids[0], phase.pid); }
      finally { held.release.resolve(); await Promise.allSettled([first, second]); }
      const [winner, follower] = await Promise.all([first, second]), state = await billingNativeState(f);
      if (order === 'create-first') {
        expect(winner.status).toBe(201); expect(follower.status).toBe(200);
        expect(follower.body.acknowledgement).toEqual(winner.body.acknowledgement); expect(follower.body.billingItem).toEqual(winner.body.billingItem);
        expect(state.bills).toHaveLength(1); expect(state.audits.filter((row: any) => row.action === 'billing_item_create_retired')).toHaveLength(0);
        await nativeBillingAcknowledgement(f, body, winner);
      } else {
        expect(winner.status).toBe(200); expect(winner.body.retired).toBe(true); expect(follower.status).toBe(409);
        expect(state.bills).toHaveLength(0); expect(state.audits.filter((row: any) => row.action === 'billing_item_create_retired')).toHaveLength(1);
        expect((await nativeBillingCreate(f, body)).status).toBe(409);
        const ack = winner.body.acknowledgement, { requestKey, ...input } = body;
        expect(ack).toMatchObject({ schemaVersion: 1, operation: 'retire_billing_item_create', actorId: f.userId, requestKey, commandSnapshot: input });
        expect(ack.commandHash).toBe(billingCreateDigest({ schemaVersion: 1, operation: 'create_billing_item', actorId: f.userId, requestKey, input }));
        expect(ack.retirementHash).toBe(billingCreateDigest({ schemaVersion: 1, operation: 'retire_billing_item_create', actorId: f.userId, requestKey, input,
          retirementRequestKey: ack.retirementRequestKey, reason: ack.reason }));
        const originalFence = state.audits.find((row: any) => row.id === ack.receiptAuditId);
        expect(originalFence).toMatchObject({ actorId: f.userId, action: 'billing_item_create_retired', targetType: 'BillingCreateRequest', targetId: ack.receiptAuditId });
        expect(originalFence.detail.after.ack).toEqual({ retired: true, replayed: false, acknowledgement: ack });
        expect(originalFence.detail.after.ackHash).toBe(billingCreateDigest(originalFence.detail.after.ack));
        const reconciled = await nativeBillingRetire(f, body); expect(reconciled.status).toBe(200); expect(reconciled.body.replayed).toBe(true);
        expect(reconciled.body.acknowledgement).toEqual(ack);
        expect(await billingNativeState(f)).toEqual(state);
      }
    });
  });

  it.each([
    ['create-grant', 'create', 'grant'], ['create-L2', 'create', 'share'],
    ['retire-grant', 'retire', 'grant'], ['retire-L2', 'retire', 'share'],
    ['replay-grant', 'replay', 'grant'], ['replay-L2', 'replay', 'share'],
  ] as const)('BC07 %s after real last INSERT/ACK read denies after an externally committed authority withdrawal', async (label, operation, fault) => {
    const f = await fixture(label, { billing: false, costs: [], shared: fault === 'share' });
    const body = billingCreateBody(f, undefined, { registerCost: { costType: 'shipping', amount: '5.0001', currency: 'USD' } });
    let billingId: string | undefined;
    if (operation === 'replay') { const original = await nativeBillingCreate(f, body); expect(original.status).toBe(201); billingId = original.body.billingItem.id; }
    const before = await billingNativeState(f), notifications: Notification[] = [];
    await billingPeer(async peer => {
      const held = nativeBillingPause(f, operation === 'replay' ? 'read_original_ack' : operation === 'retire' ? 'billing_item_create_retired' : 'billing_item_create_receipt', db(), billingId);
      const pending = operation === 'retire' ? nativeBillingRetire(f, body, held.database) : nativeBillingCreate(f, body, held.database, notifications);
      const phase = await nativeBillingPhase(pending, held.ready.promise, label);
      try {
        if (operation === 'create') { expect(phase.staged.bills).toHaveLength(1); expect(phase.staged.costs).toHaveLength(1);
          for (const action of ['create_cost_record', 'create_billing_item', 'billing_item_create_receipt']) expect(phase.staged.audits.filter((row: any) => row.action === action)).toHaveLength(1); }
        if (operation === 'retire') expect(phase.staged.audits.filter((row: any) => row.action === 'billing_item_create_retired')).toHaveLength(1);
        const revokedPid = await billingPeerPid(peer, async tx => {
          if (fault === 'grant') await tx.userPermissionOverrides.update({ where: { id: `${f.id}-invoices:write` }, data: { isActive: false } });
          else await tx.teamDataGrant.update({ where: { id: f.shareId }, data: { revokedAt: new Date(), revokedBy: f.otherUserId } });
        });
        expect(revokedPid).not.toBe(phase.pid);
        console.info('[native Billing late authority]', { label, stagedPid: phase.pid, committedRevocationPid: revokedPid });
      } finally { held.release.resolve(); await Promise.allSettled([pending]); }
      const result = await pending; expect(result.status, JSON.stringify(result.body)).toBe(fault === 'share' ? 404 : 403); safeFailure(result);
      expect(await billingNativeState(f)).toEqual(before); expect(notifications).toEqual([]);
    });
  });

  it.each(['create_billing_item', 'billing_item_create_receipt', 'billing_item_create_retired'] as const)('BC08 mandatory %s real SQL trigger failure rolls back all staged command facts', async action => {
    const f = await fixture(action, { billing: false, costs: [] }), before = await billingNativeState(f), notifications: Notification[] = [];
    const body = billingCreateBody(f, undefined, { registerCost: { costType: 'shipping', amount: '5.0001', currency: 'USD' } });
    await sqlAuditFailure(f, action, async (client, staged) => {
      const result = action === 'billing_item_create_retired' ? await nativeBillingRetire(f, body, client) : await nativeBillingCreate(f, body, client, notifications);
      expect(result.status).toBe(500); safeFailure(result); expect(staged).toHaveLength(1);
      if (action === 'billing_item_create_receipt') {
        expect(staged[0].audits.filter((row: any) => row.action === 'create_cost_record')).toHaveLength(1);
        expect(staged[0].audits.filter((row: any) => row.action === 'create_billing_item')).toHaveLength(1);
      }
      expect(await billingNativeState(f)).toEqual(before); expect(notifications).toEqual([]);
    });
  });

  it('BC09 Sample→Order canonical lock order interoperates with actual updateSample on a second physical connection without a new deadlock', async () => {
    const initial = await fixture('sample-order-lock', { billing: false, costs: [] });
    // Only least-privilege configuration is seeded. The Order and independent
    // ship Sample below are actual unapproved producers, not fabricated rows.
    await db().userPermissionOverrides.createMany({ data: ['orders:read', 'orders:write'].map(scope => ({ id: `${initial.id}-${scope}`,
      userId: initial.userId, scope, isActive: true, grantedBy: initial.userId, reason: 'Synthetic native Order producer capability' })) });
    const actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), initial.userId)), token = auth.signToken(actor);
    const application = express(); application.use(express.json());
    application.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
    application.use(createAccountStatusGuard(db())); application.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
    application.use('/api/v1/orders', createOrdersRouter({ prisma: db(), requireAuth: true, apiKeys: new Set() }));
    const order = await request(application).post('/api/v1/orders').set('Authorization', `Bearer ${token}`).send({ id: `${initial.id}-order`,
      poNumber: `${initial.id}-PO`, customer: initial.customerId, customerRelationId: initial.customerId, product: 'Synthetic pending source',
      type: 'Fabric', quantity: 1, status: 'Pending', dueDate: '2099-12-01', quoteAmount: '1' });
    expect(order.status, JSON.stringify(order.body)).toBe(200); expect(order.body.ok).toBe(true);
    const sample = await createSample({ prisma: db(), actorId: initial.userId, input: { type: 'ship', sourceOrderId: order.body.order.id,
      customerRelationId: initial.customerId, notes: 'Independent unapproved ship Sample with no Case lock to hide inversion' } });
    expect(sample.ok, JSON.stringify(sample)).toBe(true); if (!sample.ok) throw Error('Native independent sample failed');
    const f = { ...initial, sampleId: sample.data.sample.id, actor, token };
    expect((await db().sample.findUniqueOrThrow({ where: { id: f.sampleId } })).sourceCaseId).toBeNull();
    await billingPeer(async peer => {
      const ready = deferred<number>(), release = deferred<void>(), billingPids: number[] = []; let paused = false;
      const writer = billingNativeObserver(peer, async (tx, pid) => new Proxy(tx, { get(target, key) {
        if (key === '$queryRaw') return async (...args: any[]) => {
          const query = args[0], row = await target.$queryRaw(...args), sql = String(query.sql ?? query.text ?? '');
          if (!paused && /FROM\s+"Sample".*FOR UPDATE/s.test(sql)) { paused = true; ready.resolve(pid); await release.promise; }
          return row;
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } }));
      const updated = updateSample({ prisma: writer, sampleId: f.sampleId, actorId: f.userId, input: { notes: 'Actual concurrent native Sample edit' } });
      const holderPid = await nativeBillingPhase(updated, ready.promise, 'actual updateSample Sample FOR UPDATE');
      const billing = nativeBillingCreate(f, billingCreateBody(f), billingNativeObserver(db(), async (tx, pid) => { billingPids.push(pid); return tx; })); billing.catch(() => undefined);
      try {
        await until(async () => billingPids, ids => ids.length === 1, 'native Billing lock transaction PID'); expect(billingPids[0]).not.toBe(holderPid);
        const blockers = await billingBlockedBy(billingPids[0], holderPid);
        console.info('[native Sample/Order lock evidence]', { control: 'BC09', sampleId: f.sampleId, orderId: order.body.order.id, holderPid, blockers });
      } finally { release.resolve(); await Promise.allSettled([updated, billing]); }
      const [sampleResult, billingResult] = await Promise.all([updated, billing]);
      expect(sampleResult.ok, JSON.stringify(sampleResult)).toBe(true); expect(billingResult.status, JSON.stringify(billingResult.body)).toBe(201);
      const state = await billingNativeState(f); expect(state.bills).toHaveLength(1); expect(state.sample.notes).toBe('Actual concurrent native Sample edit');
      expect(state.audits.filter((row: any) => row.action === 'update_sample' && row.targetId === f.sampleId)).toHaveLength(1);
      await nativeBillingAcknowledgement(f, billingCreateBody(f), billingResult);
    });
  });
});
