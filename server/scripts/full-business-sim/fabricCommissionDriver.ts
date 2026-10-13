/** No database or business-state seed. The actual supplier owes us commission;
 * a customer's goods payment never passes through this driver. */
import { createHash } from 'node:crypto';
import type { ScenarioMasterData } from './masterData';
import type { OrderScenario } from './scenarios';
import { scenarioCommand, type ScenarioDriverDependencies, type ScenarioExecution } from './driverContract';

export type FabricCommissionScenarioContext = { master: ScenarioMasterData; scenario: OrderScenario; orderId: string; lineId: string; deps: ScenarioDriverDependencies };
export type FabricCommissionDriverOptions = { rate: string; businessDate: string;
  paymentPlan?: { amount: string; cashAccountId: string; bankReference: string } };
const enc = encodeURIComponent, scale = BigInt(10000);
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
function decimal(value: unknown): bigint {
  ensure(typeof value === 'string' && /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value), 'COMMISSION_DECIMAL_INVALID');
  const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * scale + BigInt(fraction.padEnd(4, '0'));
}
function uuid(key: string) { const h = createHash('sha256').update(`bambook-commission:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; }
function validate(c: FabricCommissionScenarioContext, rate: string) {
  ensure(c.scenario.family === 'fabric' && c.orderId && c.lineId && c.deps.runtimeId
    && Object.values(c.master.cast).every(actor => c.deps.actorIds[actor.key] === actor.id), 'COMMISSION_ACTUAL_SOURCE_OR_ACTOR_MISMATCH');
  ensure(decimal(rate) > BigInt(0) && decimal(rate) <= BigInt(100) * scale, 'COMMISSION_EXPLICIT_PERCENT_REQUIRED');
  ensure(c.master.catalog.suppliers.some(row => row.id === c.scenario.supplierId && row.kind === 'fabric_mill'), 'COMMISSION_ACTUAL_SUPPLIER_REQUIRED');
}
async function read(c: FabricCommissionScenarioContext, actor: OrderScenario['owner'], url: string) {
  await c.deps.verifyActor(actor); const response = await c.deps.invoke(actor, 'get', url);
  ensure(response.status === 200 && response.body?.ok !== false, `COMMISSION_READ_REJECTED: ${url}: ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
}
async function write(c: FabricCommissionScenarioContext, step: string, actor: OrderScenario['owner'], url: string,
  body: unknown | (() => Promise<unknown>), idempotent = true) {
  const key = `${c.scenario.key}:commission.${step}`, previous = await c.deps.journal.read(key);
  const input = typeof body === 'function' ? previous ? previous.body : await body() : body;
  return scenarioCommand(c.deps, { key, actor, method: 'post', url, body: input, idempotent });
}

/** Called after an accurate draft line exists and before actual main approval.
 * A generic PUT is not falsely declared idempotent: unknown ACK requires its
 * journal/readback reconciliation instead of blindly rewriting an approved row. */
export async function prepareFabricCommissionTerms(c: FabricCommissionScenarioContext, options: Pick<FabricCommissionDriverOptions, 'rate'>) {
  validate(c, options.rate);
  const body = { fabricSupplyMode: 'commission', fabricCommissionRate: options.rate, fabricCommissionSupplierId: c.scenario.supplierId };
  await scenarioCommand(c.deps, { key: `${c.scenario.key}:commission.terms`, actor: c.scenario.owner, method: 'put',
    url: `/api/v1/order-lines/${enc(c.lineId)}`, body });
  const current = (await read(c, c.scenario.owner, `/api/v1/order-lines?orderId=${enc(c.orderId)}`)).lines?.find((line: { id: string }) => line.id === c.lineId);
  ensure(current?.id === c.lineId && current.orderId === c.orderId && current.fabricSupplyMode === 'commission'
    && decimal(String(current.fabricCommissionRate)) === decimal(options.rate) && current.fabricCommissionSupplierId === c.scenario.supplierId,
    'COMMISSION_DRAFT_TERMS_READBACK_MISMATCH');
}

export async function runFabricCommissionScenario(c: FabricCommissionScenarioContext, options: FabricCommissionDriverOptions): Promise<ScenarioExecution> {
  const result: ScenarioExecution = { key: c.scenario.key, earnedSteps: [], stopReached: false, ids: {} };
  let at = 'commission.source';
  try {
    validate(c, options.rate);
    ensure(/^\d{4}-\d{2}-\d{2}$/.test(options.businessDate), 'COMMISSION_BUSINESS_DATE_REQUIRED');
    const base = `/api/v1/orders/${enc(c.orderId)}/fabric-commission`;
    const current = await read(c, c.scenario.owner, base), source = current.source ?? current.documents?.[0]?.snapshot?.source;
    const own = source?.financialLines?.find((row: Record<string, unknown>) => row.id === c.lineId);
    ensure(source?.orderId === c.orderId && source.customerId === c.scenario.customerId && source.currency === c.scenario.currency
      && own?.fabricSupplyMode === 'commission' && own.fabricCommissionSupplierId === c.scenario.supplierId
      && decimal(String(own.fabricCommissionRate)) === decimal(options.rate), 'COMMISSION_APPROVED_SOURCE_MISMATCH');
    result.earnedSteps.push('commission.whole-order-shipped-source-readback');
    at = 'commission.settle';
    const settled = await write(c, 'settle', c.scenario.owner, `${base}/settle`, async () => ({
      requestKey: uuid(`${c.scenario.key}:settle`), expectedSourceFingerprint: source.sourceFingerprint,
      note: '全单实际出运后一次结算；客户货款直接支付供应商，供应商另向我方支付约定佣金。' }));
    ensure(settled.receipt?.orderId === c.orderId && settled.receipt.sourceFingerprint === source.sourceFingerprint
      && typeof settled.receipt.settlementId === 'string' && Array.isArray(settled.receipt.documents) && settled.receipt.documents.length === 1,
      'COMMISSION_ORIGINAL_SETTLEMENT_ACK_MISSING');
    const doc = settled.receipt.documents[0];
    ensure(doc.supplierId === c.scenario.supplierId && doc.currency === c.scenario.currency && decimal(String(doc.amount)) > BigInt(0),
      'COMMISSION_ORIGINAL_PAYER_OR_AMOUNT_MISMATCH');
    const reread = await read(c, c.scenario.owner, base);
    ensure(reread.settled === true && reread.receipt?.settlementId === settled.receipt.settlementId
      && reread.receipt.documents[0]?.versionId === doc.versionId, 'COMMISSION_SETTLEMENT_READBACK_MISMATCH');
    result.ids.commissionSettlementId = settled.receipt.settlementId; result.ids.commissionDocumentId = doc.documentId;
    result.ids.commissionDocumentVersionId = doc.versionId;
    result.earnedSteps.push('commission.original-ci-issued-readback');
    at = 'commission.register-ar';
    const financeBase = `/api/v1/finance/fabric-commission-cis/${enc(doc.documentId)}`;
    const original = await read(c, c.scenario.finance, financeBase);
    ensure(original.snapshot?.source?.sourceFingerprint === source.sourceFingerprint && original.version?.id === doc.versionId
      && original.group?.supplierId === c.scenario.supplierId && decimal(String(original.group?.commissionAmount)) === decimal(String(doc.amount)),
      'COMMISSION_FINANCE_ORIGINAL_READBACK_MISMATCH');
    const registered = await write(c, 'register-ar', c.scenario.finance, `${financeBase}/register`, {
      requestKey: uuid(`${c.scenario.key}:register`), expectedVersionId: doc.versionId, expectedSourceFingerprint: source.sourceFingerprint });
    const invoice = registered.invoice;
    ensure(invoice?.id && invoice.type === 'Receivable' && invoice.sourceType === 'FabricCommissionCI' && invoice.sourceId === doc.versionId
      && invoice.orderId === c.orderId && invoice.customerRelationId === c.scenario.supplierId && invoice.currency === doc.currency
      && decimal(String(invoice.amount)) === decimal(String(doc.amount)), 'COMMISSION_NATIVE_AR_ACK_MISMATCH');
    result.ids.commissionInvoiceId = invoice.id;
    const ar = async () => {
      const row = (await read(c, c.scenario.finance, `/api/v2/finance/invoices/${enc(invoice.id)}`)).invoice;
      const applied = await read(c, c.scenario.finance, `/api/v1/finance/allocations?invoiceId=${enc(invoice.id)}`);
      ensure(row?.sourceId === doc.versionId && row.customerRelationId === c.scenario.supplierId && decimal(String(row.amount)) === decimal(String(doc.amount))
        && Array.isArray(applied.items) && applied.total === applied.items.length, 'COMMISSION_AR_CURRENT_OR_ALLOCATIONS_MISMATCH');
      return { row, applied: applied.items.reduce((sum: bigint, value: { appliedAmount: unknown }) => sum + decimal(String(value.appliedAmount)), BigInt(0)) };
    };
    if (!options.paymentPlan) {
      const actual = await ar(); ensure(actual.row.status === 'Issued' && actual.applied === BigInt(0), 'COMMISSION_PENDING_AR_NOT_UNPAID');
      result.earnedSteps.push('commission.ar.unpaid-readback'); result.stopReached = true; return result;
    }
    const plan = options.paymentPlan, paid = decimal(plan.amount);
    ensure(paid > BigInt(0) && paid <= decimal(String(doc.amount)) && plan.cashAccountId && plan.bankReference, 'COMMISSION_EXPLICIT_ACTUAL_RECEIPT_REQUIRED');
    at = 'commission.actual-supplier-receipt';
    const payment = (await write(c, 'actual-supplier-receipt', c.scenario.finance, '/api/v2/finance/payments', async () => {
      const account = (await read(c, c.scenario.finance, `/api/v1/finance/cash-accounts/${enc(plan.cashAccountId)}`)).account;
      ensure(account?.id === plan.cashAccountId && account.currency === doc.currency && Number.isSafeInteger(account.revision), 'COMMISSION_CURRENT_CASH_ACCOUNT_MISMATCH');
      return { requestKey: uuid(`${c.scenario.key}:receipt`), companyAccountId: account.id, expectedAccountRevision: account.revision,
        type: 'Receipt', amount: plan.amount, actualAccountAmount: plan.amount, bankFee: '0', feeBearer: 'OUR', currency: doc.currency,
        bankReference: plan.bankReference, paymentDate: options.businessDate, paymentMethod: 'TT', customerRelationId: c.scenario.supplierId,
        customerName: original.group.party.name, notes: '供应商支付我方佣金，非客户货款、非审批自动生成。' };
    })).payment;
    ensure(payment?.id && payment.cashEntryId && payment.customerRelationId === c.scenario.supplierId && payment.currency === doc.currency
      && decimal(String(payment.amount)) === paid, 'COMMISSION_SUPPLIER_RECEIPT_ACK_MISSING');
    result.ids.commissionReceiptVoucherId = payment.id; result.ids.commissionCashEntryId = payment.cashEntryId;
    at = 'commission.allocate-supplier-receipt';
    const allocation = (await write(c, 'allocate-supplier-receipt', c.scenario.finance, '/api/v1/finance/allocations', {
      invoiceId: invoice.id, voucherId: payment.id, appliedAmount: plan.amount, appliedDate: options.businessDate }, false)).allocation;
    ensure(allocation?.id && allocation.invoiceId === invoice.id && allocation.voucherId === payment.id && decimal(String(allocation.appliedAmount)) === paid,
      'COMMISSION_SUPPLIER_ALLOCATION_ACK_MISSING');
    result.ids.commissionReceiptAllocationId = allocation.id;
    const actual = await ar(), cash = await read(c, c.scenario.finance, `/api/v1/finance/cash-accounts/${enc(plan.cashAccountId)}`);
    ensure(actual.applied === paid && actual.row.status === (paid === decimal(String(doc.amount)) ? 'Paid' : 'PartiallyPaid')
      && cash.entries?.some((entry: { id: string; sourceVoucherId: string; amount: unknown }) => entry.id === payment.cashEntryId
        && entry.sourceVoucherId === payment.id && decimal(String(entry.amount)) === paid), 'COMMISSION_ACTUAL_BANK_AR_READBACK_MISMATCH');
    result.earnedSteps.push('commission.ar.supplier-cash-allocation-readback'); result.stopReached = true;
  } catch (error) { result.blockedAt = `${at}: ${error instanceof Error ? error.message : String(error)}`; }
  return result;
}
