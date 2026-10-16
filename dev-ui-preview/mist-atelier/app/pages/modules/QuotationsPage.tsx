/** 报价管理：成衣 / 面料两个板块分开；阶段流水线 + 报价单详情（版本链、审批、发送与客户反馈、转订单）。所有对外事实都登记真实依据。 */
import React from 'react';
import { Ban, CheckCircle2, CopyPlus, Download, FileText, Printer, Pencil, Plus, SearchX, Send, ShoppingBag, ThumbsDown, ThumbsUp, TimerOff, Undo2 } from 'lucide-react';
import { Banner, Button, Card, Checklist, DataTable, Dropdown, EmptyState, Facts, MistPage, Mono, ObjectCell, PageHeader, Pill, Pipeline, SearchField, Segmented, Timeline, Toolbar, type Column, type Tone } from '../../../../../components/mist';
import type { MistState } from '../../../../../server/src/shared/mistWorkspace';
import { developmentDomain } from '../../../../../server/src/shared/mistDevelopmentDomain';
import { marketBusinessDate, quotationConversionBlockerText, quotationConversionBlockers, quotationNeedsApproval, quoteLineFamily, quotationVersions, type MarketQuotation } from '../../../../../server/src/shared/mistMarket';
import { quoteMoqStatus, quoteSpecItems } from '../../../../../server/src/shared/mistQuotationSpecs';
import { lineBelowMarginFloor } from '../../../../../server/src/shared/mistQuotationMarginFloor';
import { quotationConversionComplete, quotationConversionProgress, quotationConversionStarted, quotationConvertedOrders, quotationPendingLines, quoteLineConversionStatus, quoteLineConversionText } from '../../../../../server/src/shared/mistQuotationLineConversion';
import { quotationDocumentBlocker, quotationDocuments, quotationFormalDocumentBlocker } from '../../../../../server/src/shared/mistQuotationDocument';
import { apiService } from '../../../../../services/apiService';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { ModuleEditorDialog, downloadModuleCsv, type ModuleEditorSpec } from './ModuleWorkbench';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen } from './pageKit';

export type QuoteDomain = 'garment' | 'fabric';
export type QuoteStage = 'draft' | 'pending' | 'sent' | 'accepted' | 'closed' | 'converted';
type StageFilter = 'all' | QuoteStage;
type FlagFilter = 'all' | 'expiring' | 'overdue' | 'belowCost' | 'superseded';

export const QUOTE_STAGE_LABEL: Record<QuoteStage, string> = { draft: '草稿', pending: '待审批', sent: '已发送', accepted: '客户接受', closed: '未接受 / 已失效', converted: '已转单' };
const STAGE_TONE: Record<QuoteStage, Tone> = { draft: 'neutral', pending: 'warn', sent: 'accent', accepted: 'ok', closed: 'neutral', converted: 'ok' };
const NEAR_DAYS = 7;

