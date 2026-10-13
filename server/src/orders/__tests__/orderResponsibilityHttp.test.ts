/** Actual OrdersV2 HTTP/auth/service callbacks over explicit storage substitutes.
 * No authority/helper/registry module mocks; native locks/rollback are separate PG controls. */
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createOrdersV2Router } from '../routeV2';
import { createAuthService } from '../../auth/service';
import { createAuthorizationSnapshotGuard } from '../../auth/authorizationSnapshotGuard';

const auth = createAuthService(), actorId = 'responsibility-writer';
function storage() {
  const user = (id: string, departmentId: string | null = null) => ({ id, displayName: id, status: 'active', deletedAt: null,
    primaryDeptId: departmentId, primaryDepartment: null, roles: [{ roleId: 'responsibility-custom', departmentId,
      role: { id: 'responsibility-custom', name: 'ordinary-business', permissions: [] } }] });
  const accounts = [user(actorId), user('selected-owner', 'D'), user('department-head', 'D')];
  const departments = [{ id: 'D', name: 'Actual department', status: 'active', headId: 'department-head' },
    { id: 'EMPTY', name: 'No head department', status: 'active', headId: null }];
  const grants = [{ scope: 'orders:read', isActive: true, deletedAt: null }, { scope: 'orders:write', isActive: true, deletedAt: null }];
  const state = { order: { id: 'OLD', customer: 'Real customer', product: 'Legacy garment', type: 'Garment', quantity: 200,
    status: 'InProduction', customerRelationId: 'CUSTOMER', ownerId: null as string | null, departmentId: null as string | null,
    updatedAt: BigInt(1), deletedAt: null, lines: [] }, audits: [] as any[], relationOwner: actorId,
    fault: '', afterAudit: null as null | (() => void), locks: 0 };
  const matches = (row: any, w: any): boolean => !w || Object.entries(w).every(([k,v]: any) => {
    if (k === 'AND') return (Array.isArray(v) ? v : [v]).every((x:any) => matches(row,x));
    if (k === 'OR') return v.some((x:any) => matches(row,x));
    if (v && typeof v === 'object') { if (v.in) return v.in.includes(row[k]); if (v.has) return row[k]?.includes(v.has); if(v.path)return v.path.reduce((o:any,p:string)=>o?.[p],row[k])===v.equals; }
    return row[k] === v;
  });
  const db: any = {
    userAccount: {
      findFirst: async ({where}:any) => { if(state.fault==='account') throw Error('private SQL account secret'); return accounts.find(x=>matches(x,where)) ?? null; },
      findUnique: async ({where}:any) => { if(state.fault==='account') throw Error('private SQL account secret'); return accounts.find(x=>matches(x,where)) ?? null; },
      findMany: async ({where}:any) => { if(state.fault==='options') throw Error('private SQL options secret'); return accounts.filter(x=>matches(x,where)).map(x=>({id:x.id,displayName:x.displayName})); },
    },
    userPermissionOverrides: { findMany: async ({where}:any) => where.userId===actorId ? grants.filter(x=>x.isActive&&x.deletedAt===null).map(x=>({scope:x.scope})) : [] },
    department: { findUnique: async ({where}:any) => departments.find(x=>matches(x,where)) ?? null,
      findMany: async ({where}:any) => departments.filter(x=>matches(x,where)).map(x=>({id:x.id,name:x.name,headId:x.headId})) },
    teamMember: { findMany: async()=>[] }, teamDataGrant:{findMany:async()=>[]},
    relation: { findMany: async ({where}:any)=>[{id:'CUSTOMER',ownerId:state.relationOwner,deletedAt:null,salesRepIds:[]}].filter(x=>matches(x,where)) },
    order: { findFirst: async ({where}:any)=>matches(state.order,where)?{...state.order}:null,
      findUnique: async ({where}:any)=>matches(state.order,where)?{...state.order}:null,
      update: async ({data}:any)=>{Object.assign(state.order,data);return {...state.order};},
      updateMany: async ({where,data}:any)=>{if(!matches(state.order,where))return{count:0};Object.assign(state.order,data);return{count:1};} },
    auditLog: { create: async ({data}:any)=>{if(state.fault==='audit')throw Error('private SQL audit secret');state.audits.push(data);
      if(data.action==='assign_order_responsibility')state.afterAudit?.();return data;}, findFirst:async()=>null,findMany:async({where}:any)=>state.audits.filter(x=>matches(x,where)) },
    $queryRaw: async()=>{state.locks++;return[{id:'locked'}];},
    $transaction: async (callback:any)=>{const before={...state.order},audits=[...state.audits];try{return await callback(db);}
      catch(e){state.order=before;state.audits=audits;throw e;}},
  };
  const app=express();app.use(express.json());app.use('/api',createAuthorizationSnapshotGuard({prisma:db}));
  app.use('/api/v2/orders',createOrdersV2Router({prisma:db,requireAuth:true,apiKeys:new Set(['synthetic-key'])}));
  const token=(ceiling?:string[])=>auth.signToken({userId:actorId,roles:[],permissions:['*'],departmentIds:[],...(ceiling!==undefined?{permissionCeiling:ceiling}:{})});
  const http=(method:'get'|'patch'|'put'|'post',suffix='/responsibility',ceiling?:string[])=>request(app)[method]('/api/v2/orders/OLD'+suffix).set('Authorization','Bearer '+token(ceiling));
  return {db,state,accounts,departments,grants,app,http};
}
const body=()=>({clientRequestId:randomUUID(),ownerId:'selected-owner',departmentId:'D',expectedUpdatedAt:'1',reason:'Explicit verified legacy responsibility continuation'});

