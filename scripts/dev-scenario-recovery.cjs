/** Fresh, content-verified recovery evidence for the authorized dev rebuild.
 * This module never clears a database or overwrites any shared file root. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const net = require('node:net');
const guards = require('./dev-scenario-database.cjs');
const pgBin = '/opt/homebrew/opt/postgresql@16/bin';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const digest = value => sha(JSON.stringify(stable(value)));

function privateWrite(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

/** Reject links and special files: a backup may not silently omit external
 * bytes or restore a link that points outside its private restoration root. */
function fileTreeFingerprint(root) {
  const entries = [];
  const visit = (absolute, relative) => {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw Error('RECOVERY_UNSUPPORTED_FILE');
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory' });
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
    } else entries.push({ path: relative, type: 'file', bytes: stat.size, sha256: guards.hashFile(absolute) });
  };
  visit(path.resolve(root), '');
  return { entries, sha256: digest(entries) };
}

function sameDatabaseContent(left, right) {
  return Boolean(left && right && left.protocolVersion === 1 && right.protocolVersion === 1
    && left.identity?.name === 'panda_hub_dev' && right.identity?.name === 'panda_hub_dev'
    && left.businessSha256 === right.businessSha256 && left.migrationsSha256 === right.migrationsSha256
    && digest(left.tables) === digest(right.tables));
}

function assertRestoreEvidence(receipt, current) {
  if (receipt?.protocolVersion !== 1 || receipt.database !== 'panda_hub_dev'
    || !receipt.restoredAndVerified || !receipt.postgresStopped
    || !sameDatabaseContent(receipt.before, receipt.after)
    || !sameDatabaseContent(receipt.before, receipt.restored)
    || !sameDatabaseContent(receipt.after, current)
    || !Array.isArray(receipt.files?.roots) || !receipt.files.restoreMatched
    || !Array.isArray(receipt.privateFileManifest?.files) || !receipt.fileRestoreProof?.restoredInsidePrivateSandbox
    || digest(receipt.privateFileManifest.files) !== receipt.privateFileManifest.sha256
    || digest(receipt.fileRestoreProof.sourceFiles) !== receipt.privateFileManifest.sha256
    || digest(receipt.fileRestoreProof.restoredFiles) !== receipt.privateFileManifest.sha256
    || receipt.fileRestoreProof.sourceManifestSha256 !== receipt.privateFileManifest.sha256
    || receipt.fileRestoreProof.restoredManifestSha256 !== receipt.privateFileManifest.sha256
    || receipt.files.roots.some(row => !row.sourceSha256 || row.sourceSha256 !== row.copiedSha256 || row.sourceSha256 !== row.restoredSha256)) {
    throw Error('RECOVERY_PROOF_INCOMPLETE_OR_STALE');
  }
  const directory = fs.realpathSync(receipt.backupDir);
  if (!path.basename(directory).startsWith('bambook-dev-content-recovery-')
    || (fs.statSync(directory).mode & 0o777) !== 0o700) throw Error('RECOVERY_PRIVATE_DIRECTORY_REQUIRED');
  for (const file of [receipt.dump, receipt.files.archive].filter(Boolean)) {
    if (path.dirname(fs.realpathSync(file.path)) !== directory || (fs.statSync(file.path).mode & 0o777) !== 0o600
      || guards.hashFile(file.path) !== file.sha256) throw Error('RECOVERY_ARCHIVE_CHANGED');
  }
  return receipt;
}

