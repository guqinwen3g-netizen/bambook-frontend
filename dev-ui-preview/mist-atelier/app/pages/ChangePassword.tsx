/** 设置 · 安全：修改当前账号登录密码（服务器 /auth/change-password 校验当前密码）；管理员重置密码后的强制改密页。 */
import React from 'react';
import { KeyRound, LogOut, MonitorSmartphone } from 'lucide-react';
import { Banner, Button, Card, CardHeader, Dialog, Field, FormGrid, MistPage, SettingRow, TextInput, useToast } from '../../../../components/mist';
import { changePassword, logoutAllSessions } from '../../../../services/authService';
import { useMistSession } from '../runtime/auth';

const MIN = 8;
function explain(error: unknown) {
  const text = error instanceof Error ? error.message : '';
  if (/incorrect|INVALID_CREDENTIALS/i.test(text)) return '当前密码不正确';
  if (/Not logged in|expired|UNAUTHORIZED/i.test(text)) return '登录已失效，请重新登录后再修改';
  if (/at least|WEAK_PASSWORD/i.test(text)) return `新密码至少 ${MIN} 位`;
  return text && !/HTTP|failed/i.test(text) ? text : '密码未修改，请重试';
}

function usePasswordForm(onDone: () => void | Promise<void>, currentLabel = '当前密码') {
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const [current, setCurrent] = React.useState(''), [next, setNext] = React.useState(''), [confirm, setConfirm] = React.useState('');
  const reset = () => { setCurrent(''); setNext(''); setConfirm(''); setError(''); };
  const submit = async () => {
    if (busy) return;
    if (!current) return setError('请填写' + currentLabel);
    if (next.length < MIN) return setError(`新密码至少 ${MIN} 位`);
    if (next === current) return setError('新密码不能与' + currentLabel + '相同');
    if (next !== confirm) return setError('两次输入的新密码不一致');
    setBusy(true); setError('');
    try { await changePassword(current, next); reset(); await onDone(); }
    catch (e) { setError(explain(e)); }
    finally { setBusy(false); }
  };
  const fields = <form onSubmit={e => { e.preventDefault(); void submit(); }}><FormGrid>
    <Field label={currentLabel} required full><TextInput type="password" autoComplete="current-password" value={current} disabled={busy} onChange={e => setCurrent(e.target.value)} /></Field>
    <Field label="新密码" required hint={`至少 ${MIN} 位`}><TextInput type="password" autoComplete="new-password" value={next} disabled={busy} onChange={e => setNext(e.target.value)} /></Field>
    <Field label="确认新密码" required><TextInput type="password" autoComplete="new-password" value={confirm} disabled={busy} onChange={e => setConfirm(e.target.value)} /></Field>
  </FormGrid></form>;
  return { busy, error, reset, submit, fields };
}

/** 管理员重置密码后首次登录：改密前不进入工作台。 */
export function ForcedPasswordChangePage() {
  const session = useMistSession(), toast = useToast();
  const form = usePasswordForm(async () => { toast('登录密码已修改'); await session.refresh(); }, '临时密码');
  return <MistPage width="narrow"><Card><CardHeader title="请先修改登录密码" sub={session.user?.email} />
    <div className="mist-card-body">
      <p>管理员为你重置了密码。为保护账号安全，请用收到的临时密码设置一个只有你知道的新密码，再继续使用系统。</p>
      {form.error && <Banner tone="bad" title="未修改">{form.error}</Banner>}
      {form.fields}
      <div className="mist-row"><Button variant="primary" loading={form.busy} onClick={() => void form.submit()}>修改并继续</Button><Button icon={LogOut} disabled={form.busy} onClick={() => void session.logout()}>退出登录</Button></div>
    </div>
  </Card></MistPage>;
}

export function ChangePasswordRow() {
  const toast = useToast(), session = useMistSession();
  const [open, setOpen] = React.useState(false);
  const { busy, error, reset, submit, fields } = usePasswordForm(async () => { toast('登录密码已修改，下次登录请使用新密码'); setOpen(false); if (session.user?.mustChangePassword) await session.refresh(); });
  return <>
    <SettingRow title="登录密码" description="修改当前账号的登录密码；管理员重置给你的临时密码请尽快在这里改掉。" control={<Button size="sm" icon={KeyRound} onClick={() => { reset(); setOpen(true); }}>修改密码</Button>} />
    <Dialog open={open} onClose={() => !busy && setOpen(false)} title="修改登录密码" description="需要先验证当前密码；修改后其他已登录设备不会自动退出，如有需要请再用“退出所有设备”。"
      footer={<div className="mist-row"><Button variant="primary" loading={busy} onClick={() => void submit()}>确认修改</Button><Button disabled={busy} onClick={() => setOpen(false)}>取消</Button></div>}>
      {error && <Banner tone="bad" title="未修改">{error}</Banner>}
      {fields}
    </Dialog>
  </>;
}

/** 设置 · 安全：退出所有设备（含当前设备），用于设备丢失或怀疑密码外泄。 */
export function LogoutAllRow() {
  const session = useMistSession();
  const [open, setOpen] = React.useState(false), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { await logoutAllSessions(); setOpen(false); await session.logout(); }
    catch (e) { setError(explain(e) === '密码未修改，请重试' ? '未能退出所有设备，请重试' : explain(e)); }
    finally { setBusy(false); }
  };
  return <>
    <SettingRow title="退出所有设备" description="电脑、手机等所有已登录的会话立即失效，包括当前这台；之后需要重新登录。" control={<Button size="sm" icon={MonitorSmartphone} onClick={() => { setError(''); setOpen(true); }}>退出所有设备</Button>} />
    <Dialog open={open} onClose={() => !busy && setOpen(false)} tone="bad" title="退出所有设备" description="确认后所有设备上的登录立即失效，当前设备也会回到登录页。如怀疑密码外泄，请重新登录后立即修改密码。"
      footer={<div className="mist-row"><Button variant="primary" loading={busy} onClick={() => void submit()}>确认退出</Button><Button disabled={busy} onClick={() => setOpen(false)}>取消</Button></div>}>
      {error && <Banner tone="bad" title="未完成">{error}</Banner>}
    </Dialog>
  </>;
}
