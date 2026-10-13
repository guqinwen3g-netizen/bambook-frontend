/** 本地历史加工记录：只汇总本工作空间已批准的加工合同及其实际交付（只读）；办理在采购管理，跟单在生产进度。 */
import React from 'react';
import { Download, Factory, History, SearchX } from 'lucide-react';
import { Banner, Button, Card, DataTable, Dropdown, EmptyState, Facts, MistPage, Mono, PageHeader, Pill, Pipeline, SearchField, Segmented, Toolbar, type Column, type Tone } from '../../../../../components/mist';
import type { FulfillmentPurchase } from '../../../../../server/src/shared/mistFulfillment';
import { useMistWorkspace } from '../../runtime/workspace';
import { useNav } from '../../nav';
import { downloadModuleCsv } from './ModuleWorkbench';
import { today } from './fulfillmentKit';
import { DetailBlock, DetailBody, ListDetail } from './pageKit';

type Domain = FulfillmentPurchase['domain'];
type Stage = 'open' | 'done' | 'variance';
type StageFilter = 'all' | Stage;
const STAGE: Record<Stage, { label: string; tone: Tone }> = { open: { label: '履行中', tone: 'accent' }, done: { label: '已交付', tone: 'ok' }, variance: { label: '数量差异待处理', tone: 'warn' } };
const stageOf = (p: FulfillmentPurchase): Stage => p.received > p.quantity ? 'variance' : p.received === p.quantity ? 'done' : 'open';

