import type {CostEvidence} from './developmentCostEvidenceService';
import type {BillingItem} from './billingItemService';
import { apiService } from './apiService';
export interface ClosurePreview { state:'active'|'paused'|'closed'; revision:number; fingerprint:string; development:{stage:string}; openItems:Array<{id:string;type:string;label:string;status:string}>; }
export interface ExpenseReviewPreview { history:Array<{id:string;note:string;createdByName:string;createdAt:string;current:boolean}>;hasCurrentReview:boolean;fingerprint:string; pendingCount:number; snapshot:{lifecycleState:string;costs:{totals:Array<{currency:string;amount:string}>;records:Array<{id:string;amount:string;currency:string;costType?:string;sourceType?:string;sourceId?:string;incurredAt?:string;notes?:string|null;evidence?:CostEvidence[]}>;unsupportedCurrencies:string[];unresolvedProductionExpenses:unknown[]}}; }
export interface BillingWorkflowEvent {id:string;action:string;version:number;actorId:string;createdAt:string;requestKey?:string;snapshot:{note?:string;requiredItems?:string[];financeTaskId?:string;after?:{state?:string;version?:number;status?:string;confirmedBy?:string;approvalId?:string}}}
export interface BillingWorkflowFields {developmentWorkflowState?:string|null;developmentWorkflowVersion?:number;developmentWorkflowEvents?:BillingWorkflowEvent[];developmentExpenseReviewId?:string|null;developmentApprovalId?:string|null}
export interface BillingWorkflowCommand {action:'edit'|'submit'|'return'|'cancel'|'verify';requestKey:string;expectedVersion:number;note:string;reviewId?:string;userId?:string;requiredItems?:string[];amount?:string;waivedAmount?:string;currency?:string}
export interface BillingWorkflowResult {event:BillingWorkflowEvent;billingItem:BillingItem&BillingWorkflowFields;assignment?:{id:string;userId:string;assignerId:string;status:string;metadata:{managedBy:string;kind:string;caseId:string;billingItemId:string;result?:{outcome?:string;documentId?:string;versionId?:string}}};recovered?:boolean}
export interface DevelopmentBillingDraft extends BillingWorkflowFields {id:string;itemNo:string;status:string;amount:string;invoiceId?:string|null;waivedAmount:string;offsetAmount?:string|number;currency:string;notes?:string;}
export type ClosureCommand={kind:'billing';body:{reviewId?:string;requestKey:string;amount:string;waivedAmount:string;currency:string;note:string}}|{kind:'lifecycle';body:{action:'pause'|'resume'|'close';outcome?:'completed'|'stopped';reason:string;disposition?:string;expectedRevision:number;expectedFingerprint:string;requestKey:string}}|{kind:'review';body:{note:string;expectedFingerprint:string;requestKey:string}};
export interface DevelopmentBusinessTask {id:string;title?:string;caseId?:string;reason?:string;requiredItems?:string[];restricted:boolean;message?:string}
export interface DevelopmentFinanceTask {id:string;title?:string;status:string;restricted:boolean;message?:string;caseId?:string;kind?:string;submittedDecision?:{amount:string;waivedAmount:string;currency:string;note?:string}|null;result?:{outcome?:string;reason?:string;requiredItems?:string[]}|null;billingItem?:(BillingItem&BillingWorkflowFields)|null;}
export class ClosureError extends Error {constructor(message:string,public status:number){super(message);}}
async function call<T>(id:string,path:string,body?:unknown):Promise<T>{
 const response=await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(id)}/${path}`,apiService.getStoredConfig().cloudEndpoint),{method:body===undefined?'GET':'POST',headers:apiService.getAuthHeaders(),...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await response.json().catch(()=>null);
 if(!response.ok)throw new ClosureError(data?.error?.message||'结案与费用核对未完成',response.status);
 if(!data)throw new Error('响应不完整，请重试原请求');return data;
}
export const developmentClosureService={
 expenseEvidence:(taskId:string)=>call<{review:{id:string;note:string;snapshot:ExpenseReviewPreview['snapshot']};current:boolean}>('finance-tasks',`${encodeURIComponent(taskId)}/expense-evidence`),
 workflow:(id:string,billingId:string,body:BillingWorkflowCommand)=>call<BillingWorkflowResult>(id,`billing-drafts/${encodeURIComponent(billingId)}/workflow`,body),
 reviewRecipients:(id:string,cursor?:string)=>call<{recipients:Array<{id:string;displayName:string}>;nextCursor:string|null}>(id,`billing-review-recipients${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`),
 myBusinessTasks:(cursor?:string)=>call<{tasks:DevelopmentBusinessTask[];nextCursor:string|null}>('business-tasks',`mine${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`),
 myFinanceTasks:(status='assigned',cursor?:string)=>call<{tasks:DevelopmentFinanceTask[];nextCursor:string|null}>('finance-tasks',`mine?status=${encodeURIComponent(status)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`),
 recipients:(id:string,cursor?:string)=>call<{recipients:Array<{id:string;displayName:string}>;nextCursor:string|null}>(id,`finance-recipients${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`),
 confirmHandoff:(id:string,billingId:string,body:{userId:string;expectedUpdatedAt:string})=>call(id,`billing-drafts/${encodeURIComponent(billingId)}/confirm-handoff`,body),
 billing:(id:string)=>call<{billingItems:DevelopmentBillingDraft[]}>(id,'billing-drafts'),
 preview:(id:string)=>call<{closure:ClosurePreview}>(id,'closure-preview'),
 expenses:(id:string)=>call<{review:ExpenseReviewPreview}>(id,'expense-review-preview'),
 execute:(id:string,command:ClosureCommand)=>call(id,command.kind==='lifecycle'?'lifecycle':command.kind==='billing'?'billing-drafts':'expense-reviews',command.body),
};
