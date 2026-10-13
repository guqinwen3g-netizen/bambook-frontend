/** Native multi-ticket PL commands. Source membership is fixed for a document;
 * appending freezes a new N, never rewrites dispatch, goods, finance or old PL. */
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { todayLocalKey } from '../shared/localDate';
import { lockReleaseSources } from '../production/releaseService';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { generateTradeDocumentNumber } from './tradeDocumentLifecycleService';
import { currentDocumentActor, authorizedDocumentOrders, shipmentDocumentSourceInTx, lockShipmentDocumentSourcesInTx,
  documentSourceFingerprint as hash, documentSourceJson as json } from '../shipping/shipmentDocumentSource';
import { buildMergedPackingListEnvelope, assertMergedPackingListEnvelope, type MergedPackingListSnapshot } from '../templates/docTemplates/mergedPackingListSource';
import { DEFAULT_EXPORTER_PROFILE, EXPORTER_PROFILE_CONFIG_ID } from '../config/systemConfigRoute';
const prefix='merged-pl:v1:',action='MERGED_PACKING_LIST_VERSION',operation='save_merged_packing_list_version';
const scopes=['customs:read','shipments:read'] as const;
const bad=(message='合并装箱单来源、版本或原命令无法核验。'): never=>{throw businessError('CONFLICT',message);};
const absent=():never=>{throw businessError('NOT_FOUND','合并装箱单不存在或不可查看。');};
const hex=(v: any)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),uuid=(v:any)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const ids=(values: string[])=>[...new Set(values)].sort();
const ref=(values:string[])=>prefix+hash(ids(values));
const auditId=(actorId:string,key:string)=>'AUD_MPL_'+hash({actorId,key});
export type MergedPackingListInput={requestKey:string;sourceIds:string[];expectedSourceFingerprint:string;reason:string;expectedLatestVersion:number;expectedContentHash:string|null};
export type MergedPackingListReceipt={operation:typeof operation;protocol:1;commandId:string;requestKey:string;actorId:string;documentId:string;
 sourceIds:string[];parameterHash:string;sourceFingerprint:string;previousVersion:number;previousContentHash:string|null;
 version:number;versionId:string;contentHash:string;auditIds:string[]};
function selection(value:unknown):string[]{
 if(!Array.isArray(value)||value.length<2||value.length>200||value.some(v=>typeof v!=='string'||!v.trim()||v!==v.trim()))throw businessError('INVALID_INPUT','请明确选择至少两张真实运单。');
 const result=ids(value);if(result.length<2)throw businessError('INVALID_INPUT','请明确选择至少两张不同的真实运单。');return result;
}
function parse(value:unknown,create:boolean):MergedPackingListInput{
 const v:any=value;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==6||!uuid(v.requestKey)||!hex(v.expectedSourceFingerprint)
  ||typeof v.reason!=='string'||!v.reason.trim()||v.reason.length>2000||!Number.isSafeInteger(v.expectedLatestVersion)
  ||(create?v.expectedLatestVersion!==0||v.expectedContentHash!==null:v.expectedLatestVersion<1||!hex(v.expectedContentHash)))
  throw businessError('INVALID_INPUT','请保留原请求键、固定选票、来源及版本校验值，并填写保存说明。');
 return {requestKey:v.requestKey,sourceIds:selection(v.sourceIds),expectedSourceFingerprint:v.expectedSourceFingerprint,
  reason:v.reason.trim(),expectedLatestVersion:v.expectedLatestVersion,expectedContentHash:v.expectedContentHash};
}
export async function isMergedPackingListCandidateInTx(tx:any,doc:any):Promise<boolean>{
 if(!doc)return false;
 if(typeof doc.sourceRef==='string'&&doc.sourceRef.startsWith(prefix))return true;
 return !!await tx.auditLog.findFirst({where:{action,targetType:'TradeDocument',targetId:doc.id},select:{id:true}});
}
function document(doc:any,sourceIds:string[],draft=false){
 if(!doc||doc.deletedAt!=null)absent();
 if(doc.type!=='PackingList'||doc.domain!=='customs'||doc.shipmentId!==null||doc.orderId!==null||doc.sourceRef!==ref(sourceIds)
  ||typeof doc.documentNumber!=='string'||!doc.documentNumber.trim())bad();
 if(draft&&doc.status!=='Draft')bad('仅 Draft 合并装箱单可明确追加来源版本；已签发或交单事实保持原样。');
}
const identity=(d:any)=>({id:d.id,type:d.type,domain:d.domain,status:d.status,sourceRef:d.sourceRef,shipmentId:d.shipmentId,
 orderId:d.orderId,documentNumber:d.documentNumber,issueDate:d.issueDate,consignee:d.consignee,deletedAt:d.deletedAt});
