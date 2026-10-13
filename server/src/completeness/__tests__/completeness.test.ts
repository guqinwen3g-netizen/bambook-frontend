/**
 * 资料完备度规则引擎 v1 — 测试（service + route 契约）
 *
 * mock 边界：全量 mock PrismaClient（与 briefingService.test.ts 同风格），不连真实库：
 *   - summary 聚合正确（七规则计数 / bySeverity / sampleIds ≤5 截断 / PO 归并计数）
 *   - entity=order 行级缺口（materialCode 未建档 hint + fix 直达建档深链）
 *   - entity 评分边界（product 全空=0 分 / 全齐=100 分 / garment / trim / relation）
 *   - batch（take=200 + updatedAt 倒序）
 *   - 空库不报错（summary 全 0 / batch 空数组 / entity null）
 *   - route 契约（ok:true 包裹 / 400 非法 type / 404 实体不存在 / 401 auth guard）
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  getCompletenessSummary,
  getEntityCompleteness,
  getCompletenessBatch,
} from '../service';
import { createCompletenessRouter } from '../route';

function makePrisma(overrides: Record<string, any> = {}) {
  const defaults: Record<string, any> = {
    productAsset: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    orderLine: { findMany: vi.fn().mockResolvedValue([]) },
    developmentCase: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    order: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    relation: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    creditLimit: { findMany: vi.fn().mockResolvedValue([]) },
    purchaseLine: { findMany: vi.fn().mockResolvedValue([]) },
    shipment: { findMany: vi.fn().mockResolvedValue([]) },
    tradeDocument: { findMany: vi.fn().mockResolvedValue([]) },
    trimmingProfile: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const merged: any = defaults;
  for (const [model, fns] of Object.entries(overrides)) {
    merged[model] = { ...defaults[model], ...fns };
  }
  return merged;
}

// ────────────────────────────────────────────────────────────────
// summary 聚合
// ────────────────────────────────────────────────────────────────

describe('getCompletenessSummary', () => {
  it('七规则聚合正确：P0/P1/P2 计数、PO 归并计数、sampleIds 截断 ≤5', async () => {
    // 产品档案：FB-001/FB-002 已建档，TM-001 为辅料 sku
    const productAssetFindMany = vi.fn().mockResolvedValue([
      { id: 'PA1', sku: 'FB-001' },
      { id: 'PA2', sku: 'FB-002' },
      { id: 'PT1', sku: 'TM-001' },
    ]);
    // 订单行：7 行未命中（>5 触发 sampleIds 截断）+ 2 行已命中
    const orderLineFindMany = vi.fn().mockResolvedValue([
      ...Array.from({ length: 7 }, (_, i) => ({ id: `UL${i + 1}`, materialCode: `ZZ-${i + 1}` })),
      { id: 'L8', materialCode: 'FB-001' },
      { id: 'L9', materialCode: 'FB-002' },
    ]);
    const prisma = makePrisma({
      productAsset: { findMany: productAssetFindMany },
      orderLine: { findMany: orderLineFindMany },
      developmentCase: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'DC1', productAssetId: 'PA1' },
          { id: 'DC2', productAssetId: null },
        ]),
      },
      order: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'O1', customerRelationId: 'RC1' },
          { id: 'O2', customerRelationId: null },
        ]),
      },
      relation: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'RC1', category: 'Customer' },
          { id: 'RC2', category: 'Customer' },
        ]),
      },
      creditLimit: { findMany: vi.fn().mockResolvedValue([{ relationId: 'RC1' }]) },
      purchaseLine: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'PL1', materialCode: 'ZZ-A', purchaseOrderId: 'PO1' },
          { id: 'PL2', materialCode: 'ZZ-B', purchaseOrderId: 'PO1' },
          { id: 'PL3', materialCode: 'ZZ-C', purchaseOrderId: 'PO2' },
          { id: 'PL4', materialCode: 'FB-001', purchaseOrderId: 'PO1' },
        ]),
      },
      shipment: { findMany: vi.fn().mockResolvedValue([{ id: 'S1' }, { id: 'S2' }]) },
      tradeDocument: { findMany: vi.fn().mockResolvedValue([{ shipmentId: 'S1' }]) },
      trimmingProfile: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'TP1', productAssetId: 'PT1' }, // TM-001 无采购引用 → 命中
          { id: 'TP2', productAssetId: 'PA1' }, // FB-001 有采购引用 → 不命中
        ]),
      },
    });

    const summary = await getCompletenessSummary(prisma);

    expect(summary.totalGaps).toBe(14);
    expect(summary.bySeverity).toEqual({ P0: 8, P1: 4, P2: 2 });
    expect(summary.groups).toHaveLength(7);

    // 规则①：行级计数 7，sampleIds 截断到 5
    const rule1 = summary.groups.find(g => g.ruleId === 'order_line_material_unlinked')!;
    expect(rule1.count).toBe(7);
    expect(rule1.sampleIds).toHaveLength(5);
    expect(rule1.sampleIds).toEqual(['UL1', 'UL2', 'UL3', 'UL4', 'UL5']);
    expect(rule1.severity).toBe('P0');
    expect(rule1.entityType).toBe('order');

    // 规则⑤：两行未命中归并到同一 PO → 计数 2
    const rule5 = summary.groups.find(g => g.ruleId === 'po_material_unlinked')!;
    expect(rule5.count).toBe(2);
    expect(rule5.sampleIds.sort()).toEqual(['PO1', 'PO2']);
    expect(rule5.entityType).toBe('purchase-order');

    // 规则⑦：辅料无采购引用，样本为产品档案 id
    const rule7 = summary.groups.find(g => g.ruleId === 'trim_no_reference')!;
    expect(rule7.count).toBe(1);
    expect(rule7.sampleIds).toEqual(['PT1']);
    expect(rule7.entityType).toBe('product');
  });

  it('空库不报错：全部规则 0 命中，groups 结构完整', async () => {
    const summary = await getCompletenessSummary(makePrisma());
    expect(summary.totalGaps).toBe(0);
    expect(summary.bySeverity).toEqual({ P0: 0, P1: 0, P2: 0 });
    expect(summary.groups).toHaveLength(7);
    for (const group of summary.groups) {
      expect(group.count).toBe(0);
      expect(group.sampleIds).toEqual([]);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// entity = order（行级缺口）
// ────────────────────────────────────────────────────────────────

describe('getEntityCompleteness(order)', () => {
  it('返回行级缺口：未命中面料行逐行给 hint + fix 直达建档表单 /products?create=1&sku=', async () => {
    const prisma = makePrisma({
      productAsset: {
        findMany: vi.fn().mockResolvedValue([{ id: 'PA1', sku: 'FB-001' }]),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'SIM-ORD-001',
          deletedAt: null,
          customerRelationId: null,
          lines: [
            { id: 'L1', materialCode: 'FB-UNKNOWN' },
            { id: 'L2', materialCode: 'FB-001' },
          ],
        }),
      },
    });

    const result = await getEntityCompleteness(prisma, 'order', 'SIM-ORD-001');
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe('order');
    expect(result!.id).toBe('SIM-ORD-001');
    expect(result!.score).toBeUndefined(); // score 仅 product/relation 返回
    expect(result!.gaps).toHaveLength(2);

    expect(result!.gaps[0]).toEqual({
      ruleId: 'order_line_material_unlinked',
      label: '订单行面料未建档',
      severity: 'P0',
      hint: '订单行面料「FB-UNKNOWN」未建档',
      fix: { type: 'navigate', target: '/products?create=1&sku=FB-UNKNOWN' },
    });
    expect(result!.gaps[1].ruleId).toBe('order_no_customer_relation');
    expect(result!.gaps[1].severity).toBe('P1');
    expect(result!.gaps[1].fix.target).toBe('/orders?id=SIM-ORD-001');
  });

  it('客户关系齐全时无缺口；软删/不存在返回 null', async () => {
    const prisma = makePrisma({
      productAsset: { findMany: vi.fn().mockResolvedValue([{ id: 'PA1', sku: 'FB-001' }]) },
      order: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({
            id: 'O1', deletedAt: null, customerRelationId: 'RC1',
            lines: [{ id: 'L1', materialCode: 'FB-001' }],
          })
          .mockResolvedValueOnce({ id: 'O2', deletedAt: 123n, customerRelationId: 'RC1', lines: [] })
          .mockResolvedValueOnce(null),
      },
    });
    expect(await getEntityCompleteness(prisma, 'order', 'O1')).toEqual({
      entityType: 'order', id: 'O1', gaps: [],
    });
    expect(await getEntityCompleteness(prisma, 'order', 'O2')).toBeNull();
    expect(await getEntityCompleteness(prisma, 'order', 'O3')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// entity = development-case
// ────────────────────────────────────────────────────────────────

describe('getEntityCompleteness(development-case)', () => {
  it('productAssetId 为空 → P0 缺口，fix 直达开发案详情并进入挂档案流程', async () => {
    const prisma = makePrisma({
      developmentCase: {
        findUnique: vi.fn().mockResolvedValue({ id: 'DC1', productAssetId: null, deletedAt: null }),
      },
    });
    const result = await getEntityCompleteness(prisma, 'development-case', 'DC1');
    expect(result!.gaps).toHaveLength(1);
    expect(result!.gaps[0]).toMatchObject({
      ruleId: 'dev_case_unlinked_product',
      severity: 'P0',
      fix: { type: 'navigate', target: '/development?focus=DC1&action=link-product' },
    });
  });
});

// ────────────────────────────────────────────────────────────────
// entity = product（评分边界）
// ────────────────────────────────────────────────────────────────

describe('getEntityCompleteness(product)', () => {
  const baseAsset = {
    id: 'PF1',
    deletedAt: null,
    garmentProfile: null,
    trimmingProfile: null,
    compositionLines: [],
    fabricPrices: [],
  };

  it('面料档案：三项全空 = 0 分（缺失维度中文齐全），三项全有 = 100 分', async () => {
    const emptyAsset = {
      ...baseAsset,
      sku: 'FB-001',
      fabricProfile: { deletedAt: null, moqValue: null, factoryMoqValue: null, sampleMoqValue: null },
    };
    const fullAsset = {
      ...baseAsset,
      id: 'PF2',
      sku: 'FB-002',
      fabricProfile: { deletedAt: null, moqValue: 100, factoryMoqValue: null, sampleMoqValue: null },
      compositionLines: [{ deletedAt: null }],
      fabricPrices: [{ deletedAt: null }],
    };
    const prisma = makePrisma({
      productAsset: { findUnique: vi.fn().mockResolvedValueOnce(emptyAsset).mockResolvedValueOnce(fullAsset) },
    });

    const empty = await getEntityCompleteness(prisma, 'product', 'PF1');
    expect(empty!.score).toBe(0);
    expect(empty!.gaps.map(g => g.ruleId).sort()).toEqual([
      'product_missing_composition',
      'product_missing_moq',
      'product_missing_price_history',
    ]);

    const full = await getEntityCompleteness(prisma, 'product', 'PF2');
    expect(full!.score).toBe(100);
    expect(full!.gaps).toEqual([]);
  });

  it('成衣档案：尺码有/面辅料说明无 = 50 分', async () => {
    const prisma = makePrisma({
      productAsset: {
        findUnique: vi.fn().mockResolvedValue({
          ...baseAsset,
          sku: 'GM-001',
          fabricProfile: null,
          garmentProfile: {
            deletedAt: null,
            sizeSpec: 'S/M/L', sizeRange: null, availableSizes: null, baseSize: null, measurementPoints: null,
            mainFabric: null, contrastFabric: null, liningFabric: null, ribFabric: null, pocketingFabric: null,
            button: null, zipper: null, snapsEyelets: null, thread: null, labelTrims: null, interlining: null,
            liningStructure: null, constructionNote: null, materialUsage: null,
          },
        }),
      },
    });
    const result = await getEntityCompleteness(prisma, 'product', 'PF1');
    expect(result!.score).toBe(50);
    expect(result!.gaps).toHaveLength(1);
    expect(result!.gaps[0].ruleId).toBe('product_missing_material_notes');
  });

  it('辅料档案：无采购引用 = 0 分 + trim_no_reference 缺口；有引用 = 100 分', async () => {
    const unreferencedPrisma = makePrisma({
      productAsset: {
        findUnique: vi.fn().mockResolvedValue({
          ...baseAsset, sku: 'TM-001', fabricProfile: null, trimmingProfile: { deletedAt: null },
        }),
      },
      purchaseLine: { findMany: vi.fn().mockResolvedValue([{ materialCode: 'OTHER' }]) },
    });
    const unreferenced = await getEntityCompleteness(unreferencedPrisma, 'product', 'PF1');
    expect(unreferenced!.score).toBe(0);
    expect(unreferenced!.gaps.map(g => g.ruleId)).toEqual(['trim_no_reference']);
    expect(unreferenced!.gaps[0].severity).toBe('P2');

    const referencedPrisma = makePrisma({
      productAsset: {
        findUnique: vi.fn().mockResolvedValue({
          ...baseAsset, sku: 'TM-001', fabricProfile: null, trimmingProfile: { deletedAt: null },
        }),
      },
      purchaseLine: { findMany: vi.fn().mockResolvedValue([{ materialCode: 'TM-001' }]) },
    });
    const referenced = await getEntityCompleteness(referencedPrisma, 'product', 'PF1');
    expect(referenced!.score).toBe(100);
    expect(referenced!.gaps).toEqual([]);
  });

  it('裸资产（无任何 Profile）不虚报缺口 = 100 分；软删档案视同未建档', async () => {
    const prisma = makePrisma({
      productAsset: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ ...baseAsset, sku: 'XX-1', fabricProfile: null })
          .mockResolvedValueOnce({
            ...baseAsset, sku: 'XX-2',
            fabricProfile: { deletedAt: 123n, moqValue: 1, factoryMoqValue: null, sampleMoqValue: null },
          }),
      },
    });
    const bare = await getEntityCompleteness(prisma, 'product', 'PF1');
    expect(bare!.score).toBe(100);
    expect(bare!.gaps).toEqual([]);

    const deletedProfile = await getEntityCompleteness(prisma, 'product', 'PF2');
    expect(deletedProfile!.score).toBe(100);
    expect(deletedProfile!.gaps).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// entity = relation（评分边界）
// ────────────────────────────────────────────────────────────────

describe('getEntityCompleteness(relation)', () => {
  it('客户：联系人+跟进有、信用额度无 → 67 分 + P1 customer_no_credit_limit', async () => {
    const prisma = makePrisma({
      relation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'RC1',
          category: 'Customer',
          contacts: [{ deletedAt: null }],
          creditLimits: [],
          followUpRecords: [{ deletedAt: null }],
        }),
      },
    });
    const result = await getEntityCompleteness(prisma, 'relation', 'RC1');
    expect(result!.score).toBe(67); // round(2/3*100)
    expect(result!.gaps).toHaveLength(1);
    expect(result!.gaps[0]).toMatchObject({
      ruleId: 'customer_no_credit_limit',
      severity: 'P1',
      fix: { type: 'navigate', target: '/relations?id=RC1' },
    });
  });

  it('非客户：三项全空 → 0 分，信用额度缺口降级为 P2 维度缺口', async () => {
    const prisma = makePrisma({
      relation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'RS1',
          category: 'Supplier',
          contacts: [],
          creditLimits: [],
          followUpRecords: [],
        }),
      },
    });
    const result = await getEntityCompleteness(prisma, 'relation', 'RS1');
    expect(result!.score).toBe(0);
    expect(result!.gaps).toHaveLength(3);
    expect(result!.gaps.every(g => g.severity === 'P2')).toBe(true);
    expect(result!.gaps.map(g => g.ruleId).sort()).toEqual([
      'relation_missing_contacts',
      'relation_missing_credit_limit',
      'relation_missing_follow_up',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// batch（列表页徽标）
// ────────────────────────────────────────────────────────────────

describe('getCompletenessBatch', () => {
  it('product：分页 ≤200 按 updatedAt 倒序，items 带 score/missing', async () => {
    const productAssetFindMany = vi.fn().mockResolvedValue([
      {
        id: 'PF_EMPTY', sku: 'FB-001', deletedAt: null,
        fabricProfile: { deletedAt: null, moqValue: null, factoryMoqValue: null, sampleMoqValue: null },
        garmentProfile: null, trimmingProfile: null, compositionLines: [], fabricPrices: [],
      },
      {
        id: 'PF_FULL', sku: 'FB-002', deletedAt: null,
        fabricProfile: { deletedAt: null, moqValue: 10, factoryMoqValue: null, sampleMoqValue: null },
        garmentProfile: null, trimmingProfile: null,
        compositionLines: [{ deletedAt: null }], fabricPrices: [{ deletedAt: null }],
      },
    ]);
    const prisma = makePrisma({ productAsset: { findMany: productAssetFindMany } });

    const { items } = await getCompletenessBatch(prisma, 'product');
    expect(items).toHaveLength(2);
    const byId = new Map(items.map(i => [i.id, i]));
    expect(byId.get('PF_EMPTY')!.score).toBe(0);
    expect(byId.get('PF_EMPTY')!.missing).toEqual(['成分行', '价格历史', 'MOQ']);
    expect(byId.get('PF_FULL')!.score).toBe(100);
    expect(byId.get('PF_FULL')!.missing).toEqual([]);
    // 分页契约：≤200 按 updatedAt 倒序（findMany 首调来自共享索引加载，batch 查询为最后一次）
    const args = productAssetFindMany.mock.calls.at(-1)![0];
    expect(args.take).toBe(200);
    expect(args.orderBy).toEqual({ updatedAt: 'desc' });
  });

  it('relation：items 带评分与缺失维度', async () => {
    const relationFindMany = vi.fn().mockResolvedValue([
      {
        id: 'RC1', category: 'Customer',
        contacts: [{ deletedAt: null }], creditLimits: [{ deletedAt: null }], followUpRecords: [],
      },
    ]);
    const prisma = makePrisma({ relation: { findMany: relationFindMany } });

    const { items } = await getCompletenessBatch(prisma, 'relation');
    expect(items).toEqual([{ id: 'RC1', score: 67, missing: ['跟进记录'] }]);
    const args = relationFindMany.mock.calls[0][0];
    expect(args.take).toBe(200);
    // Relation 模型无 updatedAt，近因排序用 lastInteraction（schema 口径）
    expect(args.orderBy).toEqual({ lastInteraction: 'desc' });
  });

  it('空库不报错：product / relation 均返回空数组', async () => {
    const prisma = makePrisma();
    expect((await getCompletenessBatch(prisma, 'product')).items).toEqual([]);
    expect((await getCompletenessBatch(prisma, 'relation')).items).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// route 契约（supertest）
// ────────────────────────────────────────────────────────────────

function makeApp(prisma: any, opts: { requireAuth?: boolean; apiKeys?: Set<string> } = {}) {
  const app = express();
  app.use('/', createCompletenessRouter({
    prisma,
    requireAuth: opts.requireAuth ?? false,
    apiKeys: opts.apiKeys ?? new Set(),
  }));
  return app;
}

describe('route 契约', () => {
  it('GET /summary → { ok:true, data:{ totalGaps, bySeverity, groups } }', async () => {
    const prisma = makePrisma({
      orderLine: {
        findMany: vi.fn().mockResolvedValue([{ id: 'L1', materialCode: 'ZZ-1' }]),
      },
      productAsset: { findMany: vi.fn().mockResolvedValue([{ id: 'PA1', sku: 'FB-001' }]) },
    });
    const res = await request(makeApp(prisma)).get('/summary');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.totalGaps).toBe(1);
    expect(res.body.data.bySeverity.P0).toBe(1);
    expect(res.body.data.groups[0].ruleId).toBe('order_line_material_unlinked');
  });

  it('非法 type → 400；缺 id → 400；实体不存在 → 404', async () => {
    const prisma = makePrisma();
    const app = makeApp(prisma);

    const badType = await request(app).get('/entity?type=poop&id=x');
    expect(badType.status).toBe(400);
    expect(badType.body.error.code).toBe('INVALID_TYPE');

    const missingId = await request(app).get('/entity?type=order');
    expect(missingId.status).toBe(400);
    expect(missingId.body.error.code).toBe('MISSING_ID');

    const notFound = await request(app).get('/entity?type=order&id=NOPE');
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe('ENTITY_NOT_FOUND');

    const badBatch = await request(app).get('/batch?type=order');
    expect(badBatch.status).toBe(400);
    expect(badBatch.body.error.code).toBe('INVALID_TYPE');
  });

  it('GET /entity 返回行级缺口契约；GET /batch 返回 items 契约', async () => {
    const prisma = makePrisma({
      productAsset: {
        // batch 与共享索引共用 findMany；行形状对齐真实 include（带 profile 对象）
        findMany: vi.fn().mockResolvedValue([{
          id: 'PF1', sku: 'TM-001', deletedAt: null,
          fabricProfile: null, garmentProfile: null, trimmingProfile: { deletedAt: null },
          compositionLines: [], fabricPrices: [],
        }]),
        findUnique: vi.fn().mockResolvedValue({
          id: 'PF1', sku: 'TM-001', deletedAt: null,
          fabricProfile: null, garmentProfile: null, trimmingProfile: { deletedAt: null },
          compositionLines: [], fabricPrices: [],
        }),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'SIM-ORD-001', deletedAt: null, customerRelationId: null,
          lines: [{ id: 'L1', materialCode: 'FB-UNKNOWN' }],
        }),
      },
    });
    const app = makeApp(prisma);

    const entity = await request(app).get('/entity?type=order&id=SIM-ORD-001');
    expect(entity.status).toBe(200);
    expect(entity.body).toEqual({
      ok: true,
      data: {
        entityType: 'order',
        id: 'SIM-ORD-001',
        gaps: [
          {
            ruleId: 'order_line_material_unlinked',
            label: '订单行面料未建档',
            severity: 'P0',
            hint: '订单行面料「FB-UNKNOWN」未建档',
            fix: { type: 'navigate', target: '/products?create=1&sku=FB-UNKNOWN' },
          },
          {
            ruleId: 'order_no_customer_relation',
            label: '订单未关联客户',
            severity: 'P1',
            hint: '订单未关联客户档案，信用控制与四单对账无法落到客户',
            fix: { type: 'navigate', target: '/orders?id=SIM-ORD-001' },
          },
        ],
      },
    });

    const batch = await request(app).get('/batch?type=product');
    expect(batch.status).toBe(200);
    expect(batch.body.ok).toBe(true);
    expect(batch.body.data.items).toEqual([{ id: 'PF1', score: 0, missing: ['采购引用'] }]);
  });

  it('auth guard：requireAuth=true 且无凭证 → 401（对齐既有 module guard）', async () => {
    const prisma = makePrisma();
    const app = makeApp(prisma, { requireAuth: true });
    const res = await request(app).get('/summary');
    expect(res.status).toBe(401);
  });
});
