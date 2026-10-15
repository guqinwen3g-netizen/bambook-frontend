import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexSubscriptionService, stripJsonFence, PLATFORM_SUBJECT, personalSubject } from '../ai/codexSubscription';
import { platformReasoning } from '../ai/platformModel';
import { createLlmCompleter } from '../ai/llmProviders';
import { createMistRouter } from './route';
import { getMistAssistantStatus, runMistAssistant } from './assistant';
import { createMistState, type MistWorkspaceEnvelope } from '../shared/mistWorkspace';
import type { TokenPayload } from '../auth/service';

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = (claims: object) => `h.${b64(claims)}.s`;
const ACCESS = jwt({ exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-secret-1', chatgpt_plan_type: 'plus' } });
const ID = jwt({ email: 'tester@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-secret-1' } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (events: object[]) => new Response(events.map(e => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

let dir: string;
let now: number;
let scheduled: Array<() => void>;
let calls: Array<{ url: string; init: RequestInit }>;
let routes: Array<(url: string, init: RequestInit) => Response | undefined>;
const fetchMock = vi.fn(async (url: any, init: any = {}) => {
  calls.push({ url: String(url), init });
  for (const r of routes) { const res = r(String(url), init); if (res) return res; }
  return json({ error: 'unexpected' }, 500);
});
function service(enabled = true) {
  return new CodexSubscriptionService({ dir, fetch: fetchMock as any, now: () => now, enabled, model: 'gpt-test', originator: 'bambook-test', schedule: fn => { scheduled.push(fn); return setTimeout(() => {}, 0); } });
}
function deviceRoutes(tokenStatus: number[] = [403, 200]) {
  const statuses = [...tokenStatus];
  routes.push((url) => url.endsWith('/deviceauth/usercode') ? json({ device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '1' }) : undefined);
  routes.push((url) => {
    if (!url.endsWith('/deviceauth/token')) return undefined;
    const status = statuses.shift() ?? 200;
    return status === 200 ? json({ authorization_code: 'code-1', code_verifier: 'verifier-1' }) : json({}, status);
  });
  routes.push((url, init) => url.endsWith('/oauth/token') && String(init.body).includes('grant_type=authorization_code') ? json({ access_token: ACCESS, refresh_token: 'refresh-secret-1', id_token: ID, expires_in: 3600 }) : undefined);
}
async function connect(s: CodexSubscriptionService, userId = 'owner') {
  const login = await s.startLogin(userId);
  while (scheduled.length) { const fn = scheduled.shift()!; fn(); await new Promise(r => setTimeout(r, 5)); }
  return login;
}
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'ai-sub-')); now = Date.UTC(2026, 9, 13); scheduled = []; calls = []; routes = []; fetchMock.mockClear(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('ChatGPT subscription (Codex) device login', () => {
  it('runs device-code login, stores credentials privately per user and never exposes tokens', async () => {
    deviceRoutes();
    const s = service();
    const login = await connect(s);
    expect(login).toMatchObject({ state: 'pending', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' });
    expect(s.getLogin('owner', login.loginId).state).toBe('connected');
    expect(() => s.getLogin('other', login.loginId)).toThrow(/登录会话不存在/);
    const exchange = calls.find(c => c.url.endsWith('/oauth/token'))!;
    expect(String(exchange.init.body)).toContain('redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback');
    expect(String(exchange.init.body)).toContain('code_verifier=verifier-1');
    const status = s.status('owner');
    expect(status).toMatchObject({ enabled: true, connected: true, email: 'tester@example.test', plan: 'plus', model: 'gpt-test' });
    expect(JSON.stringify(status)).not.toMatch(/secret|refresh|acct/);
    expect(s.status('other').connected).toBe(false);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('owner');
    expect((await stat(path.join(dir, files[0]))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(dir, files[0]), 'utf8')).toContain('refresh-secret-1');
    s.disconnect('owner');
    expect(s.status('owner').connected).toBe(false);
    expect(await readdir(dir)).toHaveLength(0);
  });

  it('expires pending logins and reports disabled servers', async () => {
    deviceRoutes([403, 403, 403]);
    const s = service();
    const login = await s.startLogin('owner');
    now += 16 * 60 * 1000;
    expect(s.getLogin('owner', login.loginId).state).toBe('expired');
    await expect(service(false).startLogin('owner')).rejects.toMatchObject({ code: 'AI_SUBSCRIPTION_DISABLED' });
    expect(service(false).isConnected('owner')).toBe(false);
    vi.stubEnv('BAMBOOK_CODEX_REASONING', 'extreme');
    expect(new CodexSubscriptionService({ dir, enabled: true }).reasoning).toBe('max');
    expect(new CodexSubscriptionService({ dir, enabled: true }).model).toBe('gpt-6-luna');
    vi.stubEnv('BAMBOOK_CODEX_REASONING', 'high');
    expect(new CodexSubscriptionService({ dir, enabled: true }).status('owner')).toMatchObject({ reasoning: 'high', connected: false });
  });

  it('explains when device-code login is not allowed for the account', async () => {
    routes.push(url => url.endsWith('/usercode') ? json({}, 404) : undefined);
    await expect(service().startLogin('owner')).rejects.toThrow(/设备码授权/);
  });
});

describe('ChatGPT subscription completions', () => {
  it('sends Responses requests with account headers, parses SSE deltas and strips JSON fences', async () => {
    deviceRoutes();
    const s = service();
    await connect(s);
    routes.unshift((url) => url.includes('/backend-api/codex/responses') ? sse([
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: '```json\n{"ok":' },
      { type: 'response.output_text.delta', delta: 'true}\n```' },
      { type: 'response.completed', response: { output: [] } },
    ]) : undefined);
    const deltas: string[] = [];
    const text = await s.complete('owner', { systemPrompt: '系统', messages: [{ role: 'user', content: '问' }, { role: 'assistant', content: '答' }], temperature: 0.2, signal: new AbortController().signal, jsonMode: true, onDelta: d => deltas.push(d) });
    expect(text).toBe('{"ok":true}');
    expect(deltas.join('')).toContain('"ok"');
    const req = calls.find(c => c.url.includes('/codex/responses'))!;
    const headers = req.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(headers['ChatGPT-Account-ID']).toBe('acct-secret-1');
    expect(headers.originator).toBe('bambook-test');
    const body = JSON.parse(String(req.init.body));
    expect(body).toMatchObject({ model: 'gpt-test', instructions: '系统', stream: true, store: false });
    expect(body).not.toHaveProperty('temperature');
    expect(body.reasoning).toEqual({ effort: 'max', summary: 'auto' });
    expect(body.input[1].content[0].type).toBe('output_text');
    expect(stripJsonFence('plain')).toBe('plain');
  });

  it('refreshes expiring tokens and falls back to the completed response text', async () => {
    deviceRoutes();
    const s = service();
    await connect(s);
    now += 2 * 3600 * 1000;
    routes.unshift((url, init) => url.endsWith('/oauth/token') && String(init.body).includes('grant_type=refresh_token') ? json({ access_token: ACCESS, id_token: ID, expires_in: 3600 }) : undefined);
    routes.unshift((url) => url.includes('/codex/responses') ? sse([{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }] } }]) : undefined);
    expect(await s.complete('owner', { systemPrompt: 's', messages: [{ role: 'user', content: 'q' }], signal: new AbortController().signal })).toBe('完成');
    const refresh = calls.find(c => String(c.init.body).includes('grant_type=refresh_token'))!;
    expect(String(refresh.init.body)).toContain('refresh_token=refresh-secret-1');
    expect(s.status('owner').connected).toBe(true);
  });

  it('platform AI uses only the platform connection with per-feature reasoning, then falls back to the server API chain', async () => {
    vi.stubEnv('BAMBOOK_LLM_BACKUP_URL', 'https://backup.invalid/v1');
    vi.stubEnv('BAMBOOK_LLM_BACKUP_KEY', 'k');
    for (const k of ['ARK_API_KEY', 'VOLCENGINE_API_KEY', 'TENCENT_API_KEY', 'ZHIPU_API_KEY']) vi.stubEnv(k, '');
    const subscriptions = { isConnected: vi.fn((subject: string) => subject === PLATFORM_SUBJECT), complete: vi.fn(async (..._args: any[]) => '订阅回答') };
    const input = { systemPrompt: 's', messages: [], signal: new AbortController().signal };
    expect(await createLlmCompleter({ platformProfile: 'quote-review', subscriptions })(input)).toBe('订阅回答');
    expect(subscriptions.complete).toHaveBeenLastCalledWith(PLATFORM_SUBJECT, input, { reasoning: 'max' });
    await createLlmCompleter({ platformProfile: 'assistant-chat', subscriptions })(input);
    expect(subscriptions.complete).toHaveBeenLastCalledWith(PLATFORM_SUBJECT, input, { reasoning: 'medium' });
    vi.stubEnv('BAMBOOK_PLATFORM_REASONING_QUOTE_REVIEW', 'high');
    expect(platformReasoning('quote-review')).toBe('high');
    subscriptions.complete.mockRejectedValueOnce(Object.assign(new Error('ChatGPT 订阅用量已达上限'), { code: 'AI_SUBSCRIPTION_LIMITED' }));
    const backup = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ choices: [{ message: { content: '企业回答' } }] }));
    expect(await createLlmCompleter({ platformProfile: 'quote-review', subscriptions })(input)).toBe('企业回答');
    const calls = subscriptions.complete.mock.calls.length;
    expect(await createLlmCompleter({ subscriptions })(input)).toBe('企业回答');
    expect(subscriptions.complete.mock.calls.length).toBe(calls);
    backup.mockRestore();
  });
});

