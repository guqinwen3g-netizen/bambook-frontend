// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../../components/mist';
import { ChangePasswordRow, ForcedPasswordChangePage, LogoutAllRow } from './ChangePassword';

const change = vi.hoisted(() => vi.fn());
const logoutAll = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ user: { email: 'a@x.test', mustChangePassword: false } as any, refresh: vi.fn(), logout: vi.fn() }));
vi.mock('../../../../services/authService', () => ({ changePassword: change, logoutAllSessions: logoutAll }));
vi.mock('../runtime/auth', () => { const useMistSession = () => session; return { useMistSession, useOptionalMistSession: useMistSession }; });
let root: Root, host: HTMLDivElement;
beforeEach(async () => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; change.mockReset(); session.refresh.mockReset(); session.logout.mockReset(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(<ToastProvider><ChangePasswordRow /></ToastProvider>)); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const button = (t: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === t)!;
async function fill(values: string[]) {
  const inputs = [...document.querySelectorAll('input[type=password]')] as HTMLInputElement[];
  for (const [i, v] of values.entries()) await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputs[i], v); inputs[i].dispatchEvent(new Event('input', { bubbles: true })); });
}
it('validates locally, then sends current and new password once', async () => {
  await act(async () => button('修改密码').click());
  await fill(['old-pass-1', 'new-pass-22', 'new-pass-2X']);
  await act(async () => button('确认修改').click());
  expect(document.body.textContent).toContain('两次输入的新密码不一致'); expect(change).not.toHaveBeenCalled();
  await fill(['old-pass-1', 'short', 'short']);
  await act(async () => button('确认修改').click());
  expect(document.body.textContent).toContain('新密码至少 8 位');
  change.mockResolvedValueOnce(undefined);
  await fill(['old-pass-1', 'new-pass-22', 'new-pass-22']);
  await act(async () => button('确认修改').click());
  expect(change).toHaveBeenCalledWith('old-pass-1', 'new-pass-22');
  expect(document.querySelector('input[type=password]')).toBeNull();
});
it('explains a wrong current password in Chinese', async () => {
  change.mockRejectedValueOnce(new Error('Current password is incorrect.'));
  await act(async () => button('修改密码').click());
  await fill(['bad', 'new-pass-22', 'new-pass-22']);
  await act(async () => button('确认修改').click());
  expect(document.body.textContent).toContain('当前密码不正确');
});
it('forces a password change after an admin reset and reloads the session once changed', async () => {
  await act(async () => root.render(<ToastProvider><ForcedPasswordChangePage /></ToastProvider>));
  expect(document.body.textContent).toContain('请先修改登录密码');
  await fill(['temp-pass-1', 'temp-pass-1', 'temp-pass-1']);
  await act(async () => button('修改并继续').click());
  expect(document.body.textContent).toContain('新密码不能与临时密码相同'); expect(change).not.toHaveBeenCalled();
  change.mockResolvedValueOnce(undefined);
  await fill(['temp-pass-1', 'my-new-pass', 'my-new-pass']);
  await act(async () => button('修改并继续').click());
  expect(change).toHaveBeenCalledWith('temp-pass-1', 'my-new-pass');
  expect(session.refresh).toHaveBeenCalledTimes(1);
  await act(async () => button('退出登录').click());
  expect(session.logout).toHaveBeenCalled();
});
it('logs out every device only after confirmation, then ends the local session', async () => {
  logoutAll.mockReset();
  await act(async () => root.render(<ToastProvider><LogoutAllRow /></ToastProvider>));
  await act(async () => button('退出所有设备').click());
  expect(logoutAll).not.toHaveBeenCalled();
  logoutAll.mockRejectedValueOnce(new Error('HTTP 500'));
  await act(async () => button('确认退出').click());
  expect(document.body.textContent).toContain('未能退出所有设备'); expect(session.logout).not.toHaveBeenCalled();
  logoutAll.mockResolvedValueOnce(undefined);
  await act(async () => button('确认退出').click());
  expect(logoutAll).toHaveBeenCalledTimes(2); expect(session.logout).toHaveBeenCalledTimes(1);
});
