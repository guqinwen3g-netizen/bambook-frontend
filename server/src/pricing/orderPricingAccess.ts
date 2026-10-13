import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { businessError } from '../shared/errorCodes';

/** Pricing permissions and customer/order visibility are separate gates. */
export function createOrderPricingAccess(db: any, supplied: TokenPayload | null | undefined, developmentRead = false) {
  async function scope(mode: 'read' | 'write'): Promise<Record<string, unknown>> {
    if (!supplied?.userId) {
      if (mode === 'read' && developmentRead) return {};
      throw businessError('UNAUTHORIZED', '请先登录后访问订单定价记录。');
    }
    const user = await db.userAccount.findFirst({ where: { id: supplied.userId, status: 'active', deletedAt: null }, select: { id: true } });
    const current = user && await createPermissionService({ prisma: db }).getUserPermissionContext(supplied.userId);
    if (!current) throw businessError('FORBIDDEN', '当前账号不可访问订单定价记录。');
    const actor: TokenPayload = { userId: current.userId, roles: current.legacyRoleCodes,
      roleIds: current.roleIds, permissions: current.scopes, departmentIds: current.departmentIds,
      authorizationLoaded: true, ...(supplied.permissionCeiling ? { permissionCeiling: [...supplied.permissionCeiling] } : {}) };
    const required = mode === 'read' ? 'pricing:read' : 'pricing:write';
    if (!current.scopes.includes(required) || !hasScope(actor, required)) throw businessError('FORBIDDEN', '当前权限不足以访问订单定价记录。');
    return buildOrderListScopeWhere(db, actor);
  }
  async function requireOrder(orderId: string, mode: 'read' | 'write') {
    const visible = await scope(mode);
    const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [visible] }, select: { id: true } });
    if (!order) throw businessError('NOT_FOUND', '订单不存在或不在当前业务范围内。');
  }
  return { scope, requireOrder };
}
