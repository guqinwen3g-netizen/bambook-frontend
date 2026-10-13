/**
 * REQ2-17 月末批量结转回归测试（设计文档 §5 验收锚点）
 *
 * 覆盖（DR-058 三决策）：
 *   ① mc: 幂等键月末时点快照（区隔 A5 键）；重复结转 skipped；默认上一个完整月
 *   ② 相邻期对比：metric 列求和 Δ/Δ%；上期真为 0 → Δ% null 且 Δ 算术仍成立；
 *      **上期/本期快照缺失 → deltas 内 current/previous/delta/deltaPct 全 null**（空值红线，不回落 0）
 *   ③ 审计留痕 + 单定义失败不阻断；无 monthly 定义 404；periodKey 校验 400
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const runReportMock = vi.fn();
vi.mock('../reportDefinitionService', () => ({
  runReportDefinition: (...args: any[]) => runReportMock(...args),
}));
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createMonthlyCloseService, previousMonthKey, shiftPeriodKey } from '../monthlyCloseService';

function makePrisma(seed: { definitions?: any[]; runs?: any[] } = {}) {
  const state = {
    definitions: [...(seed.definitions ?? [])],
    runs: [...(seed.runs ?? [])],
    auditLogs: [] as any[],
  };
  const prisma: any = {
    reportDefinition: {
      findMany: async ({ where }: any) =>
        state.definitions.filter((d: any) =>
          (where?.deletedAt === null ? d.deletedAt == null : true)
          && (where?.enabled === true ? d.enabled === true : true)
          && (where?.schedule === 'monthly' ? d.schedule === 'monthly' : true)),
    },
    reportRun: {
      findUnique: async ({ where }: any) => state.runs.find((r: any) => r.idempotencyKey === where.idempotencyKey) ?? null,
    },
    auditLog: { create: async ({ data }: any) => { state.auditLogs.push(data); return { id: data.id }; } },
  };
  return { prisma, state };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('periodKey 工具', () => {
  it('previousMonthKey 跨年正确（2026-01 → 2025-12）；shiftPeriodKey 双向', () => {
    expect(previousMonthKey(new Date('2026-01-15'))).toBe('2025-12');
    expect(previousMonthKey(new Date('2026-08-20'))).toBe('2026-07');
    expect(shiftPeriodKey('2026-01', -1)).toBe('2025-12');
    expect(shiftPeriodKey('2025-12', 1)).toBe('2026-01');
  });
});

describe('runMonthlyClose（DR-058-①）', () => {
  it('遍历 monthly+enabled 定义批量快照；mc: 幂等键；审计留痕', async () => {
    runReportMock.mockImplementation(async ({ idempotencyKey, definitionId }: any) => ({
      ok: true, data: { run: { id: `RPR_${definitionId}`, rowCount: 10, idempotencyKey } },
    }));
    const { prisma, state } = makePrisma({
      definitions: [
        { id: 'DEF-1', name: '订单月报', datasetKey: 'orders', schedule: 'monthly', enabled: true, deletedAt: null },
        { id: 'DEF-2', name: '发票月报', datasetKey: 'invoices', schedule: 'monthly', enabled: true, deletedAt: null },
        { id: 'DEF-3', name: '日报（跳过）', datasetKey: 'orders', schedule: 'daily', enabled: true, deletedAt: null },
        { id: 'DEF-4', name: '停用（跳过）', datasetKey: 'orders', schedule: 'monthly', enabled: false, deletedAt: null },
      ],
    });
    const r = await createMonthlyCloseService(prisma).runMonthlyClose({ periodKey: '2026-07', actorId: 'u_fin' });
    expect(r.ok).toBe(true);
    const d = (r as any).data;
    expect(d.total).toBe(2);
    expect(d.ran).toBe(2);
    expect(d.skipped).toBe(0);
    // mc: 前缀幂等键（区隔 A5 调度键 {id}:{periodKey}）
    expect(runReportMock).toHaveBeenCalledWith(expect.objectContaining({
      definitionId: 'DEF-1', trigger: 'schedule', idempotencyKey: 'mc:DEF-1:2026-07',
    }));
    // 审计
    expect(state.auditLogs[0].action).toBe('monthly_close_execute');
    expect(state.auditLogs[0].detail.after).toMatchObject({ periodKey: '2026-07', ran: 2 });
  });

  it('重复结转同 periodKey → skipped 不覆盖；单定义失败不阻断', async () => {
    runReportMock.mockImplementation(async ({ definitionId }: any) => {
      if (definitionId === 'DEF-1') return { ok: true, data: { run: { id: 'RPR_1', rowCount: 5 }, skipped: true } };
      if (definitionId === 'DEF-2') return { ok: false, error: { code: 'RUN_FAILED', message: 'boom' } };
      return { ok: true, data: { run: { id: 'RPR_x', rowCount: 1 } } };
    });
    const { prisma } = makePrisma({
      definitions: [
        { id: 'DEF-1', name: 'A', datasetKey: 'orders', schedule: 'monthly', enabled: true, deletedAt: null },
        { id: 'DEF-2', name: 'B', datasetKey: 'invoices', schedule: 'monthly', enabled: true, deletedAt: null },
        { id: 'DEF-3', name: 'C', datasetKey: 'orders', schedule: 'monthly', enabled: true, deletedAt: null },
      ],
    });
    const r = await createMonthlyCloseService(prisma).runMonthlyClose({ periodKey: '2026-07' });
    const d = (r as any).data;
    expect(d.ran).toBe(1);
    expect(d.skipped).toBe(1);
    expect(d.failed).toBe(1);
    const failed = d.results.find((x: any) => x.definitionId === 'DEF-2');
    expect(failed.error).toBe('RUN_FAILED');
  });

  it('默认上一个完整月；无 monthly 定义 404；periodKey 非法 400', async () => {
    const { prisma } = makePrisma();
    const r = await createMonthlyCloseService(prisma).runMonthlyClose({});
    expect((r as any).error.code).toBe('NO_MONTHLY_DEFINITIONS');

    const { prisma: p2 } = makePrisma({
      definitions: [{ id: 'DEF-1', name: 'A', datasetKey: 'orders', schedule: 'monthly', enabled: true, deletedAt: null }],
    });
    runReportMock.mockResolvedValue({ ok: true, data: { run: { id: 'RPR_1', rowCount: 0 } } });
    const r2 = await createMonthlyCloseService(p2).runMonthlyClose({});
    expect((r2 as any).data.periodKey).toBe(previousMonthKey());

    const r3 = await createMonthlyCloseService(p2).runMonthlyClose({ periodKey: '2026-13' });
    expect((r3 as any).error.code).toBe('VALIDATION_FAILED');
    const r4 = await createMonthlyCloseService(p2).runMonthlyClose({ periodKey: 'bad' });
    expect((r4 as any).error.code).toBe('VALIDATION_FAILED');
  });
});

describe('compareMonthlyClose（DR-058-②）', () => {
  it('相邻期 metric 汇总 Δ/Δ% 精确；上期为 0 → deltaPct null；缺上期 → previous=null', async () => {
    const { prisma } = makePrisma({
      definitions: [{
        id: 'DEF-1', name: '发票月报', datasetKey: 'invoices', schedule: 'monthly', enabled: true, deletedAt: null,
        metrics: [{ field: 'amount', agg: 'sum' }],
      }],
      runs: [
        {
          id: 'RPR_CUR', idempotencyKey: 'mc:DEF-1:2026-07', status: 'Success', rowCount: 2,
          rows: [{ 'sum(amount)': 100 }, { 'sum(amount)': 50 }],
        },
        {
          id: 'RPR_PREV', idempotencyKey: 'mc:DEF-1:2026-06', status: 'Success', rowCount: 1,
          rows: [{ 'sum(amount)': 75 }],
        },
      ],
    });
    const r = await createMonthlyCloseService(prisma).compareMonthlyClose({ periodKey: '2026-07' });
    const item = (r as any).data.items[0];
    expect(item.current.totals['sum(amount)']).toBe(150);
    expect(item.previous.totals['sum(amount)']).toBe(75);
    const delta = item.deltas[0];
    expect(delta).toMatchObject({ metric: 'sum(amount)', current: 150, previous: 75, delta: 75, deltaPct: 100 });

    // ★ 缺上期快照（无 mc:2026-05）→ previous=null ⇒ deltas 内一律 null（不可计算）。
    //   修前此处是 `previous: 0, delta: 75`（= 本期全额），与顶层 `previous: null` 自相矛盾，
    //   读作「上期 0、环比暴涨」，而真实语义是「没有基线」。
    const r2 = await createMonthlyCloseService(prisma).compareMonthlyClose({ periodKey: '2026-06' });
    const item2 = (r2 as any).data.items[0];
    expect(item2.previous).toBeNull();
    expect(item2.deltas[0]).toMatchObject({ current: 75, previous: null, delta: null, deltaPct: null });
  });

  it('对比缺本期快照 → current=null；Running 状态不算 Success；deltas 不可计算', async () => {
    const { prisma } = makePrisma({
      definitions: [{
        id: 'DEF-1', name: 'A', datasetKey: 'orders', schedule: 'monthly', enabled: true, deletedAt: null,
        metrics: [{ field: '*', agg: 'count' }],
      }],
      runs: [
        { id: 'RPR_R', idempotencyKey: 'mc:DEF-1:2026-07', status: 'Running', rows: [] },
      ],
    });
    const r = await createMonthlyCloseService(prisma).compareMonthlyClose({ periodKey: '2026-07' });
    const item = (r as any).data.items[0];
    expect(item.current).toBeNull();
    expect(item.previous).toBeNull();
    // 两侧快照都没有 → 修前是 `0/0/0`，读作「本期 0 行、环比持平」，实为「未结转、不可计算」
    expect(item.deltas[0]).toMatchObject({ current: null, previous: null, delta: null, deltaPct: null });
  });

  it('★ 上期快照存在且汇总真为 0 ⇒ 仍是真零，Δ 算术照旧成立（防修法做过头）', async () => {
    const { prisma } = makePrisma({
      definitions: [{
        id: 'DEF-1', name: '发票月报', datasetKey: 'invoices', schedule: 'monthly', enabled: true, deletedAt: null,
        metrics: [{ field: 'amount', agg: 'sum' }],
      }],
      runs: [
        { id: 'RPR_CUR', idempotencyKey: 'mc:DEF-1:2026-07', status: 'Success', rowCount: 2, rows: [{ 'sum(amount)': 100 }, { 'sum(amount)': 50 }] },
        // 上期快照在、rows 为空 ⇒ 汇总真为 0（不是"没取到"）
        { id: 'RPR_PREV', idempotencyKey: 'mc:DEF-1:2026-06', status: 'Success', rowCount: 0, rows: [] },
      ],
    });
    const r = await createMonthlyCloseService(prisma).compareMonthlyClose({ periodKey: '2026-07' });
    const d = (r as any).data.items[0].deltas[0];
    // 快照存在 ⇒ previous 是 0（真零），Δ = 150 - 0 = 150 成立；仅 Δ% 因除零为 null
    expect(d).toMatchObject({ current: 150, previous: 0, delta: 150, deltaPct: null });
  });

  it('★ 仅缺本期快照（上期在）→ previous 保真、delta 仍为 null', async () => {
    const { prisma } = makePrisma({
      definitions: [{
        id: 'DEF-1', name: 'A', datasetKey: 'orders', schedule: 'monthly', enabled: true, deletedAt: null,
        metrics: [{ field: 'amount', agg: 'sum' }],
      }],
      runs: [
        { id: 'RPR_PREV', idempotencyKey: 'mc:DEF-1:2026-06', status: 'Success', rowCount: 1, rows: [{ 'sum(amount)': 75 }] },
      ],
    });
    const r = await createMonthlyCloseService(prisma).compareMonthlyClose({ periodKey: '2026-07' });
    const item = (r as any).data.items[0];
    expect(item.current).toBeNull();
    expect(item.previous.totals['sum(amount)']).toBe(75);
    // 修前：current 回落 0 ⇒ delta = -75，读作「本期归零、暴跌 75」
    expect(item.deltas[0]).toMatchObject({ current: null, previous: 75, delta: null, deltaPct: null });
  });
});
