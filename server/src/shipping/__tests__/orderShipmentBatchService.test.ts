/**
 * P0-1 订单分批出运与尾款结算 — 批次服务回归测试
 *
 * 覆盖（设计真源：docs/design/10-评审与决策/2026-08-25-中度与严重缺失功能开发优先级规划.md P0-1）：
 *   ① 批次登记：batchNo 自动递增 / 金额按占比推导 / 单批自动末批 / 计划缺量化失败
 *   ② 校验门禁：占比合计 ≤100% / 同订单末批唯一 / 订单不存在
 *   ③ 状态机：planned→cancelled 合法；已发运不可取消、计划字段冻结；非法迁移拒绝
 *   ④ 发运确认：须已排船；尾款到期日 = 发运日 + 账期（本批覆盖 > paymentTerms 解析）
 *   ⑤ 末批发运收款门禁：已收不足阻断（409）；豁免留痕可过
 *   ⑥ 结算聚合：invoiced/paid 快照回写 + settleStatus 派生（部分/结清）
 *   ⑦ 尾款看板：到期未结清末批列出、已结清/未到期排除
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: vi.fn().mockResolvedValue('AUDIT__TEST'),
}));

import {
  createOrderShipmentBatchService,
  parseCreditDaysFromPaymentTerms,
  addDays,
  settleBasisOf,
} from '../orderShipmentBatchService';
import { logger } from '../../lib/logger';

/** 构造内存版 prisma mock（$transaction 内联执行；各表按 state 过滤/写入） */
function makePrisma(seed: {
  orders?: any[];
  shipments?: any[];
  batches?: any[];
  ioAllocations?: any[]; // InvoiceOrderAllocation
  invoices?: any[];
  invoiceAllocations?: any[]; // InvoiceAllocation
} = {}) {
  const state = {
    orders: [...(seed.orders ?? [])],
    shipments: [...(seed.shipments ?? [])],
    batches: [...(seed.batches ?? [])],
    ioAllocations: [...(seed.ioAllocations ?? [])],
    invoices: [...(seed.invoices ?? [])],
    invoiceAllocations: [...(seed.invoiceAllocations ?? [])],
  };

  const notDeleted = (rows: any[], id?: string) =>
    rows.filter(r => r.deletedAt == null && (!id || r.id === id));

  const prisma: any = {
    order: {
      findFirst: async ({ where }: any) => notDeleted(state.orders, where?.id)[0] ?? null,
      findMany: async ({ where }: any) => state.orders.filter(o => where?.id?.in ? where.id.in.includes(o.id) : true),
    },
    shipment: {
      findFirst: async ({ where }: any) => notDeleted(state.shipments, where?.id)[0] ?? null,
    },
    orderShipmentBatch: {
      findFirst: async ({ where, orderBy }: any) => {
        let rows = notDeleted(state.batches);
        if (where?.id) rows = rows.filter(b => b.id === where.id);
        if (where?.orderId) rows = rows.filter(b => b.orderId === where.orderId);
        if (where?.isFinalBatch !== undefined) rows = rows.filter(b => b.isFinalBatch === where.isFinalBatch);
        if (orderBy?.batchNo === 'desc') rows = [...rows].sort((a, b) => b.batchNo - a.batchNo);
        return rows[0] ?? null;
      },
      findMany: async ({ where, orderBy }: any) => {
        let rows = notDeleted(state.batches);
        if (where?.orderId) rows = rows.filter(b => b.orderId === where.orderId);
        if (where?.id?.not) rows = rows.filter(b => b.id !== where.id.not);
        if (where?.shipmentId) rows = rows.filter(b => b.shipmentId === where.shipmentId);
        if (where?.isFinalBatch === true) rows = rows.filter(b => b.isFinalBatch === true);
        if (where?.status && typeof where.status === 'string') rows = rows.filter(b => b.status === where.status);
        if (where?.settleStatus?.not) rows = rows.filter(b => b.settleStatus !== where.settleStatus.not);
        if (where?.finalPaymentDueDate?.lt) rows = rows.filter(b => (b.finalPaymentDueDate ?? '9999') < where.finalPaymentDueDate.lt);
        if (orderBy?.batchNo === 'asc') rows = [...rows].sort((a, b) => a.batchNo - b.batchNo);
        if (orderBy?.finalPaymentDueDate === 'asc') rows = [...rows].sort((a, b) => String(a.finalPaymentDueDate ?? '').localeCompare(String(b.finalPaymentDueDate ?? '')));
        return rows;
      },
      create: async ({ data }: any) => {
        const row = { ...data };
        state.batches.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const idx = state.batches.findIndex(b => b.id === where.id);
        if (idx < 0) throw new Error('batch not found');
        state.batches[idx] = { ...state.batches[idx], ...data };
        return state.batches[idx];
      },
      count: async () => state.batches.length,
    },
    invoiceOrderAllocation: {
      findMany: async ({ where }: any) => {
        let rows = state.ioAllocations.filter(a => a.deletedAt == null);
        if (where?.batchId) rows = rows.filter(a => a.batchId === where.batchId);
        if (where?.orderId) rows = rows.filter(a => a.orderId === where.orderId);
        if (where?.invoiceId?.in) rows = rows.filter(a => where.invoiceId.in.includes(a.invoiceId));
        return rows;
      },
    },
    invoice: {
      findMany: async ({ where }: any) =>
        state.invoices.filter(i => where?.id?.in ? where.id.in.includes(i.id) : true),
    },
    invoiceAllocation: {
      findMany: async ({ where }: any) =>
        state.invoiceAllocations.filter(ia => ia.deletedAt == null
          && (where?.invoiceId?.in ? where.invoiceId.in.includes(ia.invoiceId) : true)),
    },
    $transaction: async (fn: any) => fn(prisma),
  };
  return { prisma, state };
}

