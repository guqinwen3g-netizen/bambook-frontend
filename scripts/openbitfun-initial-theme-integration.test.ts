// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureBambookInitialThemeIntegration } from './openbitfun-initial-theme-integration.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bambook-initial-theme-')); roots.push(root);
  await mkdir(path.join(root, 'src'));
  const files = {
    'src/main.tsx': "import '@bambook/agent-theme';",
    'index.html': '<html><head>\n<link rel="stylesheet" href="/src/design-system-theme.css" />\n</head><body>user markup</body></html>',
    'src/bambookPreload.tsx': "// User note\ndocument.documentElement.dataset.bambookHost = 'true';\ndocument.documentElement.dataset.bambookTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';",
    'src/bambookAppearance.ts': `function install(target) {
  let hostTheme: 'light' | 'dark' | undefined;
  const apply = () => {
    if (!hostTheme) return;
    if (root.dataset.bambookHost !== 'true') root.dataset.bambookHost = 'true';
    if (root.dataset.bambookTheme !== hostTheme) root.dataset.bambookTheme = hostTheme;
    if (root.dataset.openbitfunAppearanceMode !== hostTheme) root.dataset.openbitfunAppearanceMode = hostTheme;
    root.style.colorScheme = hostTheme;
  };
  observe({ attributeFilter: ['data-bambook-theme', 'data-openbitfun-appearance-mode'] });
  const receive = (event: MessageEvent) => {
    hostTheme = data.theme;
  };
}`,
    'vite.config.ts': "{ find: '@bambook/agent-theme', replacement: 'existing' }, // user config",
    'tsconfig.json': '{"paths":{"@bambook/brand": ["brand.tsx"]}}',
  };
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  return root;
}
describe('persistent initial theme migration', () => {
  it('places synchronous bootstrap and blocking shared CSS before upstream CSS and is idempotent', async () => {
    const root = await fixture();
    await ensureBambookInitialThemeIntegration(root);
    const names = ['index.html', 'src/bambookPreload.tsx', 'src/bambookAppearance.ts', 'vite.config.ts', 'tsconfig.json', 'src/bambookInitialTheme.css'];
    const first = await Promise.all(names.map(name => readFile(path.join(root, name), 'utf8')));
    expect(first[0].indexOf('id="bambook-initial-theme"')).toBeLessThan(first[0].indexOf('/src/bambookInitialTheme.css'));
    expect(first[0].indexOf('/src/bambookInitialTheme.css')).toBeLessThan(first[0].indexOf('/src/design-system-theme.css'));
    expect(first[0]).toContain('user markup');
    expect(first[1]).toContain('// User note');
    expect(first[1]).toContain('readInitialBambookTheme(window) ??');
    expect(first[2]).toContain("'data-color-scheme', 'class', 'style'");
    expect(first[2]).toContain('updateBambookThemeUrl(target, hostTheme)');
    expect(first[5]).toContain("@import '@bambook/agent-theme'");
    expect(first[5]).toContain('background: var(--bg-page) !important');
    await ensureBambookInitialThemeIntegration(root);
    expect(await Promise.all(names.map(name => readFile(path.join(root, name), 'utf8')))).toEqual(first);
  });
  it('leaves files untouched if any original integration anchor is missing', async () => {
    const root = await fixture();
    const original = await readFile(path.join(root, 'index.html'), 'utf8');
    await writeFile(path.join(root, 'src/bambookPreload.tsx'), '// unknown preload');
    await expect(ensureBambookInitialThemeIntegration(root)).rejects.toThrow('anchor missing');
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe(original);
  });
  it('refuses to overwrite a locally edited appearance guard', async () => {
    const root = await fixture();
    const file = path.join(root, 'src/bambookAppearance.ts');
    const edited = (await readFile(file, 'utf8')).replace('    if (!hostTheme) return;', '    if (!hostTheme) return;\n    userCustomThemeHook();');
    await writeFile(file, edited);
    await expect(ensureBambookInitialThemeIntegration(root)).rejects.toThrow('anchor missing');
    expect(await readFile(file, 'utf8')).toBe(edited);
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).not.toContain('bambook-initial-theme');
  });
});
