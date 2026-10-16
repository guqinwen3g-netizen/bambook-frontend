// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MistRoot, ToastProvider } from '../../../../components/mist';
import { Nav } from '../nav';
const seam = vi.hoisted(() => ({ session: { signingIn: false, status: 'anonymous', error: '', login: vi.fn(), clearError: vi.fn() } }));
vi.mock('../runtime/auth', () => ({ useMistSession: () => seam.session }));
import { LoginPage } from './LoginPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLElement | undefined;
const go = vi.fn();
function render() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(<MistRoot><ToastProvider><Nav.Provider value={{ route: { view: 'login' }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() }}><LoginPage /></Nav.Provider></ToastProvider></MistRoot>)); return host; }
function input(type: string, value: string) { const element = host!.querySelector<HTMLInputElement>(`input[type="${type}"]`)!; act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function submit() { await act(async () => { host!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
beforeEach(() => { vi.clearAllMocks(); seam.session.signingIn = false; seam.session.status = 'anonymous'; seam.session.error = ''; });
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = undefined; host = undefined; vi.useRealTimers(); });
describe('original Mist login with real-session binding', () => {
  it('retains the reference brand/form composition and never pretends password reset succeeded', () => {
    const host = render();
    expect([...host.querySelector('.mist-auth')!.children].map(element => element.className)).toEqual(['mist-auth-brand', 'mist-auth-panel']);
    expect(host.querySelector('.mist-auth-brand h1')?.getAttribute('style')).toContain('font-size: 44px');
    expect(host.querySelector('.mist-auth-brand')?.textContent).toContain('从开发到收款，');
    expect(host.querySelectorAll('.mist-auth-form .mist-field')).toHaveLength(2);
    expect(host.querySelector<HTMLInputElement>('input[type="email"]')?.value).toBe('');
    const reset = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '忘记密码？')!;
    expect(reset.disabled).toBe(true); expect(reset.title).toContain('暂未接入');
    act(() => reset.click()); expect(host.textContent).not.toContain('已发送重置邮件');
    expect(host.textContent).not.toContain('任意密码'); expect(go).not.toHaveBeenCalled();
  });
  it('navigates only after real login resolves and forwards the keep-login choice', async () => {
    let resolve!: (value: unknown) => void;
    seam.session.login.mockReturnValue(new Promise(r => { resolve = r; }));
    const host = render(); input('email', 'real@example.com'); input('password', 'password');
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!; act(() => checkbox.click());
    await submit(); await submit();
    expect(seam.session.login).toHaveBeenCalledTimes(1); expect(seam.session.login).toHaveBeenCalledWith('real@example.com', 'password', { remember: false }); expect(go).not.toHaveBeenCalled();
    await act(async () => resolve({ id: 'real', displayName: '真实用户', email: 'real@example.com' }));
    expect(go).toHaveBeenCalledWith('cockpit'); expect(host.textContent).toContain('欢迎回来，真实用户');
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
  });
  it('maps network errors, clears the password and stays on the login page', async () => {
    seam.session.login.mockRejectedValue(new TypeError('Failed to fetch'));
    const host = render(); input('email', 'real@example.com'); input('password', 'secret'); await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('服务器不可达或超时，请检查网络'); expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(''); expect(go).not.toHaveBeenCalled();
  });
  it('honours server cooldown and removes its timer on unmount', async () => {
    vi.useFakeTimers(); seam.session.login.mockRejectedValue(Object.assign(new Error('登录过频'), { retryAfterMs: 2000 }));
    const host = render(); input('email', 'real@example.com'); input('password', 'secret'); await submit();
    expect(host.textContent).toContain('请稍候 2s'); input('password', 'another'); await submit(); expect(seam.session.login).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(2000)); await submit(); expect(seam.session.login).toHaveBeenCalledTimes(2);
    act(() => root!.unmount()); root = undefined; expect(vi.getTimerCount()).toBe(0);
  });
  it('two-step login: password success with MFA_REQUIRED shows code step, then submits token + code', async () => {
    seam.session.login.mockRejectedValueOnce(Object.assign(new Error('请输入两步验证码'), { code: 'MFA_REQUIRED', mfaToken: 'step-token' }));
    const host = render(); input('email', 'boss@example.com'); input('password', 'secret'); await submit();
    expect(host.textContent).toContain('两步验证'); expect(host.querySelector('[role="alert"]')).toBeNull(); expect(go).not.toHaveBeenCalled();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    await submit(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('6 位动态码'); expect(seam.session.login).toHaveBeenCalledTimes(1);
    seam.session.login.mockResolvedValueOnce({ id: 'boss', displayName: '老板', email: 'boss@example.com' });
    const code = host.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(code, '123456'); code.dispatchEvent(new Event('input', { bubbles: true })); });
    await submit();
    expect(seam.session.login).toHaveBeenLastCalledWith('boss@example.com', '', { remember: true, mfa: { mfaToken: 'step-token', code: '123456' } });
    expect(go).toHaveBeenCalledWith('cockpit');
  });
  it('expired second step returns to the password form with a message', async () => {
    seam.session.login.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'MFA_REQUIRED', mfaToken: 't' }));
    const host = render(); input('email', 'boss@example.com'); input('password', 'secret'); await submit();
    seam.session.login.mockRejectedValueOnce(Object.assign(new Error('验证已过期，请重新输入密码登录。'), { code: 'MFA_EXPIRED' }));
    const code = host.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(code, '123456'); code.dispatchEvent(new Event('input', { bubbles: true })); });
    await submit();
    expect(host.querySelector('input[type="password"]')).not.toBeNull(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('验证已过期');
  });
});
