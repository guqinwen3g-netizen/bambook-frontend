export function readInitialBambookTheme(target: Window): 'light' | 'dark' | undefined;
export function applyBambookInitialTheme(root: HTMLElement, theme: 'light' | 'dark' | undefined): void;
export function updateBambookThemeUrl(target: Window, theme: 'light' | 'dark'): void;
export const bambookInitialThemeBootstrap: string;
