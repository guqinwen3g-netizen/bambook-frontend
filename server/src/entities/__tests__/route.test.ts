import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createEntitiesRouter } from '../route';

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/entities', createEntitiesRouter({
    prisma,
    requireAuth: false,
    apiKeys: new Set<string>(),
  }));
  return app;
}

describe('entities route', () => {
  it('exposes versioned entity registry entries backed by existing source-of-truth models', async () => {
    const res = await request(makeApp({})).get('/api/v1/entities/registry');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.registryVersion).toBe('2026-05-09');
    expect(res.body.entityTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'relation.organization',
          sourceModel: 'Relation',
          schemaVersion: 1,
          canCreateInSourceModule: true,
        }),
        expect.objectContaining({
          type: 'product.fabricProfile',
          sourceModel: 'FabricProfile',
          schemaVersion: 1,
        }),
        expect.objectContaining({
          type: 'product.customerCode',
          sourceModel: 'FabricCustomerCode',
          schemaVersion: 1,
        }),
      ]),
    );
  });

  it('searches Relation as the organization source of truth and returns fillPatch data', async () => {
    const prisma = {
      relation: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'REL-PEERLESS',
            name: 'Peerless Clothing',
            category: 'Customer',
            isOrganization: true,
            officialAddress: '8888 PIE IX Boulevard',
            billingAddress: 'Billing address',
            shippingAddress: 'Shipping address',
            primaryContactName: 'Jane Buyer',
            primaryContactPhone: '+1 514 000 0000',
            paymentTerms: 'AS PER AGREEMENT',
            currency: 'USD',
            deletedAt: null,
          },
        ]),
      },
    };

    const res = await request(makeApp(prisma))
      .post('/api/v1/entities/search')
      .send({
        query: 'peerless',
        fieldKey: 'customer',
        entityTypes: ['relation.organization'],
        include: { fillPatch: true },
      });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toEqual(
      expect.objectContaining({
        entityType: 'relation.organization',
        id: 'REL-PEERLESS',
        title: 'Peerless Clothing',
        sourceModel: 'Relation',
        fillPatch: expect.objectContaining({
          customer: 'Peerless Clothing',
          customerRelationId: 'REL-PEERLESS',
          customerAddress: '8888 PIE IX Boulevard',
          contactPerson: 'Jane Buyer',
          contactTelephone: '+1 514 000 0000',
          paymentTerms: 'AS PER AGREEMENT',
          salesCurrency: 'USD',
        }),
      }),
    );
  });

  it('returns paginated entity search metadata and the requested result window', async () => {
    const prisma = {
      relation: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'REL-1',
            name: 'Peerless Clothing A',
            category: 'Customer',
            isOrganization: true,
            deletedAt: null,
          },
          {
            id: 'REL-2',
            name: 'Peerless Clothing B',
            category: 'Customer',
            isOrganization: true,
            deletedAt: null,
          },
        ]),
        count: vi.fn().mockResolvedValue(3),
      },
    };

    const res = await request(makeApp(prisma))
      .post('/api/v1/entities/search')
      .send({
        query: 'peerless',
        entityTypes: ['relation.organization'],
        limit: 1,
        offset: 1,
        include: { fillPatch: false },
      });

    expect(res.status).toBe(200);
    expect(prisma.relation.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      total: 3,
      limit: 1,
      offset: 1,
      hasMore: true,
    }));
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toEqual(expect.objectContaining({
      id: 'REL-2',
      title: 'Peerless Clothing B',
    }));
  });

  it('searches fabric customer codes with customer context and hydrates exact entity refs', async () => {
    const fabricCode = {
      id: 'FCC-1',
      productAssetId: 'PROD-1',
      customerOrganizationId: 'REL-PEERLESS',
      customerNameSnapshot: 'Peerless Clothing',
      clientCode: 'ZROH-123',
      note: null,
      deletedAt: null,
      productAsset: {
        id: 'PROD-1',
        sku: 'FAB-001',
        name: 'Navy wool twill',
        fabricProfile: {
          id: 'FP-1',
          articleNo: 'ART-001',
          millQuality: 'MQ-001',
          millColorCode: 'NAVY',
          widthValue: 150,
          widthUnit: 'CM',
          weightValue: 180,
          weightUnit: 'GSM',
        },
        compositionLines: [],
      },
    };
    const prisma = {
      fabricCustomerCode: {
        findMany: vi.fn().mockResolvedValue([fabricCode]),
        findFirst: vi.fn().mockResolvedValue(fabricCode),
      },
    };

    const searchRes = await request(makeApp(prisma))
      .post('/api/v1/entities/search')
      .send({
        query: 'ZROH-123',
        fieldKey: 'clientCode',
        entityTypes: ['product.customerCode'],
        ownerContext: { customerRelationId: 'REL-PEERLESS' },
        include: { fillPatch: true },
      });

    expect(searchRes.status).toBe(200);
    expect(searchRes.body.items[0]).toEqual(
      expect.objectContaining({
        entityType: 'product.customerCode',
        id: 'FCC-1',
        title: 'ZROH-123',
        fillPatch: expect.objectContaining({
          clientCode: 'ZROH-123',
          product: 'Navy wool twill',
          fabricCode: 'ART-001',
          productColorCode: 'MQ-001',
          width: '150 CM',
          gsm: '180 GSM',
        }),
      }),
    );

    const hydrateRes = await request(makeApp(prisma))
      .post('/api/v1/entities/hydrate')
      .send({
        refs: [{ entityType: 'product.customerCode', id: 'FCC-1' }],
        include: { fillPatch: true },
      });

    expect(hydrateRes.status).toBe(200);
    expect(hydrateRes.body.items[0].id).toBe('FCC-1');
    expect(hydrateRes.body.items[0].fillPatch.clientCode).toBe('ZROH-123');
  });

  // ── GET /related-summary：跨模块导航计数聚合 ──

  const RELATED_SUMMARY_MODELS = [
    'order', 'developmentCase', 'quotation', 'purchaseOrder', 'invoice',
    'paymentVoucher', 'vatInvoice', 'shipment', 'customsDeclaration', 'taxRefund',
    'letterOfCredit', 'fxSettlement', 'outwardRemittance', 'opportunity', 'outsourcingOrder',
  ] as const;

  function makeSummaryPrisma(counts: Partial<Record<typeof RELATED_SUMMARY_MODELS[number], number>> = {}) {
    const prisma: Record<string, { count: ReturnType<typeof vi.fn> }> = {};
    for (const model of RELATED_SUMMARY_MODELS) {
      prisma[model] = { count: vi.fn().mockResolvedValue(counts[model] ?? 0) };
    }
    return prisma;
  }

  it('related-summary: rejects missing type/id and unsupported entity types', async () => {
    const missingParam = await request(makeApp(makeSummaryPrisma()))
      .get('/api/v1/entities/related-summary');
    expect(missingParam.status).toBe(400);
    expect(missingParam.body.error).toBe('VALIDATION_FAILED');

    const badType = await request(makeApp(makeSummaryPrisma()))
      .get('/api/v1/entities/related-summary?type=order&id=ORD-1');
    expect(badType.status).toBe(400);
    expect(badType.body.error).toBe('VALIDATION_FAILED');
  });

  it('related-summary product: 404 for missing product, aggregates by productAssetId + codes', async () => {
    const prisma: any = {
      productAsset: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    const res404 = await request(makeApp(prisma))
      .get('/api/v1/entities/related-summary?type=product&id=PDT-MISS');
    expect(res404.status).toBe(404);
    expect(res404.body.error).toBe('NOT_FOUND');

    prisma.productAsset.findUnique.mockResolvedValue({
      id: 'PDT-A', sku: 'SKU-A', fabricProfile: { articleNo: 'ART-A' },
      fabricCustomerCodes: [{ clientCode: 'CL-A' }, { clientCode: 'CL-B' }],
    });
    prisma.order = { count: vi.fn().mockResolvedValue(3) };
    prisma.quotation = { count: vi.fn().mockResolvedValue(2) };
    prisma.purchaseOrder = { count: vi.fn().mockResolvedValue(1) };
    prisma.developmentCase = { count: vi.fn().mockResolvedValue(4) };
    prisma.inventoryItem = { count: vi.fn().mockResolvedValue(5) };
    prisma.bOM = { count: vi.fn().mockResolvedValue(0) };
    prisma.shipmentLine = { findMany: vi.fn().mockResolvedValue([{ shipmentId: 'SHIP-1' }, { shipmentId: 'SHIP-2' }]) };
    prisma.shipment = { count: vi.fn().mockResolvedValue(2) };

    const res = await request(makeApp(prisma))
      .get('/api/v1/entities/related-summary?type=product&id=PDT-A');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.summary.orders).toBe(3);
    expect(res.body.summary.developments).toBe(4);
    expect(res.body.summary.inventory).toBe(5);
    expect(res.body.summary.boms).toBe(0);

    const codes = ['SKU-A', 'ART-A', 'CL-A', 'CL-B'];
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: { deletedAt: null, lines: { some: { OR: [{ itemNo: { in: codes } }, { materialCode: { in: codes } }] } } },
    });
    expect(prisma.developmentCase.count).toHaveBeenCalledWith({
      where: { deletedAt: null, productAssetId: 'PDT-A' },
    });
    expect(prisma.inventoryItem.count).toHaveBeenCalledWith({
      where: { deletedAt: null, productAssetId: 'PDT-A' },
    });
  });

  it('related-summary: counts every business domain with soft-delete and relation filters', async () => {
    const prisma = makeSummaryPrisma({ order: 6, quotation: 2, outsourcingOrder: 3 });

    const res = await request(makeApp(prisma))
      .get('/api/v1/entities/related-summary?type=relation.organization&id=REL-ATLAS');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBe('REL-ATLAS');
    expect(res.body.summary).toEqual({
      orders: 6, developments: 0, quotations: 2, purchaseOrders: 0, invoices: 0,
      paymentVouchers: 0, vatInvoices: 0, shipments: 0, customsDeclarations: 0,
      taxRefunds: 0, lettersOfCredit: 0, fxSettlements: 0, outwardRemittances: 0,
      opportunities: 0, outsourcingOrders: 3, inventory: 0, boms: 0,
    });

    // 计数走业务表真实关联字段（订单 = 四角色并集；采购/外协 = 供应商侧；其余 = 客户/relation 侧）
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [
          { customerRelationId: 'REL-ATLAS' }, { consigneeRelationId: 'REL-ATLAS' },
          { billToRelationId: 'REL-ATLAS' }, { millRelationId: 'REL-ATLAS' },
        ],
      },
    });
    expect(prisma.quotation.count).toHaveBeenCalledWith({
      where: { deletedAt: null, customerRelationId: 'REL-ATLAS' },
    });
    expect(prisma.purchaseOrder.count).toHaveBeenCalledWith({
      where: { deletedAt: null, supplierRelationId: 'REL-ATLAS' },
    });
    expect(prisma.outsourcingOrder.count).toHaveBeenCalledWith({
      where: { deletedAt: null, supplierId: 'REL-ATLAS' },
    });
    // 15 个业务域全部被查询（无遗漏入口）
    for (const model of RELATED_SUMMARY_MODELS) {
      expect(prisma[model].count).toHaveBeenCalledTimes(1);
    }
  });
});
