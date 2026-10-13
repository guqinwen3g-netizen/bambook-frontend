/**
 * invoiceAmountRecalc.test.ts
 *
 * L2 变异 #8「少收无销账机制」配套 —— 发票**金额变更后派生字段（status）必须重算**。
 *
 * 病灶（真库演练 scripts/acceptance-invoice-amount-recalc.mjs 实测复现，3 条承重断言转红）：
 *   `updateInvoice`（PATCH /api/v1/finance/:id）允许改 `amount`，却**从不调用
 *   recalcInvoiceStatus**。而 `Invoice.status` 是**派生字段**（真源 = Σ InvoiceAllocation
 *   vs amount）→ 状态与净额脱钩：
 *     · 改小到 = 已核销（财务用「改金额」抹平客户少收，这是系统里唯一能抹平的路径）
 *       → open=0 但 status 停在 PartiallyPaid = **僵尸票**；
 *     · 已 Paid 的票改大 → open>0 但 status 停在 Paid =「已结清」的票其实还欠钱。
 *   连锁（代码事实）：creditService.maxOverdueDays 只按 `status ∈ {Issued, PartiallyPaid}`
 *   过滤、**连 open 都不看** → 僵尸票永久计入最大逾期天数 → 客户 60 天后被 riskWatchdog
 *   自动冻结授信，而唯一自动解冻路径（thawAutoFrozenIfSettled）要求 maxOverdueDays ≤ 60
 *   → **永不满足 → 永不解冻**。
 *
 * 顺带修的第二处：改金额到**低于已核销合计** → 制造超额核销（净额为负），
 *   违反 `applyAllocation` 已强制的 `Σapplied ≤ amount` 不变量 → 拒绝 409。
 *
 * 三层：
 *   ① 服务层：改金额 → status 重算 / 低于已核销被拒（且拦在写之前）
 *   ② 服务层：settlementDate 不变量（riskService 按期回款率以「Paid 且 settlementDate 非空」为口径）
 *   ③ 路由层：错误码 → 409（**不是 500** —— 白名单漏码是同一类陷阱的第二次出现）
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../credit/creditService', () => ({
  notifyCustomerCreditRecalc: vi.fn().mockResolvedValue(undefined),
}));

import { updateInvoice } from '../invoiceMutationService';
import { createFinanceRouter } from '../route';
import { authHeader } from '../../__tests__/authTestHelper';

const R1 = 'REL__CUST_A';

type Alloc = { appliedAmount: any; appliedDate?: string };

/**
 * 有状态 mock：`invoice.update` 之后 `invoice.findUnique` 必须返回**更新后的**行
 * —— 否则 recalcInvoiceStatus（它自己读 invoice.amount）读到的还是旧金额，
 * 「重算」断言就会在假数据上恒真。
 */
// Explicit in-memory current DB authority; real permission/source helpers run.
// The original legacy-owner credential now has a corresponding active account,
// stored role grants and scoped reads. This seam is not native PG lock evidence.
function storedOwner(prisma: any, tx: any) {
  const user = { id: 'u_owner', status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId: 'owner', departmentId: null, role: { id: 'owner', name: 'Stored synthetic owner',
      permissions: ['invoices:read', 'invoices:write', 'orders:read'].map(scope => ({ permission: { scope } })) } }] };
  const findUser = vi.fn(async ({ where }: any) => where.id === user.id ? user : null);
  for (const client of [prisma, tx]) {
    client.userAccount = { findUnique: findUser, findFirst: findUser };
    client.userPermissionOverrides = { findMany: vi.fn(async () => []) };
  }
  return user;
}

function cloneStored(value: any): any {
  if (value instanceof Prisma.Decimal) return new Prisma.Decimal(value.toString());
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneStored);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneStored(item)]));
  return value;
}

