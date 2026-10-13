/**
 * L3 联动不对称 ③ —— 订单自动结案：**触发面**与**订单/发票口径**必须与核销内核一致。
 *
 * 病灶（修前，两处）：
 *   ① 触发面：syncOrderAutoSettlementByInvoice 只挂在 allocationMutationService（route 通道），
 *      而 applyAllocation 是 route / Agent reconcileFlow / toolRuntime 三条通道的共用内核。
 *      → 走 Agent 对话核销（reconcileFlow / toolRuntime）后订单永不结案，走 UI 却会结案。
 *   ② 口径：syncOrderAutoSettlement 判定"本订单的应收票"只看 invoice.orderId（票头直挂），
 *      合并开票（一张票挂多个订单，L2 高危②硬门禁后仅限同客户）时，非票头订单的票
 *      只存在于 InvoiceOrderAllocation 上 → 该订单永远判为 no_invoice，收齐也不结案。
 *
 * 修法：结案同步收口进 applyAllocation（step 8），并把订单↔发票解析统一为
 * 「票头 orderId ∪ IOA」，与 shipmentBatchSettlementHook 同口径。
 *
 * 证伪方式：把 applyAllocation 里那行 syncOrderAutoSettlementByInvoice 注掉 → ①③ 转红；
 *          把 syncOrderAutoSettlement 的 OR 分支去掉 → ② 转红。
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
  deactivateEntityLinks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../credit/creditService', () => ({
  notifyCustomerCreditRecalc: vi.fn().mockResolvedValue(undefined),
}));

import { applyAllocation } from '../allocationService';
import { createAllocation } from '../allocationMutationService';
import { AUTO_SETTLE_ACTOR } from '../orderAutoSettlement';

/** 内存 prisma：发票 + 凭证 + 核销 + 发票↔订单分配 + 订单（批次表为空 → 批次重算 no-op） */
function makePrisma(seed: { invoices: any[]; vouchers: any[]; ioAllocations: any[]; orders: any[] }) {
  const state = {
    invoices: [...seed.invoices],
    vouchers: [...seed.vouchers],
    invoiceAllocations: [] as any[],
    ioAllocations: [...seed.ioAllocations],
    orders: [...seed.orders],
    _refs: [] as any[],
    _links: [] as any[],
  };
  const prisma: any = {
    $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
    creditNoteAllocation: { findMany: vi.fn(async () => []) }, // No CN offsets.
    creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary receipt voucher, no refund source.
    $transaction: async (fn: any) => fn(prisma),
    invoice: {
      findUnique: async ({ where }: any) => state.invoices.find((i) => i.id === where?.id) ?? null,
      findMany: async ({ where }: any) =>
        state.invoices.filter((i) => {
          if (i.deletedAt != null) return false;
          if (where?.type && i.type !== where.type) return false;
          if (where?.status?.not && i.status === where.status.not) return false;
          if (where?.orderId && i.orderId !== where.orderId) return false;
          if (where?.id?.in && !where.id.in.includes(i.id)) return false;
          if (where?.OR) {
            const ok = where.OR.some(
              (c: any) => (c.orderId && i.orderId === c.orderId) || (c.id?.in && c.id.in.includes(i.id)),
            );
            if (!ok) return false;
          }
          return true;
        }),
      update: async ({ where, data }: any) => {
        const idx = state.invoices.findIndex((i) => i.id === where.id);
        if (idx < 0) throw new Error('invoice not found');
        state.invoices[idx] = { ...state.invoices[idx], ...data };
        return state.invoices[idx];
      },
    },
    paymentVoucher: {
      findUnique: async ({ where }: any) => state.vouchers.find((v) => v.id === where?.id) ?? null,
      update: async ({ where, data }: any) => {
        const idx = state.vouchers.findIndex((v) => v.id === where.id);
        if (idx < 0) throw new Error('voucher not found');
        state.vouchers[idx] = { ...state.vouchers[idx], ...data };
        return state.vouchers[idx];
      },
    },
    invoiceAllocation: {
      upsert: async ({ where, update, create }: any) => {
        const k = where.invoiceId_voucherId;
        const idx = state.invoiceAllocations.findIndex((a) => a.invoiceId === k.invoiceId && a.voucherId === k.voucherId);
        if (idx >= 0) { state.invoiceAllocations[idx] = { ...state.invoiceAllocations[idx], ...update }; return state.invoiceAllocations[idx]; }
        state.invoiceAllocations.push({ ...create });
        return state.invoiceAllocations[state.invoiceAllocations.length - 1];
      },
      findMany: async ({ where }: any) =>
        state.invoiceAllocations.filter((a) =>
          where?.invoiceId?.in ? where.invoiceId.in.includes(a.invoiceId)
            : where?.invoiceId ? a.invoiceId === where.invoiceId
              : where?.voucherId ? a.voucherId === where.voucherId : true),
    },
    invoiceOrderAllocation: {
      findMany: async ({ where }: any) => {
        let rows = state.ioAllocations.filter((a) => a.deletedAt == null);
        if (where?.invoiceId) rows = rows.filter((a) => a.invoiceId === where.invoiceId);
        if (where?.orderId) rows = rows.filter((a) => a.orderId === where.orderId);
        if (where?.batchId) rows = rows.filter((a) => a.batchId === where.batchId);
        return rows;
      },
    },
    orderShipmentBatch: { findMany: async () => [], findFirst: async () => null, update: async () => null },
    order: {
      findFirst: async ({ where }: any) =>
        state.orders.filter((o) => o.deletedAt == null && (!where?.id || o.id === where.id))[0] ?? null,
      findMany: async ({ where }: any) =>
        state.orders.filter((o) => (where?.id?.in ? where.id.in.includes(o.id) : true)),
      update: async ({ where, data }: any) => {
        const idx = state.orders.findIndex((o) => o.id === where.id);
        if (idx < 0) throw new Error('order not found');
        state.orders[idx] = { ...state.orders[idx], ...data };
        return state.orders[idx];
      },
    },
    entityReference: {
      upsert: async ({ where, create }: any) => {
        const idx = state._refs.findIndex((r) => r.id === where.id);
        if (idx >= 0) { state._refs[idx] = { ...state._refs[idx], ...create }; return state._refs[idx]; }
        state._refs.push({ ...create }); return state._refs[state._refs.length - 1];
      },
    },
    entityLink: {
      upsert: async ({ where, create }: any) => {
        const idx = state._links.findIndex((l) => l.id === where.id);
        if (idx >= 0) { state._links[idx] = { ...state._links[idx], ...create }; return state._links[idx]; }
        state._links.push({ ...create }); return state._links[state._links.length - 1];
      },
      findMany: async () => [...state._links],
      update: async ({ where, data }: any) => {
        const idx = state._links.findIndex((l) => l.id === where.id);
        if (idx < 0) throw new Error('link not found');
        state._links[idx] = { ...state._links[idx], ...data };
        return state._links[idx];
      },
    },
  };
  return { prisma, state };
}

