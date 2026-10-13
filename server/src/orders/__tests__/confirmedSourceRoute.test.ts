/**
 * confirmedSourceRoute.test.ts — DR-053 阶段 1：直接返单（POST /orders/lines）+ 版本补录（PATCH /order-lines/:id/version）
 *
 * 验收映射（设计文档 §13.8）：
 *  - 直接返单（Asset）→ 201 建单+行（版本引用+规格快照）
 *  - 错误工厂被拒绝 → 409 MILL_MISMATCH
 *  - 重复请求不重复建单 → 同 clientRequestId recovered=true
 *  - 历史行补录版本（不伪造，成果校验后写入 confirmed*+specSnapshot）
 */
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOrdersRouter } from '../route';
import { createOrderLinesRouter } from '../orderLinesRoute';
import { authHeader } from '../../__tests__/authTestHelper';

const ASSET = { id: 'PA-1', sku: 'SKU-1', name: '档案1', mainCategory: 'fabric', fabricProfile: { millName: 'Factory A', construction: '斜纹' }, garmentProfile: null };

function makeOrdersApp(opts: { assets?: any[]; seals?: any[]; samples?: any[]; orderByRequestId?: any } = {}) {
  const state: any = { orders: [] as any[], lines: [] as any[] };
  // No development provenance for these explicitly independent Asset fixtures.
  const independentSource = {
    developmentCase: { findMany: vi.fn().mockResolvedValue([]) },
    sampleBatch: { findMany: vi.fn().mockResolvedValue([]) },
    sealSample: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked-independent-asset' }]),
  };
  const prisma: any = {
    ...independentSource,
    order: {
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where?.clientRequestId) return opts.orderByRequestId ?? null;
        return null;
      }),
    },
    sealSample: { ...independentSource.sealSample, findFirst: vi.fn().mockImplementation(async ({ where }: any) => opts.seals?.find((s: any) => s.id === where.id && !s.deletedAt) ?? null) },
    sample: { findFirst: vi.fn().mockImplementation(async ({ where }: any) => opts.samples?.find((s: any) => s.id === where.id && !s.deletedAt) ?? null) },
    productAsset: { findUnique: vi.fn().mockImplementation(async ({ where }: any) => opts.assets?.find((a: any) => a.id === where.id) ?? null) },
    $transaction: vi.fn(async (fn: any) => {
      const tx = {
        ...independentSource,
        productAsset: prisma.productAsset,
        order: { create: vi.fn().mockImplementation(async ({ data }: any) => { const o = { id: data.id, ...data }; state.orders.push(o); return o; }) },
        orderLine: { create: vi.fn().mockImplementation(async ({ data }: any) => { const l = { id: data.id, ...data }; state.lines.push(l); return l; }) },
        auditLog: { ...independentSource.auditLog, create: vi.fn().mockResolvedValue({ id: 'AUD-1' }) },
        entityReference: { upsert: vi.fn().mockResolvedValue({}) },
        entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    }),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/orders', createOrdersRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange: vi.fn() }));
  return { app, state };
}

