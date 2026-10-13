/** 单据中心：按准确出运与合同保留单据版本（新版本不覆盖旧版本）、正式文件与签发 / 归档记录；我方签发 CI / PL，外部机构单据只归档原件；CI 签发回到财务应收。 */
import React from 'react';
import { Archive, Building2, Download, FileText, FilePlus2, Pencil, Plus, Receipt, SearchX, Stamp, XCircle } from 'lucide-react';
import { Banner, Button, Card, DataTable, Dropdown, EmptyState, Facts, MistPage, Mono, PageHeader, Pill, Pipeline, SearchField, Segmented, Tabs, TextLink, Toolbar, type Column, type Tone } from '../../../../../components/mist';
import type { MistState } from '../../../../../server/src/shared/mistWorkspace';
import type { FulfillmentDocument, FulfillmentShipment } from '../../../../../server/src/shared/mistFulfillment';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { fmt } from '../../data';
import { ModuleEditorDialog, type ModuleEditorSpec } from './ModuleWorkbench';
import { choices, emptyOption, Events, exportRecords, field, localNow, RecordFiles, text } from './fulfillmentKit';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen, type ReasonedAction } from './pageKit';
import { MODE_LABEL, packingMatched } from './ShipmentsPage';

type Tab = 'documents' | 'template';
type Domain = FulfillmentShipment['domain'];
type DocType = FulfillmentDocument['type'];
type StatusFilter = 'active' | 'draft' | 'issued' | 'void';
type TypeFilter = 'all' | DocType;
const TYPE_LABEL: Record<DocType, string> = { CI: '商业发票 CI', PL: '装箱单 PL', BL: '提单 BL', CO: '原产地证 CO', OTHER: '其他外部单据' };
const OWN = (type: DocType) => type === 'CI' || type === 'PL';
const family = (d: FulfillmentDocument) => `${d.shipmentId}|${d.type}|${d.orderId}`;
export function documentStatus(d: FulfillmentDocument): { label: string; tone: Tone } {
  if (d.status === 'void') return { label: '已作废', tone: 'neutral' };
  if (d.status === 'issued') return d.externalIssue ? { label: '外部原件已归档', tone: 'ok' } : { label: '已签发', tone: 'ok' };
  return { label: '草稿', tone: 'warn' };
}
/** Why the backend would refuse to issue / archive this draft, checked up-front so the reason is visible. */
export function issueBlocker(root: MistState, d: FulfillmentDocument) {
  const s = root.fulfillment.shipments.find(row => row.id === d.shipmentId);
  if (!s) return '出运不可用';
  if (OWN(d.type) ? s.state === 'departed' || s.state === 'cancelled' : s.state === 'cancelled') return OWN(d.type) ? '出运已离港或已取消' : '出运已取消';
  if (!d.fileIds.length) return OWN(d.type) ? '请先上传核对后的正式单据文件' : '请先上传外部机构签发的原件';
  if (root.fulfillment.documents.some(o => o.id !== d.id && family(o) === family(d) && o.status === 'issued')) return '相同来源已有有效版本，请先作废';
  if (d.type === 'PL' && !packingMatched(root, s)) return '装箱分配与计划数量不一致';
  return '';
}
function voidBlocker(root: MistState, d: FulfillmentDocument) {
  const s = root.fulfillment.shipments.find(row => row.id === d.shipmentId);
  if (!s || s.state === 'departed' || s.state === 'cancelled') return '出运已离港或已取消，单据保留为历史';
  const inv = d.invoiceId ? root.invoices.find(row => row.id === d.invoiceId) : undefined;
  if (inv && (inv.open !== inv.amount || root.allocations.some(a => a.invoiceId === inv.id))) return 'CI 已有收款，请先走财务更正';
  return '';
}

