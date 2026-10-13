/** Actual PG -> composition-root authorization loader -> JWT/API-key guard.
 * These scoped endpoints observe authorized writes, not a complete order workflow.
 * The loader failure is deliberately injected storage failure, not a real outage.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createModuleAuthGuard } from '../src/auth/moduleGuard';
import { requirePermission } from '../src/auth/permissionGuard';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';

const db = new PrismaClient();
const prefix = `acceptance-freshness-${randomUUID()}`;
const key = 'acceptance-freshness-bound-key';
let counter = 0;
afterAll(async () => { await db.$disconnect(); });
beforeAll(async () => {
  const [identity] = await db.$queryRawUnsafe<Array<{ name: string }>>('SELECT current_database() AS name');
  expect(process.env.BAMBOOK_ACCEPTANCE_DB_NAME).toBeTruthy();
  expect(identity.name).toBe(process.env.BAMBOOK_ACCEPTANCE_DB_NAME);
});

async function fixture(scopes: string[]) {
  const id = `${prefix}-${++counter}`;
  const roleId = `${id}-configured-role`;
  await db.userAccount.create({ data: { id, displayName: 'Synthetic fresh-authority actor', status: 'active' } });
  await db.role.create({ data: { id: roleId, name: roleId, isSystem: false } });
  await db.userRole.create({ data: { id: `${id}-role`, userId: id, roleId } });
  for (const scope of scopes) {
    const permission = await db.permission.upsert({
      where: { scope }, create: { id: `${id}-${scope}`, scope, description: 'Synthetic boundary permission' }, update: {},
    });
    await db.rolePermission.create({ data: { id: `${id}-${scope}-link`, roleId, permissionId: permission.id } });
  }
  const payload = await buildLoadedAuthTokenPayload(db, await loadUserWithRoles(db, id));
  return { id, roleId, payload, token: createAuthService().signToken(payload) };
}

function host(options: { client?: PrismaClient; actors?: Map<string, TokenPayload> } = {}) {
  const app = express(); app.use(express.json()); app.use(cookieParser());
  const actors = options.actors ?? new Map<string, TokenPayload>();
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: options.client ?? db,
    apiKeys: new Set([key]), apiKeyActors: actors }));
  const guard = createModuleAuthGuard({ requireAuth: true, apiKeys: new Set([key]), apiKeyActors: actors });
  app.post('/api/write', guard, requirePermission('orders:write'), (req, res) => res.json({ written: true, actor: (req as any).actor }));
  app.get('/api/read', guard, requirePermission('orders:read'), (req, res) => res.json({ actor: (req as any).actor }));
  return app;
}

describe('current authorization before scoped requests', () => {
  it('a valid old JWT loses withdrawn role writes on its next request, retaining its read grant', async () => {
    const f = await fixture(['orders:read', 'orders:write']);
    const app = host();
    const initial = await request(app).post('/api/write').set('Authorization', `Bearer ${f.token}`).send({});
    expect(initial.status).toBe(200);
    expect(initial.body.written).toBe(true);
    const write = await db.permission.findUniqueOrThrow({ where: { scope: 'orders:write' } });
    await db.rolePermission.deleteMany({ where: { roleId: f.roleId, permissionId: write.id } });
    const denied = await request(app).post('/api/write').set('Authorization', `Bearer ${f.token}`).send({ permissions: ['orders:write'] });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.written).toBeUndefined();
    const read = await request(app).get('/api/read').set('Authorization', `Bearer ${f.token}`);
    expect(read.status).toBe(200);
    expect(read.body.actor.permissions).toEqual(['orders:read']);
    expect(read.body.actor.authorizationLoaded).toBe(true);
  });
  it('a valid JWT with now-expired personal grants cannot use its old grant', async () => {
    const f = await fixture(['orders:read']);
    const grantId = `${f.id}-temporary-write`;
    await db.userPermissionOverrides.create({ data: { id: grantId, userId: f.id, scope: 'orders:write',
      grantedBy: f.id, reason: 'Synthetic scoped preauthorization; granting UI not tested',
      expiresAt: new Date(Date.now() + 60_000) } });
    const prior = await buildLoadedAuthTokenPayload(db, await loadUserWithRoles(db, f.id));
    expect(prior.permissions).toContain('orders:write');
    await db.userPermissionOverrides.update({ where: { id: grantId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const denied = await request(host()).post('/api/write')
      .set('Authorization', `Bearer ${createAuthService().signToken(prior)}`).send({});
    expect(denied.status).toBe(403);
    expect(denied.body.written).toBeUndefined();
  });
  it('a bound API key uses current read grants instead of its startup write snapshot', async () => {
    const f = await fixture(['orders:read', 'orders:write']);
    const actors = new Map([[key, f.payload]]);
    await db.rolePermission.deleteMany({ where: { roleId: f.roleId } });
    const response = await request(host({ actors })).get('/api/read').set('X-Bambook-API-Key', key);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.actor).toBeUndefined();
    expect(actors.get(key)?.permissions).toContain('orders:read'); // Startup map intentionally remains stale.
  });
  it('successful current loading of an empty set is authoritative for a previously nonempty JWT', async () => {
    const f = await fixture(['orders:read']);
    await db.rolePermission.deleteMany({ where: { roleId: f.roleId } });
    const response = await request(host()).get('/api/read').set('Authorization', `Bearer ${f.token}`);
    expect(response.status).toBe(403);
  });
  it('permission loader failure stops the request without stale-grant or body-authority fallback', async () => {
    const f = await fixture(['orders:read', 'orders:write']);
    const client = { userAccount: { findFirst: vi.fn(async () => { throw new Error('Injected permission-tree outage'); }) } } as any;
    const response = await request(host({ client })).post('/api/write').set('Authorization', `Bearer ${f.token}`).send({ roles: ['owner'] });
    expect(client.userAccount.findFirst).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('AUTHORIZATION_UNAVAILABLE');
    expect(response.body.written).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('outage');
  });
});
