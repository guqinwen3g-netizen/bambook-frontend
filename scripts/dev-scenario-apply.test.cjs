'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const controller = require('./dev-scenario-apply.cjs');

const repo = '/reviewable/Bambook', args = ['--apply', '--run-dir', '/proof/run', '--backup-receipt', '/proof/recovery.json',
  '--restore-receipt', '/proof/recovery.json', '--namespace', 'qualified-rebuild', '--request-key', 'original-rebuild-key'];
function fixture(failure) {
  const events = [], plan = { protocolVersion: 1, phase: 'reviewable_preflight', namespace: 'qualified-rebuild', requestKey: 'original-rebuild-key',
    planSha256: 'a'.repeat(64), database: 'panda_hub_dev', port: 5432, businessTime: '2026-10-08T00:18:00.000Z',
    databaseIdentity: { protocolVersion: 1, database: { name: 'panda_hub_dev', port: 5432, address: '127.0.0.1', instanceFingerprint: '1'.repeat(64) },
      businessClock: { mode: 'fixed', database: 'panda_hub_dev', nowIso: '2026-10-08T00:18:00.000Z', timeZone: 'Asia/Shanghai' } },
    qualified: { sourceSha256: 'b'.repeat(64), schemaSha256: 'c'.repeat(64), developmentReached: 24, ordersReached: 36 },
    backup: { businessSha256: 'd'.repeat(64), migrationsSha256: 'e'.repeat(64) } };
  const receipt = { protocolVersion: 1, phase: 'master_provisioned', namespace: plan.namespace, requestKey: plan.requestKey,
    planSha256: plan.planSha256, sourceSha256: plan.qualified.sourceSha256, credentialsSha256: 'f'.repeat(64), transactionId: '77' };
  const event = async (name, value) => { events.push(name); if (failure === name) throw Error('SIMULATED_' + name); return value; };
  const session = { originalAllowConnections: true, dev: {}, control: {}, identity: { port: 5432, name: 'panda_hub_dev', pid: 123 } };
  const deps = { repo,
    preflight: async value => { assert.deepEqual(value, ['--plan', ...args.slice(1)]); return event('qualify', plan); },
    target: async () => event('target', { port: 5432 }),
    bindTarget: async () => event('physical_api_sql_recheck'),
    runtime: async () => event('runtime', { protocolVersion: 1, sourceSha256: plan.qualified.sourceSha256, schemaSha256: plan.qualified.schemaSha256,
      generatedClientManifest: { 'schema.prisma': 'a'.repeat(64) }, emittedManifest: { 'index.js': 'b'.repeat(64) }, verifiedAtWallIso: '2026-10-07T09:00:00.000Z' }),
    job: async () => event('job', { uid: 501, service: 'gui/501/com.bambook.dev-server', pid: 4321, plistPath: '/verified/com.bambook.dev-server.plist',
      plistSha256: '1'.repeat(64), cwd: repo + '/server', arguments: ['/usr/local/bin/node', repo + '/server/dist/index.js'], startedAtWallIso: '2026-10-07T08:00:00.000Z' }),
    privateDirectory: async () => event('private_directory', '/private/bambook-dev-scenario-rebuild-original'),
    snapshot: async () => event('snapshot', { tables: [], businessSha256: plan.backup.businessSha256, migrationsSha256: plan.backup.migrationsSha256 }),
    privateWrite: async (_directory, name, value) => { await event('write:' + name); if (name === 'context.private.json') {
      assert.equal(value.command.requestKey, plan.requestKey); assert.equal(value.expectedPort, plan.port); assert.deepEqual(value.plan, plan);
      assert.equal(value.privateDirectory, '/private/bambook-dev-scenario-rebuild-original');
      assert.equal(value.qualifiedRunDirectory, '/proof/run');
    } },
    stop: async () => event('bootout'), assertStopped: async () => event('maintenance_process'),
    connect: async () => event('connect', session), schema: async () => event('schema_and_migrations', { catalogSha256: '1'.repeat(64) }),
    deny: async () => event('deny_new_connections'), isolated: async () => event('maintenance_database'),
    recheck: async () => event('source_recheck'),
    execute: async (_session, input) => {
      await event('execute'); await input.assertMaintenanceHeld();
      return { receipt, master: { password: 'NEVER_PUBLIC' }, currentDevRebuilt: true, businessDriverComplete: false };
    },
    allow: async () => event('restore_allow'), disconnect: async () => event('disconnect'), restore: async (_job, context) => {
      await event('bootstrap_health');
      return controller.buildBackendLoadedProof(context, { ...context.verifiedJob, pid: 4322, startedAtWallIso: '2026-10-07T09:00:03.000Z' }, {
        maxRuntimeMtimeMs: Date.parse('2026-10-07T09:00:02Z'), bootstrapNotBeforeWallIso: '2026-10-07T09:00:03.000Z', observedAtWallIso: '2026-10-07T09:00:04.000Z' });
    },
  };
  return { events, deps, receipt, plan };
}

test('apply requires complete qualification before any maintenance or database construction', async () => {
  const f = fixture('qualify');
  await assert.rejects(controller.runApply(args, f.deps), /SIMULATED_qualify/);
  assert.deepEqual(f.events, ['qualify']);
});

