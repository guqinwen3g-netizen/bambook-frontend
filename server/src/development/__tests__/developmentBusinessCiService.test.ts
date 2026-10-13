import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const auth = vi.hoisted(() => ({ active: true, scopes: ['products:read', 'products:write', 'invoices:read', 'invoices:write'], access: 'owner' }));
vi.mock('../../auth/tokenHelpers', () => ({ loadUserWithRoles: vi.fn(async (_tx, id) => auth.active ? { id, status: 'active', deletedAt: null } : null),
  buildLoadedAuthTokenPayload: vi.fn(async (_tx, user) => ({ userId: user.id, roles: [], permissions: [...auth.scopes], roleIds: [], authorizationLoaded: true })) }));
vi.mock('../../auth/permissionService', () => ({ createPermissionService: () => ({ getDataScopeResolver: async (actor: any) => ({ rule: { kind: actor.userId === 'finance' ? 'all' : 'team' }, allowedTeamIds: ['team'] }) }),
  hasScope: (actor: any, scope: string) => actor.permissions.includes(scope) && (actor.permissionCeiling === undefined || actor.permissionCeiling.includes(scope)) }));
vi.mock('../../teams/teamShareService', () => ({ createTeamShareService: () => ({ resolveRelationAccess: async () => auth.access }) }));
vi.mock('../developmentExpenseSnapshot', () => ({ readDevelopmentExpenseSnapshot: async (tx: any) => ({ records: tx.facts.costs, totals: [{ currency: 'CNY', amount: '20.0000' }], unresolvedProductionExpenses: [], unsupportedCurrencies: [] }) }));
vi.mock('../../templates/docTemplates/financeInvoice', () => ({ currentExporterProfileSnapshot: async () => ({ nameEn: 'Seller Ltd', addressEn: 'Seller address' }) }));
vi.mock('../../finance/invoiceMutationService', () => ({ createInvoice: vi.fn(async ({ transaction, input }: any) => {
  const invoice = { id: `ar-${transaction.tx.facts.invoices.length + 1}`, ...input, deletedAt: null }; transaction.tx.facts.invoices.push(invoice); transaction.tx.facts.invoiceLines.push(...input.invoiceLines.map((line: any) => ({ ...line, invoiceId: invoice.id }))); return { ok: true, data: { invoice } };
}) }));
vi.mock('../../finance/billingItemService', () => ({ createBillingItemInTx: vi.fn(async (tx: any, { input }: any) => {
  const row = { id: `billing-${tx.facts.billings.length + 1}`, itemNo: `BI-${tx.facts.billings.length + 1}`, ...input,
    amount: String(input.amount), waivedAmount: String(input.waivedAmount), offsetAmount: '0', status: 'draft',
    developmentWorkflowVersion: 0, updatedAt: BigInt(20), invoiceId: null };
  tx.facts.billings.push(row); return row;
}) }));
vi.mock('../../templates/pdf', () => ({ renderHtmlToPdf: async () => ({ pdf: Buffer.from('%PDF synthetic exact CI'), bytes: 23, sha: 'f'.repeat(64) }) }));
import { commandDevelopmentCi, previewDevelopmentCiSource } from '../developmentBusinessCiService';
import { commandDevelopmentCommercialBilling, commercialBillingFingerprint } from '../developmentCommercialBillingService';
import { previewDevelopmentCiV2Source } from '../developmentBusinessCiV2Service';
import { readDevelopmentCiVersionInTx, ciHash } from '../developmentCiSource';
import { registerDevelopmentCiReceivable, listPendingDevelopmentCiReceivables } from '../../finance/developmentCiReceivableService';
import { createInvoice } from '../../finance/invoiceMutationService';
import { readDevelopmentFinanceProjection } from '../developmentFinanceProjectionService';
import { readDevelopmentCiInvoiceSource } from '../../finance/developmentCiInvoiceSource';
import { generateDevelopmentCiArchive, assertDevelopmentCiArchiveInTx } from '../developmentCiArchiveService';
import { renderDevelopmentCiDocument } from '../developmentCiDocument';
import { createDevelopmentSupplementalBillingDraft, previewDevelopmentSupplementalBilling } from '../developmentBillingDraftService';

