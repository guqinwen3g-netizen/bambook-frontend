/**
 * P0-2 催款分级状态机测试（设计文档 §验收要点）
 *
 * 覆盖：
 *   1. 纯函数：stageOfBuckets 账龄自动定级 / resolveEffectiveStage manual 钉住×auto 穿透
 *   2. listBoard 分级看板：账龄行自动归列 + manual 钉住合成 + P0-1 尾款喂入
 *      （匹配行保底 reminder / 未开票尾款合成行）+ 分级汇总
 *   3. setStageManual 人工升降级：校验（枚举/原因必填）+ 钉住留痕（routeAudit）
 *      + 解除钉住回退自动定级
 *   4. scanAndSync 主档同步：升级轨迹（none→reminder→…）
 *
 * Mock Prisma：内存存储 invoice/invoiceAllocation/groupBy/orderShipmentBatch/
 * dunningProfile/auditLog（与 crmFollowUpWatchdog.test.ts 同口径）。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  createDunningStageService,
  stageOfBuckets,
  resolveEffectiveStage,
  scopeKeyOf,
} from '../dunningStageService';

/** 相对今日的本地日期串（服务侧按真实今日计算，测试须同步口径） */
function dateFromToday(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeMockPrisma(seed: {
  invoices?: any[];
  allocations?: any[];
  batches?: any[];
  orderAllocations?: any[];
  profiles?: any[];
} = {}) {
  const invoices = [...(seed.invoices ?? [])];
  const allocations = [...(seed.allocations ?? [])];
  const batches = [...(seed.batches ?? [])];
  const orderAllocations = [...(seed.orderAllocations ?? [])];
  const profiles = [...(seed.profiles ?? [])];
  const auditLogs: any[] = [];

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
      groupBy: async ({ where }: any = {}) => {
        const sums = new Map<string, number>();
        for (const a of allocations) {
          if (where?.invoiceId?.in && !where.invoiceId.in.includes(a.invoiceId)) continue;
          sums.set(a.invoiceId, (sums.get(a.invoiceId) ?? 0) + Number(a.appliedAmount));
        }
        return [...sums.entries()].map(([invoiceId, appliedAmount]) => ({ invoiceId, _sum: { appliedAmount } }));
      },
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
      create: async ({ data }: any) => { auditLogs.push(data); return data; },
    },
    _stores: { invoices, allocations, batches, profiles, auditLogs },
  };
}

function makeInvoice(over: Record<string, any> = {}) {
  return {
    id: 'INV-1',
    invoiceNumber: 'INV-2026-001',
    amount: 10000,
    currency: 'USD',
    issueDate: dateFromToday(-100),
    dueDate: dateFromToday(-10), // 缺省逾期 10 天（d1_30）
    customerRelationId: 'REL-1',
    customerName: 'Peerless',
    type: 'Receivable',
    status: 'Issued',
    deletedAt: null,
    ...over,
  };
}

describe('纯函数：stageOfBuckets 账龄自动定级', () => {
  it('五桶映射：d90plus→legal / d61_90→urgent / d31_60→firm / d1_30→reminder / 全零→none', () => {
    expect(stageOfBuckets({ d90plus: 1 })).toBe('legal');
    expect(stageOfBuckets({ d61_90: 1 })).toBe('urgent');
    expect(stageOfBuckets({ d31_60: 1 })).toBe('firm');
    expect(stageOfBuckets({ d1_30: 1 })).toBe('reminder');
    expect(stageOfBuckets({ d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 })).toBe('none');
    expect(stageOfBuckets({})).toBe('none');
  });
});

describe('纯函数：resolveEffectiveStage manual 钉住×auto 穿透', () => {
  it('无主档 → 纯 auto；auto 来源 → 跟随 auto', () => {
    expect(resolveEffectiveStage(null, 'firm')).toEqual({ stage: 'firm', stageSource: 'auto' });
    expect(resolveEffectiveStage({ stage: 'legal', stageSource: 'auto' }, 'reminder'))
      .toEqual({ stage: 'reminder', stageSource: 'auto' });
  });

  it('manual 钉住：auto 未超 → 保持 manual；auto 超过钉住值 → 向上穿透', () => {
    // 钉在 legal，账龄只有 d1_30 → 保持 legal（提前严催）
    expect(resolveEffectiveStage({ stage: 'legal', stageSource: 'manual' }, 'reminder'))
      .toEqual({ stage: 'legal', stageSource: 'manual' });
    // 钉在 reminder（客户承诺还款），账龄烂到 90+ → aging 证据穿透为 legal
    expect(resolveEffectiveStage({ stage: 'reminder', stageSource: 'manual' }, 'legal'))
      .toEqual({ stage: 'legal', stageSource: 'auto' });
    // 钉在 firm，账龄 d61_90 → urgent 穿透
    expect(resolveEffectiveStage({ stage: 'firm', stageSource: 'manual' }, 'urgent'))
      .toEqual({ stage: 'urgent', stageSource: 'auto' });
  });
});

