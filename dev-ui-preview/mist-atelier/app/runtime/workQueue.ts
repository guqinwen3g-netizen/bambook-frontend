import type { MistState, MistTarget } from '../../../../server/src/shared/mistWorkspace';
import type { MistReview } from './reviews';

type CanRead = (view: string) => boolean;
export type MistWorkSource = 'review' | 'qc' | 'shipping' | 'finance';
/** 由业务记录派生、需要我接手的事项。不写入工作空间，原记录状态变化后自动消失。 */
export type MistWorkItem = { id: string; source: MistWorkSource; sourceLabel: string; title: string; meta: string; when: string; urgent: boolean; at: string; target: MistTarget };
export const MIST_WORK_SOURCE_LABEL: Record<MistWorkSource, string> = { review: '待我审批', qc: 'QC 报告回传', shipping: '出运资料', finance: '财务退回' };
const FINANCE_RETURN_DAYS = 30;

/**
 * 我的工作待办来源（页面清单 §6.1）：审批待我、QC 报告回传待业务确认、已出运待寄单、付款申请被退回。
 * 只返回当前账号有权查看的来源；邮件跟进已作为工作事项保存，在事项列表中按来源标注。
 */
export function mistWorkQueue(state: MistState | null | undefined, options: { canRead: CanRead; me: string; reviews?: MistReview[]; today: string }): MistWorkItem[] {
  const { canRead, me, reviews = [], today } = options, items: MistWorkItem[] = [];
  for (const review of reviews.filter(row => row.status === 'pending' && row.canDecide))
    items.push({ id: `review:${review.workspaceId}|${review.id}`, source: 'review', sourceLabel: MIST_WORK_SOURCE_LABEL.review, title: review.title, meta: [review.workspaceName, review.submittedAt.slice(0, 10)].filter(Boolean).join(' · '), when: '待审批', urgent: true, at: review.submittedAt,
      target: { view: 'approvals', id: `${review.workspaceId}|${review.id}`, section: 'mine' } as MistTarget });
  if (!state) return items;
  if (canRead('qc-workbench')) for (const task of state.fulfillment.qcTasks) {
    const sampleBack = task.kind === 'sample' && task.state === 'reported' && !task.businessConfirmation;
    const productionBack = task.kind === 'production' && (task.state === 'awaiting_business' || task.state === 'blocked');
    if (!sampleBack && !productionBack) continue;
    items.push({ id: 'qc:' + task.id, source: 'qc', sourceLabel: MIST_WORK_SOURCE_LABEL.qc, title: `${task.code} · ${task.kind === 'sample' ? '样品评审结果待确认' : task.state === 'blocked' ? '检验不通过，待业务决定' : '检验结果待业务确认'}`,
      meta: [task.factory, task.requestedBy && '发起人 ' + task.requestedBy].filter(Boolean).join(' · '), when: task.state === 'blocked' ? '已阻断' : '待确认', urgent: task.state === 'blocked' || (!!task.due && task.due <= today), at: task.due || task.createdAt, target: { view: 'qc-workbench', id: task.id } });
  }
  if (canRead('shipments')) for (const shipment of state.fulfillment.shipments.filter(item => item.state === 'departed' && !item.documentsSentAt))
    items.push({ id: 'shipping:' + shipment.id, source: 'shipping', sourceLabel: MIST_WORK_SOURCE_LABEL.shipping, title: `${shipment.code} · 已出运，单据待寄送`, meta: [shipment.customer, shipment.departedAt?.slice(0, 10)].filter(Boolean).join(' · '), when: '待交单', urgent: false, at: shipment.departedAt || '', target: { view: 'shipments', id: shipment.id } });
  if (canRead('payment-vouchers')) {
    const requests = state.payables?.requests ?? [], since = new Date(Date.parse(today + 'T00:00:00Z') - FINANCE_RETURN_DAYS * 86400000).toISOString().slice(0, 10);
    for (const request of requests.filter(item => item.state === 'rejected' && item.requesterId === me && (item.decision?.at ?? '').slice(0, 10) >= since)) {
      const resubmitted = requests.some(other => other.id !== request.id && other.submittedAt > request.submittedAt && other.state !== 'cancelled' && other.supplierId === request.supplierId && other.purpose === request.purpose
        && (other.purchaseId ?? other.settlementId ?? other.planId ?? '') === (request.purchaseId ?? request.settlementId ?? request.planId ?? ''));
      if (resubmitted) continue;
      items.push({ id: 'finance:' + request.id, source: 'finance', sourceLabel: MIST_WORK_SOURCE_LABEL.finance, title: `${request.code} · 付款申请被退回`, meta: [request.supplier, request.decision?.actor && '退回人 ' + request.decision.actor, request.decision?.note].filter(Boolean).join(' · '), when: '被退回', urgent: true, at: request.decision?.at || request.submittedAt, target: { view: 'payment-vouchers', id: request.id } });
    }
  }
  return items;
}

/** 由邮件生成的跟进事项（任务本身已保存在工作空间）。 */
export function mistEmailFollowUpTaskIds(state: MistState | null | undefined) {
  return new Set((state?.email?.messages ?? []).flatMap(message => message.followUpTaskIds ?? []));
}
