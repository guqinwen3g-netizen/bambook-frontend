/**
 * Real finance HTTP routes + current authorization guards + isolated PostgreSQL.
 * Independent expectations: 9/30 operating baseline lines 21, 231-232 requires
 * finance confirmation; 9/17 E3 forbids zero/negative receivables; visibility
 * follows the current customer/order scope. Suggestions never write allocations.
 * Synthetic records establish transport/invariant evidence, not company-user UAT.
 * Opt in only through the isolated acceptance runner; no seed or app bootstrap.
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
import { createReceiptMatchProposalRouter } from '../src/finance/receiptMatchProposalRoute';

const prefix = `acceptance-receipt-${randomUUID()}`;
let prisma: PrismaClient | undefined;
let sequence = 0;
const auth = createAuthService();
const db = () => { if (!prisma) throw new Error('isolated receipt fixture not initialized'); return prisma; };

async function actor(label: string, canonicalRole: 'role-sales' | 'role-finance', scopes: string[]) {
  const id = `${prefix}-${++sequence}-${label}`;
  const configuredRole = `${id}-configured`;
  await db().$transaction(async tx => {
    await tx.role.upsert({ where: { id: canonicalRole }, update: {}, create: { id: canonicalRole, name: canonicalRole, isSystem: true } });
    await tx.role.create({ data: { id: configuredRole, name: `Synthetic receipt ${label}`, isSystem: false } });
    await tx.userAccount.create({ data: { id, displayName: `Synthetic receipt ${label}`, status: 'active' } });
    for (const roleId of [canonicalRole, configuredRole]) await tx.userRole.create({ data: { id: `${id}-${roleId}`, userId: id, roleId } });
    for (const scope of scopes) {
      const permission = await tx.permission.upsert({ where: { scope }, update: {}, create: { id: `${prefix}-permission-${scope}`, scope } });
      await tx.rolePermission.create({ data: { id: `${id}-${scope}`, roleId: configuredRole, permissionId: permission.id } });
    }
  });
  const context = await createPermissionService({ prisma: db() }).getUserPermissionContext(id);
  expect(context, 'active synthetic actor must load actual DB authorization').not.toBeNull();
  for (const scope of scopes) expect(context!.scopes).toContain(scope);
  return { id, configuredRole, token: auth.signToken({ userId: id, roles: context!.legacyRoleCodes,
    roleIds: context!.roleIds, departmentIds: context!.departmentIds, permissions: context!.scopes, authorizationLoaded: true }) };
}

type Actor = Awaited<ReturnType<typeof actor>>;
async function source(ownerId: string, label: string, currencies: { invoice?: string; voucher?: string } = {}) {
  const id = `${prefix}-${++sequence}-${label}`;
  const relationId = `${id}-customer`;
  const orderId = `${id}-order`;
  const invoiceId = `${id}-invoice`;
  const voucherId = `${id}-voucher`;
  const now = BigInt(Date.now());
  await db().$transaction(async tx => {
    await tx.relation.create({ data: { id: relationId, name: label, category: 'Customer', type: 'Organization',
      isOrganization: true, tags: [], contactInfo: '', lastInteraction: now, ownerId, salesRepIds: [ownerId] } });
    await tx.order.create({ data: { id: orderId, customer: label, product: 'Synthetic fabric', type: 'Fabric', quantity: 10,
      status: 'Pending', dueDate: '2026-11-01', quoteAmount: '100', currency: 'USD', customerRelationId: relationId, ownerId } });
    await tx.invoice.create({ data: { id: invoiceId, invoiceNumber: invoiceId, type: 'Receivable', status: 'Issued',
      amount: '100', currency: currencies.invoice ?? 'USD', issueDate: '2026-10-01', orderId,
      customerRelationId: relationId, customerName: label, createdAt: now, updatedAt: now } });
    await tx.paymentVoucher.create({ data: { id: voucherId, voucherNumber: voucherId, type: 'Receipt', amount: '100',
      currency: currencies.voucher ?? 'USD', paymentDate: '2026-10-01', paymentMethod: 'TT', status: 'unreconciled',
      orderId, customerRelationId: relationId, customerName: label, createdAt: now, updatedAt: now } });
  });
  return { relationId, orderId, invoiceId, voucherId };
}
type Source = Awaited<ReturnType<typeof source>>;
function app(proposalDatabase: PrismaClient = db()) {
  const result = express();
  result.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? Number(value) : value);
  result.use(express.json());
  result.use(createAccountStatusGuard(db()));
  result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  result.use('/api/v1/finance/receipt-match-proposals', createReceiptMatchProposalRouter({ prisma: proposalDatabase, requireAuth: true, apiKeys: new Set() }));
  result.use('/api/v1/finance', createFinanceRouter({ prisma: db(), requireAuth: true, apiKeys: new Set() }));
  return result;
}
async function claim(who: Actor, item: Source, amount: number, requestId: string) {
  return request(app()).post('/api/v1/finance/receipt-claims/claim').set('Authorization', `Bearer ${who.token}`)
    .send({ invoiceId: item.invoiceId, voucherId: item.voucherId, amount, requestId, actorId: 'body-actor-is-untrusted' });
}
async function state(item: Source) {
  return { invoice: await db().invoice.findUniqueOrThrow({ where: { id: item.invoiceId } }),
    voucher: await db().paymentVoucher.findUniqueOrThrow({ where: { id: item.voucherId } }),
    allocations: await db().invoiceAllocation.findMany({ where: { OR: [{ invoiceId: item.invoiceId }, { voucherId: item.voucherId }] }, orderBy: { id: 'asc' } }),
    receipts: await db().auditLog.findMany({ where: { action: 'finance.receipt.claim.request', detail: { path: ['fingerprint'], string_contains: item.invoiceId } }, orderBy: { id: 'asc' } }) };
}

const proposalPath = '/api/v1/finance/receipt-match-proposals';
async function propose(who: Actor, item: Source, requestId = 'proposal-request', amount = '25.1234', note = 'bank reference supplied by salesperson') {
  return request(app()).post(proposalPath).set('Authorization', `Bearer ${who.token}`)
    .send({ invoiceId: item.invoiceId, voucherId: item.voucherId, amount, currency: 'USD', requestId, note });
}
async function decision(who: Actor, id: string, action: 'confirm' | 'reject' | 'withdraw', body: Record<string, unknown>, database: PrismaClient = db()) {
  return request(app(database)).post(`${proposalPath}/${id}/${action}`).set('Authorization', `Bearer ${who.token}`).send(body);
}
async function proposalState(item: Source, actorId: string) {
  return { ...(await state(item)), proposals: await (db() as any).receiptMatchProposal.findMany({ where: { voucherId: item.voucherId }, orderBy: { id: 'asc' } }),
    links: await db().entityLink.findMany({ where: { fromType: 'paymentVoucher', fromId: item.voucherId }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId, OR: [{ targetType: 'ReceiptMatchProposal' }, { targetType: 'InvoiceAllocation' }] }, orderBy: { id: 'asc' } }) };
}

describe.sequential('receipt allocation: explicit finance confirmation and current visibility in real PG', () => {
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
    expect(identity, 'independently verify PG identity BEFORE any fixture mutation').toEqual([{ name, directory, port: Number(port) }]);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('RA01 sales reads own current receipts but cannot see an unrelated customer receipt', async () => {
    const sales = await actor('read-only-sales', 'role-sales', ['invoices:read']);
    const own = await source(sales.id, 'own');
    const other = await source(`${prefix}-other-owner`, 'other');
    const response = await request(app()).get('/api/v1/finance/receipt-claims').set('Authorization', `Bearer ${sales.token}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.items.map((row: any) => row.voucherId)).toContain(own.voucherId);
    expect(response.body.items.map((row: any) => row.voucherId)).not.toContain(other.voucherId);
  });
  it('RA02 read-only sales cannot confirm allocation; all PG financial rows stay unchanged', async () => {
    const sales = await actor('write-denied-sales', 'role-sales', ['invoices:read']);
    const item = await source(sales.id, 'read-does-not-write');
    const before = await state(item);
    const response = await claim(sales, item, 25, 'sales-cannot-confirm');
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await state(item)).toEqual(before);
  });
  it('RA03 finance suggestion is read-only even when a real matching receivable exists', async () => {
    const finance = await actor('suggestion-finance', 'role-finance', ['invoices:read', 'invoices:reconcile']);
    const item = await source(finance.id, 'real-match');
    const before = await state(item);
    const response = await request(app()).get(`/api/v1/finance/receipt-claims/${item.voucherId}/suggestion`).set('Authorization', `Bearer ${finance.token}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.suggestion).toMatchObject({ invoiceId: item.invoiceId, voucherId: item.voucherId, requiresFinanceConfirmation: true });
    expect(await state(item)).toEqual(before);
  });
  it('RA04 explicit finance confirmation writes the allocation, statuses, links and actual actor audit', async () => {
    const finance = await actor('positive-finance', 'role-finance', ['invoices:read', 'invoices:reconcile']);
    const item = await source(finance.id, 'confirmed');
    const response = await claim(finance, item, 40, 'finance-explicit-confirmation');
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const after = await state(item);
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0].appliedAmount.toString()).toBe('40');
    expect(after.invoice.status).toBe('PartiallyPaid');
    expect(after.voucher.status).toBe('partially_reconciled');
    expect(after.voucher.appliedAmount?.toString()).toBe('40');
    expect(after.receipts).toHaveLength(1);
    expect(after.receipts[0].actorId).toBe(finance.id);
    expect(await db().auditLog.count({ where: { actorId: finance.id, action: 'append_receipt_allocation', targetId: after.allocations[0].id } })).toBe(1);
    expect(await db().entityLink.count({ where: { fromType: 'paymentVoucher', fromId: item.voucherId, toType: 'invoice', toId: item.invoiceId, linkKind: 'settlesInvoice', status: 'active' } })).toBe(1);
  });
  it('RA05 replaying the same actor/request/content creates no extra allocation or receipt audit', async () => {
    const finance = await actor('replay-finance', 'role-finance', ['invoices:reconcile']);
    const item = await source(finance.id, 'same-request');
    const first = await claim(finance, item, 40, 'stable-request');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const before = await state(item);
    const second = await claim(finance, item, 40, 'stable-request');
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(await state(item)).toEqual(before);
  });
  it('RA06 currency mismatch and over-allocation both reject without changing PG balances', async () => {
    const finance = await actor('invalid-finance', 'role-finance', ['invoices:reconcile']);
    for (const [label, currencies, amount, code] of [
      ['currency', { invoice: 'USD', voucher: 'EUR' }, 20, 'CURRENCY_MISMATCH'],
      ['over', {}, 101, 'AMOUNT_EXCEEDED'],
    ] as const) {
      const item = await source(finance.id, label, currencies);
      const before = await state(item);
      const response = await claim(finance, item, amount, `reject-${label}`);
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body.error?.code).toBe(code);
      expect(await state(item)).toEqual(before);
    }
  });
  it('RA07 formerly visible sources cannot be exposed by an idempotent replay after ownership withdrawal', async () => {
    // A designated scoped operator has reconcile explicitly; this does NOT give
    // all sales users finance authority or assert a company default-role grant.
    const designated = await actor('scoped-designated-operator', 'role-sales', ['invoices:read', 'invoices:reconcile']);
    const item = await source(designated.id, 'withdrawn-source');
    expect((await claim(designated, item, 30, 'visibility-replay')).status).toBe(201);
    await db().relation.update({ where: { id: item.relationId }, data: { ownerId: `${prefix}-new-owner`, salesRepIds: [] } });
    const before = await state(item);
    const response = await claim(designated, item, 30, 'visibility-replay');
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body.error?.code).toBe('INVOICE_NOT_VISIBLE');
    expect(response.body.allocationId).toBeUndefined();
    expect(await state(item)).toEqual(before);
  });
  it('RA08 changing the amount under an existing actor/request ID rejects rather than replaying or appending', async () => {
    const finance = await actor('payload-conflict-finance', 'role-finance', ['invoices:reconcile']);
    const item = await source(finance.id, 'request-payload-conflict');
    expect((await claim(finance, item, 20, 'immutable-request')).status).toBe(201);
    const before = await state(item);
    const response = await claim(finance, item, 25, 'immutable-request');
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error?.code).toBe('CONFLICT');
    expect(await state(item)).toEqual(before);
  });

  it('RP01 explicit suggestion grant creates Pending only, and its content cannot change under the same actor/request', async () => {
    const sales = await actor('proposal-positive-sales', 'role-sales', ['invoices:read', 'invoices:suggest_match']);
    const item = await source(sales.id, 'proposal-only');
    const before = await state(item);
    const created = await propose(sales, item);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.item).toMatchObject({ requesterId: sales.id, status: 'Pending', requestedAmount: '25.1234', revision: 1, allocationId: null });
    expect(await state(item)).toEqual(before);
    expect(await db().auditLog.count({ where: { targetId: created.body.item.id, action: 'receipt_match_proposed', actorId: sales.id } })).toBe(1);
    const replay = await propose(sales, item);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.item.id).toBe(created.body.item.id);
    const snapshot = await proposalState(item, sales.id);
    const conflict = await propose(sales, item, 'proposal-request', '26');
    expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
    expect(conflict.body.error?.code).toBe('REQUEST_CONFLICT');
    expect(await proposalState(item, sales.id)).toEqual(snapshot);
  });

  it('RP02 sales role/read alone does not implicitly grant proposal creation or access to unrelated sources', async () => {
    const readOnly = await actor('proposal-denied-sales', 'role-sales', ['invoices:read']);
    const own = await source(readOnly.id, 'no-suggestion-grant');
    const before = await proposalState(own, readOnly.id);
    expect((await propose(readOnly, own)).status).toBe(403);
    expect(await proposalState(own, readOnly.id)).toEqual(before);
    const allowed = await actor('proposal-scoped-sales', 'role-sales', ['invoices:read', 'invoices:suggest_match']);
    const foreign = await source(readOnly.id, 'foreign-proposal-source');
    const foreignBefore = await proposalState(foreign, allowed.id);
    expect((await propose(allowed, foreign)).status).toBe(404);
    expect(await proposalState(foreign, allowed.id)).toEqual(foreignBefore);
  });

  it('RP03 finance explicitly confirms once; sales cannot confirm, and changed confirm payload cannot overwrite the fact', async () => {
    const sales = await actor('proposal-finance-flow-sales', 'role-sales', ['invoices:read', 'invoices:suggest_match']);
    const finance = await actor('proposal-finance-flow-finance', 'role-finance', ['invoices:read', 'invoices:reconcile']);
    const item = await source(sales.id, 'pending-to-confirmed');
    const created = await propose(sales, item);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.item.id;
    const before = await proposalState(item, sales.id);
    expect((await decision(sales, id, 'confirm', { revision: 1, requestId: 'sales-confirm' })).status).toBe(403);
    expect(await proposalState(item, sales.id)).toEqual(before);
    const body = { revision: 1, requestId: 'finance-confirm', note: 'bank statement checked' };
    const confirmed = await decision(finance, id, 'confirm', body);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.item).toMatchObject({ status: 'Confirmed', revision: 2, requestedAmount: '25.1234', decisionActorId: finance.id });
    const after = await proposalState(item, finance.id);
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0].appliedAmount.toString()).toBe('25.1234');
    expect(after.invoice.status).toBe('PartiallyPaid');
    expect(after.voucher.appliedAmount?.toString()).toBe('25.1234');
    expect(after.audits.filter(row => row.action === 'receipt_match_confirmed')).toHaveLength(1);
    expect(after.audits.filter(row => row.action === 'confirm_receipt_match_allocation')).toHaveLength(1);
    const replay = await decision(finance, id, 'confirm', body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(await proposalState(item, finance.id)).toEqual(after);
    expect((await decision(finance, id, 'confirm', { ...body, note: 'changed decision content' })).status).toBe(409);
    expect((await decision(finance, id, 'confirm', { ...body, amount: '50' })).status).toBe(400);
    expect(await proposalState(item, finance.id)).toEqual(after);
  });

  it('RP04 only the requester can withdraw, and rejection/withdrawal retain history without any allocation', async () => {
    const sales = await actor('proposal-terminal-sales', 'role-sales', ['invoices:read', 'invoices:suggest_match']);
    const other = await actor('proposal-terminal-other-sales', 'role-sales', ['invoices:read', 'invoices:suggest_match']);
    const finance = await actor('proposal-terminal-finance', 'role-finance', ['invoices:reconcile']);
    const item = await source(sales.id, 'terminal-without-allocation');
    const first = await propose(sales, item, 'withdraw-source');
    const second = await propose(sales, item, 'reject-source');
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    const before = await state(item);
    expect((await decision(other, first.body.item.id, 'withdraw', { revision: 1, requestId: 'foreign-withdraw' })).status).toBe(403);
    const withdrawn = await decision(sales, first.body.item.id, 'withdraw', { revision: 1, requestId: 'own-withdraw', note: 'wrong reference; will resubmit' });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.item).toMatchObject({ status: 'Withdrawn', decisionActorId: sales.id });
    expect((await decision(finance, second.body.item.id, 'reject', { revision: 1, requestId: 'reason-required' })).status).toBe(400);
    const rejected = await decision(finance, second.body.item.id, 'reject', { revision: 1, requestId: 'reject-with-reason', note: 'invoice reference does not match bank advice' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.item).toMatchObject({ status: 'Rejected', decisionActorId: finance.id, allocationId: null });
    expect((await decision(finance, second.body.item.id, 'confirm', { revision: 2, requestId: 'cannot-overwrite-rejection' })).status).toBe(409);
    expect(await state(item)).toEqual(before);
    expect(await db().auditLog.count({ where: { targetId: first.body.item.id, action: 'receipt_match_withdrawn', actorId: sales.id } })).toBe(1);
    expect(await db().auditLog.count({ where: { targetId: second.body.item.id, action: 'receipt_match_rejected', actorId: finance.id } })).toBe(1);
  });

  it('RP05 proposal history/list/replay uses current ownership and never exposes another salesperson proposal', async () => {
    const sales = await actor('proposal-history-sales', 'role-sales', ['invoices:read', 'invoices:suggest_match']);
    const other = await actor('proposal-history-other-sales', 'role-sales', ['invoices:read', 'invoices:suggest_match']);
    const finance = await actor('proposal-history-finance', 'role-finance', ['invoices:read', 'invoices:reconcile']);
    const item = await source(sales.id, 'proposal-history-visible');
    const created = await propose(sales, item);
    expect(created.status).toBe(201);
    const list = async (who: Actor) => request(app()).get(proposalPath).set('Authorization', `Bearer ${who.token}`);
    expect((await list(sales)).body.items.map((row: any) => row.id)).toContain(created.body.item.id);
    expect((await list(other)).body.items.map((row: any) => row.id)).not.toContain(created.body.item.id);
    expect((await list(finance)).body.items.map((row: any) => row.id)).toContain(created.body.item.id);
    await db().relation.update({ where: { id: item.relationId }, data: { ownerId: other.id, salesRepIds: [other.id] } });
    expect((await list(sales)).body.items.map((row: any) => row.id)).not.toContain(created.body.item.id);
    expect((await propose(sales, item)).status).toBe(404);
  });

  it('RP06 stale source balance or currency blocks finance confirmation without closing the pending proposal', async () => {
    const sales = await actor('proposal-changed-source-sales', 'role-sales', ['invoices:read', 'invoices:suggest_match']);
    const finance = await actor('proposal-changed-source-finance', 'role-finance', ['invoices:reconcile']);
    for (const kind of ['balance', 'currency'] as const) {
      const item = await source(sales.id, `changed-${kind}`);
      const created = await propose(sales, item, `changed-source-${kind}`);
      expect(created.status).toBe(201);
      if (kind === 'balance') expect((await claim(finance, item, 90, 'consume-other-allocation')).status).toBe(201);
      else await db().paymentVoucher.update({ where: { id: item.voucherId }, data: { currency: 'EUR' } });
      const before = await proposalState(item, finance.id);
      const response = await decision(finance, created.body.item.id, 'confirm', { revision: 1, requestId: `changed-${kind}-decision` });
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body.error?.code).toBe(kind === 'balance' ? 'AMOUNT_EXCEEDED' : 'CURRENCY_MISMATCH');
      expect(await proposalState(item, finance.id)).toEqual(before);
    }
  });

  it('RP07 a real decision-audit FK failure rolls back allocation, links, balances and proposal state together', async () => {
    const sales = await actor('proposal-atomic-sales', 'role-sales', ['invoices:read', 'invoices:suggest_match']);
    const finance = await actor('proposal-atomic-finance', 'role-finance', ['invoices:reconcile']);
    const item = await source(sales.id, 'atomic-audit-failure');
    const created = await propose(sales, item);
    expect(created.status).toBe(201);
    const before = await proposalState(item, finance.id);
    let actualSqlError: string | undefined;
    let injected = 0;
    const faultClient = new Proxy(db(), { get(target, property) {
      if (property === '$transaction') return (callback: any, options: any) => target.$transaction(async tx => {
        const audit = new Proxy(tx.auditLog, { get(delegate, key) {
          if (key === 'create') return async (args: any) => {
            if (args.data.action !== 'receipt_match_confirmed') return delegate.create(args);
            injected++;
            try { return await delegate.create({ ...args, data: { ...args.data, actorId: `${prefix}-nonexistent-audit-actor` } }); }
            catch (error: any) { actualSqlError = error?.code; throw error; }
          };
          const value = Reflect.get(delegate, key); return typeof value === 'function' ? value.bind(delegate) : value;
        } });
        const guardedTx = new Proxy(tx, { get(client, key) { if (key === 'auditLog') return audit;
          const value = Reflect.get(client, key); return typeof value === 'function' ? value.bind(client) : value; } });
        return callback(guardedTx);
      }, options);
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } }) as PrismaClient;
    const response = await decision(finance, created.body.item.id, 'confirm', { revision: 1, requestId: 'actual-pg-audit-failure' }, faultClient);
    expect(injected, 'fault must reach the final mandatory decision audit AFTER the real allocation kernel').toBe(1);
    expect(actualSqlError, 'no synthetic throw: PostgreSQL FK must fail').toBe('P2003');
    expect(response.status, JSON.stringify(response.body)).toBe(500);
    expect(await proposalState(item, finance.id)).toEqual(before);
    console.log(JSON.stringify({ probe: 'receipt-proposal-audit-atomicity', sqlCode: actualSqlError, injections: injected, http: response.status, pgFinancialStateUnchanged: true }));
  });

  it('RP08 two different finance confirmations cannot both consume one Pending proposal', async () => {
    const sales = await actor('proposal-race-sales', 'role-sales', ['invoices:read', 'invoices:suggest_match']);
    const finance = await actor('proposal-race-finance', 'role-finance', ['invoices:reconcile']);
    const item = await source(sales.id, 'one-pending-two-decisions');
    const created = await propose(sales, item);
    expect(created.status).toBe(201);
    const actualTransactionErrors: Array<{ code: unknown; sqlState: unknown }> = [];
    const tracedDatabase = new Proxy(db(), { get(target, property) {
      if (property === '$transaction') return async (callback: any, options: any) => {
        try { return await target.$transaction(callback, options); }
        catch (error: any) { actualTransactionErrors.push({ code: error?.code ?? null, sqlState: error?.meta?.code ?? null }); throw error; }
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } }) as PrismaClient;
    const responses = await Promise.all([
      decision(finance, created.body.item.id, 'confirm', { revision: 1, requestId: 'race-A', note: 'decision A' }, tracedDatabase),
      decision(finance, created.body.item.id, 'confirm', { revision: 1, requestId: 'race-B', note: 'decision B' }, tracedDatabase),
    ]);
    console.log(JSON.stringify({ probe: 'receipt-proposal-concurrent-decisions', actualTransactionErrors, http: responses.map(response => response.status) }));
    expect(responses.map(response => response.status).sort(), JSON.stringify(responses.map(response => ({ status: response.status, body: response.body })))).toEqual([200, 409]);
    const after = await proposalState(item, finance.id);
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0].appliedAmount.toString()).toBe('25.1234');
    expect(after.proposals[0]).toMatchObject({ status: 'Confirmed', revision: 2, decisionActorId: finance.id });
    expect(after.audits.filter(row => row.action === 'receipt_match_confirmed')).toHaveLength(1);
  });
});
