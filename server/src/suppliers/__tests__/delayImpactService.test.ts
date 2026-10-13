/**
 * REQ2-10 工厂延迟链路影响计算回归测试（设计文档 §7 验收锚点）
 *
 * 覆盖：
 *   1. 缓冲侵蚀三级分级（critical ≤7 天 / warning >7 天 / info 未突破 / planDate 缺失回退）
 *   2. 登记（落库 + 影响快照 + 受影响订单 ID 快照 + 交期分联动）
 *   3. 延迟天数 → 交期分扣分映射
 *   4. 输入校验（delayDays 非正 / 工厂不存在 / reason 枚举）
 *   5. 列表 / 详情
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const recordAutoEvaluationMock = vi.fn().mockResolvedValue({ recorded: true, evaluationId: 'FAEV__D1' });
vi.mock('../factoryService', () => ({
  createFactoryService: vi.fn(() => ({ recordAutoEvaluation: recordAutoEvaluationMock })),
}));
vi.mock('../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createDelayImpactService, delayDaysToScore, DELAY_REASONS } from '../delayImpactService';

const SUPPLIER = { id: 'REL-MILL-1', name: '金华常青纺织厂', deletedAt: null };

/** 构造受影响订单：dueDate / productionPlanDeadline 可控 */
function makeOrder(o: any = {}) {
  return {
    id: 'PO-1', poNumber: 'PO-2601001', customer: 'Peerless', product: 'Wool Stretch',
    quantity: 3000, unit: 'M', status: 'Confirmed',
    dueDate: '2026-09-30', productionPlanDeadline: '2026-09-15',
    deletedAt: null, millRelationId: 'REL-MILL-1',
    ...o,
  };
}

function makePrisma(overrides: { orders?: any[]; relations?: any[]; records?: any[] } = {}) {
  const orders = overrides.orders ?? [];
  const relations = overrides.relations ?? [SUPPLIER];
  const records = overrides.records ?? [];
  const state = { records: [...records] };
  const prisma = {
    relation: {
      findFirst: vi.fn().mockImplementation(async (args: any) =>
        relations.find((r: any) => r.id === args?.where?.id && r.deletedAt == null) ?? null),
    },
    order: {
      findMany: vi.fn().mockImplementation(async () => orders.filter((o: any) => o.deletedAt == null)),
    },
    factoryDelayRecord: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }: any) => { state.records.push(data); return { ...data, impactSummary: data.impactSummary }; }),
      findMany: vi.fn().mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        return state.records.filter((r: any) =>
          (w.supplierRelationId ? r.supplierRelationId === w.supplierRelationId : true)
          && (w.deletedAt === null ? r.deletedAt == null : true)
        );
      }),
      findFirst: vi.fn().mockImplementation(async (args: any) =>
        state.records.find((r: any) => r.id === args?.where?.id && r.deletedAt == null) ?? null),
    },
  };
  return { prisma: prisma as any, state };
}

beforeEach(() => { vi.clearAllMocks(); recordAutoEvaluationMock.mockResolvedValue({ recorded: true, evaluationId: 'FAEV__D1' }); });

describe('缓冲侵蚀三级分级（DR-052-②）', () => {
  it('critical：突破交期且剩余缓冲 ≤7 天；warning：突破但缓冲 >7 天', async () => {
    // dueDate=09-30；plan=09-15；延迟 20 天 → 新完成 10-05，突破 5 天 → critical
    const critical = makeOrder();
    // plan=08-31；延迟 20 天 → 新完成 09-20，交期 09-30 前完成 → info（未突破）
    const info = makeOrder({ id: 'PO-2', poNumber: 'PO-2601002', productionPlanDeadline: '2026-08-31' });
    // plan=09-20；延迟 20 天 → 新完成 10-10，突破 10 天 → warning
    const warning = makeOrder({ id: 'PO-3', poNumber: 'PO-2601003', productionPlanDeadline: '2026-09-20' });
    const { prisma } = makePrisma({ orders: [critical, info, warning] });
    const svc = createDelayImpactService(prisma);

    const r = await svc.previewImpact('REL-MILL-1', 20);
    expect(r.ok).toBe(true);
    const { items, summary, advice } = (r as any).data;
    expect(summary).toMatchObject({ total: 3, critical: 1, warning: 1, info: 1 });
    const byPo = Object.fromEntries(items.map((x: any) => [x.poNumber, x]));
    expect(byPo['PO-2601001'].level).toBe('critical');
    expect(byPo['PO-2601001'].newCompletionDate).toBe('2026-10-05');
    expect(byPo['PO-2601001'].bufferDays).toBe(-5);
    expect(byPo['PO-2601002'].level).toBe('info');
    expect(byPo['PO-2601003'].level).toBe('warning');
    expect(byPo['PO-2601003'].bufferDays).toBe(-10);
    // 逐级沟通建议
    expect(advice.critical).toContain('立即通知客户');
    expect(advice.warning).toContain('加急');
    expect(advice.info).toContain('内部调整');
  });

  it('productionPlanDeadline 缺失 → 回退 dueDate 保守判定（planDateMissing 标注）', async () => {
    const { prisma } = makePrisma({ orders: [makeOrder({ id: 'PO-N', productionPlanDeadline: null })] });
    const svc = createDelayImpactService(prisma);
    const r = await svc.previewImpact('REL-MILL-1', 10);
    const item = (r as any).data.items[0];
    // plan 缺失 → base=dueDate 09-30，+10 → 10-10 突破 10 天 → warning
    expect(item.planDateMissing).toBe(true);
    expect(item.level).toBe('warning');
  });

  it('终态订单排除（Cancelled/Delivered/Completed 不入影响清单）', async () => {
    const { prisma } = makePrisma({
      orders: [makeOrder(), makeOrder({ id: 'PO-C', status: 'Cancelled' }), makeOrder({ id: 'PO-D', status: 'Delivered' })],
    });
    const svc = createDelayImpactService(prisma);
    const r = await svc.previewImpact('REL-MILL-1', 5);
    // mock findMany 未过滤状态——真实过滤在 service where 条件；这里用 mock 直接验证 service 传参
    const findManyCall = (prisma.order.findMany as any).mock.calls[0][0];
    expect(findManyCall.where.status.notIn).toEqual(['Cancelled', 'Delivered', 'Completed']);
    expect(findManyCall.where.millRelationId).toBe('REL-MILL-1');
  });
});

