import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import { buildOrderListScopeWhere } from '../orders/orderService';

const relatedOrderSelect = {
  id: true, orderId: true, lineNumber: true, itemNo: true,
  description: true, cloth: true, quantity: true, unit: true,
  order: { select: { id: true, poNumber: true, customer: true, dueDate: true, status: true } },
} as const;

/** Product visibility does not grant visibility into linked customer orders.
 * Reuse the native order scope, including current team/customer and legacy
 * ownership branches. Scope/query failures propagate to the route error path. */
export async function readProductRelatedOrderLines(
  prisma: PrismaClient, actor: TokenPayload | null | undefined,
  asset: { sku?: string | null; fabricProfile?: { millQuality?: string | null } | null },
) {
  if (!hasScope(actor, 'orders:read')) return [];
  const scope = await buildOrderListScopeWhere(prisma, actor, { fresh: true });
  const model = prisma.orderLine;
  if (!model) throw new Error('Generated Prisma orderLine delegate is unavailable');
  const find = (match: { materialCode: string } | { millQuality: string }) => model.findMany({
    where: { ...match, order: { deletedAt: null, AND: [scope] } },
    select: relatedOrderSelect,
    orderBy: { lineNumber: 'asc' }, take: 50,
  });
  const lines = asset.sku ? await find({ materialCode: asset.sku }) : [];
  if (lines.length || !asset.fabricProfile?.millQuality) return lines;
  return find({ millQuality: asset.fabricProfile.millQuality });
}
