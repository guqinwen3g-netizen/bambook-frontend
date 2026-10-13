/**
 * M4 信用评级定时重估调度任务单元测试
 *
 * 覆盖：
 *   1. 全部 Customer 客户重估（actorId=null 系统自动）
 *   2. 日内幂等：当日已有评级的客户跳过
 *   3. 单客户失败不阻断其余客户（failed 计数）
 *   4. shouldRun：09:45 前不跑 / 之后每日一次
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockEvaluate = vi.fn().mockResolvedValue({ id: 'CDR_1' });

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../risk/riskService', () => ({
  createRiskService: vi.fn(() => ({
    evaluateCreditRating: mockEvaluate,
  })),
}));

import { reevaluateAllCustomerRatings, createCreditRatingReevaluationTask } from '../tasks/creditRatingReevaluation';

const TODAY = new Date(2026, 7, 10, 12, 0, 0); // 2026-08-10 12:00 本地

function dayStartBigInt(d: Date): bigint {
  return BigInt(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
}

function makePrisma(relations: Array<{ id: string }>, latestRatings: Record<string, any | null> = {}) {
  return {
    relation: {
      findMany: vi.fn().mockResolvedValue(relations),
    },
    creditRating: {
      findFirst: vi.fn(async ({ where }: any) => latestRatings[where.relationId] ?? null),
    },
  } as any;
}

describe('creditRatingReevaluation · reevaluateAllCustomerRatings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluate.mockResolvedValue({ id: 'CDR_1' });
  });

  it('全部 Customer 重估，actorId=null（系统自动）', async () => {
    const prisma = makePrisma([{ id: 'REL_1' }, { id: 'REL_2' }]);
    const res = await reevaluateAllCustomerRatings(prisma, TODAY);
    expect(res).toEqual({ evaluated: 2, skipped: 0, failed: 0 });
    expect(mockEvaluate).toHaveBeenCalledTimes(2);
    expect(mockEvaluate).toHaveBeenNthCalledWith(1, 'REL_1', null);
    expect(mockEvaluate).toHaveBeenNthCalledWith(2, 'REL_2', null);
  });

  it('日内幂等：当日零点之后已有评级的客户跳过，不产生重复行', async () => {
    const prisma = makePrisma(
      [{ id: 'REL_1' }, { id: 'REL_2' }],
      {
        REL_1: { id: 'CDR_A', relationId: 'REL_1', evaluatedAt: dayStartBigInt(TODAY) + BigInt(3600_000) }, // 当日 01:00
        REL_2: { id: 'CDR_B', relationId: 'REL_2', evaluatedAt: dayStartBigInt(TODAY) - BigInt(1) }, // 昨日 23:59:59
      },
    );
    const res = await reevaluateAllCustomerRatings(prisma, TODAY);
    expect(res).toEqual({ evaluated: 1, skipped: 1, failed: 0 });
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(mockEvaluate).toHaveBeenCalledWith('REL_2', null);
  });

  it('单客户失败不阻断：failed 计数且继续处理后续客户', async () => {
    mockEvaluate
      .mockRejectedValueOnce(new Error('客户关系不存在'))
      .mockResolvedValueOnce({ id: 'CDR_2' });
    const prisma = makePrisma([{ id: 'REL_GONE' }, { id: 'REL_2' }]);
    const res = await reevaluateAllCustomerRatings(prisma, TODAY);
    expect(res).toEqual({ evaluated: 1, skipped: 0, failed: 1 });
    expect(mockEvaluate).toHaveBeenCalledTimes(2);
  });
});

describe('creditRatingReevaluation · shouldRun', () => {
  it('09:45 前不跑，之后每日一次，同日第二次不跑', () => {
    const task = createCreditRatingReevaluationTask();
    expect(task.shouldRun(new Date(2026, 7, 20, 9, 30))).toBe(false); // 09:30 < 09:45
    expect(task.shouldRun(new Date(2026, 7, 20, 9, 45))).toBe(true);
    expect(task.shouldRun(new Date(2026, 7, 20, 14, 0))).toBe(false); // 同日已跑
    expect(task.shouldRun(new Date(2026, 7, 21, 10, 0))).toBe(true); // 次日
  });
});
