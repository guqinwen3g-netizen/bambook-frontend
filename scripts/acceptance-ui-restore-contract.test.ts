import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,symlinkSync,statSync,realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
const { validatePrivateUiRestore, validatePrivateUiUpgrade,restorePrivateUiFiles,restorePrivateUiAdditionalFiles } = createRequire(import.meta.url)('./acceptance-ui-restore-contract.cjs');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(stage: '04' | '07' | '08' | '09' | '10' | '12' | '13' | '14' = '04') {
  // Filesystem/identity-contract substitute only. No DB restore or approved
  // business fact is created by this unit test; native pg_restore is separate.
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'bambook-acceptance-')); roots.push(sandbox);
  const repo = path.join(sandbox, 'repository'), relative = `artifacts/acceptance-20261001/execution/runs/TEST-RESTORE/ui${stage}-private-backup.json`;
  mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true }); mkdirSync(path.join(sandbox, 'postgres'));
  const archive = path.join(sandbox, `ui${stage}-native-private.dump`), credentials = path.join(sandbox, 'ui-credentials.json');
  writeFileSync(archive, 'Synthetic archive bytes; not a PostgreSQL backup');
  writeFileSync(credentials, JSON.stringify({ password: 'Acceptance-synthetic-not-used', users: Array.from({ length: 7 }, (_, i) => ({ id: `acceptance_ui_${i}`, email: `${i}@acceptance.invalid` })) }));
  const schema = 'a'.repeat(64), source = { sourceHead: 'b'.repeat(40), schemaSha256: schema, sandbox,
    database: { identityVerified: true, host: '127.0.0.1', name: 'bambook_acceptance_abcdef123456', directory: path.join(sandbox, 'postgres') }, live: { credentialFile: credentials } };
  const backup = { kind: `Private synthetic native UI${stage} consistent PG snapshot`, sourceHead: source.sourceHead,
    databaseIdentityVerified: true, ...(['10','12','13','14'].includes(stage)?{privateFileRoots:[]}:{}), privateBackupPath: archive, sha256: hash(readFileSync(archive)), bytes: readFileSync(archive).length };
  const save = () => { writeFileSync(path.join(repo, relative), JSON.stringify(backup)); writeFileSync(path.join(repo, path.dirname(relative), 'result.json'), JSON.stringify(source));
    return { manifest: relative, manifestSha256: hash(readFileSync(path.join(repo, relative))) }; };
  return { repo, sandbox, schema, source, backup, save, archive, credentials };
}
it('accepts only the exact synthetic archive, source schema and private credentials contract', () => {
  const f = fixture(); const result = validatePrivateUiRestore(f.repo, f.save(), f.schema);
  expect(result.sourceHead).toBe('b'.repeat(40)); expect(result.archiveSha256).toBe(hash(readFileSync(f.archive)));
  expect(Object.keys(result)).not.toContain('password');
});
it('accepts the reviewed UI07 continuation without allowing stage-kind/archive mismatch or arbitrary stages', () => {
  const f = fixture('07'); expect(validatePrivateUiRestore(f.repo, f.save(), f.schema).archiveSha256).toBe(hash(readFileSync(f.archive)));
  f.backup.kind = 'Private synthetic native UI04 consistent PG snapshot'; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('identity or source schema');
  f.backup.kind = 'Private synthetic native UI07 consistent PG snapshot'; const wrong = path.join(f.sandbox, 'ui04-native-private.dump'); writeFileSync(wrong, readFileSync(f.archive)); f.backup.privateBackupPath = wrong; expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('escaped');
  const contract = f.save(); expect(() => validatePrivateUiRestore(f.repo, { ...contract, manifest: contract.manifest.replace('ui07', 'ui99') }, f.schema)).toThrow('Invalid reviewed');
});
it('rejects changed archive bytes after manifest review', () => {
  const f = fixture(), contract = f.save(); writeFileSync(f.archive, 'Changed bytes');
  expect(() => validatePrivateUiRestore(f.repo, contract, f.schema)).toThrow('archive changed');
});
it('rejects changed manifest and arbitrary backup metadata paths', () => {
  const f = fixture(), contract = f.save(); writeFileSync(path.join(f.repo, contract.manifest), '{}');
  expect(() => validatePrivateUiRestore(f.repo, contract, f.schema)).toThrow('manifest changed');
  expect(() => validatePrivateUiRestore(f.repo, { ...contract, manifest: '../shared-backup.json' }, f.schema)).toThrow('Invalid reviewed');
});
it('rejects a source pretending to be a shared cluster or a different source commit', () => {
  const f = fixture(); f.source.database.identityVerified = false;
  expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('identity or source schema');
  f.source.database.identityVerified = true; f.backup.sourceHead = 'c'.repeat(40);
  expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('identity or source schema');
});
it('rejects unreviewed schema drift rather than repair the restored schema with db push', () => {
  const f = fixture(); expect(() => validatePrivateUiRestore(f.repo, f.save(), 'd'.repeat(64))).toThrow('identity or source schema');
});
it('rejects archive/credential escape even with a matching reviewed archive hash', () => {
  const f = fixture(); mkdirSync(path.join(f.sandbox, 'elsewhere'));
  const outside = path.join(f.sandbox, 'elsewhere', 'ui04-native-private.dump'); writeFileSync(outside, readFileSync(f.archive)); f.backup.privateBackupPath = outside;
  expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('escaped');
  f.backup.privateBackupPath = f.archive; f.source.live.credentialFile = path.join(f.sandbox, 'elsewhere', 'ui-credentials.json');
  writeFileSync(f.source.live.credentialFile, readFileSync(f.credentials));
  expect(() => validatePrivateUiRestore(f.repo, f.save(), f.schema)).toThrow('escaped');
});
it('rejects non-synthetic identities rather than import their credentials', () => {
  const f = fixture(); const contract = f.save(); writeFileSync(f.credentials, JSON.stringify({ password: 'a-real-password', users: [] }));
  expect(() => validatePrivateUiRestore(f.repo, contract, f.schema)).toThrow('not the synthetic');
});
it('populated upgrade validates the real old schema and exact old commit before distinct reviewed migration', () => {
  const f = fixture(), contract = f.save();
  expect(validatePrivateUiUpgrade(f.repo, contract, f.source.sourceHead, f.schema, 'd'.repeat(64)).sourceHead).toBe(f.source.sourceHead);
  expect(() => validatePrivateUiUpgrade(f.repo, contract, 'c'.repeat(40), f.schema, 'd'.repeat(64))).toThrow('differs');
  expect(() => validatePrivateUiUpgrade(f.repo, contract, f.source.sourceHead, 'e'.repeat(64), 'd'.repeat(64))).toThrow('source schema');
  expect(() => validatePrivateUiUpgrade(f.repo, contract, f.source.sourceHead, f.schema, f.schema)).toThrow('distinct');
  writeFileSync(f.archive, 'Changed populated archive');
  expect(() => validatePrivateUiUpgrade(f.repo, contract, f.source.sourceHead, f.schema, 'd'.repeat(64))).toThrow('archive changed');
});

