import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createApprovalKernelRouter } from '../approvalKernelRoute';
import { approvalReviewContentVersion } from '../approvalDecisionService';
import { approvalEventBus } from '../../agent/events';

/**
 * DR-007 审批内核路由契约测试（BASE-39-B2/B3）：
 *   POST /:id/delegate    — 仅当前审批人本人 / 禁委派给申请人 / reason≥10 / pending 限定 / 审计
 *   POST /:id/boss-bypass — 仅 owner / reason≥30 / pending 限定 / 绝密级三字段 + 审计
 *   GET  /:id/resolution-trace — owner/admin/manager 角色守卫
 */

// 可控 actor mock：默认 manager 角色（当前审批人）
let mockActor: { userId: string; roles: string[] } | null = { userId: 'u_reviewer', roles: ['manager'] };
vi.mock('../../auth/middleware', () => ({
  extractActorFromRequest: () => mockActor,
}));

const baseApproval = {
  id: 'ar_1',
  requesterId: 'u_requester',
  reviewerId: 'u_reviewer',
  // Generic kernel permission contract fixture; MOQ approvals require real, frozen MOQ facts.
  actionType: 'test:approval-kernel-contract',
  targetType: 'TestApprovalTarget',
  targetId: 'TARGET_1',
  status: 'pending',
  risk: 'high',
  payload: {},
  reviewerResolverRoute: 'DEPT_HEAD',
  departmentSnapshotId: 'dept_garment',
  delegatedBy: null,
  delegatedAt: null,
  delegateReason: null,
  clientReviewerIdSupplied: false,
  bossFinalBypassBy: null,
  bossFinalBypassAt: null,
  bossFinalBypassReason: null,
  bypassedApprovalId: null,
};

function makeApp(opts: { existing?: any; activeUsers?: string[] } = {}) {
  let existing = { ...(opts.existing ?? baseApproval) };
  const activeUsers = new Set(opts.activeUsers ?? ['u_reviewer', 'u_delegate', 'u_requester']);
  const read = async ({ where }: any) => where.id === existing?.id ? { ...existing } : null;
  const approvalFindUnique = vi.fn(read);
  const approvalUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => {
    if (where.status !== existing.status || where.reviewerId !== existing.reviewerId) return { count: 0 };
    existing = { ...existing, ...data }; return { count: 1 };
  });
  const auditCreate = vi.fn().mockResolvedValue({ id: 'AL-1' });
  const userFindFirst = vi.fn().mockImplementation(async ({ where }: any) =>
    activeUsers.has(where.id) ? { id: where.id } : null);
  const prisma: any = {
    approvalRequest: { findUnique: approvalFindUnique, findUniqueOrThrow: vi.fn(read), updateMany: approvalUpdate },
    userAccount: { findFirst: userFindFirst },
    userRole: { findMany: vi.fn().mockImplementation(async () => (mockActor?.roles ?? []).map(role => ({ roleId: role }))) },
    auditLog: { create: auditCreate },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (callback: any) => {
      const before = existing;
      try { return await callback(prisma); } catch (error) { existing = before; throw error; }
    }),
  };

  const app = express();
  app.use(express.json());
  app.use('/api/v1/approvals-kernel', createApprovalKernelRouter({ prisma, requireAuth: true }));
  return { app, prisma, approvalUpdate, auditCreate, userFindFirst };
}

const LONG_DELEGATE_REASON = '出差两周，委托同事代为审批';
const LONG_BOSS_REASON = '客户关系重大且已书面承诺年度订单增量，综合评估同意特批豁免本次放行';
const reviewedBase = { reviewContentVersion: approvalReviewContentVersion(baseApproval as any), confirmedReviewedContent: true };

beforeEach(() => {
  mockActor = { userId: 'u_reviewer', roles: ['manager'] };
});