const NOW = BigInt(Date.parse('2026-08-25T00:00:00Z'));

/** 订单种子：成交净额 100000 USD，paymentTerms 含 30 天账期 */
const ORDER = {
  id: 'O-1', poNumber: 'PO-2601001', customer: 'Atlas', deletedAt: null,
  totalNet: '100000', quoteAmount: '100000', salesCurrency: 'USD',
  customerRelationId: 'REL-ATLAS',
  paymentTerms: 'T/T 30% deposit, 70% against B/L 30 days',
};

beforeEach(() => { vi.clearAllMocks(); });

// ═══ 工具函数 ═══
describe('工具：账期解析与日期加法', () => {
  it('paymentTerms 解析 30 days → 30；无 days → null；越界钳 null', () => {
    expect(parseCreditDaysFromPaymentTerms('T/T 30% deposit, 70% against B/L 30 days')).toBe(30);
    expect(parseCreditDaysFromPaymentTerms('T/T 100% in advance')).toBeNull();
    expect(parseCreditDaysFromPaymentTerms('net 400 days')).toBeNull();
    expect(parseCreditDaysFromPaymentTerms(null)).toBeNull();
  });
  it('addDays 跨月正确', () => {
    expect(addDays('2026-08-25', 30)).toBe('2026-09-24');
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });

  /**
   * ★ D104（v3.93 自裁 · 收紧"读哪一段"）：只认**尾款/余额那一段**的天数，前置的生产期/在途期不许参与。
   *   改前是 `terms.match(/(\d+)\s*days?/i)` 取**第一个** `N days` ⇒ 复核实测的两个反例：
   *   · `Production lead time 75 days; balance net 30 days` 读成 **75** ⇒ 到期日晚 45 天、**静默漏催**
   *   · `Transit 30 days; balance 45 days after arrival` 读成 **30** ⇒ 到期日早 15 天、**可能对按时付款的客户发催款函**
   */
  it('★ D104：只认尾款那一段 —— 前置生产期/在途期不许被当成账期', () => {
    expect(parseCreditDaysFromPaymentTerms('Production lead time 75 days; balance net 30 days'), '生产期被当成账期 ⇒ 漏催').toBe(30);
    expect(parseCreditDaysFromPaymentTerms('Transit 30 days; balance 45 days after arrival'), '在途期被当成账期 ⇒ 误催').toBe(45);
    // 回归：原有那条不许被改坏（尾款段带 `against B/L`）
    expect(parseCreditDaysFromPaymentTerms('T/T 30% deposit, 70% against B/L 30 days')).toBe(30);
    // 单段写法照旧认：全串只有一个天数且没有分期标记 ⇒ 它就是这个口径
    expect(parseCreditDaysFromPaymentTerms('O/A 60 days')).toBe(60);
    // 认不出哪一段是尾款 ⇒ null（**宁可让调用方留痕，也不许挑一个数当账期**）
    expect(parseCreditDaysFromPaymentTerms('deposit 20 days; shipment 15 days')).toBeNull();
    // 越界钳位口径不动
    expect(parseCreditDaysFromPaymentTerms('balance net 400 days')).toBeNull();
  });
});

// ═══ 批次登记 ═══
describe('批次登记', () => {
  it('单批登记：金额按占比推导 + 自动末批 + batchNo=1 + 客户快照', async () => {
    const { prisma, state } = makePrisma({ orders: [ORDER] });
    const r = await createOrderShipmentBatchService(prisma).createBatch({
      orderId: 'O-1', plannedRatio: 60, unit: 'm',
    });
    expect(r.ok).toBe(true);
    const b = r.data;
    expect(b.batchNo).toBe(1);
    expect(b.amount).toBe(60000); // 100000 × 60%
    expect(b.currency).toBe('USD');
    expect(b.isFinalBatch).toBe(true); // 单批自动末批
    expect(b.status).toBe('planned');
    expect(b.settleStatus).toBe('unsettled');
    expect(b.customerName).toBe('Atlas');
    expect(state.batches).toHaveLength(1);
  });

  it('多批登记：batchNo 递增；第二批显式 isFinalBatch=true 且首批已让位（显式 false）', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER],
      batches: [{
        id: 'OSB__1', orderId: 'O-1', batchNo: 1, shipmentId: null,
        plannedRatio: '60.00', plannedQty: null, unit: 'm', amount: '60000', currency: 'USD',
        customerRelationId: 'REL-ATLAS', customerName: 'Atlas',
        status: 'planned', shippedAt: null, settleStatus: 'unsettled',
        invoicedAmount: null, paidAmount: null, settledAt: null,
        isFinalBatch: false, finalPaymentDueDays: null, finalPaymentDueDate: null,
        notes: null, createdAt: NOW, updatedAt: NOW, deletedAt: null,
      }],
    });
    const r = await createOrderShipmentBatchService(prisma).createBatch({
      orderId: 'O-1', plannedRatio: 40, isFinalBatch: true,
    });
    expect(r.ok).toBe(true);
    expect(r.data.batchNo).toBe(2);
    expect(r.data.amount).toBe(40000);
    expect(r.data.isFinalBatch).toBe(true);
  });

  it('占比合计 >100% 拒绝；订单不存在 404；无任何量化字段拒绝', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER],
      batches: [{
        id: 'OSB__1', orderId: 'O-1', batchNo: 1, plannedRatio: '60.00',
        amount: '60000', currency: 'USD', status: 'planned', isFinalBatch: false,
        settleStatus: 'unsettled', createdAt: NOW, updatedAt: NOW, deletedAt: null,
      }],
    });
    const svc = createOrderShipmentBatchService(prisma);
    const r1 = await svc.createBatch({ orderId: 'O-1', plannedRatio: 50 }); // 60+50>100
    expect(r1.ok).toBe(false);
    expect(r1.error.code).toBe('RATIO_EXCEEDED');

    const r2 = await svc.createBatch({ orderId: 'O-404', plannedRatio: 10 });
    expect(r2.ok).toBe(false);
    expect(r2.error.code).toBe('ORDER_NOT_FOUND');
    expect(r2.error.status).toBe(404);

    const r3 = await svc.createBatch({ orderId: 'O-1', isFinalBatch: false });
    expect(r3.ok).toBe(false);
    expect(r3.error.code).toBe('VALIDATION_FAILED');
  });

  it('排船回填：运单不存在 404；运单已取消 409', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER],
      shipments: [{ id: 'SHP-1', status: 'Cancelled', deletedAt: null }],
    });
    const svc = createOrderShipmentBatchService(prisma);
    const r1 = await svc.createBatch({ orderId: 'O-1', plannedRatio: 100, shipmentId: 'SHP-404' });
    expect(r1.error.code).toBe('SHIPMENT_NOT_FOUND');
    const r2 = await svc.createBatch({ orderId: 'O-1', plannedRatio: 100, shipmentId: 'SHP-1' });
    expect(r2.error.code).toBe('SHIPMENT_CANCELLED');
  });
});

