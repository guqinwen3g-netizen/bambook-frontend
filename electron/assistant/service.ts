/**
 * 工作助手服务：与传输无关的请求处理（host.ts 把它接到 utilityProcess 的 parentPort）。
 * 负责账号隔离、提供商配置、ChatGPT 登录、本机会话与运行（并发上限、取消、确认挂起）。
 * 确认挂起用服务端生成的一次性确认号；页面只能对仍在等待的确认号作答，不能凭空放行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AssistantError, type ChatMessage, type FetchLike, type SecretStore } from './types';
import { apiKeySecret, normalizeProvider, type ProviderConfig, type ProviderView } from './providers';
import { ChatgptAuth } from './models/chatgpt';
import { createModelClient, listProviderModels } from './models';
import { ToolRegistry, builtinTools } from './tools';
import { runTurn, type ConfirmRequest, type HarnessEvent } from './harness';
import { SessionStore } from './sessionStore';
import { systemPrompt } from './prompt';

export const MAX_ACTIVE_RUNS = 2;
export const MAX_INPUT_CHARS = 20_000;

export type AssistantEvent =
  | { type: 'run'; runId: string; sessionId: string; event: Exclude<HarnessEvent, { type: 'confirm' }> }
  | { type: 'confirm_request'; runId: string; sessionId: string; token: string; request: Omit<ConfirmRequest, 'arguments'> & { arguments: Record<string, unknown> } }
  | { type: 'run_end'; runId: string; sessionId: string; stopReason: string; text: string }
  | { type: 'run_error'; runId: string; sessionId: string; code: string; message: string };

type Run = { id: string; sessionId: string; controller: AbortController; confirms: Map<string, (approved: boolean) => void> };
type Account = { key: string; displayName: string | null; dir: string; secrets: SecretStore; chatgpt: ChatgptAuth; sessions: SessionStore };

export type ServiceOptions = { rootDir: string; secrets: SecretStore; fetch: FetchLike; emit: (event: AssistantEvent) => void; now?: () => Date; tools?: () => ToolRegistry };

const scopedSecrets = (base: SecretStore, prefix: string): SecretStore => ({
  get: key => base.get(`${prefix}:${key}`),
  set: (key, value) => base.set(`${prefix}:${key}`, value),
  delete: key => base.delete(`${prefix}:${key}`),
});

export class AssistantService {
  private account: Account | null = null;
  private readonly runs = new Map<string, Run>();
  private readonly now: () => Date;

  constructor(private readonly options: ServiceOptions) { this.now = options.now ?? (() => new Date()); }

  private requireAccount(): Account {
    if (!this.account) throw new AssistantError('NO_ACCOUNT', '请先登录 Bambook 账号');
    return this.account;
  }

  private providersFile(a: Account) { return path.join(a.dir, 'providers.json'); }

  private readProviders(a: Account): ProviderConfig[] {
    try {
      const rows = JSON.parse(fs.readFileSync(this.providersFile(a), 'utf8'));
      return Array.isArray(rows) ? rows.flatMap(r => { try { return [normalizeProvider(r)]; } catch { return []; } }) : [];
    } catch { return []; }
  }

  private writeProviders(a: Account, rows: ProviderConfig[]) {
    fs.mkdirSync(a.dir, { recursive: true, mode: 0o700 });
    const target = this.providersFile(a);
    const temp = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(rows, null, 2), { mode: 0o600 });
    fs.renameSync(temp, target);
  }

  private async views(a: Account): Promise<ProviderView[]> {
    return Promise.all(this.readProviders(a).map(async p => ({ ...p, has_api_key: p.format === 'chatgpt-subscription' ? false : Boolean(await a.secrets.get(apiKeySecret(p.id))) })));
  }

  private provider(a: Account, id: unknown): ProviderConfig {
    const found = this.readProviders(a).find(p => p.id === id);
    if (!found) throw new AssistantError('PROVIDER_NOT_FOUND', '模型配置不存在，请在设置中重新选择');
    return found;
  }

  private tools() { return this.options.tools?.() ?? new ToolRegistry(builtinTools()); }

  /** 切换账号：取消该进程内所有运行与登录，按账号哈希隔离目录与凭据。 */
  selectAccount(key: unknown, displayName: unknown) {
    const text = typeof key === 'string' ? key.trim() : '';
    if (!text || text.length > 300) throw new AssistantError('NO_ACCOUNT', '账号信息无效');
    const name = typeof displayName === 'string' ? displayName.slice(0, 60) : null;
    const hash = createHash('sha256').update(`bambook-assistant:${text}`).digest('hex').slice(0, 24);
    if (this.account?.key === hash) { this.account.displayName = name; return; }
    this.cancelAll();
    this.account?.chatgpt.cancelAll();
    const dir = path.join(this.options.rootDir, 'accounts', hash);
    const secrets = scopedSecrets(this.options.secrets, hash);
    this.account = { key: hash, displayName: name, dir, secrets, chatgpt: new ChatgptAuth(secrets, { fetch: this.options.fetch }), sessions: new SessionStore(path.join(dir, 'sessions'), this.now) };
  }

  cancelAll() { for (const run of this.runs.values()) run.controller.abort(); }

  async handle(method: string, params: any = {}): Promise<unknown> {
    params = params && typeof params === 'object' ? params : {};
    switch (method) {
      case 'ping': return { ok: true };
      case 'account.select': this.selectAccount(params.accountKey, params.displayName); return this.status();
      case 'status': return this.status();
      case 'providers.list': return this.views(this.requireAccount());
      case 'providers.save': return this.saveProvider(params);
      case 'providers.delete': {
        const a = this.requireAccount();
        const id = String(params.id ?? '');
        this.writeProviders(a, this.readProviders(a).filter(p => p.id !== id));
        await a.secrets.delete(apiKeySecret(id));
        return this.views(a);
      }
      case 'providers.models': {
        const a = this.requireAccount();
        return listProviderModels(this.provider(a, params.id), { secrets: a.secrets, fetch: this.options.fetch, chatgpt: a.chatgpt });
      }
      case 'chatgpt.status': return this.requireAccount().chatgpt.status();
      case 'chatgpt.login.start': return this.requireAccount().chatgpt.startLogin();
      case 'chatgpt.login.get': return this.requireAccount().chatgpt.getLogin(String(params.loginId ?? ''));
      case 'chatgpt.logout': return this.requireAccount().chatgpt.logout();
      case 'sessions.list': return this.requireAccount().sessions.list();
      case 'sessions.get': {
        const found = this.requireAccount().sessions.get(String(params.id ?? ''));
        if (!found) throw new AssistantError('SESSION_NOT_FOUND', '会话不存在或已删除');
        return { ...found, running: [...this.runs.values()].some(r => r.sessionId === found.meta.id) };
      }
      case 'sessions.delete': {
        const a = this.requireAccount();
        const id = String(params.id ?? '');
        for (const run of this.runs.values()) if (run.sessionId === id) run.controller.abort();
        a.sessions.delete(id);
        return a.sessions.list();
      }
      case 'run.start': return this.startRun(params);
      case 'run.cancel': { this.runs.get(String(params.runId ?? ''))?.controller.abort(); return { ok: true }; }
      case 'confirm.resolve': {
        const run = this.runs.get(String(params.runId ?? ''));
        const token = String(params.token ?? '');
        const resolve = run?.confirms.get(token);
        if (!run || !resolve) throw new AssistantError('CONFIRM_NOT_FOUND', '确认请求已失效');
        run.confirms.delete(token);
        resolve(params.approved === true);
        return { ok: true };
      }
      default: throw new AssistantError('UNKNOWN_METHOD', '不支持的请求');
    }
  }

  async status() {
    const a = this.account;
    return {
      account: Boolean(a),
      activeRuns: [...this.runs.values()].map(r => ({ runId: r.id, sessionId: r.sessionId })),
      providers: a ? this.readProviders(a).length : 0,
      chatgpt: a ? await a.chatgpt.status() : null,
    };
  }

  private async saveProvider(params: any) {
    const a = this.requireAccount();
    const config = normalizeProvider({ ...(params.config ?? {}), id: params.config?.id || `p-${randomUUID().slice(0, 8)}` });
    const rows = this.readProviders(a).filter(p => p.id !== config.id);
    if (rows.length >= 20) throw new AssistantError('INVALID_PROVIDER', '最多保存 20 个模型配置');
    const key = typeof params.apiKey === 'string' ? params.apiKey.trim() : '';
    if (key) {
      if (config.format === 'chatgpt-subscription') throw new AssistantError('INVALID_PROVIDER', 'ChatGPT 登录不需要 API Key');
      if (key.length > 500 || /\s/.test(key)) throw new AssistantError('INVALID_PROVIDER', 'API Key 格式无效');
      await a.secrets.set(apiKeySecret(config.id), key);
    } else if (params.clearApiKey === true) {
      await a.secrets.delete(apiKeySecret(config.id));
    }
    this.writeProviders(a, [...rows, config]);
    return this.views(a);
  }

  private async startRun(params: any) {
    const a = this.requireAccount();
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (!text) throw new AssistantError('EMPTY_INPUT', '请输入要助手做的事');
    if (text.length > MAX_INPUT_CHARS) throw new AssistantError('INPUT_TOO_LONG', `单条指令最多 ${MAX_INPUT_CHARS} 字，请拆分后再发`);
    if (this.runs.size >= MAX_ACTIVE_RUNS) throw new AssistantError('TOO_MANY_RUNS', `最多同时进行 ${MAX_ACTIVE_RUNS} 个任务，请等待或取消其中一个`);
    const config = this.provider(a, params.providerId);
    if (config.format === 'chatgpt-subscription') {
      if (!(await a.chatgpt.status()).connected) throw new AssistantError('CHATGPT_NOT_CONNECTED', '尚未登录 ChatGPT，请在设置中登录');
    } else if (!(await a.secrets.get(apiKeySecret(config.id)))) {
      throw new AssistantError('MISSING_API_KEY', '该模型配置还没有填写 API Key');
    }
    let sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    let history: ChatMessage[] = [];
    if (sessionId) {
      if ([...this.runs.values()].some(r => r.sessionId === sessionId)) throw new AssistantError('SESSION_BUSY', '该会话正在运行，请等待或取消');
      const found = a.sessions.get(sessionId);
      if (!found) throw new AssistantError('SESSION_NOT_FOUND', '会话不存在或已删除');
      history = found.messages;
    } else {
      sessionId = a.sessions.create(text.replace(/\s+/g, ' ').slice(0, 30), config.id).id;
    }
    const run: Run = { id: randomUUID(), sessionId, controller: new AbortController(), confirms: new Map() };
    this.runs.set(run.id, run);
    const tools = this.tools();
    const emit = this.options.emit;
    void (async () => {
      try {
        const result = await runTurn({
          client: createModelClient(config, { secrets: a.secrets, fetch: this.options.fetch, chatgpt: a.chatgpt }),
          system: systemPrompt({ displayName: a.displayName, now: this.now(), toolNames: tools.specs().map(t => t.name) }),
          history,
          userText: text,
          tools,
          sessionId,
          limits: { contextWindow: config.context_window, maxOutputTokens: config.max_tokens },
          signal: run.controller.signal,
          onEvent: event => { if (event.type !== 'confirm') emit({ type: 'run', runId: run.id, sessionId, event }); },
          onMessage: message => a.sessions.appendMessage(sessionId, message),
          confirm: request => new Promise<boolean>(resolve => {
            const token = randomUUID();
            run.confirms.set(token, resolve);
            emit({ type: 'confirm_request', runId: run.id, sessionId, token, request });
          }),
          now: this.now,
        });
        emit({ type: 'run_end', runId: run.id, sessionId, stopReason: result.stopReason, text: result.text });
      } catch (error) {
        const code = error instanceof AssistantError ? error.code : 'RUN_FAILED';
        const message = error instanceof AssistantError ? error.message : '助手运行出错，请重试';
        emit({ type: 'run_error', runId: run.id, sessionId, code, message });
      } finally {
        for (const resolve of run.confirms.values()) resolve(false);
        this.runs.delete(run.id);
      }
    })();
    return { runId: run.id, sessionId };
  }
}
