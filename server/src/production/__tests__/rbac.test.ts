import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

function makeApp(opts: { requireAuth: boolean; roles?: string[] }) {
  const apiKeys = new Set(['test-key']);
  const router = express.Router();

  router.use((req: any, res: any, next: any) => {
    if (!opts.requireAuth) return next();
    const key = req.headers['x-bambook-api-key'];
    if (!key) return res.status(401).json({ error: 'UNAUTHORIZED' });
    if (!apiKeys.has(key)) return res.status(403).json({ error: 'FORBIDDEN' });
    if (opts.roles) {
      req.user = { roles: opts.roles };
    }
    next();
  });

  const PRODUCTION_WRITE_ROLES = new Set(['production_manager', 'factory', 'manager', 'admin', 'owner']);
  const requireProductionRole = (req: any, res: any, next: any) => {
    if (!opts.requireAuth) return next();
    const roles: string[] = req.user?.roles || [];
    if (roles.length === 0) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'No roles resolved — authentication required' } });
    }
    if (!roles.some((r: string) => PRODUCTION_WRITE_ROLES.has(r))) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Requires production role' } });
    }
    return next();
  };

  router.put('/:orderId/inspection', requireProductionRole, (_req: any, res: any) => { res.json({ ok: true }); });
  router.post('/:orderId/advance/:stageKey', requireProductionRole, (_req: any, res: any) => { res.json({ ok: true }); });
  router.put('/:orderId/checklist', requireProductionRole, (_req: any, res: any) => { res.json({ ok: true }); });
  router.post('/:orderId/sign/:stageKey', requireProductionRole, (_req: any, res: any) => { res.json({ ok: true }); });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/production', router);
  return app;
}

describe('production RBAC: requireProductionRole regression', () => {
  describe('requireAuth=true', () => {
    it('无角色 roles=[] -> 403 fail-closed', async () => {
      const app = makeApp({ requireAuth: true, roles: [] });
      const res = await request(app).put('/api/v1/production/O1/inspection').set('x-bambook-api-key', 'test-key').send({ totalUnits: 100 });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toContain('No roles resolved');
    });

    it('viewer -> 403', async () => {
      const app = makeApp({ requireAuth: true, roles: ['viewer'] });
      const res = await request(app).put('/api/v1/production/O1/inspection').set('x-bambook-api-key', 'test-key').send({ totalUnits: 100 });
      expect(res.status).toBe(403);
    });

    it('finance -> 403 (advance)', async () => {
      const app = makeApp({ requireAuth: true, roles: ['finance'] });
      const res = await request(app).post('/api/v1/production/O1/advance/manufacturing').set('x-bambook-api-key', 'test-key').send({});
      expect(res.status).toBe(403);
    });

    it('sales -> 403 (advance)', async () => {
      const app = makeApp({ requireAuth: true, roles: ['sales'] });
      const res = await request(app).post('/api/v1/production/O1/advance/manufacturing').set('x-bambook-api-key', 'test-key').send({});
      expect(res.status).toBe(403);
    });

    it('logistics -> 403 (sign)', async () => {
      const app = makeApp({ requireAuth: true, roles: ['logistics'] });
      const res = await request(app).post('/api/v1/production/O1/sign/pp_sample_approved').set('x-bambook-api-key', 'test-key').send({ signType: 'production' });
      expect(res.status).toBe(403);
    });

    it('production_manager -> 200 (checklist)', async () => {
      const app = makeApp({ requireAuth: true, roles: ['production_manager'] });
      const res = await request(app).put('/api/v1/production/O1/checklist').set('x-bambook-api-key', 'test-key').send({ gradingConfirmed: true });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('factory -> 200 (inspection)', async () => {
      const app = makeApp({ requireAuth: true, roles: ['factory'] });
      const res = await request(app).put('/api/v1/production/O1/inspection').set('x-bambook-api-key', 'test-key').send({ totalUnits: 100 });
      expect(res.status).toBe(200);
    });

    it('admin -> 200 (advance)', async () => {
      const app = makeApp({ requireAuth: true, roles: ['admin'] });
      const res = await request(app).post('/api/v1/production/O1/advance/manufacturing').set('x-bambook-api-key', 'test-key').send({});
      expect(res.status).toBe(200);
    });

    it('owner -> 200 (sign)', async () => {
      const app = makeApp({ requireAuth: true, roles: ['owner'] });
      const res = await request(app).post('/api/v1/production/O1/sign/pp_sample_approved').set('x-bambook-api-key', 'test-key').send({ signType: 'production' });
      expect(res.status).toBe(200);
    });

    it('无 API key -> 401', async () => {
      const app = makeApp({ requireAuth: true, roles: ['admin'] });
      const res = await request(app).put('/api/v1/production/O1/inspection').send({ totalUnits: 100 });
      expect(res.status).toBe(401);
    });
  });

  describe('requireAuth=false (dev)', () => {
    it('跳过 RBAC -> 200', async () => {
      const app = makeApp({ requireAuth: false });
      const res = await request(app).put('/api/v1/production/O1/inspection').send({ totalUnits: 100 });
      expect(res.status).toBe(200);
    });
  });
});
