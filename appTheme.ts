import type { SystemConfig } from './types';

export type StoredThemePreference = 'dark' | 'light' | null;

export function resolveInitialDarkMode(
  themeMode: SystemConfig['themeMode'],
  storedTheme: StoredThemePreference,
  systemPrefersDark: boolean,
): boolean {
  if (themeMode === 'dark') return true;
  if (themeMode === 'light') return false;
  if (themeMode === 'system') return systemPrefersDark;
  if (storedTheme === 'dark') return true;
  if (storedTheme === 'light') return false;
  return systemPrefersDark;
}
