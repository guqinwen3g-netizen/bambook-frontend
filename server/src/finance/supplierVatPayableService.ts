import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { supplierFingerprint, supplierJson, supplierObject } from '../procurement/supplierContractPolicy';
import { businessError } from '../shared/errorCodes';
import { syncInvoiceReferences, syncVatInvoiceReferences } from '../entities/sync';
import { createFinanceSourceAccess } from './financeSourceAccess';
import { beginFinanceCommand, assertFinanceRevision } from './financeCommandReceipt';
import { SUPPLIER_VAT_PAYABLE_SOURCE, SUPPLIER_VAT_PAYABLE_ACTION, normalizeSupplierVatSelection, supplierVatOriginal,
  assertSupplierVatAmounts, assertSupplierVatCapacity, readSupplierVatApprovedLine, makeSupplierVatSnapshot,
  supplierVatLineIdentity, supplierVatPayableAuditId, readSupplierVatPayableSource, supplierVatAuthorizationOrderIds,
  type SupplierVatSelection, type SupplierVatPayableSnapshot, type SupplierVatPayableReceipt } from './supplierVatPayableSource';
import { readSupplierVatRegistrations } from './supplierVatPayableCapacity';
export { listSupplierVatPayableSources } from './supplierVatPayableCandidates';

type Actor = TokenPayload | null | undefined;
type Access = Awaited<ReturnType<typeof createFinanceSourceAccess>>;
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
const invisible = (): never => { throw businessError('NOT_FOUND', '供应商原票或准确合同不在当前财务数据范围。'); };
async function authorizeSnapshot(access: Access, snapshot: SupplierVatPayableSnapshot) {
  for (const id of supplierVatAuthorizationOrderIds(snapshot)) if (!await access.order(id)) invisible();
}
async function currentSource(tx: Prisma.TransactionClient, access: Access, vatInvoiceId: string, selection: SupplierVatSelection) {
  const vat = await tx.vatInvoice.findFirst({ where: { id: vatInvoiceId, deletedAt: null } });
  if (!vat || !await access.vat(vat)) return invisible();
  if (!['Received', 'Verified', 'Declared'].includes(vat.status)) return conflict('原票已作废或红冲；请核对原票与独立账款冲销依据，不得当作新的应付。');
  const original = supplierVatOriginal(vat);
  assertSupplierVatAmounts(original, selection);
  const sources = [];
  for (const selected of selection.sources) sources.push(await readSupplierVatApprovedLine(tx, selected, {
    current: true, supplierId: original.relationId, currency: original.currency }));
  const snapshot = makeSupplierVatSnapshot(original, selection, sources);
  if (original.orderId && !snapshot.orderIds.includes(original.orderId)) return conflict('原票所列订单不在本次准确合同行来源内。');
  await authorizeSnapshot(access, snapshot);
  const supplier = await tx.relation.findFirst({ where: { id: original.relationId, deletedAt: null, isOrganization: true, category: 'Supplier' } });
  if (!supplier) return conflict('原票供应商身份无效。');
  const partyNames = new Set([supplier.name, supplier.chineseName, supplier.englishName].filter(Boolean));
  for (const source of sources) {
    const party = supplierObject(supplierObject(source.commitmentSnapshot).supplierParty);
    for (const value of [party.name, party.chineseName, party.englishName]) if (typeof value === 'string' && value) partyNames.add(value);
    if (original.sellerTaxNo && typeof party.taxId === 'string' && party.taxId && original.sellerTaxNo !== party.taxId)
      return conflict('原票销方税号与准确已批准供应商不一致。');
  }
  if (!partyNames.has(original.sellerName)) return conflict('原票销方名称与准确供应商身份不一致，请先核对原票。');
  return { vatInvoice: vat, snapshot };
}
async function capacities(tx: Prisma.TransactionClient, snapshot: SupplierVatPayableSnapshot) {
  const prior = await readSupplierVatRegistrations(tx, new Set(snapshot.sources.map(supplierVatLineIdentity)));
  return snapshot.sources.map(line => ({ contractKind: line.contractKind, contractId: line.contractId, lineId: line.lineId,
    commitmentRevisionId: line.commitmentRevisionId, approvedLineAmount: line.approvedLineAmount,
    ...assertSupplierVatCapacity(line.approvedLineAmount, line.contractAmount, snapshot.amountBasis, prior.get(supplierVatLineIdentity(line)) ?? []) }));
}

