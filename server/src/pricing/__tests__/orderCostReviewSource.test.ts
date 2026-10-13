/** Pure source/amount rules only: these synthetic facts do not prove PG audit, authorization, files or UAT. */
import { describe, expect, it } from 'vitest';
import { COST_CATEGORIES, calculateOrderCostReview, parseOrderCostReviewInput, reviewHash, type OrderCostReviewInput, type OrderCostSources } from '../orderCostReviewSource';
import { maskProfitSheet, readCostEvidence } from '../costEvidence';

function fixture() {
  const source: OrderCostSources = {
    order: { id: 'O1', status: 'Completed', deletedAt: null }, orderLines: [{ id: 'OL1', orderId: 'O1', quantity: '100', unit: 'PC' }],
    purchaseOrders: [{ id: 'PO1', orderId: 'O1', status: 'Received', currency: 'CNY', supplierRelationId: 'SUP1', lines: [{ id: 'PL1', kind: 'FinishedGoods', orderLineId: 'OL1', quantity: '100', receivedQuantity: '100', rejectedQuantity: '0', materialCode: 'FG1', unit: 'PC' }], receipts: [{ id: 'MR1' }] }],
    deliveries: [], receiptAudits: [{ id: 'A1', detail: { after: { receiptId: 'MR1', lineReceipts: [{ lineId: 'PL1', materialCode: 'FG1', unit: 'PC', accepted: '100', rejected: '0' }] } } }],
    invoices: [{ id: 'AR1', orderId: 'O1', type: 'Receivable', status: 'Issued', amount: '2000', currency: 'CNY' }, { id: 'AP1', orderId: 'O1', type: 'Payable', status: 'Issued', customerRelationId: 'SUP1', sourceType: 'PurchaseOrder', sourceId: 'PO1', amount: '1200', currency: 'CNY' }], invoiceOrders: [], costRecords: [], costEvidence: [], shipments: [{ id: 'SH1', status: 'Shipped' }], shipmentAllocations: [{ id: 'SA1', shipmentId: 'SH1', orderId: 'O1', orderLineId: 'OL1', status: 'Fulfilled', actualQty: '100', unit: 'PC' }], batches: [], movements: [], inventory: [], voucherAllocations: [], vouchers: [], creditAllocations: [], creditNotes: [], internalTransfers: [],
  };
  const input: OrderCostReviewInput = { sourceFingerprint: reviewHash(source), bills: [{ invoiceId: 'AP1', purchaseOrderId: 'PO1', purchaseLineIds: ['PL1'], serviceDeliveryIds: [], treatment: 'cost', evidenceIds: ['E1'] }], supply: [], expenses: [], coverage: Object.fromEntries(COST_CATEGORIES.map(category => [category, { status: category === 'procurement' ? 'verified' : 'not_applicable', note: 'Synthetic financial reconciliation evidence', evidenceIds: ['E1'] }])) as OrderCostReviewInput['coverage'] };
  const calculate = () => { input.sourceFingerprint = reviewHash(source); return calculateOrderCostReview(source, input, new Set(['E1'])); };
  return { source, input, calculate };
}
describe('whole-order actual cost review independent source contract', () => {
  it('formal supplier bill establishes 1200 actual cost independently of PO price and payments', () => {
    const x = fixture(); x.source.purchaseOrders[0].totalAmount = '999999';
    x.source.vouchers.push({ id: 'PV1', orderId: 'O1', amount: '1200', bankFee: '0', currency: 'CNY' });
    expect(x.calculate()).toMatchObject({ status: 'complete', actualCostCny: 1200, actualRevenueCny: 2000, actualBreakdown: { procurement: 1200, companySupply: 0 } });
  });
  it('Draft bill, partial shipment, pending expenses and receipt/source mismatch cannot complete', () => {
    for (const mutate of [
      (s: OrderCostSources, _i: OrderCostReviewInput) => { s.invoices[1].status = 'Draft'; },
      (s: OrderCostSources, _i: OrderCostReviewInput) => { s.shipmentAllocations[0].actualQty = '50'; },
      (_s: OrderCostSources, i: OrderCostReviewInput) => { i.coverage.otherExpenses.status = 'pending'; },
      (s: OrderCostSources, _i: OrderCostReviewInput) => { s.receiptAudits[0].detail.after.lineReceipts[0].accepted = '99'; },
    ]) { const x = fixture(); mutate(x.source, x.input); expect(x.calculate()).toMatchObject({ status: 'pending', actualCostCny: null, actualRevenueCny: null }); }
  });
  it('unselected actual cost or formal supplier invoice remains a missing source, never implicit zero', () => {
    const x = fixture(); x.source.costRecords.push({ id: 'CR1', amount: '60', currency: 'CNY' });
    expect(x.calculate().pendingReasons).toContain('ACTUAL_EXPENSE_COVERAGE_MISSING');
    x.source.invoices.push({ id: 'AP2', type: 'Payable', status: 'Issued', amount: '100', currency: 'CNY' });
    expect(x.calculate().pendingReasons).toContain('SUPPLIER_BILL_COVERAGE_MISSING');
  });
  it('duplicate economic sources and foreign order/source are rejected', () => {
    const x = fixture(); x.input.bills.push({ ...x.input.bills[0] });
    expect(x.calculate).toThrow('同一实际账单不可重复归集');
    x.input.bills.pop(); x.source.invoices[1].orderId = 'O2';
    expect(x.calculate).toThrow('采购账单与订单/供应商来源不一致');
  });
  it('multi-order invoice missing an explicit allocation does not become whole-order revenue', () => {
    const x = fixture(); x.source.invoiceOrders.push({ id: 'IOA1', invoiceId: 'AR1', orderId: 'O1', allocatedAmount: null }, { id: 'IOA2', invoiceId: 'AR1', orderId: 'O2', allocatedAmount: '1000' });
    expect(x.calculate().pendingReasons).toContain('REVENUE_RANGE_OR_FX_UNVERIFIED');
  });
  it('unknown foreign-currency bill is pending; fixed invoice FX is authoritative', () => {
    const x = fixture(); x.source.invoices[1].currency = 'USD'; x.source.purchaseOrders[0].currency = 'USD';
    expect(x.calculate().pendingReasons).toContain('BILL_AMOUNT_OR_FX_MISSING');
    x.source.invoices[1].exchangeRate = '7'; expect(x.calculate().actualCostCny).toBe(8400);
  });
  it('company supply 600 input,500 used,100 unused costs 5000 at historical bill value; no stock current-price fallback', () => {
    const x = fixture(); const line = x.source.purchaseOrders[0].lines[0]; Object.assign(line, { kind: 'Material', quantity: '600', receivedQuantity: '600', unit: 'M', materialCode: 'M1' });
    Object.assign(x.source.receiptAudits[0].detail.after.lineReceipts[0], { materialCode: 'M1', accepted: '600', unit: 'M' });
    x.source.invoices[1].amount = '6000'; x.input.bills[0].treatment = 'stock_valuation';
    x.source.movements.push({ id: 'SM1', itemId: 'ST1', quantity: '600', unit: 'M', referenceId: 'MR1', notes: 'L8-source:'+JSON.stringify({ receiptId: 'MR1', lineId: 'PL1', quantity: 600, unit: 'M' }) });
    x.source.inventory.push({ id: 'ST1', ownership: 'Owned', unitCost: '9999' });
    x.input.supply.push({ movementId: 'SM1', valuationInvoiceId: 'AP1', orderLineId: 'OL1', inputQuantity: '600', usedQuantity: '500', lossQuantity: '0', unusedQuantity: '100', unit: 'M', evidenceIds: ['E1'] }); x.input.coverage.companySupply.status = 'verified';
    expect(x.calculate()).toMatchObject({ status: 'complete', actualCostCny: 5000, actualBreakdown: { procurement: 0, companySupply: 5000 } });
    x.input.supply[0].unusedQuantity = '99'; expect(x.calculate).toThrow('投入必须等于用于产品、损耗及余料之和');
    x.input.supply[0].unusedQuantity = '100'; x.input.supply[0].inputQuantity = '601'; x.input.supply[0].lossQuantity = '1'; expect(x.calculate).toThrow('供料汇总超过真实来源入库数量');
  });
  it('same physical source reused for several lines cannot exceed its original quantity', () => {
    const x = fixture(); x.source.purchaseOrders[0].lines[0].kind = 'Material'; x.input.bills[0].treatment = 'stock_valuation';
    x.source.movements.push({ id: 'SM1', itemId: 'ST1', quantity: '100', unit: 'PC', referenceId: 'MR1', notes: 'L8-source:'+JSON.stringify({ receiptId: 'MR1', lineId: 'PL1', quantity: 100, unit: 'PC' }) }); x.source.inventory.push({ id: 'ST1', ownership: 'Owned' });
    const supply = { movementId: 'SM1', valuationInvoiceId: 'AP1', orderLineId: 'OL1', inputQuantity: '60', usedQuantity: '60', lossQuantity: '0', unusedQuantity: '0', unit: 'PC', evidenceIds: ['E1'] };
    x.input.supply = [supply, { ...supply }]; expect(x.calculate).toThrow('供料汇总超过真实来源入库数量');
  });
  it('unknown inputs, empty/nonnumeric quantities, unsupported money/actor flags reject before execution', () => {
    const x = fixture(); for (const raw of [{ ...x.input, actualCostCny: 0 }, { ...x.input, actorId: 'fake' }, { ...x.input, complete: true }]) expect(() => parseOrderCostReviewInput(raw)).toThrow();
    for (const q of ['', '-1', 'NaN', '1.00001', true]) expect(() => parseOrderCostReviewInput({ ...x.input, supply: [{ movementId: 'M', valuationInvoiceId: 'I', orderLineId: 'OL1', inputQuantity: q, usedQuantity: '0', lossQuantity: '0', unusedQuantity: '0', unit: 'M', evidenceIds: ['E1'] }] })).toThrow();
  });
  it('source fingerprint detects a real amount/version change without relying on a client complete flag', () => {
    const x = fixture(); x.source.invoices[1].amount = '1100'; expect(() => calculateOrderCostReview(x.source, x.input, new Set(['E1']))).toThrow('来源已变化');
    expect(reviewHash({ a: 1, b: [{ id: 'X' }, { id: 'Y' }] })).toBe(reviewHash({ b: [{ id: 'Y' }, { id: 'X' }], a: 1 }));
  });
  it('new complete DTO requires exact reviewed scope and consistent six-category totals', () => {
    const costEvidence = { version: 2, status: 'complete', calculatedAt: '2026-10-01', pendingReasons: [], committedAmountCny: 9999, acceptedAmountCny: 1200, paidPrincipalCny: 500, actualCostCny: 1200, actualProfitCny: 800, actualRevenueCny: 2000, reviewId: 'R1', reviewRevision: 1, sourceFingerprint: 'a'.repeat(64), actualBreakdown: { procurement: 1200, companySupply: 0, logistics: 0, otherExpenses: 0, bankFees: 0, allowances: 0 } };
    expect(readCostEvidence({ costEvidence })?.actualCostCny).toBe(1200);
    expect(maskProfitSheet({ details: { costEvidence }, grossProfit: -9999, grossMargin: -50 })).toMatchObject({ grossProfit: 800, grossMargin: 40 });
    for (const patch of [{ reviewId: undefined }, { actualRevenueCny: NaN }, { actualBreakdown: { ...costEvidence.actualBreakdown, logistics: 1 } }]) expect(readCostEvidence({ costEvidence: { ...costEvidence, ...patch } })).toBeNull();
  });
});