describe('assistant status and HTTP routes', () => {
  const actorFor = (id: string, scopes = ['ai:chat']) => ({ userId: id, roles: [], permissions: scopes, authorizationLoaded: true, departmentIds: [] }) as unknown as TokenPayload;
  it('treats the platform subscription as the configured model for every user', async () => {
    const deps = { providers: () => [], subscription: () => ({ connected: true, model: 'gpt-test' }) };
    expect(getMistAssistantStatus(deps)).toEqual({ configured: true, models: ['平台 ChatGPT 订阅 · gpt-test'], mode: 'read_only', subscription: { provider: 'chatgpt', connected: true } });
    expect(getMistAssistantStatus({ providers: () => [], subscription: () => ({ connected: false, model: 'gpt-test' }) }).configured).toBe(false);
    const state = createMistState({ id: () => 'x', now: '2026-10-13T00:00:00Z', actorName: '测试' }, 'empty');
    const workspace: MistWorkspaceEnvelope = { id: 'w', ownerId: 'owner', name: 'W', revision: 1, state };
    const limited = new Error('LLM_ALL_PROVIDERS_FAILED: ' + JSON.stringify([{ providerId: 'chatgpt-subscription', error: 'AI_SUBSCRIPTION_LIMITED: 用量' }]));
    await expect(runMistAssistant({ workspace, actor: actorFor('owner'), body: { message: 'hi' } }, { ...deps, complete: async () => { throw limited; } })).rejects.toMatchObject({ code: 'MIST_ASSISTANT_SUBSCRIPTION_LIMITED', status: 429 });
  });

  it('lets only administrators connect the shared platform model', async () => {
    deviceRoutes([200]);
    const s = service();
    const app = express(); app.use(express.json());
    app.use('/api/mist', createMistRouter({ repository: {} as any, subscriptions: s, authenticate: (req, _res, next) => { const id = String(req.headers['x-test-user'] || ''); (req as any).actor = { ...actorFor(id), roles: id === 'admin' ? ['owner'] : [] }; next(); } }));
    await request(app).get('/api/mist/ai/platform-model').set('x-test-user', 'sales').expect(403);
    await request(app).post('/api/mist/ai/platform-model/chatgpt/login').set('x-test-user', 'sales').send({}).expect(403);
    const login = (await request(app).post('/api/mist/ai/platform-model/chatgpt/login').set('x-test-user', 'admin').send({}).expect(201)).body.login;
    while (scheduled.length) { scheduled.shift()!(); await new Promise(r => setTimeout(r, 5)); }
    const polled = (await request(app).get(`/api/mist/ai/platform-model/chatgpt/login/${login.loginId}`).set('x-test-user', 'admin').expect(200)).body;
    expect(polled).toMatchObject({ login: { state: 'connected' }, chatgpt: { connected: true }, profiles: expect.arrayContaining([{ id: 'quote-review', label: '报价 AI 审阅', reasoning: 'max' }]) });
    expect(JSON.stringify(polled)).not.toMatch(/secret|verifier|acct/);
    expect(s.isConnected(PLATFORM_SUBJECT)).toBe(true);
    expect(s.isConnected(personalSubject('admin'))).toBe(false);
    expect((await request(app).get('/api/mist/ai/subscriptions').set('x-test-user', 'sales').expect(200)).body.chatgpt.connected).toBe(false);
    expect((await request(app).post('/api/mist/ai/platform-model/chatgpt/disconnect').set('x-test-user', 'admin').send({}).expect(200)).body.chatgpt.connected).toBe(false);
  });

  it('keeps personal connections (for the future work assistant) per signed-in ai:chat user without secrets', async () => {
    deviceRoutes([200]);
    const s = service();
    const app = express(); app.use(express.json());
    app.use('/api/mist', createMistRouter({ repository: {} as any, subscriptions: s, authenticate: (req, _res, next) => { const id = String(req.headers['x-test-user'] || ''); (req as any).actor = actorFor(id, id === 'viewer' ? [] : ['ai:chat']); next(); } }));
    await request(app).get('/api/mist/ai/subscriptions').set('x-test-user', 'viewer').expect(403);
    await request(app).post('/api/mist/ai/subscriptions/chatgpt/login').set('x-test-user', 'owner').send({ userId: 'other' }).expect(400);
    const login = (await request(app).post('/api/mist/ai/subscriptions/chatgpt/login').set('x-test-user', 'owner').send({}).expect(201)).body.login;
    expect(login.userCode).toBe('ABCD-1234');
    while (scheduled.length) { scheduled.shift()!(); await new Promise(r => setTimeout(r, 5)); }
    const polled = await request(app).get(`/api/mist/ai/subscriptions/chatgpt/login/${login.loginId}`).set('x-test-user', 'owner').expect(200);
    expect(polled.body).toMatchObject({ login: { state: 'connected' }, chatgpt: { connected: true } });
    expect(polled.headers['cache-control']).toContain('no-store');
    expect(JSON.stringify(polled.body)).not.toMatch(/secret|verifier|code-1|dev-1/);
    await request(app).get(`/api/mist/ai/subscriptions/chatgpt/login/${login.loginId}`).set('x-test-user', 'intruder').expect(404);
    expect((await request(app).get('/api/mist/ai/subscriptions').set('x-test-user', 'intruder').expect(200)).body.chatgpt.connected).toBe(false);
    expect((await request(app).post('/api/mist/ai/subscriptions/chatgpt/disconnect').set('x-test-user', 'owner').send({}).expect(200)).body.chatgpt.connected).toBe(false);
  });
});
