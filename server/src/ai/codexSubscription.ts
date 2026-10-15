/**
 * ChatGPT 订阅（Codex 后端）模型连接 —— 只接入"个人订阅登录 + 文本补全"能力。
 *
 * 协议参考 OpenBitFun（MIT）subscription_auth/codex.rs 与 providers/openai/codex_chatgpt.rs，
 * 仅移植设备码登录、令牌刷新与 Responses 流式补全，不引入其 agent harness。
 *
 * 安全约束：
 *   - 凭据按登录用户隔离，存放在服务器私有目录（默认 server/private/ai-subscriptions，权限 0600）；
 *   - 访问令牌、刷新令牌、账户号永不返回前端、不写日志、不进入错误消息；
 *   - 默认关闭，需 BAMBOOK_CODEX_SUBSCRIPTION=1 显式启用（测试期个人账号；正式版每人连接自己的订阅或改用企业 API）。
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LlmCompletionInput } from './llmProviders';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const DEVICE_USER_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
export const CODEX_DEVICE_VERIFICATION_URL = `${ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const LOGIN_TTL_MS = 15 * 60 * 1000;
const REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const POLL_SAFETY_MARGIN_MS = 3000;

type FetchLike = typeof fetch;

export type CodexCredentials = {
  version: 1;
  provider: 'codex';
  accessToken: string;
  refreshToken: string;
  accountId: string;
  email: string | null;
  plan: string | null;
  residency: string | null;
  expiresAt: number;
  connectedAt: string;
};

export type CodexConnectionStatus = {
  provider: 'chatgpt';
  enabled: boolean;
  connected: boolean;
  email: string | null;
  plan: string | null;
  model: string;
  reasoning: CodexReasoningEffort;
  connectedAt: string | null;
};

export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];
/** 默认模型与推理档位：GPT-6-Luna + max（测试期按用户选择；可用环境变量覆盖）。 */
export const CODEX_DEFAULT_MODEL = 'gpt-6-luna';
export const CODEX_DEFAULT_REASONING: CodexReasoningEffort = 'max';

export type CodexLoginState = 'pending' | 'connected' | 'failed' | 'expired' | 'cancelled';
export type CodexLoginView = {
  loginId: string;
  state: CodexLoginState;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  message: string | null;
};

type LoginSession = {
  id: string;
  subject: string;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
  state: CodexLoginState;
  message: string | null;
  timer: NodeJS.Timeout | null;
};

export type CodexSubscriptionOptions = {
  dir?: string;
  fetch?: FetchLike;
  now?: () => number;
  enabled?: boolean;
  model?: string;
  originator?: string;
  reasoning?: CodexReasoningEffort;
  /** 测试注入：轮询等待函数 */
  schedule?: (fn: () => void, ms: number) => NodeJS.Timeout;
};

export class CodexSubscriptionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) {
    super(message);
    this.name = 'CodexSubscriptionError';
  }
}

function decodeJwtClaims(token: string | undefined | null): Record<string, any> {
  if (!token) return {};
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) ?? {};
  } catch {
    return {};
  }
}

function authClaims(claims: Record<string, any>): Record<string, any> {
  const nested = claims['https://api.openai.com/auth'];
  return nested && typeof nested === 'object' ? nested : {};
}

