/**
 * garmentDevelopmentService.test.ts — 成衣开发链（DR-051）服务测试
 *
 * 覆盖：强制转成衣档案（确认批次 / 封存轮次 → ProductAsset(Garment)+GarmentProfile）、
 *      未确认/未封存 gate 强校验、类型分派（fabric 仍走面料服务）、
 *      convertService 成衣案 ASSET_REQUIRED 门禁。
 * 消双轨 L-4：确认锚点唯一真源 = SampleBatch（confirmStatus/sealedRoundStatus），SampleNode 已退役。
 */
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDevelopmentRouter } from '../route';
import { authHeader } from '../../__tests__/authTestHelper';
import { logger } from '../../lib/logger';

const GARMENT_CASE = {
  id: 'DC-G1', code: 'DEV-G1', name: 'New Garment', type: 'garment', stage: 'approved',
  priority: 'normal', customerRelationId: 'C1', customerName: 'Client',
  supplierRelationId: 'SUP-F1', supplierName: 'Factory A', productAssetId: null, productName: '',
  styleSpec: 'V领衬衫', sizeSpec: 'S/M/L', fabricSpec: '全棉府绸', processSpec: '成衣染色',
  targetPrice: '25.5', moqEstimate: 500, sampleCategory: '5a',
  tags: [], attachments: null, linkedOrderId: null, convertedAt: null, deletedAt: null,
  createdAt: BigInt(0), updatedAt: BigInt(0),
};

// 确认批次（confirmStatus='confirmed'）：客户确认的唯一真源
const CONFIRM_BATCH = {
  id: 'SB__DC-G1__confirmed',
  developmentCaseId: 'DC-G1',
  round: 2,
  status: 'approved',
  confirmStatus: 'confirmed',
  attachments: { version: 'V2', purpose: '最终确认' },
  deletedAt: null,
};

// 封存批次（sealedRoundStatus='sealed'）：封样基准
const SEALED_BATCH = {
  id: 'SB__DC-G1__1_abcd',
  developmentCaseId: 'DC-G1',
  round: 1,
  status: 'approved',
  attachments: { version: 'V1', purpose: '确认版型', sealedRoundStatus: 'sealed' },
  deletedAt: null,
};

function txMocks(overrides: any = {}) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    productAsset: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue({sku:'GAR-1'}), create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id || 'PROD-1' })) },
    garmentProfile: { create: vi.fn().mockResolvedValue({}) },
    developmentCase: { update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...GARMENT_CASE, ...data, id: where.id })) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'AUD-1' }) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

function makeApp(opts: {
  devCase?: any;
  tx?: any;
  txFail?: boolean;
  batchRound?: any;
} = {}) {
  const devCase = opts.devCase === undefined ? GARMENT_CASE : opts.devCase;
  const tx = opts.tx ?? txMocks();
  tx.$queryRaw ??= vi.fn().mockResolvedValue([{id:devCase?.id}]);
  tx.developmentLifecycleEvent ??= {findFirst:vi.fn().mockResolvedValue(null)};
  tx.developmentCase.findFirst ??= vi.fn().mockResolvedValue(devCase);
  tx.sampleBatch ??= {findFirst:vi.fn().mockResolvedValue(opts.batchRound ?? null)};
  // Storage seam for the real post-lock active-account/current-grant contract.
  // This does not prove real DB authorization; the native PG controls do.
  const account = { id: 'u_owner', status: 'active', deletedAt: null, roles: [{ role: { id: 'role-super-admin', permissions: [
    { permission: { scope: 'products:read' } }, { permission: { scope: 'products:write' } },
  ] } }] };
  tx.userAccount ??= { findFirst: vi.fn().mockResolvedValue(account), findUnique: vi.fn().mockResolvedValue(account) };
  tx.userPermissionOverrides ??= { findMany: vi.fn().mockResolvedValue([]) };
  tx.relation ??= { findFirst: vi.fn().mockResolvedValue({ id: 'C1', ownerId: 'u_owner', deletedAt: null, salesRepIds: [] }) };
  tx.sample ??= { findMany: vi.fn().mockResolvedValue([]) }; // Legacy stand-alone approved batch has no PP physical row.
  const prisma = {
    developmentCase: { findFirst: vi.fn().mockResolvedValue(devCase) },
    // DR-054 阶段 G-Ⅱ + 消双轨 L-4：轮次唯一真源 SampleBatch（garment-round）
    sampleBatch: { findFirst: vi.fn().mockResolvedValue(opts.batchRound ?? null) },
    $transaction: opts.txFail
      ? vi.fn().mockRejectedValue(new Error('TX_BOOM'))
      : vi.fn(async (fn: any) => fn(tx)),
  } as any;
  const onDataChange = vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/development', createDevelopmentRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange }));
  return { app, prisma, tx, onDataChange };
}

