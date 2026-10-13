/** Isolated actual PG source/command unit. Synthetic unapproved legacy goods
 * are persisted explicitly; no physical receipt, QC approval or dispatch is
 * fabricated. No HTTP/PDF/publication completeness is claimed. */
import { randomUUID } from 'node:crypto';
import { realpathSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../src/auth/tokenHelpers';
import { documentSourceJson, documentSourceFingerprint as hash } from '../src/shipping/shipmentDocumentSource';
import { readPackingListDraftSource, appendPackingListDraftVersion, readPackingListVersion } from '../src/customs/shipmentPackingListCommand';
import { renderPackingListBody } from '../src/templates/docTemplates/packingList';
import { EXPORTER_PROFILE_CONFIG_ID } from '../src/config/systemConfigRoute';

const prefix = 'acceptance-pl-draft-' + randomUUID();
let prisma: PrismaClient;
const peers: PrismaClient[] = [];
const db = () => prisma;
const peer = () => { const p = new PrismaClient(); peers.push(p); return p; };
const journal = (value: any) => appendFileSync(path.join(process.env.BAMBOOK_ATTACHMENT_READONLY_EVIDENCE!, 'pl-native.jsonl'), JSON.stringify(documentSourceJson(value)) + '\n');
beforeAll(async () => {
  const { DATABASE_URL: url, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name, BAMBOOK_ACCEPTANCE_DB_DIR: directory,
    BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!url || !sandbox || !name || !directory || !port) throw Error('Private actual PG required');
  const parsed = new URL(url); expect(parsed.hostname).toBe('127.0.0.1'); expect(parsed.pathname).toBe('/' + name); expect(parsed.port).toBe(port);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  prisma = new PrismaClient(); expect(await db().$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
  await db().role.create({ data: { id: prefix + '-sales', name: 'Synthetic pricing-neutral sales', isSystem: false } });
  await db().systemConfig.create({ data: { id: EXPORTER_PROFILE_CONFIG_ID, scope: 'global', key: 'company.exporterProfile', group: 'company', label: 'Synthetic explicit exporter',
    valueType: 'json', value: { nameEn: 'Native frozen export company', addressEn: 'Native known address' }, version: 1, updatedAt: BigInt(Date.now()) } });
});
afterAll(async () => { await Promise.all(peers.map(p => p.$disconnect())); await prisma?.$disconnect(); });

async function fixture(label: string) {
  const id = `${prefix}-${label}-${randomUUID()}`, owner = id + '-owner', other = id + '-other', shipmentId = id + '-ship', documentId = id + '-pl', now = BigInt(Date.now());
  for (const userId of [owner, other]) {
    await db().userAccount.create({ data: { id: userId, displayName: userId, status: 'active' } });
    await db().userRole.create({ data: { id: userId + '-role', userId, roleId: prefix + '-sales' } });
  }
  await db().userPermissionOverrides.createMany({ data: ['orders:read', 'customs:read', 'customs:write', 'shipments:read'].map(scope => ({ id: owner + '-' + scope,
    userId: owner, scope, isActive: true, grantedBy: owner, reason: 'Explicit private source-unit permission, not company policy' })) });
  const orders = [id + '-order-a', id + '-order-b'], ol = [id + '-ol-a', id + '-ol-b'], sl = [id + '-sl-a', id + '-sl-b'];
  for (let i = 0; i < 2; i++) {
    await db().order.create({ data: { id: orders[i], poNumber: i ? null : id + '-real-PO', customer: 'Native customer ' + i, product: 'Synthetic goods', type: 'garment',
      quantity: 10, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 0, ownerId: owner, importedAt: now, updatedAt: now } });
    await db().orderLine.create({ data: { id: ol[i], orderId: orders[i], lineNumber: 1, itemNo: i ? 'REAL-B' : 'REAL-A',
      description: 'Synthetic native original row ' + i, quantity: i ? '3.0001' : '1.2345', unit: i ? 'pcs' : 'm' } });
  }
  await db().shipment.create({ data: { id: shipmentId, shipmentNumber: id + '-SHIP', type: 'Export', status: 'Loading', shippingMethod: 'Sea',
    orderId: orders[0], totalPackages: 2, grossWeight: '60', netWeight: '50', volume: '0.5', createdAt: now, updatedAt: now } });
  for (let i = 0; i < 2; i++) await db().shipmentLine.create({ data: { id: sl[i], shipmentId, orderLineId: ol[i], lineNumber: i + 1,
    productName: 'Actual native packed goods ' + i, productCode: 'REAL-' + i, quantity: i ? '3.0001' : '1.2345', unit: i ? 'pcs' : 'm', createdAt: now, updatedAt: now } });
  const cartons = [id + '-box-A', id + '-box-Z'];
  await db().shipmentCarton.create({ data: { id: cartons[0], shipmentId, cartonNo: 'A-7', grossWeight: '3.001', volume: '0.0051', createdAt: now, updatedAt: now,
    items: { create: [{ id: id + '-item-a', shipmentLineId: sl[0], quantity: '1.0001', createdAt: now, updatedAt: now },
      { id: id + '-item-b', shipmentLineId: sl[1], quantity: '3.0001', createdAt: now, updatedAt: now }] } } });
  await db().shipmentCarton.create({ data: { id: cartons[1], shipmentId, cartonNo: 'Z-42', length: '30.02', width: '20', netWeight: '2', createdAt: now, updatedAt: now,
    items: { create: { id: id + '-item-z', shipmentLineId: sl[0], quantity: '0.2344', createdAt: now, updatedAt: now } } } });
  await db().tradeDocument.create({ data: { id: documentId, documentNumber: id + '-PL', type: 'PackingList', domain: 'customs', status: 'Draft', shipmentId,
    orderId: orders[0], issueDate: '2026-01-02', consignee: 'Native consignee', filePath: '/original-v1-must-not-change.pdf', fileName: 'old-v1.pdf', createdAt: now, updatedAt: now } });
  const legacyContent = { documentSet: { shipment: { id: shipmentId }, originalLegacyMarker: id, cartonsWereNotFrozen: true } };
  const v1 = await db().documentVersion.create({ data: { id: id + '-v1', documentId, version: 1, content: legacyContent, changedBy: owner, createdAt: now } });
  const oldAudit = await db().auditLog.create({ data: { id: id + '-legacy-audit', action: 'DOCUMENT_VERSION_CREATE', actorId: owner, targetType: 'DocumentVersion', targetId: v1.id,
    detail: { version: 1, originalLegacyMarker: id } } });
  const actor = await buildLoadedAuthTokenPayload(db(), (await loadUserWithRoles(db(), owner))!);
  const source = await readPackingListDraftSource(db(), documentId, actor);
  const input = { requestKey: randomUUID(), expectedLatestVersion: source.latest.version, expectedContentHash: source.latest.contentHash,
    expectedSourceFingerprint: source.sourceFingerprint, reason: 'Explicit native source Draft append' };
  return { id, owner, other, orders, ol, sl, cartons, shipmentId, documentId, actor, source, input, v1, oldAudit };
}
type F = Awaited<ReturnType<typeof fixture>>;
const append = (f: F, input: any = f.input, client: any = db(), actor = f.actor) => appendPackingListDraftVersion(client, { documentId: f.documentId, trustedActor: actor, input });
async function protectedFacts(f: F) {
  return documentSourceJson({ orders: await db().order.findMany({ where: { id: { in: f.orders } }, orderBy: { id: 'asc' } }),
    orderLines: await db().orderLine.findMany({ where: { id: { in: f.ol } }, orderBy: { id: 'asc' } }),
    shipment: await db().shipment.findUnique({ where: { id: f.shipmentId } }), lines: await db().shipmentLine.findMany({ where: { shipmentId: f.shipmentId }, orderBy: { id: 'asc' } }),
    cartons: await db().shipmentCarton.findMany({ where: { shipmentId: f.shipmentId }, include: { items: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    stock: await db().stockMovement.count(), invoice: await db().invoice.count(), qc: await db().inspectionReport.count() });
}
async function ledger(f: F) { return { doc: await db().tradeDocument.findUnique({ where: { id: f.documentId } }),
  versions: await db().documentVersion.findMany({ where: { documentId: f.documentId }, orderBy: { version: 'asc' } }),
  audits: await db().auditLog.findMany({ where: { OR: [{ targetId: f.documentId }, { id: { startsWith: f.id } }, { detail: { path: ['documentId'], equals: f.documentId } }] }, orderBy: { id: 'asc' } }) }; }

describe('PL v2 actual isolated native source Draft', () => {
  it('N01 appends genuine sparse multi-order boxes and exact measurements; v1/file/source financial facts remain byte identical', async () => {
    const f = await fixture('source'), before = await protectedFacts(f), made = await append(f);
    expect(made.replayed).toBe(false); expect(made.receipt.version).toBe(2); expect(made.receipt.contentHash).toBe(hash(made.version.content));
    const read = await readPackingListVersion(db(), { documentId: f.documentId, version: 2, trustedActor: f.actor });
    if (!read.envelope) throw new Error('Native PL version must have a verified envelope');
    expect(read.receipt).toEqual(made.receipt); expect(read.envelope.packingListSource.cartons.map(c => c.cartonNo)).toEqual(['A-7', 'Z-42']);
    expect(read.envelope.packingListSource.cartons[0].items.map(i => i.quantity)).toEqual(['1.0001', '3.0001']);
    expect(read.envelope.packingListSource.cartons[0].netWeight).toBeNull(); expect(read.envelope.packingListSource.summaries.header).toEqual({ packages: 2, grossWeight: '60', netWeight: '50', volume: '0.5' });
    expect(read.envelope.packingListSource.summaries.cartons.grossWeight).toBeNull(); const html = renderPackingListBody(read.envelope, { nameEn: 'Ignored later profile', addressEn: '' });
    expect(html).toContain('1.0001 m'); expect(html).toContain('3.0001 pcs'); expect(html).not.toContain('C/NO. 1-2'); expect(html).toContain('Native frozen export company');
    expect(await db().documentVersion.findUnique({ where: { id: f.v1.id } })).toEqual(f.v1); expect(await db().auditLog.findUnique({ where: { id: f.oldAudit.id } })).toEqual(f.oldAudit);
    const doc = await db().tradeDocument.findUniqueOrThrow({ where: { id: f.documentId } }); expect(doc.filePath).toBe('/original-v1-must-not-change.pdf'); expect(doc.status).toBe('Draft');
    expect(await protectedFacts(f)).toEqual(before); journal({ label: 'N01', receipt: made.receipt, version: read.version, htmlHash: hash(html), before, after: await protectedFacts(f) });
    await expect(readPackingListVersion(db(), { documentId: f.documentId, version: 1, trustedActor: f.actor })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('N02 real two-connection same-key concurrency creates one version/two audits and an exact replay', async () => {
    const f = await fixture('same-key'), second = peer(); const results = await Promise.all([append(f), append(f, f.input, second)]);
    expect(results.map(x => x.replayed).sort()).toEqual([false, true]); expect(results[0].receipt).toEqual(results[1].receipt);
    expect(await db().documentVersion.count({ where: { documentId: f.documentId } })).toBe(2);
    expect(await db().auditLog.count({ where: { transactionId: 'PL-DRAFT:' + results[0].receipt.commandId } })).toBe(2); journal({ label: 'N02', results });
  });
  it('N03 real two-key version-CAS competition admits only one append with no replaced previous version', async () => {
    const f = await fixture('cas'), second = peer(), outcomes = await Promise.allSettled([append(f), append(f, { ...f.input, requestKey: randomUUID() }, second)]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((outcomes.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    expect(await db().documentVersion.count({ where: { documentId: f.documentId } })).toBe(2); expect(await db().documentVersion.findUnique({ where: { id: f.v1.id } })).toEqual(f.v1);
  });
  it('N04 changed parameters under the old key reject, and an older exact key after a later version never overwrites latest', async () => {
    const f = await fixture('replay'), original = await append(f); await expect(append(f, { ...f.input, reason: 'Different intent' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const current = await readPackingListDraftSource(db(), f.documentId, f.actor), later = await append(f, { ...f.input, requestKey: randomUUID(), expectedLatestVersion: current.latest.version,
      expectedContentHash: current.latest.contentHash, expectedSourceFingerprint: current.sourceFingerprint }); expect(later.receipt.version).toBe(3);
    const replay = await append(f); expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(original.receipt);
    expect((await db().documentVersion.findFirstOrThrow({ where: { documentId: f.documentId }, orderBy: { version: 'desc' } })).version).toBe(3);
  });
  it('N05 changed real source before locks rejects old snapshot with zero version/header/audit writes', async () => {
    const f = await fixture('source-change'), before = await ledger(f), second = peer(); let fired = false;
    const observed = db().$extends({ query: { shipmentCarton: { async findMany({ args, query }) { const rows = await query(args);
      if (!fired && (args.where as any)?.shipmentId === f.shipmentId) { fired = true; await second.shipmentCarton.update({ where: { id: f.cartons[0] }, data: { cartonNo: 'SOURCE-CHANGED' } }); }
      return rows; } } } });
    await expect(append(f, f.input, observed)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(fired).toBe(true); expect(await ledger(f)).toEqual(before);
    const stale = await fixture('stale-input'); await db().shipmentCarton.update({ where: { id: stale.cartons[0] }, data: { cartonNo: 'CURRENT-BOX' } });
    const unchanged = await ledger(stale); await expect(append(stale)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(await ledger(stale)).toEqual(unchanged);
  });
  it('N06 actual mandatory audit failure rolls back new version and header without changing goods', async () => {
    const f = await fixture('audit-fault'), before = await ledger(f), facts = await protectedFacts(f), fault = new Error('Synthetic SQL audit write failure');
    const observed = db().$extends({ query: { auditLog: { create() { throw fault; } } } });
    await expect(append(f, f.input, observed)).rejects.toBe(fault); expect(await ledger(f)).toEqual(before); expect(await protectedFacts(f)).toEqual(facts);
  });
  it('N07 current grant withdrawal after the actual version audit prevents success and rolls back the transaction', async () => {
    const f = await fixture('late-revoke'), before = await ledger(f), second = peer(); let fired = false;
    const observed = db().$extends({ query: { auditLog: { async create({ args, query }) { const row = await query(args);
      if (!fired && args.data.action === 'DOCUMENT_VERSION_CREATE') { fired = true; await second.userPermissionOverrides.deleteMany({ where: { userId: f.owner, scope: 'customs:write' } }); }
      return row; } } } });
    let outcome: any; try { outcome = { ok: true, result: await append(f, f.input, observed) }; } catch (error: any) { outcome = { ok: false, code: error.code }; }
    const after = await ledger(f); journal({ label: 'N07', outcome, before, after });
    expect(outcome).toEqual({ ok: false, code: 'FORBIDDEN' }); expect(fired).toBe(true); expect(after).toEqual(before);
  });
  it('N08 signed empty ceiling, revoked grants, foreign parent, disabled account and forged Owner claims do not authorize writes', async () => {
    for (const mode of ['empty', 'revoke', 'foreign', 'disabled', 'forged'] as const) {
      const f = await fixture(mode), before = await ledger(f); let actor: any = f.actor;
      if (mode === 'empty') actor = { ...actor, permissionCeiling: [] };
      if (mode === 'revoke' || mode === 'forged') await db().userPermissionOverrides.deleteMany({ where: { userId: f.owner, scope: 'customs:write' } });
      if (mode === 'foreign') await db().order.update({ where: { id: f.orders[1] }, data: { ownerId: f.other } });
      if (mode === 'disabled') await db().userAccount.update({ where: { id: f.owner }, data: { status: 'disabled' } });
      if (mode === 'forged') actor = { ...actor, roles: ['owner'], roleIds: ['role-super-admin'], permissions: ['*'], authorizationLoaded: true };
      await expect(append(f, f.input, db(), actor)).rejects.toMatchObject({ code: mode === 'foreign' ? 'NOT_FOUND' : mode === 'disabled' ? 'ACCOUNT_DISABLED' : 'FORBIDDEN' });
      expect(await ledger(f)).toEqual(before);
    }
  });
  it('N09 only Draft can append and malformed/source-quantity bodies never rewrite original issued facts', async () => {
    for (const status of ['Issued', 'Submitted', 'Accepted', 'Cancelled']) { const f = await fixture(status); await db().tradeDocument.update({ where: { id: f.documentId }, data: { status } });
      const before = await ledger(f); await expect(append(f)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(await ledger(f)).toEqual(before); }
    const f = await fixture('malformed'), before = await ledger(f); await expect(append(f, { ...f.input, cartons: [{ cartonNo: 'forged' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await ledger(f)).toEqual(before);
  });
  it('N10 missing command audit and rehashed forged v2 content cannot be replayed or repaired into another version', async () => {
    const f = await fixture('orphan'), made = await append(f);
    const current = await readPackingListDraftSource(db(), f.documentId, f.actor);
    await db().auditLog.delete({ where: { id: made.receipt.auditIds[0] } });
    const before = await ledger(f);
    await expect(readPackingListDraftSource(db(), f.documentId, f.actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(append(f, { ...f.input, expectedLatestVersion: current.latest.version, expectedContentHash: current.latest.contentHash,
      expectedSourceFingerprint: current.sourceFingerprint })).rejects.toMatchObject({ code: 'CONFLICT' }); expect(await ledger(f)).toEqual(before);
    await expect(readPackingListVersion(db(), { documentId: f.documentId, version: 2, trustedActor: f.actor })).rejects.toMatchObject({ code: 'CONFLICT' });
    const f2 = await fixture('tampered'), made2 = await append(f2), content: any = made2.version.content;
    content.packingList.packingListSource.cartons[0].items[0].orderId = f2.orders[1]; content.packingList.packingListHash = hash(content.packingList.packingListSource);
    await db().documentVersion.update({ where: { id: made2.version.id }, data: { content } });
    await expect(readPackingListVersion(db(), { documentId: f2.documentId, version: 2, trustedActor: f2.actor })).rejects.toMatchObject({ code: 'CONFLICT' });
    const legacy = await fixture('legacy-number-two'), oldTwo = await db().documentVersion.create({ data: { id: legacy.id + '-old-v2', documentId: legacy.documentId, version: 2,
      content: { documentSet: { legacyNumberTwo: true } }, changedBy: legacy.owner, createdAt: BigInt(Date.now()) } });
    const latest = await readPackingListDraftSource(db(), legacy.documentId, legacy.actor); expect(latest.latest.version).toBe(2); expect(latest.latest.protocol).toBe(1);
    await expect(readPackingListVersion(db(), { documentId: legacy.documentId, version: 2, trustedActor: legacy.actor })).rejects.toMatchObject({ code: 'CONFLICT' });
    const three = await append(legacy, { ...legacy.input, expectedLatestVersion: 2, expectedContentHash: latest.latest.contentHash, expectedSourceFingerprint: latest.sourceFingerprint });
    expect(three.receipt.version).toBe(3); expect(await db().documentVersion.findUnique({ where: { id: oldTwo.id } })).toEqual(oldTwo);
  });
  it('N11 stored readonly ceiling can inspect the exact version but cannot append, and historical exporter is frozen', async () => {
    const f = await fixture('readonly'), made = await append(f), readonly = { ...f.actor, permissionCeiling: ['customs:read', 'shipments:read', 'orders:read'] };
    await db().systemConfig.update({ where: { id: EXPORTER_PROFILE_CONFIG_ID }, data: { value: { nameEn: 'New later company', addressEn: 'New address' }, version: { increment: 1 } } });
    const read = await readPackingListVersion(db(), { documentId: f.documentId, version: 2, trustedActor: readonly });
    if (!read.envelope) throw new Error('Native PL version must have a verified envelope');
    expect(read.receipt).toEqual(made.receipt); expect(read.envelope.packingListSource.exporter.nameEn).toBe('Native frozen export company');
    await expect(append(f, f.input, db(), readonly)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('N12 current source/config query fault is unknown and cannot create a version from empty/default substitutes', async () => {
    const f = await fixture('read-fault'), before = await ledger(f), fault = new Error('Synthetic unknown dependency outage');
    const observed = db().$extends({ query: { systemConfig: { findUnique() { throw fault; } } } });
    await expect(append(f, f.input, observed)).rejects.toBe(fault); expect(await ledger(f)).toEqual(before);
  });
});
