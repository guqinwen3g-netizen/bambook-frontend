/**
 * invoiceConsolidationCustomerGate.test.ts
 *
 * L2 高危 2 号「合并开票不校同客户」（docs/v1全面验收方案-2026-09-17.md）回归门禁。
 *
 * 病灶：应收 / 账龄 / 催办 / 信用额度（usedAmount）**全部按客户记账**。
 *   一张发票挂上两个客户的订单 → 两边都算到票头客户头上，另一个客户凭空少债，
 *   而且**全程不报错**（静默错账，只有对账时才发现）。
 *   出运合票早有同口径硬校验（shipping/allocationService.assertConsolidationAllowed），
 *   开票侧此前完全没校 —— 这是不对称的那一半。
 *
 * 三层：
 *   ① 纯函数 findAllocationCustomerViolation：判定表（relationId 优先 / 客户名兜底 / 不误报）
 *   ② 服务层 createInvoice / updateInvoice：真的会拦，且拦在写分配行**之前**
 *   ③ 路由层：错误码映射到 409（不是 500）
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// 信用重算与本门禁无关（且发生在校验之后，违规时根本走不到），隔离掉以聚焦断言
vi.mock('../../credit/creditService', () => ({
  notifyCustomerCreditRecalc: vi.fn().mockResolvedValue(undefined),
}));

import { createInvoice, updateInvoice, findAllocationCustomerViolation } from '../invoiceMutationService';
import { createFinanceRouter } from '../route';
import { authHeader } from '../../__tests__/authTestHelper';

// ────────────────────────────────────────────────────────────────
// ① 纯函数判定表
// ────────────────────────────────────────────────────────────────

const R1 = 'REL__CUST_A';
const R2 = 'REL__CUST_B';

describe('findAllocationCustomerViolation — 判定表', () => {
  it('无订单 → 无违规', () => {
    expect(findAllocationCustomerViolation([], { type: 'Receivable', customerRelationId: R1 })).toBeNull();
  });

  it('同客户两单（relationId 相同）→ 放行', () => {
    const v = findAllocationCustomerViolation(
      [{ id: 'O1', code: 'SO-1', customerRelationId: R1 }, { id: 'O2', code: 'SO-2', customerRelationId: R1 }],
      { type: 'Receivable', customerRelationId: R1 },
    );
    expect(v).toBeNull();
  });

  it('★ 不同客户两单 → 合并开票被拒（CONSOLIDATION）', () => {
    const v = findAllocationCustomerViolation(
      [{ id: 'O1', code: 'SO-1', customerRelationId: R1, customer: '客户甲' }, { id: 'O2', code: 'SO-2', customerRelationId: R2, customer: '客户乙' }],
      { type: 'Receivable', customerRelationId: R1 },
    );
    expect(v?.code).toBe('INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH');
    // 报错文案必须点出是哪两单、分别是谁 —— 否则业务侧无从下手
    expect(v?.message).toContain('SO-1');
    expect(v?.message).toContain('SO-2');
    expect(v?.message).toContain('客户甲');
    expect(v?.message).toContain('客户乙');
  });

  it('★ 无 relationId（旧数据）→ 客户名兜底判不同客户', () => {
    const v = findAllocationCustomerViolation(
      [{ id: 'O1', customer: '客户甲' }, { id: 'O2', customer: '客户乙' }],
      { type: 'Receivable', customerRelationId: null },
    );
    expect(v?.code).toBe('INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH');
  });

  it('无 relationId + 同名 → 放行（兜底口径不能把同客户判成不同客户）', () => {
    const v = findAllocationCustomerViolation(
      [{ id: 'O1', customer: '客户甲' }, { id: 'O2', customer: '客户甲' }],
      { type: 'Receivable', customerRelationId: null },
    );
    expect(v).toBeNull();
  });

  it('★ 票头客户 ≠ 订单客户（Receivable）→ 挂错人被拒（CUSTOMER_MISMATCH）', () => {
    const v = findAllocationCustomerViolation(
      [{ id: 'O1', code: 'SO-1', customerRelationId: R1, customer: '客户甲' }],
      { type: 'Receivable', customerRelationId: R2, customerName: '客户乙' },
    );
    expect(v?.code).toBe('INVOICE_CUSTOMER_MISMATCH');
    expect(v?.message).toContain('客户乙');
    expect(v?.message).toContain('客户甲');
  });

  it('票头客户 = 订单客户 → 放行', () => {
    const v = findAllocationCustomerViolation(
      [{ id: 'O1', customerRelationId: R1 }],
      { type: 'Receivable', customerRelationId: R1 },
    );
    expect(v).toBeNull();
  });

  it('Payable 不校票头客户（customerRelationId 存的是供应商，口径不同）', () => {
    const v = findAllocationCustomerViolation(
      [{ id: 'O1', customerRelationId: R1 }],
      { type: 'Payable', customerRelationId: R2 },
    );
    expect(v).toBeNull();
  });

  it('数据不全（订单无 relationId、票头有）→ 不误报，交给业务判断', () => {
    const v = findAllocationCustomerViolation(
      [{ id: 'O1', customer: null }],
      { type: 'Receivable', customerRelationId: R1 },
    );
    expect(v).toBeNull();
  });

  it('票头无客户档案（relationId 空）→ 只校「订单之间同客户」，不误报', () => {
    const v = findAllocationCustomerViolation(
      [{ id: 'O1', customerRelationId: R1 }, { id: 'O2', customerRelationId: R1 }],
      { type: 'Receivable', customerRelationId: null },
    );
    expect(v).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// ② 服务层（createInvoice / updateInvoice）
// ────────────────────────────────────────────────────────────────

type OrderRow = { id: string; code: string | null; poNumber: string | null; customerRelationId: string | null; customer: string | null };

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
  orders: OrderRow[];
  existingInvoice?: any;
  existingAllocations?: Array<{ orderId: string }>;
}) {
  const persisted = { invoices: opts.existingInvoice ? [cloneStored(opts.existingInvoice)] : [], allocations: [] as any[] };
  const invoiceCreate = vi.fn().mockImplementation(async ({ data }: any) => { const row = { ...data, id: 'INV__NEW' }; persisted.invoices.push(row); return row; });
  const invoiceUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({
    ...(opts.existingInvoice ?? {}), ...data, id: where.id,
  }));
  const orderFindMany = vi.fn().mockResolvedValue(opts.orders);
  const orderAllocCreate = vi.fn(async ({ data }: any) => { persisted.allocations.push(data); return data; });
  const orderAllocUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const orderAllocFindMany = vi.fn().mockResolvedValue(opts.existingAllocations ?? []);
  const auditCreate = vi.fn().mockResolvedValue({ id: 'AL-1' });

  const tx = {
    $queryRawUnsafe: vi.fn(async () => []), // Ordinary invoice: no MaterialReturn claimInvoiceId back-reference.
    invoice: {
      create: invoiceCreate,
      update: invoiceUpdate,
      findUnique: vi.fn().mockResolvedValue(opts.existingInvoice ?? null),
    },
    paymentVoucher: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    invoiceAllocation: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    invoiceOrderAllocation: { create: orderAllocCreate, updateMany: orderAllocUpdateMany, findMany: orderAllocFindMany },
    invoiceLine: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: auditCreate },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    order: { findMany: orderFindMany, findUnique: vi.fn().mockResolvedValue({ id: 'O1', paymentTerms: null }) },
  } as any;

  const prisma = {
    invoice: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(opts.existingInvoice ?? null) },
    paymentVoucher: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    invoiceAllocation: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    invoiceOrderAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    systemConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    relation: { findUnique: vi.fn().mockResolvedValue(null) },
    // ★ G-4 起 createInvoice 会读订单付款方式（L/C 门禁）⇒ 同一个委托里补 findUnique
    order: { findMany: vi.fn().mockResolvedValue(opts.orders), findUnique: vi.fn().mockResolvedValue(null) },
    orderLine: { findMany: vi.fn().mockResolvedValue([]) },
    shipment: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (fn: any) => { const before = cloneStored(persisted); try { return await fn(tx); } catch (error) { Object.assign(persisted, before); throw error; } }),
  } as any;

  storedOwner(prisma, tx);
  tx.$queryRaw = vi.fn(async () => [{ id: 'stored-source-lock' }]);
  tx.order.findFirst = vi.fn(async ({ where }: any) => opts.orders.find(row => row.id === where.id) ?? null);
  tx.orderLine = { findMany: vi.fn(async () => []) };
  tx.sample = { findMany: vi.fn(async () => []) };
  tx.releaseScope = { findMany: vi.fn(async () => []) };
  tx.invoice.findFirst = tx.invoice.findUnique;
  return { prisma, persisted, invoiceCreate, invoiceUpdate, orderAllocCreate, orderFindMany, orderAllocFindMany };
}

const ORDERS_SAME_CUSTOMER: OrderRow[] = [
  { id: 'O1', code: 'SO-202608-001', poNumber: 'PO-1', customerRelationId: R1, customer: '客户甲' },
  { id: 'O2', code: 'SO-202608-002', poNumber: 'PO-2', customerRelationId: R1, customer: '客户甲' },
];
const ORDERS_TWO_CUSTOMERS: OrderRow[] = [
  { id: 'O1', code: 'SO-202608-001', poNumber: 'PO-1', customerRelationId: R1, customer: '客户甲' },
  { id: 'O2', code: 'SO-202608-002', poNumber: 'PO-2', customerRelationId: R2, customer: '客户乙' },
];

const baseCreate = { type: 'Receivable' as const, amount: '100', currency: 'USD', issueDate: '2026-09-17', dueDate: '2026-10-17', status: 'Draft' as const };

describe('createInvoice — 同客户硬门禁', () => {
  beforeEach(() => vi.clearAllMocks());

  it('★ 多客户合并开票 → 拒绝，且**不写任何分配行**（拦在写之前）', async () => {
    const { prisma, orderAllocCreate } = makePrisma({ orders: ORDERS_TWO_CUSTOMERS });
    const res = await createInvoice({ prisma, input: { ...baseCreate, invoiceNumber: 'INV-T1', customerRelationId: R1, customerName: '客户甲', orderIds: ['O1', 'O2'] } as any });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH');
    expect(orderAllocCreate).not.toHaveBeenCalled();
  });

  it('同客户多订单合并开票 → 放行，两行分配都落库', async () => {
    const { prisma, orderAllocCreate } = makePrisma({ orders: ORDERS_SAME_CUSTOMER });
    const res = await createInvoice({ prisma, input: { ...baseCreate, invoiceNumber: 'INV-T2', customerRelationId: R1, customerName: '客户甲', orderIds: ['O1', 'O2'] } as any });
    expect(res.ok).toBe(true);
    expect(orderAllocCreate).toHaveBeenCalledTimes(2);
  });

  it('★ 票头客户 ≠ 订单签约客户 → 拒绝（挂错人）', async () => {
    const { prisma, orderAllocCreate } = makePrisma({ orders: ORDERS_SAME_CUSTOMER });
    const res = await createInvoice({ prisma, input: { ...baseCreate, invoiceNumber: 'INV-T3', customerRelationId: R2, customerName: '客户乙', orderIds: ['O1'] } as any });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVOICE_CUSTOMER_MISMATCH');
    expect(orderAllocCreate).not.toHaveBeenCalled();
  });

  it('订单客户数据缺失（旧数据）→ 不误报，放行', async () => {
    const { prisma } = makePrisma({ orders: [{ id: 'O1', code: 'SO-1', poNumber: null, customerRelationId: null, customer: null }] });
    const res = await createInvoice({ prisma, input: { ...baseCreate, invoiceNumber: 'INV-T4', customerRelationId: R1, orderIds: ['O1'] } as any });
    expect(res.ok).toBe(true);
  });

  it('单订单开票（最普通路径）不受影响', async () => {
    const { prisma, orderAllocCreate } = makePrisma({ orders: [ORDERS_SAME_CUSTOMER[0]] });
    const res = await createInvoice({ prisma, input: { ...baseCreate, invoiceNumber: 'INV-T5', customerRelationId: R1, orderIds: ['O1'] } as any });
    expect(res.ok).toBe(true);
    expect(orderAllocCreate).toHaveBeenCalledTimes(1);
  });
});

describe('updateInvoice — 同客户硬门禁（含「只改客户不动分配」路径）', () => {
  beforeEach(() => vi.clearAllMocks());

  const existing = {
    id: 'INV__1', status: 'Draft', amount: new Prisma.Decimal('100'), type: 'Receivable',
    customerRelationId: R1, customerName: '客户甲', deletedAt: null,
  };

  it('★ PATCH 改分配为多客户 → 拒绝', async () => {
    const { prisma } = makePrisma({ orders: ORDERS_TWO_CUSTOMERS, existingInvoice: existing });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { orderIds: ['O1', 'O2'] } as any });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH');
  });

  it('★ 只改票头客户、不动分配 → 已有分配仍挂旧客户 → 拒绝（否则一样挂错人）', async () => {
    const { prisma } = makePrisma({
      orders: ORDERS_SAME_CUSTOMER,
      existingInvoice: existing,
      existingAllocations: [{ orderId: 'O1' }],
    });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { customerRelationId: R2, customerName: '客户乙' } as any });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVOICE_CUSTOMER_MISMATCH');
  });

  it('改客户但该票没有任何订单分配 → 放行（无挂靠，不会挂错人）', async () => {
    const { prisma } = makePrisma({ orders: ORDERS_SAME_CUSTOMER, existingInvoice: existing, existingAllocations: [] });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { customerRelationId: R2, customerName: '客户乙' } as any });
    expect(res.ok).toBe(true);
  });

  it('客户字段没变时不做额外查询（避免历史脏数据把任意 PATCH 都变成 409）', async () => {
    const { prisma, orderAllocFindMany } = makePrisma({
      orders: ORDERS_SAME_CUSTOMER, existingInvoice: existing, existingAllocations: [{ orderId: 'O1' }],
    });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { notes: '备注' } as any });
    expect(res.ok).toBe(true);
    expect(orderAllocFindMany).not.toHaveBeenCalled();
  });

  it('改客户 + 同一次 PATCH 换分配为同客户 → 放行', async () => {
    const { prisma } = makePrisma({ orders: ORDERS_TWO_CUSTOMERS, existingInvoice: existing });
    const res = await updateInvoice({ prisma, invoiceId: 'INV__1', input: { customerRelationId: R2, customerName: '客户乙', orderIds: ['O2'] } as any });
    expect(res.ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// ③ 路由层：错误码 → 409（不能落 500）
// ────────────────────────────────────────────────────────────────

describe('路由层 — 错误码映射到 409', () => {
  it('POST /api/v1/finance 多客户合并开票 → 409 + 结构化错误码', async () => {
    const { prisma } = makePrisma({ orders: ORDERS_TWO_CUSTOMERS });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange: vi.fn() }));
    const res = await request(app).post('/api/v1/finance').set(authHeader()).send({
      invoiceNumber: 'INV-R1', type: 'Receivable', amount: '100', currency: 'USD',
      issueDate: '2026-09-17', dueDate: '2026-10-17', status: 'Draft',
      customerRelationId: R1, customerName: '客户甲', orderIds: ['O1', 'O2'],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH');
  });

  it('POST /api/v1/finance 票头客户不符 → 409', async () => {
    const { prisma } = makePrisma({ orders: ORDERS_SAME_CUSTOMER });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange: vi.fn() }));
    const res = await request(app).post('/api/v1/finance').set(authHeader()).send({
      invoiceNumber: 'INV-R2', type: 'Receivable', amount: '100', currency: 'USD',
      issueDate: '2026-09-17', dueDate: '2026-10-17', status: 'Draft',
      customerRelationId: R2, customerName: '客户乙', orderIds: ['O1'],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVOICE_CUSTOMER_MISMATCH');
  });
});
