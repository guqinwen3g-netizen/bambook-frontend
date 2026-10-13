import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { developmentCiCommercialStorage } from './developmentCiCommercialStorage';

// Policy and independent side effects are seams; createInvoice and every CI/Billing producer stay real.
vi.mock('../../auth/tokenHelpers', () => ({ loadUserWithRoles: async (tx: any, id: string) => tx.auth.active ? { id, status: 'active' } : null,
  buildLoadedAuthTokenPayload: async (tx: any, user: any) => ({ userId: user.id, roles: [], permissions: tx.auth.scopes, permissionCeiling: undefined, authorizationLoaded: true }) }));
vi.mock('../../auth/permissionService', () => ({ hasScope: (actor: any, scope: string) => actor.permissions.includes(scope) && (actor.permissionCeiling === undefined || actor.permissionCeiling.includes(scope)),
  createPermissionService: ({ prisma }: any) => ({ getDataScopeResolver: async () => ({ rule: { kind: 'all' } }),
    getUserPermissionContext: async (id: string) => prisma.auth.active ? { userId: id, scopes: prisma.auth.scopes, legacyRoleCodes: [], roleIds: [], departmentIds: [] } : null }) }));
vi.mock('../../entities/sync', () => ({ syncInvoiceReferences: vi.fn(async () => undefined) }));
vi.mock('../../credit/creditService', () => ({ notifyCustomerCreditRecalc: vi.fn(async () => undefined) }));
vi.mock('../../events/businessEventBus', () => ({ publishBusinessEvent: vi.fn(async () => undefined) }));
vi.mock('../../finance/shipmentBatchSettlementHook', () => ({ notifyShipmentBatchSettlementRecalc: vi.fn(async () => undefined) }));
vi.mock('../../templates/docTemplates/financeInvoice', () => ({ currentExporterProfileSnapshot: async () => ({ nameEn: 'Seller Ltd', addressEn: 'Seller address' }) }));
vi.mock('../../shared/businessNumberService', () => ({ nextBusinessNumber: async (tx: any, kind: string) => `${kind}-TEST-${tx.state.billingItem.length + 1}` }));
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { commandDevelopmentCommercialBilling, listDevelopmentCommercialBillings, readDevelopmentCommercialOptions, normalizeDevelopmentCommercialCommand } from '../developmentCommercialBillingService';
import { commandDevelopmentCiV2, previewDevelopmentCiV2Source } from '../developmentBusinessCiV2Service';
import { commandDevelopmentCi, previewDevelopmentCiSource } from '../developmentBusinessCiService';
import { previewDevelopmentSupplementalBilling } from '../developmentBillingDraftService';
import { confirmDevelopmentExpenseReview, previewDevelopmentExpenseReview } from '../developmentClosureService';
import { ciHash, developmentCiRef, developmentCiSnapshot } from '../developmentCiSource';
import { developmentCiInvoiceLines } from '../../finance/developmentCiArMembers';
import { registerDevelopmentCiReceivable } from '../../finance/developmentCiReceivableService';
import { createInvoice, updateInvoice } from '../../finance/invoiceMutationService';
import { invoiceBillingItem } from '../../finance/billingItemService';
import { renderDevelopmentCiDocument } from '../developmentCiDocument';

const sales: any = { userId: 'sales', permissionCeiling: ['products:read', 'products:write'] };
const finance: any = { userId: 'finance', permissionCeiling: ['invoices:read', 'invoices:write'] };
const fields = { issueDate: '2026-10-12', dueDate: null, paymentTerms: 'TT', note: 'Customer agreed development services',
  billTo: { name: 'Buyer Ltd', address: 'Buyer address' }, exporter: { nameEn: 'Seller Ltd', addressEn: 'Seller address' } };
const line = (id: string, order: number, amount: string, round = 1) => ({ id, displayOrder: order, purpose: round === 1 ? 'Initial sample' : 'Revision sample',
  description: `Customer agreed service ${id}`, sourceType: 'DevelopmentSampleRound', sourceId: `round-${round}`, amount, currency: 'USD' });
function unrelatedProblemCosts(f: ReturnType<typeof developmentCiCommercialStorage>) {
  f.state.sample.push({ id: 'historical-production', sourceCaseId: 'case', type: 'production', sourceOrderId: null, updatedAt: 1n, deletedAt: null });
  f.state.costRecord.push(...[
    { id: 'unsupported', sourceType: 'DevelopmentCase', sourceId: 'case', amount: '3', currency: 'EUR' },
    { id: 'unresolved', sourceType: 'Sample', sourceId: 'historical-production', amount: '4', currency: 'CNY' },
    { id: 'invalid-amount', sourceType: 'DevelopmentCase', sourceId: 'case', amount: 'unknown', currency: 'USD' },
  ].map(row => ({ ...row, costType: 'sample_making', incurredAt: '2026-10-12', bearerType: 'internal', updatedAt: 1n, deletedAt: null })));
}
async function currentReview(f: ReturnType<typeof developmentCiCommercialStorage>) {
  f.state.developmentLifecycleEvent.push({ id: 'closed', developmentCaseId: 'case', state: 'closed', revision: 1 });
  const context = { prisma: f.prisma, actorId: 'sales', authorize: async () => undefined };
  const preview = await previewDevelopmentExpenseReview(context, 'case');
  return confirmDevelopmentExpenseReview(context, 'case', { expectedFingerprint: preview.fingerprint, requestKey: 'review', note: 'Actual complete review' });
}
function legacyBilling(id = 'legacy', amount = '60') {
  return { id, itemNo: id, sourceType: 'DevelopmentCase', sourceId: 'case', chargeType: 'development_fee', amount,
    waivedAmount: '0', offsetAmount: '0', currency: 'USD', bearerType: 'customer', bearerRelationId: 'customer', bearerName: 'Buyer Ltd',
    status: 'confirmed', developmentWorkflowState: null, developmentWorkflowVersion: 0, updatedAt: 1n, invoiceId: null,
    developmentExpenseReviewId: null, costRecordId: null, deletedAt: null };
}
const legacyManual = (amount = '100') => ({ invoiceNumber: 'LEGACY-MANUAL', type: 'Receivable', status: 'Draft', amount,
  currency: 'USD', customerRelationId: 'customer', customerName: 'Buyer Ltd', sourceType: 'Manual', sourceId: 'manual-explicit',
  invoiceLines: [{ sourceType: 'BillingItem', sourceId: 'legacy1', amount: '60', currency: 'USD', description: 'First' },
    { sourceType: 'BillingItem', sourceId: 'legacy2', amount: '40', currency: 'USD', description: 'Second' }] });