describe('listBoard 分级看板', () => {
  it('账龄行自动归列：逾期 10 天 → reminder / auto 来源', async () => {
    const prisma = makeMockPrisma({ invoices: [makeInvoice()] });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.listBoard();
    expect(r.ok).toBe(true);
    const row = (r as any).data.rows[0];
    expect(row.stage).toBe('reminder');
    expect(row.stageSource).toBe('auto');
    expect(row.scopeKey).toBe(scopeKeyOf('REL-1', 'Peerless', 'USD'));
    expect(row.totalOverdue).toBe(10000);
    expect((r as any).data.summary.reminder.count).toBe(1);
  });

  it('manual 钉住看板同口径合成：钉 legal + 账龄 reminder → 显示 legal', async () => {
    const prisma = makeMockPrisma({
      invoices: [makeInvoice()],
      profiles: [{ scopeKey: 'rel:REL-1:USD', stage: 'legal', stageSource: 'manual', stageSince: 1, autoStage: 'reminder' }],
    });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.listBoard();
    const row = (r as any).data.rows[0];
    expect(row.stage).toBe('legal');
    expect(row.stageSource).toBe('manual');
    expect((r as any).data.summary.legal.count).toBe(1);
  });

  it('P0-1 尾款喂入：末批逾期未结清（无逾期发票）→ 合成行保底 reminder + 尾款金额', async () => {
    const prisma = makeMockPrisma({
      invoices: [], // 无任何逾期发票（尾款未开票）
      batches: [{
        id: 'OSB__1', isFinalBatch: true, status: 'shipped', settleStatus: 'unsettled',
        finalPaymentDueDate: dateFromToday(-5), deletedAt: null,
        customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD',
        amount: 40000, paidAmount: 0,
      }],
    });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.listBoard();
    const row = (r as any).data.rows[0];
    expect(row.finalPaymentOverdue).toBe(true);
    expect(row.finalPaymentOutstanding).toBe(40000);
    expect(row.autoStage).toBe('reminder');
    expect(row.stage).toBe('reminder');
    expect((r as any).data.summary.reminder.amount).toBe(40000);
  });

  it('P0-1 尾款喂入：账龄行未逾期（仅 current）+ 末批逾期 → 该行保底 reminder', async () => {
    const prisma = makeMockPrisma({
      invoices: [makeInvoice({ dueDate: dateFromToday(30) })], // 未到期 → current 桶
      batches: [{
        id: 'OSB__1', isFinalBatch: true, status: 'shipped', settleStatus: 'partially_settled',
        finalPaymentDueDate: dateFromToday(-5), deletedAt: null,
        customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD',
        amount: 40000, paidAmount: 10000,
      }],
    });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.listBoard();
    const row = (r as any).data.rows[0];
    expect(row.autoStage).toBe('reminder'); // 尾款保底
    expect(row.finalPaymentOutstanding).toBe(30000);
    // 金额口径 = 逾期账款 0 + 逾期尾款 30000
    expect((r as any).data.summary.reminder.amount).toBe(30000);
  });

  it('★ B252 同一笔尾款已挂在逾期发票上 ⇒ 金额只算一遍（不再"账龄+尾款"各加一次）', async () => {
    // 现网形状（2026-09-27 实测 37/37 笔逾期尾款都是这一档）：
    //   发票 10,000 逾期 10 天；末批 10,000 未结清、到期日也过了；两者通过 InvoiceOrderAllocation 挂在同一张票上
    const prisma = makeMockPrisma({
      invoices: [makeInvoice({ amount: 10000, dueDate: dateFromToday(-10) })],
      batches: [{
        id: 'OSB__1', isFinalBatch: true, status: 'shipped', settleStatus: 'unsettled',
        finalPaymentDueDate: dateFromToday(-10), deletedAt: null,
        customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD',
        amount: 10000, paidAmount: 0,
      }],
      orderAllocations: [{ id: 'IOA__1', invoiceId: 'INV-1', batchId: 'OSB__1', orderId: 'ORD__1', allocatedAmount: 10000, deletedAt: null }],
    });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.listBoard();
    const row = (r as any).data.rows[0];
    expect(row.totalOverdue, '账龄逾期 10,000').toBe(10000);
    expect(row.finalPaymentOutstanding, '尾款列照旧展示这笔尾款（展示不是合计）').toBe(10000);
    expect(row.finalPaymentUncounted, '挂在逾期发票上的那部分不得再计一遍').toBe(0);
    expect(row.overdueAmount, '合计＝账龄逾期，不含重复的尾款').toBe(10000);
    expect((r as any).data.summary.reminder.amount, '★ 旧行为会把这里算成 20,000＝虚报一倍').toBe(10000);
  });

  it('★ B252 反面证人（去重不许把真债务也吞掉）：尾款只开了一部分票 ⇒ 未开票那部分仍要进合计', async () => {
    const prisma = makeMockPrisma({
      invoices: [makeInvoice({ amount: 15000, dueDate: dateFromToday(-10) })],
      batches: [{
        id: 'OSB__1', isFinalBatch: true, status: 'shipped', settleStatus: 'unsettled',
        finalPaymentDueDate: dateFromToday(-10), deletedAt: null,
        customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD',
        amount: 40000, paidAmount: 0,
      }],
      // 这张票只覆盖尾款里的 15,000，剩下 25,000 是真"未开票尾款"
      orderAllocations: [{ id: 'IOA__1', invoiceId: 'INV-1', batchId: 'OSB__1', orderId: 'ORD__1', allocatedAmount: 15000, deletedAt: null }],
    });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.listBoard();
    const row = (r as any).data.rows[0];
    expect(row.finalPaymentOutstanding).toBe(40000);
    expect(row.finalPaymentUncounted, '40,000 尾款里 15,000 已挂在逾期发票上 ⇒ 未计到的还有 25,000').toBe(25000);
    expect(row.overdueAmount).toBe(40000);
    expect((r as any).data.summary.reminder.amount, '真债务不能因为去重而消失').toBe(40000);
  });

  it('★ B252 附带收紧：末批金额为空 ⇒ 不假装"欠 0"，但那一行仍留在看板上（batchCount 照记）', async () => {
    const prisma = makeMockPrisma({
      invoices: [],
      batches: [{
        id: 'OSB__NULL', isFinalBatch: true, status: 'shipped', settleStatus: 'unsettled',
        finalPaymentDueDate: dateFromToday(-5), deletedAt: null,
        customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD',
        amount: null, paidAmount: null,      // schema 里这两列可空 ⇒ "还欠多少"算不出来
      }],
    });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.listBoard();
    const row = (r as any).data.rows[0];
    expect(row.finalPaymentOverdue, '这一批仍然要让财务看见（合成行不消失）').toBe(true);
    expect(row.finalPaymentOutstanding, '算不出金额时不得写成假 0 参与合计').toBe(0);
    expect(row.overdueAmount).toBe(0);
    expect((r as any).data.summary.reminder.amount).toBe(0);
    expect((r as any).data.summary.reminder.count, '行仍然占一格 ⇒ 计数不减').toBe(1);
  });

  it('末批未到期 / 已结清 / 已取消不喂入', async () => {
    const prisma = makeMockPrisma({
      invoices: [],
      batches: [
        { id: 'OSB__A', isFinalBatch: true, status: 'shipped', settleStatus: 'unsettled', finalPaymentDueDate: dateFromToday(5), deletedAt: null, customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD', amount: 100, paidAmount: 0 },
        { id: 'OSB__B', isFinalBatch: true, status: 'shipped', settleStatus: 'settled', finalPaymentDueDate: dateFromToday(-5), deletedAt: null, customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD', amount: 100, paidAmount: 100 },
        { id: 'OSB__C', isFinalBatch: true, status: 'cancelled', settleStatus: 'unsettled', finalPaymentDueDate: dateFromToday(-5), deletedAt: null, customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD', amount: 100, paidAmount: 0 },
      ],
    });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.listBoard();
    expect((r as any).data.rows).toHaveLength(0);
  });
});

describe('setStageManual 人工升降级（留痕）', () => {
  it('非法 stage / 升降级缺原因 → 400', async () => {
    const prisma = makeMockPrisma({ invoices: [makeInvoice()] });
    const svc = createDunningStageService(prisma as any);
    const bad = await svc.setStageManual({ customerName: 'Peerless', currency: 'USD', stage: 'soft', reason: 'x' });
    expect((bad as any).error.code).toBe('INVALID_STAGE');
    const noReason = await svc.setStageManual({ customerName: 'Peerless', currency: 'USD', stage: 'firm' });
    expect((noReason as any).error.code).toBe('REASON_REQUIRED');
    const noName = await svc.setStageManual({ currency: 'USD', stage: 'firm', reason: 'x' });
    expect((noName as any).error.code).toBe('CUSTOMER_NAME_REQUIRED');
  });

  it('升级钉住：profile 落库 manual + routeAudit 留痕（before/after/reason）', async () => {
    const prisma = makeMockPrisma({ invoices: [makeInvoice()] });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.setStageManual({
      customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD',
      stage: 'firm', reason: '客户长期失联，提前进入正式催款', actorId: 'user-1',
    });
    expect(r.ok).toBe(true);
    const profile = prisma._stores.profiles[0];
    expect(profile.stage).toBe('firm');
    expect(profile.stageSource).toBe('manual');
    expect(profile.escalatedAt).toBeTruthy();
    const log = prisma._stores.auditLogs[0];
    expect(log.action).toBe('set_dunning_stage');
    expect(log.targetType).toBe('DunningProfile');
    expect(log.actorId).toBe('user-1');
    expect(log.detail.after.reason).toBe('客户长期失联，提前进入正式催款');
  });

  it('解除钉住（stage=none）→ 回退账龄自动定级（auto 来源）', async () => {
    const prisma = makeMockPrisma({
      invoices: [makeInvoice()], // d1_30 → auto reminder
      profiles: [{ scopeKey: 'rel:REL-1:USD', stage: 'legal', stageSource: 'manual', stageSince: 1, autoStage: 'reminder' }],
    });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.setStageManual({
      customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD',
      stage: 'none', reason: '客户已提供还款计划', actorId: 'user-1',
    });
    expect(r.ok).toBe(true);
    const profile = prisma._stores.profiles[0];
    expect(profile.stage).toBe('reminder'); // 回退自动定级
    expect(profile.stageSource).toBe('auto');
    expect(profile.downgradedAt).toBeTruthy(); // legal→reminder 降级留痕
  });
});

describe('scanAndSync 主档同步（watchdog 写路径）', () => {
  it('首扫建档 → 账龄加深再扫 → 升级轨迹（reminder→urgent）', async () => {
    const prisma = makeMockPrisma({ invoices: [makeInvoice()] });
    const svc = createDunningStageService(prisma as any);

    // 首扫：none→reminder（建档 + 升级）
    const first = await svc.scanAndSync();
    expect(first.scanned).toBe(1);
    expect(first.escalated).toBe(1);
    expect(first.rows[0].to).toBe('reminder');
    expect(prisma._stores.profiles[0].stage).toBe('reminder');
    expect(prisma._stores.profiles[0].lastScanAt).toBeTruthy();

    // 账龄加深至 70 天（d61_90）→ reminder→urgent
    prisma._stores.invoices[0].dueDate = dateFromToday(-70);
    const second = await svc.scanAndSync();
    expect(second.escalated).toBe(1);
    expect(second.rows[0]).toMatchObject({ from: 'reminder', to: 'urgent' });
    expect(prisma._stores.profiles[0].stage).toBe('urgent');
    expect(prisma._stores.profiles[0].stageSince).toBeTruthy();

    // 幂等：无变化再扫 → 0 升级
    const third = await svc.scanAndSync();
    expect(third.escalated).toBe(0);
  });

  it('manual 钉住期间 auto 升级穿透并计入升级轨迹', async () => {
    const prisma = makeMockPrisma({ invoices: [makeInvoice()] });
    const svc = createDunningStageService(prisma as any);
    await svc.scanAndSync(); // 建档 reminder
    // 人工降级钉住 reminder（客户承诺还款）
    await svc.setStageManual({ customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD', stage: 'reminder', reason: '承诺月底还款' });
    // 账龄烂到 100 天（d90plus → legal）→ auto 穿透人工钉住
    prisma._stores.invoices[0].dueDate = dateFromToday(-100);
    const r = await svc.scanAndSync();
    expect(r.escalated).toBe(1);
    expect(r.rows[0].to).toBe('legal');
    expect(prisma._stores.profiles[0].stage).toBe('legal');
    expect(prisma._stores.profiles[0].stageSource).toBe('auto');
  });
});

// ────────────────────────────────────────────────────────────────────
// ★ G3 · 尾款到期日**无法判定**的末批：必须可见，但不得被算成逾期
//   （G3.1/G3.4「拿不到数就明说，绝不静默给 0 / 悄悄消失」+ 本文件既有原则
//    「债务真实存在，不能从看板消失」）
// ────────────────────────────────────────────────────────────────────
describe('G3 · 到期日无法判定的尾款（paymentTerms 解析不出账期 → dueDate=null）', () => {
  const unresolvedBatch = {
    id: 'OSB__U1', isFinalBatch: true, status: 'shipped', settleStatus: 'unsettled',
    finalPaymentDueDate: null, deletedAt: null,
    customerRelationId: 'REL-1', customerName: 'Peerless', currency: 'USD',
    amount: 50000, paidAmount: 0,
  };

  it('★ 可见但不定级：待核桶里有它，而逾期金额与分级**一分不被污染**（带对照行，断言可失败）', async () => {
    const prisma = makeMockPrisma({
      // 对照行：一张真实逾期 10 天的发票（10000 USD，d1_30 → reminder）⇒ rows 非空、summary 非零
      invoices: [makeInvoice()],
      batches: [unresolvedBatch],
    });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.listBoard();
    const list = (r as any).data.unresolvedFinalPayments;
    expect(list, '到期日未知的末批不得从看板静默消失').toHaveLength(1);
    expect(list[0]).toMatchObject({
      scopeKey: 'rel:REL-1:USD', customerRelationId: 'REL-1', currency: 'USD',
      outstanding: 50000, batchCount: 1,
    });
    const row = (r as any).data.rows[0];
    expect(row.finalPaymentOverdue, '待核桶不得被当成"尾款逾期"喂进分级').toBe(false);
    expect(row.finalPaymentOutstanding).toBe(0);
    // ★ 这条才是关键：50000 一旦混进逾期合计就会对按时付款的客户发催款函
    expect(row.totalOverdue, '账龄逾期额只含真实逾期发票').toBe(10000);
    expect((r as any).data.summary.reminder.amount, '分级金额不得含待核的 50000').toBe(10000);
    expect((r as any).data.summary.reminder.count).toBe(1);
  });

  it('★ 文案纪律：必须给出可执行下一步，且**不得承诺系统做不到的动作**（复核抓到原版写"补录"而无入口）', async () => {
    const prisma = makeMockPrisma({ invoices: [], batches: [unresolvedBatch] });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.listBoard();
    const reason = String((r as any).data.unresolvedFinalPayments[0].reason);
    expect(reason, '须明说系统不会自动催').toMatch(/不会自动催/);
    expect(reason, '须给人工跟进的下一步').toMatch(/人工/);
    // 反向：当前 updateBatch 无 finalPaymentDueDate 入参、改 days 不重算、已发运不可重发 ⇒ 任何"系统内可自助补"的措辞都是假结论
    expect(reason, '不得承诺系统内不存在的动作').not.toMatch(/补录|重试即可|请在系统内|修改到期日/);
  });

  it('★ 与真逾期尾款互不污染：同客户两批，一条有到期日一条没有', async () => {
    const prisma = makeMockPrisma({
      invoices: [],
      batches: [
        { ...unresolvedBatch, id: 'OSB__U1', amount: 50000 },
        { ...unresolvedBatch, id: 'OSB__D1', finalPaymentDueDate: dateFromToday(-5), amount: 40000 },
      ],
    });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.listBoard();
    const row = (r as any).data.rows[0];
    expect(row.finalPaymentOverdue).toBe(true);
    expect(row.finalPaymentOutstanding, '逾期额只含已知到期的那笔').toBe(40000);
    expect(row.autoStage).toBe('reminder');
    const list = (r as any).data.unresolvedFinalPayments;
    expect(list).toHaveLength(1);
    expect(list[0].outstanding).toBe(50000);
    expect(list[0].batchCount).toBe(1);
  });

  it('不误伤：已结清 / 未发运 / 非末批 的空到期日不进待核桶', async () => {
    const prisma = makeMockPrisma({
      invoices: [],
      batches: [
        { ...unresolvedBatch, id: 'A', settleStatus: 'settled' },
        { ...unresolvedBatch, id: 'B', status: 'cancelled' },
        { ...unresolvedBatch, id: 'C', isFinalBatch: false },
        { ...unresolvedBatch, id: 'D', deletedAt: dateFromToday(-1) },
      ],
    });
    const svc = createDunningStageService(prisma as any);
    const r = await svc.listBoard();
    expect((r as any).data.unresolvedFinalPayments).toHaveLength(0);
    expect((r as any).data.rows).toHaveLength(0);
  });
});