// ═══ 状态机与更新 ═══
describe('批次更新与状态机', () => {
  it('计划期可改占比并重推金额；末批转移（旧末批显式置 false 时通过唯一性校验）', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER],
      batches: [{
        id: 'OSB__1', orderId: 'O-1', batchNo: 1, shipmentId: null,
        plannedRatio: '60.00', plannedQty: null, unit: null, amount: '60000', currency: 'USD',
        customerRelationId: null, customerName: 'Atlas', status: 'planned', shippedAt: null,
        settleStatus: 'unsettled', invoicedAmount: null, paidAmount: null, settledAt: null,
        isFinalBatch: true, finalPaymentDueDays: null, finalPaymentDueDate: null,
        notes: null, createdAt: NOW, updatedAt: NOW, deletedAt: null,
      }],
    });
    const r = await createOrderShipmentBatchService(prisma).updateBatch('OSB__1', { plannedRatio: 50 });
    expect(r.ok).toBe(true);
    expect(r.data.amount).toBe(50000); // 重推
  });

  it('已发运：计划字段冻结（PLAN_FROZEN）+ 不可取消（ALREADY_SHIPPED）', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER],
      batches: [{
        id: 'OSB__1', orderId: 'O-1', batchNo: 1, shipmentId: 'SHP-1',
        plannedRatio: '100.00', amount: '100000', currency: 'USD',
        status: 'shipped', shippedAt: NOW, settleStatus: 'unsettled',
        isFinalBatch: true, finalPaymentDueDate: '2026-09-01',
        createdAt: NOW, updatedAt: NOW, deletedAt: null,
      }],
    });
    const svc = createOrderShipmentBatchService(prisma);
    const r1 = await svc.updateBatch('OSB__1', { plannedRatio: 80 });
    expect(r1.error.code).toBe('PLAN_FROZEN');
    const r2 = await svc.updateBatch('OSB__1', { status: 'cancelled' });
    expect(r2.error.code).toBe('ALREADY_SHIPPED');
  });

  it('计划期 planned→cancelled 合法；cancelled 后计划冻结', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER],
      batches: [{
        id: 'OSB__1', orderId: 'O-1', batchNo: 1, plannedRatio: '100.00', amount: '100000',
        currency: 'USD', status: 'planned', settleStatus: 'unsettled', isFinalBatch: true,
        createdAt: NOW, updatedAt: NOW, deletedAt: null,
      }],
    });
    const svc = createOrderShipmentBatchService(prisma);
    const r1 = await svc.updateBatch('OSB__1', { status: 'cancelled' });
    expect(r1.ok).toBe(true);
    expect(r1.data.status).toBe('cancelled');
    const r2 = await svc.updateBatch('OSB__1', { plannedRatio: 50 });
    expect(r2.error.code).toBe('PLAN_FROZEN');
  });
});

