import { fabricAuthorizationFixture, legacyApprovedFabricBatch } from './fabricAuthorizationFixture';
/**
 * fabricDevelopmentService.test.ts — 面料开发链（DR-050）服务测试
 *
 * 覆盖：开发供应商（多工厂）/ 统一样品批次状态机 / 封样同厂组合强校验 /
 *      强制转面料档案（批次/封样双路径）+ ASSET_REQUIRED 门禁。
 */
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDevelopmentRouter } from '../route';
import { authHeader } from '../../__tests__/authTestHelper';

const CASE = {
  id: 'DC-F1', code: 'DEV-F1', name: 'New Fabric', type: 'fabric', stage: 'approved',
  priority: 'normal', customerRelationId: 'C1', customerName: 'Client',
  supplierRelationId: null, supplierName: null, productAssetId: null, productName: '',
  specComposition: '100% Cotton', specWeight: '180', specWidth: '150cm', specWeave: 'Twill',
  specFinish: 'Soft wash', targetPrice: '5.2', moqEstimate: 3000,
  linkedOrderId: null, convertedAt: null, deletedAt: null,
  createdAt: BigInt(0), updatedAt: BigInt(0),
};

const BATCH = {
  id: 'SB-A1', batchCode: 'SB-20260906-0001', developmentCaseId: 'DC-F1',
  supplierRelationId: 'SUP-A', supplierName: 'Mill A', sampleType: 'lab-dip',
  specNote: 'PANTONE 19-1664', round: 1, status: 'pending',
  dyeLotNo: null, colorRating: null, defectCauses: [], customerStatus: null, approvedAsSealed: false,
  photos: null, convertedProductAssetId: null, convertedAt: null,
  deletedAt: null, createdAt: BigInt(0), updatedAt: BigInt(0),
};

