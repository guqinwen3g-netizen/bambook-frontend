import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_AGENT_ROLES, DEFAULT_AGENT_TOOLS } from './defaults';
import { extractActorFromRequest, requireRole } from '../auth/middleware';
import { createModuleAuthGuard, ModuleAuthGuardOptions } from '../auth/moduleGuard';
import { TokenPayload } from '../auth/service';
import { RuntimeDataSource } from '../dataSource';
import { createIdentityService } from './identity';
import { AgentRole, ActorContext } from './types';
import { getMcpManifest } from './mcp/manifest';
import { runMcpPlan } from './mcp/executor';
import { createMcpHttpHandler } from './mcp/httpTransport';
import { buildAgentTaskFrame } from './taskFrame';
import { approvalEventBus, formEventBus } from './events';
import { logger } from '../lib/logger';
import { ApprovalDecisionError, createApprovalDecisionService, type OnApprovalDecided } from '../approvals/approvalDecisionService';
import { safeRouteError } from '../shared/routeError';
import { publicAgentFailure } from './publicFailure';
import { redactEmailSendInput } from './emailSendOutboxFlow';

type AuthOptions = ModuleAuthGuardOptions;

type AgentStatusOptions = AuthOptions & {
  getRuntimeMetrics: () => Record<string, unknown>;
  prisma: PrismaClient;
  dataSource: RuntimeDataSource;
  onDecided?: OnApprovalDecided;
};

