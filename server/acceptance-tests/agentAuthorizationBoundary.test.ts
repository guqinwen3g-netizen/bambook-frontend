/**
 * AUTH-A independent acceptance probes; only opt-in acceptance.vitest.config.ts includes this file.
 * Business rules (not current implementation output):
 * - docs/运营落地决策基线与首批方案-2026-09-30.md:26: human/Agent share effective operation authorization.
 * - artifacts/acceptance-20261001/execution/authorization-approval-contract.md §一:
 *   a non-empty trusted snapshot is authoritative; orders:read does not authorize orders:write;
 *   failure to load permission facts cannot establish default authorization.
 * - docs/design/04-模块设计/06-资源与支撑/HR-人事管理/薪酬与工资条.md:447-463:
 *   designated HR may receive preauthorized personal hr:salary:read + sensitive:salary grants.
 *
 * Real boundaries: JWT/module guard -> Agent HTTP -> identity -> executor input; AI HTTP ->
 * prepareChatRun -> createAiRuntime -> injected chatRunner; loadAgentApiKeyActors -> strict guard.
 * Only MCP execution, model execution and storage are substituted. No tool actually writes an order.
 * Personal grants here are synthetic preauthorized facts in a Prisma double, NOT real-PG evidence,
 * grant-management/approval evidence, role-complete UAT, freshness proof or an empty-role policy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAgentRouter } from '../src/agent/route';
import { runMcpPlan } from '../src/agent/mcp/executor';
import { createAiRouter } from '../src/ai/route';
import { createAiRuntime } from '../src/ai/runtime';
import { loadAgentApiKeyActors } from '../src/auth/agentPrincipal';
import { createAuthService, type TokenPayload } from '../src/auth/service';

vi.mock('../src/agent/mcp/executor', () => ({ runMcpPlan: vi.fn(async () => []) }));

const API_KEY = 'acceptance-synthetic-agent-key';
const USER_ID = 'acceptance-agent-boundary';
const DEPT_ID = 'acceptance-agent-department';
const PLAN = { steps: [{ id: 'read-orders', toolId: 'orders.query', input: { limit: 1 } }] };
const SALARY_SCOPES = ['hr:salary:read', 'sensitive:salary'];
const executor = vi.mocked(runMcpPlan);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

function trustedActor(permissions: string[]): TokenPayload {
  return {
    userId: USER_ID, displayName: 'Synthetic Agent employee', roles: ['sales'], roleIds: ['role-sales'],
    permissions, departmentIds: [DEPT_ID],
  };
}

function makeAgentApp(prisma: any = {}, actors = new Map<string, any>()) {
  const app = express(); app.use(express.json());
  app.use('/api/agent', createAgentRouter({
    prisma, requireAuth: true, apiKeys: new Set([API_KEY]), apiKeyActors: actors,
    getRuntimeMetrics: () => ({}),
    dataSource: {
      kind: 'local-dev', runtimeEnv: 'test', database: 'postgresql', host: 'not-connected',
      name: 'synthetic-agent-boundary', isBusinessTruth: false,
      warning: 'No database connection: injected acceptance storage only.',
    },
  }));
  return app;
}

function executorSnapshot() {
  const seen = executor.mock.calls[0]?.[0];
  return JSON.stringify({
    callCount: executor.mock.calls.length, actor: seen?.actor,
    actorUserId: seen?.actorUserId, requestSource: seen?.requestSource,
  });
}

function makeRuntimeStorage() {
  let session: any = { id: 'acceptance-agent-session', userId: USER_ID, title: 'Acceptance', metadata: {} };
  return {
    userAccount: {
      findFirst: vi.fn(async ({ where }: any) => where.id === USER_ID ? { id: USER_ID } : null),
      findMany: vi.fn(async () => []),
    },
    agentSession: {
      findFirst: vi.fn(async ({ where }: any) => where.id === session.id && where.userId === USER_ID ? session : null),
      create: vi.fn(async ({ data }: any) => { session = { ...data }; return session; }),
      update: vi.fn(async ({ data }: any) => { session = { ...session, ...data }; return session; }),
    },
    agentMessage: {
      findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => ({ ...data })),
    },
  };
}

describe('AUTH-A: trusted authorization reaches the formal Agent execution boundary', () => {
  it('positive transport control: verified JWT identity wins over task-body identity', async () => {
    const token = createAuthService().signToken(trustedActor(['orders:read', 'orders:write']));
    const res = await request(makeAgentApp()).post('/api/agent/mcp/run')
      .set('Authorization', `Bearer ${token}`)
      .send({ plan: PLAN, userId: 'untrusted-body-owner', roles: ['owner'], departmentIds: ['other-department'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0]).toMatchObject({
      actor: { userId: USER_ID, roles: ['sales'], departmentIds: [DEPT_ID] },
      actorUserId: USER_ID, requestSource: 'user-session',
    });
    expect(executor.mock.calls[0][0].actor.roles).not.toContain('owner');
  });

  it.each([
    { name: 'read-only snapshot cannot regain order writes', permissions: ['orders:read'] },
    { name: 'explicit write grant remains present as the positive permission control', permissions: ['orders:read', 'orders:write'] },
  ])('$name at POST /api/agent/mcp/run', async ({ permissions }) => {
    const token = createAuthService().signToken(trustedActor(permissions));
    const res = await request(makeAgentApp()).post('/api/agent/mcp/run')
      .set('Authorization', `Bearer ${token}`)
      .send({ plan: PLAN, permissions: ['*'], roles: ['owner'], userId: 'untrusted-body-owner' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(executor).toHaveBeenCalledTimes(1);
    // permissionScopes is an existing ActorContext field, observed at the real executor call.
    const observed = executor.mock.calls[0][0].actor.permissionScopes;
    expect(observed, `trusted=${JSON.stringify(permissions)}; actual=${executorSnapshot()}`).toEqual(permissions);
    if (!permissions.includes('orders:write')) expect(observed).not.toContain('orders:write');
  });

  it('POST /api/ai/chat carries the trusted snapshot through prepareChatRun to the injected model boundary', async () => {
    const permissions = ['ai:chat', 'orders:read']; // ai:chat is required to enter this actual HTTP endpoint.
    const actor = trustedActor(permissions);
    const seen: any[] = [];
    const runtime = createAiRuntime({ chatRunner: async runRequest => {
      seen.push(runRequest);
      return { text: 'Acceptance model substitute; no tools executed.' };
    } });
    const app = express(); app.use(express.json());
    app.use('/api/ai', createAiRouter({
      prisma: makeRuntimeStorage() as any, runtime, requireAuth: true,
      apiKeys: new Set([API_KEY]), apiKeyActors: new Map(),
    }));
    const res = await request(app).post('/api/ai/chat')
      .set('Authorization', `Bearer ${createAuthService().signToken(actor)}`)
      .send({ sessionId: 'acceptance-agent-session', message: 'Read the permitted orders only.',
        userId: 'untrusted-body-owner', roles: ['owner'], permissions: ['*'], tts: { enabled: false } });
    expect(res.status, res.text).toBe(200);
    expect(res.text).toContain('event: final');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ userId: USER_ID, actorUserId: USER_ID, roles: ['sales'],
      departmentIds: [DEPT_ID], requestSource: 'user-session' });
    // Inspect the loss of the existing trusted TokenPayload.permissions, not a proposed authorization API.
    expect(seen[0].permissions, JSON.stringify({
      trustedPermissions: permissions, actualPermissions: seen[0].permissions ?? '(missing)',
      permissionsFieldPresent: Object.prototype.hasOwnProperty.call(seen[0], 'permissions'),
      forwardedFields: Object.keys(seen[0]).sort(), roles: seen[0].roles,
    })).toEqual(permissions);
    expect(seen[0].permissions).not.toContain('orders:write');
  });
});

type PersonalGrant = {
  scope: string; isActive: boolean; deletedAt: bigint | null; expiresAt: Date | null;
};

function makePrincipalStorage(opts: {
  scopes?: string[]; roleId?: string; grants?: PersonalGrant[]; fail?: 'account' | 'permission-load';
} = {}) {
  const scopes = opts.scopes ?? ['orders:read'];
  const roleId = opts.roleId ?? 'role-sales';
  const permissions = scopes.map(scope => ({ permission: { scope } }));
  const account = {
    id: USER_ID, displayName: 'Synthetic Agent employee', status: 'active', deletedAt: null,
    primaryDeptId: DEPT_ID,
    roles: [{ roleId, departmentId: DEPT_ID, role: { id: roleId, isSystem: true, permissions } }],
  };
  const failedReads: string[] = [];
  const rejectRead = (operation: string): never => {
    failedReads.push(operation); throw new Error(`Injected authorization storage failure: ${operation}`);
  };
  const prisma = {
    userAccount: {
      findFirst: vi.fn(async () => opts.fail === 'account' ? rejectRead('account.findFirst') : account),
      // A common loader may fetch account + role permissions as one relational read.
      findUnique: vi.fn(async () => opts.fail ? rejectRead('account-and-permissions.findUnique') : account),
    },
    rolePermission: {
      findMany: vi.fn(async () => opts.fail === 'permission-load' ? rejectRead('rolePermission.findMany') : permissions),
    },
    department: { findMany: vi.fn(async () => []) },
    userPermissionOverrides: {
      findMany: vi.fn(async ({ where }: any) => (opts.grants ?? []).filter(grant => {
        // Model only predicates actually supplied by production code. Omitting a filter returns
        // the disallowed rows too, so the double cannot hide an expired/inactive grant query bug.
        if (where.isActive !== undefined && grant.isActive !== where.isActive) return false;
        if (where.deletedAt === null && grant.deletedAt !== null) return false;
        if (where.OR && !where.OR.some((term: any) => term.expiresAt === null
          ? grant.expiresAt === null
          : term.expiresAt?.gt && grant.expiresAt !== null && grant.expiresAt > term.expiresAt.gt)) return false;
        return true;
      }).map(grant => ({ scope: grant.scope }))),
    },
  };
  return { prisma, failedReads };
}

async function loadActors(prisma: any) {
  vi.stubEnv('BAMBOOK_AGENT_API_KEY_MAP', `${API_KEY}=${USER_ID}`);
  return loadAgentApiKeyActors(prisma, new Set([API_KEY]));
}

function principalSnapshot(actors: Awaited<ReturnType<typeof loadAgentApiKeyActors>>) {
  const actor = actors.get(API_KEY);
  return JSON.stringify({ mapped: Boolean(actor), userId: actor?.userId, roles: actor?.roles,
    permissions: actor?.permissions, departmentIds: actor?.departmentIds });
}

describe('AUTH-A: API Key loads permission facts, never authorization from a failed DB read', () => {
  it.each([
    { scopes: ['orders:read'] }, { scopes: ['orders:read', 'orders:write'] },
  ])('positive loading control: explicit permission set $scopes is authoritative', async ({ scopes }) => {
    const fixture = makePrincipalStorage({ scopes });
    const actors = await loadActors(fixture.prisma);
    const actor = actors.get(API_KEY);
    expect(actor, principalSnapshot(actors)).toBeDefined();
    expect(actor?.permissions, principalSnapshot(actors)).toEqual(scopes);
    expect(actor?.userId).toBe(USER_ID);
    expect(actor?.departmentIds).toEqual([DEPT_ID]);
  });

  it('permission query failure cannot restore default sales rights or enter strict Agent HTTP', async () => {
    const fixture = makePrincipalStorage({ fail: 'permission-load' });
    let actors: Awaited<ReturnType<typeof loadAgentApiKeyActors>> | undefined;
    let error: unknown;
    try { actors = await loadActors(fixture.prisma); } catch (cause) { error = cause; }
    expect(fixture.failedReads.length, 'The injected permission-read failure must actually be reached.').toBeGreaterThan(0);
    // Rejecting the load itself is also fail-closed; no mapping exists to publish to the guard.
    if (error) { expect(actors).toBeUndefined(); return; }
    expect(actors).toBeDefined();
    const res = await request(makeAgentApp(fixture.prisma, actors)).post('/api/agent/mcp/run')
      .set('X-Bambook-API-Key', API_KEY).send({ plan: PLAN, roles: ['owner'], permissions: ['*'] });
    expect(res.status, `actual principal=${principalSnapshot(actors!)}; HTTP=${JSON.stringify(res.body)}`).toBe(403);
    expect(res.body.error).toBe('AGENT_PRINCIPAL_REQUIRED');
    expect(executor).not.toHaveBeenCalled();
    expect(actors!.has(API_KEY)).toBe(false);
  });

  it('negative transport control: account query failure produces no executable service principal', async () => {
    const fixture = makePrincipalStorage({ fail: 'account' });
    let actors: Awaited<ReturnType<typeof loadAgentApiKeyActors>> | undefined;
    let error: unknown;
    try { actors = await loadActors(fixture.prisma); } catch (cause) { error = cause; }
    expect(fixture.failedReads.length).toBeGreaterThan(0);
    if (error) { expect(actors).toBeUndefined(); return; }
    const res = await request(makeAgentApp(fixture.prisma, actors)).post('/api/agent/mcp/run')
      .set('X-Bambook-API-Key', API_KEY).send({ plan: PLAN });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe('AGENT_PRINCIPAL_REQUIRED');
    expect(executor).not.toHaveBeenCalled();
  });

  it('preauthorized active personal HR grants accompany the same account into API Key identity (mock storage only)', async () => {
    const fixture = makePrincipalStorage({ roleId: 'role-finance', grants: SALARY_SCOPES.map(scope => ({
      scope, isActive: true, deletedAt: null, expiresAt: new Date('2099-01-01'),
    })) });
    const actors = await loadActors(fixture.prisma);
    expect(actors.get(API_KEY)?.permissions, principalSnapshot(actors))
      .toEqual(expect.arrayContaining(['orders:read', ...SALARY_SCOPES]));
    expect(fixture.prisma.userPermissionOverrides.findMany).toHaveBeenCalled();
  });

  it.each([
    { name: 'inactive', isActive: false, deletedAt: null, expiresAt: new Date('2099-01-01') },
    { name: 'expired', isActive: true, deletedAt: null, expiresAt: new Date('2000-01-01') },
    { name: 'soft-deleted', isActive: true, deletedAt: BigInt(1), expiresAt: new Date('2099-01-01') },
  ])('$name personal grants cannot add salary rights (mock storage only)', async grant => {
    const fixture = makePrincipalStorage({ roleId: 'role-finance', grants: SALARY_SCOPES.map(scope => ({ scope, ...grant })) });
    const actors = await loadActors(fixture.prisma);
    expect(actors.get(API_KEY), principalSnapshot(actors)).toBeDefined();
    for (const scope of SALARY_SCOPES) expect(actors.get(API_KEY)?.permissions, principalSnapshot(actors)).not.toContain(scope);
  });
});
