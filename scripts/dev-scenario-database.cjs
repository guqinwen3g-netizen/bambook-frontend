// Target verification and recoverable backup for the user-authorized dev rebuild.
// This tool deliberately has no reset/seed operation. It never falls back to an
// old demo/empty database, and never logs a connection URL or password.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const { parse } = require(path.join(root, 'server/node_modules/dotenv'));
const evidenceDir = path.join(root, 'artifacts/acceptance-20261007/global-goal/dev-scenario');
const pgBin = '/opt/homebrew/opt/postgresql@16/bin';
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const MIGRATION_LEDGER_ROWS_SQL = `SELECT t.id, t.migration_name AS name, t.checksum,
  to_jsonb(t)->>'started_at' AS "startedAt", to_jsonb(t)->>'finished_at' AS "finishedAt",
  to_jsonb(t)->>'rolled_back_at' AS "rolledBackAt", t.applied_steps_count AS "appliedStepsCount",
  encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS "rowSha256"
  FROM public."_prisma_migrations" AS t ORDER BY t.id COLLATE "C"`;
const MAINTENANCE_CATALOG_SQL = `SELECT encode(sha256(convert_to(coalesce(jsonb_agg(fact ORDER BY fact::text)::text,'[]'),'UTF8')),'hex') AS sha256 FROM (
 SELECT jsonb_build_object('kind','relation','name',c.relname,'relkind',c.relkind,'persistence',c.relpersistence,'partition',c.relispartition,'bound',pg_get_expr(c.relpartbound,c.oid)) AS fact
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
 UNION ALL SELECT jsonb_build_object('kind','column','table',c.relname,'number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid))
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT jsonb_build_object('kind','constraint','table',c.relname,'name',x.conname,'definition',pg_get_constraintdef(x.oid,true)) FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
 UNION ALL SELECT jsonb_build_object('kind','index','name',c.relname,'definition',pg_get_indexdef(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('i','I')
 UNION ALL SELECT jsonb_build_object('kind','enum','name',t.typname,'order',e.enumsortorder,'label',e.enumlabel) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
 UNION ALL SELECT jsonb_build_object('kind','view','name',c.relname,'definition',pg_get_viewdef(c.oid,true)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m')
 UNION ALL SELECT jsonb_build_object('kind','trigger','name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,true)) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
 UNION ALL SELECT jsonb_build_object('kind','function','name',p.proname,'definition',pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')
 UNION ALL SELECT jsonb_build_object('kind','sequence','name',c.relname,'type',s.seqtypid,'start',s.seqstart,'increment',s.seqincrement,'min',s.seqmin,'max',s.seqmax,'cache',s.seqcache,'cycle',s.seqcycle) FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
 ) AS schema_facts`;

function loadTarget() {
  const env = { ...process.env };
  for (const [file, override] of [['server/.env.local', true], ['server/.env', false]]) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) continue;
    for (const [key, value] of Object.entries(parse(fs.readFileSync(target)))) {
      if (override || env[key] == null) env[key] = value;
    }
  }
  const url = new URL(env.DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/panda_hub_dev'
    || env.NODE_ENV === 'production'
    || [...url.searchParams.keys()].some(key => ['host', 'hostaddr', 'dbname', 'database', 'service'].includes(key.toLowerCase()))) throw Error('Only local panda_hub_dev in a non-production environment is allowed.');
  const pgEnv = { ...process.env, PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432', PGDATABASE: 'panda_hub_dev', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'bambook-dev-scenario-backup' };
  return { env, pgEnv, host: url.hostname, port: Number(url.port || '5432') };
}