// ═══ 发运确认与末批门禁 ═══
describe('批次发运确认（markShipped）', () => {
  const baseBatch = (over: any = {}) => ({
    id: 'OSB__F', orderId: 'O-1', batchNo: 2, shipmentId: 'SHP-2',
    plannedRatio: '40.00', amount: '40000', currency: 'USD',
    customerName: 'Atlas', status: 'planned', shippedAt: null,
    settleStatus: 'unsettled', invoicedAmount: null, paidAmount: null, settledAt: null,
    isFinalBatch: true, finalPaymentDueDays: null, finalPaymentDueDate: null,
    createdAt: NOW, updatedAt: NOW, deletedAt: null, ...over,
  });
  const SHIPMENT = { id: 'SHP-2', status: 'Shipped', atd: '2026-08-20', deletedAt: null };

  it('未排船拒绝；末批已收不足阻断（FINAL_PAYMENT_GATE_BLOCKED 409）', async () => {
    const { prisma } = makePrisma({ orders: [ORDER], batches: [baseBatch({ shipmentId: null })] });
    const r1 = await createOrderShipmentBatchService(prisma).markShipped('OSB__F');
    expect(r1.error.code).toBe('SHIPMENT_REQUIRED');

    // 已排船但零收款：末批门禁 = 订单 100000 − 末批 40000 = 60000 须已收
    const { prisma: p2 } = makePrisma({
      orders: [ORDER], shipments: [SHIPMENT], batches: [baseBatch()],
    });
    const r2 = await createOrderShipmentBatchService(p2).markShipped('OSB__F');
    expect(r2.error.code).toBe('FINAL_PAYMENT_GATE_BLOCKED');
    expect(r2.error.status).toBe(409);
    expect(r2.error.message).toContain('60000');
  });

  it('末批收款足额放行：尾款到期日 = 发运日 + paymentTerms 账期 30 天', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER], shipments: [SHIPMENT], batches: [baseBatch()],
      ioAllocations: [{ id: 'IOA-1', invoiceId: 'INV-1', orderId: 'O-1', batchId: 'OSB__E', allocatedAmount: '60000', deletedAt: null }],
      invoices: [{ id: 'INV-1', amount: '60000', currency: 'USD', status: 'Issued', deletedAt: null }],
      invoiceAllocations: [{ id: 'IA-1', invoiceId: 'INV-1', appliedAmount: '60000', deletedAt: null }],
    });
    const r = await createOrderShipmentBatchService(prisma).markShipped('OSB__F');
    expect(r.ok).toBe(true);
    expect(r.data.status).toBe('shipped');
    expect(r.data.finalPaymentDueDate).toBe('2026-09-19'); // 2026-08-20 + 30d
  });

  it('本批 finalPaymentDueDays 覆盖 paymentTerms；skipGate 豁免可过（留痕）', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER], shipments: [SHIPMENT], batches: [baseBatch({ finalPaymentDueDays: 60 })],
    });
    const svc = createOrderShipmentBatchService(prisma);
    const r = await svc.markShipped('OSB__F', { skipGate: true });
    expect(r.ok).toBe(true);
    expect(r.data.finalPaymentDueDate).toBe('2026-10-19'); // 2026-08-20 + 60d
  });

  // P0-4（2026-09-13 定案「单币种口径」）：发票币种不一致 → 报错拦截，绝不跨币种直加
  it('末批门禁：订单收款发票出现混合币种 → FINAL_PAYMENT_GATE_CURRENCY_MISMATCH（不跨币种相加）', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER], shipments: [SHIPMENT], batches: [baseBatch()],
      ioAllocations: [
        { id: 'IOA-1', invoiceId: 'INV-1', orderId: 'O-1', batchId: 'OSB__E', allocatedAmount: '60000', deletedAt: null },
        { id: 'IOA-2', invoiceId: 'INV-2', orderId: 'O-1', batchId: 'OSB__E', allocatedAmount: '60000', deletedAt: null },
      ],
      invoices: [
        { id: 'INV-1', amount: '60000', currency: 'USD', status: 'Issued', deletedAt: null },
        { id: 'INV-2', amount: '60000', currency: 'EUR', status: 'Issued', deletedAt: null },
      ],
      invoiceAllocations: [
        { id: 'IA-1', invoiceId: 'INV-1', appliedAmount: '60000', deletedAt: null },
        { id: 'IA-2', invoiceId: 'INV-2', appliedAmount: '60000', deletedAt: null },
      ],
    });
    const r = await createOrderShipmentBatchService(prisma).markShipped('OSB__F');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FINAL_PAYMENT_GATE_CURRENCY_MISMATCH');
    expect(r.error.status).toBe(409);
  });

  it('末批门禁：发票币种与门禁币种不符（USD 单 vs CNY 票）→ 同样拦截', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER], shipments: [SHIPMENT], batches: [baseBatch()],
      ioAllocations: [{ id: 'IOA-1', invoiceId: 'INV-1', orderId: 'O-1', batchId: 'OSB__E', allocatedAmount: '60000', deletedAt: null }],
      invoices: [{ id: 'INV-1', amount: '60000', currency: 'CNY', status: 'Issued', deletedAt: null }],
      invoiceAllocations: [{ id: 'IA-1', invoiceId: 'INV-1', appliedAmount: '60000', deletedAt: null }],
    });
    const r = await createOrderShipmentBatchService(prisma).markShipped('OSB__F');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('FINAL_PAYMENT_GATE_CURRENCY_MISMATCH');
  });
});

