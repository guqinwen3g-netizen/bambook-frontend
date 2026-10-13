/**
 * Issue-only durable receipt probes for the reviewed isolated PostgreSQL runner.
 * Technical accounts/roles/grants/Department/Relation/Team are INITIAL synthetic
 * configuration. Orders use the native signed Orders POST; pending approvals
 * use the real creation/routing service and an independently loaded assigned
 * reviewer uses the real decision service. Invoice/Outbox/audit/receipt facts
 * are created only by executeTool -> the production invoice.issue commit.
 *
 * No seed of approved/Issued/Paid/Cancelled business facts, SMTP, scheduler or
 * index bootstrap. Paid/Cancelled positives use existing financial HTTP writes.
 * Proxies observe/coordinate actual SQL and delegate unchanged, except the
 * explicitly labelled real audit-FK fault. Controlled cache/audit/Outbox damage
 * and legacy-shape fixtures are negative/compatibility premises, not authentic
 * historical evidence. This candidate has not been executed by its author.
 */
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { hasScope } from '../src/auth/permissionService';
import { currentProformaActor } from '../src/finance/proformaInvoiceAccess';
import { createOrdersRouter } from '../src/orders/route';
import { createFinanceRouter } from '../src/finance/route';
import { createApprovalCreateService } from '../src/approvals/approvalCreateService';
import { createApprovalRoutingService } from '../src/approvals/approvalRoutingService';
import { approvalReviewContentVersion, createApprovalDecisionService } from '../src/approvals/approvalDecisionService';
import { buildInvoiceIssueDraft } from '../src/agent/invoiceIssueFlow';
import { executeTool } from '../src/agent/toolRuntime';
import type { ActorContext } from '../src/agent/types';
import { businessEventBus } from '../src/events/businessEventBus';

const prefix = `acceptance-issue-receipt-${randomUUID()}`;
const auth = createAuthService();
let prisma: PrismaClient | undefined;
let sequence = 0;
const db = (): PrismaClient => {
  if (!prisma) throw Error('Reviewed private issue-receipt PostgreSQL identity is not verified');
  return prisma;
};
// Independent exact canonical SHA recipe, deliberately not a producer import.
function nativeJson(value: any): any {
  if (typeof value === 'bigint' || Prisma.Decimal.isDecimal(value)) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(nativeJson);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, nativeJson(value[key])])) : value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(nativeJson(value))).digest('hex');
