/** T10 设置：保留 Mist 分区导航、设置卡与吸底操作栏。 */
import React from 'react';
import { Bell, Building2, Laptop, Moon, Palette, Shield, Sun, Trash2, User, RefreshCw } from 'lucide-react';
import { Banner, Button, Card, ChoiceCards, Dialog, Field, FormGrid, FormSection, MistPage, PageHeader, Select, SettingRow, Skeleton, Switch, TextInput, VerticalSteps, useToast } from '../../../../components/mist';
import type { MistSettings } from '../../../../server/src/shared/mistWorkspace';
import { useMistSession } from '../runtime/auth';
import { useMistWorkspace } from '../runtime/workspace';
import { useNav } from '../nav';
import { WorkspaceMembers } from './WorkspaceMembers';
import { ChangePasswordRow } from './ChangePassword';

type TextKey = 'workspaceName' | 'profileName' | 'profileEmail' | 'locale';
type TextValues = Pick<MistSettings, TextKey>;
export function SettingsPage() {
  const workspace = useMistWorkspace(), session = useMistSession(), toast = useToast(), nav = useNav();
  const { state, loading, saving, pending } = workspace;
  const [sec, setSec] = React.useState(() => ['appearance', 'notify', 'workspace', 'account', 'security'].includes(String(nav?.route?.section)) ? String(nav!.route.section) : 'appearance'), [error, setError] = React.useState('');
  const [lifecycle,setLifecycle]=React.useState<{action:'archive'|'restore';id?:string;name:string}|null>(null),[lifecycleBusy,setLifecycleBusy]=React.useState(false);
  const lifecycleLock=React.useRef(false),mounted=React.useRef(true);
  React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const scope = `${session.sessionKey}:${workspace.workspace?.id ?? ''}`, activeScope = React.useRef(scope); activeScope.current = scope;
  const [draft, setDraft] = React.useState<{ scope: string; values: TextValues } | null>(null);
  const dirty = React.useRef<Partial<Record<TextKey, boolean>>>({}), working = React.useRef(false);
  const latest = React.useRef(draft); latest.current = draft;
  React.useEffect(() => {
    dirty.current = {}; working.current = false; lifecycleLock.current=false;setLifecycle(null);setLifecycleBusy(false);setError('');
    setDraft(state ? { scope, values: { workspaceName: state.settings.workspaceName, profileName: state.settings.profileName, profileEmail: state.settings.profileEmail, locale: state.settings.locale } } : null);
  }, [scope]);
  React.useEffect(() => {
    if (!state) return;
    setDraft(previous => {
      const values = { workspaceName: state.settings.workspaceName, profileName: state.settings.profileName, profileEmail: state.settings.profileEmail, locale: state.settings.locale };
      if (previous?.scope === scope) for (const key of Object.keys(dirty.current) as TextKey[]) if (dirty.current[key]) values[key] = previous.values[key];
      return { scope, values };
    });
  }, [state?.settings, scope]);
  const settings = state?.settings;
  const values = draft?.scope === scope ? draft.values : settings;
  const member = workspace.workspace?.access?.role === 'member';
  const busy = loading || saving || !!pending || !!workspace.pendingCreate || lifecycleBusy;
  /** 空间设置写入整个共享空间，只有所有者可改；服务端同样拒绝成员修改。 */
  const settingsLocked = busy || member;
  React.useEffect(()=>{if(sec==='security'&&workspace.refreshArchived&&!loading){const bound=scope;void workspace.refreshArchived().catch(failure=>{if(mounted.current&&activeScope.current===bound)setError(failure instanceof Error?failure.message:'回收站读取失败');});}},[sec,scope,workspace.refreshArchived,loading]);
  const confirmLifecycle=async()=>{if(!lifecycle||busy||lifecycleLock.current)return;lifecycleLock.current=true;setLifecycleBusy(true);setError('');const bound=scope;try{if(lifecycle.action==='archive')await workspace.archiveWorkspace!();else await workspace.restoreWorkspace!(lifecycle.id!);if(mounted.current&&activeScope.current===bound)setLifecycle(null);}catch(failure){if(mounted.current&&activeScope.current===bound)setError(failure instanceof Error?failure.message:'工作空间操作未完成');}finally{if(mounted.current&&activeScope.current===bound){lifecycleLock.current=false;setLifecycleBusy(false);}}};
  const edit = (key: TextKey, value: string) => {
    if (!values) return;
    dirty.current[key] = true; setDraft({ scope, values: { workspaceName: values.workspaceName, profileName: values.profileName, profileEmail: values.profileEmail, locale: values.locale, [key]: value } });
  };
  const save = async (patch: Partial<MistSettings>, success?: string) => {
    if (!state || busy || working.current) return false;
    if (patch.workspaceName !== undefined && (!patch.workspaceName.trim() || patch.workspaceName.trim().length > 120)) { setError('工作空间名称须为1至120字'); return false; }
    if (patch.profileEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.profileEmail)) { setError('请输入有效的显示邮箱'); return false; }
    working.current = true; const current = scope; setError('');
    try {
      await workspace.run({ type: 'settings.update', payload: patch });
      if (activeScope.current !== current) return false;
      for (const key of Object.keys(patch) as Array<keyof MistSettings>) if (key in dirty.current && latest.current?.values[key as TextKey] === patch[key]) delete dirty.current[key as TextKey];
      if (success) toast(success);
      return true;
    } catch (failure) {
      if (activeScope.current === current) { const message = failure instanceof Error ? failure.message : '设置保存失败'; setError(message); toast(message, 'bad'); }
      return false;
    } finally { if (activeScope.current === current) working.current = false; }
  };
  const saveField = (key: TextKey) => { if (dirty.current[key] && values) void save({ [key]: values[key].trim() }); };
  const finish = () => {
    if (!values) return;
    const patch: Partial<MistSettings> = {};
    for (const key of Object.keys(dirty.current) as TextKey[]) if (dirty.current[key]) patch[key] = values[key].trim();
    if (Object.keys(patch).length) void save(patch, '工作区设置已保存'); else toast('当前设置已同步');
  };
  const saveCurrency=(defaultCurrency:string)=>{if(!settings)return;void save({companyProfile:{legalName:'',englishName:'',address:'',englishAddress:'',phone:'',email:'',taxId:'',customsCode:'',bankName:'',bankAccount:'',swift:'',...(settings.companyProfile||{}),defaultCurrency}});};
  const notify = (key: keyof MistSettings['notifications'], value: boolean) => settings && void save({ notifications: { ...settings.notifications, [key]: value } });
  return (
    <MistPage>
      <PageHeader eyebrow="平台 · 设置" title="系统设置" description="外观、通知与工作空间。选择项即时保存，文字离开输入框后保存。" />
      {(error || workspace.error) && <Banner tone="bad" title={error || workspace.error} actions={<Button size="sm" icon={RefreshCw} onClick={() => { setError(''); void workspace.refresh(); }}>重新读取</Button>} />}
      {pending && !saving && <Banner tone="warn" title="上一次操作结果待核对" actions={<Button size="sm" disabled={saving} onClick={() => void workspace.recover().catch(failure=>setError(failure instanceof Error?failure.message:'原请求核对失败'))}>核对原请求</Button>} />}
      <div className="mist-wizard">
        <VerticalSteps mode="page" current={sec} onSelect={setSec} steps={[
          { id: 'appearance', label: '外观', icon: Palette }, { id: 'notify', label: '通知', icon: Bell },
          { id: 'workspace', label: '工作空间', icon: Building2 }, { id: 'account', label: '账号', icon: User }, { id: 'security', label: '安全', icon: Shield }]} />
        <Card>
          {!settings || !values ? <FormSection title="正在读取设置"><Skeleton height={120} /></FormSection> : <>
          {member && sec !== 'workspace' && sec !== 'security' && <Banner tone="neutral" title="空间设置由所有者维护">你是被授权成员，这些设置作用于整个空间，只能查看，不能修改。</Banner>}
          {sec === 'appearance' && <FormSection title="外观" description="浅色 = 雾蓝 Light Mist，深色 = 深夜 Deep Night。">
            <ChoiceCards<MistSettings['theme']> ariaLabel="主题" disabled={settingsLocked} value={settings.theme} onChange={value => void save({ theme: value })} options={[{ value: 'light', title: '浅色', description: '雾蓝渐变', icon: Sun }, { value: 'dark', title: '深色', description: '深夜蓝渐变', icon: Moon }, { value: 'system', title: '跟随系统', description: '自动切换', icon: Laptop }]} />
            <div style={{ marginTop: 18 }}>
              <SettingRow title="列表密度" description="影响工作区数据表的行高" control={<Select aria-label="列表密度" disabled={settingsLocked} value={settings.density} onChange={event => void save({ density: event.target.value as MistSettings['density'] })} options={[{ value: 'compact', label: '紧凑' }, { value: 'default', label: '标准' }, { value: 'comfy', label: '宽松' }]} />} />
              <SettingRow title="减少动效" description="保存减少动效偏好" control={<Switch ariaLabel="减少动效" checked={settings.reducedMotion} disabled={settingsLocked} onChange={value => void save({ reducedMotion: value })} />} />
            </div>
          </FormSection>}
          {sec === 'notify' && <FormSection title="通知" description="保存工作区通知偏好。">
            <SettingRow title="QC 报告回传" description="显示开发案新评审结论的站内提醒" control={<Switch ariaLabel="QC 报告回传" checked={settings.notifications.qc} disabled={settingsLocked} onChange={value => notify('qc', value)} />} />
            <SettingRow title="出运准备提醒" description="显示交期与出运准备事项的站内提醒" control={<Switch ariaLabel="出运准备提醒" checked={settings.notifications.shipping} disabled={settingsLocked} onChange={value => notify('shipping', value)} />} />
            <SettingRow title="小竹主动建议" description="保存主动建议的通知偏好" control={<Switch ariaLabel="小竹主动建议" checked={settings.notifications.suggestions} disabled={settingsLocked} onChange={value => notify('suggestions', value)} />} />
            <SettingRow title="站内每日摘要" description="在工作区显示每日摘要，不发送邮件" control={<Switch ariaLabel="站内每日摘要" checked={settings.notifications.digest} disabled={settingsLocked} onChange={value => notify('digest', value)} />} />
          </FormSection>}
          {sec === 'workspace' && <FormSection title="工作空间" description={`${workspace.workspace?.name ?? settings.workspaceName} · ${member ? '你被授权进入的空间，设置由所有者维护' : '当前账号的工作空间'}`}>
            <FormGrid><Field label="名称"><TextInput aria-label="工作空间名称" value={values.workspaceName} disabled={settingsLocked} onChange={event => edit('workspaceName', event.target.value)} onBlur={() => saveField('workspaceName')} /></Field><Field label="默认币种" hint="用于新建资料；客户与来源单据的币种优先"><Select aria-label="默认币种" disabled={settingsLocked} value={settings.companyProfile?.defaultCurrency||'USD'} options={[...new Set(['USD','EUR','CNY','GBP','HKD',settings.companyProfile?.defaultCurrency||'USD'])]} onChange={event=>saveCurrency(event.target.value)} /></Field>
              <Field label="时区" hint="当前设备时区，只读"><Select disabled options={[Intl.DateTimeFormat().resolvedOptions().timeZone]} /></Field><Field label="单号前缀" hint="由业务命令生成"><TextInput value="自动生成" disabled className="mist-mono" /></Field></FormGrid>
          </FormSection>}
          {sec === 'workspace' && <WorkspaceMembers busy={busy} />}
          {sec === 'account' && <FormSection title="账号" description="工作区显示资料，不改变登录账号、邮箱或密码。"><FormGrid><Field label="姓名"><TextInput aria-label="显示姓名" value={values.profileName} disabled={settingsLocked} onChange={event => edit('profileName', event.target.value)} onBlur={() => saveField('profileName')} /></Field><Field label="邮箱"><TextInput aria-label="显示邮箱" type="email" value={values.profileEmail} disabled={settingsLocked} onChange={event => edit('profileEmail', event.target.value)} onBlur={() => saveField('profileEmail')} /></Field>
            <Field label="语言偏好" hint="保存偏好，不改变当前页面文案"><Select aria-label="工作区语言" disabled={settingsLocked} value={values.locale} onChange={event => { edit('locale', event.target.value); void save({ locale: event.target.value }); }} options={[{ value: 'zh-CN', label: '简体中文' }, { value: 'en-US', label: 'English' }]} /></Field></FormGrid></FormSection>}
          {sec === 'security' && <FormSection title="安全">
            {!session.localMode && <ChangePasswordRow />}
            <SettingRow title="两步验证" description={session.localMode?'本地工作身份不使用密码，两步验证不适用':'当前工作区尚未接入认证 MFA 设置'} control={<Switch ariaLabel="两步验证" checked={false} disabled onChange={() => undefined} />} />
            <SettingRow title="退出所有设备" description={session.localMode?'本地身份由本机服务提供，设备会话管理不适用':'暂未提供批量撤销认证会话的接口'} control={<Button size="sm" disabled>{session.localMode?'不适用':'未接入'}</Button>} />
            <SettingRow title="移入回收站" description="保留所有记录与附件；待审批事项须先处理。移入后切换到其他可用工作空间。" control={<Button size="sm" variant="danger" icon={Trash2} disabled={busy||!workspace.archiveWorkspace||workspace.workspace?.ownerId!==session.user?.id} onClick={()=>setLifecycle({action:'archive',name:workspace.workspace?.name||settings.workspaceName})}>移入回收站</Button>} />
            <SettingRow title="回收站" description="只能恢复当前账号所属的工作空间；恢复后切换到该空间。" control={<Button size="sm" disabled={busy||!workspace.refreshArchived} onClick={()=>void workspace.refreshArchived?.().catch(failure=>setError(failure instanceof Error?failure.message:'回收站读取失败'))}>刷新回收站</Button>} />
            {(workspace.archivedWorkspaces??[]).map(row=><SettingRow key={row.id} title={row.name} description={'移入时间：'+new Date(row.archivedAt).toLocaleString()} control={<Button size="sm" disabled={busy||!workspace.restoreWorkspace} onClick={()=>setLifecycle({action:'restore',id:row.id,name:row.name})}>恢复</Button>}/>)}
            {!workspace.archivedWorkspaces?.length&&<p className="mist-note">回收站为空。</p>}
          </FormSection>}
          </>}
          <div className="mist-sticky-foot"><span className="mist-note">{saving ? '正在保存…' : '选择项即时保存，文字离开输入框后保存'}</span><span className="mist-spacer" /><Button variant="primary" disabled={busy || !settings} loading={saving} onClick={finish}>完成</Button></div>
        </Card>
      </div>
      <Dialog open={!!lifecycle} onClose={()=>{if(!lifecycleBusy)setLifecycle(null);}} title={lifecycle?.action==='archive'?'移入回收站':'恢复工作空间'} footer={<><Button disabled={lifecycleBusy} onClick={()=>setLifecycle(null)}>取消</Button><Button variant={lifecycle?.action==='archive'?'danger':'primary'} disabled={busy} loading={lifecycleBusy} onClick={()=>void confirmLifecycle()}>{lifecycle?.action==='archive'?'确认移入回收站':'确认恢复'}</Button></>}>
        <p>{lifecycle?.name}</p><p>{lifecycle?.action==='archive'?'这不会永久删除数据或附件。若没有其他可用空间，系统会创建一个新的空白工作空间。':'原有记录、附件和业务状态将恢复，并切换到该工作空间。'}</p>{error&&<Banner tone="bad" title="操作未完成">{error}</Banner>}
      </Dialog>
    </MistPage>
  );
}