function cleanPgEnv(source) {
  const env = { ...source };
  for (const name of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGPASSFILE', 'PGTARGETSESSIONATTRS']) delete env[name];
  return env;
}
function runPg(tool, args, env) {
  return cp.execFileSync(path.join(pgBin, tool), args, { env: cleanPgEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
async function unusedPort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
  });
}

async function createVerifiedRecovery(target = guards.loadTarget()) {
  await guards.inspect(target);
  const before = guards.readOnlyBusinessSnapshot(target);
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-dev-content-recovery-'));
  fs.chmodSync(backupDir, 0o700);
  const dump = path.join(backupDir, 'panda_hub_dev.dump');
  const receipt = { protocolVersion: 1, database: 'panda_hub_dev', backupDir, createdAt: new Date().toISOString(),
    before, restoredAndVerified: false, postgresStopped: false, files: { roots: [], restoreMatched: false } };
  const sourceFileManifest = [], restoredFileManifest = [];
  const stage = path.join(backupDir, 'files-source'), restoredFiles = path.join(backupDir, 'files-restored');
  fs.mkdirSync(stage, { mode: 0o700 }); fs.mkdirSync(restoredFiles, { mode: 0o700 });
  const roots = [...new Set([target.env.BAMBOOK_PRIVATE_FILES_DIR || path.join(guards.root, 'server/private-files'),
    target.env.BAMBOOK_UPLOAD_DIR || path.join(guards.root, 'uploads'), path.join(guards.root, 'private-credit-note-refunds')]
    .map(file => path.resolve(guards.root, file)).filter(file => fs.existsSync(file)))];
  let started = false;
  const data = path.join(backupDir, 'postgres-restore'), port = await unusedPort();
  const restoreEnv = { ...process.env, PGHOST: '127.0.0.1', PGPORT: String(port), PGDATABASE: 'panda_hub_dev',
    PGUSER: 'content_recovery', PGPASSWORD: '', PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'bambook-private-content-recovery' };
  try {
    runPg('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dump], target.pgEnv);
    fs.chmodSync(dump, 0o600);
    receipt.dump = { path: dump, bytes: fs.statSync(dump).size, sha256: guards.hashFile(dump) };
    for (const [index, root] of roots.entries()) {
      const source = fileTreeFingerprint(root), copy = path.join(stage, String(index));
      fs.cpSync(root, copy, { recursive: true, errorOnExist: true, force: false });
      const copied = fileTreeFingerprint(copy);
      if (source.sha256 !== copied.sha256 || source.sha256 !== fileTreeFingerprint(root).sha256) throw Error('RECOVERY_FILES_CHANGED_DURING_COPY');
      receipt.files.roots.push({ index, root, sourceSha256: source.sha256, copiedSha256: copied.sha256, entries: source.entries.length });
      for (const row of source.entries.filter(row => row.type === 'file')) sourceFileManifest.push({ rootKey: String(index),
        relativePath: row.path, bytes: row.bytes, sha256: row.sha256 });
    }
    if (roots.length) {
      const archive = path.join(backupDir, 'business-files.tar.gz');
      cp.execFileSync('/usr/bin/tar', ['-czf', archive, '-C', stage, ...roots.map((_row, index) => String(index))], { stdio: ['ignore', 'pipe', 'pipe'] });
      fs.chmodSync(archive, 0o600);
      receipt.files.archive = { path: archive, bytes: fs.statSync(archive).size, sha256: guards.hashFile(archive) };
      cp.execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', restoredFiles], { stdio: ['ignore', 'pipe', 'pipe'] });
      for (const row of receipt.files.roots) {
        const restored = fileTreeFingerprint(path.join(restoredFiles, String(row.index)));
        row.restoredSha256 = restored.sha256;
        if (row.restoredSha256 !== row.sourceSha256) throw Error('RECOVERY_FILE_RESTORE_MISMATCH');
        for (const file of restored.entries.filter(file => file.type === 'file')) restoredFileManifest.push({ rootKey: String(row.index),
          relativePath: file.path, bytes: file.bytes, sha256: file.sha256 });
      }
    }
    receipt.files.restoreMatched = true;
    receipt.privateFileManifest = { files: sourceFileManifest, sha256: digest(sourceFileManifest) };
    receipt.fileRestoreProof = { sourceManifestSha256: digest(sourceFileManifest), restoredManifestSha256: digest(restoredFileManifest),
      sourceFiles: sourceFileManifest, restoredFiles: restoredFileManifest, restoredInsidePrivateSandbox: true };
    receipt.after = guards.readOnlyBusinessSnapshot(target);
    if (!sameDatabaseContent(before, receipt.after)) throw Error('RECOVERY_DATABASE_CHANGED_DURING_BACKUP');
    runPg('initdb', ['-D', data, '-U', 'content_recovery', '--auth=trust', '--no-locale', '--encoding=UTF8'], restoreEnv);
    runPg('pg_ctl', ['-D', data, '-l', path.join(backupDir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${backupDir}`, '-w', 'start'], restoreEnv);
    started = true;
    runPg('createdb', ['panda_hub_dev'], restoreEnv);
    runPg('pg_restore', ['--exit-on-error', '--no-owner', '--no-acl', '--dbname', 'panda_hub_dev', dump], restoreEnv);
    receipt.restored = guards.readOnlyBusinessSnapshot({ env: { NODE_ENV: 'development' }, pgEnv: cleanPgEnv(restoreEnv), port });
    if (!sameDatabaseContent(before, receipt.restored)) throw Error('RECOVERY_DATABASE_RESTORE_MISMATCH');
    receipt.restoredAndVerified = true;
  } finally {
    if (started) { runPg('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], restoreEnv); receipt.postgresStopped = true; }
    receipt.finishedAt = new Date().toISOString();
    privateWrite(path.join(backupDir, 'receipt.json'), receipt);
  }
  assertRestoreEvidence(receipt, guards.readOnlyBusinessSnapshot(target));
  return receipt;
}

module.exports = { fileTreeFingerprint, sameDatabaseContent, assertRestoreEvidence, createVerifiedRecovery };
if (require.main === module) createVerifiedRecovery().then(receipt => {
  fs.mkdirSync(guards.evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(guards.evidenceDir, 'content-recovery-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ database: receipt.database, backupDir: receipt.backupDir, restoredAndVerified: true,
    tableCount: receipt.before.tables.length, businessSha256: receipt.before.businessSha256, postgresStopped: true,
    fileRootsRestored: receipt.files.roots.length }));
}).catch(() => { console.error('Dev recovery failed; no reset was attempted. Protected diagnostic artifacts were retained.'); process.exitCode = 1; });
