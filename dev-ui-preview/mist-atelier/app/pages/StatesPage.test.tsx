// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MistRoot, ToastProvider } from '../../../../components/mist';
import { Nav } from '../nav';
import { StatesPage } from './StatesPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLElement;
const go = vi.fn();
function render() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(<MistRoot><ToastProvider><Nav.Provider value={{ route: { view: 'states' }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() }}><StatesPage /></Nav.Provider></ToastProvider></MistRoot>)); }
function button(text: string) { const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text); expect(result).toBeDefined(); return result!; }
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = undefined; vi.useRealTimers(); });
describe('Mist controlled state examples', () => {
  it('opens the actual creation route and clears the actual example filter', () => {
    render(); act(() => button('新建开发案').click()); expect(go).toHaveBeenCalledWith('development/new');
    expect(host.textContent).toContain('没有符合条件的结果'); act(() => button('清除筛选').click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="筛选示例订单"]')?.value).toBe('');
    expect(host.textContent).not.toContain('没有符合条件的结果'); expect(host.textContent).toContain('SO-G-2026-018');
  });
  it('retries from loading to rendered results without pretending to make a network request', async () => {
    vi.useFakeTimers(); render(); act(() => button('重试').click()); expect(host.textContent).toContain('正在重试示例');
    await act(async () => vi.advanceTimersByTime(500)); expect(host.textContent).toContain('加载完成 · 表格'); expect(host.textContent).toContain('示例数据已载入'); expect(host.textContent).toContain('SO-G-2026-017');
  });
  it('explains permission and offline limitations without claiming an external action', () => {
    render(); act(() => button('申请权限').click()); const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('未向管理员发送任何申请'); act(() => button('知道了').click()); expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain('不承诺自动同步'); expect(host.textContent).not.toContain('已发送申请'); expect(host.textContent).not.toContain('修改会保存在本机');
  });
});
