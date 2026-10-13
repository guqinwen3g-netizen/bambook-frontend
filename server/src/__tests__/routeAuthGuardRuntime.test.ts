/**
 * Route auth guard runtime tests (task_mrcex1at review_changes)
 *
 * Tests 401/403/allowed at HTTP level using supertest + mock prisma.
 * Verifies: write operations require JWT (API-key alone insufficient),
 * high-risk operations require owner/admin/manager role.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requireRole } from '../auth/middleware';
import { requirePermission, hasScopeOnRequest } from '../auth/permissionGuard';
import type { TokenPayload } from '../auth/service';

function makeMockPrisma() {
  return {
    order: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn(async () => 0) },
    invoice: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn(async () => 0) },
    shipment: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn(async () => 0) },
    developmentCase: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn(async () => 0) },
    email: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn(async () => 0) },
    auditLog: { create: vi.fn(async () => ({ id: 'alog' })) },
    $transaction: vi.fn(async (fn: any) => fn({})),
  } as any;
}

// Mock JWT tokens
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const validOwnerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const validViewerToken = jwt.sign({ userId: 'u2', roles: ['viewer'] }, SECRET);
const validApiKey = 'test-api-key-123';
const apiKeys = new Set([validApiKey]);

// Pure HTTP guard probes: no business service, database or role-grant UI is
// exercised. Explicit JWT snapshots must not regain missing write authority;
// the unmarked empty/missing snapshots are deliberate compatibility controls.
function scopeToken(permissions: string[] | undefined, loaded = false, roles: string[] = ['sales']) {
  return jwt.sign({
    userId: 'u-scope-snapshot', roles, departmentIds: [],
    ...(permissions === undefined ? {} : { permissions }),
    ...(loaded ? { authorizationLoaded: true } : {}),
  }, SECRET);
}

function makeScopeApp(options: { requireAuth?: boolean; apiPrincipal?: TokenPayload } = {}) {
  const app = express();
  app.use(express.json());
  app.use(createModuleAuthGuard({
    requireAuth: options.requireAuth ?? true,
    apiKeys,
    apiKeyActors: options.apiPrincipal ? new Map([[validApiKey, options.apiPrincipal]]) : new Map(),
  }));
  const hits = { read: 0, write: 0, alternativeWrite: 0 };
  app.get('/scope/read', requirePermission('orders:read'), (_req, res) => {
    hits.read++;
    res.json({ ok: true });
  });
  app.post('/scope/write', requirePermission('orders:write'), (_req, res) => {
    hits.write++;
    res.json({ ok: true });
  });
  app.post('/scope/alternative-write', requirePermission(['orders:write', 'invoices:write']), (_req, res) => {
    hits.alternativeWrite++;
    res.json({ ok: true });
  });
  app.get('/scope/manual', (req, res) => res.json({
    read: hasScopeOnRequest(req, 'orders:read'), write: hasScopeOnRequest(req, 'orders:write'),
  }));
  return { app, hits };
}

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    // Mock cookie parser for JWT
    if (req.headers.cookie) {
      const cookies: Record<string,string> = {};
      req.headers.cookie.split(';').forEach((c: string) => {
        const [k, v] = c.trim().split('=');
        cookies[k] = v;
      });
      req.cookies = cookies;
    }
    next();
  });

  const guard = createModuleAuthGuard({ requireAuth: true, apiKeys });
  const writeGuard = requireJwtForWrite({ requireAuth: true, apiKeys });

  const mockHandler = (_req: any, res: any) => res.json({ ok: true });
  const prisma = makeMockPrisma();

  // Simulated module routes
  const modRouter = express.Router();
  modRouter.use(guard);

  // Read route - JWT or API-key
  modRouter.get('/items', mockHandler);

  // Write route - requires JWT
  modRouter.post('/items', writeGuard, mockHandler);
  modRouter.patch('/items/:id', writeGuard, mockHandler);
  modRouter.delete('/items/:id', writeGuard, mockHandler);

  // High-risk route - requires owner/admin/manager
  modRouter.post('/items/:id/cancel', requireRole('owner', 'admin', 'manager'), mockHandler);

  app.use('/api/v1/test', modRouter);
  return app;
}

describe('Module auth guard · runtime 401/403/allowed', () => {

  describe('Read operations (GET /items)', () => {
    it('401 when no auth at all', async () => {
      const app = makeTestApp();
      const res = await request(app).get('/api/v1/test/items');
      expect(res.status).toBe(401);
    });

    it('200 with valid JWT cookie', async () => {
      const app = makeTestApp();
      const res = await request(app)
        .get('/api/v1/test/items')
        .set('Cookie', `bambook_token=${validOwnerToken}`);
      expect(res.status).toBe(200);
    });

    it('200 with valid API key', async () => {
      const app = makeTestApp();
      const res = await request(app)
        .get('/api/v1/test/items')
        .set('x-bambook-api-key', validApiKey);
      expect(res.status).toBe(200);
    });

    it('401 with invalid API key（与旧模块手写 authenticate 契约对齐）', async () => {
      const app = makeTestApp();
      const res = await request(app)
        .get('/api/v1/test/items')
        .set('x-bambook-api-key', 'wrong-key');
      expect(res.status).toBe(401);
    });
  });

  describe('Write operations (POST/PATCH/DELETE) - require JWT, not just API-key', () => {
    it('POST 401 when no auth', async () => {
      const app = makeTestApp();
      const res = await request(app).post('/api/v1/test/items').send({});
      expect(res.status).toBe(401);
    });

    it('POST 401 when only API-key (no JWT)', async () => {
      const app = makeTestApp();
      const res = await request(app)
        .post('/api/v1/test/items')
        .set('x-bambook-api-key', validApiKey)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/JWT login/);
    });

    it('POST 200 when JWT provided (owner)', async () => {
      const app = makeTestApp();
      const res = await request(app)
        .post('/api/v1/test/items')
        .set('Cookie', `bambook_token=${validOwnerToken}`)
        .send({});
      expect(res.status).toBe(200);
    });

    it('DELETE 401 with API-key only', async () => {
      const app = makeTestApp();
      const res = await request(app)
        .delete('/api/v1/test/items/123')
        .set('x-bambook-api-key', validApiKey);
      expect(res.status).toBe(401);
    });

    it('PATCH 200 with JWT', async () => {
      const app = makeTestApp();
      const res = await request(app)
        .patch('/api/v1/test/items/123')
        .set('Cookie', `bambook_token=${validOwnerToken}`)
        .send({});
      expect(res.status).toBe(200);
    });
  });

  describe('High-risk operations (POST /:id/cancel) - require owner/admin/manager', () => {
    it('401 with API-key only', async () => {
      const app = makeTestApp();
      const res = await request(app)
        .post('/api/v1/test/items/123/cancel')
        .set('x-bambook-api-key', validApiKey);
      expect(res.status).toBe(401);
    });

    it('403 with viewer role JWT', async () => {
      const app = makeTestApp();
      const res = await request(app)
        .post('/api/v1/test/items/123/cancel')
        .set('Cookie', `bambook_token=${validViewerToken}`);
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/Insufficient role/);
    });

    it('200 with owner role JWT', async () => {
      const app = makeTestApp();
      const res = await request(app)
        .post('/api/v1/test/items/123/cancel')
        .set('Cookie', `bambook_token=${validOwnerToken}`);
      expect(res.status).toBe(200);
    });
  });
});

describe('Scope guard HTTP boundary: explicit authorization snapshot and legacy compatibility', () => {
  it('nonempty read-only JWT cannot regain orders:write through sales defaults or the manual scope helper', async () => {
    const { app, hits } = makeScopeApp();
    const authorization = `Bearer ${scopeToken(['orders:read'])}`;
    expect((await request(app).get('/scope/read').set('Authorization', authorization)).status).toBe(200);
    const denied = await request(app).post('/scope/write').set('Authorization', authorization).send({});
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('FORBIDDEN');
    expect((await request(app).get('/scope/manual').set('Authorization', authorization)).body).toEqual({ read: true, write: false });
    expect(hits).toEqual({ read: 1, write: 0, alternativeWrite: 0 });
  });

  it('a loaded empty JWT scope set denies read and write rather than restoring the default role grants', async () => {
    const { app, hits } = makeScopeApp();
    const authorization = `Bearer ${scopeToken([], true)}`;
    expect((await request(app).get('/scope/read').set('Authorization', authorization)).status).toBe(403);
    expect((await request(app).post('/scope/write').set('Authorization', authorization).send({})).status).toBe(403);
    expect((await request(app).get('/scope/manual').set('Authorization', authorization)).body).toEqual({ read: false, write: false });
    expect(hits).toEqual({ read: 0, write: 0, alternativeWrite: 0 });
  });

  it.each([
    { label: 'unmarked empty', permissions: [] as string[] },
    { label: 'legacy missing', permissions: undefined },
  ])('$label JWT scope set keeps the established default-role compatibility path', async ({ permissions }) => {
    const { app } = makeScopeApp();
    const authorization = `Bearer ${scopeToken(permissions)}`;
    expect((await request(app).get('/scope/read').set('Authorization', authorization)).status).toBe(200);
    expect((await request(app).post('/scope/write').set('Authorization', authorization).send({})).status).toBe(200);
    expect((await request(app).get('/scope/manual').set('Authorization', authorization)).body).toEqual({ read: true, write: true });
  });

  it('an explicitly granted write scope works without the legacy role granting it', async () => {
    const { app, hits } = makeScopeApp();
    const authorization = `Bearer ${scopeToken(['orders:write'], true, ['viewer'])}`;
    expect((await request(app).post('/scope/write').set('Authorization', authorization).send({})).status).toBe(200);
    expect((await request(app).get('/scope/read').set('Authorization', authorization)).status).toBe(403);
    expect((await request(app).get('/scope/manual').set('Authorization', authorization)).body).toEqual({ read: false, write: true });
    expect(hits.write).toBe(1);
    expect(hits.read).toBe(0);
  });

  it.each(['owner', 'role-super-admin'])('technical SuperAdmin shortcut remains for %s with a marked empty snapshot', async role => {
    const { app } = makeScopeApp();
    const authorization = `Bearer ${scopeToken([], true, [role])}`;
    expect((await request(app).post('/scope/write').set('Authorization', authorization).send({})).status).toBe(200);
    expect((await request(app).get('/scope/manual').set('Authorization', authorization)).body).toEqual({ read: true, write: true });
  });

  it('OR scope guards deny a missing write set and allow one explicitly granted alternative', async () => {
    const { app, hits } = makeScopeApp();
    expect((await request(app).post('/scope/alternative-write')
      .set('Authorization', `Bearer ${scopeToken(['orders:read'])}`).send({})).status).toBe(403);
    expect(hits.alternativeWrite).toBe(0);
    expect((await request(app).post('/scope/alternative-write')
      .set('Authorization', `Bearer ${scopeToken(['invoices:write'], true, ['viewer'])}`).send({})).status).toBe(200);
    expect(hits.alternativeWrite).toBe(1);
  });

  it('a mapped API Key may read its granted scope but cannot use an explicitly granted high-risk write scope', async () => {
    const principal: TokenPayload = {
      userId: 'u-api-scope-control', roles: ['sales'], permissions: ['orders:read', 'orders:write'],
      departmentIds: [], authorizationLoaded: true,
    };
    const { app, hits } = makeScopeApp({ apiPrincipal: principal });
    expect((await request(app).get('/scope/read').set('x-bambook-api-key', validApiKey)).status).toBe(200);
    const denied = await request(app).post('/scope/write').set('x-bambook-api-key', validApiKey).send({});
    expect(denied.status).toBe(401);
    expect(denied.body.message).toMatch(/API key insufficient/);
    expect(hits.write).toBe(0);
  });

  it('anonymous development bypass remains read-only and body actor data cannot supply write authority', async () => {
    const { app, hits } = makeScopeApp({ requireAuth: false });
    expect((await request(app).get('/scope/read')).status).toBe(200);
    const denied = await request(app).post('/scope/write').send({ actor: {
      userId: 'body-spoof', roles: ['owner'], permissions: ['orders:write'], authorizationLoaded: true,
    } });
    expect(denied.status).toBe(401);
    expect(hits.write).toBe(0);
  });
});