test('only the exact verified launchd job, executable, arguments, cwd and environment are accepted', () => {
  const plist = { Label: 'com.bambook.dev-server', ProgramArguments: ['/usr/local/bin/node', repo + '/server/dist/index.js'],
    WorkingDirectory: repo + '/server', EnvironmentVariables: { PORT: '8081', NODE_ENV: 'development', BAMBOOK_DEV_PANEL: '1', BAMBOOK_NO_SCHEDULER: '1', BAMBOOK_AUTH_REQUIRED: 'true', BAMBOOK_REQUIRE_AUTH: 'true' } };
  const printed = `gui/501/com.bambook.dev-server = {\n path = /Users/reviewer/Library/LaunchAgents/com.bambook.dev-server.plist\n state = running\n program = /usr/local/bin/node\n arguments = {\n /usr/local/bin/node\n ${repo}/server/dist/index.js\n }\n working directory = ${repo}/server\n pid = 4321\n}`;
  const observation = { uid: 501, plistPath: '/Users/reviewer/Library/LaunchAgents/com.bambook.dev-server.plist', printed,
    listeners: [4321], command: plist.ProgramArguments.join(' '), cwd: plist.WorkingDirectory };
  assert.equal(controller.assertLaunchJob(plist, observation, repo).pid, 4321);
  for (const override of [{ Label: 'other' }, { ProgramArguments: ['node', repo + '/server/dist/index.js'] },
    { ProgramArguments: [...plist.ProgramArguments, '--other'] }, { WorkingDirectory: '/elsewhere' },
    { EnvironmentVariables: { ...plist.EnvironmentVariables, BAMBOOK_NO_SCHEDULER: '0' } },
    { EnvironmentVariables: { ...plist.EnvironmentVariables, NODE_ENV: 'production' } }])
    assert.throws(() => controller.assertLaunchJob({ ...plist, ...override }, observation, repo), /JOB/);
  for (const override of [{ listeners: [9999] }, { command: '/usr/local/bin/node elsewhere.js' }, { cwd: '/other' },
    { printed: printed.replace('pid = 4321', 'pid = 9999') }, { printed: printed.replace('state = running', 'state = waiting') },
    { printed: printed.replace(repo + '/server/dist/index.js', '/elsewhere/index.js') }])
    assert.throws(() => controller.assertLaunchJob(plist, { ...observation, ...override }, repo), /JOB/);
});