function makeOrderLinesApp(opts: { line?: any; assets?: any[]; seals?: any[] } = {}) {
  let line = { confirmedSourceType: null, confirmedSourceId: null, confirmedAt: null, confirmedBy: null, ...(opts.line ?? { id: 'OL-1', orderId: 'ORD-1' }) };
  const order = { id: line.orderId, deletedAt: null, type: 'fabric', status: 'Pending', sourceCaseId: null, customerRelationId: null, customer: '', millRelationId: 'R-A' };
  // A seal with a converted asset is the actual converted state, with an
  // explicit recorded legacy conversion/audited source seam. No new approval
  // is invented by the production consumer; true native evidence is separate.
  const seals = (opts.seals ?? []).map(seal => ({ developmentCaseId: 'LEGACY-CASE', ...seal, status: seal.convertedProductAssetId ? 'converted' : seal.status }));
  const conversionAudits = seals.filter(seal => seal.convertedProductAssetId).map(seal => ({ id: 'CONVERT-' + seal.id, actorId: 'u_owner', action: 'convert_fabric_to_asset', targetType: 'ProductAsset', targetId: seal.convertedProductAssetId,
    detail: { source: 'route:dev:fabric-convert-asset', after: { fromCase: seal.developmentCaseId, sourceType: 'seal', sourceId: seal.id } } }));
  const prisma: any = {
    userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u_owner', status: 'active', deletedAt: null, roles: [{ roleId: 'role-super-admin', role: { permissions: ['orders:write'].map(scope => ({ permission: { scope } })) } }] }) },
    userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
    approvalRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    order: { findFirst: vi.fn(async ({ where }: any) => where.id === order.id && where.deletedAt === null ? order : null) },
    $queryRaw: vi.fn(async (query: any) => query.sql.includes('"OrderLine"') ? [{ id: line.id }] : [{ id: order.id }]),
    orderLine: {
      findUnique: vi.fn().mockResolvedValue(line),
      findUniqueOrThrow: vi.fn(async () => line),
      findFirst: vi.fn(async ({ where }: any) => where.id === line.id && where.order?.deletedAt === null ? line : null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (['confirmedSourceType', 'confirmedSourceId', 'confirmedAt', 'confirmedBy'].some(key => where[key] !== (line as any)[key])) return { count: 0 };
        line = { ...line, ...data }; return { count: 1 };
      }),
      update: vi.fn().mockImplementation(async ({ data }: any) => ({ ...line, ...data })),
    },
    sealSample: { findFirst: vi.fn().mockImplementation(async ({ where }: any) => seals.find(s => s.id === where.id && !s.deletedAt) ?? null), findMany: vi.fn(async ({ where }: any) => seals.filter(seal => seal.convertedProductAssetId === where.convertedProductAssetId)) },
    developmentCase: { findFirst: vi.fn(async () => ({ id: 'LEGACY-CASE', type: 'fabric' })), findMany: vi.fn(async ({ where }: any) => seals.some(seal => seal.convertedProductAssetId === where.productAssetId) ? [{ id: 'LEGACY-CASE', type: 'fabric' }] : []) },
    sealSampleBatch: { findMany: vi.fn(async () => [{ sampleBatchId: 'LEGACY-BATCH' }]) },
    sampleBatch: { findMany: vi.fn(async ({ where }: any) => where.OR ? [] : [{ id: 'LEGACY-BATCH', developmentCaseId: 'LEGACY-CASE', status: 'approved', round: 1, approvedAt: BigInt(1), approvedBy: 'u_owner' }]) },
    sample: { findFirst: vi.fn().mockResolvedValue(null) },
    entityReference: { findMany: vi.fn().mockResolvedValue([]) },
    fabricCustomerCode: { findMany: vi.fn().mockResolvedValue([]) },
    relation: { findFirst: vi.fn(async ({ where }: any) => where.id === 'R-A' && where.deletedAt === null ? { id: 'R-A', name: 'Factory A', deletedAt: null } : null) },
    productAsset: { findUnique: vi.fn().mockImplementation(async ({ where }: any) => opts.assets?.find((a: any) => a.id === where.id) ?? null), findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'AUD-1' }), findMany: vi.fn(async ({ where }: any) => conversionAudits.filter(row => row.targetId === where.targetId)) },
  };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  const app = express();
  app.use(express.json());
  app.use('/api/v1/order-lines', createOrderLinesRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange: vi.fn() }));
  return { app, prisma };
}

