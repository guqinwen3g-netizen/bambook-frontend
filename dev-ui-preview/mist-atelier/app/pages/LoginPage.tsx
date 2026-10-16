/**
 * T12 登录模板 —— 对应：Login.tsx / Register.tsx。左侧品牌（雾蓝 shell + 标志），右侧画布表单。
 */
import React from 'react';
import { ArrowRight, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import { Button, Checkbox, Field, MistMark, MistWordmark, TextInput, TextLink, useToast } from '../../../../components/mist';
import { useNav } from '../nav';
import { useMistSession } from '../runtime/auth';
import { mapAuthErrorMessage } from '../../../../services/authService';

export function LoginPage() {
  const { go } = useNav();
  const toast = useToast();
  const session = useMistSession();
  const [email, setEmail] = React.useState('');
  const [pw, setPw] = React.useState('');
  const [remember, setRemember] = React.useState(true);
  const busy = session.signingIn;
  const [cooldown, setCooldown] = React.useState(0);
  const cooldownTimer = React.useRef<number | undefined>(undefined);
  const mounted = React.useRef(true);
  const submitting = React.useRef(false);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; window.clearInterval(cooldownTimer.current); }; }, []);
  const [err, setErr] = React.useState('');
  // 两步验证第二步：密码通过后服务器给的 5 分钟凭据；有值时显示动态码表单。
  const [mfaToken, setMfaToken] = React.useState<string | null>(null);
  const [code, setCode] = React.useState('');
  const backToPassword = () => { setMfaToken(null); setCode(''); setErr(''); session.clearError(); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current || busy || cooldown > 0 || session.status === 'loading') return;
    if (mfaToken) {
      if (!code.trim()) { setErr('请输入验证器上的 6 位动态码或恢复码'); return; }
    } else {
      if (!email.trim()) { setErr('请输入工作邮箱'); return; }
      if (!pw) { setErr('请输入密码'); return; }
    }
    submitting.current = true; setErr(''); session.clearError();
    try {
      const user = await session.login(email.trim(), pw, mfaToken ? { remember, mfa: { mfaToken, code } } : { remember });
      if (mounted.current) { setPw(''); setCode(''); setMfaToken(null); go('cockpit'); toast(`欢迎回来，${user.displayName || user.email}`); }
    } catch (failure: any) {
      if (!mounted.current) return;
      setPw('');
      if (failure?.code === 'MFA_REQUIRED' && typeof failure.mfaToken === 'string') { setMfaToken(failure.mfaToken); setCode(''); setErr(''); return; }
      if (failure?.code === 'MFA_EXPIRED') { setMfaToken(null); setCode(''); }
      if (mfaToken) setCode('');
      setErr(mapAuthErrorMessage(failure, '登录失败，请稍后重试'));
      if (typeof failure?.retryAfterMs === 'number' && failure.retryAfterMs > 0) {
        setCooldown(Math.max(1, Math.ceil(failure.retryAfterMs / 1000)));
        window.clearInterval(cooldownTimer.current);
        cooldownTimer.current = window.setInterval(() => setCooldown(value => {
          if (value <= 1) { window.clearInterval(cooldownTimer.current); return 0; }
          return value - 1;
        }), 1000);
      }
    } finally { submitting.current = false; }
  };
  const shownError = err || session.error;
  const errorNode = shownError ? <span id="mist-login-error" role="alert">{shownError}</span> : undefined;
  return (
    <div className="mist-auth">
      <div className="mist-auth-brand">
        <MistMark className="mist-hero-ring" />
        <div className="mist-brand" style={{ padding: 0 }}><MistMark /><MistWordmark /></div>
        <div style={{ marginTop: 'auto', maxWidth: 440 }}>
          <h1 className="mist-h1" style={{ fontSize: 44, color: 'var(--mist-on-media)' }}>从开发到收款，<br />每一步都看得清。</h1>
          <p style={{ marginTop: 14, color: 'rgba(255,255,255,.84)', fontSize: 15 }}>Bambook 竹衍 · 成衣外贸企业工作台</p>
        </div>
      </div>
      <div className="mist-auth-panel">
        <form className="mist-auth-form" aria-label="登录" onSubmit={submit}>
          {mfaToken ? (<>
            <div><h2 className="mist-h1" style={{ fontSize: 28 }}>两步验证</h2><p className="mist-sub" style={{ marginTop: 6 }}>打开手机上的验证器应用，输入 Bambook 当前显示的 6 位动态码。手机不在身边时可输入一个恢复码。</p></div>
            <Field label="动态码或恢复码" error={errorNode}><TextInput icon={ShieldCheck} autoComplete="one-time-code" inputMode="text" autoFocus value={code} onChange={e => setCode(e.target.value)} placeholder="6 位数字或 xxxxx-xxxxx" disabled={busy} aria-invalid={!!shownError} aria-describedby={shownError ? 'mist-login-error' : undefined} /></Field>
            <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={busy || cooldown > 0 || session.status === 'loading'} iconRight={busy ? undefined : ArrowRight}>{cooldown > 0 ? `请稍候 ${cooldown}s` : '验证并登录'}</Button>
            <div className="mist-row"><TextLink onClick={backToPassword} disabled={busy}>返回重新输入密码</TextLink></div>
          </>) : (<>
          <div><h2 className="mist-h1" style={{ fontSize: 28 }}>登录</h2><p className="mist-sub" style={{ marginTop: 6 }}>使用工作邮箱登录你的工作空间</p></div>
          <Field label="工作邮箱"><TextInput icon={Mail} type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} disabled={busy} required /></Field>
          <Field label="密码" error={errorNode}><TextInput icon={KeyRound} type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} placeholder="输入密码" disabled={busy} aria-invalid={!!(err || session.error)} aria-describedby={err || session.error ? "mist-login-error" : undefined} /></Field>
          <div className="mist-row"><Checkbox checked={remember} onChange={setRemember} disabled={busy} label="保持登录" /><span className="mist-spacer" /><TextLink disabled title="密码重置暂未接入，请联系账号管理员">忘记密码？</TextLink></div>
          <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={busy || cooldown > 0 || session.status === 'loading'} iconRight={busy ? undefined : ArrowRight}>{cooldown > 0 ? `请稍候 ${cooldown}s` : '登录'}</Button>
          <p className="mist-muted" style={{ fontSize: 12, textAlign: 'center' }} role="status" aria-live="polite">使用已开通的账号登录工作空间</p>
          </>)}
        </form>
      </div>
    </div>
  );
}
