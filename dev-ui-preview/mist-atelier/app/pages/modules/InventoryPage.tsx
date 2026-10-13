/** 库存与仓储：面料 / 成衣业务组各自的实物台账；按单位分开汇总，详情为“事实 → 可做的动作 → 流水”。 */
import React from 'react';
import { ArrowRightLeft, Boxes, Download, Layers, PackageMinus, Plus, SearchX, Shirt, Trash2, Undo2, Warehouse } from 'lucide-react';
import { Banner, Button, Card, CardButton, DataTable, Dropdown, EmptyState, Facts, KeyValue, MistPage, Mono, PageHeader, Pill, Pipeline, SearchField, Select, TextLink, Tile, Timeline, Toolbar, type Column, type Tone } from '../../../../../components/mist';
import type { MistState } from '../../../../../server/src/shared/mistWorkspace';
import type { FulfillmentStock } from '../../../../../server/src/shared/mistFulfillment';
import { fulfillmentPositions, fulfillmentSourceLabel, stockIssueRemaining } from '../../../../../server/src/shared/mistFulfillment';
import type { ClaimInventoryWarehouse } from '../../../../../server/src/shared/mistClaimInventory';
import { View } from '../../../../../types';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { Nav, useNav } from '../../nav';
import { ModuleEditorDialog, ModuleWorkbench, type ModuleEditorSpec } from './ModuleWorkbench';
import { emptyOption, exportRecords, field, number, PositionSummary, RecordFiles, SourceLink, text, today, useEditor } from './fulfillmentKit';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen } from './pageKit';

type Domain = 'fabric' | 'garment';
type StateFilter = 'all' | 'available' | 'isolated' | 'cleared';
type SourceFilter = 'all' | 'purchase' | 'claimReturn';
const DOMAIN_LABEL: Record<Domain, string> = { fabric: '面料库存', garment: '成衣库存' };
const MOVE_LABEL: Record<string, string> = { receive: '实际入库', issue: '出库', return: '按原出库退回', move: '移位', lock: '隔离锁定', unlock: '批准解锁', scrap: '报废出库' };
const round = (value: number) => Math.round(value * 10000) / 10000;
const isReturn = (stock: FulfillmentStock) => stock.sourceKind === 'claimReturn';

/** Net quantity issued from this batch (issues minus returns recorded against them). */
export function stockOutstanding(root: MistState, stock: FulfillmentStock) {
  return round(root.fulfillment.stockMovements.filter(movement => movement.stockId === stock.id && movement.kind === 'issue').reduce((sum, movement) => sum + stockIssueRemaining(root, movement.id), 0));
}
/** Quality / availability state from recorded quantities only. */
export function stockState(root: MistState, stock: FulfillmentStock): Exclude<StateFilter, 'all'> {
  if ((stock.locked || 0) > 0) return 'isolated';
  return stock.available > 0 ? 'available' : 'cleared';
}
const STATE_LABEL: Record<Exclude<StateFilter, 'all'>, string> = { available: '可用', isolated: '隔离待处置', cleared: '已全部出库' };
const STATE_PILL: Record<Exclude<StateFilter, 'all'>, string> = { available: '可用', isolated: '隔离中', cleared: '已出库' };
const STATE_TONE: Record<Exclude<StateFilter, 'all'>, Tone> = { available: 'ok', isolated: 'warn', cleared: 'neutral' };
const domainOf = (root: MistState, stock: FulfillmentStock): Domain | undefined => root.orders.find(order => order.id === stock.orderId)?.type as Domain | undefined || root.fulfillment.purchases.find(purchase => purchase.id === stock.purchaseId)?.domain;
/** Per-unit totals; different units are never added together. */
function byUnit(rows: FulfillmentStock[], value: (stock: FulfillmentStock) => number) {
  const totals = new Map<string, number>();
  for (const stock of rows) { const amount = value(stock); if (amount > 0) totals.set(stock.unit, round((totals.get(stock.unit) || 0) + amount)); }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}
function UnitLines({ totals, tone }: { totals: Array<[string, number]>; tone?: Tone }) {
  if (!totals.length) return <b>0</b>;
  return <b className={`mist-unit-lines${tone ? ` mist-tone-${tone}` : ''}`}>{totals.slice(0, 2).map(([unit, amount]) => <span key={unit}>{amount}<small>{unit}</small></span>)}{totals.length > 2 && <small>另 {totals.length - 2} 种单位</small>}</b>;
}

