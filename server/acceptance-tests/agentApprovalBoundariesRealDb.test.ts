/**
 * Opt-in APPROVAL-B decision-boundary probes. Run only through the reviewed
 * isolated-PG runner; the ordinary backend config excludes acceptance-tests.
 *
 * Independent business basis:
 * - docs/运营落地决策基线与首批方案-2026-09-30.md:26: human/Agent share operation
 *   authority; special self-approval requires concrete preauthorization, scope
 *   and audit. No such company authorization is supplied by these fixtures.
 * - docs/design/04-模块设计/07-AI助手/审批与human-in-the-loop.md:468,476,636:
 *   supervisors do not self-approve; current reviewers actively delegate;
 *   the new reviewer may resolve and the old reviewer loses decision authority.
 * - docs/design/02-数据模型/底座域模型组.md:960-961: delegation audit and BOSS-only
 *   bypass identity/reason (at least 30 characters). These fields alone do not
 *   establish company permission to bypass any business rule or self-approve.
 * - docs/业务口径决策单-2026-09-17.md:163-174,317: approval scope labels do not
 *   replace the real approval kernel; claims of any amount need leader approval.
 *
 * Evidence: real PG rows/audit, real JWT verification/account-status/module/role
 * middleware and the public Agent resolve / kernel boss-bypass / delegate routes.
 * JWT claims are explicitly signed synthetic identity premises, NOT proof of
 * login issuance, live RBAC aggregation, company leader-account selection or
 * reviewer routing at creation. Pending approvals are directly stored fixtures.
 * The tool shape follows toolRuntime.ts:2310-2328 (tool:order.confirm, orders,
 * tool ID target); no ProcessDraft commit, MCP, model, resume or external action
 * is called. Only this suite's event listener is installed/removed.
 *
 * BOSS positive control is a generic synthetic non-financial, non-claim target:
 * it proves the current technical path and actual BOSS audit fields, NOT company
 * exception policy. The self-request negative has no linked/preauthorized
 * exception. A real ClaimCase/ClaimDisposition is used for the non-assigned Agent
 * negative; unchanged business rows do not prove a successful business projection.
 * There is no invented onDecided callback: the production kernel/Agent mounts
 * do not expose one. Full app bootstrap/business synchronization remains outside
 * this file's evidence. No seed, scheduler or production index is started.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { PrismaClient, type ApprovalRequest, type AuditLog } from '@prisma/client';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { createAccountStatusGuard, invalidateAccountStatusCache } from '../src/auth/accountStatusGuard';
import { createAgentRouter } from '../src/agent/route';
import { approvalEventBus } from '../src/agent/events';
import { createApprovalKernelRouter } from '../src/approvals/approvalKernelRoute';

type ActorFixture = { id: string; displayName: string; roles: TokenPayload['roles']; permissions: string[]; token: string };
type ResolutionEvent = { approvalId: string; resolution: { decision: string; decisionNote?: string; modifiedInput?: unknown } };
type Snapshot = { row: ApprovalRequest; audits: AuditLog[]; events: ResolutionEvent[] };

const prefix = `acceptance-agent-approval-${randomUUID()}`;
const longReason = 'Synthetic generic review only; independent test evidence records the actual boss identity and full reason.';
const delegateReason = 'Synthetic reviewer actively transfers this tool approval to the designated replacement reviewer.';
const resolvedEvents: ResolutionEvent[] = [];
const actors = new Map<string, ActorFixture>();
let prisma: PrismaClient | undefined;
let app: Express;
let fixtureNumber = 0;

function db(): PrismaClient {
  if (!prisma) throw new Error('APPROVAL-B fixture precondition: isolated client not initialized');
  return prisma;
}

const jsonReplacer = (_key: string, value: unknown): unknown => typeof value === 'bigint' ? Number(value) : value;
const onResolved = (approvalId: string, resolution: ResolutionEvent['resolution']): void => {
  if (approvalId.startsWith(prefix)) resolvedEvents.push({ approvalId, resolution });
};

function actor(label: string): ActorFixture {
  const value = actors.get(label);
  if (!value) throw new Error(`APPROVAL-B fixture actor missing: ${label}`);
  return value;
}

async function createActor(label: string, role: TokenPayload['roles'][number]): Promise<void> {
  const id = `${prefix}-actor-${label}`;
  const displayName = `Synthetic APPROVAL-B ${label}`;
  await db().userAccount.create({ data: { id, displayName, status: 'active', metadata: { acceptanceFixture: prefix } } });
  // V1 checks technical BOSS authority against current persisted assignments,
  // rather than accepting a signed role premise as the database authority.
  if (role === 'owner') {
    const roleId = 'role-super-admin';
    await db().role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: 'Synthetic technical owner', isSystem: true } });
    await db().userRole.create({ data: { id: `${id}-role`, userId: id, roleId } });
  }
  // Explicit trusted JWT role premises; no mutation of shared role/permission
  // defaults and no claim that a company BOSS/leader was selected by a loader.
  const payload: TokenPayload = {
    userId: id, displayName, roles: [role], departmentIds: [],
    permissions: role === 'owner' ? ['approvals:boss_final_bypass'] : ['orders:read'],
  };
  const service = createAuthService();
  const token = service.signToken(payload);
  expect(service.verifyToken(token).userId, 'fixture JWT must verify through the production secret source').toBe(id);
  actors.set(label, { id, displayName, roles: payload.roles, permissions: payload.permissions, token });
}

async function pending(label: string, requester = actor('requester'), reviewer = actor('reviewer'), generic = false): Promise<ApprovalRequest> {
  const id = `${prefix}-${++fixtureNumber}-${label}`;
  return db().approvalRequest.create({ data: {
    id, requesterId: requester.id, reviewerId: reviewer.id, status: 'pending', risk: 'high',
    actionType: generic ? 'acceptance:synthetic-review' : 'tool:order.confirm',
    targetType: generic ? 'AcceptanceSyntheticDocument' : 'orders',
    targetId: generic ? `${id}-document` : 'order.confirm',
    payload: generic
      ? { acceptanceFixture: prefix, genericNonFinancialTarget: true }
      : { acceptanceFixture: prefix, toolId: 'order.confirm', toolName: 'Confirm Order (Flow API)', scope: 'orders', input: {}, requestedAt: new Date().toISOString() },
  } });
}

async function snapshot(approval: ApprovalRequest): Promise<Snapshot> {
  const [row, audits] = await Promise.all([
    db().approvalRequest.findUnique({ where: { id: approval.id } }),
    db().auditLog.findMany({ where: {
      // Only completed decisions/transfers are compared. A legitimate rejection
      // may append its own denial audit without violating the no-success rule.
      action: { in: ['agent_approval_approved', 'agent_approval_rejected', 'agent_approval_modified', 'delegate_approval', 'boss_final_bypass'] },
      OR: [
      { targetType: 'ApprovalRequest', targetId: approval.id },
      { detail: { path: ['approvalId'], equals: approval.id } },
      // A prefix-owned business target may receive domain audit, too. The shared
      // tool target 'order.confirm' must NOT pull other fixtures' audit records.
      ...(approval.targetId?.startsWith(prefix) ? [{ targetType: approval.targetType, targetId: approval.targetId }] : []),
    ] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  ]);
  expect(row, 'fixture approval must still exist in real PG').not.toBeNull();
  if (!row) throw new Error('fixture approval disappeared');
  return { row, audits, events: resolvedEvents.filter(event => event.approvalId === approval.id).map(event => ({ ...event, resolution: { ...event.resolution } })) };
}

async function post(subject: ActorFixture, path: string, body: Record<string, unknown>) {
  const response = await request(app).post(path).set('Authorization', `Bearer ${subject.token}`).send(body);
  expect(response.headers['x-acceptance-fixture'], 'response must come from this mounted real-router fixture').toBe(prefix);
  return response;
}

function diagnose(label: string, subject: ActorFixture, response: { status: number; body: unknown }, before: Snapshot, after: Snapshot): void {
  // No bearer/cookie/secret is logged. Actual principal claims, status and real
  // stored row/audit/event deltas are retained even when the negative fails.
  console.info('[acceptance-agent-approval]', JSON.stringify({
    label, actor: { userId: subject.id, roles: subject.roles, permissions: subject.permissions },
    actual: { httpStatus: response.status, body: response.body }, before, after,
  }, jsonReplacer));
}

async function expectDenied(label: string, approval: ApprovalRequest, subject: ActorFixture, path: string, body: Record<string, unknown>, expectedStatus: number): Promise<void> {
  const before = await snapshot(approval);
  const response = await post(subject, path, body);
  const after = await snapshot(approval);
  diagnose(label, subject, response, before, after);
  expect.soft(response.status, `${label}: authenticated request must be rejected at the actual decision boundary`).toBe(expectedStatus);
  expect.soft(after.row, `${label}: rejection must preserve every stored approval field`).toEqual(before.row);
  expect.soft(after.audits, `${label}: rejection must not append a decision/delegation audit`).toEqual(before.audits);
  expect.soft(after.events, `${label}: rejection must not wake a waiting Agent`).toEqual(before.events);
}

async function expectAgentApproved(label: string, approval: ApprovalRequest, subject: ActorFixture): Promise<void> {
  const before = await snapshot(approval);
  const comment = `${label}: synthetic assigned reviewer permits only this tool approval decision.`;
  const response = await post(subject, `/api/agent/approvals/${approval.id}/resolve`, { decision: 'approved', comment });
  const after = await snapshot(approval);
  diagnose(label, subject, response, before, after);
  expect.soft(response.status, `${label}: assigned reviewer positive transport/decision control`).toBe(200);
  expect.soft(response.body.ok, `${label}: actual Agent response contract`).toBe(true);
  expect.soft(response.body.approval?.id).toBe(approval.id);
  expect.soft(after.row.status).toBe('approved');
  expect.soft(after.row.requesterId).toBe(before.row.requesterId);
  expect.soft(after.row.reviewerId, 'actual acting reviewer must remain identifiable').toBe(subject.id);
  expect.soft(after.row.decidedAt).toBeInstanceOf(Date);
  expect.soft(after.row.decisionNote).toBe(comment);
  expect.soft(after.row.bossFinalBypassBy, 'ordinary Agent decision must not pretend to be BOSS bypass').toBeNull();
  const resolution = (after.row.payload as Record<string, unknown>).resolution as Record<string, unknown> | undefined;
  expect.soft(resolution).toMatchObject({ decision: 'approved', reviewerId: subject.id, reviewerDisplayName: subject.displayName, decisionNote: comment });
  expect.soft(after.audits.length - before.audits.length, 'one real decision audit must be appended').toBe(1);
  const audit = after.audits.find(item => item.action === 'agent_approval_approved');
  expect.soft(audit).toMatchObject({ actorId: subject.id, targetType: approval.targetType, targetId: approval.targetId });
  expect.soft(audit?.detail).toMatchObject({ approvalId: approval.id, decision: 'approved', reviewerActor: { userId: subject.id, roles: subject.roles } });
  expect.soft(after.events.slice(before.events.length)).toEqual([{ approvalId: approval.id, resolution: { decision: 'approved', decisionNote: comment, modifiedInput: undefined } }]);
}

async function delegateToBoss(approval: ApprovalRequest): Promise<ApprovalRequest> {
  const subject = actor('reviewer');
  const replacement = actor('boss');
  const before = await snapshot(approval);
  const response = await post(subject, `/api/v1/approvals-kernel/${approval.id}/delegate`, { toUserId: replacement.id, reason: delegateReason });
  const after = await snapshot(approval);
  diagnose('current reviewer actively delegates tool approval', subject, response, before, after);
  expect(response.status, 'delegate positive control must succeed before testing the new/old decision authority').toBe(200);
  expect(after.row).toEqual({ ...before.row, reviewerId: replacement.id, delegatedBy: subject.id, delegatedAt: after.row.delegatedAt, delegateReason });
  expect(after.row.delegatedAt).toBeInstanceOf(Date);
  expect(after.row.status).toBe('pending');
  expect(after.audits.length - before.audits.length).toBe(1);
  const audit = after.audits.find(item => item.action === 'delegate_approval');
  expect(audit).toMatchObject({ actorId: subject.id, targetType: 'ApprovalRequest', targetId: approval.id, fieldPath: 'reviewerId', beforeValue: subject.id, afterValue: replacement.id });
  expect(audit?.detail).toMatchObject({ delegatedTo: replacement.id, delegateReason });
  expect(after.events, 'delegation is not a decision/resume event').toEqual(before.events);
  return after.row;
}

describe.sequential('APPROVAL-B: isolated PG Agent decision and kernel BOSS/delegation boundaries', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    const expectedName = process.env.BAMBOOK_ACCEPTANCE_DB_NAME;
    const expectedPort = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    const expectedDirectory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX), 'precondition: use the reviewed isolated acceptance runner').toBe(true);
    expect(url.protocol, 'precondition: actual PostgreSQL transport').toBe('postgresql:');
    expect(url.hostname, 'precondition: shared/business DB is forbidden').toBe('127.0.0.1');
    expect(url.port, 'precondition: runner-owned PG port').toBe(expectedPort);
    expect(url.pathname, 'precondition: runner-owned DB name').toBe(`/${expectedName}`);
    expect(url.pathname, 'precondition: isolated acceptance namespace').toMatch(/^\/bambook_acceptance_[a-f0-9]+$/);
    expect(Boolean(expectedDirectory), 'precondition: independent PG directory identity required').toBe(true);
    expect(process.env.BAMBOOK_NO_SCHEDULER, 'precondition: schedulers disabled').toBe('1');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
      SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
    `;
    expect(identity, 'precondition: verify real PG identity BEFORE fixture writes').toEqual([
      { name: expectedName, directory: expectedDirectory, port: Number(expectedPort) },
    ]);
    await createActor('requester', 'sales');
    await createActor('reviewer', 'manager');
    await createActor('unassigned-manager', 'manager');
    await createActor('boss', 'owner');
    await createActor('admin', 'admin');
    approvalEventBus.on('resolved', onResolved);

    app = express();
    // Same numeric BigInt JSON result as index.ts:424-428, confined to this app.
    app.set('json replacer', jsonReplacer);
    app.use(express.json());
    app.use(cookieParser());
    app.use((_req, res, next) => { res.set('x-acceptance-fixture', prefix); next(); });
    app.use(createAccountStatusGuard(db()));
    app.use('/api/agent', createAgentRouter({
      prisma: db(), requireAuth: true, apiKeys: new Set<string>(), apiKeyActors: new Map<string, TokenPayload>(),
      dataSource: { kind: 'local-dev', runtimeEnv: 'test', database: 'postgres', host: '127.0.0.1', name: expectedName!, isBusinessTruth: false },
      getRuntimeMetrics: () => ({}),
    }));
    app.use('/api/v1/approvals-kernel', createApprovalKernelRouter({ prisma: db(), requireAuth: true }));
  });

  afterAll(async () => {
    approvalEventBus.off('resolved', onResolved);
    for (const subject of actors.values()) invalidateAccountStatusCache(subject.id);
    // Keep prefix-owned evidence; the runner disposes its temporary cluster.
    // Never delete another suite's rows or remove another event listener.
    await prisma?.$disconnect();
  });

  it('A1: assigned manager may approve a tool request with real actor/audit/event evidence', async () => {
    const approval = await pending('assigned-tool-positive');
    await expectAgentApproved('A1 assigned tool reviewer', approval, actor('reviewer'));
  });

  it('A2: a different manager may not resolve a tool request assigned to another person', async () => {
    const approval = await pending('unassigned-tool-manager');
    await expectDenied('A2 non-assigned manager', approval, actor('unassigned-manager'), `/api/agent/approvals/${approval.id}/resolve`, { decision: 'approved', comment: 'Same role does not confer this reviewer assignment.' }, 403);
  });

  it('A3: a manager requesting their own tool approval may not self-approve', async () => {
    const applicant = actor('unassigned-manager');
    const approval = await pending('self-request-manager', applicant);
    await expectDenied('A3 ordinary self-approval', approval, applicant, `/api/agent/approvals/${approval.id}/resolve`, { decision: 'approved' }, 403);
  });

  it('A4: Agent resolve may not let a non-assigned manager decide a real aftersales disposition approval', async () => {
    const id = `${prefix}-claim-negative`;
    const now = BigInt(Date.now());
    const claimCase = await db().claimCase.create({ data: {
      id: `${id}-case`, caseNumber: `${id}-case-number`, status: 'PendingApproval', category: 'Quality',
      problemDesc: 'Synthetic claim approval-boundary fixture; no actual customer settlement.',
      reportedAt: '2026-10-01', reportedBy: actor('requester').id, createdAt: now, updatedAt: now,
    } });
    const disposition = await db().claimDisposition.create({ data: {
      id: `${id}-disposition`, claimCaseId: claimCase.id, kind: 'Allowance', amount: '100', currency: 'CNY',
      status: 'Draft', createdAt: now, updatedAt: now,
    } });
    // The supplied assigned account is a stored premise, not a claim that this
    // test has resolved the company's total-leader identity/routing policy.
    const approval = await db().approvalRequest.create({ data: {
      id: `${id}-approval`, requesterId: actor('requester').id, reviewerId: actor('admin').id,
      actionType: 'aftersales:claim-disposition', targetType: 'ClaimDisposition', targetId: disposition.id,
      status: 'pending', payload: { claimCaseId: claimCase.id, kind: 'Allowance', amount: '100', currency: 'CNY', quantity: null, returnDisposition: null },
    } });
    await expectDenied('A4 business approval through Agent', approval, actor('unassigned-manager'), `/api/agent/approvals/${approval.id}/resolve`, { decision: 'approved' }, 403);
    const afterCase = await db().claimCase.findUnique({ where: { id: claimCase.id } });
    const afterDisposition = await db().claimDisposition.findUnique({ where: { id: disposition.id } });
    console.info('[acceptance-agent-approval-domain]', JSON.stringify({ label: 'A4', approvalId: approval.id, claimCase: afterCase, disposition: afterDisposition }, jsonReplacer));
    expect.soft(afterCase, 'non-assigned rejection must preserve the real claim case').toEqual(claimCase);
    expect.soft(afterDisposition, 'non-assigned rejection must not create an approved/executed disposition').toEqual(disposition);
  });

  it('A5: Agent cannot rewrite a decision already made by the assigned reviewer', async () => {
    const pendingApproval = await pending('agent-already-decided');
    const approval = await db().approvalRequest.update({ where: { id: pendingApproval.id }, data: { status: 'rejected', decisionNote: 'Synthetic earlier final decision', decidedAt: new Date() } });
    await expectDenied('A5 immutable decided request', approval, actor('reviewer'), `/api/agent/approvals/${approval.id}/resolve`, { decision: 'approved' }, 409);
  });

  it('K1: generic non-self BOSS technical control records the actual boss and reason in real PG audit', async () => {
    const approval = await pending('boss-generic-positive', actor('requester'), actor('reviewer'), true);
    const subject = actor('boss');
    const before = await snapshot(approval);
    expect(longReason.trim().length, 'positive reason must satisfy the existing 30-character contract').toBeGreaterThanOrEqual(30);
    const response = await post(subject, `/api/v1/approvals-kernel/${approval.id}/boss-bypass`, { reason: longReason });
    const after = await snapshot(approval);
    diagnose('K1 generic BOSS technical control; no company exception policy proof', subject, response, before, after);
    expect.soft(response.status).toBe(200);
    expect.soft(response.body.item?.id, 'actual kernel response contract').toBe(approval.id);
    expect.soft(after.row.status).toBe('approved');
    expect.soft(after.row.reviewerId, 'original reviewer must not be mislabeled as the deciding boss').toBe(actor('reviewer').id);
    expect.soft(after.row.requesterId).toBe(actor('requester').id);
    expect.soft(after.row.bossFinalBypassBy).toBe(subject.id);
    expect.soft(after.row.bossFinalBypassAt).toBeInstanceOf(Date);
    expect.soft(after.row.bossFinalBypassAt).toEqual(after.row.decidedAt);
    expect.soft(after.row.bossFinalBypassReason).toBe(longReason);
    expect.soft(after.row.decisionNote).toBe(`[BOSS_FINAL_BYPASS] ${longReason}`);
    expect.soft(after.audits.length - before.audits.length).toBe(1);
    const audit = after.audits.find(item => item.action === 'boss_final_bypass');
    expect.soft(audit).toMatchObject({ actorId: subject.id, targetType: 'ApprovalRequest', targetId: approval.id, operationType: 'transition', fieldPath: 'status', beforeValue: 'pending', afterValue: 'approved' });
    expect.soft(audit?.detail).toMatchObject({ source: 'api:approvals-kernel', originalReviewerId: actor('reviewer').id, bossFinalBypassReason: longReason });
    expect.soft(after.events.slice(before.events.length)).toEqual([{ approvalId: approval.id, resolution: { decision: 'approved', decisionNote: `[BOSS_FINAL_BYPASS] ${longReason}` } }]);
  });

  it('K2: BOSS requester with no concrete preauthorization cannot bypass their own pending request', async () => {
    const subject = actor('boss');
    const approval = await pending('boss-self-no-preauthorization', subject, actor('reviewer'), true);
    await expectDenied('K2 owner label is not specific self-approval preauthorization', approval, subject, `/api/v1/approvals-kernel/${approval.id}/boss-bypass`, { reason: longReason }, 403);
  });

  it('K3: a non-owner admin cannot use the BOSS bypass endpoint', async () => {
    const approval = await pending('non-owner-bypass', actor('requester'), actor('reviewer'), true);
    await expectDenied('K3 non-owner BOSS boundary', approval, actor('admin'), `/api/v1/approvals-kernel/${approval.id}/boss-bypass`, { reason: longReason }, 403);
  });

  it('K4: an owner cannot bypass with a 29-character audit reason', async () => {
    const approval = await pending('short-reason-bypass', actor('requester'), actor('reviewer'), true);
    await expectDenied('K4 30-character reason boundary', approval, actor('boss'), `/api/v1/approvals-kernel/${approval.id}/boss-bypass`, { reason: 'x'.repeat(29) }, 400);
  });

  it('K5: BOSS bypass cannot replace an existing rejected decision', async () => {
    const original = await pending('boss-already-decided', actor('requester'), actor('reviewer'), true);
    const approval = await db().approvalRequest.update({ where: { id: original.id }, data: { status: 'rejected', decidedAt: new Date(), decisionNote: 'Synthetic preserved rejection' } });
    await expectDenied('K5 already-decided bypass', approval, actor('boss'), `/api/v1/approvals-kernel/${approval.id}/boss-bypass`, { reason: longReason }, 409);
  });

  it('D1: current reviewer may actively delegate a tool request and the new assigned reviewer may resolve', async () => {
    const approval = await delegateToBoss(await pending('delegated-new-reviewer-positive'));
    await expectAgentApproved('D1 new delegated reviewer', approval, actor('boss'));
    const stored = await db().approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    expect(stored.delegatedBy, 'original reviewer remains in the delegation history').toBe(actor('reviewer').id);
    expect(stored.delegatedAt).toEqual(approval.delegatedAt);
    expect(stored.delegateReason).toBe(delegateReason);
  });

  it('D2: old non-owner reviewer cannot resolve a still-pending tool request after actively delegating it', async () => {
    // Separate pending fixture: testing only after the new reviewer already
    // decided would get 409 and would NOT prove the old reviewer's loss of power.
    const approval = await delegateToBoss(await pending('delegated-old-reviewer-negative'));
    await expectDenied('D2 old reviewer loses authority while pending', approval, actor('reviewer'), `/api/agent/approvals/${approval.id}/resolve`, { decision: 'approved' }, 403);
  });
});
