import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { resolveVisibleOrderIds } from '../auth/orderVisibility';
import { businessError, lookupErrorCode } from '../shared/errorCodes';
import { getShipmentScheduleHistory, getShipmentRescheduleHistory, type ShipmentScheduleHistory } from './shipmentScheduleHistoryService';

const unavailable = () => businessError('AUTHORIZATION_UNAVAILABLE', lookupErrorCode('AUTHORIZATION_UNAVAILABLE')!.message);
const missing = () => businessError('SHIPMENT_NOT_FOUND', lookupErrorCode('SHIPMENT_NOT_FOUND')!.message);

/** Current scope plus the existing projection/allocation visibility policy.
 * History is immutable, but its reader and current parent visibility are not.
 * Default/dev/key identities never imply unrestricted access here. */
export async function readAuthorizedShipmentScheduleHistory(
  prisma: PrismaClient,
  prior: TokenPayload | null | undefined,
  shipmentId: string,
  options: { datesOnly?: boolean; limit?: number } = {},
): Promise<ShipmentScheduleHistory> {
  const qualify = async () => {
    if (!prior?.userId) throw businessError('UNAUTHORIZED', '请登录后查看船期变更历史。');
    let user;
    try { user = await loadUserWithRoles(prisma, prior.userId); } catch { throw unavailable(); }
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用，请重新登录。');
    let actor: TokenPayload;
    try { actor = await buildLoadedAuthTokenPayload(prisma, user); } catch { throw unavailable(); }
    if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
    // A signed legacy role name cannot replace a successfully loaded DB grant.
    if (!hasScope({ ...actor, roles: [] }, 'shipments:read')) throw businessError('FORBIDDEN', '当前账号没有运单历史读取权限。');
    let shipment;
    try { shipment = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { id: true, orderId: true, deletedAt: true } }); }
    catch { throw unavailable(); }
    if (!shipment || shipment.deletedAt != null || shipment.id !== shipmentId) throw missing();
    const visible = await resolveVisibleOrderIds(prisma, actor, { fresh: true, strict: true });
    if (visible === null || shipment.orderId && visible.includes(shipment.orderId)) return;
    let allocations;
    try { allocations = await prisma.shipmentOrderAllocation.findMany({ where: { shipmentId }, select: { orderId: true } }); }
    catch { throw unavailable(); }
    if (!Array.isArray(allocations)) throw unavailable();
    if (!allocations.some(row => visible.includes(row.orderId))) throw missing();
  };
  await qualify();
  // Unknown audit storage failures stay genuine 500 errors in the route's safe
  // envelope; they must never be represented as an authorized empty history.
  const result = options.datesOnly
    ? await getShipmentRescheduleHistory(prisma, shipmentId, options.limit)
    : await getShipmentScheduleHistory(prisma, shipmentId, options.limit);
  await qualify();
  if (result.shipmentId !== shipmentId) throw unavailable();
  return result;
}