// ═══ 结算聚合 ═══
describe('结算进度聚合（recalcSettlement）', () => {
  const BATCH = {
    id: 'OSB__1', orderId: 'O-1', batchNo: 1, amount: '60000', currency: 'USD',
    status: 'shipped', settleStatus: 'unsettled', isFinalBatch: false,
    invoicedAmount: null, paidAmount: null, settledAt: null,
    createdAt: NOW, updatedAt: NOW, deletedAt: null,
  };

  it('invoiced/paid 快照回写：部分收款 → partially_settled；足额 → settled + settledAt', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER], batches: [{ ...BATCH }],
      ioAllocations: [{ id: 'IOA-1', invoiceId: 'INV-1', orderId: 'O-1', batchId: 'OSB__1', allocatedAmount: '60000', deletedAt: null }],
      invoices: [{ id: 'INV-1', amount: '60000', currency: 'USD', status: 'Issued', deletedAt: null }],
      invoiceAllocations: [{ id: 'IA-1', invoiceId: 'INV-1', appliedAmount: '20000', deletedAt: null }],
    });
    const svc = createOrderShipmentBatchService(prisma);
    const r1 = await svc.recalcSettlement('OSB__1');
    expect(r1.ok).toBe(true);
    expect(r1.data.invoicedAmount).toBe(60000);
    expect(r1.data.paidAmount).toBe(20000);
    expect(r1.data.settleStatus).toBe('partially_settled');

    // 再收 40000 → 结清
    const { prisma: p2 } = makePrisma({
      orders: [ORDER], batches: [{ ...BATCH }],
      ioAllocations: [{ id: 'IOA-1', invoiceId: 'INV-1', orderId: 'O-1', batchId: 'OSB__1', allocatedAmount: '60000', deletedAt: null }],
      invoices: [{ id: 'INV-1', amount: '60000', currency: 'USD', status: 'Issued', deletedAt: null }],
      invoiceAllocations: [
        { id: 'IA-1', invoiceId: 'INV-1', appliedAmount: '20000', deletedAt: null },
        { id: 'IA-2', invoiceId: 'INV-1', appliedAmount: '40000', deletedAt: null },
      ],
    });
    const r2 = await createOrderShipmentBatchService(p2).recalcSettlement('OSB__1');
    expect(r2.data.paidAmount).toBe(60000);
    expect(r2.data.settleStatus).toBe('settled');
    expect(r2.data.settledAt).not.toBeNull();
  });

  it('作废发票不计入；allocatedAmount 缺省按发票全额；无分配保持 unsettled', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER], batches: [{ ...BATCH }],
      ioAllocations: [
        { id: 'IOA-1', invoiceId: 'INV-1', orderId: 'O-1', batchId: 'OSB__1', allocatedAmount: null, deletedAt: null },
        { id: 'IOA-2', invoiceId: 'INV-2', orderId: 'O-1', batchId: 'OSB__1', allocatedAmount: '5000', deletedAt: null },
      ],
      invoices: [
        { id: 'INV-1', amount: '60000', currency: 'USD', status: 'Cancelled', deletedAt: null },
        { id: 'INV-2', amount: '5000', currency: 'USD', status: 'Issued', deletedAt: null },
      ],
      invoiceAllocations: [],
    });
    const r = await createOrderShipmentBatchService(prisma).recalcSettlement('OSB__1');
    // INV-1 作废不计；INV-2 无核销 → invoiced=5000, paid=0, unsettled
    expect(r.data.invoicedAmount).toBe(5000);
    expect(r.data.paidAmount).toBe(0);
    expect(r.data.settleStatus).toBe('unsettled');
  });
});

// ═══ 尾款看板 ═══
describe('尾款看板（listOverdueFinalBatches）', () => {
  it('到期未结清末批列出；已结清/未到期/非末批排除', async () => {
    const mk = (over: any) => ({
      orderId: 'O-1', batchNo: 1, amount: '40000', currency: 'USD',
      status: 'shipped', settleStatus: 'unsettled', isFinalBatch: true,
      createdAt: NOW, updatedAt: NOW, deletedAt: null, ...over,
    });
    const { prisma } = makePrisma({
      orders: [ORDER],
      batches: [
        mk({ id: 'B1', finalPaymentDueDate: '2026-08-01' }),            // 到期未结 → 列出
        mk({ id: 'B2', finalPaymentDueDate: '2026-08-01', settleStatus: 'settled' }), // 已结清 → 排除
        mk({ id: 'B3', finalPaymentDueDate: '2026-12-31' }),            // 未到期 → 排除
        mk({ id: 'B4', finalPaymentDueDate: '2026-08-01', isFinalBatch: false }),     // 非末批 → 排除
      ],
    });
    const r = await createOrderShipmentBatchService(prisma).listOverdueFinalBatches();
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data[0].id).toBe('B1');
    expect(r.data[0].finalPaymentOverdue).toBe(true);
  });
});

// ═══ 订单全景 ═══
describe('订单批次全景（listByOrder）', () => {
  it('批次列表 + 汇总（计划/开票/收款合计 + allShipped）', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER],
      batches: [
        { id: 'B1', orderId: 'O-1', batchNo: 1, amount: '60000', currency: 'USD', status: 'shipped', settleStatus: 'settled', invoicedAmount: '60000', paidAmount: '60000', isFinalBatch: false, createdAt: NOW, updatedAt: NOW, deletedAt: null },
        { id: 'B2', orderId: 'O-1', batchNo: 2, amount: '40000', currency: 'USD', status: 'planned', settleStatus: 'unsettled', invoicedAmount: '0', paidAmount: '0', isFinalBatch: true, createdAt: NOW, updatedAt: NOW, deletedAt: null },
      ],
    });
    const r = await createOrderShipmentBatchService(prisma).listByOrder('O-1');
    expect(r.ok).toBe(true);
    expect(r.data.batches).toHaveLength(2);
    expect(r.data.summary.totalPlannedAmount).toBe(100000);
    expect(r.data.summary.totalPaid).toBe(60000);
    expect(r.data.summary.allShipped).toBe(false);
    expect(r.data.order.poNumber).toBe('PO-2601001');
  });
});

