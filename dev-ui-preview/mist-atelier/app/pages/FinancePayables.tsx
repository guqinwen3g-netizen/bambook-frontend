/** 应付待办：供应商票据 → 应付余额 → 付款申请（主管审批）→ 实际付款与多票分配。只用已登记事实，不用合同金额猜应付。
 *  预付款：财务按合同登记预付计划 → 申请 → 主管审批 → 实付；预付挂在合同上等结算抵扣。登记错误由财务冲回，原记录保留。 */
import { MIST_FINANCE_SCOPES } from '../../../../server/src/shared/mistFinancePermissions';
import React from 'react';
import { Banner, Button, Card, CardHeader, Checkbox, DataTable, Dialog, EmptyState, Facts, Field, FormGrid, Mono, ObjectCell, Pill, Segmented, Select, TextArea, TextInput, useToast, type Column, type Tone } from '../../../../components/mist';
import { type MistState } from '../../../../server/src/shared/mistWorkspace';
import { platformBusinessDate } from '../../../../server/src/shared/mistPlatform';
import { payableBills, payableSources, supplierPayableSummary, supplierPayments, payablesCommandPermissions, prepaymentPlans, paymentRequests, billRequestedUnpaidMinor, PAYMENT_REQUEST_SCOPES, SETTLEMENT_SCOPES, supplierSettlements, invoiceableSettlements, purchaseRequiresSettlementLink, paymentPlanStageLabel, type PaymentPlanStage, type PayableBillView, type PayablesCommand, type SupplierPaymentView, type PaymentRequest, type PrepaymentPlanView, purchasePrepaymentReadback, supplierDeductions, deductibleRecoveries, supplierSettlements as settlementsOf, type PrepaymentMove } from '../../../../server/src/shared/mistPayables';
import { useMistWorkspace } from '../runtime/workspace';
import { useMistSession } from '../runtime/auth';
import { useNav } from '../nav';
import { ActionBar, DetailBlock, DetailBody, ListDetail } from './modules/pageKit';
import { downloadMistCsv } from './OrderListPage';
import { SettlementConfirmDialog, SettlementDetail, SettlementSubmitDialog, settlementColumns } from './FinanceSettlements';
import { BillLinkDialog, DeductionDialog, DeductionList, PrepaymentMoveDialog, PrepaymentResidual } from './FinanceCloseout';

