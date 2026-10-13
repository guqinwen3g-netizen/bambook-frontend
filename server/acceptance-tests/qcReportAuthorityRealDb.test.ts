/** Private PG opt-in: native report read/sign and QC document authorization.
 * Only rendering/PDF bytes are substituted. Current account, grants, L2, locks,
 * report/signature/audit/file reference and SQL faults use the actual database.
 * No index/seed/scheduler/external actions; not PDF layout or browser proof. */
import { randomUUID } from 'node:crypto';
import { realpathSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

const rendering = vi.hoisted(() => {
  const value = { afterRender: null as null | (() => Promise<void>), calls: 0,
    priorUpload: process.env.BAMBOOK_UPLOAD_DIR,
    upload: process.env.BAMBOOK_ACCEPTANCE_SANDBOX ? `${process.env.BAMBOOK_ACCEPTANCE_SANDBOX}/qc-report-proof-files` : '' };
  if (value.upload) process.env.BAMBOOK_UPLOAD_DIR = value.upload;
  return value;
});
vi.mock('../src/templates/pdf', () => ({ renderHtmlToPdf: async () => {
  rendering.calls++; await rendering.afterRender?.();
  const pdf = Buffer.from('%PDF-1.4 isolated renderer substitute');
  return { pdf, bytes: pdf.length, sha: 'isolated-renderer-substitute' };
} }));
vi.mock('../src/templates/docTemplates/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/templates/docTemplates/registry')>();
  return { ...actual, renderServerDocument: async (_db: unknown, kind: string, data: any) =>
    `<html><body>${kind} native authorized report ${data?.report?.id ?? 'none'} <p>isolated template substitute</p></body></html>` };
});
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createQcRouter } from '../src/qc/qcRoute';
import { createCustomsRouter } from '../src/customs/customsRoute';
import { upsertDomainTradeDocument, generateTradeDocumentFile } from '../src/customs/tradeDocumentLifecycleService';
import { executeTool } from '../src/agent/toolRuntime';
import { buildQcSignReportDraft } from '../src/agent/qcFlow';
import { registerNewDomainQueryTools } from '../src/agent/newDomainQueryTools';
import type { ActorContext } from '../src/agent/types';

