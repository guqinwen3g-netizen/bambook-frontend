/**
 * 权限矩阵全组合审计 P1-2 — 报表运行快照数据集域 scope 门测试（2026-09-03）
 *
 * 锁定：GET /runs/:id（rows 快照）与 /runs/:id/export.csv 对财务数据集（invoices/
 * paymentVouchers/vatInvoices/outwardRemittances）需对应域读 scope——QC（无
 * invoices:read/vouchers:read/vat:read/remit:read）→ 403；orders 等全员可读数据集不受额外拦截。
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createReportingRouter } from '../route';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
// QC 语义：持 reports:read 但无财务读 scope
const qcToken = jwt.sign({ userId: 'u_qc', roles: [], permissions: ['reports:read', 'orders:read', 'qc:read'] }, JWT_SECRET);
// logistics：映射 → LOGISTICS_BASE 持 invoices:read / vouchers:read
const logisticsToken = jwt.sign({ userId: 'u_logistics', roles: ['logistics'] }, JWT_SECRET);

function makeApp(datasetKey: string) {
  const prisma: any = {
    reportRun: {
      findUnique: async () => ({
        id: 'RPR__1',
        definitionId: 'RPD__1',
        definitionName: '发票汇总',
        status: 'Success',
        trigger: 'manual',
        columns: ['invoiceNumber', 'amount'],
        columnLabels: ['发票号', '金额'],
        rows: [{ invoiceNumber: 'INV-001', amount: 100 }],
        rowCount: 1,
        createdAt: 0,
      }),
    },
    reportDefinition: {
      findUnique: async () => ({ id: 'RPD__1', datasetKey }),
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/v1/reports', createReportingRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
  return app;
}

describe('报表运行快照数据集域 scope 门（P1-2）', () => {
  it('invoices 数据集 + QC（无 invoices:read）→ 详情 403', async () => {
    const res = await request(makeApp('invoices')).get('/v1/reports/runs/RPR__1').set({ Authorization: `Bearer ${qcToken}` });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('invoices:read');
  });

  it('invoices 数据集 + QC → 导出 CSV 403', async () => {
    const res = await request(makeApp('invoices')).get('/v1/reports/runs/RPR__1/export.csv').set({ Authorization: `Bearer ${qcToken}` });
    expect(res.status).toBe(403);
  });

  it('invoices 数据集 + logistics（持 invoices:read）→ 详情放行', async () => {
    const res = await request(makeApp('invoices')).get('/v1/reports/runs/RPR__1').set({ Authorization: `Bearer ${logisticsToken}` });
    expect(res.status).not.toBe(403);
  });

  it('orders 数据集 + QC（全员可读）→ 详情放行（不受额外拦截）', async () => {
    const res = await request(makeApp('orders')).get('/v1/reports/runs/RPR__1').set({ Authorization: `Bearer ${qcToken}` });
    expect(res.status).not.toBe(403);
  });
});