export function DocumentCenterPage() {
  const { state, run, error, refresh, loading, saving, pending } = useMistWorkspace(), session = useMistSession(), { go, route } = useNav();
  const can = session.hasPermission('customs:write'), canInvoices = session.hasPermission('invoices:read');
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null);
  const [tab, setTab] = React.useState<Tab>('documents'), [domainChoice, setDomainChoice] = React.useState<Domain | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('active'), [typeFilter, setTypeFilter] = React.useState<TypeFilter>('all'), [query, setQuery] = React.useState('');
  const [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(!!route.id);
  React.useEffect(() => { if (route.id) { setPicked(route.id); setDrawer(true); setDomainChoice(null); setTab('documents'); } }, [route.id]);
  const f = state?.fulfillment, locked = saving || !!pending;
  const shipmentOf = (d: FulfillmentDocument) => f?.shipments.find(s => s.id === d.shipmentId);
  const contextShipment = route.section ? f?.shipments.find(s => s.id === route.section) : undefined;
  const hasContext = !!route.section, invalidContext = hasContext && !!state && !contextShipment;
  const docs = (f?.documents || []).filter(d => !hasContext || d.shipmentId === route.section);
  const routed = docs.find(d => d.id === route.id);
  const domainOf = (d: FulfillmentDocument): Domain => shipmentOf(d)?.domain || 'garment';
  const domain: Domain = domainChoice || (routed ? domainOf(routed) : undefined) || contextShipment?.domain || (docs.some(d => domainOf(d) === 'garment') || !docs.some(d => domainOf(d) === 'fabric') ? 'garment' : 'fabric');
  const inDomain = hasContext ? docs : docs.filter(d => domainOf(d) === domain);
  const needle = query.trim().toLowerCase();
  const orderCode = (id: string) => state?.orders.find(o => o.id === id)?.code || '';
  const searched = inDomain.filter(d => (typeFilter === 'all' || d.type === typeFilter) && (!needle || `${d.number} ${d.title} ${d.type} ${shipmentOf(d)?.code || ''} ${shipmentOf(d)?.customer || ''} ${orderCode(d.orderId)} ${d.externalIssue?.issuer || ''}`.toLowerCase().includes(needle)));
  const statusOf = (d: FulfillmentDocument): Exclude<StatusFilter, 'active'> => d.status;
  const count = (value: StatusFilter) => value === 'active' ? searched.filter(d => d.status !== 'void').length : searched.filter(d => statusOf(d) === value).length;
  const order: Record<FulfillmentDocument['status'], number> = { draft: 0, issued: 1, void: 2 };
  const rows = searched.filter(d => statusFilter === 'active' ? d.status !== 'void' : d.status === statusFilter)
    .sort((a, b) => order[a.status] - order[b.status] || (shipmentOf(a)?.code || '').localeCompare(shipmentOf(b)?.code || '') || a.type.localeCompare(b.type) || b.version - a.version);
  const selected = rows.find(d => d.id === picked) || (picked ? docs.find(d => d.id === picked) : undefined);

  const pick = (d: FulfillmentDocument) => { setPicked(d.id); setDrawer(true); const { view, id: _id, ...target } = route; go(view, d.id, target); };
  const changeDomain = (value: Domain) => { setDomainChoice(value); setStatusFilter('active'); setPicked(null); };
  const shipments = (f?.shipments || []).filter(s => s.state !== 'cancelled' && (!hasContext || s.id === route.section));
  const docSpec = (d?: FulfillmentDocument, base?: FulfillmentDocument): ModuleEditorSpec => {
    const src = d || base, fixed = !!src;
    const s = src ? f?.shipments.find(row => row.id === src.shipmentId) : contextShipment;
    const orderOptions = (s ? [...new Set(s.lines.map(line => line.orderId))] : []).map(id => ({ value: id, label: orderCode(id) || '订单不可用' }));
    return { title: d ? '编辑单据草稿' : base ? `基于 V${base.version} 建立新版本` : '新建单据', submitLabel: d ? '保存草稿' : '保存为草稿',
      description: d ? '只有草稿可以修改；签发或归档后保留为历史版本。' : base ? '新版本保存为草稿，原版本保持不变；有效版本须先作废，新版本才能签发。' : '我方出具 CI / PL；提单、原产地证等外部机构单据保存草稿后归档原件。CI 须绑定一份准确订单。',
      fields: [
        ...(fixed ? [] : [field('shipmentId', '准确出运', 'select', true, [emptyOption, ...shipments.map(row => ({ value: row.id, label: `${row.code} · ${row.customer}` }))]), field('type', '单据类型', 'select', true, (['CI', 'PL', 'BL', 'CO', 'OTHER'] as DocType[]).map(value => ({ value, label: TYPE_LABEL[value] })))]),
        ...(fixed ? [] : [{ ...field('orderId', 'CI 对应订单', 'select', false, [{ value: '', label: '整票出运（非 CI）' }, ...(orderOptions.length ? orderOptions : (state?.orders || []).map(o => ({ value: o.id, label: o.code })))]), hint: '仅 CI 需要；须是本票出运包含的订单。' }]),
        field('number', '实际单据编号'), field('title', '标题'),
        ...(!fixed || src?.type === 'CI' ? [{ ...field('dueDate', 'CI 合同应收日', 'date', false), hint: 'CI 必填，签发后成为财务应收到期日。' }] : []),
        field('content', '单据正文 / 制单说明', 'textarea'),
      ],
      initialValues: { shipmentId: src?.shipmentId || (hasContext ? route.section || '' : ''), type: src?.type || 'PL', orderId: src?.orderId || '', number: d?.number || '', title: src?.title || '', dueDate: src?.dueDate || '', content: src?.content || '' },
      submit: v => run({ type: 'fulfillment.documents.save', payload: { ...(d ? { id: d.id } : {}), shipmentId: src?.shipmentId || text(v, 'shipmentId'), orderId: src ? src.orderId : text(v, 'orderId'), type: (src?.type || text(v, 'type')) as DocType, number: text(v, 'number'), title: text(v, 'title'), dueDate: text(v, 'dueDate'), content: text(v, 'content'), fileIds: d?.fileIds || [] } }) };
  };
  const archiveSpec = (d: FulfillmentDocument): ModuleEditorSpec => ({ title: '归档外部机构原件', submitLabel: '归档原件', description: `${TYPE_LABEL[d.type]} ${d.number} · 以外部机构签发的原件为准。`, fields: [field('issuer', '外部签发机构'), field('at', '实际签发时间', 'datetime-local'), field('evidence', '原件来源依据', 'textarea')], initialValues: { issuer: '', at: localNow(), evidence: '' }, submit: v => run({ type: 'fulfillment.documents.archiveExternal', payload: { id: d.id, issuer: text(v, 'issuer'), at: new Date(text(v, 'at')).toISOString(), evidence: text(v, 'evidence') } }) });
  const voidSpec = (d: FulfillmentDocument): ModuleEditorSpec => ({ title: `作废 ${d.number} · V${d.version}`, submitLabel: '确认作废', description: d.invoiceId ? '作废 CI 会同时作废其财务应收，出运回到单证处理中；已对客发送的需重新发送。' : '作废后出运回到单证处理中；原版本保留为历史。', fields: [field('reason', '作废原因', 'textarea')], initialValues: { reason: '' }, submit: v => run({ type: 'fulfillment.documents.void', payload: { id: d.id, reason: text(v, 'reason') } }) });

  const columns: Column<FulfillmentDocument>[] = [
    { key: 'number', header: '单据', width: 'minmax(170px,1.6fr)', render: d => <div className="mist-col" style={{ gap: 2 }}><Mono>{d.number}</Mono><small className="mist-muted">{d.title}</small></div> },
    { key: 'type', header: '类型 · 版本', width: 'minmax(120px,1fr)', render: d => { const n = (f?.documents || []).filter(o => family(o) === family(d)).length; return <div className="mist-col" style={{ gap: 2 }}><span>{d.type} · V{d.version}</span><small className="mist-muted">{OWN(d.type) ? '我方出具' : '外部机构'}{n > 1 ? ` · 共 ${n} 版` : ''}</small></div>; } },
    { key: 'shipment', header: '出运 / 订单', width: 'minmax(150px,1.3fr)', hideOnMobile: true, render: d => <div className="mist-col" style={{ gap: 2 }}><Mono>{shipmentOf(d)?.code || '出运不可用'}</Mono><small className="mist-muted">{shipmentOf(d)?.customer}{d.orderId ? ` · ${orderCode(d.orderId)}` : ''}</small></div> },
    { key: 'date', header: '签发 / 创建', width: '116px', hideOnMobile: true, render: d => <div className="mist-col" style={{ gap: 2 }}><span>{d.issuedAt ? shortWhen(d.issuedAt) : '未签发'}</span><small className="mist-muted">{d.actor} · {shortWhen(d.createdAt)}</small></div> },
    { key: 'status', header: '状态', width: '128px', render: d => { const st = documentStatus(d); return <div className="mist-col" style={{ gap: 2, alignItems: 'flex-start' }}><Pill tone={st.tone}>{st.label}</Pill>{d.status === 'draft' && !d.fileIds.length && <small className="mist-muted">缺正式文件</small>}</div>; } },
  ];
  const createButton = can ? <Button variant="primary" icon={Plus} disabled={invalidContext || !shipments.length} title={shipments.length ? undefined : '没有可出具单据的出运'} onClick={() => setDialog(docSpec())}>新建单据</Button> : undefined;
  const empty = inDomain.length
    ? <EmptyState icon={SearchX} title="没有符合条件的单据" description="换个关键词或清除筛选。" action={<Button onClick={() => { setQuery(''); setTypeFilter('all'); setStatusFilter('active'); }}>清除筛选</Button>} />
    : <EmptyState icon={FileText} title={invalidContext ? '来源出运不存在' : hasContext ? '本票还没有单据' : `还没有${domain === 'fabric' ? '面料' : '成衣'}出运单据`} description={invalidContext ? '请返回货运管理重新选择准确出运。' : '后勤按出运出具 CI / PL：先保存草稿并上传核对后的正式文件，再签发；提单、原产地证等外部单据归档原件。'} action={createButton && !invalidContext && shipments.length ? <Button icon={Plus} onClick={() => setDialog(docSpec())}>新建单据</Button> : undefined} />;
  const detail = selected && state
    ? <DocumentDetail doc={selected} state={state} can={can} canInvoices={canInvoices} locked={locked} onPick={pick}
        onEdit={() => setDialog(docSpec(selected))} onVersion={() => setDialog(docSpec(undefined, selected))} onArchive={() => setDialog(archiveSpec(selected))} onVoid={() => setDialog(voidSpec(selected))}
        onIssue={() => setDialog({ title: `签发 ${selected.number} · V${selected.version}`, submitLabel: '确认签发', description: selected.type === 'CI' ? '签发后生成财务应收（按本票该订单条目数量 × 合同单价），本版本不可再修改。' : '签发后本版本不可再修改；如需更正请作废后建立新版本。', fields: [], initialValues: {}, submit: () => run({ type: 'fulfillment.documents.issue', payload: { id: selected.id } }) })}
        onAttach={ids => run({ type: 'fulfillment.documents.save', payload: { id: selected.id, shipmentId: selected.shipmentId, orderId: selected.orderId, type: selected.type, number: selected.number, title: selected.title, dueDate: selected.dueDate, content: selected.content, fileIds: ids } })}
        onShipment={() => go('shipments', selected.shipmentId)} onInvoice={id => go('invoices', id)} />
    : <EmptyState icon={FileText} title="单据详情" description={loading ? '正在读取单据' : '从列表选择一份单据，查看版本、正式文件与签发记录'} compact />;
  const profile = state?.settings.companyProfile;

  return <MistPage width="wide">
    <PageHeader eyebrow="订单履约 · 单证" title="单据中心"
      description={invalidContext ? '指定出运不存在，请返回货运管理重新进入。' : contextShipment ? `${contextShipment.code} · ${contextShipment.customer} · 仅显示本票单据。` : '按准确出运与合同保留单据版本、正式文件与签发记录；新版本不覆盖旧版本，CI 签发后回到财务应收。'}
      actions={<>
        {contextShipment && <Button onClick={() => go('shipments', contextShipment.id)}>返回出运</Button>}
        {hasContext && <Button onClick={() => go('document-center')}>查看全部单据</Button>}
        {tab === 'documents' && <Button icon={Download} disabled={!rows.length} onClick={() => exportRecords('单据目录', ['编号', '标题', '类型', '版本', '出运', '订单', '状态', '签发时间'], rows.map(d => [d.number, d.title, d.type, d.version, shipmentOf(d)?.code || '', orderCode(d.orderId), documentStatus(d).label, d.issuedAt || '']))}>导出</Button>}
        {tab === 'documents' && createButton}
      </>} />
    {!can && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有单证权限，可以查看单据版本与签发记录。</Banner></div>}
    {error && <div className="mist-section"><Banner tone="bad" title="单据未读取" actions={<Button onClick={() => void refresh()}>重试</Button>}>{error}</Banner></div>}
    {!hasContext && <div className="mist-section"><Tabs<Tab> value={tab} onChange={value => { setTab(value); setDrawer(false); }} options={[{ value: 'documents', label: '出运单据', count: docs.filter(d => d.status !== 'void').length }, { value: 'template', label: '抬头与模板' }]} /></div>}
    {tab === 'template' && !hasContext ? <Card><div className="mist-col" style={{ padding: 20, gap: 16 }}>
        {profile?.legalName ? <Facts items={[
          { label: '中文抬头', value: profile.legalName }, { label: '英文抬头', value: profile.englishName || '未填写' },
          { label: '中文地址', value: profile.address || '未填写' }, { label: '英文地址', value: profile.englishAddress || '未填写' },
          { label: '电话 / 邮箱', value: [profile.phone, profile.email].filter(Boolean).join(' · ') || '未填写' }, { label: '税号', value: profile.taxId || '未填写' },
          { label: '海关编码', value: profile.customsCode || '未填写' }, { label: '开户行 / SWIFT', value: [profile.bankName, profile.swift].filter(Boolean).join(' · ') || '未填写' },
        ]} /> : <EmptyState icon={Building2} title="尚未填写公司抬头" description="CI / PL 的抬头、地址和收款银行取自设置中的公司资料。" compact />}
        <div className="mist-row"><Button icon={Pencil} onClick={() => go('settings')}>在设置中维护公司资料</Button></div>
        <span className="mist-note">印章图样、编号规则预览与打印打包尚未接入；PI、样品单、试样通知与采购单在各自页面出具，单据中心暂不汇总。</span>
      </div></Card>
    : <>
      {!hasContext && <div className="mist-section"><Segmented<Domain> ariaLabel="业务板块" value={domain} onChange={changeDomain} options={[{ value: 'garment', label: `成衣业务 · ${docs.filter(d => domainOf(d) === 'garment' && d.status !== 'void').length}` }, { value: 'fabric', label: `面料业务 · ${docs.filter(d => domainOf(d) === 'fabric' && d.status !== 'void').length}` }]} /></div>}
      <Toolbar>
        <SearchField value={query} onChange={setQuery} placeholder="搜索单据编号、标题、出运号、客户、订单或签发机构" />
        <Dropdown<TypeFilter> label="类型" value={typeFilter} onChange={setTypeFilter} options={[{ value: 'all', label: '全部类型' }, ...(['CI', 'PL', 'BL', 'CO', 'OTHER'] as DocType[]).map(value => ({ value, label: TYPE_LABEL[value] }))]} />
      </Toolbar>
      <Pipeline<StatusFilter> value={statusFilter} onChange={setStatusFilter} items={[
        { value: 'active', label: '当前单据', count: count('active'), color: 'var(--mist-ink-2)' },
        { value: 'draft', label: '草稿', count: count('draft'), color: 'var(--mist-warn)' },
        { value: 'issued', label: '有效签发 / 归档', count: count('issued'), color: 'var(--mist-ok)' },
        { value: 'void', label: '已作废', count: count('void'), color: 'var(--mist-ink-3)' },
      ]} />
      <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)} drawerTitle={selected ? `${selected.number} · V${selected.version}` : '单据详情'} drawerSub={selected ? `${TYPE_LABEL[selected.type]} · ${shipmentOf(selected)?.code || ''}` : undefined}
        list={<Card><DataTable ariaLabel="单据列表" loading={loading} rows={rows} rowKey={d => d.id} selectedKey={selected?.id} density="comfy" onRowClick={pick} columns={columns} empty={empty} /></Card>}
        detail={detail} />
    </>}
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage>;
}

