/** 管理后台 · 账号：公司成员身份只在这里新建或经注册审批产生（2026-10-08 决定），角色只读展示，审计只读。 */
import React from 'react';
import { KeyRound, RefreshCw, UserPlus } from 'lucide-react';
import { Banner, Button, Card, CardHeader, Checkbox, DataTable, Dialog, Drawer, EmptyState, Field, FormGrid, KeyValue, Mono, Pill, Select, TextArea, TextInput, Toolbar, useToast, type Column } from '../../../../../components/mist';
import { useMistSession } from '../../runtime/auth';
import { useMistWorkspace } from '../../runtime/workspace';
import { ACCOUNT_STATUS, departmentOptions, organizationApi, type AdminAccount, type AdminRole, type AuditLogRow, type OrgDepartment } from '../../runtime/organization';

const SUPER_ADMIN = new Set(['role-super-admin', '老板', '超级管理员', 'SuperAdmin', 'super-admin']);
const isSuperAdmin = (role: AdminRole) => SUPER_ADMIN.has(role.id) || SUPER_ADMIN.has(role.name);
const when = (at: string | null | undefined) => at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—';
const message = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;

type Directory = { users: AdminAccount[]; departments: OrgDepartment[]; roles: AdminRole[] };
function useDirectory() {
  const session = useMistSession();
  const [data, setData] = React.useState<Directory | null>(null), [loading, setLoading] = React.useState(true), [error, setError] = React.useState('');
  const serial = React.useRef(0);
  const load = React.useCallback(async () => {
    const run = ++serial.current; setLoading(true); setError('');
    try { const [accounts, roles] = await Promise.all([organizationApi.listAccounts(), organizationApi.listRoles()]); if (run === serial.current) setData({ users: accounts.users ?? [], departments: accounts.departments ?? [], roles: roles.roles ?? [] }); }
    catch (e) { if (run === serial.current) setError(message(e, '账号读取失败')); }
    finally { if (run === serial.current) setLoading(false); }
  }, []);
  React.useEffect(() => { setData(null); void load(); return () => { serial.current++; }; }, [session.sessionKey, load]);
  return { data, loading, error, load };
}

/** 角色多选：老板（SuperAdmin）只有老板本人能授予，服务器同样复核。 */
function RolePicker({ roles, value, onChange, owner, disabled }: { roles: AdminRole[]; value: string[]; onChange: (v: string[]) => void; owner: boolean; disabled?: boolean }) {
  return <div className="mist-col" role="group" aria-label="角色">{roles.map(role => {
    const locked = isSuperAdmin(role) && !owner;
    return <Checkbox key={role.id} label={role.name + (locked ? '（仅老板可授予）' : '')} checked={value.includes(role.id)} disabled={disabled || locked}
      onChange={on => onChange(on ? [...value, role.id] : value.filter(id => id !== role.id))} />;
  })}</div>;
}

type Form = { mode: 'create' | 'approve' | 'edit'; account?: AdminAccount; displayName: string; email: string; password: string; departmentId: string; roles: string[]; grant: boolean };
function blank(): Form { return { mode: 'create', displayName: '', email: '', password: '', departmentId: '', roles: [], grant: true }; }

