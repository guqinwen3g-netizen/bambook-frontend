/** 付款收尾：发票未到时按已确认结算先付（已付未收票）、系统上线前历史付款补登到计划、审批规则前的旧付款对应计划。
 *  都走已有权限；先付款须经主管审批，补登与对应只登记已经发生的事实，错误由冲回或取消对应更正。 */
import React from 'react';
import { Banner, Button, Dialog, Facts, Field, FormGrid, Pill, Select, TextArea, TextInput } from '../../../../components/mist';
import { type MistState } from '../../../../server/src/shared/mistWorkspace';
import { platformBusinessDate } from '../../../../server/src/shared/mistPlatform';
import { ADVANCE_INVOICE_REMIND_DAYS, backfillBillOptions, legacyPaymentPlanOptions, paymentPlanStageLabel, settlementAdvanceOpenMinor, settlementAdvancePaidMinor, settlementAdvanceRoomMinor, settlementHasLiveAdvance, type PayablesCommand, type PrepaymentPlanView, type SettlementView, type SupplierPaymentView } from '../../../../server/src/shared/mistPayables';
import { DetailBlock } from './modules/pageKit';

const money = (amount: number, currency: string) => `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const cents = (value: string) => { const n = Number(value); return value.trim() && Number.isFinite(n) ? Math.round(n * 100) : NaN; };
type Execute = (command: PayablesCommand, done: (result: Record<string, unknown>) => void) => void;
type Common = { state: MistState; busy: boolean; allowed: boolean; failure: string; onClose: () => void; execute: Execute; onDone: (result: Record<string, unknown>) => void };

/** 结算详情里的“不等票付款”：可申请额度、已付未收票，以及发起申请。 */
export function SettlementAdvance({ state, settlement: st, busy, canRequest, onRequest }: { state: MistState; settlement: SettlementView; busy: boolean; canRequest: boolean; onRequest: () => void }) {
  if (st.state !== 'confirmed') return null;
  const room = settlementAdvanceRoomMinor(state, st.id) / 100, paid = settlementAdvancePaidMinor(state, st.id) / 100, open = settlementAdvanceOpenMinor(state, st.id) / 100;
  if (room <= 0 && paid <= 0 && !settlementHasLiveAdvance(state, st.id)) return null;
  return <DetailBlock title="不等票付款">
    <Facts items={[{ label: '不等票可申请', value: money(room, st.currency) }, ...(paid > 0 ? [{ label: '已先付 / 其中未收票', value: money(paid, st.currency) + ' / ' + money(open, st.currency) }] : [])]} />
    {open > 0 && <Banner tone="warn" title="已付未收票">供应商票据到后按本结算登记，先付款自动抵到票据；超过 {ADVANCE_INVOICE_REMIND_DAYS} 天未收票会在应付汇总中提醒催票。</Banner>}
    {room > 0 && <div className="mist-row"><Button size="sm" disabled={busy || !canRequest} title={!canRequest ? '需要付款申请权限' : undefined} onClick={onRequest}>不等票申请付款</Button><span className="mist-note">工厂开票慢、货已到等情况；须写明未收票原因，经主管审批后付款。</span></div>}
  </DetailBlock>;
}

export function AdvanceRequestDialog({ state, settlement: st, busy, allowed, failure, onClose, execute, onDone }: Common & { settlement: SettlementView }) {
  const room = settlementAdvanceRoomMinor(state, st.id) / 100;
  const [amount, setAmount] = React.useState(String(room)), [reason, setReason] = React.useState(''), [local, setLocal] = React.useState('');
  const submit = () => {
    const value = cents(amount);
    if (!(value > 0)) return setLocal('申请金额必须大于零。');
    if (value > Math.round(room * 100)) return setLocal('申请金额超过不等票可申请额度。');
    if (!reason.trim()) return setLocal('请写明为什么不等发票先付款，供主管审批核对。');
    setLocal(''); execute({ type: 'payable.request.submit', payload: { purpose: 'settlement', settlementId: st.id, amount: value / 100, reason } }, onDone);
  };
  const message = local || failure;
  return <Dialog open onClose={() => { if (!busy) onClose(); }} width={600} title="不等票申请付款" description={`${st.code} · ${st.purchaseCode} · ${st.supplier}。结算净额 ${money(st.net, st.currency)}，不等票可申请 ${money(room, st.currency)}（未开票部分扣除待随票计入的预付抵扣和已申请的先付款）。`}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !allowed} onClick={submit}>提交审批</Button></>}>
    <div className="mist-col">
      {message && <Banner tone="bad" title="还不能提交">{message}</Banner>}
      <Field label="申请金额" required><TextInput aria-label="不等票申请金额" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
      <Field label="未收票原因" required hint="例如：工厂开票慢、货已发出验收合格。"><TextArea aria-label="未收票原因" rows={2} value={reason} onChange={e => setReason(e.target.value)} /></Field>
    </div>
  </Dialog>;
}

/** 历史补登：系统上线前已付的款，按凭证补到计划这一期；不走审批，记录操作人。 */
export function BackfillDialog({ state, plan, busy, allowed, failure, onClose, execute, onDone }: Common & { plan: PrepaymentPlanView }) {
  const day = platformBusinessDate(new Date()), bills = plan.stage === 'prepayment' ? [] : backfillBillOptions(state, plan.id);
  const [amount, setAmount] = React.useState(String(plan.available)), [date, setDate] = React.useState(''), [reference, setReference] = React.useState(''), [billId, setBillId] = React.useState(bills[0]?.bill.id || ''), [note, setNote] = React.useState(''), [local, setLocal] = React.useState('');
  const submit = () => {
    const value = cents(amount);
    if (!(value > 0)) return setLocal('补登金额必须大于零。');
    if (value > Math.round(plan.available * 100)) return setLocal('补登金额超过计划剩余（已扣除申请和已补登）。');
    if (!date || !reference.trim()) return setLocal('请填写实际付款日期和付款凭证号。');
    if (plan.stage !== 'prepayment' && !billId) return setLocal('进度款 / 尾款须对应已登记的供应商票据。');
    setLocal(''); execute({ type: 'payable.payment.backfill', payload: { planId: plan.id, date, amount: value / 100, reference, note, ...(plan.stage !== 'prepayment' ? { billId } : {}) } }, onDone);
  };
  const message = local || failure;
  return <Dialog open onClose={() => { if (!busy) onClose(); }} width={620} title="历史付款补登" description={`${plan.code} · ${paymentPlanStageLabel(plan.stage)} · ${plan.purchaseCode} · 剩余 ${money(plan.available, plan.currency)}。只用于系统上线前已经付掉的款：不再走付款申请和审批，补登记录标“历史补登”并留操作人，错了可冲回。`}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !allowed || (plan.stage !== 'prepayment' && !bills.length)} onClick={submit}>确认补登</Button></>}>
    <div className="mist-col">
      {message && <Banner tone="bad" title="还不能补登">{message}</Banner>}
      {plan.stage !== 'prepayment' && (bills.length ? <Field label="对应票据" required><Select aria-label="对应票据" value={billId} options={bills.map(o => ({ value: o.bill.id, label: `${o.bill.code} · 发票 ${o.bill.invoiceNo} · 可补登 ${money(o.room, o.bill.currency)}` }))} onChange={e => setBillId(e.target.value)} /></Field>
        : <Banner tone="warn" title="没有可对应的票据">进度款 / 尾款补登须对应这张合同已登记、还有未付余额的供应商票据；请先登记票据。</Banner>)}
      <FormGrid>
        <Field label="补登金额" required><TextInput aria-label="补登金额" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
        <Field label="实际付款日期" required><TextInput aria-label="实际付款日期" type="date" max={day} value={date} onChange={e => setDate(e.target.value)} /></Field>
      </FormGrid>
      <Field label="付款凭证号 / 银行流水号" required><TextInput aria-label="付款凭证号" value={reference} onChange={e => setReference(e.target.value)} /></Field>
      <Field label="补登说明"><TextArea aria-label="补登说明" rows={2} value={note} onChange={e => setNote(e.target.value)} /></Field>
    </div>
  </Dialog>;
}

/** 审批规则前登记的旧付款：事后对应到付款计划，用于计划的已付跟踪。 */
export function PlanLinkDialog({ state, payment, busy, allowed, failure, onClose, execute, onDone }: Common & { payment: SupplierPaymentView }) {
  const options = legacyPaymentPlanOptions(state, payment);
  const [planId, setPlanId] = React.useState(options[0]?.id || ''), [note, setNote] = React.useState(''), [local, setLocal] = React.useState('');
  const submit = () => { if (!planId) return setLocal('请选择付款计划。'); setLocal(''); execute({ type: 'payable.payment.plan', payload: { supplierPaymentId: payment.id, planId, note } }, onDone); };
  const message = local || failure;
  return <Dialog open onClose={() => { if (!busy) onClose(); }} width={600} title="旧付款对应付款计划" description={`${payment.code} · ${payment.supplier} · ${money(payment.amount, payment.currency)}。审批规则前登记的付款，对应后计入计划的已付；不改变付款和分配。`}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !allowed || !options.length} onClick={submit}>确认对应</Button></>}>
    <div className="mist-col">
      {message && <Banner tone="bad" title="还不能对应">{message}</Banner>}
      {options.length ? <Field label="付款计划" required><Select aria-label="付款计划" value={planId} options={options.map(p => ({ value: p.id, label: `${p.code} · ${paymentPlanStageLabel(p.stage || 'prepayment')} · ${p.purchaseCode} · ${money(p.amount, p.currency)}` }))} onChange={e => setPlanId(e.target.value)} /></Field>
        : <Banner tone="warn" title="没有可对应的计划">须为同一供应商、同币种的有效计划：预付款计划对应同合同的预付款，进度款 / 尾款计划须这笔付款已分配到该合同的票据，且计划剩余额度足够。</Banner>}
      <Field label="对应说明"><TextArea aria-label="对应说明" rows={2} value={note} onChange={e => setNote(e.target.value)} /></Field>
    </div>
  </Dialog>;
}

/** 付款列表“分配情况”列：先付款显示是否已收票。 */
export function advancePill(p: SupplierPaymentView) {
  return p.aheadOpen > 0 ? <Pill tone={p.aheadOverdue ? 'bad' : 'warn'}>{p.aheadOverdue ? `超 ${ADVANCE_INVOICE_REMIND_DAYS} 天未收票` : '已付未收票'}</Pill> : <span className="mist-note">已随票抵扣</span>;
}
