import { describe, expect, it } from 'vitest';
import { planScenarioMasterData } from './masterData';
import { buildBusinessScenarios } from './scenarios';
import { scenarioCommand, type ScenarioCommandRecord, type ScenarioDriverDependencies, type ScenarioHttpMethod } from './driverContract';
import { runSupplierFinanceScenario, type SupplierFinanceOptions } from './supplierFinanceDriver';

const master = planScenarioMasterData({ namespace: 'supplier-driver', nowMs: Date.parse('2026-10-08T00:18:00Z') });
const options: SupplierFinanceOptions = { businessDate: '2026-10-08', purchaseUnitPrice: '3.20', currency: 'CNY', taxRate: '13',
  supplierPaymentTerms: '【模拟供应商条款】2026-10-08收原票后30天，2026-11-07到期；提前付款按实际流水', requestedDeliveryDate: '2026-10-03',
  supplierPaymentDueDate: '2026-11-07',
  supplierApprovalUserIds: master.approvalAuthorities.fabric, resolveCashAccount: async () => ({ id: 'CASH-CNY' }) };

/** Endpoint boundary only: no final-state seed and no permissive catch-all. The
 * real producer invariants remain subject to root's isolated HTTP/PG run. */
function boundary(stopAfter: 'partially_settled' | 'settled' | 'supplier_payment_pending', family: 'fabric' | 'garment' = 'fabric') {
  const scenario = buildBusinessScenarios(master).orders.find(row => row.stopAfter === stopAfter && row.family === family)!;
  const records = new Map<string, ScenarioCommandRecord>(), calls: Array<{ actor: ScenarioActorKey; method: ScenarioHttpMethod; url: string; body: any }> = [];
  const orderId = 'ORDER-ACTUAL', lineId = 'LINE-ACTUAL';
  const source = { id: orderId, customerRelationId: scenario.customerId, businessLine: family, status: 'Shipped',
    lines: [{ id: lineId, orderId, quantity: scenario.quantity, unit: scenario.unit, fulfillmentMode: family === 'garment' ? 'cmt' : null, cmtIncludedItems: [] }] };
  let authority: any = { version: 0, userIds: [] }, contract: any, supplierApproval: any, request: any, requestApproval: any, originalRequestAck: any;
  let requestCreates = 0;
  let losePaymentAck = false, loseRequestAck = false, removed = false, accountRevision = 1;
  const vats = new Map<string, any>(), aps = new Map<string, any>(), vouchers = new Map<string, any>(), allocations = new Map<string, any>(), entries: any[] = [];
  const money = (value: any) => Number(value).toFixed(4);
  const deps: ScenarioDriverDependencies = { runtimeId: 'pure-supplier-driver',
    actorIds: Object.fromEntries(Object.values(master.cast).map(actor => [actor.key, actor.id])) as ScenarioDriverDependencies['actorIds'],
    verifyActor: async () => { if (removed) throw Error('Current account disabled'); },
    journal: { read: async key => records.get(key) ?? null, write: async record => { records.set(record.key, structuredClone(record)); } },
    invoke: async (actor, method, url, body: any) => {
      calls.push({ actor, method, url, body: structuredClone(body) });
      if (method === 'get' && url === `/api/v2/orders/${orderId}`) return { status: 200, body: { ok: true, order: source } };
      const config = url.match(/^\/api\/v1\/procurement\/contracts\/approval-authority\/(purchase|processing)\/(fabric|garment)$/);
      if (config) {
        if (method === 'get') return { status: 200, body: { ok: true, item: authority } };
        if (method === 'put') { authority = { version: 1, userIds: body.userIds }; return { status: 200, body: { ok: true, item: authority } }; }
      }
      if (method === 'post' && /^\/api\/v1\/procurement\/contracts\/(purchase|processing)$/.test(url)) {
        contract = { id: 'CONTRACT-1', status: 'Draft', latestRevision: 1, contractKind: family === 'fabric' ? 'purchase' : 'processing',
          draft: { ...body, sourceProofs: [{ orderId, orderLineId: lineId }], lines: body.lines.map((line: any) => ({ ...line, id: 'VENDOR-LINE-1' })) }, offlineHistory: [] };
        return { status: 201, body: { ok: true, item: structuredClone(contract), commandAck: { contractId: contract.id, requestKey: body.requestKey } } };
      }
      const supplier = url.match(/^\/api\/v1\/procurement\/contracts\/(purchase|processing)\/CONTRACT-1(?:\/(submit|generate-document|record-offline-send|supplier-feedback))?$/);
      if (supplier) {
        if (method === 'get') return { status: 200, body: { ok: true, item: structuredClone(contract) } };
        if (supplier[2] === 'submit') {
          supplierApproval = { id: 'APP-SUP', actionType: 'supplier:commitment', targetId: 'REV-1', status: 'pending', reviewerId: master.cast[scenario.reviewer].id,
            reviewContentVersion: 'a'.repeat(64) };
          return { status: 200, body: { ok: true, item: supplierApproval, commandAck: { contractId: contract.id, approvalId: 'APP-SUP', revisionId: 'REV-1' } } };
        }
        if (supplier[2] === 'generate-document') return { status: 200, body: { ok: true, item: { documentId: 'SUP-DOC', revisionId: 'REV-1', sha256: 'd'.repeat(64), fileSize: 200 }, commandAck: { contractId: contract.id, revisionId: 'REV-1', documentId: 'SUP-DOC' } } };
        if (supplier[2] === 'record-offline-send' || supplier[2] === 'supplier-feedback') {
          contract.offlineHistory.push({ operation: supplier[2] === 'record-offline-send' ? 'record_offline_send' : 'record_supplier_feedback', data: body });
          if (supplier[2] === 'supplier-feedback') { contract.status = 'Confirmed'; contract.draft.lines[0].supplierCommittedDeliveryDate = body.lines[0].supplierCommittedDeliveryDate; }
          return { status: 200, body: { ok: true, item: { ...body, requiresAmendment: false }, commandAck: { contractId: contract.id, revisionId: 'REV-1' } } };
        }
      }
      const approval = url.match(/^\/api\/v1\/approvals\/(APP-SUP|APP-PAY)(?:\/decide)?$/);
      if (approval) {
        const item = approval[1] === 'APP-SUP' ? supplierApproval : requestApproval;
        if (method === 'get') return { status: 200, body: { item: structuredClone(item) } };
        if (method === 'post') {
          item.status = body.status;
          if (approval[1] === 'APP-SUP') { contract.approvedRevision = { id: 'REV-1', status: 'approved', snapshot: structuredClone(contract.draft) }; contract.approvalState = 'approved'; }
          else request.status = 'Approved';
          return { status: 200, body: { item: { ...item, businessSyncStatus: 'completed' } } };
        }
      }
      if (method === 'post' && url === '/api/v1/finance/vat-invoices') {
        const row = { ...body, id: `VAT-${vats.size + 1}`, status: 'Received' }; vats.set(row.id, row); return { status: 201, body: structuredClone(row) };
      }
      const ap = url.match(/^\/api\/v1\/finance\/supplier-vat-payables\/(VAT-[12])(?:\/(preview|register))?$/);
      if (ap) {
        const vat = vats.get(ap[1]);
        if (ap[2] === 'preview') return { status: 200, body: { ok: true, vatUpdatedAt: '100', sourceFingerprint: ap[1].endsWith('1') ? '1'.repeat(64) : '2'.repeat(64) } };
        if (ap[2] === 'register') {
          const invoice = { id: `AP-${ap[1]}`, sourceType: 'SupplierVatPayable', sourceId: vat.id, type: 'Payable', amount: vat.totalAmount, currency: vat.currency,
            customerRelationId: vat.relationId, status: 'Issued' };
          const snapshot = { sourceFingerprint: body.expectedSourceFingerprint, vatOriginal: vat, sources: body.sources };
          const row = { ok: true, invoice, vatInvoice: { ...vat, invoiceId: invoice.id }, snapshot, receipt: { invoiceId: invoice.id, vatInvoiceId: vat.id, sourceFingerprint: snapshot.sourceFingerprint } };
          aps.set(vat.id, row); return { status: 201, body: structuredClone(row) };
        }
        if (method === 'get') return { status: 200, body: structuredClone(aps.get(ap[1])) };
      }
      if (method === 'post' && url === '/api/v1/payment-requests') {
        if (body.requestKey && originalRequestAck?.financeCommand?.requestKey === body.requestKey) return { status: 201, body: structuredClone(originalRequestAck) };
        const snapshot = { sourceType: 'SupplierVatPayablePayment', supplierId: body.supplierId, currency: body.currency, totalAmount: money(body.totalAmount), sourceFingerprint: 'f'.repeat(64),
          entries: body.payableSelections.map((entry: any) => ({ invoiceId: entry.invoiceId, requestedAmount: money(entry.requestedAmount), sourceFingerprint: entry.expectedSourceFingerprint })) };
        request = { ...body, id: 'REQUEST-1', status: 'Pending', approvalRequestId: 'APP-PAY', reviewerId: master.cast.financeApprover.id,
          updatedAt: '2026-10-08T00:18:00.000Z', attachments: { sourceSnapshot: snapshot, sourceDocument: { type: 'supplier_payable', id: snapshot.sourceFingerprint } } };
        requestApproval = { id: 'APP-PAY', targetId: request.id, actionType: 'finance:payment_request', status: 'pending', reviewerId: master.cast.financeApprover.id,
          requesterId: master.cast[actor].id, payload: structuredClone(request.attachments), reviewContentVersion: 'b'.repeat(64) };
        requestCreates++;
        originalRequestAck = { paymentRequest: structuredClone(request), approvalRequestId: 'APP-PAY', auditId: 'PAY-AUDIT',
          ...(body.requestKey ? { financeCommand: { protocolVersion: 1, kind: 'payment_request.create', requestKey: body.requestKey,
            actorId: master.cast[actor].id, targetId: request.id, auditId: 'PAY-AUDIT' } } : {}) };
        if (loseRequestAck) { loseRequestAck = false; throw Error('request acknowledgement disconnected'); }
        return { status: 201, body: structuredClone(originalRequestAck) };
      }
      if (method === 'get' && url === '/api/v1/payment-requests/REQUEST-1') {
        const paid = [...vouchers.values()].reduce((sum, row) => sum + Number(row.amount), 0);
        return { status: 200, body: { item: { ...structuredClone(request), actualPayments: { paidAmount: money(paid), remainingAmount: money(Number(request.totalAmount) - paid), vouchers: [...vouchers.values()] } } } };
      }
      if (method === 'get' && url === '/api/v1/finance/cash-accounts/CASH-CNY') return { status: 200, body: { account: { id: 'CASH-CNY', currency: 'CNY', revision: accountRevision, balance: null }, entries: structuredClone(entries) } };
      if (method === 'post' && url === '/api/v1/payment-requests/REQUEST-1/record-payment') {
        const previous = [...vouchers.values()].find(row => row.requestKey === body.requestKey);
        if (previous) return { status: 200, body: { voucher: previous, replayed: true } };
        const voucher = { id: `PAY-${vouchers.size + 1}`, ...body, type: 'Disbursement', cashEntryId: `CASH-ENTRY-${vouchers.size + 1}`,
          currency: request.currency, customerRelationId: request.supplierId, companyAccountId: 'CASH-CNY' };
        vouchers.set(voucher.id, voucher); accountRevision++;
        entries.push({ id: voucher.cashEntryId, sourceVoucherId: voucher.id, kind: 'Payment', amount: body.actualAccountAmount,
          signedAmount: `-${money(body.actualAccountAmount)}`, currency: body.currency });
        request.updatedAt = `2026-10-08T00:18:0${vouchers.size}.000Z`;
        if ([...vouchers.values()].reduce((sum, row) => sum + Number(row.amount), 0) === Number(request.totalAmount)) request.status = 'Paid';
        if (losePaymentAck) { losePaymentAck = false; throw Error('cash acknowledgement disconnected'); }
        return { status: 201, body: { voucher: structuredClone(voucher), paymentRequest: structuredClone(request) } };
      }
      if (method === 'post' && url === '/api/v1/finance/allocations') {
        const allocation = { ...body, id: `${body.invoiceId}:${body.voucherId}` }; allocations.set(allocation.id, allocation);
        const original = [...aps.values()].find(row => row.invoice.id === body.invoiceId)!;
        const applied = [...allocations.values()].filter(row => row.invoiceId === body.invoiceId).reduce((sum, row) => sum + Number(row.appliedAmount), 0);
        original.invoice.status = applied === Number(original.invoice.amount) ? 'Paid' : 'PartiallyPaid';
        return { status: 201, body: { allocation: structuredClone(allocation) } };
      }
      if (method === 'get' && url.startsWith('/api/v1/finance/allocations?invoiceId=')) {
        const invoiceId = decodeURIComponent(url.split('=')[1]), items = [...allocations.values()].filter(row => row.invoiceId === invoiceId);
        return { status: 200, body: { items, total: items.length } };
      }
      throw Error(`Unexpected supplier endpoint: ${method} ${url}`);
    },
  };
  return { scenario, deps, calls, records, source, aps, vouchers, allocations, entries,
    context: { master, scenario, orderId, lineId, deps },
    get request() { return request; }, setAuthority: (value: any) => { authority = value; },
    get requestCreates() { return requestCreates; },
    losePayment: () => { losePaymentAck = true; }, loseRequest: () => { loseRequestAck = true; }, revoke: () => { removed = true; } };
}
type ScenarioActorKey = keyof typeof master.cast;

