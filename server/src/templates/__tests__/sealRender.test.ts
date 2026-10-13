/**
 * §10.3-9 Phase B 批次 1 — 盖章渲染管道测试。
 *
 * 覆盖：
 *   1. renderDocStamp：有章出 <img class="doc-stamp">；无章返回空串（版式零影响）
 *   2. QUOT / OC / CONTRACT 三模板签名区：传章则盖章、不传则无章（向后兼容）
 *   3. registry.renderServerDocument：ctx.signer 有值时按签署人解析章图盖入；无 signer 不盖章；
 *      章库异常时 fail-open（仍出单据，只是无章）
 */

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { renderDocStamp } from '../docPrintBase';
import { renderQuotationBody } from '../docTemplates/quotation';
import { renderOrderConfirmationBody } from '../docTemplates/orderConfirmation';
import { renderContractBody } from '../docTemplates/contract';
import { renderServerDocument } from '../docTemplates/registry';

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

const QUOT_DATA = {
  qt: {
    id: 'QT_1', quotationNumber: 'QT-20260912-001', status: 'Approved', currency: 'USD',
    totalAmount: 12000, issueDate: '2026-09-12', validUntil: '2026-10-12',
    deliveryTerms: 'FOB Shanghai', paymentTerms: 'T/T 30%', salesperson: 'Alice',
    inquiryRef: null, notes: null, customerName: 'ACME GmbH', customerCode: 'C-001',
  },
  lines: [],
};

const OC_DATA = {
  order: {
    id: 'SO_1', poNumber: 'CUS-PO-77', customer: 'ACME GmbH', status: 'Confirmed',
    dueDate: '2026-10-01', currency: 'USD', orderAmount: 12000, deliveryTerms: 'FOB',
    paymentTerms: 'T/T', salesContractNumber: null, finalContractNumber: null,
    shipToAddress: null, createdAt: 1757600000000,
  },
  customer: null,
  lines: [],
};

const CONTRACT_DATA = {
  contractNumber: 'SC-20260912-1',
  contractDate: '2026-09-12',
  customer: null,
  orders: [],
  lines: [],
  totals: { currency: 'USD', amount: 12000, quantity: 1000 },
};

describe('renderDocStamp', () => {
  it('有章 → 输出 doc-stamp 图', () => {
    const html = renderDocStamp(SEAL);
    expect(html).toContain('class="doc-stamp"');
    expect(html).toContain(PNG);
  });

  it('无章 / 空图 → 空串（版式零影响）', () => {
    expect(renderDocStamp(null)).toBe('');
    expect(renderDocStamp(undefined)).toBe('');
    expect(renderDocStamp({ id: 'x', name: 'y', imageDataUrl: '' })).toBe('');
  });
});

describe('三模板签名区盖章', () => {
  it('QUOT：传章盖章 / 不传无章', () => {
    expect(renderQuotationBody(QUOT_DATA as any, EXPORTER, SEAL)).toContain('class="doc-stamp"');
    expect(renderQuotationBody(QUOT_DATA as any, EXPORTER)).not.toContain('class="doc-stamp"');
  });

  it('OC：传章盖章 / 不传无章', () => {
    expect(renderOrderConfirmationBody(OC_DATA as any, EXPORTER, SEAL)).toContain('class="doc-stamp"');
    expect(renderOrderConfirmationBody(OC_DATA as any, EXPORTER)).not.toContain('class="doc-stamp"');
  });

  it('CONTRACT：传章盖章 / 不传无章', () => {
    expect(renderContractBody(CONTRACT_DATA as any, EXPORTER, SEAL)).toContain('class="doc-stamp"');
    expect(renderContractBody(CONTRACT_DATA as any, EXPORTER)).not.toContain('class="doc-stamp"');
  });

  it('盖章不破坏签名区标签（卖方签章仍在）', () => {
    const html = renderQuotationBody(QUOT_DATA as any, EXPORTER, SEAL);
    expect(html).toContain("Seller's Signature 卖方签章");
  });
});

describe('registry.renderServerDocument 印章解析', () => {
  const makePrisma = (seal: any) => ({
    seal: { findFirst: vi.fn().mockResolvedValue(seal) },
  }) as unknown as PrismaClient;

  it('ctx.signer 有值 → 按签署人解析章并盖入', async () => {
    const prisma = makePrisma({ id: 'SEAL_1', name: '公司公章', imageDataUrl: PNG });
    const html = await renderServerDocument(
      prisma, 'QUOT', QUOT_DATA, {},
      { id: 'TD_1', type: 'Quotation', sourceRef: 'QT_1', signer: { userId: 'u-boss' } },
    );
    expect(html).toContain('class="doc-stamp"');
  });

  it('无 ctx.signer → 不盖章（未签署）', async () => {
    const prisma = makePrisma({ id: 'SEAL_1', name: '公司公章', imageDataUrl: PNG });
    const html = await renderServerDocument(
      prisma, 'QUOT', QUOT_DATA, {},
      { id: 'TD_1', type: 'Quotation', sourceRef: 'QT_1' },
    );
    expect(html).not.toContain('class="doc-stamp"');
  });

  it('章库异常 → fail-open（仍出单据，只是无章）', async () => {
    const prisma = {
      seal: { findFirst: vi.fn().mockRejectedValue(new Error('db down')) },
    } as unknown as PrismaClient;
    const html = await renderServerDocument(
      prisma, 'QUOT', QUOT_DATA, {},
      { id: 'TD_1', type: 'Quotation', sourceRef: 'QT_1', signer: { userId: 'u-boss' } },
    );
    expect(html).not.toBeNull();
    expect(html).not.toContain('class="doc-stamp"');
    expect(html).toContain('QUOTATION');
  });

  it('无可用章（resolve 返回 null）→ 不盖章', async () => {
    const prisma = makePrisma(null);
    const html = await renderServerDocument(
      prisma, 'OC', OC_DATA, {},
      { id: 'TD_2', type: 'OrderConfirmation', sourceRef: 'SO_1', signer: { roleId: 'role-admin' } },
    );
    expect(html).not.toContain('class="doc-stamp"');
  });
});
