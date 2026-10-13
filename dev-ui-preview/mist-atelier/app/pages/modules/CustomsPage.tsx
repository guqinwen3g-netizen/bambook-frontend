/** 外贸与报关：后勤单证按出运登记外部申报与放行事实（本系统不代替海关 / 单一窗口申报）；信用证与退税只核对已登记事实，未接入的部分明确写出。 */
import React from 'react';
import { Download, FileText, Landmark, Pencil, Plus, Receipt, SearchX, Stamp } from 'lucide-react';
import { Banner, Button, Card, CardHeader, Checklist, DataTable, Dropdown, EmptyState, Facts, MistPage, Mono, PageHeader, Pill, Pipeline, SearchField, Segmented, Tabs, TextLink, Toolbar, type Column, type Tone } from '../../../../../components/mist';
import type { MistInvoice, MistOrder, MistState } from '../../../../../server/src/shared/mistWorkspace';
import { isActiveMistInvoice } from '../../../../../server/src/shared/mistWorkspace';
import type { FulfillmentCustoms, FulfillmentShipment } from '../../../../../server/src/shared/mistFulfillment';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { fmt } from '../../data';
import { ModuleEditorDialog, type ModuleEditorSpec } from './ModuleWorkbench';
import { emptyOption, Events, exportRecords, field, RecordFiles, SourceLink, text, today } from './fulfillmentKit';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen, type ReasonedAction } from './pageKit';
import { MODE_LABEL, packedFor, packingMatched, shipmentStage, STAGE_LABEL, STAGE_TONE } from './ShipmentsPage';

type Tab = 'declarations' | 'lc' | 'rebate';
type Domain = FulfillmentShipment['domain'];
type CustomsStatus = FulfillmentCustoms['status'];
type StatusFilter = 'all' | CustomsStatus;
type FlagKey = 'awaiting' | 'unpacked' | 'packing' | 'cancelled';
type FlagFilter = 'all' | 'attention' | 'awaiting' | 'packing';
export const CUSTOMS_LABEL: Record<CustomsStatus, string> = { draft: '未申报', submitted: '已申报', cleared: '已放行' };
const CUSTOMS_TONE: Record<CustomsStatus, Tone> = { draft: 'warn', submitted: 'accent', cleared: 'ok' };
const round = (value: number) => Math.round(value * 10000) / 10000;
const isOpenShipment = (s: FulfillmentShipment) => s.state === 'preparing' || s.state === 'ready';

/** Reminders derived only from the shipment, packing and departure facts already recorded for the declaration. */
export function customsFlags(root: MistState, c: FulfillmentCustoms) {
  const s = root.fulfillment.shipments.find(row => row.id === c.shipmentId), flags: Array<{ key: FlagKey; label: string }> = [];
  if (!s || c.status === 'cleared') return flags;
  if (s.state === 'cancelled') return [{ key: 'cancelled', label: '出运已取消' }];
  if (s.state === 'ready' && s.documentsSentAt) flags.push({ key: 'awaiting', label: '离港等待放行' });
  if (isOpenShipment(s)) {
    if (!root.fulfillment.packing.some(row => row.shipmentId === s.id)) flags.push({ key: 'unpacked', label: '尚未装箱' });
    else if (!packingMatched(root, s)) flags.push({ key: 'packing', label: '装箱与计划不符' });
  }
  return flags;
}

/** Export-rebate evidence that the workspace can actually show: customs release and collection of this shipment's issued CI receivables. */
export function rebateEvidence(root: MistState, c: FulfillmentCustoms) {
  const cis = root.fulfillment.documents.filter(d => d.shipmentId === c.shipmentId && d.type === 'CI' && d.status === 'issued');
  const invoices = cis.flatMap(d => { const invoice = d.invoiceId ? root.invoices.find(row => row.id === d.invoiceId) : undefined; return invoice && isActiveMistInvoice(invoice) ? [invoice] : []; });
  const open = new Map<string, number>();
  for (const invoice of invoices) if (invoice.open > 0) open.set(invoice.currency, round((open.get(invoice.currency) || 0) + invoice.open));
  const released = c.status === 'cleared';
  const collected = invoices.length > 0 && invoices.length === cis.length && open.size === 0;
  return { released, cis, invoices, open: [...open].map(([currency, amount]) => ({ currency, amount })), collected, ready: Number(released) + Number(collected) };
}
const openText = (open: Array<{ currency: string; amount: number }>) => open.map(row => `${row.currency} ${fmt(row.amount, 2)}`).join(' / ');