describe('real supplier finance scenario commands', () => {
  it('earns approved supplier terms, two original APs, actual partial cash and accurate multi-ticket allocation', async () => {
    const f = boundary('partially_settled');
    const result = await runSupplierFinanceScenario(f.context, options);
    expect(result).toMatchObject({ stopReached: true, ids: { supplierPayableIds: ['AP-VAT-1', 'AP-VAT-2'], supplierPaymentRequestId: 'REQUEST-1' } });
    expect(f.vouchers.size).toBe(1); expect(f.allocations.size).toBe(2);
    expect([...f.aps.values()].every(row => row.invoice.status === 'PartiallyPaid')).toBe(true);
    expect(f.calls.find(row => row.url.endsWith('/purchase') && row.method === 'post')!.body.lines[0]).toMatchObject({ kind: 'FinishedGoods', unitPrice: '3.20' });
    expect(f.calls.filter(row => row.url.endsWith('/decide')).map(row => row.actor)).toEqual([f.scenario.reviewer, 'financeApprover']);
    const request = f.calls.find(row => row.url === '/api/v1/payment-requests' && row.method === 'post')!;
    expect(request.body).toMatchObject({ expectedPaymentDate: '2026-11-07', requestKey: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(f.calls.filter(row => row.url.endsWith('/register') && row.url.includes('supplier-vat-payables')).map(row => row.body.dueDate)).toEqual(['2026-11-07', '2026-11-07']);
  });

  it('uses a real customer-supplied CMT contract, pays two legal portions and reads all APs settled', async () => {
    const f = boundary('settled', 'garment');
    const result = await runSupplierFinanceScenario(f.context, { ...options, purchaseUnitPrice: '12.00', supplierApprovalUserIds: master.approvalAuthorities.garment });
    expect(result.stopReached).toBe(true); expect(f.vouchers.size).toBe(2); expect(f.allocations.size).toBe(4);
    expect([...f.aps.values()].every(row => row.invoice.status === 'Paid')).toBe(true);
    const created = f.calls.find(row => row.url.endsWith('/processing') && row.method === 'post')!;
    expect(created.body.lines[0]).toMatchObject({ processType: 'CMT', inputSource: { kind: 'customer_supplied', relationId: f.scenario.customerId } });
    expect(f.calls.some(row => row.url === '/api/v1/finance/cash-accounts/CASH-CNY/commands')).toBe(false);
  });

  it('leaves a real supplier AP request pending with no approval or actual cash fact', async () => {
    const f = boundary('supplier_payment_pending', 'garment');
    const result = await runSupplierFinanceScenario(f.context, { ...options, purchaseUnitPrice: '12.00', supplierApprovalUserIds: master.approvalAuthorities.garment });
    expect(result.stopReached).toBe(true); expect(f.request.status).toBe('Pending'); expect(f.vouchers.size).toBe(0);
    expect(f.calls.some(row => row.url === '/api/v1/approvals/APP-PAY/decide')).toBe(false);
  });

  it('recovers an actual bank payment with its original key and payload, without a second bank fact', async () => {
    const f = boundary('partially_settled'); f.losePayment();
    expect((await runSupplierFinanceScenario(f.context, options)).stopReached).toBe(false);
    expect(f.vouchers.size).toBe(1);
    const result = await runSupplierFinanceScenario(f.context, options);
    expect(result.stopReached).toBe(true); expect(f.vouchers.size).toBe(1);
    const attempts = f.calls.filter(row => row.url.endsWith('/record-payment'));
    expect(attempts).toHaveLength(2); expect(attempts[1].body).toEqual(attempts[0].body);
  });

  it('recovers an AP request with the original key and body after a committed ACK is lost', async () => {
    const f = boundary('partially_settled'); f.loseRequest();
    expect((await runSupplierFinanceScenario(f.context, options)).stopReached).toBe(false);
    expect((await runSupplierFinanceScenario(f.context, options)).stopReached).toBe(true);
    const requests = f.calls.filter(row => row.url === '/api/v1/payment-requests' && row.method === 'post');
    expect(requests).toHaveLength(2); expect(requests[1].body).toEqual(requests[0].body); expect(f.requestCreates).toBe(1);
    expect(f.records.get(`${f.scenario.key}:supplier-finance:payment-request.create`)?.retryPolicy).toBe('native-idempotent');
    expect(f.request.status).toBe('Approved'); expect(f.vouchers.size).toBe(1);
    expect((await runSupplierFinanceScenario(f.context, options)).stopReached).toBe(true);
    expect(f.requestCreates).toBe(1); expect(f.vouchers.size).toBe(1);
  });

  it('does not upgrade a legacy unknown non-idempotent intent or reuse an original command with changed terms', async () => {
    const f = boundary('partially_settled'); f.loseRequest();
    await expect(scenarioCommand(f.deps, { key: `${f.scenario.key}:supplier-finance:payment-request.create`, actor: f.scenario.finance,
      method: 'post', url: '/api/v1/payment-requests', body: { supplierId: f.scenario.supplierId, currency: 'CNY', totalAmount: '10', payableSelections: [] } })).rejects.toThrow('disconnected');
    expect((await runSupplierFinanceScenario(f.context, options)).blockedAt).toContain('SCENARIO_COMMAND_CHANGED');
    expect(f.requestCreates).toBe(1);
    expect(f.records.get(`${f.scenario.key}:supplier-finance:payment-request.create`)?.retryPolicy).toBe('reconcile-create');
    const changed = boundary('partially_settled'); await runSupplierFinanceScenario(changed.context, options);
    expect((await runSupplierFinanceScenario(changed.context, { ...options, supplierPaymentDueDate: '2026-11-08' })).blockedAt).toContain('SCENARIO_COMMAND_CHANGED');
  });

  it('requires a real supplier payment due date separately from the sales delivery day before any command', async () => {
    const f = boundary('partially_settled');
    expect((await runSupplierFinanceScenario(f.context, { ...options, supplierPaymentDueDate: '' })).stopReached).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it('never overwrites an existing different supplier approval roster or consumes a foreign order source', async () => {
    const f = boundary('partially_settled'); f.setAuthority({ version: 4, userIds: [master.cast.logistics1.id] });
    expect((await runSupplierFinanceScenario(f.context, options)).blockedAt).toContain('SUPPLIER_APPROVAL_POLICY_CHANGED');
    expect(f.calls.some(row => row.method === 'put')).toBe(false);
    const foreign = boundary('partially_settled'); foreign.source.customerRelationId = master.businessTeams.find(row => row.key !== foreign.scenario.teamKey)!.customerIds[0];
    expect((await runSupplierFinanceScenario(foreign.context, options)).blockedAt).toContain('ORDER_SOURCE_MISMATCH');
    expect(foreign.calls.some(row => row.method === 'post')).toBe(false);
  });
});
