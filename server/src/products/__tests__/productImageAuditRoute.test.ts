import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { createProductsRouter } from '../route';

// W-C 权限收口：路由已叠加 products:read/write scope 门（requirePermission 需 req.actor）。
// 本文件不测权限（requireAuth=false dev 模式），统一注入有效 owner JWT 通过 scope 门。
const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const injectOwnerJwt = (app: express.Express) => {
  app.use((req, _res, next) => {
    req.headers.authorization = req.headers.authorization || `Bearer ${ownerToken}`;
    next();
  });
};

function makeApp(opts: { auditFail?: boolean; onDataChange?: any; uploadDir?: string } = {}) {
  const uploadDir = opts.uploadDir || '/tmp/test-uploads';
  try { fs.mkdirSync(uploadDir, { recursive: true }); } catch { /* ignore */ }
  const auditCreate = opts.auditFail ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT')) : vi.fn().mockResolvedValue({});
  const onDataChange = opts.onDataChange || vi.fn();
  const productImageCreate = vi.fn().mockResolvedValue({ id: 'IMG-1', filePath: 'products/PROD-1/test.jpg', isPrimary: true });
  const productImageUpdate = vi.fn().mockResolvedValue({});
  const productImageUpdateMany = vi.fn().mockResolvedValue({});
  const productImageFindFirst = vi.fn().mockResolvedValue({ id: 'IMG-1', productAssetId: 'PROD-1', filePath: 'products/PROD-1/test.jpg', isPrimary: true, deletedAt: null });
  const productImageCount = vi.fn().mockResolvedValue(0);
  const productAssetUpdate = vi.fn().mockResolvedValue({});
  const productAssetFindFirst = vi.fn().mockResolvedValue({ id: 'PROD-1', deletedAt: null });
  const prisma = {
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    auditLog: { create: auditCreate },
    productAsset: { update: productAssetUpdate, findFirst: productAssetFindFirst },
    productImage: { create: productImageCreate, update: productImageUpdate, updateMany: productImageUpdateMany, findFirst: productImageFindFirst, count: productImageCount },
  } as any;
  const app = express();
  app.use(express.json());
  injectOwnerJwt(app);
  app.use('/api/v1/products', createProductsRouter({ prisma, requireAuth: false, apiKeys: new Set<string>(), uploadDir, onDataChange }));
  return { app, prisma, auditCreate, onDataChange, productImageCreate, productImageUpdate, productImageUpdateMany, productAssetUpdate, productImageFindFirst };
}

describe('task ERP-P1 product-image-audit: POST upload audit + rollback cleanup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upload audit 同事务（auditLog.create 被调用）', async () => {
    const { app, auditCreate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/products/assets/PROD-1/images').attach('files', Buffer.from('fakeimg'), 'test.jpg');
    expect(res.status).toBe(201);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('audit reject → fail closed（$transaction 回滚，onDataChange 不触发）', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).post('/api/v1/products/assets/PROD-1/images').attach('files', Buffer.from('fakeimg'), 'test.jpg');
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('task ERP-P1 product-image-audit: DELETE primary promotion + audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delete audit 同事务（auditLog.create 被调用）', async () => {
    const { app, auditCreate, onDataChange } = makeApp();
    const res = await request(app).delete('/api/v1/products/assets/PROD-1/images/IMG-1');
    expect(res.status).toBe(200);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('audit reject → fail closed（onDataChange 不触发）', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).delete('/api/v1/products/assets/PROD-1/images/IMG-1');
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
  });

});

describe('task ERP-P1 product-image-audit: PATCH set-primary audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('set-primary audit 同事务（auditLog.create 被调用）', async () => {
    const { app, auditCreate, onDataChange } = makeApp();
    const res = await request(app).patch('/api/v1/products/assets/PROD-1/images/IMG-1/primary');
    expect(res.status).toBe(200);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('audit reject → fail closed', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).patch('/api/v1/products/assets/PROD-1/images/IMG-1/primary');
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('task ERP-P1 product-image-audit: PATCH reorder audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reorder audit 同事务（auditLog.create 被调用）', async () => {
    const { app, auditCreate, onDataChange } = makeApp();
    const res = await request(app).patch('/api/v1/products/assets/PROD-1/images/reorder').send({ orders: [{ id: 'IMG-1', sortOrder: 0 }] });
    expect(res.status).toBe(200);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('audit reject → fail closed', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).patch('/api/v1/products/assets/PROD-1/images/reorder').send({ orders: [{ id: 'IMG-1', sortOrder: 0 }] });
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('非 orders 数组 → 400 VALIDATION_FAILED', async () => {
    const { app } = makeApp();
    const res = await request(app).patch('/api/v1/products/assets/PROD-1/images/reorder').send({ foo: 'bar' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('task ERP-P1 product-image-audit: upload rollback cleanup（真实文件删除）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('audit reject → multer 落盘文件被删除（best-effort cleanup）', async () => {
    const uploadDir = '/tmp/test-upload-rollback';
    try { fs.mkdirSync(uploadDir, { recursive: true }); } catch { /* ignore */ }
    const { app, onDataChange } = makeApp({ auditFail: true, uploadDir });
    const res = await request(app).post('/api/v1/products/assets/PROD-1/images').attach('files', Buffer.from('fakeimg'), 'rollback-test.jpg');
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
    // multer 落盘文件应已被清理（rollback-test-* 在 uploadDir 下不存在）
    const remaining = fs.readdirSync(uploadDir).filter((f) => f.includes('rollback-test'));
    expect(remaining).toHaveLength(0);
  });

  it('ProductAsset 不存在 → 404（不是 500），且文件 best-effort 清理', async () => {
    const uploadDir = '/tmp/test-upload-notfound';
    try { fs.mkdirSync(uploadDir, { recursive: true }); } catch { /* ignore */ }
    const auditCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn(prisma)),
      auditLog: { create: auditCreate },
      productAsset: { update: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
      productImage: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    } as any;
    const app = express();
    app.use(express.json());
    injectOwnerJwt(app);
    app.use('/api/v1/products', createProductsRouter({ prisma, requireAuth: false, apiKeys: new Set<string>(), uploadDir }));
    const res = await request(app).post('/api/v1/products/assets/MISSING/images').attach('files', Buffer.from('fakeimg'), 'notfound-test.jpg');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    // 文件 best-effort 清理
    const remaining = fs.readdirSync(uploadDir).filter((f) => f.includes('notfound-test'));
    expect(remaining).toHaveLength(0);
  });
});
