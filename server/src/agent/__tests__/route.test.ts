import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAgentRouter } from '../route';
import { createAuthService, type TokenPayload } from '../../auth/service';
import { runMcpPlan } from '../mcp/executor';

vi.mock('../mcp/executor', () => ({
  runMcpPlan: vi.fn(async () => []),
}));

function makeApp(requireAuth = false, prismaOverride?: any, opts?: { apiKeyActors?: Map<string, any> }) {
  const app = express();
  app.use(express.json());
  const prisma = prismaOverride || {
    userAccount: {
      count: async () => 0,
    },
    agentToolRun: {
      count: async () => 0,
      findFirst: async () => null,
    },
    auditLog: {
      findFirst: async () => null,
    },
  } as any;
  app.use('/api/agent', createAgentRouter({
    prisma,
    dataSource: {
      kind: 'local-dev',
      runtimeEnv: 'test',
      database: 'postgresql',
      host: 'localhost',
      name: 'panda_hub_local',
      isBusinessTruth: false,
      warning: 'Local development database only.',
    },
    requireAuth,
    apiKeys: new Set(['test-key']),
    apiKeyActors: opts?.apiKeyActors,
    getRuntimeMetrics: () => ({ activeSessions: 0 }),
  }));
  return app;
}

describe('Agent status route', () => {
  it('returns Agent OS identity, tool, memory, knowledge, and job status', async () => {
    const res = await request(makeApp()).get('/api/agent/status');

    expect(res.status).toBe(200);
    expect(res.body.agent).toMatchObject({
      name: 'Bambook Enterprise Agent OS',
      host: 'mac-mini',
      knowledge: { store: 'postgres', acl: true },
      memory: { scopes: ['personal', 'role', 'department', 'company', 'system'] },
      jobs: { queue: 'postgres' },
      dataSource: { kind: 'local-dev', isBusinessTruth: false },
      runtimeMetrics: { activeSessions: 0 },
    });
    expect(res.body.agent.identity.roles.map((role: any) => role.id)).toContain('finance');
  });

  it('requires the Bambook API key when auth is enabled', async () => {
    const missing = await request(makeApp(true)).get('/api/agent/status');
    const ok = await request(makeApp(true)).get('/api/agent/status').set('X-Bambook-API-Key', 'test-key');

    expect(missing.status).toBe(401);
    expect(ok.status).toBe(200);
  });

  it('exposes MCP manifest endpoint', async () => {
    const manifest = await request(makeApp()).get('/api/agent/mcp/manifest');

    expect(manifest.status).toBe(200);
    expect(manifest.body.tools.map((tool: any) => tool.id)).toEqual(expect.arrayContaining([
      'products.query',
      'relations.query',
      'orders.query',
      'knowledge.search',
      'entities.search',
    ]));
    // Task 60 e2e：Phase 7 Runtime 2.0 manifest 契约
    expect(manifest.body.schemaVersion).toBe('2026-06-runtime-2.0');
    expect(manifest.body.summary).toMatchObject({
      total: expect.any(Number),
      byDomain: expect.any(Object),
      byRisk: expect.any(Object),
      approvalRequired: expect.any(Array),
    });
    // 每个工具都必须带 safety + inputHint，缺一不可
    for (const tool of manifest.body.tools) {
      expect(tool).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        domain: expect.any(String),
        risk: expect.any(String),
        safety: {
          approval: expect.stringMatching(/^(never|risk_based|always)$/),
          sideEffects: expect.any(Boolean),
        },
      });
      expect(typeof tool.inputHint).toBe('string');
    }
    // 注：/mcp/plan 端点已随 planner.ts dead code 清理移除（Phase 0 W3）
  });

  it('creates sessions only for the real JWT actor and ignores dev-only headers', async () => {
    const token = createAuthService().signToken({
      userId: 'owner_1',
      displayName: 'Kevin',
      roles: ['owner'],
      permissions: ['*'],
      departmentIds: ['company'],
    });
    const createdSessions: any[] = [];
    const prisma = {
      userAccount: {
        count: async () => 1,
        findFirst: async () => ({ id: 'owner_1' }),
      },
      agentSession: {
        create: async (args: any) => {
          createdSessions.push(args.data);
          return {
            ...args.data,
            createdAt: new Date('2026-06-11T00:00:00.000Z'),
            updatedAt: new Date('2026-06-11T00:00:00.000Z'),
          };
        },
      },
      agentToolRun: {
        count: async () => 0,
        findFirst: async () => null,
      },
      auditLog: {
        findFirst: async () => null,
      },
    };

    const res = await request(makeApp(false, prisma))
      .post('/api/agent/sessions')
      .set('Authorization', `Bearer ${token}`)
      .set('x-bambook-dev-only', 'local-agent-runtime')
      .send({ title: '本地 Agent 测试' });

    expect(res.status).toBe(200);
    expect(createdSessions[0]).toMatchObject({
      userId: 'owner_1',
      title: '本地 Agent 测试',
      memoryScopes: ['personal:owner_1'],
    });
  });
});

