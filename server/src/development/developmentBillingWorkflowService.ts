import {createHash,randomUUID} from 'node:crypto';
import {Prisma} from '@prisma/client';
import {canonicalClaimJson} from '../claims/claimApprovalFact';
import {bindDevelopmentBillingCoverageInTx,assertDevelopmentBillingCoverageCurrentInTx} from './developmentBillingCoverageService';
import {confirmBillingItemInTx} from '../finance/billingItemService';
import {createDevelopmentFinanceHandoffInTx} from './developmentFinanceHandoffService';
import {developmentFinanceTaskId} from './developmentFinanceTask';
import {parseNonNegativeDecimal} from '../shared/moneyInput';
import {writeRouteAuditLog} from '../audit/routeAudit';
import {assertDevelopmentExpenseReviewCurrentInTx} from './developmentClosureService';
import {assertDevelopmentBillingNotClaimedInTx,lockDevelopmentCiDocumentsInTx} from './developmentCommercialBillingService';

type Context={prisma:any;actorId:string;authorizeBusiness:(tx:any,caseId:string)=>Promise<unknown>;authorizeFinance:(tx:any,caseId:string)=>Promise<unknown>;authorizeRecipient:(tx:any,caseId:string,userId:string)=>Promise<unknown>;approvalCreateService?:{createBusinessApproval:(input:any)=>Promise<any>}};
type Input={action:'edit'|'submit'|'return'|'cancel'|'verify';requestKey:string;expectedVersion:number;note:string;reviewId?:string;userId?:string;requiredItems?:string[];amount?:unknown;waivedAmount?:unknown;currency?:string};
function fail(code:string,message:string,status=409):never{throw Object.assign(new Error(message),{code,status,httpStatus:status,statusCode:status});}
function text(v:unknown,label:string,max=4000){if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail('INVALID_INPUT',`${label}无效`,400);return v.trim();}
function money(v:unknown,label:string){const value=parseNonNegativeDecimal(v,label);if(!value.ok)fail('INVALID_AMOUNT',value.message,400);const d=new Prisma.Decimal(value.value);if(d.decimalPlaces()>4||d.gte('100000000000000'))fail('INVALID_AMOUNT',`${label}精度或范围无效`,400);return d.toString();}
const safe=(v:any)=>JSON.parse(JSON.stringify(v,(_k,value)=>typeof value==='bigint'?String(value):value));
export const snapshotDevelopmentBillingItem=(r:any)=>safe({state:r.developmentWorkflowState,version:r.developmentWorkflowVersion,reviewId:r.developmentExpenseReviewId,amount:r.amount.toString(),waivedAmount:r.waivedAmount.toString(),offsetAmount:r.offsetAmount.toString(),currency:r.currency,customerId:r.bearerRelationId,note:r.notes,assigneeId:r.developmentAssigneeId,submittedBy:r.developmentSubmittedBy});
const snapshot=snapshotDevelopmentBillingItem;
const needsLeadershipApproval=(row:any)=>new Prisma.Decimal(row.amount).isZero()||!new Prisma.Decimal(row.waivedAmount).isZero();
export const developmentBillingReviewTaskId=(id:string,version:number)=>`development-review-${createHash('sha256').update(`${id}:${version}`).digest('hex')}`;

