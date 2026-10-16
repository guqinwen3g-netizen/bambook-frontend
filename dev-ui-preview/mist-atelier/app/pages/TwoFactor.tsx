/** 设置 · 安全：两步验证（TOTP 验证器应用）。开启须验证密码并用动态码确认；恢复码只显示一次；关闭须密码 + 动态码。 */
import React from 'react';
import QRCode from 'qrcode';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { Banner, Button, Dialog, Field, FormGrid, Pill, SettingRow, TextInput, useToast } from '../../../../components/mist';
import { disableMfa, enableMfa, getMfaStatus, startMfaSetup, type MfaStatus } from '../../../../services/authService';

function explain(error: unknown, fallback: string) {
  const code = (error as { code?: unknown })?.code;
  if (code === 'INVALID_CREDENTIALS') return '登录密码不正确';
  if (code === 'MFA_INVALID') return '动态码不正确，请核对验证器上当前显示的 6 位数字（注意手机时间要准确）';
  if (code === 'MFA_SETUP_EXPIRED') return '绑定已超过 15 分钟，请重新开始';
  const text = error instanceof Error ? error.message : '';
  return text && !/HTTP|failed/i.test(text) ? text : fallback;
}
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

type Step = { kind: 'password' } | { kind: 'scan'; secret: string; qr: string } | { kind: 'codes'; codes: string[] };

