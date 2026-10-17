import { describe, expect, it } from 'vitest';
import { createMistState } from '../../../../server/src/shared/mistWorkspace';
import { mistEmailFollowUpTaskIds, mistMyTasks, mistMyWork, mistWorkQueue } from './workQueue';

let n = 0;
const ctx = () => ({ id: () => `id-${++n}`, now: '2026-10-15T08:00:00.000Z', actorName: '当前员工' });
const all = () => true;
const base = () => { const state = createMistState(ctx(), 'empty'); state.fulfillment.qcTasks = []; state.fulfillment.shipments = []; return state; };
const qc = (patch: any) => ({ id: 'qc-1', code: 'QC-1', source: { kind: 'version', versionId: 'v', devId: 'd' }, domain: 'garment', kind: 'sample', factory: '实际工厂', location: '', contact: '', due: '2026-10-20', requestedBy: '业务员甲', assignee: '', state: 'reported', reportIds: ['r'], createdAt: '2026-10-01', ...patch });
const request = (patch: any) => ({ id: 'pr-1', code: 'PR-1', purpose: 'prepayment', supplierId: 's1', supplier: '实际供应商', currency: 'CNY', amount: 100, planId: 'plan-1', lines: [], reason: '', fileIds: [], requesterId: 'me', requester: '我', submittedAt: '2026-10-10T00:00:00Z', reviewerIds: ['boss'], snapshot: [], state: 'rejected', decision: { actorId: 'boss', actor: '财务主管', at: '2026-10-12T00:00:00Z', decision: 'rejected', note: '缺少合同' }, paymentHistory: [], ...patch });