it('preserves reviewed binary cost evidence, rejects omission/content drift and never overwrites an existing file',()=>{
 const f=fixture(),directory=path.join(f.sandbox,'private-files','development-cost-evidence');mkdirSync(directory,{recursive:true});
 const file=path.join(directory,'synthetic.pdf'),bytes=Buffer.from('%PDF-1.4\nSynthetic binary evidence\n');writeFileSync(file,bytes);
 expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('inventory');
 (f.backup as any).privateFiles=[{relativePath:'development-cost-evidence/synthetic.pdf',bytes:bytes.length,sha256:hash(bytes)}];
 const restored=validatePrivateUiRestore(f.repo,f.save(),f.schema),target=path.join(f.sandbox,'restored-private-files');mkdirSync(target);
 expect(restorePrivateUiFiles(restored,target)).toEqual((f.backup as any).privateFiles);
 expect(readFileSync(path.join(target,'development-cost-evidence/synthetic.pdf'))).toEqual(bytes);expect(statSync(path.join(target,'development-cost-evidence/synthetic.pdf')).mode&0o777).toBe(0o600);
 expect(()=>restorePrivateUiFiles(restored,target)).toThrow();
 writeFileSync(file,'Changed bytes');expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('inventory');expect(()=>restorePrivateUiFiles(restored,path.join(f.sandbox,'another-target'))).toThrow('changed during restore');
});
it('rejects evidence symlink escape even if the target has reviewed matching bytes',()=>{
 const f=fixture(),directory=path.join(f.sandbox,'private-files');mkdirSync(directory);
 symlinkSync(f.archive,path.join(directory,'pretend.pdf'));
 (f.backup as any).privateFiles=[{relativePath:'pretend.pdf',bytes:readFileSync(f.archive).length,sha256:hash(readFileSync(f.archive))}];
 expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('symlink');
});

