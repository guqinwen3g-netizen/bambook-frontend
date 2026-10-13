/** Synthetic current accounts/configuration and source rows; actual JWT HTTP,
 * permission loader, Order L2, commission/canonical Invoice services, SQL locks
 * and PostgreSQL rollback. Run only in an independently verified private PG.
 * This does not prove company role assignments, UI or external payment.
 * The final control executes the original D4 fixture/hook body against native
 * storage; it is fixture-cleanup evidence, not another production endpoint. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createPricingRouter } from '../src/pricing/pricingRoute';
import { createCommissionPayable } from '../src/pricing/commissionPayableService';
import { businessEventBus, type BusinessEvent } from '../src/events/businessEventBus';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../src/__tests__/lib/drillTouchLog';
import { DEFAULT_ROLE_PERMISSION_MATRIX, SYSTEM_ROLE_IDS } from '../src/_shared/rolePermissionMatrix';

const prefix = 'acceptance-commission-authority-' + randomUUID();
let prisma: PrismaClient, serial = 0;
const queries: string[] = [], events: BusinessEvent[] = [];
let unsubscribe: (() => void) | undefined;
const db = () => { if (!prisma) throw Error('Independent commission PG not initialized'); return prisma; };
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, row) => typeof row === 'bigint' ? row.toString() : row);
async function currentActor(userId: string): Promise<TokenPayload> {
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(userId);
  if (!current) throw Error('Native synthetic account is not active');
  return { userId, roles: current.legacyRoleCodes, roleIds: current.roleIds, permissions: current.scopes,
    departmentIds: current.departmentIds, authorizationLoaded: true };
}
async function identity(id: string, scopes: string[]) {
  await db().userAccount.create({ data: { id, displayName: 'Synthetic commission authority', status: 'active' } });
  const roleId = id + '-pricing-role';
  await db().role.create({ data: { id: roleId, name: 'Synthetic scoped pricing capability', isSystem: false } });
  await db().userRole.create({ data: { id: id + '-user-role', userId: id, roleId } });
  for (const scope of scopes) {
    const permission = await db().permission.upsert({ where: { scope }, update: {}, create: { id: prefix + '-permission-' + scope, scope } });
    await db().rolePermission.create({ data: { id: id + '-grant-' + scope, roleId, permissionId: permission.id } });
  }
  const actor = await currentActor(id);
  return { id, roleId, actor, token: createAuthService().signToken(actor) };
}
function application(database = db()) {
  const app = express(); app.use(express.json());
  app.use('/api/v1/pricing', createPricingRouter({ prisma: database, requireAuth: true, apiKeys: new Set() })); return app;
}
async function fixture(label: string, scopes = ['pricing:write']) {
  const id = prefix + '-' + ++serial + '-' + label, user = await identity(id + '-user', scopes);
  const intermediary = await db().relation.create({ data: { id: id + '-intermediary', name: 'Synthetic actual intermediary',
    category: 'Supplier', type: 'Organization', isOrganization: true, tags: [], contactInfo: '', lastInteraction: BigInt(Date.now()), ownerId: user.id } });
  // Configured custom role has current self L2, not canonical Finance/all.
  const order = await db().order.create({ data: { id: id + '-order', customer: 'Synthetic own customer', product: 'Synthetic fabric',
    type: 'Fabric', quantity: 100, status: 'Confirmed', dueDate: '2026-12-31', quoteAmount: '150', currency: 'USD', ownerId: user.id } });
  const rule = await db().commissionRule.create({ data: { id: id + '-rule', name: 'Synthetic commission rule', rate: '5',
    intermediaryRelationId: intermediary.id, intermediaryName: intermediary.name, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  const pricing = await db().pricingCalculation.create({ data: { id: id + '-price', orderId: order.id, commissionRuleId: rule.id,
    purchaseCostCny: '10', refundRate: '13', exchangeRate: '7.2', profitMargin: '10', commissionRate: '5',
    netUsdCost: '1.2', profitAmount: '0.12', commissionAmount: '1.2345', finalUnitPrice: '1.5', quantity: '100',
    status: 'Confirmed', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  return { id, user, order, intermediary, rule, pricing, app: application() };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function post(f: Fixture, token = f.user.token, body: Record<string, unknown> = {}, app = f.app) {
  return request(app).post('/api/v1/pricing/orders/' + f.order.id + '/commission/payable').set('Authorization', 'Bearer ' + token).send(body);
}
function get(f: Fixture, token = f.user.token) {
  return request(f.app).get('/api/v1/pricing/orders/' + f.order.id + '/commission').set('Authorization', 'Bearer ' + token);
}
async function financialState(database: any = db()) {
  return { invoices: await database.invoice.findMany({ orderBy: { id: 'asc' } }),
    sequence: await database.businessSequence.findMany({ orderBy: { id: 'asc' } }),
    ioa: await database.invoiceOrderAllocation.findMany({ orderBy: { id: 'asc' } }),
    audits: await database.auditLog.findMany({ orderBy: { id: 'asc' } }),
    links: await database.entityLink.findMany({ orderBy: { id: 'asc' } }),
    references: await database.entityReference.findMany({ orderBy: { id: 'asc' } }) };
}
async function refusedBeforeSources(invoke: () => Promise<any>, status: number, code: string) {
  const before = await financialState(); queries.length = 0; events.length = 0;
  const response = await invoke(), reads = queries.filter(query => /\bSELECT\b/.test(query) && /"(?:PricingCalculation|CommissionRule|Invoice)"/.test(query));
  expect(response.status, diagnostic(response.body)).toBe(status);
  expect(typeof response.body.error === 'string' ? response.body.error : response.body.error.code).toBe(code);
  expect(reads, 'current authority/parent refusal precedes any commission/Invoice read').toEqual([]);
  expect(await financialState()).toEqual(before); expect(events).toEqual([]); return response;
}
async function cleanupOwn() {
  const own = { startsWith: prefix };
  await db().auditLog.deleteMany({ where: { actorId: own } });
  await db().invoice.deleteMany({ where: { sourceType: 'CommissionPayable', sourceId: own } });
  await db().pricingCalculation.deleteMany({ where: { id: own } }); await db().commissionRule.deleteMany({ where: { id: own } });
  await db().order.deleteMany({ where: { id: own } }); await db().relation.deleteMany({ where: { id: own } });
  await db().entityLink.deleteMany({ where: { OR: [{ fromId: own }, { toId: own }] } });
  await db().entityReference.deleteMany({ where: { OR: [{ ownerId: own }, { targetId: own }] } });
  await db().userRole.deleteMany({ where: { roleId: own } }); await db().rolePermission.deleteMany({ where: { roleId: own } });
  await db().role.deleteMany({ where: { id: own } }); await db().userAccount.deleteMany({ where: { id: own } });
  await db().permission.deleteMany({ where: { id: own } });
}
/** Observe/inject only native storage calls. Every read, lock and write still
 * uses the actual owning SQL transaction; no authority/producer is replaced. */
