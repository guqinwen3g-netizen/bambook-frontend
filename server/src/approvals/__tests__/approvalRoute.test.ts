import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createApprovalRouter } from '../approvalRoute';
import { approvalReviewContentVersion } from '../approvalDecisionService';
import { approvalReviewPreviewDigest } from '../approvalReviewDetailService';
import { approvalEventBus } from '../../agent/events';

/**
 * 业务审批中心路由契约测试（PRD 19.21 + 9.6）：
 *   - JWT 强制（无 token 401；API-Key 不接受）
 *   - 角色门禁（requireAuth=true 时仅 owner/admin/manager）
 *   - GET / 待办/已办视图 + 排除 tool:* Agent 工具审批
 *   - POST /:id/decide 输入校验 / 404 / 409 重复决策 / 403 自审 / 审计日志
 */

// 可控的 actor mock：默认 manager 角色的 JWT 用户
let mockActor: { userId: string; roles: string[] } | null = { userId: 'u_reviewer', roles: ['manager'] };
vi.mock('../../auth/middleware', () => ({
  extractActorFromRequest: () => mockActor,
}));

function makeApp(opts: {
  existing?: any;
  auditLogs?: any[];
  updateFail?: boolean;
  requireAuth?: boolean;
} = {}) {
  let existing = opts.existing ? { ...opts.existing } : null;
  const approvalFindMany = vi.fn().mockResolvedValue([]);
  const read = async ({ where, include }: any) => where.id === existing?.id ? {
    ...existing,
    ...(include ? { requester: { id: existing?.requesterId, displayName: '申请人', email: 'req@x.com' },
      reviewer: { id: existing?.reviewerId, displayName: '审批人', email: 'rev@x.com' } } : {}),
  } : null;
  const approvalFindUnique = vi.fn(read);
  const approvalFindFirst = vi.fn(async ({ where, include }: any) => {
    if (!existing || where.id !== existing.id || existing.actionType?.startsWith('tool:')) return null;
    const visible = (where.OR ?? []).some((scope: any) =>
      scope.requesterId === existing.requesterId
        || (scope.reviewerId !== undefined && scope.reviewerId !== null && scope.reviewerId === existing.reviewerId)
        || (scope.actionType === 'order:main_approval' && Array.isArray(existing.eligibleReviewerIds)
          && existing.eligibleReviewerIds.includes(mockActor?.userId || ''))
        || (scope.status === 'pending' && scope.reviewerId === null && existing.status === 'pending' && existing.reviewerId === null)
        || (scope.bossFinalBypassBy && scope.bossFinalBypassBy === existing.bossFinalBypassBy));
    return visible ? read({ where: { id: existing.id }, include }) : null;
  });
  const auditFindMany = vi.fn().mockResolvedValue(opts.auditLogs ?? []);
  // Keep old data matchers; the write spy now models the kernel's conditional SQL update.
  const approvalUpdate = opts.updateFail ? vi.fn().mockRejectedValue(new Error('UPDATE_BOOM'))
    : vi.fn().mockImplementation(async ({ where, data }: any) => {
      if (!existing || where.status !== existing.status || where.reviewerId !== existing.reviewerId) return { count: 0 };
      existing = { ...existing, ...data }; return { count: 1 };
    });
  const auditCreate = vi.fn().mockResolvedValue({ id: 'AL-1' });
  const prisma: any = {
    approvalRequest: { findMany: approvalFindMany, findFirst: approvalFindFirst, findUnique: approvalFindUnique,
      findUniqueOrThrow: vi.fn(read), updateMany: approvalUpdate },
    userRole: { findMany: vi.fn().mockImplementation(async () => (mockActor?.roles ?? []).map(role => ({ roleId: role }))) },
    paymentRequest: { findUnique: vi.fn(async ({ where }: any) => existing?.targetType === 'PaymentRequest' && where.id === existing.targetId
      ? { id: existing.targetId, ...existing.payload, status: 'Pending', approvalRequestId: existing.id } : null) },
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: auditCreate, findMany: auditFindMany },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (callback: any) => {
      const before = existing;
      try { return await callback(prisma); } catch (error) { existing = before; throw error; }
    }),
  };

  const app = express();
  app.use(express.json());
  app.use('/api/v1/approvals', createApprovalRouter({
    prisma,
    requireAuth: opts.requireAuth ?? true,
  }));

  return { app, prisma, approvalFindMany, approvalFindFirst, approvalFindUnique, approvalUpdate, auditCreate, auditFindMany };
}