export function AdminAccounts() {
  const session = useMistSession(), workspace = useMistWorkspace(), toast = useToast();
  const { data, loading, error, load } = useDirectory();
  const owner = session.hasRole('owner');
  const [query, setQuery] = React.useState(''), [status, setStatus] = React.useState('');
  const [selected, setSelected] = React.useState<string | null>(null), [form, setForm] = React.useState<Form | null>(null);
  const [busy, setBusy] = React.useState(false), [formError, setFormError] = React.useState('');
  const [confirm, setConfirm] = React.useState<{ kind: 'disable' | 'enable' | 'reset' | 'reject'; account: AdminAccount } | null>(null), [reason, setReason] = React.useState('');
  const [temporary, setTemporary] = React.useState<{ name: string; password: string } | null>(null);
  const envelope = workspace.workspace, canGrant = envelope?.access?.canManageMembers === true && !!workspace.changeMember;
  const memberIds = new Set((workspace.state?.members ?? []).map(m => m.userId));
  const roleName = (roleId: string) => data?.roles.find(r => r.id === roleId)?.name ?? roleId;
  const departments = data ? departmentOptions(data.departments) : [];
  const users = (data?.users ?? []).filter(u => (!status || u.status === status) && (!query.trim() || [u.displayName, u.email, u.department ?? ''].join(' ').toLowerCase().includes(query.trim().toLowerCase())));
  const pending = (data?.users ?? []).filter(u => u.status === 'pending');
  const current = data?.users.find(u => u.id === selected) ?? null;

  const grant = async (userId: string, name: string) => {
    try { await workspace.changeMember!('add', userId); return true; }
    catch (e) { toast(`账号已生效，但授权进入「${envelope?.name}」未完成：${message(e, '请稍后在账号详情重试')}`, 'bad'); return false; }
  };
  const submit = async () => {
    if (!form || busy) return;
    const f = form;
    if (f.mode !== 'edit' && !f.departmentId) return setFormError('请选择任职部门（不能直接归属公司）');
    if (f.mode !== 'edit' && !f.roles.length) return setFormError('请至少选择一个角色');
    if (f.mode === 'create' && (!f.displayName.trim() || !f.email.trim() || f.password.length < 8)) return setFormError('请填写姓名、邮箱和至少 8 位初始密码');
    setBusy(true); setFormError('');
    try {
      let userId = f.account?.id ?? '';
      if (f.mode === 'create') userId = (await organizationApi.createAccount({ displayName: f.displayName.trim(), email: f.email.trim(), password: f.password, roles: f.roles, departmentId: f.departmentId })).userId;
      else if (f.mode === 'approve') await organizationApi.approve(userId, f.roles, f.departmentId);
      else {
        await organizationApi.updateAccount(userId, { displayName: f.displayName.trim(), email: f.email.trim(), departmentId: f.departmentId || undefined });
        await organizationApi.setRoles(userId, f.roles, f.departmentId || null);
      }
      const granted = f.mode !== 'edit' && f.grant && canGrant ? await grant(userId, f.displayName) : false;
      toast(f.mode === 'create' ? (granted ? `账号已创建并授权进入「${envelope?.name}」` : '账号已创建') : f.mode === 'approve' ? (granted ? `已通过审批并授权进入「${envelope?.name}」` : '已通过注册审批') : '账号已更新');
      setForm(null); setSelected(userId); await load();
    } catch (e) { setFormError(message(e, '保存未完成')); }
    finally { setBusy(false); }
  };
  const decide = async () => {
    if (!confirm || busy) return;
    const { kind, account } = confirm;
    if (kind === 'reject' && !reason.trim()) return;
    setBusy(true);
    try {
      if (kind === 'disable') await organizationApi.disable(account.id);
      else if (kind === 'enable') await organizationApi.updateAccount(account.id, { status: 'active' });
      else if (kind === 'reject') await organizationApi.reject(account.id, reason.trim());
      else { const result = await organizationApi.resetPassword(account.id); if (result.temporaryPassword) setTemporary({ name: account.displayName, password: result.temporaryPassword }); }
      toast({ disable: '账号已停用，历史记录保留', enable: '账号已重新启用', reject: '已拒绝注册申请', reset: '密码已重置，对方下次登录须修改' }[kind]);
      setConfirm(null); setReason(''); await load();
    } catch (e) { toast(message(e, '操作未完成'), 'bad'); }
    finally { setBusy(false); }
  };

  const columns: Column<AdminAccount>[] = [
    { key: 'name', header: '姓名 / 邮箱', width: 'minmax(200px,2fr)', render: u => <><b>{u.displayName}</b><div className="mist-note">{u.email}</div></>, sortValue: u => u.displayName },
    { key: 'department', header: '任职部门', render: u => u.department ?? <span className="mist-note">未分配</span> },
    { key: 'roles', header: '角色', width: 'minmax(160px,1.5fr)', render: u => u.roleIds.length ? u.roleIds.map(roleName).join('、') : <span className="mist-note">无角色</span> },
    { key: 'status', header: '状态', width: '96px', render: u => <Pill tone={ACCOUNT_STATUS[u.status]?.tone ?? 'neutral'}>{ACCOUNT_STATUS[u.status]?.label ?? u.status}</Pill> },
    { key: 'login', header: '最近登录', width: '150px', render: u => when(u.lastLoginAt), sortValue: u => u.lastLoginAt ?? '' },
  ];
  const self = current?.id === session.user?.id;
  return <>
    {error && <Banner tone="bad" title="账号读取失败" actions={<Button size="sm" icon={RefreshCw} onClick={() => void load()}>重试</Button>}>{error}</Banner>}
    {pending.length > 0 && <Banner tone="warn" title={`${pending.length} 个注册申请待审批`}>审批时确定任职部门与角色；通过后对方才能登录。</Banner>}
    <Toolbar right={<Button variant="primary" icon={UserPlus} disabled={!data} onClick={() => { setFormError(''); setForm(blank()); }}>新建账号</Button>}>
      <Field label="搜索"><TextInput aria-label="搜索账号" placeholder="姓名、邮箱或部门" value={query} onChange={e => setQuery(e.target.value)} /></Field>
      <Field label="状态"><Select aria-label="账号状态" value={status} onChange={e => setStatus(e.target.value)} options={[{ value: '', label: '全部状态' }, ...Object.entries(ACCOUNT_STATUS).map(([value, s]) => ({ value, label: s.label }))]} /></Field>
    </Toolbar>
    <Card><DataTable ariaLabel="公司账号" rows={users} rowKey={u => u.id} loading={loading && !data} selectedKey={selected} onRowClick={u => setSelected(u.id)} columns={columns}
      empty={<EmptyState title={data?.users.length ? '没有符合条件的账号' : '还没有公司账号'} description={data?.users.length ? '调整搜索或状态后再看。' : '用“新建账号”创建第一位成员。'} />} /></Card>
    <Drawer open={!!current && !form} onClose={() => setSelected(null)} title={current?.displayName ?? ''} sub={current?.email}
      footer={current && <div className="mist-row">
        {current.status === 'pending' && <><Button variant="primary" onClick={() => { setFormError(''); setForm({ ...blank(), mode: 'approve', account: current, displayName: current.displayName, email: current.email, departmentId: current.departmentId ?? '', roles: current.roleIds }); }}>审批通过</Button><Button onClick={() => setConfirm({ kind: 'reject', account: current })}>拒绝</Button></>}
        {current.status === 'active' && <><Button onClick={() => { setFormError(''); setForm({ ...blank(), mode: 'edit', account: current, displayName: current.displayName, email: current.email, departmentId: current.departmentId ?? '', roles: current.roleIds }); }}>修改资料与角色</Button><Button icon={KeyRound} onClick={() => setConfirm({ kind: 'reset', account: current })}>重置密码</Button><Button disabled={self} onClick={() => setConfirm({ kind: 'disable', account: current })}>{self ? '不能停用自己' : '停用账号'}</Button></>}
        {current.status === 'disabled' && <Button onClick={() => setConfirm({ kind: 'enable', account: current })}>重新启用</Button>}
      </div>}>
      {current && <>
        <KeyValue items={[{ label: '状态', value: ACCOUNT_STATUS[current.status]?.label ?? current.status }, { label: '任职部门', value: current.department ?? '未分配' }, { label: '角色', value: current.roleIds.map(roleName).join('、') || '无角色' }, { label: '账号编号', value: current.id, mono: true }, { label: '创建时间', value: when(current.createdAt) }, { label: '最近登录', value: when(current.lastLoginAt) }]} />
        {envelope && current.status === 'active' && <div className="mist-section">{envelope.ownerId === current.id ? <Banner tone="neutral" title={`「${envelope.name}」的所有者`} /> : memberIds.has(current.id)
          ? <Banner tone="ok" title={`已授权进入「${envelope.name}」`}>能办理哪些业务仍按其角色与任职部门决定。</Banner>
          : <Banner tone="warn" title={`尚未授权进入「${envelope.name}」`} actions={canGrant ? <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); if (await grant(current.id, current.displayName)) toast('已授权进入当前工作空间'); setBusy(false); }}>授权进入</Button> : undefined}>{canGrant ? '授权只让对方进入这个空间，不增加任何业务权限。' : '请空间所有者在“工作空间设置 · 授权访问”中授权。'}</Banner>}</div>}
        <p className="mist-note">小组归属在“人事管理”维护；停用账号保留历史单据和审计，不删除数据。</p>
      </>}
    </Drawer>
    <Drawer open={!!form} onClose={() => !busy && setForm(null)} title={form?.mode === 'create' ? '新建账号' : form?.mode === 'approve' ? '审批注册申请' : '修改资料与角色'} sub={form?.account?.email}
      footer={<div className="mist-row"><Button variant="primary" loading={busy} onClick={() => void submit()}>{form?.mode === 'create' ? '创建账号' : form?.mode === 'approve' ? '通过审批' : '保存'}</Button><Button disabled={busy} onClick={() => setForm(null)}>取消</Button></div>}>
      {form && data && <>
        {formError && <Banner tone="bad" title="未保存">{formError}</Banner>}
        <FormGrid>
          <Field label="姓名" required><TextInput value={form.displayName} disabled={busy || form.mode === 'approve'} onChange={e => setForm({ ...form, displayName: e.target.value })} /></Field>
          <Field label="登录邮箱" required><TextInput type="email" value={form.email} disabled={busy || form.mode === 'approve'} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
          {form.mode === 'create' && <Field label="初始密码" required hint="至少 8 位；对方登录后自行修改。"><TextInput type="password" autoComplete="new-password" value={form.password} disabled={busy} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>}
          <Field label="任职部门" required hint="决定业务属性；小组须在同一部门。"><Select aria-label="任职部门" value={form.departmentId} disabled={busy} placeholder="选择部门" onChange={e => setForm({ ...form, departmentId: e.target.value })} options={departments} /></Field>
          <Field label="角色" required full hint="角色决定能做哪些动作；与部门业务属性同时满足才可办理。"><RolePicker roles={data.roles} value={form.roles} owner={owner} disabled={busy} onChange={roles => setForm({ ...form, roles })} /></Field>
          {form.mode !== 'edit' && envelope && <Field label="工作空间" full>{canGrant ? <Checkbox checked={form.grant} disabled={busy} onChange={grant => setForm({ ...form, grant })} label={`同时授权进入「${envelope.name}」`} /> : <span className="mist-note">你不是「{envelope.name}」的所有者；账号生效后请所有者授权。</span>}</Field>}
        </FormGrid>
      </>}
    </Drawer>
    <Dialog open={!!confirm} onClose={() => !busy && setConfirm(null)} tone={confirm?.kind === 'disable' || confirm?.kind === 'reject' ? 'bad' : 'warn'}
      title={confirm ? { disable: '停用账号', enable: '重新启用账号', reset: '重置密码', reject: '拒绝注册申请' }[confirm.kind] : ''}
      description={confirm ? { disable: `${confirm.account.displayName} 将无法登录，已登录的会话随即失效；历史单据与小组记录保留。`, enable: `${confirm.account.displayName} 可以再次登录，角色与部门保持不变。`, reset: `将为 ${confirm.account.displayName} 生成临时密码，只显示一次，请当面或经内部渠道转交。`, reject: `${confirm.account.displayName} 的申请将被拒绝，请写明原因。` }[confirm.kind] : undefined}
      footer={<div className="mist-row"><Button variant="primary" loading={busy} disabled={confirm?.kind === 'reject' && !reason.trim()} onClick={() => void decide()}>确认</Button><Button disabled={busy} onClick={() => setConfirm(null)}>取消</Button></div>}>
      {confirm?.kind === 'reject' && <Field label="拒绝原因" required><TextArea value={reason} onChange={e => setReason(e.target.value)} /></Field>}
    </Dialog>
    <Dialog open={!!temporary} onClose={() => setTemporary(null)} title="临时密码" description={`${temporary?.name ?? ''} 下次登录须修改。关闭后不再显示。`} footer={<Button variant="primary" onClick={() => setTemporary(null)}>已转交</Button>}>
      <Mono>{temporary?.password}</Mono>
    </Dialog>
  </>;
}

