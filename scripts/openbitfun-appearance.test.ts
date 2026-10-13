// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { installBambookAppearance } from '../tmp/upstream/OpenBitFun/src/web-ui/src/bambookAppearance';

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture() {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const target = frame.contentWindow!;
  cleanup = installBambookAppearance(target);
  return { target, send: (data: unknown, origin = 'http://localhost:3000', source: Window = target.parent) =>
    target.dispatchEvent(new MessageEvent('message', { data, origin, source })) };
}
const theme = (value: string) => ({ type: 'bambook:appearance', version: 1, theme: value });
describe('Bambook appearance-only boundary', () => {
  it('applies the initial URL theme synchronously and keeps all upstream flags stable before a host message', async () => {
    const events = new EventTarget();
    const doc = document.implementation.createHTMLDocument('theme fixture');
    const location = new URL('http://127.0.0.1:1422/?keep=1&bambookTheme=dark#draft');
    const replaceState = vi.fn((_state, _title, href) => { location.href = href; });
    const target = {
      parent: window, document: doc, location, history: { state: { retained: true }, replaceState },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } as unknown as Window;
    cleanup = installBambookAppearance(target);
    const root = doc.documentElement;
    expect(root.dataset).toMatchObject({ bambookTheme: 'dark', colorScheme: 'dark', openbitfunAppearanceMode: 'dark' });
    root.dataset.colorScheme = 'light';
    root.classList.remove('dark');
    root.style.colorScheme = 'light';
    root.style.backgroundColor = '#fff';
    await Promise.resolve();
    expect(root.dataset.colorScheme).toBe('dark');
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
    expect(root.style.backgroundColor).toBe('var(--bg-page)');
    events.dispatchEvent(new MessageEvent('message', { source: window, origin: 'http://localhost:3000', data: theme('light') }));
    expect(replaceState).toHaveBeenCalledWith({ retained: true }, '', 'http://127.0.0.1:1422/?keep=1&bambookTheme=light#draft');
    expect(root.dataset.bambookTheme).toBe('light');
    cleanup!();
    cleanup = installBambookAppearance(target);
    expect(root.dataset.bambookTheme).toBe('light');
  });
  it('accepts parent theme changes without persisting settings', async () => {
    const { target, send } = fixture();
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    send(theme('dark'));
    expect(target.document.documentElement.dataset).toMatchObject({ bambookHost: 'true', bambookTheme: 'dark' });
    target.document.documentElement.dataset.openbitfunAppearanceMode = 'light';
    target.document.documentElement.dataset.bambookTheme = 'light';
    await Promise.resolve();
    expect(target.document.documentElement.dataset.openbitfunAppearanceMode).toBe('dark');
    expect(target.document.documentElement.dataset.bambookTheme).toBe('dark');
    send(theme('light'));
    expect(target.document.documentElement.dataset.bambookTheme).toBe('light');
    expect(storage).not.toHaveBeenCalled();
    cleanup!(); send(theme('dark'));
    target.document.documentElement.dataset.openbitfunAppearanceMode = 'dark';
    await Promise.resolve();
    expect(target.document.documentElement.dataset.bambookTheme).toBe('light');
    expect(target.document.documentElement.dataset.openbitfunAppearanceMode).toBe('dark');
  });
  it('accepts the Electron file parent', () => {
    const { target, send } = fixture(); send(theme('dark'), 'null');
    expect(target.document.documentElement.dataset.bambookTheme).toBe('dark');
  });
  it.each([
    ['wrong origin', theme('dark'), 'https://untrusted.invalid'],
    ['invalid theme', theme('system'), 'http://localhost:3000'],
    ['wrong version', { ...theme('dark'), version: 2 }, 'http://localhost:3000'],
    ['wrong kind', { ...theme('dark'), type: 'execute' }, 'http://localhost:3000'],
  ])('ignores %s', (_label, data, origin) => {
    const { target, send } = fixture(); send(data, origin);
    expect(target.document.documentElement.dataset.bambookHost).toBeUndefined();
  });
  it('ignores a same-origin window that is not the parent', () => {
    const { target, send } = fixture(); send(theme('dark'), 'http://localhost:3000', target);
    expect(target.document.documentElement.dataset.bambookHost).toBeUndefined();
  });
  it('does not activate in a standalone window', () => {
    const listen = vi.spyOn(window, 'addEventListener'); cleanup = installBambookAppearance(window);
    expect(listen).not.toHaveBeenCalled();
  });
  it('maps only existing canonical OBF and BDS tokens', () => {
    const css = readFileSync('styles/bds/agent-theme.css', 'utf8');
    const contract = readFileSync('tmp/upstream/OpenBitFun/design-system/packages/design-tokens/dist/tokens.css', 'utf8')
      + readFileSync('tmp/upstream/OpenBitFun/design-system/packages/theme-openbitfun/dist/themes.css', 'utf8');
    const bds = readFileSync('styles/bds/tokens.css', 'utf8');
    for (const [, name] of css.matchAll(/(--openbitfun-[\w-]+):/g)) expect(contract).toContain(`${name}:`);
    for (const [, name] of css.matchAll(/var\((--[\w-]+)\)/g)) expect(bds).toContain(`${name}:`);
    expect(css).toContain(':root[data-bambook-host] [data-openbitfun-theme-scope]');
    expect(bds).toContain(':root[data-bambook-theme="dark"]');
    const primary = readFileSync('styles/bds/primary-actions.css', 'utf8');
    expect(primary).toContain(':where(:root[data-bambook-host] [data-openbitfun-component="button"][data-openbitfun-variant="primary"])');
  });
});
