import { AiEmit } from '../ai/runtime';

/**
 * Agent 工作事件 phase。
 *
 * 旧 phase（identity / planning / tool_call / tool_result / assessment / final / start / error）
 * 来自 orchestrator + toolRuntime.runAgentToolCalls 的旧路径，保留以兼容现有持久化和前端。
 *
 * S2 新增的 7 个 phase 用于真 Agent 循环（agentLoop.ts）：
 *   - iteration_start：第 N 步开始
 *   - thought：LLM 本步的思考文本
 *   - plan：LLM 本步决定调用的工具列表
 *   - tool_call_start：某次具体 tool call 开始
 *   - tool_call_end：某次具体 tool call 结束（含 ok / output / error / durationMs）
 *   - iteration_end：第 N 步结束
 *   - final_answer：循环收尾时给出的最终回答
 */
export type AgentWorkEventPhase =
  // 旧 phase（保留）
  | 'start'
  | 'identity'
  | 'planning'
  | 'tool_call'
  | 'tool_result'
  | 'assessment'
  | 'final'
  | 'error'
  // 新 agentLoop phase
  | 'iteration_start'
  | 'thought'
  | 'plan'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'iteration_end'
  | 'final_answer'
  | 'thought_delta'
  | 'thought_end'
  | 'answer_delta'
  | 'answer_end'
  // form 交互 phase
  | 'form_request'
  | 'form_resolved'
  // checkpoint/resume phase
  | 'checkpoint_resumed'
  // 批次 2b：挂起审批恢复 phase（resume 检查决议 → 补执行/重新挂起）
  | 'approval_resume';

export type AgentWorkEventStatus =
  | 'queued'
  | 'running'
  | 'complete'
  | 'blocked'
  | 'failed';

/**
 * agentLoop 事件 metadata 的字段约定。
 * 不强制——前端按需消费，但所有写入方应该遵循这套字段名。
 */
export type AgentWorkEventMetadata = {
  step?: number;
  callId?: string;
  toolId?: string;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  why?: string;
  thought?: string;
  plan?: Array<{ toolId: string; input: unknown; why?: string }>;
  finalAnswer?: string;
  ok?: boolean;
  stopReason?: string;
  error?: { code?: string; message: string };
  // 兜底：允许携带任意调试信息，不限制额外字段。
  [key: string]: unknown;
};

export type AgentWorkEvent = {
  id?: string;
  phase: AgentWorkEventPhase;
  status: AgentWorkEventStatus;
  title: string;
  message: string;
  toolId?: string;
  stepId?: string;
  summary?: string;
  metadata?: AgentWorkEventMetadata;
};

/**
 * 发射一条 Agent 工作事件。
 *
 * S1 已废弃 legacy 'step' 通道，默认 legacyStep=false。
 * 旧调用方可显式传 { legacyStep: true } 临时维持，但应尽快迁出。
 */