function txMocks(overrides: any = {}) {
  return {
    ...fabricAuthorizationFixture(),
    $queryRaw:vi.fn().mockResolvedValue([{id:CASE.id}]),
    $executeRaw:vi.fn().mockResolvedValue(1),
    $executeRawUnsafe:vi.fn().mockResolvedValue(0),
    developmentLifecycleEvent:{findFirst:vi.fn().mockResolvedValue(null)},
    developmentSupplier: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id || 'DS-1' })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...data, id: where.id })),
    },
    sampleBatch: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...BATCH, ...data, id: data.id || 'SB-X' })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...BATCH, ...data, id: where.id })),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    sealSampleBatch: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockImplementation(async ({ data }: any) => data),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    sealSample: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id || 'SEAL-X' })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...data, id: where.id })),
    },
    productAsset: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id || 'PROD-1' })),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    fabricProfile: { create: vi.fn().mockResolvedValue({}) },
    sampleSource: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    sample: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    developmentCase: { findFirst:vi.fn().mockResolvedValue(CASE), update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...CASE, ...data, id: where.id })) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'AUD-1' }), findFirst: vi.fn(async () => null) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    order: { create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id })), findUnique: vi.fn().mockResolvedValue({ id: 'ORD-1', poNumber: 'PO-1' }) },
    orderLine: { create: vi.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

function makeApp(opts: {
  devCase?: any;
  tx?: any;
  txFail?: boolean;
  requireAuth?: boolean;
} = {}) {
  const devCase = opts.devCase === undefined ? CASE : opts.devCase;
  const tx = opts.tx ?? txMocks();
  const prisma = {
    developmentCase: { findFirst: vi.fn().mockResolvedValue(devCase) },
    sampleBatch: { findFirst: vi.fn().mockResolvedValue(null) },
    sealSample: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: opts.txFail
      ? vi.fn().mockRejectedValue(new Error('TX_BOOM'))
      : vi.fn(async (fn: any) => fn(tx)),
  } as any;
  const onDataChange = vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/development', createDevelopmentRouter({ prisma, requireAuth: opts.requireAuth ?? false, apiKeys: new Set(), onDataChange }));
  return { app, prisma, tx, onDataChange };
}

// ────────────────────────────────────────────────────────────────────
// 开发供应商
// ────────────────────────────────────────────────────────────────────
describe('DR-050 开发供应商', () => {
  it('POST /:id/suppliers 追加工厂 → 201', async () => {
    const tx = txMocks();
    tx.developmentSupplier.create.mockImplementation(async ({ data }: any) => ({ ...data, id: 'DS-1' }));
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/DC-F1/suppliers').set(authHeader()).send({ supplierRelationId: 'SUP-A', supplierName: 'Mill A' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.supplier.supplierRelationId).toBe('SUP-A');
  });

  it('POST 重复工厂 → 幂等更新（不新增）', async () => {
    const tx = txMocks();
    tx.developmentSupplier.findUnique.mockResolvedValue({ id: 'DS-1', developmentCaseId: 'DC-F1', supplierRelationId: 'SUP-A', supplierName: 'Mill A', createdAt: BigInt(0), updatedAt: BigInt(0), deletedAt: null });
    tx.developmentSupplier.update.mockImplementation(async ({ data }: any) => ({ id: 'DS-1', supplierRelationId: 'SUP-A', ...data }));
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/DC-F1/suppliers').set(authHeader()).send({ supplierRelationId: 'SUP-A' });
    expect(res.status).toBe(201);
    expect(tx.developmentSupplier.create).not.toHaveBeenCalled();
    expect(tx.developmentSupplier.update).toHaveBeenCalled();
  });

  it('PATCH /suppliers/:sid 更新试样信息（报价/交期/结论）', async () => {
    const tx = txMocks();
    tx.developmentSupplier.findFirst.mockResolvedValue({ id: 'DS-1', supplierRelationId: 'SUP-A', deletedAt: null });
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/development/suppliers/DS-1').set(authHeader()).send({ quoteNote: 'RMB 12/m', leadTime: '2w', trialConclusion: 'ok' });
    expect(res.status).toBe(200);
    expect(res.body.supplier.trialConclusion).toBe('ok');
  });

  it('PATCH 非法试样结论 → 400', async () => {
    const tx = txMocks();
    tx.developmentSupplier.findFirst.mockResolvedValue({ id: 'DS-1', supplierRelationId: 'SUP-A', deletedAt: null });
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/development/suppliers/DS-1').set(authHeader()).send({ trialConclusion: 'maybe' });
    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────────
// 统一样品批次
// ────────────────────────────────────────────────────────────────────
describe('DR-050 统一样品批次', () => {
  it('POST /:id/batches 登记色样批次（未登记工厂时自动登记）→ 201', async () => {
    const tx = txMocks();
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/DC-F1/batches').set(authHeader()).send({
      sampleType: 'lab-dip', supplierRelationId: 'SUP-A', supplierName: 'Mill A',
      specNote: 'PANTONE 19-1664', dyeLotNo: 'LOT-01', colorRating: 4, defectCauses: ['red_cast'],
    });
    expect(res.status).toBe(201);
    expect(res.body.batch.sampleType).toBe('lab-dip');
    expect(res.body.batch.colorRating).toBe(4);
    // 未登记工厂自动补登记
    expect(tx.developmentSupplier.create).toHaveBeenCalled();
  });

  it('POST 成衣开发案登记批次 → 400 NOT_FABRIC_CASE', async () => {
    const tx = txMocks();
    const { app } = makeApp({ devCase: { ...CASE, type: 'garment' }, tx });
    const res = await request(app).post('/api/v1/development/DC-F1/batches').set(authHeader()).send({ sampleType: 'yardage', supplierRelationId: 'SUP-A' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_FABRIC_CASE');
  });

  it('POST 非法样品类型 → 400', async () => {
    const tx = txMocks();
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/DC-F1/batches').set(authHeader()).send({ sampleType: 'bogus', supplierRelationId: 'SUP-A' });
    expect(res.status).toBe(400);
  });

  it('PATCH /batches/:bid/stage 状态机全链（start→send→approve；revise 轮次+1）', async () => {
    const tx = txMocks();
    // 有状态 mock：findFirst 读当前状态，update 写回
    let state: any = { ...BATCH, id: 'SB-A1' };
    tx.sampleBatch.findFirst.mockImplementation(async () => state);
    tx.sampleBatch.update.mockImplementation(async ({ where, data }: any) => {
      state = { ...state, ...data, id: where.id };
      return state;
    });
    const { app } = makeApp({ tx });

    let res = await request(app).patch('/api/v1/development/batches/SB-A1/stage').set(authHeader()).send({ action: 'start' });
    expect(res.status).toBe(200);
    expect(res.body.batch.status).toBe('making');

    res = await request(app).patch('/api/v1/development/batches/SB-A1/stage').set(authHeader()).send({ action: 'send', courier: 'DHL', trackingNumber: '123', shippingFee: 45.5 });
    expect(res.status).toBe(200);
    expect(res.body.batch.status).toBe('sent');

    res = await request(app).patch('/api/v1/development/batches/SB-A1/stage').set(authHeader()).send({ action: 'revise', feedback: '色偏深' });
    expect(res.status).toBe(200);
    expect(res.body.batch.status).toBe('revising');

    res = await request(app).patch('/api/v1/development/batches/SB-A1/stage').set(authHeader()).send({ action: 'start' });
    expect(res.status).toBe(200);
    expect(res.body.batch.round).toBe(2); // revising→making round+1

    res = await request(app).patch('/api/v1/development/batches/SB-A1/stage').set(authHeader()).send({ action: 'send' });
    expect(res.status).toBe(200);
    res = await request(app).patch('/api/v1/development/batches/SB-A1/stage').set(authHeader()).send({ action: 'approve', feedback: 'OK' });
    expect(res.status).toBe(200);
    expect(res.body.batch.status).toBe('approved');
  });

  it('PATCH 非法状态机动作 → 409（pending 不能直接 send）', async () => {
    const tx = txMocks();
    tx.sampleBatch.findFirst.mockImplementation(async () => ({ ...BATCH, id: 'SB-A1', status: 'pending' }));
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/development/batches/SB-A1/stage').set(authHeader()).send({ action: 'send' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('POST /batches/:bid/customer-feedback lab-dip 客户判定 + asSealed 唯一基准', async () => {
    const tx = txMocks();
    // An attachment-only history update must preserve the preceding business
    // write, exactly as PostgreSQL does; returning the original BATCH reset it.
    let persisted: any = { ...BATCH, id: 'SB-A1', sampleType: 'lab-dip', developmentCaseId: 'DC-F1', status: 'sent' };
    tx.sampleBatch.findFirst.mockImplementation(async () => persisted);
    tx.sampleBatch.update.mockImplementation(async ({ where, data }: any) => { persisted = { ...persisted, ...data, id: where.id }; return persisted; });
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/batches/SB-A1/customer-feedback').set(authHeader()).send({ status: 'approved', asSealed: true });
    expect(res.status).toBe(200);
    expect(res.body.batch.customerStatus).toBe('approved');
    expect(res.body.batch.approvedAsSealed).toBe(true);
    expect(persisted.customerStatus).toBe('approved');
    expect(persisted.attachments.fabricHistory.events[0].kind).toBe('feedback');
    // 同案其他批次清基准
    expect(tx.sampleBatch.updateMany).toHaveBeenCalled();
  });

  it('POST customer-feedback 非色样批次 → 400 NOT_LAB_DIP', async () => {
    const tx = txMocks();
    tx.sampleBatch.findFirst.mockImplementation(async () => ({ ...BATCH, id: 'SB-A1', sampleType: 'yardage' }));
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/batches/SB-A1/customer-feedback').set(authHeader()).send({ status: 'approved' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_LAB_DIP');
  });

  it('DELETE 被封样引用的批次 → 409 REFERENCED_BY_SEAL', async () => {
    const tx = txMocks();
    tx.sampleBatch.findFirst.mockResolvedValue({ ...BATCH, id: 'SB-A1' });
    tx.sealSampleBatch.findFirst.mockResolvedValue({ id: 'SSB-1', sealSampleId: 'SEAL-1', sampleBatchId: 'SB-A1' });
    const { app } = makeApp({ tx });
    const res = await request(app).delete('/api/v1/development/batches/SB-A1').set(authHeader());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REFERENCED_BY_SEAL');
  });
});

// ────────────────────────────────────────────────────────────────────
// 封样（同厂组合）
// ────────────────────────────────────────────────────────────────────
describe('DR-050 封样', () => {
  it('POST /:id/seals 同厂批次组合 → 201', async () => {
    const tx = txMocks();
    tx.sampleBatch.findMany.mockResolvedValue([
      { ...BATCH, id: 'SB-A1', supplierRelationId: 'SUP-A', supplierName: 'Mill A' },
      { ...BATCH, id: 'SB-A2', sampleType: 'yardage', supplierRelationId: 'SUP-A', supplierName: 'Mill A' },
    ]);
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/DC-F1/seals').set(authHeader()).send({ batchIds: ['SB-A1', 'SB-A2'], name: '封样 A', standardNo: 'STD-001' });
    expect(res.status).toBe(201);
    expect(res.body.seal.supplierRelationId).toBe('SUP-A');
    expect(tx.sealSampleBatch.create).toHaveBeenCalledTimes(2);
  });

  it('跨厂组合 → 400 CROSS_SUPPLIER_SEAL', async () => {
    const tx = txMocks();
    tx.sampleBatch.findMany.mockResolvedValue([
      { ...BATCH, id: 'SB-A1', supplierRelationId: 'SUP-A' },
      { ...BATCH, id: 'SB-B1', supplierRelationId: 'SUP-B' },
    ]);
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/DC-F1/seals').set(authHeader()).send({ batchIds: ['SB-A1', 'SB-B1'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CROSS_SUPPLIER_SEAL');
  });

  it('空批次组合 → 400 INVALID_INPUT', async () => {
    const tx = txMocks();
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/DC-F1/seals').set(authHeader()).send({ batchIds: [] });
    expect(res.status).toBe(400);
  });

  it('PATCH /seals/:sealId/status draft→sealed 成功；sealed 后组合锁定', async () => {
    const tx = txMocks();
    tx.sealSample.findFirst.mockImplementation(async () => ({ id: 'SEAL-1', developmentCaseId: 'DC-F1', status: 'draft', sealCode: 'SEAL-1', deletedAt: null }));
    tx.sealSampleBatch.count.mockResolvedValue(2);
    tx.sealSampleBatch.findMany.mockResolvedValue([{ sampleBatchId: 'SB-A1' }, { sampleBatchId: 'SB-A2' }]);
    tx.sampleBatch.findMany.mockResolvedValue(['SB-A1', 'SB-A2'].map(id => legacyApprovedFabricBatch({ ...BATCH, id, status: 'approved', approvedBy: 'u_owner', approvedAt: 1n })));
    tx.sampleBatch.findFirst.mockImplementation(async ({where}:any) => legacyApprovedFabricBatch({ ...BATCH, id: where.id, status: 'approved', approvedBy: 'u_owner', approvedAt: 1n }));
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/development/seals/SEAL-1/status').set(authHeader()).send({ status: 'sealed' });
    expect(res.status).toBe(200);
    expect(res.body.seal.status).toBe('sealed');
    expect(res.body.seal.batchIds).toEqual(['SB-A1', 'SB-A2']);
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'seal_sample_confirm', targetId: 'SEAL-1', detail: expect.objectContaining({ after: expect.objectContaining({ batchFacts: expect.arrayContaining([expect.objectContaining({ batchId: 'SB-A1' }), expect.objectContaining({ batchId: 'SB-A2' })]) }) }) }) }));

    // sealed 后调整组合 → 409 LOCKED
    tx.sealSample.findFirst.mockResolvedValue({ id: 'SEAL-1', developmentCaseId: 'DC-F1', status: 'sealed', sealCode: 'SEAL-1', deletedAt: null });
    const res2 = await request(app).patch('/api/v1/development/seals/SEAL-1').set(authHeader()).send({ batchIds: ['SB-A1'] });
    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('LOCKED');
  });

  it('signed status request returns actual database links and never echoes body batchIds', async () => {
    const tx = txMocks();
    const source = { id: 'SEAL-1', developmentCaseId: 'DC-F1', status: 'draft', sealCode: 'SEAL-1', supplierRelationId: 'SUP-A', deletedAt: null };
    tx.sealSample.findFirst.mockResolvedValue(source);
    tx.sealSample.update.mockImplementation(async ({ data }: any) => ({ ...source, ...data }));
    tx.sealSampleBatch.findMany.mockResolvedValue([{ sampleBatchId: 'SB-A1' }, { sampleBatchId: 'SB-A2' }]);
    tx.sampleBatch.findMany.mockResolvedValue(['SB-A1', 'SB-A2'].map(id => legacyApprovedFabricBatch({ ...BATCH, id, status: 'approved', approvedBy: 'u_owner', approvedAt: 1n })));
    tx.sampleBatch.findFirst.mockImplementation(async ({ where }: any) => legacyApprovedFabricBatch({ ...BATCH, id: where.id, status: 'approved', approvedBy: 'u_owner', approvedAt: 1n }));
    const { app } = makeApp({ tx, requireAuth: true });
    const rejected = await request(app).patch('/api/v1/development/seals/SEAL-1/status').send({ status: 'sealed' });
    expect(rejected.status).toBe(401); expect(tx.sealSample.update).not.toHaveBeenCalled();
    const res = await request(app).patch('/api/v1/development/seals/SEAL-1/status').set(authHeader()).send({ status: 'sealed', batchIds: ['FOREIGN'] });
    expect(res.status).toBe(200); expect(res.body.seal).toMatchObject({ id: 'SEAL-1', developmentCaseId: 'DC-F1', status: 'sealed', batchIds: ['SB-A1', 'SB-A2'] });
    expect(tx.sealSampleBatch.create).not.toHaveBeenCalled(); expect(tx.sealSampleBatch.deleteMany).not.toHaveBeenCalled();
    expect(tx.sealSample.update).toHaveBeenCalledTimes(1);
  });

  it('status audit failure cannot emit a successful seal DTO or change notification', async () => {
    const tx = txMocks();
    tx.sealSample.findFirst.mockResolvedValue({ id: 'SEAL-1', developmentCaseId: 'DC-F1', status: 'draft', sealCode: 'SEAL-1', deletedAt: null });
    tx.sealSampleBatch.findMany.mockResolvedValue([{ sampleBatchId: 'SB-A1' }]);
    tx.sampleBatch.findMany.mockResolvedValue([legacyApprovedFabricBatch({ ...BATCH, id: 'SB-A1', status: 'approved', approvedBy: 'u_owner', approvedAt: 1n })]);
    tx.sampleBatch.findFirst.mockResolvedValue(legacyApprovedFabricBatch({ ...BATCH, id: 'SB-A1', status: 'approved', approvedBy: 'u_owner', approvedAt: 1n }));
    tx.auditLog.create.mockRejectedValue(Object.assign(Error('synthetic audit FK'), { code: 'P2003' }));
    const { app, onDataChange } = makeApp({ tx, requireAuth: true });
    const res = await request(app).patch('/api/v1/development/seals/SEAL-1/status').set(authHeader()).send({ status: 'sealed' });
    expect(res.status).toBe(500); expect(res.body.ok).toBe(false); expect(res.body.seal).toBeUndefined(); expect(onDataChange).not.toHaveBeenCalled();
    // Callback storage cannot prove database rollback; native PG owns that evidence.
  });

  it('封样中有未认可批次时不可封存，不写状态或审批事实', async () => {
    const tx = txMocks();
    tx.sealSample.findFirst.mockResolvedValue({ id: 'SEAL-1', developmentCaseId: 'DC-F1', status: 'draft', sealCode: 'SEAL-1' });
    tx.sealSampleBatch.findMany.mockResolvedValue([{ sampleBatchId: 'SB-A1' }]);
    tx.sampleBatch.findMany.mockResolvedValue([]);
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/development/seals/SEAL-1/status').set(authHeader()).send({ status: 'sealed' });
    expect(res.status).toBe(409);
    expect(tx.sealSample.update).not.toHaveBeenCalled();
  });

  it('DELETE 已转档封样 → 409 ALREADY_CONVERTED', async () => {
    const tx = txMocks();
    tx.sealSample.findFirst.mockResolvedValue({ id: 'SEAL-1', status: 'converted', sealCode: 'SEAL-1', deletedAt: null });
    const { app } = makeApp({ tx });
    const res = await request(app).delete('/api/v1/development/seals/SEAL-1').set(authHeader());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CONVERTED');
  });
});

