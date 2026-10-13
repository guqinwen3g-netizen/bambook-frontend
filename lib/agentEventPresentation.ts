/**
 * Agent 事件 → 人类可读内容的集中映射层
 *
 * 设计原则：
 *  - 纯数据转换，不依赖 React，不产生 DOM
 *  - 输出两类东西：自然语言短文本（用于状态栏/面板行），结构化标签（用于图标/色调决策）
 *  - "工作过程"而非"思考过程"——不暴露原始 reasoning，只呈现 Agent 实际执行过什么
 */

import type {
  AgentWorkEvent,
  AgentWorkEventPhase,
  AgentWorkEventStatus,
  AgentWorkEventMetadata,
} from '../types';

// ---------------------------------------------------------------------------
// 工具 id → 业务标签
// ---------------------------------------------------------------------------

export const AGENT_TOOL_NAMESPACE_LABELS: Record<string, string> = {
  relations: '关系智库',
  products: '数字档案',
  orders: '订单档案',
  knowledge: '知识库',
  files: '文件能力',
  web: '联网能力',
};

export const AGENT_TOOL_ACTION_LABELS: Record<string, string> = {
  query: '查询',
  search: '检索',
  get: '读取详情',
  expand: '展开上下文',
  list: '列出记录',
  create: '创建记录',
  update: '更新记录',
  delete: '删除记录',
};

export const compactAgentText = (text?: string): string =>
  String(text || '').trim().replace(/\s+/g, ' ');

export const describeAgentTool = (toolId?: string): string => {
  const id = compactAgentText(toolId);
  if (!id) return 'Bambook 后端工具';
  const [namespace, action] = id.split('.');
  const namespaceLabel = AGENT_TOOL_NAMESPACE_LABELS[namespace] || namespace;
  const actionLabel = AGENT_TOOL_ACTION_LABELS[action] || action;
  if (namespaceLabel && actionLabel) return `${namespaceLabel}${actionLabel}`;
  return id;
};

// ---------------------------------------------------------------------------
// 事件 → 自然语言叙述
// ---------------------------------------------------------------------------

export type AgentNarrativeLine = {
  id: string;
  phase: AgentWorkEventPhase;
  status: AgentWorkEventStatus;
  toolId?: string;
  toolLabel?: string;
  summary?: string;
  line: string;
  isRunning?: boolean;
  isBlocked?: boolean;
  isFailed?: boolean;
};

export const formatAgentNarrativeLine = (event: AgentWorkEvent): string => {
  const detail = compactAgentText(event.summary || event.message);
  const detailSuffix = detail ? `：${detail}` : '';
  const toolLabel = describeAgentTool(event.toolId);
  const step = (event.metadata as AgentWorkEventMetadata | undefined)?.step;
  const stepPrefix = typeof step === 'number' ? `第 ${step} 步 · ` : '';

  switch (event.phase) {
    case 'start':
      return '初始化任务上下文...';
    case 'identity':
      return '验证访问权限与身份角色...';
    case 'planning':
      return `规划执行步骤${detailSuffix}`;
    case 'tool_call':
      return `调用工具：${toolLabel}`;
    case 'tool_result':
      return `解析工具返回结果${detailSuffix}`;
    case 'assessment':
      if (event.status === 'blocked') return `需要补充信息${detailSuffix}`;
      if (event.status === 'failed') return `评估失败${detailSuffix}`;
      return `评估执行结果${detailSuffix}`;
    case 'final':
      return '汇总并生成最终回复...';
    case 'error':
      return detail || '任务执行中止';
    // ── S2 真 Agent 循环 ──
    case 'iteration_start':
      return `${stepPrefix}进入推理迭代`;
    case 'thought':
      return `${stepPrefix}思考${detailSuffix}`;
    case 'plan':
      return `${stepPrefix}制定本步行动计划${detailSuffix}`;
    case 'tool_call_start':
      return `${stepPrefix}调用工具：${toolLabel}`;
    case 'tool_call_end':
      if (event.status === 'failed') return `${stepPrefix}${toolLabel} 调用失败${detailSuffix}`;
      return `${stepPrefix}${toolLabel} 已返回${detailSuffix}`;
    case 'iteration_end':
      return `${stepPrefix}本步结束`;
    case 'final_answer':
      return `生成最终回答${detailSuffix}`;
    default:
      return detail;
  }
};

