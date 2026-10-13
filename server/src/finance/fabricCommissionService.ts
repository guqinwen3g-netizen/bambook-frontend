import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { currentDocumentActor, authorizedDocumentOrders, documentSourceJson as json } from '../shipping/shipmentDocumentSource';
import { currentExporterProfileSnapshot } from '../templates/docTemplates/financeInvoice';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { businessNowMs } from '../shared/businessClock';
import { todayLocalKey, isValidLocalDateKey } from '../shared/localDate';
import { businessError } from '../shared/errorCodes';
import { syncInvoiceReferences } from '../entities/sync';
import { beginFinanceCommand } from './financeCommandReceipt';
import { createFinanceSourceAccess } from './financeSourceAccess';
import { FABRIC_COMMISSION_SOURCE, FABRIC_COMMISSION_PREFIX, FABRIC_COMMISSION_SETTLED, FABRIC_COMMISSION_REGISTERED,
  commissionObject, commissionSettlementId, currentFabricCommissionSource, lockFabricCommissionSourcesInTx,
  readFabricCommissionOriginal, readFabricCommissionInvoiceSource,
  type FabricCommissionIssuedSnapshot, type FabricCommissionSettlementReceipt } from './fabricCommissionSource';

type Actor = TokenPayload | null | undefined;
function conflict(message: string): never { throw businessError('HANDOFF_CONFLICT', message); }
const invalid = (message: string): never => { throw businessError('INVALID_INPUT', message); };
const invisible = (): never => { throw businessError('NOT_FOUND', '佣金原票或准确订单不在当前数据范围。'); };
function settlementInput(input: unknown, orderId: string) {
  const row = commissionObject(input);
  if (Object.keys(row).some(key => !['requestKey', 'expectedSourceFingerprint', 'dueDate', 'note'].includes(key))
    || typeof row.expectedSourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.expectedSourceFingerprint)
    || row.dueDate != null && !isValidLocalDateKey(row.dueDate)
    || row.note != null && (typeof row.note !== 'string' || row.note.length > 2000)) return invalid('请保留准确来源指纹及原请求键；佣金金额、率和付款方只能取批准原件。');
  return { orderId, requestKey: row.requestKey, expectedSourceFingerprint: row.expectedSourceFingerprint,
    dueDate: typeof row.dueDate === 'string' ? row.dueDate : null, note: typeof row.note === 'string' ? row.note : null };
}
async function originalSettlement(tx: Prisma.TransactionClient, actor: TokenPayload, orderId: string) {
  await authorizedDocumentOrders(tx, actor, [orderId]);
  const audit = await tx.auditLog.findUnique({ where: { id: commissionSettlementId(orderId) } });
  if (!audit) return null;
  const receipt = commissionObject(commissionObject(audit.detail).receipt);
  if (!Array.isArray(receipt.documents) || !receipt.documents.length) return conflict('原佣金结算回执不完整，请核对原件。');
  const documents = [];
  for (const row of receipt.documents) {
    const item = commissionObject(row);
    if (typeof item.documentId !== 'string') return conflict('原佣金结算单据标识不完整。');
    documents.push(await readFabricCommissionOriginal(tx, item.documentId));
  }
  if (documents.some(item => item.snapshot.source.orderId !== orderId)) return conflict('原佣金结算混入其他订单。');
  return { receipt: documents[0].receipt, documents };
}

export async function getFabricCommissionSettlement(prisma: PrismaClient, prior: Actor, orderId: string) {
  return prisma.$transaction(async tx => {
    const actor = await currentDocumentActor(tx, prior, ['orders:read']);
    const existing = await originalSettlement(tx, actor, orderId);
    if (existing) return { ...existing, settled: true };
    const source = await currentFabricCommissionSource(tx, actor, orderId);
    return { source, sourceFingerprint: source.sourceFingerprint, settled: false };
  });
}

/** One actual whole-order settlement, producing one CI for each real payer.
 * An original ACK is a historical receipt, not renewed shipment eligibility. */
