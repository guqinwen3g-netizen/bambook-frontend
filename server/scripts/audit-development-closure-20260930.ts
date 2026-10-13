/** Local PG: explicit lifecycle/review + concurrent retries. Not a browser/role authorization proof. */
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { nextBusinessNumber } from '../src/shared/businessNumberService';
import { previewDevelopmentClosure as preview, recordDevelopmentLifecycle as lifecycle,
  previewDevelopmentExpenseReview as expensePreview, confirmDevelopmentExpenseReview as review,
  assertDevelopmentExpenseReviewCurrentInTx as current } from '../src/development/developmentClosureService';
import { registerPendingDevelopmentExpense as pending, completePendingDevelopmentExpense as complete } from '../src/development/developmentPendingExpenseService';
import { updateDevelopmentStage, deleteDevelopmentCase } from '../src/development/developmentCaseMutationService';
import { createCostRecordInTx, createBillingItemInTx, createBillingItem, confirmBillingItem, invoiceBillingItem, cancelBillingItem } from '../src/finance/billingItemService';
import { createSample, updateSample, deleteSample, advanceSampleStage, forkSample } from '../src/samples/sampleManageService';
import { bindDevelopmentBillingCoverage, bindDevelopmentBillingCoverageInTx } from '../src/development/developmentBillingCoverageService';
import { createDevelopmentFinanceHandoff, confirmDevelopmentBillingAndHandoff } from '../src/development/developmentFinanceHandoffService';
import { createDevelopmentBillingDraft } from '../src/development/developmentBillingDraftService';
import { transitionDevelopmentBilling } from '../src/development/developmentBillingWorkflowService';
import { createInvoice, updateInvoice } from '../src/finance/invoiceMutationService';
dotenv.config({path:'.env.local'}); dotenv.config();
const url=new URL(process.env.DATABASE_URL||'');
assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname==='/panda_hub_local'&&(!url.port||url.port==='5432'));
const db=new PrismaClient(),tag=`closure-audit-${Date.now()}`;
async function main(){
 const [identity]:any[]=await db.$queryRaw`SELECT current_database() AS name,inet_server_addr()::text AS address`;
 assert.equal(identity.name,'panda_hub_local');assert(['127.0.0.1','::1'].includes(String(identity.address).split('/')[0]));
 const results:any[]=[];
 const numberTestYear=100000000+Math.floor(Math.random()*1000000000);
 const numberTestSequence=`SEQ_SM_${numberTestYear}`;
 assert.equal(await db.businessSequence.count({where:{id:numberTestSequence}}),0);
 try {
  const numberResults=await Promise.allSettled(Array.from({length:6},()=>db.$transaction(tx=>nextBusinessNumber(tx,'SM',numberTestYear),{maxWait:20000,timeout:10000})));
  const firstNumbers=numberResults.map(result=>{if(result.status==='rejected')throw result.reason;return result.value;});
  assert.equal(new Set(firstNumbers).size,6);
  assert.equal((await db.businessSequence.findUniqueOrThrow({where:{id:numberTestSequence}})).seq,6);
  await db.userAccount.create({data:{id:tag,displayName:'本地结案核齐验证',status:'inactive'}});
  await db.relation.create({data:{id:tag,name:'本地核齐测试客户',category:'customer',type:'company',isOrganization:true,tags:[],contactInfo:'{}',lastInteraction:BigInt(Date.now())}});
  await db.userAccount.create({data:{id:`${tag}-finance`,displayName:'本地财务交接测试',status:'active'}});
  // Different cases avoid serializing through one case lock: the shared SM sequence
  // must protect concurrent registration itself. Existing sequence is never reset.
  const numberCases = [0,1].map(n=>`${tag}-number-${n}`);
  for (const id of numberCases) await db.developmentCase.create({data:{id,code:id,name:'样品并发编号验证',type:'fabric',stage:'approved',tags:[],createdAt:BigInt(Date.now()),updatedAt:BigInt(Date.now())}});
  const registered = await Promise.all(Array.from({length:6},(_,i)=>createSample({prisma:db,input:{type:'dev',sourceCaseId:numberCases[i%2]},actorId:tag})));
  const codes = registered.map(result=>{assert.equal(result.ok,true,result.ok?undefined:result.error.message);if(!result.ok)throw new Error('sample registration failed');return result.data.sample.code;});
  assert.equal(new Set(codes).size,6);
  assert(codes.every(code=>/^SM-\d{4}-\d{4,}$/.test(code)));
  assert.equal(await db.sample.count({where:{code:{in:codes}}}),6);
  for(const [i,type] of ['fabric','garment'].entries()) {
   const caseId=numberCases[i];
   await db.developmentCase.update({where:{id:caseId},data:{type,customerRelationId:tag}});
   const ctx={prisma:db,actorId:tag,authorize:async(_tx:any,id:string)=>{assert.equal(id,caseId);}};
   const body={requestKey:'early-draft',amount:'80',waivedAmount:'10',currency:'USD',note:'开发尚未结案，先记录收费方案'};
   const early=await createDevelopmentBillingDraft(ctx,caseId,body);
   assert.equal(early.billingItem.status,'draft');assert.equal(early.billingItem.developmentExpenseReviewId,null);
   assert.equal(await db.billingItemCostCoverage.count({where:{billingItemId:early.billingItem.id}}),0);
   assert.equal((await createDevelopmentBillingDraft(ctx,caseId,body)).billingItem.id,early.billingItem.id);
   await assert.rejects(()=>createDevelopmentBillingDraft(ctx,caseId,{...body,requestKey:'other-draft'}),(e:any)=>e.code==='CASE_ALREADY_BILLED');
   const blocked=await confirmBillingItem({prisma:db,id:early.billingItem.id,actorId:tag});
   assert.equal(blocked.ok,false);assert.equal(blocked.error?.code,'REVIEW_REQUIRED');
   assert.equal((await db.billingItem.findUniqueOrThrow({where:{id:early.billingItem.id}})).status,'draft');
   // Complete this isolated fixture, then exercise real transactional role handoffs.
   await db.sample.updateMany({where:{sourceCaseId:caseId},data:{status:'confirmed'}});
   await db.$transaction(tx=>createCostRecordInTx(tx,{actorId:tag,input:{sourceType:'DevelopmentCase',sourceId:caseId,costType:'development',amount:'40',currency:'USD'}}));
   const cp=await preview(ctx,caseId);
   await lifecycle(ctx,caseId,{action:'close',outcome:'completed',reason:'开发完成',disposition:'收齐费用',expectedRevision:cp.revision,expectedFingerprint:cp.fingerprint,requestKey:'wf-close'});
   const ep=await expensePreview(ctx,caseId);
   const er=await review(ctx,caseId,{expectedFingerprint:ep.fingerprint,requestKey:'wf-review',note:'费用核齐'});
   const wc={prisma:db,actorId:tag,authorizeBusiness:ctx.authorize,authorizeFinance:ctx.authorize,authorizeRecipient:async(_tx:any,c:string,u:string)=>{assert.equal(c,caseId);assert.equal(u,`${tag}-finance`);}};
   const submit={action:'submit' as const,requestKey:'wf-submit',expectedVersion:0,note:'申请核对',reviewId:er.id,userId:`${tag}-finance`};
   let failedWorkflowAudit=0;
   const failWorkflowDb=db.$extends({query:{auditLog:{async create({args,query}){if(args.data.action==='development_billing_submit'){failedWorkflowAudit++;throw Error('TEST_ONLY_WORKFLOW_AUDIT_FAILURE');}return query(args);}}}});
   await assert.rejects(()=>transitionDevelopmentBilling({...wc,prisma:failWorkflowDb},caseId,early.billingItem.id,submit),/TEST_ONLY_WORKFLOW_AUDIT_FAILURE/);
   assert.equal(failedWorkflowAudit,1);
   const beforeRetry=await db.billingItem.findUniqueOrThrow({where:{id:early.billingItem.id}});
   assert.equal(beforeRetry.developmentWorkflowState,'draft');assert.equal(beforeRetry.developmentWorkflowVersion,0);assert.equal(beforeRetry.developmentExpenseReviewId,null);
   assert.equal(await db.billingItemCostCoverage.count({where:{billingItemId:early.billingItem.id}}),0);
   assert.equal(await db.developmentBillingWorkflowEvent.count({where:{billingItemId:early.billingItem.id}}),0);
   assert.equal(await db.workAssignment.count({where:{metadata:{path:['billingItemId'],equals:early.billingItem.id}}}),0);
   const submitted=await Promise.all([transitionDevelopmentBilling(wc,caseId,early.billingItem.id,submit),transitionDevelopmentBilling(wc,caseId,early.billingItem.id,submit)]);
   assert.equal(submitted[0].event.id,submitted[1].event.id);
   assert.equal(submitted[0].billingItem.status,'draft');
   const cannotConfirm=await confirmBillingItem({prisma:db,id:early.billingItem.id,actorId:tag});
   assert.equal(cannotConfirm.ok,false);
   await assert.rejects(()=>transitionDevelopmentBilling(wc,caseId,early.billingItem.id,{action:'return',requestKey:'wrong-actor',expectedVersion:1,note:'退回',requiredItems:['凭据']}),(e:any)=>e.code==='FORBIDDEN');
   const returnCommand={action:'return' as const,requestKey:'wf-return',expectedVersion:1,note:'需明确减免依据',requiredItems:['减免说明']};
   const failReturnDb=db.$extends({query:{auditLog:{async create({args,query}){if(args.data.action==='development_billing_return')throw Error('TEST_ONLY_RETURN_AUDIT_FAILURE');return query(args);}}}});
   await assert.rejects(()=>transitionDevelopmentBilling({...wc,prisma:failReturnDb,actorId:`${tag}-finance`},caseId,early.billingItem.id,returnCommand),/TEST_ONLY_RETURN_AUDIT_FAILURE/);
   const retainedSubmission=await db.billingItem.findUniqueOrThrow({where:{id:early.billingItem.id}});
   assert.equal(retainedSubmission.developmentWorkflowState,'submitted');assert.equal(retainedSubmission.developmentWorkflowVersion,1);
   assert.equal(await db.billingItemCostCoverage.count({where:{billingItemId:early.billingItem.id,releasedAt:null}}),1);
   assert.equal(await db.developmentBillingWorkflowEvent.count({where:{billingItemId:early.billingItem.id}}),1);
   const unchangedTasks=await db.workAssignment.findMany({where:{metadata:{path:['billingItemId'],equals:early.billingItem.id}}});
   assert.equal(unchangedTasks.length,1);assert.equal(unchangedTasks[0].status,'assigned');
   await transitionDevelopmentBilling({...wc,actorId:`${tag}-finance`},caseId,early.billingItem.id,returnCommand);
   assert.equal(await db.billingItemCostCoverage.count({where:{billingItemId:early.billingItem.id,releasedAt:null}}),0);
   await transitionDevelopmentBilling(wc,caseId,early.billingItem.id,{action:'edit',requestKey:'wf-edit',expectedVersion:2,note:'本案客户优惠10美元',amount:'80',waivedAmount:'10',currency:'USD'});
   await transitionDevelopmentBilling(wc,caseId,early.billingItem.id,{...submit,requestKey:'wf-resubmit',expectedVersion:3});
   assert.equal(await db.billingItemCostCoverage.count({where:{billingItemId:early.billingItem.id}}),2);
   assert.equal(await db.billingItemCostCoverage.count({where:{billingItemId:early.billingItem.id,releasedAt:null}}),1);
   assert.equal(await db.developmentBillingWorkflowEvent.count({where:{billingItemId:early.billingItem.id}}),4);
   assert.equal(await db.workAssignment.count({where:{status:'assigned',metadata:{path:['billingItemId'],equals:early.billingItem.id}}}),1);
   results.push({workflow:type,concurrentSubmitDeduplicated:true,failedSubmitAtomicRollback:true,failedReturnAtomicRollback:true,sameRequestRetryAfterFailure:true,returnEditResubmit:true,events:4,activeCoverage:1,activeTasks:1,permissionProof:false});
   await transitionDevelopmentBilling({...wc,actorId:`${tag}-finance`},caseId,early.billingItem.id,{action:'return',requestKey:'return-before-cancel',expectedVersion:4,note:'重新核实收费方案',requiredItems:['客户意见']});
   const cancelCommand={action:'cancel' as const,requestKey:'cancel-draft',expectedVersion:5,note:'旧方案作废，费用记录继续保留'};
   const cancelled=await transitionDevelopmentBilling(wc,caseId,early.billingItem.id,cancelCommand);
   assert.equal(cancelled.billingItem.status,'cancelled');
   assert.equal((await transitionDevelopmentBilling(wc,caseId,early.billingItem.id,cancelCommand)).recovered,true);
   assert.equal(await db.workAssignment.count({where:{status:'assigned',metadata:{path:['billingItemId'],equals:early.billingItem.id}}}),0);
   assert.equal(await db.costRecord.count({where:{sourceType:'DevelopmentCase',sourceId:caseId}}),1);
   assert.equal(await db.developmentBillingWorkflowEvent.count({where:{billingItemId:early.billingItem.id}}),6);
   results.push({cancelWorkflow:type,retainedCost:true,retainedEvents:6,activeTasks:0,retryRecovered:true});


  }
  results.push({sampleNumbering:{concurrentRegistrations:6,distinctCases:2,uniquePersistedCodes:true}});
  for(const type of ['fabric','garment']){
   const id=`${tag}-${type}`,now=BigInt(Date.now());
   await db.developmentCase.create({data:{id,code:id,name:'本地结案核齐验证',type,stage:'approved',tags:[],createdAt:now,updatedAt:now}});
   const context={prisma:db,actorId:tag,
    authorize:async(tx:any,caseId:string)=>{assert.equal(caseId,id);return tx.developmentCase.findUniqueOrThrow({where:{id}});},
    authorizeAssignee:async(_tx:any,caseId:string,userId:string)=>{assert.equal(caseId,id);assert.equal(userId,tag);},
   };
   async function act(action:'pause'|'resume') {const p=await preview(context,id);return lifecycle(context,id,{action,reason:'明确暂停或恢复',expectedRevision:p.revision,expectedFingerprint:p.fingerprint,requestKey:action});}
   await act('pause');assert.equal((await preview(context,id)).state,'paused');
   assert.equal((await updateDevelopmentStage({prisma:db,caseId:id,stage:'approved',actorId:tag})).error?.code,'DEVELOPMENT_PAUSED');
   assert.equal((await deleteDevelopmentCase({prisma:db,caseId:id,actorId:tag})).error?.code,'LIFECYCLE_HISTORY_EXISTS');
   await act('resume');
   assert.equal((await updateDevelopmentStage({prisma:db,caseId:id,stage:'approved',actorId:tag})).ok,true);
   const bill=await pending(context,id,{requestKey:'bill',sourceType:'DevelopmentCase',sourceId:id,costType:'shipping',description:'快递账单待到',ownerId:tag});
   const p=await preview(context,id);const closeInput={action:'close' as const,outcome:'completed' as const,reason:'本案开发结束',disposition:'业务员继续收齐快递账单',expectedRevision:p.revision,expectedFingerprint:p.fingerprint,requestKey:'close'};
   const closed=await Promise.all([lifecycle(context,id,closeInput),lifecycle(context,id,closeInput)]);assert.equal(closed[0].id,closed[1].id);
   assert.equal((await updateDevelopmentStage({prisma:db,caseId:id,stage:'approved',actorId:tag})).error?.code,'DEVELOPMENT_CLOSED');
   let expense=await expensePreview(context,id);
   await assert.rejects(()=>review(context,id,{expectedFingerprint:expense.fingerprint,requestKey:'too-early',note:'尚未齐'}),(e:any)=>e.code==='EXPENSES_PENDING');
   await complete(context,id,bill.id,{requestKey:'resolve-bill',expectedVersion:1,outcome:'resolved',note:'到账单已核实',amount:'12.3456',currency:'CNY',incurredAt:'2026-09-30'});
   expense=await expensePreview(context,id);const reviewInput={expectedFingerprint:expense.fingerprint,requestKey:'review',note:'整案费用已核齐'};
   const reviewed=await Promise.all([review(context,id,reviewInput),review(context,id,reviewInput)]);assert.equal(reviewed[0].id,reviewed[1].id);
   assert.equal(await db.developmentExpenseReview.count({where:{developmentCaseId:id}}),1);
   const productionSampleId=`${id}-production-sample`;
   await db.sample.create({data:{id:productionSampleId,code:productionSampleId,type:'pp',status:'making',sourceCaseId:id,createdAt:now,updatedAt:now}});
   assert.equal((await preview(context,id)).openItems.some((r:any)=>r.id===productionSampleId),false);
   // Production provenance alone neither adds unfinished development nor changes an expense review.
   await db.$transaction(tx=>current(tx,id,reviewed[0].id));
   await assert.rejects(()=>pending(context,id,{requestKey:'wrong-domain',sourceType:'Sample',sourceId:productionSampleId,costType:'shipping',description:'生产寄样费',ownerId:tag}),(e:any)=>e.code==='INVALID_SOURCE');
   const ambiguousCost=await db.$transaction(tx=>createCostRecordInTx(tx,{actorId:tag,input:{sourceType:'Sample',sourceId:productionSampleId,costType:'shipping',amount:'3',currency:'CNY'}}));
   const blockedDeletion=await deleteSample({prisma:db,sampleId:productionSampleId,actorId:tag});
   assert.equal(blockedDeletion.ok,false);
   if(!blockedDeletion.ok) assert.equal(blockedDeletion.error.code,'SAMPLE_HAS_HISTORY');
   const ambiguousPreview=await expensePreview(context,id);
   await assert.rejects(()=>review(context,id,{expectedFingerprint:ambiguousPreview.fingerprint,requestKey:'unresolved-domain',note:'不得忽略未归属费用'}),(e:any)=>e.code==='EXPENSE_SCOPE_UNRESOLVED');
   // Remove only this audit fixture; business ownership corrections must use an explicit adjustment flow.
   await db.costRecord.delete({where:{id:ambiguousCost.id}});
   await db.$transaction(async tx=>{await tx.$queryRaw`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${id} FOR UPDATE`;await current(tx,id,reviewed[0].id);});
   await db.sample.create({data:{id:`${id}-late-sample`,code:`${id}-late-sample`,type:'dev',status:'confirmed',sourceCaseId:id,createdAt:now,updatedAt:now}});
   const lateSampleId=`${id}-late-sample`;
   const blockedCreation=await createSample({prisma:db,input:{type:'dev',sourceCaseId:id},actorId:tag});
   assert.equal(blockedCreation.ok,false);
   if(!blockedCreation.ok) assert.equal(blockedCreation.error.code,'DEVELOPMENT_CLOSED');
   const blockedEdit=await updateSample({prisma:db,sampleId:lateSampleId,input:{notes:'不得重写已结案开发'},actorId:tag});
   assert.equal(blockedEdit.ok,false);
   const lateShipping=await updateSample({prisma:db,sampleId:lateSampleId,input:{trackingNumber:'LATE-TRACK'},actorId:tag});
   assert.equal(lateShipping.ok,true);
   assert.equal((await db.sample.findUniqueOrThrow({where:{id:lateSampleId}})).trackingNumber,'LATE-TRACK');
   const blockedStage=await advanceSampleStage({prisma:db,sampleId:lateSampleId,action:'seal',actorId:tag});
   assert.equal(blockedStage.ok,false);
   if(!blockedStage.ok) assert.equal(blockedStage.error.code,'DEVELOPMENT_CLOSED');
   const forked=await forkSample({prisma:db,sampleId:lateSampleId,input:{toType:'pp'},actorId:tag});
   assert.equal(forked.ok,true,forked.ok?undefined:forked.error.message);
   if(forked.ok) {
    const started=await advanceSampleStage({prisma:db,sampleId:forked.data.sample.id,action:'start',actorId:tag});
    assert.equal(started.ok,true);
    assert.equal((await db.sample.findUniqueOrThrow({where:{id:forked.data.sample.id}})).status,'making');
   }
   await assert.rejects(()=>db.$transaction(tx=>current(tx,id,reviewed[0].id)),(e:any)=>e.code==='REVIEW_STALE');
   const changedSources=await expensePreview(context,id);
   const secondReview=await review(context,id,{expectedFingerprint:changedSources.fingerprint,requestKey:'review-new-source',note:'新增来源也已核查'});
   await db.$transaction(tx=>createCostRecordInTx(tx,{actorId:tag,input:{sourceType:'DevelopmentCase',sourceId:id,costType:'testing',amount:'2',currency:'USD'}}));
   await assert.rejects(()=>db.$transaction(async tx=>{await tx.$queryRaw`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${id} FOR UPDATE`;return current(tx,id,secondReview.id);}),(e:any)=>e.code==='REVIEW_STALE');
   const stored=await db.developmentExpenseReview.findUniqueOrThrow({where:{id:reviewed[0].id}});
   assert.deepEqual((stored.snapshot as any).costs.totals,[{currency:'CNY',amount:'12.3456'}]);
   assert.equal(await db.invoice.count({where:{sourceId:id}}),0);
   const finalExpense=await expensePreview(context,id);
   const finalReview=await review(context,id,{expectedFingerprint:finalExpense.fingerprint,requestKey:'review-before-billing',note:'核对全部币种成本'});
   let billingId=`${id}-billing`;
   await db.billingItem.create({data:{id:billingId,itemNo:billingId,sourceType:'DevelopmentCase',sourceId:id,chargeType:'development_fee',bearerType:'customer',bearerRelationId:tag,amount:'80',currency:'USD',createdAt:now,updatedAt:now}});
   const billingContext={prisma:db,actorId:tag,authorize:async(_tx:any,caseId:string,itemId:string)=>{assert.equal(caseId,id);assert(itemId.startsWith(id));}};
   const bound=await Promise.all([1,2].map(()=>bindDevelopmentBillingCoverage(billingContext,{caseId:id,billingItemId:billingId,reviewId:finalReview.id})));
   assert.equal(bound.filter(r=>r.recovered).length,1);
   assert.equal(await db.billingItemCostCoverage.count({where:{billingItemId:billingId}}),2);
   let rolledBackDraftId='';
   await assert.rejects(()=>db.$transaction(async tx=>{
    const draft=await createBillingItemInTx(tx,{actorId:tag,input:{sourceType:'DevelopmentCase',sourceId:id,chargeType:'development_fee',amount:80,currency:'USD',bearerRelationId:tag}});
    rolledBackDraftId=draft.id;
    await bindDevelopmentBillingCoverageInTx(tx,{prisma:db,actorId:tag,authorize:async(_tx:any,caseId:string)=>{assert.equal(caseId,id);}},{caseId:id,billingItemId:draft.id,reviewId:finalReview.id});
   }),(e:any)=>e.code==='CASE_ALREADY_BILLED');
   assert(rolledBackDraftId);
   assert.equal(await db.billingItem.count({where:{id:rolledBackDraftId}}),0);
   assert.equal(await db.auditLog.count({where:{targetId:rolledBackDraftId}}),0);
   const initialVersion=String((await db.billingItem.findUniqueOrThrow({where:{id:billingId}})).updatedAt);
   const initialHandoff=await confirmDevelopmentBillingAndHandoff({prisma:db,actorId:tag,authorize:async()=>{},authorizeRecipient:async()=>{}},{caseId:id,billingItemId:billingId,userId:`${tag}-finance`,expectedUpdatedAt:initialVersion});
   const cancelledId=billingId;
   const noReason=await cancelBillingItem({prisma:db,id:cancelledId,actorId:tag});
   assert.equal(noReason.ok,false);
   assert.equal(noReason.error?.code,'REASON_REQUIRED');
   const cancelled=await cancelBillingItem({prisma:db,id:cancelledId,reason:'重新核对收费方案',actorId:tag});
   assert.equal(cancelled.ok,true,cancelled.error?.message);
   const cancelledTask=await db.workAssignment.findUniqueOrThrow({where:{id:initialHandoff.assignment.id}});
   assert.equal(cancelledTask.status,'cancelled');assert.equal(cancelledTask.completedAt,null);
   assert.equal((cancelledTask.metadata as any).cancellation.reason,'重新核对收费方案');

   const historicalCoverage=await db.billingItemCostCoverage.findMany({where:{billingItemId:cancelledId}});
   assert.equal(historicalCoverage.length,2);
   assert(historicalCoverage.every(c=>c.releasedAt!==null&&c.releaseReason==='重新核对收费方案'));
   assert.equal((await db.billingItem.findUniqueOrThrow({where:{id:cancelledId}})).developmentExpenseReviewId,finalReview.id);
   // Updating the customer before a fresh review is required because it is part of the source snapshot.
   await db.developmentCase.update({where:{id},data:{customerRelationId:tag}});
   const billingPreview=await expensePreview(context,id);
   const billingReview=await review(context,id,{expectedFingerprint:billingPreview.fingerprint,requestKey:'review-for-customer',note:'收费客户已核实'});
   const draftInput={reviewId:billingReview.id,requestKey:'whole-case-draft',amount:'80',waivedAmount:type==='garment'?'80':'0',currency:'USD',note:'本案综合开发费'};
   const drafts=await Promise.all([1,2].map(()=>createDevelopmentBillingDraft(context,id,draftInput)));
   assert.equal(drafts[0].billingItem.id,drafts[1].billingItem.id);
   assert.equal(drafts.filter(r=>r.recovered).length,1);
   await assert.rejects(()=>createDevelopmentBillingDraft(context,id,{...draftInput,amount:'81'}),(e:any)=>e.code==='REQUEST_CONFLICT');
   billingId=drafts[0].billingItem.id;
   assert.equal(await db.billingItemCostCoverage.count({where:{billingItemId:billingId,releasedAt:null}}),2);
   const covered=await db.billingItemCostCoverage.findFirstOrThrow({where:{billingItemId:billingId}});
   const duplicateSingle=await createBillingItem({prisma:db,input:{sourceType:'DevelopmentCase',sourceId:id,chargeType:'development_fee',costRecordId:covered.costRecordId,amount:1},actorId:tag});
   assert.equal(duplicateSingle.ok,false);
   if(!duplicateSingle.ok) assert.equal(duplicateSingle.error.code,'COST_ALREADY_BILLED');
   const duplicateInvoice=await createInvoice({prisma:db,input:{invoiceNumber:`${id}-blocked-invoice`,type:'Receivable',status:'Draft',amount:1,currency:'CNY',issueDate:'2026-09-30',invoiceLines:[{sourceType:'CostRecord',sourceId:covered.costRecordId,amount:1,currency:'CNY'}]},actorId:tag});
   assert.equal(duplicateInvoice.ok,false);
   if(!duplicateInvoice.ok) assert.equal(duplicateInvoice.error.code,'LINE_ALREADY_ALLOCATED');
   assert.equal(await db.invoice.count({where:{invoiceNumber:`${id}-blocked-invoice`}}),0);
   assert.equal((await db.billingItem.findUniqueOrThrow({where:{id:billingId}})).amount.toString(),'80');
   const secondBillingId=`${id}-billing-duplicate`;
   await db.billingItem.create({data:{id:secondBillingId,itemNo:secondBillingId,sourceType:'DevelopmentCase',sourceId:id,chargeType:'development_fee',amount:'1',currency:'CNY',createdAt:now,updatedAt:now}});
   await assert.rejects(()=>bindDevelopmentBillingCoverage(billingContext,{caseId:id,billingItemId:secondBillingId,reviewId:billingReview.id}),(e:any)=>e.code==='CASE_ALREADY_BILLED');
   const lateCost=await db.$transaction(tx=>createCostRecordInTx(tx,{actorId:tag,input:{sourceType:'DevelopmentCase',sourceId:id,costType:'other',amount:'1',currency:'CNY'}}));
   const staleConfirm=await confirmBillingItem({prisma:db,id:billingId,actorId:tag});
   assert.equal(staleConfirm.ok,false);
   if(!staleConfirm.ok) assert.equal(staleConfirm.error.code,'REVIEW_STALE');
   assert.equal((await db.billingItem.findUniqueOrThrow({where:{id:billingId}})).status,'draft');
   await db.costRecord.delete({where:{id:lateCost.id}}); // Only remove the test-created late cost.
   await db.billingItemCostCoverage.delete({where:{id:covered.id}});
   const incomplete=await confirmBillingItem({prisma:db,id:billingId,actorId:tag});
   assert.equal(incomplete.ok,false);
   if(!incomplete.ok) assert.equal(incomplete.error.code,'COVERAGE_CONFLICT');
   await db.billingItemCostCoverage.create({data:covered});

   const handoffContext={prisma:db,actorId:tag,authorize:async(_tx:any,caseId:string,itemId:string)=>{assert.equal(caseId,id);assert.equal(itemId,billingId);},authorizeRecipient:async(_tx:any,caseId:string,userId:string)=>{assert.equal(caseId,id);assert.equal(userId,`${tag}-finance`);}};
   const draftVersion=String((await db.billingItem.findUniqueOrThrow({where:{id:billingId}})).updatedAt);
   await assert.rejects(()=>confirmDevelopmentBillingAndHandoff({...handoffContext,authorizeRecipient:async()=>{}},{caseId:id,billingItemId:billingId,userId:tag,expectedUpdatedAt:draftVersion}),(e:any)=>e.code==='INVALID_RECIPIENT');
   assert.equal((await db.billingItem.findUniqueOrThrow({where:{id:billingId}})).status,'draft');
   const handoffs=await Promise.all([1,2].map(()=>confirmDevelopmentBillingAndHandoff(handoffContext,{caseId:id,billingItemId:billingId,userId:`${tag}-finance`,expectedUpdatedAt:draftVersion})));
   assert.equal((await db.billingItem.findUniqueOrThrow({where:{id:billingId}})).status,'confirmed');
   assert.equal(handoffs[0].assignment.id,handoffs[1].assignment.id);
   assert.equal(handoffs.filter(r=>r.recovered).length,1);
   assert.equal(handoffs[0].assignment.metadata.managedBy,'development_cost_closure');
   assert.equal(handoffs[0].assignment.userId,`${tag}-finance`);
   assert.equal(handoffs[0].assignment.metadata.reviewId,billingReview.id);
   // A changed fee must not silently consume the original handoff, including full waiver.
   const originalWaiver=type==='garment'?80:0;
   await db.billingItem.update({where:{id:billingId},data:{waivedAmount:type==='garment'?0:80}});
   const changedDecision=await invoiceBillingItem({prisma:db,id:billingId,actorId:tag});
   assert.equal(changedDecision.ok,false);
   assert.equal(await db.invoice.count({where:{sourceType:'BillingItem',sourceId:billingId}}),0);
   assert.equal((await db.workAssignment.findUniqueOrThrow({where:{id:handoffs[0].assignment.id}})).status,'assigned');
   assert.equal((await db.billingItem.findUniqueOrThrow({where:{id:billingId}})).status,'confirmed');
   await db.billingItem.update({where:{id:billingId},data:{waivedAmount:originalWaiver}});

   const billingInvoiceInput={invoiceNumber:`${id}-billing-invoice`,sourceType:'BillingItem',sourceId:billingId,type:'Receivable',status:'Draft',amount:1,currency:'USD',issueDate:'2026-09-30'};
   const wrongAmount=await createInvoice({prisma:db,input:billingInvoiceInput,actorId:tag});
   assert.equal(wrongAmount.ok,false);
   if(!wrongAmount.ok) assert.equal(wrongAmount.error.code,'INVALID_AMOUNT');
   const wrongCustomer=await createInvoice({prisma:db,input:{...billingInvoiceInput,amount:80,customerRelationId:'wrong-customer'},actorId:tag});
   assert.equal(wrongCustomer.ok,false);
   if(!wrongCustomer.ok) assert.equal(wrongCustomer.error.code,type==='garment'?'INVALID_AMOUNT':'INVALID_TRANSITION');
   const afterConfirmCost=await db.$transaction(tx=>createCostRecordInTx(tx,{actorId:tag,input:{sourceType:'DevelopmentCase',sourceId:id,costType:'other',amount:'2',currency:'CNY'}}));
   const staleInvoice=await createInvoice({prisma:db,input:{...billingInvoiceInput,amount:80},actorId:tag});
   assert.equal(staleInvoice.ok,false);
   if(!staleInvoice.ok) assert.equal(staleInvoice.error.code,'INVALID_TRANSITION');
   assert.equal(await db.invoice.count({where:{sourceType:'BillingItem',sourceId:billingId}}),0);
   await db.billingItem.update({where:{id:billingId},data:{waivedAmount:80}}); // Independent fixture: zero receivable must also recheck review.
   const staleWaiver=await invoiceBillingItem({prisma:db,id:billingId,actorId:tag});
   assert.equal(staleWaiver.ok,false);
   if(!staleWaiver.ok) assert.equal(staleWaiver.error.code,'REVIEW_STALE');
   assert.equal((await db.billingItem.findUniqueOrThrow({where:{id:billingId}})).status,'confirmed');
   await db.costRecord.delete({where:{id:afterConfirmCost.id}}); // Restore only this isolated fixture's reviewed cost set.
   if(type==='fabric') {
    await db.billingItem.update({where:{id:billingId},data:{waivedAmount:0,costRecordId:covered.costRecordId}});
    let rejectedAudit=0;
    const failingDb=db.$extends({query:{auditLog:{async create({args,query}){if(args.data.action==='complete_development_finance_handoff'){rejectedAudit++;throw new Error('TEST_ONLY_HANDOFF_AUDIT_FAILURE');}return query(args);}}}});
    const interrupted=await invoiceBillingItem({prisma:failingDb as any,id:billingId,actorId:tag});
    assert.equal(interrupted.ok,false);assert.equal(interrupted.error?.code,'BACKFILL_FAILED');assert.equal(rejectedAudit,1);
    assert.equal((await db.billingItem.findUniqueOrThrow({where:{id:billingId}})).status,'confirmed');
    assert.equal((await db.workAssignment.findUniqueOrThrow({where:{id:handoffs[0].assignment.id}})).status,'assigned');
    assert.equal(await db.invoice.count({where:{sourceType:'BillingItem',sourceId:billingId}}),1);
    const issued=await invoiceBillingItem({prisma:db,id:billingId,actorId:tag});
    assert.equal(issued.ok,true,issued.error?.message);
    assert.equal(issued.data?.invoice?.status,'Draft');
    assert.equal(issued.data?.invoice?.amount.toString(),'80');
    assert.equal(issued.data?.invoice?.customerRelationId,tag);
    const retry=await invoiceBillingItem({prisma:db,id:billingId,actorId:tag});
    assert.equal(retry.ok,true);
    assert.equal(retry.data?.invoice?.id,issued.data?.invoice?.id);
    assert.equal(await db.invoice.count({where:{sourceType:'BillingItem',sourceId:billingId}}),1);
    assert.equal((await db.invoiceLine.findFirstOrThrow({where:{invoiceId:issued.data!.invoice.id}})).sourceType,'BillingItem');
    // Simulate invoice committed but billing backfill missing; cancellation must still find its source invoice.
    await db.billingItem.update({where:{id:billingId},data:{status:'confirmed',invoiceId:null}});
    const cancelAfterInvoice=await cancelBillingItem({prisma:db,id:billingId,reason:'不应绕过已有应收',actorId:tag});
    assert.equal(cancelAfterInvoice.ok,false);
    assert.equal(cancelAfterInvoice.error?.code,'ALREADY_INVOICED');
    assert.equal(await db.billingItemCostCoverage.count({where:{billingItemId:billingId,releasedAt:null}}),2);
    const recovered=await invoiceBillingItem({prisma:db,id:billingId,actorId:tag});
    assert.equal(recovered.ok,true);
    assert.equal(recovered.data?.invoice?.id,issued.data?.invoice?.id);
    for(const patch of [{amount:79},{currency:'CNY'},{customerRelationId:'wrong-customer'},{type:'Payable'}]) {
     const changed=await updateInvoice({prisma:db,invoiceId:issued.data!.invoice.id,input:patch,actorId:tag});
     assert.equal(changed.ok,false);
     assert.equal(changed.error?.code,'INVALID_TRANSITION');
    }
    const lateForIssue=await db.$transaction(tx=>createCostRecordInTx(tx,{actorId:tag,input:{sourceType:'DevelopmentCase',sourceId:id,costType:'other',amount:'3',currency:'CNY'}}));
    const staleIssue=await updateInvoice({prisma:db,invoiceId:issued.data!.invoice.id,input:{status:'Issued'},actorId:tag});
    assert.equal(staleIssue.ok,false);
    assert.equal(staleIssue.error?.code,'INVALID_TRANSITION');
    assert.equal((await db.invoice.findUniqueOrThrow({where:{id:issued.data!.invoice.id}})).status,'Draft');
    const notesOnly=await updateInvoice({prisma:db,invoiceId:issued.data!.invoice.id,input:{notes:'等待费用重新核齐'},actorId:tag});
    assert.equal(notesOnly.ok,true,notesOnly.error?.message);
    await db.costRecord.delete({where:{id:lateForIssue.id}});


   } else {
    let rejectedAudit=0;
    const failingDb=db.$extends({query:{auditLog:{async create({args,query}){if(args.data.action==='complete_development_finance_handoff'){rejectedAudit++;throw new Error('TEST_ONLY_HANDOFF_AUDIT_FAILURE');}return query(args);}}}});
    const interrupted=await invoiceBillingItem({prisma:failingDb as any,id:billingId,actorId:tag});
    assert.equal(interrupted.ok,false);assert.equal(interrupted.error?.code,'NO_RECEIVABLE_FAILED');assert.equal(rejectedAudit,1);
    assert.equal((await db.billingItem.findUniqueOrThrow({where:{id:billingId}})).status,'confirmed');
    assert.equal((await db.workAssignment.findUniqueOrThrow({where:{id:handoffs[0].assignment.id}})).status,'assigned');
    assert.equal(await db.invoice.count({where:{sourceType:'BillingItem',sourceId:billingId}}),0);
    const waived=await invoiceBillingItem({prisma:db,id:billingId,actorId:tag});
    assert.equal(waived.ok,true);
    assert.equal(waived.data?.noReceivable,true);
    assert.equal(await db.invoice.count({where:{sourceType:'BillingItem',sourceId:billingId}}),0);
   }
   const completedTask=await db.workAssignment.findUniqueOrThrow({where:{id:handoffs[0].assignment.id}});
   assert.equal(completedTask.status,'completed');assert(completedTask.completedAt);
   assert.equal((completedTask.metadata as any).result.noReceivable,type==='garment');
   results.push({type,explicitClose:true,pauseResume:true,pendingBlocksReview:true,concurrentCloseAndReviewOnce:true,newCostInvalidatesReview:true,newZeroCostSourceInvalidatesReview:true,oldReviewPreserved:true,productionSampleExcluded:true,unresolvedOwnershipBlocksReview:true,wholeCaseCoverageConcurrentOnce:true,duplicateCaseBillingRejected:true});
  }
 } finally {
  await db.businessSequence.deleteMany({where:{id:numberTestSequence}});
  await db.$transaction(async tx=>{
   const billingRows=await tx.billingItem.findMany({where:{sourceType:'DevelopmentCase',sourceId:{startsWith:tag}},select:{id:true}});
   const invoices=await tx.invoice.findMany({where:{sourceType:'BillingItem',sourceId:{in:billingRows.map(r=>r.id)}},select:{id:true}});
   const invoiceIds=invoices.map(i=>i.id);
   await tx.entityReference.deleteMany({where:{ownerId:{in:invoiceIds}}});
   await tx.entityLink.deleteMany({where:{fromId:{in:invoiceIds}}});
   await tx.invoiceLine.deleteMany({where:{invoiceId:{in:invoiceIds}}});
   await tx.invoice.deleteMany({where:{id:{in:invoiceIds}}});
   await tx.billingItemCostCoverage.deleteMany({where:{billingItem:{sourceType:'DevelopmentCase',sourceId:{startsWith:tag}}}});
   await tx.developmentBillingWorkflowEvent.deleteMany({where:{billingItemId:{in:billingRows.map(r=>r.id)}}});
   await tx.billingItem.deleteMany({where:{sourceType:'DevelopmentCase',sourceId:{startsWith:tag}}});
   await tx.developmentExpenseReview.deleteMany({where:{developmentCaseId:{startsWith:tag}}});
   await tx.developmentLifecycleEvent.deleteMany({where:{developmentCaseId:{startsWith:tag}}});
   await tx.developmentPendingExpense.deleteMany({where:{developmentCaseId:{startsWith:tag}}});
   await tx.costRecord.deleteMany({where:{sourceId:{startsWith:tag}}});
   await tx.auditLog.deleteMany({where:{actorId:{in:[tag,`${tag}-finance`]}}});
   await tx.sample.deleteMany({where:{sourceCaseId:{startsWith:tag}}});
   await tx.developmentCase.deleteMany({where:{id:{startsWith:tag}}});
   await tx.relation.deleteMany({where:{id:tag}});
   await tx.workAssignment.deleteMany({where:{assignerId:{in:[tag,`${tag}-finance`]}}});
   await tx.userAccount.deleteMany({where:{id:{in:[tag,`${tag}-finance`]}}});
  });
 }
 assert.equal(await db.developmentCase.count({where:{id:{startsWith:tag}}}),0);
 assert.equal(await db.developmentExpenseReview.count({where:{developmentCaseId:{startsWith:tag}}}),0);
 console.log(JSON.stringify({result:'PASS',database:identity.name,results,fixturesRemoved:true,permissionProof:false,operationalGuardsProof:'case stage/deletion; sample create/edit/stage/fork; late logistics persisted; production continuation; cost-backed deletion rejected'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>db.$disconnect());