type View = 'bills' | 'requests' | 'settlements' | 'prepay' | 'sources' | 'payments';
const REQ: Record<PaymentRequest['state'], { tone: Tone; label: string }> = { pending: { tone: 'warn', label: '待主管审批' }, approved: { tone: 'accent', label: '已批准待付' }, rejected: { tone: 'bad', label: '已退回' }, paid: { tone: 'ok', label: '已付款' }, cancelled: { tone: 'neutral', label: '已撤回' } };
const STATUS: Record<PayableBillView['status'], { tone: Tone; label: string }> = { unpaid: { tone: 'warn', label: '未付款' }, partial: { tone: 'accent', label: '部分付款' }, paid: { tone: 'ok', label: '已付清' }, void: { tone: 'neutral', label: '已作废' }, held: { tone: 'warn', label: '待关联结算' } };
const KIND = { material: '采购', finished: '成品采购', processing: '委外加工' } as const;
export const apMoney = (amount: number, currency: string) => `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const cents = (value: string) => { const n = Number(value); return value.trim() && Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const today = () => platformBusinessDate(new Date());
const fmtDay = (at?: string) => at ? platformBusinessDate(at) : '';

/** 供应商下拉：来自已批准合同或已登记票据，按供应商标识去重。 */
export function payableSupplierOptions(state: MistState | null) {
  const map = new Map<string, string>();
  for (const p of state?.fulfillment.purchases || []) if (p.state === 'approved') map.set(p.supplierId, p.supplier);
  for (const b of state?.payables?.bills || []) map.set(b.supplierId, b.supplier);
  return [...map.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

type BillDraft = { supplierId: string; invoiceNo: string; invoiceDate: string; taxAmount: string; taxRate: string; due: string; dueBasis: string; note: string; lines: Record<string, string>; links: Record<string, string> };
/** mode：request = 申请票据付款；pay = 按已批准申请登记实付；allocate = 把未分配金额分到票据。 */
type PayDraft = { mode: 'request' | 'pay' | 'allocate'; paymentId?: string; requestId?: string; planId?: string; supplierId: string; currency: string; date: string; amount: string; reference: string; note: string; allocations: Record<string, string> };
type PlanDraft = { stage: PaymentPlanStage; purchaseId: string; amount: string; trigger: string; basis: string; due: string; note: string };
type PreDraft = { planId: string; amount: string; reason: string };
type ReasonKind = 'void' | 'reverse-payment' | 'reverse-allocation' | 'cancel-request' | 'cancel-plan' | 'return-settlement' | 'cancel-settlement' | 'reverse-settlement' | 'reverse-deduction' | 'reverse-prepayment';
/** 票据行关联选项中的“发票先到、结算确认后再关联”。 */
const HELD = '__held';
const REASON: Record<ReasonKind, { title: string; label: string; action: string; description: string; done: string }> = {
  void: { title: '作废供应商票据', label: '作废原因', action: '确认作废', description: '作废后不再计入应付，合同可重新登记票据；原记录保留，不删除。', done: '票据已作废' },
  'reverse-payment': { title: '付款冲回', label: '冲回原因', action: '确认冲回', description: '原付款记录保留，另记一笔反向记录；分到票据的金额一并冲回，票据恢复未付。对应付款申请回到“已批准待付”。', done: '付款已冲回' },
  'reverse-allocation': { title: '冲回分配', label: '冲回原因', action: '确认冲回', description: '原分配保留并另记反向记录；金额回到这笔付款的未分配，可重新分配。', done: '分配已冲回' },
  'cancel-request': { title: '撤回付款申请', label: '撤回原因', action: '确认撤回', description: '撤回后不能再按此申请付款；占用的票据或预付额度释放。', done: '付款申请已撤回' },
  'cancel-plan': { title: '取消付款计划', label: '取消原因', action: '确认取消', description: '仅在没有付款申请时可取消；原计划保留。', done: '付款计划已取消' },
  'return-settlement': { title: '退回结算', label: '退回原因', action: '确认退回', description: '退回给提交人修正；所选收货记录释放，可重新提交。', done: '结算已退回' },
  'cancel-settlement': { title: '撤回结算', label: '撤回原因', action: '确认撤回', description: '撤回待复核的结算；所选收货记录释放。', done: '结算已撤回' },
  'reverse-settlement': { title: '冲回结算', label: '冲回原因', action: '确认冲回', description: '原结算保留并标记已冲回；收货记录与预付抵扣释放，可重新结算。已关联票据时须先作废票据。', done: '结算已冲回' },
  'reverse-deduction': { title: '冲回索赔扣款', label: '冲回原因', action: '确认冲回', description: '原扣款保留并标记已冲回，票据未付恢复；若追偿因扣满而落实，回到“工厂已同意、待落实”。', done: '索赔扣款已冲回' },
  'reverse-prepayment': { title: '冲回剩余预付处理', label: '冲回原因', action: '确认冲回', description: '原记录保留并标记已冲回，金额回到来源合同的剩余预付；退款冲回另记一笔反向收付款。转入合同已使用转入预付时不能冲回。', done: '剩余预付处理已冲回' },
};

export function FinancePayables() {
  const { state, loading, run, saving, pending } = useMistWorkspace(), session = useMistSession(), { route, go } = useNav(), toast = useToast();
  const canBill = session.hasPermission(MIST_FINANCE_SCOPES.invoice), canPay = session.hasPermission(MIST_FINANCE_SCOPES.voucher), canAllocate = session.hasPermission(MIST_FINANCE_SCOPES.reconcile), canRequest = session.hasPermission(PAYMENT_REQUEST_SCOPES.create as any), canSettle = session.hasPermission(SETTLEMENT_SCOPES.submit as any), canConfirm = canAllocate, day = today();
  const [view, setView] = React.useState<View>(() => !route.id ? 'bills' : (state?.payables?.payments || []).some(p => p.id === route.id) ? 'payments' : (state?.payables?.settlements || []).some(r => r.id === route.id) ? 'settlements' : (state?.payables?.requests || []).some(r => r.id === route.id) ? 'requests' : (state?.payables?.plans || []).some(r => r.id === route.id) ? 'prepay' : 'bills');
  const [selected, setSelected] = React.useState(route.id || ''), [drawer, setDrawer] = React.useState(!!route.id);
  const [filter, setFilter] = React.useState<'open' | 'overdue' | 'all'>('open');
  const [billDraft, setBillDraft] = React.useState<BillDraft | null>(null), [payDraft, setPayDraft] = React.useState<PayDraft | null>(null), [reasonDraft, setReasonDraft] = React.useState<{ kind: ReasonKind; id: string; reason: string } | null>(null);
  const [planDraft, setPlanDraft] = React.useState<PlanDraft | null>(null), [preDraft, setPreDraft] = React.useState<PreDraft | null>(null);
  const [settleOpen, setSettleOpen] = React.useState(false), [confirmId, setConfirmId] = React.useState('');
  const [linkId, setLinkId] = React.useState(''), [deductId, setDeductId] = React.useState(''), [moveDraft, setMoveDraft] = React.useState<{ kind: 'refund' | 'transfer'; purchaseId: string } | null>(null);
  const [working, setWorking] = React.useState(false), [failure, setFailure] = React.useState('');
  const busy = working || loading || saving || !!pending;
  React.useEffect(() => { setSelected(route.id || ''); setDrawer(!!route.id); }, [route.id]);

  const bills = state ? payableBills(state, day) : [], payments = state ? supplierPayments(state) : [], sources = state ? payableSources(state) : [], summary = state ? supplierPayableSummary(state, day) : [];
  const suppliers = payableSupplierOptions(state), requests = state ? paymentRequests(state) : [], plans = state ? prepaymentPlans(state) : [], settlements = state ? supplierSettlements(state) : [];
  const shownBills = bills.filter(b => filter === 'all' || (filter === 'open' ? b.open > 0 : b.overdue));
  const bill = bills.find(b => b.id === selected), payment = payments.find(p => p.id === selected), request = requests.find(r => r.id === selected), plan = plans.find(p => p.id === selected), settlement = settlements.find(x => x.id === selected);
  const open = (id: string) => { setSelected(id); setDrawer(true); go('payment-vouchers', id, { section: 'payables' }); };

  const execute = async (command: PayablesCommand, done: (result: Record<string, unknown>) => void) => {
    if (payablesCommandPermissions(command).some(permission => !session.hasPermission(permission as any))) { setFailure('没有办理此项财务动作的权限。'); return; }
    if (busy) return; setWorking(true); setFailure('');
    try { const receipt = await run(command as any); done(receipt.result as Record<string, unknown>); } catch (problem) { setFailure(problem instanceof Error ? problem.message : '操作失败，请重试'); } finally { setWorking(false); }
  };

  /** 勾选合同时的默认关联：有可开票结算就关联第一笔，金额取结算未开票额。 */
  const lineDefault = (purchaseId: string, uninvoiced: number, settlementId = '') => {
    const options = state ? invoiceableSettlements(state, purchaseId) : [], pick = options.find(o => o.settlement.id === settlementId) || options[0];
    return pick ? { amount: String(Math.min(uninvoiced, pick.left)), link: pick.settlement.id } : { amount: String(uninvoiced), link: '' };
  };
  const startBill = (supplierId = '', purchaseId = '', settlementId = '') => {
    const src = sources.find(s => s.purchase.id === purchaseId), d = src ? lineDefault(src.purchase.id, src.uninvoiced, settlementId) : null;
    setFailure(''); setBillDraft({ supplierId: supplierId || src?.purchase.supplierId || '', invoiceNo: '', invoiceDate: day, taxAmount: '', taxRate: '13%', due: '', dueBasis: src ? '合同付款条件：' + (src.purchase.terms || '未填写') : '', note: '', lines: src && d ? { [src.purchase.id]: d.amount } : {}, links: src && d?.link ? { [src.purchase.id]: d.link } : {} });
  };
  const needsLink = (purchaseId: string) => !!state && purchaseRequiresSettlementLink(state, purchaseId);
  /** 申请票据付款：按“未付余额 − 其他未付申请”预填，提交后进入主管审批。 */
  const availableMinor = (b: PayableBillView) => state ? Math.max(0, Math.round(b.open * 100) - billRequestedUnpaidMinor(state, b.id)) : 0;
  const startRequest = (supplierId = '', billId = '') => {
    const b = bills.find(x => x.id === billId); setFailure('');
    setPayDraft({ mode: 'request', supplierId: supplierId || b?.supplierId || '', currency: b?.currency || 'CNY', date: day, amount: '', reference: '', note: '', allocations: b ? { [b.id]: String(availableMinor(b) / 100) } : {} });
  };
  const startPayRequest = (r: PaymentRequest) => { setFailure(''); setPayDraft({ mode: 'pay', requestId: r.id, supplierId: r.supplierId, currency: r.currency, date: day, amount: String(r.amount), reference: '', note: '', allocations: Object.fromEntries(r.lines.map(l => [l.billId, String(l.amount)])) }); };
  const startAllocate = (p: SupplierPaymentView) => { setFailure(''); setPayDraft({ mode: 'allocate', paymentId: p.id, supplierId: p.supplierId, currency: p.currency, date: p.date, amount: String(p.amount), reference: p.reference, note: '', allocations: {} }); };
  const approvedPurchases = (state?.fulfillment.purchases || []).filter(p => p.state === 'approved');

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
    if (picked.some(id => needsLink(id) && !billDraft.links[id])) return setFailure('已有已确认结算或已付预付的合同，票据须关联已确认结算；结算还没确认时，可选“待关联结算”先登记。');
    const tax = billDraft.taxAmount.trim() ? cents(billDraft.taxAmount) : 0; if (Number.isNaN(tax)) return setFailure('税额格式无效。');
    void execute({ type: 'payable.bill.register', payload: { supplierId: billDraft.supplierId, invoiceNo: billDraft.invoiceNo, invoiceDate: billDraft.invoiceDate, currency: billCurrency, amount: billTotal / 100, taxAmount: tax / 100, taxRate: billDraft.taxRate, lines: picked.map(id => ({ purchaseId: id, amount: cents(billDraft.lines[id]) / 100, ...(billDraft.links[id] === HELD ? { awaitingSettlement: true } : billDraft.links[id] ? { settlementId: billDraft.links[id] } : {}) })), due: billDraft.due, dueBasis: billDraft.dueBasis, note: billDraft.note } }, r => { const held = picked.some(id => billDraft.links[id] === HELD); setBillDraft(null); setView('bills'); open(String(r.id)); toast(held ? '票据已登记为待关联结算，结算确认后再关联' : '供应商票据已登记，应付已形成'); });
  };

  // —— 申请 / 付款 / 分配表单
  const existing = payDraft?.mode === 'allocate' ? payments.find(p => p.id === payDraft.paymentId) : undefined;
  const payRequest = payDraft?.mode === 'pay' ? requests.find(r => r.id === payDraft.requestId) : undefined;
  const payBills = payDraft ? (payRequest ? payRequest.lines.map(l => bills.find(b => b.id === l.billId)!).filter(Boolean) : bills.filter(b => b.supplierId === payDraft.supplierId && b.currency === payDraft.currency && b.open > 0 && !b.held && (payDraft.mode !== 'request' || availableMinor(b) > 0))) : [];
  const payCurrencies = payDraft ? [...new Set([...bills.filter(b => b.supplierId === payDraft.supplierId).map(b => b.currency), payDraft.currency])].sort() : [];
  const allocRows = payDraft ? payBills.filter(b => (payDraft.allocations[b.id] || '').trim()).map(b => ({ billId: b.id, amount: cents(payDraft.allocations[b.id]) })) : [];
  const allocTotal = allocRows.reduce((n, r) => n + (r.amount || 0), 0);
  const rowLimit = (b: PayableBillView) => payDraft?.mode === 'request' ? availableMinor(b) : Math.round(b.open * 100);
  const payable = existing ? Math.round(existing.unallocated * 100) : payRequest ? Math.round(payRequest.amount * 100) : allocTotal;
  const submitPay = () => {
    if (!payDraft) return;
    if (allocRows.some(r => !(r.amount > 0))) return setFailure(payDraft.mode === 'request' ? '申请金额必须大于零。' : '分配金额必须大于零。');
    if (allocRows.some(r => r.amount > rowLimit(payBills.find(b => b.id === r.billId)!))) return setFailure(payDraft.mode === 'request' ? '申请金额不能超过可申请金额（未付余额扣除其他未付申请）。' : '分配金额不能超过票据未付余额。');
    const allocations = allocRows.map(r => ({ billId: r.billId, amount: r.amount / 100 }));
    if (payDraft.mode === 'allocate') { if (!existing) return; if (allocTotal > payable) return setFailure('分配合计超过付款金额。'); if (!allocations.length) return setFailure('请至少给一张票据填写分配金额。'); void execute({ type: 'payable.payment.allocate', payload: { supplierPaymentId: existing.id, allocations } }, () => { setPayDraft(null); toast('付款已分配到应付'); }); return; }
    if (payDraft.mode === 'request') {
      if (!payDraft.supplierId || !allocations.length) return setFailure('请选择供应商，并至少给一张票据填写申请金额。');
      if (!payDraft.note.trim()) return setFailure('请填写申请说明，供主管审批核对。');
      void execute({ type: 'payable.request.submit', payload: { purpose: 'bill', supplierId: payDraft.supplierId, currency: payDraft.currency, lines: allocations, ...(payDraft.planId ? { planId: payDraft.planId } : {}), reason: payDraft.note } }, r => { setPayDraft(null); setView('requests'); open(String(r.id)); toast('付款申请已提交，等待主管审批'); }); return;
    }
    if (!payRequest) return;
    if (!payDraft.date || !payDraft.reference.trim()) return setFailure('请填写付款日期和银行流水号。');
    void execute({ type: 'payable.payment.register', payload: { requestId: payRequest.id, date: payDraft.date, amount: payRequest.amount, reference: payDraft.reference, note: payDraft.note, ...(payRequest.purpose === 'bill' ? { allocations } : {}) } }, r => { setPayDraft(null); setView('payments'); open(String(r.id)); toast(payRequest.purpose === 'prepayment' ? '预付款已登记，待结算抵扣' : '付款已登记并分配'); });
  };
  const submitPlan = () => {
    if (!planDraft) return;
    const amount = cents(planDraft.amount);
    if (!planDraft.purchaseId || !(amount > 0) || !planDraft.trigger.trim() || !planDraft.basis.trim()) return setFailure('请选择合同，填写大于零的计划金额、付款触发条件和合同条款依据。');
    void execute({ type: 'payable.plan.register', payload: { purchaseId: planDraft.purchaseId, stage: planDraft.stage, amount: amount / 100, trigger: planDraft.trigger, basis: planDraft.basis, due: planDraft.due || undefined, note: planDraft.note } }, r => { setPlanDraft(null); setView('prepay'); open(String(r.id)); toast(paymentPlanStageLabel(planDraft.stage) + '计划已登记'); });
  };
  const prePlan = preDraft ? plans.find(p => p.id === preDraft.planId) : undefined;
  const submitPre = () => {
    if (!preDraft || !prePlan) return;
    const amount = cents(preDraft.amount);
    if (!(amount > 0)) return setFailure('申请金额必须大于零。');
    if (amount > Math.round(prePlan.available * 100)) return setFailure('申请金额超过该计划剩余可申请金额。');
    if (!preDraft.reason.trim()) return setFailure('请填写申请说明，供主管审批核对。');
    void execute({ type: 'payable.request.submit', payload: { purpose: 'prepayment', planId: prePlan.id, amount: amount / 100, reason: preDraft.reason } }, r => { setPreDraft(null); setView('requests'); open(String(r.id)); toast('预付款申请已提交，等待主管审批'); });
  };
  const submitReason = () => {
    if (!reasonDraft) return; const { kind, id, reason } = reasonDraft;
    const command: PayablesCommand = kind === 'void' ? { type: 'payable.bill.void', payload: { id, reason } } : kind === 'reverse-payment' ? { type: 'payable.payment.reverse', payload: { supplierPaymentId: id, reason } } : kind === 'reverse-allocation' ? { type: 'payable.allocation.reverse', payload: { allocationId: id, reason } } : kind === 'cancel-request' ? { type: 'payable.request.cancel', payload: { id, reason } } : kind === 'return-settlement' ? { type: 'payable.settlement.return', payload: { id, reason } } : kind === 'cancel-settlement' ? { type: 'payable.settlement.cancel', payload: { id, reason } } : kind === 'reverse-settlement' ? { type: 'payable.settlement.reverse', payload: { id, reason } } : kind === 'reverse-deduction' ? { type: 'payable.deduction.reverse', payload: { id, reason } } : kind === 'reverse-prepayment' ? { type: 'payable.prepayment.reverse', payload: { id, reason } } : { type: 'payable.plan.cancel', payload: { id, reason } };
    void execute(command, () => { setReasonDraft(null); toast(REASON[kind].done); });
  };
  const askReason = (kind: ReasonKind, id: string) => { setFailure(''); setReasonDraft({ kind, id, reason: '' }); };
  const reasonAllowed = (kind: ReasonKind) => kind === 'void' || kind === 'cancel-plan' ? canBill : kind === 'reverse-payment' ? canPay && canAllocate : kind === 'reverse-allocation' || kind === 'return-settlement' || kind === 'reverse-settlement' || kind === 'reverse-deduction' || kind === 'reverse-prepayment' ? canConfirm : kind === 'cancel-settlement' ? canSettle : canRequest;

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
  /** 预付抵扣按合同累计（同一合同可有多笔预付），付款列表显示合同层面的抵扣进度。 */
  const prepayState = (purchaseId?: string) => { const r = state && purchaseId ? purchasePrepaymentReadback(state, purchaseId) : null; return !r || r.applied <= 0 ? '预付 · 待结算抵扣' : r.available > 0 ? '预付 · 部分已抵扣' : '预付 · 已全部抵扣'; };
  const paymentColumns: Column<SupplierPaymentView>[] = [
    { key: 'code', header: '付款 / 供应商', width: 'minmax(170px,1.4fr)', render: p => <ObjectCell name={<Mono>{p.code}</Mono>} meta={p.supplier + ' · ' + p.reference} /> },
    { key: 'date', header: '付款日期', width: '108px', render: p => p.date },
    { key: 'amount', header: '付款金额', width: '140px', align: 'right', render: p => <span className="mist-num">{apMoney(p.amount, p.currency)}</span> },
    { key: 'un', header: '分配情况', width: '150px', align: 'right', render: p => p.reversed ? <Pill tone="neutral">已冲回</Pill> : p.purpose === 'prepayment' ? <Pill tone="accent">{prepayState(p.purchaseId)}</Pill> : p.unallocated > 0 ? <Pill tone="warn">{apMoney(p.unallocated, p.currency)} 未分配</Pill> : <span className="mist-note">已分完</span> },
  ];
  const requestColumns: Column<PaymentRequest>[] = [
    { key: 'code', header: '申请 / 供应商', width: 'minmax(170px,1.4fr)', render: r => <ObjectCell name={<Mono>{r.code}</Mono>} meta={r.supplier + ' · ' + (r.purpose === 'prepayment' ? '预付款 ' + (r.purchaseCode || '') : r.lines.map(l => l.billCode).join(' / '))} /> },
    { key: 'by', header: '申请人', width: '120px', hideOnMobile: true, render: r => <span className="mist-col"><span>{r.requester}</span><span className="mist-note">{fmtDay(r.submittedAt)}</span></span> },
    { key: 'amount', header: '申请金额', width: '140px', align: 'right', render: r => <span className="mist-num">{apMoney(r.amount, r.currency)}</span> },
    { key: 'state', header: '状态', width: '112px', render: r => <Pill tone={REQ[r.state].tone}>{REQ[r.state].label}</Pill> },
  ];
  const planColumns: Column<PrepaymentPlanView>[] = [
    { key: 'code', header: '付款计划 / 合同', width: 'minmax(170px,1.4fr)', render: r => <ObjectCell name={<span className="mist-row"><Mono>{r.code}</Mono><Pill tone={r.stage === 'prepayment' ? 'accent' : 'neutral'}>{paymentPlanStageLabel(r.stage)}</Pill></span>} meta={r.purchaseCode + ' · ' + r.supplier} /> },
    { key: 'trigger', header: '付款触发条件', width: 'minmax(140px,1fr)', hideOnMobile: true, render: r => r.trigger },
    { key: 'amount', header: '计划金额', width: '140px', align: 'right', render: r => <span className="mist-num">{apMoney(r.amount, r.currency)}</span> },
    { key: 'paid', header: '已付', width: '140px', align: 'right', hideOnMobile: true, render: r => <span className="mist-num">{apMoney(r.paid, r.currency)}</span> },
    { key: 'state', header: '状态', width: '104px', render: r => r.state === 'cancelled' ? <Pill tone="neutral">已取消</Pill> : r.paid >= r.amount ? <Pill tone="ok">已付清</Pill> : r.available >= r.amount ? <Pill tone="warn">待申请</Pill> : r.available > 0 ? <Pill tone="warn">{r.paid > 0 ? '部分已付' : '部分申请'}</Pill> : <Pill tone="accent">已全部申请</Pill> },
  ];
  const reversals = state?.payables?.reversals || [];
  const allocationReversal = (id: string) => reversals.find(r => r.kind === 'allocation' && r.targetId === id);

  const allocations = state?.payables?.allocations || [];
  const detail = bill ? <DetailBody data-payable-bill={bill.id} heading={<h2 className="mist-h2">{bill.code}</h2>}>
    <Facts items={[
      { label: '供应商', value: bill.supplier }, { label: '供应商发票号', value: <Mono>{bill.invoiceNo}</Mono> }, { label: '发票日期', value: bill.invoiceDate },
      { label: '价税合计', value: apMoney(bill.amount, bill.currency) }, { label: '税额 / 税率', value: apMoney(bill.taxAmount, bill.currency) + ' · ' + (bill.taxRate || '未填写') },
      ...(bill.prepaymentCredit > 0 ? [{ label: '预付抵扣（来自结算）', value: apMoney(bill.prepaymentCredit, bill.currency) }] : []),
      ...(bill.deducted > 0 ? [{ label: '索赔扣款', value: apMoney(bill.deducted, bill.currency) }] : []),
      { label: '已付 / 未付', value: apMoney(bill.paid, bill.currency) + ' / ' + apMoney(bill.open, bill.currency) },
      { label: '到期日', value: bill.due + (bill.overdue ? '（已逾期）' : '') }, { label: '到期日依据', value: bill.dueBasis }, { label: '登记', value: bill.registeredBy + ' · ' + fmtDay(bill.registeredAt) },
    ]} />
    {bill.held && <Banner tone="warn" title="待关联结算">发票先于结算到达，已登记但暂挂：不计入应付和逾期，也不能申请付款。业务员提交结算、财务确认后，在这里关联结算。</Banner>}
    {bill.status === 'void' && <Banner title="已作废">{bill.voided?.reason}（{bill.voided?.actor} · {fmtDay(bill.voided?.at)}），不再计入应付；原记录保留。</Banner>}
    <ActionBar busy={busy} actions={[
      { label: '关联结算', onClick: () => { setFailure(''); setLinkId(bill.id); }, reason: !canBill ? '需要票据登记权限' : undefined, hidden: !bill.held || bill.status === 'void' },
      { label: '申请付款', onClick: () => startRequest(bill.supplierId, bill.id), reason: !canRequest ? '需要付款申请权限' : bill.held ? '待关联结算后才能申请付款' : bill.open <= 0 ? '本票已无未付余额' : availableMinor(bill) <= 0 ? '未付余额已全部在付款申请中' : undefined, hidden: bill.status === 'void' },
      { label: '登记索赔扣款', onClick: () => { setFailure(''); setDeductId(bill.id); }, reason: !canAllocate ? '需要核销权限（财务）' : bill.held ? '待关联结算后才能扣款' : !state || !deductibleRecoveries(state, bill.supplierId, bill.currency).length ? '这家供应商没有工厂已同意从货款中扣的追偿' : availableMinor(bill) <= 0 ? '本票没有可扣的未付余额' : undefined, hidden: bill.status === 'void' || (!!state && !deductibleRecoveries(state, bill.supplierId).length) },
      { label: '作废票据', onClick: () => askReason('void', bill.id), reason: !canBill ? '需要票据登记权限' : bill.paid > 0 ? '已有付款分配，请先冲回分配或付款再作废' : bill.deducted > 0 ? '已有索赔扣款，请先冲回扣款再作废' : undefined, hidden: bill.status === 'void' },
    ]} />
    <DetailBlock title="来源合同">{bill.lines.map(l => <div className="mist-row mist-module-actions" key={l.purchaseId}><Mono>{l.purchaseCode}</Mono><span className="mist-note">{KIND[l.kind]}{l.settlementCode ? ' · 结算 ' + l.settlementCode : ''}</span>{l.awaitingSettlement && !l.settlementId && <Pill tone="warn">待关联结算</Pill>}<span className="mist-spacer" /><span className="mist-num">{apMoney(l.amount, bill.currency)}</span>{l.settlementId && <Button size="sm" onClick={() => { setView('settlements'); open(l.settlementId!); }}>查看结算</Button>}<Button size="sm" onClick={() => go('procurement', l.purchaseId)}>查看合同</Button></div>)}
      <span className="mist-note">合同付款条件：{bill.terms.join('；') || '未填写'}</span></DetailBlock>
    <DetailBlock title="付款分配">{allocations.filter(a => a.billId === bill.id).map(a => { const p = payments.find(x => x.id === a.supplierPaymentId); return <div className="mist-row mist-module-actions" key={a.id}><Mono>{p?.code || '付款记录未找到'}</Mono><span className="mist-note">{p?.date}</span><span className="mist-spacer" /><span className="mist-num">{apMoney(a.amount, a.currency)}</span>{allocationReversal(a.id) && <Pill tone="neutral">已冲回</Pill>}{p && <Button size="sm" onClick={() => { setView('payments'); open(p.id); }}>查看付款</Button>}</div>; })}
      {!allocations.some(a => a.billId === bill.id) && <span className="mist-note">还没有付款分配到这张票。</span>}</DetailBlock>
    {state && <DeductionList rows={supplierDeductions(state, bill.id)} busy={busy} canReverse={canConfirm} onReverse={d => askReason('reverse-deduction', d.id)} onClaim={id => go('claims', id)} />}
  </DetailBody> : payment ? <DetailBody data-supplier-payment={payment.id} heading={<h2 className="mist-h2">{payment.code}</h2>}>
    <Facts items={[{ label: '收款供应商', value: payment.supplier }, { label: '付款日期', value: payment.date }, { label: '付款金额', value: apMoney(payment.amount, payment.currency) }, { label: '银行流水号', value: <Mono>{payment.reference}</Mono> }, { label: '付款申请', value: payment.requestCode ? <Mono>{payment.requestCode}</Mono> : '旧记录（审批规则前登记）' }, ...(payment.purpose === 'prepayment' ? [{ label: '用途', value: '合同预付款 · ' + (state?.fulfillment.purchases.find(x => x.id === payment.purchaseId)?.code || '') }] : [{ label: '已分配 / 未分配', value: apMoney(payment.allocated, payment.currency) + ' / ' + apMoney(payment.unallocated, payment.currency) }]), { label: '登记', value: payment.actor + ' · ' + fmtDay(payment.createdAt) }, ...(payment.note ? [{ label: '备注', value: payment.note }] : [])]} />
    {payment.reversed && <Banner title="已冲回">{payment.reversed.reason}（{payment.reversed.actor} · {fmtDay(payment.reversed.at)}）。原记录保留，已另记反向记录，不再计入已付。</Banner>}
    {!payment.reversed && payment.purpose === 'prepayment' && <Banner title="预付款挂在合同上">财务确认结算时按结算数量比例抵扣（最后一次结算扫尾），再随关联结算的票据计入；不直接分到票据。</Banner>}
    {payment.unallocated > 0 && <Banner tone="warn" title="还有钱没分到票据上">未分配金额保留在这家供应商名下，不会自动配；核对后再分配。</Banner>}
    <ActionBar busy={busy} actions={[{ label: '分配到应付', onClick: () => startAllocate(payment), reason: !canAllocate ? '需要核销分配权限' : payment.unallocated <= 0 ? '没有可分配的金额' : undefined, hidden: payment.purpose === 'prepayment' || !!payment.reversed }, { label: '付款冲回', onClick: () => askReason('reverse-payment', payment.id), reason: !(canPay && canAllocate) ? '需要付款登记和核销分配权限' : undefined, hidden: !!payment.reversed }]} />
    <DetailBlock title="分配到的票据">{allocations.filter(a => a.supplierPaymentId === payment.id).map(a => { const b = bills.find(x => x.id === a.billId); return <div className="mist-row mist-module-actions" key={a.id}><Mono>{b?.code || '票据未找到'}</Mono><span className="mist-note">{b ? '发票 ' + b.invoiceNo : ''}</span><span className="mist-spacer" /><span className="mist-num">{apMoney(a.amount, a.currency)}</span>{allocationReversal(a.id) ? <Pill tone="neutral">已冲回</Pill> : <Button size="sm" disabled={busy || !canAllocate} title={!canAllocate ? '需要核销分配权限' : undefined} onClick={() => askReason('reverse-allocation', a.id)}>冲回分配</Button>}{b && <Button size="sm" onClick={() => { setView('bills'); open(b.id); }}>查看票据</Button>}</div>; })}
      {!allocations.some(a => a.supplierPaymentId === payment.id) && <span className="mist-note">{payment.purpose === 'prepayment' ? '预付款不分配到票据。' : '尚未分配。'}</span>}</DetailBlock>
  </DetailBody> : request ? <DetailBody data-payment-request={request.id} heading={<h2 className="mist-h2">{request.code}</h2>}>
    <div className="mist-row"><Pill tone={REQ[request.state].tone}>{REQ[request.state].label}</Pill><span className="mist-note">{request.requester} · 提交于 {fmtDay(request.submittedAt)}</span></div>
    <DetailBlock title="提交时冻结的审批材料"><Facts items={request.snapshot.map(d => ({ label: d.label, value: d.value }))} /></DetailBlock>
    {request.decision && <Banner tone={request.decision.decision === 'approved' ? 'ok' : 'bad'} title={request.decision.decision === 'approved' ? '主管已批准' : '主管已退回'}>{request.decision.note}（{request.decision.actor} · {fmtDay(request.decision.at)}）</Banner>}
    {request.state === 'pending' && <Banner tone="warn" title="等待主管审批">主管在“审批事项”中按冻结材料决定；批准前不能付款。</Banner>}
    {request.cancelled && <Banner title="已撤回">{request.cancelled.reason}（{request.cancelled.actor} · {fmtDay(request.cancelled.at)}）</Banner>}
    <ActionBar busy={busy} actions={[
      { label: '登记实付', onClick: () => startPayRequest(request), reason: !canPay ? '需要付款登记权限' : request.purpose === 'bill' && !canAllocate ? '票据付款需同时具备核销分配权限' : undefined, hidden: request.state !== 'approved' },
      { label: '撤回申请', onClick: () => askReason('cancel-request', request.id), reason: !canRequest ? '需要付款申请权限' : undefined, hidden: request.state !== 'pending' && request.state !== 'approved' },
      { label: '查看付款', onClick: () => { setView('payments'); open(request.supplierPaymentId!); }, hidden: !request.supplierPaymentId },
    ]} />
    {request.paymentHistory.length > (request.supplierPaymentId ? 1 : 0) && <span className="mist-note">此申请曾登记实付后冲回 {request.paymentHistory.length - (request.supplierPaymentId ? 1 : 0)} 次，原记录保留在供应商付款中。</span>}
  </DetailBody> : plan ? <DetailBody data-prepayment-plan={plan.id} heading={<h2 className="mist-h2">{plan.code}</h2>}>
    <Facts items={[{ label: '来源合同', value: <Mono>{plan.purchaseCode}</Mono> }, { label: '供应商', value: plan.supplier }, { label: '计划金额', value: apMoney(plan.amount, plan.currency) }, { label: '付款触发条件', value: plan.trigger }, { label: '合同条款依据', value: plan.basis }, ...(plan.due ? [{ label: '计划付款日', value: plan.due }] : []), { label: '已申请 / 已付', value: apMoney(plan.requested, plan.currency) + ' / ' + apMoney(plan.paid, plan.currency) }, { label: '登记', value: plan.registeredBy + ' · ' + fmtDay(plan.registeredAt) }]} />
    {plan.stage === 'prepayment' ? <Banner title="计划不是应付">按合同条款登记的付款安排；只有申请经主管批准并实际付款后才形成预付款，结算确认后抵扣。</Banner>
      : <Banner title={paymentPlanStageLabel(plan.stage) + '计划不是应付'}>只记录合同约定的付款安排。供应商票据到后按票据申请付款，并在申请中选择本计划，用来跟踪已申请和已付。</Banner>}
    {plan.cancelled && <Banner title="已取消">{plan.cancelled.reason}（{plan.cancelled.actor} · {fmtDay(plan.cancelled.at)}）</Banner>}
    <ActionBar busy={busy} actions={[
      { label: '申请预付款', onClick: () => { setFailure(''); setPreDraft({ planId: plan.id, amount: String(plan.available), reason: '' }); }, reason: !canRequest ? '需要付款申请权限' : plan.available <= 0 ? '计划金额已全部申请' : undefined, hidden: plan.state !== 'active' || plan.stage !== 'prepayment' },
      { label: '取消计划', onClick: () => askReason('cancel-plan', plan.id), reason: !canBill ? '需要票据登记权限' : plan.requested > 0 ? '已有付款申请，请先撤回申请或冲回付款' : undefined, hidden: plan.state !== 'active' },
      { label: '查看合同', onClick: () => go('procurement', plan.purchaseId) },
    ]} />
  </DetailBody> : settlement && state ? <SettlementDetail settlement={settlement} state={state} me={session.user?.id || ''} busy={busy} canSettle={canSettle} canConfirm={canConfirm} canBill={canBill}
      onConfirm={() => { setFailure(''); setConfirmId(settlement.id); }} onReason={kind => askReason(kind, settlement.id)} onBill={() => startBill(settlement.supplierId, settlement.purchaseId, settlement.id)} onPurchase={() => go('procurement', settlement.purchaseId)}>
      {settlement.final && settlement.state === 'confirmed' && <PrepaymentResidual state={state} purchaseId={settlement.purchaseId} busy={busy} canRefund={canPay && canConfirm} canMove={canConfirm} onRefund={() => { setFailure(''); setMoveDraft({ kind: 'refund', purchaseId: settlement.purchaseId }); }} onTransfer={() => { setFailure(''); setMoveDraft({ kind: 'transfer', purchaseId: settlement.purchaseId }); }} onReverse={(m: PrepaymentMove) => askReason('reverse-prepayment', m.id)} />}
    </SettlementDetail>
  : <EmptyState compact title={route.id ? '未找到应付记录' : '应付详情'} description="选择一张票据、付款申请、结算、付款计划或一笔付款，查看来源、审批、分配和余额。" />;

  const list = view === 'bills' ? <DataTable ariaLabel="应付票据" rows={shownBills} columns={billColumns} loading={loading} rowKey={b => b.id} selectedKey={selected} onRowClick={b => open(b.id)}
      empty={bills.length ? <EmptyState compact title="没有符合筛选的票据" action={<Button onClick={() => setFilter('all')}>查看全部</Button>} /> : <EmptyState title="还没有登记供应商票据" description="收到供应商的增值税发票后，在“待登记来源”里找到对应合同登记。" />} />
    : view === 'requests' ? <DataTable ariaLabel="付款申请" rows={requests} columns={requestColumns} loading={loading} rowKey={r => r.id} selectedKey={selected} onRowClick={r => open(r.id)} empty={<EmptyState title="还没有付款申请" description="所有付款（含预付）先申请，经主管审批后由财务登记实付。从票据详情或预付计划发起。" />} />
    : view === 'settlements' ? <DataTable ariaLabel="供应商结算" rows={settlements} columns={settlementColumns()} loading={loading} rowKey={r => r.id} selectedKey={selected} onRowClick={r => open(r.id)} empty={<EmptyState title="还没有结算" description="业务员按实际收货记录提交结算，财务复核确认后才算已确认结算，并抵扣预付。" />} />
    : view === 'prepay' ? <DataTable ariaLabel="付款计划" rows={plans} columns={planColumns} loading={loading} rowKey={r => r.id} selectedKey={selected} onRowClick={r => open(r.id)} empty={<EmptyState title="还没有付款计划" description="由财务按合同条款登记预付款、进度款或尾款计划和触发条件。" />} />
    : view === 'sources' ? <DataTable ariaLabel="待登记来源合同" rows={sources} columns={sourceColumns} loading={loading} rowKey={r => r.purchase.id} onRowClick={r => go('procurement', r.purchase.id)} empty={<EmptyState title="暂无已批准的采购 / 加工合同" description="合同批准后才可登记供应商票据。" />} />
    : <DataTable ariaLabel="供应商付款" rows={payments} columns={paymentColumns} loading={loading} rowKey={p => p.id} selectedKey={selected} onRowClick={p => open(p.id)} empty={<EmptyState title="还没有供应商付款" description="实际付款后在这里登记，并分配到一张或多张票据。" />} />;

  return <div className="mist-col" data-finance-payables>
    {failure && !billDraft && !payDraft && !reasonDraft && !planDraft && !preDraft && !settleOpen && !confirmId && !linkId && !deductId && !moveDraft && <Banner tone="bad" title="操作没有完成">{failure}</Banner>}
    <Card>
      <CardHeader title="供应商应付（按原币）" sub="收到供应商发票登记后形成应付；所有付款先申请、经主管审批后再登记实付" tools={<div className="mist-row" style={{ flexWrap: 'wrap' }}>
        <Button disabled={busy || !canBill} title={!canBill ? '需要票据登记权限' : undefined} onClick={() => startBill()}>登记供应商票据</Button>
        <Button disabled={busy || !canBill} title={!canBill ? '需要票据登记权限' : undefined} onClick={() => { setFailure(''); setPlanDraft({ stage: 'prepayment', purchaseId: '', amount: '', trigger: '', basis: '', due: '', note: '' }); }}>登记付款计划</Button>
        <Button disabled={busy || !canSettle} title={!canSettle ? '需要采购经办权限（业务员按实际收货提交）' : undefined} onClick={() => { setFailure(''); setSettleOpen(true); }}>提交结算</Button>
        <Button disabled={busy || !canRequest} title={!canRequest ? '需要付款申请权限' : undefined} onClick={() => startRequest()}>申请票据付款</Button></div>} />
      <div className="mist-card-body mist-col">
      {summary.length ? <DataTable ariaLabel="供应商应付汇总" rows={summary} rowKey={r => r.supplierId + r.currency} columns={[
        { key: 's', header: '供应商', render: r => <ObjectCell name={r.supplier} meta={(r.bills ? r.bills + ' 张未付清' + (r.overdue ? ' · ' + r.overdue + ' 张逾期' : '') : r.heldBills ? '无可付应付' : '已全部付清') + (r.heldBills ? ` · ${r.heldBills} 张待关联结算（${apMoney(r.held, r.currency)}）` : '')} /> },
        { key: 'open', header: '未付余额', width: '150px', align: 'right', render: r => <span className="mist-col"><span className="mist-note mist-cell-sm-label">未付余额</span><span className="mist-num">{apMoney(r.open, r.currency)}</span></span> },
        { key: 'paid', header: '已付', width: '140px', align: 'right', hideOnMobile: true, render: r => <span className="mist-num">{apMoney(r.paid, r.currency)}</span> },
        { key: 'un', header: '未分配付款', width: '140px', align: 'right', hideOnMobile: true, render: r => r.unallocated > 0 ? <span className="mist-num">{apMoney(r.unallocated, r.currency)}</span> : '—' },
        { key: 'pre', header: '预付（待抵扣）', width: '140px', align: 'right', hideOnMobile: summary.every(x => x.prepaid <= 0), render: r => <span className="mist-col"><span className="mist-note mist-cell-sm-label">预付待抵扣</span>{r.prepaid > 0 ? <span className="mist-num">{apMoney(r.prepaid, r.currency)}</span> : <span>—</span>}</span> },
      ]} /> : <span className="mist-note">还没有登记供应商票据。合同金额不是应付；收到供应商发票登记后才形成应付余额。</span>}
    </div></Card>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}>
      <Segmented<View> value={view} onChange={v => { setView(v); setSelected(''); setDrawer(false); }} options={[{ value: 'bills', label: `应付票据 · ${bills.filter(b => b.open > 0).length}` }, { value: 'requests', label: `付款申请 · ${requests.filter(r => r.state === 'pending' || r.state === 'approved').length}` }, { value: 'settlements', label: `结算 · ${settlements.filter(x => x.state === 'pending').length}` }, { value: 'prepay', label: `付款计划 · ${plans.filter(p => p.state === 'active').length}` }, { value: 'sources', label: `待登记来源 · ${sources.filter(s => s.uninvoiced > 0).length}` }, { value: 'payments', label: `供应商付款 · ${payments.length}` }]} />
      {view === 'bills' && <Segmented<'open' | 'overdue' | 'all'> value={filter} onChange={setFilter} options={[{ value: 'open', label: '未付清' }, { value: 'overdue', label: `已逾期 · ${bills.filter(b => b.overdue).length}` }, { value: 'all', label: '全部' }]} />}
      <span className="mist-spacer" />
      {view === 'bills' && <Button onClick={() => downloadMistCsv('供应商应付.csv', ['应付号', '供应商', '发票号', '发票日期', '币种', '价税合计', '税额', '已付', '未付', '到期日', '状态', '来源合同'], shownBills.map(b => [b.code, b.supplier, b.invoiceNo, b.invoiceDate, b.currency, b.amount, b.taxAmount, b.paid, b.open, b.due, STATUS[b.status].label, b.lines.map(l => l.purchaseCode + ':' + l.amount).join(' / ')]))}>导出当前票据</Button>}
    </div>
    <ListDetail drawerOpen={drawer && !!(bill || payment || request || plan || settlement)} drawerTitle={bill?.code || payment?.code || request?.code || plan?.code || settlement?.code || '应付详情'} onDrawerClose={() => setDrawer(false)} list={<Card>{list}</Card>} detail={detail} />

    <Dialog open={!!billDraft} onClose={() => { if (!busy) setBillDraft(null); }} width={760} title="登记供应商票据" description="收到供应商开给我们的增值税发票后登记。登记后形成应付；不改变采购 / 加工的交付状态。"
      footer={<><Button disabled={busy} onClick={() => setBillDraft(null)}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !canBill} onClick={submitBill}>登记应付</Button></>}>
      {billDraft && <div className="mist-col">
        {failure && <Banner tone="bad" title="还不能登记">{failure}</Banner>}
        <FormGrid>
          <Field label="供应商" required><Select aria-label="供应商" value={billDraft.supplierId} options={[{ value: '', label: '请选择供应商' }, ...suppliers]} onChange={e => setBillDraft({ ...billDraft, supplierId: e.target.value, lines: {} })} /></Field>
          <Field label="供应商发票号" required><TextInput aria-label="供应商发票号" value={billDraft.invoiceNo} onChange={e => setBillDraft({ ...billDraft, invoiceNo: e.target.value })} /></Field>
        </FormGrid>
        <Field label="这张票对应哪些合同" required hint={billCurrency ? '同一张票只能对应同币种合同（' + billCurrency + '）' : '勾选合同并写明本票对应金额，不能只挂供应商总额'}>
          <div className="mist-col">{billSources.map(s => { const on = s.purchase.id in billDraft.lines, other = !!billCurrency && s.purchase.currency !== billCurrency; return <div className="mist-row mist-module-actions" key={s.purchase.id} data-bill-source={s.purchase.id}>
            <Checkbox checked={on} disabled={other && !on} onChange={v => { const lines = { ...billDraft.lines }, links = { ...billDraft.links }; if (v) { const d = lineDefault(s.purchase.id, s.uninvoiced); lines[s.purchase.id] = d.amount; if (d.link) links[s.purchase.id] = d.link; } else { delete lines[s.purchase.id]; delete links[s.purchase.id]; } setBillDraft({ ...billDraft, lines, links, dueBasis: billDraft.dueBasis || '合同付款条件：' + (s.purchase.terms || '未填写') }); }} label={<span><Mono>{s.purchase.code}</Mono> · {s.purchase.description} · 还没收到票 {apMoney(s.uninvoiced, s.purchase.currency)}</span>} />
            <span className="mist-spacer" />{on && <TextInput aria-label={s.purchase.code + ' 本票金额'} type="number" min="0.01" step="0.01" style={{ width: 140 }} value={billDraft.lines[s.purchase.id]} onChange={e => setBillDraft({ ...billDraft, lines: { ...billDraft.lines, [s.purchase.id]: e.target.value } })} />}
            {on && state && (() => { const options = invoiceableSettlements(state, s.purchase.id), must = needsLink(s.purchase.id), finalDone = settlementsOf(state, s.purchase.id).some(x => x.state === 'confirmed' && x.final); const choices = [...(must ? (billDraft.links[s.purchase.id] ? [] : [{ value: '', label: '请选择结算' }]) : [{ value: '', label: '不关联结算' }]), ...options.map(o => ({ value: o.settlement.id, label: `${o.settlement.code} · 未开票 ${apMoney(o.left, o.settlement.currency)}${o.settlement.confirmation?.prepaymentApplied ? ' · 含预付抵扣' : ''}` })), ...(finalDone ? [] : [{ value: HELD, label: '待关联结算（发票先到，结算确认后再关联）' }])]; return options.length || must ? <Select aria-label={s.purchase.code + ' 关联结算'} value={billDraft.links[s.purchase.id] || ''} options={choices} onChange={e => { const o = options.find(x => x.settlement.id === e.target.value); setBillDraft({ ...billDraft, links: { ...billDraft.links, [s.purchase.id]: e.target.value }, lines: o ? { ...billDraft.lines, [s.purchase.id]: String(Math.min(s.uninvoiced, o.left)) } : billDraft.lines }); }} /> : null; })()}
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

    <Dialog open={!!payDraft} onClose={() => { if (!busy) setPayDraft(null); }} width={760}
      title={payDraft?.mode === 'allocate' ? '分配付款到应付' : payDraft?.mode === 'pay' ? '按已批准申请登记实付' : '申请票据付款'}
      description={existing ? `${existing.code} · 还有 ${apMoney(existing.unallocated, existing.currency)} 未分配` : payRequest ? `${payRequest.code} · ${payRequest.supplier} · 已批准 ${apMoney(payRequest.amount, payRequest.currency)}。实付金额与分配须与批准一致；金额不同请撤回后重新申请。` : '选择要付款的票据和金额，提交后由主管审批；批准后财务登记实付。'}
      footer={<><Button disabled={busy} onClick={() => setPayDraft(null)}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !(existing ? canAllocate : payRequest ? canPay : canRequest)} onClick={submitPay}>{existing ? '确认分配' : payRequest ? '登记实付' : '提交审批'}</Button></>}>
      {payDraft && <div className="mist-col">
        {failure && <Banner tone="bad" title="还不能保存">{failure}</Banner>}
        {payDraft.mode === 'request' && <FormGrid>
          <Field label="收款供应商" required><Select aria-label="收款供应商" value={payDraft.supplierId} options={[{ value: '', label: '请选择供应商' }, ...suppliers]} onChange={e => setPayDraft({ ...payDraft, supplierId: e.target.value, allocations: {} })} /></Field>
          <Field label="币种" required><Select aria-label="币种" value={payDraft.currency} options={payCurrencies} onChange={e => setPayDraft({ ...payDraft, currency: e.target.value, allocations: {} })} /></Field>
        </FormGrid>}
        {payDraft.mode === 'request' && (() => { const pos = new Set(payBills.filter(b => (payDraft.allocations[b.id] || '').trim()).flatMap(b => b.lines.map(l => l.purchaseId))), schedule = plans.filter(x => x.state === 'active' && x.stage !== 'prepayment' && x.supplierId === payDraft.supplierId && x.currency === payDraft.currency && x.available > 0 && pos.has(x.purchaseId)); return schedule.length ? <Field label="对应付款计划" hint="合同约定了进度款 / 尾款时选择，便于跟踪计划已申请和已付"><Select aria-label="对应付款计划" value={payDraft.planId || ''} options={[{ value: '', label: '不对应计划' }, ...schedule.map(x => ({ value: x.id, label: `${x.code} · ${paymentPlanStageLabel(x.stage)} · ${x.purchaseCode} · 可申请 ${apMoney(x.available, x.currency)}` }))]} onChange={e => setPayDraft({ ...payDraft, planId: e.target.value || undefined })} /></Field> : null; })()}
        {payRequest && <FormGrid cols={3}>
          <Field label="付款金额"><TextInput aria-label="付款金额" readOnly value={apMoney(payRequest.amount, payRequest.currency)} /></Field>
          <Field label="付款日期" required><TextInput aria-label="付款日期" type="date" max={day} min={fmtDay(payRequest.decision?.at)} value={payDraft.date} onChange={e => setPayDraft({ ...payDraft, date: e.target.value })} /></Field>
          <Field label="银行流水号 / 参考号" required><TextInput aria-label="银行流水号" value={payDraft.reference} onChange={e => setPayDraft({ ...payDraft, reference: e.target.value })} /></Field>
        </FormGrid>}
        {(payDraft.mode !== 'pay' || payRequest?.purpose === 'bill') && <Field label={payDraft.mode === 'request' ? '申请付款的票据' : '分配到票据'} hint={payDraft.mode === 'request' ? `本次申请合计 ${apMoney(allocTotal / 100, payDraft.currency)}` : `已分配 ${apMoney(allocTotal / 100, payDraft.currency)} · 未分配 ${apMoney(Math.max(0, payable - allocTotal) / 100, payDraft.currency)}`}>
          {payDraft.mode !== 'request' && !canAllocate && <span className="mist-note">当前账号没有核销分配权限，不能分配到票据。</span>}
          <div className="mist-col">{payBills.map(b => <div className="mist-row mist-module-actions" key={b.id} data-pay-bill={b.id}><Mono>{b.code}</Mono><span className="mist-note">发票 {b.invoiceNo} · 到期 {b.due}{b.overdue ? '（逾期）' : ''} · 未付 {apMoney(b.open, b.currency)}{payDraft.mode === 'request' && availableMinor(b) < Math.round(b.open * 100) ? ` · 可申请 ${apMoney(availableMinor(b) / 100, b.currency)}` : ''}</span><span className="mist-spacer" />
            <TextInput aria-label={b.code + (payDraft.mode === 'request' ? ' 申请金额' : ' 分配金额')} type="number" min="0.01" step="0.01" readOnly={payDraft.mode === 'pay'} disabled={busy || (payDraft.mode === 'allocate' && !canAllocate)} style={{ width: 140 }} value={payDraft.allocations[b.id] || ''} onChange={e => setPayDraft({ ...payDraft, allocations: { ...payDraft.allocations, [b.id]: e.target.value } })} /></div>)}
          {!payBills.length && <span className="mist-note">{payDraft.supplierId ? '这家供应商没有该币种可申请的未付票据。' : '先选择供应商。'}</span>}</div>
        </Field>}
        {payRequest?.purpose === 'prepayment' && <Banner title="合同预付款">{payRequest.purchaseCode} · 登记后挂在合同上，等结算确认后抵扣，不分配到票据。</Banner>}
        <Field label={payDraft.mode === 'request' ? '申请说明' : '备注'} required={payDraft.mode === 'request'} hint={payDraft.mode === 'request' ? '写明付款依据（到期、合同条款、供应商催款等），主管据此审批' : undefined}><TextArea aria-label={payDraft.mode === 'request' ? '申请说明' : '付款备注'} rows={2} value={payDraft.note} onChange={e => setPayDraft({ ...payDraft, note: e.target.value })} /></Field>
      </div>}
    </Dialog>

    <Dialog open={!!planDraft} onClose={() => { if (!busy) setPlanDraft(null); }} width={680} title="登记付款计划" description="按合同条款登记预付款、进度款或尾款的金额和触发条件。计划不是应付，也不会直接付款；付款须另行申请并经主管审批。"
      footer={<><Button disabled={busy} onClick={() => setPlanDraft(null)}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !canBill} onClick={submitPlan}>登记计划</Button></>}>
      {planDraft && <div className="mist-col">
        {failure && <Banner tone="bad" title="还不能登记">{failure}</Banner>}
        <Field label="来源合同" required><Select aria-label="来源合同" value={planDraft.purchaseId} options={[{ value: '', label: '请选择已批准合同' }, ...approvedPurchases.map(p => ({ value: p.id, label: `${p.code} · ${p.supplier} · ${apMoney(Math.round(p.quantity * p.price * 100) / 100, p.currency)}` }))]} onChange={e => { const po = approvedPurchases.find(p => p.id === e.target.value); setPlanDraft({ ...planDraft, purchaseId: e.target.value, basis: planDraft.basis || (po ? '合同付款条件：' + (po.terms || '未填写') : '') }); }} /></Field>
        <FormGrid>
          <Field label="计划类型" required><Select aria-label="计划类型" value={planDraft.stage} options={(['prepayment', 'progress', 'final'] as const).map(v => ({ value: v, label: paymentPlanStageLabel(v) }))} onChange={e => setPlanDraft({ ...planDraft, stage: e.target.value as PaymentPlanStage })} /></Field>
          <Field label={paymentPlanStageLabel(planDraft.stage) + '金额'} required><TextInput aria-label="计划金额" type="number" min="0.01" step="0.01" value={planDraft.amount} onChange={e => setPlanDraft({ ...planDraft, amount: e.target.value })} /></Field>
          <Field label="计划付款日" hint="合同有明确日期时填写"><TextInput aria-label="计划付款日" type="date" value={planDraft.due} onChange={e => setPlanDraft({ ...planDraft, due: e.target.value })} /></Field>
        </FormGrid>
        <Field label="付款触发条件" required hint="例如：合同回签后 7 天内"><TextInput aria-label="付款触发条件" value={planDraft.trigger} onChange={e => setPlanDraft({ ...planDraft, trigger: e.target.value })} /></Field>
        <Field label="合同条款依据" required><TextInput aria-label="合同条款依据" value={planDraft.basis} onChange={e => setPlanDraft({ ...planDraft, basis: e.target.value })} /></Field>
        <Field label="备注"><TextArea aria-label="计划备注" rows={2} value={planDraft.note} onChange={e => setPlanDraft({ ...planDraft, note: e.target.value })} /></Field>
      </div>}
    </Dialog>

    <Dialog open={!!preDraft} onClose={() => { if (!busy) setPreDraft(null); }} width={600} title="申请预付款" description={prePlan ? `${prePlan.code} · ${prePlan.purchaseCode} · ${prePlan.supplier} · 剩余可申请 ${apMoney(prePlan.available, prePlan.currency)}。提交后由主管审批。` : ''}
      footer={<><Button disabled={busy} onClick={() => setPreDraft(null)}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !canRequest} onClick={submitPre}>提交审批</Button></>}>
      {preDraft && prePlan && <div className="mist-col">
        {failure && <Banner tone="bad" title="还不能提交">{failure}</Banner>}
        <Facts items={[{ label: '付款触发条件', value: prePlan.trigger }, { label: '合同条款依据', value: prePlan.basis }]} />
        <Field label="申请金额" required><TextInput aria-label="申请金额" type="number" min="0.01" step="0.01" value={preDraft.amount} onChange={e => setPreDraft({ ...preDraft, amount: e.target.value })} /></Field>
        <Field label="申请说明" required hint="写明触发条件已满足的依据，例如合同已回签日期"><TextArea aria-label="申请说明" rows={3} value={preDraft.reason} onChange={e => setPreDraft({ ...preDraft, reason: e.target.value })} /></Field>
      </div>}
    </Dialog>

    <SettlementSubmitDialog open={settleOpen} state={state} busy={busy} canSettle={canSettle} failure={settleOpen ? failure : ''} onClose={() => { setSettleOpen(false); setFailure(''); }} execute={(command, done) => void execute(command, done)} onDone={id => { setSettleOpen(false); setView('settlements'); open(id); toast('结算已提交，等待财务复核'); }} />
    <SettlementConfirmDialog settlement={settlements.find(x => x.id === confirmId)} busy={busy} canConfirm={canConfirm} failure={confirmId ? failure : ''} onClose={() => { setConfirmId(''); setFailure(''); }} execute={(command, done) => void execute(command, done)} onDone={() => { setConfirmId(''); toast('结算已确认'); }} />
    {linkId && state && bills.find(b => b.id === linkId) && <BillLinkDialog bill={bills.find(b => b.id === linkId)!} state={state} busy={busy} allowed={canBill} failure={failure} onClose={() => { setLinkId(''); setFailure(''); }} execute={(command, done) => void execute(command, done)} onDone={() => { setLinkId(''); toast('已关联结算'); }} />}
    {deductId && state && bills.find(b => b.id === deductId) && <DeductionDialog bill={bills.find(b => b.id === deductId)!} state={state} busy={busy} allowed={canAllocate} failure={failure} onClose={() => { setDeductId(''); setFailure(''); }} execute={(command, done) => void execute(command, done)} onDone={() => { setDeductId(''); toast('索赔扣款已登记'); }} />}
    {moveDraft && state && <PrepaymentMoveDialog kind={moveDraft.kind} purchaseId={moveDraft.purchaseId} state={state} busy={busy} allowed={moveDraft.kind === 'refund' ? canPay && canConfirm : canConfirm} failure={failure} onClose={() => { setMoveDraft(null); setFailure(''); }} execute={(command, done) => void execute(command, done)} onDone={() => { const k = moveDraft.kind; setMoveDraft(null); toast(k === 'refund' ? '剩余预付退款已登记' : '剩余预付已转抵'); }} />}
    <Dialog open={!!reasonDraft} onClose={() => { if (!busy) setReasonDraft(null); }} title={reasonDraft ? REASON[reasonDraft.kind].title : ''} tone="bad" description={reasonDraft ? REASON[reasonDraft.kind].description : ''}
      footer={<><Button disabled={busy} onClick={() => setReasonDraft(null)}>取消</Button><Button variant="danger" loading={busy} disabled={busy || !reasonDraft || !reasonAllowed(reasonDraft.kind) || !reasonDraft.reason.trim()} onClick={submitReason}>{reasonDraft ? REASON[reasonDraft.kind].action : ''}</Button></>}>
      {reasonDraft && <div className="mist-col">{failure && <Banner tone="bad" title="未能完成">{failure}</Banner>}<Field label={REASON[reasonDraft.kind].label} required><TextArea aria-label={REASON[reasonDraft.kind].label} rows={3} value={reasonDraft.reason} onChange={e => setReasonDraft({ ...reasonDraft, reason: e.target.value })} /></Field></div>}
    </Dialog>
  </div>;
}
