// agentLoop 的核心类型定义。
// 与 orchestrator/toolRuntime 的现有类型保持平行（不复用），让新循环可以独立演进。

import { ActorContext } from './types';

/**
 * LLM 单轮决策的结构化输出。
 *
 * action='call_tool'  → 必须提供 toolCalls（>=1）
 * action='final_answer' → 必须提供 finalAnswer
 *
 * 这是 prompt + JSON 协议的核心契约。LLM 必须严格按这个结构输出，由 zod 校验。
 */
export type LLMTurnResult =
  | {
      action: 'call_tool';
      thought: string;
      toolCalls: PlannedLLMToolCall[];
      finalAnswer?: undefined;
    }
  | {
      action: 'final_answer';
      thought: string;
      finalAnswer: string;
      toolCalls?: undefined;
    }
  | {
      action: 'request_form';
      thought: string;
      formTitle: string;
      formDescription?: string;
      fields: Array<{
        key: string;
        label: string;
        type: 'text' | 'textarea' | 'select' | 'multiselect';
        required?: boolean;
        placeholder?: string;
        options?: string[];
        helpText?: string;
      }>;
      submitLabel?: string;
      toolCalls?: undefined;
      finalAnswer?: undefined;
    };

/**
 * LLM 输出的一次工具调用计划。
 * - toolId 必须是 availableTools 列表中暴露给 LLM 的 id。
 * - input 是 LLM 自己组织的 JSON 参数对象。
 * - why 是 LLM 解释为什么要调这个工具（用于前端展示和调试）。
 */
export type PlannedLLMToolCall = {
  toolId: string;
  input: Record<string, unknown>;
  why?: string;
};

/**
 * 暴露给 LLM 的工具描述（schema）。
 * 描述里只包含 LLM 能理解的最小信息，避免 prompt 过长。
 */
export type ToolDescriptor = {
  id: string;
  name: string;
  scope: string;
  risk: 'low' | 'medium' | 'high';
  description: string;
  inputHint?: string; // 简短的 input 形态提示，例如 "{query: string, limit?: number}"
};

/**
 * 一次工具执行的完整记录。
 * 来源既包括成功执行（output 有值），也包括失败/拒绝（error 有值）。
 */
export type ToolExecutionRecord = {
  callId: string;
  step: number;
  toolId: string;
  input: Record<string, unknown>;
  why?: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
  startedAt: string; // ISO
};

/**
 * Scratchpad：循环内累积的"短期记忆"。
 * 每一步都会把 LLM 的 thought + 上一步的工具结果注入下一次 prompt。
 */
export type Scratchpad = {
  thoughts: Array<{ step: number; content: string }>;
  toolCalls: ToolExecutionRecord[];
};

/**
 * 单次 iteration（循环步）的完整轨迹，用于最终 result.iterations 留档。
 */
export type IterationTrace = {
  step: number;
  startedAt: string; // ISO
  endedAt: string; // ISO
  thought: string;
  action: 'call_tool' | 'final_answer';
  toolCalls: ToolExecutionRecord[];
  finalAnswer?: string;
};

/**
 * agentLoop 主循环的配置。
 * 全部从 defaults.AGENT_LOOP_LIMITS 读取，但允许测试中按需覆盖。
 */
export type AgentLoopConfig = {
  maxSteps: number;            // 最多循环步数（含强制收尾）
  maxToolsPerStep: number;     // 单步内 LLM 可申请的工具数上限
  perToolTimeoutMs: number;    // 单个工具调用超时
  totalBudgetMs: number;       // 整次循环总预算
  llmRepairRetries: number;    // LLM JSON 解析失败时的修复重试次数
};

/**
 * agentLoop.run 的入参。
 * 与 orchestrator.run 的 AgentRunRequest 等价，但只保留 agentLoop 真正需要的字段。
 */
export type AgentLoopInput = {
  actor: ActorContext;
  /** Stable backend conversation/session identifier used to persist and resume checkpoints. */
  conversationId?: string;
  message: string;
  history: Array<{ role: string; content: string }>;
  attachmentContext: Array<{
    title: string;
    category: string;
    content: string;
    source: string;
    scopes?: string[];
  }>;
  model?: string;
  temperature?: number;
  signal: AbortSignal;
  emit?: (type: string, payload: Record<string, unknown>) => void;
  config?: Partial<AgentLoopConfig>;
};

/**
 * agentLoop.run 的产出。
 * - text 是最终回答（LLM final_answer 或强制收尾产物）。
 * - iterations 是每一步的完整轨迹，用于审计和调试。
 * - sources 与 orchestrator 输出兼容，便于前端复用现有 message.sources 渲染。
 * - thoughtProcess 是给前端的"可视化思考过程"文本（合成版）。
 */
export type AgentLoopResult = {
  text: string;
  iterations: IterationTrace[];
  sources: Array<{
    title: string;
    category: string;
    source: string;
    excerpt: string;
  }>;
  thoughtProcess: string;
  stopReason: 'final_answer' | 'max_steps' | 'budget_exhausted' | 'aborted' | 'llm_failure' | 'approval_blocked' | 'form_blocked' | 'recovery_required' | 'outcome_unknown';
};

/**
 * LLMPlanner 的依赖：实际调 LLM 的 callable。
 * 抽出来是为了测试中可以 stub。
 */
export type LLMCompleter = (input: {
  systemPrompt: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  temperature?: number;
  signal: AbortSignal;
  /**
   * jsonMode=true 时要求模型输出严格 JSON（系统提示已写明，但模型层可以再加约束）。
   * 不强求模型方支持 response_format，仅作为 hint。
   */
  jsonMode?: boolean;
  onDelta?: (chunk: string) => void;
}) => Promise<string>;

/**
 * agentLoop 依赖的工具执行器接口。
 * agentLoop 不直接 import toolRuntime，而是通过这个接口拿到能力，方便测试 stub。
 */
export type ToolExecutor = (input: {
  toolId: string;
  input: Record<string, unknown>;
  actor: ActorContext;
  signal: AbortSignal;
  skipApprovalCheck?: boolean;
  // P1-A: 审批通过后重跑时携带 approvalId，commitTransaction 从 payload 恢复已审批 ProcessDraft
  approvalId?: string;
}) => Promise<unknown>;
