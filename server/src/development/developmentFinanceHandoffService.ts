import { confirmBillingItemInTx } from '../finance/billingItemService';
import { developmentFinanceTaskId } from './developmentFinanceTask';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { assertDevelopmentBillingCoverageCurrentInTx } from './developmentBillingCoverageService';
export type DevelopmentFinanceHandoffContext = {prisma:any;actorId:string;authorize:(tx:any,caseId:string,billingItemId:string)=>Promise<unknown>;authorizeRecipient:(tx:any,caseId:string,userId:string)=>Promise<unknown>};
function reject(code:string,message:string):never{throw Object.assign(new Error(message),{code,status:409,httpStatus:409,statusCode:409});}
/** The caller must authorize finance duties and source visibility; never select a recipient from a role label alone. */
export async function createDevelopmentFinanceHandoffInTx(tx:any,context:DevelopmentFinanceHandoffContext,input:{caseId:string;billingItemId:string;userId:string}){
 const {caseId,billingItemId,userId}=input;
 if(![context.actorId,caseId,billingItemId,userId].every(v=>typeof v==='string'&&v.trim()))reject('INVALID_INPUT','缺少开发案、收费事项或财务负责人');
 await context.authorize(tx,caseId,billingItemId);
 const locked=await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
 if(!locked.length)reject('NOT_FOUND','开发案不存在');
 await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${billingItemId} FOR UPDATE`);
 await context.authorize(tx,caseId,billingItemId);
 await context.authorizeRecipient(tx,caseId,userId);
 const user=await tx.userAccount.findFirst({where:{id:userId,deletedAt:null,status:'active'},select:{id:true}});
 if(!user)reject('INVALID_RECIPIENT','财务负责人不是有效账号');
 const billing=await tx.billingItem.findFirst({where:{id:billingItemId,sourceType:'DevelopmentCase',sourceId:caseId,deletedAt:null}});
 if(!billing||billing.status!=='confirmed')reject('BILLING_NOT_CONFIRMED','先确认本案收费决定，再交给财务接手');
 await assertDevelopmentBillingCoverageCurrentInTx(tx,billing);
 const snapshot={caseId,billingItemId,reviewId:billing.developmentExpenseReviewId,amount:billing.amount.toString(),waivedAmount:billing.waivedAmount.toString(),offsetAmount:billing.offsetAmount.toString(),currency:billing.currency,bearerRelationId:billing.bearerRelationId};
 const fingerprint=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
 const id=developmentFinanceTaskId(billingItemId);
 const previous=await tx.workAssignment.findUnique({where:{id}});
 if(previous){
  if(previous.deletedAt||previous.userId!==userId||previous.metadata?.fingerprint!==fingerprint)reject('HANDOFF_CONFLICT','已有财务接手安排，请从原交接记录处理变更');
  return {assignment:previous,recovered:true};
 }
 const assignment=await tx.workAssignment.create({data:{id,title:`开发费用财务接手 · ${billing.itemNo}`,description:'核对整案收费与减免依据，生成应收草稿或确认无应收；本任务不代表已收款。',userId,assignerId:context.actorId,status:'assigned',priority:'normal',metadata:{managedBy:'development_cost_closure',kind:'finance_handoff',fingerprint,...snapshot}}});
 await writeRouteAuditLog({prisma:tx,actorId:context.actorId,source:'development:finance-handoff',operation:'assign_development_finance_handoff',targetType:'WorkAssignment',targetId:id,after:{...snapshot,userId}});
 return {assignment,recovered:false};
}
export async function createDevelopmentFinanceHandoff(context:DevelopmentFinanceHandoffContext,input:{caseId:string;billingItemId:string;userId:string}){
 return context.prisma.$transaction((tx:any)=>createDevelopmentFinanceHandoffInTx(tx,context,input));
}

/** Confirmation and assignment commit together. Expected timestamp protects the reviewed draft. */
export async function confirmDevelopmentBillingAndHandoff(context:DevelopmentFinanceHandoffContext,input:{caseId:string;billingItemId:string;userId:string;expectedUpdatedAt:string}) {
 return context.prisma.$transaction(async(tx:any)=>{
  await context.authorize(tx,input.caseId,input.billingItemId);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${input.caseId} AND "deletedAt" IS NULL FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${input.billingItemId} FOR UPDATE`);
  const row=await tx.billingItem.findFirst({where:{id:input.billingItemId,sourceType:'DevelopmentCase',sourceId:input.caseId,deletedAt:null}});
  if(!row||!row.developmentExpenseReviewId)reject('INVALID_BILLING_SOURCE','收费事项不属于本案或缺少核齐依据');
  await context.authorize(tx,input.caseId,input.billingItemId);
  await context.authorizeRecipient(tx,input.caseId,input.userId);
  if(row.status==='draft') {
   if(typeof input.expectedUpdatedAt!=='string'||String(row.updatedAt)!==input.expectedUpdatedAt)reject('BILLING_CHANGED','收费草稿已变化，请重新核对');
   await confirmBillingItemInTx(tx,{row,actorId:context.actorId});
  } else if(row.status!=='confirmed') reject('BILLING_CHANGED','当前收费状态不能确认派发');
  const handoff=await createDevelopmentFinanceHandoffInTx(tx,context,input);
  return {billingItem:await tx.billingItem.findUnique({where:{id:input.billingItemId}}),...handoff};
 });
}