// ────────────────────────────────────────────────────────────────────
// 强制转面料档案
// ────────────────────────────────────────────────────────────────────
describe('DR-050 转档与强制建档后转', () => {
  it('POST /:id/convert-to-asset 批次直接转（approved）→ 200 + 建档案 + 回填', async () => {
    const tx = txMocks();
    tx.sampleBatch.findMany.mockResolvedValue([]);
    const { app, prisma } = makeApp({ tx });
    prisma.sampleBatch.findFirst.mockResolvedValue(legacyApprovedFabricBatch({ ...BATCH, id: 'SB-A1', status: 'approved', approvedBy: 'u_owner', approvedAt: 1n }));
    tx.sampleBatch.findFirst.mockResolvedValue(legacyApprovedFabricBatch({ ...BATCH, id: 'SB-A1', status: 'approved', approvedBy: 'u_owner', approvedAt: 1n }));
    const res = await request(app).post('/api/v1/development/DC-F1/convert-to-asset').set(authHeader()).send({ sourceType: 'batch', sourceId: 'SB-A1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.asset.mainCategory).toBe('Fabric');
    expect(res.body.asset.cost).toBeNull(); // CASE.targetPrice=5.2 is a target, not actual cost.
    expect(res.body.case.productAssetId).toBe(res.body.asset.id);
    expect(tx.fabricProfile.create).toHaveBeenCalled();
    expect(tx.sampleBatch.update).toHaveBeenCalled(); // converted 回填
  });

  it.each([null, '0', '987.6543'])('目标价 %j 的转档不能制造实际成本', async targetPrice => {
    const devCase = { ...CASE, targetPrice };
    const tx = txMocks();
    tx.developmentCase.findFirst.mockResolvedValue(devCase);
    tx.sampleBatch.findMany.mockResolvedValue([]);
    tx.sampleBatch.findFirst.mockResolvedValue(legacyApprovedFabricBatch({ ...BATCH, status: 'approved', approvedBy: 'u_owner', approvedAt: 1n }));
    const { app, prisma } = makeApp({ tx, devCase });
    prisma.sampleBatch.findFirst.mockResolvedValue(legacyApprovedFabricBatch({ ...BATCH, status: 'approved', approvedBy: 'u_owner', approvedAt: 1n }));
    const res = await request(app).post('/api/v1/development/DC-F1/convert-to-asset').set(authHeader())
      .send({ sourceType: 'batch', sourceId: BATCH.id });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.asset.cost).toBeNull();
    expect(tx.productAsset.create.mock.calls[0][0].data.cost).toBeNull();
    expect(tx.developmentCase.update.mock.calls[0][0].data).not.toHaveProperty('targetPrice');
  });

  it('批次未确认（非 approved）直接转 → 409 BATCH_NOT_APPROVED', async () => {
    const tx = txMocks();
    const { app, prisma } = makeApp({ tx });
    prisma.sampleBatch.findFirst.mockResolvedValue({ ...BATCH, id: 'SB-A1', status: 'pending' });
    tx.sampleBatch.findFirst.mockResolvedValue({ ...BATCH, id: 'SB-A1', status: 'pending' });
    const res = await request(app).post('/api/v1/development/DC-F1/convert-to-asset').set(authHeader()).send({ sourceType: 'batch', sourceId: 'SB-A1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_NOT_APPROVED');
  });

  it('设计归组确认不能代替样品认可：未 approved 的批次不可转档', async () => {
    const tx = txMocks();
    tx.sampleBatch.findMany.mockResolvedValue([]);
    const { app, prisma } = makeApp({ tx });
    prisma.sampleBatch.findFirst.mockResolvedValue({ ...BATCH, id: 'SB-A1', status: 'sent', confirmStatus: 'confirmed', batchCode: 'SB-001' });
    tx.sampleBatch.findFirst.mockResolvedValue({ ...BATCH, id: 'SB-A1', status: 'sent', confirmStatus: 'confirmed', batchCode: 'SB-001' });
    const res = await request(app).post('/api/v1/development/DC-F1/convert-to-asset').set(authHeader()).send({ sourceType: 'batch', sourceId: 'SB-A1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_NOT_APPROVED');
    expect(tx.productAsset.create).not.toHaveBeenCalled();
    expect(tx.sampleBatch.update).not.toHaveBeenCalled();
  });

  it('DR-054 阶段 D：转档自动带入产品来源（立项来源映射 + sourceDetail=开发案编号）', async () => {
    const tx = txMocks();
    tx.sampleBatch.findMany.mockResolvedValue([]);
    // Both the preflight and locked storage records contain the same actual source.
    tx.developmentCase.findFirst.mockResolvedValue({ ...CASE, source: 'customer-sample' });
    const { app, prisma } = makeApp({ devCase: { ...CASE, source: 'customer-sample' }, tx });
    prisma.sampleBatch.findFirst.mockResolvedValue(legacyApprovedFabricBatch({ ...BATCH, id: 'SB-A1', status: 'approved', approvedBy: 'u_owner', approvedAt: 1n }));
    tx.sampleBatch.findFirst.mockResolvedValue(legacyApprovedFabricBatch({ ...BATCH, id: 'SB-A1', status: 'approved', approvedBy: 'u_owner', approvedAt: 1n }));
    const res = await request(app).post('/api/v1/development/DC-F1/convert-to-asset').set(authHeader()).send({ sourceType: 'batch', sourceId: 'SB-A1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(tx.productAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'customer_sample',
          sourceDetail: expect.stringContaining(CASE.code),
        }),
      }),
    );
  });

  it('DR-054 阶段 D：转档无立项来源 → 默认 development + 开发案编号', async () => {
    const tx = txMocks();
    tx.sampleBatch.findMany.mockResolvedValue([]);
    const { app, prisma } = makeApp({ tx });
    prisma.sampleBatch.findFirst.mockResolvedValue(legacyApprovedFabricBatch({ ...BATCH, id: 'SB-A1', status: 'approved', approvedBy: 'u_owner', approvedAt: 1n }));
    tx.sampleBatch.findFirst.mockResolvedValue(legacyApprovedFabricBatch({ ...BATCH, id: 'SB-A1', status: 'approved', approvedBy: 'u_owner', approvedAt: 1n }));
    const res = await request(app).post('/api/v1/development/DC-F1/convert-to-asset').set(authHeader()).send({ sourceType: 'batch', sourceId: 'SB-A1' });
    expect(res.status).toBe(200);
    expect(tx.productAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: 'development' }),
      }),
    );
  });

  it('封样转档（sealed）→ 200 + seal→converted', async () => {
    const tx = txMocks();
    tx.sealSampleBatch.findMany.mockResolvedValue([{sampleBatchId:BATCH.id}]);
    tx.sampleBatch.findMany.mockResolvedValue([legacyApprovedFabricBatch({...BATCH,status:'approved',approvedBy:'u_owner',approvedAt:1n})]);
    const { app, prisma } = makeApp({ tx });
    prisma.sealSample.findFirst.mockResolvedValue({ id: 'SEAL-1', developmentCaseId: 'DC-F1', status: 'sealed', sealCode: 'SEAL-1', supplierRelationId: 'SUP-A', supplierName: 'Mill A', deletedAt: null });
    tx.sealSample.findFirst.mockResolvedValue({ id: 'SEAL-1', developmentCaseId: 'DC-F1', status: 'sealed', sealCode: 'SEAL-1', supplierRelationId: 'SUP-A', supplierName: 'Mill A', deletedAt: null });
    const res = await request(app).post('/api/v1/development/DC-F1/convert-to-asset').set(authHeader()).send({ sourceType: 'seal', sourceId: 'SEAL-1' });
    expect(res.status).toBe(200);
    expect(tx.sealSample.update).toHaveBeenCalled();
    expect(res.body.case.productAssetId).toBe(res.body.asset.id);
  });

  it('封样未封存（draft）转档 → 409 SEAL_NOT_SEALED', async () => {
    const tx = txMocks();
    const { app, prisma } = makeApp({ tx });
    prisma.sealSample.findFirst.mockResolvedValue({ id: 'SEAL-1', developmentCaseId: 'DC-F1', status: 'draft', sealCode: 'SEAL-1', deletedAt: null });
    tx.sealSample.findFirst.mockResolvedValue({ id: 'SEAL-1', developmentCaseId: 'DC-F1', status: 'draft', sealCode: 'SEAL-1', deletedAt: null });
    const res = await request(app).post('/api/v1/development/DC-F1/convert-to-asset').set(authHeader()).send({ sourceType: 'seal', sourceId: 'SEAL-1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEAL_NOT_SEALED');
  });

  it('POST /:id/convert 面料案未建档 → 409 ASSET_REQUIRED', async () => {
    const tx = txMocks();
    const { app } = makeApp({ devCase: { ...CASE, productAssetId: null }, tx });
    const res = await request(app).post('/api/v1/development/DC-F1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ASSET_REQUIRED');
  });

  it('POST /:id/convert 面料案已建档且有认可成果 → 通过门禁（200）', async () => {
    const tx = txMocks();
    // 入口与锁后重读必须表示同一份当前开发案，不能入口 P1、事务里却仍未建档。
    const currentCase = { ...CASE, productAssetId: 'P1' };
    const currentAsset = { id: 'P1', sku: 'FAB-TEST-001', name: CASE.name };
    tx.developmentCase.findFirst.mockResolvedValue(currentCase);
    tx.developmentCase.update.mockImplementation(async ({ where, data }: any) => ({ ...currentCase, ...data, id: where.id }));
    tx.productAsset.findUnique.mockImplementation(async ({ where }: any) => where.id === currentAsset.id ? currentAsset : null);
    tx.sampleBatch.findFirst.mockResolvedValue(legacyApprovedFabricBatch({ ...BATCH, status: 'approved', approvedBy: 'u_owner', approvedAt: 1n, convertedProductAssetId: 'P1' }));
    tx.sampleBatch.findMany.mockResolvedValue([legacyApprovedFabricBatch({ ...BATCH, status: 'approved', approvedBy: 'u_owner', approvedAt: 1n, convertedProductAssetId: 'P1' })]);
    const { app } = makeApp({ devCase: currentCase, tx });
    const res = await request(app).post('/api/v1/development/DC-F1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15' });
    expect(res.status, JSON.stringify(res.body.error ?? null)).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(tx.developmentCase.findFirst).toHaveBeenCalledWith({ where: { id: CASE.id, deletedAt: null } });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.developmentCase.findFirst.mock.invocationCallOrder[0]);
    expect(tx.productAsset.findUnique).toHaveBeenCalledWith({ where: { id: 'P1' }, select: { sku: true } });
    expect(tx.orderLine.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ materialCode: currentAsset.sku, quantity: 100 }),
    }));
  });
});

