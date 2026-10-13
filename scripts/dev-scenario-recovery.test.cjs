const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const recovery = require('./dev-scenario-recovery.cjs');
test('content recovery detects equal-size changes, preserves empty directories and refuses links', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-recovery-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'empty')); fs.writeFileSync(path.join(dir, 'original.pdf'), 'aaaa');
    const before = recovery.fileTreeFingerprint(dir);
    fs.writeFileSync(path.join(dir, 'original.pdf'), 'bbbb');
    assert.notEqual(recovery.fileTreeFingerprint(dir).sha256, before.sha256);
    assert.ok(before.entries.some(row => row.path === 'empty' && row.type === 'directory'));
    fs.symlinkSync('/private/tmp', path.join(dir, 'link'));
    assert.throws(() => recovery.fileTreeFingerprint(dir), /RECOVERY_UNSUPPORTED_FILE/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('equal row counts cannot satisfy a changed business or original migration fingerprint', () => {
  const a = { protocolVersion: 1, identity: { name: 'panda_hub_dev' }, businessSha256: 'a', migrationsSha256: 'b',
    tables: [{ name: 'Order', rows: 1, sha256: 'c' }] };
  assert.equal(recovery.sameDatabaseContent(a, structuredClone(a)), true);
  assert.equal(recovery.sameDatabaseContent(a, { ...a, businessSha256: 'changed' }), false);
  assert.equal(recovery.sameDatabaseContent(a, { ...a, tables: [{ ...a.tables[0], sha256: 'changed' }] }), false);
  assert.equal(recovery.sameDatabaseContent(a, { ...a, migrationsSha256: 'changed' }), false);
  assert.equal(recovery.sameDatabaseContent(a, { ...a, identity: { name: 'panda_hub_empty' } }), false);
});
test('counts-only legacy proof is never qualified for clearing dev', () => {
  assert.throws(() => recovery.assertRestoreEvidence({ database: 'panda_hub_dev', restoredAndVerified: true,
    restoreRehearsal: { postgresStopped: true, restored: { orders: 0 } } }, {}), /RECOVERY_PROOF_INCOMPLETE_OR_STALE/);
});
test('a qualified original recovery cannot be replayed after its archive, files or database content changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-dev-content-recovery-test-'));
  fs.chmodSync(dir, 0o700);
  const dump = path.join(dir, 'panda_hub_dev.dump'); fs.writeFileSync(dump, 'original', { mode: 0o600 });
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const snapshot = { protocolVersion: 1, identity: { name: 'panda_hub_dev' }, businessSha256: 'business', migrationsSha256: 'migrations', tables: [] };
  const empty = hash('[]');
  const receipt = { protocolVersion: 1, database: 'panda_hub_dev', backupDir: dir, restoredAndVerified: true, postgresStopped: true,
    before: snapshot, after: snapshot, restored: snapshot, dump: { path: dump, sha256: hash('original') },
    files: { roots: [], restoreMatched: true }, privateFileManifest: { files: [], sha256: empty },
    fileRestoreProof: { sourceManifestSha256: empty, restoredManifestSha256: empty, sourceFiles: [], restoredFiles: [], restoredInsidePrivateSandbox: true } };
  try {
    assert.equal(recovery.assertRestoreEvidence(receipt, snapshot), receipt);
    assert.throws(() => recovery.assertRestoreEvidence(receipt, { ...snapshot, businessSha256: 'changed' }), /INCOMPLETE_OR_STALE/);
    assert.throws(() => recovery.assertRestoreEvidence({ ...receipt, fileRestoreProof: { ...receipt.fileRestoreProof, restoredFiles: [{ missing: true }] } }, snapshot), /INCOMPLETE_OR_STALE/);
    fs.writeFileSync(dump, 'modified');
    assert.throws(() => recovery.assertRestoreEvidence(receipt, snapshot), /RECOVERY_ARCHIVE_CHANGED/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
