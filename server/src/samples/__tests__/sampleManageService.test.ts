/**
 * sampleManageService.test.ts — 样品管理域（DR-052）服务测试
 *
 * 覆盖：CRUD / 设计确认状态机（dev/seal）/ 生产确认状态机（pp 双门禁）/
 *      复刻（fork：设计确认→生产确认）/ 删除。
 */
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createSampleRouter } from '../sampleRoute';
import { authHeader } from '../../__tests__/authTestHelper';
import { logger } from '../../lib/logger';
import {
  createSample, updateSample, deleteSample, advanceSampleStage, forkSample, invoiceSample, listSamples, getSample,
} from '../sampleManageService';

const SAMPLE = {
  id: 'SMP__x', code: 'SMP-20260907-001', type: 'dev', subType: 'fit-sample',
  sourceCaseId: 'C1', sourceOrderId: null, productAssetId: null,
  supplierRelationId: null, supplierName: null, customerRelationId: 'CUS-1',
  status: 'draft', round: 1,
  sentDate: null, courier: null, trackingNumber: null, shippingFee: null,
  recipientName: null, recipientCompany: null, recipientAddress: null, recipientPhone: null,
  feedback: null, feedbackDate: null, approvedAt: null, approvedBy: null,
  qcStatus: null, qcInspectionReportId: null, customerStatus: null,
  forkedFromSampleId: null, invoiceId: null, notes: null,
  deletedAt: null, createdAt: BigInt(0), updatedAt: BigInt(0),
};

function txMocks(overrides: any = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{id:"C1"}]),
    // Persisted source facts, not a mocked resolver: every specimen in these
    // pre-existing garment controls is tied to this real synthetic context.
    developmentCase: { findMany: vi.fn(async ({ where }: any) => ['C1'].filter(id => where.id.in.includes(id)).map(id => ({ id, type: 'garment', deletedAt: null }))) },
    // Real ship-sample source lock rereads this stored synthetic Order.
    order: {
      findFirst: vi.fn(async ({ where }: any) => where.id === 'ORD-1' ? { id: 'ORD-1', deletedAt: null } : null),
      findMany: vi.fn(async ({ where }: any) => ['ORD-1', 'O'].filter(id => where.id.in.includes(id)).map(id => ({ id, type: 'Garment', businessLine: 'garment', deletedAt: null }))),
    },
    productAsset: { findMany: vi.fn(async ({ where }: any) => ['PA-1', 'PROD-1'].filter(id => where.id.in.includes(id)).map(id => ({ id, mainCategory: 'Garment', garmentProfile: { id: `GP-${id}`, deletedAt: null }, deletedAt: null }))) },
    developmentLifecycleEvent: {findFirst:vi.fn().mockResolvedValue(null)},
    sample: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...SAMPLE, ...data, id: data.id || 'SMP__1' })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...SAMPLE, ...data, id: where.id })),
    },
    orderSampleSource: { findUnique: vi.fn().mockResolvedValue(null) },
    sampleSource: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    sampleCardItem: {findFirst:vi.fn().mockResolvedValue(null)},
    sampleLengthMovement: {findFirst:vi.fn().mockResolvedValue(null)},
    ppSampleRelease: {findFirst:vi.fn().mockResolvedValue(null)},
    orderLine: {findFirst:vi.fn().mockResolvedValue(null)},
    releaseScope: {findFirst:vi.fn().mockResolvedValue(null)},
    costRecord: {findFirst:vi.fn().mockResolvedValue(null)},
    developmentPendingExpense: {findFirst:vi.fn().mockResolvedValue(null)},
    billingItem: {findFirst:vi.fn().mockResolvedValue(null)},
    invoice: {findFirst:vi.fn().mockResolvedValue(null)},
    relation: { findFirst: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'AUD-1' }) },
    ...overrides,
  };
}

/** 有状态 tx：findFirst 返回当前状态，update 回写（用于状态机全链测试） */
function statefulTx(initial: any) {
  let state: any = { ...SAMPLE, ...initial };
  const tx = txMocks({
    sample: {
      ...txMocks().sample,
      findFirst: vi.fn(async () => state),
      update: vi.fn(async ({ where, data }: any) => {
        state = { ...state, ...data, id: where.id };
        return state;
      }),
    },
  });
  return tx;
}

function makeApp(opts: { tx?: any } = {}) {
  const tx = opts.tx ?? txMocks();
  // 读路径走 prisma 直查、写路径走 $transaction(fn(tx))：把 tx 全部模型代理到 prisma 层
  const prisma: any = {
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  for (const model of Object.keys(tx)) {
    prisma[model] = tx[model];
  }
  const onDataChange = vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/samples', createSampleRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange }));
  return { app, tx, onDataChange };
}

describe('DR-052 样品管理域 CRUD', () => {
  it.each(['/fabric/ORD-1/shipment-sample', '/fabric/ORD-1/head-sample', '/early-production/ORD-1/rounds'])('旧订单登记 %s 返回明确退役，零样品／审计写入及通知', async path => {
    const {app,tx,onDataChange}=makeApp();
    const response=await request(app).post(`/api/v1/samples${path}`).set(authHeader()).send({sampleQuantity:1});
    expect(response.status).toBe(410); expect(response.body.error.code).toBe('GONE');
    expect(tx.sample.create).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });
  it('登记跳过已被软删样品占用的编号，不回收旧号', async () => {
    const tx = txMocks();
    const year = new Date().getFullYear();
    let seq = 0;
    tx.businessSequence = {
      upsert: vi.fn(async () => ({ seq })),
      update: vi.fn(async () => ({ seq: ++seq })),
    };
    tx.sample.findFirst.mockImplementation(async ({ where }: any) =>
      where.code === `SM-${year}-0001` ? { id: 'deleted-sample', deletedAt: 1n } : null);
    const prisma: any = { $transaction: async (fn: any) => fn(tx) };
    const result = await createSample({ prisma, input: { type: 'dev' }, actorId: 'U1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.sample.code).toBe(`SM-${year}-0002`);
    expect(tx.sample.findFirst).toHaveBeenCalledWith({ where: { code: `SM-${year}-0001` }, select: { id: true } });
  });

  it('POST / 登记样品（type 必填，其余渐进披露）→ 201', async () => {
    const { app, tx } = makeApp();
    const res = await request(app).post('/api/v1/samples').set(authHeader()).send({
      type: 'dev', subType: 'fit-sample', sourceCaseId: 'C1', customerRelationId: 'CUS-1', notes: '开发样',
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.sample.type).toBe('dev');
    expect(res.body.sample.status).toBe('draft');
    expect(tx.sample.create).toHaveBeenCalled();
  });

  it('非法 type → 400 INVALID_INPUT', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/samples').set(authHeader()).send({ type: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('GET / 列表（type 过滤）', async () => {
    const tx = txMocks({
      sample: { ...txMocks().sample, findMany: vi.fn().mockResolvedValue([SAMPLE]), count: vi.fn().mockResolvedValue(1) },
    });
    const { app } = makeApp({ tx });
    const res = await request(app).get('/api/v1/samples?type=dev').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.samples).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  it('PATCH /:id 更新（备注/归属）', async () => {
    const tx = txMocks({
      sample: { ...txMocks().sample, findFirst: vi.fn().mockResolvedValue({ ...SAMPLE, id: 'SMP__1' }) },
    });
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/samples/SMP__1').set(authHeader()).send({ notes: '更新备注', supplierName: '杭州锦盛' });
    expect(res.status).toBe(200);
    expect(res.body.sample.notes).toBe('更新备注');
  });

  it('DELETE /:id 软删', async () => {
    const tx = txMocks({
      sample: { ...txMocks().sample, findFirst: vi.fn(async ({where}:any)=>where.forkedFromSampleId?null:({ ...SAMPLE, id: 'SMP__1' })) },
    });
    const { app } = makeApp({ tx });
    const res = await request(app).delete('/api/v1/samples/SMP__1').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('DR-052 设计确认状态机（dev/seal）', () => {
  it('dev 全链：draft→making→sent→confirmed→sealed（封样终态）', async () => {
    const tx = statefulTx({ id: 'SMP__1' });
    const { app } = makeApp({ tx });
    let res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'start' });
    expect(res.body.sample.status).toBe('making');
    res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'send', courier: 'DHL', trackingNumber: 'T1' });
    expect(res.body.sample.status).toBe('sent');
    res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'confirm' });
    expect(res.body.sample.status).toBe('confirmed');
    res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'seal' });
    expect(res.body.sample.status).toBe('sealed');
    expect(res.body.sample.approvedBy).not.toBeNull();
  });

  it('revising：sent → revise → start（round+1）', async () => {
    const tx = statefulTx({ id: 'SMP__1', status: 'sent', round: 1 });
    const { app } = makeApp({ tx });
    let res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'revise', feedback: '需调整' });
    expect(res.body.sample.status).toBe('revising');
    res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'start' });
    expect(res.body.sample.status).toBe('making');
    expect(res.body.sample.round).toBe(2);
  });

  it('seal 类型仅设计动作；qc 动作被拒（INVALID_ACTION）', async () => {
    const tx = txMocks({
      sample: { ...txMocks().sample, findFirst: vi.fn().mockResolvedValue({ ...SAMPLE, id: 'SMP__1', type: 'seal', status: 'confirmed' }) },
    });
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'qc' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ACTION');
  });
});

