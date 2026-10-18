import { describe, expect, it } from 'vitest';
import { applyMistCommand, createMistState, mistBankAccountBalances, mistCommandPermission, type MistContext } from './mistWorkspace';

const setup = () => {
  let n = 0; const ctx: MistContext = { now: '2026-10-13T08:00:00.000Z', actorName: '林舒', id: () => `ba-${++n}` };
  let s = createMistState(ctx, 'empty');
  const run = (c: any) => { const r = applyMistCommand(s, c, ctx); s = r.state; return r.result as any; };
  run({ type: 'finance.account.save', payload: { name: '美元户', bankName: '中行', accountNo: '1234', currency: 'USD', openingDate: '2026-01-01', openingBalance: 0 } });
  run({ type: 'finance.account.save', payload: { name: '人民币户', bankName: '工行', accountNo: '5678', currency: 'CNY', openingDate: '2026-01-01', openingBalance: 0 } });
  return { get s() { return s; }, run };
};

describe('银行流水入账账户与销户', () => {
  it('导入流水与登记付款可直接指定账户；币种、期初逐笔校验', () => {
    const f = setup(), [usd, cny] = f.s.bankAccounts!;
    expect(() => f.run({ type: 'finance.importReceipts', payload: { accountId: usd.id, receipts: [{ date: '2026-02-01', payer: 'A', amount: 10, currency: 'CNY', ref: 'X' }] } })).toThrow('币种');
    expect(() => f.run({ type: 'finance.importReceipts', payload: { accountId: usd.id, receipts: [{ date: '2025-12-01', payer: 'A', amount: 10, currency: 'USD', ref: 'X' }] } })).toThrow('期初');
    expect(f.s.receipts).toHaveLength(0);
    expect(f.run({ type: 'finance.importReceipts', payload: { accountId: usd.id, receipts: [{ date: '2026-02-01', payer: 'A', amount: 1000, currency: 'USD', ref: 'R1' }] } })).toMatchObject({ imported: 1 });
    expect(f.s.receipts[0].accountId).toBe(usd.id);
    expect(f.run({ type: 'finance.importReceipts', payload: { accountId: usd.id, receipts: [{ date: '2026-02-01', payer: 'A', amount: 1000, currency: 'USD', ref: 'R1' }] } })).toMatchObject({ imported: 0, skipped: 1 });
    f.run({ type: 'finance.payment.save', payload: { date: '2026-02-02', payee: '代理', amount: 1000, currency: 'USD', ref: 'P', accountId: usd.id } });
    expect(f.s.payments[0].accountId).toBe(usd.id);
    expect(() => f.run({ type: 'finance.payment.save', payload: { date: '2026-02-02', payee: '代理', amount: 1, currency: 'USD', ref: 'P', accountId: cny.id } })).toThrow('币种');
    expect(mistBankAccountBalances(f.s).accounts[0].balance).toBe(0);
  });

  it('销户须余额为零且销户日后无流水；销户后不再记入流水、结汇、归属或冲回，可按原因恢复', () => {
    expect(mistCommandPermission({ type: 'finance.account.close', payload: { id: 'x', date: '2026-10-01', reason: 'x' } })).toBe('vouchers:write');
    const f = setup(), [usd, cny] = f.s.bankAccounts!;
    f.run({ type: 'finance.importReceipts', payload: { accountId: usd.id, receipts: [{ date: '2026-03-01', payer: 'A', amount: 500, currency: 'USD', ref: 'R1' }] } });
    expect(() => f.run({ type: 'finance.account.close', payload: { id: usd.id, date: '2026-09-30', reason: '销户' } })).toThrow('余额 500.00 USD 不为零');
    f.run({ type: 'finance.fx.settle', payload: { date: '2026-09-30', bankName: '中行', currency: 'USD', amount: 500, localCurrency: 'CNY', localAmount: 3560, fromAccountId: usd.id, toAccountId: cny.id, ref: 'S1' } });
    expect(() => f.run({ type: 'finance.account.close', payload: { id: usd.id, date: '2026-09-01', reason: '销户' } })).toThrow('销户日之后仍有流水');
    expect(() => f.run({ type: 'finance.account.close', payload: { id: usd.id, date: '2026-10-20', reason: '销户' } })).toThrow('不能晚于今天');
    f.run({ type: 'finance.account.close', payload: { id: usd.id, date: '2026-09-30', reason: '中行美元户销户回执' } });
    expect(f.s.bankAccounts![0].closed).toMatchObject({ date: '2026-09-30', reason: '中行美元户销户回执' });
    expect(() => f.run({ type: 'finance.importReceipts', payload: { accountId: usd.id, receipts: [{ date: '2026-10-02', payer: 'A', amount: 1, currency: 'USD', ref: 'R2' }] } })).toThrow('已于 2026-09-30 销户');
    f.run({ type: 'finance.importReceipts', payload: { receipts: [{ date: '2026-10-02', payer: 'A', amount: 1, currency: 'USD', ref: 'R3' }] } });
    const r3 = f.s.receipts.find(r => r.ref === 'R3')!;
    expect(() => f.run({ type: 'finance.account.assign', payload: { kind: 'receipt', id: r3.id, accountId: usd.id } })).toThrow('销户');
    const r1 = f.s.receipts.find(r => r.ref === 'R1')!;
    expect(() => f.run({ type: 'finance.account.assign', payload: { kind: 'receipt', id: r1.id, accountId: null, reason: '错' } })).toThrow('已销户，流水归属已锁定');
    expect(() => f.run({ type: 'finance.fx.settle', payload: { date: '2026-10-05', bankName: '中行', currency: 'USD', amount: 1, localCurrency: 'CNY', localAmount: 7, fromAccountId: usd.id, toAccountId: cny.id, ref: 'S2' } })).toThrow('销户');
    expect(() => f.run({ type: 'finance.account.close', payload: { id: usd.id, date: '2026-09-30', reason: 'x' } })).toThrow('已销户');
    f.run({ type: 'finance.account.reopen', payload: { id: usd.id, reason: '银行撤销销户' } });
    expect(f.s.bankAccounts![0].closed).toBeUndefined();
    f.run({ type: 'finance.account.assign', payload: { kind: 'receipt', id: r3.id, accountId: usd.id } });
    expect(f.s.receipts.find(r => r.ref === 'R3')!.accountId).toBe(usd.id);
  });
});
