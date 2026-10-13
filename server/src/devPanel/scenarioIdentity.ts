/** Bind a running HTTP server to its actual PostgreSQL instance and the exact
 * original scenario transaction. No connection URL or physical path is exposed. */
import { Prisma, type PrismaClient } from '@prisma/client';
import { getActiveDb } from './activeDb';
import { BUSINESS_CLOCK_DATABASE, BUSINESS_TIME_ZONE, FIXED_BUSINESS_TIME_ISO, getBusinessClock, type BusinessClock } from '../shared/businessClock';

export interface ScenarioMasterReceiptIdentity {
  protocolVersion: 1; phase: 'master_provisioned'; namespace: string; requestKey: string;
  planSha256: string; sourceSha256: string; credentialsSha256: string; transactionId: string;
}
export interface ScenarioDatabaseIdentity {
  protocolVersion: 1;
  database: { name: 'panda_hub_dev'; port: number; address: string; instanceFingerprint: string };
  businessClock: BusinessClock;
}
export interface ScenarioRuntimeIdentity extends ScenarioDatabaseIdentity {
  receipt: ScenarioMasterReceiptIdentity;
}
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requestKeyValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(value);
const loopbackSql = (value: unknown): value is string => typeof value === 'string'
  && ['127.0.0.1', '::1', '127.0.0.1/32', '::1/128'].includes(value);
function refuse(code = 'SCENARIO_RUNTIME_IDENTITY_CHANGED', statusCode = 409): never {
  throw Object.assign(new Error(code), { code, statusCode });
}
/** Check the actual socket, never the caller-controlled forwarded address. */
export const isScenarioLoopbackCaller = (value: unknown): boolean =>
  value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';

function assertFixedDevContext(): BusinessClock {
  if (process.env.NODE_ENV === 'production' || process.env.BAMBOOK_DEV_PANEL !== '1'
    || getActiveDb() !== BUSINESS_CLOCK_DATABASE) return refuse('SCENARIO_RUNNING_DEV_TARGET_CHANGED');
  const clock = getBusinessClock();
  if (clock.mode !== 'fixed' || clock.database !== BUSINESS_CLOCK_DATABASE || clock.timeZone !== BUSINESS_TIME_ZONE
    || clock.nowIso !== FIXED_BUSINESS_TIME_ISO) return refuse('SCENARIO_RUNNING_DEV_TARGET_CHANGED');
  return { ...clock };
}

/** The pre-master endpoint proves only the physical database and fixed clock. */
export function normalizeScenarioDatabaseIdentity(value: unknown): ScenarioDatabaseIdentity {
  const row = object(value), db = object(row.database), clock = object(row.businessClock);
  if (row.protocolVersion !== 1 || db.name !== BUSINESS_CLOCK_DATABASE || !Number.isInteger(db.port) || db.port < 1 || db.port > 65535
    || !loopbackSql(db.address) || !hash(db.instanceFingerprint)
    || clock.mode !== 'fixed' || clock.database !== BUSINESS_CLOCK_DATABASE || clock.timeZone !== BUSINESS_TIME_ZONE || clock.nowIso !== FIXED_BUSINESS_TIME_ISO) return refuse();
  return { protocolVersion: 1, database: { name: BUSINESS_CLOCK_DATABASE, port: db.port, address: db.address, instanceFingerprint: db.instanceFingerprint },
    businessClock: { mode: 'fixed', database: BUSINESS_CLOCK_DATABASE, timeZone: BUSINESS_TIME_ZONE, nowIso: FIXED_BUSINESS_TIME_ISO } };
}
/** Validate and select the public fields before comparing either side. */
export function normalizeScenarioRuntimeIdentity(value: unknown): ScenarioRuntimeIdentity {
  const basis = normalizeScenarioDatabaseIdentity(value), receipt = object(object(value).receipt);
  if (receipt.protocolVersion !== 1 || receipt.phase !== 'master_provisioned' || typeof receipt.namespace !== 'string' || !/^[a-z][a-z0-9-]{2,31}$/.test(receipt.namespace)
    || !requestKeyValid(receipt.requestKey) || !hash(receipt.planSha256) || !hash(receipt.sourceSha256) || !hash(receipt.credentialsSha256)
    || typeof receipt.transactionId !== 'string' || !/^\d+$/.test(receipt.transactionId)) return refuse();
  return { ...basis,
    receipt: { protocolVersion: 1, phase: 'master_provisioned', namespace: receipt.namespace, requestKey: receipt.requestKey,
      planSha256: receipt.planSha256, sourceSha256: receipt.sourceSha256, credentialsSha256: receipt.credentialsSha256, transactionId: receipt.transactionId } };
}

