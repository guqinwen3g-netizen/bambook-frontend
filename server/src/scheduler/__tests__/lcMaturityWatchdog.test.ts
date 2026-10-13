import { describe, expect, it, beforeEach } from 'vitest';
import { scanLcMaturity } from '../tasks/lcMaturityWatchdog';

/**
 * C6 财务深化 — 信用证三期预警测试
 *
 * Mock Prisma：内存存储 LetterOfCredit + RiskAlert（dedupKey 唯一约束 → P2002，
 * 与 crmFollowUpWatchdog.test.ts 同口径）。scanLcMaturity 内部经
 * createRiskService(prisma).raiseAlert 落预警。
 */
function makeMockPrisma() {
  let seq = 0;
  const lcs: any[] = [];
  const riskAlerts: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('notIn' in cond) return !cond.notIn.includes(row[k]);
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        return true;
      }
      return row[k] === v;
    });

  const letterOfCredit = {
    findMany: async ({ where }: any = {}) => lcs.filter(l => matchWhere(l, where)),
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

  return { letterOfCredit, riskAlert, _stores: { lcs, riskAlerts } };
}

/** 相对今日的本地日期串（服务侧按真实今日计算，测试须同步口径） */
function dateFromToday(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function seedLc(prisma: any, over: Record<string, any>) {
  const row = {
    id: over.id ?? `LC_${Math.random().toString(36).slice(2, 8)}`,
    lcNumber: over.lcNumber ?? 'LC2026-001',
    status: 'Issued',
    shipmentDeadline: null,
    presentationDeadline: null,
    expiryDate: null,
    deletedAt: null,
    ...over,
  };
  prisma._stores.lcs.push(row);
  return row;
}

describe('C6 · 信用证三期预警', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('期限临近（≤7 天）→ warning，标题含字段名与剩余天数', async () => {
    seedLc(prisma, { id: 'LC_1', expiryDate: dateFromToday(5) });
    const { alerted } = await scanLcMaturity(prisma as any);
    expect(alerted).toBe(1);
    const a = prisma._stores.riskAlerts[0];
    expect(a.type).toBe('lc_maturity');
    expect(a.level).toBe('warning');
    expect(a.title).toContain('LC2026-001');
    expect(a.title).toContain('有效期');
    expect(a.title).toContain('仅剩 5 天');
    expect(a.relatedType).toBe('LetterOfCredit');
    expect(a.relatedId).toBe('LC_1');
    expect(a.dedupKey).toBe(`lc_maturity:LC_1:expiryDate:${dateFromToday(5)}:warning`);
  });

  it('期限已过 → critical，含逾期天数', async () => {
    seedLc(prisma, { id: 'LC_1', presentationDeadline: dateFromToday(-3) });
    const { alerted } = await scanLcMaturity(prisma as any);
    expect(alerted).toBe(1);
    const a = prisma._stores.riskAlerts[0];
    expect(a.level).toBe('critical');
    expect(a.title).toContain('交单期限');
    expect(a.title).toContain('已逾期 3 天');
  });

  it('今日到期 → warning「今日到期」；窗口外（>7 天）不触发', async () => {
    seedLc(prisma, { id: 'LC_1', lcNumber: 'LC-TODAY', shipmentDeadline: dateFromToday(0) });
    seedLc(prisma, { id: 'LC_2', lcNumber: 'LC-FAR', expiryDate: dateFromToday(30) });
    const { alerted } = await scanLcMaturity(prisma as any);
    expect(alerted).toBe(1);
    expect(prisma._stores.riskAlerts[0].title).toContain('今日到期');
    expect(prisma._stores.riskAlerts[0].title).toContain('最迟装运期');
  });

  it('终态（Settled/Expired/Cancelled）与软删不触发；期限为空不触发', async () => {
    seedLc(prisma, { id: 'LC_1', status: 'Settled', expiryDate: dateFromToday(-1) });
    seedLc(prisma, { id: 'LC_2', status: 'Expired', expiryDate: dateFromToday(-1) });
    seedLc(prisma, { id: 'LC_3', status: 'Cancelled', expiryDate: dateFromToday(2) });
    seedLc(prisma, { id: 'LC_4', deletedAt: BigInt(Date.now()), expiryDate: dateFromToday(-1) });
    seedLc(prisma, { id: 'LC_5' }); // 三期全空
    const { alerted } = await scanLcMaturity(prisma as any);
    expect(alerted).toBe(0);
  });

  it('一单三期各自独立预警（键互不冲突）', async () => {
    seedLc(prisma, {
      id: 'LC_1',
      shipmentDeadline: dateFromToday(3),
      presentationDeadline: dateFromToday(-2),
      expiryDate: dateFromToday(10), // 窗口外
    });
    const { alerted } = await scanLcMaturity(prisma as any);
    expect(alerted).toBe(2);
    const levels = prisma._stores.riskAlerts.map((a: any) => a.level).sort();
    expect(levels).toEqual(['critical', 'warning']);
  });

  it('dedup 幂等：重复扫描不重复；临近→逾期 tier 升级产生新键', async () => {
    seedLc(prisma, { id: 'LC_1', expiryDate: dateFromToday(3) });
    expect((await scanLcMaturity(prisma as any)).alerted).toBe(1);
    expect((await scanLcMaturity(prisma as any)).alerted).toBe(0); // 幂等
    expect(prisma._stores.riskAlerts.length).toBe(1);

    // 期限被展期修改为已逾期（或时间推移）→ tier 升级产生新预警
    prisma._stores.lcs[0].expiryDate = dateFromToday(-1);
    expect((await scanLcMaturity(prisma as any)).alerted).toBe(1);
    expect(prisma._stores.riskAlerts.length).toBe(2);
    expect(prisma._stores.riskAlerts[1].level).toBe('critical');
  });

  it('空库零预警', async () => {
    const { alerted } = await scanLcMaturity(prisma as any);
    expect(alerted).toBe(0);
  });
});