function DocumentDetail({ doc: d, state, can, canInvoices, locked, onPick, onEdit, onVersion, onIssue, onArchive, onVoid, onAttach, onShipment, onInvoice }: {
  doc: FulfillmentDocument; state: MistState; can: boolean; canInvoices: boolean; locked: boolean; onPick: (d: FulfillmentDocument) => void;
  onEdit: () => void; onVersion: () => void; onIssue: () => void; onArchive: () => void; onVoid: () => void; onAttach: (ids: string[]) => Promise<unknown>; onShipment: () => void; onInvoice: (id: string) => void;
}) {
  const s = state.fulfillment.shipments.find(row => row.id === d.shipmentId), st = documentStatus(d);
  const versions = state.fulfillment.documents.filter(o => family(o) === family(d)).sort((a, b) => b.version - a.version);
  const invoice = d.invoiceId ? state.invoices.find(row => row.id === d.invoiceId) : undefined;
  const order = state.orders.find(o => o.id === d.orderId);
  const blocker = d.status === 'draft' ? issueBlocker(state, d) : '';
  const noWrite = can ? false : '需要单证权限';
  const editableShipment = !!s && (OWN(d.type) ? s.state !== 'departed' && s.state !== 'cancelled' : s.state !== 'cancelled');
  const voidReason = d.status === 'issued' ? voidBlocker(state, d) : '';
  const next: { tone: Tone; title: string; text: string } = d.status === 'void' ? { tone: 'neutral', title: '已作废', text: '本版本保留为历史；当前有效版本见版本列表。' }
    : d.status === 'issued' ? { tone: 'ok', title: st.label, text: d.externalIssue ? `${d.externalIssue.issuer} · ${shortWhen(d.externalIssue.at)} 签发，由 ${d.externalIssue.recordedBy} 归档。` : d.type === 'CI' ? '有效 CI，已生成财务应收；更正须作废后建立新版本。' : '有效装箱单；装箱变化须作废后重签。' }
    : { tone: blocker ? 'warn' : 'accent', title: OWN(d.type) ? '草稿 · 待签发' : '草稿 · 待归档原件', text: blocker ? `${OWN(d.type) ? '签发' : '归档'}前：${blocker}。` : OWN(d.type) ? '正式文件已上传，可以签发。' : '原件已上传，登记外部签发机构与时间后归档。' };
  return <DetailBody data-document-detail={d.id} heading={<div>
      <span className="mist-mono mist-muted">{TYPE_LABEL[d.type]} · V{d.version}</span>
      <div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{d.number}</div>
    </div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={st.tone}>{st.label}</Pill><Pill>{OWN(d.type) ? '我方出具' : '外部机构'}</Pill>{s && <Pill>{s.domain === 'fabric' ? '面料业务' : '成衣业务'}</Pill>}</div>
    <Banner tone={next.tone} title={next.title}>{next.text}</Banner>
    {can && <ActionBar busy={locked} actions={[
      { label: '签发', icon: Stamp, onClick: onIssue, primary: true, reason: noWrite || blocker || false, hidden: d.status !== 'draft' || !OWN(d.type) },
      { label: '归档外部签发原件', icon: Archive, onClick: onArchive, primary: true, reason: noWrite || blocker || false, hidden: d.status !== 'draft' || OWN(d.type) },
      { label: '编辑草稿', icon: Pencil, onClick: onEdit, reason: noWrite || (editableShipment ? false : '出运已离港或已取消'), hidden: d.status !== 'draft' },
      { label: '作废当前版本', icon: XCircle, onClick: onVoid, reason: noWrite || voidReason || false, hidden: d.status !== 'issued' },
      { label: '建立新版本', icon: FilePlus2, onClick: onVersion, reason: noWrite || (editableShipment ? false : '出运已离港或已取消'), hidden: d.status === 'draft' || versions[0]?.id !== d.id },
    ] as ReasonedAction[]} />}
    <Facts items={[
      { label: '出运', value: s ? <TextLink onClick={onShipment}>{s.code}</TextLink> : '出运不可用' },
      { label: '客户', value: s?.customer || '—' },
      { label: '运输', value: s ? `${MODE_LABEL[s.mode]} · ${s.portOfLoading} → ${s.portOfDischarge}` : '—' },
      { label: '对应订单', value: order?.code || (d.orderId ? '订单不可用' : '整票出运') },
      ...(d.type === 'CI' ? [{ label: 'CI 合同应收日', value: d.dueDate || '未填写' }] : []),
      { label: '标题', value: d.title },
      { label: '创建', value: `${d.actor} · ${shortWhen(d.createdAt)}` },
      { label: '签发 / 归档', value: d.issuedAt ? shortWhen(d.issuedAt) : '尚未签发' },
    ]} />
    {d.externalIssue && <p className="mist-sub">原件来源：{d.externalIssue.evidence}</p>}
    <DetailBlock title="单据正文 / 制单说明"><p className="mist-sub" style={{ whiteSpace: 'pre-wrap' }}>{d.content}</p></DetailBlock>
    {d.type === 'CI' && <DetailBlock title="财务应收" aside={invoice && canInvoices ? <TextLink icon={Receipt} onClick={() => onInvoice(invoice.id)}>查看应收 {invoice.code}</TextLink> : undefined}>
      {invoice ? <Facts items={[{ label: '应收金额', value: `${invoice.currency} ${fmt(invoice.amount, 2)}` }, { label: '未收', value: invoice.voidedAt ? '已随 CI 作废' : `${invoice.currency} ${fmt(invoice.open, 2)}` }, { label: '到期日', value: invoice.due }]} />
        : <span className="mist-note">{d.status === 'draft' ? '签发后按本票该订单条目数量 × 合同单价生成应收。' : '未找到对应应收。'}</span>}
    </DetailBlock>}
    <DetailBlock title={`版本（${versions.length}）`}>
      <DataTable ariaLabel={`${d.number} 版本`} rows={versions} rowKey={v => v.id} selectedKey={d.id} onRowClick={onPick} columns={[
        { key: 'v', header: '版本', width: '64px', render: v => `V${v.version}` },
        { key: 'number', header: '编号', render: v => <Mono>{v.number}</Mono> },
        { key: 'status', header: '状态', render: v => <Pill tone={documentStatus(v).tone}>{documentStatus(v).label}</Pill> },
        { key: 'at', header: '签发 / 创建', hideOnMobile: true, render: v => v.issuedAt ? shortWhen(v.issuedAt) : shortWhen(v.createdAt) },
      ]} />
    </DetailBlock>
    <DetailBlock title="正式文件"><RecordFiles key={d.id} ids={d.fileIds} onAttach={can && d.status === 'draft' && editableShipment ? onAttach : undefined} />{!d.fileIds.length && <span className="mist-note">{OWN(d.type) ? '签发须引用核对后的正式 PDF 或原始单据' : '归档须上传外部机构签发的原件'}</span>}</DetailBlock>
    <DetailBlock title="处理记录"><Events entity="document" id={d.id} /></DetailBlock>
  </DetailBody>;
}
