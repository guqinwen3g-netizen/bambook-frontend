/** Internal writer for the separately qualified current-dev maintenance CLI.
 * No database construction, HTTP route, process signal or automatic retry. */
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getBusinessClock } from '../../src/shared/businessClock';
import { prepareScenarioMasterData, writeScenarioMasterDataInTransaction } from './masterData';
import { writeDevMasterCastBeforeCommit, type DevMasterCommand, type DevMasterCommittedReceipt } from './provisionDevMaster';

type TableFact = { name: string; rows: number; sha256: string };
type Snapshot = { tables: TableFact[]; businessSha256: string; migrationsSha256: string };
export interface QualifiedDevRebuildPlan {
  protocolVersion: 1; phase: 'reviewable_preflight'; namespace: string; requestKey: string; planSha256: string;
  database: 'panda_hub_dev'; port: number; businessTime: string; clearTables: string[]; preserveTables: string[];
  qualified: { sourceSha256: string; schemaSha256: string; developmentReached: number; ordersReached: number; businessTime: string };
  backup: { businessSha256: string; migrationsSha256: string };
}
const FIXED = '2026-10-08T00:18:00.000Z';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
function fail(code: string): never { throw Error(`DEV_REBUILD_${code}`); }

interface TruncateGuard {
  table: string; name: string; state: string; type: number; args: string; argCount: number;
  functionSchema: string; functionName: string; functionBody: string; qualification: string | null;
}
const reviewedTruncateTables = ['OrderSampleSource', 'OrderSampleCoverage', 'OrderSampleEvent', 'OrderSampleCommandCancellation'];
const normalizeSql = (value: string) => value.trim().replace(/\s+/g, ' ');
/** Only the four immutable-history TRUNCATE guards reviewed in the original
 * migrations may be suspended, under the already established dev fence and
 * table locks. Row/constraint triggers stay enabled throughout. */
export function buildReviewedTruncateGuardMaintenance(rows: TruncateGuard[]) {
  if (rows.length !== reviewedTruncateTables.length || new Set(rows.map(row => row.table)).size !== rows.length)
    fail('UNREVIEWED_TRUNCATE_GUARD');
  const body = "BEGIN RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514'; END;";
  for (const row of rows) {
    if (!reviewedTruncateTables.includes(row.table) || row.name !== `${row.table}_no_truncate`
      || !['O', 'A', 'R', 'D'].includes(row.state) || row.type !== 34 || row.args !== '' || row.argCount !== 0
      || row.qualification !== null || row.functionSchema !== 'public' || row.functionName !== 'bambook_order_sample_immutable'
      || normalizeSql(row.functionBody) !== body) fail('UNREVIEWED_TRUNCATE_GUARD');
  }
  return rows.filter(row => row.state !== 'D').map(row => {
    const target = `ALTER TABLE ONLY public.${quote(row.table)}`;
    const mode = row.state === 'A' ? 'ENABLE ALWAYS' : row.state === 'R' ? 'ENABLE REPLICA' : 'ENABLE';
    return { disable: `${target} DISABLE TRIGGER ${quote(row.name)}`, restore: `${target} ${mode} TRIGGER ${quote(row.name)}` };
  });
}
async function triggerCatalog(tx: Prisma.TransactionClient) {
  return tx.$queryRaw<Array<{ table: string; name: string; state: string; definition: string }>>`
    SELECT c.relname AS table, t.tgname AS name, t.tgenabled::text AS state, pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"`;
}

