/** Real HTTP/auth/current-snapshot -> MCP executor -> registry -> native orders query.
 * Only native storage delegates are substituted. Not PostgreSQL, deployment or browser proof. */
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentRouter } from '../route';
import { createIdentityService } from '../identity';
import { createAuthService, type TokenPayload } from '../../auth/service';
import { createAuthorizationSnapshotGuard } from '../../auth/authorizationSnapshotGuard';
import { __clearTeamShareCacheForTests } from '../../teams/teamShareService';
import { queryOrders } from '../../orders/query';

const userId = 'mcp-ceiling-employee';
const key = 'synthetic-mcp-ceiling-key';
function account(scopes: string[] = ['orders:read', 'orders:write']) {
  return { id: userId, displayName: 'Synthetic sales employee', status: 'active', deletedAt: null,
    primaryDeptId: 'sales-dept', roles: [{ roleId: 'role-sales', departmentId: 'sales-dept',
      role: { id: 'role-sales', isSystem: true, permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
}
function credential(ceiling: string[] | undefined): TokenPayload {
  return { userId, displayName: 'Synthetic sales employee', roles: ['sales'], roleIds: ['role-sales'],
    permissions: ['orders:read', 'orders:write'], authorizationLoaded: true, departmentIds: ['sales-dept'],
    ...(ceiling !== undefined ? { permissionCeiling: [...ceiling] } : {}) };
}
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([field, value]: [string, any]) => {
    if (field === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (field === 'OR') return value.some((part: any) => matches(row, part));
    if (value == null) return row[field] == null;
    if (typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[field]);
      if ('gt' in value) return row[field] > value.gt;
      if ('has' in value) return (row[field] ?? []).includes(value.has);
      if ('contains' in value) return String(row[field] ?? '').includes(value.contains);
      return row[field] != null && matches(row[field], value);
    }
    return row[field] === value;
  });
}
function fixture() {
  let current: any = account(), overrides: any[] = [], shares: any[] = [], memberships: any[] = [];
  let afterPage: (() => void) | undefined;
  const relations = [
    { id: 'own-customer', ownerId: userId, salesRepIds: [], deletedAt: null },
    { id: 'private-customer', ownerId: 'other-employee', salesRepIds: [], deletedAt: null },
    { id: 'shared-customer', ownerId: 'other-employee', salesRepIds: [], deletedAt: null },
  ];
  const rows = relations.map(customer => ({ id: `order-${customer.id}`, poNumber: `PO-${customer.id}`,
    customerRelationId: customer.id, ownerId: 'other-employee', deletedAt: null, lines: [],
    customer: customer.id, quantity: 1, status: 'Pending' }));
  const prisma: any = {
    userAccount: { findFirst: vi.fn(async ({ where, select }: any) => {
      if (!current || !matches(current, where)) return null;
      return select?.id ? { id: current.id } : current;
    }), findUnique: vi.fn(async ({ where }: any) => current && matches(current, where) ? current : null),
    findMany: vi.fn(async () => []) },
    // Current L2 resolver reloads the account and its department subtree too.
    department: { findMany: vi.fn(async () => []) },
    userPermissionOverrides: { findMany: vi.fn(async ({ where }: any) => overrides.filter(row => matches(row, where))) },
    teamMember: { findMany: vi.fn(async ({ where }: any) => memberships.filter(row => matches(row, where))) },
    teamDataGrant: { findMany: vi.fn(async ({ where }: any) => shares.filter(row => matches(row, where))) },
    relation: { findMany: vi.fn(async ({ where }: any) => relations.filter(row => matches(row, where))) },
    order: {
      findMany: vi.fn(async ({ where, skip = 0, take, select }: any) => {
        const found = rows.filter(row => matches(row, where)).slice(skip, take == null ? undefined : skip + take);
        if (!select?.id && afterPage) { const hook = afterPage; afterPage = undefined; hook(); }
        return select?.id ? found.map(row => ({ id: row.id })) : found;
      }),
      count: vi.fn(async ({ where }: any) => rows.filter(row => matches(row, where)).length),
      create: vi.fn(), update: vi.fn(), delete: vi.fn(),
    },
    agentTool: { upsert: vi.fn(async ({ create }: any) => create) },
    agentToolRun: { create: vi.fn(async ({ data }: any) => data) },
    auditLog: { create: vi.fn(async ({ data }: any) => data) },
    approvalRequest: { create: vi.fn() },
  };
  return { prisma, current: (value: any) => { current = value; }, overrides: (value: any[]) => { overrides = value; },
    afterPage: (hook: () => void) => { afterPage = hook; },
    share: () => {
      memberships = [{ userId, leftAt: null, teamId: 'mcp-share-team' }];
      shares = [{ teamId: 'mcp-share-team', entityType: 'relation', entityId: 'shared-customer', revokedAt: null, team: { deletedAt: null } }];
    }, revokeShare: () => { shares = []; },
  };
}
function application(f: ReturnType<typeof fixture>, prior: TokenPayload, options: { snapshot?: boolean; bound?: boolean } = {}) {
  const app = express(); app.use(express.json());
  const apiKeys = new Set([key]);
  const apiKeyActors = options.bound === false ? new Map<string, TokenPayload>() : new Map([[key, prior]]);
  // Same actual composition-root guard mounted before the Agent router in index.ts.
  if (options.snapshot !== false) app.use('/api', createAuthorizationSnapshotGuard({ prisma: f.prisma, apiKeys, apiKeyActors }));
  app.use('/api/agent', createAgentRouter({ prisma: f.prisma, dataSource: 'postgres' as any,
    requireAuth: true, apiKeys, apiKeyActors, getRuntimeMetrics: () => ({}) }));
  return app;
}
const forged = { userId: 'other-employee', actorId: 'other-employee', roles: ['owner'],
  permissions: ['*'], permissionScopes: ['*'], permissionCeiling: ['*'],
  actor: { ...credential(['*']), userId: 'other-employee', roles: ['owner'] } };
function body(input: Record<string, unknown> = {}) {
  return { ...forged, sessionId: 'synthetic-ceiling-http-session', plan: { steps: [{
    id: 'orders-read', toolId: 'orders.query', input: { ...forged, ...input }, reason: 'read current scoped orders',
  }] } };
}
async function post(app: express.Express, prior: TokenPayload, transport: 'jwt' | 'api-key' = 'jwt', input: Record<string, unknown> = {}) {
  const req = request(app).post('/api/agent/mcp/run');
  if (transport === 'jwt') req.set('Authorization', `Bearer ${createAuthService().signToken(prior)}`);
  else req.set('X-Bambook-API-Key', key);
  return req.send(body(input));
}
function runs(f: ReturnType<typeof fixture>) { return f.prisma.agentToolRun.create.mock.calls.map(([arg]: any) => arg.data); }
function noBusinessWrites(f: ReturnType<typeof fixture>) {
  expect(f.prisma.order.create).not.toHaveBeenCalled(); expect(f.prisma.order.update).not.toHaveBeenCalled();
  expect(f.prisma.order.delete).not.toHaveBeenCalled(); expect(f.prisma.approvalRequest.create).not.toHaveBeenCalled();
}
function success(f: ReturnType<typeof fixture>, res: any, transport: 'jwt' | 'api-key', ids = ['order-own-customer']) {
  expect(res.status).toBe(200); expect(res.body.ok).toBe(true);
  expect(res.body.actor).toMatchObject({ userId, roles: ['sales'] });
  expect(res.body.hits.map((hit: any) => hit.source)).toContain('agent-tool/orders.query');
  const run = runs(f).at(-1);
  expect(run).toMatchObject({ toolId: 'orders.query', actorId: userId, userId, requestSource: transport === 'jwt' ? 'user-session' : 'api-key', status: 'success',
    output: { ok: true, total: ids.length, count: ids.length } });
  expect(run.output.items.map((row: any) => row.id)).toEqual(ids);
  expect(JSON.stringify(res.body)).not.toContain('PO-private-customer');
  expect(f.prisma.userAccount.findFirst.mock.calls.every(([arg]: any) => arg.where.id === userId)).toBe(true);
  expect(f.prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
    actorId: userId, action: 'agent_tool_success', targetId: 'orders.query',
    detail: expect.objectContaining({ requestSource: transport === 'jwt' ? 'user-session' : 'api-key', actorId: userId }),
  }) }); noBusinessWrites(f);
}
function policyDenied(f: ReturnType<typeof fixture>, res: any) {
  // Existing MCP envelope reports a denied tool as 200 + no tool result; don't change that API here.
  expect(res.status).toBe(200); expect(res.body.hits).toEqual([]);
  expect(runs(f).at(-1)).toMatchObject({ actorId: userId, status: 'failed', error: 'INSUFFICIENT_SCOPE: orders:read' });
  expect(f.prisma.order.findMany).not.toHaveBeenCalled(); expect(f.prisma.order.count).not.toHaveBeenCalled();
  expect(f.prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'agent_tool_failed' }) });
  noBusinessWrites(f);
}
function lateDenied(f: ReturnType<typeof fixture>, res: any) {
  expect(res.status).toBe(500); expect(res.body).toMatchObject({ ok: false, error: 'AGENT_ROUTE_FAILED' });
  expect(res.body.hits).toBeUndefined(); expect(JSON.stringify(res.body)).not.toContain('PO-');
  expect(runs(f).at(-1)).toMatchObject({ status: 'failed', toolId: 'orders.query' });
  expect(runs(f).at(-1).output).toBeUndefined(); noBusinessWrites(f);
}
beforeEach(() => { vi.stubEnv('BAMBOOK_AGENT_DATA_API_BASE', ''); __clearTeamShareCacheForTests(); });
afterEach(() => vi.unstubAllEnvs());

