/**
 * OpenAI 兼容模型适配：Chat Completions 与 Responses 两种格式，均为流式 + 函数工具调用。
 * ChatGPT 登录（Codex 后端）复用 Responses 格式，只替换地址与鉴权头。
 */
import { readSse } from '../sse';
import { AssistantError, isAbort, type ChatMessage, type FetchLike, type ModelClient, type ModelRequest, type ModelResult, type ToolCall, type ToolSpec, type Usage } from '../types';
import type { ProviderConfig } from '../providers';

export type HttpTarget = { url: string; headers: Record<string, string>; dispatcher?: unknown };

/** HTTP 失败统一映射为中文提示；不回显响应正文，避免泄露代理或密钥信息。 */
export async function httpFailure(res: Response, label: string): Promise<AssistantError> {
  const body = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) return new AssistantError('MODEL_UNAUTHORIZED', `${label}拒绝了授权，请检查 API Key 或重新登录`);
  if (res.status === 429 || /usage_limit|rate_limit|quota/i.test(body)) return new AssistantError('MODEL_LIMITED', `${label}用量已达上限或请求过快，请稍后再试`);
  if (/model/i.test(body) && /(not supported|not found|does not exist|unsupported|invalid)/i.test(body)) return new AssistantError('MODEL_NOT_SUPPORTED', `${label}不支持当前模型，请在设置中更换模型`);
  if (res.status === 400 && /context|too long|maximum/i.test(body)) return new AssistantError('MODEL_CONTEXT', '对话超出模型上下文，请新开对话或缩小范围');
  return new AssistantError('MODEL_REQUEST_FAILED', `${label}请求失败（HTTP ${res.status}）`);
}

async function post(fetchImpl: FetchLike, target: HttpTarget, body: unknown, signal: AbortSignal, label: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(target.url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...target.headers },
      body: JSON.stringify(body),
      ...(target.dispatcher ? { dispatcher: target.dispatcher } : {}),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new AssistantError('MODEL_UNREACHABLE', `无法连接${label}，请检查网络或接口地址`);
  }
  if (!res.ok) throw await httpFailure(res, label);
  return res;
}

// ── Chat Completions ──────────────────────────────────────────────

export function toChatMessages(system: string, messages: ChatMessage[]) {
  const out: any[] = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    else out.push({
      role: 'assistant',
      content: m.content || (m.toolCalls?.length ? null : ''),
      ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}),
    });
  }
  return out;
}

const chatTools = (tools: ToolSpec[]) => tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

export class ChatCompletionsClient implements ModelClient {
  constructor(private readonly config: ProviderConfig, private readonly target: HttpTarget, private readonly fetchImpl: FetchLike, private readonly label = '模型服务') {}

  async complete(request: ModelRequest): Promise<ModelResult> {
    const c = this.config;
    const body: Record<string, unknown> = {
      ...(c.custom_request_body ?? {}),
      model: c.model,
      messages: toChatMessages(request.system, request.messages),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: c.max_tokens,
    };
    if (request.tools.length) body.tools = chatTools(request.tools);
    if (c.temperature !== undefined) body.temperature = c.temperature;
    if (c.top_p !== undefined) body.top_p = c.top_p;
    if (c.reasoning) body.reasoning_effort = c.reasoning;
    const res = await post(this.fetchImpl, this.target, body, request.signal, this.label);
    let text = '';
    let usage: Usage | undefined;
    const partial = new Map<number, ToolCall>();
    await readSse(res, event => {
      if (event?.error) throw new AssistantError('MODEL_REQUEST_FAILED', `${this.label}返回错误`);
      const choice = event?.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === 'string' && delta.content) {
        text += delta.content;
        request.onEvent?.({ type: 'text', delta: delta.content });
      }
      for (const tc of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
        const index = Number.isInteger(tc?.index) ? tc.index : partial.size;
        const current = partial.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof tc.id === 'string' && tc.id) current.id = tc.id;
        if (typeof tc.function?.name === 'string') current.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') current.arguments += tc.function.arguments;
        partial.set(index, current);
      }
      if (event?.usage) usage = { input: Number(event.usage.prompt_tokens) || 0, output: Number(event.usage.completion_tokens) || 0 };
    });
    const toolCalls = [...partial.entries()].sort((a, b) => a[0] - b[0]).map(([i, call]) => ({ ...call, id: call.id || `call_${i}` })).filter(c => c.name);
    for (const call of toolCalls) request.onEvent?.({ type: 'tool_call', call });
    if (usage) request.onEvent?.({ type: 'usage', usage });
    return { text, toolCalls, usage };
  }
}

