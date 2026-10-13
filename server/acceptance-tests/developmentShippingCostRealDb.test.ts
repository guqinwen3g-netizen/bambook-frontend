/** Opt-in real PG + actual authenticated development routes. No seed/index/scheduler.
 * Synthetic current actor/customer/supplier are master inputs, not approval/cost facts.
 * DSC01 uses existing independent private evidence upload; this slice does NOT
 * add an upload command ack, payment or customer-charge fact. DSC09 deliberately
 * exercises a historical producer-shaped send (real rows/audit), not live migration proof.
 * All sources/ack checks use current native send events and mandatory audits. */
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
import { readDevelopmentExpenseSnapshot } from '../src/development/developmentExpenseSnapshot';
import { writeRouteAuditLog } from '../src/audit/routeAudit';
import { PRIVATE_FILES_DIR } from '../src/lib/privateFiles';

const prefix = `acceptance-development-shipping-cost-${randomUUID()}`;
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
  expect(process.env.BAMBOOK_PRIVATE_FILES_DIR).toBe(path.join(realpathSync(sandbox), 'private-files'));
  expect(realpathSync(PRIVATE_FILES_DIR)).toBe(realpathSync(process.env.BAMBOOK_PRIVATE_FILES_DIR!));
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
  for (const [relationId, category] of [[customerId, 'customer'], [supplierId, 'supplier']]) await db().relation.create({ data: { id: relationId, name: relationId, category, type: 'company', isOrganization: true, ownerId: actorId, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()) } });
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

async function getSources(f: Fixture, token=f.token) {
  return request(app()).get(`/api/v1/development/${f.caseId}/shipping-cost-sources`).query({batchId:f.batchId}).set('Authorization',`Bearer ${token}`);
}
async function source(f: Fixture, round=1) {
  const response=await getSources(f); expect(response.status,JSON.stringify(response.body)).toBe(200);
  const row=response.body.sources.find((item:any)=>item.round===round); expect(row).toBeTruthy();
  expect(row.nativeAuditId).toBeTruthy(); expect(row.fingerprint).toMatch(/^[a-f0-9]{64}$/); return row;
}
async function costInput(f:Fixture, round=1) {
  const row=await source(f,round);
  return {requestKey:randomUUID(),sourceType:'SampleBatch',sourceId:f.batchId,costType:'shipping',amount:'46.7501',currency:'USD',incurredAt:'2026-10-02',notes:'Synthetic acceptance bill USD46.7501, not a payment',shippingSource:{kind:row.kind,id:row.id,round:row.round,fingerprint:row.fingerprint}};
}
const register=(f:Fixture,body:object,client?:PrismaClient)=>f.post(`/${f.caseId}/costs`,body,client);
async function state(f:Fixture) {
  return {batch:await batch(f),costs:await db().costRecord.findMany({where:{OR:[{sourceType:'SampleBatch',sourceId:f.batchId},{sourceType:'DevelopmentCase',sourceId:f.caseId}]},orderBy:{id:'asc'}}),
    audits:await db().auditLog.findMany({where:{actorId:f.actorId},orderBy:{id:'asc'}}),numbers:await db().businessSequence.findMany({where:{prefix:'CR'},orderBy:{id:'asc'}})};
}
async function secondRound(f:Fixture) {
  expect((await stage(f,'revise',{feedback:'Native S2 requested; preserve S1 send'})).response.status).toBe(200);
  expect((await stage(f,'start')).response.status).toBe(200);
  expect((await batch(f)).round).toBe(2);
  expect((await stage(f,'send',{sentDate:'2026-10-02',courier:'DHL',trackingNumber:`${f.id}-S2`,shippingFee:46.75})).response.status).toBe(200);
}
function responseLost() {
  const observed={committed:0};
  const client=new Proxy(db(),{get(base,key){
    if(key==='$transaction')return async(work:any,options?:any)=>{const result=await base.$transaction(work,options);if(!observed.committed++){throw Error('Synthetic post-commit response read failed SQL_SECRET');}return result;};
    const value=Reflect.get(base,key);return typeof value==='function'?value.bind(base):value;
  }});return{client,observed};
}

