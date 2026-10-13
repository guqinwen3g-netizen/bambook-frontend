/** 生产分支开产门禁：与服务端放行规则逐项对应，只读核对，最终以服务端为准。 */
import { assertMistOrderApproved, assertMistOrderDeposit, type MistProduction, type MistState } from '../../../../server/src/shared/mistWorkspace';

export type GateItem = { key: string; label: string; ok: boolean; detail: string; target?: { view: string; id?: string } };
const message = (check: () => void) => { try { check(); return ''; } catch (problem) { return problem instanceof Error ? problem.message : '未通过'; } };

export function productionReleaseGate(state: MistState, branch: MistProduction): GateItem[] {
  const f = state.fulfillment, order = state.orders.find(row => row.id === branch.orderId), fabric = order?.type === 'fabric';
  const fact = f?.productionFacts?.find(row => row.productionId === branch.id);
  const approval = message(() => assertMistOrderApproved(state, branch.orderId));
  const deposit = approval ? '主单批准后核对' : message(() => assertMistOrderDeposit(state, branch.orderId));
  const items: GateItem[] = [
    { key: 'approval', label: '主单已批准', ok: !approval, detail: approval || '已批准', target: { view: 'orders/detail', id: branch.orderId } },
    { key: 'deposit', label: '定金已覆盖', ok: !approval && !deposit, detail: deposit || '已覆盖或无需定金', target: { view: 'payment-vouchers' } },
  ];
  if (!fabric) items.push({ key: 'sizes', label: '生产尺码已登记', ok: !!fact?.sizes.length, detail: fact?.sizes.length ? fact.sizes.map(size => `${size.size}:${size.quantity}`).join(' · ') : '请先登记准确生产尺码与数量' });
  if (branch.sourcePurchaseId) {
    const purchase = f?.purchases.find(row => row.id === branch.sourcePurchaseId), ok = !!purchase && purchase.state === 'approved' && !!purchase.offlineSend && !!purchase.supplierConfirmation;
    items.push({ key: 'contract', label: '来源加工合同已确认', ok, detail: ok ? `${purchase!.code} 已批准、发出并回签` : '来源合同须批准、线下发出并取得供应商确认', target: purchase ? { view: 'procurement', id: purchase.id } : undefined });
  }
  const role = fabric ? 'pioneer' : 'pp', roleLabel = fabric ? '先锋样' : '产前样';
  const samples = (f?.samples || []).filter(sample => sample.role === role && sample.source.kind === 'orderLine' && sample.source.orderId === branch.orderId && sample.source.lineId === branch.lineId && sample.source.productionId === branch.id);
  const approved = samples.find(sample => (f?.qcTasks || []).some(task => { const latest = f.qcReports.find(report => report.id === task.reportIds.at(-1)); return task.sampleId === sample.id && task.kind === 'sample' && task.state === 'reported' && !!latest && latest.result !== 'reject' && latest.scopeRevision === (sample.qualityRevision || 1) && task.businessConfirmation?.result === 'approved' && task.businessContinued?.reportId === latest.id; }));
  const pending = samples.length ? (f?.qcTasks || []).find(task => task.kind === 'sample' && samples.some(sample => sample.id === task.sampleId)) : undefined;
  items.push({ key: 'sample', label: `${roleLabel}已确认`, ok: !!approved, detail: approved ? `${approved.code} 已通过 QC、需求方确认并由业务继续` : samples.length ? `${roleLabel}尚未完成准确实物 QC、需求方确认及业务继续` : `本分支还没有登记${roleLabel}`, target: pending ? { view: 'qc-workbench', id: pending.id } : { view: 'samples' } });
  return items;
}

/** 本分支最新的生产 QC 是否为 NOK（且尚未由业务继续）。 */
export function productionNok(state: MistState, branch: MistProduction) {
  const f = state.fulfillment;
  return (f?.qcTasks || []).find(task => task.kind === 'production' && task.source.kind === 'orderLine' && task.source.productionId === branch.id && f.qcReports.find(report => report.id === task.reportIds.at(-1))?.result === 'reject' && !task.businessContinued);
}