export function AdminRoles() {
  const { data, loading, error, load } = useDirectory();
  const counts = (roleId: string) => (data?.users ?? []).filter(u => u.status === 'active' && u.roleIds.includes(roleId)).length;
  return <>
    {error && <Banner tone="bad" title="角色读取失败" actions={<Button size="sm" icon={RefreshCw} onClick={() => void load()}>重试</Button>}>{error}</Banner>}
    <Banner tone="neutral" title="角色权限当前只读">修改角色包含的权限属于关键权限变更，本版只展示；给账号分配角色在“账号”中办理。</Banner>
    <Card><DataTable ariaLabel="角色" rows={data?.roles ?? []} rowKey={r => r.id} loading={loading && !data} columns={[
      { key: 'name', header: '角色', width: 'minmax(160px,1fr)', render: r => <><b>{r.name}</b>{r.isSystem && <> <Pill plain>系统</Pill></>}{r.description && <div className="mist-note">{r.description}</div>}</> },
      { key: 'users', header: '启用账号', width: '96px', align: 'right', render: r => counts(r.id) },
      { key: 'permissions', header: '权限', width: 'minmax(260px,3fr)', render: r => r.permissions.length ? <span className="mist-note">{r.permissions.join('、')}</span> : <span className="mist-note">无</span> },
    ]} empty={<EmptyState title="没有角色" />} /></Card>
  </>;
}

