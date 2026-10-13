'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const controller = require('./dev-scenario-apply.cjs');
const rebuild = require('./dev-scenario-rebuild.cjs');
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-source-metadata-test-'))), repo = path.join(base, 'repo');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(repo, { mode: 0o700 });
  const write = (relative, bytes) => { const file = path.join(repo, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  write('.gitignore', '*.log\nserver/logs/\nserver/private-files/\n');
  write('server/src/index.ts', 'export const source = 1;\n');
  write('server/scripts/helper.ts', 'export const helper = 1;\n');
  write('components/Button.tsx', 'export const Button = () => null;\n');
  write('artifacts/qualified.json', '{}');
  write('server/dist/index.js', 'module.exports = 1;\n');
  write('server/node_modules/.prisma/client/index.js', 'module.exports = 2;\n');
  write('server/logs/current.log', 'initial log\n');
  write('server/private-files/original.pdf', 'original business evidence\n');
  write('scripts/ignored.log', 'legitimate ignored log\n');
  cp.execFileSync('git', ['init', '--quiet'], { cwd: repo, stdio: 'pipe' });
  const hash = relative => crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, relative))).digest('hex');
  const manifest = rebuild.currentSourceManifest(repo, { 'artifacts/qualified.json': hash('artifacts/qualified.json') });
  const qualifiedRunDirectory = path.join(base, 'qualified'), privateDirectory = path.join(base, 'private');
  for (const directory of [qualifiedRunDirectory, privateDirectory]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(qualifiedRunDirectory, 'source-files.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(privateDirectory, 'context.private.json'), '{}');
  fs.writeFileSync(path.join(privateDirectory, 'backend-loaded.private.json'), '{}');
  const plistPath = path.join(base, 'job.plist'); fs.writeFileSync(plistPath, '<plist>original</plist>');
  const context = { qualifiedRunDirectory, privateDirectory, verifiedJob: { plistPath }, runtimeProof: {
    emittedManifest: { 'index.js': hash('server/dist/index.js') }, generatedClientManifest: { 'index.js': hash('server/node_modules/.prisma/client/index.js') },
    scriptSources: { 'server/scripts/helper.ts': hash('server/scripts/helper.ts') } } };
  const guard = controller.createPopulationMetadata(repo, context, manifest);
  return { repo, base, write, guard, context };
}
test('normal logs append and private-files creation do not alter qualified source metadata', t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.repo, 'server/logs/current.log'), 'actual progress\n');
  f.write('server/private-files/new-task/report.pdf', 'actual returned report');
  assert.doesNotThrow(f.guard.assertCurrent);
});
test('new source in an initially absent eligible directory remains rejected', t => {
  const f = fixture(t); f.write('hooks/new-path/new-hook.ts', 'export const newHook = true;');
  assert.throws(f.guard.assertCurrent, /RUNTIME_METADATA/);
});
test('new source-shaped symlink omitted by Git remains rejected', t => {
  const f = fixture(t); fs.symlinkSync(f.base, path.join(f.repo, 'components/new-link'));
  assert.throws(f.guard.assertCurrent, /RUNTIME_METADATA/);
});
test('new source FIFO omitted by Git remains rejected', t => {
  const f = fixture(t); cp.execFileSync('mkfifo', [path.join(f.repo, 'server/src/new-pipe.ts')]);
  assert.throws(f.guard.assertCurrent, /RUNTIME_METADATA/);
});
test('byte change with restored mtime is rejected and does not refresh original ctime', t => {
  const f = fixture(t), file = path.join(f.repo, 'server/src/index.ts'), before = fs.statSync(file);
  fs.writeFileSync(file, 'export const source = 2;\n'); fs.utimesSync(file, before.atime, before.mtime);
  assert.throws(f.guard.assertCurrent, /RUNTIME_METADATA/); assert.throws(f.guard.assertCurrent, /RUNTIME_METADATA/);
});
test('new compiled or generated runtime files remain rejected', t => {
  const f = fixture(t); f.write('server/node_modules/.prisma/client/unverified.js', 'new code');
  assert.throws(f.guard.assertCurrent, /RUNTIME_METADATA/);
});
test('forced manifest extras remain protected even outside isSource', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.repo, 'artifacts/qualified.json'));
  assert.throws(f.guard.assertCurrent, /RUNTIME_METADATA/);
});
test('new Git ignore policy cannot hide new source', t => {
  const f = fixture(t); f.write('components/.gitignore', 'hidden.tsx\n'); f.write('components/hidden.tsx', 'hidden code');
  assert.throws(f.guard.assertCurrent, /RUNTIME_METADATA/);
});
