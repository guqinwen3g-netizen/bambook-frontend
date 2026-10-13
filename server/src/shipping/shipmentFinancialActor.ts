import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { businessError, isBusinessError } from '../shared/errorCodes';

export type ShipmentFinancialAction = 'read' | 'write' | 'invoice';
export async function currentShipmentFinancialActor(tx: any, prior: TokenPayload | null | undefined,
  action: ShipmentFinancialAction): Promise<TokenPayload> {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '请使用当前账号办理出运结算。');
  let current: TokenPayload;
  try {
    const user = await loadUserWithRoles(tx, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
    current = await buildLoadedAuthTokenPayload(tx, user);
  } catch (error) {
    if (isBusinessError(error)) throw error;
    throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验出运结算权限。');
  }
  if (prior.permissionCeiling !== undefined) current.permissionCeiling = [...prior.permissionCeiling];
  const permission = action === 'invoice' ? 'invoices:write' : action === 'read' ? 'shipments:read' : 'shipments:write';
  if (!hasScope({ ...current, roles: [] }, 'orders:read') || !hasScope({ ...current, roles: [] }, permission))
    throw businessError('FORBIDDEN', '当前账号没有本次订单和出运结算权限。');
  return current;
}
export async function visibleFinancialOrder(tx: any, orderId: string, actor: TokenPayload) {
  const scope = await freshOrderLineScope(tx, actor);
  const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] } });
  if (!order) throw businessError('ORDER_NOT_FOUND', '来源订单不存在或不可查看。');
  return order;
}
