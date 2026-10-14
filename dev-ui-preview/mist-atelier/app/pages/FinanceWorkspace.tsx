/** Four finance entrances. Only existing workspace facts are projected; unavailable accounting capabilities stay explicit. */
import React from 'react';
import { ArrowDownLeft, ArrowUpRight, Landmark, ReceiptText } from 'lucide-react';
import { Banner, Button, Card, DataTable, EmptyState, Facts, Mono, ObjectCell, Pill, SearchField, Segmented, StatCard, StatGrid, Tabs, Toolbar, type Column } from '../../../../components/mist';
import type { MistState, MistReceipt, MistPayment } from '../../../../server/src/shared/mistWorkspace';
import { isActiveMistInvoice } from '../../../../server/src/shared/mistWorkspace';
import { useMistWorkspace } from '../runtime/workspace';
import { useNav } from '../nav';
import { ActionBar, DetailBlock, DetailBody, ListDetail } from './modules/pageKit';
import { downloadMistCsv } from './OrderListPage';
import { platformBusinessDate } from '../../../../server/src/shared/mistPlatform';
import { supplierPayableSummary } from '../../../../server/src/shared/mistPayables';
export { FinancePayables } from './FinancePayables';

export type FinanceArea = 'receivables' | 'payables' | 'records' | 'accounts';
export function financeArea(section?: string): FinanceArea { return section === 'payables' || section === 'records' || section === 'accounts' ? section : 'receivables'; }
export function financeCurrencyTotals(rows: ReadonlyArray<{ currency: string; amount: number }>) {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) || 0) + Math.round(row.amount * 100));
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, minor]) => ({ currency, amount: minor / 100 }));
}
const money = (amount: number, currency: string) => `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const totalsText = (totals: ReturnType<typeof financeCurrencyTotals>) => totals.map(t => money(t.amount, t.currency)).join(' · ') || '暂无已登记金额';

export function FinanceEntrances({ state, area, onChange }: { state: MistState | null; area: FinanceArea; onChange: (area: FinanceArea) => void }) {
  const open = financeCurrencyTotals((state?.invoices || []).filter(i => isActiveMistInvoice(i) && i.open > 0).map(i => ({ currency: i.currency, amount: i.open })));
  const unallocated = financeCurrencyTotals((state?.receipts || []).filter(r => r.remaining > 0).map(r => ({ currency: r.currency, amount: r.remaining })));
  const payable = financeCurrencyTotals(state ? supplierPayableSummary(state, platformBusinessDate(new Date())).filter(r => r.open > 0).map(r => ({ currency: r.currency, amount: r.open })) : []);
  const stat = (totals: ReturnType<typeof financeCurrencyTotals>) => totals.length === 1 ? totals[0].amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : totals.length ? '按原币' : '暂无';
  return <div className="mist-section" data-finance-entrances>
    <StatGrid>
      <StatCard icon={ReceiptText} label="应收未收" value={stat(open)} unit={open.length === 1 ? open[0].currency : undefined} foot={totalsText(open)} onClick={() => onChange('receivables')} />
      <StatCard icon={ArrowUpRight} label="应付未付" value={stat(payable)} unit={payable.length === 1 ? payable[0].currency : undefined} foot={payable.length ? totalsText(payable) : '按已登记的供应商票据计算'} onClick={() => onChange('payables')} />
      <StatCard icon={ArrowDownLeft} label="未分配到账" value={stat(unallocated)} unit={unallocated.length === 1 ? unallocated[0].currency : undefined} foot={totalsText(unallocated)} onClick={() => onChange('records')} />
      <StatCard icon={Landmark} label="公司账户可用余额" value="未接入" foot="缺少账户、期初及交易归属，不能计算" onClick={() => onChange('accounts')} />
    </StatGrid>
    <Tabs<FinanceArea> value={area} onChange={onChange} options={[{ value: 'receivables', label: '应收待办' }, { value: 'payables', label: '应付待办' }, { value: 'records', label: '收付款记录' }, { value: 'accounts', label: '账户与余额' }]} />
  </div>;
}

type FinanceRecord = { id: string; code: string; date: string; party: string; amount: number; currency: string; ref: string; direction: 'receipt' | 'payment'; receipt?: MistReceipt; payment?: MistPayment };
export function financeRecords(state: MistState | null): FinanceRecord[] {
  return [
    ...(state?.receipts || []).map(r => ({ id: r.id, code: r.code, date: r.date, party: r.payer, amount: r.amount, currency: r.currency, ref: r.ref, direction: 'receipt' as const, receipt: r })),
    ...(state?.payments || []).map(p => ({ id: p.id, code: p.code, date: p.date, party: p.payee, amount: p.amount, currency: p.currency, ref: p.ref, direction: 'payment' as const, payment: p })),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.code.localeCompare(b.code));
}
export function FinanceRecords({ onReceipt }: { onReceipt: (id: string) => void }) {
  const { state, loading } = useMistWorkspace(), { route, go } = useNav();
  const [query, setQuery] = React.useState(''), [direction, setDirection] = React.useState<'all' | 'receipt' | 'payment'>('all'), [currency, setCurrency] = React.useState('all');
  const [selected, setSelected] = React.useState(route.id || ''), [drawer, setDrawer] = React.useState(!!route.id);
  React.useEffect(() => { setSelected(route.id || ''); setDrawer(!!route.id); }, [route.id]);
  const rows = financeRecords(state), currencies = [...new Set(rows.map(r => r.currency))].sort();
  const shown = rows.filter(r => (direction === 'all' || r.direction === direction) && (currency === 'all' || r.currency === currency) && (!query.trim() || `${r.code} ${r.party} ${r.ref} ${r.date}`.toLowerCase().includes(query.trim().toLowerCase())));
  const current = rows.find(r => r.id === selected), supplierPayment = (state?.payables?.payments || []).find(p => p.paymentId === current?.id), allocations = (state?.allocations || []).filter(a => a.receiptId === current?.id);
  const columns: Column<FinanceRecord>[] = [
    { key: 'code', header: '流水 / 对方', width: 'minmax(170px,1.5fr)', render: r => <ObjectCell name={<Mono>{r.code}</Mono>} meta={r.party} /> },
    { key: 'date', header: '日期 / 方向', width: '108px', render: r => <span className="mist-col"><span>{r.date}</span><Pill tone={r.direction === 'receipt' ? 'accent' : 'neutral'}>{r.direction === 'receipt' ? '实际收款' : '付款记录'}</Pill></span> },
    { key: 'amount', header: '原币金额', width: '140px', align: 'right', render: r => <span className="mist-num">{money(r.amount, r.currency)}</span> },
    { key: 'ref', header: '银行参考 / 附言', width: 'minmax(130px,1fr)', hideOnMobile: true, render: r => r.ref || '未填写' },
  ];
  const detail = current ? <DetailBody data-finance-record={current.id} heading={<h2 className="mist-h2">{current.code}</h2>}>
    <Facts items={[{ label: '方向', value: current.direction === 'receipt' ? '实际收款' : '已登记付款记录' }, { label: '交易日期', value: current.date }, { label: '付款方 / 收款方', value: current.party }, { label: '原币金额', value: money(current.amount, current.currency) }, { label: '银行参考 / 附言', value: current.ref || '未填写' }, { label: '公司银行账户', value: '未关联（账户台账尚未接入）' }]} />
    <ActionBar actions={[
      ...(current.receipt ? [{ label: '去收款核销', onClick: () => onReceipt(current.id) }] : [supplierPayment ? { label: '查看应付分配', onClick: () => go('payment-vouchers', supplierPayment.id, { section: 'payables' }) } : { label: '分配到应付', onClick: () => {}, reason: '这是未关联供应商的付款记录；供应商付款请在“应付待办”登记，才能分配到票据' }]),
      { label: '核销冲回', onClick: () => {}, reason: '冲回命令与原因留痕尚未接入，不能删除或改写原核销事实' },
    ]} />
    {current.receipt && <DetailBlock title="应收核销分配"><Facts items={[{ label: '当前未分配', value: money(current.receipt.remaining, current.currency) }, { label: '原始到账', value: money(current.amount, current.currency) }]} />
      {allocations.map(a => { const i = state?.invoices.find(i => i.id === a.invoiceId); return <div className="mist-col" key={a.id}><div className="mist-row mist-module-actions"><Mono>{i?.code || '来源票据未找到'}</Mono><span className="mist-num">{money(a.amount, a.currency)}</span>{i && <Button size="sm" onClick={() => go('payment-vouchers', i.id)}>查看票据</Button>}</div><span className="mist-note">{a.createdAt} · {a.actor}{a.payerBasis ? ` · ${a.payerBasis}` : ''}</span></div>; })}
      {!allocations.length && <span className="mist-note">尚未产生应收核销分配。</span>}
    </DetailBlock>}
    {!current.receipt && (supplierPayment ? <Banner title="供应商付款">已在应付待办登记，分配到票据的明细在那里查看；公司账户余额仍未接入。</Banner> : <Banner title="只读付款事实">本记录没有应付分配或公司账户信息，不能据此推导供应商未付余额或银行可用余额。</Banner>)}
  </DetailBody> : <EmptyState compact title={route.id ? '未找到交易记录' : '交易详情'} description="选择一笔记录查看原币金额、核销来源及未接入能力。" />;
  return <div className="mist-col">
    <Toolbar><SearchField value={query} onChange={setQuery} placeholder="搜索流水号、对方、附言或日期" /><Button onClick={() => downloadMistCsv('收付款记录.csv', ['流水', '方向', '日期', '对方', '金额', '币种', '附言'], shown.map(r => [r.code, r.direction === 'receipt' ? '收款' : '付款', r.date, r.party, r.amount, r.currency, r.ref]))}>导出当前记录</Button></Toolbar>
    <Segmented<'all' | 'receipt' | 'payment'> value={direction} onChange={setDirection} options={[{ value: 'all', label: `全部 · ${rows.length}` }, { value: 'receipt', label: `收款 · ${rows.filter(r => r.direction === 'receipt').length}` }, { value: 'payment', label: `付款 · ${rows.filter(r => r.direction === 'payment').length}` }]} />
    <Segmented value={currency} onChange={setCurrency} options={[{ value: 'all', label: '全部币种' }, ...currencies.map(c => ({ value: c, label: c }))]} />
    <ListDetail drawerOpen={drawer && !!current} drawerTitle={current?.code || '交易详情'} onDrawerClose={() => setDrawer(false)} detail={detail} list={<Card><DataTable ariaLabel="收付款记录" rows={shown} columns={columns} loading={loading} selectedKey={selected} rowKey={r => r.id} onRowClick={r => { setSelected(r.id); setDrawer(true); go('payment-vouchers', r.id, { section: 'records' }); }} empty={<EmptyState title={rows.length ? '没有符合条件的收付款记录' : '还没有收付款记录'} action={rows.length ? <Button onClick={() => { setQuery(''); setDirection('all'); setCurrency('all'); }}>清除筛选</Button> : undefined} />} /></Card>} />
  </div>;
}

export function financeCustomerReceivables(state: MistState | null) {
  const groups = new Map<string, { customerId: string; name: string; currency: string; amount: number; invoices: number }>();
  for (const i of state?.invoices || []) if (isActiveMistInvoice(i) && i.open > 0) {
    const order = state?.orders.find(o => o.id === i.orderId), customerId = order?.customerId || '', key = JSON.stringify([customerId || i.customer, i.currency]);
    const old = groups.get(key) || { customerId, name: i.customer, currency: i.currency, amount: 0, invoices: 0 };
    old.amount += Math.round(i.open * 100); old.invoices++; groups.set(key, old);
  }
  return [...groups.entries()].map(([id, g]) => ({ id, ...g, amount: g.amount / 100 }));
}
export function FinanceAccounts() {
  const { state, loading } = useMistWorkspace(), { go } = useNav(); const customers = financeCustomerReceivables(state);
  return <div className="mist-col"><Banner tone="warn" title="银行账户与可用余额尚未接入">缺少公司账户、币种期初余额和逐笔账户归属，不能把收款减付款当成公司银行余额。这里仅展示现有应收投影与未分配到账。</Banner>
    <ActionBar actions={[{ label: '登记期初余额', onClick: () => {}, reason: '账户及期初余额服务尚未接入' }, { label: '汇兑锁定 / 结汇记录', onClick: () => {}, reason: '汇兑与结汇服务尚未接入，不能自动按汇率折算余额' }]} />
    <Card><DataTable ariaLabel="客户应收余额（原币）" rows={customers} rowKey={r => r.id} loading={loading} onRowClick={r => { if (r.customerId) go('payment-vouchers', undefined, { section: 'open', customerId: r.customerId }); }} columns={[
      { key: 'customer', header: '客户', render: r => <ObjectCell name={r.name} meta={r.customerId ? '由来源订单确认客户' : '缺少来源客户标识，请核对'} /> },
      { key: 'count', header: '未结票据', width: '90px', align: 'right', render: r => r.invoices }, { key: 'amount', header: '未收余额', width: '150px', align: 'right', render: r => money(r.amount, r.currency) },
    ]} empty={<EmptyState title="暂无未结客户应收" />} /></Card>
    <Card><div className="mist-card-body mist-col"><h2 className="mist-h2">未分配到账（按原币）</h2>{financeCurrencyTotals((state?.receipts || []).filter(r => r.remaining > 0).map(r => ({ currency: r.currency, amount: r.remaining }))).map(t => <div className="mist-row" key={t.currency}><Mono>{t.currency}</Mono><span className="mist-num">{money(t.amount, t.currency)}</span><Button onClick={() => go('payment-vouchers', undefined, { section: 'records' })}>查看收付款记录</Button></div>)}<span className="mist-note">资金归属登记不等于核销，不再次叠加到未分配余额。供应商应付余额尚未接入。</span></div></Card>
  </div>;
}
