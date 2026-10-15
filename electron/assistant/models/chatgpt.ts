/**
 * 本人 ChatGPT 账号登录（设备码）—— 协议参考 OpenBitFun（MIT）subscription_auth/codex.rs，
 * 与服务端平台连接同源，但凭据只存本机加密存储，不经过 Bambook 后端。
 */
import { randomUUID } from 'node:crypto';
import { AssistantError, type FetchLike, type SecretStore } from '../types';
import { CHATGPT_SECRET } from '../providers';
import type { HttpTarget } from './openai';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const USER_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
export const CHATGPT_VERIFICATION_URL = `${ISSUER}/codex/device`;
const REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
export const CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0';
const LOGIN_TTL_MS = 15 * 60 * 1000;
const REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const POLL_MARGIN_MS = 3000;

type Credentials = {
  version: 1; accessToken: string; refreshToken: string; accountId: string;
  email: string | null; plan: string | null; residency: string | null; expiresAt: number; connectedAt: string;
};

export type ChatgptLoginState = 'pending' | 'connected' | 'failed' | 'expired' | 'cancelled';
export type ChatgptLoginView = { loginId: string; state: ChatgptLoginState; userCode: string; verificationUrl: string; expiresAt: string; message: string | null };
export type ChatgptStatus = { connected: boolean; email: string | null; plan: string | null; connectedAt: string | null };

type Login = { id: string; deviceAuthId: string; userCode: string; intervalMs: number; expiresAt: number; state: ChatgptLoginState; message: string | null; timer: ReturnType<typeof setTimeout> | null };

function claims(token?: string | null): Record<string, any> {
  const part = token?.split('.')[1];
  if (!part) return {};
  try { return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) ?? {}; } catch { return {}; }
}
const auth = (c: Record<string, any>) => (c['https://api.openai.com/auth'] && typeof c['https://api.openai.com/auth'] === 'object' ? c['https://api.openai.com/auth'] : {});
function claimString(key: string, ...tokens: Array<string | undefined>): string | null {
  for (const t of tokens) { const c = claims(t); const v = c[key] ?? auth(c)[key]; if (typeof v === 'string' && v.trim()) return v.trim(); }
  return null;
}
function accountId(...tokens: Array<string | undefined>): string {
  for (const t of tokens) { const c = claims(t); const id = c.chatgpt_account_id || auth(c).chatgpt_account_id || c.organizations?.[0]?.id; if (typeof id === 'string' && id.trim()) return id.trim(); }
  return '';
}

export type ChatgptAuthOptions = { fetch: FetchLike; now?: () => number; schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; originator?: string };

export class ChatgptAuth {
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly logins = new Map<string, Login>();
  private refreshing: Promise<Credentials> | null = null;

