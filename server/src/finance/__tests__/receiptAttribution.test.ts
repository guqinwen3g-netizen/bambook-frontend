/**
 * receiptAttribution 单测 —— A2 第三方代付「收款归属」真源
 *
 * 真源是**纯函数**（无 IO / 无 Date / 无随机），所以这里能钉死全部口径分支，
 * 并且与 `statementThirdPartyAttribution.test.ts`（报表内核行为）形成双保险：
 * 纯函数钉「口径」，内核测试钉「接线」。
 */

import { describe, expect, it } from 'vitest';
import {
  attributeReceiptsToCustomers,
  linesForRelation,
  type AttributionVoucher,
  type AttributionAllocation,
  type AttributionInvoice,
} from '../receiptAttribution';

const v = (o: Partial<AttributionVoucher> & { id: string }): AttributionVoucher => ({
  voucherNumber: o.id,
  type: 'Receipt',
  customerRelationId: 'REL_A',
  customerName: 'Alpha',
  amount: 0,
  currency: 'USD',
  paymentDate: '2026-06-01',
  ...o,
});

const a = (voucherId: string, invoiceId: string, appliedAmount: number): AttributionAllocation => ({
  voucherId, invoiceId, appliedAmount,
});

const inv = (id: string, customerRelationId: string, customerName = 'X'): AttributionInvoice => ({
  id, customerRelationId, customerName, type: 'Receivable',
});

