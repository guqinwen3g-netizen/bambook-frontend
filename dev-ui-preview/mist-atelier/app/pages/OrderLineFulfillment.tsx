/** 条目履约：固定身份信息 → 阶段轨迹（当前步唯一展开）→ 分批与尾数。只读推导，动作回到各自模块。 */
import React from 'react';
import { Banner, Button, Facts, Mono, Pill } from '../../../../components/mist';
import type { MistOrder, MistOrderLine, MistState } from '../../../../server/src/shared/mistWorkspace';
import type { OrderGovernanceFields } from '../../../../server/src/shared/mistOrderGovernance';
import { formatOrderQuantity } from './orderAmounts';
import { currentLineStage, lineShipping, lineStages, lineTrackLabel, type LineStage } from './orderLineTrack';
import { DetailBlock } from './modules/pageKit';

const SHIP_STATE: Record<string, string> = { preparing: '准备中', ready: '待出运', departed: '已离港' };
const STATE_LABEL: Record<LineStage['state'], string> = { done: '已完成', now: '进行中', todo: '未开始', blocked: '受阻' };

export function OrderLineFulfillment({ state, order, line, go }: { state: MistState; order: MistOrder & { governance?: OrderGovernanceFields }; line: MistOrderLine; go: (view: string, id?: string, target?: Record<string, string | undefined>) => void }) {
  const stages = lineStages(state, order, line), current = currentLineStage(stages), shipping = lineShipping(state, line);
  const [openKey, setOpenKey] = React.useState(current?.key);
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
      { label: '规格', value: spec || `${line.style} · ${line.name}` },
      { label: '订单数量', value: `${q(line.qty)} ${unit}` },
      { label: '履约模式', value: lineTrackLabel(order) },
      { label: '工厂分支', value: factories.length ? factories.join('、') : '尚未开立生产' },
    ]} />
    <div className="mist-col" style={{ gap: 8 }}>
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
      ]} />
      {shipping.shipments.length > 0 && <div className="mist-col" style={{ gap: 4 }}>{shipping.shipments.map(row => <div key={row.id} className="mist-row" style={{ gap: 8 }}><Mono>{row.code}</Mono><span className="mist-muted">{SHIP_STATE[row.state] || row.state} · {row.plannedDate || '计划日未定'}</span><span className="mist-spacer" /><span className="mist-num">{q(row.quantity)} {unit}</span></div>)}</div>}
      <div className="mist-row" style={{ gap: 8, flexWrap: 'wrap' }}><Button disabled title="尚未接入：服务端还没有条目尾数收口命令">按实际完工结案</Button><span className="mist-note">尾数收口需写明原因，尚未接入；财务结算在收款与发票中单独处理。</span></div>
    </DetailBlock>
  </div>;
}
