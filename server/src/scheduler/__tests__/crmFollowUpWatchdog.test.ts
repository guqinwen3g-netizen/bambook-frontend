import { describe, expect, it, beforeEach } from 'vitest';
import { scanCrmFollowUps } from '../tasks/crmFollowUpWatchdog';

/**
 * C1 CRM 深化 — 客户跟进逾期预警测试
 *
 * Mock Prisma：内存存储 FollowUpRecord + RiskAlert（dedupKey 唯一约束 → P2002，
 * 与 hrLifecycleWatchdog.test.ts 同口径）。scanCrmFollowUps 内部经
 * createRiskService(prisma).raiseAlert 落预警。
 */
function makeMockPrisma() {
  let seq = 0;
  const followUps: any[] = [];
  const riskAlerts: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        return true;
      }
      return row[k] === v;
    });

  const followUpRecord = {
    findMany: async ({ where, include }: any = {}) =>
      followUps
        .filter(f => matchWhere(f, where))
        .map(f => (include?.relation ? { ...f, relation: f._relation ?? null } : f)),
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

  return { followUpRecord, riskAlert, _stores: { followUps, riskAlerts } };
}

/** 相对今日的本地日期串（服务侧按真实今日计算，测试须同步口径） */
function dateFromToday(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function seedFollowUp(prisma: any, over: Record<string, any>) {
  const row = {
    id: over.id ?? `FU_${Math.random().toString(36).slice(2, 8)}`,
    relationId: over.relationId ?? 'rel_1',
    type: 'Call',
    content: '跟进内容',
    followUpAt: dateFromToday(-10),
    nextFollowUpAt: null,
    nextFollowUpTopic: null,
    deletedAt: null,
    _relation: { name: over.relationName ?? 'Client A' },
    ...over,
  };
  prisma._stores.followUps.push(row);
  return row;
}

describe('C1 · CRM 跟进逾期预警', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('下次跟进日已过期 → warning，标题含逾期天数与客户名', async () => {
    seedFollowUp(prisma, { id: 'FU_1', nextFollowUpAt: dateFromToday(-3), relationName: 'Client A' });
    const { alerted } = await scanCrmFollowUps(prisma as any);
    expect(alerted).toBe(1);
    const a = prisma._stores.riskAlerts[0];
    expect(a.type).toBe('crm_follow_up_overdue');
    expect(a.level).toBe('warning');
    expect(a.title).toContain('Client A');
    expect(a.title).toContain('逾期 3 天');
    expect(a.relatedType).toBe('FollowUpRecord');
    expect(a.relatedId).toBe('FU_1');
    expect(a.dedupKey).toBe(`crm_followup:FU_1:${dateFromToday(-3)}:warning`);
  });

  it('逾期超过 7 天 → 升 critical', async () => {
    seedFollowUp(prisma, { id: 'FU_1', nextFollowUpAt: dateFromToday(-10) });
    const { alerted } = await scanCrmFollowUps(prisma as any);
    expect(alerted).toBe(1);
    expect(prisma._stores.riskAlerts[0].level).toBe('critical');
    expect(prisma._stores.riskAlerts[0].title).toContain('逾期 10 天');
  });

  it('下次跟进日未到 / 为 null 不触发', async () => {
    seedFollowUp(prisma, { id: 'FU_1', nextFollowUpAt: dateFromToday(5) }); // 未来
    seedFollowUp(prisma, { id: 'FU_2', nextFollowUpAt: dateFromToday(0) }); // 今天（未逾期）
    seedFollowUp(prisma, { id: 'FU_3' }); // null
    const { alerted } = await scanCrmFollowUps(prisma as any);
    expect(alerted).toBe(0);
  });

  it('软删记录不触发', async () => {
    seedFollowUp(prisma, { id: 'FU_1', nextFollowUpAt: dateFromToday(-3), deletedAt: BigInt(Date.now()) });
    const { alerted } = await scanCrmFollowUps(prisma as any);
    expect(alerted).toBe(0);
  });

  it('跟进主题非空时写入预警正文', async () => {
    seedFollowUp(prisma, { id: 'FU_1', nextFollowUpAt: dateFromToday(-2), nextFollowUpTopic: '季度返单洽谈' });
    const { alerted } = await scanCrmFollowUps(prisma as any);
    expect(alerted).toBe(1);
    expect(prisma._stores.riskAlerts[0].content).toContain('季度返单洽谈');
  });

  it('dedup 幂等：同 tier 重复扫描不产生新预警；逾期加深升 tier 产生新键', async () => {
    seedFollowUp(prisma, { id: 'FU_1', nextFollowUpAt: dateFromToday(-3) });
    expect((await scanCrmFollowUps(prisma as any)).alerted).toBe(1);
    expect((await scanCrmFollowUps(prisma as any)).alerted).toBe(0); // 幂等
    expect(prisma._stores.riskAlerts.length).toBe(1);

    // 逾期加深跨 7 天阈值 → tier 升级产生新预警
    prisma._stores.followUps[0].nextFollowUpAt = dateFromToday(-8);
    expect((await scanCrmFollowUps(prisma as any)).alerted).toBe(1);
    expect(prisma._stores.riskAlerts.length).toBe(2);
    expect(prisma._stores.riskAlerts[1].level).toBe('critical');
  });

  it('多条逾期记录各自产生独立预警（键互不冲突）', async () => {
    seedFollowUp(prisma, { id: 'FU_1', relationId: 'rel_1', nextFollowUpAt: dateFromToday(-2) });
    seedFollowUp(prisma, { id: 'FU_2', relationId: 'rel_2', nextFollowUpAt: dateFromToday(-9) });
    const { alerted } = await scanCrmFollowUps(prisma as any);
    expect(alerted).toBe(2);
    const levels = prisma._stores.riskAlerts.map((a: any) => a.level).sort();
    expect(levels).toEqual(['critical', 'warning']);
  });
});
