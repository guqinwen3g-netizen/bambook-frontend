import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { exactJsonValue } from '../lib/exactJsonValue';
import { logger } from '../lib/logger';
import { parseNonNegativeDecimal } from '../shared/moneyInput';
import { currentProformaActor } from './proformaInvoiceAccess';
import { assertOrdinaryBillingCreateSources } from '../development/developmentBillingRouteAccess';
import { BILLING_SOURCE_TYPES, createBillingItemInTx } from './billingItemService';

const OPERATION = 'create_billing_item';
const RECEIPT_ACTION = 'billing_item_create_receipt';
const SOURCE = 'route:billing:create-command';
const models: Record<string, string> = { DevelopmentCase:'developmentCase',Order:'order',OrderLine:'orderLine',Sample:'sample',
  SampleBatch:'sampleBatch',SealSample:'sealSample',CostRecord:'costRecord',Shipment:'shipment',Quotation:'quotation' };
type Source = { type:string; id:string; row:any };
type Graph = { sources:Source[]; signature:string };
export type BillingCreateAcknowledgement = { schemaVersion:1; operation:typeof OPERATION; actorId:string; requestKey:string;
  commandSnapshot:Record<string,unknown>; commandHash:string; billingItemId:string; receiptAuditId:string; billingItemHash:string; originalAuditId:string; originalAuditHash:string };
type Success = { billingItem:any; acknowledgement:BillingCreateAcknowledgement; replayed:boolean };
type Result = { ok:true; data:Success } | { ok:false; error:{code:string;message:string;status:number} };
function reject(code:string,message:string):never { throw businessError(code,message); }
function sorted(value:any):any { return Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value; }
/** Exact native JSON, normalized before the application's Number toJSON hooks. */
export function billingCreateDigest(value:unknown):string { return createHash('sha256').update(JSON.stringify(sorted(exactJsonValue(value)))).digest('hex'); }
function plain(raw:unknown):raw is Record<string,unknown> { return !!raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.getPrototypeOf(raw)===Object.prototype; }
const fields = ['sourceType','sourceId','chargeType','amount','currency','bearerType','bearerRelationId','costRecordId',
  'waivedAmount','offsetAmount','offsetOrderId','notes','registerCost'];
function commandInput(raw:unknown):{requestKey:string;input:Record<string,any>} {
  if(!plain(raw)||Object.keys(raw).some(key=>!fields.includes(key)&&key!=='requestKey'))reject('INVALID_INPUT','收费创建字段无效，请核对原请求。');
  if(typeof raw.requestKey!=='string'||!raw.requestKey.trim()||raw.requestKey.length>128)reject('INVALID_INPUT','请提供稳定的收费创建请求标识。');
  if(typeof raw.sourceType!=='string'||!BILLING_SOURCE_TYPES.includes(raw.sourceType as any)||typeof raw.sourceId!=='string'||!raw.sourceId.trim())
    reject('INVALID_INPUT','请提供真实的收费来源。');
  const input:Record<string,any>={};
  for(const key of fields)if(Object.prototype.hasOwnProperty.call(raw,key))input[key]=raw[key];
  for(const[key,value]of Object.entries(input)){
    if(['amount','waivedAmount','offsetAmount'].includes(key)){
      if(value!=null&&typeof value!=='string'&&typeof value!=='number')reject('INVALID_AMOUNT','收费金额必须是明确的十进制金额。');
    }else if(key==='registerCost'){
      if(!plain(value)||Object.keys(value).some(field=>!['costType','amount','currency','incurredAt','bearerType','bearerRelationId','notes'].includes(field)))reject('INVALID_INPUT','成本登记字段无效。');
      for(const[field,item]of Object.entries(value))if(field==='amount'?typeof item!=='number'&&typeof item!=='string':item!=null&&typeof item!=='string')reject('INVALID_INPUT','成本登记字段类型无效。');
    }else if(value!=null&&typeof value!=='string')reject('INVALID_INPUT','收费创建字段类型无效。');
  }
  // Omission, explicit zero and null remain distinct original parameters.
  return {requestKey:raw.requestKey,input:exactJsonValue(input)};
}
function receiptId(actorId:string,key:string){return 'billing-create:'+billingCreateDigest({operation:OPERATION,actorId,requestKey:key});}
function binding(source:Source){const r=source.row;return [source.type,source.id,r.sourceType??null,r.sourceId??null,r.sourceCaseId??null,
  r.sourceOrderId??null,r.developmentCaseId??null,r.orderId??null,r.orderLineId??null,r.convertedOrderId??null,r.customerRelationId??null];}