describe('登记（落库 + 快照 + 交期分联动 DR-052-③）', () => {
  it('登记 201：影响快照 + 受影响订单 ID 快照 + recordAutoEvaluation 联动', async () => {
    const { prisma, state } = makePrisma({ orders: [makeOrder(), makeOrder({ id: 'PO-2', poNumber: 'PO-2601002', productionPlanDeadline: '2026-08-31' })] });
    const svc = createDelayImpactService(prisma);
    const r = await svc.registerDelay({ supplierRelationId: 'REL-MILL-1', delayDays: 30, reason: 'capacity', reasonNote: '织机故障' }, 'user_sales');
    expect(r.ok).toBe(true);
    const { record, impact, qualityScoreLinked } = (r as any).data;
    expect(record.recordNumber).toMatch(/^FDR-\d{8}-\d{3}$/);
    expect(record.supplierName).toBe('金华常青纺织厂');
    expect(record.affectedOrderIds).toEqual(['PO-1', 'PO-2']);
    expect(record.impactSummary).toMatchObject({ total: 2, delayDays: 30 });
    expect(impact.summary.total).toBe(2);
    expect(qualityScoreLinked).toBe(true);
    // 交期分联动参数：30 天 → 25 分（delivery kind，幂等 sourceType）
    expect(recordAutoEvaluationMock).toHaveBeenCalledWith(expect.objectContaining({
      relationId: 'REL-MILL-1', kind: 'delivery', score: 25, sourceType: 'factory_delay',
    }));
    expect(state.records).toHaveLength(1);
  });

  it('联动失败不阻断登记（best-effort 边界）', async () => {
    recordAutoEvaluationMock.mockRejectedValue(new Error('eval down'));
    const { prisma } = makePrisma({ orders: [makeOrder()] });
    const svc = createDelayImpactService(prisma);
    const r = await svc.registerDelay({ supplierRelationId: 'REL-MILL-1', delayDays: 5 }, 'user_sales');
    expect(r.ok).toBe(true);
    expect((r as any).data.qualityScoreLinked).toBe(false);
  });
});

describe('输入校验与查询', () => {
  it('delayDays 非正整数 / 工厂不存在 / reason 非法 → 400/404', async () => {
    const { prisma } = makePrisma();
    const svc = createDelayImpactService(prisma);
    expect(((await svc.previewImpact('REL-MILL-1', 0)) as any).error.code).toBe('INVALID_DELAY_DAYS');
    expect(((await svc.previewImpact('REL-MILL-1', -5)) as any).error.code).toBe('INVALID_DELAY_DAYS');
    expect(((await svc.previewImpact('', 5)) as any).error.code).toBe('SUPPLIER_REQUIRED');
    expect(((await svc.previewImpact('REL-NONE', 5)) as any).error.status).toBe(404);
    const bad = await svc.registerDelay({ supplierRelationId: 'REL-MILL-1', delayDays: 5, reason: 'alien invasion' }, 'u');
    expect(((bad as any).error.code)).toBe('INVALID_REASON');
    expect(DELAY_REASONS).toContain('quality_rework');
  });

  it('列表（工厂过滤）与详情（404）', async () => {
    const { prisma, state } = makePrisma();
    state.records.push(
      { id: 'FDR__1', recordNumber: 'FDR-20260820-001', supplierRelationId: 'REL-MILL-1', supplierName: '金华常青纺织厂', delayDays: 30, reason: 'capacity', reasonNote: null, affectedOrderIds: ['PO-1'], impactSummary: { total: 1 }, registeredBy: 'u', createdAt: BigInt(1), deletedAt: null },
      { id: 'FDR__2', recordNumber: 'FDR-20260820-002', supplierRelationId: 'REL-MILL-2', supplierName: '他厂', delayDays: 5, reason: null, reasonNote: null, affectedOrderIds: [], impactSummary: { total: 0 }, registeredBy: 'u', createdAt: BigInt(2), deletedAt: null },
    );
    const svc = createDelayImpactService(prisma);
    const list = await svc.listDelays({ supplierRelationId: 'REL-MILL-1' });
    expect((list as any).data.items).toHaveLength(1);
    expect(((await svc.getDelay('FDR__1')) as any).data.record.id).toBe('FDR__1');
    expect(((await svc.getDelay('FDR__NOPE')) as any).error.status).toBe(404);
  });
});

describe('延迟天数 → 交期分扣分映射', () => {
  it('1-7 天=60 / 8-15 天=40 / 16-30 天=25 / >30 天=10', () => {
    expect(delayDaysToScore(1)).toBe(60);
    expect(delayDaysToScore(7)).toBe(60);
    expect(delayDaysToScore(8)).toBe(40);
    expect(delayDaysToScore(15)).toBe(40);
    expect(delayDaysToScore(16)).toBe(25);
    expect(delayDaysToScore(30)).toBe(25);
    expect(delayDaysToScore(31)).toBe(10);
    expect(delayDaysToScore(60)).toBe(10);
  });
});
