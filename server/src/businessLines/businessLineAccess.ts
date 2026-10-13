import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { resolveWriteKind, type PermissionScope } from '../_shared/rolePermissionMatrix';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { businessError, isBusinessError } from '../shared/errorCodes';

/** Registry metadata is used by Orders, QC configuration and system settings.
 * These are alternative read capabilities, never alternatives to dictionary write. */
export const BUSINESS_LINE_READ_SCOPES = ['orders:read', 'qc:read', 'settings:system:read'] as const;

/** A verified JWT/key identifies the subject and bounds the credential. Current
 * DB role/grant facts determine authority; body actor/role fields are not inputs. */
export async function currentBusinessLineActor(db: any, prior: TokenPayload | null | undefined,
  scopes?: PermissionScope | readonly PermissionScope[]): Promise<TokenPayload> {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '请登录后操作业务线。');
  let actor: TokenPayload;
  try {
    const user = await loadUserWithRoles(db, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) {
      throw businessError('ACCOUNT_DISABLED', '账号已失效，请重新登录。');
    }
    actor = await buildLoadedAuthTokenPayload(db, user);
    if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  } catch (error) {
    if (isBusinessError(error)) throw error;
    throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验业务线权限，请稍后重试。');
  }
  const required = scopes === undefined ? [] : typeof scopes === 'string' ? [scopes] : scopes;
  if (required.length && !required.some(scope => hasScope(actor, scope))) {
    throw businessError('FORBIDDEN', '当前账号没有该业务线操作权限。');
  }
  return actor;
}

/** The existing Orders resolver has a legacy read fallback for team query
 * faults. This boundary must distinguish failed loading from an empty scope. */
async function orderScope(db: any, actor: TokenPayload) {
  let failed = false;
  const strict = new Proxy(db, { get(target, key) {
    if (key !== 'teamMember') return Reflect.get(target, key);
    if (!target.teamMember) { failed = true; throw Error('BUSINESS_LINE_SCOPE_LOADING_FAILED'); }
    return new Proxy(target.teamMember, { get(delegate, method) {
      if (method !== 'findMany') return Reflect.get(delegate, method);
      return async (...args: any[]) => {
        try { return await delegate.findMany(...args); }
        catch (error) { failed = true; throw error; }
      };
    } });
  } });
  try {
    const resolver = await createPermissionService({ prisma: strict }).getDataScopeResolver(actor, 'orders');
    const scope = await buildOrderListScopeWhere(strict, actor, { fresh: true });
    if (failed) throw Error('BUSINESS_LINE_SCOPE_LOADING_FAILED');
    return { scope, writeKind: resolveWriteKind(resolver.rule) };
  } catch {
    throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验订单范围，请稍后重试。');
  }
}

/** Writes lock their parent before reloading current authority and L2. Reads
 * run in the caller's repeatable-read snapshot. A hidden parent is not disclosed. */
export async function businessLineOrderAccess(db: any, orderId: string,
  prior: TokenPayload | null | undefined, mode: 'read' | 'write') {
  if (typeof orderId !== 'string' || !orderId.trim()) throw businessError('VALIDATION_FAILED', 'orderId 必填');
  let actor = await currentBusinessLineActor(db, prior, mode === 'write' ? 'orders:write' : 'orders:read');
  if (mode === 'write') {
    // No absent-method/no-lock fallback: this is the real parent write boundary.
    const rows = await db.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`);
    if (!rows.length) throw businessError('ORDER_NOT_FOUND', '订单不存在或不在当前可操作范围。');
    actor = await currentBusinessLineActor(db, prior, 'orders:write');
  }
  const { scope, writeKind } = await orderScope(db, actor);
  const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] } });
  if (!order) throw businessError('ORDER_NOT_FOUND', '订单不存在或不在当前可操作范围。');
  // DR042 §5.3: sharing business history does not grant arbitrary Order edits.
  // A non-global writer must be the creator or a current customer follow-up.
  if (mode === 'write' && writeKind !== 'all' && order.ownerId !== actor.userId) {
    const customer = order.customerRelationId ? await db.relation.findFirst({ where: {
      id: order.customerRelationId, deletedAt: null,
      OR: [{ ownerId: actor.userId }, { salesRepIds: { has: actor.userId } }],
    }, select: { id: true } }) : null;
    if (!customer) throw businessError('FORBIDDEN', '当前账号只能查看该订单，不能修改业务线。');
  }
  return { actor, order };
}