// ────────────────────────────────────────────────────────────────────
// DR-054 阶段 B：批次级确认（确认锚点=批次）+ 登记实际结果
// ────────────────────────────────────────────────────────────────────
describe('DR-054 批次级确认 + 实物登记', () => {
  it('actual Decimal string survives the ordinary PATCH API without Number rounding', async () => {
    const tx = txMocks(); tx.sampleBatch.findFirst.mockResolvedValue(BATCH);
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/development/batches/SB-A1').set(authHeader()).send({ actualQuantity: '12345678901234.1234', actualUnit: 'M' });
    expect(res.status).toBe(200); expect(res.body.batch.actualQuantity).toBe('12345678901234.1234');
    expect(tx.sampleBatch.update.mock.calls[0][0].data.actualQuantity.toString()).toBe('12345678901234.1234');
  });
  it.each(['-1', 'NaN', '1e3', '1.23456', '123456789012345'])('invalid actual quantity %s is rejected rather than clamped to zero/null', async actualQuantity => {
    const tx = txMocks(); tx.sampleBatch.findFirst.mockResolvedValue(BATCH);
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/development/batches/SB-A1').set(authHeader()).send({ actualQuantity });
    expect(res.status).toBe(400); expect(res.body.error.code).toBe('INVALID_INPUT'); expect(tx.sampleBatch.update).not.toHaveBeenCalled(); expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('待打样不可确认设计批次，且不能同步改变同案样品状态', async () => {
    const tx = txMocks();
    tx.sampleBatch.findFirst.mockResolvedValue({ ...BATCH, confirmStatus: 'unconfirmed' });
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/batches/SB-A1/confirm').set(authHeader());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_NOT_APPROVED');
    expect(tx.sampleBatch.update).not.toHaveBeenCalled();
    expect(tx.sample.update).not.toHaveBeenCalled();
  });
  it('POST /batches/:bid/confirm 批次事实确认，但未绑定来源的同案 Sample 不受影响', async () => {
    const tx = txMocks();
    // Persist both projection and append-only history writes, not a fresh
    // original unconfirmed row for each update.
    let confirmedBatch: any = { ...BATCH, approvedBy: 'u_owner', approvedAt: 1n, status: 'approved', confirmStatus: 'unconfirmed', confirmedAt: null, confirmedBy: null, planQuantity: null, actualQuantity: null };
    tx.sampleBatch.findFirst.mockImplementation(async () => confirmedBatch);
    tx.sampleBatch.update.mockImplementation(async ({ where, data }: any) => { confirmedBatch = { ...confirmedBatch, ...data, id: where.id }; return confirmedBatch; });
    tx.sample.findMany.mockResolvedValue([{ id: 'SMP-1' }, { id: 'SMP-2' }]);
    tx.sample.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/batches/SB-A1/confirm').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.batch.confirmStatus).toBe('confirmed');
    expect(res.body.sampleCount).toBe(0);
    expect(confirmedBatch.confirmStatus).toBe('confirmed');
    expect(confirmedBatch.attachments.fabricHistory.events[0].kind).toBe('confirm');
    expect(tx.sample.update).not.toHaveBeenCalled();
  });

  it('POST /batches/:bid/confirm 已确认批次 → 409 ALREADY_CONFIRMED（防重复确认）', async () => {
    const tx = txMocks();
    tx.sampleBatch.findFirst.mockResolvedValue({ ...BATCH, confirmStatus: 'confirmed', confirmedAt: BigInt(1), confirmedBy: 'u1' });
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/batches/SB-A1/confirm').set(authHeader());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CONFIRMED');
    expect(tx.sampleBatch.update).not.toHaveBeenCalled();
  });

  it('PATCH /batches/:bid 支持计划数量与实际数量字段（打样登记→收到结果）', async () => {
    const tx = txMocks();
    tx.sampleBatch.findFirst.mockResolvedValue({ ...BATCH, confirmStatus: 'unconfirmed' });
    tx.sampleBatch.update.mockImplementation(async ({ where, data }: any) => ({ ...BATCH, ...data, id: where.id }));
    const { app } = makeApp({ tx });
    const res = await request(app).patch('/api/v1/development/batches/SB-A1').set(authHeader()).send({ planQuantity: 8, planUnit: '米', actualQuantity: 5, actualUnit: '米' });
    expect(res.status).toBe(200);
    expect(Number(res.body.batch.planQuantity)).toBe(8);
    expect(Number(res.body.batch.actualQuantity)).toBe(5);
  });
});


