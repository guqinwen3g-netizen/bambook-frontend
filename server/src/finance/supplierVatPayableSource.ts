import { Prisma } from '@prisma/client';
import { businessError } from '../shared/errorCodes';
import { supplierFingerprint, supplierJson, supplierObject } from '../procurement/supplierContractPolicy';
import { supplierSnapshot } from '../procurement/supplierContractStore';
import { isValidLocalDateKey } from '../shared/localDate';

export const SUPPLIER_VAT_PAYABLE_SOURCE = 'SupplierVatPayable';
export const SUPPLIER_VAT_PAYABLE_ACTION = 'register_supplier_vat_payable';
export type SupplierVatAmountBasis = 'net' | 'gross';
export type SupplierVatSelectedLine = { contractKind: 'purchase' | 'processing'; contractId: string; commitmentRevisionId: string; lineId: string; contractAmount: string };
export type SupplierVatSelection = { amountBasis: SupplierVatAmountBasis; dueDate: string | null; sources: SupplierVatSelectedLine[] };
export type SupplierVatOriginal = { id: string; vatCode: string | null; vatNumber: string; direction: 'Input'; invoiceType: string;
  relationId: string; sellerName: string; sellerTaxNo: string | null; buyerName: string; buyerTaxNo: string | null;
  issueDate: string; netAmount: string; taxRate: string; taxAmount: string; totalAmount: string; currency: string;
  orderId: string | null; attachments: Prisma.InputJsonValue | null };
export type SupplierVatSourceLine = SupplierVatSelectedLine & { contractNumber: string; orderId: string; orderLineId: string;
  approvedLineAmount: string; paymentTerms: string | null; approvalId: string; approvalAuditId: string;
  commitmentFingerprint: string; commitmentSnapshot: Prisma.InputJsonValue };
export type SupplierVatPayableSnapshot = { schemaVersion: 1; sourceType: typeof SUPPLIER_VAT_PAYABLE_SOURCE;
  vatOriginal: SupplierVatOriginal; amountBasis: SupplierVatAmountBasis; dueDate: string | null;
  sources: SupplierVatSourceLine[]; orderIds: string[]; sourceFingerprint: string };
export type SupplierVatPayableReceipt = { operation: typeof SUPPLIER_VAT_PAYABLE_ACTION; actorId: string; requestKey: string;
  vatInvoiceId: string; invoiceId: string; auditId: string; sourceFingerprint: string; commandHash: string };
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
const invalid = (message: string): never => { throw businessError('INVALID_INPUT', message); };
const text = (value: unknown, label: string): string => typeof value === 'string' && value.trim() && value.trim().length <= 200
  ? value.trim() : invalid(`请明确${label}。`);
const optionalText = (value: unknown): string | null => value == null || value === '' ? null : text(value, '原票字段');
const money = (value: unknown, label: string, zero = false): Prisma.Decimal => {
  const raw = value instanceof Prisma.Decimal ? value.toString() : value;
  if (typeof raw !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(raw)) return invalid(`${label}须为最多4位小数的明确十进制金额。`);
  const amount = new Prisma.Decimal(raw);
  if (zero ? amount.lt(0) : amount.lte(0)) return invalid(`${label}金额无效。`);
  return amount;
};
export const supplierVatPayableAuditId = (vatInvoiceId: string) => `supplier_vat_payable_${supplierFingerprint(vatInvoiceId)}`;
export const supplierVatLineIdentity = (line: Pick<SupplierVatSelectedLine, 'contractKind' | 'contractId' | 'lineId'>) => `${line.contractKind}:${line.contractId}:${line.lineId}`;

