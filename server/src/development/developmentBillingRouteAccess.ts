import { businessError } from '../shared/errorCodes';
import type {TokenPayload} from '../auth/service';
import {createPermissionService,hasScope} from '../auth/permissionService';
import {createTeamShareService} from '../teams/teamShareService';
import {assertDevelopmentFinanceRecipient} from './developmentExpenseAccess';
import {resolveDevelopmentCostSource,resolveOrderCostSource} from './developmentCostSourceLock';
import {authorizeOrderCostReview} from '../pricing/orderCostReviewService';
import {buildOrderListScopeWhere} from '../orders/orderService';

function deny(status=404):never {const code = status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : 'NOT_FOUND'; const error = businessError(code, status===401?'请登录后操作':'收费记录不存在或无权操作'); throw Object.assign(error, { status: error.statusCode });}
/** Apply before pagination/count; never expose hidden cases through list totals. */
export async function developmentBillingReadWhere(db:any,actor:TokenPayload|null|undefined,options:{fresh?:boolean}={}){
 if(!actor?.userId)deny(401);
 const user=await db.userAccount.findFirst({where:{id:actor.userId,status:'active',deletedAt:null},select:{id:true}});
 const permissions=createPermissionService({prisma:db});
 const current=await permissions.getUserPermissionContext(actor.userId);
 if(!user||!current?.scopes.includes('invoices:read'))deny(403);
 const fresh:TokenPayload={...actor,roles:current.legacyRoleCodes,roleIds:current.roleIds,permissions:current.scopes,departmentIds:current.departmentIds,authorizationLoaded:true};
 if(!hasScope(fresh,'invoices:read'))deny(403);
 const resolver=await permissions.getDataScopeResolver(fresh,'invoices');
 const customerIds=resolver.rule.kind==='all'?null:await createTeamShareService(db).resolveVisibleRelationIds(fresh,options);
 const cases=await db.developmentCase.findMany({where:{deletedAt:null,...(customerIds?{customerRelationId:{in:customerIds}}:{})},select:{id:true}});
 const caseIds=cases.map((row:any)=>row.id);
 const sourceTypes=['DevelopmentCase','Sample','SampleBatch','SealSample','CostRecord','Order','OrderLine'];
 const branches:any[]=[{sourceType:{notIn:sourceTypes}},{sourceType:'DevelopmentCase',sourceId:{in:caseIds}}];
 const costVisible=current.scopes.includes('pricing:read')&&current.scopes.includes('sensitive:cost')&&hasScope(fresh,'pricing:read')&&hasScope(fresh,'sensitive:cost');
 const orderIds=costVisible?(await db.order.findMany({where:{deletedAt:null,AND:[await buildOrderListScopeWhere(db,fresh,options)]},select:{id:true}})).map((row:any)=>row.id):[];
 const orderLines=orderIds.length?await db.orderLine.findMany({where:{orderId:{in:orderIds}},select:{id:true}}):[];
 branches.push({sourceType:'Order',sourceId:{in:orderIds}},{sourceType:'OrderLine',sourceId:{in:orderLines.map((row:any)=>row.id)}});
 for(const [sourceType,model,field] of [['Sample','sample','sourceCaseId'],['SampleBatch','sampleBatch','developmentCaseId'],['SealSample','sealSample','developmentCaseId']]) {
  const sources=await db[model].findMany({where:{deletedAt:null,...(sourceType==='Sample'?{OR:[{[field]:null},{[field]:{in:caseIds}}]}:{[field]:{in:caseIds}})},select:{id:true}});
  branches.push({sourceType,sourceId:{in:sources.map((row:any)=>row.id)}});
 }
 // Propagate visibility through cost-to-cost references; orphaned/cyclic chains
 // never gain access merely because their immediate source is not a case.
 let frontier=(await db.costRecord.findMany({where:{deletedAt:null,OR:branches},select:{id:true}})).map((row:any)=>row.id);
 const costIds=new Set<string>(frontier);
 while(frontier.length){
  const children=await db.costRecord.findMany({where:{deletedAt:null,sourceType:'CostRecord',sourceId:{in:frontier}},select:{id:true}});
  frontier=children.map((row:any)=>String(row.id)).filter((id:string)=>!costIds.has(id));
  for(const id of frontier)costIds.add(id);
 }
 branches.push({sourceType:'CostRecord',sourceId:{in:[...costIds]}});
 return {OR:branches};
}

