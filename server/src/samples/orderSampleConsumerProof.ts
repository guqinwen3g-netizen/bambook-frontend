import { Prisma } from '@prisma/client';
import { canonicalOrderSampleDecimal, canonicalOrderSampleUnit, buildOrderSampleSource, orderSampleDigest, OrderSampleContractError, type OrderSampleFamily, type OrderSampleSource } from './orderSampleSourceContract';
import { orderSampleQcStoredReport } from './orderSampleQcEvidence';
import { loadOrderSampleRecord, OrderSampleRecordError } from './orderSampleRecordReader';
import { resolveOrderSampleParents, orderSampleOrderLane, OrderSampleParentError } from './orderSampleParentResolver';
import { resolveCurrentProductionBatchFacts, productionBatchLineFingerprint, ProductionBatchFactsError } from '../production/productionBatchFacts';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { productionLineCoverageMatches, type ProductionLineIdentity } from '../production/productionLineIdentity';
import { readBusinessErrorMint } from '../shared/errorCodes';

export type OrderSampleConsumerTarget = {kind:'production_batch'|'release_scope'|'shipment_allocation';id:string};
export type OrderSampleConsumerScope = {
  kind:OrderSampleConsumerTarget['kind'];id:string;orderId:string;orderLineId:string;factoryRelationId:string;productionBatchId:string|null;productionBatchRevision:number|null;
  rangeStart:string;quantity:string;unit:string;lineFingerprint:string;specFingerprint:string;targetFingerprint:string;
  productionLineMode?:ProductionLineIdentity['mode']|null;productionLineId?:string|null;productionLineRevision?:number|null;productionLineFingerprint?:string|null;
};
export type OrderSampleConsumerResult =
  | {mode:'legacy_mode';qualified:false;orderId:string;reason:'NO_NATIVE_ORDER_SOURCES'}
  | {mode:'optional_unenabled';qualified:false;enabled:false;scope:OrderSampleConsumerScope}
  | {mode:'native';qualified:false;enabled:true;reason:string;candidateSourceIds:string[];scope:OrderSampleConsumerScope|null}
  | {mode:'native';qualified:true;enabled:true;proof:OrderSampleConsumerProof};
