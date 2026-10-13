/** Test-first private PG only. Synthetic initial accounts/customer/case inputs;
 * actual native Sales -> QC -> Sales customer observation -> seal -> converter
 * produce every approval and native asset. No seeded approved/sealed samples.
 * GSB15–19 explicitly model initial UNKNOWN legacy asset/profile/conversion-audit
 * records, not historical producer or customer-approval proof. They never rewrite
 * the native QC/customer/seal audits; their current Sample still comes from HTTP.
 * Deliberate source/audit damage is a negative control, never company UAT. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createDevelopmentRouter } from '../src/development/route';
import { createSampleRouter } from '../src/samples/sampleRoute';

const prefix = 'acceptance-garment-source-' + randomUUID();
let prisma: PrismaClient | undefined, sequence = 0;
const db = (): any => { if (!prisma) throw Error('Private garment-source PG identity not verified'); return prisma; };
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name, BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Independent acceptance sandbox required');
  const url = new URL(DATABASE_URL); expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe('/' + name); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/); expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
});
afterAll(async () => { await prisma?.$disconnect(); });

function app(database = db()) {
  const result = express(); result.use(express.json());
  result.set('json replacer', (_key: string, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
  result.use(createAccountStatusGuard(db())); result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  result.use('/api/v1/samples', createSampleRouter({ prisma: database, requireAuth: true, apiKeys: new Set() }));
  result.use('/api/v1/development', createDevelopmentRouter({ prisma: database, requireAuth: true, apiKeys: new Set() }));
  return result;
}
async function actor(id: string, scopes: string[]) {
  // Exact current DB grants. The synthetic role name confers no authority.
  const roleId = id + '-role';
  await db().userAccount.create({ data: { id, displayName: id, status: 'active' } });
  await db().role.create({ data: { id: roleId, name: 'Synthetic exact domain grants', isSystem: false } });
  await db().userRole.create({ data: { id: id + '-assignment', userId: id, roleId } });
  for (const scope of scopes) {
    const permission = await db().permission.upsert({ where: { scope }, update: {}, create: { id: prefix + '-' + scope, scope } });
    await db().rolePermission.create({ data: { id: id + '-' + scope, roleId, permissionId: permission.id } });
  }
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(id); expect(current).not.toBeNull();
  const trusted = { userId: id, roles: current!.legacyRoleCodes, roleIds: current!.roleIds, permissions: current!.scopes, departmentIds: current!.departmentIds, authorizationLoaded: true as const };
  return { id, roleId, trusted, token: createAuthService().signToken(trusted) };
}
type Actor = Awaited<ReturnType<typeof actor>>;
async function fixture(label: string, existingSales?: Actor, initialSpecs: Partial<Record<'styleSpec' | 'sizeSpec' | 'fabricSpec' | 'processSpec', string | null>> = {}, headerFactoryKnown = true) {
  const id = `${prefix}-${++sequence}-${label}`, now = BigInt(Date.now());
  const sales = existingSales ?? await actor(id + '-sales', ['products:read', 'products:write']);
  const qc = await actor(id + '-qc', ['products:read', 'qc:garment_chain:write']);
  const customer = await db().relation.create({ data: { id: id + '-customer', name: id + '-synthetic-client', category: 'Client', type: 'Company', isOrganization: true,
    ownerId: sales.id, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
  const factory = await db().relation.create({ data: { id: id + '-factory', name: id + '-synthetic-factory', category: 'Supplier', type: 'Company', isOrganization: true,
    ownerId: sales.id, tags: [], contactInfo: '{}', lastInteraction: now } });
  const devCase = await db().developmentCase.create({ data: { id: id + '-case', code: id + '-case', name: id, type: 'garment', stage: 'developing',
    owner: sales.id, customerRelationId: customer.id, customerName: customer.name, supplierRelationId: headerFactoryKnown ? factory.id : null, supplierName: headerFactoryKnown ? factory.name : null,
    styleSpec: 'Synthetic approved garment', sizeSpec: 'S/M/L', fabricSpec: 'Synthetic test fabric', ...initialSpecs, tags: [], createdAt: now, updatedAt: now } });
  const create = await request(app()).post(`/api/v1/samples/garment/${devCase.id}/rounds`).set('Authorization', 'Bearer ' + sales.token)
    .send({ purpose: 'Synthetic source binding', version: 'V1', materialConfig: 'Synthetic native sample', supplierRelationId: factory.id, supplierName: factory.name });
  expect(create.status, json(create.body)).toBe(201); const roundId = create.body.round.id as string;
  const denied = await request(app()).post(`/api/v1/samples/garment/${roundId}/submit-qc`).set('Authorization', 'Bearer ' + sales.token).send({ result: 'passed' });
  expect(denied.status, json(denied.body)).toBe(403);
  const qcResult = await request(app()).post(`/api/v1/samples/garment/${roundId}/submit-qc`).set('Authorization', 'Bearer ' + qc.token)
    .send({ result: 'passed', qcNote: 'Synthetic software observation; no real factory or customer assertion' });
  expect(qcResult.status, json(qcResult.body)).toBe(200); expect(qcResult.body.round.qcReviewedBy).toBe(qc.id);
  const sent = await request(app()).post(`/api/v1/samples/garment/${roundId}/submit-customer`).set('Authorization', 'Bearer ' + sales.token)
    .send({ courier: 'Synthetic test courier; no external shipment', trackingNumber: id + '-test-only', recipientName: 'Synthetic customer observation', sentDate: '2099-10-01' });
  expect(sent.status, json(sent.body)).toBe(200);
  const confirmed = await request(app()).post(`/api/v1/samples/garment/${roundId}/register-customer-confirmation`).set('Authorization', 'Bearer ' + sales.token)
    .send({ result: 'approved', confirmationDate: '2099-10-01', channel: 'Synthetic software-only customer observation', note: 'No actual customer approval claimed' });
  expect(confirmed.status, json(confirmed.body)).toBe(200); expect(confirmed.body.round.status).toBe('confirmed');
  return { id, sales, qc, customer, factory, caseId: devCase.id, roundId, sampleId: '', assetId: '' };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function seal(f: Fixture) {
  const result = await request(app()).post(`/api/v1/samples/garment/${f.roundId}/seal`).set('Authorization', 'Bearer ' + f.sales.token)
    .send({ retainLocation: 'Synthetic acceptance sample shelf' });
  expect(result.status, json(result.body)).toBe(200); expect(result.body.round.status).toBe('sealed');
  const samples = await db().sample.findMany({ where: { sourceCaseId: f.caseId, type: 'pp', deletedAt: null } }); expect(samples).toHaveLength(1);
  f.sampleId = samples[0].id; return f;
}
async function convert(f: Fixture, extra: Record<string, unknown> = {}) {
  const result = await request(app()).post(`/api/v1/development/${f.caseId}/convert-to-asset`).set('Authorization', 'Bearer ' + f.sales.token)
    .send({ sourceType: 'seal', sourceId: f.roundId, ...extra });
  expect(result.status, json(result.body)).toBe(200); f.assetId = result.body.asset.id; return result;
}
async function originalAsset(f: Fixture) {
  await seal(f); await convert(f);
  // Native generic Sample editing can correct a missing asset projection without
  // altering approval. Exercise that real seam rather than seed an approved row.
  const edited = await request(app()).patch(`/api/v1/samples/${f.sampleId}`).set('Authorization', 'Bearer ' + f.sales.token).send({ productAssetId: null });
  expect(edited.status, json(edited.body)).toBe(200); expect(edited.body.sample.productAssetId).toBeNull(); return f;
}
async function command(f: Fixture, patch: Record<string, unknown> = {}) {
  const [round, sample, asset] = await Promise.all([
    db().sampleBatch.findUniqueOrThrow({ where: { id: f.roundId } }), db().sample.findUniqueOrThrow({ where: { id: f.sampleId } }), db().productAsset.findUniqueOrThrow({ where: { id: f.assetId } }),
  ]);
  return { sourceRoundId: f.roundId, targetSampleId: f.sampleId, existingAssetId: f.assetId, expectedRoundUpdatedAt: String(round.updatedAt),
    expectedSampleUpdatedAt: String(sample.updatedAt), expectedAssetUpdatedAt: String(asset.updatedAt), requestKey: randomUUID(), ...patch };
}
async function link(f: Fixture, body: Record<string, unknown>, token = f.sales.token, database = db()) {
  return request(app(database)).post(`/api/v1/development/${f.caseId}/garment-source-links`).set('Authorization', 'Bearer ' + token).send(body);
}
async function snapshot(f: Fixture) {
  return {
    sample: await db().sample.findUniqueOrThrow({ where: { id: f.sampleId } }), round: await db().sampleBatch.findUniqueOrThrow({ where: { id: f.roundId } }),
    asset: await db().productAsset.findUniqueOrThrow({ where: { id: f.assetId } }), case: await db().developmentCase.findUniqueOrThrow({ where: { id: f.caseId } }),
    assets: await db().productAsset.count(), audits: await db().auditLog.findMany({ where: { OR: [{ targetId: { in: [f.caseId, f.sampleId, f.assetId, f.roundId] } }, { actorId: { in: [f.sales.id, f.qc.id] } }] }, orderBy: { id: 'asc' } }),
  };
}
function approvalFacts(sample: any) {
  return { status: sample.status, round: sample.round, approvedAt: sample.approvedAt, approvedBy: sample.approvedBy, qcStatus: sample.qcStatus,
    qcInspectionReportId: sample.qcInspectionReportId, customerStatus: sample.customerStatus, sourceCaseId: sample.sourceCaseId,
    sourceOrderId: sample.sourceOrderId, supplierRelationId: sample.supplierRelationId, customerRelationId: sample.customerRelationId, attachments: sample.attachments, notes: sample.notes };
}

/** Initial unknown historical storage input, NOT a call to or proof of the old
 * converter. Current round/QC/customer/seal/PP approvals above remain native.
 * The missing snapshots are explicit at INSERT; no produced audit is altered. */
