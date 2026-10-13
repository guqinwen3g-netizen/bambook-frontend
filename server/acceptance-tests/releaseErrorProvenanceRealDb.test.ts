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
import { createQcScopedService } from '../src/qc/qcScopedService';
import { resolveCurrentProductionBatchFacts } from '../src/production/productionBatchService';
import {
  createSampleBatch, advanceSampleBatchStage, createSealSample,
  sealSampleConfirm, convertToFabricAsset,
} from '../src/development/fabricDevelopmentService';

const prefix = `acceptance-release-provenance-${randomUUID()}`;
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

async function pending(label: string) {
  const f = await fixture(label), made = await created(f, await command(f, '10'));
  const scope = await scopeMade(f, made.batch), rr = await asked(f, scope);
  return { ...f, batch: made.batch, scope, rr };
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


const privateSql = 'SQL private_release P2003';
const fault = (kind: string) => kind === 'fake'
  ? Object.assign(new Error(privateSql), { name: 'ReleaseGateError', code: 'CONFLICT', statusCode: 409 })
  : new Error(privateSql);
const authHeader = (actor: TokenPayload) => `Bearer ${auth.signToken(actor)}`;
const commands = [
  ['scope','releaseScope','create','SCOPE_CREATE_FAILED','创建放行范围未能完成，请稍后重试；持续失败请联系管理员核对该订单行的放行范围与拆批记录。'],
  ['rebind','releaseScope','update','INTERNAL_ERROR','批次范围重新绑定未能完成，本次未确认任何改动，请保留原修订并刷新核对。'],
  ['request','releaseRequest','create','REQUEST_CREATE_FAILED','发起放行请求未能完成，请稍后重试；持续失败请联系管理员核对该放行范围的请求与证据快照。'],
  ['sign','releaseSignature','create','SIGN_FAILED','放行签署未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该放行范围的签字与放行单。'],
  ['transition','releaseScope','findFirst','TRANSITION_FAILED','放行状态变更未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该放行范围的状态与事件流水。'],
  ['invalidate','ppSampleRelease','findMany','INVALIDATE_FAILED','失效联动未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该样品关联的放行范围与事件流水。'],
] as const;
async function commandFixture(name: string) {
  const f=await fixture(name), made=await created(f,await command(f,'10'));
  const scope=name==='scope'?null:await scopeMade(f,made.batch);
  const rr=name==='sign'?await asked(f,scope):null;
  const actor=await releaseGrant(f,name==='sign'?'production:pp_release:business_sign':'production:pp_release:admin');
  return {...f,batch:made.batch,scope,rr,actor};
}
async function runCommand(name:string,f:Awaited<ReturnType<typeof commandFixture>>,app:ReturnType<typeof application>) {
  const req=(url:string,body:any)=>request(app.app).post(releaseBase+url).set('Authorization',authHeader(f.actor)).send(body);
  switch(name) {
    case 'scope':return scopeCreate(f,f.batch,{},app,f.actor);
    case 'rebind':return req(`/release-scopes/${f.scope.id}/rebind`,{productionBatchId:f.batch.id,expectedBatchRevision:f.batch.revision,expectedScopeRevision:f.scope.scopeRevision,quantity:'10',unit:'m'});
    case 'request':return req(`/release-scopes/${f.scope.id}/requests`,{expectedScopeRevision:f.scope.scopeRevision});
    case 'sign':return signed(f,f.rr,f.actor,app);
    case 'transition':return req(`/release-scopes/${f.scope.id}/pause`,{expectedScopeRevision:f.scope.scopeRevision});
    case 'invalidate':return req('/invalidate-by-sample',{sampleId:`${f.id}-no-evidence`,sourceKey:randomUUID()});
    default:throw Error('Unknown test command');
  }
}
describe('Release native producer provenance and private actual HTTP rollback',()=>{
  for(const [name,model,method,errorCode,message] of commands) for(const kind of ['plain','fake'])
    it(`RP-${name}-${kind} storage rejection is safe500, source names/codes cannot grant public-message provenance`,async()=>{
      const f=await commandFixture(name), before=await facts(f);let hits=0;
      const app=application(intercepted(model,method,()=>{hits++;throw fault(kind);}));
      const r=await runCommand(name,f,app);
      expect(hits).toBe(1);expect(r.status,diagnostic(r.body)).toBe(500);
      expect(r.body).toEqual({ok:false,error:{code:errorCode,message,status:500}});
      expect(diagnostic(r.body)).not.toMatch(/SQL|private_release|P2003/);
      expect(await facts(f)).toEqual(before);expect(app.changes).toEqual([]);
    });
  for(const modern of [false,true]) it(`RP-${modern?'action-context':'original-summary'} fake typed read fault is safe500 and zero-write`,async()=>{
    const f=await pending(`read-${modern}`),actor=await releaseGrant(f),before=await facts(f);let hits=0;
    const app=application(intercepted(modern?'releaseRequest':'releaseScope',modern?'findUnique':'findMany',()=>{hits++;throw fault('fake');}));
    const r=await request(app.app).get(modern?`${releaseBase}/release-requests/${f.rr.id}/action-context`:`${releaseBase}/orders/${f.orderId}/releases`).set('Authorization',authHeader(actor));
    expect(hits).toBe(1);expect(r.status,diagnostic(r.body)).toBe(500);expect(code(r)).toBe('INTERNAL_ERROR');
    expect(diagnostic(r.body)).not.toMatch(/SQL|private_release|P2003/);expect(await facts(f)).toEqual(before);expect(app.changes).toEqual([]);
  });
  for(const modern of [false,true]) it(`RP-${modern?'reasons':'history'} fake CONFLICT from batch storage cannot become readable source reasons/history`,async()=>{
    const f=await pending(`source-${modern}`),actor=await releaseGrant(f),before=await facts(f);let hits=0;
    const app=application(intercepted('productionBatch','findFirst',()=>{hits++;throw fault('fake');}));
    const r=await request(app.app).get(modern?`${releaseBase}/release-requests/${f.rr.id}/action-context`:`${releaseBase}/orders/${f.orderId}/releases`).set('Authorization',authHeader(actor));
    expect(hits).toBeGreaterThan(0);expect(r.status,diagnostic(r.body)).toBe(500);expect(code(r)).toBe('INTERNAL_ERROR');
    expect(diagnostic(r.body)).not.toMatch(/SQL|private_release|P2003/);expect(r.body).not.toHaveProperty('scopes');expect(r.body).not.toHaveProperty('item');
    expect(await facts(f)).toEqual(before);
  });
  it('RP-real-revision exact native batch conflict keeps its precise409 public message and zero-write',async()=>{
    const f=await fixture('actual-revision'), made=await created(f,await command(f,'10')),before=await facts(f);
    const r=await scopeCreate(f,made.batch,{expectedBatchRevision:made.batch.revision+1});
    expect(r.status,diagnostic(r.body)).toBe(409);expect(r.body.error).toMatchObject({code:'CONFLICT',message:'实际生产批次不存在、归属不符或修订已变化，请刷新当前范围。'});expect(await facts(f)).toEqual(before);
  });
  it('RP-real-precision native quantity producer retains400 and exact prompt before any transaction write',async()=>{
    const f=await fixture('precision'),before=await facts(f);
    const r=await request(application().app).post(`${releaseBase}/orders/${f.orderId}/lines/${f.lineId}/release-scopes`).set('Authorization',authHeader(f.actor)).send({quantity:'1.00001',unit:'m'});
    expect(r.status,diagnostic(r.body)).toBe(400);expect(r.body.error).toMatchObject({code:'INVALID_INPUT',message:'数量须为正的十进制数，最多四位小数。'});expect(await facts(f)).toEqual(before);
  });
  it('RP-real-history source revision drift is accurately historical and blocked; genuine reason preserved without signature',async()=>{
    const f=await pending('actual-history'),actor=await releaseGrant(f);
    await db().productionBatch.update({where:{id:f.batch.id},data:{revision:{increment:1}}});const before=await facts(f);
    const app=application(),old=await request(app.app).get(`${releaseBase}/orders/${f.orderId}/releases`).set('Authorization',authHeader(actor));
    expect(old.status,diagnostic(old.body)).toBe(200);expect(old.body.scopes.find((s:any)=>s.id===f.scope.id)).toMatchObject({classification:'historical',historyReason:'实际生产批次不存在、归属不符或修订已变化，请刷新当前范围。'});
    const modern=await request(app.app).get(`${releaseBase}/release-requests/${f.rr.id}/action-context`).set('Authorization',authHeader(actor));
    expect(modern.status,diagnostic(modern.body)).toBe(200);expect(modern.body.item.canSign).toBe(false);expect(modern.body.item.blockedReasons).toContain('实际生产批次不存在、归属不符或修订已变化，请刷新当前范围。');
    const denied=await signed(f,f.rr,actor);expect(denied.status,diagnostic(denied.body)).toBe(409);expect(await facts(f)).toEqual(before);
  });
  it('RP-native-authority current withdrawn grant and signed empty ceiling deny original sign; missing parent remains404',async()=>{
    const f=await pending('authority'),actor=await releaseGrant(f),before=await facts(f);
    const denied=await signed(f,f.rr,{...actor,permissionCeiling:[]});expect(denied.status).toBe(403);
    await db().userPermissionOverrides.updateMany({where:{userId:f.userId,scope:'production:pp_release:business_sign'},data:{isActive:false}});
    const withdrawn=await signed(f,f.rr,actor);expect(withdrawn.status).toBe(403);
    const missing=await request(application().app).post(`${releaseBase}/release-scopes/missing-native-scope/requests`).set('Authorization',authHeader(f.actor)).send({});
    expect(missing.status,diagnostic(missing.body)).toBe(404);expect(missing.body.error.message).toBe('范围不存在');expect(await facts(f)).toEqual(before);
  });
  it('RP-real-neutral-facts actual line drift keeps the native fact reason, not a generic500 or promoted current scope',async()=>{
    const f=await pending('neutral-facts'),actor=await releaseGrant(f);
    await db().orderLine.update({where:{id:f.lineId},data:{unit:'pc'}});const before=await facts(f);
    const r=await request(application().app).get(`${releaseBase}/release-requests/${f.rr.id}/action-context`).set('Authorization',authHeader(actor));
    expect(r.status,diagnostic(r.body)).toBe(200);expect(r.body.item.scope.classification).toBe('historical');expect(r.body.item.canSign).toBe(false);
    expect(r.body.item.blockedReasons).toContain('批次与当前订单行来源、规格、工厂或单位不一致。');
    const sign=await signed(f,f.rr,actor);expect(sign.status,diagnostic(sign.body)).toBe(409);expect(sign.body.error.message).toContain('批次与当前订单行来源、规格、工厂或单位不一致。');expect(await facts(f)).toEqual(before);
  });
  it('RP-current-L2-storage actual L2 account re-read failure preserves native OrderLineWrite503 and zero-write',async()=>{
    const f=await commandFixture('request'),before=await facts(f);let hits=0;
    const app=application(intercepted('userAccount','findUnique',()=>{hits++;throw fault('fake');}));
    const r=await runCommand('request',f,app);expect(hits).toBe(1);
    expect(r.status,diagnostic(r.body)).toBe(503);expect(r.body.error).toEqual({code:'AUTHORIZATION_UNAVAILABLE',status:503,message:'暂时无法核验订单可操作范围，请稍后重试。'});
    expect(diagnostic(r.body)).not.toMatch(/SQL|private_release|P2003/);expect(await facts(f)).toEqual(before);
  });
  for(const pg of ['P2034','P2010'])it(`RP-${pg} recognized transaction serialization conflict keeps fixed409 without SQL`,async()=>{
    const f=await commandFixture('request'),before=await facts(f);
    const error=pg==='P2034'?Object.assign(new Error(privateSql),{code:pg}):new Prisma.PrismaClientKnownRequestError(privateSql,{code:pg,clientVersion:'private-test',meta:{code:'40001'}});
    let hits=0;const r=await runCommand('request',f,application(intercepted('releaseRequest','create',()=>{hits++;throw error;})));
    expect(hits).toBe(1);expect(r.status,diagnostic(r.body)).toBe(409);expect(r.body.error).toEqual({code:'CONFLICT',status:409,message:'放行范围或来源正在变化，请保留原请求并刷新重试'});expect(await facts(f)).toEqual(before);
  });
});