async function ready() {
  const f = developmentCiCommercialStorage(), context = { prisma: f.prisma, actor: sales };
  for (const [id, amount, round] of [['b1', '60', 1], ['b2', '40', 2]] as const) {
    f.state.billingItem.push({ id, itemNo: id.toUpperCase(), sourceType: 'DevelopmentCase', sourceId: 'case', chargeType: 'development_fee', amount,
      waivedAmount: '0', offsetAmount: '0', currency: 'USD', bearerType: 'customer', bearerRelationId: 'customer', status: 'draft',
      developmentWorkflowState: 'business_ci_draft', developmentWorkflowVersion: 0, updatedAt: 1n, invoiceId: null, deletedAt: null });
    f.state.costRecord.push({ id: `c${round}`, recordNo: `CR-${round}`, sourceType: 'DevelopmentCase', sourceId: 'case', costType: 'sample_making',
      amount: round === 1 ? '10' : '7', currency: 'CNY', incurredAt: '2026-10-12', bearerType: 'internal', updatedAt: 1n, evidence: [], deletedAt: null });
    await commandDevelopmentCommercialBilling(context, 'case', id, { action: 'save', requestKey: `commercial-${id}`, expectedVersion: 0,
      chargeLines: id === 'b1' ? [line('l1', 0, '25'), line('l2', 1, '35')] : [line('l3', 0, '40', 2)], costRecordIds: [`c${round}`] });
  }
  return { ...f, context };
}
async function saved() {
  const f = await ready(), source = await previewDevelopmentCiV2Source(f.context, 'case', ['b2', 'b1']);
  const command: any = { action: 'save', billingItemIds: ['b2', 'b1'], requestKey: 'save', expectedVersion: 0, expectedSourceFingerprint: source.sourceFingerprint, fields };
  const result = await commandDevelopmentCiV2(f.context, 'case', command);
  return { ...f, command, result };
}
async function issued() {
  const f = await saved();
  const result = await commandDevelopmentCiV2(f.context, 'case', { action: 'issue', billingItemIds: ['b1', 'b2'], requestKey: 'issue', documentId: f.result.receipt.documentId,
    expectedVersion: 1, expectedSourceFingerprint: f.command.expectedSourceFingerprint });
  return { ...f, result };
}
beforeEach(() => vi.clearAllMocks());

