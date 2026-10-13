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
import { realpathSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
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

function captureNativeWire(kind: string, data: object) {
  const file = path.join(process.env.BAMBOOK_ACCEPTANCE_SANDBOX!, 'qc-native-wire.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  writeFileSync(file, JSON.stringify({ ...previous, [kind]: data }, null, 2) + '\n', { mode: 0o600 });
}
async function ledger(item: Fixture) {
  const tasks = await db().qCAssignment.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } });
  const reports = await db().inspectionReport.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } });
  const widths = await db().inspectionWidthMeasurement.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } });
  const audits = await db().auditLog.findMany({ where: { targetId: { in: [...tasks.map(row => row.id), ...reports.map(row => row.id)] } }, orderBy: { id: 'asc' } });
  return { tasks, reports, widths, audits };
}
async function stored(item: Fixture, action: string, targetId: string) {
  const rows = await db().auditLog.findMany({ where: { action, targetId, actorId: item.ownerId } });
  expect(rows).toHaveLength(1);
  const after = (rows[0].detail as any).after;
  expect((rows[0].detail as any).source).toBe('route:qc:physical-coverage');
  return { ok: true, item: after.item, ...(after.report ? { report: after.report } : {}), receipt: after.receipt, replayed: false };
}
const reportInput = { result: 'pass', inspectionDate: '2099-01-02', totalUnits: 100, passedUnits: 100,
  criticalDefects: 0, majorDefects: 0, minorDefects: 0, notes: 'Actual native QC report' };