export function TwoFactorRow() {
  const toast = useToast();
  const [status, setStatus] = React.useState<MfaStatus | null>(null), [loadError, setLoadError] = React.useState('');
  const [step, setStep] = React.useState<Step | null>(null), [disabling, setDisabling] = React.useState(false);
  const [password, setPassword] = React.useState(''), [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const load = React.useCallback(() => { setLoadError(''); getMfaStatus().then(setStatus, e => setLoadError(explain(e, '两步验证状态读取失败'))); }, []);
  React.useEffect(load, [load]);
  const clear = () => { setPassword(''); setCode(''); setError(''); };
  const closeSetup = () => { if (busy) return; const finished = step?.kind === 'codes'; setStep(null); clear(); if (finished) load(); };

  const run = async (fn: () => Promise<void>, fallback: string) => {
    if (busy) return; setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(explain(e, fallback)); } finally { setBusy(false); }
  };
  const submitPassword = () => run(async () => {
    if (!password) throw new Error('请填写登录密码');
    const { secret, otpauthUri } = await startMfaSetup(password);
    const svg = await QRCode.toString(otpauthUri, { type: 'svg', margin: 1, width: 180 });
    setPassword(''); setStep({ kind: 'scan', secret, qr: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` });
  }, '未能开始设置，请重试');
  const submitCode = () => run(async () => {
    if (!/^\d{6}$/.test(code.trim())) throw new Error('请输入验证器上的 6 位数字');
    const codes = await enableMfa(code); setCode(''); setStep({ kind: 'codes', codes }); toast('两步验证已开启');
  }, '未能开启，请重试');
  const submitDisable = () => run(async () => {
    if (!password) throw new Error('请填写登录密码');
    if (!code.trim()) throw new Error('请输入动态码或恢复码');
    await disableMfa(password, code); clear(); setDisabling(false); toast('两步验证已关闭'); load();
  }, '未能关闭，请重试');
  const copyCodes = async (codes: string[]) => { try { await navigator.clipboard.writeText(codes.join('\n')); toast('恢复码已复制'); } catch { toast('无法访问剪贴板，请手动抄写'); } };

  const description = loadError || (status?.enabled
    ? `已开启${status.enabledAt ? `（${day(status.enabledAt)}）` : ''}：登录时除密码外还要输入验证器动态码。剩余恢复码 ${status.recoveryRemaining} 个。`
    : '登录时除密码外再输入手机验证器（如 Microsoft Authenticator、Google Authenticator）上的动态码，密码外泄也登录不了。老板和管理员账号强烈建议开启。');
  const control = !status ? <Button size="sm" disabled={!loadError} onClick={load}>{loadError ? '重试' : '读取中…'}</Button>
    : status.enabled ? <div className="mist-row"><Pill tone="ok">已开启</Pill><Button size="sm" icon={ShieldOff} onClick={() => { clear(); setDisabling(true); }}>关闭</Button></div>
    : <Button size="sm" icon={ShieldCheck} onClick={() => { clear(); setStep({ kind: 'password' }); }}>开启两步验证</Button>;

  const setupFooter = step?.kind === 'password' ? <div className="mist-row"><Button variant="primary" loading={busy} onClick={() => void submitPassword()}>下一步</Button><Button disabled={busy} onClick={closeSetup}>取消</Button></div>
    : step?.kind === 'scan' ? <div className="mist-row"><Button variant="primary" loading={busy} onClick={() => void submitCode()}>确认开启</Button><Button disabled={busy} onClick={closeSetup}>取消</Button></div>
    : <div className="mist-row"><Button variant="primary" onClick={closeSetup}>我已保存好恢复码</Button></div>;

  return <>
    <SettingRow title="两步验证" description={description} control={control} />
    <Dialog open={!!step} onClose={closeSetup} icon={ShieldCheck} title={step?.kind === 'codes' ? '保存恢复码' : '开启两步验证'}
      description={step?.kind === 'password' ? '先验证当前登录密码。' : step?.kind === 'scan' ? '用手机验证器应用扫描二维码（或手动输入密钥），再填入它显示的 6 位动态码。' : '手机丢失或换机时，每个恢复码可代替动态码登录一次。这些码只显示这一次，请抄写或保存到安全的地方。'}
      footer={setupFooter}>
      {error && <Banner tone="bad" title="未完成">{error}</Banner>}
      {step?.kind === 'password' && <form onSubmit={e => { e.preventDefault(); void submitPassword(); }}><FormGrid>
        <Field label="登录密码" required full><TextInput type="password" autoComplete="current-password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></Field>
      </FormGrid></form>}
      {step?.kind === 'scan' && <form onSubmit={e => { e.preventDefault(); void submitCode(); }}>
        <div className="mist-row" style={{ alignItems: 'flex-start', gap: 16 }}>
          <img src={step.qr} alt="两步验证二维码" width={180} height={180} />
          <div><p className="mist-muted">无法扫码时手动输入密钥：</p><code aria-label="密钥" style={{ wordBreak: 'break-all' }}>{step.secret.replace(/(.{4})/g, '$1 ').trim()}</code></div>
        </div>
        <FormGrid><Field label="动态码" required full><TextInput autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} disabled={busy} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} placeholder="6 位数字" /></Field></FormGrid>
      </form>}
      {step?.kind === 'codes' && <div>
        <ul aria-label="恢复码" className="mist-mono" style={{ columns: 2, listStyle: 'none', padding: 0 }}>{step.codes.map(c => <li key={c}>{c}</li>)}</ul>
        <Button size="sm" onClick={() => void copyCodes(step.codes)}>复制全部</Button>
      </div>}
    </Dialog>
    <Dialog open={disabling} onClose={() => !busy && setDisabling(false)} tone="bad" icon={ShieldOff} title="关闭两步验证" description="关闭后登录只需密码。需要验证登录密码和一个当前动态码（或恢复码）。"
      footer={<div className="mist-row"><Button variant="primary" loading={busy} onClick={() => void submitDisable()}>确认关闭</Button><Button disabled={busy} onClick={() => setDisabling(false)}>取消</Button></div>}>
      {error && <Banner tone="bad" title="未关闭">{error}</Banner>}
      <form onSubmit={e => { e.preventDefault(); void submitDisable(); }}><FormGrid>
        <Field label="登录密码" required><TextInput type="password" autoComplete="current-password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></Field>
        <Field label="动态码或恢复码" required><TextInput autoComplete="one-time-code" value={code} disabled={busy} onChange={e => setCode(e.target.value)} /></Field>
      </FormGrid></form>
    </Dialog>
  </>;
}