describe('Explicit commercial multi-member CI through actual invoice producer', () => {
  it('recovers the exact successful legacy DevelopmentCase BI invoice without consuming its own line twice', async () => {
    const f = developmentCiCommercialStorage(); f.state.billingItem.push(legacyBilling());
    const first = await invoiceBillingItem({ prisma: f.prisma, id: 'legacy', actorId: 'finance', trustedActor: finance });
    expect(first.ok).toBe(true);
    const again = await invoiceBillingItem({ prisma: f.prisma, id: 'legacy', actorId: 'finance', trustedActor: finance });
    expect(again).toMatchObject({ ok: true, data: { recovered: true, invoice: { id: first.data!.invoice.id } } });
    expect(f.state.invoice).toHaveLength(1); expect(f.state.invoiceLine).toHaveLength(1);
    // Recover the original-source seam when an old writer missed its BI backfill.
    f.state.billingItem[0].status = 'confirmed'; f.state.billingItem[0].invoiceId = null;
    expect(await invoiceBillingItem({ prisma: f.prisma, id: 'legacy', actorId: 'finance', trustedActor: finance }))
      .toMatchObject({ ok: true, data: { recovered: true, invoice: { id: first.data!.invoice.id } } });
    expect(f.state.invoice).toHaveLength(1); expect(f.state.invoiceLine).toHaveLength(1);
  });
  it('rejects a damaged or foreign legacy invoice instead of relaxing cross-invoice occupancy on recovery', async () => {
    for (const damage of ['header', 'line', 'source', 'foreign-line']) {
      const f = developmentCiCommercialStorage(); f.state.billingItem.push(legacyBilling());
      expect((await invoiceBillingItem({ prisma: f.prisma, id: 'legacy', actorId: 'finance', trustedActor: finance })).ok).toBe(true);
      if (damage === 'header') f.state.invoice[0].amount = '1';
      if (damage === 'line') f.state.invoiceLine[0].amount = '1';
      if (damage === 'source') f.state.invoice[0].sourceId = 'foreign-billing';
      if (damage === 'foreign-line') f.state.invoiceLine[0].invoiceId = 'foreign-invoice';
      const result = await invoiceBillingItem({ prisma: f.prisma, id: 'legacy', actorId: 'finance', trustedActor: finance });
      expect(result.ok).toBe(false); expect(f.state.invoice).toHaveLength(1); expect(f.state.invoiceLine).toHaveLength(1);
    }
  });
  it('reloads actual permission after locking the legacy original invoice during recovery', async () => {
    const f = developmentCiCommercialStorage(); f.state.billingItem.push(legacyBilling());
    expect((await invoiceBillingItem({ prisma: f.prisma, id: 'legacy', actorId: 'finance', trustedActor: finance })).ok).toBe(true);
    const raw = f.tx.$queryRaw.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementation(async (query: any) => {
      const result = await raw(query);
      if (query.strings.join('').includes('FROM "Invoice"')) f.tx.auth.scopes = [];
      return result;
    });
    expect(await invoiceBillingItem({ prisma: f.prisma, id: 'legacy', actorId: 'finance', trustedActor: finance }))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(f.state.invoice).toHaveLength(1); expect(f.state.invoiceLine).toHaveLength(1);
  });
  it('rejects exact legacy BI manual lines whose total exceeds the invoice header before any financial write', async () => {
    const f = developmentCiCommercialStorage(); f.state.billingItem.push(legacyBilling('legacy1'), legacyBilling('legacy2', '40'));
    const result = await createInvoice({ prisma: f.prisma, actor: finance, actorId: 'finance', input: legacyManual('60') });
    expect(result).toMatchObject({ ok: false, error: { code: 'HANDOFF_CONFLICT' } });
    expect(f.state.invoice).toEqual([]); expect(f.state.invoiceLine).toEqual([]);
  });
  it('keeps legacy BI and manual BillingItem-line financial totals during generic invoice updates', async () => {
    for (const manual of [false, true]) {
      const f = developmentCiCommercialStorage();
      f.state.billingItem.push(...(manual ? [legacyBilling('legacy1'), legacyBilling('legacy2', '40')] : [legacyBilling()]));
      const created = manual ? await createInvoice({ prisma: f.prisma, actor: finance, actorId: 'finance', input: legacyManual() })
        : await invoiceBillingItem({ prisma: f.prisma, id: 'legacy', actorId: 'finance', trustedActor: finance });
      expect(created.ok).toBe(true);
      const invoiceId = created.data!.invoice.id, total = String(f.state.invoice[0].amount);
      const result = await updateInvoice({ prisma: f.prisma, invoiceId, actor: finance, actorId: 'finance', input: { amount: '1' } });
      expect(result).toMatchObject({ ok: false, error: { code: 'HANDOFF_CONFLICT' } });
      expect(String(f.state.invoice[0].amount)).toBe(total);
      expect(f.state.invoiceLine.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)).eq(total)).toBe(true);
      expect((await updateInvoice({ prisma: f.prisma, invoiceId, actor: finance, actorId: 'finance', input: { notes: 'Legitimate legacy note' } })).ok).toBe(true);
      expect((await updateInvoice({ prisma: f.prisma, invoiceId, actor: finance, actorId: 'finance',
        input: { amount: total, currency: 'USD', customerRelationId: 'customer', status: 'Issued' } })).ok).toBe(true);
      for (const input of [{ currency: 'CNY' }, { customerRelationId: 'foreign-customer' }, { type: 'Payable' }])
        expect(await updateInvoice({ prisma: f.prisma, invoiceId, actor: finance, actorId: 'finance', input }))
          .toMatchObject({ ok: false, error: { code: 'HANDOFF_CONFLICT' } });
      expect(String(f.state.invoice[0].amount)).toBe(total); expect(f.state.invoice[0].status).toBe('Issued');
    }
  });
  it('creates several commercial billing drafts before a first invoice without deriving price from costs', async () => {
    const f = developmentCiCommercialStorage(), context = { prisma: f.prisma, actor: sales };
    for (const index of [1, 2]) {
      const input = { requestKey: `new-${index}`, amount: '30.0001', currency: 'USD', note: 'Actual customer agreement',
        chargeLines: [line(`new-line-${index}`, 0, '30.0001', index)], costRecordIds: [] };
      const created = await commandDevelopmentCommercialBilling(context, 'case', null, input);
      expect(created.chargeLines[0]).toMatchObject({ amount: '30.0001', roundLabel: `R${index}` });
      expect(await commandDevelopmentCommercialBilling(context, 'case', null, input)).toMatchObject({ replayed: true, receipt: created.receipt });
    }
    expect(f.state.billingItem).toHaveLength(2); expect(f.state.costRecord).toHaveLength(0);
  });
  it('allows explicit empty cost selections despite unrelated unsupported/unresolved costs, through issue and the real AR producer', async () => {
    const f = developmentCiCommercialStorage(), context = { prisma: f.prisma, actor: sales };
    f.state.developmentCase[0].stage = 'Active'; unrelatedProblemCosts(f);
    const members: string[] = [];
    for (const index of [1, 2]) {
      const result = await commandDevelopmentCommercialBilling(context, 'case', null, { requestKey: `independent-${index}`, amount: '30', currency: 'USD',
        note: 'Explicit customer agreement', chargeLines: [line(`independent-line-${index}`, 0, '30', index)], costRecordIds: [] });
      members.push(result.billingItem.id);
    }
    const options = await readDevelopmentCommercialOptions(context, 'case');
    expect(options.costs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'unsupported', currency: 'EUR', selectable: false, unavailableReason: expect.any(String) }),
      expect.objectContaining({ id: 'unresolved', selectable: false, unavailableReason: expect.any(String) }),
      expect.objectContaining({ id: 'invalid-amount', selectable: false, unavailableReason: expect.any(String) }),
    ]));
    const source = await previewDevelopmentCiV2Source(context, 'case', members);
    expect(source.costs).toEqual([]); expect(source.costTotals).toEqual([]);
    const draft = await commandDevelopmentCiV2(context, 'case', { action: 'save', requestKey: 'independent-save', billingItemIds: members,
      expectedVersion: 0, expectedSourceFingerprint: source.sourceFingerprint, fields });
    const original = await commandDevelopmentCiV2(context, 'case', { action: 'issue', requestKey: 'independent-issue', billingItemIds: members,
      documentId: draft.receipt.documentId, expectedVersion: 1, expectedSourceFingerprint: source.sourceFingerprint });
    const ar = await registerDevelopmentCiReceivable(f.prisma, finance, original.receipt.documentId, { requestKey: 'independent-ar', expectedVersionId: original.receipt.versionId });
    expect(String(ar.invoice.amount)).toBe('60'); expect(f.state.invoiceLine).toHaveLength(2);
    // The existing v1/supplemental full-case expense protocol still rejects this case.
    f.state.costRecord = f.state.costRecord.filter(row => row.id !== 'invalid-amount');
    await expect(previewDevelopmentSupplementalBilling(context, 'case')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rejects explicitly selected unsupported/unresolved costs and rolls back all commercial writes', async () => {
    for (const costId of ['unsupported', 'unresolved', 'invalid-amount']) {
      const f = developmentCiCommercialStorage(), context = { prisma: f.prisma, actor: sales }; unrelatedProblemCosts(f);
      await expect(commandDevelopmentCommercialBilling(context, 'case', null, { requestKey: `problem-${costId}`, amount: '30', currency: 'USD',
        note: 'Explicit customer agreement', chargeLines: [line('problem-line', 0, '30')], costRecordIds: [costId] })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(f.state.billingItem).toEqual([]); expect(f.state.developmentBillingChargeLine).toEqual([]); expect(f.state.billingItemCostCoverage).toEqual([]);
    }
  });
  it('rechecks a selected cost that becomes unsupported before issue, while preserving the original draft', async () => {
    const f = await saved(); f.state.costRecord[0].currency = 'EUR';
    await expect(commandDevelopmentCiV2(f.context, 'case', { action: 'issue', requestKey: 'selected-stale', billingItemIds: ['b1', 'b2'],
      documentId: f.result.receipt.documentId, expectedVersion: 1, expectedSourceFingerprint: f.command.expectedSourceFingerprint })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.state.tradeDocument[0].status).toBe('Draft'); expect(f.state.documentVersion).toHaveLength(1);
  });
  it('keeps an original expense-review scope and current review mandatory for v2 consumption', async () => {
    const f = await ready(), billing = f.state.billingItem[0], review = await currentReview(f);
    // This original review covers both case costs, unlike the business's independent selected scope.
    billing.developmentExpenseReviewId = review.id;
    await expect(commandDevelopmentCommercialBilling(f.context, 'case', 'b1', { action: 'save', requestKey: 'drop-original-scope', expectedVersion: 1,
      chargeLines: [line('whole-original', 0, '60')], costRecordIds: [] })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(previewDevelopmentCiV2Source(f.context, 'case', ['b1'])).rejects.toMatchObject({ code: 'COVERAGE_CONFLICT' });
    unrelatedProblemCosts(f); f.state.costRecord = f.state.costRecord.filter(row => row.id !== 'invalid-amount');
    await expect(previewDevelopmentCiV2Source(f.context, 'case', ['b1'])).rejects.toMatchObject({ code: 'REVIEW_STALE' });
    await expect(previewDevelopmentCiSource(f.context, 'case', 'b1')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.state.tradeDocument).toEqual([]);
  });
  it('does not bypass an existing whole-case expense review at the real v2 issue producer', async () => {
    const f = developmentCiCommercialStorage(), context = { prisma: f.prisma, actor: sales };
    const created = await commandDevelopmentCommercialBilling(context, 'case', null, { requestKey: 'review-backed', amount: '30', currency: 'USD',
      note: 'Actual agreement with existing review', chargeLines: [line('review-line', 0, '30')], costRecordIds: [] });
    const review = await currentReview(f); f.state.billingItem[0].developmentExpenseReviewId = review.id;
    const members = [created.billingItem.id], source = await previewDevelopmentCiV2Source(context, 'case', members);
    const draft = await commandDevelopmentCiV2(context, 'case', { action: 'save', requestKey: 'review-save', billingItemIds: members,
      expectedVersion: 0, expectedSourceFingerprint: source.sourceFingerprint, fields });
    unrelatedProblemCosts(f); f.state.costRecord = f.state.costRecord.filter(row => row.id !== 'invalid-amount');
    await expect(commandDevelopmentCiV2(context, 'case', { action: 'issue', requestKey: 'review-stale-issue', billingItemIds: members,
      documentId: draft.receipt.documentId, expectedVersion: 1, expectedSourceFingerprint: source.sourceFingerprint })).rejects.toMatchObject({ code: 'REVIEW_STALE' });
    expect(f.state.tradeDocument[0].status).toBe('Draft'); expect(f.state.documentVersion).toHaveLength(1);
  });
  it('preserves R1/R2 commercial lines, signs with business permission, and registers one AR with one aggregated line per BI', async () => {
    const f = await issued(), snapshot = f.result.document.snapshot;
    expect(snapshot.protocolVersion).toBe(2); expect(snapshot.chargeLines.map((row: any) => row.roundLabel)).toEqual(['R1', 'R1', 'R2']);
    expect(snapshot.totalAmount).toBe('100.0000'); expect(snapshot.costTotals).toEqual([{ currency: 'CNY', amount: '17.0000' }]);
    expect(renderDevelopmentCiDocument(f.result.document)).toContain('Round / Reference');
    const result = await registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, { requestKey: 'ar', expectedVersionId: f.result.receipt.versionId });
    expect(result.invoice.amount).toBe('100');
    expect(f.state.invoiceLine.map(row => ({ sourceId: row.sourceId, amount: String(row.amount) }))).toEqual([{ sourceId: 'b1', amount: '60' }, { sourceId: 'b2', amount: '40' }]);
    expect(f.state.billingItem.every(row => row.invoiceId === result.invoice.id && row.status === 'invoiced')).toBe(true);
    f.state.invoice[0].status = 'PartiallyPaid';
    expect(await registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, { requestKey: 'another-key', expectedVersionId: f.result.receipt.versionId })).toMatchObject({ replayed: true, receipt: result.receipt });
    expect(f.state.invoice).toHaveLength(1);
  });
  it('rejects missing/extra/damaged original AR member lines and damaged BI backfill on replay', async () => {
    for (const damage of ['amount', 'extra', 'missing', 'backfill', 'billingMoney']) {
      const f = await issued(); await registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, { requestKey: 'ar', expectedVersionId: f.result.receipt.versionId });
      if (damage === 'amount') f.state.invoiceLine[0].amount = '61';
      if (damage === 'extra') f.state.invoiceLine.push({ ...f.state.invoiceLine[0], id: 'extra', sourceId: 'foreign' });
      if (damage === 'missing') f.state.invoiceLine.pop();
      if (damage === 'backfill') f.state.billingItem[1].invoiceId = 'foreign';
      if (damage === 'billingMoney') f.state.billingItem[1].amount = '41';
      await expect(registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, { requestKey: 'retry', expectedVersionId: f.result.receipt.versionId })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(f.state.invoice).toHaveLength(1);
    }
  });
  it.each([
    ['Prisma transaction conflict', { code: 'P2034' }],
    ['raw PostgreSQL serialization failure', { code: 'P2010', meta: { code: '40001' } }],
  ])('returns a business conflict for %s and recovers only on a fresh original AR request', async (_label, failure) => {
    const f = await issued(), rawQuery = f.tx.$queryRaw.getMockImplementation()!;
    const command = { requestKey: 'ar-original-nonce', expectedVersionId: f.result.receipt.versionId };
    const databaseError = Object.assign(new Error('Fixture database concurrency failure'), failure);
    f.tx.$transaction.mockClear();
    f.tx.$queryRaw.mockImplementation(async (query: any) => {
      if (query.strings.join('?').includes('FROM "BillingItem"')) throw databaseError;
      return rawQuery(query);
    });
    await expect(registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, command))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('保留原请求') });
    expect(f.tx.$transaction).toHaveBeenCalledTimes(1);
    expect(f.state.invoice).toHaveLength(0); expect(f.state.invoiceLine).toHaveLength(0);
    expect(f.state.auditLog.filter(row => row.action === 'register_development_ci_receivable')).toHaveLength(0);
    // A new call retains its original nonce. The failed call neither retries nor
    // fabricates a successful acknowledgement from the aborted transaction.
    f.tx.$queryRaw.mockImplementation(rawQuery);
    const created = await registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, command);
    expect(created.replayed).toBe(false); expect(created.receipt.requestKey).toBe(command.requestKey);
    expect(await registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, command))
      .toMatchObject({ replayed: true, receipt: created.receipt });
    expect(f.state.invoice).toHaveLength(1);
    expect(f.state.invoiceLine.map(row => ({ sourceId: row.sourceId, amount: String(row.amount) })))
      .toEqual([{ sourceId: 'b1', amount: '60' }, { sourceId: 'b2', amount: '40' }]);
    expect(f.state.billingItem.every(row => row.invoiceId === created.invoice.id && row.status === 'invoiced')).toBe(true);
  });
  it.each([
    ['raw PostgreSQL check violation', { code: 'P2010', meta: { code: '23514' } }],
    ['raw PostgreSQL missing column', { code: 'P2010', meta: { code: '42703' } }],
    ['unrelated unique constraint', { code: 'P2002' }],
  ])('preserves %s without retrying or reporting a successful AR', async (_label, failure) => {
    const f = await issued(), rawQuery = f.tx.$queryRaw.getMockImplementation()!;
    const databaseError = Object.assign(new Error('Fixture non-serialization database failure'), failure);
    f.tx.$transaction.mockClear();
    f.tx.$queryRaw.mockImplementation(async (query: any) => {
      if (query.strings.join('?').includes('FROM "BillingItem"')) throw databaseError;
      return rawQuery(query);
    });
    await expect(registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId,
      { requestKey: 'ar-original-nonce', expectedVersionId: f.result.receipt.versionId })).rejects.toBe(databaseError);
    expect(f.tx.$transaction).toHaveBeenCalledTimes(1);
    expect(f.state.invoice).toHaveLength(0); expect(f.state.invoiceLine).toHaveLength(0);
  });
  it('reserves draft members, rejects overlapping drafts, and releases only on an explicit cancellation', async () => {
    const f = await saved();
    await expect(previewDevelopmentCiV2Source(f.context, 'case', ['b1'])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.state.developmentCiBillingClaim.filter(row => row.releasedAt == null)).toHaveLength(2);
    const cancelled = await commandDevelopmentCiV2(f.context, 'case', { action: 'cancel', billingItemIds: ['b1', 'b2'], requestKey: 'cancel', documentId: f.result.receipt.documentId,
      expectedVersion: 1, expectedSourceFingerprint: f.command.expectedSourceFingerprint });
    expect(cancelled.document.document.status).toBe('Cancelled'); expect(f.state.developmentCiBillingClaim.every(row => row.releasedAt != null)).toBe(true);
    expect(await commandDevelopmentCiV2(f.context, 'case', f.command)).toMatchObject({ replayed: true, receipt: f.result.receipt });
    expect((await previewDevelopmentCiV2Source(f.context, 'case', ['b1'])).totalAmount).toBe('60.0000');
  });
  it('changes draft members atomically, keeps commercial edits stale for issue, and never releases issued members', async () => {
    const f = await saved();
    const source = await previewDevelopmentCiV2Source(f.context, 'case', ['b1'], f.result.receipt.documentId);
    const changed = await commandDevelopmentCiV2(f.context, 'case', { action: 'save', billingItemIds: ['b1'], requestKey: 'members', documentId: f.result.receipt.documentId,
      expectedVersion: 1, expectedSourceFingerprint: source.sourceFingerprint, fields });
    expect(f.state.developmentCiBillingClaim.filter(row => row.releasedAt == null).map(row => row.billingItemId)).toEqual(['b1']);
    await commandDevelopmentCommercialBilling(f.context, 'case', 'b1', { action: 'save', requestKey: 'details', expectedVersion: 1,
      chargeLines: [line('l1', 0, '25'), { ...line('l2', 1, '35'), purpose: 'Explicit revised purpose' }], costRecordIds: ['c1'] });
    await expect(commandDevelopmentCiV2(f.context, 'case', { action: 'issue', billingItemIds: ['b1'], requestKey: 'stale', documentId: changed.receipt.documentId,
      expectedVersion: 2, expectedSourceFingerprint: source.sourceFingerprint })).rejects.toMatchObject({ code: 'CONFLICT' });
    const g = await issued(); await expect(commandDevelopmentCiV2(g.context, 'case', { action: 'cancel', billingItemIds: ['b1', 'b2'], requestKey: 'cancel-issued', documentId: g.result.receipt.documentId,
      expectedVersion: 2, expectedSourceFingerprint: g.command.expectedSourceFingerprint })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(g.state.developmentCiBillingClaim.every(row => row.releasedAt == null)).toBe(true);
  });
  it('rejects foreign cases/customers, different currencies, unknown rounds, and guessing an old BI commercial price', async () => {
    for (const [field, value] of [['sourceId', 'foreign-case'], ['bearerRelationId', 'foreign-customer'], ['currency', 'CNY']]) {
      const f = await ready(); f.state.billingItem[1][field] = value;
      await expect(previewDevelopmentCiV2Source(f.context, 'case', ['b1', 'b2'])).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    const f = await ready(); f.state.developmentBillingChargeLine = f.state.developmentBillingChargeLine.filter(row => row.billingItemId !== 'b1');
    await expect(previewDevelopmentCiV2Source(f.context, 'case', ['b1'])).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(commandDevelopmentCommercialBilling(f.context, 'case', 'b1', { action: 'save', expectedVersion: 1, requestKey: 'bad-source', chargeLines: [{ ...line('old', 0, '60'), sourceId: 'unknown' }], costRecordIds: [] })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('blocks approval_pending and stale monetary approvals, without introducing a new approval for description-only saves', async () => {
    const f = await ready(); f.state.billingItem[0].developmentWorkflowState = 'approval_pending';
    await expect(previewDevelopmentCiV2Source(f.context, 'case', ['b1'])).rejects.toMatchObject({ code: 'CONFLICT' });
    f.state.billingItem[0].developmentWorkflowState = 'business_ci_draft'; f.state.billingItem[0].waivedAmount = '1';
    await expect(previewDevelopmentCiV2Source(f.context, 'case', ['b1'])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.state.approvalRequest).toEqual([]);
  });
  it('makes native generic invoice lines and top-level BI obey draft claims before any invoice write', async () => {
    for (const top of [false, true]) {
      const f = await saved();
      const result = await createInvoice({ prisma: f.prisma, actor: finance, actorId: 'finance', input: {
        invoiceNumber: 'MANUAL', type: 'Receivable', status: 'Draft', amount: '60', currency: 'USD', issueDate: '2026-10-12',
        ...(top ? { sourceType: 'BillingItem', sourceId: 'b1' } : {}), invoiceLines: [{ sourceType: 'BillingItem', sourceId: 'b1', amount: '60', currency: 'USD' }],
      } });
      expect(result.ok).toBe(false); expect(f.state.invoice).toEqual([]); expect(f.state.invoiceLine).toEqual([]);
    }
    const f = await saved();
    f.state.billingItem[0].status = 'confirmed'; f.tx.developmentCiBillingClaim.findMany.mockClear();
    const billed = await invoiceBillingItem({ prisma: f.prisma, id: 'b1', actorId: 'finance', trustedActor: finance });
    expect(billed.ok).toBe(false); expect(f.state.invoice).toEqual([]);
    expect(f.tx.developmentCiBillingClaim.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { billingItemId: { in: ['b1'] }, releasedAt: null } }));
  });
  it('rejects unconfirmed development BI members on a manual invoice before business has signed a CI', async () => {
    const f = await ready();
    const result = await createInvoice({ prisma: f.prisma, actor: finance, actorId: 'finance', input: { invoiceNumber: 'UNCONFIRMED', type: 'Receivable', status: 'Draft', amount: '60',
      currency: 'USD', issueDate: fields.issueDate, customerRelationId: 'customer', invoiceLines: [{ sourceType: 'BillingItem', sourceId: 'b1', amount: '60', currency: 'USD' }] } });
    expect(result.ok).toBe(false); expect(f.state.invoice).toEqual([]); expect(f.state.invoiceLine).toEqual([]);
  });
  it('rejects mismatched allocation lines at the real native invoice producer before financial writes', async () => {
    const f = await issued(), source = f.result.document;
    const input = { invoiceNumber: source.document.documentNumber, type: 'Receivable', status: 'Issued', amount: source.snapshot.totalAmount,
      currency: source.snapshot.currency, issueDate: source.snapshot.issueDate, dueDate: source.snapshot.dueDate,
      customerRelationId: 'customer', customerName: source.snapshot.parties.billTo.name, sourceType: 'BusinessDevelopmentCI', sourceId: source.version.id,
      invoiceLines: developmentCiInvoiceLines(source.snapshot).filter((row: any) => row.sourceId !== 'b2') };
    const result = await f.prisma.$transaction((tx: any) => createInvoice({ prisma: f.prisma, actor: finance, actorId: 'finance', input,
      transaction: { tx, deferAfterCommit: () => undefined }, developmentCiRegistration: { documentId: source.document.id, versionId: source.version.id,
        snapshotFingerprint: source.snapshot.snapshotFingerprint } }));
    expect(result.ok).toBe(false); expect(f.state.invoice).toEqual([]); expect(f.state.invoiceLine).toEqual([]);
  });
  it('keeps approval-dependent new fees in the original workflow and confirms purposes without a new approval', async () => {
    const f = developmentCiCommercialStorage(), context = { prisma: f.prisma, actor: sales };
    const created = await commandDevelopmentCommercialBilling(context, 'case', null, { requestKey: 'discount', amount: '70', waivedAmount: '10', currency: 'USD',
      note: 'Actual discounted agreement', chargeLines: [line('discount-line', 0, '60')], costRecordIds: [] });
    expect(created.billingItem.developmentWorkflowState).toBe('draft');
    const review = await currentReview(f);
    const billing = f.state.billingItem[0], proposal = { caseId: 'case', bearerType: 'customer', bearerRelationId: 'customer', currency: 'USD',
      expenseReviewId: review.id, amount: '70', waivedAmount: '10' };
    billing.developmentExpenseReviewId = review.id; billing.developmentApprovalId = 'approval'; billing.status = 'confirmed'; billing.developmentWorkflowState = 'ready';
    const decidedAt = new Date('2026-10-12T00:00:00Z'), payload = { ...proposal, contentFingerprint: ciHash(proposal) };
    f.state.approvalRequest.push({ id: 'approval', status: 'approved', targetType: 'BillingItem', targetId: billing.id, actionType: 'development:fee', reviewerId: 'leader', decidedAt, payload });
    f.state.auditLog.push({ id: 'approved', targetType: 'ApprovalRequest', targetId: 'approval', action: 'approve_business_request', actorId: 'leader',
      detail: { approvalDecisionFact: { schemaVersion: 1, status: 'approved', actionType: 'development:fee', targetType: 'BillingItem', targetId: billing.id,
        decisionActorId: 'leader', decidedAt: decidedAt.toISOString(), contentFingerprint: payload.contentFingerprint, modifiedInput: { amount: '70', waivedAmount: '10' } } } });
    await commandDevelopmentCommercialBilling(context, 'case', billing.id, { action: 'save', requestKey: 'approved-details', expectedVersion: 1,
      chargeLines: [{ ...line('discount-line', 0, '60'), purpose: 'Explicitly refined purpose' }], costRecordIds: [] });
    const source = await previewDevelopmentCiV2Source(context, 'case', [billing.id]);
    expect(source.totalAmount).toBe('60.0000'); expect(f.state.approvalRequest).toHaveLength(1);
    const draft = await commandDevelopmentCiV2(context, 'case', { action: 'save', requestKey: 'approved-save', billingItemIds: [billing.id],
      expectedVersion: 0, expectedSourceFingerprint: source.sourceFingerprint, fields });
    const issue = { action: 'issue' as const, requestKey: 'approved-issue', billingItemIds: [billing.id], documentId: draft.receipt.documentId,
      expectedVersion: 1, expectedSourceFingerprint: source.sourceFingerprint };
    f.state.billingItem[0].developmentWorkflowState = 'approval_pending';
    await expect(commandDevelopmentCiV2(context, 'case', issue)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('原审批') });
    f.state.billingItem[0].developmentWorkflowState = 'ready'; f.state.billingItem[0].amount = '71';
    await expect(commandDevelopmentCiV2(context, 'case', issue)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('原批准') });
    await expect(previewDevelopmentCiV2Source(context, 'case', [billing.id])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.state.approvalRequest).toHaveLength(1); expect(f.state.tradeDocument[0].status).toBe('Draft'); expect(f.state.documentVersion).toHaveLength(1);
  });
  it('normalizes commercial acknowledgements and exposes exact source/cost choices independently from customer price', async () => {
    const f = await ready();
    const input = { action: 'save', requestKey: ' normalized ', expectedVersion: 1, chargeLines: [line('l2', 1, '35'), line('l1', 0, '25')], costRecordIds: ['c1'] };
    const normalized = normalizeDevelopmentCommercialCommand('b1', input);
    expect(normalized).toMatchObject({ requestKey: 'normalized', amount: null, waivedAmount: null, currency: null, note: null });
    expect(normalized.chargeLines?.map(row => row.id)).toEqual(['l1', 'l2']);
    const saved = await commandDevelopmentCommercialBilling(f.context, 'case', 'b1', input);
    expect(saved.receipt.commandHash).toBe(ciHash(normalized));
    expect(await commandDevelopmentCommercialBilling(f.context, 'case', 'b1', { ...input, requestKey: 'normalized', chargeLines: [line('l1', 0, '25.0000'), line('l2', 1, '35.0000')] })).toMatchObject({ replayed: true, receipt: saved.receipt });
    const options = await readDevelopmentCommercialOptions(f.context, 'case', 'b1');
    expect(options.sources).toContainEqual({ sourceType: 'DevelopmentSampleRound', sourceId: 'round-1', sourceLabel: 'R1', roundId: 'round-1', roundNumber: 1, roundLabel: 'R1' });
    expect(options.costs.map((row: any) => [row.id, row.selectable, row.selected])).toEqual([['c1', true, true], ['c2', false, false]]);
    await expect(commandDevelopmentCommercialBilling(f.context, 'case', 'b1', { ...input, requestKey: 'financial', expectedVersion: 2, amount: '61' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('rolls back member changes when the active-claim unique seam rejects, and locks members and costs in order', async () => {
    const f = await ready(), source = await previewDevelopmentCiV2Source(f.context, 'case', ['b2', 'b1']);
    f.locks.length = 0;
    f.tx.developmentCiBillingClaim.create.mockRejectedValueOnce(Object.assign(Error('SQL active BI uniqueness seam'), { code: 'P2002' }));
    await expect(commandDevelopmentCiV2(f.context, 'case', { action: 'save', requestKey: 'unique', billingItemIds: ['b2', 'b1'], expectedVersion: 0,
      expectedSourceFingerprint: source.sourceFingerprint, fields })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.state.tradeDocument).toEqual([]); expect(f.state.documentVersion).toEqual([]); expect(f.state.developmentCiBillingClaim).toEqual([]);
    expect(f.state.auditLog.some(row => row.action === 'development_ci_command')).toBe(false);
    expect(f.locks.slice(0, 7).map(row => row.split(' :: ')[1])).toEqual(['case', 'b1', 'b2', 'c1', 'c2', 'b1', 'b2']);
  });
  it('keeps frozen v1 bytes/hash and old receipts, registers its original AR, and blocks v1 duplicate consumption', async () => {
    const f = await ready(), billing = f.state.billingItem[0]; billing.status = 'confirmed'; billing.developmentWorkflowState = 'business_ci_issued';
    const command = { action: 'issue', requestKey: 'v1-original', billingItemId: 'b1', expectedVersion: 1, expectedSourceFingerprint: 'a'.repeat(64), documentId: 'v1-doc', fields: null };
    const content: any = { protocolVersion: 1, sourceKind: 'development', caseId: 'case', caseCode: 'DEV-COMMERCIAL', billingItemId: 'b1', sourceFingerprint: command.expectedSourceFingerprint,
      customerRelationId: 'customer', currency: 'USD', totalAmount: '60.0000', issueDate: fields.issueDate, dueDate: null, paymentTerms: fields.paymentTerms,
      fields, parties: { billTo: { relationId: 'customer', ...fields.billTo } }, exporterSnapshot: fields.exporter,
      costs: [], costTotals: [], lines: [{ sourceType: 'BillingItem', sourceId: 'b1', amount: '60.0000', currency: 'USD', description: fields.note }], issuedAt: '1', issuedBy: 'sales' };
    const snapshot = { ...content, snapshotFingerprint: ciHash(content) }, document = { id: 'v1-doc', documentNumber: 'ORIGINAL-V1', type: 'CommercialInvoice', domain: 'finance', sourceInvoiceId: null,
      sourceRef: developmentCiRef('case', 'b1'), relationId: 'customer', status: 'Issued', currency: 'USD', totalAmount: new Prisma.Decimal(60), issueDate: fields.issueDate, deletedAt: null };
    f.state.tradeDocument.push(document); f.state.documentVersion.push({ id: 'v1-version', documentId: 'v1-doc', version: 2, content: { developmentCommercialInvoiceSnapshot: snapshot } });
    const original = JSON.stringify(f.state.documentVersion[0].content), auditId = `devci_${ciHash(['case', 'sales', command.requestKey])}`;
    const receipt = { operation: 'development_ci_command', actorId: 'sales', caseId: 'case', billingItemId: 'b1', requestKey: command.requestKey, commandHash: ciHash(command),
      action: 'issue', documentId: 'v1-doc', version: 2, versionId: 'v1-version', auditId };
    f.state.auditLog.push({ id: auditId, actorId: 'sales', action: 'development_ci_command', detail: { receipt } });
    expect(developmentCiSnapshot(f.state.documentVersion[0], document)).toEqual(snapshot);
    const { fields: ignored, ...oldCommand } = command;
    expect(await commandDevelopmentCi(f.context, 'case', oldCommand as any)).toMatchObject({ replayed: true, receipt });
    const bypass = await createInvoice({ prisma: f.prisma, actor: finance, actorId: 'finance', input: { invoiceNumber: 'BYPASS-V1', type: 'Receivable', status: 'Draft', amount: '60',
      currency: 'USD', issueDate: fields.issueDate, customerRelationId: 'customer', invoiceLines: [{ sourceType: 'BillingItem', sourceId: 'b1', amount: '60', currency: 'USD' }] } });
    expect(bypass.ok).toBe(false); expect(f.state.invoice).toEqual([]);
    await registerDevelopmentCiReceivable(f.prisma, finance, 'v1-doc', { requestKey: 'v1-ar', expectedVersionId: 'v1-version' });
    expect(f.state.invoiceLine[0]).toMatchObject({ sourceId: 'b1' }); expect(JSON.stringify(f.state.documentVersion[0].content)).toBe(original);
    await expect(previewDevelopmentCiV2Source(f.context, 'case', ['b1', 'b2'])).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('explicitly cancels an original v1 draft even when current commercial facts are missing, preserving its old version', async () => {
    const f = await ready(); f.state.developmentBillingChargeLine = [];
    const content: any = { protocolVersion: 1, sourceKind: 'development', caseId: 'case', caseCode: 'DEV-COMMERCIAL', billingItemId: 'b1',
      sourceFingerprint: 'b'.repeat(64), customerRelationId: 'customer', currency: 'USD', totalAmount: '60.0000', issueDate: fields.issueDate,
      dueDate: null, paymentTerms: fields.paymentTerms, fields, parties: { billTo: { relationId: 'customer', ...fields.billTo } }, exporterSnapshot: fields.exporter,
      costs: [], costTotals: [], lines: [{ sourceType: 'BillingItem', sourceId: 'b1', amount: '60.0000', currency: 'USD', description: fields.note }], issuedAt: null, issuedBy: null };
    f.state.tradeDocument.push({ id: 'legacy-draft', documentNumber: 'ORIGINAL-DRAFT', type: 'CommercialInvoice', domain: 'finance', sourceInvoiceId: null,
      sourceRef: developmentCiRef('case', 'b1'), relationId: 'customer', status: 'Draft', currency: 'USD', totalAmount: new Prisma.Decimal(60), issueDate: fields.issueDate, deletedAt: null });
    f.state.documentVersion.push({ id: 'legacy-version', documentId: 'legacy-draft', version: 1, content: { developmentCommercialInvoiceSnapshot: { ...content, snapshotFingerprint: ciHash(content) } } });
    const original = JSON.stringify(f.state.documentVersion[0].content);
    const cancelled = await commandDevelopmentCiV2(f.context, 'case', { action: 'cancel', requestKey: 'cancel-original', billingItemIds: ['b1'], documentId: 'legacy-draft',
      expectedVersion: 1, expectedSourceFingerprint: content.sourceFingerprint });
    expect(cancelled.document.document.status).toBe('Cancelled'); expect(cancelled.document.snapshot.protocolVersion).toBe(1);
    expect(cancelled.receipt.billingItemIds).toEqual(['b1']); expect(cancelled.document.snapshot.command.commandHash).toBe(cancelled.receipt.commandHash);
    expect(JSON.stringify(f.state.documentVersion[0].content)).toBe(original);
    expect(f.state.developmentCiBillingClaim).toEqual([]);
  });
  it('rejects revoked current grants even when replaying a commercial acknowledgement', async () => {
    const f = await ready(); f.tx.auth.scopes = ['products:read'];
    await expect(commandDevelopmentCommercialBilling(f.context, 'case', 'b1', { action: 'confirm', expectedVersion: 1, requestKey: 'confirm' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await listDevelopmentCommercialBillings(f.context, 'case')).billingItems).toHaveLength(2);
  });
});
