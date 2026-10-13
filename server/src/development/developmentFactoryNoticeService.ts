import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { authorizeDevelopmentSource } from './developmentConversionAuthority';
import { assertDevelopmentOperationalWrite } from './developmentOperationalGuard';
import { createFactoryFiles, factoryAttachmentZip, inspectFactoryFile, noticeFailure } from './developmentFactoryFiles';
type Target={kind:'version'|'trim';targetId:string};
type Context={prisma:any;actorId:string;trustedActor:TokenPayload;files?:ReturnType<typeof createFactoryFiles>};
const safe=(value:any)=>JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='bigint'?String(v):v));
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(safe(value))).digest('hex');
function text(value:any,label:string,max=200){if(typeof value!=='string'||!value.trim()||value.length>max)noticeFailure('INVALID_INPUT',`${label}未填写或过长`,400);return value.trim();}
async function within<T>(ctx:Context,caseId:string,target:Target,write:boolean,fn:(tx:any,development:any,row:any)=>Promise<T>):Promise<T>{
 if(!['version','trim'].includes(target.kind))noticeFailure('INVALID_INPUT','工厂任务类型不正确',400);
 return ctx.prisma.$transaction(async(tx:any)=>{
  await authorizeDevelopmentSource(tx,ctx.actorId,ctx.trustedActor,caseId,{write});
  if(write){await assertDevelopmentOperationalWrite(tx,caseId,'sample');await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);}
  const {development}=await authorizeDevelopmentSource(tx,ctx.actorId,ctx.trustedActor,caseId,{write});
  if(write){if(target.kind==='version')await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentSampleVersion" WHERE "id"=${target.targetId} AND "developmentCaseId"=${caseId} FOR UPDATE`);else await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "GarmentTrimTask" WHERE "id"=${target.targetId} AND "developmentCaseId"=${caseId} FOR UPDATE`);}
  const row=await (target.kind==='version'?tx.developmentSampleVersion:tx.garmentTrimTask).findFirst({where:{id:target.targetId,developmentCaseId:caseId,deletedAt:null}});
  if(!row || (target.kind==='trim'&&development.type!=='garment'))noticeFailure('NOT_FOUND','该开发单的工厂任务不存在',404);
  return fn(tx,development,row);
 });
}
function publicNotice(snapshot:any){return {...snapshot,attachments:(snapshot.attachments??[]).map(publicFile)};}
function publicFile(row:any){const {storageKey,...file}=row;return file;}
function refs(row:any,target:Target){return (target.kind==='version'?row.referenceAttachments:row.attachments)??[];}
function reference(value:any){return typeof value==='string'?value:value?.url;}
async function resolveFiles(tx:any,caseId:string,target:Target,values:any[]){
 if(!Array.isArray(values)||values.length>20)noticeFailure('INVALID_ATTACHMENTS','该版本附件目录无效');
 return Promise.all(values.map(async(value:any)=>{const ref=reference(value);if(typeof ref!=='string'||!ref.startsWith('development-file:'))return {reference:ref??null,originalName:typeof value==='object'?value.name??ref:ref,available:false};
  const id=ref.slice('development-file:'.length),row=await tx.auditLog.findFirst({where:{id,action:'development_factory_file',targetType:'DevelopmentCase',targetId:caseId}}),data=row?.detail;
  let belongs=data?.kind===target.kind&&data?.targetId===target.targetId;
  if(!belongs&&data?.kind==='version'&&target.kind==='version'){
   // Only explicit parent/source lineage can inherit a selected original file.
   const pending=[target.targetId],seen=new Set<string>();
   while(pending.length&&seen.size<20){const current=pending.shift()!;if(seen.has(current))continue;seen.add(current);const ancestor=await tx.developmentSampleVersion.findFirst({where:{id:current,developmentCaseId:caseId,deletedAt:null}});if(!ancestor)continue;for(const linked of [ancestor.parentVersionId,ancestor.sourceVersionId])if(linked){if(linked===data.targetId)belongs=true;pending.push(linked);}}
  }
  if(!belongs)noticeFailure('FILE_NOT_IN_VERSION','附件不属于所选工厂版本',404);
  return {...data.file,id,reference:ref,available:true};}));
}
export async function uploadFactoryFile(ctx:Context,caseId:string,target:Target,input:{bytes:Buffer;originalName:string;requestKey:string;expectedUpdatedAt:string;replaceReference?:string}){
 const metadata=inspectFactoryFile(input.bytes,input.originalName),key=text(input.requestKey,'请求编号');
 const fingerprint=hash({target,metadata,replaceReference:input.replaceReference??null,actorId:ctx.actorId});
 return within(ctx,caseId,target,true,async(tx,_development,row)=>{
  const id='DFF_'+hash({caseId,key}),prior=await tx.auditLog.findUnique({where:{id}});
  if(prior){if(prior.actorId!==ctx.actorId||prior.detail?.fingerprint!==fingerprint)noticeFailure('REQUEST_CONFLICT','请求编号已用于其他附件');return {file:publicFile(prior.detail.file),reference:`development-file:${id}`,updatedAt:prior.detail.updatedAt};}
  if(target.kind==='trim'&&row.confirmedAt!=null)noticeFailure('INVALID_STATE','已确认辅料任务不能覆盖最终资料');
  if(String(row.updatedAt)!==input.expectedUpdatedAt)noticeFailure('REVISION_CONFLICT','工厂任务已变化，请刷新后上传');
  const existing=refs(row,target);if(!Array.isArray(existing))noticeFailure('INVALID_ATTACHMENTS','工厂版本附件目录无效');
  const replace=input.replaceReference===undefined?null:text(input.replaceReference,'所选附件',2048);
  if(replace!==null&&existing.filter((f:any)=>reference(f)===replace).length!==1)noticeFailure('REVISION_CONFLICT','所选附件已变化，请重新核对原文件');
  if(replace===null&&existing.length>=20)noticeFailure('INVALID_ATTACHMENTS','工厂版本最多20项附件');
  const stored=await(ctx.files??createFactoryFiles()).put(input.bytes,input.originalName),ref=`development-file:${id}`;
  const updatedAt=BigInt(Math.max(Date.now(),Number(row.updatedAt)+1));
  const delegate=target.kind==='version'?tx.developmentSampleVersion:tx.garmentTrimTask;
  const newReference=target.kind==='version'?ref:{name:stored.originalName,url:ref};
  const selected=replace===null?[...existing,newReference]:existing.map((f:any)=>reference(f)===replace?newReference:f);
  const data=target.kind==='version'?{referenceAttachments:selected,updatedAt}:{attachments:selected,updatedAt,revision:{increment:1}};
  const changed=await delegate.updateMany({where:{id:row.id,developmentCaseId:caseId,updatedAt:row.updatedAt,deletedAt:null},data});if(changed.count!==1)noticeFailure('REVISION_CONFLICT','工厂任务已变化，请刷新后上传');
  await tx.auditLog.create({data:{id,actorId:ctx.actorId,action:'development_factory_file',targetType:'DevelopmentCase',targetId:caseId,detail:safe({...target,fingerprint,file:stored,updatedAt})}});
  return {file:publicFile(stored),reference:ref,updatedAt:String(updatedAt)};
 });
}
export async function factoryNoticeContext(ctx:Context,caseId:string,target:Target){return within(ctx,caseId,target,false,async(tx,development,row)=>{
 const factory=await tx.relation.findFirst({where:{id:row.supplierRelationId,deletedAt:null}});
 return {target,caseCode:development.code,caseName:development.name,versionLabel:row.versionLabel??null,updatedAt:String(row.updatedAt),contactName:factory?.primaryContactName??null,contactPhone:factory?.primaryContactPhone??null,attachments:(await resolveFiles(tx,caseId,target,refs(row,target))).map(publicFile),notices:(await tx.auditLog.findMany({where:{action:'development_factory_notice',targetType:'DevelopmentCase',targetId:caseId,detail:{path:['targetId'],equals:target.targetId}},orderBy:[{createdAt:'desc'},{id:'desc'}]})).filter((a:any)=>a.detail?.kind===target.kind).map((a:any)=>({id:a.id,...publicNotice(a.detail.snapshot)}))};});}