describe('Native per-send development shipping expense registration',()=>{
  it('DSC01 actual send → explicit USD cost → private proof preserves round/audit/hash/exact amount and remains independent of payment',async()=>{
    const f=await fixture();await sent(f);
    expect(await db().costRecord.count({where:{sourceId:f.batchId}})).toBe(0);
    const originalSource=await source(f),body=await costInput(f),response=await register(f,body);
    expect(response.status,JSON.stringify(response.body)).toBe(200);const row=response.body.costRecord;
    expect(row.amount).toBe('46.7501');expect(row.bearerType).toBe('internal');expect(row.currency).toBe('USD');
    const saved=await db().costRecord.findUniqueOrThrow({where:{id:row.id}}),binding=saved.developmentShippingSource as any;
    const {costRecordIds:_ids,...originalFact}=originalSource;expect(binding.source).toEqual(originalFact);
    expect(row.commandAck).toMatchObject({caseId:f.caseId,actorId:f.actorId,requestKey:body.requestKey,costRecordId:row.id,auditId:binding.registrationAuditId});
    const {requestKey:_key,...inputSnapshot}=body;expect(row.commandAck.inputSnapshot).toEqual(inputSnapshot);
    expect(row.commandAck.requestFingerprint).toBe(saved.registrationFingerprint);
    const audit=await db().auditLog.findUniqueOrThrow({where:{id:binding.registrationAuditId}});
    expect(audit.actorId).toBe(f.actorId);expect(audit.action).toBe('register_development_shipping_cost');expect((audit.detail as any).after.amount).toBe('46.7501');expect((audit.detail as any).after.shippingSource).toEqual(originalFact);
    expect((await source(f)).costRecordIds).toEqual([row.id]);
    const bytes=Buffer.from('%PDF-1.4\nSynthetic acceptance carrier bill USD46.7501\n%%EOF');
    const proof=await request(app()).post(`/api/v1/development/${f.caseId}/costs/${row.id}/evidence`).set('Authorization',`Bearer ${f.token}`).field('requestKey',randomUUID()).field('note','Synthetic proof, not payment').attach('file',bytes,{filename:'synthetic-carrier-bill.pdf',contentType:'application/pdf'});
    expect(proof.status,JSON.stringify(proof.body)).toBe(200);expect(proof.body.evidence.costRecordId).toBe(row.id);expect(proof.body.evidence.storageKey).toBeUndefined();
    const download=await request(app()).get(`/api/v1/development/${f.caseId}/costs/${row.id}/evidence/${proof.body.evidence.id}/download`).set('Authorization',`Bearer ${f.token}`);
    expect(download.status).toBe(200);expect(Buffer.from(download.body)).toEqual(bytes);
    const snapshot=await readDevelopmentExpenseSnapshot(db(),f.caseId);expect(snapshot.totals).toEqual([{currency:'USD',amount:'46.7501'}]);expect(snapshot.records[0].developmentShippingSource).toEqual(binding);
    expect(await db().billingItem.count({where:{sourceType:'SampleBatch',sourceId:f.batchId}})).toBe(0);expect(await db().paymentVoucher.count({where:{customerRelationId:f.customerId}})).toBe(0); // Registration did not establish payment.
  });
  it('DSC02 S2 native send preserves S1 source and permits later S1 expense; original cost replay does not move to S2',async()=>{
    const f=await fixture();await sent(f);const s1=await source(f),body=await costInput(f);await secondRound(f);
    const response=await register(f,body);expect(response.status).toBe(200);expect(response.body.costRecord.developmentShippingSource.source.round).toBe(1);
    const sources=(await getSources(f)).body.sources;expect(sources.map((item:any)=>item.round)).toEqual([1,2]);expect(sources.find((item:any)=>item.round===1).fingerprint).toBe(s1.fingerprint);
    const before=await state(f),replay=await register(f,body);expect(replay.status).toBe(200);expect(replay.body.costRecord.commandAck).toEqual(response.body.costRecord.commandAck);expect(await state(f)).toEqual(before);
    const s2=await costInput(f,2);expect((await register(f,s2)).status).toBe(200);expect((await source(f,2)).costRecordIds).toHaveLength(1);expect((await source(f,1)).costRecordIds).toEqual([response.body.costRecord.id]);
    expect((await batch(f)).shippingFee).toBe(46.75);expect((await batch(f)).attachments&&(await batch(f)).round).toBe(2);
  });
  it('DSC03 original actor/key immutable replay rejects changed amount/currency/source; generic existing cost API retains its original shape',async()=>{
    const f=await fixture();await sent(f);const body=await costInput(f),parallel=await Promise.all([register(f,body),register(f,body)]);expect(parallel.map(row=>row.status)).toEqual([200,200]);expect(parallel[0].body.costRecord.id).toBe(parallel[1].body.costRecord.id);const before=await state(f);expect(before.costs).toHaveLength(1);
    for(const changed of [{amount:'99'},{currency:'CNY'}]){const response=await register(f,{...body,...changed});expect(response.status).toBe(409);expect(response.body.error.code).toBe('REQUEST_CONFLICT');expect(await state(f)).toEqual(before);}
    const generic={requestKey:randomUUID(),sourceType:'DevelopmentCase',sourceId:f.caseId,costType:'sample_making',amount:'20',currency:'CNY',incurredAt:'2026-10-02'};
    const original=await register(f,generic);expect(original.status).toBe(200);expect(original.body.costRecord.developmentShippingSource).toBeNull();expect(original.body.costRecord.commandAck.requestKey).toBe(generic.requestKey);
    const replay=await register(f,generic);expect(replay.body.costRecord.commandAck).toEqual(original.body.costRecord.commandAck);expect(replay.body.costRecord.id).toBe(original.body.costRecord.id);
  });
  it('DSC04 wrong parent/round/hash and modern-event legacy alias refuse before any cost/audit/number writes',async()=>{
    const f=await fixture(),other=await fixture();await sent(f);await sent(other);const body=await costInput(f),before=await state(f),otherSource=(await costInput(other)).shippingSource;
    for(const shippingSource of [{...body.shippingSource,round:2},{...body.shippingSource,fingerprint:'a'.repeat(64)},{...body.shippingSource,kind:'legacy-send-audit',id:(await source(f)).nativeAuditId},otherSource]){
      const response=await register(f,{...body,requestKey:randomUUID(),shippingSource});expect(response.status).toBe(409);expect(response.body.error.code).toBe('DEVELOPMENT_SOURCE_CHANGED');expect(await state(f)).toEqual(before);
    }
    const cross=await register(f,{...body,sourceId:other.batchId,requestKey:randomUUID(),shippingSource:otherSource});expect(cross.status).toBe(400);expect(cross.body.error.code).toBe('DEVELOPMENT_SHIPPING_SOURCE_INVALID');expect(await state(f)).toEqual(before);
  });
  it('DSC05 explicit currency/amount required; explicit zero and maximum Decimal(18,4) preserve exact value and do not borrow raw shipping fee',async()=>{
    const f=await fixture();await sent(f);const body=await costInput(f),before=await state(f);
    for(const changed of [{currency:''},{currency:'EUR'},{amount:''},{amount:'unknown'},{amount:'-1'}]){const response=await register(f,{...body,...changed,requestKey:randomUUID()});expect(response.status).toBe(400);expect(await state(f)).toEqual(before);}
    for(const amount of ['0','99999999999999.9999']){const response=await register(f,{...body,amount,requestKey:randomUUID()});expect(response.status,JSON.stringify(response.body)).toBe(200);const saved=await db().costRecord.findUniqueOrThrow({where:{id:response.body.costRecord.id}});expect(saved.amount.toFixed(4)).toBe(amount==='0'?'0.0000':amount);const audit=await db().auditLog.findUniqueOrThrow({where:{id:response.body.costRecord.commandAck.auditId}});expect((audit.detail as any).after.amount).toBe(saved.amount.toFixed(4));}
  });
  it('DSC06 current DB revocation, signed empty ceiling and hidden customer refuse read and original replay without altering persisted expense',async()=>{
    const f=await fixture();await sent(f);const body=await costInput(f);expect((await register(f,body)).status).toBe(200);const before=await state(f);
    const limited=createAuthService().signToken({...f.actor,permissionCeiling:[]});expect((await getSources(f,limited)).status).toBe(403);
    expect((await request(app()).post(`/api/v1/development/${f.caseId}/costs`).set('Authorization',`Bearer ${limited}`).send(body)).status).toBe(403);
    await db().userPermissionOverrides.updateMany({where:{userId:f.actorId},data:{isActive:false}});expect((await getSources(f)).status).toBe(403);expect((await register(f,body)).status).toBe(403);expect(await state(f)).toEqual(before);
    await db().userPermissionOverrides.updateMany({where:{userId:f.actorId},data:{isActive:true}});
    const otherId=`${f.id}-other`;await db().userAccount.create({data:{id:otherId,displayName:'Other source owner',status:'active'}});await db().relation.update({where:{id:f.customerId},data:{ownerId:otherId}});
    expect((await getSources(f)).status).toBe(404);expect((await register(f,body)).status).toBe(404);expect(await state(f)).toEqual(before);
  });
  it('DSC07 real mandatory binding audit FK fault rolls back CostRecord/original audit/number; HTTP unknown error is safe',async()=>{
    const f=await fixture();await sent(f);const body=await costInput(f),before=await state(f),fault=auditSqlFault(f.actorId,'register_development_shipping_cost');
    const response=await register(f,body,fault.client);expect(response.status).toBe(500);expect(response.body.error.message).not.toMatch(/P2003|SQL|Foreign key|actorId|AuditLog/i);expect(fault.observed).toEqual({count:1,code:'P2003'});expect(await state(f)).toEqual(before);
    expect((await register(f,body)).status).toBe(200);
  });
  it('DSC08 committed-but-response-lost remains a real expense; original stable command returns exact ack without second creation',async()=>{
    const f=await fixture();await sent(f);const body=await costInput(f),lost=responseLost();const failed=await register(f,body,lost.client);
    expect(failed.status).toBe(500);expect(failed.body.error.message).not.toMatch(/SQL_SECRET|回滚/);expect(lost.observed.committed).toBe(1);const committed=await state(f);expect(committed.costs).toHaveLength(1);
    const replay=await register(f,body);expect(replay.status).toBe(200);expect(replay.body.costRecord.id).toBe(committed.costs[0].id);expect(replay.body.costRecord.commandAck.requestKey).toBe(body.requestKey);expect(await state(f)).toEqual(committed);
  });
  it('DSC09 historical producer-shaped real send/audit can be explicitly bound; it never fabricates amount/currency from the old record',async()=>{
    const f=await fixture();expect((await stage(f,'start')).response.status).toBe(200);const prior=await batch(f);
    // Old producer storage shape, deliberately distinct from actual current HTTP send.
    // Real PG + actual mandatory audit verifies legacy parsing only; populated upgrade is Root UI06.
    const nativeAuditId=await db().$transaction(async tx=>{await tx.sampleBatch.update({where:{id:f.batchId},data:{status:'sent',shippingFee:45.5}});return writeRouteAuditLog({prisma:tx,actorId:f.actorId,source:'route:dev:fabric-batch',operation:'advance_sample_batch',targetType:'SampleBatch',targetId:f.batchId,before:{batchCode:prior.batchCode,status:'making',round:1},after:{batchCode:prior.batchCode,status:'sent',round:1,action:'send'}});});
    const legacy=await source(f);expect(legacy.kind).toBe('legacy-send-audit');expect(legacy.id).toBe(nativeAuditId);expect(legacy.sourceSnapshot.historicalAmountCurrencyUnknown).toBe(true);expect(legacy.sourceSnapshot.after.shippingFee).toBeUndefined();
    const body=await costInput(f),response=await register(f,body);expect(response.status).toBe(200);expect(response.body.costRecord.amount).toBe('46.7501');expect(response.body.costRecord.currency).toBe('USD');expect(response.body.costRecord.developmentShippingSource.source.nativeAuditId).toBe(nativeAuditId);
  });
});