export async function assertDevelopmentBillingSourceAccess(db:any,actor:TokenPayload|null|undefined,sourceType:string,sourceId:string,mode:'read'|'write',options:{fresh?:boolean}={}){
 const where=await developmentBillingReadWhere(db,actor,options);
 if(mode==='write'){
  const current=await createPermissionService({prisma:db}).getUserPermissionContext(actor!.userId);
  if(!current?.scopes.includes('invoices:write'))deny(403);
  const fresh:TokenPayload={...actor!,roles:current.legacyRoleCodes,roleIds:current.roleIds,permissions:current.scopes,departmentIds:current.departmentIds,authorizationLoaded:true};
  if(!hasScope(fresh,'invoices:write'))deny(403);
 }
 const branch=where.OR.find((entry:any)=>entry.sourceType===sourceType);
 if(branch&&!(mode==='write'&&(sourceType==='Order'||sourceType==='OrderLine'))&&!branch.sourceId.in.includes(sourceId))deny();
 const seen=new Set<string>();
 while(sourceType==='CostRecord'){
  if(seen.has(sourceId))deny();seen.add(sourceId);
  const cost=await db.costRecord.findFirst({where:{id:sourceId,deletedAt:null}});
  if(!cost)deny();sourceType=cost.sourceType;sourceId=cost.sourceId;
 }
 if(sourceType==='Order'||sourceType==='OrderLine'){
  let orderId:string|null;
  try{orderId=await resolveOrderCostSource(db,sourceType,sourceId);}catch(error:any){if(error?.code==='INVALID_COST_SOURCE')deny();throw error;}
  try{await authorizeOrderCostReview(db,actor,mode,orderId!,options);}catch(error:any){if(typeof error?.statusCode==='number')throw Object.assign(error,{status:error.statusCode});throw error;}
  return;
 }
 let caseId:string|null;
 try {caseId=await resolveDevelopmentCostSource(db,sourceType,sourceId);}
 catch(error:any){if(error?.code==='INVALID_COST_SOURCE')deny();throw error;}
 if(mode==='write'&&caseId){
  try {await assertDevelopmentFinanceRecipient(db,caseId,actor!.userId,options);}
  catch(error:any){if(error?.code==='INVALID_FINANCE_RECIPIENT')deny();throw error;}
 }
}

export async function assertDevelopmentBillingRouteAccess(db:any,actor:TokenPayload|null|undefined,id:string,mode:'read'|'write',options:{fresh?:boolean}={}){
 if(!actor?.userId)deny(401);
 const where=await developmentBillingReadWhere(db,actor,options);
 const row=await db.billingItem.findFirst({where:{id,deletedAt:null,AND:[where]}});
 if(!row)deny();
 await assertDevelopmentBillingSourceAccess(db,actor,row.sourceType,row.sourceId,mode,options);
 if(row.costRecordId)await assertDevelopmentBillingSourceAccess(db,actor,'CostRecord',row.costRecordId,mode,options);
 return row;
}

/** Ordinary manual creation has a complete locked source graph. Standalone
 * samples/shipments cannot gain scope through the legacy unclassified branch.
 * The original internal cost/transfer callers retain their domain contracts. */
export async function assertOrdinaryBillingCreateSources(db:any,actor:TokenPayload,
 sources:Array<{type:string;id:string;row:any}>,root:{sourceType:string;sourceId:string}){
 const permissions=createPermissionService({prisma:db});
 if(!hasScope({...actor,roles:[]},'invoices:read')||!hasScope({...actor,roles:[]},'invoices:write'))deny(403);
 const resolver=await permissions.getDataScopeResolver(actor,'invoices');
 const orderScope=await buildOrderListScopeWhere(db,actor,{fresh:true});
 for(const source of sources){
  if(source.type==='Order'&&!await db.order.findFirst({where:{id:source.id,deletedAt:null,AND:[orderScope]},select:{id:true}}))deny();
  if(source.type==='DevelopmentCase'){
   try{await assertDevelopmentFinanceRecipient(db,source.id,actor.userId,{fresh:true});}
   catch(error:any){if(error?.code==='INVALID_FINANCE_RECIPIENT')deny();throw error;}
  }
  if(source.row.customerRelationId){
   if(!await db.relation.findFirst({where:{id:source.row.customerRelationId,deletedAt:null},select:{id:true}}))deny();
   if(resolver.rule.kind!=='all'&&!await createTeamShareService(db).hasBizReadAccess(actor,source.row.customerRelationId,{fresh:true}))deny();
  }else if((source.type==='Sample'||source.type==='Shipment')&&!source.row.sourceCaseId&&!source.row.sourceOrderId&&!source.row.orderId
   &&!sources.some(parent=>parent.type==='Order'||parent.type==='DevelopmentCase')&&resolver.rule.kind!=='all')deny();
 }
 // Preserve the existing explicit Order cost write contract (including reconcile).
 if(root.sourceType==='OrderLine'||root.sourceType==='CostRecord')
  await assertDevelopmentBillingSourceAccess(db,actor,root.sourceType,root.sourceId,'write',{fresh:true});
}
