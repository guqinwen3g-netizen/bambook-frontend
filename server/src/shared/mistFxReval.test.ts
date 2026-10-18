import { describe, expect, it } from 'vitest';
import { applyMistCommand, createMistState, mistCommandPermission, type MistCommand, type MistContext, type MistState } from './mistWorkspace';
import { fxCnyMinor, fxRevaluationPreview, readFxRevaluations } from './mistFxRates';

function setup(now = '2026-10-17T04:00:00Z') {
  let n = 0; const ctx: MistContext = { id: () => `rv-${++n}`, now, actorName: '林舒', actorId: 'demo-finance' };
  let state = createMistState(ctx, 'empty');
  const run = (command: MistCommand) => { const out = applyMistCommand(state, command, ctx); state = out.state; return out.result as { id: string }; };
  return { get state() { return state; }, run, ctx };
}
const acct = (id: string, currency: string, openingBalance: number) => ({ id, code: 'BA-' + id, name: currency + ' 户', bankName: '中行', accountNo: '1', currency, openingDate: '2026-08-01', openingBalance, createdAt: '', actor: '' });
const rcpt = (id: string, date: string, amount: number, accountId = 'usd') => ({ id, code: 'R-' + id, date, payer: 'Nordic', amount, remaining: amount, currency: 'USD', ref: '', state: 'unmatched' as const, accountId });
function seed(s: MistState) {
  s.bankAccounts = [acct('usd', 'USD', 1000), acct('cny', 'CNY', 0)];
  s.receipts = [rcpt('r1', '2026-09-10', 5000), rcpt('r2', '2026-10-02', 3000)];
  s.payments = [{ id: 'p1', code: 'PAY-1', date: '2026-09-12', payee: '代理', amount: 200, currency: 'USD', ref: '', accountId: 'usd' }];
  s.fxRecords = [{ id: 'fx1', code: 'FX-1', kind: 'settlement', date: '2026-09-20', bankName: '中行', currency: 'USD', amount: 2000, localCurrency: 'CNY', localAmount: 14400, rate: '7.200000', ref: '', note: '', fromAccountId: 'usd', toAccountId: 'cny', createdAt: '', actor: '' }];
  s.invoices = [
    { id: 'i1', code: 'CI-1', orderId: 'o1', order: 'SO-1', customer: 'Nordic', due: '2026-11-01', amount: 10000, open: 0, currency: 'USD', issuedAt: '2026-09-05' },
    { id: 'i2', code: 'CI-2', orderId: 'o1', order: 'SO-1', customer: 'Nordic', due: '2026-12-01', amount: 500, open: 0, currency: 'USD', issuedAt: '2026-10-05' },
    { id: 'i3', code: 'CI-3', orderId: 'o2', order: 'SO-2', customer: 'Nordic', due: '2026-12-01', amount: 900, open: 0, currency: 'USD', issuedAt: '2026-09-06', voidedAt: '2026-09-07' },
  ];
  s.allocations = [
    { id: 'a1', receiptId: 'r1', invoiceId: 'i1', amount: 4000, currency: 'USD', createdAt: '2026-09-11T00:00:00Z', actor: '' },
    { id: 'a2', receiptId: 'r2', invoiceId: 'i1', amount: 3000, currency: 'USD', createdAt: '2026-10-03T00:00:00Z', actor: '' },
  ];
}
const rate = (f: ReturnType<typeof setup>, month: string, r: string) => f.run({ type: 'fxrate.period.save', payload: { month, currency: 'USD', rate: r, source: '人民银行月末中间价' } });