// ────────────────────────────────────────────────────────────────────
// 强制转成衣档案
// ────────────────────────────────────────────────────────────────────
describe('DR-051 强制转成衣档案（convert-to-asset）', () => {
  it('确认样（确认批次 confirmStatus=confirmed，唯一真源）→ ProductAsset(Garment)+GarmentProfile，回填 productAssetId + sampleVersion 取批次版本', async () => {
    const tx = txMocks();
    const { app, tx: usedTx } = makeApp({ batchRound: CONFIRM_BATCH, tx });
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert-to-asset')
      .set(authHeader())
      .send({ sourceType: 'node', sourceId: 'confirmation' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.asset.sku).toMatch(/^GR-/);
    expect(res.body.asset.mainCategory).toBe('Garment');
    expect(res.body.asset.cost).toBeNull();
    expect(usedTx.productAsset.create).toHaveBeenCalled();
    expect(usedTx.garmentProfile.create).toHaveBeenCalled();
    const gpData = usedTx.garmentProfile.create.mock.calls[0][0].data;
    expect(gpData.styleNo).toBe('V领衬衫');
    expect(gpData.mainFabric).toBe('全棉府绸');
    expect(gpData.sizeSpec).toBe('S/M/L');
    expect(gpData.constructionNote).toBe('成衣染色');
    expect(gpData.factoryRelationId).toBe('SUP-F1');
    expect(gpData.customerRelationId).toBe('C1');
    expect(gpData.moqValue).toBe(500);
    expect(gpData.targetCost).toBe('25.5'); // Goal survives independently of actual cost.
    expect(gpData.sampleVersion).toBe('V2');
    expect(res.body.case.productAssetId).toBe(res.body.asset.id);
  });

  it.each([null, '0', '123.4567'])('成衣目标价 %j 保留为目标费用，档案实际成本仍未知', async targetPrice => {
    const tx = txMocks();
    const { app } = makeApp({ tx, devCase: { ...GARMENT_CASE, targetPrice }, batchRound: CONFIRM_BATCH });
    const res = await request(app).post('/api/v1/development/DC-G1/convert-to-asset').set(authHeader())
      .send({ sourceType: 'node', sourceId: 'confirmation' });
    expect(res.status).toBe(200);
    expect(res.body.asset.cost).toBeNull();
    expect(tx.productAsset.create.mock.calls[0][0].data.cost).toBeNull();
    expect(tx.garmentProfile.create.mock.calls[0][0].data.targetCost).toBe(targetPrice);
    expect(tx.developmentCase.update.mock.calls[0][0].data).not.toHaveProperty('targetPrice');
  });

  it('无确认批次 → 404 NODE_NOT_FOUND（确认锚点已统一开发批次，SampleNode 退役）', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert-to-asset')
      .set(authHeader())
      .send({ sourceType: 'node', sourceId: 'confirmation' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NODE_NOT_FOUND');
    expect(res.body.error.message).toContain('确认样不存在');
  });

  it('node 源仅支持确认样（sourceId=confirmation）→ 400 INVALID_NODE_LEVEL', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert-to-asset')
      .set(authHeader())
      .send({ sourceType: 'node', sourceId: 'pp' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_NODE_LEVEL');
  });

  it('DR-054 阶段 D：成衣转档自动带入产品来源（development + sourceDetail=开发案编号）', async () => {
    const tx = txMocks();
    const { app, tx: usedTx } = makeApp({ batchRound: SEALED_BATCH, tx });
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert-to-asset')
      .set(authHeader())
      .send({ sourceType: 'seal', sourceId: SEALED_BATCH.id });
    expect(res.status).toBe(200);
    expect(usedTx.productAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'development',
          sourceDetail: expect.stringContaining(GARMENT_CASE.code),
        }),
      }),
    );
  });

  // ★ G-5：上面那条「development」测试同时也是"缺陷被冻成契约"的证据 —— 成衣转档曾把 assetSource **硬编码**
  //   成 development ⇒ 案子里录了来源也会在这条路上被静默销毁。下面两条把两种形状分开钉：
  //   有来源 ⇒ 带出 customer_sample（与面料侧同一张映射表）；无来源（存量形状）⇒ 仍 development（兼容，不是已实现）。
  it('★ G-5 成衣案录了开发来源 ⇒ 转档带出 customer_sample（此前被硬编码销毁）', async () => {
    const { app, tx } = makeApp({ batchRound: SEALED_BATCH, devCase: { ...GARMENT_CASE, source: 'customer-sample' } });
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert-to-asset')
      .set(authHeader())
      .send({ sourceType: 'seal', sourceId: SEALED_BATCH.id });
    expect(res.status).toBe(200);
    expect(tx.productAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: 'customer_sample' }) }),
    );
  });

  it('★ G-5 反向对照：来源是不认识的值 ⇒ 落默认 development，不许把脏值原样写进 ProductAsset.source', async () => {
    const { app, tx } = makeApp({ batchRound: SEALED_BATCH, devCase: { ...GARMENT_CASE, source: '客户来样' } });
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert-to-asset')
      .set(authHeader())
      .send({ sourceType: 'seal', sourceId: SEALED_BATCH.id });
    expect(res.status).toBe(200);
    expect(tx.productAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: 'development' }) }),
    );
  });

  it('封存轮次未封存（非 sealed）→ 409 ROUND_NOT_SEALED', async () => {
    const { app } = makeApp({
      batchRound: { ...SEALED_BATCH, status: 'confirmed', attachments: { version: 'V1', purpose: '确认版型' } },
    });
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert-to-asset')
      .set(authHeader())
      .send({ sourceType: 'seal', sourceId: SEALED_BATCH.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROUND_NOT_SEALED');
  });

  it('封存轮次不存在 → 404 ROUND_NOT_FOUND', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert-to-asset')
      .set(authHeader())
      .send({ sourceType: 'seal', sourceId: 'SB__nope' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUND_NOT_FOUND');
  });

  it('DR-054 阶段 G-Ⅱ：轮次落 SampleBatch（sealed）→ 转档成功', async () => {
    const tx = txMocks();
    const { app } = makeApp({ batchRound: SEALED_BATCH, tx });
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert-to-asset')
      .set(authHeader())
      .send({ sourceType: 'seal', sourceId: SEALED_BATCH.id });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.asset.mainCategory).toBe('Garment');
    expect(tx.productAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'development',
          sourceDetail: expect.stringContaining(GARMENT_CASE.code),
        }),
      }),
    );
  });

  it('成衣系 trim 类型同样可转成衣档案（type 分派正确）', async () => {
    const { app } = makeApp({
      devCase: { ...GARMENT_CASE, type: 'trim' },
      batchRound: CONFIRM_BATCH,
    });
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert-to-asset')
      .set(authHeader())
      .send({ sourceType: 'node', sourceId: 'confirmation' });
    expect(res.status).toBe(200);
    expect(res.body.asset.mainCategory).toBe('Garment');
  });
});

