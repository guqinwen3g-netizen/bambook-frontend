/**
 * depositGate.test.ts — D3 定金门禁纯函数（未收足定金不得进生产/发运）
 *
 * 覆盖：只管 T/T（L/C 与 O/A 不越权）+ 未录比例=不适用（如实标出而非"已通过"）
 * + 脏比例不拿来计算 + 收足/未收足边界（含 0.01 容差）+ 跨币种不折算。
 */
import { describe, it, expect } from 'vitest';
import { decideDepositGate, normalizePaymentInstrument } from '../depositGate';

describe('normalizePaymentInstrument（只认 T/T）', () => {
  it('T/T / TT 归一为 TT；L/C 归一为 LC；其余 OTHER；空为 null', () => {
    expect(normalizePaymentInstrument('T/T')).toBe('TT');
    expect(normalizePaymentInstrument('tt')).toBe('TT');
    expect(normalizePaymentInstrument(' L/C ')).toBe('LC');
    expect(normalizePaymentInstrument('O/A')).toBe('OTHER');
    expect(normalizePaymentInstrument(null)).toBeNull();
  });
});

describe('decideDepositGate（D3 定金）', () => {
  it('★ 只管 T/T：L/C 与 O/A 不适用（不越权卡别的付款方式）', () => {
    for (const inst of ['L/C', 'O/A', 'D/P', null]) {
      const d = decideDepositGate({ paymentInstrument: inst, depositRatio: 30, orderAmount: 10000, receivedAmount: 0 });
      expect(d.applicable).toBe(false);
      expect(d.satisfied).toBe(true); // 不适用 ⇒ 不拦
    }
  });

  it('★ 未录比例 ⇒ 不适用 + 如实标出（不许显示成"已通过"）', () => {
    const d = decideDepositGate({ paymentInstrument: 'T/T', depositRatio: null, orderAmount: 10000, receivedAmount: 0 });
    expect(d.applicable).toBe(false);
    expect(d.reasonCode).toBe('DEPOSIT_NOT_CONFIGURED');
  });

  it('★ 脏比例（-5 / 150）不拿来计算 ⇒ 标 RATIO_INVALID', () => {
    for (const r of [-5, 150]) {
      const d = decideDepositGate({ paymentInstrument: 'T/T', depositRatio: r, orderAmount: 10000, receivedAmount: 0 });
      expect(d.applicable).toBe(false);
      expect(d.reasonCode).toBe('DEPOSIT_RATIO_INVALID');
    }
  });

  it('收足 ⇒ satisfied（30% × 10000 = 3000）', () => {
    const d = decideDepositGate({ paymentInstrument: 'T/T', depositRatio: 30, orderAmount: 10000, receivedAmount: 3000, currency: 'USD' });
    expect(d.applicable).toBe(true);
    expect(d.satisfied).toBe(true);
    expect(d.requiredAmount).toBe(3000);
  });

  it('★ 未收足 ⇒ 阻断，给出差额（收 2000 / 应收 3000）', () => {
    const d = decideDepositGate({ paymentInstrument: 'T/T', depositRatio: 30, orderAmount: 10000, receivedAmount: 2000, currency: 'USD' });
    expect(d.satisfied).toBe(false);
    expect(d.reasonCode).toBe('DEPOSIT_INSUFFICIENT');
    expect(d.message).toContain('差 1000');
  });

  it('分位取整容差：2999.99 视为收足（规避浮点/分位误差误拦）', () => {
    const d = decideDepositGate({ paymentInstrument: 'T/T', depositRatio: 30, orderAmount: 10000, receivedAmount: 2999.99 });
    expect(d.satisfied).toBe(true);
  });

  it('零定金（0%）⇒ 应收 0 ⇒ 收足（比例是"录了"的 0，不是"未录"）', () => {
    const d = decideDepositGate({ paymentInstrument: 'T/T', depositRatio: 0, orderAmount: 10000, receivedAmount: 0 });
    expect(d.applicable).toBe(true);
    expect(d.satisfied).toBe(true);
    expect(d.requiredAmount).toBe(0);
  });
});
