/** 订单条目阶段轨迹：只由已登记事实推导，不写入任何状态。
 * 成衣：产前样 → 面辅料 → 开裁 → 生产检验 → 完工登记 → 出运（6 步）。
 * 面料：坯布 / 染整 → 色样确认 → 生产检验 → 完工 → 出运（5 步，没有开裁；"生产中"由生产分支开立 / 未完成推导，不读取看板 cut 列）。 */
import type { MistOrder, MistOrderLine, MistState } from '../../../../server/src/shared/mistWorkspace';
import type { StepState } from '../../../../components/mist';

export type LineStageKey = 'pp' | 'material' | 'cut' | 'inspection' | 'completion' | 'shipment';
export type LineStage = { key: LineStageKey; label: string; state: StepState; caption?: string; reason?: string; target?: { view: string; id?: string } };
export const LINE_TRACK_LABEL = { garment: '成衣：产前样 → 面辅料 → 开裁 → 生产检验 → 完工登记 → 出运', fabric: '面料：坯布 / 染整 → 色样确认 → 生产检验 → 完工 → 出运' } as const;
export const lineTrackLabel = (order: Pick<MistOrder, 'type'>) => order.type === 'fabric' ? LINE_TRACK_LABEL.fabric : LINE_TRACK_LABEL.garment;
export type LineShipping = { ordered: number; planned: number; departed: number; variance: number; variancePercent: number | null; shipments: Array<{ id: string; code: string; quantity: number; state: string; plannedDate: string }> };

const num = (value: number) => Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));

export function lineShipping(state: MistState, line: MistOrderLine): LineShipping {
  const shipments = (state.fulfillment?.shipments || []).filter(shipment => shipment.state !== 'cancelled').map(shipment => ({ id: shipment.id, code: shipment.code, state: shipment.state, plannedDate: shipment.plannedDate, quantity: shipment.lines.filter(row => row.lineId === line.id).reduce((sum, row) => sum + row.quantity, 0) })).filter(row => row.quantity > 0);
  const planned = shipments.reduce((sum, row) => sum + row.quantity, 0), departed = shipments.filter(row => row.state === 'departed').reduce((sum, row) => sum + row.quantity, 0);
  return { ordered: line.qty, planned, departed, variance: departed - line.qty, variancePercent: line.qty > 0 && departed > 0 ? Math.round((departed - line.qty) / line.qty * 1000) / 10 : null, shipments };
}

