/** 个人 ChatGPT 订阅连接：设备码登录在用户自己的浏览器完成，令牌只保存在服务器。 */
import React from 'react';
import { ExternalLink, Link2, RefreshCw, Unlink } from 'lucide-react';
import { Banner, Button, Card, CardHeader, KeyValue, Pill, useToast } from '../../../../../components/mist';
import { apiService } from '../../../../../services/apiService';

export type ChatgptSubscriptionStatus = { provider: 'chatgpt'; enabled: boolean; connected: boolean; email: string | null; plan: string | null; model: string; reasoning?: string; connectedAt: string | null };
type LoginView = { loginId: string; state: 'pending' | 'connected' | 'failed' | 'expired' | 'cancelled'; userCode: string; verificationUrl: string; expiresAt: string; message: string | null };

const BASE = '/api/mist/ai/subscriptions';
async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(path, { ...init, headers: { ...apiService.getAuthHeaders(), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> ?? {}) }, credentials: 'include' });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? body?.message ?? '订阅连接请求未完成');
  if (!body) throw new Error('订阅连接没有返回可核对的结果');
  return body;
}
const time = (iso: string | null) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—';
const PLANS: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
const planLabel = (plan: string | null) => plan ? PLANS[plan] ?? plan : '已登录';
const REASONING: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高（max）' };

export function AiSubscriptionPanel({ sessionKey, onChange }: { sessionKey: string; onChange?: () => void }) {
  const [status, setStatus] = React.useState<ChatgptSubscriptionStatus | null>(null);
  const [login, setLogin] = React.useState<LoginView | null>(null);
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const toast = useToast();
  const live = React.useRef(sessionKey); live.current = sessionKey;
  const changed = React.useRef(onChange); changed.current = onChange;
  const read = React.useCallback(async () => {
    const bound = live.current;
    try { const body = await call(BASE); if (bound === live.current) setStatus(body.chatgpt ?? null); }
    catch (e) { if (bound === live.current) { setStatus(null); setError(e instanceof Error ? e.message : '无法读取订阅连接'); } }
  }, []);
  React.useEffect(() => { setStatus(null); setLogin(null); setError(''); void read(); }, [sessionKey, read]);
  React.useEffect(() => {
    if (login?.state !== 'pending') return;
    const bound = live.current;
    const timer = setInterval(async () => {
      try {
        const body = await call(`${BASE}/chatgpt/login/${encodeURIComponent(login.loginId)}`);
        if (bound !== live.current) return;
        setLogin(body.login); setStatus(body.chatgpt ?? null);
        if (body.login?.state === 'connected') { toast('ChatGPT 订阅已连接'); changed.current?.(); }
      } catch (e) { if (bound === live.current) { setLogin(null); setError(e instanceof Error ? e.message : '登录状态读取失败'); } }
    }, 3000);
    return () => clearInterval(timer);
  }, [login?.loginId, login?.state, toast]);
  if (!status?.enabled) return error ? <Banner tone="warn" title="个人订阅连接暂不可用">{error}</Banner> : null;
  const start = async () => {
    const bound = live.current; setBusy(true); setError('');
    try { const body = await call(`${BASE}/chatgpt/login`, { method: 'POST', body: '{}' }); if (bound === live.current) setLogin(body.login); }
    catch (e) { if (bound === live.current) setError(e instanceof Error ? e.message : '发起连接失败'); }
    finally { if (bound === live.current) setBusy(false); }
  };
  const disconnect = async () => {
    const bound = live.current; setBusy(true); setError('');
    try { const body = await call(`${BASE}/chatgpt/disconnect`, { method: 'POST', body: '{}' }); if (bound === live.current) { setStatus(body.chatgpt ?? null); setLogin(null); toast('已断开 ChatGPT 订阅'); changed.current?.(); } }
    catch (e) { if (bound === live.current) setError(e instanceof Error ? e.message : '断开失败'); }
    finally { if (bound === live.current) setBusy(false); }
  };
  const copy = async () => { if (!login) return; try { await navigator.clipboard.writeText(login.userCode); toast('验证码已复制'); } catch { toast('请手动输入验证码'); } };
  const pending = login?.state === 'pending';
  return <Card>
    <CardHeader title="我的 ChatGPT 订阅" sub="用你自己的 ChatGPT 账号为小竹和报价 AI 审阅提供模型；登录在 OpenAI 页面完成，凭据只保存在服务器。" tools={status.connected ? <Pill tone="ok">已连接</Pill> : <Pill>未连接</Pill>} />
    {error && <div className="mist-card-body"><Banner tone="bad" title="订阅连接未完成">{error}</Banner></div>}
    {status.connected ? <>
      <KeyValue items={[{ label: '账号', value: status.email ?? '—' }, { label: '套餐', value: planLabel(status.plan) }, { label: '模型', value: status.model, mono: true }, { label: '推理强度', value: status.reasoning ? REASONING[status.reasoning] ?? status.reasoning : '—' }, { label: '连接时间', value: time(status.connectedAt) }]} />
      <div className="mist-card-body"><div className="mist-row"><Button icon={Unlink} disabled={busy} loading={busy} onClick={() => void disconnect()}>断开连接</Button></div></div>
    </> : pending && login ? <>
      <div className="mist-card-body"><Banner tone="ai" title="在 OpenAI 页面输入验证码">打开验证页并登录你的 ChatGPT 账号，输入下方验证码后此处会自动更新。若提示未开启设备码登录，请在 ChatGPT 设置的安全选项中允许 Codex 设备码授权。</Banner></div>
      <KeyValue items={[{ label: '验证码', value: login.userCode, mono: true }, { label: '验证页', value: login.verificationUrl, mono: true }, { label: '有效期至', value: time(login.expiresAt) }]} />
      <div className="mist-card-body"><div className="mist-row">
        <Button variant="primary" icon={ExternalLink} onClick={() => window.open(login.verificationUrl, '_blank', 'noopener,noreferrer')}>打开验证页</Button>
        <Button onClick={() => void copy()}>复制验证码</Button>
        <span className="mist-note">等待授权…</span>
      </div></div>
    </> : <div className="mist-card-body">
      {login && login.state !== 'connected' && <Banner tone="warn" title={login.state === 'expired' ? '验证码已过期' : '授权未完成'}>{login.message ?? '请重新发起连接'}</Banner>}
      <p className="mist-note">测试期使用你本人的订阅额度。正式使用时每位同事连接自己的订阅，或由管理员配置企业 API；请勿共享个人账号。</p>
      <div className="mist-row">
        <Button variant="ai" icon={login ? RefreshCw : Link2} disabled={busy} loading={busy} onClick={() => void start()}>{login ? '重新连接' : '连接我的 ChatGPT 账号'}</Button>
      </div>
    </div>}
  </Card>;
}
