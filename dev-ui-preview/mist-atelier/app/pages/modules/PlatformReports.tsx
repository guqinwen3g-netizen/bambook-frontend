/** 报表中心：客户销售额、订单毛利、应收账龄、订单进度与逾期。金额按币种分别统计，从不跨币种相加，也不做汇率折算。 */
import React from 'react';
import { Clock, Download, Package, Receipt, TrendingUp } from 'lucide-react';
import { Banner, Button, Card, CardHeader, DataTable, EmptyState, Field, MistPage, PageHeader, Pill, Select, StatCard, StatGrid, Tabs, TextInput, Toolbar, type Column } from '../../../../../components/mist';
import { platformBusinessDate } from '../../../../../server/src/shared/mistPlatform';
import { isActiveMistInvoice, isRecognizedMistInvoice, mistMoneyMinor, type MistState } from '../../../../../server/src/shared/mistWorkspace';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { downloadModuleCsv } from './ModuleWorkbench';

const money = (n: number) => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const minor = (n: number) => mistMoneyMinor(n);
const days = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
const businessDay = (at: string) => { try { return platformBusinessDate(at); } catch { return at.slice(0, 10); } };

export type CustomerSalesRow = { id: string; customerId: string; customer: string; currency: string; orders: number; amount: number; invoiced: number; received: number; open: number };
/** 订单按业务日（上海）落在范围内；开票、已收、未收只统计这些订单的有效发票。 */
export function buildCustomerSales(state: MistState, from = '', to = '', currency = ''): CustomerSalesRow[] {
  const orders = state.orders.filter(o => { const d = businessDay(o.createdAt); return (!from || d >= from) && (!to || d <= to) && (!currency || o.currency === currency); });
  const map = new Map<string, { customerId: string; customer: string; currency: string; orders: number; amount: number; invoiced: number; open: number }>();
  for (const o of orders) {
    const key = (o.customerId || o.customer) + '|' + o.currency, row = map.get(key) ?? { customerId: o.customerId, customer: o.customer, currency: o.currency, orders: 0, amount: 0, invoiced: 0, open: 0 };
    row.orders++; row.amount += minor(o.amount);
    for (const i of state.invoices) if (i.orderId === o.id && isRecognizedMistInvoice(i) && i.currency === o.currency) { row.invoiced += minor(i.amount); row.open += minor(i.open); }
    map.set(key, row);
  }
  return [...map.entries()].map(([id, r]) => ({ id, customerId: r.customerId, customer: r.customer, currency: r.currency, orders: r.orders, amount: r.amount / 100, invoiced: r.invoiced / 100, received: (r.invoiced - r.open) / 100, open: r.open / 100 }))
    .sort((a, b) => a.currency.localeCompare(b.currency) || b.amount - a.amount || a.customer.localeCompare(b.customer, 'zh-CN'));
}

export type OrderMarginRow = { id: string; code: string; customer: string; currency: string; revenue: number; cost: number; billed: number; margin: number | null; rate: number | null; purchases: number; pending: number; foreign: string; status: 'ok' | 'nocost' | 'foreign' };
/**
 * 订单预估毛利（贸易公司通行做法：合同口径）：
 * 销售收入 = 已生效订单金额（未走审批或审批已通过；草稿、待审、退回不计）；
 * 采购成本 = 该订单下已批准且未取消的采购合同金额（数量 × 单价，通常为含税价）；
 * 已到票 = 这些采购在有效供应商发票中登记的金额，仅作执行参考；
 * 毛利只在采购与订单同币种时计算；有异币种采购的订单不折算、不出毛利，单独标注。
 * 未计出口退税、运费、报关、佣金、索赔扣款等，属于毛利以外的调整项。
 */