export function createAgentRouter(options: AgentStatusOptions) {
  const router = Router();
  const decisions = createApprovalDecisionService(options.prisma, { onDecided: options.onDecided });
  const requireAgentActor = requireActor(options.prisma);
  // 统一认证守卫：JWT（走 jwt.verify 验签）优先，API-Key 次之（替代原内联 auth/authActorOrApiKey）
  const guard = createModuleAuthGuard({ requireAuth: options.requireAuth, apiKeys: options.apiKeys });
  // /mcp/run 是 Agent 工具执行面，照 /api/ai 的 strict principal 模式收口：API-Key 只是
  // 传输凭证不是身份，必须显式绑定 apiKeyActors 服务主体（env AGENT_API_KEY_ACTORS 构建），
  // 否则 403 AGENT_PRINCIPAL_REQUIRED——未配置映射时空 Map 兜底=严格模式常开。
  // 历史漏洞：普通 guard 放行 API-Key 后 resolveMcpActor 从请求 body 读 userId/roles，
  // 且 normalizeRoles 空值兜底 ['owner']，API-Key 持有者可伪造 owner 执行工具计划。
  const mcpRunGuard = createModuleAuthGuard({
    requireAuth: options.requireAuth,
    apiKeys: options.apiKeys,
    apiKeyActors: options.apiKeyActors ?? new Map<string, TokenPayload>(),
    devActorFactory: buildMcpDevActor,
  });

  router.get('/status', guard, asyncHandler(async (_req, res) => {
    const [userTotal, activeUsers] = await Promise.all([
      options.prisma.userAccount.count().catch(() => 0),
      options.prisma.userAccount.count({ where: { deletedAt: null, status: 'active' } }).catch(() => 0),
    ]);
    const toolRunCount = await options.prisma.agentToolRun.count().catch(() => 0);
    const latestToolRun = await options.prisma.agentToolRun.findFirst({
      orderBy: { startedAt: 'desc' },
      select: {
        toolId: true,
        userId: true,
        actorId: true,
        actorDisplayName: true,
        actorRoles: true,
        sessionId: true,
        requestSource: true,
        approvalId: true,
        status: true,
        risk: true,
        startedAt: true,
        completedAt: true,
      },
    }).catch(() => null);
    const latestAuditLog = await options.prisma.auditLog.findFirst({
      where: { action: { startsWith: 'agent_tool_' } },
      orderBy: { createdAt: 'desc' },
      select: {
        actorId: true,
        action: true,
        targetType: true,
        targetId: true,
        detail: true,
        createdAt: true,
      },
    }).catch(() => null);
    res.json({
      ok: true,
      agent: {
        name: 'Bambook Enterprise Agent OS',
        host: 'mac-mini',
        identity: {
          roles: DEFAULT_AGENT_ROLES.map(role => ({
            id: role.id,
            name: role.name,
            permissions: role.permissions,
          })),
        },
        tools: {
          registered: DEFAULT_AGENT_TOOLS.length,
          highRisk: DEFAULT_AGENT_TOOLS.filter(tool => tool.risk === 'high').length,
          items: DEFAULT_AGENT_TOOLS.map(tool => ({
            id: tool.id,
            scope: tool.scope,
            risk: tool.risk,
            allowedRoles: tool.allowedRoles,
            approvalRoles: tool.approvalRoles || [],
          })),
        },
        knowledge: {
          store: 'postgres',
          status: 'schema-ready',
          acl: true,
        },
        memory: {
          scopes: ['personal', 'role', 'department', 'company', 'system'],
          status: 'schema-ready',
        },
        jobs: {
          status: 'schema-ready',
          queue: 'postgres',
        },
        audit: {
          toolRuns: toolRunCount,
          latestToolRun: latestToolRun ? {
            ...latestToolRun,
            startedAt: latestToolRun.startedAt.toISOString(),
            completedAt: latestToolRun.completedAt?.toISOString() || null,
          } : null,
          latestAuditLog: latestAuditLog ? {
            ...latestAuditLog,
            createdAt: latestAuditLog.createdAt.toISOString(),
          } : null,
        },
        users: {
          total: userTotal,
          active: activeUsers,
        },
        dataSource: options.dataSource,
        runtimeMetrics: options.getRuntimeMetrics(),
      },
    });
  }));

  router.get('/sessions', requireAgentActor, asyncHandler(async (req, res) => {
    const actor = (req as any).actor;
    // 搜索：标题或任一消息内容命中（大小写不敏感）
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';
    // 游标：上一页最后一条 session id（按 updatedAt desc + id desc 稳定排序锚定）
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : '';
    const takeRaw = Number(req.query.take);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(Math.floor(takeRaw), 1), 100) : 50;

    const where: Record<string, unknown> = { userId: actor.userId, deletedAt: null };
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { messages: { some: { deletedAt: null, content: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    // 多取 1 条探测是否还有下一页
    const sessions = await options.prisma.agentSession.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: take + 1,
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true, role: true, createdAt: true },
        },
        _count: { select: { messages: true } },
      },
    });

    const hasMore = sessions.length > take;
    const page = hasMore ? sessions.slice(0, take) : sessions;
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;

    res.json({
      ok: true,
      sessions: page.map(session => ({
        id: session.id,
        title: session.title || '未命名对话',
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        messageCount: session._count.messages,
        lastMessage: session.messages[0] ? {
          role: session.messages[0].role,
          content: session.messages[0].content,
          createdAt: session.messages[0].createdAt.toISOString(),
        } : null,
      })),
      pageInfo: { hasMore, nextCursor, take },
    });
  }));

  router.post('/sessions', requireAgentActor, asyncHandler(async (req, res) => {
    const actor = (req as any).actor;
    const user = await options.prisma.userAccount.findFirst({
      where: { id: actor.userId, deletedAt: null },
      select: { id: true },
    });
    if (!user) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Login user no longer exists.' });
    }
    const title = cleanTitle(req.body?.title);
    const session = await options.prisma.agentSession.create({
      data: {
        id: `as_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        userId: actor.userId,
        departmentId: null,
        title: title || '新对话',
        status: 'active',
        memoryScopes: [`personal:${actor.userId}`],
        metadata: {
          source: 'assistant',
          roles: actor.roles || [],
          departmentIds: actor.departmentIds || [],
        },
      },
    });

    res.json({ ok: true, session: serializeSession(session) });
  }));

  router.get('/sessions/:id/messages', requireAgentActor, asyncHandler(async (req, res) => {
    const actor = (req as any).actor;
    const session = await options.prisma.agentSession.findFirst({
      where: { id: req.params.id, userId: actor.userId, deletedAt: null },
    });
    if (!session) return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Session not found.' });

    const messages = await options.prisma.agentMessage.findMany({
      where: { sessionId: session.id, userId: actor.userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      ok: true,
      session: serializeSession(session),
      messages: messages.map(message => ({
        id: message.id,
        role: message.role === 'user' ? 'user' : 'model',
        text: message.content,
        timestamp: message.createdAt.getTime(),
        sources: (message.metadata as any)?.sources,
        thoughtProcess: (message.metadata as any)?.thoughtProcess,
        attachments: (message.metadata as any)?.attachments,
      })),
    });
  }));

  router.post('/sessions/:id/messages', requireAgentActor, asyncHandler(async (req, res) => {
    const actor = (req as any).actor;
    const role = req.body?.role === 'user' ? 'user' : 'model';
    const content = String(req.body?.text || req.body?.content || '').trim();
    if (!content) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'Message text is required.' });

    const session = await options.prisma.agentSession.findFirst({
      where: { id: req.params.id, userId: actor.userId, deletedAt: null },
    });
    if (!session) return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Session not found.' });

    const message = await options.prisma.agentMessage.create({
      data: {
        id: `am_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sessionId: session.id,
        userId: actor.userId,
        role,
        content,
        metadata: {
          attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : undefined,
          sources: Array.isArray(req.body?.sources) ? req.body.sources : undefined,
          thoughtProcess: typeof req.body?.thoughtProcess === 'string' ? req.body.thoughtProcess : undefined,
        },
      },
    });

    const nextTitle = session.title && session.title !== '新对话' ? session.title : titleFromMessage(content);
    await options.prisma.agentSession.update({
      where: { id: session.id },
      data: {
        title: nextTitle,
        metadata: {
          ...((session.metadata as Record<string, unknown> | null) || {}),
          lastRole: role,
          lastMessageAt: new Date().toISOString(),
        },
      },
    });

    res.json({
      ok: true,
      message: {
        id: message.id,
        role: message.role === 'user' ? 'user' : 'model',
        text: message.content,
        timestamp: message.createdAt.getTime(),
      },
    });
  }));

  router.patch('/sessions/:id', requireAgentActor, asyncHandler(async (req, res) => {
    const actor = (req as any).actor;
    const session = await options.prisma.agentSession.findFirst({
      where: { id: req.params.id, userId: actor.userId, deletedAt: null },
    });
    if (!session) return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Session not found.' });

    const data: any = {};
    if (typeof req.body?.title === 'string') data.title = cleanTitle(req.body.title) || session.title;
    if (typeof req.body?.status === 'string') data.status = req.body.status;
    const next = await options.prisma.agentSession.update({ where: { id: session.id }, data });
    res.json({ ok: true, session: serializeSession(next) });
  }));

  router.delete('/sessions/:id', requireAgentActor, asyncHandler(async (req, res) => {
    const actor = (req as any).actor;
    const session = await options.prisma.agentSession.findFirst({
      where: { id: req.params.id, userId: actor.userId, deletedAt: null },
    });
    if (!session) return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Session not found.' });
    await options.prisma.agentSession.update({
      where: { id: session.id },
      data: { deletedAt: BigInt(Date.now()) },
    });
    res.json({ ok: true });
  }));

  router.get('/tool-runs/:id', guard, asyncHandler(async (req, res) => {
    const toolRun = await options.prisma.agentToolRun.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        toolId: true,
        userId: true,
        actorId: true,
        actorDisplayName: true,
        actorRoles: true,
        sessionId: true,
        requestSource: true,
        approvalId: true,
        status: true,
        input: true,
        output: true,
        error: true,
        risk: true,
        idempotencyKey: true,
        startedAt: true,
        completedAt: true,
      },
    });
    if (!toolRun) return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Tool run not found.' });
    const approval = toolRun.approvalId
      ? await options.prisma.approvalRequest.findUnique({
        where: { id: toolRun.approvalId },
        select: {
          id: true,
          requesterId: true,
          reviewerId: true,
          actionType: true,
          targetType: true,
          targetId: true,
          status: true,
          risk: true,
          payload: true,
          decisionNote: true,
          createdAt: true,
          decidedAt: true,
        },
      }).catch(() => null)
      : null;
    res.json({
      ok: true,
      toolRun: {
        ...toolRun,
        error: toolRun.status === 'failed' && typeof toolRun.error === 'string' ? publicAgentFailure(toolRun.error) : toolRun.error,
        startedAt: toolRun.startedAt.toISOString(),
        completedAt: toolRun.completedAt?.toISOString() || null,
        approval: approval ? serializeApprovalRequest(approval) : null,
      },
    });
  }));

  router.post('/approvals/:id/resolve', guard, requireRole('owner', 'admin', 'manager'), asyncHandler(async (req, res) => {
    const actor = await resolveMcpActor(req);
    const decision = normalizeApprovalDecision(req.body?.decision);
    if (!decision) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'decision must be approved, rejected, or modified.' });
    const decisionNote = typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 2000)
      : typeof req.body?.decisionNote === 'string' ? req.body.decisionNote.trim().slice(0, 2000) : undefined;
    const modifiedInput = req.body?.modifiedInput && typeof req.body.modifiedInput === 'object' ? req.body.modifiedInput
      : req.body?.input && typeof req.body.input === 'object' ? req.body.input : undefined;
    try {
      // Preserve the authenticated server snapshot; body reviewerId/actor never participates.
      const trusted = ((req as any).actor as TokenPayload | undefined) || extractActorFromRequest(req);
      const { updated, sync, eventDelivery } = await decisions.decide({ id: req.params.id,
        actor: { ...trusted, userId: actor.userId, roles: actor.roles, displayName: actor.displayName },
        decision, decisionNote, modifiedInput, reviewerActor: serializeActor(actor), source: 'api:agent', ip: req.ip });
      res.json({ ok: true, approval: serializeApprovalRequest(updated), ...(sync ? { sync } : {}), ...(eventDelivery ? { eventDelivery } : {}) });
    } catch (error: any) {
      logger.error('[AgentRoute] approval resolve failed', { error: error?.message });
      const result = safeRouteError(error, { fallbackCode: 'AGENT_ROUTE_FAILED', fallbackMessage: 'failed to resolve approval' });
      res.status(result.status).json({ ok: false, error: result.code, message: result.message,
        ...(error instanceof ApprovalDecisionError && error.approval ? { approval: serializeApprovalRequest(error.approval) } : {}) });
    }
  }));

  router.post('/forms/:id/submit', guard, asyncHandler(async (req, res) => {
    const formId = req.params.id;
    const values = req.body?.values && typeof req.body.values === 'object'
      ? req.body.values as Record<string, unknown>
      : {};
    formEventBus.emit('submitted', formId, values);
    res.json({ ok: true, formId, values });
  }));

  // Standard MCP clients use one stateless Streamable HTTP endpoint. The
  // same strict principal, current permission snapshot and audited executor
  // as /mcp/run remain authoritative; callers cannot choose their actor.
  // Unlike the legacy development route, the standard endpoint never mints a
  // body-selected development actor, including when the app uses dev reads.
  const mcpHttpGuard = createModuleAuthGuard({ requireAuth: true, apiKeys: options.apiKeys,
    apiKeyActors: options.apiKeyActors ?? new Map<string, TokenPayload>() });
  router.all('/mcp', mcpHttpGuard, (req, res, next) => {
    if (req.method === 'POST') { next(); return; }
    res.setHeader('Allow', 'POST');
    res.status(405).end();
  });
  router.post('/mcp', createMcpHttpHandler(req => ({
    manifest: getMcpManifest,
    call: async (name, toolInput) => {
      const actor = await resolveMcpActor(req);
      // runMcpPlan reuses the runtime policy and records denied attempts too.
      return runMcpPlan({ prisma: options.prisma, actor, actorUserId: actor.userId,
        requestSource: ((req as any).authSource as 'user-session' | 'api-key' | 'dev') || 'user-session',
        plan: { planner: 'model-json', degraded: false,
          steps: [{ id: 'mcp-call', toolId: name, input: toolInput,
            reason: 'MCP tools/call', dependsOn: [], expectedUse: name }] },
      });
    },
  })));

  router.get('/mcp/manifest', guard, asyncHandler(async (_req, res) => {
    const tools = getMcpManifest();
    res.json({
      ok: true,
      schemaVersion: '2026-06-runtime-2.0',
      generatedAt: new Date().toISOString(),
      tools,
      summary: {
        total: tools.length,
        byDomain: tools.reduce<Record<string, number>>((acc, tool) => {
          acc[tool.domain] = (acc[tool.domain] || 0) + 1;
          return acc;
        }, {}),
        byRisk: tools.reduce<Record<string, number>>((acc, tool) => {
          acc[tool.risk] = (acc[tool.risk] || 0) + 1;
          return acc;
        }, {}),
        approvalRequired: tools.filter(tool => tool.safety.approval !== 'never').map(tool => tool.id),
      },
    });
  }));

  router.post('/mcp/run', mcpRunGuard, asyncHandler(async (req, res) => {
    const actor = await resolveMcpActor(req);
    const query = String(req.body?.query || req.body?.message || '').trim();
    if (!req.body?.plan || !Array.isArray(req.body.plan.steps)) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'plan is required.' });
    }
    const plan = req.body.plan;
    const hits = await runMcpPlan({
      prisma: options.prisma,
      actor,
      plan,
      sessionId: typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined,
      actorUserId: actor.userId,
      requestSource: ((req as any).authSource as 'user-session' | 'api-key' | 'dev') || 'user-session',
      taskFrame: query ? buildAgentTaskFrame(query) : undefined,
    });
    const safePlan = { ...plan, steps: plan.steps.map((step: any) => step?.toolId === 'email.send'
      ? { ...step, input: redactEmailSendInput(step.input && typeof step.input === 'object' ? step.input : {}) } : step) };
    res.json({ ok: true, actor: serializeActor(actor), plan: safePlan, hits });
  }));

  return router;
}

