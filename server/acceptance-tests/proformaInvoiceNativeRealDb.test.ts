/** Opt-in private PG only. Native PI generation/issue/conversion and mandatory
 * audits/numbering are real; the Accepted commercial Quotation is a minimal
 * synthetic source, not proof of the quotation acceptance/UI workflow.
 * Actual Finance V2 HTTP + current JWT/account/scope composition are used.
 * Faults are real SQL FK/undefined-column failures inside the native tx.
 * No seed, app bootstrap, scheduler, normal backend suite or shared DB. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createFinanceV2Router } from '../src/finance/routeV2';
import { updateInvoice } from '../src/finance/invoiceMutationService';
import * as events from '../src/events/businessEventBus';
import { periodKeyForDate } from '../src/sequence/sequenceService';
import { createTeamShareService } from '../src/teams/teamShareService';
import { createOrderShipmentBatchService } from '../src/shipping/orderShipmentBatchService';

const prefix = `acceptance-native-pi-${randomUUID()}`, auth = createAuthService();
let prisma: PrismaClient | undefined, nativeClient: PrismaClient | undefined, sequence = 0;
const db = () => { if (!prisma) throw Error('Private native PI database not initialized'); return prisma; };
const client = () => { if (!nativeClient) throw Error('Private native PI native client not initialized'); return nativeClient; };
type Fault = { kind: 'audit' | 'sequence' | 'authorization' | 'scope' | 'parent-drift' | 'allocation'; phase: 'generate' | 'convert'; actorId: string; reached: number; actualCode?: string; sqlState?: string; sourceId?: string; nextOrderId?: string; reads?: number; expectedCarryCount?: number; stagedCarryCount?: number; stagedOriginalStatus?: string };
let fault: Fault | undefined;

// One stable client is passed to all HTTP routers, so the existing service
// singleton cannot accidentally retain a non-intercepted client between cases.
function intercepted(): PrismaClient {
  return new Proxy(db(), { get(base, property) {
    if (property === '$transaction') return async (work: any, options?: any) => {
      if (typeof work !== 'function') return (base.$transaction as any)(work, options);
      return base.$transaction(async tx => work(new Proxy(tx, { get(transaction, delegate) {
        if (['auditLog', 'sequenceRegister', 'userAccount', 'teamDataGrant', 'quotation', 'invoiceOrderAllocation'].includes(String(delegate))) {
          const model: any = Reflect.get(transaction, delegate);
          return new Proxy(model, { get(real, method) {
            if (delegate === 'auditLog' && method === 'create') return async (args: any) => {
              const active = fault;
              if (active?.kind === 'audit' && args.data.actorId === active.actorId
                && args.data.detail?.source === `proforma-invoice:${active.phase}`) {
                active.reached++;
                if (active.expectedCarryCount != null) {
                  active.stagedCarryCount = await transaction.invoiceOrderAllocation.count({ where: { invoiceId: args.data.targetId, deletedAt: null } });
                  active.stagedOriginalStatus = (await transaction.invoice.findUniqueOrThrow({ where: { id: active.sourceId } })).status;
                }
                try { return await real.create({ ...args, data: { ...args.data, actorId: `${prefix}-missing-audit-actor` } }); }
                catch (error: any) { active.actualCode = error.code; active.sqlState = error.meta?.code; throw error; }
              }
              return real.create(args);
            };
            if (delegate === 'sequenceRegister' && method === 'update') return async (args: any) => {
              const active = fault;
              if (active?.kind === 'sequence') {
                active.reached++;
                try { return await transaction.$queryRaw`SELECT "native_pi_missing_sequence_column" FROM "SequenceRegister" LIMIT 1`; }
                catch (error: any) { active.actualCode = error.code; active.sqlState = error.meta?.code; throw error; }
              }
              return real.update(args);
            };
            if (delegate === 'invoiceOrderAllocation' && method === 'create') return async (args: any) => {
              const active = fault;
              if (active?.kind === 'allocation') {
                active.reached++;
                // IOA has snapshot references, not real FK constraints. A real
                // PK violation tests this native write boundary honestly.
                try { return await real.create({ ...args, data: { ...args.data, id: active.sourceId } }); }
                catch (error: any) { active.actualCode = error.code; active.sqlState = error.meta?.code; throw error; }
              }
              return real.create(args);
            };
            if (delegate === 'userAccount' && method === 'findUnique' || delegate === 'teamDataGrant' && method === 'findMany') return async (args: any) => {
              const active = fault;
              if (active && (active.kind === 'authorization' && delegate === 'userAccount' && args.where.id === active.actorId
                || active.kind === 'scope' && delegate === 'teamDataGrant')) {
                active.reached++;
                try { return await transaction.$queryRaw`SELECT "native_pi_missing_authority_column" FROM "UserAccount" LIMIT 1`; }
                catch (error: any) { active.actualCode = error.code; active.sqlState = error.meta?.code; throw error; }
              }
              return real[method](args);
            };
            if (delegate === 'quotation' && method === 'findFirst') return async (args: any) => {
              const active = fault;
              if (active?.kind === 'parent-drift' && args.where.id === active.sourceId) {
                active.reads = (active.reads ?? 0) + 1;
                if (active.reads === 2) {
                  await transaction.quotation.update({ where: { id: active.sourceId }, data: { convertedOrderId: active.nextOrderId } });
                  active.reached++;
                }
              }
              return real.findFirst(args);
            };
            const value = Reflect.get(real, method); return typeof value === 'function' ? value.bind(real) : value;
          } });
        }
        const value = Reflect.get(transaction, delegate); return typeof value === 'function' ? value.bind(transaction) : value;
      } })), options);
    };
    const value = Reflect.get(base, property); return typeof value === 'function' ? value.bind(base) : value;
  } });
}

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed isolated acceptance PG is required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
  `;
  expect(identity, 'Actual PG identity before fixture writes').toEqual([{ name, directory, port: Number(port) }]);
  nativeClient = intercepted();
});
afterEach(() => { fault = undefined; vi.restoreAllMocks(); });
afterAll(async () => { await prisma?.$disconnect(); });

async function fixture(label: string, options: { amount?: string; exchangeRate?: string; status?: string; lc?: boolean; credit?: boolean } = {}) {
  const id = `${prefix}-${++sequence}-${label}`, actorId = `${id}-actor`, roleId = `${id}-role`, quotationId = `${id}-quote`,
    relationId = `${id}-customer`, orderId = `${id}-order`, amount = options.amount ?? '25.0001', exchangeRate = options.exchangeRate ?? '7.1234';
  const now = BigInt(Date.now());
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id: actorId, displayName: 'Synthetic native PI finance operator', status: 'active' } });
    await tx.role.create({ data: { id: roleId, name: 'Synthetic exact PI operator', isSystem: false } });
    await tx.userRole.create({ data: { id: `${id}-user-role`, userId: actorId, roleId } });
    await tx.userPermissionOverrides.create({ data: { id: `${id}-grant`, userId: actorId, scope: 'invoices:write',
      isActive: true, grantedBy: actorId, reason: 'Explicit private native PI fixture grant' } });
    await tx.relation.create({ data: { id: relationId, name: `${id}-Customer`, category: 'Customer', type: 'Company',
      isOrganization: true, contactInfo: '{}', tags: [], salesRepIds: [], ownerId: actorId, lastInteraction: now } });
    await tx.order.create({ data: { id: orderId, customer: `${id}-Customer`, product: 'Synthetic fabric', type: 'fabric',
      quantity: 1, quoteAmount: amount, currency: 'USD', status: 'Pending', dueDate: '2099-12-31',
      paymentInstrument: options.lc ? 'L/C' : 'T/T', customerRelationId: relationId, ownerId: actorId, updatedAt: now } });
    await tx.quotation.create({ data: { id: quotationId, quotationNumber: `${id}-QT`, status: options.status ?? 'Accepted',
      currency: 'USD', totalAmount: amount, exchangeRate, baseCurrency: 'CNY', customerRelationId: relationId,
      customerName: `${id}-Customer`, convertedOrderId: orderId, paymentInstrument: options.lc ? 'L/C' : 'T/T',
      issueDate: '2026-10-01', ownerId: actorId, createdAt: now, updatedAt: now,
      lines: { create: { id: `${id}-line`, lineNumber: 1, description: 'Exact synthetic commercial source', fabricCode: `${id}-fabric`,
        quantity: '1', unit: 'M', unitPrice: amount, amount, createdAt: now } } } });
    if (options.credit) await tx.creditLimit.create({ data: { id: `${id}-credit`, relationId, currency: 'USD',
      totalLimit: '1000', usedAmount: '0', validFrom: '2026-01-01', status: 'Active', createdAt: now, updatedAt: now } });
  });
  const loaded = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), actorId));
  expect(loaded.permissions).toEqual(['invoices:write']); expect(loaded.roles).toEqual([]); expect(loaded.roleIds).toEqual([roleId]);
  return { id, actorId, quotationId, relationId, orderId, amount, exchangeRate, loaded, token: auth.signToken(loaded) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Actual IOA source consumption needs both current capabilities. The ordinary
 * PI fixture intentionally retains its independent invoices-only policy. */