describe('DR-052 生产确认状态机（pp 双门禁）', () => {
  it('pp 全链：draft→making→qc→submitted→confirmed→approved（产前样批准=开裁前置）', async () => {
    const tx = statefulTx({ id: 'SMP__1', type: 'pp' });
    const { app } = makeApp({ tx });
    let res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'start' });
    expect(res.body.sample.status).toBe('making');
    res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'qc', qcStatus: 'passed' });
    expect(res.body.sample.status).toBe('qc');
    expect(res.body.sample.qcStatus).toBe('passed');
    res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'submit', courier: 'DHL', trackingNumber: 'PP1' });
    expect(res.body.sample.status).toBe('submitted');
    res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'confirm', customerStatus: 'approved' });
    expect(res.body.sample.status).toBe('confirmed');
    res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'approve' });
    expect(res.body.sample.status).toBe('approved');
    expect(res.body.sample.approvedAt).not.toBeNull();
  });

  it('§10.3 大货封样：top 样批准（approved）后封样留底——retainLocation 样上登记且不覆盖既有 attachments 键', async () => {
    const tx = statefulTx({
      id: 'SMP__1', type: 'top', status: 'approved',
      sourceOrderId: 'ORD-1', productAssetId: 'PA-1',
      attachments: { batchNo: 'B2026-09', rollNos: ['R1', 'R2'] }, // 阶段 G 大货样明细既有键
    });
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader())
      .send({ action: 'seal', retainLocation: '样品间 A 柜 3 层' });
    expect(res.status).toBe(200);
    expect(res.body.sample.status).toBe('sealed');
    expect(res.body.sample.approvedBy).not.toBeNull();
    expect(res.body.sample.attachments.retainLocation).toBe('样品间 A 柜 3 层');
    expect(res.body.sample.attachments.batchNo).toBe('B2026-09'); // 既有键保留
    expect(res.body.sample.attachments.rollNos).toEqual(['R1', 'R2']);
  });

  it('§10.3 封样前置：生产样 confirmed（未批准）直接 seal → 409 INVALID_TRANSITION', async () => {
    const tx = statefulTx({ id: 'SMP__1', type: 'top', status: 'confirmed', sourceOrderId: 'ORD-1' });
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'seal' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('QC 未通过 → 回退 revising（重做开新轮）', async () => {
    const tx = txMocks({
      sample: { ...txMocks().sample, findFirst: vi.fn().mockResolvedValue({ ...SAMPLE, id: 'SMP__1', type: 'pp', status: 'making' }) },
    });
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'qc', qcStatus: 'failed' });
    expect(res.body.sample.status).toBe('revising');
    expect(res.body.sample.qcStatus).toBe('failed');
  });

  it('客户不通过（rejected）→ 该轮终止', async () => {
    const tx = txMocks({
      sample: { ...txMocks().sample, findFirst: vi.fn().mockResolvedValue({ ...SAMPLE, id: 'SMP__1', type: 'pp', status: 'submitted' }) },
    });
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'confirm', customerStatus: 'rejected' });
    expect(res.body.sample.status).toBe('rejected');
    expect(res.body.sample.customerStatus).toBe('rejected');
  });

  it('§10.3 封样口径：生产样仅批准（approved）后可 seal——confirmed 状态 seal → 409 INVALID_TRANSITION', async () => {
    const tx = txMocks({
      sample: { ...txMocks().sample, findFirst: vi.fn().mockResolvedValue({ ...SAMPLE, id: 'SMP__1', type: 'pp', status: 'confirmed' }) },
    });
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/samples/SMP__1/stage').set(authHeader()).send({ action: 'seal' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });
});

describe('DR-052 复刻（fork：设计确认 → 生产确认）', () => {
  it('seal 封样 → fork pp（产前样，forkedFromSampleId 溯源）', async () => {
    const tx = txMocks({
      sample: { ...txMocks().sample, findFirst: vi.fn().mockResolvedValue({ ...SAMPLE, id: 'SMP__seal', type: 'seal', status: 'sealed', productAssetId: 'PROD-1' }) },
    });
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/samples/SMP__seal/fork').set(authHeader()).send({ toType: 'pp' });
    expect(res.status).toBe(201);
    expect(res.body.sample.type).toBe('pp');
    expect(res.body.sample.forkedFromSampleId).toBe('SMP__seal');
    expect(res.body.sample.sourceOrderId).toBeNull();
  });

  it('生产确认样品不可再 fork → INVALID_FORK_SOURCE', async () => {
    const tx = txMocks({
      sample: { ...txMocks().sample, findFirst: vi.fn().mockResolvedValue({ ...SAMPLE, id: 'SMP__pp', type: 'pp' }) },
    });
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/samples/SMP__pp/fork').set(authHeader()).send({ toType: 'top' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FORK_SOURCE');
  });

  it('fork 目标必须是生产确认类型 → INVALID_FORK_TARGET', async () => {
    const tx = txMocks({
      sample: { ...txMocks().sample, findFirst: vi.fn().mockResolvedValue({ ...SAMPLE, id: 'SMP__seal', type: 'seal' }) },
    });
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/samples/SMP__seal/fork').set(authHeader()).send({ toType: 'dev' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FORK_TARGET');
  });
});

describe('DR-052 §6 产物级开票触点（DR-054 已收口）', () => {
  it('样品直接开票端点 → 410 GONE（开票已收归财务域单入口，scene-invoice 按场景完成）', async () => {
    const { app } = makeApp({ tx: txMocks() });
    const res = await request(app).post('/api/v1/samples/SMP__1/invoice').set(authHeader()).send({ amount: 45.5, currency: 'CNY' });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('GONE');
  });
});

describe('DR-053 阶段 0：开票权限对齐 + 幂等防重复建票', () => {
  const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
  // 仅 products:write 无 invoices:write（SALES 角色口径）
  const salesOnlyToken = jwt.sign({ userId: 'u_sales', roles: ['sales'], permissions: ['products:write'] }, JWT_SECRET);
  const noScopeToken = jwt.sign({ userId: 'u_noscope', roles: [], permissions: [] }, JWT_SECRET);

  // 建票成功路径的完整 mock（createInvoice 依赖：invoiceOrderAllocation/entityReference/entityLink/auditLog）
  function invoiceOkTx(sampleOverrides: any = {}, invoiceOverrides: any = {}) {
    return txMocks({
      sample: {
        ...txMocks().sample,
        findFirst: vi.fn().mockResolvedValue({ ...SAMPLE, id: 'SMP__1', shippingFee: 10 }),
        update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...SAMPLE, ...data, id: where.id, invoiceId: 'INV-1' })),
        ...sampleOverrides,
      },
      invoice: {
        create: vi.fn().mockResolvedValue({ id: 'INV-1', invoiceNumber: 'SMP-INV-A', type: 'Receivable', amount: 10, status: 'Draft' }),
        findFirst: vi.fn().mockResolvedValue(null),
        ...invoiceOverrides,
      },
      relation: { findFirst: vi.fn().mockResolvedValue(null) },
      invoiceOrderAllocation: { create: vi.fn().mockResolvedValue({}) },
      entityReference: { upsert: vi.fn().mockResolvedValue({}) },
      entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    });
  }

  it('只有 products:write 无 invoices:write → 403 INSUFFICIENT_SCOPE（含 invoices:write）', async () => {
    const tx = invoiceOkTx();
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/samples/SMP__1/invoice').set(authHeader(salesOnlyToken)).send({ amount: 10 });
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('INSUFFICIENT_SCOPE');
    expect(res.body.message).toContain('invoices:write');
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  it('无任何 scope → 403 INSUFFICIENT_SCOPE', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/samples/SMP__1/invoice').set(authHeader(noScopeToken)).send({ amount: 10 });
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('INSUFFICIENT_SCOPE');
  });

  it('建票成功但回填失败 → 410 GONE（DR-054 收口：样品直接开票已停用，回填/幂等逻辑随收口不复存在）', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/samples/SMP__1/invoice').set(authHeader()).send({ amount: 10 });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('GONE');
  });
});

// ────────────────────────────────────────────────────────────────────
// DR-054 阶段 G：大货生产样统一 Sample（ship/head/pioneer）+ 生产明细 attachments
// ────────────────────────────────────────────────────────────────────