export function CustomsPage() {
  const { state, run, error, refresh, loading, saving, pending } = useMistWorkspace(), session = useMistSession(), { go, route } = useNav();
  const can = session.hasPermission('customs:write'), canInvoices = session.hasPermission('invoices:read');
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null);
  const [tabChoice, setTab] = React.useState<Tab>('declarations'), [domainChoice, setDomainChoice] = React.useState<Domain | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all'), [flagFilter, setFlagFilter] = React.useState<FlagFilter>('all'), [query, setQuery] = React.useState('');
  const [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(!!route.id), [allPending, setAllPending] = React.useState(false);
  React.useEffect(() => { if (route.id) { setPicked(route.id); setDrawer(true); setDomainChoice(null); } }, [route.id]);
  const f = state?.fulfillment, day = today(), locked = saving || !!pending;
  const shipmentOf = (c: FulfillmentCustoms) => f?.shipments.find(s => s.id === c.shipmentId);
  const contextShipment = route.section ? f?.shipments.find(s => s.id === route.section) : undefined;
  const hasContext = !!route.section, invalidContext = hasContext && !!state && !contextShipment;
  const records = (f?.customs || []).filter(c => !hasContext || c.shipmentId === route.section);
  const routed = records.find(c => c.id === route.id);
  const lcAll = (state?.orders || []).filter(o => o.governance?.contract.paymentMethod === 'LC');
  const domainOf = (c: FulfillmentCustoms): Domain => shipmentOf(c)?.domain || 'garment';
  const domain: Domain = domainChoice || (routed ? domainOf(routed) : undefined) || contextShipment?.domain || (records.some(c => domainOf(c) === 'garment') || !records.some(c => domainOf(c) === 'fabric') ? 'garment' : 'fabric');
  const tab: Tab = hasContext ? 'declarations' : tabChoice === 'lc' || !routed ? tabChoice : routed.status === 'draft' ? 'declarations' : tabChoice;
  const inDomain = hasContext ? records : records.filter(c => domainOf(c) === domain);
  const needle = query.trim().toLowerCase();
  const matches = (c: FulfillmentCustoms) => { const s = shipmentOf(c); return !needle || `${c.code} ${c.declarationNo} ${c.broker} ${c.hsCode} ${c.tradeMode} ${s?.code || ''} ${s?.customer || ''} ${s?.portOfDischarge || ''}`.toLowerCase().includes(needle); };
  const flagsOf = (c: FulfillmentCustoms) => state ? customsFlags(state, c) : [];
  const searched = inDomain.filter(c => matches(c) && (flagFilter === 'all' || (flagFilter === 'attention' ? flagsOf(c).length > 0 : flagsOf(c).some(flag => flag.key === flagFilter || (flagFilter === 'packing' && flag.key === 'unpacked')))));
  const statusOrder: Record<CustomsStatus, number> = { draft: 0, submitted: 1, cleared: 2 };
  const declarationRows = searched.filter(c => statusFilter === 'all' || c.status === statusFilter)
    .sort((a, b) => Number(flagsOf(b).some(x => x.key === 'awaiting')) - Number(flagsOf(a).some(x => x.key === 'awaiting')) || Number(flagsOf(b).length > 0) - Number(flagsOf(a).length > 0) || statusOrder[a.status] - statusOrder[b.status] || (shipmentOf(a)?.plannedDate || '9').localeCompare(shipmentOf(b)?.plannedDate || '9'));
  const rebateRows = !state ? [] : inDomain.filter(c => c.status !== 'draft' && matches(c)).sort((a, b) => rebateEvidence(state, a).ready - rebateEvidence(state, b).ready || (b.clearedAt || b.declaredAt).localeCompare(a.clearedAt || a.declaredAt));
  const lcRows = lcAll.filter(o => o.type === domain && (!needle || `${o.code} ${o.customer} ${o.governance?.contract.paymentNote || ''}`.toLowerCase().includes(needle)));
  const shipmentsInDomain = (f?.shipments || []).filter(s => hasContext ? s.id === route.section : s.domain === domain);
  const pendingShipments = shipmentsInDomain.filter(s => isOpenShipment(s) && !f!.customs.some(c => c.shipmentId === s.id)).sort((a, b) => (a.plannedDate || '9').localeCompare(b.plannedDate || '9'));
  const rows = tab === 'rebate' ? rebateRows : declarationRows;
  const selected = tab === 'lc' ? undefined : rows.find(c => c.id === picked) || (picked ? records.find(c => c.id === picked) : undefined);

  const pick = (c: FulfillmentCustoms) => { setPicked(c.id); setDrawer(true); const { view, id: _id, ...target } = route; go(view, c.id, target); };
  const changeDomain = (value: Domain) => { setDomainChoice(value); setStatusFilter('all'); setPicked(null); };
  const changeTab = (value: Tab) => { setTab(value); setPicked(null); setDrawer(false); };
  const eligibleShipments = () => (f?.shipments || []).filter(s => isOpenShipment(s) && !f!.customs.some(c => c.shipmentId === s.id) && (!hasContext || s.id === route.section));
  const payload = (c: FulfillmentCustoms | undefined, patch: Partial<FulfillmentCustoms>) => ({ ...(c ? { id: c.id } : {}), shipmentId: c?.shipmentId || '', status: c?.status || 'draft', declarationNo: c?.declarationNo || '', broker: c?.broker || '', hsCode: c?.hsCode || '', origin: c?.origin || '', tradeMode: c?.tradeMode || '', declaredAt: c?.declaredAt || '', clearedAt: c?.clearedAt || '', evidence: c?.evidence || '', fileIds: c?.fileIds || [], note: c?.note || '', ...patch });
  const prepFields = [field('broker', '报关行', 'text', false), { ...field('hsCode', 'HS 编码', 'text', false), hint: '按实际申报品名归类；不同品名分开记录在报关单原件中。' }, field('origin', '原产地', 'text', false), field('tradeMode', '贸易方式 / 成交方式', 'text', false), field('note', '备注', 'textarea', false)];
  const createSpec = (shipmentId = ''): ModuleEditorSpec => ({ title: '建立报关记录', submitLabel: '建立记录', description: '先登记报关资料准备；实际向海关申报后再登记报关单号与申报日。本系统不代替海关或单一窗口申报。',
    fields: [field('shipmentId', '准确出运', 'select', true, [emptyOption, ...eligibleShipments().map(s => ({ value: s.id, label: `${s.code} · ${s.customer}` }))]), ...prepFields],
    initialValues: { shipmentId: shipmentId || (hasContext ? route.section || '' : ''), broker: '', hsCode: '', origin: '', tradeMode: '', note: '' },
    submit: v => run({ type: 'fulfillment.customs.save', payload: payload(undefined, { shipmentId: text(v, 'shipmentId'), broker: text(v, 'broker'), hsCode: text(v, 'hsCode'), origin: text(v, 'origin'), tradeMode: text(v, 'tradeMode'), note: text(v, 'note') }) }) });
  const editSpec = (c: FulfillmentCustoms): ModuleEditorSpec => ({ title: '编辑报关资料', fields: prepFields, initialValues: { broker: c.broker, hsCode: c.hsCode, origin: c.origin, tradeMode: c.tradeMode, note: c.note },
    submit: v => run({ type: 'fulfillment.customs.save', payload: payload(c, { broker: text(v, 'broker'), hsCode: text(v, 'hsCode'), origin: text(v, 'origin'), tradeMode: text(v, 'tradeMode'), note: text(v, 'note') }) }) });
  const declareSpec = (c: FulfillmentCustoms, correcting: boolean): ModuleEditorSpec => ({ title: correcting ? '更正申报信息' : '登记已向海关申报', submitLabel: correcting ? '保存更正' : '登记已申报', description: '以单一窗口回执或报关行回执为准；申报日不能晚于今天。',
    fields: [field('declarationNo', '报关单号'), field('broker', '报关行'), field('hsCode', 'HS 编码'), field('origin', '原产地'), field('tradeMode', '贸易方式 / 成交方式'), field('declaredAt', '实际申报日', 'date'), field('note', '备注', 'textarea', false)],
    initialValues: { declarationNo: c.declarationNo, broker: c.broker, hsCode: c.hsCode, origin: c.origin, tradeMode: c.tradeMode, declaredAt: c.declaredAt || day, note: c.note },
    submit: v => run({ type: 'fulfillment.customs.save', payload: payload(c, { status: 'submitted', declarationNo: text(v, 'declarationNo'), broker: text(v, 'broker'), hsCode: text(v, 'hsCode'), origin: text(v, 'origin'), tradeMode: text(v, 'tradeMode'), declaredAt: text(v, 'declaredAt'), note: text(v, 'note') }) }) });
  const releaseSpec = (c: FulfillmentCustoms): ModuleEditorSpec => ({ title: '登记海关放行', submitLabel: '登记放行', description: `报关单 ${c.declarationNo} · 申报日 ${c.declaredAt}。放行后本记录不可覆盖。`,
    fields: [field('clearedAt', '实际放行日', 'date'), { ...field('evidence', '放行依据', 'textarea'), hint: '如海关放行通知或报关行放行回执编号；原件请作为附件保存。' }],
    initialValues: { clearedAt: day, evidence: c.evidence },
    submit: v => run({ type: 'fulfillment.customs.save', payload: payload(c, { status: 'cleared', clearedAt: text(v, 'clearedAt'), evidence: text(v, 'evidence') }) }) });

  const statusCount = (value: StatusFilter) => value === 'all' ? searched.length : searched.filter(c => c.status === value).length;
  const declarationColumns: Column<FulfillmentCustoms>[] = [
    { key: 'code', header: '报关记录', width: 'minmax(150px,1.3fr)', render: c => <div className="mist-col" style={{ gap: 2 }}><Mono>{c.declarationNo || c.code}</Mono><small className="mist-muted">{c.declarationNo ? c.code : '尚无报关单号'}</small></div> },
    { key: 'shipment', header: '出运', width: 'minmax(150px,1.3fr)', render: c => { const s = shipmentOf(c); return <div className="mist-col" style={{ gap: 2 }}><Mono>{s?.code || '出运不可用'}</Mono><small className="mist-muted">{s ? `${s.customer} · ${MODE_LABEL[s.mode]} → ${s.portOfDischarge}` : ''}</small></div>; } },
    { key: 'hs', header: 'HS / 报关行', width: 'minmax(120px,1fr)', hideOnMobile: true, render: c => <div className="mist-col" style={{ gap: 2 }}><span>{c.hsCode || '待核实'}</span><small className="mist-muted">{c.broker || '未定报关行'}</small></div> },
    { key: 'date', header: '申报 / 放行', width: '120px', hideOnMobile: true, render: c => <div className="mist-col" style={{ gap: 2 }}><span>{c.declaredAt || '未申报'}</span><small className="mist-muted">{c.clearedAt ? `放行 ${c.clearedAt}` : shipmentOf(c)?.plannedDate ? `计划出运 ${shipmentOf(c)!.plannedDate}` : ''}</small></div> },
    { key: 'status', header: '状态', width: '118px', render: c => <div className="mist-col" style={{ gap: 2, alignItems: 'flex-start' }}><Pill tone={CUSTOMS_TONE[c.status]}>{CUSTOMS_LABEL[c.status]}</Pill>{flagsOf(c).map(flag => <small key={flag.key} className={flag.key === 'unpacked' ? 'mist-muted' : 'mist-tone-bad'}>{flag.label}</small>)}</div> },
  ];
  const rebateColumns: Column<FulfillmentCustoms>[] = [
    { key: 'code', header: '报关单', width: 'minmax(150px,1.3fr)', render: c => <div className="mist-col" style={{ gap: 2 }}><Mono>{c.declarationNo}</Mono><small className="mist-muted">{shipmentOf(c)?.code} · {shipmentOf(c)?.customer}</small></div> },
    { key: 'release', header: '报关单放行', width: '120px', render: c => c.status === 'cleared' ? <div className="mist-col" style={{ gap: 2, alignItems: 'flex-start' }}><Pill tone="ok">已放行</Pill><small className="mist-muted">{c.clearedAt}</small></div> : <Pill tone="warn">待放行</Pill> },
    { key: 'collect', header: '收汇', width: 'minmax(130px,1.1fr)', render: c => { const e = rebateEvidence(state!, c); return e.collected ? <Pill tone="ok">已全部收汇</Pill> : !e.cis.length ? <span className="mist-muted">未签发 CI</span> : e.open.length ? <span className="mist-tone-bad">未收 {openText(e.open)}</span> : <span className="mist-muted">CI 应收不可用</span>; } },
    { key: 'vat', header: '增值税发票', width: '110px', hideOnMobile: true, render: () => <span className="mist-muted">尚未接入</span> },
    { key: 'ready', header: '资料', width: '90px', align: 'right', hideOnMobile: true, render: c => `${rebateEvidence(state!, c).ready} / 3` },
  ];
  const lcColumns: Column<MistOrder>[] = [
    { key: 'order', header: '订单', width: 'minmax(150px,1.2fr)', render: o => <div className="mist-col" style={{ gap: 2 }}><Mono>{o.code}</Mono><small className="mist-muted">{o.customer}</small></div> },
    { key: 'note', header: '合同付款约定', width: 'minmax(160px,1.6fr)', hideOnMobile: true, render: o => o.governance?.contract.paymentNote || <span className="mist-muted">合同未写明信用证条款</span> },
    { key: 'due', header: '订单交期', width: '110px', hideOnMobile: true, render: o => o.due || '未定' },
    { key: 'shipments', header: '出运', width: 'minmax(160px,1.4fr)', render: o => { const list = (f?.shipments || []).filter(s => s.state !== 'cancelled' && s.lines.some(line => line.orderId === o.id)); return list.length ? <div className="mist-col" style={{ gap: 4, alignItems: 'flex-start' }}>{list.map(s => <span key={s.id} className="mist-row" style={{ gap: 6 }}><Mono>{s.code}</Mono><Pill tone={STAGE_TONE[shipmentStage(state!, s)]}>{STAGE_LABEL[shipmentStage(state!, s)]}</Pill></span>)}</div> : <span className="mist-muted">尚未发起出运</span>; } },
    { key: 'next', header: '下次计划出运', width: '120px', render: o => { const next = (f?.shipments || []).filter(s => isOpenShipment(s) && s.plannedDate && s.lines.some(line => line.orderId === o.id)).map(s => s.plannedDate).sort()[0]; return next ? <span className={next < day ? 'mist-tone-bad' : undefined}>{next}</span> : <span className="mist-muted">—</span>; } },
  ];

  const eligible = eligibleShipments();
  const createButton = can ? <Button variant="primary" icon={Plus} disabled={invalidContext || !eligible.length} title={eligible.length ? undefined : '没有尚无报关记录的进行中出运'} onClick={() => setDialog(createSpec())}>建立报关记录</Button> : undefined;
  const filtered = tab === 'rebate' ? !!needle && inDomain.some(c => c.status !== 'draft') : inDomain.length > 0;
  const empty = filtered
    ? <EmptyState icon={SearchX} title="没有符合条件的报关记录" description="换个关键词或清除筛选。" action={<Button onClick={() => { setQuery(''); setStatusFilter('all'); setFlagFilter('all'); }}>清除筛选</Button>} />
    : tab === 'rebate'
      ? <EmptyState icon={Receipt} title="还没有可核对的退税资料" description="报关单登记为已申报或已放行后，会在这里核对放行与本票 CI 收汇。" />
      : <EmptyState icon={Stamp} title={invalidContext ? '来源出运不存在' : hasContext ? '本票还没有报关记录' : `还没有${domain === 'fabric' ? '面料' : '成衣'}报关记录`} description={invalidContext ? '请返回货运管理重新选择准确出运。' : '报关记录与出运一一对应：后勤接手出运后建立记录，向海关申报后登记报关单号，放行后登记放行日与依据。'} action={createButton && !invalidContext && eligible.length ? <Button icon={Plus} onClick={() => setDialog(createSpec())}>建立报关记录</Button> : undefined} />;
  const detail = selected && state
    ? <CustomsDetail record={selected} state={state} can={can} canInvoices={canInvoices} locked={locked}
        onEdit={() => setDialog(editSpec(selected))} onDeclare={() => setDialog(declareSpec(selected, selected.status === 'submitted'))} onRelease={() => setDialog(releaseSpec(selected))}
        onAttach={ids => run({ type: 'fulfillment.customs.save', payload: payload(selected, { fileIds: ids }) })}
        onShipment={() => go('shipments', selected.shipmentId)} onDocuments={() => go('document-center', undefined, { section: selected.shipmentId })} onInvoice={id => go('invoices', id)} />
    : <EmptyState icon={Stamp} title="报关详情" description={loading ? '正在读取报关记录' : tab === 'rebate' ? '从列表选择一张报关单，查看放行、收汇与退税资料' : '从列表选择一条报关记录，查看申报、放行与装箱核对'} compact />;
  const pendingShown = allPending ? pendingShipments : pendingShipments.slice(0, 3);
  const exportRows = () => exportRecords('报关台账', ['记录', '报关单号', '出运', '客户', 'HS编码', '报关行', '原产地', '成交方式', '状态', '申报日', '放行日'], rows.map(c => [c.code, c.declarationNo, shipmentOf(c)?.code || '', shipmentOf(c)?.customer || '', c.hsCode, c.broker, c.origin, c.tradeMode, CUSTOMS_LABEL[c.status], c.declaredAt, c.clearedAt]));

  return <MistPage width="wide">
    <PageHeader eyebrow="订单履约 · 出口" title="外贸与报关"
      description={invalidContext ? '指定出运不存在，请返回货运管理重新进入。' : contextShipment ? `${contextShipment.code} · ${contextShipment.customer} · 仅显示本票报关。` : '后勤单证按出运登记外部申报与放行事实；本系统不代替海关或单一窗口申报。信用证与退税只核对已登记事实。'}
      actions={<>
        {contextShipment && <Button onClick={() => go('shipments', contextShipment.id)}>返回出运</Button>}
        {hasContext && <Button onClick={() => go('customs')}>查看全部报关</Button>}
        {tab !== 'lc' && <Button icon={Download} disabled={!rows.length} onClick={exportRows}>导出</Button>}
        {tab === 'declarations' && createButton}
      </>} />
    {!can && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有报关单证权限，可以查看报关记录、信用证订单与退税资料。</Banner></div>}
    {error && <div className="mist-section"><Banner tone="bad" title="报关数据未读取" actions={<Button onClick={() => void refresh()}>重试</Button>}>{error}</Banner></div>}
    {!hasContext && <div className="mist-section"><Tabs<Tab> value={tab} onChange={changeTab} options={[{ value: 'declarations', label: '报关', count: inDomain.length }, { value: 'lc', label: '信用证', count: lcAll.filter(o => o.type === domain).length }, { value: 'rebate', label: '退税', count: inDomain.filter(c => c.status !== 'draft').length }]} /></div>}
    {!hasContext && <div className="mist-section"><Segmented<Domain> ariaLabel="业务板块" value={domain} onChange={changeDomain} options={[{ value: 'garment', label: `成衣业务 · ${tab === 'lc' ? lcAll.filter(o => o.type === 'garment').length : records.filter(c => domainOf(c) === 'garment').length}` }, { value: 'fabric', label: `面料业务 · ${tab === 'lc' ? lcAll.filter(o => o.type === 'fabric').length : records.filter(c => domainOf(c) === 'fabric').length}` }]} /></div>}
    <Toolbar>
      <SearchField value={query} onChange={setQuery} placeholder={tab === 'lc' ? '搜索订单号、客户或付款约定' : '搜索报关单号、记录号、出运号、客户、HS 编码或报关行'} />
      {tab === 'declarations' && <Dropdown<FlagFilter> label="筛选" value={flagFilter} onChange={setFlagFilter} options={[{ value: 'all', label: '全部' }, { value: 'attention', label: '需要关注' }, { value: 'awaiting', label: '离港等待放行' }, { value: 'packing', label: '装箱未完成或不符' }]} />}
    </Toolbar>
    {tab === 'declarations' && <>
      {pendingShipments.length > 0 && <div className="mist-section"><Card>
        <CardHeader title={`待建报关 · ${pendingShipments.length}`} sub="已发起、尚无报关记录的出运；后勤接手后在这里建立记录。" />
        <DataTable ariaLabel="待建报关的出运" rows={pendingShown} rowKey={s => s.id} columns={[
          { key: 'code', header: '出运', width: 'minmax(150px,1.4fr)', render: s => <div className="mist-col" style={{ gap: 2 }}><Mono>{s.code}</Mono><small className="mist-muted">{s.customer} · {MODE_LABEL[s.mode]} → {s.portOfDischarge}</small></div> },
          { key: 'stage', header: '出运阶段', width: '120px', hideOnMobile: true, render: s => <Pill tone={STAGE_TONE[shipmentStage(state!, s)]}>{STAGE_LABEL[shipmentStage(state!, s)]}</Pill> },
          { key: 'packing', header: '装箱', width: '120px', hideOnMobile: true, render: s => !f!.packing.some(row => row.shipmentId === s.id) ? <span className="mist-muted">未装箱</span> : packingMatched(state!, s) ? '与计划一致' : <span className="mist-tone-bad">与计划不符</span> },
          { key: 'date', header: '计划出运', width: '110px', hideOnMobile: true, render: s => <span className={s.plannedDate && s.plannedDate < day ? 'mist-tone-bad' : undefined}>{s.plannedDate || '未定'}</span> },
          ...(can ? [{ key: 'act', header: '', width: '132px', align: 'right' as const, render: (s: FulfillmentShipment) => <Button size="sm" icon={Plus} disabled={locked} onClick={() => setDialog(createSpec(s.id))} aria-label={`为 ${s.code} 建立报关记录`}>建立记录</Button> }] : []),
        ]} />
        {pendingShipments.length > 3 && <div className="mist-row" style={{ padding: '8px 16px 12px' }}><TextLink onClick={() => setAllPending(v => !v)}>{allPending ? '收起' : `显示全部 ${pendingShipments.length} 票`}</TextLink></div>}
      </Card></div>}
      <Pipeline<StatusFilter> value={statusFilter} onChange={setStatusFilter} items={[
        { value: 'all', label: '全部记录', count: statusCount('all'), color: 'var(--mist-ink-2)' },
        { value: 'draft', label: '未申报', count: statusCount('draft'), color: 'var(--mist-warn)' },
        { value: 'submitted', label: '已申报 · 待放行', count: statusCount('submitted'), color: 'var(--mist-accent)' },
        { value: 'cleared', label: '已放行', count: statusCount('cleared'), color: 'var(--mist-ok)' },
      ]} />
    </>}
    {tab === 'rebate' && <div className="mist-section"><Banner tone="neutral" title="参考退税额与到账勾稽尚未接入">服务端还没有退税率版本、供应商增值税发票与退税到账记录。下表只核对已登记的事实：报关单放行，以及本票已签发 CI 的应收是否全部收汇。</Banner></div>}
    {tab === 'lc'
      ? <>
        <div className="mist-section"><Banner tone="neutral" title="信用证台账尚未接入">服务端还没有信用证号、开证行、金额、最晚装运日、有效期、交单期与不符点记录，本页不做倒计时提醒。下面列出合同约定以信用证付款的订单及其出运，便于按原件人工核对；信用证原件请保存在订单合同附件中。</Banner></div>
        <Card><DataTable ariaLabel="信用证付款订单" loading={loading} rows={lcRows} rowKey={o => o.id} density="comfy" onRowClick={o => go('orders/detail', o.id, { customerId: o.customerId, section: o.type })} columns={lcColumns}
          empty={needle && lcAll.some(o => o.type === domain) ? <EmptyState icon={SearchX} title="没有符合条件的订单" description="换个关键词试试。" action={<Button onClick={() => setQuery('')}>清除搜索</Button>} /> : <EmptyState icon={Landmark} title={`没有约定信用证付款的${domain === 'fabric' ? '面料' : '成衣'}订单`} description="订单合同的付款方式选择“信用证”后，会在这里列出订单与相关出运。" />} /></Card>
      </>
      : <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)} drawerTitle={selected ? `${selected.declarationNo || selected.code} · ${shipmentOf(selected)?.customer || ''}` : '报关详情'} drawerSub={selected ? `${shipmentOf(selected)?.code || ''} · ${CUSTOMS_LABEL[selected.status]}` : undefined}
          list={<Card><DataTable ariaLabel={tab === 'rebate' ? '退税资料核对' : '报关列表'} loading={loading} rows={rows} rowKey={c => c.id} selectedKey={selected?.id} density="comfy" onRowClick={pick} columns={tab === 'rebate' ? rebateColumns : declarationColumns} empty={empty} /></Card>}
          detail={detail} />}
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage>;
}

