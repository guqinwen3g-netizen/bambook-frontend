/**
 * 精简 Harness：模型 ↔ 工具循环，带步数 / 时长 / 单工具超时上限、取消、确认挂起与上下文预算。
 * 不做子 Agent、不做后台定时；写操作串行，读操作同一步最多并行 4 个。
 */
import { AssistantError, isAbort, type ChatMessage, type ModelClient, type ToolCall, type Usage } from './types';
import { parseToolArguments, type ToolDefinition, type ToolRegistry } from './tools';

export type HarnessLimits = {
  maxSteps: number;
  turnTimeoutMs: number;
  toolTimeoutMs: number;
  maxToolResultChars: number;
  contextWindow: number;
  maxOutputTokens: number;
};

export const DEFAULT_LIMITS: HarnessLimits = {
  maxSteps: 40,
  turnTimeoutMs: 30 * 60 * 1000,
  toolTimeoutMs: 60 * 1000,
  maxToolResultChars: 24_000,
  contextWindow: 128_000,
  maxOutputTokens: 8192,
};

export type ConfirmRequest = { callId: string; tool: string; risk: ToolDefinition['risk']; summary: string; groupKey: string; arguments: Record<string, unknown> };

export type HarnessEvent =
  | { type: 'text'; delta: string }
  | { type: 'step'; step: number }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; callId: string; ok: boolean; summary: string }
  | { type: 'confirm'; request: ConfirmRequest }
  | { type: 'confirm_resolved'; callId: string; approved: boolean }
  | { type: 'usage'; usage: Usage }
  | { type: 'context_trimmed'; dropped: number };

export type TurnInput = {
  client: ModelClient;
  system: string;
  history: ChatMessage[];
  userText: string;
  tools: ToolRegistry;
  sessionId: string;
  limits?: Partial<HarnessLimits>;
  signal: AbortSignal;
  onEvent: (event: HarnessEvent) => void;
  /** 挂起等待人工确认；返回 false 视为拒绝。 */
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  /** 每产生一条消息即回调，便于逐步落盘（检查点）。 */
  onMessage?: (message: ChatMessage) => void;
  now?: () => Date;
};

export type StopReason = 'completed' | 'max_steps' | 'timeout' | 'cancelled';
export type TurnResult = { messages: ChatMessage[]; text: string; stopReason: StopReason; steps: number; usage: Usage };

const estimate = (m: ChatMessage) => Math.ceil((m.content.length + (m.role === 'assistant' ? (m.toolCalls ?? []).reduce((n, c) => n + c.arguments.length + c.name.length, 0) : 0)) / 3) + 8;

/** 上下文预算：先截短旧的工具结果，再从最早的完整回合开始丢弃（保留当前回合）。 */
export function fitContext(system: string, history: ChatMessage[], current: ChatMessage[], limits: HarnessLimits): { messages: ChatMessage[]; dropped: number } {
  const budget = Math.max(2000, limits.contextWindow - limits.maxOutputTokens - Math.ceil(system.length / 3) - 4000);
  let older = history.map(m => (m.role === 'tool' && m.content.length > 2000 ? { ...m, content: m.content.slice(0, 2000) + '\n…（较早的工具结果已截短）' } : m));
  const total = () => [...older, ...current].reduce((n, m) => n + estimate(m), 0);
  let dropped = 0;
  while (older.length && total() > budget) {
    // 从下一个 user 消息处切开，保证 tool 结果不会与其调用分离。
    const next = older.findIndex((m, i) => i > 0 && m.role === 'user');
    const cut = next === -1 ? older.length : next;
    dropped += cut;
    older = older.slice(cut);
  }
  return { messages: [...older, ...current], dropped };
}

/** 修复被取消 / 中断的回合：为缺少结果的工具调用补一条“未执行”，避免下一轮请求格式无效。 */
export function repairHistory(history: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    out.push(m);
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < history.length && history[j].role === 'tool') { answered.add((history[j] as Extract<ChatMessage, { role: 'tool' }>).toolCallId); out.push(history[j]); j++; }
    for (const call of m.toolCalls) if (!answered.has(call.id)) out.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify({ error: '该操作已被取消或中断，未执行。' }) });
    i = j - 1;
  }
  return out;
}

function summarize(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? text.slice(0, 160) + '…' : text;
}

