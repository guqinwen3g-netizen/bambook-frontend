/**
 * L3 联动不对称 ② —— 作废发票必须回冲批次结算快照。
 *
 * 病灶（修前）：作废发票有两条路径
 *   ① PATCH /invoices/:id { status: 'Cancelled' }  → invoiceMutationService.updateInvoice → **有**批次重算挂点
 *   ② POST  /invoices/:id/cancel                   → voidDeleteService.cancelInvoice   → **无**批次重算挂点
 * 走 ② 作废的票，OrderShipmentBatch.invoicedAmount / settleStatus 会一直把已作废金额
 * 算作"已开票"——静默错账（批次显示已开票/已结清，实际票已作废）。
 *
 * 本测试**不 mock shipmentBatchSettlementHook**，让真实的
 * notifyShipmentBatchSettlementRecalc → orderShipmentBatchService.recalcSettlement 跑起来，
 * 断言的是**批次快照的实际数值**，而不是"某个函数被调用过"。
 *
 * 证伪方式：注掉 voidDeleteService 里那行 notifyShipmentBatchSettlementRecalc →
 * 「作废后 invoicedAmount 归零」与「settleStatus 回退」两条必转红。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: vi.fn().mockResolvedValue('AUDIT__TEST'),
}));
vi.mock('../../entities/sync', () => ({
  deactivateEntityLinks: vi.fn().mockResolvedValue(undefined),
  syncInvoiceReferences: vi.fn().mockResolvedValue(undefined),
  syncPaymentVoucherReferences: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../credit/creditService', () => ({
  notifyCustomerCreditRecalc: vi.fn().mockResolvedValue(undefined),
}));

import { cancelInvoice } from '../voidDeleteService';

const NOW = BigInt(Date.parse('2026-09-17T00:00:00Z'));

/** 内存 prisma：发票 + 核销 + 发票↔订单分配 + 出运批次（结算快照承载者） */
function makePrisma(seed: {
  invoices: any[];
  invoiceAllocations?: any[];
  ioAllocations?: any[];
  batches?: any[];
  orders?: any[];
} = { invoices: [] }) {
  const state = {
    invoices: [...seed.invoices],
    invoiceAllocations: [...(seed.invoiceAllocations ?? [])],
    ioAllocations: [...(seed.ioAllocations ?? [])],
    batches: [...(seed.batches ?? [])],
    orders: [...(seed.orders ?? [])],
    _refs: [] as any[],
    _links: [] as any[],
  };
  const prisma: any = {
    $queryRaw: vi.fn(async () => []),
    $queryRawUnsafe: vi.fn(async () => []), // No native supplier-claim source in this customer fixture.
    materialReturn: { findMany: vi.fn(async () => []) },
    $transaction: async (fn: any) => fn(prisma),
    invoice: {
      findUnique: async ({ where }: any) => state.invoices.find((i) => i.id === where?.id) ?? null,
      findMany: async ({ where }: any) =>
        state.invoices.filter((i) => (where?.id?.in ? where.id.in.includes(i.id) : true) && i.deletedAt == null),
      update: async ({ where, data }: any) => {
        const idx = state.invoices.findIndex((i) => i.id === where.id);
        if (idx < 0) throw new Error('invoice not found');
        state.invoices[idx] = { ...state.invoices[idx], ...data };
        return state.invoices[idx];
      },
    },
    invoiceAllocation: {
      count: async ({ where }: any) => state.invoiceAllocations.filter((a) => a.invoiceId === where.invoiceId).length,
      findMany: async ({ where }: any) =>
        state.invoiceAllocations.filter((a) =>
          where?.invoiceId?.in ? where.invoiceId.in.includes(a.invoiceId)
            : where?.invoiceId ? a.invoiceId === where.invoiceId : true),
    },
    invoiceOrderAllocation: {
      findMany: async ({ where }: any) => {
        let rows = state.ioAllocations.filter((a) => a.deletedAt == null);
        if (where?.invoiceId?.in) rows = rows.filter((a) => where.invoiceId.in.includes(a.invoiceId));
        if (where?.invoiceId) rows = rows.filter((a) => a.invoiceId === where.invoiceId);
        if (where?.batchId) rows = rows.filter((a) => a.batchId === where.batchId);
        if (where?.orderId) rows = rows.filter((a) => a.orderId === where.orderId);
        return rows;
      },
    },
    orderShipmentBatch: {
      findFirst: async ({ where }: any) =>
        state.batches.filter((b) => b.deletedAt == null && (!where?.id || b.id === where.id))[0] ?? null,
      findMany: async ({ where }: any) =>
        state.batches.filter((b) => b.deletedAt == null && (where?.orderId != null ? b.orderId === where.orderId : true)),
      update: async ({ where, data }: any) => {
        const idx = state.batches.findIndex((b) => b.id === where.id);
        if (idx < 0) throw new Error('batch not found');
        state.batches[idx] = { ...state.batches[idx], ...data };
        return state.batches[idx];
      },
    },
    order: {
      findFirst: async ({ where }: any) =>
        state.orders.filter((o) => o.deletedAt == null && o.id === where?.id)[0] ?? null,
      findMany: async ({ where }: any) =>
        state.orders.filter((o) => (where?.id?.in ? where.id.in.includes(o.id) : true)),
    },
    billingItem: { findFirst: async () => null, update: async () => null },
  };
  return { prisma, state };
}

