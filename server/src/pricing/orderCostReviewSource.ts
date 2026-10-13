import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { decodeInternalTransferPayload, readInternalTransferAccountingFacts } from '../internalTrade/internalTransferService';

export const COST_CATEGORIES = ['procurement', 'companySupply', 'logistics', 'otherExpenses', 'bankFees', 'allowances'] as const;
export type CostCategory = typeof COST_CATEGORIES[number];
export interface ReviewCoverage { status: 'verified' | 'not_applicable' | 'pending'; note: string; evidenceIds: string[] }
export interface ReviewBill { invoiceId: string; purchaseOrderId: string; purchaseLineIds: string[]; serviceDeliveryIds: string[]; treatment: 'cost' | 'stock_valuation'; evidenceIds: string[] }
export interface ReviewSupply { movementId: string; valuationInvoiceId: string; orderLineId: string; inputQuantity: string; usedQuantity: string; lossQuantity: string; unusedQuantity: string; unit: string; evidenceIds: string[] }
export interface ReviewExpense { costRecordId: string; category: 'logistics' | 'otherExpenses'; treatment: 'cost' | 'not_applicable'; note: string; evidenceIds: string[]; exchangeRate?: string; fxEvidenceIds?: string[] }
export interface ReviewInternalTransfer { masterId: string; mirrorId: string; garmentOrderLineId: string; fabricOrderLineId: string; deliveryIds: string[]; evidenceIds: string[] }
export interface OrderCostReviewInput { sourceFingerprint: string; bills: ReviewBill[]; supply: ReviewSupply[]; expenses: ReviewExpense[]; coverage: Record<CostCategory, ReviewCoverage>; internalTransfers?: ReviewInternalTransfer[] }
export interface ConfirmOrderCostReviewInput extends OrderCostReviewInput { expectedRevision: number; requestId: string; note: string }
export function reviewReject(code: string, message: string): never { throw businessError(code, message); }
export function reviewText(value: unknown, field: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) reviewReject('INVALID_INPUT', `${field}未填写或过长`);
  return value.trim();
}
export function reviewDecimal(value: unknown, field: string): Prisma.Decimal {
  if (!(typeof value === 'number' && Number.isFinite(value)) && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) reviewReject('INVALID_INPUT', `${field}必须为明确的非负数`);
  const result = new Prisma.Decimal(String(value));
  if (!result.isFinite() || result.isNegative() || result.decimalPlaces() > 4 || result.gte('100000000000000')) reviewReject('INVALID_INPUT', `${field}必须为非负数且最多4位小数`);
  return result;
}
export function reviewJson(value: unknown): any { return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)); }
function canonical(value: any): any {
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value;
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
export function reviewHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function keys(value: any, allowed: string[], field: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) reviewReject('INVALID_INPUT', `${field}包含无效字段`);
}
function ids(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 500) reviewReject('INVALID_INPUT', `${field}无效`);
  const result = value.map(item => reviewText(item, field, 200)).sort();
  if (new Set(result).size !== result.length) reviewReject('INVALID_INPUT', `${field}不可重复`);
  return result;
}
export function parseOrderCostReviewInput(raw: any, confirm = false): OrderCostReviewInput | ConfirmOrderCostReviewInput {
  keys(raw, ['sourceFingerprint', 'bills', 'supply', 'expenses', 'coverage', 'internalTransfers', ...(confirm ? ['expectedRevision', 'requestId', 'note'] : [])], '核对请求');
  const sourceFingerprint = reviewText(raw.sourceFingerprint, '来源版本', 64);
  if (!/^[a-f0-9]{64}$/.test(sourceFingerprint)) reviewReject('INVALID_INPUT', '来源版本无效');
  for (const field of ['bills', 'supply', 'expenses']) if (!Array.isArray(raw[field]) || raw[field].length > 500) reviewReject('INVALID_INPUT', `${field}无效`);
  const bills = raw.bills.map((row: any) => {
    keys(row, ['invoiceId', 'purchaseOrderId', 'purchaseLineIds', 'serviceDeliveryIds', 'treatment', 'evidenceIds'], '采购账单');
    if (!['cost', 'stock_valuation'].includes(row.treatment)) reviewReject('INVALID_INPUT', '采购计价方式无效');
    return { invoiceId: reviewText(row.invoiceId, '发票', 200), purchaseOrderId: reviewText(row.purchaseOrderId, '采购单', 200), purchaseLineIds: ids(row.purchaseLineIds, '采购行'), serviceDeliveryIds: ids(row.serviceDeliveryIds, '服务交付'), treatment: row.treatment, evidenceIds: ids(row.evidenceIds, '账单凭据') };
  });
  const supply = raw.supply.map((row: any) => {
    keys(row, ['movementId', 'valuationInvoiceId', 'orderLineId', 'inputQuantity', 'usedQuantity', 'lossQuantity', 'unusedQuantity', 'unit', 'evidenceIds'], '供料汇总');
    return { movementId: reviewText(row.movementId, '入库来源', 200), valuationInvoiceId: reviewText(row.valuationInvoiceId, '历史计价账单', 200), orderLineId: reviewText(row.orderLineId, '订单行', 200), inputQuantity: reviewDecimal(row.inputQuantity, '投入').toString(), usedQuantity: reviewDecimal(row.usedQuantity, '用于产品').toString(), lossQuantity: reviewDecimal(row.lossQuantity, '损耗').toString(), unusedQuantity: reviewDecimal(row.unusedQuantity, '余料').toString(), unit: reviewText(row.unit, '单位', 30), evidenceIds: ids(row.evidenceIds, '供料凭据') };
  });
  const expenses = raw.expenses.map((row: any) => {
    keys(row, ['costRecordId', 'category', 'treatment', 'note', 'evidenceIds', 'exchangeRate', 'fxEvidenceIds'], '实际费用');
    if (!['logistics', 'otherExpenses'].includes(row.category) || !['cost', 'not_applicable'].includes(row.treatment)) reviewReject('INVALID_INPUT', '费用归集无效');
    return { costRecordId: reviewText(row.costRecordId, '实际费用', 200), category: row.category, treatment: row.treatment, note: reviewText(row.note, '费用核对说明'), evidenceIds: ids(row.evidenceIds, '费用凭据'), ...(row.exchangeRate !== undefined ? { exchangeRate: reviewDecimal(row.exchangeRate, '凭据汇率').toString(), fxEvidenceIds: ids(row.fxEvidenceIds, '汇率凭据') } : {}) };
  });
  keys(raw.coverage, [...COST_CATEGORIES], '完整性核对');
  const coverage = Object.fromEntries(COST_CATEGORIES.map(category => {
    const row = raw.coverage[category]; keys(row, ['status', 'note', 'evidenceIds'], category);
    if (!['verified', 'not_applicable', 'pending'].includes(row.status)) reviewReject('INVALID_INPUT', '完整性状态无效');
    return [category, { status: row.status, note: reviewText(row.note, '核对说明'), evidenceIds: ids(row.evidenceIds, '核对凭据') }];
  })) as Record<CostCategory, ReviewCoverage>;
  let internalTransfers: ReviewInternalTransfer[] | undefined;
  if (raw.internalTransfers !== undefined) {
    if (!Array.isArray(raw.internalTransfers) || raw.internalTransfers.length > 500) reviewReject('INVALID_INPUT', '内部交易绑定无效');
    internalTransfers = raw.internalTransfers.map((row: any) => {
      keys(row, ['masterId','mirrorId','garmentOrderLineId','fabricOrderLineId','deliveryIds','evidenceIds'], '内部交易');
      return { masterId: reviewText(row.masterId, '内部主单', 200), mirrorId: reviewText(row.mirrorId, '内部镜像', 200), garmentOrderLineId: reviewText(row.garmentOrderLineId, '服装订单行', 200), fabricOrderLineId: reviewText(row.fabricOrderLineId, '面料订单行', 200), deliveryIds: ids(row.deliveryIds, '真实内部交付'), evidenceIds: ids(row.evidenceIds, '内部财务核对凭据') };
    });
  }
  const result = { sourceFingerprint, bills, supply, expenses, coverage, ...(internalTransfers === undefined ? {} : { internalTransfers }) };
  if (!confirm) return result;
  if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0) reviewReject('INVALID_INPUT', '核对版本无效');
  return { ...result, expectedRevision: raw.expectedRevision, requestId: reviewText(raw.requestId, '请求标识', 200), note: reviewText(raw.note, '确认说明') };
}