const clean = (value: unknown) => JSON.parse(JSON.stringify(nativeJson(value)));
const code = (result: any) => result.errorFeedback?.code ?? result.feedback?.error?.code;
const originalAck = (result: any) => { const { replayed: _replayed, ...ack } = result; return ack; };
function safeFailure(result: any) {
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/P2003|P2010|23503|private_issue_receipt_fault|constraint|CREATE FUNCTION|\/private\//i);
}
function actorContext(payload: TokenPayload): ActorContext {
  return { userId: payload.userId, displayName: payload.displayName, roles: payload.roles,
    departmentIds: payload.departmentIds, permissionScopes: payload.permissions ?? [],
    permissionsAuthoritative: payload.authorizationLoaded === true,
    permissionCeiling: payload.permissionCeiling, memoryScopes: [], knowledgeScopes: ['company'], toolScopes: ['finance'] };
}
async function loaded(id: string) {
  const user = await loadUserWithRoles(db(), id);
  expect(user, 'actual account and role tree must exist before signing a credential').not.toBeNull();
  const current = await buildLoadedAuthTokenPayload(db(), user);
  const payload = { ...current, permissionCeiling: [...current.permissions!] };
  const token = auth.signToken(payload);
  const verified = auth.verifyToken(token);
  expect(verified.userId).toBe(id); expect(verified.authorizationLoaded).toBe(true);
  return { id, payload: verified, token, context: actorContext(verified) };
}
type Principal = Awaited<ReturnType<typeof loaded>>;
async function technicalActor(id: string, scopes: string[], canonicalReviewer = false) {
  const roleId = `${id}-configured-role`, grants: Record<string, string> = {};
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id, displayName: `Synthetic ${id}`, status: 'active' } });
    await tx.role.create({ data: { id: roleId, name: 'Synthetic precise issue capability', isSystem: false } });
    await tx.userRole.create({ data: { id: `${id}-membership`, userId: id, roleId } });
    if (canonicalReviewer) {
      await tx.role.upsert({ where: { id: 'role-sales-manager' }, update: {},
        create: { id: 'role-sales-manager', name: 'Canonical reviewer identity', isSystem: true } });
      await tx.userRole.create({ data: { id: `${id}-canonical`, userId: id, roleId: 'role-sales-manager' } });
    }
    for (const scope of scopes) {
      const permission = await tx.permission.upsert({ where: { scope }, update: {}, create: { id: `${prefix}-permission-${scope}`, scope } });
      grants[scope] = `${id}-grant-${scope}`;
      await tx.rolePermission.create({ data: { id: grants[scope], roleId, permissionId: permission.id } });
    }
  });
  return { ...(await loaded(id)), roleId, grants };
}
function application() {
  const app = express(); app.use(express.json());
  app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
  app.use(createAccountStatusGuard(db()));
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  const options = { prisma: db(), requireAuth: true, apiKeys: new Set<string>() };
  app.use('/api/v1/orders', createOrdersRouter(options));
  app.use('/api/v1/finance', createFinanceRouter(options));
  return app;
}
async function fixture(label: string, options: { order?: boolean; email?: boolean; amount?: number } = {}) {
  const id = `${prefix}-${++sequence}-${label}`;
  const requester = await technicalActor(`${id}-requester`, ['invoices:write', 'orders:read', 'orders:write']);
  const executor = await technicalActor(`${id}-executor`, ['invoices:read', 'invoices:write', 'orders:read', 'vouchers:read', 'vouchers:write', 'invoices:reconcile']);
  const reviewer = await technicalActor(`${id}-reviewer`, ['invoices:read', 'invoices:write', 'orders:read'], true);
  const departmentId = `${id}-department`, customerId = `${id}-customer`, teamId = `${id}-team`, shareId = `${id}-share`;
  await db().$transaction(async tx => {
    await tx.department.create({ data: { id: departmentId, name: 'Synthetic request routing department', status: 'active', headId: reviewer.id } });
    await tx.userAccount.update({ where: { id: requester.id }, data: { primaryDeptId: departmentId } });
    await tx.relation.create({ data: { id: customerId, name: customerId, category: 'Customer', type: 'Company', isOrganization: true,
      ownerId: requester.id, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()) } });
    await tx.team.create({ data: { id: teamId, name: 'Synthetic source visibility team', status: 'active' } });
    await tx.teamMember.create({ data: { id: `${id}-member`, teamId, userId: executor.id } });
    await tx.teamDataGrant.create({ data: { id: shareId, teamId, entityType: 'relation', entityId: customerId,
      permission: 'read+followup', grantedBy: requester.id } });
  });
  Object.assign(requester, await loaded(requester.id));
  expect(executor.payload.roles).toEqual([]); // no Finance/Admin label supplies all-company L2
  let orderId: string | null = null;
  if (options.order) {
    // Orders POST sanitizes IDs to 60 characters; give each native order a
    // complete short identity instead of truncating the shared fixture prefix.
    orderId = `IIR-${randomUUID()}`;
    const order = await request(application()).post('/api/v1/orders').set('Authorization', `Bearer ${requester.token}`).send({
      id: orderId, poNumber: `${id}-PO`, customer: customerId, customerRelationId: customerId, product: 'Synthetic native whole-order source',
      type: 'Fabric', quantity: 10, quoteAmount: '12.3456', currency: 'USD', dueDate: '2026-11-01', paymentInstrument: 'T/T',
      notes: 'Software source only; no production or shipment approval granted',
    });
    expect(order.status, JSON.stringify(order.body)).toBe(200); expect(order.body.ok).toBe(true);
    expect(await db().order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ ownerId: requester.id, status: 'Pending', customerRelationId: customerId });
    expect(await db().auditLog.count({ where: { targetType: 'Order', targetId: orderId, action: 'create_order', actorId: requester.id } })).toBe(1);
  }
  const invoiceId = `${id}-invoice`, emailSubject = `${id}-synthetic-Outbox`;
  const input = { invoiceId, invoiceNumber: `${id}-INV`, type: 'Receivable', amount: options.amount ?? 12.3456, currency: 'USD',
    issueDate: '2026-10-02', dueDate: '2026-11-01', customerRelationId: customerId, customerName: customerId,
    ...(orderId ? { orderId } : {}),
    ...(options.email ? { email: { to: ['synthetic@example.invalid'], subject: emailSubject, bodyText: 'Synthetic private Outbox, never SMTP sent' } } : {}) };
  const draft = buildInvoiceIssueDraft(input);
  // The caller's current native Finance capability is established before the
  // actual request service. The routing service, not a test-supplied reviewer,
  // chooses the independent active Department.headId.
  await currentProformaActor(db(), requester.id, requester.payload);
  const pending = await createApprovalCreateService({ prisma: db(), routingService: createApprovalRoutingService({ prisma: db() }) })
    .createBusinessApproval({ requesterId: requester.id, actionType: 'tool:invoice.issue', targetType: 'finance', targetId: 'invoice.issue',
      risk: 'high', payload: { toolId: 'invoice.issue', toolName: 'Issue Invoice (Flow API)', scope: 'finance', input,
        requestedAt: new Date().toISOString(), originalActorUserId: requester.id, fallbackRequester: false, processDraft: draft } });
  expect(pending).toMatchObject({ status: 'pending', requesterId: requester.id, reviewerId: reviewer.id,
    reviewerResolverRoute: 'DEPT_HEAD', departmentSnapshotId: departmentId });
  const currentReviewer = await loaded(reviewer.id);
  expect(hasScope(currentReviewer.payload, 'invoices:write')).toBe(true);
  const decided = await createApprovalDecisionService(db()).decide({ id: pending.id,
    actor: { userId: currentReviewer.id, displayName: currentReviewer.payload.displayName,
      roles: currentReviewer.payload.roles, roleIds: currentReviewer.payload.roleIds, authorizationLoaded: true },
    decision: 'approved', source: 'api:approvals', decisionNote: 'Synthetic independently assigned approval; no real customer communication',
    reviewContentVersion: approvalReviewContentVersion(pending), confirmedReviewedContent: true });
  expect(decided.updated).toMatchObject({ status: 'approved', requesterId: requester.id, reviewerId: reviewer.id });
  expect(await db().auditLog.findUniqueOrThrow({ where: { id: decided.decisionAuditId } })).toMatchObject({
    actorId: reviewer.id, action: 'approve_business_request', targetType: 'ApprovalRequest', targetId: pending.id });
  return { id, requester, executor, reviewer, customerId, orderId, shareId, invoiceId, emailSubject,
    email: Boolean(options.email), draft, approvalId: pending.id, receiptKey: `commit:invoice.issue:${pending.id}` };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const issue = (f: Fixture, client: PrismaClient = db(), actor = f.executor.context) => {
  // Runtime commit calls extend the planner's plain input with the approval ID;
  // keep that real runtime shape without weakening the producer's own types.
  const call = { toolId: 'invoice.issue', approvalId: f.approvalId, input: {}, reason: 'Execute the actual assigned synthetic approval' };
  return executeTool(client, call, { actor, actorId: actor.userId }) as Promise<any>;
};
async function snapshot(f: Fixture, client: any = db()) {
  return clean({ approval: await client.approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId } }),
    invoices: await client.invoice.findMany({ where: { id: f.invoiceId }, orderBy: { id: 'asc' } }),
    emails: await client.email.findMany({ where: { subject: f.emailSubject }, orderBy: { id: 'asc' } }),
    audits: await client.auditLog.findMany({ where: { action: 'invoice_issue_committed', targetType: 'Invoice', targetId: f.invoiceId }, orderBy: { id: 'asc' } }),
    receipts: await client.agentCommitReceipt.findMany({ where: { idempotencyKey: f.receiptKey }, orderBy: { id: 'asc' } }),
    references: await client.entityReference.findMany({ where: { ownerId: f.invoiceId }, orderBy: { id: 'asc' } }),
    links: await client.entityLink.findMany({ where: { fromId: f.invoiceId }, orderBy: { id: 'asc' } }) });
}
async function oneCommitted(f: Fixture, result: any) {
  expect(result.ok, JSON.stringify(result)).toBe(true); expect(result.status).toBe('committed');
  const state = await snapshot(f); expect(state.invoices).toHaveLength(1); expect(state.emails).toHaveLength(f.email ? 1 : 0);
  expect(state.audits).toHaveLength(1); expect(state.receipts).toHaveLength(1);
  expect(state.approval).toMatchObject({ status: 'approved', requesterId: f.requester.id, reviewerId: f.reviewer.id });
  const receipt = state.receipts[0], value = receipt.result;
  expect(receipt).toMatchObject({ status: 'committed', toolId: 'invoice.issue', approvalId: f.approvalId });
  expect(value.schemaVersion).toBe(1); expect(value.commandHash).toBe(digest({ schemaVersion: 1, command: value.command }));
  expect(value.ackHash).toBe(digest(value.acknowledgement)); expect(value.acknowledgement).toEqual(originalAck(result));
  expect(value.command).toMatchObject({ executorId: f.executor.id, requesterId: f.requester.id, approvalId: f.approvalId });
  expect(value.command.processDraft).toEqual(clean(f.draft)); expect(value.facts.invoice.id).toBe(f.invoiceId);
  expect(value.facts.invoice.amount).toBe(new Prisma.Decimal(f.draft.subOperations[0].after.amount as number).toString());
  expect(typeof value.facts.invoice.createdAt).toBe('string');
  expect(state.audits[0]).toMatchObject({ id: result.auditId, actorId: f.executor.id,
    detail: { source: 'agent:invoice.issue:commit', after: { receiptKey: f.receiptKey, approvalRequesterId: f.requester.id,
      executionActorId: f.executor.id, commandSnapshot: value.command, commandHash: value.commandHash } } });
  if (f.email) expect(state.emails[0]).toMatchObject({ mailbox: 'Outbox', direction: 'outbound', sentAt: null, messageId: null });
  return state;
}
function transactionObserver(observe: (tx: any) => Promise<any>): PrismaClient {
  return new Proxy(db(), { get(target, key) {
    if (key === '$transaction') return (run: (tx: any) => Promise<any>, options?: any) =>
      target.$transaction(async tx => run(await observe(tx)), { ...options, maxWait: 10000, timeout: 15000 });
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function forwardingProxy(target: any, key: PropertyKey, override: any) {
  return new Proxy(target, { get(object, name) {
    if (name === key) return override;
    const value = Reflect.get(object, name); return typeof value === 'function' ? value.bind(object) : value;
  } });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await read(); if (matches(value)) return value;
    await new Promise<void>(resolve => setTimeout(resolve, 20)); }
  throw Error(`Actual private PG witness timed out: ${label}`);
}
async function holdRow(f: Fixture, kind: 'Order' | 'ApprovalRequest', work: (holderPid: number) => Promise<void>) {
  const ready = deferred<number>(), release = deferred<void>();
  const holder = db().$transaction(async tx => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    if (kind === 'Order') { if (!f.orderId) throw Error('Actual Order source is required');
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${f.orderId} FOR UPDATE`; }
    else await tx.$queryRaw`SELECT "id" FROM "ApprovalRequest" WHERE "id"=${f.approvalId} FOR UPDATE`;
    ready.resolve(pid); await release.promise;
  }, { maxWait: 10000, timeout: 15000 });
  holder.catch(ready.reject);
  try { await work(await ready.promise); } finally { release.resolve(); await holder; }
}
async function blockingEvidence(holderPid: number, pids: number[], expected: number) {
  await until(async () => [...pids], rows => rows.length === expected, 'actual issue transaction connection PIDs');
  return until(async () => {
    const rows: Array<{ pid: number; blockers: number[] }> = [];
    for (const pid of pids) rows.push(...await db().$queryRaw<Array<{ pid: number; blockers: number[] }>>
      `SELECT ${pid}::integer AS pid, pg_blocking_pids(${pid}::integer) AS blockers`);
    return rows;
  }, rows => {
    const edges = new Map(rows.map(row => [row.pid, row.blockers]));
    const reaches = (pid: number, seen = new Set<number>()): boolean => {
      if (pid === holderPid) return true; if (seen.has(pid)) return false; seen.add(pid);
      return (edges.get(pid) ?? []).some(blocker => reaches(blocker, new Set(seen)));
    };
    return rows.length === expected && rows.every(row => reaches(row.pid));
  }, 'pg_blocking_pids chain to the actual holder');
}

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed isolated PostgreSQL runner required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  expect(process.env.NODE_OPTIONS).toContain('acceptance-network-guard.cjs');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  // Physical identity is checked BEFORE any configuration or business write.
  expect(await db().$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
  businessEventBus.reset(); businessEventBus.setPrisma(db());
});
afterAll(async () => { businessEventBus.reset(); await prisma?.$disconnect(); });

describe.sequential('Agent invoice.issue native approval / durable receipt / isolated PG', () => {
  it('IIR01 real assigned approval yields one exact same-TX issue acknowledgement without borrowing its requester identity', async () => {
    const f = await fixture('exact-native'); const before = await snapshot(f);
    const result = await issue(f), after = await oneCommitted(f, result);
    expect(after.approval).toEqual(before.approval); expect(result.invoiceId).toBe(f.invoiceId);
    expect(after.invoices[0]).toMatchObject({ type: 'Receivable', status: 'Issued', currency: 'USD', amount: '12.3456' });
  });
  it('IIR02 actual Approval row waits and native ON CONFLICT arbitrate two identical commands to one frozen ACK and four facts', async () => {
    const f = await fixture('concurrent-claim', { email: true }), pids: number[] = [], claims: number[] = [];
    const client = transactionObserver(async tx => {
      pids.push((await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid);
      return forwardingProxy(tx, '$queryRaw', async (...args: any[]) => {
        const rows = await tx.$queryRaw(...args);
        if (args[0]?.strings?.join('').includes('INSERT INTO "AgentCommitReceipt"')) claims.push(rows.length);
        return rows;
      });
    });
    let pending!: Promise<any[]>;
    await holdRow(f, 'ApprovalRequest', async holderPid => {
      pending = Promise.all([issue(f, client), issue(f, client)]);
      const blockers = await blockingEvidence(holderPid, pids, 2);
      expect(new Set(blockers.map(row => row.pid)).size).toBe(2);
      console.info('[issue-receipt PG lock]', clean({ control: 'IIR02', holderPid, blockers }));
    });
    const results = await pending; expect(results.every(row => row.ok)).toBe(true);
    expect(results.filter(row => row.replayed === true)).toHaveLength(1);
    expect(originalAck(results[0])).toEqual(originalAck(results[1])); expect(claims.sort()).toEqual([0, 1]);
    await oneCommitted(f, originalAck(results[0]));
  });
  it('IIR03 actual Order lock wait rechecks revoked TeamDataGrant, writes nothing and permits the same original command after legitimate restoration', async () => {
    const f = await fixture('source-lock-share', { order: true, email: true }), before = await snapshot(f), pids: number[] = [];
    const client = transactionObserver(async tx => { pids.push((await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid); return tx; });
    let pending!: Promise<any>;
    await holdRow(f, 'Order', async holderPid => {
      pending = issue(f, client); const blockers = await blockingEvidence(holderPid, pids, 1);
      expect(blockers[0].blockers).toContain(holderPid);
      console.info('[issue-receipt PG lock]', clean({ control: 'IIR03', holderPid, blockers }));
      await db().teamDataGrant.update({ where: { id: f.shareId }, data: { revokedAt: new Date(), revokedBy: f.requester.id } });
    });
    const refused = await pending; safeFailure(refused); expect(code(refused)).toBe('ORDER_NOT_FOUND'); expect(await snapshot(f)).toEqual(before);
    await db().teamDataGrant.update({ where: { id: f.shareId }, data: { revokedAt: null, revokedBy: null } });
    await oneCommitted(f, await issue(f));
  });
  it('IIR04 real receipt UPDATE trigger observes Invoice/Outbox/audit staged then rolls back all facts and the claim; exact retry succeeds', async () => {
    const f = await fixture('receipt-write-fault', { email: true }), before = await snapshot(f), staged: any[] = [];
    const client = transactionObserver(async tx => forwardingProxy(tx, 'agentCommitReceipt', forwardingProxy(tx.agentCommitReceipt, 'update', async (args: any) => {
      if (args.where.idempotencyKey === f.receiptKey) staged.push(await snapshot(f, tx));
      return tx.agentCommitReceipt.update(args);
    })));
    const fn = `acceptance_issue_receipt_${randomUUID().replace(/-/g, '')}`;
    expect(fn).toMatch(/^acceptance_issue_receipt_[a-f0-9]+$/);
    const quoted = `'${f.receiptKey.replace(/'/g, "''")}'`;
    await db().$executeRawUnsafe(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."idempotencyKey"=${quoted} AND NEW.status='committed' THEN RAISE EXCEPTION 'private_issue_receipt_fault'; END IF;
      RETURN NEW; END $$`);
    try {
      await db().$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE UPDATE ON "AgentCommitReceipt" FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
      try { const result = await issue(f, client); safeFailure(result); expect(code(result)).toBe('COMMIT_TRANSACTION_FAILED'); }
      finally { await db().$executeRawUnsafe(`DROP TRIGGER ${fn} ON "AgentCommitReceipt"`); }
    } finally { await db().$executeRawUnsafe(`DROP FUNCTION public.${fn}()`); }
    expect(staged).toHaveLength(1); expect(staged[0].invoices).toHaveLength(1); expect(staged[0].emails).toHaveLength(1);
    expect(staged[0].audits).toHaveLength(1); expect(staged[0].receipts[0].status).toBe('committing');
    expect(await snapshot(f)).toEqual(before); await oneCommitted(f, await issue(f));
  });
  it('IIR05 actual mandatory AuditLog actor FK P2003 rolls back a staged issue and Outbox and leaves the original approval reusable', async () => {
    const f = await fixture('audit-FK-fault', { email: true }), before = await snapshot(f), staged: any[] = [], faults: unknown[] = [];
    const client = transactionObserver(async tx => forwardingProxy(tx, 'auditLog', forwardingProxy(tx.auditLog, 'create', async (args: any) => {
      if (args.data.action !== 'invoice_issue_committed') return tx.auditLog.create(args);
      staged.push(await snapshot(f, tx));
      try { return await tx.auditLog.create({ ...args, data: { ...args.data, actorId: `${f.id}-absent-audit-actor` } }); }
      catch (error) { faults.push(error); throw error; }
    })));
    const result = await issue(f, client); safeFailure(result); expect(code(result)).toBe('COMMIT_TRANSACTION_FAILED');
    expect(faults).toHaveLength(1); expect(faults[0]).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((faults[0] as Prisma.PrismaClientKnownRequestError).code).toBe('P2003');
    expect(staged).toHaveLength(1); expect(staged[0].invoices).toHaveLength(1); expect(staged[0].emails).toHaveLength(1);
    expect(staged[0].audits).toEqual([]); expect(staged[0].receipts[0].status).toBe('committing');
    expect(await snapshot(f)).toEqual(before); await oneCommitted(f, await issue(f));
  });
  it('IIR06 lost-response replay returns the immutable original ACK while native Paid/Cancelled history and real financial facts remain untouched', async () => {
    for (const status of ['Paid', 'Cancelled'] as const) {
      const f = await fixture(`replay-${status}`, { email: true }); const original = await issue(f); await oneCommitted(f, original);
      if (status === 'Paid') {
        const receipt = await request(application()).post('/api/v1/finance/vouchers').set('Authorization', `Bearer ${f.executor.token}`).send({
          type: 'Receipt', amount: '12.3456', currency: 'USD', customerRelationId: f.customerId, customerName: f.customerId,
          paymentDate: '2026-10-02', paymentMethod: 'TT', attachments: { paymentReference: `${f.id}-synthetic-payment` },
          notes: 'Software financial receipt only; no actual bank operation' });
        expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
        const allocated = await request(application()).post('/api/v1/finance/allocations').set('Authorization', `Bearer ${f.executor.token}`).send({
          invoiceId: f.invoiceId, voucherId: receipt.body.id, appliedAmount: '12.3456', appliedDate: '2026-10-02' });
        expect(allocated.status, JSON.stringify(allocated.body)).toBe(201);
        expect((await db().invoiceAllocation.findUniqueOrThrow({ where: { id: allocated.body.allocation.id } })).appliedAmount.toString()).toBe('12.3456');
      } else {
        const cancelled = await request(application()).post(`/api/v1/finance/${f.invoiceId}/cancel`).set('Authorization', `Bearer ${f.executor.token}`)
          .send({ reason: 'Synthetic native void, no payment allocation or real customer transmission' });
        expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
      }
      expect(await db().invoice.findUniqueOrThrow({ where: { id: f.invoiceId } })).toMatchObject({ status });
      const before = await snapshot(f), payments = clean(await db().invoiceAllocation.findMany({ where: { invoiceId: f.invoiceId }, orderBy: { id: 'asc' } }));
      const replay = await issue(f); expect(replay).toEqual({ ...originalAck(original), replayed: true });
      expect(await snapshot(f)).toEqual(before);
      expect(clean(await db().invoiceAllocation.findMany({ where: { invoiceId: f.invoiceId }, orderBy: { id: 'asc' } }))).toEqual(payments);
    }
  });
  it('IIR07 removed real role permission refuses a stale loaded executor before any issue or receipt', async () => {
    const f = await fixture('withdrawn-current-grant', { email: true }), before = await snapshot(f);
    await db().rolePermission.delete({ where: { id: f.executor.grants['invoices:write'] } });
    const result = await issue(f); safeFailure(result); expect(code(result)).toBe('FORBIDDEN'); expect(await snapshot(f)).toEqual(before);
  });
  it('IIR08 disabled current account cannot borrow its approved requester or old valid JWT to issue', async () => {
    const f = await fixture('disabled-current-account', { email: true }), before = await snapshot(f);
    await db().userAccount.update({ where: { id: f.executor.id }, data: { status: 'disabled' } });
    const result = await issue(f); safeFailure(result); expect(code(result)).toBe('UNAUTHORIZED'); expect(await snapshot(f)).toEqual(before);
  });
  it('IIR09 explicitly signed empty ceiling refuses despite actual active account and current grant rows', async () => {
    const f = await fixture('signed-empty', { email: true }), before = await snapshot(f);
    // Reissue a real signed capability token; verified JWT timestamps belong
    // to the old transport and cannot be resubmitted with expiresIn.
    const { exp: _expires, iat: _issued, ...claims } = f.executor.payload as typeof f.executor.payload & { exp?: number; iat?: number };
    const bounded = auth.verifyToken(auth.signToken({ ...claims, permissionCeiling: [] }));
    const result = await issue(f, db(), actorContext(bounded)); safeFailure(result); expect(code(result)).toBe('FORBIDDEN');
    expect(await snapshot(f)).toEqual(before);
  });
  it('IIR10 real cached command/ACK/audit/Outbox damage cannot be redeemed as success even with internally recomputed receipt hashes', async () => {
    for (const damage of ['command', 'ack', 'audit', 'outbox'] as const) {
      const f = await fixture(`damage-${damage}`, { email: true }); await oneCommitted(f, await issue(f));
      const stored = await db().agentCommitReceipt.findUniqueOrThrow({ where: { idempotencyKey: f.receiptKey } });
      const envelope: any = clean(stored.result);
      // Deliberate damage follows an actual native commit. It never creates an
      // approved row, replaces an Invoice, or pretends to be historical policy.
      if (damage === 'command') {
        envelope.command.source.amount = '12.3457'; envelope.commandHash = digest({ schemaVersion: 1, command: envelope.command });
        await db().agentCommitReceipt.update({ where: { id: stored.id }, data: { result: envelope } });
      } else if (damage === 'ack') {
        envelope.acknowledgement.transactionId = 'forged-cached-transaction'; envelope.ackHash = digest(envelope.acknowledgement);
        await db().agentCommitReceipt.update({ where: { id: stored.id }, data: { result: envelope } });
      } else if (damage === 'audit') {
        const actual = await db().auditLog.findUniqueOrThrow({ where: { id: envelope.acknowledgement.auditId } });
        const detail: any = clean(actual.detail); detail.after.outboxEmailId = 'foreign-outbox';
        await db().auditLog.update({ where: { id: actual.id }, data: { detail } });
      } else await db().email.update({ where: { id: envelope.facts.outbox.id }, data: { bodyText: 'Controlled altered actual Outbox body' } });
      const before = await snapshot(f), result = await issue(f); safeFailure(result); expect(code(result)).toBe('CONFLICT');
      expect(result).not.toHaveProperty('replayed'); expect(await snapshot(f)).toEqual(before);
    }
  });
  it('IIR11 INITIAL legacy committing technical receipt without proof stays unknown and cannot create new business facts', async () => {
    const f = await fixture('legacy-unknown', { email: true });
    await db().agentCommitReceipt.create({ data: { id: `${f.id}-old-technical-receipt`, idempotencyKey: f.receiptKey,
      toolId: 'invoice.issue', approvalId: f.approvalId, status: 'committing', result: Prisma.DbNull } });
    const before = await snapshot(f), result = await issue(f); safeFailure(result); expect(code(result)).toBe('COMMIT_REPLAY_BLOCKED');
    expect(before.invoices).toEqual([]); expect(before.emails).toEqual([]); expect(before.audits).toEqual([]);
    expect(await snapshot(f)).toEqual(before);
  });
  it('IIR12 controlled legacy committed shape replays actual original Invoice but never manufactures modern proof or a new receipt', async () => {
    const f = await fixture('legacy-committed', { order: true, email: true }), original = await issue(f); await oneCommitted(f, original);
    const stored = await db().agentCommitReceipt.findUniqueOrThrow({ where: { idempotencyKey: f.receiptKey } });
    // Compatibility fixture derived from a real successful issue. It is not a
    // claim that these bytes are an authentic production legacy receipt.
    await db().agentCommitReceipt.update({ where: { id: stored.id }, data: { result: originalAck(original) } });
    const before = await snapshot(f), replay = await issue(f); expect(replay).toEqual({ ...originalAck(original), replayed: true });
    expect(await snapshot(f)).toEqual(before); expect((await db().agentCommitReceipt.findUniqueOrThrow({ where: { id: stored.id } })).result)
      .not.toHaveProperty('schemaVersion');
  });
  it('IIR13 actual other authorized executor or changed full approved command cannot claim a second issue on the same approval key', async () => {
    const f = await fixture('principal-command-binding', { email: true }), original = await issue(f); await oneCommitted(f, original);
    const other = await technicalActor(`${f.id}-other-executor`, ['invoices:write', 'orders:read']);
    const before = await snapshot(f), foreign = await issue(f, db(), other.context);
    safeFailure(foreign); expect(code(foreign)).toBe('CONFLICT'); expect(await snapshot(f)).toEqual(before);
    const approval = await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId } });
    const payload: any = clean(approval.payload);
    payload.processDraft = buildInvoiceIssueDraft({ invoiceId: `${f.id}-changed-invoice`, invoiceNumber: `${f.id}-changed-INV`,
      amount: 13, currency: 'USD', issueDate: '2026-10-02', customerRelationId: f.customerId });
    await db().approvalRequest.update({ where: { id: approval.id }, data: { payload } }); // controlled immutable-command damage only
    const corrupted = await snapshot(f), result = await issue(f); safeFailure(result); expect(code(result)).toBe('CONFLICT');
    expect(await snapshot(f)).toEqual(corrupted); expect(await db().invoice.count({ where: { id: `${f.id}-changed-invoice` } })).toBe(0);
  });
  it('IIR14 actual Decimal18,4 quantization differs from approved amount and rejects the first successful ACK with zero committed facts', async () => {
    const f = await fixture('actual-Decimal-quantization', { email: true, amount: 12.34567 }), before = await snapshot(f), staged: any[] = [];
    const client = transactionObserver(async tx => forwardingProxy(tx, 'invoice', forwardingProxy(tx.invoice, 'create', async (args: any) => {
      const actual = await tx.invoice.create(args); staged.push(clean(actual)); return actual;
    })));
    const result = await issue(f, client); safeFailure(result); expect(code(result)).toBe('CONFLICT');
    expect(staged).toHaveLength(1); expect(staged[0].amount).toBe('12.3457'); expect(staged[0].amount).not.toBe('12.34567');
    expect(await snapshot(f)).toEqual(before);
  });
});
