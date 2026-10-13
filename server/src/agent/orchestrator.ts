import {
  ActorContext,
  AgentRunRequest,
  AgentRunResult,
  KnowledgeHit,
} from './types';
import { createIdentityService } from './identity';
import { createPolicyService } from './policy';
import { emitAgentWorkEvent } from './events';

type IdentityService = ReturnType<typeof createIdentityService>;
type PolicyService = ReturnType<typeof createPolicyService>;

type KnowledgeService = {
  search(input: {
    actor: ActorContext;
    query: string;
    sessionId: string;
    actorUserId?: string;
    requestSource?: AgentRunRequest['requestSource'];
    signal?: AbortSignal;
    emit?: AgentRunRequest['emit'];
  }): Promise<KnowledgeHit[]>;
};

type ModelService = {
  complete(input: {
    actor: ActorContext;
    message: string;
    context: KnowledgeHit[];
    history: AgentRunRequest['history'];
    model?: string;
    temperature?: number;
    signal?: AbortSignal;
    emit?: AgentRunRequest['emit'];
  }): Promise<string>;
};

type AgentOrchestratorOptions = {
  identity?: IdentityService;
  policy?: PolicyService;
  knowledge: KnowledgeService;
  model: ModelService;
};

export function createAgentOrchestrator(options: AgentOrchestratorOptions) {
  const identity = options.identity ?? createIdentityService();
  const policy = options.policy ?? createPolicyService();

  async function run(request: AgentRunRequest): Promise<AgentRunResult> {
    const trace: string[] = [];
    const emitStep = (message: string) => {
      trace.push(message);
      request.emit?.('step', { message });
    };
    const emitWork = (event: Parameters<typeof emitAgentWorkEvent>[1]) => {
      trace.push(event.message);
      emitAgentWorkEvent(request.emit, event);
    };

    const actor = await identity.resolveActorContext(request);
    emitWork({
      phase: 'identity',
      status: 'complete',
      title: '确认执行身份',
      message: `识别身份: ${actor.displayName || actor.userId}; actor=${actor.userId}; roles=${actor.roles.join(', ')}`,
      summary: actor.displayName || actor.userId,
      metadata: {
        actorId: actor.userId,
        displayName: actor.displayName,
        roles: actor.roles,
        departmentIds: actor.departmentIds,
      },
    });

    const retrievalQuery = buildRetrievalQuery(request.message, request.history || []);
    emitWork({
      phase: 'planning',
      status: 'running',
      title: '整理任务目标',
      message: `构建检索问题: ${compactTraceText(retrievalQuery, 180)}`,
      summary: compactTraceText(retrievalQuery, 120),
    });
    const rawContext = await options.knowledge.search({
      actor,
      query: retrievalQuery,
      sessionId: request.sessionId,
      actorUserId: request.actorUserId,
      requestSource: request.requestSource,
      signal: request.signal,
      emit: request.emit,
    });
    const combinedContext = [...(request.attachmentContext || []), ...rawContext];
    emitWork({
      phase: 'assessment',
      status: 'running',
      title: '观察检索结果',
      message: `检索返回: ${combinedContext.length} 条原始上下文`,
      summary: `${combinedContext.length} 条原始上下文`,
      metadata: { rawContextCount: combinedContext.length },
    });
    const context = combinedContext.filter(hit => policy.canAccessKnowledge(actor, { scopes: hit.scopes }));
    emitWork({
      phase: 'assessment',
      status: 'complete',
      title: '权限过滤完成',
      message: context.length ? `权限过滤后可用上下文: ${context.length} 条` : '权限过滤后可用上下文: 0 条',
      summary: `${context.length} 条可用上下文`,
      metadata: { contextCount: context.length },
    });
    if (context.length) {
      emitWork({
        phase: 'assessment',
        status: 'complete',
        title: '确认依据来源',
        message: `上下文来源: ${context.map(hit => `${hit.source}/${hit.category}`).join(', ')}`,
        summary: context.map(hit => `${hit.source}/${hit.category}`).join(', '),
      });
    }

    emitWork({
      phase: 'final',
      status: 'running',
      title: '生成最终总结',
      message: '生成最终回答',
      summary: '合并工具结果和可用依据',
    });
    const text = await options.model.complete({
      actor,
      message: request.message,
      context,
      history: request.history || [],
      model: request.model,
      temperature: request.temperature,
      signal: request.signal,
      emit: request.emit,
    });

    return {
      text,
      sources: context.map(hit => ({
        title: hit.title,
        category: hit.category,
        source: hit.source,
        excerpt: hit.content.slice(0, 180),
      })),
      thoughtProcess: buildVisibleThinking({
        actor,
        message: request.message,
        retrievalQuery,
        rawContextCount: rawContext.length,
        context,
      }),
    };
  }

  return { run };
}

