/**
 * T2/H14 方案 A —— 发票批次锚定（orderAllocations）单元测试
 *
 * 覆盖：
 *   - batchId 必须显式传 allocatedAmount（防线：缺省被 recalcSettlement 按整单额虚增该批已开票）
 *   - batchId 归属校验：不存在 / 已删除 / 不属于该订单 / 已取消 → 拒绝
 *   - 成功路径：IOA 落 batchId + allocatedAmount
 *   - 旧口径 orderIds 兼容：allocatedAmount=null、batchId=null
 *   - dueDate 自动推导（顺带修）：Receivable 未显式给 dueDate → issueDate + paymentTerms 账期
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createInvoice } from '../invoiceMutationService';

vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../credit/creditService', () => ({ notifyCustomerCreditRecalc: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../entities/sync', () => ({ syncInvoiceReferences: vi.fn().mockResolvedValue(undefined) }));

function makePrisma(opts: {
  orderPaymentTerms?: string | null;
  batches?: any[];
} = {}) {
  const invoiceCreate = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: 'INV__NEW' }));
  const ioaCreate = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: 'IOA__NEW' }));
  const orderFindUnique = vi.fn().mockImplementation(async ({ where }: any) =>
    where.id === 'O1' ? { id: 'O1', paymentTerms: opts.orderPaymentTerms ?? null } : null);
  const tx = {
    invoice: { create: invoiceCreate },
    invoiceOrderAllocation: { create: ioaCreate, updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    order: {
      findMany: vi.fn().mockResolvedValue([{ id: 'O1', code: 'SO-1', poNumber: 'PO-1' }]),
      findUnique: orderFindUnique,
    },
    orderShipmentBatch: { findMany: vi.fn().mockResolvedValue(opts.batches ?? []) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'AL-1' }) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  return { prisma, tx, invoiceCreate, ioaCreate, orderFindUnique };
}

const baseInput = {
  type: 'Receivable',
  status: 'Draft',
  amount: '600',
  currency: 'USD',
  issueDate: '2026-09-16',
  customerName: 'ACME',
};

describe('T2 方案A：发票批次锚定（orderAllocations）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功路径：IOA 落 batchId + allocatedAmount', async () => {
    const { prisma, ioaCreate } = makePrisma({
      batches: [{ id: 'OSB_1', orderId: 'O1', deletedAt: null, status: 'shipped' }],
    });

    const result = await createInvoice({
      prisma,
      input: { ...baseInput, orderAllocations: [{ orderId: 'O1', batchId: 'OSB_1', allocatedAmount: '600' }] },
      actorId: 'tester',
    });

    expect(result.ok).toBe(true);
    expect(ioaCreate).toHaveBeenCalledTimes(1);
    const row = ioaCreate.mock.calls[0][0].data;
    expect(row.batchId).toBe('OSB_1');
    expect((row.allocatedAmount as Prisma.Decimal).toString()).toBe('600');
  });

  it('防线：batchId 缺 allocatedAmount → 拒绝（虚增已开票防线）', async () => {
    const { prisma } = makePrisma();

    const result = await createInvoice({
      prisma,
      input: { ...baseInput, orderAllocations: [{ orderId: 'O1', batchId: 'OSB_1' }] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_AMOUNT');
      expect(result.error.message).toContain('allocatedAmount');
    }
  });

  it('batchId 不属于该订单 → 拒绝锚定', async () => {
    const { prisma } = makePrisma({
      batches: [{ id: 'OSB_OTHER', orderId: 'O2', deletedAt: null, status: 'shipped' }],
    });

    const result = await createInvoice({
      prisma,
      input: { ...baseInput, orderAllocations: [{ orderId: 'O1', batchId: 'OSB_OTHER', allocatedAmount: '600' }] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('不属于订单');
  });

  it('batchId 不存在 → 拒绝', async () => {
    const { prisma } = makePrisma({ batches: [] });

    const result = await createInvoice({
      prisma,
      input: { ...baseInput, orderAllocations: [{ orderId: 'O1', batchId: 'OSB_MISSING', allocatedAmount: '600' }] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('不存在');
  });

  it('旧口径兼容：orderIds → IOA allocatedAmount=null、batchId=null', async () => {
    const { prisma, ioaCreate } = makePrisma();

    const result = await createInvoice({
      prisma,
      input: { ...baseInput, orderIds: ['O1'] },
    });

    expect(result.ok).toBe(true);
    const row = ioaCreate.mock.calls[0][0].data;
    expect(row.batchId).toBeNull();
    expect(row.allocatedAmount).toBeNull();
  });

  it('dueDate 自动推导：Receivable 未给 dueDate → issueDate + paymentTerms 账期（30 days）', async () => {
    const { prisma, invoiceCreate } = makePrisma({ orderPaymentTerms: 'T/T 30% deposit, 70% against B/L 30 days' });

    await createInvoice({
      prisma,
      input: { ...baseInput, orderIds: ['O1'] },
    });

    const data = invoiceCreate.mock.calls[0][0].data;
    expect(data.dueDate).toBe('2026-10-16');
  });

  it('dueDate 显式传值时不覆盖', async () => {
    const { prisma, invoiceCreate } = makePrisma({ orderPaymentTerms: 'T/T 30 days' });

    await createInvoice({
      prisma,
      input: { ...baseInput, dueDate: '2026-12-31', orderIds: ['O1'] },
    });

    expect(invoiceCreate.mock.calls[0][0].data.dueDate).toBe('2026-12-31');
  });
});