export function normalizeSupplierVatSelection(value: unknown): SupplierVatSelection {
  const row = supplierObject(value);
  if (Object.keys(row).some(key => !['amountBasis', 'dueDate', 'sources'].includes(key))) return invalid('应付来源含不支持的字段，请重新核对。');
  if (row.amountBasis !== 'net' && row.amountBasis !== 'gross') return invalid('请明确本票合同金额为净价还是含税价。');
  if (!Array.isArray(row.sources) || !row.sources.length || row.sources.length > 100) return invalid('请选择1至100条准确已批准合同行。');
  const sources = row.sources.map((value): SupplierVatSelectedLine => {
    const line = supplierObject(value);
    if (Object.keys(line).some(key => !['contractKind', 'contractId', 'commitmentRevisionId', 'lineId', 'contractAmount'].includes(key))) return invalid('合同行含不支持的来源字段。');
    if (line.contractKind !== 'purchase' && line.contractKind !== 'processing') return invalid('请明确采购或加工合同类型。');
    return { contractKind: line.contractKind, contractId: text(line.contractId, '真实合同'), commitmentRevisionId: text(line.commitmentRevisionId, '准确已批版本'),
      lineId: text(line.lineId, '稳定合同行'), contractAmount: money(line.contractAmount, '本次合同行占用').toFixed(4) };
  }).sort((a, b) => supplierVatLineIdentity(a).localeCompare(supplierVatLineIdentity(b)));
  if (new Set(sources.map(supplierVatLineIdentity)).size !== sources.length) return invalid('本票不可重复选择同一稳定合同行。');
  const dueDate = row.dueDate == null || row.dueDate === '' ? null : text(row.dueDate, '实际到期日');
  if (dueDate && !isValidLocalDateKey(dueDate)) return invalid('到期日须为真实 YYYY-MM-DD 日期。');
  return { amountBasis: row.amountBasis, dueDate, sources };
}

/** Tax status, linked invoice and audit timestamps remain separate mutable facts. */
export function supplierVatOriginal(value: unknown): SupplierVatOriginal {
  const row = supplierObject(value);
  if (row.direction !== 'Input' || !['Special', 'Normal'].includes(String(row.invoiceType))) return conflict('应付须引用真实供应商进项原票，不能借用销项票。');
  const net = money(row.netAmount, '原票不含税金额'), tax = money(row.taxAmount, '原票税额', true), gross = money(row.totalAmount, '原票价税合计');
  const rate = money(row.taxRate, '原票税率', true);
  if (rate.gt(100) || !net.plus(tax).eq(gross) || net.mul(rate).div(100).toDecimalPlaces(4).minus(tax).abs().gt('0.02'))
    return conflict('原票金额、税额及价税合计不一致，请先核对供应商原票。');
  const currency = text(row.currency, '原票币种');
  if (!/^[A-Z]{3}$/.test(currency) || !isValidLocalDateKey(String(row.issueDate))) return conflict('原票币种或开票日期尚未明确。');
  return { id: text(row.id, '原票身份'), vatCode: optionalText(row.vatCode), vatNumber: text(row.vatNumber, '原票号码'), direction: 'Input',
    invoiceType: String(row.invoiceType), relationId: text(row.relationId, '真实供应商'), sellerName: text(row.sellerName, '原票销方'),
    sellerTaxNo: optionalText(row.sellerTaxNo), buyerName: text(row.buyerName, '原票购方'), buyerTaxNo: optionalText(row.buyerTaxNo),
    issueDate: String(row.issueDate), netAmount: net.toFixed(4), taxRate: rate.toFixed(4), taxAmount: tax.toFixed(4), totalAmount: gross.toFixed(4),
    currency, orderId: optionalText(row.orderId), attachments: row.attachments == null ? null : supplierJson(row.attachments) };
}
export function assertSupplierVatAmounts(vat: SupplierVatOriginal, selection: SupplierVatSelection): void {
  const total = selection.sources.reduce((sum, line) => sum.plus(line.contractAmount), new Prisma.Decimal(0));
  if (!total.eq(selection.amountBasis === 'net' ? vat.netAmount : vat.totalAmount)) conflict('所选合同行金额合计须准确等于本票所声明基准的净额或价税合计，不进行隐式换汇或税额分摊。');
}
export function assertSupplierVatCapacity(capacity: string, requested: string, basis: SupplierVatAmountBasis,
  prior: Array<{ amountBasis: SupplierVatAmountBasis; contractAmount: string }>) {
  if (prior.some(row => row.amountBasis !== basis)) return conflict('同一稳定合同行已有不同税价基准的登记，请核清原票，不能混加净价与含税价。');
  const registered = prior.reduce((sum, row) => sum.plus(money(row.contractAmount, '原登记金额')), new Prisma.Decimal(0));
  const remaining = money(capacity, '已批行金额', true).minus(registered);
  if (remaining.lt(0) || money(requested, '本次金额').gt(remaining)) return conflict('该稳定合同行累计已登记金额超过本准确已批行容量，请核对原应付。');
  return { registeredAmount: registered.toFixed(4), remainingAmount: remaining.toFixed(4) };
}

