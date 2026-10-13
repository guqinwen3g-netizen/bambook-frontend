import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';
import {transitionDevelopmentBilling} from '../developmentBillingWorkflowService';
import {bindDevelopmentBillingCoverageInTx} from '../developmentBillingCoverageService';
import {parseNotificationLink} from '../../../../services/crossModuleNav';
import {View} from '../../../../types';
vi.mock('../developmentBillingCoverageService',()=>({bindDevelopmentBillingCoverageInTx:vi.fn(async()=>{})}));
vi.mock('../developmentClosureService',()=>({assertDevelopmentExpenseReviewCurrentInTx:vi.fn(async(_tx:any,_caseId:string,reviewId:string)=>({id:reviewId,fingerprint:'expense-fingerprint',snapshot:{costs:{records:[]}}}))}));
vi.mock('../../audit/routeAudit',()=>({writeRouteAuditLog:vi.fn(async()=>{})}));
function fixture(){
 const row:any={id:'bill',itemNo:'B1',sourceType:'DevelopmentCase',sourceId:'case',chargeType:'development_fee',status:'draft',developmentWorkflowState:'draft',developmentWorkflowVersion:0,developmentExpenseReviewId:'review',developmentApprovalId:null,developmentAssigneeId:null,amount:new Prisma.Decimal(100),waivedAmount:new Prisma.Decimal(0),offsetAmount:new Prisma.Decimal(0),currency:'USD',bearerType:'customer',bearerRelationId:'customer',bearerName:'Acme'};
 const events:any[]=[],tasks:any[]=[];
 const tx:any={
  $queryRaw:vi.fn(async()=>[{id:'case'}]),
  billingItem:{findFirst:async()=>row,update:async({data}:any)=>Object.assign(row,data)},
  developmentBillingWorkflowEvent:{findUnique:async({where}:any)=>events.find(e=>e.requestKey===where.billingItemId_requestKey.requestKey),create:async({data}:any)=>{events.push(data);return data}},
  workAssignment:{findMany:async()=>tasks.filter(t=>t.status==='assigned'&&t.metadata.kind==='billing_supplement'),findUnique:async({where}:any)=>tasks.find(t=>t.id===where.id),create:async({data}:any)=>{tasks.push(data);return data},update:async({where,data}:any)=>Object.assign(tasks.find(t=>t.id===where.id),data)},
  billingItemCostCoverage:{findMany:async()=>row.developmentWorkflowState==='submitted'?[{costRecordId:'cost'}]:[],updateMany:vi.fn(async()=>({count:1}))},
  notification:{createMany:vi.fn(async()=>({count:1}))},
  developmentCiBillingClaim:{findMany:vi.fn(async()=>[])},
  tradeDocument:{findMany:vi.fn(async()=>[])},
  invoiceLine:{findFirst:vi.fn(async()=>null)},
 };
 const approvalCreateService={createBusinessApproval:vi.fn(async({requesterId,targetType,targetId,actionType,payload}:any)=>({id:'approval-1',requesterId,reviewerId:'leader',targetType,targetId,actionType,status:'pending',payload}))};
 const context={prisma:{$transaction:async(fn:any)=>fn(tx)},actorId:'sales',authorizeBusiness:vi.fn(async()=>{}),authorizeFinance:vi.fn(async()=>{}),authorizeRecipient:vi.fn(async()=>{}),approvalCreateService};
 return {context,row,events,tasks,tx,approvalCreateService};
}
const submit={action:'submit' as const,requestKey:'s1',expectedVersion:0,note:'费用齐全',reviewId:'review',userId:'finance'};
beforeEach(()=>vi.clearAllMocks());
describe('development billing workflow',()=>{
 it('discounted customer submissions request leadership approval before any finance task or cost coverage',async()=>{
  const f=fixture();f.row.waivedAmount=new Prisma.Decimal(10);
  await transitionDevelopmentBilling(f.context,'case','bill',submit);
  expect(f.row.developmentWorkflowState).toBe('approval_pending');expect(f.row.developmentApprovalId).toBe('approval-1');
  expect(f.row.status).toBe('draft');expect(f.tasks).toHaveLength(0);expect(bindDevelopmentBillingCoverageInTx).not.toHaveBeenCalled();
  expect(f.approvalCreateService.createBusinessApproval).toHaveBeenCalledWith(expect.objectContaining({requesterId:'sales',targetType:'BillingItem',targetId:'bill',actionType:'development:fee',client:f.tx,payload:expect.objectContaining({
   schemaVersion:1,kind:'development_fee',caseId:'case',billingItemId:'bill',itemNo:'B1',expenseReviewId:'review',workflowVersion:1,amount:'100',waivedAmount:'10',currency:'USD',bearerType:'customer',bearerRelationId:'customer',bearerName:'Acme',financeUserId:'finance',
  })}));
  expect(f.tx.notification.createMany).toHaveBeenCalledWith(expect.objectContaining({data:[expect.objectContaining({userId:'leader',type:'development_fee_approval_requested',link:'/development?id=case&tab=fees',metadata:expect.objectContaining({approvalId:'approval-1'})})]}));
  expect(parseNotificationLink(f.tx.notification.createMany.mock.calls[0][0].data[0].link)).toEqual({view:View.Development,id:'case',tab:'fees',params:{}});
 });
 it('zero-fee customer submissions also require leadership approval and do not start finance',async()=>{
  const f=fixture();f.row.amount=new Prisma.Decimal(0);
  await transitionDevelopmentBilling(f.context,'case','bill',{...submit,note:'本案免收需领导批准'});
  expect(f.row.developmentWorkflowState).toBe('approval_pending');expect(f.row.status).toBe('draft');
  expect(f.tasks).toHaveLength(0);expect(bindDevelopmentBillingCoverageInTx).not.toHaveBeenCalled();
 });
 it('submission stays draft and retry does not duplicate the task or coverage',async()=>{
  const f=fixture();await transitionDevelopmentBilling(f.context,'case','bill',submit);
  expect(f.row.status).toBe('draft');expect(f.row.developmentWorkflowState).toBe('submitted');
  expect(f.tasks[0].metadata.decision).toMatchObject({reviewId:'review',state:'submitted',version:1});
  expect((await transitionDevelopmentBilling(f.context,'case','bill',submit)).recovered).toBe(true);
  expect(f.events).toHaveLength(1);expect(f.tasks).toHaveLength(1);expect(bindDevelopmentBillingCoverageInTx).toHaveBeenCalledTimes(1);
 });
 it('return/edit/resubmit closes supplement while retaining every prior event',async()=>{
  const f=fixture();await transitionDevelopmentBilling(f.context,'case','bill',submit);
  await transitionDevelopmentBilling({...f.context,actorId:'finance'},'case','bill',{action:'return',requestKey:'r1',expectedVersion:1,note:'缺凭据',requiredItems:['快递账单']});
  expect(f.tx.billingItemCostCoverage.updateMany).toHaveBeenCalledOnce();
  expect(f.tasks[0].metadata.result.outcome).toBe('returned');
  await transitionDevelopmentBilling(f.context,'case','bill',{action:'edit',requestKey:'e1',expectedVersion:2,note:'补齐费用',amount:120,waivedAmount:0,currency:'USD'});
  await transitionDevelopmentBilling(f.context,'case','bill',{...submit,requestKey:'s2',expectedVersion:3});
  expect(f.events.map(e=>e.action)).toEqual(['submit','return','edit','submit']);
  expect(f.tasks.filter(t=>t.status==='assigned')).toHaveLength(1);
  expect(f.tasks.find(task=>task.metadata.kind==='billing_supplement')?.metadata.result.outcome).toBe('resubmitted');
  expect(f.row.amount.toString()).toBe('120');expect(f.row.status).toBe('draft');expect(f.row.developmentExpenseReviewId).toBe('review');
  expect(bindDevelopmentBillingCoverageInTx).toHaveBeenLastCalledWith(f.tx,expect.anything(),expect.objectContaining({submissionVersion:4}));
 });
 it('rejects another finance actor, stale edits and conflicting retries',async()=>{
  const f=fixture();await transitionDevelopmentBilling(f.context,'case','bill',submit);
  await expect(transitionDevelopmentBilling({...f.context,actorId:'other'},'case','bill',{action:'return',requestKey:'r',expectedVersion:1,note:'资料缺失',requiredItems:['凭据']})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(transitionDevelopmentBilling(f.context,'case','bill',{action:'edit',requestKey:'e',expectedVersion:0,note:'修改',amount:1,waivedAmount:0,currency:'USD'})).rejects.toMatchObject({code:'BILLING_CHANGED'});
  await expect(transitionDevelopmentBilling(f.context,'case','bill',{...submit,note:'不同内容'})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
  expect(f.events).toHaveLength(1);
 });
});

it('取消已退回草稿保留事件并结束补充任务，核对中的方案不能直接取消',async()=>{
 const f=fixture();await transitionDevelopmentBilling(f.context,'case','bill',submit);
 await expect(transitionDevelopmentBilling(f.context,'case','bill',{action:'cancel',requestKey:'blocked-cancel',expectedVersion:1,note:'停止收费'})).rejects.toMatchObject({code:'INVALID_TRANSITION'});
 await transitionDevelopmentBilling({...f.context,actorId:'finance'},'case','bill',{action:'return',requestKey:'ret',expectedVersion:1,note:'待补依据',requiredItems:['客户确认']});
 await transitionDevelopmentBilling(f.context,'case','bill',{action:'cancel',requestKey:'cancel',expectedVersion:2,note:'方案作废，保留实际成本'});
 expect(f.row.status).toBe('cancelled');expect(f.row.developmentWorkflowState).toBe('cancelled');
 expect(f.tasks.filter(t=>t.status==='assigned')).toHaveLength(0);
 expect(f.events.map(e=>e.action)).toEqual(['submit','return','cancel']);
});

it('业务CI补充草稿可显式修改或取消释放预留，不送旧整案核对',async()=>{
 const f=fixture();f.row.developmentWorkflowState='business_ci_draft';f.row.developmentExpenseReviewId=null;
 f.tx.billingItemCostCoverage.findMany=vi.fn(async()=>[{id:'coverage',costRecordId:'late-cost'}]);
 await transitionDevelopmentBilling(f.context,'case','bill',{action:'edit',requestKey:'edit-supplement',expectedVersion:0,note:'客户明确新收费',amount:30,waivedAmount:0,currency:'USD'});
 expect(f.row.developmentWorkflowState).toBe('business_ci_draft');expect(f.row.amount.toString()).toBe('30');
 await expect(transitionDevelopmentBilling(f.context,'case','bill',{...submit,requestKey:'cannot-submit',expectedVersion:1})).rejects.toMatchObject({code:'INVALID_TRANSITION'});
 expect(bindDevelopmentBillingCoverageInTx).not.toHaveBeenCalled();
 await transitionDevelopmentBilling(f.context,'case','bill',{action:'cancel',requestKey:'cancel-supplement',expectedVersion:1,note:'业务取消补票草稿，费用保留'});
 expect(f.row.status).toBe('cancelled');expect(f.tx.billingItemCostCoverage.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({releaseReason:'业务取消补票草稿，费用保留'})}));
 expect(f.events.map(e=>e.action)).toEqual(['edit','cancel']);
});