describe('object-bound legacy Order responsibility actual HTTP',()=>{
  it('ordinary orders reader/writer receives exact string source plus minimal active options, without HR/admin scope',async()=>{
    const x=storage(),r=await x.http('get');expect(r.status).toBe(200);expect(r.body.responsibility).toMatchObject({orderId:'OLD',owner:null,department:null,updatedAt:'1',canWrite:true});
    expect(r.body.responsibility.users).toContainEqual({id:'selected-owner',displayName:'selected-owner'});
    expect(r.body.responsibility.departments).toContainEqual({id:'D',name:'Actual department',headId:'department-head'});
    expect(JSON.stringify(r.body)).not.toMatch(/email|permissions|passwordHash|primaryDeptId/);expect(x.state.audits).toHaveLength(0);
  });
  it('read-only credential sees responsibility but no options or assignment capability',async()=>{
    const x=storage(),r=await x.http('get','/responsibility',['orders:read']);expect(r.status).toBe(200);
    expect(r.body.responsibility.canWrite).toBe(false);expect(r.body.responsibility.users).toBeUndefined();expect(r.body.responsibility.departments).toBeUndefined();
    expect((await x.http('patch','/responsibility',['orders:read']).send(body())).status).toBe(403);expect(x.state.audits).toHaveLength(0);
  });
  it.each([{ceiling:[]},{ceiling:['orders:write']}])('read ceiling %j cannot be widened by body role or signed stale wildcard',async ({ceiling})=>{
    const x=storage(),r=await x.http('get','/responsibility',ceiling);expect(r.status).toBe(403);expect(x.state.audits).toHaveLength(0);
  });
  it('actual ownership PATCH saves exact receipt/audits and preserves unrelated native fields',async()=>{
    const x=storage(),r=await x.http('patch').send({...body(),actorId:'department-head',roles:['owner']});expect(r.status).toBe(200);
    expect(r.body.receipt).toMatchObject({operation:'assign_order_responsibility',actorId,orderId:'OLD',before:{ownerId:null,departmentId:null,updatedAt:'1'},
      after:{ownerId:'selected-owner',departmentId:'D'},reason:body().reason});expect(typeof r.body.receipt.after.updatedAt).toBe('string');
    expect(r.body.callerCanRead).toBe(true);expect(r.body.callerCanWrite).toBe(true);expect(r.body.receipt.auditIds.length).toBeGreaterThanOrEqual(2);
    expect(x.state.order).toMatchObject({product:'Legacy garment',quantity:200,status:'InProduction'});
    expect(x.state.audits.find(a=>a.action==='assign_order_responsibility').detail.after.receipt).toEqual(r.body.receipt);
  });
  it.each([{}, {ownerId:null,departmentId:null},{ownerId:null,departmentId:'EMPTY'}, {ownerId:'ghost',departmentId:null},
    {ownerId:'selected-owner',departmentId:'EMPTY'},{expectedUpdatedAt:1},{expectedUpdatedAt:'1e0'},{reason:' '}])('malformed/unknown/dead-end/mismatched responsibility %j cannot mutate',async patch=>{
    const x=storage(),input=Object.keys(patch).length?{...body(),...patch}:{};
    const r=await x.http('patch').send(input);expect([400,409]).toContain(r.status);expect(x.state.order.ownerId).toBeNull();expect(x.state.audits).toHaveLength(0);
  });
  it('department-only explicit responsibility requires actual active head, and owner-only may preserve null department',async()=>{
    for(const input of [{...body(),ownerId:null},{...body(),departmentId:null}]){const x=storage(),r=await x.http('patch').send(input);expect(r.status).toBe(200);}
  });
  it('disabled actual target account and stale source both reject, without changing original ownership',async()=>{
    const x=storage();x.accounts[1].status='disabled';expect((await x.http('patch').send(body())).status).toBe(409);
    x.accounts[1].status='active';expect((await x.http('patch').send({...body(),expectedUpdatedAt:'0'})).status).toBe(409);expect(x.state.audits).toHaveLength(0);
  });
  it('API-key alone cannot PATCH even if body contains the writer identity',async()=>{
    const x=storage(),r=await request(x.app).patch('/api/v2/orders/OLD/responsibility').set('X-Bambook-API-Key','synthetic-key').send({...body(),actorId});
    expect(r.status).toBe(401);expect(x.state.audits).toHaveLength(0);
  });
  it.each(['account','options'])('read dependency %s fails explicitly, never empty success or private raw SQL text',async fault=>{
    const x=storage();x.state.fault=fault;const r=await x.http('get');expect(r.status).toBe(503);expect(JSON.stringify(r.body)).not.toContain('private SQL');
  });
  it('last actual command audit INSERT followed by personal-grant withdrawal rejects and rolls all writes/audits back',async()=>{
    const x=storage();x.state.afterAudit=()=>{x.grants[1].isActive=false;};const r=await x.http('patch').send(body());expect(r.status).toBe(403);
    expect(x.state.order.ownerId).toBeNull();expect(x.state.order.departmentId).toBeNull();expect(x.state.audits).toHaveLength(0);
  });
  it('audit fault safely rolls original record back',async()=>{
    const x=storage();x.state.fault='audit';const r=await x.http('patch').send(body());expect(r.status).toBe(503);expect(JSON.stringify(r.body)).not.toContain('private SQL');
    expect(x.state.order.ownerId).toBeNull();expect(x.state.audits).toHaveLength(0);
  });
  it('generic V2 PUT responsibility bypass is explicitly redirected with CONFLICT and zero update/audit',async()=>{
    const x=storage(),r=await x.http('put','').send({ownerId:'ghost',departmentId:'ghost'});expect(r.status).toBe(409);
    expect(x.state.order.ownerId).toBeNull();expect(x.state.audits).toHaveLength(0);
  });
  it('same actor/order/key exact replay returns immutable original receipt and never creates additional audit',async()=>{
    const x=storage(),input=body(),first=await x.http('patch').send(input);expect(first.status).toBe(200);
    const count=x.state.audits.length,again=await x.http('patch').send(input);expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);expect(again.body.receipt).toEqual(first.body.receipt);expect(x.state.audits).toHaveLength(count);
    expect((await x.http('patch').send({...input,reason:'Different actual intent'})).status).toBe(409);
  });
  it('normal transfer intentionally loses caller Order L2 but original actor can recover only own immutable receipt',async()=>{
    const x=storage();x.state.order.customerRelationId=null as any;x.state.order.ownerId=actorId;
    const input=body(),saved=await x.http('patch').send(input);expect(saved.status).toBe(200);
    expect(saved.body.callerCanRead).toBe(false);expect(saved.body.callerCanWrite).toBe(false);expect(saved.body.responsibility).toBeUndefined();
    expect((await x.http('get')).status).toBe(404);
    const recovered=await x.http('get','/responsibility/receipts/'+input.clientRequestId);expect(recovered.status).toBe(200);
    expect(recovered.body.receipt).toEqual(saved.body.receipt);expect(recovered.body.responsibility).toBeUndefined();
    expect(recovered.body.callerCanRead).toBe(false);expect(JSON.stringify(recovered.body)).not.toContain('displayName');
    expect((await x.http('get','/responsibility/receipts/'+randomUUID())).status).toBe(404);
  });
  it('missing original mandatory field audit makes replay/recovery fail closed',async()=>{
    const x=storage(),input=body();expect((await x.http('patch').send(input)).status).toBe(200);
    x.state.audits=x.state.audits.filter(a=>a.fieldPath!=='ownerId');
    expect((await x.http('patch').send(input)).status).toBe(409);
    expect((await x.http('get','/responsibility/receipts/'+input.clientRequestId)).status).toBe(409);
  });
  it('after last native audit customer-followership withdrawal cannot be hidden by expected owner transfer',async()=>{
    const x=storage();x.state.afterAudit=()=>{x.state.relationOwner='other-user';};
    expect((await x.http('patch').send(body())).status).toBe(404);expect(x.state.order.ownerId).toBeNull();expect(x.state.audits).toHaveLength(0);
  });

  it('RSC01 actual HTTP invalid owner/department intent can be explicitly cancelled, fenced, and corrected only under a fresh key',async()=>{
    const x=storage(),input={...body(),departmentId:'EMPTY'},cancelReason='Explicitly abandon rejected department choice';
    const parameterHash=createHash('sha256').update(JSON.stringify({operation:'assign_order_responsibility',actorId,orderId:'OLD',
      clientRequestId:input.clientRequestId,ownerId:input.ownerId,departmentId:input.departmentId,expectedUpdatedAt:input.expectedUpdatedAt,reason:input.reason})).digest('hex');
    expect((await x.http('patch').send(input)).status).toBe(409);expect(x.state.audits).toHaveLength(0);
    const cancelBody={...input,parameterHash,cancelReason};
    expect((await x.http('post','/responsibility/cancellations',['orders:read']).send({...cancelBody,roles:['owner'],permissions:['*'],actorId})).status).toBe(403);
    const cancelled=await x.http('post','/responsibility/cancellations').send(cancelBody);expect(cancelled.status).toBe(200);
    expect(cancelled.body.outcome).toBe('cancelled');expect(cancelled.body.receipt).toMatchObject({operation:'cancel_order_responsibility',actorId,orderId:'OLD',
      clientRequestId:input.clientRequestId,commandHash:parameterHash,intent:input,cancelReason});
    expect(cancelled.body.receipt.cancelledAt).toMatch(/^(0|[1-9][0-9]*)$/);expect(x.state.order.updatedAt).toBe(BigInt(1));expect(x.state.order.ownerId).toBeNull();
    expect(x.state.audits).toHaveLength(1);expect(cancelled.body.receipt.auditIds).toEqual([x.state.audits[0].id]);
    const recovered=await x.http('get','/responsibility/receipts/'+input.clientRequestId);expect(recovered.status).toBe(200);
    expect(recovered.body.outcome).toBe('cancelled');expect(recovered.body.receipt).toEqual(cancelled.body.receipt);expect(recovered.body.responsibility).toBeUndefined();
    expect((await x.http('patch').send(input)).status).toBe(409);expect(x.state.order.ownerId).toBeNull();expect(x.state.audits).toHaveLength(1);
    const retry=await x.http('post','/responsibility/cancellations').send(cancelBody);expect(retry.status).toBe(200);expect(retry.body.receipt).toEqual(cancelled.body.receipt);
    expect((await x.http('post','/responsibility/cancellations').send({...cancelBody,parameterHash:'0'.repeat(64)})).status).toBe(409);
    expect(x.state.audits).toHaveLength(1);
    const corrected=await x.http('patch').send({...input,clientRequestId:randomUUID(),departmentId:'D'});expect(corrected.status).toBe(200);
    expect(corrected.body.receipt.clientRequestId).not.toBe(input.clientRequestId);expect(x.state.order.departmentId).toBe('D');
    expect(x.state.audits.filter(a=>a.action==='cancel_order_responsibility')).toHaveLength(1);
  });

});
