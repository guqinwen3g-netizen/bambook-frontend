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
function fixture(stage: '14' | '15' = '15') {
  // Only the actual UI15 metadata shape is retained. Every secret, archive and
  // file byte below is synthetic. This does not run SQL or qualify pg_restore.
  const sandbox = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bambook-acceptance-'))); roots.push(sandbox);
  const repo = path.join(sandbox, 'repository');
  const relative = `artifacts/acceptance-20261001/execution/runs/2026-10-02T18-16-33-020Z-iNfufX/ui${stage}-private-backup.json`;
  mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true }); mkdirSync(path.join(sandbox, 'postgres'));
  const archive = path.join(sandbox, `ui${stage}-native-private.dump`), credentials = path.join(sandbox, 'ui-credentials.json');
  writeFileSync(archive, 'Filesystem-only synthetic archive, not PostgreSQL bytes');
  writeFileSync(credentials, JSON.stringify({ password: 'Acceptance-fixture-only-not-used', users: Array.from({ length: 7 }, (_, i) => ({ id: `acceptance_ui_fixture_${i}`, email: `fixture-${i}@acceptance.invalid` })) }));
  const schema = 'cc19fe672e51117e71933bdd4ac3d95c1b07e3833e3bb5789ea109eece58cd79';
  const source = { sourceHead: 'df7310b3cb565adf418bf0f1d3d40da1d16f6623', schemaSha256: schema, sandbox,
    database: { identityVerified: true, host: '127.0.0.1', port: 49811, name: 'bambook_acceptance_d79f814feafd', directory: path.join(sandbox, 'postgres') }, live: { credentialFile: credentials } };
  const privateDirectory = path.join(sandbox, 'private-files', 'development-cost-evidence'); mkdirSync(privateDirectory, { recursive: true });
  const privateFile = path.join(privateDirectory, 'original.bin'), privateBytes = Buffer.from('Original synthetic private proof'); writeFileSync(privateFile, privateBytes);
  const files = [{ relativePath: 'development-cost-evidence/original.bin', bytes: privateBytes.length, sha256: sha(privateBytes) }];
  const refundDirectory = path.join(sandbox, 'private-credit-note-refunds', 'cash-refunds'); mkdirSync(refundDirectory, { recursive: true });
  const refundFile = path.join(refundDirectory, 'original.bin'), refundBytes = Buffer.from('Original synthetic native refund proof'); writeFileSync(refundFile, refundBytes);
  const refundFiles = [{ relativePath: 'cash-refunds/original.bin', bytes: refundBytes.length, sha256: sha(refundBytes) }];
  const backup: any = { kind: `Private synthetic native UI${stage} consistent PG snapshot`, sourceHead: source.sourceHead,
    schemaSha256: schema, databaseIdentityVerified: true, privateBackupPath: archive, bytes: readFileSync(archive).length, sha256: sha(readFileSync(archive)),
    credentialSha256: sha(readFileSync(credentials)), privateFiles: files, privateFileRoots: [{ rootName: 'private-credit-note-refunds', files: refundFiles }], factsReseeded: false };
  const save = () => { writeFileSync(path.join(repo, relative), JSON.stringify(backup)); writeFileSync(path.join(repo, path.dirname(relative), 'result.json'), JSON.stringify(source));
    return { manifest: relative, manifestSha256: sha(readFileSync(path.join(repo, relative))) }; };
  return { sandbox, repo, relative, source, schema, backup, archive, credentials, privateFile, privateBytes, files, refundFile, refundBytes, refundFiles, save };
}
it('UI14 remains accepted with its original stage and all reviewed bytes', () => {
  const f = fixture('14'), restored = validatePrivateUiRestore(f.repo, f.save(), f.schema);
  expect(restored.sourceHead).toBe(f.source.sourceHead); expect(restored.archiveSha256).toBe(sha(readFileSync(f.archive)));
  expect(restored.privateFiles).toEqual(f.files); expect(restored.additionalPrivateFiles[0].files).toEqual(f.refundFiles);
});
it('UI15 accepts the exact reviewed actual-metadata-shaped filesystem contract without exposing credential contents', () => {
  const f = fixture(), restored = validatePrivateUiRestore(f.repo, f.save(), f.schema);
  expect(restored.sourceHead).toBe('df7310b3cb565adf418bf0f1d3d40da1d16f6623'); expect(restored.sourceSchemaSha256).toBe(f.schema);
  expect(restored.backupFile).toBe(f.archive); expect(restored.archiveSha256).toBe(f.backup.sha256); expect(restored.credentialSha256).toBe(sha(readFileSync(f.credentials)));
  expect(restored.privateFiles).toEqual(f.files); expect(Object.keys(restored)).not.toContain('password'); expect(JSON.stringify(restored)).not.toContain('Acceptance-fixture-only-not-used');
});
it('UI15 copies both exact proof roots privately without replacing the source or overwriting a target', () => {
  const f = fixture(), restore = validatePrivateUiRestore(f.repo, f.save(), f.schema), target = mkdtempSync(path.join(os.tmpdir(), 'bambook-acceptance-')); roots.push(target);
  expect(restorePrivateUiFiles(restore, path.join(target, 'private-files'))).toEqual(f.files);
  expect(restorePrivateUiAdditionalFiles(restore, target)).toEqual([{ rootName: 'private-credit-note-refunds', files: f.refundFiles }]);
  const copied = path.join(target, 'private-files', f.files[0].relativePath), refund = path.join(target, 'private-credit-note-refunds', f.refundFiles[0].relativePath);
  expect(readFileSync(copied)).toEqual(f.privateBytes); expect(readFileSync(refund)).toEqual(f.refundBytes);
  expect(statSync(copied).mode & 0o777).toBe(0o600); expect(statSync(refund).mode & 0o777).toBe(0o600);
  expect(readFileSync(f.privateFile)).toEqual(f.privateBytes); expect(readFileSync(f.refundFile)).toEqual(f.refundBytes);
  expect(() => restorePrivateUiFiles(restore, path.join(target, 'private-files'))).toThrow(); expect(() => restorePrivateUiAdditionalFiles(restore, target)).toThrow();
});
it('UI15 rejects a UI14 or unknown kind instead of relabeling the original source', () => {
  const f = fixture(); f.backup.kind = 'Private synthetic native UI14 consistent PG snapshot'; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('identity or source schema');
  f.backup.kind = 'Private synthetic native UI16 consistent PG snapshot'; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('identity or source schema');
});
it('UI15 rejects different source commits and unverified or shared database identities', () => {
  const f = fixture(); f.backup.sourceHead = 'a'.repeat(40); expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('identity or source schema');
  f.backup.sourceHead = f.source.sourceHead; f.source.database.identityVerified = false; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('identity or source schema');
  f.source.database.identityVerified = true; f.source.database.host = '192.0.2.1'; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('identity or source schema');
});
it('UI15 refuses archive directory or stage-name escapes even when the byte hash matches', () => {
  const f = fixture(), elsewhere = path.join(f.sandbox, 'elsewhere'); mkdirSync(elsewhere);
  const escaped = path.join(elsewhere, 'ui15-native-private.dump'); writeFileSync(escaped, readFileSync(f.archive)); f.backup.privateBackupPath = escaped;
  expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('escaped');
  const wrongStage = path.join(f.sandbox, 'ui14-native-private.dump'); writeFileSync(wrongStage, readFileSync(f.archive)); f.backup.privateBackupPath = wrongStage;
  expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('escaped');
});
it('UI15 refuses credential path escapes and non-synthetic seven-account substitutes', () => {
  const f = fixture(), elsewhere = path.join(f.sandbox, 'elsewhere'); mkdirSync(elsewhere);
  f.source.live.credentialFile = path.join(elsewhere, 'ui-credentials.json'); writeFileSync(f.source.live.credentialFile, readFileSync(f.credentials));
  expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('escaped');
  f.source.live.credentialFile = f.credentials; writeFileSync(f.credentials, JSON.stringify({ password: 'not-private-synthetic', users: [] }));
  expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('not the synthetic');
});
it('UI15 refuses a reviewed manifest hash mismatch and later archive byte drift', () => {
  const f = fixture(), contract = f.save(); expect(() => validatePrivateUiRestore(f.repo, { ...contract, manifestSha256: '0'.repeat(64) }, f.schema)).toThrow('manifest changed');
  writeFileSync(f.archive, 'Changed synthetic archive'); expect(() => validatePrivateUiRestore(f.repo, contract, f.schema)).toThrow('archive changed');
});
it('UI15 requires explicit refund-root review including an empty inventory declaration', () => {
  const f = fixture(); delete f.backup.privateFileRoots; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('roots were not reviewed');
  f.backup.privateFileRoots = []; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('inventory was omitted');
  f.backup.privateFileRoots = [{ rootName: 'private-credit-note-refunds', files: [] }]; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('inventory or hashes');
});
it('UI15 refuses missing private proof inventory and arbitrary additional root names', () => {
  const f = fixture(); delete f.backup.privateFiles; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('inventory');
  f.backup.privateFiles = f.files; f.backup.privateFileRoots = [{ rootName: '../elsewhere', files: f.refundFiles }];
  expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('Invalid reviewed additional');
});
it('UI15 rejects proof byte changes before validation and after the restore receipt was read', () => {
  const f = fixture(), restore = validatePrivateUiRestore(f.repo, f.save(), f.schema); writeFileSync(f.refundFile, 'Changed refund proof');
  expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('inventory or hashes');
  expect(() => restorePrivateUiAdditionalFiles(restore, f.sandbox)).toThrow('changed during restore');
});
it('UI15 requires the exact source schema and does not repair a restored schema', () => {
  const f = fixture(); expect(() => validatePrivateUiRestore(f.repo, f.save(), 'f'.repeat(64))).toThrow('identity or source schema');
});
it('UI15 does not admit arbitrary next stages or missing unreviewed manifests', () => {
  const f = fixture(), contract = f.save(); expect(() => validatePrivateUiRestore(f.repo, { ...contract, manifest: contract.manifest.replace('ui15', 'ui16') }, f.schema)).toThrow('Invalid reviewed');
  const missing = { ...contract, manifest: contract.manifest.replace('/2026-10-02T18-16-33-020Z-iNfufX/', '/UNREVIEWED-MISSING/') };
  expect(() => validatePrivateUiRestore(f.repo, missing, f.schema)).toThrow('Invalid reviewed');
});

it('UI15 binds original credential bytes to the sealed manifest even if replacement retains seven synthetic accounts', () => {
  const f = fixture(), contract = f.save(), credentials = JSON.parse(readFileSync(f.credentials, 'utf8'));
  credentials.password = 'Acceptance-replacement-still-synthetic'; writeFileSync(f.credentials, JSON.stringify(credentials));
  expect(() => validatePrivateUiRestore(f.repo, contract, f.schema)).toThrow('credential bytes changed');
  f.backup.credentialSha256 = sha(readFileSync(f.credentials)); expect(validatePrivateUiRestore(f.repo, f.save(), f.schema).credentialSha256).toBe(f.backup.credentialSha256);
  delete f.backup.credentialSha256; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('credential bytes changed');
});
