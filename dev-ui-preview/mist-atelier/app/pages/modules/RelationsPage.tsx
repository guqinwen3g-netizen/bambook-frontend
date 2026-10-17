/** 关系智库：统一组织主体（同一公司可同时是客户和供应商），联系人、别名、信用与在手业务；往来冻结 / 解冻留痕并在报价、订单、采购处生效。 */
import React from 'react';
import { Archive, ArchiveRestore, Building2, Download, Link2, Lock, Pencil, Plus, SearchX, Undo2, Unlock, UserPlus, Users } from 'lucide-react';
import { Banner, Button, Card, DataTable, Dropdown, EmptyState, Facts, MistPage, Mono, ObjectCell, PageHeader, Pill, Pipeline, SearchField, Timeline, Toolbar, type Column, type Tone } from '../../../../../components/mist';
import type { MistState } from '../../../../../server/src/shared/mistWorkspace';
import type { MarketRelation } from '../../../../../server/src/shared/mistMarket';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { ModuleEditorDialog, downloadModuleCsv, type ModuleEditorSpec } from './ModuleWorkbench';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen } from './pageKit';
import { quotationStage } from './QuotationsPage';
import { supplierPerformance } from './SuppliersPage';

type Identity = 'all' | 'customer' | 'supplier' | 'agent' | 'partner' | 'other';
type FlagFilter = 'all' | 'hold' | 'dual' | 'noContact';
type StatusFilter = 'active' | 'archived' | 'any';
const CATEGORY_LABEL: Record<MarketRelation['category'], string> = { Customer: '客户', Supplier: '供应商', Agent: '代理 / 货代', Partner: '合作伙伴', Government: '政府机构', Internal: '内部', Other: '其他' };
export function relationIdentities(r: MarketRelation): Exclude<Identity, 'all'>[] {
  const ids: Exclude<Identity, 'all'>[] = [];
  if (r.customerId) ids.push('customer');
  if (r.supplierId) ids.push('supplier');
  if (!ids.length) ids.push(r.category === 'Agent' ? 'agent' : r.category === 'Partner' ? 'partner' : 'other');
  return ids;
}
/** 在手业务：客户侧（进行中订单、未关闭报价、进行中商机、未收发票按币种），供应商侧（未到齐采购单）。 */
export function relationBusiness(state: MistState | null, r: MarketRelation) {
  const orders = r.customerId ? (state?.orders || []).filter(o => o.customerId === r.customerId && o.progress < 100) : [];
  const quotations = r.customerId ? (state?.market.quotations || []).filter(q => q.customerId === r.customerId && ['draft', 'pending', 'sent', 'accepted'].includes(quotationStage(q))) : [];
  const opportunities = r.customerId ? (state?.crm.opportunities || []).filter(o => o.customerId === r.customerId && o.stage !== 'won' && o.stage !== 'lost') : [];
  const orderIds = new Set((state?.orders || []).filter(o => o.customerId === r.customerId).map(o => o.id));
  const receivable = new Map<string, number>();
  if (r.customerId) for (const inv of state?.invoices || []) if (!inv.voidedAt && orderIds.has(inv.orderId) && inv.open > 0) receivable.set(inv.currency, Math.round(((receivable.get(inv.currency) || 0) + inv.open) * 100) / 100);
  const purchases = r.supplierId ? supplierPerformance(state, r.supplierId).open : [];
  return { orders, quotations, opportunities, receivable: [...receivable.entries()], purchases, total: orders.length + quotations.length + opportunities.length + purchases.length };
}

/** 客户身份的联系人以客户档案为准（客户页与关系智库共用），主联系人标记取自关系档案。 */
export function relationContacts(state: MistState | null, r: MarketRelation): MarketRelation['contacts'] {
  if (!r.customerId) return r.contacts;
  return (state?.contacts || []).filter(c => c.customerId === r.customerId).map(c => ({ id: c.id, name: c.name, role: c.role, email: c.email, phone: c.phone, primary: !!r.contacts.find(x => x.id === c.id)?.primary }));
}
export type RelationWorkbenchProps = { attachments: (r: MarketRelation, locked: boolean) => React.ReactNode; history: (id: string) => React.ReactNode };

