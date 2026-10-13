/** Actual HTTP handlers/pure shared serializer; storage substitutes, not PG evidence. */
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createProductsRouter } from '../route';
import { maskProductCost } from '../productCostVisibility';
import type { TokenPayload } from '../../auth/service';

const secret = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const actor = (scopes: string[], extras: Partial<TokenPayload> = {}): TokenPayload => ({ userId: 'purchase-actor', roles: [], departmentIds: [], permissions: scopes, authorizationLoaded: true, ...extras });
const session = (scopes: string[], extras = {}) => `Bearer ${jwt.sign(actor(scopes, extras), secret)}`;
const initial = () => ({ id: 'purchase-asset', sku: 'PURCHASE-SKU', name: 'Purchase fixture', mainCategory: 'Fabric',
  cost: new Prisma.Decimal('25.1234'), updatedAt: BigInt(1), deletedAt: null, fabricProfile: null, garmentProfile: null, trimmingProfile: null,
  fabricPrices: [
    { id: 'purchase-current', productAssetId: 'purchase-asset', priceType: 'factory', amount: new Prisma.Decimal('8.5'), currency: 'USD', unit: 'M', updatedAt: BigInt(2), deletedAt: null },
    { id: 'purchase-previous', productAssetId: 'purchase-asset', priceType: 'factory', amount: new Prisma.Decimal('8.1'), currency: 'USD', unit: 'M', updatedAt: BigInt(1), deletedAt: null },
    ...['customer', 'sample', 'cutting'].map((priceType, i) => ({ id: `purchase-${priceType}`, productAssetId: 'purchase-asset', priceType,
      amount: new Prisma.Decimal(String(20 + i)), currency: 'USD', unit: 'M', updatedAt: BigInt(2), deletedAt: null })),
  ] });
function fixture() {
  let row: any = initial();
  const prisma: any = {
    productAsset: { findFirst: vi.fn(async () => row), findMany: vi.fn(async () => [row]), count: vi.fn(async () => 1),
      create: vi.fn(async ({ data }: any) => (row = { ...initial(), ...data, fabricPrices: [] })), update: vi.fn(async ({ data }: any) => (row = { ...row, ...data })) },
    // Honour replacement filters: erasing hidden factory history is a failure,
    // even when the client legitimately replaces all customer-price rows.
    fabricPriceHistory: { deleteMany: vi.fn(async ({ where }: any) => { row.fabricPrices = row.fabricPrices.filter((p: any) => where.priceType?.not === p.priceType); return {}; }),
      createMany: vi.fn(async ({ data }: any) => { row.fabricPrices.push(...data); return { count: data.length }; }) },
    fabricCustomerCode: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async ({ data }: any) => ({ id: 'purchase-audit', ...data })) },
    entityReference: { upsert: vi.fn(async () => ({})) }, entityLink: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  const app = express(); app.use(express.json()); const notify = vi.fn();
  app.use('/api/v1/products', createProductsRouter({ prisma, requireAuth: true, apiKeys: new Set(), uploadDir: '/tmp', onDataChange: notify }));
  return { app, prisma, notify, row: () => row };
}
const baseBody = { sku: 'PURCHASE-SKU', name: 'Purchase fixture', mainCategory: 'Fabric' };
const paths = [{ name: 'list', verb: 'get', path: '/assets', array: true }, { name: 'query', verb: 'post', path: '/assets/query', array: true },
  { name: 'detail', verb: 'get', path: '/assets/purchase-asset', array: false }] as const;

describe('shared product cost output contract', () => {
  it.each([null, actor([]), actor(['products:read']), actor(['sensitive:cost'], { roles: ['owner'], permissionCeiling: ['products:read'] })])('deny snapshot %j never exposes actual/factory cost or mutates source', subject => {
    const source = { asset: initial(), garmentProfile: { targetCost: 'USD 25' }, trimmingProfile: { price: '2.5' }, createdAt: new Date(0) };
    const masked = maskProductCost(source, subject);
    expect(masked.asset.cost).toBeNull(); expect(masked.asset.fabricPrices.filter(p => p.priceType === 'factory').map(p => p.amount)).toEqual([null, null]);
    expect(masked.asset.fabricPrices.filter(p => p.priceType !== 'factory').map(p => p.amount.toString())).toEqual(['20', '21', '22']);
    expect(masked.garmentProfile.targetCost).toBe('USD 25'); expect(masked.trimmingProfile.price).toBe('2.5'); expect(masked.createdAt).toBe(source.createdAt);
    expect(source.asset.cost.toString()).toBe('25.1234'); expect(source.asset.fabricPrices[0].amount.toString()).toBe('8.5');
  });
  it('explicit cost grant keeps exact source values and all price types', () => {
    const source = initial(); expect(maskProductCost(source, actor(['products:read', 'sensitive:cost']))).toBe(source);
    expect(source.fabricPrices[0].amount.toString()).toBe('8.5');
  });
});

