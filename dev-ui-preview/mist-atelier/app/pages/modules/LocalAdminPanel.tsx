/** T10 local company settings. Saves exclusively through the active Mist workspace. */
import React from 'react';
import { Building2, FolderOpen, Landmark, Laptop, RefreshCw, Sparkles } from 'lucide-react';
import {
  Banner, Button, Card, EmptyState, Field, FormGrid, FormSection, KeyValue, MistPage,
  PageHeader, Pill, Skeleton, TextInput, VerticalSteps, useToast,
} from '../../../../../components/mist';
import type { MistSettings } from '../../../../../server/src/shared/mistWorkspace';
import { useMistSession } from '../../runtime/auth';
import { useMistWorkspace } from '../../runtime/workspace';
import { AiSubscriptionPanel } from './AiSubscriptionPanel';

export type LocalCompanyProfile = {
  legalName: string;
  englishName: string;
  address: string;
  englishAddress: string;
  phone: string;
  email: string;
  taxId: string;
  customsCode: string;
  bankName: string;
  bankAccount: string;
  swift: string;
  defaultCurrency: string;
};

type LocalSettings = MistSettings & { companyProfile?: LocalCompanyProfile };
type WorkspaceDetails = Pick<MistSettings, 'workspaceName' | 'profileName' | 'profileEmail'>;
type DraftValues = WorkspaceDetails & LocalCompanyProfile;
type DraftKey = keyof DraftValues;
type ProfileField = { key: keyof LocalCompanyProfile; label: string; type?: React.HTMLInputTypeAttribute; hint?: string };

const COMPANY_FIELDS: ProfileField[] = [
  { key: 'legalName', label: '公司中文抬头' },
  { key: 'englishName', label: '公司英文抬头' },
  { key: 'address', label: '中文地址' },
  { key: 'englishAddress', label: '英文地址' },
  { key: 'phone', label: '联系电话', type: 'tel' },
  { key: 'email', label: '公司联系邮箱', type: 'email' },
];
const EXPORT_FIELDS: ProfileField[] = [
  { key: 'taxId', label: '税务登记编号' },
  { key: 'customsCode', label: '海关登记编码' },
  { key: 'bankName', label: '收款银行名称' },
  { key: 'bankAccount', label: '收款账号' },
  { key: 'swift', label: 'SWIFT / BIC' },
  { key: 'defaultCurrency', label: '常用结算币种', hint: '填写三位币种代码，例如 USD。业务单据仍逐单确认币种。' },
];
const EMPTY_COMPANY: LocalCompanyProfile = {
  legalName: '', englishName: '', address: '', englishAddress: '', phone: '', email: '',
  taxId: '', customsCode: '', bankName: '', bankAccount: '', swift: '', defaultCurrency: '',
};

function readDraft(settings?: LocalSettings): DraftValues {
  return {
    workspaceName: settings?.workspaceName ?? '',
    profileName: settings?.profileName ?? '',
    profileEmail: settings?.profileEmail ?? '',
    ...EMPTY_COMPANY,
    ...settings?.companyProfile,
  };
}

export function validateLocalCompanyDraft(values: DraftValues): string {
  if (!values.workspaceName.trim() || values.workspaceName.trim().length > 120) return '工作空间名称须为1至120字';
  if (!values.profileName.trim() || values.profileName.trim().length > 120) return '显示姓名须为1至120字';
  const profileKeys = Object.keys(EMPTY_COMPANY) as Array<keyof LocalCompanyProfile>;
  if (profileKeys.some(key => values[key].trim()) && !values.legalName.trim() && !values.englishName.trim()) return '请填写中文或英文公司抬头';
  for (const key of profileKeys) {
    const limit = key === 'address' || key === 'englishAddress' ? 500 : 240;
    if (values[key].length > limit) return `${[...COMPANY_FIELDS, ...EXPORT_FIELDS].find(field => field.key === key)?.label}不能超过${limit}字`;
  }
  for (const [key, label] of [['email', '公司联系邮箱'], ['profileEmail', '显示邮箱']] as const) {
    if (values[key].trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values[key].trim())) return `${label}格式不正确`;
  }
  if (values.defaultCurrency.trim() && !/^[A-Z]{3}$/.test(values.defaultCurrency.trim().toUpperCase())) return '常用结算币种须为三位英文字母';
  return '';
}