function nativeFault(f: Fixture, mode: 'late-revoke' | 'audit-fk', external: PrismaClient) {
  const observed = { staged: null as any, auditCalls: 0, code: '' };
  const database = new Proxy(db(), { get(target, property) {
    if (property === '$transaction') return (callback: any, options: any) => target.$transaction(tx => callback(new Proxy(tx, { get(client, field) {
      if (field === 'invoice' || field === 'auditLog') return new Proxy((client as any)[field], { get(delegate, method) {
        if (field === 'invoice' && method === 'create') return async (args: any) => {
          const row = await delegate.create(args); observed.staged = await financialState(client);
          if (mode === 'late-revoke') await external.rolePermission.deleteMany({ where: { roleId: f.user.roleId } });
          return row;
        };
        if (field === 'auditLog' && method === 'create') return async (args: any) => {
          observed.auditCalls++;
          try { return await delegate.create(mode === 'audit-fk' ? { ...args, data: { ...args.data, actorId: prefix + '-absent-user' } } : args); }
          catch (error: any) { observed.code = error.code; throw error; }
        };
        const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
      } });
      const value = Reflect.get(client, field); return typeof value === 'function' ? value.bind(client) : value;
    } })), options);
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } }); return { database, observed };
}
/** Execute actual fixture/helper/hook bytes (not a reimplementation) with a
 * native tracking shell. The original D4 file retains its automatic B121 hook;
 * this injected native test client is checked manually with actual residual(). */