async function withAllocatedOrderRead(item: Fixture): Promise<Fixture> {
  await db().userPermissionOverrides.create({ data: { id: `${item.id}-orders-read-grant`, userId: item.actorId,
    scope: 'orders:read', isActive: true, grantedBy: item.actorId, reason: 'Explicit private native allocated Order source-read grant' } });
  const loaded = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), item.actorId));
  expect([...loaded.permissions!].sort()).toEqual(['invoices:write', 'orders:read']);
  expect(loaded.roles).toEqual([]); expect(loaded.roleIds).toEqual(item.loaded.roleIds);
  return { ...item, loaded, token: auth.signToken(loaded) };
}
function application(globalSnapshot = true) {
  const app = express(); app.use(express.json());
  if (globalSnapshot) {
    app.use(createAccountStatusGuard(db()));
    app.use(createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  }
  app.use('/api/v2/finance', createFinanceV2Router({ prisma: client(), requireAuth: true, apiKeys: new Set() }));
  return app;
}
function generate(item: Fixture, body: Record<string, unknown> = {}) {
  return request(application()).post(`/api/v2/finance/quotations/${item.quotationId}/generate-pi`)
    .set('Authorization', `Bearer ${item.token}`).send({ issueDate: '2028-02-29', ...body });
}
function convert(item: Fixture, piId: string, body: Record<string, unknown> = {}) {
  return request(application()).post(`/api/v2/finance/invoices/${piId}/convert-to-receivable`)
    .set('Authorization', `Bearer ${item.token}`).send({ issueDate: '2028-03-01', ...body });
}
async function generated(item: Fixture) {
  const res = await generate(item); expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body).toMatchObject({ ok: true, invoice: { type: 'Proforma', status: 'Draft', orderId: item.orderId } });
  return db().invoice.findUniqueOrThrow({ where: { id: res.body.invoice.id } });
}
async function snapshot(item: Fixture) {
  return { quotation: await db().quotation.findUniqueOrThrow({ where: { id: item.quotationId }, include: { lines: true } }),
    invoices: await db().invoice.findMany({ where: { customerRelationId: item.relationId }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: item.actorId }, orderBy: { id: 'asc' } }),
    number: await db().sequenceRegister.findUnique({ where: { id: `SEQREG_invoice_${periodKeyForDate('year', new Date())}` } }),
    credit: await db().creditLimit.findMany({ where: { relationId: item.relationId } }),
    creditHistory: await db().creditLimitHistory.findMany({ where: { relationId: item.relationId }, orderBy: { id: 'asc' } }) };
}
const code = (res: any) => res.body.error?.code ?? res.body.error;
function noLeaks(res: any) {
  expect(JSON.stringify(res.body)).not.toMatch(/native_pi_missing|missing-audit-actor|P2003|P2010|PrismaClient|SELECT|SequenceRegister|已回滚|未写入/);
}