// ═══ W-B 断层④：Shipment→Shipped 自动联动 ═══
describe('Shipment→Shipped 自动联动（autoAdvanceOnShipmentShipped）', () => {
  const SHIPMENT = { id: 'SHP-1', orderId: 'O-1', status: 'Shipped', atd: '2026-08-20', deletedAt: null };
  const mkBatch = (over: any) => ({
    orderId: 'O-1', batchNo: 1, shipmentId: 'SHP-1',
    plannedRatio: '100.00', amount: '100000', currency: 'USD',
    customerRelationId: 'REL-ATLAS', customerName: 'Atlas',
    status: 'planned', shippedAt: null, settleStatus: 'unsettled',
    invoicedAmount: null, paidAmount: null, settledAt: null,
    isFinalBatch: false, finalPaymentDueDays: null, finalPaymentDueDate: null,
    notes: null, createdAt: NOW, updatedAt: NOW, deletedAt: null, ...over,
  });

  it('挂接 planned 批次 → 推进 shipped，shippedAt 取运单 atd，尾款到期日 = atd + 账期', async () => {
    const { prisma, state } = makePrisma({
      orders: [ORDER],
      shipments: [SHIPMENT],
      batches: [mkBatch({ id: 'B1', isFinalBatch: true })],
    });
    const svc = createOrderShipmentBatchService(prisma);
    const r = await svc.autoAdvanceOnShipmentShipped('SHP-1', 'system');
    expect(r.advanced).toEqual(['B1']);
    expect(r.failed).toHaveLength(0);
    const b = state.batches.find(x => x.id === 'B1');
    expect(b.status).toBe('shipped');
    expect(Number(b.shippedAt)).toBe(Date.parse('2026-08-20T00:00:00Z'));
    // 末批到期日 = atd 2026-08-20 + 30 天（paymentTerms 解析）= 2026-09-19
    expect(b.finalPaymentDueDate).toBe('2026-09-19');
  });

  it('幂等：已 shipped / 已 cancelled 批次不重复推进（终态不复活）', async () => {
    const { prisma, state } = makePrisma({
      orders: [ORDER],
      shipments: [SHIPMENT],
      batches: [
        mkBatch({ id: 'B1', status: 'shipped', shippedAt: NOW }),
        mkBatch({ id: 'B2', batchNo: 2, status: 'cancelled' }),
      ],
    });
    const r = await createOrderShipmentBatchService(prisma).autoAdvanceOnShipmentShipped('SHP-1', 'system');
    expect(r.advanced).toHaveLength(0);
    expect(r.failed).toHaveLength(0);
    expect(state.batches.find(x => x.id === 'B1').status).toBe('shipped');
    expect(state.batches.find(x => x.id === 'B2').status).toBe('cancelled');
  });

  it('归属判定：未挂接（shipmentId=null）或挂其他运单的批次不受影响', async () => {
    const { prisma, state } = makePrisma({
      orders: [ORDER],
      shipments: [SHIPMENT],
      batches: [
        mkBatch({ id: 'B1', shipmentId: null }),
        mkBatch({ id: 'B2', batchNo: 2, shipmentId: 'SHP-OTHER' }),
      ],
    });
    const r = await createOrderShipmentBatchService(prisma).autoAdvanceOnShipmentShipped('SHP-1', 'system');
    expect(r.advanced).toHaveLength(0);
    expect(state.batches.every(b => b.status === 'planned')).toBe(true);
  });

  it('末批尾款缺口：物理事实优先仍推进，审计留痕 skipGate+autoLinkage', async () => {
    const { writeRouteAuditLog } = await import('../../audit/routeAudit');
    const { prisma, state } = makePrisma({
      orders: [ORDER],
      shipments: [SHIPMENT],
      // 末批 40000，订单 100000，已收 0 < 门禁线 60000 → 人工 mark-shipped 会被 FINAL_PAYMENT_GATE_BLOCKED
      batches: [mkBatch({ id: 'B1', isFinalBatch: true, amount: '40000' })],
    });
    const r = await createOrderShipmentBatchService(prisma).autoAdvanceOnShipmentShipped('SHP-1', 'system');
    expect(r.advanced).toEqual(['B1']);
    expect(state.batches.find(x => x.id === 'B1').status).toBe('shipped');
    const auditCalls = (writeRouteAuditLog as any).mock.calls.filter((c: any[]) => c[0]?.operation === 'mark_batch_shipped');
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0][0].after.skipGate).toBe(true);
    expect(auditCalls[0][0].after.autoLinkage).toBe(true);
    expect(auditCalls[0][0].actorId).toBe('system');
  });

  it('best-effort：数据层异常不 throw，返回空结果并记录告警', async () => {
    const { prisma } = makePrisma({ orders: [ORDER] });
    prisma.orderShipmentBatch.findMany = async () => { throw new Error('db down'); };
    const r = await createOrderShipmentBatchService(prisma).autoAdvanceOnShipmentShipped('SHP-1', 'system');
    expect(r.advanced).toHaveLength(0);
    expect(r.failed).toHaveLength(0);
  });
});

