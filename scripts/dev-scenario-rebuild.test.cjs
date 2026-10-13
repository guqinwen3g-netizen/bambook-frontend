'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const rebuild = require('./dev-scenario-rebuild.cjs');
const recovery = require('./dev-scenario-recovery.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const clock = { mode: 'fixed', nowIso: '2026-10-08T00:18:00.000Z', timeZone: 'Asia/Shanghai', database: 'panda_hub_dev' };
function fixture() {
  const table = { name: 'Order', rows: 1, sha256: 'a'.repeat(64) }, migrations = { name: '_prisma_migrations', rows: 120, sha256: 'b'.repeat(64) };
  const tables = [table, migrations], snapshot = { protocolVersion: 1, identity: { name: 'panda_hub_dev', port: 5432, address: '127.0.0.1', readOnly: 'on' },
    tables, businessSha256: sha(JSON.stringify(canonical([table]))), migrationsSha256: migrations.sha256 };
  const manifest = { 'server/prisma/migrations/first/migration.sql': sha('migration'), 'server/prisma/schema.prisma': sha('schema'),
    'server/src/index.ts': sha('source'), 'scripts/dev-scenario-rebuild.cjs': sha('controller'), 'server/acceptance-tests/fullBusinessScenarioDriverAcceptance.test.ts': sha('native') };
  const testFile = 'server/acceptance-tests/fullBusinessScenarioDriverAcceptance.test.ts';
  const result = { status: 'executed', startedAt: '2026-10-07T08:00:00.000Z', finishedAt: '2026-10-07T08:10:00.000Z', postgresStopped: true,
    database: { name: 'panda_hub_dev', host: '127.0.0.1', port: 60001, identityVerified: true }, scenarioRehearsal: { privateCluster: true, existingDevUntouched: true, businessClock: clock.nowIso },
    typecheck: { status: 'passed' }, schemaSha256: manifest['server/prisma/schema.prisma'], workingSource: { kind: 'current-working-source', sha256: sha(JSON.stringify(manifest)), manifest: 'source-files.json' },
    tests: [{ file: testFile }], missingFiles: [], executedFiles: [testFile], networkDenials: [],
    counts: { numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numFailedTestSuites: 0 },
    scenarioResults: { developmentReached: 24, ordersReached: 36 } };
  const execution = (key, i) => ({ key: `${key}-${i}`, stopReached: true, earnedSteps: ['created'], ids: { caseId: `${key}-case-${i}`, orderId: `${key}-order-${i}` } });
  const scenario = { businessTime: clock, expected: { development: 24, orders: 36 }, development: { executions: Array.from({ length: 24 }, (_, i) => execution('development', i)) },
    orders: Array.from({ length: 36 }, (_, i) => execution('order', i)), claims: { allStopsReached: true, currentDevRebuilt: false },
    clockEvidence: { businessTime: clock.nowIso, database: clock.database, eventCounts: { returnedAt: 1, requestedAt: 1, startedAt: 1, reviewedAt: 1, acknowledgedAt: 1 } } };
  const vitest = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numFailedTestSuites: 0,
    testResults: [{ name: '/private/workspace/' + testFile, status: 'passed', assertionResults: [{ status: 'passed', failureMessages: [] }] }] };
  const fileManifest = [{ rootKey: '0', relativePath: 'actual-report.pdf', bytes: 12, sha256: 'd'.repeat(64) }];
  const fileManifestSha256 = sha(JSON.stringify(canonical(fileManifest)));
  const backupReceipt = { protocolVersion: 1, createdAt: '2026-10-07T08:11:00.000Z', finishedAt: '2026-10-07T08:13:00.000Z',
    database: 'panda_hub_dev', backupDir: '/private/bambook-dev-content-recovery-test', restoredAndVerified: true, postgresStopped: true,
    dump: { path: '/private/bambook-dev-content-recovery-test/panda_hub_dev.dump', bytes: 50, sha256: 'c'.repeat(64) },
    files: { roots: [{ index: 0, root: '/private/business-files', sourceSha256: 'e'.repeat(64), copiedSha256: 'e'.repeat(64), restoredSha256: 'e'.repeat(64), entries: 2 }],
      archive: { path: '/private/bambook-dev-content-recovery-test/business-files.tar.gz', bytes: 32, sha256: 'f'.repeat(64) }, restoreMatched: true },
    privateFileManifest: { files: fileManifest, sha256: fileManifestSha256 },
    fileRestoreProof: { sourceManifestSha256: fileManifestSha256, restoredManifestSha256: fileManifestSha256,
      sourceFiles: structuredClone(fileManifest), restoredFiles: structuredClone(fileManifest), restoredInsidePrivateSandbox: true },
    before: structuredClone(snapshot), after: structuredClone(snapshot), restored: { ...structuredClone(snapshot), identity: { ...snapshot.identity, port: 60002 } } };
  const backupReceiptSha256 = sha(JSON.stringify(backupReceipt));
  const restoreReceipt = structuredClone(backupReceipt);
  return { snapshot, manifest, currentManifest: { ...manifest }, result, scenario, vitest, backupReceipt, restoreReceipt, backupReceiptSha256,
    fileFacts: [backupReceipt.dump, backupReceipt.files.archive].map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })) };
}