describe('standard MCP endpoint uses the existing trusted business execution chain', () => {
  it('uses a fixture that can execute the native employee-scoped reader', async () => {
    const f = fixture();
    const result = await queryOrders(f.prisma, {}, {actor:credential(['orders:read'])});
    expect(result.count).toBe(1); noBusinessWrites(f);
  });
  const mcpBody = { jsonrpc: '2.0', id: 'call-1', method: 'tools/call',
    params: { name: 'orders.query', arguments: forged }, ...forged };
  it.each(['jwt', 'api-key'] as const)('%s tools/call reads only employee rows and records the trusted audit actor', async transport => {
    const f = fixture(), prior = credential(['orders:read']), app = application(f, prior);
    const req = request(app).post('/api/agent/mcp');
    if (transport === 'jwt') req.set('Authorization', `Bearer ${createAuthService().signToken(prior)}`);
    else req.set('X-Bambook-API-Key', key);
    const res = await req.send(mcpBody);
    expect(res.status).toBe(200); expect(res.body.id).toBe('call-1');
    expect(res.body.result.isError, JSON.stringify(runs(f))).toBe(false);
    expect(res.body.result.structuredContent.hits.map((hit: any) => hit.source)).toContain('agent-tool/orders.query');
    expect(JSON.stringify(res.body)).not.toContain('PO-private-customer');
    expect(runs(f).at(-1)).toMatchObject({actorId:userId, userId, status:'success',
      requestSource:transport === 'jwt' ? 'user-session' : 'api-key'});
    expect(runs(f).at(-1).output.items.map((row: any) => row.id)).toEqual(['order-own-customer']);
    noBusinessWrites(f);
  });
  it('does not let a credential with an empty ceiling execute through standard tools/call', async () => {
    const f = fixture(), prior = credential([]);
    const res = await request(application(f, prior)).post('/api/agent/mcp')
      .set('X-Bambook-API-Key', key).send(mcpBody);
    expect(res.body.result.isError).toBe(true);
    expect(f.prisma.order.findMany).not.toHaveBeenCalled();
    expect(runs(f).at(-1)).toMatchObject({actorId:userId,status:'failed'}); noBusinessWrites(f);
  });
  it('does not enable body-selected development authority on the standard endpoint', async () => {
    const f = fixture(), app = express(); app.use(express.json());
    app.use('/api/agent', createAgentRouter({prisma:f.prisma,dataSource:'postgres' as any,
      requireAuth:false,apiKeys:new Set(),getRuntimeMetrics:()=>({})}));
    const res = await request(app).post('/api/agent/mcp').send(mcpBody);
    expect(res.status).toBe(401); expect(runs(f)).toEqual([]); noBusinessWrites(f);
  });
  it('requires a bound principal even for MCP initialization and discovery', async () => {
    const f = fixture(), prior = credential(['orders:read']), app = application(f, prior, {bound:false});
    expect((await request(app).post('/api/agent/mcp').send({jsonrpc:'2.0',id:1,method:'initialize'})).status).toBe(401);
    expect((await request(app).post('/api/agent/mcp').set('X-Bambook-API-Key',key)
      .send({jsonrpc:'2.0',id:1,method:'tools/list'})).status).toBe(403);
    expect(runs(f)).toEqual([]); noBusinessWrites(f);
  });
});

