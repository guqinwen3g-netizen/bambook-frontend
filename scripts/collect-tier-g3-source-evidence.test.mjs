import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRows, g3Key, inventoryKey, collect } from './collect-tier-g3-source-evidence.mjs';

test('duplicate producer entries remain counted when only one duplicate disappears', () => {
  const before = [{ file: 'a', expression: 'throw error', line: 1 }, { file: 'a', expression: 'throw error', line: 2 }];
  const after = [{ ...before[0], line: 7 }], result = compareRows(before, after, inventoryKey);
  assert.equal(result.removed.length, 1); assert.equal(result.added.length, 0); assert.equal(result.moved.length, 1);
  assert.equal(result.unchanged.length + result.removed.length, before.length);
});
test('line-only drift is not new debt, but a changed classification or expression remains explicit', () => {
  const row = { file: 'a', shape: 'nullish', matched: '?? 0', cls: 'L-A', rule: 'E2', sourceLine: '  amount ?? 0', line: 1 };
  const drift = compareRows([row], [{ ...row, line: 100 }], g3Key);
  assert.equal(drift.added.length, 0); assert.equal(drift.removed.length, 0); assert.equal(drift.moved.length, 1);
  for (const changed of [{ ...row, cls: '待核实' }, { ...row, sourceLine: 'price ?? 0' }]) {
    const delta = compareRows([row], [changed], g3Key);
    assert.equal(delta.added.length, 1); assert.equal(delta.removed.length, 1);
  }
});
test('unproved source cannot be silently equated to a typed producer', () => {
  const prior = { file: 'a', expression: 'throw err', kind: 'unresolved', reason: 'dynamic-or-missing-message' };
  const next = { ...prior, kind: 'typed-contract', contract: 'typed' };
  assert.notEqual(inventoryKey(prior), inventoryKey(next));
  const delta = compareRows([prior], [next], inventoryKey);
  assert.deepEqual(delta.added, [next]); assert.deepEqual(delta.removed, [prior]);
});
test('collector rejects moving refs and malformed heads before extracting or writing evidence', async () => {
  for (const head of [undefined, 'HEAD', 'main', '097e0d0e', '../source', 'a'.repeat(39)]) await assert.rejects(collect(head), /exact 40-character/);
});
