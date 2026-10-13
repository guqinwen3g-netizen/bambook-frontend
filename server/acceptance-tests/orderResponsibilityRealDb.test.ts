/** Private native PG only. Legacy null-responsibility rows are explicitly owned
 * synthetic ORM fixtures; no approval/finance/stock facts are invented or reseeded.
 * Actual HTTP/auth, current grants/L2, row locks, CAS, original audit writes and
 * rollback run unchanged. Not browser/UAT or global role/grant phantom proof. */
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../src/auth/tokenHelpers';

const prefix='native-responsibility-'+randomUUID(), auth=createAuthService();
let one:PrismaClient,two:PrismaClient,sequence=0;
beforeAll(async()=>{
  const {DATABASE_URL: url,BAMBOOK_ACCEPTANCE_SANDBOX:sandbox,BAMBOOK_ACCEPTANCE_DB_NAME:name,
    BAMBOOK_ACCEPTANCE_DB_DIR:directory,BAMBOOK_ACCEPTANCE_DB_PORT:port}=process.env;
  if(!url||!sandbox||!name||!directory||!port)throw Error('Explicit private PG identity required');
  const parsed=new URL(url);expect(parsed.protocol).toBe('postgresql:');expect(parsed.hostname).toBe('127.0.0.1');
  expect(parsed.pathname).toBe('/'+name);expect(parsed.port).toBe(port);expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox),'postgres'));expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  one=new PrismaClient({datasources:{db:{url}}});two=new PrismaClient({datasources:{db:{url}}});
  for(const client of [one,two]){const rows=await client.$queryRaw<any[]>`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`;
    expect(rows).toEqual([{name,directory,port:Number(port)}]);}
});
afterAll(async()=>{await one?.$disconnect();await two?.$disconnect();});
function app(db:any){const a=express();a.use(express.json());a.use('/api',createAuthorizationSnapshotGuard({prisma:db}));
  a.use('/api/v2/orders',createOrdersV2Router({prisma:db,requireAuth:true,apiKeys:new Set()}));return a;}
async function fixture(label:string,unanchored=false){
  const id=prefix+'-'+(++sequence)+'-'+label,actorId=id+'-actor',targetId=id+'-target',headId=id+'-head',otherId=id+'-other',departmentId=id+'-dept',orderId=id+'-order',customerId=id+'-customer';
  await one.department.create({data:{id:departmentId,name:'Synthetic real responsibility department',status:'active',headId}});
  for(const userId of [actorId,targetId,headId,otherId])await one.userAccount.create({data:{id:userId,displayName:userId,status:'active',primaryDeptId:userId===targetId||userId===headId?departmentId:null}});
  for(const userId of [actorId,otherId])for(const scope of ['orders:read','orders:write'])await one.userPermissionOverrides.create({data:{id:userId+'-'+scope,
    userId,scope,grantedBy:actorId,reason:'Synthetic explicit current grant, no business approval facts'}});
  await one.relation.create({data:{id:customerId,name:'Synthetic controlled legacy customer',category:'Customer',type:'Company',isOrganization:true,
    tags:[],contactInfo:'{}',lastInteraction:BigInt(Date.now()),ownerId:actorId,salesRepIds:[]}});
  // This missing legacy responsibility is the subject of recovery; no SQL mutates another case.
  await one.order.create({data:{id:orderId,customer:'Synthetic controlled legacy customer',product:'Legacy garment with missing responsibility',type:'Garment',quantity:200,
    status:'InProduction',dueDate:'2099-12-01',quoteAmount:'1000.5432',updatedAt:BigInt(1),customerRelationId:unanchored?null:customerId,ownerId:unanchored?actorId:null,departmentId:null}});
  const principal=async(userId:string,ceiling?:string[])=>{const actor=await buildLoadedAuthTokenPayload(one,(await loadUserWithRoles(one,userId))!);
    if(ceiling!==undefined)actor.permissionCeiling=ceiling;return actor;};
  const actor=await principal(actorId),other=await principal(otherId),input={clientRequestId:randomUUID(),ownerId:targetId,departmentId,expectedUpdatedAt:'1',reason:'Actual controlled legacy responsibility assignment'};
  return {id,actorId,targetId,headId,otherId,departmentId,orderId,customerId,actor,other,input,principal};
}
function http(application:ReturnType<typeof app>,method:'get'|'patch'|'put'|'post',orderId:string,actor:TokenPayload,suffix='/responsibility'){
  return request(application)[method]('/api/v2/orders/'+orderId+suffix).set('Authorization','Bearer '+auth.signToken(actor));
}
async function facts(item:Awaited<ReturnType<typeof fixture>>){return{order:await one.order.findUniqueOrThrow({where:{id:item.orderId}}),
  audits:await one.auditLog.findMany({where:{targetId:item.orderId},orderBy:{id:'asc'}})};}