  constructor(private readonly secrets: SecretStore, private readonly options: ChatgptAuthOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as any).unref?.(); return t; });
  }

  private userAgent() { return `Bambook-Assistant/1.0 (${process.platform}; ${process.arch})`; }

  private async read(): Promise<Credentials | null> {
    const raw = await this.secrets.get(CHATGPT_SECRET);
    if (!raw) return null;
    try { const c = JSON.parse(raw); return c?.version === 1 && typeof c.accessToken === 'string' && typeof c.refreshToken === 'string' ? c : null; } catch { return null; }
  }

  async status(): Promise<ChatgptStatus> {
    const c = await this.read();
    return { connected: Boolean(c), email: c?.email ?? null, plan: c?.plan ?? null, connectedAt: c?.connectedAt ?? null };
  }

  async logout(): Promise<ChatgptStatus> {
    for (const login of this.logins.values()) this.cancel(login);
    await this.secrets.delete(CHATGPT_SECRET);
    return this.status();
  }

  cancelAll() { for (const login of this.logins.values()) this.cancel(login); }

  private cancel(login: Login) {
    if (login.timer) clearTimeout(login.timer);
    login.timer = null;
    if (login.state === 'pending') login.state = 'cancelled';
    this.logins.delete(login.id);
  }

  private view(login: Login): ChatgptLoginView {
    if (login.state === 'pending' && this.now() > login.expiresAt) {
      if (login.timer) clearTimeout(login.timer);
      login.state = 'expired';
      login.message = '验证码已过期，请重新登录';
    }
    return { loginId: login.id, state: login.state, userCode: login.userCode, verificationUrl: CHATGPT_VERIFICATION_URL, expiresAt: new Date(login.expiresAt).toISOString(), message: login.message };
  }

  async startLogin(): Promise<ChatgptLoginView> {
    this.cancelAll();
    let res: Response;
    try {
      res = await this.options.fetch(USER_CODE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': this.userAgent() }, body: JSON.stringify({ client_id: CLIENT_ID }) });
    } catch { throw new AssistantError('CHATGPT_LOGIN_FAILED', '无法连接 OpenAI 登录服务，请检查网络后重试'); }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof data?.device_auth_id !== 'string' || typeof data?.user_code !== 'string' || !data.device_auth_id || !data.user_code) {
      throw new AssistantError('CHATGPT_LOGIN_FAILED', res.status === 403 || res.status === 404
        ? 'OpenAI 暂不允许此账号使用设备码登录，请在 ChatGPT 安全设置中启用 Codex 设备码授权后重试'
        : '发起 ChatGPT 登录失败，请稍后重试');
    }
    const n = Number.parseInt(String(data.interval ?? '5'), 10);
    const login: Login = { id: randomUUID(), deviceAuthId: data.device_auth_id, userCode: data.user_code, intervalMs: (Number.isFinite(n) && n > 0 ? n : 5) * 1000 + POLL_MARGIN_MS, expiresAt: this.now() + LOGIN_TTL_MS, state: 'pending', message: null, timer: null };
    this.logins.set(login.id, login);
    login.timer = this.schedule(() => void this.poll(login.id), login.intervalMs);
    return this.view(login);
  }

  getLogin(loginId: string): ChatgptLoginView {
    const login = this.logins.get(loginId);
    if (!login) throw new AssistantError('CHATGPT_LOGIN_NOT_FOUND', '登录会话已结束，请重新登录');
    return this.view(login);
  }

  /** 单次轮询；测试可直接调用。 */
  async poll(loginId: string): Promise<void> {
    const login = this.logins.get(loginId);
    if (!login || login.state !== 'pending') return;
    login.timer = null;
    if (this.now() > login.expiresAt) { this.view(login); return; }
    try {
      const res = await this.options.fetch(DEVICE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': this.userAgent() }, body: JSON.stringify({ device_auth_id: login.deviceAuthId, user_code: login.userCode }) });
      if (res.status === 403 || res.status === 404) {
        if (login.state === 'pending' && this.logins.has(login.id)) login.timer = this.schedule(() => void this.poll(login.id), login.intervalMs);
        return;
      }
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || typeof data?.authorization_code !== 'string' || typeof data?.code_verifier !== 'string') throw new Error('rejected');
      const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code: data.authorization_code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: data.code_verifier });
      const credentials = this.toCredentials(tokens);
      if (login.state !== 'pending') return;
      await this.secrets.set(CHATGPT_SECRET, JSON.stringify(credentials));
      login.state = 'connected';
      login.message = null;
    } catch (error) {
      if (login.state !== 'pending') return;
      login.state = 'failed';
      login.message = error instanceof AssistantError && error.code === 'SECRET_STORE_UNAVAILABLE' ? error.message : 'ChatGPT 授权未完成，请重新登录';
    }
  }

  private async tokenRequest(form: Record<string, string>) {
    let res: Response;
    try {
      res = await this.options.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': this.userAgent() }, body: new URLSearchParams(form).toString() });
    } catch { throw new AssistantError('CHATGPT_UNREACHABLE', '无法连接 OpenAI 登录服务，请检查网络'); }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof data?.access_token !== 'string' || !data.access_token) throw new AssistantError('CHATGPT_TOKEN_FAILED', 'ChatGPT 授权已失效，请重新登录');
    return data as { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number };
  }

  private toCredentials(t: { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number }, previous?: Credentials): Credentials {
    const refreshToken = t.refresh_token || previous?.refreshToken || '';
    const account = accountId(t.id_token, t.access_token) || previous?.accountId || '';
    if (!refreshToken || !account) throw new AssistantError('CHATGPT_TOKEN_FAILED', 'ChatGPT 授权缺少账号信息，请确认登录的是 ChatGPT 订阅账号');
    const fallback = this.now() + (Number(t.expires_in) > 0 ? Number(t.expires_in) : 3600) * 1000;
    const exp = Number(claims(t.access_token).exp);
    return {
      version: 1, accessToken: t.access_token, refreshToken, accountId: account,
      email: claimString('email', t.id_token) ?? previous?.email ?? null,
      plan: claimString('chatgpt_plan_type', t.id_token, t.access_token) ?? previous?.plan ?? null,
      residency: claimString('chatgpt_compute_residency', t.id_token, t.access_token) ?? previous?.residency ?? null,
      expiresAt: Number.isFinite(exp) && exp > 0 ? Math.min(exp * 1000, fallback) : fallback,
      connectedAt: previous?.connectedAt ?? new Date(this.now()).toISOString(),
    };
  }

  private async fresh(force = false): Promise<Credentials> {
    const current = await this.read();
    if (!current) throw new AssistantError('CHATGPT_NOT_CONNECTED', '尚未登录 ChatGPT，请在设置中登录');
    if (!force && current.expiresAt > this.now() + REFRESH_LEEWAY_MS) return current;
    this.refreshing ??= (async () => {
      const tokens = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: CLIENT_ID });
      const next = this.toCredentials(tokens, current);
      await this.secrets.set(CHATGPT_SECRET, JSON.stringify(next));
      return next;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private headers(c: Credentials): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${c.accessToken}`, 'ChatGPT-Account-ID': c.accountId, originator: this.options.originator ?? 'bambook', 'User-Agent': this.userAgent() };
    if (c.residency && c.residency !== 'no_constraint') h['x-openai-internal-codex-residency'] = c.residency;
    return h;
  }

  /** Responses 请求目标；401 时调用 refreshTarget 强制刷新一次。 */
  async target(): Promise<HttpTarget> { return { url: CHATGPT_RESPONSES_URL, headers: this.headers(await this.fresh()) }; }
  async refreshTarget(): Promise<HttpTarget> { return { url: CHATGPT_RESPONSES_URL, headers: this.headers(await this.fresh(true)) }; }

  async listModels(): Promise<string[]> {
    const c = await this.fresh();
    let res: Response;
    try { res = await this.options.fetch(MODELS_URL, { headers: this.headers(c) }); } catch { throw new AssistantError('CHATGPT_UNREACHABLE', '无法连接 ChatGPT，请检查网络'); }
    if (!res.ok) throw new AssistantError('CHATGPT_MODELS_FAILED', `读取可用模型失败（HTTP ${res.status}）`);
    const data: any = await res.json().catch(() => ({}));
    const rows: any[] = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : [];
    return [...new Set(rows.map(m => String(m?.slug ?? m?.id ?? '')).filter(Boolean))];
  }
}
