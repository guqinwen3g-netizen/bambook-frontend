/** 条目履约：固定身份信息 → 阶段轨迹（当前步唯一展开）→ 分批与尾数。只读推导，动作回到各自模块。 */
import React from 'react';
import { Banner, Button, Facts, Mono, Pill } from '../../../../components/mist';
import { breakdownSummary, type OrderLineBreakdown } from '../../../../server/src/shared/mistOrderBreakdown';
import { CLOSE_SETTLEMENT_HINT, approvedOverShip, closureLabel, lineToleranceStatus, overShipLabel, type ClosableLine } from '../../../../server/src/shared/mistOrderClosure';
import { LineCloseDialog } from './OrderLineClose';
import type { MistOrder, MistOrderLine, MistState } from '../../../../server/src/shared/mistWorkspace';
import type { OrderGovernanceFields } from '../../../../server/src/shared/mistOrderGovernance';
import { formatOrderQuantity } from './orderAmounts';
import { currentLineStage, lineShipping, lineStages, lineTrackLabel, type LineStage } from './orderLineTrack';
import { DetailBlock } from './modules/pageKit';

const SHIP_STATE: Record<string, string> = { preparing: '准备中', ready: '待出运', departed: '已离港' };
const STATE_LABEL: Record<LineStage['state'], string> = { done: '已完成', now: '进行中', todo: '未开始', blocked: '受阻' };

