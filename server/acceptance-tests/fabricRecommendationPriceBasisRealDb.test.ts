/** Actual recommendation router/service + fresh authorization + isolated PG.
 * Minimal synthetic source price facts/actors only; no seed or shared DB.
 * Does not prove real-company marketing UAT/customer-specific quote policy.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createFabricRecommendationRouter } from '../src/products/fabricRecommendationRoute';

const prefix = `acceptance-recommendation-basis-${randomUUID()}`;
const path = '/api/v1/fabric-recommendations';
const auth = createAuthService();
let prisma: PrismaClient | undefined, sequence = 0;
const db = () => { if (!prisma) throw Error('isolated recommendation fixture not initialized'); return prisma; };
const diagnostic = (value: unknown) => JSON.stringify(value, (_k, item) => typeof item === 'bigint' ? item.toString() : item);
async function actor(label: string, scopes = ['products:read', 'products:write'], owner = false, ceiling?: string[]) {
  const id = `${prefix}-${++sequence}-${label}`, roleId = `${id}-role`;
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id, displayName: 'Synthetic recommendation actor', status: 'active' } });
    await tx.role.create({ data: { id: roleId, name: 'Synthetic recommendation role', isSystem: false } });
    await tx.userRole.create({ data: { id: `${id}-assignment`, userId: id, roleId } });
    for (const scope of scopes) {
      const permission = await tx.permission.upsert({ where: { scope }, update: {}, create: { id: `${prefix}-permission-${scope}`, scope } });
      await tx.rolePermission.create({ data: { id: `${id}-grant-${scope}`, roleId, permissionId: permission.id } });
    }
    if (owner) {
      await tx.role.upsert({ where: { id: 'role-super-admin' }, update: {}, create: { id: 'role-super-admin', name: 'Synthetic canonical owner', isSystem: true } });
      await tx.userRole.create({ data: { id: `${id}-owner`, userId: id, roleId: 'role-super-admin' } });
    }
  });
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(id); expect(current).not.toBeNull();
  if (!owner) expect(current!.scopes).toEqual([...scopes].sort());
  return { id, roleId, token: auth.signToken({ userId: id, roles: current!.legacyRoleCodes, roleIds: current!.roleIds,
    departmentIds: current!.departmentIds, permissions: current!.scopes, authorizationLoaded: true, ...(ceiling ? { permissionCeiling: ceiling } : {}) }) };
}
type Actor = Awaited<ReturnType<typeof actor>>;
function app() {
  const result = express(); result.use(express.json()); result.use(createAccountStatusGuard(db()));
  result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  result.use(path, createFabricRecommendationRouter({ prisma: db(), requireAuth: true, apiKeys: new Set() })); return result;
}
type Price = { label: string; type: string; amount: string; time: number; currency?: string; unit?: string | null; customer?: string | null };
async function source(label: string, prices: Price[]) {
  const id = `${prefix}-product-${++sequence}-${label}`, season = `${id}-season`;
  await db().$transaction(async tx => {
    await tx.productAsset.create({ data: { id, sku: id, name: id, mainCategory: 'Fabric', subCategoryId: 'uncategorized', season, cost: null, status: 'Development', updatedAt: 1n } });
    await tx.fabricProfile.create({ data: { id: `${id}-profile`, productAssetId: id, articleNo: id, weightValue: 240, weightUnit: 'gsm', weightValueGsm: 240, updatedAt: 1n } });
    await tx.fabricPriceHistory.createMany({ data: prices.map(price => ({ id: `${id}-${price.label}`, productAssetId: id, priceType: price.type,
      amount: price.amount, currency: price.currency ?? 'USD', unit: price.unit === undefined ? 'M' : price.unit,
      customerOrganizationId: price.customer ?? null, updatedAt: BigInt(price.time) })) });
  });
  return { id, season };
}
async function run(who: Actor, input: object) {
  const response = await request(app()).post(`${path}/recommend`).set('Authorization', `Bearer ${who.token}`).send(input);
  expect(response.status, diagnostic(response.body)).toBe(201); return response.body.item;
}
async function read(who: Actor, id: string) {
  const response = await request(app()).get(`${path}/${id}`).set('Authorization', `Bearer ${who.token}`);
  expect(response.status, diagnostic(response.body)).toBe(200); return response.body.item;
}
const resultFor = (item: any, id: string) => { const row = item.results.find((r: any) => r.productAssetId === id); expect(row, `actual scored source ${id}`).toBeTruthy(); return row; };

describe.sequential('recommendation commercial source/unit/history boundaries in real PG', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || ''), name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME,
      directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true); expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe(port); expect(url.pathname).toBe(`/${name}`); expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/);
    expect(Boolean(directory)).toBe(true); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
      SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
    `;
    expect(identity, 'verify actual PG identity BEFORE fixture writes').toEqual([{ name, directory, port: Number(port) }]);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('FR01 real recommendation by a non-cost-viewer uses general customer source only, never newest purchase/sample/cutting/other-customer price', async () => {
    const who = await actor('general-source'); const product = await source('general-source', [
      { label: 'general-price', type: 'customer', amount: '13.5', time: 100 },
      { label: 'factory', type: 'factory', amount: '666666.25', time: 999 },
      { label: 'sample', type: 'sample', amount: '666666.5', time: 998 },
      { label: 'cutting', type: 'cutting', amount: '666666.75', time: 997 },
      { label: 'other-customer', type: 'customer', amount: '666666.9', time: 996, customer: `${prefix}-other-customer` },
    ]);
    const item = await run(who, { season: product.season, budgetMin: 600000, budgetMax: 700000, currency: 'USD', budgetUnit: 'M', limit: 50 });
    const row = resultFor(item, product.id);
    expect(row).toMatchObject({ score: 30, latestPrice: 13.5, priceUnit: 'M', budgetMatchStatus: 'outside', priceBasis: {
      priceType: 'customer', audience: 'general', customerOrganizationId: null, sourcePriceId: `${product.id}-general-price`, sourceUpdatedAt: '100', amount: 13.5 } });
    expect(JSON.stringify(row)).not.toContain('666666'); expect(item.snapshotStatus).toBe('verified_commercial');
    const stored = await db().fabricRecommendation.findUniqueOrThrow({ where: { id: item.id } });
    expect((stored.results as any[]).find(r => r.productAssetId === product.id)).toEqual(row);
    expect((await db().fabricPriceHistory.findUniqueOrThrow({ where: { id: `${product.id}-factory` } })).amount.toString()).toBe('666666.25');
  });
  it('FR02 real M/YD/unknown-unit prices are distinct; same-unit historical customer source wins with no price conversion', async () => {
    const who = await actor('units'); const product = await source('units', [
      { label: 'old-M', type: 'customer', amount: '13.5', time: 100 }, { label: 'new-YD', type: 'customer', amount: '100', time: 200, unit: 'YD' },
      { label: 'newest-unknown', type: 'customer', amount: '999', time: 300, unit: null }]);
    const meters = resultFor(await run(who, { season: product.season, budgetMin: 10, budgetMax: 15, budgetUnit: '米', limit: 50 }), product.id);
    expect(meters).toMatchObject({ latestPrice: 13.5, score: 60, budgetMatchStatus: 'matched', priceBasis: { sourcePriceId: `${product.id}-old-M`, unit: 'M' } });
    const yards = resultFor(await run(who, { season: product.season, budgetMin: 10, budgetMax: 15, budgetUnit: 'YD', limit: 50 }), product.id);
    expect(yards).toMatchObject({ latestPrice: 100, score: 30, budgetMatchStatus: 'outside', priceBasis: { sourcePriceId: `${product.id}-new-YD`, unit: 'YD' } });
  });
  it('FR03 missing budget unit and unknown commercial unit are explicitly unevaluated; no implicit M or manufactured zero', async () => {
    const who = await actor('unit-missing'), product = await source('unit-missing', [{ label: 'unknown-unit', type: 'customer', amount: '13.5', time: 100, unit: null }]);
    const unspecified = await run(who, { season: product.season, budgetMin: 10, budgetMax: 15, limit: 50 });
    expect(unspecified.budgetScoringStatus).toBe('unit_required'); expect(unspecified.criteria.budgetUnit).toBeNull();
    expect(resultFor(unspecified, product.id)).toMatchObject({ score: 30, latestPrice: 13.5, priceUnit: null, budgetMatchStatus: 'unit_required' });
    const mismatch = await run(who, { season: product.season, budgetMin: 10, budgetMax: 15, budgetUnit: 'M', limit: 50 });
    expect(resultFor(mismatch, product.id)).toMatchObject({ score: 30, latestPrice: 13.5, budgetMatchStatus: 'unit_mismatch' });
  });
  it('FR04 purchase-only source has unknown commercial price and contributes no budget score; explicit customer zero still remains a real zero', async () => {
    const who = await actor('unknown-zero'), unknown = await source('unknown', [{ label: 'factory-only', type: 'factory', amount: '13.5', time: 100 }]);
    const item = await run(who, { season: unknown.season, budgetMin: 10, budgetMax: 15, budgetUnit: 'M', limit: 50 });
    expect(resultFor(item, unknown.id)).toMatchObject({ latestPrice: null, priceBasis: null, score: 30, budgetMatchStatus: 'price_unknown' });
    expect(item.priceAvailability.unknownCommercialPriceCount).toBeGreaterThanOrEqual(1); // Never assume this shared isolated fixture has only our profiles.
    const zero = await source('zero', [{ label: 'commercial-zero', type: 'customer', amount: '0', time: 100 }]);
    const zeroRow = resultFor(await run(who, { season: zero.season, budgetMin: 0, budgetMax: 0, budgetUnit: 'M', limit: 50 }), zero.id);
    expect(zeroRow).toMatchObject({ latestPrice: 0, score: 60, budgetMatchStatus: 'matched', priceBasis: { amount: 0 } });
  });
  it('FR05 real legacy JSON remains unchanged while list/detail suppress anonymous cost-derived money/reasons/rank/membership for reader and capped owner', async () => {
    const who = await actor('legacy-reader', ['products:read']), owner = await actor('legacy-owner', ['products:read', 'sensitive:cost'], true, ['products:read']);
    const original = await db().fabricRecommendation.create({ data: { id: `${prefix}-legacy`, criteria: { budgetMin: 600000, budgetMax: 700000, currency: 'USD' },
      results: [{ productAssetId: `${prefix}-secret-membership`, sku: 'SECRET-MEMBERSHIP', name: 'Secret', score: 30, latestPrice: 666666.25, reasons: ['预算内 666666.25 USD'] }],
      createdBy: who.id, createdAt: BigInt(Date.now()) } });
    for (const subject of [who, owner]) {
      const list = await request(app()).get(path).query({ limit: 200 }).set('Authorization', `Bearer ${subject.token}`); expect(list.status).toBe(200);
      const listed = list.body.items.find((r: any) => r.id === original.id); expect(listed).toBeTruthy();
      for (const row of [listed, await read(subject, original.id)]) {
        expect(row.snapshotStatus).toBe('legacy_unverified'); expect(row.snapshotMessage).toContain('原始记录保留'); expect(row.results).toEqual([]); expect(row.priceAvailability).toBeNull();
        expect(JSON.stringify(row)).not.toContain('666666.25'); expect(JSON.stringify(row)).not.toContain('SECRET-MEMBERSHIP');
      }
    }
    expect(await db().fabricRecommendation.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  });
  it('FR06 server ignores body provenance injection; verified commercial snapshot stays historical after source price changes and old-session write revocation', async () => {
    const who = await actor('provenance'), product = await source('provenance', [{ label: 'general', type: 'customer', amount: '13.5', time: 100 }]);
    const item = await run(who, { season: product.season, budgetMin: 10, budgetMax: 15, currency: ' usd ', budgetUnit: 'meters',
      recommendationSchemaVersion: 999, commercialPriceAvailability: { candidateCount: 0 }, priceBasis: { priceType: 'factory', amount: 999 }, limit: 50 });
    const stored = await db().fabricRecommendation.findUniqueOrThrow({ where: { id: item.id } });
    expect(stored.criteria).toMatchObject({ recommendationSchemaVersion: 2, currency: 'USD', budgetUnit: 'M' }); expect(stored.criteria).not.toHaveProperty('priceBasis');
    await db().fabricPriceHistory.update({ where: { id: `${product.id}-general` }, data: { amount: '99', updatedAt: 200n } });
    const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'products:write' } });
    await db().rolePermission.deleteMany({ where: { roleId: who.roleId, permissionId: permission.id } });
    const historical = await read(who, item.id); expect(historical.snapshotStatus).toBe('verified_commercial'); expect(resultFor(historical, product.id)).toMatchObject({ latestPrice: 13.5, score: 60 });
    expect(await db().fabricRecommendation.findUniqueOrThrow({ where: { id: item.id } })).toEqual(stored);
    const before = await db().fabricRecommendation.findMany({ where: { createdBy: who.id }, orderBy: { id: 'asc' } });
    const denied = await request(app()).post(`${path}/recommend`).set('Authorization', `Bearer ${who.token}`).send({ season: product.season });
    expect(denied.status, diagnostic(denied.body)).toBe(403); expect(await db().fabricRecommendation.findMany({ where: { createdBy: who.id }, orderBy: { id: 'asc' } })).toEqual(before);
  });
});
