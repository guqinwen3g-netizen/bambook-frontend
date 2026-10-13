import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { createProductsRouter } from '../route';

// W-C 权限收口：路由已叠加 products:read/write scope 门（requirePermission 需 req.actor）。
// 本文件不测权限（requireAuth=false dev 模式），统一注入有效 owner JWT 通过 scope 门。
const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);

function makeApp(opts: { auditFail?: boolean; onDataChange?: any } = {}) {
  const auditCreate = opts.auditFail ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT')) : vi.fn().mockResolvedValue({});
  const productAssetCreate = vi.fn().mockResolvedValue({ id: 'PROD-1' });
  const productAssetUpdate = vi.fn().mockResolvedValue({});
  const productAssetFindFirst = vi.fn().mockResolvedValue({ id: 'PROD-1', sku: 'SKU1', name: 'Test', fabricProfile: null, deletedAt: null });
  const fabricPriceHistoryCreateMany = vi.fn().mockResolvedValue({ count: 1 });
  const onDataChange = opts.onDataChange || vi.fn();
  const prisma = {
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    auditLog: { create: auditCreate },
    productAsset: { create: productAssetCreate, update: productAssetUpdate, findFirst: productAssetFindFirst },
    fabricProfile: { update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    garmentProfile: { update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    trimmingProfile: { update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    fabricCustomerCode: { deleteMany: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
    fabricPriceHistory: { deleteMany: vi.fn(), createMany: fabricPriceHistoryCreateMany, updateMany: vi.fn() },
    fabricCertification: { deleteMany: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
    fabricCompositionLine: { deleteMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    materialCompositionTerm: { upsert: vi.fn() },
  } as any;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.headers.authorization = req.headers.authorization || `Bearer ${ownerToken}`;
    next();
  });
  app.use('/api/v1/products', createProductsRouter({ prisma, requireAuth: false, apiKeys: new Set<string>(), uploadDir: '/tmp', onDataChange }));
  return { app, prisma, auditCreate, onDataChange, fabricPriceHistoryCreateMany, productAssetCreate };
}

describe('task ERP-P1 product-audit-decimal: POST create audit + Decimal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create audit 同事务（auditLog.create 被调用）', async () => {
    const { app, auditCreate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/products/assets').send({ sku: 'SKU1', name: 'Test', mainCategory: 'Fabric' });
    expect(res.status).toBe(201);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('audit reject → fail closed（事务回滚，onDataChange 不触发）', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).post('/api/v1/products/assets').send({ sku: 'SKU1', name: 'Test', mainCategory: 'Fabric' });
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('cost Decimal-safe（new Prisma.Decimal，不 Number）', async () => {
    const { app, productAssetCreate } = makeApp();
    await request(app).post('/api/v1/products/assets').send({ sku: 'SKU1', name: 'Test', mainCategory: 'Fabric', cost: '123.4567' });
    const createData = productAssetCreate.mock.calls[0][0].data;
    expect(createData.cost).toBeInstanceOf(Prisma.Decimal);
    expect(createData.cost.toString()).toBe('123.4567');
  });
});

describe('task ERP-P1 product-audit-decimal: PATCH update audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('update audit 同事务（auditLog.create 被调用）', async () => {
    const { app, auditCreate, onDataChange } = makeApp();
    const res = await request(app).patch('/api/v1/products/assets/PROD-1').send({ name: 'Updated' });
    expect(res.status).toBe(200);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('audit reject → fail closed（onDataChange 不触发）', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).patch('/api/v1/products/assets/PROD-1').send({ name: 'Updated' });
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('cost Decimal-safe（PATCH cost）', async () => {
    const { app, prisma } = makeApp();
    await request(app).patch('/api/v1/products/assets/PROD-1').send({ cost: '999.9999' });
    const updateData = prisma.productAsset.update.mock.calls[0][0].data;
    expect(updateData.cost).toBeInstanceOf(Prisma.Decimal);
    expect(updateData.cost.toString()).toBe('999.9999');
  });
});

describe('task ERP-P1 product-audit-decimal: DELETE audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delete audit 同事务（auditLog.create 被调用）', async () => {
    const { app, auditCreate, onDataChange } = makeApp();
    const res = await request(app).delete('/api/v1/products/assets/PROD-1');
    expect(res.status).toBe(200);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('audit reject → fail closed（onDataChange 不触发）', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).delete('/api/v1/products/assets/PROD-1');
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('task ERP-P1 product-audit-decimal: FabricPriceHistory amount Decimal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('amount Decimal-safe（fabricPrices 传入 → new Prisma.Decimal）', async () => {
    const { app, fabricPriceHistoryCreateMany } = makeApp();
    await request(app).post('/api/v1/products/assets').send({
      sku: 'SKU1', name: 'Test', mainCategory: 'Fabric',
      fabricPrices: [{ priceType: 'factory', amount: '12.3456', currency: 'USD' }],
    });
    expect(fabricPriceHistoryCreateMany).toHaveBeenCalledTimes(1);
    const createdData = fabricPriceHistoryCreateMany.mock.calls[0][0].data[0];
    expect(createdData.amount).toBeInstanceOf(Prisma.Decimal);
    expect(createdData.amount.toString()).toBe('12.3456');
  });
});

describe('task ERP-P1 product-audit-decimal: 非法 Decimal fail closed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST cost 非法（abc）→ 400 INVALID_AMOUNT（不进 $transaction、不写 audit、不触发 onDataChange）', async () => {
    const { app, prisma, auditCreate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/products/assets').send({ sku: 'SKU1', name: 'Test', mainCategory: 'Fabric', cost: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_AMOUNT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('POST fabricPrices amount 非法（xyz）→ 400 INVALID_AMOUNT', async () => {
    const { app, prisma, auditCreate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/products/assets').send({ sku: 'SKU1', name: 'Test', mainCategory: 'Fabric', fabricPrices: [{ priceType: 'factory', amount: 'xyz', currency: 'USD' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_AMOUNT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('PATCH cost 非法（NaN 字符串）→ 400 INVALID_AMOUNT', async () => {
    const { app, prisma, auditCreate, onDataChange } = makeApp();
    const res = await request(app).patch('/api/v1/products/assets/PROD-1').send({ cost: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_AMOUNT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('PATCH fabricPrices amount 非法（Infinity）→ 400 INVALID_AMOUNT', async () => {
    const { app, prisma, auditCreate, onDataChange } = makeApp();
    const res = await request(app).patch('/api/v1/products/assets/PROD-1').send({ fabricPrices: [{ priceType: 'factory', amount: 'Infinity', currency: 'USD' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_AMOUNT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });
});