export function buildOrderMargin(state: MistState, from = '', to = '', currency = ''): OrderMarginRow[] {
  const purchases = state.fulfillment?.purchases ?? [], bills = (state.payables?.bills ?? []).filter(b => b.state !== 'void');
  return state.orders.filter(o => (!o.governance || o.governance.status === 'approved') && (!currency || o.currency === currency)).filter(o => { const d = businessDay(o.createdAt); return (!from || d >= from) && (!to || d <= to); }).map(o => {
    const mine = purchases.filter(p => p.orderId === o.id && !p.cancellation), approved = mine.filter(p => p.state === 'approved');
    let cost = 0, billed = 0; const foreign = new Map<string, number>();
    for (const p of approved) {
      const value = Math.max(0, Math.round(p.quantity * p.price * 100));
      if (p.currency === o.currency) cost += value; else foreign.set(p.currency, (foreign.get(p.currency) ?? 0) + value);
      for (const b of bills) if (b.currency === o.currency && p.currency === o.currency) for (const l of b.lines) if (l.purchaseId === p.id) billed += minor(l.amount);
    }
    const revenue = minor(o.amount), status: OrderMarginRow['status'] = foreign.size ? 'foreign' : approved.length ? 'ok' : 'nocost';
    const margin = status === 'ok' ? revenue - cost : null;
    return { id: o.id, code: o.code, customer: o.customer, currency: o.currency, revenue: revenue / 100, cost: cost / 100, billed: billed / 100, margin: margin === null ? null : margin / 100, rate: margin === null || !revenue ? null : margin / revenue,
      purchases: approved.length, pending: mine.filter(p => p.state === 'pending' || p.state === 'draft').length, foreign: [...foreign.entries()].map(([c, v]) => `${c} ${money(v / 100)}`).join(' · '), status };
  }).sort((a, b) => a.currency.localeCompare(b.currency) || ({ ok: 0, foreign: 1, nocost: 2 }[a.status] - { ok: 0, foreign: 1, nocost: 2 }[b.status]) || (a.rate ?? 0) - (b.rate ?? 0) || a.code.localeCompare(b.code));
}
const MARGIN_STATUS = { ok: { label: '已计算', tone: 'ok' }, foreign: { label: '含异币种采购', tone: 'warn' }, nocost: { label: '无已批准采购', tone: 'neutral' } } as const;
const percent = (r: number | null) => r === null ? '—' : (r * 100).toFixed(1) + '%';

export const AGING_BUCKETS = [{ key: 'current', label: '未到期' }, { key: 'd30', label: '逾期 1–30 天' }, { key: 'd60', label: '31–60 天' }, { key: 'd90', label: '61–90 天' }, { key: 'over', label: '90 天以上' }] as const;
type Bucket = typeof AGING_BUCKETS[number]['key'];
export const agingBucket = (due: string, asOf: string): Bucket => { const late = days(due, asOf); return late <= 0 ? 'current' : late <= 30 ? 'd30' : late <= 60 ? 'd60' : late <= 90 ? 'd90' : 'over'; };
export type AgingRow = { id: string; customer: string; currency: string; invoices: number; total: number } & Record<Bucket, number>;
/** 只统计有效且仍有未收余额的发票；按到期日计算逾期天数。 */
export function buildReceivableAging(state: MistState, asOf: string): AgingRow[] {
  const map = new Map<string, { customer: string; currency: string; invoices: number } & Record<Bucket | 'total', number>>();
  for (const i of state.invoices) {
    if (!isActiveMistInvoice(i) || !(i.open > 0)) continue;
    const key = i.customer + '|' + i.currency, row = map.get(key) ?? { customer: i.customer, currency: i.currency, invoices: 0, total: 0, current: 0, d30: 0, d60: 0, d90: 0, over: 0 };
    const value = minor(i.open); row.invoices++; row.total += value; row[agingBucket(i.due, asOf)] += value; map.set(key, row);
  }
  return [...map.entries()].map(([id, r]) => ({ id, customer: r.customer, currency: r.currency, invoices: r.invoices, total: r.total / 100, current: r.current / 100, d30: r.d30 / 100, d60: r.d60 / 100, d90: r.d90 / 100, over: r.over / 100 }))
    .sort((a, b) => a.currency.localeCompare(b.currency) || b.total - a.total);
}

