// Actual pricing router, JWT module guards, permission service and PostgreSQL.
// Synthetic role/record setup is not admin UI or real company-account evidence.
// Tests authoritative NON-EMPTY snapshots; empty-role migration policy is separate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createPricingRouter } from '../src/pricing/pricingRoute';

const prisma = new PrismaClient();
const auth = createAuthService();
beforeAll(async () => {
  if (!process.env.BAMBOOK_ACCEPTANCE_DB_NAME || !process.env.BAMBOOK_ACCEPTANCE_DB_DIR || !process.env.BAMBOOK_ACCEPTANCE_DB_PORT) throw new Error('Isolated acceptance database is required');
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string; directory: string; port: number }>>("SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port");
  expect(rows[0]).toEqual({ name: process.env.BAMBOOK_ACCEPTANCE_DB_NAME, directory: process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port: Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) });
});
afterAll(async () => { await prisma.$disconnect(); });

async function fixture(key: string, scopes: string[]) {
  const id = 'acceptance-pricing-auth-' + key;
  const now = BigInt(Date.now());
  await prisma.role.upsert({ where: { id: 'role-finance' }, create: { id: 'role-finance', name: 'Acceptance finance', isSystem: true }, update: {} });
  // Only our own permission assignments are changed; other files use independent roles.
  await prisma.rolePermission.deleteMany({ where: { id: { startsWith: 'acceptance-pricing-auth-rp-' } } });
  for (const scope of scopes) {
    const permission = await prisma.permission.upsert({ where: { scope }, create: { id: 'acceptance-pricing-auth-perm-' + scope, scope }, update: {} });
    await prisma.rolePermission.create({ data: { id: 'acceptance-pricing-auth-rp-' + scope, roleId: 'role-finance', permissionId: permission.id } });
  }
  await prisma.userAccount.create({ data: { id, displayName: 'Acceptance finance scope fixture', status: 'active' } });
  await prisma.userRole.create({ data: { id: id + '-role', userId: id, roleId: 'role-finance' } });
  const context = await createPermissionService({ prisma }).getUserPermissionContext(id);
  expect(context?.scopes).toEqual([...scopes].sort());
  expect(context?.legacyRoleCodes).toEqual(['finance']);
  const token = auth.signToken({ userId: id, roles: context!.legacyRoleCodes, roleIds: context!.roleIds,
    permissions: context!.scopes, departmentIds: context!.departmentIds });
  const orderId = id + '-order';
  await prisma.order.create({ data: { id: orderId, customer: id, product: 'Acceptance product', type: 'Fabric',
    quantity: 10000, status: 'Pending', dueDate: '2026-11-01', quoteAmount: 1000, currency: 'USD' } });
  const calculationId = id + '-calculation';
  await prisma.pricingCalculation.create({ data: { id: calculationId, orderId, purchaseCostCny: '10.5000',
    refundRate: '0.1300', exchangeRate: '7.0000', profitMargin: '0.1000', commissionRate: '0.0200',
    netUsdCost: '1.3050', profitAmount: '0.1305', commissionAmount: '0.0300', finalUnitPrice: '1.4655',
    quantity: 10000, status: 'Draft', notes: 'before', createdBy: id, createdAt: now, updatedAt: now } });
  const app = express();
  app.use(express.json());
  app.use(createAccountStatusGuard(prisma)); // Preserve the actual composition-root account check.
  app.use('/api/v1/pricing', createPricingRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
  return { id, orderId, calculationId, token, app };
}

describe('acceptance: pricing API obeys non-empty effective authorization', () => {
  it('positive: explicit sensitive grants reveal list/nested fields and explicit write persists', async () => {
    const f = await fixture('allowed', ['pricing:read', 'pricing:write', 'sensitive:cost', 'sensitive:profit', 'sensitive:commission']);
    const list = await request(f.app).get('/api/v1/pricing/calculations').query({ orderId: f.orderId }).set('Authorization', 'Bearer ' + f.token);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: f.calculationId, purchaseCostCny: 10.5, netUsdCost: 1.305,
      profitMargin: 0.1, profitAmount: 0.1305, commissionRate: 0.02, commissionAmount: 0.03 });
    const rings = await request(f.app).get('/api/v1/pricing/orders/' + f.orderId + '/cost-rings').set('Authorization', 'Bearer ' + f.token);
    expect(rings.status).toBe(200);
    // cost-rings is a two-decimal presentation projection; the list above preserves Decimal precision.
    expect(rings.body.item.quoteRing).toMatchObject({ estimateCostCny: 10.5, estimateProfitUsd: 0.13, estimateMarginPct: 0.1 });
    const write = await request(f.app).patch('/api/v1/pricing/calculations/' + f.calculationId).set('Authorization', 'Bearer ' + f.token).send({ notes: 'legitimate update' });
    expect(write.status, JSON.stringify(write.body)).toBe(200);
    expect((await prisma.pricingCalculation.findUniqueOrThrow({ where: { id: f.calculationId } })).notes).toBe('legitimate update');
  });

  it('revoked cost/profit/commission must stay masked in the actual calculation list', async () => {
    const f = await fixture('list-revoked', ['pricing:read']);
    const response = await request(f.app).get('/api/v1/pricing/calculations').query({ orderId: f.orderId }).set('Authorization', 'Bearer ' + f.token);
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    const row = response.body.items[0];
    const actual = { cost: row.purchaseCostCny, netCost: row.netUsdCost, profit: row.profitAmount,
      margin: row.profitMargin, commission: row.commissionAmount, rate: row.commissionRate };
    console.log(JSON.stringify({ probe: 'pricing-list-revoked', actual }));
    expect(actual).toEqual({ cost: null, netCost: null, profit: null, margin: null, commission: null, rate: null });
  });

  it('revoked cost/profit must stay masked inside the actual nested cost-rings response', async () => {
    const f = await fixture('rings-revoked', ['pricing:read']);
    const response = await request(f.app).get('/api/v1/pricing/orders/' + f.orderId + '/cost-rings').set('Authorization', 'Bearer ' + f.token);
    expect(response.status).toBe(200);
    const quote = response.body.item.quoteRing;
    const actual = { cost: quote.estimateCostCny, profit: quote.estimateProfitUsd, margin: quote.estimateMarginPct };
    console.log(JSON.stringify({ probe: 'pricing-rings-revoked', actual }));
    expect(actual).toEqual({ cost: null, profit: null, margin: null });
  });

  it('revoked pricing:write must deny the actual PATCH and leave the PG record unchanged', async () => {
    const f = await fixture('write-revoked', ['pricing:read']);
    const before = await prisma.pricingCalculation.findUniqueOrThrow({ where: { id: f.calculationId } });
    const response = await request(f.app).patch('/api/v1/pricing/calculations/' + f.calculationId).set('Authorization', 'Bearer ' + f.token).send({ notes: 'unauthorized update' });
    const after = await prisma.pricingCalculation.findUniqueOrThrow({ where: { id: f.calculationId } });
    console.log(JSON.stringify({ probe: 'pricing-write-revoked', http: response.status, beforeNotes: before.notes, afterNotes: after.notes }));
    expect(response.status).toBe(403);
    expect(after).toEqual(before);
  });

  it('configured custom-role scopes must enter the existing effective permission context', async () => {
    const id = 'acceptance-pricing-auth-custom';
    const roleId = id + '-role';
    await prisma.userAccount.create({ data: { id, displayName: 'Acceptance custom role', status: 'active' } });
    await prisma.role.create({ data: { id: roleId, name: 'Acceptance custom pricing reader', isSystem: false } });
    await prisma.userRole.create({ data: { id: id + '-assignment', userId: id, roleId } });
    const permission = await prisma.permission.upsert({ where: { scope: 'pricing:read' }, create: { id: id + '-permission', scope: 'pricing:read' }, update: {} });
    await prisma.rolePermission.create({ data: { id: id + '-permission-assignment', roleId, permissionId: permission.id } });
    const context = await createPermissionService({ prisma }).getUserPermissionContext(id);
    const actual = { roleIds: context?.roleIds, scopes: context?.scopes };
    console.log(JSON.stringify({ probe: 'effective-custom-role', actual }));
    expect(actual).toEqual({ roleIds: [roleId], scopes: ['pricing:read'] });
  });
});
