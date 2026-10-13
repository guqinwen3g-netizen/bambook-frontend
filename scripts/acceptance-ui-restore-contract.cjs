// Only an existing, hashed synthetic browser snapshot can be restored into a
// newly identified private cluster. This does not authorize shared DB recovery.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function privateFileInventory(directory) {
  const files=[];
  if(!fs.existsSync(directory))return files;
  const walk=(folder)=>{
    for(const name of fs.readdirSync(folder).sort()){
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))throw Error('Invalid private evidence filename');
      const file=path.join(folder,name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink())throw Error('Private evidence symlink is not permitted');
      if(stat.isDirectory()){walk(file);continue;}
      if(!stat.isFile()||stat.size>10*1024*1024||files.length>=1024)throw Error('Invalid private evidence file');
      const bytes=fs.readFileSync(file);
      files.push({relativePath:path.relative(directory,file).split(path.sep).join('/'),bytes:bytes.length,sha256:sha(bytes)});
    }
  };
  if(fs.lstatSync(directory).isSymbolicLink()||!fs.lstatSync(directory).isDirectory())throw Error('Private evidence root is not a directory');
  walk(directory);return files.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));
}
function restorePrivateUiFiles(restore,targetDirectory) {
  const copied=[]; let targetRoot;
  for(const file of restore.privateFiles){
    const bytes=fs.readFileSync(path.join(restore.privateFilesDirectory,file.relativePath));
    if(bytes.length!==file.bytes||sha(bytes)!==file.sha256)throw Error('Private evidence changed during restore');
    if(!targetRoot){
      if(fs.existsSync(targetDirectory) && fs.lstatSync(targetDirectory).isSymbolicLink()) throw Error('Private evidence target symlink is not permitted');
      fs.mkdirSync(targetDirectory,{recursive:true,mode:0o700}); targetRoot=fs.realpathSync(targetDirectory);
    }
    const target=path.join(targetDirectory,file.relativePath);
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    const parent=fs.realpathSync(path.dirname(target));
    if(parent!==targetRoot && !parent.startsWith(targetRoot+path.sep))throw Error('Private evidence target parent escaped its root');
    fs.writeFileSync(target,bytes,{mode:0o600,flag:'wx'});
    if(sha(fs.readFileSync(target))!==file.sha256)throw Error('Private evidence copy is incomplete');
    copied.push({...file});
  }
  return copied;
}
function validatePrivateUiRestore(repo, contract, schemaSha256) {
  const stage = typeof contract?.manifest === 'string'
    ? /^artifacts\/acceptance-20261001\/execution\/runs\/[A-Za-z0-9-]+\/ui(04|07|08|09|10|12|13|14|15|16)-private-backup\.json$/.exec(contract.manifest)?.[1] : null;
  if (!stage
    || !/^[a-f0-9]{64}$/.test(contract.manifestSha256)) throw Error('Invalid reviewed private UI restore contract');
  const manifestPath = path.resolve(repo, contract.manifest);
  // An absent UI15 file is not a reviewed next-stage contract. Preserve the
  // earlier continuation controls that explicitly reject such a request.
  if ((stage === '15' || stage === '16') && !fs.existsSync(manifestPath)) throw Error('Invalid reviewed private UI restore contract');
  const bytes = fs.readFileSync(manifestPath);
  if (bytes.length > 131072 || sha(bytes) !== contract.manifestSha256) throw Error('Private UI restore manifest changed');
  const backup = JSON.parse(bytes), source = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), 'result.json'), 'utf8'));
  if (backup.kind !== `Private synthetic native UI${stage} consistent PG snapshot` || backup.databaseIdentityVerified !== true
    || !/^[a-f0-9]{40}$/.test(backup.sourceHead) || source.sourceHead !== backup.sourceHead
    || source.database?.identityVerified !== true || !/^bambook_acceptance_[a-f0-9]+$/.test(source.database?.name)
    || source.database?.host !== '127.0.0.1' || !source.live?.credentialFile
    || source.schemaSha256 !== schemaSha256) throw Error('Private UI snapshot identity or source schema cannot be verified');
  const sandbox = fs.realpathSync(source.sandbox);
  if (!/^bambook-acceptance-[A-Za-z0-9]+$/.test(path.basename(sandbox))
    || fs.realpathSync(source.database?.directory || path.join(sandbox, 'postgres')) !== path.join(sandbox, 'postgres')) {
    throw Error('Private UI snapshot is outside its original sandbox');
  }
  const backupFile = fs.realpathSync(backup.privateBackupPath), credentialFile = fs.realpathSync(source.live.credentialFile);
  if (path.dirname(backupFile) !== sandbox || path.basename(backupFile) !== `ui${stage}-native-private.dump`
    || credentialFile !== path.join(sandbox, 'ui-credentials.json')) throw Error('Private UI archive or credentials escaped their source sandbox');
  const archive = fs.readFileSync(backupFile), credentialBytes = fs.readFileSync(credentialFile);
  if (archive.length !== backup.bytes || sha(archive) !== backup.sha256) throw Error('Private UI snapshot archive changed');
  const credentials = JSON.parse(credentialBytes);
  if (typeof credentials.password !== 'string' || !credentials.password.startsWith('Acceptance-')
    || !Array.isArray(credentials.users) || credentials.users.length !== 7
    || new Set(credentials.users.map(user => user.id)).size !== 7
    || credentials.users.some(user => !/^acceptance_ui_/.test(user.id) || !user.email?.endsWith('@acceptance.invalid'))) {
    throw Error('Private UI snapshot credentials are not the synthetic browser identities');
  }
  if ((stage === '15' || stage === '16') && (!/^[a-f0-9]{64}$/.test(backup.credentialSha256) || sha(credentialBytes) !== backup.credentialSha256)) throw Error('Private UI snapshot credential bytes changed');
  const privateFilesDirectory=path.join(sandbox,'private-files'),privateFiles=privateFileInventory(privateFilesDirectory);
  const reviewedFiles=backup.privateFiles??[];
  if(!Array.isArray(reviewedFiles)||JSON.stringify(reviewedFiles)!==JSON.stringify(privateFiles))throw Error('Private evidence inventory or hashes differ from the reviewed snapshot');
  // Cash-refund proof bytes live outside the general private-files directory.
  // The exact known root must be reviewed too; a DB archive alone is incomplete.
  const additionalRoots = ['private-credit-note-refunds'];
  if ((stage === '10' || stage === '12' || stage === '13' || stage === '14' || stage === '15' || stage === '16') && !Array.isArray(backup.privateFileRoots)) throw Error('Private refund evidence roots were not reviewed');
  const reviewedRoots = backup.privateFileRoots ?? [];
  if (!Array.isArray(reviewedRoots) || reviewedRoots.length > additionalRoots.length
    || new Set(reviewedRoots.map(row => row?.rootName)).size !== reviewedRoots.length
    || reviewedRoots.some(row => !row || !additionalRoots.includes(row.rootName) || !Array.isArray(row.files)
      || Object.keys(row).some(key => !['rootName','files'].includes(key)))) throw Error('Invalid reviewed additional private evidence roots');
  const additionalPrivateFiles = [];
  for (const rootName of additionalRoots) {
    const directory = path.join(sandbox, rootName), files = privateFileInventory(directory);
    const reviewed = reviewedRoots.find(row => row.rootName === rootName);
    if (files.length && !reviewed) throw Error('Additional private evidence inventory was omitted');
    if (reviewed && JSON.stringify(reviewed.files) !== JSON.stringify(files)) throw Error('Additional private evidence inventory or hashes differ');
    if (reviewed) additionalPrivateFiles.push({rootName,directory,files});
  }
  return { backupFile, credentialFile, credentialSha256: sha(credentialBytes), sourceHead: backup.sourceHead,privateFilesDirectory,privateFiles,additionalPrivateFiles,
    archiveSha256: backup.sha256, sourceSchemaSha256: source.schemaSha256, manifestSha256: contract.manifestSha256 };
}
function restorePrivateUiAdditionalFiles(restore, targetSandbox) {
  const target = fs.realpathSync(targetSandbox);
  if (!/^bambook-acceptance-[A-Za-z0-9]+$/.test(path.basename(target))) throw Error('Additional private evidence target is not an identified acceptance sandbox');
  const receipts = [];
  for (const root of restore.additionalPrivateFiles ?? []) {
    if (root.rootName !== 'private-credit-note-refunds') throw Error('Unexpected additional private evidence root');
    if (JSON.stringify(privateFileInventory(root.directory)) !== JSON.stringify(root.files)) throw Error('Additional private evidence changed during restore');
    const directory = path.join(target, root.rootName);
    if (fs.existsSync(directory) && (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())) throw Error('Additional private evidence target symlink or invalid directory');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const files = restorePrivateUiFiles({privateFiles:root.files,privateFilesDirectory:root.directory},directory);
    if (JSON.stringify(privateFileInventory(directory)) !== JSON.stringify(root.files)) throw Error('Additional private evidence target inventory mismatch');
    receipts.push({rootName:root.rootName,files});
  }
  return receipts;
}

function validatePrivateUiUpgrade(repo, contract, fromHead, oldSchemaSha256, newSchemaSha256) {
  if (!/^[a-f0-9]{40}$/.test(fromHead || '') || oldSchemaSha256 === newSchemaSha256) throw Error('Explicit distinct old/new schema required for private populated upgrade');
  const restore = validatePrivateUiRestore(repo, contract, oldSchemaSha256);
  if (restore.sourceHead !== fromHead) throw Error('Private populated upgrade source differs from reviewed old commit');
  return restore;
}
module.exports = { validatePrivateUiRestore, validatePrivateUiUpgrade,restorePrivateUiFiles,restorePrivateUiAdditionalFiles };
