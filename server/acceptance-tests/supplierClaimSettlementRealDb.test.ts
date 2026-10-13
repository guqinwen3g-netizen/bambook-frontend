/**
 * Native procurement/finance/approval HTTP and common allocation kernel in an
 * opt-in isolated PostgreSQL cluster. Independent contract: MaterialReturn
 * design P1-4/schema claim source; invoiceSettlementBasis defines |negative
 * Payable|; incoming supplier funds are Receipt, outgoing supplier funds are
 * Disbursement. Closing a claim requires actual full settlement of that exact
 * source, and all mandatory audits roll back with domain writes.
 *
 * PO/material-receipt and account/role rows are synthetic source fixtures. Every
 * MaterialReturn is created, shipped and confirmed through native HTTP; credit
 * invoices, vouchers, approvals, allocations and settlement are never hand-
 * created as confirmed/Paid/approved. Explicit post-formation corruptions test
 * damaged historical projections, not legitimate production facts. No real
 * bank transfer, company-account validation, rendered UI or default-role UAT.
 * The old SETTLE_GAP_OPEN source scanner is not behavioral evidence: the actual
 * allocation kernel already uses an absolute settlement basis.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createProcurementRouter } from '../src/procurement/procurementRoute';
import { createFinanceRouter } from '../src/finance/route';
import { createPaymentRequestRouter } from '../src/paymentRequests/paymentRequestRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { applyAllocation } from '../src/finance/allocationService';

const prefix = 'acceptance-supplier-settlement-' + randomUUID();
const scopes = ['procurement:read', 'procurement:write', 'finance:read', 'invoices:read', 'invoices:write', 'invoices:reconcile',
  'vouchers:read', 'vouchers:write', 'finance:payment_request:create', 'finance:payment_request:read'];
let prisma: PrismaClient | undefined, serial = 0;
const db = () => { if (!prisma) throw Error('Isolated supplier settlement PG not initialized'); return prisma; };
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, row) => typeof row === 'bigint' ? row.toString() : row);
function app(database: PrismaClient = db()) {
  const result = express(); result.use(express.json());
  result.set('json replacer', (_key: string, row: unknown) => typeof row === 'bigint' ? row.toString() : row);
  result.use(createAccountStatusGuard(db()));
  result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  result.use('/api/v1/procurement', createProcurementRouter({ prisma: database, requireAuth: true, apiKeys: new Set() }));
  result.use('/api/v1/finance', createFinanceRouter({ prisma: database, requireAuth: true, apiKeys: new Set() }));
  result.use('/api/v1/payment-requests', createPaymentRequestRouter({ prisma: database, requireAuth: true }));
  // No singleton/scheduler/bootstrap hook. The native issue-voucher fallback
  // projects the actually committed approval when constructing a Disbursement.
  result.use('/api/v1/approvals', createApprovalRouter({ prisma: database, requireAuth: true }));
  return result;
}
async function fixture(label: string, amount = '5.1234', currency = 'USD') {
  const id = prefix + '-' + ++serial + '-' + label, operatorId = id + '-finance', leaderId = id + '-leader', departmentId = id + '-department';
  await db().userAccount.create({ data: { id: leaderId, displayName: 'Synthetic supplier approval leader', status: 'active' } });
  await db().department.create({ data: { id: departmentId, name: id, headId: leaderId } });
  await db().userAccount.update({ where: { id: leaderId }, data: { primaryDeptId: departmentId } });
  await db().userAccount.create({ data: { id: operatorId, displayName: 'Synthetic procurement/finance operator', status: 'active', primaryDeptId: departmentId } });
  for (const [userId, canonical] of [[operatorId, 'role-finance'], [leaderId, 'role-admin']]) {
    const roleId = userId + '-configured';
    await db().role.upsert({ where: { id: canonical }, update: {}, create: { id: canonical, name: canonical, isSystem: true } });
    await db().role.create({ data: { id: roleId, name: 'Synthetic explicit supplier test capabilities', isSystem: false } });
    for (const bound of [canonical, roleId]) await db().userRole.create({ data: { id: userId + '-' + bound, userId, roleId: bound, departmentId } });
    // Do not change grants on shared canonical roles: other files in the same
    // isolated cluster may test defaults or revocation against those roles.
    for (const scope of scopes) {
      const permission = await db().permission.upsert({ where: { scope }, update: {}, create: { id: prefix + '-permission-' + scope, scope } });
      await db().rolePermission.create({ data: { id: userId + '-' + scope, roleId, permissionId: permission.id } });
    }
  }
  const token = async (userId: string) => {
    const context = await createPermissionService({ prisma: db() }).getUserPermissionContext(userId);
    expect(context).not.toBeNull(); expect(context!.scopes).toEqual(expect.arrayContaining(scopes));
    return createAuthService().signToken({ userId, roles: context!.legacyRoleCodes, roleIds: context!.roleIds,
      departmentIds: context!.departmentIds, permissions: context!.scopes, authorizationLoaded: true });
  };
  const operatorToken = await token(operatorId), leaderToken = await token(leaderId), now = BigInt(Date.now());
  const supplier = await db().relation.create({ data: { id: id + '-supplier', name: 'Synthetic ' + label + ' supplier', category: 'Supplier', type: 'Organization',
    isOrganization: true, tags: [], contactInfo: '', lastInteraction: now, ownerId: operatorId } });
  const order = await db().order.create({ data: { id: id + '-order', customer: 'Synthetic source order', product: 'Synthetic fabric', type: 'Fabric', quantity: 10,
    status: 'Pending', dueDate: '2026-11-01', quoteAmount: amount, currency, ownerId: operatorId } });
  const po = await db().purchaseOrder.create({ data: { id: id + '-po', poNumber: id + '-po', status: 'Received', supplierRelationId: supplier.id,
    supplierName: supplier.name, orderId: order.id, currency, totalAmount: amount, orderDate: '2026-10-01', createdAt: now, updatedAt: now } });
  const receipt = await db().materialReceipt.create({ data: { id: id + '-material-receipt', receiptNumber: id + '-material-receipt', purchaseOrderId: po.id,
    status: 'Rejected', receivedDate: '2026-10-01', totalReceived: '10', totalAccepted: '0', totalRejected: '10', createdAt: now } });
  return { id, operatorId, leaderId, operatorToken, leaderToken, supplier, po, receipt, amount, currency, returnId: '', invoiceId: '', app: app() };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function post(f: Fixture, path: string, body: any = {}, application = f.app, token = f.operatorToken) {
  return request(application).post('/api/v1/' + path).set('Authorization', 'Bearer ' + token).send(body);
}
async function create(f: Fixture, application = f.app) {
  const response = await post(f, 'procurement/material-returns', { receiptId: f.receipt.id, type: 'claim', quantity: 0, amount: f.amount,
    currency: f.currency, reason: 'Synthetic independently confirmed supplier claim', actorId: 'untrusted-body-actor' }, application);
  expect(response.status, diagnostic(response.body)).toBe(200);
  f.returnId = response.body.materialReturn.id;
  expect(await db().materialReturn.findUniqueOrThrow({ where: { id: f.returnId } })).toMatchObject({ type: 'claim', status: 'pending', claimInvoiceId: null });
}
async function ship(f: Fixture, application = f.app) {
  const response = await post(f, 'procurement/material-returns/' + f.returnId + '/mark-shipped', {}, application);
  expect(response.status, diagnostic(response.body)).toBe(200);
  expect(await db().stockMovement.count({ where: { referenceType: 'MaterialReturn', referenceId: f.returnId } })).toBe(0);
}
async function confirm(f: Fixture, application = f.app) {
  const response = await post(f, 'procurement/material-returns/' + f.returnId + '/confirm', {}, application);
  if (response.status === 200) f.invoiceId = response.body.claimInvoiceId;
  return response;
}
async function confirmed(label: string, amount = '5.1234', currency = 'USD') {
  const f = await fixture(label, amount, currency); await create(f); await ship(f);
  const response = await confirm(f); expect(response.status, diagnostic(response.body)).toBe(200);
  const invoice = await db().invoice.findUniqueOrThrow({ where: { id: f.invoiceId } });
  expect(invoice).toMatchObject({ type: 'Payable', status: 'Issued', customerRelationId: f.supplier.id, currency });
  expect(invoice.amount.toString()).toBe(new Prisma.Decimal(amount).negated().toString());
  expect(invoice.invoiceNumber).toMatch(/^CLM-\d{4}-\d+$/);
  return f;
}
async function incoming(f: Fixture, label: string, amount = f.amount, overrides: Record<string, unknown> = {}) {
  const response = await post(f, 'finance/vouchers', { type: 'Receipt', amount, currency: f.currency, customerRelationId: f.supplier.id,
    customerName: f.supplier.name, paymentDate: '2026-10-01', paymentMethod: 'TT', attachments: { paymentReference: f.id + '-bank-' + label }, ...overrides });
  expect(response.status, diagnostic(response.body)).toBe(201);
  const voucherId = response.body.id as string;
  expect(await db().paymentVoucher.findUniqueOrThrow({ where: { id: voucherId } })).toMatchObject({ type: 'Receipt', status: 'unreconciled' });
  return voucherId;
}
async function outgoing(f: Fixture, amount = f.amount) {
  const made = await post(f, 'payment-requests', { supplierId: f.supplier.id, supplierName: f.supplier.name, totalAmount: amount, currency: f.currency,
    sourceType: 'purchase_order', sourceId: f.po.id, remark: 'Legitimate outgoing supplier control; never the incoming refund' });
  expect(made.status, diagnostic(made.body)).toBe(201);
  const approvalId = made.body.approvalRequestId, requestId = made.body.paymentRequest.id;
  expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ status: 'pending', reviewerId: f.leaderId, requesterId: f.operatorId });
  const decided = await post(f, 'approvals/' + approvalId + '/decide', { status: 'approved', decisionNote: 'Actual assigned synthetic leader approved the outgoing control' }, f.app, f.leaderToken);
  expect(decided.status, diagnostic(decided.body)).toBe(200);
  expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ status: 'approved' });
  const issued = await post(f, 'payment-requests/' + requestId + '/issue-voucher', { paymentDate: '2026-10-01', paymentMethod: 'TT' });
  expect([200, 201], diagnostic(issued.body)).toContain(issued.status);
  expect(issued.body.voucher).toMatchObject({ type: 'Disbursement', customerRelationId: f.supplier.id, currency: f.currency });
  return issued.body.voucher.id as string;
}
async function allocate(f: Fixture, voucherId: string, appliedAmount = f.amount, invoiceId = f.invoiceId, application = f.app) {
  return post(f, 'finance/allocations', { invoiceId, voucherId, appliedAmount, appliedDate: '2026-10-01', actorId: 'untrusted-body-actor' }, application);
}
const settle = (f: Fixture, application = f.app) => post(f, 'procurement/material-returns/' + f.returnId + '/settle', {}, application);
async function state(f: Fixture) {
  const invoices = await db().invoice.findMany({ where: { customerRelationId: f.supplier.id }, orderBy: { id: 'asc' } });
  const owned = await db().paymentVoucher.findMany({ where: { customerRelationId: f.supplier.id }, select: { id: true } });
  const allocations = await db().invoiceAllocation.findMany({ where: { OR: [{ invoiceId: { in: invoices.map(row => row.id) } }, { voucherId: { in: owned.map(row => row.id) } }] }, orderBy: { id: 'asc' } });
  const vouchers = await db().paymentVoucher.findMany({ where: { id: { in: [...new Set([...owned.map(row => row.id), ...allocations.map(row => row.voucherId)])] } }, orderBy: { id: 'asc' } });
  const ids = [f.returnId, ...invoices.map(row => row.id), ...vouchers.map(row => row.id)];
  ids.push(...allocations.map(row => row.id));
  // Deterministic native keys retain audit evidence after the allocation row
  // itself is withdrawn; an absent row is not erased history.
  ids.push(...invoices.flatMap(invoice => vouchers.map(voucher => `ALLOC__${invoice.id}__${voucher.id}`)));
  return { source: await db().materialReturn.findUniqueOrThrow({ where: { id: f.returnId } }), invoices, vouchers, allocations,
    credits: await db().creditNoteAllocation.findMany({ where: { invoiceId: { in: invoices.map(row => row.id) } }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { targetId: { in: ids } }, orderBy: { id: 'asc' } }),
    links: await db().entityLink.findMany({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] }, orderBy: { id: 'asc' } }),
    references: await db().entityReference.findMany({ where: { OR: [{ ownerId: { in: ids } }, { targetId: { in: ids } }] }, orderBy: { id: 'asc' } }),
  };
}
async function rejected(f: Fixture, operation: () => Promise<any>, status: number, code?: string) {
  const before = await state(f), response = await operation(); expect(response.status, diagnostic(response.body)).toBe(status);
  if (code) expect(response.body.error.code).toBe(code);
  expect(await state(f), 'rejection preserves source, documents, balances, allocations, references and audits').toEqual(before); return response;
}
/** Only corrupt the required audit actor input. Actual PostgreSQL must raise
 * P2003 after real domain changes are staged, and the outer tx must roll back. */
