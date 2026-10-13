import { Prisma, type PrismaClient } from '@prisma/client';
import { summarizeOrderQuantity, type OrderQuantitySummary } from './orderQuantitySummary';
type QuantityDb = Pick<PrismaClient, 'order' | 'orderLine'>;
/** Strict typed DB adapter: only known Decimal fields, never arbitrary object coercion. */
export async function readOrderQuantitySummary(db: QuantityDb, orderId: string): Promise<OrderQuantitySummary> {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { quantity: true, unit: true } });
  const lines = await db.orderLine.findMany({ where: { orderId }, select: { quantity: true, unit: true }, orderBy: { id: 'asc' } });
  return summarizeOrderQuantity({ activeOrderLines: lines.map(line => ({ quantity: line.quantity.toString(), unit: line.unit })),
    legacyQuantity: order.quantity?.toString() ?? null, legacyUnit: order.unit });
}
/** Caller must already hold Order before line writes; reacquiring its same row is safe. */
export async function refreshOrderQuantityHeader(tx: Prisma.TransactionClient, orderId: string): Promise<OrderQuantitySummary> {
  const parent = await tx.$queryRaw<{ id: string; updatedAt: bigint | null }[]>(Prisma.sql`SELECT "id", "updatedAt" FROM "Order" WHERE "id"=${orderId} FOR UPDATE`);
  if (parent.length !== 1) throw Error('ORDER_QUANTITY_PARENT_UNAVAILABLE');
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "orderId"=${orderId} ORDER BY "id" FOR UPDATE`);
  const lines = await tx.orderLine.findMany({ where: { orderId }, select: { quantity: true, unit: true }, orderBy: { id: 'asc' } });
  // No active lines after a real line-set mutation means unresolved, not stale legacy total.
  const summary = summarizeOrderQuantity({ activeOrderLines: lines.map(line => ({ quantity: line.quantity.toString(), unit: line.unit })) });
  await tx.order.update({ where: { id: orderId }, data: { quantity: summary.quantity, unit: summary.unit, updatedAt: parent[0].updatedAt != null && parent[0].updatedAt >= BigInt(Date.now()) ? parent[0].updatedAt + BigInt(1) : BigInt(Date.now()) } });
  return summary;
}
