/** 公司资料：系统设置中的唯一维护入口，写入 settings.companyProfile；报价单、CI/PL 生成时读取当前值并冻结快照。 */
import React from 'react';
import { ArrowLeft, RefreshCw, Save } from 'lucide-react';
import { Banner, Button, Field, FormGrid, FormSection, TextInput, useToast } from '../../../../components/mist';
import type { MistCompanyProfile } from '../../../../server/src/shared/mistWorkspace';
import { useMistSession } from '../runtime/auth';
import { useMistWorkspace } from '../runtime/workspace';
import { useNav } from '../nav';

export type CompanyProfileKey = keyof MistCompanyProfile;
export type CompanyProfileField = { key: CompanyProfileKey; label: string; type?: React.HTMLInputTypeAttribute; hint?: string };
export const COMPANY_FIELDS: CompanyProfileField[] = [
  { key: 'legalName', label: '公司中文抬头', hint: '报价单必须有中文抬头才能生成' },
  { key: 'englishName', label: '公司英文抬头' },
  { key: 'address', label: '中文地址' },
  { key: 'englishAddress', label: '英文地址' },
  { key: 'phone', label: '联系电话', type: 'tel' },
  { key: 'email', label: '公司联系邮箱', type: 'email' },
];
export const EXPORT_FIELDS: CompanyProfileField[] = [
  { key: 'taxId', label: '税务登记编号' },
  { key: 'customsCode', label: '海关登记编码' },
  { key: 'bankName', label: '收款银行名称' },
  { key: 'bankAccount', label: '收款账号' },
  { key: 'swift', label: 'SWIFT / BIC' },
  { key: 'defaultCurrency', label: '常用结算币种', hint: '三位币种代码，例如 USD。业务单据仍逐单确认币种。' },
];
export const EMPTY_COMPANY: MistCompanyProfile = {
  legalName: '', englishName: '', address: '', englishAddress: '', phone: '', email: '',
  taxId: '', customsCode: '', bankName: '', bankAccount: '', swift: '', defaultCurrency: '',
};
const KEYS = Object.keys(EMPTY_COMPANY) as CompanyProfileKey[];
const label = (key: CompanyProfileKey) => [...COMPANY_FIELDS, ...EXPORT_FIELDS].find(field => field.key === key)!.label;
export const readCompanyProfile = (profile?: Partial<MistCompanyProfile>): MistCompanyProfile => ({ ...EMPTY_COMPANY, ...profile });

/** 返回可直接展示的错误，并指出字段；服务端用同一规则兜底。 */
export function validateCompanyProfile(values: MistCompanyProfile): { key?: CompanyProfileKey; message: string } | null {
  if (KEYS.some(key => values[key].trim()) && !values.legalName.trim() && !values.englishName.trim()) return { key: 'legalName', message: '请填写中文或英文公司抬头' };
  for (const key of KEYS) { const limit = key === 'address' || key === 'englishAddress' ? 500 : 240; if (values[key].length > limit) return { key, message: `${label(key)}不能超过${limit}字` }; }
  if (values.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) return { key: 'email', message: '公司联系邮箱格式不正确，请填写如 name@example.com 的完整地址' };
  if (values.defaultCurrency.trim() && !/^[A-Z]{3}$/.test(values.defaultCurrency.trim().toUpperCase())) return { key: 'defaultCurrency', message: '常用结算币种须为三位英文字母，如 USD、CNY、EUR' };
  return null;
}