function auditFault(f: Fixture, action: string | ((data: any) => boolean)) {
  const observed: { injections: number; code?: string; staged?: any } = { injections: 0 };
  const database = new Proxy(db(), { get(target, property) {
    if (property === '$transaction') return (callback: any, options?: any) => target.$transaction(tx => callback(new Proxy(tx, { get(client, field) {
      if (field === 'auditLog') return new Proxy(client.auditLog, { get(delegate, method) {
        if (method === 'create') return async (args: any) => {
          if (typeof action === 'string' ? args.data.action !== action : !action(args.data)) return delegate.create(args);
          observed.injections++;
          const source = await client.materialReturn.findUniqueOrThrow({ where: { id: f.returnId } });
          observed.staged = { status: source.status, claimInvoiceId: source.claimInvoiceId,
            invoices: await client.invoice.findMany({ where: { customerRelationId: f.supplier.id }, select: { id: true, status: true } }),
            allocations: await client.invoiceAllocation.count({ where: { invoiceId: f.invoiceId || source.claimInvoiceId || '-absent-' } }) };
          try { return await delegate.create({ ...args, data: { ...args.data, actorId: prefix + '-missing-actor' } }); }
          catch (error: any) { observed.code = error.code; throw error; }
        };
        const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
      } });
      const value = Reflect.get(client, field); return typeof value === 'function' ? value.bind(client) : value;
    } })), options);
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { database, observed };
}

describe.sequential('native supplier claim negative payable, incoming settlement and exact-source closure in isolated PG', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || ''), name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME,
      directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1'); expect(url.pathname).toBe('/' + name);
    expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/); expect(url.port).toBe(port); expect(Boolean(directory)).toBe(true);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRawUnsafe<Array<{ name: string; directory: string; port: number }>>(
      "SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port");
    expect(identity, 'verify actual independent cluster BEFORE ANY fixture mutation').toEqual([{ name, directory, port: Number(port) }]);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('SCS01 native create→ship→supplier confirm→actual Receipt partial/full allocations→Paid→claim closure preserves signed debt and actual-actor audits', async () => {
    const f = await confirmed('full-native-chain'), first = await incoming(f, 'partial', '2.1234'), second = await incoming(f, 'balance', '3');
    expect((await allocate(f, first, '2.1234')).status).toBe(201);
    expect(await db().invoice.findUniqueOrThrow({ where: { id: f.invoiceId } })).toMatchObject({ status: 'PartiallyPaid' });
    await rejected(f, () => settle(f), 409, 'INVALID_STATE');
    const final = await allocate(f, second, '3'); expect(final.status, diagnostic(final.body)).toBe(201); expect(final.body.newInvoiceStatus).toBe('Paid');
    const closed = await settle(f); expect(closed.status, diagnostic(closed.body)).toBe(200);
    const after = await state(f); expect(after.source).toMatchObject({ status: 'settled', claimInvoiceId: f.invoiceId });
    expect(after.invoices[0].amount.toString()).toBe('-5.1234'); expect(after.invoices[0].status).toBe('Paid');
    expect(after.allocations.map(row => row.appliedAmount).reduce((sum, amount) => sum.plus(amount), new Prisma.Decimal(0)).toString()).toBe('5.1234');
    expect(after.audits.filter(row => row.action === 'create_allocation')).toHaveLength(2);
    for (const action of ['create_material_return', 'mark_shipped_material_return', 'confirm_material_return', 'settle_material_return']) {
      const audits = after.audits.filter(row => row.action === action); expect(audits).toHaveLength(1); expect(audits[0].actorId).toBe(f.operatorId);
    }
    expect((after.audits.find(row => row.action === 'settle_material_return')!.detail as any).after.supplierClaimSettlement).toMatchObject({ invoiceId: f.invoiceId, amount: '5.1234', allocationIds: expect.arrayContaining(after.allocations.map(row => row.id)) });
    await rejected(f, () => settle(f), 409, 'INVALID_STATUS');
    await rejected(f, () => post(f, 'procurement/material-returns/' + f.returnId + '/cancel'), 409, 'INVALID_STATUS');
  });
  it('SCS02 confirmed but unpaid claim cannot close; a corrupted Paid projection does not substitute for cash allocation facts', async () => {
    const f = await confirmed('unpaid-projection'); await rejected(f, () => settle(f), 409, 'INVALID_STATE');
    // Explicit post-native corruption, not a valid Paid fixture or positive.
    await db().invoice.update({ where: { id: f.invoiceId }, data: { status: 'Paid' } });
    await rejected(f, () => settle(f), 409, 'INVALID_STATE');
  });
  it('SCS03 valid approved outgoing supplier Disbursement cannot settle a negative Payable merely because its amount is sufficient', async () => {
    const f = await confirmed('outgoing-direction'), voucher = await outgoing(f);
    await rejected(f, () => allocate(f, voucher), 409, 'ALLOCATION_DIRECTION_MISMATCH');
    await rejected(f, () => settle(f), 409, 'INVALID_STATE');
  });
  for (const [type, amount, correct, wrong] of [
    ['Receivable', '5.1234', 'Receipt', 'Disbursement'], ['Payable', '5.1234', 'Disbursement', 'Receipt'],
  ] as const) it('SCS04 native signed ' + type + ' ' + amount + ' uses ' + correct + ' and rejects ' + wrong, async () => {
    const f = await confirmed('direction-' + type + '-' + amount);
    const invoice = await post(f, 'finance', { invoiceNumber: f.id + '-direction-invoice', type, status: 'Issued', amount, currency: f.currency,
      customerRelationId: f.supplier.id, customerName: f.supplier.name, issueDate: '2026-10-01' });
    expect(invoice.status, diagnostic(invoice.body)).toBe(201);
    const receive = await incoming(f, 'direction'), pay = await outgoing(f);
    const wrongVoucher = wrong === 'Receipt' ? receive : pay, rightVoucher = correct === 'Receipt' ? receive : pay;
    await rejected(f, () => allocate(f, wrongVoucher, f.amount, invoice.body.id), 409, 'ALLOCATION_DIRECTION_MISMATCH');
    const result = await allocate(f, rightVoucher, f.amount, invoice.body.id); expect(result.status, diagnostic(result.body)).toBe(201);
    expect(await db().invoice.findUniqueOrThrow({ where: { id: invoice.body.id } })).toMatchObject({ status: 'Paid', type });
    expect((await db().invoice.findUniqueOrThrow({ where: { id: invoice.body.id } })).amount.toString()).toBe(amount);
  });
  it('SCS04b generic HTTP has no native negative Receivable issuance outlet; it rejects rather than hand-creating a valid historical credit', async () => {
    const f = await confirmed('negative-receivable-boundary');
    await rejected(f, () => post(f, 'finance', { invoiceNumber: f.id + '-negative-receivable', type: 'Receivable', status: 'Issued', amount: '-5.1234',
      currency: f.currency, customerRelationId: f.supplier.id, customerName: f.supplier.name, issueDate: '2026-10-01' }), 400, 'INVALID_AMOUNT');
    // The -Receivable kernel branch needs an independently valid historic
    // source; this actual-entry probe does not invent that missing creation path.
  });
  it('SCS05 over-allocation and currency mismatch reject without partial financial/source/audit changes', async () => {
    const f = await confirmed('over-currency'), receipt = await incoming(f, 'large', '10'), foreign = await incoming(f, 'foreign-currency', f.amount, { currency: 'EUR' });
    await rejected(f, () => allocate(f, receipt, '5.1235'), 400, 'AMOUNT_EXCEEDS_INVOICE');
    await rejected(f, () => allocate(f, foreign), 400, 'CURRENCY_MISMATCH');
    expect((await allocate(f, receipt, '4')).status).toBe(201);
    const other = await incoming(f, 'second', '2'); await rejected(f, () => allocate(f, other, '2'), 400, 'AMOUNT_EXCEEDS_INVOICE_REMAINING');
  });
  it('SCS06 unpaid native credit cancellation releases only the current source, preserves confirmation history and can be confirmed again', async () => {
    const f = await confirmed('cancel-reconfirm'), old = f.invoiceId;
    const cancelled = await post(f, 'finance/' + old + '/cancel', { reason: 'Explicit reconfirmation correction' }); expect(cancelled.status, diagnostic(cancelled.body)).toBe(200);
    expect(await db().materialReturn.findUniqueOrThrow({ where: { id: f.returnId } })).toMatchObject({ status: 'shipped', claimInvoiceId: null });
    expect(await db().invoice.findUniqueOrThrow({ where: { id: old } })).toMatchObject({ status: 'Cancelled' });
    const again = await confirm(f); expect(again.status, diagnostic(again.body)).toBe(200); expect(f.invoiceId).not.toBe(old);
    expect(await db().auditLog.count({ where: { targetId: f.returnId, action: 'confirm_material_return' } })).toBe(2);
    expect(await db().auditLog.count({ where: { targetId: f.returnId, action: 'cancel_invoice_release_supplier_claim', actorId: f.operatorId } })).toBe(1);
    const receipt = await incoming(f, 'new-current'); expect((await allocate(f, receipt)).status).toBe(201); expect((await settle(f)).status).toBe(200);
    expect(await db().invoice.findUniqueOrThrow({ where: { id: old } })).toMatchObject({ status: 'Cancelled' });
  });
  it('SCS07 allocated supplier credit cannot be cancelled to detach a real settlement or create a second payable claim', async () => {
    const f = await confirmed('allocated-cancel'), receipt = await incoming(f, 'partial'); expect((await allocate(f, receipt, '1')).status).toBe(201);
    const before = await state(f), response = await post(f, 'finance/' + f.invoiceId + '/cancel', { reason: 'Would destroy an actual allocation' });
    expect(response.status, diagnostic(response.body)).toBe(409); expect(await state(f)).toEqual(before);
    await rejected(f, () => confirm(f), 409, 'INVALID_STATUS');
  });
  it('SCS08 two actual simultaneous confirmations issue one negative payable and one native confirmation audit', async () => {
    const f = await fixture('concurrent-confirm'); await create(f); await ship(f);
    const results = await Promise.all([confirm(f), confirm(f)]); expect(results.map(row => row.status).sort()).toEqual([200, 409]);
    expect(await db().invoice.count({ where: { customerRelationId: f.supplier.id } })).toBe(1);
    expect(await db().auditLog.count({ where: { targetId: f.returnId, action: 'confirm_material_return' } })).toBe(1);
    expect((await db().materialReturn.findUniqueOrThrow({ where: { id: f.returnId } })).claimInvoiceId).toBe(f.invoiceId);
  });
  it('SCS09 concurrent HTTP Receipt allocations cannot consume the same invoice balance twice; the remaining exact amount remains settleable', async () => {
    const f = await confirmed('http-concurrent'), receipts = [await incoming(f, 'one'), await incoming(f, 'two')];
    const results = await Promise.all(receipts.map(id => allocate(f, id, '3'))); expect(results.filter(row => row.status === 201)).toHaveLength(1);
    expect([400, 409]).toContain(results.find(row => row.status !== 201)!.status);
    const allocations = await db().invoiceAllocation.findMany({ where: { invoiceId: f.invoiceId } }); expect(allocations).toHaveLength(1); expect(allocations[0].appliedAmount.toString()).toBe('3');
    const loser = receipts.find(id => id !== allocations[0].voucherId)!; expect((await allocate(f, loser, '2.1234')).status).toBe(201);
    expect((await settle(f)).status).toBe(200);
  });
  it('SCS10 common native kernel also preserves invoice balance in an external ReadCommitted transaction, independently of HTTP Serializable', async () => {
    const f = await confirmed('external-read-committed'), receipts = [await incoming(f, 'one'), await incoming(f, 'two')];
    const results = await Promise.allSettled(receipts.map(voucherId => db().$transaction(tx => applyAllocation(db(), tx, { invoiceId: f.invoiceId, voucherId, appliedAmount: '3',
      appliedDate: '2026-10-01', actorId: f.operatorId, source: 'acceptance:supplier-external-transaction' }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })));
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    const refusal = results.find(row => row.status === 'rejected') as PromiseRejectedResult; expect(refusal.reason.code).toBe('AMOUNT_EXCEEDS_INVOICE_REMAINING');
    const allocations = await db().invoiceAllocation.findMany({ where: { invoiceId: f.invoiceId } }); expect(allocations).toHaveLength(1); expect(allocations[0].appliedAmount.toString()).toBe('3');
    expect(await db().auditLog.count({ where: { targetId: allocations[0].id, action: 'create_allocation' } })).toBe(1);
  });
  it('SCS11 real mandatory confirmation audit FK failure rolls back the newly staged invoice and source projection', async () => {
    const f = await fixture('confirmation-sql-fault'); await create(f); await ship(f); const fault = auditFault(f, 'confirm_material_return');
    await rejected(f, () => confirm(f, app(fault.database)), 500, 'CONFIRM_FAILED'); expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { status: 'confirmed' } });
    expect(fault.observed.staged.invoices).toHaveLength(1); expect(await db().invoice.count({ where: { customerRelationId: f.supplier.id } })).toBe(0);
  });
  it('SCS12 real mandatory allocation audit FK failure rolls back cash allocation, invoice Paid and voucher projection', async () => {
    const f = await confirmed('allocation-sql-fault'), receipt = await incoming(f, 'real'), fault = auditFault(f, 'create_allocation');
    await rejected(f, () => allocate(f, receipt, f.amount, f.invoiceId, app(fault.database)), 500, 'CREATE_FAILED');
    expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { allocations: 1 } }); expect(fault.observed.staged.invoices[0].status).toBe('Paid');
  });
  it('SCS13 real mandatory closure audit FK failure restores confirmed source while preserving already committed Paid settlement facts', async () => {
    const f = await confirmed('closure-sql-fault'), receipt = await incoming(f, 'real'); expect((await allocate(f, receipt)).status).toBe(201);
    const fault = auditFault(f, 'settle_material_return'); await rejected(f, () => settle(f, app(fault.database)), 500, 'SETTLE_FAILED');
    expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { status: 'settled', allocations: 1 } }); expect((await settle(f)).status).toBe(200);
  });
  it('SCS14 real mandatory source-release audit FK failure keeps the original invoice and exact source linked', async () => {
    const f = await confirmed('cancel-sql-fault'), fault = auditFault(f, 'cancel_invoice_release_supplier_claim');
    await rejected(f, () => post(f, 'finance/' + f.invoiceId + '/cancel', { reason: 'Real SQL mandatory-audit fault' }, app(fault.database)), 500, 'CANCEL_FAILED');
    expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { status: 'shipped', claimInvoiceId: null } });
  });
  it('SCS15 same supplier/currency/amount Paid invoice from a different real claim cannot substitute for the current source', async () => {
    const f = await confirmed('wrong-exact-source'), original = f.invoiceId;
    // Form the second source and its financial fact through actual native routes.
    const created = await post(f, 'procurement/material-returns', { receiptId: f.receipt.id, type: 'claim', quantity: 0, amount: f.amount, currency: f.currency, reason: 'Different actual claim' });
    expect(created.status, diagnostic(created.body)).toBe(200); const otherId = created.body.materialReturn.id;
    expect((await post(f, 'procurement/material-returns/' + otherId + '/mark-shipped')).status).toBe(200);
    const another = await post(f, 'procurement/material-returns/' + otherId + '/confirm'); expect(another.status).toBe(200);
    const receipt = await incoming(f, 'other-case'); expect((await allocate(f, receipt, f.amount, another.body.claimInvoiceId)).status).toBe(201);
    // Explicit damaged historical FK; never a positive/approved fixture.
    await db().materialReturn.update({ where: { id: f.returnId }, data: { claimInvoiceId: another.body.claimInvoiceId } });
    await rejected(f, () => settle(f), 409, 'SOURCE_CLAIM_CONFLICT');
    expect((await db().invoice.findUniqueOrThrow({ where: { id: original } })).status).toBe('Issued');
  });
  it('SCS16 settled claim withdrawal reopens confirmed in the same tx, preserves historical settlement and can be paid/settled again through native entries', async () => {
    const f = await confirmed('withdraw-reopen'), receipt = await incoming(f, 'actual'); const allocation = await allocate(f, receipt);
    expect(allocation.status).toBe(201); expect((await settle(f)).status).toBe(200);
    const old = await state(f), id = allocation.body.allocation.id;
    const removed = await request(f.app).delete('/api/v1/finance/allocations/' + id).set('Authorization', 'Bearer ' + f.operatorToken);
    expect(removed.status, diagnostic(removed.body)).toBe(200);
    const after = await state(f); expect(after.source).toMatchObject({ status: 'confirmed', claimInvoiceId: f.invoiceId });
    expect(after.invoices[0].status).toBe('Issued'); expect(after.allocations).toEqual([]); expect(after.vouchers[0].status).toBe('unreconciled');
    const oldSettled = old.audits.filter(row => row.action === 'settle_material_return'); expect(oldSettled).toHaveLength(1);
    expect(after.audits.find(row => row.id === oldSettled[0].id)).toEqual(oldSettled[0]);
    const invalidation = after.audits.filter(row => !old.audits.some(previous => previous.id === row.id) && row.targetType === 'MaterialReturn');
    expect(invalidation).toHaveLength(1); expect(invalidation[0]).toMatchObject({ actorId: f.operatorId, action: 'invalidate_material_return_settlement' });
    expect((invalidation[0].detail as any).before).toMatchObject({ status: 'settled' }); expect((invalidation[0].detail as any).after).toMatchObject({ status: 'confirmed' });
    expect((invalidation[0].detail as any).after).toMatchObject({ reason: 'allocation_basis_changed', triggerId: id, appliedAmount: '0' });
    expect((await allocate(f, receipt)).status).toBe(201); expect((await settle(f)).status).toBe(200);
    expect(await db().auditLog.count({ where: { targetType: 'MaterialReturn', targetId: f.returnId, action: 'settle_material_return' } })).toBe(2);
  });
  it('SCS17 reducing real settled cash allocation reopens the claim; completing the missing balance permits a second exact settlement', async () => {
    const f = await confirmed('reduced-reopen'), receipt = await incoming(f, 'actual'), allocation = await allocate(f, receipt);
    expect(allocation.status).toBe(201); expect((await settle(f)).status).toBe(200);
    const reduced = await request(f.app).patch('/api/v1/finance/allocations/' + allocation.body.allocation.id).set('Authorization', 'Bearer ' + f.operatorToken).send({ appliedAmount: '4' });
    expect(reduced.status, diagnostic(reduced.body)).toBe(200);
    expect(await db().materialReturn.findUniqueOrThrow({ where: { id: f.returnId } })).toMatchObject({ status: 'confirmed', claimInvoiceId: f.invoiceId });
    expect(await db().invoice.findUniqueOrThrow({ where: { id: f.invoiceId } })).toMatchObject({ status: 'PartiallyPaid' });
    await rejected(f, () => settle(f), 409, 'INVALID_STATE');
    const remaining = await incoming(f, 'remaining', '1.1234'); expect((await allocate(f, remaining, '1.1234')).status).toBe(201); expect((await settle(f)).status).toBe(200);
    expect(await db().auditLog.count({ where: { targetId: f.returnId, action: 'settle_material_return' } })).toBe(2);
  });
  it('SCS18 mandatory reopening audit SQL FK failure rolls back allocation withdrawal, source invalidation and all accounting projections', async () => {
    const f = await confirmed('reopening-sql-fault'), receipt = await incoming(f, 'actual'), allocation = await allocate(f, receipt);
    expect(allocation.status).toBe(201); expect((await settle(f)).status).toBe(200);
    const fault = auditFault(f, 'invalidate_material_return_settlement'), before = await state(f);
    const response = await request(app(fault.database)).delete('/api/v1/finance/allocations/' + allocation.body.allocation.id).set('Authorization', 'Bearer ' + f.operatorToken);
    expect(response.status, diagnostic(response.body)).toBe(500); expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { status: 'confirmed' } });
    expect(await state(f)).toEqual(before);
  });
  it('SCS19 allocated actual Receipt identity/direction/value cannot be edited; date/notes leave settlement valid and facts can be corrected after withdrawal', async () => {
    const f = await confirmed('allocated-receipt-facts'), receipt = await incoming(f, 'actual'), allocation = await allocate(f, receipt);
    expect(allocation.status).toBe(201); expect((await settle(f)).status).toBe(200);
    const otherParty = await db().relation.create({ data: { id: f.id + '-other-supplier', name: 'Different real fixture supplier', category: 'Supplier', type: 'Organization',
      isOrganization: true, tags: [], contactInfo: '', lastInteraction: BigInt(Date.now()), ownerId: f.operatorId } });
    for (const body of [{ type: 'Disbursement' }, { currency: 'EUR' }, { customerRelationId: otherParty.id }, { orderId: f.po.orderId }, { invoiceId: null }, { amount: '1' }]) {
      const before = await state(f), response = await request(f.app).patch('/api/v1/finance/vouchers/' + receipt).set('Authorization', 'Bearer ' + f.operatorToken).send(body);
      expect(response.status, diagnostic({ body, response: response.body })).toBe(409); expect(await state(f)).toEqual(before);
    }
    const note = await request(f.app).patch('/api/v1/finance/vouchers/' + receipt).set('Authorization', 'Bearer ' + f.operatorToken).send({ notes: 'Financial clerk note', paymentDate: '2026-10-02' });
    expect(note.status, diagnostic(note.body)).toBe(200); expect((await db().materialReturn.findUniqueOrThrow({ where: { id: f.returnId } })).status).toBe('settled');
    expect((await request(f.app).delete('/api/v1/finance/allocations/' + allocation.body.allocation.id).set('Authorization', 'Bearer ' + f.operatorToken)).status).toBe(200);
    const corrected = await request(f.app).patch('/api/v1/finance/vouchers/' + receipt).set('Authorization', 'Bearer ' + f.operatorToken).send({ amount: '4' });
    expect(corrected.status, diagnostic(corrected.body)).toBe(200); expect((await db().materialReturn.findUniqueOrThrow({ where: { id: f.returnId } })).status).toBe('confirmed');
    expect((await allocate(f, receipt, '4')).status).toBe(201); const remainder = await incoming(f, 'corrected-balance', '1.1234');
    expect((await allocate(f, remainder, '1.1234')).status).toBe(201); expect((await settle(f)).status).toBe(200);
  });
  it('SCS20 a third-party incoming receipt may be audited by finance but does not silently become the exact supplier refund needed to close this claim', async () => {
    const f = await confirmed('supplier-party'), other = await db().relation.create({ data: { id: f.id + '-other', name: 'Another party', category: 'Supplier', type: 'Organization',
      isOrganization: true, tags: [], contactInfo: '', lastInteraction: BigInt(Date.now()), ownerId: f.operatorId } });
    const receipt = await incoming(f, 'third-party', f.amount, { customerRelationId: other.id, customerName: other.name });
    const allocation = await allocate(f, receipt); expect(allocation.status, diagnostic(allocation.body)).toBe(201);
    // DR-016's customer third-party payment flag explicitly excludes Payable.
    // Preserve actual payer identity and mandatory allocation audit instead.
    expect(allocation.body.thirdPartyPayment).toBeNull();
    const recorded = await db().invoiceAllocation.findUniqueOrThrow({ where: { invoiceId_voucherId: { invoiceId: f.invoiceId, voucherId: receipt } } });
    const audit = await db().auditLog.findFirstOrThrow({ where: { targetType: 'InvoiceAllocation', targetId: recorded.id, action: 'create_allocation' } });
    expect(audit.actorId).toBe(f.operatorId);
    expect((audit.detail as any).after).toMatchObject({ invoiceId: f.invoiceId, voucherId: receipt });
    expect((await db().paymentVoucher.findUniqueOrThrow({ where: { id: receipt } })).customerRelationId).toBe(other.id);
    await rejected(f, () => settle(f), 409, 'SOURCE_CLAIM_CONFLICT');
  });
  it('SCS23 updating a migrated allocation returns and audits the persisted row identity', async () => {
    const f = await confirmed('legacy-allocation-id'), receipt = await incoming(f, 'receipt');
    expect((await allocate(f, receipt, '1')).status).toBe(201);
    const formed = await db().invoiceAllocation.findUniqueOrThrow({ where: { invoiceId_voucherId: { invoiceId: f.invoiceId, voucherId: receipt } } });
    // Controlled migration fixture: only the preexisting row key is different.
    // The new native mutation must record its own audit under that actual key.
    const migratedId = f.id + '-legacy-allocation';
    await db().invoiceAllocation.update({ where: { id: formed.id }, data: { id: migratedId } });
    const changed = await allocate(f, receipt, '2');
    expect(changed.status, diagnostic(changed.body)).toBe(201);
    expect(changed.body.allocation.id).toBe(migratedId);
    const audit = await db().auditLog.findUniqueOrThrow({ where: { id: changed.body.auditId } });
    expect(audit.targetId).toBe(migratedId);expect((audit.detail as any).after.id).toBe(migratedId);
    expect((await db().invoiceAllocation.findUniqueOrThrow({ where: { id: migratedId } })).appliedAmount.toString()).toBe('2');
    expect(await db().invoiceAllocation.count({ where: { invoiceId: f.invoiceId, voucherId: receipt } })).toBe(1);
  });
});
