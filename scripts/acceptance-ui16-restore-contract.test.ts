import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
const { validatePrivateUiRestore, restorePrivateUiFiles, restorePrivateUiAdditionalFiles } = createRequire(import.meta.url)('./acceptance-ui-restore-contract.cjs');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  // Filesystem controls over the actual UI16 metadata shape; not SQL/pg_restore proof.
  const sandbox = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bambook-acceptance-'))); roots.push(sandbox);
  const repo = path.join(sandbox, 'repository');
  const relative = 'artifacts/acceptance-20261001/execution/runs/2026-10-02T19-46-02-436Z-hpRVky/ui16-private-backup.json';
  mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true }); mkdirSync(path.join(sandbox, 'postgres'));
  const archive = path.join(sandbox, 'ui16-native-private.dump'), credentials = path.join(sandbox, 'ui-credentials.json');
  writeFileSync(archive, 'Filesystem-only synthetic archive; not native PostgreSQL bytes');
  writeFileSync(credentials, JSON.stringify({ password: 'Acceptance-ui16-filesystem-fixture', users: Array.from({ length: 7 }, (_, i) => ({ id: `acceptance_ui_fixture_${i}`, email: `fixture-${i}@acceptance.invalid` })) }));
  const schema = 'cc19fe672e51117e71933bdd4ac3d95c1b07e3833e3bb5789ea109eece58cd79';
  const source = { sourceHead: '6a796fa9da5033618aa9bba874da58778cdf3898', schemaSha256: schema, sandbox,
    database: { identityVerified: true, host: '127.0.0.1', port: 50338, name: 'bambook_acceptance_c3b391d80dea', directory: path.join(sandbox, 'postgres') }, live: { credentialFile: credentials } };
  const privateFile = path.join(sandbox, 'private-files', 'development-cost-evidence', 'original.bin'); mkdirSync(path.dirname(privateFile), { recursive: true });
  const proof = Buffer.from('Original UI16 synthetic private evidence'); writeFileSync(privateFile, proof);
  const files = [{ relativePath: 'development-cost-evidence/original.bin', bytes: proof.length, sha256: sha(proof) }];
  const refundFile = path.join(sandbox, 'private-credit-note-refunds', 'cash-refunds', 'original.bin'); mkdirSync(path.dirname(refundFile), { recursive: true });
  const refund = Buffer.from('Original UI16 synthetic refund evidence'); writeFileSync(refundFile, refund);
  const refundFiles = [{ relativePath: 'cash-refunds/original.bin', bytes: refund.length, sha256: sha(refund) }];
  const backup: any = { kind: 'Private synthetic native UI16 consistent PG snapshot', sourceHead: source.sourceHead, schemaSha256: schema,
    databaseIdentityVerified: true, privateBackupPath: archive, bytes: readFileSync(archive).length, sha256: sha(readFileSync(archive)),
    credentialSha256: sha(readFileSync(credentials)), privateFiles: files, privateFileRoots: [{ rootName: 'private-credit-note-refunds', files: refundFiles }], factsReseeded: false };
  const save = () => { writeFileSync(path.join(repo, relative), JSON.stringify(backup)); writeFileSync(path.join(repo, path.dirname(relative), 'result.json'), JSON.stringify(source));
    return { manifest: relative, manifestSha256: sha(readFileSync(path.join(repo, relative))) }; };
  return { sandbox, repo, relative, source, schema, backup, archive, credentials, privateFile, proof, files, refundFile, refund, refundFiles, save };
}
it('UI16 accepts only its reviewed source/schema/archive and both original proof roots without returning credential contents', () => {
  const f = fixture(), restored = validatePrivateUiRestore(f.repo, f.save(), f.schema);
  expect(restored.sourceHead).toBe(f.source.sourceHead); expect(restored.archiveSha256).toBe(sha(readFileSync(f.archive)));
  expect(restored.privateFiles).toEqual(f.files); expect(restored.additionalPrivateFiles[0].files).toEqual(f.refundFiles);
  expect(restored.credentialSha256).toBe(sha(readFileSync(f.credentials))); expect(JSON.stringify(restored)).not.toContain('Acceptance-ui16-filesystem-fixture');
});
it('UI16 copies exact private/refund bytes with private modes, preserves sources and refuses target overwrite', () => {
  const f = fixture(), restore = validatePrivateUiRestore(f.repo, f.save(), f.schema), target = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bambook-acceptance-'))); roots.push(target);
  expect(restorePrivateUiFiles(restore, path.join(target, 'private-files'))).toEqual(f.files);
  expect(restorePrivateUiAdditionalFiles(restore, target)).toEqual([{ rootName: 'private-credit-note-refunds', files: f.refundFiles }]);
  const copied = path.join(target, 'private-files', f.files[0].relativePath), refund = path.join(target, 'private-credit-note-refunds', f.refundFiles[0].relativePath);
  expect(readFileSync(copied)).toEqual(f.proof); expect(readFileSync(refund)).toEqual(f.refund); expect(readFileSync(f.privateFile)).toEqual(f.proof);
  expect(statSync(copied).mode & 0o777).toBe(0o600); expect(statSync(refund).mode & 0o777).toBe(0o600);
  expect(() => restorePrivateUiFiles(restore, path.join(target, 'private-files'))).toThrow(); expect(() => restorePrivateUiAdditionalFiles(restore, target)).toThrow();
});
it('UI16 admits neither arbitrary UI17 nor an absent renamed or missing manifest', () => {
  const f = fixture(), c = f.save();
  expect(() => validatePrivateUiRestore(f.repo, { ...c, manifest: c.manifest.replace('ui16', 'ui17') }, f.schema)).toThrow('Invalid reviewed');
  expect(() => validatePrivateUiRestore(f.repo, { ...c, manifest: c.manifest.replace('/2026-10-02T19-46-02-436Z-hpRVky/', '/MISSING-UNREVIEWED/') }, f.schema)).toThrow('Invalid reviewed');
});
it('UI16 refuses a relabeled UI15 kind and stage-named archive escapes even with exact byte hashes', () => {
  const f = fixture(); f.backup.kind = 'Private synthetic native UI15 consistent PG snapshot'; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('identity or source schema');
  f.backup.kind = 'Private synthetic native UI16 consistent PG snapshot'; const other = path.join(f.sandbox, 'ui15-native-private.dump'); writeFileSync(other, readFileSync(f.archive)); f.backup.privateBackupPath = other;
  expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('escaped');
});
it('UI16 rejects source-head/schema/physical-identity mismatches rather than silently repairing the source', () => {
  const f = fixture(); expect(() => validatePrivateUiRestore(f.repo, f.save(), 'f'.repeat(64))).toThrow('identity or source schema');
  f.backup.sourceHead = 'a'.repeat(40); expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('identity or source schema');
  f.backup.sourceHead = f.source.sourceHead; f.source.database.identityVerified = false; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('identity or source schema');
});
it('UI16 requires credential byte binding even if replacement retains the seven synthetic-account shape', () => {
  const f = fixture(), c = f.save(), credential = JSON.parse(readFileSync(f.credentials, 'utf8'));
  credential.password = 'Acceptance-ui16-different-synthetic-password'; writeFileSync(f.credentials, JSON.stringify(credential));
  expect(() => validatePrivateUiRestore(f.repo, c, f.schema)).toThrow('credential bytes changed');
  f.backup.credentialSha256 = sha(readFileSync(f.credentials)); expect(validatePrivateUiRestore(f.repo, f.save(), f.schema).credentialSha256).toBe(f.backup.credentialSha256);
  delete f.backup.credentialSha256; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('credential bytes changed');
});
it('UI16 requires explicit original refund root inventory and rejects changes before and after validation', () => {
  const f = fixture(); delete f.backup.privateFileRoots; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('roots were not reviewed');
  f.backup.privateFileRoots = [{ rootName: 'private-credit-note-refunds', files: f.refundFiles }]; const restore = validatePrivateUiRestore(f.repo, f.save(), f.schema);
  writeFileSync(f.refundFile, 'Changed refund bytes'); expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('inventory or hashes');
  expect(() => restorePrivateUiAdditionalFiles(restore, f.sandbox)).toThrow('changed during restore');
});
it('UI16 detects later manifest and native archive byte drift independently', () => {
  const f = fixture(), c = f.save(); expect(() => validatePrivateUiRestore(f.repo, { ...c, manifestSha256: '0'.repeat(64) }, f.schema)).toThrow('manifest changed');
  writeFileSync(f.archive, 'Changed synthetic archive'); expect(() => validatePrivateUiRestore(f.repo, c, f.schema)).toThrow('archive changed');
});