// ── Responses ─────────────────────────────────────────────────────

export function toResponsesInput(messages: ChatMessage[]) {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: m.content }] });
    else if (m.role === 'tool') out.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
    else {
      if (m.content) out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      for (const c of m.toolCalls ?? []) out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
    }
  }
  return out;
}

export type ResponsesOptions = { label?: string; extraBody?: Record<string, unknown>; target: () => Promise<HttpTarget>; onUnauthorized?: () => Promise<HttpTarget | null> };

export class ResponsesClient implements ModelClient {
  constructor(private readonly config: ProviderConfig, private readonly options: ResponsesOptions, private readonly fetchImpl: FetchLike) {}

  async complete(request: ModelRequest): Promise<ModelResult> {
    const c = this.config;
    const label = this.options.label ?? '模型服务';
    const body: Record<string, unknown> = {
      ...(c.custom_request_body ?? {}),
      ...(this.options.extraBody ?? {}),
      model: c.model,
      instructions: request.system,
      input: toResponsesInput(request.messages),
      stream: true,
      store: false,
    };
    if (request.tools.length) {
      body.tools = request.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }
    if (c.reasoning) body.reasoning = { effort: c.reasoning, summary: 'auto' };
    if (c.temperature !== undefined) body.temperature = c.temperature;
    if (c.top_p !== undefined) body.top_p = c.top_p;
    let target = await this.options.target();
    let res: Response;
    try {
      res = await post(this.fetchImpl, target, body, request.signal, label);
    } catch (error) {
      const retry = error instanceof AssistantError && error.code === 'MODEL_UNAUTHORIZED' && this.options.onUnauthorized ? await this.options.onUnauthorized() : null;
      if (!retry) throw error;
      target = retry;
      res = await post(this.fetchImpl, target, body, request.signal, label);
    }
    let text = '';
    let completedText = '';
    let usage: Usage | undefined;
    const toolCalls: ToolCall[] = [];
    const seen = new Set<string>();
    const pushCall = (item: any) => {
      if (item?.type !== 'function_call' || typeof item.name !== 'string') return;
      const id = String(item.call_id || item.id || `call_${toolCalls.length}`);
      if (seen.has(id)) return;
      seen.add(id);
      const call = { id, name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) };
      toolCalls.push(call);
      request.onEvent?.({ type: 'tool_call', call });
    };
    await readSse(res, event => {
      switch (event?.type) {
        case 'response.output_text.delta':
          if (typeof event.delta === 'string' && event.delta) { text += event.delta; request.onEvent?.({ type: 'text', delta: event.delta }); }
          break;
        case 'response.output_item.done':
          pushCall(event.item);
          break;
        case 'response.completed':
        case 'response.done': {
          const output = Array.isArray(event.response?.output) ? event.response.output : [];
          for (const item of output) pushCall(item);
          completedText = output.filter((i: any) => i?.type === 'message').flatMap((i: any) => Array.isArray(i.content) ? i.content : [])
            .filter((p: any) => p?.type === 'output_text' && typeof p.text === 'string').map((p: any) => p.text).join('');
          const u = event.response?.usage;
          if (u) usage = { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0 };
          break;
        }
        case 'response.failed':
        case 'response.incomplete':
        case 'error': {
          const detail = JSON.stringify(event.response?.error ?? event.error ?? event.response?.incomplete_details ?? {});
          if (/usage_limit|rate_limit/i.test(detail)) throw new AssistantError('MODEL_LIMITED', `${label}用量已达上限，请稍后再试`);
          if (/context|max_output|too long/i.test(detail)) throw new AssistantError('MODEL_CONTEXT', '对话超出模型上下文，请新开对话或缩小范围');
          throw new AssistantError('MODEL_REQUEST_FAILED', `${label}返回失败`);
        }
        default:
          break;
      }
    });
    if (!text && completedText) { text = completedText; request.onEvent?.({ type: 'text', delta: completedText }); }
    if (usage) request.onEvent?.({ type: 'usage', usage });
    return { text, toolCalls, usage };
  }
}