it('UI08 continuation retains original facts only with matching stage, schema, archive and hashed files',()=>{
 const f=fixture('08');expect(validatePrivateUiRestore(f.repo,f.save(),f.schema).sourceHead).toBe(f.source.sourceHead);
 f.backup.kind='Private synthetic native UI07 consistent PG snapshot';expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('identity or source schema');
 f.backup.kind='Private synthetic native UI08 consistent PG snapshot';f.source.schemaSha256='c'.repeat(64);expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('identity or source schema');
 f.source.schemaSha256=f.schema;f.backup.sha256='d'.repeat(64);expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('archive changed');
});

it('UI09 populated continuation requires the exact old source, stage, archive, credential and evidence bytes',()=>{
 const f=fixture('09'),directory=path.join(f.sandbox,'private-files','development-cost-evidence');mkdirSync(directory,{recursive:true});
 const file=path.join(directory,'original.bin'),bytes=Buffer.from('Original private synthetic proof bytes');writeFileSync(file,bytes);
 (f.backup as any).privateFiles=[{relativePath:'development-cost-evidence/original.bin',bytes:bytes.length,sha256:hash(bytes)}];
 const contract=f.save(),result=validatePrivateUiUpgrade(f.repo,contract,f.source.sourceHead,f.schema,'d'.repeat(64));
 expect(result.archiveSha256).toBe(hash(readFileSync(f.archive)));expect(result.credentialSha256).toBe(hash(readFileSync(f.credentials)));
 expect(result.privateFiles).toEqual((f.backup as any).privateFiles);
 const invalid={...contract,manifest:contract.manifest.replace('ui09','ui99')};
 expect(()=>validatePrivateUiRestore(f.repo,invalid,f.schema)).toThrow('Invalid reviewed');
 f.backup.kind='Private synthetic native UI08 consistent PG snapshot';expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('identity or source schema');
 f.backup.kind='Private synthetic native UI09 consistent PG snapshot';f.backup.sha256='e'.repeat(64);expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('archive changed');
 f.backup.sha256=hash(readFileSync(f.archive));writeFileSync(f.credentials,JSON.stringify({password:'Acceptance-invalid',users:[]}));
 expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('not the synthetic');
});

