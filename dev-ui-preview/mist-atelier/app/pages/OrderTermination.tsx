/** BB-ORD-7：草稿 / 已退回订单作废，已批准订单申请取消；终止后只读。 */
import React from 'react';
import { Ban, XCircle } from 'lucide-react';
import { Banner, Button, Dialog, Field, KeyValue, TextArea } from '../../../../components/mist';
import type { MistCommand, MistOrder, MistState } from '../../../../server/src/shared/mistWorkspace';
import { ORDER_CANCEL_ALTERNATIVE, orderCancelBlockers, type OrderGovernanceFields } from '../../../../server/src/shared/mistOrderGovernance';
import { OrderChangeImpactList } from './OrderChangeImpactList';

type Go = (view: string, id?: string, target?: Record<string, string | undefined>) => void;
type Governed = MistOrder & { governance?: OrderGovernanceFields };

/** 订单是否已终止（作废 / 取消）或取消审批中：页面所有编辑入口据此锁定。 */
export function orderLocked(order: Governed) {
  const g = order.governance;
  return g?.status === 'void' || g?.status === 'cancelled' || g?.cancellation?.status === 'pending';
}

export function OrderTerminationBanner({ order }: { order: Governed }) {
  const g = order.governance, t = g?.termination, c = g?.cancellation;
  const when = (at?: string) => at ? new Date(at).toLocaleString('zh-CN') : '';
  if (g?.status === 'void') return <Banner tone="neutral" title="订单已作废，只读">{`${t?.byName || ''} 于 ${when(t?.at)} 作废：${t?.reason || ''}。记录保留，不能再编辑、提交或进入采购与履约。`}</Banner>;
  if (g?.status === 'cancelled') return <Banner tone="bad" title="订单已取消，只读">{`取消原因：${t?.reason || c?.reason || ''}；${c?.decidedName || t?.byName || ''} 于 ${when(t?.at)} 批准。不能再采购、生产或出运；受影响的采购、生产、出运已生成待办，请到对应模块处理。`}</Banner>;
  if (c?.status === 'pending') return <Banner tone="warn" title="取消订单审批中，订单已锁定">{`${c.requesterName} 申请取消：${c.reason}。审批期间不能编辑，也不能新建采购、生产或出运；请在审批中心等待订单审批人决定。`}</Banner>;
  if (c?.status === 'rejected') return <Banner tone="neutral" title="取消订单申请已退回">{`${c.decidedName || ''}：${c.note || ''}。订单继续履约。`}</Banner>;
  return null;
}

export function OrderTerminationButton({ state, order, busy, run, go }: { state: MistState; order: Governed; busy: boolean; run: (command: MistCommand) => Promise<unknown>; go: Go }) {
  const g = order.governance, [open, setOpen] = React.useState(false), [reason, setReason] = React.useState(''), [failure, setFailure] = React.useState(''), [working, setWorking] = React.useState(false);
  if (!g || g.status === 'void' || g.status === 'cancelled' || g.cancellation?.status === 'pending') return null;
  const mode: 'void' | 'cancel' | null = g.status === 'draft' || g.status === 'rejected' ? 'void' : g.status === 'approved' ? 'cancel' : null;
  if (!mode) return null;
  const blockers = mode === 'cancel' ? orderCancelBlockers(state, order) : [], changePending = g.changeDraft?.status === 'pending';
  const submit = async () => {
    if (working) return; setFailure('');
    if (!reason.trim()) { setFailure(mode === 'void' ? '请填写作废原因' : '请填写取消原因'); return; }
    setWorking(true);
    try { await run(mode === 'void' ? { type: 'order.governance.void', payload: { orderId: order.id, reason: reason.trim() } } as MistCommand : { type: 'order.governance.requestCancel', payload: { orderId: order.id, reason: reason.trim() } } as MistCommand); setOpen(false); setReason(''); }
    catch (problem) { setFailure(problem instanceof Error ? problem.message : '提交失败，请重试'); }
    finally { setWorking(false); }
  };
  const title = mode === 'void' ? '作废订单' : '申请取消订单';
  return <>
    <Button icon={mode === 'void' ? Ban : XCircle} variant="danger" disabled={busy} onClick={() => { setOpen(true); setFailure(''); }}>{title}</Button>
    <Dialog open={open} onClose={() => { if (!working) setOpen(false); }} title={`${title} · ${order.code}`} width={720}
      footer={<><Button disabled={working} onClick={() => setOpen(false)}>返回</Button><Button variant="danger" loading={working} disabled={busy || working || blockers.length > 0 || changePending} onClick={() => void submit()}>{mode === 'void' ? '确认作废' : '提交取消审批'}</Button></>}>
      {failure && <Banner tone="bad" title="未能提交">{failure}</Banner>}
      {mode === 'void'
        ? <Banner tone="warn" title="作废后订单只读">记录不删除，订单列表默认隐藏（可筛选查看），不能再提交审批或进入采购与履约。仅订单负责人可作废。若订单由报价转来，报价侧仍记为已转单，需在报价模块另行协调。</Banner>
        : blockers.length
          ? <Banner tone="bad" title={ORDER_CANCEL_ALTERNATIVE}>{`${blockers.join('；')}。已出运或已开票的订单不能整单取消，请在条目详情中按实际数量结案。`}</Banner>
          : <Banner tone="warn" title="取消须经订单审批人批准">提交后进入审批中心，审批期间订单锁定；申请人不能审批自己的申请。批准后订单只读，不能再采购、生产或出运，受影响的采购、生产、出运各生成一条处理待办，不会删改其他模块的数据。</Banner>}
      {changePending && <Banner tone="warn" title="有待审批的变更">请先处理变更审批，再申请取消。</Banner>}
      {mode === 'cancel' && <KeyValue items={[{ label: '订单', value: `${order.code} · ${order.customer}` }, { label: '交期', value: order.due }]} />}
      {mode === 'cancel' && !blockers.length && <OrderChangeImpactList state={state} order={order} lines={[]} go={go} note="批准取消后，下列采购、生产、出运各生成一条“订单已取消，请处理”待办；不会自动改动这些记录。" />}
      <Field label={mode === 'void' ? '作废原因' : '取消原因'} required full><TextArea aria-label={mode === 'void' ? '作废原因' : '取消原因'} value={reason} onChange={e => setReason(e.target.value)} /></Field>
    </Dialog>
  </>;
}