test('importing the original backup CLI reuses only explicit guards and does not run main', () => {
  const oldExec = cp.execFileSync, oldFetch = global.fetch;
  cp.execFileSync = () => { throw Error('DB/process execution during import is forbidden'); };
  global.fetch = () => { throw Error('HTTP during import is forbidden'); };
  try {
    const guard = require('./dev-scenario-database.cjs');
    assert.equal(typeof guard.loadTarget, 'function'); assert.equal(typeof guard.inspect, 'function');
    assert.equal(typeof guard.readOnlyBusinessSnapshot, 'function');
    assert.equal(guard.main, undefined); assert.equal(guard.applyVerifiedUpgrade, undefined);
  } finally { cp.execFileSync = oldExec; global.fetch = oldFetch; }
});

test('all maintenance reads explicitly close their fixed loopback connection and cannot target another endpoint', async () => {
  const guard = require('./dev-scenario-database.cjs'), oldFetch = global.fetch, calls = [];
  global.fetch = async (url, init) => { calls.push({ url, init }); return { status: 200 }; };
  try {
    for (const route of ['/api/dev/status', '/api/dev/database-identity', '/api/health']) await guard.freshMaintenanceGet(route, 3000);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.match(call.url, /^http:\/\/127\.0\.0\.1:8081\/(?:api\/dev\/status|api\/dev\/database-identity|api\/health)$/);
      assert.equal(call.init.method, 'GET'); assert.equal(new Headers(call.init.headers).get('connection'), 'close');
      assert.equal(call.init.redirect, 'error'); assert.ok(call.init.signal instanceof AbortSignal);
    }
    for (const route of ['http://other.invalid/api/dev/status', '/api/dev/accounts', '/api/dev/status?write=1'])
      assert.throws(() => guard.freshMaintenanceGet(route), /MAINTENANCE_HTTP_TARGET/);
    assert.equal(calls.length, 3);
  } finally { global.fetch = oldFetch; }
});