export type OrderProgressRow = { id: string; code: string; customer: string; due: string; progress: number; state: string; tone: string; status: 'overdue' | 'soon' | 'ontrack' | 'nodue'; lateDays: number };
/** 未完成订单（进度 < 100%）：已过交期为逾期，7 天内到期为临近。 */
export function buildOrderProgress(state: MistState, asOf: string): OrderProgressRow[] {
  return state.orders.filter(o => o.progress < 100).map(o => {
    const late = o.due ? days(o.due, asOf) : 0;
    const status: OrderProgressRow['status'] = !o.due ? 'nodue' : late > 0 ? 'overdue' : late >= -7 ? 'soon' : 'ontrack';
    return { id: o.id, code: o.code, customer: o.customer, due: o.due, progress: o.progress, state: o.state, tone: o.tone, status, lateDays: Math.max(0, late) };
  }).sort((a, b) => ({ overdue: 0, soon: 1, ontrack: 2, nodue: 3 }[a.status] - { overdue: 0, soon: 1, ontrack: 2, nodue: 3 }[b.status]) || b.lateDays - a.lateDays || a.due.localeCompare(b.due));
}
const PROGRESS_STATUS = { overdue: { label: '已逾期', tone: 'bad' }, soon: { label: '7 天内到期', tone: 'warn' }, ontrack: { label: '正常', tone: 'ok' }, nodue: { label: '未填交期', tone: 'neutral' } } as const;