describe('approvalKernelRoute: POST /:id/delegate 权限与校验', () => {
  it('无 JWT → 401', async () => {
    mockActor = null;
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/delegate')
      .send({ toUserId: 'u_delegate', reason: LONG_DELEGATE_REASON });
    expect(res.status).toBe(401);
  });

  it('非当前审批人调用 → 403 DELEGATION_NOT_BY_REVIEWER（BASE-39-B2：申请人/被委托人抢单均拦截）', async () => {
    mockActor = { userId: 'u_other', roles: ['manager'] };
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/delegate')
      .send({ toUserId: 'u_delegate', reason: LONG_DELEGATE_REASON });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('DELEGATION_NOT_BY_REVIEWER');
  });

  it('委派给申请人 → 403（防自审）', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/delegate')
      .send({ toUserId: 'u_requester', reason: LONG_DELEGATE_REASON });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('自审');
  });

  it('reason < 10 字 → 400', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/delegate')
      .send({ toUserId: 'u_delegate', reason: '请假' });
    expect(res.status).toBe(400);
  });

  it('toUserId === 当前审批人 → 400', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/delegate')
      .send({ toUserId: 'u_reviewer', reason: LONG_DELEGATE_REASON });
    expect(res.status).toBe(400);
  });

  it('toUserId 用户停用/不存在 → 400', async () => {
    const { app } = makeApp({ activeUsers: ['u_reviewer'] });
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/delegate')
      .send({ toUserId: 'u_delegate', reason: LONG_DELEGATE_REASON });
    expect(res.status).toBe(400);
  });

  it('非 pending → 409', async () => {
    const { app } = makeApp({ existing: { ...baseApproval, status: 'approved' } });
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/delegate')
      .send({ toUserId: 'u_delegate', reason: LONG_DELEGATE_REASON });
    expect(res.status).toBe(409);
  });

  it('成功路径：写 delegated 三字段 + 换 reviewer + AuditLog 同事务', async () => {
    const { app, prisma, approvalUpdate, auditCreate } = makeApp();
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/delegate')
      .send({ toUserId: 'u_delegate', reason: LONG_DELEGATE_REASON });
    expect(res.status).toBe(200);

    const data = approvalUpdate.mock.calls[0][0].data;
    expect(data.delegatedBy).toBe('u_reviewer');
    expect(data.delegatedAt).toBeInstanceOf(Date);
    expect(data.delegateReason).toBe(LONG_DELEGATE_REASON);
    expect(data.reviewerId).toBe('u_delegate');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const audit = auditCreate.mock.calls[0][0].data;
    expect(audit.action).toBe('delegate_approval');
    expect(audit.actorId).toBe('u_reviewer');
    expect(audit.beforeValue).toBe('u_reviewer');
    expect(audit.afterValue).toBe('u_delegate');
  });
});

