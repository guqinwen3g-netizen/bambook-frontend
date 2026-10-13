/**
 * Isolated replacement for the retired live credit-note settlement drill.
 *
 * CN01 and CN08 trace supplier claims into the current invoice model. CN02-07
 * preserve actual positive/negative Invoice ledger controls previously checked
 * by the live script and negativeCreditInvoiceSettle tests. Those Paid controls
 * are LEGACY LEDGER compatibility evidence, not fulfillment of 9/17 A3/A4:
 * docs/业务口径决策单-2026-09-17.md:106-113,301-303 requires an independent refund
 * lifecycle and symmetric payable behavior, rather than Invoice Paid.
 * CN08 is a business-red probe of confirmed A5 (:115-118,304): revocation must
 * remove the live source link, roll back the source projection and audit it.
 * The exact replacement source status is deliberately not invented here.
 * Each variant has independent sources: no raw deletion to prepare later cases,
 * no company credentials, fixed-port HTTP, seed, shared DB or manual cleanup.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createFinanceRouter } from '../src/finance/route';
import { createFinanceV2Router } from '../src/finance/routeV2';
import { createMaterialReturnService } from '../src/procurement/materialReturnService';
import { applyAllocation, recalcInvoiceStatus } from '../src/finance/allocationService';

const prefix = `acceptance-credit-note-${randomUUID()}`;
let prisma: PrismaClient | undefined;
let sequence = 0;
let operator: { id: string; token: string };
const db = () => { if (!prisma) throw new Error('isolated credit-note fixture not initialized'); return prisma; };
const nextId = (label: string) => `${prefix}-${++sequence}-${label}`;

async function makeOperator() {
  const id = nextId('operator');
  const roleId = `${id}-configured`;
  const scopes = ['finance:read', 'invoices:read', 'invoices:write', 'invoices:reconcile'];
  await db().$transaction(async tx => {
    // Canonical finance determines the existing data-scope posture; authority
    // to operate comes from explicit fixture RolePermission rows, not defaults.
    await tx.role.upsert({ where: { id: 'role-finance' }, update: {}, create: { id: 'role-finance', name: 'Finance', isSystem: true } });
    await tx.role.create({ data: { id: roleId, name: 'Synthetic credit-note operator', isSystem: false } });
    await tx.userAccount.create({ data: { id, displayName: 'Synthetic credit-note operator', status: 'active' } });
    for (const currentRole of ['role-finance', roleId]) await tx.userRole.create({ data: { id: `${id}-${currentRole}`, userId: id, roleId: currentRole } });
    for (const scope of scopes) {
      const permission = await tx.permission.upsert({ where: { scope }, update: {}, create: { id: `${prefix}-permission-${scope}`, scope } });
      await tx.rolePermission.create({ data: { id: `${id}-${scope}`, roleId, permissionId: permission.id } });
    }
  });
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(id);
  expect(current, 'actual DB-loaded active operator before any business request').not.toBeNull();
  for (const scope of scopes) expect(current!.scopes).toContain(scope);
  return { id, token: createAuthService().signToken({ userId: id, roles: current!.legacyRoleCodes,
    roleIds: current!.roleIds, departmentIds: current!.departmentIds, permissions: current!.scopes, authorizationLoaded: true }) };
}

function app(database: PrismaClient = db()) {
  const result = express();
  result.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? Number(value) : value);
  result.use(express.json());
  result.use(createAccountStatusGuard(db()));
  result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  result.use('/api/v2/finance', createFinanceV2Router({ prisma: db(), requireAuth: true, apiKeys: new Set() }));
  result.use('/api/v1/finance', createFinanceRouter({ prisma: database, requireAuth: true, apiKeys: new Set() }));
  return result;
}
async function payableSummary() {
  const response = await request(app()).get('/api/v2/finance/summary').set('Authorization', `Bearer ${operator.token}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(typeof response.body.payable?.total).toBe('number');
  expect(Number.isFinite(response.body.payable.total)).toBe(true);
  expect(Number.isSafeInteger(response.body.payable.count)).toBe(true);
  return response.body.payable as { total: number; count: number };
}

async function pair(label: string, invoiceAmount: string, voucherAmount: string, currency = 'USD') {
  const id = nextId(label);
  const now = BigInt(Date.now());
  const invoiceId = `${id}-invoice`;
  const voucherId = `${id}-voucher`;
  await db().$transaction(async tx => {
    await tx.invoice.create({ data: { id: invoiceId, invoiceNumber: invoiceId, type: 'Payable', status: 'Issued', amount: invoiceAmount,
      currency, issueDate: '2026-10-01', customerName: 'Synthetic credit-note supplier', ownerId: operator.id, createdAt: now, updatedAt: now } });
    await tx.paymentVoucher.create({ data: { id: voucherId, voucherNumber: voucherId,
      type: invoiceAmount.startsWith('-') ? 'Receipt' : 'Disbursement', amount: voucherAmount, currency, paymentDate: '2026-10-01',
      paymentMethod: 'TT', status: 'unreconciled', customerName: 'Synthetic credit-note supplier', ownerId: operator.id, createdAt: now, updatedAt: now } });
  });
  return { invoiceId, voucherId };
}
type Pair = Awaited<ReturnType<typeof pair>>;
async function allocate(item: Pair, amount: string) {
  return db().$transaction(tx => applyAllocation(tx, db(), { invoiceId: item.invoiceId, voucherId: item.voucherId,
    appliedAmount: amount, actorId: operator.id, source: 'acceptance:isolated-credit-note-ledger' }));
}
async function pairState(item: Pair) {
  return {
    invoice: await db().invoice.findUniqueOrThrow({ where: { id: item.invoiceId } }),
    voucher: await db().paymentVoucher.findUniqueOrThrow({ where: { id: item.voucherId } }),
    allocations: await db().invoiceAllocation.findMany({ where: { OR: [{ invoiceId: item.invoiceId }, { voucherId: item.voucherId }] }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: operator.id }, orderBy: { id: 'asc' } }),
    links: await db().entityLink.findMany({ where: { OR: [{ fromId: { in: [item.invoiceId, item.voucherId] } }, { toId: { in: [item.invoiceId, item.voucherId] } }] }, orderBy: { id: 'asc' } }),
    references: await db().entityReference.findMany({ where: { OR: [{ ownerId: { in: [item.invoiceId, item.voucherId] } }, { targetId: { in: [item.invoiceId, item.voucherId] } }] }, orderBy: { id: 'asc' } }),
  };
}

async function confirmedSupplierClaim(label: string, amount = '5000', currency = 'USD') {
  const id = nextId(label);
  const relationId = `${id}-supplier`;
  const poId = `${id}-po`;
  const receiptId = `${id}-receipt`;
  const returnId = `${id}-return`;
  const now = BigInt(Date.now());
  await db().$transaction(async tx => {
    await tx.relation.create({ data: { id: relationId, name: `Synthetic ${label}`, category: 'Supplier', type: 'Organization',
      isOrganization: true, tags: [], contactInfo: '', lastInteraction: now, ownerId: operator.id } });
    await tx.purchaseOrder.create({ data: { id: poId, poNumber: poId, status: 'Received', supplierRelationId: relationId,
      supplierName: `Synthetic ${label}`, currency, totalAmount: amount, orderDate: '2026-10-01', createdAt: now, updatedAt: now } });
    await tx.materialReceipt.create({ data: { id: receiptId, receiptNumber: receiptId, purchaseOrderId: poId, status: 'Rejected',
      receivedDate: '2026-10-01', totalReceived: '10', totalAccepted: '0', totalRejected: '10', createdAt: now } });
    // The acceptance target here is supplier confirmation; creating an already
    // shipped claim is a fixture, not proof of UI/create/shipping earlier stages.
    await tx.materialReturn.create({ data: { id: returnId, returnNumber: returnId, receiptId, purchaseOrderId: poId,
      supplierRelationId: relationId, supplierName: `Synthetic ${label}`, type: 'claim', status: 'shipped',
      quantity: '0', amount, currency, reason: 'Independent isolated supplier-claim confirmation', createdAt: now, updatedAt: now } });
  });
  const result = await createMaterialReturnService(db()).confirmReturn(returnId, operator.id);
  expect(result.ok, JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).toBe(true);
  const invoiceId = (result as any).data.claimInvoiceId as string;
  expect(typeof invoiceId).toBe('string');
  return { returnId, invoiceId, relationId, amount, currency };
}

describe.sequential('isolated supplier credit-note source and legacy settlement controls', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    const name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME;
    const directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR;
    const port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true);
    expect(url.protocol).toBe('postgresql:');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe(port);
    expect(url.pathname).toBe(`/${name}`);
    expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/);
    expect(Boolean(directory)).toBe(true);
    expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
      SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
    `;
    expect(identity, 'verify actual PG identity BEFORE all fixture mutations').toEqual([{ name, directory, port: Number(port) }]);
    operator = await makeOperator();
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('CN01 actual supplier confirmation creates an exact negative payable and actual-actor source audit', async () => {
    const item = await confirmedSupplierClaim('source-generation');
    const invoice = await db().invoice.findUniqueOrThrow({ where: { id: item.invoiceId } });
    expect(invoice).toMatchObject({ type: 'Payable', status: 'Issued', currency: item.currency, customerRelationId: item.relationId });
    expect(invoice.amount.toString()).toBe('-5000');
    expect(invoice.invoiceNumber).toMatch(/^CLM-\d{4}-\d+$/);
    expect(await db().materialReturn.findUniqueOrThrow({ where: { id: item.returnId } })).toMatchObject({ status: 'confirmed', claimInvoiceId: invoice.id });
    const audits = await db().auditLog.findMany({ where: { action: 'confirm_material_return', targetId: item.returnId } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(operator.id);
    expect((audits[0].detail as any).after).toMatchObject({ status: 'confirmed', claimInvoiceId: invoice.id });
  });

  it('CN02 positive payable control settles to Paid with exact allocation, voucher total and actual-actor audit', async () => {
    const item = await pair('positive-control', '1000', '1000');
    const result = await allocate(item, '1000');
    expect(result.newInvoiceStatus).toBe('Paid');
    const after = await pairState(item);
    expect(after.invoice.status).toBe('Paid');
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0].appliedAmount.toString()).toBe('1000');
    expect(after.voucher.status).toBe('reconciled');
    expect(after.voucher.appliedAmount?.toString()).toBe('1000');
    expect(after.audits.find(row => row.id === result.auditId)).toMatchObject({ actorId: operator.id, action: 'create_allocation' });
  });

  it('CN03 legacy negative payable with no allocation remains Issued and does not settle on creation', async () => {
    const item = await pair('negative-unsettled', '-500', '500');
    const before = await pairState(item);
    expect(await recalcInvoiceStatus(db(), item.invoiceId)).toBe('Issued');
    expect(before.invoice.amount.toString()).toBe('-500');
    expect(before.invoice.status).toBe('Issued');
    expect(before.allocations).toEqual([]);
    expect(await pairState(item)).toEqual(before);
  });

  it('CN04 legacy negative payable full positive allocation reaches Paid without altering its signed amount', async () => {
    const item = await pair('negative-full', '-500', '500');
    const result = await allocate(item, '500');
    expect(result.newInvoiceStatus).toBe('Paid');
    const after = await pairState(item);
    expect(after.invoice.amount.toString()).toBe('-500');
    expect(after.invoice.status).toBe('Paid');
    expect(after.invoice.settlementDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0].appliedAmount.toString()).toBe('500');
    expect(after.voucher.appliedAmount?.toString()).toBe('500');
  });

  it('CN05 legacy negative payable partial positive allocation reaches PartiallyPaid with exact open amount', async () => {
    const item = await pair('negative-partial', '-500', '300');
    const result = await allocate(item, '300');
    expect(result.newInvoiceStatus).toBe('PartiallyPaid');
    const after = await pairState(item);
    expect(after.invoice.status).toBe('PartiallyPaid');
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0].appliedAmount.toString()).toBe('300');
    expect(after.invoice.amount.abs().minus(after.allocations[0].appliedAmount).toString()).toBe('200');
  });

  it('CN06 allocation above absolute negative face value rejects and leaves all PG financial rows unchanged', async () => {
    const item = await pair('negative-overallocation', '-500', '600');
    const before = await pairState(item);
    await expect(allocate(item, '600')).rejects.toMatchObject({ code: 'AMOUNT_EXCEEDS_INVOICE' });
    expect(await pairState(item)).toEqual(before);
  });

  it('CN07 actual V2 payable summary includes equal signed CNY invoices with a zero total delta', async () => {
    const before = await payableSummary();
    const positive = await pair('summary-positive', '5000', '5000', 'CNY');
    const negative = await pair('summary-negative', '-5000', '5000', 'CNY');
    expect((await db().invoice.findUniqueOrThrow({ where: { id: positive.invoiceId } })).currency).toBe('CNY');
    expect((await db().invoice.findUniqueOrThrow({ where: { id: negative.invoiceId } })).currency).toBe('CNY');
    const after = await payableSummary();
    expect(after.count - before.count, 'both signed invoices must actually enter the aggregate, rather than both be invisible').toBe(2);
    expect(after.total - before.total).toBe(0);
    // A single-currency delta does not certify this aggregate for mixed currency.
  });

  it('CN08 confirmed A5: actual cancellation removes the active source link, rolls back its projection and audits the source', async () => {
    const item = await confirmedSupplierClaim('revocation-boundary');
    expect(await db().invoiceAllocation.count({ where: { invoiceId: item.invoiceId } })).toBe(0);
    const sourceBefore = await db().materialReturn.findUniqueOrThrow({ where: { id: item.returnId } });
    expect(sourceBefore).toMatchObject({ status: 'confirmed', claimInvoiceId: item.invoiceId });
    const auditsBefore = await db().auditLog.findMany({ where: { targetType: 'MaterialReturn', targetId: item.returnId }, orderBy: { id: 'asc' } });
    const reason = 'Isolated explicit revocation; source linkage must not claim an active credit';
    const response = await request(app()).post(`/api/v1/finance/${item.invoiceId}/cancel`)
      .set('Authorization', `Bearer ${operator.token}`).send({ reason, actorId: 'body-is-not-actor' });
    const sourceAfter = await db().materialReturn.findUniqueOrThrow({ where: { id: item.returnId } });
    const invoiceAfter = await db().invoice.findUniqueOrThrow({ where: { id: item.invoiceId } });
    const auditsAfter = await db().auditLog.findMany({ where: { targetType: 'MaterialReturn', targetId: item.returnId }, orderBy: { id: 'asc' } });
    const newSourceAudits = auditsAfter.filter(row => !auditsBefore.some(old => old.id === row.id));
    console.log(JSON.stringify({ probe: 'A5-supplier-claim-revocation', http: response.status, errorCode: response.body.error?.code,
      invoiceStatus: invoiceAfter.status, sourceBefore: { status: sourceBefore.status, claimInvoiceId: sourceBefore.claimInvoiceId },
      sourceAfter: { status: sourceAfter.status, claimInvoiceId: sourceAfter.claimInvoiceId },
      newSourceAuditActors: newSourceAudits.map(row => row.actorId), expectation: 'unlink source + rollback source projection + actual actor audit' }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(invoiceAfter.status).toBe('Cancelled');
    expect(sourceAfter.claimInvoiceId, 'A5 cannot leave a live claim pointing to the cancelled credit invoice').toBeNull();
    expect(sourceAfter.status, 'do not invent the new status, but the confirmed projection must roll back').not.toBe('confirmed');
    expect(newSourceAudits.some(row => row.actorId === operator.id), 'A5 requires a new actual-actor audit of the source rollback').toBe(true);
    expect(sourceAfter.status).toBe('shipped');
    const again = await createMaterialReturnService(db()).confirmReturn(item.returnId, operator.id);
    expect(again.ok).toBe(true); const currentInvoiceId = (again as any).data.claimInvoiceId;
    expect(currentInvoiceId).not.toBe(item.invoiceId);
    expect(await db().invoice.findUniqueOrThrow({ where: { id: item.invoiceId } })).toMatchObject({ status: 'Cancelled' });
    expect(await db().materialReturn.findUniqueOrThrow({ where: { id: item.returnId } })).toMatchObject({ status: 'confirmed', claimInvoiceId: currentInvoiceId });
    expect(await db().auditLog.findMany({ where: { action: 'confirm_material_return', targetId: item.returnId } })).toHaveLength(2);
  });
  it('CN09 actual source-release audit SQL FK failure rolls back invoice, source projection and all financial rows', async () => {
    const item = await confirmedSupplierClaim('revocation-audit-fault');
    const before = { invoice: await db().invoice.findUniqueOrThrow({ where: { id: item.invoiceId } }), source: await db().materialReturn.findUniqueOrThrow({ where: { id: item.returnId } }), audits: await db().auditLog.findMany({ where: { targetId: { in: [item.invoiceId, item.returnId] } }, orderBy: { id: 'asc' } }) };
    const fault = new Proxy(db(), { get(target, key) {
      if (key === '$transaction') return (callback: any) => target.$transaction(tx => callback(new Proxy(tx, { get(client, field) {
        if (field === 'auditLog') return new Proxy(client.auditLog, { get(delegate, method) {
          if (method === 'create') return (args: any) => delegate.create(args.data.action === 'cancel_invoice_release_supplier_claim' ? { ...args, data: { ...args.data, actorId: prefix + '-missing-account' } } : args);
          const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
        } });
        const value = Reflect.get(client, field); return typeof value === 'function' ? value.bind(client) : value;
      } })));
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const response = await request(app(fault)).post(`/api/v1/finance/${item.invoiceId}/cancel`).set('Authorization', `Bearer ${operator.token}`).send({ reason: 'actual mandatory audit FK failure' });
    expect(response.status).toBe(500); expect(response.body.error.code).toBe('CANCEL_FAILED'); expect(JSON.stringify(response.body)).not.toContain('Foreign key');
    expect({ invoice: await db().invoice.findUniqueOrThrow({ where: { id: item.invoiceId } }), source: await db().materialReturn.findUniqueOrThrow({ where: { id: item.returnId } }), audits: await db().auditLog.findMany({ where: { targetId: { in: [item.invoiceId, item.returnId] } }, orderBy: { id: 'asc' } }) }).toEqual(before);
  });
  it('CN10 alternate PATCH cancellation uses the same source release and preserves original confirmation history', async () => {
    const item = await confirmedSupplierClaim('revocation-patch');
    const response = await request(app()).patch(`/api/v1/finance/${item.invoiceId}`).set('Authorization', `Bearer ${operator.token}`).send({ status: 'Cancelled' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await db().invoice.findUniqueOrThrow({ where: { id: item.invoiceId } })).toMatchObject({ status: 'Cancelled' });
    expect(await db().materialReturn.findUniqueOrThrow({ where: { id: item.returnId } })).toMatchObject({ status: 'shipped', claimInvoiceId: null });
    expect(await db().auditLog.count({ where: { targetId: item.returnId, action: 'confirm_material_return' } })).toBe(1);
    expect(await db().auditLog.count({ where: { targetId: item.returnId, action: 'cancel_invoice_release_supplier_claim', actorId: operator.id } })).toBe(1);
  });

});