test('strict API and SQL target/clock guard rejects production, redirects, wall mode and other database', () => {
  const body = { ok: true, devPanelEnabled: true, currentDb: 'panda_hub_dev', env: { nodeEnv: 'development' }, businessClock: clock };
  assert.deepEqual(rebuild.assertDevApiIdentity(200, body), { database: 'panda_hub_dev', businessClock: clock, nodeEnv: 'development' });
  for (const bad of [{ ...body, currentDb: 'panda_hub_local' }, { ...body, env: { nodeEnv: 'production' } }, { ...body, businessClock: { ...clock, mode: 'wall' } }, { ...body, businessClock: { ...clock, nowIso: '2026-10-09T00:18:00.000Z' } }])
    assert.throws(() => rebuild.assertDevApiIdentity(200, bad), /TARGET/);
  assert.throws(() => rebuild.assertDevApiIdentity(302, body), /TARGET/);
  const target = { port: 5432, env: { NODE_ENV: 'development', BAMBOOK_DEV_PANEL: '1', BAMBOOK_DEV_BUSINESS_TIME: clock.nowIso },
    pgEnv: { PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'panda_hub_dev' } };
  assert.equal(rebuild.assertDevConnection(target), target);
  for (const invalid of [{ ...target, env: { ...target.env, NODE_ENV: 'production' } },
    { ...target, env: { ...target.env, BAMBOOK_DEV_PANEL: '0' } }, { ...target, env: { ...target.env, BAMBOOK_DEV_BUSINESS_TIME: '' } },
    { ...target, pgEnv: { ...target.pgEnv, PGDATABASE: 'panda_hub_local' } }, { ...target, pgEnv: { ...target.pgEnv, PGHOSTADDR: '10.0.0.1' } },
    { ...target, pgEnv: { ...target.pgEnv, PGHOST: '10.0.0.1' } }, { ...target, port: 60002 }]) assert.throws(() => rebuild.assertDevConnection(invalid), /TARGET/);
  const f = fixture(); assert.equal(rebuild.assertBusinessSnapshot(f.snapshot, { port: 5432 }).businessSha256, f.snapshot.businessSha256);
  assert.throws(() => rebuild.assertBusinessSnapshot({ ...f.snapshot, identity: { ...f.snapshot.identity, address: '10.0.0.1' } }, { port: 5432 }), /SNAPSHOT/);
});

test('pre-reset API must match the actual read-only SQL physical instance, including same-name cloned database rejection', () => {
  const identity = { protocolVersion: 1, database: { name: 'panda_hub_dev', port: 5432, address: '127.0.0.1', instanceFingerprint: 'a'.repeat(64) }, businessClock: clock };
  const sql = { protocolVersion: 1, database: identity.database, readOnly: 'on' }, body = { ok: true, identity };
  assert.deepEqual(rebuild.assertMatchingDatabaseIdentity(200, body, sql, 5432), identity);
  assert.doesNotThrow(() => rebuild.assertMatchingDatabaseIdentity(200, body, { ...sql, database: { ...sql.database, address: '::1' } }, 5432));
  for (const bad of [{ ...identity, database: { ...identity.database, instanceFingerprint: 'b'.repeat(64) } },
    { ...identity, database: { ...identity.database, port: 60001 } }, { ...identity, database: { ...identity.database, name: 'panda_hub_local' } },
    { ...identity, businessClock: { ...clock, mode: 'wall' } }, { ...identity, database: { ...identity.database, address: '10.0.0.1' } }])
    assert.throws(() => rebuild.assertMatchingDatabaseIdentity(200, { ok: true, identity: bad }, sql, 5432), /PHYSICAL/);
  assert.throws(() => rebuild.assertMatchingDatabaseIdentity(200, body, { ...sql, readOnly: 'off' }, 5432), /PHYSICAL/);
  assert.throws(() => rebuild.assertMatchingDatabaseIdentity(200, body, sql, 5432, { ...identity, database: { ...identity.database, instanceFingerprint: 'b'.repeat(64) } }), /PHYSICAL/);
  assert.throws(() => rebuild.assertMatchingDatabaseIdentity(302, body, sql, 5432), /PHYSICAL/);
});

test('physical SQL anchor reads only the exact loopback dev in an explicitly read-only transaction without receipt dependence', () => {
  const guard = require('./dev-scenario-database.cjs'), oldExec = cp.execFileSync;
  const target = { env: { NODE_ENV: 'development' }, port: 5432, pgEnv: { PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'panda_hub_dev' } };
  const database = { name: 'panda_hub_dev', port: 5432, address: '127.0.0.1', instanceFingerprint: 'a'.repeat(64) };
  let sql;
  cp.execFileSync = (tool, args) => {
    assert.match(tool, /\/psql$/); sql = args.at(-1);
    assert.match(sql, /READ ONLY/); assert.match(sql, /bambook_runtime_identity\.physical_fingerprint\(\)/);
    assert.doesNotMatch(sql, /pg_control_system|data_directory/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/);
    return `BEGIN\n${JSON.stringify({ protocolVersion: 1, database, readOnly: 'on' })}\nCOMMIT`;
  };
  try {
    assert.deepEqual(guard.readOnlyDatabaseIdentity(target), { protocolVersion: 1, database, readOnly: 'on' });
    sql = undefined;
    assert.throws(() => guard.readOnlyDatabaseIdentity({ ...target, pgEnv: { ...target.pgEnv, PGDATABASE: 'panda_hub_local' } }), /IDENTITY_TARGET/);
    assert.equal(sql, undefined);
  } finally { cp.execFileSync = oldExec; }
});

