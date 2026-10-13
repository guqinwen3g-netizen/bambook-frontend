/** Opt-in independent private PG: actual current QC report reader and tiny authorized parent snapshot.
 * INITIAL synthetic report/physical facts isolate the read producer; not a completion/signing journey claim.
 * Original native NP01/physical/QR controls separately exercise actual write producers. */
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createQcRouter } from '../src/qc/qcRoute';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';

const prefix = `acceptance-qc-report-metadata-${randomUUID()}`, auth = createAuthService(), grantor = `${prefix}-grantor`;
let prisma: PrismaClient | undefined, writes = 0;
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
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } }, log: [{ emit: 'event', level: 'query' }] });
  (prisma as any).$on('query', (event: { query: string }) => { if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i.test(event.query)) writes++; });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
  `;
  expect(identity, 'Actual PG identity before fixture writes').toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.create({ data: { id: grantor, displayName: 'Synthetic QC grantor', status: 'active' } });
  await seedNativeInitialFacts();
});
afterAll(async () => { await prisma?.$disconnect(); });
async function actor(userId: string) {
  const user = await loadUserWithRoles(db(), userId); expect(user?.status).toBe('active');
  return buildLoadedAuthTokenPayload(db(), user);
}
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

// INITIAL synthetic facts are deliberate: these are actual native read-producer
// controls, not a claim that this test executes the QC completion producer.
// Original NP01/physical regressions separately execute that native writer.
const IDS = { manager: 'manager-original', inspector: 'qc-original', foreign: 'foreign-reader', order: 'ORDER-ORIGINAL',
  line: 'LINE-ORIGINAL', batch: 'PB2', report: 'REPORT-PB2', customer: 'CUSTOMER-ORIGINAL', factory: 'FACTORY-ORIGINAL', asset: 'ASSET-ORIGINAL' };
async function seedNativeInitialFacts() {
  const at = BigInt(Date.now());
  await db().$transaction(async tx => {
    for (const uid of [IDS.manager, IDS.inspector, IDS.foreign]) {
      const roleId = `${prefix}-${uid}-role`;
      await tx.userAccount.create({ data: { id: uid, displayName: 'Synthetic current QC participant', status: 'active' } });
      await tx.role.create({ data: { id: roleId, name: 'admin', isSystem: false } });
      await tx.userRole.create({ data: { id: `${uid}-membership`, userId: uid, roleId } });
      await tx.userPermissionOverrides.createMany({ data: ['qc:read', 'qc:write'].map(scope => ({ id: `${uid}-${scope}`, userId: uid,
        scope, isActive: true, grantedBy: grantor, reason: 'Private actual current read/decision grant; no broad Order grant' })) });
    }
    for (const [id, category] of [[IDS.customer, 'Customer'], [IDS.factory, 'Supplier']] as const) {
      await tx.relation.create({ data: { id, name: id, category, type: 'Company', isOrganization: true,
        contactInfo: '{}', tags: [], lastInteraction: at, ownerId: IDS.manager, salesRepIds: [] } });
    }
    await tx.order.create({ data: { id: IDS.order, poNumber: 'PO-ORIGINAL-PB2', customer: '原授权客户-PB2', product: '原范围面料',
      type: 'Fabric', quantity: 100, status: 'InProduction', dueDate: '2099-01-01', quoteAmount: '987654',
      customerRelationId: IDS.customer, ownerId: IDS.manager, millRelationId: IDS.factory, updatedAt: at } });
    await tx.productAsset.create({ data: { id: IDS.asset, sku: IDS.asset, name: 'Synthetic confirmed input',
      mainCategory: 'fabric', subCategoryId: 'synthetic', season: 'synthetic', status: 'active', source: 'manual', updatedAt: at } });
    await tx.fabricProfile.create({ data: { id: `${IDS.asset}-profile`, productAssetId: IDS.asset, millOrganizationId: IDS.factory, updatedAt: at } });
    const specification = { materialCode: 'SYNTHETIC', width: '147CM', factoryRelationId: IDS.factory };
    const line = await tx.orderLine.create({ data: { id: IDS.line, orderId: IDS.order, lineNumber: 1, itemNo: '0010', materialCode: 'SYNTHETIC',
      description: 'Native controlled second batch', quantity: '100', unit: 'PC', width: '147CM', unitPrice: '999.99', netValue: '99999',
      confirmedSourceType: 'Asset', confirmedSourceId: IDS.asset, specSnapshot: specification } });
    const order = await tx.order.findUniqueOrThrow({ where: { id: IDS.order } });
    const { productionBatchSourceFingerprint } = await import('../src/production/productionBatchService');
    const sourceFingerprint = productionBatchSourceFingerprint(order, line, IDS.factory);
    await tx.productionBatch.create({ data: { id: IDS.batch, batchCode: 'PB-ORIGINAL-02', orderId: IDS.order, orderLineId: IDS.line,
      factoryRelationId: IDS.factory, rangeStart: '0', quantity: '100', unit: 'PC', revision: 1, state: 'active',
      confirmedSourceType: 'Asset', confirmedSourceId: IDS.asset, specSnapshot: specification, sourceFingerprint,
      requestKey: `${prefix}-initial`, parameterHash: sourceFingerprint, commandSnapshot: { fixtureLayer: 'INITIAL actual read-source facts' },
      createdBy: IDS.manager, createdAt: at, updatedAt: at } });
    const { resolveQcCoverage } = await import('../src/qc/qcPhysicalCoverage');
    const { reportContentFingerprint } = await import('../src/qc/qcReportReadProjection');
    const coverage = await resolveQcCoverage(tx, IDS.order, { scopeType: 'production_batch', productionBatchId: IDS.batch, expectedBatchRevision: 1 });
    const actual = await tx.inspectionReport.create({ data: { id: IDS.report, orderId: IDS.order, inspectionType: 'final', result: 'pass',
      inspectionDate: '2026-10-03', totalUnits: 100, passedUnits: 100, lotSize: 100, sampleSize: 100, criticalDefects: 0, majorDefects: 0, minorDefects: 0,
      defectSummary: '第二批原真实报告', notes: '原报告说明', inspectedBy: IDS.inspector, approvedByBusiness: false,
      scopeType: coverage.scopeType, scopeKey: coverage.scopeKey, scopeFingerprint: coverage.scopeFingerprint, scopeSnapshot: coverage.scopeSnapshot,
      productionBatchId: IDS.batch, productionBatchRevision: 1, revision: 1, signatures: { qcSignedAt: Number(at), qcSignerId: IDS.inspector }, createdAt: at, updatedAt: at } });
    await tx.inspectionReport.update({ where: { id: IDS.report }, data: { contentFingerprint: await reportContentFingerprint(tx, actual) } });
  });
}
async function facts() {
  return { order: await db().order.findUnique({ where: { id: IDS.order } }), line: await db().orderLine.findUnique({ where: { id: IDS.line } }),
    batch: await db().productionBatch.findUnique({ where: { id: IDS.batch } }), report: await db().inspectionReport.findUnique({ where: { id: IDS.report } }),
    widths: await db().inspectionWidthMeasurement.findMany({ where: { reportId: IDS.report }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: { in: [IDS.manager, IDS.inspector, IDS.foreign] } }, orderBy: { id: 'asc' } }) };
}
const responseCode = (response: any) => response.body.error?.code ?? response.body.error;
const detail = (principal: TokenPayload, app = application(db())) => http(app, 'get', `/qc/reports/${IDS.report}`, principal);
function exportWire(label: 'normal' | 'null-po' | 'list', response: any) {
  const directory = process.env.BAMBOOK_QC_REPORT_WIRE_DIR;
  if (!directory) return;
  if (!directory.startsWith('/private/tmp/bambook-qc-report-metadata-fix-') || !directory.endsWith('/native-wire')) throw Error('Private exact wire directory required');
  mkdirSync(directory, { recursive: true });
  const body = JSON.stringify(response.body); writeFileSync(path.join(directory, label + '.json'), body + '\n');
  const manifest = { origin: 'actual native Express qcRoute/getReport producer', sourceHead: '7450516c77e9672d6a070778458a45f7b89d10dd',
    serverSourceSHA256: createHash('sha256').update(readFileSync(new URL('../src/qc/qcService.ts', import.meta.url))).digest('hex'),
    bodySHA256: createHash('sha256').update(body + '\n').digest('hex'), reportId: IDS.report, orderId: IDS.order,
    parentDTO: response.body.item?.order ?? response.body.items?.find((row: any) => row.id === IDS.report)?.order ?? null, actualHttpStatus: response.status, noCompletionWriterClaim: true };
  writeFileSync(path.join(directory, label + '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
describe('native exact report parent metadata projection', () => {
  it('QRM01 actual same-parent exact HTTP snapshot restores PO/customer/product with no new fields, broad Order read or source writes', async () => {
    const principal = await actor(IDS.manager), app = application(db());
    const before = await facts(), writeBefore = writes;
    expect((await http(app, 'get', `/order-lines?orderId=${IDS.order}`, principal)).status).toBe(403);
    const response = await detail(principal, app); exportWire('normal', response);
    const listed = await http(app, 'get', '/qc/reports', principal); exportWire('list', listed);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.item.order).toEqual({ id: IDS.order, poNumber: 'PO-ORIGINAL-PB2', customer: '原授权客户-PB2', product: '原范围面料' });
    expect(response.body.item).toMatchObject({ id: IDS.report, orderId: IDS.order, contentCurrent: true, coverageCurrent: true, isCurrentRevision: true, canBusinessDecide: true });
    expect(JSON.stringify(response.body)).not.toMatch(/quoteAmount|unitPrice|netValue|987654|99999|permissions/);
    expect(await facts()).toEqual(before); expect(writes).toBe(writeBefore); expect(app.changes).toEqual([]);
  });
  it('QRM02 genuinely native null PO is returned as null with exact original parent/customer and no invented order label', async () => {
    await db().order.update({ where: { id: IDS.order }, data: { poNumber: null } });
    try {
      const before = await facts(), writeBefore = writes, app = application(db()), response = await detail(await actor(IDS.manager), app); exportWire('null-po', response);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.item.order).toEqual({ id: IDS.order, poNumber: null, customer: '原授权客户-PB2', product: '原范围面料' });
      expect(await facts()).toEqual(before); expect(writes).toBe(writeBefore); expect(app.changes).toEqual([]);
    } finally { await db().order.update({ where: { id: IDS.order }, data: { poNumber: 'PO-ORIGINAL-PB2' } }); }
  });
  it('QRM03 the small snapshot preserves actual inspector read and denies foreign L2, signed empty ceiling and current grant withdrawal without writes', async () => {
    const app = application(db()), inspector = await actor(IDS.inspector), manager = await actor(IDS.manager);
    const before = await facts(), writeBefore = writes, own = await detail(inspector, app);
    expect(own.status, JSON.stringify(own.body)).toBe(200); expect(own.body.item.order).toMatchObject({ id: IDS.order, customer: '原授权客户-PB2' });
    expect((await detail(await actor(IDS.foreign), app)).status).toBe(404);
    expect((await detail({ ...manager, permissionCeiling: [] }, app)).status).toBe(403);
    expect(await facts()).toEqual(before); expect(writes).toBe(writeBefore);
    await db().userPermissionOverrides.updateMany({ where: { userId: IDS.manager, scope: 'qc:read' }, data: { isActive: false } });
    try {
      const afterRevokeWrites = writes, denied = await detail(manager, app);
      expect(denied.status).toBe(403); expect(responseCode(denied)).toBe('FORBIDDEN'); expect(denied.body).not.toHaveProperty('item');
      expect(await facts()).toEqual(before); expect(writes).toBe(afterRevokeWrites); expect(app.changes).toEqual([]);
    } finally { await db().userPermissionOverrides.updateMany({ where: { userId: IDS.manager, scope: 'qc:read' }, data: { isActive: true } }); }
  });
});
