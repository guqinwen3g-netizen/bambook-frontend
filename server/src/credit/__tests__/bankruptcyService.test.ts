/**
 * REQ2-15 客户破产货权处置回归测试（设计文档 §7 验收锚点）
 *
 * 覆盖：
 *   1. 开案：declare 首动作 + 同客户唯一活跃案件 409 + 信用冻结 best-effort 联动
 *   2. 动作追加：四类动作 append-only + 实时汇总 + closed 案件 409 + 枚举校验
 *   3. 净损失计算：申报 − 转卖回收 − 回款 + 退运成本
 *   4. 闭案：终态 + close 动作 + 汇总结论落 closeNote + 二次闭案/追加 409
 *   5. 时间线：append-only 正序（declare → … → close 全程留痕）
 *   6. 输入校验（日期格式 / 负金额 / 不存在案件 404）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const freezeCreditMock = vi.fn().mockResolvedValue({ ok: true, data: { frozen: ['CL-1'] } });
vi.mock('../creditService', () => ({
  createCreditService: vi.fn(() => ({ freezeCredit: freezeCreditMock })),
}));
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createBankruptcyService, DISPOSAL_ACTION_TYPES } from '../bankruptcyService';

const RELATION = { id: 'REL-CUST-1', name: 'Peerless Clothing', deletedAt: null };

function makePrisma(overrides: { proceedings?: any[]; actions?: any[] } = {}) {
  const proceedings = [...(overrides.proceedings ?? [])];
  const actions = [...(overrides.actions ?? [])];
  const state = { proceedings, actions };
  const prisma = {
    relation: {
      findFirst: vi.fn().mockImplementation(async (args: any) =>
        args?.where?.id === RELATION.id ? RELATION : null),
    },
    bankruptcyProceeding: {
      count: vi.fn().mockImplementation(async (args: any) =>
        proceedings.filter((p: any) => String(p.proceedingNumber ?? '').startsWith(String(args?.where?.proceedingNumber?.startsWith ?? ''))).length),
      findFirst: vi.fn().mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        return proceedings.find((p: any) =>
          (w.id ? p.id === w.id : true)
          && (w.relationId ? p.relationId === w.relationId : true)
          && (w.status ? p.status === w.status : true)
          && (w.deletedAt === null ? p.deletedAt == null : true)
        ) ?? null;
      }),
      findMany: vi.fn().mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        return proceedings.filter((p: any) =>
          (w.relationId ? p.relationId === w.relationId : true)
          && (w.status ? p.status === w.status : true)
          && (w.deletedAt === null ? p.deletedAt == null : true)
        );
      }),
      create: vi.fn().mockImplementation(async ({ data }: any) => { proceedings.push(data); return data; }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const p = proceedings.find((x: any) => x.id === where.id);
        if (!p) throw new Error('not found');
        Object.assign(p, data);
        return p;
      }),
    },
    bankruptcyAction: {
      findMany: vi.fn().mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        const rows = actions.filter((a: any) =>
          w.proceedingId ? a.proceedingId === w.proceedingId : true);
        return w.deletedAt === null ? rows.filter((a: any) => a.deletedAt == null) : rows;
      }),
      create: vi.fn().mockImplementation(async ({ data }: any) => { actions.push(data); return data; }),
    },
  };
  return { prisma: prisma as any, state };
}

beforeEach(() => { vi.clearAllMocks(); freezeCreditMock.mockResolvedValue({ ok: true, data: { frozen: ['CL-1'] } }); });

describe('开案（DR-055-③ 自动冻结）', () => {
  it('declare 首动作落库 + 信用冻结 best-effort 联动', async () => {
    const { prisma, state } = makePrisma();
    const svc = createBankruptcyService(prisma);
    const r = await svc.openProceeding({ relationId: 'REL-CUST-1', declaredAt: '2026-08-01', totalClaimedAmount: 100000, note: '客户破产宣告' }, 'user_credit');
    expect(r.ok).toBe(true);
    const d = (r as any).data;
    expect(d.proceeding.proceedingNumber).toMatch(/^BKP-\d{8}-\d{3}$/);
    expect(d.proceeding.status).toBe('processing');
    expect(d.creditFrozen).toBe(true);
    expect(freezeCreditMock).toHaveBeenCalledWith(expect.objectContaining({ relationId: 'REL-CUST-1' }));
    // declare 首动作
    const declare = state.actions.find((a: any) => a.actionType === 'declare');
    expect(declare).toBeTruthy();
    expect(declare.payload.totalClaimedAmount).toBe(100000);
  });

  it('冻结失败不阻断开案（best-effort 边界）；同客户活跃案件 409', async () => {
    freezeCreditMock.mockResolvedValue({ ok: false, error: { code: 'X', message: 'no limit', status: 404 } });
    const { prisma } = makePrisma();
    const svc = createBankruptcyService(prisma);
    const r = await svc.openProceeding({ relationId: 'REL-CUST-1', declaredAt: '2026-08-01', totalClaimedAmount: 1 }, 'u');
    expect(r.ok).toBe(true);
    expect((r as any).data.creditFrozen).toBe(false);

    // 同客户二案 → 409
    const r2 = await svc.openProceeding({ relationId: 'REL-CUST-1', declaredAt: '2026-08-02', totalClaimedAmount: 1 }, 'u');
    expect(((r2 as any).error.code)).toBe('ACTIVE_PROCEEDING_EXISTS');
    expect((r2 as any).error.status).toBe(409);
  });

  it('校验：缺 relationId / 日期格式 / 负金额 / 客户不存在 404', async () => {
    const { prisma } = makePrisma();
    const svc = createBankruptcyService(prisma);
    expect(((await svc.openProceeding({ declaredAt: '2026-08-01', totalClaimedAmount: 0 })) as any).error.code).toBe('RELATION_REQUIRED');
    expect(((await svc.openProceeding({ relationId: 'REL-CUST-1', declaredAt: '2026/08/01', totalClaimedAmount: 0 })) as any).error.code).toBe('INVALID_DATE');
    expect(((await svc.openProceeding({ relationId: 'REL-CUST-1', declaredAt: '2026-08-01', totalClaimedAmount: -5 })) as any).error.code).toBe('INVALID_AMOUNT');
    expect(((await svc.openProceeding({ relationId: 'REL-NONE', declaredAt: '2026-08-01', totalClaimedAmount: 0 })) as any).error.status).toBe(404);
  });
});

describe('动作追加与净损失汇总（DR-055-①②）', () => {
  it('四类动作 append-only + 净损失 = 申报 − 回收 − 回款 + 退运成本', async () => {
    const { prisma } = makePrisma();
    const svc = createBankruptcyService(prisma);
    const open = await svc.openProceeding({ relationId: 'REL-CUST-1', declaredAt: '2026-08-01', totalClaimedAmount: 100000 }, 'u');
    const pid = (open as any).data.proceeding.id;

    // 转卖回收 40000（买家快照）
    const resale = await svc.addAction(pid, { actionType: 'resale', amount: 40000, payload: { buyer: '下家买家A', orderRef: 'PO-2601007' } }, 'u');
    expect(((resale as any).data.summary).resaleRecovered).toBe(40000);
    // 退运成本 8000
    const ret = await svc.addAction(pid, { actionType: 'return_shipment', amount: 8000, payload: { shipmentNo: 'SH-2026-001' } }, 'u');
    expect(((ret as any).data.summary).returnShippingCost).toBe(8000);
    // 坏账 45000（发票/订单快照引用——闭环可见性锚点）
    const bad = await svc.addAction(pid, { actionType: 'bad_debt', amount: 45000, payload: { invoiceNumbers: ['INV-2026-001'], orderIds: ['PO-2601007'] } }, 'u');
    expect(((bad as any).data.summary).badDebt).toBe(45000);
    // 部分回款 7000
    const rec = await svc.addAction(pid, { actionType: 'recover', amount: 7000, payload: { receivedAt: '2026-08-15' } }, 'u');
    const sum = (rec as any).data.summary;
    // 净损失 = 100000 − 40000 − 7000 + 8000 = 61000
    expect(sum.netLoss).toBe(61000);
    expect(sum.actionCount).toBe(5); // declare + 4 动作
  });

  it('枚举校验：declare/close 不可通过 actions 端点追加；非法类型 400；负金额 400', async () => {
    const { prisma } = makePrisma();
    const svc = createBankruptcyService(prisma);
    const open = await svc.openProceeding({ relationId: 'REL-CUST-1', declaredAt: '2026-08-01', totalClaimedAmount: 0 }, 'u');
    const pid = (open as any).data.proceeding.id;
    expect(((await svc.addAction(pid, { actionType: 'declare' })) as any).error.code).toBe('INVALID_ACTION_TYPE');
    expect(((await svc.addAction(pid, { actionType: 'close' })) as any).error.code).toBe('INVALID_ACTION_TYPE');
    expect(((await svc.addAction(pid, { actionType: 'resale', amount: -1 })) as any).error.code).toBe('INVALID_AMOUNT');
    expect(DISPOSAL_ACTION_TYPES).toHaveLength(4);
  });

  it('不存在案件 404', async () => {
    const { prisma } = makePrisma();
    const svc = createBankruptcyService(prisma);
    expect(((await svc.addAction('BKP__NOPE', { actionType: 'resale', amount: 1 })) as any).error.status).toBe(404);
  });
});

describe('闭案（终态）与时间线（X-10 全程留痕锚点）', () => {
  it('闭案：close 动作 + 汇总结论落 closeNote + 终态后追加/再闭 409', async () => {
    const { prisma } = makePrisma();
    const svc = createBankruptcyService(prisma);
    const open = await svc.openProceeding({ relationId: 'REL-CUST-1', declaredAt: '2026-08-01', totalClaimedAmount: 100000 }, 'u');
    const pid = (open as any).data.proceeding.id;
    await svc.addAction(pid, { actionType: 'resale', amount: 40000 }, 'u');
    await svc.addAction(pid, { actionType: 'bad_debt', amount: 45000, payload: { invoiceNumbers: ['INV-1'] } }, 'u');

    const close = await svc.closeProceeding(pid, { note: '债权处置完毕' }, 'boss');
    expect(close.ok).toBe(true);
    const d = (close as any).data;
    expect(d.proceeding.status).toBe('closed');
    expect(d.summary.netLoss).toBe(60000); // 100000 − 40000
    expect(d.proceeding.closeNote).toContain('净损失 ¥60000');
    expect(d.proceeding.closeNote).toContain('债权处置完毕');

    // 终态：追加动作 / 再闭案 → 409
    expect(((await svc.addAction(pid, { actionType: 'resale', amount: 1 })) as any).error.code).toBe('PROCEEDING_CLOSED');
    expect(((await svc.closeProceeding(pid, {})) as any).error.code).toBe('PROCEEDING_CLOSED');
  });

  it('时间线 append-only 正序：declare → … → close 全程可查（X-10 锚点）', async () => {
    const { prisma } = makePrisma();
    const svc = createBankruptcyService(prisma);
    const open = await svc.openProceeding({ relationId: 'REL-CUST-1', declaredAt: '2026-08-01', totalClaimedAmount: 50000 }, 'u');
    const pid = (open as any).data.proceeding.id;
    await svc.addAction(pid, { actionType: 'return_shipment', amount: 2000, payload: { shipmentNo: 'SH-1' } }, 'u');
    await svc.addAction(pid, { actionType: 'bad_debt', amount: 48000, payload: { invoiceNumbers: ['INV-9'], orderIds: ['PO-9'] } }, 'u');
    await svc.closeProceeding(pid, { note: '退运+坏账结案' }, 'boss');

    const detail = await svc.getProceeding(pid);
    const actions = (detail as any).data.actions;
    expect(actions.map((a: any) => a.actionType)).toEqual(['declare', 'return_shipment', 'bad_debt', 'close']);
    // bad_debt 快照引用（闭环可见性）
    const bad = actions.find((a: any) => a.actionType === 'bad_debt');
    expect(bad.payload.invoiceNumbers).toEqual(['INV-9']);
    expect(bad.payload.orderIds).toEqual(['PO-9']);
    // close 动作携带汇总快照
    const closeAction = actions.find((a: any) => a.actionType === 'close');
    expect(closeAction.payload.netLoss).toBe(52000); // 50000 + 2000
  });

  it('列表（关系过滤 + 每案汇总）与详情 404', async () => {
    const { prisma } = makePrisma();
    const svc = createBankruptcyService(prisma);
    await svc.openProceeding({ relationId: 'REL-CUST-1', declaredAt: '2026-08-01', totalClaimedAmount: 10000 }, 'u');
    const list = await svc.listProceedings({ relationId: 'REL-CUST-1' });
    expect((list as any).data.items).toHaveLength(1);
    expect((list as any).data.items[0].summary.totalClaimed).toBe(10000);
    expect(((await svc.getProceeding('BKP__NOPE')) as any).error.status).toBe(404);
  });
});
