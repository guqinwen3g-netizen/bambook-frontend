/** Business-owned development CI → finance registration → explicit bank
 * receipt/allocation. The caller owns target verification, login and journal.
 * No environment, database, transport construction or terminal-state writes. */
import { createHash } from 'node:crypto';
import { scenarioCommand, type ScenarioDriverDependencies } from './driverContract';
import type { ScenarioActorKey, ScenarioMasterData } from './masterData';
import type { DevelopmentScenario } from './scenarios';
import type { DevelopmentConfirmedArchive, DevelopmentDriverResult, DevelopmentScenarioExecution } from './developmentDriver';

type Row = Record<string, unknown>;
export interface DevelopmentFinanceFeePlan {
  /** Actual simulated batch-making expense, independently denominated. */
  costAmount: string; costCurrency: 'CNY' | 'USD';
  /** Original durable command notes when resuming an existing registration. */
  costNotes?: string; billingNote?: string;
  amount: string; currency: 'CNY' | 'USD';
  dueDate: string | null; paymentTerms: string;
}
export interface DevelopmentFinancePaymentPlan {
  amount: string; cashAccountId: string; bankReference: string;
}
export interface DevelopmentFinanceDriverOptions {
  /** Explicit overrides; no FX or inferred cost-to-fee conversion. */
  feePlans?: Record<string, DevelopmentFinanceFeePlan>;
  /** Explicit existing draft revision to refresh after a source repair. */
  ciBaseVersions?: Record<string, number>;
  /** Omission earns registered/unpaid AR only, never an automatic receipt. */
  paymentPlans?: Record<string, DevelopmentFinancePaymentPlan>;
}
export interface DevelopmentFinanceHandoffFact {
  scenarioKey: string; caseId?: string; documentId?: string; versionId?: string; invoiceId?: string;
  currency?: 'CNY' | 'USD'; amount?: string; appliedAmount?: string; openAmount?: string;
  receiptVoucherId?: string; allocationId?: string; cashAccountId?: string; cashEntryId?: string;
  state: 'blocked' | 'unpaid' | 'partially_paid' | 'paid'; blockedAt?: string; blockedReason?: string;
}
export interface DevelopmentFinanceDriverResult extends DevelopmentDriverResult { finance: DevelopmentFinanceHandoffFact[] }

