#!/usr/bin/env node
'use strict';
/** Current-dev maintenance CLI. Importing it performs no HTTP, environment
 * loading, process mutation, Prisma construction or database access. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const preflight = require('./dev-scenario-rebuild.cjs');
const guards = require('./dev-scenario-database.cjs');
const { isSource } = require('./acceptance-working-source.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hashValue = value => sha(JSON.stringify(canonical(value)));
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code, message) => { throw Error(`DEV_APPLY_${code}: ${message}`); };
const LABEL = 'com.bambook.dev-server';
const FIXED = '2026-10-08T00:18:00.000Z';
const LOOPBACK = ['127.0.0.1', '::1', '127.0.0.1/32', '::1/128'];

function applyArguments(args) {
  const options = {};
  const allowed = ['--run-dir', '--backup-receipt', '--restore-receipt', '--namespace', '--request-key'];
  if (args[0] !== '--apply' || args.length !== 11) fail('USAGE', '--apply requires run-dir, backup-receipt, restore-receipt, namespace and original request-key.');
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || options[args[i]] || !args[i + 1]) fail('USAGE', 'Every explicit apply option must occur once.');
    options[args[i]] = args[i + 1];
  }
  return options;
}
function resumeArguments(args) {
  if (args.length !== 3 || args[0] !== '--resume' || args[1] !== '--private-dir' || !args[2]) fail('USAGE', '--resume --private-dir ORIGINAL_PRIVATE_DIRECTORY');
  return args[2];
}
function loadedRecoveryArguments(args) {
  if (args.length !== 3 || args[0] !== '--recover-loaded-proof' || args[1] !== '--private-dir' || !args[2])
    fail('USAGE', '--recover-loaded-proof --private-dir ORIGINAL_PRIVATE_DIRECTORY');
  return args[2];
}
function assertLaunchJob(plist, observation, repo) {
  const expected = ['/usr/local/bin/node', path.join(repo, 'server/dist/index.js')], env = plist?.EnvironmentVariables;
  const service = `gui/${observation.uid}/${LABEL}`, printed = observation.printed;
  const field = name => printed?.match(new RegExp(`^\\s*${name} = ([^\\n]+)$`, 'm'))?.[1].trim();
  const printedArgs = printed?.match(/^\s*arguments = \{\s*\n([\s\S]*?)^\s*\}/m)?.[1].trim().split('\n').map(row => row.trim());
  const pid = Number(field('pid'));
  if (!Number.isInteger(observation.uid) || observation.uid < 1 || plist?.Label !== LABEL || !same(plist.ProgramArguments, expected)
    || plist.WorkingDirectory !== path.join(repo, 'server') || env?.PORT !== '8081' || env.NODE_ENV !== 'development'
    || env.BAMBOOK_DEV_PANEL !== '1' || env.BAMBOOK_NO_SCHEDULER !== '1' || env.BAMBOOK_REQUIRE_AUTH !== 'true' || env.BAMBOOK_AUTH_REQUIRED !== 'true'
    || !printed?.startsWith(service + ' = {') || field('state') !== 'running' || field('path') !== observation.plistPath
    || field('program') !== expected[0] || !same(printedArgs, expected) || field('working directory') !== plist.WorkingDirectory
    || !Number.isSafeInteger(pid) || pid < 2 || !same(observation.listeners, [pid]) || observation.command !== expected.join(' ') || observation.cwd !== plist.WorkingDirectory)
    fail('JOB', 'The exact current-user launchd job, plist, PID, listener, arguments and cwd must agree.');
  return { uid: observation.uid, service, pid, plistPath: observation.plistPath, cwd: plist.WorkingDirectory, arguments: expected };
}
function assertMigrations(rows, hashes, compatibility) {
  const expected = Object.fromEntries(Object.entries(hashes ?? {}).map(([name, checksum]) => {
    if (!/^server\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(name) || !isHash(checksum)) fail('MIGRATIONS', 'Qualified source migration identity is invalid.');
    return [name.split('/')[3], checksum];
  }));
  if (compatibility !== undefined) {
    let baseline;
    try { baseline = preflight.validateMigrationBaselineBinding(compatibility); }
    catch { fail('MIGRATIONS', 'The original full-backup migration baseline or qualified source binding is invalid.'); }
    let rowsSha256;
    try { rowsSha256 = guards.migrationRowsSha256(rows); }
    catch { fail('MIGRATIONS', 'Complete original migration facts and full-row hashes are required.'); }
    const sorted = rows.map(row => ({ ...row })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (compatibility.zeroSchemaDiff !== true || compatibility.catalogSha256 !== baseline.originalCatalogSha256
      || !same(hashes, baseline.migrationSha256) || !same(sorted, baseline.rows) || rowsSha256 !== baseline.migrationsSha256)
      fail('MIGRATIONS', 'Only unchanged original backup history and a zero-diff original catalog permit legacy checksum compatibility.');
    const completed = new Map();
    for (const row of rows) {
      if (!Object.hasOwn(expected, row.name) || row.finishedAt != null && row.rolledBackAt != null
        || row.finishedAt == null && row.rolledBackAt == null)
        fail('MIGRATIONS', 'Unknown, unresolved or contradictory original migration history cannot authorize a rebuild.');
      if (row.rolledBackAt != null) continue; // An exact historical resolved attempt is retained, never counted as applied.
      if (completed.has(row.name) || !/^\d{8}(?:\d{6})?_/.test(row.name)
        || row.name.slice(0, 8) >= '20261007' && row.checksum !== expected[row.name])
        fail('MIGRATIONS', 'Duplicate applied history or a changed current-batch successful migration checksum is not allowed.');
      completed.set(row.name, row);
    }
    if (completed.size !== Object.keys(expected).length || Object.keys(expected).some(name => !completed.has(name)))
      fail('MIGRATIONS', 'Every qualified source migration must have exactly one successful original application.');
    return;
  }
  if (!Object.keys(expected).length || !Array.isArray(rows) || rows.length !== Object.keys(expected).length
    || new Set(rows.map(row => row.name)).size !== rows.length || rows.some(row => !Object.hasOwn(expected, row.name) || row.checksum !== expected[row.name]
      || row.finishedAt == null || !Number.isFinite(new Date(row.finishedAt).getTime()) || row.rolledBackAt != null))
    fail('MIGRATIONS', 'Every original applied migration must match its qualified source checksum, without failed, rolled-back or unknown entries.');
}
function assertMaintenanceConnections(dev, control, expectedPort) {
  if (!dev || !control || dev.name !== 'panda_hub_dev' || control.name !== 'postgres' || !Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535
    || dev.port !== expectedPort || control.port !== expectedPort || !LOOPBACK.includes(dev.address) || dev.address !== control.address
    || !Number.isSafeInteger(dev.pid) || dev.pid < 1 || !Number.isSafeInteger(control.pid) || control.pid < 1 || dev.pid === control.pid
    || typeof dev.startedAt !== 'string' || !dev.startedAt || dev.startedAt !== control.startedAt
    || !isHash(dev.instanceFingerprint) || control.instanceFingerprint !== null
    || !isHash(dev.clusterControlFingerprint) || dev.clusterControlFingerprint !== control.clusterControlFingerprint
    || typeof dev.user !== 'string' || !dev.user || dev.user !== control.user || dev.owner !== control.owner
    || !(dev.ownerMember === true || dev.superuser === true) || !(control.ownerMember === true || control.superuser === true)
    || dev.allowConnections !== true || control.allowConnections !== true)
    fail('CONTROL', 'Separate dev and postgres metadata connections must prove the same physical loopback cluster, target owner authority and original allow=true.');
}
function maintenanceUrl(target, database) {
  const pg = target?.pgEnv;
  if (!pg || pg.PGDATABASE !== 'panda_hub_dev' || !['localhost', '127.0.0.1', '::1'].includes(pg.PGHOST) || Number(pg.PGPORT) !== target.port
    || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || pg.PGHOSTADDR || pg.PGSERVICE || pg.PGSERVICEFILE
    || !['panda_hub_dev', 'postgres'].includes(database)) fail('TARGET', 'Only the verified dev datasource or same-cluster metadata control datasource is permitted.');
  const url = new URL('postgresql://127.0.0.1/panda_hub_dev');
  url.hostname = pg.PGHOST === '::1' ? '[::1]' : pg.PGHOST; url.port = String(target.port); url.pathname = '/' + database;
  url.username = pg.PGUSER ?? ''; url.password = pg.PGPASSWORD ?? '';
  url.searchParams.set('schema', 'public'); url.searchParams.set('connection_limit', '1');
  return url.toString();
}
function publicReceipt(receipt, plan) {
  const command = { namespace: plan.namespace, requestKey: plan.requestKey, planSha256: plan.planSha256, sourceSha256: plan.qualified.sourceSha256 };
  if (!receipt || receipt.protocolVersion !== 1 || receipt.phase !== 'master_provisioned' || Object.entries(command).some(([key, value]) => receipt[key] !== value)
    || !isHash(receipt.credentialsSha256) || typeof receipt.transactionId !== 'string' || !receipt.transactionId) fail('RECEIPT', 'Committed result does not match the original exact request/plan/source.');
  return { protocolVersion: 1, phase: 'master_provisioned', ...command, credentialsSha256: receipt.credentialsSha256, transactionId: receipt.transactionId };
}
async function runApply(args, deps) {
  const options = applyArguments(args);
  // Qualification is first: no process maintenance or Prisma construction is
  // authorized by a partial/failed/stale rehearsal or a counts-only backup.
  const plan = await deps.preflight(['--plan', ...args.slice(1)]), target = await deps.target();
  const runtimeProof = await deps.runtime(plan), verifiedJob = await deps.job();
  const privateDirectory = await deps.privateDirectory(), originalSnapshot = await deps.snapshot(target);
  if (originalSnapshot.businessSha256 !== plan.backup.businessSha256 || originalSnapshot.migrationsSha256 !== plan.backup.migrationsSha256)
    fail('BACKUP_STALE', 'Current complete content no longer matches the qualified recovery evidence.');
  const command = { namespace: plan.namespace, requestKey: plan.requestKey, planSha256: plan.planSha256, sourceSha256: plan.qualified.sourceSha256 };
  const qualifiedRunDirectory = deps.qualifiedDirectory ? await deps.qualifiedDirectory(options['--run-dir']) : path.resolve(options['--run-dir']);
  const context = { protocolVersion: 1, plan, command, expectedPort: plan.port, privateDirectory, qualifiedRunDirectory,
    preparedAtWallIso: new Date().toISOString(), originalSnapshot, verifiedJob, runtimeProof };
  await deps.privateWrite(privateDirectory, 'context.private.json', context);
  let stopAttempted = false, denyAttempted = false, writerStarted = false, session, result, failedAt, errorCode;
  const recoveryErrors = [];
  try {
    await deps.bindTarget(plan, target);
    stopAttempted = true; await deps.stop(verifiedJob); await deps.assertStopped(verifiedJob);
    session = await deps.connect(target, plan);
    const schemaProof = await deps.schema(session, target, plan);
    await deps.privateWrite(privateDirectory, 'maintenance-intent.private.json', { protocolVersion: 1, command,
      originalAllowConnections: true, identity: session.identity, verifiedJob, schemaProof, preparedAtWallIso: new Date().toISOString() });
    denyAttempted = true; await deps.deny(session);
    await deps.privateWrite(privateDirectory, 'maintenance-ack.private.json', { protocolVersion: 1, command, allowConnections: false, recordedAtWallIso: new Date().toISOString() });
    if (deps.closedSchema) await deps.closedSchema(session, schemaProof, plan);
    const assertMaintenanceHeld = async () => { await deps.assertStopped(verifiedJob); await deps.isolated(session); await deps.recheck(plan, runtimeProof); };
    await assertMaintenanceHeld();
    writerStarted = true;
    const execution = await deps.execute(session, { plan, originalSnapshot, privateDirectory, assertMaintenanceHeld });
    // Never assign an unvalidated writer result to a public response variable:
    // the genuine writer also returns private master/password information.
    result = publicReceipt(execution.receipt, plan);
    if (deps.closedSchema) { try { await deps.closedSchema(session, schemaProof, plan); } catch { recoveryErrors.push('post_commit_schema'); } }
  } catch (error) { failedAt = writerStarted ? 'writer_outcome_unknown' : 'maintenance_before_writer';
    errorCode = String(error?.message ?? '').match(/^(?:DEV_(?:APPLY|REBUILD|MASTER)|SCENARIO)_[A-Z_]+/)?.[0] ?? 'MAINTENANCE_FAILURE'; }
  finally {
    if (denyAttempted && session) { try { await deps.allow(session); } catch { recoveryErrors.push('restore_allow'); } }
    if (session) { try { await deps.disconnect(session); } catch { recoveryErrors.push('disconnect'); } }
    if (stopAttempted) {
      try {
        const loaded = await deps.restore(verifiedJob, context);
        assertBackendLoadedProof(context, loaded);
        await deps.privateWrite(privateDirectory, 'backend-loaded.private.json', loaded);
      } catch { recoveryErrors.push('bootstrap_health_or_loaded_proof'); }
    }
  }
  const response = { protocolVersion: 1, phase: result ? recoveryErrors.length ? 'master_rebuilt_recovery_required' : 'master_rebuilt' : writerStarted ? 'unknown' : 'failed_before_rebuild',
    namespace: plan.namespace, requestKey: plan.requestKey, privateDirectory, currentDevRebuilt: result ? true : writerStarted ? null : false,
    commitStatus: result ? 'acknowledged' : writerStarted ? 'unknown' : 'not_started', businessDriverComplete: false,
    canReseed: false, ...(result ? { receipt: result } : { reason: failedAt, errorCode }), recoveryErrors };
  // This file contains no cast/password. A lost write acknowledgement still
  // leaves the original context/cast/transaction receipt available to resume.
  try { await deps.privateWrite(privateDirectory, 'public-receipt.json', response); }
  catch { response.recoveryErrors.push('public_receipt_file'); if (result) response.phase = 'master_rebuilt_recovery_required'; }
  return response;
}
async function runResume(args, deps) {
  const privateDirectory = resumeArguments(args), context = await deps.context(privateDirectory), target = await deps.target();
  if (target.port !== context.expectedPort) fail('TARGET', 'Resume must read the original exact development database port.');
  try {
    await deps.api();
    await deps.bindTarget(context.plan, target);
    const original = await deps.resume(context, target);
    if (original.phase !== 'master_provisioned') return { protocolVersion: 1, phase: 'unknown', privateDirectory: context.privateDirectory,
      currentDevRebuilt: null, commitStatus: 'unknown', businessDriverComplete: false, canReseed: false, reason: 'ORIGINAL_TRANSACTION_RECEIPT_MISSING' };
    return { protocolVersion: 1, phase: 'master_rebuilt', privateDirectory: context.privateDirectory, currentDevRebuilt: true,
      commitStatus: 'acknowledged', businessDriverComplete: false, canReseed: false, replayed: true, receipt: publicReceipt(original.receipt, context.plan) };
  } catch { return { protocolVersion: 1, phase: 'unknown', privateDirectory: context.privateDirectory, currentDevRebuilt: null, commitStatus: 'unknown',
    businessDriverComplete: false, canReseed: false, reason: 'ORIGINAL_RECEIPT_OR_MAINTENANCE_RECOVERY_REQUIRED' }; }
}
/** This recovery only reads the original committed master/cast and current
 * runtime. It may add the missing immutable loaded receipt once; it never
 * changes admission, launchd, data, credentials or the original context. */
