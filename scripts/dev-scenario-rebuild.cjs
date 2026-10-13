#!/usr/bin/env node
'use strict';
/** Read-only gate and reviewable plan. Destructive execution is intentionally
 * unavailable until a separately verified exclusive-maintenance writer exists. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { isSource } = require('./acceptance-working-source.cjs');
const guard = require('./dev-scenario-database.cjs');
const { fileTreeFingerprint } = require('./dev-scenario-recovery.cjs');
const FIXED_TIME = '2026-10-08T00:18:00.000Z';
const NATIVE_TEST = 'server/acceptance-tests/fullBusinessScenarioDriverAcceptance.test.ts';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const fail = (code, detail) => { throw Error(`DEV_REBUILD_${code}: ${detail}`); };
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function assertDevApiIdentity(status, body) {
  const clock = body?.businessClock;
  if (status !== 200 || body?.ok !== true || body.devPanelEnabled !== true || body.currentDb !== 'panda_hub_dev'
    || body.env?.nodeEnv !== 'development' || clock?.mode !== 'fixed' || clock.nowIso !== FIXED_TIME
    || clock.timeZone !== 'Asia/Shanghai' || clock.database !== 'panda_hub_dev') fail('TARGET', 'The actual running loopback API must expose the exact development database and fixed clock.');
  return { database: body.currentDb, businessClock: clock, nodeEnv: body.env.nodeEnv };
}
function assertMatchingDatabaseIdentity(status, body, sql, expectedPort, expected) {
  const actual = body?.identity, db = actual?.database, sqlDb = sql?.database, clock = actual?.businessClock;
  const validDb = value => value?.name === 'panda_hub_dev' && value.port === expectedPort && isHash(value.instanceFingerprint)
    && ['127.0.0.1/32', '::1/128', '127.0.0.1', '::1'].includes(value.address);
  if (status !== 200 || body?.ok !== true || actual?.protocolVersion !== 1 || sql?.protocolVersion !== 1 || sql.readOnly !== 'on'
    || !Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535 || !validDb(db) || !validDb(sqlDb)
    || db.instanceFingerprint !== sqlDb.instanceFingerprint || clock?.mode !== 'fixed' || clock.nowIso !== FIXED_TIME
    || clock.timeZone !== 'Asia/Shanghai' || clock.database !== 'panda_hub_dev'
    || expected && (expected.protocolVersion !== 1 || !validDb(expected.database) || db.instanceFingerprint !== expected.database.instanceFingerprint
      || !same(clock, expected.businessClock))) fail('PHYSICAL_IDENTITY', 'Actual loopback API and independent read-only SQL must prove the same original physical dev cluster and fixed clock.');
  return { protocolVersion: 1, database: { name: db.name, port: db.port, address: db.address, instanceFingerprint: db.instanceFingerprint },
    businessClock: { mode: 'fixed', nowIso: FIXED_TIME, timeZone: 'Asia/Shanghai', database: 'panda_hub_dev' } };
}
async function readMatchingDatabaseIdentity(target, expected) {
  assertDevConnection(target);
  const before = guard.readOnlyDatabaseIdentity(target);
  const response = await guard.freshMaintenanceGet('/api/dev/database-identity'), body = await response.json();
  const proof = assertMatchingDatabaseIdentity(response.status, body, before, target.port, expected);
  return assertMatchingDatabaseIdentity(response.status, body, guard.readOnlyDatabaseIdentity(target), target.port, proof);
}
function assertDevConnection(target) {
  const pg = target?.pgEnv;
  if (!pg || target.env?.NODE_ENV === 'production' || target.env?.BAMBOOK_DEV_PANEL !== '1' || target.env?.BAMBOOK_DEV_BUSINESS_TIME !== FIXED_TIME
    || pg.PGDATABASE !== 'panda_hub_dev' || !['localhost', '127.0.0.1', '::1'].includes(pg.PGHOST)
    || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || Number(pg.PGPORT) !== target.port
    || pg.PGHOSTADDR || pg.PGSERVICE || pg.PGSERVICEFILE) fail('TARGET', 'Non-production fixed-clock dev configuration without libpq redirects is required before any SQL access.');
  return target;
}
function assertBusinessSnapshot(snapshot, target) {
  const identity = snapshot?.identity, tables = snapshot?.tables;
  if (snapshot?.protocolVersion !== 1 || identity?.name !== 'panda_hub_dev' || identity.readOnly !== 'on'
    || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || identity.port !== target.port
    || !['127.0.0.1', '::1', '127.0.0.1/32', '::1/128'].includes(identity.address)
    || !Array.isArray(tables) || !tables.length || new Set(tables.map(row => row.name)).size !== tables.length
    || tables.some(row => typeof row.name !== 'string' || !row.name || !Number.isSafeInteger(row.rows) || row.rows < 0 || !isHash(row.sha256))) fail('SNAPSHOT', 'Exact SQL target and complete public row fingerprints are required.');
  const migrations = tables.find(row => row.name === '_prisma_migrations');
  if (!migrations || snapshot.migrationsSha256 !== migrations.sha256
    || snapshot.businessSha256 !== sha(JSON.stringify(canonical(tables.filter(row => row.name !== '_prisma_migrations'))))) fail('SNAPSHOT', 'Business and original migration content fingerprints do not match.');
  return snapshot;
}
function qualifyRehearsal({ result, scenario, vitest, manifest, currentManifest }) {
  const reject = detail => fail('REHEARSAL', detail);
  if (result?.status !== 'executed' || !validTime(result.finishedAt) || !validTime(result.startedAt) || Date.parse(result.finishedAt) < Date.parse(result.startedAt)
    || result.postgresStopped !== true || result.executionError || result.error || result.missingFiles?.length
    || result.typecheck?.status !== 'passed' || result.database?.name !== 'panda_hub_dev' || result.database?.host !== '127.0.0.1'
    || result.database?.identityVerified !== true || !Number.isInteger(result.database?.port) || result.database.port === 5432
    || result.scenarioRehearsal?.privateCluster !== true || result.scenarioRehearsal.existingDevUntouched !== true || result.scenarioRehearsal.businessClock !== FIXED_TIME
    || !same(result.tests, [{ file: NATIVE_TEST }]) || !same(result.executedFiles, [NATIVE_TEST]) || result.networkDenials?.length) reject('Finished dedicated private native rehearsal with exact test/clock and confirmed teardown is required.');
  for (const report of [result.counts, vitest]) if (!report || report.numTotalTests !== 1 || report.numPassedTests !== 1 || report.numFailedTests !== 0
    || report.numPendingTests !== 0 || report.numFailedTestSuites !== 0) reject('Native result has a failed, missing or skipped assertion.');
  if (vitest.success !== true || !Array.isArray(vitest.testResults) || vitest.testResults.length !== 1
    || !vitest.testResults[0].name?.endsWith('/' + NATIVE_TEST) || vitest.testResults[0].status !== 'passed'
    || vitest.testResults[0].assertionResults?.length !== 1 || vitest.testResults[0].assertionResults.some(row => row.status !== 'passed' || row.failureMessages?.length)) reject('The original native assertion result is not fully passed.');
  const developments = scenario?.development?.executions, orders = scenario?.orders, all = [...(developments ?? []), ...(orders ?? [])];
  if (!same(scenario?.expected, { development: 24, orders: 36 }) || !Array.isArray(developments) || developments.length !== 24 || !Array.isArray(orders) || orders.length !== 36
    || new Set(all.map(row => row.key)).size !== 60 || all.some(row => typeof row.key !== 'string' || !row.key || row.stopReached !== true || row.blockedAt
      || !Array.isArray(row.earnedSteps) || !row.earnedSteps.length || !row.ids || typeof row.ids !== 'object')
    || developments.some(row => typeof row.ids.caseId !== 'string' || !row.ids.caseId) || new Set(developments.map(row => row.ids.caseId)).size !== 24
    || orders.some(row => typeof row.ids.orderId !== 'string' || !row.ids.orderId) || new Set(orders.map(row => row.ids.orderId)).size !== 36
    || scenario.claims?.allStopsReached !== true || result.scenarioResults?.developmentReached !== 24 || result.scenarioResults.ordersReached !== 36) reject('Every one of the exact 24 development and 36 order scenarios must reach its earned stop.');
  assertDevApiIdentity(200, { ok: true, devPanelEnabled: true, currentDb: 'panda_hub_dev', env: { nodeEnv: 'development' }, businessClock: scenario.businessTime });
  if (scenario.clockEvidenceError || scenario.clockEvidence?.businessTime !== FIXED_TIME || scenario.clockEvidence.database !== 'panda_hub_dev'
    || ['returnedAt', 'requestedAt', 'startedAt', 'reviewedAt', 'acknowledgedAt'].some(kind => !Number.isSafeInteger(scenario.clockEvidence.eventCounts?.[kind]) || scenario.clockEvidence.eventCounts[kind] < 1)) reject('Real business-event and audit clock readback is missing.');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Object.keys(manifest).length || !same(manifest, currentManifest)
    || Object.values(manifest).some(value => !isHash(value)) || result.workingSource?.kind !== 'current-working-source'
    || result.workingSource.manifest !== 'source-files.json' || result.workingSource.sha256 !== sha(JSON.stringify(manifest))) reject('Complete current source manifest differs from the qualified native source.');
  const schemaSha256 = manifest['server/prisma/schema.prisma'];
  const migrationSha256 = Object.fromEntries(Object.entries(manifest).filter(([name]) => /^server\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(name)));
  if (!isHash(schemaSha256) || schemaSha256 !== result.schemaSha256 || !Object.keys(migrationSha256).length
    || !isHash(manifest[NATIVE_TEST]) || !isHash(manifest['scripts/dev-scenario-rebuild.cjs'])) reject('Current schema/migrations/controller must be included in the qualified source.');
  return { sourceSha256: result.workingSource.sha256, schemaSha256, migrationSha256, finishedAt: result.finishedAt,
    developmentReached: 24, ordersReached: 36, nativeTest: NATIVE_TEST, businessTime: FIXED_TIME };
}
/** Exact protocol emitted by dev-scenario-recovery.cjs. The same complete
 * recovery receipt may be supplied as both source and restore evidence; a
 * counts-only legacy backup or separately substituted restore is rejected. */
