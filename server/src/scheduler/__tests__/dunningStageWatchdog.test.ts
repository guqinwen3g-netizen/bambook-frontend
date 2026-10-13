/**
 * P0-2 催款分级 — watchdog 测试（与 crmFollowUpWatchdog.test.ts 同口径）
 *
 * Mock Prisma：内存存储 invoice/invoiceAllocation（groupBy）/orderShipmentBatch/
 * dunningProfile/auditLog/riskAlert（dedupKey 唯一约束）。scanDunningStages 内部经
 * dunningStageService.scanAndSync 同步主档 + createRiskService.raiseAlert 落升级预警。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { scanDunningStages } from '../tasks/dunningStageWatchdog';

/** 相对今日的本地日期串（服务侧按真实今日计算，测试须同步口径） */
function dateFromToday(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeMockPrisma(seed: { invoices?: any[]; batches?: any[]; orderAllocations?: any[] } = {}) {
  const invoices = [...(seed.invoices ?? [])];
  const batches = [...(seed.batches ?? [])];
  const orderAllocations = [...(seed.orderAllocations ?? [])];
  const profiles: any[] = [];
  const riskAlerts: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        if ('in' in cond) return cond.in.includes(row[k]);
        return true;
      }
      return row[k] === v;
    });

  return {
    invoice: {
      findMany: async ({ where }: any = {}) => invoices.filter(i => matchWhere(i, where)),
    },
    invoiceAllocation: {
      groupBy: async () => [] as any[],
    },
    orderShipmentBatch: {
      findMany: async ({ where }: any = {}) => batches.filter(b => matchWhere(b, where)),
    },
    invoiceOrderAllocation: {
      findMany: async ({ where }: any = {}) => orderAllocations.filter(a => matchWhere(a, where)),
    },
    dunningProfile: {
      findMany: async () => profiles.map(p => ({ ...p })),
      findUnique: async ({ where }: any) => profiles.find(p => p.scopeKey === where.scopeKey) ?? null,
      create: async ({ data }: any) => { profiles.push({ ...data }); return { ...data }; },
      update: async ({ where, data }: any) => {
        const idx = profiles.findIndex(p => p.scopeKey === where.scopeKey);
        profiles[idx] = { ...profiles[idx], ...data };
        return { ...profiles[idx] };
      },
    },
    auditLog: {
      create: async ({ data }: any) => data,
    },
    riskAlert: {
      findUnique: async ({ where }: any) =>
        riskAlerts.find(a => (where.id !== undefined ? a.id === where.id : a.dedupKey === where.dedupKey)) || null,
      create: async ({ data }: any) => {
        if (riskAlerts.some(a => a.dedupKey === data.dedupKey)) {
          const err: any = new Error('Unique constraint failed on the fields: (`dedupKey`)');
          err.code = 'P2002';
          throw err;
        }
        const row = { relatedType: null, relatedId: null, status: 'Open', resolvedAt: null, ...data, id: data.id || `RSKA__T${riskAlerts.length + 1}` };
        riskAlerts.push(row);
        return row;
      },
    },
    _stores: { invoices, batches, profiles, riskAlerts },
  };
}

function makeInvoice(over: Record<string, any> = {}) {
  return {
    id: 'INV-1',
    invoiceNumber: 'INV-2026-001',
    amount: 10000,
    currency: 'USD',
    issueDate: dateFromToday(-100),
    dueDate: dateFromToday(-10), // 缺省逾期 10 天（d1_30 → reminder）
    customerRelationId: 'REL-1',
    customerName: 'Peerless',
    type: 'Receivable',
    status: 'Issued',
    deletedAt: null,
    ...over,
  };
}

