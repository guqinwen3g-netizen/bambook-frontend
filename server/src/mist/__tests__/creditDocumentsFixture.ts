/** Explicit persisted-approval fixture only. It never reads or writes a live business store. */
import {createMistState,normalizeMistState,type MistState,type MistFile} from '../../shared/mistWorkspace';
import {appendClaimCreditSourceVersion,type MistCreditSourceLine,type MistCreditSourceVersion} from '../../shared/mistCreditDocuments';
import type {PlatformClaimDisposition} from '../../shared/mistPlatform';
export const CREDIT_DOCUMENT_NOW='2026-10-13T10:00:00.000Z';
export const CREDIT_DOCUMENT_IDS={credit:'credit-fixture',claim:'claim-fixture',source:'source-v1',invoice:'invoice-fixture',order:'order-fixture',customer:'customer-fixture'};
function approvedLine(id:string,amount:number,proofId:string):MistCreditSourceLine{
 const basis='本地契约测试已持久化批准依据 '+id;
 return {dispositionId:id,kind:'Allowance',amount,currency:'USD',basis,requesterId:'owner',reviewerId:'trusted-reviewer',submittedAt:'2026-10-13T01:00:00.000Z',decidedById:'trusted-reviewer',decidedBy:'模拟已核实审批人',decidedAt:'2026-10-13T02:00:00.000Z',decisionNote:'模拟已持久化批准决定',approvalSnapshot:JSON.stringify({kind:'Allowance',amount,currency:'USD',basis,quantity:0,unit:'',destination:''}),reviewFileIds:[proofId]};
}
function disposition(line:MistCreditSourceLine):PlatformClaimDisposition{return {id:line.dispositionId,kind:line.kind,amount:line.amount,quantity:0,unit:'',returnDisposition:'',basis:line.basis,fileIds:[...line.reviewFileIds],state:'Executed',reviewDecision:'approved',snapshot:line.approvalSnapshot,requesterId:line.requesterId,reviewerId:line.reviewerId,submittedAt:line.submittedAt,decidedById:line.decidedById,decidedBy:line.decidedBy,decidedAt:line.decidedAt,decisionNote:line.decisionNote,reviewFileIds:[...line.reviewFileIds],creditNoteId:CREDIT_DOCUMENT_IDS.credit};}
export function frozenCreditDocumentFixture(proof:MistFile):MistState{
 let sequence=0;const context={id:()=>`cn-fixture-${++sequence}`,actorId:'owner',actorName:'本地契约测试经手人',now:CREDIT_DOCUMENT_NOW},state=createMistState(context,'empty'),ids=CREDIT_DOCUMENT_IDS,line=approvedLine('disposition-v1',15,proof.id);
 state.settings.companyProfile={legalName:'本地CN契约验收公司',englishName:'Local Credit Contract Test Co',address:'上海本地测试地址',englishAddress:'Local test address, Shanghai',phone:'',email:'',taxId:'',customsCode:'',bankName:'',bankAccount:'',swift:'',defaultCurrency:'USD'};
 state.customers.push({id:ids.customer,code:'QA-CUSTOMER',name:'本地CN契约测试客户',country:'CN',city:'Shanghai',industry:'Garment',owner:'本地测试',grade:'A',currency:'USD',terms:'OA',incoterm:'FOB',categories:'成衣',creditLimit:0,since:'2026-10-13'});
 state.orders.push({id:ids.order,code:'SO-2026-QA-CN',type:'garment',customerId:ids.customer,customer:'本地CN契约测试客户',season:'AW26',lines:1,qty:4,amount:60,currency:'USD',due:'2026-11-30',progress:100,state:'明确模拟已持久化履约来源',tone:'ok',owner:'本地测试',img:'coat',checklist:[],handoffAt:CREDIT_DOCUMENT_NOW,createdAt:CREDIT_DOCUMENT_NOW,updatedAt:CREDIT_DOCUMENT_NOW});
 state.orderLines.push({id:'line-fixture',orderId:ids.order,name:'本地测试成衣',style:'QA-M',img:'coat',qty:4,unit:'件',price:15,made:4,qc:4});
 state.invoices.push({id:ids.invoice,code:'CI-2026-QA-CN',orderId:ids.order,order:'SO-2026-QA-CN',customer:'本地CN契约测试客户',due:'2026-11-30',amount:60,open:60,currency:'USD'});state.files.push(structuredClone(proof));
 const version:MistCreditSourceVersion={id:ids.source,version:1,amount:15,currency:'USD',claimId:ids.claim,claimCode:'CLM-2026-900001',invoiceId:ids.invoice,invoiceCode:'CI-2026-QA-CN',orderId:ids.order,orderCode:'SO-2026-QA-CN',customerId:ids.customer,customerName:'本地CN契约测试客户',orderApprovedVersion:1,lines:[line],createdAt:'2026-10-13T03:00:00.000Z',createdById:'owner',createdBy:'本地契约测试经手人',reason:'明确模拟已有批准执行，不代表当前业务记录'};
 state.platform.claims.push({id:ids.claim,code:version.claimCode,orderId:ids.order,invoiceId:ids.invoice,problem:'本地契约测试已批准折让',fileIds:[proof.id],state:'Processing',createdAt:CREDIT_DOCUMENT_NOW,dispositions:[disposition(line)]});
 state.platform.credits.push({id:ids.credit,code:'CLM-2026-900002',claimId:ids.claim,dispositionId:line.dispositionId,customerId:ids.customer,currency:'USD',amount:15,originalAmount:15,currentAmount:15,sourceInvoiceId:ids.invoice,currentVersionId:ids.source,schemaVersion:1,sourceVersions:[version],createdAt:CREDIT_DOCUMENT_NOW});normalizeMistState(state,context);return state;
}
/** A separate, explicit persisted V2 fixture; V1 and its approved facts remain untouched. */
export function appendFrozenCreditDocumentV2(input:MistState):MistState{
 const state=structuredClone(input),credit=state.platform.credits.find(row=>row.id===CREDIT_DOCUMENT_IDS.credit)!,previous=credit.sourceVersions!.at(-1)!,line=approvedLine('disposition-v2',5,previous.lines[0].reviewFileIds[0]);
 const next:MistCreditSourceVersion={...structuredClone(previous),id:'source-v2',version:2,previousVersionId:previous.id,amount:20,lines:[...structuredClone(previous.lines),line],createdAt:'2026-10-13T04:00:00.000Z',reason:'本地测试第二次批准执行来源'};
 credit.sourceVersions=appendClaimCreditSourceVersion(credit.sourceVersions!,next);credit.currentVersionId=next.id;credit.currentAmount=next.amount;credit.amount=next.amount;state.platform.claims.find(row=>row.id===CREDIT_DOCUMENT_IDS.claim)!.dispositions.push(disposition(line));return state;
}
