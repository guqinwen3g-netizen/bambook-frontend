/** Run this file in its own fresh isolated acceptance batch. Canonical role and
 * approval policy provisioning deliberately refuses another active roster.
 * No shared/dev database, terminal seed, mock authorization or synthetic JWT. */
import express, { type Express } from 'express';
import supertest from 'supertest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { seedScenarioMasterData, type ScenarioActorKey, type ScenarioMasterData } from '../scripts/full-business-sim/masterData';
import { createAuthRouter } from '../src/auth/route';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createAdminRouter } from '../src/admin/route';
import { createRelationsRouter } from '../src/relations/route';
import { createProductsRouter } from '../src/products/route';
import { createOrdersRouter } from '../src/orders/route';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createInventoryRouter } from '../src/inventory/inventoryRoute';
import { createSampleRouter } from '../src/samples/sampleRoute';
import { createQcRouter } from '../src/qc/qcRoute';
import { createTeamShareService } from '../src/teams/teamShareService';
import { createPermissionService } from '../src/auth/permissionService';
import { createApprovalRoutingService } from '../src/approvals/approvalRoutingService';
import { SYSTEM_ROLE_IDS } from '../src/_shared/rolePermissionMatrix';

const prisma = new PrismaClient({ datasources: { db: {
  url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled',
} } });
let app: Express, masters: ScenarioMasterData;
const sessions = {} as Record<ScenarioActorKey, { token: string; actor: TokenPayload; permissions: string[] }>;
const businessModels = ['approvalRequest', 'inspectionReport', 'developmentSampleQualityReview', 'developmentCase', 'sampleBatch', 'sample',
  'sampleCardItem', 'inventoryItem', 'stockMovement', 'materialReceipt', 'productionBatch', 'productionStockReceipt', 'factoryLoadingReceipt',
  'shipment', 'tradeDocument', 'documentVersion', 'invoice', 'paymentVoucher', 'invoiceAllocation', 'paymentRequest', 'cashAccountEntry',
  'companyCashAccount', 'supplierFulfillmentFact', 'factoryEvaluation'] as const;
const businessCounts = async () => Object.fromEntries(await Promise.all(businessModels.map(async model => [model, await (prisma as any)[model].count()])));
let beforeMasters: Record<string, number>, afterMasters: Record<string, number>;
const diagnostic = (response: supertest.Response) => JSON.stringify({ status: response.status, error: response.body?.error, message: response.body?.message });
function status(response: supertest.Response, expected = 200, label = 'native master-data HTTP') {
  expect(response.status, `${label}: ${diagnostic(response)}`).toBe(expected);
  expect(JSON.stringify(response.body)).not.toMatch(/P2003|P2010|23503|42703/);
  return response.body;
}
async function request(actor: ScenarioActorKey, method: 'get' | 'post', url: string, body?: Record<string, unknown>) {
  let call = supertest(app)[method](url).set('Authorization', `Bearer ${sessions[actor].token}`);
  if (body !== undefined) call = call.send(body);
  return await call;
}
const actorKey = (id: string) => {
  const account = Object.values(masters.cast).find(actor => actor.id === id);
  if (!account) throw new Error('Scenario actor not found');
  return account.key;
};

