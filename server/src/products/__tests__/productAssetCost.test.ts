/**
 * Independent actual-cost contract. Unit/HTTP delegate fixtures only; no PG proof.
 * Cost targets do not establish cost, and sensitive:cost is a viewing scope
 * (docs/design/01-产品总览/6. 角色与权限矩阵.md §3.6).
 */
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createProductsRouter } from '../route';
import { parseProductAssetCost, createProductAsset, updateProductAsset } from '../productAssetMutationService';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const base = { id: 'COST-ASSET-1', sku: 'COST-SKU', name: 'Cost fixture', mainCategory: 'Fabric',
  fabricProfile: null, garmentProfile: null, trimmingProfile: null,
  cost: new Prisma.Decimal('125.1234'), updatedAt: BigInt(1), deletedAt: null };

function fixture() {
  let row: any = { ...base };
  const prisma: any = {
    productAsset: {
      findFirst: vi.fn(async () => row),
      findMany: vi.fn(async ({ select }: any = {}) => {
        // Honour selected keys: the exclusivity resolver must not invent a cost field.
        if (select) return [Object.fromEntries(Object.keys(select).map(k => [k, row[k]]))];
        return [row];
      }),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn(async ({ data }: any) => (row = { ...base, ...data })),
      update: vi.fn(async ({ data }: any) => (row = { ...row, ...data })),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'cost-audit' }) },
    fabricCustomerCode: { findMany: vi.fn().mockResolvedValue([]) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  const app = express();
  app.use(express.json());
  const onDataChange = vi.fn();
  app.use('/api/v1/products', createProductsRouter({ prisma, requireAuth: true, apiKeys: new Set(), uploadDir: '/tmp', onDataChange }));
  return { app, prisma, onDataChange, row: () => row };
}

function token(scopes: string[], extra: Record<string, unknown> = {}) {
  return jwt.sign({ userId: 'cost-actor', roles: [], permissions: scopes, authorizationLoaded: true, ...extra }, SECRET);
}
const BODY = { sku: 'COST-SKU', name: 'Cost fixture', mainCategory: 'Fabric' };

