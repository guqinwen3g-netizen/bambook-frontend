/** Actual PostgreSQL DDL on the physically identified acceptance cluster only.
 * Every fixture and temporary constraint change rolls back after its assertions.
 * This proves migration integrity, not a business or UI acceptance journey. */
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../prisma/migrations/20261002010000_consolidation_shipment_integrity/migration.sql', import.meta.url), 'utf8');
let prisma: PrismaClient;
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name, BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed private acceptance PG required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(['localhost', '127.0.0.1']).toContain(url.hostname);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await prisma.$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`).toEqual([{ name, directory, port: Number(port) }]);
});
afterAll(async () => { await prisma?.$disconnect(); });
const rollback = Symbol('rollback private DDL fixture');
async function isolated(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  try { await prisma.$transaction(async tx => { await work(tx); throw rollback; }, { timeout: 20000 }); }
  catch (error) { if (error !== rollback) throw error; }
}
const dropConstraint = (tx: Prisma.TransactionClient) => tx.$executeRawUnsafe('ALTER TABLE "ConsolidationShipment" DROP CONSTRAINT "ConsolidationShipment_consolidationId_fkey"');
async function fixture(tx: Prisma.TransactionClient) {
  const id = `acceptance-consolidation-migration-${randomUUID()}`;
  await tx.containerConsolidation.create({ data: { id, createdAt: 1n, updatedAt: 1n } });
  const row = await tx.consolidationShipment.create({ data: { id: `${id}-shipment`, consolidationId: id, shipmentId: `${id}-external-shipment`, createdAt: 1n, note: 'Synthetic retained migration row' } });
  return { id, row };
}
async function constraint(tx: Prisma.TransactionClient) {
  return tx.$queryRaw<Array<{ validated: boolean; deleteAction: string; updateAction: string }>>`SELECT convalidated AS validated,confdeltype::text AS "deleteAction",confupdtype::text AS "updateAction" FROM pg_constraint WHERE conrelid='public."ConsolidationShipment"'::regclass AND conname='ConsolidationShipment_consolidationId_fkey'`;
}
async function rejectedWithoutDeleting(tx: Prisma.TransactionClient, code: string) {
  await tx.$executeRawUnsafe('SAVEPOINT migration_rejection');
  let failure: any;
  try { await tx.$executeRawUnsafe(migration); } catch (error) { failure = error; }
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT migration_rejection');
  expect(failure?.code).toBe('P2010'); expect(failure?.meta?.code).toBe(code);
}

describe('Native legacy consolidation foreign-key migration', () => {
  it('keeps an existing correct constraint and retained rows on repeated execution', async () => isolated(async tx => {
    const { row } = await fixture(tx);
    await tx.$executeRawUnsafe(migration); await tx.$executeRawUnsafe(migration);
    expect(await constraint(tx)).toEqual([{ validated: true, deleteAction: 'c', updateAction: 'c' }]);
    expect(await tx.consolidationShipment.findUnique({ where: { id: row.id } })).toEqual(row);
  }));
  it('restores the missing constraint, preserves rows, and enforces both declared cascades', async () => isolated(async tx => {
    const { id, row } = await fixture(tx); await dropConstraint(tx); await tx.$executeRawUnsafe(migration);
    expect(await tx.consolidationShipment.findUnique({ where: { id: row.id } })).toEqual(row);
    expect(await constraint(tx)).toEqual([{ validated: true, deleteAction: 'c', updateAction: 'c' }]);
    const renamed = `${id}-renamed`; await tx.containerConsolidation.update({ where: { id }, data: { id: renamed } });
    expect((await tx.consolidationShipment.findUniqueOrThrow({ where: { id: row.id } })).consolidationId).toBe(renamed);
    await tx.containerConsolidation.delete({ where: { id: renamed } });
    expect(await tx.consolidationShipment.findUnique({ where: { id: row.id } })).toBeNull();
  }));
  it('rejects a real orphan with PostgreSQL 23503 and retains the orphan and all original rows', async () => isolated(async tx => {
    const { row } = await fixture(tx); await dropConstraint(tx);
    const orphan = await tx.consolidationShipment.create({ data: { ...row, id: `${row.id}-orphan`, consolidationId: `${row.consolidationId}-missing`, shipmentId: `${row.shipmentId}-orphan` } });
    await rejectedWithoutDeleting(tx, '23503');
    expect(await constraint(tx)).toEqual([]);
    expect(await tx.consolidationShipment.findUnique({ where: { id: row.id } })).toEqual(row);
    expect(await tx.consolidationShipment.findUnique({ where: { id: orphan.id } })).toEqual(orphan);
  }));
  it('rejects a same-named constraint with different semantics without replacing it', async () => isolated(async tx => {
    const { row } = await fixture(tx); await dropConstraint(tx);
    await tx.$executeRawUnsafe('ALTER TABLE "ConsolidationShipment" ADD CONSTRAINT "ConsolidationShipment_consolidationId_fkey" FOREIGN KEY ("consolidationId") REFERENCES "ContainerConsolidation"("id") ON DELETE RESTRICT ON UPDATE CASCADE');
    await rejectedWithoutDeleting(tx, 'P0001');
    expect(await constraint(tx)).toEqual([{ validated: true, deleteAction: 'r', updateAction: 'c' }]);
    expect(await tx.consolidationShipment.findUnique({ where: { id: row.id } })).toEqual(row);
  }));
});
