// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_PAGES } from './MarketPages';
import { Nav } from '../../nav';
import { applyMistCommand, createMistState, type MistContext, type MistState } from '../../../../../server/src/shared/mistWorkspace';

const bridge = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => bridge.current }));
vi.mock('../../runtime/auth', () => { const useMistSession = () => ({ user: { id: 'demo-sales', displayName: '顾言' }, hasPermission: () => true, hasRole: () => false, canAccessView: () => true }); return { useMistSession, useOptionalMistSession: useMistSession }; });
let host: HTMLDivElement, root: Root | undefined, state: MistState; const go = vi.fn();
const ctx: MistContext = { id: (() => { let n = 0; return () => `q5-${++n}`; })(), actorName: '顾言', actorId: 'demo-sales', now: '2026-10-14T02:00:00.000Z' };
const line = (i: number) => ({ id: `ql-${i}`, productId: '', sourceDevId: '', sourceVersionId: '', name: `面料${i}`, style: `F-${i}`, specification: '', qty: String(10 * i), unit: '米', price: '2.50', amount: (25 * i).toFixed(2), cost: '1.00' });
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; go.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
  state = createMistState(ctx, 'demo');
  state.market.quotations.push({ id: 'qt-q5', code: 'QT-Q5-0001', customerId: state.customers[0].id, currency: 'USD', season: 'AW27', validUntil: '2026-12-31', deliveryTerms: 'FOB', paymentTerms: 'TT', status: 'Accepted', lines: [line(1), line(2), line(3)], total: '150.00', deliveryEvidence: '邮件', responseEvidence: '客户只确认前两色', approval: null, convertedOrderId: null, fileIds: [], note: '', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' } as never);
  const run = vi.fn(async (command: any) => { const r = applyMistCommand(state, command, ctx); Object.assign(state, r.state); return { result: r.result }; });
  bridge.current = { state, workspace: { id: 'w', ownerId: 'demo-sales' }, run, error: '', refresh: vi.fn(), loading: false, saving: false, pending: null, upload: vi.fn() };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.useRealTimers(); });
const Page = MARKET_PAGES.quotations;
const render = async () => { await act(async () => root!.render(<Nav.Provider value={{ route: { view: 'quotations', id: 'qt-q5' }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() }}><Page /></Nav.Provider>)); };
async function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await render(); }
const button = (label: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (node: HTMLElement) => { await act(async () => { node.click(); }); };
const check = (text: string) => [...document.body.querySelectorAll('[role="dialog"] label.mist-check')].find(l => l.textContent?.includes(text))!.querySelector('input') as HTMLInputElement;
const type = async (label: string, value: string) => { const node = document.body.querySelector(`[role="dialog"] [aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement; await act(async () => { const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); };
const statuses = () => [...document.body.querySelectorAll('[data-line-conversion]')].map(n => n.getAttribute('data-line-conversion'));

describe('BB-QUO-5 报价详情按条目转单', () => {
  it('勾选 2 个条目转单，只带入选中条目；详情显示各条目状态与订单号', async () => {
    await mount();
    expect(statuses()).toEqual(['pending', 'pending', 'pending']);
    await click(button('核对并转订单')!);
    expect(check('转入：面料1').checked).toBe(true); expect(check('转入：面料3').checked).toBe(true);
    await click(check('转入：面料3'));
    await type('本次订单交期', '2026-12-10');
    await click(button('创建订单草稿')!);
    expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({ type: 'market.quotation.convert', payload: expect.objectContaining({ lineIds: ['ql-1', 'ql-2'] }) }));
    const order = state.orders[0];
    expect(state.orderLines.filter(l => l.orderId === order.id).map(l => l.name)).toEqual(['面料1', '面料2']);
    await render();
    expect(statuses()).toEqual(['converted', 'converted', 'pending']);
    expect(document.body.textContent).toContain(`订单 ${order.code}`);
    expect(document.body.textContent).toContain('部分已转订单 · 1 个条目待处理');
    expect(button('转剩余条目')!.disabled).toBe(false);
  });
  it('剩余条目标记不再转须写原因，全部处理完显示已转单', async () => {
    await mount();
    await click(button('标记条目不再转')!);
    await click(check('不再转：面料3'));
    await click(button('标记不再转')!);
    expect(document.body.textContent).toContain('请填写不再转原因');
    await type('不再转原因', '客户取消第三色');
    await click(button('标记不再转')!);
    expect(bridge.current.run).toHaveBeenCalledWith({ type: 'market.quotation.skipLines', payload: { id: 'qt-q5', lineIds: ['ql-3'], reason: '客户取消第三色' } });
    await render();
    expect(statuses()).toEqual(['pending', 'pending', 'skipped']);
    expect(document.body.textContent).toContain('客户取消第三色');
    await click(button('核对并转订单')!);
    expect([...document.body.querySelectorAll('[role="dialog"] label.mist-check')].map(l => l.textContent)).not.toContain('面料3');
    await type('本次订单交期', '2026-12-10');
    await click(button('创建订单草稿')!);
    await render();
    expect(statuses()).toEqual(['converted', 'converted', 'skipped']);
    expect(document.body.querySelector('[data-quotation-detail] .mist-pill, [data-quotation-detail]')?.textContent).toContain('已转单');
    expect(button('转剩余条目')).toBeUndefined(); expect(button('标记条目不再转')).toBeUndefined();
  });
  it('历史整单转单报价只读显示为全部已转', async () => {
    state.orders.unshift({ ...state.orders[0], id: 'old-order', code: 'SO-F-2025-0009' });
    Object.assign(state.market.quotations.find(q => q.id === 'qt-q5')!, { convertedOrderId: 'old-order' });
    await mount();
    expect(statuses()).toEqual(['converted', 'converted', 'converted']);
    expect(document.body.textContent).toContain('订单 SO-F-2025-0009 · 历史整单转单');
    expect(button('核对并转订单')).toBeUndefined();
  });
});