function makePrisma(opts: {
  existing: any;
  allocations?: Alloc[];
  lastAppliedDate?: string | null;
}) {
  let current = { ...opts.existing };
  const allocations = opts.allocations ?? [];

  const invoiceUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => {
    current = { ...current, ...data, id: where.id };
    return { ...current };
  });
  const invoiceFindUnique = vi.fn().mockImplementation(async () => ({ ...current }));
  // Σ已核销与「最后一笔核销日期」都经 allocationService.sumAppliedAmount / findFirst，
  // 即与被测代码共用同一份汇总定义（不再单独 mock aggregate —— 那会造出第二套口径）。
  const allocFindMany = vi.fn().mockResolvedValue(
    allocations.map((a) => ({ appliedAmount: new Prisma.Decimal(a.appliedAmount) })),
  );
  const allocFindFirst = vi.fn().mockResolvedValue(
    opts.lastAppliedDate ? { appliedDate: opts.lastAppliedDate } : null,
  );

  const tx: any = {
    $queryRawUnsafe: vi.fn(async () => []), // Ordinary invoice: no MaterialReturn claimInvoiceId back-reference.
    invoice: { create: vi.fn(), update: invoiceUpdate, findUnique: invoiceFindUnique },
    paymentVoucher: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    invoiceAllocation: { count: vi.fn().mockResolvedValue(0), findMany: allocFindMany, findFirst: allocFindFirst },
    invoiceOrderAllocation: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
    invoiceLine: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'AL-1' }) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    order: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue({ id: 'O1', paymentTerms: null }) },
  };

  const prisma: any = {
    invoice: { findMany: vi.fn().mockResolvedValue([]), findUnique: invoiceFindUnique },
    paymentVoucher: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    invoiceAllocation: { count: vi.fn().mockResolvedValue(0), findMany: allocFindMany, findFirst: allocFindFirst },
    invoiceOrderAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    systemConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    relation: { findUnique: vi.fn().mockResolvedValue(null) },
    order: { findMany: vi.fn().mockResolvedValue([]) },
    orderLine: { findMany: vi.fn().mockResolvedValue([]) },
    shipment: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (fn: any) => { const before = cloneStored(current); try { return await fn(tx); } catch (error) { current = before; throw error; } }),
  };

  storedOwner(prisma, tx);
  tx.$queryRaw = vi.fn(async () => [{ id: 'stored-source-lock' }]);
  tx.invoice.findFirst = invoiceFindUnique;
  return { prisma, tx, invoiceUpdate, allocFindMany, allocFindFirst, current: () => ({ ...current }) };
}

const baseExisting = (over: any = {}) => ({
  id: 'INV__1', status: 'PartiallyPaid', amount: new Prisma.Decimal('1000'), type: 'Receivable',
  customerRelationId: R1, customerName: '客户甲', deletedAt: null, settlementDate: null,
  invoiceNumber: 'INV-1', currency: 'USD', issueDate: '2026-09-01', dueDate: '2026-10-01',
  orderId: null, notes: null, attachments: null, exchangeRate: null, baseCurrency: 'CNY',
  sourceType: null, sourceId: null, ownerId: null, departmentId: null,
  createdAt: BigInt(1), updatedAt: BigInt(1),
  ...over,
});

// ────────────────────────────────────────────────────────────────
// ① 服务层：改金额 → status 重算
// ────────────────────────────────────────────────────────────────