async function legacyAsset(label: string, profilePatch: Record<string, unknown> = {},
  initialSpecs: Partial<Record<'styleSpec' | 'sizeSpec' | 'fabricSpec' | 'processSpec', string | null>> = {}, profileState: 'present' | 'missing' | 'deleted' = 'present', headerFactoryKnown = true) {
  const f = await seal(await fixture(label, undefined, { processSpec: 'Synthetic exact construction', ...initialSpecs }, headerFactoryKnown));
  const development = await db().developmentCase.findUniqueOrThrow({ where: { id: f.caseId } }), now = BigInt(Date.now());
  f.assetId = f.id + '-initial-legacy-asset';
  await db().productAsset.create({ data: { id: f.assetId, sku: f.id + '-legacy-sku', name: 'Synthetic initial legacy asset; history unknown',
    mainCategory: 'Garment', subCategoryId: '', season: '', status: 'Development', source: 'development', sourceDetail: f.caseId, updatedAt: now } });
  if (profileState !== 'missing') await db().garmentProfile.create({ data: { id: f.id + '-initial-legacy-profile', productAssetId: f.assetId,
    styleNo: development.styleSpec, mainFabric: development.fabricSpec, sizeSpec: development.sizeSpec, constructionNote: development.processSpec,
    customerRelationId: development.customerRelationId, factoryRelationId: headerFactoryKnown ? development.supplierRelationId : f.factory.id, updatedAt: now,
    deletedAt: profileState === 'deleted' ? now : null, ...profilePatch } });
  await db().auditLog.create({ data: { id: f.id + '-initial-legacy-conversion-audit', actorId: f.sales.id,
    action: 'convert_garment_to_asset', targetType: 'ProductAsset', targetId: f.assetId,
    detail: { source: 'route:dev:garment-convert-asset',
      after: { fromCase: f.caseId, sourceType: 'seal', sourceId: f.roundId, sku: f.id + '-legacy-sku', mainCategory: 'Garment' },
      fixtureBoundary: 'synthetic_initial_unknown_legacy_history_not_native_conversion_proof' } } });
  return f;
}
async function legacySnapshot(f: Fixture) {
  return { ...await snapshot(f), profiles: await db().garmentProfile.findMany({ where: { productAssetId: f.assetId }, orderBy: { id: 'asc' } }) };
}
/** A separate real PG transaction owns the actual Profile row lock and stages
 * changed contents. It intentionally rolls back after the HTTP observation;
 * native approval/audit/history is never rewritten for the concurrency fixture. */
