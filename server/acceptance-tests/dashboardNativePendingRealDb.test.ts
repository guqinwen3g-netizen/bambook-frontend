/** Real private PostgreSQL/Express controls. Native source producers; no report/request pending reseed, auth mock, write helper mock, or company-data claim. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createProductionBatchRouter } from '../src/production/productionBatchRoute';
import { createReleaseRouter } from '../src/production/releaseRoute';
import { initProductionStages, advanceStage, savePreCutChecklist, PRODUCTION_STAGES } from '../src/production/stageService';
import { createSample, advanceSampleStage, updateSample } from '../src/samples/sampleManageService';
import { createQcRouter } from '../src/qc/qcRoute';
import { createDashboardRouter } from '../src/dashboard/route';
import { createQcScopedService } from '../src/qc/qcScopedService';
import { resolveCurrentProductionBatchFacts } from '../src/production/productionBatchService';
import {
  createSampleBatch, advanceSampleBatchStage, createSealSample,
  sealSampleConfirm, convertToFabricAsset,
} from '../src/development/fabricDevelopmentService';

const prefix = `acceptance-native-pending-${randomUUID()}`;
const auth = createAuthService();
const successActions = ['create_production_batch', 'split_production_batch'];
let prisma: PrismaClient | undefined, sequence = 0, sqlQueries = 0, sqlWrites = 0;
const connections: PrismaClient[] = [];
function db(): PrismaClient { if (!prisma) throw Error('Independent ProductionBatch identity not verified'); return prisma; }
const batches = (client: any = db()) => client.productionBatch;
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const code = (r: any) => r.body.error?.code ?? r.body.error;
const safeBody = (r: any) => expect(diagnostic(r.body)).not.toMatch(/P2003|P2010|23503|42703|Foreign key|constraint|missing_batch_probe|nonexistent-audit-actor/i);

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed isolated PG is required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } }, log: [{ emit: 'event', level: 'query' }] });
  (prisma as any).$on('query', (event: { query: string }) => { sqlQueries++; if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i.test(event.query)) sqlWrites++; });
  expect(await db().$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
  // The canonical role identity is supported by the real loader. No role grant
  // or matrix is edited; all fixture capabilities are explicit personal grants.
  await db().role.upsert({ where: { id: 'manager' }, update: {}, create: { id: 'manager', name: 'Synthetic current leader', isSystem: true } });
});
afterAll(async () => { await Promise.all(connections.map(c => c.$disconnect())); await prisma?.$disconnect(); });

async function fixture(label: string, shared = false) {
  const id = `${prefix}-${++sequence}-${label}`, now = BigInt(Date.now()), userId = `${id}-user`,
    customerId = `${id}-customer`, supplierId = `${id}-factory`, caseId = `${id}-case`,
    orderId = `${id}-order`, lineId = `${id}-line`, otherUserId = `${id}-other-user`, teamId = `${id}-team`, shareId = `${id}-share`;
  await db().$transaction(async tx => {
    for (const uid of [userId, otherUserId]) await tx.userAccount.create({ data: { id: uid, displayName: 'Synthetic current account', status: 'active' } });
    await tx.userRole.create({ data: { id: `${id}-role`, userId, roleId: 'manager' } });
    await tx.userPermissionOverrides.createMany({ data: [
      'orders:read', 'orders:write', 'products:read', 'products:write', 'production:read',
    ].map(scope => ({ id: `${id}-${scope}`, userId, scope, isActive: true, grantedBy: userId, reason: 'Exact private technical grant, not company approval policy' })) });
    await tx.relation.create({ data: { id: customerId, name: customerId, category: 'Customer', type: 'Company', isOrganization: true,
      ownerId: shared ? otherUserId : userId, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
    await tx.relation.create({ data: { id: supplierId, name: supplierId, category: 'Supplier', type: 'Company', isOrganization: true,
      ownerId: userId, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
    await tx.developmentCase.create({ data: { id: caseId, code: caseId, name: 'Synthetic genuine source', type: 'fabric', stage: 'developing',
      owner: userId, customerRelationId: customerId, customerName: customerId, tags: [], createdAt: now, updatedAt: now } });
    await tx.order.create({ data: { id: orderId, poNumber: orderId, customer: customerId, customerRelationId: customerId,
      product: 'Synthetic fabric', type: 'fabric', quantity: 10, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 10,
      ownerId: userId, millRelationId: supplierId, sourceCaseId: caseId, importedAt: now, updatedAt: now } });
    await tx.orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, itemNo: '0010', quantity: '10', unit: 'm',
      description: 'Synthetic controlled physical range', tolerancePercent: '25', toleranceSource: 'line_override' } });
    if (shared) {
      await tx.team.create({ data: { id: teamId, name: 'Synthetic current L2 team', status: 'active' } });
      await tx.teamMember.create({ data: { id: `${id}-member`, teamId, userId } });
      await tx.teamDataGrant.create({ data: { id: shareId, teamId, entityType: 'relation', entityId: customerId,
        permission: 'read+followup', grantedBy: otherUserId } });
    }
  });
  const actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), userId));
  expect(actor.authorizationLoaded).toBe(true); expect(actor.roles).toContain('manager'); expect(actor.permissions).toContain('orders:write');
  const f = { id, userId, otherUserId, customerId, supplierId, caseId, orderId, lineId, actor, teamId, shareId, sealId: '', assetId: '' };
  // Native independent source, not a newly invented "approved" boolean.
  const made = await createSampleBatch({ prisma: db(), caseId, actorId: userId, input: { sampleType: 'yardage', supplierRelationId: supplierId } });
  expect(made.ok, diagnostic(made)).toBe(true); const sampleBatchId = (made as any).data.batch.id;
  for (const action of ['start', 'send', 'approve'] as const) {
    const current = await db().sampleBatch.findUniqueOrThrow({ where: { id: sampleBatchId } });
    const advanced = await advanceSampleBatchStage({ prisma: db(), batchId: sampleBatchId, actorId: userId, trustedActor: actor, action,
      input: { requestKey: randomUUID(), expectedRound: current.round, expectedRevision: (current.attachments as any)?.fabricHistory?.revision ?? 0,
        feedback: action === 'approve' ? 'Synthetic explicitly recorded customer recognition' : undefined } });
    expect(advanced.ok, diagnostic(advanced)).toBe(true);
  }
  const seal = await createSealSample({ prisma: db(), caseId, actorId: userId, input: { batchIds: [sampleBatchId], name: 'Synthetic native standard' } });
  expect(seal.ok, diagnostic(seal)).toBe(true); f.sealId = (seal as any).data.seal.id;
  const sealed = await sealSampleConfirm({ prisma: db(), sealId: f.sealId, actorId: userId, trustedActor: actor }); expect(sealed.ok, diagnostic(sealed)).toBe(true);
  const asset = await convertToFabricAsset({ prisma: db(), caseId, sourceType: 'seal', sourceId: f.sealId, actorId: userId, trustedActor: actor });
  expect(asset.ok, diagnostic(asset)).toBe(true); f.assetId = (asset as any).data.asset.id;
  const sourceApp = express(); sourceApp.use(express.json());
  sourceApp.set('json replacer', (_key: string, item: any) => typeof item === 'bigint' ? item.toString() : item);
  sourceApp.use('/order-lines', createOrderLinesRouter({ prisma: db(), requireAuth: true, apiKeys: new Set() }));
  const selected = await request(sourceApp).patch(`/order-lines/${lineId}/version`).set('Authorization', `Bearer ${auth.signToken(actor)}`)
    .send({ confirmedSourceType: 'SealSample', confirmedSourceId: f.sealId, millRelationId: supplierId });
  expect(selected.status, diagnostic(selected.body)).toBe(200);
  const current = await db().orderLine.findUniqueOrThrow({ where: { id: lineId } });
  expect(current.confirmedSourceId).toBe(f.sealId); expect(current.specSnapshot).not.toBeNull();
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Change = { entity: string; action: string; ids?: string[] };
function application(client: PrismaClient = db(), requireAuth = true) {
  const app = express(), changes: Change[] = [];
  app.use(express.json()); app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  app.use(createAccountStatusGuard(db()));
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  app.use('/api/v1/order-lines', createOrderLinesRouter({ prisma: client, requireAuth, apiKeys: new Set() }));
  app.use('/api/v1/production-batches', createProductionBatchRouter({ prisma: client, requireAuth, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
  app.use('/api/v1/releases', createReleaseRouter({ prisma: client, requireAuth, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
  app.use('/api/v1/qc', createQcRouter({ prisma: client, requireAuth, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
  app.use('/api/v1/dashboard', createDashboardRouter({ prisma: client, requireAuth, apiKeys: new Set() }));
  return { app, changes };
}
const base = (f: Fixture) => `/api/v1/production-batches/orders/${f.orderId}/lines/${f.lineId}`;
async function listing(f: Fixture, app = application(), actor: TokenPayload = f.actor) {
  const r = await request(app.app).get(base(f)).set('Authorization', `Bearer ${auth.signToken(actor)}`);
  expect(r.status, diagnostic(r.body)).toBe(200); expect(r.body.ok).toBe(true);
  expect(r.body.lineFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(Array.isArray(r.body.batches)).toBe(true); return r;
}
async function command(f: Fixture, quantity = '3.25', label = 'A') {
  return { batchCode: `${f.id}-${label}`, quantity, unit: 'm', expectedLineFingerprint: (await listing(f)).body.lineFingerprint, requestKey: randomUUID() };
}
type CreateCommand = Awaited<ReturnType<typeof command>>;
const create = (f: Fixture, body: any, app = application(), actor: TokenPayload = f.actor) =>
  request(app.app).post(base(f)).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
const split = (f: Fixture, parentId: string, body: any, app = application(), actor: TokenPayload = f.actor) =>
  request(app.app).post(`/api/v1/production-batches/${parentId}/split`).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
async function splitCommand(f: Fixture, parent: any, quantities = ['1.25', '2']) {
  return { expectedRevision: parent.revision, expectedLineFingerprint: (await listing(f)).body.lineFingerprint, requestKey: randomUUID(),
    children: quantities.map((quantity, i) => ({ batchCode: `${f.id}-child-${i}`, quantity })) };
}
async function created(f: Fixture, body: CreateCommand, app = application()) {
  const r = await create(f, body, app); expect(r.status, diagnostic(r.body)).toBe(201); expect(r.body.ok).toBe(true);
  expect(r.body.replayed).toBe(false); const actual = await batches().findUniqueOrThrow({ where: { id: r.body.batch.id } });
  expect(actual.createdBy).toBe(f.userId); expect(actual.requestKey).toBe(body.requestKey);
  expect(actual.parameterHash).toMatch(/^[a-f0-9]{64}$/); expect(actual.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(actual.commandSnapshot).toMatchObject({ ...body, quantity: new Prisma.Decimal(body.quantity).toString() }); return { response: r, batch: actual };
}
const releaseBase = '/api/v1/releases';
async function releaseGrant(f: Fixture, scope = 'production:pp_release:business_sign') {
  await db().userPermissionOverrides.upsert({ where: { id: `${f.id}-${scope}` }, update: { isActive: true },
    create: { id: `${f.id}-${scope}`, userId: f.userId, scope, isActive: true, grantedBy: f.userId, reason: 'Exact private sign capability; not policy' } });
  return await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), f.userId));
}
const scopeCreate = (f: Fixture, batch: any, extra: any = {}, app = application(), actor: TokenPayload = f.actor) =>
  request(app.app).post(`${releaseBase}/orders/${f.orderId}/lines/${f.lineId}/release-scopes`)
    .set('Authorization', `Bearer ${auth.signToken(actor)}`).send({ productionBatchId: batch.id, expectedBatchRevision: batch.revision, quantity: String(batch.quantity), unit: batch.unit, ...extra });
async function scopeMade(f: Fixture, batch: any, app = application()) {
  const r = await scopeCreate(f, batch, {}, app); expect(r.status, diagnostic(r.body)).toBe(201); return r.body.scope;
}
async function asked(f: Fixture, scope: any, app = application()) {
  const r = await request(app.app).post(`${releaseBase}/release-scopes/${scope.id}/requests`)
    .set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send({ expectedScopeRevision: scope.scopeRevision });
  expect(r.status, diagnostic(r.body)).toBe(201); return r.body.request;
}
const signed = (f: Fixture, rr: any, actor: TokenPayload, app = application(), extra: any = {}) =>
  request(app.app).post(`${releaseBase}/release-requests/${rr.id}/signatures`).set('Authorization', `Bearer ${auth.signToken(actor)}`)
    .send({ role: 'business', ...extra });

async function current(userId: string) { return buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), userId)); }
const actionRead = (rr: any, actor: TokenPayload, app = application()) => request(app.app)
  .get(`${releaseBase}/release-requests/${rr.id}/action-context`).set('Authorization', `Bearer ${auth.signToken(actor)}`);
async function group(actor: TokenPayload, key: 'qc' | 'approvals', app = application()) {
  const r = await request(app.app).get(`/api/v1/dashboard/workbench?group=${key}&limit=50`).set('Authorization', `Bearer ${auth.signToken(actor)}`);
  expect(r.status, diagnostic(r.body)).toBe(200); return r.body.groups.find((r: any) => r.key === key);
}
async function pending(label: string) {
  const f = await fixture(label), made = await created(f, await command(f, '10'));
  const scope = await scopeMade(f, made.batch), rr = await asked(f, scope);
  return { ...f, batch: made.batch, scope, rr };
}
async function completed(f: Fixture, withWidth = false) {
  await releaseGrant(f, 'qc:read'); const actor = await releaseGrant(f, 'qc:write');
  const service = createQcScopedService(db()), coverage = (await service.scopes(f.orderId, actor)).scopes.find((r: any) => r.scopeType === 'whole_order')!;
  const task = await service.create({ orderId:f.orderId, inspectionType:'final', qcUserId:f.userId, scopeType:'whole_order', productionBatchId:null,
    expectedScopeFingerprint:coverage.scopeFingerprint, requestKey:randomUUID() }, actor);
  const done = await service.complete(task.item.id,{ requestKey:randomUUID(), expectedScopeFingerprint:coverage.scopeFingerprint,
    report:{ result:'pass', inspectionDate:'2026-10-03',totalUnits:10,passedUnits:10,criticalDefects:0,majorDefects:0,minorDefects:0,sampleSize:10,lotSize:10,
      ...(withWidth?{widthMeasurements:[{orderLineId:f.lineId,measuredWidthCm:147,basisWidthCm:147,note:'actual native width'}]}:{})} }, actor);
  return { actor, task:task.item, report:done.report };
}
async function facts(f: Fixture) {
  const scopes=await db().releaseScope.findMany({where:{orderId:f.orderId},orderBy:{id:'asc'}}), scopeIds=scopes.map(r=>r.id);
  const requests=await db().releaseRequest.findMany({where:{scopeId:{in:scopeIds}},orderBy:{id:'asc'}});
  const reports=await db().inspectionReport.findMany({where:{orderId:f.orderId},orderBy:{id:'asc'}});
  return {order:await db().order.findUnique({where:{id:f.orderId}}),line:await db().orderLine.findUnique({where:{id:f.lineId}}),scopes,requests,reports,
    tasks:await db().qCAssignment.findMany({where:{orderId:f.orderId},orderBy:{id:'asc'}}),
    widths:await db().inspectionWidthMeasurement.findMany({where:{reportId:{in:reports.map(r=>r.id)}},orderBy:{id:'asc'}}),
    signatures:await db().releaseSignature.findMany({where:{requestId:{in:requests.map(r=>r.id)}},orderBy:{id:'asc'}}),
    events:await db().releaseEvent.findMany({where:{scopeId:{in:scopeIds}},orderBy:{id:'asc'}}),
    releases:await db().ppSampleRelease.findMany({where:{scopeId:{in:scopeIds}},orderBy:{id:'asc'}}),
    audits:await db().auditLog.findMany({where:{actorId:f.userId},orderBy:{id:'asc'}}),
    stock:await db().stockMovement.findMany({where:{referenceId:f.orderId},orderBy:{id:'asc'}})};
}
function intercepted(modelName:string, methodName:string, after:(value:any,args:any)=>Promise<void>|void) {
  const wrap=(raw:any):any=>new Proxy(raw,{get(target,key){
    if(key==='$transaction')return(work:any,options:any)=>target.$transaction((tx:any)=>work(wrap(tx)),options);
    const model=Reflect.get(target,key);if(key!==modelName)return typeof model==='function'?model.bind(target):model;
    return new Proxy(model,{get(delegate,method){const value=Reflect.get(delegate,method);if(method===methodName)return async(args:any)=>{const result=await value.call(delegate,args);await after(result,args);return result;};return typeof value==='function'?value.bind(delegate):value;}});
  }});return wrap(db()) as PrismaClient;
}

describe('Original native report and request pending Dashboard/read contracts',()=>{
  it('NP01 completed native QC assignment exposes its original pending report, not another assignment; every read is zero-write',async()=>{
    const f=await fixture('qc-pending'), done=await completed(f), before=await facts(f),writesBefore=sqlWrites;
    const g=await group(done.actor,'qc');expect(g.status,diagnostic(g)).toBe('ready');
    const found=g.items.find((r:any)=>r.source.type==='InspectionReport'&&r.source.id===done.report.id);
    expect(found).toMatchObject({bucket:'action',target:{kind:'qc-report',reportId:done.report.id,orderId:f.orderId}});
    expect(g.items.some((r:any)=>r.source.type==='QCAssignment'&&r.source.id===done.task.id)).toBe(false);
    const get=await request(application().app).get(`/api/v1/qc/reports/${done.report.id}`).set('Authorization',`Bearer ${auth.signToken(done.actor)}`);
    expect(get.status,diagnostic(get.body)).toBe(200);expect(get.body.item).toMatchObject({contentCurrent:true,canBusinessDecide:true});
    expect(await facts(f)).toEqual(before);expect(sqlWrites).toBe(writesBefore);
    const decided=await createQcScopedService(db()).decision(done.report.id,{expectedRevision:done.report.revision,expectedScopeFingerprint:done.report.scopeFingerprint,expectedContentFingerprint:done.report.contentFingerprint,decision:'approved',requestKey:randomUUID(),reason:'Actual current business owner decision'},done.actor);
    expect(decided.item.approvedByBusiness).toBe(true);expect((await group(done.actor,'qc')).items.some((r:any)=>r.source.id===done.report.id)).toBe(false);
  });
  it('NP02 sign-only current authority reads exact original request without Order/production read, enters original sign writer once',async()=>{
    const f=await pending('sign-only');await releaseGrant(f);await db().userPermissionOverrides.updateMany({where:{userId:f.userId,scope:{not:'production:pp_release:business_sign'}},data:{isActive:false}});
    await db().role.create({data:{id:`${f.id}-sign-only-role`,name:'Synthetic exact signer custom role',isSystem:false}});
    await db().userRole.update({where:{id:`${f.id}-role`},data:{roleId:`${f.id}-sign-only-role`}});
    await db().role.create({data:{id:`${f.id}-additional-custom-role`,name:'Synthetic additional current role',isSystem:false}});
    await db().userRole.create({data:{id:`${f.id}-additional-membership`,userId:f.userId,roleId:`${f.id}-additional-custom-role`}});
    const actor=await current(f.userId);expect(actor.permissions).toEqual(['production:pp_release:business_sign']);expect(actor.roles).not.toContain('manager');
    const before=await facts(f),sqlStart=sqlQueries,writesBefore=sqlWrites,timeStart=performance.now(),r=await actionRead(f.rr,actor);
    console.log(JSON.stringify({nativeReadMeasurement:'exact-sign-only-context',queries:sqlQueries-sqlStart,milliseconds:performance.now()-timeStart}));
    expect(r.status,diagnostic(r.body)).toBe(200);
    expect(r.body.item).toMatchObject({request:{id:f.rr.id,scopeId:f.scope.id},scope:{id:f.scope.id,orderId:f.orderId,orderLineId:f.lineId,quantity:'10',classification:'current'},allowedRoles:['business'],canSign:true});
    expect(r.body.item).not.toHaveProperty('order');expect(diagnostic(r.body)).not.toMatch(/quoteAmount|costPrice|evidenceSnapshot/);
    const g=await group(actor,'approvals');expect(g.status,diagnostic(g)).toBe('ready');expect(g.items).toContainEqual(expect.objectContaining({target:{kind:'release-request',requestId:f.rr.id,scopeId:f.scope.id,orderId:f.orderId,orderLineId:f.lineId},bucket:'action'}));
    expect(await facts(f)).toEqual(before);expect(sqlWrites).toBe(writesBefore);
    let flip=false;
    const reorder=intercepted('userAccount','findUnique',row=>{if(row?.id===f.userId&&row.roles?.length>1){flip=!flip;if(flip)row.roles.reverse();}});
    const reordered=await actionRead(f.rr,actor,application(reorder));expect(reordered.status,diagnostic(reordered.body)).toBe(200);expect(reordered.body.item).toEqual(r.body.item);
    const sign=await signed(f,f.rr,actor);expect(sign.status,diagnostic(sign.body)).toBe(200);expect((await facts(f)).signatures).toHaveLength(1);
    const after=await actionRead(f.rr,actor);expect(after.status).toBe(200);expect(after.body.item).toMatchObject({request:{id:f.rr.id,state:'granted'},allowedRoles:[],canSign:false});
    expect((await group(actor,'approvals')).items.some((r:any)=>r.source.id===f.rr.id)).toBe(false);
  });
  it('NP03 two original pending requests in one scope retain exact request identity',async()=>{
    const f=await pending('same-scope'),other=await asked(f,f.scope),actor=await releaseGrant(f);expect(other.id).not.toBe(f.rr.id);
    const g=await group(actor,'approvals');expect(g.status,diagnostic(g)).toBe('ready');
    expect(g.items.filter((r:any)=>r.source.type==='ReleaseRequest').map((r:any)=>r.target.requestId).sort()).toEqual([f.rr.id,other.id].sort());
    expect((await actionRead(f.rr,actor)).body.item.request.id).toBe(f.rr.id);expect((await actionRead(other,actor)).body.item.request.id).toBe(other.id);
  });
  it.each([[[]],[['production:read']],[['production:pp_release:business_sign']]])('NP04 actual signed ceiling %j remains authoritative for signer-only read',async ceiling=>{
    const f=await pending('ceiling'),actor=await releaseGrant(f);const before=await facts(f),r=await actionRead(f.rr,{...actor,permissionCeiling:ceiling});
    expect(r.status,diagnostic(r.body)).toBe(ceiling.includes('production:pp_release:business_sign')?200:403);expect(await facts(f)).toEqual(before);
  });
  it('NP05 current revoke, forged roles and foreign parent cannot disclose pending request',async()=>{
    const f=await pending('revoked'),actor=await releaseGrant(f);await db().userPermissionOverrides.updateMany({where:{userId:f.userId,scope:'production:pp_release:business_sign'},data:{isActive:false}});
    const before=await facts(f),r=await actionRead(f.rr,{...actor,roles:['owner'],permissions:['*']});expect(r.status,diagnostic(r.body)).toBe(403);expect(await facts(f)).toEqual(before);
    await db().userPermissionOverrides.create({data:{id:`${f.id}-foreign-sign`,userId:f.otherUserId,scope:'production:pp_release:business_sign',isActive:true,grantedBy:f.userId,reason:'Exact foreign capability; does not grant parent L2'}});
    const foreign=await actionRead(f.rr,await current(f.otherUserId));expect(foreign.status,diagnostic(foreign.body)).toBe(404);
  });
  it('NP06 original source revision becomes blocked; action reader never signs or promotes historical scope',async()=>{
    const f=await pending('history'),actor=await releaseGrant(f);await db().productionBatch.update({where:{id:f.batch.id},data:{revision:{increment:1}}});
    const before=await facts(f),r=await actionRead(f.rr,actor);expect(r.status,diagnostic(r.body)).toBe(200);expect(r.body.item).toMatchObject({scope:{classification:'historical'},canSign:false});expect(r.body.item.blockedReasons.length).toBeGreaterThan(0);
    const g=await group(actor,'approvals');expect(g.status).toBe('ready');expect(g.items.find((r:any)=>r.source.id===f.rr.id).bucket).toBe('risk');expect(await facts(f)).toEqual(before);
  });
  it.each(['report','width'] as const)('NP07 tampered native %s cannot claim business decision current',async kind=>{
    const f=await fixture('content-'+kind),done=await completed(f,true);
    if(kind==='report')await db().inspectionReport.update({where:{id:done.report.id},data:{notes:'tampered after immutable content'}});
    else await db().inspectionWidthMeasurement.updateMany({where:{reportId:done.report.id},data:{measuredWidthCm:'146'}});
    const before=await facts(f),r=await request(application().app).get(`/api/v1/qc/reports/${done.report.id}`).set('Authorization',`Bearer ${auth.signToken(done.actor)}`);
    expect(r.status,diagnostic(r.body)).toBe(200);expect(r.body.item).toMatchObject({contentCurrent:false,canBusinessDecide:false});
    const g=await group(done.actor,'qc');expect(g.status).toBe('ready');expect(g.items.find((r:any)=>r.source.id===done.report.id).bucket).toBe('risk');expect(await facts(f)).toEqual(before);
  });
  it('NP08 reader fault remains failed/null rather than empty, and unknown error text stays private',async()=>{
    const f=await pending('fault'),actor=await releaseGrant(f),before=await facts(f);
    const fault=intercepted('releaseRequest','findMany',()=>{throw Error('PRIVATE_NATIVE_DEPENDENCY_BROKEN');});
    const g=await group(actor,'approvals',application(fault));expect(g).toMatchObject({status:'failed',items:null,total:null});expect(diagnostic(g)).not.toContain('PRIVATE_NATIVE_DEPENDENCY_BROKEN');expect(await facts(f)).toEqual(before);
    const failed=await actionRead(f.rr,actor,application(intercepted('releaseRequest','findUnique',()=>{throw Error('PRIVATE_NATIVE_DEPENDENCY_BROKEN');})));
    expect(failed.status,diagnostic(failed.body)).toBe(500);expect(diagnostic(failed.body)).not.toContain('PRIVATE_NATIVE_DEPENDENCY_BROKEN');
  });
  it('NP09 source changes between complete group reads fail the group without publishing its first snapshot',async()=>{
    const f=await pending('changed'),actor=await releaseGrant(f),external=new PrismaClient();connections.push(external);let changed=false;
    const client=intercepted('releaseRequest','findMany',async result=>{if(!changed&&result.some((r:any)=>r.id===f.rr.id)){changed=true;await external.releaseRequest.update({where:{id:f.rr.id},data:{requestRevision:{increment:1}}});}});
    const g=await group(actor,'approvals',application(client));expect(changed).toBe(true);expect(g).toMatchObject({status:'failed',items:null,total:null});
    expect((await facts(f)).signatures).toHaveLength(0);
  });
  it('NP10 action context current parent transfer during first read cannot leak the original response',async()=>{
    const f=await pending('parent-change'),actor=await releaseGrant(f),external=new PrismaClient();connections.push(external);let changed=false;
    const client=intercepted('releaseRequest','findUnique',async result=>{if(!changed&&result?.id===f.rr.id){changed=true;await external.relation.update({where:{id:f.customerId},data:{ownerId:f.otherUserId}});await external.order.update({where:{id:f.orderId},data:{ownerId:f.otherUserId}});}});
    const r=await actionRead(f.rr,actor,application(client));expect(changed).toBe(true);expect(r.status,diagnostic(r.body)).not.toBe(200);expect(r.body.item).toBeUndefined();
  });
  it('NP11 anonymous and API-key cannot consume the signer-only action context',async()=>{
    const f=await pending('no-session');expect((await request(application().app).get(`${releaseBase}/release-requests/${f.rr.id}/action-context`)).status).toBe(401);
    const app=express();app.use(express.json());app.use('/api/v1/releases',createReleaseRouter({prisma:db(),requireAuth:true,apiKeys:new Set(['synthetic-private-key'])}));
    const r=await request(app).get(`${releaseBase}/release-requests/${f.rr.id}/action-context`).set('x-api-key','synthetic-private-key');expect(r.status).toBe(401);expect(r.body.item).toBeUndefined();
  });
  it('NP12 read-only QC sees the original report but receives no business action; missing content storage is unknown',async()=>{
    const f=await fixture('qc-read-only'),done=await completed(f);
    const readOnly={...done.actor,permissionCeiling:['qc:read']},g=await group(readOnly,'qc');expect(g.status,diagnostic(g)).toBe('ready');expect(g.items.some((r:any)=>r.source.id===done.report.id)).toBe(false);
    const r=await request(application().app).get(`/api/v1/qc/reports/${done.report.id}`).set('Authorization',`Bearer ${auth.signToken(readOnly)}`);
    expect(r.status,diagnostic(r.body)).toBe(200);expect(r.body.item.canBusinessDecide).toBe(false);
    const before=await facts(f),broken=intercepted('inspectionWidthMeasurement','findMany',()=>{throw Error('PRIVATE_WIDTH_STORAGE_FAULT');});
    const failed=await group(done.actor,'qc',application(broken));expect(failed).toMatchObject({status:'failed',items:null,total:null});expect(diagnostic(failed)).not.toContain('PRIVATE_WIDTH_STORAGE_FAULT');expect(await facts(f)).toEqual(before);
  });
  it('NP13 active department head needs actual parent L2 and native evidence; ordinary inspector/visible colleague gets no business queue',async()=>{
    const f=await fixture('head'),done=await completed(f),departmentId=`${f.id}-dept`,teamId=`${f.id}-head-team`;
    await db().$transaction(async tx=>{
      await tx.department.create({data:{id:departmentId,name:'Actual synthetic head department',status:'active',headId:f.otherUserId}});
      await tx.order.update({where:{id:f.orderId},data:{departmentId}});
      await tx.team.create({data:{id:teamId,name:'Actual head L2 team',status:'active'}});await tx.teamMember.create({data:{id:`${teamId}-member`,teamId,userId:f.otherUserId}});
      await tx.teamDataGrant.create({data:{id:`${teamId}-grant`,teamId,entityType:'relation',entityId:f.customerId,permission:'read+followup',grantedBy:f.userId}});
      await tx.userPermissionOverrides.createMany({data:['qc:read','qc:write'].map(scope=>({id:`${f.id}-head-${scope}`,userId:f.otherUserId,scope,isActive:true,grantedBy:f.userId,reason:'Actual private head QC read/write capability'}))});
    });
    const head=await current(f.otherUserId),before=await facts(f),g=await group(head,'qc');expect(g.status,diagnostic(g)).toBe('ready');expect(g.items.find((r:any)=>r.source.id===done.report.id)).toMatchObject({bucket:'action',responsibility:{kind:'scope-visible',userId:f.otherUserId}});expect(await facts(f)).toEqual(before);
    await db().department.update({where:{id:departmentId},data:{headId:null}});
    const colleague=await group(head,'qc');expect(colleague.status,diagnostic(colleague)).toBe('ready');expect(colleague.items.some((r:any)=>r.source.id===done.report.id)).toBe(false);
    await db().department.update({where:{id:departmentId},data:{headId:f.otherUserId}});await db().teamDataGrant.delete({where:{id:`${teamId}-grant`}});
    expect((await group(head,'qc')).items.some((r:any)=>r.source.id===done.report.id)).toBe(false);
  });
  it('NP14 pending QC group rechecks actual department responsibility between complete reads',async()=>{
    const f=await fixture('qc-race'),done=await completed(f),external=new PrismaClient();connections.push(external);let changed=false;
    const client=intercepted('inspectionReport','findMany',async(rows,args)=>{if(!changed&&args.where?.approvedByBusiness===false&&rows.some((r:any)=>r.id===done.report.id)){changed=true;await external.order.update({where:{id:f.orderId},data:{ownerId:f.otherUserId}});}});
    const g=await group(done.actor,'qc',application(client));expect(changed).toBe(true);expect(g).toMatchObject({status:'failed',items:null,total:null});expect((await facts(f)).reports[0].approvedAt).toBeNull();
  });
  it('NP15 actual action-context current grant dependency fault is unavailable, never a default broad role',async()=>{
    const f=await pending('auth-fault'),actor=await releaseGrant(f),before=await facts(f);
    const client=intercepted('userAccount','findUnique',()=>{throw Error('PRIVATE_CURRENT_ACCOUNT_FAULT');});
    const r=await actionRead(f.rr,actor,application(client));expect(r.status,diagnostic(r.body)).toBe(503);expect(r.body.item).toBeUndefined();expect(diagnostic(r.body)).not.toContain('PRIVATE_CURRENT_ACCOUNT_FAULT');expect(await facts(f)).toEqual(before);
  });

});