const enc = encodeURIComponent, SCALE = BigInt(10000), ZERO = BigInt(0), BUSINESS_DATE = '2026-10-08';
const DEFAULT_FEE: DevelopmentFinanceFeePlan = { costAmount: '20', costCurrency: 'CNY', amount: '100', currency: 'USD',
  dueDate: '2026-11-08', paymentTerms: 'T/T within 30 days of the issued development CI' };
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
function object(value: unknown, label: string): Row {
  ensure(value && typeof value === 'object' && !Array.isArray(value), `INVALID_READBACK: ${label}`); return value as Row;
}
function list(value: unknown, label: string): Row[] {
  ensure(Array.isArray(value), `INVALID_READBACK: ${label}`); return value.map(v => object(v, label));
}
function text(value: unknown, label: string): string {
  ensure(typeof value === 'string' && value.trim(), `INVALID_READBACK: ${label}`); return value;
}
function money(value: unknown): bigint {
  ensure(typeof value === 'string' && /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value), 'SCENARIO_DECIMAL_INVALID');
  const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
}
const decimal = (value: bigint) => `${value / SCALE}.${String(value % SCALE).padStart(4, '0')}`;
const amountIs = (actual: unknown, expected: string) => money(String(actual)) === money(expected);
function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
}
function uuid(key: string): string {
  const hash = createHash('sha256').update(`development-finance-simulation:${key}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function cloneExecution(source: DevelopmentScenarioExecution): DevelopmentScenarioExecution {
  return { ...source, earnedSteps: [...source.earnedSteps], ids: Object.fromEntries(Object.entries(source.ids).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])) };
}

async function runOne(master: ScenarioMasterData, scenario: DevelopmentScenario, upstream: DevelopmentScenarioExecution,
  archives: DevelopmentConfirmedArchive[], deps: ScenarioDriverDependencies, options: DevelopmentFinanceDriverOptions) {
  const result = cloneExecution(upstream), fact: DevelopmentFinanceHandoffFact = { scenarioKey: scenario.key, state: 'blocked' };
  result.stopReached = false; delete result.blockedAt; delete result.blockedReason;
  let at = 'development_finance_validate_source';
  const earn = (step: string) => { if (!result.earnedSteps.includes(step)) result.earnedSteps.push(step); };
  const identity = (actor: ScenarioActorKey) => ensure(deps.runtimeId?.trim() && deps.actorIds[actor] === master.cast[actor]?.id, 'SCENARIO_RUNTIME_ACTOR_MASTER_MISMATCH');
  const ciBaseVersion = options.ciBaseVersions?.[scenario.key] ?? 0;
  ensure(Number.isSafeInteger(ciBaseVersion) && ciBaseVersion >= 0, 'SCENARIO_CI_BASE_VERSION_INVALID');
  const key = (step: string) => `${scenario.key}:development-finance:${step}${ciBaseVersion && ['save-ci', 'issue-ci'].includes(step) ? `:refresh-${ciBaseVersion}` : ''}`;
  const requestKey = (step: string) => uuid(key(step));
  const read = async (actor: ScenarioActorKey, url: string): Promise<Row> => {
    identity(actor); await deps.verifyActor(actor);
    const response = await deps.invoke(actor, 'get', url), body = object(response.body, url);
    ensure(response.status === 200 && body.ok !== false && !body.error, `READBACK_REJECTED: ${url}: HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
  };
  const command = async (step: string, actor: ScenarioActorKey, url: string, body: Row, idempotent = true, cas: string[] = [], expectedStatus: number | number[] = 200): Promise<Row> => {
    identity(actor); const previous = await deps.journal.read(key(step));
    const withoutCas = (v: unknown) => Object.fromEntries(Object.entries(object(v, step)).filter(([field]) => !cas.includes(field)));
    if (previous) ensure(JSON.stringify(canonical(withoutCas(previous.body))) === JSON.stringify(canonical(withoutCas(body))), `SCENARIO_COMMAND_CHANGED: ${key(step)}`);
    return object(await scenarioCommand(deps, { key: key(step), actor, method: 'post', url, body: previous ? previous.body : body,
      idempotent, expectedStatus }), step);
  };
  try {
    identity(scenario.owner); identity(scenario.finance);
    const team = master.businessTeams.find(t => t.key === scenario.teamKey && t.businessFamily === scenario.family);
    const customer = master.catalog.customers.find(c => c.id === scenario.customerId);
    ensure(team && customer && team.customerIds.includes(customer.id) && team.memberIds.includes(master.cast[scenario.owner].id)
      && master.cast[scenario.owner].id !== master.cast[scenario.finance].id, 'SCENARIO_ACTUAL_RESPONSIBILITY_MISMATCH');
    const candidates = archives.filter(a => a.scenarioKey === scenario.key);
    ensure(candidates.length === 1, 'SCENARIO_EXACT_CONFIRMED_ARCHIVE_REQUIRED');
    const source = candidates[0], caseId = source.caseId, path = `/api/v1/development/${enc(caseId)}`;
    ensure(source.family === scenario.family && source.customerId === scenario.customerId && source.ownerActorKey === scenario.owner
      && scenario.supplierIds.includes(source.factoryId) && source.assetId === upstream.ids.assetId && source.versionId === upstream.ids.versionId
      && source.batchId === upstream.ids.batchId && source.caseId === upstream.ids.caseId
      && ['qc_completed_pass', 'requester_confirmed', 'version_archived'].every(s => upstream.earnedSteps.includes(s)), 'SCENARIO_ARCHIVE_SOURCE_MISMATCH');
    fact.caseId = caseId;
    const development = object((await read(scenario.owner, path)).case, 'current development case');
    ensure(development.id === caseId && development.code === scenario.key && development.type === scenario.family
      && development.customerRelationId === customer.id && development.ownerId === master.cast[scenario.owner].id, 'SCENARIO_CURRENT_CASE_MISMATCH');
    const batches = list((await read(scenario.owner, `${path}/batches`)).batches, 'current factory batches');
    const matching = batches.filter(b => b.id === source.batchId && b.sampleVersionId === source.versionId);
    ensure(matching.length === 1, 'SCENARIO_CURRENT_EXACT_VERSION_REQUIRED');
    const batch = matching[0], qc = object(batch.latestFormalQcReview, 'latest formal QC'), confirmation = object(batch.versionConfirmation, 'actual requester confirmation');
    ensure(batch.developmentCaseId === caseId && batch.supplierRelationId === source.factoryId && object(batch.linkedAsset, 'version archive').id === source.assetId
      && qc.id === source.reviewId && qc.sampleVersionId === source.versionId && qc.result === 'pass' && ['reviewed', 'acknowledged'].includes(String(qc.status))
      && confirmation.id === source.confirmationId && confirmation.sampleVersionId === source.versionId && confirmation.result === 'approved', 'SCENARIO_CURRENT_ARCHIVE_FACT_CHANGED');
    const initialLifecycle = object((await read(scenario.owner, `${path}/closure-preview`)).closure, 'business lifecycle');
    const fee = options.feePlans?.[scenario.key] ?? DEFAULT_FEE, payment = options.paymentPlans?.[scenario.key];
    ensure(money(fee.costAmount) > ZERO && money(fee.amount) > ZERO && ['CNY', 'USD'].includes(fee.costCurrency)
      && ['CNY', 'USD'].includes(fee.currency) && typeof fee.paymentTerms === 'string', 'SCENARIO_FEE_PLAN_INVALID');
    ensure(!payment || money(payment.amount) > ZERO && money(payment.amount) <= money(fee.amount)
      && typeof payment.cashAccountId === 'string' && payment.cashAccountId.trim() && typeof payment.bankReference === 'string'
      && payment.bankReference.trim(), 'SCENARIO_PAYMENT_PLAN_INVALID');
    fact.currency = fee.currency; fact.amount = decimal(money(fee.amount));

    at = 'development_expense_registered';
    const expense = object((await command('register-batch-cost', scenario.owner, `${path}/costs`, { requestKey: requestKey('register-batch-cost'),
      sourceType: 'SampleBatch', sourceId: source.batchId, costType: 'sample_making', amount: fee.costAmount, currency: fee.costCurrency,
      incurredAt: BUSINESS_DATE, notes: fee.costNotes ?? `${scenario.key}，工厂准确返样 ${source.versionId} 的制作总费用；成本与对客收费分别记录。` })).costRecord, 'registered expense');
    const costId = text(expense.id, 'expense id'); result.ids.developmentCostId = costId;
    const costAck = object(expense.commandAck, 'expense original receipt');
    ensure(costAck.caseId === caseId && costAck.costRecordId === costId && costAck.actorId === master.cast[scenario.owner].id
      && costAck.requestKey === requestKey('register-batch-cost'), 'SCENARIO_EXPENSE_ACK_MISMATCH'); text(costAck.auditId, 'expense audit');
    const checkCost = (cost: Row) => ensure(cost.id === costId && cost.sourceType === 'SampleBatch' && cost.sourceId === source.batchId
      && cost.costType === 'sample_making' && amountIs(cost.amount, fee.costAmount) && cost.currency === fee.costCurrency
      && cost.incurredAt === BUSINESS_DATE, 'SCENARIO_EXPENSE_READBACK_MISMATCH');
    const expenseView = object(object(object((await read(scenario.owner, `${path}/expense-review-preview`)).review, 'expense review').snapshot, 'expense snapshot').costs, 'expense cost set');
    const actualCosts = list(expenseView.records, 'actual expenses').filter(c => c.id === costId); ensure(actualCosts.length === 1, 'SCENARIO_EXPENSE_READBACK_MISSING'); checkCost(actualCosts[0]); earn(at);

    at = 'development_customer_fee_saved';
    const billing = object((await command('create-customer-fee', scenario.owner, `${path}/billing-drafts`, { requestKey: requestKey('create-customer-fee'),
      amount: fee.amount, waivedAmount: '0', currency: fee.currency, note: fee.billingNote ?? `${scenario.key} 开发服务 ${fee.amount} ${fee.currency}，不以原币制作成本自动折算。` })).billingItem, 'business fee decision');
    const billingId = text(billing.id, 'billing id'); result.ids.developmentBillingItemId = billingId;
    const actualBilling = list((await read(scenario.owner, `${path}/billing-drafts`)).billingItems, 'current billing decisions').filter(b => b.id === billingId);
    ensure(actualBilling.length === 1 && actualBilling[0].sourceType === 'DevelopmentCase' && actualBilling[0].sourceId === caseId
      && actualBilling[0].bearerRelationId === customer.id && actualBilling[0].status !== 'cancelled'
      && amountIs(actualBilling[0].amount, fee.amount) && amountIs(actualBilling[0].waivedAmount, '0') && actualBilling[0].currency === fee.currency, 'SCENARIO_BILLING_READBACK_MISMATCH'); earn(at);
    const preview = await read(scenario.owner, `${path}/ci-source/${enc(billingId)}`), sourceFingerprint = text(preview.sourceFingerprint, 'CI source fingerprint');
    ensure(preview.caseId === caseId && preview.billingItemId === billingId && preview.currency === fee.currency && amountIs(preview.totalAmount, fee.amount)
      && /^[a-f0-9]{64}$/.test(sourceFingerprint), 'SCENARIO_CI_SOURCE_MISMATCH');
    const sourceCosts = list(preview.costs, 'CI expense sources').filter(c => c.id === costId); ensure(sourceCosts.length === 1, 'SCENARIO_CI_EXPENSE_SOURCE_MISSING'); checkCost(sourceCosts[0]);
    at = 'development_ci_saved';
    const saved = await command('save-ci', scenario.owner, `${path}/ci-commands`, { action: 'save', requestKey: requestKey('save-ci'), billingItemId: billingId,
      expectedVersion: ciBaseVersion, expectedSourceFingerprint: sourceFingerprint, fields: { issueDate: BUSINESS_DATE, dueDate: fee.dueDate,
        paymentTerms: fee.paymentTerms, note: `Development services · ${scenario.key}`,
        billTo: { name: customer.englishName || customer.name, address: customer.address },
        exporter: { nameEn: master.catalog.company.englishName, addressEn: master.catalog.company.address } } }, true, ['expectedSourceFingerprint']);
    const savedReceipt = object(saved.receipt, 'saved CI receipt'), documentId = text(savedReceipt.documentId, 'document id');
    const checkCiReceipt = (receipt: Row, action: 'save' | 'issue', version: number, step: string) => {
      ensure(receipt.action === action && receipt.version === version && receipt.documentId === documentId && receipt.caseId === caseId
        && receipt.billingItemId === billingId && receipt.actorId === master.cast[scenario.owner].id && receipt.requestKey === requestKey(step), 'SCENARIO_CI_ACK_MISMATCH');
      text(receipt.versionId, 'immutable CI version'); text(receipt.auditId, 'CI audit');
    };
    result.ids.developmentCiDocumentId = documentId; fact.documentId = documentId; checkCiReceipt(savedReceipt, 'save', ciBaseVersion + 1, 'save-ci'); earn(at);
    at = 'development_ci_issued';
    const issued = await command('issue-ci', scenario.owner, `${path}/ci-commands`, { action: 'issue', requestKey: requestKey('issue-ci'), billingItemId: billingId,
      documentId, expectedVersion: ciBaseVersion + 1, expectedSourceFingerprint: sourceFingerprint }, true, ['expectedSourceFingerprint']);
    const issuedReceipt = object(issued.receipt, 'issued CI receipt'); checkCiReceipt(issuedReceipt, 'issue', ciBaseVersion + 2, 'issue-ci');
    const versionId = text(issuedReceipt.versionId, 'issued CI version'); result.ids.developmentCiVersionId = versionId; fact.versionId = versionId;
    const original = await read(scenario.owner, `${path}/ci/${enc(documentId)}?version=${ciBaseVersion + 2}`), document = object(original.document, 'issued original'), version = object(original.version, 'issued version'), snapshot = object(original.snapshot, 'immutable CI snapshot');
    ensure(document.id === documentId && document.status === 'Issued' && version.id === versionId && version.documentId === documentId && version.version === ciBaseVersion + 2
      && snapshot.caseId === caseId && snapshot.billingItemId === billingId && snapshot.customerRelationId === customer.id
      && snapshot.issuedBy === master.cast[scenario.owner].id && snapshot.currency === fee.currency && amountIs(snapshot.totalAmount, fee.amount)
      && object(snapshot.command, 'original CI command').requestKey === requestKey('issue-ci'), 'SCENARIO_ISSUED_CI_READBACK_MISMATCH');
    const frozenCosts = list(snapshot.costs, 'original cost sources').filter(c => c.id === costId); ensure(frozenCosts.length === 1, 'SCENARIO_ISSUED_EXPENSE_SOURCE_MISSING'); checkCost(frozenCosts[0]); earn(at);

    at = 'development_ci_finance_registered';
    const pending = list((await read(scenario.finance, '/api/v1/finance/development-ci-pending')).items, 'finance pending originals');
    const ownPending = pending.filter(p => p.documentId === documentId);
    if (ownPending.length) ensure(ownPending.length === 1 && ownPending[0].versionId === versionId && ownPending[0].caseId === caseId
      && ownPending[0].customerRelationId === customer.id && ownPending[0].currency === fee.currency && amountIs(ownPending[0].amount, fee.amount), 'SCENARIO_FINANCE_PENDING_ORIGINAL_MISMATCH');
    const registered = await command('register-ar', scenario.finance, `/api/v1/finance/development-ci/${enc(documentId)}/register`, {
      requestKey: requestKey('register-ar'), expectedVersionId: versionId });
    const invoice = object(registered.invoice, 'registered receivable'), registrationReceipt = object(registered.receipt, 'finance registration original receipt');
    const invoiceId = text(invoice.id, 'invoice id'); result.ids.developmentReceivableInvoiceId = invoiceId; fact.invoiceId = invoiceId;
    ensure(invoice.type === 'Receivable' && invoice.sourceType === 'BusinessDevelopmentCI' && invoice.sourceId === versionId
      && invoice.customerRelationId === customer.id && invoice.currency === fee.currency && invoice.invoiceNumber === document.documentNumber
      && amountIs(invoice.amount, fee.amount) && registrationReceipt.operation === 'register_development_ci_receivable'
      && registrationReceipt.documentId === documentId && registrationReceipt.versionId === versionId && registrationReceipt.invoiceId === invoiceId
      && registrationReceipt.caseId === caseId && registrationReceipt.actorId === master.cast[scenario.finance].id
      && registrationReceipt.requestKey === requestKey('register-ar'), 'SCENARIO_REGISTERED_AR_MISMATCH'); text(registrationReceipt.auditId, 'finance registration audit'); earn(at);
    const projection = async () => {
      const current = await read(scenario.owner, `${path}/ci-finance`);
      ensure(current.caseId === caseId && current.customerRelationId === customer.id, 'SCENARIO_FINANCE_CASE_MISMATCH');
      const matches = list(current.items, 'case CI finance').filter(c => c.documentId === documentId && c.versionId === versionId);
      ensure(matches.length === 1, 'SCENARIO_FINANCE_PROJECTION_MISSING'); const item = matches[0], ar = object(item.invoice, 'case receivable');
      ensure(item.registrationState === 'registered' && item.billingItemId === billingId && item.currency === fee.currency && amountIs(item.amount, fee.amount)
        && ar.id === invoiceId && amountIs(ar.amount, fee.amount) && money(String(ar.appliedAmount)) + money(String(ar.openAmount)) === money(fee.amount), 'SCENARIO_FINANCE_PROJECTION_MISMATCH');
      return { item, ar };
    };
    await projection();
    if (payment) {
      at = 'development_actual_customer_receipt';
      const accountRead = await read(scenario.finance, `/api/v1/finance/cash-accounts/${enc(payment.cashAccountId)}`), account = object(accountRead.account, 'actual cash account');
      ensure(account.id === payment.cashAccountId && account.currency === fee.currency && typeof account.revision === 'number' && Number.isSafeInteger(account.revision), 'SCENARIO_CASH_ACCOUNT_CURRENCY_OR_REVISION_MISMATCH');
      const receipt = await command('actual-customer-receipt', scenario.finance, '/api/v1/finance/vouchers', { requestKey: requestKey('actual-customer-receipt'),
        companyAccountId: payment.cashAccountId, expectedAccountRevision: account.revision, bankReference: payment.bankReference,
        type: 'Receipt', amount: payment.amount, actualAccountAmount: payment.amount, bankFee: '0', feeBearer: 'OUR', currency: fee.currency,
        paymentDate: BUSINESS_DATE, paymentMethod: 'TT', customerRelationId: customer.id, customerName: customer.name,
        notes: `${scenario.key}：银行凭据 ${payment.bankReference}，实际收款 ${payment.amount} ${fee.currency}；非从CI签发或账期推算。` }, true, ['expectedAccountRevision'], 201);
      const voucherId = text(receipt.id, 'actual receipt id'), cashEntryId = text(receipt.cashEntryId, 'actual cash entry'), cashAck = object(receipt.financeCommand, 'cash command receipt');
      result.ids.developmentReceiptVoucherId = voucherId; result.ids.developmentCashAccountId = payment.cashAccountId; result.ids.developmentCashEntryId = cashEntryId;
      fact.receiptVoucherId = voucherId; fact.cashAccountId = payment.cashAccountId; fact.cashEntryId = cashEntryId;
      ensure(cashAck.kind === 'voucher.create' && cashAck.targetId === voucherId && cashAck.actorId === master.cast[scenario.finance].id
        && cashAck.requestKey === requestKey('actual-customer-receipt'), 'SCENARIO_CASH_COMMAND_ACK_MISMATCH'); text(cashAck.auditId, 'cash audit');
      const voucher = await read(scenario.finance, `/api/v1/finance/vouchers/${enc(voucherId)}`);
      ensure(voucher.id === voucherId && voucher.cashEntryId === cashEntryId && voucher.companyAccountId === payment.cashAccountId
        && voucher.ownerId === master.cast[scenario.finance].id && voucher.type === 'Receipt' && voucher.customerRelationId === customer.id
        && voucher.currency === fee.currency && amountIs(voucher.amount, payment.amount) && voucher.paymentDate === BUSINESS_DATE, 'SCENARIO_ACTUAL_RECEIPT_READBACK_MISMATCH'); earn(at);

      at = 'development_receipt_allocated';
      const allocationBody = { invoiceId, voucherId, appliedAmount: payment.amount, appliedDate: BUSINESS_DATE }, step = 'allocate-customer-receipt';
      const allocationRead = async () => {
        const found = await read(scenario.finance, `/api/v1/finance/allocations?invoiceId=${enc(invoiceId)}&voucherId=${enc(voucherId)}`);
        const rows = list(found.items, 'actual allocations'); ensure(found.total === rows.length && rows.length <= 1, 'SCENARIO_ALLOCATION_READBACK_AMBIGUOUS');
        for (const a of rows) ensure(a.invoiceId === invoiceId && a.voucherId === voucherId && amountIs(a.appliedAmount, payment.amount)
          && a.appliedDate === BUSINESS_DATE, 'SCENARIO_ALLOCATION_READBACK_CHANGED');
        return rows;
      };
      const priorAllocation = await deps.journal.read(key(step));
      let acknowledged: Row | null = null;
      if (priorAllocation) {
        try { acknowledged = object((await command(step, scenario.finance, '/api/v1/finance/allocations', allocationBody, false, [], 201)).allocation, 'allocation ACK'); }
        catch (error) { if (!(error instanceof Error) || !error.message.startsWith('SCENARIO_ACK_UNKNOWN_RECONCILE_REQUIRED:')) throw error; }
      }
      let actual = await allocationRead();
      if (!priorAllocation) {
        ensure(actual.length === 0, 'SCENARIO_UNJOURNALED_ALLOCATION_ALREADY_EXISTS');
        acknowledged = object((await command(step, scenario.finance, '/api/v1/finance/allocations', allocationBody, false, [], 201)).allocation, 'allocation ACK');
        actual = await allocationRead();
      }
      ensure(actual.length === 1, 'SCENARIO_ALLOCATION_ACK_UNKNOWN_READBACK_REQUIRED');
      if (acknowledged) ensure(acknowledged.id === actual[0].id && acknowledged.invoiceId === invoiceId && acknowledged.voucherId === voucherId
        && amountIs(acknowledged.appliedAmount, payment.amount), 'SCENARIO_ALLOCATION_ACK_MISMATCH');
      const allocationId = text(actual[0].id, 'allocation id'); result.ids.developmentReceiptAllocationId = allocationId; fact.allocationId = allocationId;
      const cash = await read(scenario.finance, `/api/v1/finance/cash-accounts/${enc(payment.cashAccountId)}`);
      ensure(list(cash.entries, 'actual bank entries').some(e => e.id === cashEntryId && e.sourceVoucherId === voucherId && e.kind === 'Receipt'
        && amountIs(e.amount, payment.amount)), 'SCENARIO_RECEIPT_CASH_SOURCE_MISSING'); earn(at);
    }
    at = 'development_finance_current_readback';
    const { item, ar } = await projection(), paid = money(payment?.amount ?? '0'), total = money(fee.amount);
    ensure(money(String(ar.appliedAmount)) === paid && money(String(ar.openAmount)) === total - paid
      && ar.status === (paid === ZERO ? 'Issued' : paid === total ? 'Paid' : 'PartiallyPaid'), 'SCENARIO_AR_BALANCE_NOT_EARNED');
    const receipts = list(item.receipts, 'case actual receipts');
    ensure(payment ? receipts.length === 1 && receipts[0].id === fact.allocationId && object(receipts[0].voucher, 'allocated receipt').id === fact.receiptVoucherId
      && amountIs(receipts[0].appliedAmount, payment.amount) : receipts.length === 0, 'SCENARIO_CASE_RECEIPTS_CHANGED');
    const finalCase = object((await read(scenario.owner, path)).case, 'final case'), finalLifecycle = object((await read(scenario.owner, `${path}/closure-preview`)).closure, 'final business lifecycle');
    ensure(finalCase.stage === development.stage && ['state', 'revision', 'lifecycleEventId'].every(k => finalLifecycle[k] === initialLifecycle[k]), 'SCENARIO_FINANCE_CHANGED_BUSINESS_LIFECYCLE');
    fact.appliedAmount = decimal(paid); fact.openAmount = decimal(total - paid); fact.state = paid === ZERO ? 'unpaid' : paid === total ? 'paid' : 'partially_paid';
    earn(at); result.stopReached = true; return { result, fact };
  } catch (error) {
    result.blockedAt = at; result.blockedReason = error instanceof Error ? error.message : String(error);
    fact.blockedAt = at; fact.blockedReason = result.blockedReason; return { result, fact };
  }
}

/** Only the two CI-designated cases are bridged. Other earned stops and all
 * exact archives are retained; one rejected handoff never fabricates another. */
export async function runDevelopmentFinanceScenarios(master: ScenarioMasterData, scenarios: DevelopmentScenario[], development: DevelopmentDriverResult,
  deps: ScenarioDriverDependencies, options: DevelopmentFinanceDriverOptions = {}): Promise<DevelopmentFinanceDriverResult> {
  const executions = development.executions.map(cloneExecution), finance: DevelopmentFinanceHandoffFact[] = [];
  const selected = scenarios.filter(s => s.stopAfter === 'development_ci_finance');
  ensure(new Set(selected.map(s => s.key)).size === selected.length, 'SCENARIO_DUPLICATE_CI_CASE');
  for (const scenario of selected) {
    const matches = executions.map((e, index) => ({ e, index })).filter(({ e }) => e.key === scenario.key && e.family === scenario.family);
    ensure(matches.length === 1, 'SCENARIO_DEVELOPMENT_EXECUTION_REQUIRED');
    const bridged = await runOne(master, scenario, matches[0].e, development.archives, deps, options);
    executions[matches[0].index] = bridged.result; finance.push(bridged.fact);
  }
  return { executions, archives: [...development.archives], finance };
}