describe('开发生命周期业务守卫',()=>{
 it.each(['paused','closed'])('%s时批次修改和直接创建均拒绝写入',async state=>{
  const tx=txMocks();tx.developmentLifecycleEvent.findFirst.mockResolvedValue({state});tx.sampleBatch.findFirst.mockResolvedValue(BATCH);
  const {app}=makeApp({tx});
  const changed=await request(app).patch('/api/v1/development/batches/SB-A1').set(authHeader()).send({notes:'edit'});
  expect(changed.status).toBe(409);expect(tx.sampleBatch.update).not.toHaveBeenCalled();
  const created=await request(app).post('/api/v1/development/DC-F1/suppliers').set(authHeader()).send({supplierRelationId:'SUP-A',supplierName:'Mill A'});
  expect(created.status).toBe(409);expect(tx.developmentSupplier.create).not.toHaveBeenCalled();
 });
});
it('生命周期查询失败不写批次；锁后来源移案返回冲突',async()=>{
 const tx=txMocks();tx.sampleBatch.findFirst.mockResolvedValue(BATCH);tx.developmentLifecycleEvent.findFirst.mockRejectedValue(new Error('DB unavailable'));
 const {app}=makeApp({tx});
 const failed=await request(app).patch('/api/v1/development/batches/SB-A1').set(authHeader()).send({notes:'edit'});
 expect(failed.status).toBe(500);expect(tx.sampleBatch.update).not.toHaveBeenCalled();
 tx.developmentLifecycleEvent.findFirst.mockResolvedValue({state:'active'});
 tx.sampleBatch.findFirst.mockReset().mockResolvedValueOnce(BATCH).mockResolvedValueOnce({...BATCH,developmentCaseId:'OTHER'});
 const moved=await request(app).patch('/api/v1/development/batches/SB-A1').set(authHeader()).send({notes:'edit'});
 expect(moved.status).toBe(409);expect(moved.body.error.code).toBe('DEVELOPMENT_SOURCE_CHANGED');expect(tx.sampleBatch.update).not.toHaveBeenCalled();
});


