#!/usr/bin/env node
// Runs a reviewed list of backend tests in a detached source copy and a fresh
// PostgreSQL cluster. Never changes the existing dev environment or copies data.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { createAcceptanceDependencyLayout } = require('./acceptance-dependency-layout.cjs');
const { captureWorkingSource } = require('./acceptance-working-source.cjs');
const { validateUpgradeContract,verifyProfessionalQcUpgrade } = require('./acceptance-upgrade-contract.cjs');
const { validatePrivateUiRestore, validatePrivateUiUpgrade,restorePrivateUiFiles,restorePrivateUiAdditionalFiles } = require('./acceptance-ui-restore-contract.cjs');
const repo = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const batchPath = path.resolve(repo, process.argv[2] || 'artifacts/acceptance-20261001/execution/first-batch.json');
// An explicit immutable commit permits parallel workers to keep editing other
// lanes. The manifest AND runner must already exist unchanged at that commit.
const selectedHead = process.argv[3] === '--source-head' ? process.argv[4] : undefined;
const workingSource = process.argv[3] === '--working-source';
if ((process.argv.length > 3 && !['--source-head','--working-source'].includes(process.argv[3]))
  || (selectedHead !== undefined && !/^[0-9a-f]{40}$/.test(selectedHead))) throw Error('Use an exact 40-character source commit');
if (process.argv[3] === '--source-head' && !selectedHead) throw Error('An explicit source commit is required');
const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
if (batch.mode != null && !['interactive-ui', 'dev-scenario-rehearsal'].includes(batch.mode)) throw Error('Unreviewed acceptance mode');
if (!Array.isArray(batch.tests) || !batch.tests.length) throw Error('Explicit reviewed test list is required');
const scenarioRehearsal = batch.mode === 'dev-scenario-rehearsal';
if (scenarioRehearsal && (!workingSource || batch.upgrade || batch.restorePrivateUi
  || (batch.fixtures && batch.fixtures.length) || batch.tests.length !== 1
  || batch.tests[0].file !== 'server/acceptance-tests/fullBusinessScenarioDriverAcceptance.test.ts')) {
  throw Error('Dev scenario rehearsal requires exactly its dedicated test, a new empty cluster and a hashed working source');
}
const upgradeContract = validateUpgradeContract(repo,batch.upgrade,workingSource);
const fixtures = batch.fixtures ?? [];
if (!Array.isArray(fixtures) || fixtures.some(name => !['system-audit-sentinel', 'rollback-controls'].includes(name)) || new Set(fixtures).size !== fixtures.length) throw Error('Unreviewed acceptance fixture');
if (batch.restorePrivateUi && (batch.mode !== 'interactive-ui' || batch.upgrade || fixtures.length)) throw Error('Private UI restore cannot mix schema upgrades or reseeded facts');
if (batch.upgrade?.restorePrivateUi && (batch.mode !== 'interactive-ui' || batch.restorePrivateUi || fixtures.length
  || !Array.isArray(batch.upgrade.requirePopulatedTables) || !batch.upgrade.requirePopulatedTables.length
  || batch.upgrade.requirePopulatedTables.some(table => !['UserAccount', 'DevelopmentCase', 'SampleBatch', 'ProductAsset', 'AuditLog', 'CostRecord', 'CreditNoteRefund', 'CreditNoteRefundReturn', 'CreditNoteRefundEvidence'].includes(table)))) {
  throw Error('Populated private upgrade requires reviewed native tables and cannot reseed fixtures');
}
for (const test of batch.tests) {
  if (!/^server\/(src|acceptance-tests|ops-panel\/src)\/[^\n]+\.test\.ts$/.test(test.file) || test.file.includes('..') || !fs.existsSync(path.join(repo, test.file))) throw Error('Invalid test file: ' + test.file);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceRoot = path.join(repo, workingSource ? 'artifacts/acceptance-20261007/global-goal/runs' : 'artifacts/acceptance-20261001/execution/runs');
fs.mkdirSync(evidenceRoot, { recursive: true });
// Two independent batches can start in the same millisecond. Exclusive fresh
// directories prevent one run from replacing another run's proof files.
const evidenceDir = fs.mkdtempSync(path.join(evidenceRoot, stamp + '-'));
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-acceptance-')));
fs.chmodSync(sandbox, 0o700);
const workspace = path.join(sandbox, 'workspace');
const data = path.join(sandbox, 'postgres');
// The production clock guard intentionally accepts only this dev database
// name. The dedicated rehearsal still gets a brand-new private PG cluster;
// ordinary acceptance guards and database naming remain unchanged.
const dbName = scenarioRehearsal ? 'panda_hub_dev' : 'bambook_acceptance_' + crypto.randomBytes(6).toString('hex');
const scenarioNonce = scenarioRehearsal ? crypto.randomBytes(32).toString('hex') : undefined;
const scenarioClockEnv = scenarioRehearsal ? { BAMBOOK_DEV_PANEL: '1',
  BAMBOOK_DEV_BUSINESS_TIME: '2026-10-08T00:18:00.000Z', BAMBOOK_SCENARIO_REHEARSAL_NONCE: scenarioNonce } : {};
const logPath = path.join(evidenceDir, 'run.log');
const privateFilesDir = path.join(sandbox, 'private-files');
fs.mkdirSync(privateFilesDir, { mode: 0o700 });
const environment = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: 'en_US.UTF-8', TMPDIR: sandbox, CHECKPOINT_DISABLE: '1',
  BAMBOOK_PRIVATE_FILES_DIR: privateFilesDir };