export function RelationWorkbench({ attachments, history }: RelationWorkbenchProps) {
  const { state, run, error, refresh, loading, saving, pending } = useMistWorkspace(), session = useMistSession(), { go, route } = useNav();
  const [identity, setIdentity] = React.useState<Identity>('all'), [flagFilter, setFlagFilter] = React.useState<FlagFilter>('all'), [statusFilter, setStatusFilter] = React.useState<StatusFilter>('active'), [query, setQuery] = React.useState('');
  const [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(!!route.id);
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null);
  React.useEffect(() => { if (route.id) setPicked(route.id); }, [route.id]);
  const all = state?.market.relations || [];
  const customer = (r: MarketRelation) => state?.customers.find(c => c.id === r.customerId);
  const supplier = (r: MarketRelation) => state?.market.suppliers.find(s => s.id === r.supplierId);
  const business = React.useMemo(() => new Map(all.map(r => [r.id, relationBusiness(state, r)])), [state, all]);
  const needle = query.trim().toLowerCase();
  const flagged = (r: MarketRelation, f: FlagFilter) => f === 'all' || (f === 'hold' ? !!r.hold : f === 'dual' ? !!(r.customerId && r.supplierId) : !relationContacts(state, r).length && !(supplier(r)?.contacts.length));
  const searched = all.filter(r => (statusFilter === 'any' || r.status === statusFilter) && flagged(r, flagFilter)
    && (!needle || `${r.name} ${r.aliases.join(' ')} ${r.country} ${r.address} ${customer(r)?.code || ''} ${supplier(r)?.code || ''} ${relationContacts(state, r).map(c => c.name + ' ' + c.email).join(' ')}`.toLowerCase().includes(needle)));
  const count = (v: Identity) => searched.filter(r => v === 'all' || relationIdentities(r).includes(v)).length;
  const rows = searched.filter(r => identity === 'all' || relationIdentities(r).includes(identity)).sort((a, b) => Number(!!b.hold) - Number(!!a.hold) || a.name.localeCompare(b.name, 'zh'));
  const selected = rows.find(r => r.id === picked) || (picked ? all.find(r => r.id === picked) : undefined);
  const can = session.hasPermission('relations:write');
  const locked = saving || !!pending;
  const pick = (r: MarketRelation) => { setPicked(r.id); setDrawer(true); const { view, id: _id, ...target } = route; go(view, r.id, target); };
  const linked = (r?: MarketRelation) => !!r && (!!r.customerId || !!r.supplierId);
  const profileSpec = (r?: MarketRelation): ModuleEditorSpec => ({
    title: r ? `编辑 ${r.name}` : '建立关系档案', submitLabel: '保存',
    description: r && linked(r) ? '客户与供应商的名称、地区读取各自档案；这里维护别名与备注。' : '客户与供应商请在各自页面新建，会自动生成关系档案；这里登记货代、报关行、合作伙伴等其它组织。',
    initialValues: r ? { category: r.category, name: r.name, country: r.country, address: r.address, aliases: r.aliases.join('、'), note: r.note } : { category: 'Agent', name: '', country: '', address: '', aliases: '', note: '' },
    fields: [
      { key: 'category', label: '关系类别', type: 'select', required: true, readonly: linked(r), options: (linked(r) ? Object.keys(CATEGORY_LABEL) : ['Agent', 'Partner', 'Government', 'Internal', 'Other']).map(k => ({ value: k, label: CATEGORY_LABEL[k as MarketRelation['category']] })) },
      { key: 'name', label: '组织名称', required: !linked(r), readonly: linked(r) },
      { key: 'country', label: '国家地区', readonly: linked(r) && !!r?.supplierId && !r?.customerId }, { key: 'address', label: '地址', readonly: linked(r) && !!r?.supplierId && !r?.customerId },
      { key: 'aliases', label: '别名', hint: '英文全称、简称、旧名等，用顿号分隔；搜索与付款人匹配会用到' }, { key: 'note', label: '偏好与备注', type: 'textarea' },
    ],
    submit: async v => { const res = await run({ type: 'market.relation.save', payload: { id: r?.id, input: { name: String(v.name ?? ''), category: String(v.category) as MarketRelation['category'], customerId: r?.customerId || '', supplierId: r?.supplierId || '', country: String(v.country ?? ''), address: String(v.address ?? ''), aliases: String(v.aliases ?? '').split(/[、,\n]/).map(x => x.trim()).filter(Boolean), note: String(v.note ?? ''), fileIds: r?.fileIds || [] } } }); const id = String((res.result as { id?: string }).id || ''); if (!r && id) { setPicked(id); go('relations', id); } },
  });
  const holdSpec = (r: MarketRelation, frozen: boolean): ModuleEditorSpec => {
    const b = business.get(r.id)!;
    const effects = [r.customerId && '不能新建报价、发送报价、报价转订单或新建订单', r.supplierId && '不能新建采购单'].filter(Boolean).join('；');
    return frozen
      ? { title: `冻结与 ${r.name} 的往来`, submitLabel: '冻结', description: `冻结后${effects || '仅作标记，不影响其它业务'}。已有在手业务 ${b.total} 项不受影响，继续执行。`, initialValues: { reason: '' }, fields: [{ key: 'reason', label: '冻结原因', type: 'textarea', required: true, hint: '例如逾期未付、信用额度超限、合规调查' }], submit: v => run({ type: 'market.relation.hold', payload: { id: r.id, frozen: true, reason: String(v.reason ?? '') } }) }
      : { title: `解冻 ${r.name}`, submitLabel: '解冻', initialValues: { reason: '' }, fields: [{ key: 'reason', label: '解冻说明', type: 'textarea', required: true, hint: '例如回款已确认' }], submit: v => run({ type: 'market.relation.hold', payload: { id: r.id, frozen: false, reason: String(v.reason ?? '') } }) };
  };
  const linkable = (state?.market.suppliers || []).filter(s => !all.some(r => r.supplierId === s.id && r.customerId));
  const linkSpec = (r: MarketRelation): ModuleEditorSpec => ({
    title: `为 ${r.name} 关联供应商身份`, submitLabel: '关联', description: '同一家公司既是客户又是供应商时使用。该供应商原有的关系档案会合并进来（别名、附件保留）；客户与供应商的联系人、业务仍各自维护。',
    initialValues: { supplierId: '' }, fields: [{ key: 'supplierId', label: '供应商', type: 'select', required: true, options: linkable.map(s => ({ value: s.id, label: `${s.code} · ${s.name}` })) }],
    submit: v => run({ type: 'market.relation.linkSupplier', payload: { id: r.id, supplierId: String(v.supplierId ?? '') } }),
  });
  const contactSpec = (kind: 'relation' | 'supplier', parentId: string, owner: string, c?: MarketRelation['contacts'][number]): ModuleEditorSpec => ({
    title: c ? `编辑联系人 ${c.name}` : `添加 ${owner} 联系人`, submitLabel: '保存', initialValues: c ? { ...c } : { name: '', role: '', email: '', phone: '', primary: false },
    fields: [{ key: 'name', label: '联系人姓名', required: true }, { key: 'role', label: '岗位' }, { key: 'email', label: '邮箱' }, { key: 'phone', label: '电话' }, { key: 'primary', label: '主联系人', type: 'checkbox' }],
    submit: v => run({ type: 'market.contact.save', payload: { kind, parentId, id: c?.id, name: String(v.name ?? ''), role: String(v.role ?? ''), email: String(v.email ?? ''), phone: String(v.phone ?? ''), primary: !!v.primary } }),
  });
  const identityPills = (r: MarketRelation) => <>{r.customerId && <Pill tone="accent">客户</Pill>}{r.supplierId && <Pill tone="ok">供应商</Pill>}{!r.customerId && !r.supplierId && <Pill>{CATEGORY_LABEL[r.category]}</Pill>}</>;
  const columns: Column<MarketRelation>[] = [
    { key: 'name', header: '组织', width: 'minmax(180px,1.4fr)', render: r => <ObjectCell name={r.name} meta={r.aliases.length ? r.aliases.join(' · ') : [customer(r)?.code, supplier(r)?.code].filter(Boolean).join(' · ') || '—'} /> },
    { key: 'identity', header: '身份', width: '120px', render: r => <span className="mist-row" style={{ gap: 4, flexWrap: 'wrap' }}>{identityPills(r)}</span> },
    { key: 'country', header: '地区', width: '80px', hideOnMobile: true, render: r => r.country || '—' },
    { key: 'contacts', header: '联系人', width: '72px', align: 'right', hideOnMobile: true, render: r => <span className="mist-num">{relationContacts(state, r).length + (r.customerId && r.supplierId ? supplier(r)?.contacts.length || 0 : 0)}</span> },
    { key: 'business', header: '在手', width: '64px', align: 'right', render: r => <span className="mist-num">{business.get(r.id)?.total || 0}</span> },
    { key: 'status', header: '状态', width: '88px', render: r => r.hold ? <Pill tone="bad">已冻结</Pill> : r.status === 'archived' ? <Pill>已归档</Pill> : <Pill tone="ok">正常</Pill> },
  ];
  const empty = all.length
    ? <EmptyState icon={SearchX} title="没有符合条件的组织" description="换个关键词或清除筛选。" action={<Button onClick={() => { setQuery(''); setIdentity('all'); setFlagFilter('all'); setStatusFilter('active'); }}>清除筛选</Button>} />
    : <EmptyState icon={Users} title="还没有关系档案" description="新建客户或供应商时会自动生成；货代、报关行等其它组织可在这里登记。" action={can ? <Button icon={Plus} onClick={() => setDialog(profileSpec())}>建立关系档案</Button> : undefined} />;
  const detail = selected && state
    ? <RelationDetail r={selected} state={state} can={can} locked={locked} business={business.get(selected.id)!} identityPills={identityPills(selected)} linkableCount={linkable.length}
        onEdit={() => setDialog(profileSpec(selected))} onHold={f => setDialog(holdSpec(selected, f))} onLink={() => setDialog(linkSpec(selected))}
        onContact={(kind, parentId, owner, c) => setDialog(contactSpec(kind, parentId, owner, c))} onArchive={() => void run({ type: 'market.relation.status', payload: { id: selected.id, status: selected.status === 'active' ? 'archived' : 'active' } })}
        onOpen={(view, id, extra) => go(view, id, extra)} attachments={attachments(selected, !can)} history={history(selected.id)} />
    : <EmptyState icon={Building2} title="组织档案" description="从左侧列表选择一个组织，查看身份、联系人、信用与在手业务。" compact />;
  return <MistPage>
    <PageHeader eyebrow="客户与市场 · 组织关系" title="关系智库" description="同一组织只有一份档案：客户、供应商身份与联系人、别名、在手业务集中查看；冻结往来会在报价、订单、采购处生效。"
      actions={<>
        <Button icon={Download} onClick={() => downloadModuleCsv('关系智库.csv', ['组织', '身份', '别名', '地区', '地址', '联系人', '在手业务', '状态', '冻结原因'], rows.map(r => [r.name, relationIdentities(r).map(i => ({ customer: '客户', supplier: '供应商', agent: '代理', partner: '合作伙伴', other: '其他' })[i]).join(' + '), r.aliases.join('、'), r.country, r.address, relationContacts(state, r).map(c => c.name).join('、'), business.get(r.id)?.total || 0, r.hold ? '已冻结' : r.status === 'archived' ? '已归档' : '正常', r.hold?.reason || '']))}>导出</Button>
        {can && <Button variant="primary" icon={Plus} disabled={locked} onClick={() => setDialog(profileSpec())}>建立关系档案</Button>}
      </>} />
    {!can && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有关系档案写权限，可以查看组织、联系人与在手业务。</Banner></div>}
    {error && <div className="mist-section"><Banner tone="bad" title="关系数据未加载" actions={<Button onClick={() => void refresh()}>重试</Button>}>{error}</Banner></div>}
    <Toolbar>
      <SearchField value={query} onChange={setQuery} placeholder="搜索组织、别名、编码、地址或联系人" />
      <Dropdown<FlagFilter> label="提醒" value={flagFilter} onChange={setFlagFilter} options={[{ value: 'all', label: '全部' }, { value: 'hold', label: '已冻结' }, { value: 'dual', label: '既是客户也是供应商' }, { value: 'noContact', label: '没有联系人' }]} />
      <Dropdown<StatusFilter> label="档案" value={statusFilter} onChange={setStatusFilter} options={[{ value: 'active', label: '使用中' }, { value: 'archived', label: '已归档' }, { value: 'any', label: '全部' }]} />
    </Toolbar>
    <Pipeline<Identity> value={identity} onChange={setIdentity} items={[
      { value: 'all', label: '全部', count: count('all'), color: 'var(--mist-ink-2)' },
      { value: 'customer', label: '客户', count: count('customer'), color: 'var(--mist-accent)' },
      { value: 'supplier', label: '供应商', count: count('supplier'), color: 'var(--mist-ok)' },
      { value: 'agent', label: '代理 / 货代', count: count('agent'), color: 'var(--mist-warn)' },
      { value: 'partner', label: '合作伙伴', count: count('partner'), color: 'var(--mist-ink-3)' },
      { value: 'other', label: '其他', count: count('other'), color: 'var(--mist-ink-3)' },
    ]} />
    <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)} drawerTitle={selected?.name || '组织档案'} drawerSub={selected ? relationIdentities(selected).length > 1 ? '客户 + 供应商' : CATEGORY_LABEL[selected.category] : undefined}
      list={<Card><DataTable ariaLabel="关系档案列表" loading={loading} rows={rows} rowKey={r => r.id} selectedKey={selected?.id} density="comfy" onRowClick={pick} columns={columns} empty={empty} /></Card>}
      detail={detail} />
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage>;
}

