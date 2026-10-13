import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { resolveVisibleOrderIds, resolveVisibleShipmentIds } from '../auth/orderVisibility';
import { businessError, lookupErrorCode } from '../shared/errorCodes';
import { getOnTimeStats, getMethodStats, type ShipmentStatsProjection } from './shipmentStatsService';

const unavailable = () => businessError('AUTHORIZATION_UNAVAILABLE', lookupErrorCode('AUTHORIZATION_UNAVAILABLE')!.message);

/** Statistics follow the existing direct-parent OR any-SOA-parent shipping policy.
 * Both resource grants and current canonical order L2 are reloaded for each read.
 * A second projection validates current authority and source parents before any
 * aggregates leave the process; no default/dev/legacy-role scope substitutes. */
export async function readAuthorizedShipmentStats(
  prisma: PrismaClient,
  prior: TokenPayload | null | undefined,
  kind: 'on-time' | 'by-method',
  params: { from?: string; to?: string } = {},
) {
  const qualify = async (): Promise<ShipmentStatsProjection> => {
    if (!prior?.userId) throw businessError('UNAUTHORIZED', '请登录后查看货运统计。');
    let user;
    try { user = await loadUserWithRoles(prisma, prior.userId); } catch { throw unavailable(); }
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用，请重新登录。');
    let actor: TokenPayload;
    try { actor = await buildLoadedAuthTokenPayload(prisma, user); } catch { throw unavailable(); }
    if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
    if (!hasScope({ ...actor, roles: [] }, 'orders:read') || !hasScope({ ...actor, roles: [] }, 'shipments:read'))
      throw businessError('FORBIDDEN', '当前账号没有订单与货运统计读取权限。');
    const visible = await resolveVisibleOrderIds(prisma, actor, { fresh: true, strict: true });
    const shipmentIds = visible === null ? null : await resolveVisibleShipmentIds(prisma, visible, { strict: true });
    try {
      const orders = await prisma.order.findMany({
        where: { deletedAt: null, ...(visible === null ? {} : { id: { in: visible } }) },
        select: { id: true, dueDate: true }, orderBy: { id: 'asc' },
      });
      const shipments = await prisma.shipment.findMany({
        where: { deletedAt: null, ...(visible === null ? {} : { OR: [{ orderId: { in: visible } }, { id: { in: shipmentIds! } }] }) },
        select: { id: true, orderId: true, status: true, eta: true, ata: true, etd: true, shippingMethod: true }, orderBy: { id: 'asc' },
      });
      // Complete actual associations are required even for a fully scoped actor.
      // Parent labels are never loaded and foreign orders never enter the order bucket.
      const allocations = await prisma.shipmentOrderAllocation.findMany({
        where: { shipmentId: { in: shipments.map(s => s.id) } },
        select: { id: true, shipmentId: true, orderId: true, status: true }, orderBy: { id: 'asc' },
      });
      if (!Array.isArray(orders) || !Array.isArray(shipments) || !Array.isArray(allocations)) throw unavailable();
      return { orders, shipments, allocations };
    } catch { throw unavailable(); }
  };
  const projection = await qualify();
  const result = kind === 'on-time'
    ? await getOnTimeStats(prisma, params, projection)
    : await getMethodStats(prisma, params, projection);
  const current = await qualify();
  if (JSON.stringify(current) !== JSON.stringify(projection)) throw unavailable();
  return result;
}