async function runRecoverLoadedProof(args, deps) {
  const directory = loadedRecoveryArguments(args), context = await deps.context(directory), target = await deps.target();
  if (target.port !== context.expectedPort) fail('TARGET', 'Loaded-proof recovery must use the original exact development database port.');
  let receipt;
  try {
    await deps.api();
    await deps.bindTarget(context.plan, target);
    const original = await deps.resume(context, target);
    if (original.phase !== 'master_provisioned') fail('RECOVERY_ORIGINAL_RECEIPT', 'The original committed receipt and exact private cast must be readable before runtime recovery.');
    receipt = publicReceipt(original.receipt, context.plan);
    const proof = await deps.recoverLoaded(context, receipt);
    return { protocolVersion: 1, phase: 'backend_loaded_verified', privateDirectory: context.privateDirectory,
      currentDevRebuilt: true, commitStatus: 'acknowledged', receipt, replayed: proof.replayed,
      businessDriverComplete: false, canReseed: false };
  } catch (error) {
    return { protocolVersion: 1, phase: 'backend_loaded_recovery_required', privateDirectory: context.privateDirectory,
      currentDevRebuilt: receipt ? true : null, commitStatus: receipt ? 'acknowledged' : 'unknown', ...(receipt ? { receipt } : {}),
      errorCode: String(error?.message ?? '').match(/^(?:DEV_(?:APPLY|REBUILD|MASTER)|SCENARIO)_[A-Z_]+/)?.[0] ?? 'LOADED_PROOF_RECOVERY_REQUIRED',
      businessDriverComplete: false, canReseed: false };
  }
}