export function InventoryPage() {
  const { state, run, error, refresh, loading, saving, pending } = useMistWorkspace(), session = useMistSession(), editor = useEditor(), nav = useNav(), { route, go } = nav;
  const f = state?.fulfillment, hasClaim = route.section?.startsWith('claim:') === true, claimId = hasClaim ? route.section!.slice(6) : undefined;
  const claim = state?.platform.claims.find(row => row.id === claimId), receipt = f?.returnReceipts?.find(row => row.id === route.id), incomingStock = f?.stock.find(row => row.id === route.id);
  const invalidSource = hasClaim && !!state && (!claim || !!route.id && !receipt && !incomingStock || !!receipt && receipt.claimId !== claim?.id || !!incomingStock && incomingStock.claimId !== claim?.id);
  const [warehouseFilter, setWarehouseFilter] = React.useState(''); React.useEffect(() => { setWarehouseFilter(''); }, [route.section, session.sessionKey]);
  const [domainChoice, setDomainChoice] = React.useState<Domain | null>(null), [stateFilter, setStateFilter] = React.useState<StateFilter>('all'), [sourceFilter, setSourceFilter] = React.useState<SourceFilter>('all'), [query, setQuery] = React.useState('');
  const [picked, setPicked] = React.useState<string | null>(incomingStock ? incomingStock.id : null), [drawer, setDrawer] = React.useState(!!incomingStock);
  React.useEffect(() => { if (incomingStock) { setPicked(incomingStock.id); setDomainChoice(null); } }, [incomingStock?.id]);
  const can = session.hasPermission('inventory:write'), [catalog, setCatalog] = useRouteDraft(false), [catalogId, setCatalogId] = useRouteDraft<string | undefined>(undefined), [selectedGoods, setSelectedGoods] = useRouteDraft('');
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null);
  const claimGoods = (state?.platform.claimGoods || []).filter(goods => goods.source && goods.returnReceiptId && (!hasClaim || goods.claimId === claim?.id) && (!receipt || goods.returnReceiptId === receipt.id));
  const sourceGoods = claimGoods.find(goods => goods.id === selectedGoods), terminal = !!claim && ['Closed', 'Cancelled'].includes(claim.state);
  const scoped = invalidSource ? [] : (f?.stock || []).filter(stock => { if (!route.section) return true; if (hasClaim) return !!claim && stock.claimId === claim.id && (!receipt || stock.returnReceiptId === receipt.id); return stock.purchaseId === route.section; });
  const sourceMode = !!route.section;
  const routedDomain = state && incomingStock ? domainOf(state, incomingStock) : undefined;
  const domain: Domain = domainChoice || routedDomain || (!state || scoped.some(stock => domainOf(state, stock) === 'garment') || !scoped.some(stock => domainOf(state, stock) === 'fabric') ? 'garment' : 'fabric');
  const domainRows = sourceMode || !state ? scoped : scoped.filter(stock => { const value = domainOf(state, stock); return !value || value === domain; });
  const needle = query.trim().toLowerCase();
  const purchaseOf = (stock: FulfillmentStock) => f?.purchases.find(purchase => purchase.id === stock.purchaseId);
  const returnCode = (stock: FulfillmentStock) => f?.returnReceipts.find(rt => rt.id === stock.returnReceiptId)?.code;
  const warehouseName = (id?: string) => id ? f?.warehouses.find(row => row.id === id)?.name || '仓库不可用' : '';
  const searched = domainRows.filter(stock => (!warehouseFilter || stock.warehouseId === warehouseFilter) && (sourceFilter === 'all' || (sourceFilter === 'claimReturn') === isReturn(stock))
    && (!needle || `${stock.name} ${stock.batchNumber || ''} ${stock.location} ${stock.owner} ${fulfillmentPositions(stock).map(position => position.location).join(' ')} ${purchaseOf(stock)?.code || ''} ${purchaseOf(stock)?.supplier || ''} ${returnCode(stock) || ''} ${warehouseName(stock.warehouseId)}`.toLowerCase().includes(needle)));
  const priority: Record<Exclude<StateFilter, 'all'>, number> = { isolated: 0, available: 1, cleared: 2 };
  const rows = !state ? [] : searched.filter(stock => stateFilter === 'all' || stockState(state, stock) === stateFilter)
    .sort((a, b) => priority[stockState(state, a)] - priority[stockState(state, b)] || b.createdAt.localeCompare(a.createdAt));
  const selected = rows.find(stock => stock.id === picked) || (picked ? scoped.find(stock => stock.id === picked) : undefined);
  const locked = saving || !!pending;

  const warehouseSpec = (row?: ClaimInventoryWarehouse): ModuleEditorSpec => ({ title: row ? '更新真实仓库' : '登记真实仓库', fields: [field('code', '仓库代码'), field('name', '仓库名称'), field('address', '实际仓库地址'), field('active', '当前启用', 'checkbox', false)], initialValues: { code: row?.code || '', name: row?.name || '', address: row?.address || '', active: row?.active ?? true }, submit: v => run({ type: 'fulfillment.claimInventory.warehouse.save', payload: { ...(row ? { id: row.id } : {}), code: text(v, 'code'), name: text(v, 'name'), address: text(v, 'address'), active: !!v.active } }) });
  const receive = () => {
    if (!sourceGoods?.source || !state) return; const goods = sourceGoods, source = goods.source!, rt = f!.returnReceipts.find(row => row.id === goods.returnReceiptId)!;
    editor.open({ title: '登记本批真实退货收货', fields: [{ ...field('warehouseId', '正式退货单仓库', 'select', true, (f?.warehouses || []).map(row => ({ value: row.id, label: row.code + ' · ' + row.name }))), readonly: true }, field('quantity', `本次实收数量（${source.unit}）`, 'number'), field('location', '实际仓内位置'), field('batchNumber', '真实退回批号'), field('ownership', '实际货权', 'select', true, [emptyOption, { value: 'Owned', label: '我方货权' }, { value: 'Transferred', label: '来源客户货权' }]), field('ownershipDate', '货权确认日期', 'date'), { ...field('ownershipEvidence', '货权确认依据', 'textarea'), hint: '按实际权利义务确认，不因退货或退款自动改变货权。' }, field('receivedAt', '实际收货日期', 'date'), { ...field('basis', '实际点数与交接依据', 'textarea'), hint: `${source.style} · 批准 ${source.quantity}${source.unit}，已收 ${goods.receivedQuantity || 0}${source.unit}` }, field('fileId', '实际收货凭据', 'select', false, [emptyOption, ...state.files.map(file => ({ value: file.id, label: file.name }))])], initialValues: { warehouseId: rt.warehouseId, quantity: 0, location: '', batchNumber: '', ownership: '', ownershipDate: today(), ownershipEvidence: '', receivedAt: today(), basis: '', fileId: '' }, submit: v => run({ type: 'fulfillment.claimInventory.receive', payload: { goodsId: goods.id, quantity: number(v, 'quantity'), unit: source.unit, warehouseId: rt.warehouseId, location: text(v, 'location'), batchNumber: text(v, 'batchNumber'), ownership: text(v, 'ownership') as 'Owned' | 'Transferred', ownershipDate: text(v, 'ownershipDate'), ownershipEvidence: text(v, 'ownershipEvidence'), receivedAt: text(v, 'receivedAt'), basis: text(v, 'basis'), fileIds: text(v, 'fileId') ? [text(v, 'fileId')] : [] } }) });
  };
  const scrapSpec = (stock: FulfillmentStock): ModuleEditorSpec | null => { const record = f?.receivedRecords.find(row => row.stockId === stock.id); if (!record) return null; return { title: '登记本批批准报废', fields: [{ ...field('batch', '准确收货批次'), readonly: true }, field('basis', '批准报废执行依据', 'textarea')], initialValues: { batch: stock.batchNumber + ' · ' + record.quantity + ' ' + record.unit, basis: '' }, submit: v => run({ type: 'fulfillment.claimInventory.scrap', payload: { goodsId: record.goodsId, receivedEventId: record.id, basis: text(v, 'basis'), fileIds: [] } }) }; };
  const moveSpec = (stock: FulfillmentStock, kind: 'issue' | 'return' | 'move'): ModuleEditorSpec => ({ title: ({ issue: '登记实际出库', return: '按原出库退回', move: '登记库存移位' })[kind], submitLabel: ({ issue: '登记出库', return: '登记退回', move: '登记移位' })[kind], fields: [...(kind !== 'return' && fulfillmentPositions(stock).length > 1 ? [field('sourceLocation', kind === 'move' ? '移出位置' : '本次出库位置', 'select', true, [{ value: '__choose__', label: '请选择位置' }, ...fulfillmentPositions(stock).map(position => ({ value: position.location, label: `${position.location || '位置未记录'} · ${position.available}${stock.unit}` }))])] : []), ...(kind === 'return' ? [field('issueId', '原出库', 'select', true, [emptyOption, ...(f?.stockMovements || []).filter(movement => movement.stockId === stock.id && movement.kind === 'issue' && stockIssueRemaining(state!, movement.id) > 0).map(movement => ({ value: movement.id, label: `${movement.person} · 可退回 ${stockIssueRemaining(state!, movement.id)}${stock.unit} · ${movement.location}` }))])] : []), ...(kind !== 'move' ? [{ ...field('quantity', `数量（${stock.unit}）`, 'number'), hint: kind === 'issue' ? `当前可用 ${stock.available} ${stock.unit}` : undefined }] : []), field('location', kind === 'move' ? '移入位置' : '实际交接地点'), field('person', kind === 'issue' ? '接收方（工厂 / 出运 / 人员）' : '接收 / 交付方'), field('note', '交接依据', 'textarea')], initialValues: { quantity: kind === 'return' ? 0 : stock.available, location: kind === 'return' || stock.location === '多个位置' ? '' : stock.location, person: '', note: '', issueId: '', sourceLocation: '__choose__' }, submit: v => run({ type: 'fulfillment.inventory.move', payload: { id: stock.id, kind, quantity: kind === 'move' ? 0 : number(v, 'quantity'), location: text(v, 'location'), person: text(v, 'person'), note: text(v, 'note'), ...(text(v, 'issueId') ? { issueId: text(v, 'issueId') } : {}), ...(text(v, 'sourceLocation') !== '__choose__' ? { sourceLocation: text(v, 'sourceLocation') } : {}) } }) });
  if (editor.spec) return editor.view;
  const back = <>{hasClaim && claim && session.canAccessView(View.Claims) && <Button onClick={() => go('claims', claim.id)}>返回来源案件</Button>}{hasClaim && <Button onClick={() => go('inventory')}>查看全部库存</Button>}{!hasClaim && route.section && <Button onClick={() => go('procurement', route.section)}>返回来源采购</Button>}</>;
  if (catalog) return <Nav.Provider value={{ ...nav, route: { ...route, id: catalogId }, go: (view, id, target) => { if (view === 'inventory') setCatalogId(id); else go(view, id, target); } }}><ModuleWorkbench title="仓库目录" description="登记真实仓库；启用目录供批准退货单准确选择，不产生实物库存。" rows={f?.warehouses || []} columns={[{ key: 'code', header: '仓库', render: row => <><Mono>{row.code}</Mono><div>{row.name}</div></> }, { key: 'address', header: '实际地址', render: row => row.address }, { key: 'active', header: '状态', render: row => <Pill tone={row.active ? 'ok' : 'neutral'}>{row.active ? '启用' : '停用'}</Pill> }]} create={can ? warehouseSpec() : undefined} edit={can ? row => warehouseSpec(row) : undefined} detail={row => <KeyValue items={[{ label: '仓库代码', value: row.code }, { label: '仓库名称', value: row.name }, { label: '实际地址', value: row.address }, { label: '当前状态', value: row.active ? '启用' : '停用' }]} />} toolbar={<>{back}<Button onClick={() => { setCatalog(false); setCatalogId(undefined); }}>返回库存台账</Button></>} /></Nav.Provider>;
  const receivingBlocked = !sourceGoods || terminal || invalidSource || (sourceGoods.receivedQuantity || 0) >= sourceGoods.quantity || !f?.warehouses.some(row => row.id === f.returnReceipts.find(rt => rt.id === sourceGoods.returnReceiptId)?.warehouseId && row.active);
  const receivingReason = !sourceGoods ? '请先选择准确退回履行条目' : terminal ? '来源案件已结束' : (sourceGoods.receivedQuantity || 0) >= sourceGoods.quantity ? '本条目已全部收货' : receivingBlocked ? '退货单仓库未启用' : '';

  const pick = (stock: FulfillmentStock) => { setPicked(stock.id); setDrawer(true); };
  const changeDomain = (value: Domain) => { setDomainChoice(value); setStateFilter('all'); setPicked(null); };
  const stateCount = (value: StateFilter) => !state ? 0 : value === 'all' ? searched.length : searched.filter(stock => stockState(state, stock) === value).length;
  const metrics = (value: Domain) => { const list = !state ? [] : scoped.filter(stock => domainOf(state, stock) === value); return { count: list.length, available: byUnit(list, stock => stock.available), isolated: byUnit(list, stock => stock.locked || 0), out: byUnit(list, stock => state ? stockOutstanding(state, stock) : 0) }; };
  const columns: Column<FulfillmentStock>[] = [
    { key: 'name', header: '物料 / 产品 · 来源批次', width: 'minmax(170px,1.6fr)', render: stock => <div className="mist-col" style={{ gap: 2 }}><span>{stock.name}</span><small className="mist-muted">{isReturn(stock) ? `${returnCode(stock) || '退货单不可用'} · ${stock.batchNumber}` : `${purchaseOf(stock)?.code || '来源采购不可用'}${stock.batchNumber ? ` · ${stock.batchNumber}` : ''}`}</small></div> },
    { key: 'source', header: '订单条目', width: 'minmax(120px,1fr)', hideOnMobile: true, render: stock => <SourceLink source={{ kind: 'orderLine', orderId: stock.orderId, lineId: stock.lineId }} /> },
    { key: 'location', header: '位置 / 货权', width: 'minmax(120px,1fr)', hideOnMobile: true, render: stock => { const positions = fulfillmentPositions(stock); return <div className="mist-col" style={{ gap: 2 }}><span>{stock.warehouseId ? `${warehouseName(stock.warehouseId)} · ` : ''}{positions.length > 1 ? `${positions.length} 个位置` : stock.location || '位置未记录'}</span><small className="mist-muted">{stock.owner}</small></div>; } },
    { key: 'quantity', header: '数量', width: '188px', align: 'right', render: stock => { const out = state ? stockOutstanding(state, stock) : 0; return <div className="mist-col" style={{ gap: 2, alignItems: 'flex-end' }}><span className="mist-num" style={{ whiteSpace: 'nowrap' }}>{isReturn(stock) ? `可用 ${stock.available} / 现存 ${stock.onHand} / 隔离 ${stock.locked} ${stock.unit}` : `可用 ${stock.available} / 累计入库 ${stock.quantity} ${stock.unit}`}</span>{out > 0 && <small className="mist-muted">已出库 {out} {stock.unit}</small>}</div>; } },
    { key: 'state', header: '状态', width: '80px', render: stock => state ? <Pill tone={STATE_TONE[stockState(state, stock)]}>{STATE_PILL[stockState(state, stock)]}</Pill> : null },
  ];
  const exportRows = () => exportRecords('库存来源台账', ['名称', '来源', '批号', '订单条目', '累计入库', '物理现存', '隔离', '可用', '已出库（净）', '单位', '仓库', '位置', '货权'], rows.map(stock => [stock.name, isReturn(stock) ? returnCode(stock) : purchaseOf(stock)?.code || stock.receiptId, stock.batchNumber || '', fulfillmentSourceLabel(state!, { kind: 'orderLine', orderId: stock.orderId, lineId: stock.lineId }), stock.quantity, stock.onHand ?? '', stock.locked ?? '', stock.available, stockOutstanding(state!, stock), stock.unit, warehouseName(stock.warehouseId), stock.location, stock.owner]));
  const filtersOn = !!needle || stateFilter !== 'all' || sourceFilter !== 'all' || !!warehouseFilter;
  const empty = filtersOn && domainRows.length
    ? <EmptyState icon={SearchX} title="没有符合条件的库存" description="换个关键词或清除筛选。" action={<Button onClick={() => { setQuery(''); setStateFilter('all'); setSourceFilter('all'); setWarehouseFilter(''); }}>清除筛选</Button>} />
    : <EmptyState icon={Boxes} title={invalidSource ? '来源不匹配' : sourceMode ? '本来源还没有入库批次' : `还没有${DOMAIN_LABEL[domain]}`} description={invalidSource ? '请返回来源案件重新选择准确退货单。' : '库存只来自真实的采购交付入库（在采购单上登记“入我方仓库”）和批准的退货入库，不能在这里手工新增。'} action={!sourceMode && session.canAccessView(View.Procurement) ? <Button onClick={() => go('procurement')}>前往采购管理</Button> : undefined} />;
  const detail = selected && state
    ? <StockDetail stock={selected} state={state} can={can} locked={locked}
        onMove={kind => setDialog(moveSpec(selected, kind))} onScrap={() => setDialog(scrapSpec(selected))}
        onPurchase={id => go('procurement', id)} onClaim={(id, section) => section ? go('claims', id, { section }) : go('claims', id)} canClaims={session.canAccessView(View.Claims)} />
    : <EmptyState icon={Boxes} title="库存详情" description={loading ? '正在读取库存' : '从列表选择一个批次，查看来源、位置余额与出入库流水'} compact />;

  return <Nav.Provider value={{ ...nav, route: { ...route, id: receipt || invalidSource ? undefined : route.id } }}><MistPage width="wide">
    <PageHeader eyebrow="订单履约 · 库存" title="库存与仓储"
      description={hasClaim ? invalidSource ? '来源案件或退货单不匹配，请重新选择。' : `${claim?.code || ''} · 真实退货批次先入库并隔离；各批按批准去向处置。` : route.section ? `${f?.purchases.find(purchase => purchase.id === route.section)?.code || '来源采购'} · 只显示本采购交付入库的批次。` : '库存只来自真实采购交付与批准退回；保留原单位、货权与每一次实际出入库。'}
      actions={<>{back}<Button icon={Download} disabled={!rows.length} onClick={exportRows}>导出</Button><Button icon={Warehouse} onClick={() => setCatalog(true)}>仓库目录</Button>{can && <Button variant="primary" icon={Plus} disabled={locked} onClick={() => editor.open(warehouseSpec())}>登记真实仓库</Button>}</>} />
    {!can && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有库存写权限，可以查看批次、位置与流水；出入库由实际经手的业务组成员登记。</Banner></div>}
    {error && <div className="mist-section"><Banner tone="bad" title="库存读取未完成" actions={<Button onClick={() => void refresh()}>重试</Button>}>{error}</Banner></div>}
    {hasClaim && !f?.warehouses.length && <div className="mist-section"><Banner tone="warn" title="尚无真实仓库">请先登记，再返回案件选择退货仓库。</Banner></div>}
    {hasClaim && !invalidSource && <div className="mist-section"><Card><div className="mist-card-body mist-col">
      <div className="mist-row" style={{ flexWrap: 'wrap' }}><span className="mist-eyebrow">退货收货 · {claim?.code}</span><span className="mist-spacer" /><span className="mist-note">逐条选择准确退回履行条目，按实际点数登记；收货后自动隔离。</span></div>
      <div className="mist-row" style={{ flexWrap: 'wrap' }}>
        <Select aria-label="准确退回履行条目" value={selectedGoods} onChange={event => setSelectedGoods(event.target.value)} options={[emptyOption, ...claimGoods.map(goods => ({ value: goods.id, label: `${f?.returnReceipts.find(rt => rt.id === goods.returnReceiptId)?.code || '退货单不可用'} · ${goods.source!.style} · 批准${goods.quantity}${goods.unit} / 已收${goods.receivedQuantity || 0}${goods.unit}` }))]} />
        {can && <Button variant="primary" icon={PackageMinus} disabled={receivingBlocked} title={receivingReason || undefined} onClick={receive}>登记本批真实收货</Button>}
      </div>
      {can && receivingBlocked && receivingReason && <span className="mist-note">登记本批真实收货：{receivingReason}</span>}
    </div></Card></div>}
    {!sourceMode && <div className="mist-domains" role="tablist" aria-label="库存业务板块">
      {(['fabric', 'garment'] as const).map(value => { const m = metrics(value); return <CardButton key={value} role="tab" aria-selected={domain === value} className="mist-domain" onClick={() => changeDomain(value)}>
        <span className="mist-domain-h"><Tile icon={value === 'fabric' ? Layers : Shirt} tone={domain === value ? 'accent' : undefined} /><b>{DOMAIN_LABEL[value]}</b><span className="mist-spacer" /><span className="mist-note">{m.count} 个批次 · 按单位分开</span></span>
        <span className="mist-domain-nums">
          <span><small>可用</small><UnitLines totals={m.available} /></span>
          <span><small>隔离待处置</small><UnitLines totals={m.isolated} tone={m.isolated.length ? 'warn' : undefined} /></span>
          <span><small>已出库</small><UnitLines totals={m.out} /></span>
        </span>
      </CardButton>; })}
    </div>}
    <Toolbar right={<span className="mist-note">预留、在途与盘点尚未接入</span>}>
      <SearchField value={query} onChange={setQuery} placeholder="搜索名称、批号、位置、采购单或退货单" />
      <Select aria-label="仓库筛选" value={warehouseFilter} onChange={event => setWarehouseFilter(event.target.value)} options={[{ value: '', label: '全部仓库' }, ...(f?.warehouses || []).map(row => ({ value: row.id, label: row.code + ' · ' + row.name + (row.active ? '' : '（停用）') }))]} />
      <Dropdown<SourceFilter> label="来源" value={sourceFilter} onChange={setSourceFilter} options={[{ value: 'all', label: '全部' }, { value: 'purchase', label: '采购交付入库' }, { value: 'claimReturn', label: '批准退货入库' }]} />
    </Toolbar>
    <Pipeline<StateFilter> value={stateFilter} onChange={setStateFilter} items={[
      { value: 'all', label: '全部批次', count: stateCount('all'), color: 'var(--mist-ink-2)' },
      { value: 'available', label: '可用', count: stateCount('available'), color: 'var(--mist-ok)' },
      { value: 'isolated', label: '隔离待处置', count: stateCount('isolated'), color: 'var(--mist-warn)' },
      { value: 'cleared', label: '已全部出库', count: stateCount('cleared'), color: 'var(--mist-ink-3)' },
    ]} />
    <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)} drawerTitle={selected?.name || '库存详情'} drawerSub={selected ? `${selected.available} ${selected.unit} 可用` : undefined}
      list={<Card><DataTable ariaLabel="库存批次列表" loading={loading} rows={rows} rowKey={stock => stock.id} selectedKey={selected?.id} density="comfy" onRowClick={pick} columns={columns} empty={empty} /></Card>}
      detail={detail} />
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage></Nav.Provider>;
}

