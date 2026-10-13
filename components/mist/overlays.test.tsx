// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CommandPalette, Dialog, Drawer, Dropdown, MistRoot } from './index';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
function render(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container);
  const root: Root = createRoot(container);
  act(() => root.render(element));
  cleanups.push(() => { act(() => root.unmount()); container.remove(); });
  return container;
}
function key(target: EventTarget, key: string, shiftKey = false) {
  act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })));
}
function click(element: HTMLElement) { act(() => element.click()); }
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); document.body.replaceChildren(); });

it('names the dialog, portals inside its Mist theme, traps Tab and restores its opener', () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  function Example() {
    const [open, setOpen] = React.useState(true);
    return <MistRoot theme="dark"><Dialog open={open} onClose={() => setOpen(false)} title="确认订单" description="确认当前版本"
      footer={<button>确认</button>}><input aria-label="备注" /></Dialog></MistRoot>;
  }
  const host = render(<Example />);
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.closest('.mist-root')?.getAttribute('data-theme')).toBe('dark');
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('确认订单');
  expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe('确认当前版本');
  const first = dialog.querySelector<HTMLButtonElement>('button')!, last = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).at(-1)!;
  expect(document.activeElement).toBe(first);
  act(() => last.focus()); key(last, 'Tab'); expect(document.activeElement).toBe(first);
  key(first, 'Tab', true); expect(document.activeElement).toBe(last);
  key(last, 'Escape'); expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(opener);
});

it('keeps drawer focus inside and returns to the real trigger after Escape', () => {
  function Example() {
    const [open, setOpen] = React.useState(false);
    return <MistRoot><button onClick={() => setOpen(true)}>账号</button><Drawer open={open} onClose={() => setOpen(false)} title="账号操作">
      <button>设置</button><button>退出</button>
    </Drawer><button>外部动作</button></MistRoot>;
  }
  const host = render(<Example />), trigger = host.querySelector<HTMLButtonElement>('button')!;
  act(() => trigger.focus()); click(trigger);
  const drawer = host.querySelector<HTMLElement>('[role="dialog"]')!;
  const outside = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === '外部动作')!;
  act(() => outside.focus()); expect(drawer.contains(document.activeElement)).toBe(true);
  key(document.activeElement!, 'Escape'); expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
});

it('portals a dropdown out of a clipping ancestor into the nearest MistRoot and selects by keyboard', () => {
  const change = vi.fn();
  const host = render(<MistRoot theme="light"><MistRoot theme="dark"><div style={{ overflow: 'hidden' }}>
    <Dropdown label="状态" value="pending" options={[{ value: 'pending', label: '待确认' }, { value: 'done', label: '完成' }]} onChange={change} />
  </div></MistRoot></MistRoot>);
  const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  act(() => trigger.focus()); key(trigger, 'ArrowDown');
  const menu = host.querySelector<HTMLElement>('[role="menu"]')!;
  expect(menu.parentElement).toBe(trigger.closest('.mist-root'));
  expect(menu.closest('.mist-root')?.getAttribute('data-theme')).toBe('dark');
  key(document.activeElement!, 'End'); expect(document.activeElement?.textContent).toBe('完成');
  click(document.activeElement as HTMLElement);
  expect(change).toHaveBeenCalledWith('done'); expect(host.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
});

it('keeps a modal-owned portal menu focused, closes only the menu on Escape and resumes Tab after its trigger', () => {
  const close = vi.fn();
  const host = render(<MistRoot><Dialog open onClose={close} title="匹配筛选"><Dropdown label="仓库" value="a"
    options={[{ value: 'a', label: '甲仓' }, { value: 'b', label: '乙仓' }]} onChange={() => {}} /><input aria-label="下一字段" /></Dialog></MistRoot>);
  const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  click(trigger); expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio');
  key(document.activeElement!, 'Escape'); expect(close).not.toHaveBeenCalled(); expect(document.activeElement).toBe(trigger);
  click(trigger); key(document.activeElement!, 'Tab');
  expect(document.activeElement).toBe(host.querySelector('[aria-label="下一字段"]')); expect(host.querySelector('[role="menu"]')).toBeNull();
});

it('dismisses only the top nested modal and restores focus to its parent trigger', () => {
  const parentClose = vi.fn();
  function Example() {
    const [child, setChild] = React.useState(false);
    return <MistRoot><Dialog open onClose={parentClose} title="父任务"><button onClick={() => setChild(true)}>查看子任务</button>
      <Dialog open={child} onClose={() => setChild(false)} title="子任务"><input aria-label="子字段" /></Dialog>
    </Dialog></MistRoot>;
  }
  const host = render(<Example />), trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === '查看子任务')!;
  act(() => trigger.focus()); click(trigger);
  expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  key(document.activeElement!, 'Escape'); expect(parentClose).not.toHaveBeenCalled(); expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.activeElement).toBe(trigger);
});

it('resets a controlled search on opening and executes a real result after typing', () => {
  const run = vi.fn();
  function Example() {
    const [open, setOpen] = React.useState(false), [query, setQuery] = React.useState('旧查询');
    return <MistRoot><button onClick={() => setOpen(true)}>搜索</button><CommandPalette open={open} onClose={() => setOpen(false)} query={query} onQueryChange={setQuery}
      items={query === '订单' ? [{ id: 'order', group: '订单', label: '订单 SO-1', run }] : []} /></MistRoot>;
  }
  const host = render(<Example />); click(host.querySelector<HTMLButtonElement>('button')!);
  const input = host.querySelector<HTMLInputElement>('input')!;
  expect(input.value).toBe('');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '订单');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.querySelector('.mist-palette-it')?.textContent).toContain('订单 SO-1');
  key(input, 'Enter'); expect(run).toHaveBeenCalledTimes(1); expect(host.querySelector('[role="dialog"]')).toBeNull();
});