/** 订单 + 批次（计划额 60000）+ 发票（60000，挂在批次上）+ 部分核销 */
function seed() {
  return {
    orders: [{ id: 'O-1', poNumber: 'PO-2601001', customer: 'Atlas', deletedAt: null }],
    batches: [{
      id: 'OSB__1', orderId: 'O-1', batchNo: 1, shipmentId: null,
      plannedRatio: '60.00', amount: '60000', currency: 'USD',
      customerRelationId: 'REL-ATLAS', customerName: 'Atlas',
      status: 'planned', shippedAt: null, settleStatus: 'partially_settled',
      invoicedAmount: '60000', paidAmount: '20000', settledAt: null,
      isFinalBatch: false, createdAt: NOW, updatedAt: NOW, deletedAt: null,
    }],
    ioAllocations: [{ id: 'IOA-1', invoiceId: 'INV-1', orderId: 'O-1', batchId: 'OSB__1', allocatedAmount: '60000', deletedAt: null }],
    invoices: [{
      id: 'INV-1', invoiceNumber: 'INV-2026-9001', amount: '60000', currency: 'USD',
      status: 'PartiallyPaid', type: 'Receivable', orderId: null,
      customerRelationId: 'REL-ATLAS', customerName: 'Atlas',
      sourceType: null, sourceId: null, deletedAt: null,
    }],
    // 有核销记录 → cancelInvoice 会以 HAS_ALLOCATIONS 拒绝；本测试先清空再作废（业务上先撤核销再作废）
    invoiceAllocations: [] as any[],
  };
}

const findBatch = (state: any) => state.batches.find((b: any) => b.id === 'OSB__1');

beforeEach(() => { vi.clearAllMocks(); });

describe('L3② 作废发票 → 批次结算快照必须回冲（cancelInvoice 路径）', () => {
  it('★ 作废后批次 invoicedAmount 归零、settleStatus 回退（修前会停在 60000 / partially_settled）', async () => {
    const { prisma, state } = makePrisma(seed());
    expect(Number(findBatch(state).invoicedAmount)).toBe(60000); // 作废前

    const r = await cancelInvoice({ prisma, invoiceId: 'INV-1', actorId: 'tester', reason: '开错客户' });
    expect(r.ok).toBe(true);
    expect(state.invoices[0].status).toBe('Cancelled');

    const b = findBatch(state);
    // recalcSettlement 内部排除 Cancelled 发票 → 已开票额应归零
    expect(Number(b.invoicedAmount)).toBe(0);
    expect(Number(b.paidAmount)).toBe(0);
    expect(b.settleStatus).toBe('unsettled');
  });

  it('有核销记录的发票不能直接作废（先撤核销）—— 该门禁不被本次改动破坏', async () => {
    const s = seed();
    s.invoiceAllocations = [{ id: 'ALLOC-1', invoiceId: 'INV-1', voucherId: 'V-1', appliedAmount: '20000' }];
    const { prisma, state } = makePrisma(s);
    const r = await cancelInvoice({ prisma, invoiceId: 'INV-1', actorId: 'tester' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('HAS_ALLOCATIONS');
    // 拒绝后批次快照不得被动过
    expect(Number(findBatch(state).invoicedAmount)).toBe(60000);
  });

  it('同订单有第二张有效票时，作废其中一张 → 快照按剩余有效票收敛（不误清零）', async () => {
    const s = seed();
    s.ioAllocations.push({ id: 'IOA-2', invoiceId: 'INV-2', orderId: 'O-1', batchId: 'OSB__1', allocatedAmount: '25000', deletedAt: null });
    s.invoices.push({
      id: 'INV-2', invoiceNumber: 'INV-2026-9002', amount: '25000', currency: 'USD',
      status: 'Issued', type: 'Receivable', orderId: null,
      customerRelationId: 'REL-ATLAS', customerName: 'Atlas', sourceType: null, sourceId: null, deletedAt: null,
    });
    const { prisma, state } = makePrisma(s);

    const r = await cancelInvoice({ prisma, invoiceId: 'INV-1', actorId: 'tester' });
    expect(r.ok).toBe(true);

    const b = findBatch(state);
    expect(Number(b.invoicedAmount)).toBe(25000); // 只剩 INV-2
    expect(Number(b.paidAmount)).toBe(0);
  });

  it('发票未挂任何批次 → 作废是无害 no-op（不抛错、不影响其它批次）', async () => {
    const s = seed();
    s.ioAllocations = []; // 票不挂批次
    s.batches = [];
    const { prisma } = makePrisma(s);
    const r = await cancelInvoice({ prisma, invoiceId: 'INV-1', actorId: 'tester' });
    expect(r.ok).toBe(true);
  });
});