function asyncHandler(
  handler: (req: Request, res: Response, next?: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next?: NextFunction) => {
    handler(req, res, next).catch(error => {
      logger.error('[agent] route failed', { error: error?.message || String(error) });
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: 'AGENT_ROUTE_FAILED',
          message: publicAgentFailure(error),
        });
      }
    });
  };
}

function requireActor(prisma: PrismaClient) {
  return asyncHandler(async (req: Request, res: Response, next?: NextFunction) => {
    const actor = extractActorFromRequest(req);
    if (!actor) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Login required.' });
    }
    (req as any).actor = actor;
    next?.();
  });
}

function cleanTitle(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function titleFromMessage(value: string) {
  return cleanTitle(value) || '新对话';
}

function serializeSession(session: any) {
  return {
    id: session.id,
    title: session.title || '未命名对话',
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function normalizeApprovalDecision(value: unknown): 'approved' | 'rejected' | 'modified' | null {
  if (value === 'approved' || value === 'rejected' || value === 'modified') return value;
  return null;
}

function serializeApprovalRequest(approval: any) {
  return {
    id: approval.id,
    requesterId: approval.requesterId,
    reviewerId: approval.reviewerId,
    actionType: approval.actionType,
    targetType: approval.targetType,
    targetId: approval.targetId,
    status: approval.status,
    risk: approval.risk,
    payload: approval.payload,
    decisionNote: approval.decisionNote,
    createdAt: approval.createdAt?.toISOString?.() || null,
    decidedAt: approval.decidedAt?.toISOString?.() || null,
  };
}

async function resolveMcpActor(req: Request): Promise<ActorContext> {
  // 身份唯一来源=守卫注入的受控主体（JWT 验签 / API-Key 映射服务主体 / dev 工厂）。
  // 请求 body 的 userId/roles/departmentIds 不再参与身份解析（API-Key 角色注入漏洞收口）。
  const trusted = ((req as any).actor as TokenPayload | undefined) || extractActorFromRequest(req);
  if (!trusted?.userId) {
    throw new Error('ACTOR_REQUIRED: Agent execution requires an authenticated principal.');
  }
  return createIdentityService().resolveActorContext({
    userId: trusted.userId,
    displayName: trusted.displayName,
    roles: normalizeRoles(trusted.roles),
    departmentIds: trusted.departmentIds,
    roleIds: trusted.roleIds,
    permissions: trusted.permissions,
    authorizationLoaded: trusted.authorizationLoaded,
    permissionCeiling: trusted.permissionCeiling,
  });
}

// 照 /api/ai buildDevelopmentActor：requireAuth=false（本地 dev）时构建显式 dev 主体，
// identity service 不隐式发明 owner 访问（dev 模式 body 角色是本地信任面，与 ai 模块同口径）。
function buildMcpDevActor(req: Request): TokenPayload {
  const requestedRoles = Array.isArray(req.body?.roles) ? req.body.roles.map(String) : [];
  const roles = requestedRoles.length ? requestedRoles : ['owner'];
  const departmentIds = Array.isArray(req.body?.departmentIds) && req.body.departmentIds.length
    ? req.body.departmentIds.map(String)
    : ['company'];
  return {
    userId: String(req.body?.userId || req.headers['x-bambook-user-id'] || 'local-dev-agent'),
    displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : 'Local Development Agent',
    roles: roles as TokenPayload['roles'],
    permissions: [],
    departmentIds,
  };
}

function normalizeRoles(value: unknown): AgentRole[] {
  const allowed = new Set(DEFAULT_AGENT_ROLES.map(role => role.id));
  const roles = Array.isArray(value) ? value.map(String).filter(role => allowed.has(role as AgentRole)) as AgentRole[] : [];
  // 不再兜底 ['owner']：空/无效 roles 由 identity.resolveActorContext fail-closed
  // （ACTOR_ROLES_REQUIRED），与 /api/ai runner 的 normalizeRoles 语义对齐。
  return roles;
}

function serializeActor(actor: ActorContext) {
  return {
    userId: actor.userId,
    displayName: actor.displayName,
    roles: actor.roles,
    departmentIds: actor.departmentIds,
    toolScopes: actor.toolScopes,
  };
}