function accountIdFrom(...tokens: Array<string | undefined>): string {
  for (const token of tokens) {
    const claims = decodeJwtClaims(token);
    const id = claims.chatgpt_account_id || authClaims(claims).chatgpt_account_id || claims.organizations?.[0]?.id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return '';
}

function claimString(key: string, ...tokens: Array<string | undefined>): string | null {
  for (const token of tokens) {
    const claims = decodeJwtClaims(token);
    const value = claims[key] ?? authClaims(claims)[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function effectiveExpiry(accessToken: string, fallbackMs: number): number {
  const exp = Number(decodeJwtClaims(accessToken).exp);
  return Number.isFinite(exp) && exp > 0 ? Math.min(exp * 1000, fallbackMs) : fallbackMs;
}

function pollInterval(value: unknown): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  return (Number.isFinite(n) && n > 0 ? n : 5) * 1000;
}

/** JSON 模式下模型偶尔会用 ```json 包裹，剥离后再交给调用方解析。 */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

export class CodexSubscriptionService {
  private readonly dir: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly logins = new Map<string, LoginSession>();
  private readonly refreshing = new Map<string, Promise<CodexCredentials>>();
  readonly enabled: boolean;
  readonly model: string;
  readonly originator: string;
  readonly reasoning: CodexReasoningEffort;

  constructor(options: CodexSubscriptionOptions = {}) {
    this.dir = options.dir ?? (process.env.BAMBOOK_AI_SUBSCRIPTION_DIR?.trim() || path.resolve(__dirname, '../../private/ai-subscriptions'));
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.enabled = options.enabled ?? process.env.BAMBOOK_CODEX_SUBSCRIPTION === '1';
    this.model = (options.model ?? process.env.BAMBOOK_CODEX_MODEL?.trim()) || CODEX_DEFAULT_MODEL;
    const effort = (options.reasoning ?? process.env.BAMBOOK_CODEX_REASONING?.trim()) as CodexReasoningEffort | undefined;
    this.reasoning = effort && CODEX_REASONING_EFFORTS.includes(effort) ? effort : CODEX_DEFAULT_REASONING;
    this.originator = (options.originator ?? process.env.BAMBOOK_CODEX_ORIGINATOR?.trim()) || 'bambook';
  }

  private userAgent() {
    return `Bambook/1.0 (${process.platform}; ${process.arch})`;
  }

  private file(subject: string) {
    return path.join(this.dir, `${createHash('sha256').update(`codex:${subject}`).digest('hex')}.json`);
  }

  private read(subject: string): CodexCredentials | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(subject), 'utf8'));
      if (data?.version === 1 && data.provider === 'codex' && typeof data.accessToken === 'string' && typeof data.refreshToken === 'string') return data;
    } catch { /* 无凭据或损坏均视为未连接 */ }
    return null;
  }

  private write(subject: string, credentials: CodexCredentials) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(subject);
    const temp = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(credentials), { mode: 0o600 });
    fs.renameSync(temp, target);
  }

  isConnected(subject: string | undefined | null): boolean {
    return Boolean(this.enabled && subject && this.read(subject));
  }

  status(subject: string): CodexConnectionStatus {
    const credentials = this.enabled ? this.read(subject) : null;
    return {
      provider: 'chatgpt',
      enabled: this.enabled,
      connected: Boolean(credentials),
      email: credentials?.email ?? null,
      plan: credentials?.plan ?? null,
      model: this.model,
      reasoning: this.reasoning,
      connectedAt: credentials?.connectedAt ?? null,
    };
  }

  disconnect(subject: string) {
    for (const session of [...this.logins.values()]) if (session.subject === subject) this.cancel(session);
    try { fs.rmSync(this.file(subject), { force: true }); } catch { /* ignore */ }
    return this.status(subject);
  }

  private cancel(session: LoginSession) {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (session.state === 'pending') session.state = 'cancelled';
    this.logins.delete(session.id);
  }

  private view(session: LoginSession): CodexLoginView {
    if (session.state === 'pending' && this.now() > session.expiresAt) {
      if (session.timer) clearTimeout(session.timer);
      session.state = 'expired';
      session.message = '验证码已过期，请重新发起连接';
    }
    return {
      loginId: session.id,
      state: session.state,
      userCode: session.userCode,
      verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
      expiresAt: new Date(session.expiresAt).toISOString(),
      message: session.message,
    };
  }

  private requireEnabled() {
    if (!this.enabled) throw new CodexSubscriptionError('AI_SUBSCRIPTION_DISABLED', '服务器未启用 ChatGPT 订阅连接，请联系管理员', 409);
  }

  async startLogin(subject: string): Promise<CodexLoginView> {
    this.requireEnabled();
    for (const session of [...this.logins.values()]) {
      if (session.subject === subject) this.cancel(session);
      else if (this.now() > session.expiresAt + LOGIN_TTL_MS) this.logins.delete(session.id);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(DEVICE_USER_CODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': this.userAgent() },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      });
    } catch {
      throw new CodexSubscriptionError('AI_SUBSCRIPTION_LOGIN_FAILED', '无法连接 OpenAI 登录服务，请稍后重试');
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof data?.device_auth_id !== 'string' || typeof data?.user_code !== 'string' || !data.device_auth_id.trim() || !data.user_code.trim()) {
      throw new CodexSubscriptionError('AI_SUBSCRIPTION_LOGIN_FAILED', res.status === 404 || res.status === 403
        ? 'OpenAI 暂不允许此账号使用设备码登录，请在 ChatGPT 安全设置中启用 Codex 设备码授权后重试'
        : '发起 ChatGPT 登录失败，请稍后重试');
    }
    const session: LoginSession = {
      id: randomUUID(),
      subject: subject,
      deviceAuthId: data.device_auth_id,
      userCode: data.user_code,
      intervalMs: pollInterval(data.interval) + POLL_SAFETY_MARGIN_MS,
      expiresAt: this.now() + LOGIN_TTL_MS,
      state: 'pending',
      message: null,
      timer: null,
    };
    this.logins.set(session.id, session);
    session.timer = this.schedule(() => void this.poll(session), session.intervalMs);
    return this.view(session);
  }

  getLogin(subject: string, loginId: string): CodexLoginView {
    const session = this.logins.get(loginId);
    if (!session || session.subject !== subject) throw new CodexSubscriptionError('AI_SUBSCRIPTION_LOGIN_NOT_FOUND', '登录会话不存在或已结束，请重新发起连接', 404);
    return this.view(session);
  }

  /** 单次轮询；测试可直接调用。 */
  async poll(session: LoginSession): Promise<void> {
    session.timer = null;
    if (session.state !== 'pending' || !this.logins.has(session.id)) return;
    if (this.now() > session.expiresAt) { this.view(session); return; }
    try {
      const res = await this.fetchImpl(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': this.userAgent() },
        body: JSON.stringify({ device_auth_id: session.deviceAuthId, user_code: session.userCode }),
      });
      if (res.status === 403 || res.status === 404) {
        if (session.state === 'pending') session.timer = this.schedule(() => void this.poll(session), session.intervalMs);
        return;
      }
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || typeof data?.authorization_code !== 'string' || typeof data?.code_verifier !== 'string') throw new Error('device token rejected');
      const credentials = await this.exchange(data.authorization_code, data.code_verifier);
      if (session.state !== 'pending') return;
      this.write(session.subject, credentials);
      session.state = 'connected';
      session.message = null;
    } catch {
      if (session.state !== 'pending') return;
      session.state = 'failed';
      session.message = 'ChatGPT 授权未完成，请重新发起连接';
    }
  }

  private async tokenRequest(form: Record<string, string>) {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': this.userAgent() },
      body: new URLSearchParams(form).toString(),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof data?.access_token !== 'string' || !data.access_token) {
      throw new CodexSubscriptionError('AI_SUBSCRIPTION_TOKEN_FAILED', 'ChatGPT 授权已失效，请重新连接', res.status === 400 || res.status === 401 ? 401 : 502);
    }
    return data as { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number };
  }

  private toCredentials(tokens: { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number }, previous?: CodexCredentials): CodexCredentials {
    const refreshToken = tokens.refresh_token || previous?.refreshToken || '';
    const accountId = accountIdFrom(tokens.id_token, tokens.access_token) || previous?.accountId || '';
    if (!refreshToken || !accountId) throw new CodexSubscriptionError('AI_SUBSCRIPTION_TOKEN_FAILED', 'ChatGPT 授权缺少账号信息，请确认登录的是 ChatGPT 订阅账号', 502);
    const expiresAt = effectiveExpiry(tokens.access_token, this.now() + (Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : 3600) * 1000);
    return {
      version: 1,
      provider: 'codex',
      accessToken: tokens.access_token,
      refreshToken,
      accountId,
      email: claimString('email', tokens.id_token) ?? previous?.email ?? null,
      plan: claimString('chatgpt_plan_type', tokens.id_token, tokens.access_token) ?? previous?.plan ?? null,
      residency: claimString('chatgpt_compute_residency', tokens.id_token, tokens.access_token) ?? previous?.residency ?? null,
      expiresAt,
      connectedAt: previous?.connectedAt ?? new Date(this.now()).toISOString(),
    };
  }

  private async exchange(code: string, verifier: string) {
    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: DEVICE_REDIRECT_URI,
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    });
    return this.toCredentials(tokens);
  }

  private async fresh(subject: string, force = false): Promise<CodexCredentials> {
    const current = this.read(subject);
    if (!current) throw new CodexSubscriptionError('AI_SUBSCRIPTION_NOT_CONNECTED', '尚未连接 ChatGPT 订阅', 409);
    if (!force && current.expiresAt > this.now() + REFRESH_LEEWAY_MS) return current;
    const pending = this.refreshing.get(subject);
    if (pending) return pending;
    const job = (async () => {
      const tokens = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: CODEX_CLIENT_ID });
      const next = this.toCredentials(tokens, current);
      this.write(subject, next);
      return next;
    })().finally(() => this.refreshing.delete(subject));
    this.refreshing.set(subject, job);
    return job;
  }

  private buildBody(input: LlmCompletionInput, reasoning: CodexReasoningEffort) {
    const conversation = input.messages.filter(m => m.role !== 'system');
    const extraSystem = input.messages.filter(m => m.role === 'system').map(m => m.content);
    return {
      model: this.model,
      instructions: [input.systemPrompt, ...extraSystem].filter(Boolean).join('\n\n'),
      input: conversation.map(m => ({
        type: 'message',
        role: m.role,
        content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
      })),
      stream: true,
      store: false,
      reasoning: { effort: reasoning, summary: 'auto' },
      include: [],
    };
  }

  async complete(subject: string, input: LlmCompletionInput, options: { reasoning?: CodexReasoningEffort } = {}): Promise<string> {
    this.requireEnabled();
    const reasoning = options.reasoning ?? this.reasoning;
    let credentials = await this.fresh(subject);
    let res = await this.send(credentials, input, reasoning);
    if (res.status === 401) {
      credentials = await this.fresh(subject, true);
      res = await this.send(credentials, input, reasoning);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401) throw new CodexSubscriptionError('AI_SUBSCRIPTION_TOKEN_FAILED', 'ChatGPT 授权已失效，请重新连接', 401);
      if (res.status === 429 || /usage_limit|rate_limit/i.test(body)) throw new CodexSubscriptionError('AI_SUBSCRIPTION_LIMITED', 'ChatGPT 订阅用量已达上限，请稍后再试', 429);
      if (/model/i.test(body) && /(not supported|not found|does not exist|unsupported)/i.test(body)) throw new Error(`model_not_supported: ChatGPT 订阅不支持模型 ${this.model}`);
      throw new CodexSubscriptionError('AI_SUBSCRIPTION_REQUEST_FAILED', `ChatGPT 订阅模型请求失败（HTTP ${res.status}）`);
    }
    const text = (await this.readStream(res, input)).trim();
    if (!text) throw new CodexSubscriptionError('AI_SUBSCRIPTION_EMPTY', 'ChatGPT 订阅模型没有返回内容');
    return input.jsonMode ? stripJsonFence(text) : text;
  }

  private send(credentials: CodexCredentials, input: LlmCompletionInput, reasoning: CodexReasoningEffort) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${credentials.accessToken}`,
      'ChatGPT-Account-ID': credentials.accountId,
      originator: this.originator,
      'User-Agent': this.userAgent(),
    };
    if (credentials.residency && credentials.residency !== 'no_constraint') headers['x-openai-internal-codex-residency'] = credentials.residency;
    return this.fetchImpl(RESPONSES_URL, { method: 'POST', signal: input.signal, headers, body: JSON.stringify(this.buildBody(input, reasoning)) });
  }

  private async readStream(res: Response, input: LlmCompletionInput): Promise<string> {
    if (!res.body) throw new CodexSubscriptionError('AI_SUBSCRIPTION_EMPTY', 'ChatGPT 订阅模型没有返回内容');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let completedText = '';
    const handle = (raw: string) => {
      const dataLines = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
      if (!dataLines.length) return;
      const payload = dataLines.join('\n');
      if (!payload || payload === '[DONE]') return;
      let event: any;
      try { event = JSON.parse(payload); } catch { return; }
      switch (event?.type) {
        case 'response.output_text.delta':
          if (typeof event.delta === 'string' && event.delta) { text += event.delta; input.onDelta?.(event.delta); }
          break;
        case 'response.completed':
        case 'response.done': {
          const output = Array.isArray(event.response?.output) ? event.response.output : [];
          completedText = output
            .filter((item: any) => item?.type === 'message')
            .flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
            .filter((c: any) => c?.type === 'output_text' && typeof c.text === 'string')
            .map((c: any) => c.text)
            .join('');
          break;
        }
        case 'response.failed':
        case 'response.incomplete':
        case 'error': {
          const message = String(event.response?.error?.message || event.error?.message || event.message || event.response?.incomplete_details?.reason || '');
          if (/usage_limit|rate_limit/i.test(message + JSON.stringify(event.response?.error ?? event.error ?? {}))) throw new CodexSubscriptionError('AI_SUBSCRIPTION_LIMITED', 'ChatGPT 订阅用量已达上限，请稍后再试', 429);
          throw new CodexSubscriptionError('AI_SUBSCRIPTION_REQUEST_FAILED', 'ChatGPT 订阅模型返回失败');
        }
        default:
          break;
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          handle(raw);
        }
      }
      if (buffer.trim()) handle(buffer);
    } finally {
      reader.releaseLock();
    }
    return text || completedText;
  }
}

/**
 * 凭据主体：
 *   - 平台 AI（报价审阅、汇总、对账、业务问答等固定流程）共用一个平台连接，由管理员连接；
 *     测试期为管理员个人 ChatGPT 订阅，生产期改为企业 API。
 *   - 个人连接只供后续"工作助手"（本机 Agent）使用，不被平台 AI 调用。
 */
export const PLATFORM_SUBJECT = 'platform';
export const personalSubject = (userId: string) => `user:${userId}`;

let shared: CodexSubscriptionService | null = null;
export function codexSubscriptions(): CodexSubscriptionService {
  shared ??= new CodexSubscriptionService();
  return shared;
}
/** 测试用：替换共享实例。 */
export function setCodexSubscriptionsForTest(service: CodexSubscriptionService | null) {
  shared = service;
}
