import { Prisma, PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { authorizedDocumentOrders, currentDocumentActor, documentSourceFingerprint } from '../shipping/shipmentDocumentSource';
import { BUSINESS_SHIPMENT_CI_PREFIX, isBusinessShipmentCi, readBusinessShipmentCiVersionInTx } from '../customs/businessShipmentCiSnapshot';
import { createInvoice } from './invoiceMutationService';
import { assertBusinessCiGoodsResponsibility } from './fabricCommissionGoodsGuard';

function conflict(message: string): never { throw businessError('HANDOFF_CONFLICT', message); }

/** Finance records an already issued business CI as an AR fact. All money,
 * customer, line, and order values come from its exact issued version. */
export async function registerIssuedBusinessCiReceivable(prisma: PrismaClient, documentId: string, actor: TokenPayload | null,
  actorId: string, ip?: string | null) {
  if (!actor?.userId || actor.userId !== actorId) throw businessError('UNAUTHORIZED', '登记客户应收需要当前财务账号。');
  const afterCommit: Array<() => Promise<void>> = [];
  const outcome = await prisma.$transaction(async (tx: any) => {
    const current = await currentDocumentActor(tx, actor, ['invoices:write', 'customs:read', 'shipments:read', 'orders:read']);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${documentId} FOR UPDATE`);
    const source = await readBusinessShipmentCiVersionInTx(tx, documentId, current, { requiredScopes: ['customs:read'] });
    if (!isBusinessShipmentCi(source.document) || source.document.status !== 'Issued' || source.version.id !== source.latestVersion.id
      || !source.snapshot.issuedAt || source.snapshot.issueDate !== source.document.issueDate) {
      conflict('财务只能登记后勤单证已签发的当前商业发票版本。');
    }
    await assertBusinessCiGoodsResponsibility(tx, source.snapshot.lines);
    const existing = await tx.invoice.findFirst({ where: { sourceType: 'BusinessShipmentCI', sourceId: source.version.id } });
    if (existing) {
      if (existing.deletedAt != null || existing.invoiceNumber !== source.document.documentNumber
        || !new Prisma.Decimal(existing.amount).equals(source.snapshot.totalAmount) || existing.currency !== source.snapshot.currency
        || existing.customerRelationId !== source.snapshot.customerRelationId) {
        conflict('该 CI 已有财务来源记录，但台账内容不一致或已作废，请先核对，不得重复登记。');
      }
      return { invoice: existing, replayed: true };
    }

    const byOrder = new Map<string, Prisma.Decimal>();
    for (const line of source.snapshot.lines) byOrder.set(line.orderId,
      (byOrder.get(line.orderId) ?? new Prisma.Decimal(0)).plus(line.amount));
    const orderAllocations = [...byOrder.entries()].map(([orderId, amount]) => ({ orderId, allocatedAmount: amount.toString() }));
    const input = {
      invoiceNumber: source.document.documentNumber,
      type: 'Receivable', status: 'Issued', amount: String(source.snapshot.totalAmount), currency: source.snapshot.currency,
      issueDate: source.document.issueDate, customerRelationId: source.snapshot.customerRelationId,
      customerName: source.snapshot.parties?.billTo?.name ?? null,
      orderId: source.snapshot.orderIds.length === 1 ? source.snapshot.orderIds[0] : null,
      orderAllocations,
      sourceType: 'BusinessShipmentCI', sourceId: source.version.id,
      notes: `出运商业发票 ${source.document.documentNumber}`,
    };
    const mutation = await createInvoice({ prisma, input, actorId, actor: current, ip,
      transaction: { tx, deferAfterCommit: work => afterCommit.push(work) },
      businessCiRegistration: { documentId, versionId: source.version.id, snapshotFingerprint: documentSourceFingerprint(source.snapshot) } });
    if (!mutation.ok || !mutation.data?.invoice) conflict(mutation.error?.message || 'CI 应收登记未成功。');
    return { invoice: mutation.data.invoice, replayed: Boolean(mutation.data.replayed) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  for (const work of afterCommit) { try { await work(); } catch { /* the financial commit is authoritative; refresh can recover effects */ } }
  return outcome;
}

/** Finance inbox: issued shipment CIs without a matching AR ledger record. */
export async function listPendingBusinessCiReceivables(prisma: PrismaClient, actor: TokenPayload | null,
  options: { limit?: number; offset?: number } = {}) {
  const fresh = await currentDocumentActor(prisma, actor, ['invoices:read', 'customs:read', 'shipments:read', 'orders:read']);
  const take = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const skip = Math.max(0, Math.floor(options.offset ?? 0));
  const where = { type: 'CommercialInvoice', domain: 'customs', status: 'Issued', sourceInvoiceId: null,
    sourceRef: { startsWith: BUSINESS_SHIPMENT_CI_PREFIX }, deletedAt: null };
  const documents = await prisma.tradeDocument.findMany({ where, orderBy: [{ issueDate: 'asc' }, { createdAt: 'asc' }] });
  if (!documents.length) return { items: [], total: 0, offset: skip, limit: take };
  const versions = await prisma.documentVersion.findMany({ where: { documentId: { in: documents.map((row: any) => row.id) } },
    select: { id: true, documentId: true } });
  const versionIds = versions.map((row: any) => row.id);
  const registered = versionIds.length ? await prisma.invoice.findMany({
    where: { sourceType: 'BusinessShipmentCI', sourceId: { in: versionIds } }, select: { sourceId: true },
  }) : [];
  const registeredVersionIds = new Set(registered.map((row: any) => row.sourceId));
  const versionToDocument = new Map(versions.map((row: any) => [row.id, row.documentId]));
  const registeredDocumentIds = new Set(registered.map((row: any) => versionToDocument.get(row.sourceId)).filter(Boolean));
  const pending: any[] = [];
  for (const document of documents) {
    if (registeredDocumentIds.has(document.id)) continue;
    const source = await prisma.$transaction((tx: any) => readBusinessShipmentCiVersionInTx(tx, document.id, fresh, { requiredScopes: ['customs:read'] }));
    if (source.document.status !== 'Issued' || source.version.id !== source.latestVersion.id || !source.snapshot.issuedAt) continue;
    if (registeredVersionIds.has(source.version.id)) continue;
    // A trade-value CI for customer-to-supplier goods is retained in customs;
    // only the separate supplier-to-us commission original enters our AR.
    try { await assertBusinessCiGoodsResponsibility(prisma, source.snapshot.lines); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'HANDOFF_CONFLICT') continue; throw error; }
    const orders = await authorizedDocumentOrders(prisma, fresh, source.snapshot.orderIds);
    const orderById = new Map(orders.map((order: any) => [order.id, order]));
    pending.push({ documentId: document.id, documentNumber: document.documentNumber, shipmentId: document.shipmentId,
      issueDate: document.issueDate, amount: String(source.snapshot.totalAmount), currency: source.snapshot.currency,
      customerName: source.snapshot.parties?.billTo?.name ?? null, customerRelationId: source.snapshot.customerRelationId,
      contractNumber: source.snapshot.contractNumber, lineCount: source.snapshot.lines.length,
      orderReferences: source.snapshot.orderIds.map((id: string) => { const order: any = orderById.get(id); return { orderId: id, orderNumber: order?.code ?? null, poNumber: order?.poNumber ?? null }; }) });
  }
  return { items: pending.slice(skip, skip + take), total: pending.length, offset: skip, limit: take };
}
