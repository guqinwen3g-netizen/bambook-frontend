// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureBambookOverlayIntegration } from './openbitfun-overlay-integration.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bambook-overlay-upgrade-'));
  roots.push(root);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/main.tsx'), "import '@bambook/agent-theme';\n// User's existing application code\n");
  await writeFile(path.join(root, 'vite.config.ts'), "// User config\n{ find: '@bambook/agent-theme', replacement: 'theme' },\npath.join(bambookUiRoot, 'styles/bds'),\n");
  await writeFile(path.join(root, 'tsconfig.json'), '{"paths":{"@bambook/brand": ["brand.tsx"]}}');
  return root;
}
describe('additive OpenBitFun overlay source migration', () => {
  it('upgrades an existing host-patched checkout and preserves unrelated edits', async () => {
    const root = await fixture();
    await ensureBambookOverlayIntegration(root);
    const files = ['src/main.tsx', 'vite.config.ts', 'tsconfig.json'];
    const before = await Promise.all(files.map(file => readFile(path.join(root, file), 'utf8')));
    expect(before[0]).toContain("// User's existing application code");
    expect(before[0]).toContain("import '@bambook/agent-overlays-css';");
    expect(before[1]).toContain('// User config');
    expect(before[1]).toContain("path.join(bambookUiRoot, 'scripts')");
    expect(JSON.parse(before[2]).paths['@bambook/agent-overlays']).toHaveLength(1);
    await ensureBambookOverlayIntegration(root);
    expect(await Promise.all(files.map(file => readFile(path.join(root, file), 'utf8')))).toEqual(before);
  });
  it('does not partially write source when an upgrade anchor is missing', async () => {
    const root = await fixture();
    const original = await readFile(path.join(root, 'src/main.tsx'), 'utf8');
    await writeFile(path.join(root, 'vite.config.ts'), '// unfamiliar user config');
    await expect(ensureBambookOverlayIntegration(root)).rejects.toThrow('anchor missing');
    expect(await readFile(path.join(root, 'src/main.tsx'), 'utf8')).toBe(original);
  });
  it('leaves independent dev-host test fixtures untouched', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'src/main.tsx'), '// independent app');
    expect(await ensureBambookOverlayIntegration(root, { optional: true })).toBe(false);
    expect(await readFile(path.join(root, 'src/main.tsx'), 'utf8')).toBe('// independent app');
  });
  it('receipts the verified base before migration so dev then prepare can repeat safely', async () => {
    const original = await fixture();
    const project = await mkdtemp(path.join(os.tmpdir(), 'bambook-overlay-receipt-'));
    roots.push(project);
    const upstream = path.join(project, 'tmp/upstream/OpenBitFun');
    const web = path.join(upstream, 'src/web-ui');
    await mkdir(path.join(web, 'src'), { recursive: true });
    await mkdir(path.join(project, 'scripts'));
    for (const name of ['src/main.tsx', 'vite.config.ts', 'tsconfig.json']) {
      await writeFile(path.join(web, name), await readFile(path.join(original, name)));
    }
    execFileSync('git', ['init', '--quiet', upstream]);
    const patch = path.join(project, 'scripts/openbitfun-host.patch');
    await writeFile(patch, "diff --git a/src/web-ui/src/main.tsx b/src/web-ui/src/main.tsx\n--- a/src/web-ui/src/main.tsx\n+++ b/src/web-ui/src/main.tsx\n@@ -1 +1,2 @@\n+import '@bambook/agent-theme';\n // User's existing application code\n");
    await ensureBambookOverlayIntegration(web, { recordBasePatch: true });
    expect((await readFile(path.join(upstream, '.bambook-host-patch.sha256'), 'utf8')).trim()).toMatch(/^[a-f0-9]{64}$/);
    await expect(ensureBambookOverlayIntegration(web, { recordBasePatch: true })).resolves.toBe(true);
    await writeFile(patch, '// changed base');
    await expect(ensureBambookOverlayIntegration(web, { recordBasePatch: true })).rejects.toThrow('base patch changed');
  });
});
