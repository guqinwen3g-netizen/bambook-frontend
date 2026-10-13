/** Actual pricing routes/current grants/order scope against private PostgreSQL.
 * Projection rows are synthetic inputs; no full business-journey or UI claim. */
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createPricingRouter } from '../src/pricing/pricingRoute';

const prefix = `acceptance-pricing-visibility-${randomUUID()}`;
let prisma: PrismaClient | undefined, index = 0;
const db = () => { if (!prisma) throw Error('Private pricing fixture not initialized'); return prisma; };
async function fixture() {
  const id = `${prefix}-${++index}`, other = `${id}-other`, roleId = `${id}-configured-role`;
  for (const userId of [id, other]) await db().userAccount.create({ data: { id: userId, displayName: 'Synthetic private pricing actor', status: 'active' } });
  await db().role.create({ data: { id: roleId, name: 'Explicit limited pricing grants', isSystem: false } });
  await db().userRole.create({ data: { id: `${id}-role`, roleId, userId: id } });
  for (const scope of ['pricing:read', 'pricing:write']) {
    const permission = await db().permission.upsert({ where: { scope }, update: {}, create: { id: `${prefix}-${scope}`, scope } });
    await db().rolePermission.create({ data: { id: `${id}-${scope}`, roleId, permissionId: permission.id } });
  }
  const now = BigInt(Date.now());
  const ownOrder = `${id}-own-order`, hiddenOrder = `${id}-hidden-order`;
  for (const [orderId, ownerId] of [[ownOrder, id], [hiddenOrder, other]]) {
    await db().order.create({ data: { id: orderId, ownerId, customer: 'Synthetic visibility customer', product: 'Synthetic order', type: 'Fabric', quantity: 10, status: 'Confirmed', dueDate: '2026-10-01', quoteAmount: 100, updatedAt: now } });
    await db().orderProfitSheet.create({ data: { id: `${orderId}-sheet`, orderId, salesRevenue: 100, purchaseCost: 50, grossProfit: 50, grossMargin: 50, details: { costEvidence: { version: 2, calculatedAt: '2026-10-01', status: 'complete', committedAmountCny: 50, acceptedAmountCny: 50, paidPrincipalCny: 50, actualCostCny: 50, actualProfitCny: 50, pendingReasons: [] } }, generatedAt: now, createdAt: now, updatedAt: now } });
  }
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(id);
  expect(current).not.toBeNull();
  const payload = { userId: id, roles: current!.legacyRoleCodes, roleIds: current!.roleIds, permissions: current!.scopes, departmentIds: current!.departmentIds, authorizationLoaded: true as const };
  const token = createAuthService().signToken(payload);
  const app = express(); app.use(express.json()); app.use('/api/v1/pricing', createPricingRouter({ prisma: db(), requireAuth: true, apiKeys: new Set() }));
  return { id, ownOrder, hiddenOrder, payload, token, app };
}
const header = (token: string) => ({ Authorization: `Bearer ${token}` });

describe.sequential('Pricing actual order visibility and current grants', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true);
    expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe(process.env.BAMBOOK_ACCEPTANCE_DB_PORT);
    expect(url.pathname).toBe(`/${process.env.BAMBOOK_ACCEPTANCE_DB_NAME}`); expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/);
    expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`;
    expect(identity).toEqual([{ name: process.env.BAMBOOK_ACCEPTANCE_DB_NAME, directory: process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port: Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) }]);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('PVR01 list applies real order scope before pagination/count and rejects stale stored completeness', async () => {
    const f = await fixture(); const response = await request(f.app).get('/api/v1/pricing/profit-sheets?limit=1&offset=0').set(header(f.token));
    expect(response.status, JSON.stringify(response.body)).toBe(200); expect(response.body.total).toBe(1);
    expect(response.body.items.map((row: any) => row.orderId)).toEqual([f.ownOrder]);
    expect(response.body.items[0].grossProfit).toBeNull(); expect(response.body.items[0].grossMargin).toBeNull();
    expect(response.body.items[0].details.costEvidence).toBeNull();
  });
  it('PVR02 foreign profit detail and cost rings refuse the actual hidden order', async () => {
    const f = await fixture();
    for (const path of [`profit-sheets/order/${f.hiddenOrder}`, `orders/${f.hiddenOrder}/cost-rings`, `orders/${f.hiddenOrder}/commission`]) {
      const response = await request(f.app).get(`/api/v1/pricing/${path}`).set(header(f.token));
      expect(response.status, JSON.stringify(response.body)).toBe(404); expect(response.body.error.code).toBe('NOT_FOUND');
    }
  });
  it('PVR03 foreign delete and generation cannot change or overwrite the hidden projection', async () => {
    const f = await fixture(); const before = await db().orderProfitSheet.findUniqueOrThrow({ where: { orderId: f.hiddenOrder } });
    const removed = await request(f.app).delete(`/api/v1/pricing/profit-sheets/order/${f.hiddenOrder}`).set(header(f.token));
    const generated = await request(f.app).post(`/api/v1/pricing/profit-sheets/generate/${f.hiddenOrder}`).set(header(f.token));
    expect(removed.status).toBe(404); expect(generated.status).toBe(404);
    expect(removed.body.error.code).toBe('NOT_FOUND'); expect(generated.body.error.code).toBe('NOT_FOUND');
    expect(await db().orderProfitSheet.findUniqueOrThrow({ where: { orderId: f.hiddenOrder } })).toEqual(before);
  });
  it('PVR04 revoked current read grant cannot be restored by a stale trusted JWT', async () => {
    const f = await fixture(); await db().rolePermission.delete({ where: { id: `${f.id}-pricing:read` } });
    const response = await request(f.app).get('/api/v1/pricing/profit-sheets').set(header(f.token));
    expect(response.status).toBe(403); expect(response.body.error.code).toBe('FORBIDDEN');
  });
  it('PVR05 a current DB grant cannot exceed the credential permission ceiling', async () => {
    const f = await fixture(); const token = createAuthService().signToken({ ...f.payload, permissionCeiling: ['pricing:read'] });
    const response = await request(f.app).delete(`/api/v1/pricing/profit-sheets/order/${f.ownOrder}`).set(header(token));
    expect(response.status).toBe(403); expect(await db().orderProfitSheet.findUnique({ where: { orderId: f.ownOrder } })).not.toBeNull();
  });
  it('PVR06 soft-deleted actor cannot use an old active-session JWT', async () => {
    const f = await fixture(); await db().userAccount.update({ where: { id: f.id }, data: { deletedAt: BigInt(Date.now()) } });
    const response = await request(f.app).get('/api/v1/pricing/profit-sheets').set(header(f.token));
    expect(response.status).toBe(403); expect(response.body.error.code).toBe('FORBIDDEN');
  });
  it('PVR07 archived source order is absent from list/count and cannot be read by its prior owner', async () => {
    const f = await fixture(); await db().order.update({ where: { id: f.ownOrder }, data: { deletedAt: BigInt(Date.now()) } });
    const response = await request(f.app).get('/api/v1/pricing/profit-sheets').set(header(f.token));
    expect(response.status).toBe(200); expect(response.body.items).toEqual([]); expect(response.body.total).toBe(0);
    const detail = await request(f.app).get(`/api/v1/pricing/profit-sheets/order/${f.ownOrder}`).set(header(f.token)); expect(detail.status).toBe(404);
  });
});
