/** Only an embedded host may choose the initial theme through the URL. */
export function readInitialBambookTheme(target) {
  if (target.parent === target) return undefined;
  const value = new URLSearchParams(target.location.search).get('bambookTheme');
  if (value === 'light' || value === 'dark') return value;
  const root = target.document.documentElement;
  const early = root.dataset.bambookTheme;
  return root.dataset.bambookHost === 'true' && (early === 'light' || early === 'dark') ? early : undefined;
}

/** Shared by the synchronous head bootstrap and later appearance guard. */
export function applyBambookInitialTheme(root, theme) {
  if (theme !== 'light' && theme !== 'dark') return;
  const attributes = {
    'data-bambook-host': 'true', 'data-bambook-theme': theme,
    'data-openbitfun-appearance-mode': theme, 'data-color-scheme': theme,
  };
  for (const [name, value] of Object.entries(attributes)) {
    if (root.getAttribute(name) !== value) root.setAttribute(name, value);
  }
  if (root.classList.contains('dark') !== (theme === 'dark')) root.classList.toggle('dark', theme === 'dark');
  if (root.style.colorScheme !== theme) root.style.colorScheme = theme;
  if (root.style.backgroundColor !== 'var(--bg-page)') root.style.backgroundColor = 'var(--bg-page)';
}

/** The child document's own refresh must retain the latest trusted host theme. */
export function updateBambookThemeUrl(target, theme) {
  if (target.parent === target || (theme !== 'light' && theme !== 'dark')) return;
  const url = new URL(target.location.href);
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) return;
  if (url.searchParams.get('bambookTheme') === theme) return;
  url.searchParams.set('bambookTheme', theme);
  target.history.replaceState(target.history.state, '', url.href);
}

// Inline instead of a module: execute before the first stylesheet can paint.
export const bambookInitialThemeBootstrap = `(function () {
  var read = ${readInitialBambookTheme.toString()};
  var apply = ${applyBambookInitialTheme.toString()};
  var theme = read(window);
  if (theme) apply(document.documentElement, theme);
})();`;
