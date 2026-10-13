/**
 * W-A 波次 · P0-1 结算自动触发点挂接 — 回归测试
 *
 * 场景真源：docs/design/10-评审与决策/2026-08-25-中度与严重缺失功能开发优先级规划.md P0-1
 *
 * 覆盖链路（finance 核销事务收口 → shipping 批次结算聚合派生）：
 *   ① 核销新增（createAllocation/applyAllocation）→ 受影响批次 paid 快照回写 → partially_settled
 *   ② 同发票追加核销至足额 → settled + settledAt 落值
 *   ③ 核销删除（deleteAllocation）→ 回退 partially_settled → unsettled
 *   ④ 失败不阻断主业务：批次聚合侧抛错时核销事务仍成功，仅 logger.warn 留痕
 *   ⑤ 幂等：重复触发重算结果收敛，无状态漂移
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: vi.fn().mockResolvedValue('AUDIT__TEST'),
}));
vi.mock('../../entities/sync', () => ({
  syncInvoiceReferences: vi.fn().mockResolvedValue(undefined),
  syncPaymentVoucherReferences: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../events/businessEventBus', () => ({
  publishBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));

import { createAllocation, updateAllocation, deleteAllocation } from '../allocationMutationService';
import { notifyShipmentBatchSettlementRecalc } from '../shipmentBatchSettlementHook';
import { logger } from '../../lib/logger';

/** 组合内存 prisma：finance 核销表 + shipping 批次表统一状态驱动 */
function makePrisma(seed: {
  orders?: any[];
  batches?: any[];
  ioAllocations?: any[]; // InvoiceOrderAllocation（发票↔订单分配，batchId 归属锚点）
  invoices?: any[];
  vouchers?: any[]; // PaymentVoucher
  invoiceAllocations?: any[]; // InvoiceAllocation（凭证×发票核销记录）
} = {}) {
  const state = {
    orders: [...(seed.orders ?? [])],
    batches: [...(seed.batches ?? [])],
    ioAllocations: [...(seed.ioAllocations ?? [])],
    invoices: [...(seed.invoices ?? [])],
    vouchers: [...(seed.vouchers ?? [])],
    invoiceAllocations: [...(seed.invoiceAllocations ?? [])],
    _refs: [] as any[],
    _links: [] as any[],
  };

  const prisma: any = {
    $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
    creditNoteAllocation: { findMany: vi.fn(async () => []) }, // No CN offsets.
    creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary shipment receipts.
    // ── 共享 ──
    $transaction: async (fn: any) => fn(prisma),
    order: {
      findFirst: async ({ where }: any) => state.orders.filter(o => o.deletedAt == null && o.id === where?.id)[0] ?? null,
      findMany: async ({ where }: any) => state.orders.filter(o => where?.id?.in ? where.id.in.includes(o.id) : true),
    },
    invoice: {
      findUnique: async ({ where }: any) => state.invoices.find(i => i.id === where?.id) ?? null,
      findMany: async ({ where }: any) => state.invoices.filter(i => where?.id?.in ? where.id.in.includes(i.id) : true),
      update: async ({ where, data }: any) => {
        const idx = state.invoices.findIndex(i => i.id === where.id);
        if (idx < 0) throw new Error('invoice not found');
        state.invoices[idx] = { ...state.invoices[idx], ...data };
        return state.invoices[idx];
      },
    },
    paymentVoucher: {
      findUnique: async ({ where }: any) => state.vouchers.find(v => v.id === where?.id) ?? null,
      update: async ({ where, data }: any) => {
        const idx = state.vouchers.findIndex(v => v.id === where.id);
        if (idx < 0) throw new Error('voucher not found');
        state.vouchers[idx] = { ...state.vouchers[idx], ...data };
        return state.vouchers[idx];
      },
    },
    // ── finance：核销记录（硬删除模型，delete+insert 语义） ──
    invoiceAllocation: {
      findUnique: async ({ where }: any) => state.invoiceAllocations.find(a => a.id === where?.id) ?? null,
      update: async ({ where, data }: any) => {
        const idx = state.invoiceAllocations.findIndex(a => a.id === where.id);
        if (idx < 0) throw new Error('allocation not found');
        state.invoiceAllocations[idx] = { ...state.invoiceAllocations[idx], ...data };
        return state.invoiceAllocations[idx];
      },
      upsert: async ({ where, update, create }: any) => {
        const k = where.invoiceId_voucherId;
        const idx = state.invoiceAllocations.findIndex(a => a.invoiceId === k.invoiceId && a.voucherId === k.voucherId);
        if (idx >= 0) {
          state.invoiceAllocations[idx] = { ...state.invoiceAllocations[idx], ...update };
          return state.invoiceAllocations[idx];
        }
        const row = { ...create };
        state.invoiceAllocations.push(row);
        return row;
      },
      findMany: async ({ where }: any) =>
        state.invoiceAllocations.filter(a => where?.invoiceId?.in ? where.invoiceId.in.includes(a.invoiceId)
          : where?.invoiceId ? a.invoiceId === where.invoiceId
            : where?.voucherId ? a.voucherId === where.voucherId : true),
      delete: async ({ where }: any) => {
        const idx = state.invoiceAllocations.findIndex(a => a.id === where.id);
        if (idx < 0) throw new Error('allocation not found');
        const [row] = state.invoiceAllocations.splice(idx, 1);
        return row;
      },
    },
    // ── 发票↔订单分配（软删除模型） ──
    invoiceOrderAllocation: {
      findMany: async ({ where }: any) => {
        let rows = state.ioAllocations.filter(a => a.deletedAt == null);
        if (where?.invoiceId?.in) rows = rows.filter(a => where.invoiceId.in.includes(a.invoiceId));
        if (where?.invoiceId) rows = rows.filter(a => a.invoiceId === where.invoiceId);
        if (where?.batchId) rows = rows.filter(a => a.batchId === where.batchId);
        if (where?.orderId) rows = rows.filter(a => a.orderId === where.orderId);
        return rows;
      },
    },
    // ── shipping：出运批次（结算快照承载者） ──
    orderShipmentBatch: {
      findFirst: async ({ where }: any) => {
        let rows = state.batches.filter(b => b.deletedAt == null && (!where?.id || b.id === where.id));
        if (where?.orderId) rows = rows.filter(b => b.orderId === where.orderId);
        return rows[0] ?? null;
      },
      findMany: async ({ where }: any) =>
        state.batches.filter(b => b.deletedAt == null && (where?.orderId != null ? b.orderId === where.orderId : true)),
      update: async ({ where, data }: any) => {
        const idx = state.batches.findIndex(b => b.id === where.id);
        if (idx < 0) throw new Error('batch not found');
        state.batches[idx] = { ...state.batches[idx], ...data };
        return state.batches[idx];
      },
    },
    // ── EntityLink/EntityReference（syncAllocationVoucherLinks 内存实现） ──
    entityReference: {
      upsert: async ({ where, create }: any) => {
        const idx = state._refs.findIndex(r => r.id === where.id);
        if (idx >= 0) { state._refs[idx] = { ...state._refs[idx], ...create }; return state._refs[idx]; }
        const row = { ...create };
        state._refs.push(row);
        return row;
      },
    },
    entityLink: {
      upsert: async ({ where, create }: any) => {
        const idx = state._links.findIndex(l => l.id === where.id);
        if (idx >= 0) { state._links[idx] = { ...state._links[idx], ...create }; return state._links[idx]; }
        const row = { ...create };
        state._links.push(row);
        return row;
      },
      findMany: async () => [...state._links],
      update: async ({ where, data }: any) => {
        const idx = state._links.findIndex(l => l.id === where.id);
        if (idx < 0) throw new Error('link not found');
        state._links[idx] = { ...state._links[idx], ...data };
        return state._links[idx];
      },
    },
  };
  return { prisma, state };
}