function privateDirectory(value) {
  const supplied = path.resolve(value), stat = fs.lstatSync(supplied), resolved = fs.realpathSync(supplied);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !path.basename(resolved).startsWith('bambook-dev-scenario-rebuild-')
    || (stat.mode & 0o777) !== 0o700 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('PRIVATE', 'Owned 0700 original rebuild directory required.');
  return resolved;
}
function privateWrite(directory, name, value) {
  directory = privateDirectory(directory);
  if (!/^[A-Za-z0-9.-]+\.json$/.test(name)) fail('PRIVATE', 'Private evidence requires a simple exact filename.');
  const descriptor = fs.openSync(path.join(directory, name), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(value) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}
function readProtectedJson(directory, name) {
  directory = privateDirectory(directory);
  const file = path.join(directory, name), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.size > 16 * 1024 * 1024
    || typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('PRIVATE', 'Original 0600 private context is required.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let value;
  try { const actual = fs.fstatSync(fd); if (actual.ino !== stat.ino || actual.dev !== stat.dev) fail('PRIVATE', 'Private evidence changed while reading.'); value = JSON.parse(fs.readFileSync(fd, 'utf8')); }
  finally { fs.closeSync(fd); }
  return value;
}
function readContext(directory) {
  directory = privateDirectory(directory);
  const context = readProtectedJson(directory, 'context.private.json');
  const plan = context?.plan, { planSha256, ...withoutHash } = plan ?? {};
  if (context?.protocolVersion !== 1 || context.privateDirectory !== directory || context.expectedPort !== plan?.port
    || !Number.isInteger(context.expectedPort) || context.expectedPort < 1 || context.expectedPort > 65535 || plan.database !== 'panda_hub_dev' || plan.businessTime !== FIXED
    || !isHash(planSha256) || hashValue(withoutHash) !== planSha256 || plan.phase !== 'reviewable_preflight'
    || !same(context.command, { namespace: plan.namespace, requestKey: plan.requestKey, planSha256, sourceSha256: plan.qualified?.sourceSha256 })
    || !isHash(context.command.sourceSha256) || typeof context.qualifiedRunDirectory !== 'string' || !path.isAbsolute(context.qualifiedRunDirectory)
    || fs.realpathSync(context.qualifiedRunDirectory) !== context.qualifiedRunDirectory
    || !Number.isFinite(Date.parse(context.preparedAtWallIso))) fail('PRIVATE', 'Original context request/plan/source/target binding changed.');
  preflight.assertMatchingDatabaseIdentity(200, { ok: true, identity: plan.databaseIdentity },
    { protocolVersion: 1, database: plan.databaseIdentity?.database, readOnly: 'on' }, context.expectedPort);
  return context;
}
function regularHash(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('RUNTIME', 'Runtime proof requires exact regular bytes.');
  return sha(fs.readFileSync(file));
}
function directoryFiles(directory) {
  const result = [];
  function visit(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) fail('RUNTIME', 'Runtime files may not use links or special files.');
      if (stat.isDirectory()) visit(file); else result.push(file);
    }
  }
  visit(directory); return result;
}
function assertGeneratedClient({ manifest, indexSource, edgeSource, packageJson }, expectedSchemaSha256) {
  const required = ['schema.prisma', 'index.js', 'index.d.ts', 'default.js', 'default.d.ts', 'edge.js', 'package.json'];
  if (!isHash(expectedSchemaSha256) || required.some(name => !isHash(manifest?.[name]))
    || !Object.keys(manifest).some(name => /query_engine.*\.node$/.test(name))
    || packageJson?.name !== 'prisma-client-' + expectedSchemaSha256 || packageJson.main !== 'index.js' || packageJson.types !== 'index.d.ts')
    fail('RUNTIME_BUILD_REQUIRED', 'A complete actual generated client for the exact normalized schema is required.');
  for (const source of [indexSource, edgeSource]) {
    const literal = source?.match(/^\s*"inlineSchema":\s*(.*),$/m)?.[1];
    let schema;
    try { schema = literal && JSON.parse(literal); } catch { fail('RUNTIME_BUILD_REQUIRED', 'Generated client schema proof is malformed.'); }
    if (typeof schema !== 'string' || sha(schema) !== expectedSchemaSha256) fail('RUNTIME_BUILD_REQUIRED', 'Generated runtime client embeds a different schema.');
  }
}
/** Prisma formats its generated schema. Normalize only a private temporary
 * copy; the original qualified source bytes and shared client stay untouched. */