// ═══ 结清分母真源（settleBasisOf，零依赖纯函数） ═══
describe("settleBasisOf：结清分母真源", () => {
  it("未开票 ⇒ 用计划额（保留出运前「计划回款进度」语义）", () => {
    expect(settleBasisOf(60000, 0)).toBe(60000);
    expect(settleBasisOf(60000, null)).toBe(60000);
  });

  it("★ 短装（已开票 < 计划额）⇒ 用已开票额 —— 否则批次永远结不清", () => {
    expect(settleBasisOf(60000, 55000)).toBe(55000);
  });

  it("溢装（已开票 > 计划额）⇒ 用计划额（min，与旧行为一致，不回退）", () => {
    expect(settleBasisOf(60000, 65000)).toBe(60000);
  });

  it("同额 ⇒ 与旧行为逐字节一致", () => {
    expect(settleBasisOf(60000, 60000)).toBe(60000);
  });

  it("边界：计划额缺省/为 0 ⇒ 用已开票额；两者皆缺 ⇒ null（不瞎判）", () => {
    expect(settleBasisOf(null, 55000)).toBe(55000);
    expect(settleBasisOf(0, 55000)).toBe(55000);
    expect(settleBasisOf(null, 0)).toBeNull();
    expect(settleBasisOf(null, null)).toBeNull();
  });
});

// ═══ 结清分母：短装（2026-09-19 修） ═══
// 背景：batch.amount 是**计划额**（订单额 × plannedRatio%），而短装（实际出运 < 计划，
// 纺织服装常规情形 / 甲方 ±5% 溢短装条款）时「已开票额」必然小于计划额。
// 旧判据 `paid >= amount` 下这类批次**永远结不清** → 被 watchdog「到期未结清末批」反复误催。
// 修法：已开票时分母取 min(计划额, 已开票额)；未开票时仍取计划额。
describe('结清分母：短装 / 溢装 / 未开票（分母 = min(计划额, 已开票额)）', () => {
  const PLAN = '60000';
  const B = (over: Record<string, unknown> = {}) => ({
    id: 'OSB__1', orderId: 'O-1', batchNo: 1, amount: PLAN, currency: 'USD',
    status: 'shipped', settleStatus: 'unsettled', isFinalBatch: false,
    invoicedAmount: null, paidAmount: null, settledAt: null,
    createdAt: NOW, updatedAt: NOW, deletedAt: null, ...over,
  });
  const fx = (allocated: string, applied: string[]) => ({
    orders: [ORDER], batches: [B()],
    ioAllocations: [{ id: 'IOA-1', invoiceId: 'INV-1', orderId: 'O-1', batchId: 'OSB__1', allocatedAmount: allocated, deletedAt: null }],
    invoices: [{ id: 'INV-1', amount: allocated, currency: 'USD', status: 'Issued', deletedAt: null }],
    invoiceAllocations: applied.map((a, i) => ({ id: `IA-${i}`, invoiceId: 'INV-1', appliedAmount: a, deletedAt: null })),
  });

  it('★ 短装：实际开票 55,000 且已收齐 55,000（< 计划 60,000）⇒ settled', async () => {
    const { prisma } = makePrisma(fx('55000', ['55000']));
    const r = await createOrderShipmentBatchService(prisma).recalcSettlement('OSB__1');
    expect(r.ok).toBe(true);
    expect(r.data.invoicedAmount).toBe(55000);
    expect(r.data.paidAmount).toBe(55000);
    // 旧判据（paid >= 计划额 60000）会判 partially_settled ⇒ 该批永远结不清
    expect(r.data.settleStatus).toBe('settled');
    expect(r.data.settledAt).not.toBeNull();
  });

  it('阴性对照：短装且只收一半（27,500 / 55,000）⇒ partially_settled（不得一律判 settled）', async () => {
    const { prisma } = makePrisma(fx('55000', ['27500']));
    const r = await createOrderShipmentBatchService(prisma).recalcSettlement('OSB__1');
    expect(r.data.settleStatus).toBe('partially_settled');
    expect(r.data.settledAt).toBeNull();
  });

  it('阴性对照：短装且分文未收 ⇒ unsettled', async () => {
    const { prisma } = makePrisma(fx('55000', []));
    const r = await createOrderShipmentBatchService(prisma).recalcSettlement('OSB__1');
    expect(r.data.settleStatus).toBe('unsettled');
  });

  it('回归：未开票（invoiced=0）时仍按计划额判 —— 收 20,000/60,000 ⇒ partially_settled', async () => {
    const { prisma } = makePrisma({
      orders: [ORDER], batches: [B()], ioAllocations: [], invoices: [], invoiceAllocations: [],
    });
    // 无发票分配 ⇒ invoiced=0、paid=0 ⇒ 维持 unsettled（分母缺省不瞎判）
    const r = await createOrderShipmentBatchService(prisma).recalcSettlement('OSB__1');
    expect(r.data.invoicedAmount).toBe(0);
    expect(r.data.paidAmount).toBe(0);
    expect(r.data.settleStatus).toBe('unsettled');
  });

  it('回归：溢装（开票 65,000 > 计划 60,000）收齐 65,000 ⇒ settled', async () => {
    const { prisma } = makePrisma(fx('65000', ['65000']));
    const r = await createOrderShipmentBatchService(prisma).recalcSettlement('OSB__1');
    expect(r.data.settleStatus).toBe('settled');
  });

  it('回归：溢装只收计划额（60,000 / 开票 65,000）⇒ settled（min 取计划额，与旧行为一致，不回退）', async () => {
    const { prisma } = makePrisma(fx('65000', ['60000']));
    const r = await createOrderShipmentBatchService(prisma).recalcSettlement('OSB__1');
    expect(r.data.settleStatus).toBe('settled');
  });
});