export function LocalAdminPanel() {
  const workspace = useMistWorkspace();
  const session = useMistSession();
  const toast = useToast();
  const localMode = (session as { localMode?: boolean }).localMode === true;
  const scope = `${session.sessionKey}:${workspace.workspace?.id ?? ''}`;
  const currentScope = React.useRef(scope);
  currentScope.current = scope;
  const mounted = React.useRef(false);
  const savingRef = React.useRef(false);
  const dirty = React.useRef(new Set<DraftKey>());
  const [section, setSection] = React.useState('company');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState<{ scope: string; values: DraftValues }>(() => ({ scope, values: readDraft(workspace.state?.settings) }));

  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => {
    dirty.current.clear(); savingRef.current = false; setBusy(false); setError('');
    setDraft({ scope, values: readDraft(workspace.state?.settings) });
  }, [scope]);
  React.useEffect(() => {
    if (!workspace.state) return;
    setDraft(previous => {
      const values = readDraft(workspace.state?.settings);
      if (previous.scope === scope) for (const key of dirty.current) values[key] = previous.values[key];
      return { scope, values };
    });
  }, [workspace.state?.settings, scope]);

  const values = draft.scope === scope ? draft.values : readDraft(workspace.state?.settings);
  const blocked = !localMode || !workspace.state || workspace.loading || workspace.saving || !!workspace.pending || !!workspace.pendingCreate || busy;
  const edit = (key: DraftKey, value: string) => {
    dirty.current.add(key);
    setDraft(previous => ({ scope, values: { ...(previous.scope === scope ? previous.values : readDraft(workspace.state?.settings)), [key]: value } }));
    setError('');
  };
  const save = async () => {
    if (blocked || savingRef.current) return;
    const problem = validateLocalCompanyDraft(values);
    if (problem) { setError(problem); return; }
    const boundScope = scope;
    const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])) as DraftValues;
    normalized.defaultCurrency = normalized.defaultCurrency.toUpperCase();
    const companyProfile = Object.fromEntries((Object.keys(EMPTY_COMPANY) as Array<keyof LocalCompanyProfile>).map(key => [key, normalized[key]])) as LocalCompanyProfile;
    const payload: Partial<MistSettings> & { companyProfile: LocalCompanyProfile } = {
      workspaceName: normalized.workspaceName, profileName: normalized.profileName,
      profileEmail: normalized.profileEmail, companyProfile,
    };
    savingRef.current = true; setBusy(true); setError('');
    try {
      await workspace.run({ type: 'settings.update', payload });
      if (!mounted.current || currentScope.current !== boundScope) return;
      dirty.current.clear(); setDraft({ scope: boundScope, values: normalized });
      toast('本地公司与空间资料已保存');
    } catch (failure) {
      if (mounted.current && currentScope.current === boundScope) setError(failure instanceof Error ? failure.message : '本地资料保存失败');
    } finally {
      if (mounted.current && currentScope.current === boundScope) { savingRef.current = false; setBusy(false); }
    }
  };
  const recover = async () => {
    const boundScope=scope;
    try { await workspace.recover(); }
    catch(failure){if(mounted.current&&currentScope.current===boundScope)setError(failure instanceof Error?failure.message:'原请求核对失败');}
  };

  if (!localMode) return <MistPage><PageHeader title="管理后台" /><Card><EmptyState title="此资料页仅用于本地工作空间" description="当前会话使用服务器账号，请打开对应的服务器管理设置。" /></Card></MistPage>;

  const fields = section === 'company' ? COMPANY_FIELDS : EXPORT_FIELDS;
  return <MistPage>
    <PageHeader eyebrow="平台 · 本地工作空间" title="管理后台" description="维护当前本地空间的公司抬头、出口方和收款资料。" actions={<Pill tone="neutral">本地开发模式</Pill>} />
    {(error || workspace.error) && <Banner tone="bad" title="资料尚未保存" actions={workspace.error ? <Button icon={RefreshCw} disabled={busy} onClick={() => void workspace.refresh()}>重新读取</Button> : undefined}>{error || workspace.error}</Banner>}
    {workspace.pending && <Banner tone="warn" title="上一次保存结果待核对" actions={<Button disabled={busy || workspace.saving} onClick={() => void recover()}>核对原请求</Button>}>输入已保留，核对完成后再继续保存。</Banner>}
    <div className="mist-wizard">
      <VerticalSteps mode="page" current={section} onSelect={setSection} steps={[
        { id: 'company', label: '公司抬头', icon: Building2 },
        { id: 'export', label: '出口与收款', icon: Landmark },
        { id: 'workspace', label: '当前空间', icon: FolderOpen },
        { id: 'local', label: '本地使用', icon: Laptop },
        ...(session.hasRole?.('owner') ? [{ id: 'ai', label: '平台 AI 模型', icon: Sparkles }] : []),
      ]} />
      <Card>
        {!workspace.state ? <FormSection title="正在读取本地空间"><Skeleton height={180} /></FormSection> : <>
          {(section === 'company' || section === 'export') && <FormSection title={section === 'company' ? '公司抬头与联系方式' : '出口与收款资料'} description={section === 'company' ? '按实际公司资料填写。未录入的信息保持空白。' : '保存实际登记与银行资料，不会替代报关、付款或专业审核。'}>
            <FormGrid>{fields.map(field => <Field key={field.key} label={field.label} hint={field.hint} full={field.key === 'address' || field.key === 'englishAddress'}>
              <TextInput aria-label={field.label} type={field.type ?? 'text'} value={values[field.key]} disabled={blocked} onChange={event => edit(field.key, event.target.value)} />
            </Field>)}</FormGrid>
          </FormSection>}
          {section === 'workspace' && <FormSection title="当前工作空间" description="这些显示资料只属于当前空间，不会修改登录账号或其他空间。">
            <FormGrid>
              <Field label="工作空间名称" required><TextInput aria-label="工作空间名称" value={values.workspaceName} disabled={blocked} onChange={event => edit('workspaceName', event.target.value)} /></Field>
              <Field label="显示姓名" required><TextInput aria-label="显示姓名" value={values.profileName} disabled={blocked} onChange={event => edit('profileName', event.target.value)} /></Field>
              <Field label="显示邮箱"><TextInput aria-label="显示邮箱" type="email" value={values.profileEmail} disabled={blocked} onChange={event => edit('profileEmail', event.target.value)} /></Field>
              <Field label="当前设备时区"><TextInput value={Intl.DateTimeFormat().resolvedOptions().timeZone} readOnly /></Field>
            </FormGrid>
          </FormSection>}
          {section === 'local' && <FormSection title="本地开发模式" description="用于在当前设备上录入与验证完整业务。">
            <Banner tone="neutral" title="资料保存在当前设备">本地身份与公司资料独立于原服务器账号。业务记录保存到当前本地工作空间，切换设备不会自动带走这些资料。</Banner>
            <KeyValue items={[
              { label: '当前身份', value: session.user?.displayName || '本地用户' },
              { label: '当前空间', value: workspace.workspace?.name || values.workspaceName },
              { label: '公司抬头', value: values.legalName || values.englishName || '尚未填写' },
              { label: '外部办理', value: '报关、银行付款等外部事实仍按实际凭证登记。' },
            ]} />
          </FormSection>}
        </>}
        {section === 'ai' && <AiSubscriptionPanel mode="platform" bare sessionKey={session.sessionKey} />}
        {section !== 'ai' && <div className="mist-sticky-foot"><span className="mist-note">{busy || workspace.saving ? '正在保存本地资料…' : '保存后应用于当前本地工作空间'}</span><span className="mist-spacer" /><Button variant="primary" loading={busy} disabled={blocked} onClick={() => void save()}>保存资料</Button></div>}
      </Card>
    </div>
  </MistPage>;
}