// Keep strict native facts; no mocked approval flag/Invoice result or fabricated
// audit. These tests cover only the PI lane, not company-user UAT or PDF rendering.
describe('native PI private PostgreSQL and actual Finance V2 HTTP', () => {
  it('PIN01 Accepted commercial source generates a Draft PI with exact source snapshot and native audit', async () => {
    const item = await fixture('generate'), pi = await generated(item);
    expect(pi).toMatchObject({ type: 'Proforma', status: 'Draft', orderId: item.orderId, ownerId: item.actorId, dueDate: null });
    expect(pi.amount.toString()).toBe(item.amount); expect(pi.exchangeRate?.toString()).toBe(item.exchangeRate);
    expect(pi.attachments).toMatchObject({ quotationId: item.quotationId, quotationNumber: `${item.id}-QT`,
      lines: [{ quantity: '1', unitPrice: item.amount, amount: item.amount, unit: 'M' }] });
    const audits = await db().auditLog.findMany({ where: { targetId: pi.id, action: 'generate_proforma_from_quotation' } });
    expect(audits).toHaveLength(1); expect(audits[0].actorId).toBe(item.actorId);
    expect(audits[0].detail).toMatchObject({ source: 'proforma-invoice:generate',
      before: { quotationId: item.quotationId, quotationNumber: `${item.id}-QT` }, after: { invoiceId: pi.id, amount: item.amount, currency: 'USD' } });
    expect(await db().invoice.count({ where: { customerRelationId: item.relationId, type: 'Receivable' } })).toBe(0);
  });

  it('PIN02 native Draft→Issued→convert creates one Issued Receivable, cancels original PI and preserves audit/snapshot', async () => {
    const item = await fixture('issued'), pi = await generated(item);
    const issue = await updateInvoice({ prisma: db(), invoiceId: pi.id, input: { status: 'Issued' }, actorId: item.actorId });
    expect(issue.ok, JSON.stringify(issue.error)).toBe(true);
    const res = await convert(item, pi.id); expect(res.status, JSON.stringify(res.body)).toBe(200);
    const formal = await db().invoice.findUniqueOrThrow({ where: { id: res.body.invoice.id } });
    expect(formal).toMatchObject({ type: 'Receivable', status: 'Issued', ownerId: item.actorId, customerRelationId: item.relationId });
    expect(formal.amount.toString()).toBe(item.amount); expect(formal.attachments).toMatchObject({ quotationId: item.quotationId,
      proformaInvoiceId: pi.id, proformaInvoiceNumber: pi.invoiceNumber });
    const original = await db().invoice.findUniqueOrThrow({ where: { id: pi.id } });
    expect(original.status).toBe('Cancelled'); expect(original.notes).toContain(formal.invoiceNumber);
    const audit = await db().auditLog.findFirstOrThrow({ where: { targetId: formal.id, action: 'convert_proforma_to_receivable' } });
    expect(audit.actorId).toBe(item.actorId); expect(audit.detail).toMatchObject({ source: 'proforma-invoice:convert',
      before: { proformaInvoiceId: pi.id, proformaStatus: 'Issued' }, after: { receivableInvoiceId: formal.id, status: 'Issued', amount: item.amount } });
  });

  it('PIN03 Decimal header/FX/source lines survive generation and legal Draft conversion with all four decimals', async () => {
    const item = await fixture('precision', { amount: '9007199254740.1234', exchangeRate: '12345678901.1234' }), pi = await generated(item);
    expect(pi.amount.toString()).toBe(item.amount); expect(pi.exchangeRate?.toString()).toBe(item.exchangeRate);
    const res = await convert(item, pi.id); expect(res.status, JSON.stringify(res.body)).toBe(200);
    const formal = await db().invoice.findUniqueOrThrow({ where: { id: res.body.invoice.id } });
    expect(formal.amount.toString()).toBe(item.amount); expect(formal.exchangeRate?.toString()).toBe(item.exchangeRate);
    expect(formal.attachments).toMatchObject({ lines: [{ quantity: '1', unitPrice: item.amount, amount: item.amount }] });
    const audits = await db().auditLog.findMany({ where: { actorId: item.actorId, action: { in: ['generate_proforma_from_quotation', 'convert_proforma_to_receivable'] } } });
    expect(audits).toHaveLength(2); for (const audit of audits) expect(audit.detail).toMatchObject({ after: { amount: item.amount } });
  });

  it.each(['generate', 'convert'] as const)('PIN04-%s actual audit SQL P2003 rolls back Invoice/PI/sequence/credit and returns safe HTTP 500', async phase => {
    const item = await fixture(`audit-${phase}`, { credit: true }), pi = phase === 'convert' ? await generated(item) : null,
      before = await snapshot(item), published = vi.spyOn(events, 'publishBusinessEvent');
    const probe: Fault = { kind: 'audit', phase, actorId: item.actorId, reached: 0 }; fault = probe;
    const res = phase === 'generate' ? await generate(item) : await convert(item, pi!.id);
    expect(res.status, JSON.stringify(res.body)).toBe(500); expect(code(res)).toBe('INTERNAL_ERROR');
    expect(probe.reached).toBe(1); expect(probe.actualCode).toBe('P2003'); noLeaks(res);
    expect(await snapshot(item), 'Real failed native tx has zero partial business/number/audit/credit writes').toEqual(before);
    expect(published).not.toHaveBeenCalled();
  });

  it('PIN05 concurrent real conversions create exactly one native formal Invoice and one conversion audit', async () => {
    const item = await fixture('race'), pi = await generated(item), beforeNumber = (await snapshot(item)).number;
    const results = await Promise.all([convert(item, pi.id), convert(item, pi.id)]);
    expect(results.map(res => res.status).sort()).toEqual([200, 400]);
    const rejected = results.find(res => res.status !== 200)!; expect(code(rejected)).toBe('ALREADY_CONVERTED');
    const rows = await db().invoice.findMany({ where: { customerRelationId: item.relationId } });
    const formals = rows.filter(row => row.type === 'Receivable'); expect(formals).toHaveLength(1);
    expect(rows.find(row => row.id === pi.id)?.status).toBe('Cancelled');
    expect(formals[0].attachments).toMatchObject({ proformaInvoiceId: pi.id });
    expect(await db().auditLog.count({ where: { actorId: item.actorId, action: 'convert_proforma_to_receivable' } })).toBe(1);
    expect((await snapshot(item)).number!.currentSeq).toBe(beforeNumber!.currentSeq + 1);
  });

  it('PIN06 cancelled/native formal/missing PI source refusals preserve all original facts', async () => {
    const item = await fixture('source-refusal'), pi = await generated(item), converted = await convert(item, pi.id);
    expect(converted.status, JSON.stringify(converted.body)).toBe(200);
    const before = await snapshot(item);
    for (const [id, status, expected] of [[pi.id, 400, 'ALREADY_CONVERTED'], [converted.body.invoice.id, 400, 'NOT_PROFORMA'], [`${item.id}-missing`, 404, 'NOT_FOUND']] as const) {
      const res = await convert(item, id); expect(res.status, JSON.stringify(res.body)).toBe(status); expect(code(res)).toBe(expected);
      expect(await snapshot(item)).toEqual(before);
    }
  });

  it('PIN07 Draft/soft-deleted quotation cannot be turned into a PI or burn a number', async () => {
    const item = await fixture('bad-quote', { status: 'Draft' });
    let before = await snapshot(item), res = await generate(item);
    expect(res.status, JSON.stringify(res.body)).toBe(400); expect(code(res)).toBe('QUOTATION_NOT_ACCEPTED'); expect(await snapshot(item)).toEqual(before);
    await db().quotation.update({ where: { id: item.quotationId }, data: { status: 'Accepted', deletedAt: BigInt(Date.now()) } });
    before = await snapshot(item); res = await generate(item);
    expect(res.status, JSON.stringify(res.body)).toBe(404); expect(code(res)).toBe('QUOTATION_NOT_FOUND'); expect(await snapshot(item)).toEqual(before);
  });

  it('PIN08 real L/C issue refusal leaves PI usable and never writes a formal Invoice or sequence', async () => {
    const item = await fixture('lc-blocked', { lc: true }), pi = await generated(item), before = await snapshot(item), res = await convert(item, pi.id);
    expect(res.status, JSON.stringify(res.body)).toBe(403); expect(code(res)).toBe('LC_GATE_BLOCKED');
    expect(res.body.message).toContain('请先登记或核对 L/C，确需例外请按 DR-013 申请。'); expect(await snapshot(item)).toEqual(before);
  });

  it.each(['generate', 'convert'] as const)('PIN09-%s actual sequence SQL P2010 rolls back and is a safe service failure, not HTTP 400', async phase => {
    const item = await fixture(`number-${phase}`), pi = phase === 'convert' ? await generated(item) : null, before = await snapshot(item);
    const probe: Fault = { kind: 'sequence', phase, actorId: item.actorId, reached: 0 }; fault = probe;
    const res = phase === 'generate' ? await generate(item) : await convert(item, pi!.id);
    expect(res.status, JSON.stringify(res.body)).toBe(500); expect(code(res)).toBe('SEQUENCE_FAILED');
    expect(probe.reached).toBe(1); expect(probe.actualCode).toBe('P2010'); expect(probe.sqlState).toBe('42703');
    noLeaks(res); expect(await snapshot(item)).toEqual(before);
  });

  it.each([
    ['generate', 'issueDate', '2026-13-45'], ['generate', 'dueDate', '2026-02-30'],
    ['convert', 'issueDate', '2026-02-30'], ['convert', 'dueDate', '2026-13-45'],
  ] as const)('PIN10 %s real invalid calendar %s=%s writes no business row/audit/number', async (phase, field, value) => {
    const item = await fixture(`date-${phase}-${field}`), pi = phase === 'convert' ? await generated(item) : null, before = await snapshot(item);
    const res = phase === 'generate' ? await generate(item, { [field]: value }) : await convert(item, pi!.id, { [field]: value });
    expect(res.status, JSON.stringify(res.body)).toBe(400); expect(code(res)).toBe('INVALID_STATUS');
    expect(res.body.message).toContain(field === 'issueDate' ? '开票日期不正确' : '到期日期不正确');
    expect(await snapshot(item)).toEqual(before);
  });
});