async function profile(tx:any):Promise<MergedPackingListSnapshot['exporter']>{
 const row=await tx.systemConfig.findUnique({where:{id:EXPORTER_PROFILE_CONFIG_ID}});
 if(!row)return{nameEn:DEFAULT_EXPORTER_PROFILE.nameEn,addressEn:DEFAULT_EXPORTER_PROFILE.addressEn,source:'default',configVersion:null};
 if(row.encrypted||row.valueType!=='json'||!Number.isSafeInteger(row.version)||row.version<1)bad('当前出具方档案无法核验。');
 let value=row.value;if(typeof value==='string'){try{value=JSON.parse(value);}catch{bad('当前出具方档案无法核验。');}}
 if(!value||typeof value.nameEn!=='string'||!value.nameEn.trim()||typeof value.addressEn!=='string')bad('当前出具方档案无法核验。');
 return{nameEn:value.nameEn,addressEn:value.addressEn,source:'configured',configVersion:row.version};
}
async function authority(tx:any,prior:TokenPayload|null,parentIds:string[],write=false){
 const required=[...scopes,...(write?['customs:write' as const]:[]),...(parentIds.length?['orders:read' as const]:[])];
 const actor=await currentDocumentActor(tx,prior,required),parents=await authorizedDocumentOrders(tx,actor,parentIds);
 const final=await currentDocumentActor(tx,prior,required);if(hash(actor)!==hash(final))bad('当前合并装箱单权限在读取时变化。');
 return {actor:final,stamp:hash({actor:final,parents})};
}
async function current(tx:any,sourceIds:string[],prior:TokenPayload|null,write=false){
 const required=[...scopes,...(write?['customs:write' as const]:[])],before=await currentDocumentActor(tx,prior,required);
 const facts=[];for(const id of sourceIds)facts.push(await shipmentDocumentSourceInTx(tx,id,{trustedActor:prior,extraScopes:required}));
 const exporter=await profile(tx),parentIds=ids(facts.flatMap(f=>f.orderIds));
 const result=await authority(tx,prior,parentIds,write);if(hash(before)!==hash(result.actor))bad('当前合并来源读取身份变化。');
 const fingerprint=hash({sources:facts.map(f=>({shipmentId:f.shipment.id,fingerprint:f.fingerprint})),exporter});
 return{facts,exporter,parentIds,actor:result.actor,authorityStamp:result.stamp,fingerprint};
}
const snapshot=(c:Awaited<ReturnType<typeof current>>,d:any)=>buildMergedPackingListEnvelope(c.facts,{id:d.id,documentNumber:d.documentNumber,issueDate:d.issueDate??null},c.exporter);
export async function readMergedPackingListSelection(prisma:PrismaClient,sourceIds:unknown,trustedActor:TokenPayload|null){
 const selected=selection(sourceIds);
 return prisma.$transaction(async tx=>{
  const before=await current(tx,selected,trustedActor);
  const findExisting=async()=>{const doc=await tx.tradeDocument.findFirst({where:{domain:'customs',type:'PackingList',sourceRef:ref(selected),deletedAt:null}});
   return doc?readMergedPackingListVersionInTx(tx,{documentId:doc.id,trustedActor}):null;};
  const first=await findExisting(),after=await current(tx,selected,trustedActor),last=await findExisting();
  if(before.fingerprint!==after.fingerprint||before.authorityStamp!==after.authorityStamp||first?.fingerprint!==last?.fingerprint)bad('合并装箱单选票来源或已登记版本已变化。');
  // Read-only unregistered preview cannot invent a formal number. An existing
  // verified record is located explicitly, never recreated or silently updated.
  const envelope=snapshot(after,last?.document??{id:'unregistered-preview',documentNumber:'未登记预览',issueDate:null});
  const existingDocument=last?{id:last.document.id,documentNumber:last.document.documentNumber,status:last.document.status,
   version:last.version.version,versionId:last.version.id,contentHash:hash(last.version.content)}:null;
  return{sourceIds:selected,sourceFingerprint:after.fingerprint,source:envelope,existingDocument,
   latest:existingDocument?{version:existingDocument.version,contentHash:existingDocument.contentHash}:{version:0,contentHash:null}};
 },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
}
async function proof(tx:any,doc:any,version:any){
 const content:any=version?.content,command=content?.command;
 if(content?.mergedPlDraftProtocol!==1||Object.keys(content).length!==3||!command||!uuid(command.requestKey)||typeof command.actorId!=='string')bad();
 const audit=await tx.auditLog.findUnique({where:{id:auditId(command.actorId,command.requestKey)}}),p:MergedPackingListReceipt=audit?.detail?.mergedPackingListReceipt;
 if(!p||p.operation!==operation||p.protocol!==1||p.documentId!==doc.id||p.actorId!==audit.actorId||audit.action!==action
  ||audit.targetType!=='TradeDocument'||audit.targetId!==doc.id||p.requestKey!==command.requestKey||!uuid(p.commandId)
  ||audit.transactionId!=='MPL:'+p.commandId||p.versionId!==version.id||p.version!==version.version||version.changedBy!==p.actorId
  ||!hex(p.sourceFingerprint)||!hex(p.parameterHash)||!hex(p.contentHash)||p.contentHash!==hash(content)
  ||!Array.isArray(p.auditIds)||p.auditIds.length!==2||p.auditIds[0]!==audit.id
  ||!Number.isSafeInteger(p.previousVersion)||p.previousVersion<0||p.version!==p.previousVersion+1)bad();
 const input=parse(audit.detail.intent,p.previousVersion===0);
 if(hash({operation,actorId:p.actorId,documentId:p.previousVersion===0?null:doc.id,input})!==p.parameterHash
  ||hash(command)!==hash({commandId:p.commandId,requestKey:p.requestKey,actorId:p.actorId,parameterHash:p.parameterHash,versionId:p.versionId})
  ||hash(input.sourceIds)!==hash(p.sourceIds))bad();
 const envelope=assertMergedPackingListEnvelope(content.mergedPackingList),s=envelope.mergedPackingListSource;
 document(doc,p.sourceIds);
 if(s.document.id!==doc.id||s.document.documentNumber!==doc.documentNumber||hash(s.shipments.map(c=>c.source.shipmentId))!==hash(p.sourceIds)
  ||input.expectedSourceFingerprint!==p.sourceFingerprint)bad();
 const va=await tx.auditLog.findUnique({where:{id:p.auditIds[1]}});
 if(!va||va.action!=='DOCUMENT_VERSION_CREATE'||va.targetType!=='DocumentVersion'||va.targetId!==version.id||va.actorId!==p.actorId
  ||va.transactionId!==audit.transactionId||hash(va.detail)!==hash({protocol:1,documentId:doc.id,version:p.version,contentHash:p.contentHash,sourceFingerprint:p.sourceFingerprint,requestKey:p.requestKey,parameterHash:p.parameterHash}))bad();
 if(p.previousVersion){const previous=await tx.documentVersion.findUnique({where:{documentId_version:{documentId:doc.id,version:p.previousVersion}}});
  if(!previous||hash(previous.content)!==p.previousContentHash||input.expectedLatestVersion!==p.previousVersion||input.expectedContentHash!==p.previousContentHash)bad();
 }else if(p.previousContentHash!==null)bad();
 const frozenSources=s.shipments.map(c=>({shipmentId:c.source.shipmentId,fingerprint:c.source.fingerprint}));
 if(hash({sources:frozenSources,exporter:s.exporter})!==p.sourceFingerprint)bad();
 return{receipt:p,envelope,audit};
}
async function warning(tx:any,envelope:ReturnType<typeof assertMergedPackingListEnvelope>){
 const sources=envelope.mergedPackingListSource.shipments,rows=[];const warnings:string[]=[];
 for(const child of sources){const shipment=await tx.shipment.findUnique({where:{id:child.source.shipmentId},select:{id:true,status:true,deletedAt:true,updatedAt:true}});
  const cartons=await tx.shipmentCarton.findMany({where:{shipmentId:child.source.shipmentId},include:{items:{orderBy:{id:'asc'}}},orderBy:{id:'asc'}});
  rows.push({shipment,cartons});
  if(!shipment||shipment.deletedAt!==null||shipment.status==='Cancelled')warnings.push(child.shipment.shipmentNumber+'：当前票已取消或不可操作；保留原版本。');
  const simple=(values:any[])=>values.map(c=>({id:c.id,cartonNo:c.cartonNo,description:c.description??null,
    ...Object.fromEntries(['length','width','height','grossWeight','netWeight','volume'].map(k=>[k,c[k]==null?null:String(c[k])])),
    items:c.items.map((i:any)=>({id:i.id,shipmentLineId:i.shipmentLineId,quantity:String(i.quantity)})).sort((a:any,b:any)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.id.localeCompare(b.id));
  if(String(shipment?.updatedAt)!==child.source.shipmentUpdatedAt||hash(simple(cartons))!==hash(simple(child.cartons)))warnings.push(child.shipment.shipmentNumber+'：当前包装来源已变化；此处仍显示原版本。');
 }
 return{stamp:hash(rows),warnings};
}
export async function readMergedPackingListVersionInTx(tx:any,params:{documentId:string;version?:number;trustedActor:TokenPayload|null;write?:boolean}){
 await currentDocumentActor(tx,params.trustedActor,params.write?[...scopes,'customs:write']:scopes);
 const doc=await tx.tradeDocument.findFirst({where:{id:params.documentId,deletedAt:null}});if(!doc)absent();
 const version=params.version===undefined?await tx.documentVersion.findFirst({where:{documentId:doc.id},orderBy:{version:'desc'}})
  :await tx.documentVersion.findUnique({where:{documentId_version:{documentId:doc.id,version:params.version}}});if(!version)absent();
 const proved=await proof(tx,doc,version),parentIds=ids(proved.envelope.mergedPackingListSource.shipments.flatMap(c=>c.source.orderIds));
 const before=await authority(tx,params.trustedActor,parentIds,params.write),notes=await warning(tx,proved.envelope);
 const finalDoc=await tx.tradeDocument.findFirst({where:{id:doc.id,deletedAt:null}}),finalVersion=await tx.documentVersion.findUnique({where:{id:version.id}});
 if(!finalDoc||!finalVersion||hash(identity(doc))!==hash(identity(finalDoc))||hash(version)!==hash(finalVersion))bad();
 const final=await proof(tx,finalDoc,finalVersion),last=await authority(tx,params.trustedActor,parentIds,params.write),lastNotes=await warning(tx,final.envelope);
 if(before.stamp!==last.stamp||notes.stamp!==lastNotes.stamp)bad('合并装箱单历史范围在读取时变化。');
 return{kind:'merged' as const,document:finalDoc,item:json(finalVersion),version:json(finalVersion),protocol:2 as const,provenance:'native' as const,
  envelope:final.envelope,receipt:json(final.receipt) as MergedPackingListReceipt,orderIds:parentIds,shipmentIds:final.receipt.sourceIds,
  warnings:[...final.envelope.mergedPackingListSource.warnings,...lastNotes.warnings],authorityStamp:last.stamp,
  fingerprint:hash({doc:identity(finalDoc),version:finalVersion,before:last.stamp,warning:lastNotes.stamp})};
}
export async function readMergedPackingListDraftSource(prisma:PrismaClient,documentId:string,trustedActor:TokenPayload|null){
 return prisma.$transaction(async tx=>{
  const original=await readMergedPackingListVersionInTx(tx,{documentId,trustedActor});document(original.document,original.shipmentIds,true);
  const before=await current(tx,original.shipmentIds,trustedActor),after=await current(tx,original.shipmentIds,trustedActor);
  const last=await readMergedPackingListVersionInTx(tx,{documentId,trustedActor});
  if(before.fingerprint!==after.fingerprint||before.authorityStamp!==after.authorityStamp||last.fingerprint!==original.fingerprint)bad();
  return{documentId,shipmentIds:original.shipmentIds,source:snapshot(after,original.document),sourceFingerprint:after.fingerprint,
   latest:{id:original.version.id,version:original.version.version,contentHash:hash(original.version.content),protocol:2}};
 },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
}
async function receiptResult(tx:any,prior:TokenPayload|null,audit:any,parameterHash?:string){
 const p=audit?.detail?.mergedPackingListReceipt;if(!p||parameterHash!==undefined&&p.parameterHash!==parameterHash)bad('原请求键已用于不同合并来源或参数。');
 const selected=await readMergedPackingListVersionInTx(tx,{documentId:p.documentId,version:p.version,trustedActor:prior});
 if(hash(selected.receipt)!==hash(p))bad();return{document:json(selected.document),receipt:json(selected.receipt),version:json(selected.version),replayed:true};
}
export async function saveMergedPackingListDraft(prisma:PrismaClient,params:{trustedActor:TokenPayload|null;input:unknown;documentId?:string}){
 const input=parse(params.input,!params.documentId);
 return prisma.$transaction(async(tx:any)=>{
  const initial=await current(tx,input.sourceIds,params.trustedActor,true),parameterHash=hash({operation,actorId:initial.actor.userId,documentId:params.documentId??null,input});
  const key=auditId(initial.actor.userId,input.requestKey),prior=await tx.auditLog.findUnique({where:{id:key}});
  if(prior)return receiptResult(tx,params.trustedActor,prior,parameterHash);
  await lockShipmentDocumentSourcesInTx(tx,input.sourceIds,{trustedActor:params.trustedActor,extraScopes:['customs:read','customs:write']});
  let doc:any,previous:any;
  if(params.documentId){await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${params.documentId} FOR UPDATE`);
   await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DocumentVersion" WHERE "documentId"=${params.documentId} ORDER BY "version" FOR UPDATE`);
   const original=await readMergedPackingListVersionInTx(tx,{documentId:params.documentId,trustedActor:params.trustedActor,write:true});
   doc=original.document;document(doc,input.sourceIds,true);previous=original.version;
   if(previous.version!==input.expectedLatestVersion||hash(previous.content)!==input.expectedContentHash)bad('原合并装箱单版本已变化，请重新核对后明确追加。');
  }else{
   const existing=await tx.tradeDocument.findFirst({where:{domain:'customs',type:'PackingList',sourceRef:ref(input.sourceIds),deletedAt:null}});
   if(existing){const selected=await readMergedPackingListVersionInTx(tx,{documentId:existing.id,trustedActor:params.trustedActor,write:true});
    bad('同组运单已有合并装箱单 '+selected.document.documentNumber+'，请定位原单后明确追加版本。');}
  }
  const secondPrior=await tx.auditLog.findUnique({where:{id:key}});if(secondPrior)return receiptResult(tx,params.trustedActor,secondPrior,parameterHash);
  const locked=await current(tx,input.sourceIds,params.trustedActor,true);
  if(initial.fingerprint!==locked.fingerprint||initial.authorityStamp!==locked.authorityStamp||locked.fingerprint!==input.expectedSourceFingerprint)bad('原逐箱合并来源已变化，请刷新核对。');
  const ts=BigInt(Date.now()),commandId=randomUUID(),versionId='DVER_MPL_'+randomUUID(),versionAuditId='AUD_MPL_VERSION_'+randomUUID();
  if(!doc){const id='TD_MPL_'+randomUUID(),number=await generateTradeDocumentNumber(tx,'PackingList');
   doc=await tx.tradeDocument.create({data:{id,type:'PackingList',domain:'customs',status:'Draft',shipmentId:null,orderId:null,sourceRef:ref(input.sourceIds),documentNumber:number,
    issueDate:todayLocalKey(),consignee:null,createdAt:ts,updatedAt:ts}});}
  const original=snapshot(locked,doc),content={mergedPlDraftProtocol:1,command:{commandId,requestKey:input.requestKey,actorId:locked.actor.userId,parameterHash,versionId},mergedPackingList:original};
  const receipt:MergedPackingListReceipt={operation,protocol:1,commandId,requestKey:input.requestKey,actorId:locked.actor.userId,documentId:doc.id,sourceIds:input.sourceIds,
   parameterHash,sourceFingerprint:locked.fingerprint,previousVersion:previous?.version??0,previousContentHash:previous?hash(previous.content):null,
   version:(previous?.version??0)+1,versionId,contentHash:hash(content),auditIds:[key,versionAuditId]};
  const version=await tx.documentVersion.create({data:{id:versionId,documentId:doc.id,version:receipt.version,content:json(content),changedBy:locked.actor.userId,changeReason:input.reason,createdAt:ts}});
  await tx.auditLog.create({data:{id:versionAuditId,action:'DOCUMENT_VERSION_CREATE',actorId:locked.actor.userId,targetType:'DocumentVersion',targetId:versionId,transactionId:'MPL:'+commandId,
   detail:{protocol:1,documentId:doc.id,version:receipt.version,contentHash:receipt.contentHash,sourceFingerprint:receipt.sourceFingerprint,requestKey:input.requestKey,parameterHash}}});
  await tx.auditLog.create({data:{id:key,action,actorId:locked.actor.userId,targetType:'TradeDocument',targetId:doc.id,transactionId:'MPL:'+commandId,detail:{mergedPackingListReceipt:receipt,intent:input}}});
  if(previous)await tx.tradeDocument.update({where:{id:doc.id},data:{updatedAt:ts>BigInt(doc.updatedAt)?ts:BigInt(doc.updatedAt)+BigInt(1)}});
  const final=await current(tx,input.sourceIds,params.trustedActor,true);if(locked.fingerprint!==final.fingerprint||locked.authorityStamp!==final.authorityStamp)bad('保存时当前合并来源或权限变化。');
  const proved=await readMergedPackingListVersionInTx(tx,{documentId:doc.id,version:receipt.version,trustedActor:params.trustedActor,write:true});
  return{document:json(proved.document),receipt:json(receipt),version:json(proved.version),replayed:false};
 },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
}
export async function readOwnMergedPackingListCommand(prisma:PrismaClient,params:{requestKey:string;trustedActor:TokenPayload|null;documentId?:string}){
 if(!uuid(params.requestKey))throw businessError('INVALID_INPUT','请保留原合并装箱单请求键。');
 return prisma.$transaction(async tx=>{const actor=await currentDocumentActor(tx,params.trustedActor,scopes);
  const audit=await tx.auditLog.findUnique({where:{id:auditId(actor.userId,params.requestKey)}});if(!audit||audit.actorId!==actor.userId)absent();
  if(params.documentId&&audit!.targetId!==params.documentId)absent();
  const result=await receiptResult(tx,params.trustedActor,audit);
  // A completed original command remains recoverable after later cancellation.
  // Check actual current parent identity/authority, not eligibility for new goods.
  const fixed={documentId:result.receipt.documentId,version:result.receipt.version,trustedActor:params.trustedActor};
  const before=await readMergedPackingListArchiveSourceInTx(tx,fixed),final=await receiptResult(tx,params.trustedActor,audit),after=await readMergedPackingListArchiveSourceInTx(tx,fixed);
  if(hash(result)!==hash(final)||before.archiveStamp!==after.archiveStamp||hash(after.receipt)!==hash(final.receipt))bad();
  return{...final,protocol:2,provenance:'native'};
 },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
}
export async function authorizeMergedPackingListMetadataInTx(tx:any,id:string,prior:TokenPayload|null){
 const first=await readMergedPackingListVersionInTx(tx,{documentId:id,trustedActor:prior,write:true});
 await lockReleaseSources(tx,first.orderIds);
 await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Shipment" WHERE "id" IN (${Prisma.join(first.shipmentIds)}) ORDER BY "id" FOR UPDATE`);
 await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${id} FOR UPDATE`);
 const final=await readMergedPackingListVersionInTx(tx,{documentId:id,trustedActor:prior,write:true});
 if(hash(identity(first.document))!==hash(identity(final.document)))bad();return final;
}
export async function finishMergedPackingListMetadataInTx(tx:any,prior:TokenPayload|null,original:Awaited<ReturnType<typeof readMergedPackingListVersionInTx>>){
 if(original.authorityStamp!==(await authority(tx,prior,original.orderIds,true)).stamp)bad('合并装箱单当前父来源或授权变化。');
}
export async function readMergedPackingListArchiveSourceInTx(tx:any,params:{documentId:string;version?:number;trustedActor:TokenPayload|null;write?:boolean}){
 const selected=await readMergedPackingListVersionInTx(tx,params);
 // Read original N after later cancellation; current parent identity/authority
 // is still checked without requiring current goods to become a new version.
 const stamp=async()=>{const rows=[];for(const id of selected.shipmentIds){const sh=await tx.shipment.findUnique({where:{id},select:{id:true,orderId:true}}),
  lines=await tx.shipmentLine.findMany({where:{shipmentId:id},select:{id:true,orderLineId:true},orderBy:{id:'asc'}}),
  allocations=await tx.shipmentOrderAllocation.findMany({where:{shipmentId:id},select:{id:true,orderId:true,orderLineId:true},orderBy:{id:'asc'}}),
  physical=await tx.shipmentProductionAllocation.findMany({where:{shipmentId:id},select:{id:true,orderId:true,orderLineId:true},orderBy:{id:'asc'}});
  const lineIds=ids([...lines,...allocations,...physical].map((l:any)=>l.orderLineId).filter((x:any)=>typeof x==='string'&&!!x));
  const originals=lineIds.length?await tx.orderLine.findMany({where:{id:{in:lineIds}},select:{id:true,orderId:true},orderBy:{id:'asc'}}):[];
  if(originals.length!==lineIds.length)bad();const parents=ids([sh?.orderId,...allocations.map((a:any)=>a.orderId),...physical.map((a:any)=>a.orderId),...originals.map((a:any)=>a.orderId)].filter((x):x is string=>typeof x==='string'&&!!x));
  rows.push({sh,lines,allocations,physical,originals,authority:(await authority(tx,params.trustedActor,parents,params.write)).stamp});}
  return hash(rows);};
 const before=await stamp(),final=await readMergedPackingListVersionInTx(tx,{...params,version:selected.version.version}),after=await stamp();
 const actor=await currentDocumentActor(tx,params.trustedActor,params.write?[...scopes,'customs:write']:scopes);
 if(before!==after||selected.fingerprint!==final.fingerprint)bad('原合并装箱单文件期间父来源或权限变化。');
 return{...final,actor,archiveStamp:hash({selected:final.fingerprint,currentParents:after,actor})};
}
