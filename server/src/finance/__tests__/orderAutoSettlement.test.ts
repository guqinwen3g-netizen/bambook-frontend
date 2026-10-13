import { describe, expect, it, vi } from 'vitest';
vi.mock('../../shared/businessClock', () => ({ businessNowMs: () => Date.parse('2026-10-08T00:18:00.000Z') }));
import { AUTO_SETTLE_ACTOR, syncOrderAutoSettlement, syncOrderAutoSettlementByInvoice } from '../orderAutoSettlement';

/**
 * §10.3-1：订单结案（绿）= 全额核销自动判定，无人工动作。
 * 本批把「人工确认结案」补成「收齐自动结案」，并保留人工结案不被系统撤回。
 */

type InvRow = { id: string; type: string; status: string };

function makePrisma(opts: {
  order: { id: string; settledAt: bigint | null; settledBy: string | null } | null;
  invoices: InvRow[];
  orderIdByInvoice?: string | null;
  failUpdate?: boolean;
}) {
  const state = { updates: [] as any[], audits: [] as any[] };
  const prisma: any = {
    order: {
      findFirst: async () => opts.order,
      update: async ({ data }: any) => {
        if (opts.failUpdate) throw new Error('db down');
        state.updates.push(data);
        if (opts.order) Object.assign(opts.order, data);
        return opts.order;
      },
    },
    invoice: {
      findMany: async ({ where }: any) =>
        opts.invoices.filter(
          (i) => i.type === where.type && i.status !== (where.status?.not ?? '__none__'),
        ),
      findUnique: async () => ({ orderId: opts.orderIdByInvoice ?? null }),
    },
    auditLog: {
      create: async ({ data }: any) => {
        state.audits.push(data);
        return data;
      },
    },
  };
  return { prisma, state };
}

const ORD = (over: Partial<{ id: string; settledAt: bigint | null; settledBy: string | null }> = {}) => ({
  id: 'ORD-1',
  settledAt: null,
  settledBy: null,
  ...over,
});

describe('§10.3-1 订单自动结案', () => {
  it('keeps the automatic marker separate from the real triggering audit actor and frozen business date', async () => {
    const { prisma, state } = makePrisma({ order: ORD(), invoices: [{ id: 'INV-1', type: 'Receivable', status: 'Paid' }] });
    await syncOrderAutoSettlement(prisma, 'ORD-1', { source: 'route:allocation:create', actorId: 'actual-finance-user' });
    expect(state.updates[0]).toMatchObject({ settledAt: BigInt(Date.parse('2026-10-08T00:18:00.000Z')), settledBy: AUTO_SETTLE_ACTOR });
    expect(state.audits[0].actorId).toBe('actual-finance-user');
    expect(state.updates[0].updatedAt).not.toBe(state.updates[0].settledAt);
  });
  it('uses the canonical disabled system actor for a background calculation, never a nonexistent automatic marker', async () => {
    const { prisma, state } = makePrisma({ order: ORD(), invoices: [{ id: 'INV-1', type: 'Receivable', status: 'Paid' }] });
    await syncOrderAutoSettlement(prisma, 'ORD-1');
    expect(state.audits[0].actorId).toBe('system');
  });
  it('应收发票全部 Paid → 自动结案并留痕', async () => {
    const { prisma, state } = makePrisma({
      order: ORD(),
      invoices: [
        { id: 'INV-1', type: 'Receivable', status: 'Paid' },
        { id: 'INV-2', type: 'Receivable', status: 'Paid' },
      ],
    });
    const r = await syncOrderAutoSettlement(prisma, 'ORD-1', { source: 'test' });
    expect(r).toBe('settled');
    expect(state.updates[0].settledAt).toBeTypeOf('bigint');
    expect(state.updates[0].settledBy).toBe(AUTO_SETTLE_ACTOR);
    expect(state.audits.some((a: any) => a.action === 'order_auto_settle')).toBe(true);
  });

  it('已作废发票不计入：其余全 Paid 仍自动结案', async () => {
    const { prisma } = makePrisma({
      order: ORD(),
      invoices: [
        { id: 'INV-1', type: 'Receivable', status: 'Paid' },
        { id: 'INV-2', type: 'Receivable', status: 'Cancelled' },
      ],
    });
    expect(await syncOrderAutoSettlement(prisma, 'ORD-1')).toBe('settled');
  });

  it('存在未结清应收 + 此前是自动结案 → 撤回（防撤销核销后仍显示绿）', async () => {
    const { prisma, state } = makePrisma({
      order: ORD({ settledAt: 1n, settledBy: AUTO_SETTLE_ACTOR }),
      invoices: [
        { id: 'INV-1', type: 'Receivable', status: 'Paid' },
        { id: 'INV-2', type: 'Receivable', status: 'PartiallyPaid' },
      ],
    });
    const r = await syncOrderAutoSettlement(prisma, 'ORD-1');
    expect(r).toBe('reverted');
    expect(state.updates[0].settledAt).toBeNull();
    expect(state.audits.some((a: any) => a.action === 'order_auto_settle_revert')).toBe(true);
  });

  it('存在未结清应收 + 此前是人工结案 → 保留不动（系统无权替人反悔）', async () => {
    const { prisma, state } = makePrisma({
      order: ORD({ settledAt: 1n, settledBy: 'usr_demo_finance' }),
      invoices: [{ id: 'INV-1', type: 'Receivable', status: 'Issued' }],
    });
    expect(await syncOrderAutoSettlement(prisma, 'ORD-1')).toBe('manual_kept');
    expect(state.updates).toHaveLength(0);
  });

  it('已自动结案且仍全 Paid → 幂等跳过', async () => {
    const { prisma, state } = makePrisma({
      order: ORD({ settledAt: 1n, settledBy: AUTO_SETTLE_ACTOR }),
      invoices: [{ id: 'INV-1', type: 'Receivable', status: 'Paid' }],
    });
    expect(await syncOrderAutoSettlement(prisma, 'ORD-1')).toBe('skipped');
    expect(state.updates).toHaveLength(0);
  });

  it('无应收发票的订单不参与自动结案（仍走人工确认）', async () => {
    const { prisma, state } = makePrisma({ order: ORD(), invoices: [] });
    expect(await syncOrderAutoSettlement(prisma, 'ORD-1')).toBe('no_invoice');
    expect(state.updates).toHaveLength(0);
  });

  it('DB 异常 → fail-open 不抛错（不阻断核销）', async () => {
    const { prisma } = makePrisma({
      order: ORD(),
      invoices: [{ id: 'INV-1', type: 'Receivable', status: 'Paid' }],
      failUpdate: true,
    });
    await expect(syncOrderAutoSettlement(prisma, 'ORD-1')).resolves.toBe('skipped');
  });

  it('按发票反查订单：无关联订单则跳过', async () => {
    const { prisma, state } = makePrisma({ order: ORD(), invoices: [], orderIdByInvoice: null });
    expect(await syncOrderAutoSettlementByInvoice(prisma, 'INV-X')).toBe('skipped');
    expect(state.updates).toHaveLength(0);
  });
});
