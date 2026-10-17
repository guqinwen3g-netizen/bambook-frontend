import { describe, expect, it } from 'vitest';
import { applyMistCommand, createMistState, mistCommandPermission, type MistCommand, type MistContext } from './mistWorkspace';
import { fxPeriodRateFor, fxRateFor, fxSettledAverage } from './mistFxRates';

function setup() {
  let n = 0; const ctx: MistContext = { id: () => `fx-${++n}`, now: '2026-10-17T04:00:00Z', actorName: '林舒', actorId: 'demo-finance' };
  let state = createMistState(ctx, 'empty');
  const run = (command: MistCommand) => { const out = applyMistCommand(state, command, ctx); state = out.state; return out.result as { id: string }; };
  return { get state() { return state; }, set state(v) { state = v; }, run };
}

describe('月末汇率与报表折算口径', () => {
  it('月末汇率由财务凭证权限登记；每月每币种一条，作废后可重登，取不晚于所选月份的最新一期', () => {
    expect(mistCommandPermission({ type: 'fxrate.period.save', payload: { month: '2026-09', currency: 'USD', rate: '7.1', source: 'x' } })).toBe('vouchers:write');
    const f = setup();
    const aug = f.run({ type: 'fxrate.period.save', payload: { month: '2026-08', currency: 'USD', rate: '7.1500', source: '人民银行 8 月末中间价' } }).id;
    const sep = f.run({ type: 'fxrate.period.save', payload: { month: '2026-09', currency: 'usd', rate: '7.1180', source: '人民银行 9 月末中间价' } }).id;
    expect(() => f.run({ type: 'fxrate.period.save', payload: { month: '2026-09', currency: 'USD', rate: '7.2', source: '重复' } })).toThrow('已登记月末汇率');
    expect(() => f.run({ type: 'fxrate.period.save', payload: { month: '2026-11', currency: 'USD', rate: '7.2', source: 'x' } })).toThrow('未来月份');
    expect(() => f.run({ type: 'fxrate.period.save', payload: { month: '2026-09', currency: 'CNY', rate: '1', source: 'x' } })).toThrow('人民币');
    expect(() => f.run({ type: 'fxrate.period.save', payload: { month: '2026-09', currency: 'EUR', rate: '-1', source: 'x' } })).toThrow('正数');
    expect(fxPeriodRateFor(f.state, 'USD', '2026-10')?.rate).toBe('7.1180');
    expect(fxPeriodRateFor(f.state, 'USD', '2026-08')?.id).toBe(aug);
    expect(fxPeriodRateFor(f.state, 'USD', '2026-07')).toBeUndefined();
    f.run({ type: 'fxrate.period.void', payload: { id: sep, reason: '取错日期' } });
    expect(fxPeriodRateFor(f.state, 'USD', '2026-10')?.id).toBe(aug);
    f.run({ type: 'fxrate.period.save', payload: { month: '2026-09', currency: 'USD', rate: '7.1190', source: '更正' } });
    expect(fxPeriodRateFor(f.state, 'USD', '2026-10')?.rate).toBe('7.1190');
  });

  it('实际结汇按未冲回结汇加权；定价预计取订单最新定价快照，仅美元；人民币恒为 1；缺汇率不猜', () => {
    const f = setup(), s = f.state;
    s.fxRecords = [
      { id: 'a', code: 'FX-1', kind: 'settlement', date: '2026-10-01', bankName: '', currency: 'USD', amount: 10000, localCurrency: 'CNY', localAmount: 71000, rate: '7.1', ref: '', note: '' },
      { id: 'b', code: 'FX-2', kind: 'settlement', date: '2026-10-10', bankName: '', currency: 'USD', amount: 30000, localCurrency: 'CNY', localAmount: 214500, rate: '7.15', ref: '', note: '' },
      { id: 'c', code: 'FX-3', kind: 'settlement', date: '2026-10-11', bankName: '', currency: 'USD', amount: 5000, localCurrency: 'CNY', localAmount: 40000, rate: '8', ref: '', note: '', reversed: { at: 'x', actor: 'x', reason: '错' } } as any,
      { id: 'd', code: 'FX-4', kind: 'lock', date: '2026-10-11', bankName: '', currency: 'USD', amount: 5000, localCurrency: 'CNY', localAmount: 40000, rate: '8', ref: '', note: '' },
    ];
    s.platform.pricing = [{ id: 'p1', orderId: 'o1', exchangeRate: 7.0, createdAt: '2026-09-01T00:00:00Z' } as any, { id: 'p2', orderId: 'o1', exchangeRate: 7.2, createdAt: '2026-09-05T00:00:00Z' } as any];
    expect(fxSettledAverage(s, 'USD')).toMatchObject({ rate: 7.1375, count: 2, amount: 40000 });
    expect(fxSettledAverage(s, 'USD', '2026-10-05')?.rate).toBe(7.1);
    const opts = { month: '2026-10', asOf: '2026-10-17', orderId: 'o1' };
    expect(fxRateFor(s, 'USD', 'actual', opts)).toMatchObject({ rate: 7.1375, estimated: false });
    expect(fxRateFor(s, 'USD', 'quote', opts)).toMatchObject({ rate: 7.2, estimated: true });
    expect(fxRateFor(s, 'EUR', 'quote', opts)).toBeUndefined();
    expect(fxRateFor(s, 'EUR', 'actual', opts)).toBeUndefined();
    expect(fxRateFor(s, 'USD', 'period', opts)).toBeUndefined();
    expect(fxRateFor(s, 'CNY', 'period', opts)).toMatchObject({ rate: 1 });
  });
});