function formattedSchemaHash(repo, schema) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-runtime-schema-'));
  fs.chmodSync(directory, 0o700);
  try {
    const file = path.join(directory, 'schema.prisma'); fs.writeFileSync(file, fs.readFileSync(schema), { mode: 0o600, flag: 'wx' });
    const result = cp.spawnSync(process.execPath, [path.join(repo, 'server/node_modules/prisma/build/index.js'), 'format', '--schema', file],
      { env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' }, encoding: 'utf8', timeout: 30000 });
    if (result.error || result.signal || result.status !== 0) fail('RUNTIME_BUILD_REQUIRED', 'Exact qualified schema could not be normalized by the installed Prisma generator version.');
    return regularHash(file);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
/** Recompile into memory and compare every actual dist byte. A boolean build
 * receipt cannot qualify stale generated types or a stale deployed server. */
function verifyCompiledRuntime(repo, plan) {
  const server = path.join(repo, 'server'), client = path.join(server, 'node_modules/.prisma/client'), schema = path.join(server, 'prisma/schema.prisma');
  if (regularHash(schema) !== plan.qualified.schemaSha256) fail('RUNTIME_BUILD_REQUIRED', 'Qualified schema source changed before runtime verification.');
  const formattedSchemaSha256 = formattedSchemaHash(repo, schema), generatedSchemaSha256 = regularHash(path.join(client, 'schema.prisma'));
  if (generatedSchemaSha256 !== formattedSchemaSha256) fail('RUNTIME_BUILD_REQUIRED', 'Run local Prisma generate for the exact qualified schema before maintenance.');
  const generatedClientManifest = Object.fromEntries(directoryFiles(client).map(file => [path.relative(client, file), regularHash(file)]));
  assertGeneratedClient({ manifest: generatedClientManifest, indexSource: fs.readFileSync(path.join(client, 'index.js'), 'utf8'),
    edgeSource: fs.readFileSync(path.join(client, 'edge.js'), 'utf8'), packageJson: JSON.parse(fs.readFileSync(path.join(client, 'package.json'), 'utf8')) }, generatedSchemaSha256);
  const ts = require(path.join(server, 'node_modules/typescript'));
  const loaded = ts.readConfigFile(path.join(server, 'tsconfig.json'), ts.sys.readFile);
  if (loaded.error) fail('RUNTIME_BUILD_REQUIRED', 'Server compiler configuration could not be read.');
  const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, server), emitted = {};
  if (config.errors.length) fail('RUNTIME_BUILD_REQUIRED', 'Server compiler configuration has diagnostics.');
  const program = ts.createProgram(config.fileNames, { ...config.options, noEmit: false, noEmitOnError: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) fail('RUNTIME_BUILD_REQUIRED', 'Current qualified source does not compile cleanly.');
  const emission = program.emit(undefined, (file, text) => {
    const relative = path.relative(path.join(server, 'dist'), file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || regularHash(file) !== sha(text)) fail('RUNTIME_BUILD_REQUIRED', 'Current server/dist differs from actual freshly compiled source. Run the normal local build first.');
    emitted[relative] = sha(text);
  });
  if (emission.emitSkipped || emission.diagnostics.length || !Object.keys(emitted).length) fail('RUNTIME_BUILD_REQUIRED', 'No complete current server build was verified.');
  if (!same(Object.keys(emitted).sort(), directoryFiles(path.join(server, 'dist')).map(file => path.relative(path.join(server, 'dist'), file)).sort()))
    fail('RUNTIME_BUILD_REQUIRED', 'Server dist contains missing or stale extra files.');
  const entries = ['devExclusiveReset.ts', 'provisionDevMaster.ts', 'runningDevPopulation.ts'].map(name => path.join(server, 'scripts/full-business-sim', name)).filter(file => fs.existsSync(file));
  const helpers = ts.createProgram(entries, { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true });
  if (ts.getPreEmitDiagnostics(helpers).length) fail('RUNTIME_BUILD_REQUIRED', 'The exact maintenance and receipt helpers must also compile strictly.');
  const scriptSources = Object.fromEntries(helpers.getSourceFiles().filter(file => file.fileName.startsWith(server + path.sep) && !file.fileName.includes('/node_modules/'))
    .map(file => [path.relative(repo, file.fileName), regularHash(file.fileName)]).sort(([a], [b]) => a.localeCompare(b)));
  return { protocolVersion: 1, sourceSha256: plan.qualified.sourceSha256, schemaSha256: plan.qualified.schemaSha256,
    formattedSchemaSha256, generatedSchemaSha256, generatedClientManifest, emittedManifest: emitted, scriptSources, verifiedAtWallIso: new Date().toISOString() };
}
/** Lightweight check for each command after the full original runtime proof
 * has been recompiled and verified once at population/resume startup. */
function assertRuntimeProofCurrent(repo, plan, proof) {
  if (proof?.protocolVersion !== 1 || proof.sourceSha256 !== plan.qualified.sourceSha256 || proof.schemaSha256 !== plan.qualified.schemaSha256
    || !isHash(proof.formattedSchemaSha256) || proof.formattedSchemaSha256 !== proof.generatedSchemaSha256
    || !isHash(proof.emittedManifest?.['index.js']) || !isHash(proof.scriptSources?.['server/scripts/full-business-sim/provisionDevMaster.ts'])
    || regularHash(path.join(repo, 'server/prisma/schema.prisma')) !== proof.schemaSha256) fail('RUNTIME', 'Original source/schema/compiled runtime proof is incomplete or changed.');
  for (const [directory, expected] of [[path.join(repo, 'server/dist'), proof.emittedManifest],
    [path.join(repo, 'server/node_modules/.prisma/client'), proof.generatedClientManifest]]) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) || !Object.keys(expected).length || Object.values(expected).some(hash => !isHash(hash)))
      fail('RUNTIME', 'Original runtime file inventory is incomplete.');
    const actual = Object.fromEntries(directoryFiles(directory).map(file => [path.relative(directory, file), regularHash(file)]));
    if (!same(actual, expected)) fail('RUNTIME', 'Actual generated client or compiled runtime bytes changed.');
  }
  if (regularHash(path.join(repo, 'server/node_modules/.prisma/client/schema.prisma')) !== proof.generatedSchemaSha256) fail('RUNTIME', 'Actual generated schema no longer matches its original normalized source.');
  for (const [relative, expected] of Object.entries(proof.scriptSources)) {
    if (!/^server\/(?:src|scripts)\//.test(relative) || relative.split('/').includes('..') || !isHash(expected) || regularHash(path.join(repo, relative)) !== expected)
      fail('RUNTIME', 'Original maintenance/population helper source changed.');
  }
  return { sourceSha256: proof.sourceSha256, schemaSha256: proof.schemaSha256,
    compiledRuntimeSha256: hashValue(proof.emittedManifest), generatedClientSha256: hashValue(proof.generatedClientManifest) };
}
/** Read-only startup proof for the independently controlled population CLI.
 * It reads the original protected context and complete qualified source,
 * freshly compiles in memory, and rejects any drift in recorded runtime bytes. */
function verifyContextRuntime(repo, context) {
  if (!same(readContext(context.privateDirectory), context)) fail('PRIVATE', 'Population context differs from the protected original.');
  const manifest = preflight.readJsonEvidence(context.qualifiedRunDirectory, 'source-files.json').value;
  if (sha(JSON.stringify(manifest)) !== context.command.sourceSha256 || !same(preflight.currentSourceManifest(repo, manifest), manifest))
    fail('RUNTIME', 'Population source no longer matches the final qualified full rehearsal.');
  const fresh = verifyCompiledRuntime(repo, context.plan), { verifiedAtWallIso: freshTime, ...freshFacts } = fresh,
    { verifiedAtWallIso: recordedTime, ...recordedFacts } = context.runtimeProof ?? {};
  if (!same(freshFacts, recordedFacts)) fail('RUNTIME', 'Fresh build/client proof differs from the protected original runtime.');
  return { ...assertRuntimeProofCurrent(repo, context.plan, fresh), verifiedAtWallIso: freshTime };
}
function parseProcessStart(value) {
  const match = typeof value === 'string' && value.trim().match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/);
  if (!match) fail('PROCESS', 'The exact backend process start time could not be read in UTC.');
  const [, weekday, month, day, hours, minutes, seconds, year] = match, months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const time = new Date(Date.UTC(Number(year), months.indexOf(month), Number(day), Number(hours), Number(minutes), Number(seconds)));
  if (time.getUTCFullYear() !== Number(year) || time.getUTCMonth() !== months.indexOf(month) || time.getUTCDate() !== Number(day)
    || time.getUTCHours() !== Number(hours) || time.getUTCMinutes() !== Number(minutes) || time.getUTCSeconds() !== Number(seconds)
    || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][time.getUTCDay()] !== weekday) fail('PROCESS', 'The backend start time is not a valid UTC process timestamp.');
  return time.toISOString();
}
function runtimeSummary(proof) {
  return { sourceSha256: proof?.sourceSha256, schemaSha256: proof?.schemaSha256,
    compiledRuntimeSha256: hashValue(proof?.emittedManifest), generatedClientSha256: hashValue(proof?.generatedClientManifest) };
}
function assertLoadedProcess(context, job, options = {}) {
  const original = context?.verifiedJob, proof = context?.runtimeProof, start = Date.parse(job?.startedAtWallIso), verified = Date.parse(proof?.verifiedAtWallIso);
  const maxMtime = options.maxRuntimeMtimeMs, notBefore = options.bootstrapNotBeforeWallIso === undefined ? verified : Date.parse(options.bootstrapNotBeforeWallIso);
  if (!original || !Number.isSafeInteger(job?.pid) || job.pid < 2 || !Number.isFinite(start) || start % 1000 !== 0 || !Number.isFinite(verified)
    || !Number.isFinite(maxMtime) || !Number.isFinite(notBefore)
    || start < Math.ceil(Math.max(verified, maxMtime, notBefore) / 1000) * 1000
    || ['uid', 'service', 'plistPath', 'plistSha256', 'cwd'].some(key => job[key] !== original[key]) || !isHash(job.plistSha256)
    || !same(job.arguments, original.arguments) || job.service !== `gui/${job.uid}/${LABEL}`
    || options.expectedProcess && (job.pid !== options.expectedProcess.pid || job.startedAtWallIso !== options.expectedProcess.startedAtWallIso))
    fail('LOADED_PROCESS', 'The exact owned backend must have started after every original runtime byte, proof and controlled bootstrap boundary; a population run may not switch process.');
  return job;
}
function buildBackendLoadedProof(context, job, options) {
  assertLoadedProcess(context, job, options);
  const proof = { protocolVersion: 1, phase: 'backend_loaded', command: context.command, privateDirectory: context.privateDirectory,
    runtime: runtimeSummary(context.runtimeProof), job, origin: options.origin ?? 'controlled_bootstrap',
    maxRuntimeMtimeMs: options.maxRuntimeMtimeMs, bootstrapNotBeforeWallIso: options.bootstrapNotBeforeWallIso,
    observedAtWallIso: options.observedAtWallIso ?? new Date().toISOString() };
  assertBackendLoadedProof(context, proof); return proof;
}
function assertBackendLoadedProof(context, proof) {
  if (proof?.protocolVersion !== 1 || proof.phase !== 'backend_loaded' || proof.privateDirectory !== context.privateDirectory
    || !same(proof.command, context.command) || !same(proof.runtime, runtimeSummary(context.runtimeProof))
    || !['controlled_bootstrap', 'observed_after_original_receipt'].includes(proof.origin)
    || Object.values(proof.runtime ?? {}).some(value => !isHash(value)) || !Number.isFinite(Date.parse(proof.observedAtWallIso))
    || !Number.isFinite(Date.parse(proof.bootstrapNotBeforeWallIso)) || Date.parse(proof.observedAtWallIso) < Date.parse(proof.job?.startedAtWallIso))
    fail('LOADED_PROCESS', 'The immutable backend-loaded receipt must bind the original command, process, plist and compiled/generated bytes.');
  assertLoadedProcess(context, proof.job, proof); return proof;
}
function runtimeFiles(repo, proof) {
  return [
    ...Object.keys(proof.emittedManifest).map(relative => path.join(repo, 'server/dist', relative)),
    ...Object.keys(proof.generatedClientManifest).map(relative => path.join(repo, 'server/node_modules/.prisma/client', relative)),
    ...Object.keys(proof.scriptSources).map(relative => path.join(repo, relative)),
  ];
}
function latestRuntimeMtimeMs(repo, proof) {
  return Math.max(...runtimeFiles(repo, proof).map(file => {
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) fail('RUNTIME', 'Actual runtime mtime proof requires regular files.'); return stat.mtimeMs;
  }));
}
/** Whole-file hashes are checked once at startup. Subsequent checks reject all
 * inode, nanosecond time, permission or inventory drift, including attempts to
 * restore mtime after changing a file. No cache refresh can accept new bytes. */