describe('SealSample 原生取号与安全边界', () => {
  it('封样跳过已软删的占号；实际序列递增，不复用历史编号', async () => {
    let sequence = 0;
    const tx = txMocks({ businessSequence: {
      upsert: vi.fn().mockResolvedValue({ seq: 0 }),
      update: vi.fn(async () => ({ seq: ++sequence })),
    }});
    tx.sampleBatch.findMany.mockResolvedValue([BATCH]);
    tx.sealSample.findFirst.mockImplementation(async ({ where }: any) => where.sealCode?.endsWith('-0001') ? { id: 'historical-soft-deleted-seal', deletedAt: 1n } : null);
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/DC-F1/seals').set(authHeader()).send({ batchIds: [BATCH.id] });
    expect(res.status).toBe(201);
    expect(res.body.seal.sealCode).toBe(`SEAL-${new Date().getFullYear()}-0002`);
    expect(tx.businessSequence.update).toHaveBeenCalledTimes(2);
    expect(tx.sealSample.findFirst).toHaveBeenCalledWith({ where: { sealCode: `SEAL-${new Date().getFullYear()}-0001` }, select: { id: true } });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it('封样内部存储失败仍为 500，响应不泄漏约束或 SQL', async () => {
    const tx = txMocks(); tx.sampleBatch.findMany.mockResolvedValue([BATCH]);
    tx.sealSample.create.mockRejectedValue(new Error('P2002 SQL private_SealSample_unique_constraint'));
    const { app } = makeApp({ tx });
    const res = await request(app).post('/api/v1/development/DC-F1/seals').set(authHeader()).send({ batchIds: [BATCH.id] });
    expect(res.status).toBe(500); expect(res.body.error.code).toBe('SEAL_CREATE_FAILED');
    expect(JSON.stringify(res.body)).not.toMatch(/P2002|SQL|private_|constraint/);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
