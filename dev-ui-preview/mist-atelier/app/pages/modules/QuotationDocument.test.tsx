// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_PAGES } from './MarketPages';
import { Nav } from '../../nav';
import { createMistState, type MistContext, type MistState } from '../../../../../server/src/shared/mistWorkspace';

const bridge = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => bridge.current }));
vi.mock('../../runtime/auth', () => ({ useMistSession: () => ({ user: { id: 'demo-sales', displayName: '顾言' }, hasPermission: () => true, hasRole: () => false, canAccessView: () => true }) }));
let host: HTMLDivElement, root: Root | undefined, state: MistState; const go = vi.fn();
const ctx: MistContext = { id: (() => { let n = 0; return () => `q6-${++n}`; })(), actorName: '顾言', actorId: 'demo-sales', now: '2026-10-14T02:00:00.000Z' };
const company = { legalName: '杭州竹语纺织有限公司', englishName: 'Hangzhou Bamboo Textile', address: '杭州', englishAddress: 'Hangzhou', phone: '', email: '', taxId: '', customsCode: '', bankName: '', bankAccount: '', swift: '', defaultCurrency: 'USD' };
const quote = (over: Record<string, unknown> = {}) => ({ id: 'qt-q6', code: 'QT-Q6-0001-V2', revision: 2, rootId: 'qt-q6-v1', previousId: 'qt-q6-v1', customerId: state.customers[0].id, currency: 'USD', season: 'AW27', validUntil: '2026-12-31', deliveryTerms: 'FOB', paymentTerms: 'TT', status: 'Draft', lines: [{ id: 'ql-1', productId: '', sourceDevId: '', sourceVersionId: '', name: '面料1', style: 'F-1', specification: '', qty: '100', unit: '米', price: '2.50', amount: '250.00', cost: '1.00' }], total: '250.00', deliveryEvidence: '', responseEvidence: '', approval: null, convertedOrderId: null, fileIds: [], note: '', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over });
const record = (draft: boolean, n: number) => ({ id: 'doc-' + n, quotationId: 'qt-q6', revision: 2, draft, fileId: 'file-' + n, fileName: `QT-Q6-0001-V2-0${n}${draft ? '-DRAFT' : ''}.pdf`, sha256: 'x', bytes: 10, templateVersion: 1, snapshotFingerprint: 'f', snapshot: {} as never, generatedAt: `2026-10-1${n}T02:00:00.000Z`, generatedBy: '顾言', generatedById: 'demo-sales' });
const setup = (over: Record<string, unknown> = {}, profile = true) => {
  state = createMistState(ctx, 'demo'); if (profile) state.settings.companyProfile = { ...company }; else delete state.settings.companyProfile;
  state.market.quotations.push(quote(over) as never);
  const run = vi.fn(async () => ({ result: {} }));
  bridge.current = { state, run, error: '', refresh: vi.fn(), loading: false, saving: false, pending: null, upload: vi.fn(), downloadFile: vi.fn(async () => undefined), fileUrl: (f: { id: string }) => '/files/' + f.id };
};
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; go.mockReset(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-14T04:00:00Z')); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.useRealTimers(); });
const Page = MARKET_PAGES.quotations;
async function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<Nav.Provider value={{ route: { view: 'quotations', id: 'qt-q6' }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() }}><Page /></Nav.Provider>)); }
const button = (label: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (node: HTMLElement) => { await act(async () => { node.click(); }); };
const reasons = () => document.body.querySelector('[data-action-reasons]')?.textContent || '';

describe('BB-QUO-6 生成报价单', () => {
  it('无需审批的 V2 可生成正式版；命令只带报价号与版本类型', async () => {
    setup(); await mount();
    expect(button('生成正式报价单')!.disabled).toBe(false);
    await click(button('生成正式报价单')!);
    expect(bridge.current.run).toHaveBeenCalledWith({ type: 'market.quotation.document', payload: { id: 'qt-q6', draft: false } });
    await click(button('生成草稿水印版')!);
    expect(bridge.current.run).toHaveBeenLastCalledWith({ type: 'market.quotation.document', payload: { id: 'qt-q6', draft: true } });
    expect(document.body.textContent).toContain('尚未生成报价单');
  });
  it('须审批未批准：正式版禁用并写原因，只能生成草稿水印版', async () => {
    setup({ requiresApproval: true }); await mount();
    expect(button('生成正式报价单')!.disabled).toBe(true);
    expect(reasons()).toContain('生成正式报价单：此报价须业务审批，未批准只能生成草稿水印版');
    expect(button('生成草稿水印版')!.disabled).toBe(false);
  });
  it('未维护公司资料时两种都禁用并写明需管理员补全', async () => {
    setup({}, false); await mount();
    expect(button('生成正式报价单')!.disabled).toBe(true); expect(button('生成草稿水印版')!.disabled).toBe(true);
    expect(reasons()).toContain('工作区尚未维护公司资料（公司抬头），需管理员补全后才能生成报价单');
  });
  it('列出每次生成的文件记录（新在前），可下载与打印', async () => {
    setup({ documents: [record(true, 1), record(false, 2)] });
    state.files.push({ id: 'file-1', name: 'QT-Q6-0001-V2-01-DRAFT.pdf', mimeType: 'application/pdf', size: 10, storageKey: 'ws/file-1', createdAt: '' } as never, { id: 'file-2', name: 'QT-Q6-0001-V2-02.pdf', mimeType: 'application/pdf', size: 10, storageKey: 'ws/file-2', createdAt: '' } as never);
    await mount();
    const rows = [...document.body.querySelectorAll('[data-quote-document]')];
    expect(rows.map(r => r.getAttribute('data-quote-document'))).toEqual(['formal', 'draft']);
    expect(rows[0].textContent).toContain('QT-Q6-0001-V2-02.pdf'); expect(rows[0].textContent).toContain('V2'); expect(rows[0].textContent).toContain('顾言');
    expect(rows[1].textContent).toContain('草稿水印版');
    await click([...rows[0].querySelectorAll('button')].find(b => b.textContent?.includes('下载'))!);
    expect(bridge.current.downloadFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-2' }));
    const win = { location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(win as never);
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }));
    vi.stubGlobal('fetch', fetchMock); (URL as any).createObjectURL = vi.fn(() => 'blob:pdf'); (URL as any).revokeObjectURL = vi.fn();
    await click([...rows[1].querySelectorAll('button')].find(b => b.textContent?.includes('打印'))!);
    expect(fetchMock).toHaveBeenCalledWith('/files/file-1', expect.objectContaining({ credentials: 'include' }));
    expect(win.location.href).toBe('blob:pdf');
    open.mockRestore(); vi.unstubAllGlobals();
  });
  it('缺公司抬头时所有者可直达系统设置的公司资料并带回本报价；成员只看到由所有者维护的说明', async () => {
    setup({}, false); await mount();
    expect(document.body.querySelector('[data-quote-company-missing]')?.textContent).toContain('缺少公司抬头');
    expect(button('生成正式报价单')!.disabled).toBe(true); expect(button('生成草稿水印版')!.disabled).toBe(true);
    await click(button('去维护公司资料')!); expect(go).toHaveBeenCalledWith('settings', 'qt-q6', { section: 'company' });
    await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = '';
    setup({}, false); bridge.current.workspace = { id: 'w', name: '空间', access: { role: 'member' } }; await mount();
    expect(button('去维护公司资料')).toBeUndefined(); expect(document.body.textContent).toContain('公司资料由空间所有者维护');
    await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = '';
    setup(); await mount(); expect(document.body.querySelector('[data-quote-company-missing]')).toBeNull(); expect(button('生成正式报价单')!.disabled).toBe(false);
  });
});
