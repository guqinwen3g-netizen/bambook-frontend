import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import { businessError } from '../shared/errorCodes';
import { createFinanceSourceAccess } from './financeSourceAccess';
import type { AttributedReceiptLine } from './receiptAttribution';

type Scope = Awaited<ReturnType<typeof createFinanceSourceAccess>>;
const contexts = new WeakMap<object, { tx: any; access: Scope; invoiceIds: string[]; voucherIds: string[] }>();
export const isFinanceReadProjection = (db: object) => contexts.has(db);

/** A finite read adapter for the financial reports/reconciliation engines. Each
 * delegate intersects source IDs before count, pagination or aggregation. It
 * exposes no writes, raw SQL or arbitrary model fallback. */
export async function withFinanceReadProjection<T>(prisma: any, actor: TokenPayload | null | undefined,
  read: (db: any) => Promise<T>, target: { orderId?: string; relationId?: string } = {}): Promise<T> {
  return prisma.$transaction(async (tx: any) => {
    const access = await createFinanceSourceAccess(tx, actor, []);
    if (!hasScope(access.actor, 'invoices:read') && !hasScope(access.actor, 'vouchers:read'))
      throw businessError('FORBIDDEN', '当前账号没有财务读取权限。');
    if (target.orderId && !await access.order(target.orderId)) throw businessError('NOT_FOUND', '订单不在当前财务范围。');
    const invoices: any[] = [], vouchers: any[] = [];
    for (const row of await tx.invoice.findMany({ where: { deletedAt: null } }))
      if (await access.invoice(row)) invoices.push(row);
    for (const row of await tx.paymentVoucher.findMany({ where: { deletedAt: null } }))
      if (await access.voucher(row)) vouchers.push(row);
    const invoiceIds = invoices.map(row => row.id), voucherIds = vouchers.map(row => row.id);
    const relationIds = new Set<string>([...invoices, ...vouchers].map(row => row.customerRelationId).filter(Boolean));
    if (target.relationId && !relationIds.has(target.relationId) && !await access.customer(target.relationId))
      throw businessError('NOT_FOUND', '交易对象不在当前财务范围。');
    if (access.all) {
      // The marker also prevents nested services from starting a new snapshot.
      const view = Object.create(tx);
      contexts.set(view, { tx, access, invoiceIds, voucherIds });
      const result = await read(view);
      await access.finish();
      return result;
    }
    let orderIdsPromise: Promise<string[]> | undefined, shipmentIdsPromise: Promise<string[]> | undefined;
    const orderIds = () => orderIdsPromise ??= (async () => {
      const ids: string[] = [];
      for (const row of await tx.order.findMany({ where: { deletedAt: null } })) if (await access.order(row.id)) {
        ids.push(row.id); if (row.customerRelationId) relationIds.add(row.customerRelationId);
      }
      return ids;
    })();
    const shipmentIds = () => shipmentIdsPromise ??= (async () => {
      const ids: string[] = [];
      for (const row of await tx.shipment.findMany({ where: { deletedAt: null } }))
        if (await access.source({ type: 'Shipment', id: row.id })) ids.push(row.id);
      return ids;
    })();
    const byOrder = async () => ({ orderId: { in: await orderIds() } });
    const constraints: Record<string, () => Promise<any>> = {
      invoice: async () => ({ id: { in: invoiceIds } }),
      paymentVoucher: async () => ({ id: { in: voucherIds } }),
      invoiceAllocation: async () => ({ OR: [{ invoiceId: { in: invoiceIds } }, { voucherId: { in: voucherIds } }] }),
      creditNoteAllocation: async () => ({ invoiceId: { in: invoiceIds } }),
      order: async () => ({ id: { in: await orderIds() } }), orderLine: byOrder,
      shipment: async () => ({ id: { in: await shipmentIds() } }),
      shipmentLine: async () => ({ shipmentId: { in: await shipmentIds() } }),
      shipmentOrderAllocation: async () => ({ orderId: { in: await orderIds() }, shipmentId: { in: await shipmentIds() } }),
      invoiceOrderAllocation: async () => ({ invoiceId: { in: invoiceIds }, orderId: { in: await orderIds() } }),
      fxSettlement: async () => ({ voucherId: { in: voucherIds } }),
      outwardRemittance: async () => ({ voucherId: { in: voucherIds } }),
      fxRateLock: byOrder, orderProfitSheet: byOrder, orderInternalTransfer: byOrder,
      customsDeclaration: async () => ({ orderId: { in: await orderIds() }, OR: [{ shipmentId: null }, { shipmentId: { in: await shipmentIds() } }] }),
      taxRefund: byOrder,
      relation: async () => {
        for (const row of await tx.relation.findMany({ where: { deletedAt: null } })) if (await access.customer(row.id)) relationIds.add(row.id);
        return { id: { in: [...relationIds] } };
      },
      customerReconciliationAck: async () => {
        for (const row of await tx.relation.findMany({ where: { deletedAt: null } })) if (await access.customer(row.id)) relationIds.add(row.id);
        return { customerRelationId: { in: [...relationIds] } };
      },
      exchangeRate: async () => ({}),
      dunningProfile: async () => ({ customerRelationId: { in: [...relationIds] } }),
      orderShipmentBatch: byOrder,
      orderPaymentEvent: byOrder,
    };
    const view: any = Object.create(null);
    for (const [model, constraint] of Object.entries(constraints)) {
      if (!tx[model]) continue;
      const delegate: any = Object.create(null);
      for (const method of ['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy']) {
        delegate[method] = async (args: any = {}) => {
          const actualMethod = method === 'findUnique' ? 'findFirst' : method === 'findUniqueOrThrow' ? 'findFirstOrThrow' : method;
          return tx[model][actualMethod]({ ...args, where: { AND: [args.where ?? {}, await constraint()] } });
        };
      }
      view[model] = delegate;
    }
    // A nested read remains on this transaction and the same finite projection.
    view.$transaction = async (work: any) => typeof work === 'function' ? work(view) : Promise.all(work);
    contexts.set(view, { tx, access, invoiceIds, voucherIds });
    const result = await read(view);
    await access.finish();
    return result;
  }, { isolationLevel: 'RepeatableRead' });
}

