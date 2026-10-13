/**
 * C3d KPI 指标校验 — 回归测试
 *
 * validateKpiItems 为 hrService 内部函数（非导出），回归测试经公开入口
 * upsertPerformanceReview({ cycleId, userId, kpi }) 触达，覆盖：
 *   ① weight 边界 0 / 100 通过；两项合计恰为 100 通过
 *   ② 负数或 >100 单项拒绝（HrError VALIDATION_FAILED）
 *   ③ 合计超 100 拒绝
 *   ④ projectId 空串归一化为 undefined
 *   ⑤ 空数组按实现语义落库 []；kpi:null 允许并落库 null
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../events/businessEventBus', () => ({
  publishBusinessEvent: vi.fn(),
}));

import { createHrService, HrError } from '../hrService';

/** 内存版 db mock：Open 周期 + 无既有评定 → create 分支捕获 data */
function makeDb() {
  const created: any[] = [];
  const db: any = {
    performanceCycle: {
      findUnique: async () => ({ id: 'CYC-1', status: 'Open' }),
    },
    performanceReview: {
      findUnique: async () => null,
      create: async ({ data }: any) => {
        created.push(data);
        return { id: data.id ?? 'review_x', ...data };
      },
      update: async () => {
        throw new Error('update should not be reached in these tests');
      },
    },
  };
  return { db, created };
}

const REVIEW = (kpi: unknown) => ({ cycleId: 'CYC-1', userId: 'u1', kpi });

describe('HR KPI 校验（validateKpiItems 经 upsertPerformanceReview）', () => {
  it('weight 边界 0 与 100 通过', async () => {
    const { db, created } = makeDb();
    const svc = createHrService(db);

    const r0 = await svc.upsertPerformanceReview(REVIEW([
      { name: '加班贡献', target: '', weight: 0 },
    ]));
    expect(r0.review.kpi).toHaveLength(1);
    expect(r0.review.kpi[0].weight).toBe(0);

    const r100 = await svc.upsertPerformanceReview(REVIEW([
      { name: '交付达成率', target: '≥95%', weight: 100 },
    ]));
    expect(r100.review.kpi[0].weight).toBe(100);
    expect(created).toHaveLength(2); // 两例均走 create 分支落数据
  });

  it('两项合计恰为 100 通过', async () => {
    const { db } = makeDb();
    const svc = createHrService(db);
    const { review } = await svc.upsertPerformanceReview(REVIEW([
      { name: '质量', target: '', weight: 50 },
      { name: '交期', target: '', weight: 50 },
    ]));
    expect(review.kpi.map((i: any) => i.weight)).toEqual([50, 50]);
  });

  it('负数 weight 拒绝：VALIDATION_FAILED 且不落数据', async () => {
    const { db, created } = makeDb();
    const svc = createHrService(db);
    await expect(
      svc.upsertPerformanceReview(REVIEW([{ name: '产量', target: '', weight: -5 }])),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('kpi[0].weight'),
    });
    expect(created).toHaveLength(0);
  });

  it('weight >100 拒绝', async () => {
    const { db } = makeDb();
    const svc = createHrService(db);
    await expect(
      svc.upsertPerformanceReview(REVIEW([{ name: '产量', target: '', weight: 101 }])),
    ).rejects.toBeInstanceOf(HrError);
    await expect(
      svc.upsertPerformanceReview(REVIEW([{ name: '产量', target: '', weight: 101 }])),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('须在 0-100'),
    });
  });

  it('合计超 100 拒绝（60+60=120）', async () => {
    const { db } = makeDb();
    const svc = createHrService(db);
    await expect(
      svc.upsertPerformanceReview(REVIEW([
        { name: '质量', target: '', weight: 60 },
        { name: '交期', target: '', weight: 60 },
      ])),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('KPI 权重总和 120 超过 100'),
    });
  });

  it('projectId 空串归一化为 undefined，非空串保留', async () => {
    const { db } = makeDb();
    const svc = createHrService(db);
    const { review } = await svc.upsertPerformanceReview(REVIEW([
      { id: 'a', name: '项目 A 达成', target: '', weight: 40, projectId: '' },
      { id: 'b', name: '项目 B 达成', target: '', weight: 40, projectId: '  PRJ-9  ' },
    ]));
    // 空串视为无效关联 → 归一化掉；非空串 trim 后保留
    expect(review.kpi[0].projectId).toBeUndefined();
    expect(review.kpi[1].projectId).toBe('PRJ-9');
  });

  it('空数组按实现语义有效并落库为 []', async () => {
    const { db, created } = makeDb();
    const svc = createHrService(db);
    const { review } = await svc.upsertPerformanceReview(REVIEW([]));
    expect(review.kpi).toEqual([]);
    expect(created[0].kpi).toEqual([]);
  });

  it('kpi=null 视为未设置：允许通过且落库 null', async () => {
    const { db } = makeDb();
    const svc = createHrService(db);
    const { review } = await svc.upsertPerformanceReview(REVIEW(null));
    expect(review.kpi).toBeNull();
  });
});
