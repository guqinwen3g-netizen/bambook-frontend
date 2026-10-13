/** Native atomic-writer integration tests in a fresh private PG restored from
 * the verified backup. Synthetic input plans test the writer boundary only;
 * they are NOT the 60-case business qualification accepted by the apply CLI. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const guard = require('./dev-scenario-database.cjs');
const recovery = require('./dev-scenario-recovery.cjs');
const pgBin = '/opt/homebrew/opt/postgresql@16/bin';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const source = relative => path.join(guard.root, relative);
const portAvailable = () => new Promise((resolve, reject) => {
  const socket = net.createServer(); socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
});
async function main() {
  const protectedRecovery = JSON.parse(fs.readFileSync(source('artifacts/acceptance-20261007/global-goal/dev-scenario/content-recovery-receipt.json'), 'utf8'));
  recovery.assertRestoreEvidence(protectedRecovery, protectedRecovery.after);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-dev-reset-rehearsal-'));
  fs.chmodSync(sandbox, 0o700);
  const data = path.join(sandbox, 'postgres'), port = await portAvailable();
  const env = { ...process.env, PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'reset_rehearsal', PGDATABASE: 'panda_hub_dev', PGPASSWORD: '' };
  for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGPASSFILE']) delete env[key];
  const run = (tool, args) => cp.execFileSync(path.join(pgBin, tool), args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const report = { protocolVersion: 1, sandbox, startedAt: new Date().toISOString(), database: { name: 'panda_hub_dev', host: '127.0.0.1', port },
    claims: { privateWriterIntegrationOnly: true, syntheticQualifiedPlan: true, currentDevUntouched: true, wholeProductPassed: false, business60Qualified: false },
    checks: {}, postgresStopped: false };
  let started = false, client, control, fence = false;
  try {
    run('initdb', ['-D', data, '-U', 'reset_rehearsal', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    run('pg_ctl', ['-D', data, '-l', path.join(sandbox, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${sandbox}`, '-w', 'start']);
    started = true;
    run('createdb', ['panda_hub_dev']);
    if (guard.hashFile(protectedRecovery.dump.path) !== protectedRecovery.dump.sha256) throw Error('PRIVATE_RESET_BACKUP_CHANGED');
    run('pg_restore', ['--exit-on-error', '--no-owner', '--no-acl', '--dbname', 'panda_hub_dev', protectedRecovery.dump.path]);
    const privateIdentity = run('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c',
      "SELECT current_database() || '|' || current_setting('data_directory') || '|' || inet_server_port()"] ).trim();
    assert.equal(privateIdentity, `panda_hub_dev|${data}|${port}`);
    run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', source('server/prisma/migrations/20261007320000_scenario_physical_identity/migration.sql')]);
    Object.assign(process.env, { DATABASE_URL: `postgresql://reset_rehearsal@127.0.0.1:${port}/panda_hub_dev?schema=public&connection_limit=1`,
      NODE_ENV: 'development', BAMBOOK_DEV_PANEL: '1', BAMBOOK_DEV_BUSINESS_TIME: '2026-10-08T00:18:00.000Z', BAMBOOK_NO_SCHEDULER: '1' });
    require(require.resolve('tsx/cjs', { paths: [source('server')] }));
    const { PrismaClient } = require(source('server/node_modules/@prisma/client'));
    const { executeExclusiveDevMasterRebuild, buildDevClearStatement } = require(source('server/scripts/full-business-sim/devExclusiveReset.ts'));
    const { createDevMasterPrivateDirectory, readCommittedDevMaster } = require(source('server/scripts/full-business-sim/provisionDevMaster.ts'));
    const { assertBusinessClockConfiguration } = require(source('server/src/shared/businessClock.ts'));
    assertBusinessClockConfiguration();
    client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    control = new PrismaClient({ datasources: { db: { url: `postgresql://reset_rehearsal@127.0.0.1:${port}/postgres?schema=public&connection_limit=1` } } });
    const original = guard.readOnlyBusinessSnapshot({ env: { NODE_ENV: 'development' }, pgEnv: env, port });
    assert.equal(recovery.sameDatabaseContent(original, protectedRecovery.before), true);
    const checkPrivateIdentity = async () => {
      const rows = await client.$queryRawUnsafe(`SELECT current_database() AS name, inet_server_port() AS port,
        inet_server_addr()::text AS address, current_setting('data_directory') AS directory, pg_backend_pid() AS pid,
        (SELECT datallowconn FROM pg_database WHERE datname=current_database()) AS allowed`);
      assert.equal(rows.length, 1); assert.equal(rows[0].name, 'panda_hub_dev'); assert.equal(rows[0].port, port);
      assert.equal(fs.realpathSync(rows[0].directory), fs.realpathSync(data)); assert.ok(['127.0.0.1', '127.0.0.1/32'].includes(rows[0].address));
      return rows[0];
    };
    const originalConnection = await checkPrivateIdentity();
    assert.equal(originalConnection.allowed, true);
    const readTriggers = () => client.$queryRawUnsafe(`SELECT c.relname AS table,t.tgname AS name,t.tgenabled::text AS state,
      pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C"`);
    const originalTriggers = await readTriggers();
    const controlIdentity = await control.$queryRawUnsafe("SELECT current_database() AS name,inet_server_port() AS port,current_setting('data_directory') AS directory");
    assert.equal(controlIdentity[0].name, 'postgres'); assert.equal(controlIdentity[0].port, port);
    assert.equal(fs.realpathSync(controlIdentity[0].directory), fs.realpathSync(data));
    await control.$executeRawUnsafe('ALTER DATABASE "panda_hub_dev" ALLOW_CONNECTIONS false'); fence = true;
    assert.equal((await checkPrivateIdentity()).allowed, false);
    const newcomer = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    try { await assert.rejects(newcomer.$connect(), /not currently accepting connections|does not allow connections/i); }
    finally { await newcomer.$disconnect(); }
    report.checks.newConnectionsActuallyRejected = true;
    // This callback also runs inside the dev interactive transaction. Query
    // through the independent control connection so the single dev connection
    // never waits for itself while holding the transaction's table locks.
    const assertMaintenanceHeld = async () => {
      const state = await control.$queryRawUnsafe(`SELECT (SELECT datallowconn FROM pg_database WHERE datname='panda_hub_dev') AS allowed,
        EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='panda_hub_dev' AND pid=${originalConnection.pid}) AS original_alive`);
      assert.equal(state.length, 1); assert.equal(state[0].allowed, false); assert.equal(state[0].original_alive, true);
    };
    const sourceSha256 = sha(Buffer.concat(['server/scripts/full-business-sim/devExclusiveReset.ts', 'server/scripts/full-business-sim/masterData.ts',
      'server/scripts/full-business-sim/provisionDevMaster.ts'].map(file => fs.readFileSync(source(file)))));
    const makePlan = key => {
      const plan = { protocolVersion: 1, phase: 'reviewable_preflight', namespace: `reset-${key}`, requestKey: `private-native-reset-${key}`,
        database: 'panda_hub_dev', port, businessTime: '2026-10-08T00:18:00.000Z', preserveTables: ['_prisma_migrations'],
        clearTables: original.tables.map(row => row.name).filter(name => name !== '_prisma_migrations'),
        qualified: { sourceSha256, schemaSha256: guard.hashFile(source('server/prisma/schema.prisma')), developmentReached: 24, ordersReached: 36,
          businessTime: '2026-10-08T00:18:00.000Z' }, backup: { businessSha256: original.businessSha256, migrationsSha256: original.migrationsSha256 } };
      return { ...plan, planSha256: sha(JSON.stringify(canonical(plan))) };
    };
    const rollbackPlan = makePlan('rollback'), rollbackDirectory = createDevMasterPrivateDirectory(sandbox);
    const rollbackClient = new Proxy(client, { get(target, key) {
      if (key === '$transaction') return (work, options) => target.$transaction(tx => work(new Proxy(tx, { get(inner, name) {
        if (name === 'auditLog') return new Proxy(inner.auditLog, { get(audit, action) {
          if (action === 'create') return async () => { throw Error('PRIVATE_NATIVE_ORIGINAL_AUDIT_FAILED'); };
          const value = Reflect.get(audit, action); return typeof value === 'function' ? value.bind(audit) : value;
        } });
        const value = Reflect.get(inner, name); return typeof value === 'function' ? value.bind(inner) : value;
      } })), options);
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await assert.rejects(executeExclusiveDevMasterRebuild(rollbackClient, { plan: rollbackPlan, originalSnapshot: original,
      privateDirectory: rollbackDirectory, assertMaintenanceHeld }), /PRIVATE_NATIVE_ORIGINAL_AUDIT_FAILED/);
    // Reopen only for a full independent readonly content readback, then fence
    // the same private DB again. No real/current DB is connected by this test.
    await control.$executeRawUnsafe('ALTER DATABASE "panda_hub_dev" ALLOW_CONNECTIONS true'); fence = false;
    const afterRollback = guard.readOnlyBusinessSnapshot({ env: { NODE_ENV: 'development' }, pgEnv: env, port });
    assert.equal(recovery.sameDatabaseContent(original, afterRollback), true);
    assert.deepEqual(await readTriggers(), originalTriggers);
    const rollbackRecovery = await readCommittedDevMaster(client, { namespace: rollbackPlan.namespace, requestKey: rollbackPlan.requestKey,
      planSha256: rollbackPlan.planSha256, sourceSha256, privateDirectory: rollbackDirectory, expectedPort: port });
    assert.equal(rollbackRecovery.phase, 'unknown'); assert.equal(rollbackRecovery.canReseed, false);
    report.checks.failedAuditRolledBackEveryOriginalRowAndMigration = true;
    report.checks.missingOriginalCommitNeverGrantsReseed = true;
    await control.$executeRawUnsafe('ALTER DATABASE "panda_hub_dev" ALLOW_CONNECTIONS false'); fence = true;
    const plan = makePlan('success'), privateDirectory = createDevMasterPrivateDirectory(sandbox);
    const unknownClient = new Proxy(client, { get(target, key) {
      if (key === '$transaction') return async (...args) => { await target.$transaction(...args); throw Error('PRIVATE_NATIVE_COMMIT_ACK_LOST'); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await assert.rejects(executeExclusiveDevMasterRebuild(unknownClient, { plan, originalSnapshot: original, privateDirectory, assertMaintenanceHeld }), /PRIVATE_NATIVE_COMMIT_ACK_LOST/);
    const recovered = await readCommittedDevMaster(client, { namespace: plan.namespace, requestKey: plan.requestKey,
      planSha256: plan.planSha256, sourceSha256, privateDirectory, expectedPort: port });
    assert.equal(recovered.phase, 'master_provisioned'); assert.equal(recovered.canReseed, false);
    assert.equal(recovered.businessDriverComplete, false); assert.equal(Object.keys(recovered.master.cast).length, 21);
    const beforeHashes = await client.userAccount.findMany({ select: { id: true, passwordHash: true }, orderBy: { id: 'asc' } });
    const again = await readCommittedDevMaster(client, { namespace: plan.namespace, requestKey: plan.requestKey,
      planSha256: plan.planSha256, sourceSha256, privateDirectory, expectedPort: port });
    assert.deepEqual(again.receipt, recovered.receipt);
    assert.deepEqual(await client.userAccount.findMany({ select: { id: true, passwordHash: true }, orderBy: { id: 'asc' } }), beforeHashes);
    assert.equal(await client.userAccount.count(), 22); assert.equal(await client.order.count(), 0);
    assert.equal(await client.relation.count({ where: { category: 'Customer' } }), 35);
    assert.equal(await client.relation.count({ where: { category: 'Supplier' } }), 35);
    assert.deepEqual(await readTriggers(), originalTriggers);
    await assert.rejects(client.$executeRawUnsafe(buildDevClearStatement(original.tables.map(row => row.name))), /append-only.*TRUNCATE.*forbidden/s);
    assert.equal(await client.userAccount.count(), 22);
    report.checks.allOriginalTriggersPreservedAfterRollbackAndCommit = true;
    report.checks.normalTruncateStillForbiddenAfterMaintenance = true;
    report.checks.successfulUnknownCommitRecoveredExactOriginalCastAndReceipt = true;
    report.checks.recoveryNeverRotatesCredentials = true;
    report.originalReceipt = recovered.receipt;
    await control.$executeRawUnsafe('ALTER DATABASE "panda_hub_dev" ALLOW_CONNECTIONS true'); fence = false;
    const { verifyRuntimeIdentityRehearsal } = require(source('server/scripts/full-business-sim/runtimeIdentityRehearsal.ts'));
    report.runtimeIdentity = await verifyRuntimeIdentityRehearsal({ prisma: client, master: recovered.master,
      receipt: recovered.receipt, expectedPort: port, sandbox, databaseUrl: process.env.DATABASE_URL });
    const after = guard.readOnlyBusinessSnapshot({ env: { NODE_ENV: 'development' }, pgEnv: env, port });
    assert.equal(after.migrationsSha256, original.migrationsSha256);
    report.checks.originalMigrationLedgerPreserved = true;
    report.status = 'passed';
  } finally {
    if (fence && control) await control.$executeRawUnsafe('ALTER DATABASE "panda_hub_dev" ALLOW_CONNECTIONS true');
    await client?.$disconnect(); await control?.$disconnect();
    if (started) { run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); report.postgresStopped = true; }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(sandbox, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(source('artifacts/acceptance-20261007/global-goal/dev-scenario/reset-writer-rehearsal.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ status: report.status, postgresStopped: report.postgresStopped, checks: report.checks, currentDevUntouched: true }));
}
if (require.main === module) main().catch(error => {
  console.error('Private reset-writer rehearsal failed:', String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[private connection]'));
  process.exitCode = 1;
});
