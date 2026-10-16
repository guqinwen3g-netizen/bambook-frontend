/** 货运管理：业务发起出运 → 后勤核实装箱、订舱与单证 → 资料回业务对客发送 → 实际离港；按面料 / 成衣业务组分开。 */
import React from 'react';
import { Anchor, Boxes, CheckCircle2, Download, FileText, Pencil, Plane, Plus, ScrollText, SearchX, Send, Ship, Undo2, X } from 'lucide-react';
import { BackLink, Banner, Button, Card, CardHeader, Checklist, DataTable, Dropdown, EmptyState, Facts, Field, FormGrid, FormSection, KeyValue, MistPage, Mono, PageHeader, Pill, Pipeline, SearchField, Segmented, Select, TextArea, TextInput, TextLink, Timeline, Toolbar, VerticalSteps, type Column, type Tone } from '../../../../../components/mist';
import type { MistState } from '../../../../../server/src/shared/mistWorkspace';
import type { FulfillmentShipment } from '../../../../../server/src/shared/mistFulfillment';
import { fulfillmentSourceLabel } from '../../../../../server/src/shared/mistFulfillment';
import { OVER_SHIP_REQUIRED, SHORT_SHIP_HINT, pendingOverShip, shipmentToleranceCheck } from '../../../../../server/src/shared/mistOrderClosure';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { ModuleEditorDialog, type ModuleEditorSpec } from './ModuleWorkbench';
import { emptyOption, Events, exportRecords, field, localNow, parseSource, RecordFiles, SourceLink, sourceOptions, status, text, today, useEditor } from './fulfillmentKit';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen, type ReasonedAction } from './pageKit';

