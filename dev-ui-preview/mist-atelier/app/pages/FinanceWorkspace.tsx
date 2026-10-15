/** Four finance entrances. Only existing workspace facts are projected; unavailable accounting capabilities stay explicit. */
import React from 'react';
import { ArrowDownLeft, ArrowUpRight, Landmark, ReceiptText } from 'lucide-react';
import { Banner, Button, Card, DataTable, EmptyState, Facts, Mono, ObjectCell, Pill, SearchField, Segmented, StatCard, StatGrid, Tabs, Toolbar, type Column } from '../../../../components/mist';
import type { MistState, MistReceipt, MistPayment } from '../../../../server/src/shared/mistWorkspace';
import { isActiveMistInvoice, mistBankAccountBalances } from '../../../../server/src/shared/mistWorkspace';
import { AccountAssignDialog, BankAccountDialog, accountLabel, editAccountDraft, newAccountDraft, useBankAccountCommand } from './FinanceBankAccounts';
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
  const bank = state ? mistBankAccountBalances(state) : null, balances = financeCurrencyTotals((bank?.accounts || []).map(a => ({ currency: a.account.currency, amount: a.balance })));
  const unassigned = bank ? bank.unassigned.receipts + bank.unassigned.payments : 0;
  const stat = (totals: ReturnType<typeof financeCurrencyTotals>) => totals.length === 1 ? totals[0].amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : totals.length ? '按原币' : '暂无';
  return <div className="mist-section" data-finance-entrances>
    <StatGrid>
      <StatCard icon={ReceiptText} label="应收未收" value={stat(open)} unit={open.length === 1 ? open[0].currency : undefined} foot={totalsText(open)} onClick={() => onChange('receivables')} />
      <StatCard icon={ArrowUpRight} label="应付未付" value={stat(payable)} unit={payable.length === 1 ? payable[0].currency : undefined} foot={payable.length ? totalsText(payable) : '按已登记的供应商票据计算'} onClick={() => onChange('payables')} />
      <StatCard icon={ArrowDownLeft} label="未分配到账" value={stat(unallocated)} unit={unallocated.length === 1 ? unallocated[0].currency : undefined} foot={totalsText(unallocated)} onClick={() => onChange('records')} />
      <StatCard icon={Landmark} label="公司账户余额" value={bank?.accounts.length ? stat(balances) : '未登记账户'} unit={balances.length === 1 ? balances[0].currency : undefined} foot={bank?.accounts.length ? totalsText(balances) + (unassigned ? ` · ${unassigned} 笔流水未归属账户` : '') : '登记账户与期初后，按归属流水计算'} onClick={() => onChange('accounts')} />
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
  const [assigning, setAssigning] = React.useState(false), { canWrite } = useBankAccountCommand();
  const current = rows.find(r => r.id === selected), currentRow = current?.receipt || current?.payment, account = (state?.bankAccounts || []).find(a => a.id === currentRow?.accountId), supplierPayment = (state?.payables?.payments || []).find(p => p.paymentId === current?.id), allocations = (state?.allocations || []).filter(a => a.receiptId === current?.id);
  const columns: Column<FinanceRecord>[] = [
    { key: 'code', header: '流水 / 对方', width: 'minmax(170px,1.5fr)', render: r => <ObjectCell name={<Mono>{r.code}</Mono>} meta={r.party} /> },
    { key: 'date', header: '日期 / 方向', width: '108px', render: r => <span className="mist-col"><span>{r.date}</span><Pill tone={r.direction === 'receipt' ? 'accent' : 'neutral'}>{r.direction === 'receipt' ? '实际收款' : '付款记录'}</Pill></span> },
    { key: 'amount', header: '原币金额', width: '140px', align: 'right', render: r => <span className="mist-num">{money(r.amount, r.currency)}</span> },
    { key: 'ref', header: '银行参考 / 附言', width: 'minmax(130px,1fr)', hideOnMobile: true, render: r => r.ref || '未填写' },
    { key: 'account', header: '账户', width: '110px', hideOnMobile: true, render: r => { const a = (state?.bankAccounts || []).find(x => x.id === (r.receipt || r.payment)?.accountId); return a ? <Mono>{a.code}</Mono> : <Pill tone="warn">未归属</Pill>; } },
  ];
  const detail = current ? <DetailBody data-finance-record={current.id} heading={<h2 className="mist-h2">{current.code}</h2>}>
    <Facts items={[{ label: '方向', value: current.direction === 'receipt' ? '实际收款' : '已登记付款记录' }, { label: '交易日期', value: current.date }, { label: '付款方 / 收款方', value: current.party }, { label: '原币金额', value: money(current.amount, current.currency) }, { label: '银行参考 / 附言', value: current.ref || '未填写' }, { label: '公司银行账户', value: account ? `${account.code} · ${accountLabel(account)}` : '未归属' }]} />
    <ActionBar actions={[
      { label: account ? '调整归属账户' : '归属账户', onClick: () => setAssigning(true), reason: canWrite ? undefined : '需要付款凭证权限' },
      ...(current.receipt ? [{ label: '去收款核销', onClick: () => onReceipt(current.id) }] : [supplierPayment ? { label: '查看应付分配', onClick: () => go('payment-vouchers', supplierPayment.id, { section: 'payables' }) } : { label: '分配到应付', onClick: () => {}, reason: '这是未关联供应商的付款记录；供应商付款请在“应付待办”登记，才能分配到票据' }]),
      current.receipt ? { label: '核销冲回', onClick: () => onReceipt(current.id), reason: allocations.length ? undefined : '此流水没有有效核销，无需冲回' } : { label: '付款冲回', onClick: () => { if (supplierPayment) go('payment-vouchers', supplierPayment.id, { section: 'payables' }); }, reason: supplierPayment ? undefined : '在“收款核销 → 付款凭证”中逐张冲回，原凭证保留' },
    ]} />
    {current.receipt && <DetailBlock title="应收核销分配"><Facts items={[{ label: '当前未分配', value: money(current.receipt.remaining, current.currency) }, { label: '原始到账', value: money(current.amount, current.currency) }]} />
      {allocations.map(a => { const i = state?.invoices.find(i => i.id === a.invoiceId); return <div className="mist-col" key={a.id}><div className="mist-row mist-module-actions"><Mono>{i?.code || '来源票据未找到'}</Mono><span className="mist-num">{money(a.amount, a.currency)}</span>{i && <Button size="sm" onClick={() => go('payment-vouchers', i.id)}>查看票据</Button>}</div><span className="mist-note">{a.createdAt} · {a.actor}{a.payerBasis ? ` · ${a.payerBasis}` : ''}</span></div>; })}
      {!allocations.length && <span className="mist-note">尚未产生应收核销分配。</span>}
    </DetailBlock>}
    {!current.receipt && (supplierPayment ? <Banner title="供应商付款">已在应付待办登记，分配到票据的明细在那里查看；付出账户在上方“公司银行账户”归属。</Banner> : <Banner title="只读付款事实">本记录没有应付分配，不能据此推导供应商未付余额。</Banner>)}
  </DetailBody> : <EmptyState compact title={route.id ? '未找到交易记录' : '交易详情'} description="选择一笔记录查看原币金额、核销来源及归属账户。" />;
  return <div className="mist-col">
    <Toolbar><SearchField value={query} onChange={setQuery} placeholder="搜索流水号、对方、附言或日期" /><Button onClick={() => downloadMistCsv('收付款记录.csv', ['流水', '方向', '日期', '对方', '金额', '币种', '附言'], shown.map(r => [r.code, r.direction === 'receipt' ? '收款' : '付款', r.date, r.party, r.amount, r.currency, r.ref]))}>导出当前记录</Button></Toolbar>
    <Segmented<'all' | 'receipt' | 'payment'> value={direction} onChange={setDirection} options={[{ value: 'all', label: `全部 · ${rows.length}` }, { value: 'receipt', label: `收款 · ${rows.filter(r => r.direction === 'receipt').length}` }, { value: 'payment', label: `付款 · ${rows.filter(r => r.direction === 'payment').length}` }]} />
    <Segmented value={currency} onChange={setCurrency} options={[{ value: 'all', label: '全部币种' }, ...currencies.map(c => ({ value: c, label: c }))]} />
    {assigning && state && current && currentRow && <AccountAssignDialog state={state} kind={current.direction} row={currentRow} onClose={() => setAssigning(false)} />}
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
  const { canWrite } = useBankAccountCommand(), [editing, setEditing] = React.useState<ReturnType<typeof newAccountDraft> | null>(null);
  const bank = state ? mistBankAccountBalances(state) : { accounts: [], unassigned: { receipts: 0, payments: 0 } }, unassigned = bank.unassigned.receipts + bank.unassigned.payments;
  const used = (id?: string) => !!id && !!bank.accounts.find(a => a.account.id === id && a.receiptCount + a.paymentCount > 0);
  return <div className="mist-col">
    {!bank.accounts.length ? <Banner tone="warn" title="还没有登记公司银行账户">登记账户、币种和期初余额后，把收付款流水逐笔归属到账户，系统按“期初 + 归属到账 − 归属付款”计算余额；不会用全部收款减付款猜余额。</Banner>
      : unassigned > 0 ? <Banner tone="warn" title={`${unassigned} 笔流水还没有归属账户`}>未归属的 {bank.unassigned.receipts} 笔到账、{bank.unassigned.payments} 笔付款不计入任何账户余额，请在“收付款记录”逐笔归属。</Banner> : null}
    <ActionBar actions={[{ label: '新增账户', onClick: () => setEditing(newAccountDraft()), reason: canWrite ? undefined : '需要付款凭证权限' }, { label: '查看未归属流水', onClick: () => go('payment-vouchers', undefined, { section: 'records' }), hidden: !unassigned }, { label: '汇兑锁定 / 结汇记录', onClick: () => {}, reason: '汇兑与结汇服务尚未接入，不能自动按汇率折算余额' }]} />
    <Card><DataTable ariaLabel="公司银行账户" rows={bank.accounts} rowKey={r => r.account.id} loading={loading} onRowClick={r => { if (canWrite) setEditing(editAccountDraft(r.account)); }} columns={[
      { key: 'account', header: '账户', width: 'minmax(200px,1.6fr)', render: r => <ObjectCell name={<><Mono>{r.account.code}</Mono> {r.account.name}</>} meta={`${r.account.bankName} · ${r.account.accountNo} · 期初日 ${r.account.openingDate}`} /> },
      { key: 'opening', header: '期初', width: '150px', align: 'right', hideOnMobile: true, render: r => <span className="mist-num">{money(r.account.openingBalance, r.account.currency)}</span> },
      { key: 'in', header: '归属到账', width: '150px', align: 'right', hideOnMobile: true, render: r => <span className="mist-num" title={`${r.receiptCount} 笔`}>{money(r.receipts, r.account.currency)}</span> },
      { key: 'out', header: '归属付款', width: '150px', align: 'right', hideOnMobile: true, render: r => <span className="mist-num" title={`${r.paymentCount} 笔`}>{money(r.payments, r.account.currency)}</span> },
      { key: 'balance', header: '账户余额', width: '150px', align: 'right', render: r => <span className="mist-num">{money(r.balance, r.account.currency)}</span> },
    ]} empty={<EmptyState title="暂无公司银行账户" description="点上方“新增账户”登记账户与期初余额。" />} /></Card>
    {editing && <BankAccountDialog draft={editing} used={used(editing.id)} onClose={() => setEditing(null)} />}
    <Card><DataTable ariaLabel="客户应收余额（原币）" rows={customers} rowKey={r => r.id} loading={loading} onRowClick={r => { if (r.customerId) go('payment-vouchers', undefined, { section: 'open', customerId: r.customerId }); }} columns={[
      { key: 'customer', header: '客户', render: r => <ObjectCell name={r.name} meta={r.customerId ? '由来源订单确认客户' : '缺少来源客户标识，请核对'} /> },
      { key: 'count', header: '未结票据', width: '90px', align: 'right', render: r => r.invoices }, { key: 'amount', header: '未收余额', width: '150px', align: 'right', render: r => money(r.amount, r.currency) },
    ]} empty={<EmptyState title="暂无未结客户应收" />} /></Card>
    <Card><div className="mist-card-body mist-col"><h2 className="mist-h2">未分配到账（按原币）</h2>{financeCurrencyTotals((state?.receipts || []).filter(r => r.remaining > 0).map(r => ({ currency: r.currency, amount: r.remaining }))).map(t => <div className="mist-row" key={t.currency}><Mono>{t.currency}</Mono><span className="mist-num">{money(t.amount, t.currency)}</span><Button onClick={() => go('payment-vouchers', undefined, { section: 'records' })}>查看收付款记录</Button></div>)}<span className="mist-note">资金归属登记不等于核销，不再次叠加到未分配余额。</span></div></Card>
  </div>;
}