function assertRecoveryFileProofs(receipt) {
  const roots = receipt?.files?.roots, manifest = receipt?.privateFileManifest, proof = receipt?.fileRestoreProof;
  if (!Array.isArray(roots) || receipt.files.restoreMatched !== true
    || roots.some(row => !Number.isSafeInteger(row.index) || row.index < 0 || typeof row.root !== 'string' || !path.isAbsolute(row.root) || row.root === path.parse(row.root).root
      || !Number.isSafeInteger(row.entries) || row.entries < 1 || !isHash(row.sourceSha256) || row.sourceSha256 !== row.copiedSha256 || row.sourceSha256 !== row.restoredSha256)
    || new Set(roots.map(row => row.index)).size !== roots.length || new Set(roots.map(row => path.resolve(row.root))).size !== roots.length
    || !Array.isArray(manifest?.files) || !isHash(manifest.sha256) || proof?.restoredInsidePrivateSandbox !== true
    || !same(proof.sourceFiles, manifest.files) || !same(proof.restoredFiles, manifest.files)
    || proof.sourceManifestSha256 !== manifest.sha256 || proof.restoredManifestSha256 !== manifest.sha256
    || sha(JSON.stringify(canonical(manifest.files))) !== manifest.sha256) fail('BACKUP', 'Complete original and actually restored private file manifests must match.');
  const rootKeys = new Set(roots.map(row => String(row.index))), paths = new Set();
  for (const row of manifest.files) {
    if (!row || !rootKeys.has(row.rootKey) || typeof row.relativePath !== 'string' || !row.relativePath || path.isAbsolute(row.relativePath)
      || row.relativePath.includes('\\') || row.relativePath.includes('\0') || row.relativePath.split('/').some(part => !part || part === '.' || part === '..')
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !isHash(row.sha256)) fail('BACKUP', 'Restored file identity, relative path and exact bytes are required.');
    const key = `${row.rootKey}/${row.relativePath}`;
    if (paths.has(key)) fail('BACKUP', 'A restored file identity is duplicated.');
    paths.add(key);
  }
  return { roots, manifest };
}
function recoveryArchives(receipt) {
  if (!receipt?.dump || typeof receipt.dump.path !== 'string' || !Array.isArray(receipt.files?.roots)
    || receipt.files.roots.length > 0 && !receipt.files.archive) fail('BACKUP', 'A full database dump and all existing business file roots are required.');
  const files = [receipt.dump, ...(receipt.files.archive ? [receipt.files.archive] : [])];
  if (files.some(file => typeof file.path !== 'string' || !path.isAbsolute(file.path) || !isHash(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0)
    || new Set(files.map(file => path.resolve(file.path))).size !== files.length) fail('BACKUP', 'Original recovery archive identities are invalid.');
  return files;
}
function qualifyBackup({ backupReceipt, restoreReceipt, backupReceiptSha256, currentSnapshot, fileFacts, qualifiedFinishedAt }) {
  const reject = detail => fail('BACKUP', detail), port = currentSnapshot?.identity?.port, receipt = backupReceipt;
  assertBusinessSnapshot(currentSnapshot, { port });
  if (receipt?.protocolVersion !== 1 || receipt.database !== 'panda_hub_dev' || receipt.restoredAndVerified !== true || receipt.postgresStopped !== true
    || !validTime(receipt.createdAt) || !validTime(receipt.finishedAt) || !validTime(qualifiedFinishedAt)
    || Date.parse(receipt.createdAt) < Date.parse(qualifiedFinishedAt) || Date.parse(receipt.finishedAt) < Date.parse(receipt.createdAt)
    || !isHash(backupReceiptSha256) || !same(receipt, restoreReceipt)) reject('A fresh, complete and consistent protected content recovery receipt is required.');
  const before = assertBusinessSnapshot(receipt.before, { port }), after = assertBusinessSnapshot(receipt.after, { port });
  const restoredPort = receipt.restored?.identity?.port;
  if (!Number.isInteger(restoredPort) || restoredPort === port || restoredPort === 5432) reject('Restoration must use a stopped, separately initialized private loopback cluster.');
  const restored = assertBusinessSnapshot(receipt.restored, { port: restoredPort });
  for (const source of [before, after, restored]) {
    if (!same(source.tables, currentSnapshot.tables) || source.businessSha256 !== currentSnapshot.businessSha256 || source.migrationsSha256 !== currentSnapshot.migrationsSha256)
      reject('Current rows, original migrations or the restored whole database content changed.');
  }
  if (!same(recoveryArchives(receipt), fileFacts)) reject('Backup file bytes or protected digests changed.');
  const { roots, manifest } = assertRecoveryFileProofs(receipt);
  return { backupReceiptSha256, businessSha256: currentSnapshot.businessSha256, migrationsSha256: currentSnapshot.migrationsSha256,
    migrationRows: currentSnapshot.tables.find(row => row.name === '_prisma_migrations').rows,
    verifiedAt: receipt.finishedAt, restoredPort, privateFileManifestSha256: manifest.sha256,
    fileRoots: roots.map(({ index, root, sourceSha256 }) => ({ index, root, sha256: sourceSha256 })),
    files: fileFacts.map(({ sha256, bytes }) => ({ sha256, bytes })) };
}
/** The full backup hash, not a newly accepted checksum list, anchors old
 * history. Every original row also retains its complete SQL row hash (logs and
 * timestamp precision included) and exact facts for closed-maintenance checks. */
function buildMigrationBaseline({ ledger, backup, qualified, currentSnapshot }) {
  const reject = () => fail('MIGRATION_BASELINE', 'Original complete migration rows, qualified source and protected restored backup must agree.');
  assertBusinessSnapshot(currentSnapshot, { port: currentSnapshot?.identity?.port });
  let rowsSha256;
  try { rowsSha256 = guard.migrationRowsSha256(ledger?.rows); } catch { reject(); }
  const table = currentSnapshot.tables.find(row => row.name === '_prisma_migrations');
  if (ledger?.protocolVersion !== 1 || !same(ledger.identity, currentSnapshot.identity)
    || typeof ledger.timeZone !== 'string' || !/^[A-Za-z0-9_+:/.-]{1,128}$/.test(ledger.timeZone)
    || !isHash(ledger.catalogSha256) || rowsSha256 !== ledger.migrationsSha256 || rowsSha256 !== table.sha256
    || ledger.rows.length !== table.rows || backup?.migrationsSha256 !== rowsSha256 || backup.migrationRows !== table.rows
    || !isHash(backup.backupReceiptSha256) || !isHash(qualified?.sourceSha256) || !isHash(qualified.schemaSha256)
    || !qualified.migrationSha256 || !Object.keys(qualified.migrationSha256).length
    || Object.entries(qualified.migrationSha256).some(([name, checksum]) => !/^server\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(name) || !isHash(checksum))) reject();
  const baseline = { protocolVersion: 1, identity: { ...ledger.identity }, timeZone: ledger.timeZone,
    originalCatalogSha256: ledger.catalogSha256, migrationsSha256: rowsSha256, migrationRows: ledger.rows.length,
    backupReceiptSha256: backup.backupReceiptSha256, sourceSha256: qualified.sourceSha256, schemaSha256: qualified.schemaSha256,
    migrationSha256: { ...qualified.migrationSha256 }, rows: ledger.rows.map(row => ({ ...row })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
  return { ...baseline, baselineSha256: sha(JSON.stringify(canonical(baseline))) };
}
function validateMigrationBaselineBinding({ baseline, backup, qualified }) {
  const reject = () => fail('MIGRATION_BASELINE', 'The immutable original migration baseline or its protected backup/source binding changed.');
  const { baselineSha256, ...content } = baseline ?? {};
  let rowsSha256;
  try { rowsSha256 = guard.migrationRowsSha256(content.rows); } catch { reject(); }
  if (content.protocolVersion !== 1 || !isHash(baselineSha256) || sha(JSON.stringify(canonical(content))) !== baselineSha256
    || content.identity?.name !== 'panda_hub_dev' || content.identity.readOnly !== 'on'
    || !Number.isInteger(content.identity.port) || content.identity.port < 1 || content.identity.port > 65535
    || !['127.0.0.1', '::1', '127.0.0.1/32', '::1/128'].includes(content.identity.address)
    || typeof content.timeZone !== 'string' || !/^[A-Za-z0-9_+:/.-]{1,128}$/.test(content.timeZone)
    || !isHash(content.originalCatalogSha256) || content.migrationsSha256 !== rowsSha256 || content.migrationRows !== content.rows.length
    || !isHash(content.backupReceiptSha256) || content.backupReceiptSha256 !== backup?.backupReceiptSha256
    || backup.migrationsSha256 !== rowsSha256 || backup.migrationRows !== content.rows.length
    || !isHash(content.sourceSha256) || content.sourceSha256 !== qualified?.sourceSha256
    || !isHash(content.schemaSha256) || content.schemaSha256 !== qualified.schemaSha256
    || !same(content.migrationSha256, qualified.migrationSha256)
    || !content.migrationSha256 || !Object.keys(content.migrationSha256).length
    || Object.entries(content.migrationSha256).some(([name, checksum]) => !/^server\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(name) || !isHash(checksum))) reject();
  return baseline;
}
function buildRebuildPlan({ namespace, requestKey, qualified, backup, currentSnapshot, target, processObservation, databaseIdentity, migrationBaseline }) {
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9-]{2,31}$/.test(namespace) || typeof requestKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(requestKey)) fail('INPUT', 'Explicit stable request key and distinct scenario namespace are required.');
  assertBusinessSnapshot(currentSnapshot, target);
  assertMatchingDatabaseIdentity(200, { ok: true, identity: databaseIdentity }, { protocolVersion: 1, readOnly: 'on', database: databaseIdentity?.database }, target.port);
  if (migrationBaseline !== undefined) {
    validateMigrationBaselineBinding({ baseline: migrationBaseline, backup, qualified });
    if (!same(migrationBaseline.identity, currentSnapshot.identity) || migrationBaseline.migrationsSha256 !== currentSnapshot.migrationsSha256)
      fail('MIGRATION_BASELINE', 'The baseline must describe this exact current target and complete snapshot.');
  }
  const tables = currentSnapshot.tables.map(row => row.name).filter(name => name !== '_prisma_migrations').sort();
  const quote = value => `"${value.replace(/"/g, '""')}"`;
  const plan = { protocolVersion: 1, phase: 'reviewable_preflight', executable: false, currentDevRebuilt: false, businessDriverComplete: false,
    namespace, requestKey, database: 'panda_hub_dev', port: target.port, businessTime: FIXED_TIME, databaseIdentity, qualified, backup,
    ...(migrationBaseline === undefined ? {} : { migrationBaseline }),
    preserveTables: ['_prisma_migrations'], clearTables: tables, fileRootsModified: false, processObservation: processObservation ?? null,
    blockers: [{ code: 'EXCLUSIVE_MAINTENANCE_REQUIRED', detail: 'Before any writer: verify this repository backend PID, pause it, exclude other dev database sessions and guarantee finally recovery. Observation alone is not maintenance.' },
      { code: 'CURRENT_SCHEMA_DIFF_REQUIRED', detail: 'Recheck actual current dev schema against the exact qualified schema and applied migration checksums under maintenance; source hashes alone do not prove current DB structure.' },
      { code: 'ATOMIC_REBUILD_TRANSACTION_REQUIRED', detail: 'The separately controlled writer must prove TRUNCATE, master provisioning and original receipt share one transaction with precommit durable private cast; a plan alone grants no write.' }],
    transactionPlan: ['BEGIN SERIALIZABLE; verify live target and original-key receipt before any mutation.',
      `TRUNCATE TABLE ${tables.map(table => `ONLY public.${quote(table)}`).join(', ')} RESTART IDENTITY RESTRICT;`,
      'Run the existing master producer on the SAME transaction; no nested transaction or independent commit.',
      'Durably save the original cast in a private 0700 directory / exclusive 0600 file BEFORE commit, then persist its SHA256 and request/plan hash in the transaction receipt.',
      'COMMIT; if outcome is unknown, read the original transaction receipt and original private cast; NEVER clear/reseed or rotate credentials on resume.',
      'FINALLY restore the exact backend process; invoke the existing real-account HTTP driver separately. Master provision is not scenario completion.'] };
  return { ...plan, planSha256: sha(JSON.stringify(canonical(plan))) };
}

function readJsonEvidence(directory, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..') || relative.includes('\0')) fail('PATH', 'Evidence path escapes its declared root.');
  const base = fs.realpathSync(directory), file = path.join(base, relative), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file || !file.startsWith(base + path.sep)) fail('PATH', 'Evidence requires a regular file inside its declared root.');
  const bytes = fs.readFileSync(file);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha(bytes) };
}
function currentSourceManifest(repo, manifest) {
  const inventory = cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\0').filter(relative => relative && isSource(relative) && fs.existsSync(path.join(repo, relative)));
  const current = Object.fromEntries([...new Set([...inventory, ...Object.keys(manifest)])].sort().map(relative => {
    if (path.isAbsolute(relative) || relative.split('/').includes('..') || /(?:^|\/)\.env(?:\.|$)/.test(relative)) fail('PATH', 'Source manifest contains an unsafe path.');
    const file = path.join(repo, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) fail('PATH', 'Source manifest contains a non-regular repository file.');
    return [relative, sha(fs.readFileSync(file))];
  }));
  return current;
}
function protectedBackupFiles(receipt, options = {}) {
  const { roots, manifest } = assertRecoveryFileProofs(receipt), archives = recoveryArchives(receipt);
  const suppliedDirectory = path.resolve(receipt.backupDir), directory = fs.realpathSync(suppliedDirectory), stat = fs.lstatSync(suppliedDirectory);
  if (!path.basename(directory).startsWith('bambook-dev-content-recovery-') || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('BACKUP', 'Protected backup directory is required.');
  const assertPrivateFile = file => {
    const value = fs.lstatSync(file);
    if (!value.isFile() || value.isSymbolicLink() || path.dirname(fs.realpathSync(file)) !== directory || fs.realpathSync(path.dirname(file)) !== directory
      || (value.mode & 0o777) !== 0o600 || typeof process.getuid === 'function' && value.uid !== process.getuid()) fail('BACKUP', 'Backup bytes escaped their protected directory.');
    return value;
  };
  assertPrivateFile(path.join(directory, 'receipt.json'));
  if (!same(JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json'), 'utf8')), receipt)) fail('BACKUP', 'Public recovery evidence differs from the protected original receipt.');
  const data = path.join(directory, 'postgres-restore'), dataStat = fs.lstatSync(data);
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink() || fs.realpathSync(data) !== data || (dataStat.mode & 0o777) !== 0o700
    || fs.readFileSync(path.join(data, 'PG_VERSION'), 'utf8').trim() !== '16' || fs.existsSync(path.join(data, 'postmaster.pid'))) fail('BACKUP', 'The independent restored cluster must be retained privately and stopped.');
  if (options.expectedRoots && !same([...options.expectedRoots].map(value => path.resolve(value)).sort(), roots.map(row => path.resolve(row.root)).sort())) fail('BACKUP', 'Recovery does not cover the actual configured business file roots.');
  const actualSource = [], actualRestored = [];
  for (const row of roots) {
    const source = fileTreeFingerprint(row.root), copied = fileTreeFingerprint(path.join(directory, 'files-source', String(row.index))),
      restored = fileTreeFingerprint(path.join(directory, 'files-restored', String(row.index)));
    if (source.sha256 !== row.sourceSha256 || copied.sha256 !== row.sourceSha256 || restored.sha256 !== row.sourceSha256 || source.entries.length !== row.entries)
      fail('BACKUP', 'Current business files or the actual private restored files changed since backup.');
    for (const [tree, destination] of [[source, actualSource], [restored, actualRestored]]) {
      for (const file of tree.entries.filter(entry => entry.type === 'file')) destination.push({ rootKey: String(row.index), relativePath: file.path, bytes: file.bytes, sha256: file.sha256 });
    }
  }
  if (!same(actualSource, manifest.files) || !same(actualRestored, manifest.files)) fail('BACKUP', 'Actual source/restored file bytes do not match the precise manifest.');
  return archives.map(file => {
    const value = fs.lstatSync(file.path);
    assertPrivateFile(file.path);
    return { path: file.path, bytes: value.size, sha256: sha(fs.readFileSync(file.path)) };
  });
}
function readDevProcessObservation(repo) {
  const ids = cp.execFileSync('/usr/sbin/lsof', ['-nP', '-tiTCP:8081', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/);
  if (ids.length !== 1 || !/^\d+$/.test(ids[0]) || Number(ids[0]) < 2) fail('PROCESS', 'Exactly one verified API listener is required.');
  const pid = Number(ids[0]), command = cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  const cwd = cp.execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find(line => line.startsWith('n'))?.slice(1);
  if (cwd !== path.join(repo, 'server') || !/(?:^|\s)(?:\S*\/)?(?:src\/index\.ts|dist\/index\.js)(?:\s|$)/.test(command) || !/node|ts-node/.test(command)) fail('PROCESS', 'The current API process does not have this repository server cwd/entrypoint.');
  return { pid, cwd, commandSha256: sha(command), exclusiveMaintenanceHeld: false };
}
async function main(args = process.argv.slice(2)) {
  if (args[0] === '--apply') fail('APPLY_DISABLED', 'No destructive executor is enabled in this preflight slice.');
  if (args[0] !== '--plan' || args.length !== 11) fail('USAGE', '--plan --run-dir DIR --backup-receipt FILE --restore-receipt FILE --namespace NAME --request-key KEY');
  const allowed = ['--run-dir', '--backup-receipt', '--restore-receipt', '--namespace', '--request-key'], options = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || options[args[i]] || !args[i + 1]) fail('USAGE', 'Every explicit option must occur once.');
    options[args[i]] = args[i + 1];
  }
  const target = assertDevConnection(guard.loadTarget());
  const response = await guard.freshMaintenanceGet('/api/dev/status');
  assertDevApiIdentity(response.status, await response.json());
  const databaseIdentity = await readMatchingDatabaseIdentity(target);
  await guard.inspect(target);
  const run = path.resolve(options['--run-dir']), result = readJsonEvidence(run, 'result.json').value, scenario = readJsonEvidence(run, 'scenario-execution.json').value,
    vitest = readJsonEvidence(run, 'vitest.json').value, manifest = readJsonEvidence(run, 'source-files.json').value;
  const qualified = qualifyRehearsal({ result, scenario, vitest, manifest, currentManifest: currentSourceManifest(guard.root, manifest) });
  const receiptPath = path.resolve(options['--backup-receipt']), restorePath = path.resolve(options['--restore-receipt']);
  const sourceReceipt = readJsonEvidence(path.dirname(receiptPath), path.basename(receiptPath)), restoreReceipt = readJsonEvidence(path.dirname(restorePath), path.basename(restorePath)).value;
  const expectedRoots = [...new Set([target.env.BAMBOOK_PRIVATE_FILES_DIR || path.join(guard.root, 'server/private-files'),
    target.env.BAMBOOK_UPLOAD_DIR || path.join(guard.root, 'uploads'), path.join(guard.root, 'private-credit-note-refunds')]
    .map(file => path.resolve(guard.root, file)).filter(file => fs.existsSync(file)))];
  const currentSnapshot = guard.readOnlyBusinessSnapshot(target), fileFacts = protectedBackupFiles(sourceReceipt.value, { expectedRoots });
  const backup = qualifyBackup({ backupReceipt: sourceReceipt.value, restoreReceipt, backupReceiptSha256: sourceReceipt.sha256, currentSnapshot, fileFacts, qualifiedFinishedAt: qualified.finishedAt });
  const ledger = guard.readOnlyMigrationLedger(target), migrationBaseline = buildMigrationBaseline({ ledger, backup, qualified, currentSnapshot });
  const processObservation = readDevProcessObservation(guard.root), after = guard.readOnlyBusinessSnapshot(target);
  if (!same(after.tables, currentSnapshot.tables)) fail('BACKUP', 'Business content changed during read-only preflight.');
  if (!same(guard.readOnlyMigrationLedger(target), ledger)) fail('MIGRATION_BASELINE', 'Original migration rows or catalog changed during read-only preflight.');
  const recheck = await guard.freshMaintenanceGet('/api/dev/status');
  assertDevApiIdentity(recheck.status, await recheck.json());
  await readMatchingDatabaseIdentity(target, databaseIdentity);
  if (!same(protectedBackupFiles(sourceReceipt.value, { expectedRoots }), fileFacts)) fail('BACKUP', 'Recovery bytes changed during preflight.');
  // No signals, TRUNCATE, seed, environment edits or shared file cleanup occur.
  return buildRebuildPlan({ namespace: options['--namespace'], requestKey: options['--request-key'], qualified, backup, currentSnapshot, target, processObservation, databaseIdentity, migrationBaseline });
}
module.exports = Object.freeze({ assertDevApiIdentity, assertDevConnection, assertBusinessSnapshot, assertMatchingDatabaseIdentity, readMatchingDatabaseIdentity, qualifyRehearsal, qualifyBackup, buildMigrationBaseline, validateMigrationBaselineBinding, buildRebuildPlan,
  readJsonEvidence, currentSourceManifest, protectedBackupFiles, readDevProcessObservation, main });
if (require.main === module) main().then(plan => console.log(JSON.stringify(plan, null, 2))).catch(error => {
  console.error(String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted connection]'));
  process.exitCode = 1;
});
