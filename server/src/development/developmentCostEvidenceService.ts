import {createHash,randomUUID} from 'node:crypto';
import {Prisma} from '@prisma/client';
import {writeRouteAuditLog} from '../audit/routeAudit';
import {readDevelopmentExpenseSnapshot} from './developmentExpenseSnapshot';
import {createCostEvidenceFiles,inspectCostEvidenceFile} from './developmentCostEvidenceFiles';
type Context={prisma:any;actorId:string;authorize:(tx:any,caseId:string)=>Promise<unknown>;files?:ReturnType<typeof createCostEvidenceFiles>};
function reject(code:string,message:string,status=409):never{throw Object.assign(Error(message),{code,status,httpStatus:status});}
function text(raw:unknown,label:string,max=2000){if(typeof raw!=='string'||!raw.trim()||raw.trim().length>max)reject('INVALID_INPUT',`${label}未填写或过长`,400);return raw.trim();}
export function publicCostEvidence(row:any){const {storageKey,requestFingerprint,requestKey,...publicRow}=row;return publicRow;}
async function inCost<T>(ctx:Context,caseId:string,costId:string,work:(tx:any)=>Promise<T>):Promise<T>{
 text(ctx.actorId,'操作人',200);text(caseId,'开发案',200);text(costId,'费用',200);
 return ctx.prisma.$transaction(async(tx:any)=>{
  await ctx.authorize(tx,caseId);
  const rows=await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
  if(!rows.length)reject('NOT_FOUND','开发案不存在',404);
  await ctx.authorize(tx,caseId);
  const snapshot=await readDevelopmentExpenseSnapshot(tx,caseId);
  if(!snapshot.records.some((r:any)=>r.id===costId))reject('COST_NOT_IN_CASE','费用不属于本开发案',404);
  return work(tx);
 });
}
async function editable(tx:any,costId:string){
 const bound=await tx.billingItemCostCoverage.findFirst({where:{costRecordId:costId,releasedAt:null,billingItem:{status:{in:['confirmed','invoiced']}}},select:{id:true}});
 if(bound)reject('COST_EVIDENCE_LOCKED','费用已进入确认收费，请通过后续调整处理凭据，不能直接更改原依据');
}
export async function addDevelopmentCostEvidence(ctx:Context,caseId:string,costId:string,input:{bytes:Buffer;originalName:string;requestKey:string;note:string}){
 const key=text(input.requestKey,'请求标识',200),note=text(input.note,'凭据说明');
 const metadata=inspectCostEvidenceFile(input.bytes,input.originalName);
 const fingerprint=createHash('sha256').update(JSON.stringify({...metadata,note,actorId:ctx.actorId})).digest('hex');
 const files=ctx.files??createCostEvidenceFiles();let storedKey:string|undefined;
 try{return await inCost(ctx,caseId,costId,async tx=>{
  const prior=await tx.costEvidence.findUnique({where:{costRecordId_requestKey:{costRecordId:costId,requestKey:key}}});
  if(prior){if(prior.requestFingerprint!==fingerprint)reject('REQUEST_CONFLICT','该请求已登记其他凭据');return publicCostEvidence(prior);}
  await editable(tx,costId);
  const stored=await files.put(input.bytes,input.originalName);storedKey=stored.storageKey;
  const row=await tx.costEvidence.create({data:{id:randomUUID(),costRecordId:costId,requestKey:key,requestFingerprint:fingerprint,...stored,note,createdBy:ctx.actorId,createdAt:BigInt(Date.now())}});
  await writeRouteAuditLog({prisma:tx,actorId:ctx.actorId,source:'development-cost-evidence',operation:'development_cost_evidence_add',targetType:'CostEvidence',targetId:row.id,after:{costRecordId:costId,caseId,sha256:stored.sha256,note}});
  return publicCostEvidence(row);
 });}catch(error){
  if(storedKey){
   // Unknown commit outcomes must not delete a potentially referenced file.
   try{const referenced=await ctx.prisma.costEvidence.findUnique({where:{storageKey:storedKey},select:{id:true}});if(!referenced)await files.removeUnreferenced(storedKey);}catch{/* preserve for reconciliation; never guess that commit failed */}
  }
  throw error;
 }
}
export async function revokeDevelopmentCostEvidence(ctx:Context,caseId:string,costId:string,evidenceId:string,rawReason:string){
 const reason=text(rawReason,'撤销原因');
 return inCost(ctx,caseId,costId,async tx=>{
  const row=await tx.costEvidence.findFirst({where:{id:evidenceId,costRecordId:costId}});
  if(!row)reject('NOT_FOUND','凭据不存在',404);
  if(row.revokedAt!=null){if(row.revokedBy!==ctx.actorId||row.revokeReason!==reason)reject('ALREADY_REVOKED','凭据已由其他处理撤销');return publicCostEvidence(row);}
  await editable(tx,costId);
  const changed=await tx.costEvidence.update({where:{id:row.id},data:{revokedBy:ctx.actorId,revokedAt:BigInt(Date.now()),revokeReason:reason}});
  await writeRouteAuditLog({prisma:tx,actorId:ctx.actorId,source:'development-cost-evidence',operation:'development_cost_evidence_revoke',targetType:'CostEvidence',targetId:row.id,after:{costRecordId:costId,caseId,reason}});
  return publicCostEvidence(changed);
 });
}
export async function readDevelopmentCostEvidence(ctx:Context,caseId:string,costId:string,evidenceId:string){
 const row=await inCost(ctx,caseId,costId,async tx=>{
  const found=await tx.costEvidence.findFirst({where:{id:evidenceId,costRecordId:costId}});if(!found)reject('NOT_FOUND','凭据不存在',404);return found;
 });
 return {evidence:publicCostEvidence(row),bytes:await(ctx.files??createCostEvidenceFiles()).read(row)};
}
export async function listDevelopmentCostEvidence(ctx:Context,caseId:string,costId:string){
 return inCost(ctx,caseId,costId,async tx=>(await tx.costEvidence.findMany({where:{costRecordId:costId},orderBy:[{createdAt:'desc'},{id:'desc'}]})).map(publicCostEvidence));
}
