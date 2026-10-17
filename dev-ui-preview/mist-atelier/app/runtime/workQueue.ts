import { isPendingFinanceMistInvoice, type MistState, type MistTarget, type MistTask } from '../../../../server/src/shared/mistWorkspace';
import type { MistReview } from './reviews';
import { shipmentStage } from '../pages/modules/ShipmentsPage';
import { financeReceiptDisplay } from '../pages/FinancePage';

type CanRead = (view: string) => boolean;
export type MistWorkSource = 'review' | 'qc' | 'shipping' | 'finance' | 'task';
/**
 * 等我处理的一条事项。module 是它计入的侧栏模块（与模块页「待我处理」同一归属）；
 * 其他工作空间的审批归到 approvals，只进「我的工作」合计。
 */
export type MistWorkItem = { id: string; source: MistWorkSource; sourceLabel: string; title: string; meta: string; when: string; urgent: boolean; at: string; target: MistTarget; module: string };
export const MIST_WORK_SOURCE_LABEL: Record<MistWorkSource, string> = { review: '待我审批', qc: 'QC', shipping: '出运', finance: '财务', task: '工作事项' };
export type MistWorkOptions = {
  canRead: CanRead; me: string; today: string; reviews?: MistReview[];
  /** 当前账号是否持有某项权限；不传时岗位事项（按权限分派）一律不算我的。 */
  can?: (permission: string) => boolean;
  /** 当前工作空间；只有本空间的审批按业务模块归类。 */
  workspaceId?: string;
};
const FINANCE_RETURN_DAYS = 30;
/** 不在主导航里的视图归到同组的主模块，保证侧栏数字加起来等于合计。 */
const MODULE_ALIAS: Record<string, string> = { invoices: 'payment-vouchers' };
export const mistWorkModule = (view: string | undefined) => { const base = (view || '').split('/')[0] || 'cockpit'; return MODULE_ALIAS[base] ?? base; };

/** 工作事项是否等我处理：指定给我，或属于我持有权限的岗位。都没写的事项不属于任何人。 */
export function isMyMistTask(task: MistTask, options: Pick<MistWorkOptions, 'me' | 'can' | 'canRead'>) {
  if (task.done) return false;
  const mine = (!!options.me && (task.assigneeIds ?? []).includes(options.me)) || (!!task.permission && !!options.can?.(task.permission));
  return mine && options.canRead(mistWorkModule(task.target?.view));
}
export function mistMyTasks(state: MistState | null | undefined, options: Pick<MistWorkOptions, 'me' | 'can' | 'canRead'>) {
  return (state?.tasks ?? []).filter(task => isMyMistTask(task, options));
}

/**
 * 由业务记录派生、等我处理的事项（不写入工作空间，原记录状态变化后自动消失）：
 * 待我审批；QC 待认领/处理中（QC 岗）与结果待业务确认（业务岗）；出运待物流接手、资料已回待发单、已出运待寄单；
 * 未认领收款、待确认发票（财务岗）；我提交后被退回的付款申请。
 */