async function withTimeout<T>(ms: number, parent: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AssistantError('TOOL_TIMEOUT', `工具执行超过 ${Math.round(ms / 1000)} 秒，已停止`)); }, ms); }),
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', onAbort);
  }
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
  const now = input.now ?? (() => new Date());
  const produced: ChatMessage[] = [];
  const usage: Usage = { input: 0, output: 0 };
  const add = (m: ChatMessage) => { produced.push(m); input.onMessage?.(m); };
  const turn = new AbortController();
  const onParentAbort = () => turn.abort(input.signal.reason);
  input.signal.addEventListener('abort', onParentAbort, { once: true });
  let timedOut = false;
  const turnTimer = setTimeout(() => { timedOut = true; turn.abort(); }, limits.turnTimeoutMs);
  const approvedGroups = new Set<string>();
  let finalText = '';
  let steps = 0;
  const stop = (stopReason: StopReason): TurnResult => ({ messages: produced, text: finalText, stopReason, steps, usage });
  const history = repairHistory(input.history);
  add({ role: 'user', content: input.userText });
  try {
    while (steps < limits.maxSteps) {
      if (turn.signal.aborted) return stop(timedOut ? 'timeout' : 'cancelled');
      steps += 1;
      input.onEvent({ type: 'step', step: steps });
      const fitted = fitContext(input.system, history, produced, limits);
      if (fitted.dropped) input.onEvent({ type: 'context_trimmed', dropped: fitted.dropped });
      const result = await input.client.complete({
        system: input.system,
        messages: fitted.messages,
        tools: input.tools.specs(),
        signal: turn.signal,
        onEvent: e => { if (e.type === 'text') input.onEvent({ type: 'text', delta: e.delta }); },
      });
      if (result.usage) { usage.input += result.usage.input; usage.output += result.usage.output; input.onEvent({ type: 'usage', usage: result.usage }); }
      add({ role: 'assistant', content: result.text, ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}) });
      if (!result.toolCalls.length) { finalText = result.text; return stop('completed'); }

      const executeOne = async (call: ToolCall): Promise<ChatMessage> => {
        const tool = input.tools.get(call.name);
        const reply = (content: string): ChatMessage => ({ role: 'tool', toolCallId: call.id, name: call.name, content });
        input.onEvent({ type: 'tool_start', call });
        if (!tool) { input.onEvent({ type: 'tool_end', callId: call.id, ok: false, summary: '未知工具' }); return reply(JSON.stringify({ error: `工具 ${call.name} 不存在` })); }
        let args: Record<string, unknown>;
        try { args = parseToolArguments(call.arguments, tool); } catch (e) {
          const message = e instanceof Error ? e.message : '参数无效';
          input.onEvent({ type: 'tool_end', callId: call.id, ok: false, summary: message });
          return reply(JSON.stringify({ error: message }));
        }
        if (tool.confirm !== 'never') {
          const groupKey = `${tool.name}:${tool.groupKey?.(args) ?? '*'}`;
          const already = tool.confirm === 'grouped' && approvedGroups.has(groupKey);
          if (!already) {
            const request: ConfirmRequest = { callId: call.id, tool: tool.name, risk: tool.risk, summary: tool.describe?.(args) ?? summarize(args), groupKey, arguments: args };
            input.onEvent({ type: 'confirm', request });
            const approved = await Promise.race([
              input.confirm(request),
              new Promise<boolean>(resolve => turn.signal.addEventListener('abort', () => resolve(false), { once: true })),
            ]);
            input.onEvent({ type: 'confirm_resolved', callId: call.id, approved });
            if (!approved) {
              input.onEvent({ type: 'tool_end', callId: call.id, ok: false, summary: '用户未确认' });
              return reply(JSON.stringify({ error: '用户没有确认此操作，未执行。请询问用户下一步，不要重试。' }));
            }
            if (tool.confirm === 'grouped') approvedGroups.add(groupKey);
          }
        }
        try {
          const value = await withTimeout(tool.timeoutMs ?? limits.toolTimeoutMs, turn.signal, signal => tool.run(args, { signal, sessionId: input.sessionId, now }));
          let content = typeof value === 'string' ? value : JSON.stringify(value ?? null);
          if (content.length > limits.maxToolResultChars) content = content.slice(0, limits.maxToolResultChars) + `\n…（结果过长，已截取前 ${limits.maxToolResultChars} 个字符，可缩小范围再查）`;
          input.onEvent({ type: 'tool_end', callId: call.id, ok: true, summary: summarize(value) });
          return reply(content);
        } catch (e) {
          if (turn.signal.aborted) throw e;
          const message = e instanceof Error ? e.message : '工具执行失败';
          input.onEvent({ type: 'tool_end', callId: call.id, ok: false, summary: message });
          return reply(JSON.stringify({ error: message }));
        }
      };

      // 读操作并行（每批最多 4 个），需确认或有副作用的工具按顺序执行；结果按调用顺序回填。
      const results = new Map<string, ChatMessage>();
      const calls = result.toolCalls;
      let i = 0;
      while (i < calls.length) {
        const tool = input.tools.get(calls[i].name);
        if (tool && tool.risk === 'read' && tool.confirm === 'never') {
          const batch: ToolCall[] = [];
          while (i < calls.length && batch.length < 4) {
            const t = input.tools.get(calls[i].name);
            if (!(t && t.risk === 'read' && t.confirm === 'never')) break;
            batch.push(calls[i++]);
          }
          const outs = await Promise.all(batch.map(executeOne));
          batch.forEach((c, k) => results.set(c.id, outs[k]));
        } else {
          results.set(calls[i].id, await executeOne(calls[i]));
          i += 1;
        }
      }
      for (const call of calls) add(results.get(call.id)!);
    }
    finalText = '已达到单轮最多步骤，先停在这里。可以告诉我是否继续。';
    return stop('max_steps');
  } catch (error) {
    if (turn.signal.aborted || isAbort(error)) return stop(timedOut ? 'timeout' : 'cancelled');
    throw error;
  } finally {
    clearTimeout(turnTimer);
    input.signal.removeEventListener('abort', onParentAbort);
  }
}