// ---------------------------------------------------------------------------
// 事件 → 图标 / 色调（语义标签，由上层组件消费成实际图标）
// ---------------------------------------------------------------------------

export type AgentEventSemanticTone =
  | 'info'      // 执行中/规划中/普通信息
  | 'success'   // 已完成
  | 'warning'   // 需要补充/阻塞
  | 'danger';   // 失败

export const getAgentEventSemanticTone = (event: AgentWorkEvent): AgentEventSemanticTone => {
  if (event.status === 'failed') return 'danger';
  if (event.status === 'blocked') return 'warning';
  if (event.status === 'complete') return 'success';
  return 'info';
};

export type AgentEventIconKind =
  | 'running'
  | 'complete'
  | 'blocked'
  | 'tool'
  | 'cognitive'  // planning / assessment
  | 'identity'
  | 'final'
  | 'unknown';

export const getAgentEventIconKind = (event: AgentWorkEvent): AgentEventIconKind => {
  if (event.status === 'failed') return 'blocked';
  if (event.status === 'blocked') return 'blocked';
  if (event.status === 'complete') return 'complete';
  if (event.phase === 'tool_call' || event.phase === 'tool_result') return 'tool';
  if (event.phase === 'tool_call_start' || event.phase === 'tool_call_end') return 'tool';
  if (event.phase === 'planning' || event.phase === 'assessment') return 'cognitive';
  if (event.phase === 'thought' || event.phase === 'plan') return 'cognitive';
  if (event.phase === 'identity') return 'identity';
  if (event.phase === 'final' || event.phase === 'final_answer') return 'final';
  if (event.phase === 'start' || event.phase === 'iteration_start') return 'running';
  return 'unknown';
};

// ---------------------------------------------------------------------------
// 实时状态条：把事件流压缩成一句话
// ---------------------------------------------------------------------------

// 工具中文名映射 — 与 Assistant.tsx 中的保持一致
const TOOL_CN_MAP: Record<string, string> = {
  'relations.query': '检索客户档案',
  'relations.create': '创建客户档案',
  'relations.update': '更新客户档案',
  'relations.delete': '删除客户档案',
  'orders.query': '检索订单',
  'orders.create': '创建订单',
  'orders.update': '更新订单',
  'orders.delete': '删除订单',
  'invoices.query': '检索发票',
  'invoices.create': '创建发票',
  'invoices.update': '更新发票',
  'shipments.query': '检索发货单',
  'shipments.create': '创建发货单',
  'knowledge.search': '搜索知识库',
  'knowledge.create': '写入知识库',
  'email.list': '查看邮件',
  'email.read': '读取邮件',
  'email.ai_extract': '解析邮件',
  'finance.query': '查询财务数据',
  'template.list': '列出模板',
  'template.render': '渲染模板',
  'template.render_pdf': '生成 PDF',
};

export const getAgentLiveStatusText = (
  events: AgentWorkEvent[],
  isLoading: boolean,
): string => {
  const last = events[events.length - 1];
  if (!isLoading && !last) return '';
  if (!last) return isLoading ? '正在工作…' : '';

  const toolCN = (id?: string) => (id && TOOL_CN_MAP[id]) || id || '工具';

  if (last.status === 'blocked') return '等待你确认';
  if (last.status === 'failed') return '遇到问题';
  if (last.phase === 'tool_call' || last.phase === 'tool_call_start') return `正在${toolCN(last.toolId)}…`;
  if (last.phase === 'tool_call_end') return `${toolCN(last.toolId)} 完成`;
  if (last.phase === 'tool_result') return '正在分析返回数据…';
  if (last.phase === 'planning')    return '正在理解你的需求…';
  if (last.phase === 'plan')        return '正在制定方案…';
  if (last.phase === 'thought_delta') return '正在思考…';
  if (last.phase === 'thought_end') return '思考完成';
  if (last.phase === 'answer_delta') return '正在生成回答…';
  if (last.phase === 'answer_end') return '回答生成完成';
  if (last.phase === 'thought')     return last.message ? `思考中：${last.message}` : '正在思考…';
  if (last.phase === 'iteration_start') return `开始第 ${last.metadata?.step ?? '?'} 步…`;
  if (last.phase === 'iteration_end') return `第 ${last.metadata?.step ?? '?'} 步完成`;
  if (last.phase === 'assessment')  return '正在判断下一步…';
  if (last.phase === 'final')       return '正在整理回答…';
  if (last.phase === 'final_answer') return '回答已就绪';
  if (last.phase === 'identity')    return '正在验证身份…';
  return isLoading ? '正在工作…' : '完成';
};