describe('approvalKernelRoute: POST /:id/boss-bypass 权限与校验', () => {
  it('owner 自己申请也不能用长理由特批：403，零决定、零审计、零 resolved', async () => {
    mockActor = { userId: 'u_requester', roles: ['owner'] };
    const { app, approvalUpdate, auditCreate } = makeApp();
    const resolved = vi.fn();
    approvalEventBus.on('resolved', resolved);
    try {
      const response = await request(app).post('/api/v1/approvals-kernel/ar_1/boss-bypass').send({ reason: LONG_BOSS_REASON, ...reviewedBase });
      expect(response.status).toBe(403);
      expect(response.body.error).toContain('自审');
      expect(approvalUpdate).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
      expect(resolved).not.toHaveBeenCalled();
    } finally { approvalEventBus.off('resolved', resolved); }
  });

  it('非 owner（manager）→ 403 BOSS_BYPASS_REQUIRES_OWNER', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/boss-bypass')
      .send({ reason: LONG_BOSS_REASON, ...reviewedBase });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('BOSS_BYPASS_REQUIRES_OWNER');
  });

  it('系统管理员 admin 也不许写 bossFinalBypass（BASE-39-B3 绝密级）→ 403', async () => {
    mockActor = { userId: 'u_admin', roles: ['admin'] };
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/boss-bypass')
      .send({ reason: LONG_BOSS_REASON, ...reviewedBase });
    expect(res.status).toBe(403);
  });

  it('reason < 30 字 → 400（fail-closed）', async () => {
    mockActor = { userId: 'u_boss', roles: ['owner'] };
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/boss-bypass')
      .send({ reason: '客户要货急，特批' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('30');
  });

  it('非 pending → 409', async () => {
    mockActor = { userId: 'u_boss', roles: ['owner'] };
    const { app } = makeApp({ existing: { ...baseApproval, status: 'rejected' } });
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/boss-bypass')
      .send({ reason: LONG_BOSS_REASON, ...reviewedBase });
    expect(res.status).toBe(409);
  });

  it('reviewed content version is stale → 409 with no decision or audit write', async () => {
    mockActor = { userId: 'u_boss', roles: ['owner'] };
    const { app, approvalUpdate, auditCreate } = makeApp({
      existing: { ...baseApproval, payload: { summary: '内容在审阅后发生了变化' } },
    });
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/boss-bypass')
      .send({ reason: LONG_BOSS_REASON, ...reviewedBase });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('审批依据已变化');
    expect(approvalUpdate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('成功路径：status=approved + bossFinalBypass 三字段 + decisionNote 前缀 + AuditLog', async () => {
    mockActor = { userId: 'u_boss', roles: ['owner'] };
    const { app, approvalUpdate, auditCreate } = makeApp();
    const res = await request(app)
      .post('/api/v1/approvals-kernel/ar_1/boss-bypass')
      .send({ reason: LONG_BOSS_REASON, ...reviewedBase });
    expect(res.status).toBe(200);

    const data = approvalUpdate.mock.calls[0][0].data;
    expect(data.status).toBe('approved');
    expect(data.decidedAt).toBeInstanceOf(Date);
    expect(data.bossFinalBypassBy).toBe('u_boss');
    expect(data.bossFinalBypassAt).toBeInstanceOf(Date);
    expect(data.bossFinalBypassReason).toBe(LONG_BOSS_REASON);
    expect(data.decisionNote.startsWith('[BOSS_FINAL_BYPASS] ')).toBe(true);

    const audit = auditCreate.mock.calls[0][0].data;
    expect(audit.action).toBe('boss_final_bypass');
    expect(audit.actorId).toBe('u_boss');
    expect(audit.beforeValue).toBe('pending');
    expect(audit.afterValue).toBe('approved');
  });

  it('成功路径 → emit approvalEventBus resolved（跨链路唤醒挂起 Agent）', async () => {
    mockActor = { userId: 'u_boss', roles: ['owner'] };
    const emitSpy = vi.spyOn(approvalEventBus, 'emit').mockReturnValue(true);
    try {
      const { app } = makeApp();
      const res = await request(app)
        .post('/api/v1/approvals-kernel/ar_1/boss-bypass')
        .send({ reason: LONG_BOSS_REASON, ...reviewedBase });
      expect(res.status).toBe(200);
      expect(emitSpy).toHaveBeenCalledWith('resolved', 'ar_1', {
        decision: 'approved',
        decisionNote: `[BOSS_FINAL_BYPASS] ${LONG_BOSS_REASON}`,
      });
    } finally {
      emitSpy.mockRestore();
    }
  });

  it('非 pending 409 → 不 emit（失败路径零副作用）', async () => {
    mockActor = { userId: 'u_boss', roles: ['owner'] };
    const emitSpy = vi.spyOn(approvalEventBus, 'emit').mockReturnValue(true);
    try {
      const { app } = makeApp({ existing: { ...baseApproval, status: 'rejected' } });
      await request(app)
        .post('/api/v1/approvals-kernel/ar_1/boss-bypass')
        .send({ reason: LONG_BOSS_REASON, ...reviewedBase });
      expect(emitSpy).not.toHaveBeenCalled();
    } finally {
      emitSpy.mockRestore();
    }
  });
});

describe('approvalKernelRoute: GET /:id/resolution-trace 角色守卫', () => {
  it('sales 角色 → 403', async () => {
    mockActor = { userId: 'u_sales', roles: ['sales'] };
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/approvals-kernel/ar_1/resolution-trace');
    expect(res.status).toBe(403);
  });

  it.each(['owner', 'admin', 'manager'])('角色 %s → 200 且返回审计字段', async (role) => {
    mockActor = { userId: 'u_reader', roles: [role] };
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/approvals-kernel/ar_1/resolution-trace');
    expect(res.status).toBe(200);
    expect(res.body.item.reviewerResolverRoute).toBe('DEPT_HEAD');
    expect(res.body.item.departmentSnapshotId).toBe('dept_garment');
    expect(res.body.item).toHaveProperty('delegatedBy');
    expect(res.body.item).toHaveProperty('bossFinalBypassBy');
    expect(res.body.item).toHaveProperty('bypassedApprovalId');
    expect(res.body.item).toHaveProperty('clientReviewerIdSupplied');
  });

  it('审批单不存在 → 404', async () => {
    const { app } = makeApp({ existing: null });
    const res = await request(app).get('/api/v1/approvals-kernel/ar_missing/resolution-trace');
    expect(res.status).toBe(404);
  });
});
