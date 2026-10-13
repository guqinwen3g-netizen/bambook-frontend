import type {TokenPayload} from '../auth/service';
import {createPermissionService,hasScope} from '../auth/permissionService';
import {createTeamShareService} from '../teams/teamShareService';
import {conversionAuthorityRead,signedConversionCeiling} from '../development/developmentConversionAuthority';
import {businessError} from '../shared/errorCodes';
import {freshOrderLineScope} from './orderLineWriteAccess';
/** Current read policy, independent of source status/credit/new-write permission. */
export async function currentOrderConversionReader(db:any,prior:TokenPayload,sourceType:'development'|'quotation'):Promise<TokenPayload>{
 if(!prior?.userId)throw businessError('UNAUTHORIZED','请登录后核对原转单请求。');
 const ceiling=signedConversionCeiling(prior);
 return conversionAuthorityRead(db,async strict=>{
  const user=await strict.userAccount.findFirst({where:{id:prior.userId,deletedAt:null,status:'active'}});
  if(!user)throw businessError('UNAUTHORIZED','当前账号已不可用。');
  const context=await createPermissionService({prisma:strict}).getUserPermissionContext(prior.userId);
  if(!context)throw businessError('AUTHORIZATION_UNAVAILABLE','当前权限未能完整核对。');
  const actor:TokenPayload={...prior,roles:context.legacyRoleCodes,roleIds:context.roleIds,permissions:context.scopes,departmentIds:context.departmentIds,authorizationLoaded:true,...(ceiling!==null?{permissionCeiling:ceiling}:{})};
  const readScope=sourceType==='development'?'products:read':'quotations:read',writeScope=sourceType==='development'?'products:write':'quotations:write';
  if(!hasScope(actor,readScope)&&!hasScope(actor,writeScope))throw businessError('FORBIDDEN','当前账号没有读取本次业务来源的权限。');
  return actor;
 });
}
export async function assertOrderConversionCustomerRead(db:any,actor:TokenPayload,customerId:string|null,ownerId:string|null):Promise<void>{
 await conversionAuthorityRead(db,async strict=>{
  if(customerId){
   const customer=await strict.relation.findFirst({where:{id:customerId,deletedAt:null}});
   if(!customer||await createTeamShareService(strict).resolveRelationAccess(actor,customerId,{fresh:true})==='none')throw businessError('NOT_FOUND','业务来源不存在或不在当前可见范围。');
  }else{
   const resolver=await createPermissionService({prisma:strict}).getDataScopeResolver(actor,'relations');
   if(resolver.rule.kind!=='all'&&ownerId!==actor.userId)throw businessError('NOT_FOUND','业务来源不存在或不在当前可见范围。');
  }
 });
}
export async function assertOrderConversionTargetRead(db:any,actor:TokenPayload,orderId:string):Promise<void>{
 await conversionAuthorityRead(db,async strict=>{
  const scope=await freshOrderLineScope(strict,actor),order=await strict.order.findFirst({where:{id:orderId,deletedAt:null,AND:[scope]}});
  if(!order)throw businessError('ORDER_NOT_FOUND','目标订单不存在或不在当前可见范围。');
  await assertOrderConversionCustomerRead(strict,actor,order.customerRelationId??null,order.ownerId??null);
 });
}
