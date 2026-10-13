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

const prefix = `acceptance-qc-context-${randomUUID()}`, auth = createAuthService(), grantor = `${prefix}-grantor`;
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
// Reads below never manufacture a report: the original native completion writer
// supplies assignment.reportId, and the following GET must read that exact fact.
describe('current native QC task operational snapshot', () => {
  it('QCX01 exact assignee context includes original task metadata and customer without broad Order visibility or financial fields', async () => {
    const item = await fixture('snapshot'), app = application(db()), id = await assignment(item, app);
    const locationId = item.id + '-location';
    await db().qCLocation.create({ data: { id: locationId, code: item.id, name: '原任务驻地',
      createdAt: 1790980000000n, updatedAt: 1790980000000n } });
    await db().qCAssignment.update({ where: { id }, data: { locationId, notes: '原任务要求\n检查匹头与色差', dueDate: '2099-03-04' } });
    await db().userPermissionOverrides.updateMany({ where: { userId: item.inspectorId, scope: 'orders:read' }, data: { isActive: false } });
    const principal = await actor(item.inspectorId), before = await snapshot(item);
    const orderBefore = await db().order.findUnique({ where: { id: item.orderId } });
    expect((await http(app, 'get', `/order-lines?orderId=${item.orderId}`, principal)).status).toBe(403);
    const response = await http(app, 'get', `/qc/assignments/${id}/inspection-context`, principal);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(Object.keys(response.body.assignment).sort()).toEqual(['assignedAt', 'completedAt', 'dueDate', 'id',
      'inspectionType', 'location', 'locationId', 'notes', 'orderId', 'qcUserId', 'reportId', 'status', 'updatedAt']);
    expect(response.body.assignment).toMatchObject({ id, orderId: item.orderId, qcUserId: item.inspectorId,
      status: 'Assigned', dueDate: '2099-03-04', notes: '原任务要求\n检查匹头与色差',
      assignedAt: Number(before.tasks[0].assignedAt), completedAt: null, reportId: null, locationId,
      location: { id: locationId, code: item.id, name: '原任务驻地' } });
    expect(response.body.order).toEqual({ id: item.orderId, poNumber: `${item.id}-PO`, type: 'fabric',
      product: 'Synthetic fabric', customer: `${item.id}-customer` });
    expect(JSON.stringify(response.body)).not.toMatch(/unitPrice|netValue|quoteAmount|987654|999\.99|commandHash|requestKey|permissions/);
    expect(await snapshot(item)).toEqual(before);
    expect(await db().order.findUnique({ where: { id: item.orderId } })).toEqual(orderBefore);
    expect(app.changes).toHaveLength(1);
  });
  it('QCX02 original native start and completion reread exact completedAt/reportId without a new report or read audit', async () => {
    const item = await fixture('completed'), app = application(db()), id = await assignment(item, app);
    expect((await http(app, 'post', `/qc/assignments/${id}/start`, item.inspector)).status).toBe(200);
    const complete = await http(app, 'post', `/qc/assignments/${id}/complete`, item.inspector).send({ report: report(item) });
    expect(complete.status, JSON.stringify(complete.body)).toBe(200);
    const before = await snapshot(item);
    const response = await http(app, 'get', `/qc/assignments/${id}/inspection-context`, item.inspector);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.assignment).toMatchObject({ status: 'Completed', reportId: before.tasks[0].reportId,
      completedAt: Number(before.tasks[0].completedAt), assignedAt: Number(before.tasks[0].assignedAt) });
    expect(response.body.assignment.reportId).toBe(before.reports[0].id);
    expect(await snapshot(item)).toEqual(before);
  });
  it('QCX03 genuinely null notes, due date and location remain null rather than borrowed board data', async () => {
    const item = await fixture('nullable'), app = application(db()), id = await assignment(item, app);
    await db().qCAssignment.update({ where: { id }, data: { notes: null, dueDate: null, locationId: null } });
    const before = await snapshot(item), response = await http(app, 'get', `/qc/assignments/${id}/inspection-context`, item.inspector);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.assignment).toMatchObject({ dueDate: null, notes: null, locationId: null,
      location: null, completedAt: null, reportId: null });
    expect(await snapshot(item)).toEqual(before);
  });
  it('QCX04 actual native location read failure remains explicit safe failure with all original facts unchanged', async () => {
    const item = await fixture('location-fault'), id = await assignment(item), locationId = item.id + '-location';
    await db().qCLocation.create({ data: { id: locationId, code: item.id, name: '原任务驻地', createdAt: 1n, updatedAt: 1n } });
    await db().qCAssignment.update({ where: { id }, data: { locationId } });
    const before = await snapshot(item); let readFault = false;
    const client = new Proxy(db(), { get(real, key) {
      if (key === '$transaction') return (work: any, options: any) => real.$transaction(tx => work(new Proxy(tx, { get(t, delegate) {
        if (delegate === 'qCLocation') return new Proxy(t.qCLocation, { get(model, method) {
          if (method === 'findFirst') return async () => { readFault = true; return t.$queryRaw`SELECT "QC_INTERNAL_missing_location" FROM "QCLocation"`; };
          const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
        } });
        const value = Reflect.get(t, delegate); return typeof value === 'function' ? value.bind(t) : value;
      } })), options);
      const value = Reflect.get(real, key); return typeof value === 'function' ? value.bind(real) : value;
    } });
    const app = application(client), response = await http(app, 'get', `/qc/assignments/${id}/inspection-context`, item.inspector);
    expect(response.status).toBe(500); expect(readFault).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(/QC_INTERNAL_missing_location|QCLocation|SELECT/);
    expect(response.body).not.toHaveProperty('assignment'); expect(await snapshot(item)).toEqual(before);
    expect(app.changes).toEqual([]);
  });
  it.each(['foreign', 'ceiling'])('QCX05 new metadata never bypasses current %s task access', async variant => {
    const item = await fixture(variant), app = application(db()), id = await assignment(item, app), before = await snapshot(item);
    app.changes.length = 0;
    const principal = variant === 'foreign' ? item.other : { ...item.inspector, permissionCeiling: [] };
    const response = await http(app, 'get', `/qc/assignments/${id}/inspection-context`, principal);
    expect(response.status).toBe(variant === 'foreign' ? 404 : 403);
    expect(response.body).not.toHaveProperty('assignment'); expect(response.body).not.toHaveProperty('order');
    expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
});

it('QCX06 native nullable Order.poNumber stays null in authorized context with real customer and no invented PO', async () => {
  const item = await fixture('null-po'), app = application(db()), id = await assignment(item, app);
  await db().order.update({ where: { id: item.orderId }, data: { poNumber: null } });
  const before = await snapshot(item), orderBefore = await db().order.findUnique({ where: { id: item.orderId } });
  const response = await http(app, 'get', `/qc/assignments/${id}/inspection-context`, item.inspector);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.order).toEqual({ id: item.orderId, poNumber: null, type: 'fabric', product: 'Synthetic fabric', customer: `${item.id}-customer` });
  expect(response.body.assignment).toMatchObject({ id, orderId: item.orderId, qcUserId: item.inspectorId });
  expect(await snapshot(item)).toEqual(before);
  expect(await db().order.findUnique({ where: { id: item.orderId } })).toEqual(orderBefore);
});