export function assertExclusiveDevObservation(identity: any, otherSessions: any[], expectedPort: number) {
  if (!identity || identity.name !== 'panda_hub_dev' || identity.port !== expectedPort
    || !Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535
    || !['127.0.0.1', '::1', '127.0.0.1/32', '::1/128'].includes(identity.address)
    || !Number.isInteger(identity.pid) || identity.pid < 1) fail('TARGET');
  // Idle sessions count too: they could issue a stale write after COMMIT.
  if (identity.allowsNewConnections !== false) fail('CONNECTION_FENCE');
  if (!Array.isArray(otherSessions) || otherSessions.length) fail('OTHER_SESSION');
}
export function buildDevClearStatement(names: string[]) {
  if (!Array.isArray(names) || !names.includes('_prisma_migrations') || names.length < 2
    || new Set(names).size !== names.length || names.some(name => typeof name !== 'string' || !name || name.includes('\0'))) fail('TABLE_INVENTORY');
  return `TRUNCATE TABLE ${names.filter(name => name !== '_prisma_migrations').sort()
    .map(name => `ONLY public.${quote(name)}`).join(', ')} RESTART IDENTITY RESTRICT`;
}
async function observe(tx: Prisma.TransactionClient, port: number) {
  const identity = await tx.$queryRaw<any[]>`SELECT current_database() AS name, inet_server_port() AS port,
    inet_server_addr()::text AS address, pg_backend_pid() AS pid,
    (SELECT datallowconn FROM pg_database WHERE datname=current_database()) AS "allowsNewConnections"`;
  const others = await tx.$queryRaw<any[]>`SELECT pid, state FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`;
  if (identity.length !== 1) fail('TARGET');
  assertExclusiveDevObservation(identity[0], others, port);
}
async function tableNames(tx: Prisma.TransactionClient): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ name: string }>>`SELECT tablename AS name FROM pg_tables
    WHERE schemaname='public' ORDER BY tablename COLLATE "C"`;
  return rows.map(row => row.name);
}
async function snapshot(tx: Prisma.TransactionClient, names: string[]): Promise<Snapshot> {
  const tables: TableFact[] = [];
  for (const name of names) {
    const rows = await tx.$queryRawUnsafe<Array<{ rows: bigint; sha256: string }>>(`SELECT count(*) AS rows,
      encode(sha256(convert_to(coalesce(string_agg(row_hash,'' ORDER BY row_hash),''),'UTF8')),'hex') AS sha256
      FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS row_hash FROM public.${quote(name)} AS t) AS source_rows`);
    if (rows.length !== 1 || rows[0].rows > BigInt(Number.MAX_SAFE_INTEGER)) fail('CONTENT_PROOF');
    tables.push({ name, rows: Number(rows[0].rows), sha256: rows[0].sha256 });
  }
  return { tables, businessSha256: sha(JSON.stringify(canonical(tables.filter(row => row.name !== '_prisma_migrations')))),
    migrationsSha256: tables.find(row => row.name === '_prisma_migrations')?.sha256 ?? '' };
}

