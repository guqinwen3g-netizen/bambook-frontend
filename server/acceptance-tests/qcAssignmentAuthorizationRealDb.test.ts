/** Opt-in private PG only. Native assignment -> assigned inspector context ->
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

const prefix = `acceptance-qc-task-${randomUUID()}`, auth = createAuthService(), grantor = `${prefix}-grantor`;
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
  await db().userAccount.create({ data: { id: grantor, displayName: 'Synthetic QC grantor', status: 'active' } });
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
function report(item: Fixture) { return { result: 'pass', totalUnits: 100, passedUnits: 100, inspectionDate: '2026-10-02',
  widthMeasurements: [{ orderLineId: item.lineId, measuredWidthCm: 147, basisWidthCm: 147 }] }; }
async function snapshot(item: Fixture) {
  return { tasks: await db().qCAssignment.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    reports: await db().inspectionReport.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    widths: await db().inspectionWidthMeasurement.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { targetType: 'QCAssignment', actorId: { in: [item.ownerId, item.inspectorId, item.otherId] } }, orderBy: { id: 'asc' } }) };
}
const responseCode = (response: any) => response.body.error?.code ?? response.body.error;
type Probe = { auditFault?: boolean; storageFault?: boolean; afterOrderLock?: () => Promise<void>;
  beforeOrderLock?: () => Promise<void>; reached?: boolean; actualCode?: string; sqlState?: string };
/** Real SQL faults are sent through the interactive tx. Neither a thrown mock
 * error nor a mocked business fact can prove audit or storage rollback. */
function intercepted(probe: Probe): PrismaClient {
  let observed = false;
  return new Proxy(db(), { get(client, key) {
    if (key === '$transaction') return (work: any, options?: any) => client.$transaction(async tx => work(new Proxy(tx, { get(transaction, delegate) {
      if (delegate === '$queryRaw') return async (query: any, ...rest: any[]) => {
        const orderLock = query?.strings?.join(' ').includes('"Order"') && query?.strings?.join(' ').includes('FOR UPDATE');
        if (orderLock) await probe.beforeOrderLock?.();
        const rows = await (transaction.$queryRaw as any)(query, ...rest);
        if (orderLock && !observed && rows.length) { observed = true; await probe.afterOrderLock?.(); }
        return rows;
      };
      if (delegate === 'auditLog' && probe.auditFault) {
        const model = transaction.auditLog;
        return new Proxy(model, { get(real, method) {
          if (method === 'create') return async (args: any) => {
            probe.reached = true;
            try { return await real.create({ ...args, data: { ...args.data, actorId: `${prefix}-absent-actor` } }); }
            catch (error: any) { probe.actualCode = error.code; throw error; }
          };
          const value = Reflect.get(real, method); return typeof value === 'function' ? value.bind(real) : value;
        } });
      }
      if (delegate === 'orderLine' && probe.storageFault) {
        const model = transaction.orderLine;
        return new Proxy(model, { get(real, method) {
          if (method === 'findMany') return async () => {
            probe.reached = true;
            try { return await transaction.$queryRaw`SELECT "QC_INTERNAL_missing_必填" FROM "OrderLine" LIMIT 1`; }
            catch (error: any) { probe.actualCode = error.code; probe.sqlState = error.meta?.code; throw error; }
          };
          const value = Reflect.get(real, method); return typeof value === 'function' ? value.bind(real) : value;
        } });
      }
      const value = Reflect.get(transaction, delegate); return typeof value === 'function' ? value.bind(transaction) : value;
    } })), { ...options, timeout: 20_000 });
    const value = Reflect.get(client, key); return typeof value === 'function' ? value.bind(client) : value;
  } });
}