// ────────────────────────────────────────────────────────────────────
// convertService 成衣案 ASSET_REQUIRED（强制建档后转）
// ────────────────────────────────────────────────────────────────────
describe('DR-051 convert-to-order 成衣案 ASSET_REQUIRED', () => {
  it('成衣案未转成衣档案 → 409 ASSET_REQUIRED', async () => {
    const { app } = makeApp({ devCase: GARMENT_CASE });
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert')
      .set(authHeader())
      .send({ autoCreate: true, quantity: 100, dueDate: '2026-10-01' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ASSET_REQUIRED');
    expect(res.body.error.message).toContain('成衣档案');
  });

  it('成衣案已转档案 → 放行进入转单（不再 ASSET_REQUIRED）', async () => {
    const tx = txMocks({
      order: { create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id })), findUnique: vi.fn().mockResolvedValue({ id: 'ORD-1', poNumber: 'PO-1' }) },
      orderLine: { create: vi.fn().mockResolvedValue({}) },
      productionStage: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    });
    const { app } = makeApp({
      devCase: { ...GARMENT_CASE, productAssetId: 'PROD-G1', productName: 'V领衬衫' },
      tx,
    });
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert')
      .set(authHeader())
      .send({ autoCreate: true, quantity: 100, dueDate: '2026-10-01' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.order.poNumber).toContain('PO-');
  });
});

/**
 * §9 **B39** · 位置参数内插原文（``fail(CODE, `固定文案: ${原文}`, 500)``）的执行覆盖（R3 / §6 S1）
 *
 * 棘轮只数**语法形状** ⇒ 它变绿不能证明"用户收到的是中文"。本批把这处换成字面中文，
 * **并补上了该文件原本完全没有的 `logger.error`**（实测 `logger.error` 计数为 0，且**未 import logger**）
 * —— 若只换文案不补日志，等于把唯一的线索删掉（D51）。
 *
 * 出口链已核：`development/route.ts:594` 用 `res.status(r.error.status).json({ ok: false, error: r.error })`
 * **整个 error 对象**转发 ⇒ 服务层文案就是用户看到的东西。
 */
