/** 样品仓库：面料按档案汇总形态余额，成衣按每件实物；详情卡承接借出、寄出、归还、移位与送检。 */
import React from 'react';
import { ArrowLeftRight, Download, Layers, Package, Pencil, Plus, RefreshCw, SearchX, Send, Shirt, Undo2 } from 'lucide-react';
import { Banner, Button, Card, DataTable, Dropdown, EmptyState, Facts, Icon, MistPage, Mono, ObjectCell, PageHeader, Pagination, Pill, Pipeline, SearchField, Tabs, TextLink, Thumb, Timeline, Toolbar, type Column } from '../../../../../components/mist';
import type { FulfillmentSample, SampleMovement } from '../../../../../server/src/shared/mistFulfillment';
import { fulfillmentSourceLabel, fulfillmentPositions, fulfillmentSampleRoleLabel, sampleLoanRemaining } from '../../../../../server/src/shared/mistFulfillment';
import type { MistState } from '../../../../../server/src/shared/mistWorkspace';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { ModuleEditorDialog, type ModuleEditorSpec } from './ModuleWorkbench';
import { choices, emptyOption, exportRecords, field, number, parseSource, PositionSummary, RecordFiles, shipmentReturnTarget, SourceLink, sourceOptions, text, today, useEditor } from './fulfillmentKit';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen } from './pageKit';

type Shelf = 'fabric' | 'garment' | 'other';
type StatusFilter = 'all' | 'available' | 'lent' | 'overdue' | 'empty';
type MoveKind = 'lend' | 'return' | 'send' | 'move';
/** One ledger row: a fabric archive with its forms, or one garment / other physical sample. */
type LedgerRow = { id: string; shelf: Shelf; name: string; samples: FulfillmentSample[]; primary: FulfillmentSample };

const MOVE_LABEL: Record<SampleMovement['kind'], string> = { receive: '入库', lend: '借出', return: '归还', send: '寄出', move: '移位' };
const shelfOf = (sample: FulfillmentSample): Shelf => sample.category === '面料' ? 'fabric' : sample.category === '成衣' ? 'garment' : 'other';
const archiveKey = (sample: FulfillmentSample) => sample.source.kind === 'version' ? 'v:' + sample.source.versionId
  : sample.source.kind === 'orderLine' ? `l:${sample.source.lineId}:${sample.source.productionId || ''}` : `m:${sample.name}|${sample.source.description}`;

function ledgerRows(samples: FulfillmentSample[]): LedgerRow[] {
  const rows: LedgerRow[] = [], archives = new Map<string, LedgerRow>();
  for (const sample of samples) {
    const shelf = shelfOf(sample);
    if (shelf !== 'fabric') { rows.push({ id: sample.id, shelf, name: sample.name, samples: [sample], primary: sample }); continue; }
    const key = archiveKey(sample), existing = archives.get(key);
    if (existing) { existing.samples.push(sample); continue; }
    const row: LedgerRow = { id: 'archive:' + key, shelf, name: sample.name, samples: [sample], primary: sample };
    archives.set(key, row); rows.push(row);
  }
  return rows;
}

function sampleFacts(state: MistState, sample: FulfillmentSample, day: string) {
  const movements = state.fulfillment.sampleMovements.filter(movement => movement.sampleId === sample.id);
  const openLoans = movements.filter(movement => movement.kind === 'lend' && sampleLoanRemaining(state, movement.id) > 0);
  const lent = openLoans.reduce((total, loan) => total + sampleLoanRemaining(state, loan.id), 0);
  const overdue = openLoans.filter(loan => loan.expectedReturn && loan.expectedReturn < day);
  const sent = movements.some(movement => movement.kind === 'send');
  const last = movements.slice().sort((a, b) => a.at.localeCompare(b.at)).pop();
  return { movements, openLoans, lent: Math.round(lent * 10000) / 10000, overdue, sent, last };
}

function rowStatus(state: MistState, row: LedgerRow, day: string): { key: StatusFilter; label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } {
  const facts = row.samples.map(sample => sampleFacts(state, sample, day));
  if (facts.some(fact => fact.overdue.length)) return { key: 'overdue', label: '逾期未还', tone: 'bad' };
  if (facts.some(fact => fact.openLoans.length)) return { key: 'lent', label: row.shelf === 'fabric' ? '部分借出' : '借出中', tone: 'warn' };
  if (row.samples.some(sample => sample.available > 0)) return { key: 'available', label: row.shelf === 'fabric' ? '可用' : '在库', tone: 'ok' };
  return { key: 'empty', label: facts.some(fact => fact.sent) ? '已寄出' : '无可用', tone: 'neutral' };
}

