/** Commercial invoices reference one actual financial Receivable. This module
 * produces TradeDocument/version/audit only, never financial facts or numbers. */
import { Prisma, PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { currentDocumentActor, authorizedDocumentOrders, documentDecimal, documentSourceJson, documentSourceFingerprint,
  shipmentDocumentSourceInTx, lockShipmentDocumentSourcesInTx, type ShipmentDocumentSource } from '../shipping/shipmentDocumentSource';
import { verifyFinancialShipmentSource } from '../shipping/shipmentFinancialAuthority';

/** Canonical Invoice.status, schema.prisma/Invoice + financial statusTransition.
 * Overdue is derived from dueDate/allocations, not another invoice status. */
export const FINAL_CI_INVOICE_STATUSES = Object.freeze(['Issued', 'PartiallyPaid', 'Paid'] as const);
function conflict(message: string): never { throw businessError('CONFLICT', message); }
function invisible(): never { throw businessError('NOT_FOUND', '原财务发票不存在或不可查看。'); }
const ids = (values: any[]): string[] => [...new Set<string>(values.filter((v): v is string => typeof v === 'string' && !!v))].sort();
export type CiInvoiceSource = {
  invoice: any; allocations: any[]; batches: any[]; orders: any[]; orderIds: string[];
  shipmentSources: ShipmentDocumentSource[]; requestedShipmentId: string | null;
  fingerprint: string; draft: boolean;
};
export interface CiInvoiceSourceOptions {
  trustedActor: TokenPayload | null;
  sourceInvoiceId?: string;
  shipmentId?: string;
  mode: 'preview' | 'render' | 'register';
  expectedSourceFingerprint?: string;
  expectedShipmentSourceFingerprint?: string;
}
const scopesFor = (options: CiInvoiceSourceOptions): ('invoices:read' | 'customs:write')[] =>
  options.mode === 'register' ? ['invoices:read', 'customs:write'] : ['invoices:read'];
async function invoiceScope(tx: any, actor: TokenPayload) {
  let failed = false;
  const strict = new Proxy(tx, { get(target, key) {
    if (key !== 'teamMember') return Reflect.get(target, key);
    if (!target.teamMember) { failed = true; throw Error('INVOICE_SCOPE_UNAVAILABLE'); }
    return new Proxy(target.teamMember, { get(delegate, method) {
      if (method !== 'findMany') return Reflect.get(delegate, method);
      return async (...args: any[]) => { try { return await delegate.findMany(...args); } catch (error) { failed = true; throw error; } };
    } });
  } });
  const resolver = await createPermissionService({ prisma: strict }).getDataScopeResolver(actor, 'finance');
  if (failed) throw businessError('AUTHORIZATION_UNAVAILABLE', '原发票可见范围暂时无法核验。');
  return buildScopeWhereFromResolver(resolver, actor.userId);
}
function assertInvoice(invoice: any, mode: CiInvoiceSourceOptions['mode']) {
  if (!invoice || invoice.deletedAt != null) invisible();
  if (invoice.type !== 'Receivable') conflict('商业发票必须引用原财务应收票；PI 与应付票不能替代。');
  const draft = mode === 'preview' && invoice.status === 'Draft';
  if (!draft && !(FINAL_CI_INVOICE_STATUSES as readonly string[]).includes(invoice.status)) conflict('原应收票尚未正式签发或已作废。');
  if (typeof invoice.invoiceNumber !== 'string' || !invoice.invoiceNumber.trim() || typeof invoice.currency !== 'string' || !invoice.currency.trim()) conflict('原财务票号或币种缺失。');
  const amount = documentDecimal(invoice.amount);
  if (amount === null || new Prisma.Decimal(amount).lt(0)) conflict('原财务发票金额无效。');
  return draft;
}
function coversWholeOrder(source: ShipmentDocumentSource, order: any): boolean {
  const original = order?.lines ?? [];
  if (!original.length) return false;
  return original.every((line: any) => {
    const quantity = documentDecimal(line.quantity);
    if (quantity === null || new Prisma.Decimal(quantity).lt(0)) return false;
    const shipped = source.lines.filter(row => row.orderLineId === line.id);
    return shipped.every(row => row.quantity !== null && row.unit === line.unit)
      && shipped.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)).equals(quantity);
  });
}
function checkCoverage(source: ShipmentDocumentSource, invoice: any, allocations: any[], batches: any[], orders: any[]) {
  if (source.kind === 'claim') conflict('售后补发不能借普通销售发票生成本票商业发票。');
  const activeIds = ids(source.lines.filter(row => row.quantity !== null && new Prisma.Decimal(row.quantity).gt(0)).map(row => row.orderId));
  if (!activeIds.length) conflict('本票没有稳定原订单行的实际货物范围。');
  for (const orderId of activeIds) {
    const matches = allocations.filter(row => row.orderId === orderId);
    if (!matches.length) conflict('原财务发票未覆盖本票全部实际订单。');
    // An Invoice can cover several actual shipment batches. At least one
    // original allocation must cover this ticket; other genuine batches stay
    // part of the same financial invoice, never an arbitrary first shipment.
    const covered = matches.some(allocation => {
      if (!allocation.batchId) return coversWholeOrder(source, orders.find(row => row.id === orderId));
      const batch = batches.find(row => row.id === allocation.batchId);
      return batch && batch.orderId === orderId && batch.shipmentId === source.shipment.id && batch.deletedAt == null && batch.status !== 'cancelled';
    });
    if (!covered) conflict('原财务发票未明确覆盖本票实际分批范围。');
    for (const allocation of matches.filter(row => row.batchId)) {
      const batch = batches.find(row => row.id === allocation.batchId);
      if (!batch || batch.currency !== invoice.currency || batch.customerRelationId && batch.customerRelationId !== invoice.customerRelationId)
        conflict('原发票出运批次客户或币种不一致。');
    }
  }
  for (const row of source.allocations.filter(row => row.status !== 'Cancelled' && row.actualQty != null && new Prisma.Decimal(row.actualQty).gt(0))) {
    if (!row.orderLineId) conflict('实际分配尚未细化到原订单行。');
    const lines = source.lines.filter(line => line.orderLineId === row.orderLineId);
    if (!lines.length || lines.some(line => line.quantity === null || line.unit !== row.unit)
      || !lines.reduce((sum, line) => sum.plus(line.quantity), new Prisma.Decimal(0)).equals(row.actualQty)) conflict('装运行未完整覆盖本票实际分配。');
  }
}
async function loadFixedInvoice(tx: any, invoiceId: string, options: CiInvoiceSourceOptions): Promise<CiInvoiceSource> {
  const actor = await currentDocumentActor(tx, options.trustedActor, scopesFor(options));
  const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, deletedAt: null, AND: [await invoiceScope(tx, actor)] } });
  const draft = assertInvoice(invoice, options.mode);
  const allocations = await tx.invoiceOrderAllocation.findMany({ where: { invoiceId, deletedAt: null }, orderBy: { id: 'asc' } });
  const batchIds = ids(allocations.map((row: any) => row.batchId));
  const batches = batchIds.length ? await tx.orderShipmentBatch.findMany({ where: { id: { in: batchIds } }, orderBy: { id: 'asc' } }) : [];
  if (batches.length !== batchIds.length || batches.some((batch: any) => batch.deletedAt != null || batch.status === 'cancelled'
    || !allocations.some((row: any) => row.batchId === batch.id && row.orderId === batch.orderId))) conflict('原发票分配批次已丢失或改绑。');
  const orderIds = ids([invoice.orderId, ...allocations.map((row: any) => row.orderId)]);
  if (orderIds.length) await currentDocumentActor(tx, options.trustedActor, ['orders:read', ...scopesFor(options)]);
  const orders = await authorizedDocumentOrders(tx, actor, orderIds);
  for (const order of orders) {
    if (invoice.customerRelationId && order.customerRelationId !== invoice.customerRelationId || order.currency && order.currency !== invoice.currency
      || !order.currency && order.salesCurrency && order.salesCurrency !== invoice.currency) conflict('原发票与真实订单客户或币种不一致。');
  }
  const shipmentIds = ids([options.shipmentId, ...batches.map((batch: any) => batch.shipmentId)]);
  const shipmentSources = await Promise.all(shipmentIds.map(id => shipmentDocumentSourceInTx(tx, id, { trustedActor: options.trustedActor,
    extraScopes: scopesFor(options), ...(id === options.shipmentId && options.expectedShipmentSourceFingerprint !== undefined
      ? { expectedSourceFingerprint: options.expectedShipmentSourceFingerprint } : {}) })));
  for (const batch of batches.filter((row: any) => row.status === 'shipped')) {
    const source = shipmentSources.find(row => row.shipment.id === batch.shipmentId);
    if (!source) conflict('原已出运批次缺少实际运单。');
    await verifyFinancialShipmentSource(tx, { ...source, actor, allocationFingerprint: source.allocationFingerprint }, batch.orderId);
  }
  if (options.shipmentId) checkCoverage(shipmentSources.find(source => source.shipment.id === options.shipmentId)!, invoice, allocations, batches, orders);
  const facts = { invoice: documentSourceJson(invoice), allocations: documentSourceJson(allocations), batches: documentSourceJson(batches),
    orders: documentSourceJson(orders), orderIds, shipmentSources, requestedShipmentId: options.shipmentId ?? null, draft };
  const source = { ...facts, fingerprint: documentSourceFingerprint(facts) };
  if (options.expectedSourceFingerprint !== undefined && source.fingerprint !== options.expectedSourceFingerprint) conflict('原财务发票来源已变化，请重新核对。');
  const finalActor = await currentDocumentActor(tx, options.trustedActor, scopesFor(options));
  if (!await tx.invoice.findFirst({ where: { id: invoiceId, deletedAt: null, AND: [await invoiceScope(tx, finalActor)] }, select: { id: true } })) invisible();
  await authorizedDocumentOrders(tx, finalActor, orderIds);
  await currentDocumentActor(tx, options.trustedActor, [...scopesFor(options), ...(orderIds.length ? ['orders:read' as const] : [])]);
  return source;
}
export async function resolveCiInvoiceSourceInTx(tx: any, options: CiInvoiceSourceOptions): Promise<CiInvoiceSource> {
  if (options.sourceInvoiceId !== undefined) {
    if (typeof options.sourceInvoiceId !== 'string' || !options.sourceInvoiceId.trim()) conflict('原发票标识无效。');
    return loadFixedInvoice(tx, options.sourceInvoiceId, options);
  }
  if (!options.shipmentId) conflict('请选择一张明确的原财务发票。');
  await currentDocumentActor(tx, options.trustedActor, scopesFor(options));
  const shipment = await shipmentDocumentSourceInTx(tx, options.shipmentId, { trustedActor: options.trustedActor, extraScopes: scopesFor(options),
    ...(options.expectedShipmentSourceFingerprint !== undefined ? { expectedSourceFingerprint: options.expectedShipmentSourceFingerprint } : {}) });
  const links = await tx.invoiceOrderAllocation.findMany({ where: { orderId: { in: shipment.orderIds }, deletedAt: null }, orderBy: { id: 'asc' } });
  const candidates: CiInvoiceSource[] = [];
  for (const id of ids(links.map((row: any) => row.invoiceId))) {
    try { candidates.push(await loadFixedInvoice(tx, id, options)); }
    catch (error) {
      // Ineligible candidates are not choices; dependency/authorization failures
      // never degrade into standalone numbering or a guessed latest invoice.
      if (!isBusinessError(error) || !['NOT_FOUND', 'CONFLICT'].includes(error.code)) throw error;
    }
  }
  if (candidates.length !== 1) conflict(candidates.length ? '存在多张合格原发票，请明确选择，不能自动取最新一张。' : '本票没有可核验的正式原财务发票。');
  return candidates[0];
}
export async function readCiInvoiceSource(prisma: PrismaClient, options: CiInvoiceSourceOptions): Promise<CiInvoiceSource> {
  return prisma.$transaction(tx => resolveCiInvoiceSourceInTx(tx, options), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function assertCanonicalCiDocumentInTx(tx: any, document: any, source: CiInvoiceSource, options: { allowLegacy?: boolean; historical?: boolean } = {}) {
  if (!document || document.deletedAt != null || document.type !== 'CommercialInvoice' || document.sourceInvoiceId !== source.invoice.id
    || document.documentNumber !== source.invoice.invoiceNumber || !options.historical && document.status === 'Cancelled') conflict('原商业发票记录来源已损坏或已作废，禁止另建替代。');
  const version = await tx.documentVersion.findFirst({ where: { documentId: document.id, version: 1 } });
  const receipt = version?.content?.ciSource;
  const audit = await tx.auditLog.findMany({ where: { transactionId: 'CI:' + document.id }, orderBy: { id: 'asc' } });
  // Historical linked CI has no new receipt. Read the actual original invoice
  // after current source authorization; never fabricate replacement history.
  // A partial new receipt/audit is corruption, not a historical compatibility case.
  if (!receipt && !audit.length && options.allowLegacy && version && !(version.content as any)?.ciSourceProtocol) return;
  if (!receipt || receipt.schemaVersion !== 1 || receipt.invoiceId !== source.invoice.id || receipt.invoiceNumber !== source.invoice.invoiceNumber
    || typeof receipt.sourceFingerprint !== 'string') conflict('原商业发票缺少完整的原财务来源凭据。');
  const snapshot = version.content?.ciSourceSnapshot;
  if (!snapshot || snapshot.invoice?.id !== receipt.invoiceId || snapshot.invoice?.invoiceNumber !== receipt.invoiceNumber
    || snapshot.fingerprint !== receipt.sourceFingerprint || documentSourceFingerprint(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'fingerprint'))) !== receipt.sourceFingerprint)
    conflict('原商业发票历史来源快照丢失或损坏。');
  if (audit.length !== 2 || !audit.some((row: any) => row.action === 'TRADE_DOCUMENT_CREATE' && row.targetId === document.id && row.detail?.ciSource
    && documentSourceFingerprint(row.detail.ciSource) === documentSourceFingerprint(receipt))
    || !audit.some((row: any) => row.action === 'DOCUMENT_VERSION_CREATE' && row.targetId === document.id && row.detail?.version === 1
      && row.detail?.sourceFingerprint === receipt.sourceFingerprint)) conflict('原商业发票创建审计或版本审计缺失。');
}
/** Lock actual source parents before financial Batch -> Invoice -> IOA -> CI.
 * Original financial source locks and mutation kernels remain unchanged. */
