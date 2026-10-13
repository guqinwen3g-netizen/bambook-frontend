import { Prisma } from '@prisma/client';
import { businessError } from '../shared/errorCodes';

/** Active DR-054 S/S writer seam. Called AFTER the native Case/Sample locks
 * and BEFORE mutation. On insertion, the Order lock closes the empty-set gap. */
export async function lockShipmentSampleOrders(tx: any, orderIds: Array<string | null | undefined>): Promise<void> {
  for (const id of [...new Set(orderIds.filter((id): id is string => !!id))].sort()) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${id} FOR UPDATE`);
    if (!await tx.order.findFirst({ where: { id, deletedAt: null }, select: { id: true } }))
      throw businessError('ORDER_NOT_FOUND', '船样来源订单不存在或已删除。');
  }
}
