import type { TokenPayload } from '../auth/service';
import type { MistContext } from '../shared/mistWorkspace';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
/** Approval authority is rebuilt in the same DB transaction as the business command. */
export async function mistApprovalAuthority(db:any,actor:TokenPayload,kind:string):Promise<NonNullable<MistContext['authority']>>{
  const authority:NonNullable<MistContext['authority']>={supplier:{}};
  // 风险处理权：按当前账号此刻的岗位权限重建（risk:write 不限来源；否则只认本人客户/订单 + 现有订单写/客户档案写权限）。
  if(kind.startsWith('platform.risk.'))authority.risk={all:hasScope(actor,'risk:write' as any),orders:hasScope(actor,'orders:write' as any),customers:hasScope(actor,'relations:write' as any)};
  if((actor as any).mistLocal===true && process.env.MIST_LOCAL_WORKSPACE==='1' && process.env.NODE_ENV!=='production'){
    // 演示经办人（demo-*）的审批主管是周敏（demo-reviewer，业务主管岗）；测试身份沿用本地审批员 / 业务主管测试身份。
    const demo=String(actor.userId||'').startsWith('demo-'),single=demo?'demo-reviewer':'local-reviewer',managers=demo?['demo-reviewer']:['local-manager','local-reviewer'];
    for(const contract of ['purchase','processing'])for(const family of ['fabric','garment'])authority.supplier[`supplierCommitment.approvers.${contract}.${family}`]={version:1,userIds:demo?managers:['local-reviewer','local-manager']};
    // 本地测试审批人：原全权限审批员 + 按现有岗位持有 procurement:approve / orders:write 的业务主管测试身份。
    authority.claimReviewerId=single;authority.businessReviewerId=single;const orderReviewers=demo?managers:['local-operator','local-reviewer','local-manager'];authority.orderReviewerIds={garment:[...orderReviewers],fabric:[...orderReviewers]};
    // 付款申请：业务主管按岗位持有 finance:payment_request:approve。
    authority.paymentReviewerIds=[...managers];
    // 风险申请：业务主管按岗位持有 risk:write；申请人本人由命令排除。
    if(kind.startsWith('platform.risk.'))authority.riskReviewerIds=[...managers];
    return authority;
  }
  if(kind.startsWith('order.governance.')){
    const {createOrderMainApprovalService}=await import('../orders/orderMainApprovalService');
    const service=createOrderMainApprovalService(db);authority.orderReviewerIds={garment:[],fabric:[]};
    for(const domain of ['garment','fabric'] as const){
      let configured:string[];try{configured=await service.resolveEligibleReviewerIds(db,domain);}catch(error:any){if(error?.code==='ORDER_APPROVAL_AUTHORITY_MISSING')continue;throw error;}
      for(const id of configured){const user=await loadUserWithRoles(db,id);if(!user||user.status!=='active'||user.deletedAt)continue;const fresh=await buildLoadedAuthTokenPayload(db,user);if(hasScope({...fresh,roles:[]},'orders:write'))authority.orderReviewerIds[domain].push(id);}
    }
  }
  if(kind.startsWith('fulfillment.procurement.')){
    for(const contract of ['purchase','processing'])for(const family of ['fabric','garment']){
      const key=`supplierCommitment.approvers.${contract}.${family}`;
      const row=await db.systemConfig?.findUnique({where:{id:`global::${key}`}});
      let value:any=row?.value;try{if(typeof value==='string')value=JSON.parse(value);}catch{value=null;}
      if(value?.schemaVersion!==1||!Array.isArray(value.userIds)||!Number.isSafeInteger(row?.version))continue;
      const userIds:string[]=[];
      for(const id of [...new Set(value.userIds.filter((id:any)=>typeof id==='string'))].slice(0,100) as string[]){
        const user=await loadUserWithRoles(db,id);if(!user||user.status!=='active'||user.deletedAt)continue;
        const fresh=await buildLoadedAuthTokenPayload(db,user);if(hasScope(fresh,'procurement:approve' as any) && (fresh.globalBusinessScope || fresh.departmentIds.some(id=>actor.departmentIds.includes(id)) || fresh.userId===actor.userId))userIds.push(id);
      }
      authority.supplier[key]={version:row.version,userIds};
    }
  }
  const routing=createApprovalRoutingService({prisma:db});
  if(kind.startsWith('platform.claim.')){try{authority.claimReviewerId=(await routing.resolveClaimLeader(actor.userId)).reviewerId;}catch(error:any){if(error?.code!=='NO_REVIEWER_RESOLVED')throw error;}}
  // 付款申请由申请人所在部门主管审批；主管必须当前仍持有付款申请审批权，不能自审。
  if(kind.startsWith('payable.request.')){authority.paymentReviewerIds=[];try{const reviewerId=(await routing.resolveReviewerByDepartment(actor.userId)).reviewerId;const user=reviewerId&&reviewerId!==actor.userId?await loadUserWithRoles(db,reviewerId):null;if(user&&user.status==='active'&&!user.deletedAt&&hasScope(await buildLoadedAuthTokenPayload(db,user),'finance:payment_request:approve' as any))authority.paymentReviewerIds.push(reviewerId);}catch(error:any){if(error?.code!=='NO_REVIEWER_RESOLVED')throw error;}}
  // 风险关闭/豁免/带风险放行申请：由申请人所在部门主管审批；主管须当前在职、仍持有风险处理权，且不能是申请人本人。
  if(kind.startsWith('platform.risk.')){authority.riskReviewerIds=[];try{const reviewerId=(await routing.resolveReviewerByDepartment(actor.userId)).reviewerId;const user=reviewerId&&reviewerId!==actor.userId?await loadUserWithRoles(db,reviewerId):null;if(user&&user.status==='active'&&!user.deletedAt&&hasScope(await buildLoadedAuthTokenPayload(db,user),'risk:write' as any))authority.riskReviewerIds.push(reviewerId);}catch(error:any){if(error?.code!=='NO_REVIEWER_RESOLVED')throw error;}}
  if(kind.startsWith('market.quotation.')){try{authority.businessReviewerId=(await routing.resolveReviewerByDepartment(actor.userId)).reviewerId;}catch(error:any){if(error?.code!=='NO_REVIEWER_RESOLVED')throw error;}}
  return authority;
}
