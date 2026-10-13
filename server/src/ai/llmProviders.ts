/**
 * LLM Provider 链 — 批次 2a「LLM 网关备用 provider 配置化」
 *
 * 改造前：createArkLLMCompleter 单 provider（ARK baseUrl + env key 链），
 * 主 provider 不可用时 agentLoop 直接 llm_failure 收尾，无降级通道。
 *
 * 设计：
 *   1. provider 链由 env 声明式配置——主 provider（沿用现有 ARK 语义，向后兼容）
 *      + 最多两组备用（BAMBOOK_LLM_BACKUP_* / BAMBOOK_LLM_BACKUP2_*）。
 *      备用需 URL + KEY 齐备才启用；MODEL 缺省回落全局默认（BAMBOOK_MODEL_NAME）。
 *   2. 失败转移策略：请求级逐个尝试（网络错误 / 非 2xx / 流中断 → 下一个 provider）；
 *      AbortError（用户取消/会话超时/上游 superseded）不转移，直接抛出。
 *   3. 不做后台健康探测——失败转移本身就是探测，避免常驻探针的复杂度与额外配额消耗。
 *   4. 全链失败抛语义化错误 LLM_ALL_PROVIDERS_FAILED（附逐 provider 失败摘要），
 *      上层可观测、可排查。
 *   5. 每次 complete 动态 resolve 链（与改造前读 env 行为一致，支持运行时调整配置）。
 */

export type LlmProviderConfig = {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type LlmCompletionInput = {
  systemPrompt: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  temperature?: number;
  signal: AbortSignal;
  jsonMode?: boolean;
  onDelta?: (chunk: string) => void;
};

const DEFAULT_LLM_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const DEFAULT_LLM_MODEL = 'ark-code-latest';

function resolvePrimaryApiKey(): string {
  return (
    process.env.ARK_API_KEY ||
    process.env.VOLCENGINE_API_KEY ||
    process.env.TENCENT_API_KEY ||
    process.env.ZHIPU_API_KEY ||
    ''
  ).trim();
}

function resolveGlobalModel(): string {
  return String(process.env.BAMBOOK_MODEL_NAME || DEFAULT_LLM_MODEL).trim();
}

function resolveBackupProvider(envPrefix: 'BAMBOOK_LLM_BACKUP' | 'BAMBOOK_LLM_BACKUP2'): LlmProviderConfig | null {
  const baseUrl = process.env[`${envPrefix}_URL`]?.trim().replace(/\/+$/, '');
  const apiKey = process.env[`${envPrefix}_KEY`]?.trim();
  if (!baseUrl || !apiKey) return null;
  return {
    id: envPrefix === 'BAMBOOK_LLM_BACKUP' ? 'backup' : 'backup2',
    baseUrl,
    apiKey,
    model: process.env[`${envPrefix}_MODEL`]?.trim() || resolveGlobalModel(),
  };
}

/**
 * 解析有序 provider 链：主 provider（ARK 语义）→ backup → backup2。
 * 主 provider 未配置任何 key 且无备用时返回空数组（调用方据此报"未配置"）。
 */
export function resolveLlmProviderChain(): LlmProviderConfig[] {
  const chain: LlmProviderConfig[] = [];
  const primaryApiKey = resolvePrimaryApiKey();
  if (primaryApiKey) {
    chain.push({
      id: 'primary',
      baseUrl: String(process.env.BAMBOOK_MODEL_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/+$/, ''),
      apiKey: primaryApiKey,
      model: resolveGlobalModel(),
    });
  }
  const backup = resolveBackupProvider('BAMBOOK_LLM_BACKUP');
  if (backup) chain.push(backup);
  const backup2 = resolveBackupProvider('BAMBOOK_LLM_BACKUP2');
  if (backup2) chain.push(backup2);
  return chain;
}

/**
 * 链式 LLM completer：逐 provider 尝试，AbortError 直抛，全链失败抛
 * LLM_ALL_PROVIDERS_FAILED。同一 provider 内保持"流式优先、流式失败降级非流式"。
 */
export function createLlmCompleter() {
  return async function complete(input: LlmCompletionInput): Promise<string> {
    const providers = resolveLlmProviderChain();
    if (providers.length === 0) {
      throw new Error('Model API key is not configured on Mac mini');
    }
    const failures: Array<{ providerId: string; error: string }> = [];
    for (const provider of providers) {
      try {
        return await completeWithProvider(provider, input);
      } catch (err: any) {
        if (err?.name === 'AbortError') throw err;
        failures.push({ providerId: provider.id, error: String(err?.message || err) });
      }
    }
    throw new Error(`LLM_ALL_PROVIDERS_FAILED: ${JSON.stringify(failures)}`);
  };
}

async function completeWithProvider(provider: LlmProviderConfig, input: LlmCompletionInput): Promise<string> {
  const model = input.model || provider.model;
  const messages = [
    { role: 'system' as const, content: input.systemPrompt },
    ...input.messages,
  ];

  // 流式路径：有 onDelta 时走 stream:true，失败降级非流式（同一 provider 内）
  if (input.onDelta) {
    try {
      return await streamChatCompletion({
        baseUrl: provider.baseUrl, apiKey: provider.apiKey, model, messages,
        temperature: input.temperature ?? 0.2,
        signal: input.signal, onDelta: input.onDelta,
      });
    } catch (streamErr: any) {
      if (streamErr?.name === 'AbortError') throw streamErr;
      // 流式失败，降级到非流式后仍由外层链负责转移到下一个 provider
    }
  }

  const body: Record<string, unknown> = {
    model,
    temperature: input.temperature ?? 0.2,
    stream: false,
    messages,
  };
  if (input.jsonMode) {
    // 注意：不是所有模型/API 都支持 response_format JSON mode。
    // system prompt 里已经明确要求 JSON 输出格式，所以这里不再设置 response_format。
    // 保留这个分支作为未来切换支持 JSON mode 的模型时的入口。
  }
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: input.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || data?.message || `Model API failed with ${res.status}`);
  }
  const data: any = await res.json().catch(() => ({}));
  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text) {
    throw new Error(`Model API returned empty content (provider ${provider.id})`);
  }
  return text;
}

async function streamChatCompletion(params: {
  baseUrl: string; apiKey: string; model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number; signal: AbortSignal;
  onDelta: (chunk: string) => void;
}): Promise<string> {
  const res = await fetch(`${params.baseUrl}/chat/completions`, {
    method: 'POST', signal: params.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.apiKey}` },
    body: JSON.stringify({ model: params.model, temperature: params.temperature, stream: true, messages: params.messages }),
  });
  if (!res.ok) throw new Error(`Model API stream failed with ${res.status}`);
  if (!res.body) throw new Error('Model API stream returned no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const chunk: any = JSON.parse(dataStr);
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (delta) { fullText += delta; params.onDelta(delta); }
        } catch { /* skip */ }
      }
    }
  } finally { reader.releaseLock(); }
  const text = fullText.trim();
  if (!text) throw new Error('Model API stream returned no content');
  return text;
}