const prefix = `acceptance-qc-report-${randomUUID()}`, auth = createAuthService(), grantor = `${prefix}-grantor`;
let prisma: PrismaClient | undefined, seq = 0;
function db() { if (!prisma) throw Error('Private report client not initialized'); return prisma; }
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port || !rendering.upload) throw Error('Reviewed private acceptance database required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres')); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`;
  expect(identity, 'Actual PG identity before fixture writes').toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.create({ data: { id: grantor, displayName: 'Isolated QC report grantor', status: 'active' } });
  await db().role.upsert({ where: { id: 'owner' }, update: {}, create: { id: 'owner', name: 'Synthetic canonical owner', isSystem: true } });
  registerNewDomainQueryTools();
});
afterAll(async () => {
  rendering.afterRender = null;
  await prisma?.$disconnect();
  if (rendering.upload && process.env.BAMBOOK_ACCEPTANCE_SANDBOX && path.dirname(rendering.upload) === process.env.BAMBOOK_ACCEPTANCE_SANDBOX) {
    rmSync(rendering.upload, { recursive: true, force: true });
  }
  if (rendering.priorUpload === undefined) delete process.env.BAMBOOK_UPLOAD_DIR; else process.env.BAMBOOK_UPLOAD_DIR = rendering.priorUpload;
});
async function actor(userId: string) { return buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), userId)); }
async function fixture(label: string) {
  const id = `${prefix}-${++seq}-${label}`, ownerId = `${id}-owner`, inspectorId = `${id}-inspector`, otherId = `${id}-other`,
    orderId = `${id}-order`, customerId = `${id}-customer`, reportId = `${id}-report`, otherReportId = `${id}-midline`, chainReportId = `${id}-pp`;
  await db().$transaction(async tx => {
    for (const userId of [ownerId, inspectorId, otherId]) {
      await tx.userAccount.create({ data: { id: userId, displayName: 'Synthetic report actor', status: 'active' } });
      const roleId = userId === ownerId ? 'owner' : `${userId}-custom`;
      if (userId !== ownerId) await tx.role.create({ data: { id: roleId, name: 'admin', isSystem: false } });
      await tx.userRole.create({ data: { id: `${userId}-membership`, userId, roleId } });
      await tx.userPermissionOverrides.createMany({ data: ['qc:read', 'qc:write', 'orders:read', 'customs:read', 'customs:write'].map(scope => ({
        id: `${userId}-${scope}`, userId, scope, isActive: true, grantedBy: grantor, reason: 'Isolated explicit capability, no company policy inference' })) });
    }
    await tx.relation.create({ data: { id: customerId, name: 'Synthetic customer', category: 'Customer', type: 'Company', isOrganization: true,
      contactInfo: '{}', tags: [], lastInteraction: BigInt(Date.now()), ownerId, salesRepIds: [] } });
    await tx.order.create({ data: { id: orderId, poNumber: `${id}-PO`, customer: 'Synthetic customer', product: 'Synthetic fabric', type: 'fabric',
      quantity: 10, status: 'InProduction', dueDate: '2099-01-01', quoteAmount: 987654, customerRelationId: customerId, ownerId, updatedAt: BigInt(Date.now()) } });
    for (const [report, type, by] of [[reportId, 'final', inspectorId], [otherReportId, 'midline', ownerId], [chainReportId, 'sample_pp__r1', ownerId]]) {
      await tx.inspectionReport.create({ data: { id: report, orderId, inspectionType: type, totalUnits: 10, passedUnits: 10, inspectedBy: by,
        result: 'pass', inspectionDate: '2026-10-02', signatures: { chain: { original: true } }, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
    }
    await tx.qCAssignment.create({ data: { id: `${id}-task`, orderId, inspectionType: 'final', qcUserId: inspectorId, status: 'Completed', reportId,
      assignedAt: BigInt(Date.now()), completedAt: BigInt(Date.now()), createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  });
  return { id, ownerId, inspectorId, otherId, orderId, customerId, reportId, otherReportId, chainReportId,
    owner: await actor(ownerId), inspector: await actor(inspectorId), other: await actor(otherId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function application(client = db(), requireAuth = true) {
  const app = express(), changes: any[] = [];
  app.use(express.json()); app.use(createAccountStatusGuard(client));
  app.use(createAuthorizationSnapshotGuard({ prisma: client, apiKeys: new Set(), apiKeyActors: new Map() }));
  app.use('/qc', createQcRouter({ prisma: client, requireAuth, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
  app.use('/customs', createCustomsRouter({ prisma: client, requireAuth, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
  return { app, changes };
}
function http(app: ReturnType<typeof application>, method: 'get' | 'post' | 'put', endpoint: string, principal: TokenPayload) {
  return request(app.app)[method](endpoint).set('Authorization', `Bearer ${auth.signToken(principal)}`);
}
async function snapshot(item: Fixture) {
  return { reports: await db().inspectionReport.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    documents: await db().tradeDocument.findMany({ where: { domain: 'qc', orderId: item.orderId }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: { in: [item.ownerId, item.inspectorId, item.otherId] } }, orderBy: { id: 'asc' } }) };
}
const responseCode = (r: any) => r.body.error?.code ?? r.body.error;
function files() { const dir = path.join(rendering.upload, 'trade-documents'); return existsSync(dir) ? readdirSync(dir).sort() : []; }
function toolActor(principal: TokenPayload): ActorContext { return { userId: principal.userId, roles: principal.roles,
  departmentIds: principal.departmentIds, permissionScopes: principal.permissions, permissionsAuthoritative: true,
  permissionCeiling: principal.permissionCeiling, memoryScopes: [], knowledgeScopes: [], toolScopes: ['qc'] }; }
type Probe = { auditFault?: boolean; reportFault?: boolean; grantFault?: boolean; reached?: boolean; actualCode?: string; sqlState?: string };
function intercepted(probe: Probe): PrismaClient {
  const modelProxy = (tx: any, delegate: string, value: any) => new Proxy(value, { get(model, method) {
    if ((delegate === 'auditLog' && probe.auditFault && method === 'create') ||
      (delegate === 'inspectionReport' && probe.reportFault && method === 'update') ||
      (delegate === 'userPermissionOverrides' && probe.grantFault && method === 'findMany')) {
      return async (args: any) => {
        probe.reached = true;
        try {
          if (delegate === 'auditLog') return await model.create({ ...args, data: { ...args.data, actorId: `${prefix}-absent` } });
          return await tx.$queryRaw`SELECT "QC_REPORT_INTERNAL_不存在_必填" FROM "InspectionReport" LIMIT 1`;
        } catch (error: any) { probe.actualCode = error.code; probe.sqlState = error.meta?.code; throw error; }
      };
    }
    const field = Reflect.get(model, method); return typeof field === 'function' ? field.bind(model) : field;
  } });
  return new Proxy(db(), { get(client, key) {
    if (key === '$transaction') return (work: any, options?: any) => client.$transaction(async tx => work(new Proxy(tx, { get(transaction, name) {
      const value = Reflect.get(transaction, name);
      if (['auditLog', 'inspectionReport', 'userPermissionOverrides'].includes(String(name))) return modelProxy(transaction, String(name), value);
      return typeof value === 'function' ? value.bind(transaction) : value;
    } })), { ...options, timeout: 20_000 });
    const value = Reflect.get(client, key);
    if (key === 'userPermissionOverrides') return modelProxy(client, String(key), value);
    return typeof value === 'function' ? value.bind(client) : value;
  } });
}
/** Real external lock wait witness (not an injected error or same-tx mutation).
 * The request is proved blocked by pg_blocking_pids before independently revoking
 * its grant/share. ReadCommitted must observe that revocation after the lock. */
async function whileOrderLocked(item: Fixture, action: () => Promise<any>, revoke: () => Promise<void>) {
  let ready!: () => void, release!: () => void, blockerPid = 0;
  const locked = new Promise<void>(r => { ready = r; }), freed = new Promise<void>(r => { release = r; });
  const blocker = db().$transaction(async tx => {
    const pid = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; blockerPid = pid[0].pid;
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${item.orderId} FOR UPDATE`);
    ready(); await freed;
  }, { timeout: 20_000 });
  await locked;
  const running = action();
  try {
    let witnessed = false;
    for (let attempt = 0; attempt < 100 && !witnessed; attempt++) {
      const rows = await db().$queryRaw<Array<{ pid: number }>>`SELECT pid FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))`;
      witnessed = rows.length > 0; if (!witnessed) await new Promise(r => setTimeout(r, 20));
    }
    expect(witnessed, 'Actual native request is waiting on held Order row lock').toBe(true);
    await revoke();
  } finally { release(); await blocker; }
  return running;
}

