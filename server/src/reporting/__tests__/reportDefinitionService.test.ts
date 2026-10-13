/**
 * A5 报表引擎 — reportDefinitionService 单测
 * 覆盖：定义 CRUD（校验 fail closed + 审计同事务）/ 预览截断 /
 *       运行快照（Running→Success/Failed）/ 调度幂等（查询层 + unique 约束双层）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_LIMIT,
  createReportDefinition,
  deleteReportDefinition,
  previewReportQuery,
  runReportDefinition,
  updateReportDefinition,
} from '../reportDefinitionService';

const VALID_INPUT = {
  name: '月度应收汇总',
  datasetKey: 'invoices',
  dimensions: ['currency'],
  metrics: [{ field: 'amount', agg: 'sum' }],
  filters: [{ field: 'type', op: 'eq', value: 'Receivable' }],
};

const EXISTING_DEF = {
  id: 'RPD__1',
  name: '月度应收汇总',
  description: null,
  datasetKey: 'invoices',
  dimensions: ['currency'],
  metrics: [{ field: 'amount', agg: 'sum' }],
  filters: [{ field: 'type', op: 'eq', value: 'Receivable' }],
  schedule: null,
  enabled: true,
  lastRunAt: null,
  createdBy: null,
  createdAt: 1n,
  updatedAt: 1n,
  deletedAt: null,
};

function makePrisma(overrides: {
  definition?: any;
  existingRun?: any;
  groupByResult?: any[];
  createRunError?: any;
} = {}) {
  const tx = {
    reportDefinition: {
      findUnique: vi.fn().mockResolvedValue(overrides.definition === undefined ? EXISTING_DEF : overrides.definition),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...EXISTING_DEF, id: where.id, ...data })),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  };
  const prisma: any = {
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    reportDefinition: {
      findUnique: vi.fn().mockResolvedValue(overrides.definition === undefined ? EXISTING_DEF : overrides.definition),
      update: vi.fn().mockResolvedValue({}),
    },
    reportRun: {
      findUnique: vi.fn().mockResolvedValue(overrides.existingRun ?? null),
      create: overrides.createRunError
        ? vi.fn().mockRejectedValue(overrides.createRunError)
        : vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    invoice: {
      groupBy: vi.fn().mockResolvedValue(overrides.groupByResult ?? []),
      aggregate: vi.fn().mockResolvedValue({}),
    },
    __tx: tx,
  };
  return prisma;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('createReportDefinition', () => {
  it('缺 name / 未知数据集 → fail closed', async () => {
    const prisma = makePrisma();
    const r1 = await createReportDefinition({ prisma, input: { ...VALID_INPUT, name: '' } });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('INVALID_INPUT');

    const r2 = await createReportDefinition({ prisma, input: { ...VALID_INPUT, datasetKey: 'hack' } });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('UNKNOWN_DATASET');
  });

  it('非法 schedule → INVALID_SCHEDULE', async () => {
    const prisma = makePrisma();
    const r = await createReportDefinition({ prisma, input: { ...VALID_INPUT, schedule: 'hourly' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_SCHEDULE');
  });

  it('成功创建：白名单规范化落库 + 审计同事务', async () => {
    const prisma = makePrisma();
    const r = await createReportDefinition({
      prisma,
      input: { ...VALID_INPUT, dimensions: ['currency', 'currency'], schedule: 'monthly' },
      actorId: 'user1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.definition.dimensions).toEqual(['currency']); // 去重
      expect(r.data.definition.schedule).toBe('monthly');
      expect(r.data.auditId).toBeDefined();
    }
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledOnce();
  });
});

describe('updateReportDefinition', () => {
  it('定义不存在 → NOT_FOUND', async () => {
    const prisma = makePrisma({ definition: null });
    const r = await updateReportDefinition({ prisma, definitionId: 'RPD__x', input: { name: 'x' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('合并后定义重新过白名单（改 dataset 后旧维度失效 → 拒绝）', async () => {
    const prisma = makePrisma();
    // currency 在 taxRefunds 数据集不是合法维度
    const r = await updateReportDefinition({
      prisma,
      definitionId: 'RPD__1',
      input: { datasetKey: 'taxRefunds' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_DIMENSION');
  });

  it('成功更新名称 + 启停', async () => {
    const prisma = makePrisma();
    const r = await updateReportDefinition({
      prisma,
      definitionId: 'RPD__1',
      input: { name: '新名称', enabled: false },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.definition.name).toBe('新名称');
      expect(r.data.definition.enabled).toBe(false);
    }
  });
});

describe('deleteReportDefinition', () => {
  it('软删 + 禁用 + 审计', async () => {
    const prisma = makePrisma();
    const r = await deleteReportDefinition({ prisma, definitionId: 'RPD__1' });
    expect(r.ok).toBe(true);
    const updateCall = prisma.__tx.reportDefinition.update.mock.calls[0][0];
    expect(updateCall.data.enabled).toBe(false);
    expect(updateCall.data.deletedAt).toBeDefined();
  });

  it('不存在 → NOT_FOUND', async () => {
    const prisma = makePrisma({ definition: null });
    const r = await deleteReportDefinition({ prisma, definitionId: 'RPD__x' });
    expect(r.ok).toBe(false);
  });
});

describe('previewReportQuery', () => {
  it('校验失败不落库', async () => {
    const prisma = makePrisma();
    const r = await previewReportQuery({ prisma, input: { datasetKey: 'hack', metrics: [] } });
    expect(r.ok).toBe(false);
    expect(prisma.invoice.groupBy).not.toHaveBeenCalled();
  });

  it(`超过 ${PREVIEW_LIMIT} 行截断并标记 truncated`, async () => {
    const bigRows = Array.from({ length: PREVIEW_LIMIT + 1 }, (_, i) => ({
      currency: `C${i}`, _sum: { amount: i },
    }));
    const prisma = makePrisma({ groupByResult: bigRows });
    const r = await previewReportQuery({
      prisma,
      input: { datasetKey: 'invoices', dimensions: ['currency'], metrics: [{ field: 'amount', agg: 'sum' }] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.truncated).toBe(true);
      expect(r.data.rows.length).toBe(PREVIEW_LIMIT);
    }
  });
});

describe('runReportDefinition', () => {
  it('定义不存在 / 已删除 → NOT_FOUND', async () => {
    const prisma = makePrisma({ definition: null });
    const r = await runReportDefinition({ prisma, definitionId: 'RPD__x', trigger: 'manual' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('schedule 触发 + 定义禁用 → DISABLED', async () => {
    const prisma = makePrisma({ definition: { ...EXISTING_DEF, enabled: false } });
    const r = await runReportDefinition({ prisma, definitionId: 'RPD__1', trigger: 'schedule', idempotencyKey: 'RPD__1:2026-08' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DISABLED');
  });

  it('同周期已有运行 → skipped，不重复执行聚合', async () => {
    const prisma = makePrisma({ existingRun: { id: 'RPR__old', idempotencyKey: 'RPD__1:2026-08' } });
    const r = await runReportDefinition({ prisma, definitionId: 'RPD__1', trigger: 'schedule', idempotencyKey: 'RPD__1:2026-08' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.skipped).toBe(true);
    expect(prisma.invoice.groupBy).not.toHaveBeenCalled();
    expect(prisma.reportRun.create).not.toHaveBeenCalled();
  });

  it('unique 冲突（并发）→ 按已运行处理', async () => {
    const prisma = makePrisma({
      existingRun: null,
      createRunError: Object.assign(new Error('unique'), { code: 'P2002' }),
    });
    // create 失败后 findUnique 第二次应返回已存在记录
    prisma.reportRun.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'RPR__concurrent' });
    const r = await runReportDefinition({ prisma, definitionId: 'RPD__1', trigger: 'schedule', idempotencyKey: 'RPD__1:2026-08' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.skipped).toBe(true);
      expect(r.data.run.id).toBe('RPR__concurrent');
    }
  });

  it('手动运行成功：Running→Success 快照 + lastRunAt 更新', async () => {
    const prisma = makePrisma({
      groupByResult: [{ currency: 'USD', _sum: { amount: { toString: () => '9.5' } } }],
    });
    const r = await runReportDefinition({ prisma, definitionId: 'RPD__1', trigger: 'manual', actorId: 'user1' });
    expect(r.ok).toBe(true);

    const createData = prisma.reportRun.create.mock.calls[0][0].data;
    expect(createData.status).toBe('Running');
    expect(createData.trigger).toBe('manual');
    expect(createData.idempotencyKey).toBeNull();

    const updateData = prisma.reportRun.update.mock.calls[0][0].data;
    expect(updateData.status).toBe('Success');
    expect(updateData.rowCount).toBe(1);
    expect(updateData.columns).toEqual(['currency', 'sum(amount)']);
    expect(updateData.columnLabels).toEqual(['币种', '发票金额(合计)']);
    expect(updateData.rows).toEqual([{ currency: 'USD', 'sum(amount)': 9.5 }]);
    expect(prisma.reportDefinition.update).toHaveBeenCalledOnce();
  });

  it('聚合执行异常 → Failed 快照（error 截断落库）', async () => {
    const prisma = makePrisma();
    prisma.invoice.groupBy.mockRejectedValue(new Error('GROUPBY_DOWN'));
    const r = await runReportDefinition({ prisma, definitionId: 'RPD__1', trigger: 'manual' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RUN_FAILED');
    const updateData = prisma.reportRun.update.mock.calls[0][0].data;
    expect(updateData.status).toBe('Failed');
    expect(updateData.error).toContain('GROUPBY_DOWN');
  });

  it('存储定义被手工改坏 → DEFINITION_INVALID（复核 fail closed）', async () => {
    const prisma = makePrisma({ definition: { ...EXISTING_DEF, dimensions: ['$where'] } });
    const r = await runReportDefinition({ prisma, definitionId: 'RPD__1', trigger: 'manual' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DEFINITION_INVALID');
  });
});
