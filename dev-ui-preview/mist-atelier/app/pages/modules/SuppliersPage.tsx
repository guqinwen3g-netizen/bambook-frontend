/** 供应商管理：类型 / 合作状态筛选，档案含产能工艺、认证有效期、评级历史、在手业务与交付表现；暂停 / 停用按生效日阻止新增业务。 */
import React from 'react';
import { Award, Ban, Building2, Download, FileBadge, Pause, Pencil, Play, Plus, Scale, SearchX, UserPlus } from 'lucide-react';
import { Banner, Button, Card, DataTable, Dropdown, EmptyState, Facts, MistPage, Mono, ObjectCell, PageHeader, Pill, Pipeline, SearchField, Timeline, Toolbar, type Column, type Tone } from '../../../../../components/mist';
import type { MistState } from '../../../../../server/src/shared/mistWorkspace';
import type { FulfillmentPurchase } from '../../../../../server/src/shared/mistFulfillment';
import { SUPPLIER_GRADES, SUPPLIER_TYPES, marketBusinessDate, supplierGrade, type MarketSupplier, type SupplierCertificate } from '../../../../../server/src/shared/mistMarket';
import { supplierStatusOn } from '../../../../../server/src/shared/mistSupplierStatus';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { memberSelectOptions, workspaceMembers } from '../../runtime/members';
import { MIST_BUSINESS_GROUPS, MIST_BUSINESS_GROUP_LABEL } from '../../../../../server/src/shared/mistAccounts';
import { useNav } from '../../nav';
import { ModuleEditorDialog, downloadModuleCsv, type ModuleEditorSpec } from './ModuleWorkbench';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen } from './pageKit';

type StatusFilter = 'all' | 'active' | 'paused' | 'blocked';
type FlagFilter = 'all' | 'certExpiring' | 'certExpired' | 'noCert' | 'unrated' | 'scheduled';
const CERT_NEAR_DAYS = 30;
const STATUS_LABEL: Record<MarketSupplier['status'], string> = { active: '合作中', paused: '已暂停', blocked: '已停用' };
const STATUS_TONE: Record<MarketSupplier['status'], Tone> = { active: 'ok', paused: 'warn', blocked: 'bad' };
const GRADE_TONE: Record<string, Tone> = { A: 'ok', B: 'accent', C: 'warn', D: 'bad' };
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

export function certificateState(c: SupplierCertificate, day: string): { tone: Tone; label: string; key: 'expired' | 'expiring' | 'valid' } {
  const left = daysBetween(day, c.validUntil);
  return left < 0 ? { tone: 'bad', label: `已过期 ${-left} 天`, key: 'expired' } : left <= CERT_NEAR_DAYS ? { tone: 'warn', label: `${left} 天后到期`, key: 'expiring' } : { tone: 'neutral', label: `有效至 ${c.validUntil}`, key: 'valid' };
}

/** 采购事实推导的供应表现：到货 = 合格 + 退回；准交按最后一次到货日对比供应商确认交期（无确认用要求交期）。 */
export function supplierPerformance(state: MistState | null, supplierId: string) {
  const purchases = (state?.fulfillment.purchases || []).filter(p => p.supplierId === supplierId);
  const receiptsOf = (p: FulfillmentPurchase) => (state?.fulfillment.receipts || []).filter(r => r.purchaseId === p.id);
  const arrived = (p: FulfillmentPurchase) => receiptsOf(p).reduce((n, r) => n + r.quantity + r.rejected, 0);
  const promised = (p: FulfillmentPurchase) => p.supplierConfirmation?.confirmedDue || p.due;
  const open = purchases.filter(p => p.state !== 'rejected' && arrived(p) < p.quantity);
  const completed = purchases.filter(p => p.state === 'approved' && arrived(p) >= p.quantity).map(p => { const last = receiptsOf(p).map(r => r.date).sort().pop() || ''; return { purchase: p, last, promised: promised(p), onTime: !!last && last <= promised(p) }; });
  const receipts = purchases.flatMap(receiptsOf);
  return { purchases, open, completed, onTime: completed.filter(c => c.onTime).length, receipts: receipts.length, clean: receipts.filter(r => r.rejected === 0).length, arrived, promised };
}
const rate = (part: number, whole: number) => whole ? Math.round(part / whole * 100) + '%' : '—';
const purchaseStage = (p: FulfillmentPurchase) => p.state === 'draft' ? '草稿' : p.state === 'pending' ? '待审批' : p.state === 'rejected' ? '已退回' : p.supplierConfirmation ? '供应商已确认' : p.offlineSend ? '已发送待确认' : '已批准待发送';

