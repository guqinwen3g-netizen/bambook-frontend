// Signed HTTP with storage substitutes: fault honesty and source completeness,
// not proof of current PostgreSQL grants or a completed native business journey.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { authHeader } from '../../__tests__/authTestHelper';
import { createDevelopmentRouter } from '../route';
import { resolveConfirmedSource } from '../convertService';

const privateFault = 'synthetic private SQL detail must not reach the page';
function makeOutputs() {
  const seals = [{ id: 'SEAL-1', developmentCaseId: 'DEV-1', status: 'converted', sealCode: 'SEAL-001', convertedProductAssetId: 'ASSET-1' }];
  const samples = [{ id: 'SAMPLE-1', sourceCaseId: 'DEV-1', status: 'approved', code: 'SAMPLE-001', type: 'pp', productAssetId: 'ASSET-1' }];
  const asset = { id: 'ASSET-1', sku: 'ACTUAL-001', name: 'Actual confirmed garment', mainCategory: 'garment', deletedAt: null };
  const db = {
    sealSample: { findMany: vi.fn(async () => seals) },
    sample: { findMany: vi.fn(async () => samples) },
    productAsset: { findMany: vi.fn(async () => [asset]) },
  };
  const app = express();
  app.use('/api/v1/development', createDevelopmentRouter({ prisma: db as any, requireAuth: false, apiKeys: new Set() }));
  return { app, db };
}
describe('confirmed output reads keep absence separate from failed storage', () => {
  it('returns the actual seal and sample with their real linked asset', async () => {
    const f = makeOutputs();
    const response = await request(f.app).get('/api/v1/development/DEV-1/outputs').set(authHeader());
    expect(response.status).toBe(200);
    expect(response.body.outputs.map((row: any) => [row.confirmedSourceType, row.confirmedSourceId, row.productAsset.id]))
      .toEqual([['SealSample', 'SEAL-1', 'ASSET-1'], ['Sample', 'SAMPLE-1', 'ASSET-1']]);
    expect(f.db.productAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['ASSET-1'] }, deletedAt: null } }));
  });
  it.each(['sealSample', 'sample', 'productAsset'] as const)('a real %s query rejection returns 500, never an empty success', async delegate => {
    const f = makeOutputs();
    f.db[delegate].findMany.mockRejectedValueOnce(new Error(privateFault));
    const response = await request(f.app).get('/api/v1/development/DEV-1/outputs').set(authHeader());
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: expect.any(String) } });
    expect(JSON.stringify(response.body)).not.toContain(privateFault);
    expect(response.body).not.toHaveProperty('outputs');
  });
  it('a successful empty asset read exposes no selectable dangling seal/sample', async () => {
    const f = makeOutputs(); f.db.productAsset.findMany.mockResolvedValueOnce([]);
    const response = await request(f.app).get('/api/v1/development/DEV-1/outputs').set(authHeader());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, outputs: [] });
  });
});

describe('confirmed source resolution cannot fabricate a usable version', () => {
  it.each(['SealSample', 'Sample'])('%s query rejection reaches the caller instead of becoming missing data', async type => {
    const fault = new Error(privateFault);
    const db = { sealSample: { findFirst: vi.fn().mockRejectedValue(fault) }, sample: { findFirst: vi.fn().mockRejectedValue(fault) } };
    await expect(resolveConfirmedSource({ prisma: db as any, confirmedSourceType: type, confirmedSourceId: 'ACTUAL-1' })).rejects.toBe(fault);
  });
  it.each([null, { id: 'ASSET-1', deletedAt: 1n }])('an approved sample with an absent or deleted asset cannot yield an empty spec snapshot', async asset => {
    const db = { sample: { findFirst: vi.fn(async () => ({ id: 'SAMPLE-1', code: 'SAMPLE-001', status: 'approved', productAssetId: 'ASSET-1' })) }, productAsset: { findUnique: vi.fn(async () => asset) } };
    const resolved = await resolveConfirmedSource({ prisma: db as any, confirmedSourceType: 'Sample', confirmedSourceId: 'SAMPLE-1' });
    expect(resolved).toEqual({ ok: false, error: { code: 'CONFIRMED_SOURCE_NOT_FOUND', message: expect.any(String), status: 404 } });
  });
  it('a linked asset query failure cannot yield an empty spec snapshot', async () => {
    const fault = new Error(privateFault);
    const db = { sample: { findFirst: vi.fn(async () => ({ id: 'SAMPLE-1', code: 'SAMPLE-001', status: 'approved', productAssetId: 'ASSET-1' })) }, productAsset: { findUnique: vi.fn().mockRejectedValue(fault) } };
    await expect(resolveConfirmedSource({ prisma: db as any, confirmedSourceType: 'Sample', confirmedSourceId: 'SAMPLE-1' })).rejects.toBe(fault);
  });
  it('unknown types cannot silently resolve a sample and be stored as a made-up source type', async () => {
    const findFirst = vi.fn();
    const resolved = await resolveConfirmedSource({ prisma: { sample: { findFirst } } as any, confirmedSourceType: 'invented', confirmedSourceId: 'SAMPLE-1' });
    expect(resolved).toEqual({ ok: false, error: { code: 'INVALID_INPUT', message: expect.any(String), status: 400 } });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
