import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { tmpdir } from 'node:os';
import jwt from 'jsonwebtoken';
import { createProductsRouter } from '../route';

// W-C 权限收口：路由已叠加 products:read/write scope 门（requirePermission 需 req.actor）。
// 本文件不测权限（requireAuth=false dev 模式），统一注入有效 owner JWT 通过 scope 门。
const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.headers.authorization = req.headers.authorization || `Bearer ${ownerToken}`;
    next();
  });
  app.use('/api/v1/products', createProductsRouter({ prisma, requireAuth: false, apiKeys: new Set<string>(), uploadDir: tmpdir() }));
  return app;
}

describe('products route', () => {
  it('GET /assets returns active product assets with fabric details', async () => {
    const prisma = {
      productAsset: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'PROD-1',
            sku: 'FAB-001',
            name: 'Black wool twill',
            mainCategory: 'Fabric',
            updatedAt: BigInt(100),
            deletedAt: null,
            fabricProfile: { millQuality: 'MQ-001', articleNo: 'ART-001' },
            fabricCustomerCodes: [],
            fabricPrices: [],
            fabricCertifications: [],
            compositionLines: [],
          },
        ]),
        count: vi.fn().mockResolvedValue(37),
      },
    };

    const res = await request(makeApp(prisma)).get('/api/v1/products/assets?mainCategory=Fabric&limit=20&offset=5');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.assets).toHaveLength(1);
    expect(res.body.assets[0].updatedAt).toBe(100);
    expect(res.body.total).toBe(37);
    expect(res.body.limit).toBe(20);
    expect(res.body.offset).toBe(5);
    expect(res.body.hasMore).toBe(true);
    expect(prisma.productAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null, mainCategory: 'Fabric' }),
        take: 20,
        skip: 5,
      }),
    );
    expect(prisma.productAsset.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null, mainCategory: 'Fabric' }),
      }),
    );
  });

  it('POST /assets/query runs structured filters, sorting, and pagination for Agent access', async () => {
    const prisma = {
      productAsset: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'PROD-RWS-1',
            sku: 'FAB-RWS-001',
            name: 'RWS wool suiting',
            mainCategory: 'Fabric',
            updatedAt: BigInt(500),
            fabricProfile: { articleNo: 'RWS-ART-001', weightValue: 260 },
            fabricCustomerCodes: [],
            fabricPrices: [],
            fabricCertifications: [{ certification: 'RWS', deletedAt: null }],
            compositionLines: [],
          },
        ]),
        count: vi.fn().mockResolvedValue(12),
      },
    };

    const res = await request(makeApp(prisma))
      .post('/api/v1/products/assets/query')
      .send({
        entity: 'ProductAsset',
        aggregate: 'list',
        query: '',
        filters: {
          fieldFilters: [
            { path: 'mainCategory', operator: 'equals', value: 'Fabric' },
            { path: 'fabric.certification', operator: 'contains', value: 'RWS' },
            { path: 'fabric.weightValue', operator: 'gte', value: 250 },
          ],
        },
        sort: { field: 'updatedAt', direction: 'desc' },
        limit: 10,
        offset: 0,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dataSource).toBe('bambook-data-center');
    expect(res.body.total).toBe(12);
    expect(res.body.assets[0].updatedAt).toBe(500);
    expect(prisma.productAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          { deletedAt: null },
          { mainCategory: { equals: 'Fabric', mode: 'insensitive' } },
          { fabricCertifications: { some: { deletedAt: null, certification: { contains: 'RWS', mode: 'insensitive' } } } },
          { fabricProfile: { is: { weightValueGsm: { gte: 250 } } } },
        ]),
      }),
      orderBy: { updatedAt: 'desc' },
      take: 10,
      skip: 0,
    }));
    expect(prisma.productAsset.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          { deletedAt: null },
          { mainCategory: { equals: 'Fabric', mode: 'insensitive' } },
        ]),
      }),
    }));
  });

  it('POST /assets rejects missing sku', async () => {
    const prisma = { productAsset: { create: vi.fn() } };

    const res = await request(makeApp(prisma))
      .post('/api/v1/products/assets')
      .send({ name: 'Missing SKU', mainCategory: 'Fabric' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(prisma.productAsset.create).not.toHaveBeenCalled();
  });

  it('POST /assets creates a fabric asset with profile', async () => {
    const prisma = {
      $transaction: vi.fn(async (fn) => fn(prisma)),
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      fabricProfile: { create: vi.fn().mockResolvedValue({}) },
      garmentProfile: { create: vi.fn().mockResolvedValue({}) },
      trimmingProfile: { create: vi.fn().mockResolvedValue({}) },
      productAsset: {
        create: vi.fn().mockResolvedValue({
          id: 'PROD-100',
          sku: 'FAB-100',
          name: 'Navy stretch wool',
          mainCategory: 'Fabric',
          updatedAt: BigInt(200),
          fabricProfile: {
            id: 'FAB-100',
            millQuality: 'MQ-100',
          },
        }),
        findFirst: vi.fn().mockResolvedValue({
          id: 'PROD-100',
          sku: 'FAB-100',
          name: 'Navy stretch wool',
          mainCategory: 'Fabric',
          updatedAt: BigInt(200),
          fabricProfile: { id: 'FAB-100', millQuality: 'MQ-100' },
          fabricCustomerCodes: [],
          fabricPrices: [],
          fabricCertifications: [],
          compositionLines: [],
        }),
      },
    };

    const res = await request(makeApp(prisma))
      .post('/api/v1/products/assets')
      .send({
        sku: 'FAB-100',
        name: 'Navy stretch wool',
        mainCategory: 'Fabric',
        fabricProfile: { millQuality: 'MQ-100', widthText: '57/58', moqValue: 1000, factoryMoqValue: 2000, sampleMoqValue: 10.3 },
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.asset.updatedAt).toBe(200);
    expect(prisma.productAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sku: 'FAB-100',
          mainCategory: 'Fabric',
        }),
      }),
    );
    expect(prisma.fabricProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productAssetId: 'PROD-100',
          millQuality: 'MQ-100',
          widthText: '57/58',
          moqValue: 1000,
          factoryMoqValue: 2000,
          sampleMoqValue: 10.3,
        }),
      }),
    );
  });

  it('POST /assets derives weightValueGsm（oz/yd² → g/m² 服务端单一真源）', async () => {
    const prisma = {
      $transaction: vi.fn(async (fn) => fn(prisma)),
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      fabricProfile: { create: vi.fn().mockResolvedValue({}) },
      garmentProfile: { create: vi.fn().mockResolvedValue({}) },
      trimmingProfile: { create: vi.fn().mockResolvedValue({}) },
      productAsset: {
        create: vi.fn().mockResolvedValue({ id: 'PROD-101', sku: 'FAB-101', name: 'Denim', mainCategory: 'Fabric', updatedAt: BigInt(201) }),
        findFirst: vi.fn().mockResolvedValue({
          id: 'PROD-101', sku: 'FAB-101', name: 'Denim', mainCategory: 'Fabric', updatedAt: BigInt(201),
          fabricProfile: { id: 'FAB-101', weightValue: 12, weightUnit: 'oz/yd²', weightValueGsm: 406.9 },
          fabricCustomerCodes: [], fabricPrices: [], fabricCertifications: [], compositionLines: [],
        }),
      },
    };

    const res = await request(makeApp(prisma))
      .post('/api/v1/products/assets')
      .send({
        sku: 'FAB-101',
        name: 'Denim',
        mainCategory: 'Fabric',
        fabricProfile: { weightValue: 12, weightUnit: 'oz/yd²' },
      });

    expect(res.status).toBe(201);
    expect(prisma.fabricProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ weightValue: 12, weightUnit: 'oz/yd²', weightValueGsm: 406.9 }),
      }),
    );
  });

  it('POST /assets 支持产品来源（source/sourceDetail，DR-054 阶段 D）', async () => {
    const prisma = {
      $transaction: vi.fn(async (fn) => fn(prisma)),
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      fabricProfile: { create: vi.fn().mockResolvedValue({}) },
      garmentProfile: { create: vi.fn().mockResolvedValue({}) },
      trimmingProfile: { create: vi.fn().mockResolvedValue({}) },
      productAsset: {
        create: vi.fn().mockResolvedValue({ id: 'PROD-101', sku: 'FAB-101', name: 'Sourcing fabric', mainCategory: 'Fabric', updatedAt: BigInt(201) }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };

    const res = await request(makeApp(prisma))
      .post('/api/v1/products/assets')
      .send({
        sku: 'FAB-101',
        name: 'Sourcing fabric',
        mainCategory: 'Fabric',
        source: 'sourcing',
        sourceDetail: '2026 秋冬 sourcing 季',
      });

    expect(res.status).toBe(201);
    expect(prisma.productAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: 'sourcing', sourceDetail: '2026 秋冬 sourcing 季' }),
      }),
    );
  });

  it('POST /assets 非法来源回退 manual（白名单 fail-safe，DR-054 阶段 D）', async () => {
    const prisma = {
      $transaction: vi.fn(async (fn) => fn(prisma)),
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      fabricProfile: { create: vi.fn().mockResolvedValue({}) },
      garmentProfile: { create: vi.fn().mockResolvedValue({}) },
      trimmingProfile: { create: vi.fn().mockResolvedValue({}) },
      productAsset: {
        create: vi.fn().mockResolvedValue({ id: 'PROD-101', sku: 'FAB-101', name: 'Any', mainCategory: 'Fabric', updatedAt: BigInt(201) }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };

    const res = await request(makeApp(prisma))
      .post('/api/v1/products/assets')
      .send({
        sku: 'FAB-101',
        name: 'Any',
        mainCategory: 'Fabric',
        source: 'hacked-value',
      });

    expect(res.status).toBe(201);
    expect(prisma.productAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: 'manual' }),
      }),
    );
  });

  it('POST /assets filters UI-only fabric profile fields before Prisma create', async () => {
    const prisma = {
      $transaction: vi.fn(async (fn) => fn(prisma)),
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      fabricProfile: { create: vi.fn().mockResolvedValue({}) },
      garmentProfile: { create: vi.fn().mockResolvedValue({}) },
      trimmingProfile: { create: vi.fn().mockResolvedValue({}) },
      productAsset: {
        create: vi.fn().mockResolvedValue({
          id: 'PROD-101',
          sku: 'FAB-101',
          name: 'Grey twill',
          mainCategory: 'Fabric',
          updatedAt: BigInt(201),
        }),
        findFirst: vi.fn().mockResolvedValue({
          id: 'PROD-101',
          sku: 'FAB-101',
          name: 'Grey twill',
          mainCategory: 'Fabric',
          updatedAt: BigInt(201),
          fabricProfile: { millQuality: 'MQ-101' },
          fabricCustomerCodes: [],
          fabricPrices: [],
          fabricCertifications: [],
          compositionLines: [],
        }),
      },
    };

    const res = await request(makeApp(prisma))
      .post('/api/v1/products/assets')
      .send({
        sku: 'FAB-101',
        name: 'Grey twill',
        mainCategory: 'Fabric',
        fabricProfile: {
          productAssetId: 'client-should-not-write-this',
          millQuality: 'MQ-101',
          uiOnly: 'ignored',
        },
      });

    expect(res.status).toBe(201);
    expect(prisma.fabricProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productAssetId: 'PROD-101',
          millQuality: 'MQ-101',
        }),
      }),
    );
    expect(prisma.fabricProfile.create.mock.calls[0][0].data).not.toMatchObject({
      productAssetId: 'client-should-not-write-this',
      uiOnly: 'ignored',
    });
  });

  it('GET /assets/:id returns product detail', async () => {
    const prisma = {
      productAsset: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'PROD-1',
          sku: 'FAB-001',
          name: 'Black wool twill',
          updatedAt: BigInt(300),
          fabricProfile: { millQuality: 'MQ-001' },
        }),
      },
    };

    const res = await request(makeApp(prisma)).get('/api/v1/products/assets/PROD-1');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.asset.id).toBe('PROD-1');
    expect(res.body.asset.updatedAt).toBe(300);
    expect(res.body.relatedOrderLines).toEqual([]);
  });

  it('GET /assets/:id 关联订单反查主通道 = OrderLine.materialCode 与档案 sku（真实链路）', async () => {
    const orderLineFindMany = vi.fn().mockResolvedValue([
      { id: 'OL-1', materialCode: 'FAB-001', lineNumber: 1, quantity: '100', order: { id: 'O-1', poNumber: 'PO-1', customer: 'Acme', dueDate: '2026-10-01', status: 'Pending' } },
    ]);
    const prisma = {
      productAsset: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'PROD-1',
          sku: 'FAB-001',
          name: 'Black wool twill',
          updatedAt: BigInt(300),
          fabricProfile: { millQuality: 'MQ-001' },
        }),
      },
      orderLine: { findMany: orderLineFindMany },
    };

    const res = await request(makeApp(prisma)).get('/api/v1/products/assets/PROD-1');

    expect(res.status).toBe(200);
    expect(orderLineFindMany).toHaveBeenCalledTimes(1);
    expect(orderLineFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ materialCode: 'FAB-001' }) }),
    );
    expect(res.body.relatedOrderLines).toHaveLength(1);
    expect(res.body.relatedOrderLines[0].order.poNumber).toBe('PO-1');
  });

  it('GET /assets/:id sku 主通道无命中 → 回退 millQuality 兜底通道', async () => {
    const orderLineFindMany = vi.fn()
      .mockResolvedValueOnce([]) // sku 通道空
      .mockResolvedValueOnce([
        { id: 'OL-9', millQuality: 'MQ-001', lineNumber: 2, quantity: '50', order: { id: 'O-2', poNumber: 'PO-2', customer: 'Beta', dueDate: '2026-11-01', status: 'Pending' } },
      ]);
    const prisma = {
      productAsset: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'PROD-1',
          sku: 'FAB-001',
          name: 'Black wool twill',
          updatedAt: BigInt(300),
          fabricProfile: { millQuality: 'MQ-001' },
        }),
      },
      orderLine: { findMany: orderLineFindMany },
    };

    const res = await request(makeApp(prisma)).get('/api/v1/products/assets/PROD-1');

    expect(res.status).toBe(200);
    expect(orderLineFindMany).toHaveBeenCalledTimes(2);
    expect(orderLineFindMany.mock.calls[1][0].where).toEqual({ millQuality: 'MQ-001', order: { deletedAt: null } });
    expect(res.body.relatedOrderLines).toHaveLength(1);
    expect(res.body.relatedOrderLines[0].order.poNumber).toBe('PO-2');
  });

  it('PATCH /assets/:id updates product fields', async () => {
    const existing = {
      id: 'PROD-1',
      sku: 'FAB-001',
      name: 'Black wool twill',
      mainCategory: 'Fabric',
      updatedAt: BigInt(300),
      fabricProfile: { productAssetId: 'PROD-1', millQuality: 'MQ-001' },
      fabricCustomerCodes: [],
      fabricCertifications: [],
      fabricPrices: [],
      compositionLines: [],
    };
    const updated = { ...existing, name: 'Updated twill', updatedAt: BigInt(301) };

    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn(prisma)),
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      productAsset: {
        findFirst: vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(updated),
        update: vi.fn().mockResolvedValue(updated),
      },
      fabricProfile: {
        update: vi.fn().mockResolvedValue({}),
      },
      garmentProfile: { update: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) },
      trimmingProfile: { update: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) },
      fabricCustomerCode: { deleteMany: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({}) },
      fabricPriceHistory: { deleteMany: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({}) },
      fabricCertification: { deleteMany: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({}) },
      fabricCompositionLine: { deleteMany: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) },
      materialCompositionTerm: { upsert: vi.fn().mockResolvedValue({}) },
    };

    const res = await request(makeApp(prisma))
      .patch('/api/v1/products/assets/PROD-1')
      .send({ name: 'Updated twill' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prisma.productAsset.update).toHaveBeenCalled();
  });

  it('DELETE /assets/:id soft-deletes a product', async () => {
    const existing = { id: 'PROD-1', sku: 'FAB-001', fabricProfile: null };
    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn(prisma)),
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      productAsset: {
        findFirst: vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce({ ...existing, fabricProfile: null }),
        update: vi.fn().mockResolvedValue({ ...existing, deletedAt: BigInt(999) }),
      },
      fabricProfile: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      fabricCustomerCode: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      fabricPriceHistory: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      fabricCertification: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      fabricCompositionLine: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      garmentProfile: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      trimmingProfile: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };

    const res = await request(makeApp(prisma)).delete('/api/v1/products/assets/PROD-1');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe('PROD-1');
    expect(prisma.productAsset.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'PROD-1' },
        data: expect.objectContaining({ deletedAt: expect.any(BigInt) }),
      }),
    );
  });
});
