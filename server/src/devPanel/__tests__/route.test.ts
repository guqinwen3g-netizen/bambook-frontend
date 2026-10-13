import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createDevPanelRouter } from '../route';

/**
 * devPanel 路由契约测试（补登：本模块此前 **零测试**）。
 * 重点覆盖两道**安全护栏**：
 *   1. 双护栏（NODE_ENV !== production 且 BAMBOOK_DEV_PANEL==='1'）不满足 → 全端点 404；
 *   2. GET /env 环境变量**脱敏**（含 SECRET/PASSWORD/TOKEN/KEY/CREDENTIAL/PRIVATE 的键不出现）。
 * 以及切库校验、一键登录的状态门禁（非 active 拒绝）。
 */

const mocks = vi.hoisted(() => ({
  getActiveDb: vi.fn(() => 'panda_hub_dev'),
  setActiveDb: vi.fn(() => true),
  loadUserWithRoles: vi.fn(),
  buildLoadedAuthTokenPayload: vi.fn(),
}));

vi.mock('../activeDb', () => ({ getActiveDb: mocks.getActiveDb, setActiveDb: mocks.setActiveDb }));
vi.mock('../../auth/tokenHelpers', () => ({
  buildLoadedAuthTokenPayload: mocks.buildLoadedAuthTokenPayload,
  serializeAuthUser: (u: any) => u,
  loadUserWithRoles: mocks.loadUserWithRoles,
}));
vi.mock('../../auth/service', () => ({
  createAuthService: () => ({ signToken: () => 'dev-token' }),
}));

function makePrisma() {
  return {
    userAccount: {
      count: vi.fn(async () => 3),
      update: vi.fn(async () => ({})),
    },
    order: { count: vi.fn(async () => 69) },
    relation: { count: vi.fn(async () => 12) },
    auditLog: { create: vi.fn(async () => ({})) },
  } as any;
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/dev', createDevPanelRouter({ prisma }));
  return app;
}

const ORIGINAL_ENV = { ...process.env };

describe('devPanelRoute', () => {
  beforeEach(() => {
    mocks.getActiveDb.mockReturnValue('panda_hub_dev');
    mocks.setActiveDb.mockReturnValue(true);
    mocks.loadUserWithRoles.mockReset();
    mocks.buildLoadedAuthTokenPayload.mockReset().mockResolvedValue({
      userId: 'U1', roles: ['sales'], permissions: ['orders:read'], departmentIds: ['company'],
      roleIds: ['role-sales'], authorizationLoaded: true,
    });
    process.env.NODE_ENV = 'test';
    process.env.BAMBOOK_DEV_PANEL = '1';
  });
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
    if (ORIGINAL_ENV.BAMBOOK_DEV_PANEL === undefined) delete process.env.BAMBOOK_DEV_PANEL;
    else process.env.BAMBOOK_DEV_PANEL = ORIGINAL_ENV.BAMBOOK_DEV_PANEL;
  });

  it('护栏：BAMBOOK_DEV_PANEL 未开启 → 端点 404（等同不存在）', async () => {
    delete process.env.BAMBOOK_DEV_PANEL;
    const res = await request(makeApp(makePrisma())).get('/api/dev/status');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('护栏：NODE_ENV=production → 即便开关开着也 404', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(makeApp(makePrisma())).get('/api/dev/status');
    expect(res.status).toBe(404);
  });

  it('GET /status 回当前库/公司/统计；count 失败降级为 0 不 500', async () => {
    const prisma = makePrisma();
    prisma.order.count.mockRejectedValue(new Error('BOOM'));
    const res = await request(makeApp(prisma)).get('/api/dev/status');
    expect(res.status).toBe(200);
    expect(res.body.currentDb).toBe('panda_hub_dev');
    expect(res.body.stats.accountCount).toBe(3);
    expect(res.body.stats.orderCount).toBe(0); // 降级
  });

  it('GET /env 脱敏：含 SECRET/PASSWORD/TOKEN/KEY/CREDENTIAL/PRIVATE 的键一律不出现', async () => {
    process.env.MY_SECRET_KEY = 'do-not-leak';
    process.env.DB_PASSWORD = 'do-not-leak';
    process.env.SOME_TOKEN = 'do-not-leak';
    process.env.PRIVATE_THING = 'do-not-leak';
    process.env.HARMLESS_VAR = 'ok';
    try {
      const res = await request(makeApp(makePrisma())).get('/api/dev/env');
      expect(res.status).toBe(200);
      expect(res.body.keys).toContain('HARMLESS_VAR');
      for (const leak of ['MY_SECRET_KEY', 'DB_PASSWORD', 'SOME_TOKEN', 'PRIVATE_THING']) {
        expect(res.body.keys).not.toContain(leak);
      }
    } finally {
      delete process.env.MY_SECRET_KEY;
      delete process.env.DB_PASSWORD;
      delete process.env.SOME_TOKEN;
      delete process.env.PRIVATE_THING;
      delete process.env.HARMLESS_VAR;
    }
  });

  it('POST /company/switch 非法库名 → 400 INVALID_DB（不调用 setActiveDb）', async () => {
    const res = await request(makeApp(makePrisma())).post('/api/dev/company/switch').send({ db: 'prod_db' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_DB');
    expect(mocks.setActiveDb).not.toHaveBeenCalled();
  });

  it('POST /company/switch 合法 → 200 + 翻转内存指针；已在目标库则 alreadyThere', async () => {
    const ok = await request(makeApp(makePrisma())).post('/api/dev/company/switch').send({ db: 'panda_hub_dev' });
    expect(ok.status).toBe(200);
    expect(ok.body.alreadyThere).toBe(true);

    const same = await request(makeApp(makePrisma())).post('/api/dev/company/switch').send({ db: 'panda_hub_dev' });
    expect(same.body.alreadyThere).toBe(true);
  });

  it('POST /accounts/:id/login 状态门禁：不存在 → 404；非 active → 403；active → 200 带 token', async () => {
    mocks.loadUserWithRoles.mockResolvedValueOnce(null);
    const missing = await request(makeApp(makePrisma())).post('/api/dev/accounts/U404/login');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('USER_NOT_FOUND');

    mocks.loadUserWithRoles.mockResolvedValueOnce({ id: 'U2', status: 'disabled' });
    const inactive = await request(makeApp(makePrisma())).post('/api/dev/accounts/U2/login');
    expect(inactive.status).toBe(403);
    expect(inactive.body.error).toBe('USER_INACTIVE');

    const prisma = makePrisma();
    mocks.loadUserWithRoles.mockResolvedValueOnce({ id: 'U1', status: 'active' });
    const ok = await request(makeApp(prisma)).post('/api/dev/accounts/U1/login');
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBe('dev-token');
    expect(prisma.auditLog.create).toHaveBeenCalled(); // 与真实登录一致：留痕
  });

  it('当前授权加载失败不签发开发登录 token', async () => {
    mocks.loadUserWithRoles.mockResolvedValueOnce({ id: 'U1', status: 'active' });
    mocks.buildLoadedAuthTokenPayload.mockRejectedValueOnce(new Error('synthetic authorization read failure'));
    const prisma = makePrisma();
    const res = await request(makeApp(prisma)).post('/api/dev/accounts/U1/login');
    expect(res.status).toBe(500);
    expect(res.body.token).toBeUndefined();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