async function readGraph(tx:any,input:Record<string,any>):Promise<Graph>{
  const found=new Map<string,Source>(); const shipmentLinks:any[]=[];
  async function visit(type:string,id:string,path:Set<string>):Promise<void>{
    const key=type+':'+id;
    if(path.has(key))reject('CONFLICT','收费来源关联循环，请核对原单。');
    if(found.has(key))return;
    if(!Object.prototype.hasOwnProperty.call(models,type)||typeof id!=='string'||!id)reject('NOT_FOUND','收费来源不存在或无权操作。');
    const row=type==='OrderLine'?await tx[models[type]].findUnique({where:{id}}):await tx[models[type]].findFirst({where:{id,deletedAt:null}});
    if(!row||row.deletedAt!=null)reject('NOT_FOUND','收费来源不存在或无权操作。');
    found.set(key,{type,id,row});const next=new Set(path);next.add(key);
    if(type==='CostRecord')await visit(row.sourceType,row.sourceId,next);
    if(type==='Sample'&&row.sourceCaseId)await visit('DevelopmentCase',row.sourceCaseId,next);
    if(type==='Sample'&&row.sourceOrderId)await visit('Order',row.sourceOrderId,next);
    if(['SampleBatch','SealSample','Quotation'].includes(type)&&row.developmentCaseId)await visit('DevelopmentCase',row.developmentCaseId,next);
    if(['OrderLine','Quotation'].includes(type)&&row.orderId)await visit('Order',row.orderId,next);
    if(type==='Quotation'&&row.orderLineId)await visit('OrderLine',row.orderLineId,next);
    if(type==='Quotation'&&row.convertedOrderId)await visit('Order',row.convertedOrderId,next);
    if(type==='Shipment'){
      if(row.orderId)await visit('Order',row.orderId,next);
      const links=await tx.shipmentOrderAllocation.findMany({where:{shipmentId:id},orderBy:{id:'asc'}});
      for(const link of links){
        shipmentLinks.push([link.id,link.shipmentId,link.orderId,link.orderLineId??null]);await visit('Order',link.orderId,next);
        if(link.orderLineId){await visit('OrderLine',link.orderLineId,next);if(found.get('OrderLine:'+link.orderLineId)!.row.orderId!==link.orderId)reject('CONFLICT','运单来源订单行关联需要核对。');}
      }
    }
  }
  await visit(input.sourceType,input.sourceId,new Set());
  if(input.costRecordId)await visit('CostRecord',input.costRecordId,new Set());
  if(input.offsetOrderId)await visit('Order',input.offsetOrderId,new Set());
  const priority=(type:string)=>['DevelopmentCase','Order'].includes(type)?0:type==='CostRecord'?2:1;
  const sources=[...found.values()].sort((a,b)=>priority(a.type)-priority(b.type)||a.type.localeCompare(b.type)||a.id.localeCompare(b.id));
  return {sources,signature:billingCreateDigest({sources:sources.map(binding),shipmentLinks:shipmentLinks.sort((a,b)=>a[0].localeCompare(b[0]))})};
}
async function graph(tx:any,input:Record<string,any>):Promise<Graph>{
  try{return await readGraph(tx,input);}catch(error){
    if(isBusinessError(error))throw error;
    logger.error('[billing-create-source] failed',{error});
    return reject('DEPENDENCY_CHECK_FAILED','收费来源暂时无法核对，请保留原请求稍后重试。');
  }
}
async function lockSources(tx:any,before:Graph){
  // Match the existing native writers: Case -> Seal/Sample/Batch -> Order ->
  // Line -> Quotation/Shipment -> Cost. Ship Samples take Sample before Order;
  // Shipment consumers retain Order before Shipment. Sorting the lock plan
  // separately keeps persisted source signatures and original ACKs unchanged.
  const rank:Record<string,number>={DevelopmentCase:0,SealSample:1,Sample:2,SampleBatch:3,Order:4,OrderLine:5,Quotation:6,Shipment:7,CostRecord:8};
  const plan=[...before.sources].sort((a,b)=>rank[a.type]-rank[b.type]||a.id.localeCompare(b.id));
  for(const source of plan){
    // A closed server whitelist, never an HTTP table/SQL fragment.
    const locked=await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw('"'+source.type+'"')} WHERE "id"=${source.id} FOR UPDATE`);
    if(!locked.length)reject('NOT_FOUND','收费来源不存在或无权操作。');
  }
}
async function authorize(tx:any,actor:TokenPayload,input:Record<string,any>,sources:Graph){
  const current=await currentProformaActor(tx,actor.userId,actor);
  await assertOrdinaryBillingCreateSources(tx,current,sources.sources,{sourceType:input.sourceType,sourceId:input.sourceId});return current;
}
/** Run after the final producer/audit/receipt await in the caller's TX. A
 * current account/grant/share refusal aborts new facts and refuses old ACKs. */
async function assertFinalAuthority(tx:any,actor:TokenPayload,input:Record<string,any>,locked:Graph){
  const current=await graph(tx,input);
  if(current.signature!==locked.signature)reject('CONFLICT','收费来源关联已变化，请保留原请求核对。');
  await authorize(tx,actor,input,current);
}
function originalAuditFact(row:any){return exactJsonValue(row);}
function exactBilling(row:any){
  const result=exactJsonValue(row);const net=new Prisma.Decimal(row.amount).minus(row.waivedAmount??0).minus(row.offsetAmount??0);
  return {...result,netAmount:net.toString(),netAmountExact:net.toFixed(4)};
}
function readReceipt(row:any,id:string,actorId:string,key:string,input:Record<string,any>):Success{
  const after=row?.detail?.after;const receipt=after?.ack;const command={schemaVersion:1,operation:OPERATION,actorId,requestKey:key,input};
  if(row.id!==id||row.actorId!==actorId||row.action!==RECEIPT_ACTION||row.targetType!=='BillingItem'||row.detail?.source!==SOURCE
    ||!receipt||after.commandHash!==billingCreateDigest(command)||billingCreateDigest(after.command)!==billingCreateDigest(command))reject('CONFLICT','原收费请求与当前参数或历史回执不一致，请保留原请求核对。');
  const ack=receipt.acknowledgement;
  if(ack?.schemaVersion!==1||ack.operation!==OPERATION||ack.actorId!==actorId||ack.requestKey!==key||ack.receiptAuditId!==id
    ||ack.commandHash!==after.commandHash||billingCreateDigest(ack.commandSnapshot)!==billingCreateDigest(input)
    ||!receipt.billingItem?.id||receipt.billingItem.id!==row.targetId||ack.billingItemId!==row.targetId
    ||typeof ack.originalAuditId!=='string'||!ack.originalAuditId||ack.originalAuditId!==after.originalAuditId
    ||typeof ack.originalAuditHash!=='string'||!/^([a-f0-9]{64})$/.test(ack.originalAuditHash)||ack.originalAuditHash!==after.originalAuditHash
    ||ack.billingItemHash!==billingCreateDigest(receipt.billingItem)||after.ackHash!==billingCreateDigest(receipt))reject('CONFLICT','原收费创建回执不完整，请保留原请求核对。');
  return {...receipt,replayed:true};
}
async function lockCommand(tx:any,actor:TokenPayload,input:Record<string,any>,key:string){
  await currentProformaActor(tx,actor.userId,actor);
  const before=await graph(tx,input);await authorize(tx,actor,input,before);await lockSources(tx,before);
  let current=await graph(tx,input);
  if(current.signature!==before.signature)reject('CONFLICT','收费来源关联已变化，请保留原请求核对。');
  const id=receiptId(actor.userId,key);
  // transactionId is only indexed. The actual PK + transaction advisory lock
  // serialize two same-key writers. Different keys remain separate decisions.
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text`);
  current=await graph(tx,input);
  if(current.signature!==before.signature)reject('CONFLICT','收费来源关联已变化，请保留原请求核对。');
  const effectiveActor=await authorize(tx,actor,input,current);
  const prior=await tx.auditLog.findUnique({where:{id}});
  // The native creation audit survives an independently missing/displaced
  // receipt. A surviving key fact cannot be classified as never applied.
  const traces=await tx.auditLog.findMany({where:{OR:[
    // Stable server anchors remain relevant even when a residual actor field
    // has been corrupted. Such history cannot prove an unapplied request.
    {transactionId:id},
    {detail:{path:['ordinaryCreateRequest','receiptAuditId'],equals:id}},
    {actorId:actor.userId,action:OPERATION,detail:{path:['ordinaryCreateRequest','requestKey'],equals:key}},
    {actorId:actor.userId,action:{in:[RECEIPT_ACTION,'billing_item_create_retired']},detail:{path:['after','command','requestKey'],equals:key}},
  ]}});
  const expected=new Set(prior?[id,...(prior.action===RECEIPT_ACTION?[prior.detail?.after?.originalAuditId]:[])]:[]);
  if(traces.some((row:any)=>!expected.has(row.id)))reject('CONFLICT','原收费请求仍有已提交或损坏的历史事实，请保留原请求核对。');
  return {before,current,id,effectiveActor,prior};
}
async function replayCreation(tx:any,prior:any,id:string,actor:TokenPayload,input:Record<string,any>,key:string,current:Graph):Promise<Success>{
    const receipt=readReceipt(prior,id,actor.userId,key,input);
    if(prior.detail.after.sourceSignature!==current.signature)reject('CONFLICT','原收费来源父项已变化，请保留原请求核对。');
    const original=await tx.auditLog.findUnique({where:{id:prior.detail.after.originalAuditId}});
    if(!original||original.actorId!==actor.userId||original.action!==OPERATION||original.targetType!=='BillingItem'||original.targetId!==receipt.billingItem.id
      ||original.transactionId!==id||original.detail?.ordinaryCreateRequest?.receiptAuditId!==id
      ||original.detail?.ordinaryCreateRequest?.actorId!==actor.userId||original.detail?.ordinaryCreateRequest?.requestKey!==key
      ||original.detail?.ordinaryCreateRequest?.commandHash!==prior.detail.after.commandHash
      ||billingCreateDigest(original.detail?.ordinaryCreateRequest?.command)!==billingCreateDigest(prior.detail.after.command)
      ||prior.detail.after.originalAuditHash!==billingCreateDigest(originalAuditFact(original))
      ||!await tx.billingItem.findUnique({where:{id:receipt.billingItem.id}}))reject('CONFLICT','原收费创建事实或必需审计无法核对，请保留原请求。');
    await assertFinalAuthority(tx,actor,input,current);
    return receipt; // Mutable BI state never replaces the original creation ACK.
}
/** Ordinary HTTP commands may not acknowledge a rounded Decimal(18,4).
 * Replay above this check remains the original frozen receipt, not today's
 * mutable default. Internal/resale kernel callers retain their own contract. */
