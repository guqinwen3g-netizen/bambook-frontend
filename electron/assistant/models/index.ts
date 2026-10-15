/** 按提供商格式创建模型客户端；API Key 每次从本机加密存储读取，不常驻配置对象。 */
import { Agent } from 'undici';
import { AssistantError, type FetchLike, type ModelClient, type SecretStore } from '../types';
import { apiKeySecret, type ProviderConfig } from '../providers';
import { ChatCompletionsClient, ResponsesClient, type HttpTarget } from './openai';
import type { ChatgptAuth } from './chatgpt';

export type ModelDeps = { secrets: SecretStore; fetch: FetchLike; chatgpt: ChatgptAuth };

let insecureAgent: Agent | null = null;
const dispatcherFor = (config: ProviderConfig) => (config.skip_ssl_verify ? (insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } })) : undefined);

async function apiTarget(config: ProviderConfig, deps: ModelDeps, path: string): Promise<HttpTarget> {
  const key = await deps.secrets.get(apiKeySecret(config.id));
  const headers: Record<string, string> = { ...(config.custom_headers ?? {}) };
  if (key) headers.Authorization = `Bearer ${key}`;
  return { url: config.request_url || `${config.base_url}${path}`, headers, dispatcher: dispatcherFor(config) };
}

export function createModelClient(config: ProviderConfig, deps: ModelDeps): ModelClient {
  const label = config.name ? `「${config.name}」` : '模型服务';
  if (config.format === 'chatgpt-subscription') {
    return new ResponsesClient(config, { label: 'ChatGPT', extraBody: { include: [] }, target: () => deps.chatgpt.target(), onUnauthorized: () => deps.chatgpt.refreshTarget() }, deps.fetch);
  }
  if (config.format === 'openai-responses') {
    return new ResponsesClient(config, { label, target: () => apiTarget(config, deps, '/responses') }, deps.fetch);
  }
  return {
    async complete(request) {
      const target = await apiTarget(config, deps, '/chat/completions');
      return new ChatCompletionsClient(config, target, deps.fetch, label).complete(request);
    },
  };
}

/** “获取可用模型”：OpenAI 兼容接口读 /models；ChatGPT 读 Codex 模型清单。 */
export async function listProviderModels(config: ProviderConfig, deps: ModelDeps): Promise<string[]> {
  if (config.format === 'chatgpt-subscription') return deps.chatgpt.listModels();
  const target = await apiTarget(config, deps, '/models');
  target.url = `${config.base_url}/models`;
  let res: Response;
  try { res = await deps.fetch(target.url, { headers: target.headers, ...(target.dispatcher ? { dispatcher: target.dispatcher } : {}) }); } catch { throw new AssistantError('MODEL_UNREACHABLE', '无法连接接口地址，请检查网络或地址'); }
  if (res.status === 401 || res.status === 403) throw new AssistantError('MODEL_UNAUTHORIZED', '接口拒绝了授权，请检查 API Key');
  if (!res.ok) throw new AssistantError('MODEL_LIST_FAILED', `读取模型列表失败（HTTP ${res.status}）`);
  const data: any = await res.json().catch(() => ({}));
  const rows: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return [...new Set(rows.map(m => String(m?.id ?? m?.name ?? '')).filter(Boolean))].sort();
}