/** 报价所属板块：按条目引用的产品档案或开发案判断；面料条目优先归入面料板块。 */
export function quotationDomain(state: MistState | null, q: MarketQuotation): QuoteDomain {
  for (const line of q.lines) {
    const product = state?.market.products.find(p => p.id === line.productId);
    if (product?.category === 'fabric') return 'fabric';
    if (!product && line.sourceDevId) { const dev = state?.devs.find(d => d.id === line.sourceDevId); if (dev && developmentDomain(dev.values) === 'fabric') return 'fabric'; }
  }
  return 'garment';
}
export function quotationStage(q: MarketQuotation): QuoteStage {
  if (quotationConversionComplete(q)) return 'converted';
  if (q.status === 'Accepted') return 'accepted';
  if (q.status === 'Sent') return 'sent';
  if (q.status === 'Rejected' || q.status === 'Expired') return 'closed';
  return q.approval?.status === 'pending' ? 'pending' : 'draft';
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
export function quotationFlags(all: MarketQuotation[], q: MarketQuotation, day: string) {
  const stage = quotationStage(q), flags: Array<{ key: Exclude<FlagFilter, 'all'> | 'returned'; label: string; tone: Tone }> = [];
  const open = stage === 'draft' || stage === 'pending' || stage === 'sent';
  if (open && q.validUntil < day) flags.push({ key: 'overdue', label: '已过有效期', tone: 'bad' });
  else if (open && daysBetween(day, q.validUntil) <= NEAR_DAYS) flags.push({ key: 'expiring', label: `${daysBetween(day, q.validUntil)} 天后到期`, tone: 'warn' });
  if ((stage === 'draft' || stage === 'pending') && quotationNeedsApproval(q) && q.approval?.status !== 'approved') flags.push({ key: 'belowCost', label: '低于成本或成本待核', tone: 'warn' });
  if (q.approval?.status === 'rejected' && stage === 'draft') flags.push({ key: 'returned', label: '审批退回', tone: 'bad' });
  const next = all.find(x => x.previousId === q.id);
  if (next) flags.push({ key: 'superseded', label: `已有新版本 ${next.code}`, tone: 'neutral' });
  return flags;
}
const margin = (price: string, cost: string) => { const p = Number(price), c = Number(cost); return cost && p > 0 && Number.isFinite(c) ? Math.round((p - c) / p * 1000) / 10 : null; };
const version = (q: MarketQuotation) => 'V' + (q.revision || 1);
export const quotationStageLabel = (q: MarketQuotation) => { const s = quotationStage(q); return s === 'closed' ? (q.status === 'Expired' ? '已失效' : '客户未接受') : QUOTE_STAGE_LABEL[s]; };

export type QuotationWorkbenchProps = {
  onCreate: () => void;
  onEdit: (q: MarketQuotation) => void;
  onRevise: (q: MarketQuotation) => void;
  attachments: (q: MarketQuotation, locked: boolean) => React.ReactNode;
  history: (id: string) => React.ReactNode;
};

export function QuotationWorkbench({ onCreate, onEdit, onRevise, attachments, history }: QuotationWorkbenchProps) {
  const { state, run, error, refresh, loading, saving, pending, downloadFile, fileUrl } = useMistWorkspace(), session = useMistSession(), { go, route } = useNav();
  const [domainChoice, setDomainChoice] = React.useState<QuoteDomain | null>(null), [stageFilter, setStageFilter] = React.useState<StageFilter>('all'), [flagFilter, setFlagFilter] = React.useState<FlagFilter>('all'), [query, setQuery] = React.useState('');
  const [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(!!route.id);
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null), [failure, setFailure] = useRouteDraft('');
  React.useEffect(() => { if (route.id) { setPicked(route.id); setDomainChoice(null); } }, [route.id]);
  const day = marketBusinessDate(new Date());
  const all = state?.market.quotations || [];
  const customerName = (id: string) => state?.customers.find(c => c.id === id)?.name || '未知客户';
  const routed = all.find(q => q.id === route.id);
  const domainOf = (q: MarketQuotation) => quotationDomain(state, q);
  const domain: QuoteDomain = domainChoice || (routed ? domainOf(routed) : all.some(q => domainOf(q) === 'garment') || !all.some(q => domainOf(q) === 'fabric') ? 'garment' : 'fabric');
  const domainRows = all.filter(q => domainOf(q) === domain);
  const needle = query.trim().toLowerCase();
  const searched = domainRows.filter(q => (!needle || `${q.code} ${customerName(q.customerId)} ${q.season} ${q.deliveryTerms} ${q.lines.map(l => l.name + ' ' + l.style).join(' ')}`.toLowerCase().includes(needle)) && (flagFilter === 'all' || quotationFlags(all, q, day).some(f => f.key === flagFilter)));
  const stageCount = (s: StageFilter) => searched.filter(q => s === 'all' || quotationStage(q) === s).length;
  const order: QuoteStage[] = ['pending', 'draft', 'sent', 'accepted', 'converted', 'closed'];
  const rows = searched.filter(q => stageFilter === 'all' || quotationStage(q) === stageFilter)
    .sort((a, b) => order.indexOf(quotationStage(a)) - order.indexOf(quotationStage(b)) || a.validUntil.localeCompare(b.validUntil) || a.code.localeCompare(b.code));
  const selected = rows.find(q => q.id === picked) || (picked ? domainRows.find(q => q.id === picked) : undefined);
  const can = session.hasPermission('quotations:write'), canOrder = session.hasPermission('orders:write'), canApprove = session.hasPermission('approvals:write'), me = session.user?.id || '';
  const locked = saving || !!pending;
  const pick = (q: MarketQuotation) => { setPicked(q.id); setDrawer(true); const { view, id: _id, ...target } = route; go(view, q.id, target); };
  const changeDomain = (value: QuoteDomain) => { setDomainChoice(value); setStageFilter('all'); setPicked(null); };
  const act = async (work: () => Promise<unknown>) => { setFailure(''); try { await work(); } catch (e) { setFailure(e instanceof Error ? e.message : String(e)); } };
  const evidenceSpec = (q: MarketQuotation, next: MarketQuotation['status']): ModuleEditorSpec => ({
    title: next === 'Sent' ? `登记 ${q.code} 已发送给客户` : next === 'Accepted' ? `登记客户接受 ${q.code}` : next === 'Rejected' ? `登记客户未接受 ${q.code}` : `标记 ${q.code} 已失效`,
    submitLabel: '登记',
    initialValues: { evidence: '' },
    fields: [{ key: 'evidence', label: next === 'Sent' ? '发送方式与对象' : '客户反馈或依据', type: 'textarea', required: true, hint: '登记已经发生的事实与来源，例如邮件、会议纪要；此操作不会代为发送邮件。' }],
    submit: v => run({ type: 'market.quotation.status', payload: { id: q.id, status: next, evidence: String(v.evidence ?? '') } }),
  });
  const decideSpec = (q: MarketQuotation, decision: 'approved' | 'rejected'): ModuleEditorSpec => ({
    title: decision === 'approved' ? `批准报价 ${q.code}` : `退回报价 ${q.code}`, submitLabel: decision === 'approved' ? '批准' : '退回',
    initialValues: { note: '' }, fields: [{ key: 'note', label: '审批意见', type: 'textarea', required: true }],
    submit: v => run({ type: 'market.quotation.decide', payload: { id: q.id, decision, note: String(v.note ?? '') } }),
  });
  /** BB-QUO-5 按条目转单：只列未处理条目；未获认可的开发版本条目不可勾选。 */
  const lineChoices = (q: MarketQuotation) => {
    const blocked = state ? quotationConversionBlockers(state, { lines: quotationPendingLines(q) }) : [];
    return quotationPendingLines(q).map(l => {
      const b = blocked.find(x => x.lineId === l.id), family = state?.market ? quoteLineFamily(state, state.market, l) : undefined;
      return { line: l, family, blocked: b ? quotationConversionBlockerText(b) : '' };
    });
  };
  const checkedLines = (v: Record<string, unknown>) => Object.keys(v).filter(k => k.startsWith('line:') && v[k]).map(k => k.slice(5));
  const convertSpec = (q: MarketQuotation): ModuleEditorSpec => {
    const choices = lineChoices(q), domain = domainOf(q);
    return {
      title: `从 ${q.code} 创建订单`, submitLabel: '创建订单草稿',
      description: '只使用客户已接受的这一版报价；勾选本次转单的条目（须同一板块），数量、单位与单价原样带入订单草稿。未勾选的条目之后可再转另一张订单，或标记不再转。',
      initialValues: { type: domain, due: '', owner: state?.settings.profileName || session.user?.displayName || '', ...Object.fromEntries(choices.map(c => ['line:' + c.line.id, !c.blocked && (!c.family || c.family === domain)])) },
      fields: [
        ...choices.map(c => ({ key: 'line:' + c.line.id, label: `转入：${c.line.name} · ${c.line.qty} ${c.line.unit} × ${c.line.price}`, type: 'checkbox' as const, readonly: !!c.blocked, hint: c.blocked || (c.family ? (c.family === 'fabric' ? '面料条目' : '成衣条目') : undefined) })),
        { key: 'type', label: '订单类型', type: 'select', required: true, options: [{ value: 'garment', label: '成衣订单' }, { value: 'fabric', label: '面料订单' }] },
        { key: 'due', label: '本次订单交期', type: 'date', required: true },
        { key: 'owner', label: '业务负责人', required: true },
      ],
      submit: async v => { const lineIds = checkedLines(v); if (!lineIds.length) throw new Error('请至少勾选一个条目'); const r = await run({ type: 'market.quotation.convert', payload: { id: q.id, type: v.type as QuoteDomain, due: String(v.due ?? ''), owner: String(v.owner ?? ''), lineIds } }); go('orders/detail', String((r.result as { orderId?: string }).orderId)); },
    };
  };
  const skipSpec = (q: MarketQuotation): ModuleEditorSpec => ({
    title: `${q.code} 条目标记不再转`, submitLabel: '标记不再转',
    description: '客户只接受部分条目时，把不再转单的条目标记出来并写明原因；标记后不能再转单，全部条目处理完报价显示“已转单”。',
    initialValues: { reason: '', ...Object.fromEntries(quotationPendingLines(q).map(l => ['line:' + l.id, false])) },
    fields: [
      ...quotationPendingLines(q).map(l => ({ key: 'line:' + l.id, label: `不再转：${l.name} · ${l.qty} ${l.unit}`, type: 'checkbox' as const })),
      { key: 'reason', label: '不再转原因', type: 'textarea', required: true, hint: '例如客户取消该色、改由其它报价下单。' },
    ],
    submit: async v => { const lineIds = checkedLines(v); if (!lineIds.length) throw new Error('请至少勾选一个条目'); await run({ type: 'market.quotation.skipLines', payload: { id: q.id, lineIds, reason: String(v.reason ?? '') } }); },
  });
  const generateDocument = (q: MarketQuotation, draft: boolean) => void act(() => run({ type: 'market.quotation.document', payload: { id: q.id, draft } }));
  const docFile = (fileId: string) => state?.files.find(f => f.id === fileId);
  const downloadDocument = (fileId: string) => { const file = docFile(fileId); if (!file) { setFailure('报价单文件不可用或无权读取'); return; } void act(() => downloadFile(file)); };
  /** 重新打印：取归档原件，在新窗口用浏览器 PDF 预览打开后打印；不重新生成。 */
  const printDocument = (fileId: string) => {
    const file = docFile(fileId); if (!file) { setFailure('报价单文件不可用或无权读取'); return; }
    const win = window.open('', '_blank');
    void act(async () => {
      const response = await fetch(fileUrl(file), { headers: apiService.getAuthHeaders(), credentials: 'include' });
      if (!response.ok) { win?.close(); throw new Error('报价单文件读取失败'); }
      const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'application/pdf' }));
      if (win) win.location.href = url; else window.open(url, '_blank');
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  };
  const exportQuote = (q: MarketQuotation) => downloadModuleCsv(`${q.code}.csv`, ['产品', '款号 / 编码', '规格', '数量', '单位', '单价', '金额', '币种'], q.lines.map(l => [l.name, l.style, l.specification, l.qty, l.unit, l.price, l.amount, q.currency]));
  const columns: Column<MarketQuotation>[] = [
    { key: 'code', header: '报价 / 客户', width: 'minmax(150px,1.1fr)', render: q => <ObjectCell name={<><Mono>{q.code.replace(/-V\d+$/, '')}</Mono> <Pill tone={q.revision ? 'accent' : 'neutral'}>{version(q)}</Pill></>} meta={customerName(q.customerId)} /> },
    { key: 'lines', header: '条目', width: 'minmax(110px,1fr)', hideOnMobile: true, render: q => <span className="mist-col" style={{ gap: 2 }}><span>{q.lines[0]?.name || '—'}</span><small className="mist-muted">{q.lines.length > 1 ? `等 ${q.lines.length} 项` : q.lines[0] ? `${q.lines[0].qty} ${q.lines[0].unit}` : ''}</small></span> },
    { key: 'total', header: '金额 / 术语', width: '118px', align: 'right', render: q => <span className="mist-col" style={{ gap: 2, alignItems: 'flex-end' }}><span className="mist-num" style={{ whiteSpace: 'nowrap' }}>{q.currency} {q.total}</span><small className="mist-muted">{q.deliveryTerms}</small></span> },
    { key: 'valid', header: '有效期', width: '96px', render: q => { const f = quotationFlags(all, q, day).find(x => x.key === 'overdue' || x.key === 'expiring'); return <span className="mist-col" style={{ gap: 2 }}><span className="mist-num">{q.validUntil}</span>{f && <small className={f.tone === 'bad' ? 'mist-tone-bad' : 'mist-tone-warn'}>{f.label}</small>}</span>; } },
    { key: 'stage', header: '状态', width: '92px', render: q => { const s = quotationStage(q), superseded = all.some(x => x.previousId === q.id); return <span className="mist-col" style={{ gap: 2, alignItems: 'flex-start' }}><Pill tone={STAGE_TONE[s]}>{quotationStageLabel(q)}</Pill>{superseded && <small className="mist-muted">已出新版本</small>}</span>; } },
  ];
  const empty = domainRows.length
    ? <EmptyState icon={SearchX} title="没有符合条件的报价" description="换个关键词或清除筛选。" action={<Button onClick={() => { setQuery(''); setStageFilter('all'); setFlagFilter('all'); }}>清除筛选</Button>} />
    : <EmptyState icon={FileText} title={`还没有${domain === 'fabric' ? '面料' : '成衣'}报价`} description={domain === 'fabric' ? '面料报价按 米 / 码 / 公斤 计价，从数字档案的面料或面料开发版本选择条目。' : '成衣报价按 件 / 套 计价，从数字档案或准确开发版本选择条目。'} action={can ? <Button icon={Plus} onClick={onCreate}>新建报价</Button> : undefined} />;
  const detail = selected && state
    ? <QuotationDetail q={selected} state={state} all={all} day={day} me={me} can={can} canOrder={canOrder} canApprove={canApprove} locked={locked} customer={customerName(selected.customerId)}
        onEdit={() => onEdit(selected)} onRevise={() => onRevise(selected)} onSubmit={() => void act(() => run({ type: 'market.quotation.submit', payload: { id: selected.id } }))}
        onDecide={d => setDialog(decideSpec(selected, d))} onStatus={s => setDialog(evidenceSpec(selected, s))} onConvert={() => setDialog(convertSpec(selected))} onSkip={() => setDialog(skipSpec(selected))} onDocument={draft => generateDocument(selected, draft)} onDownloadDocument={downloadDocument} onPrintDocument={printDocument}
        onExport={() => exportQuote(selected)} onOpen={(view, id, extra) => go(view, id, extra)} attachments={attachments(selected, !can || selected.status !== 'Draft' || selected.approval?.status === 'pending')} history={history(selected.id)} />
    : <EmptyState icon={FileText} title="报价单详情" description="从左侧列表选择一份报价，查看条目、版本、审批与客户反馈。" compact />;
  return <MistPage>
    <PageHeader eyebrow="订单履约 · 报价" title="报价管理" description="按客户接受的版本转订单；改价或续期另出新版本，旧版本保留。"
      actions={<>
        <Button icon={Download} onClick={() => downloadModuleCsv('报价台账.csv', ['报价号', '版本', '客户', '板块', '币种', '金额', '贸易术语', '付款条件', '有效期', '状态'], rows.map(q => [q.code, version(q), customerName(q.customerId), domainOf(q) === 'fabric' ? '面料' : '成衣', q.currency, q.total, q.deliveryTerms, q.paymentTerms, q.validUntil, quotationStageLabel(q)]))}>导出</Button>
        {can && <Button variant="primary" icon={Plus} disabled={locked} onClick={onCreate}>新建报价</Button>}
      </>} />
    {!can && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有报价写权限，可以查看报价单、版本与审批记录。</Banner></div>}
    {(error || failure) && <div className="mist-section"><Banner tone="bad" title="报价操作未完成" actions={error ? <Button onClick={() => void refresh()}>重试</Button> : undefined}>{failure || error}</Banner></div>}
    <div className="mist-section"><Segmented<QuoteDomain> ariaLabel="业务板块" value={domain} onChange={changeDomain} options={[{ value: 'garment', label: `成衣业务 · ${all.filter(q => domainOf(q) === 'garment').length}` }, { value: 'fabric', label: `面料业务 · ${all.filter(q => domainOf(q) === 'fabric').length}` }]} /></div>
    <Toolbar>
      <SearchField value={query} onChange={setQuery} placeholder="搜索报价号、客户、款号或季节" />
      <Dropdown<FlagFilter> label="提醒" value={flagFilter} onChange={setFlagFilter} options={[{ value: 'all', label: '全部' }, { value: 'expiring', label: `${NEAR_DAYS} 天内到期` }, { value: 'overdue', label: '已过有效期' }, { value: 'belowCost', label: '低于成本或成本待核' }, { value: 'superseded', label: '已有新版本' }]} />
    </Toolbar>
    <Pipeline<StageFilter> value={stageFilter} onChange={setStageFilter} items={[
      { value: 'all', label: '全部', count: stageCount('all'), color: 'var(--mist-ink-2)' },
      { value: 'draft', label: '草稿', count: stageCount('draft'), color: 'var(--mist-ink-3)' },
      { value: 'pending', label: '待审批', count: stageCount('pending'), color: 'var(--mist-warn)' },
      { value: 'sent', label: '已发送', count: stageCount('sent'), color: 'var(--mist-accent)' },
      { value: 'accepted', label: '客户接受', count: stageCount('accepted'), color: 'var(--mist-ok)' },
      { value: 'converted', label: '已转单', count: stageCount('converted'), color: 'var(--mist-ok)' },
      { value: 'closed', label: '未接受 / 已失效', count: stageCount('closed'), color: 'var(--mist-ink-3)' },
    ]} />
    <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)} drawerTitle={selected ? `${selected.code} · ${customerName(selected.customerId)}` : '报价单详情'} drawerSub={selected ? `${selected.currency} ${selected.total}` : undefined}
      list={<Card><DataTable ariaLabel={`${domain === 'fabric' ? '面料' : '成衣'}报价列表`} loading={loading} rows={rows} rowKey={q => q.id} selectedKey={selected?.id} density="comfy" onRowClick={pick} columns={columns} empty={empty} /></Card>}
      detail={detail} />
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage>;
}

