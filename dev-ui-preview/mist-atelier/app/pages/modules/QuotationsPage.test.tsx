// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_PAGES } from './MarketPages';
import { quotationDomain, quotationFlags, quotationStage } from './QuotationsPage';
import { Nav } from '../../nav';
import { createMistState, type MistContext, type MistState } from '../../../../../server/src/shared/mistWorkspace';

const bridge = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => bridge.current }));
vi.mock('../../runtime/auth', () => { const useMistSession = () => ({ user: { id: 'demo-sales', displayName: '顾言' }, hasPermission: () => true, hasRole: () => false, canAccessView: () => true }); return { useMistSession, useOptionalMistSession: useMistSession }; });
let host: HTMLDivElement, root: Root | undefined, state: MistState; const go = vi.fn();
const code = (c: string) => state.market.quotations.find(q => q.code === c)!;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; go.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
  let n = 0; const ctx: MistContext = { id: () => `q-test-${++n}`, actorName: '演示', now: '2026-10-14T02:00:00.000Z' };
  state = createMistState(ctx, 'demo');
  bridge.current = { state, run: vi.fn(async () => ({ result: { id: 'saved' } })), error: '', refresh: vi.fn(), loading: false, saving: false, pending: null, upload: vi.fn() };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); });
async function mount(id?: string) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); const Page = MARKET_PAGES.quotations; await act(async () => root!.render(<Nav.Provider value={{ route: { view: 'quotations', id }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() }}><Page /></Nav.Provider>)); }
const button = (label: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
async function click(label: string) { const b = button(label); expect(b, label).toBeTruthy(); await act(async () => b!.click()); }

describe('报价管理', () => {
  it('演示数据按成衣 / 面料分板块，阶段与提醒由真实记录推出', () => {
    const fabric = state.market.quotations.filter(q => quotationDomain(state, q) === 'fabric').map(q => q.code).sort();
    expect(fabric).toEqual(['QT-2026-0001', 'QT-2026-0002', 'QT-2026-0004']);
    expect(quotationStage(code('QT-2026-0002'))).toBe('converted');
    expect(quotationStage(code('QT-2026-0003-V2'))).toBe('pending');
    expect(quotationStage(code('QT-2026-0001'))).toBe('closed');
    const all = state.market.quotations;
    expect(quotationFlags(all, code('QT-2026-0005'), '2026-10-14').map(f => f.label)).toContain('4 天后到期');
    expect(quotationFlags(all, code('QT-2026-0003'), '2026-10-14').map(f => f.label)).toContain('已有新版本 QT-2026-0003-V2');
    expect(quotationFlags(all, code('QT-2026-0003-V2'), '2026-10-14').map(f => f.key)).toContain('belowCost');
  });
  it('列表默认成衣板块，不混排面料报价，并显示临期提醒', async () => {
    await mount();
    expect(host.textContent).toContain('成衣业务 · 3'); expect(host.textContent).toContain('面料业务 · 3');
    expect(host.textContent).toContain('QT-2026-0005'); expect(host.textContent).not.toContain('QT-2026-0002');
    expect(host.textContent).toContain('4 天后到期');
    await click('面料业务 · 3');
    expect(host.textContent).toContain('QT-2026-0002'); expect(host.textContent).not.toContain('QT-2026-0005');
  });
  it('待审批的新版本：显示版本链，非指定审批人不能决定，并说明原因', async () => {
    await mount(code('QT-2026-0003-V2').id);
    const detail = host.querySelector('[data-quotation-detail]')!;
    expect(detail.textContent).toContain('待业务审批');
    expect(host.querySelector('[data-quotation-versions]')!.textContent).toMatch(/V1.*客户未接受.*V2.*待审批/);
    expect(button('批准')!.disabled).toBe(true);
    expect(detail.textContent).toContain('仅本次指定的业务审批人可决定');
    expect(button('登记已发送')).toBeUndefined();
    expect(detail.textContent).toContain('毛利 -2.4%');
  });
  it('已有新版本的旧报价不能再出版本；已转单报价可直接打开订单', async () => {
    await mount(code('QT-2026-0003').id);
    expect(button('新建版本')!.disabled).toBe(true);
    expect(host.textContent).toContain('新建版本：已有新版本 QT-2026-0003-V2');
    await act(async () => root!.unmount()); root = undefined; host.remove();
    const converted = code('QT-2026-0002');
    await mount(converted.id);
    await click('打开订单');
    expect(go).toHaveBeenCalledWith('orders/detail', converted.convertedOrderId, undefined);
  });
  it('基于已发送报价新建版本：沿用客户与条目，保存时带上来源版本，不改写原报价', async () => {
    const near = code('QT-2026-0005');
    await mount(near.id);
    await click('新建版本');
    expect(host.textContent).toContain('新建版本 V2 · QT-2026-0005');
    const customer = host.querySelector('[aria-label="客户"]') as HTMLSelectElement | null;
    if (customer) expect(customer.disabled).toBe(true);
    const valid = host.querySelector('[aria-label="有效期"]') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(valid, '2026-11-30'); valid.dispatchEvent(new Event('input', { bubbles: true })); });
    await click('下一步'); await click('下一步'); await click('保存报价草稿');
    expect(bridge.current.run).toHaveBeenCalledWith({ type: 'market.quotation.save', payload: { id: undefined, input: expect.objectContaining({ previousId: near.id, customerId: near.customerId, validUntil: '2026-11-30', lines: [expect.objectContaining({ productId: near.lines[0].productId, qty: '1200', price: '29.80' })] }) } });
    expect(near.status).toBe('Sent');
  });
  it('已过有效期的已发送报价才能标记失效；未到期时说明原因', async () => {
    await mount(code('QT-2026-0005').id);
    expect(button('标记已失效')!.disabled).toBe(true);
    expect(host.textContent).toContain('有效期至 2026-10-18，到期后才能标记');
    await click('客户接受');
    expect(document.body.textContent).toContain('登记客户接受 QT-2026-0005');
  });
});