const business: any = { userId: 'sales', permissionCeiling: ['products:read', 'products:write'] };
const finance: any = { userId: 'finance', permissionCeiling: ['invoices:read', 'invoices:write'] };
const fields = { issueDate: '2026-10-07', dueDate: '2026-11-07', paymentTerms: 'TT 30 days', note: 'Development and sample services',
  billTo: { name: 'Buyer Ltd', address: 'Buyer address' }, exporter: { nameEn: 'Seller Ltd', addressEn: 'Seller address' } };
function fixture() {
  const facts = { costs: [{ id: 'cost-1', sourceType: 'DevelopmentCase', sourceId: 'case-1', costType: 'sample_making', amount: '20.0000', currency: 'CNY', incurredAt: '2026-10-07' }],
    billing: { id: 'billing-1', itemNo: 'BI-1', sourceType: 'DevelopmentCase', sourceId: 'case-1', chargeType: 'development_fee', status: 'draft',
      amount: '100.0000', waivedAmount: '0', offsetAmount: '0', currency: 'USD', bearerType: 'customer', bearerRelationId: 'customer-1',
      developmentWorkflowState: 'draft', developmentWorkflowVersion: 0, updatedAt: BigInt(10), notes: 'Charge agreed with customer', invoiceId: null },
    commercialLines: [] as any[], claims: [] as any[], invoiceLines: [] as any[], documents: [] as any[], versions: [] as any[], audits: [] as any[], invoices: [] as any[], coverage: [] as any[], allocations: [] as any[], vouchers: [] as any[],
    billings: [] as any[], tasks: [] as any[], approvals: [] as any[] };
  facts.billings.push(facts.billing);
  const line = { id: 'charge-1', billingItemId: 'billing-1', displayOrder: 0, purpose: 'Development', description: 'Customer agreed sample development',
    sourceType: 'DevelopmentCase', sourceId: 'case-1', sourceLabel: 'DEV-1', roundId: null, roundNumber: null, roundLabel: '整案', amount: '100.0000', currency: 'USD' };
  facts.commercialLines.push(line);
  facts.coverage.push({ id: 'cov-1', billingItemId: 'billing-1', costRecordId: 'cost-1', costAmount: '20.0000', costCurrency: 'CNY', releasedAt: null });
  const selection = { caseId: 'case-1', billingItemId: 'billing-1', costs: facts.costs.map(cost => ({ ...cost })), costFingerprint: ciHash(facts.costs) };
  Object.assign(facts.billing, { developmentCommercialCostSelection: selection, developmentCommercialConfirmedAt: 1n, developmentCommercialConfirmedBy: 'sales',
    developmentCommercialFingerprint: commercialBillingFingerprint(facts.billing, [line], selection) });
  const matches = (row: any, where: any): boolean => Object.entries(where || {}).every(([key, value]: any) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (value && typeof value === 'object') {
      if (value.path) return value.path.reduce((target: any, part: string) => target?.[part], row[key]) === value.equals;
      if (value.in) return value.in.includes(row[key]); if (value.notIn) return !value.notIn.includes(row[key]);
      if ('not' in value) return row[key] !== value.not; if (value.startsWith) return row[key]?.startsWith(value.startsWith);
      return true;
    }
    return value === null ? row[key] == null : row[key] === value;
  });
  const tx: any = { facts, $queryRaw: vi.fn(async () => [{ id: 'locked' }]),
    developmentCase: { findFirst: vi.fn(async ({ where }: any) => where.id === 'case-1' ? { id: 'case-1', code: 'DEV-1', customerRelationId: 'customer-1' } : null) },
    relation: { findFirst: vi.fn(async ({ where }: any) => where.id === 'customer-1' ? { id: 'customer-1', name: 'Buyer Ltd', ownerId: auth.access === 'owner' ? 'sales' : 'other' } : null) },
    teamDataGrant: { findFirst: vi.fn(async () => ['team-read', 'team-followup'].includes(auth.access) ? { id: 'grant' } : null) },
    billingItem: { findFirst: vi.fn(async ({ where }: any) => facts.billings.find(row => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where }: any) => facts.billings.filter(row => matches(row, where))),
      update: vi.fn(async ({ where, data }: any) => Object.assign(facts.billings.find(row => row.id === where.id), data)) },
    developmentBillingChargeLine: { findMany: vi.fn(async ({ where }: any) => facts.commercialLines.filter(row => matches(row, where))),
      findUnique: vi.fn(async ({ where }: any) => facts.commercialLines.find(row => row.id === where.id) ?? null),
      deleteMany: vi.fn(async ({ where }: any) => { facts.commercialLines = facts.commercialLines.filter(row => !matches(row, where)); }),
      create: vi.fn(async ({ data }: any) => { facts.commercialLines.push(data); return data; }) },
    developmentCiBillingClaim: { findMany: vi.fn(async ({ where }: any) => facts.claims.filter(row => matches(row, where))),
      create: vi.fn(async ({ data }: any) => { const row = { releasedAt: null, ...data }; facts.claims.push(row); return row; }),
      updateMany: vi.fn(async ({ where, data }: any) => { for (const row of facts.claims.filter(row => matches(row, where))) Object.assign(row, data); }) },
    billingItemCostCoverage: { updateMany: vi.fn(async ({ where, data }: any) => { for (const row of facts.coverage.filter(row => matches(row, where))) Object.assign(row, data); }), findMany: vi.fn(async ({ where }: any) => facts.coverage.filter(row => matches(row, where))), create: vi.fn(async ({ data }: any) => { const row = { releasedAt: null, ...data }; facts.coverage.push(row); return row; }) },
    invoiceLine: { findFirst: vi.fn(async ({ where }: any) => facts.invoiceLines.find(row => matches(row, where)) ?? null), findMany: vi.fn(async ({ where }: any) => facts.invoiceLines.filter(row => matches(row, where))) },
    tradeDocument: { findFirst: vi.fn(async ({ where }: any) => facts.documents.find(row => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where }: any) => facts.documents.filter(row => matches(row, where))), create: vi.fn(async ({ data }: any) => { facts.documents.push(data); return data; }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(facts.documents.find(row => row.id === where.id), data)) },
    documentVersion: { findUnique: vi.fn(async ({ where }: any) => facts.versions.find(row => row.id === where.id) ?? null),
      findFirst: vi.fn(async ({ where }: any) => [...facts.versions].reverse().find(row => row.documentId === where.documentId && (!where.version || row.version === where.version)) ?? null),
      create: vi.fn(async ({ data }: any) => { facts.versions.push(data); return data; }) },
    auditLog: { findUnique: vi.fn(async ({ where }: any) => facts.audits.find(row => row.id === where.id) ?? null),
      findFirst: vi.fn(async ({ where }: any) => facts.audits.find(row => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where }: any) => facts.audits.filter(row => matches(row, where))),
      create: vi.fn(async ({ data }: any) => { facts.audits.push(data); return data; }) },
    invoice: { findFirst: vi.fn(async ({ where }: any) => facts.invoices.find(row => (!where.id || row.id === where.id) && (!where.sourceType || row.sourceType === where.sourceType) && (!where.sourceId || row.sourceId === where.sourceId)) ?? null) },
    invoiceAllocation: { findMany: vi.fn(async ({ where }: any) => facts.allocations.filter(row => row.invoiceId === where.invoiceId)) },
    creditNoteAllocation: { findMany: vi.fn(async () => []) }, paymentVoucher: { findFirst: vi.fn(async ({ where }: any) => facts.vouchers.find(row => row.id === where.id) ?? null) },
    workAssignment: { findMany: vi.fn(async ({ where }: any) => facts.tasks.filter(row => matches(row, where))),
      update: vi.fn(async ({ where, data }: any) => Object.assign(facts.tasks.find(row => row.id === where.id), data)) } };
  const prisma: any = { ...tx, $transaction: vi.fn(async (work: any) => work(tx)) };
  return { prisma, tx, facts, context: { prisma, actor: business } };
}
beforeEach(() => { vi.clearAllMocks(); auth.active = true; auth.access = 'owner'; auth.scopes = ['products:read', 'products:write', 'invoices:read', 'invoices:write']; });
async function saved(f = fixture()) {
  const source = await previewDevelopmentCiV2Source(f.context, 'case-1', ['billing-1']);
  const command: any = { action: 'save', requestKey: 'save-1', billingItemIds: ['billing-1'], expectedVersion: 0, expectedSourceFingerprint: source.sourceFingerprint, fields };
  const result = await commandDevelopmentCi(f.context, 'case-1', command); return { ...f, command, result };
}
async function issued(f = fixture()) {
  const s = await saved(f); const command: any = { action: 'issue', requestKey: 'issue-1', billingItemIds: ['billing-1'], documentId: s.result.receipt.documentId,
    expectedVersion: 1, expectedSourceFingerprint: s.command.expectedSourceFingerprint };
  const result = await commandDevelopmentCi(f.context, 'case-1', command); return { ...f, command, result };
}

