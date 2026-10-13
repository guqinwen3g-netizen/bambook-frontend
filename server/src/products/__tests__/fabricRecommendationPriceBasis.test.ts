/** Actual route/service/scoring with independent substitute storage. Not PG/UAT. */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { createFabricRecommendationRouter } from '../fabricRecommendationRoute';

const secret = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const path = '/api/v1/fabric-recommendations';
const token = (scopes = ['products:read', 'products:write'], extra = {}) => `Bearer ${jwt.sign({ userId: 'recommendation-actor', roles: [],
  permissions: scopes, authorizationLoaded: true, departmentIds: [], ...extra }, secret)}`;
function price(id: string, type: string, amount: number, updatedAt: number, currency = 'USD', unit: string | null = 'M', customerOrganizationId: string | null = null) {
  return { id, priceType: type, amount, currency, unit, customerOrganizationId, updatedAt: BigInt(updatedAt), deletedAt: null };
}
function fixture(prices = [price('general-customer', 'customer', 13.5, 100)], initial: any[] = []) {
  const rows = initial;
  const source = { id: 'source-profile', productAssetId: 'source-product', weightValue: 240, weightUnit: 'gsm', weightValueGsm: 240, pattern: 'twill', stockStatus: 'in stock', millName: 'Mill', deletedAt: null,
    productAsset: { id: 'source-product', sku: 'SOURCE-SKU', name: 'Source fabric', season: '2026AW', deletedAt: null, fabricPrices: prices, compositionLines: [] } };
  const prisma: any = {
    fabricProfile: { findMany: vi.fn(async ({ include }: any) => {
      const where = include.productAsset.include.fabricPrices.where;
      return [{ ...source, productAsset: { ...source.productAsset, fabricPrices: prices
        .filter(p => p.priceType === where.priceType && p.customerOrganizationId === where.customerOrganizationId && p.deletedAt === where.deletedAt)
        .sort((a, b) => Number(b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id)) } }];
    }) },
    fabricRecommendation: { create: vi.fn(async ({ data }: any) => { const row = { ...data }; rows.push(row); return row; }),
      findMany: vi.fn(async () => rows.filter(r => r.deletedAt === null)), count: vi.fn(async () => rows.filter(r => r.deletedAt === null).length),
      findUnique: vi.fn(async ({ where }: any) => rows.find(r => r.id === where.id) ?? null), update: vi.fn() },
  };
  const app = express(); app.use(express.json()); app.use(path, createFabricRecommendationRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
  return { app, prisma, rows, source };
}
async function run(f: ReturnType<typeof fixture>, criteria: object, auth = token()) {
  const response = await request(f.app).post(`${path}/recommend`).set('Authorization', auth).send(criteria);
  expect(response.status, JSON.stringify(response.body)).toBe(201); return response.body.item;
}

describe('recommendation uses only explicit commercial price facts', () => {
  it('latest factory/sample/cutting/another-customer values cannot replace a general customer price or contribute budget reasons/score', async () => {
    const f = fixture([price('general-customer', 'customer', 13.5, 100), price('purchase-newest', 'factory', 666666.25, 999),
      price('sample-newest', 'sample', 666666.5, 998), price('cutting-newest', 'cutting', 666666.75, 997), price('specific-customer', 'customer', 666666.9, 996, 'USD', 'M', 'other-customer')]);
    const item = await run(f, { season: '2026AW', budgetMin: 600000, budgetMax: 700000, currency: 'USD', budgetUnit: 'M' });
    expect(item.results[0]).toMatchObject({ latestPrice: 13.5, score: 35, budgetMatchStatus: 'outside', priceBasis: { priceType: 'customer', audience: 'general', sourcePriceId: 'general-customer', amount: 13.5, unit: 'M' } });
    expect(JSON.stringify(item)).not.toContain('666666');
    expect(f.prisma.fabricProfile.findMany.mock.calls[0][0].include.productAsset.include.fabricPrices.where).toEqual({ deletedAt: null, priceType: 'customer', customerOrganizationId: null });
  });
  it('same-unit commercial history is chosen before a newer price in another unit, without converting M/YD', async () => {
    const f = fixture([price('new-YD', 'customer', 100, 200, 'USD', 'YD'), price('previous-M', 'customer', 13.5, 100)]);
    const item = await run(f, { budgetMin: 10, budgetMax: 15, currency: 'USD', budgetUnit: 'meters' });
    expect(item.criteria.budgetUnit).toBe('M'); expect(item.results[0]).toMatchObject({ latestPrice: 13.5, score: 35, budgetMatchStatus: 'matched', priceBasis: { sourcePriceId: 'previous-M', sourceUpdatedAt: '100' } });
    expect(item.results[0].reasons).toContain('预算内 13.5 USD / M');
  });
  it.each([{ unit: null, status: 'unit_required' }, { unit: 'unrecognized', status: 'unit_required' }])('missing/unrecognized budget denominator $unit never defaults to meters or contributes a budget score', async ({ unit, status }) => {
    const item = await run(fixture(), { budgetMin: 10, budgetMax: 15, budgetUnit: unit });
    expect(item.budgetScoringStatus).toBe(status); expect(item.results[0].score).toBe(5); expect(item.results[0].budgetMatchStatus).toBe('unit_required');
  });
  it.each([{ currency: 'CNY', unit: 'M', status: 'currency_mismatch' }, { currency: 'USD', unit: 'YD', status: 'unit_mismatch' },
    { currency: 'USD', unit: null, status: 'unit_mismatch' }])('commercial price $currency/$unit remains a distinct fact and does not count as matching USD/M', async ({ currency, unit, status }) => {
    const item = await run(fixture([price('commercial', 'customer', 13.5, 100, currency, unit)]), { budgetMin: 10, budgetMax: 15, currency: 'USD', budgetUnit: 'M' });
    expect(item.results[0]).toMatchObject({ score: 5, latestPrice: 13.5, budgetMatchStatus: status });
  });
  it('missing commercial source leaves price unknown even if purchase/actual/target values are available', async () => {
    const f = fixture([price('purchase', 'factory', 13.5, 200)]); (f.source.productAsset as any).cost = 13.5; (f.source.productAsset as any).targetCost = 13.5;
    const item = await run(f, { season: '2026AW', budgetMin: 10, budgetMax: 15, budgetUnit: 'M' });
    expect(item.results[0]).toMatchObject({ score: 35, latestPrice: null, priceBasis: null, priceUnit: null, budgetMatchStatus: 'price_unknown' });
    expect(item.results[0].reasons).toEqual(['季节匹配 2026AW', '有现货']);
  });
  it('budget-only without a commercial price reports missing coverage even when there are no scored results', async () => {
    const f = fixture([price('purchase', 'factory', 13.5, 200)]); f.source.stockStatus = '';
    const item = await run(f, { budgetMin: 10, budgetMax: 15, budgetUnit: 'M' });
    expect(item.results).toEqual([]); expect(item.priceAvailability).toEqual({ candidateCount: 1, unknownCommercialPriceCount: 1, unmatchedCommercialPriceCount: 0, comparableCommercialPriceCount: 0 });
    expect(item.snapshotStatus).toBe('verified_commercial');
  });
  it('explicit commercial zero remains zero and can match an explicit zero budget', async () => {
    const item = await run(fixture([price('commercial-zero', 'customer', 0, 100)]), { budgetMin: 0, budgetMax: 0, budgetUnit: 'M' });
    expect(item.results[0]).toMatchObject({ latestPrice: 0, score: 35, priceBasis: { amount: 0 }, budgetMatchStatus: 'matched' });
  });
  it('server generates normalized provenance; body markers/private facts are never copied to the stored criteria', async () => {
    const f = fixture(); const item = await run(f, { season: ' 2026AW ', currency: ' usd ', budgetUnit: '米',
      recommendationSchemaVersion: 999, priceBasis: { priceType: 'factory', amount: 999 }, privateCost: 12345 });
    expect(item.snapshotStatus).toBe('verified_commercial'); expect(f.rows[0].criteria).toMatchObject({ recommendationSchemaVersion: 2, season: '2026AW', currency: 'USD', budgetUnit: 'M' });
    expect(f.rows[0].criteria).not.toHaveProperty('privateCost'); expect(f.rows[0].criteria).not.toHaveProperty('priceBasis');
  });
  it('legacy anonymous results are explicitly unverified for read-only and cost-authorized owner alike; SQL-like originals remain untouched', async () => {
    const original = { id: 'legacy-recommendation', criteria: { budgetMin: 600000, budgetMax: 700000, currency: 'USD' },
      results: [{ productAssetId: 'cost-leaking-product', sku: 'COST-LEAKING', name: 'Secret membership', latestPrice: 666666.25, score: 30, reasons: ['预算内 666666.25 USD'] }],
      createdBy: 'historical-actor', createdAt: 1n, deletedAt: null };
    const f = fixture([], [original]);
    for (const session of [token(['products:read']), token(['products:read', 'sensitive:cost'], { roles: ['owner'] })]) {
      const list = await request(f.app).get(path).set('Authorization', session); const detail = await request(f.app).get(`${path}/${original.id}`).set('Authorization', session);
      for (const row of [list.body.items[0], detail.body.item]) {
        expect(row.results).toEqual([]); expect(row.snapshotStatus).toBe('legacy_unverified'); expect(row.snapshotMessage).toContain('原始记录保留');
        expect(JSON.stringify(row)).not.toContain('666666.25'); expect(JSON.stringify(row)).not.toContain('COST-LEAKING');
      }
    }
    expect(original.results[0]).toMatchObject({ latestPrice: 666666.25, score: 30, sku: 'COST-LEAKING' }); expect(f.prisma.fabricRecommendation.update).not.toHaveBeenCalled();
  });
  it('a copied contract marker with factory basis is still unverified; new trusted customer snapshots remain readable after source changes', async () => {
    const f = fixture(); const created = await run(f, { season: '2026AW' });
    const stored = f.rows[0]; f.source.productAsset.fabricPrices[0].amount = 99;
    const valid = await request(f.app).get(`${path}/${created.id}`).set('Authorization', token(['products:read']));
    expect(valid.body.item.snapshotStatus).toBe('verified_commercial'); expect(valid.body.item.results[0].latestPrice).toBe(13.5);
    f.rows.push({ ...stored, id: 'malformed-provenance', results: [{ ...stored.results[0], priceBasis: { ...stored.results[0].priceBasis, priceType: 'factory' } }] });
    const invalid = await request(f.app).get(`${path}/malformed-provenance`).set('Authorization', token(['products:read']));
    expect(invalid.body.item.snapshotStatus).toBe('legacy_unverified'); expect(invalid.body.item.results).toEqual([]);
  });
});