describe('GET /sessions（历史会话搜索与游标分页）', () => {
  const sign = (userId: string) =>
    createAuthService().signToken({ userId, displayName: userId, roles: ['owner'], permissions: ['*'], departmentIds: ['company'] });

  function makeSessionsPrisma(rows: any[]) {
    const calls: any[] = [];
    const prisma = {
      userAccount: {
        count: async () => 1,
        findFirst: async () => ({ id: 'u1' }),
      },
      agentSession: {
        findMany: async (args: any) => {
          calls.push(args);
          return rows;
        },
      },
      agentToolRun: {
        count: async () => 0,
        findFirst: async () => null,
      },
      auditLog: {
        findFirst: async () => null,
      },
    };
    return { prisma, calls };
  }

  const makeRow = (id: string) => ({
    id,
    title: `会话 ${id}`,
    status: 'active',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-02T00:00:00.000Z'),
    messages: [],
    _count: { messages: 0 },
  });

  it('默认 take=50：多取 1 条探测 hasMore 并输出 nextCursor', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => makeRow(`as_${String(i).padStart(3, '0')}`));
    const { prisma, calls } = makeSessionsPrisma(rows);
    const res = await request(makeApp(false, prisma))
      .get('/api/agent/sessions')
      .set('Authorization', `Bearer ${sign('u1')}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessions).toHaveLength(50);
    expect(res.body.pageInfo).toEqual({ hasMore: true, nextCursor: 'as_049', take: 50 });
    expect(calls).toHaveLength(1);
    expect(calls[0].take).toBe(51);
    expect(calls[0].cursor).toBeUndefined();
    expect(calls[0].orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }]);
    expect(calls[0].where).toEqual({ userId: 'u1', deletedAt: null });
  });

  it('不足一页时 hasMore=false 且 nextCursor=null', async () => {
    const { prisma } = makeSessionsPrisma([makeRow('as_1'), makeRow('as_2')]);
    const res = await request(makeApp(false, prisma))
      .get('/api/agent/sessions')
      .set('Authorization', `Bearer ${sign('u1')}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.pageInfo).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('携带 cursor 时按 id 锚定并 skip 1', async () => {
    const { prisma, calls } = makeSessionsPrisma([makeRow('as_9')]);
    const res = await request(makeApp(false, prisma))
      .get('/api/agent/sessions?cursor=as_5')
      .set('Authorization', `Bearer ${sign('u1')}`);

    expect(res.status).toBe(200);
    expect(calls[0].cursor).toEqual({ id: 'as_5' });
    expect(calls[0].skip).toBe(1);
    expect(res.body.pageInfo).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('search 命中标题或消息内容（OR contains insensitive），并作用于 where', async () => {
    const { prisma, calls } = makeSessionsPrisma([makeRow('as_hit')]);
    const res = await request(makeApp(false, prisma))
      .get('/api/agent/sessions?search=%E9%9D%A2%E6%96%99')
      .set('Authorization', `Bearer ${sign('u1')}`);

    expect(res.status).toBe(200);
    expect(calls[0].where).toEqual({
      userId: 'u1',
      deletedAt: null,
      OR: [
        { title: { contains: '面料', mode: 'insensitive' } },
        { messages: { some: { deletedAt: null, content: { contains: '面料', mode: 'insensitive' } } } },
      ],
    });
  });

  it('search 为空白串时不添加 OR 条件', async () => {
    const { prisma, calls } = makeSessionsPrisma([]);
    const res = await request(makeApp(false, prisma))
      .get('/api/agent/sessions?search=%20%20')
      .set('Authorization', `Bearer ${sign('u1')}`);

    expect(res.status).toBe(200);
    expect(calls[0].where).toEqual({ userId: 'u1', deletedAt: null });
  });

  it('take 参数截断到 1-100 区间', async () => {
    const { prisma, calls } = makeSessionsPrisma([]);
    const res = await request(makeApp(false, prisma))
      .get('/api/agent/sessions?take=500')
      .set('Authorization', `Bearer ${sign('u1')}`);

    expect(res.status).toBe(200);
    expect(calls[0].take).toBe(101);

    const res2 = await request(makeApp(false, prisma))
      .get('/api/agent/sessions?take=abc')
      .set('Authorization', `Bearer ${sign('u1')}`);
    expect(res2.status).toBe(200);
    expect(calls[1].take).toBe(51);
  });
});

describe('POST /approvals/:id/resolve（Agent 工具审批决策）', () => {
  const sign = (userId: string, roles: TokenPayload['roles']) =>
    createAuthService().signToken({ userId, displayName: userId, roles, permissions: ['*'], departmentIds: ['company'] });

  function makeResolvePrisma(approval: any) {
    const updates: any[] = [];
    let current = approval ? { ...approval } : null;
    const read = async ({ where }: any) => current?.id === where.id ? { ...current } : null;
    const prisma: any = {
      approvalRequest: {
        findUnique: read, findUniqueOrThrow: read,
        updateMany: async ({ where, data }: any) => {
          if (current?.status !== where.status || current?.reviewerId !== where.reviewerId) return { count: 0 };
          updates.push({ where, data }); current = { ...current, ...data }; return { count: 1 };
        },
      },
      userAccount: { count: async () => 1, findFirst: async ({ where }: any) => ({ id: where.id }) },
      userRole: { findMany: async ({ where }: any) => [{ roleId: where.userId === 'u_owner' ? 'role-super-admin' : 'role-sales-manager' }] },
      agentToolRun: { count: async () => 0, findFirst: async () => null },
      auditLog: { findFirst: async () => null, create: vi.fn(async () => ({})) },
      $queryRaw: vi.fn(async () => []),
      $transaction: vi.fn(async (callback: any) => {
        const before = current; const count = updates.length;
        try { return await callback(prisma); } catch (error) { current = before; updates.splice(count); throw error; }
      }),
    };
    return { prisma, updates };
  }

  const baseApproval = {
    id: 'ar_test_1',
    requesterId: 'u_requester',
    reviewerId: 'u_owner',
    actionType: 'tool:orders.update',
    targetType: 'orders',
    targetId: 'orders.update',
    status: 'pending',
    risk: 'high',
    payload: { toolId: 'orders.update', input: {} },
    decisionNote: null,
    createdAt: new Date('2026-08-16T00:00:00.000Z'),
    decidedAt: null,
  };

  it('自审禁止：requesterId === 当前用户（owner 角色）→ 403 SELF_APPROVAL_FORBIDDEN 且不写库', async () => {
    const { prisma, updates } = makeResolvePrisma({ ...baseApproval, requesterId: 'u_owner' });
    const res = await request(makeApp(false, prisma))
      .post('/api/agent/approvals/ar_test_1/resolve')
      .set('Authorization', `Bearer ${sign('u_owner', ['owner'])}`)
      .send({ decision: 'approved' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'SELF_APPROVAL_FORBIDDEN' });
    expect(updates).toHaveLength(0);
  });

  it('自审禁止：manager 角色同样不豁免 → 403', async () => {
    const { prisma, updates } = makeResolvePrisma({ ...baseApproval, requesterId: 'u_mgr' });
    const res = await request(makeApp(false, prisma))
      .post('/api/agent/approvals/ar_test_1/resolve')
      .set('Authorization', `Bearer ${sign('u_mgr', ['manager'])}`)
      .send({ decision: 'rejected', comment: '拒绝理由' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(updates).toHaveLength(0);
  });

  it('非本人 pending 单 → 200 正常决策（reviewerId 落库为决策人）', async () => {
    const { prisma, updates } = makeResolvePrisma({ ...baseApproval });
    const res = await request(makeApp(false, prisma))
      .post('/api/agent/approvals/ar_test_1/resolve')
      .set('Authorization', `Bearer ${sign('u_owner', ['owner'])}`)
      .send({ decision: 'approved', comment: '同意' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({ status: 'approved', reviewerId: 'u_owner' });
  });

  it('manager 不是当前指派人：403 APPROVAL_NOT_ASSIGNED，不能抢 tool 审批', async () => {
    const { prisma, updates } = makeResolvePrisma({ ...baseApproval });
    const response = await request(makeApp(false, prisma)).post('/api/agent/approvals/ar_test_1/resolve')
      .set('Authorization', `Bearer ${sign('u_outsider', ['manager'])}`).send({ decision: 'approved' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('APPROVAL_NOT_ASSIGNED');
    expect(updates).toHaveLength(0);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('modified 保留受控输入及实际决议人审计，body reviewerId 不造身份', async () => {
    const { prisma, updates } = makeResolvePrisma({ ...baseApproval });
    const response = await request(makeApp(false, prisma)).post('/api/agent/approvals/ar_test_1/resolve')
      .set('Authorization', `Bearer ${sign('u_owner', ['owner'])}`)
      .send({ decision: 'modified', modifiedInput: { status: 'Confirmed' }, reviewerId: 'forged' });
    expect(response.status).toBe(200);
    expect(updates[0].data.payload.resolution).toMatchObject({ decision: 'modified', reviewerId: 'u_owner', modifiedInput: { status: 'Confirmed' } });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      actorId: 'u_owner', action: 'agent_approval_modified', detail: expect.objectContaining({
        modifiedInput: { status: 'Confirmed' }, approvalDecisionFact: expect.objectContaining({ decisionActorId: 'u_owner', status: 'modified' }),
      }),
    }) }));
  });

  it('非本人但已决策单 → 409（自审守卫不影响既有重复决策语义）', async () => {
    const { prisma, updates } = makeResolvePrisma({ ...baseApproval, status: 'approved' });
    const res = await request(makeApp(false, prisma))
      .post('/api/agent/approvals/ar_test_1/resolve')
      .set('Authorization', `Bearer ${sign('u_owner', ['owner'])}`)
      .send({ decision: 'approved' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('APPROVAL_ALREADY_RESOLVED');
    expect(updates).toHaveLength(0);
  });
});

describe('POST /mcp/run（strict principal 收口：API-Key 角色注入漏洞）', () => {
  const plan = { steps: [{ id: 's1', toolId: 'products.query', input: { q: '面料' } }] };
  const runMcpPlanMock = vi.mocked(runMcpPlan);

  beforeEach(() => {
    runMcpPlanMock.mockClear();
  });

  it('有效 API-Key 无主体映射 + body 注入 owner → 403 AGENT_PRINCIPAL_REQUIRED（Key 是凭证不是身份）', async () => {
    const res = await request(makeApp(true))
      .post('/api/agent/mcp/run')
      .set('X-Bambook-API-Key', 'test-key')
      .send({ plan, userId: 'attacker', displayName: 'Attacker', roles: ['owner'] });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'AGENT_PRINCIPAL_REQUIRED' });
    expect(runMcpPlanMock).not.toHaveBeenCalled();
  });

  it('无效 API-Key → 401（与 ai 模块口径一致：无效凭证统一 401）', async () => {
    const res = await request(makeApp(true))
      .post('/api/agent/mcp/run')
      .set('X-Bambook-API-Key', 'wrong-key')
      .send({ plan, roles: ['owner'] });

    expect(res.status).toBe(401);
    expect(runMcpPlanMock).not.toHaveBeenCalled();
  });

  it('API-Key 映射主体（agent_operator）+ body 注入 owner → 以映射主体执行，body 身份全部被忽略', async () => {
    const res = await request(makeApp(true, undefined, {
      apiKeyActors: new Map([['test-key', {
        userId: 'service-mcp',
        displayName: 'MCP Service',
        roles: ['agent_operator'],
        permissions: [],
        departmentIds: ['company'],
      }]]),
    }))
      .post('/api/agent/mcp/run')
      .set('X-Bambook-API-Key', 'test-key')
      .send({ plan, userId: 'attacker', displayName: 'Attacker', roles: ['owner'], departmentIds: ['company'] });

    expect(res.status).toBe(200);
    expect(runMcpPlanMock).toHaveBeenCalledTimes(1);
    const input = runMcpPlanMock.mock.calls[0][0] as any;
    expect(input.actor).toMatchObject({ userId: 'service-mcp', roles: ['agent_operator'] });
    expect(input.actor.roles).not.toContain('owner');
    expect(input.actorUserId).toBe('service-mcp');
    expect(input.requestSource).toBe('api-key');
    expect(res.body.actor).toMatchObject({ userId: 'service-mcp', roles: ['agent_operator'] });
  });

  it('JWT（viewer）+ body 注入 owner → 以 JWT 主体执行，body roles 被忽略', async () => {
    const token = createAuthService().signToken({
      userId: 'u_viewer',
      displayName: 'Viewer',
      roles: ['viewer'],
      permissions: ['*'],
      departmentIds: ['company'],
    });
    const res = await request(makeApp(true))
      .post('/api/agent/mcp/run')
      .set('Authorization', `Bearer ${token}`)
      .send({ plan, userId: 'attacker', roles: ['owner'] });

    expect(res.status).toBe(200);
    const input = runMcpPlanMock.mock.calls[0][0] as any;
    expect(input.actor).toMatchObject({ userId: 'u_viewer', roles: ['viewer'] });
    expect(input.requestSource).toBe('user-session');
    expect(res.body.actor).toMatchObject({ userId: 'u_viewer', roles: ['viewer'] });
  });

  it('requireAuth=false 无 JWT → dev 工厂显式主体（与 /api/ai buildDevelopmentActor 同口径）', async () => {
    const res = await request(makeApp(false))
      .post('/api/agent/mcp/run')
      .send({ plan, userId: 'dev-user', roles: ['viewer'] });

    expect(res.status).toBe(200);
    const input = runMcpPlanMock.mock.calls[0][0] as any;
    expect(input.actor).toMatchObject({ userId: 'dev-user', roles: ['viewer'] });
    expect(input.requestSource).toBe('dev');
  });
});
