// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyBambookInitialTheme, bambookInitialThemeBootstrap, readInitialBambookTheme, updateBambookThemeUrl } from './bambook-initial-theme.mjs';

afterEach(() => { document.documentElement.removeAttribute('style'); document.documentElement.className = ''; for (const key of Object.keys(document.documentElement.dataset)) delete document.documentElement.dataset[key]; vi.restoreAllMocks(); });
const embedded = (search = '') => ({ parent: {}, location: { search }, document });
describe('Bambook first-paint host theme', () => {
  it.each(['light', 'dark'])('bootstraps %s synchronously before CSS/module startup', theme => {
    const target = embedded(`?bambookTheme=${theme}`);
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    new Function('window', 'document', bambookInitialThemeBootstrap)(target, document);
    const root = document.documentElement;
    expect(root.dataset).toMatchObject({ bambookHost: 'true', bambookTheme: theme, colorScheme: theme, openbitfunAppearanceMode: theme });
    expect(root.classList.contains('dark')).toBe(theme === 'dark');
    expect(root.style.colorScheme).toBe(theme);
    expect(root.style.backgroundColor).toBe('var(--bg-page)');
    expect(storage).not.toHaveBeenCalled();
  });
  it.each(['?bambookTheme=system', '?bambookTheme=Dark', '?bambookTheme=', ''])('rejects invalid or absent URL choice %s', search => {
    expect(readInitialBambookTheme(embedded(search) as any)).toBeUndefined();
  });
  it('does not activate query theme in a standalone window', () => {
    const target: any = embedded('?bambookTheme=dark'); target.parent = target;
    expect(readInitialBambookTheme(target)).toBeUndefined();
    new Function('window', 'document', bambookInitialThemeBootstrap)(target, document);
    expect(document.documentElement.dataset.bambookHost).toBeUndefined();
  });
  it('keeps a validated early embedded marker and restores every upstream mode flag', () => {
    applyBambookInitialTheme(document.documentElement, 'dark');
    expect(readInitialBambookTheme(embedded() as any)).toBe('dark');
    document.documentElement.dataset.colorScheme = 'light';
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = 'light';
    applyBambookInitialTheme(document.documentElement, 'dark');
    expect(document.documentElement.dataset.colorScheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
  it('updates only the theme query after a trusted change so refresh preserves it', () => {
    const replaceState = vi.fn();
    const target: any = { parent: {}, location: { href: 'http://127.0.0.1:1422/work?keep=1&bambookTheme=light#draft' }, history: { state: { session: 7 }, replaceState } };
    updateBambookThemeUrl(target, 'dark');
    expect(replaceState).toHaveBeenCalledWith({ session: 7 }, '', 'http://127.0.0.1:1422/work?keep=1&bambookTheme=dark#draft');
    expect(readInitialBambookTheme({ ...target, location: { search: '?keep=1&bambookTheme=dark' }, document })).toBe('dark');
  });
});
