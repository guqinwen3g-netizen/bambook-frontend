import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthService } from '../../auth/service';
import { createAdminRouter } from '../route';

function adminToken() {
  return createAuthService().signToken({
    userId: 'owner-1',
    displayName: 'Owner',
    roles: ['owner'],
    permissions: ['users:read', 'users:write', 'users:delete', 'roles:read', 'roles:write'],
    departmentIds: [],
  });
}

function makeApp(opts: { logs?: any[]; count?: number } = {}) {
  const logs = opts.logs ?? [];
  const count = opts.count ?? logs.length;
  const findMany = vi.fn().mockResolvedValue(logs);
  const countFn = vi.fn().mockResolvedValue(count);
  const prisma = { auditLog: { findMany, count: countFn } } as any;
  const app = express();
  app.use(express.json());
  app.use('/admin', createAdminRouter({ prisma }));
  return { app, findMany, countFn, token: adminToken() };
}

describe('task ERP-P1 audit-query: GET /audit-logs filters', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('targetType + targetId 过滤进入 where', async () => {
    const { app, findMany, countFn, token } = makeApp({ logs: [{ id: 'a1' }], count: 1 });
    const res = await request(app).get('/admin/audit-logs?targetType=Order&targetId=ORD__1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, logs: [{ id: 'a1' }], total: 1 });
    expect(findMany.mock.calls[0][0].where).toMatchObject({ targetType: 'Order', targetId: 'ORD__1' });
    expect(countFn.mock.calls[0][0].where).toMatchObject({ targetType: 'Order', targetId: 'ORD__1' });
  });

  it('time range (createdFrom/createdTo) 进入 where.createdAt', async () => {
    const { app, findMany, token } = makeApp();
    await request(app).get('/admin/audit-logs?createdFrom=1000&createdTo=2000').set('Authorization', `Bearer ${token}`);
    const where = findMany.mock.calls[0][0].where;
    expect(where.createdAt).toBeTruthy();
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
    expect(where.createdAt.gte.getTime()).toBe(1000);
    expect(where.createdAt.lte.getTime()).toBe(2000);
  });

  it('combined filters 同 where', async () => {
    const { app, findMany, countFn, token } = makeApp();
    await request(app).get('/admin/audit-logs?action=delete_order&actorId=u1&targetType=Order&targetId=ORD__1&createdFrom=1000').set('Authorization', `Bearer ${token}`);
    const expectedWhere = { action: 'delete_order', actorId: 'u1', targetType: 'Order', targetId: 'ORD__1', createdAt: { gte: new Date(1000) } };
    expect(findMany.mock.calls[0][0].where).toMatchObject(expectedWhere);
    expect(countFn.mock.calls[0][0].where).toMatchObject(expectedWhere);
  });

  it('count 使用同一 where', async () => {
    const { app, findMany, countFn, token } = makeApp();
    await request(app).get('/admin/audit-logs?targetType=Invoice').set('Authorization', `Bearer ${token}`);
    const findWhere = findMany.mock.calls[0][0].where;
    const countWhere = countFn.mock.calls[0][0].where;
    expect(JSON.stringify(countWhere)).toEqual(JSON.stringify(findWhere));
  });

  it('limit cap 500', async () => {
    const { app, findMany, token } = makeApp();
    await request(app).get('/admin/audit-logs?limit=1000').set('Authorization', `Bearer ${token}`);
    expect(findMany.mock.calls[0][0].take).toBe(500);
  });

  it('invalid pagination limit=-1 → 400', async () => {
    const { app, findMany, token } = makeApp();
    const res = await request(app).get('/admin/audit-logs?limit=-1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAGINATION');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('invalid pagination offset=abc → 400', async () => {
    const { app, token } = makeApp();
    const res = await request(app).get('/admin/audit-logs?offset=abc').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAGINATION');
  });

  it('invalid date createdFrom=xyz → 400', async () => {
    const { app, findMany, token } = makeApp();
    const res = await request(app).get('/admin/audit-logs?createdFrom=xyz').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_DATE_RANGE');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('from > to → 400', async () => {
    const { app, findMany, token } = makeApp();
    const res = await request(app).get('/admin/audit-logs?createdFrom=2000&createdTo=1000').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_DATE_RANGE');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('无 filter → payload {ok,logs,total} 不破坏', async () => {
    const { app, token } = makeApp({ logs: [{ id: 'a1' }, { id: 'a2' }], count: 2 });
    const res = await request(app).get('/admin/audit-logs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  it('orderBy createdAt desc 保持不变', async () => {
    const { app, findMany, token } = makeApp();
    await request(app).get('/admin/audit-logs').set('Authorization', `Bearer ${token}`);
    expect(findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
  });
});
