/** 供应商结算：业务员按实际收货提交 → 财务复核确认并决定预付抵扣 → 发票到后关联结算登记票据。
 *  拒收不计结算；争议 / 未确认扣款单列，不自动抵减。抵扣建议按结算数量比例，最后一次结算扫尾；调整须写原因。 */
import React from 'react';
import { Banner, Button, Checkbox, Dialog, Facts, Field, FormGrid, Mono, ObjectCell, Pill, Select, TextArea, TextInput, type Column, type Tone } from '../../../../components/mist';
import { type MistState } from '../../../../server/src/shared/mistWorkspace';
import { platformBusinessDate } from '../../../../server/src/shared/mistPlatform';
import { purchaseContractMinor, purchasePrepaymentReadback, settlementReceipts, settlementSuggestedPrepaymentMinor, type PayablesCommand, type SettlementView } from '../../../../server/src/shared/mistPayables';
import { ActionBar, DetailBlock, DetailBody } from './modules/pageKit';

const money = (amount: number, currency: string) => `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const cents = (value: string) => { const n = Number(value); return value.trim() && Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const fmtDay = (at?: string) => at ? platformBusinessDate(at) : '';
export const SETTLEMENT_STATE: Record<SettlementView['state'], { tone: Tone; label: string }> = { pending: { tone: 'warn', label: '待财务复核' }, confirmed: { tone: 'ok', label: '已确认' }, returned: { tone: 'bad', label: '已退回' }, cancelled: { tone: 'neutral', label: '已撤回' }, reversed: { tone: 'neutral', label: '已冲回' } };

export function settlementColumns(): Column<SettlementView>[] {
  return [
    { key: 'code', header: '结算 / 合同', width: 'minmax(170px,1.4fr)', render: r => <ObjectCell name={<Mono>{r.code}</Mono>} meta={r.purchaseCode + ' · ' + r.supplier + (r.final ? ' · 最终结算' : '')} /> },
    { key: 'qty', header: '实收结算', width: '120px', align: 'right', hideOnMobile: true, render: r => <span className="mist-num">{r.quantity} {r.unit}</span> },
    { key: 'amount', header: '结算金额', width: '140px', align: 'right', render: r => <span className="mist-num">{money(r.amount, r.currency)}</span> },
    { key: 'pre', header: '预付抵扣', width: '140px', align: 'right', hideOnMobile: true, render: r => r.state === 'confirmed' ? <span className="mist-num">{money(r.confirmation?.prepaymentApplied || 0, r.currency)}</span> : r.state === 'pending' && r.suggested > 0 ? <span className="mist-note">建议 {money(r.suggested, r.currency)}</span> : '—' },
    { key: 'state', header: '状态', width: '104px', render: r => <Pill tone={SETTLEMENT_STATE[r.state].tone}>{SETTLEMENT_STATE[r.state].label}</Pill> },
  ];
}

export function SettlementDetail({ settlement: st, state, me, busy, canSettle, canConfirm, canBill, onConfirm, onReason, onBill, onPurchase }: {
  settlement: SettlementView; state: MistState; me: string; busy: boolean; canSettle: boolean; canConfirm: boolean; canBill: boolean;
  onConfirm: () => void; onReason: (kind: 'return-settlement' | 'cancel-settlement' | 'reverse-settlement') => void; onBill: () => void; onPurchase: () => void;
}) {
  const receipts = state.fulfillment.receipts.filter(r => st.receiptIds.includes(r.id));
  const own = st.submitterId === me;
  return <DetailBody data-settlement={st.id} heading={<h2 className="mist-h2">{st.code}</h2>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={SETTLEMENT_STATE[st.state].tone}>{SETTLEMENT_STATE[st.state].label}</Pill>{st.final && <Pill tone="accent">最终结算</Pill>}<span className="mist-note">{st.submittedBy} · 提交于 {fmtDay(st.submittedAt)}</span></div>
    <Facts items={[
      { label: '来源合同', value: <Mono>{st.purchaseCode}</Mono> }, { label: '供应商', value: st.supplier },
      { label: '实收结算数量', value: `${st.quantity} ${st.unit} × ${st.price} ${st.currency}` }, { label: '结算金额', value: money(st.amount, st.currency) },
      ...(st.rejected ? [{ label: '拒收（不计结算）', value: `${st.rejected} ${st.unit}` }] : []),
      ...(st.state === 'confirmed' ? [{ label: '预付抵扣', value: money(st.confirmation?.prepaymentApplied || 0, st.currency) + (st.confirmation && st.confirmation.prepaymentApplied !== st.confirmation.suggestedPrepayment ? `（建议 ${money(st.confirmation.suggestedPrepayment, st.currency)}）` : '') }, { label: '抵扣后应付', value: money(st.net, st.currency) }, { label: '已关联票据 / 未开票', value: money(st.invoiced, st.currency) + ' / ' + money(st.uninvoiced, st.currency) }] : []),
      ...(st.state === 'pending' ? [{ label: '建议预付抵扣', value: money(st.suggested, st.currency) + ` · 合同剩余可抵扣 ${money(st.available, st.currency)}` }] : []),
      ...(st.note ? [{ label: '结算说明', value: st.note }] : []),
    ]} />
    {st.state === 'pending' && <Banner tone="warn" title="等待财务复核">财务核对收货记录、数量和单价后确认；确认后才算已确认结算，并按比例抵扣预付。</Banner>}
    {st.confirmation && <Banner tone="ok" title="财务已确认">{st.confirmation.actor} · {fmtDay(st.confirmation.at)}{st.confirmation.adjustReason ? `。抵扣调整原因：${st.confirmation.adjustReason}` : ''}{st.confirmation.note ? `。${st.confirmation.note}` : ''}</Banner>}
    {st.returned && <Banner tone="bad" title="财务已退回">{st.returned.reason}（{st.returned.actor} · {fmtDay(st.returned.at)}）。收货记录已释放，可修正后重新提交。</Banner>}
    {st.cancelled && <Banner title="已撤回">{st.cancelled.reason}（{st.cancelled.actor} · {fmtDay(st.cancelled.at)}）</Banner>}
    {st.reversed && <Banner title="已冲回">{st.reversed.reason}（{st.reversed.actor} · {fmtDay(st.reversed.at)}）。原记录保留；收货记录和预付抵扣已释放。</Banner>}
    <ActionBar busy={busy} actions={[
      { label: '确认结算', onClick: onConfirm, reason: !canConfirm ? '需要核销权限（财务）' : own ? '不能复核本人提交的结算' : undefined, hidden: st.state !== 'pending' },
      { label: '退回结算', onClick: () => onReason('return-settlement'), reason: !canConfirm ? '需要核销权限（财务）' : own ? '不能复核本人提交的结算' : undefined, hidden: st.state !== 'pending' },
      { label: '撤回结算', onClick: () => onReason('cancel-settlement'), reason: !canSettle ? '需要采购经办权限' : !own ? '只有提交人可以撤回' : undefined, hidden: st.state !== 'pending' },
      { label: '按结算登记票据', onClick: onBill, reason: !canBill ? '需要票据登记权限' : st.uninvoiced <= 0 ? '本结算已全部开票' : undefined, hidden: st.state !== 'confirmed' },
      { label: '冲回结算', onClick: () => onReason('reverse-settlement'), reason: !canConfirm ? '需要核销权限（财务）' : st.invoiced > 0 ? '已关联票据，请先作废关联票据' : undefined, hidden: st.state !== 'confirmed' },
      { label: '查看合同', onClick: onPurchase },
    ]} />
    <DetailBlock title="对应收货记录">{receipts.map(r => <div className="mist-row mist-module-actions" key={r.id}><span>{r.date}</span><span className="mist-note">{r.location} · {r.evidence}</span><span className="mist-spacer" /><span className="mist-num">实收 {r.quantity}{r.rejected ? ` · 拒收 ${r.rejected}` : ''} {st.unit}</span></div>)}
      {!receipts.length && <span className="mist-note">收货记录未找到。</span>}</DetailBlock>
    <DetailBlock title="争议 / 未确认扣款（单列，不抵减）">{st.disputes.map((d, i) => <div className="mist-row mist-module-actions" key={i}><span>{d.description}</span><span className="mist-spacer" /><span className="mist-num">{money(d.amount, st.currency)}</span></div>)}
      {!st.disputes.length && <span className="mist-note">没有登记争议或扣款。</span>}</DetailBlock>
  </DetailBody>;
}

type SubmitDraft = { purchaseId: string; receipts: Record<string, boolean>; final: boolean; disputes: Array<{ description: string; amount: string }>; note: string };
/** 多个控件的分组：不能用 <label>（会把整组文字当成第一个控件的名称，点说明文字也会误触按钮）。 */
function FieldGroup({ label, required, hint, children }: { label: string; required?: boolean; hint?: React.ReactNode; children: React.ReactNode }) {
  return <div className="mist-field" role="group" aria-label={label}><span className="mist-field-label">{label}{required && <em>*</em>}</span>{children}{hint && <span className="mist-field-hint">{hint}</span>}</div>;
}

export function SettlementSubmitDialog({ open, state, busy, canSettle, failure, onClose, execute, onDone }: {
  open: boolean; state: MistState | null; busy: boolean; canSettle: boolean; failure: string; onClose: () => void;
  execute: (command: PayablesCommand, done: (result: Record<string, unknown>) => void, local?: string) => void; onDone: (id: string) => void;
}) {
  const [draft, setDraft] = React.useState<SubmitDraft>({ purchaseId: '', receipts: {}, final: false, disputes: [], note: '' }), [local, setLocal] = React.useState('');
  React.useEffect(() => { if (open) { setDraft({ purchaseId: '', receipts: {}, final: false, disputes: [], note: '' }); setLocal(''); } }, [open]);
  const purchases = (state?.fulfillment.purchases || []).filter(p => p.state === 'approved');
  const po = purchases.find(p => p.id === draft.purchaseId);
  const rows = state && po ? settlementReceipts(state, po.id) : [];
  const chosen = rows.filter(r => draft.receipts[r.receipt.id] && !r.settled);
  const qty = chosen.reduce((n, r) => n + r.receipt.quantity, 0), amount = po ? Math.round(qty * po.price * 100) : 0;
  const prepay = state && po ? purchasePrepaymentReadback(state, po.id) : null;
  const suggested = state && po && qty > 0 ? settlementSuggestedPrepaymentMinor(state, { id: '', purchaseId: po.id, quantity: qty, amount: amount / 100, final: draft.final }) : 0;
  const submit = () => {
    if (!po) return setLocal('请选择合同。');
    if (!chosen.length) return setLocal('请至少勾选一条实际收货记录。');
    if (qty <= 0) return setLocal('所选收货记录没有实收合格数量；拒收数量不计入结算。');
    const disputes = draft.disputes.filter(d => d.description.trim() || d.amount.trim());
    if (disputes.some(d => !d.description.trim() || !(cents(d.amount) > 0))) return setLocal('每条争议 / 扣款都要写明说明和大于零的金额。');
    setLocal('');
    execute({ type: 'payable.settlement.submit', payload: { purchaseId: po.id, receiptIds: chosen.map(r => r.receipt.id), final: draft.final, disputes: disputes.map(d => ({ description: d.description, amount: cents(d.amount) / 100 })), note: draft.note } }, r => onDone(String(r.id)));
  };
  const message = local || failure;
  return <Dialog open={open} onClose={() => { if (!busy) onClose(); }} width={760} title="提交结算" description="按实际收货记录提交，财务复核确认后成为已确认结算。拒收不计；争议和未确认扣款单列，不抵减结算金额。"
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !canSettle} onClick={submit}>提交复核</Button></>}>
    <div className="mist-col">
      {message && <Banner tone="bad" title="还不能提交">{message}</Banner>}
      <Field label="来源合同" required><Select aria-label="结算合同" value={draft.purchaseId} options={[{ value: '', label: '请选择已批准合同' }, ...purchases.map(p => ({ value: p.id, label: `${p.code} · ${p.supplier} · ${p.quantity} ${p.unit} · ${money(purchaseContractMinor(p) / 100, p.currency)}` }))]} onChange={e => setDraft({ ...draft, purchaseId: e.target.value, receipts: {} })} /></Field>
      {po && <FieldGroup label="实际收货记录" required hint={`本次实收 ${qty} ${po.unit} · 结算金额 ${money(amount / 100, po.currency)}`}>
        <div className="mist-col">{rows.map(({ receipt: r, settled }) => <div className="mist-row mist-module-actions" key={r.id} data-settle-receipt={r.id}>
          <Checkbox checked={!!draft.receipts[r.id] && !settled} disabled={settled || r.quantity <= 0} onChange={v => setDraft({ ...draft, receipts: { ...draft.receipts, [r.id]: v } })} label={<span>{r.date} · {r.location} · 实收 {r.quantity}{r.rejected ? ` · 拒收 ${r.rejected}` : ''} {po.unit}{settled ? ' · 已在结算中' : r.quantity <= 0 ? ' · 无实收' : ''}</span>} /></div>)}
          {!rows.length && <span className="mist-note">这张合同还没有实际收货记录；先在采购详情登记收货。</span>}</div>
      </FieldGroup>}
      {po && <Checkbox checked={draft.final} onChange={v => setDraft({ ...draft, final: v })} label="这是本合同最终结算（短交关闭或已全部交付）；将抵扣剩余全部预付" />}
      {po && prepay && prepay.paid > 0 && <Banner title="预付抵扣建议（由财务确认）">合同已付预付 {money(prepay.paid, po.currency)}，已抵扣 {money(prepay.applied, po.currency)}。本次建议抵扣 {money(suggested / 100, po.currency)}{draft.final || qty === 0 ? '' : `（预付 × ${qty} ÷ ${po.quantity}）`}。</Banner>}
      <FieldGroup label="争议 / 未确认扣款" hint="例如色差、短码待供应商确认的扣款；单列记录，不抵减结算金额">
        <div className="mist-col">{draft.disputes.map((d, i) => <FormGrid key={i}>
          <TextInput aria-label={`争议说明 ${i + 1}`} value={d.description} onChange={e => setDraft({ ...draft, disputes: draft.disputes.map((x, j) => j === i ? { ...x, description: e.target.value } : x) })} />
          <TextInput aria-label={`争议金额 ${i + 1}`} type="number" min="0.01" step="0.01" value={d.amount} onChange={e => setDraft({ ...draft, disputes: draft.disputes.map((x, j) => j === i ? { ...x, amount: e.target.value } : x) })} />
        </FormGrid>)}
          <div className="mist-row"><Button size="sm" disabled={draft.disputes.length >= 20} onClick={() => setDraft({ ...draft, disputes: [...draft.disputes, { description: '', amount: '' }] })}>添加争议 / 扣款</Button></div></div>
      </FieldGroup>
      <Field label="结算说明"><TextArea aria-label="结算说明" rows={2} value={draft.note} onChange={e => setDraft({ ...draft, note: e.target.value })} /></Field>
    </div>
  </Dialog>;
}

export function SettlementConfirmDialog({ settlement: st, busy, canConfirm, failure, onClose, execute, onDone }: {
  settlement: SettlementView | undefined; busy: boolean; canConfirm: boolean; failure: string; onClose: () => void;
  execute: (command: PayablesCommand, done: (result: Record<string, unknown>) => void) => void; onDone: () => void;
}) {
  const [applied, setApplied] = React.useState(''), [adjust, setAdjust] = React.useState(''), [note, setNote] = React.useState(''), [local, setLocal] = React.useState('');
  React.useEffect(() => { if (st) { setApplied(String(st.suggested)); setAdjust(''); setNote(''); setLocal(''); } }, [st?.id]);
  if (!st) return null;
  const value = cents(applied || '0'), changed = value !== Math.round(st.suggested * 100);
  const submit = () => {
    if (Number.isNaN(value) || value < 0) return setLocal('预付抵扣格式无效。');
    if (value > Math.round(st.available * 100)) return setLocal('预付抵扣超过合同剩余可抵扣预付。');
    if (value > Math.round(st.amount * 100)) return setLocal('预付抵扣不能超过结算金额。');
    if (changed && !adjust.trim()) return setLocal('抵扣额与建议不同，请写明调整原因。');
    setLocal(''); execute({ type: 'payable.settlement.confirm', payload: { id: st.id, prepaymentApplied: value / 100, adjustReason: changed ? adjust : undefined, note } }, onDone);
  };
  const message = local || failure;
  return <Dialog open onClose={() => { if (!busy) onClose(); }} width={640} title="确认结算" description={`${st.code} · ${st.purchaseCode} · 实收 ${st.quantity} ${st.unit} · ${money(st.amount, st.currency)}。核对收货记录、数量与单价后确认。`}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !canConfirm} onClick={submit}>确认结算</Button></>}>
    <div className="mist-col">
      {message && <Banner tone="bad" title="还不能确认">{message}</Banner>}
      <Facts items={[{ label: '建议预付抵扣', value: money(st.suggested, st.currency) + (st.final ? '（最终结算：抵扣剩余全部预付）' : '（按结算数量比例）') }, { label: '合同剩余可抵扣', value: money(st.available, st.currency) }, ...(st.disputes.length ? [{ label: '争议 / 扣款（不抵减）', value: st.disputes.map(d => `${d.description} ${money(d.amount, st.currency)}`).join('；') }] : [])]} />
      <Field label="本次预付抵扣" required><TextInput aria-label="本次预付抵扣" type="number" min="0" step="0.01" value={applied} onChange={e => setApplied(e.target.value)} /></Field>
      {changed && <Field label="调整原因" required hint="抵扣额与建议不同时必须写明，例如合同约定首批不抵扣"><TextInput aria-label="调整原因" value={adjust} onChange={e => setAdjust(e.target.value)} /></Field>}
      <Field label="复核意见"><TextArea aria-label="复核意见" rows={2} value={note} onChange={e => setNote(e.target.value)} /></Field>
    </div>
  </Dialog>;
}