export type OrderSampleConsumerProof = {
  schemaVersion:1;family:OrderSampleFamily;enabled:boolean;scope:OrderSampleConsumerScope;source:OrderSampleSource;head:{eventId:string;sequence:number};parentFingerprint:string;
  shipmentEvent:unknown;shipmentAudit:unknown;shipmentAcknowledgement:unknown;feedbackEvent:unknown;feedbackAudit:unknown;feedbackAcknowledgement:unknown;qcReport:unknown;qcReportAudit:unknown;proofFingerprint:string;
};
const MAX_SOURCES=4096;
const reject=(message:string):never=>{throw new DevelopmentDomainError('CONFLICT',message);};
const id=(v:unknown):string=>{if(typeof v!=='string'||!v||v.length>200||v.trim()!==v)reject('消费范围身份须明确。');return v as string;};
function dec(value:any,zero=false) {if(typeof value!=='string'&&!Prisma.Decimal.isDecimal(value)) reject('实际范围数量不是精确数据库十进制。');return canonicalOrderSampleDecimal(value.toString(),zero);}
const scaled=(s:string)=>{const [w,f='']=s.split('.');return BigInt(w)*BigInt(10000)+BigInt(f.padEnd(4,'0'));};
const known=(e:unknown)=>e instanceof DevelopmentDomainError||e instanceof OrderSampleContractError||e instanceof OrderSampleParentError||e instanceof OrderSampleRecordError||e instanceof ProductionBatchFactsError||readBusinessErrorMint(e)?.code==='CONFLICT';
async function targetScope(db:any,target:OrderSampleConsumerTarget,family:OrderSampleFamily):Promise<OrderSampleConsumerScope> {
  id(target.id);let row:any,batch:any,order:any,line:any,rangeStart:string,quantity:string,factory:string,productionLineIdentity:ProductionLineIdentity|null=null;
  if(target.kind==='production_batch') {batch=await db.productionBatch.findUnique({where:{id:target.id}});if(!batch)reject('实际生产批次不存在。');row=batch;}
  else if(target.kind==='shipment_allocation') {
    row=await db.shipmentProductionAllocation.findUnique({where:{id:target.id}});
    if(!row||!['reserved','shipped'].includes(row.state))reject('实际发运分配不可用。');
    batch=await db.productionBatch.findUnique({where:{id:row.productionBatchId}});if(!batch||row.productionBatchRevision!==batch.revision||row.orderId!==batch.orderId||row.orderLineId!==batch.orderLineId||canonicalOrderSampleUnit(row.unit)!==canonicalOrderSampleUnit(batch.unit))reject('实物分配的订单、行或批次修订不符。');
    const actual=row.actualQty==null?null:dec(row.actualQty,true),planned=row.plannedQty==null?null:dec(row.plannedQty,true);
    if(actual===null&&planned===null||[actual,planned].some(q=>q!==null&&scaled(q)>scaled(dec(batch.quantity))))reject('实物分配数量未知或超出实际批次。');
    if(![actual,planned].some(q=>q!==null&&scaled(q)>BigInt(0)))reject('实物分配没有正的实际或计划数量。');
    const snapshot=row.scopeSnapshot;
    if(!snapshot||snapshot.scopeType!=='production_batch'||snapshot.scopeKey!==`production_batch:${batch.id}`||snapshot.scopeFingerprint!==orderSampleDigest(snapshot.scopeSnapshot))reject('实物分配的范围快照不完整。');
    const b=snapshot.scopeSnapshot?.batch;
    if(!b||b.id!==batch.id||b.revision!==batch.revision||b.factoryRelationId!==batch.factoryRelationId||b.rangeStart!==dec(batch.rangeStart,true)||b.quantity!==dec(batch.quantity)||canonicalOrderSampleUnit(b.unit)!==canonicalOrderSampleUnit(batch.unit)||b.sourceFingerprint!==batch.sourceFingerprint)reject('实物分配的冻结批次范围已经过期。');
  } else if(target.kind==='release_scope') {
    row=await db.releaseScope.findUnique({where:{id:target.id}});
    if(!row||row.deletedAt!=null||['paused','revoked','invalidated'].includes(row.state))reject('实际放行范围不可用。');
    if(row.productionBatchId) {batch=await db.productionBatch.findUnique({where:{id:row.productionBatchId}});
      if(!batch||row.productionBatchRevision!==batch.revision||row.orderId!==batch.orderId||row.orderLineId!==batch.orderLineId||row.factoryRelationId!==batch.factoryRelationId||dec(row.quantity)!==dec(batch.quantity)||canonicalOrderSampleUnit(row.unit)!==canonicalOrderSampleUnit(batch.unit)||orderSampleDigest(row.specSnapshot)!==orderSampleDigest(batch.specSnapshot)||row.confirmedSourceType!==batch.confirmedSourceType||row.confirmedSourceId!==batch.confirmedSourceId)reject('实际放行范围与批次依据不一致。');
    } else {
      if(family!=='garment_pp'||row.productionBatchRevision!=null||!row.factoryRelationId)reject('无实际批次身份的范围不能补造原生消费资格。');
      if((await db.releaseScope.findMany({where:{orderId:row.orderId,orderLineId:row.orderLineId,productionBatchId:{not:null},deletedAt:null},take:1})).length)reject('整行范围已由实际批次承接。');
      order=await db.order.findFirst({where:{id:row.orderId,deletedAt:null}});line=await db.orderLine.findUnique({where:{id:row.orderLineId}});
      if(!order||!line||line.orderId!==order.id||dec(row.quantity)!==dec(line.quantity)||canonicalOrderSampleUnit(row.unit)!==canonicalOrderSampleUnit(line.unit)||orderSampleDigest(row.specSnapshot)!==orderSampleDigest(line.specSnapshot)||row.confirmedSourceType!==line.confirmedSourceType||row.confirmedSourceId!==line.confirmedSourceId)reject('整行放行范围与实际订单行不一致。');
    }
  } else reject('没有支持的实际消费范围。');
  if(batch) {const facts=await resolveCurrentProductionBatchFacts(db,batch);order=facts.order;line=facts.line;productionLineIdentity=facts.productionLineIdentity;rangeStart=dec(batch.rangeStart,true);quantity=dec(batch.quantity);factory=batch.factoryRelationId;}
  else {rangeStart='0';quantity=dec(line.quantity);factory=row.factoryRelationId;}
  if(!family.startsWith(`${orderSampleOrderLane(order)}_`))reject('实际订单与样品业务族不一致。');
  if(family==='garment_pp'&&batch&&!productionLineIdentity)reject('须明确本工厂单线实际声明或真实生产线，不能从旧分支猜测产前依据。');
  const body={kind:target.kind,id:target.id,orderId:order.id,orderLineId:line.id,factoryRelationId:factory,productionBatchId:batch?.id??null,productionBatchRevision:batch?.revision??null,
    rangeStart,quantity,unit:canonicalOrderSampleUnit(line.unit),lineFingerprint:productionBatchLineFingerprint(order,line),specFingerprint:orderSampleDigest(line.specSnapshot),
    ...(productionLineIdentity ? { productionLineMode:productionLineIdentity.mode,productionLineId:productionLineIdentity.productionLineId,productionLineRevision:productionLineIdentity.lineRevision,productionLineFingerprint:productionLineIdentity.fingerprint } : {})};
  return {...body,targetFingerprint:orderSampleDigest({target:body,allocation:target.kind==='shipment_allocation'?{state:row.state,plannedQty:row.plannedQty==null?null:dec(row.plannedQty,true),actualQty:row.actualQty==null?null:dec(row.actualQty,true),scopeSnapshot:row.scopeSnapshot}:null,scopeRevision:target.kind==='release_scope'?row.scopeRevision:null})};
}
function covers(source:OrderSampleSource,scope:OrderSampleConsumerScope):boolean {
  if(source.owner.orderId!==scope.orderId||source.owner.factoryRelationId!==scope.factoryRelationId)return false;
  const intervals=source.coverage.filter(c=>c.orderLineId===scope.orderLineId&&c.unit===scope.unit&&c.lineFingerprint===scope.lineFingerprint&&c.specFingerprint===scope.specFingerprint
    && (c.scopeKind==='order_line'&&source.family==='garment_pp'||c.productionBatchId===scope.productionBatchId&&c.productionBatchRevision===scope.productionBatchRevision)
    &&(source.family!=='garment_pp'||scope.productionBatchId===null||productionLineCoverageMatches(c,{productionLineMode:scope.productionLineMode??null,productionLineFingerprint:scope.productionLineFingerprint??null})));
  if(!intervals.length)return false;
  const start=scaled(scope.rangeStart),end=start+scaled(scope.quantity);let cursor=start;
  for(const c of intervals) {const cs=scaled(c.rangeStart),ce=cs+scaled(c.quantity);if(ce<=cursor)continue;if(cs>cursor)return false;cursor=ce;if(cursor>=end)return true;}
  return false;
}
/** Internal read utility. Caller supplies current authorized/locked business
 * snapshot and revalidates before irreversible writes. This is sample evidence
 * only: it does not grant final bulk QC, production signatures or shipment stock.
 * Explicit selection resolves competing chains; it never restores an older
 * round. Missing delegates/SQL faults propagate rather than legacy fallback. */
