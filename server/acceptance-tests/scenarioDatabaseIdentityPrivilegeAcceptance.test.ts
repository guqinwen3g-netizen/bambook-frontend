import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { getActiveDb, setActiveDb } from '../src/devPanel/activeDb';
import { createDevPanelRouter } from '../src/devPanel/route';
import { assertMatchingScenarioDatabaseIdentity, readScenarioDatabaseIdentity } from '../src/devPanel/scenarioIdentity';

type MaintenanceIdentity = { name: string; port: number; address: string; pid: number; startedAt: string;
  instanceFingerprint: string | null; clusterControlFingerprint: string; user: string; owner: string;
  ownerMember: boolean; superuser: boolean; allowConnections: boolean };
const controller = require('../../scripts/dev-scenario-apply.cjs') as {
  readMaintenanceIdentity(db: PrismaClient): Promise<MaintenanceIdentity>;
  readMaintenanceCatalog(db: PrismaClient): Promise<string>;
  assertMaintenanceConnections(dev: MaintenanceIdentity, control: MaintenanceIdentity, port: number): void;
};
const guards = require('../../scripts/dev-scenario-database.cjs') as {
  readOnlyDatabaseIdentity(target: { env: { NODE_ENV: string }; port: number; pgEnv: NodeJS.ProcessEnv }):
    { protocolVersion: 1; readOnly: string; database: { name: string; port: number; address: string; instanceFingerprint: string } };
};
const migration = fs.readFileSync(path.resolve(__dirname, '../prisma/migrations/20261007320000_scenario_physical_identity/migration.sql'), 'utf8');
const nonce = randomBytes(5).toString('hex'), appRole = `identity_app_${nonce}`, strangerRole = `identity_other_${nonce}`;
const admin = new PrismaClient();
let devAdmin: PrismaClient | undefined, appDb: PrismaClient | undefined, controlDb: PrismaClient | undefined, stranger: PrismaClient | undefined;
let createdDatabase = false, createdAppRole = false, createdStrangerRole = false;
let port: number, adminUrl: URL, originalCatalog: string, expectedFingerprint: string;
const environmentKeys = ['DATABASE_URL', 'BAMBOOK_DEV_PANEL', 'BAMBOOK_DEV_BUSINESS_TIME'] as const;
const originalEnv = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const originalActive = getActiveDb();
function urlFor(database: string, role?: string) {
  const value = new URL(adminUrl); value.pathname = `/${database}`; value.searchParams.set('connection_limit', '1');
  if (role) { value.username = role; value.password = ''; }
  return value.toString();
}
function http() {
  if (!appDb) throw Error('PRIVATE_APP_DATABASE_NOT_READY');
  const app = express(); app.use('/api/dev', createDevPanelRouter({ prisma: appDb })); return request(app);
}
async function privilegeFacts() {
  if (!appDb) throw Error('PRIVATE_APP_DATABASE_NOT_READY');
  const [row] = await appDb.$queryRaw<Array<{ role: string; superuser: boolean; settingsMember: boolean; schemaCreate: boolean; helperExecute: boolean }>>`
    SELECT current_user AS role, r.rolsuper AS superuser,
      pg_has_role(current_user, 'pg_read_all_settings', 'MEMBER') AS "settingsMember",
      has_schema_privilege(current_user, 'bambook_runtime_identity', 'CREATE') AS "schemaCreate",
      has_function_privilege(current_user, 'bambook_runtime_identity.physical_fingerprint()', 'EXECUTE') AS "helperExecute"
    FROM pg_roles r WHERE rolname = current_user`;
  return row;
}

beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(admin);
  // This extra database and both login roles exist only in the runner's fresh
  // cluster. Never reinterpret an existing panda_hub_dev as our fixture.
  adminUrl = new URL(process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL!); port = Number(adminUrl.port);
  const existing = await admin.$queryRaw<Array<{ exists: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = 'panda_hub_dev') AS exists`;
  if (existing[0]?.exists !== false) throw Error('PRIVATE_IDENTITY_DATABASE_MUST_BE_NEW');
  await admin.$executeRawUnsafe(`CREATE ROLE "${appRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`); createdAppRole = true;
  await admin.$executeRawUnsafe(`CREATE ROLE "${strangerRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`); createdStrangerRole = true;
  await admin.$executeRawUnsafe(`CREATE DATABASE panda_hub_dev OWNER "${appRole}"`); createdDatabase = true;
  devAdmin = new PrismaClient({ datasources: { db: { url: urlFor('panda_hub_dev') } } });
  appDb = new PrismaClient({ datasources: { db: { url: urlFor('panda_hub_dev', appRole) } } });
  controlDb = new PrismaClient({ datasources: { db: { url: urlFor('postgres', appRole) } } });
  stranger = new PrismaClient({ datasources: { db: { url: urlFor('panda_hub_dev', strangerRole) } } });
  process.env.DATABASE_URL = urlFor('panda_hub_dev', appRole); process.env.BAMBOOK_DEV_PANEL = '1';
  process.env.BAMBOOK_DEV_BUSINESS_TIME = '2026-10-08T00:18:00.000Z';
  if (!setActiveDb('panda_hub_dev')) throw Error('PRIVATE_IDENTITY_ACTIVE_TARGET_REJECTED');
  await appDb.$executeRawUnsafe('CREATE TABLE public.identity_permission_canary (id integer PRIMARY KEY, value text NOT NULL)');
  await appDb.$executeRawUnsafe("INSERT INTO public.identity_permission_canary (id, value) VALUES (1, 'unchanged technical canary')");
  originalCatalog = await controller.readMaintenanceCatalog(devAdmin);
  const [physical] = await devAdmin.$queryRaw<Array<{ value: string }>>`
    SELECT encode(sha256(convert_to(current_setting('data_directory') || ':' ||
      (SELECT system_identifier::text FROM pg_control_system()), 'UTF8')), 'hex') AS value`;
  expectedFingerprint = physical.value;
});
afterAll(async () => {
  for (const key of environmentKeys) { const value = originalEnv[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  setActiveDb(originalActive);
  await Promise.allSettled([appDb?.$disconnect(), controlDb?.$disconnect(), stranger?.$disconnect(), devAdmin?.$disconnect()]);
  if (createdDatabase) await admin.$executeRawUnsafe('DROP DATABASE panda_hub_dev');
  if (createdAppRole) await admin.$executeRawUnsafe(`DROP ROLE "${appRole}"`);
  if (createdStrangerRole) await admin.$executeRawUnsafe(`DROP ROLE "${strangerRole}"`);
  await admin.$disconnect();
});

describe('actual unprivileged scenario database physical identity', () => {
  it('requires trusted bootstrap, then serves the same physical hash using the real non-superuser application connection', async () => {
    const app = appDb!, installer = devAdmin!;
    const [role] = await app.$queryRaw<Array<{ name: string; superuser: boolean; settingsMember: boolean }>>`
      SELECT current_user AS name, rolsuper AS superuser, pg_has_role(current_user,'pg_read_all_settings','MEMBER') AS "settingsMember"
      FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ name: appRole, superuser: false, settingsMember: false });
    await expect(app.$queryRawUnsafe("SELECT current_setting('data_directory')")).rejects.toMatchObject({ meta: { code: '42501' } });
    await expect(app.$executeRawUnsafe(migration)).rejects.toMatchObject({ meta: { code: '42501' } });
    const missing = await http().get('/api/dev/database-identity');
    expect(missing.status).toBe(409); expect(missing.body.error).toBe('SCENARIO_PHYSICAL_IDENTITY_UNAVAILABLE');
    await installer.$executeRawUnsafe(migration);
    await app.$executeRawUnsafe(migration); // app migrations assert the exact installation; never bypass it.
    const response = await http().get('/api/dev/database-identity');
    expect(response.status).toBe(200); expect(response.body.ok).toBe(true);
    expect(response.body.identity.database.instanceFingerprint).toBe(expectedFingerprint);
    expect(Object.keys(response.body.identity.database).sort()).toEqual(['address', 'instanceFingerprint', 'name', 'port']);
    expect(JSON.stringify(response.body).includes(process.env.BAMBOOK_ACCEPTANCE_DB_DIR!)).toBe(false);
    expect(await privilegeFacts()).toEqual({ role: appRole, superuser: false, settingsMember: false, schemaCreate: false, helperExecute: true });
    await expect(app.$queryRawUnsafe("SELECT current_setting('data_directory')")).rejects.toMatchObject({ meta: { code: '42501' } });
    expect(await controller.readMaintenanceCatalog(installer)).toBe(originalCatalog);
    expect(await app.$queryRawUnsafe('SELECT count(*)::integer AS count FROM public.identity_permission_canary')).toEqual([{ count: 1 }]);
  });

  it('binds guard and controller to the same hash while the separate postgres control connection reads no privileged path', async () => {
    const app = appDb!, original = await readScenarioDatabaseIdentity(app, port);
    const sql = guards.readOnlyDatabaseIdentity({ env: { NODE_ENV: 'test' }, port, pgEnv: {
      PGHOST: '127.0.0.1', PGPORT: String(port), PGDATABASE: 'panda_hub_dev', PGUSER: appRole,
      PGCONNECT_TIMEOUT: '5', PGPASSWORD: '',
    } });
    expect(sql.database.instanceFingerprint).toBe(expectedFingerprint);
    assertMatchingScenarioDatabaseIdentity({ ...sql, businessClock: original.businessClock }, original);
    const dev = await controller.readMaintenanceIdentity(app), control = await controller.readMaintenanceIdentity(controlDb!);
    expect(dev.instanceFingerprint).toBe(expectedFingerprint); expect(control.instanceFingerprint).toBeNull();
    expect(dev.clusterControlFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(control.clusterControlFingerprint).toBe(dev.clusterControlFingerprint);
    expect('dataDirectory' in dev || 'dataDirectory' in control).toBe(false);
    expect(() => controller.assertMaintenanceConnections(dev, control, port)).not.toThrow();
    expect(() => controller.assertMaintenanceConnections(dev, { ...control, startedAt: 'different actual instance' }, port)).toThrow('CONTROL');
    const wrong = (expectedFingerprint[0] === 'a' ? 'b' : 'a') + expectedFingerprint.slice(1);
    expect(() => assertMatchingScenarioDatabaseIdentity({ ...original, database: { ...original.database, instanceFingerprint: wrong } }, original)).toThrow('SCENARIO_RUNTIME_IDENTITY_CHANGED');
  });

  it('denies helper replacement and other roles, detects an unsafe ACL, and preserves the protected helper across public reset', async () => {
    const app = appDb!, installer = devAdmin!;
    await expect(stranger!.$queryRawUnsafe('SELECT bambook_runtime_identity.physical_fingerprint()')).rejects.toMatchObject({ meta: { code: '42501' } });
    await expect(app.$executeRawUnsafe('CREATE OR REPLACE FUNCTION bambook_runtime_identity.physical_fingerprint() RETURNS text LANGUAGE sql AS \'SELECT repeat(\'\'0\'\',64)\'')).rejects.toMatchObject({ meta: { code: '42501' } });
    await expect(app.$executeRawUnsafe('CREATE FUNCTION bambook_runtime_identity.any_path(text) RETURNS text LANGUAGE sql AS \'SELECT $1\'')).rejects.toMatchObject({ meta: { code: '42501' } });
    await installer.$executeRawUnsafe(`GRANT USAGE ON SCHEMA bambook_runtime_identity TO "${strangerRole}"`);
    await expect(app.$executeRawUnsafe(migration)).rejects.toMatchObject({ meta: { code: '42501' } });
    await installer.$executeRawUnsafe(`REVOKE ALL ON SCHEMA bambook_runtime_identity FROM "${strangerRole}"`);
    await app.$executeRawUnsafe(migration);
    await installer.$executeRawUnsafe(`REVOKE EXECUTE ON FUNCTION bambook_runtime_identity.physical_fingerprint() FROM "${appRole}"`);
    const denied = await http().get('/api/dev/database-identity');
    expect(denied.status).toBe(409); expect(denied.body.error).toBe('SCENARIO_PHYSICAL_IDENTITY_UNAVAILABLE');
    await installer.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION bambook_runtime_identity.physical_fingerprint() TO "${appRole}"`);
    await app.$executeRawUnsafe('TRUNCATE public.identity_permission_canary');
    expect((await readScenarioDatabaseIdentity(app, port)).database.instanceFingerprint).toBe(expectedFingerprint);
    expect(await controller.readMaintenanceCatalog(installer)).toBe(originalCatalog);
    const before = await controller.readMaintenanceCatalog(admin);
    await admin.$executeRawUnsafe(migration); // random acceptance DB is a production/non-dev no-op branch.
    expect(await controller.readMaintenanceCatalog(admin)).toBe(before);
    expect(await admin.$queryRawUnsafe("SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname='bambook_runtime_identity'")).toEqual([{ count: 0 }]);
  });
});