/** Native authority/audit/SQL are tested separately in opt-in PG. These are
 * deliberately synthetic verified DAO facts, testing only range/math rules. */
function internalFixture(side: 'garment' | 'fabric') {
  const x = fixture();
  const payload = { docType: 'DR033_INTERNAL_FABRIC_SUPPLY', schemaVersion: 2, role: 'master', masterId: 'ITG', mirrorId: 'ITF', garmentOrderId: 'O1', fabricOrderId: 'F1', garmentOrderLineId: 'OL1', fabricOrderLineId: 'FL1', status: 'Closed', confirmedQuantity: 100, deliveries: [{ id: 'D1', quantity: 100, receivedQuantity: 100, variance: 0 }], receipts: [{ id: 'R1', deliveryId: 'D1', quantity: 100 }] };
  const master = { id: 'ITG', orderId: 'O1', transferAmount: '300.0001', transferCurrency: 'CNY', memo: JSON.stringify(payload) };
  const mirror = { id: 'ITF', orderId: 'F1', transferAmount: '300.0001', transferCurrency: 'CNY', memo: JSON.stringify({ ...payload, role: 'mirror' }) };
  const facts: any = { master, mirror, payload, orders: [{ id: 'O1' }, { id: 'F1' }], approval: { id: 'AR_NATIVE' }, decisionAudit: { id: 'DECIDE1' }, confirmationAudit: { id: 'CONFIRM1' }, deliveries: [{ audit: { id: 'DA1' } }], receipts: [{ audit: { id: 'RA1' } }] };
  if (side === 'fabric') {
    x.source.order = { id: 'F1', status: 'Completed', deletedAt: null, isInternalFabricTrade: true };
    x.source.orderLines = [{ id: 'FL1', orderId: 'F1', quantity: '100', unit: 'PC' }];
    x.source.shipmentAllocations[0].orderId = 'F1'; x.source.shipmentAllocations[0].orderLineId = 'FL1';
    x.source.invoices = []; x.source.purchaseOrders = []; x.source.receiptAudits = []; x.input.bills = [];
    x.input.coverage.procurement.status = 'not_applicable';
  }
  const record = side === 'fabric' ? mirror : master;
  x.source.internalTransfers = [record]; x.source.internalFacts = [{ recordId: record.id, status: 'verified', facts }];
  x.input.internalTransfers = [{ masterId: 'ITG', mirrorId: 'ITF', garmentOrderLineId: 'OL1', fabricOrderLineId: 'FL1', deliveryIds: ['D1'], evidenceIds: ['E1'] }];
  return x;
}
describe('internal supply actual cost/revenue range (pure, synthetic native DAO facts)', () => {
  it('approved received internal supply adds exact garment procurement cost without an external AP', () => {
    const x = internalFixture('garment');
    expect(x.calculate()).toMatchObject({ status: 'complete', actualCostCny: 1500.0001, actualRevenueCny: 2000, scopeSnapshot: { internalPurchaseTransferIds: ['ITG'], internalRevenueTransferIds: [] } });
  });
  it('fabric uses the same native mirror income instead of requiring an external commercial invoice', () => {
    const x = internalFixture('fabric');
    expect(x.calculate()).toMatchObject({ status: 'complete', actualCostCny: 0, actualRevenueCny: 300.0001, scopeSnapshot: { revenueInvoiceIds: [], internalRevenueTransferIds: ['ITF'], internalPurchaseTransferIds: [] } });
  });
  it('unbound or unverified real pair remains pending; history recognizedAt is insufficient', () => {
    const x = internalFixture('fabric'); x.input.internalTransfers = [];
    expect(x.calculate()).toMatchObject({ status: 'pending', actualCostCny: null, actualRevenueCny: null });
    x.source.internalFacts = [{ recordId: 'ITF', status: 'pending', reason: 'INVALID_COST_SOURCE' }];
    expect(x.calculate().pendingReasons).toContain('INTERNAL_TRADE_COST_SCOPE_UNVERIFIED');
  });
  it('wrong mirror, stable line, partial delivery range and duplicate pair reject, never guess by code', () => {
    for (const change of [
      (i: OrderCostReviewInput) => { i.internalTransfers![0].mirrorId = 'FOREIGN'; },
      (i: OrderCostReviewInput) => { i.internalTransfers![0].fabricOrderLineId = 'FOREIGN'; },
      (i: OrderCostReviewInput) => { i.internalTransfers![0].deliveryIds = []; },
    ]) { const x = internalFixture('fabric'); change(x.input); expect(x.calculate).toThrow('内部'); }
    const x = internalFixture('fabric'); x.input.internalTransfers!.push({ ...x.input.internalTransfers![0] }); expect(x.calculate).toThrow('内部交易主单不可重复归集');
  });
  it('short receipt and manually named Closed without full approved scope cannot confirm any amount', () => {
    for (const qty of [50, 99]) {
      const x = internalFixture('fabric'), p = x.source.internalFacts![0].facts!.payload;
      // A zero-variance partial delivery still must cover the complete approved quantity.
      p.deliveries[0].quantity = qty; p.deliveries[0].receivedQuantity = qty; p.receipts![0].quantity = qty;
      expect(x.calculate()).toMatchObject({ status: 'pending', actualCostCny: null, actualRevenueCny: null });
      expect(x.calculate().pendingReasons).toContain('INTERNAL_RECEIPT_SCOPE_UNVERIFIED');
    }
  });
  it('internal range proof is mandatory, and current peer/audit/source changes invalidate the source hash', () => {
    const x = internalFixture('fabric'); x.input.internalTransfers![0].evidenceIds = [];
    expect(x.calculate().pendingReasons).toContain('INTERNAL_REVIEW_EVIDENCE_MISSING');
    x.input.sourceFingerprint = reviewHash(x.source); x.source.internalFacts![0].facts!.mirror.transferAmount = '400';
    expect(() => calculateOrderCostReview(x.source, x.input, new Set(['E1']))).toThrow('来源已变化');
  });
  it('old clients omit the new optional field with exactly unchanged command shape and external scope', () => {
    const x = fixture(), parsed = parseOrderCostReviewInput(x.input);
    expect(parsed).not.toHaveProperty('internalTransfers'); expect(reviewHash(parsed)).toBe(reviewHash(x.input));
    expect(x.calculate().scopeSnapshot).not.toHaveProperty('internalRevenueTransferIds');
    expect(parseOrderCostReviewInput({ ...x.input, internalTransfers: [] })).toHaveProperty('internalTransfers', []);
  });
});