export async function previewSupplierVatPayable(prisma: PrismaClient, prior: Actor, vatInvoiceId: string, input: unknown) {
  const selection = normalizeSupplierVatSelection(input);
  return prisma.$transaction(async tx => {
    const access = await createFinanceSourceAccess(tx, prior, ['invoices:read', 'vat:read']);
    const source = await currentSource(tx, access, vatInvoiceId, selection);
    if (source.vatInvoice.invoiceId) return conflict('本原票已经登记应付，请读取原应付及原回执。');
    const available = await capacities(tx, source.snapshot);
    await access.finish();
    return { snapshot: source.snapshot, sourceFingerprint: source.snapshot.sourceFingerprint,
      vatUpdatedAt: String(source.vatInvoice.updatedAt), capacities: available };
  });
}

function registerCommand(input: unknown, vatInvoiceId: string) {
  const row = supplierObject(input);
  if (Object.keys(row).some(key => !['amountBasis', 'dueDate', 'sources', 'requestKey', 'expectedVatUpdatedAt', 'expectedSourceFingerprint'].includes(key)))
    throw businessError('INVALID_INPUT', '应付登记含不支持的字段。');
  const selection = normalizeSupplierVatSelection({ amountBasis: row.amountBasis, dueDate: row.dueDate, sources: row.sources });
  if (typeof row.expectedVatUpdatedAt !== 'string' || !/^\d+$/.test(row.expectedVatUpdatedAt)
    || typeof row.expectedSourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.expectedSourceFingerprint))
    throw businessError('INVALID_INPUT', '请保留已核对的原票版本及准确来源指纹。');
  return { vatInvoiceId, ...selection, requestKey: row.requestKey, expectedVatUpdatedAt: row.expectedVatUpdatedAt,
    expectedSourceFingerprint: row.expectedSourceFingerprint };
}
const selectionOf = (snapshot: SupplierVatPayableSnapshot): SupplierVatSelection => ({ amountBasis: snapshot.amountBasis, dueDate: snapshot.dueDate,
  sources: snapshot.sources.map(({ contractKind, contractId, commitmentRevisionId, lineId, contractAmount }) => ({ contractKind, contractId, commitmentRevisionId, lineId, contractAmount })) });