export function mistWorkQueue(state: MistState | null | undefined, options: MistWorkOptions): MistWorkItem[] {
  const { canRead, me, reviews = [], today, workspaceId } = options, can = options.can ?? (() => false), items: MistWorkItem[] = [];
  const push = (item: Omit<MistWorkItem, 'sourceLabel' | 'module'> & { module?: string }) => items.push({ ...item, sourceLabel: MIST_WORK_SOURCE_LABEL[item.source], module: item.module ?? mistWorkModule(item.target.view) });
  for (const review of reviews.filter(row => row.status === 'pending' && row.canDecide)) {
    const local = !!workspaceId && review.workspaceId === workspaceId, module = mistWorkModule(review.target?.view);
    push({ id: `review:${review.workspaceId}|${review.id}`, source: 'review', title: review.title, meta: [review.workspaceName, review.submittedAt.slice(0, 10)].filter(Boolean).join(' · '), when: '待审批', urgent: true, at: review.submittedAt,
      target: { view: 'approvals', id: `${review.workspaceId}|${review.id}`, section: 'mine' } as MistTarget, module: local && canRead(module) ? module : 'approvals' });
  }
  if (!state) return items;
  if (canRead('qc-workbench')) for (const task of state.fulfillment.qcTasks) {
    // 待认领/检验中只给专业 QC（qc:inspect，且有该业务线登记权）；业务主管虽有登记权但不是检验岗。
    const qcRole = can('qc:inspect') && can(`qc:${task.domain}_chain:write`), business = can('orders:write');
    const open = qcRole && task.state === 'pending', working = qcRole && task.state === 'working' && !!me && task.assigneeId === me;
    const sampleBack = business && task.kind === 'sample' && task.state === 'reported' && !task.businessConfirmation;
    const productionBack = business && task.kind === 'production' && (task.state === 'awaiting_business' || task.state === 'blocked');
    if (!open && !working && !sampleBack && !productionBack) continue;
    const what = open ? '待认领' : working ? '检验中' : task.kind === 'sample' ? '样品评审结果待确认' : task.state === 'blocked' ? '检验不通过，待业务决定' : '检验结果待业务确认';
    push({ id: 'qc:' + task.id, source: 'qc', title: `${task.code} · ${what}`, meta: [task.factory, task.requestedBy && '发起人 ' + task.requestedBy].filter(Boolean).join(' · '),
      when: task.state === 'blocked' ? '已阻断' : open ? '待认领' : working ? '处理中' : '待确认', urgent: task.state === 'blocked' || (!!task.due && task.due <= today), at: task.due || task.createdAt, target: { view: 'qc-workbench', id: task.id } });
  }
  if (canRead('shipments')) for (const shipment of state.fulfillment.shipments) {
    const stage = shipmentStage(state, shipment);
    const intake = stage === 'intake' && can('shipments:write'), business = stage === 'business' && can('orders:write'), unsent = stage === 'departed' && !shipment.documentsSentAt && can('orders:write');
    if (!intake && !business && !unsent) continue;
    push({ id: 'shipping:' + shipment.id, source: 'shipping', title: `${shipment.code} · ${intake ? '待物流接手' : business ? '资料已回，待发送 CI/PL' : '已出运，单据待寄送'}`, meta: [shipment.customer, (unsent ? shipment.departedAt : shipment.plannedDate)?.slice(0, 10)].filter(Boolean).join(' · '),
      when: intake ? '待接手' : business ? '待发单' : '待交单', urgent: !unsent && !!shipment.plannedDate && shipment.plannedDate <= today, at: (unsent ? shipment.departedAt : shipment.plannedDate) || '', target: { view: 'shipments', id: shipment.id } });
  }
  if (canRead('payment-vouchers')) {
    if (can('invoices:reconcile')) for (const receipt of state.receipts ?? []) {
      const display = financeReceiptDisplay(receipt, state.orderFunding?.assignments ?? [], state.allocations ?? []);
      if (receipt.remaining <= 0 || (display.label !== '未认领' && display.label !== '匹配建议')) continue;
      push({ id: 'receipt:' + receipt.id, source: 'finance', title: `${receipt.payer || '到账'} · ${display.label === '未认领' ? '到账未认领' : '匹配建议待确认'}`, meta: [`${receipt.currency} ${receipt.remaining.toLocaleString('en-US')}`, receipt.date].filter(Boolean).join(' · '),
        when: display.label, urgent: display.label === '未认领', at: receipt.date || '', target: { view: 'payment-vouchers', id: receipt.id } });
    }
    if (can('invoices:write')) for (const invoice of (state.invoices ?? []).filter(isPendingFinanceMistInvoice))
      push({ id: 'invoice:' + invoice.id, source: 'finance', title: `${invoice.code} · 发票待财务确认`, meta: [invoice.customer, invoice.order].filter(Boolean).join(' · '), when: '待确认', urgent: false, at: invoice.due || '',
        target: { view: 'invoices', section: 'pending', id: invoice.id } as MistTarget });
    const requests = state.payables?.requests ?? [], since = new Date(Date.parse(today + 'T00:00:00Z') - FINANCE_RETURN_DAYS * 86400000).toISOString().slice(0, 10);
    for (const request of requests.filter(item => item.state === 'rejected' && item.requesterId === me && (item.decision?.at ?? '').slice(0, 10) >= since)) {
      const resubmitted = requests.some(other => other.id !== request.id && other.submittedAt > request.submittedAt && other.state !== 'cancelled' && other.supplierId === request.supplierId && other.purpose === request.purpose
        && (other.purchaseId ?? other.settlementId ?? other.planId ?? '') === (request.purchaseId ?? request.settlementId ?? request.planId ?? ''));
      if (resubmitted) continue;
      push({ id: 'finance:' + request.id, source: 'finance', title: `${request.code} · 付款申请被退回`, meta: [request.supplier, request.decision?.actor && '退回人 ' + request.decision.actor, request.decision?.note].filter(Boolean).join(' · '), when: '被退回', urgent: true, at: request.decision?.at || request.submittedAt, target: { view: 'payment-vouchers', id: request.id } });
    }
  }
  return items;
}

/** 我的全部待处理：派生事项 + 指定给我或我岗位的工作事项。侧栏、首页、模块页「待我处理」共用这一份。 */
export function mistMyWork(state: MistState | null | undefined, options: MistWorkOptions): MistWorkItem[] {
  const today = options.today;
  return [...mistWorkQueue(state, options), ...mistMyTasks(state, options).map(task => ({ id: 'task:' + task.id, source: 'task' as const, sourceLabel: MIST_WORK_SOURCE_LABEL.task, title: task.title, meta: task.due ? '期限 ' + task.due : '未定期限',
    when: !task.due ? '未定期限' : task.due < today ? '已逾期' : task.due === today ? '今天' : task.due.slice(5), urgent: !!task.due && task.due <= today, at: task.due, target: task.target, module: mistWorkModule(task.target?.view) }))];
}

/** 由邮件生成的跟进事项（任务本身已保存在工作空间）。 */
export function mistEmailFollowUpTaskIds(state: MistState | null | undefined) {
  return new Set((state?.email?.messages ?? []).flatMap(message => message.followUpTaskIds ?? []));
}

/**
 * 侧栏数字 = 各模块等我处理的条数（与模块页「待我处理」一致）；「我的工作」= 全部合计（含其他工作空间的审批）。
 * 存量、总数不计入；没有待办不显示。
 */
export function mistNavCounts(state: MistState | null | undefined, options: MistWorkOptions): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of mistMyWork(state, options)) { if (item.module !== 'cockpit') counts[item.module] = (counts[item.module] || 0) + 1; counts.cockpit = (counts.cockpit || 0) + 1; }
  return counts;
}