function StockDetail({ stock, state, can, locked, canClaims, onMove, onScrap, onPurchase, onClaim }: {
  stock: FulfillmentStock; state: MistState; can: boolean; locked: boolean; canClaims: boolean;
  onMove: (kind: 'issue' | 'return' | 'move') => void; onScrap: () => void; onPurchase: (id: string) => void; onClaim: (id: string, section?: string) => void;
}) {
  const f = state.fulfillment, returned = isReturn(stock), current = stockState(state, stock), out = stockOutstanding(state, stock), domain = domainOf(state, stock);
  const purchase = f.purchases.find(row => row.id === stock.purchaseId), receipt = f.receipts.find(row => row.id === stock.receiptId);
  const record = f.receivedRecords.find(row => row.stockId === stock.id), sourceClaim = state.platform.claims.find(row => row.id === stock.claimId);
  const goods = state.platform.claimGoods.find(row => row.id === stock.goodsId), disposition = sourceClaim?.dispositions.find(row => row.id === stock.dispositionId);
  const warehouse = f.warehouses.find(row => row.id === stock.warehouseId);
  const movements = f.stockMovements.filter(movement => movement.stockId === stock.id);
  const openIssues = movements.filter(movement => movement.kind === 'issue' && stockIssueRemaining(state, movement.id) > 0);
  const writeReason = can ? false : '需要库存写权限';
  const claimOpen = !!sourceClaim && !['Closed', 'Cancelled'].includes(sourceClaim.state);
  const next: { tone: Tone; title: string; text: string } = returned
    ? record && !record.disposal ? { tone: 'warn', title: '退回隔离库存', text: '本批不能通用领出或移位；先按批准去向办理。返修与补发没有真实放行事实时不能假标发出。' } : { tone: 'ok', title: '已按批准去向处置', text: record?.disposal ? `${record.disposal.actor} · ${shortWhen(record.disposal.at)} · ${record.disposal.basis}` : '本批没有待处置数量。' }
    : current === 'available' ? { tone: 'accent', title: `可用 ${stock.available} ${stock.unit}`, text: '发工厂供料或随货出运时登记出库；未用完退回须对应原出库，位置变化登记移位。' }
    : out > 0 ? { tone: 'neutral', title: `已全部出库 · ${out} ${stock.unit}`, text: '本批没有可用数量；工厂退回余料时按原出库登记退回。' }
    : { tone: 'neutral', title: '已出清', text: '本批已全部出库并处置完毕，仅保留流水供追溯。' };
  const returnedReason = '退回隔离库存须按批准去向处置，不能通用领出或移位';
  return <DetailBody data-stock-detail={stock.id} heading={<div>
      <span className="mist-mono mist-muted">{returned ? returnCode(state, stock) || '退货单不可用' : purchase?.code || '来源采购不可用'}{stock.batchNumber ? ` · ${stock.batchNumber}` : ''}</span>
      <div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{stock.name}</div>
    </div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={STATE_TONE[current]}>{STATE_LABEL[current]}</Pill><Pill>{returned ? '批准退货入库' : '采购交付入库'}</Pill>{domain && <Pill>{domain === 'fabric' ? '面料业务' : '成衣业务'}</Pill>}{out > 0 && <Pill>已出库 {out} {stock.unit}</Pill>}</div>
    <Banner tone={next.tone} title={next.title}>{next.text}</Banner>
    <ActionBar busy={locked} actions={[
      { label: '登记出库', icon: PackageMinus, onClick: () => onMove('issue'), primary: !returned && stock.available > 0, reason: writeReason || (returned ? returnedReason : stock.available <= 0 ? '当前没有可用数量' : false), hidden: returned },
      { label: '按原出库退回', icon: Undo2, onClick: () => onMove('return'), primary: !returned && stock.available <= 0 && openIssues.length > 0, reason: writeReason || (!openIssues.length ? '没有未归还的出库' : false), hidden: returned },
      { label: '登记移位', icon: ArrowRightLeft, onClick: () => onMove('move'), reason: writeReason || (stock.available <= 0 ? '当前没有可用数量' : false), hidden: returned },
      { label: '登记本批报废', icon: Trash2, onClick: onScrap, primary: true, reason: writeReason || (!claimOpen ? '来源案件已结束' : false), hidden: !returned || !record || !!record.disposal || goods?.destination !== 'Scrap' || !can },
    ]} />
    {!returned && <span className="mist-note" data-unsupported-actions>预留给订单条目、盘点差异与依据 QC 结论的质量冻结：服务端尚未提供，暂不能在此登记。</span>}
    {returned
      ? <KeyValue items={[{ label: '来源订单', value: <SourceLink source={{ kind: 'orderLine', orderId: stock.orderId, lineId: stock.lineId }} /> }, { label: '正式退货单', value: returnCode(state, stock) || '不可用' }, { label: '来源案件', value: sourceClaim?.code || '不可用' }, { label: '来源CI', value: state.invoices.find(invoice => invoice.id === stock.invoiceId)?.code || '来源发票不可用' }, { label: '来源出运', value: f.shipments.find(shipment => shipment.id === record?.source.shipmentId)?.code || '来源出运不可用' }, { label: '真实批号', value: stock.batchNumber }, { label: '累计入库', value: `${stock.quantity} ${stock.unit}` }, { label: '物理现存', value: `${stock.onHand} ${stock.unit}` }, { label: '隔离数量', value: `${stock.locked} ${stock.unit}` }, { label: '可用数量', value: `${stock.available} ${stock.unit}` }, { label: '仓库', value: warehouse ? `${warehouse.code} · ${warehouse.name}` : '仓库不可用' }, { label: '位置', value: stock.location }, { label: '货权', value: stock.owner }, { label: '货权确认日期', value: stock.ownershipDate }, { label: '货权确认依据', value: stock.ownershipEvidence }, { label: '计量单位', value: stock.unit }]} />
      : <Facts items={[
        { label: '来源订单条目', value: <SourceLink source={{ kind: 'orderLine', orderId: stock.orderId, lineId: stock.lineId }} /> },
        { label: '来源采购', value: purchase ? <TextLink onClick={() => onPurchase(purchase.id)}>{purchase.code} · {purchase.supplier}</TextLink> : '来源采购不可用' },
        { label: '入库日期', value: receipt?.date || shortWhen(stock.createdAt) },
        { label: '累计入库', value: `${stock.quantity} ${stock.unit}` },
        { label: '当前可用', value: `${stock.available} ${stock.unit}` },
        { label: '已出库（净）', value: out > 0 ? `${out} ${stock.unit}` : '无' },
        { label: '仓库 / 位置', value: `${warehouse ? `${warehouse.name} · ` : ''}${stock.location || '位置未记录'}` },
        { label: '货权', value: stock.owner },
      ]} />}
    {receipt?.evidence && !returned && <p className="mist-sub">入库依据：{receipt.evidence}</p>}
    <PositionSummary row={stock} />
    {openIssues.length > 0 && <DetailBlock title="出库去向 · 可按原出库退回">
      <DataTable ariaLabel="出库去向" rows={openIssues} rowKey={movement => movement.id} columns={[
        { key: 'who', header: '接收方', render: movement => movement.person },
        { key: 'where', header: '交接地点', hideOnMobile: true, render: movement => movement.location },
        { key: 'when', header: '出库日', hideOnMobile: true, render: movement => shortWhen(movement.at) },
        { key: 'left', header: '可退回', align: 'right', render: movement => `${stockIssueRemaining(state, movement.id)} ${stock.unit}` },
      ]} />
    </DetailBlock>}
    {record && <DetailBlock title="收货与处置凭据"><RecordFiles ids={[...record.fileIds, ...(record.disposal?.fileIds || [])]} /></DetailBlock>}
    {returned && <div className="mist-row mist-module-actions">{sourceClaim && canClaims && <Button onClick={() => onClaim(sourceClaim.id)}>返回准确案件</Button>}{disposition?.creditNoteId && sourceClaim && canClaims && <Button onClick={() => onClaim(sourceClaim.id, 'credit:' + disposition.creditNoteId)}>查看来源CN</Button>}</div>}
    <DetailBlock title="出入库流水">
      {movements.length ? <Timeline events={movements.slice().reverse().map(movement => ({ who: movement.actor, when: new Date(movement.at).toLocaleString(), text: `${MOVE_LABEL[movement.kind]} ${movement.quantity}${stock.unit} · ${movement.location} · ${movement.note}${movement.onHandBefore === undefined ? '' : ` · 现存 ${movement.onHandBefore}→${movement.onHandAfter} / 隔离 ${movement.lockedBefore}→${movement.lockedAfter}`}` }))} /> : <span className="mist-note">还没有流水</span>}
    </DetailBlock>
  </DetailBody>;
}
const returnCode = (state: MistState, stock: FulfillmentStock) => state.fulfillment.returnReceipts.find(rt => rt.id === stock.returnReceiptId)?.code;