function createFileMetadataGuard({ files = [], trees = [], shallowDirectories = [], protectedDirectories = [], ignoreDirectory = () => false }) {
  const fileFacts = new Map(), directoryFacts = new Map(), protectedFacts = new Map();
  const signature = (file, kind, identityOnly = false, initial = false) => {
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || kind === 'file' && !stat.isFile() || kind === 'directory' && !stat.isDirectory()
      || initial && fs.realpathSync(file) !== file) fail('RUNTIME_METADATA', 'Original runtime paths must remain regular and may not be replaced by links.');
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, ...(identityOnly ? [] : [stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink])].map(String).join(':');
  };
  const addParents = value => {
    let directory = path.dirname(value);
    while (true) {
      if (!protectedFacts.has(directory)) protectedFacts.set(directory, signature(directory, 'directory', true, true));
      if (path.dirname(directory) === directory) break; directory = path.dirname(directory);
    }
  };
  const addFile = file => { file = path.resolve(file); fileFacts.set(file, signature(file, 'file', false, true)); addParents(file); };
  const addDirectory = (directory, recursive) => {
    directory = path.resolve(directory); if (directoryFacts.has(directory)) return;
    const entries = fs.readdirSync(directory).sort(); directoryFacts.set(directory, { stat: signature(directory, 'directory', false, true), entries: entries.join('\0') }); addParents(directory);
    if (recursive) for (const name of entries) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (ignoreDirectory(file)) continue;
      if (stat.isDirectory()) addDirectory(file, true);
      else if (stat.isFile()) addFile(file);
      else if (!stat.isDirectory()) fail('RUNTIME_METADATA', 'Runtime trees may not contain links or special files.');
    }
  };
  for (const file of files) addFile(file);
  for (const directory of trees) addDirectory(directory, true);
  for (const directory of shallowDirectories) addDirectory(directory, false);
  for (const directory of protectedDirectories) {
    const resolved = path.resolve(directory); protectedFacts.set(resolved, signature(resolved, 'directory', true, true)); addParents(resolved);
  }
  const assertCurrent = () => {
    try {
      for (const [file, expected] of fileFacts) if (signature(file, 'file') !== expected) fail('RUNTIME_METADATA', 'Original runtime or source file metadata changed.');
      for (const [directory, expected] of directoryFacts) if (signature(directory, 'directory') !== expected.stat || fs.readdirSync(directory).sort().join('\0') !== expected.entries)
        fail('RUNTIME_METADATA', 'Original source/runtime directory inventory changed.');
      for (const [directory, expected] of protectedFacts) if (signature(directory, 'directory', true) !== expected) fail('RUNTIME_METADATA', 'Protected original evidence directory identity changed.');
    } catch (error) { if (String(error.message).startsWith('DEV_APPLY_RUNTIME_METADATA')) throw error; fail('RUNTIME_METADATA', 'An original runtime/source path disappeared or could not be observed.'); }
    return true;
  };
  return Object.freeze({ assertCurrent, fileCount: fileFacts.size, directoryCount: directoryFacts.size + protectedFacts.size });
}
function populationMetadata(repo, context, manifest, options = {}) {
  const { sourceInventory } = require('./dev-scenario-source-inventory.cjs');
  const originalInventory = sourceInventory(repo, manifest), expected = Object.keys(manifest).sort();
  if (!same(originalInventory.names, expected)) fail('RUNTIME_METADATA', 'Qualified complete source inventory changed.');
  const relativeFiles = [...new Set([...expected, ...Object.keys(context.runtimeProof.scriptSources)])];
  const loadedFile = path.join(context.privateDirectory, 'backend-loaded.private.json');
  const metadata = createFileMetadataGuard({ files: [...relativeFiles.map(relative => path.join(repo, relative)), ...originalInventory.policies,
    ...runtimeFiles(repo, context.runtimeProof), path.join(options.manifestDirectory ?? context.qualifiedRunDirectory, 'source-files.json'),
    path.join(context.privateDirectory, 'context.private.json'), ...(!options.allowMissingLoadedProof || fs.existsSync(loadedFile) ? [loadedFile] : []), context.verifiedJob.plistPath],
    trees: [path.join(repo, 'server/dist'), path.join(repo, 'server/node_modules/.prisma/client')],
    protectedDirectories: [context.privateDirectory, context.qualifiedRunDirectory, ...(options.manifestDirectory ? [options.manifestDirectory] : [])] });
  return Object.freeze({ fileCount: metadata.fileCount, directoryCount: metadata.directoryCount, assertCurrent() {
    metadata.assertCurrent();
    if (!same(sourceInventory(repo, manifest), originalInventory)) fail('RUNTIME_METADATA', 'Qualified source inventory or Git eligibility changed.');
    metadata.assertCurrent(); return true;
  } });
}
function assertObservedPopulationJob(context, loaded, job, options) {
  assertBackendLoadedProof(context, loaded);
  assertLoadedProcess(context, job, options);
  const restarted = job.pid !== loaded.job.pid || job.startedAtWallIso !== loaded.job.startedAtWallIso;
  if (restarted && Date.parse(job.startedAtWallIso) < Math.ceil(Date.parse(loaded.observedAtWallIso) / 1000) * 1000)
    fail('LOADED_PROCESS', 'A replacement backend must start after the original immutable loaded receipt as well as all verified bytes.');
  return { protocolVersion: 1, ...runtimeSummary(context.runtimeProof), job, restarted, backendLoadedSha256: hashValue(loaded) };
}
function assertPopulationJobCurrent(repo, context, options = {}) {
  if (!same(readContext(context.privateDirectory), context)) fail('PRIVATE', 'The population context must match the protected original.');
  const loaded = readProtectedJson(context.privateDirectory, 'backend-loaded.private.json');
  assertRuntimeProofCurrent(repo, context.plan, context.runtimeProof);
  return assertObservedPopulationJob(context, loaded, observeJob(repo), { ...options, maxRuntimeMtimeMs: latestRuntimeMtimeMs(repo, context.runtimeProof) });
}
function createPopulationRuntimeGuard(repo, context) {
  if (!same(readContext(context.privateDirectory), context)) fail('PRIVATE', 'The population context must match the protected original.');
  context = JSON.parse(JSON.stringify(context)); // Do not let callers refresh the immutable in-memory baseline.
  const manifest = preflight.readJsonEvidence(context.qualifiedRunDirectory, 'source-files.json').value;
  const metadata = populationMetadata(repo, context, manifest), loaded = readProtectedJson(context.privateDirectory, 'backend-loaded.private.json');
  verifyContextRuntime(repo, context);
  const maxRuntimeMtimeMs = latestRuntimeMtimeMs(repo, context.runtimeProof), initialProof = assertObservedPopulationJob(context, loaded, observeJob(repo), { maxRuntimeMtimeMs });
  metadata.assertCurrent();
  const expectedProcess = { pid: initialProof.job.pid, startedAtWallIso: initialProof.job.startedAtWallIso };
  return Object.freeze({ initialProof, fileCount: metadata.fileCount, directoryCount: metadata.directoryCount, assertCurrent() {
    const result = assertObservedPopulationJob(context, loaded, observeJob(repo), { maxRuntimeMtimeMs, expectedProcess });
    metadata.assertCurrent(); return result;
  } });
}
function persistBackendLoadedProof(context, candidate) {
  assertBackendLoadedProof(context, candidate);
  const read = () => assertBackendLoadedProof(context, readProtectedJson(context.privateDirectory, 'backend-loaded.private.json'));
  try { return { proof: read(), replayed: true }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    privateWrite(context.privateDirectory, 'backend-loaded.private.json', candidate);
  } catch (error) {
    // EEXIST or a lost fsync/write acknowledgement may already have left the
    // original complete bytes. Read and verify them; never overwrite/retry.
    try { return { proof: read(), replayed: true }; } catch { throw error; }
  }
  const actual = read();
  if (!same(actual, candidate)) fail('LOADED_PROCESS', 'New loaded-proof bytes changed before their acknowledgement.');
  return { proof: actual, replayed: false };
}
function recoverBackendLoadedProof(repo, context, originalReceipt) {
  publicReceipt(originalReceipt, context.plan);
  if (!same(readContext(context.privateDirectory), context)) fail('PRIVATE', 'Recovery must use the protected original context.');
  context = JSON.parse(JSON.stringify(context));
  const manifest = preflight.readJsonEvidence(context.qualifiedRunDirectory, 'source-files.json').value,
    metadata = populationMetadata(repo, context, manifest, { allowMissingLoadedProof: true });
  verifyContextRuntime(repo, context);
  const maxRuntimeMtimeMs = latestRuntimeMtimeMs(repo, context.runtimeProof), job = observeJob(repo),
    bootstrapNotBeforeWallIso = new Date(Math.ceil(Math.max(maxRuntimeMtimeMs, Date.parse(context.runtimeProof.verifiedAtWallIso)) / 1000) * 1000).toISOString();
  const candidate = buildBackendLoadedProof(context, job, { maxRuntimeMtimeMs, bootstrapNotBeforeWallIso, origin: 'observed_after_original_receipt' });
  metadata.assertCurrent();
  const saved = persistBackendLoadedProof(context, candidate);
  const result = assertObservedPopulationJob(context, saved.proof, observeJob(repo), { maxRuntimeMtimeMs,
    expectedProcess: { pid: job.pid, startedAtWallIso: job.startedAtWallIso } });
  metadata.assertCurrent(); return { ...result, replayed: saved.replayed };
}
function command(executable, args, options = {}) {
  const result = cp.spawnSync(executable, args, { encoding: 'utf8', timeout: 15000, ...options });
  if (result.error || result.signal) fail('PROCESS', 'Exact process observation/control command had an unknown outcome.');
  return result;
}
function listenerIds() {
  const result = command('/usr/sbin/lsof', ['-nP', '-tiTCP:8081', '-sTCP:LISTEN']);
  if (result.status === 1 && !result.stdout.trim()) return [];
  if (result.status !== 0 || !/^\d+(?:\s+\d+)*\s*$/.test(result.stdout)) fail('JOB', 'Listener observation failed.');
  return result.stdout.trim().split(/\s+/).map(Number).sort((a, b) => a - b);
}
function jobPrint(service) {
  const result = command('/bin/launchctl', ['print', service]);
  if (result.status === 0) return result.stdout;
  if ([3, 113].includes(result.status) && /Could not find service/i.test(result.stderr)) return null;
  fail('JOB', 'The exact launchd job registration could not be observed.');
}
function observeJob(repo) {
  const uid = process.getuid(), plistPath = path.join(os.homedir(), 'Library/LaunchAgents', LABEL + '.plist'), stat = fs.lstatSync(plistPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) fail('JOB', 'Owned immutable-to-others launchd plist required.');
  const plistBytes = fs.readFileSync(plistPath), result = command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]);
  if (result.status !== 0) fail('JOB', 'The exact launchd plist could not be decoded.');
  const printed = jobPrint(`gui/${uid}/${LABEL}`), pid = Number(printed?.match(/^\s*pid = (\d+)$/m)?.[1]);
  if (!pid) fail('JOB', 'The verified backend must be running before a new rebuild.');
  const startArgs = ['-p', String(pid), '-o', 'lstart='], startOptions = { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } };
  const before = command('/bin/ps', startArgs, startOptions), ps = command('/bin/ps', ['-p', String(pid), '-o', 'command=']), cwd = command('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (ps.status !== 0 || cwd.status !== 0) fail('JOB', 'The exact backend process could not be observed.');
  const after = command('/bin/ps', startArgs, startOptions);
  if (before.status !== 0 || after.status !== 0 || before.stdout.trim() !== after.stdout.trim()) fail('JOB', 'Backend process changed while its identity was being read.');
  return { ...assertLaunchJob(JSON.parse(result.stdout), { uid, plistPath, printed, listeners: listenerIds(), command: ps.stdout.trim(),
    cwd: cwd.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) }, repo), plistSha256: sha(plistBytes), startedAtWallIso: parseProcessStart(after.stdout) };
}
async function assertStopped(job) {
  if (regularHash(job.plistPath) !== job.plistSha256 || jobPrint(job.service) !== null || listenerIds().length) fail('MAINTENANCE', 'Original plist changed, job is registered or port is listening.');
  const ps = command('/bin/ps', ['-p', String(job.pid), '-o', 'pid=']);
  if (ps.status !== 1 || ps.stdout.trim()) fail('MAINTENANCE', 'Original backend PID has not fully exited.');
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) { try { return await check(); } catch { if (attempt === attempts - 1) fail('RECOVERY', 'Exact backend/database maintenance state did not become ready.'); await delay(100); } }
}
async function apiIdentity() {
  const response = await guards.freshMaintenanceGet('/api/dev/status', 3000);
  return preflight.assertDevApiIdentity(response.status, await response.json());
}
async function restoreJob(job, repo, context) {
  if (regularHash(job.plistPath) !== job.plistSha256) fail('RECOVERY', 'Original launchd plist changed; it will not be overwritten or replaced.');
  const maxRuntimeMtimeMs = latestRuntimeMtimeMs(repo, context.runtimeProof);
  const boundary = Math.ceil(Math.max(Date.now(), maxRuntimeMtimeMs, Date.parse(context.runtimeProof.verifiedAtWallIso)) / 1000) * 1000;
  if (boundary - Date.now() > 2000) fail('RECOVERY', 'Runtime timestamps are in the future; exact backend bootstrap cannot prove loaded bytes.');
  if (boundary > Date.now()) await delay(boundary - Date.now() + 10);
  const bootstrapNotBeforeWallIso = new Date(boundary).toISOString();
  if (jobPrint(job.service) === null) {
    const result = command('/bin/launchctl', ['bootstrap', `gui/${job.uid}`, job.plistPath]);
    if (result.status !== 0) fail('RECOVERY', 'Exact launchd bootstrap did not acknowledge success.');
  }
  const restored = await waitFor(async () => {
    const current = observeJob(repo);
    const response = await guards.freshMaintenanceGet('/api/health', 3000), health = await response.json();
    if (response.status !== 200 || health.status !== 'ok' || health.database !== 'ok' || health.authRequired !== true) fail('RECOVERY', 'Backend health/auth guard is not ready.');
    await apiIdentity();
    return current;
  });
  assertRuntimeProofCurrent(repo, context.plan, context.runtimeProof);
  return buildBackendLoadedProof(context, restored, { maxRuntimeMtimeMs, bootstrapNotBeforeWallIso });
}
const IDENTITY_SQL = `SELECT current_database() AS name,inet_server_port() AS port,inet_server_addr()::text AS address,pg_backend_pid() AS pid,
  pg_postmaster_start_time()::text AS "startedAt",current_user AS "user",
  __PHYSICAL_FINGERPRINT__ AS "instanceFingerprint",
  encode(sha256(convert_to((SELECT system_identifier::text FROM pg_catalog.pg_control_system()),'UTF8')),'hex') AS "clusterControlFingerprint",
  (SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS "backendStartedAt",
  pg_get_userbyid(d.datdba) AS owner,pg_has_role(current_user,d.datdba,'MEMBER') AS "ownerMember",r.rolsuper AS superuser,d.datallowconn AS "allowConnections"
  FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname='panda_hub_dev'`;
