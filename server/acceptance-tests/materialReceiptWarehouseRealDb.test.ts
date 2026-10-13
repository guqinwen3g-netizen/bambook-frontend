/** Opt-in dedicated fresh private PG: Warehouse must initially be empty.
 * Actual procurement HTTP/current JWT, native Draft→Sent→Confirmed, receipt,
 * warehouse service, L8/inventory and crash-recovery task run against PG.
 * No shared DB, seed, index or scheduler bootstrap. A synthetic pre-upgrade
 * receipt/audit/outbox is explicitly used only for the legacy recovery probe.
 * Producers do not prove posting: only real movements/items/audit do. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createProcurementRouter } from '../src/procurement/procurementRoute';
import { createProcurementService } from '../src/procurement/procurementService';
import { createInventoryService } from '../src/inventory/inventoryService';
import { createOperationalReadAccess } from '../src/auth/operationalReadAccess';
import { businessEventBus, type BusinessEvent, type LinkageHandler } from '../src/events/businessEventBus';
import { registerL8AutoStockIn } from '../src/events/linkages/L8AutoStockIn';
import { createCrashRecoveryTask } from '../src/scheduler/tasks/retryLinkages';
import { isLinkageEnabled } from '../src/config/automationConfig';
import { createTraceabilityService } from '../src/traceability/traceabilityService';

const prefix=`acceptance-receipt-warehouse-${randomUUID()}`,auth=createAuthService();
let prisma:PrismaClient|undefined,sequence=0,execute:LinkageHandler['execute'];
const warehouses=new Set<string>();
const db=()=>{if(!prisma)throw Error('Isolated receipt PG not initialized');return prisma;};
beforeAll(async()=>{
 const {DATABASE_URL,BAMBOOK_ACCEPTANCE_SANDBOX:sandbox,BAMBOOK_ACCEPTANCE_DB_NAME:name,BAMBOOK_ACCEPTANCE_DB_DIR:directory,BAMBOOK_ACCEPTANCE_DB_PORT:port}=process.env;
 if(!DATABASE_URL||!sandbox||!name||!directory||!port)throw Error('Reviewed private acceptance PG required');
 const url=new URL(DATABASE_URL);expect(url.protocol).toBe('postgresql:');expect(['localhost','127.0.0.1']).toContain(url.hostname);
 expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);expect(url.pathname).toBe(`/${name}`);expect(url.port).toBe(port);
 expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox),'postgres'));
 expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
 prisma=new PrismaClient({datasources:{db:{url:DATABASE_URL}}});
 const identity=await db().$queryRaw<Array<{name:string;directory:string;port:number}>>`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`;
 expect(identity).toEqual([{name,directory,port:Number(port)}]);
 expect(await db().warehouse.count(),'Dedicated fresh PG required: never deactivate another suite’s warehouses').toBe(0);
 expect(isLinkageEnabled('L8_auto_stock_in'),'Actual configured L8 must be enabled').toBe(true);
});
beforeEach(()=>{
 businessEventBus.reset();businessEventBus.setPrisma(db());
 const spy=vi.spyOn(businessEventBus,'registerLinkage');registerL8AutoStockIn();execute=spy.mock.calls[0][0].execute;spy.mockRestore();
});
afterEach(async()=>{
 businessEventBus.reset();vi.restoreAllMocks();
 if(warehouses.size)await db().warehouse.updateMany({where:{id:{in:[...warehouses]}},data:{isActive:false}});
 warehouses.clear();
});
afterAll(async()=>{businessEventBus.reset();await prisma?.$disconnect();});
async function fixture(label:string,two=false){
 const id=`${prefix}-${++sequence}-${label}`,actorId=`${id}-actor`,roleId=`${id}-role`,orderId=`${id}-order`,now=BigInt(Date.now());
 await db().userAccount.create({data:{id:actorId,displayName:'Synthetic receipt operator',status:'active'}});
 await db().role.create({data:{id:roleId,name:'Custom receipt operator',isSystem:false}});
 await db().userRole.create({data:{id:`${id}-membership`,userId:actorId,roleId}});
 for(const scope of ['procurement:write','procurement:read','orders:read'])await db().userPermissionOverrides.create({data:{id:`${id}-${scope}`,userId:actorId,scope,isActive:true,grantedBy:actorId,reason:'Explicit isolated fixture grant'}});
 await db().order.create({data:{id:orderId,customer:'Synthetic buyer',product:'Physical source',type:'fabric',quantity:20,quoteAmount:100,currency:'USD',status:'Pending',dueDate:'2099-11-15',ownerId:actorId,updatedAt:now}});
 const service=createProcurementService(db());
 const draft=await service.createPurchaseOrder({poNumber:`${id}-PO`,orderId,currency:'USD',supplierName:'Synthetic physical supplier',orderDate:'2026-10-02',lines:Array.from({length:two?2:1},(_,index)=>({kind:'Material',description:`Actual receipt line ${index}`,materialCode:`${id}-material-${index}`,quantity:10,unit:'M',unitPrice:2.5}))},actorId);
 await service.sendPurchaseOrder(draft.id,actorId);const po=await service.confirmPurchaseOrder(draft.id,actorId);
 const loaded=await buildLoadedAuthTokenPayload(db(),await loadUserWithRoles(db(),actorId));
 expect(loaded.roles).toEqual([]);expect(loaded.authorizationLoaded).toBe(true);
 return{id,actorId,orderId,po,loaded,token:auth.signToken(loaded)};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function warehouse(item:Fixture,label:string,type:'Main'|'Auxiliary'='Main',sortOrder=0){
 const row=await createInventoryService(db()).createWarehouse({code:`${item.id}-${label}`,name:`Actual ${label}`,type,sortOrder},item.actorId);warehouses.add(row.id);return row;
}
function input(item:Fixture,accepted=10,rejected=0,extra:Record<string,unknown>={}){
 return{receiptNumber:`${item.id}-MR`,receivedDate:'2026-10-02',totalReceived:accepted+rejected,totalAccepted:accepted,totalRejected:rejected,
 lineReceipts:[{lineId:item.po.lines[0].id,accepted,rejected}],...extra};
}
function app(prisma:PrismaClient=db()){
 const application=express();application.use(express.json());application.set('json replacer',(_key:string,value:unknown)=>typeof value==='bigint'?Number(value):value);
 application.use(createAccountStatusGuard(db()));application.use(createAuthorizationSnapshotGuard({prisma:db(),apiKeys:new Set()}));
 application.use('/api/v1/procurement',createProcurementRouter({prisma,requireAuth:true,apiKeys:new Set()}));return application;
}
const submit=(item:Fixture,body:ReturnType<typeof input>,prisma?:PrismaClient)=>request(app(prisma)).post(`/api/v1/procurement/${item.po.id}/receipts`).set('Authorization',`Bearer ${item.token}`).send(body);
function crashWake(){return vi.spyOn(businessEventBus,'publish').mockResolvedValue(undefined);}
async function pending(item:Fixture,body=input(item)){
 const wake=crashWake();try{const res=await submit(item,body);expect(res.status,JSON.stringify(res.body)).toBe(201);const receipt=await db().materialReceipt.findUniqueOrThrow({where:{id:res.body.receipt.id}});
 const job=await db().agentJob.findUniqueOrThrow({where:{id:`bev_material_received_${receipt.id}`}});expect(job.status).toBe('queued');return{receipt,job,event:job.payload as unknown as BusinessEvent};}finally{wake.mockRestore();}
}
async function state(item:Fixture){return{po:await db().purchaseOrder.findUniqueOrThrow({where:{id:item.po.id},include:{lines:true}}),receipts:await db().materialReceipt.findMany({where:{purchaseOrderId:item.po.id},orderBy:{id:'asc'}}),
 audits:await db().auditLog.findMany({where:{actorId:item.actorId},orderBy:{id:'asc'}}),jobs:await db().agentJob.findMany({where:{payload:{path:['sourceEntityId'],equals:item.po.id}},orderBy:{id:'asc'}}),
 items:await db().inventoryItem.findMany({where:{materialCode:{startsWith:item.id}},orderBy:{id:'asc'}}),movements:await db().stockMovement.findMany({where:{item:{materialCode:{startsWith:item.id}}},orderBy:{id:'asc'}})};}
function faultAudit(actorId:string,action:string){
 const observed:{count:number;code?:string}={count:0};
 const client=new Proxy(db(),{get(base,key){if(key==='$transaction')return async(work:any,options?:any)=>base.$transaction(async tx=>work(new Proxy(tx,{get(real,delegate){if(delegate==='auditLog')return new Proxy(real.auditLog,{get(model,method){if(method==='create')return async(args:any)=>{if(args.data.actorId===actorId&&args.data.action===action){observed.count++;try{return await model.create({...args,data:{...args.data,actorId:`${prefix}-missing-actor`}});}catch(error:any){observed.code=error.code;throw error;}}return model.create(args);};const value=Reflect.get(model,method);return typeof value==='function'?value.bind(model):value;}});const value=Reflect.get(real,delegate);return typeof value==='function'?value.bind(real):value;}})),options);const value=Reflect.get(base,key);return typeof value==='function'?value.bind(base):value;}});
 return{client,observed};
}
function faultWarehouseSql(){
 const observed:{count:number;code?:string;sqlState?:string}={count:0};
 const client=new Proxy(db(),{get(base,key){
  if(key==='$transaction')return async(work:any,options?:any)=>base.$transaction(async tx=>work(new Proxy(tx,{get(real,delegate){
   if(delegate==='warehouse')return new Proxy(real.warehouse,{get(model,method){
    if(method==='findFirst')return async()=>{observed.count++;try{return await real.$queryRaw(Prisma.sql`SELECT "仅不存在-storage-probe" FROM "Warehouse"`);}catch(error:any){observed.code=error.code;observed.sqlState=error.meta?.code;throw error;}};
    const value=Reflect.get(model,method);return typeof value==='function'?value.bind(model):value;
   }});
   const value=Reflect.get(real,delegate);return typeof value==='function'?value.bind(real):value;
  }})),options);
  const value=Reflect.get(base,key);return typeof value==='function'?value.bind(base):value;
 }});
 return{client,observed};
}
describe('native receipt warehouse, currency, source and durable posting boundaries',()=>{
 it('MW01 missing default warehouse is HTTP409 with actionable Chinese and zero receipt/line/PO/audit/outbox writes',async()=>{
  const x=await fixture('no-warehouse'),before=await state(x),res=await submit(x,input(x));expect(res.status,JSON.stringify(res.body)).toBe(409);expect(res.body.code).toBe('CONFLICT');expect(res.body.error).toContain('请先启用或建立实际仓库');expect(await state(x)).toEqual(before);
 });
 it.each(['missing','inactive','deleted'] as const)('MW02-%s explicit unavailable destination never falls back to an active Main',async variant=>{
  const x=await fixture(`bad-${variant}`),main=await warehouse(x,'available'),bad=variant==='missing'?null:await warehouse(x,'bad','Auxiliary');
  if(bad)await db().warehouse.update({where:{id:bad.id},data:variant==='inactive'?{isActive:false}:{deletedAt:BigInt(Date.now())}});
  const before=await state(x),res=await submit(x,input(x,10,0,{warehouseId:bad?.id??`${x.id}-missing`,warehouseName:main.name}));
  expect(res.status,JSON.stringify(res.body)).toBe(409);expect(res.body.error).toContain('请核对并选择实际可用仓库');expect(await state(x)).toEqual(before);
 });
 it('MW03 default Main is resolved before commit; original command stays null while actual USD stock and MaterialReceipt movements become readable',async()=>{
  const x=await fixture('usd'),aux=await warehouse(x,'aux','Auxiliary',-10),main=await warehouse(x,'main','Main',99),posted=await pending(x,input(x,10,0,{warehouseName:'Forged label'}));
  expect(posted.receipt).toMatchObject({warehouseId:main.id,warehouseName:main.name,status:'Accepted'});expect(posted.event.payload).toMatchObject({warehouseId:main.id,warehouseName:main.name,currency:'USD'});
  const receiptAudit=await db().auditLog.findFirstOrThrow({where:{actorId:x.actorId,action:'create_material_receipt',targetId:x.po.id}});
  expect(receiptAudit.detail).toMatchObject({after:{receiptSnapshot:{warehouseId:null,warehouseName:'Forged label'},warehouseResolution:{id:main.id,name:main.name}}});
  expect((await execute(db(),posted.event)).ok).toBe(true);const stored=await state(x);expect(stored.items).toHaveLength(1);expect(stored.items[0]).toMatchObject({warehouseId:main.id,currency:'USD'});expect(stored.items[0].unitCost?.toString()).toBe('2.5');expect(stored.items[0].quantity.toString()).toBe('10');
  expect(stored.movements).toHaveLength(1);expect(stored.movements[0]).toMatchObject({referenceType:'MaterialReceipt',referenceId:posted.receipt.id,warehouseId:main.id});
  const scope=await createOperationalReadAccess(db(),x.loaded).stockMovementWhere();expect(await db().stockMovement.count({where:{AND:[{id:stored.movements[0].id},scope]}})).toBe(1);expect(aux.id).not.toBe(main.id);
  const trace=await createTraceabilityService(db()).trace(x.loaded,'purchaseToStock',x.po.id);
  expect(trace.summary).toMatchObject({receiptCount:1,movementCount:1,itemCount:1});
  expect(trace.edges).toContainEqual({from:posted.receipt.id,to:stored.movements[0].id,relation:'has_stock_movement'});
  const reverse=await createTraceabilityService(db()).trace(x.loaded,'purchaseToStock',stored.items[0].id);
  expect(reverse.summary).toMatchObject({receiptCount:1,poCount:1});
 });
 it('MW04 accepted0 is a real rejection without a warehouse or any inbound stock',async()=>{
  const x=await fixture('rejected'),res=await submit(x,input(x,0,10));expect(res.status,JSON.stringify(res.body)).toBe(201);expect(res.body.receipt).toMatchObject({status:'Rejected',warehouseId:null});
  expect((await state(x)).items).toHaveLength(0);expect((await state(x)).movements).toHaveLength(0);
 });
 it('MW05 no Main uses actual Auxiliary; exact completed receipt retry after stop cannot select another destination or post twice',async()=>{
  const x=await fixture('replay'),chosen=await warehouse(x,'aux','Auxiliary'),command=input(x),posted=await pending(x,command);expect(posted.receipt.warehouseId).toBe(chosen.id);
  expect((await execute(db(),posted.event)).ok).toBe(true);await db().warehouse.update({where:{id:chosen.id},data:{isActive:false}});await warehouse(x,'later-main');
  const before=await state(x),wake=crashWake();const replay=await submit(x,command);wake.mockRestore();expect(replay.status,JSON.stringify(replay.body)).toBe(201);expect(replay.body.receipt.id).toBe(posted.receipt.id);expect(replay.body.receipt.warehouseId).toBe(chosen.id);
  expect((await execute(db(),posted.event)).ok).toBe(true);expect(await state(x)).toEqual(before);
 });
 it('MW06 actual mandatory receipt audit SQL P2003 is safe HTTP500 and rolls back all receipt/outbox/quantity writes',async()=>{
  const x=await fixture('audit'),chosen=await warehouse(x,'main'),before=await state(x),fault=faultAudit(x.actorId,'create_material_receipt');const res=await submit(x,input(x,10,0,{warehouseId:chosen.id}),fault.client);
  expect(res.status,JSON.stringify(res.body)).toBe(500);expect(res.body.code).toBe('INTERNAL_ERROR');expect(res.body.error).toContain('结果暂不可确认');expect(JSON.stringify(res.body)).not.toMatch(/P2003|Prisma|missing-actor|已回滚|未写入/);expect(fault.observed).toEqual({count:1,code:'P2003'});expect(await state(x)).toEqual(before);
 });
 it('MW07 second-line mixed currency refuses the entire L8 stock batch; committed receipt stays queued rather than pretending posted',async()=>{
  const x=await fixture('mixed',true),wh=await warehouse(x,'main');const old=await createInventoryService(db()).createInventoryItem({warehouseId:wh.id,materialCode:x.po.lines[1].materialCode!,description:'Other-currency source',quantity:0,unit:'M',unitCost:2.5,currency:'CNY'},x.actorId);
  const posted=await pending(x,input(x,20,0,{lineReceipts:x.po.lines.map(line=>({lineId:line.id,accepted:10,rejected:0}))})),before=await state(x),result=await execute(db(),posted.event);
  expect(result.ok).toBe(false);expect(result.error).toContain('币种');expect(await state(x)).toEqual(before);expect((await db().inventoryItem.findUniqueOrThrow({where:{id:old.id}})).quantity.toString()).toBe('0');
 });
 it('MW08 actual L8 audit FK failure leaves no partial stock; native crash recovery later completes the original queued job exactly once',async()=>{
  const x=await fixture('recover'),wh=await warehouse(x,'main'),posted=await pending(x,input(x,10,0,{warehouseId:wh.id})),before=await state(x),fault=faultAudit(x.actorId,'stock_in_material_receipt');
  expect((await execute(fault.client,posted.event)).ok).toBe(false);expect(fault.observed).toEqual({count:1,code:'P2003'});expect(await state(x)).toEqual(before);
  await createCrashRecoveryTask().run(db());const after=await state(x);expect(after.items).toHaveLength(1);expect(after.movements).toHaveLength(1);expect(after.items[0].quantity.toString()).toBe('10');expect((await db().agentJob.findUniqueOrThrow({where:{id:posted.job.id}})).status).toBe('completed');
  const receipt=await db().materialReceipt.findUniqueOrThrow({where:{id:posted.receipt.id}});expect(receipt).toEqual(posted.receipt);await createCrashRecoveryTask().run(db());expect(await state(x)).toEqual(after);
 });
 it('MW09 forged event destination and mismatched source currency refuse without any stock writes',async()=>{
  const x=await fixture('event-tamper'),wh=await warehouse(x,'main'),other=await warehouse(x,'other','Auxiliary'),posted=await pending(x,input(x,10,0,{warehouseId:wh.id})),before=await state(x);
  expect((await execute(db(),{...posted.event,payload:{...posted.event.payload,warehouseId:other.id}})).ok).toBe(false);expect(await state(x)).toEqual(before);
  expect((await execute(db(),{...posted.event,payload:{...posted.event.payload,currency:'CNY'}})).ok).toBe(false);expect(await state(x)).toEqual(before);
 });
 it('MW10 synthetic old no-warehouse queued receipt recovers from its actual audit, and exact old PurchaseOrder receipt markers replay without duplication',async()=>{
  const x=await fixture('legacy'),receiptId=`${x.id}-legacy`,now=Date.now(),event:BusinessEvent={id:`bev_material_received_${receiptId}`,type:'MaterialReceived',sourceEntityType:'PurchaseOrder',sourceEntityId:x.po.id,actorId:x.actorId,occurredAt:now,payload:{purchaseOrderId:x.po.id,receiptId}};
  // This is explicitly a pre-upgrade storage-shape fixture, not a new native
  // receipt producer proof. No posting/approval fact is invented.
  await db().materialReceipt.create({data:{id:receiptId,receiptNumber:`${x.id}-old-MR`,purchaseOrderId:x.po.id,status:'Accepted',receivedDate:'2026-10-02',totalReceived:3,totalAccepted:3,totalRejected:0,createdAt:BigInt(now)}});
  await db().auditLog.create({data:{id:`${x.id}-legacy-audit`,actorId:x.actorId,action:'create_material_receipt',targetType:'PurchaseOrder',targetId:x.po.id,detail:{after:{receiptId,lineReceipts:[{lineId:x.po.lines[0].id,accepted:3,rejected:0}]}},createdAt:new Date()}});
  await db().agentJob.create({data:{id:event.id!,jobType:'bev:MaterialReceived',status:'queued',priority:5,payload:JSON.parse(JSON.stringify(event)),scheduledAt:new Date(now)}});
  const receipt=await db().materialReceipt.findUniqueOrThrow({where:{id:receiptId}});await createCrashRecoveryTask().run(db());expect((await db().agentJob.findUniqueOrThrow({where:{id:event.id!}})).status).toBe('queued');expect((await state(x)).items).toHaveLength(0);
  const wh=await warehouse(x,'restore');await createCrashRecoveryTask().run(db());let stored=await state(x);expect(stored.items).toHaveLength(1);expect(stored.items[0].quantity.toString()).toBe('3');expect(stored.items[0].currency).toBe('USD');expect((await db().materialReceipt.findUniqueOrThrow({where:{id:receiptId}}))).toEqual(receipt);
  const movement=stored.movements[0];await db().stockMovement.update({where:{id:movement.id},data:{referenceType:'PurchaseOrder'}}); // Declared old-type compatibility fixture only.
  businessEventBus.reset();businessEventBus.setPrisma(db());registerL8AutoStockIn();await db().agentJob.update({where:{id:event.id!},data:{status:'queued',completedAt:null}});
  await db().warehouse.update({where:{id:wh.id},data:{isActive:false}});await createCrashRecoveryTask().run(db());stored=await state(x);expect(stored.movements).toHaveLength(1);expect(stored.items[0].quantity.toString()).toBe('3');expect((await db().agentJob.findUniqueOrThrow({where:{id:event.id!}})).status).toBe('completed');
  const scope=await createOperationalReadAccess(db(),x.loaded).stockMovementWhere();expect(await db().stockMovement.count({where:{AND:[{id:movement.id},scope]}})).toBe(1);
  await db().order.update({where:{id:x.orderId},data:{ownerId:null}});const hidden=await createOperationalReadAccess(db(),x.loaded).stockMovementWhere();expect(await db().stockMovement.count({where:{AND:[{id:movement.id},hidden]}})).toBe(0);
 });
 it('MW11 finite receipt validation remains HTTP400 and leaves all real state unchanged',async()=>{
  const x=await fixture('validation'),wh=await warehouse(x,'main');
  for(const patch of [{receivedDate:'2026-02-30'},{totalReceived:11},{lineReceipts:[{lineId:`${x.id}-foreign`,accepted:10,rejected:0}]}]){
   const before=await state(x),res=await submit(x,input(x,10,0,{warehouseId:wh.id,...patch}));
   expect(res.status,JSON.stringify(res.body)).toBe(400);expect(res.body.code).toBe('VALIDATION_FAILED');expect(res.body.error).toBeTruthy();expect(await state(x)).toEqual(before);
  }
 });
 it('MW12 actual missing-column SQL containing old message keywords stays safe HTTP500 with zero receipt/outbox writes',async()=>{
  const x=await fixture('sql-keyword'),wh=await warehouse(x,'main'),before=await state(x),fault=faultWarehouseSql();
  const res=await submit(x,input(x,10,0,{warehouseId:wh.id}),fault.client);
  expect(res.status,JSON.stringify(res.body)).toBe(500);expect(res.body.code).toBe('INTERNAL_ERROR');expect(res.body.error).toContain('结果暂不可确认');
  expect(JSON.stringify(res.body)).not.toMatch(/P2010|42703|Prisma|仅不存在|storage-probe|SELECT|已回滚|未写入/);
  expect(fault.observed).toEqual({count:1,code:'P2010',sqlState:'42703'});expect(await state(x)).toEqual(before);
 });
 it('MW13 native purchase validation is HTTP400; actual mandatory creation audit P2003 is safe HTTP500 and rolls back the new order',async()=>{
  const x=await fixture('po-boundary');
  const body={poNumber:`${x.id}-new`,orderId:x.orderId,currency:'USD',orderDate:'2026-10-02',lines:[{kind:'Material',description:'Synthetic material',quantity:10,unit:'M',unitPrice:2.5}]};
  const snapshot=async()=>({orders:await db().purchaseOrder.findMany({where:{orderId:x.orderId},include:{lines:true},orderBy:{id:'asc'}}),audits:await db().auditLog.findMany({where:{actorId:x.actorId},orderBy:{id:'asc'}})});
  const before=await snapshot();
  const invalid=await request(app()).post('/api/v1/procurement').set('Authorization',`Bearer ${x.token}`).send({...body,lines:[{...body.lines[0],kind:'ForgedType'}]});
  expect(invalid.status,JSON.stringify(invalid.body)).toBe(400);expect(invalid.body.code).toBe('VALIDATION_FAILED');expect(await snapshot()).toEqual(before);
  const fault=faultAudit(x.actorId,'create_purchase_order');
  const failed=await request(app(fault.client)).post('/api/v1/procurement').set('Authorization',`Bearer ${x.token}`).send(body);
  expect(failed.status,JSON.stringify(failed.body)).toBe(500);expect(failed.body.code).toBe('INTERNAL_ERROR');expect(JSON.stringify(failed.body)).not.toMatch(/P2003|Prisma|missing-actor|已回滚|未写入/);
  expect(fault.observed).toEqual({count:1,code:'P2003'});expect(await snapshot()).toEqual(before);
  const retry=await request(app()).post('/api/v1/procurement').set('Authorization',`Bearer ${x.token}`).send(body);
  expect(retry.status,JSON.stringify(retry.body)).toBe(201);expect(await db().purchaseOrder.count({where:{poNumber:body.poNumber}})).toBe(1);
 });
 it('MW14 real SQL with the old procurement-validation keyword cannot be downgraded or exposed',async()=>{
  const x=await fixture('po-sql-keyword'),observed:{code?:string;sqlState?:string}={};
  const faulty=new Proxy(db(),{get(base,key){
   if(key==='factoryProfile')return new Proxy(base.factoryProfile,{get(model,method){
    if(method==='findUnique')return async()=>{try{return await base.$queryRaw(Prisma.sql`SELECT "采购明细-storage-probe" FROM "FactoryProfile"`);}catch(error:any){observed.code=error.code;observed.sqlState=error.meta?.code;throw error;}};
    const value=Reflect.get(model,method);return typeof value==='function'?value.bind(model):value;
   }});
   const value=Reflect.get(base,key);return typeof value==='function'?value.bind(base):value;
  }});
  const body={poNumber:`${x.id}-new`,orderId:x.orderId,supplierRelationId:`${x.id}-synthetic`,currency:'USD',orderDate:'2026-10-02',lines:[{kind:'Material',description:'Synthetic material',quantity:10,unit:'M',unitPrice:2.5}]},before=await state(x);
  const res=await request(app(faulty)).post('/api/v1/procurement').set('Authorization',`Bearer ${x.token}`).send(body);
  expect(res.status,JSON.stringify(res.body)).toBe(500);expect(res.body.code).toBe('INTERNAL_ERROR');expect(JSON.stringify(res.body)).not.toMatch(/P2010|42703|Prisma|采购明细-storage-probe|SELECT/);
  expect(observed).toEqual({code:'P2010',sqlState:'42703'});expect(await db().purchaseOrder.count({where:{poNumber:body.poNumber}})).toBe(0);expect(await state(x)).toEqual(before);
 });
});