const locationSummary = (row: LedgerRow) => {
  const places = [...new Set(row.samples.flatMap(sample => fulfillmentPositions(sample).filter(position => position.available > 0).map(position => position.location || '位置未记录')))];
  return places.length === 0 ? '无在库位置' : places.length === 1 ? places[0] : '多个位置';
};

export function SamplesPage() {
  const { state, loading, error, run, saving, pending } = useMistWorkspace(), session = useMistSession(), { go, route } = useNav(), editor = useEditor();
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null);
  const [syncError, setSyncError] = useRouteDraft(''), [syncing, setSyncing] = React.useState(false);
  const [query, setQuery] = React.useState(''), [form, setForm] = React.useState('all'), [origin, setOrigin] = React.useState('all'), [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all');
  const [page, setPage] = React.useState(1), [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(false);
  React.useEffect(() => { setPicked(route.id || null); }, [route.id]);
  const day = today(), can = session.hasPermission('products:write'), locked = saving || !!pending;

  // Shipment context: only this shipment's shipping samples, bound to its exact production branch.
  const hasShipmentContext = route.section?.startsWith('shipment:') === true, shipmentId = hasShipmentContext ? route.section!.slice(9) : undefined;
  const incomingShipment = state?.fulfillment.shipments.find(shipment => shipment.id === shipmentId);
  const sourceShipment = incomingShipment && incomingShipment.state !== 'cancelled' && (!route.customerId || incomingShipment.customerId === route.customerId) ? incomingShipment : undefined;
  const shipmentProductions = (state?.productions || []).filter(branch => sourceShipment?.lines.some(line => line.productionId === branch.id && line.orderId === branch.orderId && line.lineId === branch.lineId));
  const uniqueProduction = shipmentProductions.length === 1 ? shipmentProductions[0] : undefined;
  const sourceProduction = route.productionId ? shipmentProductions.find(branch => branch.id === route.productionId) : uniqueProduction;
  const invalidShipment = hasShipmentContext && !!state && (!sourceShipment || !shipmentProductions.length);
  const sourceHint = invalidShipment ? '本票出运或准确生产来源已不可用，请重新选择出运。' : hasShipmentContext && route.productionId && !sourceProduction ? '指定工厂分支不属于本票，请明确选择本票实际来源。' : hasShipmentContext && shipmentProductions.length > 1 ? '本票含多个生产分支，请明确选择本次船样实际来源。' : undefined;
  const inShipment = (sample: FulfillmentSample) => !hasShipmentContext || !!sourceShipment && sample.role === 'shipping' && sample.shipmentId === sourceShipment.id && sample.source.kind === 'orderLine'
    && shipmentProductions.some(branch => sample.source.kind === 'orderLine' && branch.id === sample.source.productionId && branch.orderId === sample.source.orderId && branch.lineId === sample.source.lineId);

  const allRows = ledgerRows((state?.fulfillment.samples || []).filter(inShipment));
  const routedRow = allRows.find(row => row.samples.some(sample => sample.id === picked) || row.id === picked);
  const counts: Record<Shelf, number> = { fabric: 0, garment: 0, other: 0 }; for (const row of allRows) counts[row.shelf]++;
  const [shelfChoice, setShelf] = React.useState<Shelf | null>(null);
  const shelf: Shelf = shelfChoice || routedRow?.shelf || (counts.fabric || !counts.garment ? (counts.fabric || counts.other === 0 ? 'fabric' : 'other') : 'garment');
  const shelfRows = allRows.filter(row => row.shelf === shelf);
  const forms = [...new Set(shelfRows.flatMap(row => row.samples.map(sample => sample.form)))];
  const statusOf = (row: LedgerRow) => state ? rowStatus(state, row, day) : { key: 'all' as StatusFilter, label: '', tone: 'neutral' as const };
  const searchText = (row: LedgerRow) => [row.name, ...row.samples.flatMap(sample => [sample.code, sample.form, sample.size, sample.color, sample.location, sample.note, ...fulfillmentPositions(sample).map(position => position.location)]), state ? fulfillmentSourceLabel(state, row.primary.source) : ''].join(' ').toLocaleLowerCase();
  const filtered = shelfRows.filter(row => (form === 'all' || row.samples.some(sample => sample.form === form))
    && (origin === 'all' || row.primary.source.kind === origin)
    && (statusFilter === 'all' || statusOf(row).key === statusFilter || (statusFilter === 'lent' && statusOf(row).key === 'overdue'))
    && (!query || searchText(row).includes(query.toLocaleLowerCase())));
  const size = 10, pages = Math.max(1, Math.ceil(filtered.length / size)), currentPage = Math.min(page, pages), visible = filtered.slice((currentPage - 1) * size, currentPage * size);
  const selected = routedRow && routedRow.shelf === shelf ? routedRow : visible[0];
  React.useEffect(() => setPage(1), [query, form, origin, statusFilter, shelf]);
  const overdueLoans = state ? allRows.flatMap(row => row.samples.flatMap(sample => sampleFacts(state, sample, day).overdue.map(loan => ({ loan, sample })))) : [];

  const synchronize = async () => { if (syncing || locked) return; setSyncing(true); setSyncError(''); try { await run({ type: 'fulfillment.samples.sync', payload: {} }); } catch (problem) { setSyncError(problem instanceof Error ? problem.message : '来源实物同步失败'); } finally { setSyncing(false); } };
  const pick = (row: LedgerRow) => { setPicked(row.primary.id); setDrawer(true); const { view, id: _id, detail: _detail, ...target } = route; go(view, row.primary.id, target); };
  const changeShelf = (next: Shelf) => { setShelf(next); setForm('all'); setStatusFilter('all'); setPicked(null); };

  const sampleSources = hasShipmentContext ? [emptyOption, ...shipmentProductions.map(branch => ({ value: 'production:' + branch.id, label: `${branch.order} · ${branch.code} · ${branch.factory}` }))]
    : [{ value: 'manual', label: '手工 / 无系统来源' }, ...sourceOptions(state, true).filter(option => option.value && !option.value.startsWith('line:'))];
  const roleOptions = hasShipmentContext ? [{ value: 'shipping', label: '船样' }] : [emptyOption, { value: 'pp', label: '成衣产前样' }, { value: 'pioneer', label: '面料先锋样' }, { value: 'shipping', label: '船样' }];
  const shipmentOptions = hasShipmentContext ? (sourceShipment ? [{ value: sourceShipment.id, label: sourceShipment.code }] : [emptyOption]) : [emptyOption, ...(state?.fulfillment.shipments || []).filter(shipment => shipment.state !== 'cancelled').map(shipment => ({ value: shipment.id, label: shipment.code }))];
  const defaultCategory = sourceShipment ? (sourceShipment.domain === 'fabric' ? '面料' : '成衣') : shelf === 'garment' ? '成衣' : shelf === 'other' ? '其他' : '面料';
  const createSpec: ModuleEditorSpec = {
    title: '新建样品', description: '登记实际收到的实物。有系统来源时选准确版本或生产分支；没有来源时写明手工来源。',
    sections: [
      { id: 'identity', label: '类别与来源', description: '来源决定样品与开发版本或订单分支的准确关联。', fields: ['category', 'categoryCustom', 'name', 'source', 'sourceText', 'role', 'shipmentId'] },
      { id: 'form', label: '形态与数量', description: '面料按形态与单位记录；成衣每件单独登记。', fields: ['form', 'quantity', 'unit'] },
      { id: 'place', label: '规格与位置', fields: ['size', 'color', 'location', 'note'] },
    ],
    fields: [field('category', '大类', 'select', true, choices(['面料', '成衣', '其他'])), field('categoryCustom', '其他类别（选其他时填写）', 'text', false), field('name', '名称'),
      { ...field('source', '准确来源', 'select', true, sampleSources), hint: sourceHint }, field('sourceText', '手工来源说明', 'text', false),
      { ...field('role', '订单样品角色', 'select', hasShipmentContext, roleOptions), readonly: hasShipmentContext }, { ...field('shipmentId', '船样对应出运批次', 'select', hasShipmentContext, shipmentOptions), readonly: hasShipmentContext },
      field('form', '形态'), field('quantity', '数量 / 长度', 'number'), field('unit', '单位', 'select', true, choices(['米', '码', '公斤', '份', '件'])),
      field('size', '尺码', 'text', false), field('color', '颜色', 'text', false), field('location', '自由文本位置', 'text', false), field('note', '备注', 'textarea', false)],
    initialValues: { category: defaultCategory, categoryCustom: '', name: '', source: hasShipmentContext ? (sourceProduction ? 'production:' + sourceProduction.id : '') : route.productionId ? 'production:' + route.productionId : 'manual', sourceText: '',
      role: hasShipmentContext ? 'shipping' : route.productionId ? (state?.orders.find(order => order.id === state.productions.find(branch => branch.id === route.productionId)?.orderId)?.type === 'fabric' ? 'pioneer' : 'pp') : '',
      shipmentId: sourceShipment?.id || '', form: hasShipmentContext ? '船样' : '', quantity: 1, unit: defaultCategory === '面料' ? '' : '件', size: '', color: '', location: '', note: '' },
    submitLabel: '登记样品',
    submit: async values => {
      if (!state) return; if (invalidShipment) throw new Error('本票出运或生产来源已不可用');
      const category = text(values, 'category') === '其他' ? text(values, 'categoryCustom') : text(values, 'category');
      if (!category) throw new Error('请填写其他类别');
      if (category !== '面料' && !Number.isInteger(number(values, 'quantity'))) throw new Error('件或份类样品必须按整数登记');
      await run({ type: 'fulfillment.samples.create', payload: { name: text(values, 'name'), category, form: text(values, 'form'), unit: text(values, 'unit'), quantity: number(values, 'quantity'), location: text(values, 'location'), size: text(values, 'size'), color: text(values, 'color'), note: text(values, 'note'), fileIds: [],
        ...(text(values, 'role') ? { role: text(values, 'role') as FulfillmentSample['role'] } : {}), ...(text(values, 'shipmentId') ? { shipmentId: text(values, 'shipmentId') } : {}),
        source: text(values, 'source') === 'manual' ? { kind: 'manual', description: text(values, 'sourceText') } : parseSource(state, text(values, 'source')) } });
    },
  };
  const editSpec = (sample: FulfillmentSample): ModuleEditorSpec => ({ title: '编辑样品资料', description: '来源、类别和数量由流转记录决定，这里只修改识别资料。', fields: [field('name', '样品名称'), field('form', '样品形态'), field('size', '尺码', 'text', false), field('color', '颜色', 'text', false), field('note', '备注', 'textarea', false)],
    initialValues: { name: sample.name, form: sample.form, size: sample.size, color: sample.color, note: sample.note },
    submit: values => run({ type: 'fulfillment.samples.edit', payload: { id: sample.id, location: sample.location, name: text(values, 'name'), form: text(values, 'form'), size: text(values, 'size'), color: text(values, 'color'), note: text(values, 'note'), fileIds: sample.fileIds } }) });
  const movement = (sample: FulfillmentSample, kind: MoveKind) => {
    if (!state) return;
    const loans = state.fulfillment.sampleMovements.filter(item => item.sampleId === sample.id && item.kind === 'lend' && sampleLoanRemaining(state, item.id) > 0);
    const positions = fulfillmentPositions(sample);
    setDialog({ title: ({ lend: '登记借出', return: '登记分次归还', send: '登记永久寄出', move: '登记移位' })[kind] + ` · ${sample.form}`,
      description: ({ lend: '借出后可用量减少，归还时引用本次借出。', return: '可分次归还，归还量不超过未还量。', send: '寄出后不再归还，例如寄给客户确认。', move: '整批移到新位置，不改变数量。' })[kind],
      fields: [...(kind !== 'return' && positions.length > 1 ? [field('sourceLocation', '本次出库位置', 'select', true, [{ value: '__choose__', label: '请选择位置' }, ...positions.map(position => ({ value: position.location, label: `${position.location || '位置未记录'} · ${position.available}${sample.unit}` }))])] : []),
        ...(kind === 'return' ? [field('loanId', '原借出', 'select', true, [emptyOption, ...loans.map(loan => ({ value: loan.id, label: `${loan.person} · 未还 ${sampleLoanRemaining(state, loan.id)}${sample.unit} · ${loan.at.slice(0, 10)}` }))])] : []),
        ...(kind !== 'move' ? [field('quantity', `本次数量（${sample.unit}）`, 'number')] : []),
        field('person', kind === 'send' ? '收件人 / 公司' : kind === 'lend' ? '借用人' : '经手人', 'text', kind === 'lend' || kind === 'send'),
        field('location', kind === 'send' ? '寄送去向 / 运单号' : '新位置', 'text', false), ...(kind === 'lend' ? [field('expectedReturn', '预计归还日', 'date', false)] : []), field('note', '交接说明', 'textarea', false)],
      initialValues: { quantity: kind === 'return' ? 0 : sample.available, person: '', location: kind === 'return' || sample.location === '多个位置' ? '' : sample.location, note: '', loanId: '', expectedReturn: '', sourceLocation: '__choose__' },
      submitLabel: '保存流转',
      submit: values => run({ type: 'fulfillment.samples.move', payload: { id: sample.id, kind, quantity: kind === 'move' ? 0 : number(values, 'quantity'), person: text(values, 'person'), location: text(values, 'location'), note: text(values, 'note'),
        ...(text(values, 'loanId') ? { loanId: text(values, 'loanId') } : {}), ...(text(values, 'expectedReturn') ? { expectedReturn: text(values, 'expectedReturn') } : {}), ...(text(values, 'sourceLocation') !== '__choose__' ? { sourceLocation: text(values, 'sourceLocation') } : {}) } }) });
  };
  const openSampleQc = (sample: FulfillmentSample) => {
    const source = sample.source; if (source.kind === 'manual' || !state) return;
    const existing = state.fulfillment.qcTasks.find(task => task.sampleId === sample.id);
    const qcTarget = sample.role === 'shipping' && sample.shipmentId ? { section: 'shipment:' + sample.shipmentId, productionId: source.kind === 'orderLine' ? source.productionId : undefined } : { section: 'sample', ...(source.kind === 'orderLine' ? { orderLineId: source.lineId, productionId: source.productionId } : { versionId: source.versionId }) };
    if (existing) { go('qc-workbench', existing.id, qcTarget); return; }
    editor.open({ title: `送检 ${sample.code} · ${sample.role ? fulfillmentSampleRoleLabel(sample.role) : '开发样'}`, description: '发起后由对应板块的 QC 认领；结论回到本样品与来源。',
      fields: [field('factory', '工厂'), field('location', '实际检查地点'), field('contact', '现场联系人', 'text', false), field('due', '预计检查日', 'date')],
      initialValues: { factory: source.kind === 'orderLine' ? state.productions.find(branch => branch.id === source.productionId)?.factory || '' : state.versions.find(version => version.id === source.versionId)?.factory || '', location: sample.location, contact: '', due: today() },
      submitLabel: '发起送检',
      submit: async values => {
        const domain = source.kind === 'orderLine' ? state.orders.find(order => order.id === source.orderId)?.type : state.devs.find(dev => dev.id === source.devId)?.values.category.includes('面料') ? 'fabric' : 'garment';
        const saved = await run({ type: 'fulfillment.qc.request', payload: { source, sampleId: sample.id, domain: domain || 'garment', kind: 'sample', factory: text(values, 'factory'), location: text(values, 'location'), contact: text(values, 'contact'), due: text(values, 'due') } });
        go('qc-workbench', String(saved.result.id || ''), qcTarget);
      } });
  };

  if (editor.spec) return editor.view;

  const balanceLines = (row: LedgerRow) => row.samples.map(sample => <span key={sample.id} className="mist-cell-sub">{sample.form} · <b className="mist-num">{sample.available}</b> {sample.unit} 可用</span>);
  const fabricColumns: Column<LedgerRow>[] = [
    { key: 'archive', header: '面料档案', width: 'minmax(190px,1.6fr)', render: row => <ObjectCell thumb={<Thumb icon={Layers} />} name={row.name} meta={<><Mono>{row.primary.code}</Mono>{row.samples.length > 1 ? ` · ${row.samples.length} 种形态` : ''}</>} />, sortValue: row => row.name },
    { key: 'balance', header: '形态与余额', width: 'minmax(150px,1.2fr)', render: row => <div className="mist-col">{balanceLines(row)}</div> },
    { key: 'source', header: '来源', width: 'minmax(140px,1fr)', hideOnMobile: true, render: row => state ? <span className="mist-cell-sub">{fulfillmentSourceLabel(state, row.primary.source)}</span> : null },
    { key: 'location', header: '位置', width: '110px', hideOnMobile: true, render: row => locationSummary(row) },
    { key: 'status', header: '状态', width: '96px', render: row => { const status = statusOf(row); return <Pill tone={status.tone}>{status.label}</Pill>; } },
  ];
  const pieceColumns: Column<LedgerRow>[] = [
    { key: 'piece', header: shelf === 'garment' ? '实物' : '样品', width: 'minmax(190px,1.6fr)', render: row => <ObjectCell thumb={<Thumb icon={shelf === 'garment' ? Shirt : Package} />} name={row.name} meta={<><Mono>{row.primary.code}</Mono> · {row.primary.form}</>} />, sortValue: row => row.name },
    { key: 'spec', header: '规格', width: '120px', hideOnMobile: true, render: row => [row.primary.size, row.primary.color].filter(Boolean).join(' · ') || '未记录' },
    { key: 'source', header: '来源', width: 'minmax(140px,1fr)', hideOnMobile: true, render: row => state ? <span className="mist-cell-sub">{fulfillmentSourceLabel(state, row.primary.source)}</span> : null },
    { key: 'location', header: '位置', width: '110px', hideOnMobile: true, render: row => row.primary.available > 0 ? locationSummary(row) : '—' },
    { key: 'status', header: '状态', width: '96px', render: row => { const status = statusOf(row); return <Pill tone={status.tone}>{status.label}</Pill>; } },
  ];
  const statusCounts = (key: StatusFilter) => shelfRows.filter(row => key === 'all' || statusOf(row).key === key || (key === 'lent' && statusOf(row).key === 'overdue')).length;

  const detail = selected && state ? <SampleDetail row={selected} state={state} day={day} can={can} locked={locked}
    onMove={movement} onEdit={sample => editor.open(editSpec(sample))} onQc={openSampleQc}
    onAttach={(sample, ids) => run({ type: 'fulfillment.samples.edit', payload: { id: sample.id, location: sample.location, note: sample.note, fileIds: ids } })} />
    : <EmptyState icon={shelf === 'garment' ? Shirt : Layers} title="样品详情" description={loading ? '正在读取样品' : '从列表选择一条样品记录'} compact />;

  return <MistPage>
    <PageHeader eyebrow="订单履约 · 实体样品" title="样品仓库" description={sourceHint || (sourceShipment ? `${sourceShipment.code} · 只处理本票船样，绑定实际工厂分支与送审实物。` : '全公司样品统一台账。面料按档案看各形态余额，成衣逐件管理。')}
      actions={<>
        {sourceShipment && <Button onClick={() => go('shipments', sourceShipment.id, shipmentReturnTarget(state, sourceShipment))}>返回本票出运</Button>}
        {hasShipmentContext && <Button onClick={() => go('samples')}>查看全部样品</Button>}
        {can && !hasShipmentContext && <Button icon={RefreshCw} loading={syncing} disabled={syncing || locked} onClick={() => void synchronize()}>同步已返样版本</Button>}
        <Button icon={Download} disabled={!filtered.length} onClick={() => exportRecords('样品仓库', ['编号', '名称', '来源', '形态', '总量', '可用', '单位', '位置'], filtered.flatMap(row => row.samples).map(sample => [sample.code, sample.name, state ? fulfillmentSourceLabel(state, sample.source) : '', sample.form, sample.quantity, sample.available, sample.unit, fulfillmentPositions(sample).map(position => `${position.location || '位置未记录'} ${position.available}${sample.unit}`).join('；')]))}>导出</Button>
        {can && !invalidShipment && <Button variant="primary" icon={Plus} disabled={locked} onClick={() => editor.open(createSpec)}>新建样品</Button>}
      </>} />
    {!can && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有样品写权限，可以查询台账与流转记录；登记和流转由对应业务员操作。</Banner></div>}
    {syncError && <div className="mist-section"><Banner tone="bad" title="来源实物同步失败">{syncError}</Banner></div>}
    {error && <div className="mist-section"><Banner tone="bad" title="读取失败">{error}</Banner></div>}
    {overdueLoans.length > 0 && <div className="mist-section"><Banner tone="warn" title={`${overdueLoans.length} 笔借出已超过预计归还日`} actions={<Button onClick={() => { const first = overdueLoans[0]; changeShelf(shelfOf(first.sample)); setStatusFilter('overdue'); }}>只看逾期</Button>}>
      {overdueLoans.slice(0, 3).map(({ loan, sample }) => `${sample.name} · ${loan.person} · 应还 ${loan.expectedReturn}`).join('；')}{overdueLoans.length > 3 ? ' …' : ''}</Banner></div>}
    <Tabs value={shelf} onChange={value => changeShelf(value as Shelf)} options={[{ value: 'fabric', label: '面料', count: counts.fabric }, { value: 'garment', label: '成衣', count: counts.garment }, { value: 'other', label: '其他类别', count: counts.other }]} />
    <Toolbar>
      <SearchField value={query} onChange={setQuery} placeholder="搜索档案号、名称、来源或位置" />
      <Dropdown label="形态" value={form} onChange={setForm} options={[{ value: 'all', label: '全部形态' }, ...forms.map(value => ({ value, label: value }))]} />
      <Dropdown label="来源" value={origin} onChange={setOrigin} options={[{ value: 'all', label: '全部来源' }, { value: 'version', label: '开发版本' }, { value: 'orderLine', label: '订单条目' }, { value: 'manual', label: '手工登记' }]} />
    </Toolbar>
    <Pipeline value={statusFilter} onChange={value => setStatusFilter(value as StatusFilter)} items={[
      { value: 'all', label: '全部', count: statusCounts('all'), color: 'var(--mist-ink-2)' },
      { value: 'available', label: shelf === 'fabric' ? '可用' : '在库', count: statusCounts('available'), color: 'var(--mist-ok)' },
      { value: 'lent', label: '借出未还', count: statusCounts('lent'), color: 'var(--mist-warn)' },
      { value: 'overdue', label: '逾期未还', count: statusCounts('overdue'), color: 'var(--mist-bad)' },
      { value: 'empty', label: '已寄出 / 无可用', count: statusCounts('empty'), color: 'var(--mist-ink-3)' },
    ]} />
    <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)} drawerTitle={selected?.name || '样品详情'} drawerSub={selected?.primary.code}
      list={<Card><DataTable ariaLabel="样品台账" loading={loading} rows={visible} rowKey={row => row.id} selectedKey={selected?.id} density="comfy" onRowClick={pick}
        columns={shelf === 'fabric' ? fabricColumns : pieceColumns}
        empty={shelfRows.length ? <EmptyState icon={SearchX} title="没有符合条件的样品" description="换个关键词或清除筛选。" action={<TextLink onClick={() => { setQuery(''); setForm('all'); setOrigin('all'); setStatusFilter('all'); }}>清除筛选</TextLink>} />
          : <EmptyState icon={shelf === 'garment' ? Shirt : Layers} title={hasShipmentContext ? '本票还没有船样' : '还没有样品档案'} description={can ? '收到实物后在这里登记；开发返样可用“同步已返样版本”自动建档。' : '业务员登记样品后会显示在这里。'} action={can && !invalidShipment ? <Button icon={Plus} onClick={() => editor.open(createSpec)}>新建样品</Button> : undefined} />}
        footer={pages > 1 ? <Pagination page={currentPage} pages={pages} onChange={setPage} /> : undefined} /></Card>}
      detail={detail} />
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage>;
}

