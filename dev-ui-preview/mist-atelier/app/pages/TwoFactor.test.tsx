// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../../components/mist';

const api = vi.hoisted(() => ({ getMfaStatus: vi.fn(), startMfaSetup: vi.fn(), enableMfa: vi.fn(), disableMfa: vi.fn() }));
vi.mock('../../../../services/authService', () => api);
vi.mock('qrcode', () => ({ default: { toString: vi.fn(async () => '<svg/>') } }));
import { TwoFactorRow } from './TwoFactor';

let root: Root, host: HTMLDivElement;
const button = (t: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === t)!;
const set = async (el: HTMLInputElement, v: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); });
async function mount() { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(<ToastProvider><TwoFactorRow /></ToastProvider>)); }
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; Object.values(api).forEach(f => f.mockReset()); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ''; });

it('开启流程：密码 → 扫码并输入动态码 → 恢复码只显示一次，关闭后刷新状态', async () => {
  api.getMfaStatus.mockResolvedValueOnce({ enabled: false, enabledAt: null, recoveryRemaining: 0 });
  await mount();
  await act(async () => button('开启两步验证').click());
  await act(async () => button('下一步').click());
  expect(document.body.textContent).toContain('请填写登录密码'); expect(api.startMfaSetup).not.toHaveBeenCalled();
  api.startMfaSetup.mockResolvedValueOnce({ secret: 'ABCDEFGHIJKLMNOP', otpauthUri: 'otpauth://totp/x' });
  await set(document.querySelector('input[type=password]') as HTMLInputElement, 'Pass-word-1');
  await act(async () => button('下一步').click());
  expect(api.startMfaSetup).toHaveBeenCalledWith('Pass-word-1');
  expect(document.querySelector('img[alt="两步验证二维码"]')).not.toBeNull();
  expect(document.body.textContent).toContain('ABCD EFGH IJKL MNOP');
  const code = document.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement;
  await set(code, '12a3'); await act(async () => button('确认开启').click());
  expect(api.enableMfa).not.toHaveBeenCalled();
  api.enableMfa.mockResolvedValueOnce(['aaaaa-11111', 'bbbbb-22222']);
  await set(code, '123456'); await act(async () => button('确认开启').click());
  expect(api.enableMfa).toHaveBeenCalledWith('123456');
  expect(document.querySelector('[aria-label="恢复码"]')?.textContent).toContain('aaaaa-11111');
  api.getMfaStatus.mockResolvedValueOnce({ enabled: true, enabledAt: '2026-10-16T05:00:00Z', recoveryRemaining: 2 });
  await act(async () => button('我已保存好恢复码').click());
  expect(document.querySelector('[aria-label="恢复码"]')).toBeNull();
  expect(host.textContent).toContain('剩余恢复码 2 个');
});

it('关闭须密码和动态码；服务端拒绝时显示原因', async () => {
  api.getMfaStatus.mockResolvedValue({ enabled: true, enabledAt: null, recoveryRemaining: 10 });
  await mount();
  await act(async () => button('关闭').click());
  await set(document.querySelector('input[type=password]') as HTMLInputElement, 'Pass-word-1');
  await act(async () => button('确认关闭').click());
  expect(api.disableMfa).not.toHaveBeenCalled();
  api.disableMfa.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'MFA_INVALID' }));
  await set(document.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement, '000000');
  await act(async () => button('确认关闭').click());
  expect(api.disableMfa).toHaveBeenCalledWith('Pass-word-1', '000000');
  expect(document.body.textContent).toContain('动态码不正确');
});