export function lineStages(state: MistState, order: MistOrder, line: MistOrderLine): LineStage[] {
  const f = state.fulfillment, unit = line.unit;
  const reportOf = (task: { reportIds: string[] }) => f?.qcReports.find(report => report.id === task.reportIds.at(-1));
  const fabric = order.type === 'fabric';
  // 产前样 / 色样：来源为本条目的样品与样品评审
  const samples = (f?.samples || []).filter(sample => sample.source.kind === 'orderLine' && sample.source.lineId === line.id && (fabric || sample.role === 'pp'));
  const sampleTasks = (f?.qcTasks || []).filter(task => task.kind === 'sample' && task.source.kind === 'orderLine' && task.source.lineId === line.id);
  const sampleName = fabric ? '色样' : '产前样';
  const pp: LineStage = (() => {
    const base = { key: 'pp' as const, label: fabric ? '色样确认' : '产前样' };
    const latest = sampleTasks.at(-1), report = latest && reportOf(latest);
    if (report?.result === 'reject') return { ...base, state: 'blocked', caption: `${sampleName}未通过`, reason: `${sampleName}评审结论为不通过，需要重新打样后再评审。`, target: { view: 'qc-workbench', id: latest!.id } };
    if (report) return { ...base, state: 'done', caption: report.result === 'conditional' ? '有条件认可' : '已认可' };
    if (latest) return { ...base, state: 'now', caption: latest.state === 'awaiting_business' ? '待业务确认' : '评审中', target: { view: 'qc-workbench', id: latest.id } };
    if (samples.length) return { ...base, state: 'now', caption: '已收样 · 待送审', target: { view: 'samples', id: samples[0].id } };
    return { ...base, state: 'todo', caption: `未登记${sampleName}` };
  })();
  // 面辅料 / 坯布·染整：来源为本条目的采购
  const purchases = (f?.purchases || []).filter(purchase => purchase.lineId === line.id && (fabric || purchase.kind === 'material'));
  const material: LineStage = (() => {
    const base = { key: 'material' as const, label: fabric ? '坯布 / 染整' : '面辅料' };
    if (!purchases.length) return { ...base, state: 'todo', caption: '未建采购' };
    const rejected = purchases.find(purchase => purchase.state === 'rejected');
    if (rejected) return { ...base, state: 'blocked', caption: '采购被退回', reason: `${rejected.code} 审批被退回，需要修改后重新提交。`, target: { view: 'procurement', id: rejected.id } };
    const approved = purchases.filter(purchase => purchase.state === 'approved'), arrived = approved.filter(purchase => purchase.received >= purchase.quantity);
    if (approved.length === purchases.length && arrived.length === purchases.length) return { ...base, state: 'done', caption: `${purchases.length} 张已到齐` };
    return { ...base, state: 'now', caption: `${approved.length} / ${purchases.length} 已批 · ${arrived.length} 到齐`, target: { view: 'procurement', id: (purchases.find(purchase => purchase.state !== 'approved' || purchase.received < purchase.quantity) || purchases[0]).id } };
  })();
  const jobs = state.productions.filter(job => job.lineId === line.id);
  const cut: LineStage = (() => {
    const base = { key: 'cut' as const, label: '开裁' };
    if (!jobs.length) return { ...base, state: 'todo', caption: '未开立生产' };
    if (jobs.some(job => job.col === 'cut')) return { ...base, state: 'now', caption: `${jobs.filter(job => job.col === 'cut').length} 个分支开裁中`, target: { view: 'production-board', id: jobs.find(job => job.col === 'cut')!.id } };
    return { ...base, state: 'done', caption: `${jobs.length} 个分支已开裁` };
  })();
  const qcTasks = (f?.qcTasks || []).filter(task => task.kind === 'production' && task.source.kind === 'orderLine' && task.source.lineId === line.id);
  const inspection: LineStage = (() => {
    const base = { key: 'inspection' as const, label: '生产检验' };
    if (!qcTasks.length) {
      if (!fabric) return { ...base, state: 'todo', caption: '未发起检验' };
      // 面料没有开裁步：生产分支已开立且未完工即"生产中"，与看板列无关
      const running = jobs.filter(job => job.col !== 'done');
      if (!jobs.length) return { ...base, state: 'todo', caption: '未开立生产' };
      if (running.length) return { ...base, state: 'now', caption: `生产中 · ${running.length} 个分支 · 未发起检验`, target: { view: 'production-board', id: running[0].id } };
      return { ...base, state: 'now', caption: '生产已完成 · 未发起检验', target: { view: 'production-board', id: jobs[0].id } };
    }
    const nok = qcTasks.find(task => reportOf(task)?.result === 'reject' && !task.businessContinued);
    if (nok) return { ...base, state: 'blocked', caption: 'QC NOK', reason: `${nok.code} 结论 NOK，需要暂停、由 QC 复验后经业务确认恢复。`, target: { view: 'qc-workbench', id: nok.id } };
    const waiting = qcTasks.find(task => task.state === 'awaiting_business');
    if (waiting) return { ...base, state: 'blocked', caption: '待业务恢复', reason: `${waiting.code} 复检已出结论，须由业务核对后明确继续。`, target: { view: 'qc-workbench', id: waiting.id } };
    const passed = qcTasks.filter(task => { const result = reportOf(task)?.result; return result === 'pass' || result === 'conditional' || !!task.businessContinued; });
    const covered = jobs.length > 0 && jobs.every(job => qcTasks.some(task => task.source.kind === 'orderLine' && task.source.productionId === job.id && passed.includes(task)));
    if (covered) return { ...base, state: 'done', caption: '全部分支 OK' };
    return { ...base, state: 'now', caption: `${passed.length} / ${qcTasks.length} 已出结论`, target: { view: 'qc-workbench', id: (qcTasks.find(task => !passed.includes(task)) || qcTasks[0]).id } };
  })();
  const facts = jobs.map(job => (f?.productionFacts || []).find(fact => fact.productionId === job.id)?.completion).filter(Boolean) as Array<{ quantity: number }>;
  const done = facts.reduce((sum, fact) => sum + fact.quantity, 0);
  const completion: LineStage = !jobs.length || !facts.length ? { key: 'completion', label: fabric ? '完工' : '完工登记', state: 'todo', caption: '未登记完工' }
    : { key: 'completion', label: fabric ? '完工' : '完工登记', state: facts.length === jobs.length ? 'done' : 'now', caption: `${num(done)} ${unit} 已完工` };
  const ship = lineShipping(state, line);
  const shipment: LineStage = !ship.planned ? { key: 'shipment', label: '出运', state: 'todo', caption: '未排出运' }
    : { key: 'shipment', label: '出运', state: ship.departed >= line.qty ? 'done' : 'now', caption: `已离港 ${num(ship.departed)} / ${num(line.qty)} ${unit}`, target: { view: 'shipments', id: ship.shipments[0].id } };
  return fabric ? [material, pp, inspection, completion, shipment] : [pp, material, cut, inspection, completion, shipment];
}

/** 先显示当前受阻；已足量离港显示出运完成，未登记的上游事实保持原状。 */
export function currentLineStage(stages: LineStage[]): LineStage | null {
  const blocked = stages.find(stage => stage.state === 'blocked');
  if (blocked) return blocked;
  if (stages.some(stage => stage.key === 'shipment' && stage.state === 'done')) return null;
  return stages.find(stage => stage.state !== 'done') || null;
}

/** 列表上的订单提醒：待业务动作、QC NOK、待出运条目数。 */
export function orderLineFlags(state: MistState, order: MistOrder) {
  const lines = state.orderLines.filter(line => line.orderId === order.id), tracks = lines.map(line => ({ line, stages: lineStages(state, order, line) }));
  const business = (state.fulfillment?.qcTasks || []).filter(task => task.state === 'awaiting_business' && task.source.kind === 'orderLine' && task.source.orderId === order.id).length;
  const nok = tracks.filter(track => track.stages.find(stage => stage.key === 'inspection')?.caption === 'QC NOK').length;
  const toShip = tracks.filter(track => { const completion = track.stages.find(stage => stage.key === 'completion'), shipment = track.stages.find(stage => stage.key === 'shipment'); return completion?.state !== 'todo' && shipment?.state !== 'done'; }).length;
  return { tracks, business, nok, toShip };
}