function SampleDetail({ row, state, day, can, locked, onMove, onEdit, onQc, onAttach }: {
  row: LedgerRow; state: MistState; day: string; can: boolean; locked: boolean;
  onMove: (sample: FulfillmentSample, kind: MoveKind) => void; onEdit: (sample: FulfillmentSample) => void; onQc: (sample: FulfillmentSample) => void; onAttach: (sample: FulfillmentSample, ids: string[]) => Promise<unknown>;
}) {
  const { go } = useNav();
  const primary = row.primary, status = rowStatus(state, row, day);
  const shipment = state.fulfillment.shipments.find(item => item.id === primary.shipmentId);
  const events = row.samples.flatMap(sample => state.fulfillment.sampleMovements.filter(movement => movement.sampleId === sample.id).map(movement => ({ movement, sample })))
    .sort((a, b) => b.movement.at.localeCompare(a.movement.at));
  const why = (sample: FulfillmentSample, kind: MoveKind): string | false => {
    if (!can) return '没有样品写权限';
    const facts = sampleFacts(state, sample, day);
    if (kind === 'return') return facts.openLoans.length ? false : '没有未归还的借出';
    return sample.available > 0 ? false : '当前没有可用数量';
  };
  return <DetailBody data-sample-detail={row.id} heading={<div>
      <span className="mist-mono mist-muted">{row.samples.map(sample => sample.code).join(' · ')}</span>
      <div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{row.name}</div>
    </div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill>{primary.category}</Pill><Pill tone={status.tone}>{status.label}</Pill>{primary.role && <Pill tone="accent">{fulfillmentSampleRoleLabel(primary.role)}</Pill>}</div>
    <Facts items={[
      { label: '来源', value: <SourceLink source={primary.source} /> },
      { label: row.shelf === 'fabric' ? '形态数' : '规格', value: row.shelf === 'fabric' ? `${row.samples.length} 种` : [primary.size, primary.color].filter(Boolean).join(' · ') || '未记录' },
      ...(shipment ? [{ label: '出运批次', value: <Mono>{shipment.code}</Mono> }] : []),
      { label: '登记', value: shortWhen(primary.createdAt) },
    ]} />
    <DetailBlock title={row.shelf === 'fabric' ? '形态与余额' : '数量与位置'}>
      {row.samples.map(sample => { const facts = sampleFacts(state, sample, day); return <div key={sample.id} className="mist-col" data-sample-form={sample.id}>
        <div className="mist-row"><b>{sample.form}</b><span className="mist-spacer" /><span className="mist-num">{sample.available} / {sample.quantity} {sample.unit}</span></div>
        <span className="mist-note">可用 {sample.available} {sample.unit} · 借出未还 {facts.lent} {sample.unit} · {sample.available > 0 ? (fulfillmentPositions(sample).length > 1 ? '多个位置' : sample.location || '位置未记录') : '无在库位置'}</span>
        {facts.overdue.map(loan => <span key={loan.id} className="mist-note"><Icon icon={Undo2} size="xs" />{loan.person} 应于 {loan.expectedReturn} 归还，已逾期</span>)}
        <PositionSummary row={sample} />
        <ActionBar busy={locked} actions={[
          { label: '借出', icon: ArrowLeftRight, onClick: () => onMove(sample, 'lend'), reason: why(sample, 'lend') },
          { label: '寄出', icon: Send, onClick: () => onMove(sample, 'send'), reason: why(sample, 'send') },
          { label: '归还', icon: Undo2, onClick: () => onMove(sample, 'return'), reason: why(sample, 'return') },
          { label: '移位', onClick: () => onMove(sample, 'move'), reason: why(sample, 'move') },
        ]} />
      </div>; })}
    </DetailBlock>
    <div className="mist-row mist-module-actions">
      {can && <Button icon={Pencil} disabled={locked} onClick={() => onEdit(primary)}>编辑资料</Button>}
      {primary.source.kind !== 'manual' && <Button onClick={() => onQc(primary)}>查看 / 发起本样品QC</Button>}
    </div>
    {primary.note && <p className="mist-sub">{primary.note}</p>}
    <DetailBlock title="实物照片与附件">
      <RecordFiles key={primary.id} ids={primary.fileIds} onAttach={can ? ids => onAttach(primary, ids) : undefined} />
      {row.samples.slice(1).filter(sample => sample.fileIds.length).map(sample => <RecordFiles key={sample.id} ids={sample.fileIds} />)}
    </DetailBlock>
    <DetailBlock title="流转记录">
      {events.length ? <Timeline events={events.map(({ movement, sample }) => { const line = `${MOVE_LABEL[movement.kind]}${row.samples.length > 1 ? ' · ' + sample.form : ''}${movement.quantity ? ` ${movement.quantity}${sample.unit}` : ''}${movement.person ? ' · ' + movement.person : ''}${movement.location ? ' · ' + movement.location : ''}${movement.expectedReturn ? ` · 预计 ${movement.expectedReturn} 归还` : ''}${movement.note ? ' · ' + movement.note : ''}`, link = movement.development; return ({ who: movement.actor, when: new Date(movement.at).toLocaleString(), text: link ? <>{line} <TextLink onClick={() => go('development/detail', link.devId, { versionId: link.versionId })}>查看开发案 {state.devs.find(dev => dev.id === link.devId)?.code || ''}</TextLink></> : line }); })} />
        : <span className="mist-note">还没有流转记录</span>}
    </DetailBlock>
  </DetailBody>;
}
