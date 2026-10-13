import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { createTeamShareService } from '../teams/teamShareService';
import { businessError, lookupErrorCode } from '../shared/errorCodes';
import { writeFieldAuditDiff, writeRouteAuditLog } from '../audit/routeAudit';

const operation = 'assign_order_responsibility' as const;
const fieldOperation = 'update_order_responsibility';
const cancellationOperation = 'cancel_order_responsibility' as const;
const source = 'service:orders:responsibility';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const stamp = /^(0|[1-9][0-9]*)$/;
type Point = { ownerId: string | null; departmentId: string | null; updatedAt: string };
export interface ResponsibilityCommand {
  clientRequestId: string; ownerId: string | null; departmentId: string | null; expectedUpdatedAt: string; reason: string;
}
export interface ResponsibilityReceipt {
  operation: typeof operation; actorId: string; orderId: string; clientRequestId: string;
  commandId: string; commandHash: string; before: Point; after: Point; reason: string; auditIds: string[];
}
export interface ResponsibilityCancellationReceipt {
  operation: typeof cancellationOperation; actorId:string; orderId:string; clientRequestId:string;
  commandId:string; commandHash:string; intent:ResponsibilityCommand; cancelReason:string; cancelledAt:string; auditIds:string[];
}
export type ResponsibilityOutcomeResult = {
  outcome:'committed'; receipt:ResponsibilityReceipt; callerCanRead:boolean; callerCanWrite:boolean;
} | {
  outcome:'cancelled'; receipt:ResponsibilityCancellationReceipt; callerCanRead:boolean; callerCanWrite:boolean;
};
export interface ResponsibilityView {
  orderId: string; owner: {id:string;displayName:string}|null;
  department: {id:string;name:string;headId:string|null}|null; updatedAt: string;
}
export interface ResponsibilityDto extends ResponsibilityView {
  canWrite: boolean; users?:Array<{id:string;displayName:string}>;
  departments?:Array<{id:string;name:string;headId:string|null}>;
}
export interface ResponsibilityReceiptResult { receipt:ResponsibilityReceipt; callerCanRead:boolean; callerCanWrite:boolean; }
export interface ResponsibilityMutationResult extends ResponsibilityReceiptResult { responsibility?:ResponsibilityView; replayed:boolean; }
const failure = () => businessError('AUTHORIZATION_UNAVAILABLE', '订单责任或权限暂时无法核对，请稍后重试。');
const conflict = (message: string) => businessError('CONFLICT', message);
const invalid = () => businessError('VALIDATION_FAILED', '请选择真实责任账号或部门，保留原更新时间并填写说明。');
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value === value.trim(); }
function command(input: any, allowEmpty = false): ResponsibilityCommand {
  if (!input || !uuid.test(input.clientRequestId) || typeof input.expectedUpdatedAt !== 'string' || !stamp.test(input.expectedUpdatedAt)
    || !Object.prototype.hasOwnProperty.call(input,'ownerId') || !Object.prototype.hasOwnProperty.call(input,'departmentId')
    || !(input.ownerId === null || id(input.ownerId)) || !(input.departmentId === null || id(input.departmentId))
    || (!allowEmpty && input.ownerId === null && input.departmentId === null) || typeof input.reason !== 'string' || !input.reason.trim()) throw invalid();
  return {clientRequestId:input.clientRequestId,ownerId:input.ownerId,departmentId:input.departmentId,
    expectedUpdatedAt:input.expectedUpdatedAt,reason:input.reason.trim()};
}
function hash(actorId: string, orderId: string, input: ResponsibilityCommand) {
  return createHash('sha256').update(JSON.stringify({operation,actorId,orderId,clientRequestId:input.clientRequestId,
    ownerId:input.ownerId,departmentId:input.departmentId,expectedUpdatedAt:input.expectedUpdatedAt,reason:input.reason})).digest('hex');
}
function point(order: any): Point {
  if (order.updatedAt == null || !stamp.test(String(order.updatedAt))) throw conflict('原订单更新时间不可核对，请先核对原记录。');
  return {ownerId:order.ownerId ?? null,departmentId:order.departmentId ?? null,updatedAt:String(order.updatedAt)};
}
async function current(db: any, prior: TokenPayload | null | undefined, scope: 'orders:read'|'orders:write'): Promise<TokenPayload> {
  if (!prior?.userId) throw businessError('UNAUTHORIZED','需要有效的用户登录会话。');
  try {
    const user = await loadUserWithRoles(db,prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED','账号已失效，请重新登录。');
    const actor = await buildLoadedAuthTokenPayload(db,user);
    if (prior.permissionCeiling !== undefined) actor.permissionCeiling=[...prior.permissionCeiling];
    if (!hasScope({...actor,roles:[]},scope)) throw businessError('FORBIDDEN','当前凭据没有所需的订单权限。');
    return actor;
  } catch(error: any) {
    if (['UNAUTHORIZED','ACCOUNT_DISABLED','FORBIDDEN'].includes(error?.code)) throw error;
    throw failure();
  }
}
/** Preserve OrdersV2's actual read/write L2, and force fresh shared reads.
 * Existing compatibility catches must not turn a failed dependency into empty visibility. */
async function allowed(db: any, actor: TokenPayload, order: any, write: boolean): Promise<boolean> {
  if (!order || order.deletedAt != null) return false;
  let fault = false;
  const strict = new Proxy(db,{get(target,key) {
    const delegate=Reflect.get(target,key);
    if (typeof key !== 'string' || key.startsWith('$') || !delegate || typeof delegate !== 'object') return delegate;
    return new Proxy(delegate,{get(value,method) {
      const fn=Reflect.get(value,method);
      if (typeof fn !== 'function') return fn;
      return async (...args: any[]) => {try{return await fn.apply(value,args);}catch(error){fault=true;throw error;}};
    }});
  }});
  try {
    const resolver=await createPermissionService({prisma:strict}).getDataScopeResolver(actor,'orders');
    let result: boolean;
    if (resolver.rule.kind === 'all') result=true;
    else if (write) {
      const follows=await strict.relation.findMany({where:{deletedAt:null,OR:[{ownerId:actor.userId},{salesRepIds:{has:actor.userId}}]},select:{id:true}});
      result=order.ownerId === actor.userId || follows.some((row: any)=>row.id === order.customerRelationId);
    } else {
      const visible=await createTeamShareService(strict).resolveVisibleRelationIds(actor,{fresh:true});
      result=visible.includes(order.customerRelationId) || (order.customerRelationId == null && order.ownerId === actor.userId);
    }
    if (fault) throw failure();
    return result;
  } catch(error: any) {
    if (['UNAUTHORIZED','ACCOUNT_DISABLED','FORBIDDEN'].includes(error?.code)) throw error;
    throw failure();
  }
}
async function found(db: any, orderId: string) {
  const order=await db.order.findUnique({where:{id:orderId}});
  if(!order || order.deletedAt != null) throw businessError('NOT_FOUND','订单不存在或不在当前范围。');
  return order;
}
async function flags(db: any, actor: TokenPayload, order: any) {
  return {callerCanRead:hasScope({...actor,roles:[]},'orders:read') && await allowed(db,actor,order,false),
    callerCanWrite:hasScope({...actor,roles:[]},'orders:write') && await allowed(db,actor,order,true)};
}
async function view(db: any, order: any) {
  const owner=order.ownerId ? await db.userAccount.findUnique({where:{id:order.ownerId},select:{id:true,displayName:true}}) : null;
  const department=order.departmentId ? await db.department.findUnique({where:{id:order.departmentId},select:{id:true,name:true,headId:true}}) : null;
  if ((order.ownerId && !owner) || (order.departmentId && !department)) throw failure();
  return {orderId:order.id,owner:owner ? {id:owner.id,displayName:owner.displayName}:null,
    department:department ? {id:department.id,name:department.name,headId:department.headId ?? null}:null,updatedAt:point(order).updatedAt};
}
async function targets(db: any, input: ResponsibilityCommand) {
  const owner=input.ownerId ? await db.userAccount.findUnique({where:{id:input.ownerId},include:{roles:{select:{departmentId:true}}}}):null;
  const department=input.departmentId ? await db.department.findUnique({where:{id:input.departmentId}}):null;
  const head=department?.headId ? await db.userAccount.findUnique({where:{id:department.headId}}):null;
  if(input.ownerId && (!owner || owner.status !== 'active' || owner.deletedAt != null)) throw conflict('所选责任账号不存在或已停用。');
  if(input.departmentId && (!department || department.status !== 'active')) throw conflict('所选部门不存在或已停用。');
  if(owner && department && owner.primaryDeptId !== department.id && !owner.roles.some((row: any)=>row.departmentId === department.id))
    throw conflict('所选账号与部门没有真实关联，请核对归属。');
  if(!owner && (!head || head.status !== 'active' || head.deletedAt != null)) throw conflict('所选部门没有有效的主管，不能清空全部责任。');
  return {owner,department,head};
}
async function original(db: any, actorId: string, orderId: string, key: string): Promise<ResponsibilityReceipt|null> {
  const rows=await db.auditLog.findMany({where:{actorId,targetType:'Order',targetId:orderId,action:operation,
    detail:{path:['after','clientRequestId'],equals:key}},take:2});
  if(!rows.length)return null;
  if(rows.length !== 1)throw conflict('原提交回执不能完整核对，请保留原请求。');
  const row=rows[0], receipt=row.detail?.after?.receipt as ResponsibilityReceipt;
  if (!receipt || receipt.operation !== operation || receipt.actorId !== actorId || receipt.orderId !== orderId || receipt.clientRequestId !== key
    || !uuid.test(receipt.commandId) || row.transactionId !== receipt.commandId || !id(receipt.commandHash)
    || !stamp.test(receipt.before?.updatedAt) || !stamp.test(receipt.after?.updatedAt)
    || BigInt(receipt.after.updatedAt) <= BigInt(receipt.before.updatedAt) || !Array.isArray(receipt.auditIds) || !receipt.auditIds.length
    || new Set(receipt.auditIds).size !== receipt.auditIds.length || receipt.auditIds.some(value=>!id(value)))
    throw conflict('原提交回执不能完整核对，请保留原请求。');
  const intent=command({clientRequestId:key,ownerId:receipt.after.ownerId,departmentId:receipt.after.departmentId,
    expectedUpdatedAt:receipt.before.updatedAt,reason:receipt.reason});
  let storedIntent: ResponsibilityCommand;
  try { storedIntent=command(row.detail.after.intent); } catch { throw conflict('原提交意图或回执已损坏，请保留原请求。'); }
  // PostgreSQL JSONB does not retain object insertion order.
  if (receipt.commandHash !== hash(actorId,orderId,intent) || JSON.stringify(storedIntent) !== JSON.stringify(intent))
    throw conflict('原提交意图或回执已损坏，请保留原请求。');
  const changed=(['ownerId','departmentId'] as const).filter(field=>receipt.before[field] !== receipt.after[field]);
  const audits=await db.auditLog.findMany({where:{id:{in:receipt.auditIds},actorId,targetType:'Order',targetId:orderId,
    action:fieldOperation,transactionId:receipt.commandId}});
  if(audits.length !== changed.length || audits.length !== receipt.auditIds.length || changed.some(field=>
    audits.filter((audit: any)=>audit.fieldPath===field && audit.beforeValue === receipt.before[field] && audit.afterValue === receipt.after[field]).length !== 1))
    throw conflict('原字段审计不完整，请保留原请求。');
  return receipt;
}
async function cancelled(db:any,actorId:string,orderId:string,key:string):Promise<ResponsibilityCancellationReceipt|null> {
  const rows=await db.auditLog.findMany({where:{actorId,targetType:'Order',targetId:orderId,action:cancellationOperation,
    detail:{path:['after','clientRequestId'],equals:key}},take:2});
  if(!rows.length)return null;
  if(rows.length !== 1)throw conflict('原取消回执不能完整核对，请保留原请求。');
  const row=rows[0],receipt=row.detail?.after?.receipt as ResponsibilityCancellationReceipt;
  let intent:ResponsibilityCommand;
  try {intent=command(receipt?.intent,true);}catch {throw conflict('原取消意图或回执已损坏，请保留原请求。');}
  if(!receipt || receipt.operation !== cancellationOperation || receipt.actorId !== actorId || receipt.orderId !== orderId
    || receipt.clientRequestId !== key || intent.clientRequestId !== key || !uuid.test(receipt.commandId)
    || row.transactionId !== receipt.commandId || receipt.commandHash !== hash(actorId,orderId,intent)
    || typeof receipt.cancelReason !== 'string' || !receipt.cancelReason.trim() || receipt.cancelReason !== receipt.cancelReason.trim()
    || !stamp.test(receipt.cancelledAt) || !Array.isArray(receipt.auditIds) || receipt.auditIds.length !== 1 || receipt.auditIds[0] !== row.id)
    throw conflict('原取消意图或回执已损坏，请保留原请求。');
  return receipt;
}
/** A missing commit summary must not let surviving field facts be falsely
 * declared cancelled. Only this actor/Order's new responsibility history is read. */
async function assertNoOrphanedCommit(db:any,actorId:string,orderId:string) {
  const fields=await db.auditLog.findMany({where:{actorId,targetType:'Order',targetId:orderId,action:fieldOperation},select:{transactionId:true}});
  const transactions=[...new Set<string>(fields.map((row:any)=>row.transactionId))];
  if(transactions.some(value=>!uuid.test(value)))throw conflict('原责任审计不完整，无法确认取消。');
  for(const transactionId of transactions) {
    const summaries=await db.auditLog.findMany({where:{actorId,targetType:'Order',targetId:orderId,action:operation,transactionId},take:2});
    if(summaries.length !== 1 || !uuid.test(summaries[0].detail?.after?.clientRequestId)
      || !await original(db,actorId,orderId,summaries[0].detail.after.clientRequestId))throw conflict('原责任审计不完整，无法确认取消。');
  }
}
async function bounded<T>(work:()=>Promise<T>): Promise<T> {
  try{return await work();}catch(error: any){
    if(error?.code === 'P2034' || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010'
      && ['40001','40P01'].includes(String(error.meta?.code)))) throw conflict('并发更新发生冲突，请核对原提交后重试。');
    if (lookupErrorCode(error?.code) && typeof error?.statusCode === 'number') throw error;
    throw failure();
  }
}
export function createOrderResponsibilityService(db: any) {
  async function get(prior: TokenPayload|null|undefined, orderId: string):Promise<{responsibility:ResponsibilityDto}> {
    return bounded<{responsibility:ResponsibilityDto}>(()=>db.$transaction(async (tx: any)=>{
      let actor=await current(tx,prior,'orders:read'),order=await found(tx,orderId);
      if(!await allowed(tx,actor,order,false))throw businessError('NOT_FOUND','订单不存在或不在当前范围。');
      const result=await view(tx,order);
      let users: Array<{id:string;displayName:string}>|undefined,departments: Array<{id:string;name:string;headId:string|null}>|undefined;
      if(hasScope({...actor,roles:[]},'orders:write') && await allowed(tx,actor,order,true)) {
        users=await tx.userAccount.findMany({where:{status:'active',deletedAt:null},select:{id:true,displayName:true},orderBy:[{displayName:'asc'},{id:'asc'}]});
        departments=await tx.department.findMany({where:{status:'active'},select:{id:true,name:true,headId:true},orderBy:[{name:'asc'},{id:'asc'}]});
      }
      actor=await current(tx,prior,'orders:read');order=await found(tx,orderId);
      if(!await allowed(tx,actor,order,false))throw businessError('NOT_FOUND','订单不存在或不在当前范围。');
      if(point(order).updatedAt !== result.updatedAt)throw conflict('订单归属已变化，请刷新后核对。');
      const canWrite=hasScope({...actor,roles:[]},'orders:write') && await allowed(tx,actor,order,true);
      return {responsibility:{...result,canWrite,...(canWrite?{users,departments}:{})}};
    }));
  }
  async function patch(prior: TokenPayload|null|undefined,orderId: string,raw: unknown):Promise<ResponsibilityMutationResult> {
    const input=command(raw);
    return bounded<ResponsibilityMutationResult>(()=>db.$transaction(async(tx: any)=>{
      let actor=await current(tx,prior,'orders:write');
      const hint=await found(tx,orderId), priorReceipt=await original(tx,actor.userId,orderId,input.clientRequestId);
      if(!priorReceipt && !await allowed(tx,actor,hint,true))throw businessError('NOT_FOUND','订单不在当前可操作范围。');
      // Every create/replay for an Order shares the original parent lock.
      const rows=await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`);
      if(!rows.length)throw businessError('NOT_FOUND','订单不存在或不在当前范围。');
      actor=await current(tx,prior,'orders:write');
      const previous=await original(tx,actor.userId,orderId,input.clientRequestId);
      const cancelledReceipt=await cancelled(tx,actor.userId,orderId,input.clientRequestId);
      if(previous && cancelledReceipt)throw conflict('原请求有冲突回执，请保留原请求。');
      if(cancelledReceipt)throw conflict(cancelledReceipt.commandHash === hash(actor.userId,orderId,input)
        ? '原请求已明确取消，继续办理请读取当前记录并明确建立新请求。' : '原请求已有不同意图的取消回执，请保留原请求。');
      if(previous) {
        if(previous.commandHash !== hash(actor.userId,orderId,input))throw conflict('同一请求已有不同归属意图，请保留原请求并核对。');
        actor=await current(tx,prior,'orders:write');
        const order=await tx.order.findUnique({where:{id:orderId}}), access=await flags(tx,actor,order);
        return {receipt:previous,...access,replayed:true};
      }
      const order=await found(tx,orderId),before=point(order);
      if(!await allowed(tx,actor,order,true))throw businessError('NOT_FOUND','订单不存在或不在当前可操作范围。');
      if(before.updatedAt !== input.expectedUpdatedAt)throw conflict('订单归属或版本已变化，请核对当前记录。');
      const selected=await targets(tx,input);
      const targetIds=[...new Set([input.ownerId,selected.department?.headId].filter((value): value is string=>Boolean(value)))].sort();
      for(const targetId of targetIds)await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "UserAccount" WHERE "id" = ${targetId} FOR UPDATE`);
      if(input.departmentId)await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Department" WHERE "id" = ${input.departmentId} FOR UPDATE`);
      const lockedTargets=await targets(tx,input);
      if((lockedTargets.department?.headId ?? null) !== (selected.department?.headId ?? null))throw conflict('部门主管已变化，请刷新后核对。');
      actor=await current(tx,prior,'orders:write');
      if(!await allowed(tx,actor,await found(tx,orderId),true))throw businessError('NOT_FOUND','订单不在当前可操作范围。');
      if(before.ownerId === input.ownerId && before.departmentId === input.departmentId)throw conflict('订单责任没有变化，请读取原记录。');
      const now=BigInt(Date.now()),next=now>BigInt(before.updatedAt)?now:BigInt(before.updatedAt)+BigInt(1);
      const changed=await tx.order.updateMany({where:{id:orderId,deletedAt:null,updatedAt:BigInt(input.expectedUpdatedAt),
        ownerId:before.ownerId,departmentId:before.departmentId},data:{ownerId:input.ownerId,departmentId:input.departmentId,updatedAt:next}});
      if(changed.count !== 1)throw conflict('订单归属或版本已变化，请核对当前记录。');
      const after=point(await found(tx,orderId)),commandId=randomUUID();
      const auditIds=await writeFieldAuditDiff({prisma:tx,actorId:actor.userId,source,operation:fieldOperation,targetType:'Order',targetId:orderId,
        before,after,trackedFields:['ownerId','departmentId'],operationType:'update',transactionId:commandId,note:input.reason});
      const receipt: ResponsibilityReceipt={operation,actorId:actor.userId,orderId,clientRequestId:input.clientRequestId,commandId,
        commandHash:hash(actor.userId,orderId,input),before,after,reason:input.reason,auditIds};
      await writeRouteAuditLog({prisma:tx,actorId:actor.userId,source,operation,targetType:'Order',targetId:orderId,before,
        after:{clientRequestId:input.clientRequestId,intent:input,receipt},operationType:'update',transactionId:commandId,note:input.reason});
      actor=await current(tx,prior,'orders:write');
      const actual=await found(tx,orderId);
      // Only this locked CAS's explicit owner change may remove the transferor's
      // owner basis. Current account/grants and customer followership are reloaded.
      if(!await allowed(tx,actor,{...actual,ownerId:before.ownerId},true))throw businessError('NOT_FOUND','原授权依据已撤回，归属未保存。');
      await targets(tx,input);
      const access=await flags(tx,actor,actual);
      return {receipt,...access,...(access.callerCanRead?{responsibility:await view(tx,actual)}:{}),replayed:false};
    }));
  }
  async function readReceipt(prior:TokenPayload|null|undefined,orderId:string,key:string):Promise<ResponsibilityOutcomeResult> {
    if(!uuid.test(key))throw invalid();
    return bounded<ResponsibilityOutcomeResult>(()=>db.$transaction(async(tx:any)=>{
      let actor=await current(tx,prior,'orders:read');
      const receipt=await original(tx,actor.userId,orderId,key), cancellation=await cancelled(tx,actor.userId,orderId,key);
      if(receipt && cancellation)throw conflict('原请求有冲突回执，请保留原请求。');
      if(!receipt && !cancellation)throw businessError('NOT_FOUND','原提交回执不存在。');
      actor=await current(tx,prior,'orders:read');
      const order=await tx.order.findUnique({where:{id:orderId}}),access=await flags(tx,actor,order);
      return receipt ? {outcome:'committed',receipt,...access}:{outcome:'cancelled',receipt:cancellation!,...access};
    }));
  }
  async function cancel(prior:TokenPayload|null|undefined,orderId:string,raw:any):Promise<ResponsibilityOutcomeResult> {
    const input=command(raw,true);
    if(typeof raw.cancelReason !== 'string' || !raw.cancelReason.trim() || typeof raw.parameterHash !== 'string')throw invalid();
    const cancelReason=raw.cancelReason.trim();
    return bounded<ResponsibilityOutcomeResult>(()=>db.$transaction(async(tx:any)=>{
      let actor=await current(tx,prior,'orders:write'),order=await found(tx,orderId);
      if(raw.parameterHash !== hash(actor.userId,orderId,input))throw conflict('原意图校验不一致，请保留原请求。');
      if(!await allowed(tx,actor,order,true))throw businessError('NOT_FOUND','订单不在当前可操作范围。');
      const locked=await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`);
      if(!locked.length)throw businessError('NOT_FOUND','订单不存在或不在当前范围。');
      actor=await current(tx,prior,'orders:write');order=await found(tx,orderId);
      if(!await allowed(tx,actor,order,true))throw businessError('NOT_FOUND','订单不在当前可操作范围。');
      const receipt=await original(tx,actor.userId,orderId,input.clientRequestId),priorCancel=await cancelled(tx,actor.userId,orderId,input.clientRequestId);
      if(receipt && priorCancel)throw conflict('原请求有冲突回执，请保留原请求。');
      if(receipt && receipt.commandHash !== raw.parameterHash)throw conflict('原提交已有不同意图，请保留原请求。');
      if(priorCancel && (priorCancel.commandHash !== raw.parameterHash || priorCancel.cancelReason !== cancelReason))throw conflict('原取消已有不同意图，请保留原请求。');
      let outcome:ResponsibilityOutcomeResult['outcome']='committed';
      let saved:ResponsibilityReceipt|ResponsibilityCancellationReceipt=receipt!;
      if(!receipt) {
        outcome='cancelled';
        if(priorCancel)saved=priorCancel;
        else {
          await assertNoOrphanedCommit(tx,actor.userId,orderId);
          const commandId=randomUUID(),auditId='alog_'+randomUUID();
          saved={operation:cancellationOperation,actorId:actor.userId,orderId,clientRequestId:input.clientRequestId,commandId,
            commandHash:raw.parameterHash,intent:input,cancelReason,cancelledAt:Date.now().toString(),auditIds:[auditId]};
          await tx.auditLog.create({data:{id:auditId,actorId:actor.userId,action:cancellationOperation,targetType:'Order',targetId:orderId,
            detail:{source,after:{clientRequestId:input.clientRequestId,receipt:saved},note:cancelReason},ip:null,operationType:'update',transactionId:commandId}});
        }
      }
      actor=await current(tx,prior,'orders:write');order=await found(tx,orderId);
      if(!await allowed(tx,actor,order,true))throw businessError('NOT_FOUND','原授权依据已撤回，取消未保存。');
      const access=await flags(tx,actor,order);
      return outcome === 'committed' ? {outcome,receipt:saved as ResponsibilityReceipt,...access}
        :{outcome,receipt:saved as ResponsibilityCancellationReceipt,...access};
    }));
  }
  return {get,patch,readReceipt,cancel};
}