describe('DR-053 阶段 1：POST /orders/lines 直接返单（不经开发案，同一套版本契约）', () => {
  it('Asset 直接返单 → 201 建单+行（版本引用 confirmedSourceType=Asset + 规格快照）', async () => {
    const { app, state } = makeOrdersApp({ assets: [ASSET] });
    const res = await request(app).post('/api/v1/orders/lines').set(authHeader()).send({
      confirmedSourceType: 'Asset', confirmedSourceId: 'PA-1', millRelationId: 'R-A',
      clientRequestId: 'direct-1', quantity: 200, dueDate: '2026-12-01', quoteAmount: 9000,
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.recovered).toBe(false);
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0].clientRequestId).toBe('direct-1');
    expect(state.orders[0].millRelationId).toBe('R-A');
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0].confirmedSourceType).toBe('Asset');
    expect(state.lines[0].confirmedSourceId).toBe('PA-1');
    expect(state.lines[0].specSnapshot.fabric.construction).toBe('斜纹');
  });

  it('重复请求不重复建单：同 clientRequestId → recovered=true 返回已有订单', async () => {
    const { app, state } = makeOrdersApp({ assets: [ASSET], orderByRequestId: { id: 'ORD-EXIST', clientRequestId: 'direct-dup' } });
    const res = await request(app).post('/api/v1/orders/lines').set(authHeader()).send({
      confirmedSourceType: 'Asset', confirmedSourceId: 'PA-1', millRelationId: 'R-A',
      clientRequestId: 'direct-dup', quantity: 200, dueDate: '2026-12-01',
    });
    expect(res.status).toBe(200);
    expect(res.body.recovered).toBe(true);
    expect(res.body.order.id).toBe('ORD-EXIST');
    expect(state.orders).toHaveLength(0); // 未新建
  });

  it('错误工厂被拒绝：Asset 档案工厂与 millRelationId 不一致 → 409 MILL_MISMATCH', async () => {
    const { app } = makeOrdersApp({ assets: [{ ...ASSET, fabricProfile: { millName: 'Factory A', millOrganizationId: 'R-A', construction: '斜纹' } }] });
    const res = await request(app).post('/api/v1/orders/lines').set(authHeader()).send({
      confirmedSourceType: 'Asset', confirmedSourceId: 'PA-1', millRelationId: 'R-B',
      clientRequestId: 'direct-x', quantity: 200, dueDate: '2026-12-01',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MILL_MISMATCH');
  });

  it('缺确认成果 → 400 CONFIRMED_SOURCE_REQUIRED', async () => {
    const { app } = makeOrdersApp();
    const res = await request(app).post('/api/v1/orders/lines').set(authHeader()).send({ quantity: 200, dueDate: '2026-12-01' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONFIRMED_SOURCE_REQUIRED');
  });

  it('档案不存在 → 404 CONFIRMED_SOURCE_NOT_FOUND', async () => {
    const { app } = makeOrdersApp({ assets: [] });
    const res = await request(app).post('/api/v1/orders/lines').set(authHeader()).send({
      confirmedSourceType: 'Asset', confirmedSourceId: 'PA-GHOST', millRelationId: 'R-A',
      clientRequestId: 'direct-g', quantity: 200, dueDate: '2026-12-01',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONFIRMED_SOURCE_NOT_FOUND');
  });
});

describe('DR-053 阶段 1：PATCH /order-lines/:id/version 历史行补录（不伪造版本）', () => {
  it('补录成功：校验成果后写入 confirmed* + specSnapshot + 审计', async () => {
    const { app, prisma } = makeOrderLinesApp({ line: { id: 'OL-1', orderId: 'ORD-1', confirmedSourceType: null }, assets: [ASSET], seals: [{ id: 'SEAL-1', sealCode: 'SEAL-1-001', status: 'sealed', supplierRelationId: 'R-A', convertedProductAssetId: 'PA-1', deletedAt: null }] });
    const res = await request(app).patch('/api/v1/order-lines/OL-1/version').set(authHeader()).send({
      confirmedSourceType: 'SealSample', confirmedSourceId: 'SEAL-1', millRelationId: 'R-A',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.line.confirmedSourceType).toBe('SealSample');
    expect(res.body.line.confirmedSourceId).toBe('SEAL-1');
    expect(res.body.line.specSnapshot.fabric.construction).toBe('斜纹');
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('成果不存在 → 404 CONFIRMED_SOURCE_NOT_FOUND（不写入）', async () => {
    const { app, prisma } = makeOrderLinesApp({ line: { id: 'OL-1', orderId: 'ORD-1' }, assets: [ASSET] });
    const res = await request(app).patch('/api/v1/order-lines/OL-1/version').set(authHeader()).send({
      confirmedSourceType: 'SealSample', confirmedSourceId: 'SEAL-GHOST', millRelationId: 'R-A',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONFIRMED_SOURCE_NOT_FOUND');
    expect(prisma.orderLine.update).not.toHaveBeenCalled();
    expect(prisma.orderLine.updateMany).not.toHaveBeenCalled();
  });

  it('缺 confirmedSource* → 400 CONFIRMED_SOURCE_REQUIRED', async () => {
    const { app } = makeOrderLinesApp();
    const res = await request(app).patch('/api/v1/order-lines/OL-1/version').set(authHeader()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONFIRMED_SOURCE_REQUIRED');
  });
});
