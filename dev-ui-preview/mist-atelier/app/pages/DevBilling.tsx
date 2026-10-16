/** BB-DEV-9：开发费用（制作费 + 寄样费，按币种合计）→ 发起开票 → 财务票据回链 → 销账后最终结案。 */
import React from 'react';
import { Receipt, Send } from 'lucide-react';
import { Banner, Button, Card, CardFooter, CardHeader, Dialog, Field, FormGrid, Mono, Pill, Select, TextInput, TextLink, useToast } from '../../../../components/mist';
import { developmentCharged } from '../../../../server/src/shared/mistDevelopmentDomain';
import { billingRequestBlocker, developmentBillTo, developmentBillingInvoices, developmentBillingStage, developmentFeeSummary, developmentSamplesOf, makingFeeBlocker } from '../../../../server/src/shared/mistDevelopmentBilling';
import { isActiveMistInvoice, type MistCommand, type MistDev, type MistState } from '../../../../server/src/shared/mistWorkspace';
import { useNav } from '../nav';

type Props = { state: MistState; dev: MistDev; disabled?: boolean; run: (command: MistCommand) => Promise<unknown> };
const money = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`;

export function DevBillingCard({ state, dev, disabled, run }: Props) {
  const toast = useToast(), { go } = useNav();
  const [open, setOpen] = React.useState(false), [busy, setBusy] = React.useState(false), [failure, setFailure] = React.useState('');
  const [fee, setFee] = React.useState({ sampleId: '', amount: '', currency: 'CNY' });
  if (!developmentCharged(dev.values)) return <Card><CardHeader title="开发费用" sub="不收费开发" /><p className="mist-note">本案为不收费开发，需求方认可即结案，不登记费用、不发起开票。</p></Card>;
  const summary = developmentFeeSummary(state, dev), request = dev.billing?.request, stage = developmentBillingStage(state, dev);
  const samples = developmentSamplesOf(state, dev), invoices = developmentBillingInvoices(state, dev);
  const unrecorded = samples.filter(sample => !makingFeeBlocker(state, dev, sample.id));
  const requestBlocker = billingRequestBlocker(state, dev);
  const feeError = !fee.sampleId ? '请选择实物' : !/^\d{1,12}(\.\d{1,2})?$/.test(fee.amount.trim()) || Number(fee.amount) <= 0 ? '制作费须为大于零、最多两位小数的总额' : !/^[A-Za-z]{3}$/.test(fee.currency.trim()) ? '请填写三位币种代码' : null;
  const execute = async (command: MistCommand, done: () => void) => {
    if (busy) return; setBusy(true); setFailure('');
    try { await run(command); done(); } catch (problem) { setFailure(problem instanceof Error ? problem.message : '操作失败，请重试'); } finally { setBusy(false); }
  };
  const openFee = (sampleId = unrecorded[0]?.id || '') => { setFee({ sampleId, amount: '', currency: 'CNY' }); setFailure(''); setOpen(true); };
  return <Card>
    <CardHeader title="开发费用" sub={`收费开发 · 费用归属 ${developmentBillTo(dev) || '未指定需求方'}`} tools={stage && <Pill tone={stage.tone}>{stage.label}</Pill>} />
    {failure && !open && <Banner tone="bad" title="未完成">{failure}</Banner>}
    <div className="mist-section">
      <span className="mist-eyebrow">制作费（每条实物一笔总额）</span>
      {samples.length ? samples.map(sample => { const row = dev.billing?.makingFees.find(item => item.sampleId === sample.id); return <div className="mist-row" key={sample.id}>
        <span>{state.versions.find(version => sample.source.kind === 'version' && version.id === sample.source.versionId)?.label} · {sample.form} <Mono>{sample.code}</Mono></span>
        {row ? <b>{money(row.amount, row.currency)}</b> : <><span className="mist-note">未登记</span>{!request && <Button size="sm" disabled={disabled || busy} onClick={() => openFee(sample.id)}>登记制作费</Button>}</>}
      </div>; }) : <p className="mist-note">本案尚无入库实物。</p>}
    </div>
    <div className="mist-section">
      <span className="mist-eyebrow">寄样费（每次寄样一笔）</span>
      {summary.lines.filter(line => line.kind === 'dispatch').map(line => <div className="mist-row" key={line.refId}><span>{line.versionLabel} · {line.label}</span><b>{money(line.amount, line.currency)}</b></div>)}
      {!dev.versionIds.some(id => state.versions.find(version => version.id === id)?.dispatches?.length) && <p className="mist-note">暂无寄样记录。</p>}
      {summary.missing.filter(text => text.includes('寄样费')).length > 0 && <p className="mist-note">缺寄样费的记录请在对应版本的寄样记录中补登。</p>}
    </div>
    <div className="mist-section">
      <span className="mist-eyebrow">费用汇总（按币种分别合计，不折算）</span>
      {(request?.totals || summary.totals).length ? (request?.totals || summary.totals).map(total => <div className="mist-row" key={total.currency}><span>{total.currency}</span><b>{money(total.amount, total.currency)}</b></div>) : <p className="mist-note">尚无费用。</p>}
      {!request && summary.missing.length > 0 && <Banner tone="warn" title="费用尚未补齐">{summary.missing.join('；')}</Banner>}
    </div>
    {request && <div className="mist-section">
      <span className="mist-eyebrow">开票</span>
      <p className="mist-note">{request.requestedBy} 于 {request.requestedAt.slice(0, 10)} 发起开票 → {request.billTo}{request.state === 'pending' ? ' · 等待财务开票' : ` · 财务 ${request.invoicedBy || ''} 已开票`}</p>
      {invoices.map(invoice => <div className="mist-row" key={invoice.id}>
        <TextLink onClick={() => go('payment-vouchers', invoice.id)}>{invoice.code}</TextLink>
        <span>{money(invoice.amount, invoice.currency)}</span><span className="mist-note">未收 {money(invoice.open, invoice.currency)}</span>
        <Pill tone={!isActiveMistInvoice(invoice) ? 'bad' : invoice.open <= 0 ? 'ok' : 'warn'}>{!isActiveMistInvoice(invoice) ? '已作废' : invoice.open <= 0 ? '已销账' : '待收款'}</Pill>
      </div>)}
    </div>}
    {!request && <CardFooter>
      {unrecorded.length > 0 && <Button disabled={disabled || busy} onClick={() => openFee()}>登记制作费</Button>}
      <Button variant="primary" icon={Send} loading={busy} disabled={disabled || busy || !!requestBlocker} title={requestBlocker || undefined} onClick={() => void execute({ type: 'development.billing.request', payload: { devId: dev.id } }, () => toast('已发起开票，财务将在财务模块开具票据'))}>发起开票</Button>
      {requestBlocker && <span className="mist-note">{requestBlocker}</span>}
    </CardFooter>}
    <Dialog open={open} onClose={() => { if (!busy) setOpen(false); }} title="登记制作费" description="每条实物登记一笔制作费总额，不拆单价；登记后不能覆盖。" footer={<><Button disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button variant="primary" icon={Receipt} loading={busy} disabled={busy || !!feeError} onClick={() => void execute({ type: 'development.fee.recordMaking', payload: { devId: dev.id, sampleId: fee.sampleId, amount: Number(fee.amount), currency: fee.currency.trim().toUpperCase() } }, () => { setOpen(false); toast('制作费已登记'); })}>登记</Button></>}>
      {failure && <Banner tone="bad" title="未登记">{failure}</Banner>}
      <FormGrid>
        <Field label="实物" required><Select aria-label="实物" value={fee.sampleId} options={[{ value: '', label: '请选择实物' }, ...unrecorded.map(sample => ({ value: sample.id, label: `${sample.form} ${sample.code}` }))]} onChange={event => setFee({ ...fee, sampleId: event.target.value })} /></Field>
        <Field label="制作费总额" required><TextInput aria-label="制作费总额" type="number" min="0.01" step="0.01" value={fee.amount} onChange={event => setFee({ ...fee, amount: event.target.value })} /></Field>
        <Field label="币种" required><TextInput aria-label="制作费币种" value={fee.currency} onChange={event => setFee({ ...fee, currency: event.target.value })} /></Field>
      </FormGrid>
      {feeError && <p className="mist-note">{feeError}</p>}
    </Dialog>
  </Card>;
}
