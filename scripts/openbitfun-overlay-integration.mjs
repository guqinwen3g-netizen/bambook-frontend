import { access, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

// Additive migration after the stable host patch. Do not reset the upstream
// checkout or replace user edits just to update a host-owned integration.
export async function ensureBambookOverlayIntegration(webRoot, { optional = false, recordBasePatch = false } = {}) {
  const mainPath = path.join(webRoot, 'src/main.tsx');
  let main;
  try { main = await readFile(mainPath, 'utf8'); }
  catch (error) { if (optional && error.code === 'ENOENT') return false; throw error; }
  if (!main.includes("import '@bambook/agent-theme';")) {
    if (optional) return false;
    throw new Error('Bambook host theme integration missing; overlay migration left source untouched.');
  }
  const vitePath = path.join(webRoot, 'vite.config.ts');
  const tsPath = path.join(webRoot, 'tsconfig.json');
  let [vite, ts] = await Promise.all([readFile(vitePath, 'utf8'), readFile(tsPath, 'utf8')]);
  const inject = (source, marker, insertion) => {
    if (!source.includes(marker)) throw new Error(`Overlay migration anchor missing: ${marker}; source left untouched.`);
    return source.replace(marker, insertion + marker);
  };
  if (!main.includes("import '@bambook/agent-overlays-css';")) {
    main = main.replace("import '@bambook/agent-theme';", "import '@bambook/agent-theme';\nimport '@bambook/agent-overlays-css';\nimport { installBambookOverlayStack } from '@bambook/agent-overlays';\nconst disposeBambookOverlays = installBambookOverlayStack();\nif (import.meta.hot) import.meta.hot.dispose(disposeBambookOverlays);");
  }
  if (!vite.includes("find: '@bambook/agent-overlays-css'")) {
    vite = inject(vite, "{ find: '@bambook/agent-theme',", "{ find: '@bambook/agent-overlays-css', replacement: path.resolve(bambookUiRoot, 'scripts/bambook-agent-overlays.css') },\n        { find: '@bambook/agent-overlays', replacement: path.resolve(bambookUiRoot, 'scripts/bambook-agent-overlays.mjs') },\n        ");
  }
  if (!vite.includes("path.join(bambookUiRoot, 'scripts')")) {
    vite = inject(vite, "path.join(bambookUiRoot, 'styles/bds'),", "path.join(bambookUiRoot, 'scripts'),\n        ");
  }
  if (!ts.includes('"@bambook/agent-overlays"')) {
    ts = inject(ts, '"@bambook/brand":', '"@bambook/agent-overlays": ["../../../../../scripts/bambook-agent-overlays.mjs"],\n      ');
  }
  // Source dev can upgrade before prepare is run again. Verify and receipt the
  // stable base before changing its patch context, exactly as prepare does.
  if (recordBasePatch) {
    const upstream = path.resolve(webRoot, '../..');
    const isCheckout = await access(path.join(upstream, '.git')).then(() => true, () => false);
    if (isCheckout) {
      const patch = path.resolve(webRoot, '../../../../../scripts/openbitfun-host.patch');
      const digest = createHash('sha256').update(await readFile(patch)).digest('hex');
      const receipt = path.join(upstream, '.bambook-host-patch.sha256');
      const previous = await readFile(receipt, 'utf8').catch(() => '');
      if (!previous.trim()) {
        await promisify(execFile)('git', ['apply', '--reverse', '--check', patch], { cwd: upstream });
        await writeFile(receipt, digest);
      } else if (previous.trim() !== digest) {
        throw new Error('Bambook base patch changed; run prepare before migrating overlays.');
      }
    }
  }
  // Validate all anchors before the first write; preserve all unrelated text.
  const replacements = [[mainPath, main], [vitePath, vite], [tsPath, ts]];
  for (const [file, content] of replacements) {
    if (await readFile(file, 'utf8') !== content) await writeFile(file, content);
  }
  return true;
}
