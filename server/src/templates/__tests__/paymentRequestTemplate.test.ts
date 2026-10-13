/**
 * §10.3-9 Phase B 批次 4 — 付款申请单 PDF 模板测试。
 *
 * 覆盖：
 *   1. renderPaymentRequestBody：标题/单号/收款方/付款要素/金额大写/审批区/双签；带章 vs 无章
 *   2. loadPaymentRequestDocData：真源装配（供应商回落、来源单据解析、审批与凭证快照）
 *   3. registry：PaymentRequest → PAYREQ 映射
 */

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  renderPaymentRequestBody,
  loadPaymentRequestDocData,
  PAYMENT_REQUEST_STATUS_LABEL,
  PAYMENT_CATEGORY_LABEL,
} from '../docTemplates/paymentRequest';
import { serverKindForType, SERVER_DOC_TEMPLATES } from '../docTemplates/registry';

const EXPORTER = {
  nameEn: 'BAMBOOK TRADING CO., LTD.',
  addressEn: 'No. 88 Nanjing Road, Shanghai, China',
  beneficiary: 'BAMBOOK TRADING',
  bankName: 'Bank of Shanghai',
  swiftCode: 'BOSHCNSH',
  bankAddress: 'Shanghai Main Branch',
  usdAccountNumber: '1234567890',
};

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const SEAL = { id: 'SEAL_1', name: '公司公章', imageDataUrl: PNG };

const DATA = {
  pr: {
    id: 'PAYR__1',
    requestNumber: 'PAYR-20260912-001',
    status: 'Approved',
    requestDate: '2026-09-12',
    expectedPaymentDate: '2026-09-20',
    supplierName: 'Nantong Textile Mill Co., Ltd.',
    supplierCode: 'SUP-0001',
    totalAmount: 16850.5,
    currency: 'USD',
    paymentCategory: 'sample_express',
    remark: '样品快递费结算',
    sourceType: 'purchase_order',
    sourceId: 'PO_1',
    sourceNumber: 'PO-20260901-001',
    applicantName: 'Alice',
    reviewerName: 'Bob',
    approvalStatus: 'approved',
    decidedAt: '2026-09-12',
    decisionNote: '同意',
    voucherNumber: null,
  },
};

describe('renderPaymentRequestBody', () => {
  it('渲染标题/单号/收款方/付款要素/审批区/双签', () => {
    const html = renderPaymentRequestBody(DATA as any, EXPORTER);
    expect(html).toContain('PAYMENT REQUEST');
    expect(html).toContain('付 款 申 请 单');
    expect(html).toContain('PAYR-20260912-001');
    expect(html).toContain('Nantong Textile Mill Co., Ltd.');
    expect(html).toContain('SUP-0001');
    expect(html).toContain('16,850.50 USD');
    expect(html).toContain('样品快递费');
    expect(html).toContain('采购订单 · PO-20260901-001');
    expect(html).toContain('已批准 Approved');
    expect(html).toContain('Amount in Words 金额大写');
    expect(html).toContain('申请人签字');
    expect(html).toContain('审批人签章');
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).toContain('样品快递费结算');
  });

  it('缺项（无来源单据/无备注/无预期付款日）→ 破折号占位不报错', () => {
    const html = renderPaymentRequestBody({
      pr: {
        ...DATA.pr,
        expectedPaymentDate: null, sourceType: null, sourceId: null, sourceNumber: null,
        remark: null, supplierCode: null, decisionNote: null,
      },
    } as any, EXPORTER);
    expect(html).toContain('—');
    expect(html).not.toContain('样品快递费结算');
    expect(html).not.toContain('Expected 预期付款');
  });

  it('电子签：传章盖入审批人签章位 / 不传不出章', () => {
    expect(renderPaymentRequestBody(DATA as any, EXPORTER, SEAL)).toContain('class="doc-stamp"');
    expect(renderPaymentRequestBody(DATA as any, EXPORTER)).not.toContain('class="doc-stamp"');
  });

  it('状态与付款性质标签表覆盖全枚举（口径与前端一致）', () => {
    expect(Object.keys(PAYMENT_REQUEST_STATUS_LABEL)).toEqual(
      ['Draft', 'Pending', 'Approved', 'Rejected', 'VoucherIssued', 'Executing', 'Paid', 'Cancelled'],
    );
    expect(Object.keys(PAYMENT_CATEGORY_LABEL)).toEqual(
      ['normal', 'advance', 'deposit', 'sample_express', 'customer_reimburse', 'business_cost'],
    );
  });
  it('客户实付申请打印真实客户、户名和贷项版本，四位金额不得显示成13.00', () => {
    const html = renderPaymentRequestBody({ pr: { ...DATA.pr, status: 'Executing', supplierName: null,
      supplierCode: null, totalAmount: '12.9999', sourceType: 'credit_note', sourceId: null,
      sourceNumber: 'CLM-2026-0001 / v2', customerRefund: { customerName: 'Actual Customer',
        accountHolder: 'Approved Payee', creditNoteNumber: 'CLM-2026-0001', version: 2 } } }, EXPORTER);
    expect(html).toContain('Actual Customer'); expect(html).toContain('Approved Payee');
    expect(html).toContain('CLM-2026-0001 / v2'); expect(html).toContain('12.9999 USD');
    expect(html).toContain('银行付款执行中'); expect(html).not.toContain('13.00');
    expect(html).toContain('POINT NINE NINE NINE NINE');
    expect(html).not.toContain('Nantong Textile'); expect(html).not.toContain('SUP-0001');
  });
  it('最大精度金额不经过浮点，未知金额拒绝出单', () => {
    expect(renderPaymentRequestBody({ pr: { ...DATA.pr, totalAmount: '99999999999999.1234' } }, EXPORTER))
      .toContain('99,999,999,999,999.1234 USD');
    expect(() => renderPaymentRequestBody({ pr: { ...DATA.pr, totalAmount: 'unknown' } }, EXPORTER)).toThrow();
  });
});