function refundEvidenceFixture(stage: '10' | '12' | '13' | '14' = '10'){
 const f=fixture(stage),directory=path.join(f.sandbox,'private-credit-note-refunds','cash-refunds');mkdirSync(directory,{recursive:true});
 const bytes=Buffer.from('%PDF-1.4\nOriginal synthetic paid/return proof\n'),file=path.join(directory,'original-proof.bin');writeFileSync(file,bytes);
 const files=[{relativePath:'cash-refunds/original-proof.bin',bytes:bytes.length,sha256:hash(bytes)}];
 (f.backup as any).privateFileRoots=[{rootName:'private-credit-note-refunds',files}];
 return {...f,file,bytes,files};
}
it('UI10 separately restores exact refund proof bytes beside the general private root without overwriting originals',()=>{
 const f=refundEvidenceFixture(),restore=validatePrivateUiRestore(f.repo,f.save(),f.schema),target=mkdtempSync(path.join(os.tmpdir(),'bambook-acceptance-'));roots.push(target);
 const receipts=restorePrivateUiAdditionalFiles(restore,target);expect(receipts).toEqual([{rootName:'private-credit-note-refunds',files:f.files}]);
 const copied=path.join(target,'private-credit-note-refunds','cash-refunds/original-proof.bin');expect(readFileSync(copied)).toEqual(f.bytes);expect(statSync(copied).mode&0o777).toBe(0o600);
 expect(()=>restorePrivateUiAdditionalFiles(restore,target)).toThrow();expect(readFileSync(copied)).toEqual(f.bytes);
});
it('UI10 rejects omitted refund roots and omitted actual refund proof inventory',()=>{
 const f=refundEvidenceFixture();delete (f.backup as any).privateFileRoots;expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('roots were not reviewed');
 (f.backup as any).privateFileRoots=[];expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('inventory was omitted');
 (f.backup as any).privateFileRoots=[{rootName:'private-credit-note-refunds',files:[]}];expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('inventory or hashes');
});
it('UI10 rejects refund byte changes both before and after metadata review',()=>{
 const f=refundEvidenceFixture(),restore=validatePrivateUiRestore(f.repo,f.save(),f.schema);writeFileSync(f.file,'Changed original proof');
 expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('inventory or hashes');
 expect(()=>restorePrivateUiAdditionalFiles(restore,f.sandbox)).toThrow('changed during restore');
});
it('UI10 cannot restore arbitrary private root paths or refund source symlinks',()=>{
 const f=refundEvidenceFixture();(f.backup as any).privateFileRoots=[{rootName:'../escaped',files:f.files}];expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('Invalid reviewed additional');
 (f.backup as any).privateFileRoots=[{rootName:'private-credit-note-refunds',files:f.files}];symlinkSync(f.archive,path.join(f.sandbox,'private-credit-note-refunds','pretend.bin'));expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('symlink');
});
it('UI10 refund recovery rejects a target symlink rather than write outside the new sandbox',()=>{
 const f=refundEvidenceFixture(),restore=validatePrivateUiRestore(f.repo,f.save(),f.schema),target=mkdtempSync(path.join(os.tmpdir(),'bambook-acceptance-'));roots.push(target);
 symlinkSync(path.join(f.sandbox,'private-credit-note-refunds'),path.join(target,'private-credit-note-refunds'));expect(()=>restorePrivateUiAdditionalFiles(restore,target)).toThrow('target symlink');expect(readFileSync(f.file)).toEqual(f.bytes);
});

it('UI10 refund recovery refuses a nested target symlink before writing any proof outside its root',()=>{
 const f=refundEvidenceFixture(),restore=validatePrivateUiRestore(f.repo,f.save(),f.schema),target=mkdtempSync(path.join(os.tmpdir(),'bambook-acceptance-'));roots.push(target);
 const outside=path.join(target,'outside');mkdirSync(outside);const destination=path.join(target,'private-credit-note-refunds');mkdirSync(destination);symlinkSync(outside,path.join(destination,'cash-refunds'));
 expect(()=>restorePrivateUiAdditionalFiles(restore,target)).toThrow('parent escaped');expect(()=>readFileSync(path.join(outside,'original-proof.bin'))).toThrow();
});


