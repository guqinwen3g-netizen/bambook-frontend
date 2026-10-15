/**
 * 工作助手（本机 Agent）页面：会话列表 + 对话 + 本人模型设置。
 * 只在 Bambook 桌面端可用；模型调用、凭据与会话都在本机 assistant-host 里，页面只拿结果与事件。
 */
import React from 'react';
import { ExternalLink, KeyRound, LogIn, MessageSquarePlus, RefreshCw, Settings2, Square, Trash2 } from 'lucide-react';
import { Banner, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, FormGrid, KeyValue, MistPage, Mono, PageHeader, Pill, Select, TextArea, TextInput } from '../../../../../components/mist';
import { useMistSession } from '../../runtime/auth';

// ── 桥接层 ─────────────────────────────────────────────────────────

type BridgeResult = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
export type AssistantBridge = { request(method: string, params?: unknown): Promise<BridgeResult>; onEvent(cb: (event: any) => void): () => void };
export class AssistantCallError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export function getAssistantBridge(): AssistantBridge | null {
  const candidate = typeof window !== 'undefined' ? (window as unknown as { bambookAssistant?: AssistantBridge }).bambookAssistant : undefined;
  return candidate && typeof candidate.request === 'function' && typeof candidate.onEvent === 'function' ? candidate : null;
}

async function call<T>(bridge: AssistantBridge, method: string, params?: unknown): Promise<T> {
  const response = await bridge.request(method, params);
  if (!response || typeof response !== 'object') throw new AssistantCallError('INVALID', '工作助手没有返回可核对的结果');
  if (!response.ok) throw new AssistantCallError(response.error?.code ?? 'ERROR', response.error?.message ?? '工作助手请求未完成');
  return response.result as T;
}

// ── 类型 ───────────────────────────────────────────────────────────

type Format = 'openai' | 'openai-responses' | 'chatgpt-subscription';
type Provider = { id: string; name: string; format: Format; base_url: string; request_url?: string; model: string; context_window: number; max_tokens: number; temperature?: number; top_p?: number; reasoning?: string; custom_headers?: Record<string, string>; custom_request_body?: Record<string, unknown>; skip_ssl_verify?: boolean; has_api_key: boolean };
type SessionMeta = { id: string; title: string; providerId: string | null; createdAt: string; updatedAt: string; messageCount: number };
type ToolCall = { id: string; name: string; arguments: string };
type Message = { role: 'user'; content: string } | { role: 'assistant'; content: string; toolCalls?: ToolCall[] } | { role: 'tool'; toolCallId: string; name: string; content: string };
type ChatgptStatus = { connected: boolean; email: string | null; plan: string | null; connectedAt: string | null };
type LoginView = { loginId: string; state: 'pending' | 'connected' | 'failed' | 'expired' | 'cancelled'; userCode: string; verificationUrl: string; expiresAt: string; message: string | null };
type HostStatus = { state: 'stopped' | 'starting' | 'running' | 'restarting' | 'failed'; reason?: string };
type Confirm = { token: string; runId: string; tool: string; risk: string; summary: string };
type LiveRun = { runId: string; sessionId: string; text: string; tools: Array<{ id: string; name: string; state: 'running' | 'ok' | 'failed'; summary?: string }>; confirms: Confirm[] };

const FORMAT_LABEL: Record<Format, string> = { openai: 'OpenAI 兼容 · Chat Completions', 'openai-responses': 'OpenAI 兼容 · Responses', 'chatgpt-subscription': 'ChatGPT 账号登录' };
const REASONING = [{ value: '', label: '模型默认' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }, { value: 'xhigh', label: '超高' }, { value: 'max', label: '最高（max）' }];
const TOOL_LABEL: Record<string, string> = { current_time: '读取本机时间' };
const RISK_LABEL: Record<string, string> = { write: '修改业务数据', external: '对外发送', local_write: '写入本机文件', draft: '生成草稿', read: '读取' };
const time = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

// ── 设置：模型配置表单 ─────────────────────────────────────────────

