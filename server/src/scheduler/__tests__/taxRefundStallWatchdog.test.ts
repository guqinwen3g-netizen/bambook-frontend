import { describe, expect, it, beforeEach } from 'vitest';
import { scanTaxRefundStalls } from '../tasks/taxRefundStallWatchdog';

/**
 * C6 财务深化 — 出口退税滞留预警测试
 *
 * Mock Prisma：内存存储 TaxRefund + RiskAlert（dedupKey 唯一约束 → P2002，
 * 与 crmFollowUpWatchdog.test.ts 同口径）。scanTaxRefundStalls 内部经
 * createRiskService(prisma).raiseAlert 落预警。滞留时钟 = updatedAt（BigInt ms）。
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function makeMockPrisma() {
  let seq = 0;
  const refunds: any[] = [];
  const riskAlerts: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('notIn' in cond) return !cond.notIn.includes(row[k]);
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        return true;
      }
      return row[k] === v;
    });

  const taxRefund = {
    findMany: async ({ where }: any = {}) => refunds.filter(r => matchWhere(r, where)),
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

  return { taxRefund, riskAlert, _stores: { refunds, riskAlerts } };
}

/** N 天前的 epoch ms（BigInt，与 schema updatedAt 同型） */
function daysAgo(n: number): bigint {
  return BigInt(Date.now() - n * DAY_MS);
}

function seedRefund(prisma: any, over: Record<string, any>) {
  const row = {
    id: over.id ?? `TR_${Math.random().toString(36).slice(2, 8)}`,
    refundNumber: over.refundNumber ?? 'TR2026-001',
    status: 'Submitted',
    refundAmount: 12345.6789,
    updatedAt: daysAgo(0),
    deletedAt: null,
    ...over,
  };
  prisma._stores.refunds.push(row);
  return row;
}

describe('C6 · 出口退税滞留预警', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('Submitted 滞留 35 天 → warning（税务审核滞留）', async () => {
    seedRefund(prisma, { id: 'TR_1', status: 'Submitted', updatedAt: daysAgo(35) });
    const { alerted } = await scanTaxRefundStalls(prisma as any);
    expect(alerted).toBe(1);
    const a = prisma._stores.riskAlerts[0];
    expect(a.type).toBe('tax_refund_stall');
    expect(a.level).toBe('warning');
    expect(a.title).toContain('TR2026-001');
    expect(a.title).toContain('税务审核');
    expect(a.title).toContain('滞留 35 天');
    expect(a.relatedType).toBe('TaxRefund');
    expect(a.dedupKey).toBe('tax_refund_stall:TR_1:Submitted:warning');
  });

  it('Reviewing 滞留 65 天 → critical', async () => {
    seedRefund(prisma, { id: 'TR_1', status: 'Reviewing', updatedAt: daysAgo(65) });
    const { alerted } = await scanTaxRefundStalls(prisma as any);
    expect(alerted).toBe(1);
    expect(prisma._stores.riskAlerts[0].level).toBe('critical');
  });

  it('Approved 滞留 70 天 → warning（已批未到账）；95 天 → critical', async () => {
    seedRefund(prisma, { id: 'TR_1', refundNumber: 'TR-A', status: 'Approved', updatedAt: daysAgo(70) });
    seedRefund(prisma, { id: 'TR_2', refundNumber: 'TR-B', status: 'Approved', updatedAt: daysAgo(95) });
    const { alerted } = await scanTaxRefundStalls(prisma as any);
    expect(alerted).toBe(2);
    const a = prisma._stores.riskAlerts.find((x: any) => x.relatedId === 'TR_1');
    const b = prisma._stores.riskAlerts.find((x: any) => x.relatedId === 'TR_2');
    expect(a.level).toBe('warning');
    expect(a.title).toContain('已批未到账');
    expect(b.level).toBe('critical');
  });

  it('阈值内 / 终态 / 软删不触发', async () => {
    seedRefund(prisma, { id: 'TR_1', status: 'Submitted', updatedAt: daysAgo(10) }); // 阈值内
    seedRefund(prisma, { id: 'TR_2', status: 'Draft', updatedAt: daysAgo(100) }); // Draft 未申报不参与
    seedRefund(prisma, { id: 'TR_3', status: 'Refunded', updatedAt: daysAgo(200) }); // 终态
    seedRefund(prisma, { id: 'TR_4', status: 'Rejected', updatedAt: daysAgo(200) }); // 终态
    seedRefund(prisma, { id: 'TR_5', status: 'Approved', updatedAt: daysAgo(100), deletedAt: BigInt(Date.now()) }); // 软删
    const { alerted } = await scanTaxRefundStalls(prisma as any);
    expect(alerted).toBe(0);
  });

  it('dedup 幂等：同状态同 tier 重扫不重复；tier 升级 / 状态迁移产生新键', async () => {
    seedRefund(prisma, { id: 'TR_1', status: 'Submitted', updatedAt: daysAgo(35) });
    expect((await scanTaxRefundStalls(prisma as any)).alerted).toBe(1);
    expect((await scanTaxRefundStalls(prisma as any)).alerted).toBe(0); // 幂等
    expect(prisma._stores.riskAlerts.length).toBe(1);

    // 滞留加深跨 60 天 → critical 新键
    prisma._stores.refunds[0].updatedAt = daysAgo(65);
    expect((await scanTaxRefundStalls(prisma as any)).alerted).toBe(1);
    expect(prisma._stores.riskAlerts.length).toBe(2);
    expect(prisma._stores.riskAlerts[1].level).toBe('critical');

    // 状态迁移 Submitted→Approved（时钟重置为 70 天前）→ Approved:warning 新键
    prisma._stores.refunds[0].status = 'Approved';
    prisma._stores.refunds[0].updatedAt = daysAgo(70);
    expect((await scanTaxRefundStalls(prisma as any)).alerted).toBe(1);
    expect(prisma._stores.riskAlerts.length).toBe(3);
    expect(prisma._stores.riskAlerts[2].dedupKey).toBe('tax_refund_stall:TR_1:Approved:warning');
  });

  it('应退金额非空时写入预警正文', async () => {
    seedRefund(prisma, { id: 'TR_1', status: 'Submitted', updatedAt: daysAgo(40), refundAmount: 88000.5 });
    const { alerted } = await scanTaxRefundStalls(prisma as any);
    expect(alerted).toBe(1);
    expect(prisma._stores.riskAlerts[0].content).toContain('88000.5');
  });

  it('空库零预警', async () => {
    const { alerted } = await scanTaxRefundStalls(prisma as any);
    expect(alerted).toBe(0);
  });
});
