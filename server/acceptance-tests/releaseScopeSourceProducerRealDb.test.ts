/** DR-053 §13.5 + §14.2/14.3/14.7: quantity/unit-only native UI
 * must freeze the real locked OrderLine source/spec/factory. Native fabric
 * producers and version HTTP establish current source facts; no approval,
 * ReleaseScope or completed production fact is seeded. Separate PG wait
 * witnesses prove concurrent source/spec drift, rather than fake a lock.
 * Synthetic observations/current technical grants are not company UAT. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createReleaseRouter } from '../src/production/releaseRoute';
import { createReleaseScope } from '../src/production/releaseService';
import { createSampleBatch, advanceSampleBatchStage, createSealSample, sealSampleConfirm, convertToFabricAsset } from '../src/development/fabricDevelopmentService';

const prefix=`acceptance-release-source-${randomUUID()}`;
let prisma:PrismaClient|undefined, sequence=0;
const connections:PrismaClient[]=[];
const db=()=>{if(!prisma)throw Error('Private release source identity not verified');return prisma;};
const diagnostic=(value:unknown)=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?item.toString():item);
beforeAll(async()=>{
 const {DATABASE_URL,BAMBOOK_ACCEPTANCE_SANDBOX:sandbox,BAMBOOK_ACCEPTANCE_DB_NAME:name,BAMBOOK_ACCEPTANCE_DB_DIR:directory,BAMBOOK_ACCEPTANCE_DB_PORT:port}=process.env;
 if(!DATABASE_URL||!sandbox||!name||!directory||!port)throw Error('Reviewed independent PG required');
 const url=new URL(DATABASE_URL);expect(url.protocol).toBe('postgresql:');expect(url.hostname).toBe('127.0.0.1');
 expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);expect(url.pathname).toBe('/'+name);expect(url.port).toBe(port);
 expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox),'postgres'));
 expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');prisma=new PrismaClient({datasources:{db:{url:DATABASE_URL}}});
 expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`).toEqual([{name,directory,port:Number(port)}]);
 await db().role.upsert({where:{id:'manager'},update:{},create:{id:'manager',name:'Canonical synthetic leader',isSystem:true}});
});
afterAll(async()=>{await Promise.all(connections.map(c=>c.$disconnect()));await prisma?.$disconnect();});
async function fixture(label:string){
 const id=`${prefix}-${++sequence}-${label}`,now=BigInt(Date.now()),userId=id+'-actor',customerId=id+'-customer',supplierId=id+'-factory',caseId=id+'-case',orderId=id+'-order',lineId=id+'-line';
 await db().userAccount.create({data:{id:userId,displayName:'Synthetic actual current manager',status:'active'}});
 await db().userRole.create({data:{id:id+'-membership',userId,roleId:'manager'}});
 for(const scope of ['orders:read','orders:write','products:read','products:write','production:read','production:pp_release:business_sign'])await db().userPermissionOverrides.create({data:{id:id+'-'+scope,userId,scope,isActive:true,grantedBy:userId,reason:'Exact private fixture grant, not company policy'}});
 for(const [relationId,category] of [[customerId,'Customer'],[supplierId,'Supplier'],[id+'-other-factory','Supplier']])await db().relation.create({data:{id:relationId,name:relationId,category,type:'Company',isOrganization:true,ownerId:userId,salesRepIds:[],tags:[],contactInfo:'{}',lastInteraction:now}});
 await db().developmentCase.create({data:{id:caseId,code:caseId,name:'Synthetic current source',type:'fabric',stage:'developing',owner:userId,customerRelationId:customerId,customerName:customerId,tags:[],createdAt:now,updatedAt:now}});
 await db().order.create({data:{id:orderId,poNumber:orderId,customer:customerId,customerRelationId:customerId,product:'Synthetic fabric',type:'fabric',quantity:10,status:'Pending',dueDate:'2099-01-01',quoteAmount:10,ownerId:userId,millRelationId:supplierId,sourceCaseId:caseId,importedAt:now,updatedAt:now}});
 await db().orderLine.create({data:{id:lineId,orderId,lineNumber:1,itemNo:'0010',quantity:'10',unit:'m',description:'Actual source freeze'}});
 const actor=await buildLoadedAuthTokenPayload(db(),await loadUserWithRoles(db(),userId));expect(actor.authorizationLoaded).toBe(true);
 return {id,userId,customerId,supplierId,caseId,orderId,lineId,actor,token:createAuthService().signToken(actor),sealId:'',assetId:''};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function application(database:PrismaClient=db()){
 const app=express(),changes:any[]=[];app.use(express.json());app.set('json replacer',(_key:string,value:any)=>typeof value==='bigint'?value.toString():value);
 app.use(createAccountStatusGuard(db()));app.use('/api',createAuthorizationSnapshotGuard({prisma:db(),apiKeys:new Set()}));
 app.use('/api/v1/order-lines',createOrderLinesRouter({prisma:database,requireAuth:true,apiKeys:new Set()}));
 app.use('/api/v1/releases',createReleaseRouter({prisma:database,requireAuth:true,apiKeys:new Set(),onDataChange:event=>changes.push(event)}));
 return {app,changes};
}
async function nativeSource(f:Fixture){
 const made=await createSampleBatch({prisma:db(),caseId:f.caseId,actorId:f.userId,input:{sampleType:'yardage',supplierRelationId:f.supplierId}});expect(made.ok,diagnostic(made)).toBe(true);const batchId=(made as any).data.batch.id;
 for(const action of ['start','send','approve'] as const){const batch=await db().sampleBatch.findUniqueOrThrow({where:{id:batchId}});const result=await advanceSampleBatchStage({prisma:db(),batchId,actorId:f.userId,trustedActor:f.actor,action,input:{requestKey:randomUUID(),expectedRound:batch.round,expectedRevision:(batch.attachments as any)?.fabricHistory?.revision??0,feedback:action==='approve'?'Synthetic explicitly recorded customer recognition':undefined}});expect(result.ok,diagnostic(result)).toBe(true);}
 const created=await createSealSample({prisma:db(),caseId:f.caseId,actorId:f.userId,input:{batchIds:[batchId],name:'Synthetic native standard'}});expect(created.ok,diagnostic(created)).toBe(true);f.sealId=(created as any).data.seal.id;
 const sealed=await sealSampleConfirm({prisma:db(),sealId:f.sealId,actorId:f.userId,trustedActor:f.actor});expect(sealed.ok,diagnostic(sealed)).toBe(true);
 const converted=await convertToFabricAsset({prisma:db(),caseId:f.caseId,sourceType:'seal',sourceId:f.sealId,actorId:f.userId,trustedActor:f.actor});expect(converted.ok,diagnostic(converted)).toBe(true);f.assetId=(converted as any).data.asset.id;
 const selected=await request(application().app).patch(`/api/v1/order-lines/${f.lineId}/version`).set('Authorization','Bearer '+f.token).send({confirmedSourceType:'SealSample',confirmedSourceId:f.sealId,millRelationId:f.supplierId});expect(selected.status,diagnostic(selected.body)).toBe(200);
 const actual=await db().orderLine.findUniqueOrThrow({where:{id:f.lineId}});expect(actual.confirmedSourceId).toBe(f.sealId);expect(actual.specSnapshot).not.toBeNull();
 expect(await db().auditLog.count({where:{action:'convert_fabric_to_asset',targetId:f.assetId}})).toBe(1);return f;
}
const body={quantity:10,unit:'m'};
const create=(f:Fixture,input:Record<string,unknown>=body,app=application())=>request(app.app).post(`/api/v1/releases/orders/${f.orderId}/lines/${f.lineId}/release-scopes`).set('Authorization','Bearer '+f.token).send(input);
async function snapshot(f:Fixture){return {line:await db().orderLine.findUniqueOrThrow({where:{id:f.lineId}}),scopes:await db().releaseScope.findMany({where:{orderId:f.orderId},orderBy:{id:'asc'}}),requests:await db().releaseRequest.findMany({where:{scopeId:{in:(await db().releaseScope.findMany({where:{orderId:f.orderId},select:{id:true}})).map(s=>s.id)}},orderBy:{id:'asc'}}),audits:await db().auditLog.findMany({where:{actorId:f.userId,targetType:'ReleaseScope'},orderBy:{id:'asc'}})};}
async function rejected(f:Fixture,input:Record<string,unknown>){const before=await snapshot(f),app=application(),r=await create(f,input,app);expect(r.status,diagnostic(r.body)).toBe(409);expect(await snapshot(f)).toEqual(before);expect(app.changes).toEqual([]);}
async function sign(f:Fixture,scopeId:string,app=application()){
 const asked=await request(app.app).post(`/api/v1/releases/release-scopes/${scopeId}/requests`).set('Authorization','Bearer '+f.token).send({});expect(asked.status,diagnostic(asked.body)).toBe(201);
 const signed=await request(app.app).post(`/api/v1/releases/release-requests/${asked.body.request.id}/signatures`).set('Authorization','Bearer '+f.token).send({role:'business'});expect(signed.status,diagnostic(signed.body)).toBe(200);
 const released=await db().ppSampleRelease.findUniqueOrThrow({where:{id:signed.body.release.id}});expect(released.approvedBy).toBe(f.userId);expect(released.signedByBusiness).toBe(f.userId);
 const eligibility=await request(app.app).get(`/api/v1/releases/release-scopes/${scopeId}/eligibility`).set('Authorization','Bearer '+f.token);expect(eligibility.status,diagnostic(eligibility.body)).toBe(200);expect(eligibility.body.eligible).toBe(true);
 const signature=await db().releaseSignature.findUniqueOrThrow({where:{requestId_role:{requestId:asked.body.request.id,role:'business'}}});expect(signature.actorId).toBe(f.userId);
 const event=await db().releaseEvent.findFirstOrThrow({where:{scopeId,kind:'granted',releaseId:released.id}});expect(event.actorId).toBe(f.userId);
}
function signal(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function connection(){const value=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL!}}});connections.push(value);const [identity]=await value.$queryRawUnsafe<any[]>('SELECT current_database() AS name,current_setting(\'data_directory\') AS directory,inet_server_port() AS port');expect(identity).toEqual({name:process.env.BAMBOOK_ACCEPTANCE_DB_NAME,directory:process.env.BAMBOOK_ACCEPTANCE_DB_DIR,port:Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT)});return value;}
async function driftAfterActualWait(f:Fixture,patch:Prisma.OrderLineUncheckedUpdateInput){
 const blocker=await connection(),writer=await connection(),held=signal(),release=signal();let blockerPid=0,writerPid=0,ended=false;
 const blocking=blocker.$transaction(async tx=>{const [identity]=await tx.$queryRawUnsafe<any[]>('SELECT pg_backend_pid() AS pid');blockerPid=identity.pid;await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${f.orderId} FOR UPDATE`;held.resolve();await release.promise;await tx.orderLine.update({where:{id:f.lineId},data:patch});},{timeout:20000,maxWait:10000});await held.promise;
 const measured=new Proxy(writer,{get(base,key){if(key==='$transaction')return (work:any,options?:any)=>base.$transaction(async tx=>{const [identity]=await tx.$queryRawUnsafe<any[]>('SELECT pg_backend_pid() AS pid');writerPid=identity.pid;return work(tx);},{...options,timeout:20000,maxWait:10000});const value=Reflect.get(base,key);return typeof value==='function'?value.bind(base):value;}}) as PrismaClient;
 const writing=createReleaseScope({prisma:measured,orderId:f.orderId,orderLineId:f.lineId,actorId:f.userId,input:body}).then(value=>{ended=true;return value;});
 try{
  let witnessed=false;
  for(let n=0;n<200;n++){if(ended)throw Error('Writer completed before real Order lock wait');if(writerPid){const [actual]=await db().$queryRawUnsafe<any[]>('SELECT pg_blocking_pids($1::integer) AS blockers',writerPid);if(actual.blockers.includes(blockerPid)){witnessed=true;break;}}await new Promise(done=>setTimeout(done,20));}
  expect(witnessed,'Actual pg_blocking_pids Order wait is mandatory').toBe(true);release.resolve();await blocking;const result=await writing;expect(result.ok,diagnostic(result)).toBe(false);expect((result as any).error).toMatchObject({code:'CONFLICT',status:409});
  expect(await db().releaseScope.count({where:{orderId:f.orderId}})).toBe(0);expect(await db().auditLog.count({where:{actorId:f.userId,targetType:'ReleaseScope'}})).toBe(0);
 }finally{release.resolve();await Promise.allSettled([blocking,writing]);}
}
describe.sequential('native release scope producer locks and freezes real current source',()=>{
 it('RSP01 native quantity/unit-only UI freezes actual Seal/spec/factory, then actual leader can sign',async()=>{const f=await nativeSource(await fixture('ui-positive')),before=await snapshot(f),app=application(),r=await create(f,body,app);expect(r.status,diagnostic(r.body)).toBe(201);const actual=await db().releaseScope.findUniqueOrThrow({where:{id:r.body.scope.id}});expect(actual).toMatchObject({confirmedSourceType:'SealSample',confirmedSourceId:f.sealId,factoryRelationId:f.supplierId,specSnapshot:before.line.specSnapshot,unit:'m'});expect(actual.quantity.toString()).toBe('10');expect((await snapshot(f)).line).toEqual(before.line);expect((await snapshot(f)).audits).toHaveLength(1);await sign(f,actual.id,app);});
 it('RSP02 existing explicit matching source/spec/factory remains a legal positive control',async()=>{const f=await nativeSource(await fixture('explicit')),line=await db().orderLine.findUniqueOrThrow({where:{id:f.lineId}}),r=await create(f,{...body,confirmedSourceType:'SealSample',confirmedSourceId:f.sealId,factoryRelationId:f.supplierId,specSnapshot:line.specSnapshot});expect(r.status,diagnostic(r.body)).toBe(201);await sign(f,r.body.scope.id);});
 it('RSP03 valid but different real Asset body cannot override actual line Seal identity',async()=>{const f=await nativeSource(await fixture('wrong-source'));await rejected(f,{...body,confirmedSourceType:'Asset',confirmedSourceId:f.assetId});});
 it('RSP04 another actual factory cannot overwrite the source factory',async()=>{const f=await nativeSource(await fixture('wrong-factory'));await rejected(f,{...body,factoryRelationId:f.id+'-other-factory'});});
 it('RSP05 a body specSnapshot cannot replace the immutable current line specification',async()=>{const f=await nativeSource(await fixture('wrong-spec'));await rejected(f,{...body,specSnapshot:{syntheticWrongWidth:'999'}});});
 it('RSP06 explicit null clearing is not absence when a real source is bound',async()=>{const f=await nativeSource(await fixture('clear-source'));await rejected(f,{...body,confirmedSourceType:null,confirmedSourceId:null});});
 it('RSP07 recorded source-less historical line keeps both-null compatibility and legitimate sign',async()=>{const f=await fixture('legacy-empty'),r=await create(f);expect(r.status,diagnostic(r.body)).toBe(201);const actual=await db().releaseScope.findUniqueOrThrow({where:{id:r.body.scope.id}});expect(actual.confirmedSourceType).toBeNull();expect(actual.confirmedSourceId).toBeNull();expect(actual.specSnapshot).toBeNull();await sign(f,actual.id);});
 it('RSP08 actual unique native SKU fallback freezes the Asset identity, never product description',async()=>{const f=await nativeSource(await fixture('sku-fallback')),asset=await db().productAsset.findUniqueOrThrow({where:{id:f.assetId}});await db().orderLine.update({where:{id:f.lineId},data:{confirmedSourceType:null,confirmedSourceId:null,materialCode:asset.sku}});const line=await db().orderLine.findUniqueOrThrow({where:{id:f.lineId}}),r=await create(f);expect(r.status,diagnostic(r.body)).toBe(201);expect(await db().releaseScope.findUniqueOrThrow({where:{id:r.body.scope.id}})).toMatchObject({confirmedSourceType:'Asset',confirmedSourceId:f.assetId,factoryRelationId:f.supplierId,specSnapshot:line.specSnapshot});await sign(f,r.body.scope.id);});
 it('RSP09 real source changed after actual Order wait conflicts without a stale scope',async()=>{const f=await nativeSource(await fixture('source-drift'));await driftAfterActualWait(f,{confirmedSourceType:'Asset',confirmedSourceId:f.assetId});});
 it.each(['spec','quantity','unit'] as const)('RSP10-%s real line contract changed after actual Order wait conflicts without writing',async kind=>{const f=await nativeSource(await fixture('contract-drift-'+kind));const patch=kind==='spec'?{specSnapshot:{syntheticCommittedWidth:'160'}}:kind==='quantity'?{quantity:'8'}:{unit:'YD'};await driftAfterActualWait(f,patch);});
 it('RSP11 actual mandatory audit FK failure rolls back scope and sends no success event',async()=>{const f=await nativeSource(await fixture('audit-failure')),before=await snapshot(f);let failedSqlAttempted=false;const database=new Proxy(db(),{get(base,key){if(key==='$transaction')return (work:any,options?:any)=>base.$transaction(async tx=>{const wrapped=new Proxy(tx,{get(current,model){if(model==='auditLog')return new Proxy(current.auditLog,{get(delegate,method){if(method==='create')return (arg:any)=>{failedSqlAttempted=true;return delegate.create({...arg,data:{...arg.data,actorId:f.id+'-missing-audit-actor'}});};const value=Reflect.get(delegate,method);return typeof value==='function'?value.bind(delegate):value;}});const value=Reflect.get(current,model);return typeof value==='function'?value.bind(current):value;}});return work(wrapped);},options);const value=Reflect.get(base,key);return typeof value==='function'?value.bind(base):value;}}) as PrismaClient;const app=application(database),r=await create(f,body,app);expect(failedSqlAttempted).toBe(true);expect(r.status,diagnostic(r.body)).toBe(500);expect(r.body.error.message).not.toMatch(/P2003|Foreign key|constraint|missing-audit-actor/);expect(await snapshot(f)).toEqual(before);expect(app.changes).toEqual([]);});
 it('RSP12 actual soft-deleted source case cannot produce a new release scope; original native source/audit stay',async()=>{const f=await nativeSource(await fixture('source-case-deleted')),seal=await db().sealSample.findUniqueOrThrow({where:{id:f.sealId}}),sourceAudits=await db().auditLog.findMany({where:{targetId:f.assetId},orderBy:{id:'asc'}});await db().developmentCase.update({where:{id:f.caseId},data:{deletedAt:BigInt(Date.now())}});await rejected(f,body);expect(await db().sealSample.findUniqueOrThrow({where:{id:f.sealId}})).toEqual(seal);expect(await db().auditLog.findMany({where:{targetId:f.assetId},orderBy:{id:'asc'}})).toEqual(sourceAudits);});
});
