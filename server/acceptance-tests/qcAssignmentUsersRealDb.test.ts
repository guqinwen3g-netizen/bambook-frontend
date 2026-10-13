/** Opt-in private PG only. QC roster/recipient grant controls.
 * Source Order/Line and identity configuration reuse the reviewed original native
 * QC fixture; assignment facts/audits come exclusively from actual QC HTTP.
 * No company role-policy or browser claim.
 * Original provenance: qcAssignmentAuthorizationRealDb.test.ts @286eb.
 *  Native assignment -> assigned inspector context ->
 * start/complete, actual report/width/status/audit and current identity/L2/cap.
 * This does not prove QC sample chains, report signing, HR directory, browser
 * rendering or quality release policy. No seed, index, scheduler or shared DB. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createQcRouter } from '../src/qc/qcRoute';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';

const prefix = `acceptance-qc-users-${randomUUID()}`, auth = createAuthService(), grantor = `${prefix}-grantor`;
let prisma: PrismaClient | undefined, seq = 0;
function db() { if (!prisma) throw Error('Independent QC client not initialized'); return prisma; }
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed isolated acceptance database is required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
  `;
  expect(identity, 'Actual PG identity before fixture writes').toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.create({ data: { id: grantor, displayName: 'Synthetic recipient-test grantor', status: 'active' } });
  await db().role.upsert({ where: { id: 'owner' }, update: {}, create: { id: 'owner', name: 'Synthetic canonical owner', isSystem: true } });
});
afterAll(async () => { await prisma?.$disconnect(); });
async function actor(userId: string) {
  const user = await loadUserWithRoles(db(), userId); expect(user?.status).toBe('active');
  return buildLoadedAuthTokenPayload(db(), user);
}
async function fixture(label: string) {
  const id = `${prefix}-${++seq}-${label}`, ownerId = `${id}-owner`, inspectorId = `${id}-inspector`,
    otherId = `${id}-other`, orderId = `${id}-order`, lineId = `${id}-line`, customerId = `${id}-customer`;
  await db().$transaction(async tx => {
    for (const [userId, owner] of [[ownerId, true], [inspectorId, false], [otherId, false]] as const) {
      await tx.userAccount.create({ data: { id: userId, displayName: owner ? 'Synthetic dispatcher' : 'Synthetic assigned inspector', status: 'active' } });
      const roleId = owner ? 'owner' : `${userId}-role`;
      if (!owner) await tx.role.create({ data: { id: roleId, name: 'admin', isSystem: false } });
      await tx.userRole.create({ data: { id: `${userId}-membership`, userId, roleId } });
      await tx.userPermissionOverrides.createMany({ data: ['qc:read', 'qc:write', 'orders:read'].map(scope => ({
        id: `${userId}-${scope}`, userId, scope, isActive: true, grantedBy: grantor, reason: 'Explicit isolated fixture capability' })) });
    }
    await tx.relation.create({ data: { id: customerId, name: `${id}-customer`, category: 'Customer', type: 'Company',
      isOrganization: true, contactInfo: '{}', tags: [], lastInteraction: BigInt(Date.now()), ownerId, salesRepIds: [] } });
    await tx.order.create({ data: { id: orderId, poNumber: `${id}-PO`, customer: `${id}-customer`, product: 'Synthetic fabric',
      type: 'fabric', quantity: 100, status: 'InProduction', dueDate: '2099-01-01', quoteAmount: 987654,
      customerRelationId: customerId, ownerId, updatedAt: BigInt(Date.now()) } });
    await tx.orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, itemNo: '10', materialCode: 'SYNTHETIC-FABRIC',
      description: 'Inspection input', quantity: 100, unit: 'M', width: '147 cm', unitPrice: 999.99, netValue: 99999 } });
  });
  return { id, ownerId, inspectorId, otherId, orderId, lineId, customerId,
    owner: await actor(ownerId), inspector: await actor(inspectorId), other: await actor(otherId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function application(client: PrismaClient) {
  const app = express(), changes: any[] = [];
  app.use(express.json()); app.use(createAccountStatusGuard(client));
  app.use(createAuthorizationSnapshotGuard({ prisma: client, apiKeys: new Set<string>(), apiKeyActors: new Map() }));
  app.use('/qc', createQcRouter({ prisma: client, requireAuth: true, apiKeys: new Set(), onDataChange: event => changes.push(event) }));
  app.use('/order-lines', createOrderLinesRouter({ prisma: client, requireAuth: true, apiKeys: new Set() }));
  return { app, changes };
}
type App = ReturnType<typeof application>;
function http(app: App, method: 'get' | 'post' | 'patch' | 'delete', endpoint: string, principal: TokenPayload) {
  return request(app.app)[method](endpoint).set('Authorization', `Bearer ${auth.signToken(principal)}`);
}
async function assignment(item: Fixture, app = application(db())) {
  const response = await http(app, 'post', '/qc/assignments', item.owner).send({ orderId: item.orderId,
    inspectionType: 'final', qcUserId: item.inspectorId, dueDate: '2099-01-01', actorId: item.otherId });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.item.assignedById).toBe(item.ownerId);
  return response.body.item.id as string;
}
async function facts(item: Fixture) {
  return { tasks: await db().qCAssignment.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { targetType: 'QCAssignment', actorId: item.ownerId }, orderBy: { id: 'asc' } }) };
}
async function scopedInput(item: Fixture, requestKey = `${item.id}-request`) {
  const res = await http(application(db()), 'get', `/qc/orders/${item.orderId}/inspection-scopes`, item.owner);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const scope = res.body.scopes.find((row: any) => row.scopeType === 'whole_order'); expect(scope).toBeTruthy();
  return { orderId: item.orderId, inspectionType: 'final', qcUserId: item.inspectorId, scopeType: 'whole_order',
    productionBatchId: null, expectedScopeFingerprint: scope.scopeFingerprint, requestKey };
}
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function boundedHandoff<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`${label} handoff was not reached`)), 6000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function waitBlockedBy(blocker: number) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const rows = await db().$queryRaw<Array<{ pid: number; blockers: number[] }>>`
      SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname = current_database() AND ${blocker}::integer = ANY(pg_blocking_pids(pid))`;
    if (rows.length) { expect(rows.some(row => row.blockers.includes(blocker))).toBe(true); return rows; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Actual PostgreSQL row-lock wait was not observed');
}
type Probe = { auditFault?: boolean; recipientGrantFault?: boolean; holdAfterInsert?: () => Promise<void>; heldPid?: number; reached?: boolean; actualCode?: string };
function intercepted(probe: Probe): PrismaClient {
  return new Proxy(db(), { get(client, key) {
    if (key === '$transaction') return (work: any, options?: any) => client.$transaction(async tx => work(new Proxy(tx, { get(transaction, delegate) {
      if (delegate === 'auditLog' && probe.auditFault) return new Proxy(transaction.auditLog, { get(model, method) {
        if (method === 'create') return async (args: any) => { probe.reached = true;
          try { return await model.create({ ...args, data: { ...args.data, actorId: `${prefix}-missing-audit-user` } }); }
          catch (error: any) { probe.actualCode = error.code; throw error; } };
        const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
      } });
      if (delegate === 'userPermissionOverrides' && probe.recipientGrantFault) return new Proxy(transaction.userPermissionOverrides, { get(model, method) {
        if (method === 'findMany') return async (args: any) => {
          if (args?.where?.userId?.endsWith('-inspector')) { probe.reached = true;
            try { return await transaction.$queryRaw`SELECT "QC_RECIPIENT_PRIVATE_missing" FROM "UserPermissionOverrides" LIMIT 1`; }
            catch (error: any) { probe.actualCode = error.code; throw error; } }
          return model.findMany(args);
        };
        const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
      } });
      if (delegate === 'qCAssignment' && probe.holdAfterInsert) return new Proxy(transaction.qCAssignment, { get(model, method) {
        if (method === 'create') return async (args: any) => { const row = await model.create(args); const [{ pid }] = await transaction.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; probe.heldPid = pid; await probe.holdAfterInsert!(); return row; };
        const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
      } });
      const value = Reflect.get(transaction, delegate); return typeof value === 'function' ? value.bind(transaction) : value;
    } })), { ...options, timeout: 15_000 });
    const value = Reflect.get(client, key); return typeof value === 'function' ? value.bind(client) : value;
  } });
}

describe('private PG actual QC recipient workflow', () => {
  it('QR01 no-HR dispatcher reads only minimal names with real effective grants and names on visible tasks', async () => {
    const item = await fixture('minimal'), app = application(db());
    await db().role.update({ where: { id: `${item.inspectorId}-role` }, data: { name: 'No QC role label' } });
    const names = await http(app, 'get', '/qc/assignment-users', item.inspector);
    expect(names.status, JSON.stringify(names.body)).toBe(200);
    expect(names.body.users.some((row: any) => row.id === item.inspectorId)).toBe(true);
    for (const row of names.body.users) expect(Object.keys(row).sort()).toEqual(['departmentName', 'displayName', 'id']);
    const id = await assignment(item, app), board = await http(app, 'get', '/qc/workbench', item.inspector);
    expect(board.status).toBe(200); expect(board.body.assigned.find((row: any) => row.id === id).qcUser).toEqual({ id: item.inspectorId, displayName: 'Synthetic assigned inspector' });
  });
  it('QR02 role label QC, missing read/write, disabled/deleted and expired personal grants cannot receive new assignments', async () => {
    for (const variant of ['label-only', 'read-only', 'write-only', 'disabled', 'deleted', 'expired'] as const) {
      const item = await fixture(variant), app = application(db());
      if (variant === 'disabled') await db().userAccount.update({ where: { id: item.inspectorId }, data: { status: 'disabled' } });
      else if (variant === 'deleted') await db().userAccount.update({ where: { id: item.inspectorId }, data: { deletedAt: BigInt(Date.now()) } });
      else {
        await db().role.update({ where: { id: `${item.inspectorId}-role` }, data: { name: 'QC' } });
        await db().userPermissionOverrides.updateMany({ where: { userId: item.inspectorId,
          ...(variant === 'read-only' ? { scope: 'qc:write' } : variant === 'write-only' ? { scope: 'qc:read' } : { scope: { in: ['qc:read', 'qc:write'] } }) },
          data: variant === 'expired' ? { expiresAt: new Date(0) } : { isActive: false } });
      }
      const res = await http(app, 'post', '/qc/assignments', item.owner).send({ orderId: item.orderId, inspectionType: 'final', qcUserId: item.inspectorId });
      expect(res.status, JSON.stringify(res.body)).toBe(variant === 'deleted' ? 404 : 400); expect(await facts(item)).toEqual({ tasks: [], audits: [] }); expect(app.changes).toEqual([]);
    }
  });
  it('QR03 modern exact ACK remains history after target disabled; new key is rejected and altered original key conflicts', async () => {
    const item = await fixture('replay'), app = application(db()), input = await scopedInput(item);
    const first = await http(app, 'post', '/qc/assignments', item.owner).send(input); expect(first.status, JSON.stringify(first.body)).toBe(201);
    await db().userAccount.update({ where: { id: item.inspectorId }, data: { status: 'disabled' } });
    const before = await facts(item), replay = await http(app, 'post', '/qc/assignments', item.owner).send(input);
    expect(replay.status).toBe(201); expect(replay.body.replayed).toBe(true); expect(replay.body.receipt).toEqual(first.body.receipt); expect(replay.body.item).toEqual(first.body.item);
    const fresh = await http(app, 'post', '/qc/assignments', item.owner).send({ ...input, inspectionType: 'midline', requestKey: `${item.id}-new` });
    expect(fresh.status).toBe(400); expect((await http(app, 'post', '/qc/assignments', item.owner).send({ ...input, notes: 'changed-key-intent' })).status).toBe(409);
    expect(await facts(item)).toEqual(before);
  });
  it('QR04 reassignment to a now-unqualified recipient cannot change original task or audit history', async () => {
    const item = await fixture('reassign'), app = application(db()), id = await assignment(item, app), before = await facts(item);
    await db().userPermissionOverrides.updateMany({ where: { userId: item.otherId, scope: 'qc:write' }, data: { isActive: false } });
    const res = await http(app, 'patch', `/qc/assignments/${id}`, item.owner).send({ qcUserId: item.otherId });
    expect(res.status).toBe(400); expect(await facts(item)).toEqual(before);
  });
  it('QR05 current caller signed ceiling, withdrawn grants, customer token and API-key cannot enumerate names', async () => {
    const item = await fixture('caller'), app = application(db());
    expect((await http(app, 'get', '/qc/assignment-users', { ...item.owner, permissionCeiling: [] })).status).toBe(403);
    expect((await request(app.app).get('/qc/assignment-users').set('X-API-Key', 'synthetic-key').query({ actorId: item.ownerId })).status).toBe(401);
    const customer = request(app.app).get('/qc/assignment-users').set('Authorization', `Bearer ${auth.signToken({ kind: 'customer', customerUserId: 'synthetic-customer' } as any)}`);
    expect((await customer).status).toBe(401);
    await db().userPermissionOverrides.updateMany({ where: { userId: item.inspectorId, scope: 'qc:write' }, data: { isActive: false } });
    expect((await http(app, 'get', '/qc/assignment-users', item.inspector)).status).toBe(403);
  });
  it('QR06 recipient authorization SQL failure is safe 503 and cannot persist any assignment/audit', async () => {
    const item = await fixture('grant-query'), probe: Probe = { recipientGrantFault: true }, app = application(intercepted(probe));
    const res = await http(app, 'post', '/qc/assignments', item.owner).send({ orderId: item.orderId, inspectionType: 'final', qcUserId: item.inspectorId });
    expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2010'); expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('QC_RECIPIENT_PRIVATE_missing'); expect(await facts(item)).toEqual({ tasks: [], audits: [] }); expect(app.changes).toEqual([]);
  });
  it('QR07 actual mandatory audit FK fault rolls back legacy and modern assignment and command ACK', async () => {
    for (const modern of [false, true]) {
      const item = await fixture(`audit-${modern}`), probe: Probe = { auditFault: true }, app = application(intercepted(probe));
      const input = modern ? await scopedInput(item) : { orderId: item.orderId, inspectionType: 'final', qcUserId: item.inspectorId };
      const res = await http(app, 'post', '/qc/assignments', item.owner).send(input);
      expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2003'); expect(res.status).toBe(500); expect(await facts(item)).toEqual({ tasks: [], audits: [] }); expect(app.changes).toEqual([]);
    }
  });
  it.each(['disabled', 'grant-withdrawal'] as const)('QR08 actual two-connection %s wins recipient lock; post-lock current reload rejects zero facts', async variant => {
    const item = await fixture(variant), app = application(db()), other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    const begun = deferred<number>(), release = deferred();
    const blocker = other.$transaction(async tx => {
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (variant === 'disabled') await tx.userAccount.update({ where: { id: item.inspectorId }, data: { status: 'disabled' } });
      else await tx.userPermissionOverrides.updateMany({ where: { userId: item.inspectorId, scope: 'qc:write' }, data: { isActive: false } });
      begun.resolve(pid); await release.promise;
    }, { timeout: 12_000 });
    let save: Promise<any> | undefined;
    try {
      const pid = await boundedHandoff(Promise.race([begun.promise, blocker.then(() => { throw Error('Recipient blocker ended before handoff'); })]), 'Recipient blocker'); save = http(app, 'post', '/qc/assignments', item.owner).send({ orderId: item.orderId, inspectionType: 'final', qcUserId: item.inspectorId }).then(res => res);
      const waits = await waitBlockedBy(pid); expect(waits.length).toBeGreaterThan(0);
      release.resolve(); await blocker; const res = await save; expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(await facts(item)).toEqual({ tasks: [], audits: [] }); expect(app.changes).toEqual([]);
    } finally { release.resolve(); await blocker.catch(() => undefined); await save?.catch(() => undefined); await other.$disconnect(); }
  });
  it('QR09 assignment holding recipient SHARE first commits before a blocked account disable and original ACK remains replayable', async () => {
    const item = await fixture('assignment-first'), entered = deferred(), release = deferred(), input = await scopedInput(item),
      probe: Probe = { holdAfterInsert: async () => { entered.resolve(); await release.promise; } }, app = application(intercepted(probe)),
      other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    const saved = http(app, 'post', '/qc/assignments', item.owner).send(input).then(res => res);
    let disabling: Promise<void> | undefined;
    try {
      await boundedHandoff(Promise.race([entered.promise, saved.then(res => { throw Error(`Assignment ended before hold: ${res.status}`); })]), 'Assignment SHARE');
      expect(probe.heldPid).toBeGreaterThan(0);
      disabling = other.userAccount.update({ where: { id: item.inspectorId }, data: { status: 'disabled' } }).then(() => undefined);
      const waits = await waitBlockedBy(probe.heldPid!); expect(waits.length).toBeGreaterThan(0);
      release.resolve(); const first = await saved; expect(first.status, JSON.stringify(first.body)).toBe(201); await disabling;
      expect((await db().userAccount.findUnique({ where: { id: item.inspectorId } }))!.status).toBe('disabled');
      const before = await facts(item), replay = await http(application(db()), 'post', '/qc/assignments', item.owner).send(input);
      expect(replay.status).toBe(201); expect(replay.body.receipt).toEqual(first.body.receipt); expect(await facts(item)).toEqual(before);
    } finally { release.resolve(); await saved.catch(() => undefined); await disabling?.catch(() => undefined); await other.$disconnect(); }
  });
});