function CustomsDetail({ record: c, state, can, canInvoices, locked, onEdit, onDeclare, onRelease, onAttach, onShipment, onDocuments, onInvoice }: {
  record: FulfillmentCustoms; state: MistState; can: boolean; canInvoices: boolean; locked: boolean;
  onEdit: () => void; onDeclare: () => void; onRelease: () => void; onAttach: (ids: string[]) => Promise<unknown>; onShipment: () => void; onDocuments: () => void; onInvoice: (id: string) => void;
}) {
  const f = state.fulfillment, s = f.shipments.find(row => row.id === c.shipmentId), flags = customsFlags(state, c);
  const packingRows = f.packing.filter(row => row.shipmentId === c.shipmentId), documents = f.documents.filter(row => row.shipmentId === c.shipmentId);
  const closed = !s || s.state === 'departed' || s.state === 'cancelled';
  const baseReason = !can ? '需要报关单证权限' : closed ? '出运已离港或已取消，报关记录不能再修改' : false;
  const evidence = rebateEvidence(state, c);
  const unit = (lineId: string) => state.orderLines.find(line => line.id === lineId)?.unit || '';
  const cartons = new Set(packingRows.map(row => row.carton)).size, net = round(packingRows.reduce((sum, row) => sum + row.netWeight, 0)), gross = round(packingRows.reduce((sum, row) => sum + row.grossWeight, 0)), volume = round(packingRows.reduce((sum, row) => sum + row.volume, 0));
  const next: { tone: Tone; title: string; text: string } = flags.some(flag => flag.key === 'cancelled') ? { tone: 'neutral', title: '出运已取消', text: '本报关记录保留为历史；如已向海关申报，请在外部办理撤单。' }
    : c.status === 'draft' ? { tone: 'warn', title: '资料准备中', text: '向海关申报后，登记报关单号、报关行、HS 编码、原产地、贸易方式与申报日。' }
    : c.status === 'submitted' ? { tone: flags.some(flag => flag.key === 'awaiting') ? 'bad' : 'accent', title: '已申报，等待放行', text: flags.some(flag => flag.key === 'awaiting') ? '业务已对客发送 CI / PL，出运正在等海关放行才能登记实际离港。' : '取得海关放行后登记放行日与依据；放行后本记录不可覆盖。' }
    : { tone: 'ok', title: '已放行', text: s?.state === 'departed' ? `已随出运离港（ATD ${s.departedAt ? shortWhen(s.departedAt) : ''}）。` : '出口清关已完成，后勤可在出运中登记实际离港。' };
  return <DetailBody data-customs-detail={c.id} heading={<div>
      <span className="mist-mono mist-muted">{c.code}</span>
      <div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{c.declarationNo ? `报关单 ${c.declarationNo}` : `${s?.code || '出运'} · 未申报`}</div>
    </div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={CUSTOMS_TONE[c.status]}>{CUSTOMS_LABEL[c.status]}</Pill>{s && <Pill>{s.domain === 'fabric' ? '面料业务' : '成衣业务'}</Pill>}{s && <Pill>{MODE_LABEL[s.mode]}</Pill>}{flags.map(flag => <Pill key={flag.key} tone={flag.key === 'unpacked' ? 'warn' : 'bad'}>{flag.label}</Pill>)}</div>
    <Banner tone={next.tone} title={next.title}>{next.text}</Banner>
    {can && c.status !== 'cleared' && <ActionBar busy={locked} actions={[
      { label: '登记已申报', icon: Stamp, onClick: onDeclare, primary: true, reason: baseReason, hidden: c.status !== 'draft' },
      { label: '编辑报关资料', icon: Pencil, onClick: onEdit, reason: baseReason, hidden: c.status !== 'draft' },
      { label: '登记海关放行', icon: Stamp, onClick: onRelease, primary: true, reason: baseReason, hidden: c.status !== 'submitted' },
      { label: '更正申报信息', icon: Pencil, onClick: onDeclare, reason: baseReason, hidden: c.status !== 'submitted' },
    ] as ReasonedAction[]} />}
    {c.status === 'cleared' && <span className="mist-note">已放行记录不可覆盖；如需更正，请先在海关办理改单后补充附件说明。</span>}
    <Facts items={[
      { label: '出运', value: s ? <TextLink onClick={onShipment}>{s.code}</TextLink> : '出运不可用' },
      { label: '客户', value: s?.customer || '—' },
      { label: '运输', value: s ? `${MODE_LABEL[s.mode]} · ${s.portOfLoading} → ${s.portOfDischarge} · ${s.incoterm}` : '—' },
      { label: '报关单号', value: c.declarationNo || '未申报' },
      { label: '报关行', value: c.broker || '未填写' },
      { label: 'HS 编码', value: c.hsCode || '待核实' },
      { label: '原产地', value: c.origin || '未填写' },
      { label: '贸易方式 / 成交方式', value: c.tradeMode || '未填写' },
      { label: '申报日', value: c.declaredAt || '未申报' },
      { label: '放行日', value: c.clearedAt || (c.status === 'submitted' ? '待放行' : '—') },
    ]} />
    {c.evidence && <p className="mist-sub">放行依据：{c.evidence}</p>}
    {c.note && <p className="mist-sub">备注：{c.note}</p>}
    <span className="mist-note">申报品名、申报要素与申报金额尚未接入：服务端目前只记录 HS 编码、原产地与贸易方式，请把报关单原件作为附件保存。</span>
    <DetailBlock title="与装箱实货核对">
      {s ? <DataTable ariaLabel={`${c.code} 装箱核对`} rows={s.lines} rowKey={line => line.lineId + ':' + (line.productionId || '')} columns={[
        { key: 'source', header: '准确条目', render: line => <SourceLink source={{ kind: 'orderLine', orderId: line.orderId, lineId: line.lineId, productionId: line.productionId }} /> },
        { key: 'plan', header: '计划 / 已装箱', align: 'right', render: line => { const packed = packedFor(state, s, line); return <span className={packingRows.length && packed !== line.quantity ? 'mist-tone-bad' : undefined}>{line.quantity} / {packed} {unit(line.lineId)}</span>; } },
      ]} /> : <span className="mist-note">出运不可用，无法核对装箱。</span>}
      {packingRows.length > 0 ? <Facts cols={4} items={[{ label: '箱数', value: `${cartons} 箱` }, { label: '净重', value: `${net} kg` }, { label: '毛重', value: `${gross} kg` }, { label: '体积', value: `${volume} m³` }]} /> : s && <span className="mist-note">后勤尚未装箱；申报数量与重量须以实际装箱为准。</span>}
    </DetailBlock>
    <DetailBlock title="本票单据" aside={s && <TextLink icon={FileText} onClick={onDocuments}>处理本票单据</TextLink>}>
      {documents.length ? <DataTable ariaLabel={`${c.code} 本票单据`} rows={documents} rowKey={row => row.id} columns={[
        { key: 'type', header: '类型', render: row => row.type },
        { key: 'number', header: '编号 · 版本', render: row => `${row.number || '未编号'} · v${row.version}` },
        { key: 'status', header: '状态', render: row => <Pill tone={row.status === 'issued' ? 'ok' : row.status === 'void' ? 'neutral' : 'warn'}>{row.status === 'issued' ? '已签发' : row.status === 'void' ? '已作废' : '草稿'}</Pill> },
      ]} /> : <span className="mist-note">本票还没有单据；CI / PL 在单据中心按版本签发。</span>}
    </DetailBlock>
    {c.status !== 'draft' && <DetailBlock title="退税资料" aside={<span className="mist-muted">已具备 {evidence.ready} / 3</span>}>
      <Checklist items={[
        { label: '报关单（海关放行）', done: evidence.released, note: evidence.released ? `${c.declarationNo} · 放行 ${c.clearedAt}` : `${c.declarationNo} · 待放行` },
        { label: '收汇（本票 CI 应收）', done: evidence.collected, note: !evidence.cis.length ? '本票尚未签发 CI' : evidence.collected ? `${evidence.invoices.length} 张应收已全部收汇` : evidence.open.length ? `未收 ${openText(evidence.open)}` : 'CI 对应应收不可用', noteTone: evidence.open.length ? 'bad' : undefined },
        { label: '增值税专用发票', done: false, note: '尚未接入：服务端还没有供应商增值税发票记录' },
      ]} />
      {canInvoices && evidence.invoices.length > 0 && <div className="mist-row" style={{ flexWrap: 'wrap' }}>{evidence.invoices.map((invoice: MistInvoice) => <TextLink key={invoice.id} icon={Receipt} onClick={() => onInvoice(invoice.id)}>查看应收 {invoice.code}</TextLink>)}</div>}
      <span className="mist-note">参考退税额与退税到账勾稽尚未接入（缺退税率版本与到账记录）。</span>
    </DetailBlock>}
    <DetailBlock title="附件"><RecordFiles key={c.id} ids={c.fileIds} onAttach={can && c.status !== 'cleared' && !closed ? onAttach : undefined} />{!c.fileIds.length && <span className="mist-note">报关单、放行通知等原件作为附件保存</span>}</DetailBlock>
    <DetailBlock title="处理记录"><Events entity="customs" id={c.id} /></DetailBlock>
  </DetailBody>;
}
