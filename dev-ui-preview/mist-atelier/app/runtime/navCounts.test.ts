import { describe, expect, it } from 'vitest';
import { mistNavCounts } from './workQueue';

const base = { tasks: [], fulfillment: { qcTasks: [], shipments: [] }, payables: { requests: [] } } as any;
describe('mistNavCounts', () => {
  it('counts only items that need handling, attributed to the target module, with 我的工作 as the total', () => {
    const state = { ...base,
      tasks: [
        { id: 't1', title: 'a', due: '', done: false, kind: 'development', target: { view: 'development/detail', id: 'd1' } },
        { id: 't2', title: 'b', due: '', done: true, kind: 'development', target: { view: 'development/detail', id: 'd2' } },
        { id: 't3', title: 'c', due: '', done: false, kind: 'work', target: { view: 'orders/detail', id: 'o1' } },
      ],
      fulfillment: { qcTasks: [{ id: 'q1', code: 'QC-1', kind: 'sample', state: 'reported', factory: 'F', createdAt: '2026-10-01' }], shipments: [] },
      // 存量记录（订单、开发案总数、未认领收款）不计入侧栏数字。
      orders: [{ id: 'o1' }, { id: 'o2' }], devs: [{ id: 'd1' }, { id: 'd2' }], receipts: [{ id: 'r1', remaining: 10 }] };
    const counts = mistNavCounts(state, { canRead: () => true, me: 'u1', today: '2026-10-17' });
    expect(counts).toEqual({ cockpit: 3, development: 1, orders: 1, 'qc-workbench': 1 });
  });
  it('hides sources the account cannot read and returns nothing when there is no work', () => {
    const state = { ...base, fulfillment: { qcTasks: [{ id: 'q1', code: 'QC-1', kind: 'sample', state: 'reported', factory: 'F', createdAt: '2026-10-01' }], shipments: [] } };
    expect(mistNavCounts(state, { canRead: view => view !== 'qc-workbench', me: 'u1', today: '2026-10-17' })).toEqual({});
    expect(mistNavCounts(null, { canRead: () => true, me: 'u1', today: '2026-10-17' })).toEqual({});
  });
});