describe('native QC reports: actual current authority, locked dual signatures and private documents', () => {
  it('QR01 actual inspector sees only its own live report before count/pagination; chain and other type stay hidden', async () => {
    const item = await fixture('minimal'), app = application();
    const list = await http(app, 'get', `/qc/reports?orderId=${item.orderId}&limit=1&offset=0`, item.inspector);
    expect(list.status, JSON.stringify(list.body)).toBe(200); expect(list.body.total).toBe(1);
    expect(list.body.items.map((row: any) => row.id)).toEqual([item.reportId]);
    expect(JSON.stringify(list.body)).not.toMatch(/quoteAmount|unitPrice|987654/);
    expect((await http(app, 'get', `/qc/reports/${item.otherReportId}`, item.inspector)).status).toBe(404);
    const chains = await http(app, 'get', `/qc/chain/${item.orderId}/reports`, item.inspector);
    expect(chains.status).toBe(200); expect(chains.body.items).toEqual([]);
    const denied = await http(app, 'get', `/qc/reports/${item.reportId}`, item.other); expect(denied.status).toBe(404);
  });
  it('QR02 a native exact assignment/type gives the assigned reader only that report; cancelled task loses access', async () => {
    const item = await fixture('assignment'), app = application();
    await db().inspectionReport.update({ where: { id: item.reportId }, data: { inspectedBy: item.ownerId } });
    expect((await http(app, 'get', `/qc/reports/${item.reportId}`, item.inspector)).status).toBe(200);
    await db().qCAssignment.update({ where: { id: `${item.id}-task` }, data: { inspectionType: 'midline' } });
    expect((await http(app, 'get', `/qc/reports/${item.reportId}`, item.inspector)).status).toBe(404);
    await db().qCAssignment.update({ where: { id: `${item.id}-task` }, data: { inspectionType: 'final', status: 'Cancelled' } });
    expect((await http(app, 'get', `/qc/reports/${item.reportId}`, item.inspector)).status).toBe(404);
  });
  it('QR03 actual relation/shared customer L2 gives all its reports with consistent filters, count and pages', async () => {
    const item = await fixture('team'), app = application(), teamId = `${item.id}-team`;
    await db().team.create({ data: { id: teamId, name: 'Isolated report shared team' } });
    await db().teamMember.create({ data: { id: `${teamId}-member`, teamId, userId: item.otherId } });
    await db().teamDataGrant.create({ data: { id: `${teamId}-grant`, teamId, entityType: 'relation', entityId: item.customerId, permission: 'read', grantedBy: item.ownerId } });
    const list = await http(app, 'get', `/qc/reports?orderId=${item.orderId}&limit=2&offset=2`, item.other);
    expect(list.status).toBe(200); expect(list.body.total).toBe(3); expect(list.body.items).toHaveLength(1);
    const orderList = await http(app, 'get', `/qc/orders/${item.orderId}/reports`, item.other);
    expect(orderList.status).toBe(200); expect(orderList.body.total).toBe(3);
    await db().teamDataGrant.update({ where: { id: `${teamId}-grant` }, data: { revokedAt: new Date() } });
    const withdrawn = await http(app, 'get', `/qc/reports?orderId=${item.orderId}`, item.other);
    expect(withdrawn.status).toBe(200); expect(withdrawn.body.total).toBe(0); expect(withdrawn.body.items).toEqual([]);
  });
  it('QR04 deleted parent hides list/detail/preview/sign/generate without erasing reports or signatures', async () => {
    const item = await fixture('deleted'), app = application(); await db().order.update({ where: { id: item.orderId }, data: { deletedAt: BigInt(Date.now()) } });
    const before = await snapshot(item), rendered = rendering.calls;
    const list = await http(app, 'get', `/qc/reports?orderId=${item.orderId}`, item.owner);
    expect(list.status).toBe(200); expect(list.body.total).toBe(0); expect(list.body.items).toEqual([]);
    for (const endpoint of [`/qc/reports/${item.reportId}`, `/qc/reports/${item.reportId}/preview.html`]) expect((await http(app, 'get', endpoint, item.owner)).status).toBe(404);
    expect((await http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.inspector).send({ role: 'qc' })).status).toBe(404);
    expect((await http(app, 'post', `/qc/reports/${item.reportId}/generate-document`, item.owner)).status).toBe(404);
    expect(await snapshot(item)).toEqual(before); expect(rendering.calls).toBe(rendered); expect(app.changes).toEqual([]);
  });
  it('QR05 stale permissions, disabled accounts and signed ceiling cannot restore native read/write authority', async () => {
    const item = await fixture('authority'), app = application(), before = await snapshot(item);
    for (const principal of [item.owner, item.inspector]) {
      expect((await http(app, 'get', `/qc/reports/${item.reportId}`, { ...principal, permissionCeiling: [] })).status).toBe(403);
      expect((await http(app, 'post', `/qc/reports/${item.reportId}/sign`, { ...principal, permissionCeiling: ['qc:read'] }).send({ role: 'qc' })).status).toBe(403);
    }
    await db().userPermissionOverrides.updateMany({ where: { userId: item.inspectorId, scope: { in: ['qc:read', 'qc:write'] } }, data: { isActive: false } });
    expect((await http(app, 'get', `/qc/reports/${item.reportId}`, item.inspector)).status).toBe(403);
    expect((await http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.inspector).send({ role: 'qc' })).status).toBe(403);
    await db().userAccount.update({ where: { id: item.otherId }, data: { status: 'disabled' } });
    expect((await http(app, 'get', `/qc/reports/${item.reportId}`, item.other)).status).toBe(401);
    expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it('QR06 current grant loader SQL failure is explicit 503, never successful empty; dev anonymous remains denied', async () => {
    const item = await fixture('loader'), probe: Probe = { grantFault: true }, app = application(intercepted(probe)), before = await snapshot(item);
    const response = await http(app, 'get', `/qc/reports/${item.reportId}`, item.inspector);
    expect(response.status).toBe(503); expect(responseCode(response)).toBe('AUTHORIZATION_UNAVAILABLE');
    expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2010'); expect(probe.sqlState).toBe('42703');
    expect(JSON.stringify(response.body)).not.toMatch(/QC_REPORT_INTERNAL|InspectionReport|42703/);
    expect((await request(application(db(), false).app).get('/qc/reports')).status).toBe(401);
    expect(await snapshot(item)).toEqual(before);
  });
  it('QR07 actual inspector signs, field audit and chain merge are atomic; duplicate remains 400 with no new audit/event', async () => {
    const item = await fixture('sign'), app = application();
    const signed = await http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.inspector).send({ role: 'qc', actorId: item.ownerId });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200); expect(signed.body.item.signatures.qcSignerId).toBe(item.inspectorId);
    expect(signed.body.item.signatures.chain).toEqual({ original: true });
    const facts = await snapshot(item);
    expect(facts.audits.find(row => row.action === 'inspection_report_sign_qc')).toMatchObject({ actorId: item.inspectorId, fieldPath: 'signatures.qcSignedAt',
      detail: { after: { delegated: false, inspectedBy: item.inspectorId } } });
    const changes = [...app.changes];
    const duplicate = await http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.inspector).send({ role: 'qc' });
    expect(duplicate.status).toBe(400); expect(duplicate.body.error.message).toContain('已签署');
    expect(await snapshot(item)).toEqual(facts); expect(app.changes).toEqual(changes);
  });
  it('QR08 label admin + qc write cannot sign another inspector; actual manager delegation requires reason and is audited', async () => {
    const item = await fixture('delegate'), app = application();
    await db().relation.update({ where: { id: item.customerId }, data: { salesRepIds: [item.otherId] } });
    const before = await snapshot(item);
    expect((await http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.other).send({ role: 'qc', delegationReason: '说明代签' })).status).toBe(403);
    expect((await http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.owner).send({ role: 'qc' })).status).toBe(403);
    expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
    const result = await http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.owner).send({ role: 'qc', delegationReason: '本次由当前管理人员现场核验代签' });
    expect(result.status).toBe(200);
    const facts = await snapshot(item);
    expect(facts.audits.find(row => row.action === 'inspection_report_sign_qc')).toMatchObject({ actorId: item.ownerId,
      detail: { after: { delegated: true, inspectedBy: item.inspectorId, delegationReason: '本次由当前管理人员现场核验代签' } } });
  });
  it('QR09 business sign needs actual owner or active department head and Order L2; plain role/inspector is insufficient', async () => {
    const item = await fixture('business'), app = application();
    await db().relation.update({ where: { id: item.customerId }, data: { salesRepIds: [item.inspectorId, item.otherId] } });
    const before = await snapshot(item);
    expect((await http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.inspector).send({ role: 'business' })).status).toBe(403);
    expect(await snapshot(item)).toEqual(before);
    const departmentId = `${item.id}-dept`;
    await db().department.create({ data: { id: departmentId, name: 'Synthetic department', status: 'active', headId: item.otherId } });
    await db().order.update({ where: { id: item.orderId }, data: { departmentId } });
    expect((await http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.other).send({ role: 'business' })).status).toBe(200);
    const owner = await http(app, 'post', `/qc/reports/${item.otherReportId}/sign`, item.owner).send({ role: 'business' });
    expect(owner.status).toBe(200); expect(owner.body.item.signatures.businessSignerId).toBe(item.ownerId);
  });
  it('QR10 real Order lock wait then external qc write revocation is observed before signature/audit', async () => {
    const item = await fixture('lock-revoke'), app = application(), before = await snapshot(item);
    const response = await whileOrderLocked(item,
      () => http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.inspector).send({ role: 'qc' }).then(r => r),
      async () => { await db().userPermissionOverrides.updateMany({ where: { userId: item.inspectorId, scope: 'qc:write' }, data: { isActive: false } }); });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it('QR11 real Order lock wait then external L2 share revocation blocks an otherwise valid business owner', async () => {
    const item = await fixture('lock-share'), app = application(), teamId = `${item.id}-team`;
    await db().order.update({ where: { id: item.orderId }, data: { ownerId: item.otherId } });
    await db().team.create({ data: { id: teamId, name: 'Isolated restore share' } });
    await db().teamMember.create({ data: { id: `${teamId}-member`, teamId, userId: item.otherId } });
    await db().teamDataGrant.create({ data: { id: `${teamId}-grant`, teamId, entityType: 'relation', entityId: item.customerId, permission: 'read', grantedBy: item.ownerId } });
    const before = await snapshot(item);
    const response = await whileOrderLocked(item,
      () => http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.other).send({ role: 'business' }).then(r => r),
      async () => { await db().teamDataGrant.update({ where: { id: `${teamId}-grant` }, data: { revokedAt: new Date() } }); });
    expect(response.status, JSON.stringify(response.body)).toBe(404); expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it('QR12 concurrent same role writes one signature/audit; different roles merge without overwriting either historical fact', async () => {
    const item = await fixture('concurrent'), app = application();
    const same = await Promise.all([1, 2].map(() => http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.inspector).send({ role: 'qc' })));
    expect(same.map(r => r.status).sort()).toEqual([200, 400]);
    const facts = await snapshot(item); expect(facts.audits.filter(row => row.action === 'inspection_report_sign_qc')).toHaveLength(1);
    const other = await fixture('dual'), otherApp = application();
    const dual = await Promise.all([
      http(otherApp, 'post', `/qc/reports/${other.reportId}/sign`, other.inspector).send({ role: 'qc' }),
      http(otherApp, 'post', `/qc/reports/${other.reportId}/sign`, other.owner).send({ role: 'business' }),
    ]);
    expect(dual.map(r => r.status)).toEqual([200, 200]);
    const saved = await db().inspectionReport.findUniqueOrThrow({ where: { id: other.reportId } });
    expect(saved.signatures).toMatchObject({ qcSignerId: other.inspectorId, businessSignerId: other.ownerId, chain: { original: true } });
  });
  it('QR13 actual mandatory audit FK failure and unknown SQL roll back signatures; never leak validation-looking SQL', async () => {
    for (const probe of [{ auditFault: true }, { reportFault: true }] as Probe[]) {
      const item = await fixture('sql-rollback'), app = application(intercepted(probe)), before = await snapshot(item);
      const response = await http(app, 'post', `/qc/reports/${item.reportId}/sign`, item.inspector).send({ role: 'qc' });
      expect(response.status).toBe(500); expect(probe.reached).toBe(true); expect(probe.actualCode).toBe(probe.auditFault ? 'P2003' : 'P2010');
      expect(JSON.stringify(response.body)).not.toMatch(/QC_REPORT_INTERNAL|不存在|必填|42703|P2003|InspectionReport/);
      expect(await snapshot(item)).toEqual(before); expect(app.changes).toEqual([]);
    }
  });
  it('QR14 approved Agent snapshot actorId cannot supply identity; actual runtime actor reaches the native sign transaction', async () => {
    const item = await fixture('agent'), draft = buildQcSignReportDraft({ reportId: item.reportId, role: 'qc', actorId: item.inspectorId });
    const approvalId = `${item.id}-approval`;
    await db().approvalRequest.create({ data: { id: approvalId, status: 'approved', actionType: 'tool:qc.sign_report', targetType: 'InspectionReport', targetId: item.reportId, requesterId: item.inspectorId,
      payload: { processDraft: draft } as any } });
    const before = await snapshot(item);
    for (const context of [undefined, { actor: toolActor(item.other) }]) {
      const result: any = await executeTool(db(), { toolId: 'qc.sign_report', input: {}, approvalId } as any, context);
      expect(result.ok).toBe(false); expect(result.errorFeedback.code).toBe('SIGN_FAILED');
    }
    expect(await snapshot(item)).toEqual(before);
    expect(await db().agentCommitReceipt.count({ where: { approvalId } })).toBe(0);
    const result: any = await executeTool(db(), { toolId: 'qc.sign_report', input: {}, approvalId } as any, { actor: toolActor(item.inspector) });
    expect(result.ok, JSON.stringify(result)).toBe(true); expect(result.status).toBe('committed');
    expect((await db().inspectionReport.findUniqueOrThrow({ where: { id: item.reportId } })).signatures).toMatchObject({ qcSignerId: item.inspectorId });
    const query: any = await executeTool(db(), { toolId: 'qc.query_reports', input: { orderId: item.orderId } } as any, { actor: toolActor(item.inspector) });
    expect(query.total).toBe(1); expect(query.items.map((r: any) => r.id)).toEqual([item.reportId]);
    await expect(executeTool(db(), { toolId: 'qc.query_reports', input: { orderId: item.orderId, includeEligibility: true } } as any,
      { actor: toolActor(item.inspector) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('QR15 native producer needs trusted current actor and rejects a forged document parent before any metadata write', async () => {
    const item = await fixture('producer'), before = await snapshot(item);
    await expect(upsertDomainTradeDocument(db(), { domain: 'qc', type: 'InspectionReport', sourceRef: item.reportId, actorId: item.ownerId }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(upsertDomainTradeDocument(db(), { domain: 'qc', type: 'InspectionReport', sourceRef: item.reportId, orderId: 'forged-parent', actorId: item.ownerId, trustedActor: item.owner }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await snapshot(item)).toEqual(before);
  });
  it('QR16 actual authorized preview/generation/archive download agree; global customs read and mixed ZIP cannot borrow QC access', async () => {
    const item = await fixture('document'), app = application();
    const preview = await http(app, 'get', `/qc/reports/${item.reportId}/preview.html`, item.inspector);
    expect(preview.status).toBe(200); expect(preview.text).toContain(item.reportId);
    const generated = await http(app, 'post', `/qc/reports/${item.reportId}/generate-document`, item.inspector);
    expect(generated.status, JSON.stringify(generated.body)).toBe(200); const documentId = generated.body.document.documentId;
    const downloaded = await http(app, 'get', `/customs/trade-documents/${documentId}/download`, item.inspector);
    expect(downloaded.status).toBe(200);
    expect((await http(app, 'post', '/customs/trade-documents/batch-download', item.inspector).send({ ids: [documentId] })).status).toBe(200);
    const original = await db().tradeDocument.findUniqueOrThrow({ where: { id: documentId } });
    const before = await snapshot(item), filesBefore = files();
    await expect(generateTradeDocumentFile(db(), { id: documentId, actorId: item.inspectorId })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect((await http(app, 'put', `/customs/trade-documents/${documentId}`, item.inspector).send({ type: 'PackingList' })).status).toBe(409);
    expect(await snapshot(item)).toEqual(before);
    const ordinaryId = `${item.id}-ordinary`, borrowedId = `${item.id}-borrowed`, ordinaryIrId = `${item.id}-ordinary-ir`;
    await db().tradeDocument.createMany({ data: [
      { id: ordinaryId, documentNumber: `${ordinaryId}-PL`, domain: 'customs', type: 'Other', createdAt: 1n, updatedAt: 1n },
      { id: borrowedId, documentNumber: `${borrowedId}-PL`, domain: 'customs', type: 'PackingList', filePath: original.filePath,
        fileName: original.fileName, createdAt: 1n, updatedAt: 1n },
      { id: ordinaryIrId, documentNumber: `${ordinaryIrId}-IR`, domain: 'customs', type: 'InspectionReport', sourceRef: item.reportId,
        orderId: item.orderId, createdAt: 1n, updatedAt: 1n },
    ] });
    for (const principal of [item.other, item.inspector]) {
      const expected = principal.userId === item.inspectorId ? 409 : 404;
      expect((await http(app, 'get', `/customs/trade-documents/${ordinaryIrId}/preview.html`, principal)).status).toBe(expected);
      expect((await http(app, 'post', `/customs/trade-documents/${ordinaryIrId}/generate-file`, principal).send({ html: '<html>Caller content cannot override private native source</html>' })).status).toBe(expected);
      expect((await http(app, 'post', '/customs/trade-documents/batch-download', principal).send({ ids: [ordinaryId, ordinaryIrId] })).status).toBe(expected);
    }
    expect((await db().tradeDocument.findUniqueOrThrow({ where: { id: ordinaryIrId } })).filePath).toBeNull();
    expect(files()).toEqual(filesBefore);
    expect((await http(app, 'get', `/customs/trade-documents/${borrowedId}/download`, item.other)).status).toBe(404);
    expect((await http(app, 'get', `/customs/trade-documents/${borrowedId}/download`, item.inspector)).status).toBe(409);
    expect((await http(app, 'post', '/customs/trade-documents/batch-download', item.inspector).send({ ids: [borrowedId] })).status).toBe(409);
    // Even a legacy type edit retaining the file reference cannot change its native identity.
    await db().tradeDocument.update({ where: { id: documentId }, data: { type: 'PackingList' } });
    expect((await http(app, 'get', `/customs/trade-documents/${documentId}/download`, item.inspector)).status).toBe(409);
    await db().tradeDocument.update({ where: { id: documentId }, data: { type: 'InspectionReport' } });
    for (const endpoint of [`/customs/trade-documents/${documentId}/download`, `/customs/trade-documents/${documentId}/preview.html`]) {
      expect((await http(app, 'get', endpoint, item.other)).status).toBe(404);
    }
    expect((await http(app, 'post', '/customs/trade-documents/batch-download', item.other).send({ ids: [ordinaryId, documentId] })).status).toBe(404);
    expect(await snapshot(item)).toEqual(before); expect(files()).toEqual(filesBefore);
    await db().inspectionReport.update({ where: { id: item.reportId }, data: { notes: 'New native source fact' } });
    expect((await http(app, 'get', `/customs/trade-documents/${documentId}/download`, item.inspector)).status).toBe(409);
  });
  it('QR17 render-then-withdraw and render-then-source-change reject publication and remove only the new attempt; old archive survives', async () => {
    for (const variant of ['grant', 'source'] as const) {
      const item = await fixture(`render-${variant}`), registration = await upsertDomainTradeDocument(db(), { domain: 'qc', type: 'InspectionReport',
        sourceRef: item.reportId, orderId: item.orderId, actorId: item.inspectorId, trustedActor: item.inspector });
      await generateTradeDocumentFile(db(), { id: registration.documentId, actorId: item.inspectorId, trustedActor: item.inspector });
      const before = await snapshot(item), filesBefore = files();
      rendering.afterRender = async () => {
        if (variant === 'grant') await db().userPermissionOverrides.updateMany({ where: { userId: item.inspectorId, scope: 'qc:write' }, data: { isActive: false } });
        else await db().inspectionReport.update({ where: { id: item.reportId }, data: { notes: 'Concurrent current source mutation' } });
      };
      try {
        await expect(generateTradeDocumentFile(db(), { id: registration.documentId, actorId: item.inspectorId, trustedActor: item.inspector }))
          .rejects.toMatchObject({ code: variant === 'grant' ? 'FORBIDDEN' : 'CONFLICT' });
      } finally { rendering.afterRender = null; }
      const after = await snapshot(item); expect(after.documents).toEqual(before.documents); expect(after.audits).toEqual(before.audits);
      if (variant === 'grant') expect(after.reports).toEqual(before.reports); else expect(after.reports.find(r => r.id === item.reportId)!.notes).toBe('Concurrent current source mutation');
      expect(files()).toEqual(filesBefore);
      for (const doc of before.documents) expect(existsSync(path.join(rendering.upload, doc.filePath!))).toBe(true);
    }
  });
  it('QR18 mandatory generation audit SQL FK failure rolls back reference and cleans temporary bytes without overwriting the old file', async () => {
    const item = await fixture('file-audit'), reg = await upsertDomainTradeDocument(db(), { domain: 'qc', type: 'InspectionReport', sourceRef: item.reportId,
      actorId: item.inspectorId, trustedActor: item.inspector });
    await generateTradeDocumentFile(db(), { id: reg.documentId, actorId: item.inspectorId, trustedActor: item.inspector });
    const before = await snapshot(item), filesBefore = files(), probe: Probe = { auditFault: true };
    await expect(generateTradeDocumentFile(intercepted(probe), { id: reg.documentId, actorId: item.inspectorId, trustedActor: item.inspector })).rejects.toThrow();
    expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2003');
    expect(await snapshot(item)).toEqual(before); expect(files()).toEqual(filesBefore);
  });
});
