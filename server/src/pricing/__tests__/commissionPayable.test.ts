/**
 * commissionPayable.test.ts — ★ D4 真源单测：订单佣金应付汇总（纯函数）
 *
 * 为什么单测这块（零基础障碍清单 D4「缺订单应付闭环」）：
 *   佣金在定价侧算得很细，但**只算不收** —— 没有任何地方能回答「这张单欠中间人多少佣金」。
 *   修法 = 汇总成应付（再开一张应付发票落地）。「哪些行算、怎么算、中间人怎么定」必须可单测，
 *   尤其**多行归属不同中间人时不猜**（挑一个 = 静默错账）。
 */
import { describe, expect, it } from 'vitest';
import { summarizeOrderCommission, COMMISSION_CURRENCY, type CommissionRuleRef } from '../commissionPayableService';

const R = (id: string, over: Partial<CommissionRuleRef> = {}): CommissionRuleRef =>
  ({ id, rate: 5, intermediaryRelationId: 'REL-AGENT', intermediaryName: '某代理', ...over });

const P = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, status: 'Confirmed', commissionAmount: 1, quantity: 100, commissionRuleId: 'CR-1', ...over });

const rules = (...list: CommissionRuleRef[]) => new Map(list.map(r => [r.id, r]));

describe('summarizeOrderCommission（订单佣金应付）', () => {
  it('① 佣金总额 = Σ(单价佣金 × 数量)；币种恒为 USD（定价链口径）', () => {
    const r = summarizeOrderCommission({
      orderId: 'O1',
      rows: [P('a', { commissionAmount: 1.5, quantity: 100 }), P('b', { commissionAmount: 0.5, quantity: 200 })],
      rulesById: rules(R('CR-1')),
    });
    expect(r.totalCommission).toBe(250); // 150 + 100
    expect(r.lineCount).toBe(2);
    expect(r.currency).toBe(COMMISSION_CURRENCY);
    expect(r.currency).toBe('USD');
    expect(r.intermediaryRelationId).toBe('REL-AGENT');
    expect(r.intermediaryName).toBe('某代理');
  });

  it('★ ② 只算「已确认」的定价行（草稿不是承诺；归档已作废）', () => {
    const r = summarizeOrderCommission({
      orderId: 'O1',
      rows: [
        P('a', { status: 'Confirmed', commissionAmount: 1, quantity: 100 }),
        P('b', { status: 'Draft', commissionAmount: 9, quantity: 100 }),
        P('c', { status: 'Archived', commissionAmount: 9, quantity: 100 }),
      ],
      rulesById: rules(R('CR-1')),
    });
    expect(r.totalCommission).toBe(100);
    expect(r.skippedRowCount).toBe(2);
    expect(r.issues.join(' ')).toContain('不是「已确认」状态');
  });

  it('★ ③ 缺数量 → 不计入且**不按 1 顶替**，并显式上报', () => {
    const r = summarizeOrderCommission({
      orderId: 'O1',
      rows: [P('a', { quantity: null }), P('b', { quantity: 0 })],
      rulesById: rules(R('CR-1')),
    });
    expect(r.totalCommission).toBe(0);
    expect(r.lineCount).toBe(0);
    expect(r.issues.join(' ')).toContain('缺数量');
  });

  it('★ ④ 多行归属**不同中间人** → 不猜（返回 null + 明确提示）', () => {
    const r = summarizeOrderCommission({
      orderId: 'O1',
      rows: [P('a', { commissionRuleId: 'CR-1' }), P('b', { commissionRuleId: 'CR-2' })],
      rulesById: rules(R('CR-1'), R('CR-2', { intermediaryRelationId: 'REL-OTHER', intermediaryName: '另一家' })),
    });
    expect(r.intermediaryRelationId).toBeNull();
    expect(r.intermediaryName).toBeNull();
    expect(r.issues.join(' ')).toContain('不猜');
  });

  it('⑤ 单行能解析出中间人（多行同一中间人亦可）', () => {
    const r = summarizeOrderCommission({
      orderId: 'O1',
      rows: [P('a', { commissionRuleId: 'CR-1' }), P('b', { commissionRuleId: 'CR-1' })],
      rulesById: rules(R('CR-1')),
    });
    expect(r.intermediaryRelationId).toBe('REL-AGENT');
    expect(r.issues).toEqual([]);
  });

  it('⑥ 规则缺失 / 规则未填中间人 → issue（不硬塞一个中间人）', () => {
    const noRule = summarizeOrderCommission({
      orderId: 'O1',
      rows: [P('a', { commissionRuleId: 'CR-GONE' })],
      rulesById: rules(R('CR-1')),
    });
    expect(noRule.intermediaryRelationId).toBeNull();
    expect(noRule.issues.join(' ')).toContain('规则已不存在');

    const emptyIntermediary = summarizeOrderCommission({
      orderId: 'O1',
      rows: [P('a', { commissionRuleId: 'CR-1' })],
      rulesById: rules(R('CR-1', { intermediaryRelationId: null, intermediaryName: null })),
    });
    expect(emptyIntermediary.intermediaryRelationId).toBeNull();
    // ⓘ 断言要抄实现里的**原文**（我第一版写成「没填中间人」而实现是「未填中间人」⇒ 假红）
    expect(emptyIntermediary.issues.join(' ')).toContain('未填中间人');
  });

  it('⑦ 佣金为 0/负/缺失的行 → 跳过且**不算问题**（无佣金的单是正常的）', () => {
    const r = summarizeOrderCommission({
      orderId: 'O1',
      rows: [P('a', { commissionAmount: 0 }), P('b', { commissionAmount: null }), P('c', { commissionAmount: -1 })],
      rulesById: rules(R('CR-1')),
    });
    expect(r.totalCommission).toBe(0);
    expect(r.issues).toEqual([]);
  });

  it('⑧ 空订单 → 全 0，无 issue', () => {
    const r = summarizeOrderCommission({ orderId: 'O1', rows: [], rulesById: rules(R('CR-1')) });
    expect(r).toMatchObject({ lineCount: 0, totalCommission: 0, intermediaryRelationId: null, skippedRowCount: 0 });
    expect(r.issues).toEqual([]);
  });

  it('⑨ ★ Decimal 对象入参必须算得准（Prisma 查询结果是 Decimal，不是 number）', () => {
    const dec = (s: string) => ({ toString: () => s }) as any;
    const r = summarizeOrderCommission({
      orderId: 'O1',
      rows: [{ id: 'a', status: 'Confirmed', commissionAmount: dec('2.5'), quantity: dec('40'), commissionRuleId: 'CR-1' }],
      rulesById: rules(R('CR-1', { rate: dec('5') })),
    });
    expect(r.totalCommission).toBe(100);
    expect(r.lines[0].rate).toBe(5);
  });

  it('⑩ 行级明细带出规则与费率（可追溯）', () => {
    const r = summarizeOrderCommission({
      orderId: 'O1',
      rows: [P('a', { commissionAmount: 1, quantity: 50, commissionRuleId: 'CR-1' })],
      rulesById: rules(R('CR-1', { rate: 10 })),
    });
    expect(r.lines[0]).toMatchObject({ pricingId: 'a', unitCommission: 1, quantity: 50, amount: 50, ruleId: 'CR-1', rate: 10, intermediaryRelationId: 'REL-AGENT' });
  });
});
