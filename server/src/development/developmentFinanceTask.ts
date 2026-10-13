import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { ciHash, ciJson, ciConflict } from './developmentCiSource';
export const developmentFinanceTaskId=(billingItemId:string)=>`development-finance-${createHash('sha256').update(billingItemId).digest('hex')}`;
/** Caller holds the case and billing locks. Compare the decision, not just its record ID. */
export async function assertDevelopmentFinanceTaskCurrentInTx(tx:any,billing:any){
 if(!billing.developmentExpenseReviewId)return null;
 const id=developmentFinanceTaskId(billing.id);
 await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "WorkAssignment" WHERE "id"=${id} FOR UPDATE`);
 const task=await tx.workAssignment.findUnique({where:{id}});
 if(!task)return null; // Existing historical decisions may predate managed tasks.
 const meta=task.metadata;
 let matches=false;
 try {
  matches=!!meta&&!task.deletedAt&&['assigned','completed'].includes(task.status)
   &&meta.managedBy==='development_cost_closure'&&meta.caseId===billing.sourceId
   &&meta.billingItemId===billing.id&&meta.reviewId===billing.developmentExpenseReviewId
   &&meta.currency===billing.currency&&meta.bearerRelationId===billing.bearerRelationId
   &&['amount','waivedAmount','offsetAmount'].every(key=>meta[key]!=null&&new Prisma.Decimal(meta[key]).eq(billing[key]));
 } catch { matches=false; }
 if(!matches)throw Object.assign(new Error('收费金额、减免或客户与财务交接依据不一致，请核对原交接记录'),{code:'HANDOFF_CONFLICT',statusCode:409});
 return task;
}
/** Caller holds case and billing locks; complete only after the billing result is saved in this transaction. */
export async function completeDevelopmentFinanceTaskInTx(tx:any,billing:any,actorId:string){
 if(!billing.developmentExpenseReviewId)return;
 const id=developmentFinanceTaskId(billing.id);
 const task=await assertDevelopmentFinanceTaskCurrentInTx(tx,billing);
 if(!task)return; // Historical decisions can predate managed assignments.
 const meta=task.metadata;
 if(task.deletedAt||meta?.managedBy!=='development_cost_closure'||meta.billingItemId!==billing.id||meta.reviewId!==billing.developmentExpenseReviewId||billing.status!=='invoiced')throw Object.assign(new Error('财务接手任务与收费结果不一致'),{code:'HANDOFF_CONFLICT',statusCode:409});
 if(task.status==='completed'){
  if(meta.result?.invoiceId!==(billing.invoiceId??null)||meta.result?.noReceivable!==!billing.invoiceId)throw Object.assign(new Error('已完成财务任务的应收结果不一致'),{code:'HANDOFF_CONFLICT',statusCode:409});
  return;
 }
 const net=new Prisma.Decimal(billing.amount).minus(billing.waivedAmount).minus(billing.offsetAmount);
 if(!billing.invoiceId&&!net.eq(0))throw Object.assign(new Error('尚无应收结果，不能完成财务接手'),{code:'HANDOFF_CONFLICT',statusCode:409});
 await tx.workAssignment.update({where:{id},data:{status:'completed',completedAt:new Date(),metadata:{...meta,result:{invoiceId:billing.invoiceId??null,noReceivable:!billing.invoiceId,completedBy:actorId}}}});
 await writeRouteAuditLog({prisma:tx,actorId,source:'development:finance-handoff',operation:'complete_development_finance_handoff',targetType:'WorkAssignment',targetId:id,after:{billingItemId:billing.id,invoiceId:billing.invoiceId??null,noReceivable:!billing.invoiceId}});
}

/** Cancellation preserves the assignment and reason; it is not a completed receivable. */
export async function cancelDevelopmentFinanceTaskInTx(tx:any,billing:any,actorId:string,reason:string){
 if(!billing.developmentExpenseReviewId)return;
 const id=developmentFinanceTaskId(billing.id);
 await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "WorkAssignment" WHERE "id"=${id} FOR UPDATE`);
 const task=await tx.workAssignment.findUnique({where:{id}});
 if(!task)return;
 if(task.deletedAt||task.metadata?.managedBy!=='development_cost_closure'||task.metadata?.billingItemId!==billing.id||billing.status!=='cancelled'||task.status==='completed')throw Object.assign(new Error('财务任务状态与取消收费不一致'),{code:'HANDOFF_CONFLICT',statusCode:409});
 if(task.status==='cancelled')return;
 await tx.workAssignment.update({where:{id},data:{status:'cancelled',metadata:{...task.metadata,cancellation:{reason,cancelledBy:actorId,cancelledAt:new Date().toISOString()}}}});
 await writeRouteAuditLog({prisma:tx,actorId,source:'development:finance-handoff',operation:'cancel_development_finance_handoff',targetType:'WorkAssignment',targetId:id,after:{billingItemId:billing.id,reason}});
}

/** Business issuance replaces obsolete finance-production work, never an approval or financial fact. */
export async function supersedeDevelopmentFinanceTasksByCiInTx(tx: any, input: { caseId: string; billingItemId: string;
 documentId: string; versionId: string; requestKey: string; actorId: string; issuedAt: bigint }) {
 const where = { deletedAt: null, status: { notIn: ['completed', 'cancelled'] }, AND: [
  { metadata: { path: ['managedBy'], equals: 'development_cost_closure' } },
  { metadata: { path: ['caseId'], equals: input.caseId } }, { metadata: { path: ['billingItemId'], equals: input.billingItemId } },
  { OR: ['finance_handoff', 'billing_supplement', 'finance_review'].map(kind => ({ metadata: { path: ['kind'], equals: kind } })) },
 ] };
 const hinted = await tx.workAssignment.findMany({ where, orderBy: { id: 'asc' } });
 for (const task of hinted) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "WorkAssignment" WHERE "id"=${task.id} FOR UPDATE`);
 const tasks = await tx.workAssignment.findMany({ where, orderBy: { id: 'asc' } });
 for (const task of tasks) {
  const meta = task.metadata, auditId = `devcits_${ciHash([input.documentId, input.versionId, task.id])}`;
  if (meta?.caseId !== input.caseId || meta.billingItemId !== input.billingItemId || meta.managedBy !== 'development_cost_closure')
   ciConflict('原费用待办归属已变化，签发未完成。');
  const supersession = { outcome: 'superseded_by_business_ci', caseId: input.caseId, billingItemId: input.billingItemId,
   documentId: input.documentId, versionId: input.versionId, requestKey: input.requestKey,
   actorId: input.actorId, issuedAt: input.issuedAt.toString(), auditId };
  await tx.workAssignment.update({ where: { id: task.id }, data: { status: 'cancelled', metadata: ciJson({ ...meta,
   result: { ...(meta.result ?? {}), ...supersession }, supersession }) } });
  await tx.auditLog.create({ data: { id: auditId, actorId: input.actorId, action: 'supersede_development_finance_task_by_ci',
   targetType: 'WorkAssignment', targetId: task.id, transactionId: input.requestKey,
   detail: ciJson({ before: task, after: { status: 'cancelled', supersession }, source: 'development:business-ci' }) } });
 }
 return { supersededTaskIds: tasks.map((task: any) => task.id) };
}