const pendingApproval = {
  id: 'ar_1',
  requesterId: 'u_requester',
  reviewerId: null,
  actionType: 'quotation:price-deviation',
  targetType: 'Quotation',
  targetId: 'QT_1',
  status: 'pending',
  risk: 'high',
  payload: { quotationId: 'QT_1', quotationNumber: 'QT-1', deviationPercent: 35, level: 'block',
    hitConditions: ['track-deviation-block'], requestedAt: '2026-08-09T10:00:00Z',
    ruleFindings: [{ key: 'track-deviation-block', level: 'block', reason: '最终报价偏离市场中位价 35%' }] },
  decisionNote: null,
  createdAt: new Date('2026-08-09T10:00:00Z'),
  decidedAt: null,
};
const reviewed = (row: any = pendingApproval) => ({ reviewContentVersion: approvalReviewContentVersion(row),
  reviewPreviewDigest: approvalReviewPreviewDigest(row), confirmedReviewedContent: true });
const approveBody = (row: any = pendingApproval, extra: Record<string, unknown> = {}) => ({ status: 'approved', ...reviewed(row), ...extra });
const rejectBody = (row: any = pendingApproval, rejectionReason = '事实依据不完整', requestedChanges = '补充客户确认文件') => ({
  status: 'rejected', ...reviewed(row), rejectionReason, requestedChanges,
});

beforeEach(() => {
  mockActor = { userId: 'u_reviewer', roles: ['manager'] };
});

describe('approvalRoute: 鉴权与角色门禁', () => {
  it('无 JWT → 401（API-Key 亦不接受）', async () => {
    mockActor = null;
    const { app } = makeApp();
    const res = await request(app)
      .get('/api/v1/approvals')
      .set('x-bambook-api-key', 'some-key');
    expect(res.status).toBe(401);
  });

  it('requireAuth=true 且角色不含审批权（sales）→ 403', async () => {
    mockActor = { userId: 'u_sales', roles: ['sales'] };
    const { app } = makeApp({ requireAuth: true });
    const res = await request(app).get('/api/v1/approvals');
    expect(res.status).toBe(403);
  });

  it.each(['owner', 'admin', 'manager'])('角色 %s → 200', async (role) => {
    mockActor = { userId: 'u_reviewer', roles: [role] };
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/approvals');
    expect(res.status).toBe(200);
  });
});

describe('approvalRoute: 订单主单并行审批冻结详情', () => {
  it('授权域收件人无需通用审批角色也能读冻结快照与处理历史', async () => {
    mockActor = { userId: 'fabric-lead', roles: ['sales'] };
    const orderApproval = {
      id: 'OAP_1', requesterId: 'fabric-lead', reviewerId: null, actionType: 'order:main_approval', targetType: 'Order', targetId: 'ORD_1',
      status: 'pending', risk: 'high', eligibleReviewerIds: ['fabric-lead', 'boss'],
      payload: { round: 2, businessLine: 'fabric', snapshot: { order: { id: 'ORD_1', poNumber: 'PO-1', customer: '客户甲',
        lines: [{ id: 'LINE_1', itemNo: '1', product: '面料A', quantity: '120' }] } } },
      decisionNote: null, createdAt: new Date('2026-10-07T01:00:00Z'), decidedAt: null,
    };
    const { app } = makeApp({ existing: orderApproval, requireAuth: true });
    const response = await request(app).get('/api/v1/approvals/OAP_1/detail');
    expect(response.status).toBe(200);
    expect(response.body.detail).toMatchObject({ schemaVersion: 1, approvalId: 'OAP_1', actionType: 'order:main_approval',
      targetType: 'Order', targetId: 'ORD_1', canApprove: true, decisionHistoryStatus: 'available' });
    expect(response.body.detail.frozen.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'order.poNumber', value: 'PO-1' }),
      expect.objectContaining({ key: 'lines.0.product', value: '面料A' }),
    ]));
    expect(response.body.detail.frozen.previewDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('非冻结授权收件人无法读取审批快照', async () => {
    mockActor = { userId: 'unassigned', roles: ['sales'] };
    const orderApproval = { id: 'OAP_2', requesterId: 'submitter', reviewerId: null, actionType: 'order:main_approval',
      targetType: 'Order', targetId: 'ORD_2', status: 'pending', risk: 'high', eligibleReviewerIds: ['boss'],
      payload: { businessLine: 'garment', snapshot: { order: { id: 'ORD_2', lines: [] } } }, createdAt: new Date(), decidedAt: null };
    const { app } = makeApp({ existing: orderApproval, requireAuth: true });
    const response = await request(app).get('/api/v1/approvals/OAP_2/detail');
    expect(response.status).toBe(404);
  });
});

