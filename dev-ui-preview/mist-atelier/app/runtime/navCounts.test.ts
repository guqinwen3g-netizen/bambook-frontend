import { describe, expect, it } from 'vitest';
import { mistNavCounts } from './workQueue';

const base = { tasks: [], fulfillment: { qcTasks: [], shipments: [] }, payables: { requests: [] } } as any;
const task = (id: string, view: string, patch: any = {}) => ({ id, title: id, due: '', done: false, kind: 'work', target: { view, id: 'x' }, assigneeIds: ['u1'], ...patch });
describe('mistNavCounts', () => {
  it('counts what waits for me per module, with 我的工作 as the total', () => {
    const state = { ...base,
      tasks: [task('t1', 'development/detail'), task('t2', 'development/detail', { done: true }), task('t3', 'orders/detail'), task('t4', 'orders/detail', { assigneeIds: ['u2'] }), task('t5', 'orders/detail', { assigneeIds: [] }), task('t6', 'invoices', { assigneeIds: [], permission: 'invoices:write' })],
      fulfillment: { qcTasks: [{ id: 'q1', code: 'QC-1', kind: 'sample', domain: 'garment', state: 'reported', factory: 'F', createdAt: '2026-10-01' }], shipments: [] },
      // 存量记录（订单、开发案总数）不计入侧栏数字。
      orders: [{ id: 'o1' }, { id: 'o2' }], devs: [{ id: 'd1' }, { id: 'd2' }] };
    const reviews = [{ id: 'r1', workspaceId: 'w1', workspaceName: '甲', title: '本空间', status: 'pending', canDecide: true, submittedAt: '2026-10-16T00:00:00Z', target: { view: 'orders/detail', id: 'o1' } }, { id: 'r2', workspaceId: 'w2', workspaceName: '乙', title: '其他空间', status: 'pending', canDecide: true, submittedAt: '2026-10-16T00:00:00Z', target: { view: 'orders/detail', id: 'o9' } }] as any;
    const counts = mistNavCounts(state, { canRead: () => true, can: p => p === 'orders:write' || p === 'invoices:write', me: 'u1', today: '2026-10-17', reviews, workspaceId: 'w1' });
    expect(counts).toEqual({ cockpit: 6, development: 1, orders: 2, 'qc-workbench': 1, 'payment-vouchers': 1, approvals: 1 });
  });
  it('hides sources the account cannot read and returns nothing when there is no work', () => {
    const state = { ...base, fulfillment: { qcTasks: [{ id: 'q1', code: 'QC-1', kind: 'sample', domain: 'garment', state: 'reported', factory: 'F', createdAt: '2026-10-01' }], shipments: [] } };
    expect(mistNavCounts(state, { canRead: view => view !== 'qc-workbench', can: () => true, me: 'u1', today: '2026-10-17' })).toEqual({});
    expect(mistNavCounts(null, { canRead: () => true, me: 'u1', today: '2026-10-17' })).toEqual({});
  });
});
