import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { currentRegistrationActor } from './sampleRegistrationContextService';
import { businessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { productionBatchLineFingerprint, resolveCurrentProductionBatchFacts, ProductionBatchFactsError } from '../production/productionBatchFacts';
import { canonicalOrderSampleDecimal, canonicalOrderSampleUnit, type OrderSampleFamily } from './orderSampleSourceContract';
import { resolveOrderSampleParents, OrderSampleParentError, type OrderSampleParentRequest } from './orderSampleParentResolver';

const families: Record<OrderSampleFamily,string> = {fabric_ss:'fabric',fabric_rc:'fabric',fabric_eps:'fabric',garment_pp:'garment',garment_top:'garment',garment_ship:'garment'};
function fail(code:string,message:string):never { throw businessError(code as any,message); }
function validate(orderId:unknown,family:unknown) {
  if (typeof orderId!=='string'||!orderId||orderId.trim()!==orderId||orderId.length>256||/[\u0000-\u001f]/.test(orderId)) fail('INVALID_INPUT','请选择真实订单。');
  if(typeof family!=='string'||!Object.prototype.hasOwnProperty.call(families,family)) fail('INVALID_INPUT','请选择明确样品业务族。');
}
async function authorized(db:any, prior:TokenPayload|null|undefined, orderId:string,family:OrderSampleFamily) {
 const actor=await currentRegistrationActor(db,prior,'read');
 if(!hasScope({...actor,roles:[]},'orders:read')) fail('FORBIDDEN','当前账号没有订单读取权限。');
 const scope=await freshOrderLineScope(db,actor);
 const order=await db.order.findFirst({where:{id:orderId,deletedAt:null,AND:[scope]}});
 if(!order) fail('NOT_FOUND','订单不存在或不在当前可见范围。');
 const lane=typeof order.type==='string'?order.type.trim().toLowerCase():'';const declared=typeof order.businessLine==='string'?order.businessLine.trim().toLowerCase():'';
 if(!['fabric','garment'].includes(lane)||declared&&declared!==lane||families[family]!==lane) fail('CONFLICT','订单业务线与样品业务族不一致。');
 return order;
}
function finite(rows:any[]) {if(rows.length>128) fail('CONFLICT','订单来源超过完整读取预算，不能截断候选。');return rows;}
function exact(value:any,zero=false) {
 if(!Prisma.Decimal.isDecimal(value)&&typeof value!=='string') fail('CONFLICT','订单数量不是精确十进制记录。');
 return canonicalOrderSampleDecimal(value.toString(),zero);
}
async function result<T>(work:()=>Promise<T>) {
 try{return {ok:true as const,data:await work()};}
 catch(error){
  const e=error instanceof OrderSampleParentError||error instanceof ProductionBatchFactsError?businessError('CONFLICT',error.message):error;
  const safe=safeRouteError(e,{fallbackCode:'ORDER_SAMPLE_CONTEXT_FAILED',fallbackMessage:'订单样品来源暂时无法核对，请稍后重试。'});
  return {ok:false as const,error:{code:safe.code,message:safe.message,status:safe.status}};
 }
}
/** Read context is not a write grant. No inferred batch, default unit or parent
 * ancestry is returned. Permission and exact order visibility are refreshed
 * outside RepeatableRead before any candidate data is returned. */
export async function getOrderSampleContext(params:{prisma:any;actor:TokenPayload|null|undefined;orderId:string;family:OrderSampleFamily}) {
 return result(async()=>{
  validate(params.orderId,params.family);
  const data=await params.prisma.$transaction(async(tx:any)=>{
   const order=await authorized(tx,params.actor,params.orderId,params.family);
   const lines=finite(await tx.orderLine.findMany({where:{orderId:order.id},orderBy:{id:'asc'},take:129}));
   const batches=finite(await tx.productionBatch.findMany({where:{orderId:order.id},orderBy:{id:'asc'},take:129}));
   const lineViews=[];
   for(const l of lines){
    const reasons:string[]=[];let quantity:string|null=null,unit:string|null=null,lineFingerprint:string|null=null;
    try {quantity=exact(l.quantity);unit=canonicalOrderSampleUnit(l.unit);lineFingerprint=productionBatchLineFingerprint(order,l);}catch{reasons.push('INVALID_LINE_FACTS');}
    if(!l.confirmedSourceType||!l.confirmedSourceId||l.specSnapshot==null) reasons.push('CONFIRMED_PARENT_MISSING');
    if(params.family!=='garment_pp') reasons.push('REAL_PRODUCTION_BATCH_REQUIRED');
    let factoryRelationId=order.millRelationId??null;
    if(params.family==='garment_pp'&&!reasons.length){
     if(!factoryRelationId){
      if(l.confirmedSourceType==='Sample') factoryRelationId=(await tx.sample.findUnique({where:{id:l.confirmedSourceId}}))?.supplierRelationId??null;
      else if(l.confirmedSourceType==='SealSample') factoryRelationId=(await tx.sealSample.findUnique({where:{id:l.confirmedSourceId}}))?.supplierRelationId??null;
      else if(l.confirmedSourceType==='Asset') factoryRelationId=(await tx.productAsset.findUnique({where:{id:l.confirmedSourceId},include:{fabricProfile:true,garmentProfile:true}}))?.garmentProfile?.factoryRelationId??null;
     }
     if(!factoryRelationId) reasons.push('FACTORY_MISSING');
     else try {await resolveOrderSampleParents(tx,{family:params.family,orderId:order.id,factoryRelationId,coverage:[{orderLineId:l.id,expectedLineFingerprint:lineFingerprint!,productionBatchId:null,expectedBatchRevision:null,rangeStart:'0',quantity:quantity!,unit:unit!}]});}
     catch(error){if(error instanceof OrderSampleParentError) reasons.push('CONFIRMED_PARENT_UNAVAILABLE');else throw error;}
    }
    lineViews.push({id:l.id,quantity,unit,lineFingerprint,factoryRelationId,selectable:!reasons.length,blockedReasons:reasons});
   }
   const batchViews=[];
   for(const b of batches){
    const reasons:string[]=[];let quantity:string|null=null,rangeStart:string|null=null,unit:string|null=null,lineFingerprint:string|null=null;
    if(!lines.some((l:any)=>l.id===b.orderLineId)) reasons.push('ORDER_LINE_MISSING');
    if(b.state!=='active') reasons.push('BATCH_INACTIVE');
    if(!Number.isSafeInteger(b.revision)||b.revision<1) reasons.push('BATCH_REVISION_INVALID');
    const factory=b.factoryRelationId?await tx.relation.findFirst({where:{id:b.factoryRelationId,deletedAt:null},select:{id:true,name:true}}):null;
    if(!factory) reasons.push('FACTORY_MISSING');
    try {quantity=exact(b.quantity);rangeStart=exact(b.rangeStart,true);unit=canonicalOrderSampleUnit(b.unit);}catch{reasons.push('INVALID_BATCH_FACTS');}
    if(!reasons.length){
     try {const current=await resolveCurrentProductionBatchFacts(tx,{id:b.id,revision:b.revision});lineFingerprint=current.lineFingerprint;
      // Validate the real confirmed ancestor graph, not just nullable IDs.
      await resolveOrderSampleParents(tx,{family:params.family,orderId:order.id,factoryRelationId:b.factoryRelationId,coverage:[{orderLineId:b.orderLineId,expectedLineFingerprint:lineFingerprint!,productionBatchId:b.id,expectedBatchRevision:b.revision,rangeStart:rangeStart!,quantity:quantity!,unit:unit!}]});
     }catch(error){if(error instanceof ProductionBatchFactsError||error instanceof OrderSampleParentError) reasons.push('CONFIRMED_PARENT_UNAVAILABLE');else throw error;}
    }
    batchViews.push({id:b.id,lineId:b.orderLineId,factoryRelationId:b.factoryRelationId,factoryName:factory?.name??null,revision:b.revision,state:b.state,
     rangeStart,quantity,unit,lineFingerprint,sourceFingerprint:b.sourceFingerprint,selectable:!reasons.length,blockedReasons:reasons});
   }
   return {order:{id:order.id,businessLine:order.type.trim().toLowerCase()},family:params.family,lines:lineViews,batches:batchViews};
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  await authorized(params.prisma,params.actor,params.orderId,params.family);return data;
 });
}
export async function previewOrderSampleParents(params:{prisma:any;actor:TokenPayload|null|undefined;request:OrderSampleParentRequest}) {
 return result(async()=>{
  validate(params.request?.orderId,params.request?.family);
  const data=await params.prisma.$transaction(async(tx:any)=>{
   await authorized(tx,params.actor,params.request.orderId,params.request.family);
   const resolved=await resolveOrderSampleParents(tx,params.request);
   return {parentFingerprint:resolved.parentFingerprint,owner:resolved.owner,specSnapshot:resolved.specSnapshot,coverage:resolved.coverage,lines:resolved.lines,batches:resolved.batches};
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  await authorized(params.prisma,params.actor,params.request.orderId,params.request.family);return data;
 });
}
