import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bambookInitialThemeBootstrap } from './bambook-initial-theme.mjs';

/** Additive update after the stable base and overlay migrations. */
export async function ensureBambookInitialThemeIntegration(webRoot, { optional = false } = {}) {
  const mainPath = path.join(webRoot, 'src/main.tsx');
  let main;
  try { main = await readFile(mainPath, 'utf8'); }
  catch (error) { if (optional && error.code === 'ENOENT') return false; throw error; }
  if (!main.includes("import '@bambook/agent-theme';")) {
    if (optional) return false;
    throw new Error('Bambook host integration missing; initial-theme migration left source untouched.');
  }
  const paths = ['index.html', 'src/bambookPreload.tsx', 'src/bambookAppearance.ts'];
  let [html, preload, appearance] = await Promise.all(paths.map(name => readFile(path.join(webRoot, name), 'utf8')));
  const replace = (source, anchor, replacement) => {
    if (!source.includes(anchor)) throw new Error(`Initial-theme migration anchor missing: ${anchor}; source left untouched.`);
    return source.replace(anchor, replacement);
  };
  const bootstrap = `<script id="bambook-initial-theme">${bambookInitialThemeBootstrap}</script>`;
  if (!html.includes('id="bambook-initial-theme"')) {
    const earlyAnchor = html.includes('<meta charset="UTF-8" />') ? '<meta charset="UTF-8" />' : '<head>';
    html = replace(html, earlyAnchor, `${earlyAnchor}\n    ${bootstrap}`);
  }
  if (!html.includes('/src/bambookInitialTheme.css')) html = replace(html, '<link rel="stylesheet" href="/src/design-system-theme.css" />', '<link rel="stylesheet" href="/src/bambookInitialTheme.css" />\n    <link rel="stylesheet" href="/src/design-system-theme.css" />');
  if (!preload.includes('readInitialBambookTheme')) {
    preload = "import { readInitialBambookTheme, applyBambookInitialTheme } from '../../../../../../scripts/bambook-initial-theme.mjs';\n" + replace(preload,
      "document.documentElement.dataset.bambookHost = 'true';\ndocument.documentElement.dataset.bambookTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';",
      "const initialTheme = readInitialBambookTheme(window) ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');\napplyBambookInitialTheme(document.documentElement, initialTheme);");
  }
  if (!appearance.includes('readInitialBambookTheme')) {
    appearance = "import { readInitialBambookTheme, applyBambookInitialTheme, updateBambookThemeUrl } from '../../../../../../scripts/bambook-initial-theme.mjs';\n" + replace(appearance,
      "let hostTheme: 'light' | 'dark' | undefined;",
      "let hostTheme: 'light' | 'dark' | undefined = readInitialBambookTheme(target);");
    appearance = replace(appearance, `  const apply = () => {
    if (!hostTheme) return;
    if (root.dataset.bambookHost !== 'true') root.dataset.bambookHost = 'true';
    if (root.dataset.bambookTheme !== hostTheme) root.dataset.bambookTheme = hostTheme;
    if (root.dataset.openbitfunAppearanceMode !== hostTheme) root.dataset.openbitfunAppearanceMode = hostTheme;
    root.style.colorScheme = hostTheme;
  };`, '  const apply = () => { applyBambookInitialTheme(root, hostTheme);\n  };');
    appearance = replace(appearance,
      "attributeFilter: ['data-bambook-theme', 'data-openbitfun-appearance-mode']",
      "attributeFilter: ['data-bambook-host', 'data-bambook-theme', 'data-openbitfun-appearance-mode', 'data-color-scheme', 'class', 'style']");
    appearance = replace(appearance, "  const receive = (event: MessageEvent) => {", "  apply();\n  const receive = (event: MessageEvent) => {");
    appearance = replace(appearance, '    hostTheme = data.theme;', '    hostTheme = data.theme;\n    updateBambookThemeUrl(target, hostTheme);');
  }
  const changes = paths.map((name, index) => [path.join(webRoot, name), [html, preload, appearance][index]]);
  changes.push([path.join(webRoot, 'src/bambookInitialTheme.css'), "@import '@bambook/agent-theme';\n:root[data-bambook-host], :root[data-bambook-host] body { background: var(--bg-page) !important; }\n"]);
  for (const [file, content] of changes) {
    if (await readFile(file, 'utf8').catch(() => '') !== content) await writeFile(file, content);
  }
  return true;
}