export async function executeExclusiveDevMasterRebuild(prisma: PrismaClient, input: {
  plan: QualifiedDevRebuildPlan; originalSnapshot: Snapshot; privateDirectory: string;
  /** Real controller must reverify the exact launchd job has been removed,
   * original PID exited and port 8081 is not listening on every invocation. */
  assertMaintenanceHeld(): Promise<void>;
}) {
  const { plan } = input, { planSha256, ...originalPlan } = plan;
  if (plan.protocolVersion !== 1 || plan.phase !== 'reviewable_preflight' || plan.database !== 'panda_hub_dev'
    || plan.businessTime !== FIXED || plan.qualified?.businessTime !== FIXED || plan.qualified.developmentReached !== 24
    || plan.qualified.ordersReached !== 36 || !/^[a-f0-9]{64}$/.test(plan.qualified.sourceSha256)
    || !/^[a-f0-9]{64}$/.test(plan.qualified.schemaSha256) || planSha256 !== sha(JSON.stringify(canonical(originalPlan)))
    || !same(plan.preserveTables, ['_prisma_migrations']) || plan.backup.businessSha256 !== input.originalSnapshot.businessSha256
    || plan.backup.migrationsSha256 !== input.originalSnapshot.migrationsSha256) fail('QUALIFICATION');
  const clock = getBusinessClock();
  if (clock.mode !== 'fixed' || clock.nowIso !== FIXED || clock.database !== 'panda_hub_dev' || clock.timeZone !== 'Asia/Shanghai') fail('CLOCK');
  const command: DevMasterCommand = { namespace: plan.namespace, requestKey: plan.requestKey, planSha256, sourceSha256: plan.qualified.sourceSha256 };
  await input.assertMaintenanceHeld();
  const prepared = await prepareScenarioMasterData({ namespace: plan.namespace, nowMs: Date.parse(FIXED) });
  await input.assertMaintenanceHeld();
  const receipt = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '120s'");
    await observe(tx, plan.port);
    const names = await tableNames(tx);
    if (!same([...names.filter(name => name !== '_prisma_migrations')].sort(), [...plan.clearTables].sort())) fail('TABLE_INVENTORY');
    // The controller already fenced new connections in pg_database. Lock the
    // migration ledger too, but never clear or rewrite it. NOWAIT
    // makes any competing transaction a failure before destructive work.
    await tx.$executeRawUnsafe(`LOCK TABLE ${names.map(name => `ONLY public.${quote(name)}`).join(', ')} IN ACCESS EXCLUSIVE MODE NOWAIT`);
    await observe(tx, plan.port);
    const before = await snapshot(tx, names);
    if (!same(before.tables, input.originalSnapshot.tables) || before.businessSha256 !== plan.backup.businessSha256
      || before.migrationsSha256 !== plan.backup.migrationsSha256) fail('BACKUP_STALE');
    if (await tx.auditLog.count({ where: { action: 'dev_scenario_master_provisioned', targetType: 'ScenarioDevRebuild' } })) fail('ORIGINAL_RECEIPT_EXISTS');
    await input.assertMaintenanceHeld();
    const originalTriggers = await triggerCatalog(tx);
    const truncateGuards = await tx.$queryRaw<TruncateGuard[]>`SELECT c.relname AS table, t.tgname AS name,
      t.tgenabled::text AS state, t.tgtype::int AS type, encode(t.tgargs,'hex') AS args, t.tgnargs::int AS "argCount",
      fn.nspname AS "functionSchema", p.proname AS "functionName", p.prosrc AS "functionBody", t.tgqual::text AS qualification
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace fn ON fn.oid=p.pronamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal AND (t.tgtype::int & 32)=32
      ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"`;
    const maintenance = buildReviewedTruncateGuardMaintenance(truncateGuards);
    for (const trigger of maintenance) await tx.$executeRawUnsafe(trigger.disable);
    await tx.$executeRawUnsafe(buildDevClearStatement(names));
    for (const trigger of maintenance) await tx.$executeRawUnsafe(trigger.restore);
    if (!same(await triggerCatalog(tx), originalTriggers)) fail('TRIGGER_CATALOG_CHANGED');
    await writeScenarioMasterDataInTransaction(tx, prepared);
    const cast = writeDevMasterCastBeforeCommit({ ...command, privateDirectory: input.privateDirectory, master: prepared.data });
    const transaction = await tx.$queryRaw<Array<{ id: string }>>`SELECT txid_current()::text AS id`;
    if (transaction.length !== 1 || !transaction[0].id) fail('TRANSACTION_ID');
    const committed: DevMasterCommittedReceipt = { protocolVersion: 1, phase: 'master_provisioned', ...command,
      credentialsSha256: cast.sha256, transactionId: transaction[0].id };
    await tx.auditLog.create({ data: { id: `DRB_${sha(plan.requestKey)}`, actorId: 'system', action: 'dev_scenario_master_provisioned',
      targetType: 'ScenarioDevRebuild', targetId: plan.requestKey,
      detail: { source: 'script:dev-scenario-rebuild', after: committed as unknown as Prisma.InputJsonObject } } });
    const migration = (await snapshot(tx, ['_prisma_migrations'])).migrationsSha256;
    if (migration !== before.migrationsSha256) fail('MIGRATION_LEDGER_CHANGED');
    await observe(tx, plan.port);
    await input.assertMaintenanceHeld();
    return committed;
  }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 120000 });
  // Credentials are returned only to the private caller. Public evidence must
  // contain the receipt, never this master or the prepared password hash.
  return { receipt, master: prepared.data, currentDevRebuilt: true, businessDriverComplete: false };
}