export function assertMatchingScenarioDatabaseIdentity(actual: unknown, expected: unknown): void {
  const left = normalizeScenarioDatabaseIdentity(actual), right = normalizeScenarioDatabaseIdentity(expected);
  // A single local PostgreSQL instance can accept IPv4 and IPv6 clients.
  const comparable = (proof: ScenarioDatabaseIdentity) => ({ ...proof, database: { ...proof.database, address: 'loopback' } });
  if (JSON.stringify(comparable(left)) !== JSON.stringify(comparable(right))) refuse();
}
export function assertMatchingScenarioRuntimeIdentity(actual: unknown, expected: unknown): void {
  const left = normalizeScenarioRuntimeIdentity(actual), right = normalizeScenarioRuntimeIdentity(expected);
  assertMatchingScenarioDatabaseIdentity(left, right);
  if (JSON.stringify(left.receipt) !== JSON.stringify(right.receipt)) refuse();
}

async function databaseIdentityInTransaction(tx: Prisma.TransactionClient, expectedPort?: number): Promise<ScenarioDatabaseIdentity> {
  type IdentityRow = { name: string; port: number; address: string; readOnly: string; instanceFingerprint: string };
  let rows: IdentityRow[];
  try {
    rows = await tx.$queryRaw<IdentityRow[]>`
      SELECT current_database() AS name, inet_server_port() AS port, inet_server_addr()::text AS address,
        current_setting('transaction_read_only') AS "readOnly",
        bambook_runtime_identity.physical_fingerprint() AS "instanceFingerprint"`;
  } catch (cause) {
    const error = object(cause), databaseCode = object(error.meta).code ?? error.code;
    if (['42501', '42883', '3F000'].includes(String(databaseCode))) return refuse('SCENARIO_PHYSICAL_IDENTITY_UNAVAILABLE', 409);
    throw cause;
  }
  const db = rows[0];
  if (rows.length !== 1 || db.name !== BUSINESS_CLOCK_DATABASE || db.readOnly !== 'on'
    || expectedPort !== undefined && db.port !== expectedPort) return refuse();
  return normalizeScenarioDatabaseIdentity({ protocolVersion: 1, database: { name: db.name, port: db.port, address: db.address,
    instanceFingerprint: db.instanceFingerprint }, businessClock: assertFixedDevContext() });
}

export async function readScenarioDatabaseIdentity(prisma: PrismaClient, expectedPort?: number): Promise<ScenarioDatabaseIdentity> {
  if (expectedPort !== undefined && (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535)) return refuse();
  assertFixedDevContext();
  const identity = await prisma.$transaction(async tx => {
    assertFixedDevContext();
    await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
    return databaseIdentityInTransaction(tx, expectedPort);
  }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 10000 });
  assertFixedDevContext();
  return identity;
}

export async function readScenarioRuntimeIdentity(prisma: PrismaClient, requestKey: unknown, expectedPort?: number): Promise<ScenarioRuntimeIdentity> {
  if (!requestKeyValid(requestKey)) return refuse('SCENARIO_ORIGINAL_REQUEST_REQUIRED', 400);
  if (expectedPort !== undefined && (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535)) return refuse();
  assertFixedDevContext();
  // Resolve the active data-source transaction once. Every SQL fact and the
  // original receipt below use its frozen transaction client, never the proxy.
  const proof = await prisma.$transaction(async tx => {
    assertFixedDevContext();
    await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
    const identity = await databaseIdentityInTransaction(tx, expectedPort);
    const audits = await tx.auditLog.findMany({ where: { action: 'dev_scenario_master_provisioned', targetType: 'ScenarioDevRebuild', targetId: requestKey },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2 });
    const audit = audits[0], detail = object(audit?.detail), receipt = object(detail.after);
    if (audits.length !== 1 || audit.actorId !== 'system' || detail.source !== 'script:dev-scenario-rebuild'
      || receipt.requestKey !== requestKey) return refuse('SCENARIO_RUNTIME_ORIGINAL_RECEIPT_CHANGED');
    const businessClock = assertFixedDevContext();
    return normalizeScenarioRuntimeIdentity({ ...identity, businessClock, receipt });
  }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 10000 });
  // A development company switch or clock change during the asynchronous read
  // must not turn a valid old transaction into permission for the next command.
  assertFixedDevContext();
  return proof;
}