type ReportTab = 'sales' | 'margin' | 'aging' | 'orders';
export function PlatformReportsPage() {
  const workspace = useMistWorkspace(), session = useMistSession(), { route, go } = useNav(), state = workspace.state;
  // 毛利涉及采购成本，只给报表管理者（业务主管、财务、老板）看；本地工作区为单人使用。
  const canSeeMargin = !!session.localMode || session.hasPermission('reports:admin');
  const tab: ReportTab = route.section === 'aging' || route.section === 'orders' || (route.section === 'margin' && canSeeMargin) ? route.section : 'sales';
  const asOf = platformBusinessDate(new Date());
  const [from, setFrom] = React.useState(''), [to, setTo] = React.useState(''), [currency, setCurrency] = React.useState(''), [progressFilter, setProgressFilter] = React.useState('');
  const invalid = !!from && !!to && from > to;
  const currencies = [...new Set([...(state?.orders ?? []).map(o => o.currency), ...(state?.invoices ?? []).map(i => i.currency)])].filter(Boolean).sort();
  const sales = state && !invalid ? buildCustomerSales(state, from, to, currency) : [];
  const margin = state && !invalid && tab === 'margin' ? buildOrderMargin(state, from, to, currency) : [];
  const marginTotals = [...new Set(margin.map(r => r.currency))].map(c => { const rows = margin.filter(r => r.currency === c && r.status === 'ok'), rev = rows.reduce((t, r) => t + minor(r.revenue), 0), m = rows.reduce((t, r) => t + minor(r.margin ?? 0), 0); return { currency: c, revenue: rev / 100, margin: m / 100, rate: rev ? m / rev : null, orders: rows.length }; });
  const aging = state ? buildReceivableAging(state, asOf).filter(r => !currency || r.currency === currency) : [];
  const progress = state ? buildOrderProgress(state, asOf) : [];
  const shownProgress = progress.filter(r => !progressFilter || r.status === progressFilter);
  const totals = (rows: Array<{ currency: string }>, pick: (r: any) => number) => [...new Set(rows.map(r => r.currency))].map(c => `${c} ${money(rows.filter(r => r.currency === c).reduce((s, r) => s + minor(pick(r)), 0) / 100)}`).join(' · ') || '—';
  const currencyFilter = <Field label="币种"><Select aria-label="币种" value={currency} onChange={e => setCurrency(e.target.value)} options={[{ value: '', label: '全部币种（分别统计）' }, ...currencies.map(c => ({ value: c, label: c }))]} /></Field>;

  const salesColumns: Column<CustomerSalesRow>[] = [
    { key: 'customer', header: '客户', width: 'minmax(180px,2fr)', render: r => r.customerId ? <Button variant="quiet" onClick={() => go('crm', r.customerId, { customerId: r.customerId })}>{r.customer}</Button> : r.customer, sortValue: r => r.customer },
    { key: 'currency', header: '币种', width: '72px', render: r => r.currency },
    { key: 'orders', header: '订单数', width: '80px', align: 'right', render: r => r.orders, sortValue: r => r.orders },
    { key: 'amount', header: '订单金额', align: 'right', render: r => money(r.amount), sortValue: r => r.amount },
    { key: 'invoiced', header: '已开票', align: 'right', render: r => money(r.invoiced), sortValue: r => r.invoiced },
    { key: 'received', header: '已收', align: 'right', render: r => money(r.received), sortValue: r => r.received },
    { key: 'open', header: '未收', align: 'right', render: r => money(r.open), sortValue: r => r.open },
  ];
  const marginColumns: Column<OrderMarginRow>[] = [
    { key: 'code', header: '订单', width: 'minmax(130px,1fr)', render: r => <Button variant="quiet" onClick={() => go('orders/detail', r.id)}>{r.code}</Button>, sortValue: r => r.code },
    { key: 'customer', header: '客户', width: 'minmax(140px,1.4fr)', render: r => r.customer, sortValue: r => r.customer },
    { key: 'currency', header: '币种', width: '64px', render: r => r.currency },
    { key: 'revenue', header: '销售收入', align: 'right', render: r => money(r.revenue), sortValue: r => r.revenue },
    { key: 'cost', header: '采购成本', align: 'right', render: r => r.purchases ? money(r.cost) : <span className="mist-note">—</span>, sortValue: r => r.cost },
    { key: 'margin', header: '毛利', align: 'right', render: r => r.margin === null ? <span className="mist-note">—</span> : <b className={r.margin < 0 ? 'mist-tone-bad' : undefined}>{money(r.margin)}</b>, sortValue: r => r.margin ?? -Infinity },
    { key: 'rate', header: '毛利率', width: '80px', align: 'right', render: r => <span className={r.rate !== null && r.rate < 0 ? 'mist-tone-bad' : undefined}>{percent(r.rate)}</span>, sortValue: r => r.rate ?? -Infinity },
    { key: 'billed', header: '已到票', align: 'right', render: r => r.billed ? money(r.billed) : <span className="mist-note">—</span>, sortValue: r => r.billed },
    { key: 'status', header: '说明', width: 'minmax(150px,1.4fr)', render: r => <><Pill tone={MARGIN_STATUS[r.status].tone}>{MARGIN_STATUS[r.status].label}</Pill>{r.foreign && <div className="mist-note">另有 {r.foreign}</div>}{r.pending > 0 && <div className="mist-note">{r.pending} 张采购未批准，未计入</div>}</> },
  ];
  const agingColumns: Column<AgingRow>[] = [
    { key: 'customer', header: '客户', width: 'minmax(160px,2fr)', render: r => r.customer, sortValue: r => r.customer },
    { key: 'currency', header: '币种', width: '72px', render: r => r.currency },
    ...AGING_BUCKETS.map(b => ({ key: b.key, header: b.label, align: 'right' as const, render: (r: AgingRow) => r[b.key] ? <span className={b.key === 'over' || b.key === 'd90' ? 'mist-tone-bad' : undefined}>{money(r[b.key])}</span> : <span className="mist-note">—</span>, sortValue: (r: AgingRow) => r[b.key] })),
    { key: 'total', header: '未收合计', align: 'right', render: r => <b>{money(r.total)}</b>, sortValue: r => r.total },
  ];
  const progressColumns: Column<OrderProgressRow>[] = [
    { key: 'code', header: '订单', width: 'minmax(140px,1fr)', render: r => <Button variant="quiet" onClick={() => go('orders/detail', r.id)}>{r.code}</Button>, sortValue: r => r.code },
    { key: 'customer', header: '客户', width: 'minmax(140px,1.5fr)', render: r => r.customer },
    { key: 'due', header: '交期', width: '110px', render: r => r.due || '—', sortValue: r => r.due },
    { key: 'progress', header: '进度', width: '80px', align: 'right', render: r => r.progress + '%', sortValue: r => r.progress },
    { key: 'status', header: '交期状态', width: '120px', render: r => <Pill tone={PROGRESS_STATUS[r.status].tone}>{PROGRESS_STATUS[r.status].label}{r.status === 'overdue' ? ` ${r.lateDays} 天` : ''}</Pill> },
    { key: 'state', header: '当前环节', render: r => r.state },
  ];
  const exportCurrent = () => {
    if (tab === 'sales') downloadModuleCsv('客户销售额.csv', ['客户', '币种', '订单数', '订单金额', '已开票', '已收', '未收'], sales.map(r => [r.customer, r.currency, r.orders, r.amount, r.invoiced, r.received, r.open]));
    else if (tab === 'margin') downloadModuleCsv('订单毛利.csv', ['订单', '客户', '币种', '销售收入', '采购成本', '毛利', '毛利率%', '已到票', '说明', '异币种采购', '未批准采购数'], margin.map(r => [r.code, r.customer, r.currency, r.revenue, r.purchases ? r.cost : '', r.margin ?? '', r.rate === null ? '' : Math.round(r.rate * 1000) / 10, r.billed, MARGIN_STATUS[r.status].label, r.foreign, r.pending]));
    else if (tab === 'aging') downloadModuleCsv(`应收账龄-${asOf}.csv`, ['客户', '币种', ...AGING_BUCKETS.map(b => b.label), '未收合计'], aging.map(r => [r.customer, r.currency, ...AGING_BUCKETS.map(b => r[b.key]), r.total]));
    else downloadModuleCsv(`订单进度-${asOf}.csv`, ['订单', '客户', '交期', '进度%', '交期状态', '逾期天数', '当前环节'], shownProgress.map(r => [r.code, r.customer, r.due, r.progress, PROGRESS_STATUS[r.status].label, r.lateDays, r.state]));
  };

  return <MistPage>
    <PageHeader title="报表中心" description="基于当前工作空间的订单、采购与发票实时统计；金额按币种分别统计，不做汇率折算。" actions={<Button icon={Download} disabled={!state || ((tab === 'sales' || tab === 'margin') && invalid)} onClick={exportCurrent}>导出当前报表</Button>} />
    {workspace.error && <Banner tone="bad" title="读取失败">{workspace.error}</Banner>}
    <Tabs<ReportTab> value={tab} onChange={next => go('reports', undefined, { section: next })} options={[{ value: 'sales', label: '客户销售额' }, ...(canSeeMargin ? [{ value: 'margin' as const, label: '订单毛利' }] : []), { value: 'aging', label: '应收账龄' }, { value: 'orders', label: '订单进度与逾期', count: progress.filter(r => r.status === 'overdue').length || undefined }]} />
    <section className="mist-section">{tab === 'sales' ? <>
      <Toolbar><Field label="订单创建起日"><TextInput type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="订单创建止日"><TextInput type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>{currencyFilter}</Toolbar>
      {invalid && <Banner tone="bad" title="起始日期不能晚于结束日期" />}
      <StatGrid><StatCard icon={Package} label="订单金额" value={totals(sales, r => r.amount)} /><StatCard icon={Receipt} label="已收" value={totals(sales, r => r.received)} /><StatCard icon={Clock} label="未收" value={totals(sales, r => r.open)} /></StatGrid>
      <section className="mist-section"><Card><DataTable ariaLabel="客户销售额" rows={sales} rowKey={r => r.id} loading={workspace.loading} columns={salesColumns} empty={<EmptyState title="当前范围没有订单" description="调整日期或币种后重新查看。" />} /></Card></section>
      <p className="mist-note">按订单业务日期（北京时间）统计；已开票、已收、未收只计这些订单下的有效发票，作废发票不计。</p>
    </> : tab === 'margin' ? <>
      <Toolbar><Field label="订单创建起日"><TextInput type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="订单创建止日"><TextInput type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>{currencyFilter}</Toolbar>
      {invalid && <Banner tone="bad" title="起始日期不能晚于结束日期" />}
      <StatGrid>{marginTotals.length ? marginTotals.map(t => <StatCard key={t.currency} icon={TrendingUp} label={`${t.currency} 毛利 · ${t.orders} 单`} value={`${money(t.margin)}（${percent(t.rate)}）`} />) : <StatCard icon={TrendingUp} label="毛利" value="—" />}</StatGrid>
      <section className="mist-section"><Card><DataTable ariaLabel="订单毛利" rows={margin} rowKey={r => r.id} loading={workspace.loading} columns={marginColumns} empty={<EmptyState title="当前范围没有已生效订单" description="草稿、待审批或被退回的订单不计入毛利。" />} /></Card></section>
      <p className="mist-note">预估毛利 = 订单金额 − 已批准采购合同金额（同币种）。汇总只含“已计算”的订单；含异币种采购的订单不做汇率折算、不出毛利。采购价通常含税，未计出口退税、运费、报关、佣金与索赔扣款。“已到票”为供应商有效发票中登记到这些采购的金额。</p>
    </> : tab === 'aging' ? <>
      <Toolbar right={<span className="mist-note">截至 {asOf}</span>}>{currencyFilter}</Toolbar>
      <StatGrid>{AGING_BUCKETS.map(b => <StatCard key={b.key} icon={Clock} label={b.label} value={totals(aging, r => r[b.key])} />)}</StatGrid>
      <section className="mist-section"><Card><DataTable ariaLabel="应收账龄" rows={aging} rowKey={r => r.id} loading={workspace.loading} columns={agingColumns} empty={<EmptyState title="没有未收应收" description="有效发票均已收清。" />} /></Card></section>
      <div className="mist-row"><Button onClick={() => go('invoices')}>查看发票</Button><Button onClick={() => go('payment-vouchers')}>查看到账与核销</Button></div>
    </> : <>
      <Toolbar right={<span className="mist-note">截至 {asOf} · 只含进度未到 100% 的订单</span>}><Field label="交期状态"><Select aria-label="交期状态" value={progressFilter} onChange={e => setProgressFilter(e.target.value)} options={[{ value: '', label: '全部' }, ...Object.entries(PROGRESS_STATUS).map(([value, s]) => ({ value, label: s.label }))]} /></Field></Toolbar>
      <StatGrid>{(Object.keys(PROGRESS_STATUS) as Array<keyof typeof PROGRESS_STATUS>).map(k => <StatCard key={k} icon={Package} label={PROGRESS_STATUS[k].label} value={progress.filter(r => r.status === k).length} onClick={() => setProgressFilter(k)} />)}</StatGrid>
      <section className="mist-section"><Card><DataTable ariaLabel="订单进度" rows={shownProgress} rowKey={r => r.id} loading={workspace.loading} columns={progressColumns} empty={<EmptyState title="没有符合条件的未完成订单" />} /></Card></section>
    </>}</section>
  </MistPage>;
}
