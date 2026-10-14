/** 采购管理：面料 / 成衣业务组下分“采购订单”“委外加工单”两个入口；阶段流水线 + 单据详情轨迹，所有对外动作都登记真实依据。 */
import React from 'react';
import { CheckCircle2, Download, FileSignature, PackageCheck, Pencil, Plus, SearchX, Send, ShoppingCart, Undo2, Workflow } from 'lucide-react';
import { Banner, Button, Card, Checklist, DataTable, Dropdown, EmptyState, Facts, MistPage, Mono, PageHeader, Pill, Pipeline, SearchField, Segmented, Tabs, Timeline, Toolbar, type Column, type Tone } from '../../../../../components/mist';
import type { MistState } from '../../../../../server/src/shared/mistWorkspace';
import type { FulfillmentPurchase } from '../../../../../server/src/shared/mistFulfillment';
import { fulfillmentSourceLabel } from '../../../../../server/src/shared/mistFulfillment';
import { purchaseContractMinor, purchasePayableReadback, purchasePrepaymentReadback } from '../../../../../server/src/shared/mistPayables';
import { supplierBusinessDay, supplierStatusOn, supplierUnavailableReason } from '../../../../../server/src/shared/mistSupplierStatus';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { ModuleEditorDialog, type ModuleEditorSpec } from './ModuleWorkbench';
import { emptyOption, Events, exportRecords, field, localNow, number, parseSource, RecordFiles, SourceLink, sourceOptions, status, text, today, useEditor } from './fulfillmentKit';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen } from './pageKit';

type Domain = FulfillmentPurchase['domain'];
type Entry = 'purchase' | 'processing';
type Stage = 'draft' | 'pending' | 'supplier' | 'fulfilling' | 'done';
type StageFilter = 'all' | Stage;
type FlagFilter = 'all' | 'overdue' | 'variance' | 'returned';

const ENTRY_LABEL: Record<Entry, string> = { purchase: '采购订单', processing: '委外加工单' };
const KIND_LABEL: Record<FulfillmentPurchase['kind'], string> = { material: '材料', finished: '成品', processing: '加工服务' };
const STAGE_LABEL: Record<Stage, string> = { draft: '需求草稿', pending: '待审批', supplier: '待供应商确认', fulfilling: '供应履约中', done: '已完成' };
const STAGE_TONE: Record<Stage, Tone> = { draft: 'neutral', pending: 'warn', supplier: 'accent', fulfilling: 'accent', done: 'ok' };
const entryOf = (purchase: FulfillmentPurchase): Entry => purchase.kind === 'processing' ? 'processing' : 'purchase';
/** Approval state plus real offline facts; never infers supplier progress that was not recorded. */
export function purchaseStage(purchase: FulfillmentPurchase): Stage {
  if (purchase.state === 'draft' || purchase.state === 'rejected') return 'draft';
  if (purchase.state === 'pending') return 'pending';
  if (purchase.quantity > 0 && purchase.received >= purchase.quantity) return 'done';
  return purchase.supplierConfirmation || purchase.received > 0 ? 'fulfilling' : 'supplier';
}
function purchaseFlags(purchase: FulfillmentPurchase, day: string) {
  const stage = purchaseStage(purchase), flags: Array<{ key: Exclude<FlagFilter, 'all'>; label: string }> = [];
  if (purchase.state === 'rejected') flags.push({ key: 'returned', label: '审批退回' });
  if (stage !== 'done' && stage !== 'draft' && purchase.due && purchase.due < day) flags.push({ key: 'overdue', label: '已过要求交期' });
  if (purchase.received > purchase.quantity) flags.push({ key: 'variance', label: `超收 ${round(purchase.received - purchase.quantity)} ${purchase.unit}` });
  return flags;
}
const round = (value: number) => Math.round(value * 10000) / 10000;