export async function saveFactoryNotice(ctx:Context,caseId:string,target:Target,input:{requestKey:string;expectedUpdatedAt:string;contactName?:string|null;contactPhone?:string|null}){
 const key=text(input.requestKey,'请求编号'),fingerprint=hash({target,input,actorId:ctx.actorId});
 return within(ctx,caseId,target,true,async(tx,development,row)=>{
  const id='DFN_'+hash({caseId,key}),prior=await tx.auditLog.findUnique({where:{id}});if(prior){if(prior.actorId!==ctx.actorId||prior.detail?.fingerprint!==fingerprint)noticeFailure('REQUEST_CONFLICT','请求编号已用于其他通知单');return {id,...publicNotice(prior.detail.snapshot)};}
  if(String(row.updatedAt)!==input.expectedUpdatedAt)noticeFailure('REVISION_CONFLICT','工厂任务已变化，请核对后生成');
  const factory=await tx.relation.findFirst({where:{id:row.supplierRelationId,deletedAt:null}}),files=await resolveFiles(tx,caseId,target,refs(row,target));
  const batches=target.kind==='version'?await tx.sampleBatch.findMany({where:{developmentCaseId:caseId,sampleVersionId:row.versionKind==='minor'&&row.parentVersionId?row.parentVersionId:row.id,deletedAt:null},orderBy:[{formIndex:'asc'},{id:'asc'}]}):[];
  const round=target.kind==='version'?await tx.developmentSampleRound.findFirst({where:{id:row.roundId,developmentCaseId:caseId,deletedAt:null}}):null;
  const materials=development.type==='garment'&&target.kind==='version'?await tx.garmentMaterialUse.findMany({where:{developmentCaseId:caseId,sampleVersionId:row.versionKind==='minor'&&row.parentVersionId?row.parentVersionId:row.id,deletedAt:null},orderBy:{id:'asc'}}):[];
  const contact=(v:any,fallback:any)=>v===undefined?fallback??null:v===null?null:text(v,'联系人',200);
  const snapshot=safe({title:target.kind==='trim'?'辅料通知单':development.type==='fabric'?'面料试样通知单':'服装开发通知单',caseId,caseCode:development.code,caseName:development.name,...target,versionLabel:row.versionLabel??`辅料任务修订${row.revision}`,sourceUpdatedAt:row.updatedAt,supplierRelationId:row.supplierRelationId,supplierName:row.supplierName??factory?.name??null,contactName:contact(input.contactName,factory?.primaryContactName),contactPhone:contact(input.contactPhone,factory?.primaryContactPhone),requirements:row.factoryRequirements??row.requirements??null,roundRequirements:row.roundRequirementsSnapshot??null,dueDate:row.targetCompletionDate??row.dueDate??null,quantity:row.quantity??null,unit:row.unit??null,round:round?{purpose:round.purpose,materialConfig:round.materialConfig,notes:round.notes}:null,specification:development.type==='fabric'?development.fabricSpecification:development.garmentSpecification,samplePlans:batches.map((b:any)=>({sampleType:b.sampleType,specNote:b.specNote,quantity:b.planQuantity,unit:b.planUnit})),materials:materials.map((m:any)=>({position:m.position,specification:m.specification,color:m.color,perPiece:m.perPiece,unit:m.unit,provider:m.provider,colorMode:m.colorMode,colorReference:m.colorReference,sourceNature:m.sourceNature,snapshot:m.snapshot})),attachments:files,createdAt:new Date().toISOString()});
  await tx.auditLog.create({data:{id,actorId:ctx.actorId,action:'development_factory_notice',targetType:'DevelopmentCase',targetId:caseId,detail:{...target,fingerprint,snapshot}}});return {id,...publicNotice(snapshot)};
 });
}
export function factoryNoticeHtml(snapshot:any){const escape=(v:any)=>String(v??'未填写').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 const fields=[['开发单',`${snapshot.caseCode} ${snapshot.caseName??''}`],['版本',snapshot.versionLabel],['工厂',snapshot.supplierName],['联系人',snapshot.contactName],['联系电话',snapshot.contactPhone],['交期',snapshot.dueDate],['数量',snapshot.quantity==null?null:`${snapshot.quantity} ${snapshot.unit??''}`],['共同要求',snapshot.roundRequirements],['本厂要求/本次重点',snapshot.requirements],['轮次要求',JSON.stringify(snapshot.round??null)],['规格/尺寸',JSON.stringify(snapshot.specification??null)],['样品形态/件数',JSON.stringify(snapshot.samplePlans??[])],['面辅料',JSON.stringify(snapshot.materials??[])],['附件',snapshot.attachments.map((f:any)=>f.originalName).join('\n')||'无']];
 return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${escape(snapshot.title)}</title><style>body{font:14px/1.7 sans-serif;margin:32px;color:#111}dt{font-weight:bold;margin-top:12px}dd{margin:0;white-space:pre-wrap}button{margin-bottom:16px}@media print{button{display:none}}</style><button onclick="window.print()">打印 / 另存为 PDF</button><h1>${escape(snapshot.title)}</h1><dl>${fields.map(([label,value])=>`<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('')}</dl></html>`;
}
export async function readFactoryNotice(ctx:Context,caseId:string,id:string,zip=false){
 const snapshot=await ctx.prisma.$transaction(async(tx:any)=>{await authorizeDevelopmentSource(tx,ctx.actorId,ctx.trustedActor,caseId,{write:false});const audit=await tx.auditLog.findFirst({where:{id,action:'development_factory_notice',targetType:'DevelopmentCase',targetId:caseId}});if(!audit?.detail?.snapshot)noticeFailure('NOT_FOUND','通知单不存在',404);return audit.detail.snapshot;});
 if(!zip)return {bytes:Buffer.from(factoryNoticeHtml(snapshot)),name:`${snapshot.versionLabel}-${snapshot.title}.html`,mimeType:'text/html'};
 if(snapshot.attachments.some((f:any)=>!f.available))noticeFailure('ATTACHMENT_ORIGINAL_REQUIRED','该通知版本仍有未托管的附件链接，请将原文件上传到准确工厂版本后重新生成通知单');
 const files=await Promise.all(snapshot.attachments.map(async(f:any)=>({originalName:f.originalName,bytes:await(ctx.files??createFactoryFiles()).read(f)})));
 return {bytes:await factoryAttachmentZip(files),name:`${snapshot.versionLabel}-附件包.zip`,mimeType:'application/zip'};
}
export async function readFactoryOriginal(ctx:Context,caseId:string,target:Target,fileId:string){const file=await within(ctx,caseId,target,false,async(tx,_d,row)=>{
 const selected=(await resolveFiles(tx,caseId,target,refs(row,target))).find((f:any)=>f.id===fileId);if(!selected)noticeFailure('NOT_FOUND','原文件不属于所选版本',404);return selected;});return {file:publicFile(file),bytes:await(ctx.files??createFactoryFiles()).read(file)};}