it('UI12 restores reviewed PDF and refund bytes into a fresh same-schema sandbox and preserves the original snapshot',()=>{
 const f=refundEvidenceFixture('12'),directory=path.join(f.sandbox,'private-files','development-cost-evidence');mkdirSync(directory,{recursive:true});
 const pdf=Buffer.from('%PDF-1.4\nOriginal UI12 synthetic native cost proof\n'),file=path.join(directory,'original-ui12.pdf');writeFileSync(file,pdf);
 const files=[{relativePath:'development-cost-evidence/original-ui12.pdf',bytes:pdf.length,sha256:hash(pdf)}];(f.backup as any).privateFiles=files;
 const contract=f.save(),restore=validatePrivateUiRestore(f.repo,contract,f.schema),target=mkdtempSync(path.join(os.tmpdir(),'bambook-acceptance-'));roots.push(target);
 expect(contract.manifest).toMatch(/\/ui12-private-backup\.json$/);expect(restore.backupFile).toBe(realpathSync(f.archive));expect(path.basename(restore.backupFile)).toBe('ui12-native-private.dump');
 expect(restore.sourceHead).toBe(f.source.sourceHead);expect(restore.sourceSchemaSha256).toBe(f.schema);expect(restore.archiveSha256).toBe(hash(readFileSync(f.archive)));expect(restore.credentialSha256).toBe(hash(readFileSync(f.credentials)));expect(Object.keys(restore)).not.toContain('password');
 expect(target).not.toBe(f.sandbox);expect(restorePrivateUiFiles(restore,path.join(target,'private-files'))).toEqual(files);
 expect(restorePrivateUiAdditionalFiles(restore,target)).toEqual([{rootName:'private-credit-note-refunds',files:f.files}]);
 const copiedPdf=path.join(target,'private-files',files[0].relativePath),copiedRefund=path.join(target,'private-credit-note-refunds',f.files[0].relativePath);
 expect(readFileSync(copiedPdf)).toEqual(pdf);expect(readFileSync(copiedRefund)).toEqual(f.bytes);expect(hash(readFileSync(copiedPdf))).toBe(files[0].sha256);expect(hash(readFileSync(copiedRefund))).toBe(f.files[0].sha256);
 expect(statSync(copiedPdf).mode&0o777).toBe(0o600);expect(statSync(copiedRefund).mode&0o777).toBe(0o600);expect(readFileSync(file)).toEqual(pdf);expect(readFileSync(f.file)).toEqual(f.bytes);
 expect(()=>restorePrivateUiFiles(restore,path.join(target,'private-files'))).toThrow();expect(()=>restorePrivateUiAdditionalFiles(restore,target)).toThrow();expect(readFileSync(copiedPdf)).toEqual(pdf);expect(readFileSync(copiedRefund)).toEqual(f.bytes);
 f.backup.kind='Private synthetic native UI10 consistent PG snapshot';expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('identity or source schema');
 f.backup.kind='Private synthetic native UI12 consistent PG snapshot';const wrong=path.join(f.sandbox,'ui10-native-private.dump');writeFileSync(wrong,readFileSync(f.archive));f.backup.privateBackupPath=wrong;expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('escaped');
});
it('UI12 requires an explicit refund root review even for empty source roots and rejects omitted proof inventories',()=>{
 const empty=fixture('12');delete (empty.backup as any).privateFileRoots;expect(()=>validatePrivateUiRestore(empty.repo,empty.save(),empty.schema)).toThrow('roots were not reviewed');
 const f=refundEvidenceFixture('12');delete (f.backup as any).privateFileRoots;expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('roots were not reviewed');
 (f.backup as any).privateFileRoots=[];expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('inventory was omitted');
 (f.backup as any).privateFileRoots=[{rootName:'private-credit-note-refunds',files:[]}];expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('inventory or hashes');
});
it('UI12 refuses tampered refund bytes or roots before validation and before restoration',()=>{
 const f=refundEvidenceFixture('12'),restore=validatePrivateUiRestore(f.repo,f.save(),f.schema);writeFileSync(f.file,'Tampered original UI12 refund proof');
 expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('inventory or hashes');expect(()=>restorePrivateUiAdditionalFiles(restore,f.sandbox)).toThrow('changed during restore');
 const wrong=refundEvidenceFixture('12');(wrong.backup as any).privateFileRoots=[{rootName:'../escaped',files:wrong.files}];expect(()=>validatePrivateUiRestore(wrong.repo,wrong.save(),wrong.schema)).toThrow('Invalid reviewed additional');
 (wrong.backup as any).privateFileRoots=[{rootName:'private-credit-note-refunds',files:[{...wrong.files[0],sha256:'c'.repeat(64)}]}];expect(()=>validatePrivateUiRestore(wrong.repo,wrong.save(),wrong.schema)).toThrow('inventory or hashes');
});