export function LocalMesPage() {
  const { state, loading } = useMistWorkspace(), { go, route } = useNav();
  const all = (state?.fulfillment?.purchases || []).filter(p => p.kind === 'processing' && p.state === 'approved');
  const [domainChoice, setDomainChoice] = React.useState<Domain | null>(null), [stage, setStage] = React.useState<StageFilter>('all'), [supplier, setSupplier] = React.useState('all'), [year, setYear] = React.useState('all'), [query, setQuery] = React.useState('');
  const [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(!!route.id);
  React.useEffect(() => { if (route.id) { setPicked(route.id); setDrawer(true); setDomainChoice(null); } }, [route.id]);
  const routed = all.find(p => p.id === route.id), day = today();
  const domain: Domain = domainChoice || routed?.domain || (all.some(p => p.domain === 'garment') || !all.some(p => p.domain === 'fabric') ? 'garment' : 'fabric');
  const inDomain = all.filter(p => (p.domain || 'garment') === domain);
  const orderCode = (id: string) => state?.orders.find(o => o.id === id)?.code || '';
  const suppliers = [...new Set(inDomain.map(p => p.supplier))].sort(), years = [...new Set(inDomain.map(p => (p.due || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  const needle = query.trim().toLowerCase();
  const searched = inDomain.filter(p => (supplier === 'all' || p.supplier === supplier) && (year === 'all' || (p.due || '').startsWith(year)) && (!needle || `${p.code} ${p.supplier} ${p.description} ${orderCode(p.orderId)}`.toLowerCase().includes(needle)));
  const count = (value: StageFilter) => value === 'all' ? searched.length : searched.filter(p => stageOf(p) === value).length;
  const order: Record<Stage, number> = { variance: 0, open: 1, done: 2 };
  const rows = searched.filter(p => stage === 'all' || stageOf(p) === stage).sort((a, b) => order[stageOf(a)] - order[stageOf(b)] || (b.due || '').localeCompare(a.due || ''));
  const selected = rows.find(p => p.id === picked) || (picked ? all.find(p => p.id === picked) : undefined);
  const pick = (p: FulfillmentPurchase) => { setPicked(p.id); setDrawer(true); go('mes', p.id); };
  const overdue = (p: FulfillmentPurchase) => stageOf(p) === 'open' && !!p.due && p.due < day;
  const columns: Column<FulfillmentPurchase>[] = [
    { key: 'code', header: '加工合同', width: 'minmax(128px,1.2fr)', render: p => <div className="mist-col" style={{ gap: 2 }}><Mono>{p.code}</Mono><small className="mist-muted">{orderCode(p.orderId) || '来源订单不可用'}</small></div> },
    { key: 'supplier', header: '加工方', width: 'minmax(88px,1fr)', hideOnMobile: true, render: p => p.supplier },
    { key: 'name', header: '加工内容', width: 'minmax(112px,1.4fr)', hideOnMobile: true, render: p => p.description },
    { key: 'qty', header: '已交付 / 合同', width: '124px', align: 'right', render: p => <span className={stageOf(p) === 'variance' ? 'mist-tone-bad' : undefined}>{p.received} / {p.quantity} {p.unit}</span> },
    { key: 'due', header: '交期', width: '96px', hideOnMobile: true, render: p => <span className={overdue(p) ? 'mist-tone-bad' : undefined}>{p.due || '未定'}</span> },
    { key: 'state', header: '状态', width: '92px', render: p => <Pill tone={STAGE[stageOf(p)].tone}>{STAGE[stageOf(p)].label}</Pill> },
  ];
  const empty = inDomain.length
    ? <EmptyState icon={SearchX} title="没有符合条件的加工记录" description="换个关键词或清除筛选。" action={<Button onClick={() => { setQuery(''); setSupplier('all'); setYear('all'); setStage('all'); }}>清除筛选</Button>} />
    : <EmptyState icon={History} title="还没有历史加工记录" description="采购管理中已批准的加工合同及其实际交付会在这里汇总。" action={<Button onClick={() => go('procurement')}>前往采购管理</Button>} />;
  const detail = selected && state ? <LocalMesDetail purchase={selected} state={state} orderCode={orderCode} go={go} />
    : <EmptyState icon={History} title="加工记录详情" description={loading ? '正在读取加工记录' : '从列表选择一份加工合同，查看实际交付与来源'} compact />;
  return <MistPage width="wide">
    <PageHeader eyebrow="平台 · 加工履行" title="历史加工记录" description="只读汇总本工作空间已批准的加工合同及实际交付；新的委外加工从“采购管理”发起，生产跟踪在“生产进度”。"
      actions={<>
        <Button icon={Download} disabled={!rows.length} onClick={() => downloadModuleCsv('加工履行记录.csv', ['合同', '订单', '加工方', '加工内容', '合同数量', '单位', '已交付', '交期', '状态'], rows.map(p => [p.code, orderCode(p.orderId), p.supplier, p.description, p.quantity, p.unit, p.received, p.due, STAGE[stageOf(p)].label]))}>导出</Button>
        <Button icon={Factory} variant="primary" onClick={() => go('production-board')}>前往生产进度</Button>
      </>} />
    <div className="mist-section"><Segmented<Domain> ariaLabel="业务板块" value={domain} onChange={value => { setDomainChoice(value); setStage('all'); setSupplier('all'); setPicked(null); }} options={[{ value: 'garment', label: `成衣业务 · ${all.filter(p => (p.domain || 'garment') === 'garment').length}` }, { value: 'fabric', label: `面料业务 · ${all.filter(p => p.domain === 'fabric').length}` }]} /></div>
    <Toolbar>
      <SearchField value={query} onChange={setQuery} placeholder="搜索加工合同、加工方、加工内容或来源订单" />
      {suppliers.length > 1 && <Dropdown label="加工方" value={supplier} onChange={setSupplier} options={[{ value: 'all', label: '全部加工方' }, ...suppliers.map(value => ({ value, label: value }))]} />}
      {years.length > 1 && <Dropdown label="交期年份" value={year} onChange={setYear} options={[{ value: 'all', label: '全部年份' }, ...years.map(value => ({ value, label: `${value} 年` }))]} />}
    </Toolbar>
    <Pipeline<StageFilter> value={stage} onChange={setStage} items={[
      { value: 'all', label: '全部合同', count: count('all'), color: 'var(--mist-ink-2)' },
      { value: 'open', label: '履行中', count: count('open'), color: 'var(--mist-accent)' },
      { value: 'done', label: '已交付', count: count('done'), color: 'var(--mist-ok)' },
      { value: 'variance', label: '数量差异', count: count('variance'), color: 'var(--mist-warn)' },
    ]} />
    <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)} drawerTitle={selected ? `${selected.code} · ${selected.supplier}` : '加工记录详情'} drawerSub={selected?.description}
      list={<Card><DataTable ariaLabel="历史加工记录" loading={loading} rows={rows} rowKey={p => p.id} selectedKey={selected?.id} density="comfy" onRowClick={pick} columns={columns} empty={empty} /></Card>}
      detail={detail} />
  </MistPage>;
}

function LocalMesDetail({ purchase: p, state, orderCode, go }: { purchase: FulfillmentPurchase; state: NonNullable<ReturnType<typeof useMistWorkspace>['state']>; orderCode: (id: string) => string; go: ReturnType<typeof useNav>['go'] }) {
  const receipts = state.fulfillment.receipts.filter(receipt => receipt.purchaseId === p.id), production = state.productions.find(row => row.sourcePurchaseId === p.id);
  const rejected = receipts.reduce((sum, receipt) => sum + (receipt.rejected || 0), 0), st = STAGE[stageOf(p)];
  return <DetailBody data-mes-detail={p.id} heading={<div>
      <span className="mist-mono mist-muted">{p.code} · 只读汇总</span>
      <div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{p.description}</div>
    </div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={st.tone}>{st.label}</Pill><Pill>{p.domain === 'fabric' ? '面料业务' : '成衣业务'}</Pill></div>
    {stageOf(p) === 'variance' ? <Banner tone="warn" title="交付数量超过合同">实际交付 {p.received} {p.unit}，合同 {p.quantity} {p.unit}；差异请在采购管理中按合同处理。</Banner>
      : <Banner tone="neutral" title="只读汇总">加工合同在采购管理中办理，本页只汇总已批准合同的实际交付。</Banner>}
    <Facts items={[
      { label: '加工方', value: p.supplier },
      { label: '来源订单', value: orderCode(p.orderId) || '来源订单不可用' },
      { label: '实际交付', value: `${p.received} / ${p.quantity} ${p.unit}` },
      { label: '拒收合计', value: `${rejected} ${p.unit}` },
      { label: '交期', value: p.supplierConfirmation?.confirmedDue && p.supplierConfirmation.confirmedDue !== p.due ? `${p.due} · 加工方确认 ${p.supplierConfirmation.confirmedDue}` : p.due || '未定' },
      { label: '交付地点', value: p.destination || '未填写' },
      { label: '条款', value: p.terms || '未填写' },
      { label: '批准', value: p.decision ? `${p.decision.actor} · ${p.decision.at.slice(0, 10)}` : '已批准' },
    ]} />
    <DetailBlock title={`实际交付（${receipts.length}）`}>
      {receipts.length ? <DataTable ariaLabel="加工实际交付" rows={receipts} rowKey={receipt => receipt.id} columns={[
        { key: 'date', header: '日期', render: receipt => receipt.date },
        { key: 'quantity', header: '实收 / 拒收', align: 'right', render: receipt => `实收 ${receipt.quantity} · 拒收 ${receipt.rejected || 0} ${p.unit}` },
        { key: 'location', header: '实际地点', hideOnMobile: true, render: receipt => receipt.location },
        { key: 'evidence', header: '交付依据', hideOnMobile: true, render: receipt => receipt.evidence },
      ]} /> : <span className="mist-note">还没有登记实际交付。</span>}
    </DetailBlock>
    <div className="mist-row mist-module-actions" style={{ flexWrap: 'wrap' }}>
      <Button onClick={() => go('procurement', p.id)}>打开加工合同</Button>
      <Button onClick={() => go('orders/detail', p.orderId, { orderLineId: p.lineId, productionId: production?.id })}>返回来源条目</Button>
      <Button disabled={!production} title={production ? undefined : '尚未生成生产跟单'} onClick={() => go('production-board', undefined, { productionId: production?.id })}>查看生产跟单</Button>
    </div>
    {!production && <span className="mist-note">该加工合同尚未生成生产跟单，可在生产进度中从来源条目开立。</span>}
  </DetailBody>;
}