export const getAgentRunStatusText = (
  events: AgentWorkEvent[],
  isLoading: boolean,
): string => {
  const last = events[events.length - 1];
  if (last?.status === 'blocked') return '需要补充';
  if (last?.status === 'failed') return '执行失败';
  if (isLoading) return '执行中';
  if (events.length) return '已完成';
  return '待执行';
};

// ---------------------------------------------------------------------------
// 工作过程面板：事件流 → 显示项（去重 + 状态标签）
// ---------------------------------------------------------------------------

/**
 * 把"开启类"事件 (start/iteration_start/tool_call_start/...) 收敛到对应的"结束类"事件状态。
 *
 * 解决的问题：
 *   - 用户看到"初始化任务上下文 / 规划执行步骤"这类已经过去的步骤一直转圈，
 *     是因为后端发的 running 事件和后续 complete 事件 phase 名不同（如
 *     `iteration_start` running 配对 `iteration_end` complete），单纯按 phase 去重会让
 *     running 事件永远没有 complete 对家来覆盖它，于是显示层一直把它认作"运行中"。
 *
 * 设计：
 *   - 通过 (step, toolId, callId) 维度建立"逻辑步骤 key"。
 *   - 一旦遇到"结束类"事件（iteration_end / tool_call_end / *.complete / final / final_answer），
 *     就把同 key 的 running 开启事件**就地改写为 status='complete'**，并把对方的 metadata 合并过来。
 *   - 调用方传 `force=true` 时（会话整体结束/中止），把所有残留的 running 事件
 *     直接强制改为 complete——这是兜底，避免任何路径残留转圈圈。
 *
 * 不修改输入数组，返回一个新的浅拷贝。
 */
export const finalizeAgentEvents = (
  events: AgentWorkEvent[],
  options: { force?: boolean } = {},
): AgentWorkEvent[] => {
  if (!events.length) return events;

  // 关键 key：能唯一定位"逻辑步骤"的字符串
  const keyOf = (event: AgentWorkEvent): string => {
    const meta = (event.metadata || {}) as AgentWorkEventMetadata;
    const step = typeof meta.step === 'number' ? meta.step : null;
    const callId = typeof meta.callId === 'string' ? meta.callId : '';
    const toolId = event.toolId || (typeof meta.toolId === 'string' ? meta.toolId : '') || '';
    // tool 维度：以 step+callId 优先，退化到 step+toolId
    if (
      event.phase === 'tool_call_start' || event.phase === 'tool_call_end' ||
      event.phase === 'tool_call' || event.phase === 'tool_result'
    ) {
      if (callId) return `tool:${step ?? '_'}:${callId}`;
      return `tool:${step ?? '_'}:${toolId}`;
    }
    // iteration 维度：start ↔ end 配对
    if (event.phase === 'iteration_start' || event.phase === 'iteration_end') {
      return `iter:${step ?? '_'}`;
    }
    // 同 phase 收敛（identity/planning/final 等"开始 running → 同 phase complete"模式）
    if (step !== null) return `phase:${step}:${event.phase}`;
    return `phase:${event.phase}`;
  };

  // 第一遍：找出所有"已经被结束类事件覆盖"的逻辑 key
  const closedKeys = new Set<string>();
  for (const event of events) {
    const isTerminal =
      event.status === 'complete' || event.status === 'failed' || event.status === 'blocked' ||
      event.phase === 'iteration_end' || event.phase === 'tool_call_end' ||
      event.phase === 'tool_result' || event.phase === 'final_answer' ||
      event.phase === 'error';
    if (isTerminal) closedKeys.add(keyOf(event));
  }

  // 是否会话整体结束：force=true 强制；或事件流里出现 final/final_answer/error 终止信号
  const isFinalized = options.force === true || events.some(e => (
    (e.phase === 'final' && e.status === 'complete') ||
    e.phase === 'final_answer' ||
    (e.phase === 'error' && (e.status === 'failed' || e.status === 'blocked'))
  ));

  return events.map(event => {
    if (event.status !== 'running') return event;
    const key = keyOf(event);
    if (closedKeys.has(key)) {
      return { ...event, status: 'complete' as AgentWorkEventStatus };
    }
    if (isFinalized) {
      return { ...event, status: 'complete' as AgentWorkEventStatus };
    }
    return event;
  });
};

