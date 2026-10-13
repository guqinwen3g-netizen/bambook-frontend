import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { createPermissionService, hasScope } from '../auth/permissionService';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';
import { businessError } from '../shared/errorCodes';
import { freshOrderLineScope } from './orderLineWriteAccess';

/** Only the authenticated HTTP/Tool caller supplies this context, never body data. */
export interface OrderQueryReadContext {
  actor?: TokenPayload | null;
  /** Explicit anonymous development-read compatibility, set after the module guard. */
  developmentRead?: boolean;
}
export interface OrderQueryReadAccess {
  actor: TokenPayload | null;
  orderWhere: Record<string, unknown>;
  financeWhere: Record<string, unknown>;
  can: (scope: PermissionScope) => boolean;
  fingerprint: string;
}
export function andOrderScope(where: any, scope: Record<string, unknown>): any {
  if (!Object.keys(scope).length) return where;
  return { AND: [...(Array.isArray(where.AND) ? where.AND : [where]), scope] };
}
function stable(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(stable).sort().join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function loadOrderQueryReadAccess(prisma: PrismaClient, context: OrderQueryReadContext = {}): Promise<OrderQueryReadAccess> {
  if (!context.actor?.userId) {
    if (context.developmentRead === true) return {actor:null,orderWhere:{},financeWhere:{},can:()=>true,fingerprint:'explicit-development-read'};
    throw businessError('UNAUTHORIZED', '订单查询需要有效的用户会话或已绑定员工的 API Key。');
  }
  let current: TokenPayload;
  try {
    const user = await loadUserWithRoles(prisma, context.actor.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '账号已失效，请重新登录。');
    current = await buildLoadedAuthTokenPayload(prisma,user);
    if (context.actor.permissionCeiling !== undefined) current.permissionCeiling = [...context.actor.permissionCeiling];
  } catch (error: any) {
    if (error?.code === 'ACCOUNT_DISABLED') throw error;
    throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验订单读取权限，请稍后重试。');
  }
  const can = (scope: PermissionScope) => hasScope({...current,roles:[]},scope);
  if (!can('orders:read')) throw businessError('FORBIDDEN', '当前账号没有订单读取权限。');
  const orderWhere = await freshOrderLineScope(prisma,current);
  let financeWhere: Record<string,unknown> = {};
  if (can('invoices:read') || can('vouchers:read')) {
    let fault = false;
    // Existing resolver has compatibility catches; strict reads distinguish a storage fault.
    const strict = new Proxy(prisma,{get(target,key) {
      if (key !== 'teamMember') return Reflect.get(target,key);
      return new Proxy((target as any).teamMember ?? {},{get(delegate,method) {
        if (method !== 'findMany') return Reflect.get(delegate,method);
        return async (...args: any[]) => {try {return await delegate.findMany(...args);} catch (error) {fault=true;throw error;}};
      }});
    }});
    try {
      const resolver = await createPermissionService({prisma:strict}).getDataScopeResolver(current,'finance');
      if (fault) throw Error('FINANCE_SCOPE_UNAVAILABLE');
      financeWhere = buildScopeWhereFromResolver(resolver,current.userId);
    } catch {
      throw businessError('AUTHORIZATION_UNAVAILABLE','暂时无法核验关联财务记录范围，请稍后重试。');
    }
  }
  return {actor:current,orderWhere,financeWhere,can,
    fingerprint:stable({userId:current.userId,roles:current.roles,permissions:current.permissions,
      ceiling:current.permissionCeiling,orderWhere,financeWhere})};
}
export function assertOrderReadAccessUnchanged(before: OrderQueryReadAccess, after: OrderQueryReadAccess) {
  if (before.fingerprint !== after.fingerprint) throw businessError('FORBIDDEN','读取期间权限或可查询范围发生变化，请重新查询。');
}
