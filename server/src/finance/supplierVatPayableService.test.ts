import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
const auth = vi.hoisted(() => ({ active: true, scopes: ['invoices:read', 'invoices:write', 'vat:read', 'vat:write', 'invoices:reconcile', 'vouchers:read'],
  kind: 'all', orders: ['order1', 'order2'] }));
vi.mock('../auth/tokenHelpers', () => ({ loadUserWithRoles: async (_tx: unknown, id: string) => auth.active ? { id, status: 'active', deletedAt: null } : null,
  buildLoadedAuthTokenPayload: async (_tx: unknown, user: { id: string }) => ({ userId: user.id, roles: [], roleIds: [], departmentIds: [], permissions: [...auth.scopes], authorizationLoaded: true }) }));
vi.mock('../auth/permissionService', () => ({ createPermissionService: () => ({ getDataScopeResolver: async () => ({ rule: { kind: auth.kind }, allowedUserIds: ['fin'], allowedTeamIds: [] }) }),
  hasScope: (actor: any, scope: string) => actor.permissions.includes(scope) && (actor.permissionCeiling === undefined || actor.permissionCeiling.includes(scope)) }));
vi.mock('../teams/teamShareService', () => ({ createTeamShareService: () => ({ getActiveGrantedRelationIds: async () => [] }) }));
vi.mock('../orders/orderService', () => ({ buildOrderListScopeWhere: async () => ({ id: { in: [...auth.orders] } }) }));
vi.mock('../entities/sync', () => ({ syncInvoiceReferences: vi.fn(async () => {}), syncVatInvoiceReferences: vi.fn(async () => {}) }));
import { supplierFingerprint } from '../procurement/supplierContractPolicy';
import { getSupplierVatPayable, listSupplierVatPayableSources, previewSupplierVatPayable, registerSupplierVatPayable } from './supplierVatPayableService';
import { readSupplierVatPayableSource } from './supplierVatPayableSource';
import { requireFinanceAllocationAccess, assertVatInvoiceSource } from './financeSourceAccess';
const actor = { userId: 'fin', roles: [], roleIds: [], departmentIds: [], permissions: [] };
type Row = Record<string, any>;
function fixture() {
  const snapshot: Row = { schemaVersion: 1, contractKind: 'purchase', supplierRelationId: 'supplier', currency: 'CNY',
    paymentTerms: 'TT 30 days', mainDeliveryLocation: { kind: 'external', name: 'Receiver', address: 'Actual source' },
    mainDeliveryLocationKey: 'location', orderDate: '2026-10-08', businessOwnerId: 'sales', basedOnRevisionId: null, changeReason: null,
    supplierParty: { id: 'supplier', name: 'Actual supplier', taxId: 'tax-id' },
    lines: [{ id: 'line1', orderLineId: 'ol1', kind: 'Material', description: 'Actual fabric', quantity: '100', unit: 'M', unitPrice: '1', amount: '100', requestedDeliveryDate: null }],
    totalAmount: '100', sourceProofs: [{ orderId: 'order1', orderLineId: 'ol1', businessLine: 'fabric', mainApprovalId: 'approved-order',
      mainApprovalFingerprint: 'original-order', commercialFingerprint: 'actual-spec', commercial: {} }] };
  const fp = supplierFingerprint(snapshot);
  const facts: Record<string, Row[]> = {
    relation: [{ id: 'supplier', name: 'Actual supplier', taxId: 'tax-id', isOrganization: true, category: 'Supplier', ownerId: 'fin', salesRepIds: [], deletedAt: null },
      { id: 'customer', ownerId: 'fin', salesRepIds: [], deletedAt: null }, { id: 'hidden-customer', ownerId: 'other', salesRepIds: [], deletedAt: null }],
    order: [{ id: 'order1', code: 'ORDER1', poNumber: null, ownerId: 'fin', customerRelationId: 'customer', deletedAt: null },
      { id: 'order2', code: 'ORDER2', poNumber: null, ownerId: 'other', customerRelationId: 'hidden-customer', deletedAt: null }],
    orderLine: [{ id: 'ol1', orderId: 'order1' }, { id: 'ol2', orderId: 'order2' }],
    purchaseOrder: [{ id: 'PO', poNumber: 'Actual PO', supplierRelationId: 'supplier', currency: 'CNY', approvedCommitmentRevisionId: 'rev1', deletedAt: null }],
    purchaseLine: [{ id: 'line1', purchaseOrderId: 'PO', orderLineId: 'ol1', amount: '100', retiredAt: null }], outsourcingOrder: [], outsourcingLine: [],
    supplierCommitmentRevision: [{ id: 'rev1', purchaseOrderId: 'PO', outsourcingOrderId: null, revision: 1, status: 'approved', approvalRequestId: 'approval1', snapshot, contentFingerprint: fp }],
    approvalRequest: [{ id: 'approval1', actionType: 'supplier:commitment', targetType: 'SupplierCommitmentRevision', targetId: 'rev1', status: 'approved', reviewerId: 'approver', decidedAt: new Date(),
      payload: { revisionId: 'rev1', contractId: 'PO', contractKind: 'purchase', contentFingerprint: fp, documentSnapshot: snapshot } }],
    auditLog: [{ id: 'approved-audit', actorId: 'approver', action: 'approved_supplier_commitment', targetType: 'PurchaseOrder', targetId: 'PO', createdAt: new Date(),
      detail: { after: { approvalId: 'approval1', revisionId: 'rev1', status: 'approved', snapshot } } }],
    vatInvoice: [], invoice: [], invoiceOrderAllocation: [], invoiceLine: [], paymentVoucher: [], invoiceAllocation: [],
  };
  const matches = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (key === 'OR') return value.some((part: Row) => matches(row, part));
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('path' in value) return value.path.reduce((item: Row, path: string) => item?.[path], row[key]) === value.equals;
      if ('not' in value) return row[key] !== value.not;
      if ('gt' in value) return row[key] > value.gt;
      if ('gte' in value) return row[key] >= value.gte;
      if ('contains' in value) return String(row[key]).toLowerCase().includes(String(value.contains).toLowerCase());
    }
    return value === null ? row[key] == null : row[key] === value;
  });
  const tx: Row = { $queryRaw: vi.fn(async () => []) };
  for (const [model, rows] of Object.entries(facts)) tx[model] = {
    findFirst: vi.fn(async ({ where = {} }: Row = {}) => rows.find(row => matches(row, where)) ?? null),
    findUnique: vi.fn(async ({ where }: Row) => rows.find(row => matches(row, where)) ?? null),
    findMany: vi.fn(async ({ where = {}, orderBy, take }: Row = {}) => {
      const result = rows.filter(row => matches(row, where));
      if (orderBy?.id === 'asc') result.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return take === undefined ? result : result.slice(0, take);
    }),
    create: vi.fn(async ({ data }: Row) => { const row = { deletedAt: null, ...data }; rows.push(row); return row; }),
    update: vi.fn(async ({ where, data }: Row) => { const row = rows.find(row => matches(row, where)); if (!row) throw Error('missing row'); Object.assign(row, data); return { ...row }; }),
  };
  const prisma = { ...tx, $transaction: async (run: (db: Row) => Promise<unknown>) => run(tx) } as unknown as PrismaClient;
  const addVat = (id = 'VAT1', net = '100', extra: Row = {}) => { const tax = new Prisma.Decimal(net).mul('0.13');
    const row = { id, vatNumber: id, vatCode: null, direction: 'Input', invoiceType: 'Special', status: 'Received', invoiceId: null,
      relationId: 'supplier', sellerName: 'Actual supplier', sellerTaxNo: 'tax-id', buyerName: 'Actual buyer', buyerTaxNo: null, issueDate: '2026-10-08',
      netAmount: net, taxRate: '13', taxAmount: tax.toFixed(4), totalAmount: new Prisma.Decimal(net).plus(tax).toFixed(4), currency: 'CNY',
      orderId: null, attachments: null, updatedAt: BigInt(100), deletedAt: null, ...extra }; facts.vatInvoice.push(row); return row; };
  const selection = (amount = '100', extra: Row = {}) => ({ amountBasis: 'net', dueDate: '2026-11-08',
    sources: [{ contractKind: 'purchase', contractId: 'PO', commitmentRevisionId: 'rev1', lineId: 'line1', contractAmount: amount }], ...extra });
  const command = async (id = 'VAT1', selected = selection()) => {
    const preview = await previewSupplierVatPayable(prisma, actor, id, selected);
    return { ...selected, requestKey: randomUUID(), expectedVatUpdatedAt: preview.vatUpdatedAt, expectedSourceFingerprint: preview.sourceFingerprint };
  };
  const addContract = (id: string, extra: { hidden?: boolean; kind?: 'purchase' | 'processing'; currency?: string; supplierId?: string } = {}) => {
    const kind = extra.kind ?? 'purchase', next = JSON.parse(JSON.stringify(snapshot)) as Row;
    next.contractKind = kind; next.currency = extra.currency ?? 'CNY'; next.supplierRelationId = extra.supplierId ?? 'supplier';
    next.supplierParty.id = next.supplierRelationId;
    next.lines[0].id = `${id}-line`; next.lines[0].orderLineId = extra.hidden ? 'ol2' : 'ol1';
    if (kind === 'processing') next.lines[0].processType = 'Printing';
    next.sourceProofs = [{ ...next.sourceProofs[0], orderId: extra.hidden ? 'order2' : 'order1', orderLineId: next.lines[0].orderLineId }];
    const revisionId = `${id}-revision`, approvalId = `${id}-approval`, contentFingerprint = supplierFingerprint(next);
    facts[kind === 'purchase' ? 'purchaseOrder' : 'outsourcingOrder'].push({ id,
      ...(kind === 'purchase' ? { poNumber: `${id} purchase`, supplierRelationId: next.supplierRelationId }
        : { orderNumber: `${id} processing`, supplierId: next.supplierRelationId }),
      currency: next.currency, approvedCommitmentRevisionId: revisionId, deletedAt: null });
    facts[kind === 'purchase' ? 'purchaseLine' : 'outsourcingLine'].push({ id: `${id}-line`, purchaseOrderId: id, outsourcingOrderId: id,
      orderLineId: next.lines[0].orderLineId, amount: '100', retiredAt: null });
    facts.supplierCommitmentRevision.push({ id: revisionId, purchaseOrderId: kind === 'purchase' ? id : null, outsourcingOrderId: kind === 'processing' ? id : null,
      revision: 1, status: 'approved', approvalRequestId: approvalId, snapshot: next, contentFingerprint });
    facts.approvalRequest.push({ id: approvalId, actionType: 'supplier:commitment', targetType: 'SupplierCommitmentRevision', targetId: revisionId,
      status: 'approved', reviewerId: 'approver', decidedAt: new Date(), payload: { revisionId, contractId: id, contractKind: kind, contentFingerprint, documentSnapshot: next } });
    facts.auditLog.push({ id: `${id}-approved-audit`, actorId: 'approver', action: 'approved_supplier_commitment', targetType: kind === 'purchase' ? 'PurchaseOrder' : 'OutsourcingOrder',
      targetId: id, createdAt: new Date(), detail: { after: { approvalId, revisionId, status: 'approved', snapshot: next } } });
    return next;
  };
  return { facts, tx, prisma, addVat, selection, command, snapshot, addContract };
}
beforeEach(() => { auth.active = true; auth.scopes = ['invoices:read', 'invoices:write', 'vat:read', 'vat:write', 'invoices:reconcile', 'vouchers:read']; auth.kind = 'all'; auth.orders = ['order1', 'order2']; });
describe('native supplier VAT payable original source and intent', () => {
  it('registers original gross AP, VAT backlink, complete approved source and audit receipt once', async () => {
    const f = fixture(); f.addVat(); const command = await f.command();
    const first = await registerSupplierVatPayable(f.prisma, actor, 'VAT1', command);
    expect(first.invoice).toMatchObject({ type: 'Payable', status: 'Issued', sourceType: 'SupplierVatPayable', sourceId: 'VAT1', customerRelationId: 'supplier' });
    expect(String(first.invoice.amount)).toBe('113'); expect(f.facts.vatInvoice[0].invoiceId).toBe(first.invoice.id);
    const replay = await registerSupplierVatPayable(f.prisma, actor, 'VAT1', command);
    expect(replay.invoice).toEqual(first.invoice); expect(replay.receipt).toEqual(first.receipt); expect(replay.replayed).toBe(true);
    expect(f.facts.invoice).toHaveLength(1); expect(f.facts.auditLog.filter(row => row.action === 'register_supplier_vat_payable')).toHaveLength(1);
    expect((await getSupplierVatPayable(f.prisma, actor, 'VAT1')).snapshot.sources[0]).toMatchObject({ approvalId: 'approval1', approvalAuditId: 'approved-audit', orderLineId: 'ol1' });
  });
  it('binds one original key to the whole payload and same VAT to its exact existing source', async () => {
    const f = fixture(); f.addVat(); const command = await f.command(); await registerSupplierVatPayable(f.prisma, actor, 'VAT1', command);
    await expect(registerSupplierVatPayable(f.prisma, actor, 'VAT1', { ...command, dueDate: '2026-11-09' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const duplicate = await registerSupplierVatPayable(f.prisma, actor, 'VAT1', { ...command, requestKey: randomUUID() }); expect(duplicate.replayed).toBe(true);
    await expect(registerSupplierVatPayable(f.prisma, actor, 'VAT1', { ...command, requestKey: randomUUID(), dueDate: '2026-12-01' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.facts.invoice).toHaveLength(1);
  });
  it('restores the original committed ACK after later allocation status without rewriting the original result', async () => {
    const f = fixture(); f.addVat(); const command = await f.command(); const first = await registerSupplierVatPayable(f.prisma, actor, 'VAT1', command);
    f.facts.invoice[0].status = 'PartiallyPaid'; f.facts.invoice[0].updatedAt = BigInt(200);
    const replay = await registerSupplierVatPayable(f.prisma, actor, 'VAT1', command);
    expect(replay.invoice.status).toBe('Issued'); expect(replay.receipt).toEqual(first.receipt);
    expect((await getSupplierVatPayable(f.prisma, actor, 'VAT1')).invoice.status).toBe('PartiallyPaid');
  });
  it.each(['pending', 'rejected'])('cannot consume an unapproved revision %s', async status => {
    const f = fixture(); f.addVat(); f.facts.supplierCommitmentRevision[0].status = status;
    await expect(f.command()).rejects.toMatchObject({ code: 'CONFLICT' }); expect(f.facts.invoice).toHaveLength(0);
  });
  it('checks the actual approved approval and approved audit, not a revision status scalar', async () => {
    const f = fixture(); f.addVat(); f.facts.approvalRequest[0].status = 'pending';
    await expect(f.command()).rejects.toMatchObject({ code: 'CONFLICT' });
    f.facts.approvalRequest[0].status = 'approved'; f.facts.auditLog[0].actorId = 'another-person';
    await expect(f.command()).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it.each([{ currency: 'USD' }, { sellerName: 'Different supplier' }, { sellerTaxNo: 'other-tax' }, { relationId: 'other-supplier' }, { direction: 'Output' }, { status: 'RedFlushed' }])('rejects original party, currency or tax mismatch %j', async extra => {
    const f = fixture(); f.addVat('VAT1', '100', extra); await expect(f.command()).rejects.toBeDefined(); expect(f.facts.invoice).toHaveLength(0);
  });
  it('requires CAS and the precise reviewed source fingerprint after locks', async () => {
    const f = fixture(); f.addVat(); const command = await f.command(); f.facts.vatInvoice[0].updatedAt = BigInt(101);
    await expect(registerSupplierVatPayable(f.prisma, actor, 'VAT1', command)).rejects.toMatchObject({ code: 'CONFLICT' });
    const next = await f.command(); await expect(registerSupplierVatPayable(f.prisma, actor, 'VAT1', { ...next, expectedSourceFingerprint: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('counts exact net capacity across separate VATs instead of summing their tax-inclusive AP amounts', async () => {
    const f = fixture(); f.addVat('VAT1', '60'); const first = await f.command('VAT1', f.selection('60')); await registerSupplierVatPayable(f.prisma, actor, 'VAT1', first);
    f.addVat('VAT2', '40'); const second = await f.command('VAT2', f.selection('40')); await registerSupplierVatPayable(f.prisma, actor, 'VAT2', second);
    f.addVat('VAT3', '0.0001'); await expect(f.command('VAT3', f.selection('0.0001'))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.facts.invoice.map(row => String(row.amount))).toEqual(['67.8', '45.2']);
  });
  it('preserves historical approved source after later contract amendment but requires current revision for new VAT', async () => {
    const f = fixture(); f.addVat(); const command = await f.command(); const first = await registerSupplierVatPayable(f.prisma, actor, 'VAT1', command);
    f.facts.supplierCommitmentRevision[0].status = 'superseded'; f.facts.purchaseOrder[0].approvedCommitmentRevisionId = 'rev2';
    expect((await getSupplierVatPayable(f.prisma, actor, 'VAT1')).snapshot).toEqual(first.snapshot);
    expect((await registerSupplierVatPayable(f.prisma, actor, 'VAT1', command)).invoice.id).toBe(first.invoice.id);
    f.addVat('VAT2', '1'); await expect(f.command('VAT2', f.selection('1'))).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rejects every mixed hidden parent even when VAT and selected line are readable', async () => {
    const f = fixture(); auth.kind = 'self'; f.addVat(); f.snapshot.sourceProofs.push({ orderId: 'order2', orderLineId: 'ol2' });
    const fp = supplierFingerprint(f.snapshot); f.facts.supplierCommitmentRevision[0].contentFingerprint = fp;
    f.facts.approvalRequest[0].payload.contentFingerprint = fp;
    await expect(f.command()).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(f.facts.invoice).toHaveLength(0);
  });
  it('rechecks current grants and JWT ceiling on original ACK replay and original reads', async () => {
    const f = fixture(); f.addVat(); const command = await f.command(); await registerSupplierVatPayable(f.prisma, actor, 'VAT1', command);
    await expect(registerSupplierVatPayable(f.prisma, { ...actor, permissionCeiling: ['invoices:read', 'vat:read'] }, 'VAT1', command)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    auth.scopes = ['vat:read']; await expect(getSupplierVatPayable(f.prisma, actor, 'VAT1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    auth.active = false; await expect(registerSupplierVatPayable(f.prisma, actor, 'VAT1', command)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });
  it('checks source L2 again on old ACK and rejects revoked source reachability', async () => {
    const f = fixture(); f.addVat(); const command = await f.command(); await registerSupplierVatPayable(f.prisma, actor, 'VAT1', command);
    auth.kind = 'self'; auth.orders = []; await expect(registerSupplierVatPayable(f.prisma, actor, 'VAT1', command)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('detects permission withdrawal under the source lock before creating AP', async () => {
    const f = fixture(); f.addVat(); const command = await f.command();
    f.tx.$queryRaw.mockImplementation(async (sql: Prisma.Sql) => { if (sql.sql.includes('"VatInvoice"')) auth.scopes = ['invoices:read', 'vat:read']; return []; });
    await expect(registerSupplierVatPayable(f.prisma, actor, 'VAT1', command)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(f.facts.invoice).toHaveLength(0);
  });
  it('detects tampered AP amount, VAT original, registration receipt and order allocation', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.facts.invoice[0].amount = '1'; },
      (f: ReturnType<typeof fixture>) => { f.facts.vatInvoice[0].buyerName = 'changed'; },
      (f: ReturnType<typeof fixture>) => { f.facts.auditLog.find(row => row.action === 'register_supplier_vat_payable')!.detail.commandInput.dueDate = '2026-12-01'; },
      (f: ReturnType<typeof fixture>) => { f.facts.invoiceOrderAllocation[0].allocatedAmount = '112.99'; },
    ]) { const f = fixture(); f.addVat(); await registerSupplierVatPayable(f.prisma, actor, 'VAT1', await f.command()); mutate(f);
      await expect(readSupplierVatPayableSource(f.tx as Prisma.TransactionClient, 'VAT1')).rejects.toMatchObject({ code: 'CONFLICT' }); }
  });
  it('tax verification and red flush remain separate; red flush cannot be allocated as a valid payable', async () => {
    const f = fixture(); f.addVat(); await registerSupplierVatPayable(f.prisma, actor, 'VAT1', await f.command());
    f.facts.vatInvoice[0].status = 'Verified'; expect((await getSupplierVatPayable(f.prisma, actor, 'VAT1')).invoice.status).toBe('Issued');
    f.facts.vatInvoice[0].status = 'RedFlushed'; expect((await getSupplierVatPayable(f.prisma, actor, 'VAT1')).invoice.status).toBe('Issued');
    await expect(requireFinanceAllocationAccess(f.tx, actor, f.facts.invoice[0].id, 'voucher')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(assertVatInvoiceSource(f.tx, { ...f.facts.vatInvoice[0], id: 'another-vat' })).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
  });
});

describe('supplier VAT finance-only approved source candidates', () => {
  it('lists actual approved purchase and processing lines with read scopes only and no procurement grants', async () => {
    const f = fixture(); f.addVat(); f.addContract('PROCESS', { kind: 'processing' });
    auth.scopes = ['invoices:read', 'vat:read'];
    const page = await listSupplierVatPayableSources(f.prisma, { ...actor, permissionCeiling: [...auth.scopes] }, 'VAT1', { amountBasis: 'net' });
    expect(page.items).toEqual([
      expect.objectContaining({ contractKind: 'processing', contractId: 'PROCESS', commitmentRevisionId: 'PROCESS-revision', lineId: 'PROCESS-line',
        orderId: 'order1', orderLineId: 'ol1', paymentTerms: 'TT 30 days', approvedLineAmount: '100.0000', registeredAmount: '0.0000',
        remainingAmount: '100.0000', registeredAmountBasis: null, selectable: true }),
      expect.objectContaining({ contractKind: 'purchase', contractId: 'PO', commitmentRevisionId: 'rev1', lineId: 'line1', selectable: true }),
    ]);
    expect(page).toMatchObject({ nextCursor: null, hasMore: false }); expect(Object.keys(page).sort()).toEqual(['hasMore', 'items', 'nextCursor']);
    expect(f.facts.invoice).toHaveLength(0); expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('excludes the complete mixed contract when any frozen parent is hidden, even if its displayed line is owned', async () => {
    const f = fixture(); f.addVat(); const mixed = f.addContract('MIXED'); mixed.sourceProofs.push({ orderId: 'order2', orderLineId: 'ol2' });
    const revision = f.facts.supplierCommitmentRevision.find(row => row.id === 'MIXED-revision')!;
    revision.contentFingerprint = supplierFingerprint(mixed); f.facts.approvalRequest.find(row => row.id === 'MIXED-approval')!.payload.contentFingerprint = revision.contentFingerprint;
    f.addContract('HIDDEN', { hidden: true }); auth.kind = 'self'; auth.orders = ['order1'];
    const page = await listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net' });
    expect(page.items.map(row => row.contractId)).toEqual(['PO']); expect(page.hasMore).toBe(false);
    expect(JSON.stringify(page)).not.toMatch(/MIXED|HIDDEN|order2|total/);
  });
  it('filters actual supplier/currency and excludes invalid approval, retired rows and fabricated frozen proof', async () => {
    const f = fixture(); f.addVat(); f.addContract('OTHER-CURRENCY', { currency: 'USD' }); f.addContract('OTHER-SUPPLIER', { supplierId: 'another' });
    f.addContract('PENDING'); f.facts.approvalRequest.find(row => row.id === 'PENDING-approval')!.status = 'pending';
    f.addContract('RETIRED'); f.facts.purchaseLine.find(row => row.id === 'RETIRED-line')!.retiredAt = BigInt(1);
    f.addContract('TAMPER'); f.facts.supplierCommitmentRevision.find(row => row.id === 'TAMPER-revision')!.contentFingerprint = 'a'.repeat(64);
    expect((await listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'gross' })).items.map(row => row.contractId)).toEqual(['PO']);
  });
  it('shows actual cumulative capacity and basis conflict without converting net into gross', async () => {
    const f = fixture(); f.addVat('VAT1', '60'); await registerSupplierVatPayable(f.prisma, actor, 'VAT1', await f.command('VAT1', f.selection('60'))); f.addVat('VAT2', '1');
    const net = await listSupplierVatPayableSources(f.prisma, actor, 'VAT2', { amountBasis: 'net' });
    expect(net.items[0]).toMatchObject({ registeredAmount: '60.0000', remainingAmount: '40.0000', registeredAmountBasis: 'net', selectable: true });
    const gross = await listSupplierVatPayableSources(f.prisma, actor, 'VAT2', { amountBasis: 'gross' });
    expect(gross.items[0]).toMatchObject({ registeredAmount: '60.0000', remainingAmount: '40.0000', registeredAmountBasis: 'net', selectable: false });
    expect(gross.items[0].unavailableReason).toMatch(/基准/);
  });
  it('retains a fully registered line as unavailable and requires the original AP for an already registered VAT', async () => {
    const f = fixture(); f.addVat(); await registerSupplierVatPayable(f.prisma, actor, 'VAT1', await f.command()); f.addVat('VAT2', '1');
    expect((await listSupplierVatPayableSources(f.prisma, actor, 'VAT2', { amountBasis: 'net' })).items[0]).toMatchObject({ remainingAmount: '0.0000', selectable: false });
    await expect(listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('does not leak a capacity amount from an original AP whose other frozen parents are now hidden', async () => {
    const f = fixture(); f.addContract('PROCESS', { kind: 'processing', hidden: true }); f.addVat('VAT1', '20');
    const selected = f.selection('10', { sources: [{ contractKind: 'purchase', contractId: 'PO', commitmentRevisionId: 'rev1', lineId: 'line1', contractAmount: '10' },
      { contractKind: 'processing', contractId: 'PROCESS', commitmentRevisionId: 'PROCESS-revision', lineId: 'PROCESS-line', contractAmount: '10' }] });
    await registerSupplierVatPayable(f.prisma, actor, 'VAT1', await f.command('VAT1', selected)); f.addVat('VAT2', '1');
    auth.kind = 'self'; auth.orders = ['order1'];
    expect(await listSupplierVatPayableSources(f.prisma, actor, 'VAT2', { amountBasis: 'net' })).toEqual({ items: [], nextCursor: null, hasMore: false });
    expect(f.facts.invoice).toHaveLength(1);
  });
  it('pages visible rows after authorization without leaking a hidden continuation or count', async () => {
    const f = fixture(); f.addVat(); f.addContract('AA-HIDDEN', { hidden: true }); f.addContract('AB-OWN'); f.addContract('ZZ-HIDDEN', { hidden: true });
    auth.kind = 'self'; auth.orders = ['order1'];
    const first = await listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net', limit: '1' });
    expect(first.items.map(row => row.contractId)).toEqual(['AB-OWN']); expect(first.hasMore).toBe(true); expect(first.nextCursor).toEqual(expect.any(String));
    const next = await listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net', limit: '1', cursor: first.nextCursor });
    expect(next.items.map(row => row.contractId)).toEqual(['PO']); expect(next.hasMore).toBe(false); expect(next.nextCursor).toBeNull();
    const searched = await listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net', search: 'actual po' });
    expect(searched.items.map(row => row.contractId)).toEqual(['PO']);
    await expect(listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'gross', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'CONFLICT' });
    f.facts.vatInvoice[0].vatNumber = 'changed';
    await expect(listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rejects a cursor whose original current approved version was superseded rather than continuing old sources', async () => {
    const f = fixture(); f.addVat(); f.addContract('AB-OWN');
    const page = await listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net', limit: '1' });
    f.facts.purchaseOrder.find(row => row.id === 'AB-OWN')!.approvedCommitmentRevisionId = 'new-revision';
    await expect(listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net', limit: '1', cursor: page.nextCursor })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('fails closed on fresh grants, disabled account and credential ceiling without relying on stale roles', async () => {
    const f = fixture(); f.addVat();
    await expect(listSupplierVatPayableSources(f.prisma, { ...actor, permissionCeiling: ['vat:read'] }, 'VAT1', { amountBasis: 'net' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    auth.scopes = ['vat:read']; await expect(listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    auth.active = false; await expect(listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net' })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });
  it.each([{ direction: 'Output' }, { relationId: null }, { status: 'Void' }, { sellerName: 'Wrong original seller' }])('does not invent a supplier or basis for ineligible original %j', async extra => {
    const f = fixture(); f.addVat('VAT1', '100', extra);
    await expect(listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net' })).rejects.toBeDefined();
    expect(f.facts.invoice).toHaveLength(0);
  });
  it('rechecks current approval evidence and authorization after enumeration before returning any source', async () => {
    const f = fixture(); f.addVat();
    const read = f.tx.purchaseLine.findFirst.getMockImplementation();
    let count = 0;
    f.tx.purchaseLine.findFirst.mockImplementation(async (input: Row) => { const row = await read(input); if (++count === 1) f.facts.approvalRequest[0].status = 'pending'; return row; });
    await expect(listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rejects withdrawal of actual grants during enumeration before returning the page', async () => {
    const f = fixture(); f.addVat(); const read = f.tx.purchaseLine.findFirst.getMockImplementation();
    f.tx.purchaseLine.findFirst.mockImplementation(async (input: Row) => { const row = await read(input); auth.scopes = ['vat:read']; return row; });
    await expect(listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('continues through batches of hidden contracts before deciding whether another visible page exists', async () => {
    const f = fixture(); f.addVat(); for (let i = 0; i < 102; i++) f.addContract(`A-${String(i).padStart(3, '0')}`, { hidden: true });
    f.addContract('B-OWN'); auth.kind = 'self'; auth.orders = ['order1'];
    const page = await listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net', limit: 1 });
    expect(page.items.map(row => row.contractId)).toEqual(['B-OWN']); expect(page.hasMore).toBe(true);
    const next = await listSupplierVatPayableSources(f.prisma, actor, 'VAT1', { amountBasis: 'net', limit: 1, cursor: page.nextCursor });
    expect(next.items.map(row => row.contractId)).toEqual(['PO']); expect(next).toMatchObject({ hasMore: false, nextCursor: null });
    expect(f.tx.purchaseOrder.findMany.mock.calls.some(([input]: [Row]) => input.where.id?.gt === 'A-099')).toBe(true);
  });
});
