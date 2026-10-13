/**
 * 权限矩阵全组合审计 P2 — reconciliation 域 finance:read 门测试（2026-09-03）
 *
 * 锁定：四单对账端点此前仅 module 认证门，QC（无 finance:read）可拉取财务差异清单。
 * 2026-09-03 起挂 finance:read——QC → 403，owner 直通，无凭证 → 401。
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createReconciliationRouter } from '../reconciliationRoute';
import { authHeader } from '../../__tests__/authTestHelper';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
// QC 语义 token：显式 permissions（无 invoices:read / vouchers:read）——QC_BASE 无两 scope
const qcToken = jwt.sign({ userId: 'u_qc', roles: [], permissions: ['qc:read', 'orders:read', 'shipments:read'] }, JWT_SECRET);
// logistics：legacy 映射 → LOGISTICS_BASE 持 invoices:read / vouchers:read
const logisticsToken = jwt.sign({ userId: 'u_logistics', roles: ['logistics'] }, JWT_SECRET);

function makeApp() {
  const prisma: any = {};
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reconciliation', createReconciliationRouter({ prisma, requireAuth: true, apiKeys: new Set(['k']) }));
  return app;
}

describe('reconciliation finance:read 门（P2）', () => {
  it('无凭证 → 401', async () => {
    const res = await request(makeApp()).get('/api/v1/reconciliation/discrepancies');
    expect(res.status).toBe(401);
  });

  it('QC 语义（无 invoices:read/vouchers:read）→ 403', async () => {
    const res = await request(makeApp()).get('/api/v1/reconciliation/discrepancies').set({ Authorization: `Bearer ${qcToken}` });
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('invoices:read');
  });

  it('logistics（持 invoices:read）→ 非 403（门放行）', async () => {
    const res = await request(makeApp()).get('/api/v1/reconciliation/discrepancies').set({ Authorization: `Bearer ${logisticsToken}` });
    expect(res.status).not.toBe(403);
  });

  it('owner（SuperAdmin 直通）→ 非 403（门放行）', async () => {
    const res = await request(makeApp()).get('/api/v1/reconciliation/discrepancies').set(authHeader());
    expect(res.status).not.toBe(403);
  });
});
