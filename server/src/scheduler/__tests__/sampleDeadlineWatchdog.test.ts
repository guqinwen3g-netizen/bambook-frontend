import { describe, expect, it, beforeEach } from 'vitest';
import { scanSampleDeadlines } from '../tasks/sampleDeadlineWatchdog';

/**
 * Mock Prisma：内存存储 Order + RiskAlert（dedupKey 唯一约束 → P2002，
 * 与 riskRoute.test.ts 同口径）。scanSampleDeadlines 内部经
 * createRiskService(prisma).raiseAlert 落预警。
 */
function makeMockPrisma() {
  let seq = 0;
  const orders: any[] = [];
  const riskAlerts: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('notIn' in cond) return !cond.notIn.includes(row[k]);
        return true;
      }
      return row[k] === v;
    });

  const order = {
    findMany: async ({ where }: any = {}) => orders.filter(o => matchWhere(o, where)),
  };

  const riskAlert = {
    findUnique: async ({ where }: any) =>
      riskAlerts.find(a => (where.id !== undefined ? a.id === where.id : a.dedupKey === where.dedupKey)) || null,
    create: async ({ data }: any) => {
      if (riskAlerts.some(a => a.dedupKey === data.dedupKey)) {
        const err: any = new Error('Unique constraint failed on the fields: (`dedupKey`)');
        err.code = 'P2002';
        throw err;
      }
      const row = { relatedType: null, relatedId: null, status: 'Open', resolvedAt: null, ...data, id: data.id || `RSKA__T${++seq}` };
      riskAlerts.push(row);
      return row;
    },
  };

  return { order, riskAlert, _stores: { orders, riskAlerts } };
}

/** 相对今日的本地日期串（服务侧按真实今日计算，测试须同步口径） */
function dateFromToday(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function seedOrder(prisma: any, over: Record<string, any>) {
  const row = {
    id: over.id,
    poNumber: over.poNumber ?? `PO-${over.id}`,
    customer: 'Acme',
    product: 'Tee',
    quantity: 1000,
    status: 'InProduction',
    dueDate: '2026-12-01',
    clientDate: null,
    sampleSentDate: null,
    sampleConfirmedDate: null,
    fabricSampleSentDate: null,
    fabricSampleConfirmedDate: null,
    deletedAt: null,
    ...over,
  };
  prisma._stores.orders.push(row);
  return row;
}

describe('P0 · 船样 / 匹头样确认追踪预警（PRD 5.2）', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('船样：Exmill 前 14 天窗口内未确认 → warning，标题含剩余天数', async () => {
    seedOrder(prisma, { id: 'O1', clientDate: dateFromToday(10), sampleSentDate: dateFromToday(-5) });
    const { alerted } = await scanSampleDeadlines(prisma as any);
    expect(alerted).toBe(1);
    const a = prisma._stores.riskAlerts[0];
    expect(a.type).toBe('sample_deadline');
    expect(a.level).toBe('warning');
    expect(a.title).toContain('船样未确认');
    expect(a.title).toContain('仅剩 10 天');
    expect(a.relatedType).toBe('Order');
    expect(a.relatedId).toBe('O1');
    expect(a.dedupKey).toBe(`sample_deadline:O1:shipment:${dateFromToday(10)}:warning`);
  });

  it('船样：已确认不触发；窗口外（>14 天）不触发', async () => {
    seedOrder(prisma, { id: 'O1', clientDate: dateFromToday(10), sampleConfirmedDate: dateFromToday(-1) });
    seedOrder(prisma, { id: 'O2', clientDate: dateFromToday(20) });
    const { alerted } = await scanSampleDeadlines(prisma as any);
    expect(alerted).toBe(0);
  });

  it('船样：超过 Exmill → 升 critical', async () => {
    seedOrder(prisma, { id: 'O1', clientDate: dateFromToday(-3) });
    const { alerted } = await scanSampleDeadlines(prisma as any);
    expect(alerted).toBe(1);
    const a = prisma._stores.riskAlerts[0];
    expect(a.level).toBe('critical');
    expect(a.title).toContain('已超 Exmill 3 天');
    expect(a.dedupKey).toContain(':critical');
  });

  it('匹头样：已寄出未确认且进入 7 天窗口触发；未寄出（无匹头样流程）不触发', async () => {
    // 窗口 7 天：clientDate +5 → 触发（船样 14 天窗口也会触发一条）
    seedOrder(prisma, { id: 'O1', clientDate: dateFromToday(5), fabricSampleSentDate: dateFromToday(-3) });
    // 未寄出 → 不对无匹头样要求的订单误报（船样仍触发）
    seedOrder(prisma, { id: 'O2', clientDate: dateFromToday(5) });

    const { alerted } = await scanSampleDeadlines(prisma as any);
    expect(alerted).toBe(3); // O1 船样 + O1 匹头样 + O2 船样
    const fabric = prisma._stores.riskAlerts.filter((a: any) => a.dedupKey.includes(':fabric:'));
    expect(fabric.length).toBe(1);
    expect(fabric[0].relatedId).toBe('O1');
    expect(fabric[0].title).toContain('匹头样未确认');
  });

  it('已出运 / 已完结状态订单不触发；clientDate 缺失不触发', async () => {
    for (const status of ['Cancelled', 'Closed', 'Shipped', 'Invoiced', 'PartiallyPaid', 'Paid']) {
      seedOrder(prisma, { id: `O-${status}`, clientDate: dateFromToday(3), status });
    }
    seedOrder(prisma, { id: 'O-NODATE', clientDate: null });
    const { alerted } = await scanSampleDeadlines(prisma as any);
    expect(alerted).toBe(0);
  });

  it('dedup 幂等：同 tier 重复扫描不产生新预警；tier 升级产生新键', async () => {
    seedOrder(prisma, { id: 'O1', clientDate: dateFromToday(10) });
    expect((await scanSampleDeadlines(prisma as any)).alerted).toBe(1);
    expect((await scanSampleDeadlines(prisma as any)).alerted).toBe(0); // 幂等
    expect(prisma._stores.riskAlerts.length).toBe(1);

    // 同一订单 clientDate 变到过去（如改单）→ tier 升级产生新预警
    prisma._stores.orders[0].clientDate = dateFromToday(-1);
    expect((await scanSampleDeadlines(prisma as any)).alerted).toBe(1);
    expect(prisma._stores.riskAlerts.length).toBe(2);
    expect(prisma._stores.riskAlerts[1].level).toBe('critical');
  });
});