// These controls deliberately omit the global snapshot middleware for some
// requests, retaining the actual JWT/module permission middleware. This proves
// the native service itself reloads authority instead of trusting old JWT grants.
function nativeCommand(item: Fixture, phase: 'generate' | 'convert', piId?: string, body: Record<string, unknown> = {}, token = item.token) {
  return request(application(false)).post(phase === 'generate'
    ? `/api/v2/finance/quotations/${item.quotationId}/generate-pi`
    : `/api/v2/finance/invoices/${piId}/convert-to-receivable`)
    .set('Authorization', `Bearer ${token}`).send({ issueDate: '2028-03-01', ...body });
}
async function extraOrder(item: Fixture, label: string, customerRelationId = item.relationId, ownerId = item.actorId) {
  const id = `${item.id}-${label}-order`;
  await db().order.create({ data: { id, customer: `${item.id}-Customer`, product: 'Synthetic additional actual parent', type: 'fabric',
    quantity: 1, quoteAmount: item.amount, currency: 'USD', status: 'Pending', dueDate: '2099-12-31',
    paymentInstrument: 'T/T', customerRelationId, ownerId, updatedAt: BigInt(Date.now()) } });
  return id;
}
async function shareSource(item: Fixture, other: Fixture) {
  // Supporting organizational fixtures are synthetic; the native PI Invoice,
  // allocation and mandatory audit below are produced by real services.
  await db().relation.update({ where: { id: item.relationId }, data: { ownerId: other.actorId } });
  const teamId = `${item.id}-shared-team`, grantId = `${item.id}-shared-grant`;
  await db().team.create({ data: { id: teamId, name: 'Synthetic private PI shared source', status: 'active' } });
  await db().teamMember.create({ data: { id: `${item.id}-shared-member`, teamId, userId: item.actorId } });
  await db().teamDataGrant.create({ data: { id: grantId, teamId, entityType: 'relation', entityId: item.relationId,
    permission: 'read', grantedBy: other.actorId } });
  return grantId;
}
async function requireNoWrite(item: Fixture, before: Awaited<ReturnType<typeof snapshot>>, response: any, status: number, expectedCode: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status); expect(code(response)).toBe(expectedCode);
  noLeaks(response); expect(await snapshot(item), 'Denied native PI command changed no business/number/audit/credit fact').toEqual(before);
}