export function ProcurementPage() {
  const { state, run, error, refresh, loading, saving, pending } = useMistWorkspace(), session = useMistSession(), editor = useEditor(), { go, route } = useNav();
  const [domainChoice, setDomainChoice] = React.useState<Domain | null>(null), [entryChoice, setEntryChoice] = React.useState<Entry | null>(null);
  const [stageFilter, setStageFilter] = React.useState<StageFilter>('all'), [flagFilter, setFlagFilter] = React.useState<FlagFilter>('all'), [query, setQuery] = React.useState('');
  const [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(!!route.id);
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null), [failure, setFailure] = useRouteDraft('');
  React.useEffect(() => { if (route.id) { setPicked(route.id); setDomainChoice(null); setEntryChoice(null); } }, [route.id]);
  const day = supplierBusinessDay(new Date());
  const expectedOrderId = route.section?.startsWith('order:') ? route.section.slice(6) : undefined;
  const incomingLine = state?.orderLines.find(line => line.id === route.orderLineId);
  const incomingOrder = state?.orders.find(order => order.id === incomingLine?.orderId);
  const sourceLine = incomingLine && incomingOrder && (!expectedOrderId || incomingLine.orderId === expectedOrderId) && (!route.customerId || incomingOrder.customerId === route.customerId) ? incomingLine : undefined;
  const sourceOrder = sourceLine ? incomingOrder : undefined, invalidSource = !!state && !!route.orderLineId && !sourceLine;
  const sourceHint = invalidSource ? '指定来源不存在或不属于当前订单，请重新选择准确订单条目。' : undefined;
  const all = state?.fulfillment.purchases || [];
  const inScope = all.filter(p => !route.orderLineId || (!!sourceLine && p.lineId === sourceLine.id && p.orderId === sourceLine.orderId));
  const routed = all.find(p => p.id === route.id);
  const domain: Domain = domainChoice || routed?.domain || sourceOrder?.type || (inScope.some(p => p.domain === 'garment') || !inScope.some(p => p.domain === 'fabric') ? 'garment' : 'fabric');
  const domainRows = inScope.filter(p => p.domain === domain);
  const entry: Entry = entryChoice || (routed && routed.domain === domain ? entryOf(routed) : domainRows.some(p => entryOf(p) === 'purchase') || !domainRows.some(p => entryOf(p) === 'processing') ? 'purchase' : 'processing');
  const entryRows = domainRows.filter(p => entryOf(p) === entry);
  const needle = query.trim().toLowerCase();
  const searched = entryRows.filter(p => (!needle || `${p.code} ${p.supplier} ${p.description} ${p.destination} ${p.terms} ${state ? fulfillmentSourceLabel(state, { kind: 'orderLine', orderId: p.orderId, lineId: p.lineId }) : ''}`.toLowerCase().includes(needle))
    && (flagFilter === 'all' || purchaseFlags(p, day).some(flag => flag.key === flagFilter)));
  const rows = searched.filter(p => stageFilter === 'all' || purchaseStage(p) === stageFilter)
    .sort((a, b) => Number(purchaseFlags(b, day).length > 0) - Number(purchaseFlags(a, day).length > 0) || Number(purchaseStage(a) === 'done') - Number(purchaseStage(b) === 'done') || (a.due || '9').localeCompare(b.due || '9'));
  const selected = rows.find(p => p.id === picked) || (picked ? all.find(p => p.id === picked && p.domain === domain && entryOf(p) === entry) : undefined);
  const can = session.hasPermission('procurement:write'), canApprove = session.hasPermission('procurement:approve'), me = session.user?.id || '';
  const locked = saving || !!pending;
  if (editor.spec) return editor.view;

  const pick = (purchase: FulfillmentPurchase) => { setPicked(purchase.id); setDrawer(true); const { view, id: _id, ...target } = route; go(view, purchase.id, target); };
  const changeDomain = (value: Domain) => { setDomainChoice(value); setEntryChoice(null); setStageFilter('all'); setPicked(null); };
  const changeEntry = (value: Entry) => { setEntryChoice(value); setStageFilter('all'); setPicked(null); };
  const act = async (work: () => Promise<unknown>) => { setFailure(''); try { await work(); } catch (e) { setFailure(e instanceof Error ? e.message : String(e)); } };
  const supplierOptions = (currentId?: string) => (state?.market.suppliers || [])
    .filter(s => s.id === currentId || supplierStatusOn(s, day) === 'active')
    .map(s => { const reason = supplierUnavailableReason(s, day); return { value: s.id, label: reason ? `${s.name} · 原供应商（${reason}）` : s.name }; });
  const purchaseSpec = (p?: FulfillmentPurchase): ModuleEditorSpec => ({
    title: p ? `修订${ENTRY_LABEL[entryOf(p)]}草稿` : `新建${ENTRY_LABEL[entry]}`, submitLabel: p ? '保存草稿' : '保存为草稿',
    description: '先核对来源与供应商，再确认数量、费用及交付约定。保存草稿不会形成对外承诺；批准后才能对外发出。',
    sections: [
      { id: 'source', label: '来源与供应商', description: '确认由谁供给、为哪个订单条目履约；材料、成品与加工服务分别记录。', fields: ['source', 'kind', 'supplierId', 'description'] },
      { id: 'commercial', label: '数量与费用', description: '按本次供给的实际计量单位记录数量与单价，不自动换算单位或币种。', fields: ['quantity', 'unit', 'price', 'currency'] },
      { id: 'delivery', label: '交付约定', description: '交期、付款条件与主要交付地点将随提交版本冻结，批准后再登记线下发出。', fields: ['due', 'terms', 'destination', 'note'] },
    ],
    fields: [{ ...field('source', '来源条目', 'select', true, sourceOptions(state, false)), hint: sourceHint }, field('kind', '采购类型', 'select', true, [{ value: 'material', label: '材料' }, { value: 'finished', label: '成品' }, { value: 'processing', label: '加工服务' }]), field('supplierId', '供应商', 'select', true, [emptyOption, ...supplierOptions(p?.supplierId)]), field('description', '采购内容 / 规格'), field('quantity', '承诺数量', 'number'), field('unit', '计量单位'), field('price', '含税 / 约定单价', 'number'), field('currency', '币种'), field('due', '交期', 'date'), field('terms', '付款条件'), field('destination', '主要交付地点'), field('note', '补充约定', 'textarea', false)],
    initialValues: { source: p ? 'line:' + p.lineId : sourceLine ? 'line:' + sourceLine.id : '', kind: p?.kind || (entry === 'processing' ? 'processing' : 'material'), supplierId: p?.supplierId || '', description: p?.description || '', quantity: p?.quantity || sourceLine?.qty || 1, unit: p?.unit || sourceLine?.unit || '', price: p?.price || 0, currency: p?.currency || sourceOrder?.currency || 'USD', due: p?.due || today(), terms: p?.terms || '', destination: p?.destination || '', note: p?.note || '' },
    submit: async values => {
      if (!state) return;
      const source = parseSource(state, text(values, 'source'));
      if (source.kind !== 'orderLine') throw new Error('采购必须关联订单条目');
      const supplier = state.market.suppliers.find(s => s.id === text(values, 'supplierId'));
      if (!supplier) throw new Error('请选择当前供应商');
      const saved = await run({ type: 'fulfillment.procurement.save', payload: { ...(p ? { id: p.id } : {}), orderId: source.orderId, lineId: source.lineId, kind: text(values, 'kind') as FulfillmentPurchase['kind'], supplierId: supplier.id, supplier: supplier.name, description: text(values, 'description'), quantity: number(values, 'quantity'), unit: text(values, 'unit'), price: number(values, 'price'), currency: text(values, 'currency'), due: text(values, 'due'), terms: text(values, 'terms'), destination: text(values, 'destination'), note: text(values, 'note'), fileIds: p?.fileIds || [] } });
      const id = String(saved?.result?.id || p?.id || '');
      if (id) { setPicked(id); setEntryChoice(text(values, 'kind') === 'processing' ? 'processing' : 'purchase'); }
    },
  });
  const sendSpec = (p: FulfillmentPurchase): ModuleEditorSpec => ({ title: '登记批准合同线下发出', submitLabel: '登记发出', fields: [field('at', '实际发出时间', 'datetime-local'), field('evidence', '发出方式与依据', 'textarea')], initialValues: { at: localNow(), evidence: '' }, submit: values => run({ type: 'fulfillment.procurement.send', payload: { id: p.id, at: new Date(text(values, 'at')).toISOString(), evidence: text(values, 'evidence'), fileIds: [] } }) });
  const confirmSpec = (p: FulfillmentPurchase): ModuleEditorSpec => ({ title: '登记供应商线下确认', submitLabel: '登记确认', fields: [field('at', '实际确认时间', 'datetime-local'), { ...field('confirmedDue', '确认交期', 'date'), hint: '须与批准交期一致；不同需先走商业变更。' }, field('evidence', '供应商确认依据', 'textarea')], initialValues: { at: localNow(), confirmedDue: p.due, evidence: '' }, submit: values => run({ type: 'fulfillment.procurement.confirm', payload: { id: p.id, at: new Date(text(values, 'at')).toISOString(), confirmedDue: text(values, 'confirmedDue'), evidence: text(values, 'evidence'), fileIds: [] } }) });
  const receiveSpec = (p: FulfillmentPurchase): ModuleEditorSpec => ({ title: p.kind === 'processing' ? '登记加工回交' : '登记真实交付 / 收货', submitLabel: '登记本次交付', fields: [field('quantity', `接收数量（${p.unit}）`, 'number'), field('rejected', `拒收数量（${p.unit}）`, 'number'), field('destination', '真实路径', 'select', true, [{ value: 'warehouse', label: '入我方仓库' }, { value: 'supplier', label: p.kind === 'processing' ? '加工服务交付' : '供应商直送加工方' }]), field('location', '实际交接地点'), field('date', '实际交付日', 'date'), field('evidence', '点数与交接依据', 'textarea')], initialValues: { quantity: Math.max(0, round(p.quantity - p.received)), rejected: 0, destination: p.kind === 'processing' ? 'supplier' : 'warehouse', location: p.destination, date: today(), evidence: '' }, submit: values => run({ type: 'fulfillment.procurement.receive', payload: { id: p.id, quantity: number(values, 'quantity'), rejected: number(values, 'rejected'), destination: text(values, 'destination') as 'warehouse' | 'supplier', location: text(values, 'location'), date: text(values, 'date'), evidence: text(values, 'evidence'), fileIds: [] } }) });
  const decideSpec = (p: FulfillmentPurchase, decision: 'approved' | 'rejected'): ModuleEditorSpec => ({ title: decision === 'approved' ? '批准采购承诺' : '退回采购', submitLabel: decision === 'approved' ? '批准' : '退回修改', fields: [field('note', '审批意见', 'textarea')], initialValues: { note: '' }, submit: values => run({ type: 'fulfillment.procurement.decide', payload: { id: p.id, decision, note: text(values, 'note') } }) });

  const stageCount = (value: StageFilter) => value === 'all' ? searched.length : searched.filter(p => purchaseStage(p) === value).length;
  const lineLabel = (p: FulfillmentPurchase) => state ? fulfillmentSourceLabel(state, { kind: 'orderLine', orderId: p.orderId, lineId: p.lineId }) : '';
  const columns: Column<FulfillmentPurchase>[] = [
    { key: 'code', header: ENTRY_LABEL[entry], width: 'minmax(200px,2.2fr)', render: p => <div className="mist-col" style={{ gap: 2 }}><span><Mono>{p.code}</Mono> · {p.description}</span><small className="mist-muted">{KIND_LABEL[p.kind]} · {lineLabel(p)}</small></div> },
    { key: 'supplier', header: '供应商', width: 'minmax(120px,1fr)', hideOnMobile: true, render: p => <div className="mist-col" style={{ gap: 2 }}><span>{p.supplier}</span><small className="mist-muted">{p.terms || '付款条件未填'}</small></div> },
    { key: 'due', header: '要求 / 承诺交期', width: '128px', hideOnMobile: true, render: p => <div className="mist-col" style={{ gap: 2 }}><span className={purchaseFlags(p, day).some(flag => flag.key === 'overdue') ? 'mist-tone-bad' : undefined}>{p.due || '未填'}</span><small className="mist-muted">{p.supplierConfirmation ? `承诺 ${shortWhen(p.supplierConfirmation.confirmedDue)}` : '供应商未确认'}</small></div> },
    { key: 'received', header: entry === 'processing' ? '累计回交' : '累计交付', width: '136px', align: 'right', hideOnMobile: true, render: p => <div className="mist-col" style={{ gap: 2, alignItems: 'flex-end' }}><span className="mist-num" style={{ whiteSpace: 'nowrap' }}>{p.received} / {p.quantity} {p.unit}</span>{purchaseFlags(p, day).filter(flag => flag.key === 'variance').map(flag => <small key={flag.key} className="mist-tone-bad">{flag.label}</small>)}</div> },
    { key: 'state', header: '审批 / 阶段', width: '104px', render: p => <div className="mist-col" style={{ gap: 2, alignItems: 'flex-start' }}><Pill tone={p.state === 'approved' ? STAGE_TONE[purchaseStage(p)] : p.state === 'rejected' ? 'bad' : p.state === 'pending' ? 'warn' : 'neutral'}>{status[p.state]}</Pill>{p.state === 'approved' && <small className="mist-muted">{STAGE_LABEL[purchaseStage(p)]}</small>}</div> },
  ];
  const createButton = can ? <Button variant="primary" icon={Plus} disabled={locked} onClick={() => editor.open(purchaseSpec())}>{`新建${ENTRY_LABEL[entry]}`}</Button> : undefined;
  const empty = entryRows.length
    ? <EmptyState icon={SearchX} title="没有符合条件的单据" description="换个关键词或清除筛选。" action={<Button onClick={() => { setQuery(''); setStageFilter('all'); setFlagFilter('all'); }}>清除筛选</Button>} />
    : <EmptyState icon={entry === 'processing' ? Workflow : ShoppingCart} title={sourceLine ? `本条目还没有${ENTRY_LABEL[entry]}` : `还没有${domain === 'fabric' ? '面料' : '成衣'}${ENTRY_LABEL[entry]}`} description={entry === 'processing' ? '委外加工单从订单条目发起：选择加工厂、约定加工费与回交日期，批准后发出。' : '采购订单从订单条目的物料或成品需求发起，批准后才能发给供应商。'} action={can ? <Button icon={Plus} onClick={() => editor.open(purchaseSpec())}>{`新建${ENTRY_LABEL[entry]}`}</Button> : undefined} />;
  const detail = selected && state
    ? <PurchaseDetail purchase={selected} state={state} day={day} me={me} can={can} canApprove={canApprove} locked={locked}
        onEdit={() => editor.open(purchaseSpec(selected))}
        onSubmit={() => void act(() => run({ type: 'fulfillment.procurement.submit', payload: { id: selected.id } }))}
        onDecide={decision => setDialog(decideSpec(selected, decision))}
        onSend={() => setDialog(sendSpec(selected))} onConfirm={() => setDialog(confirmSpec(selected))} onReceive={() => setDialog(receiveSpec(selected))}
        onDownload={() => void act(async () => downloadApprovedPurchase(state, selected))}
        onAttach={ids => run({ type: 'fulfillment.procurement.save', payload: { ...selected, fileIds: ids } })}
        onInventory={() => go('inventory', undefined, { section: selected.id })} onSupplier={() => go('suppliers', selected.supplierId)} />
    : <EmptyState icon={entry === 'processing' ? Workflow : ShoppingCart} title="单据详情" description={loading ? '正在读取采购' : '从列表选择一张单据，查看审批、供应商确认与交付轨迹'} compact />;

  return <MistPage width="wide">
    <PageHeader eyebrow="订单履约 · 采购与委外" title="采购管理" description={sourceHint || (sourceLine && sourceOrder ? `${sourceOrder.code} · ${sourceLine.style} · ${sourceLine.name} · 只显示本条目的采购与委外。` : '从准确订单条目形成供应承诺：批准后线下发出、登记供应商确认，再逐次登记真实交付与回交。')}
      actions={<>
        {sourceOrder && sourceLine && <Button onClick={() => go('orders/detail', sourceOrder.id, { orderLineId: sourceLine.id, customerId: sourceOrder.customerId, section: sourceOrder.type })}>返回来源订单</Button>}
        {route.orderLineId && <Button onClick={() => go('procurement')}>查看全部采购</Button>}
        <Button icon={Download} disabled={!rows.length} onClick={() => exportRecords('采购台账', ['编号', '入口', '供应商', '内容', '数量', '单位', '单价', '币种', '要求交期', '承诺交期', '审批', '阶段', '累计交付'], rows.map(p => [p.code, ENTRY_LABEL[entryOf(p)], p.supplier, p.description, p.quantity, p.unit, p.price, p.currency, p.due, p.supplierConfirmation?.confirmedDue || '', status[p.state], STAGE_LABEL[purchaseStage(p)], p.received]))}>导出</Button>
        {createButton}
      </>} />
    {!can && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有采购写权限，可以查看单据与轨迹；新建、发出与交付登记由对应业务组经办人操作。</Banner></div>}
    {(error || failure) && <div className="mist-section"><Banner tone="bad" title="采购操作未完成" actions={error ? <Button onClick={() => void refresh()}>重试</Button> : undefined}>{failure || error}</Banner></div>}
    <div className="mist-section"><Segmented<Domain> ariaLabel="业务板块" value={domain} onChange={changeDomain} options={[{ value: 'garment', label: `成衣业务 · ${inScope.filter(p => p.domain === 'garment').length}` }, { value: 'fabric', label: `面料业务 · ${inScope.filter(p => p.domain === 'fabric').length}` }]} /></div>
    <Tabs<Entry> value={entry} onChange={changeEntry} options={[{ value: 'purchase', label: '采购订单', count: domainRows.filter(p => entryOf(p) === 'purchase').length }, { value: 'processing', label: '委外加工单', count: domainRows.filter(p => entryOf(p) === 'processing').length }]} />
    <Toolbar>
      <SearchField value={query} onChange={setQuery} placeholder="搜索单据号、供应商、内容或来源订单" />
      <Dropdown<FlagFilter> label="异常" value={flagFilter} onChange={setFlagFilter} options={[{ value: 'all', label: '全部' }, { value: 'overdue', label: '已过要求交期' }, { value: 'variance', label: '数量差异' }, { value: 'returned', label: '审批退回' }]} />
    </Toolbar>
    <Pipeline<StageFilter> value={stageFilter} onChange={setStageFilter} items={[
      { value: 'all', label: '全部', count: stageCount('all'), color: 'var(--mist-ink-2)' },
      { value: 'draft', label: '需求草稿', count: stageCount('draft'), color: 'var(--mist-ink-3)' },
      { value: 'pending', label: '待审批', count: stageCount('pending'), color: 'var(--mist-warn)' },
      { value: 'supplier', label: '待供应商确认', count: stageCount('supplier'), color: 'var(--mist-accent)' },
      { value: 'fulfilling', label: entry === 'processing' ? '加工 / 回交中' : '供应履约中', count: stageCount('fulfilling'), color: 'var(--mist-accent)' },
      { value: 'done', label: '已完成', count: stageCount('done'), color: 'var(--mist-ok)' },
    ]} />
    <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)} drawerTitle={selected ? `${selected.code} · ${selected.description}` : '单据详情'} drawerSub={selected?.supplier}
      list={<Card><DataTable ariaLabel={`${ENTRY_LABEL[entry]}列表`} loading={loading} rows={rows} rowKey={p => p.id} selectedKey={selected?.id} density="comfy" onRowClick={pick} columns={columns} empty={empty} /></Card>}
      detail={detail} />
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage>;
}

