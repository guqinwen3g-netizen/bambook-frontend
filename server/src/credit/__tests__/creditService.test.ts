import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  createCreditService,
  CREDIT_ERRORS,
  SYSTEM_CREDIT_ACTOR,
  OVERDUE_FREEZE_THRESHOLD_DAYS,
} from '../creditService';

/**
 * 信用控制域统一信用服务测试（Track F）：
 *   人工冻结/解冻（理由必填 / 状态机 409 / 历史+审计留痕）
 *   reserve/release 占用释放（floor 0 / 无额度跳过不报错）
 *   checkCreditAvailable 门禁（Frozen/Revoked/Net61+ 逾期兜底 / 超额提示）
 *   60 天逾期自动冻结（阈值边界 / 幂等 / lastAutoScanDate 标记）
 *   逾期款全额核销自动解冻（仅系统自动冻结额度；人工冻结不被自动解冻）
 *   getCreditHistory 时间线
 *
 * 固定今天：2026-08-10（本地零点）
 */

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const TODAY = new Date(2026, 7, 10);

function makeCreditLimit(overrides: Record<string, any> = {}) {
  return {
    id: 'CL_1',
    relationId: 'REL_A',
    totalLimit: 800000,
    usedAmount: 120000,
    currency: 'CNY',
    status: 'Active',
    frozenAt: null,
    frozenBy: null,
    thawedReason: null,
    lastAutoScanDate: null,
    deletedAt: null,
    createdAt: BigInt(1),
    ...overrides,
  };
}

function makeInvoice(overrides: Record<string, any> = {}) {
  return {
    id: 'INV_1',
    customerRelationId: 'REL_A',
    // ★ 必须有 amount：「未结清应收」判据含 `amount > 0` 守卫
    //   （shared/openReceivable）。缺这个字段 → hasOpenAmount(undefined)=false
    //   → 该票被当成「不欠钱」跳过 → maxOverdueDays=0 → 冻结类断言全红。
    //   2026-09-17 踩过：新增一次字段读会打穿所有「mock 不完整」的既有测试。
    amount: '1000',
    dueDate: '2026-06-06', // 65 天逾期（以 TODAY 2026-08-10 计）
    issueDate: '2026-05-01',
    ...overrides,
  };
}

function makePrisma(opts: {
  creditLimits?: any[];
  invoices?: any[];
  history?: any[];
} = {}) {
  const creditLimits = opts.creditLimits ?? [];
  const invoices = opts.invoices ?? [];
  const history = opts.history ?? [];

  const calls = {
    clUpdate: vi.fn(async ({ where, data }: any) => ({ ...creditLimits.find((c) => c.id === where.id), ...data })),
    clUpdateMany: vi.fn(async () => ({ count: creditLimits.length })),
    historyCreate: vi.fn(async ({ data }: any) => data),
    auditCreate: vi.fn(async () => ({ id: 'AL-1' })),
  };

  const matchWhere = (cl: any, where: any) => {
    if (where.relationId && cl.relationId !== where.relationId) return false;
    if (where.relationId?.in && !where.relationId.in.includes(cl.relationId)) return false;
    if (where.status && cl.status !== where.status) return false;
    if (where.frozenBy && cl.frozenBy !== where.frozenBy) return false;
    if ('deletedAt' in where && where.deletedAt === null && cl.deletedAt !== null) return false;
    return true;
  };

  const prisma: any = {
    creditLimit: {
      findMany: vi.fn(async ({ where, select }: any = {}) => {
        const rows = creditLimits.filter((cl) => matchWhere(cl, where ?? {}));
        if (select) return rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, (r as any)[k]])));
        return rows;
      }),
      findFirst: vi.fn(async ({ where }: any) => creditLimits.find((cl) => matchWhere(cl, where ?? {})) ?? null),
      update: calls.clUpdate,
      updateMany: calls.clUpdateMany,
    },
    creditLimitHistory: {
      create: calls.historyCreate,
      findMany: vi.fn(async ({ where }: any) => history.filter((h) => !where?.relationId || h.relationId === where.relationId)),
      count: vi.fn(async ({ where }: any) => history.filter((h) => !where?.relationId || h.relationId === where.relationId).length),
    },
    invoice: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        // 支持两种查询：全量扫描（无 customerRelationId）与按客户过滤
        if (where?.customerRelationId) return invoices.filter((i) => i.customerRelationId === where.customerRelationId);
        return invoices;
      }),
    },
    auditLog: { create: calls.auditCreate },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, calls };
}