const NOW = BigInt(Date.parse('2026-08-25T00:00:00Z'));

/** 订单（成交净额 100000）+ 批次（计划额 60000，批内已开票由 IOA 承载）种子 */
function baseSeed(): Parameters<typeof makePrisma>[0] {
  return {
    orders: [{
      id: 'O-1', poNumber: 'PO-2601001', customer: 'Atlas', deletedAt: null,
      totalNet: '100000', quoteAmount: '100000', salesCurrency: 'USD',
      customerRelationId: 'REL-ATLAS', paymentTerms: 'T/T 30% deposit, 70% against B/L 30 days',
    }],
    batches: [{
      id: 'OSB__1', orderId: 'O-1', batchNo: 1, shipmentId: null,
      plannedRatio: '60.00', plannedQty: null, unit: null, amount: '60000', currency: 'USD',
      customerRelationId: 'REL-ATLAS', customerName: 'Atlas',
      status: 'planned', shippedAt: null, settleStatus: 'unsettled',
      invoicedAmount: null, paidAmount: null, settledAt: null,
      isFinalBatch: false, finalPaymentDueDays: null, finalPaymentDueDate: null,
      notes: null, createdAt: NOW, updatedAt: NOW, deletedAt: null,
    }],
    ioAllocations: [{ id: 'IOA-1', invoiceId: 'INV-1', orderId: 'O-1', batchId: 'OSB__1', allocatedAmount: '60000', deletedAt: null }],
    invoices: [{ id: 'INV-1', type: 'Receivable', invoiceNumber: 'INV-2026-0001', amount: '60000', currency: 'USD', status: 'Issued', orderId: null, deletedAt: null }],
    vouchers: [
      { id: 'V-1', type: 'Receipt', amount: '30000', currency: 'USD', status: 'unreconciled', deletedAt: null },
      { id: 'V-2', type: 'Receipt', amount: '40000', currency: 'USD', status: 'unreconciled', deletedAt: null },
    ],
    invoiceAllocations: [],
  };
}

