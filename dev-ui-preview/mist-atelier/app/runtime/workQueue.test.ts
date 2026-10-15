import { describe, expect, it } from 'vitest';
import { createMistState } from '../../../../server/src/shared/mistWorkspace';
import { mistEmailFollowUpTaskIds, mistWorkQueue } from './workQueue';

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
  });
  it('surfaces QC results waiting for the business and hides them once confirmed or without QC access', () => {
    const state = base();
    state.fulfillment.qcTasks = [qc({}), qc({ id: 'qc-2', code: 'QC-2', kind: 'production', state: 'awaiting_business' }), qc({ id: 'qc-3', code: 'QC-3', kind: 'production', state: 'blocked' }),
      qc({ id: 'qc-4', code: 'QC-4', businessConfirmation: { result: 'approved', note: '', actor: 'a', at: 'x' } }), qc({ id: 'qc-5', code: 'QC-5', state: 'pending' })] as any;
    const items = mistWorkQueue(state, { canRead: all, me: 'me', today: '2026-10-15' });
    expect(items.map(item => item.id)).toEqual(['qc:qc-1', 'qc:qc-2', 'qc:qc-3']);
    expect(items[2]).toMatchObject({ when: '已阻断', urgent: true, target: { view: 'qc-workbench', id: 'qc-3' } });
    expect(mistWorkQueue(state, { canRead: view => view !== 'qc-workbench', me: 'me', today: '2026-10-15' })).toEqual([]);
  });
  it('flags departed shipments whose documents have not been sent', () => {
    const state = base();
    state.fulfillment.shipments = [{ id: 'sh-1', code: 'SH-1', customer: '客户', state: 'departed', departedAt: '2026-10-14T00:00:00Z' }, { id: 'sh-2', code: 'SH-2', customer: '客户', state: 'departed', documentsSentAt: '2026-10-14' }, { id: 'sh-3', code: 'SH-3', customer: '客户', state: 'ready' }] as any;
    expect(mistWorkQueue(state, { canRead: all, me: 'me', today: '2026-10-15' }).map(item => item.target)).toEqual([{ view: 'shipments', id: 'sh-1' }]);
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
  it('identifies follow-up tasks created from email', () => {
    const state = base(); state.email.messages = [{ followUpTaskIds: ['t1', 't2'] }, { followUpTaskIds: [] }] as any;
    expect([...mistEmailFollowUpTaskIds(state)]).toEqual(['t1', 't2']);
  });
});