describe('native PI current authority and exact source L2', () => {
  it.each(['order-id', 'order-line'] as const)('PINA14-%s quote for an existing order preserves its actual parent through PI and formal invoice', async source => {
    const item = await fixture(`existing-${source}`);
    const lineId = `${item.id}-actual-order-line`;
    if (source === 'order-line') await db().orderLine.create({ data: { id: lineId, orderId: item.orderId, lineNumber: 1,
      itemNo: '0010', quantity: 1, unit: 'M', description: 'Existing quote source' } });
    await db().quotation.update({ where: { id: item.quotationId }, data: { convertedOrderId: null,
      orderId: source === 'order-id' ? item.orderId : null, orderLineId: source === 'order-line' ? lineId : null } });
    const pi = await generated(item), res = await convert(item, pi.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200); expect(res.body.invoice.orderId).toBe(item.orderId);
    expect((await db().invoice.findUniqueOrThrow({ where: { id: pi.id } })).status).toBe('Cancelled');
  });
  it.each(['order-id', 'order-line'] as const)('PINA15-%s existing-order quote cannot discard its L/C gate while generating PI', async source => {
    const item = await fixture(`existing-lc-${source}`, { lc: true });
    const lineId = `${item.id}-actual-order-line`;
    if (source === 'order-line') await db().orderLine.create({ data: { id: lineId, orderId: item.orderId, lineNumber: 1,
      itemNo: '0010', quantity: 1, unit: 'M', description: 'Existing L/C quote source' } });
    await db().quotation.update({ where: { id: item.quotationId }, data: { convertedOrderId: null,
      orderId: source === 'order-id' ? item.orderId : null, orderLineId: source === 'order-line' ? lineId : null } });
    const pi = await generated(item), before = await snapshot(item);
    await requireNoWrite(item, before, await convert(item, pi.id), 403, 'LC_GATE_BLOCKED');
  });
  it('PINA16 converted order is the financial parent while a different original source remains an authorization parent', async () => {
    const item = await fixture('converted-with-origin'), second = await extraOrder(item, 'second'), other = await fixture('origin-other-owner');
    await db().quotation.update({ where: { id: item.quotationId }, data: { orderId: second } });
    const pi = await generated(item); expect(pi.orderId).toBe(item.orderId);
    expect(await db().invoiceOrderAllocation.count({ where: { invoiceId: pi.id } })).toBe(0);
    await db().order.update({ where: { id: second }, data: { ownerId: other.actorId, customerRelationId: other.relationId } });
    await requireNoWrite(item, await snapshot(item), await convert(item, pi.id), 404, 'NOT_FOUND');
  });
  it('PINA17 a legacy PI missing its real quotation Order cannot become an unallocated formal invoice', async () => {
    const item = await fixture('legacy-missing-parent'), pi = await generated(item);
    await db().invoice.update({ where: { id: pi.id }, data: { orderId: null } });
    await requireNoWrite(item, await snapshot(item), await convert(item, pi.id), 409, 'CONFLICT');
  });
  it.each(['generate', 'convert'] as const)('PINA13-%s actual canonical owner cannot restore a revoked invoice write grant', async phase => {
    const item = await fixture(`canonical-revoke-${phase}`);
    await db().role.upsert({ where: { id: 'owner' }, update: {}, create: { id: 'owner', name: 'Synthetic canonical owner', isSystem: true } });
    await db().userRole.create({ data: { id: `${item.id}-canonical-owner`, userId: item.actorId, roleId: 'owner' } });
    const loaded = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), item.actorId));
    expect(loaded.roles).toContain('owner'); expect(loaded.permissions).toContain('invoices:write');
    const owner = { ...item, loaded, token: auth.signToken(loaded) };
    const pi = phase === 'convert' ? await generated(owner) : null;
    await db().userPermissionOverrides.update({ where: { id: `${item.id}-grant` }, data: { isActive: false } });
    const current = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), item.actorId));
    expect(current.roles).toContain('owner'); expect(current.permissions).not.toContain('invoices:write');
    const before = await snapshot(owner);
    await requireNoWrite(owner, before, await nativeCommand(owner, phase, pi?.id), 403, 'FORBIDDEN');
  });
  it.each(['generate', 'convert'] as const)('PINA00-%s actual HTTP without a signed identity cannot create a PI or formal invoice', async phase => {
    const item = await fixture(`missing-identity-${phase}`), pi = phase === 'convert' ? await generated(item) : null, before = await snapshot(item);
    const res = await request(application()).post(phase === 'generate'
      ? `/api/v2/finance/quotations/${item.quotationId}/generate-pi`
      : `/api/v2/finance/invoices/${pi!.id}/convert-to-receivable`).send({ issueDate: '2028-03-01', actorId: item.actorId, trustedActor: item.loaded });
    expect(res.status, JSON.stringify(res.body)).toBe(401); noLeaks(res); expect(await snapshot(item)).toEqual(before);
  });

  it.each(['generate', 'convert'] as const)('PINA01-%s stale signed write grant cannot survive actual stored revocation', async phase => {
    const item = await fixture(`revoke-${phase}`), pi = phase === 'convert' ? await generated(item) : null;
    await db().userPermissionOverrides.update({ where: { id: `${item.id}-grant` }, data: { isActive: false } });
    const before = await snapshot(item);
    await requireNoWrite(item, before, await nativeCommand(item, phase, pi?.id), 403, 'FORBIDDEN');
    // No role is added and no revoked scope is repaired by a request body.
    expect((await db().userPermissionOverrides.findUniqueOrThrow({ where: { id: `${item.id}-grant` } })).isActive).toBe(false);
  });

  it.each([
    ['generate', 'disabled'], ['convert', 'disabled'], ['generate', 'deleted'], ['convert', 'deleted'],
  ] as const)('PINA02-%s current account %s rejects despite an earlier valid signed token', async (phase, state) => {
    const item = await fixture(`account-${phase}-${state}`), pi = phase === 'convert' ? await generated(item) : null;
    await db().userAccount.update({ where: { id: item.actorId }, data: state === 'disabled' ? { status: 'disabled' } : { deletedAt: BigInt(Date.now()) } });
    const before = await snapshot(item);
    await requireNoWrite(item, before, await nativeCommand(item, phase, pi?.id), 401, 'UNAUTHORIZED');
  });

  it.each(['generate', 'convert'] as const)('PINA03-%s actual write authority remains bounded by an explicitly empty signed ceiling', async phase => {
    const item = await fixture(`cap-${phase}`), pi = phase === 'convert' ? await generated(item) : null;
    const token = auth.signToken({ ...item.loaded, permissionCeiling: [] }), before = await snapshot(item);
    await requireNoWrite(item, before, await nativeCommand(item, phase, pi?.id, {}, token), 403, 'FORBIDDEN');
    expect((await loadUserWithRoles(db(), item.actorId))?.id).toBe(item.actorId);
  });

  it('PINA04 URL quotation is the sole source and mismatched body quotationId cannot create either invoice', async () => {
    const item = await fixture('url-source'), other = await fixture('body-source'), before = await snapshot(item), otherBefore = await snapshot(other);
    const res = await generate(item, { quotationId: other.quotationId });
    await requireNoWrite(item, before, res, 400, 'INVALID_INPUT'); expect(await snapshot(other)).toEqual(otherBefore);
  });

  it('PINA05 body authority cannot restore revoked scope and body money/ownership cannot override actual source', async () => {
    const item = await fixture('body-authority'), other = await fixture('body-privileged');
    await db().userPermissionOverrides.update({ where: { id: `${item.id}-grant` }, data: { isActive: false } });
    let before = await snapshot(item);
    const forged = { actorId: other.actorId, trustedActor: { ...other.loaded, roles: ['owner'], permissions: ['*'] },
      roles: ['admin'], permissions: ['*'], amount: '999', customerRelationId: other.relationId, ownerId: other.actorId, type: 'Receivable' };
    await requireNoWrite(item, before, await nativeCommand(item, 'generate', undefined, forged), 403, 'FORBIDDEN');
    await db().userPermissionOverrides.update({ where: { id: `${item.id}-grant` }, data: { isActive: true } });
    const res = await generate(item, forged); expect(res.status, JSON.stringify(res.body)).toBe(200);
    const invoice = await db().invoice.findUniqueOrThrow({ where: { id: res.body.invoice.id } });
    expect(invoice).toMatchObject({ type: 'Proforma', customerRelationId: item.relationId, ownerId: item.actorId });
    expect(invoice.amount.toString()).toBe(item.amount);
    expect((await db().auditLog.findFirstOrThrow({ where: { targetId: invoice.id, action: 'generate_proforma_from_quotation' } })).actorId).toBe(item.actorId);
  });

  it('PINA06 followed customer and actual converted Order are separately required visible parents', async () => {
    const item = await fixture('hidden-customer'), other = await fixture('hidden-owner');
    await db().relation.update({ where: { id: item.relationId }, data: { ownerId: other.actorId } });
    await requireNoWrite(item, await snapshot(item), await generate(item), 404, 'NOT_FOUND');
    await db().relation.update({ where: { id: item.relationId }, data: { ownerId: item.actorId } });
    await db().quotation.update({ where: { id: item.quotationId }, data: { convertedOrderId: other.orderId } });
    await requireNoWrite(item, await snapshot(item), await generate(item), 404, 'NOT_FOUND');
  });

  it('PINA07 real team-shared source is usable and revocation defeats a previously warmed team cache', async () => {
    const item = await fixture('shared'), other = await fixture('shared-owner'), grantId = await shareSource(item, other);
    const shares = createTeamShareService(db());
    expect(await shares.getActiveGrantedRelationIds(item.actorId)).toContain(item.relationId);
    const pi = await generated(item);
    await db().teamDataGrant.update({ where: { id: grantId }, data: { revokedAt: new Date(), revokedBy: other.actorId } });
    expect(await shares.getActiveGrantedRelationIds(item.actorId), 'The read cache deliberately still contains the old grant').toContain(item.relationId);
    const before = await snapshot(item);
    await requireNoWrite(item, before, await generate(item), 404, 'NOT_FOUND');
    await requireNoWrite(item, before, await convert(item, pi.id), 404, 'NOT_FOUND');
    expect((await db().invoice.findUniqueOrThrow({ where: { id: pi.id } })).status).toBe('Draft');
  });

  it('PINA08 exact Invoice finance scope remains required independently of visible source Order', async () => {
    const item = await fixture('invoice-scope'), other = await fixture('invoice-owner'), pi = await generated(item);
    // Explicit post-formation scope mutation is a negative, not a fabricated
    // PI/Approved invoice positive. The PI and its generation audit are real.
    await db().invoice.update({ where: { id: pi.id }, data: { ownerId: other.actorId } });
    await requireNoWrite(item, await snapshot(item), await convert(item, pi.id), 404, 'NOT_FOUND');
  });

  it.each([false, true])('PINA09 native active co-order attachments all participate in conversion visibility hidden=%s', async hidden => {
    const item = await withAllocatedOrderRead(await fixture(`co-order-${hidden}`)), other = await fixture(`co-order-other-${hidden}`), pi = await generated(item), second = await extraOrder(item, 'second');
    const attach = await updateInvoice({ prisma: db(), invoiceId: pi.id, actorId: item.actorId,
      input: { orderAllocations: [{ orderId: item.orderId, allocatedAmount: '10' }, { orderId: second, allocatedAmount: '15.0001' }] } });
    expect(attach.ok, JSON.stringify(attach.error)).toBe(true);
    expect(await db().invoiceOrderAllocation.count({ where: { invoiceId: pi.id, deletedAt: null } })).toBe(2);
    if (hidden) {
      await db().order.update({ where: { id: second }, data: { customerRelationId: other.relationId, ownerId: other.actorId } });
      await requireNoWrite(item, await snapshot(item), await convert(item, pi.id), 404, 'NOT_FOUND');
    } else {
      const res = await convert(item, pi.id); expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await db().invoice.findUniqueOrThrow({ where: { id: pi.id } })).status).toBe('Cancelled');
      expect((await db().invoice.findUniqueOrThrow({ where: { id: res.body.invoice.id } })).type).toBe('Receivable');
    }
  });

  it.each(['generate', 'convert'] as const)('PINA10-%s real authorization SQL failure is safe 503 with zero document/number/audit writes', async phase => {
    const item = await fixture(`authority-sql-${phase}`), pi = phase === 'convert' ? await generated(item) : null, before = await snapshot(item);
    const probe: Fault = { kind: 'authorization', phase, actorId: item.actorId, reached: 0 }; fault = probe;
    await requireNoWrite(item, before, await nativeCommand(item, phase, pi?.id), 503, 'DEPENDENCY_CHECK_FAILED');
    expect(probe.reached).toBe(1); expect(probe.actualCode).toBe('P2010'); expect(probe.sqlState).toBe('42703');
  });

  it('PINA11 real fresh team-scope SQL failure cannot masquerade as an empty source list or invisible success', async () => {
    const item = await fixture('scope-sql'), other = await fixture('scope-sql-owner'); await shareSource(item, other);
    const before = await snapshot(item), probe: Fault = { kind: 'scope', phase: 'generate', actorId: item.actorId, reached: 0 }; fault = probe;
    await requireNoWrite(item, before, await generate(item), 503, 'DEPENDENCY_CHECK_FAILED');
    expect(probe.reached).toBe(1); expect(probe.actualCode).toBe('P2010'); expect(probe.sqlState).toBe('42703');
  });

  it('PINA12 post-lock actual source parent drift is 409 and rolls back the injected source change', async () => {
    const item = await fixture('parent-drift'), second = await extraOrder(item, 'drift-visible'), before = await snapshot(item);
    const probe: Fault = { kind: 'parent-drift', phase: 'generate', actorId: item.actorId, sourceId: item.quotationId, nextOrderId: second, reached: 0 }; fault = probe;
    await requireNoWrite(item, before, await generate(item), 409, 'CONFLICT');
    expect(probe.reached).toBe(1); expect(probe.reads).toBe(2);
  });
});