describe('actual products HTTP purchase-price boundaries', () => {
  for (const path of paths) it.each([{ scopes: ['products:read'], extra: {}, visible: false },
    { scopes: ['products:read', 'sensitive:cost'], extra: {}, visible: true },
    { scopes: ['products:read', 'sensitive:cost'], extra: { roles: ['owner'], permissionCeiling: ['products:read'] }, visible: false }])(`${path.name} masks every factory history under $scopes / $extra`, async ({ scopes, extra, visible }) => {
    const f = fixture(); const call = request(f.app)[path.verb](`/api/v1/products${path.path}`).set('Authorization', session(scopes, extra));
    const res = await (path.verb === 'post' ? call.send({}) : call); expect(res.status).toBe(200);
    const row = path.array ? res.body.assets[0] : res.body.asset;
    expect(row.fabricPrices.filter((p: any) => p.priceType === 'factory').map((p: any) => p.amount)).toEqual(visible ? [8.5, 8.1] : [null, null]);
    expect(row.fabricPrices.filter((p: any) => p.priceType !== 'factory').map((p: any) => p.amount)).toEqual([20, 21, 22]);
    expect(row.cost).toBe(visible ? 25.1234 : null); expect(f.row().fabricPrices[0].amount.toString()).toBe('8.5');
  });
  it.each(['post', 'patch'] as const)('%s without cost authority rejects explicit/default factory rows before all writes', async verb => {
    for (const price of [{ priceType: 'factory', amount: 10 }, { amount: 10 }]) {
      const f = fixture(); const res = await request(f.app)[verb](`/api/v1/products/assets${verb === 'patch' ? '/purchase-asset' : ''}`)
        .set('Authorization', session(['products:write'])).send({ ...baseBody, fabricPrices: [price] });
      expect(res.status).toBe(403); expect(res.body.error).toBe('FORBIDDEN');
      expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(f.prisma.auditLog.create).not.toHaveBeenCalled(); expect(f.notify).not.toHaveBeenCalled();
    }
  });
  it('a hidden factory id cannot be retyped to customer to overwrite its historical identity', async () => {
    const f = fixture(); const res = await request(f.app).patch('/api/v1/products/assets/purchase-asset').set('Authorization', session(['products:write']))
      .send({ fabricPrices: [{ id: 'purchase-current', priceType: 'customer', amount: 10 }] });
    expect(res.status).toBe(403); expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(f.row().fabricPrices[0].amount.toString()).toBe('8.5');
  });
  it.each([{ prices: [] }, { prices: [{ id: 'customer-replacement', priceType: 'customer', amount: 30, currency: 'USD', unit: 'M' }] }])('legitimate customer-only replacement $prices preserves hidden factory history in storage and response masking', async ({ prices }) => {
    const f = fixture(); const original = f.row().fabricPrices.filter((p: any) => p.priceType === 'factory');
    const res = await request(f.app).patch('/api/v1/products/assets/purchase-asset').set('Authorization', session(['products:write'])).send({ fabricPrices: prices });
    expect(res.status).toBe(200); expect(f.prisma.fabricPriceHistory.deleteMany).toHaveBeenCalledWith({ where: { productAssetId: 'purchase-asset', priceType: { not: 'factory' } } });
    expect(f.row().fabricPrices.filter((p: any) => p.priceType === 'factory')).toEqual(original);
    expect(res.body.asset.fabricPrices.filter((p: any) => p.priceType === 'factory').map((p: any) => p.amount)).toEqual([null, null]);
    expect(f.row().fabricPrices.filter((p: any) => p.priceType !== 'factory').length).toBe(prices.length);
    expect(f.prisma.auditLog.create).toHaveBeenCalledTimes(1); expect(f.notify).toHaveBeenCalledTimes(1);
  });
  it.each(['post', 'patch'] as const)('%s authorized unknown factory input cannot be converted to zero, but explicit zero remains valid', async verb => {
    for (const amount of [null, undefined]) {
      const f = fixture(); const res = await request(f.app)[verb](`/api/v1/products/assets${verb === 'patch' ? '/purchase-asset' : ''}`)
        .set('Authorization', session(['products:write', 'sensitive:cost'])).send({ ...baseBody, fabricPrices: [{ priceType: 'factory', amount }] });
      expect(res.status).toBe(400); expect(res.body.error).toBe('INVALID_AMOUNT'); expect(f.prisma.$transaction).not.toHaveBeenCalled();
    }
    const f = fixture(); const res = await request(f.app)[verb](`/api/v1/products/assets${verb === 'patch' ? '/purchase-asset' : ''}`)
      .set('Authorization', session(['products:write', 'sensitive:cost'])).send({ ...baseBody, fabricPrices: [{ priceType: 'factory', amount: 0 }] });
    expect(res.status).toBe(verb === 'post' ? 201 : 200); expect(res.body.asset.fabricPrices[0].amount).toBe(0);
    expect(f.row().fabricPrices[0].amount.toString()).toBe('0');
  });
});
