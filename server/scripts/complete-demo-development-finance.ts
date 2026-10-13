import dotenv from 'dotenv';dotenv.config({path:'.env.local',override:true});
import {PrismaClient} from '@prisma/client';import fs from 'node:fs/promises';
import {planScenarioMasterData} from './full-business-sim/masterData';import {buildBusinessScenarios} from './full-business-sim/scenarios';
import {runDevelopmentFinanceScenarios} from './full-business-sim/developmentFinanceDriver';
import {createPrivateScenarioJournal} from './full-business-sim/privateJournal';
import {createAuthService} from '../src/auth/service';import {buildLoadedAuthTokenPayload,loadUserWithRoles} from '../src/auth/tokenHelpers';
const db=new PrismaClient(),root='../scratch/demo-development-finance-resumed';
async function main(){
 const status=await fetch('http://localhost:8081/api/dev/status').then(r=>r.json());if(status.currentDb!=='panda_hub_dev')throw Error('WRONG_TARGET');
 const master=planScenarioMasterData({namespace:'dev-oct08',nowMs:Date.parse('2026-10-08T00:18:00Z')}), auth=createAuthService(),tokens=new Map<string,string>();
 const verifyActor=async(key:any)=>{const user=await loadUserWithRoles(db,master.cast[key].id);if(!user)throw Error('MISSING_ACTOR');tokens.set(key,auth.signToken(await buildLoadedAuthTokenPayload(db,user)));};
 const deps:any={runtimeId:'demo-development-finance-audit-20261008',actorIds:Object.fromEntries(Object.entries(master.cast).map(([k,a])=>[k,a.id])),journal:await createPrivateScenarioJournal(`${root}/journal`),verifyActor,
 invoke:async(actor:any,method:string,url:string,body:any)=>{await verifyActor(actor);const r=await fetch(`http://localhost:8081${url}`,{method:method.toUpperCase(),headers:{Authorization:`Bearer ${tokens.get(actor)}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});return {status:r.status,body:r.headers.get('content-type')?.includes('application/pdf')?Buffer.from(await r.arrayBuffer()):await r.json()};}};
 const selected=buildBusinessScenarios(master).developments.filter(s=>s.stopAfter==='development_ci_finance'),executions:any[]=[],archives:any[]=[],feePlans:any={};
 for(const s of selected){
  const c=await db.developmentCase.findFirst({where:{code:s.key,deletedAt:null}});if(!c)throw Error('MISSING_DEVELOPMENT');
  const response=await deps.invoke(s.owner,'get',`/api/v1/development/${encodeURIComponent(c.id)}/batches`);if(response.status!==200)throw Error('BATCH_READ_FAILED');
  const eligible=response.body.batches.filter((b:any)=>b.linkedAsset?.id&&b.latestFormalQcReview?.result==='pass'&&b.versionConfirmation?.result==='approved');
  if(eligible.length!==1)throw Error('EXACT_CONFIRMED_ARCHIVE_REQUIRED');const b=eligible[0];
  const archive={scenarioKey:s.key,family:s.family,caseId:c.id,batchId:b.id,versionId:b.sampleVersionId,assetId:b.linkedAsset.id,reviewId:b.latestFormalQcReview.id,confirmationId:b.versionConfirmation.id,factoryId:b.supplierRelationId,customerId:c.customerRelationId,ownerActorKey:s.owner,physicalCardIds:[]};
  const cost = await db.costRecord.findFirst({where:{sourceType:'SampleBatch',sourceId:b.id,deletedAt:null}});
  const billing = await db.billingItem.findFirst({where:{sourceType:'DevelopmentCase',sourceId:c.id,deletedAt:null}});
  if(!cost||!billing)throw Error('ORIGINAL_FEE_SOURCE_REQUIRED');
  const costAudit:any=await db.auditLog.findFirst({where:{targetId:cost.id,action:'register_development_cost'}});
  const billingAudit:any=await db.auditLog.findFirst({where:{targetId:billing.id,action:'create_development_billing_draft'}});
  if(!costAudit?.detail?.after?.command?.inputSnapshot||!billingAudit?.detail?.after)throw Error('ORIGINAL_COMMAND_MISSING');
  feePlans[s.key]={costAmount:cost.amount.toString(),costCurrency:cost.currency,amount:billing.amount.toString(),currency:billing.currency,dueDate:'2026-11-08',paymentTerms:'T/T within 30 days of the issued development CI',costNotes:costAudit.detail.after.command.inputSnapshot.notes,billingNote:billingAudit.detail.after.note};
  // These source facts are reconstructed from native readback, then fully revalidated by the finance driver.
  archives.push(archive);executions.push({key:s.key,family:s.family,stopReached:false,earnedSteps:['qc_completed_pass','requester_confirmed','version_archived'],ids:{caseId:c.id,batchId:b.id,versionId:b.sampleVersionId,assetId:b.linkedAsset.id},archive});
 }
 const result=await runDevelopmentFinanceScenarios(master,selected,{executions,archives},deps,{feePlans,ciBaseVersions:Object.fromEntries(selected.map(s=>[s.key,1]))});
 await fs.mkdir(root,{recursive:true});await fs.writeFile(`${root}/results.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result.finance));
}
main().finally(()=>db.$disconnect());
