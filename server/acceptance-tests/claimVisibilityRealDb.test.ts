/** Real HTTP/JWT/current DB + isolated PG scope/source probes.
 * Independent rules: DR-042 §5.1/5.3 (customer L2 subtree), DR-016 (actual
 * order/invoice allocation vs billTo), A1/A2 (real source/customer, separate
 * financial execution), and parent-approved reporter/team unbound-case fallback.
 * Canonical identities + an isolated role COPY of the current default matrix
 * are technical default-contract evidence, not deployed company-role/UAT proof.
 * Legacy closed CN headers here prove scoped history queries only; they do not
 * manufacture issued versions, approval facts, refund entitlement or printing.
 * No seed/index/scheduler/shared DB/external actions; runner owns cluster cleanup.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createClaimRouter } from '../src/claims/claimRoute';
import { createTeamShareService } from '../src/teams/teamShareService';
import { DEFAULT_ROLE_PERMISSION_MATRIX, type SystemRoleId } from '../src/_shared/rolePermissionMatrix';

const prefix = 'acceptance-claim-visibility-' + randomUUID();
let prisma: PrismaClient | undefined, counter = 0;
const db = () => { if (!prisma) throw Error('Independent claim visibility client not initialized'); return prisma; };
// Runner privately generates current schema; shared client intentionally remains untouched.
const models = () => db() as any;
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed independent acceptance sandbox required');
  const url = new URL(DATABASE_URL);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.protocol).toBe('postgresql:');
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`,
    'verify private name/directory/port BEFORE any fixture mutation').toEqual([{ name, directory, port: Number(port) }]);
});
afterAll(async () => { if (prisma) await prisma.$disconnect(); });

function app(database: PrismaClient = db()) {
  const application = express(); application.use(express.json());
  application.set('json replacer', (_key: string, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
  application.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  application.use('/api/v1', createClaimRouter({ prisma: database, requireAuth: true }));
  return application;
}
async function person(id: string, roleId: SystemRoleId) {
  await db().userAccount.create({ data: { id, displayName: id, status: 'active' } });
  await db().role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: roleId, isSystem: true } });
  const copy = id + '-default-copy'; await db().role.create({ data: { id: copy, name: 'Synthetic isolated copy of current default matrix', isSystem: false } });
  for (const assignment of [roleId, copy]) await db().userRole.create({ data: { id: id + '-role-' + assignment, userId: id, roleId: assignment } });
  for (const [scope, allowed] of Object.entries(DEFAULT_ROLE_PERMISSION_MATRIX[roleId])) {
    if (allowed !== true) continue;
    const permission = await db().permission.upsert({ where: { scope }, update: {}, create: { id: prefix + '-permission-' + scope, scope } });
    await db().rolePermission.create({ data: { id: id + '-scope-' + scope, roleId: copy, permissionId: permission.id } });
  }
  const actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), id));
  return { id, actor, token: createAuthService().signToken(actor) };
}
async function fixture() {
  const id = prefix + '-' + ++counter;
  const sales = await person(id + '-sales', 'role-sales'), other = await person(id + '-other', 'role-sales'), finance = await person(id + '-finance', 'role-finance');
  const relation = async (key: string, ownerId: string) => db().relation.create({ data: { id: id + key, name: id + key,
    category: 'Customer', type: 'Company', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()), ownerId, salesRepIds: [ownerId] } });
  const own = await relation('-own', sales.id), foreign = await relation('-foreign', other.id), billTo = await relation('-billTo', other.id);
  const order = async (key: string, customer: any, ownerId: string) => db().order.create({ data: { id: id + key, code: id + key,
    customer: customer.name, customerRelationId: customer.id, product: 'Synthetic visibility-only material', type: 'Fabric', quantity: 1000,
    status: 'Confirmed', dueDate: '2026-12-01', quoteAmount: 100, ownerId } });
  const ownOrder = await order('-order', own, sales.id), foreignOrder = await order('-foreign-order', foreign, other.id);
  const invoice = async (key: string, customer: any, ownerId: string, orderId: string | null = null) => db().invoice.create({ data: {
    id: id + key, invoiceNumber: id + key, type: 'Receivable', status: 'Issued', amount: 100, currency: 'USD', issueDate: '2026-10-01',
    customerRelationId: customer.id, customerName: customer.name, orderId, ownerId, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  const ownInvoice = await invoice('-invoice', own, sales.id, ownOrder.id), foreignInvoice = await invoice('-foreign-invoice', foreign, other.id, foreignOrder.id);
  const thirdPartyInvoice = await invoice('-third-party-invoice', billTo, sales.id);
  await db().invoiceOrderAllocation.create({ data: { id: id + '-ioa', invoiceId: thirdPartyInvoice.id, orderId: ownOrder.id,
    allocatedAmount: 50, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  await db().invoiceOrderAllocation.create({ data: { id: id + '-ioa-private', invoiceId: thirdPartyInvoice.id, orderId: foreignOrder.id,
    allocatedAmount: 50, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  const application = app();
  const create = async (body: any, who = sales) => request(application).post('/api/v1/claims').set('Authorization', 'Bearer ' + who.token).send({ problemDesc: 'Synthetic whole-source scope check', ...body });
  const owned = await create({ customerRelationId: own.id, sourceOrderId: ownOrder.id, sourceInvoiceId: ownInvoice.id, customerName: 'Caller wrong name' });
  expect(owned.status, diagnostic(owned.body)).toBe(201);
  const hidden = await create({ customerRelationId: foreign.id, sourceOrderId: foreignOrder.id, sourceInvoiceId: foreignInvoice.id }, other);
  expect(hidden.status, diagnostic(hidden.body)).toBe(201);
  const unbound = await create({ customerName: 'Unbound descriptive name' }); expect(unbound.status, diagnostic(unbound.body)).toBe(201);
  return { id, sales, other, finance, own, foreign, billTo, ownOrder, foreignOrder, ownInvoice, foreignInvoice, thirdPartyInvoice,
    app: application, create, owned: owned.body.claimCase, hidden: hidden.body.claimCase, unbound: unbound.body.claimCase };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const get = (f: Fixture, suffix: string, who = f.sales, application = f.app) => request(application).get('/api/v1/' + suffix).set('Authorization', 'Bearer ' + who.token);
async function unchanged(f: Fixture, action: () => Promise<any>, status: number) {
  const state = async () => ({ cases: await db().claimCase.findMany({ where: { reportedBy: { in: [f.sales.id, f.other.id] } }, orderBy: { id: 'asc' } }),
    dispositions: await db().claimDisposition.findMany({ where: { claimCaseId: { in: [f.owned.id, f.hidden.id] } }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: f.sales.id }, orderBy: { id: 'asc' } }) });
  const before = await state(), result = await action(); expect(result.status, diagnostic(result.body)).toBe(status); expect(await state()).toEqual(before); return result;
}
describe('Actual claim HTTP source and data-scope contracts', () => {
  it('owned and reporter-only cases are visible; known private case IDs neither disclose nor mutate', async () => {
    const f = await fixture(); expect((await get(f, 'claims/' + f.owned.id)).status).toBe(200);
    expect((await get(f, 'claims/' + f.unbound.id)).body.claimCase.customerRelationId).toBeNull();
    await unchanged(f, () => get(f, 'claims/' + f.hidden.id), 404);
    await unchanged(f, () => request(f.app).post('/api/v1/claims/' + f.hidden.id + '/dispositions').set('Authorization', 'Bearer ' + f.sales.token)
      .send({ kind: 'Allowance', amount: 10, currency: 'USD' }), 404);
    expect((await get(f, 'claims/' + f.owned.id)).body.claimCase.customerName).toBe(f.own.name);
  });
  it('parent scope rejects real disposition, receipt, return line, repair, replacement and CN IDs', async () => {
    const f = await fixture(), now = BigInt(Date.now());
    const d = await db().claimDisposition.create({ data: { id: f.id + '-d', claimCaseId: f.hidden.id, kind: 'Replace', replacementShipmentId: f.id + '-shipment', createdAt: now, updatedAt: now } });
    const rr = await db().returnReceipt.create({ data: { id: f.id + '-rr', receiptNumber: f.id + '-rr', claimCaseId: f.hidden.id, warehouseId: 'synthetic-not-consumed', disposition: 'Replace', createdAt: now, updatedAt: now } });
    const line = await models().returnReceiptLine.create({ data: { id: f.id + '-line', returnReceiptId: rr.id, claimDispositionId: d.id,
      materialCode: 'Visibility-only', expectedQuantity: 1, unit: 'PCS', disposition: 'Replace', createdAt: now, updatedAt: now } });
    const repair = await db().repairWorkOrder.create({ data: { id: f.id + '-repair', workOrderNumber: f.id + '-repair', claimCaseId: f.hidden.id,
      dispositionId: d.id, workStationId: 'synthetic-not-consumed', quantity: 1, createdAt: now, updatedAt: now } });
    const cn = await db().creditNote.create({ data: { id: f.id + '-cn', creditNoteNumber: f.id + '-cn', claimCaseId: f.hidden.id,
      customerRelationId: f.foreign.id, currency: 'USD', amount: 10, openAmount: 10, issueDate: '2026-10-01', createdAt: now, updatedAt: now } });
    for (const suffix of ['return-receipts/' + rr.id, 'repair-work-orders/' + repair.id, 'claim-shipments/' + d.replacementShipmentId + '/stock', 'credit-notes/' + cn.id + '/versions'])
      await unchanged(f, () => get(f, suffix), 404);
    await unchanged(f, () => request(f.app).post('/api/v1/claims/dispositions/' + d.id + '/execute').set('Authorization', 'Bearer ' + f.sales.token).send({}), 404);
    // Use a current canonical all-scope finance actor only to read the receipt;
    // no fake factory/QC/approval/stock fact is consumed by these negative probes.
    expect((await get(f, 'return-receipts/' + rr.id, f.finance)).status).toBe(200);
    expect(await models().returnReceiptLine.findUnique({ where: { id: line.id } })).toMatchObject({ status: 'Draft', receivedQuantity: expect.anything() });
  });
  it('list count and offset are computed after L2 filter, with stable page boundaries', async () => {
    const f = await fixture(); for (let i = 0; i < 2; i++) expect((await f.create({ customerRelationId: f.own.id })).status).toBe(201);
    const first = await get(f, `claims?customerRelationId=${f.own.id}&limit=1&offset=0`), second = await get(f, `claims?customerRelationId=${f.own.id}&limit=1&offset=1`);
    expect(first.body).toMatchObject({ total: 3, limit: 1, offset: 0 }); expect(second.body).toMatchObject({ total: 3, offset: 1 });
    expect(first.body.items).toHaveLength(1); expect(second.body.items).toHaveLength(1); expect(first.body.items[0].id).not.toBe(second.body.items[0].id);
    const privateList = await get(f, `claims?customerRelationId=${f.foreign.id}`); expect(privateList.body).toMatchObject({ items: [], total: 0 });
  });
  it('guessed identifiers, cross-customer order and unrelated invoice leave no created case/audit', async () => {
    const f = await fixture();
    const otherVisible = await db().relation.create({ data: { id: f.id + '-visible-other', name: 'Another actually followed customer', category: 'Customer', type: 'Company',
      isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()), ownerId: f.sales.id, salesRepIds: [f.sales.id] } });
    const unrelatedVisible = await db().invoice.create({ data: { id: f.id + '-unrelated-visible', invoiceNumber: f.id + '-unrelated-visible', type: 'Receivable', status: 'Issued',
      amount: 100, currency: 'USD', issueDate: '2026-10-01', customerRelationId: f.own.id, ownerId: f.sales.id, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
    await unchanged(f, () => f.create({ customerRelationId: f.id + '-fake', customerName: f.own.name }), 404);
    await unchanged(f, () => f.create({ customerRelationId: otherVisible.id, sourceOrderId: f.ownOrder.id }), 400);
    await unchanged(f, () => f.create({ sourceOrderId: f.ownOrder.id, sourceInvoiceId: unrelatedVisible.id }), 400);
    await unchanged(f, () => f.create({ sourceInvoiceId: f.ownInvoice.id, customerRelationId: otherVisible.id }), 400);
    await unchanged(f, () => f.create({ sourceOrderId: f.ownOrder.id, sourceInvoiceId: f.foreignInvoice.id }), 404);
    await unchanged(f, () => f.create({ customerRelationId: f.foreign.id }), 404);
  });
  it('DR-016 IOA proves order source while case customer and invoice billTo stay distinct', async () => {
    const f = await fixture(); const created = await f.create({ customerRelationId: f.own.id, sourceOrderId: f.ownOrder.id, sourceInvoiceId: f.thirdPartyInvoice.id });
    expect(created.status, diagnostic(created.body)).toBe(201); expect(created.body.claimCase).toMatchObject({ customerRelationId: f.own.id, sourceInvoiceId: f.thirdPartyInvoice.id });
    const detail = await get(f, 'claims/' + created.body.claimCase.id);
    expect(detail.body.claimCase.sourceInvoice).toMatchObject({ id: f.thirdPartyInvoice.id, billTo: { id: f.billTo.id, name: f.billTo.name } });
    expect(await db().invoice.findUniqueOrThrow({ where: { id: f.thirdPartyInvoice.id } })).toMatchObject({ customerRelationId: f.billTo.id });
  });
  it('three real source candidate endpoints page in scope and do not disclose financial/cost fields', async () => {
    const f = await fixture();
    const customers = await get(f, 'claims/sources/customers?limit=1&offset=0'); expect(customers.status, diagnostic(customers.body)).toBe(200);
    expect(customers.body).toMatchObject({ total: 1, limit: 1, offset: 0 }); expect(customers.body.items).toEqual([{ id: f.own.id, name: f.own.name }]);
    const orders = await get(f, 'claims/sources/orders?customerRelationId=' + f.own.id); expect(orders.body.items).toEqual([{ id: f.ownOrder.id, code: f.ownOrder.code, poNumber: null, customerRelationId: f.own.id, customerName: f.own.name }]);
    const invoices = await get(f, `claims/sources/invoices?customerRelationId=${f.own.id}&sourceOrderId=${f.ownOrder.id}&limit=1&offset=1`);
    expect(invoices.status, diagnostic(invoices.body)).toBe(200); expect(invoices.body).toMatchObject({ total: 2, offset: 1 }); expect(invoices.body.items).toHaveLength(1);
    expect(Object.keys(invoices.body.items[0]).sort()).toEqual(['billTo', 'currency', 'customerRelationId', 'id', 'invoiceNumber', 'sourceOrderIds']);
    expect(invoices.body.items[0].sourceOrderIds).toEqual([f.ownOrder.id]);
    expect((await get(f, 'claims/sources/invoices?sourceOrderId=' + f.foreignOrder.id)).status).toBe(404);
  });
  it('current TeamShare grant permits business subtree, then real revocation takes effect without waiting for cached reads', async () => {
    const f = await fixture(); const teamId = f.id + '-team'; await db().team.create({ data: { id: teamId, name: teamId } });
    await db().teamMember.createMany({ data: [f.sales.id, f.other.id].map(userId => ({ id: teamId + '-' + userId, teamId, userId })) });
    const grant = await db().teamDataGrant.create({ data: { id: teamId + '-grant', teamId, entityType: 'relation', entityId: f.foreign.id, permission: 'read', grantedBy: f.other.id } });
    expect((await get(f, 'claims/' + f.hidden.id)).status).toBe(200);
    expect(await createTeamShareService(db()).getActiveGrantedRelationIds(f.sales.id)).toContain(f.foreign.id);
    await db().teamDataGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date(), revokedBy: f.other.id } });
    await unchanged(f, () => get(f, 'claims/' + f.hidden.id), 404);
    await unchanged(f, () => f.create({ customerRelationId: f.foreign.id }), 404);
    const teammateUnbound = await f.create({ customerName: 'Unbound teammate' }, f.other); expect(teammateUnbound.status).toBe(201);
    expect((await get(f, 'claims/' + teammateUnbound.body.claimCase.id)).status).toBe(200);
    await db().teamMember.update({ where: { teamId_userId: { teamId, userId: f.sales.id } }, data: { leftAt: new Date() } });
    expect((await get(f, 'claims/' + teammateUnbound.body.claimCase.id)).status).toBe(404);
  });
  it('real team SQL read fault cannot silently produce an empty successful list or permit a new case', async () => {
    const f = await fixture(); let faults = 0, code: string | undefined;
    const database = new Proxy(db(), { get(target, property) {
      if (property !== 'teamMember') return Reflect.get(target, property);
      return new Proxy(target.teamMember, { get(delegate, method) {
        if (method !== 'findMany') return Reflect.get(delegate, method);
        return async () => { faults++; try { return await target.$queryRawUnsafe('SELECT * FROM "acceptance_missing_claim_scope_table"'); } catch (error: any) { code = error.code; throw error; } };
      } });
    } });
    const failedApp = app(database);
    await unchanged(f, () => get(f, 'claims', f.sales, failedApp), 503);
    await unchanged(f, () => request(failedApp).post('/api/v1/claims').set('Authorization', 'Bearer ' + f.sales.token).send({ problemDesc: 'must not submit with unknown scope' }), 503);
    expect(faults).toBe(2); expect(code).toBe('P2010');
  });
  it('closed CN history preserves scoped totals and a private balance never enters visible aggregate', async () => {
    const f = await fixture(), now = BigInt(Date.now());
    for (const [suffix, claim, customer, status, open] of [['open1', f.owned, f.own, 'Open', 30], ['open2', f.owned, f.own, 'PartiallyApplied', 20],
      ['closed', f.owned, f.own, 'Closed', 0], ['private', f.hidden, f.foreign, 'Open', 999]] as const) {
      await db().creditNote.create({ data: { id: f.id + suffix, creditNoteNumber: f.id + suffix, claimCaseId: claim.id, customerRelationId: customer.id,
        currency: 'USD', amount: 1000, openAmount: open, status, issueDate: '2026-10-01', createdAt: now, updatedAt: now } });
    }
    const open = await get(f, 'credit-notes?claimCaseId=' + f.owned.id + '&limit=1'); expect(open.body).toMatchObject({ total: 2, totalOpen: '50' }); expect(open.body.items).toHaveLength(1);
    const closed = await get(f, 'credit-notes?claimCaseId=' + f.owned.id + '&includeClosed=true&status=Closed');
    expect(closed.body).toMatchObject({ total: 1, totalOpen: '0' }); expect(closed.body.items[0]).toMatchObject({ status: 'Closed', id: f.id + 'closed' });
    expect((await get(f, 'credit-notes?claimCaseId=' + f.hidden.id)).body).toMatchObject({ total: 0, totalOpen: '0', items: [] });
  });
  it('current default Finance can reach reconcile; default Sales cannot turn a proposal into finance execution', async () => {
    const f = await fixture(), now = BigInt(Date.now()); const note = await db().creditNote.create({ data: { id: f.id + '-cn-permission', creditNoteNumber: f.id + '-cn-permission',
      claimCaseId: f.owned.id, customerRelationId: f.own.id, currency: 'USD', amount: 10, openAmount: 10, issueDate: '2026-10-01', createdAt: now, updatedAt: now } });
    const apply = (token: string) => request(f.app).post('/api/v1/credit-notes/' + note.id + '/apply').set('Authorization', 'Bearer ' + token).send({});
    const rejected = await apply(f.sales.token); expect(rejected.status, diagnostic(rejected.body)).toBe(403);
    const allowedBoundary = await apply(f.finance.token); expect(allowedBoundary.status, diagnostic(allowedBoundary.body)).toBe(400); expect(allowedBoundary.body.error).toBe('VALIDATION_FAILED');
    expect(await db().creditNote.findUniqueOrThrow({ where: { id: note.id } })).toMatchObject({ status: 'Open', openAmount: expect.anything() });
    const limited: TokenPayload = { ...f.finance.actor, permissionCeiling: ['aftersales:read'] };
    expect((await apply(createAuthService().signToken(limited))).status).toBe(403);
  });
});