export const buildAgentProgressItems = (
  events: AgentWorkEvent[],
): AgentNarrativeLine[] => {
  // S3 修复：在去重之前先把残留 running 事件按"开启 → 结束"映射收敛掉，
  // 避免已经过去的步骤（initial/identity/planning/iteration_start/tool_call_start 等）
  // 在会话结束后还以 spinning 状态显示。
  const normalizedEvents = finalizeAgentEvents(events);
  const itemsMap = new Map<string, AgentNarrativeLine>();

  for (const event of normalizedEvents) {
    const line = formatAgentNarrativeLine(event);
    if (!line) continue;

    const step = (event.metadata as any)?.step;
    let key = '';

    // 生成唯一的逻辑步骤 Key，用于归并“开始 -> 结束”状态
    if (typeof step === 'number') {
      if (
        event.phase === 'tool_call_start' ||
        event.phase === 'tool_call_end' ||
        event.phase === 'tool_call' ||
        event.phase === 'tool_result'
      ) {
        key = `step:${step}:tool:${event.toolId || ''}`;
      } else {
        key = `step:${step}:${event.phase}`;
      }
    } else {
      if (event.phase === 'tool_call' || event.phase === 'tool_result') {
        key = `global:tool:${event.toolId || ''}`;
      } else {
        key = `global:${event.phase}`;
      }
    }

    const isRunning = event.status === 'running';
    const isBlocked = event.status === 'blocked';
    const isFailed = event.status === 'failed' || event.phase === 'error';

    const existing = itemsMap.get(key);
    if (existing) {
      // 状态覆盖规则：
      // 如果新状态是终止状态（如 complete、failed、blocked），
      // 或者旧状态是 running 而新状态也是新进展，我们进行覆盖更新。
      const shouldOverwrite =
        (!isRunning && existing.isRunning) ||
        isFailed ||
        isBlocked ||
        (!existing.isFailed && !existing.isBlocked && event.status === 'complete');

      if (shouldOverwrite) {
        itemsMap.set(key, {
          id: event.id,
          phase: event.phase,
          status: event.status,
          toolId: event.toolId,
          toolLabel: event.toolId ? describeAgentTool(event.toolId) : undefined,
          summary: event.summary,
          line,
          isRunning,
          isBlocked,
          isFailed,
        });
      }
    } else {
      itemsMap.set(key, {
        id: event.id,
        phase: event.phase,
        status: event.status,
        toolId: event.toolId,
        toolLabel: event.toolId ? describeAgentTool(event.toolId) : undefined,
        summary: event.summary,
        line,
        isRunning,
        isBlocked,
        isFailed,
      });
    }
  }

  return Array.from(itemsMap.values());
};

// ---------------------------------------------------------------------------
// thinkingLogs → 显示用（fallback，当后端不返回 agent_event 时用）
// ---------------------------------------------------------------------------

