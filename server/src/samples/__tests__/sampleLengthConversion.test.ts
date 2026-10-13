/**
 * sampleLengthConversion.test.ts — D7-① 米样转化通道（转大货 / 转售）
 *
 * 拍板口径：三类动作（裁剪给客户 ✅D6 已有 / 转大货 / 转售），记录**来源样品·转化数量·损耗·
 * 余量退回·目标对象**，并生成**双侧流水**（样品侧减、大货侧增或应收侧增）。
 *
 * 本组钉住的不变量：
 *   1. **转大货双侧同事务**：大货侧必须经 `createStockMovement` 且传 `opts.tx`（不得绕过直改 quantity）
 *   2. **单位铁律**：样品 lengthUnit ≠ 库存项 unit → 409（M 与 YD 不可互算）
 *   3. **长度不可为负**：不足 → 409，且**不写任何流水**
 *   4. **损耗单独成笔**、不计入大货数量
 *   5. **转售**：样品侧减 + 应收侧走既有 BillingItem(sourceType='Sample')；
 *      BillingItem 失败时整体回滚（不留下单侧扣减）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const stockMovementCalls: any[] = [];
const billingItemCalls: any[] = [];

vi.mock('../../inventory/inventoryService', () => ({
  createInventoryService: () => ({
    createStockMovement: vi.fn(async (input: any, actor: string, opts: any) => {
      stockMovementCalls.push({ input, actor, opts });
      return { id: 'SM__1', ...input };
    }),
  }),
}));
vi.mock('../../finance/billingItemService', () => ({
  // 事务内版本：成功返回 billingItem，失败 **throw**（与真实实现同语义）
  createBillingItemInTx: vi.fn(async (tx: any, params: any) => {
    billingItemCalls.push({ tx, params });
    if (params.input.amount === 999) {
      throw Object.assign(new Error('计费项创建失败'), { __billingFail: true, code: 'BOOM', httpStatus: 500 });
    }
    return { id: 'BI__1', itemNo: 'BI-20260916-001', ...params.input };
  }),
}));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn(async () => ({})) }));

import { createSampleLengthService } from '../sampleLengthService';
import { writeRouteAuditLog } from '../../audit/routeAudit';

const BASE_SAMPLE = {
  id: 'SMP1', code: 'SMP-20260916-001', deletedAt: null,
  lengthQty: '100', lengthUnit: 'M',
  type: 'dev', subType: 'yardage', productAssetId: null, status: 'making',
  sourceCaseId: 'DEV_1', sourceOrderId: null,
};

function makePrisma(seed: {
  sample?: any;
  inventoryItem?: any;
  warehouse?: any;
  sourceCases?: any[]; sourceOrders?: any[]; sourceAssets?: any[];
} = {}) {
  const state = {
    sample: seed.sample === undefined ? { ...BASE_SAMPLE } : seed.sample,
    inventoryItem: seed.inventoryItem === undefined ? null : seed.inventoryItem,
    warehouse: seed.warehouse === undefined ? { id: 'WH_MAIN', type: 'Main', isActive: true, sortOrder: 0 } : seed.warehouse,
  };
  const movements: any[] = [];
  const created: any[] = [];
  const tx: any = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    developmentCase: { findMany: vi.fn().mockResolvedValue(seed.sourceCases ?? [{ id: 'DEV_1', type: 'fabric', deletedAt: null }]) },
    order: { findMany: vi.fn().mockResolvedValue(seed.sourceOrders ?? []) },
    productAsset: { findMany: vi.fn().mockResolvedValue(seed.sourceAssets ?? []) },
    sampleSource: { findMany: vi.fn().mockResolvedValue([]) },
    sample: {
      findUnique: vi.fn(async () => state.sample),
      update: vi.fn(async ({ data }: any) => { state.sample = { ...state.sample, ...data }; return state.sample; }),
    },
    inventoryItem: {
      findUnique: async () => state.inventoryItem,
      findFirst: async () => state.inventoryItem,
      create: vi.fn(async ({ data }: any) => { created.push(data); state.inventoryItem = data; return data; }),
    },
    warehouse: { findFirst: async () => state.warehouse },
    sampleLengthMovement: { create: async ({ data }: any) => { movements.push(data); return data; } },
    auditLog: { create: async () => ({ id: 'AUD1' }) },
  };
  return {
    // ⚠️ `$transaction` 必须**模拟回滚**（抛错时恢复快照）——否则「整体回滚」的断言是空过的：
    //    state 被改过、movements 已 push，测试却看不出差别。
    prisma: {
      ...tx,
      $transaction: async (fn: any) => {
        const snap = {
          sample: state.sample ? { ...state.sample } : state.sample,
          inventoryItem: state.inventoryItem ? { ...state.inventoryItem } : state.inventoryItem,
          movLen: movements.length,
          createdLen: created.length,
        };
        try {
          return await fn(tx);
        } catch (e) {
          state.sample = snap.sample;
          state.inventoryItem = snap.inventoryItem;
          movements.length = snap.movLen;
          created.length = snap.createdLen;
          throw e;
        }
      },
    } as any,
    movements, created, state, tx,
  };
}

beforeEach(() => { vi.clearAllMocks(); stockMovementCalls.length = 0; billingItemCalls.length = 0; });

describe('convertToBulk — 米样转大货（双侧同事务）', () => {
  it('样品侧减 + 大货侧增（经 createStockMovement 且传 opts.tx）', async () => {
    const { prisma, movements } = makePrisma({ inventoryItem: { id: 'INV1', unit: 'M', deletedAt: null, materialCode: 'SMP-20260916-001' } });
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToBulk({ sampleId: 'SMP1', quantity: '30', operator: 'u1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.convertedQty).toBe(30);
      expect(r.data.balanceAfter).toBe(70);
      expect(r.data.inventoryItemId).toBe('INV1');
    }
    // 样品侧流水
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe('to_bulk');
    expect(String(movements[0].quantity)).toBe('30');
    expect(movements[0].targetInventoryItemId).toBe('INV1');
    // 大货侧：单一写入口 + **同事务**（opts.tx 必须存在）
    expect(stockMovementCalls).toHaveLength(1);
    expect(stockMovementCalls[0].input.type).toBe('Inbound');
    expect(stockMovementCalls[0].input.referenceType).toBe('Sample');
    expect(stockMovementCalls[0].input.referenceId).toBe('SMP1');
    expect(stockMovementCalls[0].opts?.tx).toBeDefined();
  });

  it('单位不一致（样品 M / 库存项 YD）→ 409 UNIT_MISMATCH，且不写流水', async () => {
    const { prisma, movements } = makePrisma({ inventoryItem: { id: 'INV1', unit: 'YD', deletedAt: null } });
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToBulk({ sampleId: 'SMP1', quantity: '30' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('UNIT_MISMATCH');
      expect(r.error.status).toBe(409);
    }
    expect(movements).toHaveLength(0);
    expect(stockMovementCalls).toHaveLength(0);
  });

  it('长度不足 → 409 LENGTH_INSUFFICIENT，且不写流水/不动库存', async () => {
    const { prisma, movements } = makePrisma({ inventoryItem: { id: 'INV1', unit: 'M', deletedAt: null } });
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToBulk({ sampleId: 'SMP1', quantity: '101' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('LENGTH_INSUFFICIENT');
    expect(movements).toHaveLength(0);
    expect(stockMovementCalls).toHaveLength(0);
  });

  it('带损耗：样品减 quantity+loss（两笔流水），**大货只增 quantity**', async () => {
    const { prisma, movements } = makePrisma({ inventoryItem: { id: 'INV1', unit: 'M', deletedAt: null } });
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToBulk({ sampleId: 'SMP1', quantity: '30', lossQty: '5' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.convertedQty).toBe(30);
      expect(r.data.lossQty).toBe(5);
      expect(r.data.balanceAfter).toBe(65); // 100 − 30 − 5
    }
    expect(movements.map(m => m.type).sort()).toEqual(['loss', 'to_bulk']);
    // 大货只增 30（损耗不进大货）
    expect(String(stockMovementCalls[0].input.quantity)).toBe('30');
  });

  it('目标库存项不存在 → 404 ITEM_NOT_FOUND', async () => {
    const { prisma } = makePrisma({ inventoryItem: null });
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToBulk({ sampleId: 'SMP1', quantity: '10', targetInventoryItemId: 'NOPE' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(404);
  });

  it('缺项自动建行（落到主仓，单位取样品单位）', async () => {
    const { prisma, created } = makePrisma({ inventoryItem: null });
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToBulk({ sampleId: 'SMP1', quantity: '10', materialCode: 'FAB-999' });
    expect(r.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].warehouseId).toBe('WH_MAIN');
    expect(created[0].materialCode).toBe('FAB-999');
    expect(created[0].unit).toBe('M');
  });

  it('无可用仓库 → 409 NO_WAREHOUSE', async () => {
    const { prisma } = makePrisma({ inventoryItem: null, warehouse: null });
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToBulk({ sampleId: 'SMP1', quantity: '10' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NO_WAREHOUSE');
  });

  it('未建长度账 → 409 NO_LENGTH_ACCOUNT', async () => {
    const { prisma } = makePrisma({ sample: { ...BASE_SAMPLE, lengthQty: null, lengthUnit: null } });
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToBulk({ sampleId: 'SMP1', quantity: '10' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NO_LENGTH_ACCOUNT');
  });
});

describe('convertToResale — 米样转售（样品侧减 + 应收侧增，**严格同事务**）', () => {
  it('样品侧减 + 应收侧走既有 BillingItem(sourceType=Sample)，且**传同一个 tx**', async () => {
    const { prisma, movements, tx } = makePrisma();
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToResale({ sampleId: 'SMP1', quantity: '20', customerRelationId: 'REL1', amount: '500', currency: 'CNY', operator: 'u1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.resoldQty).toBe(20);
      expect(r.data.balanceAfter).toBe(80);
      expect(r.data.billingItem).not.toBeNull();
      expect(r.data.warning).toBeNull();
    }
    expect(movements[0].type).toBe('to_resale');
    expect(movements[0].targetRelationId).toBe('REL1');
    expect(String(movements[0].amount)).toBe('500');
    // 应收侧走既有通路（不新建收款通道）
    expect(billingItemCalls).toHaveLength(1);
    expect(billingItemCalls[0].params.input.sourceType).toBe('Sample');
    expect(billingItemCalls[0].params.input.sourceId).toBe('SMP1');
    expect(billingItemCalls[0].params.input.bearerRelationId).toBe('REL1');
    // **同事务铁律**：计费侧收到的必须是事务客户端本身（对象同一性），不是裸 prisma
    expect(billingItemCalls[0].tx).toBe(tx);
  });

  it('计费项创建失败 → **整体回滚**（样品不扣、无流水、不落计费项）—— 不得出现半成品', async () => {
    const { prisma, movements, state } = makePrisma();
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToResale({ sampleId: 'SMP1', quantity: '20', customerRelationId: 'REL1', amount: 999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BOOM'); // 保留计费层具体 code，不糊成 500
    // 关键：样品侧必须回滚 —— 这正是修「非严格同事务」的核心断言
    expect(movements).toHaveLength(0);
    expect(Number(state.sample.lengthQty)).toBe(100);
  });

  it('金额 ≤ 0 → 400', async () => {
    const { prisma } = makePrisma();
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToResale({ sampleId: 'SMP1', quantity: '20', customerRelationId: 'REL1', amount: '0' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(400);
  });

  it('缺客户 → 400', async () => {
    const { prisma } = makePrisma();
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToResale({ sampleId: 'SMP1', quantity: '20', customerRelationId: '', amount: '100' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(400);
  });

  it('长度不足 → 409，且不建计费项、不写流水', async () => {
    const { prisma, movements } = makePrisma();
    const svc = createSampleLengthService(prisma);
    const r = await svc.convertToResale({ sampleId: 'SMP1', quantity: '999', customerRelationId: 'REL1', amount: '100' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('LENGTH_INSUFFICIENT');
    expect(billingItemCalls).toHaveLength(0);
    expect(movements).toHaveLength(0);
  });
});

describe('米样转化通道: 来源不明确或不属于面料时不得触及下游', () => {
  const invalidSources: { name: string; seed: { sample?: any; sourceCases?: any[]; sourceOrders?: any[] }; code: string }[] = [
    { name: '成衣开发来源（已有 M 长度账不能证明是面料）', seed: { sourceCases: [{ id: 'DEV_1', type: 'garment', deletedAt: null }] }, code: 'SAMPLE_LENGTH_BUSINESS_LINE_MISMATCH' },
    { name: '无业务来源', seed: { sample: { ...BASE_SAMPLE, sourceCaseId: null } }, code: 'SAMPLE_BUSINESS_CONTEXT_UNRESOLVED' },
    { name: '来源记录不存在', seed: { sourceCases: [] }, code: 'SAMPLE_BUSINESS_CONTEXT_UNRESOLVED' },
    { name: '来源记录已删除', seed: { sourceCases: [{ id: 'DEV_1', type: 'fabric', deletedAt: BigInt(1) }] }, code: 'SAMPLE_BUSINESS_CONTEXT_UNRESOLVED' },
    { name: '旧 pp 来源不能确认业务线', seed: { sourceCases: [{ id: 'DEV_1', type: 'pp', deletedAt: null }] }, code: 'SAMPLE_BUSINESS_CONTEXT_UNRESOLVED' },
    { name: '面料案和成衣订单冲突', seed: { sample: { ...BASE_SAMPLE, sourceOrderId: 'ORD_1' }, sourceOrders: [{ id: 'ORD_1', type: 'garment', businessLine: 'garment', deletedAt: null }] }, code: 'SAMPLE_BUSINESS_CONTEXT_CONFLICT' },
    { name: '订单 businessLine 与 type 自身冲突', seed: { sample: { ...BASE_SAMPLE, sourceCaseId: null, sourceOrderId: 'ORD_1' }, sourceOrders: [{ id: 'ORD_1', type: 'garment', businessLine: 'fabric', deletedAt: null }] }, code: 'SAMPLE_BUSINESS_CONTEXT_CONFLICT' },
  ];
  const actions = [
    { name: 'to_bulk', invoke: (svc: ReturnType<typeof createSampleLengthService>) => svc.convertToBulk({ sampleId: 'SMP1', quantity: '20', materialCode: 'FAB_NEW' }) },
    { name: 'to_resale', invoke: (svc: ReturnType<typeof createSampleLengthService>) => svc.convertToResale({ sampleId: 'SMP1', quantity: '20', customerRelationId: 'REL1', amount: '500' }) },
  ];
  for (const action of actions) {
    for (const scenario of invalidSources) {
      it(`${action.name}: ${scenario.name} → 无样品扣减/建库存/库存流水/应收/审计`, async () => {
        const { prisma, movements, created, state, tx } = makePrisma(scenario.seed);
        const before = { ...state.sample };
        const result = await action.invoke(createSampleLengthService(prisma));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(scenario.code);
          expect(result.error.status).toBe(409);
        }
        expect(state.sample).toEqual(before);
        expect(movements).toEqual([]);
        expect(created).toEqual([]);
        expect(tx.sample.update).not.toHaveBeenCalled();
        expect(tx.inventoryItem.create).not.toHaveBeenCalled();
        expect(stockMovementCalls).toEqual([]);
        expect(billingItemCalls).toEqual([]);
        expect(writeRouteAuditLog).not.toHaveBeenCalled();
      });
    }
  }
});