/**
 * §9 **B39** · 位置参数内插原文的执行覆盖（R3 / §6 S1）
 *
 * 本批把该文件 3 处 ``fail(CODE, `…失败: ${String(e?.message ?? e)}`, 500)`` 换成字面中文，
 * **并补上该文件原本没有的 `logger.error`**（实测 `logger.error` 计数为 0，只有 info/warn）—— D51。
 *
 * ★ 三处的文案**故意不同**（**D52**：形状相同 ≠ 文案相同），差别由 `catch` 的覆盖面决定：
 *   · `createBatch`（`:244` 起）：try 内**唯一写**就是 `$transaction`，之后只有 `return` ⇒ 可承诺零改动；
 *   · `updateBatch`（`:352` 起）：同上 ⇒ 可承诺零改动；
 *   · `markShipped`（`:577` 起）：try 在 `$transaction` **之前**还有 `await recalcSettlement(batchId)`
 *     （`:528`，**无 tx ⇒ 直写库**，刷新结算快照）⇒ **不许承诺任何写入状态**。
 */
const B39_RAW = 'PrismaClientKnownRequestError: Invalid `prisma.$transaction()` invocation in '
  + '/srv/app/server/src/shipping/orderShipmentBatchService.ts:244 — '
  + 'Unique constraint failed on the fields: (`batchNo`)';
const B39_FRAGMENTS = ['PrismaClient', 'prisma.$transaction', 'orderShipmentBatchService.ts:244', 'Unique constraint', '/srv/app', 'P2002'];

function expectB39Copy(msg: unknown, mustMention: string) {
  expect(typeof msg).toBe('string');
  const s = msg as string;
  expect(s.length, `文案过短（${s.length} 字）：${s}`).toBeGreaterThanOrEqual(20);
  expect(s, '必须含中文').toMatch(/[\u4e00-\u9fa5]/);
  expect(s, `必须说清对象：${s}`).toContain(mustMention);
  expect(s, `必须给下一步：${s}`).toMatch(/(稍后重试|联系管理员)/);
  expect(s.match(/[A-Za-z]{3,}/g) ?? [], `混入拉丁词（疑似原文上屏）：${s}`).toEqual([]);
}

describe('§9 B39 · 批次动作事务失败时用户收到的是中文，不是 Prisma 原文', () => {
  const BATCH_PLANNED = {
    id: 'OSB__1', orderId: 'O-1', batchNo: 1, shipmentId: null,
    plannedRatio: '60.00', plannedQty: null, unit: null, amount: '60000', currency: 'USD',
    customerRelationId: null, customerName: 'Atlas', status: 'planned', shippedAt: null,
    settleStatus: 'unsettled', invoicedAmount: null, paidAmount: null, settledAt: null,
    isFinalBatch: true, finalPaymentDueDays: null, finalPaymentDueDate: null,
    notes: null, createdAt: NOW, updatedAt: NOW, deletedAt: null,
  };
  const BATCH_SHIPPABLE = { ...BATCH_PLANNED, id: 'OSB__F', batchNo: 2, shipmentId: 'SHP-2', isFinalBatch: false };
  const SHIPMENT = { id: 'SHP-2', status: 'Shipped', atd: '2026-08-20', deletedAt: null };

  function withFailingTx(prisma: any) {
    prisma.$transaction = async () => { throw new Error(B39_RAW); };
    return prisma;
  }

  it('createBatch：500 + 码名不变 + 中文 + 零原文，且**承诺本次未确认任何改动**', async () => {
    const { prisma } = makePrisma({ orders: [ORDER] });
    const r = await createOrderShipmentBatchService(withFailingTx(prisma))
      .createBatch({ orderId: 'O-1', plannedRatio: 60, unit: 'm' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code, '码名不得随文案一起改（前端按码分支）').toBe('CREATE_FAILED');
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectB39Copy(r.error.message, '批次登记');
    expect(r.error.message, '唯一写是 $transaction ⇒ 可以承诺').toContain('本次未确认任何改动');
    expect(logger.error, '原文必须仍进日志（本文件原先一处 logger.error 都没有）').toHaveBeenCalledWith(
      expect.stringContaining('[OrderShipmentBatch]'), expect.objectContaining({ error: B39_RAW }));
  });

  it('updateBatch：500 + 码名不变 + 中文 + 零原文，且**承诺本次未确认任何改动**', async () => {
    const { prisma } = makePrisma({ orders: [ORDER], batches: [{ ...BATCH_PLANNED }] });
    const r = await createOrderShipmentBatchService(withFailingTx(prisma))
      .updateBatch('OSB__1', { plannedRatio: 50 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UPDATE_FAILED');
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectB39Copy(r.error.message, '批次更新');
    expect(r.error.message).toContain('本次未确认任何改动');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[OrderShipmentBatch]'), expect.objectContaining({ error: B39_RAW }));
  });

  it('markShipped：500 + 码名不变 + 中文 + 零原文，且**不许承诺写入状态**（事务前已刷新结算快照）', async () => {
    const { prisma } = makePrisma({ orders: [ORDER], shipments: [SHIPMENT], batches: [{ ...BATCH_SHIPPABLE }] });
    const r = await createOrderShipmentBatchService(withFailingTx(prisma)).markShipped('OSB__F');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SHIP_FAILED');
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectB39Copy(r.error.message, '批次发运确认');
    // ★ D52：事务前有 recalcSettlement（:528，无 tx ⇒ 直写库）⇒ 不许给"零改动"这类假结论
    expect(r.error.message, 'markShipped 事务前已有副作用 ⇒ 不得承诺写入状态')
      .not.toMatch(/(没有写入任何数据|本次未确认任何改动|本次改动未生效)/);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[OrderShipmentBatch]'), expect.objectContaining({ error: B39_RAW }));
  });
});