it('UI13 continuation restores only the exact reviewed same-schema private archive and proof bytes, retaining original source', () => {
 const f=refundEvidenceFixture('13'),contract=f.save(),restore=validatePrivateUiRestore(f.repo,contract,f.schema),target=mkdtempSync(path.join(os.tmpdir(),'bambook-acceptance-'));roots.push(target);
 expect(restore.sourceHead).toBe(f.source.sourceHead);expect(restore.archiveSha256).toBe(hash(readFileSync(f.archive)));expect(restore.credentialSha256).toBe(hash(readFileSync(f.credentials)));
 expect(restorePrivateUiAdditionalFiles(restore,target)).toEqual([{rootName:'private-credit-note-refunds',files:f.files}]);
 expect(readFileSync(path.join(target,'private-credit-note-refunds',f.files[0].relativePath))).toEqual(f.bytes);expect(readFileSync(f.file)).toEqual(f.bytes);
 expect(()=>validatePrivateUiRestore(f.repo,contract,'f'.repeat(64))).toThrow('identity or source schema');
 f.backup.kind='Private synthetic native UI12 consistent PG snapshot';expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('identity or source schema');
});
it('UI13 requires explicit refund review and refuses changed archive, omitted proof or unknown continuation stages', () => {
 const f=refundEvidenceFixture('13'),contract=f.save();
 expect(()=>validatePrivateUiRestore(f.repo,{...contract,manifest:contract.manifest.replace('ui13','ui15')},f.schema)).toThrow('Invalid reviewed');
 delete (f.backup as any).privateFileRoots;expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('roots were not reviewed');
 (f.backup as any).privateFileRoots=[];expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('inventory was omitted');
 (f.backup as any).privateFileRoots=[{rootName:'private-credit-note-refunds',files:f.files}];writeFileSync(f.archive,'Tampered original UI13 snapshot');expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('archive changed');
});

it('UI14 continuation preserves the exact source archive, native proof bytes and credential bytes before UI15', () => {
 const f=refundEvidenceFixture('14'),contract=f.save(),restore=validatePrivateUiRestore(f.repo,contract,f.schema),target=mkdtempSync(path.join(os.tmpdir(),'bambook-acceptance-'));roots.push(target);
 expect(restore.sourceHead).toBe(f.source.sourceHead);expect(restore.archiveSha256).toBe(hash(readFileSync(f.archive)));expect(restore.credentialSha256).toBe(hash(readFileSync(f.credentials)));
 expect(restorePrivateUiAdditionalFiles(restore,target)).toEqual([{rootName:'private-credit-note-refunds',files:f.files}]);
 expect(readFileSync(path.join(target,'private-credit-note-refunds',f.files[0].relativePath))).toEqual(f.bytes);expect(readFileSync(f.file)).toEqual(f.bytes);
 expect(()=>validatePrivateUiRestore(f.repo,contract,'f'.repeat(64))).toThrow('identity or source schema');
 f.backup.kind='Private synthetic native UI13 consistent PG snapshot';expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('identity or source schema');
});
it('UI14 requires explicit refund inventory and denies changed bytes or unreviewed next stages', () => {
 const f=refundEvidenceFixture('14'),contract=f.save();
 expect(()=>validatePrivateUiRestore(f.repo,{...contract,manifest:contract.manifest.replace('ui14','ui15')},f.schema)).toThrow('Invalid reviewed');
 delete (f.backup as any).privateFileRoots;expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('roots were not reviewed');
 (f.backup as any).privateFileRoots=[];expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('inventory was omitted');
 (f.backup as any).privateFileRoots=[{rootName:'private-credit-note-refunds',files:f.files}];writeFileSync(f.archive,'Tampered original UI14 snapshot');expect(()=>validatePrivateUiRestore(f.repo,f.save(),f.schema)).toThrow('archive changed');
});