export function CompanyProfileSection({ member }: { member: boolean }) {
  const workspace = useMistWorkspace(), session = useMistSession(), toast = useToast(), nav = useNav();
  const scope = `${session.sessionKey}:${workspace.workspace?.id ?? ''}`, activeScope = React.useRef(scope); activeScope.current = scope;
  const stored = workspace.state?.settings.companyProfile;
  const host = React.useRef<HTMLDivElement>(null), dirty = React.useRef(new Set<CompanyProfileKey>()), working = React.useRef(false), mounted = React.useRef(false);
  const [draft, setDraft] = React.useState(() => ({ scope, values: readCompanyProfile(stored) }));
  const [problem, setProblem] = React.useState<{ key?: CompanyProfileKey; message: string } | null>(null), [busy, setBusy] = React.useState(false), [saved, setSaved] = React.useState(false);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // 切换账号或空间：丢弃草稿与错误，绝不把上一空间的资料带入。
  React.useEffect(() => { dirty.current.clear(); working.current = false; setBusy(false); setProblem(null); setSaved(false); setDraft({ scope, values: readCompanyProfile(workspace.state?.settings.companyProfile) }); }, [scope]);
  // 读回服务端最新值；只保留本空间内正在编辑的字段。
  React.useEffect(() => { setDraft(previous => { const values = readCompanyProfile(stored); if (previous.scope === scope) for (const key of dirty.current) values[key] = previous.values[key]; return { scope, values }; }); }, [stored, scope]);
  const values = draft.scope === scope ? draft.values : readCompanyProfile(stored);
  const locked = member || !workspace.state || workspace.loading || workspace.saving || !!workspace.pending || !!workspace.pendingCreate || busy;
  const empty = !KEYS.some(key => stored?.[key]?.trim());
  const returnId = nav?.route?.section === 'company' && nav.route.id ? nav.route.id : undefined;
  const edit = (key: CompanyProfileKey, value: string) => { dirty.current.add(key); setSaved(false); setProblem(current => current?.key === key || !current?.key ? null : current); setDraft(previous => ({ scope, values: { ...(previous.scope === scope ? previous.values : readCompanyProfile(stored)), [key]: value } })); };
  const save = async () => {
    if (locked || working.current) return;
    const normalized = Object.fromEntries(KEYS.map(key => [key, values[key].trim()])) as MistCompanyProfile; normalized.defaultCurrency = normalized.defaultCurrency.toUpperCase();
    const invalid = validateCompanyProfile(normalized);
    if (invalid) { setProblem(invalid); const target = invalid.key && host.current?.querySelector<HTMLInputElement>(`input[aria-label="${label(invalid.key)}"]`); if (target) { target.focus(); target.scrollIntoView?.({ block: 'center' }); } return; }
    const changed = KEYS.filter(key => dirty.current.has(key) && normalized[key] !== (stored?.[key] ?? ''));
    if (!changed.length) { dirty.current.clear(); toast('公司资料没有改动'); return; }
    // 只提交改动的字段；服务端按字段合并，未提交的字段保持原值。
    const companyProfile = Object.fromEntries(changed.map(key => [key, normalized[key]])) as Partial<MistCompanyProfile>;
    const bound = scope; working.current = true; setBusy(true); setProblem(null);
    try {
      await workspace.run({ type: 'settings.update', payload: { companyProfile } });
      if (!mounted.current || activeScope.current !== bound) return;
      for (const key of changed) dirty.current.delete(key);
      setDraft(previous => ({ scope: bound, values: { ...previous.values, ...companyProfile } }));
      setSaved(true); toast('公司资料已保存');
    } catch (failure) {
      // 保存失败保留草稿（dirty 不清），用户可修正后重试。
      if (mounted.current && activeScope.current === bound) { const message = failure instanceof Error ? failure.message : '公司资料保存失败'; setProblem({ message }); toast(message, 'bad'); }
    } finally { if (mounted.current && activeScope.current === bound) { working.current = false; setBusy(false); } }
  };
  const field = (f: CompanyProfileField) => <Field key={f.key} label={f.label} hint={problem?.key === f.key ? undefined : f.hint} error={problem?.key === f.key ? problem.message : undefined}>
    <TextInput aria-label={f.label} type={f.type} value={values[f.key]} disabled={locked} maxLength={f.key === 'defaultCurrency' ? 3 : undefined} className={f.key === 'defaultCurrency' || f.key === 'swift' || f.key === 'bankAccount' ? 'mist-mono' : undefined} onChange={event => edit(f.key, event.target.value)} />
  </Field>;
  const notices = member || empty || !stored?.legalName?.trim() || (problem && !problem.key);
  return <div data-company-profile ref={host}>
    <FormSection title="公司资料" description="报价单、CI / PL 的抬头、地址与收款信息取自这里。保存后新生成的单据使用当前资料，已生成的单据保持原样。">
      {notices && <div className="mist-col" style={{ gap: 12, marginBottom: 16 }}>
      {member && <Banner tone="neutral" title="公司资料由空间所有者维护">{empty ? '当前空间尚未填写公司资料，生成报价单需要中文公司抬头，请联系空间所有者补全。' : '你是被授权成员，可以查看，不能修改。'}</Banner>}
      {!member && empty && <Banner tone="neutral" title="尚未填写公司资料">至少填写公司中文抬头后才能生成报价单；其余字段按需补全。印章图样不在此维护。</Banner>}
      {!member && !empty && !stored?.legalName?.trim() && <Banner tone="warn" title="缺少公司中文抬头">报价单需要中文抬头，补全后才能生成。</Banner>}
      {problem && !problem.key && <Banner tone="bad" title="公司资料未保存" actions={<Button size="sm" icon={RefreshCw} disabled={locked} onClick={() => { setProblem(null); void workspace.refresh(); }}>重新读取</Button>}>{problem.message}。已填写的内容仍保留，可修改后重新保存。</Banner>}
      </div>}
      <FormGrid>{COMPANY_FIELDS.map(field)}</FormGrid>
    </FormSection>
    <FormSection title="出口与收款" description="税号、海关编码与收款银行，用于对外单据。">
      <FormGrid>{EXPORT_FIELDS.map(field)}</FormGrid>
    </FormSection>
    <div className="mist-sticky-foot">
      <span className="mist-note">{busy ? '正在保存…' : saved ? '已保存，新生成的单据将使用当前资料' : member ? '只读' : '填写后点击保存'}</span><span className="mist-spacer" />
      {returnId && <Button icon={ArrowLeft} disabled={busy} onClick={() => nav?.go('quotations', returnId)}>返回报价</Button>}
      {!member && <Button variant="primary" icon={Save} disabled={locked} loading={busy} onClick={() => void save()}>保存公司资料</Button>}
    </div>
  </div>;
}
