/** Controlled master planning and original-receipt recovery only. There is no
 * Prisma construction, environment loading, reset or seed executor here. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma, type PrismaClient } from '@prisma/client';
import { BUSINESS_CLOCK_DATABASE, BUSINESS_TIME_ZONE, FIXED_BUSINESS_TIME_ISO, getBusinessClock } from '../../src/shared/businessClock';
import { planScenarioMasterData, type ScenarioMasterData } from './masterData';

export interface DevMasterCommand {
  namespace: string;
  requestKey: string;
  planSha256: string;
  sourceSha256: string;
}
export interface DevMasterCommittedReceipt extends DevMasterCommand {
  protocolVersion: 1;
  phase: 'master_provisioned';
  credentialsSha256: string;
  transactionId: string;
}
interface ProtectedCast extends DevMasterCommand {
  protocolVersion: 1;
  phase: 'prepared_before_commit';
  preparedAtWallIso: string;
  master: ScenarioMasterData;
}
export type DevMasterRecovery = {
  phase: 'unknown'; canReseed: false; businessDriverComplete: false; reason: 'ORIGINAL_TRANSACTION_RECEIPT_MISSING';
} | {
  phase: 'master_provisioned'; replayed: true; canReseed: false; businessDriverComplete: false;
  receipt: DevMasterCommittedReceipt; auditId: string; recordedAtWallIso: string; master: ScenarioMasterData;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fail(code: string, message: string): never { throw Error(`DEV_MASTER_${code}: ${message}`); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('RECEIPT', 'Original evidence is not an object.');
  return value as Record<string, unknown>;
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
function validateCommand(input: DevMasterCommand): void {
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(input.namespace) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(input.requestKey)
    || !isHash(input.planSha256) || !isHash(input.sourceSha256)) fail('INPUT', 'Exact namespace, stable request key and original plan/source digests are required.');
}
function assertActualClock(): void {
  const clock = getBusinessClock();
  if (clock.mode !== 'fixed' || clock.nowIso !== FIXED_BUSINESS_TIME_ISO || clock.database !== BUSINESS_CLOCK_DATABASE || clock.timeZone !== BUSINESS_TIME_ZONE)
    fail('TARGET', 'Only the actual guarded fixed-clock development database may recover this receipt.');
}
export function buildDevMasterProvisionPlan(input: DevMasterCommand) {
  validateCommand(input);
  const master = planScenarioMasterData({ namespace: input.namespace, nowMs: Date.parse(FIXED_BUSINESS_TIME_ISO) });
  return { ...input, mode: 'plan' as const, executable: false as const, currentDevRebuilt: false as const, businessDriverComplete: false as const,
    preserveTables: ['_prisma_migrations'] as const, master,
    requiredAtomicity: 'Future maintenance controller must use one transaction for exact public-table clear + master producer + original AuditLog receipt. Save private cast durably before COMMIT. Resume never calls the seeder.' };
}
export function createDevMasterPrivateDirectory(parent = os.tmpdir()): string {
  const directory = fs.mkdtempSync(path.join(parent, 'bambook-dev-scenario-rebuild-'));
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}
function protectedDirectory(value: string): string {
  const supplied = path.resolve(value), stat = fs.lstatSync(supplied), directory = fs.realpathSync(supplied);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !path.basename(directory).startsWith('bambook-dev-scenario-rebuild-')
    || (stat.mode & 0o777) !== 0o700 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('PATH', 'An owned, private 0700 rebuild directory is required.');
  return directory;
}
function castPath(directory: string, requestKey: string): string { return path.join(directory, `cast-${hash(requestKey)}.private.json`); }
function validateMaster(master: ScenarioMasterData, input: DevMasterCommand): ScenarioMasterData {
  if (master.namespace !== input.namespace || master.mode !== 'apply' || !master.cast) fail('CAST', 'The private cast must be the original already-produced master result.');
  const actors = Object.values(master.cast);
  if (actors.length !== 21 || actors.some(actor => typeof actor.password !== 'string' || !/^Scenario-[a-f0-9]{48}$/.test(actor.password))) fail('CAST', 'The actual original master credentials are missing.');
  const withoutCredentials = { ...master, mode: 'plan', cast: Object.fromEntries(actors.map(actor => [actor.key, { ...actor, password: null }])) };
  const expected = planScenarioMasterData({ namespace: input.namespace, nowMs: Date.parse(FIXED_BUSINESS_TIME_ISO) });
  if (JSON.stringify(canonical(withoutCredentials)) !== JSON.stringify(canonical(expected))) fail('CAST', 'The original cast/catalog no longer matches its exact namespace and fixed business plan.');
  return master;
}
/** Used only inside a future outer rebuild transaction, after the genuine seed
 * returned and BEFORE COMMIT. A failure propagates so that transaction rolls
 * back. Any existing original bytes force readback, never password rotation. */
