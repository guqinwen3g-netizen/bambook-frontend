// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_PAGES } from './MarketPages';
import { Nav } from '../../nav';
import { createMistState, type MistContext, type MistState } from '../../../../../server/src/shared/mistWorkspace';
import { developmentDomain } from '../../../../../server/src/shared/mistDevelopmentDomain';

const bridge = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => bridge.current }));
vi.mock('../../runtime/auth', () => { const useMistSession = () => ({ user: { id: 'demo-sales', displayName: '顾言' }, hasPermission: () => true, hasRole: () => false, canAccessView: () => true }); return { useMistSession, useOptionalMistSession: useMistSession }; });
let host: HTMLDivElement, root: Root | undefined, state: MistState; const go = vi.fn();
let version: MistState['versions'][number];
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; go.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
  let n = 0; const ctx: MistContext = { id: () => `q4-${++n}`, actorName: '演示', now: '2026-10-14T02:00:00.000Z' };
  state = createMistState(ctx, 'demo');
  version = state.versions.find(v => !v.archivedAt && developmentDomain(state.devs.find(d => d.id === v.devId)!.values) !== 'fabric')!;
  version.confirmations = [];
  const dev = state.devs.find(d => d.id === version.devId)!;
  state.market.quotations.push({ id: 'qt-q4', code: 'QT-Q4-0001', customerId: state.customers[0].id, currency: 'USD', season: 'AW27', validUntil: '2026-12-31', deliveryTerms: 'FOB', paymentTerms: 'TT', status: 'Accepted', lines: [{ id: 'ql-q4', productId: '', sourceDevId: dev.id, sourceVersionId: version.id, name: '版本来源大衣', style: dev.style, specification: '', qty: '100', unit: '件', price: '50', amount: '5000.00', cost: '30' }], total: '5000.00', deliveryEvidence: '邮件', responseEvidence: '客户接受', approval: null, convertedOrderId: null, fileIds: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' } as never);
  bridge.current = { state, run: vi.fn(async () => ({ result: { id: 'saved' } })), error: '', refresh: vi.fn(), loading: false, saving: false, pending: null, upload: vi.fn() };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); });
async function mount(id: string) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); const Page = MARKET_PAGES.quotations; await act(async () => root!.render(<Nav.Provider value={{ route: { view: 'quotations', id }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() }}><Page /></Nav.Provider>)); }
const button = (label: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

describe('BB-QUO-4 转订单须开发版本已获需求方认可', () => {
  it('引用未确认开发版本时禁用“核对并转订单”，并写明哪个条目、哪个版本', async () => {
    await mount('qt-q4');
    const convert = button('核对并转订单')!;
    expect(convert.disabled).toBe(true);
    const text = document.body.querySelector('[data-convert-blockers]')?.textContent || '';
    expect(text).toContain('版本来源大衣'); expect(text).toContain(version.label); expect(text).toContain('尚无需求方确认');
    expect(document.body.textContent).toContain('开发版本未获需求方认可');
  });
  it('需求方认可后按钮可用，提示消失', async () => {
    version.confirmations.push({ id: 'cf', result: 'approved', confirmer: '客户', organization: '', confirmedAt: '2026-10-10T00:00:00.000Z', basis: '邮件', originalText: '', recordedAt: '2026-10-10T00:00:00.000Z', recordedBy: '演示' });
    await mount('qt-q4');
    expect(button('核对并转订单')!.disabled).toBe(false);
    expect(document.body.querySelector('[data-convert-blockers]')).toBeNull();
  });
});