const formatVisibleThinkingStep = (rawStep: string): string => {
  const step = String(rawStep || '').trim();
  if (!step) return '';
  if (step.includes('正在启动')) return '连接 Agent Runtime...';
  if (step.includes('我识别到需要调用 Bambook 后端工具')) {
    return step.replace('我识别到需要调用 Bambook 后端工具：', '调用后端工具：');
  }
  if (step.includes('我正在查询数字档案')) return '查询数字档案...';
  if (step.includes('我先查业务字典')) return '查询业务字典...';
  if (step.includes('业务字典返回')) return '读取业务字典结果';
  if (step.includes('分类字典结果不足')) return '分类字典结果不足，扩大检索范围';
  if (step.includes('业务记录统计完成')) return '业务记录统计完成';
  if (step.includes('数字档案查询完成')) return '数字档案查询完成';
  if (step.includes('完整数字档案已读取到')) return '完整数字档案已读取';
  if (step.includes('识别身份')) return '验证访问权限与身份角色...';
  if (step.includes('构建检索问题')) return '构建检索任务参数...';
  if (step.includes('检索返回')) return '读取上下文和工具结果...';
  if (step.includes('权限过滤后可用上下文')) return '基于当前用户权限过滤可用上下文';
  if (step.includes('上下文来源')) return '区分并归类上下文来源';
  if (step.includes('生成最终回答')) return '生成最终回复...';
  if (step.includes('已停止')) return '任务已停止';
  return step
    .replace(/^actor=.*$/i, '确认当前执行身份')
    .replace(/^context=.*$/i, '检查上下文完整度');
};

export const getVisibleThinkingSteps = (logs: string[]): string[] => {
  const seen = new Set<string>();
  const steps = logs
    .map(formatVisibleThinkingStep)
    .filter(Boolean)
    .filter(step => {
      if (seen.has(step)) return false;
      seen.add(step);
      return true;
    });
  const toolSteps = steps.filter(step => (
    step.includes('后端工具') ||
    step.includes('业务字典') ||
    step.includes('业务记录') ||
    step.includes('数字档案') ||
    step.includes('分类字典') ||
    step.includes('产品统计') ||
    step.includes('完整档案')
  ));
  return toolSteps.length >= 2 ? toolSteps : steps;
};

export const buildAgentThoughtProcessText = (
  events: AgentWorkEvent[],
  fallbackLogs: string[],
): string => {
  const eventLines = events.map(formatAgentNarrativeLine).filter(Boolean);
  const uniqueEventLines = Array.from(new Set(eventLines));
  if (uniqueEventLines.length) {
    return uniqueEventLines.map((line, index) => `${index + 1}. ${line}`).join('\n');
  }
  const steps = getVisibleThinkingSteps(fallbackLogs);
  return steps.map((line, index) => `${index + 1}. ${line}`).join('\n');
};

// ---------------------------------------------------------------------------
// 把后端返回的任意对象规范成 AgentWorkEvent
// ---------------------------------------------------------------------------

export const normalizeAgentWorkEvent = (value: any): AgentWorkEvent | null => {
  if (!value || typeof value !== 'object') return null;
  const phase = String(value.phase || '') as AgentWorkEventPhase;
  const status = String(value.status || '') as AgentWorkEventStatus;
  if (!phase || !status || !value.title || !value.message) return null;
  return {
    id: String(value.id || `agent_event_${Date.now()}_${Math.random().toString(36).slice(2)}`),
    at: typeof value.at === 'string' ? value.at : undefined,
    phase,
    status,
    title: String(value.title),
    message: String(value.message),
    toolId: typeof value.toolId === 'string' ? value.toolId : undefined,
    stepId: typeof value.stepId === 'string' ? value.stepId : undefined,
    summary: typeof value.summary === 'string' ? value.summary : undefined,
    metadata: value.metadata && typeof value.metadata === 'object' ? value.metadata : undefined,
  };
};

// ---------------------------------------------------------------------------
// AgentTimeline：把扁平事件流按 step 聚合为结构化"迭代"，给 S3 卡片流消费
// ---------------------------------------------------------------------------

export type AgentTimelinePlanItem = {
  toolId: string;
  input: unknown;
  why?: string;
};

export type AgentTimelineToolCall = {
  callId: string;
  toolId: string;
  toolLabel: string;
  why?: string;
  input?: unknown;
  output?: unknown;
  error?: { code?: string; message: string };
  durationMs?: number;
  ok?: boolean;
  /** 'running' / 'complete' / 'failed' / 'queued' */
  status: AgentWorkEventStatus;
  startedAtId: string;
};