describe('期末调汇（汇兑损益）', () => {
  it('按月初汇率记账、月末汇率重估：银行按流水日、应收按开票日与到账日截止，结汇差额为已实现损益', () => {
    const f = setup(); seed(f.state); rate(f, '2026-08', '7.100000'); rate(f, '2026-09', '7.150000');
    const v = fxRevaluationPreview(f.state, '2026-09', '2026-10-17');
    expect(v.blockers).toEqual([]);
    const by = (k: string) => v.lines.filter(l => l.kind === k);
    expect(by('bank')).toMatchObject([{ refId: 'usd', amount: 3800, bookCny: 26980, closingCny: 27170, diff: 190 }]);
    expect(by('receivable')).toMatchObject([{ refId: 'i1', amount: 6000, diff: 300 }]);
    expect(by('unapplied')).toMatchObject([{ refId: 'r1', amount: -1000, diff: -50 }]);
    expect(by('settlement')).toMatchObject([{ refId: 'fx1', amount: 2000, bookCny: 14200, closingCny: 14400, closingRate: '7.200000', diff: 200 }]);
    expect(v).toMatchObject({ unrealized: 440, realized: 200, total: 640 });
    expect(v.currencies).toEqual([{ currency: 'USD', bookRate: '7.100000', closingRate: '7.150000', unrealized: 440, realized: 200, total: 640 }]);
    expect(fxCnyMinor(-333, '7.15')).toBe(-2381);
  });

  it('登记冻结明细；须到月末、汇率齐全、按月连续；作废只能倒序，作废后可重登', () => {
    expect(mistCommandPermission({ type: 'fxrate.reval.post', payload: { month: '2026-09' } })).toBe('vouchers:write');
    const f = setup(); seed(f.state);
    rate(f, '2026-08', '7.100000');
    expect(() => f.run({ type: 'fxrate.reval.post', payload: { month: '2026-09' } })).toThrow('缺少汇率：2026-09 USD 月末汇率');
    rate(f, '2026-09', '7.150000');
    expect(() => f.run({ type: 'fxrate.reval.post', payload: { month: '2026-10' } })).toThrow('尚未到月末');
    const sep = f.run({ type: 'fxrate.reval.post', payload: { month: '2026-09', note: '9 月结账' } }).id;
    const rec = readFxRevaluations(f.state)[0];
    expect(rec).toMatchObject({ id: sep, code: 'FXR-2026-0001', month: '2026-09', total: 640, note: '9 月结账', actor: '林舒' });
    expect(() => f.run({ type: 'fxrate.reval.post', payload: { month: '2026-09' } })).toThrow('已登记期末调汇');
    expect(() => f.run({ type: 'fxrate.reval.post', payload: { month: '2026-08' } })).toThrow('不能回头登记更早月份');
    // 登记后改动流水不影响已冻结的明细
    f.state.receipts[0].amount = 9999;
    expect(readFxRevaluations(f.state)[0].lines.find(l => l.kind === 'bank')?.amount).toBe(3800);
    f.run({ type: 'fxrate.reval.void', payload: { id: sep, reason: '漏登流水' } });
    expect(() => f.run({ type: 'fxrate.reval.void', payload: { id: sep, reason: '再次' } })).toThrow('已作废');
    expect(f.run({ type: 'fxrate.reval.post', payload: { month: '2026-09' } }).id).not.toBe(sep);
  });

  it('跳月登记被拒；后续月份未作废时不能作废前一期', () => {
    const f = setup('2026-12-05T04:00:00Z'); seed(f.state);
    for (const [m, r] of [['2026-08', '7.1'], ['2026-09', '7.15'], ['2026-10', '7.12'], ['2026-11', '7.2']]) rate(f, m, r);
    const sep = f.run({ type: 'fxrate.reval.post', payload: { month: '2026-09' } }).id;
    expect(() => f.run({ type: 'fxrate.reval.post', payload: { month: '2026-11' } })).toThrow('本次应登记 2026-10');
    const oct = f.run({ type: 'fxrate.reval.post', payload: { month: '2026-10' } }).id;
    // 10 月：记账汇率 7.15 → 月末 7.12；应收含 10-02 到账前的 i1 余额已核销 3000、新增 i2
    const r = readFxRevaluations(f.state).find(x => x.id === oct)!;
    expect(r.lines.find(l => l.kind === 'receivable' && l.refId === 'i1')?.amount).toBe(3000);
    expect(r.lines.find(l => l.kind === 'receivable' && l.refId === 'i2')?.amount).toBe(500);
    expect(r.realized).toBe(0);
    expect(() => f.run({ type: 'fxrate.reval.void', payload: { id: sep, reason: 'x' } })).toThrow('请先作废后续月份 2026-10');
  });
});