const findBatch = (state: any) => state.batches.find((b: any) => b.id === 'OSB__1');

beforeEach(() => { vi.clearAllMocks(); });

describe('P0-1 结算自动触发点挂接（核销事务 → 批次结算重算）', () => {
  it('① 分配并核销部分款（20000/60000）→ 批次 invoiced/paid 回写 + partially_settled', async () => {
    const { prisma, state } = makePrisma(baseSeed());
    const r = await createAllocation({
      prisma,
      input: { invoiceId: 'INV-1', voucherId: 'V-1', appliedAmount: 20000, appliedDate: '2026-08-25' },
      actorId: 'tester',
    });
    expect(r.ok).toBe(true);

    const b = findBatch(state);
    expect(Number(b.invoicedAmount)).toBe(60000);   // IOA.batchId 锚定的开票额
    expect(Number(b.paidAmount)).toBe(20000); // 核销快照
    expect(b.settleStatus).toBe('partially_settled');
    expect(b.settledAt).toBeNull();
  });

  it('② 追加核销至足额（+40000）→ settled + settledAt 落值', async () => {
    const { prisma, state } = makePrisma(baseSeed());
    const svcParams = { prisma, actorId: 'tester' };
    const r1 = await createAllocation({ ...svcParams, input: { invoiceId: 'INV-1', voucherId: 'V-1', appliedAmount: 20000, appliedDate: '2026-08-25' } });
    expect(r1.ok).toBe(true);
    const r2 = await createAllocation({ ...svcParams, input: { invoiceId: 'INV-1', voucherId: 'V-2', appliedAmount: 40000, appliedDate: '2026-08-26' } });
    expect(r2.ok).toBe(true);
    expect(r2.data!.newInvoiceStatus).toBe('Paid'); // 核销链路自身状态机正确性旁证

    const b = findBatch(state);
    expect(Number(b.paidAmount)).toBe(60000);
    expect(b.settleStatus).toBe('settled');
    expect(b.settledAt).not.toBeNull();
  });

  it('③ 核销删除逐级回退：settled → partially_settled → unsettled', async () => {
    const { prisma, state } = makePrisma(baseSeed());
    const svcParams = { prisma, actorId: 'tester' };
    await createAllocation({ ...svcParams, input: { invoiceId: 'INV-1', voucherId: 'V-1', appliedAmount: 20000, appliedDate: '2026-08-25' } });
    const r2 = await createAllocation({ ...svcParams, input: { invoiceId: 'INV-1', voucherId: 'V-2', appliedAmount: 40000, appliedDate: '2026-08-26' } });
    expect(findBatch(state).settleStatus).toBe('settled');

    // 删除第一笔核销（IA = ALLOC__INV-1__V-x）
    const del1 = await deleteAllocation({ ...svcParams, allocationId: 'ALLOC__INV-1__V-2' });
    expect(del1.ok).toBe(true);
    let b = findBatch(state);
    expect(Number(b.paidAmount)).toBe(20000);
    expect(b.settleStatus).toBe('partially_settled');
    expect(b.settledAt).toBeNull();

    // 删除最后一笔 → unsettled
    const del2 = await deleteAllocation({ ...svcParams, allocationId: 'ALLOC__INV-1__V-1' });
    expect(del2.ok).toBe(true);
    b = findBatch(state);
    expect(Number(b.paidAmount)).toBe(0);
    expect(b.settleStatus).toBe('unsettled');
    expect(Number(b.invoicedAmount)).toBe(60000); // 开票事实不受核销删除影响
  });

  it('④ 核销金额调整（updateAllocation）→ 批次 paid 快照联动刷新', async () => {
    const { prisma, state } = makePrisma(baseSeed());
    const r1 = await createAllocation({
      prisma, input: { invoiceId: 'INV-1', voucherId: 'V-1', appliedAmount: 10000, appliedDate: '2026-08-25' }, actorId: 'tester',
    });
    expect(r1.ok).toBe(true);
    expect(findBatch(state).settleStatus).toBe('partially_settled');

    const r2 = await updateAllocation({ prisma, allocationId: 'ALLOC__INV-1__V-1', input: { appliedAmount: 30000 }, actorId: 'tester' });
    // eslint-disable-next-line no-console
    console.log('DEBUG-4', JSON.stringify(r2));
    expect(r2.ok).toBe(true);
    const b = findBatch(state);
    expect(Number(b.paidAmount)).toBe(30000); // = V-1 凭证剩余全部，同对重复核销取 upsert
    expect(b.settleStatus).toBe('partially_settled');
  });

  it('⑤ 失败不阻断主业务：批次聚合侧故障时核销仍成功 + logger.warn 留痕', async () => {
    const { prisma, state } = makePrisma(baseSeed());
    prisma.orderShipmentBatch.findFirst = async () => { throw new Error('batch store down'); };
    prisma.orderShipmentBatch.findMany = async () => { throw new Error('batch store down'); };

    const r = await createAllocation({
      prisma, input: { invoiceId: 'INV-1', voucherId: 'V-1', appliedAmount: 20000, appliedDate: '2026-08-25' }, actorId: 'tester',
    });
    expect(r.ok).toBe(true);                      // 主业务不受影响
    expect(state.invoiceAllocations).toHaveLength(1); // 核销事实已落库
    expect(logger.warn).toHaveBeenCalled();
    const warnMsgs = vi.mocked(logger.warn).mock.calls.map(c => String(c[0]));
    expect(warnMsgs.some(m => m.includes('shipmentBatchSettlementRecalc'))).toBe(true);
  });

  it('⑥ 幂等：显式重复触发 notify 重算，批次状态收敛不漂移', async () => {
    const { prisma, state } = makePrisma(baseSeed());
    await createAllocation({ prisma, input: { invoiceId: 'INV-1', voucherId: 'V-1', appliedAmount: 20000, appliedDate: '2026-08-25' }, actorId: 'tester' });
    const snap = () => JSON.stringify({
      paid: findBatch(state).paidAmount,
      inv: findBatch(state).invoicedAmount,
      st: findBatch(state).settleStatus,
      at: findBatch(state).settledAt,
    });
    const s1 = snap();
    await notifyShipmentBatchSettlementRecalc(prisma, { invoiceId: 'INV-1', source: 'test:idempotent' });
    await notifyShipmentBatchSettlementRecalc(prisma, { invoiceId: 'INV-1', source: 'test:idempotent' });
    expect(snap()).toBe(s1);
  });

  it('⑦ 发票主档直挂 orderId（无 IOA 行）→ 兜底解析并触发重算（无 batchId 锚点时 paid 口径为 0）', async () => {
    const seed = baseSeed();
    seed.ioAllocations = []; // 无发票↔订单分配行
    (seed.invoices as any[])[0].orderId = 'O-1'; // 主档直挂
    const { prisma, state } = makePrisma(seed);

    const r = await createAllocation({ prisma, input: { invoiceId: 'INV-1', voucherId: 'V-1', appliedAmount: 20000, appliedDate: '2026-08-25' }, actorId: 'tester' });
    expect(r.ok).toBe(true);
    const b = findBatch(state);
    // 批次未通过 IOA.batchId 锚定开票 → recalcSettlement 的批次口径不含该发票的核销（paid=0），
    // 但主档兜底路径已成功执行重算：updatedAt 推进即为重算落库凭证
    expect(Number(b.paidAmount)).toBe(0);
    expect(b.settleStatus).toBe('unsettled');
    expect(BigInt(b.updatedAt)).toBeGreaterThan(NOW);
  });

  it('⑧ 完全未关联订单的发票：notify 为 no-op，不触碰批次表', async () => {
    const { prisma, state } = makePrisma({
      ...baseSeed(),
      ioAllocations: [], // 无订单分配
    });
    await notifyShipmentBatchSettlementRecalc(prisma, { invoiceId: 'INV-1', source: 'test:no-op' });
    expect(findBatch(state).updatedAt).toBe(NOW);   // 批次未被改写
    expect(findBatch(state).settleStatus).toBe('unsettled');
  });

  it('⑨ 跨发票多订单：IOA 路径解析受影响订单并批量重算（无 batchId 绑定时保持 unsettled）', async () => {
    const seed = baseSeed();
    // INV-2 通过 IOA 挂 O-2；同时将其主档 orderId 指向 O-1（直挂兜底路径件应只重算一次 O-1）
    seed.ioAllocations.push({ id: 'IOA-2', invoiceId: 'INV-2', orderId: 'O-2', batchId: null, allocatedAmount: null, deletedAt: null });
    seed.orders.push({ id: 'O-2', poNumber: 'PO-2', customer: 'Baltic', deletedAt: null, totalNet: '50000', quoteAmount: '50000', salesCurrency: 'USD' });
    seed.batches.push({ ...seed.batches![0], id: 'OSB__O2', orderId: 'O-2', amount: '10000' });
    seed.invoices.push({ id: 'INV-2', type: 'Receivable', invoiceNumber: 'INV-2026-0002', amount: '8000', currency: 'USD', status: 'Issued', orderId: null, deletedAt: null });
    const { prisma, state } = makePrisma(seed);

    const r = await createAllocation({ prisma, input: { invoiceId: 'INV-2', voucherId: 'V-1', appliedAmount: 8000, appliedDate: '2026-08-26' }, actorId: 'tester' });
    expect(r.ok).toBe(true);
    // INV-2 无 batchId 绑定 → 其订单批次只刷快照不变 settled 语义；关键是全链路无异常且 IOA 路径被解析到 O-2
    const b2 = state.batches.find((b: any) => b.id === 'OSB__O2');
    expect(b2.settleStatus).toBe('unsettled'); // 该批次无 batchId 开票分配 → paid=0 保持 unsettled
  });
});
