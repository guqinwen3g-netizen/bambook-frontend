/**
 * Phase 1 Sprint 3 — 联动执行器单元测试
 *
 * 覆盖：
 *   L1: OrderConfirmed → initProductionStages（含幂等检查）
 *   L2: ProductionCompleted → createShipment（含已存在跳过、订单未找到）
 *   L3: ShipmentCompleted → createInvoice（含已存在跳过、无金额跳过）
 *   L5: PaymentVoucherCreated → autoAllocate（含匹配发票、无匹配跳过、非 Receipt 跳过）
 *
 * 测试策略：
 *   - Mock prisma（避免真实 DB）
 *   - Mock service 函数（createShipment/createInvoice/createAllocation/initProductionStages）
 *   - 验证幂等性：相同事件不重复执行
 *   - 验证失败恢复：失败后可重试
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

// Mock 依赖服务
vi.mock('../../../production/stageService', () => ({
  initProductionStages: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../shipping/shipmentMutationService', () => ({
  createShipment: vi.fn(),
}));
vi.mock('../../../finance/invoiceMutationService', () => ({
  createInvoice: vi.fn(),
}));
vi.mock('../../../finance/allocationMutationService', () => ({
  createAllocation: vi.fn(),
}));
vi.mock('../../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { businessEventBus, publishBusinessEvent } from '../../businessEventBus';
import { initProductionStages } from '../../../production/stageService';
import { createShipment } from '../../../shipping/shipmentMutationService';
import { createInvoice } from '../../../finance/invoiceMutationService';
import { createAllocation } from '../../../finance/allocationMutationService';
import { registerAllLinkages } from '../index';
import { issueShipmentInvoiceDrafts } from '../L3IssueInvoice';

// Explicit synthetic persisted source for the real verifier and lock helpers.
// This is storage-shape coverage, not evidence of a native PG transition or
// canonical Invoice atomicity. Original downstream spies stay output seams.
const DELIVERY_AUDIT_ID = 'delivered-shp_1';
function orderStorageRead() {
  let row: any = null;
  const read = vi.fn(async ({ where }: any) => row?.id === where.id ? row : null);
  read.mockResolvedValue = ((value: any) => {
    row = value == null ? null : { id: 'ord_1', deletedAt: null, ...value };
    return read;
  }) as typeof read.mockResolvedValue;
  return read;
}

// ── Mock Prisma 工厂 ──
function makeMockPrisma(overrides: Record<string, any> = {}) {
  const jobs = new Map<string, any>();
  const audit = { id: DELIVERY_AUDIT_ID, actorId: 'test', action: 'update_shipment', targetType: 'Shipment', targetId: 'shp_1',
    detail: { before: { status: 'Cleared' }, after: { status: 'Delivered' } } };
  const audits = new Map<string, any>([[audit.id, audit]]);
  const delivered = { id: 'shp_1', orderId: 'ord_1', deletedAt: null, status: 'Delivered', shipmentNumber: 'SHP-001', updatedAt: 2n };
  const soa = { id: 'soa-shp_1', shipmentId: 'shp_1', orderId: 'ord_1', orderLineId: null, status: 'Active', actualQty: '1.0000', plannedQty: '1.0000', unit: 'pcs' };
  const empty = () => vi.fn(async () => []);
  const db: any = {
    shipment: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(async ({ where }: any) => where.id === delivered.id ? delivered : null),
      ...overrides.shipment,
    },
    order: {
      findUnique: orderStorageRead(),
      ...overrides.order,
    },
    invoice: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      ...overrides.invoice,
    },
    paymentVoucher: {
      findUnique: vi.fn().mockResolvedValue(null),
      ...overrides.paymentVoucher,
    },
    // T2/H14：L3 批次路由依赖（count=0 → 走旧整单口径）
    orderShipmentBatch: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      ...overrides.orderShipmentBatch,
    },
    invoiceOrderAllocation: {
      findMany: vi.fn().mockResolvedValue([]),
      ...overrides.invoiceOrderAllocation,
    },
    invoiceAllocation: {
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { appliedAmount: null } }),
      ...overrides.invoiceAllocation,
    },
    agentJob: {
      create: vi.fn(async ({ data }: any) => { jobs.set(data.id, { ...data }); return data; }),
      findUnique: vi.fn(async ({ where }: any) => jobs.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => { const row = jobs.get(where.id); if (!row) throw Error('Unknown durable event'); Object.assign(row, data); return row; }),
    },
    auditLog: {
      findUnique: vi.fn(async ({ where }: any) => audits.get(where.id) ?? null),
      create: vi.fn(async ({ data }: any) => { if (audits.has(data.id)) throw Error('Duplicate audit identity'); audits.set(data.id, { ...data }); return data; }),
    },
    shipmentOrderAllocation: { findMany: vi.fn(async ({ where }: any) => where.shipmentId === soa.shipmentId ? [soa] : []) },
    shipmentProductionAllocation: { findMany: empty() }, productionBatch: { findMany: empty() },
    claimDisposition: { findMany: empty() }, repairWorkOrder: { findMany: empty() },
    sample: { findMany: empty() }, releaseScope: { findMany: empty() }, orderLine: { findMany: empty() },
    $queryRaw: vi.fn(async () => []),
    ...overrides,
  };
  db.$transaction = vi.fn(async (work: any) => work({ ...db, $transaction: undefined }));
  db.deliveryAudits = audits;
  db.durableJobs = jobs;
  return db;
}

describe('Linkage Handlers', () => {
  let prisma: any;

  beforeEach(() => {
    vi.clearAllMocks();
    businessEventBus.reset();
    prisma = makeMockPrisma();
    businessEventBus.setPrisma(prisma);
    registerAllLinkages();
  });

  // ── L1: OrderConfirmed → initProductionStages ──
  describe('L1: OrderConfirmed → initProductionStages', () => {
    it('initializes production stages when order is confirmed', async () => {
      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        orderId: 'ord_1',
        payload: { poNumber: 'PO-001', fromStatus: 'Pending' },
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(initProductionStages).toHaveBeenCalledWith(prisma, 'ord_1');
    });

    it('skips when orderId is missing', async () => {
      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        payload: {},
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(initProductionStages).not.toHaveBeenCalled();
    });

    it('does not re-execute for duplicate event (same orderId)', async () => {
      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        orderId: 'ord_1',
        payload: {},
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      await publishBusinessEvent({
        type: 'OrderConfirmed',
        sourceEntityType: 'Order',
        sourceEntityId: 'ord_1',
        orderId: 'ord_1',
        payload: {},
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(initProductionStages).toHaveBeenCalledTimes(1);
    });
  });

  // ── L2: ProductionCompleted → createShipment ──
  describe('L2: ProductionCompleted → createShipment', () => {
    it('creates shipment draft when production completes', async () => {
      prisma.order.findUnique.mockResolvedValue({
        poNumber: 'PO-001',
        customer: 'ACME Corp',
        customerRelationId: 'rel_1',
        currency: 'USD',
      });
      (createShipment as any).mockResolvedValue({
        ok: true,
        data: { shipment: { id: 'SHP_1', shipmentNumber: 'SHP-PO-001-xxx' } },
      });

      await publishBusinessEvent({
        type: 'ProductionCompleted',
        sourceEntityType: 'ProductionStage',
        sourceEntityId: 'pst_1',
        orderId: 'ord_1',
        payload: { stageKey: 'qc_shipped' },
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(createShipment).toHaveBeenCalledTimes(1);
      const callArg = (createShipment as any).mock.calls[0][0];
      expect(callArg.input.orderId).toBe('ord_1');
      expect(callArg.input.status).toBe('Draft');
      expect(callArg.input.type).toBe('Export');
      expect(callArg.actorId).toBe('system');
    });

    it('skips when shipment already exists for order', async () => {
      prisma.shipment.findFirst.mockResolvedValue({ id: 'SHP_existing', shipmentNumber: 'SHP-001' });

      await publishBusinessEvent({
        type: 'ProductionCompleted',
        sourceEntityType: 'ProductionStage',
        sourceEntityId: 'pst_1',
        orderId: 'ord_1',
        payload: {},
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(createShipment).not.toHaveBeenCalled();
    });

    it('returns not-ok when order not found', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await publishBusinessEvent({
        type: 'ProductionCompleted',
        sourceEntityType: 'ProductionStage',
        sourceEntityId: 'pst_1',
        orderId: 'ord_missing',
        payload: {},
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(createShipment).not.toHaveBeenCalled();
    });
  });

  // ── L3: ShipmentCompleted never writes accounts receivable ──
  describe('L3: ShipmentCompleted stays outside finance', () => {
    it('does not create a receivable draft when shipment is delivered', async () => {
      await publishBusinessEvent({
        type: 'ShipmentCompleted',
        transactionId: DELIVERY_AUDIT_ID,
        sourceEntityType: 'Shipment',
        sourceEntityId: 'shp_1',
        orderId: 'ord_1',
        payload: {},
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(createInvoice).not.toHaveBeenCalled();
      expect(prisma.invoice.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── L5: PaymentVoucherCreated → autoAllocate ──
  describe('L5: PaymentVoucherCreated → autoAllocate', () => {
    it('suggests a match without allocating even with explicit invoiceId', async () => {
      prisma.paymentVoucher.findUnique.mockResolvedValue({
        id: 'voc_1',
        voucherNumber: 'PAY-001',
        type: 'Receipt',
        amount: '3000.00',
        currency: 'USD',
        invoiceId: 'inv_1',
        orderId: 'ord_1',
        customerRelationId: 'rel_1',
        status: 'unreconciled',
        appliedAmount: null,
      });
      prisma.invoice.findUnique.mockResolvedValue({
        id: 'inv_1',
        invoiceNumber: 'INV-001',
        type: 'Receivable',
        amount: '5000.00',
        status: 'Issued',
        currency: 'USD',
      });
      prisma.invoiceAllocation.aggregate.mockResolvedValue({ _sum: { appliedAmount: null } });
      (createAllocation as any).mockResolvedValue({
        ok: true,
        data: {
          allocation: { id: 'alloc_1', invoiceId: 'inv_1', voucherId: 'voc_1', appliedAmount: '3000.00', appliedDate: '2026-08-06' },
          newInvoiceStatus: 'PartiallyPaid',
          newVoucherStatus: 'reconciled',
        },
      });

      await publishBusinessEvent({
        type: 'PaymentVoucherCreated',
        sourceEntityType: 'PaymentVoucher',
        sourceEntityId: 'voc_1',
        orderId: 'ord_1',
        payload: { voucherNumber: 'PAY-001', type: 'Receipt', amount: '3000.00', invoiceId: 'inv_1' },
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(createAllocation).not.toHaveBeenCalled();
      expect(prisma.invoiceAllocation.findMany).toHaveBeenCalled();
    });

    it('skips non-Receipt type vouchers', async () => {
      await publishBusinessEvent({
        type: 'PaymentVoucherCreated',
        sourceEntityType: 'PaymentVoucher',
        sourceEntityId: 'voc_2',
        payload: { type: 'Disbursement', amount: '1000.00' },
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(createAllocation).not.toHaveBeenCalled();
    });

    it('skips already reconciled vouchers', async () => {
      prisma.paymentVoucher.findUnique.mockResolvedValue({
        id: 'voc_3',
        type: 'Receipt',
        amount: '1000.00',
        status: 'reconciled',
        appliedAmount: '1000.00',
        invoiceId: null,
        orderId: null,
        customerRelationId: null,
      });

      await publishBusinessEvent({
        type: 'PaymentVoucherCreated',
        sourceEntityType: 'PaymentVoucher',
        sourceEntityId: 'voc_3',
        payload: { type: 'Receipt', amount: '1000.00' },
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(createAllocation).not.toHaveBeenCalled();
    });

    it('skips when no matching invoice found', async () => {
      prisma.paymentVoucher.findUnique.mockResolvedValue({
        id: 'voc_4',
        type: 'Receipt',
        amount: '1000.00',
        status: 'unreconciled',
        appliedAmount: null,
        invoiceId: null,
        orderId: null,
        customerRelationId: null,
      });

      await publishBusinessEvent({
        type: 'PaymentVoucherCreated',
        sourceEntityType: 'PaymentVoucher',
        sourceEntityId: 'voc_4',
        payload: { type: 'Receipt', amount: '1000.00' },
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(createAllocation).not.toHaveBeenCalled();
    });

    it('computes a suggestion without changing balances', async () => {
      prisma.paymentVoucher.findUnique.mockResolvedValue({
        id: 'voc_5',
        type: 'Receipt',
        amount: '3000.00',
        currency: 'USD',
        status: 'unreconciled',
        appliedAmount: null,
        invoiceId: 'inv_5',
        orderId: null,
        customerRelationId: null,
      });
      prisma.invoice.findUnique.mockResolvedValue({
        id: 'inv_5',
        invoiceNumber: 'INV-005',
        type: 'Receivable',
        amount: '2000.00',
        status: 'Issued',
        currency: 'USD',
      });
      prisma.invoiceAllocation.aggregate.mockResolvedValue({ _sum: { appliedAmount: null } });
      (createAllocation as any).mockResolvedValue({
        ok: true,
        data: {
          allocation: { id: 'alloc_5', appliedAmount: '2000.00' },
          newInvoiceStatus: 'Paid',
          newVoucherStatus: 'partially_reconciled',
        },
      });

      await publishBusinessEvent({
        type: 'PaymentVoucherCreated',
        sourceEntityType: 'PaymentVoucher',
        sourceEntityId: 'voc_5',
        payload: { type: 'Receipt', amount: '3000.00', invoiceId: 'inv_5' },
        actorId: 'test',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(createAllocation).not.toHaveBeenCalled();
      expect(prisma.invoiceAllocation.findMany).toHaveBeenCalled();
    });
  });

  // ── 联动注册 ──
  describe('registration', () => {
    it('registerAllLinkages is idempotent', () => {
      // Already registered in beforeEach, calling again should not throw
      expect(() => registerAllLinkages()).not.toThrow();
    });
  });
});

describe('receipt suggestions remain read-only', () => {
  it('returns the smaller remaining balance without allocating', async () => {
    const { suggestReceiptAllocation } = await import('../L5AutoAllocate');
    const db = makeMockPrisma();
    db.paymentVoucher.findUnique.mockResolvedValue({ id: 'V', type: 'Receipt', amount: 100, appliedAmount: 20, currency: 'USD', invoiceId: 'I', status: 'unreconciled' });
    db.invoice.findUnique.mockResolvedValue({ id: 'I', type: 'Receivable', amount: 200, currency: 'USD', status: 'Issued' });
    db.invoiceAllocation.findMany.mockResolvedValue([{ invoiceId: 'I', appliedAmount: 150 }]);
    vi.mocked(createAllocation).mockClear();
    const result = await suggestReceiptAllocation(db, { sourceEntityId: 'V', payload: {}, id: 'E' });
    expect(result.created).toMatchObject({ invoiceId: 'I', suggestedAmount: '50', requiresFinanceConfirmation: true });
    expect(createAllocation).not.toHaveBeenCalled();
  });
  it('does not suggest allocations for deleted receipts', async () => {
    const { suggestReceiptAllocation } = await import('../L5AutoAllocate');
    const db = makeMockPrisma();
    db.paymentVoucher.findUnique.mockResolvedValue({ type: 'Receipt', deletedAt: new Date(), status: 'unreconciled' });
    const result = await suggestReceiptAllocation(db, { sourceEntityId: 'V', payload: {}, id: 'E' });
    expect(result.created).toBeNull();
    expect(db.invoice.findUnique).not.toHaveBeenCalled();
  });
});

it('作废凭证不建议，贷项抵扣计入建议余额', async () => {
 const { suggestReceiptAllocation } = await import('../L5AutoAllocate');
 const db = makeMockPrisma();
 db.paymentVoucher.findUnique.mockResolvedValue({ type: 'Receipt', status: 'cancelled' });
 expect((await suggestReceiptAllocation(db, { sourceEntityId: 'V', payload: {}, id: 'E' })).created).toBeNull();
 db.paymentVoucher.findUnique.mockResolvedValue({ type: 'Receipt', status: 'unreconciled', amount: 100, appliedAmount: 0, currency: 'USD', invoiceId: 'I' });
 db.invoice.findUnique.mockResolvedValue({ id: 'I', type: 'Receivable', status: 'PartiallyPaid', amount: 100, currency: 'USD' });
 db.creditNoteAllocation = { findMany: vi.fn().mockResolvedValue([{ invoiceId: 'I', appliedAmount: 80 }]) };
 expect((await suggestReceiptAllocation(db, { sourceEntityId: 'V', payload: {}, id: 'E' })).created?.suggestedAmount).toBe('20');
});


describe('L3 legacy helper compatibility', () => {
  it('does no invoice or financial-source work for a legacy event id', async () => {
    businessEventBus.reset();
    vi.clearAllMocks();
    const prisma = makeMockPrisma();
    const result = await issueShipmentInvoiceDrafts(prisma, 'event-exact');
    expect(result.ok).toBe(true);
    expect(result.created).toBeNull();
    expect(createInvoice).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