describe('updateInvoice — 改金额后 status 必须重算（派生字段与净额一致）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('★ 改到 = 已核销（open 归零）→ status 重算为 Paid', async () => {
    const { prisma } = makePrisma({ existing: baseExisting(), allocations: [{ appliedAmount: '900' }] });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { amount: '900' } as any });
    expect(res.ok).toBe(true);
    expect(res.data?.invoice.status).toBe('Paid');
    // 净额口径（不经过被测路径，独立算一遍）
    expect(new Prisma.Decimal(res.data!.invoice.amount).minus(new Prisma.Decimal('900')).toNumber()).toBe(0);
  });

  it('★ 已 Paid 的票改大 → 退回 PartiallyPaid（「已结清」的票其实还欠钱）', async () => {
    const { prisma } = makePrisma({
      existing: baseExisting({ status: 'Paid', amount: new Prisma.Decimal('1000'), settlementDate: '2026-09-10' }),
      allocations: [{ appliedAmount: '1000' }],
    });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { amount: '1100' } as any });
    expect(res.ok).toBe(true);
    expect(res.data?.invoice.status).toBe('PartiallyPaid');
  });

  it('护栏：改大到仍部分核销 → PartiallyPaid（重算方向正确）', async () => {
    const { prisma } = makePrisma({ existing: baseExisting(), allocations: [{ appliedAmount: '900' }] });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { amount: '1200' } as any });
    expect(res.ok).toBe(true);
    expect(res.data?.invoice.status).toBe('PartiallyPaid');
  });

  it('护栏：无核销的票改金额 → 状态保持不变（不能被重算带跑）', async () => {
    const { prisma } = makePrisma({ existing: baseExisting({ status: 'Issued' }), allocations: [] });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { amount: '600' } as any });
    expect(res.ok).toBe(true);
    expect(res.data?.invoice.status).toBe('Issued');
  });

  it('护栏：PATCH 不含 amount（如只改备注）→ 不做核销汇总查询（避免每次 PATCH 多打两次库）', async () => {
    const { prisma, allocFindMany } = makePrisma({ existing: baseExisting(), allocations: [{ appliedAmount: '900' }] });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { notes: '备注' } as any });
    expect(res.ok).toBe(true);
    expect(allocFindMany).not.toHaveBeenCalled();
  });

  it('护栏：amount 传相同值（no-op）→ 同样不触发重算', async () => {
    const { prisma, allocFindMany } = makePrisma({ existing: baseExisting(), allocations: [{ appliedAmount: '900' }] });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { amount: '1000' } as any });
    expect(res.ok).toBe(true);
    expect(allocFindMany).not.toHaveBeenCalled();
  });

  it('★ 改金额到低于已核销合计 → 拒绝 AMOUNT_BELOW_ALLOCATED（否则制造超额核销，净额为负）', async () => {
    const { prisma, invoiceUpdate } = makePrisma({ existing: baseExisting(), allocations: [{ appliedAmount: '900' }] });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { amount: '800' } as any });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('AMOUNT_BELOW_ALLOCATED');
    // 报错要指向真问题（点出已核销多少），并告诉用户怎么走
    expect(res.error?.message).toContain('900');
    expect(res.error?.message).toContain('撤销核销');
    // ★ 拦在写之前：金额与状态都没动
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('★ 恰好等于已核销合计 → 放行（边界不是「小于等于」）', async () => {
    const { prisma } = makePrisma({ existing: baseExisting(), allocations: [{ appliedAmount: '900' }] });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { amount: '900' } as any });
    expect(res.ok).toBe(true);
    expect(res.data?.invoice.status).toBe('Paid');
  });
});

// ────────────────────────────────────────────────────────────────
// ② settlementDate 不变量（riskService 按期回款率口径）
// ────────────────────────────────────────────────────────────────

describe('updateInvoice — Paid ⟹ settlementDate 非空（否则被按期回款率静默漏统计）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('★ 重算成 Paid 且原本无结算日 → 补上「最后一笔核销的 appliedDate」（不是「今天」）', async () => {
    const { prisma } = makePrisma({
      existing: baseExisting({ settlementDate: null }),
      allocations: [{ appliedAmount: '900' }],
      lastAppliedDate: '2026-09-10',
    });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { amount: '900' } as any });
    expect(res.ok).toBe(true);
    expect(res.data?.invoice.status).toBe('Paid');
    expect(res.data?.invoice.settlementDate).toBe('2026-09-10');
  });

  it('护栏：已有结算日 → 不被覆盖（历史事实不因改金额而失真）', async () => {
    const { prisma } = makePrisma({
      existing: baseExisting({ settlementDate: '2026-08-01' }),
      allocations: [{ appliedAmount: '900' }],
      lastAppliedDate: '2026-09-10',
    });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { amount: '900' } as any });
    expect(res.ok).toBe(true);
    expect(res.data?.invoice.settlementDate).toBe('2026-08-01');
  });

  it('护栏：重算后不是 Paid → 不写结算日', async () => {
    const { prisma, allocFindFirst } = makePrisma({
      existing: baseExisting({ settlementDate: null }),
      allocations: [{ appliedAmount: '900' }],
      lastAppliedDate: '2026-09-10',
    });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { amount: '1200' } as any });
    expect(res.ok).toBe(true);
    expect(res.data?.invoice.status).toBe('PartiallyPaid');
    expect(res.data?.invoice.settlementDate).toBeNull();
    expect(allocFindFirst).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// ③ 路由层：错误码 → 409（不能落 500）
// ────────────────────────────────────────────────────────────────

describe('路由层 — 改金额低于已核销 → 409（不是 500）', () => {
  it('★ PATCH /api/v1/finance/:id → 409 + 结构化错误码', async () => {
    const { prisma } = makePrisma({ existing: baseExisting(), allocations: [{ appliedAmount: '900' }] });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange: vi.fn() }));
    const res = await request(app).patch('/api/v1/finance/INV__1').set(authHeader()).send({ amount: '800' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AMOUNT_BELOW_ALLOCATED');
  });
});