describe('DR-054 阶段 G：大货生产样统一 Sample', () => {
  it('POST / 独立订单船样缺实际批次来源，拒绝通用登记', async () => {
    const { app, tx } = makeApp();
    const res = await request(app).post('/api/v1/samples').set(authHeader()).send({
      type: 'ship',
      sourceOrderId: 'ORD-1',
      supplierRelationId: 'SUP-1',
      customerRelationId: 'CUS-1',
      attachments: {
        sampleQuantity: 2,
        sampleUnit: 'meter',
        batchNo: 'FB-2026-001',
        cuttingDate: '2026-09-08',
      },
    });
    expect(res.status).toBe(400);
    expect(tx.sample.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('PATCH / 更新生产明细（attachments 整块替换）→ 200', async () => {
    const tx = txMocks({
      sample: {
        ...txMocks().sample,
        findFirst: vi.fn().mockResolvedValue({ ...SAMPLE, id: 'SMP__1', type: 'head', attachments: { sampleQuantity: 1 } }),
      },
    });
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/samples/SMP__1').set(authHeader()).send({
      attachments: { sampleQuantity: 3, rollNos: ['R-1', 'R-2'] },
    });
    expect(res.status).toBe(200);
    expect(tx.sample.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attachments: expect.objectContaining({ rollNos: ['R-1', 'R-2'] }) }),
      }),
    );
  });

  it('POST / 独立订单先锋样缺实际批次来源，拒绝通用登记', async () => {
    const { app, tx } = makeApp();
    const res = await request(app).post('/api/v1/samples').set(authHeader()).send({
      type: 'pioneer',
      sourceOrderId: 'ORD-1',
      attachments: { productionStage: 'after_dyeing', producedMeterage: 1200 },
    });
    expect(res.status).toBe(400);
    expect(tx.sample.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// §9 B39 · 本文件六处出口：内部原文不上屏（R3 / §6 S1 执行覆盖）
// ────────────────────────────────────────────────────────────────────

/**
 * 形状 = ``fail(CODE, `固定文案: ${String(e?.message ?? e)}`, 500)`` —— 位置参数内插原文，
 * 五条既有判据（B22 / B30 / B33 / B36① / B36② / B37）一条都不认 ⇒ 记在 §9 B39，
 * 基线在 `shared/__tests__/serviceRawEchoRatchet.test.ts` 的 `B39_BASELINE`。
 * 期望值出处是 G6.5（未预期异常不得把内部原文给客户端）+ B31 文案口径，不是当前行为。
 *
 * ★ **D52 覆盖面逐处读原文**（不按形状套模板，文案口径因此分三组）：
 *   · `:262 createSample` / `:309 updateSample` / `:336 deleteSample` / `:533 forkSample`
 *     —— `try` 内**唯一写**是那个 `$transaction`（连审计也在事务内），事务之后只有 `return`
 *     ⇒ **可承诺**「本次未确认任何改动」；
 *   · `:470 advanceSampleStage` —— 事务之后确有一段会写库的返修联动，但 ★ **复核证伪了我给它的判语**：
 *     联动的拒绝被调用点 `.catch` 与 `invalidateScopesBySample` 自带 catch **双重吸收** ⇒ 外层 catch
 *     在事务提交后**不可触发** ⇒ 按 D52 本可承诺"未确认任何改动"。本批**仍保留保守口径**，理由换成
 *     「依赖一条无守卫的跨文件不变量」而非「覆盖面包含提交后区段」（证据与后果不同），且用例**只钉正向要求、
 *     不禁更强的承诺** —— 详见下方 `promisesZeroChange: false` 那条分支的注释；
 *   · `:648 invoiceSample` —— 无事务：发票由 `createInvoice` 独立提交后才回填 `invoiceId`
 *     ⇒ 原文案「发票已创建但样品回填失败」是**真结论**，本批保留它、只删原文（并允许业务单号是拉丁字符）。
 *
 * ★ **B41 出口清单**（D50「逐出口清」的产物，四列表见 `docs/S0A2-第7i批-*.md`）：
 *   上面 5 处经 `sampleRoute.ts:90` 的 `sendResult`（`res.status(r.error.status).json({error:{code,message}})`
 *   原样转发 `r.error.message`）到达响应体 ⇒ 活的上屏通道；末例对 **create** 做端到端实证，
 *   其余 4 处共用同一转发函数但**未逐端点覆盖**（结构性共用 ≠ 测试证据）。
 *   `:648` 的 `invoiceSample` **无 HTTP 消费者**：`POST /:id/invoice` 现为 410 GONE，该函数只在
 *   `sampleRoute.ts:52` 被 import、未被调用（与本文件 `:323` 既有用例「回填/幂等逻辑随收口不复存在」一致）
 *   ⇒ 现行**不会**上屏，仍按导出 API 清掉，覆盖只能用服务层直调（倒数第二例）。
 */
const B39_RAW = 'PrismaClientKnownRequestError: Invalid `prisma.$transaction()` invocation in '
  + '/srv/app/server/src/samples/sampleManageService.ts:230 — The table `Sample` does not exist in the current database. code=P2002';
const B39_FRAGMENTS = ['PrismaClient', 'prisma.$transaction', 'sampleManageService.ts:230', 'does not exist', '/srv/app', 'P2002'];

/** 事务一进门就炸 ⇒ 落到该函数 catch 的兜底分支（B39 站点） */
function txRejection(): any {
  return { $transaction: async () => { throw new Error(B39_RAW); } };
}

function expectB39Copy(msg: unknown, mustMention: string, allowLatin: string[] = []) {
  expect(typeof msg).toBe('string');
  const s = msg as string;
  expect(s.length, `文案过短（${s.length} 字）：${s}`).toBeGreaterThanOrEqual(20);
  expect(s, '必须含中文').toMatch(/[\u4e00-\u9fa5]/);
  expect(s, `必须说清对象：${s}`).toContain(mustMention);
  expect(s, `必须给下一步：${s}`).toMatch(/(稍后重试|可重试|请联系管理员|请刷新)/);
  const latin = (s.match(/[A-Za-z]{3,}/g) ?? []).filter((w) => !allowLatin.includes(w));
  expect(latin, `混入拉丁词（疑似原文上屏）：${s}`).toEqual([]);
}

describe('§9 B39 · 样品管理域六处出口：内部原文不上屏', () => {
  const CASES: Array<{ name: string; code: string; mention: string; promisesZeroChange: boolean; run: (prisma: any) => Promise<any> }> = [
    { name: 'createSample', code: 'SAMPLE_CREATE_FAILED', mention: '样品登记', promisesZeroChange: true, run: (p) => createSample({ prisma: p, input: { type: 'dev' }, actorId: 'u_1' }) },
    { name: 'updateSample', code: 'SAMPLE_UPDATE_FAILED', mention: '样品信息更新', promisesZeroChange: true, run: (p) => updateSample({ prisma: p, sampleId: 'SMP__1', input: { notes: '改备注' }, actorId: 'u_1' }) },
    { name: 'deleteSample', code: 'SAMPLE_DELETE_FAILED', mention: '样品删除', promisesZeroChange: true, run: (p) => deleteSample({ prisma: p, sampleId: 'SMP__1', actorId: 'u_1' }) },
    { name: 'advanceSampleStage', code: 'SAMPLE_STAGE_FAILED', mention: '样品状态推进', promisesZeroChange: false, run: (p) => advanceSampleStage({ prisma: p, sampleId: 'SMP__1', action: 'start', actorId: 'u_1' }) },
    { name: 'forkSample', code: 'SAMPLE_FORK_FAILED', mention: '样品复刻', promisesZeroChange: true, run: (p) => forkSample({ prisma: p, sampleId: 'SMP__1', input: { toType: 'pp' }, actorId: 'u_1' }) },
  ];

  for (const c of CASES) {
    it(`★ ${c.name}：500 + 码名不变 + 中文 + 零原文${c.promisesZeroChange ? ' + 承诺零改动' : '（D52：不许承诺写入状态）'}`, async () => {
      const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
      const r = await c.run(txRejection());
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.status, `${c.name} 档位不变`).toBe(500);
      expect(r.error.code, `${c.name} 码名不得随文案一起改`).toBe(c.code);
      const raw = JSON.stringify(r.error);
      for (const frag of B39_FRAGMENTS) expect(raw, `${c.name} 泄漏了「${frag}」`).not.toContain(frag);
      expectB39Copy(r.error.message, c.mention);
      if (c.promisesZeroChange) {
        expect(r.error.message, `${c.name}：try 内唯一写是 $transaction ⇒ 可以承诺`).toContain('本次未确认任何改动');
      } else {
        // ★ 复核纠正：本处原有一条 `.not.toContain('本次未确认任何改动')`，把"当前保守口径"锁成了规矩 ——
        // 复核实测该 catch 在事务提交后**不可触发**（双重 .catch 吸收）⇒ 更强的承诺其实成立，
        // 只是依赖一条无守卫的跨文件不变量。故这里**只钉正向要求**（告诉用户去核对），
        // **不禁止**将来证据齐了换成更强的承诺（否则"谁改对谁红"）。
        expect(r.error.message, `${c.name}：状态机动作须让用户核对实际状态`).toMatch(/刷新|核对/);
      }
      expect(spy, `${c.name} 原文必须仍进日志（本文件原本 logger.error 计数为 1）`).toHaveBeenCalledWith(
        expect.stringContaining('[SampleManage]'), expect.objectContaining({ error: B39_RAW }));
      spy.mockRestore();
    });
  }

  it('★ invoiceSample 回填失败：保留「发票已创建」真结论 + 删掉原文 + 原文进日志', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const created = { id: 'INV-1', invoiceNumber: 'SMP-INV-A', type: 'Receivable', amount: 10, currency: 'CNY', status: 'Draft' };
    const prisma: any = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'C1' }]),
      developmentCase: txMocks().developmentCase,
      sampleSource: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: async (fn: any) => fn(prisma),
      sample: {
        findFirst: async () => ({ ...SAMPLE, id: 'SMP__1', invoiceId: null, shippingFee: 10 }),
        update: async () => { throw new Error(B39_RAW); },
      },
      invoice: { findFirst: async () => null, create: async () => created },
      relation: { findFirst: async () => null },
      invoiceOrderAllocation: { create: async () => ({}) },
      entityReference: { upsert: async () => ({}) },
      entityLink: { upsert: async () => ({}), findMany: async () => [], update: async () => ({}) },
      auditLog: { create: async () => ({ id: 'AUD-1' }) },
    };
    const r = await invoiceSample({ prisma, sampleId: 'SMP__1', input: { amount: 10 }, actorId: 'u_1' });
    expect(r.ok, `桩未走通建票路径（实际拿到 ${JSON.stringify(r)})`).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BACKFILL_FAILED');
    expect(r.error.status).toBe(500);
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expect(r.error.message, '发票已创建是真结论，必须保留').toContain('已创建但样品回填失败');
    expect(r.error.message, '重试安全（来源幂等恢复）必须说清').toContain('不会重复建票');
    expectB39Copy(r.error.message, '样品', ['SMP', 'INV']);
    expect(spy, '原文必须进日志').toHaveBeenCalledWith(
      expect.stringContaining('[SampleManage]'), expect.objectContaining({ error: B39_RAW }));
    spy.mockRestore();
  });

  it('★ 端到端：POST /api/v1/samples 服务层炸 → 响应体零原文（证明这确实是上屏通道，不是纸面缺陷）', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/samples', createSampleRouter({
      prisma: txRejection(), requireAuth: false, apiKeys: new Set<string>(), onDataChange: vi.fn(),
    }));
    const res = await request(app).post('/api/v1/samples').set(authHeader()).send({ type: 'dev' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('SAMPLE_CREATE_FAILED');
    const body = JSON.stringify(res.body);
    for (const frag of B39_FRAGMENTS) expect(body, `响应体泄漏「${frag}」`).not.toContain(frag);
    expect(res.body.error.message).toContain('本次未确认任何改动');
  });
});

 describe('样品编辑的开发生命周期边界',()=>{
  it.each(['paused','closed'])('%s限制开发内容但允许补寄送事实',async state=>{
   const tx=statefulTx({type:'dev'});tx.developmentLifecycleEvent.findFirst.mockResolvedValue({state} as any);
   const prisma:any={$transaction:(fn:any)=>fn(tx)};
   const blocked=await updateSample({prisma,sampleId:SAMPLE.id,input:{attachments:{newDesign:true}},actorId:'u'});
   expect(blocked.ok).toBe(false);expect(tx.sample.update).not.toHaveBeenCalled();
   const facts=await updateSample({prisma,sampleId:SAMPLE.id,input:{trackingNumber:'TRACK',shippingFee:12},actorId:'u'});
   expect(facts.ok).toBe(true);expect(tx.sample.update).toHaveBeenCalledOnce();
  });
  it('生产样继续沿原编辑规则，不被开发结案冻结',async()=>{
   const tx=statefulTx({type:'pp',sourceOrderId:'O'});tx.developmentLifecycleEvent.findFirst.mockResolvedValue({state:'closed'} as any);
   const result=await updateSample({prisma:{$transaction:(fn:any)=>fn(tx)} as any,sampleId:SAMPLE.id,input:{notes:'生产记录'},actorId:'u'});
   expect(result.ok).toBe(true);
  });
  it('不能用普通编辑清空来源搬走历史费用',async()=>{
   const tx=statefulTx({});const result=await updateSample({prisma:{$transaction:(fn:any)=>fn(tx)} as any,sampleId:SAMPLE.id,input:{sourceCaseId:null},actorId:'u'});
   expect(result).toMatchObject({ok:false,error:{code:'SAMPLE_SOURCE_CHANGED',status:409}});expect(tx.sample.update).not.toHaveBeenCalled();
  });
 });