describe('my work queue sources', () => {
  it('lists only reviews I can decide, pointing at the exact approval', () => {
    const items = mistWorkQueue(base(), { canRead: all, me: 'me', today: '2026-10-15', reviews: [
      { id: 'payment:1', workspaceId: 'w1', workspaceName: '空间一', title: '付款 1', status: 'pending', canDecide: true, submittedAt: '2026-10-14T00:00:00Z' } as any,
      { id: 'payment:2', workspaceId: 'w1', workspaceName: '空间一', title: '付款 2', status: 'pending', canDecide: false, submittedAt: '2026-10-14T00:00:00Z' } as any,
      { id: 'payment:3', workspaceId: 'w1', workspaceName: '空间一', title: '付款 3', status: 'approved', canDecide: true, submittedAt: '2026-10-14T00:00:00Z' } as any] });
    expect(items.map(item => item.title)).toEqual(['付款 1']);
    expect(items[0].target).toEqual({ view: 'approvals', id: 'w1|payment:1', section: 'mine' });
    expect(items[0].module).toBe('approvals');
  });
  it('files reviews of the current workspace under their business module and other workspaces under approvals', () => {
    const row = (id: string, workspaceId: string) => ({ id, workspaceId, workspaceName: workspaceId, title: id, status: 'pending', canDecide: true, submittedAt: '2026-10-14T00:00:00Z', target: { view: 'procurement', id: 'p1' } }) as any;
    const items = mistWorkQueue(base(), { canRead: all, me: 'me', today: '2026-10-15', workspaceId: 'w1', reviews: [row('a', 'w1'), row('b', 'w2')] });
    expect(items.map(item => item.module)).toEqual(['procurement', 'approvals']);
    expect(mistWorkQueue(base(), { canRead: view => view !== 'procurement', me: 'me', today: '2026-10-15', workspaceId: 'w1', reviews: [row('a', 'w1')] })[0].module).toBe('approvals');
  });
  it('surfaces QC results waiting for the business and hides them once confirmed or without QC access', () => {
    const state = base();
    state.fulfillment.qcTasks = [qc({}), qc({ id: 'qc-2', code: 'QC-2', kind: 'production', state: 'awaiting_business' }), qc({ id: 'qc-3', code: 'QC-3', kind: 'production', state: 'blocked' }),
      qc({ id: 'qc-4', code: 'QC-4', businessConfirmation: { result: 'approved', note: '', actor: 'a', at: 'x' } }), qc({ id: 'qc-5', code: 'QC-5', state: 'pending' })] as any;
    const business = (p: string) => p === 'orders:write';
    const items = mistWorkQueue(state, { canRead: all, can: business, me: 'me', today: '2026-10-15' });
    expect(items.map(item => item.id)).toEqual(['qc:qc-1', 'qc:qc-2', 'qc:qc-3']);
    expect(items[2]).toMatchObject({ when: '已阻断', urgent: true, module: 'qc-workbench', target: { view: 'qc-workbench', id: 'qc-3' } });
    expect(mistWorkQueue(state, { canRead: view => view !== 'qc-workbench', can: business, me: 'me', today: '2026-10-15' })).toEqual([]);
    expect(mistWorkQueue(state, { canRead: all, me: 'me', today: '2026-10-15' })).toEqual([]);
  });
  it('gives QC staff unclaimed tasks of their domain and the tasks they are working on', () => {
    const state = base();
    state.fulfillment.qcTasks = [qc({ id: 'a', code: 'A', state: 'pending' }), qc({ id: 'b', code: 'B', state: 'pending', domain: 'fabric' }), qc({ id: 'c', code: 'C', state: 'working', assigneeId: 'me' }), qc({ id: 'd', code: 'D', state: 'working', assigneeId: 'other' }), qc({ id: 'e', code: 'E' })] as any;
    const items = mistWorkQueue(state, { canRead: all, can: p => p === 'qc:garment_chain:write' || p === 'qc:inspect', me: 'me', today: '2026-10-15' });
    expect(items.map(item => [item.id, item.when])).toEqual([['qc:a', '待认领'], ['qc:c', '处理中']]);
    expect(mistWorkQueue(state, { canRead: all, can: p => p === 'qc:garment_chain:write', me: 'me', today: '2026-10-15' })).toEqual([]);
  });
  it('flags departed shipments whose documents have not been sent', () => {
    const state = base();
    state.fulfillment.shipments = [{ id: 'sh-1', code: 'SH-1', customer: '客户', state: 'departed', departedAt: '2026-10-14T00:00:00Z' }, { id: 'sh-2', code: 'SH-2', customer: '客户', state: 'departed', documentsSentAt: '2026-10-14' }, { id: 'sh-3', code: 'SH-3', customer: '客户', state: 'ready' }] as any;
    state.fulfillment.shipments.push({ id: 'sh-4', code: 'SH-4', customer: '客户', state: 'preparing', plannedDate: '2026-10-20', lines: [] } as any);
    const business = (p: string) => p === 'orders:write', logistics = (p: string) => p === 'shipments:write';
    expect(mistWorkQueue(state, { canRead: all, can: business, me: 'me', today: '2026-10-15' }).map(item => item.target)).toEqual([{ view: 'shipments', id: 'sh-1' }, { view: 'shipments', id: 'sh-3' }]);
    expect(mistWorkQueue(state, { canRead: all, can: logistics, me: 'me', today: '2026-10-15' }).map(item => [item.target.id, item.when])).toEqual([['sh-4', '待接手']]);
    expect(mistWorkQueue(state, { canRead: all, me: 'me', today: '2026-10-15' })).toEqual([]);
  });
  it('returns my recently rejected payment requests until a new request replaces them', () => {
    const state = base();
    state.payables = { bills: [], payments: [], allocations: [], requests: [request({}), request({ id: 'pr-2', code: 'PR-2', requesterId: 'other' }), request({ id: 'pr-3', code: 'PR-3', decision: { actorId: 'b', actor: 'b', at: '2026-08-01T00:00:00Z', decision: 'rejected', note: '' } })] } as any;
    const items = mistWorkQueue(state, { canRead: all, me: 'me', today: '2026-10-15' });
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ id: 'finance:pr-1', target: { view: 'payment-vouchers', id: 'pr-1' } }); expect(items[0].meta).toContain('缺少合同');
    state.payables!.requests!.push(request({ id: 'pr-4', code: 'PR-4', state: 'pending', submittedAt: '2026-10-13T00:00:00Z', decision: undefined }) as any);
    expect(mistWorkQueue(state, { canRead: all, me: 'me', today: '2026-10-15' })).toEqual([]);
    expect(mistWorkQueue({ ...state, payables: { ...state.payables!, requests: [request({})] } } as any, { canRead: view => view !== 'payment-vouchers', me: 'me', today: '2026-10-15' })).toEqual([]);
  });
  it('gives finance unclaimed or suggested receipts and invoices waiting for confirmation', () => {
    const state = base();
    state.receipts = [{ id: 'r1', code: 'R1', date: '2026-10-10', payer: '甲', amount: 10, remaining: 10, currency: 'USD', ref: '', state: 'unmatched' }, { id: 'r2', code: 'R2', date: '2026-10-11', payer: '乙', amount: 10, remaining: 10, currency: 'USD', ref: '', state: 'suggested' },
      { id: 'r3', code: 'R3', date: '2026-10-11', payer: '丙', amount: 10, remaining: 0, currency: 'USD', ref: '', state: 'matched' }, { id: 'r4', code: 'R4', date: '2026-10-11', payer: '丁', amount: 10, remaining: 5, currency: 'USD', ref: '', state: 'unmatched' }] as any;
    state.allocations = [{ id: 'al', receiptId: 'r4', invoiceId: 'i0', amount: 5, currency: 'USD', createdAt: '', actor: '' }] as any;
    state.invoices = [{ id: 'i1', code: 'INV-1', customer: '客户', order: 'SO-1', due: '2026-11-01', financeStatus: 'pending' }, { id: 'i2', code: 'INV-2', financeStatus: 'confirmed' }] as any;
    const items = mistWorkQueue(state, { canRead: all, can: p => p === 'invoices:reconcile' || p === 'invoices:write', me: 'me', today: '2026-10-15' });
    expect(items.map(item => [item.id, item.module])).toEqual([['receipt:r1', 'payment-vouchers'], ['receipt:r2', 'payment-vouchers'], ['invoice:i1', 'payment-vouchers']]);
    expect(items[2].target).toEqual({ view: 'invoices', section: 'pending', id: 'i1' });
    expect(mistWorkQueue(state, { canRead: all, me: 'me', today: '2026-10-15' })).toEqual([]);
  });
  it('counts work items only for their assignees or holders of the named permission', () => {
    const state = base();
    state.tasks = [{ id: 't1', title: '我的', due: '', done: false, kind: 'x', target: { view: 'crm', id: 'c' }, assigneeIds: ['me'] }, { id: 't2', title: '岗位', due: '', done: false, kind: 'x', target: { view: 'shipments', id: 's' }, assigneeIds: [], permission: 'shipments:write' },
      { id: 't3', title: '无主', due: '', done: false, kind: 'x', target: { view: 'orders/detail', id: 'o' }, assigneeIds: [] }, { id: 't4', title: '已完成', due: '', done: true, kind: 'x', target: { view: 'crm', id: 'c' }, assigneeIds: ['me'] }];
    expect(mistMyTasks(state, { canRead: all, me: 'me' }).map(task => task.id)).toEqual(['t1']);
    expect(mistMyWork(state, { canRead: all, can: p => p === 'shipments:write', me: 'me', today: '2026-10-15' }).map(item => [item.id, item.module])).toEqual([['task:t1', 'crm'], ['task:t2', 'shipments']]);
  });
  it('identifies follow-up tasks created from email', () => {
    const state = base(); state.email.messages = [{ followUpTaskIds: ['t1', 't2'] }, { followUpTaskIds: [] }] as any;
    expect([...mistEmailFollowUpTaskIds(state)]).toEqual(['t1', 't2']);
  });
});
