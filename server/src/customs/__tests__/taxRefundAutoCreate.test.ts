/**
 * B1 — createTaxRefundFromDeclaration 自动核算单元测试
 *
 * 覆盖：
 *   - 全链路核算：行明细合计 FOB × 发票汇率 → CNY；按行 HS 退税率加权 refundableVat
 *   - 回退链：无行金额回退报关总额；无发票汇率回退订单汇率；出口日期 atd→etd→申报日期
 *   - 幂等：同一报关单已有退税申报 → 抛错（联动层识别为幂等成功）
 *   - 边界：报关单不存在抛错；无 HS 退税率覆盖时 refundableVat 为 null 仍建草稿
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createCustomsService } from '../customsService';
import { businessEventBus } from '../../events/businessEventBus';

vi.spyOn(businessEventBus, 'publish').mockResolvedValue(undefined);
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface MockOptions {
  existingRefund?: any;
  declaration?: any;
  invoice?: any;
  voucher?: any;
  shipment?: any;
  hsRows?: any[];
}

function makePrisma(opts: MockOptions) {
  const taxRefundCreate = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null }));
  const auditLogCreate = vi.fn().mockResolvedValue({});

  const tx = {
    taxRefund: { create: taxRefundCreate },
    auditLog: { create: auditLogCreate },
    // EntityLink 图谱（D1.1a）：createTaxRefund 事务内 syncTaxRefundReferences
    entityReference: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    entityLink: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    taxRefund: {
      findFirst: vi.fn().mockResolvedValue(opts.existingRefund ?? null),
      create: taxRefundCreate,
    },
    customsDeclaration: {
      findFirst: vi.fn().mockResolvedValue(opts.declaration ?? null),
    },
    invoice: {
      findFirst: vi.fn().mockResolvedValue(opts.invoice ?? null),
    },
    paymentVoucher: {
      findFirst: vi.fn().mockResolvedValue(opts.voucher ?? null),
    },
    shipment: {
      findUnique: vi.fn().mockResolvedValue(opts.shipment ?? null),
    },
    hsCode: {
      findMany: vi.fn().mockResolvedValue(opts.hsRows ?? []),
    },
    auditLog: { create: auditLogCreate },
  };

  return { prisma: prisma as any, taxRefundCreate };
}

const DECLARATION = {
  id: 'CD_1',
  declarationNumber: 'CD202608070001',
  orderId: 'ORD_1',
  relationId: 'REL_1',
  shipmentId: 'SHP_1',
  declarationDate: '2026-08-01',
  currency: 'USD',
  totalValue: 10000,
  lines: [
    { lineNumber: 1, productName: '全棉梭织布', hsCode: '5208.52.00.00', totalAmount: 6000 },
    { lineNumber: 2, productName: '涤纶针织布', hsCode: '6006.32.00.00', totalAmount: 4000 },
  ],
};

describe('createTaxRefundFromDeclaration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computes FOB/CNY/refundableVat from lines + HS rates + invoice fxRate', async () => {
    const { prisma, taxRefundCreate } = makePrisma({
      declaration: DECLARATION,
      invoice: { exchangeRate: 7.1 },
      voucher: { exchangeRate: 7.0 },
      shipment: { atd: '2026-08-03', etd: '2026-08-02' },
      hsRows: [
        { code: '5208.52.00.00', exportTaxRebateRate: 13 },
        { code: '6006.32.00.00', exportTaxRebateRate: 11 },
      ],
    });
    const svc = createCustomsService(prisma);

    const refund = await svc.createTaxRefundFromDeclaration('CD_1', 'tester');

    const data = taxRefundCreate.mock.calls[0][0].data;
    // FOB = 6000 + 4000 = 10000 USD；汇率取发票 7.1（优先于订单）
    expect(Number(data.exportAmountFob)).toBe(10000);
    expect(data.exportAmountFobCurrency).toBe('USD');
    expect(Number(data.fxRate)).toBe(7.1);
    expect(Number(data.exportAmountCny)).toBe(71000);
    // refundableVat = 6000×7.1×13% + 4000×7.1×11% = 5538 + 3124 = 8662
    expect(Number(data.refundableVat)).toBe(8662);
    // 加权退税率 = 8662 / 71000 ≈ 12.2%（百分数口径，前端按 `${rate}%` 展示）
    expect(Number(data.refundableRate)).toBeCloseTo(12.2, 3);
    expect(Number(data.refundAmount)).toBe(8662);
    // 出口日期取运单 atd
    expect(data.exportDate).toBe('2026-08-03');
    expect(data.declarationDate).toBe('2026-08-01');
    expect(data.refundNumber).toBe('TRA-CD202608070001');
    expect(data.status).toBe('Draft');
    expect(refund.refundNumber).toBe('TRA-CD202608070001');
  });

  it('falls back to declaration totalValue / voucher fxRate / etd when lines/invoice/atd missing', async () => {
    const { prisma, taxRefundCreate } = makePrisma({
      declaration: { ...DECLARATION, lines: [], totalValue: 8000 },
      invoice: null,
      voucher: { exchangeRate: 7.05 },
      shipment: { atd: null, etd: '2026-08-02' },
      hsRows: [],
    });
    const svc = createCustomsService(prisma);

    await svc.createTaxRefundFromDeclaration('CD_1', 'tester');

    const data = taxRefundCreate.mock.calls[0][0].data;
    expect(Number(data.exportAmountFob)).toBe(8000);
    expect(Number(data.fxRate)).toBe(7.05);
    expect(Number(data.exportAmountCny)).toBe(56400);
    expect(data.exportDate).toBe('2026-08-02');
    // 无行明细 → 无 HS 覆盖 → refundableVat 为 null（草稿仍可建，由人工补录）
    expect(data.refundableVat).toBeNull();
    expect(data.refundableRate).toBeNull();
    expect(data.refundAmount).toBeNull();
  });

  it('creates draft with null amounts when neither fxRate nor amount source available', async () => {
    const { prisma, taxRefundCreate } = makePrisma({
      declaration: { ...DECLARATION, orderId: null, shipmentId: null, lines: [], totalValue: null },
      hsRows: [],
    });
    const svc = createCustomsService(prisma);

    await svc.createTaxRefundFromDeclaration('CD_1', 'tester');

    const data = taxRefundCreate.mock.calls[0][0].data;
    expect(data.exportAmountFob).toBeNull();
    expect(data.fxRate).toBeNull();
    expect(data.exportAmountCny).toBeNull();
    // 出口日期回退申报日期
    expect(data.exportDate).toBe('2026-08-01');
  });

  it('skips lines without HS rebate rate when computing refundableVat', async () => {
    const { prisma, taxRefundCreate } = makePrisma({
      declaration: DECLARATION,
      invoice: { exchangeRate: 7.0 },
      shipment: null,
      voucher: null,
      hsRows: [{ code: '5208.52.00.00', exportTaxRebateRate: 13 }], // 第二行无退税率
    });
    const svc = createCustomsService(prisma);

    await svc.createTaxRefundFromDeclaration('CD_1', 'tester');

    const data = taxRefundCreate.mock.calls[0][0].data;
    // 仅第一行覆盖：6000×7.0×0.13 = 5460
    expect(Number(data.refundableVat)).toBe(5460);
    expect(Number(data.exportAmountCny)).toBe(70000);
  });

  it('throws when declaration already has a tax refund (idempotent guard)', async () => {
    const { prisma, taxRefundCreate } = makePrisma({
      existingRefund: { id: 'TR_X', refundNumber: 'TRA-EXISTING' },
      declaration: DECLARATION,
    });
    const svc = createCustomsService(prisma);

    await expect(svc.createTaxRefundFromDeclaration('CD_1', 'tester'))
      .rejects.toThrow('不可重复生成');
    expect(taxRefundCreate).not.toHaveBeenCalled();
  });

  it('throws when declaration not found', async () => {
    const { prisma } = makePrisma({ declaration: null });
    const svc = createCustomsService(prisma);

    await expect(svc.createTaxRefundFromDeclaration('CD_MISSING', 'tester'))
      .rejects.toThrow('报关单 CD_MISSING 不存在');
  });
});