function ShipmentEditor({ shipment, onClose }: {
    shipment?: FulfillmentShipment;
    onClose: () => void;
}) {
    const { state, run, saving, pending } = useMistWorkspace(), {route}=useNav();
    const hasOrderContext=route.section?.startsWith('order:')===true, sourceOrderId=hasOrderContext?route.section!.slice(6):undefined;
    const incomingOrder=state?.orders.find(order=>order.id===sourceOrderId);
    const sourceOrder=incomingOrder&&(!route.customerId||incomingOrder.customerId===route.customerId)?incomingOrder:undefined;
    const invalidSource=hasOrderContext&&!!state&&!sourceOrder;
    const sourceOptionsForShipment=sourceOptions(state,false).filter(option=>!option.value||option.value.startsWith('production:')&&(!hasOrderContext||!!sourceOrder&&(!!shipment||state?.productions.find(branch=>branch.id===option.value.slice(11))?.orderId===sourceOrder.id)));
    const [step, setStep] = React.useState(0), [failure, setFailure] = useRouteDraft(''), [busy, setBusy] = React.useState(false);
    const [lines, setLines] = React.useState(shipment?.lines.map(l => ({ source: l.productionId ? 'production:' + l.productionId : 'line:' + l.lineId, quantity: l.quantity, factoryConfirmedAt: l.factoryConfirmedAt })) || [{ source: '', quantity: '' as number|'', factoryConfirmedAt: today() }]);
    const [form, setForm] = React.useState({ portOfLoading: shipment?.portOfLoading || '', portOfDischarge: shipment?.portOfDischarge || '', incoterm: shipment?.incoterm || (hasOrderContext?sourceOrder?.governance?.contract.incoterm||'':'FOB'), plannedDate: shipment?.plannedDate || '', booking: shipment?.booking || '', note: shipment?.note || '' });
    let first: ReturnType<typeof parseSource> | undefined;
    try {
        if (state && lines[0].source)
            first = parseSource(state, lines[0].source);
    }
    catch { }
    const terms = state?.fulfillment.shippingTerms.find(term=>term.orderId===(!shipment&&sourceOrder?sourceOrder.id:first?.kind==='orderLine'?first.orderId:undefined));
    const blocked = busy || saving || !!pending || invalidSource;
    // BB-ORD-6：按条目累计（本票 + 其他未取消出运）预判溢短装；超出须经理审批，短装仅提示。
    const toleranceChecks = React.useMemo(() => { if (!state) return []; const totals = new Map<string, number>(); for (const row of lines) { try { const src = parseSource(state, row.source); if (src.kind === 'orderLine' && typeof row.quantity === 'number' && row.quantity > 0) totals.set(src.lineId, (totals.get(src.lineId) || 0) + row.quantity); } catch { } }
        return [...totals].flatMap(([lineId, quantity]) => { const line = state.orderLines.find(l => l.id === lineId), order = state.orders.find(o => o.id === line?.orderId); if (!line || !order) return []; const reserved = state.fulfillment.shipments.filter(s => s.id !== shipment?.id && s.state !== 'cancelled').flatMap(s => s.lines.filter(l => l.lineId === lineId).map(l => l.quantity)).reduce((a, b) => a + b, 0); return [{ line, order, reserved, check: shipmentToleranceCheck(line, order.governance?.contract, reserved + quantity), pending: pendingOverShip(line) }]; }); }, [state, lines, shipment?.id]);
    const [overReason, setOverReason] = React.useState<Record<string, string>>({}), [overNotice, setOverNotice] = React.useState('');
    const requestOverShip = async (item: typeof toleranceChecks[number]) => { if (blocked) return; setFailure(''); setOverNotice(''); setBusy(true); try {
        await run({ type: 'order.governance.requestOverShip', payload: { orderId: item.order.id, lineId: item.line.id, quantity: item.check.cumulative, reason: (overReason[item.line.id] || '').trim() } });
        setOverNotice(`已发起超量出运申请：${item.line.style} 累计 ${item.check.cumulative} ${item.line.unit}，等待订单审批人在审批中心决定。`);
    } catch (e) { setFailure(e instanceof Error ? e.message : '超量出运申请未提交'); } finally { setBusy(false); } };
    const toleranceNotices = toleranceChecks.filter(t => t.check.verdict !== 'within').map(({ line, check, pending: waiting, reserved }) => check.verdict === 'over'
        ? <section key={line.id} data-over-ship={line.id}><Banner tone="bad" title={OVER_SHIP_REQUIRED}>{line.style} · {line.name}：累计出运 {check.cumulative} {line.unit}（本票 {Math.round((check.cumulative - reserved) * 10000) / 10000}，其他出运 {reserved}），{check.approved > check.max ? `已批准上限 ${check.limit}` : `溢装上限 ${check.max}`}，超出 {check.excess} {line.unit}。</Banner>{waiting ? <p className="mist-note">超量出运申请审批中（拟出 {waiting.quantity} {line.unit}），批准后才能保存。</p> : <><Field label="超量原因" required><TextArea aria-label={`超量原因 ${line.style}`} value={overReason[line.id] || ''} onChange={e => setOverReason(r => ({ ...r, [line.id]: e.target.value }))}/></Field><Button disabled={blocked || !(overReason[line.id] || '').trim()} onClick={() => { const item = toleranceChecks.find(t => t.line.id === line.id); if (item) void requestOverShip(item); }}>发起超量出运申请</Button></>}</section>
        : <Banner key={line.id} tone="warn" title={SHORT_SHIP_HINT}><span data-short-ship={line.id}>{line.style} · {line.name}：累计出运 {check.cumulative} {line.unit}，低于短装下限 {check.min}；可继续保存，尾数请在订单条目处理。</span></Banner>);
    const validate = () => {
        if (!state) throw new Error('工作区尚未读取');
        if (invalidSource) throw new Error('指定订单不存在或客户不匹配，不能创建其他订单的出运');
        if (!terms) throw new Error('请先为来源订单核对合同收货条款');
        const values = lines.map(row => {
            const src=parseSource(state,row.source);
            if(src.kind!=='orderLine')throw new Error('出运必须关联订单条目');
            if(!shipment&&sourceOrder&&src.orderId!==sourceOrder.id)throw new Error('来源分支不属于当前订单');
            if(typeof row.quantity!=='number'||!Number.isFinite(row.quantity)||row.quantity<=0)throw new Error('请明确填写本次计划数量');
            return {orderId:src.orderId,lineId:src.lineId,productionId:src.productionId,quantity:row.quantity,factoryConfirmedAt:row.factoryConfirmedAt};
        });
        if (toleranceChecks.some(t => t.check.verdict === 'over')) throw new Error(OVER_SHIP_REQUIRED + '，请先发起超量出运申请并等待批准');
        return values;
    };
    const save = async () => { if (blocked)
        return; setFailure(''); setBusy(true); try {
        const values = validate();
        await run({ type: 'fulfillment.shipments.save', payload: { ...(shipment ? { id: shipment.id } : {}), ...form, consignee: terms!.consignee, mode: terms!.mode, lines: values, fileIds: shipment?.fileIds || [] } });
        onClose();
    }
    catch (e) {
        setFailure(e instanceof Error ? e.message : '出运请求未保存');
    }
    finally {
        setBusy(false);
    } };
    const updateLine = (index: number, patch: Partial<typeof lines[number]>) => setLines(all => all.map((l, i) => i === index ? { ...l, ...patch } : l));
    return <MistPage><BackLink onClick={onClose}>返回货运管理</BackLink><PageHeader title={shipment ? '编辑出运请求' : '创建出运请求'} description={invalidSource?"指定订单不存在或客户不匹配，请返回并重新选择准确来源。":sourceOrder?`${sourceOrder.code} · ${sourceOrder.customer} · 请明确选择本次工厂分支与数量。`:"逐条选择本次真实可出运的来源，收货方和分批限制读取已核对的合同。"}/>{failure && <Banner tone="bad" title="出运请求未保存">{failure}</Banner>}<div className="mist-wizard"><VerticalSteps current={String(step)} onSelect={value => { if (Number(value) < step)
        setStep(Number(value)); }} steps={[{ id: '0', label: '来源与数量', done: step > 0 }, { id: '1', label: '运输信息', done: step > 1 }, { id: '2', label: '确认请求', done: false }]}/><Card>{step === 0 ? <FormSection title="本次出运范围">{lines.map((line, i) => <div className="mist-section" key={i}><FormGrid><Field label={`来源条目 ${i + 1}`} required><Select aria-label={`来源条目 ${i + 1}`} value={line.source} options={sourceOptionsForShipment} onChange={e => updateLine(i, { source: e.target.value })}/></Field><Field label="本次计划数量" required><TextInput type="number" min={0.0001} step="0.0001" value={line.quantity} onChange={e => updateLine(i, { quantity: e.target.value===''?'':Number(e.target.value) })}/></Field><Field label="工厂可出运确认日" required><TextInput type="date" value={line.factoryConfirmedAt} onChange={e => updateLine(i, { factoryConfirmedAt: e.target.value })}/></Field></FormGrid>{lines.length > 1 && <Button onClick={() => setLines(all => all.filter((_, n) => n !== i))}>移除此条目</Button>}</div>)}<Button icon={Plus} onClick={() => setLines(all => [...all, { source: '', quantity: '' as number|'', factoryConfirmedAt: today() }])}>增加来源条目</Button>{overNotice && <Banner tone="ok" title="已提交审批">{overNotice}</Banner>}{toleranceNotices}{terms ? <KeyValue items={[{ label: '合同收货方', value: terms.consignee }, { label: '运输方式', value: terms.mode === 'sea' ? '海运' : '空运' }, { label: '分批条款', value: terms.partialAllowed ? '允许分批' : '禁止分批' }, { label: '合同依据', value: terms.evidence }]}/> : <Banner tone="warn" title="选择已核对合同条款的来源">未登记时，请返回货运管理，先核对合同收货条款。</Banner>}</FormSection> : step === 1 ? <FormSection title="运输与后勤要求"><FormGrid>{(['portOfLoading', 'portOfDischarge', 'incoterm', 'plannedDate', 'booking'] as const).map((key, i) => <Field key={key} label={['起运港', '目的港', '贸易术语', '计划出运日', '订舱号'][i]} required={i < 3}><TextInput type={key === 'plannedDate' ? 'date' : 'text'} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}/></Field>)}<Field label="后勤要求" full><TextArea value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))}/></Field></FormGrid></FormSection> : <FormSection title="核对本次请求"><KeyValue items={[{ label: '收货方', value: terms?.consignee }, { label: '运输', value: `${form.portOfLoading} → ${form.portOfDischarge}` }, { label: '贸易术语', value: form.incoterm }, { label: '计划出运日', value: form.plannedDate || '未记录' }, { label: '后勤要求', value: form.note || '未记录' }]}/>{lines.map((l, i) => <p key={i}>{sourceOptionsForShipment.find(o => o.value === l.source)?.label} · {l.quantity} · 工厂确认 {l.factoryConfirmedAt}</p>)}</FormSection>}<div className="mist-sticky-foot"><span className="mist-note">第 {step + 1} / 3 步</span><span className="mist-spacer"/>{step > 0 && <Button disabled={blocked} onClick={() => setStep(s => s - 1)}>上一步</Button>}<Button variant="primary" disabled={blocked} onClick={() => { if (step === 2) {
        void save();
        return;
    } try {
        validate();
        if (step === 1 && (!form.portOfLoading.trim() || !form.portOfDischarge.trim() || !form.incoterm.trim()))
            throw new Error('请填写起运港、目的港与贸易术语');
        setFailure('');
        setStep(s => s + 1);
    }
    catch (e) {
        setFailure(String(e));
    } }}>{step === 2 ? '保存出运请求' : '下一步'}</Button></div></Card></div></MistPage>;
}
function PackingEditor({ shipment, onClose }: {
    shipment: FulfillmentShipment;
    onClose: () => void;
}) {
    const { state, run, saving, pending } = useMistWorkspace();
    const [failure, setFailure] = useRouteDraft(''), [busy, setBusy] = React.useState(false);
    const existing = (state?.fulfillment.packing || []).filter(p => p.shipmentId === shipment.id);
    const [rows, setRows] = React.useState<Array<{
        id: string;
        lineId: string;
        productionId?: string;
        carton: string;
        quantity: number;
        netWeight: number;
        grossWeight: number;
        volume: number;
        note: string;
    }>>(existing.length ? existing : shipment.lines.map((l, i) => ({ id: String(i), lineId: l.lineId, productionId: l.productionId, carton: String(i + 1), quantity: l.quantity, netWeight: 0, grossWeight: 0, volume: 0, note: '' })));
    const update = (index: number, patch: Partial<typeof rows[number]>) => setRows(all => all.map((r, i) => i === index ? { ...r, ...patch } : r));
    const options = shipment.lines.map(l => ({ value: l.lineId + '::' + (l.productionId || ''), label: state?.orderLines.find(o => o.id === l.lineId)?.name + ' · ' + (state?.productions.find(p => p.id === l.productionId)?.code || state?.orderLines.find(o => o.id === l.lineId)?.style) }));
    const columns: Column<typeof rows[number]>[] = [{ key: 'source', header: '准确条目', width: 'minmax(190px,2fr)', render: r => <Select aria-label="装箱来源条目" value={r.lineId + '::' + (r.productionId || '')} options={options} onChange={e => { const [lineId, productionId] = e.target.value.split('::'); update(rows.indexOf(r), { lineId, productionId: productionId || undefined }); }}/> }, { key: 'carton', header: '箱号', width: '100px', render: r => <TextInput aria-label="箱号" value={r.carton} onChange={e => update(rows.indexOf(r), { carton: e.target.value })}/> }, ...(['quantity', 'netWeight', 'grossWeight', 'volume'] as const).map((key, i): Column<typeof rows[number]> => ({ key, header: ['数量', '净重 kg', '毛重 kg', '体积 m³'][i], width: '100px', align: 'right', render: r => <TextInput aria-label={['装箱数量', '净重', '毛重', '体积'][i]} type="number" min={0} step="0.0001" value={r[key]} onChange={e => update(rows.indexOf(r), { [key]: Number(e.target.value) })}/> })), { key: 'remove', header: '', width: '70px', render: r => <TextLink onClick={() => setRows(all => all.filter(item => item !== r))}>移除</TextLink> }];
    return <MistPage><BackLink onClick={onClose}>返回出运详情</BackLink><PageHeader title="装箱分配" description={`${shipment.code} · 每条来源的装箱数量须等于本次计划数量。`}/>{failure && <Banner tone="bad" title="装箱未保存">{failure}</Banner>}<div className="mist-reconcile"><Card><CardHeader title="本次计划"/><KeyValue items={shipment.lines.map(l => ({ label: state?.orderLines.find(o => o.id === l.lineId)?.name || '来源条目', value: `${l.quantity} ${state?.orderLines.find(o => o.id === l.lineId)?.unit || ''}` }))}/></Card><Card><CardHeader title="实际装箱" tools={<Button icon={Plus} onClick={() => setRows(all => [...all, { id: crypto.randomUUID(), lineId: shipment.lines[0].lineId, productionId: shipment.lines[0].productionId, carton: String(all.length + 1), quantity: 0, netWeight: 0, grossWeight: 0, volume: 0, note: '' }])}>增加装箱行</Button>}/><DataTable rows={rows} columns={columns} rowKey={r => r.id}/><Checklist items={shipment.lines.map(l => { const packed = Math.round(rows.filter(r => r.lineId === l.lineId && r.productionId === l.productionId).reduce((n, r) => n + r.quantity, 0) * 10000) / 10000; return { label: `${state?.orderLines.find(o => o.id === l.lineId)?.name}：已分配 ${packed} / ${l.quantity}`, done: packed === l.quantity }; })}/><div className="mist-sticky-foot"><span className="mist-spacer"/><Button variant="primary" disabled={busy || saving || !!pending} onClick={() => { setBusy(true); setFailure(''); void run({ type: 'fulfillment.shipments.pack', payload: { id: shipment.id, lines: rows.map(({ id, ...row }) => row) } }).then(onClose).catch(e => setFailure(e instanceof Error ? e.message : '装箱分配未保存')).finally(() => setBusy(false)); }}>保存装箱分配</Button></div></Card></div></MistPage>;
}
type Domain = FulfillmentShipment['domain'];
type Stage = 'intake' | 'logistics' | 'business' | 'departure' | 'departed' | 'cancelled';
type StageFilter = 'all' | Stage;
type FlagFilter = 'all' | 'overdue' | 'packing' | 'mine';
export const STAGE_LABEL: Record<Stage, string> = { intake: '待物流接手', logistics: '物流处理中', business: '资料已回业务', departure: '待离港', departed: '已出运', cancelled: '已取消' };
export const STAGE_TONE: Record<Stage, Tone> = { intake: 'warn', logistics: 'accent', business: 'warn', departure: 'accent', departed: 'ok', cancelled: 'neutral' };
export const MODE_LABEL: Record<FulfillmentShipment['mode'], string> = { sea: '海运', air: '空运' };
const round = (value: number) => Math.round(value * 10000) / 10000;
/** Logistics workbench stage derived only from recorded facts (packing, booking, documents, customs, dispatch, departure). */
export function shipmentStage(root: MistState, s: FulfillmentShipment): Stage {
  if (s.state === 'cancelled') return 'cancelled';
  if (s.state === 'departed') return 'departed';
  if (s.state === 'ready') return s.documentsSentAt ? 'departure' : 'business';
  const f = root.fulfillment;
  const touched = !!s.booking || f.packing.some(row => row.shipmentId === s.id) || f.documents.some(row => row.shipmentId === s.id && row.status !== 'void') || f.customs.some(row => row.shipmentId === s.id);
  return touched ? 'logistics' : 'intake';
}
export const packedFor = (root: MistState, s: FulfillmentShipment, line: FulfillmentShipment['lines'][number]) => round(root.fulfillment.packing.filter(row => row.shipmentId === s.id && row.lineId === line.lineId && row.productionId === line.productionId).reduce((sum, row) => sum + row.quantity, 0));
export const packingMatched = (root: MistState, s: FulfillmentShipment) => s.lines.length > 0 && s.lines.every(line => packedFor(root, s, line) === line.quantity);
function shipmentFlags(root: MistState, s: FulfillmentShipment, day: string) {
  const flags: Array<{ key: 'overdue' | 'packing'; label: string }> = [], stage = shipmentStage(root, s);
  if (stage !== 'departed' && stage !== 'cancelled' && s.plannedDate && s.plannedDate < day) flags.push({ key: 'overdue', label: '计划出运日已过' });
  if (stage !== 'departed' && stage !== 'cancelled' && root.fulfillment.packing.some(row => row.shipmentId === s.id) && !packingMatched(root, s)) flags.push({ key: 'packing', label: '装箱与计划不符' });
  return flags;
}
/** What the backend will refuse when marking documents ready; checked up-front so the reason is visible. */
function readyBlocker(root: MistState, s: FulfillmentShipment) {
  if (!packingMatched(root, s)) return '逐条目装箱数量须等于本次计划数量';
  const issued = root.fulfillment.documents.filter(row => row.shipmentId === s.id && row.status === 'issued');
  if (!issued.some(row => row.type === 'PL')) return '请先在单据中心签发本票装箱单';
  if ([...new Set(s.lines.map(line => line.orderId))].some(orderId => !issued.some(row => row.type === 'CI' && row.orderId === orderId))) return '请按原订单分别签发 CI';
  return '';
}