type Draft = { id?: string; name: string; format: Format; base_url: string; request_url: string; model: string; context_window: string; max_tokens: string; temperature: string; top_p: string; reasoning: string; headers: string; body: string; skip_ssl_verify: boolean; apiKey: string; clearApiKey: boolean; hasKey: boolean };
const emptyDraft = (format: Format = 'openai'): Draft => ({ name: format === 'chatgpt-subscription' ? '我的 ChatGPT' : '', format, base_url: format === 'chatgpt-subscription' ? '' : 'https://api.openai.com/v1', request_url: '', model: format === 'chatgpt-subscription' ? 'gpt-6-luna' : '', context_window: '', max_tokens: '', temperature: '', top_p: '', reasoning: format === 'chatgpt-subscription' ? 'medium' : '', headers: '', body: '', skip_ssl_verify: false, apiKey: '', clearApiKey: false, hasKey: false });
const toDraft = (p: Provider): Draft => ({ id: p.id, name: p.name, format: p.format, base_url: p.format === 'chatgpt-subscription' ? '' : p.base_url, request_url: p.request_url ?? '', model: p.model, context_window: String(p.context_window), max_tokens: String(p.max_tokens), temperature: p.temperature?.toString() ?? '', top_p: p.top_p?.toString() ?? '', reasoning: p.reasoning ?? '', headers: p.custom_headers ? JSON.stringify(p.custom_headers, null, 2) : '', body: p.custom_request_body ? JSON.stringify(p.custom_request_body, null, 2) : '', skip_ssl_verify: !!p.skip_ssl_verify, apiKey: '', clearApiKey: false, hasKey: p.has_api_key });

