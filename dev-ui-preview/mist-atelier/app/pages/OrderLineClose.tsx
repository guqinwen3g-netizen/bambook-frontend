/** BB-ORD-5：条目按实际结案的确认弹窗。结案数量 = 已离港数量；范围内直接结案，超出范围提交审批。 */
import React from 'react';
import { Banner, Button, Dialog, Field, KeyValue, TextArea } from '../../../../components/mist';
import type { MistOrderLine } from '../../../../server/src/shared/mistWorkspace';
import type { lineToleranceStatus } from '../../../../server/src/shared/mistOrderClosure';
import { formatOrderQuantity as q } from './orderAmounts';

export function LineCloseDialog({ open, line, status, onClose, onSubmit }: { open: boolean; line: MistOrderLine; status: ReturnType<typeof lineToleranceStatus>; onClose: () => void; onSubmit: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = React.useState(''), [busy, setBusy] = React.useState(false), [failure, setFailure] = React.useState('');
  React.useEffect(() => { if (open) { setReason(''); setFailure(''); setBusy(false); } }, [open, line.id]);
  const within = status.departed >= status.min && status.departed <= status.max;
  const submit = async () => {
    if (busy) return; if (!reason.trim()) { setFailure('请写明结案原因'); return; }
    setBusy(true); setFailure('');
    try { await onSubmit(reason.trim()); onClose(); } catch (problem) { setFailure(problem instanceof Error ? problem.message : '结案未成功，请重试'); } finally { setBusy(false); }
  };
  return <Dialog open={open} onClose={() => { if (!busy) onClose(); }} title="按实际完工结案" description={`${line.style} · ${line.name}`} footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy} onClick={() => void submit()}>{within ? '确认结案' : '提交结案审批'}</Button></>}>
    <KeyValue items={[{ label: '订单数量', value: `${q(line.qty)} ${line.unit}` }, { label: '溢短装条款', value: status.text }, { label: '允许范围', value: `${q(status.min)} – ${q(status.max)} ${line.unit}` }, { label: '结案数量（已离港）', value: `${q(status.departed)} ${line.unit}` }]} />
    {within ? <Banner tone="ok" title="在允许范围内">确认后直接结案。</Banner> : <Banner tone="warn" title="超出允许范围">将提交订单审批人审批，批准后才结案；申请人不能自批。</Banner>}
    <Field label="结案原因" required full><TextArea aria-label="结案原因" value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></Field>
    {failure && <Banner tone="bad" title="未能结案">{failure}</Banner>}
  </Dialog>;
}
