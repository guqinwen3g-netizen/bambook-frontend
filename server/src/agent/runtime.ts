import { PrismaClient } from '@prisma/client';
import { AiChatRequest, AiChatResult, AiEmit } from '../ai/runtime';
import { TokenPayload } from '../auth/service';
import { resolveActorUserAccountId } from './actorIdentity';

type HistoryItem = { role: string; content?: string; text?: string };
type RuntimeRunStatus = 'running' | 'complete' | 'failed';

type PrepareChatInput = {
  sessionId: string;
  actor?: TokenPayload | null;
  body: {
    userId?: string;
    displayName?: string;
    roles?: string[];
    departmentIds?: string[];
    message: string;
    history?: HistoryItem[];
    attachments?: Array<{ name: string; mimeType?: string; data?: string }>;
    model?: string;
    temperature?: number;
    tts?: AiChatRequest['tts'];
  };
  signal: AbortSignal;
  emit: AiEmit;
  requestSource?: AiChatRequest['requestSource'];
};

export function createAgentRuntimeService(options: { prisma: PrismaClient }) {
  const prisma = options.prisma;
  const runtimeEvents = new Map<string, Record<string, unknown>[]>();

  async function prepareChatRun(input: PrepareChatInput): Promise<AiChatRequest> {
    const actorUserId = input.actor?.userId || input.body.userId || 'default-user';
    const displayName = input.actor?.displayName || input.body.displayName;
    const roles = input.actor?.roles || input.body.roles;
    const departmentIds = input.actor?.departmentIds || input.body.departmentIds;
    const resolvedUserId = await resolveActorUserAccountId(prisma, { userId: actorUserId, displayName });
    const userId = resolvedUserId || actorUserId;
    const message = input.body.message.trim();
    const bodyHistory = Array.isArray(input.body.history) ? input.body.history : [];
    const runtimeRunId = `arun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const emit = createRuntimeEmit({
      baseEmit: input.emit,
      sessionId: input.sessionId,
      userId,
      runtimeRunId,
      objective: message,
    });

    await ensureSession({
      sessionId: input.sessionId,
      userId,
      actorUserId,
      requestSource: input.requestSource || 'dev',
      title: message,
      roles,
      departmentIds,
    });
    const history = await loadSessionHistory({
      sessionId: input.sessionId,
      userId,
      currentMessage: message,
      bodyHistory,
    });
    await createMessageIfNotDuplicate({
      sessionId: input.sessionId,
      userId,
      role: 'user',
      content: message,
      metadata: { attachments: input.body.attachments || [] },
    });
    await persistRunState({
      sessionId: input.sessionId,
      userId,
      runtimeRunId,
      objective: message,
      status: 'running',
      patch: { startedAt: new Date().toISOString(), events: [] },
    });

    return {
      sessionId: input.sessionId,
      userId,
      runtimeRunId,
      actorUserId,
      requestSource: input.requestSource || 'dev',
      displayName,
      roles,
      departmentIds,
      roleIds: input.actor?.roleIds,
      permissions: input.actor?.permissions,
      authorizationLoaded: input.actor?.authorizationLoaded,
      message,
      history,
      attachments: input.body.attachments || [],
      model: input.body.model,
      temperature: input.body.temperature,
      tts: input.body.tts,
      signal: input.signal,
      emit,
    };
  }

  async function saveAssistantMessage(input: {
    sessionId: string;
    userId: string;
    runtimeRunId?: string;
    result: AiChatResult;
  }) {
    const content = String(input.result.text || '').trim();
    if (!content) return;
    await createMessageIfNotDuplicate({
      sessionId: input.sessionId,
      userId: input.userId,
      role: 'model',
      content,
      metadata: {
        sources: input.result.sources || [],
        thoughtProcess: input.result.thoughtProcess,
      },
    });
    const stopReason = (input.result as AiChatResult & { stopReason?: string }).stopReason;
    const incomplete = typeof stopReason === 'string' && stopReason !== 'final_answer';
    await persistRunState({
      sessionId: input.sessionId,
      userId: input.userId,
      runtimeRunId: input.runtimeRunId,
      status: incomplete ? 'failed' : 'complete',
      patch: {
        ...(incomplete ? { interruptedAt: new Date().toISOString(), stopReason, completedAt: null } : { completedAt: new Date().toISOString() }),
        events: input.runtimeRunId ? runtimeEvents.get(input.runtimeRunId)?.slice(-30) || [] : [],
        finalTextPreview: content.slice(0, 500),
        sourceCount: input.result.sources?.length || 0,
      },
    });
    if (input.runtimeRunId) runtimeEvents.delete(input.runtimeRunId);
  }

  async function markRunFailed(input: {
    sessionId: string;
    userId: string;
    runtimeRunId?: string;
    error: string;
  }) {
    await persistRunState({
      sessionId: input.sessionId,
      userId: input.userId,
      runtimeRunId: input.runtimeRunId,
      status: 'failed',
      patch: {
        failedAt: new Date().toISOString(),
        events: input.runtimeRunId ? runtimeEvents.get(input.runtimeRunId)?.slice(-30) || [] : [],
        error: input.error,
      },
    });
    if (input.runtimeRunId) runtimeEvents.delete(input.runtimeRunId);
  }

  async function ensureSession(input: {
    sessionId: string;
    userId: string;
    actorUserId?: string;
    requestSource?: AiChatRequest['requestSource'];
    title: string;
    roles?: string[];
    departmentIds?: string[];
  }) {
    if (input.userId === 'default-user') return;
    const user = await prisma.userAccount.findFirst({
      where: { id: input.userId, deletedAt: null },
      select: { id: true },
    }).catch(() => null);
    if (!user) return;

    const existing = await prisma.agentSession.findFirst({
      where: { id: input.sessionId, userId: input.userId, deletedAt: null },
      select: { id: true },
    });
    if (existing) return;

    await prisma.agentSession.create({
      data: {
        id: input.sessionId,
        userId: input.userId,
        departmentId: null,
        title: titleFromMessage(input.title),
        status: 'active',
        memoryScopes: [`personal:${input.userId}`],
        metadata: {
          source: 'ai-chat-runtime',
          requestSource: input.requestSource || 'dev',
          actorUserId: input.actorUserId,
          roles: input.roles || [],
          departmentIds: input.departmentIds || [],
        },
      },
    }).catch(() => undefined);
  }

  async function loadSessionHistory(input: {
    sessionId: string;
    userId: string;
    currentMessage: string;
    bodyHistory: HistoryItem[];
  }) {
    const normalizedBodyHistory = input.bodyHistory
      .map(normalizeHistoryItem)
      .filter(Boolean) as Array<{ role: string; content: string }>;
    if (input.userId === 'default-user') return normalizedBodyHistory;

    const rows = await prisma.agentMessage.findMany({
      where: {
        sessionId: input.sessionId,
        userId: input.userId,
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      take: 32,
      select: { role: true, content: true },
    }).catch(() => []);

    const dbHistory = rows
      .map(row => normalizeHistoryItem({ role: row.role, content: row.content }))
      .filter(Boolean) as Array<{ role: string; content: string }>;
    const withoutCurrent = trimTrailingDuplicateUserMessage(dbHistory, input.currentMessage);
    return withoutCurrent.length > normalizedBodyHistory.length ? withoutCurrent : normalizedBodyHistory;
  }

  async function createMessageIfNotDuplicate(input: {
    sessionId: string;
    userId: string;
    role: 'user' | 'model';
    content: string;
    metadata?: Record<string, unknown>;
  }) {
    if (input.userId === 'default-user') return;
    const session = await prisma.agentSession.findFirst({
      where: { id: input.sessionId, userId: input.userId, deletedAt: null },
      select: { id: true, title: true, metadata: true },
    }).catch(() => null);
    if (!session) return;

    const last = await prisma.agentMessage.findFirst({
      where: { sessionId: input.sessionId, userId: input.userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { role: true, content: true },
    }).catch(() => null);
    if (last?.role === input.role && last.content.trim() === input.content.trim()) return;

    await prisma.agentMessage.create({
      data: {
        id: `am_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sessionId: input.sessionId,
        userId: input.userId,
        role: input.role,
        content: input.content,
        metadata: (input.metadata || {}) as any,
      },
    });
    await prisma.agentSession.update({
      where: { id: input.sessionId },
      data: {
        title: session.title && session.title !== '新对话' ? session.title : titleFromMessage(input.content),
        metadata: {
          ...(((session.metadata as Record<string, unknown> | null) || {})),
          lastRole: input.role,
          lastMessageAt: new Date().toISOString(),
        },
      },
    }).catch(() => undefined);
  }

    function createRuntimeEmit(input: {
      baseEmit: AiEmit;
      sessionId: string;
      userId: string;
      runtimeRunId: string;
      objective: string;
    }): AiEmit {
      const events: Record<string, unknown>[] = [];
      runtimeEvents.set(input.runtimeRunId, events);
      return (type, payload) => {
        input.baseEmit(type, payload);
        if (type !== 'agent_event') return;
        const event = sanitizeAgentEvent(payload);
        events.push(event);
        void persistRunState({
          sessionId: input.sessionId,
          userId: input.userId,
          runtimeRunId: input.runtimeRunId,
          objective: input.objective,
          status: event.status === 'failed' ? 'failed' : 'running',
          patch: {
            updatedAt: new Date().toISOString(),
            latestPhase: event.phase,
            latestStatus: event.status,
            latestMessage: event.message,
            events: events.slice(-30),
          },
        });
      };
    }

    async function persistRunState(input: {
      sessionId: string;
      userId: string;
      runtimeRunId?: string;
      objective?: string;
      status: RuntimeRunStatus;
      patch: Record<string, unknown>;
    }) {
      if (input.userId === 'default-user' || !input.runtimeRunId) return;
      const session = await prisma.agentSession.findFirst({
        where: { id: input.sessionId, userId: input.userId, deletedAt: null },
        select: { id: true, metadata: true },
      }).catch(() => null);
      if (!session) return;
      const metadata = ((session.metadata as Record<string, unknown> | null) || {});
      const previousRuntime = ((metadata.agentRuntime as Record<string, unknown> | null) || {});
      const previousRun = ((previousRuntime.currentRun as Record<string, unknown> | null) || {});
      await prisma.agentSession.update({
        where: { id: session.id },
        data: {
          metadata: {
            ...metadata,
            agentRuntime: {
              ...previousRuntime,
              currentRun: {
                ...previousRun,
                id: input.runtimeRunId,
                objective: input.objective || previousRun.objective,
                status: input.status,
                ...input.patch,
              },
            },
          } as any,
        },
      }).catch(() => undefined);
    }

    return { prepareChatRun, saveAssistantMessage, markRunFailed };
  }

  function sanitizeAgentEvent(payload: Record<string, unknown>) {
    return {
      id: String(payload.id || `agent_event_${Date.now()}`),
      at: typeof payload.at === 'string' ? payload.at : new Date().toISOString(),
      phase: String(payload.phase || ''),
      status: String(payload.status || ''),
      title: String(payload.title || ''),
      message: String(payload.message || ''),
      toolId: typeof payload.toolId === 'string' ? payload.toolId : undefined,
      summary: typeof payload.summary === 'string' ? payload.summary : undefined,
      metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : undefined,
    };
  }

function normalizeHistoryItem(item: HistoryItem | null | undefined) {
  if (!item) return null;
  const content = String(item.content || item.text || '').trim();
  if (!content) return null;
  return {
    role: item.role === 'user' ? 'user' : 'model',
    content,
  };
}

function trimTrailingDuplicateUserMessage(history: Array<{ role: string; content: string }>, currentMessage: string) {
  const next = [...history];
  const last = next[next.length - 1];
  if (last?.role === 'user' && last.content.trim() === currentMessage.trim()) next.pop();
  return next;
}

function titleFromMessage(content: string) {
  return content.replace(/\s+/g, ' ').slice(0, 32) || '新对话';
}