export function OrderLineFulfillment({ state, order, line, go, onCloseLine }: { state: MistState; order: MistOrder & { governance?: OrderGovernanceFields }; line: MistOrderLine; go: (view: string, id?: string, target?: Record<string, string | undefined>) => void; onCloseLine?: (reason: string) => Promise<unknown> }) {
  const stages = lineStages(state, order, line), current = currentLineStage(stages), shipping = lineShipping(state, line);
  const [openKey, setOpenKey] = React.useState(current?.key), [closing, setClosing] = React.useState(false);
  const tolerance = lineToleranceStatus(state, order, line), closure = tolerance.closure;
  React.useEffect(() => setOpenKey(current?.key), [line.id, current?.key]);
  const open = stages.find(stage => stage.key === openKey) || current;
  const factories = [...new Set(state.productions.filter(job => job.lineId === line.id).map(job => job.factory))];
  const spec = (line as MistOrderLine & { specification?: string }).specification;
  const contract = order.governance?.contract, unit = line.unit, q = formatOrderQuantity;
  const sourceTarget = (stage: LineStage) => stage.target && (() => go(stage.target!.view, stage.target!.view === 'production-board' ? undefined : stage.target!.id, { orderLineId: line.id, ...(stage.target!.view === 'production-board' ? { productionId: stage.target!.id } : {}) }));
  const variance = shipping.departed ? `${shipping.variance > 0 ? '溢装 +' : shipping.variance < 0 ? '短装 ' : '足量 '}${shipping.variance ? q(shipping.variance) + ' ' + unit : ''}${shipping.variancePercent !== null && shipping.variance ? `（${shipping.variancePercent > 0 ? '+' : ''}${shipping.variancePercent}%）` : ''}` : '尚未离港';
  return <div className="mist-col" style={{ gap: 14 }} data-line-fulfillment={line.id}>
    <Facts cols={2} items={[
      { label: '订单 · 客户', value: <><Mono>{order.code}</Mono> · {order.customer}</> },
      { label: 'PO / 合同号', value: contract?.kind === 'internal' ? contract.internalPurpose || '内部用途待填' : contract?.poNumber || '待补充' },
      { label: '规格 / 分色分码', value: <><span>{spec || `${line.style} · ${line.name}`}</span><span className="mist-cell-sub" data-line-breakdown-summary>{breakdownSummary((line as MistOrderLine & { breakdown?: OrderLineBreakdown }).breakdown, unit)}</span></> },
      { label: '订单数量', value: `${q(line.qty)} ${unit}` },
      { label: '履约模式', value: lineTrackLabel(order) },
      { label: '工厂分支', value: factories.length ? factories.join('、') : '尚未开立生产' },
    ]} />
    <div className="mist-col" style={{ gap: 8 }}>
      {closure && <Banner tone={closure.status === 'closed' ? 'ok' : closure.status === 'pending' ? 'warn' : 'bad'} title={closure.status === 'closed' ? '条目已结案' : closure.status === 'pending' ? '结案待审批' : '结案申请已退回'}><span data-line-closure={closure.status}>{closureLabel(closure)}</span>{closure.status !== 'rejected' && <span className="mist-note"> · 不能再建出运或改数量；{CLOSE_SETTLEMENT_HINT}</span>}</Banner>}
      <div className="mist-row"><b className="mist-h3">阶段轨迹</b><span className="mist-spacer" />{current ? <Pill tone={current.state === 'blocked' ? 'bad' : 'accent'}>当前：{current.label}</Pill> : <Pill tone="ok">已全部完成</Pill>}</div>
      <nav className="mist-line-track" aria-label="条目阶段" style={{ ['--mist-steps' as string]: stages.length }}>
        {stages.map(stage => <button key={stage.key} type="button" data-state={stage.state === 'todo' ? undefined : stage.state === 'now' && stage.key !== current?.key ? 'partial' : stage.state} aria-current={stage.key === current?.key ? 'step' : undefined} aria-pressed={stage.key === open?.key} onClick={() => setOpenKey(stage.key)}><b>{stage.label}</b><small>{stage.caption || STATE_LABEL[stage.state]}</small></button>)}
      </nav>
      {open && <div className="mist-col" style={{ gap: 6 }} data-stage-open={open.key}>
        {open.state === 'blocked' ? <Banner tone="bad" title={`${open.label}受阻`} actions={sourceTarget(open) && <Button onClick={sourceTarget(open)!}>去处理</Button>}>{open.reason}</Banner>
          : <div className="mist-row" style={{ gap: 8, flexWrap: 'wrap' }}><span className="mist-note">{open.label} · {STATE_LABEL[open.state]}{open.caption ? ` · ${open.caption}` : ''}{open.key !== current?.key && open.state === 'todo' ? '（前序阶段完成后解锁）' : ''}</span><span className="mist-spacer" />{sourceTarget(open) && <Button variant="quiet" onClick={sourceTarget(open)!}>查看来源记录</Button>}</div>}
      </div>}
    </div>
    <DetailBlock title="分批与尾数">
      <Facts cols={2} items={[
        { label: '订单数量', value: `${q(shipping.ordered)} ${unit}` },
        { label: '已排出运', value: `${q(shipping.planned)} ${unit}` },
        { label: '已离港', value: `${q(shipping.departed)} ${unit}` },
        { label: '短溢装', value: <span className={shipping.variance < 0 && shipping.departed ? 'mist-tone-warn' : undefined}>{variance}</span> },
        { label: '溢短装条款', value: <span data-line-tolerance>{tolerance.text}</span> },
        { label: '允许范围', value: <span data-line-range>{q(tolerance.min)} – {q(tolerance.max)} {unit}</span> },
        { label: '剩余待出', value: `${q(tolerance.remaining)} ${unit}` },
        { label: '范围判断（含已排未离港）', value: <span data-line-verdict={tolerance.verdict} className={tolerance.verdict === 'within' ? undefined : 'mist-tone-warn'}>{!tolerance.planned ? '尚未排出运' : tolerance.verdict === 'within' ? '在允许范围内' : tolerance.verdict === 'over' ? `超出溢装上限 ${q(tolerance.planned - tolerance.max)} ${unit}` : `低于短装下限 ${q(tolerance.min - tolerance.planned)} ${unit}`}</span> },
        { label: '已批准超量额度', value: <span data-line-overship-approved>{approvedOverShip(line) > tolerance.max ? `累计可出 ${q(approvedOverShip(line))} ${unit}（超出溢装上限 ${q(approvedOverShip(line) - tolerance.max)}）` : '无'}</span> },
      ]} />
      {((line as ClosableLine).overShips || []).length > 0 && <div className="mist-col" style={{ gap: 4 }} role="list" aria-label="超量出运审批记录">{((line as ClosableLine).overShips || []).map(r => <div key={r.id} role="listitem" data-overship-request={r.status} className="mist-row" style={{ gap: 8, flexWrap: 'wrap' }}><Pill tone={r.status === 'approved' ? 'ok' : r.status === 'pending' ? 'warn' : 'bad'}>超量出运</Pill><span className="mist-muted">{overShipLabel(r)}</span><span className="mist-spacer" /><span className="mist-note">{r.requesterName}{r.decidedName ? ` → ${r.decidedName}` : ''}</span></div>)}</div>}
      {shipping.shipments.length > 0 && <div className="mist-col" style={{ gap: 4 }}>{shipping.shipments.map(row => <div key={row.id} className="mist-row" style={{ gap: 8 }}><Mono>{row.code}</Mono><span className="mist-muted">{SHIP_STATE[row.state] || row.state} · {row.plannedDate || '计划日未定'}</span><span className="mist-spacer" /><span className="mist-num">{q(row.quantity)} {unit}</span></div>)}</div>}
      <div className="mist-row" style={{ gap: 8, flexWrap: 'wrap' }}><Button disabled={!onCloseLine || order.governance?.status !== 'approved' || closure?.status === 'closed' || closure?.status === 'pending' || tolerance.open.length > 0} title={tolerance.open.length ? `还有未离港出运：${tolerance.open.map(s => s.code).join('、')}` : undefined} onClick={() => setClosing(true)}>按实际完工结案</Button><span className="mist-note">以已离港 {q(tolerance.departed)} {unit} 结案，须写原因；超出允许范围需订单审批人批准。{CLOSE_SETTLEMENT_HINT}。</span></div>
      {onCloseLine && <LineCloseDialog open={closing} line={line} status={tolerance} onClose={() => setClosing(false)} onSubmit={onCloseLine} />}
    </DetailBlock>
  </div>;
}
