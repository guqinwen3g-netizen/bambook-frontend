/** Actual release router/helpers, storage-only projections. No PG acceptance claim. */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { createAuthService } from '../../auth/service';
import { createReleaseRouter } from '../releaseRoute';
const auth = createAuthService();
const actor = { userId: 'read-user', roles: [], departmentIds: [], permissions: ['production:read'], authorizationLoaded: true as const };
function storage(fault?: string, history = false) {
  const scopes = history ? [
    { id: 'parent', orderId: 'order', orderLineId: 'line-1', productionBatchId: null, state: 'invalidated', scopeRevision: 1, quantity: new Prisma.Decimal(1), currentReleaseId: null, unit: 'm' },
    ...['1','2'].map(id => ({ id: 'current-' + id, orderId: 'order', orderLineId: 'line-' + id, productionBatchId: null,
      state: 'ready', scopeRevision: 1, quantity: new Prisma.Decimal(1), currentReleaseId: 'release-' + id, unit: 'm' })),
  ] : [];
  const match = (row: any, where: any): boolean => !where || Object.entries(where).every(([key, value]: any) => {
    if (value === null) return row[key] == null;
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return value.not === null ? row[key] != null : row[key] !== value.not;
    }
    return row[key] === value;
  });
  const unsafe = () => { throw Error('P2010 SQL private-storage-password SELECT secret_column'); };
  const db: any = {
    productionStage: { findMany: async ({ where }: any) => {
      if (fault === 'productionStage' || (fault === 'ppStages' && where.stageKey === 'pp_sample_approved')) return unsafe();
      return where.stageKey === 'manufacturing' ? [{ orderId: 'order', status: 'in_progress', doneAt: 1n }] : [];
    } },
    order: { findMany: async () => fault === 'order' ? unsafe() : [{ id: 'order', poNumber: 'PO', customer: 'Client' }] },
    releaseScope: { findMany: async ({ where }: any) => fault === 'releaseScope' ? unsafe() : scopes.filter(s => match(s, where)),
      findFirst: async ({ where }: any) => scopes.find(s => match(s, where)) ?? null },
    releaseEvent: { findFirst: async () => ({ kind: 'superseded' }) },
    orderLine: { findUnique: async ({ where }: any) => ({ id: where.id, orderId: 'order', quantity: new Prisma.Decimal(1), unit: 'm', specSnapshot: null }) },
    ppSampleRelease: { findUnique: async ({ where }: any) => ({ id: where.id, requestId: where.id.replace('release-', 'request-'), scopeId: where.id.replace('release-', 'current-'), scopeRevision: 1, evidenceSnapshot: null }) },
    releaseRequest: { findUnique: async ({ where }: any) => ({ id: where.id, scopeId: where.id.replace('request-', 'current-'), scopeRevision: 1, specSnapshot: null }) },
  };
  return db;
}
function app(db: any) {
  const result = express(); result.use(express.json());
  result.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  result.use('/api/v1/releases', createReleaseRouter({ prisma: db, requireAuth: true, apiKeys: new Set(['synthetic-key']) }));
  return result;
}
const read = (db: any) => request(app(db)).get('/api/v1/releases/reconciliation').set('Authorization', 'Bearer ' + auth.signToken(actor));
describe('Release reconciliation current/history and failed-read contract', () => {
  it.each(['productionStage','order','ppStages','releaseScope'])('essential %s read failure returns safe unavailable, never zero-success', async fault => {
    const response = await read(storage(fault)); expect(response.status).toBe(503); expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('AUTHORIZATION_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toMatch(/P2010|SELECT|secret_column|password/);
    expect(response.body).not.toHaveProperty('items');
  });
  it('historical scope stays in readback IDs while readiness uses only current scopes', async () => {
    const response = await read(storage(undefined, true)); expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({ scopeCount: 2, ready: 2, summary: 'ready', historyTotal: 1, discrepancy: false });
    expect(response.body.items[0].scopeIds).toEqual(['parent','current-1','current-2']);
  });
  it('successful genuine empty in-production storage remains an honest empty result', async () => {
    const db = storage(); db.productionStage.findMany = async () => [];
    const response = await read(db); expect(response.status).toBe(200); expect(response.body).toMatchObject({ ok: true, total: 0, inProduction: 0, items: [] });
  });
  it('explicit rebind requires a JWT and cannot be granted by API key or actor-shaped body', async () => {
    const response = await request(app(storage())).post('/api/v1/releases/release-scopes/scope/rebind')
      .set('x-api-key','synthetic-key').send({ expectedScopeRevision: 1, expectedBatchRevision: 1, productionBatchId: 'batch', actorId: 'owner', permissions: ['orders:write'] });
    expect(response.status).toBe(401); expect(response.body).not.toHaveProperty('scope'); expect(response.body.ok).not.toBe(true);
  });
});