describe('loadPaymentRequestDocData', () => {
  const makePrisma = (overrides: Record<string, any> = {}) => {
    const row = {
      id: 'PAYR__1', requestNumber: 'PAYR-20260912-001', status: 'Pending',
      supplierId: 'REL_1', supplierName: '冗余名', requestDate: '2026-09-12',
      expectedPaymentDate: null, totalAmount: { toString: () => '16850.5' },
      currency: 'USD', paymentCategory: 'sample_express', applicantId: 'u_a',
      reviewerId: 'u_b', approvalRequestId: 'APR_1', paymentVoucherId: null,
      remark: null, attachments: { sourceDocument: { type: 'order', id: 'SO_1' } },
      deletedAt: null, ...overrides,
    };
    return {
      paymentRequest: { findUnique: vi.fn().mockResolvedValue(row) },
      relation: { findUnique: vi.fn().mockResolvedValue({ name: '冗余名', englishName: 'ACME GmbH', chineseName: null, code: 'SUP-0001' }) },
      userAccount: {
        findUnique: vi.fn().mockImplementation(({ where }: any) =>
          Promise.resolve({ displayName: where.id === 'u_a' ? 'Alice' : 'Bob' })),
      },
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ status: 'approved', decidedAt: new Date('2026-09-12T00:00:00Z'), decisionNote: '同意' }) },
      paymentVoucher: { findUnique: vi.fn().mockResolvedValue(null) },
      purchaseOrder: { findUnique: vi.fn().mockResolvedValue({ poNumber: 'PO-1' }) },
      order: { findUnique: vi.fn().mockResolvedValue({ poNumber: 'CUS-PO-77' }) },
    } as unknown as PrismaClient;
  };

  it('真源装配：客户档案英文名优先、来源单据号解析、审批快照', async () => {
    const data = await loadPaymentRequestDocData(makePrisma(), 'PAYR__1');
    expect(data).not.toBeNull();
    expect(data!.pr.supplierName).toBe('ACME GmbH'); // 档案英文名优先于冗余名
    expect(data!.pr.supplierCode).toBe('SUP-0001');
    expect(data!.pr.totalAmount).toBe(16850.5);
    expect(data!.pr.sourceType).toBe('order');
    expect(data!.pr.sourceNumber).toBe('CUS-PO-77');
    expect(data!.pr.applicantName).toBe('Alice');
    expect(data!.pr.reviewerName).toBe('Bob');
    expect(data!.pr.approvalStatus).toBe('approved');
    expect(data!.pr.decidedAt).toBe('2026-09-12');
  });

  it('来源单据解析失败 → 回落 null（不阻断出单）', async () => {
    const prisma = makePrisma();
    (prisma as any).order.findUnique = vi.fn().mockRejectedValue(new Error('db down'));
    const data = await loadPaymentRequestDocData(prisma, 'PAYR__1');
    expect(data!.pr.sourceNumber).toBeNull();
    expect(data!.pr.sourceType).toBe('order');
  });

  it('单据不存在 / 已软删 → null（调用方 404）', async () => {
    expect(await loadPaymentRequestDocData(makePrisma({ deletedAt: new Date() }), 'PAYR__1')).toBeNull();
    const prisma = makePrisma();
    (prisma as any).paymentRequest.findUnique = vi.fn().mockResolvedValue(null);
    expect(await loadPaymentRequestDocData(prisma, 'PAYR__1')).toBeNull();
  });
});

describe('registry：付款申请单模板登记', () => {
  it('PaymentRequest → PAYREQ，且模板已注册', () => {
    expect(serverKindForType('PaymentRequest')).toBe('PAYREQ');
    expect(SERVER_DOC_TEMPLATES.PAYREQ).toBeTruthy();
    expect(SERVER_DOC_TEMPLATES.PAYREQ.title).toContain('付款申请单');
  });
});
