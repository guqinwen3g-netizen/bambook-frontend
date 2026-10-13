import { describe, expect, it } from 'vitest';
import { buildQuantityPlan, prepareQuantityPlanDraft } from './orderQuantityPlanUiService';

const makeOrder = () => ({
  id: 'O1',
  updatedAt: '1780000000000',
  lines: [
    { id: 'P1', orderId: 'O1', lineNumber: 2, quantity: '5', unit: 'PC', unitPrice: null, netValue: '0' as string | null },
    { id: 'M1', orderId: 'O1', lineNumber: 1, quantity: '1000' as string | number, unit: 'M', unitPrice: '2', netValue: '1750' },
  ],
});

describe('exact per-line quantity plan UI contract', () => {
  it('orders actual rows and keeps mixed units separate without allocating a header total', () => {
    const draft = prepareQuantityPlanDraft(makeOrder());
    expect(draft.rows.map(row => row.lineId)).toEqual(['M1', 'P1']);
    draft.rows[0].afterQuantity = '800.0003';
    draft.rows[0].afterNetValue = '1500';
    const plan = buildQuantityPlan(draft);
    expect(plan.lines.map(line => [line.lineId, line.unit, line.afterQuantity, line.afterNetValue])).toEqual([
      ['M1', 'M', '800.0003', '1500'],
      ['P1', 'PC', '5', '0'],
    ]);
  });

  it('preserves exact decimal text through JSON', () => {
    const draft = prepareQuantityPlanDraft(makeOrder());
    draft.rows[0].afterQuantity = '0.0003';
    draft.rows[0].afterNetValue = '0.0001';
    expect(JSON.parse(JSON.stringify(buildQuantityPlan(draft))).lines[0].afterQuantity).toBe('0.0003');
  });

  it('keeps an unchanged unknown net value null but requires a changed row amount', () => {
    const order = makeOrder();
    order.lines[0].netValue = null;
    const draft = prepareQuantityPlanDraft(order);
    draft.rows[0].afterQuantity = '900';
    draft.rows[0].afterNetValue = '1600';
    expect(buildQuantityPlan(draft).lines[1].afterNetValue).toBeNull();
    draft.rows[1].afterNetValue = '';
    const unchanged = buildQuantityPlan(draft);
    expect(unchanged.lines[1].afterNetValue).toBeNull();
    draft.rows[1].afterQuantity = '4';
    expect(() => buildQuantityPlan(draft)).toThrow('必须明确填写变更后净额');
  });

  it('rejects missing units, stale versions, duplicates, and imprecise numbers', () => {
    const order = makeOrder();
    expect(() => prepareQuantityPlanDraft({ ...order, updatedAt: undefined })).toThrow('版本');
    order.lines[0].unit = '';
    expect(() => prepareQuantityPlanDraft(order)).toThrow('单位');
    order.lines[0].unit = 'PC';
    order.lines[1].id = 'P1';
    expect(() => prepareQuantityPlanDraft(order)).toThrow('重复');
    order.lines[1].id = 'M1';
    order.lines[1].quantity = 0.1 + 0.2;
    expect(() => prepareQuantityPlanDraft(order)).toThrow();
  });

  it('rejects a money-only change as a quantity change', () => {
    const draft = prepareQuantityPlanDraft(makeOrder());
    draft.rows[0].afterNetValue = '1600';
    expect(() => buildQuantityPlan(draft)).toThrow('没有实际数量变化');
  });
});