export async function registerCanonicalCiInTx(tx: any, options: CiInvoiceSourceOptions): Promise<{ document: any; created: boolean; source: CiInvoiceSource }> {
  if (options.mode !== 'register') conflict('草稿预览不能登记正式商业发票。');
  let source = await resolveCiInvoiceSourceInTx(tx, options);
  const fixed = { ...options, sourceInvoiceId: source.invoice.id };
  await lockShipmentDocumentSourcesInTx(tx, source.shipmentSources.map(row => row.shipment.id), { trustedActor: options.trustedActor,
    extraScopes: scopesFor(options) }, source.orderIds);
  const batchIds = ids(source.batches.map(row => row.id));
  if (batchIds.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderShipmentBatch" WHERE "id" IN (${Prisma.join(batchIds)}) ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "id"=${source.invoice.id} FOR UPDATE`);
  const allocationIds = ids(source.allocations.map(row => row.id));
  if (allocationIds.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InvoiceOrderAllocation" WHERE "id" IN (${Prisma.join(allocationIds)}) ORDER BY "id" FOR UPDATE`);
  const current = await resolveCiInvoiceSourceInTx(tx, fixed);
  if (current.fingerprint !== source.fingerprint) conflict('原财务发票、批次或真实货物在取得锁时变化。');
  source = current;
  const existing = await tx.tradeDocument.findMany({ where: { OR: [{ sourceInvoiceId: source.invoice.id }, { documentNumber: source.invoice.invoiceNumber }] }, orderBy: { id: 'asc' } });
  if (existing.length) {
    if (existing.length !== 1) conflict('原财务发票关联多个冲突单据，禁止猜测或重建。');
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${existing[0].id} FOR UPDATE`);
    const document = await tx.tradeDocument.findUnique({ where: { id: existing[0].id } });
    await assertCanonicalCiDocumentInTx(tx, document, source, { allowLegacy: true });
    const final = await resolveCiInvoiceSourceInTx(tx, fixed);
    if (final.fingerprint !== source.fingerprint) conflict('原商业发票读取来源已变化。');
    return { document, created: false, source: final };
  }
  const priorCreation = await tx.auditLog.findMany({ where: { action: 'TRADE_DOCUMENT_CREATE', detail: { path: ['ciSource', 'invoiceId'], equals: source.invoice.id } } });
  if (priorCreation.length) conflict('原商业发票记录丢失但原创建审计仍在，禁止补造替代。');
  const actor = await currentDocumentActor(tx, options.trustedActor, scopesFor(options)), ts = BigInt(Date.now());
  const receipt = { schemaVersion: 1, invoiceId: source.invoice.id, invoiceNumber: source.invoice.invoiceNumber,
    sourceFingerprint: source.fingerprint, requestedShipmentId: source.requestedShipmentId,
    shipmentIds: source.shipmentSources.map(row => row.shipment.id), orderIds: source.orderIds };
  const document = await tx.tradeDocument.create({ data: {
    id: 'TD_' + crypto.randomBytes(8).toString('hex'), type: 'CommercialInvoice', domain: 'customs', status: 'Draft',
    documentNumber: source.invoice.invoiceNumber, sourceInvoiceId: source.invoice.id, sourceRef: 'invoice:' + source.invoice.id,
    shipmentId: source.requestedShipmentId, orderId: source.invoice.orderId ?? null, relationId: source.invoice.customerRelationId ?? null,
    issueDate: source.invoice.issueDate ?? null, totalAmount: new Prisma.Decimal(source.invoice.amount), currency: source.invoice.currency,
    consignee: source.invoice.customerName ?? null, createdAt: ts, updatedAt: ts,
  } });
  await tx.documentVersion.create({ data: { id: 'DV_' + crypto.randomBytes(8).toString('hex'), documentId: document.id,
    version: 1, content: { ciSourceProtocol: 1, ciSource: receipt, ciSourceSnapshot: documentSourceJson(source) }, changedBy: actor.userId, changeReason: '原财务发票生成商业发票', createdAt: ts } });
  await tx.auditLog.create({ data: { id: 'AUD_' + crypto.randomBytes(8).toString('hex'), action: 'DOCUMENT_VERSION_CREATE',
    actorId: actor.userId, targetType: 'DocumentVersion', targetId: document.id, transactionId: 'CI:' + document.id,
    detail: { version: 1, sourceFingerprint: source.fingerprint } } });
  await tx.auditLog.create({ data: { id: 'AUD_' + crypto.randomBytes(8).toString('hex'), action: 'TRADE_DOCUMENT_CREATE',
    actorId: actor.userId, targetType: 'TradeDocument', targetId: document.id, transactionId: 'CI:' + document.id, detail: { ciSource: receipt } } });
  // Last read happens after every mandatory producer await; withdrawal throws
  // inside the same business transaction and rolls back all three native writes.
  const final = await resolveCiInvoiceSourceInTx(tx, fixed);
  if (final.fingerprint !== source.fingerprint) conflict('原财务发票或货物来源在登记时变化。');
  return { document, created: true, source: final };
}
export async function registerCanonicalCi(prisma: PrismaClient, options: CiInvoiceSourceOptions) {
  return prisma.$transaction(tx => registerCanonicalCiInTx(tx, options), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Public CI reads resolve the actual persisted record, not caller sourceRef.
 * A historical linked document remains readable under current native access;
 * malformed new provenance never degrades into legacy compatibility. */
export async function readAuthorizedCiDocumentInTx(tx: any, documentId: string, options: Omit<CiInvoiceSourceOptions, 'sourceInvoiceId' | 'shipmentId'>) {
  const document = await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
  if (!document || document.type !== 'CommercialInvoice') invisible();
  if (!document.sourceInvoiceId) conflict('历史商业发票没有原财务来源，仅可阅读历史版本，不能正式出单。');
  const source = await resolveCiInvoiceSourceInTx(tx, { ...options, sourceInvoiceId: document.sourceInvoiceId,
    ...(document.shipmentId ? { shipmentId: document.shipmentId } : {}) });
  const siblings = await tx.tradeDocument.findMany({ where: { OR: [{ sourceInvoiceId: source.invoice.id }, { documentNumber: source.invoice.invoiceNumber }] } });
  if (siblings.length !== 1 || siblings[0].id !== document.id) conflict('原财务发票的历史商业单据归属不唯一。');
  await assertCanonicalCiDocumentInTx(tx, document, source, { allowLegacy: true });
  await currentDocumentActor(tx, options.trustedActor, scopesFor(options));
  return { document, source };
}
export async function readAuthorizedCiDocument(prisma: PrismaClient, documentId: string, options: Omit<CiInvoiceSourceOptions, 'sourceInvoiceId' | 'shipmentId'>) {
  return prisma.$transaction(tx => readAuthorizedCiDocumentInTx(tx, documentId, options), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Selection GET contract: current authorized candidates, no latest heuristic,
 * no document/financial writes. Draft is labelled preview-only. Each exact
 * fingerprint binds later rendering/registration to this actual source read. */
export async function listCiInvoiceSourcesForShipment(prisma: PrismaClient, shipmentId: string, trustedActor: TokenPayload | null) {
  return prisma.$transaction(async tx => {
    const shipment = await shipmentDocumentSourceInTx(tx, shipmentId, { trustedActor, extraScopes: ['invoices:read'] });
    const links = await tx.invoiceOrderAllocation.findMany({ where: { orderId: { in: shipment.orderIds }, deletedAt: null }, orderBy: { id: 'asc' } });
    const candidates: Array<{ sourceInvoiceId: string; invoiceNumber: string; status: string; amount: string; currency: string;
      canRegister: boolean; expectedSourceFingerprint: string; orderIds: string[]; shipmentIds: string[] }> = [];
    for (const sourceInvoiceId of ids(links.map(row => row.invoiceId))) {
      try {
        const source = await resolveCiInvoiceSourceInTx(tx, { trustedActor, sourceInvoiceId, shipmentId, mode: 'preview', expectedShipmentSourceFingerprint: shipment.fingerprint });
        candidates.push({ sourceInvoiceId, invoiceNumber: source.invoice.invoiceNumber, status: source.invoice.status, amount: source.invoice.amount,
          currency: source.invoice.currency, canRegister: !source.draft, expectedSourceFingerprint: source.fingerprint,
          orderIds: source.orderIds, shipmentIds: source.shipmentSources.map(row => row.shipment.id) });
      } catch (error) { if (!isBusinessError(error) || !['NOT_FOUND', 'CONFLICT'].includes(error.code)) throw error; }
    }
    await shipmentDocumentSourceInTx(tx, shipmentId, { trustedActor, extraScopes: ['invoices:read'], expectedSourceFingerprint: shipment.fingerprint });
    const finalActor = await currentDocumentActor(tx, trustedActor, ['invoices:read']);
    for (const candidate of candidates) candidate.canRegister = candidate.canRegister && hasScope(finalActor, 'customs:write');
    return { schemaVersion: 1, shipmentId, expectedShipmentSourceFingerprint: shipment.fingerprint, orderIds: shipment.orderIds, candidates };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export interface HistoricalCiSourceOptions { trustedActor: TokenPayload | null; version?: number; additionalSnapshots?: CiInvoiceSource[]; }
export type HistoricalCiDocumentSource = { document: any; version: any; originalVersion: any; currentInvoice: any | null;
  sourceSnapshot: CiInvoiceSource | null; documentSet: any | null; orderIds: string[]; fingerprint: string };
function historicalIds(document: any, version: any, original: any, extra: CiInvoiceSource[] = []): { orderIds: string[]; shipmentIds: string[]; orderLineIds: string[]; productionBatchIds: string[] } {
  const contents = [version?.content, original?.content, ...extra.map(ciSourceSnapshot => ({ ciSourceSnapshot }))].filter(Boolean);
  const snapshots = contents.map(content => content.ciSourceSnapshot).filter(Boolean), sets = contents.map(content => content.documentSet).filter(Boolean);
  const receipts = contents.map(content => content.ciSource).filter(Boolean);
  return { orderIds: ids([document.orderId, ...contents.map(content => content.orderId), ...receipts.flatMap(receipt => receipt.orderIds ?? []),
      ...snapshots.flatMap(snapshot => snapshot.orderIds ?? []), ...sets.flatMap(set => [set.order?.id, ...(set.orders ?? []).map((row: any) => row.id), ...(set.source?.orderIds ?? []), ...(set.lines ?? []).map((row: any) => row.orderId)])]),
    shipmentIds: ids([document.shipmentId, ...receipts.flatMap(receipt => [receipt.requestedShipmentId, ...(receipt.shipmentIds ?? [])]),
      ...snapshots.flatMap(snapshot => (snapshot.shipmentSources ?? []).map((source: any) => source.shipment?.id)), ...sets.map(set => set.shipment?.id)]),
    orderLineIds: ids([...snapshots.flatMap(snapshot => (snapshot.shipmentSources ?? []).flatMap((source: any) => (source.lines ?? []).map((line: any) => line.orderLineId))),
      ...sets.flatMap(set => (set.lines ?? []).map((line: any) => line.orderLineId))]),
    productionBatchIds: ids(snapshots.flatMap(snapshot => (snapshot.shipmentSources ?? []).flatMap((source: any) => (source.physical ?? []).map((row: any) => row.productionBatchId)))) };
}
/** Existing archives are historical facts. Current source cancellation/revision
 * cannot replace their original snapshot. Authority remains current, with all
 * identifiable original and current native source parents under original L2. */
export async function readHistoricalCiDocumentInTx(tx: any, documentId: string, options: HistoricalCiSourceOptions): Promise<HistoricalCiDocumentSource> {
  const document = await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
  if (!document || document.type !== 'CommercialInvoice') invisible();
  const [originalVersion, version] = await Promise.all([
    tx.documentVersion.findFirst({ where: { documentId, version: 1 } }),
    tx.documentVersion.findFirst({ where: { documentId, ...(options.version !== undefined ? { version: options.version } : {}) }, orderBy: { version: 'desc' } }),
  ]);
  if (!originalVersion || !version) conflict('原商业发票历史版本丢失，不能补造历史。');
  const scopes = ['customs:read' as const, ...(document.sourceInvoiceId ? ['invoices:read' as const] : [])];
  let actor = await currentDocumentActor(tx, options.trustedActor, scopes), currentInvoice: any = null;
  if (document.sourceInvoiceId) {
    currentInvoice = await tx.invoice.findFirst({ where: { id: document.sourceInvoiceId, deletedAt: null, AND: [await invoiceScope(tx, actor)] } });
    if (!currentInvoice) invisible();
    if (currentInvoice.type !== 'Receivable') conflict('历史商业发票回链不属于原财务应收票。');
    // The original number belongs to this immutable document history. A later
    // cancellation never makes it a new official invoice or creates new facts.
    await assertCanonicalCiDocumentInTx(tx, document, { invoice: { id: currentInvoice.id, invoiceNumber: document.documentNumber } } as CiInvoiceSource,
      { allowLegacy: true, historical: true });
  } else {
    const native = await tx.auditLog.findMany({ where: { transactionId: 'CI:' + document.id } });
    if (originalVersion.content?.ciSourceProtocol || originalVersion.content?.ciSource || native.length) conflict('原回链凭据损坏，不能降级为无源历史单据。');
  }
  const links = currentInvoice ? await tx.invoiceOrderAllocation.findMany({ where: { invoiceId: currentInvoice.id, deletedAt: null } }) : [];
  const identities = historicalIds(document, version, originalVersion, options.additionalSnapshots);
  const [shipments, orderLines, batches] = await Promise.all([
    identities.shipmentIds.length ? tx.shipment.findMany({ where: { id: { in: identities.shipmentIds } } }) : [],
    identities.orderLineIds.length ? tx.orderLine.findMany({ where: { id: { in: identities.orderLineIds } } }) : [],
    identities.productionBatchIds.length ? tx.productionBatch.findMany({ where: { id: { in: identities.productionBatchIds } } }) : [],
  ]);
  const allocations = identities.shipmentIds.length ? await tx.shipmentOrderAllocation.findMany({ where: { shipmentId: { in: identities.shipmentIds } } }) : [];
  const orderIds = ids([...identities.orderIds, currentInvoice?.orderId, ...links.map((row: any) => row.orderId), ...shipments.map((row: any) => row.orderId),
    ...allocations.map((row: any) => row.orderId), ...orderLines.map((row: any) => row.orderId), ...batches.map((row: any) => row.orderId)]);
  const finalScopes = [...scopes, ...(identities.shipmentIds.length ? ['shipments:read' as const] : []), ...(orderIds.length ? ['orders:read' as const] : [])];
  actor = await currentDocumentActor(tx, options.trustedActor, finalScopes);
  await authorizedDocumentOrders(tx, actor, orderIds);
  const original = documentSourceJson(originalVersion), selected = documentSourceJson(version);
  if (original.content?.ciSourceProtocol && selected.content?.ciSourceSnapshot
    && documentSourceFingerprint(selected.content.ciSourceSnapshot) !== documentSourceFingerprint(original.content.ciSourceSnapshot))
    conflict('选定历史版本不是原受控财务来源快照，不能冒充原票事实。');
  const facts = { document: documentSourceJson(document), version: selected, originalVersion: original };
  // Check immutable version/proof again after all reads; do not authorize from a
  // cache or use a changed snapshot if source withdrawal races this read.
  const finalVersion = await tx.documentVersion.findFirst({ where: { documentId, version: version.version } });
  const finalOriginal = await tx.documentVersion.findFirst({ where: { documentId, version: 1 } });
  const finalDocument = await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
  if (!finalDocument || documentSourceFingerprint(finalDocument) !== documentSourceFingerprint(document)
    || documentSourceFingerprint(finalOriginal) !== documentSourceFingerprint(originalVersion)) conflict('原归档单据或来源凭据在读取时变化。');
  if (documentSourceFingerprint(finalVersion) !== documentSourceFingerprint(version)) conflict('原历史版本在读取时变化。');
  actor = await currentDocumentActor(tx, options.trustedActor, finalScopes);
  if (currentInvoice) {
    const finalInvoice = await tx.invoice.findFirst({ where: { id: currentInvoice.id, deletedAt: null, AND: [await invoiceScope(tx, actor)] } });
    if (!finalInvoice) invisible();
    currentInvoice = finalInvoice;
    await assertCanonicalCiDocumentInTx(tx, document, { invoice: { id: currentInvoice.id, invoiceNumber: document.documentNumber } } as CiInvoiceSource, { allowLegacy: true, historical: true });
  }
  await authorizedDocumentOrders(tx, actor, orderIds);
  await currentDocumentActor(tx, options.trustedActor, finalScopes);
  return { ...facts, currentInvoice: documentSourceJson(currentInvoice), sourceSnapshot: selected.content?.ciSourceSnapshot ?? original.content?.ciSourceSnapshot ?? null,
    documentSet: selected.content?.documentSet ?? null, orderIds, fingerprint: documentSourceFingerprint(facts) };
}
export async function readHistoricalCiDocument(prisma: PrismaClient, documentId: string, options: HistoricalCiSourceOptions) {
  return prisma.$transaction(tx => readHistoricalCiDocumentInTx(tx, documentId, options), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