function parseJsonObject(text: string, label: string) {
  if (!text.trim()) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${label}不是有效 JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}须为 JSON 对象`);
  return value;
}

function ProviderForm({ bridge, draft, setDraft, onSaved, onCancel, chatgpt, onChatgptChange }: { bridge: AssistantBridge; draft: Draft; setDraft: (d: Draft) => void; onSaved: (rows: Provider[]) => void; onCancel: () => void; chatgpt: ChatgptStatus | null; onChatgptChange: () => void }) {
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [models, setModels] = React.useState<string[]>([]);
  const subscription = draft.format === 'chatgpt-subscription';
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const save = async (): Promise<Provider[] | null> => {
    setBusy(true); setError('');
    try {
      const config = { id: draft.id, name: draft.name, format: draft.format, base_url: draft.base_url, request_url: draft.request_url, model: draft.model, context_window: draft.context_window, max_tokens: draft.max_tokens, temperature: draft.temperature, top_p: draft.top_p, reasoning: draft.reasoning || undefined, custom_headers: parseJsonObject(draft.headers, '自定义请求头'), custom_request_body: parseJsonObject(draft.body, '自定义请求体'), skip_ssl_verify: draft.skip_ssl_verify };
      const rows = await call<Provider[]>(bridge, 'providers.save', { config, apiKey: draft.apiKey || undefined, clearApiKey: draft.clearApiKey });
      return rows;
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); return null; } finally { setBusy(false); }
  };
  const fetchModels = async () => {
    const rows = await save();
    if (!rows) return;
    const saved = draft.id ? rows.find(r => r.id === draft.id) : rows.find(r => r.name === draft.name && r.format === draft.format);
    if (!saved) return;
    setDraft({ ...draft, id: saved.id, apiKey: '', clearApiKey: false, hasKey: saved.has_api_key });
    setBusy(true);
    try { setModels(await call<string[]>(bridge, 'providers.models', { id: saved.id })); } catch (e) { setError(e instanceof Error ? e.message : '读取模型失败'); } finally { setBusy(false); }
  };
  return <>
    {error && <Banner tone="bad" title="配置未保存">{error}</Banner>}
    <FormGrid>
      <Field label="接入方式" full><Select aria-label="接入方式" value={draft.format} disabled={!!draft.id} options={(Object.keys(FORMAT_LABEL) as Format[]).map(f => ({ value: f, label: FORMAT_LABEL[f] }))} onChange={e => setDraft({ ...emptyDraft(e.target.value as Format) })} /></Field>
      <Field label="名称" required><TextInput aria-label="名称" value={draft.name} maxLength={60} onChange={e => set({ name: e.target.value })} /></Field>
      <Field label="模型" required hint={models.length ? `可用 ${models.length} 个模型` : undefined}>{models.length ? <Select aria-label="模型" value={draft.model} options={[...new Set([draft.model, ...models].filter(Boolean))].map(m => ({ value: m, label: m }))} onChange={e => set({ model: e.target.value })} /> : <TextInput aria-label="模型" value={draft.model} onChange={e => set({ model: e.target.value })} />}</Field>
      {!subscription && <>
        <Field label="接口地址" required full hint="例如 https://api.openai.com/v1；本机地址可用 http。"><TextInput aria-label="接口地址" value={draft.base_url} onChange={e => set({ base_url: e.target.value })} /></Field>
        <Field label={draft.hasKey ? 'API Key（已保存，留空不修改）' : 'API Key'} required={!draft.hasKey} full hint="只保存在本机，用系统钥匙串加密；不会上传到 Bambook 服务器。"><TextInput aria-label="API Key" type="password" autoComplete="off" value={draft.apiKey} onChange={e => set({ apiKey: e.target.value, clearApiKey: false })} /></Field>
      </>}
      <Field label="推理档位"><Select aria-label="推理档位" value={draft.reasoning} options={REASONING} onChange={e => set({ reasoning: e.target.value })} /></Field>
      <Field label="上下文窗口（token）"><TextInput aria-label="上下文窗口" inputMode="numeric" placeholder={subscription ? '272000' : '128000'} value={draft.context_window} onChange={e => set({ context_window: e.target.value })} /></Field>
      <Field label="最大输出（token）"><TextInput aria-label="最大输出" inputMode="numeric" placeholder="8192" value={draft.max_tokens} onChange={e => set({ max_tokens: e.target.value })} /></Field>
    </FormGrid>
    {!subscription && <details className="mist-wa-advanced" open={!!(draft.temperature || draft.top_p || draft.request_url || draft.headers || draft.body || draft.skip_ssl_verify)}>
      <summary>高级选项（代理网关、采样参数）</summary>
      <FormGrid>
        <Field label="temperature"><TextInput aria-label="temperature" inputMode="decimal" placeholder="模型默认" value={draft.temperature} onChange={e => set({ temperature: e.target.value })} /></Field>
        <Field label="top_p"><TextInput aria-label="top_p" inputMode="decimal" placeholder="模型默认" value={draft.top_p} onChange={e => set({ top_p: e.target.value })} /></Field>
        <Field label="完整请求地址（可选）" full hint="代理网关要求固定路径时填写，会覆盖接口地址拼接的路径。"><TextInput aria-label="完整请求地址" value={draft.request_url} onChange={e => set({ request_url: e.target.value })} /></Field>
        <Field label="自定义请求头（JSON，可选）" full><TextArea aria-label="自定义请求头" rows={3} value={draft.headers} onChange={e => set({ headers: e.target.value })} /></Field>
        <Field label="自定义请求体（JSON，可选）" full><TextArea aria-label="自定义请求体" rows={3} value={draft.body} onChange={e => set({ body: e.target.value })} /></Field>
        <Field label="证书校验" full><Checkbox checked={draft.skip_ssl_verify} onChange={v => set({ skip_ssl_verify: v })} label="跳过 SSL 证书校验（仅限可信的内网网关）" /></Field>
      </FormGrid>
    </details>}
    {draft.skip_ssl_verify && <Banner tone="warn" title="已关闭证书校验">请求可能被中间人截获，只在公司内网的可信网关上使用。</Banner>}
    {subscription && <ChatgptLogin bridge={bridge} status={chatgpt} onChange={onChatgptChange} />}
    <div className="mist-row">
      <Button variant="primary" loading={busy} disabled={busy || !draft.name.trim() || !draft.model.trim()} onClick={async () => { const rows = await save(); if (rows) onSaved(rows); }}>保存配置</Button>
      <Button disabled={busy || !draft.name.trim() || (!subscription && !draft.hasKey && !draft.apiKey) || (subscription && !chatgpt?.connected)} onClick={() => void fetchModels()}>获取可用模型</Button>
      {draft.hasKey && !draft.apiKey && <Button variant="quiet" disabled={busy} onClick={() => set({ clearApiKey: true, hasKey: false })}>清除已保存的 Key</Button>}
      <Button variant="quiet" disabled={busy} onClick={onCancel}>返回列表</Button>
    </div>
  </>;
}

function ChatgptLogin({ bridge, status, onChange }: { bridge: AssistantBridge; status: ChatgptStatus | null; onChange: () => void }) {
  const [login, setLogin] = React.useState<LoginView | null>(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  React.useEffect(() => {
    if (login?.state !== 'pending') return;
    const timer = setInterval(async () => {
      try { const next = await call<LoginView>(bridge, 'chatgpt.login.get', { loginId: login.loginId }); setLogin(next); if (next.state === 'connected') onChange(); } catch (e) { setError(e instanceof Error ? e.message : '登录状态读取失败'); setLogin(null); }
    }, 3000);
    return () => clearInterval(timer);
  }, [login?.loginId, login?.state, bridge, onChange]);
  const start = async () => { setBusy(true); setError(''); try { const view = await call<LoginView>(bridge, 'chatgpt.login.start'); setLogin(view); window.open(view.verificationUrl, '_blank', 'noopener'); } catch (e) { setError(e instanceof Error ? e.message : '发起登录失败'); } finally { setBusy(false); } };
  const logout = async () => { setBusy(true); setError(''); try { await call(bridge, 'chatgpt.logout'); setLogin(null); onChange(); } catch (e) { setError(e instanceof Error ? e.message : '退出失败'); } finally { setBusy(false); } };
  return <Card>
    <CardHeader title="ChatGPT 账号" sub="用你本人的 ChatGPT 订阅；令牌只保存在这台电脑。" tools={status?.connected ? <Pill tone="ok">已登录</Pill> : <Pill tone="neutral">未登录</Pill>} />
    <div className="mist-card-body">
      {error && <Banner tone="bad" title="登录未完成">{error}</Banner>}
      {status?.connected && <KeyValue items={[{ label: '账号', value: status.email ?? '—' }, { label: '订阅', value: status.plan ?? '—' }, { label: '登录时间', value: status.connectedAt ? time(status.connectedAt) : '—' }]} />}
      {login?.state === 'pending' && <Banner tone="ai" title="在浏览器中完成登录" actions={<Button icon={ExternalLink} onClick={() => window.open(login.verificationUrl, '_blank', 'noopener')}>打开登录页</Button>}>输入验证码 <Mono>{login.userCode}</Mono>，完成后这里会自动更新。验证码 15 分钟内有效。</Banner>}
      {login && login.state !== 'pending' && login.state !== 'connected' && <Banner tone="warn" title="登录没有完成">{login.message ?? '请重新登录'}</Banner>}
      <div className="mist-row">{status?.connected ? <Button disabled={busy} onClick={() => void logout()}>退出 ChatGPT</Button> : <Button variant="primary" icon={LogIn} loading={busy} disabled={busy || login?.state === 'pending'} onClick={() => void start()}>用 ChatGPT 登录</Button>}</div>
    </div>
  </Card>;
}

function SettingsDialog({ open, onClose, bridge, providers, setProviders, chatgpt, refreshChatgpt, initialFormat }: { open: boolean; onClose: () => void; bridge: AssistantBridge; providers: Provider[]; setProviders: (rows: Provider[]) => void; chatgpt: ChatgptStatus | null; refreshChatgpt: () => void; initialFormat: Format | null }) {
  const [draft, setDraft] = React.useState<Draft | null>(null), [error, setError] = React.useState('');
  React.useEffect(() => { if (open) setDraft(initialFormat ? emptyDraft(initialFormat) : null); }, [open, initialFormat]);
  const remove = async (p: Provider) => { setError(''); try { setProviders(await call<Provider[]>(bridge, 'providers.delete', { id: p.id })); } catch (e) { setError(e instanceof Error ? e.message : '删除失败'); } };
  return <Dialog open={open} onClose={onClose} width={720} title={draft ? (draft.id ? '编辑模型配置' : '添加模型配置') : '我的模型'} description="工作助手只使用你本人的模型连接，凭据保存在这台电脑。">
    {draft ? <ProviderForm bridge={bridge} draft={draft} setDraft={setDraft} chatgpt={chatgpt} onChatgptChange={refreshChatgpt} onCancel={() => setDraft(null)} onSaved={rows => { setProviders(rows); setDraft(null); }} /> : <>
      {error && <Banner tone="bad" title="操作未完成">{error}</Banner>}
      {providers.length ? providers.map(p => <Card key={p.id}><CardHeader title={p.name} sub={FORMAT_LABEL[p.format] + ' · ' + p.model} tools={<div className="mist-row"><Pill tone={p.format === 'chatgpt-subscription' ? (chatgpt?.connected ? 'ok' : 'warn') : p.has_api_key ? 'ok' : 'warn'}>{p.format === 'chatgpt-subscription' ? (chatgpt?.connected ? '已登录' : '未登录') : p.has_api_key ? 'Key 已保存' : '缺少 Key'}</Pill><Button size="sm" onClick={() => setDraft(toDraft(p))}>编辑</Button><Button size="sm" variant="quiet" icon={Trash2} aria-label={'删除 ' + p.name} onClick={() => void remove(p)} /></div>} /></Card>) : <EmptyState title="还没有模型配置" description="用你的 ChatGPT 账号登录，或填写你自己的 API。" compact />}
      <div className="mist-row"><Button icon={LogIn} onClick={() => setDraft(emptyDraft('chatgpt-subscription'))}>用 ChatGPT 登录</Button><Button icon={KeyRound} onClick={() => setDraft(emptyDraft('openai'))}>添加 API 配置</Button></div>
    </>}
  </Dialog>;
}

// ── 对话 ───────────────────────────────────────────────────────────

function MessageView({ message }: { message: Message }) {
  if (message.role === 'tool') return null;
  if (message.role === 'user') return <div className="mist-wa-msg" data-role="user"><p>{message.content}</p></div>;
  return <div className="mist-wa-msg" data-role="assistant">
    {message.content && <p>{message.content}</p>}
    {message.toolCalls?.map(c => <span key={c.id} className="mist-note">· {TOOL_LABEL[c.name] ?? c.name}</span>)}
  </div>;
}

export function WorkAssistantPage({ tabs }: { tabs?: React.ReactNode }) {
  const session = useMistSession();
  const bridge = React.useMemo(getAssistantBridge, []);
  const [host, setHost] = React.useState<HostStatus | null>(null);
  const [ready, setReady] = React.useState(false), [error, setError] = React.useState('');
  const [providers, setProviders] = React.useState<Provider[]>([]), [providerId, setProviderId] = React.useState('');
  const [chatgpt, setChatgpt] = React.useState<ChatgptStatus | null>(null);
  const [sessions, setSessions] = React.useState<SessionMeta[]>([]), [activeId, setActiveId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]), [live, setLive] = React.useState<LiveRun | null>(null);
  const [input, setInput] = React.useState(''), [sending, setSending] = React.useState(false);
  const [settings, setSettings] = React.useState<{ open: boolean; format: Format | null }>({ open: false, format: null });
  const activeRef = React.useRef<string | null>(null); activeRef.current = activeId;
  const liveRef = React.useRef<LiveRun | null>(null); liveRef.current = live;
  const accountKey = session.user ? `${typeof location !== 'undefined' ? location.origin : ''}|${session.user.id}` : '';

  const refreshChatgpt = React.useCallback(() => { if (bridge) void call<ChatgptStatus>(bridge, 'chatgpt.status').then(setChatgpt).catch(() => undefined); }, [bridge]);
  const loadSession = React.useCallback(async (id: string) => {
    if (!bridge) return;
    const found = await call<{ meta: SessionMeta; messages: Message[] }>(bridge, 'sessions.get', { id });
    if (activeRef.current === id) setMessages(found.messages);
  }, [bridge]);

  React.useEffect(() => {
    if (!bridge || !accountKey) return;
    let cancelled = false;
    setReady(false); setError(''); setActiveId(null); setMessages([]); setLive(null);
    (async () => {
      try {
        setHost(await call<HostStatus>(bridge, 'host.status'));
        await call(bridge, 'account.select', { accountKey, displayName: session.user?.displayName });
        const [rows, list, gpt] = await Promise.all([call<Provider[]>(bridge, 'providers.list'), call<SessionMeta[]>(bridge, 'sessions.list'), call<ChatgptStatus>(bridge, 'chatgpt.status')]);
        if (cancelled) return;
        setProviders(rows); setSessions(list); setChatgpt(gpt); setProviderId(id => rows.some(r => r.id === id) ? id : rows[0]?.id ?? '');
        setReady(true);
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : '工作助手未就绪'); }
    })();
    return () => { cancelled = true; };
  }, [bridge, accountKey, session.user?.displayName]);

  React.useEffect(() => {
    if (!bridge) return;
    return bridge.onEvent((event: any) => {
      if (event?.type === 'host_status') { setHost(event.status); return; }
      const current = liveRef.current;
      if (!current || event?.runId !== current.runId) return;
      if (event.type === 'run') {
        const e = event.event;
        setLive(run => {
          if (!run || run.runId !== event.runId) return run;
          if (e.type === 'text') return { ...run, text: run.text + e.delta };
          if (e.type === 'step' && e.step > 1) return { ...run, text: '' };
          if (e.type === 'tool_start') return { ...run, tools: [...run.tools, { id: e.call.id, name: e.call.name, state: 'running' }] };
          if (e.type === 'tool_end') return { ...run, tools: run.tools.map(t => t.id === e.callId ? { ...t, state: e.ok ? 'ok' : 'failed', summary: e.summary } : t) };
          return run;
        });
        if (e.type === 'step' && e.step > 1 && activeRef.current === current.sessionId) void loadSession(current.sessionId).catch(() => undefined);
      } else if (event.type === 'confirm_request') {
        setLive(run => run && run.runId === event.runId ? { ...run, confirms: [...run.confirms, { token: event.token, runId: event.runId, tool: event.request.tool, risk: event.request.risk, summary: event.request.summary }] } : run);
      } else if (event.type === 'run_end' || event.type === 'run_error') {
        if (event.type === 'run_error') setError(event.message);
        else if (event.stopReason === 'timeout') setError('任务超过 30 分钟，已停止。可以继续发指令接着做。');
        setLive(null);
        void loadSession(event.sessionId).catch(() => undefined);
        void call<SessionMeta[]>(bridge, 'sessions.list').then(setSessions).catch(() => undefined);
      }
    });
  }, [bridge, loadSession]);

  const open = (id: string | null) => { setActiveId(id); setMessages([]); setError(''); if (id) void loadSession(id).catch(e => setError(e instanceof Error ? e.message : '会话读取失败')); };
  const send = async () => {
    if (!bridge || !input.trim() || sending || live || !providerId) return;
    setSending(true); setError('');
    const text = input.trim();
    try {
      const { runId, sessionId } = await call<{ runId: string; sessionId: string }>(bridge, 'run.start', { providerId, text, sessionId: activeId ?? undefined });
      setInput('');
      setActiveId(sessionId); activeRef.current = sessionId;
      setMessages(items => [...items, { role: 'user', content: text }]);
      setLive({ runId, sessionId, text: '', tools: [], confirms: [] });
      if (!activeId) void call<SessionMeta[]>(bridge, 'sessions.list').then(setSessions).catch(() => undefined);
    } catch (e) { setError(e instanceof Error ? e.message : '发送失败'); } finally { setSending(false); }
  };
  const resolve = async (c: Confirm, approved: boolean) => {
    if (!bridge) return;
    setLive(run => run ? { ...run, confirms: run.confirms.filter(x => x.token !== c.token) } : run);
    try { await call(bridge, 'confirm.resolve', { runId: c.runId, token: c.token, approved }); } catch (e) { setError(e instanceof Error ? e.message : '确认未送达'); }
  };
  const removeSession = async (id: string) => { if (!bridge) return; try { setSessions(await call<SessionMeta[]>(bridge, 'sessions.delete', { id })); if (activeId === id) open(null); } catch (e) { setError(e instanceof Error ? e.message : '删除失败'); } };

  const header = <PageHeader title="工作助手" description="在你的电脑上按指令干活，使用你本人的模型连接。对外发送、确认、删除等操作会先请你确认。" actions={bridge ? <Button icon={Settings2} disabled={!ready} onClick={() => setSettings({ open: true, format: null })}>我的模型</Button> : undefined} />;
  if (!bridge) return <MistPage>{header}{tabs}<Banner tone="warn" title="需在 Bambook 桌面端使用">工作助手运行在你的电脑上，邮件、附件和模型凭据都留在本机，浏览器里无法使用。请在 Bambook 桌面端打开此页。</Banner></MistPage>;
  const provider = providers.find(p => p.id === providerId);
  const providerReady = provider ? (provider.format === 'chatgpt-subscription' ? !!chatgpt?.connected : provider.has_api_key) : false;
  return <MistPage>
    {header}{tabs}
    {host?.state === 'failed' && <Banner tone="bad" title="工作助手已停止" actions={<Button icon={RefreshCw} onClick={() => void call<HostStatus>(bridge, 'host.restart').then(setHost).catch(e => setError(e.message))}>重新启动</Button>}>多次异常退出（{host.reason ?? '未知原因'}），已停止自动重启。</Banner>}
    {host?.state === 'restarting' && <Banner tone="warn" title="工作助手正在重启">{host.reason ?? ''}。进行中的任务已停止，对话已保存。</Banner>}
    {error && <Banner tone="bad" title="未完成">{error}</Banner>}
    {ready && !providers.length ? <Card><div className="mist-card-body"><EmptyState title="先连接你的模型" description="工作助手只用你本人的模型：ChatGPT 账号登录，或你自己的 OpenAI 兼容 API。凭据只保存在这台电脑。" action={<div className="mist-row"><Button variant="primary" icon={LogIn} onClick={() => setSettings({ open: true, format: 'chatgpt-subscription' })}>用 ChatGPT 登录</Button><Button icon={KeyRound} onClick={() => setSettings({ open: true, format: 'openai' })}>添加 API 配置</Button></div>} /></div></Card> :
    <section className="mist-wa">
      <Card className="mist-wa-rail">
        <CardHeader title="对话" tools={<Button size="sm" icon={MessageSquarePlus} disabled={!!live} onClick={() => open(null)}>新对话</Button>} />
        <div className="mist-wa-list">{sessions.map(s => <div key={s.id} className="mist-wa-item" data-active={s.id === activeId || undefined}>
          <button type="button" className="mist-wa-open" disabled={!!live && s.id !== activeId} onClick={() => open(s.id)}><span>{s.title}</span><span className="mist-note">{time(s.updatedAt)}</span></button>
          <Button size="sm" variant="quiet" icon={Trash2} aria-label={'删除对话 ' + s.title} disabled={!!live && live.sessionId === s.id} onClick={() => void removeSession(s.id)} />
        </div>)}{!sessions.length && <p className="mist-note">还没有对话</p>}</div>
      </Card>
      <Card className="mist-wa-main">
        <div className="mist-wa-thread" aria-live="polite">
          {messages.map((m, i) => <MessageView key={i} message={m} />)}
          {live && <div className="mist-wa-msg" data-role="assistant">
            {live.tools.map(t => <span key={t.id} className="mist-note">· {TOOL_LABEL[t.name] ?? t.name}{t.state === 'running' ? ' …' : t.state === 'ok' ? ' · 完成' : ' · ' + (t.summary ?? '未完成')}</span>)}
            {live.text ? <p>{live.text}</p> : !live.confirms.length && <p className="mist-note">正在处理…</p>}
          </div>}
          {live?.confirms.map(c => <Banner key={c.token} tone="warn" title={'需要你确认：' + (RISK_LABEL[c.risk] ?? c.tool)} actions={<><Button variant="primary" onClick={() => void resolve(c, true)}>确认执行</Button><Button onClick={() => void resolve(c, false)}>不执行</Button></>}>{c.summary}</Banner>)}
          {!messages.length && !live && <EmptyState title="告诉助手要做什么" description="例如：帮我把今天的待办整理成清单。业务数据、邮箱和文档能力会陆续开放。" compact />}
        </div>
        <div className="mist-wa-composer">
          <TextArea aria-label="给工作助手的指令" rows={3} maxLength={20000} value={input} disabled={!ready} placeholder="输入指令，Ctrl+Enter 发送" onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
          <div className="mist-row">
            <Select aria-label="使用的模型" value={providerId} options={providers.map(p => ({ value: p.id, label: p.name + ' · ' + p.model }))} onChange={e => setProviderId(e.target.value)} />
            {!providerReady && provider && <span className="mist-note">{provider.format === 'chatgpt-subscription' ? 'ChatGPT 未登录' : '缺少 API Key'}</span>}
            <span className="mist-wa-spacer" />
            {live ? <Button icon={Square} onClick={() => void call(bridge, 'run.cancel', { runId: live.runId }).catch(e => setError(e.message))}>停止</Button> : <Button variant="ai" loading={sending} disabled={!ready || !input.trim() || !providerReady || sending} onClick={() => void send()}>发送</Button>}
          </div>
        </div>
      </Card>
    </section>}
    <SettingsDialog open={settings.open} initialFormat={settings.format} onClose={() => { setSettings({ open: false, format: null }); refreshChatgpt(); }} bridge={bridge} providers={providers} setProviders={rows => { setProviders(rows); setProviderId(id => rows.some(r => r.id === id) ? id : rows[0]?.id ?? ''); }} chatgpt={chatgpt} refreshChatgpt={refreshChatgpt} />
  </MistPage>;
}