describe('MCP actual HTTP trusted credential ceiling', () => {
  it.each(['jwt', 'api-key'] as const)('%s original permitted credential reads only current native L2 rows despite body actor forgery', async transport => {
    const f = fixture(), prior = credential(['orders:read']);
    success(f, await post(application(f, prior), prior, transport), transport);
    expect(f.prisma.order.findMany.mock.calls.filter(([arg]: any) => !arg.select?.id)).toHaveLength(1);
    expect(f.prisma.order.findMany.mock.calls.filter(([arg]: any) => arg.select?.id)).toHaveLength(1);
  });
  it.each(['jwt', 'api-key'] as const)('%s undefined ceiling retains existing authenticated/native read compatibility', async transport => {
    const f = fixture(), prior = credential(undefined);
    success(f, await post(application(f, prior), prior, transport), transport);
  });
  it.each(['jwt', 'api-key'] as const)('%s signed write-only ceiling cannot borrow current orders:read after actual auth refresh', async transport => {
    const f = fixture(), prior = credential(['orders:write']);
    prior.permissions = ['orders:write'];
    policyDenied(f, await post(application(f, prior), prior, transport));
  });
  it.each(['jwt', 'api-key'] as const)('%s explicit empty ceiling survives refresh and body star cannot restore authority', async transport => {
    const f = fixture(), prior = credential([]);
    policyDenied(f, await post(application(f, prior), prior, transport));
  });
  it('without the composition-root refresh original action policy already blocks a write-only snapshot before native query', async () => {
    const f = fixture(), prior = credential(['orders:write']); prior.permissions = ['orders:write'];
    policyDenied(f, await post(application(f, prior, { snapshot: false }), prior));
    expect(f.prisma.userPermissionOverrides.findMany).not.toHaveBeenCalled();
  });
  it('a real API key without an employee binding cannot use forged body identity', async () => {
    const f = fixture(), prior = credential(['orders:read']);
    const res = await post(application(f, prior, { bound: false }), prior, 'api-key');
    expect(res.status).toBe(403); expect(res.body.error).toBe('AGENT_PRINCIPAL_REQUIRED');
    expect(f.prisma.userAccount.findFirst).not.toHaveBeenCalled(); expect(runs(f)).toEqual([]); noBusinessWrites(f);
  });
  it('missing credential and invalid signed token cannot use body roles, actor or ceiling', async () => {
    const f = fixture(), prior = credential(['orders:read']), app = application(f, prior);
    for (const header of [undefined, 'Bearer deliberately-invalid-not-a-jwt']) {
      const req = request(app).post('/api/agent/mcp/run'); if (header) req.set('Authorization', header);
      const res = await req.send(body()); expect(res.status).toBe(401); expect(res.body.error).toBe('UNAUTHORIZED');
    }
    expect(f.prisma.userAccount.findFirst).not.toHaveBeenCalled(); expect(runs(f)).toEqual([]); noBusinessWrites(f);
  });
  it('the same bound key loses current read grant on the next real HTTP request', async () => {
    const f = fixture(), prior = credential(['orders:read']), app = application(f, prior);
    success(f, await post(app, prior, 'api-key'), 'api-key');
    f.current(account(['orders:write'])); f.prisma.order.findMany.mockClear(); f.prisma.order.count.mockClear();
    policyDenied(f, await post(app, prior, 'api-key'));
  });
  it('actual current personal read grant works and its inactive row cannot survive the signed credential', async () => {
    const f = fixture(), prior = credential(['orders:read']), app = application(f, prior);
    f.current(account(['orders:write']));
    const grant = { userId, scope: 'orders:read', isActive: true, deletedAt: null, expiresAt: null };
    f.overrides([grant]); success(f, await post(app, prior, 'jwt'), 'jwt');
    f.overrides([{ ...grant, isActive: false }]); f.prisma.order.findMany.mockClear(); f.prisma.order.count.mockClear();
    policyDenied(f, await post(app, prior));
  });
  it('grant revoked after the actual native page await rejects the entire HTTP result and records a failed original tool run', async () => {
    const f = fixture(), prior = credential(['orders:read']); f.afterPage(() => f.current(account(['orders:write'])));
    lateDenied(f, await post(application(f, prior), prior, 'api-key'));
    expect(f.prisma.order.findMany).toHaveBeenCalledTimes(1);
  });
  it('actual shared-customer L2 works; withdrawal after page await cannot expose that stale native page', async () => {
    const f = fixture(), prior = credential(['orders:read']), app = application(f, prior); f.share();
    success(f, await post(app, prior), 'jwt', ['order-own-customer', 'order-shared-customer']);
    f.afterPage(() => f.revokeShare()); lateDenied(f, await post(app, prior));
  });
  it('a disabled current account rejects the still-valid signed credential before any tool run', async () => {
    const f = fixture(), prior = credential(['orders:read']); f.current({ ...account(), status: 'disabled' });
    const res = await post(application(f, prior), prior);
    expect(res.status).toBe(401); expect(res.body.error).toBe('ACCOUNT_DISABLED');
    expect(f.prisma.order.findMany).not.toHaveBeenCalled(); expect(runs(f)).toEqual([]); noBusinessWrites(f);
  });
  it('current grant storage fault fails closed rather than returning empty successful data', async () => {
    const f = fixture(), prior = credential(['orders:read']);
    f.prisma.userPermissionOverrides.findMany.mockRejectedValue(new Error('synthetic current grant storage failure'));
    const res = await post(application(f, prior), prior, 'api-key');
    expect(res.status).toBe(503); expect(res.body.error).toBe('AUTHORIZATION_UNAVAILABLE');
    expect(f.prisma.order.findMany).not.toHaveBeenCalled(); expect(runs(f)).toEqual([]); noBusinessWrites(f);
  });
  it('native count uses the same trusted employee scope and excludes the other employee row', async () => {
    const f = fixture(), prior = credential(['orders:read']);
    const res = await post(application(f, prior), prior, 'api-key', { aggregate: 'count' });
    expect(res.status).toBe(200); expect(runs(f).at(-1)).toMatchObject({ status: 'success', output: { ok: true, aggregate: 'count', count: 1 } });
    expect(f.prisma.order.findMany).not.toHaveBeenCalled(); noBusinessWrites(f);
  });
});

describe('identity actual optional ceiling copy', () => {
  it('explicit empty and non-empty ceilings are independent copies, not aliases or inferred grants', async () => {
    for (const ceiling of [[], ['orders:write']]) {
      const input = { userId, roles: ['sales'] as const, permissions: ['orders:read'], authorizationLoaded: true as const, permissionCeiling: ceiling };
      const actor = await createIdentityService().resolveActorContext({ ...input, roles: [...input.roles] });
      expect(actor.permissionCeiling).toEqual(ceiling); expect(actor.permissionCeiling).not.toBe(ceiling);
      ceiling.push('synthetic-after-resolution'); expect(actor.permissionCeiling).not.toContain('synthetic-after-resolution');
    }
  });
  it('omitted ceiling remains omitted instead of inventing a cap for old callers', async () => {
    const actor = await createIdentityService().resolveActorContext({ userId, roles: ['sales'] });
    expect(Object.prototype.hasOwnProperty.call(actor, 'permissionCeiling')).toBe(false);
  });
});