const CATALOG_SQL = guards.MAINTENANCE_CATALOG_SQL;
/** Match the psql full-backup projection exactly. Prisma usually sets UTC;
 * relying on its default would change timestamptz JSON and every row digest. */
async function readMigrationLedgerRows(connection, timeZone) {
  if (typeof timeZone !== 'string' || !/^[A-Za-z0-9_+:/.-]{1,128}$/.test(timeZone))
    fail('MIGRATIONS', 'The original backup session timezone is required for complete migration row hashes.');
  return connection.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$queryRawUnsafe("SELECT set_config('TimeZone', $1, true) AS timezone", timeZone);
    const rows = await tx.$queryRawUnsafe(guards.MIGRATION_LEDGER_ROWS_SQL);
    try { guards.migrationRowsSha256(rows); }
    catch { fail('MIGRATIONS', 'The read-only original ledger returned incomplete full-row facts.'); }
    return rows;
  }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 10000 });
}
async function identity(connection) {
  const targets = await connection.$queryRawUnsafe('SELECT current_database() AS name');
  if (targets.length !== 1 || !['panda_hub_dev', 'postgres'].includes(targets[0].name)) fail('CONTROL', 'Only the original dev and metadata control databases may be inspected.');
  // The protected helper exists only in dev. The control connection proves the
  // same running postmaster/port/system hash without receiving a directory.
  const expression = targets[0].name === 'panda_hub_dev' ? 'bambook_runtime_identity.physical_fingerprint()' : 'NULL::text';
  const rows = await connection.$queryRawUnsafe(IDENTITY_SQL.replace('__PHYSICAL_FINGERPRINT__', expression));
  if (rows.length !== 1 || rows[0].name !== targets[0].name || !isHash(rows[0].clusterControlFingerprint)
    || targets[0].name === 'panda_hub_dev' && !isHash(rows[0].instanceFingerprint)) fail('CONTROL', 'Physical database identity could not be read.');
  return rows[0];
}
async function catalog(connection) {
  const rows = await connection.$queryRawUnsafe(CATALOG_SQL);
  if (rows.length !== 1 || !isHash(rows[0].sha256)) fail('SCHEMA', 'Complete public catalog identity could not be read.'); return rows[0].sha256;
}
async function noOthers(session) {
  const others = await session.dev.$queryRawUnsafe("SELECT pid,state FROM pg_stat_activity WHERE datname='panda_hub_dev' AND pid<>$1 AND backend_type='client backend'", session.identity.pid);
  if (others.length) fail('OTHER_SESSION', 'Another dev SQL client exists, including an idle one; no session will be killed.');
}
async function assertControlIdentity(session) {
  const current = await identity(session.control), original = session.controlIdentity;
  for (const key of ['name', 'port', 'address', 'startedAt', 'instanceFingerprint', 'clusterControlFingerprint', 'user', 'owner']) if (current[key] !== original[key]) fail('CONTROL', 'Metadata control connection no longer points at the original physical cluster.');
  return current;
}
function assertClosedConnectionRows(rows, original) {
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].pid !== original.pid || rows[0].name !== 'panda_hub_dev'
    || rows[0].user !== original.user || rows[0].startedAt !== original.backendStartedAt)
    fail('OTHER_SESSION', 'Exactly the original existing dev backend must remain; all new or replaced sessions are forbidden.');
}
function actualDependencies() {
  const repo = guards.root; let target, modules, proof, qualifiedManifest;
  const loadModules = runtimeProof => {
    for (const [relative, expected] of Object.entries(runtimeProof?.scriptSources ?? {})) if (regularHash(path.join(repo, relative)) !== expected) fail('RUNTIME', 'Original maintenance/receipt helper source changed.');
    if (!runtimeProof?.scriptSources?.['server/scripts/full-business-sim/provisionDevMaster.ts']) fail('RUNTIME', 'Original runtime pointer is missing.');
    if (!modules) {
      require(path.join(repo, 'server/node_modules/ts-node')).register({ project: path.join(repo, 'server/tsconfig.json'), transpileOnly: false,
        compilerOptions: { rootDir: path.join(repo, 'server') } });
      modules = { ...require(path.join(repo, 'server/scripts/full-business-sim/provisionDevMaster.ts')),
        ...require(path.join(repo, 'server/scripts/full-business-sim/devExclusiveReset.ts')),
        PrismaClient: require(path.join(repo, 'server/node_modules/@prisma/client')).PrismaClient };
    }
    return modules;
  };
  return { repo, preflight: async args => {
    const plan = await preflight.main(args), options = applyArguments(['--apply', ...args.slice(1)]);
    qualifiedManifest = preflight.readJsonEvidence(fs.realpathSync(options['--run-dir']), 'source-files.json').value;
    if (sha(JSON.stringify(qualifiedManifest)) !== plan.qualified.sourceSha256) fail('RUNTIME', 'Original qualified source manifest changed.');
    return plan;
  }, qualifiedDirectory: async directory => fs.realpathSync(directory),
    target: async () => {
      target = preflight.assertDevConnection(guards.loadTarget());
      for (const key of ['NODE_ENV', 'DATABASE_URL', 'BAMBOOK_DEV_PANEL', 'BAMBOOK_DEV_BUSINESS_TIME']) process.env[key] = target.env[key];
      return target;
    },
    runtime: async plan => (proof = verifyCompiledRuntime(repo, plan)),
    bindTarget: async (plan, value) => {
      if (!plan.databaseIdentity) fail('TARGET', 'The original plan must contain its pre-reset physical API/SQL identity.');
      return preflight.readMatchingDatabaseIdentity(value, plan.databaseIdentity);
    },
    job: async () => observeJob(repo), privateDirectory: async () => loadModules(proof).createDevMasterPrivateDirectory(),
    privateWrite, snapshot: async value => guards.readOnlyBusinessSnapshot(value),
    stop: async job => {
      const current = observeJob(repo);
      if (current.pid !== job.pid || current.plistSha256 !== job.plistSha256) fail('JOB', 'Original exact backend changed before bootout.');
      const result = command('/bin/launchctl', ['bootout', job.service]);
      if (result.status !== 0) fail('MAINTENANCE', 'Exact bootout did not acknowledge success.');
      await waitFor(() => assertStopped(job));
    }, assertStopped,
    connect: async (value, plan) => {
      const { PrismaClient } = loadModules(proof), dev = new PrismaClient({ datasources: { db: { url: maintenanceUrl(value, 'panda_hub_dev') } } }),
        control = new PrismaClient({ datasources: { db: { url: maintenanceUrl(value, 'postgres') } } });
      try {
        const original = await identity(dev), controlIdentity = await identity(control);
        assertMaintenanceConnections(original, controlIdentity, value.port);
        const expected = plan.databaseIdentity?.database;
        if (expected?.name !== original.name || expected.port !== original.port || expected.instanceFingerprint !== original.instanceFingerprint)
          fail('CONTROL', 'Closed maintenance datasource differs from the original pre-reset API/SQL physical anchor.');
        const session = { dev, control, identity: original, controlIdentity, originalAllowConnections: true };
        await noOthers(session); return session;
      } catch { await Promise.allSettled([dev.$disconnect(), control.$disconnect()]); fail('CONTROL', 'Exact existing dev and same-cluster owner control connections could not be established.'); }
    },
    schema: async (session, value, plan) => {
      await noOthers(session); const before = await catalog(session.dev);
      const baseline = plan.migrationBaseline;
      if (baseline !== undefined) {
        preflight.validateMigrationBaselineBinding({ baseline, backup: plan.backup, qualified: plan.qualified });
        if (!same(baseline.identity, { name: session.identity.name, port: session.identity.port, address: session.identity.address, readOnly: 'on' })
          || before !== baseline.originalCatalogSha256) fail('MIGRATIONS', 'Original backup migration target or catalog changed before schema verification.');
      }
      const rows = baseline === undefined
        ? await session.dev.$queryRawUnsafe('SELECT migration_name AS name,checksum,finished_at AS "finishedAt",rolled_back_at AS "rolledBackAt" FROM public."_prisma_migrations" ORDER BY migration_name')
        : await readMigrationLedgerRows(session.dev, baseline.timeZone);
      if (baseline === undefined) assertMigrations(rows, plan.qualified.migrationSha256);
      const schema = path.join(repo, 'server/prisma/schema.prisma');
      if (regularHash(schema) !== plan.qualified.schemaSha256) fail('SCHEMA', 'Qualified schema source changed before maintenance.');
      const env = { ...value.env, DATABASE_URL: maintenanceUrl(value, 'panda_hub_dev'), CHECKPOINT_DISABLE: '1' };
      const diff = cp.spawnSync(process.execPath, [path.join(repo, 'server/node_modules/prisma/build/index.js'), 'migrate', 'diff',
        '--from-schema-datasource', schema, '--to-schema-datamodel', schema, '--exit-code'], { cwd: path.join(repo, 'server'), env, encoding: 'utf8', timeout: 60000 });
      if (diff.error || diff.signal || diff.status !== 0) fail('SCHEMA', 'Actual current dev schema must have zero diff against the exact qualified schema.');
      await noOthers(session);
      if (await catalog(session.dev) !== before) fail('SCHEMA', 'Current schema changed while its independent diff was checked.');
      if (baseline !== undefined) assertMigrations(rows, plan.qualified.migrationSha256,
        { baseline, backup: plan.backup, qualified: plan.qualified, zeroSchemaDiff: true, catalogSha256: before });
      return { catalogSha256: before, schemaSha256: plan.qualified.schemaSha256, migrationSha256: plan.qualified.migrationSha256,
        zeroSchemaDiff: true, ...(baseline === undefined ? {} : { migrationBaselineSha256: baseline.baselineSha256 }) };
    },
    deny: async session => {
      const before = await assertControlIdentity(session);
      if (before.allowConnections !== true) fail('CONTROL', 'Another maintenance owner already changed dev connection admission.');
      await session.control.$executeRawUnsafe('ALTER DATABASE "panda_hub_dev" ALLOW_CONNECTIONS false');
      if ((await assertControlIdentity(session)).allowConnections !== false) fail('CONTROL', 'New dev connections were not demonstrably denied.');
    },
    closedSchema: async (session, schemaProof, plan) => {
      const dev = await identity(session.dev);
      if (dev.allowConnections !== false || dev.pid !== session.identity.pid || await catalog(session.dev) !== schemaProof.catalogSha256)
        fail('SCHEMA', 'Current catalog or the original dev connection changed between zero-diff and closed maintenance.');
      if (schemaProof.zeroSchemaDiff !== true || schemaProof.schemaSha256 !== plan.qualified.schemaSha256
        || !same(schemaProof.migrationSha256, plan.qualified.migrationSha256)) fail('SCHEMA', 'The exact successful schema-diff and qualified migration proof is required.');
      const baseline = plan.migrationBaseline;
      if (baseline !== undefined && schemaProof.migrationBaselineSha256 !== baseline.baselineSha256)
        fail('MIGRATIONS', 'The closed-maintenance original migration baseline differs from the schema proof.');
      const rows = baseline === undefined
        ? await session.dev.$queryRawUnsafe('SELECT migration_name AS name,checksum,finished_at AS "finishedAt",rolled_back_at AS "rolledBackAt" FROM public."_prisma_migrations" ORDER BY migration_name')
        : await readMigrationLedgerRows(session.dev, baseline.timeZone);
      assertMigrations(rows, plan.qualified.migrationSha256, baseline === undefined ? undefined :
        { baseline, backup: plan.backup, qualified: plan.qualified, zeroSchemaDiff: schemaProof.zeroSchemaDiff, catalogSha256: schemaProof.catalogSha256 });
    },
    isolated: async session => {
      // This callback also runs INSIDE the writer's interactive transaction.
      // Never query session.dev here: its sole connection belongs to that tx.
      const control = await assertControlIdentity(session);
      if (control.allowConnections !== false) fail('MAINTENANCE', 'New dev connections must remain denied.');
      const rows = await session.control.$queryRawUnsafe(`SELECT pid,datname AS name,usename AS "user",backend_start::text AS "startedAt"
        FROM pg_stat_activity WHERE datname='panda_hub_dev' AND backend_type='client backend'`);
      assertClosedConnectionRows(rows, session.identity);
    },
    recheck: async (plan, runtimeProof) => {
      if (!qualifiedManifest || runtimeProof.sourceSha256 !== plan.qualified.sourceSha256 || sha(JSON.stringify(qualifiedManifest)) !== plan.qualified.sourceSha256
        || !same(preflight.currentSourceManifest(repo, qualifiedManifest), qualifiedManifest)) fail('RUNTIME', 'Complete current source differs from the final qualified native source.');
      assertRuntimeProofCurrent(repo, plan, runtimeProof);
    },
    execute: async (session, input) => loadModules(proof).executeExclusiveDevMasterRebuild(session.dev, input),
    allow: async session => {
      // Admission restoration is an idempotent recovery action, separate from
      // the non-retryable reset/seed transaction.
      await waitFor(async () => {
        const current = await assertControlIdentity(session);
        if (current.allowConnections !== true && current.allowConnections !== false) fail('CONTROL', 'Original dev admission state is unavailable.');
        if (!current.allowConnections) await session.control.$executeRawUnsafe('ALTER DATABASE "panda_hub_dev" ALLOW_CONNECTIONS true');
        if ((await assertControlIdentity(session)).allowConnections !== true) fail('CONTROL', 'Original dev connection admission could not be restored.');
      }, 3);
    },
    disconnect: async session => {
      const results = await Promise.allSettled([session.dev.$disconnect(), session.control.$disconnect()]);
      if (results.some(result => result.status === 'rejected')) fail('CONTROL', 'Maintenance connections did not acknowledge disconnect.');
    }, restore: async (job, context) => restoreJob(job, repo, context), context: async value => readContext(value), api: apiIdentity,
    recoverLoaded: async (context, receipt) => recoverBackendLoadedProof(repo, context, receipt),
    resume: async (context, value) => {
      const runtime = loadModules(context.runtimeProof), prisma = new runtime.PrismaClient({ datasources: { db: { url: maintenanceUrl(value, 'panda_hub_dev') } } });
      try { return await runtime.readCommittedDevMaster(prisma, { ...context.command, privateDirectory: context.privateDirectory, expectedPort: context.expectedPort }); }
      finally { await prisma.$disconnect(); }
    },
  };
}
async function main(args = process.argv.slice(2)) {
  if (args[0] === '--apply') { applyArguments(args); return runApply(args, actualDependencies()); }
  if (args[0] === '--resume') { resumeArguments(args); return runResume(args, actualDependencies()); }
  if (args[0] === '--recover-loaded-proof') { loadedRecoveryArguments(args); return runRecoverLoadedProof(args, actualDependencies()); }
  fail('USAGE', 'Use --apply with qualified evidence, --resume or --recover-loaded-proof with the original private directory.');
}
module.exports = Object.freeze({ assertLaunchJob, assertMigrations, assertMaintenanceConnections, assertClosedConnectionRows, assertGeneratedClient, maintenanceUrl, publicReceipt,
  privateWrite, readContext, verifyCompiledRuntime, assertRuntimeProofCurrent, verifyContextRuntime,
  parseProcessStart, assertLoadedProcess, buildBackendLoadedProof, assertBackendLoadedProof, createFileMetadataGuard,
  observeJob, assertPopulationJobCurrent, createPopulationRuntimeGuard, createPopulationMetadata: populationMetadata, persistBackendLoadedProof, recoverBackendLoadedProof,
  readMaintenanceIdentity: identity, readMaintenanceCatalog: catalog, readMigrationLedgerRows, runApply, runResume, runRecoverLoadedProof, main });
if (require.main === module) main().then(result => { console.log(JSON.stringify(result, null, 2));
  if (!['master_rebuilt', 'backend_loaded_verified'].includes(result.phase) || result.recoveryErrors?.length) process.exitCode = 1;
}).catch(error => { console.error(/^DEV_APPLY_|^DEV_REBUILD_/.test(error?.message ?? '') ? String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted connection]') : 'DEV_APPLY_FAILED: No automatic clear/seed retry was attempted. Retain the original private recovery context.'); process.exitCode = 1; });