describe('§9 B39 · 转档事务失败时用户收到的是中文，不是原始异常', () => {
  it('★ 事务抛错 ⇒ 500 + 码名不变 + 中文文案 + 响应体零原文', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const { app } = makeApp({ batchRound: CONFIRM_BATCH, txFail: true });
    const res = await request(app)
      .post('/api/v1/development/DC-G1/convert-to-asset')
      .set(authHeader())
      .send({ sourceType: 'node', sourceId: 'confirmation' });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code, '码名不得随文案一起改（前端按码分支）').toBe('CONVERT_ASSET_FAILED');
    const raw = JSON.stringify(res.body);
    expect(raw, '响应体不得含原始异常').not.toContain('TX_BOOM');
    expect(res.body.error.message, '必须含中文').toMatch(/[\u4e00-\u9fa5]/);
    expect(res.body.error.message, '必须说清对象').toContain('成衣档案');
    expect(res.body.error.message, '必须给下一步').toMatch(/(稍后重试|联系管理员)/);
    expect(res.body.error.message.match(/[A-Za-z]{3,}/g) ?? [], '混入拉丁词 = 原文上屏的指纹').toEqual([]);
    // 原文必须仍进日志（本文件原本一处 logger.error 都没有 ⇒ 这条同时证明"补日志"真的生效）
    expect(spy, 'catch 必须把原文写进日志').toHaveBeenCalledWith(
      expect.stringContaining('[GarmentDev]'), expect.objectContaining({ error: 'TX_BOOM' }));
    spy.mockRestore();
  });
});

describe('转档生命周期与锁后来源',()=>{
 it('锁案时发现已删除，返回404且不创建档案',async()=>{
  const tx=txMocks({$queryRaw:vi.fn().mockResolvedValue([])});const {app}=makeApp({tx,batchRound:CONFIRM_BATCH});
  const r=await request(app).post('/api/v1/development/DC-G1/convert-to-asset').set(authHeader()).send({sourceType:'node',sourceId:'confirmation'});
  expect(r.status).toBe(404);expect(r.body.error.code).toBe('DEV_CASE_NOT_FOUND');expect(tx.productAsset.create).not.toHaveBeenCalled();
 });
 it.each([{state:'paused'},{state:'closed',outcome:'stopped'}])('暂停或终止结案不能转档：%j',async event=>{
  const tx=txMocks({developmentLifecycleEvent:{findFirst:vi.fn().mockResolvedValue(event)}});const {app}=makeApp({tx,batchRound:CONFIRM_BATCH});
  const r=await request(app).post('/api/v1/development/DC-G1/convert-to-asset').set(authHeader()).send({sourceType:'node',sourceId:'confirmation'});
  expect(r.status).toBe(409);expect(tx.productAsset.create).not.toHaveBeenCalled();
 });
 it('成功结案仍允许认可来源转档',async()=>{
  const tx=txMocks({developmentLifecycleEvent:{findFirst:vi.fn().mockResolvedValue({state:'closed',outcome:'completed'})}});const {app}=makeApp({tx,batchRound:CONFIRM_BATCH});
  const r=await request(app).post('/api/v1/development/DC-G1/convert-to-asset').set(authHeader()).send({sourceType:'node',sourceId:'confirmation'});
  expect(r.status).toBe(200);expect(tx.productAsset.create).toHaveBeenCalledTimes(1);
 });
 it('跨案封样及锁后撤回确认都不能写档案',async()=>{
  const first=makeApp({batchRound:{...SEALED_BATCH,developmentCaseId:'OTHER'}});
  const cross=await request(first.app).post('/api/v1/development/DC-G1/convert-to-asset').set(authHeader()).send({sourceType:'seal',sourceId:SEALED_BATCH.id});
  expect(cross.status).toBe(404);expect(first.tx.productAsset.create).not.toHaveBeenCalled();
  const tx=txMocks({sampleBatch:{findFirst:vi.fn().mockResolvedValue({...CONFIRM_BATCH,status:'pending'})}});const second=makeApp({tx,batchRound:CONFIRM_BATCH});
  const changed=await request(second.app).post('/api/v1/development/DC-G1/convert-to-asset').set(authHeader()).send({sourceType:'node',sourceId:'confirmation'});
  expect(changed.status).toBe(409);expect(tx.productAsset.create).not.toHaveBeenCalled();
 });
});