function QuotationDetail({ q, state, all, day, me, can, canOrder, canApprove, locked, customer, onEdit, onRevise, onSubmit, onDecide, onStatus, onConvert, onSkip, onDocument, onDownloadDocument, onPrintDocument, onExport, onOpen, attachments, history }: {
  q: MarketQuotation; state: MistState; all: MarketQuotation[]; day: string; me: string; can: boolean; canOrder: boolean; canApprove: boolean; locked: boolean; customer: string;
  onEdit: () => void; onRevise: () => void; onSubmit: () => void; onDecide: (d: 'approved' | 'rejected') => void; onStatus: (s: MarketQuotation['status']) => void; onConvert: () => void; onSkip: () => void; onExport: () => void;
  onDocument: (draft: boolean) => void; onDownloadDocument: (fileId: string) => void; onPrintDocument: (fileId: string) => void;
  onOpen: (view: string, id?: string, extra?: Record<string, string | undefined>) => void; attachments: React.ReactNode; history: React.ReactNode;
}) {
  const stage = quotationStage(q), flags = quotationFlags(all, q, day), versions = quotationVersions(state.market, q), next = all.find(x => x.previousId === q.id);
  const needsApproval = quotationNeedsApproval(q), approved = q.approval?.status === 'approved', expired = q.validUntil < day;
  const writeReason = !can ? '没有报价写权限' : false;
  const sendReason = writeReason || (q.approval?.status === 'pending' ? '审批中，等待业务负责人决定' : needsApproval && !approved ? '低于成本、低于最低毛利率或成本待核，须先取得业务审批' : expired ? '已过有效期，请修改有效期后再发送' : false);
  const reviewer = q.approval?.status === 'pending' && q.approval.reviewerId === me;
  const pending = quotationPendingLines(q), started = quotationConversionStarted(q), progress = quotationConversionProgress(q), orders = quotationConvertedOrders(q, state.orders);
  const blockers = stage === 'accepted' ? quotationConversionBlockers(state, { lines: pending }) : [];
  const allBlocked = blockers.length > 0 && blockers.length >= pending.length;
  const convertReason = !canOrder ? '没有订单写权限' : allBlocked ? `${quotationConversionBlockerText(blockers[0])}${blockers.length > 1 ? `，另有 ${blockers.length - 1} 个条目同样未认可` : ''}` : false;
  const decideReason = !canApprove ? '没有审批权限' : !reviewer ? '仅本次指定的业务审批人可决定，可在审批中心处理' : false;
  const docBase = writeReason || quotationDocumentBlocker({ issuer: state.settings.companyProfile, customerFound: state.customers.some(c => c.id === q.customerId), lineCount: q.lines.length }) || false;
  const formalDocReason = docBase || quotationFormalDocumentBlocker(q, needsApproval) || false;
  const documents = quotationDocuments(q);
  const reviseReason = writeReason || (next ? `已有新版本 ${next.code}，请在最新版本上修改` : q.convertedOrderId ? '已转订单的报价不再出新版本' : false);
  const banner: { tone: Tone; title: string; text: string } =
    stage === 'pending' ? { tone: 'warn', title: '待业务审批', text: `${shortWhen(q.approval!.submittedAt)} 提交；审批通过前不能发送给客户。` }
    : stage === 'draft' ? (q.approval?.status === 'rejected' ? { tone: 'bad', title: '审批已退回', text: `意见：${q.approval.note || '—'}。修订草稿后可重新提交。` }
      : needsApproval && !approved ? { tone: 'warn', title: '草稿 · 须先审批', text: '有条目低于成本、低于最低毛利率或成本待核实，提交业务审批并通过后才能发送。' }
      : { tone: 'neutral', title: approved ? '草稿 · 审批已通过' : '草稿', text: '核对条目与条款后发送给客户，再在此登记发送方式与对象。' })
    : stage === 'sent' ? { tone: expired ? 'bad' : 'accent', title: expired ? '已过有效期 · 待处理' : '已发送 · 等待客户反馈', text: expired ? '客户仍有意向时请新建版本续期；否则标记为已失效。' : `有效期至 ${q.validUntil}。客户回复后登记接受或未接受。` }
    : stage === 'accepted' ? (started ? { tone: 'accent', title: `部分已转订单 · ${pending.length} 个条目待处理`, text: `${progress.text}。未转条目可再转另一张订单，或标记不再转并写明原因。` } : { tone: 'ok', title: '客户已接受 · 待转订单', text: '勾选本次转单的条目，核对交期与负责人后转为订单草稿，条目单位与单价原样带入。' })
    : stage === 'converted' ? { tone: 'ok', title: '已转订单', text: `全部条目已处理（${progress.text}），报价不再修改。` }
    : { tone: 'neutral', title: q.status === 'Expired' ? '已失效' : '客户未接受', text: next ? `已基于此报价出新版本 ${next.code}。` : '客户如重新询价，可基于此报价新建版本。' };
  const track = [
    { label: '保存草稿', done: true, note: shortWhen(q.createdAt) },
    { label: '业务审批', done: approved || (!needsApproval && stage !== 'draft' && stage !== 'pending'), note: q.approval ? `${q.approval.status === 'approved' ? '已批准' : q.approval.status === 'rejected' ? '已退回' : '审批中'} · ${shortWhen(q.approval.decidedAt || q.approval.submittedAt)}` : needsApproval ? '须审批' : '无需审批', noteTone: q.approval?.status === 'rejected' ? 'bad' as const : undefined },
    { label: '发送给客户', done: !!q.deliveryEvidence, note: q.deliveryEvidence || '未登记' },
    { label: '客户反馈', done: !!q.responseEvidence, note: q.responseEvidence || '未登记', noteTone: q.status === 'Rejected' || q.status === 'Expired' ? 'bad' as const : undefined },
    { label: '转订单', done: stage === 'converted', note: orders.length ? `${orders.map(o => o.code || '订单不可用').join('、')}${pending.length ? ` · ${pending.length} 个条目待处理` : ''}` : q.status === 'Accepted' ? '待转单' : '—' },
  ];
  return <DetailBody data-quotation-detail={q.id} heading={<div><span className="mist-mono mist-muted">{q.code}</span><div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{customer}</div></div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}>
      <Pill tone={STAGE_TONE[stage]}>{quotationStageLabel(q)}</Pill>
      <Pill tone="accent">{version(q)}</Pill>
      <Pill>{quotationDomain(state, q) === 'fabric' ? '面料业务' : '成衣业务'}</Pill>
      {flags.filter(f => f.key !== 'returned' && f.key !== 'superseded').map(f => <Pill key={f.key} tone={f.tone}>{f.label}</Pill>)}
    </div>
    <Banner tone={banner.tone} title={banner.title}>{banner.text}</Banner>
    {blockers.length > 0 && <Banner tone="warn" title={allBlocked ? '开发版本未获需求方认可 · 暂不能转订单' : '部分条目的开发版本未获需求方认可 · 这些条目暂不能转'}><span data-convert-blockers>{blockers.map(b => <span key={b.lineId} style={{ display: 'block' }}>{quotationConversionBlockerText(b)}</span>)}请先在开发模块记录需求方认可后再转单；产品档案条目不受此限制。</span></Banner>}
    <ActionBar busy={locked} actions={[
      { label: '编辑草稿', icon: Pencil, onClick: onEdit, reason: writeReason, hidden: stage !== 'draft' },
      { label: '提交业务审批', icon: Send, onClick: onSubmit, primary: needsApproval && !approved, reason: writeReason, hidden: stage !== 'draft' || approved },
      { label: '批准', icon: CheckCircle2, onClick: () => onDecide('approved'), primary: true, reason: decideReason, hidden: stage !== 'pending' },
      { label: '退回修改', icon: Undo2, onClick: () => onDecide('rejected'), reason: decideReason, hidden: stage !== 'pending' },
      { label: '登记已发送', icon: Send, onClick: () => onStatus('Sent'), primary: !needsApproval || approved, reason: sendReason, hidden: stage !== 'draft' },
      { label: '客户接受', icon: ThumbsUp, onClick: () => onStatus('Accepted'), primary: true, reason: writeReason, hidden: stage !== 'sent' },
      { label: '客户未接受', icon: ThumbsDown, onClick: () => onStatus('Rejected'), reason: writeReason, hidden: stage !== 'sent' },
      { label: '标记已失效', icon: TimerOff, onClick: () => onStatus('Expired'), reason: writeReason || (!expired ? `有效期至 ${q.validUntil}，到期后才能标记` : false), hidden: stage !== 'sent' },
      { label: started ? '转剩余条目' : '核对并转订单', icon: ShoppingBag, onClick: onConvert, primary: true, reason: convertReason, hidden: stage !== 'accepted' },
      { label: '标记条目不再转', icon: Ban, onClick: onSkip, reason: !canOrder ? '没有订单写权限' : false, hidden: stage !== 'accepted' },
      { label: orders.length > 1 ? `打开订单 ${orders[0].code}` : '打开订单', icon: ShoppingBag, onClick: () => onOpen('orders/detail', orders[0].id), primary: stage === 'converted', hidden: !orders.length },
      { label: '新建版本', icon: CopyPlus, onClick: onRevise, reason: reviseReason, hidden: stage === 'draft' || stage === 'pending' || stage === 'converted' },
      { label: '生成正式报价单', icon: FileText, onClick: () => onDocument(false), reason: formalDocReason },
      { label: '生成草稿水印版', icon: FileText, onClick: () => onDocument(true), reason: docBase },
      { label: '导出条目', icon: Download, onClick: onExport },
    ]} />
    <Facts items={[
      { label: '金额', value: <span className="mist-num">{q.currency} {q.total}</span> },
      { label: '有效期', value: <span className={flags.some(f => f.key === 'overdue') ? 'mist-tone-bad' : undefined}>{q.validUntil}</span> },
      { label: '贸易术语', value: q.deliveryTerms },
      { label: '付款条件', value: q.paymentTerms },
      { label: '季节', value: q.season || '未填' },
      { label: '条目', value: `${q.lines.length} 项` },
    ]} />
    {q.note && <p className="mist-sub">{q.note}</p>}
    <DetailBlock title="报价条目">
      <div className="mist-col" style={{ gap: 0 }} role="list" aria-label={`${q.code} 报价条目`}>{q.lines.map(l => { const m = margin(l.price, l.cost), family = state.market ? quoteLineFamily(state, state.market, l) : undefined, specItems = quoteSpecItems(family, l.specs), moq = quoteMoqStatus(family, l); return <div key={l.id} role="listitem" className="mist-col mist-quote-line" style={{ gap: 4, padding: '10px 0' }}>
        <div className="mist-row" style={{ gap: 8, flexWrap: 'wrap' }}><strong>{l.name}</strong><span className="mist-spacer" /><Button variant="quiet" onClick={() => l.productId ? onOpen('products', l.productId) : onOpen('development/detail', l.sourceDevId, { versionId: l.sourceVersionId })}>{l.productId ? '档案' : '开发版本'}</Button><Button onClick={()=>onOpen('quotations',q.id,{section:'costing:'+l.id})}>条目核算</Button><Button onClick={()=>onOpen('quotations',q.id,{section:'compare:'+l.id})}>历史条件对照</Button></div>
        <small className="mist-muted"><Mono>{l.style}</Mono>{l.specification ? ' · ' + l.specification : ''}</small>
        {specItems.length > 0 && <small className="mist-muted" data-quote-specs>{specItems.map((it, k) => <span key={it.label}>{k ? ' · ' : ''}{it.label} <span className={it.missing ? 'mist-tone-warn' : undefined}>{it.value}</span></span>)}</small>}
        {(q.status === 'Accepted' || q.convertedOrderId) && (() => { const c = quoteLineConversionStatus(q, l, state.orders); return <div className="mist-row" style={{ gap: 6, flexWrap: 'wrap' }} data-line-conversion={c.state}><Pill tone={c.state === 'converted' ? 'ok' : c.state === 'skipped' ? 'neutral' : 'accent'}>{c.state === 'converted' ? '已转' : c.state === 'skipped' ? '不再转' : '未转'}</Pill><small className="mist-muted">{c.state === 'converted' ? `订单 ${c.orderCode || '不可用'}${c.legacy ? ' · 历史整单转单' : ''}` : c.state === 'skipped' ? `${quoteLineConversionText(c).slice(4)} · ${c.by} ${shortWhen(c.at)}` : '尚未转单'}</small>{c.state === 'converted' && <Button variant="quiet" onClick={() => onOpen('orders/detail', c.orderId)}>打开订单</Button>}</div>; })()}
        {moq.state !== 'none' && moq.state !== 'met' && <div className="mist-row" style={{ gap: 6, flexWrap: 'wrap' }} data-quote-moq={moq.state}>{moq.state === 'below' && <Pill tone="warn">低于 MOQ</Pill>}<small className="mist-muted">{moq.text}</small></div>}
        <div className="mist-row" style={{ gap: 8, flexWrap: 'wrap' }}><span className="mist-num">{l.qty} {l.unit} × {l.price} = {q.currency} {l.amount}</span><span className="mist-spacer" />{lineBelowMarginFloor(l) && <span data-margin-floor-breach><Pill tone="warn">{`低于最低毛利率 ${l.marginFloor!.minMarginPercent}%（V${l.marginFloor!.version}）`}</Pill></span>}{m === null ? <span className="mist-muted">成本待核</span> : <span className={m < 0 ? 'mist-tone-bad mist-num' : 'mist-num mist-muted'}>毛利 {m}%</span>}</div>
      </div>; })}</div>
      <span className="mist-note">毛利参考 = (单价 − 成本) / 单价，仅按已记录条目成本，不是实际订单利润。专业核算从准确条目进入；历史行业基准、汇率换算与 AI 尚未接入。</span>
    </DetailBlock>
    {!!q.costingSnapshots?.length&&<DetailBlock title="核算历史"><span className="mist-note">{q.costingSnapshots.length} 份不可覆盖快照；编辑草稿重建条目后，旧快照仅历史，不自动绑定新行。当前行从条目核算查看。</span><Button onClick={()=>onOpen('quotations',q.id,{section:'cost-history'})}>查看全部核算历史</Button></DetailBlock>}
    {versions.length > 1 && <DetailBlock title="版本">
      <div className="mist-col" style={{ gap: 6 }} data-quotation-versions>{versions.map(v => <Button key={v.id} variant={v.id === q.id ? 'secondary' : 'quiet'} aria-current={v.id === q.id || undefined} onClick={() => onOpen('quotations', v.id)}>
        <span className="mist-row" style={{ gap: 8, width: '100%' }}><Pill tone={v.id === q.id ? 'accent' : 'neutral'}>{version(v)}</Pill><span className="mist-num">{v.currency} {v.total}</span><span className="mist-muted">至 {v.validUntil.slice(5)}</span><span className="mist-spacer" /><span>{quotationStageLabel(v)}</span></span>
      </Button>)}</div>
    </DetailBlock>}
    <DetailBlock title="客户反馈记录"><span className="mist-note">{q.feedback?.length||0} 条结构化反馈；区分客户原话、业务判断和未知原因。还价不改本版单价，接受 / 未接受仍从主线确认。</span><Button onClick={()=>onOpen('quotations',q.id,{section:'feedback'})}>查看客户反馈</Button></DetailBlock>
    <DetailBlock title="进度"><Checklist items={track} /></DetailBlock>
    {!!(q.approvalHistory?.length || q.approval) && <DetailBlock title="审批记录">
      <Timeline events={[...(q.approvalHistory || []), ...(q.approval ? [q.approval] : [])].reverse().map(a => ({ who: a.status === 'pending' ? '等待审批' : a.status === 'approved' ? '已批准' : '已退回', when: new Date(a.decidedAt || a.submittedAt).toLocaleString(), text: <>{a.note || (a.status === 'pending' ? '已提交，待指定审批人决定' : '—')}<br /><span className="mist-note">{a.details.filter(d => d.label === '金额' || d.label === '有效期').map(d => d.label + ' ' + d.value).join(' · ')}</span></> }))} />
    </DetailBlock>}
    <DetailBlock title="报价单文件">
      <div className="mist-col" style={{ gap: 0 }} data-quote-documents role="list" aria-label={`${q.code} 报价单文件`}>{documents.length ? documents.map(d => <div key={d.id} role="listitem" className="mist-row" style={{ gap: 8, flexWrap: 'wrap', padding: '8px 0' }} data-quote-document={d.draft ? 'draft' : 'formal'}>
        <Pill tone={d.draft ? 'warn' : 'ok'}>{d.draft ? '草稿水印版' : '正式版'}</Pill><Pill tone="accent">{'V' + d.revision}</Pill>
        <span className="mist-col" style={{ gap: 0, minWidth: 0 }}><span style={{ overflowWrap: 'anywhere' }}>{d.fileName}</span><small className="mist-muted">{d.generatedBy} · {shortWhen(d.generatedAt)}</small></span>
        <span className="mist-spacer" />
        <Button variant="quiet" icon={Download} onClick={() => onDownloadDocument(d.fileId)}>下载</Button>
        <Button variant="quiet" icon={Printer} onClick={() => onPrintDocument(d.fileId)}>打印</Button>
      </div>) : <span className="mist-muted">尚未生成报价单。</span>}</div>
      <span className="mist-note">每次生成都保存一份不可覆盖的 PDF（时间、生成人、报价版本）；修改报价后请重新生成。{formalDocReason && formalDocReason !== docBase ? `正式版：${formalDocReason}。` : ''}</span>
    </DetailBlock>
    <DetailBlock title="附件">{attachments}</DetailBlock>
    <DetailBlock title="处理记录">{history}</DetailBlock>
  </DetailBody>;
}
