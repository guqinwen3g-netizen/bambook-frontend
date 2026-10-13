/**
 * A5 报表引擎 — scheduledReportRunner 调度任务单测
 * 覆盖：周期键幂等（同周期跳过）/ 单定义失败不阻断其他定义 /
 *       shouldRun 小时级去重 / 无定义零开销
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetScheduledReportRunnerState,
  createScheduledReportRunnerTask,
  runDueReports,
} from '../tasks/scheduledReportRunner';

const DEF_DAILY = {
  id: 'RPD__d1',
  schedule: 'daily',
  name: '日报',
  datasetKey: 'invoices',
  dimensions: ['currency'],
  metrics: [{ field: 'amount', agg: 'sum' }],
  filters: [],
  enabled: true,
  deletedAt: null,
};
const DEF_MONTHLY = { ...DEF_DAILY, id: 'RPD__m1', schedule: 'monthly', name: '月报' };

function makePrisma(opts: {
  definitions?: any[];
  existingRunKeys?: Record<string, any>;
  failDefinitionId?: string;
} = {}) {
  const defs = opts.definitions ?? [];
  const defById = new Map(defs.map(d => [d.id, d]));
  return {
    reportDefinition: {
      findMany: vi.fn().mockResolvedValue(defs.map(d => ({ id: d.id, schedule: d.schedule }))),
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => defById.get(where.id) ?? null),
      update: vi.fn().mockResolvedValue({}),
    },
    reportRun: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => opts.existingRunKeys?.[where.idempotencyKey] ?? null),
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        if (opts.failDefinitionId && data.definitionId === opts.failDefinitionId) {
          throw new Error('DB_DOWN');
        }
        return { ...data };
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    invoice: {
      groupBy: vi.fn().mockResolvedValue([{ currency: 'USD', _sum: { amount: 1 } }]),
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetScheduledReportRunnerState();
});

describe('runDueReports', () => {
  it('无定时定义 → 零执行', async () => {
    const prisma = makePrisma({ definitions: [] });
    expect(await runDueReports(prisma, new Date(2026, 7, 8))).toBe(0);
    expect(prisma.reportRun.create).not.toHaveBeenCalled();
  });

  it('按周期键触发：daily=日期键 / monthly=月份键', async () => {
    const prisma = makePrisma({ definitions: [DEF_DAILY, DEF_MONTHLY] });
    const now = new Date(2026, 7, 8);
    const executed = await runDueReports(prisma, now);
    expect(executed).toBe(2);

    const keys = prisma.reportRun.create.mock.calls.map((c: any) => c[0].data.idempotencyKey);
    expect(keys).toContain('RPD__d1:2026-08-08');
    expect(keys).toContain('RPD__m1:2026-08');
    for (const c of prisma.reportRun.create.mock.calls) {
      expect(c[0].data.trigger).toBe('schedule');
    }
  });

  it('同周期已运行 → 跳过（幂等）', async () => {
    const prisma = makePrisma({
      definitions: [DEF_DAILY],
      existingRunKeys: { 'RPD__d1:2026-08-08': { id: 'RPR__old' } },
    });
    const executed = await runDueReports(prisma, new Date(2026, 7, 8));
    expect(executed).toBe(0);
    expect(prisma.reportRun.create).not.toHaveBeenCalled();
  });

  it('单定义失败不阻断其他定义', async () => {
    const prisma = makePrisma({ definitions: [DEF_DAILY, DEF_MONTHLY], failDefinitionId: 'RPD__d1' });
    const executed = await runDueReports(prisma, new Date(2026, 7, 8));
    expect(executed).toBe(1); // 月报成功，日报失败
  });
});

describe('createScheduledReportRunnerTask', () => {
  it('shouldRun 小时级去重（同一小时只触发一次）', () => {
    const task = createScheduledReportRunnerTask();
    expect(task.id).toBe('scheduled_report_runner');
    const h10 = new Date(2026, 7, 8, 10, 0);
    const h10later = new Date(2026, 7, 8, 10, 30);
    const h11 = new Date(2026, 7, 8, 11, 0);
    expect(task.shouldRun(h10)).toBe(true);
    expect(task.shouldRun(h10later)).toBe(false);
    expect(task.shouldRun(h11)).toBe(true);
  });
});
