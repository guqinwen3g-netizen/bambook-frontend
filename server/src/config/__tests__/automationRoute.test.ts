/**
 * 自动化规则路由权限守卫回归测试（W7 设置域裁决）
 *
 * 验证：
 *   1. PATCH /rules/:id 无 actor → 401
 *   2. PATCH /rules/:id 无 settings:automation:write scope → 403
 *   3. PATCH /rules/:id 有 scope → 200 放行
 *   4. GET /rules 无需 scope（只读）
 */

import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock fs（automationConfig 依赖文件持久化）
vi.mock('fs', () => ({
  readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createAutomationRouter } from '../automationRoute';

const prismaMock = {} as any;

function buildApp(actor?: { roles: string[]; permissions?: string[] }) {
  const app = express();
  app.use(express.json());
  // 模拟上游 sdkAuth / moduleGuard 注入 actor
  if (actor) {
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      (req as any).authSource = 'user-session';
      next();
    });
  }
  app.use(createAutomationRouter(prismaMock));
  return app;
}

describe('AutomationRoute permission guard', () => {
  it('GET /rules returns 200 without actor', async () => {
    const res = await request(buildApp()).get('/rules');
    expect(res.status).toBe(200);
    // 10 条 = L1–L11（无 L4）；L11 为 T3 新增，见 automationConfig.test.ts 同款清单钉
    expect(res.body.rules).toHaveLength(10);
  });

  it('PATCH /rules/:id returns 401 without actor', async () => {
    const res = await request(buildApp())
      .patch('/rules/L1_init_production')
      .send({ enabled: false });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('PATCH /rules/:id returns 403 with actor lacking scope', async () => {
    const res = await request(buildApp({ roles: ['sales'] }))
      .patch('/rules/L1_init_production')
      .send({ enabled: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('PATCH /rules/:id returns 200 with admin role (has settings:automation:write)', async () => {
    const res = await request(buildApp({ roles: ['admin'] }))
      .patch('/rules/L1_init_production')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.rule.enabled).toBe(false);
  });

  it('PATCH /rules/:id returns 200 with explicit permission in JWT', async () => {
    const res = await request(buildApp({ roles: [], permissions: ['settings:automation:write'] }))
      .patch('/rules/L2_create_shipment')
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.rule.enabled).toBe(true);
  });

  it('PATCH /rules/:id returns 400 for non-boolean enabled', async () => {
    const res = await request(buildApp({ roles: ['admin'] }))
      .patch('/rules/L1_init_production')
      .send({ enabled: 'yes' });
    expect(res.status).toBe(400);
  });
});