test('qualifies only all 60 native stops with exact fresh source, schema and migration hashes', () => {
  const f = fixture();
  const proof = rebuild.qualifyRehearsal(f);
  assert.equal(proof.developmentReached, 24); assert.equal(proof.ordersReached, 36);
  assert.equal(proof.schemaSha256, f.result.schemaSha256);
  assert.equal(proof.migrationSha256['server/prisma/migrations/first/migration.sql'], f.manifest['server/prisma/migrations/first/migration.sql']);
});

for (const problem of ['failed', 'running', 'missing', 'partial', 'duplicate', 'skipped', 'clock', 'source_changed', 'source_added', 'migration_changed', 'schema_changed', 'native_failed', 'pg_not_stopped']) {
  test(`rehearsal qualification fails closed for ${problem}`, () => {
    const f = fixture();
    if (problem === 'failed') f.result.status = 'failed';
    if (problem === 'running') delete f.result.finishedAt;
    if (problem === 'missing') f.scenario.orders.pop();
    if (problem === 'partial') f.scenario.orders[0].stopReached = false;
    if (problem === 'duplicate') f.scenario.orders[1].key = f.scenario.orders[0].key;
    if (problem === 'skipped') f.result.counts.numPendingTests = 1;
    if (problem === 'clock') f.scenario.clockEvidenceError = 'time did not match';
    if (problem === 'source_changed') f.currentManifest['server/src/index.ts'] = sha('changed');
    if (problem === 'source_added') f.currentManifest['server/src/extra.ts'] = sha('extra');
    if (problem === 'migration_changed') f.currentManifest['server/prisma/migrations/first/migration.sql'] = sha('new migration');
    if (problem === 'schema_changed') f.result.schemaSha256 = sha('other schema');
    if (problem === 'native_failed') f.vitest.testResults[0].assertionResults[0].status = 'failed';
    if (problem === 'pg_not_stopped') f.result.postgresStopped = false;
    assert.throws(() => rebuild.qualifyRehearsal(f), /REHEARSAL/);
  });
}

test('requires a fresh complete restored content proof, not unchanged aggregate counts', () => {
  const f = fixture();
  assert.equal(rebuild.qualifyBackup({ ...f, currentSnapshot: f.snapshot, qualifiedFinishedAt: f.result.finishedAt }).businessSha256, f.snapshot.businessSha256);
  for (const problem of ['counts_only', 'changed_backup', 'changed_rows', 'changed_migrations', 'old_restore', 'files_not_restored', 'other_db',
    'same_port', 'different_receipt', 'manifest_missing', 'manifest_changed', 'restored_file_changed', 'file_path_escape', 'root_mismatch']) {
    const v = fixture();
    if (problem === 'counts_only') delete v.backupReceipt.before;
    if (problem === 'changed_backup') v.fileFacts[0].sha256 = 'd'.repeat(64);
    if (problem === 'changed_rows') v.snapshot.businessSha256 = 'e'.repeat(64);
    if (problem === 'changed_migrations') v.backupReceipt.restored.migrationsSha256 = 'f'.repeat(64);
    if (problem === 'old_restore') v.backupReceipt.createdAt = '2026-10-07T07:00:00.000Z';
    if (problem === 'files_not_restored') v.backupReceipt.files.restoreMatched = false;
    if (problem === 'other_db') v.backupReceipt.database = 'panda_hub_local';
    if (problem === 'same_port') v.backupReceipt.restored.identity.port = 5432;
    if (problem === 'manifest_missing') delete v.backupReceipt.privateFileManifest;
    if (problem === 'manifest_changed') v.backupReceipt.privateFileManifest.files[0].sha256 = '1'.repeat(64);
    if (problem === 'restored_file_changed') v.backupReceipt.fileRestoreProof.restoredFiles[0].sha256 = '1'.repeat(64);
    if (problem === 'file_path_escape') v.backupReceipt.privateFileManifest.files[0].relativePath = '../outside.pdf';
    if (problem === 'root_mismatch') v.backupReceipt.files.roots[0].restoredSha256 = '1'.repeat(64);
    if (problem !== 'different_receipt') v.restoreReceipt = structuredClone(v.backupReceipt);
    else v.restoreReceipt.finishedAt = '2026-10-07T08:14:00.000Z';
    assert.throws(() => rebuild.qualifyBackup({ ...v, currentSnapshot: v.snapshot, qualifiedFinishedAt: v.result.finishedAt }), /BACKUP|SNAPSHOT/);
  }
});