function originalD4(ctx: ReturnType<typeof createDrillContext>) {
  const file = path.resolve(__dirname, '../src/pricing/__tests__/commissionPayableDrill.test.ts');
  const source = readFileSync(file, 'utf8'), tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = new Set(['ensureActor', 'cleanup', 'assertAnchorBites', 'makeOrder', 'makeRule', 'makePricing']);
  const variables = new Set(['seq', 'n', 'RUN', 'ANCHOR', 'RESIDUAL_SPEC']);
  const definitions = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && variables.has(declaration.name.text)));
  let hook: ts.Expression | undefined;
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'afterAll') hook = node.arguments[0]; ts.forEachChild(node, visit); };
  visit(tree); if (!hook || definitions.length !== 11) throw Error('Original D4 fixture/hook extraction contract changed');
  const script = definitions.map(node => node.getText(tree)).join('\n') + '\nreturn { ensureActor, cleanup, assertAnchorBites, makeOrder, makeRule, makePricing, finish: ' + hook.getText(tree) + ' };';
  const compiled = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function('ctx', 'prisma', 'ACTOR', 'REL', 'Prisma', 'expect', 'safeResidualCounts', 'noBackendMessage', compiled)
    (ctx, ctx.prisma, ctx.actor, ctx.id('REL_AGENT'), Prisma, expect, safeResidualCounts, noBackendMessage) as {
      ensureActor: () => Promise<void>; cleanup: () => Promise<void>; makeOrder: () => Promise<any>;
      makeRule: (id: string) => Promise<any>; makePricing: (orderId: string, ruleId: string, amount: number, quantity: number) => Promise<any>;
      finish: () => Promise<void>;
    };
}