const AUDIT_ACTIONS: Record<string, string> = { register: '提交注册', create_user: '新建账号', reactivate_user: '重新启用账号', update_user: '修改账号', update_profile: '修改个人资料', reset_password: '重置密码', disable_account: '停用账号', approve_register: '通过注册', reject_register: '拒绝注册', update_roles: '调整角色', update_role_permissions: '调整角色权限', erase_personal_data: '清除个人数据', create_department: '新建部门', edit_department: '修改部门', retire_department: '裁撤部门', create_team: '新建小组', update_team: '修改小组', delete_team: '解散小组', add_team_member: '加入小组', remove_team_member: '移出小组', upsert_employee: '保存员工档案', delete_employee: '删除员工档案' };
export function AdminAuditLog() {
  const session = useMistSession();
  const [rows, setRows] = React.useState<AuditLogRow[]>([]), [total, setTotal] = React.useState(0), [page, setPage] = React.useState(0), [targetType, setTargetType] = React.useState('');
  const [loading, setLoading] = React.useState(true), [error, setError] = React.useState('');
  const size = 50, serial = React.useRef(0);
  const load = React.useCallback(async () => {
    const run = ++serial.current; setLoading(true); setError('');
    try { const result = await organizationApi.auditLogs({ limit: size, offset: page * size, targetType }); if (run === serial.current) { setRows(result.logs ?? []); setTotal(result.total ?? 0); } }
    catch (e) { if (run === serial.current) setError(message(e, '审计日志读取失败')); }
    finally { if (run === serial.current) setLoading(false); }
  }, [page, targetType]);
  React.useEffect(() => { void load(); return () => { serial.current++; }; }, [load, session.sessionKey]);
  return <>
    {error && <Banner tone="bad" title="审计日志读取失败" actions={<Button size="sm" icon={RefreshCw} onClick={() => void load()}>重试</Button>}>{error}</Banner>}
    <Toolbar right={<span className="mist-note">共 {total} 条 · 第 {page + 1} / {Math.max(1, Math.ceil(total / size))} 页</span>}>
      <Field label="对象"><Select aria-label="审计对象" value={targetType} onChange={e => { setPage(0); setTargetType(e.target.value); }} options={[{ value: '', label: '全部对象' }, { value: 'UserAccount', label: '账号' }, { value: 'Department', label: '部门' }, { value: 'Team', label: '小组' }, { value: 'TeamMember', label: '小组成员' }, { value: 'EmployeeProfile', label: '员工档案' }, { value: 'Role', label: '角色' }]} /></Field>
      <Button disabled={loading || page === 0} onClick={() => setPage(page - 1)}>上一页</Button><Button disabled={loading || (page + 1) * size >= total} onClick={() => setPage(page + 1)}>下一页</Button>
    </Toolbar>
    <Card><DataTable ariaLabel="审计日志" rows={rows} rowKey={r => r.id} loading={loading} columns={[
      { key: 'at', header: '时间', width: '170px', render: r => when(r.createdAt) },
      { key: 'actor', header: '操作人', width: 'minmax(140px,1fr)', render: r => <Mono>{r.actorId}</Mono> },
      { key: 'action', header: '动作', width: 'minmax(120px,1fr)', render: r => AUDIT_ACTIONS[r.action] ?? r.action },
      { key: 'target', header: '对象', width: 'minmax(180px,2fr)', render: r => <>{r.targetType} <Mono>{r.targetId ?? ''}</Mono></> },
    ]} empty={<EmptyState title="没有审计记录" description="调整对象筛选后再看。" />} /></Card>
  </>;
}
