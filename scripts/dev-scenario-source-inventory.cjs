'use strict';
// Name-only equivalent of currentSourceManifest. Git qualifications and the
// explicit manifest union stay authoritative; ordinary runtime files do not
// become source merely because their parent also contains TypeScript.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { isSource } = require('./acceptance-working-source.cjs');
const fail = () => { throw Error('DEV_APPLY_RUNTIME_METADATA: Qualified source inventory or Git eligibility changed.'); };
function git(repo, args, optional = false) {
  const result = cp.spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 10000 });
  if (result.error || result.signal || result.status !== 0 && !(optional && result.status === 1)) fail();
  return result;
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) fail();
}
function safe(relative) {
  return typeof relative === 'string' && relative && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.includes('\0')
    && !relative.split('/').some(part => !part || part === '.' || part === '..');
}
function sourceInventory(repo, manifest) {
  const policies = new Set();
  const potential = relative => ['docs', 'server/ops-panel'].includes(relative)
    || ['__inventory__.ts', '__inventory__.prisma', 'migration.sql', 'compositionTerms.ts', 'sttCustomTerms.ts']
      .some(name => isSource(relative + '/' + name));
  const visit = (directory, relative) => {
    for (const name of fs.readdirSync(directory)) {
      const child = relative ? relative + '/' + name : name, file = path.join(directory, name), stat = fs.lstatSync(file);
      if (name === '.gitignore') { regular(file); policies.add(file); }
      if (stat.isDirectory()) { if (potential(child)) visit(file, child); }
      else if ((isSource(child) || potential(child)) && (!stat.isFile() || stat.isSymbolicLink())) fail();
    }
  };
  visit(repo, '');
  const names = new Set();
  for (const relative of git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean)) {
    if (!safe(relative)) fail();
    if (!isSource(relative)) continue;
    try { regular(path.join(repo, relative)); names.add(relative); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const relative of Object.keys(manifest)) { if (!safe(relative)) fail(); regular(path.join(repo, relative)); names.add(relative); }
  for (const row of git(repo, ['config', '--show-origin', '--list']).stdout.split('\n')) {
    const origin = row.match(/^file:(.*?)\t/);
    if (origin) { const file = path.resolve(repo, origin[1]); regular(file); policies.add(file); }
  }
  for (const suffix of ['config', 'info/exclude']) {
    const file = path.resolve(repo, git(repo, ['rev-parse', '--git-path', suffix]).stdout.trim());
    if (fs.existsSync(file)) { regular(file); policies.add(file); }
  }
  const excludes = git(repo, ['config', '--path', '--get', 'core.excludesFile'], true);
  if (excludes.status === 0 && excludes.stdout.trim()) {
    const file = path.resolve(repo, excludes.stdout.trim()); if (fs.existsSync(file)) { regular(file); policies.add(file); }
  }
  return { names: [...names].sort(), policies: [...policies].sort() };
}
module.exports = Object.freeze({ sourceInventory });
