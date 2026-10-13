/** Real supplier-finance continuation. The caller supplies every HTTP identity
 * and the durable private command journal; this module never opens a database. */
import { createHash } from 'node:crypto';
import type { ScenarioActorKey, ScenarioMasterData } from './masterData';
import type { OrderScenario } from './scenarios';
import { scenarioCommand, type ScenarioDriverDependencies, type ScenarioExecution, type ScenarioHttpMethod } from './driverContract';

export interface SupplierFinanceContext {
  master: ScenarioMasterData; scenario: OrderScenario; orderId: string; lineId: string; deps: ScenarioDriverDependencies;
}
export interface SupplierFinanceOptions {
  businessDate: string;
  /** Explicit synthetic vendor quotation. Never derive it from the sales price. */
  purchaseUnitPrice: string; currency: string; taxRate: string;
  supplierPaymentTerms: string; requestedDeliveryDate: string;
  /** Explicit supplier contract due date, independent of the sales delivery day. */
  supplierPaymentDueDate: string;
  /** An explicit simulation company policy; an existing different policy is
   * never replaced. Omit to consume an already configured actual authority. */
  supplierApprovalUserIds?: string[];
  resolveCashAccount: (currency: string) => Promise<{ id: string }>;
}

const enc = encodeURIComponent, SCALE = BigInt(10000), ZERO = BigInt(0);
function ensure(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function number(value: unknown): bigint {
  ensure(typeof value === 'string' && /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value), 'SCENARIO_SUPPLIER_DECIMAL_INVALID');
  const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
}
function decimal(value: bigint): string {
  ensure(value >= ZERO, 'SCENARIO_SUPPLIER_NEGATIVE_AMOUNT');
  return `${value / SCALE}.${String(value % SCALE).padStart(4, '0')}`;
}
function uuid(key: string) {
  const hash = createHash('sha256').update(`bambook-supplier-finance:${key}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function date(value: string) {
  ensure(/^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
    'SCENARIO_SUPPLIER_DATE_INVALID'); return value;
}
function sameIds(left: unknown, right: string[]) {
  return Array.isArray(left) && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/** A reached stop describes only facts earned by real protected producers.
 * Unknown non-idempotent ACKs stop for reconciliation, never create duplicates. */
export async function runSupplierFinanceScenario(context: SupplierFinanceContext, options: SupplierFinanceOptions): Promise<ScenarioExecution> {
  const { master, scenario: s, orderId, lineId, deps } = context;
  const result: ScenarioExecution = { key: s.key, earnedSteps: [], stopReached: false, ids: {} };
  let at = 'supplier-finance.validate';
  const earned = (step: string) => { if (!result.earnedSteps.includes(step)) result.earnedSteps.push(step); };
  const read = async (actor: ScenarioActorKey, url: string) => {
    at = `read ${url}`; await deps.verifyActor(actor);
    const response = await deps.invoke(actor, 'get', url);
    ensure(response.status === 200 && response.body?.ok !== false, `SCENARIO_SUPPLIER_READ_REJECTED: HTTP ${response.status}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const write = async (step: string, actor: ScenarioActorKey, method: ScenarioHttpMethod, url: string,
    body: unknown | (() => Promise<unknown>), idempotent = false) => {
    at = step; const key = `${s.key}:supplier-finance:${step}`, previous = await deps.journal.read(key);
    const actualBody = typeof body === 'function' ? previous ? previous.body : await (body as () => Promise<unknown>)() : body;
    at = step; const ack = await scenarioCommand(deps, { key, actor, method, url, body: actualBody, idempotent });
    earned(`supplier-finance.${step}`); return ack;
  };
  try {
    ensure(deps.runtimeId?.trim() && Object.values(master.cast).every(actor => deps.actorIds[actor.key] === actor.id), 'SCENARIO_RUNTIME_ACTOR_MASTER_MISMATCH');
    ensure(['partially_settled', 'settled', 'supplier_payment_pending'].includes(s.stopAfter), 'SCENARIO_SUPPLIER_FINANCE_STOP_INVALID');
    ensure(s.key.startsWith(`${master.namespace}-`) && s.key.length <= 140 && orderId && lineId, 'SCENARIO_SUPPLIER_SOURCE_ID_REQUIRED');
    date(options.businessDate); date(options.requestedDeliveryDate); date(options.supplierPaymentDueDate);
    ensure(/^[A-Z]{3}$/.test(options.currency) && options.supplierPaymentTerms.trim(), 'SCENARIO_SUPPLIER_CURRENCY_TERMS_REQUIRED');
    const qty = number(s.quantity), price = number(options.purchaseUnitPrice), rate = number(options.taxRate);
    ensure(qty > ZERO && price > ZERO && rate <= BigInt(100) * SCALE && qty * price % SCALE === ZERO, 'SCENARIO_SUPPLIER_EXACT_QUOTE_REQUIRED');
    const net = qty * price / SCALE, firstNet = net / BigInt(2), netParts = [firstNet, net - firstNet];
    ensure(netParts.every(amount => amount > ZERO), 'SCENARIO_SUPPLIER_TWO_ORIGINAL_AMOUNTS_REQUIRED');
    const supplier = master.catalog.suppliers.find(row => row.id === s.supplierId), team = master.businessTeams.find(row => row.key === s.teamKey);
    ensure(supplier && team?.businessFamily === s.family && team.supplierIds.includes(supplier.id) && team.customerIds.includes(s.customerId)
      && team.memberIds.includes(master.cast[s.owner].id) && master.cast[s.finance].departmentId === master.approvalRouting.financeRequesterDepartmentId
      && master.cast.financeApprover.id === master.approvalRouting.financeReviewerId && master.cast[s.finance].id !== master.cast.financeApprover.id,
    'SCENARIO_SUPPLIER_ACTUAL_RESPONSIBILITY_MISMATCH');
    const source = (await read(s.owner, `/api/v2/orders/${enc(orderId)}`)).order, sourceLine = source?.lines?.find((row: any) => row.id === lineId);
    ensure(source?.id === orderId && source.customerRelationId === s.customerId && source.businessLine === s.family
      && sourceLine?.orderId === orderId && number(String(sourceLine.quantity)) === qty && sourceLine.unit === s.unit,
    'SCENARIO_SUPPLIER_ORDER_SOURCE_MISMATCH');
    if (s.family === 'garment') ensure(sourceLine.fulfillmentMode === 'cmt' && Array.isArray(sourceLine.cmtIncludedItems), 'SCENARIO_SUPPLIER_CMT_SOURCE_REQUIRED');
    earned('supplier-finance.current-order-source');
    const kind = s.family === 'fabric' ? 'purchase' : 'processing', root = `/api/v1/procurement/contracts/${kind}`;
    const authorityUrl = `/api/v1/procurement/contracts/approval-authority/${kind}/${s.family}`;
    let authority = (await read('owner', authorityUrl)).item;
    const configured = options.supplierApprovalUserIds;
    if (configured) {
      ensure(configured.length > 0 && new Set(configured).size === configured.length && configured.includes(master.cast[s.reviewer].id)
        && configured.every(id => Object.values(master.cast).some(actor => actor.id === id)), 'SCENARIO_SUPPLIER_APPROVAL_POLICY_INVALID');
      if (!sameIds(authority?.userIds, configured)) {
        ensure(authority?.version === 0 && Array.isArray(authority.userIds) && authority.userIds.length === 0, 'SCENARIO_SUPPLIER_APPROVAL_POLICY_CHANGED');
        await write('contract.configure-authority', 'owner', 'put', authorityUrl, async () => ({ requestKey: uuid(`${s.key}:supplier-authority`),
          expectedConfigVersion: authority.version, userIds: configured, reason: `${master.namespace} ${kind}/${s.family} 审批名单；不代表真实公司名单。` }), true);
        authority = (await read('owner', authorityUrl)).item;
      }
      ensure(sameIds(authority?.userIds, configured), 'SCENARIO_SUPPLIER_APPROVAL_POLICY_CHANGED');
    }
    ensure(authority?.userIds?.includes(master.cast[s.reviewer].id), 'SCENARIO_SUPPLIER_APPROVAL_POLICY_REQUIRED');
    const created = await write('contract.create', s.owner, 'post', root, { requestKey: uuid(`${s.key}:supplier-contract-create`), contractNumber: `${s.key}-vendor`,
      supplierRelationId: supplier.id, currency: options.currency, paymentTerms: options.supplierPaymentTerms, orderDate: s.contractDate,
      mainDeliveryLocation: { kind: 'supplier', relationId: supplier.id, address: supplier.address }, deliveryTerms: 'EXW',
      notes: '采购/加工单价由剧本明确；不从销售价、库存或已出运状态推算。',
      lines: [{ orderLineId: lineId, description: sourceLine.description, quantity: s.quantity, unit: s.unit, unitPrice: options.purchaseUnitPrice,
        requestedDeliveryDate: options.requestedDeliveryDate, ...(kind === 'purchase' ? { kind: 'FinishedGoods' }
          : { processType: 'CMT', cmtIncludedItemsReviewed: sourceLine.cmtIncludedItems, inputSource: { kind: 'customer_supplied', relationId: s.customerId } }) }] }, true);
    const contractId = created.commandAck?.contractId, vendorLine = created.item?.draft?.lines?.[0];
    ensure(typeof contractId === 'string' && vendorLine?.id && vendorLine.orderLineId === lineId, 'SCENARIO_SUPPLIER_CONTRACT_ACK_MISSING');
    result.ids.supplierContractId = contractId; result.ids.supplierContractLineId = vendorLine.id;
    const contractUrl = `${root}/${enc(contractId)}`;
    const submitted = await write('contract.submit', s.owner, 'post', `${contractUrl}/submit`, async () => {
      const current = (await read(s.owner, contractUrl)).item;
      return { requestKey: uuid(`${s.key}:supplier-contract-submit`), expectedRevision: current.latestRevision };
    }, true);
    const supplierApprovalId = submitted.commandAck?.approvalId, revisionId = submitted.commandAck?.revisionId;
    ensure(supplierApprovalId && revisionId, 'SCENARIO_SUPPLIER_APPROVAL_ACK_MISSING');
    result.ids.supplierContractRevisionId = revisionId; result.ids.supplierContractApprovalId = supplierApprovalId;
    const supplierReview = (await read(s.reviewer, `/api/v1/approvals/${enc(supplierApprovalId)}`)).item;
    ensure(supplierReview?.id === supplierApprovalId && supplierReview.actionType === 'supplier:commitment' && supplierReview.targetId === revisionId,
      'SCENARIO_SUPPLIER_APPROVAL_SOURCE_MISMATCH');
    await write('contract.approve', s.reviewer, 'post', `/api/v1/approvals/${enc(supplierApprovalId)}/decide`, async () => ({ requestKey: uuid(`${s.key}:supplier-contract-approve`),
      status: 'approved', confirmedReviewedContent: true, reviewContentVersion: supplierReview.reviewContentVersion,
      decisionNote: '已核对准确订单来源、供应商报价、工艺/成品责任、币种与交付条款。' }), true);
    const approved = (await read(s.owner, contractUrl)).item;
    ensure(approved?.approvedRevision?.id === revisionId && approved.approvedRevision.status === 'approved'
      && approved.approvedRevision.snapshot?.supplierRelationId === supplier.id && approved.approvedRevision.snapshot.currency === options.currency
      && approved.approvedRevision.snapshot.lines?.some((line: any) => line.id === vendorLine.id && line.orderLineId === lineId
        && number(String(line.quantity)) === qty && number(String(line.unitPrice)) === price), 'SCENARIO_SUPPLIER_APPROVED_PROMISE_NOT_CURRENT');
    const generated = await write('contract.generate-document', s.owner, 'post', `${contractUrl}/generate-document`, {
      requestKey: uuid(`${s.key}:supplier-contract-document`), approvedRevisionId: revisionId }, true);
    ensure(generated.commandAck?.documentId && generated.item?.documentId === generated.commandAck.documentId
      && generated.item.revisionId === revisionId && /^[a-f0-9]{64}$/.test(generated.item.sha256) && generated.item.fileSize > 0,
    'SCENARIO_SUPPLIER_FORMAL_DOCUMENT_PROOF_MISSING');
    result.ids.supplierContractDocumentId = generated.commandAck.documentId;
    await write('contract.record-offline-send', s.owner, 'post', `${contractUrl}/record-offline-send`, {
      requestKey: uuid(`${s.key}:supplier-offline-send`), approvedRevisionId: revisionId, sentAt: options.businessDate,
      evidence: [`simulation:${s.key}:actual-approved-vendor-document-sent`] }, true);
    const feedback = await write('contract.supplier-feedback', s.owner, 'post', `${contractUrl}/supplier-feedback`, {
      requestKey: uuid(`${s.key}:supplier-feedback`), approvedRevisionId: revisionId, feedbackAt: options.businessDate,
      lines: [{ lineId: vendorLine.id, supplierCommittedDeliveryDate: options.requestedDeliveryDate }],
      evidence: [`simulation:${s.key}:actual-supplier-confirmed-date`] }, true);
    ensure(feedback.item?.requiresAmendment === false, 'SCENARIO_SUPPLIER_FEEDBACK_REQUIRES_REAL_AMENDMENT');
    const confirmed = (await read(s.owner, contractUrl)).item;
    ensure(confirmed.approvedRevision?.id === revisionId && confirmed.status === 'Confirmed'
      && confirmed.offlineHistory?.some((row: any) => row.operation === 'record_offline_send' && row.data?.approvedRevisionId === revisionId)
      && confirmed.offlineHistory?.some((row: any) => row.operation === 'record_supplier_feedback' && row.data?.approvedRevisionId === revisionId),
    'SCENARIO_SUPPLIER_CURRENT_COMMITMENT_READBACK_MISSING');
    earned('supplier-finance.contract.current-approved-feedback');
    const payables: Array<{ vatId: string; id: string; sourceFingerprint: string; amount: bigint }> = [];
    for (const [index, part] of netParts.entries()) {
      // The VAT producer checks the original three monetary columns. This
      // explicit simulation rate uses the producer's four-decimal rounding.
      const divisor = BigInt(100) * SCALE, tax = (part * rate + divisor / BigInt(2)) / divisor, gross = part + tax;
      const original = await write(`vat.${index + 1}.record-original`, s.finance, 'post', '/api/v1/finance/vat-invoices', {
        requestKey: uuid(`${s.key}:supplier-vat-${index + 1}`), vatNumber: `${s.key}-VAT-${index + 1}`, direction: 'Input', invoiceType: 'Special',
        sellerName: supplier.name, buyerName: master.catalog.company.name, issueDate: options.businessDate, netAmount: decimal(part), taxRate: options.taxRate,
        taxAmount: decimal(tax), totalAmount: decimal(gross), currency: options.currency, relationId: supplier.id, orderId,
        notes: '票面三栏及明确剧本税率；不代表替供应商开票，不生成履约、库存或付款事实。' }, true);
      ensure(original?.id && original.direction === 'Input' && original.relationId === supplier.id && original.currency === options.currency
        && number(String(original.totalAmount)) === gross, 'SCENARIO_SUPPLIER_VAT_ORIGINAL_ACK_MISMATCH');
      const selection = { amountBasis: 'net', dueDate: options.supplierPaymentDueDate, sources: [{ contractKind: kind, contractId,
        commitmentRevisionId: revisionId, lineId: vendorLine.id, contractAmount: decimal(part) }] };
      const payableUrl = `/api/v1/finance/supplier-vat-payables/${enc(original.id)}`;
      const registered = await write(`ap.${index + 1}.register`, s.finance, 'post', `${payableUrl}/register`, async () => {
        // Preview is a live POST reader, not an acknowledged business command.
        at = `ap.${index + 1}.preview`; await deps.verifyActor(s.finance);
        const response = await deps.invoke(s.finance, 'post', `${payableUrl}/preview`, selection);
        ensure(response.status === 200 && response.body?.ok === true, `SCENARIO_SUPPLIER_AP_PREVIEW_REJECTED: ${JSON.stringify(response.body)}`);
        return { ...selection, requestKey: uuid(`${s.key}:supplier-ap-${index + 1}`), expectedVatUpdatedAt: response.body.vatUpdatedAt,
          expectedSourceFingerprint: response.body.sourceFingerprint };
      }, true);
      const invoice = registered.invoice;
      ensure(invoice?.id && invoice.type === 'Payable' && invoice.sourceType === 'SupplierVatPayable' && invoice.sourceId === original.id
        && invoice.customerRelationId === supplier.id && invoice.currency === options.currency && number(String(invoice.amount)) === gross
        && registered.snapshot?.sourceFingerprint === registered.receipt?.sourceFingerprint && /^[a-f0-9]{64}$/.test(registered.snapshot.sourceFingerprint),
      'SCENARIO_SUPPLIER_AP_ORIGINAL_SOURCE_MISMATCH');
      payables.push({ vatId: original.id, id: invoice.id, sourceFingerprint: registered.snapshot.sourceFingerprint, amount: gross });
    }
    result.ids.supplierVatInvoiceIds = payables.map(row => row.vatId); result.ids.supplierPayableIds = payables.map(row => row.id);
    const payableTotal = payables.reduce((sum, row) => sum + row.amount, ZERO);
    const paymentRequestKey = uuid(`${s.key}:supplier-payment-request-create`);
    const made = await write('payment-request.create', s.finance, 'post', '/api/v1/payment-requests', {
      requestKey: paymentRequestKey,
      supplierId: supplier.id, supplierName: supplier.name, totalAmount: decimal(payableTotal), currency: options.currency, paymentCategory: 'normal',
      requestDate: options.businessDate, expectedPaymentDate: options.supplierPaymentDueDate, sourceType: 'supplier_payable',
      payableSelections: payables.map(row => ({ invoiceId: row.id, requestedAmount: decimal(row.amount), expectedSourceFingerprint: row.sourceFingerprint })),
      remark: '准确两张已登记供应商原票；批准仅授权，银行实际付款另行登记。' }, true);
    const requestId = made.paymentRequest?.id, paymentApprovalId = made.approvalRequestId;
    ensure(requestId && paymentApprovalId, 'SCENARIO_SUPPLIER_PAYMENT_REQUEST_ACK_MISSING');
    ensure(made.financeCommand?.protocolVersion === 1 && made.financeCommand.kind === 'payment_request.create'
      && made.financeCommand.requestKey === paymentRequestKey && made.financeCommand.actorId === master.cast[s.finance].id
      && made.financeCommand.targetId === requestId && made.financeCommand.auditId === made.auditId,
    'SCENARIO_SUPPLIER_PAYMENT_REQUEST_ORIGINAL_COMMAND_MISSING');
    result.ids.supplierPaymentRequestId = requestId; result.ids.supplierPaymentApprovalId = paymentApprovalId;
    result.ids.supplierPaymentRequestCommandAuditId = made.auditId;
    const requestUrl = `/api/v1/payment-requests/${enc(requestId)}`, paymentApprovalUrl = `/api/v1/approvals/${enc(paymentApprovalId)}`;
    const currentRequest = async () => {
      const current = (await read(s.finance, requestUrl)).item, frozen = current?.attachments?.sourceSnapshot;
      ensure(current?.id === requestId && current.supplierId === supplier.id && current.currency === options.currency
        && number(String(current.totalAmount)) === payableTotal && current.approvalRequestId === paymentApprovalId
        && current.reviewerId === master.cast.financeApprover.id && frozen?.sourceType === 'SupplierVatPayablePayment'
        && frozen.supplierId === supplier.id && frozen.currency === options.currency && number(String(frozen.totalAmount)) === payableTotal
        && sameIds(frozen.entries?.map((row: any) => row.invoiceId), payables.map(row => row.id))
        && payables.every(row => frozen.entries.some((entry: any) => entry.invoiceId === row.id && entry.sourceFingerprint === row.sourceFingerprint
          && number(String(entry.requestedAmount)) === row.amount)), 'SCENARIO_SUPPLIER_FROZEN_PAYMENT_SET_MISMATCH');
      return current;
    };
    const pending = await currentRequest(), review = (await read('financeApprover', paymentApprovalUrl)).item;
    ensure(review?.id === paymentApprovalId && review.actionType === 'finance:payment_request' && review.targetId === requestId
      && review.requesterId === master.cast[s.finance].id && review.reviewerId === master.cast.financeApprover.id
      && review.payload?.sourceSnapshot?.sourceFingerprint === pending.attachments.sourceSnapshot.sourceFingerprint,
    'SCENARIO_SUPPLIER_INDEPENDENT_PAYMENT_APPROVAL_MISMATCH');
    if (s.stopAfter === 'supplier_payment_pending') {
      ensure(pending.status === 'Pending' && review.status === 'pending' && number(String(pending.actualPayments?.paidAmount)) === ZERO,
        'SCENARIO_SUPPLIER_REQUEST_IS_NOT_PENDING');
      earned('supplier-finance.payment-request.pending-readback'); result.stopReached = true; return result;
    }
    await write('payment-request.approve', 'financeApprover', 'post', `${paymentApprovalUrl}/decide`, async () => ({
      status: 'approved', confirmedReviewedContent: true, reviewContentVersion: review.reviewContentVersion,
      decisionNote: '已核对逐张AP原票、批准合同行、收款供应商、币种和准确申请额；不表示银行已付。' }));
    let approvedRequest: any;
    for (let attempt = 0; attempt < 30; attempt++) {
      approvedRequest = await currentRequest(); if (['Approved', 'Paid'].includes(approvedRequest.status)) break;
      // The native approval hook projects asynchronously; a pending projection
      // is neither permission to pay nor an excuse to manufacture Approved.
      if (attempt < 29) await new Promise(resolve => setTimeout(resolve, 20));
    }
    ensure(['Approved', 'Paid'].includes(approvedRequest?.status), 'SCENARIO_SUPPLIER_PAYMENT_DECISION_NOT_PROJECTED');
    const firstParts = payables.map(row => row.amount / BigInt(2));
    ensure(firstParts.every(amount => amount > ZERO), 'SCENARIO_SUPPLIER_PART_PAYMENT_PRECISION_INVALID');
    const allParts = s.stopAfter === 'settled' ? [firstParts, payables.map((row, index) => row.amount - firstParts[index])] : [firstParts];
    const voucherIds: string[] = [], allocationIds: string[] = [], cashEntryIds: string[] = [];
    for (const [index, parts] of allParts.entries()) {
      const paidAmount = parts.reduce((sum, amount) => sum + amount, ZERO);
      const paid = await write(`cash.${index + 1}.record-actual`, s.finance, 'post', `${requestUrl}/record-payment`, async () => {
        const actualRequest = await currentRequest(), accountRef = await options.resolveCashAccount(options.currency);
        ensure(accountRef?.id, 'SCENARIO_SUPPLIER_ACTUAL_CASH_ACCOUNT_REQUIRED');
        const account = (await read(s.finance, `/api/v1/finance/cash-accounts/${enc(accountRef.id)}`)).account;
        ensure(account?.id === accountRef.id && account.currency === options.currency && Number.isSafeInteger(account.revision), 'SCENARIO_SUPPLIER_CASH_ACCOUNT_SOURCE_MISMATCH');
        return { requestKey: uuid(`${s.key}:supplier-actual-payment-${index + 1}`), expectedRequestUpdatedAt: actualRequest.updatedAt,
          amount: decimal(paidAmount), currency: options.currency, paymentDate: options.businessDate, paymentMethod: 'TT',
          bankReference: `${s.key}-ACTUAL-VENDOR-PAYMENT-${index + 1}`, evidenceNote: '票款与实际银行扣款显式同额，无手续费；非由批准或账期推算。',
          companyAccountId: account.id, expectedAccountRevision: account.revision, actualAccountAmount: decimal(paidAmount), bankFee: '0', feeBearer: 'OUR' };
      }, true);
      const voucher = paid.voucher;
      ensure(voucher?.id && voucher.type === 'Disbursement' && voucher.currency === options.currency && voucher.customerRelationId === supplier.id
        && voucher.companyAccountId && voucher.cashEntryId && number(String(voucher.amount)) === paidAmount, 'SCENARIO_SUPPLIER_ACTUAL_CASH_ACK_MISSING');
      voucherIds.push(voucher.id); cashEntryIds.push(voucher.cashEntryId); result.ids.supplierCashAccountId = voucher.companyAccountId;
      for (const [apIndex, row] of payables.entries()) {
        const allocation = (await write(`cash.${index + 1}.allocate-ap.${apIndex + 1}`, s.finance, 'post', '/api/v1/finance/allocations', {
          invoiceId: row.id, voucherId: voucher.id, appliedAmount: decimal(parts[apIndex]), appliedDate: options.businessDate })).allocation;
        ensure(allocation?.id && allocation.invoiceId === row.id && allocation.voucherId === voucher.id && number(String(allocation.appliedAmount)) === parts[apIndex],
          'SCENARIO_SUPPLIER_AP_ALLOCATION_ACK_MISSING');
        allocationIds.push(allocation.id);
      }
      const cash = await read(s.finance, `/api/v1/finance/cash-accounts/${enc(voucher.companyAccountId)}`);
      ensure(cash.account?.currency === options.currency && cash.entries?.some((entry: any) => entry.id === voucher.cashEntryId
        && entry.sourceVoucherId === voucher.id && entry.kind === 'Payment' && entry.currency === options.currency
        && number(String(entry.amount)) === paidAmount && /^-/.test(String(entry.signedAmount))
        && number(String(entry.signedAmount).slice(1)) === paidAmount),
      'SCENARIO_SUPPLIER_BANK_FACT_READBACK_MISSING');
      // An unverified Opening remains unknown, even though a real movement
      // exists. No zero/positive Opening is created to make this case green.
    }
    result.ids.supplierVoucherIds = voucherIds; result.ids.supplierCashEntryIds = cashEntryIds; result.ids.supplierAllocationIds = allocationIds;
    for (const [index, row] of payables.entries()) {
      const original = await read(s.finance, `/api/v1/finance/supplier-vat-payables/${enc(row.vatId)}`);
      const allocationSet = await read(s.finance, `/api/v1/finance/allocations?invoiceId=${enc(row.id)}`);
      ensure(original.invoice?.id === row.id && original.snapshot?.sourceFingerprint === row.sourceFingerprint
        && number(String(original.invoice.amount)) === row.amount && original.invoice.currency === options.currency
        && Array.isArray(allocationSet.items) && allocationSet.total === allocationSet.items.length, 'SCENARIO_SUPPLIER_AP_CURRENT_ORIGINAL_CHANGED');
      const applied = allocationSet.items.reduce((sum: bigint, item: any) => sum + number(String(item.appliedAmount)), ZERO);
      const expected = s.stopAfter === 'settled' ? row.amount : firstParts[index];
      ensure(applied === expected && original.invoice.status === (s.stopAfter === 'settled' ? 'Paid' : 'PartiallyPaid')
        && allocationSet.items.every((item: any) => voucherIds.includes(item.voucherId)), 'SCENARIO_SUPPLIER_AP_BALANCE_NOT_EARNED');
    }
    const finished = await currentRequest(), actuallyPaid = allParts.flat().reduce((sum, part) => sum + part, ZERO);
    ensure(number(String(finished.actualPayments?.paidAmount)) === actuallyPaid && number(String(finished.actualPayments?.remainingAmount)) === payableTotal - actuallyPaid
      && finished.status === (s.stopAfter === 'settled' ? 'Paid' : 'Approved'), 'SCENARIO_SUPPLIER_REQUEST_CASH_BALANCE_MISMATCH');
    earned(s.stopAfter === 'settled' ? 'supplier-finance.ap.cash.fully-settled-readback' : 'supplier-finance.ap.cash.partially-settled-readback');
    result.stopReached = true;
  } catch (error) { result.blockedAt = `${at}: ${error instanceof Error ? error.message : String(error)}`; }
  return result;
}
