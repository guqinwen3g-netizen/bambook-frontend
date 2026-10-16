/** Real Express/JWT/current-grant loaders, role/scope guards, Orders L2 resolver
 * and mutation services. Only Prisma storage delegates are substituted. These
 * HTTP probes do not prove real-PG locking/rollback or a complete company UAT.
 * Authority: current Orders write/delete scopes, including business staff;
 * DR-042 L2 customer follow-up/shared view and legacy owner anchor are preserved. */
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordAuthorityFixtureProof } from './currentAuthorityFixtureProof';
import { createAuthService } from '../service';
import { createOrderLinesRouter } from '../../orders/orderLinesRoute';

const identity = createAuthService(), userId = 'u_current_order_line_probe';
const actorToken = (extra: any = {}) => identity.signToken({ userId, roles: ['owner'], permissions: ['orders:write','orders:delete'], authorizationLoaded: true, departmentIds: [], ...extra });
const actions = [
  { name:'create', method:'post', path:'/', scope:'orders:write', body:{poNumber:'PO-SYNTHETIC',quantity:2} },
  { name:'update', method:'put', path:'/LINE-SYNTHETIC', scope:'orders:write', body:{quantity:3} },
  { name:'version reference', method:'patch', path:'/LINE-SYNTHETIC/version', scope:'orders:write', body:{confirmedSourceType:'Asset',confirmedSourceId:'ASSET-SYNTHETIC'} },
  { name:'delete', method:'delete', path:'/LINE-SYNTHETIC', scope:'orders:delete', body:{} },
] as const;
function account(scopes: readonly string[] = ['orders:write','orders:delete'], roleId='role-admin') {
  return { id:userId, status:'active', deletedAt:null, displayName:'Synthetic leadership', primaryDeptId:'test-dept', primaryDepartment:{ parentId:'company', status:'active', metadata:{ businessAttributes:['fabric_business','garment_business'] } },
    roles:[{roleId,role:{id:roleId,name:'Not a source of role authority',permissions:scopes.map(scope=>({permission:{scope}}))}}] };
}
/** Small query adapter honors the actual Prisma where fragment. Assertions also
 * inspect the emitted AND filter; returning preselected rows cannot prove L2. */
