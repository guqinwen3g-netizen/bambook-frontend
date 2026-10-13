/**
 * REQ2-13 离职交接路由测试（/api/v2/handover）
 *
 * 覆盖：
 *   1. 门禁：未登录 401 / sales 无 users:admin 403 / API-key 不足以执行交接 401
 *   2. preview / execute / records 全链 happy path
 *   3. execute 校验错误码透传（SAME_USER / INACTIVE_SUCCESSOR / NOT_FOUND）
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u_boss', roles: ['owner'] }, SECRET);
const salesToken = jwt.sign({ userId: 'u_sales', roles: ['sales'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

const { invalidateMock } = vi.hoisted(() => ({ invalidateMock: vi.fn() }));
vi.mock('../../auth/accountStatusGuard', () => ({
  invalidateAccountStatusCache: invalidateMock,
}));
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createHandoverRouter } from '../route';

function makePrisma() {
  const state = {
    users: [
      { id: 'u_from', displayName: '离职业务员', status: 'active', deletedAt: null, metadata: {} },
      { id: 'u_to', displayName: '接收业务员', status: 'active', deletedAt: null, metadata: {} },
    ],
    relations: [{ id: 'REL-1', ownerId: 'u_from', salesRepIds: ['u_from'] }],
    opportunities: [{ id: 'OPP-1', salesRepId: 'u_from', salesRepName: '离职业务员' }],
    followUpRecords: [],
    orders: [],
    departments: [],
    handoverRecords: [] as any[],
    auditLogs: [] as any[],
  };
  const prisma: any = {
    userAccount: {
      findUnique: async ({ where }: any) => state.users.find((u: any) => u.id === where.id) || null,
      update: async ({ where, data }: any) => {
        const u = state.users.find((x: any) => x.id === where.id);
        Object.assign(u, data);
        return u;
      },
    },
    relation: {
      count: async ({ where }: any) =>
        state.relations.filter((r: any) =>
          (where.ownerId !== undefined ? r.ownerId === where.ownerId : true)
          && (where.salesRepIds?.has !== undefined ? (r.salesRepIds || []).includes(where.salesRepIds.has) : true)
          && (where.NOT?.ownerId !== undefined ? r.ownerId !== where.NOT.ownerId : true),
        ).length,
      findMany: async ({ where, select }: any) =>
        state.relations
          .filter((r: any) =>
            (where.ownerId !== undefined ? r.ownerId === where.ownerId : true)
            && (where.salesRepIds?.has !== undefined ? (r.salesRepIds || []).includes(where.salesRepIds.has) : true)
            && (where.NOT?.ownerId !== undefined ? r.ownerId !== where.NOT.ownerId : true))
          .map((r: any) => (select ? Object.fromEntries(Object.keys(select).map(k => [k, (r as any)[k]])) : r)),
      update: async ({ where, data }: any) => {
        const r = state.relations.find((x: any) => x.id === where.id);
        Object.assign(r, data);
        return r;
      },
    },
    opportunity: {
      count: async ({ where }: any) => state.opportunities.filter((o: any) => o.salesRepId === where.salesRepId).length,
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const o of state.opportunities) if (o.salesRepId === where.salesRepId) { Object.assign(o, data); count++; }
        return { count };
      },
    },
    followUpRecord: {
      count: async () => 0,
      updateMany: async () => ({ count: 0 }),
    },
    order: {
      count: async () => 0,
      updateMany: async () => ({ count: 0 }),
    },
    department: { findMany: async () => [] },
    handoverRecord: {
      create: async ({ data }: any) => { state.handoverRecords.push(data); return data; },
      findMany: async ({ take }: any) => state.handoverRecords.slice(0, take ?? 20),
    },
    auditLog: { create: async ({ data }: any) => { state.auditLogs.push(data); return { id: data.id }; } },
    $transaction: async (fn: any) => fn(prisma),
  };
  return { prisma, state };
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/handover', createHandoverRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const ownerAuth = () => ({ Authorization: `Bearer ${ownerToken}` });
const salesAuth = () => ({ Authorization: `Bearer ${salesToken}` });

describe('REQ2-13 · /api/v2/handover 门禁', () => {
  let prisma: any;
  beforeEach(() => { prisma = makePrisma().prisma; });

  it('未登录 → 401', async () => {
    const res = await request(makeApp(prisma)).get('/api/v2/handover/preview?fromUserId=u_from');
    expect(res.status).toBe(401);
  });

  it('sales 角色（无 users:admin）→ 403 INSUFFICIENT_SCOPE', async () => {
    const app = makeApp(prisma);
    const r1 = await request(app).get('/api/v2/handover/preview?fromUserId=u_from').set(salesAuth());
    expect(r1.status).toBe(403);
    expect(r1.body.error).toBe('FORBIDDEN');

    const r2 = await request(app).post('/api/v2/handover').set(salesAuth()).send({ fromUserId: 'u_from', toUserId: 'u_to' });
    expect(r2.status).toBe(403);

    const r3 = await request(app).get('/api/v2/handover/records').set(salesAuth());
    expect(r3.status).toBe(403);
  });

  it('API-key 通道不足以执行交接（写高危 scope 强制 JWT）→ 401', async () => {
    const res = await request(makeApp(prisma))
      .post('/api/v2/handover')
      .set('X-Bambook-API-Key', validApiKey)
      .send({ fromUserId: 'u_from', toUserId: 'u_to' });
    expect(res.status).toBe(401);
  });
});

describe('REQ2-13 · /api/v2/handover 业务链', () => {
  let prisma: any, state: any;
  beforeEach(() => ({ prisma, state } = makePrisma()));

  it('preview → execute → records 全链', async () => {
    const app = makeApp(prisma);

    const p = await request(app).get('/api/v2/handover/preview?fromUserId=u_from&toUserId=u_to').set(ownerAuth());
    expect(p.status).toBe(200);
    expect(p.body.ok).toBe(true);
    expect(p.body.counts.relationsOwned).toBe(1);
    expect(p.body.counts.opportunities).toBe(1);
    expect(p.body.warnings).toEqual([]);

    const e = await request(app).post('/api/v2/handover').set(ownerAuth()).send({
      fromUserId: 'u_from', toUserId: 'u_to', note: '路由测试交接',
    });
    expect(e.status).toBe(200);
    expect(e.body.ok).toBe(true);
    expect(e.body.counts.relationsOwned).toBe(1);
    expect(e.body.accountDisabled).toBe(true);

    // 资产改写落库
    expect(state.relations[0]).toMatchObject({ ownerId: 'u_to', salesRepIds: ['u_to'] });
    expect(state.opportunities[0]).toMatchObject({ salesRepId: 'u_to', salesRepName: '接收业务员' });
    expect(state.users.find((u: any) => u.id === 'u_from').status).toBe('disabled');
    // 交接单 + 双审计
    expect(state.handoverRecords.length).toBe(1);
    const actions = state.auditLogs.map((a: any) => a.action);
    expect(actions).toContain('handover_execute');
    expect(actions).toContain('disable_account');

    const r = await request(app).get('/api/v2/handover/records').set(ownerAuth());
    expect(r.status).toBe(200);
    expect(r.body.records.length).toBe(1);
    expect(r.body.records[0]).toMatchObject({ fromUserId: 'u_from', toUserId: 'u_to', operatedBy: 'u_boss' });
  });

  it('preview 离职者不存在 → 404；execute from=to → 400 SAME_USER；接收人非 active → 400', async () => {
    const app = makeApp(prisma);
    const p = await request(app).get('/api/v2/handover/preview?fromUserId=u_ghost').set(ownerAuth());
    expect(p.status).toBe(404);

    const e1 = await request(app).post('/api/v2/handover').set(ownerAuth()).send({ fromUserId: 'u_from', toUserId: 'u_from' });
    expect(e1.status).toBe(400);
    expect(e1.body.error).toBe('SAME_USER');

    state.users.find((u: any) => u.id === 'u_to').status = 'disabled';
    const e2 = await request(app).post('/api/v2/handover').set(ownerAuth()).send({ fromUserId: 'u_from', toUserId: 'u_to' });
    expect(e2.status).toBe(400);
    expect(e2.body.error).toBe('INACTIVE_SUCCESSOR');
  });
});