test('full apply orders guards, connection exclusion and single writer; finally restores DB before backend', async () => {
  const f = fixture(), result = await controller.runApply(args, f.deps);
  assert.equal(result.phase, 'master_rebuilt'); assert.equal(result.currentDevRebuilt, true); assert.equal(result.businessDriverComplete, false);
  assert.deepEqual(result.receipt, f.receipt); assert.doesNotMatch(JSON.stringify(result), /NEVER_PUBLIC|password|master"/);
  assert.equal(f.events.filter(event => event === 'execute').length, 1);
  for (const [first, second] of [['qualify', 'bootout'], ['write:context.private.json', 'bootout'], ['physical_api_sql_recheck', 'bootout'], ['maintenance_process', 'connect'],
    ['schema_and_migrations', 'deny_new_connections'], ['write:maintenance-intent.private.json', 'deny_new_connections'],
    ['deny_new_connections', 'execute'], ['execute', 'restore_allow'], ['restore_allow', 'bootstrap_health'],
    ['bootstrap_health', 'write:backend-loaded.private.json'], ['write:backend-loaded.private.json', 'write:public-receipt.json']])
    assert.ok(f.events.indexOf(first) < f.events.indexOf(second), `${first} precedes ${second}`);
});

test('a changed pre-reset physical API/SQL identity refuses before bootout or any writable connection', async () => {
  const f = fixture('physical_api_sql_recheck'), result = await controller.runApply(args, f.deps);
  assert.equal(result.phase, 'failed_before_rebuild'); assert.equal(result.currentDevRebuilt, false);
  for (const forbidden of ['bootout', 'connect', 'deny_new_connections', 'execute', 'bootstrap_health']) assert.equal(f.events.includes(forbidden), false);
});

test('backend-loaded proof write failure retains the committed transaction and cannot claim a population-ready runtime', async () => {
  const f = fixture('write:backend-loaded.private.json'), result = await controller.runApply(args, f.deps);
  assert.equal(result.phase, 'master_rebuilt_recovery_required'); assert.deepEqual(result.receipt, f.receipt);
  assert.ok(result.recoveryErrors.includes('bootstrap_health_or_loaded_proof')); assert.equal(result.businessDriverComplete, false);
  assert.equal(f.events.filter(event => event === 'execute').length, 1);
});

for (const point of ['bootout', 'maintenance_process', 'connect', 'schema_and_migrations', 'deny_new_connections', 'maintenance_database', 'source_recheck', 'execute']) {
  test(`failure at ${point} never retries the writer and always attempts exact backend recovery`, async () => {
    const f = fixture(point), result = await controller.runApply(args, f.deps);
    assert.equal(result.businessDriverComplete, false); assert.equal(result.canReseed, false);
    assert.ok(f.events.includes('bootstrap_health'));
    assert.ok(f.events.filter(event => event === 'execute').length <= 1);
    if (f.events.includes('deny_new_connections')) assert.ok(f.events.includes('restore_allow'));
    if (point === 'execute') { assert.equal(result.phase, 'unknown'); assert.equal(result.currentDevRebuilt, null); assert.equal(result.commitStatus, 'unknown'); }
  });
}

test('a failed ALLOW restore still attempts bootstrap and preserves the committed receipt without a completion claim', async () => {
  const f = fixture('restore_allow'), result = await controller.runApply(args, f.deps);
  assert.equal(result.phase, 'master_rebuilt_recovery_required'); assert.deepEqual(result.receipt, f.receipt);
  assert.ok(f.events.includes('bootstrap_health')); assert.ok(result.recoveryErrors.includes('restore_allow'));
});

test('an invalid writer receipt cannot leak its raw private master or become an acknowledged result', async () => {
  const f = fixture(); f.deps.execute = async () => ({ receipt: { ...f.receipt, sourceSha256: '0'.repeat(64) }, master: { password: 'NEVER_PUBLIC' } });
  const result = await controller.runApply(args, f.deps);
  assert.equal(result.phase, 'unknown'); assert.equal(result.commitStatus, 'unknown'); assert.equal(result.currentDevRebuilt, null);
  assert.equal(result.receipt, undefined); assert.doesNotMatch(JSON.stringify(result), /NEVER_PUBLIC|password|master"/);
  assert.ok(f.events.includes('restore_allow')); assert.ok(f.events.includes('bootstrap_health'));
});

test('post-commit catalog or private receipt-write failure preserves known commit and reports recovery needed', async () => {
  for (const problem of ['catalog', 'receipt_file']) {
    const f = fixture(), write = f.deps.privateWrite; let calls = 0;
    f.deps.closedSchema = async () => { if (++calls === 2 && problem === 'catalog') throw Error('TRIGGER_NOT_RESTORED'); };
    f.deps.privateWrite = async (...params) => { if (params[1] === 'public-receipt.json' && problem === 'receipt_file') throw Error('WRITE_ACK_LOST'); return write(...params); };
    const result = await controller.runApply(args, f.deps);
    assert.equal(result.phase, 'master_rebuilt_recovery_required'); assert.deepEqual(result.receipt, f.receipt);
    assert.equal(result.commitStatus, 'acknowledged'); assert.equal(result.businessDriverComplete, false);
    assert.ok(result.recoveryErrors.includes(problem === 'catalog' ? 'post_commit_schema' : 'public_receipt_file'));
    assert.ok(f.events.includes('bootstrap_health'));
  }
});

test('qualified schema demands every original migration checksum and excludes failed, duplicate and unknown migrations', () => {
  const hashes = { 'server/prisma/migrations/first/migration.sql': 'a'.repeat(64), 'server/prisma/migrations/second/migration.sql': 'b'.repeat(64) };
  const rows = Object.entries(hashes).map(([name, checksum]) => ({ name: name.split('/')[3], checksum, finishedAt: new Date(), rolledBackAt: null }));
  assert.doesNotThrow(() => controller.assertMigrations(rows, hashes));
  for (const bad of [rows.slice(1), [...rows, rows[0]], [...rows, { ...rows[0], name: 'unknown' }],
    [{ ...rows[0], checksum: 'c'.repeat(64) }, rows[1]], [{ ...rows[0], finishedAt: null }, rows[1]], [{ ...rows[0], rolledBackAt: new Date() }, rows[1]]])
    assert.throws(() => controller.assertMigrations(bad, hashes), /MIGRATIONS/);
});

function historicalMigrations(change) {
  const rebuild = require('./dev-scenario-rebuild.cjs');
  const hashes = { 'server/prisma/migrations/20260507_drop_deprecated_order_cols/migration.sql': 'a'.repeat(64),
    'server/prisma/migrations/20261007320000_scenario_physical_identity/migration.sql': 'b'.repeat(64) };
  const old = { id: 'old-applied', name: '20260507_drop_deprecated_order_cols', checksum: 'c'.repeat(64),
    startedAt: '2026-09-01T08:00:00+08:00', finishedAt: '2026-09-01T08:00:01+08:00', rolledBackAt: null, appliedStepsCount: 1, rowSha256: '1'.repeat(64) };
  let rows = [old, { ...old, id: 'old-resolved', finishedAt: null, rolledBackAt: '2026-09-01T08:00:00.5+08:00', appliedStepsCount: 0, rowSha256: '2'.repeat(64) },
    { ...old, id: 'new-applied', name: '20261007320000_scenario_physical_identity', checksum: 'b'.repeat(64), rowSha256: '3'.repeat(64) }];
  if (change) rows = change(rows);
  rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const ledgerHash = crypto.createHash('sha256').update(rows.map(row => row.rowSha256).sort().join('')).digest('hex');
  const order = { name: 'Order', rows: 0, sha256: '4'.repeat(64) }, migrationTable = { name: '_prisma_migrations', rows: rows.length, sha256: ledgerHash };
  const snapshot = { protocolVersion: 1, identity: { name: 'panda_hub_dev', port: 5432, address: '127.0.0.1', readOnly: 'on' }, tables: [order, migrationTable],
    migrationsSha256: ledgerHash, businessSha256: crypto.createHash('sha256').update(JSON.stringify([order])).digest('hex') };
  // Use the same canonical table fingerprint as the existing complete snapshot.
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  snapshot.businessSha256 = crypto.createHash('sha256').update(JSON.stringify(canonical([order]))).digest('hex');
  const backup = { backupReceiptSha256: '5'.repeat(64), migrationsSha256: ledgerHash, migrationRows: rows.length };
  const qualified = { sourceSha256: '6'.repeat(64), schemaSha256: '7'.repeat(64), migrationSha256: hashes };
  const ledger = { protocolVersion: 1, identity: snapshot.identity, timeZone: 'Asia/Shanghai', catalogSha256: '8'.repeat(64), rows, migrationsSha256: ledgerHash };
  const baseline = rebuild.buildMigrationBaseline({ ledger, backup, qualified, currentSnapshot: snapshot });
  return { rows, hashes, baseline, backup, qualified, ledger, snapshot,
    proof: { baseline, backup, qualified, zeroSchemaDiff: true, catalogSha256: ledger.catalogSha256 } };
}

test('restored full-content baseline permits only identical resolved legacy history, keeping the original strict default', () => {
  const f = historicalMigrations();
  assert.throws(() => controller.assertMigrations(f.rows, f.hashes), /MIGRATIONS/);
  assert.doesNotThrow(() => controller.assertMigrations(f.rows, f.hashes, f.proof));
});

test('legacy compatibility is bound to exact backup, original catalog, qualified source, row identity and zero schema diff', () => {
  const f = historicalMigrations();
  for (const proof of [undefined, { ...f.proof, zeroSchemaDiff: false }, { ...f.proof, catalogSha256: '9'.repeat(64) },
    { ...f.proof, backup: { ...f.backup, backupReceiptSha256: '9'.repeat(64) } },
    { ...f.proof, backup: { ...f.backup, migrationsSha256: '9'.repeat(64) } },
    { ...f.proof, qualified: { ...f.qualified, sourceSha256: '9'.repeat(64) } },
    { ...f.proof, baseline: { ...f.baseline, rows: f.baseline.rows.slice(1) } }])
    assert.throws(() => controller.assertMigrations(f.rows, f.hashes, proof), /MIGRATIONS|MIGRATION_BASELINE/);
  for (const key of ['id', 'checksum', 'rowSha256', 'startedAt']) {
    const changed = structuredClone(f.rows); changed[0][key] = key === 'startedAt' ? '2026-09-02T00:00:00Z' : '9'.repeat(64);
    assert.throws(() => controller.assertMigrations(changed, f.hashes, f.proof), /MIGRATIONS/);
  }
});

test('a backup cannot authorize unknown, unresolved, duplicate active or changed Oct7 applied migrations', () => {
  for (const change of [
    rows => rows.map(row => row.id === 'new-applied' ? { ...row, checksum: '9'.repeat(64) } : row),
    rows => [...rows, { ...rows[0], id: 'unknown', name: '20260901000000_untracked', rowSha256: '9'.repeat(64) }],
    rows => rows.map(row => row.id === 'old-resolved' ? { ...row, rolledBackAt: null } : row),
    rows => [...rows, { ...rows[0], id: 'second-success', rowSha256: '9'.repeat(64) }],
  ]) {
    const f = historicalMigrations(change);
    assert.throws(() => controller.assertMigrations(f.rows, f.hashes, f.proof), /MIGRATIONS/);
  }
});

test('closed-ledger reads use the backup timezone inside a repeatable read-only transaction', async () => {
  const f = historicalMigrations(), calls = [];
  const tx = { $executeRawUnsafe: async sql => { calls.push(['execute', sql]); },
    $queryRawUnsafe: async (sql, ...params) => { calls.push(['query', sql, ...params]); return sql.includes('set_config') ? [{ timezone: params[0] }] : f.rows; } };
  const db = { $transaction: async (work, options) => { assert.deepEqual(options, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 10000 }); return work(tx); } };
  assert.deepEqual(await controller.readMigrationLedgerRows(db, 'Asia/Shanghai'), f.rows);
  assert.deepEqual(calls[0], ['execute', 'SET TRANSACTION READ ONLY']);
  assert.deepEqual(calls[1], ['query', "SELECT set_config('TimeZone', $1, true) AS timezone", 'Asia/Shanghai']);
  assert.match(calls[2][1], /to_jsonb\(t\)::text/);
  const before = calls.length; await assert.rejects(controller.readMigrationLedgerRows(db, "UTC'; DROP TABLE x"), /MIGRATIONS/); assert.equal(calls.length, before);
});

test('baseline construction refuses a substituted whole-backup ledger even if the current row counts match', () => {
  const f = historicalMigrations(), rebuild = require('./dev-scenario-rebuild.cjs');
  for (const change of [
    { ledger: { ...f.ledger, migrationsSha256: '9'.repeat(64) } },
    { backup: { ...f.backup, migrationsSha256: '9'.repeat(64) } },
    { backup: { ...f.backup, migrationRows: f.rows.length + 1 } },
    { ledger: { ...f.ledger, identity: { ...f.ledger.identity, port: 6543 } } },
    { qualified: { ...f.qualified, sourceSha256: undefined } },
  ]) assert.throws(() => rebuild.buildMigrationBaseline({ ledger: f.ledger, backup: f.backup, qualified: f.qualified, currentSnapshot: f.snapshot, ...change }), /MIGRATION_BASELINE/);
});

test('dev and metadata control connections must be distinct PIDs in the same exact physical cluster with owner authority', () => {
  const dev = { name: 'panda_hub_dev', port: 5432, address: '127.0.0.1', pid: 123, startedAt: 'same-start', instanceFingerprint: '1'.repeat(64), clusterControlFingerprint: '3'.repeat(64), user: 'db_owner', owner: 'db_owner', ownerMember: true, superuser: false, allowConnections: true };
  const control = { ...dev, name: 'postgres', pid: 124, instanceFingerprint: null };
  assert.doesNotThrow(() => controller.assertMaintenanceConnections(dev, control, 5432));
  for (const bad of [{ ...control, name: 'panda_hub_local' }, { ...control, port: 5433 }, { ...control, address: '::1' },
    { ...control, pid: 123 }, { ...control, startedAt: 'new-cluster' }, { ...control, clusterControlFingerprint: '2'.repeat(64) }, { ...control, user: 'different-owner' }])
    assert.throws(() => controller.assertMaintenanceConnections(dev, bad, 5432), /CONTROL/);
  assert.throws(() => controller.assertMaintenanceConnections({ ...dev, allowConnections: false }, control, 5432), /CONTROL/);
  assert.throws(() => controller.assertMaintenanceConnections({ ...dev, ownerMember: false }, { ...control, ownerMember: false }, 5432), /CONTROL/);
});

test('maintenance identity uses the dev-only protected hash and a separate control hash without selecting physical paths', async () => {
  for (const name of ['panda_hub_dev', 'postgres']) {
    let reads = 0;
    const row = { name, clusterControlFingerprint: '3'.repeat(64), instanceFingerprint: name === 'panda_hub_dev' ? '1'.repeat(64) : null };
    const connection = { $queryRawUnsafe: async sql => {
      reads++;
      assert.doesNotMatch(sql, /data_directory/);
      if (reads === 1) return [{ name }];
      assert.match(sql, /pg_catalog\.pg_control_system\(\)/);
      if (name === 'panda_hub_dev') assert.match(sql, /bambook_runtime_identity\.physical_fingerprint\(\)/);
      else assert.doesNotMatch(sql, /bambook_runtime_identity/);
      return [row];
    } };
    assert.deepEqual(await controller.readMaintenanceIdentity(connection), row);
    assert.equal(reads, 2);
  }
  let reads = 0;
  await assert.rejects(controller.readMaintenanceIdentity({ $queryRawUnsafe: async () => { reads++; return [{ name: 'panda_hub_empty' }]; } }), /CONTROL/);
  assert.equal(reads, 1);
});

test('closed-admission callback only accepts the original SQL PID and backend start, including when other sessions are idle', () => {
  const original = { pid: 123, user: 'dev_owner', backendStartedAt: 'original-backend-start' };
  const row = { pid: 123, name: 'panda_hub_dev', user: original.user, startedAt: original.backendStartedAt };
  assert.doesNotThrow(() => controller.assertClosedConnectionRows([row], original));
  for (const rows of [[], [row, { ...row, pid: 124, state: 'idle' }], [{ ...row, pid: 124 }], [{ ...row, startedAt: 'replacement' }],
    [{ ...row, name: 'panda_hub_local' }], [{ ...row, user: 'different' }]]) assert.throws(() => controller.assertClosedConnectionRows(rows, original), /OTHER_SESSION/);
});

test('generated client proof needs real runtime schema bindings, types and engine, not a copied schema file', () => {
  const schema = 'generator client { provider = "prisma-client-js" }\n', hash = crypto.createHash('sha256').update(schema).digest('hex');
  const manifest = Object.fromEntries(['schema.prisma', 'index.js', 'index.d.ts', 'default.js', 'default.d.ts', 'edge.js', 'package.json', 'libquery_engine-darwin-arm64.dylib.node'].map(name => [name, 'a'.repeat(64)]));
  const source = `  "inlineSchema": ${JSON.stringify(schema)},\n`, packageJson = { name: 'prisma-client-' + hash, main: 'index.js', types: 'index.d.ts' };
  const proof = { manifest, indexSource: source, edgeSource: source, packageJson };
  assert.doesNotThrow(() => controller.assertGeneratedClient(proof, hash));
  for (const bad of [{ ...proof, manifest: { 'schema.prisma': hash } }, { ...proof, packageJson: { ...packageJson, name: 'other-client' } },
    { ...proof, indexSource: '  "inlineSchema": "other schema",\n' }, { ...proof, edgeSource: '  "inlineSchema": not-json,\n' }])
    assert.throws(() => controller.assertGeneratedClient(bad, hash), /RUNTIME_BUILD_REQUIRED/);
});

test('per-command runtime check rejects source, generated bytes and stale extra compiled files', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-runtime-hash-test-'));
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const files = { 'server/prisma/schema.prisma': 'original schema', 'server/node_modules/.prisma/client/schema.prisma': 'normalized schema',
    'server/dist/index.js': 'original compiled index', 'server/scripts/full-business-sim/provisionDevMaster.ts': 'original receipt helper' };
  try {
    for (const [relative, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true }); fs.writeFileSync(path.join(repo, relative), text); }
    const { plan } = fixture(); plan.qualified.schemaSha256 = sha(files['server/prisma/schema.prisma']);
    const normalized = sha(files['server/node_modules/.prisma/client/schema.prisma']);
    const proof = { protocolVersion: 1, sourceSha256: plan.qualified.sourceSha256, schemaSha256: plan.qualified.schemaSha256,
      formattedSchemaSha256: normalized, generatedSchemaSha256: normalized, emittedManifest: { 'index.js': sha(files['server/dist/index.js']) },
      generatedClientManifest: { 'schema.prisma': normalized }, scriptSources: {
        'server/scripts/full-business-sim/provisionDevMaster.ts': sha(files['server/scripts/full-business-sim/provisionDevMaster.ts']) } };
    assert.equal(controller.assertRuntimeProofCurrent(repo, plan, proof).sourceSha256, plan.qualified.sourceSha256);
    for (const relative of Object.keys(files)) {
      fs.writeFileSync(path.join(repo, relative), 'changed same logical file');
      assert.throws(() => controller.assertRuntimeProofCurrent(repo, plan, proof), /RUNTIME/);
      fs.writeFileSync(path.join(repo, relative), files[relative]);
    }
    fs.writeFileSync(path.join(repo, 'server/dist/stale.js'), 'unverified code');
    assert.throws(() => controller.assertRuntimeProofCurrent(repo, plan, proof), /RUNTIME/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('datasource URL is rebuilt only from the verified target with public schema and one connection, without redirects', () => {
  const url = new URL(controller.maintenanceUrl({ port: 5432, pgEnv: { PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'panda_hub_dev', PGUSER: 'dev_owner', PGPASSWORD: 'private-secret' } }, 'panda_hub_dev'));
  assert.equal(url.pathname, '/panda_hub_dev'); assert.equal(url.searchParams.get('connection_limit'), '1'); assert.equal(url.searchParams.get('schema'), 'public');
  assert.equal(url.searchParams.size, 2);
  assert.throws(() => controller.maintenanceUrl({ port: 5432, pgEnv: { PGHOST: '10.0.0.1', PGPORT: '5432', PGDATABASE: 'panda_hub_dev' } }, 'postgres'), /TARGET/);
});

test('resume is read-only original receipt recovery and never calls maintenance or seeding', async () => {
  const f = fixture(), events = [];
  const result = await controller.runResume(['--resume', '--private-dir', '/private/original'], {
    context: async () => ({ plan: f.plan, privateDirectory: '/private/original', expectedPort: 5432, command: {
      namespace: f.plan.namespace, requestKey: f.plan.requestKey, planSha256: f.plan.planSha256, sourceSha256: f.plan.qualified.sourceSha256 } }),
    target: async () => ({ port: 5432 }), api: async () => events.push('current_api'),
    bindTarget: async () => events.push('current_physical_identity'),
    resume: async () => { events.push('read_original'); return { phase: 'master_provisioned', receipt: f.receipt, master: { password: 'NEVER_PUBLIC' } }; },
  });
  assert.deepEqual(events, ['current_api', 'current_physical_identity', 'read_original']); assert.equal(result.phase, 'master_rebuilt'); assert.equal(result.canReseed, false);
  assert.doesNotMatch(JSON.stringify(result), /NEVER_PUBLIC|password|master"/);
});

test('protected original context is durable, immutable and binds exact qualified run/plan/source/port', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-dev-scenario-rebuild-context-test-')),
    run = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-qualified-run-test-'));
  fs.chmodSync(directory, 0o700);
  try {
    const { plan } = fixture(); delete plan.planSha256;
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    plan.planSha256 = crypto.createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
    const context = { protocolVersion: 1, plan, privateDirectory: fs.realpathSync(directory), qualifiedRunDirectory: fs.realpathSync(run), expectedPort: plan.port,
      command: { namespace: plan.namespace, requestKey: plan.requestKey, planSha256: plan.planSha256, sourceSha256: plan.qualified.sourceSha256 }, preparedAtWallIso: new Date().toISOString() };
    controller.privateWrite(directory, 'context.private.json', context);
    const file = path.join(directory, 'context.private.json'), original = fs.readFileSync(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.deepEqual(controller.readContext(directory), context);
    assert.throws(() => controller.privateWrite(directory, 'context.private.json', context), /EEXIST/);
    assert.equal(fs.readFileSync(file).equals(original), true);
    fs.chmodSync(file, 0o644); assert.throws(() => controller.readContext(directory), /PRIVATE/); fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify({ ...context, expectedPort: 60002 })); assert.throws(() => controller.readContext(directory), /PRIVATE/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(run, { recursive: true, force: true }); }
});

test('missing or unprovable original commit stays unknown and never falls through to a new apply', async () => {
  const f = fixture(), context = { plan: f.plan, privateDirectory: '/private/original', expectedPort: 5432, command: {} };
  for (const failure of ['api', 'receipt']) {
    const result = await controller.runResume(['--resume', '--private-dir', '/private/original'], { context: async () => context,
      target: async () => ({ port: 5432 }), api: async () => { if (failure === 'api') throw Error('fixed clock status unavailable'); },
      bindTarget: async () => {},
      resume: async () => ({ phase: 'unknown', canReseed: false }) });
    assert.equal(result.phase, 'unknown'); assert.equal(result.currentDevRebuilt, null); assert.equal(result.canReseed, false);
    assert.equal(result.businessDriverComplete, false);
  }
});

test('unsupported or incomplete CLI operations reject before any environment, HTTP or SQL work', () => {
  for (const args of [['--reset'], ['--seed'], ['--apply'], ['--resume'], ['--recover-loaded-proof']]) {
    const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'dev-scenario-apply.cjs'), ...args], {
      env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: 'postgresql://forbidden@127.0.0.1:1/forbidden_business_db' }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /USAGE/); assert.doesNotMatch(result.stderr, /forbidden@/);
  }
});

function processFixture() {
  const { plan } = fixture(), normalized = 'd'.repeat(64);
  const runtimeProof = { protocolVersion: 1, sourceSha256: plan.qualified.sourceSha256, schemaSha256: plan.qualified.schemaSha256,
    formattedSchemaSha256: normalized, generatedSchemaSha256: normalized, emittedManifest: { 'index.js': 'e'.repeat(64) },
    generatedClientManifest: { 'schema.prisma': normalized }, scriptSources: { 'server/scripts/full-business-sim/provisionDevMaster.ts': 'f'.repeat(64) },
    verifiedAtWallIso: '2026-10-07T09:00:00.123Z' };
  const verifiedJob = { uid: 501, service: 'gui/501/com.bambook.dev-server', pid: 123, plistPath: '/Users/reviewer/Library/LaunchAgents/com.bambook.dev-server.plist',
    plistSha256: '1'.repeat(64), cwd: repo + '/server', arguments: ['/usr/local/bin/node', repo + '/server/dist/index.js'], startedAtWallIso: '2026-10-07T08:00:00.000Z' };
  const context = { privateDirectory: '/private/bambook-dev-scenario-rebuild-proof', plan, runtimeProof, verifiedJob,
    command: { namespace: plan.namespace, requestKey: plan.requestKey, planSha256: plan.planSha256, sourceSha256: plan.qualified.sourceSha256 } };
  const job = { ...verifiedJob, pid: 124, startedAtWallIso: '2026-10-07T09:00:03.000Z' };
  return { context, job };
}

test('actual ps start time is parsed in UTC independent of local TZ, with seconds precision and strict invalid rejection', () => {
  assert.equal(controller.parseProcessStart('Wed Oct  7 17:22:33 2026\n'), '2026-10-07T17:22:33.000Z');
  for (const value of ['', 'Wed Oct 99 17:22:33 2026', 'Wed Oct 7 25:22:33 2026', 'Thu Oct 7 17:22:33 2026', '2026-10-07'])
    assert.throws(() => controller.parseProcessStart(value), /PROCESS/);
});

test('a backend must start after the original runtime proof and every actual runtime file mtime', () => {
  const { context, job } = processFixture(), options = { maxRuntimeMtimeMs: Date.parse('2026-10-07T09:00:02.001Z'), bootstrapNotBeforeWallIso: '2026-10-07T09:00:03.000Z' };
  assert.doesNotThrow(() => controller.assertLoadedProcess(context, job, options));
  for (const changed of [{ ...job, pid: context.verifiedJob.pid, startedAtWallIso: context.verifiedJob.startedAtWallIso },
    { ...job, startedAtWallIso: '2026-10-07T09:00:02.000Z' }, { ...job, plistSha256: '2'.repeat(64) },
    { ...job, cwd: '/another/server' }, { ...job, arguments: ['node', 'old.js'] }, { ...job, service: 'gui/501/other' }])
    assert.throws(() => controller.assertLoadedProcess(context, changed, options), /LOADED_PROCESS/);
  assert.throws(() => controller.assertLoadedProcess(context, job, { ...options, expectedProcess: { ...job, pid: 125 } }), /LOADED_PROCESS/);
  assert.throws(() => controller.assertLoadedProcess(context, job, { ...options, bootstrapNotBeforeWallIso: '2026-10-07T09:00:04.000Z' }), /LOADED_PROCESS/);
});

test('immutable backend-loaded proof binds the original command, actual process and original compiled/generated bytes', () => {
  const { context, job } = processFixture();
  const proof = controller.buildBackendLoadedProof(context, job, { maxRuntimeMtimeMs: Date.parse('2026-10-07T09:00:02Z'),
    bootstrapNotBeforeWallIso: '2026-10-07T09:00:03.000Z', observedAtWallIso: '2026-10-07T09:00:04.123Z' });
  assert.deepEqual(proof.command, context.command); assert.equal(proof.job.pid, job.pid); assert.equal(proof.phase, 'backend_loaded');
  assert.doesNotThrow(() => controller.assertBackendLoadedProof(context, proof));
  for (const changed of [{ ...proof, command: { ...proof.command, requestKey: 'different-key' } },
    { ...proof, runtime: { ...proof.runtime, compiledRuntimeSha256: '0'.repeat(64) } },
    { ...proof, job: { ...proof.job, plistSha256: '0'.repeat(64) } },
    { ...proof, observedAtWallIso: '2026-10-07T08:00:00.000Z' }])
    assert.throws(() => controller.assertBackendLoadedProof(context, changed), /LOADED_PROCESS/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-dev-scenario-rebuild-loaded-test-'));
  fs.chmodSync(directory, 0o700);
  try {
    controller.privateWrite(directory, 'backend-loaded.private.json', proof); const file = path.join(directory, 'backend-loaded.private.json'), original = fs.readFileSync(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => controller.privateWrite(directory, 'backend-loaded.private.json', { ...proof, job: { ...job, pid: 125 } }), /EEXIST/);
    assert.equal(fs.readFileSync(file).equals(original), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('cached metadata guard rejects any inode, bytes-time, mode or directory inventory drift without rehashing the engine', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-runtime-stat-test-')));
  try {
    const engine = path.join(directory, 'client/engine.node'), empty = path.join(directory, 'client/empty');
    fs.mkdirSync(empty, { recursive: true }); fs.writeFileSync(engine, Buffer.alloc(8192, 1));
    let guard = controller.createFileMetadataGuard({ files: [engine], trees: [path.dirname(engine)] });
    assert.doesNotThrow(guard.assertCurrent);
    const previous = fs.statSync(engine); fs.writeFileSync(engine, Buffer.alloc(8192, 2)); fs.utimesSync(engine, previous.atime, previous.mtime);
    assert.throws(guard.assertCurrent, /RUNTIME_METADATA/); // Restoring mtime cannot restore ctime.
    guard = controller.createFileMetadataGuard({ files: [engine], trees: [path.dirname(engine)] });
    fs.writeFileSync(path.join(empty, 'new.js'), 'new unverified module'); assert.throws(guard.assertCurrent, /RUNTIME_METADATA/);
    fs.unlinkSync(path.join(empty, 'new.js')); guard = controller.createFileMetadataGuard({ files: [engine], trees: [path.dirname(engine)] });
    fs.chmodSync(engine, 0o600); assert.throws(guard.assertCurrent, /RUNTIME_METADATA/);
    guard = controller.createFileMetadataGuard({ files: [engine], trees: [path.dirname(engine)] });
    const replacement = path.join(directory, 'replacement'); fs.writeFileSync(replacement, fs.readFileSync(engine)); fs.renameSync(replacement, engine);
    assert.throws(guard.assertCurrent, /RUNTIME_METADATA/);
    guard = controller.createFileMetadataGuard({ files: [engine], trees: [path.dirname(engine)] });
    fs.unlinkSync(engine); fs.symlinkSync(replacement, engine); assert.throws(guard.assertCurrent, /RUNTIME_METADATA/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a protected private-directory metadata identity tolerates new journal files while protected original evidence stays immutable', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-runtime-private-stat-test-')));
  try {
    fs.chmodSync(directory, 0o700); const original = path.join(directory, 'context.private.json'); fs.writeFileSync(original, '{}', { mode: 0o600 });
    const guard = controller.createFileMetadataGuard({ files: [original], protectedDirectories: [directory] });
    fs.writeFileSync(path.join(directory, 'journal.private.json'), 'new progress', { mode: 0o600 }); assert.doesNotThrow(guard.assertCurrent);
    fs.chmodSync(directory, 0o755); assert.throws(guard.assertCurrent, /RUNTIME_METADATA/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('cached file stat check reads no engine bytes and ancestor identity rejects a same-inode file reached through a new parent link', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-runtime-parent-stat-test-')));
  try {
    const parent = path.join(directory, 'client'), originalParent = path.join(directory, 'original-client'); fs.mkdirSync(parent);
    const engine = path.join(parent, 'engine.node'); fs.writeFileSync(engine, 'unchanged original engine');
    const guard = controller.createFileMetadataGuard({ files: [engine] }), read = fs.readFileSync;
    fs.readFileSync = () => { throw Error('per-command engine byte reads forbidden'); };
    try { assert.doesNotThrow(guard.assertCurrent); } finally { fs.readFileSync = read; }
    fs.renameSync(parent, originalParent); fs.symlinkSync(originalParent, parent, 'dir');
    assert.throws(guard.assertCurrent, /RUNTIME_METADATA/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('loaded-proof recovery first reads the original committed cast/receipt, then verifies current source and process; it never invokes maintenance', async () => {
  const f = fixture(), events = [], context = { plan: f.plan, command: {}, privateDirectory: '/private/original', expectedPort: 5432 };
  const result = await controller.runRecoverLoadedProof(['--recover-loaded-proof', '--private-dir', context.privateDirectory], {
    context: async () => context, target: async () => ({ port: 5432 }), api: async () => events.push('api'),
    bindTarget: async () => events.push('physical_identity'),
    resume: async () => { events.push('original_receipt_and_cast'); return { phase: 'master_provisioned', receipt: f.receipt }; },
    recoverLoaded: async (_context, receipt) => { assert.deepEqual(receipt, f.receipt); events.push('source_runtime_process_and_exclusive_proof'); return { replayed: false, job: { pid: 123 } }; },
  });
  assert.deepEqual(events, ['api', 'physical_identity', 'original_receipt_and_cast', 'source_runtime_process_and_exclusive_proof']);
  assert.equal(result.phase, 'backend_loaded_verified'); assert.equal(result.currentDevRebuilt, true); assert.equal(result.canReseed, false);
  assert.equal(result.businessDriverComplete, false); assert.doesNotMatch(JSON.stringify(result), /password|master"/);
});

test('loaded-proof recovery refuses missing original receipt and preserves a known commit if runtime proof cannot be recovered', async () => {
  for (const receiptPresent of [false, true]) {
    const f = fixture(), context = { plan: f.plan, privateDirectory: '/private/original', expectedPort: 5432 };
    let writes = 0;
    const result = await controller.runRecoverLoadedProof(['--recover-loaded-proof', '--private-dir', context.privateDirectory], {
      context: async () => context, target: async () => ({ port: 5432 }), api: async () => {},
      bindTarget: async () => {},
      resume: async () => receiptPresent ? { phase: 'master_provisioned', receipt: f.receipt } : { phase: 'unknown' },
      recoverLoaded: async () => { writes++; throw Error('DEV_APPLY_LOADED_PROCESS: old process'); },
    });
    assert.equal(writes, receiptPresent ? 1 : 0); assert.equal(result.phase, 'backend_loaded_recovery_required');
    assert.equal(result.currentDevRebuilt, receiptPresent ? true : null); assert.equal(result.commitStatus, receiptPresent ? 'acknowledged' : 'unknown');
    assert.equal(result.canReseed, false); assert.equal(result.businessDriverComplete, false);
  }
});

test('loaded-proof recovery never accepts even an identical cast/receipt from a different current physical API/SQL target', async () => {
  const f = fixture(); let originalReads = 0;
  const result = await controller.runRecoverLoadedProof(['--recover-loaded-proof', '--private-dir', '/private/original'], {
    context: async () => ({ plan: f.plan, privateDirectory: '/private/original', expectedPort: 5432 }), target: async () => ({ port: 5432 }), api: async () => {},
    bindTarget: async () => { throw Error('DEV_REBUILD_PHYSICAL_IDENTITY'); }, resume: async () => { originalReads++; return { phase: 'master_provisioned', receipt: f.receipt }; },
  });
  assert.equal(originalReads, 0); assert.equal(result.phase, 'backend_loaded_recovery_required'); assert.equal(result.currentDevRebuilt, null); assert.equal(result.canReseed, false);
});

test('missing loaded receipt is written once; original bytes are recovered after lost fsync ACK and never replaced', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-dev-scenario-rebuild-recovery-test-')));
  fs.chmodSync(directory, 0o700);
  const { context, job } = processFixture(); context.privateDirectory = directory;
  const candidate = controller.buildBackendLoadedProof(context, job, { maxRuntimeMtimeMs: Date.parse('2026-10-07T09:00:02Z'),
    bootstrapNotBeforeWallIso: '2026-10-07T09:00:03.000Z', observedAtWallIso: '2026-10-07T09:00:04.000Z', origin: 'observed_after_original_receipt' });
  const file = path.join(directory, 'backend-loaded.private.json');
  try {
    const sync = fs.fsyncSync;
    fs.fsyncSync = descriptor => { sync(descriptor); throw Object.assign(Error('ACK_LOST_AFTER_SYNC'), { code: 'EIO' }); };
    let recovered;
    try { recovered = controller.persistBackendLoadedProof(context, candidate); } finally { fs.fsyncSync = sync; }
    assert.equal(recovered.replayed, true); assert.deepEqual(recovered.proof, candidate);
    const bytes = fs.readFileSync(file), replacement = { ...candidate, job: { ...job, pid: 999, startedAtWallIso: '2026-10-07T09:01:03.000Z' }, observedAtWallIso: '2026-10-07T09:01:04.000Z' };
    assert.deepEqual(controller.persistBackendLoadedProof(context, replacement), { proof: candidate, replayed: true });
    assert.equal(fs.readFileSync(file).equals(bytes), true);
    fs.writeFileSync(file, '{incomplete'); const malformed = fs.readFileSync(file);
    assert.throws(() => controller.persistBackendLoadedProof(context, candidate)); assert.equal(fs.readFileSync(file).equals(malformed), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