/** Only this customer's actual allocated share is exposed for a third-party
 * payer. Other customers' allocations and the payer's whole cash balance do
 * not become visible merely because one invoice is shared. */
export async function scopedCustomerReceiptLines(db: object, relationId: string): Promise<AttributedReceiptLine[] | null> {
  const context = contexts.get(db);
  if (!context || context.access.all) return null;
  const { tx, access, invoiceIds } = context;
  const invoices = await tx.invoice.findMany({ where: { id: { in: invoiceIds }, customerRelationId: relationId,
    type: 'Receivable', deletedAt: null, status: { in: ['Issued', 'PartiallyPaid', 'Paid'] } } });
  const ids = invoices.map((row: any) => row.id);
  const allocations = await tx.invoiceAllocation.findMany({ where: { invoiceId: { in: ids } } });
  const vouchers = await tx.paymentVoucher.findMany({ where: { deletedAt: null, type: 'Receipt', status: { notIn: ['cancelled', 'void'] },
    OR: [{ customerRelationId: relationId }, { id: { in: allocations.map((row: any) => row.voucherId) } }] } });
  const allAllocations = await tx.invoiceAllocation.findMany({ where: { voucherId: { in: vouchers.map((row: any) => row.id) } } });
  const result: AttributedReceiptLine[] = [];
  for (const row of vouchers) {
    const visible = await access.voucher(row);
    const applied = allocations.filter((item: any) => item.voucherId === row.id).reduce((sum: Prisma.Decimal, item: any) => sum.plus(item.appliedAmount), new Prisma.Decimal(0));
    const fullApplied = allAllocations.filter((item: any) => item.voucherId === row.id).reduce((sum: Prisma.Decimal, item: any) => sum.plus(item.appliedAmount), new Prisma.Decimal(0));
    const unallocated = visible && row.customerRelationId === relationId ? Prisma.Decimal.max(new Prisma.Decimal(row.amount).minus(fullApplied), 0) : new Prisma.Decimal(0);
    const amount = applied.plus(unallocated);
    if (amount.lte(0)) continue;
    result.push({ voucherId: row.id, voucherNumber: row.voucherNumber, ownerRelationId: relationId,
      ownerName: invoices[0]?.customerName ?? null, amount: amount.toNumber(), currency: row.currency,
      paymentDate: row.paymentDate, isThirdParty: row.customerRelationId !== relationId,
      payerRelationId: visible ? row.customerRelationId : null, payerName: visible ? row.customerName : null,
      appliedAmount: applied.toNumber(), unappliedAmount: unallocated.toNumber(),
      note: row.customerRelationId !== relationId ? '第三方付款，仅计入已核销至本客户的金额。' : null });
  }
  return result;
}
