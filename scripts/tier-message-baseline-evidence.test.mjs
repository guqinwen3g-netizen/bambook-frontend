import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { verifyTierMessageBaselineEvidence } from './lib/tierMessageBaselineEvidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const make = () => {
  const sourceHead = 'a'.repeat(40), accounting = { total: 2, 'public-message': 1, 'typed-contract': 0, internal: 0, unresolved: 1 };
  const literal = { file: 'src/probe.ts', line: 1, message: '来源不存在', kind: 'public-message' };
  const inventory = { sourceHead, measurement: 'ast-bound-error-sources-v1', accounting, keywordCount: 1,
    literals: [{ ...literal, tier: 404 }], report: { inventory: [literal, { file: 'src/probe.ts', line: 2, kind: 'unresolved', reason: 'dynamic-or-missing-message' }], publicLiterals: [literal] } };
  const bytes = gzipSync(JSON.stringify(inventory));
  const baseline = { count: 1, byTier: { 404: 1 }, sourceInventory: { ...accounting }, measurement: inventory.measurement,
    _sourceEvidence: { sourceHead, sourceInventory: 'synthetic.json.gz', sourceInventorySha256: createHash('sha256').update(bytes).digest('hex') } };
  return { bytes, baseline };
};
test('reviewed live baseline is bound to the retained immutable source archive', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'scripts/baselines/tier-message-snapshot.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(root, baseline._sourceEvidence.sourceInventory));
  const result = verifyTierMessageBaselineEvidence(baseline, bytes);
  assert.ok(result.count > 150); assert.ok(result.accounting.unresolved > 0);
});
test('baseline cannot silently promote unresolved source into a typed or public bucket', () => {
  const { bytes, baseline } = make();
  verifyTierMessageBaselineEvidence(baseline, bytes);
  baseline.sourceInventory.unresolved = 0; baseline.sourceInventory['typed-contract'] = 1;
  assert.throws(() => verifyTierMessageBaselineEvidence(baseline, bytes), /source accounting/);
});
test('new literal and changed keyword tier cannot be hidden by refreezing count alone', () => {
  for (const mutate of [base => base.count++, base => { base.byTier = { 400: 1 }; }]) {
    const { bytes, baseline } = make(); mutate(baseline);
    assert.throws(() => verifyTierMessageBaselineEvidence(baseline, bytes), /literal count|keyword bucket/);
  }
});
test('different bytes, fixed source and absent external provenance fail closed', () => {
  const { bytes, baseline } = make();
  assert.throws(() => verifyTierMessageBaselineEvidence(baseline, Buffer.concat([bytes, Buffer.from('x')])), /archive checksum/);
  assert.throws(() => verifyTierMessageBaselineEvidence({ ...baseline, _sourceEvidence: { ...baseline._sourceEvidence, sourceHead: 'b'.repeat(40) } }, bytes), /fixed source/);
  assert.throws(() => verifyTierMessageBaselineEvidence({ ...baseline, _sourceEvidence: undefined }, bytes), /missing reviewed source/);
});