describe('样品状态推进生命周期与并发重读',()=>{
 it.each(['paused','closed'])('%s不允许设计样重新开工',async state=>{
  const tx=statefulTx({type:'dev',status:'draft'});tx.developmentLifecycleEvent.findFirst.mockResolvedValue({state} as any);
  const result=await advanceSampleStage({prisma:{$transaction:(fn:any)=>fn(tx)} as any,sampleId:SAMPLE.id,action:'start',actorId:'u'});
  expect(result).toMatchObject({ok:false,error:{status:409}});expect(tx.sample.update).not.toHaveBeenCalled();
 });
 it('开发已结案不阻止生产样开工',async()=>{
  const tx=statefulTx({type:'pp',status:'draft',sourceOrderId:'O'});tx.developmentLifecycleEvent.findFirst.mockResolvedValue({state:'closed'} as any);
  const result=await advanceSampleStage({prisma:{$transaction:(fn:any)=>fn(tx)} as any,sampleId:SAMPLE.id,action:'start',actorId:'u'});
  expect(result.ok).toBe(true);expect(tx.sample.update).toHaveBeenCalledOnce();
 });
 it('锁后状态已改变，不按旧draft重复开工',async()=>{
  const tx=statefulTx({});tx.sample.findFirst.mockResolvedValueOnce({...SAMPLE,status:'draft'}).mockResolvedValue({...SAMPLE,status:'confirmed'});
  const result=await advanceSampleStage({prisma:{$transaction:(fn:any)=>fn(tx)} as any,sampleId:SAMPLE.id,action:'start',actorId:'u'});
  expect(result).toMatchObject({ok:false,error:{code:'INVALID_TRANSITION'}});expect(tx.sample.update).not.toHaveBeenCalled();
 });
});

it.each(['paused','closed'])('%s后不能登记新开发样，生产样保留独立入口',async state=>{
 const tx=txMocks();tx.developmentLifecycleEvent.findFirst.mockResolvedValue({state} as any);const prisma:any={$transaction:(fn:any)=>fn(tx)};
 const blocked=await createSample({prisma,input:{type:'dev',sourceCaseId:'C1'},actorId:'u'});
 expect(blocked).toMatchObject({ok:false,error:{status:409}});expect(tx.sample.create).not.toHaveBeenCalled();
 expect((await createSample({prisma,input:{type:'pp',sourceCaseId:'C1'},actorId:'u'})).ok).toBe(true);
});

it.each(['costRecord','developmentPendingExpense','billingItem','invoice','sampleCardItem','sampleLengthMovement','ppSampleRelease','orderLine','releaseScope'])('样品已有%s历史不能删除',async model=>{
 const tx:any=statefulTx({});tx.sample.findFirst.mockImplementation(async({where}:any)=>where.forkedFromSampleId?null:SAMPLE);tx[model].findFirst.mockResolvedValue({id:'historic',deletedAt:1n});
 const result=await deleteSample({prisma:{$transaction:(fn:any)=>fn(tx)} as any,sampleId:SAMPLE.id,actorId:'u'});
 expect(result).toMatchObject({ok:false,error:{code:'SAMPLE_HAS_HISTORY'}});expect(tx.sample.update).not.toHaveBeenCalled();
});
it('无关联草稿仍可删除',async()=>{
 const tx=statefulTx({});tx.sample.findFirst.mockImplementation(async({where}:any)=>where.forkedFromSampleId?null:SAMPLE);
 const result=await deleteSample({prisma:{$transaction:(fn:any)=>fn(tx)} as any,sampleId:SAMPLE.id,actorId:'u'});
 expect(result.ok).toBe(true);expect(tx.sample.update).toHaveBeenCalledOnce();
});

describe('样品复刻的锁后来源与结案衔接',()=>{
 it('成功结案仍可复刻到生产样',async()=>{
  const tx=statefulTx({type:'seal',status:'sealed'});tx.developmentLifecycleEvent.findFirst.mockResolvedValue({state:'closed',outcome:'completed'} as any);
  const result=await forkSample({prisma:{$transaction:(fn:any)=>fn(tx)} as any,sampleId:SAMPLE.id,input:{toType:'pp'},actorId:'u'});
  expect(result.ok).toBe(true);expect(tx.sample.create).toHaveBeenCalledOnce();
 });
 it('锁后源样品已删除则不创建衍生样',async()=>{
  const tx=statefulTx({});tx.sample.findFirst.mockResolvedValueOnce(SAMPLE).mockResolvedValue(null as any);
  const result=await forkSample({prisma:{$transaction:(fn:any)=>fn(tx)} as any,sampleId:SAMPLE.id,input:{toType:'pp'},actorId:'u'});
  expect(result).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});expect(tx.sample.create).not.toHaveBeenCalled();
 });
 it.each([{state:'paused'},{state:'closed',outcome:'stopped'}])('暂停或终止案不得复刻：%j',async event=>{
  const tx=statefulTx({});tx.developmentLifecycleEvent.findFirst.mockResolvedValue(event as any);
  const result=await forkSample({prisma:{$transaction:(fn:any)=>fn(tx)} as any,sampleId:SAMPLE.id,input:{toType:'pp'},actorId:'u'});
  expect(result).toMatchObject({ok:false,error:{status:409}});expect(tx.sample.create).not.toHaveBeenCalled();
 });
});