export type AgentTimelineIteration = {
  step: number;
  thought?: string;
  plan?: AgentTimelinePlanItem[];
  toolCalls: AgentTimelineToolCall[];
  finalAnswer?: string;
  /** 是否已经收到 iteration_end / final_answer */
  isComplete: boolean;
};

export type AgentTimelineLegacyTaskNode = {
  id: string;
  kind?: string;
  status?: string;
  toolId?: string;
  objective?: string;
};

export type AgentTimeline = {
  /** 至少出现过一次 iteration_start/thought/plan/tool_call_start/iteration_end/final_answer */
  hasNewLoop: boolean;
  iterations: AgentTimelineIteration[];
  finalAnswer?: string;
  stopReason?: string;
  forced?: boolean;
  /** 旧 orchestrator 路径的任务图（phase='planning' / metadata.steps）；agentLoop 路径不会有 */
  legacyTaskGraph?: AgentTimelineLegacyTaskNode[];
  /** 旧 phase 流（无新 phase 时由 AgentProcessPanel 兜底渲染） */
  legacyEvents: AgentWorkEvent[];
};

const NEW_LOOP_PHASES = new Set<AgentWorkEventPhase>([
  'iteration_start',
  'thought',
  'thought_delta',
  'thought_end',
  'plan',
  'tool_call_start',
  'tool_call_end',
  'iteration_end',
  'final_answer',
  'answer_delta',
  'answer_end',
]);

const ensureIteration = (
  iters: Map<number, AgentTimelineIteration>,
  step: number,
): AgentTimelineIteration => {
  let iter = iters.get(step);
  if (!iter) {
    iter = { step, toolCalls: [], isComplete: false };
    iters.set(step, iter);
  }
  return iter;
};

/**
 * 把 AgentWorkEvent[] 聚合为 step 维度的 timeline。
 *
 * 设计：
 *   - 一遍扫描 + 按 metadata.step 索引到 AgentTimelineIteration。
 *   - tool_call_start / tool_call_end 通过 metadata.callId 配对；找不到 callId 时按 toolId 兜底。
 *   - 旧 phase（planning 等）的 metadata.steps 被收集到 legacyTaskGraph，给 TaskGraphPanel 渲染。
 *   - 任何无 step 维度的旧事件统一塞进 legacyEvents，供 AgentProcessPanel 渲染。
 */