test('a reviewable plan remains non-executable without separately proved exclusive maintenance and atomic transaction', () => {
  const f = fixture(), qualified = rebuild.qualifyRehearsal(f), backup = rebuild.qualifyBackup({ ...f, currentSnapshot: f.snapshot, qualifiedFinishedAt: f.result.finishedAt });
  const plan = rebuild.buildRebuildPlan({ namespace: 'approved-dev-cast', requestKey: 'stable-rebuild-request', qualified, backup, currentSnapshot: f.snapshot,
    target: { port: 5432 }, processObservation: { pid: 123, exclusiveMaintenanceHeld: false },
    databaseIdentity: { protocolVersion: 1, database: { name: 'panda_hub_dev', port: 5432, address: '127.0.0.1', instanceFingerprint: 'a'.repeat(64) }, businessClock: clock } });
  assert.equal(plan.executable, false); assert.equal(plan.phase, 'reviewable_preflight');
  assert.equal(plan.businessDriverComplete, false); assert.equal(plan.currentDevRebuilt, false);
  assert.ok(plan.blockers.some(value => value.code === 'EXCLUSIVE_MAINTENANCE_REQUIRED'));
  assert.ok(plan.blockers.some(value => value.code === 'ATOMIC_REBUILD_TRANSACTION_REQUIRED'));
  assert.equal(plan.preserveTables[0], '_prisma_migrations');
  assert.equal(plan.clearTables.includes('_prisma_migrations'), false);
  assert.doesNotMatch(plan.transactionPlan[1], /CASCADE/);
  assert.match(plan.transactionPlan[1], /RESTRICT/);
  assert.equal(typeof plan.planSha256, 'string');
});

