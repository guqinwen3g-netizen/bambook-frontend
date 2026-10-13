/** Native fabric HTTP + current DB grants, locking/history/audit on private PG.
 * Customer/supplier/actor are minimum synthetic master data, not approved facts.
 * No seed/index/scheduler/shared DB. Costs, general manual order creation and
 * production release are separate acceptance domains and are not proved here. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevelopmentRouter } from '../src/development/route';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAuthService } from '../src/auth/service';
import { assertDevelopmentExpenseAccess } from '../src/development/developmentExpenseAccess';
import { previewDevelopmentClosure, recordDevelopmentLifecycle } from '../src/development/developmentClosureService';

const prefix = `acceptance-fabric-revision-${randomUUID()}`;
let prisma: PrismaClient | undefined;
const db = () => { if (!prisma) throw Error('Private fabric PG not initialized'); return prisma; };
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name, BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed private acceptance PG required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(['localhost', '127.0.0.1']).toContain(url.hostname);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/); expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`).toEqual([{ name, directory, port: Number(port) }]);
});
afterAll(async () => { await prisma?.$disconnect(); });
function app(client = db()) {
  const application = express(); application.use(express.json());
  application.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? Number(value) : value);
  application.use(createAccountStatusGuard(db())); application.use(createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  application.use('/api/v1/development', createDevelopmentRouter({ prisma: client, requireAuth: true, apiKeys: new Set() })); return application;
}
async function fixture() {
  const id = `${prefix}-${randomUUID()}`, actorId = `${id}-actor`, roleId = `${id}-role`, customerId = `${id}-customer`, supplierId = `${id}-supplier`;
  await db().userAccount.create({ data: { id: actorId, displayName: 'Synthetic development salesperson', status: 'active' } });
  await db().role.create({ data: { id: roleId, name: 'Custom development operator', isSystem: false } });
  await db().userRole.create({ data: { id: `${id}-membership`, userId: actorId, roleId } });
  for (const scope of ['products:read', 'products:write']) await db().userPermissionOverrides.create({ data: { id: `${id}-${scope}`, userId: actorId, scope, isActive: true, grantedBy: actorId, reason: 'Explicit private fixture grant' } });
  for (const [relationId, category] of [[customerId, 'Client'], [supplierId, 'Supplier']]) await db().relation.create({ data: { id: relationId, name: relationId, category, type: 'company', isOrganization: true, ownerId: actorId, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()) } });
  const actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), actorId));
  expect(actor.roles).toEqual([]); expect(actor.authorizationLoaded).toBe(true);
  const token = createAuthService().signToken(actor);
  const post = (url: string, body: object, client?: PrismaClient) => request(app(client)).post(`/api/v1/development${url}`).set('Authorization', `Bearer ${token}`).send(body);
  const created = await post('/', { code: id, name: 'Native fabric development', type: 'fabric', customerRelationId: customerId, customerName: customerId, specComposition: '100% cotton', specWeight: '180', specWidth: '150cm' });
  expect(created.status, JSON.stringify(created.body)).toBe(201); const caseId = created.body.case.id;
  expect((await post(`/${caseId}/suppliers`, { supplierRelationId: supplierId, supplierName: supplierId })).status).toBe(201);
  const createdBatch = await post(`/${caseId}/batches`, { sampleType: 'lab-dip', supplierRelationId: supplierId, specNote: 'Native S1' });
  expect(createdBatch.status, JSON.stringify(createdBatch.body)).toBe(201);
  const batchId = createdBatch.body.batch.id;
  const patch = (url: string, body: object, client?: PrismaClient) => request(app(client)).patch(`/api/v1/development${url}`).set('Authorization', `Bearer ${token}`).send(body);
  return { id, actorId, customerId, supplierId, caseId, batchId, actor, token, post, patch };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const batch = (f: Fixture) => db().sampleBatch.findUniqueOrThrow({ where: { id: f.batchId } });
async function command(f: Fixture, payload: object) {
  const value = await batch(f), history: any = value.attachments;
  return { ...payload, requestKey: randomUUID(), expectedRound: value.round, expectedRevision: history?.fabricHistory?.revision ?? 0 };
}
async function stage(f: Fixture, action: string, fields: object = {}, client?: PrismaClient) {
  const body = await command(f, { action, ...fields });
  return { body, response: await f.patch(`/batches/${f.batchId}/stage`, body, client) };
}
async function sent(f: Fixture) {
  expect((await stage(f, 'start')).response.status).toBe(200);
  expect((await stage(f, 'send', { sentDate: '2026-10-02', courier: 'DHL', trackingNumber: `${f.id}-tracking`, shippingFee: 45.5 })).response.status).toBe(200);
}
async function feedback(f: Fixture, status: string, note: string) {
  return f.post(`/batches/${f.batchId}/customer-feedback`, await command(f, { status, note, asSealed: status === 'approved' }));
}
async function approved(f: Fixture) {
  await sent(f); expect((await feedback(f, 'approved', 'Native customer approval')).status).toBe(200);
  expect((await stage(f, 'approve', { feedback: 'Customer recognized this round' })).response.status).toBe(200);
}
const convert = (f: Fixture, client?: PrismaClient) => f.post(`/${f.caseId}/convert-to-asset`, { sourceType: 'batch', sourceId: f.batchId }, client);
async function state(f: Fixture) {
  return { batch: await batch(f), development: await db().developmentCase.findUniqueOrThrow({ where: { id: f.caseId } }),
    audits: await db().auditLog.findMany({ where: { actorId: f.actorId }, orderBy: { id: 'asc' } }),
    orders: await db().order.findMany({ where: { customerRelationId: f.customerId }, orderBy: { id: 'asc' } }) };
}
function auditSqlFault(actorId: string, action: string) {
  const observed: { count: number; code?: string } = { count: 0 };
  const client = new Proxy(db(), { get(base, key) {
    if (key === '$transaction') return async (work: any, options?: any) => base.$transaction(async tx => work(new Proxy(tx, { get(real, delegate) {
      if (delegate === 'auditLog') return new Proxy(real.auditLog, { get(model, method) {
        if (method === 'create') return async (args: any) => { if (args.data.actorId !== actorId || args.data.action !== action) return model.create(args);
          observed.count++; try { return await model.create({ ...args, data: { ...args.data, actorId: `${prefix}-missing-actor` } }); } catch (error: any) { observed.code = error.code; throw error; } };
        const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
      } });
      const value = Reflect.get(real, delegate); return typeof value === 'function' ? value.bind(real) : value;
    } })), options);
    const value = Reflect.get(base, key); return typeof value === 'function' ? value.bind(base) : value;
  } }); return { client, observed };
}

describe('UI04 native fabric current eligibility and same-batch history', () => {
  it('FDR01 actual create→send→feedback→approve→confirm→asset→case completion→order preserves exact native anchors', async () => {
    const f = await fixture(); await approved(f);
    const confirmation = await f.post(`/batches/${f.batchId}/confirm`, await command(f, {})); expect(confirmation.status).toBe(200);
    const asset = await convert(f); expect(asset.status, JSON.stringify(asset.body)).toBe(200); expect(asset.body.asset.cost).toBeNull();
    for (const next of ['shipping', 'feedback', 'approved']) expect((await f.patch(`/${f.caseId}/stage`, { stage: next })).status).toBe(200);
    const order = await f.post(`/${f.caseId}/convert`, { autoCreate: true, quantity: 100, dueDate: '2099-11-15', clientRequestId: randomUUID() });
    expect(order.status, JSON.stringify(order.body)).toBe(200); expect(order.body.case.linkedOrderId).toBe(order.body.order.id);
    const stored = await batch(f); expect(stored.round).toBe(1); expect(stored.convertedProductAssetId).toBe(asset.body.asset.id);
    expect((stored.attachments as any).fabricHistory.events.map((e: any) => e.kind)).toEqual(['start', 'send', 'feedback', 'approve', 'confirm', 'convert']);
    expect(await db().costRecord.count({ where: { sourceType: 'SampleBatch', sourceId: f.batchId } })).toBe(0); // Fee without currency is not financial cost.
  });
  it.each(['needs_recast', 'rejected'])('FDR02/03 latest %s rejects recognition/confirmation/conversion/stage without a new fact', async status => {
    const f = await fixture(); await sent(f); expect((await feedback(f, status, 'Native negative response')).status).toBe(200);
    const before = await state(f);
    expect((await stage(f, 'approve')).response.status).toBe(409);
    expect((await f.post(`/batches/${f.batchId}/confirm`, await command(f, {}))).status).toBe(409);
    expect((await convert(f)).status).toBe(409);
    for (const next of ['shipping', 'feedback']) expect((await f.patch(`/${f.caseId}/stage`, { stage: next })).status).toBe(200);
    const beforeApproval = await state(f); expect((await f.patch(`/${f.caseId}/stage`, { stage: 'approved' })).status).toBe(409);
    expect(await state(f)).toEqual(beforeApproval); expect((await batch(f)).attachments).toEqual(before.batch.attachments);
  });
  it('FDR04 late negative keeps native old asset/seal facts and rejects old completion/order/converted-seal consumption', async () => {
    const f = await fixture(); await approved(f); const asset = await convert(f); expect(asset.status).toBe(200);
    const seal = await f.post(`/${f.caseId}/seals`, { batchIds: [f.batchId] }); expect(seal.status).toBe(201);
    expect((await f.patch(`/seals/${seal.body.seal.id}/status`, { status: 'sealed' })).status).toBe(200);
    for (const next of ['shipping', 'feedback', 'approved']) expect((await f.patch(`/${f.caseId}/stage`, { stage: next })).status).toBe(200);
    expect((await feedback(f, 'needs_recast', 'Recast after original approval')).status).toBe(200);
    const prior = await state(f);
    expect((await convert(f)).status).toBe(409);
    expect((await f.post(`/${f.caseId}/convert-to-asset`, { sourceType: 'seal', sourceId: seal.body.seal.id })).status).toBe(409);
    expect((await f.post(`/${f.caseId}/convert`, { autoCreate: true, quantity: 100, dueDate: '2099-11-15', clientRequestId: randomUUID() })).status).toBe(409);
    const context = { prisma: db(), actorId: f.actorId, authorize: (tx: any, id: string) => assertDevelopmentExpenseAccess(tx, f.actor, id, 'write') };
    const preview = await previewDevelopmentClosure(context, f.caseId);
    await expect(recordDevelopmentLifecycle(context, f.caseId, { action: 'close', outcome: 'completed', reason: 'Attempt after recast', disposition: 'Recast remains pending', expectedRevision: preview.revision, expectedFingerprint: preview.fingerprint, requestKey: randomUUID() })).rejects.toMatchObject({ code: 'DEVELOPMENT_NOT_READY' });
    expect(await state(f)).toEqual(prior); expect(await db().productAsset.findUnique({ where: { id: asset.body.asset.id } })).not.toBeNull();
    expect((await batch(f)).convertedProductAssetId).toBe(asset.body.asset.id);
  });
  it('FDR05 revise then start appends S2, retains S1 fee/feedback/asset, and independent new batch stays S1', async () => {
    const f = await fixture(); const originalCaseRound = (await db().developmentCase.findUniqueOrThrow({ where: { id: f.caseId } })).currentRound; await approved(f); const originalAsset = await convert(f); expect(originalAsset.status).toBe(200);
    expect((await feedback(f, 'needs_recast', 'S1 too dark')).status).toBe(200);
    expect((await stage(f, 'revise', { feedback: 'Make a lighter S2' })).response.status).toBe(200);
    const started = await stage(f, 'start'); expect(started.response.status).toBe(200); expect(started.response.body.batch.round).toBe(2);
    expect(started.response.body.batch.customerStatus).toBeNull(); expect(started.response.body.batch.shippingFee).toBeNull();
    expect(started.response.body.batch.convertedProductAssetId).toBe(originalAsset.body.asset.id); expect(started.response.body.batch.eligibility.assetCurrent).toBe(false);
    const history: any = (await batch(f)).attachments; expect(history.fabricHistory.events.some((e: any) => e.round === 1 && e.kind === 'feedback' && e.after.customerFeedbackNote === 'S1 too dark')).toBe(true);
    expect(history.fabricHistory.events.some((e: any) => e.round === 1 && e.kind === 'send' && e.after.shippingFee === 45.5)).toBe(true);
    const independent = await f.post(`/${f.caseId}/batches`, { sampleType: 'lab-dip', supplierRelationId: f.supplierId }); expect(independent.status).toBe(201); expect(independent.body.batch.round).toBe(1);
    expect((await db().developmentCase.findUniqueOrThrow({ where: { id: f.caseId } })).currentRound).toBe(originalCaseRound);
    expect((await stage(f, 'send')).response.status).toBe(200); expect((await feedback(f, 'approved', 'S2 approved')).status).toBe(200); expect((await stage(f, 'approve')).response.status).toBe(200);
    const replacement = await convert(f); expect(replacement.status).toBe(200); expect(replacement.body.asset.id).not.toBe(originalAsset.body.asset.id);
    expect((await db().developmentCase.findUniqueOrThrow({ where: { id: f.caseId } })).productAssetId).toBe(replacement.body.asset.id);
    expect(await db().productAsset.findUnique({ where: { id: originalAsset.body.asset.id } })).not.toBeNull();
  });
  it('FDR06 same actor/key replay returns original mandatory audit ack, changed content/stale revision reject zero writes', async () => {
    const f = await fixture(); await sent(f); const body = await command(f, { status: 'needs_recast', note: 'Original negative fact' });
    const first = await f.post(`/batches/${f.batchId}/customer-feedback`, body); expect(first.status).toBe(200); const before = await state(f);
    const replay = await f.post(`/batches/${f.batchId}/customer-feedback`, body); expect(replay.status).toBe(200); expect(replay.body.batch.commandAck).toEqual(first.body.batch.commandAck); expect(await state(f)).toEqual(before);
    const changed = await f.post(`/batches/${f.batchId}/customer-feedback`, { ...body, status: 'approved' }); expect(changed.status).toBe(409); expect(changed.body.error.code).toBe('REQUEST_CONFLICT');
    const stale = await f.post(`/batches/${f.batchId}/customer-feedback`, { ...body, requestKey: randomUUID() }); expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('DEVELOPMENT_SOURCE_CHANGED'); expect(await state(f)).toEqual(before);
  });
  it('FDR07 current scope revocation, credential empty cap and hidden customer cannot mutate pending source', async () => {
    const f = await fixture(); const before = await state(f);
    const limited = createAuthService().signToken({ ...f.actor, permissionCeiling: [] });
    const cap = await request(app()).patch(`/api/v1/development/batches/${f.batchId}/stage`).set('Authorization', `Bearer ${limited}`).send(await command(f, { action: 'start' })); expect(cap.status).toBe(403);
    await db().userPermissionOverrides.updateMany({ where: { userId: f.actorId, scope: 'products:write' }, data: { isActive: false } });
    expect((await stage(f, 'start')).response.status).toBe(403); expect(await state(f)).toEqual(before);
    await db().userPermissionOverrides.updateMany({ where: { userId: f.actorId, scope: 'products:write' }, data: { isActive: true } });
    const otherId = `${f.id}-other`; await db().userAccount.create({ data: { id: otherId, displayName: 'Hidden customer owner', status: 'active' } });
    await db().relation.update({ where: { id: f.customerId }, data: { ownerId: otherId } });
    const hidden = await stage(f, 'start'); expect(hidden.response.status).toBe(404); expect(await state(f)).toEqual(before);
  });
  it('FDR08 real audit FK fault rolls projection/history back, no SQL leakage; competing revisions cannot both commit', async () => {
    const f = await fixture(); await sent(f); const before = await state(f); const fault = auditSqlFault(f.actorId, 'submit_batch_customer_feedback');
    const response = await f.post(`/batches/${f.batchId}/customer-feedback`, await command(f, { status: 'needs_recast', note: 'Fault probe' }), fault.client);
    expect(response.status).toBe(500); expect(response.body.error.message).not.toMatch(/P2003|Foreign key|SQL|actorId/); expect(fault.observed).toEqual({ count: 1, code: 'P2003' }); expect(await state(f)).toEqual(before);
    const a = await command(f, { status: 'needs_recast', note: 'First customer response' }), b = { ...a, requestKey: randomUUID(), note: 'Competing response' };
    const results = await Promise.all([f.post(`/batches/${f.batchId}/customer-feedback`, a), f.post(`/batches/${f.batchId}/customer-feedback`, b)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await batch(f)).attachments && (await batch(f)).customerStatus).toBe('needs_recast');
    expect(await db().auditLog.count({ where: { actorId: f.actorId, action: 'submit_batch_customer_feedback' } })).toBe(1);
  });
  it('FDR09 a conversion waiting on the parent uses locked current specification/source and preserves another native primary asset', async () => {
    const f = await fixture(); await approved(f);
    const otherBatch = await f.post(`/${f.caseId}/batches`, { sampleType: 'lab-dip', supplierRelationId: f.supplierId }); expect(otherBatch.status).toBe(201);
    const peer = { ...f, batchId: otherBatch.body.batch.id }; await approved(peer);
    const peerAsset = await convert(peer); expect(peerAsset.status).toBe(200);
    await db().developmentCase.update({ where: { id: f.caseId }, data: { productAssetId: null, productName: '' } });
    let transactionStarted!: () => void;
    const started = new Promise<void>(resolve => { transactionStarted = resolve; });
    const instrumented = new Proxy(db(), { get(base, key) {
      if (key === '$transaction') return (work: any, options?: any) => { transactionStarted(); return base.$transaction(work, options); };
      const value = Reflect.get(base, key); return typeof value === 'function' ? value.bind(base) : value;
    } });
    let attempt: PromiseLike<any> | undefined;
    await db().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${f.caseId} FOR UPDATE`;
      await tx.developmentCase.update({ where: { id: f.caseId }, data: { productAssetId: peerAsset.body.asset.id, productName: 'Locked current fabric', specWeight: '235', specWidth: '162cm', specWeave: 'Locked satin', specFinish: 'Locked finish' } });
      await tx.sampleBatch.update({ where: { id: f.batchId }, data: { batchCode: `${f.id}-locked-batch`, supplierName: 'Locked current mill' } });
      // Supertest is lazy; .then starts the actual HTTP before releasing the lock.
      attempt = convert(f, instrumented).then(value => value);
      await started;
    });
    const response = await attempt!; expect(response.status, JSON.stringify(response.body)).toBe(200);
    const profile = await db().fabricProfile.findUniqueOrThrow({ where: { productAssetId: response.body.asset.id } });
    expect(response.body.asset.name).toBe('Locked current fabric');
    expect(profile).toMatchObject({ construction: 'Locked satin', weightValue: 235, widthValue: 162, widthText: '162cm', specialNote: 'Locked finish', referenceBatch: `${f.id}-locked-batch`, millName: 'Locked current mill' });
    expect(response.body.case.productAssetId).toBe(peerAsset.body.asset.id);
    const audit = await db().auditLog.findFirstOrThrow({ where: { actorId: f.actorId, action: 'convert_fabric_asset_link_case', targetId: f.caseId }, orderBy: { createdAt: 'desc' } });
    expect((audit.detail as any).before.productAssetId).toBe(peerAsset.body.asset.id);
    expect((audit.detail as any).after.productAssetId).toBe(peerAsset.body.asset.id);
  });
  it('FDR10 confirmed projection cannot consume an approval whose mandatory audit fact was removed', async () => {
    const f = await fixture(); await approved(f);
    const stored = await batch(f), event = (stored.attachments as any).fabricHistory.events.find((e: any) => e.kind === 'approve');
    // Corrupt the actual audit fact rather than manufacturing a permitted projection.
    await db().auditLog.update({ where: { id: event.auditId }, data: { detail: { corruptionProbe: 'missing round fact' } } });
    const before = await state(f);
    const response = await f.post(`/batches/${f.batchId}/confirm`, await command(f, {}));
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('DEVELOPMENT_SOURCE_CHANGED');
    expect(await state(f)).toEqual(before);
  });

});

describe('native fabric asset conversion request receipts',()=>{
 it('FDR11 response recovery and real concurrent duplicate requests return one exact native asset and audit',async()=>{
  const f=await fixture();await approved(f);const body=await command(f,{sourceType:'batch',sourceId:f.batchId});
  const responses=await Promise.all([f.post('/'+f.caseId+'/convert-to-asset',body),f.post('/'+f.caseId+'/convert-to-asset',body)]);
  for(const response of responses)expect(response.status,JSON.stringify(response.body)).toBe(200);
  const [first,replay]=responses;expect(replay.body.asset.id).toBe(first.body.asset.id);
  expect(replay.body.batch.commandAck).toEqual(first.body.batch.commandAck);
  expect(first.body.batch.commandAck).toMatchObject({kind:'convert',actorId:f.actorId,requestKey:body.requestKey,commandInput:{sourceType:'batch',sourceId:f.batchId,expectedRound:body.expectedRound,expectedRevision:body.expectedRevision},after:{convertedProductAssetId:first.body.asset.id}});
  expect(await db().auditLog.count({where:{actorId:f.actorId,action:'convert_fabric_to_asset'}})).toBe(1);
  const stored=await batch(f);expect((stored.attachments as any).fabricHistory.events.filter((e:any)=>e.kind==='convert')).toHaveLength(1);
  const before=await state(f);const changed=await f.post('/'+f.caseId+'/convert-to-asset',{...body,expectedRound:body.expectedRound+1});
  expect(changed.status).toBe(409);expect(changed.body.error.code).toBe('REQUEST_CONFLICT');expect(await state(f)).toEqual(before);
  await db().userPermissionOverrides.updateMany({where:{userId:f.actorId,scope:'products:write'},data:{isActive:false}});
  const denied=await f.post('/'+f.caseId+'/convert-to-asset',body);expect(denied.status).toBe(403);expect(await state(f)).toEqual(before);
 });
 it('FDR12 real mandatory conversion audit failure writes no asset or ack, then original request retries safely',async()=>{
  const f=await fixture();await approved(f);const body=await command(f,{sourceType:'batch',sourceId:f.batchId}),before=await state(f),assetCount=await db().productAsset.count();
  const fault=auditSqlFault(f.actorId,'convert_fabric_to_asset');const failed=await f.post('/'+f.caseId+'/convert-to-asset',body,fault.client);
  expect(failed.status).toBe(500);expect(fault.observed).toMatchObject({count:1,code:'P2003'});
  expect(await state(f)).toEqual(before);expect(await db().productAsset.count()).toBe(assetCount);
  const retry=await f.post('/'+f.caseId+'/convert-to-asset',body);expect(retry.status,JSON.stringify(retry.body)).toBe(200);
  expect(retry.body.batch.commandAck.requestKey).toBe(body.requestKey);expect(await db().auditLog.count({where:{actorId:f.actorId,action:'convert_fabric_to_asset'}})).toBe(1);
 });
});