export function supplierFlags(s: MarketSupplier, day: string) {
  const flags: Array<{ key: Exclude<FlagFilter, 'all'>; label: string; tone: Tone }> = [];
  const certs = (s.certificates || []).map(c => certificateState(c, day));
  if (certs.some(c => c.key === 'expired')) flags.push({ key: 'certExpired', label: '认证已过期', tone: 'bad' });
  if (certs.some(c => c.key === 'expiring')) flags.push({ key: 'certExpiring', label: `认证 ${CERT_NEAR_DAYS} 天内到期`, tone: 'warn' });
  if (!certs.length) flags.push({ key: 'noCert', label: '未登记认证', tone: 'neutral' });
  if (!s.ratings?.length) flags.push({ key: 'unrated', label: '未评级', tone: 'neutral' });
  if (s.status !== 'active' && supplierStatusOn(s, day) === 'active') flags.push({ key: 'scheduled', label: `${s.statusFrom} 起${s.status === 'paused' ? '暂停' : '停用'}`, tone: 'warn' });
  return flags;
}

export type SupplierWorkbenchProps = {
  attachments: (s: MarketSupplier, locked: boolean) => React.ReactNode;
  history: (id: string) => React.ReactNode;
};

export function SupplierWorkbench({ attachments, history }: SupplierWorkbenchProps) {
  const { state, run, error, refresh, loading, saving, pending, workspace } = useMistWorkspace(), session = useMistSession(), { go, route } = useNav();
  const members = workspaceMembers(workspace, state, session.user);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all'), [typeFilter, setTypeFilter] = React.useState('all'), [flagFilter, setFlagFilter] = React.useState<FlagFilter>('all'), [query, setQuery] = React.useState('');
  const [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(!!route.id);
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null);
  React.useEffect(() => { if (route.id) setPicked(route.id); }, [route.id]);
  const day = marketBusinessDate(new Date());
  const all = state?.market.suppliers || [];
  const statusNow = (s: MarketSupplier) => supplierStatusOn(s, day);
  const needle = query.trim().toLowerCase();
  const legacyTypes = [...new Set(all.map(s => s.type).filter(t => !(SUPPLIER_TYPES as readonly string[]).includes(t)))];
  const searched = all.filter(s => (!needle || `${s.code} ${s.name} ${s.type} ${s.capabilities} ${s.address} ${s.contacts.map(c => c.name).join(' ')}`.toLowerCase().includes(needle))
    && (typeFilter === 'all' || s.type === typeFilter) && (flagFilter === 'all' || supplierFlags(s, day).some(f => f.key === flagFilter)));
  const statusCount = (v: StatusFilter) => searched.filter(s => v === 'all' || statusNow(s) === v).length;
  const perf = React.useMemo(() => new Map(all.map(s => [s.id, supplierPerformance(state, s.id)])), [state, all]);
  const rows = searched.filter(s => statusFilter === 'all' || statusNow(s) === statusFilter).sort((a, b) => ['active', 'paused', 'blocked'].indexOf(statusNow(a)) - ['active', 'paused', 'blocked'].indexOf(statusNow(b)) || a.code.localeCompare(b.code));
  const selected = rows.find(s => s.id === picked) || (picked ? all.find(s => s.id === picked) : undefined);
  // P6：档案 / 认证 / 联系人需 suppliers:write（业务员即有）；评级与暂停 / 停用 / 恢复需 suppliers:admin。服务端同样校验。
  const can = session.hasPermission('suppliers:write'), canAdmin = session.hasPermission('suppliers:admin'), canContacts = can;
  const locked = saving || !!pending;
  const pick = (s: MarketSupplier) => { setPicked(s.id); setDrawer(true); const { view, id: _id, ...target } = route; go(view, s.id, target); };
  const typeOptions = (current = '') => [...SUPPLIER_TYPES, ...(current && !(SUPPLIER_TYPES as readonly string[]).includes(current) ? [current] : [])].map(t => ({ value: t, label: t }));
  const profileSpec = (s?: MarketSupplier): ModuleEditorSpec => ({
    title: s ? `编辑供应商 ${s.name}` : '新增供应商', submitLabel: '保存',
    initialValues: { ...(s ? { code: s.code, name: s.name, type: s.type, country: s.country, address: s.address, capabilities: s.capabilities, capacity: s.capacity, capacityUnit: s.capacityUnit, leadDays: s.leadDays, note: s.note } : { code: '', name: '', type: '织造', country: '中国', address: '', capabilities: '', capacity: 0, capacityUnit: '米/月', leadDays: 0, note: '' }), ...Object.fromEntries(MIST_BUSINESS_GROUPS.map(g => ['handler:' + g, s?.handlers?.[g]?.id || ''])) },
    sections: [{ id: 'id', label: '身份', fields: ['code', 'name', 'type', 'country', 'address'] }, { id: 'cap', label: '产能与工艺', fields: ['capabilities', 'capacity', 'capacityUnit', 'leadDays', 'note'] }, { id: 'handlers', label: '经手人', fields: MIST_BUSINESS_GROUPS.map(g => 'handler:' + g) }],
    fields: [
      { key: 'code', label: '供应商编码', required: true }, { key: 'name', label: '名称', required: true },
      { key: 'type', label: '供应商类型', type: 'select', required: true, options: typeOptions(s?.type) },
      { key: 'country', label: '国家地区' }, { key: 'address', label: '实际生产地址' },
      { key: 'capabilities', label: '工艺与生产能力', type: 'textarea', required: true },
      { key: 'capacity', label: '月产能', type: 'number', min: 0 }, { key: 'capacityUnit', label: '产能单位', required: true, hint: '例如 米/月、件/月、粒/月；不同单位的产能不会合计' },
      { key: 'leadDays', label: '通常交付周期（天）', type: 'number', min: 0 }, { key: 'note', label: '备注', type: 'textarea' },
      ...MIST_BUSINESS_GROUPS.map(g => ({ key: 'handler:' + g, label: `${MIST_BUSINESS_GROUP_LABEL[g]}经手人`, type: 'select' as const, hint: `每组一人，从${MIST_BUSINESS_GROUP_LABEL[g]}业务组成员中按账号选择；业务组在“设置 · 工作空间”由所有者设置`, options: [{ value: '', label: '未指定' }, ...memberSelectOptions(members, { group: g, current: s?.handlers?.[g] })] })),
    ],
    submit: async v => { const r = await run({ type: 'market.supplier.save', payload: { id: s?.id, input: { code: String(v.code ?? ''), name: String(v.name ?? ''), type: String(v.type ?? ''), country: String(v.country ?? ''), address: String(v.address ?? ''), capabilities: String(v.capabilities ?? ''), capacity: Number(v.capacity), capacityUnit: String(v.capacityUnit ?? ''), leadDays: Number(v.leadDays), note: String(v.note ?? ''), fileIds: s?.fileIds || [], handlerIds: Object.fromEntries(MIST_BUSINESS_GROUPS.map(g => [g, String(v['handler:' + g] ?? '')])) } } }); const id = String((r.result as { id?: string }).id || ''); if (!s && id) { setPicked(id); go('suppliers', id); } },
  });
  const certSpec = (s: MarketSupplier, c?: SupplierCertificate): ModuleEditorSpec => ({
    title: c ? `更新认证 ${c.name}` : `登记 ${s.name} 的认证`, submitLabel: '保存', description: '登记供应商已取得的认证与证书有效期；证书原件可在附件中上传。',
    initialValues: c ? { name: c.name, number: c.number, issuer: c.issuer, validUntil: c.validUntil } : { name: '', number: '', issuer: '', validUntil: '' },
    fields: [{ key: 'name', label: '认证名称', required: true, hint: '例如 OEKO-TEX Standard 100、GOTS、GRS、BSCI、ISO 9001' }, { key: 'number', label: '证书编号' }, { key: 'issuer', label: '发证机构' }, { key: 'validUntil', label: '有效期至', type: 'date', required: true }],
    submit: v => run({ type: 'market.supplier.certificate.save', payload: { supplierId: s.id, id: c?.id, name: String(v.name ?? ''), number: String(v.number ?? ''), issuer: String(v.issuer ?? ''), validUntil: String(v.validUntil ?? ''), fileIds: c?.fileIds || [] } }),
  });
  const deleteCertSpec = (s: MarketSupplier, c: SupplierCertificate): ModuleEditorSpec => ({ title: `删除认证 ${c.name}`, submitLabel: '删除', description: '仅在登记错误时删除；过期认证请保留，以便追溯。', initialValues: {}, fields: [], submit: () => run({ type: 'market.supplier.certificate.delete', payload: { supplierId: s.id, id: c.id } }) });
  const rateSpec = (s: MarketSupplier): ModuleEditorSpec => ({
    title: `评级 ${s.name}`, submitLabel: '保存评级', description: '每次评级单独记录，历史评级保留。',
    initialValues: { grade: supplierGrade(s)?.grade || 'B', period: '', note: '' },
    fields: [{ key: 'grade', label: '评级', type: 'select', required: true, options: SUPPLIER_GRADES.map(g => ({ value: g, label: g })) }, { key: 'period', label: '评级周期', required: true, hint: '例如 2026 Q3' }, { key: 'note', label: '评级依据', type: 'textarea', required: true, hint: '准交、品质、响应等事实依据' }],
    submit: v => run({ type: 'market.supplier.rate', payload: { supplierId: s.id, grade: String(v.grade) as typeof SUPPLIER_GRADES[number], period: String(v.period ?? ''), note: String(v.note ?? '') } }),
  });
  const statusSpec = (s: MarketSupplier, next: MarketSupplier['status']): ModuleEditorSpec => {
    const open = perf.get(s.id)?.open || [];
    const handover = open.length ? `在手业务 ${open.length} 单（${open.map(p => p.code).join('、')}）不受影响，将继续执行；如需转给其他供应商，须在采购单上走变更（转移尚未接入）。` : '当前没有在手业务。';
    return next === 'active'
      ? { title: `恢复与 ${s.name} 的合作`, submitLabel: '恢复合作', initialValues: { reason: '' }, fields: [{ key: 'reason', label: '恢复原因', type: 'textarea', required: true, hint: '例如整改复核通过' }], submit: v => run({ type: 'market.supplier.status', payload: { id: s.id, status: 'active', reason: String(v.reason ?? '') } }) }
      : { title: `${next === 'paused' ? '暂停' : '停用'}供应商 ${s.name}`, submitLabel: next === 'paused' ? '暂停合作' : '停用', description: `生效后不能再为该供应商新建采购单或建档引用。${handover}`,
          initialValues: { reason: '', effectiveDate: day }, fields: [{ key: 'reason', label: next === 'paused' ? '暂停原因' : '停用原因', type: 'textarea', required: true }, { key: 'effectiveDate', label: '生效日', type: 'date', required: true, hint: '不能早于今天' }],
          submit: v => run({ type: 'market.supplier.status', payload: { id: s.id, status: next, reason: String(v.reason ?? ''), effectiveDate: String(v.effectiveDate ?? '') } }) };
  };
  const contactSpec = (s: MarketSupplier, c?: MarketSupplier['contacts'][number]): ModuleEditorSpec => ({
    title: c ? `编辑联系人 ${c.name}` : `添加 ${s.name} 的联系人`, submitLabel: '保存', initialValues: c ? { ...c } : { name: '', role: '', email: '', phone: '', primary: !s.contacts.length },
    fields: [{ key: 'name', label: '联系人姓名', required: true }, { key: 'role', label: '岗位' }, { key: 'email', label: '邮箱' }, { key: 'phone', label: '电话' }, { key: 'primary', label: '主联系人', type: 'checkbox' }],
    submit: v => run({ type: 'market.contact.save', payload: { kind: 'supplier', parentId: s.id, id: c?.id, name: String(v.name ?? ''), role: String(v.role ?? ''), email: String(v.email ?? ''), phone: String(v.phone ?? ''), primary: !!v.primary } }),
  });
  const columns: Column<MarketSupplier>[] = [
    { key: 'name', header: '供应商', width: 'minmax(170px,1.3fr)', render: s => <ObjectCell name={s.name} meta={<><Mono>{s.code}</Mono> · {s.type}</>} /> },
    { key: 'grade', header: '评级', width: '64px', render: s => { const g = supplierGrade(s); return g ? <Pill tone={GRADE_TONE[g.grade]}>{g.grade}</Pill> : <span className="mist-muted">—</span>; } },
    { key: 'certs', header: '认证', width: 'minmax(120px,1fr)', hideOnMobile: true, render: s => { const certs = s.certificates || [], worst = certs.map(c => certificateState(c, day)).sort((a, b) => ['expired', 'expiring', 'valid'].indexOf(a.key) - ['expired', 'expiring', 'valid'].indexOf(b.key))[0]; return certs.length ? <span className="mist-col" style={{ gap: 2 }}><span>{certs.map(c => c.name.split(' ')[0]).join(' · ')}</span>{worst && worst.key !== 'valid' && <small className={worst.tone === 'bad' ? 'mist-tone-bad' : 'mist-tone-warn'}>{worst.label}</small>}</span> : <span className="mist-muted">未登记</span>; } },
    { key: 'open', header: '在手', width: '64px', align: 'right', render: s => <span className="mist-num">{perf.get(s.id)?.open.length || 0}</span> },
    { key: 'ontime', header: '准交率', width: '80px', align: 'right', hideOnMobile: true, render: s => { const p = perf.get(s.id); return p?.completed.length ? <span className="mist-col" style={{ gap: 2, alignItems: 'flex-end' }}><span className="mist-num">{rate(p.onTime, p.completed.length)}</span><small className="mist-muted">{p.onTime}/{p.completed.length} 单</small></span> : <span className="mist-muted">—</span>; } },
    { key: 'status', header: '状态', width: '92px', render: s => { const now = statusNow(s), scheduled = supplierFlags(s, day).find(f => f.key === 'scheduled'); return <span className="mist-col" style={{ gap: 2, alignItems: 'flex-start' }}><Pill tone={STATUS_TONE[now]}>{STATUS_LABEL[now]}</Pill>{scheduled && <small className="mist-tone-warn">{scheduled.label}</small>}</span>; } },
  ];
  const empty = all.length
    ? <EmptyState icon={SearchX} title="没有符合条件的供应商" description="换个关键词或清除筛选。" action={<Button onClick={() => { setQuery(''); setStatusFilter('all'); setTypeFilter('all'); setFlagFilter('all'); }}>清除筛选</Button>} />
    : <EmptyState icon={Building2} title="还没有供应商" description="登记织造、染整、印花、成衣加工、辅料等供应商后，采购单才能选择供应商。" action={can ? <Button icon={Plus} onClick={() => setDialog(profileSpec())}>新增供应商</Button> : undefined} />;
  const detail = selected && state
    ? <SupplierDetail s={selected} state={state} day={day} can={can} canAdmin={canAdmin} canContacts={canContacts} locked={locked} perf={perf.get(selected.id)!}
        onEdit={() => setDialog(profileSpec(selected))} onRate={() => setDialog(rateSpec(selected))} onCert={c => setDialog(certSpec(selected, c))} onDeleteCert={c => setDialog(deleteCertSpec(selected, c))}
        onStatus={n => setDialog(statusSpec(selected, n))} onContact={c => setDialog(contactSpec(selected, c))} onOpen={(view, id) => go(view, id)}
        attachments={attachments(selected, !can)} history={history(selected.id)} />
    : <EmptyState icon={Building2} title="供应商档案" description="从左侧列表选择一家供应商，查看认证、评级、在手业务与交付表现。" compact />;
  return <MistPage>
    <PageHeader eyebrow="客户与市场 · 供应商" title="供应商管理" description="认证有效期、评级与交付表现集中查看；暂停或停用按生效日阻止新增业务，在手业务继续执行。"
      actions={<>
        <Button icon={Download} onClick={() => downloadModuleCsv('供应商.csv', ['编码', '名称', '类型', '地址', '工艺与能力', '月产能', '产能单位', '交付周期天', '评级', '认证', '在手单', '准交', '状态'], rows.map(s => { const p = perf.get(s.id); return [s.code, s.name, s.type, s.address, s.capabilities, s.capacity, s.capacityUnit, s.leadDays, supplierGrade(s)?.grade || '', (s.certificates || []).map(c => `${c.name}(${c.validUntil})`).join('；'), p?.open.length || 0, p?.completed.length ? `${p.onTime}/${p.completed.length}` : '', STATUS_LABEL[statusNow(s)]]; }))}>导出</Button>
        {can && <Button variant="primary" icon={Plus} disabled={locked} onClick={() => setDialog(profileSpec())}>新增供应商</Button>}
      </>} />
    {!can && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有供应商写权限，可以查看档案、认证与交付表现。</Banner></div>}
    {error && <div className="mist-section"><Banner tone="bad" title="供应商数据未加载" actions={<Button onClick={() => void refresh()}>重试</Button>}>{error}</Banner></div>}
    <Toolbar>
      <SearchField value={query} onChange={setQuery} placeholder="搜索名称、编码、工艺、地址或联系人" />
      <Dropdown label="类型" value={typeFilter} onChange={setTypeFilter} options={[{ value: 'all', label: '全部' }, ...[...SUPPLIER_TYPES, ...legacyTypes].map(t => ({ value: t, label: `${t} · ${all.filter(s => s.type === t).length}` }))]} />
      <Dropdown<FlagFilter> label="提醒" value={flagFilter} onChange={setFlagFilter} options={[{ value: 'all', label: '全部' }, { value: 'certExpired', label: '认证已过期' }, { value: 'certExpiring', label: `认证 ${CERT_NEAR_DAYS} 天内到期` }, { value: 'noCert', label: '未登记认证' }, { value: 'unrated', label: '未评级' }, { value: 'scheduled', label: '即将暂停 / 停用' }]} />
    </Toolbar>
    <Pipeline<StatusFilter> value={statusFilter} onChange={setStatusFilter} items={[
      { value: 'all', label: '全部', count: statusCount('all'), color: 'var(--mist-ink-2)' },
      { value: 'active', label: '合作中', count: statusCount('active'), color: 'var(--mist-ok)' },
      { value: 'paused', label: '已暂停', count: statusCount('paused'), color: 'var(--mist-warn)' },
      { value: 'blocked', label: '已停用', count: statusCount('blocked'), color: 'var(--mist-bad)' },
    ]} />
    <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)} drawerTitle={selected ? `${selected.code} · ${selected.name}` : '供应商档案'} drawerSub={selected?.type}
      list={<Card><DataTable ariaLabel="供应商列表" loading={loading} rows={rows} rowKey={s => s.id} selectedKey={selected?.id} density="comfy" onRowClick={pick} columns={columns} empty={empty} /></Card>}
      detail={detail} />
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage>;
}