function matches(row: any, where: any): boolean {
  if(!row)return false;
  return Object.entries(where??{}).every(([key,condition]:[string,any])=>{
    if(key==='AND')return (Array.isArray(condition)?condition:[condition]).every(w=>matches(row,w));
    if(key==='OR')return condition.some((w:any)=>matches(row,w));
    if(condition===null)return row[key]==null;
    if(condition&&typeof condition==='object') {
      if('in' in condition)return condition.in.includes(row[key]);
      if('has' in condition)return (row[key]??[]).includes(condition.has);
      return matches(row[key],condition);
    }
    return row[key]===condition;
  });
}
/** Current storage select projection; no credential fields or role defaults. */
function projectCurrent(row: any, select?: any): any {
  if (row == null) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.entries(select).filter(([, value]) => value).map(([key, value]: [string, any]) => [key,
    value === true ? row[key] ?? null
      : Array.isArray(row[key]) ? row[key].map((item: any) => projectCurrent(item, value.select))
      : projectCurrent(row[key], value.select)]));
}
let latestFixture: any;
function fixture(requireAuth=false) {
  let current:any=account(), relations:any[]=[], memberships:any[]=[], grants:any[]=[], audits:any[]=[], beforeTransaction:(()=>void)|undefined;
  const order:any={id:'ORDER-SYNTHETIC',poNumber:'PO-SYNTHETIC',customer:'Synthetic customer',customerRelationId:'CUSTOMER-SYNTHETIC',ownerId:'u_other',type:'fabric',status:'Pending',deletedAt:null};
  let line:any={id:'LINE-SYNTHETIC',orderId:order.id,itemNo:'0010',lineNumber:1,quantity:1,materialCode:null,fieldSources:{},status:'Pending',productionSteps:[],confirmedSourceType:null,confirmedSourceId:null,confirmedAt:null,confirmedBy:null,specSnapshot:null};
  let transactionInvocations = 0;
  const authorityReads: Array<{ operation: string; args: any }> = [];
  const departments = [{ id: 'test-dept', parentId: null, status: 'active' },
    { id: 'test-dept-child', parentId: 'test-dept', status: 'active' },
    { id: 'inactive-child', parentId: 'test-dept', status: 'inactive' },
    { id: 'unrelated-child', parentId: 'other-root', status: 'active' }];
  const prisma:any={
    // Accepts both Prisma.sql objects and tagged-template calls (strings array).
    $queryRaw:vi.fn(async(query:any)=>(Array.isArray(query)?query.join('?'):query.sql).includes('"OrderLine"')?[{id:line.id}]:[{id:order.id}]),
    userAccount:{findFirst:vi.fn(async(args:any)=>{authorityReads.push({operation:'userAccount.findFirst',args});return current;}),
      findUnique:vi.fn(async({where,select}:any)=>{authorityReads.push({operation:'userAccount.findUnique',args:{where,select}});return matches(current,where)?projectCurrent(current,select):null;})},
    userPermissionOverrides:{findMany:vi.fn(async(args:any)=>{authorityReads.push({operation:'userPermissionOverrides.findMany',args});return [];})},
    department:{findMany:vi.fn(async({where,select}:any)=>departments.filter(row=>matches(row,where)).map(row=>projectCurrent(row,select)))},
    teamMember:{findMany:vi.fn(async({where,select}:any)=> memberships.filter(m=>(!where.userId||m.userId===where.userId)&&(!where.teamId?.in||where.teamId.in.includes(m.teamId)))
      .map(m=>select?.userId?{userId:m.userId}:{teamId:m.teamId}))},
    teamDataGrant:{findMany:vi.fn(async()=>grants)},
    relation:{findMany:vi.fn(async({where}:any)=>relations.filter(row=>matches(row,where)))},
    order:{findMany:vi.fn(async({where,select}:any)=>matches(order,where)?[projectCurrent(order,select)]:[]),findFirst:vi.fn(async({where}:any)=>matches(order,where)?order:null),findUnique:vi.fn(async({where}:any)=>matches(order,where)?order:null),
      findUniqueOrThrow:vi.fn(async()=>order),update:vi.fn(async()=>order)},
    approvalRequest:{findFirst:vi.fn(async()=>null)},
    orderLine:{findFirst:vi.fn(async({where}:any)=>matches({...line,order},where)?line:null),findUnique:vi.fn(async({where}:any)=>matches(line,where)?line:null),findMany:vi.fn(async()=>[]),
      findUniqueOrThrow:vi.fn(async({where}:any)=>{if(!matches(line,where))throw Error('Synthetic missing row');return line;}),
      create:vi.fn(async({data}:any)=>({ ...data })),update:vi.fn(async({data}:any)=>{line={...line,...data};return line;}),
      updateMany:vi.fn(async({where,data}:any)=>{if(!matches({...line,order},where))return {count:0};line={...line,...data};return {count:1};}),delete:vi.fn(async()=>line)},
    entityReference:{upsert:vi.fn(async()=>({})),findMany:vi.fn(async()=>[]),update:vi.fn(async()=>({}))},
    entityLink:{upsert:vi.fn(async()=>({})),count:vi.fn(async()=>0),findMany:vi.fn(async()=>[]),update:vi.fn(async()=>({}))},
    productAsset:{findUnique:vi.fn(async()=>({id:'ASSET-SYNTHETIC',sku:'SKU-SYNTHETIC',name:'Synthetic asset',mainCategory:'fabric',fabricProfile:{id:'FABRIC-PROFILE-SYNTHETIC',deletedAt:null,millOrganizationId:null},garmentProfile:null})),findMany:vi.fn(async()=>[])},
    fabricProfile:{findMany:vi.fn(async()=>[])},
    fabricCustomerCode:{findMany:vi.fn(async()=>[])},
    // This fixture selects an independent/manual asset, with no development
    // conversion audit or reverse provenance. Native PG tests cover real locks.
    sampleBatch:{findMany:vi.fn(async()=>[])},sealSample:{findMany:vi.fn(async()=>[])},
    developmentCase:{findMany:vi.fn(async()=>[])},
    auditLog:{findMany:vi.fn(async()=>[]),create:vi.fn(async({data}:any)=>{audits.push(data);return data;})},
  };
  // This models storage rollback only. SQL isolation/foreign keys are deliberately
  // not claimed; the isolated real-PG batch must prove those independently.
  prisma.$transaction=vi.fn(async(fn:any)=>{
    transactionInvocations++;beforeTransaction?.();const oldLine=line,oldAudits=[...audits];
    try{return await fn(prisma);}catch(error){line=oldLine;audits=oldAudits;throw error;}
  });
  const app=express(),onDataChange=vi.fn();app.use(express.json());
  app.set('json replacer',(_key:string,value:any)=>typeof value==='bigint'?value.toString():value);
  app.use('/order-lines',createOrderLinesRouter({prisma,requireAuth,apiKeys:new Set(['synthetic-api-key']),onDataChange}));
  const result = {app,prisma,onDataChange,order,authorityReads,beforeTransactionInvocations:()=>transactionInvocations,setUser:(value:any)=>{current=value;},getLine:()=>line,getAudits:()=>audits,
    beforeTransaction:(callback:()=>void)=>{beforeTransaction=callback;},setLine:(patch:any)=>{line={...line,...patch};},
    followCustomer:()=>{relations=[{id:order.customerRelationId,deletedAt:null,ownerId:userId,salesRepIds:[]}];},
    shareCustomer:()=>{memberships=[{teamId:'TEAM-SYNTHETIC',userId}];grants=[{entityId:order.customerRelationId}];},
    revokeSharedCustomer:()=>{grants=[];}};
  latestFixture = result;
  return result;
}
afterEach(async context=>recordAuthorityFixtureProof('currentOrderLineWriteAccess.test.ts',context.task,latestFixture));
const send=(f:ReturnType<typeof fixture>,action:typeof actions[number],token?:string)=>{
  const req=(request(f.app) as any)[action.method]('/order-lines'+action.path);if(token)req.set('Authorization','Bearer '+token);return req.send(action.body);
};
/** lockConfirmedFabricSources deliberately reads lock hints (by id) before the
 * Order lock to keep the global lock order; hints are never permission and
 * nothing is returned. The authorized source resolution (asset + profiles) must
 * still not run after a denial. */