const ord = (id: string) => ({ id, settledAt: null as bigint | null, settledBy: null as string | null, deletedAt: null });
const inv = (over: any) => ({
  id: 'INV-1', invoiceNumber: 'INV-2026-9001', amount: '10000', currency: 'USD',
  status: 'Issued', type: 'Receivable', orderId: null, deletedAt: null,
  customerRelationId: 'REL-A', customerName: 'A', ...over,
});

/** 直调内核（模拟 Agent reconcileFlow / toolRuntime 通道） */
const applyViaKernel = (prisma: any, invoiceId: string, voucherId: string, amount: number) =>
  prisma.$transaction(async (tx: any) =>
    applyAllocation(prisma, tx, {
      invoiceId, voucherId, appliedAmount: String(amount),
      actorId: 'agent', source: 'agent:receive_and_reconcile',
    }));

beforeEach(() => { vi.clearAllMocks(); });

describe('L3③ 订单自动结案 —— 触发面 & 口径与核销内核一致', () => {
  it('★① Agent 通道（applyAllocation 直调）核销至全额 → 订单结案（修前返回 skipped，永不结案）', async () => {
    const { prisma, state } = makePrisma({
      orders: [ord('O-1')],
      vouchers: [{ id: 'V-1', type: 'Receipt', amount: '10000', currency: 'USD', status: 'unreconciled', deletedAt: null }],
      invoices: [inv({ orderId: null })],                                   // 票头不挂订单
      ioAllocations: [{ id: 'IOA-1', invoiceId: 'INV-1', orderId: 'O-1', batchId: null, deletedAt: null }],
    });

    await applyViaKernel(prisma, 'INV-1', 'V-1', 10000);

    expect(state.invoices[0].status).toBe('Paid');
    expect(state.orders[0].settledAt).not.toBeNull();
    expect(state.orders[0].settledBy).toBe(AUTO_SETTLE_ACTOR);
  });

  it('★② 合并开票（票头 O-1，分配挂 O-1+O-2）收齐 → 两个订单都结案（修前 O-2 判 no_invoice）', async () => {
    const { prisma, state } = makePrisma({
      orders: [ord('O-1'), ord('O-2')],
      vouchers: [{ id: 'V-1', type: 'Receipt', amount: '10000', currency: 'USD', status: 'unreconciled', deletedAt: null }],
      invoices: [inv({ orderId: 'O-1' })],
      ioAllocations: [
        { id: 'IOA-1', invoiceId: 'INV-1', orderId: 'O-1', batchId: null, deletedAt: null },
        { id: 'IOA-2', invoiceId: 'INV-1', orderId: 'O-2', batchId: null, deletedAt: null },
      ],
    });

    await applyViaKernel(prisma, 'INV-1', 'V-1', 10000);

    const o1 = state.orders.find((o: any) => o.id === 'O-1');
    const o2 = state.orders.find((o: any) => o.id === 'O-2');
    expect(o1.settledAt).not.toBeNull();
    expect(o2.settledAt).not.toBeNull(); // ★ 修前必为 null
    expect(o2.settledBy).toBe(AUTO_SETTLE_ACTOR);
  });

  it('③ route 通道（createAllocation）同样结案 —— 不因收口而回归', async () => {
    const { prisma, state } = makePrisma({
      orders: [ord('O-1')],
      vouchers: [{ id: 'V-1', type: 'Receipt', amount: '10000', currency: 'USD', status: 'unreconciled', deletedAt: null }],
      invoices: [inv({ orderId: 'O-1' })],
      ioAllocations: [],
    });

    const r = await createAllocation({ prisma, input: { invoiceId: 'INV-1', voucherId: 'V-1', appliedAmount: 10000 }, actorId: 'tester' });
    expect(r.ok).toBe(true);
    expect(state.orders[0].settledAt).not.toBeNull();
  });

  it('④ 未收齐（部分核销）→ 不误结案', async () => {
    const { prisma, state } = makePrisma({
      orders: [ord('O-1')],
      vouchers: [{ id: 'V-1', type: 'Receipt', amount: '4000', currency: 'USD', status: 'unreconciled', deletedAt: null }],
      invoices: [inv({ orderId: 'O-1' })],
      ioAllocations: [],
    });

    await applyViaKernel(prisma, 'INV-1', 'V-1', 4000);

    expect(state.invoices[0].status).toBe('PartiallyPaid');
    expect(state.orders[0].settledAt).toBeNull();
  });

  it('⑤ 订单有另一张未收清的应收票 → 不结案（不能只看被核销的这张）', async () => {
    const { prisma, state } = makePrisma({
      orders: [ord('O-1')],
      vouchers: [{ id: 'V-1', type: 'Receipt', amount: '10000', currency: 'USD', status: 'unreconciled', deletedAt: null }],
      invoices: [
        inv({ id: 'INV-1', invoiceNumber: 'INV-2026-9001', orderId: 'O-1', amount: '10000' }),
        inv({ id: 'INV-2', invoiceNumber: 'INV-2026-9002', orderId: 'O-1', amount: '5000', status: 'Issued' }),
      ],
      ioAllocations: [],
    });

    await applyViaKernel(prisma, 'INV-1', 'V-1', 10000);

    expect(state.orders[0].settledAt).toBeNull();
  });

  it('⑥ 人工结案的订单不被系统撤回（settledBy 是真人）', async () => {
    const { prisma, state } = makePrisma({
      orders: [{ ...ord('O-1'), settledAt: BigInt(1), settledBy: 'usr_human' }],
      vouchers: [{ id: 'V-1', type: 'Receipt', amount: '4000', currency: 'USD', status: 'unreconciled', deletedAt: null }],
      invoices: [inv({ orderId: 'O-1' })],
      ioAllocations: [],
    });

    await applyViaKernel(prisma, 'INV-1', 'V-1', 4000);

    expect(state.orders[0].settledAt).not.toBeNull();
    expect(state.orders[0].settledBy).toBe('usr_human');
  });
});
