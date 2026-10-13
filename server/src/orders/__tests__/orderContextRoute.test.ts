import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOrdersRouter } from '../route';

/**
 * 阶段 D / D3：GET /api/v1/orders/:id/context 订单全链路聚合端点。
 * 覆盖：聚合正确性（嵌套装配）、空态、404。
 */

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/orders', createOrdersRouter({ prisma, requireAuth: false, apiKeys: new Set<string>() }));
  return app;
}

/** 默认全空 mock：所有 findMany 返回 []，order.findFirst 返回订单 */
function makeContextPrisma(overrides: Record<string, any> = {}) {
  const empty = vi.fn().mockResolvedValue([]);
  const prisma: any = {
    order: {
      findFirst: vi.fn().mockResolvedValue({ id: 'ORD-1', poNumber: 'PO-001', sourceCaseId: null, lines: [] }),
      findMany: vi.fn(async ({ where }: any) => {
        const source = { id: 'ORD-1' };
        const filters = Array.isArray(where?.AND) ? where.AND : [where];
        return filters.every((filter: any) => !filter?.id?.in || filter.id.in.includes(source.id)) ? [source] : [];
      }),
    },
    quotation: { findMany: empty },
    developmentCase: { findMany: empty },
    bOM: { findMany: empty },
    purchaseOrder: { findMany: empty },
    productionStage: { findMany: empty },
    inspectionReport: { findMany: empty },
    outsourcingOrder: { findMany: empty },
    shipment: { findMany: empty },
    invoice: { findMany: empty },
    invoiceOrderAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    shipmentOrderAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    paymentVoucher: { findMany: empty },
    sampleBatch: { findMany: empty }, // 消双轨 L-1：开发节点读源切 SampleBatch
    customsDeclaration: { findMany: empty },
    invoiceAllocation: { findMany: empty },
    taxRefund: { findMany: empty },
    ...overrides,
  };
  return prisma;
}