function PurchaseDetail({ purchase: p, state, day, me, can, canApprove, locked, onEdit, onSubmit, onDecide, onSend, onConfirm, onReceive, onDownload, onAttach, onInventory, onSupplier }: {
  purchase: FulfillmentPurchase; state: MistState; day: string; me: string; can: boolean; canApprove: boolean; locked: boolean;
  onEdit: () => void; onSubmit: () => void; onDecide: (decision: 'approved' | 'rejected') => void; onSend: () => void; onConfirm: () => void; onReceive: () => void; onDownload: () => void;
  onAttach: (ids: string[]) => Promise<unknown>; onInventory: () => void; onSupplier: () => void;
}) {
  const stage = purchaseStage(p), flags = purchaseFlags(p, day), processing = p.kind === 'processing';
  const receipts = state.fulfillment.receipts.filter(receipt => receipt.purchaseId === p.id);
  const prepay = purchasePrepaymentReadback(state, p.id);
  const billed = purchasePayableReadback(state, p.id, day).filter(r => r.bill.status !== 'void'), invoicedMinor = billed.reduce((n, r) => n + Math.round(r.lineAmount * 100), 0);
  const rejectedQty = round(receipts.reduce((sum, receipt) => sum + receipt.rejected, 0));
  const writeReason = can ? false : '需要采购写权限';
  const reviewerReason = !canApprove ? '需要供应商承诺审批权限' : !p.reviewerIds.includes(me) ? '你不在本单提交时的审批名单中' : false;
  const next: { tone: Tone; title: string; text: string } = p.state === 'rejected' ? { tone: 'bad', title: '审批退回', text: `${p.decision?.actor || '审批人'}：${p.decision?.note || '未写明原因'}。修订草稿后重新提交。` }
    : stage === 'draft' ? { tone: 'neutral', title: '草稿 · 未形成对外承诺', text: '核对来源、供应商、数量与交付约定后提交审批。' }
    : stage === 'pending' ? { tone: 'warn', title: '等待审批', text: `已提交 ${p.submittedAt ? shortWhen(p.submittedAt) : ''}，审批名单 ${p.reviewerIds.length} 人；批准前不能发给供应商。` }
    : !p.offlineSend ? { tone: 'accent', title: '已批准 · 待线下发出', text: `${p.decision?.actor || '审批人'}已批准。把批准版本发给供应商后，在此登记发出方式与依据。` }
    : !p.supplierConfirmation ? { tone: 'accent', title: '合同已发出 · 待供应商确认', text: '收到对方盖章确认后登记；确认交期须与批准交期一致，不同需先走商业变更。' }
    : stage === 'done' ? { tone: 'ok', title: processing ? '已全部回交' : '已全部交付', text: `累计 ${p.received} / ${p.quantity} ${p.unit}。验收尚未接入；供应商票据与付款由财务在应付待办登记。` }
    : { tone: 'accent', title: processing ? '加工中 · 分批回交' : '供应履约中', text: `供应商承诺 ${p.supplierConfirmation.confirmedDue}；已${processing ? '回交' : '交付'} ${p.received} / ${p.quantity} ${p.unit}。` };
  const track = [
    { label: '提交审批', done: !!p.submittedAt || stage !== 'draft', note: p.submittedAt ? shortWhen(p.submittedAt) : '未提交' },
    { label: '审批', done: p.state === 'approved', note: p.decision ? `${p.decision.actor} · ${p.decision.decision === 'approved' ? '批准' : '退回'} · ${shortWhen(p.decision.at)}` : '待审批', noteTone: p.state === 'rejected' ? 'bad' as const : undefined },
    { label: '合同线下发出', done: !!p.offlineSend, note: p.offlineSend ? `${p.offlineSend.actor} · ${shortWhen(p.offlineSend.at)}` : '未登记' },
    { label: '供应商确认', done: !!p.supplierConfirmation, note: p.supplierConfirmation ? `承诺 ${p.supplierConfirmation.confirmedDue}` : '未登记' },
    ...(processing ? [{ label: '原料交接', done: false, note: '发料、损耗与余料归还尚未接入' }] : []),
    { label: processing ? '分批回交' : '分批交付', done: stage === 'done', note: `${p.received} / ${p.quantity} ${p.unit}` },
    { label: '验收', done: false, note: rejectedQty ? `已拒收 ${rejectedQty} ${p.unit} · 退换尚未接入` : '独立验收尚未接入', noteTone: rejectedQty ? 'bad' as const : undefined },
    ...(prepay.plans.length ? [{ label: '合同预付款', done: prepay.paid >= prepay.planned, note: `计划 ${prepay.planned.toFixed(2)} · 已付 ${prepay.paid.toFixed(2)} ${p.currency}${prepay.paid > 0 ? '（待结算抵扣）' : ''}` }] : []),
    { label: '财务登记供应商票据与付款', done: billed.length > 0 && invoicedMinor >= purchaseContractMinor(p) && billed.every(r => r.bill.open <= 0), note: billed.length ? `已登记票据 ${(invoicedMinor / 100).toFixed(2)} / 合同 ${(purchaseContractMinor(p) / 100).toFixed(2)} ${p.currency} · ${billed.filter(r => r.bill.open > 0).length ? billed.filter(r => r.bill.open > 0).length + ' 张未付清' : '已付清'}` : '财务尚未登记供应商票据' },
  ];
  return <DetailBody data-purchase-detail={p.id} heading={<div>
      <span className="mist-mono mist-muted">{p.code}</span>
      <div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{p.description}</div>
    </div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={p.state === 'rejected' ? 'bad' : STAGE_TONE[stage]}>{p.state === 'rejected' ? '已退回' : STAGE_LABEL[stage]}</Pill><Pill>{KIND_LABEL[p.kind]}</Pill><Pill>{p.domain === 'fabric' ? '面料业务' : '成衣业务'}</Pill>{flags.filter(flag => flag.key !== 'returned').map(flag => <Pill key={flag.key} tone="bad">{flag.label}</Pill>)}</div>
    <Banner tone={next.tone} title={next.title}>{next.text}</Banner>
    <ActionBar busy={locked} actions={[
      { label: '编辑草稿', icon: Pencil, onClick: onEdit, reason: writeReason, hidden: stage !== 'draft' },
      { label: '提交审批', icon: Send, onClick: onSubmit, primary: true, reason: writeReason || (p.state === 'rejected' ? '退回的单据请先修订草稿再提交' : false), hidden: stage !== 'draft' },
      { label: '批准承诺', icon: CheckCircle2, onClick: () => onDecide('approved'), primary: true, reason: reviewerReason, hidden: stage !== 'pending' },
      { label: '退回修改', icon: Undo2, onClick: () => onDecide('rejected'), reason: reviewerReason, hidden: stage !== 'pending' },
      { label: '登记合同线下发出', icon: Send, onClick: onSend, primary: !p.offlineSend, reason: writeReason, hidden: p.state !== 'approved' || !!p.offlineSend },
      { label: '登记供应商确认', icon: FileSignature, onClick: onConfirm, primary: true, reason: writeReason, hidden: p.state !== 'approved' || !p.offlineSend || !!p.supplierConfirmation },
      { label: processing ? '登记加工回交' : '登记本次交付', icon: PackageCheck, onClick: onReceive, primary: !!p.supplierConfirmation && stage !== 'done', reason: writeReason || (!p.offlineSend || !p.supplierConfirmation ? '请先登记合同线下发出和供应商确认' : false), hidden: p.state !== 'approved' },
      { label: '下载批准单据', icon: Download, onClick: onDownload, hidden: p.state !== 'approved' },
    ]} />
    <Facts items={[
      { label: '来源条目', value: <SourceLink source={{ kind: 'orderLine', orderId: p.orderId, lineId: p.lineId }} /> },
      { label: '供应商', value: p.supplier },
      { label: '数量 × 单价', value: `${p.quantity} ${p.unit} × ${p.price} ${p.currency}` },
      { label: '付款条件', value: p.terms || '未填' },
      { label: '交付地点', value: p.destination || '未填' },
      { label: '要求交期', value: <span className={flags.some(flag => flag.key === 'overdue') ? 'mist-tone-bad' : undefined}>{p.due || '未填'}</span> },
      { label: '供应商承诺日', value: p.supplierConfirmation?.confirmedDue || '未确认' },
      { label: processing ? '累计回交' : '累计交付', value: `${p.received} / ${p.quantity} ${p.unit}${p.received > p.quantity ? ' · 超出待处理' : p.received < p.quantity && p.received > 0 ? ` · 尚差 ${round(p.quantity - p.received)}` : ''}` },
    ]} />
    {p.note && <p className="mist-sub">{p.note}</p>}
    <DetailBlock title="阶段轨迹"><Checklist items={track} /></DetailBlock>
    <DetailBlock title={processing ? '回交记录' : '交付记录'}>
      {receipts.length ? <DataTable ariaLabel={`${p.code} 交付记录`} rows={receipts} rowKey={receipt => receipt.id} columns={[
        { key: 'date', header: '日期', render: receipt => receipt.date },
        { key: 'qty', header: '实收 / 拒收', align: 'right', render: receipt => `${receipt.quantity} / ${receipt.rejected} ${p.unit}` },
        { key: 'loc', header: '实际地点', hideOnMobile: true, render: receipt => `${receipt.destination === 'warehouse' ? '入库' : processing ? '加工交付' : '直送加工方'} · ${receipt.location}` },
        { key: 'evidence', header: '依据', hideOnMobile: true, render: receipt => receipt.evidence },
      ]} /> : <span className="mist-note">还没有{processing ? '回交' : '交付'}记录</span>}
    </DetailBlock>
    <div className="mist-row mist-module-actions"><Button onClick={onInventory}>查看来源库存</Button><Button onClick={onSupplier}>供应商档案</Button></div>
    <DetailBlock title="附件">
      <RecordFiles key={p.id} ids={p.fileIds} onAttach={can && stage === 'draft' ? onAttach : undefined} />
      {!p.fileIds.length && stage !== 'draft' && <span className="mist-note">提交后附件随版本冻结</span>}
    </DetailBlock>
    {!!p.revisionHistory?.length && <DetailBlock title="承诺与审批版本">
      <Timeline events={p.revisionHistory.slice().reverse().map(revision => ({ who: revision.decision?.actor || p.createdBy, when: new Date(revision.decision?.at || revision.submittedAt).toLocaleString(), text: <><div>第 {revision.revision} 版 · {revision.decision ? status[revision.decision.decision] : '待审批'}</div><div>{revision.snapshot.supplier} · {revision.snapshot.description} · {revision.snapshot.quantity} {revision.snapshot.unit} × {revision.snapshot.price} {revision.snapshot.currency}</div><div>{revision.snapshot.terms} · {revision.snapshot.destination} · {revision.snapshot.due}</div>{revision.decision && <div>{revision.decision.note}</div>}<RecordFiles ids={revision.snapshot.fileIds} /></> }))} />
    </DetailBlock>}
    <DetailBlock title="处理记录"><Events entity="procurement" id={p.id} /></DetailBlock>
  </DetailBody>;
}

export function downloadApprovedPurchase(root: MistState, p: FulfillmentPurchase) {
  if (p.state !== 'approved' || !p.decision) throw new Error('当前采购尚未批准');
  const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const values = [['单据编号', p.code], ['供应商', p.supplier], ['来源订单', fulfillmentSourceLabel(root, { kind: 'orderLine', orderId: p.orderId, lineId: p.lineId })], ['内容 / 规格', p.description], ['数量', `${p.quantity} ${p.unit}`], ['单价', `${p.price} ${p.currency}`], ['约定交期', p.due], ['付款条件', p.terms], ['交付地点', p.destination], ['批准人', p.decision.actor], ['批准时间', p.decision.at], ['批准意见', p.decision.note], ['备注', p.note]];
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>' + escape(p.code) + '</title><body><h1>' + (p.kind === 'processing' ? '委托加工确认单' : '采购单') + '</h1><dl>' + values.map(([label, value]) => '<dt>' + escape(label) + '</dt><dd>' + escape(value) + '</dd>').join('') + '</dl></body></html>';
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })), a = document.createElement('a');
  a.href = url; a.download = p.code + '.html'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
