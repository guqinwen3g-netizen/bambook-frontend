/**
 * Opt-in acceptance: actual ordinary and legacy admin approval-decision HTTP
 * boundaries, backed by independently identified, runner-owned PostgreSQL.
 * Do not run against the shared/business database or import the production index.
 *
 * Independent business basis:
 * - docs/业务口径决策单-2026-09-17.md:163-174 (B1): the 13 approval
 *   scopes are UI capability labels, not substitutes for approval authority.
 * - docs/运营落地决策基线与首批方案-2026-09-30.md:26: authority binds
 *   actor/data/operation; ordinary self-approval is forbidden without a separately
 *   authorized, scoped, audited exception. These fixtures have NO such exception.
 * - docs/design/04-模块设计/07-AI助手/审批与human-in-the-loop.md:468,
 *   475, 477, 485 (DR7-A5/B1/B4/C2): no self-approval, one decision, preserve
 *   rejected history, and a non-designated actor must not change the approval.
 * - The same design:530 (DR013-C4) requires approval/audit atomicity. The SQL
 *   failure probes here exercise that technical boundary only; their synthetic
 *   target is NOT a complete DR-013, order-price or after-sales approval scenario.
 *
 * Actual mounts: index.ts:665 /api/admin, :677 /api/v1/approvals; the host
 * includes cookieParser -> accountStatusGuard as in index.ts:365-368. Real JWTs
 * are signed/verified by production auth code for actual active fixture accounts.
 * They are not login/refresh or effective-permission-loader evidence. Assignment
 * is a synthetic persisted precondition, NOT evidence of department routing.
 *
 * The ordinary onDecided callback is an observation spy (no business side
 * effect). Admin EmailService is an explicit no-delivery substitute; no SMTP,
 * Resend, seed, scheduler, index bootstrap or listening application is started.
 * A successful admin control proves technical write/actor attribution only, NOT
 * completeness/legality of the legacy route's full approval contract. No owner
 * bypass, vacant-reviewer policy or special self-approval policy is invented.
 *
 * Audit fault injection changes only the actorId passed to the REAL Prisma
 * auditLog.create, to an independently absent UserAccount. PG must produce
 * P2003. No hand-thrown error stands in for SQL. Array transactions receive
 * the original PrismaPromise; interactive transactions proxy the actual tx
 * audit delegate, so the same fault reaches the unified decision transaction.
 * Fixtures/audits are retained for runner capture and temporary-cluster disposal.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { PrismaClient, type ApprovalRequest } from '@prisma/client';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createApprovalKernelRouter } from '../src/approvals/approvalKernelRoute';
import { createAdminRouter } from '../src/admin/route';
import { createAuthService } from '../src/auth/service';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { serializeValue } from '../src/lib/serializeValue';
import type { EmailMessage, EmailService } from '../src/auth/email';

type FixtureRole = 'sales' | 'manager' | 'admin' | 'owner';
type Actor = { id: string; role: FixtureRole; roleId: string };
type Fixture = { id: string; requester: Actor; reviewer: Actor; outsider: Actor };
type DecisionStatus = 'approved' | 'rejected';
type RouteKind = 'ordinary' | 'admin';
type SqlFaultObservation = {
  calls: Array<{ targetId: string | null; attemptedActorId: string; originalActorId: string | null }>;
  sqlCodes: string[];
};

const prefix = `acceptance-approval-boundaries-${randomUUID()}`;
const roleIds: Record<FixtureRole, string> = {
  sales: 'role-sales', manager: 'role-sales-manager', admin: 'role-admin', owner: 'role-super-admin',
};
const uiOnlyLabel = 'vouchers:approve:pay_lt5';
const decisionActions = ['approve_business_request', 'reject_business_request', 'approve', 'reject'];
const onDecided = vi.fn(async (_decision: unknown) => undefined);
const noDeliveryEmail: EmailService = {
  isReal: false,
  describe: () => 'Acceptance-only no-delivery email substitute',
  send: vi.fn(async (_message: EmailMessage) => undefined),
};
let prisma: PrismaClient | undefined;
let app: Express;
let fixtureNumber = 0;

function db(): PrismaClient {
  if (!prisma) throw new Error('Approval acceptance precondition: isolated PG client is not initialized');
  return prisma;
}

function signedBearer(actor: Actor, permissions: string[] = []): string {
  return `Bearer ${createAuthService().signToken({
    userId: actor.id, displayName: 'Synthetic approval actor', roles: [actor.role],
    roleIds: [actor.roleId], permissions, departmentIds: [],
  })}`;
}

function createHost(routeClient: PrismaClient = db(), syncAll = false): Express {
  const host = express();
  // index.ts installs BigInt -> Number JSON serialization globally. Use the
  // shared production serializer locally, without altering other test workers.
  host.set('json replacer', (_key: string, value: unknown) => serializeValue(value));
  host.use(express.json());
  host.use(cookieParser());
  host.use(createAccountStatusGuard(db()));
  host.use('/api/v1/approvals', createApprovalRouter({
    prisma: routeClient, requireAuth: true, onDecided,
  }));
  host.use('/api/admin', createAdminRouter({
    prisma: routeClient, requireAuth: true, apiKeys: new Set<string>(), email: noDeliveryEmail,
    ...(syncAll ? { onDecided } : {}),
  }));
  host.use('/api/v1/approvals-kernel', createApprovalKernelRouter({ prisma: routeClient, requireAuth: true }));
  return host;
}

async function account(label: string, role: FixtureRole): Promise<Actor> {
  const actor = { id: `${prefix}-${label}`, role, roleId: roleIds[role] };
  await db().userAccount.create({ data: {
    id: actor.id, displayName: `Synthetic approval ${label}`, status: 'active',
  } });
  await db().userRole.create({ data: {
    id: `${actor.id}-role`, userId: actor.id, roleId: actor.roleId,
  } });
  return actor;
}

async function fixture(label: string, options: {
  reviewerRole?: 'manager' | 'admin'; self?: boolean; initialStatus?: DecisionStatus;
} = {}): Promise<Fixture> {
  const key = `${++fixtureNumber}-${label}`;
  const requester = await account(`${key}-requester`, options.self ? 'admin' : 'sales');
  const reviewer = options.self ? requester : await account(`${key}-reviewer`, options.reviewerRole ?? 'manager');
  const outsider = await account(`${key}-non-designated-admin`, 'admin');
  const id = `${prefix}-${key}-approval`;
  await db().approvalRequest.create({ data: {
    id, requesterId: requester.id, reviewerId: reviewer.id,
    actionType: 'order:price-adjust', targetType: 'AcceptanceApprovalProbe', targetId: `${id}-synthetic-target`,
    payload: { acceptanceFixture: prefix, description: 'Synthetic persisted assignment; no real order-price approval' },
    status: options.initialStatus ?? 'pending', risk: 'high',
    decisionNote: options.initialStatus ? 'Synthetic original decision retained as history' : null,
    decidedAt: options.initialStatus ? new Date('2026-09-29T00:00:00.000Z') : null,
  } });
  return { id, requester, reviewer, outsider };
}

async function row(f: Fixture): Promise<ApprovalRequest> {
  return db().approvalRequest.findUniqueOrThrow({ where: { id: f.id } });
}

async function decisionAudits(f: Fixture) {
  // A denied-attempt audit is allowed. It must not masquerade as a successful
  // decision; this list deliberately excludes dedicated denial-audit actions.
  return db().auditLog.findMany({
    where: { targetType: 'ApprovalRequest', targetId: f.id, action: { in: decisionActions } },
    orderBy: { id: 'asc' },
  });
}

async function decide(kind: RouteKind, f: Fixture, actor: Actor, status: DecisionStatus, options: {
  host?: Express; note?: string; reviewerId?: string; permissions?: string[];
} = {}) {
  const path = kind === 'ordinary' ? `/api/v1/approvals/${f.id}/decide` : `/api/admin/approvals/${f.id}`;
  const operation = kind === 'ordinary' ? request(options.host ?? app).post(path) : request(options.host ?? app).patch(path);
  return operation.set('Authorization', signedBearer(actor, options.permissions ?? [])).send({
    status, decisionNote: options.note ?? 'Synthetic independently assigned reviewer decision',
    ...(options.reviewerId ? { reviewerId: options.reviewerId } : {}),
  });
}

function diagnostic(caseId: string, kind: RouteKind, httpStatus: number,
  before: ApprovalRequest, after: ApprovalRequest, auditBefore: number, auditAfter: number,
  fault?: SqlFaultObservation): string {
  const evidence = {
    caseId, mount: kind === 'ordinary' ? '/api/v1/approvals/:id/decide' : '/api/admin/approvals/:id',
    httpStatus, before, after, decisionAuditCountBefore: auditBefore, decisionAuditCountAfter: auditAfter,
    hookCalls: onDecided.mock.calls.length, ...(fault ? { sqlFault: fault } : {}),
  };
  const serialized = JSON.stringify(serializeValue(evidence));
  // Synthetic PG facts only; no bearer token, cookie, email credential or DB URL.
  console.info('ACCEPTANCE_APPROVAL_BOUNDARY_DIAGNOSTIC', serialized);
  return serialized;
}

async function expectDeniedUnchanged(caseId: string, kind: RouteKind, f: Fixture, actor: Actor,
  status: DecisionStatus, expectedHttp: 403 | 409, options: {
    permissions?: string[]; reviewerId?: string;
  } = {}): Promise<void> {
  const before = await row(f);
  const auditsBefore = await decisionAudits(f);
  const response = await decide(kind, f, actor, status, options);
  // Read/record the actual post-request PG facts before the first assertion so
  // that an unexpected HTTP 200 does not conceal the persisted mutation.
  const after = await row(f);
  const auditsAfter = await decisionAudits(f);
  const evidence = diagnostic(caseId, kind, response.status, before, after, auditsBefore.length, auditsAfter.length);
  expect(response.status, evidence).toBe(expectedHttp);
  expect(after, `${caseId}: every original persisted approval field must remain unchanged`).toEqual(before);
  expect(auditsAfter, `${caseId}: no successful decision audit on a denied operation`).toEqual(auditsBefore);
  expect(onDecided, `${caseId}: denied operation must not call the ordinary business-sync observer`).not.toHaveBeenCalled();
  expect(noDeliveryEmail.send, `${caseId}: no external email path is exercised`).not.toHaveBeenCalled();
}

function realSqlAuditActorFault(kind: RouteKind, missingActorId: string): {
  client: PrismaClient; observation: SqlFaultObservation;
} {
  const observation: SqlFaultObservation = { calls: [], sqlCodes: [] };
  const recordSqlError = (error: unknown) => {
    observation.sqlCodes.push(String((error as { code?: unknown })?.code ?? 'NO_PRISMA_ERROR_CODE'));
  };
  const proxyAudit = (delegate: PrismaClient['auditLog'], insideTransaction = false) => new Proxy(delegate, { get(target, key) {
    if (key === 'create') return (args: any) => {
      observation.calls.push({
        targetId: typeof args.data.targetId === 'string' ? args.data.targetId : null,
        originalActorId: typeof args.data.actorId === 'string' ? args.data.actorId : null,
        attemptedActorId: missingActorId,
      });
      const realSql = target.create({ ...args, data: { ...args.data, actorId: missingActorId } });
      // Array $transaction requires a genuine, still-lazy PrismaPromise. Do not
      // wrap the ordinary result in async/then/catch before the real transaction.
      if (kind === 'ordinary' || insideTransaction) return realSql;
      // Legacy admin awaits create directly. Record its REAL SQL failure, then
      // rethrow the same Prisma error for the actual HTTP error wrapper.
      return realSql.catch(error => { recordSqlError(error); throw error; });
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const auditLog = proxyAudit(db().auditLog);
  const client = new Proxy(db(), { get(target, key) {
    if (key === 'auditLog') return auditLog;
    if (key === '$transaction') return (...args: any[]) => {
      const original = args[0];
      const transactionArgs = typeof original === 'function' ? [async (tx: any) => original(new Proxy(tx, { get(txTarget, txKey) {
        if (txKey === 'auditLog') return proxyAudit(txTarget.auditLog, true);
        const value = Reflect.get(txTarget, txKey);
        return typeof value === 'function' ? value.bind(txTarget) : value;
      } })), ...args.slice(1)] : args;
      const realTransaction = Reflect.apply(target.$transaction, target, transactionArgs) as Promise<unknown>;
      return realTransaction.catch(error => { recordSqlError(error); throw error; });
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { client, observation };
}

async function expectRealSqlAuditRollback(caseId: string, kind: RouteKind): Promise<void> {
  const f = await fixture(`${kind}-audit-fk`, { reviewerRole: 'admin' });
  const missingActorId = `${f.id}-absent-audit-actor`;
  expect(await db().userAccount.count({ where: { id: missingActorId } }), 'SQL FK fault precondition: no referenced actor exists').toBe(0);
  const before = await row(f);
  const auditsBefore = await decisionAudits(f);
  const fault = realSqlAuditActorFault(kind, missingActorId);
  const response = await decide(kind, f, f.reviewer, 'approved', { host: createHost(fault.client) });
  const after = await row(f);
  const auditsAfter = await decisionAudits(f);
  const allTargetAudits = await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: f.id } });
  const evidence = diagnostic(caseId, kind, response.status, before, after, auditsBefore.length, auditsAfter.length, fault.observation);
  expect(fault.observation.calls, `${caseId}: the production route must attempt one real audit SQL insert`).toEqual([
    { targetId: f.id, originalActorId: f.reviewer.id, attemptedActorId: missingActorId },
  ]);
  expect(fault.observation.sqlCodes, `${caseId}: the failure must be an actual PG foreign-key violation surfaced by Prisma`).toEqual(['P2003']);
  expect(response.status, evidence).toBe(500);
  expect(after, `${caseId}: failed mandatory audit must not leave an unaudited decision; ${evidence}`).toEqual(before);
  expect(auditsAfter, `${caseId}: no decision audit partially commits`).toEqual(auditsBefore);
  expect(allTargetAudits, `${caseId}: the deliberately invalid SQL insert must not persist`).toBe(0);
  expect(onDecided, `${caseId}: aborted approval must not trigger ordinary business synchronization`).not.toHaveBeenCalled();
  expect(noDeliveryEmail.send, `${caseId}: no external email path is exercised`).not.toHaveBeenCalled();
}

describe.sequential('approval acceptance: ordinary and actual /api/admin decision boundaries on isolated PG', () => {
  beforeAll(async () => {
    const expectedName = process.env.BAMBOOK_ACCEPTANCE_DB_NAME;
    const expectedPort = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    const expectedDirectory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR;
    const url = new URL(process.env.DATABASE_URL || '');
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX), 'precondition: reviewed isolated acceptance runner is required').toBe(true);
    expect(expectedName, 'precondition: generated isolated database name is required').toMatch(/^bambook_acceptance_[a-f0-9]+$/);
    expect(expectedPort, 'precondition: explicit isolated PG port is required').toMatch(/^\d+$/);
    expect(Number(expectedPort), 'precondition: valid PG port').toBeGreaterThan(0);
    expect(Number(expectedPort), 'precondition: valid PG port').toBeLessThanOrEqual(65535);
    expect(Boolean(expectedDirectory), 'precondition: isolated PG directory identity is required').toBe(true);
    expect(url.protocol, 'precondition: actual PG transport').toBe('postgresql:');
    expect(url.hostname, 'precondition: never connect to the shared/business database').toBe('127.0.0.1');
    expect(url.port, 'precondition: runner-owned PG port must match URL').toBe(expectedPort);
    expect(url.pathname, 'precondition: runner-owned database must match URL').toBe(`/${expectedName}`);
    expect(process.env.BAMBOOK_NO_SCHEDULER, 'precondition: schedulers must be disabled').toBe('1');

    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
      SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
    `;
    expect(identity, 'precondition: verify actual PG identity before ANY fixture write').toEqual([
      { name: expectedName, directory: expectedDirectory, port: Number(expectedPort) },
    ]);
    for (const role of ['sales', 'manager', 'admin', 'owner'] as const) {
      // Do not replace existing roles/grants, touch role-finance, seed a global
      // matrix, or depend on the number of scopes elsewhere in the fresh cluster.
      await db().role.upsert({ where: { id: roleIds[role] }, update: {}, create: {
        id: roleIds[role], name: role, isSystem: true,
        description: 'Minimal approval-boundary fixture role; no permission seed',
      } });
    }
    app = createHost();
  });

  beforeEach(() => { onDecided.mockClear(); vi.mocked(noDeliveryEmail.send).mockClear(); });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('ABD01 ordinary: assigned reviewer approves without UI labels; body reviewerId cannot forge actor, and repeat is 409', async () => {
    const f = await fixture('ordinary-approved');
    const before = await row(f);
    const response = await decide('ordinary', f, f.reviewer, 'approved', {
      reviewerId: f.outsider.id, note: '  Synthetic approval with genuine assigned actor  ',
    });
    const after = await row(f);
    const audits = await decisionAudits(f);
    const evidence = diagnostic('ABD01', 'ordinary', response.status, before, after, 0, audits.length);
    expect(response.status, evidence).toBe(200);
    expect(response.body.item, 'actual serialized ordinary response').toMatchObject({
      id: f.id, status: 'approved', reviewerId: f.reviewer.id,
      decisionNote: 'Synthetic approval with genuine assigned actor',
    });
    expect(after).toMatchObject({ status: 'approved', requesterId: f.requester.id, reviewerId: f.reviewer.id,
      decisionNote: 'Synthetic approval with genuine assigned actor', payload: before.payload });
    expect(after.decidedAt).toBeInstanceOf(Date);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: f.reviewer.id, action: 'approve_business_request',
      operationType: 'transition', fieldPath: 'status', beforeValue: 'pending', afterValue: 'approved' });
    expect(onDecided).toHaveBeenCalledTimes(1);
    expect(onDecided).toHaveBeenCalledWith({ id: f.id, actionType: before.actionType,
      targetType: before.targetType, targetId: before.targetId, status: 'approved',
      reviewerId: f.reviewer.id, actualDecisionActor: f.reviewer.id,
      decisionNote: 'Synthetic approval with genuine assigned actor' });
    const repeat = await decide('ordinary', f, f.reviewer, 'approved');
    expect(repeat.status, 'single pending decision: repeating the same approval is refused').toBe(409);
    expect(await row(f), 'repeat must preserve the full decided row').toEqual(after);
    expect(await decisionAudits(f), 'repeat must not append a second successful decision').toEqual(audits);
    expect(onDecided).toHaveBeenCalledTimes(1);
    expect(noDeliveryEmail.send).not.toHaveBeenCalled();
  });

  it('ABD02 ordinary: non-designated admin with a UI approval label is denied, without state or hook mutation', async () => {
    const f = await fixture('ordinary-non-designated');
    await expectDeniedUnchanged('ABD02', 'ordinary', f, f.outsider, 'approved', 403, {
      permissions: [uiOnlyLabel], reviewerId: f.reviewer.id,
    });
  });

  it('ABD03 ordinary: applicant admin cannot self-approve even when preassigned and holding a UI label', async () => {
    const f = await fixture('ordinary-self', { self: true });
    await expectDeniedUnchanged('ABD03', 'ordinary', f, f.requester, 'approved', 403, { permissions: [uiOnlyLabel] });
  });

  it('ABD04 ordinary: assigned reviewer cannot overwrite the rejected original decision', async () => {
    const f = await fixture('ordinary-rejected-history', { initialStatus: 'rejected' });
    await expectDeniedUnchanged('ABD04', 'ordinary', f, f.reviewer, 'approved', 409);
  });

  it('ABD05 ordinary: assigned reviewer can reject once with a genuine actor, persisted audit and onDecided observation', async () => {
    const f = await fixture('ordinary-rejected');
    const response = await decide('ordinary', f, f.reviewer, 'rejected', { note: 'Synthetic rejection with preserved original request' });
    expect(response.status, 'legitimate assigned rejection is the positive control for terminal rejected history').toBe(200);
    expect(response.body.item).toMatchObject({ id: f.id, status: 'rejected', reviewerId: f.reviewer.id });
    expect(await row(f)).toMatchObject({ status: 'rejected', reviewerId: f.reviewer.id,
      decisionNote: 'Synthetic rejection with preserved original request' });
    const audits = await decisionAudits(f);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: f.reviewer.id, action: 'reject_business_request',
      beforeValue: 'pending', afterValue: 'rejected' });
    expect(onDecided).toHaveBeenCalledTimes(1);
    expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ id: f.id, status: 'rejected', reviewerId: f.reviewer.id }));
    expect(noDeliveryEmail.send).not.toHaveBeenCalled();
  });

  it('ABD06 admin TECHNICAL CONTROL: actual assigned admin writes approval and real actor audit, ignoring spoofed body reviewerId', async () => {
    const f = await fixture('admin-technical-control', { reviewerRole: 'admin' });
    const before = await row(f);
    const response = await decide('admin', f, f.reviewer, 'approved', { reviewerId: f.outsider.id });
    const after = await row(f);
    const audits = await decisionAudits(f);
    const evidence = diagnostic('ABD06', 'admin', response.status, before, after, 0, audits.length);
    expect(response.status, evidence).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(after).toMatchObject({ status: 'approved', requesterId: f.requester.id, reviewerId: f.reviewer.id, payload: before.payload });
    expect(after.decidedAt).toBeInstanceOf(Date);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: f.reviewer.id, action: 'approve' });
    // This mount has no ordinary onDecided option. Its successful SQL mutation
    // does not prove real business synchronization or full approval legality.
    expect(onDecided).not.toHaveBeenCalled();
    expect(noDeliveryEmail.send).not.toHaveBeenCalled();
  });

  it('ABD07 admin: non-designated admin cannot gain assignment through UI label or body reviewerId', async () => {
    const f = await fixture('admin-non-designated', { reviewerRole: 'admin' });
    await expectDeniedUnchanged('ABD07', 'admin', f, f.outsider, 'approved', 403, {
      permissions: [uiOnlyLabel], reviewerId: f.reviewer.id,
    });
  });

  it('ABD08 admin: applicant admin cannot self-approve without a separately authorized exception', async () => {
    const f = await fixture('admin-self', { self: true });
    await expectDeniedUnchanged('ABD08', 'admin', f, f.requester, 'approved', 403, { permissions: [uiOnlyLabel] });
  });

  it('ABD09 admin: a previously approved decision cannot be overwritten as rejected', async () => {
    const f = await fixture('admin-approved-history', { reviewerRole: 'admin', initialStatus: 'approved' });
    await expectDeniedUnchanged('ABD09', 'admin', f, f.reviewer, 'rejected', 409);
  });

  it('ABD10 admin: a previously rejected decision cannot be overwritten as approved', async () => {
    const f = await fixture('admin-rejected-history', { reviewerRole: 'admin', initialStatus: 'rejected' });
    await expectDeniedUnchanged('ABD10', 'admin', f, f.reviewer, 'approved', 409);
  });

  it('ABD11 ordinary: real audit-actor SQL FK failure rolls back the approval and successful-decision audit', async () => {
    await expectRealSqlAuditRollback('ABD11', 'ordinary');
  });

  it('ABD12 admin: real audit-actor SQL FK failure must not leave a partially committed unaudited decision', async () => {
    await expectRealSqlAuditRollback('ABD12', 'admin');
  });

  it('V1-ABD13: concurrent ordinary/admin decisions commit exactly one decision, mandatory audit and callback', async () => {
    const f = await fixture('cross-entry-race', { reviewerRole: 'admin' });
    const host = createHost(db(), true);
    const responses = await Promise.all([
      decide('ordinary', f, f.reviewer, 'approved', { host }),
      decide('admin', f, f.reviewer, 'rejected', { host }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const after = await row(f);
    expect(after.status).toBe(responses[0].status === 200 ? 'approved' : 'rejected');
    expect(await decisionAudits(f)).toHaveLength(1);
    expect(onDecided).toHaveBeenCalledTimes(1);
    expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ id: f.id, actualDecisionActor: f.reviewer.id, status: after.status }));
    expect(await db().auditLog.count({ where: { targetId: f.id, action: 'approval_sync_completed' } })).toBe(1);
    expect(noDeliveryEmail.send).not.toHaveBeenCalled();
  });

  it('V1-ABD14: delegation racing a decision cannot leave a terminal approval assigned to a new reviewer', async () => {
    const f = await fixture('delegate-decision-race', { reviewerRole: 'admin' });
    const [decision, delegation] = await Promise.all([
      decide('ordinary', f, f.reviewer, 'approved'),
      request(app).post(`/api/v1/approvals-kernel/${f.id}/delegate`).set('Authorization', signedBearer(f.reviewer))
        .send({ toUserId: f.outsider.id, reason: 'Synthetic concurrency delegation reason' }),
    ]);
    const after = await row(f);
    if (decision.status === 200) {
      expect(delegation.status).toBe(409);
      expect(after).toMatchObject({ status: 'approved', reviewerId: f.reviewer.id, delegatedAt: null });
      expect(await decisionAudits(f)).toHaveLength(1);
      expect(onDecided).toHaveBeenCalledTimes(1);
    } else {
      expect(decision.status).toBe(403);
      expect(delegation.status).toBe(200);
      expect(after).toMatchObject({ status: 'pending', reviewerId: f.outsider.id, delegatedBy: f.reviewer.id });
      expect(await decisionAudits(f)).toHaveLength(0);
      expect(onDecided).not.toHaveBeenCalled();
    }
  });

  it('V1-ABD15: a legacy JWT cannot retain BOSS decision authority after its actual database role is withdrawn', async () => {
    const f = await fixture('revoked-boss-authority');
    const boss = await account(`${++fixtureNumber}-withdrawn-boss`, 'owner');
    const staleToken = signedBearer(boss); // Existing unmarked, empty-snapshot compatibility token.
    await db().userRole.deleteMany({ where: { userId: boss.id, roleId: boss.roleId } });
    const before = await row(f);
    const response = await request(app).post(`/api/v1/approvals-kernel/${f.id}/boss-bypass`)
      .set('Authorization', staleToken).send({ reason: 'Synthetic reason with more than thirty characters for a withdrawn role' });
    expect(response.status).toBe(403);
    expect(await row(f)).toEqual(before);
    expect(await db().auditLog.count({ where: { targetId: f.id } })).toBe(0);
    expect(onDecided).not.toHaveBeenCalled();
  });
});
