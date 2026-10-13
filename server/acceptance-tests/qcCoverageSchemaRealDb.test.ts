/** Private-PG storage contract only. INITIAL synthetic legacy report/task rows
 * are not native assignments, approvals, real physical batches or delivery.
 * Coverage remains unknown until an actual producer freezes it. No shared DB. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
let prisma: PrismaClient | undefined;
const prefix = `acceptance-qc-schema-${randomUUID()}`;
const db = () => { if (!prisma) throw Error('Private schema identity not verified'); return prisma; };
beforeAll(async () => {
  const { DATABASE_URL: urlText, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!urlText || !sandbox || !name || !directory || !port) throw Error('Reviewed private PG required');
  const url = new URL(urlText);
  expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: urlText } } });
  expect(await db().$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
});
afterAll(async () => { await prisma?.$disconnect(); });
function row(label: string) { const id = `${prefix}-${label}`; return { id, orderId: `${id}-order`, inspectionType: 'final',
  totalUnits: 100, passedUnits: 98, notes: 'INITIAL observations, no native customer or business decision',
  createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) }; }
describe('QC actual scope/revision persistence contract, not native workflow proof', () => {
  it('an old-shaped report gets whole-order revision 1 and no fabricated coverage/approval evidence', async () => {
    const input = row('legacy'), made = await db().inspectionReport.create({ data: input });
    expect(made).toMatchObject({ ...input, scopeType: 'whole_order', scopeKey: 'whole_order', revision: 1,
      productionBatchId: null, productionBatchRevision: null, scopeSnapshot: null, scopeFingerprint: null,
      supersedesId: null, contentFingerprint: null, requestKey: null, commandHash: null, approvedByBusiness: false });
  });
  it('two explicitly distinct coverage lineages can retain separate final results on the same order', async () => {
    const input = row('separate'), a = await db().inspectionReport.create({ data: { ...input,
      scopeType: 'production_batch', scopeKey: 'A', productionBatchId: 'INITIAL-scope-A', result: 'pass' } });
    const b = await db().inspectionReport.create({ data: { ...input, id: `${input.id}-B`,
      scopeType: 'production_batch', scopeKey: 'B', productionBatchId: 'INITIAL-scope-B', result: 'fail' } });
    expect(await db().inspectionReport.findMany({ where: { orderId: input.orderId }, orderBy: { scopeKey: 'asc' } }))
      .toEqual([a, b]);
    expect(a.approvedByBusiness).toBe(false); expect(b.approvedByBusiness).toBe(false);
    expect(a.scopeSnapshot).toBeNull(); expect(b.scopeSnapshot).toBeNull();
  });
  it('same lineage revision is unique; a new revision preserves every original report byte and points to its predecessor', async () => {
    const input = row('revision'), original = await db().inspectionReport.create({ data: { ...input, result: 'fail' } });
    await expect(db().inspectionReport.create({ data: { ...input, id: `${input.id}-duplicate` } })).rejects.toMatchObject({ code: 'P2002' });
    const next = await db().inspectionReport.create({ data: { ...input, id: `${input.id}-revision2`, revision: 2,
      supersedesId: input.id, notes: 'INITIAL corrected observation', result: 'pass' } });
    expect(next.supersedesId).toBe(original.id); expect(next.revision).toBe(2);
    expect(await db().inspectionReport.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(next.approvedByBusiness).toBe(false); expect(next.scopeSnapshot).toBeNull();
  });
  it('report request keys are unique for the actual inspector but independently usable by another inspector', async () => {
    const input = row('request'), key = `${input.id}-request`, who = `${input.id}-inspector`;
    const a = await db().inspectionReport.create({ data: { ...input, inspectedBy: who, requestKey: key } });
    await expect(db().inspectionReport.create({ data: { ...row('request-duplicate'), inspectedBy: who, requestKey: key } }))
      .rejects.toMatchObject({ code: 'P2002' });
    const b = await db().inspectionReport.create({ data: { ...row('request-other'), inspectedBy: `${who}-other`, requestKey: key } });
    expect(b.id).not.toBe(a.id); expect(await db().inspectionReport.findUniqueOrThrow({ where: { id: a.id } })).toEqual(a);
  });
});