async function withProfileWriteLock(f: Fixture, observe: () => Promise<void>) {
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const rollback = new Error('Synthetic Profile concurrency transaction rollback');
  const holder = db().$transaction(async (tx: any) => {
    const rows = await tx.$queryRawUnsafe('SELECT "id" FROM "GarmentProfile" WHERE "productAssetId"=$1 FOR UPDATE', f.assetId);
    expect(rows).toHaveLength(1);
    await tx.garmentProfile.update({ where: { productAssetId: f.assetId }, data: { mainFabric: 'Synthetic concurrently changed fabric' } });
    expect((await tx.garmentProfile.findUniqueOrThrow({ where: { productAssetId: f.assetId } })).mainFabric).toBe('Synthetic concurrently changed fabric');
    entered(); await released; throw rollback;
  }, { timeout: 15000 }).catch((error: unknown) => { if (error !== rollback) throw error; });
  try {
    await Promise.race([held, holder.then(() => { throw new Error('Profile lock holder ended before the HTTP observation'); })]);
    await observe();
  } finally { release(); await holder; }
}

describe.sequential('native garment exact source binding and original-asset continuation, private PG', () => {
  it('GSB01 real seal and Sample sync audits bind both actual IDs without replacing native QC/customer history', async () => {
    const f = await seal(await fixture('double-ids'));
    const sample = await db().sample.findUniqueOrThrow({ where: { id: f.sampleId } });
    expect(sample).toMatchObject({ type: 'pp', sourceCaseId: f.caseId, status: 'approved', productAssetId: null, approvedBy: f.sales.id });
    const native = await db().sampleBatch.findUniqueOrThrow({ where: { id: f.roundId } });
    expect(native).toMatchObject({ status: 'approved', qcStatus: 'passed', customerStatus: 'approved', qcReviewedBy: f.qc.id });
    const sealAudit = await db().auditLog.findFirstOrThrow({ where: { action: 'seal_garment_preproduction_sample', targetId: f.caseId } });
    const sampleAudit = await db().auditLog.findFirstOrThrow({ where: { action: 'sync_pp_sample_create', targetId: f.sampleId } });
    expect(sealAudit.detail).toMatchObject({ source: 'route:samples:garment-gate', after: { roundId: f.roundId, sourceRoundId: f.roundId, sampleId: f.sampleId } });
    expect(sampleAudit.detail).toMatchObject({ source: 'route:samples:garment-gate', after: { sourceCaseId: f.caseId, sourceRoundId: f.roundId, sampleId: f.sampleId } });
  });
  it('GSB02 unique native sealed source links its actual independent Sample during the same asset conversion', async () => {
    const f = await seal(await fixture('native-convert')), before = await db().sample.findUniqueOrThrow({ where: { id: f.sampleId } });
    const round = await db().sampleBatch.findUniqueOrThrow({ where: { id: f.roundId } }); await convert(f);
    const after = await db().sample.findUniqueOrThrow({ where: { id: f.sampleId } });
    expect(after.productAssetId).toBe(f.assetId); expect(approvalFacts(after)).toEqual(approvalFacts(before));
    expect(await db().sampleBatch.findUniqueOrThrow({ where: { id: f.roundId } })).toEqual(round);
    const audit = await db().auditLog.findFirstOrThrow({ where: { action: 'convert_garment_to_asset', targetId: f.assetId } });
    expect(audit.detail).toMatchObject({ source: 'route:dev:garment-convert-asset', after: { fromCase: f.caseId, sourceType: 'seal', sourceId: f.roundId, sourceRoundId: f.roundId, sampleId: f.sampleId } });
  });
  it('GSB03 native garment QC/customer confirmation can convert the selected actual round without fabric approval tags', async () => {
    const f = await fixture('native-confirmation');
    const before = await db().sampleBatch.findUniqueOrThrow({ where: { id: f.roundId } }); expect(before.confirmStatus).not.toBe('confirmed');
    const result = await request(app()).post(`/api/v1/development/${f.caseId}/convert-to-asset`).set('Authorization', 'Bearer ' + f.sales.token)
      .send({ sourceType: 'node', sourceId: 'confirmation', sourceRoundId: f.roundId });
    expect(result.status, json(result.body)).toBe(200); expect(result.body.asset.id).toBeTruthy();
    expect(await db().sampleBatch.findUniqueOrThrow({ where: { id: f.roundId } })).toEqual(before);
    expect(await db().sample.count({ where: { sourceCaseId: f.caseId } })).toBe(0); // No manufactured PP approval.
    const audit = await db().auditLog.findFirstOrThrow({ where: { action: 'convert_garment_to_asset', targetId: result.body.asset.id } });
    expect(audit.detail).toMatchObject({ after: { fromCase: f.caseId, sourceType: 'node', sourceRoundId: f.roundId } });
  });
  it('GSB04 original asset continuation creates only the real Sample link and mandatory audit, never another asset or approval', async () => {
    const f = await originalAsset(await fixture('original-asset')), body = await command(f), before = await snapshot(f);
    const result = await link(f, body); expect(result.status, json(result.body)).toBe(200);
    expect(result.body.sourceBinding).toMatchObject({ sourceRoundId: f.roundId, sampleId: f.sampleId, assetId: f.assetId, historicalApprovalRestored: false });
    const after = await snapshot(f); expect(after.assets).toBe(before.assets); expect(after.asset).toEqual(before.asset); expect(after.round).toEqual(before.round); expect(after.case).toEqual(before.case);
    expect(after.sample.productAssetId).toBe(f.assetId); expect(approvalFacts(after.sample)).toEqual(approvalFacts(before.sample));
    for (const prior of before.audits) expect(after.audits.find((row: any) => row.id === prior.id)).toEqual(prior);
    const audit = await db().auditLog.findUniqueOrThrow({ where: { id: result.body.sourceBinding.auditId } });
    expect(audit).toMatchObject({ actorId: f.sales.id, action: 'link_garment_sample_asset', targetType: 'Sample', targetId: f.sampleId });
    expect(audit.detail).toMatchObject({ source: 'route:dev:garment-source-link', after: { sourceRoundId: f.roundId, sampleId: f.sampleId, assetId: f.assetId, requestKey: body.requestKey } });
  });
  it('GSB05 exact original payload/key replays its immutable receipt; parameter changes conflict without a second link audit', async () => {
    const f = await originalAsset(await fixture('replay')), body = await command(f);
    const first = await link(f, body); expect(first.status, json(first.body)).toBe(200); const before = await snapshot(f);
    const replay = await link(f, body); expect(replay.status, json(replay.body)).toBe(200); expect(replay.body.sourceBinding).toEqual(first.body.sourceBinding);
    expect(await snapshot(f)).toEqual(before);
    const conflict = await link(f, { ...body, expectedSampleUpdatedAt: String(BigInt(String(body.expectedSampleUpdatedAt)) + 1n) });
    expect(conflict.status, json(conflict.body)).toBe(409); expect(await snapshot(f)).toEqual(before);
  });
  it('GSB06 stale source versions refuse without altering the original asset, Sample, round or approval/audit history', async () => {
    const f = await originalAsset(await fixture('stale')), body = await command(f), before = await snapshot(f);
    const result = await link(f, { ...body, expectedRoundUpdatedAt: String(BigInt(String(body.expectedRoundUpdatedAt)) - 1n) });
    expect(result.status, json(result.body)).toBe(409); expect(await snapshot(f)).toEqual(before);
  });
  it('GSB07 foreign actual Sample cannot replace the same-case target even when the operator owns both native cases', async () => {
    const f = await originalAsset(await fixture('foreign-target')), other = await originalAsset(await fixture('foreign-case', f.sales));
    const body = await command(f), before = await snapshot(f), otherBefore = await snapshot(other);
    const result = await link(f, { ...body, targetSampleId: other.sampleId }); expect(result.status, json(result.body)).toBe(404);
    expect(await snapshot(f)).toEqual(before); expect(await snapshot(other)).toEqual(otherBefore);
  });
  it('GSB08 damaged original conversion audit cannot be replaced by case pointers or notes', async () => {
    const f = await originalAsset(await fixture('damaged-origin'));
    const audit = await db().auditLog.findFirstOrThrow({ where: { action: 'convert_garment_to_asset', targetId: f.assetId } });
    await db().auditLog.update({ where: { id: audit.id }, data: { detail: { ...(audit.detail as any), after: { ...(audit.detail as any).after, fromCase: 'damaged-foreign-case' } } } });
    const body = await command(f), before = await snapshot(f); const result = await link(f, body);
    expect(result.status, json(result.body)).toBe(409); expect(await snapshot(f)).toEqual(before);
  });
  it('GSB09 actual mandatory audit P2003 rolls back the staged Sample link; the same command can then legally retry', async () => {
    const f = await originalAsset(await fixture('audit-rollback')), body = await command(f), before = await snapshot(f);
    let injected = false, actualCode = '';
    const broken = new Proxy(db(), { get(target, key) {
      if (key === '$transaction') return (callback: any, opts: any) => target.$transaction(async (tx: any) => callback(new Proxy(tx, { get(inner, member) {
        if (member === 'auditLog') return new Proxy(inner.auditLog, { get(delegate, method) {
          if (method === 'create') return async (args: any) => {
            if (args.data.action !== 'link_garment_sample_asset') return delegate.create(args);
            injected = true; const staged = await tx.sample.findUniqueOrThrow({ where: { id: f.sampleId } }); expect(staged.productAssetId).toBe(f.assetId);
            try { return await delegate.create({ ...args, data: { ...args.data, actorId: prefix + '-actual-missing-actor' } }); }
            catch (error: any) { actualCode = error.code; throw error; }
          };
          const value = delegate[method]; return typeof value === 'function' ? value.bind(delegate) : value;
        } });
        const value = inner[member]; return typeof value === 'function' ? value.bind(inner) : value;
      } })), opts);
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = await link(f, body, f.sales.token, broken); expect(result.status, json(result.body)).toBe(500); expect(injected).toBe(true); expect(actualCode).toBe('P2003');
    expect(await snapshot(f)).toEqual(before);
    const retry = await link(f, body); expect(retry.status, json(retry.body)).toBe(200); expect((await snapshot(f)).sample.productAssetId).toBe(f.assetId);
  });
  it.each(['signed-empty', 'actual-revoked', 'disabled', 'foreign-actor'])('GSB10 %s has no permission to bind or claim the parent source', async mode => {
    const f = await originalAsset(await fixture(mode)), body = await command(f), before = await snapshot(f); let token = f.sales.token, expected = 403;
    if (mode === 'signed-empty') token = createAuthService().signToken({ ...f.sales.trusted, permissionCeiling: [] });
    if (mode === 'actual-revoked') { const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'products:write' } }); await db().rolePermission.deleteMany({ where: { roleId: f.sales.roleId, permissionId: permission.id } }); }
    if (mode === 'disabled') { await db().userAccount.update({ where: { id: f.sales.id }, data: { status: 'disabled' } }); expected = 401; }
    if (mode === 'foreign-actor') { token = (await actor(f.id + '-outsider', ['products:read', 'products:write'])).token; expected = 404; }
    const result = await link(f, body, token); expect(result.status, json(result.body)).toBe(expected); expect(await snapshot(f)).toEqual(before);
  });
  it('GSB11 multiple actual PP physical records cannot be randomly overwritten by sealing; all native facts remain unchanged', async () => {
    const f = await fixture('ambiguous-physical-samples');
    for (let n = 0; n < 2; n++) {
      const created = await request(app()).post('/api/v1/samples').set('Authorization','Bearer ' + f.sales.token)
        .send({ type:'pp',sourceCaseId:f.caseId,supplierRelationId:f.factory.id,customerRelationId:f.customer.id,notes:`Synthetic physical input ${n + 1}; no approval asserted` });
      expect(created.status,json(created.body)).toBe(201); expect(created.body.sample.status).toBe('draft');
    }
    const truth = async () => ({
      case: await db().developmentCase.findUniqueOrThrow({where:{id:f.caseId}}), round: await db().sampleBatch.findUniqueOrThrow({where:{id:f.roundId}}),
      samples: await db().sample.findMany({where:{sourceCaseId:f.caseId},orderBy:{id:'asc'}}),
      audits: await db().auditLog.findMany({where:{actorId:{in:[f.sales.id,f.qc.id]}},orderBy:{id:'asc'}}),
    });
    const before = await truth(); expect(before.samples).toHaveLength(2);
    const result = await request(app()).post(`/api/v1/samples/garment/${f.roundId}/seal`).set('Authorization','Bearer ' + f.sales.token).send({retainLocation:'Synthetic ambiguous shelf'});
    expect(result.status,json(result.body)).toBe(409); expect(result.body.error.code).toBe('CONFLICT'); expect(await truth()).toEqual(before);
  });
  it('GSB12 real garment cases and the real fabric batch producer consume one global SB pool without collisions', async () => {
    const f = await fixture('number-pool'), other = await fixture('number-pool-other',f.sales), now = BigInt(Date.now());
    const fabricId = f.id + '-fabric-case';
    await db().developmentCase.create({data:{id:fabricId,code:fabricId,name:'Synthetic initial fabric case',type:'fabric',stage:'developing',owner:f.sales.id,
      customerRelationId:f.customer.id,supplierRelationId:f.factory.id,tags:[],createdAt:now,updatedAt:now}});
    const fabric = await request(app()).post(`/api/v1/development/${fabricId}/batches`).set('Authorization','Bearer ' + f.sales.token)
      .send({sampleType:'handloom',supplierRelationId:f.factory.id,supplierName:f.factory.name});
    expect(fabric.status,json(fabric.body)).toBe(201);
    const rows = await db().sampleBatch.findMany({where:{id:{in:[f.roundId,other.roundId,fabric.body.batch.id]}}});
    expect(rows).toHaveLength(3); expect(new Set(rows.map((r:any)=>r.batchCode)).size).toBe(3);
    for (const row of rows) expect(row.batchCode).toMatch(/^SB-\d{4}-\d{4,}$/);
    const seq = await db().businessSequence.findUniqueOrThrow({where:{id:`SEQ_SB_${new Date().getFullYear()}`}});
    expect(seq.prefix).toBe('SB'); expect(seq.seq).toBeGreaterThanOrEqual(Math.max(...rows.map((r:any)=>Number(r.batchCode.split('-')[2]))));
  });
  it('GSB13 a soft-deleted native round keeps its number and a deliberately stale sequence catches up without reusing it', async () => {
    const f = await fixture('occupied-soft-deleted'), year = new Date().getFullYear();
    const original = await db().sampleBatch.findUniqueOrThrow({where:{id:f.roundId}});
    const removed = await request(app()).delete(`/api/v1/development/batches/${f.roundId}`).set('Authorization','Bearer ' + f.sales.token);
    expect(removed.status,json(removed.body)).toBe(200);
    const retired = await db().sampleBatch.findUniqueOrThrow({where:{id:f.roundId}}); expect(retired.deletedAt).not.toBeNull(); expect(retired.batchCode).toBe(original.batchCode);
    // Deliberate private sequence damage, not a hand-seeded business/approval fact.
    await db().businessSequence.update({where:{id:`SEQ_SB_${year}`},data:{seq:Number(original.batchCode.split('-')[2])-1}});
    const created = await request(app()).post(`/api/v1/samples/garment/${f.caseId}/rounds`).set('Authorization','Bearer ' + f.sales.token)
      .send({purpose:'Synthetic next sample',version:'V2',materialConfig:'Synthetic changed physical input',supplierRelationId:f.factory.id});
    expect(created.status,json(created.body)).toBe(201);
    const next = await db().sampleBatch.findUniqueOrThrow({where:{id:created.body.round.id}});
    expect(next.batchCode).not.toBe(original.batchCode); expect(Number(next.batchCode.split('-')[2])).toBeGreaterThan(Number(original.batchCode.split('-')[2]));
    expect(await db().sampleBatch.findUniqueOrThrow({where:{id:f.roundId}})).toEqual(retired);
  });
  it('GSB14 native confirmed-round conversion followed by sealing preserves that exact existing asset and never creates a replacement', async () => {
    const f = await fixture('exact-asset-before-seal');
    const converted = await request(app()).post(`/api/v1/development/${f.caseId}/convert-to-asset`).set('Authorization','Bearer ' + f.sales.token)
      .send({sourceType:'node',sourceId:'confirmation',sourceRoundId:f.roundId});
    expect(converted.status,json(converted.body)).toBe(200); f.assetId=converted.body.asset.id;
    const before = await db().productAsset.findUniqueOrThrow({where:{id:f.assetId}}), assetCount = await db().productAsset.count();
    await seal(f); const sample = await db().sample.findUniqueOrThrow({where:{id:f.sampleId}});
    expect(sample.productAssetId).toBe(f.assetId); expect(sample.approvedBy).toBe(f.sales.id);
    expect(await db().productAsset.count()).toBe(assetCount); expect(await db().productAsset.findUniqueOrThrow({where:{id:f.assetId}})).toEqual(before);
  });
  it.each(['styleNo', 'mainFabric', 'sizeSpec', 'constructionNote', 'customerRelationId', 'factoryRelationId'] as const)(
    'GSB15 initial unknown legacy history with mismatched actual Profile %s refuses all writes', async field => {
      const f = await legacyAsset('legacy-mismatch-' + field, { [field]: 'Synthetic foreign ' + field }), body = await command(f), before = await legacySnapshot(f);
      const result = await link(f, body); expect(result.status, json(result.body)).toBe(409); expect(result.body.error.code).toBe('CONFLICT');
      expect(await legacySnapshot(f)).toEqual(before); expect(before.sample.productAssetId).toBeNull();
    });
  it.each(['styleNo', 'mainFabric', 'sizeSpec', 'constructionNote', 'customerRelationId', 'factoryRelationId'] as const)(
    'GSB16 initial unknown legacy history with missing actual Profile %s cannot pretend equal to the current source', async field => {
      const f = await legacyAsset('legacy-missing-' + field, { [field]: null }), body = await command(f), before = await legacySnapshot(f);
      const result = await link(f, body); expect(result.status, json(result.body)).toBe(409); expect(result.body.error.code).toBe('CONFLICT');
      expect(await legacySnapshot(f)).toEqual(before);
    });
  it.each(['missing', 'deleted'] as const)('GSB17 initial unknown legacy history with %s actual Profile refuses without changing approval or history', async state => {
    const f = await legacyAsset('legacy-profile-' + state, {}, {}, state), body = await command(f), before = await legacySnapshot(f);
    const result = await link(f, body); expect(result.status, json(result.body)).toBe(409); expect(result.body.error.code).toBe('CONFLICT');
    expect(await legacySnapshot(f)).toEqual(before);
  });
  it('GSB18 complete matching current Profile permits only explicit current_link_recorded, never restoration of the unknown historical approval', async () => {
    const f = await legacyAsset('legacy-current-complete'), body = await command(f), before = await legacySnapshot(f);
    const origin = before.audits.find((row: any) => row.action === 'convert_garment_to_asset');
    expect(origin.detail.after).not.toHaveProperty('caseContent'); expect(origin.detail.after).not.toHaveProperty('roundContent');
    expect(origin.detail.after).not.toHaveProperty('sourceRoundId');
    const result = await link(f, body); expect(result.status, json(result.body)).toBe(200);
    expect(result.body.sourceBinding).toMatchObject({ sourceRoundId: f.roundId, sampleId: f.sampleId, assetId: f.assetId,
      provenance: 'current_link_recorded', historicalApprovalRestored: false });
    const after = await legacySnapshot(f); expect(after.sample.productAssetId).toBe(f.assetId);
    expect(approvalFacts(after.sample)).toEqual(approvalFacts(before.sample)); expect(after.assets).toBe(before.assets);
    for (const field of ['asset', 'profiles', 'case', 'round'] as const) expect(after[field]).toEqual(before[field]);
    for (const prior of before.audits) expect(after.audits.find((row: any) => row.id === prior.id)).toEqual(prior);
    const actual = await db().auditLog.findUniqueOrThrow({ where: { id: result.body.sourceBinding.auditId } });
    expect(actual).toMatchObject({ actorId: f.sales.id, action: 'link_garment_sample_asset', targetId: f.sampleId });
    expect(actual.detail.after).toMatchObject({ provenance: 'current_link_recorded', historicalApprovalRestored: false });
  });
  it.each([['styleSpec', 'styleNo'], ['fabricSpec', 'mainFabric'], ['sizeSpec', 'sizeSpec'], ['processSpec', 'constructionNote']] as const)(
    'GSB19 unknown current Case %s and missing Profile %s are not two matching approved facts', async (caseField, profileField) => {
      const f = await legacyAsset('legacy-both-missing-' + caseField, { [profileField]: null }, { [caseField]: null }), body = await command(f), before = await legacySnapshot(f);
      expect((before.case as any)[caseField]).toBeNull(); expect(before.profiles[0][profileField]).toBeNull();
      const result = await link(f, body); expect(result.status, json(result.body)).toBe(409); expect(result.body.error.code).toBe('CONFLICT');
      expect(await legacySnapshot(f)).toEqual(before);
    });
  it('GSB20 an actual concurrent Profile writer prevents accepting an old matching snapshot; rollback permits the same original request', async () => {
    const f = await legacyAsset('legacy-profile-concurrent-write'), body = await command(f), before = await legacySnapshot(f);
    await withProfileWriteLock(f, async () => {
      // A timeout is a test failure, never a substitute for the controlled 409.
      const result = await request(app()).post(`/api/v1/development/${f.caseId}/garment-source-links`)
        .set('Authorization', 'Bearer ' + f.sales.token).send(body).timeout({ deadline: 5000 });
      expect(result.status, json(result.body)).toBe(409); expect(result.body.error.code).toBe('CONFLICT');
      expect(await legacySnapshot(f)).toEqual(before);
    });
    expect(await legacySnapshot(f)).toEqual(before);
    const retry = await link(f, body); expect(retry.status, json(retry.body)).toBe(200);
    expect(retry.body.sourceBinding).toMatchObject({ command: body, sampleId: f.sampleId, assetId: f.assetId,
      provenance: 'current_link_recorded', historicalApprovalRestored: false });
    const after = await legacySnapshot(f); expect(after.sample.productAssetId).toBe(f.assetId);
    expect(approvalFacts(after.sample)).toEqual(approvalFacts(before.sample));
    for (const field of ['asset', 'profiles', 'case', 'round'] as const) expect(after[field]).toEqual(before[field]);
    for (const prior of before.audits) expect(after.audits.find((row: any) => row.id === prior.id)).toEqual(prior);
    expect(after.audits.filter((row: any) => row.action === 'link_garment_sample_asset')).toHaveLength(1);
  });
  it('GSB21 Profile write locks do not block a read-only candidate view or reinterpret an already applied immutable request receipt', async () => {
    const f = await legacyAsset('legacy-profile-read-replay-control'), body = await command(f);
    const first = await link(f, body); expect(first.status, json(first.body)).toBe(200); const before = await legacySnapshot(f);
    await withProfileWriteLock(f, async () => {
      const preview = await request(app()).get(`/api/v1/development/${f.caseId}/garment-source-links`)
        .set('Authorization', 'Bearer ' + f.sales.token).timeout({ deadline: 5000 });
      expect(preview.status, json(preview.body)).toBe(200);
      expect(preview.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ sourceRoundId: f.roundId, sampleId: f.sampleId, assetId: f.assetId })]));
      const replay = await request(app()).post(`/api/v1/development/${f.caseId}/garment-source-links`)
        .set('Authorization', 'Bearer ' + f.sales.token).send(body).timeout({ deadline: 5000 });
      expect(replay.status, json(replay.body)).toBe(200); expect(replay.body.sourceBinding).toEqual(first.body.sourceBinding);
      expect(await legacySnapshot(f)).toEqual(before);
    });
    expect(await legacySnapshot(f)).toEqual(before);
  });
  // Controlled projection loss AFTER actual native QC/customer/seal writes, not
  // proof that these new fixture rows were produced by a historical writer.
  // legacyAsset's asset/profile/conversion record is explicit INITIAL unknown
  // history; its current round and physical Sample approval/audits are native.
  it('GSB22 a deliberately lost nullable customer projection permits only the exact current link when native approval audits remain intact', async () => {
    const f = await legacyAsset('controlled-customer-projection-loss');
    const native = await legacySnapshot(f);
    expect(native.round.customerStatus).toBe('approved');
    const confirmation = (native.round.attachments as any).confirmation;
    expect(native.audits.filter((row: any) => row.action === 'confirm_garment_sample'
      && row.actorId === confirmation.registeredBy && row.detail?.source === 'route:samples:garment-gate'
      && row.detail.after?.roundId === f.roundId && row.detail.after.customerStatus === 'approved')).toHaveLength(1);
    await db().sampleBatch.update({ where: { id: f.roundId }, data: { customerStatus: null } });
    const body = await command(f), before = await legacySnapshot(f);
    expect(before.audits).toEqual(native.audits); expect(before.round.customerStatus).toBeNull();
    const result = await link(f, body); expect(result.status, json(result.body)).toBe(200);
    expect(result.body.sourceBinding).toMatchObject({ sourceRoundId: f.roundId, sampleId: f.sampleId, assetId: f.assetId,
      provenance: 'current_link_recorded', historicalApprovalRestored: false });
    const after = await legacySnapshot(f); expect(after.sample.productAssetId).toBe(f.assetId);
    expect(approvalFacts(after.sample)).toEqual(approvalFacts(before.sample)); expect(after.round.customerStatus).toBeNull();
    for (const field of ['asset', 'profiles', 'case', 'round', 'assets'] as const) expect(after[field]).toEqual(before[field]);
    for (const prior of before.audits) expect(after.audits.find((row: any) => row.id === prior.id)).toEqual(prior);
    expect(after.audits.filter((row: any) => row.action === 'link_garment_sample_asset')).toHaveLength(1);
  });
  it('GSB23 an explicit rejected customer projection cannot fall back to an older approved attachment or audit', async () => {
    const f = await legacyAsset('controlled-customer-rejected');
    await db().sampleBatch.update({ where: { id: f.roundId }, data: { customerStatus: 'rejected' } });
    const body = await command(f), before = await legacySnapshot(f);
    expect((before.round.attachments as any).confirmation.result).toBe('approved');
    const result = await link(f, body); expect(result.status, json(result.body)).toBe(409); expect(result.body.error.code).toBe('CONFLICT');
    expect(await legacySnapshot(f)).toEqual(before);
  });
  it('GSB24 null customer projection without its actual approval audit cannot establish an approved source', async () => {
    const f = await legacyAsset('controlled-customer-audit-loss');
    const native = await legacySnapshot(f);
    const customer = native.audits.filter((row: any) => row.action === 'confirm_garment_sample'
      && row.detail?.source === 'route:samples:garment-gate' && row.detail.after?.roundId === f.roundId);
    expect(customer).toHaveLength(1);
    // Deliberate missing-fact NEGATIVE input, never a reconstruction of old history.
    await db().auditLog.delete({ where: { id: customer[0].id } });
    await db().sampleBatch.update({ where: { id: f.roundId }, data: { customerStatus: null } });
    const body = await command(f), before = await legacySnapshot(f);
    const result = await link(f, body); expect(result.status, json(result.body)).toBe(409); expect(result.body.error.code).toBe('CONFLICT');
    expect(await legacySnapshot(f)).toEqual(before);
  });
  it('GSB25 null customer projection does not excuse current content drift from actual native approval snapshots', async () => {
    const f = await legacyAsset('controlled-customer-null-content-drift'), native = await legacySnapshot(f);
    const customer = native.audits.find((row: any) => row.action === 'confirm_garment_sample' && row.detail?.after?.roundId === f.roundId);
    expect(customer?.detail?.after?.roundContent).toBeTruthy();
    await db().sampleBatch.update({ where: { id: f.roundId }, data: { customerStatus: null,
      attachments: { ...(native.round.attachments as any), materialConfig: 'Synthetic deliberately changed physical content' } } });
    const body = await command(f), before = await legacySnapshot(f); expect(before.audits).toEqual(native.audits);
    const result = await link(f, body); expect(result.status, json(result.body)).toBe(409); expect(result.body.error.code).toBe('CONFLICT');
    expect(await legacySnapshot(f)).toEqual(before);
  });
});


