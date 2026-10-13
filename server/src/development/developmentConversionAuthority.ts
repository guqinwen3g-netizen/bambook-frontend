import { logger } from '../lib/logger';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { hasActualQcScope } from '../qc/qcExecutionScope';
import { createTeamShareService } from '../teams/teamShareService';
import { resolveWriteKind } from '../_shared/rolePermissionMatrix';
import { DevelopmentDomainError } from './developmentOperationalGuard';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
const fail=(code:string,message:string):never=>{throw new DevelopmentDomainError(code,message);};
/** Storage faults cannot be reduced to an empty permission/group set by legacy readers. */
export async function conversionAuthorityRead<T>(db:any,work:(strict:any)=>Promise<T>):Promise<T>{
  let storageFault=false;
  // A read snapshot can expose nonconfigurable, readonly delegates/methods.
  // Proxying that object directly and substituting a wrapper violates the JS
  // get invariant. Empty facades keep the original descriptors untouched, and
  // every method retains the real database/delegate as its receiver.
  const strict=new Proxy(Object.create(null),{get(_target,key){
    const value=Reflect.get(db,key,db);
    if(typeof value==='function')return value.bind(db);
    if(!value||typeof value!=='object'||typeof key!=='string'||key.startsWith('$'))return value;
    const delegate=value;
    return new Proxy(Object.create(null),{get(_delegateTarget,method){
      const fn=Reflect.get(delegate,method,delegate);
      if(typeof fn!=='function')return fn;
      return async(...args:any[])=>{
        try{return await Reflect.apply(fn,delegate,args);}
        catch(e){storageFault=true;logger.error('[ConversionAuthority] storage read failed',{error:e instanceof Error?e.message:String(e)});throw e;}
      };
    }});
  }});
  try{const result=await work(strict);if(storageFault)fail('AUTHORIZATION_UNAVAILABLE','当前授权或业务归属未能完整核对。');return result;}catch(error){if(storageFault)fail('AUTHORIZATION_UNAVAILABLE','当前授权或业务归属未能完整核对。');throw error;}
}
export function signedConversionCeiling(actor:TokenPayload):string[]|null{
  const value=actor.permissionCeiling!==undefined?actor.permissionCeiling:actor.permissions;
  if(value===undefined)return null;
  if(!Array.isArray(value)||value.some(s=>typeof s!=='string'||!s||s.trim()!==s))fail('FORBIDDEN','原凭据权限上限不可用。');
  return [...new Set(value)];
}
export async function currentConversionActor(db:any,scalarId:string|undefined,prior:TokenPayload|null|undefined,scope:'products:write'|'products:read'|'quotations:write'|'qc:read'|'qc:write'|'qc:inspect'):Promise<TokenPayload>{
  if(!prior?.userId||prior.userId!==scalarId)fail('UNAUTHORIZED','转单须使用与当前凭据一致的真实主体。');
  const ceiling=signedConversionCeiling(prior!);
  return conversionAuthorityRead(db,async strict=>{const user=await strict.userAccount.findFirst({where:{id:prior!.userId,deletedAt:null,status:'active'}});
    if(!user||user.id!==prior!.userId||user.deletedAt!=null||user.status!=='active')fail('UNAUTHORIZED','当前账号已不可用。');
    const service=createPermissionService({prisma:strict}),context=await service.getUserPermissionContext(prior!.userId);
    if(!context||context.userId!==prior!.userId)fail('AUTHORIZATION_UNAVAILABLE','当前权限未能完整核对。');
    const current:TokenPayload={...prior!,roles:context!.legacyRoleCodes,roleIds:context!.roleIds,permissions:context!.scopes,departmentIds:context!.departmentIds,authorizationLoaded:true,...(ceiling!==null?{permissionCeiling:ceiling}:{})};
    if(!(scope.startsWith('qc:')?hasActualQcScope(current,scope):hasScope(current,scope)))fail('FORBIDDEN','当前账号没有本次转单操作权限。');return current;
  });
}
export async function assertConversionCustomerWrite(db:any,actor:TokenPayload,customerId:string|null|undefined,legacyOwnerId?:string|null):Promise<void>{
  await conversionAuthorityRead(db,async strict=>{const service=createPermissionService({prisma:strict});
    if(customerId){const customer=await strict.relation.findFirst({where:{id:customerId,deletedAt:null}});if(!customer||customer.id!==customerId)fail('NOT_FOUND','业务来源不存在或不在当前可操作范围。');
      const access=await createTeamShareService(strict).resolveRelationAccess(actor,customerId,{fresh:true});if(!['owner','team-followup'].includes(access))fail('NOT_FOUND','业务来源不存在或不在当前可操作范围。');
    }else{const resolver=await service.getDataScopeResolver(actor,'relations');if(resolveWriteKind(resolver.rule)!=='all'&&(!legacyOwnerId||legacyOwnerId!==actor.userId))fail('NOT_FOUND','无客户锚点的业务来源尚不在当前可操作范围。');}
  });
}
/** One source authority for development operations, confirmations and QC.
 * Internal work is anchored to the recorded case owner and current development
 * data scope; a customer relation is not manufactured merely to gain access. */