beforeEach(() => vi.clearAllMocks());

// ══════════════════════════════════════════════════════════════════
// 人工冻结
// ══════════════════════════════════════════════════════════════════
describe('freezeCredit 人工冻结', () => {
  it('Active → Frozen：frozenAt/frozenBy 写入 + CreditLimitHistory(credit_freeze, delta=0) + AuditLog', async () => {
    const { prisma, calls } = makePrisma({ creditLimits: [makeCreditLimit()] });
    const svc = createCreditService({ prisma });
    const res = await svc.freezeCredit({ relationId: 'REL_A', reason: '客户涉诉，法务要求暂停授信', actorId: 'u_fin' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.frozen).toEqual(['CL_1']);
    const update = calls.clUpdate.mock.calls[0][0];
    expect(update.data.status).toBe('Frozen');
    expect(update.data.frozenAt).toBeInstanceOf(Date);
    expect(update.data.frozenBy).toBe('u_fin');
    const hist = calls.historyCreate.mock.calls[0][0].data;
    expect(hist.triggerType).toBe('credit_freeze');
    expect(hist.triggerBy).toBe('u_fin');
    expect(hist.delta).toBe(0); // 冻结不改变占用
    expect(hist.beforeUsedAmount).toBe(120000);
    expect(hist.remark).toContain('客户涉诉');
    expect(calls.auditCreate).toHaveBeenCalledTimes(1);
    expect(calls.auditCreate.mock.calls[0][0].data.action).toBe('credit_freeze');
  });

  it('理由缺失 → 400 CREDIT_REASON_REQUIRED（审计强制）', async () => {
    const { prisma } = makePrisma({ creditLimits: [makeCreditLimit()] });
    const svc = createCreditService({ prisma });
    const res = await svc.freezeCredit({ relationId: 'REL_A', reason: '  ', actorId: 'u_fin' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe(CREDIT_ERRORS.CREDIT_REASON_REQUIRED);
    expect(res.error.statusCode).toBe(400);
  });

  it('已 Frozen → 409 CREDIT_ALREADY_FROZEN（防重复冻结）', async () => {
    const { prisma } = makePrisma({ creditLimits: [makeCreditLimit({ status: 'Frozen' })] });
    const svc = createCreditService({ prisma });
    const res = await svc.freezeCredit({ relationId: 'REL_A', reason: '重复冻结测试用理由', actorId: 'u_fin' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe(CREDIT_ERRORS.CREDIT_ALREADY_FROZEN);
    expect(res.error.statusCode).toBe(409);
  });

  it('无任何额度 → 404 CREDIT_LIMIT_NOT_FOUND', async () => {
    const { prisma } = makePrisma();
    const svc = createCreditService({ prisma });
    const res = await svc.freezeCredit({ relationId: 'REL_NONE', reason: '无额度冻结测试理由', actorId: 'u_fin' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe(CREDIT_ERRORS.CREDIT_LIMIT_NOT_FOUND);
    expect(res.error.statusCode).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
// 手动解冻（路径①）
// ══════════════════════════════════════════════════════════════════
describe('thawCredit 主管手动解冻（路径①）', () => {
  it('Frozen → Active：thawedReason 记录 + 历史 credit_thaw + 审计', async () => {
    const { prisma, calls } = makePrisma({
      creditLimits: [makeCreditLimit({ status: 'Frozen', frozenBy: 'u_fin', frozenAt: new Date(2026, 7, 1) })],
    });
    const svc = createCreditService({ prisma });
    const res = await svc.thawCredit({ relationId: 'REL_A', reason: '客户已支付全部逾期款并特批恢复', actorId: 'u_fin_mgr' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.thawed).toEqual(['CL_1']);
    const update = calls.clUpdate.mock.calls[0][0];
    expect(update.data.status).toBe('Active');
    expect(update.data.thawedReason).toContain('特批恢复');
    const hist = calls.historyCreate.mock.calls[0][0].data;
    expect(hist.triggerType).toBe('credit_thaw');
    expect(hist.triggerBy).toBe('u_fin_mgr');
    expect(calls.auditCreate.mock.calls[0][0].data.action).toBe('credit_thaw');
  });

  it('理由缺失 → 400 CREDIT_REASON_REQUIRED', async () => {
    const { prisma } = makePrisma({ creditLimits: [makeCreditLimit({ status: 'Frozen' })] });
    const svc = createCreditService({ prisma });
    const res = await svc.thawCredit({ relationId: 'REL_A', reason: '', actorId: 'u_fin_mgr' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe(CREDIT_ERRORS.CREDIT_REASON_REQUIRED);
  });

  it('未冻结（Active）→ 409 CREDIT_NOT_FROZEN', async () => {
    const { prisma } = makePrisma({ creditLimits: [makeCreditLimit()] });
    const svc = createCreditService({ prisma });
    const res = await svc.thawCredit({ relationId: 'REL_A', reason: '未冻结解冻测试理由', actorId: 'u_fin_mgr' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe(CREDIT_ERRORS.CREDIT_NOT_FROZEN);
    expect(res.error.statusCode).toBe(409);
  });
});

// ══════════════════════════════════════════════════════════════════
// reserve / release 占用释放统一入口
// ══════════════════════════════════════════════════════════════════
describe('reserveCredit / releaseCredit 占用释放', () => {
  it('reserveCredit：usedAmount +amount + 历史 delta 为正（triggerType 透传）', async () => {
    const { prisma, calls } = makePrisma({ creditLimits: [makeCreditLimit()] });
    const svc = createCreditService({ prisma });
    const res = await svc.reserveCredit({
      relationId: 'REL_A', amount: 30000,
      triggerType: 'order_confirm', triggerId: 'ORD_1', triggerBy: 'system_test', remark: '订单确认预占',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.adjusted).toBe(true);
    expect(res.data.before).toBe(120000);
    expect(res.data.after).toBe(150000);
    // 原子化收口：CAS 条件自增（where 携带 usedAmount 快照，data 用 increment 而非绝对值）
    const cas = calls.clUpdateMany.mock.calls[0][0];
    expect(cas.where).toMatchObject({ id: 'CL_1', status: 'Active', deletedAt: null, usedAmount: 120000 });
    expect(cas.data.usedAmount).toEqual({ increment: 30000 });
    const hist = calls.historyCreate.mock.calls[0][0].data;
    expect(hist.delta).toBe(30000);
    expect(hist.triggerType).toBe('order_confirm');
    expect(hist.triggerId).toBe('ORD_1');
  });

  it('releaseCredit：usedAmount -amount + 历史 delta 为负；释放超余额 floor 0', async () => {
    const { prisma, calls } = makePrisma({ creditLimits: [makeCreditLimit({ usedAmount: 20000 })] });
    const svc = createCreditService({ prisma });
    const res = await svc.releaseCredit({
      relationId: 'REL_A', amount: 50000,
      triggerType: 'order_cancel', triggerId: 'ORD_2', triggerBy: 'system_test',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.after).toBe(0); // floor 0
    const hist = calls.historyCreate.mock.calls[0][0].data;
    expect(hist.delta).toBe(-20000);
    expect(hist.afterUsedAmount).toBe(0);
  });

  it('无 Active 额度 → adjusted=false 跳过不报错（与既有联动语义一致）', async () => {
    const { prisma, calls } = makePrisma({ creditLimits: [makeCreditLimit({ status: 'Frozen' })] });
    const svc = createCreditService({ prisma });
    const res = await svc.reserveCredit({ relationId: 'REL_A', amount: 1000, triggerType: 'order_confirm' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.adjusted).toBe(false);
    expect(calls.historyCreate).not.toHaveBeenCalled();
  });

  it('非法金额（0 / 负数 / NaN）→ 400 INVALID_AMOUNT', async () => {
    const { prisma } = makePrisma({ creditLimits: [makeCreditLimit()] });
    const svc = createCreditService({ prisma });
    for (const amount of [0, -5, NaN]) {
      const res = await svc.reserveCredit({ relationId: 'REL_A', amount, triggerType: 'order_confirm' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe(CREDIT_ERRORS.INVALID_AMOUNT);
    }
  });

  it('支持外部 tx（orderChanges 事务内接线）：tx 传入时直接用 tx 写', async () => {
    const { prisma } = makePrisma({ creditLimits: [makeCreditLimit()] });
    const svc = createCreditService({ prisma });
    const txHistoryCreate = vi.fn(async ({ data }: any) => data);
    const tx: any = {
      creditLimit: {
        findFirst: vi.fn(async () => makeCreditLimit()),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      creditLimitHistory: { create: txHistoryCreate },
    };
    const res = await svc.reserveCredit({ relationId: 'REL_A', amount: 100, triggerType: 'order_change_customer', tx });
    expect(res.ok).toBe(true);
    expect(txHistoryCreate).toHaveBeenCalledTimes(1);
    expect(prisma.creditLimitHistory.create).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════
// shiftUsedAmount 并发回归（GAP 收口：CAS 原子自增）
// ══════════════════════════════════════════════════════════════════
describe('shiftUsedAmount CAS 并发回归', () => {
  it('首次 CAS count=0（快照被并发事务推进）→ 重读新快照二次 CAS 成功，before/after 取新快照', async () => {
    const { prisma, calls } = makePrisma({ creditLimits: [makeCreditLimit()] });
    // 第一次读 120000（陈旧快照），并发事务已推进到 135000 → 第二次读新快照
    prisma.creditLimit.findFirst
      .mockResolvedValueOnce(makeCreditLimit({ usedAmount: 120000 }))
      .mockResolvedValueOnce(makeCreditLimit({ usedAmount: 135000 }));
    calls.clUpdateMany
      .mockResolvedValueOnce({ count: 0 }) // 陈旧快照 CAS 失败
      .mockResolvedValueOnce({ count: 1 }); // 新快照 CAS 成功
    const svc = createCreditService({ prisma });
    const res = await svc.reserveCredit({ relationId: 'REL_A', amount: 30000, triggerType: 'order_confirm' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 结果取 CAS 成功时的新快照，丢更新被重试兜住
    expect(res.data.before).toBe(135000);
    expect(res.data.after).toBe(165000);
    expect(prisma.creditLimit.findFirst).toHaveBeenCalledTimes(2);
    expect(calls.clUpdateMany).toHaveBeenCalledTimes(2);
    // 第二次 CAS 的 where 快照必须是重读后的 135000，而非陈旧的 120000
    expect(calls.clUpdateMany.mock.calls[1][0].where.usedAmount).toBe(135000);
    expect(calls.clUpdateMany.mock.calls[1][0].data.usedAmount).toEqual({ increment: 30000 });
    // 历史留痕与新快照一致（delta 为真实落库增量）
    const hist = calls.historyCreate.mock.calls[0][0].data;
    expect(hist.beforeUsedAmount).toBe(135000);
    expect(hist.afterUsedAmount).toBe(165000);
    expect(hist.delta).toBe(30000);
  });

  it('CAS 持续冲突达上限（5 次）→ fail-closed CREDIT_WRITE_FAILED，不写历史', async () => {
    const { prisma, calls } = makePrisma({ creditLimits: [makeCreditLimit()] });
    calls.clUpdateMany.mockResolvedValue({ count: 0 }); // 永远冲突
    const svc = createCreditService({ prisma });
    const res = await svc.reserveCredit({ relationId: 'REL_A', amount: 30000, triggerType: 'order_confirm' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe(CREDIT_ERRORS.CREDIT_WRITE_FAILED);
    expect(res.error.statusCode).toBe(500);
    expect(res.error.message).toContain('并发冲突');
    // 重试上限 5 次（每次循环一次 findFirst + 一次 updateMany）
    expect(prisma.creditLimit.findFirst).toHaveBeenCalledTimes(5);
    expect(calls.clUpdateMany).toHaveBeenCalledTimes(5);
    // 未成功落库 → 不得写历史（append-only 账本不出现 phantom 行）
    expect(calls.historyCreate).not.toHaveBeenCalled();
  });

  it('并发释放超余额：重读后快照被其他释放事务压低 → appliedDelta 按新快照 floor 0 收敛', async () => {
    const { prisma, calls } = makePrisma({ creditLimits: [makeCreditLimit({ usedAmount: 20000 })] });
    // 第一次读 20000；并发释放事务已把 usedAmount 压到 5000 → 第二次读 5000
    prisma.creditLimit.findFirst
      .mockResolvedValueOnce(makeCreditLimit({ usedAmount: 20000 }))
      .mockResolvedValueOnce(makeCreditLimit({ usedAmount: 5000 }));
    calls.clUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const svc = createCreditService({ prisma });
    const res = await svc.releaseCredit({ relationId: 'REL_A', amount: 50000, triggerType: 'order_cancel' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.before).toBe(5000);
    expect(res.data.after).toBe(0); // floor 0
    // appliedDelta = -5000（按新快照收敛），而非首次陈旧快照的 -20000
    expect(calls.clUpdateMany.mock.calls[1][0].data.usedAmount).toEqual({ increment: -5000 });
    const hist = calls.historyCreate.mock.calls[0][0].data;
    expect(hist.delta).toBe(-5000);
    expect(hist.afterUsedAmount).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// checkCreditAvailable 门禁
// ══════════════════════════════════════════════════════════════════
describe('checkCreditAvailable 订单门禁', () => {
  it('Frozen → blocked + CREDIT_FROZEN_60_DAYS + creditFrozen=true', async () => {
    const { prisma } = makePrisma({ creditLimits: [makeCreditLimit({ status: 'Frozen' })] });
    const svc = createCreditService({ prisma });
    const res = await svc.checkCreditAvailable({ relationId: 'REL_A', today: TODAY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.blocked).toBe(true);
    expect(res.data.blockCode).toBe('CREDIT_FROZEN_60_DAYS');
    expect(res.data.creditFrozen).toBe(true);
  });

  it('Revoked → blocked + CREDIT_REVOKED', async () => {
    const { prisma } = makePrisma({ creditLimits: [makeCreditLimit({ status: 'Revoked' })] });
    const svc = createCreditService({ prisma });
    const res = await svc.checkCreditAvailable({ relationId: 'REL_A', today: TODAY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.blocked).toBe(true);
    expect(res.data.blockCode).toBe('CREDIT_REVOKED');
  });

  it('Active 但存在 Net61+ 未结清逾期（调度遗漏兜底）→ blocked + OVERDUE_60_DAYS', async () => {
    const { prisma } = makePrisma({
      creditLimits: [makeCreditLimit()],
      invoices: [makeInvoice({ dueDate: '2026-06-06' })], // 65 天
    });
    const svc = createCreditService({ prisma });
    const res = await svc.checkCreditAvailable({ relationId: 'REL_A', today: TODAY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.blocked).toBe(true);
    expect(res.data.blockCode).toBe('OVERDUE_60_DAYS');
    expect(res.data.maxOverdueDays).toBe(65);
  });

  it('Active 且无逾期 → 不阻断；amount 超额 → wouldExceedLimit=true（提示不伪造阻断）', async () => {
    const { prisma } = makePrisma({ creditLimits: [makeCreditLimit()] });
    const svc = createCreditService({ prisma });
    const res = await svc.checkCreditAvailable({ relationId: 'REL_A', amount: 700000, today: TODAY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.blocked).toBe(false);
    expect(res.data.wouldExceedLimit).toBe(true); // 120000+700000 > 800000
    expect(res.data.remaining).toBe(680000);
  });

  it('无信用额度客户 → hasCreditLimit=false，不阻断（现金/小单场景，§6 #6）', async () => {
    const { prisma } = makePrisma();
    const svc = createCreditService({ prisma });
    const res = await svc.checkCreditAvailable({ relationId: 'REL_NONE', today: TODAY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.hasCreditLimit).toBe(false);
    expect(res.data.blocked).toBe(false);
    expect(res.data.creditFrozen).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 规则① 60 天逾期自动冻结
// ══════════════════════════════════════════════════════════════════
describe('runAutoFreezeScan 60 天逾期自动冻结', () => {
  it('逾期 65 天（Net61+）→ Active 自动冻结 + frozenBy=system + 历史 + 审计 + lastAutoScanDate', async () => {
    const { prisma, calls } = makePrisma({
      creditLimits: [makeCreditLimit()],
      invoices: [makeInvoice({ dueDate: '2026-06-06' })],
    });
    const svc = createCreditService({ prisma });
    const res = await svc.runAutoFreezeScan({ today: TODAY });
    expect(res.frozenCount).toBe(1);
    expect(res.frozen[0]).toMatchObject({ relationId: 'REL_A', creditLimitId: 'CL_1', maxOverdueDays: 65 });
    const update = calls.clUpdate.mock.calls[0][0];
    expect(update.data.status).toBe('Frozen');
    expect(update.data.frozenBy).toBe(SYSTEM_CREDIT_ACTOR);
    expect(update.data.frozenAt).toBeInstanceOf(Date);
    expect(update.data.lastAutoScanDate).toBeInstanceOf(Date);
    const hist = calls.historyCreate.mock.calls[0][0].data;
    expect(hist.triggerType).toBe('credit_freeze');
    expect(hist.triggerBy).toBe(SYSTEM_CREDIT_ACTOR);
    expect(hist.remark).toContain('65 天');
    expect(calls.auditCreate.mock.calls[0][0].data.action).toBe('credit:60d-overdue-freeze');
    // lastAutoScanDate 巡检标记（updateMany 覆盖评估到的客户）
    expect(calls.clUpdateMany).toHaveBeenCalledTimes(1);
    expect(calls.clUpdateMany.mock.calls[0][0].data.lastAutoScanDate).toBeInstanceOf(Date);
  });

  it('阈值边界：逾期恰好 60 天不冻结（Net61+ 桶口径，>60 才冻结）；61 天冻结', async () => {
    const d60 = makePrisma({
      creditLimits: [makeCreditLimit()],
      invoices: [makeInvoice({ dueDate: '2026-06-11' })], // 恰好 60 天
    });
    const svc60 = createCreditService({ prisma: d60.prisma });
    const res60 = await svc60.runAutoFreezeScan({ today: TODAY });
    expect(res60.frozenCount).toBe(0);
    expect(OVERDUE_FREEZE_THRESHOLD_DAYS).toBe(60);

    const d61 = makePrisma({
      creditLimits: [makeCreditLimit()],
      invoices: [makeInvoice({ dueDate: '2026-06-10' })], // 61 天
    });
    const svc61 = createCreditService({ prisma: d61.prisma });
    const res61 = await svc61.runAutoFreezeScan({ today: TODAY });
    expect(res61.frozenCount).toBe(1);
  });

  it('逾期 30 天（Net0-30 桶）→ 不冻结', async () => {
    const { prisma } = makePrisma({
      creditLimits: [makeCreditLimit()],
      invoices: [makeInvoice({ dueDate: '2026-07-11' })], // 30 天
    });
    const svc = createCreditService({ prisma });
    const res = await svc.runAutoFreezeScan({ today: TODAY });
    expect(res.frozenCount).toBe(0);
  });

  it('幂等：已 Frozen 客户再次扫描 → frozenCount=0，不重复写历史/审计', async () => {
    const { prisma, calls } = makePrisma({
      creditLimits: [makeCreditLimit({ status: 'Frozen', frozenBy: SYSTEM_CREDIT_ACTOR })],
      invoices: [makeInvoice({ dueDate: '2026-06-06' })],
    });
    const svc = createCreditService({ prisma });
    const res = await svc.runAutoFreezeScan({ today: TODAY });
    expect(res.frozenCount).toBe(0);
    expect(calls.historyCreate).not.toHaveBeenCalled();
    expect(calls.auditCreate).not.toHaveBeenCalled();
    // 但仍更新巡检标记
    expect(calls.clUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('dueDate 缺失 → Net 30 推定（issueDate 2026-05-12 + 30d = 2026-06-11，逾期 60 天不冻结；05-11 → 61 天冻结）', async () => {
    const estimated60 = makePrisma({
      creditLimits: [makeCreditLimit()],
      invoices: [makeInvoice({ dueDate: null, issueDate: '2026-05-12' })],
    });
    expect(await createCreditService({ prisma: estimated60.prisma }).runAutoFreezeScan({ today: TODAY }))
      .toMatchObject({ frozenCount: 0 });

    const estimated61 = makePrisma({
      creditLimits: [makeCreditLimit()],
      invoices: [makeInvoice({ dueDate: null, issueDate: '2026-05-11' })],
    });
    expect(await createCreditService({ prisma: estimated61.prisma }).runAutoFreezeScan({ today: TODAY }))
      .toMatchObject({ frozenCount: 1 });
  });

  it('无 customerRelationId 的发票无法归属客户 → 跳过冻结', async () => {
    const { prisma } = makePrisma({
      creditLimits: [makeCreditLimit()],
      invoices: [makeInvoice({ customerRelationId: null, dueDate: '2026-01-01' })],
    });
    const svc = createCreditService({ prisma });
    const res = await svc.runAutoFreezeScan({ today: TODAY });
    expect(res.frozenCount).toBe(0);
    expect(res.evaluatedRelations).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// 解冻路径② 逾期款全额核销自动解冻
// ══════════════════════════════════════════════════════════════════
describe('自动解冻（路径②：逾期款全额核销）', () => {
  it('runAutoThawScan：系统自动冻结客户逾期发票已结清（无 open 发票）→ 自动解冻 + thawedReason', async () => {
    const { prisma, calls } = makePrisma({
      creditLimits: [makeCreditLimit({ status: 'Frozen', frozenBy: SYSTEM_CREDIT_ACTOR, frozenAt: new Date(2026, 7, 1) })],
      invoices: [], // 逾期款已全额核销（Paid 发票不在 open 扫描口径内）
    });
    const svc = createCreditService({ prisma });
    const res = await svc.runAutoThawScan({ today: TODAY });
    expect(res.thawedCount).toBe(1);
    expect(res.thawed[0]).toEqual({ relationId: 'REL_A', creditLimitIds: ['CL_1'] });
    const update = calls.clUpdate.mock.calls[0][0];
    expect(update.data.status).toBe('Active');
    expect(update.data.thawedReason).toContain('全额核销');
    const hist = calls.historyCreate.mock.calls[0][0].data;
    expect(hist.triggerType).toBe('credit_thaw');
    expect(hist.triggerBy).toBe(SYSTEM_CREDIT_ACTOR);
    expect(calls.auditCreate.mock.calls[0][0].data.action).toBe('credit_auto_thaw_settled');
  });

  it('runAutoThawScan：仍有 Net61+ 逾期 → 不解冻', async () => {
    const { prisma } = makePrisma({
      creditLimits: [makeCreditLimit({ status: 'Frozen', frozenBy: SYSTEM_CREDIT_ACTOR })],
      invoices: [makeInvoice({ dueDate: '2026-06-06' })], // 65 天仍未结清
    });
    const svc = createCreditService({ prisma });
    const res = await svc.runAutoThawScan({ today: TODAY });
    expect(res.thawedCount).toBe(0);
  });

  it('runAutoThawScan：人工冻结（frozenBy=userId）→ 不被自动解冻（人工合规判断不被系统覆盖）', async () => {
    const { prisma } = makePrisma({
      creditLimits: [makeCreditLimit({ status: 'Frozen', frozenBy: 'u_fin' })],
      invoices: [],
    });
    const svc = createCreditService({ prisma });
    const res = await svc.runAutoThawScan({ today: TODAY });
    expect(res.evaluatedFrozen).toBe(0);
    expect(res.thawedCount).toBe(0);
  });

  it('autoThawIfSettled（核销域接口点）：单客户触发，已结清 → 解冻；未结清 → stillOverdueDays 回传', async () => {
    const settled = makePrisma({
      creditLimits: [makeCreditLimit({ status: 'Frozen', frozenBy: SYSTEM_CREDIT_ACTOR })],
      invoices: [],
    });
    const res1 = await createCreditService({ prisma: settled.prisma })
      .autoThawIfSettled({ relationId: 'REL_A', today: TODAY, triggerId: 'ALLOC_1' });
    expect(res1.thawed).toBe(true);
    expect(res1.thawedIds).toEqual(['CL_1']);
    // triggerId 透传到历史留痕
    expect(settled.calls.historyCreate.mock.calls[0][0].data.triggerId).toBe('ALLOC_1');

    const unsettled = makePrisma({
      creditLimits: [makeCreditLimit({ status: 'Frozen', frozenBy: SYSTEM_CREDIT_ACTOR })],
      invoices: [makeInvoice({ dueDate: '2026-06-06' })],
    });
    const res2 = await createCreditService({ prisma: unsettled.prisma })
      .autoThawIfSettled({ relationId: 'REL_A', today: TODAY });
    expect(res2.thawed).toBe(false);
    expect(res2.stillOverdueDays).toBe(65);
  });
});

// ══════════════════════════════════════════════════════════════════
// getCreditHistory 时间线
// ══════════════════════════════════════════════════════════════════
describe('getCreditHistory 历史时间线', () => {
  it('按 relationId 返回全事件（冻结/解冻/占用/释放）倒序 + total', async () => {
    const history = [
      { id: 'H4', relationId: 'REL_A', triggerType: 'credit_thaw', delta: 0 },
      { id: 'H3', relationId: 'REL_A', triggerType: 'credit_freeze', delta: 0 },
      { id: 'H2', relationId: 'REL_A', triggerType: 'order_confirm', delta: 50000 },
      { id: 'H1', relationId: 'REL_B', triggerType: 'order_confirm', delta: 10000 },
    ];
    const { prisma } = makePrisma({ history });
    const svc = createCreditService({ prisma });
    const res = await svc.getCreditHistory({ relationId: 'REL_A' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.total).toBe(3);
    expect(res.data.items.map((h: any) => h.id)).toEqual(['H4', 'H3', 'H2']);
    const where = prisma.creditLimitHistory.findMany.mock.calls[0][0];
    expect(where.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('relationId 缺失 → 400 RELATION_REQUIRED', async () => {
    const { prisma } = makePrisma();
    const svc = createCreditService({ prisma });
    const res = await svc.getCreditHistory({ relationId: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(CREDIT_ERRORS.RELATION_REQUIRED);
  });
});