describe('GET /api/v1/orders/:id/context（阶段 D / D3）', () => {
  it('订单不存在 → 404', async () => {
    const prisma = makeContextPrisma({
      order: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const res = await request(makeApp(prisma)).get('/api/v1/orders/ORD-X/context');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('空态：无关联实体时各阶段返回空数组/空分组', async () => {
    const prisma = makeContextPrisma();
    const res = await request(makeApp(prisma)).get('/api/v1/orders/ORD-1/context');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.order).toEqual({ id: 'ORD-1', poNumber: 'PO-001' });
    expect(res.body.quotation).toEqual([]);
    expect(res.body.developmentCase).toEqual([]);
    expect(res.body.bom).toEqual([]);
    expect(res.body.procurement).toEqual([]);
    expect(res.body.production).toEqual({ stages: [], inspections: [] });
    expect(res.body.outsourcing).toEqual([]);
    expect(res.body.shipments).toEqual([]);
    expect(res.body.customsDeclarations).toEqual([]);
    expect(res.body.taxRefunds).toEqual([]);
    expect(res.body.finance).toEqual({ invoices: [], vouchers: [] });
  });

  it('全量聚合：嵌套装配（样衣节点→开发案、报关→运单、退税→报关、核销→发票）', async () => {
    const prisma = makeContextPrisma({
      quotation: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'QT-1', quotationNumber: 'QT-001', status: 'Accepted', currency: 'USD', totalAmount: 10000, issueDate: '2026-01-05' },
        ]),
      },
      developmentCase: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'DC-1', code: 'DEV-001', name: '夹克开发', type: 'garment', stage: 'approved', currentRound: 2 },
        ]),
      },
      sampleBatch: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'SB-1', developmentCaseId: 'DC-1', sampleType: 'garment-round', round: 1, status: 'sent', confirmStatus: 'confirmed', confirmedAt: 1730000000000, sentDate: '2026-02-01', approvedAt: null },
          { id: 'SB-2', developmentCaseId: 'DC-OTHER', sampleType: 'handloom', round: 1, status: 'sent', confirmStatus: 'unconfirmed', confirmedAt: null, sentDate: null, approvedAt: null },
        ]),
      },
      bOM: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'BOM-1', bomNumber: 'BOM-001', status: 'Confirmed', version: 1, totalCost: 8000, currency: 'CNY' },
        ]),
      },
      purchaseOrder: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'PO-1', poNumber: 'PON-001', status: 'Received', supplierName: 'Panda Mill', currency: 'CNY', totalAmount: 6000, orderDate: '2026-01-10', expectedDeliveryDate: '2026-02-10', actualDeliveryDate: '2026-02-08' },
        ]),
      },
      productionStage: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'PST-1', stageKey: 'order_placed', stageSeq: 1, status: 'done', startedAt: 1, doneAt: 2 },
          { id: 'PST-2', stageKey: 'qc_shipped', stageSeq: 10, status: 'pending', startedAt: null, doneAt: null },
        ]),
      },
      inspectionReport: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'INR-1', inspectionType: 'final', result: 'pass', inspectionDate: '2026-03-01', aqlLevel: '2.5/4.0 II', criticalDefects: 0, majorDefects: 2, minorDefects: 5 },
        ]),
      },
      outsourcingOrder: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'OSO-1', orderNumber: 'OSO-001', processType: 'Embroidery', status: 'InProduction', quantity: 500, unit: 'PC', plannedDeliveryDate: '2026-02-20', actualDeliveryDate: null, qualityAcceptedQty: 0, qualityRejectedQty: 0 },
        ]),
      },
      shipment: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'SHP-1', shipmentNumber: 'SH-001', status: 'Shipped', shippingMethod: 'Sea', etd: '2026-03-05', atd: '2026-03-05', eta: '2026-04-01', ata: null, portOfLoading: 'Shanghai', portOfDischarge: 'Hamburg' },
        ]),
      },
      customsDeclaration: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'CD-1', declarationNumber: 'DEC-001', status: 'Released', shipmentId: 'SHP-1', declarationDate: '2026-03-04', totalValue: 10000, currency: 'USD' },
          { id: 'CD-2', declarationNumber: 'DEC-002', status: 'Draft', shipmentId: null, declarationDate: null, totalValue: null, currency: null },
        ]),
      },
      taxRefund: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'TR-1', refundNumber: 'TR-001', status: 'Refunded', declarationId: 'CD-1', exportAmountFob: 10000, exportAmountFobCurrency: 'USD', refundAmount: 9000, refundDate: '2026-05-01' },
          { id: 'TR-2', refundNumber: 'TR-002', status: 'Draft', declarationId: null, exportAmountFob: null, exportAmountFobCurrency: null, refundAmount: null, refundDate: null },
        ]),
      },
      invoice: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'INV-1', invoiceNumber: 'INV-001', type: 'Receivable', status: 'Paid', amount: 10000, currency: 'USD', issueDate: '2026-03-06', dueDate: '2026-04-06', settlementDate: '2026-04-01' },
        ]),
      },
      paymentVoucher: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'PAY-1', voucherNumber: 'PAY-001', type: 'Receipt', status: 'reconciled', amount: 10000, currency: 'USD', paymentDate: '2026-04-01', invoiceId: 'INV-1' },
        ]),
      },
      invoiceAllocation: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'ALLOC-1', invoiceId: 'INV-1', voucherId: 'PAY-1', appliedAmount: 10000, appliedDate: '2026-04-01' },
        ]),
      },
    });

    const res = await request(makeApp(prisma)).get('/api/v1/orders/ORD-1/context');
    expect(res.status).toBe(200);

    // 各阶段数量
    expect(res.body.quotation).toHaveLength(1);
    expect(res.body.bom).toHaveLength(1);
    expect(res.body.procurement).toHaveLength(1);
    expect(res.body.production.stages).toHaveLength(2);
    expect(res.body.production.inspections).toHaveLength(1);
    expect(res.body.outsourcing).toHaveLength(1);

    // 开发节点（← SampleBatch）只挂到匹配的 developmentCase（DC-OTHER 的不应出现）；确认批次映射为 approved
    expect(res.body.developmentCase).toHaveLength(1);
    expect(res.body.developmentCase[0].sampleNodes.map((n: any) => n.id)).toEqual(['SB-1']);
    expect(res.body.developmentCase[0].sampleNodes[0].status).toBe('approved');

    // 报关单嵌套：CD-1 挂到 SHP-1，CD-2 无运单进顶层 orphan
    expect(res.body.shipments).toHaveLength(1);
    expect(res.body.shipments[0].customsDeclarations.map((d: any) => d.id)).toEqual(['CD-1']);
    expect(res.body.customsDeclarations.map((d: any) => d.id)).toEqual(['CD-2']);

    // 退税嵌套：TR-1 挂到 CD-1，TR-2 无报关单进顶层 orphan
    expect(res.body.shipments[0].customsDeclarations[0].taxRefunds.map((r: any) => r.id)).toEqual(['TR-1']);
    expect(res.body.taxRefunds.map((r: any) => r.id)).toEqual(['TR-2']);

    // 核销嵌套到发票
    expect(res.body.finance.invoices).toHaveLength(1);
    expect(res.body.finance.invoices[0].allocations.map((a: any) => a.id)).toEqual(['ALLOC-1']);
    expect(res.body.finance.vouchers).toHaveLength(1);
  });

  it('按 poNumber 也可命中（与 getOrder 口径一致），关联查询用真实 orderId', async () => {
    const prisma = makeContextPrisma();
    const res = await request(makeApp(prisma)).get('/api/v1/orders/PO-001/context');
    expect(res.status).toBe(200);
    expect(res.body.order.id).toBe('ORD-1');
    expect(prisma.quotation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ convertedOrderId: 'ORD-1' }),
    }));
  });
});
