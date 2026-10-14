/** 应付待办：供应商票据 → 应付余额 → 实际付款与多票分配。只用已登记事实，不用合同金额猜应付。 */
import { MIST_FINANCE_SCOPES } from '../../../../server/src/shared/mistFinancePermissions';
import React from 'react';
import { Banner, Button, Card, CardHeader, Checkbox, DataTable, Dialog, EmptyState, Facts, Field, FormGrid, Mono, ObjectCell, Pill, Segmented, Select, TextArea, TextInput, useToast, type Column, type Tone } from '../../../../components/mist';
import { type MistState } from '../../../../server/src/shared/mistWorkspace';
import { platformBusinessDate } from '../../../../server/src/shared/mistPlatform';
import { payableBills, payableSources, supplierPayableSummary, supplierPayments, payablesCommandPermissions, type PayableBillView, type PayablesCommand, type SupplierPaymentView } from '../../../../server/src/shared/mistPayables';
import { useMistWorkspace } from '../runtime/workspace';
import { useMistSession } from '../runtime/auth';
import { useNav } from '../nav';
import { ActionBar, DetailBlock, DetailBody, ListDetail } from './modules/pageKit';
import { downloadMistCsv } from './OrderListPage';

type View = 'bills' | 'sources' | 'payments';
const STATUS: Record<PayableBillView['status'], { tone: Tone; label: string }> = { unpaid: { tone: 'warn', label: '未付款' }, partial: { tone: 'accent', label: '部分付款' }, paid: { tone: 'ok', label: '已付清' }, void: { tone: 'neutral', label: '已作废' } };
const KIND = { material: '采购', finished: '成品采购', processing: '委外加工' } as const;
export const apMoney = (amount: number, currency: string) => `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const cents = (value: string) => { const n = Number(value); return value.trim() && Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const today = () => platformBusinessDate(new Date());

/** 供应商下拉：来自已批准合同或已登记票据，按供应商标识去重。 */
export function payableSupplierOptions(state: MistState | null) {
  const map = new Map<string, string>();
  for (const p of state?.fulfillment.purchases || []) if (p.state === 'approved') map.set(p.supplierId, p.supplier);
  for (const b of state?.payables?.bills || []) map.set(b.supplierId, b.supplier);
  return [...map.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

type BillDraft = { supplierId: string; invoiceNo: string; invoiceDate: string; taxAmount: string; taxRate: string; due: string; dueBasis: string; note: string; lines: Record<string, string> };
type PayDraft = { paymentId?: string; supplierId: string; currency: string; date: string; amount: string; reference: string; note: string; allocations: Record<string, string> };

export function FinancePayables() {
  const { state, loading, run, saving, pending } = useMistWorkspace(), session = useMistSession(), { route, go } = useNav(), toast = useToast();
  const canBill = session.hasPermission(MIST_FINANCE_SCOPES.invoice), canPay = session.hasPermission(MIST_FINANCE_SCOPES.voucher), canAllocate = session.hasPermission(MIST_FINANCE_SCOPES.reconcile), day = today();
  const [view, setView] = React.useState<View>(() => route.id && (state?.payables?.payments || []).some(p => p.id === route.id) ? 'payments' : 'bills');
  const [selected, setSelected] = React.useState(route.id || ''), [drawer, setDrawer] = React.useState(!!route.id);
  const [filter, setFilter] = React.useState<'open' | 'overdue' | 'all'>('open');
  const [billDraft, setBillDraft] = React.useState<BillDraft | null>(null), [payDraft, setPayDraft] = React.useState<PayDraft | null>(null), [voidDraft, setVoidDraft] = React.useState<{ id: string; reason: string } | null>(null);
  const [working, setWorking] = React.useState(false), [failure, setFailure] = React.useState('');
  const busy = working || loading || saving || !!pending;
  React.useEffect(() => { setSelected(route.id || ''); setDrawer(!!route.id); }, [route.id]);

  const bills = state ? payableBills(state, day) : [], payments = state ? supplierPayments(state) : [], sources = state ? payableSources(state) : [], summary = state ? supplierPayableSummary(state, day) : [];
  const suppliers = payableSupplierOptions(state);
  const shownBills = bills.filter(b => filter === 'all' || (filter === 'open' ? b.open > 0 : b.overdue));
  const bill = bills.find(b => b.id === selected), payment = payments.find(p => p.id === selected);
  const open = (id: string) => { setSelected(id); setDrawer(true); go('payment-vouchers', id, { section: 'payables' }); };

  const execute = async (command: PayablesCommand, done: (result: Record<string, unknown>) => void) => {
    if (payablesCommandPermissions(command).some(permission => !session.hasPermission(permission as any))) { setFailure('没有办理此项财务动作的权限。'); return; }
    if (busy) return; setWorking(true); setFailure('');
    try { const receipt = await run(command as any); done(receipt.result as Record<string, unknown>); } catch (problem) { setFailure(problem instanceof Error ? problem.message : '操作失败，请重试'); } finally { setWorking(false); }
  };

  const startBill = (supplierId = '', purchaseId = '') => {
    const src = sources.find(s => s.purchase.id === purchaseId);
    setFailure(''); setBillDraft({ supplierId: supplierId || src?.purchase.supplierId || '', invoiceNo: '', invoiceDate: day, taxAmount: '', taxRate: '13%', due: '', dueBasis: src ? '合同付款条件：' + (src.purchase.terms || '未填写') : '', note: '', lines: src ? { [src.purchase.id]: String(src.uninvoiced) } : {} });
  };
  const startPay = (supplierId = '', billId = '') => {
    const b = bills.find(x => x.id === billId); setFailure('');
    setPayDraft({ supplierId: supplierId || b?.supplierId || '', currency: b?.currency || 'CNY', date: day, amount: b ? String(b.open) : '', reference: '', note: '', allocations: b && canAllocate ? { [b.id]: String(b.open) } : {} });
  };
  const startAllocate = (p: SupplierPaymentView) => { setFailure(''); setPayDraft({ paymentId: p.id, supplierId: p.supplierId, currency: p.currency, date: p.date, amount: String(p.amount), reference: p.reference, note: '', allocations: {} }); };

  // —— 登记票据表单的派生数据
  const billSources = billDraft ? sources.filter(s => s.purchase.supplierId === billDraft.supplierId && s.uninvoiced > 0) : [];
  const picked = billDraft ? Object.keys(billDraft.lines).filter(id => billSources.some(s => s.purchase.id === id)) : [];
  const billCurrency = picked.length ? sources.find(s => s.purchase.id === picked[0])!.purchase.currency : '';
  const billTotal = billDraft ? picked.reduce((n, id) => n + (cents(billDraft.lines[id]) || 0), 0) : 0;
  const submitBill = () => {
    if (!billDraft) return;
    if (!billDraft.supplierId || !billDraft.invoiceNo.trim() || !billDraft.invoiceDate || !billDraft.due || !billDraft.dueBasis.trim()) return setFailure('请填写供应商、发票号、发票日期、到期日和到期日依据。');
    if (!picked.length) return setFailure('请至少勾选一张来源合同，并写明本票对应金额。');
    if (picked.some(id => !(cents(billDraft.lines[id]) > 0))) return setFailure('每张勾选合同的对应金额都要大于零。');
    const tax = billDraft.taxAmount.trim() ? cents(billDraft.taxAmount) : 0; if (Number.isNaN(tax)) return setFailure('税额格式无效。');
    void execute({ type: 'payable.bill.register', payload: { supplierId: billDraft.supplierId, invoiceNo: billDraft.invoiceNo, invoiceDate: billDraft.invoiceDate, currency: billCurrency, amount: billTotal / 100, taxAmount: tax / 100, taxRate: billDraft.taxRate, lines: picked.map(id => ({ purchaseId: id, amount: cents(billDraft.lines[id]) / 100 })), due: billDraft.due, dueBasis: billDraft.dueBasis, note: billDraft.note } }, r => { setBillDraft(null); setView('bills'); open(String(r.id)); toast('供应商票据已登记，应付已形成'); });
  };

  // —— 付款 / 分配表单
  const existing = payDraft?.paymentId ? payments.find(p => p.id === payDraft.paymentId) : undefined;
  const payBills = payDraft ? bills.filter(b => b.supplierId === payDraft.supplierId && b.currency === payDraft.currency && b.open > 0) : [];
  const payCurrencies = payDraft ? [...new Set([...bills.filter(b => b.supplierId === payDraft.supplierId).map(b => b.currency), ...sources.filter(s => s.purchase.supplierId === payDraft.supplierId).map(s => s.purchase.currency), payDraft.currency])].sort() : [];
  const allocRows = payDraft ? payBills.filter(b => (payDraft.allocations[b.id] || '').trim()).map(b => ({ billId: b.id, amount: cents(payDraft.allocations[b.id]) })) : [];
  const allocTotal = allocRows.reduce((n, r) => n + (r.amount || 0), 0);
  const payable = existing ? Math.round(existing.unallocated * 100) : cents(payDraft?.amount || '');
  const submitPay = () => {
    if (!payDraft) return;
    if (allocRows.some(r => !(r.amount > 0))) return setFailure('分配金额必须大于零。');
    if (allocRows.some(r => r.amount > Math.round(payBills.find(b => b.id === r.billId)!.open * 100))) return setFailure('分配金额不能超过票据未付余额。');
    if (Number.isFinite(payable) && allocTotal > payable) return setFailure('分配合计超过付款金额。');
    const allocations = allocRows.map(r => ({ billId: r.billId, amount: r.amount / 100 }));
    if (existing) { if (!allocations.length) return setFailure('请至少给一张票据填写分配金额。'); void execute({ type: 'payable.payment.allocate', payload: { supplierPaymentId: existing.id, allocations } }, () => { setPayDraft(null); toast('付款已分配到应付'); }); return; }
    if (!payDraft.supplierId || !payDraft.date || !(payable > 0) || !payDraft.reference.trim()) return setFailure('请填写收款供应商、付款日期、大于零的金额和银行流水号。');
    void execute({ type: 'payable.payment.register', payload: { supplierId: payDraft.supplierId, date: payDraft.date, amount: payable / 100, currency: payDraft.currency, reference: payDraft.reference, note: payDraft.note, allocations } }, r => { setPayDraft(null); setView('payments'); open(String(r.id)); toast(allocations.length ? '付款已登记并分配' : '付款已登记，金额暂留未分配'); });
  };

  const billColumns: Column<PayableBillView>[] = [
    { key: 'code', header: '应付 / 供应商', width: 'minmax(170px,1.4fr)', render: b => <ObjectCell name={<Mono>{b.code}</Mono>} meta={b.supplier + ' · 发票 ' + b.invoiceNo} /> },
    { key: 'due', header: '到期日', width: '112px', render: b => <span className="mist-col"><span>{b.due}</span>{b.overdue && <Pill tone="bad">已逾期</Pill>}</span> },
    { key: 'amount', header: '票据金额', width: '140px', align: 'right', hideOnMobile: true, render: b => <span className="mist-num">{apMoney(b.amount, b.currency)}</span> },
    { key: 'open', header: '未付余额', width: '140px', align: 'right', render: b => <span className="mist-num">{apMoney(b.open, b.currency)}</span> },
    { key: 'state', header: '状态', width: '96px', render: b => <Pill tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Pill> },
  ];
  const sourceColumns: Column<(typeof sources)[number]>[] = [
    { key: 'code', header: '来源合同', width: 'minmax(160px,1.3fr)', render: r => <ObjectCell name={<Mono>{r.purchase.code}</Mono>} meta={r.purchase.supplier + ' · ' + KIND[r.purchase.kind]} /> },
    { key: 'terms', header: '合同付款条件', width: 'minmax(140px,1fr)', hideOnMobile: true, render: r => r.purchase.terms || '未填写' },
    { key: 'contract', header: '合同金额', width: '140px', align: 'right', hideOnMobile: true, render: r => <span className="mist-num">{apMoney(r.contract, r.purchase.currency)}</span> },
    { key: 'uninvoiced', header: '还没收到票', width: '140px', align: 'right', render: r => <span className="mist-num">{apMoney(r.uninvoiced, r.purchase.currency)}</span> },
    { key: 'act', header: '', width: '112px', render: r => <Button size="sm" disabled={busy || !canBill || r.uninvoiced <= 0} title={!canBill ? '需要票据登记权限' : undefined} onClick={event => { event.stopPropagation(); startBill(r.purchase.supplierId, r.purchase.id); }}>登记票据</Button> },
  ];
  const paymentColumns: Column<SupplierPaymentView>[] = [
    { key: 'code', header: '付款 / 供应商', width: 'minmax(170px,1.4fr)', render: p => <ObjectCell name={<Mono>{p.code}</Mono>} meta={p.supplier + ' · ' + p.reference} /> },
    { key: 'date', header: '付款日期', width: '108px', render: p => p.date },
    { key: 'amount', header: '付款金额', width: '140px', align: 'right', render: p => <span className="mist-num">{apMoney(p.amount, p.currency)}</span> },
    { key: 'un', header: '未分配', width: '130px', align: 'right', render: p => p.unallocated > 0 ? <Pill tone="warn">{apMoney(p.unallocated, p.currency)}</Pill> : <span className="mist-note">已分完</span> },
  ];

  const allocations = state?.payables?.allocations || [];
  const detail = bill ? <DetailBody data-payable-bill={bill.id} heading={<h2 className="mist-h2">{bill.code}</h2>}>
    <Facts items={[
      { label: '供应商', value: bill.supplier }, { label: '供应商发票号', value: <Mono>{bill.invoiceNo}</Mono> }, { label: '发票日期', value: bill.invoiceDate },
      { label: '价税合计', value: apMoney(bill.amount, bill.currency) }, { label: '税额 / 税率', value: apMoney(bill.taxAmount, bill.currency) + ' · ' + (bill.taxRate || '未填写') },
      { label: '已付 / 未付', value: apMoney(bill.paid, bill.currency) + ' / ' + apMoney(bill.open, bill.currency) },
      { label: '到期日', value: bill.due + (bill.overdue ? '（已逾期）' : '') }, { label: '到期日依据', value: bill.dueBasis }, { label: '登记', value: bill.registeredBy + ' · ' + bill.registeredAt.slice(0, 10) },
    ]} />
    {bill.status === 'void' && <Banner title="已作废">{bill.voided?.reason}（{bill.voided?.actor} · {bill.voided?.at.slice(0, 10)}），不再计入应付；原记录保留。</Banner>}
    <ActionBar busy={busy} actions={[
      { label: '登记付款', onClick: () => startPay(bill.supplierId, bill.id), reason: !canPay ? '需要付款登记权限' : bill.open <= 0 ? '本票已无未付余额' : undefined, hidden: bill.status === 'void' },
      { label: '作废票据', onClick: () => { setFailure(''); setVoidDraft({ id: bill.id, reason: '' }); }, reason: !canBill ? '需要票据登记权限' : bill.paid > 0 ? '已有付款分配，付款冲回尚未接入，不能直接作废' : undefined, hidden: bill.status === 'void' },
    ]} />
    <DetailBlock title="来源合同">{bill.lines.map(l => <div className="mist-row mist-module-actions" key={l.purchaseId}><Mono>{l.purchaseCode}</Mono><span className="mist-note">{KIND[l.kind]}</span><span className="mist-spacer" /><span className="mist-num">{apMoney(l.amount, bill.currency)}</span><Button size="sm" onClick={() => go('procurement', l.purchaseId)}>查看合同</Button></div>)}
      <span className="mist-note">合同付款条件：{bill.terms.join('；') || '未填写'}</span></DetailBlock>
    <DetailBlock title="付款分配">{allocations.filter(a => a.billId === bill.id).map(a => { const p = payments.find(x => x.id === a.supplierPaymentId); return <div className="mist-row mist-module-actions" key={a.id}><Mono>{p?.code || '付款记录未找到'}</Mono><span className="mist-note">{p?.date}</span><span className="mist-spacer" /><span className="mist-num">{apMoney(a.amount, a.currency)}</span>{p && <Button size="sm" onClick={() => { setView('payments'); open(p.id); }}>查看付款</Button>}</div>; })}
      {!allocations.some(a => a.billId === bill.id) && <span className="mist-note">还没有付款分配到这张票。</span>}</DetailBlock>
  </DetailBody> : payment ? <DetailBody data-supplier-payment={payment.id} heading={<h2 className="mist-h2">{payment.code}</h2>}>
    <Facts items={[{ label: '收款供应商', value: payment.supplier }, { label: '付款日期', value: payment.date }, { label: '付款金额', value: apMoney(payment.amount, payment.currency) }, { label: '银行流水号', value: <Mono>{payment.reference}</Mono> }, { label: '已分配 / 未分配', value: apMoney(payment.allocated, payment.currency) + ' / ' + apMoney(payment.unallocated, payment.currency) }, { label: '登记', value: payment.actor + ' · ' + payment.createdAt.slice(0, 10) }, ...(payment.note ? [{ label: '备注', value: payment.note }] : [])]} />
    {payment.unallocated > 0 && <Banner tone="warn" title="还有钱没分到票据上">未分配金额保留在这家供应商名下，不会自动配；收到新票或核对后再分配。</Banner>}
    <ActionBar busy={busy} actions={[{ label: '分配到应付', onClick: () => startAllocate(payment), reason: !canAllocate ? '需要核销分配权限' : payment.unallocated <= 0 ? '这笔付款已全部分配' : undefined }, { label: '付款冲回', onClick: () => {}, reason: '冲回命令与原因留痕尚未接入，不能删除或改写原付款事实' }]} />
    <DetailBlock title="分配到的票据">{allocations.filter(a => a.supplierPaymentId === payment.id).map(a => { const b = bills.find(x => x.id === a.billId); return <div className="mist-row mist-module-actions" key={a.id}><Mono>{b?.code || '票据未找到'}</Mono><span className="mist-note">{b ? '发票 ' + b.invoiceNo : ''}</span><span className="mist-spacer" /><span className="mist-num">{apMoney(a.amount, a.currency)}</span>{b && <Button size="sm" onClick={() => { setView('bills'); open(b.id); }}>查看票据</Button>}</div>; })}
      {!allocations.some(a => a.supplierPaymentId === payment.id) && <span className="mist-note">尚未分配。</span>}</DetailBlock>
  </DetailBody> : <EmptyState compact title={route.id ? '未找到应付记录' : '应付详情'} description="选择一张票据或一笔付款，查看来源合同、付款分配和余额。" />;

  const list = view === 'bills' ? <DataTable ariaLabel="应付票据" rows={shownBills} columns={billColumns} loading={loading} rowKey={b => b.id} selectedKey={selected} onRowClick={b => open(b.id)}
      empty={bills.length ? <EmptyState compact title="没有符合筛选的票据" action={<Button onClick={() => setFilter('all')}>查看全部</Button>} /> : <EmptyState title="还没有登记供应商票据" description="收到供应商的增值税发票后，在“待登记来源”里找到对应合同登记。" />} />
    : view === 'sources' ? <DataTable ariaLabel="待登记来源合同" rows={sources} columns={sourceColumns} loading={loading} rowKey={r => r.purchase.id} onRowClick={r => go('procurement', r.purchase.id)} empty={<EmptyState title="暂无已批准的采购 / 加工合同" description="合同批准后才可登记供应商票据。" />} />
    : <DataTable ariaLabel="供应商付款" rows={payments} columns={paymentColumns} loading={loading} rowKey={p => p.id} selectedKey={selected} onRowClick={p => open(p.id)} empty={<EmptyState title="还没有供应商付款" description="实际付款后在这里登记，并分配到一张或多张票据。" />} />;

  return <div className="mist-col" data-finance-payables>
    {failure && !billDraft && !payDraft && !voidDraft && <Banner tone="bad" title="操作没有完成">{failure}</Banner>}
    <Card>
      <CardHeader title="供应商应付（按原币）" sub="收到供应商发票登记后才形成应付；付款另记并分到票据" tools={<div className="mist-row" style={{ flexWrap: 'wrap' }}>
        <Button disabled={busy || !canBill} title={!canBill ? '需要票据登记权限' : undefined} onClick={() => startBill()}>登记供应商票据</Button>
        <Button disabled={busy || !canPay} title={!canPay ? '需要付款登记权限' : undefined} onClick={() => startPay()}>登记供应商付款</Button></div>} />
      <div className="mist-card-body mist-col">
      {summary.length ? <DataTable ariaLabel="供应商应付汇总" rows={summary} rowKey={r => r.supplierId + r.currency} columns={[
        { key: 's', header: '供应商', render: r => <ObjectCell name={r.supplier} meta={r.bills ? r.bills + ' 张未付清' + (r.overdue ? ' · ' + r.overdue + ' 张逾期' : '') : '已全部付清'} /> },
        { key: 'open', header: '未付余额', width: '150px', align: 'right', render: r => <span className="mist-num">{apMoney(r.open, r.currency)}</span> },
        { key: 'paid', header: '已付', width: '140px', align: 'right', hideOnMobile: true, render: r => <span className="mist-num">{apMoney(r.paid, r.currency)}</span> },
        { key: 'un', header: '未分配付款', width: '140px', align: 'right', render: r => r.unallocated > 0 ? <span className="mist-num">{apMoney(r.unallocated, r.currency)}</span> : '—' },
      ]} /> : <span className="mist-note">还没有登记供应商票据。合同金额不是应付；收到供应商发票登记后才形成应付余额。</span>}
    </div></Card>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}>
      <Segmented<View> value={view} onChange={v => { setView(v); setSelected(''); setDrawer(false); }} options={[{ value: 'bills', label: `应付票据 · ${bills.filter(b => b.open > 0).length}` }, { value: 'sources', label: `待登记来源 · ${sources.filter(s => s.uninvoiced > 0).length}` }, { value: 'payments', label: `供应商付款 · ${payments.length}` }]} />
      {view === 'bills' && <Segmented<'open' | 'overdue' | 'all'> value={filter} onChange={setFilter} options={[{ value: 'open', label: '未付清' }, { value: 'overdue', label: `已逾期 · ${bills.filter(b => b.overdue).length}` }, { value: 'all', label: '全部' }]} />}
      <span className="mist-spacer" />
      {view === 'bills' && <Button onClick={() => downloadMistCsv('供应商应付.csv', ['应付号', '供应商', '发票号', '发票日期', '币种', '价税合计', '税额', '已付', '未付', '到期日', '状态', '来源合同'], shownBills.map(b => [b.code, b.supplier, b.invoiceNo, b.invoiceDate, b.currency, b.amount, b.taxAmount, b.paid, b.open, b.due, STATUS[b.status].label, b.lines.map(l => l.purchaseCode + ':' + l.amount).join(' / ')]))}>导出当前票据</Button>}
    </div>
    <ListDetail drawerOpen={drawer && !!(bill || payment)} drawerTitle={bill?.code || payment?.code || '应付详情'} onDrawerClose={() => setDrawer(false)} list={<Card>{list}</Card>} detail={detail} />

    <Dialog open={!!billDraft} onClose={() => { if (!busy) setBillDraft(null); }} width={760} title="登记供应商票据" description="收到供应商开给我们的增值税发票后登记。登记后形成应付；不改变采购 / 加工的交付状态。"
      footer={<><Button disabled={busy} onClick={() => setBillDraft(null)}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !canBill} onClick={submitBill}>登记应付</Button></>}>
      {billDraft && <div className="mist-col">
        {failure && <Banner tone="bad" title="还不能登记">{failure}</Banner>}
        <FormGrid>
          <Field label="供应商" required><Select aria-label="供应商" value={billDraft.supplierId} options={[{ value: '', label: '请选择供应商' }, ...suppliers]} onChange={e => setBillDraft({ ...billDraft, supplierId: e.target.value, lines: {} })} /></Field>
          <Field label="供应商发票号" required><TextInput aria-label="供应商发票号" value={billDraft.invoiceNo} onChange={e => setBillDraft({ ...billDraft, invoiceNo: e.target.value })} /></Field>
        </FormGrid>
        <Field label="这张票对应哪些合同" required hint={billCurrency ? '同一张票只能对应同币种合同（' + billCurrency + '）' : '勾选合同并写明本票对应金额，不能只挂供应商总额'}>
          <div className="mist-col">{billSources.map(s => { const on = s.purchase.id in billDraft.lines, other = !!billCurrency && s.purchase.currency !== billCurrency; return <div className="mist-row" key={s.purchase.id} data-bill-source={s.purchase.id}>
            <Checkbox checked={on} disabled={other && !on} onChange={v => { const lines = { ...billDraft.lines }; if (v) lines[s.purchase.id] = String(s.uninvoiced); else delete lines[s.purchase.id]; setBillDraft({ ...billDraft, lines, dueBasis: billDraft.dueBasis || '合同付款条件：' + (s.purchase.terms || '未填写') }); }} label={<span><Mono>{s.purchase.code}</Mono> · {s.purchase.description} · 还没收到票 {apMoney(s.uninvoiced, s.purchase.currency)}</span>} />
            <span className="mist-spacer" />{on && <TextInput aria-label={s.purchase.code + ' 本票金额'} type="number" min="0.01" step="0.01" style={{ width: 140 }} value={billDraft.lines[s.purchase.id]} onChange={e => setBillDraft({ ...billDraft, lines: { ...billDraft.lines, [s.purchase.id]: e.target.value } })} />}
          </div>; })}
          {billDraft.supplierId && !billSources.length && <span className="mist-note">这家供应商没有还能登记票据的已批准合同。</span>}
          {!billDraft.supplierId && <span className="mist-note">先选择供应商。</span>}</div>
        </Field>
        <FormGrid cols={3}>
          <Field label="价税合计"><TextInput aria-label="价税合计" readOnly value={picked.length ? apMoney(billTotal / 100, billCurrency) : '—'} /></Field>
          <Field label="税额"><TextInput aria-label="税额" type="number" min="0" step="0.01" value={billDraft.taxAmount} onChange={e => setBillDraft({ ...billDraft, taxAmount: e.target.value })} /></Field>
          <Field label="税率"><TextInput aria-label="税率" value={billDraft.taxRate} onChange={e => setBillDraft({ ...billDraft, taxRate: e.target.value })} /></Field>
          <Field label="发票日期" required><TextInput aria-label="发票日期" type="date" max={day} value={billDraft.invoiceDate} onChange={e => setBillDraft({ ...billDraft, invoiceDate: e.target.value })} /></Field>
          <Field label="到期日" required><TextInput aria-label="到期日" type="date" value={billDraft.due} onChange={e => setBillDraft({ ...billDraft, due: e.target.value })} /></Field>
        </FormGrid>
        <Field label="到期日依据" required hint="按合同付款条件推算，写清楚怎么算的"><TextInput aria-label="到期日依据" value={billDraft.dueBasis} onChange={e => setBillDraft({ ...billDraft, dueBasis: e.target.value })} /></Field>
        <Field label="备注"><TextArea aria-label="备注" rows={2} value={billDraft.note} onChange={e => setBillDraft({ ...billDraft, note: e.target.value })} /></Field>
      </div>}
    </Dialog>

    <Dialog open={!!payDraft} onClose={() => { if (!busy) setPayDraft(null); }} width={760} title={existing ? '分配付款到应付' : '登记供应商付款'} description={existing ? `${existing.code} · 还有 ${apMoney(existing.unallocated, existing.currency)} 未分配` : '登记已经实际付出的款。可以分到同一供应商、同币种的多张票据；没分完的钱会保留，不自动配。'}
      footer={<><Button disabled={busy} onClick={() => setPayDraft(null)}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !(existing ? canAllocate : canPay)} onClick={submitPay}>{existing ? '确认分配' : '登记付款'}</Button></>}>
      {payDraft && <div className="mist-col">
        {failure && <Banner tone="bad" title="还不能保存">{failure}</Banner>}
        {!existing && <FormGrid cols={3}>
          <Field label="收款供应商" required><Select aria-label="收款供应商" value={payDraft.supplierId} options={[{ value: '', label: '请选择供应商' }, ...suppliers]} onChange={e => setPayDraft({ ...payDraft, supplierId: e.target.value, allocations: {} })} /></Field>
          <Field label="币种" required><Select aria-label="币种" value={payDraft.currency} options={payCurrencies} onChange={e => setPayDraft({ ...payDraft, currency: e.target.value, allocations: {} })} /></Field>
          <Field label="付款日期" required><TextInput aria-label="付款日期" type="date" max={day} value={payDraft.date} onChange={e => setPayDraft({ ...payDraft, date: e.target.value })} /></Field>
          <Field label="付款金额" required><TextInput aria-label="付款金额" type="number" min="0.01" step="0.01" value={payDraft.amount} onChange={e => setPayDraft({ ...payDraft, amount: e.target.value })} /></Field>
          <Field label="银行流水号 / 参考号" required><TextInput aria-label="银行流水号" value={payDraft.reference} onChange={e => setPayDraft({ ...payDraft, reference: e.target.value })} /></Field>
          <Field label="备注"><TextInput aria-label="付款备注" value={payDraft.note} onChange={e => setPayDraft({ ...payDraft, note: e.target.value })} /></Field>
        </FormGrid>}
        <Field label="分配到票据" hint={`已分配 ${apMoney(allocTotal / 100, payDraft.currency)} · 未分配 ${Number.isFinite(payable) ? apMoney(Math.max(0, payable - allocTotal) / 100, payDraft.currency) : '—'}`}>
          {!canAllocate && <span className="mist-note">当前账号没有核销分配权限；付款仅登记为未分配，不会自动核销。</span>}
          <div className="mist-col">{payBills.map(b => <div className="mist-row" key={b.id} data-pay-bill={b.id}><Mono>{b.code}</Mono><span className="mist-note">发票 {b.invoiceNo} · 到期 {b.due}{b.overdue ? '（逾期）' : ''} · 未付 {apMoney(b.open, b.currency)}</span><span className="mist-spacer" />
            <TextInput aria-label={b.code + ' 分配金额'} type="number" min="0.01" step="0.01" disabled={busy || !canAllocate} style={{ width: 140 }} value={payDraft.allocations[b.id] || ''} onChange={e => setPayDraft({ ...payDraft, allocations: { ...payDraft.allocations, [b.id]: e.target.value } })} /></div>)}
          {!payBills.length && <span className="mist-note">{payDraft.supplierId ? '这家供应商没有该币种的未付票据；付款可以先登记，金额保留为未分配。' : '先选择供应商。'}</span>}</div>
        </Field>
      </div>}
    </Dialog>

    <Dialog open={!!voidDraft} onClose={() => { if (!busy) setVoidDraft(null); }} title="作废供应商票据" tone="bad" description="作废后不再计入应付，合同可重新登记票据；原记录保留，不删除。"
      footer={<><Button disabled={busy} onClick={() => setVoidDraft(null)}>取消</Button><Button variant="danger" loading={busy} disabled={busy || !canBill || !voidDraft?.reason.trim()} onClick={() => voidDraft && void execute({ type: 'payable.bill.void', payload: voidDraft }, () => { setVoidDraft(null); toast('票据已作废'); })}>确认作废</Button></>}>
      {voidDraft && <div className="mist-col">{failure && <Banner tone="bad" title="未能作废">{failure}</Banner>}<Field label="作废原因" required><TextArea aria-label="作废原因" rows={3} value={voidDraft.reason} onChange={e => setVoidDraft({ ...voidDraft, reason: e.target.value })} /></Field></div>}
    </Dialog>
  </div>;
}
