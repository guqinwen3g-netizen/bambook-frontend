/**
 * 阶段 D / D6：GET /api/v1/audit/entity 实体级审计查询端点测试
 *
 * 覆盖：
 *   1. 缺 targetType/targetId → 400 TARGET_REQUIRED（防全表扫描）
 *   2. 未认证（requireAuth=true 无 token）→ 401
 *   3. merchandiser 可读 Order 审计（模块读权限命中）
 *   4. viewer 不可读 Order 审计（viewer 无 orders scope）
 *   5. finance 角色不可读 Relation 审计（无 relations scope）
 *   6. viewer 可读 ProductAsset 审计（products scope 含 viewer）
 *   7. owner/admin 恒可读（全局审计权）
 *   8. 未映射 targetType fail closed：manager 可读、merchandiser 拒绝
 *   9. 返回结构：固定 limit 20、createdAt desc、含 actor 摘要
 *
 * 权限模型（2026-09-06 Kevin 验收决策）：实体审计按模块读权限门禁（canReadEntityAudit），
 * 不再叠加 audit:read 第一层 scope 门 —— 能读该实体的角色即可看它的变更历史（含创建人/时间）。
 * 本文件 token 默认不带任何 permissions（permissions: []），全部判定落在角色映射层。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthService } from '../../auth/service';
import { createAuditRouter } from '../route';
import type { AgentRole } from '../../agent/types';

function tokenFor(roles: AgentRole[], userId = 'u-1', permissions: string[] = []) {
  return createAuthService().signToken({
    userId,
    displayName: 'Test User',
    roles,
    permissions,
    departmentIds: [],
  });
}

function makeApp(opts: { logs?: any[]; requireAuth?: boolean } = {}) {
  const findMany = vi.fn().mockResolvedValue(opts.logs ?? []);
  const prisma = { auditLog: { findMany } } as any;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/audit', createAuditRouter({
    prisma,
    requireAuth: opts.requireAuth ?? true,
    apiKeys: new Set(),
  }));
  return { app, findMany };
}

const SAMPLE_LOG = {
  id: 'alog_1',
  action: 'update_order',
  targetType: 'Order',
  targetId: 'ORD_1',
  operationType: 'update',
  fieldPath: 'status',
  beforeValue: 'Draft',
  afterValue: 'Confirmed',
  detail: { source: 'orders.route' },
  createdAt: new Date('2026-08-07T10:00:00Z'),
  actor: { id: 'u-9', displayName: 'Operator', email: 'op@example.com' },
};

describe('D6 audit entity query: GET /api/v1/audit/entity', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('缺 targetType → 400 TARGET_REQUIRED', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/api/v1/audit/entity?targetId=ORD_1')
      .set('Authorization', `Bearer ${tokenFor(['merchandiser'])}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TARGET_REQUIRED');
  });

  it('缺 targetId → 400 TARGET_REQUIRED', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/api/v1/audit/entity?targetType=Order')
      .set('Authorization', `Bearer ${tokenFor(['merchandiser'])}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TARGET_REQUIRED');
  });

  it('未认证 → 401', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/audit/entity?targetType=Order&targetId=ORD_1');
    expect(res.status).toBe(401);
  });

  it('merchandiser 可读 Order 审计 → 200 + actor 摘要', async () => {
    const { app, findMany } = makeApp({ logs: [SAMPLE_LOG] });
    const res = await request(app)
      .get('/api/v1/audit/entity?targetType=Order&targetId=ORD_1')
      .set('Authorization', `Bearer ${tokenFor(['merchandiser'])}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].action).toBe('update_order');
    expect(res.body.logs[0].fieldPath).toBe('status');
    expect(res.body.logs[0].actor.displayName).toBe('Operator');
    // 查询契约：where 精确定位、固定 20 条、倒序
    expect(findMany.mock.calls[0][0].where).toMatchObject({ targetType: 'Order', targetId: 'ORD_1' });
    expect(findMany.mock.calls[0][0].take).toBe(20);
    expect(findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
  });

  it('viewer 不可读 Order 审计 → 403（viewer 无 orders 模块读权限，角色映射层拒）', async () => {
    const { app, findMany } = makeApp();
    const res = await request(app)
      .get('/api/v1/audit/entity?targetType=Order&targetId=ORD_1')
      .set('Authorization', `Bearer ${tokenFor(['viewer'], 'u-1', [])}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('finance 角色不可读 Relation 审计 → 403', async () => {
    const { app, findMany } = makeApp();
    const res = await request(app)
      .get('/api/v1/audit/entity?targetType=Relation&targetId=REL_1')
      .set('Authorization', `Bearer ${tokenFor(['finance'])}`);
    expect(res.status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('viewer 可读 ProductAsset 审计 → 200', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/api/v1/audit/entity?targetType=ProductAsset&targetId=PA_1')
      .set('Authorization', `Bearer ${tokenFor(['viewer'])}`);
    expect(res.status).toBe(200);
  });

  it('sales 可读 Invoice 审计（finance scope 含 sales）→ 200', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/api/v1/audit/entity?targetType=Invoice&targetId=INV_1')
      .set('Authorization', `Bearer ${tokenFor(['sales'])}`);
    expect(res.status).toBe(200);
  });

  it('owner 恒可读任意 targetType → 200', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/api/v1/audit/entity?targetType=JobPosition&targetId=JP_1')
      .set('Authorization', `Bearer ${tokenFor(['owner'])}`);
    expect(res.status).toBe(200);
  });

  it('未映射 targetType fail closed：merchandiser 403 / manager 200', async () => {
    const { app } = makeApp();
    const r1 = await request(app)
      .get('/api/v1/audit/entity?targetType=JobPosition&targetId=JP_1')
      .set('Authorization', `Bearer ${tokenFor(['merchandiser'])}`);
    expect(r1.status).toBe(403);

    const r2 = await request(app)
      .get('/api/v1/audit/entity?targetType=JobPosition&targetId=JP_1')
      .set('Authorization', `Bearer ${tokenFor(['manager'])}`);
    expect(r2.status).toBe(200);
  });
});