function SupplierDetail({ s, state, day, can, canAdmin, canContacts, locked, perf, onEdit, onRate, onCert, onDeleteCert, onStatus, onContact, onOpen, attachments, history }: {
  s: MarketSupplier; state: MistState; day: string; can: boolean; canAdmin: boolean; canContacts: boolean; locked: boolean; perf: ReturnType<typeof supplierPerformance>;
  onEdit: () => void; onRate: () => void; onCert: (c?: SupplierCertificate) => void; onDeleteCert: (c: SupplierCertificate) => void; onStatus: (s: MarketSupplier['status']) => void;
  onContact: (c?: MarketSupplier['contacts'][number]) => void; onOpen: (view: string, id?: string) => void; attachments: React.ReactNode; history: React.ReactNode;
}) {
  const now = supplierStatusOn(s, day), grade = supplierGrade(s), flags = supplierFlags(s, day), certs = s.certificates || [];
  const products = state.market.products.filter(p => p.supplierId === s.id);
  const writeReason = !can ? '没有供应商写权限' : false, adminReason = !canAdmin ? '评级与合作状态须由主管（供应商管理权限）办理' : false;
  const primary = s.contacts.find(c => c.primary) || s.contacts[0];
  const banner: { tone: Tone; title: string; text: string } | null =
    now !== 'active' ? { tone: now === 'paused' ? 'warn' : 'bad', title: `${STATUS_LABEL[now]} · ${s.statusFrom} 起`, text: `${s.blockReason}。不能新建采购单或引用建档；${perf.open.length ? `在手业务 ${perf.open.length} 单继续执行。` : '当前没有在手业务。'}` }
    : s.status !== 'active' ? { tone: 'warn', title: `将于 ${s.statusFrom} ${s.status === 'paused' ? '暂停合作' : '停用'}`, text: `${s.blockReason}。生效前仍可正常下单。` }
    : flags.some(f => f.key === 'certExpired') ? { tone: 'warn', title: '有认证已过期', text: '请向供应商索取新证书并更新有效期；客户要求该认证的订单下单前须核对。' } : null;
  return <DetailBody data-supplier-detail={s.id} heading={<div><span className="mist-mono mist-muted">{s.code}</span><div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{s.name}</div></div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}>
      <Pill tone={STATUS_TONE[now]}>{STATUS_LABEL[now]}</Pill>
      <Pill>{s.type}</Pill>
      {grade ? <Pill tone={GRADE_TONE[grade.grade]}>评级 {grade.grade}</Pill> : <Pill>未评级</Pill>}
      {flags.filter(f => f.key === 'certExpired' || f.key === 'certExpiring').map(f => <Pill key={f.key} tone={f.tone}>{f.label}</Pill>)}
    </div>
    {banner && <Banner tone={banner.tone} title={banner.title}>{banner.text}</Banner>}
    <ActionBar busy={locked} actions={[
      { label: '编辑档案', icon: Pencil, onClick: onEdit, reason: writeReason },
      { label: '评级', icon: Award, onClick: onRate, reason: adminReason },
      { label: '登记认证', icon: FileBadge, onClick: () => onCert(), reason: writeReason },
      { label: '询价比价', icon: Scale, onClick: () => undefined, reason: '多家回价对比后转采购，尚未接入' },
      { label: '暂停合作', icon: Pause, onClick: () => onStatus('paused'), reason: adminReason, hidden: s.status !== 'active' },
      { label: '停用', icon: Ban, onClick: () => onStatus('blocked'), reason: adminReason, hidden: s.status === 'blocked' },
      { label: now === 'active' ? '取消计划' : '恢复合作', icon: Play, onClick: () => onStatus('active'), primary: true, reason: adminReason, hidden: s.status === 'active' },
    ]} />
    <Facts items={[
      { label: '生产地址', value: `${s.country} ${s.address}`.trim() || '未填' },
      { label: '月产能', value: <span className="mist-num">{s.capacity} {s.capacityUnit}</span> },
      { label: '通常交付周期', value: `${s.leadDays} 天` },
      { label: '准交率', value: perf.completed.length ? `${rate(perf.onTime, perf.completed.length)}（${perf.onTime}/${perf.completed.length} 单）` : '暂无完成单' },
      { label: '来料无退货', value: perf.receipts ? `${perf.clean}/${perf.receipts} 批` : '暂无到货' },
      { label: '主联系人', value: primary ? `${primary.name}${primary.role ? ' · ' + primary.role : ''}` : '未登记' },
      ...MIST_BUSINESS_GROUPS.map(g => ({ label: `${MIST_BUSINESS_GROUP_LABEL[g]}经手人`, value: s.handlers?.[g]?.name || '未指定' })),
    ]} />
    <DetailBlock title="产能与工艺"><p className="mist-sub" style={{ margin: 0 }}>{s.capabilities}</p>{s.note && <span className="mist-note">{s.note}</span>}</DetailBlock>
    <DetailBlock title={`认证 · ${certs.length}`} aside={can ? <Button variant="quiet" icon={Plus} disabled={locked} onClick={() => onCert()}>登记</Button> : undefined}>
      {certs.length ? <div className="mist-col" style={{ gap: 0 }} role="list" aria-label={`${s.name} 认证`} data-supplier-certs>{[...certs].sort((a, b) => a.validUntil.localeCompare(b.validUntil)).map(c => { const st = certificateState(c, day); return <div key={c.id} role="listitem" className="mist-col mist-quote-line" style={{ gap: 4, padding: '10px 0' }}>
        <div className="mist-row" style={{ gap: 8 }}><strong>{c.name}</strong><span className="mist-spacer" /><Pill tone={st.tone}>{st.label}</Pill></div>
        <div className="mist-row" style={{ gap: 8, flexWrap: 'wrap' }}><small className="mist-muted">{[c.number && <Mono key="n">{c.number}</Mono>, c.issuer].filter(Boolean).reduce<React.ReactNode[]>((acc, x, i) => i ? [...acc, ' · ', x] : [x], [])}{!c.number && !c.issuer && '未填证书编号'} · 至 {c.validUntil}</small><span className="mist-spacer" />
          {can && <><Button variant="quiet" disabled={locked} onClick={() => onCert(c)}>更新</Button><Button variant="quiet" disabled={locked} onClick={() => onDeleteCert(c)}>删除</Button></>}</div>
      </div>; })}</div> : <span className="mist-muted">未登记认证。客户要求 OEKO-TEX、GOTS、BSCI 等认证时，请先登记证书与有效期。</span>}
    </DetailBlock>
    <DetailBlock title={`在手业务 · ${perf.open.length}`}>
      {perf.open.length ? <div className="mist-col" style={{ gap: 0 }} role="list" aria-label="在手采购单">{perf.open.map(p => <div key={p.id} role="listitem" className="mist-row mist-quote-line" style={{ gap: 8, padding: '8px 0', flexWrap: 'wrap' }}>
        <Mono>{p.code}</Mono><span style={{ flex: '1 1 160px', minWidth: 0 }}>{p.description}<small className="mist-cell-sub">{perf.arrived(p)} / {p.quantity} {p.unit} 已到 · 交期 {perf.promised(p)}</small></span><Pill tone={p.state === 'pending' ? 'warn' : p.state === 'draft' ? 'neutral' : 'accent'}>{purchaseStage(p)}</Pill><Button variant="quiet" onClick={() => onOpen('procurement', p.id)}>打开</Button>
      </div>)}</div> : <span className="mist-muted">没有进行中的采购单。</span>}
    </DetailBlock>
    {!!perf.completed.length && <DetailBlock title="交付记录">
      <div className="mist-col" style={{ gap: 0 }} role="list" aria-label="已完成采购单">{perf.completed.map(c => <div key={c.purchase.id} role="listitem" className="mist-row mist-quote-line" style={{ gap: 8, padding: '8px 0', flexWrap: 'wrap' }}>
        <Mono>{c.purchase.code}</Mono><span style={{ flex: '1 1 160px', minWidth: 0 }}>{c.purchase.description}<small className="mist-cell-sub">到货 {c.last} · 承诺 {c.promised}</small></span><Pill tone={c.onTime ? 'ok' : 'bad'}>{c.onTime ? '准时' : '延迟'}</Pill>
      </div>)}</div>
    </DetailBlock>}
    <DetailBlock title={`联系人 · ${s.contacts.length}`} aside={canContacts ? <Button variant="quiet" icon={UserPlus} disabled={locked} onClick={() => onContact()}>添加</Button> : undefined}>
      {s.contacts.length ? <div className="mist-col" style={{ gap: 0 }}>{s.contacts.map(c => <div key={c.id} className="mist-row mist-quote-line" style={{ gap: 8, padding: '8px 0' }}>
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{c.name}{c.role ? ' · ' + c.role : ''}<small className="mist-cell-sub">{[c.phone, c.email].filter(Boolean).join(' · ') || '未填联系方式'}</small></span>{c.primary && <Pill>主联系人</Pill>}{canContacts && <Button variant="quiet" disabled={locked} onClick={() => onContact(c)}>编辑</Button>}
      </div>)}</div> : <span className="mist-muted">未登记联系人。</span>}
    </DetailBlock>
    {!!products.length && <DetailBlock title={`引用档案 · ${products.length}`}>
      <div className="mist-row" style={{ gap: 6, flexWrap: 'wrap' }}>{products.map(p => <Button key={p.id} variant="quiet" onClick={() => onOpen('products', p.id)}><Mono>{p.sku}</Mono> {p.name}{p.supplierCode ? ` · ${p.supplierCode}` : ''}</Button>)}</div>
    </DetailBlock>}
    <DetailBlock title="评级历史">
      {s.ratings?.length ? <Timeline events={[...s.ratings].reverse().map(r => ({ who: `${r.grade} · ${r.period}`, when: `${shortWhen(r.at)} · ${r.actor}`, text: r.note }))} /> : <span className="mist-muted">尚未评级。</span>}
    </DetailBlock>
    {!!s.statusHistory?.length && <DetailBlock title="合作状态记录">
      <Timeline events={[...s.statusHistory].reverse().map(h => ({ who: `${STATUS_LABEL[h.status]} · ${h.effectiveDate} 生效`, when: `${shortWhen(h.at)} · ${h.actor}`, text: h.reason || '—' }))} />
    </DetailBlock>}
    <DetailBlock title="附件">{attachments}</DetailBlock>
    <DetailBlock title="处理记录">{history}</DetailBlock>
  </DetailBody>;
}
