/** 设置 · 工作空间：授权访问。只管“谁能进这个空间”，不授予任何业务权限。 */
import React from 'react';
import { UserPlus } from 'lucide-react';
import { Banner, Button, Checkbox, Field, FormSection, Select, SettingRow, TextInput } from '../../../../components/mist';
import { MIST_BUSINESS_GROUPS, MIST_BUSINESS_GROUP_LABEL, type MistBusinessGroup } from '../../../../server/src/shared/mistAccounts';
import { accountOwnedObjects, workspaceMembers } from '../runtime/members';
import { useMistSession } from '../runtime/auth';
import { useMistWorkspace } from '../runtime/workspace';

const when = (at: string) => new Date(at).toLocaleString();
export function WorkspaceMembers({ busy: outerBusy }: { busy: boolean }) {
  const workspace = useMistWorkspace(), session = useMistSession();
  const envelope = workspace.workspace, state = workspace.state, owner = envelope?.access?.canManageMembers === true;
  const [account, setAccount] = React.useState(''), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const scope = `${session.sessionKey}:${envelope?.id ?? ''}`;
  const liveScope = React.useRef(scope), mounted = React.useRef(true), inFlight = React.useRef(false);
  liveScope.current = scope;
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => { inFlight.current = false; setAccount(''); setError(''); setBusy(false); }, [scope]);
  if (!envelope || !state) return null;
  const members = state.members ?? [], log = state.memberLog ?? [];
  const candidates = (session.localProfiles ?? []).filter(p => p.id !== envelope.ownerId && !members.some(m => m.userId === p.id));
  const disabled = outerBusy || busy || !!workspace.pending || !workspace.changeMember;
  const directory = workspaceMembers(envelope, state, session.user);
  const setGroups = async (userId: string, groups: MistBusinessGroup[]) => {
    if (!owner || outerBusy || busy || workspace.pending || inFlight.current) return;
    const boundScope = scope, current = () => mounted.current && liveScope.current === boundScope;
    inFlight.current = true; setBusy(true); setError('');
    try { await workspace.run({ type: 'member.groups.set', payload: { userId, groups } }); }
    catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : '业务组未保存'); }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };
  /** 业务组（面料 / 成衣，可多选）决定能否被指定为对应组的供应商经手人；只有所有者可改。 */
  const groupControl = (userId: string) => {
    const groups = directory.find(m => m.id === userId)?.groups ?? [];
    return <span className="mist-row" role="group" aria-label="业务组">{MIST_BUSINESS_GROUPS.map(g => <Checkbox key={g} label={MIST_BUSINESS_GROUP_LABEL[g]} checked={groups.includes(g)} disabled={!owner || outerBusy || busy || !!workspace.pending}
      onChange={on => void setGroups(userId, MIST_BUSINESS_GROUPS.filter(x => x === g ? on : groups.includes(x)))} />)}</span>;
  };
  const ownedSummary = (userId: string) => {
    const owned = accountOwnedObjects(state, userId);
    return owned.length ? `名下 ${owned.length} 项：${owned.slice(0, 3).map(o => o.role + ' ' + o.label).join('；')}${owned.length > 3 ? ' 等' : ''}` : '名下暂无负责对象';
  };
  const change = async (action: 'add' | 'remove', target: string) => {
    if (!owner || disabled || inFlight.current) return;
    const boundScope = scope, current = () => mounted.current && liveScope.current === boundScope;
    inFlight.current = true; setBusy(true); setError('');
    try { await workspace.changeMember!(action, target); if (current() && action === 'add') setAccount(''); }
    catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : '授权未完成'); }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };
  return <><FormSection title="授权访问" description="授权只让对方进入这个空间。对方能看到哪些数据、能办理哪些动作，仍按其本人岗位权限决定，由服务端校验。">
    {!owner && <Banner tone="neutral" title="你是被授权成员">空间设置、授权和回收站只能由所有者办理；你可以按本人岗位权限查看和办理业务。</Banner>}
    {error && <Banner tone="bad" title="授权未完成">{error}</Banner>}
    <SettingRow title="所有者" description={envelope.ownerId === session.user?.id ? '当前账号' : '创建此空间的账号'} control={<span className="mist-mono">{envelope.ownerId === session.user?.id ? session.user?.displayName : envelope.ownerId}</span>} />
    {members.map(m => <SettingRow key={m.userId} title={m.name} description={`${m.addedByName} 于 ${when(m.addedAt)} 授权`} control={owner ? <Button size="sm" disabled={disabled} onClick={() => void change('remove', m.userId)}>撤销授权</Button> : <span className="mist-note">{m.userId === session.user?.id ? '当前账号' : '已授权'}</span>} />)}
    {!members.length && <p className="mist-note">尚未授权其他账号。</p>}
    {owner && <div className="mist-row">
      <Field label={session.localMode ? '本地工作身份' : '员工账号'} hint={session.localMode ? '本地测试身份的权限取自现有岗位' : '填写登录邮箱或账号编号'}>
        {session.localMode
          ? <Select aria-label="要授权的本地工作身份" disabled={disabled || !candidates.length} value={account} onChange={event => setAccount(event.target.value)} placeholder={candidates.length ? '选择身份' : '没有可授权的身份'} options={candidates.map(p => ({ value: p.id, label: p.name }))} />
          : <TextInput aria-label="要授权的员工账号" disabled={disabled} value={account} onChange={event => setAccount(event.target.value)} />}
      </Field>
      <Button icon={UserPlus} disabled={disabled || !account.trim()} loading={busy} onClick={() => void change('add', account)}>授权进入</Button>
    </div>}
    {log.length > 0 && <div className="mist-col"><b>授权记录</b>{log.slice(0, 20).map(l => <small key={l.id}>{when(l.at)} · {l.actorName}{l.action === 'add' ? ' 授权 ' : ' 撤销 '}{l.name}</small>)}</div>}
  </FormSection>
  <FormSection title="业务组" description="供应商的面料 / 成衣经手人只能从对应业务组的成员中选择。业务组由所有者设置，不改变岗位权限。">
    {!owner && <p className="mist-note">业务组只能由所有者设置。</p>}
    {directory.map(m => <SettingRow key={m.id} title={m.owner ? `${m.name}（所有者）` : m.name} description={ownedSummary(m.id)} control={groupControl(m.id)} />)}
  </FormSection></>;
}