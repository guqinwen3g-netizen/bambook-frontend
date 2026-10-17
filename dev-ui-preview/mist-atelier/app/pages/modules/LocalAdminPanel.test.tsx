// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getByRole, queryByRole } from '@testing-library/dom';
import { MistRoot, ToastProvider } from '../../../../../components/mist';
import { applyMistCommand,createMistState } from '../../../../../server/src/shared/mistWorkspace';
import { LocalAdminPanel, type LocalCompanyProfile } from './LocalAdminPanel';

const bridge = vi.hoisted(() => ({ localMode: true, sessionKey: 'local-a', workspace: null as any, run: vi.fn(), recover: vi.fn() }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => bridge.workspace }));
vi.mock('../../runtime/auth', () => { const useMistSession = () => ({ localMode: bridge.localMode, sessionKey: bridge.sessionKey, user: { id: 'local-user', displayName: '本地经办人' } }); return { useMistSession, useOptionalMistSession: useMistSession }; });

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root;
const profile: LocalCompanyProfile = { legalName: '实际公司', englishName: 'ACTUAL COMPANY', address: '实际中文地址', englishAddress: '', phone: '', email: 'actual@example.com', taxId: '', customsCode: '', bankName: '实际银行', bankAccount: '', swift: '', defaultCurrency: 'USD' };
function render() { act(() => root.render(<MistRoot><ToastProvider><LocalAdminPanel /></ToastProvider></MistRoot>)); }
function input(label: string, value: string) {
  const element = getByRole(host, 'textbox', { name: label }) as HTMLInputElement;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function click(label: string) { await act(async () => getByRole(host, 'button', { name: label }).click()); }
beforeEach(() => {
  bridge.localMode = true; bridge.sessionKey = 'local-a'; bridge.run.mockReset().mockResolvedValue({ result: {} }); bridge.recover.mockReset().mockResolvedValue({ result: {} });
  const state = createMistState({ id: () => crypto.randomUUID(), actorName: '本地经办人', now: '2026-10-13T12:00:00Z' }, 'empty');
  Object.assign(state.settings, { companyProfile: { ...profile }, workspaceName: '本地业务空间', profileName: '本地经办人' });
  bridge.workspace = { state, workspace: { id: 'workspace-a', name: '本地业务空间' }, loading: false, saving: false, pending: null, pendingCreate: null, error: '', run: bridge.run, refresh: vi.fn(), recover: bridge.recover };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it('reads the active local company and preserves the original T10 layout', () => {
  render();
  expect(host.querySelector('.mist-wizard')).not.toBeNull();
  expect((getByRole(host, 'textbox', { name: '公司中文抬头' }) as HTMLInputElement).value).toBe('实际公司');
  expect(host.textContent).toContain('本地开发模式');
  expect(host.textContent).not.toContain('服务器版本');
});

it('persists normalized company and space data through settings.update', async () => {
  render(); input('公司中文抬头', '  新实际公司  '); input('公司联系邮箱', 'contact@example.com');
  await click('出口与收款'); input('常用结算币种', 'eur'); input('收款账号', 'ACTUAL-ACCOUNT');
  await click('保存资料');
  expect(bridge.run).toHaveBeenCalledWith({ type: 'settings.update', payload: expect.objectContaining({ workspaceName: '本地业务空间', profileName: '本地经办人', companyProfile: expect.objectContaining({ legalName: '新实际公司', email: 'contact@example.com', defaultCurrency: 'EUR', bankAccount: 'ACTUAL-ACCOUNT' }) }) });
  expect(host.textContent).toContain('本地公司与空间资料已保存');
});
it('reads back the actual domain-persisted company parameters and workspace name',async()=>{let sequence=0;const context={id:()=>`admin-${++sequence}`,now:'2026-10-13T12:00:00Z',actorName:'本地经办人'};bridge.run.mockImplementation(async(command)=>{const result=applyMistCommand(bridge.workspace.state,command,context);bridge.workspace.state=result.state;return{result:result.result};});render();input('公司中文抬头','真实保存公司');await click('出口与收款');input('常用结算币种','eur');input('收款账号','ACCOUNT-01');await click('当前空间');input('工作空间名称','真实保存空间');await click('保存资料');expect(bridge.workspace.state.settings).toMatchObject({workspaceName:'真实保存空间',companyProfile:{legalName:'真实保存公司',defaultCurrency:'EUR',bankAccount:'ACCOUNT-01'}});render();await click('公司抬头');expect((getByRole(host,'textbox',{name:'公司中文抬头'}) as HTMLInputElement).value).toBe('真实保存公司');});
it('rejects addresses above the actual backend field limit before sending',async()=>{render();input('中文地址','地'.repeat(501));await click('保存资料');expect(bridge.run).not.toHaveBeenCalled();expect(host.textContent).toContain('不能超过500字');});
it('preserves a dirty field while refreshing untouched company parameters',async()=>{render();input('公司中文抬头','仍在编辑的名称');bridge.workspace.state={...bridge.workspace.state,settings:{...bridge.workspace.state.settings,companyProfile:{...profile,legalName:'外部快照名称',bankName:'已更新的银行'}}};render();expect((getByRole(host,'textbox',{name:'公司中文抬头'}) as HTMLInputElement).value).toBe('仍在编辑的名称');await click('出口与收款');expect((getByRole(host,'textbox',{name:'收款银行名称'}) as HTMLInputElement).value).toBe('已更新的银行');});

it('keeps entered company information when local persistence fails', async () => {
  bridge.run.mockRejectedValue(new Error('本地磁盘写入失败'));
  render(); input('公司中文抬头', '尚未保存的公司'); await click('保存资料');
  expect(host.textContent).toContain('本地磁盘写入失败');
  expect((getByRole(host, 'textbox', { name: '公司中文抬头' }) as HTMLInputElement).value).toBe('尚未保存的公司');
  expect(host.textContent).not.toContain('本地公司与空间资料已保存');
});

it('validates contact details before any command is sent', async () => {
  render(); input('公司联系邮箱', 'not-an-email'); await click('保存资料');
  expect(host.textContent).toContain('公司联系邮箱格式不正确'); expect(bridge.run).not.toHaveBeenCalled();
});

it('does not expose local writes in a normal server session', () => {
  bridge.localMode = false; render();
  expect(host.textContent).toContain('此资料页仅用于本地工作空间');
  expect(queryByRole(host, 'button', { name: '保存资料' })).toBeNull(); expect(bridge.run).not.toHaveBeenCalled();
});

it('uses original-request recovery while preserving input', async () => {
  bridge.workspace.pending = { requestId: 'same-request' }; render();
  expect((getByRole(host, 'button', { name: '保存资料' }) as HTMLButtonElement).disabled).toBe(true);
  await click('核对原请求'); expect(bridge.recover).toHaveBeenCalledTimes(1); expect(bridge.run).not.toHaveBeenCalled();
});

it('does not publish a stale save after changing the active local space', async () => {
  let finish!: (value: unknown) => void;
  bridge.run.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(); input('公司中文抬头', '旧空间未完成保存'); await click('保存资料');
  bridge.workspace = { ...bridge.workspace, workspace: { id: 'workspace-b', name: '另一空间' }, state: { ...bridge.workspace.state, settings: { ...bridge.workspace.state.settings, workspaceName: '另一空间', companyProfile: { ...profile, legalName: '另一公司' } } } };
  render(); await act(async () => finish({ result: {} }));
  expect((getByRole(host, 'textbox', { name: '公司中文抬头' }) as HTMLInputElement).value).toBe('另一公司');
  expect(host.textContent).not.toContain('本地公司与空间资料已保存');
});
it('does not display an old recovery failure in another workspace',async()=>{let reject!:(error:Error)=>void;bridge.workspace.pending={requestId:'old'};bridge.recover.mockImplementation(()=>new Promise((_,no)=>{reject=no;}));render();await click('核对原请求');bridge.workspace={...bridge.workspace,pending:null,workspace:{id:'workspace-b',name:'另一空间'}};render();await act(async()=>reject(new Error('旧空间恢复错误')));expect(host.textContent).not.toContain('旧空间恢复错误');});
