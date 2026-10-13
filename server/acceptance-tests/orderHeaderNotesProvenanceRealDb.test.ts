/** Opt-in private PostgreSQL + actual Order import/PUT/GET HTTP.
 * Parsed PO inputs are synthetic and bypass PDF extraction: the real native
 * import establishes Pending orders, lines and their import provenance. The
 * one explicitly labelled legacy fixture supplies INITIAL imported note
 * metadata because the current PO parser has no instructions field. Neither
 * is evidence of a real PDF, company default grants, approval or production.
 * Mandatory audit failure uses an actual FK violation after a staged write.
 * Never connect to the shared DB; verify physical identity before mutations.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createOrdersRouter } from '../src/orders/route';
import type { ParsedOrder } from '../src/import/types';

const prefix = `acceptance-order-header-${randomUUID()}`, actorId = `${prefix}-actor`;
let prisma: PrismaClient | undefined, token: string, sequence = 0;
const db = (): PrismaClient => { if (!prisma) throw Error('Private Order header PG identity not verified'); return prisma; };
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed independent acceptance sandbox is required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.create({ data: { id: actorId, displayName: 'Synthetic Order header employee', status: 'active' } });
  // A real canonical Finance role supplies the existing all-order READ scope.
  // Personal explicit read/write grants are synthetic preconditions, not a
  // claim that the ordinary company Finance/Sales default matrix grants them.
  await db().role.upsert({ where: { id: 'role-finance' }, update: {},
    create: { id: 'role-finance', name: 'Synthetic canonical Finance', isSystem: true } });
  await db().userRole.create({ data: { id: `${prefix}-assignment`, userId: actorId, roleId: 'role-finance' } });
  for (const scope of ['orders:read', 'orders:write']) {
    await db().userPermissionOverrides.create({ data: { id: `${prefix}-${scope}`, userId: actorId, scope,
      grantedBy: actorId, reason: 'Synthetic bounded actual header-route acceptance grant' } });
  }
  const user = await loadUserWithRoles(db(), actorId), actor = await buildLoadedAuthTokenPayload(db(), user);
  expect(actor.roles).toContain('finance'); expect(actor.authorizationLoaded).toBe(true);
  expect(actor.permissions).toEqual(expect.arrayContaining(['orders:read', 'orders:write']));
  token = createAuthService().signToken({ ...actor, permissionCeiling: ['orders:read', 'orders:write'] });
});
afterAll(async () => { await prisma?.$disconnect(); });

function application(client = db()) {
  const app = express(), changes: unknown[] = [];
  app.use(express.json()); app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  app.use(createAccountStatusGuard(client));
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: client, apiKeys: new Set() }));
  app.use('/api/v1/orders', createOrdersRouter({ prisma: client, requireAuth: true, apiKeys: new Set(), onDataChange: value => changes.push(value) }));
  return { app, changes };
}
type Application = ReturnType<typeof application>;
async function fixture(label: string) {
  const poNumber = `${prefix}-${++sequence}-${label}`, app = application();
  const parsed: ParsedOrder = { customerId: 'peerless', poNumber, season: 'SYNTHETIC', poDate: '2026-10-02',
    contactPerson: 'Software test contact', contactPhone: 'synthetic-no-call', currency: 'USD',
    deliveryTerms: 'Synthetic EXW', paymentTerms: 'Synthetic T/T terms', shipTo: { company: 'Synthetic consignee',
      contactName: 'Synthetic recipient', addressLines: ['Software test address'], country: 'CN' }, deliverTo: 'Synthetic destination',
    totalNet: 5000, totalActual: 5000, lines: [{ itemNo: '0010', materialCode: 'SYNTHETIC-SKU', millQuality: 'Test shade',
      description: 'Synthetic header provenance article', width: '150CM', exMillDate: '2026-11-01', deliveryDate: '2026-10-25',
      quantity: 200, unit: 'M', unitPrice: 25, netValue: 5000, via: 'Synthetic', cloth: 'Synthetic', weight: '100GSM' }] };
  const created = await request(app.app).post('/api/v1/orders/import').set('Authorization', `Bearer ${token}`).send({ orders: [parsed] });
  expect(created.status, json(created.body)).toBe(200); expect(created.body.ok).toBe(true);
  expect(created.body.created).toBe(1); expect(created.body.orders).toHaveLength(1);
  const id = created.body.orders[0].id as string;
  const order = await db().order.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
  expect(order.status).toBe('Pending'); expect(order.lines).toHaveLength(1);
  expect(order.specialInstructions).toBeNull(); expect(order.fieldSources).toMatchObject({ customer: 'pdf', paymentTerms: 'pdf', quoteAmount: 'pdf' });
  expect(order.lines[0].confirmedSourceId).toBeNull(); expect(order.lines[0].specSnapshot).toBeNull();
  return { id, app, order };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function fullHeader(order: Fixture['order']): Record<string, unknown> {
  // The real editor sends unchanged persisted header values too. Preserve
  // this compatibility; the server must compare values rather than keys.
  return { customer: order.customer, product: order.product, type: order.type, quantity: order.quantity,
    status: order.status, dueDate: order.dueDate, poNumber: order.poNumber, quoteAmount: order.quoteAmount.toString(),
    customerCode: order.customerCode, season: order.season, poDate: order.poDate, contactPerson: order.contactPerson,
    contactPhone: order.contactPhone, currency: order.currency, salesCurrency: order.salesCurrency, purchaseCurrency: order.purchaseCurrency,
    paymentTerms: order.paymentTerms, paymentInstrument: order.paymentInstrument, deliveryTerms: order.deliveryTerms,
    shipToName: order.shipToName, shipToAddress1: order.shipToAddress1, shipToAddress2: order.shipToAddress2,
    shipToCountry: order.shipToCountry, deliverTo: order.deliverTo, source: order.source, millName: order.millName,
    totalNet: order.totalNet?.toString() ?? null, totalActual: order.totalActual?.toString() ?? null,
    contractAmount: order.contractAmount?.toString() ?? null, salesPrice: order.salesPrice?.toString() ?? null,
    specialInstructions: order.specialInstructions, ocDays: order.ocDays, actualPaymentAmount: order.actualPaymentAmount?.toString() ?? null };
}
function put(item: Fixture, payload: Record<string, unknown>, app: Application = item.app) {
  return request(app.app).put(`/api/v1/orders/${item.id}`).set('Authorization', `Bearer ${token}`).send(payload);
}
async function get(item: Fixture) {
  const response = await request(item.app.app).get(`/api/v1/orders/${item.id}`).set('Authorization', `Bearer ${token}`);
  expect(response.status, json(response.body)).toBe(200); expect(response.body.ok).toBe(true); expect(response.body.order.id).toBe(item.id);
  return response.body.order;
}
async function snapshot(item: Fixture) {
  return { order: await db().order.findUniqueOrThrow({ where: { id: item.id } }),
    lines: await db().orderLine.findMany({ where: { orderId: item.id }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { targetType: 'Order', targetId: item.id }, orderBy: { id: 'asc' } }),
    references: await db().entityReference.findMany({ where: { ownerId: item.id }, orderBy: { id: 'asc' } }),
    links: await db().entityLink.findMany({ where: { fromId: item.id }, orderBy: { id: 'asc' } }) };
}
async function saved(item: Fixture, payload: Record<string, unknown>) {
  const response = await put(item, payload); expect(response.status, json(response.body)).toBe(200); expect(response.body.ok).toBe(true);
  const current = await db().order.findUniqueOrThrow({ where: { id: item.id } });
  expect(current.id).toBe(item.id); expect(current.status).toBe('Pending');
  expect(await db().orderLine.findMany({ where: { orderId: item.id }, orderBy: { lineNumber: 'asc' } })).toEqual(item.order.lines);
  const audits = await db().auditLog.findMany({ where: { targetId: item.id, action: 'update_order' } });
  expect(audits.length).toBeGreaterThan(0);
  expect(audits.every(row => row.actorId === actorId && (row.detail as any).source === 'route:orders:update')).toBe(true);
  return { response, current, readback: await get(item) };
}
const sources = (order: { fieldSources: unknown }) => order.fieldSources as Record<string, string>;

describe('native Order header instructions/provenance private PG', () => {
  it('OHN01 canonical specialInstructions survives native PUT response, physical DB and fresh GET', async () => {
    const item = await fixture('canonical'), notes = 'Synthetic notes; no external customer instruction';
    const result = await saved(item, { specialInstructions: notes });
    expect(result.response.body.order.specialInstructions).toBe(notes); expect(result.current.specialInstructions).toBe(notes);
    expect(result.readback.specialInstructions).toBe(notes); expect(sources(result.current).specialInstructions).toBe('manual');
    expect(result.current.quantity).toBe(200); expect(result.current.quoteAmount.toString()).toBe('5000');
  });
  it('OHN02 full unchanged header values retain every existing PDF source while only changed notes become manual', async () => {
    const item = await fixture('full-header'), original = sources(item.order), result = await saved(item, { ...fullHeader(item.order), specialInstructions: 'Actual new note' });
    expect(sources(result.current)).toEqual({ ...original, specialInstructions: 'manual' });
    expect(result.readback.fieldSources).toEqual({ ...original, specialInstructions: 'manual' });
    expect(result.current.specialInstructions).toBe('Actual new note');
  });
  it('OHN03 explicitly assumed INITIAL legacy imported notes become imported-then-edited and keep that fact on same-value replay', async () => {
    const item = await fixture('legacy-note');
    // No production parser currently produces this column. This is a clearly
    // labelled INITIAL legacy observation, not a fabricated native PDF/audit.
    const initialSources = { ...sources(item.order), specialInstructions: 'pdf' };
    await db().order.update({ where: { id: item.id }, data: { specialInstructions: 'Assumed initial legacy imported note', fieldSources: initialSources } });
    const first = await saved(item, { specialInstructions: 'Actually edited note' });
    expect(sources(first.current).specialInstructions).toBe('imported-then-edited');
    const repeated = await saved(item, { specialInstructions: 'Actually edited note' });
    expect(sources(repeated.current)).toEqual({ ...initialSources, specialInstructions: 'imported-then-edited' });
    expect(repeated.readback.specialInstructions).toBe('Actually edited note');
    // Same-value retry is not claimed as exact-request idempotency: this old
    // header API has no request key and may append another update audit.
  });
  it('OHN04 a full same-value header submission does not invent manual confirmation/provenance', async () => {
    const item = await fixture('same-value'), result = await saved(item, fullHeader(item.order));
    expect(sources(result.current)).toEqual(sources(item.order)); expect(result.current.specialInstructions).toBeNull();
    expect(result.readback.specialInstructions).toBeNull();
  });
  it('OHN05 explicitly clearing persisted notes to empty string roundtrips without clearing unrelated imported facts', async () => {
    const item = await fixture('clear-empty'); await saved(item, { specialInstructions: 'Notes to clear' });
    const result = await saved(item, { specialInstructions: '' });
    expect(result.current.specialInstructions).toBe(''); expect(result.readback.specialInstructions).toBe('');
    expect(sources(result.current)).toEqual({ ...sources(item.order), specialInstructions: 'manual' });
  });
  it('OHN06 explicitly clearing persisted notes to null retains unknown/null instead of defaulting back to old text', async () => {
    const item = await fixture('clear-null'); await saved(item, { specialInstructions: 'Notes to clear' });
    const result = await saved(item, { specialInstructions: null });
    expect(result.response.body.order.specialInstructions).toBeNull(); expect(result.current.specialInstructions).toBeNull();
    expect(result.readback.specialInstructions).toBeNull(); expect(sources(result.current)).toEqual({ ...sources(item.order), specialInstructions: 'manual' });
  });
  it('OHN07 unchanged nullable scalar inputs do not become invented known facts or manual sources', async () => {
    const item = await fixture('null-unchanged'), result = await saved(item, { specialInstructions: null, ocDays: null, actualPaymentAmount: null, paymentInstrument: null });
    expect(result.current).toMatchObject({ specialInstructions: null, ocDays: null, actualPaymentAmount: null, paymentInstrument: null });
    expect(sources(result.current)).toEqual(sources(item.order));
  });
  it('OHN08 explicit numeric zero differs from null while subsequent zero replay remains zero and preserves prior sources', async () => {
    const item = await fixture('zero-change'); expect(item.order.ocDays).toBeNull();
    const first = await saved(item, { ...fullHeader(item.order), ocDays: 0 });
    expect(first.current.ocDays).toBe(0); expect(first.readback.ocDays).toBe(0);
    expect(sources(first.current)).toEqual({ ...sources(item.order), ocDays: 'manual' });
    const repeated = await saved(item, { ocDays: 0 });
    expect(repeated.current.ocDays).toBe(0); expect(sources(repeated.current)).toEqual(sources(first.current));
    expect(repeated.current.actualPaymentAmount).toBeNull();
  });
  it('OHN09 numerically equivalent persisted Decimal representations do not mark imported amounts as manually edited', async () => {
    const item = await fixture('decimal-equal');
    const result = await saved(item, { quoteAmount: '5000.0000', totalNet: '5000.0000', contractAmount: '5000.0000', totalActual: '5000.0000' });
    expect(sources(result.current)).toEqual(sources(item.order));
    expect(result.current.quoteAmount.toString()).toBe('5000'); expect(result.current.totalNet!.toString()).toBe('5000');
    expect(result.current.contractAmount!.toString()).toBe('5000'); expect(result.current.totalActual!.toString()).toBe('5000');
  });
  it('OHN10 actual mandatory audit FK failure rolls back staged notes and provenance; a legitimate retry can then save', async () => {
    const item = await fixture('audit-rollback'), before = await snapshot(item), notes = 'Staged instruction must roll back';
    let reached = false, actualCode: string | undefined;
    const client = new Proxy(db(), { get(target, key) {
      if (key === '$transaction') return async (callback: any, ...args: any[]) => {
        if (typeof callback !== 'function') return (target.$transaction as any)(callback, ...args);
        return (target.$transaction as any)(async (tx: any) => callback(new Proxy(tx, { get(inner, model) {
          if (model === 'auditLog') return new Proxy(inner.auditLog, { get(delegate, operation) {
            if (operation === 'create') return async (input: any) => {
              if (input.data.action !== 'update_order') return delegate.create(input);
              const staged = await tx.order.findUniqueOrThrow({ where: { id: item.id } });
              expect(staged.specialInstructions, 'positive control: business write was staged before mandatory audit').toBe(notes);
              expect(sources(staged).specialInstructions).toBe('manual'); reached = true;
              try { return await delegate.create({ ...input, data: { ...input.data, actorId: `${prefix}-missing-audit-actor` } }); }
              catch (error) { expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError); actualCode = (error as Prisma.PrismaClientKnownRequestError).code; throw error; }
            };
            const value = Reflect.get(delegate, operation); return typeof value === 'function' ? value.bind(delegate) : value;
          } });
          const value = Reflect.get(inner, model); return typeof value === 'function' ? value.bind(inner) : value;
        } })), ...args);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const faulty = application(client), response = await put(item, { ...fullHeader(item.order), specialInstructions: notes }, faulty);
    expect(reached).toBe(true); expect(actualCode).toBe('P2003'); expect(response.status, json(response.body)).toBe(500);
    expect(response.body.error.code).toBe('UPDATE_FAILED'); expect(json(response.body)).not.toContain(`${prefix}-missing-audit-actor`);
    expect(await snapshot(item)).toEqual(before); expect(faulty.changes).toEqual([]);
    const retried = await saved(item, { ...fullHeader(item.order), specialInstructions: notes });
    expect(retried.current.specialInstructions).toBe(notes); expect(retried.readback.specialInstructions).toBe(notes);
    expect(sources(retried.current)).toEqual({ ...sources(item.order), specialInstructions: 'manual' });
  });
});