beforeAll(async () => {
  // This guard must precede EVERY fixture/master/business write.
  await assertIsolatedAcceptanceDatabase(prisma);
  expect(await prisma.orderApprovalAuthority.count(), 'master acceptance requires its own fresh batch; do not erase another test policy').toBe(0);
  beforeMasters = await businessCounts();
  expect(Object.values(beforeMasters).every(count => count === 0), 'fresh master batch must not import historical business verdicts').toBe(true);
  masters = await seedScenarioMasterData(prisma, { namespace: `master-${randomUUID().slice(0, 8)}`,
    nowMs: Date.parse('2026-10-08T00:18:00.000Z'), mode: 'apply' });
  afterMasters = await businessCounts();

  app = express();
  app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? String(value) : value);
  app.use(express.json());
  const options = { prisma, requireAuth: true, apiKeys: new Set<string>() };
  const privateFilesDir = path.join(process.env.BAMBOOK_ACCEPTANCE_SANDBOX!, `${masters.namespace}-private-files`);
  app.use('/api', createAuthorizationSnapshotGuard(options));
  app.use('/api/auth', createAuthRouter({ prisma, loginRateLimit: false }));
  app.use('/api/v1/admin', createAdminRouter(options));
  app.use('/api/v1/relations', createRelationsRouter(options));
  app.use('/api/v1/products', createProductsRouter({ ...options, uploadDir: path.join(privateFilesDir, 'catalog') }));
  app.use('/api/v1/orders', createOrdersRouter(options));
  app.use('/api/v2/orders', createOrdersV2Router(options));
  app.use('/api/v1/inventory', createInventoryRouter(options));
  app.use('/api/v1/samples', createSampleRouter({ ...options, privateFilesDir }));
  app.use('/api/v1/qc', createQcRouter({ ...options, privateFilesDir }));
  const auth = createAuthService();
  for (const account of Object.values(masters.cast)) {
    const login = status(await supertest(app).post('/api/auth/login').send({ identifier: account.email, password: account.password }), 200, `actual login ${account.key}`);
    expect(login.user.id).toBe(account.id); expect(typeof login.token).toBe('string');
    const actor = auth.verifyToken(login.token); // Verify the real login response, never sign a fixture token.
    expect(actor.userId).toBe(account.id); expect(actor.roleIds).toEqual([account.roleId]);
    expect(actor.authorizationLoaded).toBe(true);
    const me = status(await supertest(app).get('/api/auth/me').set('Authorization', `Bearer ${login.token}`), 200, `fresh authguard ${account.key}`).user;
    expect(me.id).toBe(account.id); expect(me.roleIds).toEqual([account.roleId]);
    expect(me.departmentIds).toContain(account.departmentId);
    sessions[account.key] = { token: login.token, actor, permissions: me.permissions };
  }
}, 180_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('native dev scenario master cast and catalogs (fresh isolated PG/actual HTTP)', () => {
  it('M01 provisions 21 real identities, precise current sharing/authority and 35+35 honest readable product profiles without business verdicts', async () => {
    expect(afterMasters).toEqual(beforeMasters);
    expect(Object.keys(sessions)).toHaveLength(21);
    expect(await prisma.relation.count({ where: { id: { in: masters.catalog.customers.map(row => row.id) }, category: 'Customer', isOrganization: true } })).toBe(35);
    expect(await prisma.relation.count({ where: { id: { in: masters.catalog.suppliers.map(row => row.id) }, category: 'Supplier', isOrganization: true } })).toBe(35);
    expect(await prisma.productAsset.count({ where: { id: { in: masters.catalog.fabricAssets.map(row => row.id) }, mainCategory: 'Fabric' } })).toBe(35);
    expect(await prisma.productAsset.count({ where: { id: { in: masters.catalog.garmentAssets.map(row => row.id) }, mainCategory: 'Garment' } })).toBe(35);
    const share = createTeamShareService(prisma), permission = createPermissionService({ prisma });
    for (const team of masters.businessTeams) {
      const stored = await prisma.team.findUniqueOrThrow({ where: { id: team.id }, include: { members: true, grants: true } });
      expect((stored.metadata as any).businessFamily).toBe(team.businessFamily);
      expect(stored.members.filter(row => row.leftAt === null).map(row => row.userId).sort()).toEqual(team.memberIds.slice().sort());
      expect(stored.grants.filter(row => row.revokedAt === null).map(row => row.entityId).sort()).toEqual([...team.customerIds, ...team.supplierIds].sort());
      expect(stored.grants.every(row => row.permission === 'read+followup')).toBe(true);
      const sales = actorKey(team.salespersonId), actor = sessions[sales].actor;
      expect((await permission.getDataScopeResolver(actor, 'orders')).rule.kind).toBe('team');
      for (const customerId of team.customerIds) expect(await share.hasBizReadAccess(actor, customerId, { fresh: true })).toBe(true);
      for (const foreign of masters.businessTeams.filter(row => row.id !== team.id)) {
        for (const customerId of foreign.customerIds) expect(await share.hasBizReadAccess(actor, customerId, { fresh: true }), `${team.key} cannot follow ${foreign.key} customers`).toBe(false);
      }
    }
    for (const team of masters.professionalTeams) {
      const grants = await prisma.teamDataGrant.findMany({ where: { teamId: team.id, revokedAt: null } });
      expect(grants.every(row => row.permission === 'read')).toBe(true);
      expect(grants).toHaveLength(team.businessFamily === 'fabric' ? 28 : team.businessFamily === 'garment' ? 42 : 70);
    }
    for (const [key, module] of [['fabricQc', 'qc'], ['financeOperator', 'finance'], ['logistics1', 'shipping']] as const)
      expect((await permission.getDataScopeResolver(sessions[key].actor, module)).rule.kind).toBe('all');
    const roster = status(await request('owner', 'get', '/api/v1/admin/order-approval-authorities')).assignments;
    for (const family of ['fabric', 'garment'] as const) expect(roster.filter((row: any) => row.businessLine === family).map((row: any) => row.userId).sort()).toEqual(masters.approvalAuthorities[family].slice().sort());
    expect(roster.some((row: any) => row.userId === masters.cast.financeApprover.id)).toBe(false);
    status(await request('fabric1Sales', 'get', '/api/v1/admin/order-approval-authorities'), 403, 'a business account is not an administrator');
    const routing = createApprovalRoutingService({ prisma });
    expect((await routing.resolveReviewerByDepartment(masters.cast.financeOperator.id)).reviewerId).toBe(masters.cast.financeApprover.id);
    expect(masters.cast.financeApprover.roleId).toBe(SYSTEM_ROLE_IDS.ADMIN); expect(masters.cast.financeOperator.roleId).toBe(SYSTEM_ROLE_IDS.FINANCE);
    expect(masters.cast.financeApprover.id).not.toBe(masters.cast.financeOperator.id);

    for (const catalog of [...masters.catalog.fabricAssets, ...masters.catalog.garmentAssets]) {
      const asset = status(await request(catalog.businessFamily === 'fabric' ? 'fabric1Sales' : 'garment1Sales', 'get', `/api/v1/products/assets/${encodeURIComponent(catalog.id)}`), 200, `read imported ${catalog.sku}`).asset;
      expect(asset).toMatchObject({ id: catalog.id, source: 'other', sourceDetail: catalog.sourceDetail });
      expect(asset.sourceDevelopmentCaseId).toBeNull(); expect(asset.sourceSampleBatchId).toBeNull(); expect(asset.sourceSampleVersionId).toBeNull();
      if (catalog.businessFamily === 'fabric') {
        expect(asset.fabricProfile).toMatchObject({ productAssetId: catalog.id, millOrganizationId: catalog.factoryRelationId, moqValue: 800 });
        expect(asset.fabricProfile.stockQuantity).toBeNull(); expect(asset.fabricProfile.factoryMoqValue).toBeNull();
      } else expect(asset.garmentProfile).toMatchObject({ productAssetId: catalog.id, factoryRelationId: catalog.factoryRelationId, customerRelationId: catalog.customerRelationId, moqValue: 200 });
    }
    const warehouses = status(await request('fabric1Sales', 'get', '/api/v1/inventory/warehouses')).warehouses;
    expect(warehouses.map((row: any) => row.id).sort()).toEqual(masters.catalog.warehouses.map(row => row.id).sort());
    for (const warehouse of warehouses) expect(await prisma.relation.findUnique({ where: { id: warehouse.profile.custodianRelationId } })).toMatchObject({ isOrganization: true });
    expect(await businessCounts()).toEqual(beforeMasters);
  }, 180_000);

  it('M02 uses each actual business group to create/read its own draft and preserves professional scopes without creating stock or quality/payment conclusions', async () => {
    const draftIds: Array<{ id: string; teamKey: string; salesperson: ScenarioActorKey; leader: ScenarioActorKey; customerId: string }> = [];
    for (const team of masters.businessTeams) {
      const salesperson = actorKey(team.salespersonId), leader = actorKey(team.leaderId), customerId = team.customerIds[0];
      const customer = status(await request(salesperson, 'get', `/api/v1/relations/${encodeURIComponent(customerId)}`)).relation;
      expect(customer).toMatchObject({ id: customerId, isOrganization: true, category: 'Customer' });
      expect(sessions[salesperson].permissions).toEqual(expect.arrayContaining(['inventory:write', 'sample:room:write', 'orders:write']));
      expect(sessions[salesperson].permissions).not.toContain('qc:inspect');
      const draft = status(await request(salesperson, 'post', '/api/v1/orders', { id: `${masters.namespace}-draft-${team.key}`, type: team.businessFamily === 'fabric' ? 'Fabric' : 'Garment',
        businessLine: team.businessFamily, customer: customer.name, customerRelationId: customer.id, product: `${team.name}原生草稿权限验收`,
        quantity: team.businessFamily === 'fabric' ? '1000' : '500', unit: team.businessFamily === 'fabric' ? 'M' : 'PC',
        quoteAmount: 0, status: 'Pending', dueDate: '2026-12-08', currency: customer.currency }), 200, `native ${team.key} draft`).order;
      expect(draft).toMatchObject({ customerRelationId: customer.id, ownerId: team.salespersonId, source: 'manual', status: 'Pending' });
      draftIds.push({ id: draft.id, teamKey: team.key, salesperson, leader, customerId });
      expect(status(await request(leader, 'get', `/api/v1/orders/${encodeURIComponent(draft.id)}`)).order.id).toBe(draft.id);
      expect(status(await request(salesperson, 'get', `/api/v2/orders/${encodeURIComponent(draft.id)}`)).order.id).toBe(draft.id);
      // Invalid facts prove the real write gate is reached without seeding stock
      // or an intake. Current business actors have these operational scopes.
      status(await request(salesperson, 'post', '/api/v1/inventory/movements', {}), 400, 'actual business inventory gate, missing physical fact');
      status(await request(salesperson, 'post', '/api/v1/samples/room/items', {}), 400, 'actual business sample gate, missing physical fact');
      status(await request(salesperson, 'post', `/api/v1/qc/assignments/${masters.namespace}-unknown/start`, {}), 403, 'business requester cannot perform professional inspection');
    }
    for (const draft of draftIds) {
      for (const foreign of draftIds.filter(row => row.teamKey !== draft.teamKey)) {
        status(await request(foreign.salesperson, 'get', `/api/v1/orders/${encodeURIComponent(draft.id)}`), 404, `${foreign.teamKey} cannot read ${draft.teamKey} order source`);
        status(await request(foreign.salesperson, 'get', `/api/v2/orders/${encodeURIComponent(draft.id)}`), 404, 'V2 uses the same actual group boundary');
      }
      for (const key of ['financeOperator', 'fabricQc', 'logistics1'] as const)
        expect(status(await request(key, 'get', `/api/v1/orders/${encodeURIComponent(draft.id)}`)).order.customerRelationId).toBe(draft.customerId);
    }
    for (const qc of ['fabricQc', 'garmentQc1', 'garmentQc2'] as const) {
      expect(sessions[qc].permissions).toContain('qc:inspect');
      status(await request(qc, 'get', '/api/v1/qc/assignments'));
      status(await request(qc, 'post', `/api/v1/qc/assignments/${masters.namespace}-unknown/start`, {}), 404, 'professional scope reaches an absent assignment, never invents a report');
    }
    expect(await prisma.order.count({ where: { id: { in: draftIds.map(row => row.id) }, status: 'Pending' } })).toBe(5);
    expect(await businessCounts()).toEqual(beforeMasters);
  }, 180_000);
});