describe('样品业务分线守卫与真实来源回读', () => {
  function conflictTx(initial: any = {}) {
    const tx = statefulTx({ ...initial, sourceOrderId: 'FABRIC-ORDER' });
    tx.order.findMany.mockImplementation(async ({ where }: any) => where.id.in.includes('FABRIC-ORDER') ? [{ id: 'FABRIC-ORDER', type: 'Fabric', businessLine: 'fabric', deletedAt: null }] : []);
    return tx;
  }
  const prismaFor = (tx: any) => ({ ...tx, $transaction: async (work: any) => work(tx) }) as any;
  it('list/get返回可信context；重复来源整页批查而非逐行查询', async () => {
    const tx = txMocks();
    tx.sample.findMany.mockResolvedValue([{ ...SAMPLE }, { ...SAMPLE, id: 'SMP__2' }]);
    tx.sample.count.mockResolvedValue(2);
    tx.sample.findFirst.mockResolvedValue(SAMPLE);
    const prisma = prismaFor(tx);
    const list = await listSamples(prisma, {});
    expect(list).toMatchObject({ ok: true, data: { total: 2, samples: [{ businessContext: { status: 'resolved', businessLine: 'garment' } }, { businessContext: { status: 'resolved', businessLine: 'garment' } }] } });
    expect(tx.developmentCase.findMany).toHaveBeenCalledOnce();
    expect((await getSample(prisma, SAMPLE.id))).toMatchObject({ ok: true, data: { sample: { businessContext: { status: 'resolved', businessLine: 'garment' } } } });
  });
  it('无来源草稿可以暂存但明确待核对，不能指定批准状态或携带业务附件', async () => {
    const tx = txMocks(), prisma = prismaFor(tx);
    expect(await createSample({ prisma, input: { type: 'dev', notes: '待核对历史样' }, actorId: 'u' }))
      .toMatchObject({ ok: true, data: { sample: { status: 'draft', businessContext: { status: 'unresolved', businessLine: null } } } });
    tx.sample.create.mockClear(); tx.auditLog.create.mockClear();
    expect(await createSample({ prisma, input: { type: 'pp', status: 'approved' }, actorId: 'u' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await createSample({ prisma, input: { type: 'ship', attachments: { sampleQuantity: 4 } }, actorId: 'u' })).toMatchObject({ ok: false, error: { code: 'SAMPLE_BUSINESS_UNRESOLVED', status: 409 } });
    expect(tx.sample.create).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('非空失效来源不因draft而悄悄登记', async () => {
    const tx = txMocks();
    expect(await createSample({ prisma: prismaFor(tx), input: { type: 'dev', sourceCaseId: 'MISSING' }, actorId: 'u' }))
      .toMatchObject({ ok: false, error: { code: 'SAMPLE_BUSINESS_UNRESOLVED' } });
    expect(tx.sample.create).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it.each(['create', 'update', 'fork', 'stage', 'delete', 'invoice'])('%s 跨线拒绝且不写样品、审计或财务', async operation => {
    const tx = conflictTx({ type: 'seal', status: 'sealed' }), prisma = prismaFor(tx);
    const result = operation === 'create'
      ? await createSample({ prisma, input: { type: 'dev', sourceCaseId: 'C1', sourceOrderId: 'FABRIC-ORDER' }, actorId: 'u' })
      : operation === 'update' ? await updateSample({ prisma, sampleId: SAMPLE.id, input: { notes: '备注' }, actorId: 'u' })
      : operation === 'fork' ? await forkSample({ prisma, sampleId: SAMPLE.id, input: { toType: 'pp' }, actorId: 'u' })
      : operation === 'stage' ? await advanceSampleStage({ prisma, sampleId: SAMPLE.id, action: 'start', actorId: 'u' })
      : operation === 'delete' ? await deleteSample({ prisma, sampleId: SAMPLE.id, actorId: 'u' })
      : await invoiceSample({ prisma, sampleId: SAMPLE.id, input: { amount: 10 }, actorId: 'u' });
    expect(result).toMatchObject({ ok: false, error: { code: 'SAMPLE_BUSINESS_CONFLICT', status: 409 } });
    expect(tx.sample.create).not.toHaveBeenCalled(); expect(tx.sample.update).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('普通编辑校验proposed档案，不仅原档案；不能把成衣接到面料档案', async () => {
    const tx = statefulTx({ productAssetId: 'PA-1' });
    tx.productAsset.findMany.mockImplementation(async ({ where }: any) => [{ id: 'PA-1', mainCategory: 'Garment', deletedAt: null }, { id: 'FABRIC-ASSET', mainCategory: 'Fabric', deletedAt: null }].filter(row => where.id.in.includes(row.id)));
    expect(await updateSample({ prisma: prismaFor(tx), sampleId: SAMPLE.id, input: { productAssetId: 'FABRIC-ASSET' }, actorId: 'u' }))
      .toMatchObject({ ok: false, error: { code: 'SAMPLE_BUSINESS_CONFLICT' } });
    expect(tx.sample.update).not.toHaveBeenCalled();
  });
  it.each(['update', 'fork'])('%s 唯一档案来源也不能由面料替换成成衣，原/目标单独合法不等于同线', async operation => {
    const tx = statefulTx({ sourceCaseId: null, sourceOrderId: null, productAssetId: 'FABRIC-A', type: 'seal', status: 'sealed' });
    tx.productAsset.findMany.mockImplementation(async ({ where }: any) => [
      { id: 'FABRIC-A', mainCategory: 'Fabric', deletedAt: null, fabricProfile: { id: 'FP-A', deletedAt: null } },
      { id: 'GARMENT-B', mainCategory: 'Garment', deletedAt: null, garmentProfile: { id: 'GP-B', deletedAt: null } },
    ].filter(row => where.id.in.includes(row.id)));
    const prisma = prismaFor(tx);
    const result = operation === 'update'
      ? await updateSample({ prisma, sampleId: SAMPLE.id, input: { productAssetId: 'GARMENT-B' }, actorId: 'u' })
      : await forkSample({ prisma, sampleId: SAMPLE.id, input: { toType: 'pp', productAssetId: 'GARMENT-B' }, actorId: 'u' });
    expect(result).toMatchObject({ ok: false, error: { code: 'SAMPLE_BUSINESS_CONFLICT', status: 409 } });
    expect(tx.sample.create).not.toHaveBeenCalled();
    expect(tx.sample.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it.each(['update', 'fork'])('%s 唯一档案来源仍允许同线成衣档案绑定', async operation => {
    const tx = statefulTx({ sourceCaseId: null, sourceOrderId: null, productAssetId: 'GARMENT-A', type: 'seal', status: 'sealed' });
    tx.productAsset.findMany.mockImplementation(async ({ where }: any) => ['GARMENT-A', 'GARMENT-B']
      .filter(id => where.id.in.includes(id)).map(id => ({ id, mainCategory: 'Garment', deletedAt: null, garmentProfile: { id: `GP-${id}`, deletedAt: null } })));
    const prisma = prismaFor(tx);
    const result = operation === 'update'
      ? await updateSample({ prisma, sampleId: SAMPLE.id, input: { productAssetId: 'GARMENT-B' }, actorId: 'u' })
      : await forkSample({ prisma, sampleId: SAMPLE.id, input: { toType: 'pp', productAssetId: 'GARMENT-B' }, actorId: 'u' });
    expect(result).toMatchObject({ ok: true, data: { sample: { productAssetId: 'GARMENT-B', businessContext: { status: 'resolved', businessLine: 'garment' } } } });
    expect(operation === 'update' ? tx.sample.update : tx.sample.create).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });
  it('待核对历史草稿仅备注可编辑；寄送事实与状态推进都拒绝', async () => {
    const tx = statefulTx({ sourceCaseId: null }), prisma = prismaFor(tx);
    expect(await updateSample({ prisma, sampleId: SAMPLE.id, input: { notes: '请核对' }, actorId: 'u' })).toMatchObject({ ok: true });
    tx.sample.update.mockClear(); tx.auditLog.create.mockClear();
    expect(await updateSample({ prisma, sampleId: SAMPLE.id, input: { trackingNumber: 'TRACK' }, actorId: 'u' })).toMatchObject({ ok: false, error: { code: 'SAMPLE_BUSINESS_UNRESOLVED' } });
    expect(await advanceSampleStage({ prisma, sampleId: SAMPLE.id, action: 'start', actorId: 'u' })).toMatchObject({ ok: false, error: { code: 'SAMPLE_BUSINESS_UNRESOLVED' } });
    expect(tx.sample.update).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('Sample锁后sourceOrderId/productAssetId变化拒绝，不按旧来源推进', async () => {
    const tx = statefulTx({});
    tx.sample.findFirst.mockResolvedValueOnce(SAMPLE).mockResolvedValue({ ...SAMPLE, productAssetId: 'PA-1' });
    expect(await advanceSampleStage({ prisma: prismaFor(tx), sampleId: SAMPLE.id, action: 'start', actorId: 'u' }))
      .toMatchObject({ ok: false, error: { code: 'SAMPLE_SOURCE_CHANGED' } });
    expect(tx.sample.update).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});


describe('遗留样品开票组合事务的失败回滚（有状态模拟，非Postgres证明）', () => {
  function transactionalInvoices(existing = false) {
    const savedInvoice: any = { id: 'INV-EXISTING', invoiceNumber: 'SMP-INV-EXISTING', type: 'Receivable', status: 'Draft', amount: 10, currency: 'CNY', sourceType: 'Sample', sourceId: SAMPLE.id, deletedAt: null };
    const state: any = { sample: { ...SAMPLE, customerRelationId: null, shippingFee: 10 }, invoices: existing ? [savedInvoice] : [], audits: [] };
    const failures = { createAudit: false, linkAudit: false };
    const transactions = { committed: 0, rolledBack: 0 };
    const tx: any = txMocks();
    tx.sample = {
      findFirst: vi.fn(async () => ({ ...state.sample })),
      update: vi.fn(async ({ data }: any) => { state.sample = { ...state.sample, ...data }; return { ...state.sample }; }),
    };
    tx.invoice = {
      findFirst: vi.fn(async ({ where }: any) => state.invoices.find((row: any) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { ...data, deletedAt: null }; state.invoices.push(row); return row; }),
    };
    tx.auditLog = { create: vi.fn(async ({ data }: any) => {
      if (failures.createAudit && data.action === 'create_invoice') throw new Error('synthetic invoice audit rejected');
      if (failures.linkAudit && data.action === 'invoice_sample_link_backfill') throw new Error('synthetic sample link audit rejected');
      state.audits.push(data); return data;
    }) };
    tx.invoiceOrderAllocation = { findMany: vi.fn().mockResolvedValue([]) };
    const prisma: any = { ...tx, $transaction: vi.fn(async (work: any) => {
      const snapshot = { sample: { ...state.sample }, invoices: state.invoices.map((row: any) => ({ ...row })), audits: [...state.audits] };
      try { const result = await work(tx); transactions.committed += 1; return result; }
      catch (error) { Object.assign(state, snapshot); transactions.rolledBack += 1; throw error; }
    }) };
    return { state, failures, transactions, tx, prisma };
  }
  it('实际createInvoice已写Invoice后审计拒绝，外层Result必须抛出使模拟事务回滚', async () => {
    const { state, failures, transactions, tx, prisma } = transactionalInvoices();
    failures.createAudit = true;
    const result = await invoiceSample({ prisma, sampleId: SAMPLE.id, input: { amount: 10 }, actorId: 'u' });
    expect(result).toMatchObject({ ok: false, error: { code: 'CREATE_FAILED' } });
    expect(tx.invoice.create).toHaveBeenCalledOnce(); // Proof this failed after the canonical write, not before it.
    expect(transactions).toEqual({ committed: 0, rolledBack: 1 });
    expect(state.invoices).toEqual([]); expect(state.audits).toEqual([]); expect(state.sample.invoiceId).toBeNull();
    expect(tx.sample.update).not.toHaveBeenCalled();
    expect(tx.invoiceOrderAllocation.findMany).not.toHaveBeenCalled(); // Deferred effects must not drain on failure.
  });
  it('已有发票恢复回填时审计拒绝，关联也回滚且明确BACKFILL_FAILED；重试不重复建票', async () => {
    const { state, failures, transactions, tx, prisma } = transactionalInvoices(true);
    failures.linkAudit = true;
    expect(await invoiceSample({ prisma, sampleId: SAMPLE.id, input: { amount: 10 }, actorId: 'u' }))
      .toMatchObject({ ok: false, error: { code: 'BACKFILL_FAILED', status: 500 } });
    expect(tx.sample.update).toHaveBeenCalledOnce(); // Link write happened and was then reverted with its audit.
    expect(transactions).toEqual({ committed: 0, rolledBack: 1 });
    expect(state.sample.invoiceId).toBeNull(); expect(state.audits).toEqual([]); expect(state.invoices).toHaveLength(1);
    expect(tx.invoice.create).not.toHaveBeenCalled();
    failures.linkAudit = false;
    expect(await invoiceSample({ prisma, sampleId: SAMPLE.id, input: { amount: 10 }, actorId: 'u' }))
      .toMatchObject({ ok: true, data: { recovered: true, sample: { invoiceId: 'INV-EXISTING' } } });
    expect(state.invoices).toHaveLength(1); expect(tx.invoice.create).not.toHaveBeenCalled();
    expect(state.audits.map((row: any) => row.action)).toEqual(['invoice_sample_link_backfill']);
  });
  it('新票已提交但回填审计拒绝，保留一次票与原创建审计，下一次只恢复关联', async () => {
    const { state, failures, transactions, tx, prisma } = transactionalInvoices();
    failures.linkAudit = true;
    expect(await invoiceSample({ prisma, sampleId: SAMPLE.id, input: { amount: 10 }, actorId: 'u' }))
      .toMatchObject({ ok: false, error: { code: 'BACKFILL_FAILED', status: 500 } });
    expect(transactions).toEqual({ committed: 1, rolledBack: 1 });
    expect(state.sample.invoiceId).toBeNull(); expect(state.invoices).toHaveLength(1);
    expect(state.audits.map((row: any) => row.action)).toEqual(['create_invoice']);
    failures.linkAudit = false;
    expect(await invoiceSample({ prisma, sampleId: SAMPLE.id, input: { amount: 10 }, actorId: 'u' }))
      .toMatchObject({ ok: true, data: { recovered: true } });
    expect(tx.invoice.create).toHaveBeenCalledOnce(); expect(state.invoices).toHaveLength(1);
    expect(state.sample.invoiceId).toBe(state.invoices[0].id);
    expect(state.audits.map((row: any) => row.action)).toEqual(['create_invoice', 'invoice_sample_link_backfill']);
  });
});

/** Synthetic snapshot storage exercises the real resolver and pagination.
 * This verifies the service contract, not PostgreSQL MVCC/concurrency itself. */
function listSnapshotStorage(seed: { samples?: any[]; cases?: any[]; orders?: any[]; assets?: any[] } = {}) {
  const state = {
    samples: seed.samples ?? [],
    cases: seed.cases ?? [{ id: 'CF', type: 'fabric', deletedAt: null }, { id: 'CG', type: 'garment', deletedAt: null }],
    orders: seed.orders ?? [], assets: seed.assets ?? [],
  };
  const reads: { model: string; args: any; snapshot: number }[] = [];
  let afterFirstRead: (() => void) | undefined;
  let snapshotIndex = 0;
  const matches = (row: any, where: any): boolean => !where || Object.entries(where).every(([key, value]: any) => {
    if (key === 'OR') return value.some((condition: any) => matches(row, condition));
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('contains' in value) return String(row[key] ?? '').toLowerCase().includes(String(value.contains).toLowerCase());
    }
    return row[key] === value;
  });
  const transactions: any[] = [];
  const prisma: any = { $transaction: vi.fn(async (work: any, options: any) => {
    const snapshot = structuredClone(state), index = ++snapshotIndex;
    const stored = (model: 'cases' | 'orders' | 'assets') => ({ findMany: vi.fn(async (args: any) => {
      reads.push({ model, args, snapshot: index }); return snapshot[model].filter(row => matches(row, args.where));
    }) });
    const sampleModel = {
      findMany: vi.fn(async (args: any) => {
        reads.push({ model: 'samples', args, snapshot: index });
        let rows = snapshot.samples.filter(row => matches(row, args.where)).sort((a, b) =>
          a.createdAt === b.createdAt ? a.id === b.id ? 0 : a.id < b.id ? 1 : -1 : a.createdAt < b.createdAt ? 1 : -1);
        if (args.cursor) { const start = rows.findIndex(row => row.id === args.cursor.id); rows = rows.slice(start < 0 ? rows.length : start + (args.skip ?? 0)); }
        else rows = rows.slice(args.skip ?? 0);
        if (args.take !== undefined) rows = rows.slice(0, args.take);
        if (args.select) rows = rows.map(row => Object.fromEntries(Object.keys(args.select).map(key => [key, row[key]])));
        const mutate = afterFirstRead; afterFirstRead = undefined; mutate?.();
        return rows;
      }),
      count: vi.fn(async (args: any) => { reads.push({ model: 'count', args, snapshot: index }); return snapshot.samples.filter(row => matches(row, args.where)).length; }),
    };
    const tx: any = { sample: sampleModel, developmentCase: stored('cases'), order: stored('orders'), productAsset: stored('assets'),
      sampleSource: { findMany: vi.fn(async (args: any) => { reads.push({ model: 'origins', args, snapshot: index }); return []; }) } };
    transactions.push({ index, options, tx }); return work(tx);
  }) };
  return { prisma, state, reads, transactions, afterFirstRead: (mutation: () => void) => { afterFirstRead = mutation; } };
}
const listRow = (id: string, sourceCaseId: string | null, createdAt = 0n, patch: any = {}) => ({ ...SAMPLE, id, code: id, sourceCaseId, createdAt, ...patch });

describe('S3A complete business-lane page/count snapshot', () => {
  it('Case anchoring is applied before full lane count and off-page selection, not to the first page', async () => {
    const samples = [
      ...Array.from({ length: 250 }, (_, index) => listRow(`TARGET-${String(index).padStart(4, '0')}`, 'CF', BigInt(index))),
      ...Array.from({ length: 210 }, (_, index) => listRow(`OTHER-${index}`, 'CF-OTHER', BigInt(index + 1000))),
    ];
    const storage = listSnapshotStorage({ samples, cases: [{ id: 'CF', type: 'fabric', deletedAt: null }, { id: 'CF-OTHER', type: 'fabric', deletedAt: null }] });
    const result = await listSamples(storage.prisma, { scope: 'fabric', sourceCaseId: 'CF', limit: 5, offset: 201 });
    expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.message);
    expect(result.data.total).toBe(250); expect(result.data.sourceCaseId).toBe('CF');
    expect(result.data.samples.map(row => row.id)).toEqual(['TARGET-0048','TARGET-0047','TARGET-0046','TARGET-0045','TARGET-0044']);
    expect(storage.reads.filter(read => read.model === 'samples' && read.args.select).every(read => read.args.where.sourceCaseId === 'CF')).toBe(true);
    expect(storage.transactions).toHaveLength(1); expect(storage.transactions[0].options.isolationLevel).toBe('RepeatableRead');
  });
  it('Case filtering preserves lane/review decisions and includes historical bad-source rows only for the selected Case', async () => {
    const storage = listSnapshotStorage({ samples: [listRow('F','CF'), listRow('CONFLICT','CF',1n,{ sourceOrderId:'OG' }),
      listRow('OTHER-CONFLICT','CG',2n,{ sourceOrderId:'OF' }), listRow('DELETED','CF',3n,{ deletedAt:1n }), listRow('UNKNOWN','MISSING',4n)],
      orders: [{ id:'OG', type:'Garment', businessLine:'garment', deletedAt:null }, { id:'OF', type:'Fabric', businessLine:'fabric', deletedAt:null }] });
    for (const [scope, caseId, expected] of [['fabric','CF',['F']], ['review','CF',['CONFLICT']], ['review','MISSING',['UNKNOWN']]] as const) {
      const result = await listSamples(storage.prisma, { scope, sourceCaseId: caseId });
      expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.message);
      expect(result.data.samples.map(row => row.id)).toEqual(expected); expect(result.data.total).toBe(1); expect(result.data.sourceCaseId).toBe(caseId);
    }
  });
  it('Case-only legacy reads use the same snapshot/count and omit the echo after the filter is cleared', async () => {
    const storage = listSnapshotStorage({ samples: [listRow('A','CF',2n), listRow('B','CF',1n), listRow('OTHER','CG',3n)] });
    storage.afterFirstRead(() => { storage.state.samples[0].sourceCaseId = 'CG'; storage.state.samples.push(listRow('LATE','CF',4n)); });
    const filtered = await listSamples(storage.prisma, { sourceCaseId:'CF', limit:1, offset:1 });
    expect(filtered.ok).toBe(true); if (!filtered.ok) throw Error(filtered.error.message);
    expect(filtered.data.samples.map(row => row.id)).toEqual(['B']); expect(filtered.data.total).toBe(2); expect(filtered.data.sourceCaseId).toBe('CF');
    expect(new Set(storage.reads.map(read => read.snapshot))).toEqual(new Set([1]));
    const cleared = await listSamples(storage.prisma, {}); expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw Error(cleared.error.message); expect(cleared.data.total).toBe(4); expect(cleared.data).not.toHaveProperty('sourceCaseId');
  });
  it.each(['', ' CF', null, ['CF'], { id:'CF' }, 1])('invalid Case anchor %j refuses before any database read', async sourceCaseId => {
    const storage = listSnapshotStorage(); expect(await listSamples(storage.prisma, { sourceCaseId })).toMatchObject({ ok:false, error:{ code:'INVALID_INPUT',status:400 } });
    expect(storage.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('the ordinary HTTP list forwards the raw Case query and returns an applied-source echo only on success', async () => {
    const tx = txMocks({ sample:{ ...txMocks().sample, findMany:vi.fn().mockResolvedValue([SAMPLE]), count:vi.fn().mockResolvedValue(1) } });
    const { app } = makeApp({ tx });
    const valid = await request(app).get('/api/v1/samples?sourceCaseId=C1&scope=garment&limit=1').set(authHeader());
    expect(valid.status).toBe(200); expect(valid.body.sourceCaseId).toBe('C1'); expect(valid.body.total).toBe(1);
    expect(tx.sample.findMany).toHaveBeenCalledWith(expect.objectContaining({ where:expect.objectContaining({ sourceCaseId:'C1' }) }));
    for (const query of ['sourceCaseId=', 'sourceCaseId=C1&sourceCaseId=C2', 'sourceCaseId[id]=C1', 'sourceCaseId=%20C1']) {
      tx.sample.findMany.mockClear(); tx.sample.count.mockClear();
      const invalid = await request(app).get('/api/v1/samples?'+query).set(authHeader());
      expect(invalid.status, query).toBe(400); expect(invalid.body).not.toHaveProperty('sourceCaseId');
      expect(tx.sample.findMany).not.toHaveBeenCalled(); expect(tx.sample.count).not.toHaveBeenCalled();
    }
  });
  it('classifies all >200 candidates before paging and returns a real off-page count/page with bounded chunks', async () => {
    const rows = Array.from({ length: 420 }, (_, index) => listRow(`ROW-${String(index).padStart(4, '0')}`, index % 2 === 0 ? 'CF' : 'CG', BigInt(index)));
    const storage = listSnapshotStorage({ samples: rows });
    const result = await listSamples(storage.prisma, { scope: 'fabric', limit: 5, offset: 202 });
    expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.message);
    expect(result.data.total).toBe(210);expect(result.data.scope).toBe('fabric');
    expect(result.data.samples.map(row => row.id)).toEqual(['ROW-0014','ROW-0012','ROW-0010','ROW-0008','ROW-0006']);
    expect(result.data.samples.every(row => row.businessContext.businessLine === 'fabric')).toBe(true);
    expect(result.data.samples.every(row => row.sourceContext.status === 'unresolved')).toBe(true); // Lane remains known without exact origin.
    const chunks = storage.reads.filter(read => read.model === 'samples' && read.args.select);
    expect(chunks).toHaveLength(3); expect(chunks.every(read => read.args.take === 200)).toBe(true);
    expect(chunks[1].args).toMatchObject({ cursor: { id: 'ROW-0220' }, skip: 1 });
    expect(storage.reads.filter(read => read.model === 'cases')).toHaveLength(3);
    expect(storage.reads.filter(read => read.model === 'origins')).toHaveLength(1);
    expect(storage.reads.find(read => read.model === 'origins')?.args.where.sampleId.in).toHaveLength(5);
    expect(storage.reads.some(read => read.model === 'count')).toBe(false);
  });
  it('review contains actual unknown/conflicting/missing/deleted sources, while deleted Samples and resolved lanes stay outside', async () => {
    const storage = listSnapshotStorage({ samples: [
      listRow('F','CF'), listRow('G','CG'), listRow('UNKNOWN',null), listRow('CONFLICT','CF',0n,{sourceOrderId:'OG'}),
      listRow('DELETED_SOURCE','CD'), listRow('MISSING','MISSING'), listRow('UNSUPPORTED','CU'), listRow('DELETED_SAMPLE','CF',0n,{deletedAt:1n}),
    ], cases: [{id:'CF',type:'fabric',deletedAt:null},{id:'CG',type:'garment',deletedAt:null},{id:'CD',type:'fabric',deletedAt:1n},{id:'CU',type:'pp',deletedAt:null}],
      orders: [{id:'OG',businessLine:'garment',type:'Garment',deletedAt:null}] });
    const result = await listSamples(storage.prisma, { scope: 'review', limit: 200 });
    expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.message);
    expect(result.data.total).toBe(5);expect(result.data.scope).toBe('review'); expect(result.data.samples.map(row => row.id)).toEqual(['UNSUPPORTED','UNKNOWN','MISSING','DELETED_SOURCE','CONFLICT']);
    expect(result.data.samples.find(row=>row.id==='CONFLICT').businessContext).toMatchObject({status:'conflict',businessLine:null});
    expect(result.data.samples.find(row=>row.id==='DELETED_SOURCE').businessContext.reasons).toContain('CASE_MISSING_OR_DELETED');
  });
  it('stable createdAt DESC/id DESC ties survive separate page requests without gaps or duplicates', async () => {
    const storage = listSnapshotStorage({ samples: [listRow('A','CF',10n),listRow('D','CF',10n),listRow('B','CF',10n),listRow('C','CF',9n)] });
    const first = await listSamples(storage.prisma, {scope:'fabric',limit:2}); const second = await listSamples(storage.prisma,{scope:'fabric',limit:2,offset:2});
    expect(first.ok && second.ok).toBe(true); if (!first.ok || !second.ok) throw Error('page failed');
    expect(first.data.samples.map(row=>row.id)).toEqual(['D','B']);expect(second.data.samples.map(row=>row.id)).toEqual(['A','C']);
    expect(first.data.total).toBe(4);expect(second.data.total).toBe(4);
    expect(storage.reads.filter(read=>read.model==='samples').every(read=>JSON.stringify(read.args.orderBy)===JSON.stringify([{createdAt:'desc'},{id:'desc'}]))).toBe(true);
  });
  it.each([undefined,'fabric','review'])('page, classification, count and source readback share one requested RepeatableRead snapshot (%s)',async scope=>{
    const storage=listSnapshotStorage({samples:[listRow('ORIGINAL','CF')]});
    storage.afterFirstRead(()=>{storage.state.samples.push(listRow('CONCURRENT','CG',2n));storage.state.cases[0]={id:'CF',type:'garment',deletedAt:null};});
    const result=await listSamples(storage.prisma,{scope,limit:20});expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.message);
    expect(result.data.total).toBe(scope==='review'?0:1);expect(result.data.samples.map(row=>row.id)).toEqual(scope==='review'?[]:['ORIGINAL']);
    if(result.data.samples.length)expect(result.data.samples[0].businessContext.businessLine).toBe('fabric');
    expect(storage.transactions).toHaveLength(1);expect(storage.transactions[0].options).toEqual({isolationLevel:'RepeatableRead',maxWait:5000,timeout:30000});
    expect(new Set(storage.reads.map(read=>read.snapshot))).toEqual(new Set([1]));
  });
  it('other business filters apply before classification/count, and omitted scope retains the unsegmented page/count contract',async()=>{
    const storage=listSnapshotStorage({samples:[listRow('MATCH-F','CF',1n,{type:'dev',status:'draft',supplierRelationId:'A'}),listRow('MATCH-G','CG',2n,{type:'dev',status:'draft',supplierRelationId:'A'}),
      listRow('OTHER','CF',3n,{type:'seal',status:'draft',supplierRelationId:'A'}),listRow('MATCH-B','CF',4n,{type:'dev',status:'draft',supplierRelationId:'B'})]});
    const filters={type:'dev',status:'draft',supplier:'A',search:'match',limit:1};
    const scoped=await listSamples(storage.prisma,{...filters,scope:'fabric'});const legacy=await listSamples(storage.prisma,filters);
    expect(scoped.ok&&legacy.ok).toBe(true);if(!scoped.ok||!legacy.ok)throw Error('list failed');
    expect(scoped.data.total).toBe(1);expect(scoped.data.samples[0].id).toBe('MATCH-F');expect(legacy.data.total).toBe(2);expect(legacy.data.samples[0].id).toBe('MATCH-G');expect(Object.prototype.hasOwnProperty.call(legacy.data,'scope')).toBe(false);
  });
  it.each([undefined,'fabric'])('zero limit returns no rows with full count; offsets beyond count are valid (%s)',async scope=>{
    const storage=listSnapshotStorage({samples:[listRow('F','CF'),listRow('G','CG')]});const zero=await listSamples(storage.prisma,{scope,limit:0});
    expect(zero.ok).toBe(true);if(!zero.ok)throw Error(zero.error.message);expect(zero.data.samples).toEqual([]);expect(zero.data.total).toBe(scope?1:2);
    const off=await listSamples(storage.prisma,{scope,offset:99,limit:5});expect(off.ok).toBe(true);if(!off.ok)throw Error(off.error.message);expect(off.data.samples).toEqual([]);expect(off.data.total).toBe(scope?1:2);
    expect(storage.reads.some(read=>read.model==='origins')).toBe(false);
  });
  it.each([{scope:''},{scope:'Fabric'},{scope:'other'},{scope:['fabric']},{limit:-1},{limit:1.5},{limit:NaN},{limit:201},{limit:'1e2'},{limit:''},{limit:['1']},{offset:-1},{offset:0.1},{offset:'NaN'},{offset:Number.MAX_SAFE_INTEGER+1}])('invalid scope/page parameters fail before database access %j',async query=>{
    const storage=listSnapshotStorage();expect(await listSamples(storage.prisma,query)).toMatchObject({ok:false,error:{code:'INVALID_INPUT',status:400}});
    expect(storage.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('HTTP preserves omitted defaults, accepts exact scope, and rejects raw malformed numeric values instead of coercing them',async()=>{
    const tx=txMocks({sample:{...txMocks().sample,findMany:vi.fn().mockResolvedValue([SAMPLE]),count:vi.fn().mockResolvedValue(1)}});const{app}=makeApp({tx});
    const omitted=await request(app).get('/api/v1/samples').set(authHeader());expect(omitted.status).toBe(200);
    expect(tx.sample.findMany).toHaveBeenCalledWith(expect.objectContaining({take:50,skip:0}));
    const garment=await request(app).get('/api/v1/samples?scope=garment&limit=1&offset=0').set(authHeader());expect(garment.status).toBe(200);expect(garment.body.total).toBe(1);expect(garment.body.scope).toBe('garment');
    for(const query of ['scope=invalid','scope=','limit=-1','limit=1.5','limit=1e2','limit=','limit=201','offset=NaN','offset=-1','scope=fabric&scope=garment']){
      tx.sample.findMany.mockClear();tx.sample.count.mockClear();const invalid=await request(app).get('/api/v1/samples?'+query).set(authHeader());
      expect(invalid.status,query).toBe(400);expect(invalid.body.error.code).toBe('INVALID_INPUT');expect(tx.sample.findMany).not.toHaveBeenCalled();expect(tx.sample.count).not.toHaveBeenCalled();
    }
  });
  it('sample/resolver SQL failures propagate and the HTTP route returns failure instead of an empty or zero-total success',async()=>{
    const failure=Error('synthetic SQL unavailable');const tx=txMocks();tx.sample.findMany.mockRejectedValue(failure);
    const prisma:any={$transaction:async(work:any)=>work(tx)};await expect(listSamples(prisma,{scope:'fabric'})).rejects.toBe(failure);
    const{app}=makeApp({tx});const response=await request(app).get('/api/v1/samples?scope=fabric').set(authHeader());expect(response.status).toBe(500);expect(response.body.ok).not.toBe(true);expect(response.body.samples).toBeUndefined();expect(response.body.total).toBeUndefined();expect(response.body.scope).toBeUndefined();
    const second=txMocks({sample:{...txMocks().sample,findMany:vi.fn().mockResolvedValue([SAMPLE])}});second.developmentCase.findMany.mockRejectedValue(failure);
    await expect(listSamples({$transaction:async(work:any)=>work(second)} as any,{scope:'garment'})).rejects.toBe(failure);
  });
});

 describe('native order sample generic mutation protection', () => {
  it.each(['update','delete','stage','fork'] as const)('blocks %s after Sample lock and reload, without generic writes', async operation => {
    const tx = statefulTx({ id: 'SMP__1', sourceCaseId: null, sourceOrderId: 'ORD-1', type: 'ship', status: 'making' });
    tx.orderSampleSource.findUnique.mockResolvedValue({ id: 'NATIVE', sampleId: 'SMP__1' });
    const prisma: any = { $transaction: async (fn: any) => fn(tx) };
    const base = { prisma, sampleId: 'SMP__1', actorId: 'A' };
    const r = operation === 'update' ? await updateSample({ ...base, input: { notes: 'edited' } }) : operation === 'delete' ? await deleteSample(base) : operation === 'stage' ? await advanceSampleStage({ ...base, action: 'send' }) : await forkSample({ ...base, input: { toType: 'pp' } });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED', status: 409 });
    expect(tx.sample.update).not.toHaveBeenCalled(); expect(tx.sample.create).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.calls.some(([q]: any) => q.strings.join('').includes('FROM "Sample"') && q.strings.join('').includes('FOR UPDATE'))).toBe(true);
  });
  it('rejects standalone order production creation before either Sample or audit is written', async () => {
    const tx = txMocks(), prisma: any = { $transaction: async (fn: any) => fn(tx) };
    const r = await createSample({ prisma, input: { type: 'ship', sourceOrderId: 'ORD-1' }, actorId: 'A' });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.status).toBe(400);
    expect(tx.sample.create).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