export function writeDevMasterCastBeforeCommit(input: DevMasterCommand & { privateDirectory: string; master: ScenarioMasterData }): { path: string; sha256: string } {
  validateCommand(input); validateMaster(input.master, input);
  const directory = protectedDirectory(input.privateDirectory), file = castPath(directory, input.requestKey);
  const envelope: ProtectedCast = { protocolVersion: 1, phase: 'prepared_before_commit', namespace: input.namespace, requestKey: input.requestKey,
    planSha256: input.planSha256, sourceSha256: input.sourceSha256, preparedAtWallIso: new Date().toISOString(), master: input.master };
  const bytes = Buffer.from(JSON.stringify(envelope) + '\n');
  let descriptor: number;
  try { descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('CAST_EXISTS', 'Original private cast already exists; recover its original transaction instead of reseeding.'); throw error; }
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  return { path: file, sha256: hash(bytes) };
}
function readProtectedCast(input: DevMasterCommand & { privateDirectory: string }): { envelope: ProtectedCast; sha256: string } {
  const directory = protectedDirectory(input.privateDirectory), file = castPath(directory, input.requestKey), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('PATH', 'Original cast must remain an owned 0600 regular file.');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const actual = fs.fstatSync(descriptor);
    if (!actual.isFile() || (actual.mode & 0o777) !== 0o600 || actual.ino !== stat.ino || actual.dev !== stat.dev) fail('PATH', 'Private cast changed while opening its original bytes.');
    bytes = fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  const value = record(JSON.parse(bytes.toString('utf8')));
  if (value.protocolVersion !== 1 || value.phase !== 'prepared_before_commit' || value.namespace !== input.namespace || value.requestKey !== input.requestKey
    || value.planSha256 !== input.planSha256 || value.sourceSha256 !== input.sourceSha256 || typeof value.preparedAtWallIso !== 'string' || !Number.isFinite(Date.parse(value.preparedAtWallIso))) fail('CAST', 'Original request/plan/source bindings do not match the private cast.');
  // The complete deterministic non-credential shape and all credentials are
  // validated before any stored JSON is returned to the private driver.
  const master = validateMaster(value.master as ScenarioMasterData, input);
  return { envelope: { protocolVersion: 1, phase: 'prepared_before_commit', ...input, preparedAtWallIso: value.preparedAtWallIso, master }, sha256: hash(bytes) };
}
/** Readback after a lost COMMIT acknowledgement. Missing evidence is UNKNOWN,
 * never permission to reset again. Current accounts are checked without any
 * upsert, role restoration, seeding or password replacement. Credentials remain
 * private; callers must never include result.master in public logs. */
export async function readCommittedDevMaster(prisma: PrismaClient, input: DevMasterCommand & { privateDirectory: string; expectedPort: number }): Promise<DevMasterRecovery> {
  validateCommand(input); assertActualClock();
  if (!Number.isInteger(input.expectedPort) || input.expectedPort < 1 || input.expectedPort > 65535) fail('TARGET', 'Exact previously API/SQL-verified development port is required.');
  const original = readProtectedCast(input);
  const recovery = await prisma.$transaction(async tx => {
    await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
    const sql = await tx.$queryRaw<Array<{ name: string; port: number; address: string; readOnly: string }>>`
      SELECT current_database() AS name, inet_server_port() AS port, inet_server_addr()::text AS address,
        current_setting('transaction_read_only') AS "readOnly"`;
    if (sql.length !== 1 || sql[0].name !== BUSINESS_CLOCK_DATABASE || sql[0].port !== input.expectedPort || sql[0].readOnly !== 'on'
      || !['127.0.0.1', '::1', '127.0.0.1/32', '::1/128'].includes(sql[0].address)) fail('TARGET', 'The current SQL connection is not the original exact development target.');
    const rows = await tx.auditLog.findMany({ where: { action: 'dev_scenario_master_provisioned', targetType: 'ScenarioDevRebuild', targetId: input.requestKey },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2 });
    if (!rows.length) return { phase: 'unknown', canReseed: false, businessDriverComplete: false, reason: 'ORIGINAL_TRANSACTION_RECEIPT_MISSING' } as const;
    if (rows.length !== 1) fail('RECEIPT', 'The original rebuild transaction has ambiguous receipts.');
    const audit = rows[0], detail = record(audit.detail), fact = record(detail.after);
    if (audit.actorId !== 'system' || detail.source !== 'script:dev-scenario-rebuild' || fact.protocolVersion !== 1 || fact.phase !== 'master_provisioned'
      || fact.namespace !== input.namespace || fact.requestKey !== input.requestKey || fact.planSha256 !== input.planSha256 || fact.sourceSha256 !== input.sourceSha256
      || fact.credentialsSha256 !== original.sha256 || typeof fact.transactionId !== 'string' || !fact.transactionId || !Number.isFinite(audit.createdAt.getTime())) fail('RECEIPT', 'Original transaction/source/cast receipt no longer matches.');
    const master = original.envelope.master, actors = Object.values(master.cast);
    const users = await tx.userAccount.findMany({ where: { id: { in: actors.map(actor => actor.id) } }, include: { roles: true } });
    if (users.length !== actors.length) fail('ACCOUNT', 'A current cast account is unavailable; do not replace it through seeding.');
    const byId = new Map(users.map(user => [user.id, user]));
    for (const actor of actors) {
      const user = byId.get(actor.id), metadata = user ? record(user.metadata) : {};
      if (!user || user.status !== 'active' || user.deletedAt != null || user.email !== actor.email || user.primaryDeptId !== actor.departmentId
        || metadata.simulationNamespace !== input.namespace || metadata.scenarioActor !== actor.key || user.roles.length !== 1
        || user.roles[0].roleId !== actor.roleId || user.roles[0].departmentId !== actor.departmentId
        || !actor.password || !await bcrypt.compare(actor.password, user.passwordHash)) fail('ACCOUNT', `Current account or original credential changed: ${actor.key}.`);
    }
    const receipt: DevMasterCommittedReceipt = { protocolVersion: 1, phase: 'master_provisioned', namespace: input.namespace, requestKey: input.requestKey,
      planSha256: input.planSha256, sourceSha256: input.sourceSha256, credentialsSha256: original.sha256, transactionId: fact.transactionId };
    return { phase: 'master_provisioned', replayed: true, canReseed: false, businessDriverComplete: false,
      receipt, auditId: audit.id, recordedAtWallIso: audit.createdAt.toISOString(), master } as const;
  }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 60000 });
  assertActualClock();
  return recovery;
}