export const buildAgentTimeline = (events: AgentWorkEvent[]): AgentTimeline => {
  const iterations = new Map<number, AgentTimelineIteration>();
  const legacyEvents: AgentWorkEvent[] = [];
  let legacyTaskGraph: AgentTimelineLegacyTaskNode[] | undefined;
  let finalAnswer: string | undefined;
  let stopReason: string | undefined;
  let forced: boolean | undefined;
  let hasNewLoop = false;

  for (const event of events) {
    const meta = (event.metadata || {}) as AgentWorkEventMetadata;
    const step = typeof meta.step === 'number' ? meta.step : undefined;

    if (NEW_LOOP_PHASES.has(event.phase)) hasNewLoop = true;

    switch (event.phase) {
      case 'iteration_start': {
        if (step) ensureIteration(iterations, step);
        break;
      }
      case 'thought': {
        if (!step) break;
        const iter = ensureIteration(iterations, step);
        iter.thought = String(meta.thought ?? event.message ?? '').trim();
        break;
      }
      case 'thought_delta': {
        if (!step) break;
        const iter = ensureIteration(iterations, step);
        iter.thought = (iter.thought || '') + String(meta.delta ?? event.message ?? '');
        break;
      }
      case 'thought_end':
      case 'answer_end':
        break;
      case 'plan': {
        if (!step) break;
        const iter = ensureIteration(iterations, step);
        const plan = Array.isArray(meta.plan) ? meta.plan : [];
        iter.plan = plan.map(item => ({
          toolId: String(item.toolId || ''),
          input: item.input ?? {},
          why: typeof item.why === 'string' ? item.why : undefined,
        }));
        break;
      }
      case 'tool_call_start': {
        if (!step) break;
        const iter = ensureIteration(iterations, step);
        const toolId = String(event.toolId || meta.toolId || '');
        const callId = String(meta.callId || `${toolId}:${event.id}`);
        iter.toolCalls.push({
          callId,
          toolId,
          toolLabel: describeAgentTool(toolId),
          why: typeof meta.why === 'string' ? meta.why : undefined,
          input: meta.input,
          status: 'running',
          startedAtId: event.id,
        });
        break;
      }
      case 'tool_call_end': {
        if (!step) break;
        const iter = ensureIteration(iterations, step);
        const toolId = String(event.toolId || meta.toolId || '');
        const callId = String(meta.callId || '');
        // 1) 优先 callId 匹配；2) fallback toolId + 仍 running 的最后一项
        let target = callId
          ? iter.toolCalls.find(call => call.callId === callId)
          : undefined;
        if (!target) {
          for (let i = iter.toolCalls.length - 1; i >= 0; i--) {
            const cand = iter.toolCalls[i];
            if (cand.toolId === toolId && cand.status === 'running') { target = cand; break; }
          }
        }
        if (!target) {
          // 后端没发 start，直接合成一条已完成的记录
          target = {
            callId: callId || `${toolId}:${event.id}`,
            toolId,
            toolLabel: describeAgentTool(toolId),
            status: event.status,
            startedAtId: event.id,
          };
          iter.toolCalls.push(target);
        }
        target.status = event.status;
        target.ok = typeof meta.ok === 'boolean' ? meta.ok : event.status === 'complete';
        if (typeof meta.durationMs === 'number') target.durationMs = meta.durationMs;
        if ('output' in meta) target.output = meta.output;
        if (meta.error) target.error = meta.error;
        if (typeof meta.input !== 'undefined' && typeof target.input === 'undefined') target.input = meta.input;
        break;
      }
      case 'iteration_end': {
        if (!step) break;
        const iter = ensureIteration(iterations, step);
        iter.isComplete = true;
        break;
      }
      case 'final_answer': {
        finalAnswer = typeof meta.finalAnswer === 'string' ? meta.finalAnswer : event.message;
        if (typeof meta.stopReason === 'string') stopReason = meta.stopReason;
        if (typeof meta.forced === 'boolean') forced = meta.forced;
        if (step) {
          const iter = ensureIteration(iterations, step);
          iter.finalAnswer = finalAnswer;
          iter.isComplete = true;
        }
        break;
      }
      // ── 旧 phase ──
      case 'planning': {
        // orchestrator 旧路径会发两次 planning：第一次 status=running 标"读取工具能力"，
        // 第二次 status=complete metadata.steps 标"生成任务图"。把后者收集成 legacyTaskGraph。
        const steps = Array.isArray(meta.steps) ? meta.steps : undefined;
        if (steps && steps.length) {
          legacyTaskGraph = steps.map((node, idx) => ({
            id: String((node as any).id || `legacy_${idx}`),
            kind: typeof (node as any).kind === 'string' ? (node as any).kind : undefined,
            status: typeof (node as any).status === 'string' ? (node as any).status : undefined,
            toolId: typeof (node as any).toolId === 'string' ? (node as any).toolId : undefined,
            objective: typeof (node as any).objective === 'string'
              ? (node as any).objective
              : typeof (node as any).reason === 'string' ? (node as any).reason : undefined,
          }));
        }
        legacyEvents.push(event);
        break;
      }
      default:
        legacyEvents.push(event);
    }
  }

  return {
    hasNewLoop,
    iterations: (() => {
      const sorted = Array.from(iterations.values()).sort((a, b) => a.step - b.step);
      // 如果整轮已经结束（finalAnswer 已下达 / 旧 phase final 也算），把所有未配对的
      // running toolCall 收敛为 complete，并把 iteration 标 isComplete，避免卡转圈。
      const hasFinal = typeof finalAnswer === 'string' && finalAnswer.length > 0;
      if (!hasFinal) return sorted;
      return sorted.map(iter => ({
        ...iter,
        isComplete: true,
        toolCalls: iter.toolCalls.map(call => (
          call.status === 'running'
            ? { ...call, status: 'complete' as AgentWorkEventStatus, ok: call.ok ?? true }
            : call
        )),
      }));
    })(),
    finalAnswer,
    stopReason,
    forced,
    legacyTaskGraph,
    legacyEvents,
  };
};