function psql(target, sql) {
  return cp.execFileSync(path.join(pgBin, 'psql'), ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { env: target.pgEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Every maintenance GET closes its connection before synchronous compiler
 * work can leave a stale keepalive socket in the process-wide fetch pool. */
function freshMaintenanceGet(route, timeoutMs = 5000) {
  if (!['/api/dev/status', '/api/dev/database-identity', '/api/health'].includes(route)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw Error('MAINTENANCE_HTTP_TARGET: only the exact read-only loopback maintenance routes are allowed.');
  return fetch('http://127.0.0.1:8081' + route, { method: 'GET', headers: { Connection: 'close' },
    redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
}

async function liveIdentity() {
  const response = await freshMaintenanceGet('/api/dev/status');
  const body = await response.json();
  if (response.status !== 200 || body.ok !== true || body.devPanelEnabled !== true
    || body.currentDb !== 'panda_hub_dev' || body.env?.nodeEnv === 'production') {
    throw Error('Running backend is not the authorized dev target.');
  }
  return { currentDb: body.currentDb, nodeEnv: body.env.nodeEnv, stats: body.stats };
}

async function inspect(target) {
  const live = await liveIdentity();
  const sql = `BEGIN READ ONLY;
    SELECT json_build_object('name',current_database(),'port',inet_server_port(),
      'address',inet_server_addr()::text,'readOnly',current_setting('transaction_read_only'));
    SELECT json_build_object('accounts',(SELECT count(*) FROM "UserAccount" WHERE "deletedAt" IS NULL),
      'orders',(SELECT count(*) FROM "Order"),'relations',(SELECT count(*) FROM "Relation"),
      'publicTables',(SELECT count(*) FROM pg_tables WHERE schemaname='public'));
    COMMIT;`;
  const records = psql(target, sql).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const [database, counts] = records;
  if (database?.name !== 'panda_hub_dev' || database?.readOnly !== 'on' || database?.port !== target.port
    || !['127.0.0.1/32', '::1/128', '127.0.0.1', '::1'].includes(database?.address)
    || counts?.accounts !== live.stats.accountCount || counts?.orders !== live.stats.orderCount
    || counts?.relations !== live.stats.relationCount) throw Error('SQL/live backend identity or counts did not match.');
  const migrations = JSON.parse(psql(target, `BEGIN READ ONLY;
    SELECT coalesce(json_agg(json_build_object('name',migration_name,'finished',finished_at IS NOT NULL,
      'rolledBack',rolled_back_at IS NOT NULL) ORDER BY migration_name),'[]'::json)
    FROM "_prisma_migrations"; COMMIT;`).split('\n').find(line => line.startsWith('[')));
  return { observedAt: new Date().toISOString(), readOnly: true, database, counts, live, migrations };
}

/** Stronger read-only evidence for a later rebuild preflight. Aggregate account
 * counts are deliberately insufficient: every public row contributes to its
 * table hash, including the original migration ledger. No row values escape. */
function readOnlyBusinessSnapshot(target) {
  const pg = target.pgEnv;
  if (target.env?.NODE_ENV === 'production' || pg.PGDATABASE !== 'panda_hub_dev'
    || !['localhost', '127.0.0.1', '::1'].includes(pg.PGHOST)
    || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
    || Number(pg.PGPORT) !== target.port || pg.PGHOSTADDR || pg.PGSERVICE || pg.PGSERVICEFILE) {
    throw Error('REBUILD_SNAPSHOT_TARGET: exact loopback dev connection without libpq redirects is required.');
  }
  const listSql = `BEGIN READ ONLY;
    SELECT coalesce(json_agg(tablename ORDER BY tablename COLLATE "C"),'[]'::json) FROM pg_tables WHERE schemaname='public'; COMMIT;`;
  const names = JSON.parse(psql(target, listSql).split('\n').find(line => line.startsWith('[')) || 'null');
  if (!Array.isArray(names) || !names.length || !names.includes('_prisma_migrations')
    || names.some(name => typeof name !== 'string' || !name.length || name.includes('\0')) || new Set(names).size !== names.length) throw Error('REBUILD_SNAPSHOT_TABLES: complete public table inventory is required.');
  const literal = value => `'${value.replace(/'/g, "''")}'`, identifier = value => `"${value.replace(/"/g, '""')}"`;
  const statements = names.map(name => `SELECT json_build_object('name',${literal(name)},'rows',count(*),'sha256',
    encode(sha256(convert_to(coalesce(string_agg(row_hash,'' ORDER BY row_hash),''),'UTF8')),'hex'))
    FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS row_hash FROM public.${identifier(name)} AS t) AS source_rows;`);
  const sql = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SELECT json_build_object('name',current_database(),'port',inet_server_port(),'address',inet_server_addr()::text,
      'readOnly',current_setting('transaction_read_only'));
    ${statements.join('\n')}
    SELECT coalesce(json_agg(tablename ORDER BY tablename COLLATE "C"),'[]'::json) FROM pg_tables WHERE schemaname='public'; COMMIT;`;
  const lines = psql(target, sql).split('\n'), rows = lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const [identity, ...tables] = rows, finalNames = JSON.parse(lines.find(line => line.startsWith('[')) || 'null');
  if (identity?.name !== 'panda_hub_dev' || identity?.port !== target.port || identity?.readOnly !== 'on'
    || !['127.0.0.1/32', '::1/128', '127.0.0.1', '::1'].includes(identity?.address)
    || JSON.stringify(names) !== JSON.stringify(finalNames) || tables.length !== names.length
    || tables.some((table, index) => table.name !== names[index] || !Number.isSafeInteger(table.rows) || table.rows < 0 || !/^[a-f0-9]{64}$/.test(table.sha256))) {
    throw Error('REBUILD_SNAPSHOT_IDENTITY: SQL target/table inventory changed or content proof is incomplete.');
  }
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return { protocolVersion: 1, observedAt: new Date().toISOString(), identity, tables,
    businessSha256: crypto.createHash('sha256').update(JSON.stringify(canonical(tables.filter(table => table.name !== '_prisma_migrations')))).digest('hex'),
    migrationsSha256: tables.find(table => table.name === '_prisma_migrations').sha256 };
}

function migrationRowsSha256(rows) {
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const time = value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (!Array.isArray(rows) || !rows.length || new Set(rows.map(row => row?.id)).size !== rows.length
    || rows.some(row => !row || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name
      || !hash(row.checksum) || !hash(row.rowSha256) || typeof row.startedAt !== 'string' || !time(row.startedAt)
      || !time(row.finishedAt) || !time(row.rolledBackAt) || !Number.isSafeInteger(row.appliedStepsCount) || row.appliedStepsCount < 0))
    throw Error('MIGRATION_LEDGER_FACTS: complete immutable migration identities and full-row hashes are required.');
  // Identical to the complete backup's SQL: SHA256(concat(sorted row SHA256)).
  return crypto.createHash('sha256').update(rows.map(row => row.rowSha256).sort().join('')).digest('hex');
}

/** Full-row hashes include original logs and all timestamp precision, without
 * exporting logs or credentials. Record the psql session timezone: maintenance
 * Prisma transactions must use that same projection before hashing to_jsonb. */
function readOnlyMigrationLedger(target) {
  const pg = target?.pgEnv;
  if (!pg || target.env?.NODE_ENV === 'production' || pg.PGDATABASE !== 'panda_hub_dev'
    || !['localhost', '127.0.0.1', '::1'].includes(pg.PGHOST)
    || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
    || Number(pg.PGPORT) !== target.port || pg.PGHOSTADDR || pg.PGSERVICE || pg.PGSERVICEFILE)
    throw Error('MIGRATION_LEDGER_TARGET: exact read-only loopback dev target required.');
  const sql = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SELECT json_build_object('name',current_database(),'port',inet_server_port(),'address',inet_server_addr()::text,
      'readOnly',current_setting('transaction_read_only'),'timeZone',current_setting('TimeZone'));
    SELECT coalesce(json_agg(row_to_json(ledger_rows) ORDER BY ledger_rows.id COLLATE "C"),'[]'::json)
      FROM (${MIGRATION_LEDGER_ROWS_SQL}) AS ledger_rows;
    ${MAINTENANCE_CATALOG_SQL}; COMMIT;`;
  const lines = psql(target, sql).split('\n'), identities = lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line)),
    lists = lines.filter(line => line.startsWith('[')).map(line => JSON.parse(line)), catalogs = lines.filter(line => /^[a-f0-9]{64}$/.test(line));
  const identity = identities[0], rows = lists[0], timeZone = identity?.timeZone;
  if (identities.length !== 1 || lists.length !== 1 || catalogs.length !== 1 || identity.name !== 'panda_hub_dev'
    || identity.port !== target.port || identity.readOnly !== 'on'
    || !['127.0.0.1', '::1', '127.0.0.1/32', '::1/128'].includes(identity.address)
    || typeof timeZone !== 'string' || !/^[A-Za-z0-9_+:/.-]{1,128}$/.test(timeZone))
    throw Error('MIGRATION_LEDGER_IDENTITY: original SQL target, timezone or catalog was not proved.');
  return { protocolVersion: 1, identity: { name: identity.name, port: identity.port, address: identity.address, readOnly: identity.readOnly },
    timeZone, catalogSha256: catalogs[0], rows, migrationsSha256: migrationRowsSha256(rows) };
}

/** Pre-reset physical anchor. Unlike a master receipt it exists before any
 * scenario data, and unlike counts it cannot confuse two same-name clusters. */
function readOnlyDatabaseIdentity(target) {
  const pg = target?.pgEnv;
  if (!pg || target.env?.NODE_ENV === 'production' || pg.PGDATABASE !== 'panda_hub_dev'
    || !['localhost', '127.0.0.1', '::1'].includes(pg.PGHOST) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
    || Number(pg.PGPORT) !== target.port || pg.PGHOSTADDR || pg.PGSERVICE || pg.PGSERVICEFILE)
    throw Error('REBUILD_IDENTITY_TARGET: exact loopback dev connection without libpq redirects is required.');
  const sql = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SELECT json_build_object('protocolVersion',1,'readOnly',current_setting('transaction_read_only'),
      'database',json_build_object('name',current_database(),'port',inet_server_port(),'address',inet_server_addr()::text,
        'instanceFingerprint',bambook_runtime_identity.physical_fingerprint())); COMMIT;`;
  const rows = psql(target, sql).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)), row = rows[0], database = row?.database;
  if (rows.length !== 1 || row.protocolVersion !== 1 || row.readOnly !== 'on' || database?.name !== 'panda_hub_dev' || database.port !== target.port
    || !['127.0.0.1/32', '::1/128', '127.0.0.1', '::1'].includes(database.address) || !/^[a-f0-9]{64}$/.test(database.instanceFingerprint ?? ''))
    throw Error('REBUILD_IDENTITY_TARGET: actual read-only physical database identity was not proved.');
  return row;
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--verify-backup' || mode === '--verify-upgrade') return verifyBackup(mode === '--verify-upgrade');
  if (mode === '--upgrade-and-configure-clock') return applyVerifiedUpgrade();
  if (!['--inspect', '--backup'].includes(mode)) throw Error('Usage: node scripts/dev-scenario-database.cjs --inspect|--backup|--verify-backup');
  const target = loadTarget();
  const before = await inspect(target);
  fs.mkdirSync(evidenceDir, { recursive: true });
  if (mode === '--inspect') {
    fs.writeFileSync(path.join(evidenceDir, 'target-inspection.json'), JSON.stringify(before, null, 2) + '\n');
    console.log(JSON.stringify({ database: before.database, counts: before.counts, migrations: before.migrations.length, readOnly: true }));
    return;
  }
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-dev-before-scenario-'));
  fs.chmodSync(backupDir, 0o700);
  const dump = path.join(backupDir, 'panda_hub_dev.dump');
  cp.execFileSync(path.join(pgBin, 'pg_dump'), ['--format=custom', '--no-owner', '--no-acl', '--file', dump],
    { env: target.pgEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.chmodSync(dump, 0o600);
  const restoreList = cp.execFileSync(path.join(pgBin, 'pg_restore'), ['--list', dump], { encoding: 'utf8' });
  if (!restoreList.includes('TABLE DATA public')) throw Error('Backup contains no restorable table data.');
  // Preserve current file roots; do not delete shared attachments used by other DBs.
  const fileRoots = [target.env.BAMBOOK_PRIVATE_FILES_DIR || path.join(root, 'server/private-files'),
    target.env.BAMBOOK_UPLOAD_DIR || path.join(root, 'uploads'), path.join(root, 'private-credit-note-refunds')]
    .map(file => path.resolve(root, file)).filter(file => fs.existsSync(file));
  const files = path.join(backupDir, 'business-files.tar.gz');
  if (fileRoots.length) {
    cp.execFileSync('/usr/bin/tar', ['-czf', files, ...fileRoots.map(file => file.slice(1))],
      { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] });
    fs.chmodSync(files, 0o600);
  }
  const after = await inspect(target);
  if (JSON.stringify(before.counts) !== JSON.stringify(after.counts)) throw Error('Data changed during backup; retry before relying on it.');
  const receipt = { backupAt: new Date().toISOString(), database: before.database, backupDir,
    readOnlyBackup: true, before, after,
    files: [dump, ...(fileRoots.length ? [files] : [])].map(file => ({ path: file, bytes: fs.statSync(file).size, sha256: hashFile(file) })),
    restoreListChecked: true, restoredAndVerified: false,
    boundary: 'Protected backup, not a restore rehearsal or reset. Other databases and file roots were not modified.' };
  fs.writeFileSync(path.join(evidenceDir, 'backup-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ database: before.database.name, backupDir, files: receipt.files.map(file => ({ bytes: file.bytes, sha256: file.sha256 })), restoredAndVerified: false }));
}

async function applyVerifiedUpgrade() {
  const target = loadTarget(), before = await inspect(target);
  const receipt = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'backup-receipt.json'), 'utf8'));
  const rehearsal = receipt.upgradeRehearsal;
  const schema = path.join(root, 'server/prisma/schema.prisma');
  const migrationHashes = Object.fromEntries(fs.readdirSync(path.join(root, 'server/prisma/migrations'))
    .filter(name => fs.existsSync(path.join(root, 'server/prisma/migrations', name, 'migration.sql')))
    .map(name => [name, hashFile(path.join(root, 'server/prisma/migrations', name, 'migration.sql'))]));
  if (!receipt.restoredAndVerified || !rehearsal?.zeroSchemaDiff || !rehearsal.postgresStopped
    || rehearsal.sourceSchemaSha256 !== hashFile(schema)
    || JSON.stringify(migrationHashes) !== JSON.stringify(rehearsal.migrationSha256)
    || JSON.stringify(before.counts) !== JSON.stringify(receipt.before.counts)
    || JSON.stringify(before.migrations) !== JSON.stringify(receipt.before.migrations)) {
    throw Error('Current target/source no longer matches its verified backup upgrade; inspect, back up and rehearse again.');
  }
  for (const file of receipt.files) if (hashFile(file.path) !== file.sha256) throw Error('Verified backup changed.');
  // Reconstruct the URL exclusively from the SQL-verified target. PostgreSQL
  // redirect query parameters from an environment URL cannot override it.
  const url = new URL('postgresql://localhost/panda_hub_dev');
  url.hostname = target.pgEnv.PGHOST; url.port = target.pgEnv.PGPORT;
  url.username = target.pgEnv.PGUSER; url.password = target.pgEnv.PGPASSWORD;
  url.searchParams.set('schema', 'public');
  const env = { ...target.env, DATABASE_URL: url.toString(), CHECKPOINT_DISABLE: '1' };
  const cli = path.join(root, 'server/node_modules/prisma/build/index.js');
  const run = args => cp.execFileSync(process.execPath, [cli, ...args],
    { cwd: path.join(root, 'server'), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(evidenceDir, 'dev-migration-deploy.log'), run(['migrate', 'deploy', '--schema', schema]));
  const diff = run(['migrate', 'diff', '--from-url', url.toString(), '--to-schema-datamodel', schema, '--exit-code']);
  fs.writeFileSync(path.join(evidenceDir, 'dev-schema-diff.log'), diff);
  const localEnv = path.join(root, 'server/.env.local');
  const oldEnv = fs.existsSync(localEnv) ? fs.readFileSync(localEnv, 'utf8') : '';
  const savedEnv = path.join(receipt.backupDir, 'server-env-local.before-clock');
  fs.writeFileSync(savedEnv, oldEnv, { mode: 0o600, flag: 'wx' });
  const key = 'BAMBOOK_DEV_BUSINESS_TIME', value = '2026-10-08T00:18:00.000Z';
  const entries = oldEnv.split(/\r?\n/).filter(line => !/^\s*BAMBOOK_DEV_BUSINESS_TIME\s*=/.test(line));
  const next = entries.join('\n').replace(/\n*$/, '') + `\n${key}=${value}\n`;
  fs.writeFileSync(localEnv, next, { mode: 0o600 });
  const after = await inspect(target);
  const applied = { observedAt: new Date().toISOString(), database: after.database, beforeCounts: before.counts,
    afterCounts: after.counts, sourceSchemaSha256: hashFile(schema), migrationSha256: migrationHashes,
    backupDir: receipt.backupDir, zeroSchemaDiff: true, businessTimeConfigured: value,
    serverRestarted: false, boundary: 'User-authorized local dev migration and clock configuration; no data reset or scenario seed.' };
  fs.writeFileSync(path.join(evidenceDir, 'dev-upgrade-receipt.json'), JSON.stringify(applied, null, 2) + '\n');
  console.log(JSON.stringify({ database: after.database.name, zeroSchemaDiff: true, businessTimeConfigured: value,
    counts: after.counts, serverRestarted: false }));
}

async function verifyBackup(upgrade = false) {
  const receiptPath = path.join(evidenceDir, 'backup-receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const backupDir = fs.realpathSync(receipt.backupDir);
  if (receipt.database?.name !== 'panda_hub_dev' || !path.basename(backupDir).startsWith('bambook-dev-before-scenario-')) throw Error('Unrecognized backup receipt.');
  for (const file of receipt.files) {
    if (path.dirname(fs.realpathSync(file.path)) !== backupDir || hashFile(file.path) !== file.sha256) throw Error('Backup path or digest changed.');
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-dev-backup-restore-'));
  fs.chmodSync(sandbox, 0o700);
  const data = path.join(sandbox, 'postgres');
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const actual = socket.address().port; socket.close(() => resolve(actual)); });
  });
  const env = { ...process.env, PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'backup_rehearsal',
    PGDATABASE: 'bambook_dev_backup_rehearsal', PGPASSWORD: '', PGCONNECT_TIMEOUT: '5' };
  let started = false;
  const run = (tool, args) => cp.execFileSync(path.join(pgBin, tool), args, { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  try {
    run('initdb', ['-D', data, '-U', 'backup_rehearsal', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    run('pg_ctl', ['-D', data, '-l', path.join(sandbox, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${sandbox}`, '-w', 'start']);
    started = true;
    run('createdb', ['bambook_dev_backup_rehearsal']);
    run('pg_restore', ['--exit-on-error', '--no-owner', '--no-acl', '--dbname', 'bambook_dev_backup_rehearsal', path.join(backupDir, 'panda_hub_dev.dump')]);
    const rows = psql({ pgEnv: env }, `BEGIN READ ONLY;
      SELECT json_build_object('name',current_database(),'port',inet_server_port(),
        'accounts',(SELECT count(*) FROM "UserAccount" WHERE "deletedAt" IS NULL),
        'orders',(SELECT count(*) FROM "Order"),'relations',(SELECT count(*) FROM "Relation"),
        'publicTables',(SELECT count(*) FROM pg_tables WHERE schemaname='public'),
        'migrations',(SELECT count(*) FROM "_prisma_migrations")); COMMIT;`)
      .split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const restored = rows[0];
    if (restored?.name !== env.PGDATABASE || restored.port !== port
      || ['accounts', 'orders', 'relations', 'publicTables'].some(key => restored[key] !== receipt.before.counts[key])
      || restored.migrations !== receipt.before.migrations.length) throw Error('Restored backup readback does not match its source.');
    if (upgrade) {
      // Rehearse the complete gap from the *actual* dev dump, rather than
      // assuming the newer synthetic acceptance baseline equals that DB.
      const schema = path.join(root, 'server/prisma/schema.prisma');
      const prismaCli = path.join(root, 'server/node_modules/prisma/build/index.js');
      const url = `postgresql://backup_rehearsal@127.0.0.1:${port}/${env.PGDATABASE}?schema=public`;
      const cliEnv = { ...env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1' };
      const deploy = cp.execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schema],
        { cwd: path.join(root, 'server'), env: cliEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      fs.writeFileSync(path.join(sandbox, 'migration-deploy.log'), deploy);
      let diff;
      try {
        diff = cp.execFileSync(process.execPath, [prismaCli, 'migrate', 'diff', '--from-url', url,
          '--to-schema-datamodel', schema, '--exit-code'],
          { cwd: path.join(root, 'server'), env: cliEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (failure) {
        fs.writeFileSync(path.join(sandbox, 'schema-diff.log'), String(failure.stdout || failure.stderr || ''));
        const sql = cp.execFileSync(process.execPath, [prismaCli, 'migrate', 'diff', '--from-url', url,
          '--to-schema-datamodel', schema, '--script'],
          { cwd: path.join(root, 'server'), env: cliEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        fs.writeFileSync(path.join(sandbox, 'schema-diff.sql'), sql);
        throw Error(`Actual dev upgrade has remaining schema differences; private diagnostic: ${path.join(sandbox, 'schema-diff.log')}`);
      }
      fs.writeFileSync(path.join(sandbox, 'schema-diff.log'), diff);
      const original = new Set(receipt.before.migrations.map(row => row.name));
      const applied = JSON.parse(psql({ pgEnv: env }, `BEGIN READ ONLY;
        SELECT coalesce(json_agg(migration_name ORDER BY migration_name),'[]'::json)
        FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL; COMMIT;`)
        .split('\n').find(line => line.startsWith('[')));
      receipt.upgradeRehearsal = { verifiedAt: new Date().toISOString(), sandbox, sourceSchemaSha256: hashFile(schema),
        migrationSha256: Object.fromEntries(fs.readdirSync(path.join(root, 'server/prisma/migrations')).filter(name => fs.existsSync(path.join(root, 'server/prisma/migrations', name, 'migration.sql')))
          .map(name => [name, hashFile(path.join(root, 'server/prisma/migrations', name, 'migration.sql'))])),
        appliedMigrations: applied.filter(name => !original.has(name)), zeroSchemaDiff: true,
        database: { name: env.PGDATABASE, port }, boundary: 'Actual dev backup restored and upgraded only inside a fresh private PostgreSQL cluster.' };
    }
    const filesArchive = receipt.files.find(file => file.path.endsWith('business-files.tar.gz'));
    if (filesArchive) cp.execFileSync('/usr/bin/tar', ['-tzf', filesArchive.path], { stdio: ['ignore', 'pipe', 'pipe'] });
    receipt.restoreRehearsal = { verifiedAt: new Date().toISOString(), sandbox, restored, fileArchiveReadable: Boolean(filesArchive),
      boundary: 'SQL dump restored into a fresh private PG cluster; protected file archive listed, not restored over shared roots.' };
    receipt.restoredAndVerified = true;
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    if (receipt.restoreRehearsal) receipt.restoreRehearsal.postgresStopped = true;
    if (receipt.upgradeRehearsal) receipt.upgradeRehearsal.postgresStopped = true;
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  }
  console.log(JSON.stringify({ database: receipt.database.name, restoredAndVerified: receipt.restoredAndVerified,
    rehearsal: receipt.restoreRehearsal.restored, upgradedMigrations: receipt.upgradeRehearsal?.appliedMigrations.length,
    zeroSchemaDiff: receipt.upgradeRehearsal?.zeroSchemaDiff, postgresStopped: true }));
}

module.exports = Object.freeze({ root, evidenceDir, hashFile, loadTarget, liveIdentity, inspect, readOnlyBusinessSnapshot, readOnlyDatabaseIdentity,
  freshMaintenanceGet, readOnlyMigrationLedger, migrationRowsSha256, MIGRATION_LEDGER_ROWS_SQL, MAINTENANCE_CATALOG_SQL });
if (require.main === module) main().catch(error => {
  console.error('Dev target operation failed:', String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted connection]'));
  process.exitCode = 1;
});
