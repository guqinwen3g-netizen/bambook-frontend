import { describe, expect, it } from 'vitest';
import { createMistState, type MistContext } from '../../../../server/src/shared/mistWorkspace';
import { rankSearchRecords, workspaceSearchRecords, type MistSearchRecord } from './search';

const rec = (label: string, hint = '', keywords = '', group = '订单'): MistSearchRecord => ({ view: 'orders/detail', id: label, group, label, hint, keywords });
describe('统一搜索', () => {
  it('requires every space-separated token and ranks name matches first', () => {
    const rows = [rec('SO-1002', 'Panda', 'AW26'), rec('Panda 外套', 'C-9'), rec('PANDA', 'C-1'), rec('其他', '', 'panda')];
    expect(rankSearchRecords(rows, 'panda').map(r => r.label)).toEqual(['PANDA', 'Panda 外套', 'SO-1002', '其他']);
    expect(rankSearchRecords(rows, 'panda aw26').map(r => r.label)).toEqual(['SO-1002']);
    expect(rankSearchRecords(rows, '   ')).toEqual([]);
  });
  it('only returns records from pages the account can enter', () => {
    let i = 0; const context = { id: () => `id-${++i}`, now: '2026-10-15T00:00:00Z', actorName: 'A', actorId: 'a' } as unknown as MistContext;
    const state = createMistState(context, 'empty');
    state.customers = [{ id: 'c1', name: '实际客户', code: 'C1' } as any];
    state.orders = [{ id: 'o1', code: 'SO-1', customer: '实际客户' } as any];
    const all = workspaceSearchRecords(state, () => true), limited = workspaceSearchRecords(state, view => view !== 'crm');
    expect(all.map(r => r.group)).toEqual(['订单', '客户']);
    expect(all.find(r => r.group === '客户')?.target).toEqual({ customerId: 'c1' });
    expect(limited.map(r => r.group)).toEqual(['订单']);
  });
});
