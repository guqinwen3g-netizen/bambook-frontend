import { describe, expect, it } from 'vitest';
import { planScenarioMasterData } from './masterData';
import { buildBusinessScenarios, SCENARIO_BUSINESS_TIME } from './scenarios';
import type { DevelopmentConfirmedArchive, DevelopmentDriverResult, DevelopmentScenarioExecution } from './developmentDriver';
import type { ScenarioCommandRecord, ScenarioDriverDependencies, ScenarioHttpResponse } from './driverContract';
import { runDevelopmentFinanceScenarios, type DevelopmentFinanceDriverOptions } from './developmentFinanceDriver';

const master = planScenarioMasterData({ namespace: 'dev-finance-protocol', nowMs: Date.parse(SCENARIO_BUSINESS_TIME) });
const scenarios = buildBusinessScenarios(master).developments;
const selected = scenarios.filter(s => s.stopAfter === 'development_ci_finance');
type Row = Record<string, unknown>;
const row = (value: unknown) => value as Row;

/** Pure HTTP protocol simulator. No database or business-state seed. Each
 * downstream fact exists only after the corresponding producer call. */
function protocol() {
  const archives: DevelopmentConfirmedArchive[] = selected.map(s => ({ scenarioKey: s.key, family: s.family, caseId: `case-${s.family}`,
    batchId: `batch-${s.family}`, versionId: `version-${s.family}`, assetId: `asset-${s.family}`, reviewId: `review-${s.family}`,
    confirmationId: `confirmation-${s.family}`, factoryId: s.supplierIds[0], customerId: s.customerId,
    ownerActorKey: s.owner, physicalCardIds: [`card-${s.family}`] }));
  const development: DevelopmentDriverResult = { archives, executions: scenarios.map<DevelopmentScenarioExecution>(s => {
    const ids: Record<string, string | string[]> = {};
    if (s.stopAfter === 'development_ci_finance') Object.assign(ids, { caseId: `case-${s.family}`, batchId: `batch-${s.family}`,
      versionId: `version-${s.family}`, assetId: `asset-${s.family}` });
    return { key: s.key, family: s.family,
    earnedSteps: s.stopAfter === 'development_ci_finance' ? ['qc_completed_pass', 'requester_confirmed', 'version_archived'] : ['earlier_stop'],
    stopReached: s.stopAfter !== 'development_ci_finance', ...(s.stopAfter === 'development_ci_finance' ? {
      blockedAt: 'development_ci_finance', blockedReason: 'DEVELOPMENT_CI_FINANCE_HANDOFF_REQUIRED', archive: archives.find(a => a.scenarioKey === s.key),
    } : {}), ids };
  }) };
  const records = new Map<string, ScenarioCommandRecord>(), costs = new Map<string, Row>(), billings = new Map<string, Row>();
  const docs = new Map<string, Row>(), invoices = new Map<string, Row>(), vouchers = new Map<string, Row>(), allocations = new Map<string, Row>();
  const entries: Row[] = [], calls: Array<{ actor: string; method: string; url: string; body?: unknown }> = [];
  const account: Row = { id: 'actual-usd-account', currency: 'USD', revision: 1 };
  let denied: string | null = null;
  const deps: ScenarioDriverDependencies = {
    runtimeId: 'pure-test', actorIds: Object.fromEntries(Object.values(master.cast).map(a => [a.key, a.id])) as Record<keyof typeof master.cast, string>,
    async verifyActor(actor) { if (denied === actor) throw Error('ACTUAL_ACCOUNT_REVOKED'); },
    journal: { async read(key) { return records.get(key) ?? null; }, async write(record) { records.set(record.key, structuredClone(record)); } },
    async invoke(actor, method, url, input) {
      calls.push({ actor, method, url, body: structuredClone(input) }); const body = row(input ?? {});
      const match = url.match(/^\/api\/v1\/development\/(case-(fabric|garment))(?:\/(.*))?$/);
      if (match) {
        const [, caseId, family, tail] = match, s = selected.find(s => s.family === family)!, a = archives.find(a => a.caseId === caseId)!;
        if (actor !== s.owner) return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
        if (method === 'get' && !tail) return { status: 200, body: { ok: true, case: { id: caseId, code: s.key, type: family,
          ownerId: master.cast[s.owner].id, customerRelationId: s.customerId, stage: 'approved' } } };
        if (tail === 'batches' && method === 'get') return { status: 200, body: { ok: true, batches: [{ id: a.batchId, developmentCaseId: caseId,
          sampleVersionId: a.versionId, supplierRelationId: a.factoryId, linkedAsset: { id: a.assetId },
          latestFormalQcReview: { id: a.reviewId, sampleVersionId: a.versionId, result: 'pass', status: 'acknowledged' },
          versionConfirmation: { id: a.confirmationId, sampleVersionId: a.versionId, result: 'approved' } }] } };
        if (tail === 'closure-preview' && method === 'get') return { status: 200, body: { closure: { state: 'active', revision: 0, lifecycleEventId: null } } };
        if (tail === 'costs' && method === 'post') {
          const id = `cost-${family}`, cost = { ...body, id, bearerType: 'internal', commandAck: { caseId, costRecordId: id,
            actorId: master.cast[actor].id, requestKey: body.requestKey, auditId: `audit-${id}` } };
          costs.set(caseId, cost); return { status: 200, body: { costRecord: cost } };
        }
        if (tail === 'expense-review-preview' && method === 'get') return { status: 200, body: { review: { snapshot: { costs: {
          records: [...costs.values()].filter(c => c.sourceId === a.batchId) } } } } };
        if (tail === 'billing-drafts' && method === 'post') {
          if (!costs.has(caseId)) throw Error('Expense producer required');
          const billing = { ...body, id: `billing-${family}`, sourceType: 'DevelopmentCase', sourceId: caseId, chargeType: 'development_fee',
            bearerType: 'customer', bearerRelationId: s.customerId, status: 'draft', developmentWorkflowState: 'draft' };
          billings.set(caseId, billing); return { status: 200, body: { billingItem: billing } };
        }
        if (tail === 'billing-drafts' && method === 'get') return { status: 200, body: { billingItems: [billings.get(caseId)] } };
        if (tail?.startsWith('ci-source/') && method === 'get') {
          const b = billings.get(caseId)!;
          return { status: 200, body: { caseId, billingItemId: b.id, sourceFingerprint: 'a'.repeat(64), currency: b.currency,
            totalAmount: b.amount, costs: [costs.get(caseId)], document: docs.get(caseId) ?? null } };
        }
        if (tail === 'ci-commands' && method === 'post') {
          const b = billings.get(caseId)!;
          if (body.billingItemId !== b.id || body.expectedSourceFingerprint !== 'a'.repeat(64)) throw Error('CI needs actual source');
          const version = Number(body.expectedVersion) + 1, issued = body.action === 'issue', documentId = `document-${family}`, versionId = `ci-version-${family}-${version}`;
          if (issued && !docs.has(caseId)) throw Error('Draft producer required');
          const fields = !issued ? body.fields : row(docs.get(caseId)!.snapshot).fields;
          const document = { document: { id: documentId, documentNumber: `DEV-CI-${family}`, status: issued ? 'Issued' : 'Draft' },
            version: { id: versionId, documentId, version }, snapshot: { caseId, billingItemId: b.id, currency: b.currency,
              customerRelationId: s.customerId, totalAmount: b.amount, sourceFingerprint: 'a'.repeat(64), costs: [costs.get(caseId)], fields,
              issuedBy: issued ? master.cast[actor].id : null, command: { action: body.action, requestKey: body.requestKey } } };
          docs.set(caseId, document); if (issued) Object.assign(b, { status: 'confirmed', developmentWorkflowState: 'business_ci_issued' });
          return { status: 200, body: { document, receipt: { action: body.action, requestKey: body.requestKey, actorId: master.cast[actor].id,
            caseId, billingItemId: b.id, documentId, versionId, version, auditId: `audit-${versionId}` } } };
        }
        if (tail?.startsWith('ci/') && method === 'get') return { status: 200, body: docs.get(caseId) };
        if (tail === 'ci-finance' && method === 'get') {
          const doc = docs.get(caseId), invoice = invoices.get(caseId), found = [...allocations.values()].filter(a => a.invoiceId === invoice?.id);
          const applied = found.reduce((sum, a) => sum + Number(a.appliedAmount), 0), amount = Number(invoice?.amount ?? 100);
          return { status: 200, body: { caseId, customerRelationId: s.customerId, items: doc ? [{ documentId: row(doc.document).id,
            versionId: row(doc.version).id, billingItemId: billings.get(caseId)!.id, currency: billings.get(caseId)!.currency,
            amount: String(amount), status: row(doc.document).status, registrationState: invoice ? 'registered' : 'pending_registration',
            snapshot: doc.snapshot, invoice: invoice ? { ...invoice, appliedAmount: String(applied), openAmount: String(amount - applied) } : null,
            receipts: found.map(a => ({ ...a, voucher: vouchers.get(String(a.voucherId)) })) }] : [] } };
        }
      }
      if (url === '/api/v1/finance/development-ci-pending' && method === 'get') return { status: 200, body: { items: selected.flatMap(s => {
        const caseId = `case-${s.family}`, doc = docs.get(caseId), b = billings.get(caseId);
        return doc && !invoices.has(caseId) ? [{ caseId, customerRelationId: s.customerId, documentId: row(doc.document).id,
          versionId: row(doc.version).id, billingItemId: b!.id, amount: b!.amount, currency: b!.currency }] : [];
      }) } };
      const registration = url.match(/^\/api\/v1\/finance\/development-ci\/document-(fabric|garment)\/register$/);
      if (registration && method === 'post') {
        const family = registration[1], caseId = `case-${family}`, s = selected.find(s => s.family === family)!, doc = docs.get(caseId)!;
        if (actor !== s.finance || row(doc.document).status !== 'Issued' || body.expectedVersionId !== row(doc.version).id) throw Error('Finance needs issued original');
        const invoice = { id: `invoice-${family}`, type: 'Receivable', sourceType: 'BusinessDevelopmentCI', sourceId: body.expectedVersionId,
          invoiceNumber: `DEV-CI-${family}`, customerRelationId: s.customerId, currency: billings.get(caseId)!.currency,
          amount: billings.get(caseId)!.amount, status: 'Issued' }; invoices.set(caseId, invoice);
        Object.assign(billings.get(caseId)!, { status: 'invoiced', invoiceId: invoice.id });
        return { status: 200, body: { invoice, receipt: { operation: 'register_development_ci_receivable', requestKey: body.requestKey,
          actorId: master.cast[actor].id, documentId: row(doc.document).id, versionId: body.expectedVersionId, invoiceId: invoice.id,
          auditId: `audit-ar-${family}`, caseId } } };
      }
      if (url.startsWith('/api/v1/finance/cash-accounts/') && method === 'get') return { status: 200, body: { ok: true,
        account: { ...account }, balance: null, balanceStatus: 'unknown', entries: structuredClone(entries) } };
      if (url === '/api/v1/finance/vouchers' && method === 'post') {
        if (body.companyAccountId !== account.id || body.expectedAccountRevision !== account.revision || body.currency !== account.currency) throw Error('Account mismatch');
        const id = `receipt-${vouchers.size + 1}`, cashEntryId = `entry-${vouchers.size + 1}`, voucher = { ...body, id, cashEntryId, ownerId: master.cast[actor].id };
        vouchers.set(id, voucher); entries.push({ id: cashEntryId, sourceVoucherId: id, kind: 'Receipt', amount: body.amount }); account.revision = Number(account.revision) + 1;
        return { status: 201, body: { ...voucher, financeCommand: { kind: 'voucher.create', actorId: master.cast[actor].id,
          requestKey: body.requestKey, targetId: id, auditId: `audit-${id}` } } };
      }
      if (url.startsWith('/api/v1/finance/vouchers/') && method === 'get') return { status: 200, body: vouchers.get(url.substring(url.lastIndexOf('/') + 1)) };
      if (url.startsWith('/api/v1/finance/allocations?') && method === 'get') {
        const p = new URL(url, 'http://pure.invalid').searchParams, items = [...allocations.values()].filter(a => (!p.get('invoiceId') || a.invoiceId === p.get('invoiceId')) && (!p.get('voucherId') || a.voucherId === p.get('voucherId')));
        return { status: 200, body: { items, total: items.length } };
      }
      if (url === '/api/v1/finance/allocations' && method === 'post') {
        const invoice = [...invoices.values()].find(i => i.id === body.invoiceId), voucher = vouchers.get(String(body.voucherId));
        if (!invoice || !voucher || Number(body.appliedAmount) > Number(invoice.amount) || Number(body.appliedAmount) !== Number(voucher.amount)) throw Error('Actual cash allocation required');
        const id = `allocation-${allocations.size + 1}`, allocation = { ...body, id }; allocations.set(id, allocation);
        invoice.status = Number(body.appliedAmount) === Number(invoice.amount) ? 'Paid' : 'PartiallyPaid';
        return { status: 201, body: { allocation, auditId: `audit-${id}` } };
      }
      throw Error(`Unexpected pure finance call: ${actor} ${method} ${url}`);
    },
  };
  const native = deps.invoke, receipts = new Map<string, { body: string; response: ScenarioHttpResponse }>();
  deps.invoke = async (actor, method, url, input) => {
    const requestKey = input && typeof input === 'object' && 'requestKey' in input ? input.requestKey : undefined;
    const key = typeof requestKey === 'string' ? `${actor}:${url}:${requestKey}` : null, prior = key ? receipts.get(key) : undefined;
    if (prior) { calls.push({ actor, method, url, body: structuredClone(input) });
      if (prior.body !== JSON.stringify(input)) return { status: 409, body: { error: { code: 'REQUEST_CONFLICT' } } };
      return structuredClone(prior.response); }
    const response = await native(actor, method, url, input);
    if (key && response.status >= 200 && response.status < 300) receipts.set(key, { body: JSON.stringify(input), response: structuredClone(response) });
    return structuredClone(response);
  };
  return { deps, development, calls, records, docs, costs, billings, invoices, vouchers, allocations, account, entries,
    deny: (actor: string | null) => { denied = actor; } };
}