export interface OrderCostSources {
  order: any; orderLines: any[]; purchaseOrders: any[]; deliveries: any[]; receiptAudits: any[]; invoices: any[]; invoiceOrders: any[];
  costRecords: any[]; costEvidence: any[]; shipments: any[]; shipmentAllocations: any[]; batches: any[]; movements: any[]; inventory: any[];
  voucherAllocations: any[]; vouchers: any[]; creditAllocations: any[]; creditNotes: any[]; internalTransfers: any[];
  internalFacts?: { recordId: string; status: 'verified' | 'pending'; reason?: string; facts?: Awaited<ReturnType<typeof readInternalTransferAccountingFacts>>; currentRows?: any[] }[];
  /** DAO-only peers to authorize before exposing shared native facts; never accepted in commands. */
  internalOrderIds?: string[];
}
/** All current relevant sources, including unfinished ones: callers cannot select away a missing cost. */
export async function loadOrderCostSources(db: any, orderId: string): Promise<OrderCostSources> {
  const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null } });
  if (!order) reviewReject('NOT_FOUND', '订单不存在或无权访问');
  const orderLines = await db.orderLine.findMany({ where: { orderId }, orderBy: { id: 'asc' } });
  const purchaseOrders = await db.purchaseOrder.findMany({ where: { orderId, deletedAt: null, status: { not: 'Cancelled' } }, include: { lines: true, receipts: true } });
  const deliveries = await db.purchaseServiceDelivery.findMany({ where: { orderId } });
  const receiptIds = purchaseOrders.flatMap((po: any) => po.receipts.map((row: any) => row.id));
  const receiptAudits = await db.auditLog.findMany({ where: { action: 'create_material_receipt', targetType: 'PurchaseOrder', targetId: { in: purchaseOrders.map((po: any) => po.id) } } });
  const invoiceOrders = await db.invoiceOrderAllocation.findMany({ where: { orderId, deletedAt: null } });
  const invoices = await db.invoice.findMany({ where: { deletedAt: null, OR: [{ orderId }, { id: { in: invoiceOrders.map((row: any) => row.invoiceId) } }, { sourceType: 'PurchaseOrder', sourceId: { in: purchaseOrders.map((po: any) => po.id) } }, { sourceType: 'PurchaseServiceDelivery', sourceId: { in: deliveries.map((row: any) => row.id) } }] } });
  // All allocation rows distinguish a real single-order bill from a multi-order invoice.
  const allInvoiceOrders = await db.invoiceOrderAllocation.findMany({ where: { invoiceId: { in: invoices.map((row: any) => row.id) }, deletedAt: null } });
  const costRecords = await db.costRecord.findMany({ where: { deletedAt: null, OR: [{ sourceType: 'Order', sourceId: orderId }, { sourceType: 'OrderLine', sourceId: { in: orderLines.map((row: any) => row.id) } }] } });
  const costEvidence = await db.costEvidence.findMany({ where: { costRecordId: { in: costRecords.map((row: any) => row.id) }, revokedAt: null } });
  const shipmentAllocations = await db.shipmentOrderAllocation.findMany({ where: { orderId, status: { not: 'Cancelled' } } });
  const shipments = await db.shipment.findMany({ where: { deletedAt: null, status: { not: 'Cancelled' }, OR: [{ orderId }, { id: { in: shipmentAllocations.map((row: any) => row.shipmentId) } }] } });
  const batches = await db.orderShipmentBatch.findMany({ where: { orderId, deletedAt: null, status: { not: 'cancelled' } } });
  const movements = await db.stockMovement.findMany({ where: { type: 'Inbound', referenceType: { in: ['MaterialReceipt', 'PurchaseOrder'] }, referenceId: { in: receiptIds } } });
  const inventory = await db.inventoryItem.findMany({ where: { id: { in: movements.map((row: any) => row.itemId) }, deletedAt: null } });
  const invoiceIds = invoices.map((row: any) => row.id);
  const myVoucherAllocations = await db.invoiceAllocation.findMany({ where: { invoiceId: { in: invoiceIds } } });
  const vouchers = await db.paymentVoucher.findMany({ where: { deletedAt: null, OR: [{ orderId }, { invoiceId: { in: invoiceIds } }, { id: { in: myVoucherAllocations.map((row: any) => row.voucherId) } }] } });
  const voucherAllocations = await db.invoiceAllocation.findMany({ where: { voucherId: { in: vouchers.map((row: any) => row.id) } } });
  const creditAllocations = await db.creditNoteAllocation.findMany({ where: { invoiceId: { in: invoiceIds } } });
  const creditNotes = await db.creditNote.findMany({ where: { id: { in: creditAllocations.map((row: any) => row.creditNoteId) } } });
  const internalTransfers = await db.orderInternalTransfer.findMany({ where: { orderId, deletedAt: null } });
  const internalPeerIds = new Set<string>(internalTransfers.map((row: any) => row.orderId));
  const internalFacts: NonNullable<OrderCostSources['internalFacts']> = [];
  for (const record of internalTransfers) {
    const payload = decodeInternalTransferPayload(record.memo);
    // Even cancelled/historical source DTOs must not reveal a hidden peer.
    // Memo only locates candidate rows: peer identity comes from real DB rows.
    const pairIds = payload ? [payload.masterId, payload.mirrorId].filter(Boolean) : [record.id];
    const pairRows = await db.orderInternalTransfer.findMany({ where: { id: { in: pairIds } } });
    for (const row of pairRows) if (row.orderId) internalPeerIds.add(row.orderId);
    if (payload?.status === 'Cancelled') continue;
    try {
      const facts = await readInternalTransferAccountingFacts(db, record);
      // Peer customer/contact data is irrelevant to the shared internal price fact.
      facts.orders = facts.orders.map((row: any) => ({ id: row.id, status: row.status, isInternalFabricTrade: row.isInternalFabricTrade, deletedAt: row.deletedAt }));
      internalFacts.push({ recordId: record.id, status: 'verified', facts });
    } catch (error) {
      if (!isBusinessError(error)) throw error;
      internalFacts.push({ recordId: record.id, status: 'pending', reason: String(error.code), currentRows: pairRows });
    }
  }
  const internalOrderIds = [...internalPeerIds].sort();
  return { order, orderLines, purchaseOrders, deliveries, receiptAudits, invoices, invoiceOrders: allInvoiceOrders, costRecords, costEvidence, shipments, shipmentAllocations, batches, movements, inventory, voucherAllocations, vouchers, creditAllocations, creditNotes, internalTransfers, ...(internalTransfers.length ? { internalFacts, internalOrderIds } : {}) };
}