describe('approvalRoute: GET / 待办/已办列表', () => {
  it('默认待办视图：status=pending + 排除 tool:* + 先到先审', async () => {
    const { app, approvalFindMany } = makeApp();
    const res = await request(app).get('/api/v1/approvals');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
    const args = approvalFindMany.mock.calls[0][0];
    expect(args.where.status).toBe('pending');
    expect(args.where.actionType).toEqual({ not: { startsWith: 'tool:' } });
    expect(args.where.requesterId).toEqual({ not: 'u_reviewer' });
    expect(args.where.OR).toEqual([{ reviewerId: 'u_reviewer' }]);
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('status=done → 已办视图：approved/rejected + 决策时间倒序', async () => {
    const { app, approvalFindMany } = makeApp();
    const res = await request(app).get('/api/v1/approvals?status=done');
    expect(res.status).toBe(200);
    const args = approvalFindMany.mock.calls[0][0];
    expect(args.where.status).toEqual({ in: ['approved', 'rejected', 'cancelled'] });
    expect(args.where.actionType).toEqual({ not: { startsWith: 'tool:' } });
    expect(args.orderBy).toEqual({ decidedAt: 'desc' });
  });
});

describe('approvalRoute: GET /:id 精确详情只读范围', () => {
  it('申请人可用普通业务角色读取自己的冻结申请与 reviewContentVersion', async () => {
    mockActor = { userId: 'u_requester', roles: ['sales'] };
    const { app, approvalFindFirst } = makeApp({ existing: pendingApproval });
    const res = await request(app).get('/api/v1/approvals/ar_1');
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      id: 'ar_1', requesterId: 'u_requester', payload: pendingApproval.payload,
      reviewContentVersion: approvalReviewContentVersion(pendingApproval), businessSyncStatus: 'not_applicable',
      requester: { id: 'u_requester' },
    });
    expect(approvalFindFirst.mock.calls[0][0].where.OR).toEqual([{ requesterId: 'u_requester' }]);
  });

  it('非申请人仅能在既有 reviewer 角色范围内读取；外部申请同态 404', async () => {
    mockActor = { userId: 'u_reviewer', roles: ['manager'] };
    const assigned = { ...pendingApproval, reviewerId: 'u_reviewer' };
    const { app, approvalFindFirst } = makeApp({ existing: assigned });
    const res = await request(app).get('/api/v1/approvals/ar_1');
    expect(res.status).toBe(200);
    expect(approvalFindFirst.mock.calls[0][0].where.OR).toEqual([
      { requesterId: 'u_reviewer' }, { reviewerId: 'u_reviewer' },
    ]);

    mockActor = { userId: 'u_foreign', roles: ['manager'] };
    const foreign = await request(makeApp({ existing: assigned }).app).get('/api/v1/approvals/ar_1');
    expect(foreign.status).toBe(404);
  });

  it('owner 仅获得未指派待办兜底和本人 BOSS 决议回读，不获得其他已办单', async () => {
    mockActor = { userId: 'u_boss', roles: ['owner'] };
    const pending = makeApp({ existing: pendingApproval });
    expect((await request(pending.app).get('/api/v1/approvals/ar_1')).status).toBe(200);
    expect(pending.approvalFindFirst.mock.calls[0][0].where.OR).toEqual([
      { requesterId: 'u_boss' }, { reviewerId: 'u_boss' }, { status: 'pending', reviewerId: null }, { bossFinalBypassBy: 'u_boss' },
    ]);

    const doneElsewhere = { ...pendingApproval, status: 'approved', reviewerId: 'u_other', decidedAt: new Date(), bossFinalBypassBy: null };
    const hidden = await request(makeApp({ existing: doneElsewhere }).app).get('/api/v1/approvals/ar_1');
    expect(hidden.status).toBe(404);

    const bossDecision = { ...doneElsewhere, bossFinalBypassBy: 'u_boss' };
    const visible = await request(makeApp({ existing: bossDecision }).app).get('/api/v1/approvals/ar_1');
    expect(visible.status).toBe(200);
  });

  it('foreign actor cannot read tool approvals or bypass the JWT requirement', async () => {
    mockActor = { userId: 'u_requester', roles: ['sales'] };
    const toolApproval = { ...pendingApproval, actionType: 'tool:execute' };
    expect((await request(makeApp({ existing: toolApproval }).app).get('/api/v1/approvals/ar_1')).status).toBe(404);
    mockActor = null;
    expect((await request(makeApp({ existing: pendingApproval }).app).get('/api/v1/approvals/ar_1')).status).toBe(401);
  });

  it('OrderChangeRequest continuation is unknown without a matching durable decision/sync audit', async () => {
    mockActor = { userId: 'u_requester', roles: ['sales'] };
    const row = { ...pendingApproval, targetType: 'OrderChangeRequest', status: 'approved',
      reviewerId: 'u_reviewer', decidedAt: new Date('2026-08-09T11:00:00Z') };
    const { app, auditFindMany } = makeApp({ existing: row });
    const res = await request(app).get('/api/v1/approvals/ar_1');
    expect(res.status).toBe(200);
    expect(res.body.item.businessSyncStatus).toBe('unknown');
    expect(auditFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { targetType: 'ApprovalRequest', targetId: 'ar_1' },
    }));
  });

  it.each(['approval_sync_failed', 'approval_sync_completed'])('returns %s only when linked to the exact decision audit', async (syncAction) => {
    mockActor = { userId: 'u_requester', roles: ['sales'] };
    const row = { ...pendingApproval, targetType: 'OrderChangeRequest', status: 'approved',
      reviewerId: 'u_reviewer', decidedAt: new Date('2026-08-09T11:00:00Z'),
      payload: { contentFingerprint: 'fp-1' } };
    const decisionId = 'decision-audit-1';
    const audits = [
      { id: decisionId, targetType: 'ApprovalRequest', targetId: row.id, actorId: 'u_reviewer', action: 'approve_business_request',
        detail: { approvalDecisionFact: { schemaVersion: 1, status: row.status, actionType: row.actionType,
          targetType: row.targetType, targetId: row.targetId, contentFingerprint: 'fp-1',
          decisionActorId: 'u_reviewer', decidedAt: row.decidedAt.toISOString() } } },
      { id: 'sync-audit-1', targetType: 'ApprovalRequest', targetId: row.id, action: syncAction,
        detail: { approvalId: row.id, decisionAuditId: decisionId } },
      { id: 'unrelated-sync', targetType: 'ApprovalRequest', targetId: row.id, action: 'approval_sync_completed',
        detail: { approvalId: row.id, decisionAuditId: 'different-decision' } },
    ];
    const { app } = makeApp({ existing: row, auditLogs: audits });
    const res = await request(app).get('/api/v1/approvals/ar_1');
    expect(res.status).toBe(200);
    expect(res.body.item.businessSyncStatus).toBe(syncAction === 'approval_sync_failed' ? 'failed' : 'completed');
  });

  it('does not trust a matching sync audit when the decision actor fact disagrees with the approval row', async () => {
    mockActor = { userId: 'u_requester', roles: ['sales'] };
    const row = { ...pendingApproval, targetType: 'OrderChangeRequest', status: 'approved',
      reviewerId: 'u_reviewer', decidedAt: new Date('2026-08-09T11:00:00Z'),
      payload: { contentFingerprint: 'fp-1' } };
    const audits = [
      { id: 'decision-audit-1', targetType: 'ApprovalRequest', targetId: row.id, actorId: 'u_other', action: 'approve_business_request',
        detail: { approvalDecisionFact: { schemaVersion: 1, status: row.status, actionType: row.actionType,
          targetType: row.targetType, targetId: row.targetId, contentFingerprint: 'fp-1',
          decisionActorId: 'u_other', decidedAt: row.decidedAt.toISOString() } } },
      { id: 'sync-audit-1', targetType: 'ApprovalRequest', targetId: row.id, action: 'approval_sync_completed',
        detail: { approvalId: row.id, decisionAuditId: 'decision-audit-1' } },
    ];
    const { app } = makeApp({ existing: row, auditLogs: audits });
    const res = await request(app).get('/api/v1/approvals/ar_1');
    expect(res.status).toBe(200);
    expect(res.body.item.businessSyncStatus).toBe('unknown');
  });
});

