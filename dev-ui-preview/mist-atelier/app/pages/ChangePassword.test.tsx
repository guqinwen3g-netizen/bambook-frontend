// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../../components/mist';
import { ChangePasswordRow } from './ChangePassword';

const change = vi.hoisted(() => vi.fn());
vi.mock('../../../../services/authService', () => ({ changePassword: change }));
let root: Root, host: HTMLDivElement;
beforeEach(async () => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; change.mockReset(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(<ToastProvider><ChangePasswordRow /></ToastProvider>)); });
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