export function emitAgentWorkEvent(
  emit: AiEmit | undefined,
  event: AgentWorkEvent,
  options: { legacyStep?: boolean } = {},
) {
  const payload = {
    id: event.id || `agent_event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...event,
  };
  emit?.('agent_event', payload);
  emitBlocksForAgentWorkEvent(emit, payload);
  if (options.legacyStep === true) {
    emit?.('step', { message: event.message });
  }
}

function emitBlocksForAgentWorkEvent(emit: AiEmit | undefined, event: AgentWorkEvent & { id: string; at: string }) {
  if (!emit) return;

  // form 交互：LLM 自主发起的交互原语，不依赖工具（无 toolId）。
  // 必须在 toolId 早退之前处理，否则 form_request 永远派生不出 form block。
  if (event.phase === 'form_request' && event.metadata?.formId) {
    emitFormBlock(emit, event);
    return;
  }

  // 以下分支派生 tool/approval 相关 block，依赖 toolId
  if (!event.toolId) return;

  if (event.phase === 'tool_call' || event.phase === 'tool_call_start' || event.phase === 'tool_result' || event.phase === 'tool_call_end') {
    emitToolLifecycleBlock(emit, event);
  }

  if ((event.phase === 'tool_result' || event.phase === 'tool_call_end') && event.status === 'complete') {
    const output = event.metadata?.output;
    const outputSummary = typeof event.summary === 'string' && event.summary.trim()
      ? event.summary
      : typeof event.metadata?.outputSummary === 'string'
        ? event.metadata.outputSummary
        : undefined;
    emitEvidenceBlock(emit, event, outputSummary);
    emitTableBlockFromOutput(emit, event, output);
  }

  // Phase 7-58: tool 被审批拦截时，派生 approval block（审批气泡），让前端走 HITL Action Dispatcher
  // 触发条件：status='blocked' + (metadata.approvalId 存在 或 risk=high)
  // approvalId 可能为临时 ID（API Key 模式下落库失败时 toolRuntime 生成的 ar_temp_ 前缀 ID）
  if (event.status === 'blocked' && (event.metadata?.approvalId || event.metadata?.risk === 'high')) {
    emitApprovalBlock(emit, event);
  }
}

/**
 * 派生 approval block。
 *
 * 触发条件：emitAgentWorkEvent 里 status='blocked' + metadata.approvalId 已落库。
 *
 * 字段映射：
 *   - approvalId: 来自 metadata.approvalId（runAgentToolCall 里 ApprovalRequest 主键）
 *   - risk: tool manifest 风险
 *   - proposedAction: 工具人话标题（如"读取订单数据"）
 *   - input: 候选执行入参（用户可能在 modal 里改）
 *   - editableFields: 来自 ToolManifestSafety.editableFields
 *   - approvalStatus: 'pending'（resolve 后通过下一轮事件 patch）
 */
function emitApprovalBlock(emit: AiEmit, event: AgentWorkEvent & { id: string; at: string }) {
  let approvalId = String(event.metadata?.approvalId || '');
  // 兜底：如果 approvalId 仍为空（理论上不应发生，因为外层已过滤），用事件 ID 兜底
  if (!approvalId) {
    approvalId = `ar_fallback_${event.id}`;
  }
  const risk = normalizeApprovalRisk(event.metadata?.risk);
  const blockId = stableBlockId('block_approval', event);
  const editableFields = Array.isArray(event.metadata?.editableFields)
    ? (event.metadata!.editableFields as string[]).filter(field => typeof field === 'string')
    : undefined;
  const inputPreview = previewRecord(event.metadata?.input);
  emit('block_start', {
    messageId: '',
    block: {
      id: blockId,
      type: 'approval',
      title: '需要审批',
      status: 'streaming',
      approvalId,
      risk,
      proposedAction: event.title || event.toolId || '执行工具',
      toolId: event.toolId,
      input: inputPreview,
      editableFields,
      approvalStatus: 'pending',
    },
  });
  // 注意：不立即 emit block_end —— approval block 的 lifecycle 由 resolve 路由
  // 通过 patch 推进（pending → approved/rejected/modified）。即使前端在重连时收不到
  // block_end，reduceAgentBlocks 也允许后续 block_patch 单独把 approvalStatus 切到终态。
}

function normalizeApprovalRisk(value: unknown): 'medium' | 'high' | 'critical' {
  return value === 'critical' || value === 'high' || value === 'medium' ? value : 'high';
}

function emitFormBlock(emit: AiEmit, event: AgentWorkEvent & { id: string; at: string }) {
  const formId = String(event.metadata?.formId || '');
  if (!formId) return;
  const fields = Array.isArray(event.metadata?.fields) ? event.metadata.fields : [];
  const blockId = stableBlockId('block_form', event);
  emit('block_start', {
    messageId: '',
    block: {
      id: blockId,
      type: 'form',
      title: event.title || '请填写信息',
      status: 'streaming',
      formId,
      description: event.message || '',
      fields,
      submitLabel: typeof event.metadata?.submitLabel === 'string' ? event.metadata.submitLabel : '提交',
      formStatus: 'pending',
    },
  });
}

function emitToolLifecycleBlock(emit: AiEmit, event: AgentWorkEvent & { id: string; at: string }) {
  const blockId = stableBlockId('block_tool', event);
  const lifecycleStatus = event.status === 'failed'
    ? 'failed'
    : event.status === 'blocked'
      ? 'blocked'
      : event.phase === 'tool_call' || event.phase === 'tool_call_start'
        ? 'running'
        : 'succeeded';

  emit('block_start', {
    messageId: '',
    block: {
      id: blockId,
      type: 'tool',
      title: event.title,
      status: lifecycleStatus === 'succeeded' || lifecycleStatus === 'failed' || lifecycleStatus === 'blocked' ? 'complete' : 'streaming',
      toolRunId: typeof event.metadata?.toolRunId === 'string' ? event.metadata.toolRunId : undefined,
      toolId: event.toolId,
      risk: normalizeRisk(event.metadata?.risk),
      lifecycleStatus,
      reason: event.summary || event.message,
      inputPreview: previewRecord(event.metadata?.input),
      outputPreview: previewValue(event.metadata?.outputPreview ?? event.metadata?.output ?? event.metadata?.outputSummary),
      error: event.metadata?.error && typeof event.metadata.error === 'object'
        ? String((event.metadata.error as { message?: unknown }).message || '')
        : undefined,
      errorPreview: event.metadata?.errorPreview,
      errorCode: event.metadata?.error && typeof event.metadata.error === 'object'
        ? (event.metadata.error as { code?: unknown }).code as string | undefined
        : undefined,
      errorUserAction: event.metadata?.error && typeof event.metadata.error === 'object'
        ? (event.metadata.error as { userAction?: unknown }).userAction as string | undefined
        : undefined,
      expandable: Boolean(event.metadata?.input || event.metadata?.output),
    },
  });
  if (lifecycleStatus !== 'running') {
    emit('block_end', { messageId: '', blockId });
  }
}

function emitEvidenceBlock(
  emit: AiEmit,
  event: AgentWorkEvent & { id: string; at: string },
  outputSummary?: string,
) {
  const summary = outputSummary || event.message;
  if (!summary) return;
  const refId = stableBlockId('ref_tool', event);
  const blockId = stableBlockId('block_evidence', event);
  emit('block_start', {
    messageId: '',
    block: {
      id: blockId,
      type: 'evidence',
      title: '执行结果',
      status: 'complete',
      anchors: [{
        refId,
        kind: 'tool_run',
        label: event.toolId,
        toolRunId: typeof event.metadata?.toolRunId === 'string' ? event.metadata.toolRunId : undefined,
        blockId: stableBlockId('block_tool', event),
      }],
      items: [{
        refId,
        label: humanizeToolLabel(event.toolId || '', event.title),
        summary: humanizeOutputSummary(event.toolId || '', summary),
        confidence: 'high',
      }],
    },
  });
  emit('block_end', { messageId: '', blockId });
}

function emitTableBlockFromOutput(emit: AiEmit, event: AgentWorkEvent & { id: string; at: string }, output: unknown) {
  const rows = extractRows(output);
  if (!rows.length) return;
  const columns = inferColumns(rows).slice(0, 6);
  if (!columns.length) return;
  const blockId = stableBlockId('block_table', event);
  emit('block_start', {
    messageId: '',
    block: {
      id: blockId,
      type: 'table',
      title: `${event.toolId} 结果`,
      status: 'complete',
      columns,
      rows: rows.slice(0, 8).map(row => pickPreviewRow(row, columns.map(column => column.key))),
      caption: rows.length > 8 ? `显示前 8 条，共 ${rows.length} 条候选记录。` : undefined,
      source: {
        kind: 'tool',
        toolRunIds: [typeof event.metadata?.toolRunId === 'string' ? event.metadata.toolRunId : event.id].filter(Boolean),
      },
    },
  });
  emit('block_end', { messageId: '', blockId });
}

function stableBlockId(prefix: string, event: AgentWorkEvent & { id: string }) {
  const raw = String(event.metadata?.callId || event.id || event.toolId || 'event');
  return `${prefix}_${raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}`;
}

function normalizeRisk(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low' ? value : 'low';
}

function previewRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return pickPreviewRow(value as Record<string, unknown>, Object.keys(value as Record<string, unknown>).slice(0, 8));
}

function previewValue(value: unknown): unknown {
  if (Array.isArray(value)) return { count: value.length };
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const preview = pickPreviewRow(record, Object.keys(record).slice(0, 8));
  for (const key of ['count', 'total', 'hasMore', 'dataSource']) {
    if (key in record) preview[key] = primitivePreview(record[key]);
  }
  return preview;
}

function extractRows(output: unknown): Array<Record<string, unknown>> {
  if (!output || typeof output !== 'object') return [];
  const record = output as Record<string, unknown>;
  const candidates = [record.items, record.rows, record.records, record.data, record.results];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const rows = candidate.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>>;
    if (rows.length) return rows;
  }
  return [];
}

function inferColumns(rows: Array<Record<string, unknown>>) {
  const seen = new Set<string>();
  const columns: Array<{ key: string; label: string; align?: 'left' | 'center' | 'right' }> = [];
  for (const row of rows.slice(0, 5)) {
    for (const [key, value] of Object.entries(row)) {
      if (seen.has(key)) continue;
      if (!isPreviewablePrimitive(value)) continue;
      seen.add(key);
      columns.push({ key, label: humanizeKey(key), align: typeof value === 'number' ? 'right' : 'left' });
    }
  }
  return columns;
}

function pickPreviewRow(row: Record<string, unknown>, keys: string[]) {
  return keys.reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = primitivePreview(row[key]);
    return acc;
  }, {});
}

function primitivePreview(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === 'object') return 'object';
  return String(value);
}

function isPreviewablePrimitive(value: unknown) {
  return value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value);
}

function humanizeKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, char => char.toUpperCase());
}

// ── 人性化标签：把机械的 toolId 和 "total/count=0" 翻译成自然语言 ──

const TOOL_LABEL_MAP: Record<string, string> = {
  'memory.recall': '检索跨会话记忆',
  'memory.write': '写入跨会话记忆',
  'relations.query': '检索客户/供应商档案',
  'relations.get': '读取档案详情',
  'relations.expand': '展开档案上下文',
  'relations.create': '创建新档案',
  'orders.query': '检索订单',
  'orders.get': '读取订单详情',
  'orders.expand': '展开订单上下文',
  'products.query': '检索产品档案',
  'products.get': '读取产品档案',
  'products.expand': '展开产品上下文',
  'products.describe_schema': '读取数据结构',
  'knowledge.search': '搜索知识库',
  'entities.search': '解析候选实体',
  'entities.hydrate': '获取实体详情',
  'finance.list_invoices': '检索发票',
  'finance.list_vouchers': '检索付款凭证',
  'shipping.list_shipments': '检索发货记录',
  'development.query': '检索开发案例',
  'email.list': '检索邮件',
  'template.list': '列出模板',
  'template.render': '渲染模板',
  'template.render_pdf': '渲染 PDF',
};

function humanizeToolLabel(toolId: string, fallback?: string): string {
  if (TOOL_LABEL_MAP[toolId]) return TOOL_LABEL_MAP[toolId];
  // 如果 fallback 是 "xxx 完成" 这种，直接用
  if (fallback && fallback !== toolId) return fallback;
  return toolId;
}

function humanizeOutputSummary(toolId: string, summary: string): string {
  if (!summary) return '已返回结果';
  // 处理 "total/count=0" 格式
  const countMatch = summary.match(/total\/count\s*=\s*(\d+)/i);
  if (countMatch) {
    const count = parseInt(countMatch[1], 10);
    if (count === 0) return `查询完成，没有找到匹配记录`;
    if (count === 1) return `查询完成，找到 1 条匹配记录`;
    return `查询完成，找到 ${count} 条匹配记录`;
  }
  if (summary === 'found=true') return '找到匹配记录';
  if (summary === 'found=false') return '未找到匹配记录';
  if (summary === '工具已返回结果' || summary === '工具已返回结构化结果') return '已返回结果';
  return summary;
}

// =========================================================================
// 全局事件总线：用于审批流程的进程内通信
// 解决旧架构下导致对话切分的问题，实现“一轮流内挂起等待”的长程思考架构。
// =========================================================================
import { EventEmitter } from 'events';
export const approvalEventBus = new EventEmitter();
export const formEventBus = new EventEmitter();
// =========================================================================