describe('development finance bridge producer protocol', () => {
  it('bridges the two confirmed CI archives to original AR; preserves all 24 cases and distinct duties', async () => {
    const f = protocol(), original = structuredClone(f.development);
    const result = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps);
    expect(result.executions).toHaveLength(24); expect(result.executions.every(r => r.stopReached)).toBe(true);
    expect(result.archives).toEqual(original.archives); expect(f.development).toEqual(original);
    expect(f.docs.size).toBe(2); expect(f.invoices.size).toBe(2); expect(f.vouchers.size).toBe(0);
    expect(result.finance.map(r => r.state)).toEqual(['unpaid', 'unpaid']);
    for (const s of selected) {
      const execution = result.executions.find(r => r.key === s.key)!;
      expect(execution.blockedAt).toBeUndefined(); expect(execution.earnedSteps).toContain('development_ci_finance_registered');
      expect(f.calls.filter(c => c.method === 'post' && c.url.includes(`case-${s.family}/ci-commands`)).every(c => c.actor === s.owner)).toBe(true);
    }
    expect(f.calls.some(c => c.method !== 'get' && /lifecycle|expense-reviews$|workflow|approvals/.test(c.url))).toBe(false);
  });

  it('refreshes an existing CI draft as the next immutable version before issuing and registering AR', async () => {
    const f = protocol();
    for (const s of selected.slice(0, 1)) f.docs.set(`case-${s.family}`, { document: { id: `document-${s.family}`, status: 'Draft' }, version: { version: 1 }, snapshot: { fields: {} } });
    const result = await runDevelopmentFinanceScenarios(master, selected.slice(0, 1), f.development, f.deps, {
      ciBaseVersions: Object.fromEntries(selected.map(s => [s.key, 1])),
    });
    expect(result.finance.filter(r => r.state === 'blocked')).toEqual([]);
    expect(result.finance.map(r => r.state)).toEqual(['unpaid']);
    for (const s of selected.slice(0, 1)) {
      const commands = f.calls.filter(c => c.method === 'post' && c.url.includes(`case-${s.family}/ci-commands`));
      expect(commands.map(c => row(c.body).expectedVersion)).toEqual([1, 2]);
      expect(row(f.docs.get(`case-${s.family}`)!.version).version).toBe(3);
    }
  });

  const paymentOptions = (amount = '40'): DevelopmentFinanceDriverOptions => ({ paymentPlans: {
    [selected[0].key]: { amount, cashAccountId: 'actual-usd-account', bankReference: 'SIMULATION-BANK-ACTUAL-001' },
  } });

  it('earns a partial actual receipt for one case and leaves the other unpaid, without inventing Opening or converting costs', async () => {
    const f = protocol(), result = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps, paymentOptions());
    expect(result.finance).toEqual([
      expect.objectContaining({ state: 'partially_paid', amount: '100.0000', appliedAmount: '40.0000', openAmount: '60.0000' }),
      expect.objectContaining({ state: 'unpaid', appliedAmount: '0.0000', openAmount: '100.0000' }),
    ]);
    expect(f.vouchers.size).toBe(1); expect(f.allocations.size).toBe(1); expect(f.entries).toHaveLength(1);
    expect([...f.costs.values()].every(c => c.sourceType === 'SampleBatch' && c.costType === 'sample_making' && c.currency === 'CNY' && c.amount === '20')).toBe(true);
    expect([...f.billings.values()].every(c => c.currency === 'USD' && c.amount === '100' && c.waivedAmount === '0')).toBe(true);
    expect(f.calls.some(c => c.method !== 'get' && /cash-accounts/.test(c.url))).toBe(false);
    expect([...f.vouchers.values()][0]).toMatchObject({ type: 'Receipt', amount: '40', currency: 'USD', paymentDate: '2026-10-08', bankReference: 'SIMULATION-BANK-ACTUAL-001' });
  });

  it('can earn a fully paid AR from the explicitly supplied exact receipt amount without closing development', async () => {
    const f = protocol(), result = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps, paymentOptions('100'));
    expect(result.finance[0]).toMatchObject({ state: 'paid', appliedAmount: '100.0000', openAmount: '0.0000' });
    expect(result.executions.every(r => r.stopReached)).toBe(true);
    expect(f.calls.some(c => c.method !== 'get' && c.url.endsWith('/lifecycle'))).toBe(false);
  });

  it('rechecks current source/account/AR facts when resuming completed cases without duplicate producer writes', async () => {
    const f = protocol(), first = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps, paymentOptions());
    const before = f.calls.filter(c => c.method !== 'get').length, readCount = f.calls.filter(c => c.method === 'get').length;
    const resumed = await runDevelopmentFinanceScenarios(master, scenarios, first, f.deps, paymentOptions());
    expect(resumed.executions.every(r => r.stopReached)).toBe(true); expect(resumed.finance).toEqual(first.finance);
    expect(f.calls.filter(c => c.method !== 'get')).toHaveLength(before);
    expect(f.calls.filter(c => c.method === 'get').length).toBeGreaterThan(readCount);
    expect(f.docs.size).toBe(2); expect(f.invoices.size).toBe(2); expect(f.vouchers.size).toBe(1); expect(f.allocations.size).toBe(1);
  });

  for (const loss of ['issue', 'register', 'receipt'] as const) {
    it(`recovers the original ${loss} command after commit/ACK loss with identical key and content`, async () => {
      const f = protocol(), base = f.deps.invoke, lostInputs: unknown[] = []; let lose = true;
      f.deps.invoke = async (actor, method, url, body) => {
        const isTarget = method === 'post' && (loss === 'issue' ? url.includes('case-fabric/ci-commands') && row(body).action === 'issue'
          : loss === 'register' ? url.includes('/development-ci/document-fabric/register') : url === '/api/v1/finance/vouchers');
        if (isTarget) lostInputs.push(structuredClone(body));
        const response = await base(actor, method, url, body);
        if (isTarget && lose) { lose = false; throw Error('COMMITTED_ACK_DISCONNECTED'); }
        return response;
      };
      const first = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps, paymentOptions());
      expect(first.executions.find(r => r.key === selected[0].key)).toMatchObject({ stopReached: false, blockedReason: 'COMMITTED_ACK_DISCONNECTED' });
      const originalIntent = [...f.records.values()].find(r => r.state === 'intent')!;
      expect(originalIntent).toBeDefined(); expect(originalIntent.retryPolicy).toBe('native-idempotent');
      const resumed = await runDevelopmentFinanceScenarios(master, scenarios, first, f.deps, paymentOptions());
      expect(resumed.executions.every(r => r.stopReached)).toBe(true); expect(lostInputs).toHaveLength(2); expect(lostInputs[1]).toEqual(lostInputs[0]);
      expect(f.docs.size).toBe(2); expect(f.invoices.size).toBe(2); expect(f.vouchers.size).toBe(1); expect(f.allocations.size).toBe(1);
      expect(f.records.get(originalIntent.key)?.state).toBe('acknowledged');
    });
  }

  it('reconciles an unknown non-idempotent allocation only through current exact invoice/voucher readback, without resending', async () => {
    const f = protocol(), base = f.deps.invoke; let lose = true;
    f.deps.invoke = async (actor, method, url, body) => {
      const response = await base(actor, method, url, body);
      if (lose && method === 'post' && url === '/api/v1/finance/allocations') { lose = false; throw Error('ALLOCATION_COMMITTED_ACK_LOST'); }
      return response;
    };
    const first = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps, paymentOptions());
    expect(first.finance[0]).toMatchObject({ state: 'blocked', blockedAt: 'development_receipt_allocated' });
    const intent = [...f.records.values()].find(r => r.url === '/api/v1/finance/allocations')!;
    expect(intent.state).toBe('intent'); expect(intent.retryPolicy).toBe('reconcile-create');
    const resumed = await runDevelopmentFinanceScenarios(master, scenarios, first, f.deps, paymentOptions());
    expect(resumed.finance[0]).toMatchObject({ state: 'partially_paid', allocationId: 'allocation-1' });
    expect(f.calls.filter(c => c.method === 'post' && c.url === '/api/v1/finance/allocations')).toHaveLength(1);
    expect(f.records.get(intent.key)?.state).toBe('intent'); // Current readback is evidence, never a fabricated command ACK.
  });

  it('keeps an unknown allocation blocked when exact current readback has no committed row', async () => {
    const f = protocol(), base = f.deps.invoke; let sends = 0;
    f.deps.invoke = async (actor, method, url, body) => {
      if (method === 'post' && url === '/api/v1/finance/allocations') { sends++; throw Error('ALLOCATION_CONNECTION_LOST'); }
      return base(actor, method, url, body);
    };
    const first = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps, paymentOptions());
    const resumed = await runDevelopmentFinanceScenarios(master, scenarios, first, f.deps, paymentOptions());
    expect(resumed.finance[0]).toMatchObject({ state: 'blocked', blockedAt: 'development_receipt_allocated', blockedReason: 'SCENARIO_ALLOCATION_ACK_UNKNOWN_READBACK_REQUIRED' });
    expect(sends).toBe(1); expect(f.allocations.size).toBe(0); expect(f.vouchers.size).toBe(1);
    expect([...f.records.values()].find(r => r.url === '/api/v1/finance/allocations')?.state).toBe('intent');
  });

  it('retains the original unknown receipt after later finance authority revocation and resumes only after current authority returns', async () => {
    const f = protocol(), base = f.deps.invoke; let lose = true;
    f.deps.invoke = async (actor, method, url, body) => {
      const response = await base(actor, method, url, body);
      if (lose && method === 'post' && url === '/api/v1/finance/vouchers') { lose = false; throw Error('RECEIPT_ACK_LOST'); }
      return response;
    };
    const first = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps, paymentOptions());
    const intent = structuredClone([...f.records.values()].find(r => r.url === '/api/v1/finance/vouchers')!);
    f.deny(selected[0].finance);
    const revoked = await runDevelopmentFinanceScenarios(master, scenarios, first, f.deps, paymentOptions());
    expect(revoked.finance[0].state).toBe('blocked'); expect(revoked.finance[0].blockedReason).toContain('ACTUAL_ACCOUNT_REVOKED');
    expect(f.records.get(intent.key)).toEqual(intent); expect(f.vouchers.size).toBe(1); expect(f.allocations.size).toBe(0);
    f.deny(null);
    const restored = await runDevelopmentFinanceScenarios(master, scenarios, revoked, f.deps, paymentOptions());
    expect(restored.finance[0].state).toBe('partially_paid'); expect(f.vouchers.size).toBe(1); expect(f.allocations.size).toBe(1);
  });

  it('rejects changed fee/receipt content and cross-runtime journal reuse instead of replacing an earlier intent', async () => {
    const f = protocol(), first = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps, paymentOptions());
    const changed = await runDevelopmentFinanceScenarios(master, scenarios, first, f.deps, paymentOptions('50'));
    expect(changed.finance[0].state).toBe('blocked'); expect(changed.finance[0].blockedReason).toContain('SCENARIO_COMMAND_CHANGED');
    expect(f.vouchers.size).toBe(1); expect(f.allocations.size).toBe(1);
    f.deps.runtimeId = 'different-target';
    const foreign = await runDevelopmentFinanceScenarios(master, scenarios, first, f.deps, paymentOptions());
    expect(foreign.finance.every(r => r.state === 'blocked' && r.blockedReason?.includes('SCENARIO_COMMAND_CHANGED'))).toBe(true);
    expect(f.invoices.size).toBe(2);
  });

  it('blocks a foreign or missing archive before any expense/CI producer, while another correct case still runs', async () => {
    const f = protocol(); f.development.archives[0].customerId = selected[1].customerId;
    const result = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps);
    expect(result.finance[0]).toMatchObject({ state: 'blocked', blockedReason: 'SCENARIO_ARCHIVE_SOURCE_MISMATCH' });
    expect(result.finance[1].state).toBe('unpaid'); expect(f.costs.size).toBe(1); expect(f.invoices.size).toBe(1);
  });

  it('rejects an issued snapshot with the wrong exact version and never registers its AR', async () => {
    const f = protocol(), base = f.deps.invoke;
    f.deps.invoke = async (actor, method, url, body) => {
      const response = await base(actor, method, url, body);
      if (method === 'get' && url.includes('case-fabric/ci/document-fabric')) row(row(response.body).version).id = 'wrong-issued-version';
      return response;
    };
    const result = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps);
    expect(result.finance[0]).toMatchObject({ state: 'blocked', blockedReason: 'SCENARIO_ISSUED_CI_READBACK_MISMATCH' });
    expect(f.invoices.has('case-fabric')).toBe(false); expect(f.invoices.has('case-garment')).toBe(true);
    expect(result.executions.find(r => r.key === selected[0].key)?.ids.developmentCiVersionId).toBe('ci-version-fabric-2');
  });

  it('blocks a wrong-currency actual bank account before producing Receipt, without guessing exchange rates', async () => {
    const f = protocol(); f.account.currency = 'EUR';
    const result = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps, paymentOptions());
    expect(result.finance[0]).toMatchObject({ state: 'blocked', blockedReason: 'SCENARIO_CASH_ACCOUNT_CURRENCY_OR_REVISION_MISMATCH' });
    expect(f.invoices.size).toBe(2); expect(f.vouchers.size).toBe(0); expect(f.allocations.size).toBe(0);
  });

  it('does not claim an unpaid stop when later actual allocations have changed its current AR balance', async () => {
    const f = protocol(), first = await runDevelopmentFinanceScenarios(master, scenarios, f.development, f.deps, paymentOptions());
    const result = await runDevelopmentFinanceScenarios(master, scenarios, first, f.deps);
    expect(result.finance[0]).toMatchObject({ state: 'blocked', blockedReason: 'SCENARIO_AR_BALANCE_NOT_EARNED' });
    expect(result.finance[1].state).toBe('unpaid'); expect(f.vouchers.size).toBe(1);
  });
});