async function consolidatedPi(label: string) {
  const item = await withAllocatedOrderRead(await fixture(label)), pi = await generated(item), second = await extraOrder(item, 'carry');
  const batchService = createOrderShipmentBatchService(db()), batchIds: string[] = [];
  for (const [orderId, amount] of [[item.orderId, 10.1234], [second, 14.8767]] as const) {
    const created = await batchService.createBatch({ orderId, amount, currency: 'USD', plannedQty: 1, unit: 'M' }, item.actorId);
    expect(created.ok, JSON.stringify(created.ok ? undefined : created.error)).toBe(true);
    if (!created.ok) throw Error('Native supporting planned batch creation failed');
    batchIds.push(created.data.id);
  }
  const attached = await updateInvoice({ prisma: db(), invoiceId: pi.id, actorId: item.actorId, input: { orderAllocations: [
    { orderId: item.orderId, batchId: batchIds[0], allocatedAmount: '10.1234', note: 'Native first planned batch' },
    { orderId: second, batchId: batchIds[1], allocatedAmount: '14.8767', note: 'Native second planned batch' },
  ] } });
  expect(attached.ok, JSON.stringify(attached.error)).toBe(true);
  const originals = await db().invoiceOrderAllocation.findMany({ where: { invoiceId: pi.id, deletedAt: null }, orderBy: { orderId: 'asc' } });
  expect(originals).toHaveLength(2);
  return { item, pi, second, batchIds, originals };
}
async function carrySnapshot(f: Awaited<ReturnType<typeof consolidatedPi>>) {
  return { business: await snapshot(f.item), originalInvoice: await db().invoice.findUniqueOrThrow({ where: { id: f.pi.id } }),
    invoicesByParent: await db().invoice.findMany({ where: { orderId: { in: [f.item.orderId, f.second] } }, orderBy: { id: 'asc' } }), allocations: await db().invoiceOrderAllocation.findMany({
    where: { orderId: { in: [f.item.orderId, f.second] } }, orderBy: { id: 'asc' },
  }), batches: await db().orderShipmentBatch.findMany({ where: { id: { in: f.batchIds } }, orderBy: { id: 'asc' } }) };
}
async function deniedCarry(f: Awaited<ReturnType<typeof consolidatedPi>>, before: Awaited<ReturnType<typeof carrySnapshot>>, status: number, expected: string) {
  const res = await convert(f.item, f.pi.id); expect(res.status, JSON.stringify(res.body)).toBe(status); expect(code(res)).toBe(expected);
  noLeaks(res); expect(await carrySnapshot(f), 'Native failed conversion must preserve all source allocations/batches and produce no partial AR').toEqual(before);
}