let started = false;
let stopping = false;
let activeChild;
const activeGroups = new Set();
let binDir;
const summary = { batch: batch.id, runnerPid: process.pid, startedAt: new Date().toISOString(), sourceHead: '', status: 'preparing', sandbox, evidenceDir, tests: batch.tests, fixtures,
  boundary: 'Node socket guard plus independent PostgreSQL identity; not an OS/native-engine network sandbox',
  claims: { wholeProductPassed: false, uiPassed: false, realRoleHandoffsPassed: false } };
const save = () => fs.writeFileSync(path.join(evidenceDir, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
function run(command, args, cwd = repo, env = environment) {
  return new Promise((resolve, reject) => {
    fs.appendFileSync(logPath, '$ ' + path.basename(command) + ' ' + args.join(' ') + '\n');
    const child = cp.spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    activeGroups.add(child.pid);
    child.stdout.on('data', bytes => fs.appendFileSync(logPath, bytes));
    child.stderr.on('data', bytes => fs.appendFileSync(logPath, bytes));
    child.on('error', reject);
    child.on('close', code => { activeGroups.delete(child.pid); if (activeChild === child) activeChild = undefined; code === 0 ? resolve() : reject(Object.assign(new Error(path.basename(command) + ' exited ' + code), { exitCode: code })); });
  });
}
const read = (command, args, cwd = repo, env = environment) => cp.execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function stop() {
  if (stopping) return;
  stopping = true;
  const groups = [...activeGroups];
  for (const pid of groups) { try { process.kill(-pid, 'SIGTERM'); } catch {} }
  if (groups.length) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    for (const pid of groups) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  }
  if (started) {
    try { await run(path.join(binDir, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop']); summary.postgresStopped = true; }
    catch (e) { summary.postgresStopped = false; summary.stopError = e.message; }
  }
  summary.finishedAt = new Date().toISOString();
  const denials = path.join(sandbox, 'network-denials.jsonl');
  summary.networkDenials = fs.existsSync(denials) ? fs.readFileSync(denials, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  save();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { summary.status = 'interrupted'; await stop(); process.exit(130); });
async function main() {
  summary.sourceHead = selectedHead ?? read('git', ['rev-parse', 'HEAD']);
  summary.sourceSelection = workingSource ? 'hashed current working source; not the Git HEAD revision' : selectedHead ? 'explicit immutable commit; working changes excluded' : 'clean current HEAD';
  const codeDirty = read('git', ['status', '--porcelain', '--', 'server/src', 'server/ops-panel/src', 'server/acceptance-tests', 'server/prisma', 'server/vitest.config.ts', 'server/acceptance.vitest.config.ts', 'scripts/acceptance-isolated-run.cjs', 'scripts/acceptance-dependency-layout.cjs', 'scripts/acceptance-working-source.cjs', 'scripts/acceptance-upgrade-contract.cjs', 'scripts/acceptance-ui-restore-contract.cjs', 'scripts/acceptance-network-guard.cjs', 'scripts/acceptance-fixtures.cjs']);
  if (codeDirty && !selectedHead && !workingSource) throw Error('Commit the executable source and guard before running an immutable copy, or explicitly use --working-source for a hashed private WIP snapshot');
  if (selectedHead) {
    const committed = relative => cp.execFileSync('git', ['show', summary.sourceHead + ':' + relative], { cwd: repo, env: environment, maxBuffer: 20 * 1024 * 1024 });
    if (sha(committed('scripts/acceptance-isolated-run.cjs')) !== sha(fs.readFileSync(__filename))) throw Error('The invoked runner must match the selected commit');
    if (sha(committed('scripts/acceptance-dependency-layout.cjs')) !== sha(fs.readFileSync(path.join(repo, 'scripts/acceptance-dependency-layout.cjs')))) throw Error('The dependency layout helper must match the selected commit');
    if (sha(committed('scripts/acceptance-ui-restore-contract.cjs')) !== sha(fs.readFileSync(path.join(repo, 'scripts/acceptance-ui-restore-contract.cjs')))) throw Error('The restore contract must match the selected commit');
    if (sha(committed('scripts/acceptance-upgrade-contract.cjs')) !== sha(fs.readFileSync(path.join(repo, 'scripts/acceptance-upgrade-contract.cjs')))) throw Error('The schema upgrade contract must match the selected commit');
    const relativeBatch = path.relative(repo, batchPath).split(path.sep).join('/');
    if (relativeBatch.startsWith('../') || sha(committed(relativeBatch)) !== sha(fs.readFileSync(batchPath))) throw Error('The manifest must match the selected commit');
    for (const test of batch.tests) committed(test.file); // All requested tests must be present in the immutable source.
  }
  summary.batchSha256 = sha(fs.readFileSync(batchPath));
  summary.runnerSha256 = sha(fs.readFileSync(__filename));
  binDir = read('pg_config', ['--bindir']);
  const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  summary.database = { host: '127.0.0.1', port, name: dbName, schema: 'public', provision: 'new cluster and empty database; Prisma db push --skip-generate, not migration/upgrade proof' };
  if (workingSource) {
    const relativeBatch = path.relative(repo,batchPath).split(path.sep).join('/');
    const files = cp.execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:repo,maxBuffer:32*1024*1024}).toString().split('\0').filter(Boolean).filter(file=>fs.existsSync(path.join(repo,file)));
    const captured = captureWorkingSource({repo,workspace,relativeFiles:files,extraFiles:[relativeBatch,...upgradeContract.extraFiles]});
    summary.workingSource = {kind:captured.kind,sha256:captured.sha256,boundary:captured.boundary,manifest:'source-files.json'};
    fs.writeFileSync(path.join(evidenceDir,'source-files.json'),JSON.stringify(captured.files,null,2)+'\n');
  } else {
    await run('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, workspace]);
    await run('git', ['checkout', '--quiet', '--detach', summary.sourceHead], workspace);
  }
  const dependencyLayout = createAcceptanceDependencyLayout({ sandbox, workspace,
    sharedRootModules: path.join(repo, 'node_modules'), sharedServerModules: path.join(repo, 'server/node_modules') });
  summary.dependencyLayout = dependencyLayout;
  // Prisma generation still owns a physically copied package and private .prisma.
  const sharedModules = dependencyLayout.server.sharedInputRoot;
  const privateModules = dependencyLayout.server.path;
  const sharedClientFiles = ['.prisma/client/schema.prisma', '.prisma/client/index.js'];
  const sharedClientHashes = sharedClientFiles.map(file => sha(fs.readFileSync(path.join(sharedModules, file))));
  const url = `postgresql://acceptance@127.0.0.1:${port}/${dbName}?schema=public`;
  const envText = `DATABASE_URL=${url}\nJWT_SECRET=acceptance-only-secret-at-least-32-chars\nBAMBOOK_NO_SCHEDULER=1\nBAMBOOK_UPLOAD_DIR=${sandbox}/uploads\n`
    + Object.entries(scenarioClockEnv).map(([key, value]) => `${key}=${value}\n`).join('');
  for (const relative of ['.env', '.env.local', 'server/.env', 'server/.env.local']) fs.writeFileSync(path.join(workspace, relative), envText, { mode: 0o600 });
  await run(process.execPath, [path.join(privateModules, 'prisma/build/index.js'), 'generate', '--schema', 'prisma/schema.prisma'], path.join(workspace, 'server'), {
    ...environment, DATABASE_URL: url, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NODE_ENV: 'test',
  });
  if (sharedClientFiles.some((file, index) => sha(fs.readFileSync(path.join(sharedModules, file))) !== sharedClientHashes[index])) throw Error('Shared generated Prisma client changed');
  const privateClient = fs.realpathSync(path.join(privateModules, '.prisma/client'));
  if (!privateClient.startsWith(sandbox + path.sep)) throw Error('Generated Prisma client escaped the sandbox');
  summary.privateGeneratedClient = { path: privateClient, sharedClientUnchanged: true, sourceSchemaSha256: sha(fs.readFileSync(path.join(workspace, 'server/prisma/schema.prisma'))) };
  if (batch.typecheck === true) {
    await run(process.execPath, [path.join(workspace, 'server/node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.json'], path.join(workspace, 'server'));
    summary.typecheck = { status: 'passed', project: 'server/tsconfig.json', sourceHead: summary.sourceHead };
  }
  summary.schemaSha256 = sha(fs.readFileSync(path.join(workspace, 'server/prisma/schema.prisma')));
  const restore = batch.restorePrivateUi ? validatePrivateUiRestore(repo, batch.restorePrivateUi, summary.schemaSha256) : null;
  summary.files = Object.fromEntries([...batch.tests.map(test => test.file), 'server/acceptance-tests/environment.test.ts', 'server/src/test-setup.ts', 'server/acceptance.vitest.config.ts', 'scripts/acceptance-dependency-layout.cjs', 'scripts/acceptance-working-source.cjs', 'scripts/acceptance-upgrade-contract.cjs', 'scripts/acceptance-ui-restore-contract.cjs', 'scripts/acceptance-network-guard.cjs', 'scripts/acceptance-fixtures.cjs', ...(batch.mode === 'interactive-ui' ? ['scripts/acceptance-ui-fixtures.cjs'] : [])].map(file => [file, sha(fs.readFileSync(path.join(workspace, file)))]));
  summary.environment = { node: process.version, postgres: read('pg_config', ['--version']),
    vitest: JSON.parse(fs.readFileSync(path.join(workspace, 'server/node_modules/vitest/package.json'))).version,
    prisma: JSON.parse(fs.readFileSync(path.join(workspace, 'server/node_modules/@prisma/client/package.json'))).version,
    dependencies: 'ordinary dependency symlinks are logical read inputs; cache containers and Prisma client package/generated code are private, not OS-enforced filesystem isolation',
    generatedClientSchemaSha256: sha(fs.readFileSync(path.join(workspace, 'server/node_modules/.prisma/client/schema.prisma'))),
    generatedClientSha256: sha(fs.readFileSync(path.join(workspace, 'server/node_modules/.prisma/client/index.js'))),
    packageLockSha256: sha(fs.readFileSync(path.join(workspace, 'server/package-lock.json'))) };
  for (const directory of ['uploads', 'tmp']) fs.mkdirSync(path.join(sandbox, directory));
  const runtimeEnv = { ...environment, ...scenarioClockEnv, DATABASE_URL: url, BAMBOOK_ACCEPTANCE_DATABASE_URL: url, NODE_ENV: 'test', JWT_SECRET: 'acceptance-only-secret-at-least-32-chars', BAMBOOK_NO_SCHEDULER: '1', BAMBOOK_UPLOAD_DIR: path.join(sandbox, 'uploads'),
    BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_PORT: String(port), BAMBOOK_ACCEPTANCE_DB_NAME: dbName, BAMBOOK_ACCEPTANCE_DB_DIR: data, NO_PROXY: '127.0.0.1,localhost,::1' };
  await run(path.join(binDir, 'initdb'), ['-D', data, '-U', 'acceptance', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--no-locale']);
  // Bind only loopback; the cluster's Unix socket also stays inside the sandbox.
  fs.appendFileSync(path.join(data, 'postgresql.conf'), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = '${sandbox.replaceAll("'", "''")}'\n`);
  started = true;
  await run(path.join(binDir, 'pg_ctl'), ['-D', data, '-l', path.join(sandbox, 'postgres.log'), '-w', 'start']);
  await run(path.join(binDir, 'createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance', dbName]);
  const identity = read(path.join(binDir, 'psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance', '-d', dbName, '-At', '-c', "SELECT current_database() || '|' || current_setting('data_directory') || '|' || inet_server_port()"]);
  if (identity !== `${dbName}|${data}|${port}`) throw Error('Independent cluster identity mismatch');
  summary.database.identityVerified = true;
  if (scenarioRehearsal) {
    fs.writeFileSync(path.join(sandbox, 'scenario-rehearsal-target.json'), JSON.stringify({
      nonce: scenarioNonce, databaseUrl: url, directory: data, port, database: dbName,
      sourceSha256: summary.workingSource.sha256, clock: scenarioClockEnv.BAMBOOK_DEV_BUSINESS_TIME,
    }), { mode: 0o600, flag: 'wx' });
    summary.scenarioRehearsal = { privateCluster: true, businessClock: scenarioClockEnv.BAMBOOK_DEV_BUSINESS_TIME,
      existingDevUntouched: true, targetGuard: 'dedicated scenario guard; ordinary acceptance guard unchanged' };
    // db push cannot install the dev-only privileged hash helper. Run its
    // exact captured migration only after independent private cluster proof;
    // ordinary acceptance databases and the user's current dev are untouched.
    const physicalIdentityMigration = path.join(workspace, 'server/prisma/migrations/20261007320000_scenario_physical_identity/migration.sql');
    await run(path.join(binDir, 'psql'), ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance',
      '-d', dbName, '-f', physicalIdentityMigration]);
    summary.scenarioRehearsal.physicalIdentityHelperSha256 = sha(fs.readFileSync(physicalIdentityMigration));
  }
  let upgradeRestore = null;
  if (batch.upgrade) {
    const oldSchema = path.join(sandbox, 'before.prisma');
    fs.writeFileSync(oldSchema, batch.upgrade.fromSchema
      ? fs.readFileSync(path.join(workspace,batch.upgrade.fromSchema.file))
      : cp.execFileSync('git', ['show', `${batch.upgrade.fromHead}:server/prisma/schema.prisma`], { cwd: repo }));
    if (batch.upgrade.fromSchema && sha(fs.readFileSync(oldSchema)) !== batch.upgrade.fromSchema.sha256) throw Error('Before-schema snapshot hash mismatch');
    await run(process.execPath, [path.join(privateModules, 'prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', oldSchema], path.join(workspace, 'server'), runtimeEnv);
    let beforeData = null;
    let originalColumns = null;
    let originalAuthorization = null;
    const queryUpgrade = sql => read(path.join(binDir, 'psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance', '-d', dbName, '-At', '-c', sql]);
    const authorizationRows = () => JSON.parse(queryUpgrade(`SELECT json_build_object(
      'permissions',(SELECT coalesce(json_agg(row_to_json(p) ORDER BY p."id"),'[]') FROM "Permission" p),
      'grants',(SELECT coalesce(json_agg(row_to_json(g) ORDER BY g."id"),'[]') FROM "RolePermission" g),
      'roles',(SELECT coalesce(json_agg(row_to_json(r) ORDER BY r."id"),'[]') FROM "Role" r))`));
    const sqlIdentifier = value => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw Error('Unexpected native schema identifier');
      return '"' + value + '"';
    };
    const dataFingerprint = () => {
      const query = sql => read(path.join(binDir, 'psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance', '-d', dbName, '-At', '-c', sql]);
      if (!originalColumns) {
        const inventory = JSON.parse(query("SELECT coalesce(json_agg(facts ORDER BY facts.table_name),'[]') FROM (SELECT t.table_name,array_agg(c.column_name ORDER BY c.ordinal_position) AS columns FROM information_schema.tables t JOIN information_schema.columns c ON c.table_schema=t.table_schema AND c.table_name=t.table_name WHERE t.table_schema='public' AND t.table_type='BASE TABLE' GROUP BY t.table_name) facts"));
        if (!inventory.length) throw Error('Original schema inventory is empty');
        originalColumns = Object.fromEntries(inventory.map(entry => {
          sqlIdentifier(entry.table_name);
          if (!Array.isArray(entry.columns) || !entry.columns.length) throw Error('Original table has no recorded columns');
          entry.columns.forEach(sqlIdentifier);
          return [entry.table_name, entry.columns];
        }));
      }
      // Every original column is compared, including existing native provenance.
      // Newly added nullable fields are not mistaken for changed historical data.
      return Object.fromEntries(Object.entries(originalColumns).map(([table, columns]) => {
        const oldAuthRows = originalAuthorization && (table === 'Permission' ? originalAuthorization.permissions : table === 'RolePermission' ? originalAuthorization.grants : null);
        const nativeTable = 'public.' + sqlIdentifier(table);
        const qualified = oldAuthRows
          ? `(SELECT * FROM ${nativeTable} WHERE "id" IN (${oldAuthRows.length ? oldAuthRows.map(row => "'" + row.id.replaceAll("'", "''") + "'").join(',') : 'NULL'})) preserved`
          : nativeTable;
        const projection = columns.map(sqlIdentifier).join(',');
        const sql = `SELECT json_build_object('count',count(*),'digest',md5(COALESCE(string_agg(row::text,E'\\n' ORDER BY row::text),''))) FROM (SELECT row_to_json(t) AS row FROM (SELECT ${projection} FROM ${qualified}) t) facts`;
        return [table, JSON.parse(query(sql))];
      }));
    };
    if (batch.upgrade.restorePrivateUi) {
      upgradeRestore = validatePrivateUiUpgrade(repo, batch.upgrade.restorePrivateUi, batch.upgrade.fromHead, sha(fs.readFileSync(oldSchema)), summary.schemaSha256);
      const target = read(path.join(binDir, 'psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance', '-d', dbName, '-At', '-c', "SELECT current_database() || '|' || current_setting('data_directory') || '|' || inet_server_port()"]);
      if (target !== `${dbName}|${data}|${port}` || sha(fs.readFileSync(upgradeRestore.backupFile)) !== upgradeRestore.archiveSha256) throw Error('Private populated upgrade target or archive changed');
      await run(path.join(binDir, 'pg_restore'), ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error', '-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance', '-d', dbName, upgradeRestore.backupFile]);
      await run(process.execPath, [path.join(privateModules, 'prisma/build/index.js'), 'migrate', 'diff', '--from-url', url, '--to-schema-datamodel', oldSchema, '--exit-code'], workspace, runtimeEnv);
      if (batch.upgrade.professionalQcScope) originalAuthorization = authorizationRows();
      beforeData = dataFingerprint();
      for (const table of batch.upgrade.requirePopulatedTables) if (!(beforeData[table]?.count > 0)) throw Error('Required old native table is empty: ' + table);
    }
    if (batch.upgrade.syntheticLegacySql) {
      if (upgradeRestore) throw Error('A legacy draft fixture cannot mix with restored business facts');
      const file=path.join(workspace,batch.upgrade.syntheticLegacySql.file);
      if (sha(fs.readFileSync(file)) !== batch.upgrade.syntheticLegacySql.sha256) throw Error('Legacy draft fixture hash mismatch');
      await run(path.join(binDir,'psql'),['-h','127.0.0.1','-p',String(port),'-U','acceptance','-d',dbName,'--single-transaction','-v','ON_ERROR_STOP=1','-f',file],workspace,runtimeEnv);
      if (batch.upgrade.professionalQcScope) originalAuthorization = authorizationRows();
      beforeData=dataFingerprint();
      if (!['UserAccount','DevelopmentCase','SampleBatch','DevelopmentSampleQualityReview'].every(table=>beforeData[table]?.count>0)) throw Error('Required synthetic legacy draft rows were not created');
      if (batch.upgrade.migrations.some(file => file.includes('20261007250000_supplier_commitments'))
        && !['PurchaseOrder','PurchaseLine','OutsourcingOrder','OutsourcingLine'].every(table=>beforeData[table]?.count>0)) throw Error('Required synthetic legacy supplier draft rows were not created');
    }
    for (const relative of batch.upgrade.migrations) {
      const file = path.join(workspace, relative);
      if (!fs.existsSync(file)) throw Error('Upgrade migration missing from fixed source: ' + relative);
      await run(path.join(binDir, 'psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance', '-d', dbName, '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', file], workspace, runtimeEnv);
    }
    // A mismatch is a failure. Do not silently repair an incomplete migration
    // with db push against the new schema before testing it.
    await run(process.execPath, [path.join(privateModules, 'prisma/build/index.js'), 'migrate', 'diff', '--from-url', url,
      '--to-schema-datamodel', path.join(workspace, 'server/prisma/schema.prisma'), '--exit-code'], workspace, runtimeEnv);
    summary.database.provision = 'isolated old schema + reviewed incremental migrations + zero schema diff; no shared/production database migration';
    summary.schemaUpgrade = { fromHead: batch.upgrade.fromHead, fromWorkingSchema:batch.upgrade.fromSchema, oldSchemaSha256: sha(fs.readFileSync(oldSchema)), migrations: Object.fromEntries(batch.upgrade.migrations.map(file => [file, sha(fs.readFileSync(path.join(workspace, file)))])), schemaDiffZero: true };
    if (batch.upgrade.professionalQcScope) {
      if (!originalAuthorization) throw Error('Professional QC upgrade requires an original authorization inventory');
      summary.schemaUpgrade.professionalQcScope = verifyProfessionalQcUpgrade(originalAuthorization, authorizationRows());
    }
    if (batch.upgrade.syntheticLegacySql) {
      const afterData=dataFingerprint();
      if(JSON.stringify(beforeData)!==JSON.stringify(afterData)) throw Error('Incremental migration changed original legacy draft facts');
      const supplierUnknownCheck = batch.upgrade.migrations.some(file => file.includes('20261007250000_supplier_commitments'))
        ? ' + (SELECT count(*) FROM "SupplierCommitmentRevision") + (SELECT count(*) FROM "SupplierContractCommandReceipt") + (SELECT count(*) FROM "SupplierFulfillmentFact") + (SELECT count(*) FROM "PurchaseOrder" WHERE "approvedCommitmentRevisionId" IS NOT NULL OR "businessOwnerId" IS NOT NULL OR "mainDeliveryLocationKey" IS NOT NULL OR "mainDeliveryLocation" IS NOT NULL) + (SELECT count(*) FROM "PurchaseLine" WHERE "requestedDeliveryDate" IS NOT NULL OR "supplierCommittedDeliveryDate" IS NOT NULL OR "retiredAt" IS NOT NULL) + (SELECT count(*) FROM "OutsourcingOrder" WHERE "approvedCommitmentRevisionId" IS NOT NULL OR "businessOwnerId" IS NOT NULL OR "paymentTerms" IS NOT NULL OR "mainDeliveryLocationKey" IS NOT NULL OR "mainDeliveryLocation" IS NOT NULL) + (SELECT count(*) FROM "OutsourcingLine" WHERE "orderLineId" IS NOT NULL OR "requestedDeliveryDate" IS NOT NULL OR "supplierCommittedDeliveryDate" IS NOT NULL OR "specification" IS NOT NULL OR "retiredAt" IS NOT NULL)' : '';
      const productionLineUnknownCheck = batch.upgrade.migrations.some(file => file.includes('20261007260000_factory_production_line_identity'))
        ? ' + (SELECT count(*) FROM "FactoryProductionLine") + (SELECT count(*) FROM "ProductionBatch" WHERE "productionLineId" IS NOT NULL OR "productionLineSnapshot" IS NOT NULL) + (SELECT count(*) FROM "OrderSampleCoverage" WHERE "productionLineIdentity" IS NOT NULL)' : '';
      const cashUnknownCheck = batch.upgrade.migrations.some(file => file.includes('20261007270000_company_cash_ledger'))
        ? ' + (SELECT count(*) FROM "CompanyCashAccount") + (SELECT count(*) FROM "CashAccountEntry") + (SELECT count(*) FROM "CashAccountCommandReceipt") + (SELECT count(*) FROM "PaymentVoucher" WHERE "companyAccountId" IS NOT NULL OR "cashEntryId" IS NOT NULL)' : '';
      const qcEvidenceUnknownCheck = batch.upgrade.migrations.some(file => file.includes('20261007280000_professional_qc_handoffs'))
        ? ' + (SELECT count(*) FROM "InspectionReport" WHERE "evidenceFiles" IS NOT NULL)' : '';
      const invented=read(path.join(binDir,'psql'),['-h','127.0.0.1','-p',String(port),'-U','acceptance','-d',dbName,'-At','-c',
        'SELECT (SELECT count(*) FROM "DevelopmentSampleQualityReview" WHERE "sampleVersionId" IS NOT NULL OR "reviewSequence" IS NOT NULL) + (SELECT count(*) FROM "DevelopmentVersionConfirmation") + (SELECT count(*) FROM "FactoryLoadingReceipt") + (SELECT count(*) FROM "InspectionReport" WHERE "productionSizeChecks" IS NOT NULL) + (SELECT count(*) FROM "FabricLineAllocation") + (SELECT count(*) FROM "Order" WHERE "orderPurpose" IS NOT NULL OR "internalPurpose" IS NOT NULL OR "internalDemandTeamId" IS NOT NULL OR "internalReceiverId" IS NOT NULL) + (SELECT count(*) FROM "OrderLine" WHERE "fulfillmentMode" IS NOT NULL OR "cmtIncludedItems" IS NOT NULL) + (SELECT count(*) FROM "OrderSampleCoverage" WHERE "materialProof" IS NOT NULL)' + supplierUnknownCheck + productionLineUnknownCheck + cashUnknownCheck + qcEvidenceUnknownCheck]);
      if(invented!=='0') throw Error('Upgrade invented exact-version, size-inspection, confirmation, loading or internal-material facts');
      summary.schemaUpgrade.syntheticLegacyData={fixture:batch.upgrade.syntheticLegacySql,originalRowsUnchanged:true,unknownFactsRemainUnknown:true,
        originalTables:beforeData,afterTables:afterData,boundary:'Synthetic draft and queued legacy records only; not native workflow acceptance or existing business data.'};
    }
    if (upgradeRestore) {
      const afterData = dataFingerprint();
      if (JSON.stringify(afterData) !== JSON.stringify(beforeData)) throw Error('Populated migration changed original business rows');
      const newlyAddedTables = read(path.join(binDir, 'psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance', '-d', dbName, '-At', '-c', "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"]).split('\n').filter(table => table && !Object.hasOwn(originalColumns, table));
      for (const table of newlyAddedTables) {
        const count = read(path.join(binDir, 'psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance', '-d', dbName, '-At', '-c', 'SELECT count(*) FROM public.' + sqlIdentifier(table)]);
        if (count !== '0') throw Error('Migration invented native facts in a newly added table: ' + table);
      }
      const shippingProvenanceAdded = !originalColumns.CostRecord?.includes('developmentShippingSource');
      if (shippingProvenanceAdded) {
        const inventedBindings = read(path.join(binDir, 'psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance', '-d', dbName, '-At', '-c', 'SELECT count(*) FROM "CostRecord" WHERE "developmentShippingSource" IS NOT NULL']);
        if (inventedBindings !== '0') throw Error('Migration invented shipment provenance for existing costs');
      }
      const credentialBytes = fs.readFileSync(upgradeRestore.credentialFile);
      if (sha(credentialBytes) !== upgradeRestore.credentialSha256) throw Error('Private populated upgrade credentials changed');
      fs.writeFileSync(path.join(sandbox, 'ui-credentials.json'), credentialBytes, { mode: 0o600 });
      const privateFiles=restorePrivateUiFiles(upgradeRestore,privateFilesDir);
      const additionalPrivateFiles=restorePrivateUiAdditionalFiles(upgradeRestore,sandbox);
      summary.schemaUpgrade.populatedSnapshot = { sourceHead: upgradeRestore.sourceHead, archiveSha256: upgradeRestore.archiveSha256,
        manifestSha256: upgradeRestore.manifestSha256, factsReseeded: false, targetIdentityVerified: true, oldSchemaDiffZero: true,
        originalRowsUnchanged: true, originalColumnInventory: originalColumns, newlyAddedTablesEmpty: newlyAddedTables, originalShippingProvenanceUnchanged: !shippingProvenanceAdded, legacyCostsUnbound: shippingProvenanceAdded ? true : undefined,privateFiles,additionalPrivateFiles,originalTables: beforeData, afterTables: afterData,
        limit: 'Synthetic native populated acceptance database only; not a production restore or human business approval.' };
    }
  } else {
    await run(process.execPath, [path.join(privateModules, 'prisma/build/index.js'), 'db', 'push', '--skip-generate'], path.join(workspace, 'server'), runtimeEnv);
  }
  if (restore) {
    // Identity is verified again immediately before native PG restore. No
    // shared cluster, approved-fact seed or schema-upgrade shortcut is allowed.
    const currentIdentity = read(path.join(binDir, 'psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance', '-d', dbName, '-At', '-c', "SELECT current_database() || '|' || current_setting('data_directory') || '|' || inet_server_port()"]);
    if (currentIdentity !== `${dbName}|${data}|${port}` || sha(fs.readFileSync(restore.backupFile)) !== restore.archiveSha256) throw Error('Private restore target or source changed');
    await run(path.join(binDir, 'pg_restore'), ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error', '-h', '127.0.0.1', '-p', String(port), '-U', 'acceptance', '-d', dbName, restore.backupFile]);
    await run(process.execPath, [path.join(privateModules, 'prisma/build/index.js'), 'migrate', 'diff', '--from-url', url,
      '--to-schema-datamodel', path.join(workspace, 'server/prisma/schema.prisma'), '--exit-code'], workspace, runtimeEnv);
    const credentialBytes = fs.readFileSync(restore.credentialFile);
    if (sha(credentialBytes) !== restore.credentialSha256) throw Error('Private browser credentials changed during restore');
    fs.writeFileSync(path.join(sandbox, 'ui-credentials.json'), credentialBytes, { mode: 0o600 });
    const privateFiles=restorePrivateUiFiles(restore,privateFilesDir);
    const additionalPrivateFiles=restorePrivateUiAdditionalFiles(restore,sandbox);
    summary.privateUiRestore = { sourceHead: restore.sourceHead, archiveSha256: restore.archiveSha256,
      sourceSchemaSha256: restore.sourceSchemaSha256, manifestSha256: restore.manifestSha256,
      targetIdentityVerified: true, schemaDiffZero: true, factsReseeded: false,privateFiles,additionalPrivateFiles,
      limits: 'Replays original synthetic native successes and defects; not valid customer approval, production recovery or schema upgrade qualification.' };
    summary.database.provision = 'new isolated cluster restored from hashed synthetic native UI04 snapshot; exact source schema checked, no facts reseeded';
  }
  // Native probes write only into distinct, runner-owned diagnostic directories.
  // These paths are evidence sinks, never business sources or authorization.
  const diagnosticEvidence = Object.fromEntries([
    ['BAMBOOK_CARTON_EVIDENCE_DIR', 'carton'],
    ['BAMBOOK_ATTACHMENT_READONLY_EVIDENCE', 'invoice-attachments'],
    ['BAMBOOK_ALIAS_PROBE_EVIDENCE_DIR', 'authorization-alias'],
    ['BAMBOOK_FINANCE_REFS_EVIDENCE_DIR', 'invoice-order-refs'],
  ].map(([name, leaf]) => {
    const directory = path.join(sandbox, 'native-diagnostics', leaf);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return [name, directory];
  }));
  summary.nativeDiagnosticEvidence = diagnosticEvidence;
  const guardEnv = { ...runtimeEnv, ...diagnosticEvidence, NODE_OPTIONS: '--require=' + path.join(workspace, 'scripts/acceptance-network-guard.cjs') };
  summary.status = 'executing'; save();
  // A separate prerequisite must pass before any business test is launched.
  await run(process.execPath, [path.join(workspace, 'server/node_modules/vitest/vitest.mjs'), 'run', '--config', 'acceptance.vitest.config.ts', 'acceptance-tests/environment.test.ts', '--reporter=json', '--outputFile=' + path.join(evidenceDir, 'environment-vitest.json')], path.join(workspace, 'server'), guardEnv);
  if (fixtures.length) await run(process.execPath, [path.join(workspace, 'scripts/acceptance-fixtures.cjs'), ...fixtures], path.join(workspace, 'server'), guardEnv);
  if (batch.mode === 'interactive-ui') {
    if (!restore && !upgradeRestore) await run(process.execPath, [path.join(workspace, 'scripts/acceptance-ui-fixtures.cjs')], path.join(workspace, 'server'), guardEnv);
    await run(process.execPath, [path.join(privateModules, 'typescript/bin/tsc'), '-p', 'tsconfig.json'], path.join(workspace, 'server'), guardEnv);
    const reservePort = () => new Promise((resolve, reject) => {
      const socket = net.createServer(); socket.once('error', reject);
      socket.listen(0, '127.0.0.1', () => { const chosen = socket.address().port; socket.close(() => resolve(chosen)); });
    });
    const apiPort = await reservePort(), frontendPort = await reservePort();
    // Private Vite needs the real symlinked dependency directory for font
    // assets, while allowing no other shared checkout files. Isolate its cache.
    const viteConfig = path.join(workspace, 'acceptance-ui.vite.config.mts');
    fs.writeFileSync(viteConfig, `import config from './vite.config.ts';\nimport fs from 'node:fs';\nexport default (env) => { const base = typeof config === 'function' ? config(env) : config; return { ...base, cacheDir: ${JSON.stringify(path.join(sandbox, 'vite-cache'))}, server: { ...base.server, fs: { allow: [${JSON.stringify(workspace)}, ${JSON.stringify(dependencyLayout.root.sharedInputRoot)}] } } }; };\n`);
    const launch = (command, args, cwd, env, readyText) => new Promise((resolve, reject) => {
      fs.appendFileSync(logPath, '$ ' + path.basename(command) + ' ' + args.join(' ') + '\n');
      const child = cp.spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      activeGroups.add(child.pid);
      let text = '', ready = false;
      const timeout = setTimeout(() => { reject(Error('Private UI service did not become ready')); }, 60_000);
      const output = bytes => {
        fs.appendFileSync(logPath, bytes); text = (text + bytes).slice(-20_000);
        if (!ready && text.includes(readyText)) { ready = true; clearTimeout(timeout); resolve(child.pid); }
      };
      child.stdout.on('data', output); child.stderr.on('data', output);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => {
        activeGroups.delete(child.pid); clearTimeout(timeout);
        if (!ready) reject(Error('Private UI service exited ' + code));
        else if (!stopping) { summary.status = 'service-failed'; summary.error = 'Private UI service exited ' + code; void stop().then(() => process.exit(1)); }
      });
    });
    const apiPid = await launch(process.execPath, [path.join(workspace, 'server/dist/index.js')], path.join(workspace, 'server'),
      { ...guardEnv, PORT: String(apiPort), BAMBOOK_REQUIRE_AUTH: 'true', BAMBOOK_DEV_PANEL: 'false' }, 'Sovereign Neural Core Online');
    const frontendPid = await launch(process.execPath, [path.join(workspace, 'node_modules/vite/bin/vite.js'), '--config', viteConfig, '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], workspace,
      { ...guardEnv, VITE_API_BASE_URL: '/api', VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`, BAMBOOK_ACCEPTANCE_UI_API_PORT: String(apiPort) }, 'Local:');
    summary.status = 'ready-for-private-browser';
    summary.live = { apiUrl: `http://127.0.0.1:${apiPort}`, frontendUrl: `http://127.0.0.1:${frontendPort}`, apiPid, frontendPid,
      credentialFile: path.join(sandbox, 'ui-credentials.json'), limits: 'Services running is not business/UI acceptance; all assertions and claims remain unqualified.' };
    save(); console.log(JSON.stringify({ status: summary.status, sourceHead: summary.sourceHead, evidence: evidenceDir, live: summary.live }));
    await new Promise(() => {}); // The owning session must stop both services and PG explicitly.
    return;
  }
  try {
    await run(process.execPath, [path.join(workspace, 'server/node_modules/vitest/vitest.mjs'), 'run', '--config', 'acceptance.vitest.config.ts', ...batch.tests.map(test => test.file.replace(/^server\//, '')), '--reporter=default', '--reporter=json', '--outputFile=' + path.join(evidenceDir, 'vitest.json')], path.join(workspace, 'server'), guardEnv);
    summary.status = 'executed';
  } catch (e) { summary.status = 'failed'; summary.executionError = e.message; }
  const reportPath = path.join(evidenceDir, 'vitest.json');
  if (scenarioRehearsal) {
    const scenarioReport = path.join(sandbox, 'scenario-execution.json');
    if (fs.existsSync(scenarioReport)) {
      // Fictional business results only. Never publish the private cast,
      // login tokens, DB environment or full command journal.
      const original = JSON.parse(fs.readFileSync(scenarioReport, 'utf8'));
      const publicReport = Object.fromEntries(['businessTime', 'configuration', 'clockEvidence', 'clockEvidenceError', 'expected', 'development', 'orders', 'counts', 'claims']
        .filter(key => Object.hasOwn(original, key)).map(key => [key, original[key]]));
      fs.writeFileSync(path.join(evidenceDir, 'scenario-execution.json'), JSON.stringify(publicReport, null, 2) + '\n');
      summary.scenarioResults = { file: 'scenario-execution.json',
        developmentReached: original.development.executions.filter(row => row.stopReached).length,
        ordersReached: original.orders.filter(row => row.stopReached).length, claims: original.claims };
    }
  }
  if (!fs.existsSync(reportPath)) { summary.status = 'incomplete'; summary.reportError = 'Vitest JSON evidence missing'; }
  else {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    summary.counts = Object.fromEntries(['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests'].map(key => [key, report[key]]));
    summary.assertions = report.testResults.flatMap(file => file.assertionResults.map(test => ({ file: path.relative(workspace, file.name), title: test.fullName, status: test.status, failureMessages: test.failureMessages })));
    summary.executedFiles = report.testResults.map(file => path.relative(workspace, file.name));
    summary.missingFiles = batch.tests.map(test => test.file).filter(file => !summary.executedFiles.includes(file));
    if (summary.missingFiles.length || !report.numTotalTests) summary.status = 'incomplete';
  }
  const denials = path.join(sandbox, 'network-denials.jsonl');
  summary.networkDenials = fs.existsSync(denials) ? fs.readFileSync(denials, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}
main().catch(e => { summary.status = 'blocked'; summary.error = e.message; }).finally(async () => {
  await stop();
  console.log(JSON.stringify({ status: summary.status, counts: summary.counts, error: summary.error, evidence: evidenceDir, postgresStopped: summary.postgresStopped }));
  process.exitCode = summary.status === 'executed' && summary.postgresStopped === true ? 0 : 1;
});