export async function registerSupplierVatPayable(prisma: PrismaClient, prior: Actor, vatInvoiceId: string, input: unknown) {
  const commandInput = registerCommand(input, vatInvoiceId);
  return prisma.$transaction(async tx => {
    let access = await createFinanceSourceAccess(tx, prior, ['invoices:write', 'vat:read']);
    const command = await beginFinanceCommand(tx, access.actor, 'supplier_vat_payable.register', commandInput);
    if (command.replayed) {
      const original = await readSupplierVatPayableSource(tx, vatInvoiceId);
      await authorizeSnapshot(access, original.snapshot);
      if (!await access.invoice(original.invoice)) invisible();
      await access.finish();
      return { ...command.receipt, replayed: true };
    }
    const already = await tx.invoice.findFirst({ where: { sourceType: SUPPLIER_VAT_PAYABLE_SOURCE, sourceId: vatInvoiceId } });
    if (already) {
      const original = await readSupplierVatPayableSource(tx, vatInvoiceId);
      await authorizeSnapshot(access, original.snapshot);
      if (!await access.invoice(original.invoice)) invisible();
      if (supplierFingerprint(selectionOf(original.snapshot)) !== supplierFingerprint({ amountBasis: commandInput.amountBasis,
        dueDate: commandInput.dueDate, sources: commandInput.sources }) || commandInput.expectedSourceFingerprint !== original.snapshot.sourceFingerprint)
        return conflict('同一供应商原票已登记另一准确来源内容，请核对原应付，不能重复登记。');
      await access.finish();
      return command.commit({ ...original, replayed: true });
    }
    const initial = await currentSource(tx, access, vatInvoiceId, commandInput);
    // Supplier commitments lock source orders before vendor contracts. Match
    // that order and lock all shared contract parents before cumulative reads.
    for (const id of supplierVatAuthorizationOrderIds(initial.snapshot))
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${id} FOR SHARE`);
    const lines = [...new Set(initial.snapshot.sources.flatMap(source => {
      const proofs = supplierObject(source.commitmentSnapshot).sourceProofs;
      return Array.isArray(proofs) ? proofs.map(value => String(supplierObject(value).orderLineId)) : [];
    }))].sort();
    for (const id of lines) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "id"=${id} FOR SHARE`);
    const contracts = [...new Map(initial.snapshot.sources.map(source => [`${source.contractKind}:${source.contractId}`, source])).values()]
      .sort((a, b) => `${a.contractKind}:${a.contractId}`.localeCompare(`${b.contractKind}:${b.contractId}`));
    for (const source of contracts) {
      if (source.contractKind === 'purchase') await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseOrder" WHERE "id"=${source.contractId} FOR UPDATE`);
      else await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OutsourcingOrder" WHERE "id"=${source.contractId} FOR UPDATE`);
    }
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "VatInvoice" WHERE "id"=${vatInvoiceId} FOR UPDATE`);
    access = await createFinanceSourceAccess(tx, prior, ['invoices:write', 'vat:read']);
    const source = await currentSource(tx, access, vatInvoiceId, commandInput);
    if (source.vatInvoice.invoiceId || await tx.invoice.findFirst({ where: { sourceType: SUPPLIER_VAT_PAYABLE_SOURCE, sourceId: vatInvoiceId } }))
      return conflict('原票在核验期间已登记，请以原请求核对结果。');
    assertFinanceRevision(source.vatInvoice, commandInput.expectedVatUpdatedAt);
    if (source.snapshot.sourceFingerprint !== commandInput.expectedSourceFingerprint) return conflict('原票或准确已批来源内容已经变化，请重新核对。');
    await capacities(tx, source.snapshot);
    const original = source.snapshot.vatOriginal, now = BigInt(Date.now()), invoiceId = `INV__${randomUUID()}`;
    const invoice = await tx.invoice.create({ data: { id: invoiceId, invoiceNumber: `SVAT-${vatInvoiceId}`, type: 'Payable', status: 'Issued',
      amount: new Prisma.Decimal(original.totalAmount), currency: original.currency, issueDate: original.issueDate, dueDate: source.snapshot.dueDate,
      orderId: source.snapshot.orderIds.length === 1 ? source.snapshot.orderIds[0] : null,
      customerRelationId: original.relationId, customerName: original.sellerName, sourceType: SUPPLIER_VAT_PAYABLE_SOURCE, sourceId: vatInvoiceId,
      notes: `供应商原票 ${original.vatCode ? `${original.vatCode}/` : ''}${original.vatNumber}；原票与合同依据见准确来源快照。`,
      ownerId: access.actor.userId, createdAt: now, updatedAt: now } });
    // Net-price contracts do not provide a defensible gross allocation across
    // several customer orders. Keep that unknown rather than apportioning tax.
    for (const orderId of source.snapshot.orderIds) {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      const amount = source.snapshot.orderIds.length === 1 ? new Prisma.Decimal(original.totalAmount)
        : source.snapshot.amountBasis === 'gross' ? source.snapshot.sources.filter(line => line.orderId === orderId)
          .reduce((sum, line) => sum.plus(line.contractAmount), new Prisma.Decimal(0)) : null;
      await tx.invoiceOrderAllocation.create({ data: { id: `IOA_${randomUUID()}`, invoiceId, orderId,
        orderNumber: order?.code ?? null, poNumber: order?.poNumber ?? null, allocatedAmount: amount,
        note: amount == null ? '净价合同未提供逐订单含税分摊；保持未知。' : '按本票准确来源金额登记。', createdAt: now, updatedAt: now } });
    }
    const vatInvoice = await tx.vatInvoice.update({ where: { id: vatInvoiceId }, data: { invoiceId, updatedAt: now } });
    const auditId = supplierVatPayableAuditId(vatInvoiceId);
    const receipt: SupplierVatPayableReceipt = { operation: SUPPLIER_VAT_PAYABLE_ACTION, actorId: access.actor.userId,
      requestKey: String(commandInput.requestKey), vatInvoiceId, invoiceId, auditId, sourceFingerprint: source.snapshot.sourceFingerprint,
      commandHash: supplierFingerprint(commandInput) };
    await tx.auditLog.create({ data: { id: auditId, actorId: access.actor.userId, action: SUPPLIER_VAT_PAYABLE_ACTION, targetType: 'Invoice',
      targetId: invoiceId, transactionId: String(commandInput.requestKey), detail: supplierJson({ source: 'finance:supplier-vat-payable',
        receipt, snapshot: source.snapshot, commandInput }) } });
    await syncInvoiceReferences(prisma, invoice, { source: 'finance:supplier-vat-payable' }, tx);
    await syncVatInvoiceReferences(prisma, vatInvoice, { source: 'finance:supplier-vat-payable' }, tx);
    await readSupplierVatPayableSource(tx, vatInvoiceId);
    if (!await access.invoice(invoice)) invisible();
    await access.finish();
    return command.commit({ invoice, vatInvoice, snapshot: source.snapshot, receipt, auditId, replayed: false });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
}

export async function getSupplierVatPayable(prisma: PrismaClient, prior: Actor, vatInvoiceId: string) {
  return prisma.$transaction(async tx => {
    const access = await createFinanceSourceAccess(tx, prior, ['invoices:read', 'vat:read']);
    const original = await readSupplierVatPayableSource(tx, vatInvoiceId);
    await authorizeSnapshot(access, original.snapshot);
    if (!await access.invoice(original.invoice) || !await access.vat(original.vatInvoice)) invisible();
    await access.finish();
    return original;
  });
}
