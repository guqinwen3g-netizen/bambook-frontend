/** BB-ORD-4：变更草稿的影响清单——按条目列出受影响的采购、生产分支、出运批次与发票，可点开到原模块核对。只读。 */
import React from 'react';
import { Banner, Button, Mono, Pill } from '../../../../components/mist';
import type { MistOrder, MistState } from '../../../../server/src/shared/mistWorkspace';
import { impactStateLabel, orderChangeImpact } from '../../../../server/src/shared/mistOrderChangeImpact';
import type { OrderGovernanceLine } from '../../../../server/src/shared/mistOrderGovernance';
import { formatOrderQuantity as q } from './orderAmounts';

type Go = (view: string, id?: string, target?: Record<string, string | undefined>) => void;

export function OrderChangeImpactList({ state, order, lines, go, note }: { state: MistState; order: MistOrder; lines: OrderGovernanceLine[]; go: Go; note?: string }) {
  const impact = orderChangeImpact(state, order, lines);
  if (!impact.hasFacts) return null;
  const link = (label: React.ReactNode, onClick: () => void) => <Button size="sm" variant="quiet" onClick={onClick}>{label}</Button>;
  return <section className="mist-col" style={{ gap: 8 }} aria-label="影响清单" data-change-impact>
    <b className="mist-h3">影响清单</b>
    <span className="mist-note">{note || '审批通过后新数量生效，并给下列采购、生产各生成一条核对待办；不会自动改采购或生产数据。'}</span>
    {impact.lines.filter(line => line.purchases.length || line.productions.length || line.shipments.length).map(line => <div key={line.lineId} className="mist-col" style={{ gap: 4 }} data-impact-line={line.lineId}>
      <div className="mist-row" style={{ gap: 8, flexWrap: 'wrap' }}><b>{line.label}</b><span className="mist-muted">{line.removed ? '拟删除' : `${line.before === null ? '新增' : q(line.before)} → ${line.after === null ? '—' : q(line.after)} ${line.unit}`}</span><span className="mist-spacer" /><Pill tone="neutral">下限 {q(line.floor)} {line.unit}（已完工 {q(line.completed)} · 已排出运 {q(line.shipped)}）</Pill></div>
      {line.warning && <Banner tone="warn" title="需同步调整生产分配">{line.warning}</Banner>}
      <div className="mist-row" style={{ gap: 4, flexWrap: 'wrap' }}>
        {line.purchases.map(p => <React.Fragment key={p.id}>{link(<>采购 <Mono>{p.code}</Mono> · {impactStateLabel(p.state)} · {q(p.quantity)} {p.unit}</>, () => go('procurement', p.id, { orderLineId: line.lineId }))}</React.Fragment>)}
        {line.productions.map(p => <React.Fragment key={p.id}>{link(<>生产 <Mono>{p.code}</Mono> · {p.factory} · {impactStateLabel(p.col)} · 分配 {q(p.qty)} · 已完工 {q(p.completed)}</>, () => go('production-board', undefined, { productionId: p.id, orderLineId: line.lineId }))}</React.Fragment>)}
        {line.shipments.map(s => <React.Fragment key={s.id}>{link(<>出运 <Mono>{s.code}</Mono> · {impactStateLabel(s.state)} · {q(s.quantity)} {line.unit}</>, () => go('shipments', s.id))}</React.Fragment>)}
      </div>
    </div>)}
    {impact.invoices.length > 0 && <div className="mist-row" style={{ gap: 4, flexWrap: 'wrap' }} data-impact-invoices><b>发票</b>{impact.invoices.map(i => <React.Fragment key={i.id}>{link(<>发票 <Mono>{i.code}</Mono> · {i.voided ? '已作废' : '有效'} · {i.amount} {i.currency} · 未收 {i.open}</>, () => go('invoices', i.id))}</React.Fragment>)}</div>}
  </section>;
}