export function ShipmentsPage() {
  const { state, run, error, refresh, loading, saving, pending } = useMistWorkspace(), session = useMistSession(), { go, route } = useNav(), editor = useEditor();
  const [editing, setEditing] = useRouteDraft<FulfillmentShipment | 'new' | null>(null), [packing, setPacking] = useRouteDraft<FulfillmentShipment | null>(null);
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null), [failure, setFailure] = useRouteDraft('');
  const [domainChoice, setDomainChoice] = React.useState<Domain | null>(null), [stageFilter, setStageFilter] = React.useState<StageFilter>('all'), [flagFilter, setFlagFilter] = React.useState<FlagFilter>('all'), [query, setQuery] = React.useState('');
  const [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(!!route.id);
  React.useEffect(() => { if (route.id) { setPicked(route.id); setDrawer(true); setDomainChoice(null); } }, [route.id]);
  const hasOrderContext = route.section?.startsWith('order:') === true, sourceOrderId = hasOrderContext ? route.section!.slice(6) : undefined;
  const incomingOrder = state?.orders.find(order => order.id === sourceOrderId);
  const sourceOrder = incomingOrder && (!route.customerId || incomingOrder.customerId === route.customerId) ? incomingOrder : undefined;
  const invalidSource = hasOrderContext && !!state && !sourceOrder;
  const business = session.hasPermission('orders:write'), logistics = session.hasPermission('shipments:write'), me = session.user?.id || '';
  const day = today(), locked = saving || !!pending;
  const all = state?.fulfillment.shipments || [];
  const scoped = all.filter(shipment => !hasOrderContext || !!sourceOrder && shipment.customerId === sourceOrder.customerId && shipment.lines.some(line => line.orderId === sourceOrder.id));
  const routed = all.find(shipment => shipment.id === route.id);
  const domain: Domain = domainChoice || routed?.domain || (sourceOrder?.type as Domain | undefined) || (scoped.some(s => s.domain === 'garment') || !scoped.some(s => s.domain === 'fabric') ? 'garment' : 'fabric');
  const domainRows = hasOrderContext ? scoped : scoped.filter(s => s.domain === domain);
  const needle = query.trim().toLowerCase();
  const searched = !state ? [] : domainRows.filter(s => (!needle || `${s.code} ${s.customer} ${s.consignee} ${s.portOfLoading} ${s.portOfDischarge} ${s.booking} ${s.requestedBy} ${s.lines.map(line => fulfillmentSourceLabel(state, { kind: 'orderLine', orderId: line.orderId, lineId: line.lineId })).join(' ')}`.toLowerCase().includes(needle))
    && (flagFilter === 'all' || (flagFilter === 'mine' ? s.requesterId === me : shipmentFlags(state, s, day).some(flag => flag.key === flagFilter))));
  const order: Record<Stage, number> = { business: 0, intake: 1, logistics: 2, departure: 3, departed: 4, cancelled: 5 };
  const rows = !state ? [] : searched.filter(s => stageFilter === 'all' ? shipmentStage(state, s) !== 'cancelled' : shipmentStage(state, s) === stageFilter)
    .sort((a, b) => Number(shipmentFlags(state, b, day).length > 0) - Number(shipmentFlags(state, a, day).length > 0) || order[shipmentStage(state, a)] - order[shipmentStage(state, b)] || (a.plannedDate || '9').localeCompare(b.plannedDate || '9'));
  const selected = rows.find(s => s.id === picked) || (picked ? scoped.find(s => s.id === picked) : undefined);
  if (editing) return <ShipmentEditor shipment={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />;
  if (packing) return <PackingEditor shipment={packing} onClose={() => setPacking(null)} />;
  if (editor.spec) return editor.view;

  const pick = (s: FulfillmentShipment) => { setPicked(s.id); setDrawer(true); const { view, id: _id, ...target } = route; go(view, s.id, target); };
  const changeDomain = (value: Domain) => { setDomainChoice(value); setStageFilter('all'); setPicked(null); };
  const act = async (work: () => Promise<unknown>) => { setFailure(''); try { await work(); } catch (e) { setFailure(e instanceof Error ? e.message : String(e)); } };
  const termsSpec = (): ModuleEditorSpec => ({ title: '核对来源合同收货与分批条款', fields: [field('orderId', '来源订单', 'select', true, [emptyOption, ...(state?.orders || []).filter(o => !hasOrderContext || o.id === sourceOrder?.id).map(o => ({ value: o.id, label: o.code }))]), field('consignee', '合同收货方'), field('partialAllowed', '合同允许分批', 'checkbox', false), field('mode', '约定运输方式', 'select', true, [{ value: 'sea', label: '海运' }, { value: 'air', label: '空运' }]), field('confirmedAt', '条款核实日', 'date'), field('evidence', '合同 / 信用证依据', 'textarea')], initialValues: { orderId: sourceOrder?.id || '', consignee: '', partialAllowed: false, mode: 'sea', confirmedAt: today(), evidence: '' }, submit: v => run({ type: 'fulfillment.shipments.sourceTerms', payload: { orderId: text(v, 'orderId'), consignee: text(v, 'consignee'), partialAllowed: !!v.partialAllowed, mode: text(v, 'mode') as 'sea' | 'air', confirmedAt: text(v, 'confirmedAt'), evidence: text(v, 'evidence') } }) });
  const transportSpec = (s: FulfillmentShipment): ModuleEditorSpec => ({ title: '更新运输安排', fields: [field('booking', '订舱号', 'text', false), field('plannedDate', '计划出运日', 'date', false), { ...field('note', '运输安排说明', 'textarea', false), hint: s.booking ? '更换已登记的订舱号时须写明原因。' : undefined }], initialValues: { booking: s.booking, plannedDate: s.plannedDate, note: s.note }, submit: v => run({ type: 'fulfillment.shipments.updateTransport', payload: { id: s.id, booking: text(v, 'booking'), plannedDate: text(v, 'plannedDate'), note: text(v, 'note') } }) });
  const departSpec = (s: FulfillmentShipment): ModuleEditorSpec => ({ title: s.mode === 'air' ? '登记实际起飞' : '登记实际离港', submitLabel: '登记离港', fields: [field('at', s.mode === 'air' ? '实际起飞时间（ATD）' : '实际离港时间（ATD）', 'datetime-local'), { ...field('evidence', '实际离港 / 起飞依据', 'textarea'), hint: '以船公司 / 航司或货代的实际离港信息为准；Draft B/L 不能作为离港证明。' }], initialValues: { at: localNow(), evidence: '' }, submit: v => run({ type: 'fulfillment.shipments.depart', payload: { id: s.id, at: new Date(text(v, 'at')).toISOString(), evidence: text(v, 'evidence'), fileIds: [] } }) });
  const sentSpec = (s: FulfillmentShipment): ModuleEditorSpec => ({ title: '登记已向客户发送 CI / PL', submitLabel: '登记发送', fields: [{ ...field('at', '向客户发送时间', 'datetime-local'), hint: '发送的是当前有效签发版本；作废或重签后需重新登记。' }], initialValues: { at: localNow() }, submit: v => run({ type: 'fulfillment.shipments.sent', payload: { id: s.id, at: new Date(text(v, 'at')).toISOString() } }) });
  const cancelSpec = (s: FulfillmentShipment): ModuleEditorSpec => ({ title: '取消本次出运请求', submitLabel: '确认取消', fields: [field('reason', '取消原因', 'textarea')], initialValues: { reason: '' }, submit: v => run({ type: 'fulfillment.shipments.cancel', payload: { id: s.id, reason: text(v, 'reason') } }) });
  const stageCount = (value: StageFilter) => !state ? 0 : value === 'all' ? searched.filter(s => shipmentStage(state, s) !== 'cancelled').length : searched.filter(s => shipmentStage(state, s) === value).length;
  const cancelledCount = stageCount('cancelled');
  const columns: Column<FulfillmentShipment>[] = [
    { key: 'code', header: '出运', width: 'minmax(170px,1.6fr)', render: s => <div className="mist-col" style={{ gap: 2 }}><Mono>{s.code}</Mono><small className="mist-muted">{s.customer}</small></div> },
    { key: 'mode', header: '运输', width: 'minmax(140px,1.2fr)', hideOnMobile: true, render: s => <div className="mist-col" style={{ gap: 2 }}><span>{MODE_LABEL[s.mode]} · {s.portOfLoading} → {s.portOfDischarge}</span><small className="mist-muted">{s.incoterm} · {s.booking ? `订舱 ${s.booking}` : '未订舱'}</small></div> },
    { key: 'source', header: '来源', width: 'minmax(110px,1fr)', hideOnMobile: true, render: s => { const orders = [...new Set(s.lines.map(line => line.orderId))]; return <div className="mist-col" style={{ gap: 2 }}><span>{orders.length} 个订单 · {s.lines.length} 条目</span><small className="mist-muted">{orders.map(id => state?.orders.find(o => o.id === id)?.code || '订单不可用').join('、')}</small></div>; } },
    { key: 'date', header: '计划出运', width: '112px', hideOnMobile: true, render: s => <div className="mist-col" style={{ gap: 2 }}><span className={state && shipmentFlags(state, s, day).some(flag => flag.key === 'overdue') ? 'mist-tone-bad' : undefined}>{s.departedAt ? `ATD ${shortWhen(s.departedAt)}` : s.plannedDate || '未定'}</span><small className="mist-muted">{s.requestedBy}</small></div> },
    { key: 'stage', header: '阶段', width: '112px', render: s => state ? <div className="mist-col" style={{ gap: 2, alignItems: 'flex-start' }}><Pill tone={STAGE_TONE[shipmentStage(state, s)]}>{STAGE_LABEL[shipmentStage(state, s)]}</Pill>{shipmentFlags(state, s, day).map(flag => <small key={flag.key} className="mist-tone-bad">{flag.label}</small>)}</div> : null },
  ];
  const canCreate = business ? <Button variant="primary" icon={Plus} disabled={hasOrderContext && !sourceOrder} onClick={() => setEditing('new')}>新建出运</Button> : undefined;
  const empty = domainRows.length
    ? <EmptyState icon={SearchX} title="没有符合条件的出运" description="换个关键词或清除筛选。" action={<Button onClick={() => { setQuery(''); setStageFilter('all'); setFlagFilter('all'); }}>清除筛选</Button>} />
    : <EmptyState icon={Ship} title={invalidSource ? '来源不匹配' : sourceOrder ? '本订单还没有出运' : `还没有${domain === 'fabric' ? '面料' : '成衣'}出运`} description={invalidSource ? '请返回来源订单重新进入。' : '出运由业务员从完工的生产分支发起：先核对合同收货与分批条款，再填写本次计划数量；后勤接手装箱、订舱与单证。'} action={canCreate && !invalidSource ? <Button icon={Plus} onClick={() => setEditing('new')}>新建出运</Button> : undefined} />;
  const detail = selected && state
    ? <ShipmentDetail shipment={selected} state={state} day={day} me={me} business={business} logistics={logistics} locked={locked}
        onEdit={() => setEditing(selected)} onPack={() => setPacking(selected)} onTransport={() => setDialog(transportSpec(selected))}
        onReady={() => void act(() => run({ type: 'fulfillment.shipments.ready', payload: { id: selected.id } }))}
        onSent={() => setDialog(sentSpec(selected))} onDepart={() => setDialog(departSpec(selected))} onCancel={() => setDialog(cancelSpec(selected))}
        onCustoms={() => go('customs', undefined, { section: selected.id })} onDocuments={() => go('document-center', undefined, { section: selected.id })}
        onSamples={() => go('samples', undefined, { section: 'shipment:' + selected.id, customerId: selected.customerId })} />
    : <EmptyState icon={Ship} title="出运详情" description={loading ? '正在读取出运' : '从列表选择一票出运，查看来源范围、装箱、单证与离港轨迹'} compact />;

  return <MistPage width="wide">
    <PageHeader eyebrow="订单履约 · 出运" title="货运管理"
      description={invalidSource ? '指定订单不存在或客户不匹配，请重新选择准确来源，不能创建其他订单的出运。' : sourceOrder ? `${sourceOrder.code} · ${sourceOrder.customer} · 仅显示当前订单相关出运。` : '业务员按完工分支发起出运；后勤核实装箱、订舱与单证后交回业务对客发送，再登记实际离港。'}
      actions={<>
        {sourceOrder && <Button onClick={() => go('orders/detail', sourceOrder.id, { customerId: sourceOrder.customerId, section: sourceOrder.type })}>返回来源订单</Button>}
        {hasOrderContext && <Button onClick={() => go('shipments')}>查看全部出运</Button>}
        <Button icon={Download} disabled={!rows.length} onClick={() => exportRecords('出运台账', ['编号', '客户', '收货方', '运输', '起运港', '目的港', '计划日', '阶段', '实际离港'], rows.map(s => [s.code, s.customer, s.consignee, MODE_LABEL[s.mode], s.portOfLoading, s.portOfDischarge, s.plannedDate, STAGE_LABEL[shipmentStage(state!, s)], s.departedAt || '']))}>导出</Button>
        {business && <Button icon={ScrollText} disabled={hasOrderContext && !sourceOrder} onClick={() => editor.open(termsSpec())}>核对合同收货条款</Button>}
        {canCreate}
      </>} />
    {!business && !logistics && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有出运业务或后勤权限，可以查看出运与轨迹。</Banner></div>}
    {(error || failure) && <div className="mist-section"><Banner tone="bad" title="出运操作未完成" actions={error ? <Button onClick={() => void refresh()}>重试</Button> : undefined}>{failure || error}</Banner></div>}
    {!hasOrderContext && <div className="mist-section"><Segmented<Domain> ariaLabel="业务板块" value={domain} onChange={changeDomain} options={[{ value: 'garment', label: `成衣业务 · ${scoped.filter(s => s.domain === 'garment').length}` }, { value: 'fabric', label: `面料业务 · ${scoped.filter(s => s.domain === 'fabric').length}` }]} /></div>}
    <Toolbar>
      <SearchField value={query} onChange={setQuery} placeholder="搜索出运号、客户、收货方、港口、订舱号或来源订单" />
      <Dropdown<FlagFilter> label="筛选" value={flagFilter} onChange={setFlagFilter} options={[{ value: 'all', label: '全部' }, { value: 'mine', label: '我发起的' }, { value: 'overdue', label: '计划出运日已过' }, { value: 'packing', label: '装箱与计划不符' }]} />
    </Toolbar>
    <Pipeline<StageFilter> value={stageFilter} onChange={setStageFilter} items={[
      { value: 'all', label: '进行中与已出运', count: stageCount('all'), color: 'var(--mist-ink-2)' },
      { value: 'intake', label: '待物流接手', count: stageCount('intake'), color: 'var(--mist-warn)' },
      { value: 'logistics', label: '物流处理中', count: stageCount('logistics'), color: 'var(--mist-accent)' },
      { value: 'business', label: '资料已回业务', count: stageCount('business'), color: 'var(--mist-warn)' },
      { value: 'departure', label: '待离港', count: stageCount('departure'), color: 'var(--mist-accent)' },
      { value: 'departed', label: '已出运', count: stageCount('departed'), color: 'var(--mist-ok)' },
      ...(cancelledCount ? [{ value: 'cancelled' as const, label: '已取消', count: cancelledCount, color: 'var(--mist-ink-3)' }] : []),
    ]} />
    <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)} drawerTitle={selected ? `${selected.code} · ${selected.customer}` : '出运详情'} drawerSub={selected ? `${MODE_LABEL[selected.mode]} · ${selected.portOfLoading} → ${selected.portOfDischarge}` : undefined}
      list={<Card><DataTable ariaLabel="出运列表" loading={loading} rows={rows} rowKey={s => s.id} selectedKey={selected?.id} density="comfy" onRowClick={pick} columns={columns} empty={empty} /></Card>}
      detail={detail} />
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage>;
}