/** Submit/return/edit never confirm a fee. Finance verification consumes the live submission. */
export async function transitionDevelopmentBilling(context:Context,caseId:string,billingId:string,input:Input){
 text(context.actorId,'操作人',200);text(caseId,'开发案',200);text(billingId,'收费事项',200);
 if(!['edit','submit','return','cancel','verify'].includes(input.action)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)fail('INVALID_INPUT','操作或版本无效',400);
 const command:any={action:input.action,expectedVersion:input.expectedVersion,note:text(input.note,'处理依据'),requestKey:text(input.requestKey,'请求标识',200)};
 if(input.action==='submit'){command.reviewId=text(input.reviewId,'费用核齐依据',200);command.userId=text(input.userId,'财务接收人',200);}
 if(input.action==='return'){
  if(!Array.isArray(input.requiredItems)||!input.requiredItems.length||input.requiredItems.length>30)fail('INVALID_INPUT','请列明待补资料',400);
  command.requiredItems=input.requiredItems.map(item=>text(item,'待补资料',500));
 }
 if(input.action==='edit'){
  command.amount=money(input.amount,'拟收金额');command.waivedAmount=money(input.waivedAmount,'减免金额');command.currency=input.currency;
  if(new Prisma.Decimal(command.waivedAmount).gt(command.amount)||!['CNY','USD'].includes(command.currency))fail('INVALID_INPUT','减免或币种无效',400);
 }
 const fingerprint=createHash('sha256').update(JSON.stringify(command)).digest('hex');
 const authorize=['return','verify'].includes(input.action)?context.authorizeFinance:context.authorizeBusiness;
 return context.prisma.$transaction(async(tx:any)=>{
  await authorize(tx,caseId);
  const cases=await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
  if(!cases.length)fail('NOT_FOUND','开发案不存在',404);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${billingId} FOR UPDATE`);
  await authorize(tx,caseId);
  const row=await tx.billingItem.findFirst({where:{id:billingId,sourceType:'DevelopmentCase',sourceId:caseId,deletedAt:null}});
  if(!row)fail('NOT_FOUND','收费事项不存在',404);
  const previous=await tx.developmentBillingWorkflowEvent.findUnique({where:{billingItemId_requestKey:{billingItemId:billingId,requestKey:command.requestKey}}});
  if(previous){
   if(previous.fingerprint!==fingerprint||previous.actorId!==context.actorId)fail('REQUEST_CONFLICT','原请求与本次操作不一致');
   if(previous.action==='verify'){
    const assignment=await tx.workAssignment.findUnique({where:{id:developmentFinanceTaskId(billingId)}});
    if(!assignment||assignment.deletedAt||assignment.userId!==context.actorId||assignment.metadata?.managedBy!=='development_cost_closure'||assignment.metadata?.kind!=='finance_handoff'||assignment.metadata?.caseId!==caseId||assignment.metadata?.billingItemId!==billingId)fail('HANDOFF_CONFLICT','原财务制单任务不可核实，请核对交接记录');
    return {event:previous,billingItem:row,assignment,recovered:true};
   }
   return {event:previous,billingItem:row,recovered:true};
  }
  if(row.status!=='draft'||row.developmentWorkflowVersion!==input.expectedVersion)fail('BILLING_CHANGED','收费状态或版本已变化，请刷新');
  const version=row.developmentWorkflowVersion+1,now=BigInt(Date.now()),before=snapshot(row);
  let data:any={developmentWorkflowVersion:version,updatedAt:now};
  let taskId:string|null=null;
  let approvalId:string|null=null;
  let approvalNotification:any=null;
  let assignment:any;
  if(input.action==='submit'){
   if(!['draft','returned'].includes(row.developmentWorkflowState))fail('INVALID_TRANSITION','当前不能提交核对');
   await context.authorizeRecipient(tx,caseId,command.userId);
   if(!new Prisma.Decimal(row.offsetAmount).isZero())fail('UNSUPPORTED_OFFSET','开发费抵扣承担方尚未核准，不能提交抵扣方案');
   if(row.bearerType!=='customer'||!row.bearerRelationId||!row.bearerName)fail('UNSUPPORTED_BEARER','当前仅支持已关联客户的对客收费方案');
   const review=await assertDevelopmentExpenseReviewCurrentInTx(tx,caseId,command.reviewId);
   if(row.developmentExpenseReviewId&&row.developmentExpenseReviewId!==command.reviewId){
    let oldReviewIsCurrent=true;
    try{await assertDevelopmentExpenseReviewCurrentInTx(tx,caseId,row.developmentExpenseReviewId);}
    catch(error:any){if(error?.code==='REVIEW_STALE'||error?.code==='REVIEW_REQUIRED')oldReviewIsCurrent=false;else throw error;}
    if(oldReviewIsCurrent)fail('REVIEW_CONFLICT','收费事项已绑定另一份仍有效的费用核齐依据');
    const oldCoverage=await tx.billingItemCostCoverage.findMany({where:{billingItemId:billingId,releasedAt:null}});
    if(oldCoverage.length)await tx.billingItemCostCoverage.updateMany({where:{billingItemId:billingId,releasedAt:null},data:{releasedAt:now,releaseReason:'原费用核齐依据已失效，改用本次重新核齐版本'}});
    await tx.billingItem.update({where:{id:billingId},data:{developmentExpenseReviewId:null,updatedAt:now}});
   }
   if(needsLeadershipApproval(row)){
    if(!context.approvalCreateService)fail('APPROVAL_UNAVAILABLE','领导审批服务暂不可用，未提交收费方案',503);
    const payloadBase={schemaVersion:1,kind:'development_fee',caseId,billingItemId:billingId,itemNo:row.itemNo,
     expenseReviewId:review.id,expenseReviewFingerprint:review.fingerprint,workflowVersion:version,
     amount:row.amount.toString(),waivedAmount:row.waivedAmount.toString(),currency:row.currency,
     bearerType:'customer',bearerRelationId:row.bearerRelationId,bearerName:row.bearerName,
     financeUserId:command.userId,reason:command.note};
    const contentFingerprint=createHash('sha256').update(canonicalClaimJson(payloadBase)).digest('hex');
    const approval=await context.approvalCreateService.createBusinessApproval({client:tx,requesterId:context.actorId,
     targetType:'BillingItem',targetId:billingId,actionType:'development:fee',risk:'high',payload:{...payloadBase,contentFingerprint}});
    if(!approval?.id||approval.status!=='pending')fail('APPROVAL_CREATE_FAILED','领导审批未能创建，收费事项保持原状态',409);
    data={...data,developmentWorkflowState:'approval_pending',developmentApprovalId:approval.id,developmentExpenseReviewId:review.id,
     developmentSubmittedBy:context.actorId,developmentSubmittedAt:now,developmentAssigneeId:context.actorId};
    approvalId=approval.id;
    if(approval.reviewerId){
     await tx.notification.createMany({data:[{id:`ntf_dev_fee_approval_${approval.id}`,userId:approval.reviewerId,
      type:'development_fee_approval_requested',title:'开发收费待领导审批',
      body:`${row.itemNo} 的客户收费方案包含减免或免收，等待审核并最终确定。`,level:'warning',
      link:`/development?id=${encodeURIComponent(caseId)}&tab=fees`,
      metadata:{caseId,billingItemId:billingId,approvalId:approval.id}}],skipDuplicates:true});
     approvalNotification={id:`ntf_dev_fee_approval_${approval.id}`,userId:approval.reviewerId};
    }
   }else{
    // A prior draft may have held its current expense coverage at version 0.
    // Release that round while retaining its immutable row before reserving this submission.
    const activeCoverage=await tx.billingItemCostCoverage.findMany({where:{billingItemId:billingId,releasedAt:null}});
    if(activeCoverage.length)await tx.billingItemCostCoverage.updateMany({where:{billingItemId:billingId,releasedAt:null},data:{releasedAt:now,releaseReason:`替换为第 ${version} 轮费用核对覆盖`}});
    await bindDevelopmentBillingCoverageInTx(tx,{...context,authorize:(inner:any,id:string)=>context.authorizeBusiness(inner,id)},{caseId,billingItemId:billingId,reviewId:command.reviewId,submissionVersion:version});
    data={...data,developmentWorkflowState:'submitted',developmentSubmittedBy:context.actorId,developmentSubmittedAt:now,developmentAssigneeId:command.userId};
    taskId=developmentBillingReviewTaskId(billingId,version);
    await tx.workAssignment.create({data:{id:taskId,title:`核对开发收费 · ${row.itemNo}`,description:command.note,userId:command.userId,assignerId:context.actorId,status:'assigned',metadata:{managedBy:'development_cost_closure',kind:'finance_review',caseId,billingItemId:billingId,version,reviewId:command.reviewId,decision:{...before,state:'submitted',version,reviewId:command.reviewId,assigneeId:command.userId,submittedBy:context.actorId}}}});
   }
   // A returned supplement task is closed by a successful resubmission, whether
   // the final customer fee now needs leadership approval or goes to finance.
   const supplements=await tx.workAssignment.findMany({where:{deletedAt:null,status:'assigned',AND:[{metadata:{path:['managedBy'],equals:'development_cost_closure'}},{metadata:{path:['kind'],equals:'billing_supplement'}},{metadata:{path:['billingItemId'],equals:billingId}}]}});
   for(const supplement of supplements)await tx.workAssignment.update({where:{id:supplement.id},data:{status:'completed',completedAt:new Date(),metadata:{...supplement.metadata,result:{outcome:'resubmitted',version}}}});
  }else if(input.action==='verify'){
   if(row.developmentWorkflowState!=='submitted'||row.developmentAssigneeId!==context.actorId)fail('FORBIDDEN','仅当前财务处理人可核对本轮收费事项',403);
   taskId=developmentBillingReviewTaskId(billingId,row.developmentWorkflowVersion);
   const task=await tx.workAssignment.findUnique({where:{id:taskId}});
   const meta=task?.metadata;
   if(!task||task.deletedAt||task.status!=='assigned'||task.userId!==context.actorId||meta?.managedBy!=='development_cost_closure'||meta.kind!=='finance_review'||meta.caseId!==caseId||meta.billingItemId!==billingId||meta.version!==row.developmentWorkflowVersion||meta.reviewId!==row.developmentExpenseReviewId||!meta.decision||Object.entries(before).some(([key,value])=>JSON.stringify(meta.decision[key])!==JSON.stringify(value)))fail('TASK_CHANGED','核对任务或本轮提交依据已变化，请刷新');
   const coverage=await tx.billingItemCostCoverage.findMany({where:{billingItemId:billingId,releasedAt:null},orderBy:{costRecordId:'asc'}});
   for(const cost of coverage)await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${cost.costRecordId} FOR UPDATE`);
   if(coverage.some((cost:any)=>cost.submissionVersion!==row.developmentWorkflowVersion))fail('COVERAGE_CONFLICT','费用覆盖不属于本轮提交，请重新核对');
   await assertDevelopmentBillingCoverageCurrentInTx(tx,row);
   // Finance verifies the customer's final proposal but never creates leadership authority.
   if(!new Prisma.Decimal(row.offsetAmount).isZero())fail('INVALID_STATE','开发费抵扣承担方尚未核准，不能确认抵扣');
   if(needsLeadershipApproval(row)){
    const approval=row.developmentApprovalId?await tx.approvalRequest.findUnique({where:{id:row.developmentApprovalId}}):null;
    const decisionAudits=approval?await tx.auditLog.findMany({where:{targetType:'ApprovalRequest',targetId:approval.id}}):[];
    const payload=approval?.payload??{};
    const facts=decisionAudits.filter((audit:any)=>{const fact=audit.detail?.approvalDecisionFact;return audit.action==='approve_business_request'&&audit.actorId===(approval?.bossFinalBypassBy??approval?.reviewerId)&&fact?.schemaVersion===1&&fact.status==='approved'&&fact.actionType==='development:fee'&&fact.targetType==='BillingItem'&&fact.targetId===billingId&&fact.decisionActorId===audit.actorId&&fact.decidedAt===approval?.decidedAt?.toISOString()&&fact.contentFingerprint===payload.contentFingerprint;});
    const finalInput=facts[0]?.detail?.approvalDecisionFact?.modifiedInput??{amount:payload.amount,waivedAmount:payload.waivedAmount};
    if(!approval||approval.status!=='approved'||approval.actionType!=='development:fee'||approval.targetType!=='BillingItem'||approval.targetId!==billingId
      ||payload.caseId!==caseId||payload.expenseReviewId!==row.developmentExpenseReviewId||!new Prisma.Decimal(finalInput.amount).eq(row.amount)
      ||!new Prisma.Decimal(finalInput.waivedAmount).eq(row.waivedAmount)||facts.length!==1)
      fail('INVALID_STATE','零收费或减免缺少与当前最终金额一致的有效领导批准');
   }else if(new Prisma.Decimal(row.amount).lte(0))fail('INVALID_STATE','收费金额须大于零');
   await authorize(tx,caseId);
   const ready=await tx.billingItem.update({where:{id:billingId},data:{...data,developmentWorkflowState:'ready'}});
   await confirmBillingItemInTx(tx,{row:ready,actorId:context.actorId});
   const handoff=await createDevelopmentFinanceHandoffInTx(tx,{...context,authorize:(inner:any,id:string)=>context.authorizeFinance(inner,id)}, {caseId,billingItemId:billingId,userId:context.actorId});
   assignment=handoff.assignment;
   await tx.workAssignment.update({where:{id:taskId},data:{status:'completed',completedAt:new Date(),metadata:{...meta,result:{outcome:'verified',note:command.note,actorId:context.actorId,version,financeTaskId:assignment.id}}}});
   data={...data,developmentWorkflowState:'ready'};
   approvalId=row.developmentApprovalId??null;
  }else if(input.action==='return'){
   if(row.developmentWorkflowState!=='submitted'||row.developmentAssigneeId!==context.actorId)fail('FORBIDDEN','仅当前财务处理人可退回待核对事项',403);
   if(!row.developmentSubmittedBy)fail('TASK_CHANGED','原提交人缺失，请核实交接记录');
   const reviewTaskId=developmentBillingReviewTaskId(billingId,row.developmentWorkflowVersion);
   const task=await tx.workAssignment.findUnique({where:{id:reviewTaskId}});
   if(!task||task.deletedAt||task.status!=='assigned'||task.userId!==context.actorId)fail('TASK_CHANGED','核对任务已变化');
   const coverage=await tx.billingItemCostCoverage.findMany({where:{billingItemId:billingId,releasedAt:null},orderBy:{costRecordId:'asc'}});
   for(const cost of coverage)await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${cost.costRecordId} FOR UPDATE`);
   await tx.billingItemCostCoverage.updateMany({where:{billingItemId:billingId,releasedAt:null},data:{releasedAt:now,releaseReason:command.note}});
   await tx.workAssignment.update({where:{id:reviewTaskId},data:{status:'completed',completedAt:new Date(),metadata:{...task.metadata,result:{outcome:'returned',reason:command.note,requiredItems:command.requiredItems,actorId:context.actorId}}}});
   data={...data,developmentWorkflowState:'returned',developmentAssigneeId:row.developmentSubmittedBy};
   taskId=`${developmentBillingReviewTaskId(billingId,version)}-supplement`;
   await tx.workAssignment.create({data:{id:taskId,title:`补充开发收费资料 · ${row.itemNo}`,description:command.requiredItems.join('\n'),userId:row.developmentSubmittedBy,assignerId:context.actorId,status:'assigned',metadata:{managedBy:'development_cost_closure',kind:'billing_supplement',caseId,billingItemId:billingId,version,reason:command.note,requiredItems:command.requiredItems}}});
  }else if(input.action==='cancel'){
   if(!['draft','returned','business_ci_draft'].includes(row.developmentWorkflowState))fail('INVALID_TRANSITION','财务核对中的方案须先退回，不能直接取消');
   if(row.invoiceId)fail('BILLING_CHANGED','仍有应收记录，不能直接取消');
   await assertDevelopmentBillingNotClaimedInTx(tx,caseId,[billingId]);
   const activeCoverage=await tx.billingItemCostCoverage.findMany({where:{billingItemId:billingId,releasedAt:null}});
   for(const id of activeCoverage.map((coverage:any)=>coverage.costRecordId).sort())await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${id} FOR UPDATE`);
   await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCiBillingClaim" WHERE "billingItemId"=${billingId} ORDER BY "id" FOR UPDATE`);
   await lockDevelopmentCiDocumentsInTx(tx,caseId);
   await assertDevelopmentBillingNotClaimedInTx(tx,caseId,[billingId]);
   if(activeCoverage.length)await tx.billingItemCostCoverage.updateMany({where:{billingItemId:billingId,releasedAt:null},data:{releasedAt:now,releaseReason:command.note}});
   const supplements=await tx.workAssignment.findMany({where:{deletedAt:null,status:'assigned',AND:[{metadata:{path:['managedBy'],equals:'development_cost_closure'}},{metadata:{path:['kind'],equals:'billing_supplement'}},{metadata:{path:['billingItemId'],equals:billingId}}]}});
   for(const task of supplements)await tx.workAssignment.update({where:{id:task.id},data:{status:'cancelled',metadata:{...task.metadata,result:{outcome:'cancelled',reason:command.note,version}}}});
   data={...data,status:'cancelled',developmentWorkflowState:'cancelled',developmentAssigneeId:null};
  }else{
   if(!['draft','returned','business_ci_draft'].includes(row.developmentWorkflowState))fail('INVALID_TRANSITION','提交后的方案不能直接覆盖，请先退回处理');
   // Charge edits do not rewrite or erase actual CostRecord/ExpenseReview facts.
   // A later submit binds a still-current review or explicitly replaces only a stale one.
   if(new Prisma.Decimal(command.amount).minus(command.waivedAmount).minus(row.offsetAmount).lt(0))fail('INVALID_AMOUNT','收费不足以抵减免和抵扣',400);
   data={...data,amount:new Prisma.Decimal(command.amount),waivedAmount:new Prisma.Decimal(command.waivedAmount),currency:command.currency,notes:command.note,
    ...((!new Prisma.Decimal(command.amount).eq(row.amount)||!new Prisma.Decimal(command.waivedAmount).eq(row.waivedAmount)||command.currency!==row.currency)
      &&(row.developmentApprovalId||needsLeadershipApproval({amount:command.amount,waivedAmount:command.waivedAmount}))?{developmentWorkflowState:'draft'}:{})};
  }
  const saved=input.action==='verify'?await tx.billingItem.findFirst({where:{id:billingId,deletedAt:null}}):await tx.billingItem.update({where:{id:billingId},data});
  const event=await tx.developmentBillingWorkflowEvent.create({data:{id:randomUUID(),billingItemId:billingId,requestKey:command.requestKey,fingerprint,action:command.action,version,actorId:context.actorId,createdAt:now,snapshot:{before,after:{...snapshot(saved),...(input.action==='verify'?{status:saved.status,confirmedBy:saved.confirmedBy}: {})},note:command.note,requiredItems:command.requiredItems??[],taskId,...(approvalId?{approvalId}:{}),...(assignment?{financeTaskId:assignment.id}:{})}}});
  await writeRouteAuditLog({prisma:tx,actorId:context.actorId,source:'development:billing-workflow',operation:`development_billing_${command.action}`,targetType:'BillingItem',targetId:billingId,after:{eventId:event.id,version,taskId}});
  return {event,billingItem:saved,...(assignment?{assignment}:{}),...(approvalNotification?{approvalNotification}:{}),recovered:false};
 });
}
