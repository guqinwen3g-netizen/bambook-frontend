import {registerDevelopmentCost} from '../src/development/developmentCostRegistration';
/** Local-only real database and private-file verification. All fixtures roll back. */
import dotenv from 'dotenv';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {PrismaClient} from '@prisma/client';
import {createCostEvidenceFiles} from '../src/development/developmentCostEvidenceFiles';
import {addDevelopmentCostEvidence,revokeDevelopmentCostEvidence,readDevelopmentCostEvidence} from '../src/development/developmentCostEvidenceService';
import {assertDevelopmentExpenseAccess} from '../src/development/developmentExpenseAccess';
import {previewDevelopmentClosure,recordDevelopmentLifecycle,previewDevelopmentExpenseReview,confirmDevelopmentExpenseReview,assertDevelopmentExpenseReviewCurrentInTx} from '../src/development/developmentClosureService';
dotenv.config({path:'.env.local'});dotenv.config();const url=new URL(process.env.DATABASE_URL||'');assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname==='/panda_hub_local'&&(!url.port||url.port==='5432'));
const db=new PrismaClient(),tag=`cost-evidence-${Date.now()}`,rollback=Error('ROLLBACK_FIXTURES');
async function main(){
 const [identity]:any[]=await db.$queryRaw`SELECT current_database() name,inet_server_addr()::text address`;assert.equal(identity.name,'panda_hub_local');assert(['127.0.0.1','::1'].includes(String(identity.address).split('/')[0]));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bambook-evidence-audit-'));const files=createCostEvidenceFiles(root);const results:any[]=[];
 try{try{await db.$transaction(async tx=>{
  const now=BigInt(Date.now());await tx.userAccount.create({data:{id:tag,displayName:'隔离凭据测试',status:'active'}});
  for(const scope of ['products:read','products:write'])await tx.userPermissionOverrides.create({data:{id:`${tag}-${scope}`,userId:tag,scope,grantedBy:tag,reason:'隔离测试回滚'}});
  await tx.relation.create({data:{id:tag,name:'本地测试客户',category:'customer',type:'company',isOrganization:true,tags:[],contactInfo:'{}',lastInteraction:now,ownerId:tag}});
  const actor:any={userId:tag,roles:[],permissions:['products:read','products:write']};
  const client:any={...tx,$transaction:async(fn:any)=>fn(tx)};
  const ctx={prisma:client,actorId:tag,files,authorize:(transaction:any,id:string)=>assertDevelopmentExpenseAccess(transaction,actor,id,'write')};
  for(const type of ['fabric','garment']){
   const id=`${tag}-${type}`;
   await tx.developmentCase.create({data:{id,code:id,name:'本地凭据验证',type,stage:'approved',customerRelationId:tag,tags:[],createdAt:now,updatedAt:now}});
   const registration={requestKey:'same-cost',sourceType:'DevelopmentCase',sourceId:id,costType:'shipping',amount:'12.3456',currency:'CNY',incurredAt:'2026-09-30'};
   const cost=await registerDevelopmentCost(ctx,id,registration);const costId=cost.id;
   assert.equal((await registerDevelopmentCost(ctx,id,registration)).id,costId);
   assert.equal(await tx.costRecord.count({where:{sourceType:'DevelopmentCase',sourceId:id}}),1);
   await assert.rejects(()=>registerDevelopmentCost(ctx,id,{...registration,amount:'99'}),(e:any)=>e.status===409);
   assert.equal(cost.bearerType,'internal');
   const p=await previewDevelopmentClosure(ctx,id);await recordDevelopmentLifecycle(ctx,id,{action:'close',outcome:'completed',reason:'测试开发完成',requestKey:'close',expectedRevision:p.revision,expectedFingerprint:p.fingerprint});
   async function review(key:string){const p=await previewDevelopmentExpenseReview(ctx,id);return confirmDevelopmentExpenseReview(ctx,id,{requestKey:key,expectedFingerprint:p.fingerprint,note:'测试费用核齐'});}
   const old=await review('before');
   const input={bytes:Buffer.from('%PDF-1.7\nlocal isolated receipt'),originalName:'receipt.pdf',requestKey:'upload',note:'本案快递凭据'};
   const evidence=await addDevelopmentCostEvidence(ctx,id,costId,input);
   assert.equal((await addDevelopmentCostEvidence(ctx,id,costId,input)).id,evidence.id);assert.equal(await tx.costEvidence.count({where:{costRecordId:costId}}),1);
   await assert.rejects(()=>assertDevelopmentExpenseReviewCurrentInTx(tx,id,old.id),(e:any)=>e.code==='REVIEW_STALE');
   const reviewed=await review('with-evidence');assert.equal((reviewed.snapshot as any).costs.records[0].evidence[0].sha256,evidence.sha256);
   assert(!(JSON.stringify(reviewed.snapshot)).includes('storageKey'));
   const read=await readDevelopmentCostEvidence({...ctx,authorize:(t:any,c:string)=>assertDevelopmentExpenseAccess(t,actor,c,'read')},id,costId,evidence.id);assert(read.bytes.equals(input.bytes));
   await assert.rejects(()=>readDevelopmentCostEvidence(ctx,id,'wrong-cost',evidence.id),(e:any)=>e.code==='COST_NOT_IN_CASE');
   await revokeDevelopmentCostEvidence(ctx,id,costId,evidence.id,'测试撤销错误账单');
   await assert.rejects(()=>assertDevelopmentExpenseReviewCurrentInTx(tx,id,reviewed.id),(e:any)=>e.code==='REVIEW_STALE');
   assert.equal((reviewed.snapshot as any).costs.records[0].evidence[0].revokedAt,null);
   assert.equal((await tx.costRecord.findUniqueOrThrow({where:{id:costId}})).amount.toString(),'12.3456');
   await tx.userPermissionOverrides.updateMany({where:{userId:tag,scope:'products:write'},data:{isActive:false}});
   await assert.rejects(()=>addDevelopmentCostEvidence(ctx,id,costId,{...input,requestKey:'revoked-scope'}),(e:any)=>e.status===403);
   await tx.userPermissionOverrides.updateMany({where:{userId:tag,scope:'products:write'},data:{isActive:true}});
   results.push({type,costRegistrationRetryOnce:true,uploadRetryOnce:true,originalFileReadable:true,addAndRevokeInvalidateReview:true,historicalSnapshotPreserved:true,costUnchanged:true,revokedWriteDenied:true});
  }
  throw rollback;
 },{timeout:30000,maxWait:10000});}catch(e){if(e!==rollback)throw e;}
 assert.equal(await db.userAccount.count({where:{id:tag}}),0);console.log(JSON.stringify({result:'PASS',results,fixturesRolledBack:true,browserProof:false}));
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>db.$disconnect());