export async function resolveOrderSampleConsumerProof(db:any,target:OrderSampleConsumerTarget,family:OrderSampleFamily,selection?:{sourceId:string}):Promise<OrderSampleConsumerResult> {
  id(target.id);
  const delegate=target.kind==='production_batch'?db.productionBatch:target.kind==='release_scope'?db.releaseScope:target.kind==='shipment_allocation'?db.shipmentProductionAllocation:null;
  if(!delegate)reject('实际消费范围类型不受支持。');
  const targetRow=await delegate.findUnique({where:{id:target.id}});
  if(!targetRow||!targetRow.orderId)return {mode:'native',qualified:false,enabled:true,reason:'TARGET_UNRESOLVED',candidateSourceIds:[],scope:null};
  const rows=await db.orderSampleSource.findMany({where:{orderId:targetRow.orderId},orderBy:[{chainId:'asc'},{round:'asc'}],take:MAX_SOURCES+1});
  if(rows.length>MAX_SOURCES)return {mode:'native',qualified:false,enabled:true,reason:'SOURCE_BUDGET_EXCEEDED',candidateSourceIds:[],scope:null};
  if(!rows.length)return {mode:'legacy_mode',qualified:false,orderId:targetRow.orderId,reason:'NO_NATIVE_ORDER_SOURCES'};
  let scope:OrderSampleConsumerScope;
  try {scope=await targetScope(db,target,family);if(scope.orderId!==targetRow.orderId)reject('实际目标订单在读取时变化。');}catch(error){if(!known(error))throw error;return {mode:'native',qualified:false,enabled:true,reason:'TARGET_UNRESOLVED',candidateSourceIds:[],scope:null};}
  const familyRows=rows.filter((r:any)=>r.family===family);
  const blocked=(reason:string,ids:string[]=[]):OrderSampleConsumerResult=>({mode:'native',qualified:false,enabled:true,reason,candidateSourceIds:ids,scope});
  if(!familyRows.length)return family==='fabric_rc'?{mode:'optional_unenabled',qualified:false,enabled:false,scope}:blocked('NATIVE_FAMILY_MISSING');
  const chains=new Map<string,any>();
  for(const row of familyRows) {
    if(row.orderId!==scope.orderId||!row.id||!row.chainId||!Number.isSafeInteger(row.round)||row.round<1)return blocked('SOURCE_IDENTITY_UNRESOLVED');
    const prior=chains.get(row.chainId);if(prior?.round===row.round)return blocked('DUPLICATE_ROUND');if(!prior||row.round>prior.round)chains.set(row.chainId,row);
  }
  const loaded=new Map<string,any>();
  if(family==='fabric_rc') {
    let enabled=false;
    for(const row of familyRows) {
      let record;try {record=await loadOrderSampleRecord(db,row.id);}catch(error){if(!known(error))throw error;return blocked('SOURCE_RECORD_UNRESOLVED',[row.id]);}
      loaded.set(row.id,record);
      if(record.view.rcScopeEnabled && record.source.owner.orderId===scope.orderId && record.source.owner.factoryRelationId===scope.factoryRelationId
        &&record.source.coverage.some((c:any)=>c.orderLineId===scope.orderLineId&&c.unit===scope.unit&&c.productionBatchId===scope.productionBatchId))enabled=true;
    }
    if(!enabled)return {mode:'optional_unenabled',qualified:false,enabled:false,scope};
  }
  const candidates:any[]=[];
  for(const row of chains.values()) {
    let record;
    try {record=loaded.get(row.id)??await loadOrderSampleRecord(db,row.id);}catch(error){if(!known(error))throw error;return blocked('SOURCE_RECORD_UNRESOLVED',[row.id]);}
    if(covers(record.source,scope))candidates.push(record);
  }
  let chosen:any;
  if(selection) {
    id(selection.sourceId);const selected=familyRows.find((r:any)=>r.id===selection.sourceId);
    if(!selected||chains.get(selected.chainId).id!==selected.id)return blocked('SELECTION_NOT_CURRENT',[selection.sourceId]);
    chosen=candidates.find(r=>r.source.sourceId===selection.sourceId);if(!chosen)return blocked('SELECTION_SCOPE_MISMATCH',[selection.sourceId]);
  } else {
    if(candidates.length!==1)return blocked(candidates.length?'AMBIGUOUS_NATIVE_SOURCE':'NATIVE_SCOPE_UNCOVERED',candidates.map(r=>r.source.sourceId));
    chosen=candidates[0];
  }
  const source:OrderSampleSource=chosen.source;
  if(source.provenance!=='native_new'||chosen.view.invalidated)return blocked('SOURCE_NOT_ELIGIBLE',[source.sourceId]);
  const latestShipment=chosen.view.shipments[chosen.view.shipments.length-1],feedback=chosen.view.latestFeedback;
  if(!latestShipment||!feedback||feedback.result!=='approved'||feedback.shippedEventId!==latestShipment.eventId)return blocked('CURRENT_CUSTOMER_APPROVAL_MISSING',[source.sourceId]);
  if(['garment_pp','garment_top'].includes(family)&&(chosen.view.pendingQcRequest||chosen.view.qc?.result!=='passed'))return blocked('CURRENT_QC_PASS_MISSING',[source.sourceId]);
  let parents;
  try {parents=await resolveOrderSampleParents(db,{family,orderId:source.owner.orderId,factoryRelationId:source.owner.factoryRelationId,coverage:source.coverage.map(c=>({orderLineId:c.orderLineId,expectedLineFingerprint:c.lineFingerprint,productionBatchId:c.productionBatchId,expectedBatchRevision:c.productionBatchRevision,rangeStart:c.rangeStart,quantity:c.quantity,unit:c.unit}))});
    const current=buildOrderSampleSource({domain:'order',sourceId:source.sourceId,sampleId:source.sampleId,family,owner:parents.owner,chainId:source.chainId,round:source.round,previousSourceId:source.previousSourceId,provenance:source.provenance,specSnapshot:parents.specSnapshot,sampleFacts:source.sampleFacts,coverage:parents.coverage,lines:parents.lines,batches:parents.batches});
    if(orderSampleDigest(current)!==orderSampleDigest(source))return blocked('CURRENT_PARENT_MISMATCH',[source.sourceId]);
  }catch(error){if(!known(error))throw error;return blocked('CURRENT_PARENT_UNRESOLVED',[source.sourceId]);}
  const shipmentEvent=chosen.events.find((e:any)=>e.id===latestShipment.eventId),feedbackEvent=chosen.events.find((e:any)=>e.id===feedback.eventId);
  if(!shipmentEvent||!feedbackEvent)return blocked('NATIVE_EVENT_PROOF_MISSING',[source.sourceId]);
  const qcEvent=chosen.view.qc?chosen.events.find((e:any)=>e.id===chosen.view.qc.eventId):null;
  let qcReport:any=null,qcReportAudit:any=null;
  if(qcEvent) {
    const rawReport=await db.inspectionReport.findUnique({where:{id:qcEvent.payload.report.id}});
    const rawAudit=await db.auditLog.findUnique({where:{id:qcEvent.payload.reportAudit.auditId}});
    const originalReport=orderSampleQcStoredReport(rawReport);
    if(!rawAudit||!(rawAudit.createdAt instanceof Date)||rawAudit.id!==qcEvent.payload.reportAudit.auditId||rawAudit.actorId!==qcEvent.actorId||rawAudit.action!=='order_sample_qc_review'||rawAudit.targetType!=='InspectionReport'||rawAudit.targetId!==rawReport.id||rawAudit.transactionId!==qcEvent.id||String(rawAudit.createdAt.getTime())!==qcEvent.recordedAt||orderSampleDigest(rawAudit.detail?.after)!==orderSampleDigest(qcEvent.payload.report)||rawAudit.detail?.originalReportHash!==orderSampleDigest(originalReport))return blocked('NATIVE_QC_PROOF_CHANGED',[source.sourceId]);
    qcReport={fact:qcEvent.payload.report,originalReport,originalReportHash:orderSampleDigest(originalReport)};
    qcReportAudit={id:rawAudit.id,actorId:rawAudit.actorId,action:rawAudit.action,targetType:rawAudit.targetType,targetId:rawAudit.targetId,transactionId:rawAudit.transactionId,createdAt:String(rawAudit.createdAt.getTime()),detail:rawAudit.detail};
  }
  const shipmentAcknowledgement=chosen.acknowledgements.find((a:any)=>a.eventId===shipmentEvent.id),feedbackAcknowledgement=chosen.acknowledgements.find((a:any)=>a.eventId===feedbackEvent.id);
  if(!shipmentAcknowledgement||!feedbackAcknowledgement)return blocked('NATIVE_EVENT_PROOF_MISSING',[source.sourceId]);
  const body={schemaVersion:1 as const,family,enabled:true,scope,source,head:chosen.view.head,parentFingerprint:parents.parentFingerprint,shipmentEvent,shipmentAudit:shipmentEvent.audit,shipmentAcknowledgement,feedbackEvent,feedbackAudit:feedbackEvent.audit,feedbackAcknowledgement,qcReport,qcReportAudit};
  return {mode:'native',qualified:true,enabled:true,proof:{...body,proofFingerprint:orderSampleDigest(body)}};
}
export function assertFrozenOrderSampleConsumerProof(current:OrderSampleConsumerResult,frozen:unknown):void {
  if(current.mode!=='native'||!current.qualified||orderSampleDigest(current.proof)!==orderSampleDigest(frozen))reject('原生样品依据与原批准冻结来源、事件版本或实际覆盖范围不一致。');
}
