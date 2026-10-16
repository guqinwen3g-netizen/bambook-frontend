/** BB-DEV-9：财务接收业务员发起的开发费用开票申请，按币种开具应收票据并回链开发案。 */
import React from 'react';
import { FileCheck } from 'lucide-react';
import { Banner, Button, Card, CardHeader, Dialog, Field, FormGrid, Mono, TextInput, TextLink } from '../../../../components/mist';
import type { MistCommand, MistDev, MistState } from '../../../../server/src/shared/mistWorkspace';
import { useNav } from '../nav';

type Props = { state: MistState; canInvoice: boolean; busy: boolean; execute: (command: MistCommand, success: (result: Record<string, unknown>) => void) => Promise<void> | void };
export const pendingDevelopmentBilling = (state: MistState): MistDev[] => state.devs.filter(dev => dev.billing?.request?.state === 'pending');

export function FinanceDevBilling({ state, canInvoice, busy, execute }: Props) {
  const { go } = useNav();
  const rows = pendingDevelopmentBilling(state);
  const [target, setTarget] = React.useState<MistDev | null>(null), [due, setDue] = React.useState('');
  if (!rows.length) return null;
  const totals = (dev: MistDev) => (dev.billing?.request?.totals || []).map(total => `${total.amount.toFixed(2)} ${total.currency}`).join(' + ');
  return <div className="mist-section"><Card>
    <CardHeader title="开发费用待开票" sub={`${rows.length} 个开发案已由业务员发起开票；每个币种开具一张应收票据并回链开发案`} />
    {rows.map(dev => <div className="mist-row" key={dev.id}>
      <TextLink onClick={() => go('development/detail', dev.id)}><Mono>{dev.code}</Mono> {dev.name}</TextLink>
      <span>{dev.billing!.request!.billTo}</span><b>{totals(dev)}</b>
      <span className="mist-note">{dev.billing!.request!.requestedBy} · {dev.billing!.request!.requestedAt.slice(0, 10)}</span>
      <Button size="sm" variant="primary" disabled={busy || !canInvoice} title={canInvoice ? undefined : '没有开票权限'} onClick={() => { setTarget(dev); setDue(''); }}>开票</Button>
    </div>)}
    <Dialog open={!!target} onClose={() => { if (!busy) setTarget(null); }} title={target ? `开具开发费用发票 · ${target.code}` : '开具开发费用发票'} description={target ? `${target.billing?.request?.billTo} · ${totals(target)}` : ''} footer={<><Button disabled={busy} onClick={() => setTarget(null)}>取消</Button><Button variant="primary" icon={FileCheck} loading={busy} disabled={busy || !canInvoice || !/^\d{4}-\d{2}-\d{2}$/.test(due)} onClick={() => { if (!target?.billing?.request) return; void execute({ type: 'finance.developmentInvoice.issue', payload: { devId: target.id, requestId: target.billing.request.id, due } }, () => setTarget(null)); }}>确认开票</Button></>}>
      {target && <Banner title="开票明细">{(target.billing?.request?.lines || []).map(line => `${line.versionLabel} ${line.label}：${line.amount.toFixed(2)} ${line.currency}`).join('；')}</Banner>}
      <FormGrid><Field label="到期日" required><TextInput aria-label="到期日" type="date" value={due} onChange={event => setDue(event.target.value)} /></Field></FormGrid>
    </Dialog>
  </Card></div>;
}