describe('approvalRoute: POST /:id/decide 输入校验', () => {
  it('status 非法 → 400', async () => {
    const { app } = makeApp({ existing: pendingApproval });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send({ status: 'maybe' });
    expect(res.status).toBe(400);
  });

  it('rejected 缺驳回原因与修改要求 → 400', async () => {
    const { app } = makeApp({ existing: pendingApproval });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send({ status: 'rejected', ...reviewed() });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('驳回原因');
  });

  it('审批单不存在 → 404', async () => {
    const { app } = makeApp({ existing: null });
    const res = await request(app)
      .post('/api/v1/approvals/ar_missing/decide')
      .send(approveBody());
    expect(res.status).toBe(404);
  });

  it('已处理审批单 → 409 不可重复决策', async () => {
    const { app } = makeApp({ existing: { ...pendingApproval, status: 'approved' } });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send(rejectBody({ ...pendingApproval, status: 'approved' }));
    expect(res.status).toBe(409);
  });

  it('申请人审批自己的单子 → 403 自审禁止', async () => {
    mockActor = { userId: 'u_requester', roles: ['owner'] }; // 与 requesterId 相同
    const { app } = makeApp({ existing: pendingApproval });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send(approveBody());
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('自审');
  });
});

describe('approvalRoute: POST /:id/decide 跨链路唤醒（approvalEventBus）', () => {
  let emitSpy: { mockRestore(): void };

  beforeEach(() => {
    emitSpy = vi.spyOn(approvalEventBus, 'emit').mockReturnValue(true);
  });

  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('decide approved → emit resolved（agentLoop 按 id 匹配可恢复挂起循环）', async () => {
    const { app } = makeApp({ existing: pendingApproval });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send(approveBody());
    expect(res.status).toBe(200);
    expect(emitSpy).toHaveBeenCalledWith('resolved', 'ar_1', {
      decision: 'approved',
      decisionNote: undefined,
    });
  });

  it('decide rejected（含意见）→ emit resolved 携带 decisionNote', async () => {
    const { app } = makeApp({ existing: pendingApproval });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send(rejectBody(pendingApproval, '折扣超限', '重新核算偏差并提交客户可接受价格'));
    expect(res.status).toBe(200);
    expect(emitSpy).toHaveBeenCalledWith('resolved', 'ar_1', {
      decision: 'rejected',
      decisionNote: '驳回原因：折扣超限\n需要修改的内容：重新核算偏差并提交客户可接受价格',
    });
  });

  it('409 重复决策 / 403 自审 / 404 不存在 → 不 emit（失败路径零副作用）', async () => {
    const { app: app409 } = makeApp({ existing: { ...pendingApproval, status: 'approved' } });
    await request(app409).post('/api/v1/approvals/ar_1/decide').send(approveBody({ ...pendingApproval, status: 'approved' }));
    const { app: app403 } = makeApp({ existing: pendingApproval });
    mockActor = { userId: 'u_requester', roles: ['manager'] };
    await request(app403).post('/api/v1/approvals/ar_1/decide').send(approveBody());
    const { app: app404 } = makeApp({ existing: null });
    await request(app404).post('/api/v1/approvals/ar_missing/decide').send(approveBody());
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe('approvalRoute: POST /:id/decide 决策落库', () => {
  it('approved → 200 + 写入 reviewer/decidedAt + 审计日志同事务', async () => {
    const { app, approvalUpdate, auditCreate, prisma } = makeApp({ existing: pendingApproval });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send(approveBody());
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('approved');

    const updateData = approvalUpdate.mock.calls[0][0].data;
    expect(updateData.status).toBe('approved');
    expect(updateData.reviewerId).toBe('u_reviewer');
    expect(updateData.decisionNote).toBeNull();
    expect(updateData.decidedAt).toBeInstanceOf(Date);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const auditData = auditCreate.mock.calls[0][0].data;
    expect(auditData.action).toBe('approve_business_request');
    expect(auditData.actorId).toBe('u_reviewer');
    expect(auditData.targetType).toBe('ApprovalRequest');
    expect(auditData.targetId).toBe('ar_1');
    expect(auditData.beforeValue).toBe('pending');
    expect(auditData.afterValue).toBe('approved');
    expect(auditData.detail.actionType).toBe('quotation:price-deviation');
  });

  it('rejected + decisionNote → 200 + 审计 action=reject_business_request', async () => {
    const { app, approvalUpdate, auditCreate } = makeApp({ existing: pendingApproval });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send(rejectBody(pendingApproval, '偏差过大', '重新谈价并提交客户确认'));
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('rejected');
    expect(approvalUpdate.mock.calls[0][0].data.decisionNote).toBe('驳回原因：偏差过大\n需要修改的内容：重新谈价并提交客户确认');
    expect(auditCreate.mock.calls[0][0].data.action).toBe('reject_business_request');
  });

  it('DB 异常 → 500', async () => {
    const { app } = makeApp({ existing: pendingApproval, updateFail: true });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send(approveBody());
    expect(res.status).toBe(500);
  });
});

describe('approvalRoute: POST /:id/decide 决议人归属校验（S3-δ · approvalDecisionService）', () => {
  // DR-007 已指派单：reviewerId 为服务端路由落点（pay_gt5 上抬档场景 = 落点总领导）
  const routedApproval = (reviewerId: string) => ({
    ...pendingApproval,
    reviewerId,
    actionType: 'finance:payment_request',
    targetType: 'PaymentRequest', targetId: 'PAYR_1',
    payload: { requestNumber: 'PAYR-1', totalAmount: '100000', currency: 'CNY',
      paymentCategory: 'supplier', supplierId: 'supplier-1', supplierName: '测试供应商' },
  });

  it('SM 决议路由给总领导档的单（reviewerId=u_gm）→ 403 APPROVAL_NOT_ASSIGNED', async () => {
    mockActor = { userId: 'u_sm', roles: ['manager'] };
    const { app, approvalUpdate } = makeApp({ existing: routedApproval('u_gm') });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send(approveBody(routedApproval('u_gm')));
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('APPROVAL_NOT_ASSIGNED');
    expect(approvalUpdate).not.toHaveBeenCalled();
  });

  it('SM 决议本档位单（reviewerId=本人）→ 放行 200 并落库', async () => {
    mockActor = { userId: 'u_sm', roles: ['manager'] };
    const { app, approvalUpdate } = makeApp({ existing: routedApproval('u_sm') });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send(approveBody(routedApproval('u_sm'), { decisionNote: '本团队小单，同意' }));
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('approved');
    expect(approvalUpdate.mock.calls[0][0].data.reviewerId).toBe('u_sm');
  });

  it('指定 reviewer 的单被其他 manager 决议 → 403', async () => {
    mockActor = { userId: 'u_reviewer', roles: ['manager'] };
    const { app, approvalUpdate } = makeApp({ existing: routedApproval('u_other') });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send(rejectBody(routedApproval('u_other'), '越权驳回尝试', '不得执行'));
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('APPROVAL_NOT_ASSIGNED');
    expect(approvalUpdate).not.toHaveBeenCalled();
  });

  it('owner（BOSS 兜底）决议他人单 → 200（与内核 boss-bypass 同一角色口径）', async () => {
    mockActor = { userId: 'u_boss', roles: ['owner'] };
    const { app } = makeApp({ existing: routedApproval('u_gm') });
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send(approveBody(routedApproval('u_gm'), { decisionNote: 'BOSS 兜底决议' }));
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('approved');
  });

  it('legacy 未指派单（reviewerId=null）→ 不额外拦截，角色门禁放行 200', async () => {
    mockActor = { userId: 'u_reviewer', roles: ['manager'] };
    const { app } = makeApp({ existing: pendingApproval }); // reviewerId: null
    const res = await request(app)
      .post('/api/v1/approvals/ar_1/decide')
      .send(approveBody());
    expect(res.status).toBe(200);
  });
});
