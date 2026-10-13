/**
 * P4-1 P1-#1（2026-09-15）— 报表「出数动作」数据集域 scope 门测试
 *
 * 背景与锁定的契约：
 *   P1-2（runsScope.test.ts）已给「运行快照读取」加门——GET /runs/:id 与 export.csv 对
 *   invoices / paymentVouchers / vatInvoices / outwardRemittances / taxRefunds 需对应域读 scope。
 *   但 POST /preview、POST /drill、POST /definitions/:id/run 三条**出数路径**此前只有
 *   reports:write —— 同一份财务明细，「跑完再看」被拦、「直接预览/下钻/手动跑」不拦，属同道两制。
 *
 * 本测试锁定：三条出数路径与快照读取同口径；orders 等全员可读数据集不受额外拦截；
 * 且拦截发生在**产生快照之前**（不留下含明细的 ReportRun 行）。
 */
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createReportingRouter } from '../route';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
// QC 语义：持 reports:write（能进报表设计器）但无财务读 scope
const qcToken = jwt.sign(
  { userId: 'u_qc', roles: [], permissions: ['reports:read', 'reports:write', 'orders:read', 'qc:read'] },
  JWT_SECRET,
);
// 财务：映射 → FINANCE_BASE 持 reports:write ＋ invoices:read（放行基准：证明新门不误伤合法主体）
const financeToken = jwt.sign({ userId: 'u_finance', roles: ['finance'] }, JWT_SECRET);
// 仓储：持 reports:read/write ＋ inventory:read（证明库存数据集对合法主体放行，不误伤）
const warehouseToken = jwt.sign(
  { userId: 'u_wh', roles: [], permissions: ['reports:read', 'reports:write', 'inventory:read'] },
  JWT_SECRET,
);

const PREVIEW_BODY = {
  datasetKey: 'invoices',
  dimensions: ['currency'],
  metrics: [{ field: 'amount', agg: 'sum' }],
};

function makeApp(datasetKey: string) {
  const runCreate = vi.fn(async () => ({ id: 'RPR__new' }));
  const prisma: any = {
    invoice: { groupBy: async () => [], aggregate: async () => ({}) },
    order: { groupBy: async () => [], aggregate: async () => ({}) },
    inventoryItem: { groupBy: async () => [], aggregate: async () => ({}) },
    reportDefinition: {
      findUnique: async () => ({
        id: 'RPD__1',
        datasetKey,
        name: '发票汇总',
        deletedAt: null,
        schedule: null,
        enabled: true,
      }),
    },
    reportRun: { create: runCreate, findUnique: async () => null, findMany: async () => [], count: async () => 0 },
    auditLog: { create: async () => ({}) },
  };
  const app = express();
  app.use(express.json());
  app.use('/v1/reports', createReportingRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
  return { app, runCreate };
}

describe('报表出数路径数据集域 scope 门（P4-1 P1-#1）', () => {
  it('invoices 数据集 + QC（无 invoices:read）→ 预览 403', async () => {
    const res = await request(makeApp('invoices').app)
      .post('/v1/reports/preview')
      .set({ Authorization: `Bearer ${qcToken}` })
      .send(PREVIEW_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(res.body.error.message).toContain('invoices:read');
  });

  it('invoices 数据集 + QC → 下钻 403（下钻返回明细行，比聚合更敏感）', async () => {
    const res = await request(makeApp('invoices').app)
      .post('/v1/reports/drill')
      .set({ Authorization: `Bearer ${qcToken}` })
      .send({ ...PREVIEW_BODY, group: { currency: 'USD' } });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('invoices:read');
  });

  it('invoices 数据集 + QC → 手动运行 403，且不产生含明细的运行快照', async () => {
    const { app, runCreate } = makeApp('invoices');
    const res = await request(app)
      .post('/v1/reports/definitions/RPD__1/run')
      .set({ Authorization: `Bearer ${qcToken}` })
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('invoices:read');
    expect(runCreate).not.toHaveBeenCalled();
  });

  it('invoices 数据集 + 财务（持 reports:write ＋ invoices:read）→ 预览放行', async () => {
    const res = await request(makeApp('invoices').app)
      .post('/v1/reports/preview')
      .set({ Authorization: `Bearer ${financeToken}` })
      .send(PREVIEW_BODY);
    expect(res.status).toBe(200);
  });

  it('orders 数据集（全员可读）+ QC → 预览/下钻放行，不受额外拦截', async () => {
    const { app } = makeApp('orders');
    const body = { ...PREVIEW_BODY, datasetKey: 'orders' };
    const prev = await request(app).post('/v1/reports/preview').set({ Authorization: `Bearer ${qcToken}` }).send(body);
    expect(prev.status).not.toBe(403);
    const drill = await request(app).post('/v1/reports/drill').set({ Authorization: `Bearer ${qcToken}` }).send(body);
    expect(drill.status).not.toBe(403);
  });

  // ── 库存数据集：含**单位成本（金额）** → 与财务数据集同口径收窄 ──────────
  // 2026-09-16 新增：inventoryItems 注册进报表引擎时一并加门，
  // 否则持 reports:write 而无 inventory:read 的角色可经报表读到库存成本。
  it('inventoryItems 数据集 + QC（无 inventory:read）→ 预览 403', async () => {
    const body = {
      datasetKey: 'inventoryItems',
      dimensions: ['ownership', 'unit'],
      metrics: [{ field: 'unitCost', agg: 'avg' }],
    };
    const res = await request(makeApp('inventoryItems').app)
      .post('/v1/reports/preview')
      .set({ Authorization: `Bearer ${qcToken}` })
      .send(body);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(res.body.error.message).toContain('inventory:read');
  });

  it('inventoryItems 数据集 + 持 inventory:read 的角色 → 预览放行', async () => {
    const body = {
      datasetKey: 'inventoryItems',
      dimensions: ['ownership', 'unit'],
      metrics: [{ field: 'unitCost', agg: 'avg' }],
    };
    const res = await request(makeApp('inventoryItems').app)
      .post('/v1/reports/preview')
      .set({ Authorization: `Bearer ${warehouseToken}` })
      .send(body);
    expect(res.status).toBe(200);
  });
});