describe('Development business CI source and issued-version finance registration', () => {
  it('business saves and issues without Finance write scope; costs keep their own currency and no fabricated quantity', async () => {
    auth.scopes = ['products:read', 'products:write']; const f = await issued();
    expect(f.result.document.snapshot).toMatchObject({ totalAmount: '100.0000', currency: 'USD', issuedBy: 'sales', costs: [{ amount: '20.0000', currency: 'CNY' }] });
    expect(f.result.document.snapshot.lines[0]).not.toHaveProperty('quantity');
    expect(f.facts.billing).toMatchObject({ status: 'confirmed', developmentWorkflowState: 'business_ci_issued', invoiceId: null });
    expect(createInvoice).not.toHaveBeenCalled();
  });
  it('replays the original saved acknowledgement even after a later issued version', async () => {
    const f = await saved(); await commandDevelopmentCi(f.context, 'case-1', { action: 'issue', requestKey: 'issue-1', billingItemIds: ['billing-1'], expectedVersion: 1, expectedSourceFingerprint: f.command.expectedSourceFingerprint });
    const retry = await commandDevelopmentCi(f.context, 'case-1', f.command);
    expect(retry).toMatchObject({ replayed: true, receipt: f.result.receipt }); expect(f.facts.versions).toHaveLength(2);
  });
  it('rejects same key with different fields and stale CAS without creating another version', async () => {
    const f = await saved(); await expect(commandDevelopmentCi(f.context, 'case-1', { ...f.command, fields: { ...fields, note: 'Other' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(commandDevelopmentCi(f.context, 'case-1', { ...f.command, requestKey: 'save-2' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.facts.versions).toHaveLength(1);
  });
  it('requires refreshing changed fees before issue and never overwrites an issued CI', async () => {
    const f = await saved(); f.facts.costs[0].amount = '21.0000';
    await expect(commandDevelopmentCi(f.context, 'case-1', { ...f.command, action: 'issue', requestKey: 'issue-1', expectedVersion: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    const done = await issued(); const source = await previewDevelopmentCiV2Source(done.context, 'case-1', ['billing-1']);
    await expect(commandDevelopmentCi(done.context, 'case-1', { ...done.command, action: 'save', requestKey: 'overwrite', expectedVersion: 2, expectedSourceFingerprint: source.sourceFingerprint, fields })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(done.facts.versions).toHaveLength(2);
  });
  it('enforces current account, credential ceiling and cross-case/customer source access', async () => {
    const f = await saved(); auth.scopes = ['products:read'];
    await expect(commandDevelopmentCi(f.context, 'case-1', f.command)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    auth.scopes.push('products:write'); auth.access = 'none';
    await expect(commandDevelopmentCi(f.context, 'case-1', f.command)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    auth.access = 'owner'; await expect(commandDevelopmentCi({ ...f.context, actor: { userId: 'sales', permissionCeiling: ['products:read'] } }, 'case-1', f.command)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(commandDevelopmentCi(f.context, 'case-other', f.command)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    auth.active = false; await expect(commandDevelopmentCi(f.context, 'case-1', f.command)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });
  it('detects tampered issued amount/header and immutable source content', async () => {
    const f = await issued(); f.facts.versions[1].content.developmentCommercialInvoiceSnapshot.totalAmount = '101';
    await expect(readDevelopmentCiVersionInTx(f.tx, f.result.receipt.documentId, business)).rejects.toMatchObject({ code: 'CONFLICT' });
    const g = await issued(); g.facts.documents[0].totalAmount = new Prisma.Decimal(200);
    await expect(readDevelopmentCiVersionInTx(g.tx, g.result.receipt.documentId, business)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('finance inbox and registration consume exact business CI, then repeat the original receipt after partial payment', async () => {
    const f = await issued(); const pending = await listPendingDevelopmentCiReceivables(f.prisma, finance);
    expect(pending.items[0]).toMatchObject({ caseId: 'case-1', versionId: f.result.receipt.versionId, amount: '100.0000' });
    const input = { requestKey: 'register-1', expectedVersionId: f.result.receipt.versionId };
    const first = await registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, input);
    expect(createInvoice).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ type: 'Receivable', status: 'Issued', sourceType: 'BusinessDevelopmentCI', amount: '100.0000' }) }));
    f.facts.invoices[0].status = 'PartiallyPaid';
    const replay = await registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, input);
    expect(replay).toMatchObject({ replayed: true, receipt: first.receipt, invoice: { status: 'PartiallyPaid' } }); expect(createInvoice).toHaveBeenCalledOnce();
    expect((await listPendingDevelopmentCiReceivables(f.prisma, finance)).items).toEqual([]);
  });
  it('rejects draft and wrong-version finance registration', async () => {
    const f = await saved(); await expect(registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, { requestKey: 'register-1', expectedVersionId: f.result.receipt.versionId })).rejects.toMatchObject({ code: 'CONFLICT' });
    const g = await issued(); await expect(registerDevelopmentCiReceivable(g.prisma, finance, g.result.receipt.documentId, { requestKey: 'register-1', expectedVersionId: 'old-version' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(createInvoice).not.toHaveBeenCalled();
  });
  it('development reads real partial balance and only its own allocations from a multi-CI voucher', async () => {
    const f = await issued(); await registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, { requestKey: 'r-1', expectedVersionId: f.result.receipt.versionId });
    f.facts.invoices[0].status = 'PartiallyPaid'; f.facts.allocations.push({ id: 'a-1', invoiceId: 'ar-1', voucherId: 'cash-1', appliedAmount: '40', appliedDate: '2026-10-07' }, { id: 'secret', invoiceId: 'other-ci', voucherId: 'cash-1', appliedAmount: '60' });
    f.facts.vouchers.push({ id: 'cash-1', voucherNumber: 'PV-1', type: 'Receipt', currency: 'USD', paymentDate: '2026-10-07' });
    const view = await readDevelopmentFinanceProjection(f.prisma, 'case-1', business);
    expect(view.items[0].invoice).toMatchObject({ appliedAmount: '40.0000', openAmount: '60.0000' });
    expect(view.items[0].receipts.map((row: any) => row.id)).toEqual(['a-1']);
  });
  it('financial rendering resolves the exact business original and preserves its identity after payment', async () => {
    const f = await issued(); await registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, { requestKey: 'r-1', expectedVersionId: f.result.receipt.versionId });
    const first = await readDevelopmentCiInvoiceSource(f.prisma, 'ar-1', finance); f.facts.invoices[0].status = 'Paid';
    const settled = await readDevelopmentCiInvoiceSource(f.prisma, 'ar-1', finance); expect(settled.fingerprint).toBe(first.fingerprint);
    const html = renderDevelopmentCiDocument(first); expect(html).toContain('COMMERCIAL INVOICE'); expect(html).toContain('Development and sample services');
    expect(html).not.toMatch(/Container|Vessel|Gross weight/i);
    f.facts.invoices[0].amount = '999'; await expect(readDevelopmentCiInvoiceSource(f.prisma, 'ar-1', finance)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('archives only the exact issued original with provenance and rejects tampered file proof', async () => {
    const f = await issued(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-ci-archive-')), previousRoot = process.env.BAMBOOK_UPLOAD_DIR;
    process.env.BAMBOOK_UPLOAD_DIR = directory; auth.scopes.push('customs:read', 'customs:write');
    const authority: any = { userId: 'finance' };
    try {
      const result = await generateDevelopmentCiArchive(f.prisma, f.facts.documents[0], { actorId: 'finance', trustedActor: authority, version: 2 });
      expect(result.filePath).toMatch(/^trade-documents\/ci-development-/); expect(fs.existsSync(path.join(directory, result.filePath))).toBe(true);
      // The immutable business version is untouched by byte publication.
      expect(f.facts.versions).toHaveLength(2);
      f.tx.auditLog.findMany.mockImplementation(async () => f.facts.audits.filter(row => row.action === 'TRADE_DOCUMENT_FILE_GENERATED'));
      await assertDevelopmentCiArchiveInTx(f.tx, f.facts.documents[0], f.facts.documents[0], authority);
      f.facts.audits.find(row => row.action === 'TRADE_DOCUMENT_FILE_GENERATED').detail.developmentCiVersionId = 'foreign';
      await expect(assertDevelopmentCiArchiveInTx(f.tx, f.facts.documents[0], f.facts.documents[0], authority)).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally { if (previousRoot === undefined) delete process.env.BAMBOOK_UPLOAD_DIR; else process.env.BAMBOOK_UPLOAD_DIR = previousRoot; fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('issues a second immutable CI for explicitly selected late costs and reads each invoice balance', async () => {
    const f = await issued(), original = JSON.stringify(f.facts.versions[1].content);
    await registerDevelopmentCiReceivable(f.prisma, finance, f.result.receipt.documentId, { requestKey: 'first-ar', expectedVersionId: f.result.receipt.versionId });
    f.facts.costs.push({ ...f.facts.costs[0], id: 'cost-2', amount: '8.0000' }, { ...f.facts.costs[0], id: 'cost-3', amount: '6.0000' });
    const scope = await previewDevelopmentSupplementalBilling(f.context, 'case-1');
    expect(scope.costs.map((row: any) => row.id)).toEqual(['cost-2', 'cost-3']); expect(scope.occupiedCount).toBe(1);
    const command = { requestKey: 'supplement-1', expectedSourceFingerprint: scope.sourceFingerprint, costRecordIds: ['cost-2'], amount: '30', waivedAmount: '0', currency: 'USD', note: 'Later customer-agreed services' };
    const draft = await createDevelopmentSupplementalBillingDraft(f.context, 'case-1', command);
    await commandDevelopmentCommercialBilling(f.context, 'case-1', draft.billingItem.id, { action: 'save', requestKey: 'explicit-' + draft.billingItem.id,
      expectedVersion: 0, chargeLines: [{ id: 'commercial-' + draft.billingItem.id, displayOrder: 0, purpose: 'Additional development services',
        description: command.note, sourceType: 'DevelopmentCase', sourceId: 'case-1', amount: '30', currency: 'USD' }], costRecordIds: command.costRecordIds });
    const source = await previewDevelopmentCiV2Source(f.context, 'case-1', [draft.billingItem.id]);
    expect(source.costs.map((row: any) => row.id)).toEqual(['cost-2']); expect(source.totals).toEqual([{ currency: 'CNY', amount: '8.0000' }]);
    const saved = await commandDevelopmentCi(f.context, 'case-1', { action: 'save', requestKey: 'supp-save', billingItemIds: [draft.billingItem.id], expectedVersion: 0, expectedSourceFingerprint: source.sourceFingerprint, fields });
    f.facts.costs.push({ ...f.facts.costs[0], id: 'unselected-after-draft', amount: '2.0000' });
    const second = await commandDevelopmentCi(f.context, 'case-1', { action: 'issue', requestKey: 'supp-issue', billingItemIds: [draft.billingItem.id], documentId: saved.receipt.documentId, expectedVersion: 1, expectedSourceFingerprint: source.sourceFingerprint });
    const ar = await registerDevelopmentCiReceivable(f.prisma, finance, second.receipt.documentId, { requestKey: 'second-ar', expectedVersionId: second.receipt.versionId });
    expect(ar.invoice.id).toBe('ar-2'); expect(JSON.stringify(f.facts.versions[1].content)).toBe(original);
    expect((await previewDevelopmentCiV2Source(f.context, 'case-1', ['billing-1'])).costs.map((row: any) => row.id)).toEqual(['cost-1']);
    expect((await previewDevelopmentSupplementalBilling(f.context, 'case-1')).costs.map((row: any) => row.id)).toEqual(['cost-3', 'unselected-after-draft']);
    expect(await createDevelopmentSupplementalBillingDraft(f.context, 'case-1', command)).toMatchObject({ replayed: true, receipt: draft.receipt, billingItem: { status: 'invoiced' } });
    f.facts.allocations.push({ id: 'pay-first', invoiceId: 'ar-1', voucherId: 'cash', appliedAmount: '40' }, { id: 'pay-second', invoiceId: 'ar-2', voucherId: 'cash', appliedAmount: '20' });
    f.facts.vouchers.push({ id: 'cash', voucherNumber: 'PV', type: 'Receipt', currency: 'USD' });
    const view = await readDevelopmentFinanceProjection(f.prisma, 'case-1', business);
    expect(view.items.map((row: any) => row.invoice.openAmount).sort()).toEqual(['10.0000', '60.0000']);
  });
  it('rejects covered, foreign, duplicate, stale selection and changed selected facts without silently enlarging coverage', async () => {
    const f = await issued(); f.facts.costs.push({ ...f.facts.costs[0], id: 'late', amount: '8.0000' });
    const scope = await previewDevelopmentSupplementalBilling(f.context, 'case-1');
    const command = { requestKey: 'supplement-1', expectedSourceFingerprint: scope.sourceFingerprint, costRecordIds: ['late'], amount: '30', waivedAmount: '0', currency: 'USD', note: 'Selected later fee' };
    for (const ids of [['cost-1'], ['foreign'], ['late', 'late']]) await expect(createDevelopmentSupplementalBillingDraft(f.context, 'case-1', { ...command, costRecordIds: ids })).rejects.toMatchObject({ code: 'CONFLICT' });
    const created = await createDevelopmentSupplementalBillingDraft(f.context, 'case-1', command);
    await commandDevelopmentCommercialBilling(f.context, 'case-1', created.billingItem.id, { action: 'save', requestKey: 'explicit-' + created.billingItem.id,
      expectedVersion: 0, chargeLines: [{ id: 'commercial-' + created.billingItem.id, displayOrder: 0, purpose: 'Additional development services',
        description: command.note, sourceType: 'DevelopmentCase', sourceId: 'case-1', amount: '30', currency: 'USD' }], costRecordIds: command.costRecordIds });
    await expect(createDevelopmentSupplementalBillingDraft(f.context, 'case-1', { ...command, note: 'Changed original key' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(createDevelopmentSupplementalBillingDraft(f.context, 'case-1', { ...command, requestKey: 'parallel-key' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const source = await previewDevelopmentCiV2Source(f.context, 'case-1', [created.billingItem.id]);
    await commandDevelopmentCi(f.context, 'case-1', { action: 'save', requestKey: 'supp-save', billingItemIds: [created.billingItem.id], expectedVersion: 0, expectedSourceFingerprint: source.sourceFingerprint, fields });
    f.facts.costs[1].amount = '9.0000';
    await expect(commandDevelopmentCi(f.context, 'case-1', { action: 'issue', requestKey: 'supp-issue', billingItemIds: [created.billingItem.id], expectedVersion: 1, expectedSourceFingerprint: source.sourceFingerprint })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.facts.documents).toHaveLength(2); expect(f.facts.documents[1].status).toBe('Draft'); expect(f.facts.coverage.filter(row => row.billingItemId === created.billingItem.id)).toHaveLength(1);
  });
  it('supersedes only matching unfinished old work on successful issue and preserves approvals and completed history', async () => {
    const f = fixture(); const metadata = { managedBy: 'development_cost_closure', caseId: 'case-1', billingItemId: 'billing-1', kind: 'finance_handoff', fingerprint: 'original' };
    f.facts.tasks.push({ id: 'finance-work', status: 'assigned', metadata }, { id: 'supplement-work', status: 'assigned', metadata: { ...metadata, kind: 'billing_supplement', requiredItems: ['Original question'] } },
      { id: 'review-work', status: 'assigned', metadata: { ...metadata, kind: 'finance_review' } }, { id: 'completed', status: 'completed', metadata },
      { id: 'foreign-billing', status: 'assigned', metadata: { ...metadata, billingItemId: 'other' } }, { id: 'foreign-case', status: 'assigned', metadata: { ...metadata, caseId: 'other' } });
    f.facts.approvals.push({ id: 'original-approval', status: 'pending', payload: { original: true } }); const approvals = JSON.stringify(f.facts.approvals);
    const s = await saved(f); expect(f.facts.tasks.every(row => row.status !== 'cancelled')).toBe(true);
    await expect(commandDevelopmentCi(f.context, 'case-1', { action: 'issue', requestKey: 'wrong-version', billingItemIds: ['billing-1'], expectedVersion: 0, expectedSourceFingerprint: s.command.expectedSourceFingerprint })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.facts.tasks.every(row => row.status !== 'cancelled')).toBe(true);
    const result = await commandDevelopmentCi(f.context, 'case-1', { action: 'issue', requestKey: 'issue-1', billingItemIds: ['billing-1'], expectedVersion: 1, expectedSourceFingerprint: s.command.expectedSourceFingerprint });
    expect(f.facts.tasks.filter(row => row.status === 'cancelled').map(row => row.id)).toEqual(['finance-work', 'supplement-work', 'review-work']);
    expect(f.facts.tasks[1].metadata).toMatchObject({ requiredItems: ['Original question'], result: { outcome: 'superseded_by_business_ci', versionId: result.receipt.versionId } });
    expect(f.facts.tasks[3].status).toBe('completed'); expect(JSON.stringify(f.facts.approvals)).toBe(approvals);
    expect(f.facts.audits.filter(row => row.action === 'supersede_development_finance_task_by_ci')).toHaveLength(3);
    const replay = await commandDevelopmentCi(f.context, 'case-1', { action: 'issue', requestKey: 'issue-1', billingItemIds: ['billing-1'], expectedVersion: 1, expectedSourceFingerprint: s.command.expectedSourceFingerprint });
    expect(replay).toMatchObject({ replayed: true, receipt: result.receipt }); expect(f.facts.audits.filter(row => row.action === 'supersede_development_finance_task_by_ci')).toHaveLength(3);
  });
  it('requires a prior real issued CI and current business grants even to recover a supplemental acknowledgement', async () => {
    const empty = fixture(), scope = await previewDevelopmentSupplementalBilling(empty.context, 'case-1'); expect(scope.canSupplement).toBe(false);
    const command = { requestKey: 'supplement-1', expectedSourceFingerprint: scope.sourceFingerprint, costRecordIds: ['cost-1'], amount: '30', waivedAmount: '0', currency: 'USD', note: 'Later fee' };
    await expect(createDevelopmentSupplementalBillingDraft(empty.context, 'case-1', command)).rejects.toMatchObject({ code: 'CONFLICT' });
    const f = await issued(); f.facts.costs.push({ ...f.facts.costs[0], id: 'late', amount: '8.0000' });
    const actual = { ...command, costRecordIds: ['late'], expectedSourceFingerprint: (await previewDevelopmentSupplementalBilling(f.context, 'case-1')).sourceFingerprint };
    await createDevelopmentSupplementalBillingDraft(f.context, 'case-1', actual); auth.scopes = ['products:read'];
    await expect(createDevelopmentSupplementalBillingDraft(f.context, 'case-1', actual)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects a supplemental selection that no longer matches its original command receipt', async () => {
    const f = await issued(); f.facts.costs.push({ ...f.facts.costs[0], id: 'late', amount: '8.0000' });
    const scope = await previewDevelopmentSupplementalBilling(f.context, 'case-1');
    const result = await createDevelopmentSupplementalBillingDraft(f.context, 'case-1', { requestKey: 'supplement-1', expectedSourceFingerprint: scope.sourceFingerprint,
      costRecordIds: ['late'], amount: '30', waivedAmount: '0', currency: 'USD', note: 'Later fee' });
    f.facts.audits.find(row => row.id === result.receipt.auditId).detail.command.costRecordIds = ['another-real-cost'];
    await expect(previewDevelopmentCiSource(f.context, 'case-1', result.billingItem.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

import { Prisma } from '@prisma/client';
