import {createAcceptanceCashAccount,acceptanceCashInput} from './companyCashAcceptanceHelpers';
/** Opt-in isolated PG/HTTP evidence. Fixtures contain accounts/master data;
 * actual expenses, billing decisions, issued CI, AR and allocations are only
 * created through their canonical HTTP producers. No financial fact is seeded. */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevelopmentBusinessCiRouter } from '../src/development/developmentBusinessCiRoute';
import { createDevelopmentCiFinanceRouter } from '../src/finance/developmentCiFinanceRoute';
import { createFinanceRouter } from '../src/finance/route';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, type GlobalBusinessHttpFixture, type BusinessFixtureActorName, type HttpMethod } from './globalBusinessFixtures';

let prisma: PrismaClient, f: GlobalBusinessHttpFixture;
let loseAcknowledgement: 'issue' | 'register' | 'supplement' | null = null;
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
const http = (actor: BusinessFixtureActorName, method: HttpMethod, path: string, body?: unknown) => f.request(actor, method, path, body);
function status(response: any, expected = 200, context = 'development CI HTTP') {
  expect(response.status, `${context}: ${diagnostic(response.body)}`).toBe(expected);
  expect(diagnostic(response.body)).not.toMatch(/P2003|P2010|23503|42703|PRIVATE committed CI acknowledgement/i);
  return response.body;
}
beforeAll(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL } } });
  await assertIsolatedAcceptanceDatabase(prisma);
  const client = new Proxy(prisma, { get(target, key) {
    if (key === '$transaction') return async (...args: any[]) => {
      const result = await (target.$transaction as any)(...args);
      const lostIssue = loseAcknowledgement === 'issue' && result?.receipt?.action === 'issue';
      const lostRegistration = loseAcknowledgement === 'register' && result?.receipt?.operation === 'register_development_ci_receivable';
      const lostSupplement = loseAcknowledgement === 'supplement' && result?.receipt?.operation === 'create_development_supplemental_billing';
      if ((lostIssue || lostRegistration || lostSupplement) && result.replayed === false) { loseAcknowledgement = null; throw new Error('PRIVATE committed CI acknowledgement disconnected'); }
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  f = await createGlobalBusinessHttpFixture(prisma, { prefix: `dev-ci-${randomUUID().slice(0, 8)}`, mountAdditionalRoutes(app) {
    app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? String(value) : value);
    const options = { prisma: client, requireAuth: true, apiKeys: new Set<string>() };
    app.use('/api/v1/development', createDevelopmentBusinessCiRouter(options));
    app.use('/api/v1/finance', createDevelopmentCiFinanceRouter(options));
    app.use('/api/v1/finance', createFinanceRouter(options));
  } });
}, 120_000);
afterAll(async () => { await f?.close(); await prisma?.$disconnect(); });

async function draft(label: string, amount = '100') {
  const created = status(await http('salesOwner', 'post', '/api/v1/development', {
    code: `${f.prefix}-${label}`, name: `开发收费 ${label}`, type: 'fabric', ownerId: f.actors.salesOwner.id,
    initiator: 'customer', customerInput: 'spec-direction', customerRelationId: f.customer.id, customerName: f.customer.name,
    developmentDirection: '独立真实开发费用及客户收费', source: 'customer-request',
  }), 201, 'create development');
  const caseId = created.case.id, path = `/api/v1/development/${encodeURIComponent(caseId)}`;
  const expense = status(await http('salesOwner', 'post', `${path}/costs`, { requestKey: randomUUID(), sourceType: 'DevelopmentCase',
    sourceId: caseId, costType: 'development', amount: '20', currency: 'CNY', incurredAt: '2026-10-07',
    bearerType: 'customer', bearerRelationId: f.customer.id, notes: '实际开发服务账单，原币成本' }), 200, 'register actual expense').costRecord;
  expect(expense).toMatchObject({ sourceType: 'DevelopmentCase', sourceId: caseId, costType: 'development', currency: 'CNY' });
  const billed = status(await http('salesOwner', 'post', `${path}/billing-drafts`, { requestKey: randomUUID(), amount,
    waivedAmount: '0', currency: 'USD', note: '业务与客户确定开发服务收费，独立于原币成本' }), 200, 'business billing decision');
  const billingId = billed.billingItem.id;
  const source = status(await http('salesOwner', 'get', `${path}/ci-source/${encodeURIComponent(billingId)}`));
  const save = { action: 'save', requestKey: randomUUID(), billingItemId: billingId, expectedVersion: 0,
    expectedSourceFingerprint: source.sourceFingerprint, fields: { issueDate: '2026-10-07', dueDate: '2026-11-07',
      paymentTerms: 'TT 30 days', note: 'Development services', billTo: { name: f.customer.name, address: 'Synthetic buyer address' },
      exporter: { nameEn: 'Synthetic seller', addressEn: 'Synthetic seller address', beneficiary: 'Synthetic seller', bankName: 'Synthetic bank', usdAccountNumber: 'ACCEPTANCE-ONLY' } } };
  const saved = status(await http('salesOwner', 'post', `${path}/ci-commands`, save), 200, 'business saves CI');
  const issue = { action: 'issue', requestKey: randomUUID(), billingItemId: billingId, documentId: saved.receipt.documentId,
    expectedVersion: 1, expectedSourceFingerprint: source.sourceFingerprint };
  const businessState = await prisma.developmentCase.findUniqueOrThrow({ where: { id: caseId }, select: { stage: true } });
  const lifecycleEvents = await prisma.developmentLifecycleEvent.findMany({ where: { developmentCaseId: caseId }, orderBy: { revision: 'asc' } });
  return { caseId, path, expense, billingId, source, save, saved, issue, businessState, lifecycleEvents };
}
async function issueAndRegister(label: string, amount = '100') {
  const d = await draft(label, amount);
  const issued = status(await http('salesOwner', 'post', `${d.path}/ci-commands`, d.issue));
  const registration = { requestKey: randomUUID(), expectedVersionId: issued.receipt.versionId };
  const registered = status(await http('finance', 'post', `/api/v1/finance/development-ci/${issued.receipt.documentId}/register`, registration));
  return { ...d, issued, registration, registered, invoice: registered.invoice };
}

describe('Development CI → Finance registration → multi-invoice cash allocation → development readback', () => {
  it('recovers exact original business and registration acknowledgements, then reads true many-to-many balances', async () => {
    const a = await draft('cash-a'); loseAcknowledgement = 'issue';
    status(await http('salesOwner', 'post', `${a.path}/ci-commands`, a.issue), 500, 'lost issued acknowledgement');
    const issued = status(await http('salesOwner', 'post', `${a.path}/ci-commands`, a.issue));
    expect(issued.replayed).toBe(true);
    expect(await prisma.documentVersion.count({ where: { documentId: issued.receipt.documentId } })).toBe(2);
    const pending = status(await http('finance', 'get', '/api/v1/finance/development-ci-pending'));
    expect(pending.items).toContainEqual(expect.objectContaining({ caseId: a.caseId, versionId: issued.receipt.versionId, amount: '100.0000', currency: 'USD' }));
    const command = { requestKey: randomUUID(), expectedVersionId: issued.receipt.versionId }; loseAcknowledgement = 'register';
    const registrationPath = `/api/v1/finance/development-ci/${issued.receipt.documentId}/register`;
    status(await http('finance', 'post', registrationPath, command), 500, 'lost registration acknowledgement');
    const first = status(await http('finance', 'post', registrationPath, command)); expect(first.replayed).toBe(true);
    const concurrent = await Promise.all([http('finance', 'post', registrationPath, { ...command, requestKey: randomUUID() }), http('finance', 'post', registrationPath, { ...command, requestKey: randomUUID() })]);
    for (const result of concurrent) expect(status(result)).toMatchObject({ replayed: true, receipt: first.receipt, invoice: { id: first.invoice.id } });
    expect(await prisma.invoice.count({ where: { sourceType: 'BusinessDevelopmentCI', sourceId: issued.receipt.versionId } })).toBe(1);
    const b = await issueAndRegister('cash-b', '60');
    const companyAccount = await createAcceptanceCashAccount(f);
    const makeReceipt = async (number: string, amount: string) => status(await http('finance', 'post', '/api/v1/finance/vouchers', {
      ...await acceptanceCashInput(f,companyAccount.id), requestKey: randomUUID(), voucherNumber: `${f.prefix}-${number}`, type: 'Receipt', amount, currency: 'USD', paymentDate: '2026-10-07',
      paymentMethod: 'TT', customerRelationId: f.customer.id, customerName: f.customer.name,
    }), 201, 'record actual bank receipt');
    const cash = await makeReceipt('cash-1', '100');
    const apply = (invoiceId: string, voucherId: string, appliedAmount: string) => http('finance', 'post', '/api/v1/finance/allocations', { invoiceId, voucherId, appliedAmount, appliedDate: '2026-10-07' });
    const allocationA = status(await apply(first.invoice.id, cash.id, '40'), 201, 'one cash covers first CI');
    status(await apply(b.invoice.id, cash.id, '60'), 201, 'same cash covers second CI');
    const readA = status(await http('salesOwner', 'get', `${a.path}/ci-finance`));
    const readB = status(await http('salesOwner', 'get', `${b.path}/ci-finance`));
    expect(readA.items[0].invoice).toMatchObject({ status: 'PartiallyPaid', appliedAmount: '40.0000', openAmount: '60.0000' });
    expect(readB.items[0].invoice).toMatchObject({ status: 'Paid', appliedAmount: '60.0000', openAmount: '0.0000' });
    expect(readA.items[0].receipts).toHaveLength(1); expect(readA.items[0].receipts[0].appliedAmount).toBe('40');
    const moreCash = await makeReceipt('cash-2', '60'); status(await apply(first.invoice.id, moreCash.id, '60'), 201);
    const settled = status(await http('salesOwner', 'get', `${a.path}/ci-finance`));
    expect(settled.items[0].invoice).toMatchObject({ status: 'Paid', openAmount: '0.0000' }); expect(settled.items[0].receipts).toHaveLength(2);
    expect(status(await http('finance', 'post', registrationPath, command))).toMatchObject({ receipt: first.receipt, invoice: { status: 'Paid' } });
    status(await http('finance', 'delete', `/api/v1/finance/allocations/${allocationA.allocation.id}`));
    expect(status(await http('salesOwner', 'get', `${a.path}/ci-finance`)).items[0].invoice).toMatchObject({ status: 'PartiallyPaid', appliedAmount: '60.0000', openAmount: '40.0000' });
    const ownOriginal = await http('salesOwner', 'get', `${a.path}/ci/${issued.receipt.documentId}/preview.html?version=2`);
    expect(ownOriginal.status).toBe(200); expect(ownOriginal.text).toContain('COMMERCIAL INVOICE');
    const financeOriginal = await http('finance', 'get', `/api/v1/finance/${first.invoice.id}/preview.html`);
    expect(financeOriginal.status).toBe(200); expect(financeOriginal.text).toContain(issued.document.document.documentNumber);
    expect(await prisma.developmentCase.findUniqueOrThrow({ where: { id: a.caseId }, select: { stage: true } })).toEqual(a.businessState);
    expect(await prisma.developmentLifecycleEvent.findMany({ where: { developmentCaseId: a.caseId }, orderBy: { revision: 'asc' } })).toEqual(a.lifecycleEvents);
    const bank=status(await http('finance','get',`/api/v1/finance/cash-accounts/${companyAccount.id}`));
    expect(bank).toMatchObject({balance:null,balanceStatus:'unknown'});expect(bank.entries).toHaveLength(2);
    expect(bank.entries.every((entry:any)=>entry.kind==='Receipt')).toBe(true); // allocations never post another bank entry
  }, 120_000);

  it('refuses overwritten original, foreign L2, stale versions/keys, ordinary financial mutations and old-token revoked grants', async () => {
    const a = await issueAndRegister('boundaries');
    status(await http('salesOwner', 'post', `${a.path}/ci-commands`, { ...a.save, requestKey: randomUUID(), documentId: a.issued.receipt.documentId, expectedVersion: 2 }), 409);
    status(await http('salesOwner', 'post', `${a.path}/ci-commands`, { ...a.issue, requestKey: a.save.requestKey }), 409);
    status(await http('finance', 'post', `/api/v1/finance/development-ci/${a.issued.receipt.documentId}/register`, { requestKey: randomUUID(), expectedVersionId: a.saved.receipt.versionId }), 409);
    status(await http('finance', 'patch', `/api/v1/finance/${a.invoice.id}`, { amount: '999' }), 409, 'finance cannot rewrite original amount');
    status(await http('finance', 'delete', `/api/v1/finance/${a.invoice.id}`), 409, 'finance cannot delete original CI registration');
    status(await http('salesOutsider', 'get', `${a.path}/ci-finance`), 404);
    status(await http('salesOutsider', 'get', `/api/v1/finance/${a.invoice.id}`), 404);
    const hidden = status(await http('salesOutsider', 'get', `/api/v1/finance?customerRelationId=${encodeURIComponent(f.customer.id)}`));
    expect(hidden.total).toBe(0); expect(hidden.items).toEqual([]);
    const allocations = status(await http('salesOutsider', 'get', '/api/v1/finance/allocations')); expect(allocations.items).toEqual([]);
    status(await http('salesOwner', 'post', '/api/v1/finance/allocations', { invoiceId: a.invoice.id, voucherId: 'foreign', appliedAmount: '1' }), 403);
    const d = await draft('revoked');
    const role = await prisma.userRole.findFirstOrThrow({ where: { userId: f.actors.salesOwner.id, roleId: f.actors.salesOwner.roleId } });
    await prisma.userRole.delete({ where: { id: role.id } });
    try {
      const stale = await http('salesOwner', 'post', `${d.path}/ci-commands`, d.issue);
      expect([401, 403]).toContain(stale.status); expect(await prisma.documentVersion.count({ where: { documentId: d.saved.receipt.documentId } })).toBe(1);
      expect([401, 403]).toContain((await http('salesOwner', 'get', `/api/v1/finance/${a.invoice.id}`)).status);
    } finally { await prisma.userRole.create({ data: role }); }
  }, 120_000);

  it('selects true later costs in the same case, issues a second original and allocates cash to both', async () => {
    const a = await issueAndRegister('late-same-case'), firstOriginal = await prisma.documentVersion.findUniqueOrThrow({ where: { id: a.issued.receipt.versionId } });
    const later = async (note: string, amount: string) => status(await http('salesOwner', 'post', `${a.path}/costs`, {
      requestKey: randomUUID(), sourceType: 'DevelopmentCase', sourceId: a.caseId, costType: 'development', amount, currency: 'CNY',
      incurredAt: '2026-10-07', bearerType: 'customer', bearerRelationId: f.customer.id, notes: note,
    }), 200, 'actual later expense').costRecord;
    const selected = await later('Actual later development service', '8'), unselected = await later('Actual later test service', '6');
    const scope = status(await http('salesOwner', 'get', `${a.path}/ci-uncovered-costs`));
    expect(scope.costs.map((row: any) => row.id).sort()).toEqual([selected.id, unselected.id].sort());
    const command = { requestKey: randomUUID(), expectedSourceFingerprint: scope.sourceFingerprint, costRecordIds: [selected.id],
      amount: '30', waivedAmount: '0', currency: 'USD', note: 'Customer agreed supplemental services' };
    status(await http('salesOwner', 'post', `${a.path}/ci-supplemental-billings`, { ...command, requestKey: randomUUID(), costRecordIds: [a.expense.id] }), 409, 'first original cost cannot be covered again');
    status(await http('salesOwner', 'post', `${a.path}/ci-supplemental-billings`, { ...command, requestKey: randomUUID(), costRecordIds: ['other-case-cost'] }), 409);
    loseAcknowledgement = 'supplement'; status(await http('salesOwner', 'post', `${a.path}/ci-supplemental-billings`, command), 500, 'lost supplemental acknowledgement');
    const supplemental = status(await http('salesOwner', 'post', `${a.path}/ci-supplemental-billings`, command)); expect(supplemental.replayed).toBe(true);
    status(await http('salesOwner', 'post', `${a.path}/ci-supplemental-billings`, { ...command, amount: '31' }), 409);
    status(await http('salesOwner', 'post', `${a.path}/ci-supplemental-billings`, { ...command, requestKey: randomUUID() }), 409, 'stale or occupied selection');
    const secondSource = status(await http('salesOwner', 'get', `${a.path}/ci-source/${supplemental.billingItem.id}`));
    expect(secondSource.costs.map((row: any) => row.id)).toEqual([selected.id]);
    const secondDraft = status(await http('salesOwner', 'post', `${a.path}/ci-commands`, { ...a.save, requestKey: randomUUID(),
      billingItemId: supplemental.billingItem.id, expectedSourceFingerprint: secondSource.sourceFingerprint }));
    const second = status(await http('salesOwner', 'post', `${a.path}/ci-commands`, { action: 'issue', requestKey: randomUUID(),
      billingItemId: supplemental.billingItem.id, documentId: secondDraft.receipt.documentId, expectedVersion: 1, expectedSourceFingerprint: secondSource.sourceFingerprint }));
    expect(second.receipt.documentId).not.toBe(a.issued.receipt.documentId);
    const registered = status(await http('finance', 'post', `/api/v1/finance/development-ci/${second.receipt.documentId}/register`, {
      requestKey: randomUUID(), expectedVersionId: second.receipt.versionId }));
    const remaining = status(await http('salesOwner', 'get', `${a.path}/ci-uncovered-costs`)); expect(remaining.costs.map((row: any) => row.id)).toEqual([unselected.id]);
    expect(await prisma.documentVersion.findUniqueOrThrow({ where: { id: a.issued.receipt.versionId } })).toEqual(firstOriginal);
    expect(status(await http('salesOwner', 'get', `${a.path}/ci-source/${a.billingId}`)).costs.map((row: any) => row.id)).toEqual([a.expense.id]);
    const cash = status(await http('finance', 'post', '/api/v1/finance/vouchers', { ...await acceptanceCashInput(f,(await createAcceptanceCashAccount(f)).id), requestKey: randomUUID(), type: 'Receipt', amount: '80', currency: 'USD',
      paymentDate: '2026-10-07', paymentMethod: 'TT', customerRelationId: f.customer.id, customerName: f.customer.name }), 201);
    for (const [invoiceId, appliedAmount] of [[a.invoice.id, '60'], [registered.invoice.id, '20']])
      status(await http('finance', 'post', '/api/v1/finance/allocations', { invoiceId, voucherId: cash.id, appliedAmount, appliedDate: '2026-10-07' }), 201);
    const readback = status(await http('salesOwner', 'get', `${a.path}/ci-finance`));
    expect(readback.items).toHaveLength(2); expect(readback.items.map((row: any) => row.invoice.openAmount).sort()).toEqual(['10.0000', '40.0000']);
    // A real concurrent attempt has one authoritative reservation; its other result cannot create a duplicate.
    const race = { ...command, expectedSourceFingerprint: remaining.sourceFingerprint, costRecordIds: [unselected.id] };
    const raced = await Promise.all([http('salesOwner', 'post', `${a.path}/ci-supplemental-billings`, { ...race, requestKey: randomUUID() }),
      http('salesOwner', 'post', `${a.path}/ci-supplemental-billings`, { ...race, requestKey: randomUUID() })]);
    expect(raced.filter(row => row.status === 200)).toHaveLength(1); expect(raced.filter(row => row.status === 409)).toHaveLength(1);
    expect(await prisma.billingItemCostCoverage.count({ where: { costRecordId: unselected.id, releasedAt: null } })).toBe(1);
    const reserved = raced.find(row => row.status === 200)!.body.billingItem;
    status(await http('salesOwner', 'post', `${a.path}/billing-drafts/${reserved.id}/workflow`, { action: 'cancel', requestKey: randomUUID(),
      expectedVersion: reserved.developmentWorkflowVersion, note: 'Business explicitly defers this separate late service charge' }));
    expect(status(await http('salesOwner', 'get', `${a.path}/ci-uncovered-costs`)).costs.map((row: any) => row.id)).toEqual([unselected.id]);
    expect(await prisma.billingItemCostCoverage.count({ where: { costRecordId: unselected.id, releasedAt: { not: null } } })).toBe(1);
  }, 120_000);

  it('retires native old finance/supplement tasks only when the matching business CI is issued', async () => {
    for (const kind of ['finance_handoff', 'billing_supplement'] as const) {
      const a = await draft(`retire-${kind}`);
      const closure = status(await http('salesOwner', 'get', `${a.path}/closure-preview`)).closure;
      status(await http('salesOwner', 'post', `${a.path}/lifecycle`, { action: 'close', outcome: 'stopped', reason: 'Business stops this independent development request',
        expectedRevision: closure.revision, expectedFingerprint: closure.fingerprint, requestKey: randomUUID() }));
      const expenseScope = status(await http('salesOwner', 'get', `${a.path}/expense-review-preview`)).review;
      const reviewed = status(await http('salesOwner', 'post', `${a.path}/expense-reviews`, { note: 'All actual bills in this request have arrived',
        expectedFingerprint: expenseScope.fingerprint, requestKey: randomUUID() })).review;
      const submitted = status(await http('salesOwner', 'post', `${a.path}/billing-drafts/${a.billingId}/workflow`, { action: 'submit', requestKey: randomUUID(),
        expectedVersion: 0, note: 'Original old financial review request', reviewId: reviewed.id, userId: f.actors.finance.id }));
      const finishingCommand = { action: kind === 'finance_handoff' ? 'verify' : 'return', requestKey: randomUUID(),
        expectedVersion: submitted.billingItem.developmentWorkflowVersion, note: kind === 'finance_handoff' ? 'Original fees verified' : 'Original business invoice details still required',
        ...(kind === 'billing_supplement' ? { requiredItems: ['Confirm customer-facing original invoice text'] } : {}) };
      const finished = status(await http('finance', 'post', `${a.path}/billing-drafts/${a.billingId}/workflow`, finishingCommand));
      const tasks = await prisma.workAssignment.findMany({ where: { status: 'assigned', AND: [{ metadata: { path: ['billingItemId'], equals: a.billingId } }, { metadata: { path: ['kind'], equals: kind } }] } });
      expect(tasks).toHaveLength(1);
      const approvals = await prisma.approvalRequest.findMany({ where: { targetType: 'BillingItem', targetId: a.billingId }, orderBy: { id: 'asc' } });
      const source = status(await http('salesOwner', 'get', `${a.path}/ci-source/${a.billingId}`));
      const saved = status(await http('salesOwner', 'post', `${a.path}/ci-commands`, { ...a.save, requestKey: randomUUID(), documentId: a.saved.receipt.documentId,
        expectedVersion: 1, expectedSourceFingerprint: source.sourceFingerprint }));
      expect((await prisma.workAssignment.findUniqueOrThrow({ where: { id: tasks[0].id } })).status).toBe('assigned');
      const issued = status(await http('salesOwner', 'post', `${a.path}/ci-commands`, { action: 'issue', requestKey: randomUUID(), billingItemId: a.billingId,
        documentId: saved.receipt.documentId, expectedVersion: 2, expectedSourceFingerprint: source.sourceFingerprint }));
      const retired = await prisma.workAssignment.findUniqueOrThrow({ where: { id: tasks[0].id } });
      expect(retired.status).toBe('cancelled'); expect(retired.completedAt).toBeNull();
      expect((retired.metadata as any).result).toMatchObject({ outcome: 'superseded_by_business_ci', documentId: issued.receipt.documentId, versionId: issued.receipt.versionId });
      expect(await prisma.auditLog.count({ where: { action: 'supersede_development_finance_task_by_ci', targetId: retired.id } })).toBe(1);
      expect(await prisma.approvalRequest.findMany({ where: { targetType: 'BillingItem', targetId: a.billingId }, orderBy: { id: 'asc' } })).toEqual(approvals);
      const oldReplay = status(await http('finance', 'post', `${a.path}/billing-drafts/${a.billingId}/workflow`, finishingCommand));
      expect(oldReplay.recovered).toBe(true); expect(oldReplay.event.id).toBe(finished.event.id);
      if (kind === 'finance_handoff') expect(oldReplay.assignment.status).toBe('cancelled');
    }
  }, 120_000);
});
