import type { TokenPayload } from '../auth/service';
import type { MistContext } from '../shared/mistWorkspace';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
/** Approval authority is rebuilt in the same DB transaction as the business command. */
export async function mistApprovalAuthority(db:any,actor:TokenPayload,kind:string):Promise<NonNullable<MistContext['authority']>>{
  const authority:NonNullable<MistContext['authority']>={supplier:{}};
  if((actor as any).mistLocal===true && process.env.MIST_LOCAL_WORKSPACE==='1' && process.env.NODE_ENV!=='production'){
    for(const contract of ['purchase','processing'])for(const family of ['fabric','garment'])authority.supplier[`supplierCommitment.approvers.${contract}.${family}`]={version:1,userIds:['local-reviewer']};
    authority.claimReviewerId='local-reviewer';authority.businessReviewerId='local-reviewer';authority.orderReviewerIds={garment:['local-operator','local-reviewer'],fabric:['local-operator','local-reviewer']};return authority;
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
  if(kind.startsWith('market.quotation.')){try{authority.businessReviewerId=(await routing.resolveReviewerByDepartment(actor.userId)).reviewerId;}catch(error:any){if(error?.code!=='NO_REVIEWER_RESOLVED')throw error;}}
  return authority;
}