function intercepted(base:PrismaClient,hook:(tx:any,data:any)=>Promise<void>){return new Proxy(base,{get(target,key){
  if(key==='$transaction')return(callback:any)=>target.$transaction(async(tx:any)=>callback(new Proxy(tx,{get(t,k){
    if(k!=='auditLog')return Reflect.get(t,k);return new Proxy(t.auditLog,{get(delegate,method){
      if(method!=='create')return Reflect.get(delegate,method);return async(args:any)=>{const row=await delegate.create(args);await hook(tx,args.data);return row;};}});
  }})));const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}
function cancelBody(item:Awaited<ReturnType<typeof fixture>>,cancelReason:string){const input=item.input;
  const parameterHash=createHash('sha256').update(JSON.stringify({operation:'assign_order_responsibility',actorId:item.actorId,orderId:item.orderId,
    clientRequestId:input.clientRequestId,ownerId:input.ownerId,departmentId:input.departmentId,expectedUpdatedAt:input.expectedUpdatedAt,reason:input.reason})).digest('hex');
  return {...input,parameterHash,cancelReason};}
function latch(){let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve;});return{promise,open};}
async function blockedBy(pid:number,blocker:number){const until=Date.now()+2000;while(Date.now()<until){
  const rows=await one.$queryRaw<any[]>`SELECT pg_blocking_pids(${pid}::int) AS ids`;if(rows[0].ids.includes(blocker))return;
  await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Actual second PG transaction never blocked on first original Order lock');}

describe('native Order responsibility controlled continuation',()=>{
  it('RSP01 native ordinary writer assigns exact legacy responsibility, one audit per field plus persistent receipt, no other business facts',async()=>{
    const item=await fixture('save'),before=await facts(item),res=await http(app(one),'patch',item.orderId,item.actor).send({...item.input,actorId:item.otherId,roles:['owner']});
    expect(res.status).toBe(200);expect(res.body.receipt).toMatchObject({actorId:item.actorId,orderId:item.orderId,clientRequestId:item.input.clientRequestId,before:{ownerId:null,departmentId:null,updatedAt:'1'}});
    const after=await facts(item);expect(after.order.ownerId).toBe(item.targetId);expect(after.order.departmentId).toBe(item.departmentId);
    expect(after.order.quantity).toBe(before.order.quantity);expect(after.order.quoteAmount.toFixed(4)).toBe('1000.5432');expect(after.order.status).toBe(before.order.status);
    expect(after.audits.filter(x=>x.action==='update_order_responsibility').map(x=>x.fieldPath).sort()).toEqual(['departmentId','ownerId']);
    expect((after.audits.find(x=>x.action==='assign_order_responsibility')!.detail as any).after.receipt).toEqual(res.body.receipt);
    expect((await http(app(one),'get',item.orderId,item.actor)).body.responsibility.updatedAt).toBe(res.body.receipt.after.updatedAt);
  });
  it('RSP02 two true PG connections same key serialize on actual Order lock and replay exact one receipt; altered intent conflicts',async()=>{
    const item=await fixture('samekey'),inserted=latch(),release=latch();let firstPid=0,secondPid=0;
    const a=intercepted(one,async(tx,data)=>{if(data.action==='assign_order_responsibility'){
      firstPid=(await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;inserted.open();await release.promise;}});
    const second=new Proxy(two,{get(target,key){if(key==='$transaction')return(callback:any)=>target.$transaction(async(tx:any)=>{
      secondPid=(await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;return callback(tx);});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    const initial=http(app(a),'patch',item.orderId,item.actor).send(item.input).then(r=>r);await Promise.race([inserted.promise,initial.then(r=>{expect(r.status).toBe(200);})]);
    const retry=http(app(second),'patch',item.orderId,item.actor).send(item.input).then(r=>r);
    const until=Date.now()+1000;while(!secondPid&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
    try{expect(secondPid).not.toBe(firstPid);await blockedBy(secondPid,firstPid);}finally{release.open();}
    const responses=await Promise.all([initial,retry]);expect(responses.map(r=>r.status)).toEqual([200,200]);expect(responses[1].body.replayed).toBe(true);
    expect(responses[1].body.receipt).toEqual(responses[0].body.receipt);expect((await facts(item)).audits).toHaveLength(3);
    expect((await http(app(two),'patch',item.orderId,item.actor).send({...item.input,reason:'Altered intent'})).status).toBe(409);
  });
  it('RSP03 two independent keys on same old stamp produce one actual CAS assignment and one conflict',async()=>{
    const item=await fixture('differentkeys');const responses=await Promise.all([
      http(app(one),'patch',item.orderId,item.actor).send(item.input),
      http(app(two),'patch',item.orderId,item.actor).send({...item.input,clientRequestId:randomUUID()})]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);expect((await facts(item)).audits).toHaveLength(3);
  });
  it('RSP04 valid owner transfer can lose detail L2; only original actor recovers original immutable receipt after later responsibility change',async()=>{
    const item=await fixture('handover',true),res=await http(app(one),'patch',item.orderId,item.actor).send(item.input);expect(res.status).toBe(200);
    expect(res.body.callerCanRead).toBe(false);expect(res.body.callerCanWrite).toBe(false);expect(res.body.responsibility).toBeUndefined();
    expect((await http(app(one),'get',item.orderId,item.actor)).status).toBe(404);
    const recovered=await http(app(two),'get',item.orderId,item.actor,'/responsibility/receipts/'+item.input.clientRequestId);
    expect(recovered.status).toBe(200);expect(recovered.body.receipt).toEqual(res.body.receipt);expect(recovered.body.responsibility).toBeUndefined();
    expect((await http(app(two),'get',item.orderId,item.other,'/responsibility/receipts/'+item.input.clientRequestId)).status).toBe(404);
    for(const scope of ['orders:read','orders:write'])await one.userPermissionOverrides.create({data:{id:item.targetId+'-'+scope,userId:item.targetId,scope,grantedBy:item.actorId,reason:'Actual synthetic transfer recipient permissions'}});
    const recipient=await item.principal(item.targetId);
    const changed=await http(app(two),'patch',item.orderId,recipient).send({...item.input,clientRequestId:randomUUID(),ownerId:item.headId,expectedUpdatedAt:res.body.receipt.after.updatedAt});expect(changed.status).toBe(200);
    const replay=await http(app(two),'patch',item.orderId,item.actor).send(item.input);expect(replay.status).toBe(200);expect(replay.body.receipt).toEqual(res.body.receipt);
    expect((await facts(item)).audits).toHaveLength(5);
  });
  it('RSP05 post actual summary audit INSERT external connection grant withdrawal rolls Order and every audit back; no phantom grant claims',async()=>{
    const item=await fixture('lategrant');let inserted=false;
    const hooked=intercepted(one,async(_tx,data)=>{if(data.action==='assign_order_responsibility'){inserted=true;
      await two.userPermissionOverrides.update({where:{userId_scope:{userId:item.actorId,scope:'orders:write'}},data:{isActive:false}});}});
    const res=await http(app(hooked),'patch',item.orderId,item.actor).send(item.input);expect(inserted).toBe(true);expect(res.status).toBe(403);
    const after=await facts(item);expect(after.order.ownerId).toBeNull();expect(after.order.updatedAt).toBe(BigInt(1));expect(after.audits).toHaveLength(0);
    expect((await two.userPermissionOverrides.findUniqueOrThrow({where:{userId_scope:{userId:item.actorId,scope:'orders:write'}}})).isActive).toBe(false);
  });
  it('RSP06 late actual customer followership withdrawal is distinct from permitted explicit owner transfer and rolls all native writes back',async()=>{
    const item=await fixture('lateL2');const hooked=intercepted(one,async(_tx,data)=>{if(data.action==='assign_order_responsibility')
      await two.relation.update({where:{id:item.customerId},data:{ownerId:item.otherId}});});
    expect((await http(app(hooked),'patch',item.orderId,item.actor).send(item.input)).status).toBe(404);
    const after=await facts(item);expect(after.order.ownerId).toBeNull();expect(after.audits).toHaveLength(0);
  });
  it('RSP07 actual mandatory field audit INSERT then fault rolls all real rows back; same original intent retries once; damaged owned field audit refuses replay',async()=>{
    const item=await fixture('auditrollback');let fieldInsert=false;
    const hooked=intercepted(one,async(_tx,data)=>{if(data.fieldPath==='departmentId'){fieldInsert=true;throw Error('private SQL sensitive audit stack');}});
    const failed=await http(app(hooked),'patch',item.orderId,item.actor).send(item.input);expect(fieldInsert).toBe(true);expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('private SQL');expect((await facts(item)).audits).toHaveLength(0);expect((await facts(item)).order.ownerId).toBeNull();
    const saved=await http(app(one),'patch',item.orderId,item.actor).send(item.input);expect(saved.status).toBe(200);
    const original=(await facts(item)).audits.find(x=>x.fieldPath==='ownerId')!;await two.auditLog.delete({where:{id:original.id}});
    expect((await http(app(one),'patch',item.orderId,item.actor).send(item.input)).status).toBe(409);
    expect((await http(app(one),'get',item.orderId,item.actor,'/responsibility/receipts/'+item.input.clientRequestId)).status).toBe(409);
  });
  it('RSP08 actual inactive targets/mismatched departments/cap/body forgery and generic bypass deny, independent qc-only target role is not required',async()=>{
    const item=await fixture('targets');expect((await http(app(one),'put',item.orderId,item.actor,'').send({ownerId:'ghost'})).status).toBe(409);
    await two.userAccount.update({where:{id:item.targetId},data:{status:'disabled'}});
    expect((await http(app(one),'patch',item.orderId,item.actor).send(item.input)).status).toBe(409);
    await two.userAccount.update({where:{id:item.targetId},data:{status:'active'}});
    const emptyDept=item.id+'-empty';await one.department.create({data:{id:emptyDept,name:'Synthetic no-head',status:'active'}});
    for(const input of [{...item.input,ownerId:null,departmentId:emptyDept},{...item.input,departmentId:emptyDept}])
      expect((await http(app(one),'patch',item.orderId,item.actor).send(input)).status).toBe(409);
    const capped=await item.principal(item.actorId,[]);expect((await http(app(one),'patch',item.orderId,capped).send({...item.input,actorId:item.actorId,roles:['owner'],permissions:['*']})).status).toBe(403);
    expect((await http(app(one),'put',item.orderId,item.actor,'').send({ownerId:'ghost'})).status).toBe(409);
    expect((await facts(item)).audits).toHaveLength(0);expect((await http(app(one),'patch',item.orderId,item.actor).send(item.input)).status).toBe(200);
  });
  it('RSC02 true PG cancellation INSERT serializes a late original PATCH, preserves Order facts, and hides own cancellation from another actor',async()=>{
    const item=await fixture('cancelrace'),inserted=latch(),release=latch(),intent=cancelBody(item,'Explicitly cancel the unconfirmed original intention');let firstPid=0,secondPid=0;
    const a=intercepted(one,async(tx,data)=>{if(data.action==='cancel_order_responsibility'){
      firstPid=(await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;inserted.open();await release.promise;}});
    const second=new Proxy(two,{get(target,key){if(key==='$transaction')return(callback:any)=>target.$transaction(async(tx:any)=>{
      secondPid=(await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;return callback(tx);});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    const initial=http(app(a),'post',item.orderId,item.actor,'/responsibility/cancellations').send(intent).then(r=>r);
    await Promise.race([inserted.promise,initial.then(r=>{expect(r.status).toBe(200);})]);
    const late=http(app(second),'patch',item.orderId,item.actor).send(item.input).then(r=>r);
    const until=Date.now()+1000;while(!secondPid&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
    try{expect(secondPid).not.toBe(firstPid);await blockedBy(secondPid,firstPid);}finally{release.open();}
    const responses=await Promise.all([initial,late]);expect(responses.map(r=>r.status)).toEqual([200,409]);
    const cancelled=responses[0].body;expect(cancelled.outcome).toBe('cancelled');expect(cancelled.receipt).toMatchObject({operation:'cancel_order_responsibility',
      actorId:item.actorId,orderId:item.orderId,clientRequestId:item.input.clientRequestId,commandHash:intent.parameterHash,intent:item.input,cancelReason:intent.cancelReason});
    expect(cancelled.receipt.cancelledAt).toMatch(/^(0|[1-9][0-9]*)$/);
    const after=await facts(item);expect(after.order.ownerId).toBeNull();expect(after.order.departmentId).toBeNull();expect(after.order.updatedAt).toBe(BigInt(1));
    expect(after.order.quoteAmount.toFixed(4)).toBe('1000.5432');expect(after.audits).toHaveLength(1);expect(cancelled.receipt.auditIds).toEqual([after.audits[0].id]);
    const own=await http(app(two),'get',item.orderId,item.actor,'/responsibility/receipts/'+item.input.clientRequestId);expect(own.status).toBe(200);
    expect(own.body.outcome).toBe('cancelled');expect(own.body.receipt).toEqual(cancelled.receipt);expect(own.body.responsibility).toBeUndefined();
    const other=await http(app(two),'get',item.orderId,item.other,'/responsibility/receipts/'+item.input.clientRequestId);expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain(item.actorId);expect(JSON.stringify(other.body)).not.toContain(intent.cancelReason);
    const repeated=await http(app(two),'post',item.orderId,item.actor,'/responsibility/cancellations').send(intent);expect(repeated.status).toBe(200);expect(repeated.body.receipt).toEqual(cancelled.receipt);
    expect((await facts(item)).audits).toHaveLength(1);
    const next=await http(app(two),'patch',item.orderId,item.actor).send({...item.input,clientRequestId:randomUUID()});expect(next.status).toBe(200);
    expect((await facts(item)).audits).toHaveLength(4);
  });
  it('RSC03 actual committed receipt cannot be overwritten by cancellation, and surviving field audits cannot be falsely declared cancelled',async()=>{
    const item=await fixture('commitwins'),saved=await http(app(one),'patch',item.orderId,item.actor).send(item.input);expect(saved.status).toBe(200);
    const before=await facts(item),cancelled=await http(app(two),'post',item.orderId,item.actor,'/responsibility/cancellations').send(cancelBody(item,'Verify or cancel the original pending intention'));
    expect(cancelled.status).toBe(200);expect(cancelled.body.outcome).toBe('committed');expect(cancelled.body.receipt).toEqual(saved.body.receipt);
    const after=await facts(item);expect(after.order.ownerId).toBe(before.order.ownerId);expect(after.order.updatedAt).toBe(before.order.updatedAt);expect(after.audits).toEqual(before.audits);
    expect(after.audits.filter(x=>x.action==='cancel_order_responsibility')).toHaveLength(0);
    const read=await http(app(two),'get',item.orderId,item.actor,'/responsibility/receipts/'+item.input.clientRequestId);expect(read.status).toBe(200);
    expect(read.body.outcome).toBe('committed');expect(read.body.receipt).toEqual(saved.body.receipt);
    // Corruption is restricted to this test's own synthetic command summary.
    await two.auditLog.delete({where:{id:after.audits.find(x=>x.action==='assign_order_responsibility')!.id}});
    const refused=await http(app(two),'post',item.orderId,item.actor,'/responsibility/cancellations').send(cancelBody(item,'Verify or cancel the original pending intention'));
    expect(refused.status).toBe(409);const factsAfter=await facts(item);expect(factsAfter.order.updatedAt).toBe(before.order.updatedAt);
    expect(factsAfter.audits).toHaveLength(2);expect(factsAfter.audits.every(x=>x.action==='update_order_responsibility')).toBe(true);
  });

});
