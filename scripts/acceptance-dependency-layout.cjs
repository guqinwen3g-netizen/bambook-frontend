'use strict';
// Dependency packages are shared read inputs by convention, not read-only OS
// mounts. Writable framework caches and generated Prisma code stay private.
const fs = require('node:fs');
const path = require('node:path');

const MUTABLE_CACHE_ENTRIES = Object.freeze(['.vite', '.vite-temp', '.cache', '.tmp']);
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function existsIncludingSymlink(target) {
  try { fs.lstatSync(target); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function privateParent(sandbox, parent) {
  const actual = fs.realpathSync(parent);
  if (!inside(sandbox, actual) || fs.lstatSync(parent).isSymbolicLink()) {
    throw Error('Dependency container parent must be a private directory inside the sandbox');
  }
  return actual;
}
function createAcceptanceDependencyLayout({ sandbox, workspace, sharedRootModules, sharedServerModules }) {
  if (fs.lstatSync(sandbox).isSymbolicLink()) throw Error('Acceptance sandbox must be a real private directory');
  const sandboxRoot = fs.realpathSync(sandbox);
  const workspaceRoot = privateParent(sandboxRoot, workspace);
  const serverRoot = privateParent(sandboxRoot, path.join(workspaceRoot, 'server'));
  const rootTarget = path.join(workspaceRoot, 'node_modules');
  const serverTarget = path.join(serverRoot, 'node_modules');
  const rootSource = fs.realpathSync(sharedRootModules);
  const serverSource = fs.realpathSync(sharedServerModules);
  for (const [source, target] of [[rootSource, rootTarget], [serverSource, serverTarget]]) {
    if (!fs.statSync(source).isDirectory() || source === target || inside(target, source) || inside(source, target)
      || existsIncludingSymlink(target)) throw Error('Dependency container must be fresh, private and distinct from its shared input');
  }
  // Check the special package before creating either container. Generation is
  // still performed by the owning runner against its copied client package.
  const prismaSource = path.join(serverSource, '@prisma');
  const prismaEntries = fs.readdirSync(prismaSource);
  if (!prismaEntries.includes('client')) throw Error('Shared Prisma client input is required');
  function container(source, target, privatePrisma) {
    fs.mkdirSync(target, { mode: 0o700 });
    for (const entry of fs.readdirSync(source)) {
      if (MUTABLE_CACHE_ENTRIES.includes(entry) || entry === '.prisma' || (privatePrisma && entry === '@prisma')) continue;
      fs.symlinkSync(path.join(source, entry), path.join(target, entry));
    }
    for (const entry of MUTABLE_CACHE_ENTRIES) fs.mkdirSync(path.join(target, entry), { mode: 0o700 });
    if (privatePrisma) {
      fs.mkdirSync(path.join(target, '@prisma'));
      for (const entry of prismaEntries) {
        const input = path.join(prismaSource, entry), output = path.join(target, '@prisma', entry);
        if (entry === 'client') fs.cpSync(fs.realpathSync(input), output, { recursive: true });
        else fs.symlinkSync(input, output);
      }
    }
    return { path: target, sharedInputRoot: source,
      mutableCaches: Object.fromEntries(MUTABLE_CACHE_ENTRIES.map(entry => [entry, fs.realpathSync(path.join(target, entry))])) };
  }
  return { root: container(rootSource, rootTarget, false), server: container(serverSource, serverTarget, true),
    boundary: 'Ordinary dependency symlinks are logical read inputs; framework cache containers and generated Prisma code are private, not an OS filesystem sandbox' };
}
function privateCacheDir(sandbox, directory) {
  if (!['vitest-cache', 'frontend-vitest-cache'].includes(directory)) throw Error('Unreviewed acceptance cache directory');
  if (fs.lstatSync(sandbox).isSymbolicLink()) throw Error('Acceptance sandbox must be a real private directory');
  const root = fs.realpathSync(sandbox), target = path.join(root, directory);
  if (existsIncludingSymlink(target) && (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isDirectory())) {
    throw Error('Acceptance cache must be a private directory');
  }
  return target;
}
function createPrivateFrontendVitestConfig({ sandbox, workspace }) {
  const workspaceRoot = privateParent(fs.realpathSync(sandbox), workspace);
  const cacheDir = privateCacheDir(sandbox, 'frontend-vitest-cache');
  const configPath = path.join(workspaceRoot, 'acceptance-frontend.vitest.config.mts');
  const source = `import config from './vite.config.ts';\nexport default (env) => { const base = typeof config === 'function' ? config(env) : config; return { ...base, cacheDir: ${JSON.stringify(cacheDir)} }; };\n`;
  fs.writeFileSync(configPath, source, { flag: 'wx', mode: 0o600 });
  return { path: configPath, cacheDir, sha256: require('node:crypto').createHash('sha256').update(source).digest('hex') };
}
module.exports = { MUTABLE_CACHE_ENTRIES, createAcceptanceDependencyLayout, privateCacheDir, createPrivateFrontendVitestConfig };
