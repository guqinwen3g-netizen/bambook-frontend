// Independent acceptance requirement: revocation must apply to both service and
// HTTP permission decisions. This probe deliberately retains failures as evidence.
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requirePermission } from '../src/auth/permissionGuard';
import { createPermissionService } from '../src/auth/permissionService';
const service = createPermissionService({ prisma: {} as never });
function app(actor: any, scope: any = 'orders:write', authSource = 'user-session') {
  const app = express();
  app.use((req, _res, next) => { Object.assign(req, { actor, authSource }); next(); });
  app.post('/probe', requirePermission(scope), (_req, res) => res.status(204).end());
  return app;
}
describe('whole-product acceptance: authoritative permission snapshot', () => {
  it('non-empty snapshot excluding orders:write must deny in service AND HTTP', async () => {
    const actor: any = { userId: 'acceptance-sales', roles: ['sales'], permissions: ['orders:read'] };
    expect(service.hasScope(actor, 'orders:write')).toBe(false);
    expect((await request(app(actor)).post('/probe')).status).toBe(403);
  });
  it('explicit grant still allows the same operation through both entry points', async () => {
    const actor: any = { userId: 'acceptance-sales', roles: ['sales'], permissions: ['orders:write'] };
    expect(service.hasScope(actor, 'orders:write')).toBe(true);
    expect((await request(app(actor)).post('/probe')).status).toBe(204);
  });
  it('API key cannot perform a write even with the scope', async () => {
    const actor: any = { userId: 'acceptance-sales', roles: ['sales'], permissions: ['orders:write'] };
    expect((await request(app(actor, 'orders:write', 'api-key')).post('/probe')).status).toBe(401);
  });
  it('missing actor is denied before the operation', async () => {
    expect((await request(app(null)).post('/probe')).status).toBe(401);
  });
  it.each(['cost', 'profit'] as const)('revoked sensitive:%s cannot be restored by the default role matrix', field => {
    const actor: any = { userId: 'acceptance-finance', roles: ['finance'], permissions: ['orders:read'] };
    expect(service.canViewSensitiveField({ ...actor, permissions: [] }, field)).toBe(true);
    expect(service.hasScope(actor, `sensitive:${field}`)).toBe(false);
    expect(service.canViewSensitiveField(actor, field)).toBe(false);
  });
});
