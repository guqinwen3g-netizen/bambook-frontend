import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import scheduler from './acceptance-frontend-run.cjs';
const loadDependency = createRequire(import.meta.url);
const { MUTABLE_CACHE_ENTRIES, createAcceptanceDependencyLayout, privateCacheDir,
  createPrivateFrontendVitestConfig } = loadDependency('./acceptance-dependency-layout.cjs');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const actualRoot = path.dirname(fs.realpathSync(path.join(repo, 'node_modules/vite')));
// Package symlinks in this implementation checkout resolve to immutable read
// inputs. Resolve the server package itself rather than private @prisma/cache.
const actualServer = path.dirname(fs.realpathSync(path.join(repo, 'server/node_modules/vitest')));
function scratch(t) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-cache-probe-')));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  return sandbox;
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function treeFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? treeFiles(file) : [file];
  });
}
function fixture(t, realPackages = false) {
  const sandbox = scratch(t), workspace = path.join(sandbox, 'workspace');
  fs.mkdirSync(path.join(workspace, 'server'), { recursive: true });
  const sharedRootModules = path.join(sandbox, 'shared/root/node_modules');
  const sharedServerModules = path.join(sandbox, 'shared/server/node_modules');
  for (const [source, actual] of [[sharedRootModules, actualRoot], [sharedServerModules, actualServer]]) {
    fs.mkdirSync(source, { recursive: true });
    if (realPackages) for (const entry of fs.readdirSync(actual)) {
      if (MUTABLE_CACHE_ENTRIES.includes(entry) || entry === '.prisma' || entry === '@prisma') continue;
      fs.symlinkSync(path.join(actual, entry), path.join(source, entry));
    }
    for (const entry of MUTABLE_CACHE_ENTRIES) write(path.join(source, entry, 'canary.txt'), 'Shared input must remain exact: ' + entry);
    write(path.join(source, 'dummy/package.json'), '{"name":"dummy","main":"index.cjs"}');
    write(path.join(source, 'dummy/index.cjs'), 'module.exports = "ordinary-package-readback";');
  }
  write(path.join(sharedServerModules, '@prisma/client/default.js'), 'module.exports = "shared-client-canary";');
  write(path.join(sharedServerModules, '@prisma/debug/package.json'), '{"name":"@prisma/debug"}');
  write(path.join(sharedServerModules, '.prisma/client/schema.prisma'), 'shared-generated-schema-canary');
  write(path.join(workspace, 'package.json'), '{"type":"module"}');
  write(path.join(workspace, 'server/package.json'), '{"type":"module"}');
  const beforeCaches = () => Object.fromEntries([sharedRootModules, sharedServerModules].flatMap(source =>
    MUTABLE_CACHE_ENTRIES.flatMap(entry => treeFiles(path.join(source, entry)).map(file => [file, fs.readFileSync(file, 'utf8')]))));
  const originalCaches = beforeCaches();
  const args = { sandbox, workspace, sharedRootModules, sharedServerModules };
  const layout = createAcceptanceDependencyLayout(args);
  // Withdrawal applies ONLY to synthetic shared trees owned by this test.
  if (process.env.BAMBOOK_CACHE_TEST_WITHDRAWAL === '1') {
    for (const [source, target] of [[sharedRootModules, layout.root.path], [sharedServerModules, layout.server.path]]) {
      fs.rmSync(target, { recursive: true, force: true }); fs.symlinkSync(source, target);
    }
  }
  return { ...args, layout, originalCaches, readCaches: beforeCaches };
}
function child(f, source, args = []) {
  const script = path.join(f.sandbox, 'probe-' + Math.random().toString(16).slice(2) + '.mjs');
  write(script, source);
  const result = spawnSync(process.execPath, [script, ...args], { cwd: f.workspace, encoding: 'utf8', timeout: 45000,
    env: { PATH: process.env.PATH, TMPDIR: f.sandbox, NODE_ENV: 'test', BAMBOOK_ACCEPTANCE_SANDBOX: f.sandbox, BAMBOOK_ACCEPTANCE_NO_DATABASE: '1',
      NODE_OPTIONS: '--require=' + path.join(repo, 'scripts/acceptance-network-guard.cjs') } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const denialFile = path.join(f.sandbox, 'network-denials.jsonl');
  const networkDenials = fs.existsSync(denialFile) ? fs.readFileSync(denialFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  assert.deepEqual(networkDenials, []);
  return { ...JSON.parse(result.stdout.trim().split('\n').at(-1)), networkDenials };
}
function proof(name, value) {
  const directory = process.env.BAMBOOK_CACHE_PROBE_EVIDENCE;
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name + '-' + Math.random().toString(16).slice(2) + '.json'), JSON.stringify(value, null, 2) + '\n');
}
function actualBundle(f) {
  const config = path.join(f.workspace, 'probe.vite.config.mts');
  write(config, 'export default { cacheDir: ' + JSON.stringify(path.join(f.sandbox, 'explicit-vite-cache')) + ' };');
  const result = child(f, `import fs from 'node:fs/promises'; import path from 'node:path'; import {pathToFileURL} from 'node:url';
    const writes=[],original=fs.writeFile;
    fs.writeFile=async function(file,...rest){writes.push({file:String(file),parentRealpath:await fs.realpath(path.dirname(String(file)))});return original.call(this,file,...rest)};
    const vite=await import(pathToFileURL(process.argv[2]).href);
    const resolved=await vite.resolveConfig({root:process.argv[3],configFile:process.argv[4],logLevel:'silent'},'serve');
    console.log(JSON.stringify({cacheDir:resolved.cacheDir,writes}));`,
    [path.join(f.layout.root.path, 'vite/dist/node/index.js'), f.workspace, config]);
  proof('vite6-bundle', result); return result;
}
function runVitest(f, frontend, oldDefault = false) {
  const directory = frontend ? f.workspace : path.join(f.workspace, 'server');
  write(path.join(directory, 'probe.test.ts'), "import {it,expect} from 'vitest'; it('synthetic DB-free cache probe',()=>expect(2+2).toBe(4));");
  let config;
  if (frontend) {
    write(path.join(directory, 'vite.config.ts'), "export default () => ({css:{postcss:{plugins:[]}},test:{include:['probe.test.ts'],pool:'forks',fileParallelism:false}});");
    config = createPrivateFrontendVitestConfig({ sandbox: f.sandbox, workspace: f.workspace }).path;
  } else {
    config = path.join(directory, 'probe.vitest.config.mts');
    for (const relative of ['server/acceptance.vitest.config.ts', 'server/vitest.config.ts', 'scripts/acceptance-dependency-layout.cjs']) {
      write(path.join(f.workspace, relative), fs.readFileSync(path.join(repo, relative)));
      assert.deepEqual(fs.readFileSync(path.join(f.workspace, relative)), fs.readFileSync(path.join(repo, relative)));
    }
    write(config, `import acceptance from './acceptance.vitest.config.ts';
      export default {...acceptance, ${oldDefault ? 'cacheDir:undefined,' : ''} root:${JSON.stringify(directory)},
        test:{...acceptance.test,setupFiles:[],include:['probe.test.ts'],pool:'forks',fileParallelism:false,
          poolOptions:{forks:{singleFork:false}},minWorkers:1,maxWorkers:1}};`);
  }
  const cli = path.join(frontend ? f.layout.root.path : f.layout.server.path, 'vitest/vitest.mjs');
  const receipt = path.join(f.sandbox, frontend ? 'frontend-vitest.json' : 'server-vitest.json');
  const result = spawnSync(process.execPath, [cli, 'run', '--config', config, '--reporter=json', '--outputFile=' + receipt],
    { cwd: directory, encoding: 'utf8', timeout: 45000,
      env: { PATH: process.env.PATH, TMPDIR: f.sandbox, NODE_ENV: 'test', BAMBOOK_ACCEPTANCE_SANDBOX: f.sandbox, BAMBOOK_ACCEPTANCE_NO_DATABASE: '1',
      NODE_OPTIONS: '--require=' + path.join(repo, 'scripts/acceptance-network-guard.cjs') } });
  proof(frontend ? 'frontend-vitest4' : oldDefault ? 'backend-vitest2-old-default' : 'backend-vitest2', {
    exitCode: result.status, stdout: result.stdout, stderr: result.stderr, config,
    networkDenials: fs.existsSync(path.join(f.sandbox, 'network-denials.jsonl'))
      ? fs.readFileSync(path.join(f.sandbox, 'network-denials.jsonl'), 'utf8') : '',
    source: fs.readFileSync(config, 'utf8'), report: fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : null });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(report.numTotalTests, 1); assert.equal(report.numPassedTests, 1); assert.equal(report.numPendingTests, 0);
  return { directory, config, report };
}
test('actual frontend scheduler classifies this DB-free probe file as native Node with no ambiguous framework load', () => {
  const result = scheduler.classifyTestSource('scripts/acceptance-dependency-layout.test.mjs', fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'));
  assert.equal(result.executor, 'node');
  assert.ok(result.modules.includes('node:test'));
  assert.ok(result.modules.includes('vite'));
});
test('private containers isolate actual cache writes and Prisma mutations while ordinary packages resolve', t => {
  const f = fixture(t);
  for (const record of [f.layout.root, f.layout.server]) {
    assert.equal(fs.lstatSync(record.path).isSymbolicLink(), false);
    for (const entry of MUTABLE_CACHE_ENTRIES) {
      assert.equal(fs.lstatSync(path.join(record.path, entry)).isSymbolicLink(), false);
      write(path.join(record.path, entry, 'private-write.txt'), 'private');
      fs.rmSync(path.join(record.path, entry, 'private-write.txt'));
    }
    assert.equal(loadDependency(path.join(record.path, 'dummy')), 'ordinary-package-readback');
  }
  write(path.join(f.layout.server.path, '@prisma/client/default.js'), 'private-client-change');
  write(path.join(f.layout.server.path, '.prisma/client/schema.prisma'), 'private-generated-change');
  assert.equal(fs.readFileSync(path.join(f.sharedServerModules, '@prisma/client/default.js'), 'utf8'), 'module.exports = "shared-client-canary";');
  assert.equal(fs.readFileSync(path.join(f.sharedServerModules, '.prisma/client/schema.prisma'), 'utf8'), 'shared-generated-schema-canary');
  assert.deepEqual(f.readCaches(), f.originalCaches);
});
test('absence of shared cache directories still yields fresh writable private caches', t => {
  const f = fixture(t);
  for (const source of [f.sharedRootModules, f.sharedServerModules]) for (const entry of MUTABLE_CACHE_ENTRIES) fs.rmSync(path.join(source, entry), { recursive: true });
  for (const record of [f.layout.root, f.layout.server]) for (const entry of MUTABLE_CACHE_ENTRIES) {
    write(path.join(record.path, entry, 'new.txt'), 'private');
    assert.equal(fs.existsSync(path.join(record.sharedInputRoot, entry)), false);
  }
});
test('unsafe existing containers and workspace/sandbox symlink escapes reject before writes', t => {
  const f = fixture(t);
  assert.throws(() => createAcceptanceDependencyLayout(f), /fresh/);
  const outside = scratch(t); fs.mkdirSync(path.join(outside, 'server'));
  assert.throws(() => createAcceptanceDependencyLayout({ ...f, workspace: outside }), /inside the sandbox/);
  const alias = path.join(f.sandbox, 'aliased-workspace'); fs.symlinkSync(outside, alias);
  assert.throws(() => createAcceptanceDependencyLayout({ ...f, workspace: alias }), /private directory/);
  const aliasedSandbox = path.join(outside, 'sandbox-link'); fs.symlinkSync(f.sandbox, aliasedSandbox);
  assert.throws(() => createAcceptanceDependencyLayout({ ...f, sandbox: aliasedSandbox }), /real private/);
  assert.deepEqual(f.readCaches(), f.originalCaches);
});
test('cache roots reject existing symlink escapes and frontend config refuses overwrite', t => {
  const f = fixture(t), outside = scratch(t);
  fs.symlinkSync(outside, path.join(f.sandbox, 'vitest-cache'));
  assert.throws(() => privateCacheDir(f.sandbox, 'vitest-cache'), /private directory/);
  fs.unlinkSync(path.join(f.sandbox, 'vitest-cache'));
  fs.symlinkSync(path.join(outside, 'missing-target'), path.join(f.sandbox, 'vitest-cache'));
  assert.throws(() => privateCacheDir(f.sandbox, 'vitest-cache'), /private directory/);
  assert.throws(() => privateCacheDir(f.sandbox, '../outside'), /Unreviewed/);
  write(path.join(f.workspace, 'vite.config.ts'), 'export default {};');
  const first = createPrivateFrontendVitestConfig(f);
  assert.ok(first.cacheDir.startsWith(f.sandbox + path.sep));
  assert.throws(() => createPrivateFrontendVitestConfig(f), /EEXIST/);
  assert.deepEqual(f.readCaches(), f.originalCaches);
});
test('installed Vite 6 ESM configuration bundle writes only to the private .vite-temp', t => {
  const f = fixture(t, true), result = actualBundle(f);
  const bundles = result.writes.filter(entry => entry.file.includes('.vite-temp/'));
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].parentRealpath, path.join(f.layout.root.path, '.vite-temp'));
  assert.equal(result.cacheDir, path.join(f.sandbox, 'explicit-vite-cache'));
  assert.deepEqual(f.readCaches(), f.originalCaches);
});
test('Vite 6 old whole-container symlink control exposes a real synthetic shared config write', t => {
  const f = fixture(t, true);
  fs.rmSync(f.layout.root.path, { recursive: true }); fs.symlinkSync(f.sharedRootModules, f.layout.root.path);
  const result = actualBundle(f), bundle = result.writes.find(entry => entry.file.includes('.vite-temp/'));
  assert.equal(bundle.parentRealpath, path.join(f.sharedRootModules, '.vite-temp'));
  assert.notEqual(bundle.parentRealpath, path.join(f.layout.root.path, '.vite-temp'));
});
test('installed backend Vitest 2 writes its actual result cache inside acceptance sandbox', t => {
  const f = fixture(t, true); runVitest(f, false);
  const cacheFiles = treeFiles(path.join(f.sandbox, 'vitest-cache')).filter(file => file.endsWith('results.json'));
  assert.equal(cacheFiles.length, 1);
  const cached = JSON.parse(fs.readFileSync(cacheFiles[0], 'utf8'));
  assert.equal(cached.version, JSON.parse(fs.readFileSync(path.join(f.layout.server.path, 'vitest/package.json'))).version);
  assert.deepEqual(f.readCaches(), f.originalCaches);
});
test('actual backend configuration refuses a symlinked acceptance result-cache root', t => {
  const f = fixture(t, true), outside = scratch(t);
  fs.symlinkSync(outside, path.join(f.sandbox, 'vitest-cache'));
  assert.throws(() => runVitest(f, false), /Acceptance cache must be a private directory/);
  fs.unlinkSync(path.join(f.sandbox, 'vitest-cache'));
  fs.symlinkSync(path.join(outside, 'missing-target'), path.join(f.sandbox, 'vitest-cache'));
  assert.throws(() => runVitest(f, false), /Acceptance cache must be a private directory/);
  assert.deepEqual(f.readCaches(), f.originalCaches);
});
test('actual backend acceptance entry resolves its private cache in the original CommonJS package mode without DB setup', t => {
  const f = fixture(t, true);
  const result = child(f, `import {pathToFileURL} from 'node:url';
    const vite=await import(pathToFileURL(process.argv[2]).href);
    const resolved=await vite.resolveConfig({root:process.argv[3],configFile:process.argv[4],logLevel:'silent'},'serve');
    console.log(JSON.stringify({cacheDir:resolved.cacheDir,setupFiles:resolved.test.setupFiles}));`,
    [path.join(f.layout.server.path, 'vite/dist/node/index.js'), path.join(repo, 'server'), path.join(repo, 'server/acceptance.vitest.config.ts')]);
  assert.equal(result.cacheDir, path.join(f.sandbox, 'vitest-cache'));
  assert.deepEqual(result.setupFiles, ['./src/test-setup.ts']);
  proof('backend-cjs-entry-config', result);
  assert.deepEqual(f.readCaches(), f.originalCaches);
});
test('backend old default cache control exposes actual writes through synthetic shared .vite', t => {
  const f = fixture(t, true);
  fs.rmSync(path.join(f.layout.server.path, '.vite'), { recursive: true });
  fs.symlinkSync(path.join(f.sharedServerModules, '.vite'), path.join(f.layout.server.path, '.vite'));
  runVitest(f, false, true);
  const escaped = treeFiles(path.join(f.sharedServerModules, '.vite')).filter(file => file.endsWith('results.json'));
  assert.equal(escaped.length, 1);
  assert.equal(fs.existsSync(path.join(f.sandbox, 'vitest-cache')), false);
});
test('actual frontend Vitest 4 consumes generated private config and leaves synthetic shared caches exact', t => {
  const f = fixture(t, true); runVitest(f, true);
  const cacheFiles = treeFiles(path.join(f.sandbox, 'frontend-vitest-cache')).filter(file => file.endsWith('results.json'));
  assert.equal(cacheFiles.length, 1);
  assert.deepEqual(f.readCaches(), f.originalCaches);
});
test('actual private Vite serves real font inputs and denies unrelated source outside allowed roots', async t => {
  const sandbox = scratch(t), workspace = path.join(sandbox, 'workspace');
  fs.mkdirSync(path.join(workspace, 'server'), { recursive: true });
  const layout = createAcceptanceDependencyLayout({ sandbox, workspace,
    sharedRootModules: actualRoot, sharedServerModules: actualServer });
  const vite = await import('vite');
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const chosen = socket.address().port; socket.close(() => resolve(chosen)); });
  });
  const server = await vite.createServer({ root: workspace, configFile: false, cacheDir: path.join(sandbox, 'vite-cache'),
    logLevel: 'silent', css: { postcss: { plugins: [] } }, optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, fs: { strict: true, allow: [workspace, layout.root.sharedInputRoot] } } });
  t.after(() => server.close()); await server.listen();
  const address = server.httpServer.address(), base = 'http://127.0.0.1:' + address.port;
  const fontDirectory = path.join(actualRoot, '@fontsource/urbanist/files');
  const font = path.join(fontDirectory, fs.readdirSync(fontDirectory).find(file => file.endsWith('.woff2')));
  const response = await fetch(base + '/@fs' + font);
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(font));
  const denied = path.join(sandbox, 'unrelated-company/source.txt'); write(denied, 'Unrelated company source');
  const deniedStatus = (await fetch(base + '/@fs' + denied)).status;
  assert.equal(deniedStatus, 403);
  proof('font-http', { font, fontStatus: response.status, denied, deniedStatus, allowedRoots: server.config.server.fs.allow,
    privateCacheDir: server.config.cacheDir, privatePort: address.port });
});