function assertOrdinaryMoney(input:Record<string,any>){
  for(const [field,label]of [['amount','收费金额'],['waivedAmount','免收金额'],['offsetAmount','抵货款金额']]){
    if(input[field]==null)continue;
    const read=parseNonNegativeDecimal(input[field],label);
    if(!read.ok)reject('INVALID_AMOUNT',read.message);
    const amount=new Prisma.Decimal(read.value);
    if(amount.decimalPlaces()>4||amount.gte('100000000000000'))reject('INVALID_AMOUNT',`${label}最多4位小数，且必须小于100000000000000。`);
  }
}
async function createInTx(tx:any,actor:TokenPayload,input:Record<string,any>,key:string,ip?:string|null):Promise<Success>{
  const {before,current,id,effectiveActor,prior}=await lockCommand(tx,actor,input,key);
  if(prior){
    if(prior.action==='billing_item_create_retired'){readRetirement(prior,id,actor,input,key,current);await assertFinalAuthority(tx,actor,input,current);reject('CONFLICT','原收费创建请求已安全结束，请使用新的明确请求。');}
    return replayCreation(tx,prior,id,actor,input,key,current);
  }
  const effectiveInput={...input};const source=current.sources.find(s=>s.type===input.sourceType&&s.id===input.sourceId)!.row;
  if(input.amount==null){
    const amount=input.sourceType==='CostRecord'?source.amount:input.sourceType==='DevelopmentCase'?source.sampleShippingFee:
      input.sourceType==='Shipment'?source.freightAmount:['Sample','SampleBatch'].includes(input.sourceType)?source.shippingFee:null;
    if(amount!=null)effectiveInput.amount=amount.toString();
  }
  assertOrdinaryMoney(effectiveInput);
  const made=await createBillingItemInTx(tx,{input:effectiveInput as any,actorId:effectiveActor.userId,trustedActor:effectiveActor,ip});
  const row=await tx.billingItem.findUnique({where:{id:made.id}});if(!row)reject('CONFLICT','收费创建结果无法核对，请保留原请求。');
  // A real PG fault swallowed by a legacy optional description read cannot
  // commit the aborted transaction: source/auth/audit checks still run in TX.
  const afterSource=await graph(tx,input);
  if(afterSource.signature!==before.signature)reject('CONFLICT','收费来源关联已变化，请保留原请求核对。');
  await authorize(tx,actor,input,afterSource);
  const audits=await tx.auditLog.findMany({where:{action:OPERATION,targetType:'BillingItem',targetId:row.id}});
  if(audits.length!==1||audits[0].actorId!==actor.userId||audits[0].detail?.source!=='route:billing')reject('CONFLICT','收费创建必需审计无法核对。');
  const billingItem=exactBilling(row),command={schemaVersion:1,operation:OPERATION,actorId:actor.userId,requestKey:key,input};
  const commandHash=billingCreateDigest(command);
  // Add an independent command anchor to this newly created native audit
  // before THIS transaction commits. Never rewrite committed audit history.
  const auditId=audits[0].id;
  if(typeof auditId!=='string'||!auditId)reject('CONFLICT','收费创建必需审计无法核对。');
  const auditLock=await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "AuditLog" WHERE "id"=${auditId} FOR UPDATE`);
  const nativeAudit=await tx.auditLog.findUnique({where:{id:auditId}});
  if(!auditLock.length||!nativeAudit||nativeAudit.actorId!==actor.userId||nativeAudit.action!==OPERATION||nativeAudit.targetType!=='BillingItem'
    ||nativeAudit.targetId!==row.id||nativeAudit.detail?.source!=='route:billing'||nativeAudit.detail?.ordinaryCreateRequest!=null
    ||nativeAudit.transactionId!=null)reject('CONFLICT','收费创建必需审计无法核对。');
  const boundAudit=await tx.auditLog.update({where:{id:auditId},data:{transactionId:id,detail:{...nativeAudit.detail,
    ordinaryCreateRequest:{schemaVersion:1,operation:OPERATION,actorId:actor.userId,requestKey:key,receiptAuditId:id,command,commandHash}}}});
  const originalAuditHash=billingCreateDigest(originalAuditFact(boundAudit));
  const ack:Success={billingItem,replayed:false,acknowledgement:{schemaVersion:1,operation:OPERATION,actorId:actor.userId,requestKey:key,
    commandSnapshot:input,commandHash,billingItemId:row.id,receiptAuditId:id,billingItemHash:billingCreateDigest(billingItem),originalAuditId:auditId,originalAuditHash}};
  await tx.auditLog.create({data:{id,actorId:actor.userId,action:RECEIPT_ACTION,targetType:'BillingItem',targetId:row.id,
    detail:{source:SOURCE,after:{command,commandHash,sourceSignature:afterSource.signature,sourceBindings:afterSource.sources.map(binding),originalAuditId:audits[0].id,
      originalAuditHash,ack,ackHash:billingCreateDigest(ack)}},
    operationType:'create',transactionId:id,ip:ip??null}});
  await assertFinalAuthority(tx,actor,input,afterSource);
  return ack;
}
/** Ordinary HTTP only: resale/whole-case callers retain their domain kernel. */
export async function createBillingItemCommand(params:{prisma:any;actor:TokenPayload|null;input:unknown;ip?:string|null}):Promise<Result>{
  try{
    if(!params.actor?.userId)reject('UNAUTHORIZED','请登录后创建收费决定。');
    const {input,requestKey}=commandInput(params.input);
    const data=await params.prisma.$transaction((tx:any)=>createInTx(tx,params.actor!,input,requestKey,params.ip),{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
    return {ok:true,data};
  }catch(error){
    if(!isBusinessError(error))logger.error('[billing-create-command] failed',{error});
    const safe=safeRouteError(error,{fallbackCode:'CREATE_FAILED',fallbackMessage:'创建收费决定暂时失败，请保留原请求稍后核对。'});
    return {ok:false,error:{code:safe.code,message:safe.message,status:safe.status}};
  }
}


type Retirement = {retired:true;replayed:boolean;acknowledgement:{schemaVersion:1;operation:'retire_billing_item_create';actorId:string;
  requestKey:string;commandSnapshot:Record<string,unknown>;commandHash:string;receiptAuditId:string;retirementRequestKey:string;reason:string;retirementHash:string}};
function readRetirement(row:any,id:string,actor:TokenPayload,input:Record<string,any>,key:string,current:Graph,retirement?:{retirementRequestKey:string;reason:string}):Retirement{
  const after=row?.detail?.after, result=after?.ack, ack=result?.acknowledgement;
  const command={schemaVersion:1,operation:OPERATION,actorId:actor.userId,requestKey:key,input};
  if(row.actorId!==actor.userId||row.id!==id||row.action!=='billing_item_create_retired'||row.targetType!=='BillingCreateRequest'||row.targetId!==id
    ||row.detail?.source!==SOURCE||after?.sourceSignature!==current.signature||after?.commandHash!==billingCreateDigest(command)
    ||billingCreateDigest(after?.command)!==billingCreateDigest(command)||!result?.retired||ack?.schemaVersion!==1
    ||ack.operation!=='retire_billing_item_create'||ack.actorId!==actor.userId||ack.requestKey!==key||ack.receiptAuditId!==id
    ||ack.commandHash!==after.commandHash||billingCreateDigest(ack.commandSnapshot)!==billingCreateDigest(input)
    ||typeof ack.retirementRequestKey!=='string'||!ack.retirementRequestKey||typeof ack.reason!=='string'||!ack.reason
    ||ack.retirementHash!==billingCreateDigest({schemaVersion:1,operation:'retire_billing_item_create',actorId:actor.userId,requestKey:key,input,
      retirementRequestKey:ack.retirementRequestKey,reason:ack.reason})||after.ackHash!==billingCreateDigest(result)
    ||retirement&&(ack.retirementRequestKey!==retirement.retirementRequestKey||ack.reason!==retirement.reason))
    reject('CONFLICT','原收费请求封存事实与参数无法核对，请保留原请求。');
  return {...result,replayed:true};
}
/** Same stable PK as creation: a late old writer cannot cross the committed
 * fence. A list absence or a prior 4xx never provides this guarantee. */
export async function retireBillingItemCreateCommand(params:{prisma:any;actor:TokenPayload|null;input:unknown;ip?:string|null}):Promise<
  {ok:true;data:Success|Retirement}|{ok:false;error:{code:string;message:string;status:number}}>{
  try{
    if(!params.actor?.userId)reject('UNAUTHORIZED','请登录后核对原收费请求。');
    const raw=params.input;
    if(!plain(raw)||Object.keys(raw).some(key=>!['input','requestKey','retirementRequestKey','reason'].includes(key))||!plain(raw.input)
      ||typeof raw.retirementRequestKey!=='string'||!raw.retirementRequestKey.trim()||raw.retirementRequestKey.length>128
      ||typeof raw.reason!=='string'||!raw.reason.trim()||raw.reason.length>1000)reject('INVALID_INPUT','请提供完整原请求、稳定核对标识与结束原因。');
    const {input,requestKey}=commandInput({...raw.input,requestKey:raw.requestKey});
    const retirement={retirementRequestKey:raw.retirementRequestKey,reason:raw.reason};
    const actor=params.actor;
    const data=await params.prisma.$transaction(async(tx:any)=>{
      const {id,current,prior}=await lockCommand(tx,actor,input,requestKey);
      if(prior){
        if(prior.action==='billing_item_create_retired'){const result=readRetirement(prior,id,actor,input,requestKey,current,retirement);await assertFinalAuthority(tx,actor,input,current);return result;}
        return replayCreation(tx,prior,id,actor,input,requestKey,current);
      }
      const command={schemaVersion:1,operation:OPERATION,actorId:actor.userId,requestKey,input};
      const ack:Retirement={retired:true,replayed:false,acknowledgement:{schemaVersion:1,operation:'retire_billing_item_create',actorId:actor.userId,
        requestKey,commandSnapshot:input,commandHash:billingCreateDigest(command),receiptAuditId:id,...retirement,
        retirementHash:billingCreateDigest({schemaVersion:1,operation:'retire_billing_item_create',actorId:actor.userId,requestKey,input,...retirement})}};
      await tx.auditLog.create({data:{id,actorId:actor.userId,action:'billing_item_create_retired',targetType:'BillingCreateRequest',targetId:id,
        detail:{source:SOURCE,after:{command,commandHash:billingCreateDigest(command),sourceSignature:current.signature,
          sourceBindings:current.sources.map(binding),ack,ackHash:billingCreateDigest(ack)}},operationType:'transition',transactionId:id,ip:params.ip??null}});
      await assertFinalAuthority(tx,actor,input,current);
      return ack;
    },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
    return {ok:true,data};
  }catch(error){
    if(!isBusinessError(error))logger.error('[billing-create-retire] failed',{error});
    const safe=safeRouteError(error,{fallbackCode:'CREATE_FAILED',fallbackMessage:'原收费请求暂时无法核对，请保留原请求。'});
    return {ok:false,error:{code:safe.code,message:safe.message,status:safe.status}};
  }
}