describe('native PI conversion preserves actual multi-order and planned-batch facts', () => {
  it('PINX01 native planned/null-shipment PI allocations carry exactly into AR while all original source/history remains', async () => {
    const f = await consolidatedPi('carry-planned'), sourceAudits = await db().auditLog.findMany({ where: { targetId: f.pi.id }, orderBy: { id: 'asc' } });
    expect((await carrySnapshot(f)).batches.every(row => row.status === 'planned' && row.shipmentId === null)).toBe(true);
    const res = await convert(f.item, f.pi.id); expect(res.status, JSON.stringify(res.body)).toBe(200);
    const formal = await db().invoice.findUniqueOrThrow({ where: { id: res.body.invoice.id } });
    expect(formal.amount.toString()).toBe('25.0001'); expect(formal.currency).toBe('USD'); expect(formal.type).toBe('Receivable');
    const carried = await db().invoiceOrderAllocation.findMany({ where: { invoiceId: formal.id, deletedAt: null }, orderBy: { orderId: 'asc' } });
    expect(carried).toHaveLength(2);
    for (let i = 0; i < f.originals.length; i++) {
      const original = f.originals[i], row = carried[i];
      expect(row.id).not.toBe(original.id); expect(row.invoiceId).toBe(formal.id);
      expect(row).toMatchObject({ orderId: original.orderId, batchId: original.batchId, note: original.note });
      expect(row.allocatedAmount?.toString()).toBe(original.allocatedAmount?.toString());
    }
    expect(await db().invoiceOrderAllocation.findMany({ where: { invoiceId: f.pi.id, deletedAt: null }, orderBy: { orderId: 'asc' } })).toEqual(f.originals);
    expect(await db().auditLog.findMany({ where: { targetId: f.pi.id }, orderBy: { id: 'asc' } })).toEqual(sourceAudits);
    const audit = await db().auditLog.findFirstOrThrow({ where: { targetId: formal.id, action: 'convert_proforma_to_receivable' } });
    expect(audit.detail).toMatchObject({ before: { proformaInvoiceId: f.pi.id, orderAllocations: expect.arrayContaining(f.originals.map(row => ({
      id: row.id, invoiceId: f.pi.id, orderId: row.orderId, batchId: row.batchId, allocatedAmount: row.allocatedAmount!.toString(), note: row.note,
    }))) }, after: { orderAllocations: expect.arrayContaining(carried.map(row => ({
      id: row.id, invoiceId: formal.id, sourceAllocationId: f.originals.find(source => source.orderId === row.orderId)!.id,
      orderId: row.orderId, batchId: row.batchId, allocatedAmount: row.allocatedAmount!.toString(), note: row.note,
    }))) } });
    for (const batch of await db().orderShipmentBatch.findMany({ where: { id: { in: f.batchIds } } })) {
      const line = carried.find(row => row.batchId === batch.id)!;
      expect(batch.invoicedAmount?.toString(), 'Awaited derived refresh counts new AR once and ignores cancelled original PI').toBe(line.allocatedAmount!.toString());
      expect(batch.status).toBe('planned'); expect(batch.shipmentId).toBeNull();
    }
  });

  it('PINX02 actual non-header L/C order without a registered LC blocks the whole conversion with zero writes', async () => {
    const f = await consolidatedPi('carry-lc');
    await db().order.update({ where: { id: f.second }, data: { paymentInstrument: 'L/C' } });
    expect((await db().order.findUniqueOrThrow({ where: { id: f.item.orderId } })).paymentInstrument).toBe('T/T');
    await deniedCarry(f, await carrySnapshot(f), 403, 'LC_GATE_BLOCKED');
  });

  it('PINX03 real native IOA PK P2002 failure rolls back newly staged AR/sequence and all source facts', async () => {
    const f = await consolidatedPi('carry-ioa-fault'), before = await carrySnapshot(f), published = vi.spyOn(events, 'publishBusinessEvent');
    const probe: Fault = { kind: 'allocation', phase: 'convert', actorId: f.item.actorId, sourceId: f.originals[0].id, reached: 0 }; fault = probe;
    await deniedCarry(f, before, 500, 'INTERNAL_ERROR'); expect(probe.reached).toBe(1); expect(probe.actualCode).toBe('P2002');
    expect(published).not.toHaveBeenCalled();
  });

  it('PINX04 actual mandatory audit FK P2003 after two AR allocations and PI cancellation rolls all staged facts back', async () => {
    const f = await consolidatedPi('carry-audit-fault'), before = await carrySnapshot(f), published = vi.spyOn(events, 'publishBusinessEvent');
    const probe: Fault = { kind: 'audit', phase: 'convert', actorId: f.item.actorId, sourceId: f.pi.id, expectedCarryCount: 2, reached: 0 }; fault = probe;
    await deniedCarry(f, before, 500, 'INTERNAL_ERROR'); expect(probe.reached).toBe(1); expect(probe.actualCode).toBe('P2003');
    expect(probe.stagedCarryCount, 'Independent control must observe both genuine AR child writes before the FK failure').toBe(2);
    expect(probe.stagedOriginalStatus).toBe('Cancelled'); expect(published).not.toHaveBeenCalled();
  });

  it.each(['currency', 'cancelled', 'missing-amount'] as const)('PINX05 damaged actual batch allocation %s cannot convert or silently repair historical facts', async damage => {
    const f = await consolidatedPi(`carry-damage-${damage}`);
    // Explicit post-formation corruption negatives; no synthetic final source
    // Invoice/IOA/confirmation substitutes for the real native positive above.
    if (damage === 'currency') await db().orderShipmentBatch.update({ where: { id: f.batchIds[0] }, data: { currency: 'EUR' } });
    if (damage === 'cancelled') await db().orderShipmentBatch.update({ where: { id: f.batchIds[0] }, data: { status: 'cancelled' } });
    if (damage === 'missing-amount') await db().invoiceOrderAllocation.update({ where: { id: f.originals[0].id }, data: { allocatedAmount: null } });
    await deniedCarry(f, await carrySnapshot(f), damage === 'currency' ? 409 : 400, damage === 'currency' ? 'CONFLICT' : 'INVALID_AMOUNT');
  });

  it('PINX06 native producer rejects PI bill-to mismatch when carrying source Orders into a Receivable', async () => {
    const f = await consolidatedPi('carry-billto'), other = await fixture('carry-other-billto');
    const changed = await updateInvoice({ prisma: db(), invoiceId: f.pi.id, actorId: f.item.actorId,
      input: { customerRelationId: other.relationId, customerName: `${other.id}-Customer` } });
    expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
    await deniedCarry(f, await carrySnapshot(f), 409, 'INVOICE_CUSTOMER_MISMATCH');
  });
});
