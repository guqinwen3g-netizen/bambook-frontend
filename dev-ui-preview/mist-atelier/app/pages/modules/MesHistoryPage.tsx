/** 历史加工记录：只读保留原系统委外加工单，可按工艺 / 状态 / 年份检索并回查来源；新的生产跟踪在“生产进度”，委外从“采购管理”发起。 */
import React from 'react';
import { Download, Factory, History, RefreshCw, SearchX } from 'lucide-react';
import { Banner, Button, Card, DataTable, Dropdown, EmptyState, Facts, MistPage, Mono, PageHeader, Pill, SearchField, Toolbar, type Column, type Tone } from '../../../../../components/mist';
import { apiService } from '../../../../../services/apiService';
import type { OutsourcingOrder, OutsourcingProcessType, OutsourcingStatus } from '../../../../../types';
import { useMistSession } from '../../runtime/auth';
import { useMistWorkspace } from '../../runtime/workspace';
import { useNav } from '../../nav';
import { fmt } from '../../data';
import { exportRecords } from './fulfillmentKit';
import { DetailBlock, DetailBody, ListDetail } from './pageKit';

const PAGE = 100;
export const MES_STATUS: Record<OutsourcingStatus, { label: string; tone: Tone }> = { Draft: { label: '草稿', tone: 'neutral' }, Sent: { label: '已发出', tone: 'accent' }, Confirmed: { label: '已确认', tone: 'accent' }, InProduction: { label: '加工中', tone: 'warn' }, Received: { label: '已收回', tone: 'ok' }, Cancelled: { label: '已取消', tone: 'neutral' } };
export const MES_PROCESS: Record<OutsourcingProcessType, string> = { Sewing: '缝制', Cutting: '裁剪', Washing: '水洗', Printing: '印花', Embroidery: '绣花', Dyeing: '染色', Other: '其他' };
type StatusFilter = 'all' | OutsourcingStatus;
type ProcessFilter = 'all' | OutsourcingProcessType;
const statusOf = (r: OutsourcingOrder) => MES_STATUS[r.status] || { label: String(r.status), tone: 'neutral' as Tone };
const late = (r: OutsourcingOrder) => !!r.plannedDeliveryDate && !!r.actualDeliveryDate && r.actualDeliveryDate.slice(0, 10) > r.plannedDeliveryDate.slice(0, 10);

