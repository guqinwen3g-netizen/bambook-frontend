/**
 * H2 季度回顾自动生成调度任务单元测试
 *
 * 覆盖：
 *   1. endDate 已过且无 reviewJson → 生成（逐条调用 generateSeasonReview）
 *   2. 已有 reviewJson / endDate 未到 → 跳过（DB 过滤条件携带 reviewJson:null + endDate < 今日）
 *   3. 单条生成失败 catch 住继续，不阻断其他季度
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mockGenerate = vi.fn().mockResolvedValue({});

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../seasons/seasonService', () => ({
  createSeasonService: vi.fn(() => ({
    generateSeasonReview: mockGenerate,
  })),
}));

import { logger } from '../../lib/logger';
import { generatePendingSeasonReviews } from '../tasks/seasonReviewWatchdog';

// 固定今天：2026-08-10
const TODAY = new Date(2026, 7, 10);

function makePrisma(seasons: any[]) {
  return {
    season: {
      findMany: vi.fn().mockResolvedValue(seasons),
    },
  } as any;
}

function makeSeason(overrides: Record<string, any> = {}) {
  return {
    id: 'SEAS__1',
    code: 'SS26',
    endDate: '2026-06-30', // 已过
    reviewJson: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('seasonReviewWatchdog · generatePendingSeasonReviews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('endDate 已过且无 reviewJson → 逐个生成季度回顾', async () => {
    const prisma = makePrisma([
      makeSeason({ id: 'SEAS__1', code: 'SS26' }),
      makeSeason({ id: 'SEAS__2', code: 'AW25', endDate: '2025-12-31' }),
    ]);
    const n = await generatePendingSeasonReviews(prisma, TODAY);
    expect(n).toBe(2);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockGenerate).toHaveBeenNthCalledWith(1, 'SEAS__1', 'system');
    expect(mockGenerate).toHaveBeenNthCalledWith(2, 'SEAS__2', 'system');
    expect(logger.info).toHaveBeenCalledWith('[SeasonReviewWatchdog] season reviews generated', { count: 2 });
  });

  it('已有 reviewJson / endDate 未到 → DB 过滤为空集，不生成（校验过滤口径）', async () => {
    const prisma = makePrisma([]); // reviewJson 非 null / endDate >= 今日 的行被 DB where 过滤
    const n = await generatePendingSeasonReviews(prisma, TODAY);
    expect(n).toBe(0);
    expect(mockGenerate).not.toHaveBeenCalled();

    const call = prisma.season.findMany.mock.calls[0][0];
    expect(call.where.deletedAt).toBeNull();
    expect(call.where.reviewJson).toEqual(Prisma.DbNull);
    expect(call.where.endDate).toEqual({ lt: '2026-08-10' });
  });

  it('单条生成失败 → 记录 error 并继续其他季度', async () => {
    mockGenerate.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({});
    const prisma = makePrisma([
      makeSeason({ id: 'SEAS__BAD' }),
      makeSeason({ id: 'SEAS__OK', code: 'AW25' }),
    ]);
    const n = await generatePendingSeasonReviews(prisma, TODAY);
    expect(n).toBe(1);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      '[SeasonReviewWatchdog] generate failed',
      expect.objectContaining({ seasonId: 'SEAS__BAD', error: 'boom' }),
    );
  });
});