describe('attributeReceiptsToCustomers', () => {
  it('① 第三方代付：钱归「被核销发票的合同客户」，并打代付标', () => {
    const lines = attributeReceiptsToCustomers({
      vouchers: [v({ id: 'v1', customerRelationId: 'REL_A', customerName: 'Alpha', amount: 10000 })],
      allocations: [a('v1', 'i1', 10000)],
      invoices: [inv('i1', 'REL_B', 'Beta')],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      ownerRelationId: 'REL_B',
      ownerName: 'Beta',
      amount: 10000,
      isThirdParty: true,
      payerRelationId: 'REL_A',
      payerName: 'Alpha',
      appliedAmount: 10000,
      unappliedAmount: 0,
    });
    expect(lines[0].note).toContain('第三方代付');
    expect(lines[0].note).toContain('Alpha');
  });

  it('② 代付方自己那侧**不再产生行**（钱不能两边都算）', () => {
    const lines = attributeReceiptsToCustomers({
      vouchers: [v({ id: 'v1', customerRelationId: 'REL_A', amount: 10000 })],
      allocations: [a('v1', 'i1', 10000)],
      invoices: [inv('i1', 'REL_B', 'Beta')],
    });
    expect(linesForRelation(lines, 'REL_A')).toHaveLength(0);
    expect(linesForRelation(lines, 'REL_B')).toHaveLength(1);
  });

  it('③ 自付（打款人 = 合同客户）：合并成一行全额 —— 与改造前逐字节一致', () => {
    const lines = attributeReceiptsToCustomers({
      vouchers: [v({ id: 'v1', customerRelationId: 'REL_A', amount: 10000 })],
      allocations: [a('v1', 'i1', 10000)],
      invoices: [inv('i1', 'REL_A', 'Alpha')],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      ownerRelationId: 'REL_A', amount: 10000, isThirdParty: false,
      appliedAmount: 10000, unappliedAmount: 0,
    });
    expect(lines[0].note).toBeNull();
  });

  it('④ 部分核销的自付凭证：核销额 + 未核销余款合并为一行全额（不拆行）', () => {
    const lines = attributeReceiptsToCustomers({
      vouchers: [v({ id: 'v1', customerRelationId: 'REL_A', amount: 10000 })],
      allocations: [a('v1', 'i1', 6000)],
      invoices: [inv('i1', 'REL_A', 'Alpha')],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amount: 10000, appliedAmount: 6000, unappliedAmount: 4000 });
  });

  it('⑤ 代付部分核销：被代付方拿核销额，余款留在打款人名下（预收不凭空归别人）', () => {
    const lines = attributeReceiptsToCustomers({
      vouchers: [v({ id: 'v1', customerRelationId: 'REL_A', amount: 10000 })],
      allocations: [a('v1', 'i1', 6000)],
      invoices: [inv('i1', 'REL_B', 'Beta')],
    });
    const beta = linesForRelation(lines, 'REL_B');
    const alpha = linesForRelation(lines, 'REL_A');
    expect(beta).toHaveLength(1);
    expect(beta[0].amount).toBe(6000);
    expect(beta[0].isThirdParty).toBe(true);
    expect(alpha).toHaveLength(1);
    expect(alpha[0]).toMatchObject({ amount: 4000, isThirdParty: false, unappliedAmount: 4000 });
    // 总额守恒：6000 + 4000 = 10000
    expect(beta[0].amount + alpha[0].amount).toBe(10000);
  });

  it('⑥ 一票多客户：同一凭证核销两家发票 → 拆成两行，各自代付标', () => {
    const lines = attributeReceiptsToCustomers({
      vouchers: [v({ id: 'v1', customerRelationId: 'REL_A', amount: 9000 })],
      allocations: [a('v1', 'i1', 5000), a('v1', 'i2', 4000)],
      invoices: [inv('i1', 'REL_B', 'Beta'), inv('i2', 'REL_C', 'Cappa')],
    });
    expect(linesForRelation(lines, 'REL_B')[0].amount).toBe(5000);
    expect(linesForRelation(lines, 'REL_C')[0].amount).toBe(4000);
    expect(lines.every(l => l.isThirdParty)).toBe(true);
  });

  it('⑦ 未核销凭证（预收/在途）：全额留在打款人名下，不打代付标', () => {
    const lines = attributeReceiptsToCustomers({
      vouchers: [v({ id: 'v1', customerRelationId: 'REL_A', amount: 8000 })],
      allocations: [],
      invoices: [],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      ownerRelationId: 'REL_A', amount: 8000, isThirdParty: false, unappliedAmount: 8000,
    });
  });

  it('⑧ 口径隔离：非 Receipt 凭证 / 非 Receivable 发票不参与归属', () => {
    const lines = attributeReceiptsToCustomers({
      vouchers: [
        v({ id: 'v1', type: 'Disbursement', customerRelationId: 'REL_A', amount: 10000 }),
        v({ id: 'v2', customerRelationId: 'REL_A', amount: 7000 }),
      ],
      allocations: [a('v1', 'i1', 10000), a('v2', 'i2', 7000)],
      invoices: [inv('i1', 'REL_B', 'Beta'), { id: 'i2', customerRelationId: 'REL_C', customerName: 'Cappa', type: 'Payable' }],
    });
    // v1 是付款凭证 → 跳过；v2 核销的是应付票 → 不参与归属 → 余款留在打款人
    expect(linesForRelation(lines, 'REL_B')).toHaveLength(0);
    expect(linesForRelation(lines, 'REL_C')).toHaveLength(0);
    expect(linesForRelation(lines, 'REL_A')[0]).toMatchObject({ amount: 7000, unappliedAmount: 7000 });
  });

  it('⑨ 防御：超核销（历史脏数据）不产生负的未核销额', () => {
    const lines = attributeReceiptsToCustomers({
      vouchers: [v({ id: 'v1', customerRelationId: 'REL_A', amount: 1000 })],
      allocations: [a('v1', 'i1', 3000)],
      invoices: [inv('i1', 'REL_B', 'Beta')],
    });
    expect(lines[0].amount).toBe(3000);
    expect(lines[0].unappliedAmount).toBe(0);
    expect(lines.some(l => l.amount < 0)).toBe(false);
  });

  it('⑩ 防御：无合同客户 / 无打款人的凭证不凭空造行', () => {
    const lines = attributeReceiptsToCustomers({
      vouchers: [v({ id: 'v1', customerRelationId: null, amount: 5000 })],
      allocations: [a('v1', 'i1', 1000)],
      invoices: [{ id: 'i1', customerRelationId: null, customerName: null, type: 'Receivable' }],
    });
    expect(lines).toHaveLength(0);
  });

  it('⑪ Decimal / 字符串金额同样算得准（Prisma.Decimal 直接入参）', () => {
    const lines = attributeReceiptsToCustomers({
      vouchers: [v({ id: 'v1', customerRelationId: 'REL_A', amount: { toString: () => '1234.5678' } as any })],
      allocations: [a('v1', 'i1', { toString: () => '1000.0000' } as any)],
      invoices: [inv('i1', 'REL_B', 'Beta')],
    });
    expect(linesForRelation(lines, 'REL_B')[0].amount).toBe(1000);
    expect(linesForRelation(lines, 'REL_A')[0].amount).toBeCloseTo(234.5678, 4);
  });
});
