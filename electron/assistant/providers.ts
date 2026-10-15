/**
 * 提供商配置 —— 字段照搬 OpenBitFun AIConfig（name/base_url/request_url/api_key/model/format/
 * context_window/max_tokens/temperature/top_p/custom_headers/skip_ssl_verify/custom_request_body），
 * 便于互相导入。按用户确认只接 OpenAI 兼容（Chat Completions / Responses）与 ChatGPT 登录。
 * api_key 不落在配置文件里：单独存入本机加密凭据存储，视图只给出 has_api_key。
 */
import { AssistantError } from './types';

export const PROVIDER_FORMATS = ['openai', 'openai-responses', 'chatgpt-subscription'] as const;
export type ProviderFormat = typeof PROVIDER_FORMATS[number];
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export type ProviderConfig = {
  id: string;
  name: string;
  format: ProviderFormat;
  base_url: string;
  request_url?: string;
  model: string;
  context_window: number;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  reasoning?: ReasoningEffort;
  custom_headers?: Record<string, string>;
  custom_request_body?: Record<string, unknown>;
  skip_ssl_verify?: boolean;
};

export type ProviderView = ProviderConfig & { has_api_key: boolean };

export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CHATGPT_DEFAULT_MODEL = 'gpt-6-luna';

const ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const RESERVED_HEADERS = new Set(['authorization', 'chatgpt-account-id', 'content-type', 'host', 'content-length']);
const RESERVED_BODY = new Set(['model', 'messages', 'input', 'instructions', 'tools', 'stream']);

const fail = (message: string): never => { throw new AssistantError('INVALID_PROVIDER', message); };

function optionalNumber(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${label}须在 ${min}–${max} 之间`);
  return n;
}

function integer(value: unknown, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label}须为 ${min}–${max} 的整数`);
  return n;
}

function httpsUrl(value: unknown, label: string, required: boolean): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) { if (required) fail(`请填写${label}`); return undefined; }
  let url: URL;
  try { url = new URL(text); } catch { return fail(`${label}不是有效地址`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) fail(`${label}须使用 https（本机地址可用 http）`);
  if (url.username || url.password) fail(`${label}不能包含账号或密码，请改填 API Key`);
  return text.replace(/\/+$/, '');
}

/** 校验并规范化用户提交的配置（不含 api_key）。 */
export function normalizeProvider(input: any): ProviderConfig {
  if (!input || typeof input !== 'object') fail('配置格式无效');
  const id = String(input.id ?? '').trim();
  if (!ID.test(id)) fail('配置标识无效');
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 60) fail('请填写 1–60 个字的名称');
  const format = input.format as ProviderFormat;
  if (!PROVIDER_FORMATS.includes(format)) fail('不支持的接口格式');
  const subscription = format === 'chatgpt-subscription';
  const model = String(input.model ?? '').trim() || (subscription ? CHATGPT_DEFAULT_MODEL : '');
  if (!model || model.length > 120) fail('请填写模型名');
  const reasoning = input.reasoning ? String(input.reasoning) as ReasoningEffort : undefined;
  if (reasoning && !REASONING_EFFORTS.includes(reasoning)) fail('推理档位无效');
  const headers: Record<string, string> = {};
  if (input.custom_headers && !subscription) {
    if (typeof input.custom_headers !== 'object' || Array.isArray(input.custom_headers)) fail('自定义请求头须为键值对');
    for (const [key, value] of Object.entries(input.custom_headers)) {
      const k = key.trim();
      if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || RESERVED_HEADERS.has(k.toLowerCase())) fail(`请求头 ${key} 不可自定义`);
      if (typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 1000) fail(`请求头 ${key} 的值无效`);
      headers[k] = value as string;
    }
  }
  let body: Record<string, unknown> | undefined;
  if (input.custom_request_body && !subscription) {
    if (typeof input.custom_request_body !== 'object' || Array.isArray(input.custom_request_body)) fail('自定义请求体须为 JSON 对象');
    for (const key of Object.keys(input.custom_request_body)) if (RESERVED_BODY.has(key)) fail(`请求体字段 ${key} 由助手管理，不可覆盖`);
    if (JSON.stringify(input.custom_request_body).length > 8000) fail('自定义请求体过大');
    body = input.custom_request_body;
  }
  const config: ProviderConfig = {
    id,
    name,
    format,
    base_url: subscription ? CHATGPT_BASE_URL : httpsUrl(input.base_url, '接口地址', true)!,
    model,
    context_window: integer(input.context_window, '上下文窗口', 4000, 2_000_000, subscription ? 272_000 : 128_000),
    max_tokens: integer(input.max_tokens, '最大输出', 256, 200_000, 8192),
  };
  const requestUrl = subscription ? undefined : httpsUrl(input.request_url, '完整请求地址', false);
  if (requestUrl) config.request_url = requestUrl;
  const temperature = subscription ? undefined : optionalNumber(input.temperature, 'temperature', 0, 2);
  if (temperature !== undefined) config.temperature = temperature;
  const topP = subscription ? undefined : optionalNumber(input.top_p, 'top_p', 0, 1);
  if (topP !== undefined) config.top_p = topP;
  if (reasoning) config.reasoning = reasoning;
  if (Object.keys(headers).length) config.custom_headers = headers;
  if (body) config.custom_request_body = body;
  if (input.skip_ssl_verify === true && !subscription) config.skip_ssl_verify = true;
  return config;
}

export const apiKeySecret = (providerId: string) => `provider:${providerId}`;
export const CHATGPT_SECRET = 'chatgpt';