export async function settleFabricCommission(prisma: PrismaClient, prior: Actor, orderId: string, input: unknown) {
  const commandInput = settlementInput(input, orderId);
  return prisma.$transaction(async tx => {
    let actor = await currentDocumentActor(tx, prior, ['orders:read']);
    const command = await beginFinanceCommand(tx, actor, 'fabric_commission.settle', commandInput);
    if (command.replayed) {
      const original = await originalSettlement(tx, actor, orderId);
      if (!original || original.receipt.sourceFingerprint !== commandInput.expectedSourceFingerprint) return conflict('原佣金回执与当前请求内容不一致。');
      await authorizedDocumentOrders(tx, await currentDocumentActor(tx, prior, ['orders:read']), [orderId]);
      return { ...command.receipt, replayed: true };
    }
    actor = await currentDocumentActor(tx, prior, ['orders:write', 'orders:read', 'shipments:read']);
    // Unique order-event lock prevents two independent keys creating two
    // settlement events. Canonical source locks then follow native ship order.
    const eventId = commissionSettlementId(orderId);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${eventId}, 0))::text AS "lock"`);
    if (await originalSettlement(tx, actor, orderId)) return conflict('本订单已完成唯一佣金结算，请读取原票或核对原请求，不能重新开佣金。');
    await lockFabricCommissionSourcesInTx(tx, actor, orderId);
    actor = await currentDocumentActor(tx, prior, ['orders:write', 'orders:read', 'shipments:read']);
    const source = await currentFabricCommissionSource(tx, actor, orderId);
    if (source.sourceFingerprint !== commandInput.expectedSourceFingerprint) return conflict('佣金的准确批准或实际出运来源已变化，请重新核对。');
    const exporterSnapshot = json(await currentExporterProfileSnapshot(tx as PrismaClient));
    const issueDate = todayLocalKey(), issuedAt = String(businessNowMs()), now = BigInt(Date.now());
    const documents = [], receiptDocuments: FabricCommissionSettlementReceipt['documents'] = [];
    for (const group of source.groups) {
      const documentId = `TD_${randomUUID()}`, versionId = `DVER__${randomUUID()}`;
      const documentNumber = await nextBusinessNumber(tx, 'CI', undefined, { occupied: async number => !!await tx.tradeDocument.findFirst({ where: { documentNumber: number }, select: { id: true } }) });
      const snapshot: FabricCommissionIssuedSnapshot = { schemaVersion: 1, sourceType: FABRIC_COMMISSION_SOURCE,
        settlementId: eventId, source, supplierId: group.supplierId, issueDate, dueDate: commandInput.dueDate, issuedAt,
        issuedBy: actor.userId, exporterSnapshot };
      const document = await tx.tradeDocument.create({ data: { id: documentId, documentNumber, domain: 'finance', type: 'CommercialInvoice', status: 'Issued',
        orderId, relationId: group.supplierId, sourceRef: `${FABRIC_COMMISSION_PREFIX}${orderId}:${group.supplierId}`, issueDate,
        issuedBy: actor.userId, totalAmount: new Prisma.Decimal(group.commissionAmount), currency: source.currency,
        notes: commandInput.note, createdAt: now, updatedAt: now } });
      const version = await tx.documentVersion.create({ data: { id: versionId, documentId, version: 1,
        content: json({ fabricCommissionSnapshot: snapshot }), changedBy: actor.userId, changeReason: '全单实际出运后一次佣金结算签发', createdAt: now } });
      receiptDocuments.push({ supplierId: group.supplierId, documentId, versionId, documentNumber, amount: group.commissionAmount, currency: source.currency });
      documents.push({ document, version, snapshot });
    }
    const receipt: FabricCommissionSettlementReceipt = { settlementId: eventId, orderId, sourceFingerprint: source.sourceFingerprint,
      documents: receiptDocuments, auditId: eventId, requestKey: String(commandInput.requestKey) };
    await authorizedDocumentOrders(tx, await currentDocumentActor(tx, prior, ['orders:write', 'orders:read', 'shipments:read']), [orderId]);
    await tx.auditLog.create({ data: { id: eventId, actorId: actor.userId, action: FABRIC_COMMISSION_SETTLED, targetType: 'Order', targetId: orderId,
      transactionId: String(commandInput.requestKey), detail: json({ source, receipt, commandInput, occurredAt: issuedAt }) } });
    for (const doc of documents) await readFabricCommissionOriginal(tx, doc.document.id);
    return command.commit({ receipt, documents, auditId: eventId, replayed: false });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
}

function registerInput(value: unknown, documentId: string) {
  const row = commissionObject(value);
  if (Object.keys(row).some(k => !['requestKey', 'expectedVersionId', 'expectedSourceFingerprint'].includes(k))
    || typeof row.expectedVersionId !== 'string' || !row.expectedVersionId
    || typeof row.expectedSourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.expectedSourceFingerprint))
    return invalid('请保留已核对佣金原票的准确版本、来源指纹及请求键。');
  return { documentId, requestKey: row.requestKey, expectedVersionId: row.expectedVersionId, expectedSourceFingerprint: row.expectedSourceFingerprint };
}
export async function getFabricCommissionDocument(prisma: PrismaClient, prior: Actor, documentId: string) {
  return prisma.$transaction(async tx => {
    const access = await createFinanceSourceAccess(tx, prior, ['invoices:read']);
    const original = await readFabricCommissionOriginal(tx, documentId);
    if (!await access.order(original.snapshot.source.orderId)) invisible();
    const invoice = await tx.invoice.findFirst({ where: { sourceType: FABRIC_COMMISSION_SOURCE, sourceId: original.version.id, deletedAt: null } });
    if (invoice && !await access.invoice(invoice)) invisible();
    await access.finish();
    return { ...original, invoice };
  });
}
export async function listPendingFabricCommissionReceivables(prisma: PrismaClient, prior: Actor) {
  return prisma.$transaction(async tx => {
    const access = await createFinanceSourceAccess(tx, prior, ['invoices:read']);
    const docs = await tx.tradeDocument.findMany({ where: { domain: 'finance', type: 'CommercialInvoice', status: 'Issued', deletedAt: null,
      sourceRef: { startsWith: FABRIC_COMMISSION_PREFIX } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const items = [];
    for (const document of docs) {
      if (!document.orderId || !await access.order(document.orderId)) continue;
      const original = await readFabricCommissionOriginal(tx, document.id);
      if (await tx.invoice.findFirst({ where: { sourceType: FABRIC_COMMISSION_SOURCE, sourceId: original.version.id } })) continue;
      items.push({ documentId: document.id, documentNumber: document.documentNumber, versionId: original.version.id,
        orderId: original.snapshot.source.orderId, orderNumber: original.snapshot.source.orderNumber, poNumber: original.snapshot.source.poNumber,
        supplierId: original.group.supplierId, supplierName: original.group.party.name, amount: original.group.commissionAmount,
        currency: original.snapshot.source.currency, issueDate: original.snapshot.issueDate, sourceFingerprint: original.snapshot.source.sourceFingerprint });
    }
    await access.finish(); return { items, total: items.length };
  });
}
export async function getFabricCommissionBusinessDocument(prisma: PrismaClient, prior: Actor, orderId: string, documentId: string) {
  return prisma.$transaction(async tx => {
    const actor = await currentDocumentActor(tx, prior, ['orders:read']);
    await authorizedDocumentOrders(tx, actor, [orderId]);
    const original = await readFabricCommissionOriginal(tx, documentId);
    if (original.snapshot.source.orderId !== orderId) invisible();
    await authorizedDocumentOrders(tx, await currentDocumentActor(tx, prior, ['orders:read']), [orderId]);
    return original;
  });
}
export async function registerFabricCommissionReceivable(prisma: PrismaClient, prior: Actor, documentId: string, input: unknown) {
  const commandInput = registerInput(input, documentId);
  return prisma.$transaction(async tx => {
    let access = await createFinanceSourceAccess(tx, prior, ['invoices:read']);
    const command = await beginFinanceCommand(tx, access.actor, 'fabric_commission.register', commandInput);
    const original = await readFabricCommissionOriginal(tx, documentId), source = original.snapshot.source;
    if (!await access.order(source.orderId)) invisible();
    if (original.version.id !== commandInput.expectedVersionId || source.sourceFingerprint !== commandInput.expectedSourceFingerprint)
      return conflict('佣金原票版本或来源与财务核对内容不一致。');
    if (command.replayed) {
      const verified = await readFabricCommissionInvoiceSource(tx, commandInput.expectedVersionId);
      if (!await access.invoice(verified.invoice)) invisible();
      await access.finish(); return { ...command.receipt, replayed: true };
    }
    access = await createFinanceSourceAccess(tx, prior, ['invoices:write']);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${source.orderId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${documentId} FOR UPDATE`);
    const locked = await readFabricCommissionOriginal(tx, documentId);
    if (!await access.order(source.orderId) || locked.version.id !== commandInput.expectedVersionId) invisible();
    const existing = await tx.invoice.findFirst({ where: { sourceType: FABRIC_COMMISSION_SOURCE, sourceId: locked.version.id } });
    if (existing) {
      const verified = await readFabricCommissionInvoiceSource(tx, locked.version.id);
      if (!await access.invoice(verified.invoice)) invisible();
      await access.finish(); return command.commit({ ...verified, replayed: true });
    }
    const now = BigInt(Date.now()), invoiceId = `INV__${randomUUID()}`, auditId = `fabric_commission_ar_${locked.version.id}`;
    const invoice = await tx.invoice.create({ data: { id: invoiceId, invoiceNumber: locked.document.documentNumber, type: 'Receivable', status: 'Issued',
      amount: new Prisma.Decimal(locked.group.commissionAmount), currency: source.currency, issueDate: locked.snapshot.issueDate,
      dueDate: locked.snapshot.dueDate, orderId: source.orderId, customerRelationId: locked.group.supplierId, customerName: locked.group.party.name,
      sourceType: FABRIC_COMMISSION_SOURCE, sourceId: locked.version.id, notes: '面料供应商向我方支付的佣金；客户货款直接支付供应商。',
      ownerId: access.actor.userId, createdAt: now, updatedAt: now } });
    await tx.invoiceOrderAllocation.create({ data: { id: `IOA_${randomUUID()}`, invoiceId, orderId: source.orderId,
      orderNumber: source.orderNumber, poNumber: source.poNumber, allocatedAmount: invoice.amount,
      note: '准确全单实际出运佣金原票', createdAt: now, updatedAt: now } });
    await tx.auditLog.create({ data: { id: auditId, actorId: access.actor.userId, action: FABRIC_COMMISSION_REGISTERED, targetType: 'Invoice', targetId: invoiceId,
      transactionId: String(commandInput.requestKey), detail: json({ documentId, versionId: locked.version.id, sourceFingerprint: source.sourceFingerprint,
        settlementId: locked.snapshot.settlementId, commandInput }) } });
    await syncInvoiceReferences(prisma, invoice, { source: 'finance:fabric-commission' }, tx);
    const verified = await readFabricCommissionInvoiceSource(tx, locked.version.id);
    if (!await access.invoice(invoice)) invisible();
    await access.finish();
    return command.commit({ ...verified, auditId, replayed: false });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
}
