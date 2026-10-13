import { describe, expect, it, beforeEach } from 'vitest';
import { scanHrLifecycle } from '../tasks/hrLifecycleWatchdog';

/**
 * C3 HR 深化 — 试用转正 / 合同到期 预警测试
 *
 * Mock Prisma：内存存储 EmployeeProfile + RiskAlert（dedupKey 唯一约束 → P2002，
 * 与 sampleDeadlineWatchdog.test.ts 同口径）。scanHrLifecycle 内部经
 * createRiskService(prisma).raiseAlert 落预警。
 */
function makeMockPrisma() {
  let seq = 0;
  const profiles: any[] = [];
  const riskAlerts: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        if ('notIn' in cond) return !cond.notIn.includes(row[k]);
        return true;
      }
      return row[k] === v;
    });

  const employeeProfile = {
    findMany: async ({ where, include }: any = {}) =>
      profiles
        .filter(p => matchWhere(p, where))
        .map(p => (include?.user ? { ...p, user: p._user ?? null } : p)),
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

  return { employeeProfile, riskAlert, _stores: { profiles, riskAlerts } };
}

/** 相对今日的本地日期串（服务侧按真实今日计算，测试须同步口径） */
function dateFromToday(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function seedProfile(prisma: any, over: Record<string, any>) {
  const row = {
    id: over.id ?? `emp_${over.userId}`,
    userId: over.userId,
    employeeNo: over.employeeNo ?? `EMP-${over.userId}`,
    employmentStatus: 'Probation',
    regularDate: null,
    contractType: 'FixedTerm',
    contractEnd: null,
    deletedAt: null,
    _user: { displayName: over.displayName ?? `员工${over.userId}` },
    ...over,
  };
  prisma._stores.profiles.push(row);
  return row;
}

describe('C3 · 试用转正 / 合同到期预警', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('试用转正：转正日前 7 天窗口内 → warning，标题含剩余天数', async () => {
    seedProfile(prisma, { userId: 'U1', regularDate: dateFromToday(5) });
    const { alerted } = await scanHrLifecycle(prisma as any);
    expect(alerted).toBe(1);
    const a = prisma._stores.riskAlerts[0];
    expect(a.type).toBe('hr_lifecycle');
    expect(a.level).toBe('warning');
    expect(a.title).toContain('试用期即将到期');
    expect(a.title).toContain('仅剩 5 天');
    expect(a.relatedType).toBe('EmployeeProfile');
    expect(a.dedupKey).toBe(`hr_lifecycle:U1:probation:${dateFromToday(5)}:warning`);
  });

  it('试用转正：超过转正日 → 升 critical；窗口外（>7 天）不触发', async () => {
    seedProfile(prisma, { userId: 'U1', regularDate: dateFromToday(-2) });
    seedProfile(prisma, { userId: 'U2', regularDate: dateFromToday(10) });
    const { alerted } = await scanHrLifecycle(prisma as any);
    expect(alerted).toBe(1);
    const a = prisma._stores.riskAlerts[0];
    expect(a.level).toBe('critical');
    expect(a.title).toContain('已超转正日 2 天');
  });

  it('已转正（Regular）员工不触发试用期预警', async () => {
    seedProfile(prisma, { userId: 'U1', employmentStatus: 'Regular', regularDate: dateFromToday(3) });
    const { alerted } = await scanHrLifecycle(prisma as any);
    expect(alerted).toBe(0);
  });

  it('合同到期：30 天窗口内 → warning；过期 → critical', async () => {
    seedProfile(prisma, { userId: 'U1', employmentStatus: 'Regular', contractEnd: dateFromToday(20) });
    seedProfile(prisma, { userId: 'U2', employmentStatus: 'Regular', contractEnd: dateFromToday(-5) });
    seedProfile(prisma, { userId: 'U3', employmentStatus: 'Regular', contractEnd: dateFromToday(40) }); // 窗口外
    const { alerted } = await scanHrLifecycle(prisma as any);
    expect(alerted).toBe(2);
    const warning = prisma._stores.riskAlerts.find((a: any) => a.dedupKey.includes('U1'));
    const critical = prisma._stores.riskAlerts.find((a: any) => a.dedupKey.includes('U2'));
    expect(warning.level).toBe('warning');
    expect(warning.title).toContain('仅剩 20 天');
    expect(critical.level).toBe('critical');
    expect(critical.title).toContain('已过期');
  });

  it('离职/终止员工与无日期字段员工不触发任何预警', async () => {
    seedProfile(prisma, { userId: 'U1', employmentStatus: 'Resigned', regularDate: dateFromToday(1), contractEnd: dateFromToday(1) });
    seedProfile(prisma, { userId: 'U2', employmentStatus: 'Terminated', contractEnd: dateFromToday(1) });
    seedProfile(prisma, { userId: 'U3' }); // 无 regularDate / contractEnd
    seedProfile(prisma, { userId: 'U4', regularDate: dateFromToday(1), deletedAt: BigInt(Date.now()) }); // 软删
    const { alerted } = await scanHrLifecycle(prisma as any);
    expect(alerted).toBe(0);
  });

  it('dedup 幂等：同 tier 重复扫描不产生新预警；tier 升级产生新键', async () => {
    seedProfile(prisma, { userId: 'U1', regularDate: dateFromToday(5) });
    expect((await scanHrLifecycle(prisma as any)).alerted).toBe(1);
    expect((await scanHrLifecycle(prisma as any)).alerted).toBe(0); // 幂等
    expect(prisma._stores.riskAlerts.length).toBe(1);

    // 转正日变更到过去（如延期手续未办）→ tier 升级产生新预警
    prisma._stores.profiles[0].regularDate = dateFromToday(-1);
    expect((await scanHrLifecycle(prisma as any)).alerted).toBe(1);
    expect(prisma._stores.riskAlerts.length).toBe(2);
    expect(prisma._stores.riskAlerts[1].level).toBe('critical');
  });

  it('同一员工可同时产生试用期 + 合同两条预警（键互不冲突）', async () => {
    seedProfile(prisma, { userId: 'U1', regularDate: dateFromToday(3), contractEnd: dateFromToday(15) });
    const { alerted } = await scanHrLifecycle(prisma as any);
    expect(alerted).toBe(2);
    const keys = prisma._stores.riskAlerts.map((a: any) => a.dedupKey);
    expect(keys.some((k: string) => k.includes(':probation:'))).toBe(true);
    expect(keys.some((k: string) => k.includes(':contract:'))).toBe(true);
  });
});
