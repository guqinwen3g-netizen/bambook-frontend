import { describe, expect, it } from 'vitest';
import { applyMistCommand, createMistState, lineAmount, type MistContext } from '../../../../server/src/shared/mistWorkspace';
import { orderAmounts, sumOrderMoney } from './orderAmounts';

describe('canonical order amount previews', () => {
  it.each([
    [1.005, 1, 1.01],
    [3.3333, 2.99, 9.97],
    [0.0001, 100, 0.01],
    [2.5555, 0.5, 1.28],
    [3.2, 0, 0],
    [999999999, 0.01, 9999999.99],
  ])('matches server decimal rounding for %s × %s', (qty, price, expected) => {
    expect(lineAmount(qty, price)).toBe(expected);
    expect(orderAmounts([{ qty, price }])).toEqual({ items: [{ amount: expected, error: '' }], total: expected, cents: Math.round(expected * 100), error: '' });
  });

  it('matches the persisted server total after individually rounded lines are accumulated', () => {
    let sequence = 0;
    const context: MistContext = { id: () => `amount-${++sequence}`, now: '2026-10-13T02:00:00.000Z', actorName: '业务员甲', actorId: 'sales' };
    const state = createMistState(context, 'empty');
    state.customers.push({ id: 'customer-a', code: 'C-A', name: '客户甲', country: '', city: '', industry: '', owner: '业务员甲', grade: 'A', currency: 'USD', terms: '', incoterm: '', categories: '', creditLimit: 0, since: '2026-01-01' });
    const lines = [{ qty: 1.005, price: 1 }, { qty: 1.005, price: 1 }, { qty: 0.3, price: 0.1 }];
    const result = applyMistCommand(state, { type: 'order.create', payload: { type: 'garment', customerId: 'customer-a', season: 'AW28', currency: 'USD', due: '2026-10-30', ownerId:'sales', lines: lines.map((line, index) => ({ ...line, name: '条目', style: `SKU-${index}`, img: 'coat', unit: '件' })) } }, context);
    expect(orderAmounts(lines).total).toBe(2.05);
    expect(orderAmounts(lines).total).toBe(result.state.orders[0].amount);
  });

  it.each([
    { qty: 0, price: 1 }, { qty: -1, price: 1 }, { qty: Number.NaN, price: 1 },
    { qty: 1.00001, price: 1 }, { qty: 1, price: 1.001 }, { qty: 1, price: Number.POSITIVE_INFINITY },
    { qty: 1, price: -1 }, { qty: 999999999, price: 999999999999.99 },
  ])('returns an actionable error and no misleading total for invalid values: %j', line => {
    const result = orderAmounts([{ qty: 1.005, price: 1 }, line]);
    expect(result.items[0].amount).toBe(1.01);
    expect(result.items[1].amount).toBeNull();
    expect(result.total).toBeNull();
    expect(result.error).toMatch(/^条目 2：/);
  });

  it('does not present an empty order as a zero-value confirmed total', () => {
    expect(orderAmounts([])).toEqual({ items: [], total: null, cents: null, error: '请至少添加一个订单条目' });
  });

  it('accumulates received money without floating point addition residue', () => {
    expect(sumOrderMoney([0.1, 0.2])).toEqual({ total: 0.3, cents: 30, error: '' });
    expect(sumOrderMoney([1.001]).total).toBeNull();
    expect(sumOrderMoney(Array(200).fill(999999999999.99))).toEqual({ total: null, cents: null, error: '总金额超出支持范围' });
  });
});
