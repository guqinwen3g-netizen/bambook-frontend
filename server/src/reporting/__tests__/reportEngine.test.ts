/**
 * A5 报表引擎 — reportEngine 单测
 * 覆盖：白名单校验（fail closed 全链路）/ 聚合执行（groupBy + aggregate 双路径 /
 *       软删注入 / 同字段过滤合并）/ CSV 转义 / 调度周期键（含 ISO 周年界）
 */
import { describe, expect, it, vi } from 'vitest';
import {
  executeReportDrill,
  executeReportQuery,
  isoWeekAndYear,
  metricColumn,
  periodKeyFor,
  rowsToCsv,
  validateDrillGroup,
  validateReportQuery,
} from '../reportEngine';
import { getDataset, listDatasets } from '../datasets';

// ────────────────────────────────────────────────────────────────
// 1. 白名单校验
// ────────────────────────────────────────────────────────────────
describe('validateReportQuery', () => {
  const VALID = {
    datasetKey: 'invoices',
    dimensions: ['type', 'currency'],
    metrics: [{ field: 'amount', agg: 'sum' }],
    filters: [{ field: 'issueDate', op: 'gte', value: '2026-01-01' }],
  };

  it('接受合法定义', () => {
    const r = validateReportQuery(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.datasetKey).toBe('invoices');
      expect(r.spec.dimensions).toEqual(['type', 'currency']);
      expect(r.dataset.prismaModel).toBe('invoice');
    }
  });

  it('拒绝非对象输入 / 未知数据集', () => {
    expect(validateReportQuery(null).ok).toBe(false);
    expect(validateReportQuery('x').ok).toBe(false);
    const r = validateReportQuery({ ...VALID, datasetKey: 'dropTable' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_DATASET');
  });

  it('拒绝白名单外维度（注入防御）', () => {
    const r = validateReportQuery({ ...VALID, dimensions: ['type', '$where'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_DIMENSION');
  });

  it('拒绝维度超上限', () => {
    const r = validateReportQuery({ ...VALID, dimensions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_DIMENSIONS');
  });

  it('维度去重', () => {
    const r = validateReportQuery({ ...VALID, dimensions: ['type', 'type'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.dimensions).toEqual(['type']);
  });

  it('拒绝空 metrics / 白名单外指标字段', () => {
    const r1 = validateReportQuery({ ...VALID, metrics: [] });
    expect(r1.ok).toBe(false);
    const r2 = validateReportQuery({ ...VALID, metrics: [{ field: 'customerName', agg: 'sum' }] });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('UNKNOWN_METRIC');
  });

  it('拒绝非法 agg；* 仅允许 count', () => {
    const r1 = validateReportQuery({ ...VALID, metrics: [{ field: 'amount', agg: 'median' }] });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('INVALID_AGG');
    const r2 = validateReportQuery({ ...VALID, metrics: [{ field: '*', agg: 'sum' }] });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('INVALID_METRIC');
    const r3 = validateReportQuery({ ...VALID, metrics: [{ field: '*', agg: 'count' }] });
    expect(r3.ok).toBe(true);
  });

  it('拒绝白名单外过滤字段 / 类型不允许的 op', () => {
    const r1 = validateReportQuery({ ...VALID, filters: [{ field: 'notes', op: 'eq', value: 'x' }] });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('UNKNOWN_FILTER_FIELD');

    // number 字段不允许 contains
    const r2 = validateReportQuery({
      datasetKey: 'invoices', dimensions: [], metrics: [{ field: 'amount', agg: 'sum' }],
      filters: [{ field: 'type', op: 'gte', value: 'x' }],
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('INVALID_FILTER_OP');
  });

  it('date 过滤值必须 YYYY-MM-DD', () => {
    const r = validateReportQuery({ ...VALID, filters: [{ field: 'issueDate', op: 'gte', value: '2026/01/01' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_FILTER_VALUE');
  });

  it('enum 过滤值必须在枚举内；in 要求字符串数组', () => {
    const r1 = validateReportQuery({ ...VALID, filters: [{ field: 'type', op: 'eq', value: 'Hacked' }] });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('INVALID_FILTER_VALUE');

    const r2 = validateReportQuery({ ...VALID, filters: [{ field: 'type', op: 'in', value: ['Receivable', 'Payable'] }] });
    expect(r2.ok).toBe(true);

    const r3 = validateReportQuery({ ...VALID, filters: [{ field: 'type', op: 'in', value: 'Receivable' }] });
    expect(r3.ok).toBe(false);
  });

  it('注册表覆盖 8 个核心数据集', () => {
    const keys = listDatasets().map(d => d.key);
    expect(keys).toEqual(['orders', 'invoices', 'paymentVouchers', 'shipments', 'vatInvoices', 'outwardRemittances', 'taxRefunds', 'inventoryItems']);
    for (const k of keys) {
      const ds = getDataset(k)!;
      expect(ds.dimensions.length).toBeGreaterThan(0);
      expect(ds.metrics.length).toBeGreaterThan(0);
      // A5d 下钻契约：实体类型码 / 主键 / 明细字段齐备
      expect(ds.entityType).toBeTruthy();
      expect(ds.idField).toBeTruthy();
      expect(ds.detailFields.length).toBeGreaterThan(0);
    }
  });

  it('库存数据集（inventoryItems）钉住三条口径', () => {
    const ds = getDataset('inventoryItems')!;
    expect(ds.prismaModel).toBe('inventoryItem');
    // ① 单位不可跨加 → 「单位」必须可选为维度
    expect(ds.dimensions.map(d => d.key)).toContain('unit');
    // ② 存货按货权而非物理位置 → ownership 必须是维度，且枚举两态
    const own = ds.dimensions.find(d => d.key === 'ownership')!;
    expect(own).toBeTruthy();
    expect(own.type).toBe('enum');
    expect(own.enumValues).toEqual(['Owned', 'Transferred']);
    // ③ 单位成本是金额、跨币种不可加 → 币种必须可选为维度
    expect(ds.dimensions.map(d => d.key)).toContain('currency');
    // 字段是否在模型上真实存在 → 由真库验收实跑 groupBy 证明（单测无法查 schema）
  });
});

// ────────────────────────────────────────────────────────────────
// 2. 聚合执行
// ────────────────────────────────────────────────────────────────
describe('executeReportQuery', () => {
  function makePrisma(groupByResult: any[] = [], aggregateResult: any = {}) {
    return {
      invoice: {
        groupBy: vi.fn().mockResolvedValue(groupByResult),
        aggregate: vi.fn().mockResolvedValue(aggregateResult),
      },
    } as any;
  }

  const dataset = getDataset('invoices')!;

  it('groupBy 路径：注入 deletedAt:null、by、聚合参数；结果列正确映射', async () => {
    const prisma = makePrisma([
      { type: 'Receivable', currency: 'USD', _sum: { amount: { toString: () => '1000.5' } }, _count: { _all: 3 } },
      { type: 'Receivable', currency: 'CNY', _sum: { amount: null }, _count: { _all: 1 } },
    ]);
    const spec = {
      datasetKey: 'invoices',
      dimensions: ['type', 'currency'],
      metrics: [{ field: 'amount', agg: 'sum' as const }, { field: '*', agg: 'count' as const }],
      filters: [{ field: 'issueDate', op: 'gte' as const, value: '2026-01-01' }],
    };
    const r = await executeReportQuery(prisma, dataset, spec, 500);

    const args = prisma.invoice.groupBy.mock.calls[0][0];
    expect(args.by).toEqual(['type', 'currency']);
    expect(args.where).toEqual({ deletedAt: null, issueDate: { gte: '2026-01-01' } });
    expect(args._sum).toEqual({ amount: true });
    expect(args._count).toEqual({ _all: true });
    expect(args.take).toBe(500);
    expect(args.orderBy).toEqual([{ type: 'asc' }, { currency: 'asc' }]);

    expect(r.columns).toEqual(['type', 'currency', 'sum(amount)', 'count(*)']);
    expect(r.columnLabels).toEqual(['发票类型', '币种', '发票金额(合计)', '行数']);
    expect(r.rows).toEqual([
      { type: 'Receivable', currency: 'USD', 'sum(amount)': 1000.5, 'count(*)': 3 },
      { type: 'Receivable', currency: 'CNY', 'sum(amount)': null, 'count(*)': 1 },
    ]);
  });

  it('同字段多过滤合并（日期区间 gte+lte）', async () => {
    const prisma = makePrisma([]);
    const spec = {
      datasetKey: 'invoices',
      dimensions: ['type'],
      metrics: [{ field: 'amount', agg: 'sum' as const }],
      filters: [
        { field: 'issueDate', op: 'gte' as const, value: '2026-01-01' },
        { field: 'issueDate', op: 'lte' as const, value: '2026-01-31' },
      ],
    };
    await executeReportQuery(prisma, dataset, spec, 500);
    const args = prisma.invoice.groupBy.mock.calls[0][0];
    expect(args.where.issueDate).toEqual({ gte: '2026-01-01', lte: '2026-01-31' });
  });

  it('无维度 → aggregate 单行路径', async () => {
    const prisma = makePrisma([], { _sum: { amount: { toString: () => '42' } }, _count: { _all: 7 } });
    const spec = {
      datasetKey: 'invoices',
      dimensions: [],
      metrics: [{ field: 'amount', agg: 'sum' as const }, { field: '*', agg: 'count' as const }],
      filters: [],
    };
    const r = await executeReportQuery(prisma, dataset, spec, 500);
    expect(prisma.invoice.aggregate).toHaveBeenCalledOnce();
    expect(prisma.invoice.groupBy).not.toHaveBeenCalled();
    expect(r.rows).toEqual([{ 'sum(amount)': 42, 'count(*)': 7 }]);
  });

  it('非 count 聚合支持 avg/min/max', async () => {
    const prisma = makePrisma([
      { currency: 'USD', _avg: { amount: 10 }, _min: { amount: 5 }, _max: { amount: 15 } },
    ]);
    const spec = {
      datasetKey: 'invoices',
      dimensions: ['currency'],
      metrics: [
        { field: 'amount', agg: 'avg' as const },
        { field: 'amount', agg: 'min' as const },
        { field: 'amount', agg: 'max' as const },
      ],
      filters: [],
    };
    const r = await executeReportQuery(prisma, dataset, spec, 500);
    const args = prisma.invoice.groupBy.mock.calls[0][0];
    expect(args._avg).toEqual({ amount: true });
    expect(args._min).toEqual({ amount: true });
    expect(args._max).toEqual({ amount: true });
    expect(r.rows[0]).toEqual({ currency: 'USD', 'avg(amount)': 10, 'min(amount)': 5, 'max(amount)': 15 });
  });

  it('字段级 count（非 *）映射 _count.field', async () => {
    const prisma = makePrisma([{ type: 'Receivable', _count: { amount: 2 } }]);
    const spec = {
      datasetKey: 'invoices',
      dimensions: ['type'],
      metrics: [{ field: 'amount', agg: 'count' as const }],
      filters: [],
    };
    const r = await executeReportQuery(prisma, dataset, spec, 500);
    expect(metricColumn(spec.metrics[0])).toBe('count(amount)');
    expect(r.rows[0]['count(amount)']).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// 2.5 下钻（A5d：聚合组 → 组成员实体明细）
// ────────────────────────────────────────────────────────────────
describe('validateDrillGroup', () => {
  const spec = { datasetKey: 'invoices', dimensions: ['type', 'currency'], metrics: [{ field: 'amount', agg: 'sum' as const }], filters: [] };

  it('接受恰好覆盖维度的组约束（含 null 空值组）', () => {
    const r = validateDrillGroup(spec, { type: 'Receivable', currency: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.group).toEqual({ type: 'Receivable', currency: null });
  });

  it('无维度报表接受空组（总计行下钻全表）', () => {
    const r = validateDrillGroup({ ...spec, dimensions: [] }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.group).toEqual({});
  });

  it('拒绝非对象 / 维度外键 / 非法值类型', () => {
    expect(validateDrillGroup(spec, null).ok).toBe(false);
    expect(validateDrillGroup(spec, ['type']).ok).toBe(false);
    const r1 = validateDrillGroup(spec, { type: 'Receivable', currency: 'USD', hack: 'x' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('INVALID_DRILL_GROUP');
    expect(validateDrillGroup(spec, { type: 123, currency: 'USD' }).ok).toBe(false);
  });
});

describe('executeReportDrill', () => {
  const dataset = getDataset('invoices')!;
  const spec = {
    datasetKey: 'invoices',
    dimensions: ['type', 'currency'],
    metrics: [{ field: 'amount', agg: 'sum' as const }],
    filters: [{ field: 'issueDate', op: 'gte' as const, value: '2026-01-01' }],
  };

  it('注入软删过滤 + 普通过滤 + 维度等值（含 null）；select 主键+明细字段；返回 total', async () => {
    const prisma = {
      invoice: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'INV__1', invoiceNumber: 'INV-2026-001', type: 'Receivable', status: 'Issued', customerName: 'Acme', amount: { toString: () => '100.5' }, currency: 'USD', issueDate: '2026-01-10', dueDate: null },
        ]),
        count: vi.fn().mockResolvedValue(3),
      },
    } as any;
    const r = await executeReportDrill(prisma, dataset, spec, { type: 'Receivable', currency: null }, 200);

    const args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      deletedAt: null,
      issueDate: { gte: '2026-01-01' },
      type: { equals: 'Receivable' },
      currency: { equals: null },
    });
    expect(args.select).toEqual({
      id: true, invoiceNumber: true, type: true, status: true,
      customerName: true, amount: true, currency: true, issueDate: true, dueDate: true,
    });
    expect(args.orderBy).toEqual({ id: 'asc' });
    expect(args.take).toBe(200);
    expect(prisma.invoice.count).toHaveBeenCalledWith({ where: args.where });

    expect(r.entityType).toBe('invoice');
    expect(r.idField).toBe('id');
    expect(r.total).toBe(3);
    expect(r.columns[0]).toBe('id');
    expect(r.columnLabels[0]).toBe('ID');
    // Decimal 等对象值统一字符串化
    expect(r.rows[0].amount).toBe('100.5');
    expect(r.rows[0].dueDate).toBeNull();
  });

  it('维度等值与同字段普通过滤合并', async () => {
    const prisma = { invoice: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) } } as any;
    const merged = {
      ...spec,
      dimensions: ['type'],
      filters: [{ field: 'type', op: 'ne' as const, value: 'Payable' }],
    };
    await executeReportDrill(prisma, dataset, merged, { type: 'Receivable' }, 200);
    const args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args.where.type).toEqual({ not: 'Payable', equals: 'Receivable' });
  });
});

// ────────────────────────────────────────────────────────────────
// 3. CSV 导出
// ────────────────────────────────────────────────────────────────
describe('rowsToCsv', () => {
  it('转义引号/逗号/换行；带 BOM；null 为空', () => {
    const csv = rowsToCsv(
      ['客户', '金额'],
      ['customer', 'amount'],
      [
        { customer: 'Acme, Inc.', amount: 100 },
        { customer: 'Say "Hi"\nBye', amount: null },
      ],
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\n');
    expect(lines[0]).toBe('客户,金额');
    expect(lines[1]).toBe('"Acme, Inc.",100');
    expect(lines[2]).toBe('"Say ""Hi""');
    expect(lines[3]).toBe('Bye",');
  });
});

// ────────────────────────────────────────────────────────────────
// 4. 调度周期键
// ────────────────────────────────────────────────────────────────
describe('periodKeyFor', () => {
  it('daily / monthly', () => {
    const d = new Date(2026, 7, 8); // 2026-08-08
    expect(periodKeyFor('daily', d)).toBe('2026-08-08');
    expect(periodKeyFor('monthly', d)).toBe('2026-08');
  });

  it('weekly 使用 ISO 周 + 周所属年（年界同周同键）', () => {
    // 2025-12-29（周一）与 2026-01-01（周四）同属 2026-W01
    const mon = new Date(2025, 11, 29);
    const thu = new Date(2026, 0, 1);
    expect(isoWeekAndYear(mon)).toEqual({ year: 2026, week: 1 });
    expect(isoWeekAndYear(thu)).toEqual({ year: 2026, week: 1 });
    expect(periodKeyFor('weekly', mon)).toBe('2026-W01');
    expect(periodKeyFor('weekly', thu)).toBe('2026-W01');
    // 2026-08-08 是周六 → 2026-W32
    expect(periodKeyFor('weekly', new Date(2026, 7, 8))).toBe('2026-W32');
  });
});