describe('actual CNY cost parser (separate from commercial prices)', () => {
  it.each([undefined, null, '', '  '])('unknown %j is null, not zero', (raw) => {
    expect(parseProductAssetCost(raw)).toEqual({ ok: true, value: null });
  });
  it.each([0, '0', '123.4567', ' 25.5000 ', '99999999999999.9999'])('explicit valid cost %j remains exact Decimal', raw => {
    const parsed = parseProductAssetCost(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('valid cost rejected');
    expect(parsed.value).toBeInstanceOf(Prisma.Decimal);
    expect(parsed.value!.equals(new Prisma.Decimal(typeof raw === 'string' ? raw.trim() : raw))).toBe(true);
  });
  it.each([-1, '-1', 'USD 25', 'NaN', NaN, Infinity, true, {}, [], '0x20', '1e2', '0.00001', '100000000000000'])('invalid cost %j is rejected', raw => {
    expect(parseProductAssetCost(raw)).toEqual({ ok: false });
  });
});

describe('shared route/Agent mutation cost writes', () => {
  it('create with only a targetCost/targetPrice leaves actual cost unknown', async () => {
    const { prisma } = fixture();
    const result = await createProductAsset({ prisma, actorId: 'cost-actor', body: { ...BODY, targetPrice: 200, garmentProfile: { targetCost: 'USD 25' } } });
    expect(result.ok).toBe(true);
    expect(prisma.productAsset.create.mock.calls[0][0].data.cost).toBeNull();
    expect(prisma.auditLog.create.mock.calls[0][0].data.detail.after.cost).toBeNull();
  });
  it('omitted update leaves the independently confirmed cost unchanged', async () => {
    const { prisma, row } = fixture();
    const result = await updateProductAsset({ prisma, actorId: 'cost-actor', assetId: base.id, patch: { name: 'Renamed', targetCost: '999' } });
    expect(result.ok).toBe(true);
    expect(prisma.productAsset.update.mock.calls[0][0].data).not.toHaveProperty('cost');
    expect(row().cost.toString()).toBe('125.1234');
  });
  it.each([null, '', ' '])('explicit clear %j writes null and preserves before cost in mandatory audit', async raw => {
    const { prisma, row } = fixture();
    const result = await updateProductAsset({ prisma, actorId: 'cost-actor', assetId: base.id, patch: { cost: raw } });
    expect(result.ok).toBe(true);
    expect(row().cost).toBeNull();
    const audit = prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.actorId).toBe('cost-actor');
    expect(audit.detail.before.cost).toBe('125.1234');
    expect(audit.detail.after.cost).toBeNull();
  });
  it('invalid cost cannot enter the transaction, write, or emit audit', async () => {
    const { prisma } = fixture();
    const result = await createProductAsset({ prisma, actorId: 'cost-actor', body: { ...BODY, cost: '-1' } });
    expect(result.error?.code).toBe('INVALID_AMOUNT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.productAsset.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

const readPaths = [
  { title: 'list', method: 'get', path: '/assets', key: 'assets', array: true, body: undefined },
  { title: 'query', method: 'post', path: '/assets/query', key: 'assets', array: true, body: {} },
  { title: 'detail', method: 'get', path: `/assets/${base.id}`, key: 'asset', array: false, body: undefined },
] as const;
describe('actual HTTP sensitive cost response boundaries', () => {
  it('actual POST target-only asset returns unknown cost even to a cost viewer', async () => {
    const { app, row } = fixture();
    const res = await request(app).post('/api/v1/products/assets')
      .set('Authorization', `Bearer ${token(['products:write', 'sensitive:cost'])}`)
      .send({ ...BODY, targetPrice: '125.25', targetCost: 'USD 25' });
    expect(res.status).toBe(201);
    expect(res.body.asset.cost).toBeNull(); expect(row().cost).toBeNull();
  });
  it('actual PATCH can clear a confirmed cost while a subsequent unrelated edit preserves null', async () => {
    const { app, row } = fixture();
    const auth = `Bearer ${token(['products:write', 'sensitive:cost'])}`;
    const clear = await request(app).patch(`/api/v1/products/assets/${base.id}`).set('Authorization', auth).send({ cost: null });
    expect(clear.status).toBe(200); expect(clear.body.asset.cost).toBeNull(); expect(row().cost).toBeNull();
    const rename = await request(app).patch(`/api/v1/products/assets/${base.id}`).set('Authorization', auth).send({ name: 'Renamed' });
    expect(rename.status).toBe(200); expect(rename.body.asset.cost).toBeNull(); expect(row().cost).toBeNull();
  });
  it('actual POST explicit zero is stored and shown as zero to the authorized cost viewer', async () => {
    const { app, row } = fixture();
    const res = await request(app).post('/api/v1/products/assets')
      .set('Authorization', `Bearer ${token(['products:write', 'sensitive:cost'])}`).send({ ...BODY, cost: 0 });
    expect(res.status).toBe(201); expect(res.body.asset.cost).toBe(0); expect(row().cost.toString()).toBe('0');
  });
  for (const path of readPaths) {
    it.each([
      { title: 'loaded read-only', jwt: token(['products:read']), visible: false },
      { title: 'loaded cost viewer', jwt: token(['products:read', 'sensitive:cost']), visible: true },
      { title: 'limited owner', jwt: token(['products:read'], { roles: ['owner'], permissionCeiling: ['products:read'] }), visible: false },
    ])(`${path.title}: $title obeys cost visibility without changing raw value`, async ({ jwt: session, visible }) => {
      const { app, row } = fixture();
      const req = request(app)[path.method](`/api/v1/products${path.path}`).set('Authorization', `Bearer ${session}`);
      const res = await (path.body ? req.send(path.body) : req);
      expect(res.status).toBe(200);
      const asset = path.array ? res.body[path.key][0] : res.body[path.key];
      expect(asset.id).toBe(base.id);
      expect(asset.sku).toBe(base.sku);
      expect(asset.cost).toBe(visible ? 125.1234 : null);
      expect(row().cost).toBeInstanceOf(Prisma.Decimal);
      expect(row().cost.toString()).toBe('125.1234');
    });
  }
  it.each(['post', 'patch'] as const)('%s returns masked cost to products writer without sensitive viewer permission', async method => {
    const { app, row } = fixture();
    const path = method === 'post' ? '/assets' : `/assets/${base.id}`;
    const res = await request(app)[method](`/api/v1/products${path}`)
      .set('Authorization', `Bearer ${token(['products:write'])}`)
      .send(method === 'post' ? { ...BODY, cost: '20.1234' } : { cost: '20.1234' });
    expect(res.status).toBe(method === 'post' ? 201 : 200);
    expect(res.body.asset.cost).toBeNull();
    // sensitive:cost is defined as viewing, not an invented new write policy.
    expect(row().cost.toString()).toBe('20.1234');
  });
  it.each(['post', 'patch'] as const)('%s rejects invalid cost before any business/audit write', async method => {
    const { app, prisma, onDataChange } = fixture();
    const path = method === 'post' ? '/assets' : `/assets/${base.id}`;
    const res = await request(app)[method](`/api/v1/products${path}`)
      .set('Authorization', `Bearer ${token(['products:write'])}`)
      .send(method === 'post' ? { ...BODY, cost: '-1' } : { cost: '-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_AMOUNT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.productAsset.create).not.toHaveBeenCalled();
    expect(prisma.productAsset.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });
  it('exclusivity matching preserves selected identity fields and does not add a cost field', async () => {
    const { app, row } = fixture();
    const res = await request(app).post('/api/v1/products/fabric-exclusivity/check')
      .set('Authorization', `Bearer ${token(['products:read'])}`).send({ productAssetId: base.id });
    expect(res.status).toBe(200);
    expect(res.body.matchedAssets[0]).toEqual({ id: base.id, sku: base.sku, name: base.name });
    expect(row().cost.toString()).toBe('125.1234');
  });
});