function compactTraceText(value: string, maxLength: number) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function buildVisibleThinking(input: {
  actor: ActorContext;
  message: string;
  retrievalQuery: string;
  rawContextCount: number;
  context: KnowledgeHit[];
}) {
  const sources = input.context.map(hit => `${hit.source}/${hit.category}`);
  const toolHits = input.context.filter(hit => hit.source.startsWith('agent-tool/'));
  const evidence = input.context
    .filter(hit => hit.source !== 'agent-core')
    .slice(0, 4)
    .map(hit => `- ${hit.source}/${hit.category}: ${summarizeEvidence(hit.content)}`);
  const lines = [
    '我的理解',
    `我先把这个问题理解为：${compactTraceText(input.message, 160)}`,
    `当前我是以 ${input.actor.displayName || input.actor.userId} 的身份处理，能看的数据范围由 Bambook 后端权限决定。`,
    '',
    '我的做法',
    `我会先使用 Bambook 后端可访问的数据和工具，而不是凭记忆或关键词直接猜答案。检索问题是：${compactTraceText(input.retrievalQuery, 180)}`,
    toolHits.length
      ? `这次我用到的工具/上下文包括：${sources.join('、')}。`
      : `这次我拿到 ${input.rawContextCount} 条原始上下文，权限过滤后可用 ${input.context.length} 条。`,
    '',
    '我拿到的依据',
    evidence.length ? evidence.join('\n') : '- 没有拿到足够的业务数据依据，因此不能假装知道结果。',
    '',
    '我的结论方式',
    toolHits.length
      ? '我会优先相信后端工具返回的结构化结果；如果字典、分类或记录查询没有命中，我会说明口径不足，而不是用模糊样本代替真实统计。'
      : '我会只基于已经进入上下文、且当前身份有权限访问的内容回答；上下文不足时需要继续查询或说明不确定。',
  ];
  return lines.join('\n');
}

function summarizeEvidence(content: string) {
  const fullText = String(content || '').replace(/\s+/g, ' ').trim();
  const dictionaryMatch = fullText.match(/output\.dictionary = ([^;]+).*?output\.query = ([^;]+).*?output\.count = ([^;]+)/);
  if (dictionaryMatch) {
    return `我先查业务字典 ${dictionaryMatch[1]}，查询词是 ${dictionaryMatch[2]}，命中 ${dictionaryMatch[3]} 条。`;
  }
  const taskGraphMatch = fullText.match(/task_graph_id=([^;\n]+).*?objective=([^\n]+).*?steps:/s);
  if (taskGraphMatch) {
    const toolChain = Array.from(fullText.matchAll(/via ([a-z]+\.[a-z_]+)/g)).map(match => match[1]);
    return `我按任务图 ${taskGraphMatch[1]} 推进，目标是 ${taskGraphMatch[2]}${toolChain.length ? `；计划工具链是 ${toolChain.join(' -> ')}` : ''}。`;
  }
  const recordsMatch = fullText.match(/output\.entity = ([^;]+).*?output\.aggregate = ([^;]+).*?output\.count = ([^;]+)/);
  if (recordsMatch) {
    return `我再查业务记录 ${recordsMatch[1]}，统计方式是 ${recordsMatch[2]}，结果是 ${recordsMatch[3]}。`;
  }
  const productGetMatch = fullText.match(/tool_id = products\.get.*?output\.found = true.*?output\.identifier = ([^;]+)/);
  if (productGetMatch) {
    return `我读取了唯一数字档案，标识是 ${productGetMatch[1]}。`;
  }
  const productQueryMatch = fullText.match(/tool_id = products\.query.*?output\.total = ([^;]+).*?output\.count = ([^;]+)/);
  if (productQueryMatch) {
    return `我按结构化条件查询数字档案，匹配总数 ${productQueryMatch[1]}，本页返回 ${productQueryMatch[2]} 条。`;
  }
  return compactTraceText(fullText, 260);
}

function buildRetrievalQuery(message: string, history: NonNullable<AgentRunRequest['history']>): string {
  const recentUserTurns = history
    .filter(item => item.role === 'user')
    .slice(-4)
    .map(item => String(item.content || item.text || '').trim())
    .filter(Boolean);
  const current = message.trim();
  return [...recentUserTurns, current].filter(Boolean).join('\n').slice(-1600);
}
