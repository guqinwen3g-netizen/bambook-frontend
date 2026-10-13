import type { TokenPayload } from '../auth/service';
import { createPermissionService } from '../auth/permissionService';
import { createTeamShareService } from '../teams/teamShareService';
import { resolveWriteKind } from '../_shared/rolePermissionMatrix';
import { httpStatusOfCode } from '../shared/errorCodes';

function denied(code = 'DEVELOPMENT_NOT_ACCESSIBLE', status = 404): never {
  throw Object.assign(new Error('开发费用来源不存在或无权操作'), {code,status,httpStatus:status,statusCode:status});
}
/** Use the supplied transaction for source rechecks; library-visible customers are not business-visible. */
export async function assertDevelopmentExpenseAccess(tx:any, actor:TokenPayload|null|undefined, caseId:string, mode:'read'|'write') {
  if (!actor?.userId) denied('UNAUTHORIZED',401);
  const permissions=createPermissionService({prisma:tx});
  if (!permissions.hasScope(actor,mode==='write'?'products:write':'products:read')) denied('FORBIDDEN',403);
  const user=await tx.userAccount.findFirst({where:{id:actor.userId,deletedAt:null,status:'active'},select:{id:true,displayName:true}});
  if(!user)denied('FORBIDDEN',403);
  const current=await permissions.getUserPermissionContext(actor.userId);
  if(!current?.scopes.includes(mode==='write'?'products:write':'products:read'))denied('FORBIDDEN',403);
  actor={userId:actor.userId,displayName:user.displayName,roles:current.legacyRoleCodes,roleIds:current.roleIds,permissions:current.scopes,departmentIds:current.departmentIds};

  const development=await tx.developmentCase.findFirst({where:{id:caseId,deletedAt:null}});
  if (!development) denied();
  if (!development.customerRelationId) {
    const resolver=await permissions.getDataScopeResolver(actor,'relations');
    if (resolveWriteKind(resolver.rule)!=='all') denied();
    return development;
  }
  const customer=await tx.relation.findFirst({where:{id:development.customerRelationId,deletedAt:null},select:{id:true}});
  if (!customer) denied();
  const access=await createTeamShareService(tx).resolveRelationAccess(actor,customer.id);
  if (mode==='write' ? !['owner','team-followup'].includes(access) : access==='none') denied();
  return development;
}

export async function assertDevelopmentExpenseAssignee(tx:any, actor:TokenPayload|null|undefined, caseId:string, userId:string) {
  await assertDevelopmentExpenseAccess(tx,actor,caseId,'write');
  const user=await tx.userAccount.findFirst({where:{id:userId,deletedAt:null,status:'active'},select:{id:true,displayName:true}});
  if (!user) denied('INVALID_ASSIGNEE',400);
  const permissions=createPermissionService({prisma:tx});
  const context=await permissions.getUserPermissionContext(userId);
  if (!context) denied('INVALID_ASSIGNEE',400);
  const assignee:TokenPayload={userId,displayName:user.displayName,roles:context.legacyRoleCodes,roleIds:context.roleIds,permissions:context.scopes,departmentIds:context.departmentIds};
  // Explicitly use current DB scopes: an empty set must not regain code-default roles.
  if (!context.scopes.includes('products:write')) denied('INVALID_ASSIGNEE',400);
  await assertDevelopmentExpenseAccess(tx,assignee,caseId,'write');
  return user;
}

/** Resolve the recipient from current DB permissions, not cached role names or caller-supplied scopes. */
export async function assertDevelopmentFinanceRecipient(tx:any, caseId:string, userId:string, options:{fresh?:boolean}={}) {
  const user=await tx.userAccount.findFirst({where:{id:userId,deletedAt:null,status:'active'},select:{id:true,displayName:true}});
  if(!user) denied('INVALID_FINANCE_RECIPIENT',400);
  const permissions=createPermissionService({prisma:tx});
  const current=await permissions.getUserPermissionContext(userId);
  if(!current||!current.scopes.includes('invoices:read')||!current.scopes.includes('invoices:write')) denied('INVALID_FINANCE_RECIPIENT',400);
  const actor:TokenPayload={userId,displayName:user.displayName,roles:current.legacyRoleCodes,roleIds:current.roleIds,permissions:current.scopes,departmentIds:current.departmentIds};
  const development=await tx.developmentCase.findFirst({where:{id:caseId,deletedAt:null}});
  if(!development?.customerRelationId) denied('INVALID_FINANCE_RECIPIENT',400);
  const customer=await tx.relation.findFirst({where:{id:development.customerRelationId,deletedAt:null},select:{id:true}});
  if(!customer) denied('INVALID_FINANCE_RECIPIENT',400);
  const resolver=await permissions.getDataScopeResolver(actor,'invoices');
  if(resolveWriteKind(resolver.rule)!=='all') {
    const access=await createTeamShareService(tx).resolveRelationAccess(actor,customer.id,options);
    if(!['owner','team-followup'].includes(access)) denied('INVALID_FINANCE_RECIPIENT',400);
  }
  return {id:user.id,displayName:user.displayName};
}

/** A recipient's DB grant cannot expand the verified session's signed ceiling. */
export async function assertDevelopmentFinanceWriteAccess(tx:any, actor:TokenPayload|null|undefined, caseId:string) {
  if (!actor?.userId) denied('UNAUTHORIZED',httpStatusOfCode('UNAUTHORIZED'));
  const permissions=createPermissionService({prisma:tx});
  if (!permissions.hasScope(actor,'invoices:read') || !permissions.hasScope(actor,'invoices:write')) denied('FORBIDDEN',httpStatusOfCode('FORBIDDEN'));
  try { return await assertDevelopmentFinanceRecipient(tx,caseId,actor.userId); }
  catch(error:any) {
    if (error?.code==='INVALID_FINANCE_RECIPIENT') denied('FORBIDDEN',httpStatusOfCode('FORBIDDEN'));
    throw error;
  }
}