function noSourceResolution(f:ReturnType<typeof fixture>) {
  expect(f.prisma.productAsset.findUnique.mock.calls.filter((call:any[])=>call[0]?.include)).toEqual([]);
}
function noWrite(f:ReturnType<typeof fixture>) {
  expect(f.prisma.orderLine.create).not.toHaveBeenCalled();expect(f.prisma.orderLine.update).not.toHaveBeenCalled();expect(f.prisma.orderLine.delete).not.toHaveBeenCalled();
  expect(f.prisma.orderLine.updateMany).not.toHaveBeenCalled();
  expect(f.prisma.auditLog.create).not.toHaveBeenCalled();expect(f.prisma.entityReference.upsert).not.toHaveBeenCalled();expect(f.prisma.entityLink.upsert).not.toHaveBeenCalled();expect(f.onDataChange).not.toHaveBeenCalled();
}
describe.each(actions)('OrderLines $name current authority',action=>{
  it.each([false,true])('anonymous requireAuth=%s cannot write using forged body owner',async configured=>{
    const f=fixture(configured),r=await(request(f.app) as any)[action.method]('/order-lines'+action.path).send({...action.body,actor:{userId,roles:['owner'],permissions:['*']}});
    expect(r.status).toBe(401);noWrite(f);
  });
  it('an API key cannot supply write identity',async()=>{
    const f=fixture(),r=await(request(f.app) as any)[action.method]('/order-lines'+action.path).set('X-Bambook-API-Key','synthetic-api-key').send(action.body);
    expect(r.status).toBe(401);noWrite(f);
  });
  it.each(['absent','inactive','deleted'])('current %s account denies a stale signed owner',async state=>{
    const f=fixture(),u:any=account();if(state==='inactive')u.status='inactive';if(state==='deleted')u.deletedAt=new Date();f.setUser(state==='absent'?null:u);
    const r=await send(f,action,actorToken());expect(r.status).toBe(401);noWrite(f);
  });
  it.each(['account','grants'])('%s loader fault is 503, never default leadership scope',async failure=>{
    const f=fixture();(failure==='account'?f.prisma.userAccount.findFirst:f.prisma.userPermissionOverrides.findMany).mockRejectedValue(Error('synthetic read failure'));
    const r=await send(f,action,actorToken());expect(r.status).toBe(503);noWrite(f);
  });
  it('current revoked action denies previously signed write scope',async()=>{
    const f=fixture();f.setUser(account(['orders:read']));const r=await send(f,action,actorToken());expect(r.status).toBe(403);noWrite(f);
  });
  it('current sales action grant writes within the actual followed customer scope',async()=>{
    const f=fixture();f.setUser(account([action.scope],'role-sales'));f.followCustomer();
    const r=await send(f,action,actorToken());expect(r.status).toBe(200);
    expect(f.prisma.auditLog.create).toHaveBeenCalledTimes(1);expect(f.onDataChange).toHaveBeenCalledTimes(1);
  });
  it('owner privilege remains bounded by a signed read-only credential ceiling',async()=>{
    const f=fixture();f.setUser(account([action.scope],'role-super-admin'));const r=await send(f,action,actorToken({permissionCeiling:['orders:read']}));expect(r.status).toBe(403);noWrite(f);
  });
  it('current legitimate leadership+action grants allow a stale token with empty roles/scopes',async()=>{
    const f=fixture();f.setUser(account([action.scope]));const r=await send(f,action,actorToken({roles:[],permissions:[],authorizationLoaded:undefined}));
    expect(r.status).toBe(200);
    expect(f.authorityReads.map((read: { operation: string })=>read.operation)).toEqual([
      'userAccount.findFirst','userPermissionOverrides.findMany',
      'userAccount.findUnique','userPermissionOverrides.findMany',
      'userAccount.findFirst','userPermissionOverrides.findMany',
      'userAccount.findUnique','userPermissionOverrides.findMany',
      'userAccount.findFirst','userPermissionOverrides.findMany',
      'userAccount.findUnique','userPermissionOverrides.findMany',
    ]);
    expect(f.prisma.userPermissionOverrides.findMany).toHaveBeenCalledTimes(6);
    expect(f.prisma.auditLog.create).toHaveBeenCalledTimes(1);expect(f.prisma.auditLog.create.mock.calls[0][0].data.actorId).toBe(userId);expect(f.onDataChange).toHaveBeenCalledTimes(1);
  });
  it('manager cannot guess a line/PO belonging to an unrelated customer',async()=>{
    const f=fixture();f.setUser(account([action.scope],'role-sales-manager'));const r=await send(f,action,actorToken());expect(r.status).toBe(404);noWrite(f);
    if(action.name==='create'){expect(f.prisma.order.findMany.mock.calls[0][0].where.AND[0].OR).toBeDefined();expect(f.prisma.order.findFirst).not.toHaveBeenCalled();}
    else expect(f.prisma.orderLine.findFirst.mock.calls[0][0].where.order.AND[0].OR).toBeDefined();
    if(action.name==='version reference')expect(f.prisma.productAsset.findUnique).not.toHaveBeenCalled();
  });
  it.each(['followed','shared','legacy-own'])('manager may write the actual %s Order anchor',async anchor=>{
    const f=fixture();f.setUser(account([action.scope],'role-sales-manager'));
    if(anchor==='followed')f.followCustomer();if(anchor==='shared')f.shareCustomer();if(anchor==='legacy-own'){f.order.customerRelationId=null;f.order.ownerId=userId;}
    const r=await send(f,action,actorToken());expect(r.status).toBe(200);expect(f.prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it.each(['team','missing-team','relation','grants'])('L2 %s read failure is explicit 503 with no write',async source=>{
    const f=fixture();f.setUser(account([action.scope],'role-sales-manager'));f.shareCustomer();
    if(source==='missing-team')delete f.prisma.teamMember;
    else (source==='team'?f.prisma.teamMember.findMany:source==='relation'?f.prisma.relation.findMany:f.prisma.teamDataGrant.findMany).mockRejectedValue(Error('synthetic visibility fault'));
    const r=await send(f,action,actorToken());expect(r.status).toBe(503);noWrite(f);
  });
  it('deleted parent is never writable even with all-scope leadership',async()=>{
    const f=fixture();f.order.deletedAt=BigInt(1);const r=await send(f,action,actorToken());expect(r.status).toBe(404);noWrite(f);
  });
});
it('a removed TeamShare cannot authorize a second write from the 60-second reader cache',async()=>{
  const f=fixture();f.setUser(account(['orders:write'],'role-sales-manager'));f.shareCustomer();
  expect((await send(f,actions[1],actorToken())).status).toBe(200);
  f.revokeSharedCustomer();f.prisma.orderLine.update.mockClear();f.prisma.auditLog.create.mockClear();f.onDataChange.mockClear();
  expect((await send(f,actions[1],actorToken())).status).toBe(404);noWrite(f);expect(f.prisma.teamDataGrant.findMany).toHaveBeenCalledTimes(4);
});
it('orders:write does not authorize delete, even when the old leadership role matches',async()=>{
  const f=fixture();f.setUser(account(['orders:write']));const r=await send(f,actions[3],actorToken());expect(r.status).toBe(403);noWrite(f);
});

describe('version reference single-transaction contract',()=>{
  it('mandatory audit failure rejects and the storage adapter restores the original reference',async()=>{
    const f=fixture(),before={...f.getLine()};f.prisma.auditLog.create.mockRejectedValue(Error('Synthetic mandatory audit rejection'));
    const r=await send(f,actions[2],actorToken());expect(r.status).toBe(500);expect(r.body.ok).toBe(false);
    expect(f.prisma.orderLine.updateMany).toHaveBeenCalledTimes(1);expect(f.getLine()).toEqual(before);expect(f.getAudits()).toEqual([]);expect(f.onDataChange).not.toHaveBeenCalled();
    expect(f.prisma.$transaction.mock.calls[0][1]).toEqual({isolationLevel:'Serializable'});
  });
  it('source CAS cannot overwrite a version selected after the preflight read',async()=>{
    const f=fixture();f.beforeTransaction(()=>f.setLine({confirmedSourceType:'Asset',confirmedSourceId:'ASSET-OTHER',confirmedAt:BigInt(9),confirmedBy:'u_other'}));
    const r=await send(f,actions[2],actorToken());expect(r.status).toBe(409);expect(r.body.error.code).toBe('CONFLICT');
    expect(f.prisma.orderLine.updateMany).toHaveBeenCalledTimes(1);expect(f.getLine().confirmedSourceId).toBe('ASSET-OTHER');
    expect(f.prisma.auditLog.create).not.toHaveBeenCalled();expect(f.onDataChange).not.toHaveBeenCalled();
  });
  it('current write revocation before the transaction denies before reading source or mutating',async()=>{
    const f=fixture();f.beforeTransaction(()=>f.setUser(account(['orders:read'])));
    const r=await send(f,actions[2],actorToken());expect(r.status).toBe(403);noWrite(f);noSourceResolution(f);
  });
  it('account deactivation before the transaction is not replaced by the earlier loaded actor',async()=>{
    const f=fixture();f.beforeTransaction(()=>f.setUser({...account(),status:'inactive'}));
    const r=await send(f,actions[2],actorToken());expect(r.status).toBe(401);noWrite(f);
  });
  it('personal grant loading failure inside the transaction remains 503 with no write',async()=>{
    const f=fixture();f.beforeTransaction(()=>f.prisma.userPermissionOverrides.findMany.mockRejectedValue(Error('Synthetic transaction grant failure')));
    const r=await send(f,actions[2],actorToken());expect(r.status).toBe(503);noWrite(f);noSourceResolution(f);
  });
  it('TeamShare revocation before the transaction rechecks the parent scope with no reader cache',async()=>{
    const f=fixture();f.setUser(account(['orders:write'],'role-sales-manager'));f.shareCustomer();f.beforeTransaction(()=>f.revokeSharedCustomer());
    const r=await send(f,actions[2],actorToken());expect(r.status).toBe(404);noWrite(f);noSourceResolution(f);
    expect(f.prisma.teamDataGrant.findMany).toHaveBeenCalledTimes(2);
  });
  it('serialization conflict cannot emit a successful version-change event',async()=>{
    const f=fixture();f.prisma.$transaction.mockRejectedValue(Object.assign(Error('Synthetic SQL serialization conflict'),{code:'P2034'}));
    const r=await send(f,actions[2],actorToken());expect(r.status).toBe(409);expect(r.body.error.code).toBe('CONFLICT');noWrite(f);
  });
});

describe.each([actions[0],actions[1],actions[3]])('OrderLines $name transaction authorization',action=>{
  it('grant revocation after HTTP preflight rejects inside the business transaction',async()=>{
    const f=fixture();f.beforeTransaction(()=>f.setUser(account(['orders:read'])));
    const r=await send(f,action,actorToken());expect(r.status).toBe(403);expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);noWrite(f);
  });
  it('current account deactivation after HTTP preflight denies without business mutation',async()=>{
    const f=fixture();f.beforeTransaction(()=>f.setUser({...account(),status:'inactive'}));
    const r=await send(f,action,actorToken());expect(r.status).toBe(401);noWrite(f);
  });
  it('a current sales role after preflight still requires its real customer range and action grant',async()=>{
    const f=fixture();f.followCustomer();f.beforeTransaction(()=>f.setUser(account([action.scope],'role-sales')));
    const r=await send(f,action,actorToken());expect(r.status).toBe(200);
    expect(f.prisma.auditLog.create).toHaveBeenCalledTimes(1);expect(f.onDataChange).toHaveBeenCalledTimes(1);
  });
  it('transaction grant loading fault remains explicit 503',async()=>{
    const f=fixture();f.beforeTransaction(()=>f.prisma.userPermissionOverrides.findMany.mockRejectedValue(Error('Synthetic transaction grant fault')));
    const r=await send(f,action,actorToken());expect(r.status).toBe(503);noWrite(f);
  });
  it('removing the shared parent between preflight and transaction denies the real target',async()=>{
    const f=fixture();f.setUser(account([action.scope],'role-sales-manager'));f.shareCustomer();f.beforeTransaction(()=>f.revokeSharedCustomer());
    const r=await send(f,action,actorToken());expect(r.status).toBe(404);noWrite(f);
  });
});
