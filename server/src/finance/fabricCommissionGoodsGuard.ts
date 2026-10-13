import { Prisma } from '@prisma/client';
import { businessError } from '../shared/errorCodes';
import { normalizeFabricSupplyTerms, type FabricFinancialLine } from '../orders/fabricCommissionPolicy';
import { commissionObject } from './fabricCommissionSource';

const refuse = (): never => { throw businessError('HANDOFF_CONFLICT', '佣金行的货款由客户直接支付供应商；请从全单实际出运佣金原票登记我方应收。普通货物行须选择其准确独立货款来源。'); };
/** Immutable CI terms and current accurate rows must both exclude commission.
 * A legacy CI cannot erase a now-explicit approved commission responsibility. */
export async function assertBusinessCiGoodsResponsibility(tx: Prisma.TransactionClient, selected: unknown) {
  if (!Array.isArray(selected) || !selected.length) return refuse();
  const ids = selected.map(value => commissionObject(value).orderLineId);
  if (ids.some(id => typeof id !== 'string')) return refuse();
  const lines = await tx.orderLine.findMany({ where: { id: { in: ids as string[] } } });
  for (const value of selected) {
    const frozen = commissionObject(value), live = lines.find(line => line.id === frozen.orderLineId);
    if (!live || live.orderId !== frozen.orderId || normalizeFabricSupplyTerms(frozen as FabricFinancialLine).fabricSupplyMode === 'commission'
      || normalizeFabricSupplyTerms(live as FabricFinancialLine).fabricSupplyMode === 'commission') return refuse();
  }
}

/** The generic ledger may consume normal rows within a mixed order, but an
 * opaque whole-order amount or Manual line cannot disguise commission goods. */
export async function assertGenericFabricGoodsReceivable(tx: Prisma.TransactionClient, input: Record<string, unknown>) {
  if (input.type !== 'Receivable' || input.sourceType === 'BusinessShipmentCI' || input.sourceType === 'BusinessDevelopmentCI') return;
  const selected = Array.isArray(input.invoiceLines) ? input.invoiceLines.map(commissionObject) : [];
  const orderIds = new Set<string>();
  for (const id of [input.orderId, ...(Array.isArray(input.orderIds) ? input.orderIds : []),
    ...(Array.isArray(input.orderAllocations) ? input.orderAllocations.map(v => commissionObject(v).orderId) : []),
    ...(input.sourceType === 'Order' ? [input.sourceId] : [])]) if (typeof id === 'string' && id) orderIds.add(id);
  const lineIds = [...new Set([...(input.sourceType === 'OrderLine' ? [input.sourceId] : []),
    ...selected.filter(row => row.sourceType === 'OrderLine').map(row => row.sourceId)].filter((id): id is string => typeof id === 'string' && !!id))];
  const direct = lineIds.length ? await tx.orderLine.findMany({ where: { id: { in: lineIds } } }) : [];
  for (const line of direct) orderIds.add(line.orderId);
  if (!orderIds.size) return;
  const all = await tx.orderLine.findMany({ where: { orderId: { in: [...orderIds] } } });
  if (!all.some(line => normalizeFabricSupplyTerms(line as FabricFinancialLine).fabricSupplyMode === 'commission')) return;
  if (!selected.length || selected.some(row => row.sourceType !== 'OrderLine') || new Set(selected.map(row => row.sourceId)).size !== selected.length) return refuse();
  let total = new Prisma.Decimal(0);
  for (const row of selected) {
    const line = direct.find(line => line.id === row.sourceId);
    if (!line || normalizeFabricSupplyTerms(line as FabricFinancialLine).fabricSupplyMode === 'commission') return refuse();
    let amount: Prisma.Decimal;
    try { amount = new Prisma.Decimal(String(row.amount)); } catch { return refuse(); }
    if (!amount.isFinite() || amount.lte(0) || !line.unitPrice || amount.gt(line.quantity.mul(line.unitPrice))) return refuse();
    total = total.plus(amount);
  }
  try { if (!total.eq(String(input.amount))) return refuse(); } catch { return refuse(); }
  if ([...orderIds].some(id => !direct.some(line => line.orderId === id))) return refuse();
}
