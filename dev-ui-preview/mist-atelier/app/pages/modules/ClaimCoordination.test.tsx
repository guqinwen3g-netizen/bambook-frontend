// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMistState, type MistContext, type MistState } from '../../../../../server/src/shared/mistWorkspace';
import type { PlatformClaim } from '../../../../../server/src/shared/mistPlatform';
import { ClaimCoordinationPanel, claimDefaultSupplierId } from './ClaimCoordination';

let host: HTMLDivElement, root: Root | undefined, state: MistState;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; let n = 0; const ctx: MistContext = { id: () => `cc-${++n}`, actorName: '演示', now: '2026-10-14T02:00:00.000Z' }; state = createMistState(ctx, 'demo'); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); });
function claimFor(extra: Partial<PlatformClaim> = {}): PlatformClaim {
  const invoice = state.invoices[0];
  return { id: 'c1', code: 'CLM-1', orderId: invoice.orderId, invoiceId: invoice.id, problem: '色差', fileIds: [], state: 'Processing', createdAt: '2026-10-14', dispositions: [], ...extra };
}
async function mount(claim: PlatformClaim, can = { write: true, qc: false, finance: false, approve: false }, actorId = 'me') {
  const command = vi.fn(async () => ({})), openEditor = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<ClaimCoordinationPanel claim={claim} state={state} actorId={actorId} busy={false} can={can} command={command} openEditor={openEditor} />));
  return { command, openEditor };
}
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const supplier = () => state.market.suppliers[0];

describe('售后索赔协同面板', () => {
  it('新案件：显示五步进度，业务员可通知相关人员，提交记录通知命令（只记录工厂通知，不对外发送）', async () => {
    const { command, openEditor } = await mount(claimFor());
    expect(host.textContent).toContain('通知相关人员：质检、负责人、跟单、工厂');
    expect(host.textContent).toContain('尚未通知');
    expect(host.textContent).toContain('公司自担');
    expect(button('记录质检核实')).toBeUndefined();
    await act(async () => button('通知相关人员')!.click());
    const spec = openEditor.mock.calls[0][0];
    expect(spec.description).toContain('不等于认定工厂责任');
    await spec.submit({ supplierId: supplier().id, factoryChannel: '微信群', note: '底线 3000' });
    expect(command).toHaveBeenCalledWith({ type: 'platform.claim.notify', payload: { id: 'c1', supplierId: supplier().id, factoryChannel: '微信群', note: '底线 3000' } });
  });
  it('质检核实前已有处置时提醒；安全隐患单独提示；质检可记录核实', async () => {
    const d = { id: 'd1', kind: 'Allowance' as const, amount: 10, quantity: 0, unit: '', returnDisposition: '' as const, basis: 'x', fileIds: [], state: 'Draft' as const };
    await mount(claimFor({ dispositions: [d] }), { write: false, qc: true, finance: false, approve: false });
    expect(host.textContent).toContain('质检尚未核实');
    expect(button('记录质检核实')).toBeTruthy(); expect(button('通知相关人员')).toBeUndefined();
    await act(async () => root!.unmount()); root = undefined; host.remove();
    await mount(claimFor({ coordination: { notices: [], recoveries: [], verifications: [{ id: 'v', at: '2026-10-14T03:00:00Z', by: '许言', byId: 'qc', result: 'confirmed', scope: 'A款', affectedQuantity: 5, unit: '件', goodsLocation: 'sold', mitigation: '', factoryResponse: '工厂承认', safety: true, fileIds: [] }] } }));
    expect(host.textContent).toContain('涉及安全隐患'); expect(host.textContent).toContain('已上架 / 已销售'); expect(host.textContent).toContain('工厂承认');
  });
  it('客户已处理、工厂未落实时提示等待；两笔账分开显示；放弃追偿不能由提出人自己批准', async () => {
    const cur = state.invoices[0].currency;
    const d = { id: 'd1', kind: 'Allowance' as const, amount: 100, quantity: 0, unit: '', returnDisposition: '' as const, basis: 'x', fileIds: [], state: 'Executed' as const };
    const recovery = { id: 'r1', supplierId: supplier().id, supplierName: supplier().name, currency: cur, requested: 100, basis: '工厂责任', state: 'Agreed' as const, agreed: 60, method: 'deduction' as const, agreedNote: '邮件确认', createdAt: '', createdBy: '顾言', createdById: 'me', events: [] };
    await mount(claimFor({ dispositions: [d], coordination: { notices: [], verifications: [], recoveries: [recovery] } }), { write: true, qc: false, finance: true, approve: true }, 'me');
    expect(host.textContent).toContain('客户这边已解决，但还在等工厂补偿');
    expect(host.textContent).toContain('已执行并结清');
    expect(host.textContent).toContain('40.00 ' + cur);
    expect(button('登记实际落实')).toBeUndefined(); expect(button('批准放弃')).toBeUndefined();
    expect(host.textContent).toContain('由财务在应付里按工厂票据扣款');
  });
  it('默认工厂仅在生产分支工厂名与供应商档案唯一匹配时预选', () => {
    const claim = claimFor(); const rows = state.productions.filter(p => p.orderId === claim.orderId); expect(rows.length).toBeGreaterThan(0);
    rows.forEach(p => { p.factory = supplier().name; }); expect(claimDefaultSupplierId(state, claim)).toBe(supplier().id);
    rows[0].factory = '另一家没有档案的工厂'; if (rows.length > 1) expect(claimDefaultSupplierId(state, claim)).toBe(supplier().id);
    rows.forEach(p => { p.factory = '未登记工厂'; }); expect(claimDefaultSupplierId(state, claim)).toBe('');
  });
});
