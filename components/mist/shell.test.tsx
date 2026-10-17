// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { LayoutGrid } from 'lucide-react';
import { MistAppShell, MistSidebarPresentation, MistTopbar } from './shell';

it('opens the mobile navigation from the topbar, closes it after navigating, and offers a back button on sub pages', () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), navigate = vi.fn(), back = vi.fn();
  try {
    act(() => root.render(<MistAppShell
      sidebar={<MistSidebarPresentation sections={[{ id: 'g', label: '我的事务', items: [{ id: 'cockpit', label: '我的工作', icon: LayoutGrid, count: 2 }] }]} activeId="cockpit" onNavigate={navigate} collapsed={false} onToggleCollapsed={() => {}} account={{ name: '顾言' }} />}
      topbar={() => <MistTopbar crumbs={[{ label: '订单履约' }, { label: '开发与寻样' }, { label: 'DEV-1' }]} onBack={back} backLabel="返回开发与寻样" />}>
      <p>内容</p>
    </MistAppShell>));
    const side = host.querySelector('.mist-side') as HTMLElement;
    expect(side.dataset.menuOpen).toBeUndefined();
    act(() => (host.querySelector('[aria-label="打开菜单"]') as HTMLButtonElement).click());
    expect(side.dataset.menuOpen).toBe('true');
    expect(host.querySelector('[aria-label="打开菜单"]')!.getAttribute('aria-expanded')).toBe('true');
    act(() => (host.querySelector('.mist-nav-item') as HTMLButtonElement).click());
    expect(navigate).toHaveBeenCalledWith('cockpit');
    expect(side.dataset.menuOpen).toBeUndefined();
    act(() => (host.querySelector('[aria-label="打开菜单"]') as HTMLButtonElement).click());
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(side.dataset.menuOpen).toBeUndefined();
    act(() => (host.querySelector('[aria-label="返回开发与寻样"]') as HTMLButtonElement).click());
    expect(back).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.mist-topbar')!.getAttribute('data-has-back')).toBe('true');
  } finally { act(() => root.unmount()); host.remove(); }
});
