import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import scheduler from './acceptance-frontend-run.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { classifyTestSource, splitTestInventory, nodeReporterSource, readNodeReceipt,
  readVitestReceipt, aggregateExecutorCounts, executorPairPassed } = scheduler;
function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-frontend-scheduling-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function nodeProbe(t, source) {
  const dir = scratch(t), file = path.join(dir, 'native.test.cjs'), reporter = path.join(dir, 'reporter.cjs'), events = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, source);
  fs.writeFileSync(reporter, nodeReporterSource);
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=' + reporter, '--test-reporter-destination=' + events, file], {
    cwd: dir, encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', NODE_OPTIONS: '--require=' + path.join(root, 'scripts/acceptance-network-guard.cjs'),
      BAMBOOK_ACCEPTANCE_SANDBOX: dir, BAMBOOK_ACCEPTANCE_NO_DATABASE: '1' },
  });
  return { dir, result, jsonl: fs.readFileSync(events, 'utf8') };
}
const passedExecutor = (tests = 1) => ({ status: 'passed', exitCode: 0, expectedFiles: ['test'], errors: [], counts: { tests, passed: tests, failed: 0, skipped: 0, files: 1 } });

test('the three original native files and this new protocol test are classified by actual imports', () => {
  for (const file of ['scripts/collect-tier-g3-source-evidence.test.mjs', 'scripts/tier-message-baseline-evidence.test.mjs',
    'scripts/tier-message-sources.test.mjs', 'scripts/acceptance-frontend-scheduling.test.mjs']) {
    const result = classifyTestSource(file, fs.readFileSync(path.join(root, file), 'utf8'));
    assert.equal(result.executor, 'node', file);
    assert.ok(result.modules.includes('node:test'));
  }
});
test('native imports are source bindings, not filenames, comments or example strings', () => {
  for (const source of ["import run from 'node:test'; run('case',()=>{});", "import {test as run} from 'node:test';",
    "const {test}=require('node:test');", "const test=await import('node:test');"]) {
    assert.equal(classifyTestSource('arbitrary.test.mjs', source).executor, 'node');
  }
  for (const source of ["// import test from 'node:test';", "const example=\"import test from 'node:test';\";",
    "import type {TestContext} from 'node:test';", "import test from './node-test-lookalike.mjs';"]) {
    assert.equal(classifyTestSource('tier-message-sources.test.mjs', source).executor, 'vitest');
  }
});
test('mixed, computed and shadowed framework loads are never silently excluded from Vitest', () => {
  for (const tail of ["import {it} from 'vitest';", "import * as other from '@vitest/runner';", "require('vitest');",
    "export {it} from 'vitest';", "await import('vitest');", 'await import(frameworkName);', "function require(x){return x}; require('node:test');"]) {
    assert.equal(classifyTestSource('native.test.mjs', "import test from 'node:test';\n" + tail).executor, 'vitest');
  }
});
test('same inventory preserves every file and its source hash; missing, duplicates and escapes reject', t => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'a.test.mjs'), "import test from 'node:test';");
  fs.writeFileSync(path.join(dir, 'b.test.ts'), "import {it} from 'vitest';");
  const entries = [{ file: path.join(dir, 'b.test.ts') }, { file: path.join(dir, 'a.test.mjs') }];
  const inventory = splitTestInventory(dir, entries);
  assert.deepEqual(inventory.map(item => [item.file, item.executor]), [['a.test.mjs', 'node'], ['b.test.ts', 'vitest']]);
  assert.ok(inventory.every(item => /^[a-f0-9]{64}$/.test(item.sourceSha256)));
  assert.throws(() => splitTestInventory(dir, []), /empty/);
  assert.throws(() => splitTestInventory(dir, [entries[0], entries[0]]), /Duplicate/);
  assert.throws(() => splitTestInventory(dir, [{ file: path.join(root, 'package.json') }]), /escaped/);
  assert.throws(() => splitTestInventory(dir, [{ file: path.join(dir, 'missing.test.mjs') }]), /ENOENT/);
});
test('real Node execution produces two original cases and both terminal/per-file receipts', t => {
  const probe = nodeProbe(t, "const {test}=require('node:test');test('one',()=>{});test('two',()=>{});");
  assert.equal(probe.result.status, 0, probe.result.stderr);
  const receipt = readNodeReceipt(probe.dir, ['native.test.cjs'], probe.jsonl);
  assert.equal(receipt.counts.tests, 2); assert.equal(receipt.counts.passed, 2);
  assert.equal(receipt.counts.files, 1); assert.equal(receipt.fileResults[0].counts.tests, 2);
  assert.deepEqual(receipt.errors, []); assert.deepEqual(receipt.failures, []);
});
test('real native assertion failure remains a failed executor even when Vitest passes', t => {
  const probe = nodeProbe(t, "const {test}=require('node:test');test('denied',()=>{throw Error('native failure control')});");
  assert.notEqual(probe.result.status, 0);
  const receipt = readNodeReceipt(probe.dir, ['native.test.cjs'], probe.jsonl);
  assert.equal(receipt.counts.failed, 1);
  assert.ok(receipt.failures.some(item => item.error.message.includes('native failure control')));
  const executors = { node: { ...receipt, exitCode: probe.result.status, status: 'failed', expectedFiles: ['native.test.cjs'] }, vitest: passedExecutor() };
  assert.equal(executorPairPassed(executors), false);
});
test('a native file with no cases is not a passing substitute for real execution', t => {
  const probe = nodeProbe(t, 'const unused = 1;');
  assert.equal(probe.result.status, 0);
  assert.throws(() => readNodeReceipt(probe.dir, ['native.test.cjs'], probe.jsonl), /zero-case|missing file receipts/);
});
test('missing, duplicated, truncated and altered native receipts fail closed', t => {
  const probe = nodeProbe(t, "const {test}=require('node:test');test('one',()=>{});");
  assert.throws(() => readNodeReceipt(probe.dir, ['native.test.cjs', 'not-run.test.cjs'], probe.jsonl), /missing file/);
  const events = probe.jsonl.trim().split('\n').map(line => JSON.parse(line));
  const encode = rows => rows.map(row => JSON.stringify(row)).join('\n');
  const perFile = events.find(event => event.type === 'test:summary' && event.data.file);
  assert.throws(() => readNodeReceipt(probe.dir, ['native.test.cjs'], encode([...events, perFile])), /duplicate file/);
  assert.throws(() => readNodeReceipt(probe.dir, ['native.test.cjs'], encode(events.filter(event => !(event.type === 'test:summary' && !event.data.file)))), /terminal summary/);
  const altered = structuredClone(events);
  altered.find(event => event.type === 'test:summary' && !event.data.file).data.counts.tests++;
  assert.throws(() => readNodeReceipt(probe.dir, ['native.test.cjs'], encode(altered)), /count mismatch/);
});
test('Vitest suite-level failure with zero assertions is explicitly recorded', t => {
  const dir = scratch(t), file = path.join(dir, 'empty.test.ts'); fs.writeFileSync(file, '');
  const receipt = readVitestReceipt(dir, ['empty.test.ts'], { success: false, numTotalTests: 0, numPassedTests: 0,
    numFailedTests: 0, numPendingTests: 0, numFailedTestSuites: 1,
    testResults: [{ name: file, status: 'failed', message: 'No test suite found', assertionResults: [] }] });
  assert.equal(receipt.suiteErrors.length, 1);
  assert.ok(receipt.errors.some(error => error.includes('zero assertions')));
  assert.equal(executorPairPassed({ node: passedExecutor(), vitest: { ...receipt, status: 'failed', exitCode: 1, expectedFiles: ['empty.test.ts'] } }), false);
});
test('Vitest cannot omit an excluded-by-accident file or rewrite its assertion denominator', t => {
  const dir = scratch(t), file = path.join(dir, 'one.test.ts'); fs.writeFileSync(file, '');
  const report = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
    testResults: [{ name: file, status: 'passed', assertionResults: [{ status: 'passed' }] }] };
  assert.deepEqual(readVitestReceipt(dir, ['one.test.ts'], report).errors, []);
  assert.throws(() => readVitestReceipt(dir, ['one.test.ts', 'missed.test.ts'], report), /missing file/);
  assert.ok(readVitestReceipt(dir, ['one.test.ts'], { ...report, numTotalTests: 2 }).errors.some(error => error.includes('count mismatch')));
});
test('both actual executor exits and protocol errors matter; counts retain both frameworks', () => {
  const executors = { node: passedExecutor(2), vitest: passedExecutor(3) };
  assert.equal(executorPairPassed(executors), true);
  assert.deepEqual(aggregateExecutorCounts(executors), { tests: 5, passed: 5, failed: 0, skipped: 0, files: 2, cancelled: 0, todo: 0 });
  for (const change of [{ exitCode: 1 }, { exitCode: null }, { status: 'pending' }, { errors: ['missing receipt'] }]) {
    assert.equal(executorPairPassed({ ...executors, node: { ...executors.node, ...change } }), false);
  }
});