test('all destructive CLI modes reject before environment loading or any current-dev connection', () => {
  for (const mode of ['--apply', '--reset', '--seed']) {
    const child = cp.spawnSync(process.execPath, [path.join(__dirname, 'dev-scenario-rebuild.cjs'), mode], {
      env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://forbidden@127.0.0.1:1/forbidden', NODE_ENV: 'test' }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 1); assert.match(child.stderr, /APPLY_DISABLED|USAGE/); assert.doesNotMatch(child.stderr, /password|forbidden@/);
  }
});

test('evidence path readers refuse symbolic links and paths outside their declared root', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-rebuild-guard-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'evidence.json'), '{}'); fs.symlinkSync(path.join(directory, 'evidence.json'), path.join(directory, 'linked.json'));
    assert.throws(() => rebuild.readJsonEvidence(directory, 'linked.json'), /PATH/);
    assert.throws(() => rebuild.readJsonEvidence(directory, '../outside.json'), /PATH/);
    assert.deepEqual(rebuild.readJsonEvidence(directory, 'evidence.json').value, {});
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('protected recovery rehashes current roots, extracted files and archives rather than trusting receipt flags', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-dev-content-recovery-test-')),
    source = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-recovery-live-files-test-'));
  fs.chmodSync(directory, 0o700);
  try {
    fs.mkdirSync(path.join(source, 'empty')); fs.writeFileSync(path.join(source, 'report.pdf'), 'original');
    fs.mkdirSync(path.join(directory, 'files-source'), { mode: 0o700 });
    fs.mkdirSync(path.join(directory, 'files-restored'), { mode: 0o700 });
    fs.cpSync(source, path.join(directory, 'files-source/0'), { recursive: true });
    fs.cpSync(source, path.join(directory, 'files-restored/0'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'postgres-restore'), { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'postgres-restore/PG_VERSION'), '16\n');
    const f = fixture(), receipt = f.backupReceipt, tree = recovery.fileTreeFingerprint(source);
    receipt.backupDir = directory;
    receipt.files.roots = [{ index: 0, root: source, sourceSha256: tree.sha256, copiedSha256: tree.sha256, restoredSha256: tree.sha256, entries: tree.entries.length }];
    const manifest = tree.entries.filter(row => row.type === 'file').map(row => ({ rootKey: '0', relativePath: row.path, bytes: row.bytes, sha256: row.sha256 }));
    receipt.privateFileManifest = { files: manifest, sha256: sha(JSON.stringify(canonical(manifest))) };
    receipt.fileRestoreProof = { sourceManifestSha256: receipt.privateFileManifest.sha256, restoredManifestSha256: receipt.privateFileManifest.sha256,
      sourceFiles: manifest, restoredFiles: manifest, restoredInsidePrivateSandbox: true };
    for (const [name, field] of [['panda_hub_dev.dump', receipt.dump], ['business-files.tar.gz', receipt.files.archive]]) {
      field.path = path.join(directory, name); fs.writeFileSync(field.path, name, { mode: 0o600 });
      field.bytes = fs.statSync(field.path).size; field.sha256 = sha(fs.readFileSync(field.path));
    }
    fs.writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
    const files = rebuild.protectedBackupFiles(receipt, { expectedRoots: [source] });
    assert.deepEqual(files, [receipt.dump, receipt.files.archive]);
    assert.throws(() => rebuild.protectedBackupFiles(receipt, { expectedRoots: [] }), /actual configured business file roots/);
    fs.writeFileSync(path.join(source, 'report.pdf'), 'modified');
    assert.throws(() => rebuild.protectedBackupFiles(receipt), /business files/);
    fs.writeFileSync(path.join(source, 'report.pdf'), 'original');
    fs.writeFileSync(path.join(directory, 'files-restored/0/report.pdf'), 'modified');
    assert.throws(() => rebuild.protectedBackupFiles(receipt), /business files/);
    fs.writeFileSync(path.join(directory, 'files-restored/0/report.pdf'), 'original');
    fs.chmodSync(receipt.dump.path, 0o644);
    assert.throws(() => rebuild.protectedBackupFiles(receipt), /protected directory/);
    fs.chmodSync(receipt.dump.path, 0o600);
    fs.writeFileSync(path.join(directory, 'postgres-restore/postmaster.pid'), '1234');
    assert.throws(() => rebuild.protectedBackupFiles(receipt), /stopped/);
    fs.unlinkSync(path.join(directory, 'postgres-restore/postmaster.pid'));
    fs.symlinkSync(source, path.join(directory, 'files-restored/0/link'));
    assert.throws(() => rebuild.protectedBackupFiles(receipt), /RECOVERY_UNSUPPORTED_FILE/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(source, { recursive: true, force: true }); }
});

test('complete snapshot hashes every public row in a repeatable read-only transaction and rejects inventory drift', () => {
  const guard = require('./dev-scenario-database.cjs'), oldExec = cp.execFileSync, calls = [], f = fixture();
  const target = { env: { NODE_ENV: 'development' }, port: 5432, pgEnv: { PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'panda_hub_dev' } };
  const names = f.snapshot.tables.map(row => row.name);
  let drift = false;
  cp.execFileSync = (tool, args) => {
    assert.match(tool, /\/psql$/); const sql = args.at(-1); calls.push(sql);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/);
    if (!sql.includes('REPEATABLE READ')) return `BEGIN\n${JSON.stringify(names)}\nCOMMIT`;
    return ['BEGIN', JSON.stringify(f.snapshot.identity), ...f.snapshot.tables.map(row => JSON.stringify(row)), JSON.stringify(drift ? ['Order'] : names), 'COMMIT'].join('\n');
  };
  try {
    const snapshot = guard.readOnlyBusinessSnapshot(target);
    assert.equal(snapshot.businessSha256, f.snapshot.businessSha256);
    assert.equal(snapshot.migrationsSha256, f.snapshot.migrationsSha256);
    assert.match(calls[0], /BEGIN READ ONLY/); assert.match(calls[1], /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
    for (const name of names) assert.ok(calls[1].includes(`public.\"${name}\" AS t`));
    assert.match(calls[1], /sha256\(convert_to\(to_jsonb\(t\)::text/);
    drift = true; assert.throws(() => guard.readOnlyBusinessSnapshot(target), /SNAPSHOT_IDENTITY/);
    for (const pg of [{ ...target.pgEnv, PGHOST: '10.0.0.1' }, { ...target.pgEnv, PGHOSTADDR: '10.0.0.1' }, { ...target.pgEnv, PGDATABASE: 'panda_hub_local' }]) {
      const before = calls.length; assert.throws(() => guard.readOnlyBusinessSnapshot({ ...target, pgEnv: pg }), /SNAPSHOT_TARGET/); assert.equal(calls.length, before);
    }
  } finally { cp.execFileSync = oldExec; }
});

test('original ledger reader hashes complete PostgreSQL rows and retains timestamp precision without exporting logs', () => {
  const guard = require('./dev-scenario-database.cjs'), previous = cp.execFileSync;
  const target = { env: { NODE_ENV: 'development' }, port: 5432,
    pgEnv: { PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'panda_hub_dev' } };
  const original = { id: 'exact-id', name: '20260901000000_original', checksum: 'a'.repeat(64),
    startedAt: '2026-09-01T08:00:00.123456+08:00', finishedAt: null, rolledBackAt: '2026-09-01T08:00:01.654321+08:00',
    appliedStepsCount: 0, rowSha256: 'b'.repeat(64) };
  const identity = { name: 'panda_hub_dev', port: 5432, address: '127.0.0.1', readOnly: 'on', timeZone: 'Asia/Shanghai' };
  let rows = [original], connection = identity, calls = 0;
  cp.execFileSync = (tool, args) => {
    calls++; assert.match(tool, /\/psql$/); const sql = args.at(-1);
    assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
    assert.match(sql, /sha256\(convert_to\(to_jsonb\(t\)::text,'UTF8'\)\)/);
    assert.match(sql, /to_jsonb\(t\)->>'started_at'/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/);
    return ['BEGIN', JSON.stringify(connection), JSON.stringify(rows), 'c'.repeat(64), 'COMMIT'].join('\n');
  };
  try {
    const ledger = guard.readOnlyMigrationLedger(target);
    assert.equal(ledger.timeZone, 'Asia/Shanghai'); assert.equal(ledger.rows[0].startedAt, original.startedAt);
    assert.equal(ledger.rows[0].rolledBackAt, original.rolledBackAt);
    assert.equal(ledger.migrationsSha256, sha(original.rowSha256));
    assert.equal(Object.hasOwn(ledger.rows[0], 'logs'), false);
    rows = [{ ...original, rowSha256: 'invalid' }]; assert.throws(() => guard.readOnlyMigrationLedger(target), /LEDGER_FACTS/);
    rows = [original, original]; assert.throws(() => guard.readOnlyMigrationLedger(target), /LEDGER_FACTS/);
    rows = [original]; connection = { ...identity, readOnly: 'off' }; assert.throws(() => guard.readOnlyMigrationLedger(target), /LEDGER_IDENTITY/);
    for (const pg of [{ ...target.pgEnv, PGHOST: '10.0.0.1' }, { ...target.pgEnv, PGHOSTADDR: '127.0.0.1' }, { ...target.pgEnv, PGDATABASE: 'panda_hub' }]) {
      const before = calls; assert.throws(() => guard.readOnlyMigrationLedger({ ...target, pgEnv: pg }), /LEDGER_TARGET/); assert.equal(calls, before);
    }
  } finally { cp.execFileSync = previous; }
});
