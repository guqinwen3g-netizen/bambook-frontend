/** 设置 · 安全：修改当前账号登录密码（服务器 /auth/change-password 校验当前密码）。 */
import React from 'react';
import { KeyRound } from 'lucide-react';
import { Banner, Button, Dialog, Field, FormGrid, SettingRow, TextInput, useToast } from '../../../../components/mist';
import { changePassword } from '../../../../services/authService';

const MIN = 8;
function explain(error: unknown) {
  const text = error instanceof Error ? error.message : '';
  if (/incorrect|INVALID_CREDENTIALS/i.test(text)) return '当前密码不正确';
  if (/Not logged in|expired|UNAUTHORIZED/i.test(text)) return '登录已失效，请重新登录后再修改';
  if (/at least|WEAK_PASSWORD/i.test(text)) return `新密码至少 ${MIN} 位`;
  return text && !/HTTP|failed/i.test(text) ? text : '密码未修改，请重试';
}

export function ChangePasswordRow() {
  const toast = useToast();
  const [open, setOpen] = React.useState(false), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const [current, setCurrent] = React.useState(''), [next, setNext] = React.useState(''), [confirm, setConfirm] = React.useState('');
  const reset = () => { setCurrent(''); setNext(''); setConfirm(''); setError(''); };
  const submit = async () => {
    if (busy) return;
    if (!current) return setError('请填写当前密码');
    if (next.length < MIN) return setError(`新密码至少 ${MIN} 位`);
    if (next === current) return setError('新密码不能与当前密码相同');
    if (next !== confirm) return setError('两次输入的新密码不一致');
    setBusy(true); setError('');
    try { await changePassword(current, next); toast('登录密码已修改，下次登录请使用新密码'); reset(); setOpen(false); }
    catch (e) { setError(explain(e)); }
    finally { setBusy(false); }
  };
  return <>
    <SettingRow title="登录密码" description="修改当前账号的登录密码；管理员重置给你的临时密码请尽快在这里改掉。" control={<Button size="sm" icon={KeyRound} onClick={() => { reset(); setOpen(true); }}>修改密码</Button>} />
    <Dialog open={open} onClose={() => !busy && setOpen(false)} title="修改登录密码" description="需要先验证当前密码；修改后其他已登录设备的会话不会自动退出。"
      footer={<div className="mist-row"><Button variant="primary" loading={busy} onClick={() => void submit()}>确认修改</Button><Button disabled={busy} onClick={() => setOpen(false)}>取消</Button></div>}>
      {error && <Banner tone="bad" title="未修改">{error}</Banner>}
      <form onSubmit={e => { e.preventDefault(); void submit(); }}><FormGrid>
        <Field label="当前密码" required full><TextInput type="password" autoComplete="current-password" value={current} disabled={busy} onChange={e => setCurrent(e.target.value)} /></Field>
        <Field label="新密码" required hint={`至少 ${MIN} 位`}><TextInput type="password" autoComplete="new-password" value={next} disabled={busy} onChange={e => setNext(e.target.value)} /></Field>
        <Field label="确认新密码" required><TextInput type="password" autoComplete="new-password" value={confirm} disabled={busy} onChange={e => setConfirm(e.target.value)} /></Field>
      </FormGrid></form>
    </Dialog>
  </>;
}