function ContactRows({ contacts, edit }: { contacts: MarketRelation['contacts']; edit?: (c: MarketRelation['contacts'][number]) => void }) {
  return contacts.length ? <div className="mist-col" style={{ gap: 0 }}>{contacts.map(c => <div key={c.id} className="mist-row mist-quote-line" style={{ gap: 8, padding: '8px 0' }}>
    <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{c.name}{c.role ? ' · ' + c.role : ''}<small className="mist-cell-sub">{[c.phone, c.email].filter(Boolean).join(' · ') || '未填联系方式'}</small></span>{c.primary && <Pill>主联系人</Pill>}{edit && <Button variant="quiet" onClick={() => edit(c)}>编辑</Button>}
  </div>)}</div> : <span className="mist-muted">未登记联系人。</span>;
}

function RelationDetail({ r, state, can, locked, business, identityPills, linkableCount, onEdit, onHold, onLink, onContact, onArchive, onOpen, attachments, history }: {
  r: MarketRelation; state: MistState; can: boolean; locked: boolean; business: ReturnType<typeof relationBusiness>; identityPills: React.ReactNode; linkableCount: number;
  onEdit: () => void; onHold: (frozen: boolean) => void; onLink: () => void; onContact: (kind: 'relation' | 'supplier', parentId: string, owner: string, c?: MarketRelation['contacts'][number]) => void;
  onArchive: () => void; onOpen: (view: string, id?: string, extra?: Record<string, string | undefined>) => void; attachments: React.ReactNode; history: React.ReactNode;
}) {
  const customer = state.customers.find(c => c.id === r.customerId), supplier = state.market.suppliers.find(s => s.id === r.supplierId);
  const dual = !!(customer && supplier), contacts = relationContacts(state, r);
  const writeReason = !can ? '没有关系档案写权限' : false;
  const archiveReason = writeReason || (r.status === 'active' && business.total ? `还有在手业务 ${business.total} 项，完成或交接后再归档` : false);
  return <DetailBody data-relation-detail={r.id} heading={<div><span className="mist-muted">{[customer?.code, supplier?.code].filter(Boolean).join(' · ') || CATEGORY_LABEL[r.category]}</span><div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{r.name}</div></div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}>{identityPills}{r.hold && <Pill tone="bad">已冻结</Pill>}{r.status === 'archived' && <Pill>已归档</Pill>}</div>
    {r.hold && <Banner tone="bad" title={`往来已冻结 · ${shortWhen(r.hold.at)} ${r.hold.actor}`}>{r.hold.reason}。{[customer && '不能新建报价、发送报价、转订单或新建订单', supplier && '不能新建采购单'].filter(Boolean).join('；')}；在手业务继续执行。</Banner>}
    {dual && !r.hold && <Banner tone="neutral" title="既是客户也是供应商">客户与供应商的联系人、业务分别维护；冻结往来对两种身份同时生效。</Banner>}
    <ActionBar busy={locked} actions={[
      { label: '编辑档案', icon: Pencil, onClick: onEdit, reason: writeReason },
      { label: '冻结往来', icon: Lock, onClick: () => onHold(true), reason: writeReason, hidden: !!r.hold },
      { label: '解冻', icon: Unlock, onClick: () => onHold(false), primary: true, reason: writeReason, hidden: !r.hold },
      { label: '关联供应商身份', icon: Link2, onClick: onLink, reason: writeReason || (!linkableCount ? '没有可关联的供应商' : false), hidden: !customer || !!supplier },
      { label: '打开客户业务', icon: Users, onClick: () => onOpen('crm', r.customerId, { customerId: r.customerId }), hidden: !customer },
      { label: '打开供应商', icon: Building2, onClick: () => onOpen('suppliers', r.supplierId), hidden: !supplier },
      { label: '在手业务交接', icon: Undo2, onClick: () => undefined, reason: '离职 / 调岗时逐项转给新负责人，尚未接入', hidden: !customer },
      { label: r.status === 'active' ? '归档' : '恢复', icon: r.status === 'active' ? Archive : ArchiveRestore, onClick: onArchive, reason: archiveReason },
    ]} />
    <Facts items={[
      { label: '地区', value: [r.country, r.address].filter(Boolean).join(' · ') || '未填' },
      { label: '别名', value: r.aliases.join('、') || '—' },
      ...(customer ? [{ label: '客户负责人', value: customer.owner || '未指定' }, { label: '信用额度', value: customer.creditLimit ? <span className="mist-num">{customer.currency} {customer.creditLimit.toLocaleString('en-US')}</span> : '未设定' },
        { label: '未收发票', value: business.receivable.length ? <span className="mist-num">{business.receivable.map(([c, v]) => `${c} ${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`).join(' · ')}</span> : '无' }, { label: '结算条件', value: [customer.terms, customer.incoterm].filter(Boolean).join(' · ') || '未填' }] : []),
      ...(supplier ? [{ label: '供应商类型', value: supplier.type }, { label: '交付周期', value: `${supplier.leadDays} 天` }] : []),
      { label: '查看范围', value: '工作空间成员按角色权限查看' },
    ]} />
    {r.note && <p className="mist-sub">{r.note}</p>}
    <DetailBlock title={`在手业务 · ${business.total}`}>
      {business.total ? <div className="mist-col" style={{ gap: 0 }} role="list" aria-label="在手业务" data-relation-business>
        {business.orders.map(o => <div key={o.id} role="listitem" className="mist-row mist-quote-line" style={{ gap: 8, padding: '8px 0' }}><Pill tone="accent">订单</Pill><Mono>{o.code}</Mono><span style={{ flex: '1 1 8em', minWidth: 0 }} className="mist-muted">{o.state} · 交期 {o.due}</span><Button variant="quiet" onClick={() => onOpen('orders/detail', o.id)}>打开</Button></div>)}
        {business.quotations.map(q => <div key={q.id} role="listitem" className="mist-row mist-quote-line" style={{ gap: 8, padding: '8px 0' }}><Pill>报价</Pill><Mono>{q.code}</Mono><span style={{ flex: '1 1 8em', minWidth: 0 }} className="mist-muted mist-num">{q.currency} {q.total} · 至 {q.validUntil}</span><Button variant="quiet" onClick={() => onOpen('quotations', q.id)}>打开</Button></div>)}
        {business.opportunities.map(o => <div key={o.id} role="listitem" className="mist-row mist-quote-line" style={{ gap: 8, padding: '8px 0' }}><Pill>商机</Pill><span style={{ flex: '1 1 8em', minWidth: 0 }}>{o.title}<small className="mist-cell-sub">{o.owner || '未指定负责人'} · 预计 {o.expectedDate || '—'}</small></span><Button variant="quiet" onClick={() => onOpen('crm', r.customerId, { customerId: r.customerId })}>打开</Button></div>)}
        {business.purchases.map(p => <div key={p.id} role="listitem" className="mist-row mist-quote-line" style={{ gap: 8, padding: '8px 0' }}><Pill tone="ok">采购</Pill><Mono>{p.code}</Mono><span style={{ flex: '1 1 8em', minWidth: 0 }} className="mist-muted">{p.description}</span><Button variant="quiet" onClick={() => onOpen('procurement', p.id)}>打开</Button></div>)}
      </div> : <span className="mist-muted">没有在手业务。</span>}
    </DetailBlock>
    <DetailBlock title={dual ? `客户联系人 · ${contacts.length}` : `联系人 · ${contacts.length}`} aside={can ? <Button variant="quiet" icon={UserPlus} disabled={locked} onClick={() => onContact('relation', r.id, dual ? '客户侧' : r.name)}>添加</Button> : undefined}>
      <ContactRows contacts={contacts} edit={can ? c => onContact('relation', r.id, r.name, c) : undefined} />
    </DetailBlock>
    {dual && <DetailBlock title={`供应商联系人 · ${supplier!.contacts.length}`} aside={can && state ? <Button variant="quiet" icon={UserPlus} disabled={locked} onClick={() => onContact('supplier', supplier!.id, '供应商侧')}>添加</Button> : undefined}>
      <ContactRows contacts={supplier!.contacts} edit={can ? c => onContact('supplier', supplier!.id, supplier!.name, c) : undefined} />
    </DetailBlock>}
    {!!r.holdHistory?.length && <DetailBlock title="冻结记录">
      <Timeline events={[...r.holdHistory].reverse().map(h => ({ who: h.action === 'freeze' ? '冻结' : '解冻', when: `${shortWhen(h.at)} · ${h.actor}`, text: h.reason }))} />
    </DetailBlock>}
    <DetailBlock title="附件">{attachments}</DetailBlock>
    <DetailBlock title="处理记录">{history}</DetailBlock>
  </DetailBody>;
}