describe.sequential('native commission current pricing authority and rollback in isolated PG', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || ''), name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME,
      directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1'); expect(url.pathname).toBe('/' + name);
    expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/); expect(url.port).toBe(port); expect(Boolean(directory)).toBe(true);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [{ emit: 'event', level: 'query' }] });
    (prisma as PrismaClient<Prisma.PrismaClientOptions, 'query'>).$on('query', event => queries.push(event.query));
    expect(await db().$queryRawUnsafe('SELECT current_database() AS name, current_setting(\'data_directory\') AS directory, inet_server_port() AS port'))
      .toEqual([{ name, directory, port: Number(port) }]);
    unsubscribe = businessEventBus.subscribe('InvoiceIssued', event => { events.push(event); });
  });
  afterEach(async () => { await cleanupOwn(); events.length = 0; queries.length = 0; });
  afterAll(async () => { unsubscribe?.(); await prisma?.$disconnect(); });

  it('CPAN01 pricing-only own-L2 operator forms exact native AP, number, current audit and post-commit event without invoices:write', async () => {
    expect(DEFAULT_ROLE_PERMISSION_MATRIX[SYSTEM_ROLE_IDS.FINANCE]['pricing:write']).toBe(true);
    expect(DEFAULT_ROLE_PERMISSION_MATRIX[SYSTEM_ROLE_IDS.SALES]['pricing:write']).not.toBe(true);
    const f = await fixture('pricing-only'); expect(f.user.actor.permissions).toEqual(['pricing:write']);
    expect((await currentActor(f.user.id)).permissions).not.toContain('invoices:write');
    const response = await post(f); expect(response.status, diagnostic(response.body)).toBe(201);
    const invoice = await db().invoice.findUniqueOrThrow({ where: { id: response.body.invoice.id } });
    expect(invoice).toMatchObject({ type: 'Payable', status: 'Issued', orderId: f.order.id, ownerId: f.user.id,
      sourceType: 'CommissionPayable', sourceId: f.order.id + '#1', customerRelationId: f.intermediary.id, currency: 'USD' });
    expect(invoice.amount.toString()).toBe('123.45'); expect(invoice.invoiceNumber).toMatch(/^INV-\d{4}-\d{4}$/);
    expect(await db().businessSequence.findUniqueOrThrow({ where: { prefix_year: { prefix: 'INV', year: Number(invoice.invoiceNumber.split('-')[1]) } } }))
      .toMatchObject({ seq: Number(invoice.invoiceNumber.split('-')[2]) });
    const audit = await db().auditLog.findFirstOrThrow({ where: { targetType: 'Invoice', targetId: invoice.id, action: 'create_invoice' } });
    expect(audit.actorId).toBe(f.user.id); expect((audit.detail as any).after.amount).toBe('123.45');
    expect(response.body.commission).toMatchObject({ totalCommission: 123.45, invoicedAmount: 123.45, uninvoicedAmount: 0 });
    expect(events.map(event => event.sourceEntityId)).toEqual([invoice.id]); expect(events[0].transactionId).toBe(audit.id);
    const before = await financialState(); const retry = await post(f); expect(retry.status).toBe(409); expect(retry.body.error.code).toBe('ALREADY_INVOICED');
    expect(await financialState()).toEqual(before); expect(events).toHaveLength(1);
  });
  it('CPAN02 actual grant revocation defeats stale signed pricing authority before amount-source access and any write', async () => {
    const f = await fixture('revoked'); await db().rolePermission.deleteMany({ where: { roleId: f.user.roleId } });
    expect(f.user.actor.permissions).toContain('pricing:write'); expect((await currentActor(f.user.id)).permissions).toEqual([]);
    await refusedBeforeSources(() => post(f), 403, 'FORBIDDEN');
  });
  it('CPAN03 true signed empty ceiling cannot be repaired by body operator or privileged claims', async () => {
    const f = await fixture('ceiling'); const token = createAuthService().signToken({ ...f.user.actor, permissionCeiling: [] });
    await refusedBeforeSources(() => post(f, token, { actorId: f.user.id, actor: { ...f.user.actor, permissions: ['*'], permissionCeiling: ['*'], roles: ['owner'] } }), 403, 'FORBIDDEN');
    const unauthenticated = await request(f.app).post('/api/v1/pricing/orders/' + f.order.id + '/commission/payable').send({ actor: f.user.actor, actorId: f.user.id });
    expect(unauthenticated.status).toBe(401); expect(await db().invoice.count({ where: { orderId: f.order.id } })).toBe(0);
  });
  it('CPAN04 current scoped parent L2 rejects a foreign order before commission data rather than assuming Finance-all', async () => {
    const f = await fixture('foreign'); await db().order.update({ where: { id: f.order.id }, data: { ownerId: prefix + '-other-user' } });
    expect(f.user.actor.roles).toEqual([]); await refusedBeforeSources(() => post(f), 404, 'NOT_FOUND');
  });
  it('CPAN05 actual read-only pricing endpoint remains reachable with no mutations; write, current revoke and foreign reads are denied', async () => {
    const f = await fixture('read-only', ['pricing:read']); const before = await financialState();
    const response = await get(f); expect(response.status, diagnostic(response.body)).toBe(200);
    expect(response.body).toMatchObject({ totalCommission: 123.45, invoicedAmount: 0, uninvoicedAmount: 123.45, currency: 'USD' });
    expect(await financialState()).toEqual(before); await refusedBeforeSources(() => post(f), 403, 'FORBIDDEN');
    await db().order.update({ where: { id: f.order.id }, data: { ownerId: prefix + '-other-user' } });
    await refusedBeforeSources(() => get(f), 404, 'NOT_FOUND');
    await db().rolePermission.deleteMany({ where: { roleId: f.user.roleId } }); await refusedBeforeSources(() => get(f), 403, 'FORBIDDEN');
  });
  it('CPAN06 actual disabled account cannot use its earlier signed pricing claim to read sources or create AP', async () => {
    const f = await fixture('disabled'); await db().userAccount.update({ where: { id: f.user.id }, data: { status: 'disabled' } });
    await refusedBeforeSources(() => post(f), 403, 'FORBIDDEN');
  });
  it('CPAN07 independent native revoke after staged Invoice is rechecked before mandatory audit and rolls back every financial row and sequence', async () => {
    const f = await fixture('late-revoke'), external = new PrismaClient();
    const before = await financialState(); events.length = 0;
    try {
      const fault = nativeFault(f, 'late-revoke', external);
      const result = await createCommissionPayable(fault.database, { orderId: f.order.id }, f.user.id, f.user.actor);
      expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', status: 403 } });
      expect(fault.observed.staged.invoices).toHaveLength(before.invoices.length + 1);
      expect(fault.observed.staged.sequence).not.toEqual(before.sequence); expect(fault.observed.auditCalls).toBe(0);
      expect(await external.rolePermission.count({ where: { roleId: f.user.roleId } })).toBe(0);
      expect(await financialState()).toEqual(before); expect(events).toEqual([]);
    } finally { await external.$disconnect(); }
  });
  it('CPAN08 real native mandatory-audit foreign-key failure rolls back Invoice, exact sequence, links/allocations and emits no event', async () => {
    const f = await fixture('audit-fk'), external = new PrismaClient(); const before = await financialState(); events.length = 0;
    try {
      const fault = nativeFault(f, 'audit-fk', external);
      const result = await createCommissionPayable(fault.database, { orderId: f.order.id }, f.user.id, f.user.actor);
      expect(result).toMatchObject({ ok: false, error: { code: 'CREATE_FAILED', status: 500 } });
      expect(fault.observed.code).toBe('P2003'); expect(fault.observed.auditCalls).toBe(1);
      expect(fault.observed.staged.invoices).toHaveLength(before.invoices.length + 1); expect(fault.observed.staged.sequence).not.toEqual(before.sequence);
      expect(await financialState()).toEqual(before); expect(events).toEqual([]); expect(diagnostic(result)).not.toContain('Foreign key');
    } finally { await external.$disconnect(); }
  });
  it('CPAN09 original D4 failed anchor still cleans native business/auth rows; anchor plus native cleanup fault both remain visible', async () => {
    for (const fault of [false, true]) {
      const client = new PrismaClient(), ctx = createDrillContext({ prefix: 'TEST_CPAN_', client, runId: randomUUID().replace(/-/g, '') });
      const original = originalD4(ctx), trigger = 'cpan_cleanup_' + randomUUID().replace(/-/g, '');
      let captured: any;
      try {
        await original.ensureActor(); const order = await original.makeOrder(), rule = await original.makeRule(ctx.id('REL_AGENT'));
        await original.makePricing(order.id, rule.id, 2, 100);
        const payable = await createCommissionPayable(ctx.prisma, { orderId: order.id }, ctx.actor);
        expect(payable.ok, diagnostic(payable)).toBe(true); if (!payable.ok) throw Error('Actual D4 fixture failed');
        await ctx.prisma.invoice.deleteMany({ where: { sourceType: 'CommissionPayable', sourceId: { startsWith: ctx.mark } } });
        // Actual PostgreSQL trigger fault, scoped to this native actor only.
        // It exists only in this private cluster and is always dropped below.
        if (fault) {
          await db().$executeRawUnsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."actorId" = '${ctx.actor}' THEN RAISE EXCEPTION 'CPAN native cleanup fault'; END IF; RETURN OLD; END $$`);
          await db().$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`);
        }
        try { await original.finish(); } catch (error) { captured = error; }
        expect(captured?.message).toContain('演练认领判据**没咬到任何行**');
        if (fault) { expect(captured.errors.length).toBeGreaterThanOrEqual(2); expect(captured.message).toContain('CPAN native cleanup fault'); }
        else { expect(captured.errors).toBeUndefined(); expect((await ctx.residual({ settleMs: 0 })).dirty).toEqual([]); }
      } finally {
        if (fault) { await db().$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "AuditLog"`); await db().$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${trigger}"()`); }
        await original.cleanup();
        const residue = await ctx.residual({ settleMs: 0 }); expect(residue.dirty).toEqual([]); expect(residue.failed).toEqual([]);
        expect(await db().userAccount.count({ where: { id: ctx.actor } })).toBe(0);
        expect(await db().permission.count({ where: { id: { startsWith: ctx.mark } } })).toBe(0);
        await client.$disconnect();
      }
    }
  });
});
