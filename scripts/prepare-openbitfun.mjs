import { access, cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ensureBambookOverlayIntegration } from './openbitfun-overlay-integration.mjs';
import { ensureBambookInitialThemeIntegration } from './openbitfun-initial-theme-integration.mjs';
import { OPENBITFUN_REVISION, OPENBITFUN_SUSPENDED, spawnGuarded } from './openbitfun-runtime.mjs';

if (OPENBITFUN_SUSPENDED) {
  console.error('[openbitfun:prepare] Build suspended pending investigation of the memory exhaustion incident.');
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, '..');
const upstream = path.join(root, 'tmp/upstream/OpenBitFun');
const bundle = path.join(root, 'tmp/openbitfun-runtime');
const tools = path.join(root, 'tmp/openbitfun-tools');
const cargoBin = path.join(tools, 'cargo/bin');
const nodeTools = path.join(tools, 'node');
const env = {
  ...process.env,
  PATH: `${path.join(nodeTools, 'node_modules/.bin')}${path.delimiter}${cargoBin}${path.delimiter}${process.env.PATH}`,
  BAMBOOK_UI_ROOT: root,
  OPENBITFUN_PRODUCT_ID: 'bambook-agent',
  OPENBITFUN_DATA_NAMESPACE: 'bambook-agent',
  OPENBITFUN_HIDDEN_DATA_DIRECTORY: '.bambook-agent',
  CARGO_PROFILE_DEV_DEBUG: '0',
  CARGO_BUILD_JOBS: '1',
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=3072`.trim(),
};
try {
  await access(path.join(cargoBin, 'cargo'));
  env.CARGO_HOME = path.join(tools, 'cargo');
  env.RUSTUP_HOME = path.join(tools, 'rustup');
} catch { /* A pre-existing system Rust toolchain may also be used. */ }

async function run(command, args, cwd = upstream, capture = false) {
  const managed = await spawnGuarded(command, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', maxRssMiB: 6144, timeoutMs: 900000 });
  const stop = () => managed.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let output = '', outputOverflow = false;
  if (capture) managed.child.stdout.on('data', chunk => {
    if (output.length + chunk.length > 65536) { outputOverflow = true; managed.stop(); }
    else output += chunk;
  });
  try {
    const result = await managed.done;
    if (outputOverflow || result.code !== 0) throw new Error(`${command} stopped before completion`);
    return output.trim();
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

try {
  await mkdir(path.dirname(upstream), { recursive: true });
  try { await access(path.join(upstream, '.git')); }
  catch {
    await run('git', ['clone', '--no-checkout', '--filter=blob:none', 'https://github.com/GCWing/OpenBitFun.git', upstream], root);
    await run('git', ['checkout', '--detach', OPENBITFUN_REVISION]);
  }
  if (await run('git', ['rev-parse', 'HEAD'], upstream, true) !== OPENBITFUN_REVISION) {
    throw new Error('OpenBitFun checkout revision mismatch; existing checkout was left untouched.');
  }
  const patch = path.join(root, 'scripts/openbitfun-host.patch');
  const patchDigest = createHash('sha256').update(await readFile(patch)).digest('hex');
  const patchReceipt = path.join(upstream, '.bambook-host-patch.sha256');
  const appliedDigest = await readFile(patchReceipt, 'utf8').catch(() => '');
  // Additive integration migrations change lines in the host patch's context.
  // A digest receipt avoids reapplying it over those changes on the next run.
  if (appliedDigest.trim() !== patchDigest) {
    try { await run('git', ['apply', '--reverse', '--check', patch], upstream, true); }
    catch {
      await run('git', ['apply', '--check', patch]);
      await run('git', ['apply', patch]);
    }
    await writeFile(patchReceipt, patchDigest);
  }
  await ensureBambookOverlayIntegration(path.join(upstream, 'src/web-ui'));
  await ensureBambookInitialThemeIntegration(path.join(upstream, 'src/web-ui'));
  // A source checkout is retained separately from the redistributable bundle.
  await run('npm', ['install', '--prefix', nodeTools, '--no-audit', '--no-fund', 'pnpm@10.15.0', 'bun@1.3.14'], root);
  await run('cargo', ['--version']);
  await run('pnpm', ['install', '--frozen-lockfile']);
  await run('bun', ['install', '--cwd', 'src/apps/extension-host', '--frozen-lockfile']);
  await run('bun', ['run', '--cwd', 'src/apps/extension-host', 'build']);
  await run('pnpm', ['--dir', 'src/web-ui', 'run', 'build:web']);
  await run('cargo', ['build', '--locked', '--manifest-path', 'src/apps/server/Cargo.toml']);
  await mkdir(bundle, { recursive: true });
  const binaryName = process.platform === 'win32' ? 'openbitfun-server.exe' : 'openbitfun-server';
  // Replace the inode atomically: overwriting a previously executed Mach-O can
  // retain stale macOS code-signing cache entries and cause launch-time SIGKILL.
  await cp(path.join(upstream, 'target/debug', binaryName), path.join(bundle, `${binaryName}.next`));
  await rename(path.join(bundle, `${binaryName}.next`), path.join(bundle, binaryName));
  await cp(path.join(upstream, 'dist'), path.join(bundle, 'web'), { recursive: true });
  const fontNotices = path.join(bundle, 'web/third-party/fonts/bambook');
  await mkdir(fontNotices, { recursive: true });
  for (const [name, dependency] of Object.entries({
    urbanist: '@fontsource/urbanist', harmonyos: 'harmonyos-sans-sc-webfont-splitted',
    jetbrains: '@fontsource/jetbrains-mono',
  })) {
    await cp(path.join(root, 'node_modules', dependency, 'LICENSE'), path.join(fontNotices, `${name}-LICENSE.txt`));
  }
  await cp(path.join(upstream, 'src/apps/extension-host/dist'), path.join(bundle, 'resources/ext-host'), { recursive: true });
  await mkdir(path.join(bundle, 'bin'), { recursive: true });
  await cp(path.join(nodeTools, 'node_modules/bun/bin/bun.exe'), path.join(bundle, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun'));
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await cp(path.join(upstream, name), path.join(bundle, name));
  }
  await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({ revision: OPENBITFUN_REVISION, version: '1.0.5', platform: process.platform, arch: process.arch }, null, 2));
  console.log(`OpenBitFun prepared: ${bundle}`);
} catch (error) {
  console.error(`[openbitfun:prepare] ${error.message}`);
  process.exitCode = 1;
}