const formal = (row: any) => ['Issued', 'PartiallyPaid', 'Paid'].includes(row.status);
const unit = (raw: unknown) => typeof raw === 'string' ? raw.trim().toUpperCase() : '';
function amount(value: unknown): Prisma.Decimal | null {
  if (value == null || String(value).trim() === '') return null;
  try { const parsed = new Prisma.Decimal(String(value)); return parsed.isFinite() && !parsed.isNegative() && parsed.lt('100000000000000') ? parsed : null; } catch { return null; }
}
function cny(value: unknown, currency: unknown, exchangeRate: unknown, baseCurrency?: unknown): Prisma.Decimal | null {
  const number = amount(value); if (!number || (baseCurrency != null && baseCurrency !== 'CNY')) return null;
  if (currency === 'CNY') return number.toDecimalPlaces(4);
  const rate = amount(exchangeRate); return typeof currency === 'string' && currency.trim() && rate?.gt(0) ? number.mul(rate).toDecimalPlaces(4) : null;
}
export function allReviewEvidenceIds(input: OrderCostReviewInput): string[] {
  return [...new Set([...Object.values(input.coverage).flatMap(row => row.evidenceIds), ...input.bills.flatMap(row => row.evidenceIds), ...input.supply.flatMap(row => row.evidenceIds), ...input.expenses.flatMap(row => [...row.evidenceIds, ...(row.fxEvidenceIds ?? [])]), ...(input.internalTransfers ?? []).flatMap(row => row.evidenceIds)])].sort();
}
/** Pure calculation against independently fetched current facts; has no status/amount supplied by client. */
export function calculateOrderCostReview(s: OrderCostSources, input: OrderCostReviewInput, evidenceIds: Set<string>) {
  const reasons = new Set<string>();
  const add = (value: string) => reasons.add(value);
  const breakdown: Record<CostCategory, Prisma.Decimal> = Object.fromEntries(COST_CATEGORIES.map(key => [key, new Prisma.Decimal(0)])) as any;
  const evidence = (ids: string[], code: string) => { if (!ids.length || ids.some(id => !evidenceIds.has(id))) add(code); };
  if (input.sourceFingerprint !== reviewHash(s)) reviewReject('SOURCE_CHANGED', '来源已变化，请刷新核对');
  for (const category of COST_CATEGORIES) {
    const coverage = input.coverage[category];
    if (coverage.status === 'pending') add(`COVERAGE_PENDING:${category}`);
    evidence(coverage.evidenceIds, `COVERAGE_EVIDENCE_MISSING:${category}`);
  }
  if (!s.orderLines.length || !s.shipmentAllocations.length || s.shipments.some(row => !['Shipped', 'Arrived', 'Cleared', 'Delivered'].includes(row.status)) || s.shipmentAllocations.some(row => !['Fulfilled', 'ShortShipped'].includes(row.status))) add('FINAL_ORDER_SCOPE_UNVERIFIED');
  if (s.batches.length ? !s.batches.some(row => row.isFinalBatch && row.status === 'shipped') || s.batches.some(row => row.status !== 'shipped') : !['Delivered', 'Completed'].includes(s.order.status)) add('FINAL_ORDER_SCOPE_UNVERIFIED');
  for (const line of s.orderLines) {
    const allocations = s.shipmentAllocations.filter(row => row.orderLineId === line.id);
    const q = amount(line.quantity); const quantities = allocations.map(row => amount(row.actualQty));
    if (!q || !unit(line.unit) || !allocations.length || quantities.some(value => value === null) || allocations.some(row => unit(row.unit) !== unit(line.unit)) || !quantities.reduce<Prisma.Decimal>((sum, value) => sum.add(value!), new Prisma.Decimal(0)).eq(q)) add('FINAL_ORDER_LINE_SCOPE_UNVERIFIED');
  }
  if (s.shipmentAllocations.some(row => !s.orderLines.some(line => line.id === row.orderLineId) || !s.shipments.some(shipment => shipment.id === row.shipmentId))) add('FINAL_ORDER_LINE_SCOPE_UNVERIFIED');
  let revenue = new Prisma.Decimal(0); const revenueIds: string[] = [];
  const internalRevenueTransferIds: string[] = [], internalPurchaseTransferIds: string[] = [], seenInternalPairs = new Set<string>();
  for (const binding of input.internalTransfers ?? []) {
    if (seenInternalPairs.has(binding.masterId)) reviewReject('DUPLICATE_COST_SOURCE', '内部交易主单不可重复归集'); seenInternalPairs.add(binding.masterId);
    const source = s.internalFacts?.find(row => row.status === 'verified' && row.facts?.master.id === binding.masterId);
    const facts = source?.facts;
    if (!facts || facts.mirror.id !== binding.mirrorId || facts.payload.garmentOrderLineId !== binding.garmentOrderLineId || facts.payload.fabricOrderLineId !== binding.fabricOrderLineId
        || ![facts.payload.garmentOrderId, facts.payload.fabricOrderId].includes(s.order.id)) reviewReject('INVALID_COST_SOURCE', '内部绑定必须匹配准确主单、镜像及双方稳定订单行');
    const actualIds = facts.payload.deliveries.map(row => row.id).sort();
    if (reviewHash(actualIds) !== reviewHash([...binding.deliveryIds].sort())) reviewReject('INVALID_COST_SOURCE', '内部交付范围必须完整且准确，不可漏选或跨单绑定');
    evidence(binding.evidenceIds, 'INTERNAL_REVIEW_EVIDENCE_MISSING');
    const approvedQty = amount(facts.payload.confirmedQuantity);
    const deliveredQty = facts.payload.deliveries.reduce((sum, row) => sum.add(row.quantity), new Prisma.Decimal(0));
    const receivedQty = (facts.payload.receipts ?? []).reduce((sum, row) => sum.add(row.quantity), new Prisma.Decimal(0));
    if (facts.payload.status !== 'Closed' || !actualIds.length || !approvedQty?.gt(0) || !deliveredQty.eq(approvedQty) || !receivedQty.eq(approvedQty)
        || facts.payload.deliveries.some(row => row.variance !== 0 || row.receivedQuantity === null)) add('INTERNAL_RECEIPT_SCOPE_UNVERIFIED');
    const internalAmount = cny(facts.master.transferAmount, facts.master.transferCurrency, null);
    if (!internalAmount) add('INTERNAL_PRICE_AMOUNT_UNVERIFIED');
    else if (s.order.id === facts.payload.garmentOrderId) { breakdown.procurement = breakdown.procurement.add(internalAmount); internalPurchaseTransferIds.push(facts.master.id); }
    else { revenue = revenue.add(internalAmount); internalRevenueTransferIds.push(facts.mirror.id); }
  }
  const operativeInternal = s.internalTransfers.filter(row => decodeInternalTransferPayload(row.memo)?.status !== 'Cancelled');
  for (const row of operativeInternal) {
    const payload = decodeInternalTransferPayload(row.memo);
    if (!payload || !seenInternalPairs.has(payload.masterId) || !s.internalFacts?.some(fact => fact.recordId === row.id && fact.status === 'verified')) add('INTERNAL_TRADE_COST_SCOPE_UNVERIFIED');
  }
  if (s.order.isInternalFabricTrade && !internalRevenueTransferIds.length) add('INTERNAL_REVENUE_SOURCE_MISSING');
  const receivables = s.invoices.filter(row => row.type === 'Receivable' && row.status !== 'Cancelled');
  if (!receivables.length && !internalRevenueTransferIds.length) add('FORMAL_REVENUE_MISSING');
  for (const invoice of receivables) {
    if (!formal(invoice)) { add('FORMAL_REVENUE_INCOMPLETE'); continue; }
    const rows = s.invoiceOrders.filter(row => row.invoiceId === invoice.id);
    const own = rows.find(row => row.orderId === s.order.id);
    const value = cny(own ? own.allocatedAmount : rows.length ? null : invoice.amount, invoice.currency, invoice.exchangeRate, invoice.baseCurrency);
    if (!value || (!own && invoice.orderId !== s.order.id)) add('REVENUE_RANGE_OR_FX_UNVERIFIED');
    else { revenue = revenue.add(value); revenueIds.push(invoice.id); }
  }
  const seenInvoices = new Set<string>(); const coveredLines = new Set<string>(); const coveredDeliveries = new Set<string>();
  for (const bill of input.bills) {
    const invoice = s.invoices.find(row => row.id === bill.invoiceId); const po = s.purchaseOrders.find(row => row.id === bill.purchaseOrderId);
    if (!invoice || !po || invoice.type !== 'Payable' || invoice.orderId !== s.order.id || invoice.customerRelationId !== po.supplierRelationId || !po.supplierRelationId || !po.currency || invoice.currency !== po.currency || s.invoiceOrders.some(row => row.invoiceId === invoice.id && row.orderId !== s.order.id)) reviewReject('INVALID_COST_SOURCE', '采购账单与订单/供应商来源不一致');
    if (seenInvoices.has(invoice.id)) reviewReject('DUPLICATE_COST_SOURCE', '同一实际账单不可重复归集'); seenInvoices.add(invoice.id);
    evidence(bill.evidenceIds, 'BILL_EVIDENCE_MISSING');
    if (!formal(invoice)) add('SUPPLIER_BILL_NOT_FORMAL');
    if (!bill.purchaseLineIds.length) add('PURCHASE_LINE_COVERAGE_MISSING');
    for (const id of bill.purchaseLineIds) {
      const line = po.lines.find((row: any) => row.id === id);
      if (!line || !s.orderLines.some(row => row.id === line.orderLineId)) reviewReject('INVALID_COST_SOURCE', '采购行不属于本订单范围');
      if (line.kind === 'ProcessingService') {
        if (bill.treatment !== 'cost') reviewReject('INVALID_COST_SOURCE', '加工服务不能作为库存计价');
      } else {
        if (coveredLines.has(id)) reviewReject('DUPLICATE_COST_SOURCE', '非服务采购行缺分账依据，不能重复覆盖');
        if (bill.treatment === 'stock_valuation' && line.kind !== 'Material') reviewReject('INVALID_COST_SOURCE', '仅材料采购可用于供料历史计价');
      }
      coveredLines.add(id);
    }
    for (const id of bill.serviceDeliveryIds) {
      const delivery = s.deliveries.find(row => row.id === id);
      if (!delivery || delivery.orderId !== s.order.id || delivery.purchaseOrderId !== po.id || !bill.purchaseLineIds.includes(delivery.purchaseLineId)) reviewReject('INVALID_COST_SOURCE', '加工交付来源不一致');
      if (coveredDeliveries.has(id)) reviewReject('DUPLICATE_COST_SOURCE', '同一加工交付不可重复结算'); coveredDeliveries.add(id);
    }
    const legacyExplicitBinding = invoice.sourceType == null && invoice.sourceId == null;
    const invoiceSourceMatches = invoice.sourceType === 'PurchaseOrder' && invoice.sourceId === po.id || invoice.sourceType === 'PurchaseServiceDelivery' && bill.serviceDeliveryIds.length === 1 && bill.serviceDeliveryIds[0] === invoice.sourceId;
    if (!legacyExplicitBinding && !invoiceSourceMatches) reviewReject('INVALID_COST_SOURCE', '账单既有来源与核对绑定冲突，不能覆盖原来源');
    const value = cny(invoice.amount, invoice.currency, invoice.exchangeRate, invoice.baseCurrency);
    if (!value) add('BILL_AMOUNT_OR_FX_MISSING'); else if (bill.treatment === 'cost') breakdown.procurement = breakdown.procurement.add(value);
  }
  for (const po of s.purchaseOrders) {
    if (!['Received', 'Closed'].includes(po.status)) add('PROCUREMENT_NOT_CLOSED');
    for (const line of po.lines) {
      if (!coveredLines.has(line.id)) add('PURCHASE_LINE_COVERAGE_MISSING');
      if (line.kind === 'Material' && !input.bills.some(bill => bill.purchaseLineIds.includes(line.id) && bill.treatment === 'stock_valuation')) add('MATERIAL_USAGE_BASIS_MISSING');
      if (line.kind === 'ProcessingService' && !s.deliveries.some(row => row.purchaseLineId === line.id)) add('SERVICE_ACCEPTANCE_MISSING');
      let accepted = new Prisma.Decimal(0), rejected = new Prisma.Decimal(0), valid = true;
      if (line.kind === 'ProcessingService') {
        for (const delivery of s.deliveries.filter(row => row.purchaseLineId === line.id)) {
          const a = amount(delivery.acceptedQuantity), r = amount(delivery.rejectedQuantity);
          if (!a || !r || delivery.orderId !== s.order.id || delivery.orderLineId !== line.orderLineId || unit(delivery.unit) !== unit(line.unit)) valid = false;
          else { accepted = accepted.add(a); rejected = rejected.add(r); }
        }
      } else {
        for (const receipt of po.receipts) {
          const audits = s.receiptAudits.filter(row => row.detail?.after?.receiptId === receipt.id);
          const rows = audits.length === 1 ? audits[0].detail?.after?.lineReceipts : null;
          const row = Array.isArray(rows) ? rows.find((source: any) => source.lineId === line.id) : null;
          if (!Array.isArray(rows)) { valid = false; continue; }
          if (!row) continue; // a legitimate receipt can cover other purchase lines
          const a = amount(row.accepted), r = amount(row.rejected);
          if (!a || !r || row.materialCode !== line.materialCode || unit(row.unit) !== unit(line.unit) || rows.filter((source: any) => source.lineId === line.id).length !== 1) valid = false;
          else { accepted = accepted.add(a); rejected = rejected.add(r); }
        }
      }
      if (!valid || !accepted.eq(amount(line.receivedQuantity) ?? -1) || !rejected.eq(amount(line.rejectedQuantity) ?? -1) || !accepted.add(rejected).eq(amount(line.quantity) ?? -1)) add('PURCHASE_ACCEPTANCE_RANGE_UNVERIFIED');
    }
  }
  if (s.deliveries.some(row => !coveredDeliveries.has(row.id))) add('SERVICE_DELIVERY_COVERAGE_MISSING');
  if (s.invoices.some(row => row.type === 'Payable' && row.status !== 'Cancelled' && !seenInvoices.has(row.id))) add('SUPPLIER_BILL_COVERAGE_MISSING');
  const supplyInput = new Map<string, Prisma.Decimal>();
  for (const row of input.supply) {
    const movement = s.movements.find(source => source.id === row.movementId);
    const stock = movement && s.inventory.find(source => source.id === movement.itemId);
    if (!movement || !stock || stock.ownership !== 'Owned' || !s.orderLines.some(line => line.id === row.orderLineId)) reviewReject('INVALID_COST_SOURCE', '公司供料来源不属于可核订单物料');
    let marker: any;
    try { marker = JSON.parse(String(movement.notes).replace(/^L8-source:/, '')); } catch { add('SUPPLY_SOURCE_SNAPSHOT_MISSING'); continue; }
    const po = s.purchaseOrders.find(source => source.receipts.some((receipt: any) => receipt.id === movement.referenceId));
    const line = po?.lines.find((source: any) => source.id === marker.lineId);
    const bill = input.bills.find(source => source.invoiceId === row.valuationInvoiceId && source.treatment === 'stock_valuation' && source.purchaseLineIds.includes(marker.lineId));
    const invoice = s.invoices.find(source => source.id === row.valuationInvoiceId);
    // No arbitrary division of a mixed-material invoice: historical line valuation needs its own basis.
    if (!line || !bill || !invoice || po.lines.length !== 1 || line.kind !== 'Material' || marker.receiptId !== movement.referenceId || !amount(marker.quantity)?.eq(amount(movement.quantity) ?? -1) || unit(marker.unit) !== unit(movement.unit) || unit(row.unit) !== unit(line.unit) || unit(row.unit) !== unit(movement.unit)) { add('HISTORICAL_SUPPLY_VALUATION_UNVERIFIED'); continue; }
    const audit = s.receiptAudits.find(source => source.detail?.after?.receiptId === movement.referenceId);
    const received = audit?.detail?.after?.lineReceipts?.find((source: any) => source.lineId === line.id);
    if (!received || unit(received.unit) !== unit(row.unit) || !amount(received.accepted)?.eq(amount(movement.quantity) ?? -1)) add('SUPPLY_RECEIPT_EVIDENCE_MISSING');
    const inputQty = reviewDecimal(row.inputQuantity, '投入'); const used = reviewDecimal(row.usedQuantity, '使用'); const loss = reviewDecimal(row.lossQuantity, '损耗'); const unused = reviewDecimal(row.unusedQuantity, '余料');
    if (!inputQty.eq(used.add(loss).add(unused))) reviewReject('INVALID_SUPPLY_BALANCE', '投入必须等于用于产品、损耗及余料之和');
    const aggregate = (supplyInput.get(movement.id) ?? new Prisma.Decimal(0)).add(inputQty); supplyInput.set(movement.id, aggregate);
    if (aggregate.gt(amount(movement.quantity) ?? -1)) reviewReject('SUPPLY_QUANTITY_EXCEEDED', '供料汇总超过真实来源入库数量');
    const totalBill = cny(invoice.amount, invoice.currency, invoice.exchangeRate, invoice.baseCurrency); const totalAccepted = amount(line.receivedQuantity);
    if (!totalBill || !totalAccepted?.gt(0) || !formal(invoice)) add('HISTORICAL_SUPPLY_VALUATION_UNVERIFIED');
    else breakdown.companySupply = breakdown.companySupply.add(totalBill.div(totalAccepted).mul(used.add(loss)).toDecimalPlaces(4));
    evidence(row.evidenceIds, 'SUPPLY_RECONCILIATION_EVIDENCE_MISSING');
  }
  for (const bill of input.bills.filter(row => row.treatment === 'stock_valuation')) if (!input.supply.some(row => row.valuationInvoiceId === bill.invoiceId)) add('COMPANY_SUPPLY_RECONCILIATION_MISSING');
  const seenExpenses = new Set<string>();
  for (const row of input.expenses) {
    const cost = s.costRecords.find(source => source.id === row.costRecordId);
    if (!cost) reviewReject('INVALID_COST_SOURCE', '费用不属于本订单');
    if (seenExpenses.has(cost.id)) reviewReject('DUPLICATE_COST_SOURCE', '同一费用不可重复归集'); seenExpenses.add(cost.id);
    evidence(row.evidenceIds, 'EXPENSE_REVIEW_EVIDENCE_MISSING');
    // Order expenses have no development-case upload route. Their individually
    // bound, audited review attachments are real evidence too; do not require an
    // unavailable legacy CostEvidence upload as an additional permanent gate.
    if (cost.currency !== 'CNY') evidence(row.fxEvidenceIds ?? [], 'EXPENSE_FX_EVIDENCE_MISSING');
    const value = cny(cost.amount, cost.currency, row.exchangeRate);
    if (!value) add('EXPENSE_AMOUNT_OR_FX_MISSING'); else if (row.treatment === 'cost') breakdown[row.category] = breakdown[row.category].add(value);
  }
  if (s.costRecords.some(row => !seenExpenses.has(row.id))) add('ACTUAL_EXPENSE_COVERAGE_MISSING');
  for (const voucher of s.vouchers) {
    const fee = amount(voucher.bankFee); if (!fee) { add('BANK_FEE_UNKNOWN'); continue; } if (fee.isZero()) continue;
    if (voucher.orderId !== s.order.id || s.voucherAllocations.some(row => row.voucherId === voucher.id && !s.invoices.some(invoice => invoice.id === row.invoiceId && !s.invoiceOrders.some(link => link.invoiceId === invoice.id && link.orderId !== s.order.id)))) { add('BANK_FEE_ORDER_SHARE_UNVERIFIED'); continue; }
    const value = cny(fee, voucher.currency, voucher.exchangeRate, voucher.baseCurrency); if (!value) add('BANK_FEE_FX_MISSING'); else breakdown.bankFees = breakdown.bankFees.add(value);
  }
  for (const allocation of s.creditAllocations) {
    const note = s.creditNotes.find(row => row.id === allocation.creditNoteId); const invoice = s.invoices.find(row => row.id === allocation.invoiceId);
    if (!note || note.deletedAt != null || note.status === 'Cancelled' || !invoice || invoice.type !== 'Receivable') { add('ALLOWANCE_SOURCE_UNVERIFIED'); continue; }
    if (s.invoiceOrders.some(row => row.invoiceId === invoice.id && row.orderId !== s.order.id)) { add('ALLOWANCE_ORDER_SHARE_UNVERIFIED'); continue; }
    const value = cny(allocation.appliedAmount, note.currency, invoice.exchangeRate, invoice.baseCurrency);
    if (note.currency !== invoice.currency || !value) add('ALLOWANCE_AMOUNT_OR_FX_MISSING'); else breakdown.allowances = breakdown.allowances.add(value);
  }
  const actualBreakdown = Object.fromEntries(COST_CATEGORIES.map(key => [key, Number(breakdown[key].toDecimalPlaces(4))])) as Record<CostCategory, number>;
  for (const category of COST_CATEGORIES) if (input.coverage[category].status === 'not_applicable' && (breakdown[category].gt(0) || category === 'procurement' && s.purchaseOrders.length > 0 || category === 'companySupply' && input.supply.length > 0 || ['logistics', 'otherExpenses'].includes(category) && input.expenses.some(row => row.category === category && row.treatment === 'cost'))) add(`INVALID_NOT_APPLICABLE:${category}`);
  const total = COST_CATEGORIES.reduce((sum, key) => sum.add(breakdown[key]), new Prisma.Decimal(0)).toDecimalPlaces(4);
  if (total.gte('100000000000000') || revenue.gte('100000000000000') || !new Prisma.Decimal(Number(total)).eq(total) || !new Prisma.Decimal(Number(revenue)).eq(revenue)) add('ACTUAL_TOTAL_OUT_OF_RANGE');
  return { status: reasons.size ? 'pending' as const : 'complete' as const, pendingReasons: [...reasons].sort(), actualCostCny: reasons.size ? null : Number(total), actualRevenueCny: reasons.size ? null : Number(revenue.toDecimalPlaces(4)), actualBreakdown, scopeSnapshot: { orderId: s.order.id, orderLineIds: s.orderLines.map(row => row.id).sort(), revenueInvoiceIds: revenueIds.sort(), shipmentAllocationIds: s.shipmentAllocations.map(row => row.id).sort(), range: 'whole_order_final', ...(operativeInternal.length || input.internalTransfers !== undefined ? { internalRevenueTransferIds: internalRevenueTransferIds.sort(), internalPurchaseTransferIds: internalPurchaseTransferIds.sort() } : {}) } };
}
