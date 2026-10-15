/** 应付收尾：发票先于结算到达的暂挂票据关联结算、索赔工厂扣款抵应付、短交最终结算后剩余预付的退款 / 转抵。
 *  都是财务对已登记事实的处理；错误由冲回更正，原记录保留。 */
import React from 'react';
import { Banner, Button, Dialog, Facts, Field, FormGrid, Mono, Pill, Select, TextArea, TextInput } from '../../../../components/mist';
import { type MistState } from '../../../../server/src/shared/mistWorkspace';
import { platformBusinessDate } from '../../../../server/src/shared/mistPlatform';
import { billRequestedUnpaidMinor, deductibleRecoveries, invoiceableSettlements, prepaymentTransferTargets, purchasePrepaymentReadback, type PayableBillView, type PayablesCommand, type PrepaymentMove, type SupplierDeduction } from '../../../../server/src/shared/mistPayables';
import { DetailBlock } from './modules/pageKit';
import { FieldGroup } from './FinanceSettlements';

const money = (amount: number, currency: string) => `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const cents = (value: string) => { const n = Number(value); return value.trim() && Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const fmtDay = (at?: string) => at ? platformBusinessDate(at) : '';
type Execute = (command: PayablesCommand, done: (result: Record<string, unknown>) => void) => void;
type Common = { state: MistState; busy: boolean; allowed: boolean; failure: string; onClose: () => void; execute: Execute; onDone: () => void };

/** 暂挂票据关联已确认结算：每个待关联合同行选一笔结算，结算未开票额须覆盖本行金额。 */
export function BillLinkDialog({ bill, state, busy, allowed, failure, onClose, execute, onDone }: Common & { bill: PayableBillView }) {
  const rows = bill.lines.filter(l => l.awaitingSettlement && !l.settlementId);
  const [links, setLinks] = React.useState<Record<string, string>>({}), [local, setLocal] = React.useState('');
  React.useEffect(() => { setLocal(''); setLinks(Object.fromEntries(rows.map(l => [l.purchaseId, invoiceableSettlements(state, l.purchaseId).find(o => o.left >= l.amount)?.settlement.id || '']))); }, [bill.id]);
  const chosen = rows.filter(l => links[l.purchaseId]);
  const submit = () => {
    if (!chosen.length) return setLocal('请至少给一个合同行选择已确认结算。');
    setLocal(''); execute({ type: 'payable.bill.link', payload: { id: bill.id, links: chosen.map(l => ({ purchaseId: l.purchaseId, settlementId: links[l.purchaseId] })) } }, onDone);
  };
  const message = local || failure;
  return <Dialog open onClose={() => { if (!busy) onClose(); }} width={680} title="关联结算" description={`${bill.code} · 发票 ${bill.invoiceNo}。结算经财务确认后关联，关联后按结算计入预付抵扣并可申请付款。`}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !allowed} onClick={submit}>确认关联</Button></>}>
    <div className="mist-col">
      {message && <Banner tone="bad" title="还不能关联">{message}</Banner>}
      <FieldGroup label="待关联的合同行" required hint="一行对应一笔结算；票额跨多笔结算时，请作废后按结算分行重新登记">
        <div className="mist-col">{rows.map(l => { const options = invoiceableSettlements(state, l.purchaseId); return <div className="mist-row mist-module-actions" key={l.purchaseId} data-link-line={l.purchaseId}>
          <Mono>{l.purchaseCode}</Mono><span className="mist-note">本票 {money(l.amount, bill.currency)}</span><span className="mist-spacer" />
          {options.length ? <Select aria-label={l.purchaseCode + ' 关联结算'} value={links[l.purchaseId] || ''} options={[{ value: '', label: '暂不关联' }, ...options.map(o => ({ value: o.settlement.id, label: `${o.settlement.code} · 未开票 ${money(o.left, o.settlement.currency)}${o.left < l.amount ? ' · 不足' : ''}` }))]} onChange={e => setLinks({ ...links, [l.purchaseId]: e.target.value })} />
            : <span className="mist-note">还没有已确认、未开票的结算</span>}
        </div>; })}</div>
      </FieldGroup>
    </div>
  </Dialog>;
}

/** 索赔扣款：工厂已同意“从货款中扣”（或组合方式）的追偿，按票据登记扣款，减少该票未付。 */
export function DeductionDialog({ bill, state, busy, allowed, failure, onClose, execute, onDone }: Common & { bill: PayableBillView }) {
  const options = deductibleRecoveries(state, bill.supplierId, bill.currency);
  const room = Math.max(0, Math.round(bill.open * 100) - billRequestedUnpaidMinor(state, bill.id));
  const [pick, setPick] = React.useState(options[0]?.recovery.id || ''), [amount, setAmount] = React.useState(''), [reference, setReference] = React.useState(''), [note, setNote] = React.useState(''), [local, setLocal] = React.useState('');
  const row = options.find(o => o.recovery.id === pick);
  React.useEffect(() => { setLocal(''); setAmount(row ? String(Math.min(Math.round(row.left * 100), room) / 100) : ''); }, [pick, bill.id]);
  const submit = () => {
    const value = cents(amount);
    if (!row) return setLocal('请选择要扣的工厂追偿。');
    if (!(value > 0)) return setLocal('扣款金额必须大于零。');
    if (value > Math.round(row.left * 100)) return setLocal('扣款金额超过该追偿还可扣的金额。');
    if (value > room) return setLocal('扣款金额超过本票可扣金额（未付扣除待付申请）。');
    if (!reference.trim()) return setLocal('请填写扣款依据，例如扣款通知或对账单编号。');
    setLocal(''); execute({ type: 'payable.deduction.register', payload: { recoveryId: row.recovery.id, billId: bill.id, amount: value / 100, reference, note } }, onDone);
  };
  const message = local || failure;
  return <Dialog open onClose={() => { if (!busy) onClose(); }} width={640} title="登记索赔扣款" description={`${bill.code} · ${bill.supplier} · 可扣 ${money(room / 100, bill.currency)}（未付扣除待付申请）。扣满工厂同意金额后，索赔里的追偿自动记为已落实。`}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !allowed} onClick={submit}>登记扣款</Button></>}>
    <div className="mist-col">
      {message && <Banner tone="bad" title="还不能登记">{message}</Banner>}
      <Field label="工厂追偿" required><Select aria-label="工厂追偿" value={pick} options={[{ value: '', label: '请选择' }, ...options.map(o => ({ value: o.recovery.id, label: `${o.claimCode} · 同意 ${money(o.recovery.agreed || 0, o.recovery.currency)} · 还可扣 ${money(o.left, o.recovery.currency)}${o.recovery.method === 'mixed' ? ' · 组合方式' : ''}` }))]} onChange={e => setPick(e.target.value)} /></Field>
      {row && row.deducted > 0 && <span className="mist-note">该追偿已在应付中扣 {money(row.deducted, row.recovery.currency)}。</span>}
      <FormGrid>
        <Field label="扣款金额" required><TextInput aria-label="扣款金额" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
        <Field label="扣款依据" required hint="扣款通知 / 对账单编号"><TextInput aria-label="扣款依据" value={reference} onChange={e => setReference(e.target.value)} /></Field>
      </FormGrid>
      <Field label="备注"><TextArea aria-label="扣款备注" rows={2} value={note} onChange={e => setNote(e.target.value)} /></Field>
    </div>
  </Dialog>;
}

/** 剩余预付处理：退款（供应商退回到账）或转抵到同一供应商的其他合同。 */
export function PrepaymentMoveDialog({ kind, purchaseId, state, busy, allowed, failure, onClose, execute, onDone }: Common & { kind: 'refund' | 'transfer'; purchaseId: string }) {
  const po = state.fulfillment.purchases.find(p => p.id === purchaseId), r = purchasePrepaymentReadback(state, purchaseId), targets = prepaymentTransferTargets(state, purchaseId), day = platformBusinessDate(new Date());
  const [amount, setAmount] = React.useState(String(r.available)), [date, setDate] = React.useState(day), [reference, setReference] = React.useState(''), [target, setTarget] = React.useState((targets.find(t => t.id === po?.cancellation?.targetPurchaseId) || targets[0])?.id || ''), [reason, setReason] = React.useState(''), [local, setLocal] = React.useState('');
  if (!po) return null;
  const submit = () => {
    const value = cents(amount);
    if (!(value > 0)) return setLocal('金额必须大于零。');
    if (value > Math.round(r.available * 100)) return setLocal('金额超过合同剩余预付。');
    if (!reason.trim()) return setLocal(kind === 'refund' ? '请填写退款说明。' : '请填写转抵依据，例如双方邮件确认。');
    if (kind === 'refund') {
      if (!date || !reference.trim()) return setLocal('请填写到账日期和银行流水号。');
      setLocal(''); execute({ type: 'payable.prepayment.refund', payload: { purchaseId, amount: value / 100, date, reference, reason } }, onDone); return;
    }
    if (!target) return setLocal('请选择转入合同。');
    setLocal(''); execute({ type: 'payable.prepayment.transfer', payload: { purchaseId, targetPurchaseId: target, amount: value / 100, reason } }, onDone);
  };
  const message = local || failure;
  return <Dialog open onClose={() => { if (!busy) onClose(); }} width={620} title={kind === 'refund' ? '登记剩余预付退款' : '剩余预付转抵到其他合同'} description={`${po.code} · ${po.supplier} · 剩余预付 ${money(r.available, po.currency)}。${kind === 'refund' ? '供应商退回的钱到账后登记，记一笔收款（负数付款）。' : '转入同一供应商、同币种、未最终结算的合同，在该合同结算时抵扣。'}`}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !allowed || (kind === 'transfer' && !targets.length)} onClick={submit}>{kind === 'refund' ? '登记退款' : '确认转抵'}</Button></>}>
    <div className="mist-col">
      {message && <Banner tone="bad" title="还不能保存">{message}</Banner>}
      {kind === 'transfer' && (targets.length ? <Field label="转入合同" required><Select aria-label="转入合同" value={target} options={targets.map(t => ({ value: t.id, label: `${t.code} · ${t.description} · ${t.quantity} ${t.unit}` }))} onChange={e => setTarget(e.target.value)} /></Field>
        : <Banner tone="warn" title="没有可转入的合同">这家供应商没有其他已批准、同币种、未最终结算的合同；可改为登记退款。</Banner>)}
      <FormGrid>
        <Field label={kind === 'refund' ? '退款金额' : '转抵金额'} required><TextInput aria-label={kind === 'refund' ? '退款金额' : '转抵金额'} type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
        {kind === 'refund' && <Field label="到账日期" required><TextInput aria-label="到账日期" type="date" max={day} value={date} onChange={e => setDate(e.target.value)} /></Field>}
      </FormGrid>
      {kind === 'refund' && <Field label="银行流水号 / 参考号" required><TextInput aria-label="退款流水号" value={reference} onChange={e => setReference(e.target.value)} /></Field>}
      <Field label={kind === 'refund' ? '退款说明' : '转抵依据'} required><TextArea aria-label={kind === 'refund' ? '退款说明' : '转抵依据'} rows={2} value={reason} onChange={e => setReason(e.target.value)} /></Field>
    </div>
  </Dialog>;
}

/** 合同预付去向：已付、已抵扣、退款、转入转出与剩余；最终结算后才可退款或转抵。 */
export function PrepaymentResidual({ state, purchaseId, busy, canRefund, canMove, onRefund, onTransfer, onReverse }: { state: MistState; purchaseId: string; busy: boolean; canRefund: boolean; canMove: boolean; onRefund: () => void; onTransfer: () => void; onReverse: (move: PrepaymentMove) => void }) {
  const r = purchasePrepaymentReadback(state, purchaseId), po = state.fulfillment.purchases.find(p => p.id === purchaseId), cur = po?.currency || '';
  if (!po || (r.paid <= 0 && r.transferredIn <= 0 && !r.moves.length)) return null;
  const closed = r.residualAfterFinal > 0 || r.moves.some(m => m.purchaseId === purchaseId);
  return <DetailBlock title="合同预付去向">
    <Facts items={[{ label: '已付预付', value: money(r.paid, cur) }, ...(r.transferredIn ? [{ label: '其他合同转入', value: money(r.transferredIn, cur) }] : []), { label: '结算已抵扣', value: money(r.applied, cur) }, ...(r.refunded ? [{ label: '供应商已退回', value: money(r.refunded, cur) }] : []), ...(r.transferredOut ? [{ label: '已转抵到其他合同', value: money(r.transferredOut, cur) }] : []), { label: '剩余预付', value: money(r.available, cur) }]} />
    {r.cancelled && <Banner tone={r.available > 0 ? 'warn' : 'neutral'} title="合同已取消">{r.cancelled.actor} · {fmtDay(r.cancelled.at)} · {r.cancelled.reason}。{r.cancelled.prepayment === 'refund' ? `业务员选择让工厂退款：${r.available > 0 ? `待退回 ${money(r.available, cur)}，到账后登记退款。` : '已全部退回。'}` : r.cancelled.prepayment === 'transfer' ? `业务员选择转抵到 ${r.cancelled.targetPurchaseCode}${r.available > 0 ? `，请财务办理转抵 ${money(r.available, cur)}。` : '，已处理完毕。'}` : '取消时没有已付预付。'}</Banner>}
    {r.residualAfterFinal > 0 && !r.cancelled && <Banner tone="warn" title="最终结算后仍有剩余预付">短交或结算金额小于预付时出现。请与供应商确认：退回到账后登记退款，或转抵到这家供应商的其他合同。</Banner>}
    {r.moves.map(m => { const out = m.purchaseId === purchaseId; return <div className="mist-row mist-module-actions" key={m.id} data-prepayment-move={m.id}><Mono>{m.code}</Mono>
      <span className="mist-note">{m.kind === 'refund' ? `退款 · ${m.date} · ${m.reference}` : out ? `转抵到 ${m.targetPurchaseCode}` : `由 ${m.purchaseCode} 转入`} · {m.actor} · {fmtDay(m.at)}</span><span className="mist-spacer" />
      <span className="mist-num">{out ? '−' : '+'}{money(m.amount, m.currency)}</span>
      {m.reversed ? <Pill tone="neutral">已冲回</Pill> : out && <Button size="sm" disabled={busy || !canMove} title={!canMove ? '需要核销权限（财务）' : undefined} onClick={() => onReverse(m)}>冲回</Button>}</div>; })}
    {closed && r.available > 0 && <div className="mist-row" style={{ flexWrap: 'wrap' }}>
      <Button size="sm" disabled={busy || !canRefund} title={!canRefund ? '需要付款登记和核销权限' : undefined} onClick={onRefund}>登记退款</Button>
      <Button size="sm" disabled={busy || !canMove} title={!canMove ? '需要核销权限（财务）' : undefined} onClick={onTransfer}>转抵到其他合同</Button></div>}
  </DetailBlock>;
}

/** 票据上的索赔扣款明细。 */
export function DeductionList({ rows, busy, canReverse, onReverse, onClaim }: { rows: SupplierDeduction[]; busy: boolean; canReverse: boolean; onReverse: (d: SupplierDeduction) => void; onClaim: (claimId: string) => void }) {
  if (!rows.length) return null;
  return <DetailBlock title="索赔扣款">{rows.map(d => <div className="mist-row mist-module-actions" key={d.id} data-deduction={d.id}><Mono>{d.code}</Mono><span className="mist-note">{d.claimCode} · {d.reference} · {d.actor} · {fmtDay(d.at)}</span><span className="mist-spacer" /><span className="mist-num">{money(d.amount, d.currency)}</span>
    {d.reversed ? <Pill tone="neutral">已冲回</Pill> : <Button size="sm" disabled={busy || !canReverse} title={!canReverse ? '需要核销权限（财务）' : undefined} onClick={() => onReverse(d)}>冲回扣款</Button>}
    <Button size="sm" onClick={() => onClaim(d.claimId)}>查看案件</Button></div>)}</DetailBlock>;
}