describe('P0-2 · 催款分级自动升级 watchdog', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('首扫建档并升级 → dunning_stage 预警（reminder 档 info，标题含客户/档位）', async () => {
    prisma = makeMockPrisma({ invoices: [makeInvoice()] });
    const { scanned, escalated, alerted } = await scanDunningStages(prisma as any);
    expect(scanned).toBe(1);
    expect(escalated).toBe(1);
    expect(alerted).toBe(1);
    const a = prisma._stores.riskAlerts[0];
    expect(a.type).toBe('dunning_stage');
    expect(a.level).toBe('info');
    expect(a.title).toContain('Peerless');
    expect(a.title).toContain('提醒');
    expect(a.relatedType).toBe('DunningProfile');
    expect(a.dedupKey).toBe(`dunning_stage:rel:REL-1:USD:reminder`);
    // 主档已同步
    expect(prisma._stores.profiles[0].stage).toBe('reminder');
    expect(prisma._stores.profiles[0].lastScanAt).toBeTruthy();
  });

  it('账龄加深跨级 → 升级轨迹新键 + 级别升 critical（urgent/legal）', async () => {
    prisma = makeMockPrisma({ invoices: [makeInvoice()] });
    await scanDunningStages(prisma as any); // reminder（info）

    // 加深至 70 天（d61_90 → urgent，critical）
    prisma._stores.invoices[0].dueDate = dateFromToday(-70);
    const second = await scanDunningStages(prisma as any);
    expect(second.escalated).toBe(1);
    expect(second.alerted).toBe(1);
    expect(prisma._stores.riskAlerts[1].level).toBe('critical');
    expect(prisma._stores.riskAlerts[1].dedupKey).toBe(`dunning_stage:rel:REL-1:USD:urgent`);
    expect(prisma._stores.profiles[0].stage).toBe('urgent');

    // 幂等：无变化再扫 → 0 升级 0 新预警
    const third = await scanDunningStages(prisma as any);
    expect(third.escalated).toBe(0);
    expect(third.alerted).toBe(0);
    expect(prisma._stores.riskAlerts).toHaveLength(2);
  });

  it('P0-1 尾款逾期未结清（无逾期发票）→ 合成行保底 reminder 并预警', async () => {
    prisma = makeMockPrisma({
      batches: [{
        id: 'OSB__1', isFinalBatch: true, status: 'shipped', settleStatus: 'unsettled',
        finalPaymentDueDate: dateFromToday(-5), deletedAt: null,
        customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD',
        amount: 40000, paidAmount: 0,
      }],
    });
    const { escalated, alerted } = await scanDunningStages(prisma as any);
    expect(escalated).toBe(1);
    expect(alerted).toBe(1);
    const a = prisma._stores.riskAlerts[0];
    // ★ B252 后口径：这笔尾款一张票都没开过 ⇒ 全额都算"未开票尾款"，金额仍是那一个数（不重复念）
    expect(a.content).toContain('逾期账款 40000 USD');
    expect(a.content).toContain('含未开票尾款 40000');
    expect(a.content, '同一笔钱不得再出现"逾期账款 X + 逾期尾款 X"那种两遍写法').not.toContain(' + 逾期尾款 ');
    expect(prisma._stores.profiles[0].stage).toBe('reminder');
  });

  it('★ B252 已开票且已逾期的尾款：告警金额只念一遍（旧写法会把同一笔钱报成两倍）', async () => {
    prisma = makeMockPrisma({
      invoices: [{
        id: 'INV-1', invoiceNumber: 'INV-1', amount: 12900, currency: 'USD',
        issueDate: dateFromToday(-60), dueDate: dateFromToday(-10),
        customerRelationId: 'REL-1', customerName: 'Peerless',
        type: 'Receivable', status: 'Issued', deletedAt: null,
      }],
      batches: [{
        id: 'OSB__1', isFinalBatch: true, status: 'shipped', settleStatus: 'unsettled',
        finalPaymentDueDate: dateFromToday(-10), deletedAt: null,
        customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD',
        amount: 12900, paidAmount: 0,
      }],
      // 这 12,900 的尾款就是这张逾期发票 —— 现网 37/37 笔都是这一档
      orderAllocations: [{ id: 'IOA__1', invoiceId: 'INV-1', batchId: 'OSB__1', orderId: 'ORD__1', allocatedAmount: 12900, deletedAt: null }],
    });
    const { alerted } = await scanDunningStages(prisma as any);
    expect(alerted).toBe(1);
    const content = prisma._stores.riskAlerts[0].content;
    expect(content).toContain('逾期账款 12900 USD');
    expect(content, '钱已在账龄里计过 ⇒ 不得再挂一段"未开票尾款"').not.toContain('未开票尾款');
    expect(content, '★ 旧写法会写成 12900 + 12900＝把一笔债报成两笔').not.toContain(' + 逾期尾款 ');
  });

  it('无逾期数据 → 零扫描零预警', async () => {
    const r = await scanDunningStages(prisma as any);
    expect(r.scanned).toBe(0);
    expect(r.escalated).toBe(0);
    expect(r.alerted).toBe(0);
    expect(prisma._stores.riskAlerts).toHaveLength(0);
  });
});