// INITIAL header supplier may legitimately be unknown while the actual selected
// round and its native PP sample identify the real factory. No approved/history
// row is edited to manufacture this condition.
describe.sequential('native selected garment factory independent from optional case header', () => {
  it('GSB26 native conversion preserves the actual selected round factory when case header supplier is initially unknown', async () => {
    const f = await seal(await fixture('selected-round-factory', undefined, { processSpec: 'Synthetic actual construction' }, false));
    const before = await db().developmentCase.findUniqueOrThrow({ where: { id: f.caseId } });
    expect(before.supplierRelationId).toBeNull();
    await convert(f);
    const profile = await db().garmentProfile.findUniqueOrThrow({ where: { productAssetId: f.assetId } });
    expect(profile.factoryRelationId).toBe(f.factory.id);
    expect(profile.factory).toBe(f.factory.name);
    expect((await db().developmentCase.findUniqueOrThrow({ where: { id: f.caseId } })).supplierRelationId).toBeNull();
    const nativeSample = await db().sample.findUniqueOrThrow({ where: { id: f.sampleId } });
    expect(nativeSample.supplierRelationId).toBe(f.factory.id);
    expect(nativeSample.productAssetId).toBe(f.assetId);
  });
  it('GSB27 complete current legacy profile matches the actual selected round factory without inventing a case header supplier or historical approval', async () => {
    const f = await legacyAsset('known-round-unknown-header', {}, {}, 'present', false);
    const before = await legacySnapshot(f);
    expect(before.case.supplierRelationId).toBeNull();
    expect(before.profiles[0].factoryRelationId).toBe(f.factory.id);
    const result = await link(f, await command(f));
    expect(result.status, json(result.body)).toBe(200);
    expect(result.body.sourceBinding.provenance).toBe('current_link_recorded');
    expect(result.body.sourceBinding.historicalApprovalRestored).toBe(false);
    const after = await legacySnapshot(f);
    expect(after.case).toEqual(before.case);
    expect(after.round).toEqual(before.round);
    expect(after.asset).toEqual(before.asset);
    expect(after.profiles).toEqual(before.profiles);
    expect(approvalFacts(after.sample)).toEqual(approvalFacts(before.sample));
    expect(after.sample.productAssetId).toBe(f.assetId);
  });
  it('GSB28 optional unknown header cannot let a foreign legacy factory borrow the selected native sample approval', async () => {
    const f = await legacyAsset('foreign-round-factory', { factoryRelationId: prefix + '-unrelated-factory' }, {}, 'present', false);
    const before = await legacySnapshot(f);
    const result = await link(f, await command(f));
    expect(result.status, json(result.body)).toBe(409);
    expect(await legacySnapshot(f)).toEqual(before);
  });
});