export function MesHistoryPage() {
  const session = useMistSession(), { route, go } = useNav(), { state } = useMistWorkspace();
  const [rows, setRows] = React.useState<OutsourcingOrder[]>([]), [loading, setLoading] = React.useState(true), [error, setError] = React.useState(''), [offset, setOffset] = React.useState(0), [total, setTotal] = React.useState(0), [retry, setRetry] = React.useState(0);
  const [status, setStatus] = React.useState<StatusFilter>('all'), [process, setProcess] = React.useState<ProcessFilter>('all'), [year, setYear] = React.useState('all'), [query, setQuery] = React.useState('');
  const [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(!!route.id);
  React.useEffect(() => { if (route.id) { setPicked(route.id); setDrawer(true); } }, [route.id]);
  React.useEffect(() => {
    let alive = true; setRows([]); setLoading(true); setError('');
    void apiService.listOutsourcingOrders({ ...(status !== 'all' ? { status } : {}), ...(process !== 'all' ? { processType: process } : {}), limit: PAGE, offset })
      .then(page => { if (alive) { setRows(page.items); setTotal(page.total); } })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : '历史记录读取失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [session.sessionKey, offset, retry, status, process]);
  const needle = query.trim().toLowerCase();
  const years = [...new Set(rows.map(r => (r.orderDate || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  const shown = rows.filter(r => (year === 'all' || (r.orderDate || '').startsWith(year)) && (!needle || `${r.orderNumber} ${r.description || ''} ${r.notes || ''} ${r.orderId || ''} ${r.supplierId || ''}`.toLowerCase().includes(needle)));
  const selected = shown.find(r => r.id === picked) || rows.find(r => r.id === picked);
  const pick = (r: OutsourcingOrder) => { setPicked(r.id); setDrawer(true); go('mes', r.id); };
  const serverFilter = (apply: () => void) => { apply(); setOffset(0); setPicked(null); };
  const columns: Column<OutsourcingOrder>[] = [
    { key: 'code', header: '历史单号', width: 'minmax(160px,1.5fr)', render: r => <div className="mist-col" style={{ gap: 2 }}><Mono>{r.orderNumber}</Mono><small className="mist-muted">{r.description || '无描述'}</small></div> },
    { key: 'process', header: '工艺', width: '80px', hideOnMobile: true, render: r => MES_PROCESS[r.processType] || r.processType },
    { key: 'qty', header: '数量', width: 'minmax(110px,1fr)', align: 'right', render: r => <div className="mist-col" style={{ gap: 2, alignItems: 'flex-end' }}><span>{fmt(r.quantity)} {r.unit}</span>{(r.qualityAcceptedQty != null || r.qualityRejectedQty != null) && <small className="mist-muted">合格 {r.qualityAcceptedQty ?? '—'} · 不合格 {r.qualityRejectedQty ?? '—'}</small>}</div> },
    { key: 'amount', header: '金额', width: '120px', align: 'right', hideOnMobile: true, render: r => `${r.currency} ${fmt(r.totalAmount, 2)}` },
    { key: 'date', header: '下单 / 交付', width: '128px', hideOnMobile: true, render: r => <div className="mist-col" style={{ gap: 2 }}><span>{r.orderDate?.slice(0, 10) || '—'}</span><small className={late(r) ? 'mist-tone-bad' : 'mist-muted'}>{r.actualDeliveryDate ? `实交 ${r.actualDeliveryDate.slice(0, 10)}${late(r) ? ' · 晚于计划' : ''}` : r.plannedDeliveryDate ? `计划 ${r.plannedDeliveryDate.slice(0, 10)}` : '未记录交期'}</small></div> },
    { key: 'status', header: '原系统状态', width: '104px', render: r => <Pill tone={statusOf(r).tone}>{statusOf(r).label}</Pill> },
  ];
  const filtered = status !== 'all' || process !== 'all' || year !== 'all' || !!needle;
  const empty = error ? <EmptyState icon={History} title="历史记录暂不可读" description="未使用演示记录替代；稍后重新读取。" action={<Button icon={RefreshCw} onClick={() => setRetry(v => v + 1)}>重新读取</Button>} />
    : filtered ? <EmptyState icon={SearchX} title="没有符合条件的历史记录" description="换个关键词或清除筛选。" action={<Button onClick={() => { setQuery(''); setYear('all'); serverFilter(() => { setStatus('all'); setProcess('all'); }); }}>清除筛选</Button>} />
    : <EmptyState icon={History} title="没有可见历史加工记录" description="原系统没有留下委外加工单，或你的账号无权查看。" />;
  const detail = selected ? <MesDetail row={selected} orderCode={id => state?.orders.find(o => o.id === id)?.code} onOrder={id => go('orders/detail', id)} />
    : <EmptyState icon={History} title="加工记录详情" description={loading ? '正在读取历史记录' : '从列表选择一张历史单据，查看数量、交付、验收与来源'} compact />;
  return <MistPage width="wide">
    <PageHeader eyebrow="平台 · 历史" title="历史加工记录" description="只读保留原系统委外加工单据，不能新建或修改；新的生产跟踪在“生产进度”，委外加工从“采购管理”发起。"
      actions={<>
        <Button icon={Download} disabled={!shown.length} onClick={() => exportRecords('历史加工记录', ['历史单号', '工艺', '描述', '数量', '单位', '币种', '金额', '下单日', '计划交付', '实际交付', '合格', '不合格', '状态'], shown.map(r => [r.orderNumber, MES_PROCESS[r.processType] || r.processType, r.description || '', r.quantity, r.unit, r.currency, r.totalAmount, r.orderDate || '', r.plannedDeliveryDate || '', r.actualDeliveryDate || '', r.qualityAcceptedQty ?? '', r.qualityRejectedQty ?? '', statusOf(r).label]))}>导出本批</Button>
        <Button icon={RefreshCw} onClick={() => setRetry(v => v + 1)}>重新读取</Button>
        <Button icon={Factory} variant="primary" onClick={() => go('production-board')}>前往生产进度</Button>
      </>} />
    {error && <div className="mist-section"><Banner tone="bad" title="原生历史接口读取失败">{error}。未使用演示记录替代。</Banner></div>}
    <Toolbar>
      <SearchField value={query} onChange={setQuery} placeholder="在本批中搜索单号、描述、备注或原系统编号" />
      <Dropdown<ProcessFilter> label="工艺" value={process} onChange={v => serverFilter(() => setProcess(v))} options={[{ value: 'all', label: '全部工艺' }, ...(Object.keys(MES_PROCESS) as OutsourcingProcessType[]).map(value => ({ value, label: MES_PROCESS[value] }))]} />
      <Dropdown<StatusFilter> label="状态" value={status} onChange={v => serverFilter(() => setStatus(v))} options={[{ value: 'all', label: '全部状态' }, ...(Object.keys(MES_STATUS) as OutsourcingStatus[]).map(value => ({ value, label: MES_STATUS[value].label }))]} />
      {years.length > 1 && <Dropdown label="年份" value={year} onChange={setYear} options={[{ value: 'all', label: '全部年份' }, ...years.map(value => ({ value, label: `${value} 年` }))]} />}
    </Toolbar>
    <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)} drawerTitle={selected?.orderNumber || '加工记录详情'} drawerSub={selected ? `${MES_PROCESS[selected.processType] || selected.processType} · ${statusOf(selected).label}` : undefined}
      list={<Card><DataTable ariaLabel="历史加工记录" loading={loading} rows={shown} rowKey={r => r.id} selectedKey={selected?.id} density="comfy" onRowClick={pick} columns={columns} empty={empty}
        footer={<div className="mist-row" style={{ flexWrap: 'wrap' }}><span className="mist-muted">共 {total} 条{total > PAGE ? ` · 第 ${offset + 1}–${offset + rows.length} 条` : ''}{shown.length !== rows.length ? ` · 本批显示 ${shown.length} 条` : ''}</span><span className="mist-spacer" /><Button size="sm" disabled={!offset || loading} onClick={() => setOffset(o => Math.max(0, o - PAGE))}>上一批</Button><Button size="sm" disabled={offset + rows.length >= total || loading} onClick={() => setOffset(o => o + PAGE)}>下一批</Button></div>} /></Card>}
      detail={detail} />
  </MistPage>;
}

function MesDetail({ row: r, orderCode, onOrder }: { row: OutsourcingOrder; orderCode: (id: string) => string | undefined; onOrder: (id: string) => void }) {
  const [full, setFull] = React.useState<OutsourcingOrder | null>(r.lines ? r : null), [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let alive = true; setFull(r.lines ? r : null); setFailed(false);
    if (!r.lines) void (async () => { try { const item = await apiService.getOutsourcingOrder(r.id); if (alive) setFull(item); } catch { if (alive) setFailed(true); } })();
    return () => { alive = false; };
  }, [r]);
  const lines = full?.lines || [], st = statusOf(r), code = r.orderId ? orderCode(r.orderId) : undefined;
  return <DetailBody data-mes-detail={r.id} heading={<div>
      <span className="mist-mono mist-muted">{MES_PROCESS[r.processType] || r.processType} · 只读历史</span>
      <div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{r.orderNumber}</div>
    </div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={st.tone}>{st.label}</Pill>{late(r) && <Pill tone="bad">晚于计划交付</Pill>}</div>
    <Banner tone="neutral" title="只读历史">原系统单据不能在这里修改；需要继续的加工请在采购管理新建委外加工单，并从生产进度跟踪。</Banner>
    <Facts items={[
      { label: '数量', value: `${fmt(r.quantity)} ${r.unit}` },
      { label: '单价 / 金额', value: `${r.currency} ${fmt(r.unitPrice, 2)} / ${fmt(r.totalAmount, 2)}` },
      { label: '下单日', value: r.orderDate?.slice(0, 10) || '未记录' },
      { label: '计划交付', value: r.plannedDeliveryDate?.slice(0, 10) || '未记录' },
      { label: '实际交付', value: r.actualDeliveryDate ? <span className={late(r) ? 'mist-tone-bad' : undefined}>{r.actualDeliveryDate.slice(0, 10)}</span> : '未记录' },
      { label: '验收', value: r.qualityAcceptedQty != null || r.qualityRejectedQty != null ? `合格 ${r.qualityAcceptedQty ?? '—'} · 不合格 ${r.qualityRejectedQty ?? '—'} ${r.unit}` : '未记录' },
    ]} />
    {r.description && <p className="mist-sub">描述：{r.description}</p>}
    {r.notes && <p className="mist-sub">备注：{r.notes}</p>}
    <DetailBlock title="来源回查">
      <Facts items={[
        { label: '来源订单', value: !r.orderId ? '历史未关联' : code ? <Button size="sm" onClick={() => onOrder(r.orderId!)}>{code}</Button> : <span className="mist-muted">原系统订单 {r.orderId.slice(0, 8)} · 当前工作空间无对应订单</span> },
        { label: '加工方', value: r.supplierId ? <span className="mist-muted">原系统供应商 {r.supplierId.slice(0, 8)} · 尚未映射到供应商管理</span> : '历史未关联' },
        { label: 'BOM', value: r.bomId ? <span className="mist-muted">原系统 BOM {r.bomId.slice(0, 8)}</span> : '未关联' },
      ]} />
    </DetailBlock>
    <DetailBlock title="加工明细">
      {failed ? <span className="mist-note">明细读取失败，未使用演示数据替代。</span>
        : !full ? <span className="mist-note">正在读取明细…</span>
        : lines.length ? <DataTable ariaLabel={`${r.orderNumber} 加工明细`} rows={lines} rowKey={l => l.id} columns={[
          { key: 'process', header: '工艺', render: l => MES_PROCESS[l.processType] || l.processType },
          { key: 'desc', header: '内容', render: l => <div className="mist-col" style={{ gap: 2 }}><span>{l.description}</span>{l.materialCode && <small className="mist-muted">{l.materialCode}</small>}</div> },
          { key: 'qty', header: '数量', align: 'right', render: l => `${fmt(l.quantity)} ${l.unit}` },
          { key: 'amount', header: '金额', align: 'right', hideOnMobile: true, render: l => `${r.currency} ${fmt(l.amount, 2)}` },
        ]} /> : <span className="mist-note">原系统未记录分项明细。</span>}
    </DetailBlock>
  </DetailBody>;
}