/** This reader requires no procurement write capability. Finance consumes the
 * actual approved evidence; it never creates or approves the vendor contract. */
export async function readSupplierVatApprovedLine(tx: Prisma.TransactionClient, selected: SupplierVatSelectedLine,
  options: { current: boolean; supplierId: string; currency: string }): Promise<SupplierVatSourceLine> {
  const revision = await tx.supplierCommitmentRevision.findUnique({ where: { id: selected.commitmentRevisionId } });
  const contract = selected.contractKind === 'purchase'
    ? await tx.purchaseOrder.findFirst({ where: { id: selected.contractId, deletedAt: null } })
    : await tx.outsourcingOrder.findFirst({ where: { id: selected.contractId, deletedAt: null } });
  if (!revision || revision.purchaseOrderId !== (selected.contractKind === 'purchase' ? selected.contractId : null)
    || revision.outsourcingOrderId !== (selected.contractKind === 'processing' ? selected.contractId : null)
    || !['approved', 'superseded'].includes(revision.status) || !revision.approvalRequestId
    || supplierFingerprint(revision.snapshot) !== revision.contentFingerprint) return conflict('缺少准确供应商承诺的正式批准依据。');
  if (options.current && (!contract || contract.approvedCommitmentRevisionId !== revision.id || revision.status !== 'approved'))
    return conflict('新应付须登记当前准确已批准合同版本，请刷新合同后核对。');
  const snapshot = supplierSnapshot(revision.snapshot, selected.contractKind);
  const line = snapshot.lines.find(row => row.id === selected.lineId);
  const proof = line && snapshot.sourceProofs.find(row => row.orderLineId === line.orderLineId);
  if (!line || !proof || !proof.orderId || snapshot.supplierRelationId !== options.supplierId || snapshot.currency !== options.currency)
    return conflict('原票供应商、币种、合同行和准确来源不一致。');
  const raw = supplierObject(revision.snapshot), party = supplierObject(raw.supplierParty);
  if (party.id !== options.supplierId) return conflict('已批准合同缺少准确供应商身份快照。');
  const approval = await tx.approvalRequest.findUnique({ where: { id: revision.approvalRequestId } });
  const payload = supplierObject(approval?.payload);
  const audit = await tx.auditLog.findFirst({ where: { action: 'approved_supplier_commitment',
    targetType: selected.contractKind === 'purchase' ? 'PurchaseOrder' : 'OutsourcingOrder', targetId: selected.contractId,
    detail: { path: ['after', 'revisionId'], equals: revision.id } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const after = supplierObject(supplierObject(audit?.detail).after);
  if (!approval || approval.actionType !== 'supplier:commitment' || approval.targetType !== 'SupplierCommitmentRevision'
    || approval.targetId !== revision.id || approval.status !== 'approved' || !approval.reviewerId || !approval.decidedAt
    || payload.revisionId !== revision.id || payload.contractId !== selected.contractId || payload.contractKind !== selected.contractKind
    || payload.contentFingerprint !== revision.contentFingerprint || supplierFingerprint(payload.documentSnapshot) !== revision.contentFingerprint
    || !audit || audit.actorId !== approval.reviewerId || after.approvalId !== approval.id || after.status !== 'approved'
    || supplierFingerprint(after.snapshot) !== revision.contentFingerprint) return conflict('供应商承诺与实际批准记录不一致，不能登记应付。');
  const actualLine = await tx.orderLine.findFirst({ where: { id: line.orderLineId, orderId: proof.orderId }, select: { id: true } });
  if (!actualLine) return conflict('准确来源订单条目已经失效，不能借其他订单登记。');
  if (options.current) {
    const actual = selected.contractKind === 'purchase'
      ? await tx.purchaseLine.findFirst({ where: { id: line.id, purchaseOrderId: selected.contractId, retiredAt: null } })
      : await tx.outsourcingLine.findFirst({ where: { id: line.id, outsourcingOrderId: selected.contractId, retiredAt: null } });
    if (!actual || actual.orderLineId !== line.orderLineId || !new Prisma.Decimal(actual.amount).eq(line.amount)) return conflict('当前合同行与准确已批准行不一致。');
  }
  return { ...selected, contractNumber: contract ? ('poNumber' in contract ? contract.poNumber : contract.orderNumber) : text(raw.contractNumber ?? selected.contractId, '历史合同身份'),
    orderId: proof.orderId, orderLineId: line.orderLineId, approvedLineAmount: new Prisma.Decimal(line.amount).toFixed(4),
    paymentTerms: snapshot.paymentTerms, approvalId: approval.id, approvalAuditId: audit.id,
    commitmentFingerprint: revision.contentFingerprint, commitmentSnapshot: supplierJson(revision.snapshot) };
}

export function makeSupplierVatSnapshot(vat: SupplierVatOriginal, selection: SupplierVatSelection, sources: SupplierVatSourceLine[]): SupplierVatPayableSnapshot {
  const basis: Omit<SupplierVatPayableSnapshot, 'sourceFingerprint'> = { schemaVersion: 1, sourceType: SUPPLIER_VAT_PAYABLE_SOURCE, vatOriginal: vat,
    amountBasis: selection.amountBasis, dueDate: selection.dueDate, sources, orderIds: [...new Set(sources.map(line => line.orderId))].sort() };
  return { ...basis, sourceFingerprint: supplierFingerprint(basis) };
}

/** Full frozen approval documents may contain other source lines. Reading any
 * of that document requires every actual parent, not just the selected line. */
export function supplierVatAuthorizationOrderIds(snapshot: SupplierVatPayableSnapshot): string[] {
  const ids = new Set(snapshot.orderIds);
  for (const source of snapshot.sources) {
    const proofs = supplierObject(source.commitmentSnapshot).sourceProofs;
    if (!Array.isArray(proofs) || !proofs.length) return conflict('已批合同缺少准确订单来源。');
    for (const proof of proofs) ids.add(text(supplierObject(proof).orderId, '合同原订单来源'));
  }
  return [...ids].sort();
}

/** Historical provenance is verified against the exact original approved
 * revision, never against a later amendment or a projected header scalar. */
export async function readSupplierVatPayableSource(tx: Prisma.TransactionClient, vatInvoiceId: string) {
  const invoice = await tx.invoice.findFirst({ where: { sourceType: SUPPLIER_VAT_PAYABLE_SOURCE, sourceId: vatInvoiceId, deletedAt: null } });
  const auditId = supplierVatPayableAuditId(vatInvoiceId);
  const audit = await tx.auditLog.findUnique({ where: { id: auditId } });
  const vat = await tx.vatInvoice.findFirst({ where: { id: vatInvoiceId, deletedAt: null } });
  if (!invoice || !audit || !vat) return conflict('原应付、供应商原票或登记回执缺失，请核对原账。');
  const detail = supplierObject(audit.detail), frozen = supplierObject(detail.snapshot), receipt = supplierObject(detail.receipt);
  if (frozen.schemaVersion !== 1 || frozen.sourceType !== SUPPLIER_VAT_PAYABLE_SOURCE || !Array.isArray(frozen.sources)) return conflict('原应付来源快照无法核实。');
  const selection = normalizeSupplierVatSelection({ amountBasis: frozen.amountBasis, dueDate: frozen.dueDate,
    sources: frozen.sources.map(value => { const line = supplierObject(value); return { contractKind: line.contractKind, contractId: line.contractId,
      commitmentRevisionId: line.commitmentRevisionId, lineId: line.lineId, contractAmount: line.contractAmount }; }) });
  const original = supplierVatOriginal(vat);
  if (supplierFingerprint(frozen.vatOriginal) !== supplierFingerprint(original)) return conflict('供应商原票内容已偏离登记原件，请核对原账。');
  const rebuilt: SupplierVatSourceLine[] = [];
  for (const selected of selection.sources) {
    const verified = await readSupplierVatApprovedLine(tx, selected, { current: false, supplierId: original.relationId, currency: original.currency });
    const old = frozen.sources.find(value => { const line = supplierObject(value);
      return `${line.contractKind}:${line.contractId}:${line.lineId}` === supplierVatLineIdentity(selected); });
    // Preserve the original contract number even if the current header label changed.
    verified.contractNumber = text(supplierObject(old).contractNumber, '原合同编号');
    rebuilt.push(verified);
  }
  const snapshot = makeSupplierVatSnapshot(original, selection, rebuilt);
  assertSupplierVatAmounts(original, selection);
  if (supplierFingerprint(snapshot) !== supplierFingerprint(frozen) || audit.action !== SUPPLIER_VAT_PAYABLE_ACTION || audit.targetType !== 'Invoice'
    || audit.targetId !== invoice.id || audit.actorId !== receipt.actorId || audit.transactionId !== receipt.requestKey
    || receipt.operation !== SUPPLIER_VAT_PAYABLE_ACTION || receipt.auditId !== auditId || receipt.invoiceId !== invoice.id
    || receipt.vatInvoiceId !== vat.id || receipt.sourceFingerprint !== snapshot.sourceFingerprint
    || receipt.commandHash !== supplierFingerprint(detail.commandInput) || supplierObject(detail.commandInput).requestKey !== receipt.requestKey
    || vat.invoiceId !== invoice.id || invoice.type !== 'Payable' || invoice.status === 'Cancelled'
    || invoice.currency !== original.currency || !new Prisma.Decimal(invoice.amount).eq(original.totalAmount)
    || invoice.invoiceNumber !== `SVAT-${vat.id}` || invoice.issueDate !== original.issueDate || invoice.dueDate !== selection.dueDate
    || invoice.customerRelationId !== original.relationId || invoice.customerName !== original.sellerName
    || invoice.orderId !== (snapshot.orderIds.length === 1 ? snapshot.orderIds[0] : null)) return conflict('原应付与原票登记回执不一致，请核对原账。');
  const links = await tx.invoiceOrderAllocation.findMany({ where: { invoiceId: invoice.id, deletedAt: null } });
  if (supplierFingerprint(links.map(row => row.orderId).sort()) !== supplierFingerprint(snapshot.orderIds)) return conflict('原应付关联订单范围发生变化。');
  for (const link of links) {
    const expected = snapshot.orderIds.length === 1 ? new Prisma.Decimal(original.totalAmount)
      : snapshot.amountBasis === 'gross' ? snapshot.sources.filter(line => line.orderId === link.orderId)
        .reduce((sum, line) => sum.plus(line.contractAmount), new Prisma.Decimal(0)) : null;
    if (expected === null ? link.allocatedAmount !== null : link.allocatedAmount === null || !expected.eq(link.allocatedAmount))
      return conflict('原应付逐订单金额偏离准确登记依据，未知分摊不能擅自补算。');
  }
  return { invoice, vatInvoice: vat, snapshot, receipt: receipt as SupplierVatPayableReceipt, auditId };
}