describe('actual isolated PG QC assignment authority and atomic completion', () => {
  it('QA01 assigned inspector reads only minimum inputs while general Order L2 remains hidden; native completion is audited', async () => {
    const item = await fixture('journey'), app = application(db()), id = await assignment(item, app);
    const general = await http(app, 'get', `/order-lines?orderId=${item.orderId}`, item.inspector);
    expect(general.status).toBe(200); expect(general.body.lines).toEqual([]);
    const context = await http(app, 'get', `/qc/assignments/${id}/inspection-context`, item.inspector);
    expect(context.status, JSON.stringify(context.body)).toBe(200);
    expect(Object.keys(context.body).sort()).toEqual(['assignment', 'lines', 'ok', 'order']);
    expect(context.body.assignment.qcUserId).toBe(item.inspectorId);
    expect(Object.keys(context.body.order).sort()).toEqual(['customer', 'id', 'poNumber', 'product', 'type']);
    expect(context.body.lines).toEqual([{ id: item.lineId, lineNumber: 1, itemNo: '10', materialCode: 'SYNTHETIC-FABRIC',
      description: 'Inspection input', quantity: 100, unit: 'M', width: '147 cm' }]);
    expect(JSON.stringify(context.body)).not.toMatch(/unitPrice|netValue|quoteAmount|987654|999\.99/);
    expect((await http(app, 'post', `/qc/assignments/${id}/start`, item.inspector)).status).toBe(200);
    const complete = await http(app, 'post', `/qc/assignments/${id}/complete`, item.inspector).send({ report: report(item), actorId: item.ownerId });
    expect(complete.status, JSON.stringify(complete.body)).toBe(200);
    const facts = await snapshot(item);
    expect(facts.tasks[0]).toMatchObject({ status: 'Completed', reportId: `INR__${item.orderId}`, qcUserId: item.inspectorId });
    expect(facts.reports[0]).toMatchObject({ inspectedBy: item.inspectorId, totalUnits: 100, passedUnits: 100 });
    expect(facts.widths).toHaveLength(1); expect(Number(facts.widths[0].measuredWidthCm)).toBe(147);
    expect(facts.audits.find(row => row.action === 'complete_assignment')).toMatchObject({ actorId: item.inspectorId,
      detail: { after: { actualActorId: item.inspectorId, assignedQcUserId: item.inspectorId, delegated: false } } });
  });
  it('QA02 another qc:write account cannot inspect, even with parent L2; custom name admin is no authority', async () => {
    const item = await fixture('other'), id = await assignment(item), app = application(db());
    expect((await http(app, 'get', `/qc/assignments/${id}/inspection-context`, item.other)).status).toBe(404);
    await db().relation.update({ where: { id: item.customerId }, data: { salesRepIds: [item.otherId] } });
    expect((await http(app, 'get', `/qc/assignments/${id}/inspection-context`, item.other)).status).toBe(200);
    const before = await snapshot(item);
    for (const action of ['start', 'complete']) {
      const response = await http(app, 'post', `/qc/assignments/${id}/${action}`, item.other).send({ report: report(item) });
      expect(response.status, JSON.stringify(response.body)).toBe(403); expect(responseCode(response)).toBe('FORBIDDEN');
    }
    expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it('QA03 reassignment removes the former task grant and gives only the new current inspector access', async () => {
    const item = await fixture('reassign'), id = await assignment(item), app = application(db());
    expect((await http(app, 'patch', `/qc/assignments/${id}`, item.owner).send({ qcUserId: item.otherId })).status).toBe(200);
    const before = await snapshot(item); app.changes.length = 0;
    expect((await http(app, 'get', `/qc/assignments/${id}/inspection-context`, item.inspector)).status).toBe(404);
    expect((await http(app, 'post', `/qc/assignments/${id}/complete`, item.inspector).send({ report: report(item) })).status).toBe(404);
    expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
    expect((await http(app, 'post', `/qc/assignments/${id}/start`, item.other)).status).toBe(200);
  });
  it('QA04 task assignment never grants management of a hidden mother Order', async () => {
    const item = await fixture('manage'), id = await assignment(item), app = application(db()), before = await snapshot(item);
    for (const [method, endpoint, body] of [
      ['patch', `/qc/assignments/${id}`, { qcUserId: item.otherId }], ['post', `/qc/assignments/${id}/cancel`, {}],
      ['delete', `/qc/assignments/${id}`, {}], ['post', '/qc/assignments', { orderId: item.orderId, inspectionType: 'midline', qcUserId: item.inspectorId }],
    ] as const) {
      expect((await http(app, method, endpoint, item.inspector).send(body)).status).toBe(404);
    }
    expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it('QA05 stale JWT cannot restore withdrawn scopes, disabled or soft-deleted account', async () => {
    for (const variant of ['withdraw', 'disabled', 'deleted'] as const) {
      const item = await fixture(variant), id = await assignment(item), app = application(db());
      if (variant === 'withdraw') await db().userPermissionOverrides.updateMany({ where: { userId: item.inspectorId }, data: { isActive: false } });
      else await db().userAccount.update({ where: { id: item.inspectorId }, data: variant === 'disabled' ? { status: 'disabled' } : { deletedAt: BigInt(Date.now()) } });
      const before = await snapshot(item);
      const read = await http(app, 'get', `/qc/assignments/${id}/inspection-context`, item.inspector);
      const write = await http(app, 'post', `/qc/assignments/${id}/start`, item.inspector);
      const expectedStatus = variant === 'withdraw' ? 403 : 401;
      expect(read.status).toBe(expectedStatus); expect(write.status).toBe(expectedStatus);
      expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
    }
  });
  it('QA06 canonical manager may inspect on behalf only with current explicit scope; the actual actor is the report/audit author', async () => {
    const item = await fixture('delegate'), id = await assignment(item), app = application(db());
    const response = await http(app, 'post', `/qc/assignments/${id}/complete`, item.owner).send({ report: report(item) });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const facts = await snapshot(item);
    expect(facts.reports[0].inspectedBy).toBe(item.ownerId); expect(facts.tasks[0].qcUserId).toBe(item.inspectorId);
    expect(facts.audits.find(row => row.action === 'complete_assignment')).toMatchObject({ actorId: item.ownerId,
      detail: { after: { actualActorId: item.ownerId, assignedQcUserId: item.inspectorId, delegated: true } } });
    const denied = await fixture('owner-no-grant'), deniedId = await assignment(denied), deniedApp = application(db());
    await db().userPermissionOverrides.updateMany({ where: { userId: denied.ownerId, scope: 'qc:write' }, data: { isActive: false } });
    const before = await snapshot(denied);
    expect((await http(deniedApp, 'post', `/qc/assignments/${deniedId}/start`, denied.owner)).status).toBe(403);
    expect(await snapshot(denied)).toEqual(before);
  });
  it('QA07 empty and read-only signed credential ceilings remain ceilings for owner and assigned inspector', async () => {
    const item = await fixture('cap'), id = await assignment(item), app = application(db()), before = await snapshot(item);
    for (const principal of [item.owner, item.inspector]) for (const ceiling of [[], ['qc:read']]) {
      const capped = { ...principal, permissionCeiling: ceiling };
      expect((await http(app, 'post', `/qc/assignments/${id}/complete`, capped).send({ report: report(item) })).status).toBe(403);
      if (!ceiling.length) expect((await http(app, 'get', `/qc/assignments/${id}/inspection-context`, capped)).status).toBe(403);
    }
    expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it('QA08 actual FK audit failure rolls back report, width, assignment and notifications; original command then succeeds', async () => {
    const item = await fixture('audit'), id = await assignment(item), before = await snapshot(item), probe: Probe = { auditFault: true }, app = application(intercepted(probe));
    const response = await http(app, 'post', `/qc/assignments/${id}/complete`, item.inspector).send({ report: report(item) });
    expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2003');
    expect(response.status, JSON.stringify(response.body)).toBe(500); expect(JSON.stringify(response.body)).not.toMatch(/Foreign key|P2003|AuditLog/);
    expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
    expect((await http(application(db()), 'post', `/qc/assignments/${id}/complete`, item.inspector).send({ report: report(item) })).status).toBe(200);
  });
  it('QA09 finite integer/range/calendar and foreign line validation produces no report or partial task', async () => {
    const item = await fixture('input'), id = await assignment(item), app = application(db()), before = await snapshot(item);
    for (const bad of [ { totalUnits: -1 }, { totalUnits: 1.5 }, { totalUnits: '100' }, { totalUnits: 100, passedUnits: 101 },
      { criticalDefects: 2147483648 }, { lotSize: 10, sampleSize: 11 }, { inspectionDate: '2026-02-30' },
      { inspectionDate: '2026-13-01' }, { widthMeasurements: [{ orderLineId: `${item.lineId}-foreign`, measuredWidthCm: 147, basisWidthCm: 147 }] } ]) {
      const response = await http(app, 'post', `/qc/assignments/${id}/complete`, item.inspector).send({ report: { ...report(item), ...bad } });
      expect(response.status, JSON.stringify(response.body)).toBe(400);
    }
    expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it.each(['midline', 'sample_pp__r1'])('QA15 final task cannot attach a same-order %s report and falsely complete', async inspectionType => {
    const item = await fixture(`wrong-report-${inspectionType}`), id = await assignment(item), app = application(db());
    const reportId = `${item.id}-existing-report`, ts = BigInt(Date.now());
    // Declared pre-existing storage fact; not a native inspection or approval.
    await db().inspectionReport.create({ data: { id: reportId, orderId: item.orderId, inspectionType, result: 'pass',
      inspectionDate: '2026-10-02', inspectedBy: item.inspectorId, totalUnits: 100, passedUnits: 100, createdAt: ts, updatedAt: ts } });
    const before = await snapshot(item);
    const response = await http(app, 'post', `/qc/assignments/${id}/complete`, item.inspector).send({ reportId });
    // Assignment validation preserves the native per-operation envelope;
    // the finite service error still determines HTTP400 and the zero-write gate.
    expect(response.status, JSON.stringify(response.body)).toBe(400); expect(responseCode(response)).toBe('QC_ASSIGNMENT_COMPLETE_FAILED');
    expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it('QA10 list/workbench filtering includes own task but excludes other hidden tasks before count/export', async () => {
    const item = await fixture('list'), ownId = await assignment(item), otherResponse = await http(application(db()), 'post', '/qc/assignments', item.owner)
      .send({ orderId: item.orderId, inspectionType: 'midline', qcUserId: item.otherId });
    expect(otherResponse.status).toBe(201);
    const app = application(db());
    const list = await http(app, 'get', `/qc/assignments?orderId=${item.orderId}&limit=1`, item.inspector);
    expect(list.status).toBe(200); expect(list.body.total).toBe(1); expect(list.body.items.map((row: any) => row.id)).toEqual([ownId]);
    const filtered = await http(app, 'get', `/qc/assignments?orderId=${item.orderId}&qcUserId=${item.otherId}`, item.inspector);
    expect(filtered.body.total).toBe(0); expect(filtered.body.items).toEqual([]);
    const bench = await http(app, 'get', '/qc/workbench', item.inspector);
    expect(bench.status).toBe(200); expect(bench.body.assigned.map((row: any) => row.id)).toEqual([ownId]);
    expect(JSON.stringify(bench.body)).not.toMatch(/quoteAmount|unitPrice|netValue/);
  });
  it('QA11 permission withdrawn after the Order lock is rechecked before any assignment write', async () => {
    const item = await fixture('lock-revoke'), id = await assignment(item), before = await snapshot(item), probe: Probe = {
      afterOrderLock: async () => {
        probe.reached = true;
        await db().userPermissionOverrides.updateMany({ where: { userId: item.inspectorId, scope: 'qc:write' }, data: { isActive: false } });
      },
    }, app = application(intercepted(probe));
    expect((await http(app, 'post', `/qc/assignments/${id}/start`, item.inspector)).status).toBe(403);
    expect(probe.reached).toBe(true); expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it('QA12 an unknown real SQL fault containing old validation keywords stays a safe 500 with zero partial completion', async () => {
    const item = await fixture('sql'), id = await assignment(item), before = await snapshot(item), probe: Probe = { storageFault: true }, app = application(intercepted(probe));
    const response = await http(app, 'post', `/qc/assignments/${id}/complete`, item.inspector).send({ report: report(item) });
    expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2010'); expect(probe.sqlState).toBe('42703');
    expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toMatch(/QC_INTERNAL|42703|必填|OrderLine/);
    expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it('QA13 concurrent completion locks the same task and commits only one report/audit', async () => {
    const item = await fixture('race'), id = await assignment(item);
    let arrived = 0, release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const probe: Probe = { beforeOrderLock: async () => { if (++arrived === 2) release(); await ready; } };
    const app = application(intercepted(probe));
    const responses = await Promise.all([1, 2].map(() => http(app, 'post', `/qc/assignments/${id}/complete`, item.inspector).send({ report: report(item) })));
    expect(responses.map(row => row.status).sort()).toEqual([200, 409]);
    const facts = await snapshot(item);
    expect(facts.reports).toHaveLength(1); expect(facts.widths).toHaveLength(1);
    expect(facts.audits.filter(row => row.action === 'complete_assignment')).toHaveLength(1); expect(app.changes).toHaveLength(1);
  });
  it('QA14 native create, reassign, start, cancel and delete each roll back on their actual mandatory audit FK failure', async () => {
    for (const action of ['create', 'reassign', 'start', 'cancel', 'delete'] as const) {
      const item = await fixture(`audit-${action}`), id = await assignment(item), before = await snapshot(item);
      const probe: Probe = { auditFault: true }, app = application(intercepted(probe));
      const response = action === 'create'
        ? await http(app, 'post', '/qc/assignments', item.owner).send({ orderId: item.orderId, inspectionType: 'midline', qcUserId: item.inspectorId })
        : action === 'reassign'
          ? await http(app, 'patch', `/qc/assignments/${id}`, item.owner).send({ qcUserId: item.otherId })
          : action === 'delete'
            ? await http(app, 'delete', `/qc/assignments/${id}`, item.owner)
            : await http(app, 'post', `/qc/assignments/${id}/${action}`, item.owner);
      expect(probe.reached, action).toBe(true); expect(probe.actualCode, action).toBe('P2003');
      expect(response.status, JSON.stringify(response.body)).toBe(500);
      expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
    }
  });
});