async function created(item: Fixture) {
  const input = { ...await scopedInput(item), locationId: null, dueDate: null, notes: null }, app = application(db());
  const response = await http(app, 'post', '/qc/assignments', item.owner).send(input);
  expect(response.status, JSON.stringify(response.body)).toBe(201); return { app, input, response };
}
async function completed(item: Fixture) {
  const original = await created(item), input = { report: reportInput, expectedScopeFingerprint: original.response.body.item.scopeFingerprint, requestKey: `${item.id}-complete` };
  // Existing canonical owner/current grants + original source L2 legitimately allow delegated completion.
  const response = await http(original.app, 'post', `/qc/assignments/${original.response.body.item.id}/complete`, item.owner).send(input);
  expect(response.status, JSON.stringify(response.body)).toBe(200); return { ...original, completeInput: input, completion: response };
}
describe('private PG exact scoped QC command envelopes', () => {
  it('QA01 create first equals actual persisted ACK and same-key replay after target disable; no extra fact/audit', async () => {
    const item = await fixture('create-envelope'), original = await created(item), first = original.response.body;
    expect(first).toEqual(await stored(item, 'create_scoped_assignment', first.item.id));
    captureNativeWire('create', { actor: item.owner, input: original.input, first });
    expect(typeof first.item.assignedAt).toBe('string'); expect(first.item.assignedAt).toMatch(/^\d+$/);
    const before = await ledger(item); await db().userAccount.update({ where: { id: item.inspectorId }, data: { status: 'disabled' } });
    const replay = await http(original.app, 'post', '/qc/assignments', item.owner).send(original.input);
    expect(replay.status).toBe(201); expect(replay.body).toEqual({ ...first, replayed: true }); expect(await ledger(item)).toEqual(before);
  });
  it('QA02 complete first equals actual persisted ACK and exact replay after recipient disabled; altered intent conflicts', async () => {
    const item = await fixture('complete-envelope'), original = await completed(item), first = original.completion.body;
    expect(first).toEqual(await stored(item, 'complete_scoped_assignment', first.item.id));
    const actualBoard = await http(original.app, 'get', '/qc/workbench', item.owner), actualReports = await http(original.app, 'get', `/qc/reports?orderId=${item.orderId}`, item.owner);
    expect(actualBoard.status).toBe(200); expect(actualReports.status).toBe(200);
    captureNativeWire('complete', { actor: item.owner, assignmentId: first.item.id, input: original.completeInput, first, board: actualBoard.body, reports: actualReports.body });
    expect(first.item.status).toBe('Completed'); expect(first.report.inspectedBy).toBe(item.ownerId);
    expect(typeof first.item.completedAt).toBe('string'); expect(typeof first.report.createdAt).toBe('string');
    await db().userAccount.update({ where: { id: item.inspectorId }, data: { status: 'disabled' } }); const before = await ledger(item);
    const endpoint = `/qc/assignments/${first.item.id}/complete`, replay = await http(original.app, 'post', endpoint, item.owner).send(original.completeInput);
    expect(replay.status).toBe(200); expect(replay.body).toEqual({ ...first, replayed: true });
    const changed = await http(original.app, 'post', endpoint, item.owner).send({ ...original.completeInput, report: { ...reportInput, notes: 'changed intent' } });
    expect(changed.status).toBe(409); expect(await ledger(item)).toEqual(before); expect(before.reports).toHaveLength(1);
  });
  it('QA03 decision first equals stored ACK and exact replay after target disabled; no new decision/audit', async () => {
    const item = await fixture('decision-envelope'), original = await completed(item), report = original.completion.body.report,
      input = { expectedRevision: report.revision, expectedScopeFingerprint: report.scopeFingerprint,
        expectedContentFingerprint: report.contentFingerprint, decision: 'approved', reason: 'Actual business decision', requestKey: `${item.id}-decision` },
      endpoint = `/qc/reports/${report.id}/business-decision`;
    const first = await http(original.app, 'post', endpoint, item.owner).send(input); expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toEqual(await stored(item, 'decide_scoped_report', report.id));
    const actualReports = await http(original.app, 'get', `/qc/reports?orderId=${item.orderId}`, item.owner); expect(actualReports.status).toBe(200);
    captureNativeWire('decision', { actor: item.owner, reportId: report.id, input, first: first.body, reports: actualReports.body }); expect(typeof first.body.item.approvedAt).toBe('string');
    await db().userAccount.update({ where: { id: item.inspectorId }, data: { status: 'disabled' } }); const before = await ledger(item);
    const replay = await http(original.app, 'post', endpoint, item.owner).send(input); expect(replay.status).toBe(200); expect(replay.body).toEqual({ ...first.body, replayed: true });
    expect((await http(original.app, 'post', endpoint, item.owner).send({ ...input, reason: 'changed intent' })).status).toBe(409); expect(await ledger(item)).toEqual(before);
  });
  it('QA04 actual complete mandatory audit FK fault rolls back report, widths, assignment and ACK together', async () => {
    const item = await fixture('complete-audit'), original = await created(item), before = await ledger(item), probe: Probe = { auditFault: true };
    const res = await http(application(intercepted(probe)), 'post', `/qc/assignments/${original.response.body.item.id}/complete`, item.owner)
      .send({ report: { ...reportInput, widthMeasurements: [{ orderLineId: item.lineId, measuredWidthCm: 147, basisWidthCm: 147 }] }, expectedScopeFingerprint: original.response.body.item.scopeFingerprint, requestKey: `${item.id}-complete-fault` });
    expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2003'); expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('missing-audit-user'); expect(await ledger(item)).toEqual(before);
  });
  it('QA05 actual decision mandatory audit FK fault preserves original report and successful history, no ACK', async () => {
    const item = await fixture('decision-audit'), original = await completed(item), report = original.completion.body.report, before = await ledger(item), probe: Probe = { auditFault: true };
    const res = await http(application(intercepted(probe)), 'post', `/qc/reports/${report.id}/business-decision`, item.owner).send({ expectedRevision: report.revision,
      expectedScopeFingerprint: report.scopeFingerprint, expectedContentFingerprint: report.contentFingerprint, decision: 'approved', reason: 'Actual decision fault', requestKey: `${item.id}-decision-fault` });
    expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2003'); expect(res.status).toBe(500); expect(await ledger(item)).toEqual(before);
    expect(before.reports[0].approvedAt).toBeNull();
  });
  it('QA06 modern exact ACK is followed by actual legacy readback date DTOs without changing stored audit timestamps', async () => {
    const item = await fixture('date-readback'), original = await completed(item), first = original.completion.body, before = await ledger(item);
    const board = await http(original.app, 'get', '/qc/workbench', item.owner), row = board.body.completed.find((entry: any) => entry.id === first.item.id);
    expect(board.status).toBe(200); expect(row).toBeTruthy(); expect(typeof row.completedAt).toBe('number');
    expect(String(row.completedAt)).toBe(first.item.completedAt); expect(new Date(row.completedAt).toLocaleString('zh-CN', { hour12: false })).not.toBe('Invalid Date');
    const reports = await http(original.app, 'get', `/qc/reports?orderId=${item.orderId}`, item.owner), current = reports.body.items.find((entry: any) => entry.id === first.report.id);
    expect(reports.status).toBe(200); expect(typeof current.createdAt).toBe('number'); expect(String(current.createdAt)).toBe(first.report.createdAt); expect(current.inspectionDate).toBe(reportInput.inspectionDate);
    expect(await ledger(item)).toEqual(before);
    captureNativeWire('readback', { actor: item.owner, complete: first, board: board.body, reports: reports.body });
  });
});