function ShipmentDetail({ shipment: s, state, day, me, business, logistics, locked, onEdit, onPack, onTransport, onReady, onSent, onDepart, onCancel, onCustoms, onDocuments, onSamples }: {
  shipment: FulfillmentShipment; state: MistState; day: string; me: string; business: boolean; logistics: boolean; locked: boolean;
  onEdit: () => void; onPack: () => void; onTransport: () => void; onReady: () => void; onSent: () => void; onDepart: () => void; onCancel: () => void; onCustoms: () => void; onDocuments: () => void; onSamples: () => void;
}) {
  const f = state.fulfillment, stage = shipmentStage(state, s), flags = shipmentFlags(state, s, day), closed = stage === 'departed' || stage === 'cancelled';
  const packingRows = f.packing.filter(row => row.shipmentId === s.id), documents = f.documents.filter(row => row.shipmentId === s.id), customs = f.customs.filter(row => row.shipmentId === s.id);
  const issued = documents.filter(row => row.status === 'issued'), cleared = customs.some(row => row.status === 'cleared');
  const issuedCiPl = issued.some(row => ['CI', 'PL'].includes(row.type)), customsFiled = customs.some(row => row.status !== 'draft');
  const unit = (lineId: string) => state.orderLines.find(line => line.id === lineId)?.unit || '';
  const blocker = readyBlocker(state, s), matched = packingMatched(state, s);
  const cartons = new Set(packingRows.map(row => row.carton)).size, net = round(packingRows.reduce((sum, row) => sum + row.netWeight, 0)), gross = round(packingRows.reduce((sum, row) => sum + row.grossWeight, 0)), volume = round(packingRows.reduce((sum, row) => sum + row.volume, 0));
  const next: { tone: Tone; title: string; text: string } = stage === 'cancelled' ? { tone: 'neutral', title: '已取消', text: s.cancelReason || '未记录原因' }
    : stage === 'departed' ? { tone: 'ok', title: s.mode === 'air' ? '已起飞' : '已离港', text: `ATD ${s.departedAt ? new Date(s.departedAt).toLocaleString() : ''} · ${s.departureEvidence || ''}` }
    : stage === 'intake' ? { tone: 'warn', title: '等待后勤接手', text: '后勤核实来源与数量后逐箱装箱、订舱，并在单据中心签发 CI / PL。' }
    : stage === 'logistics' ? { tone: 'accent', title: '后勤处理中', text: blocker ? `完成单证准备前：${blocker}。` : '装箱与 CI / PL 已齐，可以完成单证准备并交回业务。' }
    : stage === 'business' ? { tone: 'warn', title: '资料已回业务', text: '业务员把当前有效 CI / PL 发给客户后登记发送；之后后勤才能登记实际离港。' }
    : { tone: 'accent', title: '等待离港', text: cleared ? '出口清关已完成，取得实际离港信息后登记 ATD。' : '业务已对客发送；出口清关完成后才能登记实际离港。' };
  const logisticsReason = logistics ? false : '需要后勤出运权限';
  const businessReason = business ? false : '需要订单业务权限';
  const editReason = businessReason || (packingRows.length || issued.length || customsFiled ? '已有装箱、有效单据或申报记录，不能再改请求' : false);
  const cancelReason = businessReason || (s.requesterId !== me ? '仅原业务发起人可取消' : s.booking || issued.length || customsFiled ? '已有订舱、有效单据或申报事实，请先完成对应撤销' : false);
  const packReason = logisticsReason || (issuedCiPl ? '已有有效 CI 或装箱单，请先在单据中心作废原件' : customsFiled ? '已有实际申报或清关记录，请先完成外部更正' : false);
  const departReason = logisticsReason || (!s.documentsSentAt ? '等待业务登记对客发送 CI / PL' : !cleared ? '出口清关尚未完成' : false);
  const track = [
    { label: '业务发起', done: true, note: `${s.requestedBy} · ${shortWhen(s.createdAt)}` },
    { label: '逐条目装箱核实', done: matched, note: packingRows.length ? `${cartons} 箱 · ${matched ? '与计划一致' : '与计划不符'}` : '未装箱', noteTone: packingRows.length && !matched ? 'bad' as const : undefined },
    { label: '订舱', done: !!s.booking, note: s.booking || '未订舱' },
    { label: 'CI / PL 签发', done: issued.some(row => row.type === 'PL') && [...new Set(s.lines.map(line => line.orderId))].every(orderId => issued.some(row => row.type === 'CI' && row.orderId === orderId)), note: issued.length ? issued.map(row => `${row.type} ${row.number}`).join('、') : '未签发' },
    { label: '出口报关', done: cleared, note: customs.length ? customs.map(row => status[row.status] || row.status).join('、') : '未建报关记录' },
    { label: '单证准备完毕 · 交回业务', done: s.state === 'ready' || s.state === 'departed', note: s.state === 'ready' || s.state === 'departed' ? '已交回' : '未完成' },
    { label: '业务对客发送', done: !!s.documentsSentAt, note: s.documentsSentAt ? shortWhen(s.documentsSentAt) : '未登记' },
    { label: s.mode === 'air' ? '实际起飞' : '实际离港', done: !!s.departedAt, note: s.departedAt ? `ATD ${shortWhen(s.departedAt)}` : '未登记' },
  ];
  return <DetailBody data-shipment-detail={s.id} heading={<div>
      <span className="mist-mono mist-muted">{s.code}</span>
      <div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{s.customer}</div>
    </div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</Pill><Pill>{s.domain === 'fabric' ? '面料业务' : '成衣业务'}</Pill><Pill>{MODE_LABEL[s.mode]}</Pill>{flags.map(flag => <Pill key={flag.key} tone="bad">{flag.label}</Pill>)}</div>
    <Banner tone={next.tone} title={next.title}>{next.text}</Banner>
    {(business || logistics) && <ActionBar busy={locked} actions={[
      ...(logistics ? [
        { label: '分配装箱', icon: Boxes, onClick: onPack, primary: stage === 'intake' || (stage === 'logistics' && !matched), reason: packReason, hidden: closed },
        { label: '更新运输安排', icon: Anchor, onClick: onTransport, reason: logisticsReason, hidden: closed },
        { label: '完成单证准备', icon: CheckCircle2, onClick: onReady, primary: stage === 'logistics' && !blocker, reason: logisticsReason || blocker || false, hidden: s.state !== 'preparing' },
        { label: s.mode === 'air' ? '登记实际起飞' : '登记实际离港', icon: s.mode === 'air' ? Plane : Ship, onClick: onDepart, primary: stage === 'departure', reason: departReason, hidden: s.state !== 'ready' },
        { label: '退回业务确认差异', icon: Undo2, onClick: () => undefined, reason: '服务端尚未提供差异退回，请线下联系发起业务员', hidden: s.state !== 'preparing' },
      ] as ReasonedAction[] : []),
      ...(business ? [
        { label: '编辑出运请求', icon: Pencil, onClick: onEdit, reason: businessReason, hidden: s.state !== 'preparing' || !!editReason },
        { label: '登记已向客户发送CI/PL', icon: Send, onClick: onSent, primary: stage === 'business', reason: businessReason, hidden: s.state !== 'ready' },
        { label: '取消请求', icon: X, onClick: onCancel, reason: businessReason, hidden: closed || !!cancelReason },
      ] as ReasonedAction[] : []),
    ]} />}
    <Facts items={[
      { label: '收货方', value: s.consignee },
      { label: '运输', value: `${MODE_LABEL[s.mode]} · ${s.portOfLoading} → ${s.portOfDischarge}` },
      { label: '贸易术语', value: s.incoterm },
      { label: '订舱号', value: s.booking || '未订舱' },
      { label: '计划出运日', value: <span className={flags.some(flag => flag.key === 'overdue') ? 'mist-tone-bad' : undefined}>{s.plannedDate || '未定'}</span> },
      { label: '发起业务员', value: s.requestedBy },
    ]} />
    {s.note && <p className="mist-sub">后勤要求：{s.note}</p>}
    <DetailBlock title="阶段轨迹"><Checklist items={track} /></DetailBlock>
    <DetailBlock title="来源范围（只读）">
      <DataTable ariaLabel={`${s.code} 来源范围`} rows={s.lines} rowKey={line => line.lineId + ':' + (line.productionId || '')} columns={[
        { key: 'source', header: '准确条目', render: line => <SourceLink source={{ kind: 'orderLine', orderId: line.orderId, lineId: line.lineId, productionId: line.productionId }} /> },
        { key: 'plan', header: '计划 / 已装箱', align: 'right', render: line => { const packed = packedFor(state, s, line); return <span className={packingRows.length && packed !== line.quantity ? 'mist-tone-bad' : undefined}>{line.quantity} / {packed} {unit(line.lineId)}</span>; } },
        { key: 'factory', header: '工厂确认', hideOnMobile: true, render: line => line.factoryConfirmedAt },
      ]} />
    </DetailBlock>
    {packingRows.length > 0 && <DetailBlock title="装箱汇总"><Facts items={[{ label: '箱数', value: `${cartons} 箱` }, { label: '净重 / 毛重', value: `${net} / ${gross} kg` }, { label: '体积', value: `${volume} m³` }, { label: '装箱行', value: `${packingRows.length} 行` }]} /></DetailBlock>}
    <DetailBlock title="单证与报关" aside={<span className="mist-row"><TextLink icon={FileText} onClick={onDocuments}>处理本票单据</TextLink><TextLink onClick={onCustoms}>处理本票报关</TextLink></span>}>
      {documents.length ? <DataTable ariaLabel={`${s.code} 单据`} rows={documents} rowKey={row => row.id} columns={[
        { key: 'type', header: '类型', render: row => row.type },
        { key: 'number', header: '编号 · 版本', render: row => `${row.number || '未编号'} · v${row.version}` },
        { key: 'status', header: '状态', render: row => <Pill tone={row.status === 'issued' ? 'ok' : row.status === 'void' ? 'neutral' : 'warn'}>{row.status === 'issued' ? '已签发' : row.status === 'void' ? '已作废' : '草稿'}</Pill> },
      ]} /> : <span className="mist-note">还没有单据；CI / PL 在单据中心按版本签发。</span>}
      {customs.map(row => <span key={row.id} className="mist-note">报关 {row.code} · {status[row.status] || row.status}{row.declarationNo ? ` · ${row.declarationNo}` : ''}</span>)}
    </DetailBlock>
    <div className="mist-row mist-module-actions"><Button onClick={onSamples}>处理本票船样</Button></div>
    {!!s.documentDispatches?.length && <DetailBlock title="对客发送记录"><Timeline events={s.documentDispatches.map(dispatch => ({ who: dispatch.actor, when: new Date(dispatch.at).toLocaleString(), text: '已登记发送：' + dispatch.documentIds.map(id => f.documents.find(row => row.id === id)?.number || '历史单据').join('、') }))} /></DetailBlock>}
    <DetailBlock title="附件"><RecordFiles key={s.id} ids={s.fileIds} />{!s.fileIds.length && <span className="mist-note">离港凭据随“登记实际离港”归档</span>}</DetailBlock>
    <DetailBlock title="处理记录"><Events entity="shipment" id={s.id} /></DetailBlock>
  </DetailBody>;
}