export async function authorizeDevelopmentSource(db:any,scalarId:string|undefined,prior:TokenPayload|null|undefined,caseId:string,
  options:{scope?:'products:write'|'products:read'|'qc:read'|'qc:write'|'qc:inspect';write?:boolean}={}){
  const write=options.write??true;
  const actor=await currentConversionActor(db,scalarId,prior,options.scope??(write?'products:write':'products:read'));
  const development:any=await conversionAuthorityRead(db,strict=>strict.developmentCase.findFirst({where:{id:caseId,deletedAt:null}}));
  if(!development)fail('NOT_FOUND','开发来源不存在或不可见。');
  if(development.customerRelationId){
    if(write)await assertConversionCustomerWrite(db,actor,development.customerRelationId,development.ownerId);
    else await conversionAuthorityRead(db,async strict=>{if(!await createTeamShareService(strict).hasBizReadAccess(actor,development.customerRelationId,{fresh:true}))fail('NOT_FOUND','开发来源不存在或不可见。');});
  }else await conversionAuthorityRead(db,async strict=>{
    const resolver=await createPermissionService({prisma:strict}).getDataScopeResolver(actor,'development');
    const kind=write?resolveWriteKind(resolver.rule):resolver.rule.kind;
    const own=development.ownerId&&development.ownerId===actor.userId;
    const scopedOwner=development.ownerId&&(resolver.allowedUserIds??[]).includes(development.ownerId);
    const scopedDepartment=development.departmentId&&(resolver.allowedDepartmentIds??[]).includes(development.departmentId);
    if(kind!=='all'&&!own&&!scopedOwner&&!scopedDepartment)fail('NOT_FOUND','开发来源不存在或不在当前负责范围。');
  });
  return{actor,development};
}
export async function authorizeDevelopmentConversion(db:any,scalarId:string|undefined,prior:TokenPayload|null|undefined,caseId:string){
  return authorizeDevelopmentSource(db,scalarId,prior,caseId);
}
/** Existing link targets use actual customer follow-up or actual legacy owner; no leadership gate. */
export async function lockExistingConversionOrder(db:any,actor:TokenPayload,orderId:string){
  const rows=await db.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${orderId} AND "deletedAt" IS NULL FOR UPDATE`);
  if(!rows.length)fail('ORDER_NOT_FOUND','目标订单不存在或不可操作。');
  const order=await conversionAuthorityRead(db,async strict=>{const scope=await freshOrderLineScope(strict,actor);return strict.order.findFirst({where:{id:orderId,deletedAt:null,AND:[scope]}});});
  if(!order)fail('ORDER_NOT_FOUND','目标订单不存在或不可操作。');await assertConversionCustomerWrite(db,actor,(order as any).customerRelationId,(order as any).ownerId);return order as any;
}
