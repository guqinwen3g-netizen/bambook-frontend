import {randomUUID} from 'node:crypto';
import { businessError } from '../shared/errorCodes';
import { canonicalClaimJson } from '../claims/claimApprovalFact';
import { actualMoqFamily, buildActualMoqLines, lockMoqBasisRows, findCurrentMoqApproval, hashMoqBasis } from '../moq/moqApprovalBasis';
import { createMoqConfigService } from '../moq/moqConfigService';
import { isValidSnapshot, createMoqResolutionService } from '../moq/moqResolutionService';
import { createMoqValidationService } from '../moq/moqValidationService';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { canonicalQuantityPlan, lockAndValidateQuantityPlan, quantityPlanApprovalHash, quantityPlanCommercialFacts, validateProposedQuantityPlanMoney } from './orderLineQuantityPlan';

export function quantityApprovalFingerprint(payload:any):string {const {contentFingerprint,...facts}=payload;return hashMoqBasis(facts);}
export function withQuantityApprovalFingerprint(payload:any){return payload.changeType==='quantity'?{...payload,contentFingerprint:quantityApprovalFingerprint(payload)}:payload;}
export async function assertOriginalQuantityDecision(tx:any,approval:any){
 const fail=()=>{throw businessError('CONFLICT','原数量计划审批决定证据未核实或已变化（legacy_unverified），请重新审批');};
 if(!approval||approval.status!=='approved'||approval.payload?.changeType!=='quantity'||typeof approval.payload?.contentFingerprint!=='string'||approval.payload.contentFingerprint!==quantityApprovalFingerprint(approval.payload)||!approval.decidedAt)fail();
 const actorId=approval.bossFinalBypassBy??approval.reviewerId;if(!actorId)fail();
 const audits=await tx.auditLog.findMany({where:{targetType:'ApprovalRequest',targetId:approval.id}});
 const facts=audits.filter((a:any)=>{const fact=a.detail?.approvalDecisionFact;return a.actorId===actorId&&fact?.schemaVersion===1&&fact.status==='approved'&&fact.actionType===approval.actionType&&fact.targetType===approval.targetType&&fact.targetId===approval.targetId&&fact.decisionActorId===actorId&&fact.decidedAt===approval.decidedAt.toISOString()&&fact.contentFingerprint===approval.payload.contentFingerprint;});
 if(facts.length!==1)fail();
}
export function moqApprovalFingerprint(payload:any): string {
 return payload.plannedQuantityChange ? hashMoqBasis({moqBasisHash:payload.moqBasisHash,plannedQuantityChange:payload.plannedQuantityChange}) : payload.moqBasisHash;
}
async function currentActor(tx:any,id:string){
 const user=await loadUserWithRoles(tx,id);if(!user||user.status!=='active'||user.deletedAt!=null)throw businessError('CONFLICT','MOQ 原申请人账号不可用');
 return buildLoadedAuthTokenPayload(tx,user);
}
function configFacts(row:any){return {id:row.id,effectiveFrom:row.effectiveFrom.toISOString(),updatedAt:row.updatedAt.toISOString(),fabricDefaultMoq:row.fabricDefaultMoq,garmentDefaultMoq:row.garmentDefaultMoq,capsuleMoq:row.capsuleMoq};}
async function lockedActiveConfig(tx:any){
 await tx.$queryRawUnsafe('SELECT id FROM "MoqThresholdConfig" WHERE "isActive"=true ORDER BY id FOR UPDATE');
 const cfg=await tx.moqThresholdConfig.findFirst({where:{isActive:true},orderBy:{effectiveFrom:'desc'}});
 if(!cfg||![cfg.fabricDefaultMoq,cfg.garmentDefaultMoq,cfg.capsuleMoq].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0))throw businessError('CONFLICT','历史订单缺少已核实 MOQ 快照且当前没有有效配置，请先核实配置');
 return cfg;
}
export async function freezeQuantityMoqSnapshot(tx:any,order:any){
 if(isValidSnapshot(order.moqSnapshot))return null;
 const cfg=await lockedActiveConfig(tx);return {snapshot:{fabricDefaultMoq:cfg.fabricDefaultMoq,garmentDefaultMoq:cfg.garmentDefaultMoq,capsuleMoq:cfg.capsuleMoq,snapshotAt:new Date().toISOString(),configId:cfg.id,source:'moq_config'},configFacts:configFacts(cfg),originalSnapshot:order.moqSnapshot??null};
}
async function planSnapshotOrder(tx:any,cr:any,order:any){
 const frozen=cr.afterDelta?.quantityPlanMoqSnapshot;
 if(!frozen)return order;
 if(isValidSnapshot(order.moqSnapshot)){if(canonicalClaimJson(order.moqSnapshot)!==canonicalClaimJson(frozen.snapshot))throw businessError('CONFLICT','历史订单 MOQ 快照已变化，请重新核对数量计划');return order;}
 if(canonicalClaimJson(order.moqSnapshot??null)!==canonicalClaimJson(frozen.originalSnapshot))throw businessError('CONFLICT','未核实 MOQ 快照原件已变化');
 const cfg=await lockedActiveConfig(tx);if(!isValidSnapshot(frozen.snapshot)||canonicalClaimJson(configFacts(cfg))!==canonicalClaimJson(frozen.configFacts))throw businessError('CONFLICT','数量计划冻结的 MOQ 配置已变化，请重新申请');
 return {...order,moqSnapshot:frozen.snapshot};
}
export async function checkOrderMoqFacts(tx:any,order:any,rows:any[],actorId:string|null,lock=true){
 const actor=actorId?await currentActor(tx,actorId):null,configService=createMoqConfigService({prisma:tx});
 const lines=await buildActualMoqLines(tx,[...rows].sort((a,b)=>a.lineNumber-b.lineNumber||a.id.localeCompare(b.id)),actualMoqFamily(order));
 if(lock)await lockMoqBasisRows(tx,lines,order.customerRelationId);
 return createMoqValidationService({prisma:tx,configService,resolutionService:createMoqResolutionService({prisma:tx,configService})}).validateCreate({type:order.type,businessLine:order.businessLine,capsuleExemption:order.capsuleExemption===true,customerRelationId:order.customerRelationId??null,snapshot:order.moqSnapshot,lines},{actor});
}
export async function checkProposedPlanMoq(tx:any,cr:any,validated:any){
 validateProposedQuantityPlanMoney(validated);
 if(validated.actual.some((l:any)=>typeof l.moqOverride==='number'&&l.moqOverride>0))throw businessError('CONFLICT','MOQ 行级 override 原授权证据未核实（legacy_unverified），请先核实真实授权依据');
 const effectiveOrder=await planSnapshotOrder(tx,cr,validated.order);
 const original=await checkOrderMoqFacts(tx,effectiveOrder,validated.actual,cr.requesterId);
 const rows=validated.actual.map((line:any)=>({...line,quantity:validated.plan.lines.find((p:any)=>p.lineId===line.id)!.afterQuantity}));
 const proposed=await checkOrderMoqFacts(tx,effectiveOrder,rows,cr.requesterId);
 return {original,proposed,reference:{changeRequestId:cr.id,lineQuantityPlanHash:validated.hash,originalMoqBasisHash:original.basisHash}};
}
/** Caller has validated actor, scope, original approved plan and locks. */
export async function requireProposedPlanMoq(tx:any,cr:any,validated:any,approvalCreateService:any){
 const {original,proposed,reference}=await checkProposedPlanMoq(tx,cr,validated);
 if(proposed.lines.some((line:any)=>line.unresolvedReason))throw businessError('CONFLICT','数量变更后 MOQ 单位或来源未明确，不能普通豁免或生效');
 if(proposed.lines.every(line=>line.compliant))return null;
 const approved=await findCurrentMoqApproval(tx,'Order',cr.orderId,proposed,{plannedReference:reference});if(approved)return null;
 const payload={policyKey:'moq_exemption',reason:'quantity_change_below_moq',moqBasisVersion:1,moqBasis:proposed.basis,moqBasisHash:proposed.basisHash,plannedQuantityChange:reference,contentFingerprint:''};payload.contentFingerprint=moqApprovalFingerprint(payload);
 const pending=await tx.approvalRequest.findFirst({where:{requesterId:cr.requesterId,targetType:'Order',targetId:cr.orderId,actionType:'order:moq-exemption',status:'pending'},orderBy:{createdAt:'desc'}});
 if(pending){if(canonicalClaimJson(pending.payload)!==canonicalClaimJson(payload))return {approvalRequestId:pending.id,message:'原 MOQ 未决审批依据不同，请先处理原审批，再申请当前数量计划豁免'};return {approvalRequestId:pending.id,message:'数量变更后低于 MOQ，请先批准该数量计划的 MOQ 豁免'};}
 const approval=await approvalCreateService.createBusinessApproval({client:tx,requesterId:cr.requesterId,targetType:'Order',targetId:cr.orderId,actionType:'order:moq-exemption',risk:'high',payload});
 await tx.auditLog.create({data:{id:`audit_${randomUUID()}`,actorId:validated.actor.userId,action:'request_quantity_plan_moq_exemption',targetType:'ApprovalRequest',targetId:approval.id,detail:{source:'service:order-change:quantity-moq',plannedQuantityMoqRequestFact:{schemaVersion:1,changeRequestId:cr.id,orderId:cr.orderId,requesterId:cr.requesterId,creationActorId:validated.actor.userId,lineQuantityPlanHash:validated.hash,originalMoqBasisHash:original.basisHash,proposedMoqBasisHash:proposed.basisHash,contentFingerprint:payload.contentFingerprint,authority:{scope:'order:change_request:apply',signedCeiling:validated.actor.permissionCeiling??null,storedPermissions:validated.actor.permissions??[]}}},operationType:'create'}});
 return {approvalRequestId:approval.id,message:'数量变更后低于 MOQ，已创建对应计划的 MOQ 豁免审批，数量尚未生效'};
}
/** Real approval kernel validates future facts without changing stored business quantity. */
export async function assertPlannedMoqRequestFact(tx:any,approval:any,cr:any){
 const payload=approval.payload,ref=payload.plannedQuantityChange;
 const rows=await tx.auditLog.findMany({where:{targetType:'ApprovalRequest',targetId:approval.id}});
 const facts=rows.filter((a:any)=>{const fact=a.detail?.plannedQuantityMoqRequestFact;return a.action==='request_quantity_plan_moq_exemption'&&a.detail?.source==='service:order-change:quantity-moq'&&fact?.schemaVersion===1&&a.actorId===fact.creationActorId&&fact.authority?.scope==='order:change_request:apply'&&fact.changeRequestId===cr.id&&fact.orderId===cr.orderId&&fact.requesterId===cr.requesterId&&fact.lineQuantityPlanHash===ref.lineQuantityPlanHash&&fact.originalMoqBasisHash===ref.originalMoqBasisHash&&fact.proposedMoqBasisHash===payload.moqBasisHash&&fact.contentFingerprint===payload.contentFingerprint;});
 if(facts.length!==1)throw businessError('CONFLICT','MOQ 数量计划原申请授权事实未核实（legacy_unverified）');
 return facts[0].detail.plannedQuantityMoqRequestFact;
}
export async function assertPlannedMoqApproval(tx:any,approval:any){
 const payload=approval.payload,ref=payload.plannedQuantityChange;
 const fail=()=>{throw Object.assign(new Error('数量计划 MOQ 审批原件或来源已变化，请重新核对申请'),{code:'MOQ_APPROVAL_SOURCE_CHANGED',statusCode:409,status:409});};
 if(!ref||Object.keys(ref).sort().join(',')!=='changeRequestId,lineQuantityPlanHash,originalMoqBasisHash'||payload.contentFingerprint!==moqApprovalFingerprint(payload))fail();
 await tx.$queryRawUnsafe('SELECT id FROM "OrderChangeRequest" WHERE id=$1 FOR UPDATE',ref.changeRequestId);
 const cr=await tx.orderChangeRequest.findUnique({where:{id:ref.changeRequestId}});
 if(!cr||cr.status!=='Approved'||cr.deletedAt||cr.orderId!==approval.targetId||cr.requesterId!==approval.requesterId)fail();
 const creationFact=await assertPlannedMoqRequestFact(tx,approval,cr);
 await currentActor(tx,cr.requesterId);
 const actor=await currentActor(tx,creationFact.creationActorId);
 if(creationFact.authority.signedCeiling!==null)actor.permissionCeiling=creationFact.authority.signedCeiling;
 const validated=await lockAndValidateQuantityPlan(tx,cr.orderId,cr.afterDelta?.lineQuantityPlan,actor,'order:change_request:apply');
 const changeApproval=await tx.approvalRequest.findUnique({where:{id:cr.approvalRequestId}});
 if(!changeApproval||changeApproval.status!=='approved'||changeApproval.requesterId!==cr.requesterId||changeApproval.targetType!=='OrderChangeRequest'||changeApproval.targetId!==cr.orderId||changeApproval.actionType!=='order:change'||canonicalClaimJson(changeApproval.payload?.afterDelta)!==canonicalClaimJson(cr.afterDelta)||canonicalClaimJson(changeApproval.payload?.beforeSnapshot)!==canonicalClaimJson(cr.beforeSnapshot)||quantityPlanApprovalHash(canonicalQuantityPlan(cr.afterDelta.lineQuantityPlan),cr.afterDelta.lineCommercialFacts)!==validated.hash||canonicalClaimJson(cr.afterDelta.lineCommercialFacts)!==canonicalClaimJson(quantityPlanCommercialFacts(validated)))fail();
 await assertOriginalQuantityDecision(tx,changeApproval);
 const check=await checkProposedPlanMoq(tx,cr,validated);
 if(canonicalClaimJson(check.reference)!==canonicalClaimJson(ref)||check.proposed.lines.some((l:any)=>l.unresolvedReason)||check.proposed.basisHash!==payload.moqBasisHash||hashMoqBasis(payload.moqBasis)!==payload.moqBasisHash)fail();
}
/** Read-only consumer; caller owns current source locks for a writer. */
export async function currentOrderMoqReasons(tx:any,orderId:string){
 try {
 const order=await tx.order.findUnique({where:{id:orderId},include:{lines:{orderBy:{lineNumber:'asc'}}}});
 if(!order||order.deletedAt)return ['MOQ 原订单不可用'];
 if(!isValidSnapshot(order.moqSnapshot))return ['当前订单 MOQ 快照尚未核实'];
 if(order.lines.some((l:any)=>typeof l.moqOverride==='number'&&l.moqOverride>0))return ['MOQ 行级 override 原授权证据未核实（legacy_unverified）'];
 const check=await checkOrderMoqFacts(tx,order,order.lines,null,false);
 if(check.lines.some((l:any)=>l.unresolvedReason))return ['当前订单 MOQ 单位或来源未明确'];
 if(check.lines.every(line=>line.compliant)||await findCurrentMoqApproval(tx,'Order',orderId,check))return [];
 return ['当前实际订单行低于 MOQ 且无对应有效豁免'];
 } catch {return ['当前 MOQ 依据暂时无法核验，不能继续生产'];}
}
