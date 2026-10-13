import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ownerToken } from '../../__tests__/authTestHelper';
import { fabricAuthorizationFixture } from '../../development/__tests__/fabricAuthorizationFixture';

/**
 * P2-3 回归：报价审批端点（条目级 / 总价）先建单、后写审计。
 * 原实现把两者放在同一个 try —— 审计写失败会返回 500 `APPROVAL_CREATE_FAILED`，
 * 但审批单其实已经创建成功；调用方见到 500 重试 → 重复建单（状态不一致）。
 *
 * 契约：动作已成功时不得伪报失败（审计缺口用 error 日志显性化，fail-open 留痕）；
 * 而「审批服务本身失败」仍必须 500（真实失败不得被吞）。
 */

const auditMock = vi.hoisted(() => ({ writeRouteAuditLog: vi.fn() }));
vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: auditMock.writeRouteAuditLog,
  actorIdFromRequest: () => 'u_sales',
}));

const approvalMock = vi.hoisted(() => ({
  requestLineApproval: vi.fn(),
  requestTotalApproval: vi.fn(),
  getApprovalStatus: vi.fn(),
}));
vi.mock('../quotationApproval', () => ({
  createQuotationApprovalService: vi.fn(() => approvalMock),
}));

import { createQuotationRouter } from '../quotationRoute';
import { logger } from '../../lib/logger';

function makeApp() {
  const app = express();
  app.use(express.json());
  // 注入 owner JWT（SuperAdmin 全放行），保持「测业务、不测门禁」语义
  app.use((req, _res, next) => {
    if (!req.headers.authorization) req.headers.authorization = `Bearer ${ownerToken}`;
    next();
  });
  app.use('/api/v1/quotations', createQuotationRouter({
    prisma: { ...fabricAuthorizationFixture('u_owner'), quotation: { findFirst: async () => ({ id: 'QT-1', ownerId: 'u_owner', customerRelationId: null, deletedAt: null }) } } as any,
    requireAuth: false,
    apiKeys: new Set<string>(),
    onDataChange: vi.fn(),
  }));
  return app;
}

describe('quotationRoute 审批端点 · 审计失败不伪报 500（P2-3）', () => {
  let errSpy: any;
  beforeEach(() => {
    approvalMock.requestLineApproval.mockResolvedValue({ approval: { id: 'APR-1' }, line: { id: 'QL-1' } });
    approvalMock.requestTotalApproval.mockResolvedValue({
      autoApproved: false, totalStatus: 'pending', totalApproval: { id: 'APR-2' }, lineStatuses: [],
    });
    errSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('条目级：审计抛错仍返回 200 + approvalId，并留 error 日志', async () => {
    auditMock.writeRouteAuditLog.mockRejectedValue(new Error('AUDIT_BOOM'));
    const res = await request(makeApp()).post('/api/v1/quotations/QT-1/lines/QL-1/request-approval').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.approvalId).toBe('APR-1');
    expect(errSpy).toHaveBeenCalled();
  });

  it('总价级：审计抛错仍返回 200 + totalApprovalId，并留 error 日志', async () => {
    auditMock.writeRouteAuditLog.mockRejectedValue(new Error('AUDIT_BOOM'));
    const res = await request(makeApp()).post('/api/v1/quotations/QT-1/request-total-approval').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.totalApprovalId).toBe('APR-2');
    expect(errSpy).toHaveBeenCalled();
  });

  it('对照：审批服务本身失败仍返回 500（真实失败不得被吞）', async () => {
    approvalMock.requestLineApproval.mockRejectedValue(new Error('DB_BOOM'));
    auditMock.writeRouteAuditLog.mockResolvedValue('alog_1');
    const res = await request(makeApp()).post('/api/v1/quotations/QT-1/lines/QL-1/request-approval').send({});
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('APPROVAL_CREATE_FAILED');
  });
});
