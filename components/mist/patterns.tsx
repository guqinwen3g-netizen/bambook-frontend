import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { ArrowRight, ArrowUpRight, Check, ChevronRight, MessageSquare } from 'lucide-react';
import { MistMark } from './MistMark';
import { AIBadge, Avatar, AvatarStack, Card, CardHeader, Icon, Pill, Tile } from './primitives';
import { toneAttr, type StepState, type Tone } from './types';

/* ═════════ 页面级 ═════════ */

/** 焦点大卡：首页/工作台「当前最该做的一件事」。一页最多一个。 */
export function HeroFocus({ tag = '当前焦点', meta, title, description, media, steps, actions, className }: {
  tag?: React.ReactNode; meta?: React.ReactNode[]; title: React.ReactNode; description?: React.ReactNode;
  media?: { src: string; alt: string }; steps?: Array<{ label: string; state: StepState }>; actions?: React.ReactNode; className?: string;
}) {
  return (
    <article className={`mist-hero ${className ?? ''}`}>
      <MistMark className="mist-hero-ring" />
      {media && <img className="mist-hero-media" src={media.src} alt={media.alt} />}
      <div className="mist-hero-meta"><span className="mist-hero-tag">{tag}</span>{meta?.map((m, i) => <React.Fragment key={i}>{i > 0 && <span>·</span>}<span>{m}</span></React.Fragment>)}</div>
      <h2>{title}</h2>
      {description && <p className="mist-hero-desc">{description}</p>}
      {steps && <div className="mist-hero-steps">{steps.map((s, i) => <div key={i} data-s={s.state === 'todo' ? undefined : s.state}><i />{s.label}</div>)}</div>}
      {actions && <div className="mist-hero-cta">{actions}</div>}
    </article>
  );
}

/** AI 今日简报：小竹总结的 3–5 条要点 + 提问入口。 */
export function AIBrief({ icon, title = '今日简报', sub, items, onAsk, askPlaceholder = '问问这些事的来龙去脉…', className }: {
  icon: LucideIcon; title?: React.ReactNode; sub?: React.ReactNode; className?: string;
  items: Array<{ strong: React.ReactNode; text: React.ReactNode; onClick?: () => void }>; onAsk?: () => void; askPlaceholder?: string;
}) {
  return (
    <Card tone="ai" className={`mist-brief ${className ?? ''}`}>
      <CardHeader leading={<AIBadge icon={icon} />} title={title} sub={sub} />
      <ul>{items.map((it, i) => <li key={i}><button type="button" onClick={it.onClick}><span className="mist-brief-n">{i + 1}</span><span><b>{it.strong}</b> {it.text}</span></button></li>)}</ul>
      {onAsk && <button type="button" className="mist-brief-ask" onClick={onAsk}><Icon icon={MessageSquare} size="sm" />{askPlaceholder}<span className="mist-send"><Icon icon={ArrowUpRight} size="sm" /></span></button>}
    </Card>
  );
}

export type TaskItem = { id: string; when: string; urgent?: boolean; title: React.ReactNode; meta?: React.ReactNode; status?: { tone: Tone; label: string }; people?: Array<{ name: string; tone?: Tone }> };
/** 待办列表：时间 / 标题+来源 / 状态 / 参与人 / 箭头。 */
export function TaskList({ items, onOpen }: { items: TaskItem[]; onOpen: (t: TaskItem) => void }) {
  return (
    <div className="mist-tasks">{items.map(t => (
      <button key={t.id} type="button" className="mist-task" onClick={() => onOpen(t)}>
        <span className="mist-task-when" data-urgent={t.urgent || undefined}>{t.when}</span>
        <div style={{ minWidth: 0 }}><div className="mist-task-t">{t.title}</div>{t.meta && <div className="mist-task-d">{t.meta}</div>}</div>
        {t.status ? <Pill tone={t.status.tone}>{t.status.label}</Pill> : <span />}
        {t.people ? <AvatarStack people={t.people} /> : <span />}
        <span className="mist-go"><Icon icon={ArrowRight} size="sm" /></span>
      </button>
    ))}</div>
  );
}

/** 周条 */
export function WeekStrip({ days, value, onChange }: { days: Array<{ key: string; weekday: string; day: number; dots: number }>; value: string; onChange: (k: string) => void }) {
  return <div className="mist-week">{days.map(d => <button key={d.key} type="button" aria-pressed={d.key === value} onClick={() => onChange(d.key)}><span>{d.weekday}</span><b>{d.day}</b><span className="mist-week-dots">{Array.from({ length: Math.min(d.dots, 3) }, (_, i) => <i key={i} />)}</span></button>)}</div>;
}
/** 日程列表。tone: 默认强调色 / ai 紫藤 / mute 灰 / warn 黄 */
export function Agenda({ events }: { events: Array<{ time: string; title: React.ReactNode; meta?: React.ReactNode; tone?: 'ai' | 'mute' | 'warn' }> }) {
  return <div className="mist-agenda">{events.map((e, i) => <div key={i} className="mist-ev"><span className="mist-ev-tm">{e.time}</span><div className="mist-ev-box" data-tone={e.tone}><b>{e.title}</b>{e.meta && <small>{e.meta}</small>}</div></div>)}</div>;
}

/* ═════════ 详情页 ═════════ */

/** 详情页身份行：缩略图 + 元信息 + 大标题 + 右侧关键人/日期/状态。 */
export function IdentityHeader({ thumb, meta, title, facts, actions }: { thumb?: React.ReactNode; meta?: React.ReactNode[]; title: React.ReactNode; facts?: Array<{ label: React.ReactNode; value: React.ReactNode }>; actions?: React.ReactNode }) {
  return (
    <section className="mist-idrow">
      {thumb}
      <div className="mist-idrow-ttl">
        {meta && <div className="mist-idrow-meta">{meta.map((m, i) => <React.Fragment key={i}>{i > 0 && <i />}<span>{m}</span></React.Fragment>)}</div>}
        <h1 className="mist-h1">{title}</h1>
      </div>
      <div className="mist-idrow-people">{facts?.map((f, i) => <div key={i}><small>{f.label}</small><b>{f.value}</b></div>)}{actions}</div>
    </section>
  );
}

/** 阶段步进条（横向）：done 浅色勾、now 实心强调色、todo 灰、blocked 红。 */
export function Stepper({ steps, onSelect }: { steps: Array<{ label: string; state: StepState; caption?: string }>; onSelect?: (index: number) => void }) {
  const cap = { done: '已完成', now: '进行中', todo: '未开始', blocked: '受阻' } as const;
  return (
    <Card as="nav" className="mist-stepper" aria-label="阶段" style={{ ['--mist-steps' as string]: steps.length }}>
      {steps.map((s, i) => (
        <button key={i} type="button" className="mist-step" data-state={s.state === 'todo' ? undefined : s.state} aria-current={s.state === 'now' ? 'step' : undefined} onClick={() => onSelect?.(i)}>
          <span className="mist-step-k">{s.state === 'done' ? <Icon icon={Check} size="sm" /> : String(i + 1).padStart(2, '0')}</span>
          <span><b>{s.label}</b><small>{s.caption ?? cap[s.state]}</small></span>
        </button>
      ))}
    </Card>
  );
}

/** 竖向步骤（创建向导、设置分区导航）。 */
export function VerticalSteps({ steps, current, onSelect, mode = 'step' }: { steps: Array<{ id: string; label: string; done?: boolean; icon?: LucideIcon }>; current: string; onSelect: (id: string) => void; mode?: 'step' | 'page' }) {
  return (
    <Card as="nav" className="mist-vsteps">
      {steps.map((s, i) => (
        <button key={s.id} type="button" aria-current={s.id === current ? mode : undefined} data-state={s.done ? 'done' : undefined} onClick={() => onSelect(s.id)}>
          {mode === 'step' ? <span className="mist-step-k">{s.done && s.id !== current ? <Icon icon={Check} size="xs" /> : i + 1}</span> : s.icon && <Icon icon={s.icon} size="sm" />}
          {s.label}
        </button>
      ))}
    </Card>
  );
}

/** 流程节点（订单履约 / 出运 / 审批链）。 */
export function FlowSteps({ nodes }: { nodes: Array<{ label: string; caption?: string; icon: LucideIcon; state: StepState }> }) {
  return (
    <div className="mist-flow">{nodes.map((n, i) => (
      <React.Fragment key={i}>
        {i > 0 && <span className="mist-flow-bar" data-done={n.state === 'done' || n.state === 'now' ? true : undefined} />}
        <div className="mist-flow-node" data-state={n.state === 'todo' ? undefined : n.state}>
          <span className="mist-flow-k"><Icon icon={n.state === 'done' ? Check : n.icon} /></span><b>{n.label}</b>{n.caption && <small>{n.caption}</small>}
        </div>
      </React.Fragment>
    ))}</div>
  );
}

export type TimelineEvent = { who: string; tone?: Tone; avatar?: string; when: string; text: React.ReactNode; attachment?: { icon: LucideIcon; name: string } };
/** 动态时间线（操作日志、沟通记录）。 */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="mist-timeline">{events.map((e, i) => (
      <div key={i} className="mist-tl">
        <Avatar name={e.avatar ?? e.who} tone={e.tone} size="sm" />
        <div><b>{e.who}</b> <small>· {e.when}</small><p>{e.text}</p>{e.attachment && <div className="mist-tl-att"><Icon icon={e.attachment.icon} size="sm" />{e.attachment.name}</div>}</div>
      </div>
    ))}</div>
  );
}

/** 核对清单（出运准备、上线检查）。note 可标红（tone='bad'）。 */
export function Checklist({ items, onToggle }: { items: Array<{ label: React.ReactNode; done: boolean; note?: React.ReactNode; noteTone?: 'bad' }>; onToggle?: (index: number) => void }) {
  return (
    <div className="mist-checklist">{items.map((it, i) => (
      <div key={i} data-done={it.done || undefined}>
        <button type="button" className="mist-checklist-bx" role="checkbox" aria-checked={it.done} aria-label={typeof it.label === 'string' ? it.label : undefined} onClick={() => onToggle?.(i)} disabled={!onToggle}>{it.done && <Icon icon={Check} size="xs" />}</button>
        <span>{it.label}</span>{it.note && <small data-tone={it.noteTone}>{it.note}</small>}
      </div>
    ))}</div>
  );
}

export type Measurement = { point: string; standard: number; actual: number; tolerance: number };
/** QC 测量事实：标准 / 实测 / 公差条 / 偏差；超半公差提示关注，超出提示偏差。支持零公差和逐行不同公差；不推导总体 QC 结论。 */
export function MeasurementTable({ rows, unit = 'cm' }: { rows: Measurement[]; unit?: string }) {
  const tol = rows[0]?.tolerance;
  const sameTolerance = tol !== undefined && rows.every(row => row.tolerance === tol);
  return (
    <div className="mist-measure">
      <div className="mist-measure-row" data-head><span>部位</span><span>标准</span><span>实测</span><span>{sameTolerance ? `公差 ±${Number.isInteger(tol) ? tol.toFixed(1) : String(tol)}${unit}` : `公差（${unit}）`}</span><span style={{ textAlign: 'right' }}>偏差</span></div>
      {!rows.length && <div className="mist-measure-row"><span className="mist-muted" style={{ gridColumn: '1 / -1' }}>暂无测量记录</span></div>}
      {rows.map((r, index) => {
        const raw = r.actual - r.standard, epsilon = r.tolerance === 0 ? 0 : Number.EPSILON * Math.max(1, Math.abs(r.standard), Math.abs(r.actual), r.tolerance) * 4;
        const dv = Math.abs(raw) <= epsilon ? 0 : raw;
        const tone = Math.abs(dv) > r.tolerance + epsilon ? 'bad' : Math.abs(dv) > r.tolerance * .5 + epsilon ? 'warn' : undefined;
        const offset = r.tolerance === 0 ? (dv === 0 ? 0 : Math.sign(dv) * 48) : (dv / r.tolerance) * 20;
        const pos = Math.max(2, Math.min(98, 50 + offset));
        const toleranceLabel = `${r.point} 公差 ±${r.tolerance}${unit}`;
        return (
          <div key={`${r.point}-${index}`} className="mist-measure-row">
            <span>{r.point}</span><span className="mist-muted mist-num">{r.standard.toFixed(1)}</span><span className="mist-num">{r.actual.toFixed(1)}</span>
            <span className="mist-tol" title={toleranceLabel} aria-label={toleranceLabel}><i data-tone={tone} style={{ left: `${pos}%` }} /></span>
            <span className={`mist-measure-dv mist-num ${tone ? `mist-tone-${tone}` : ''}`}>{(dv > 0 ? '+' : '') + dv.toFixed(1)}</span>
          </div>
        );
      })}
    </div>
  );
}
export function SummaryNumbers({ items }: { items: Array<{ label: React.ReactNode; value: React.ReactNode; tone?: Tone }> }) {
  return <div className="mist-summary-nums">{items.map((it, i) => <div key={i}><small>{it.label}</small><b className={it.tone ? `mist-tone-${it.tone}` : undefined}>{it.value}</b></div>)}</div>;
}

/** 关联对象列表（详情页右栏）。 */
export function RelatedList({ items }: { items: Array<{ icon: LucideIcon; title: React.ReactNode; sub?: React.ReactNode; onClick?: () => void }> }) {
  return <div className="mist-related">{items.map((it, i) => <button key={i} type="button" onClick={it.onClick}><Tile icon={it.icon} /><span><b>{it.title}</b>{it.sub && <small>{it.sub}</small>}</span><span className="mist-go"><Icon icon={ChevronRight} size="sm" /></span></button>)}</div>;
}

/** 版本选择（R1-A-1 / R2-A-2…）。 */
export function VersionPicker({ versions, value, onChange }: { versions: string[]; value: string; onChange: (v: string) => void }) {
  return <div className="mist-vers" role="group" aria-label="版本">{versions.map(v => <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{v}</button>)}</div>;
}

/** 商品展台（抠图 + 浅色舞台）。 */
export function ObjectStage({ src, alt, size, topLeft, topRight, caption }: { src: string; alt: string; size?: 'md' | 'lg'; topLeft?: React.ReactNode; topRight?: React.ReactNode; caption?: React.ReactNode }) {
  return <div className="mist-stage" data-size={size === 'lg' ? 'lg' : undefined}><img key={src} src={src} alt={alt} />{topLeft && <span className="mist-stage-tl">{topLeft}</span>}{topRight && <span className="mist-stage-tr">{topRight}</span>}{caption && <span className="mist-stage-cap">{caption}</span>}</div>;
}

/** 单据汇总条（订单/发票/核销页顶部的 3–4 个大数字）。 */
export function SummaryBar({ items }: { items: Array<{ label: React.ReactNode; value: React.ReactNode; unit?: React.ReactNode; hint?: React.ReactNode; hintTone?: Tone }> }) {
  return (
    <Card as="section" className="mist-sumbar" style={{ ['--mist-sum-cols' as string]: items.length }}>
      {items.map((it, i) => <div key={i}><small>{it.label}</small><div className="mist-sumbar-big">{it.value}{it.unit && <small className="mist-muted">{it.unit}</small>}</div>{it.hint && <div className={`mist-sumbar-hint ${it.hintTone ? `mist-tone-${it.hintTone}` : ''}`}>{it.hint}</div>}</div>)}
    </Card>
  );
}

/* ═════════ 看板 ═════════ */
export type KanbanColumn<T> = { id: string; title: string; color: string; items: T[] };
/** 看板：支持拖拽改列（onMove）。renderCard 只渲染卡片内部内容。 */
export function Kanban<T>({ columns, itemKey, renderCard, onMove, onOpen }: { columns: KanbanColumn<T>[]; itemKey: (t: T) => string; renderCard: (t: T) => React.ReactNode; onMove?: (key: string, toColumn: string) => void; onOpen?: (t: T) => void }) {
  const [drag, setDrag] = React.useState<string | null>(null);
  const dragRef = React.useRef<string | null>(null);
  const [over, setOver] = React.useState<string | null>(null);
  return (
    <div className="mist-kanban" style={{ ['--mist-kb-cols' as string]: columns.length }}>
      {columns.map(c => (
        <section key={c.id} className="mist-kb-col" data-over={over === c.id || undefined}
          onDragOver={e => { if (onMove) { e.preventDefault(); setOver(c.id); } }} onDragLeave={() => setOver(null)}
          onDrop={() => { const key = dragRef.current; dragRef.current = null; setDrag(null); setOver(null); if (key && onMove) onMove(key, c.id); }}>
          <div className="mist-kb-h"><i style={{ background: c.color }} />{c.title}<span>{c.items.length}</span></div>
          {c.items.map(t => { const k = itemKey(t); return (
            <button key={k} type="button" className="mist-kb-card" draggable={!!onMove} data-dragging={drag === k || undefined}
              onDragStart={() => { dragRef.current = k; setDrag(k); }} onDragEnd={() => { dragRef.current = null; setDrag(null); setOver(null); }} onClick={() => onOpen?.(t)}>{renderCard(t)}</button>
          ); })}
        </section>
      ))}
    </div>
  );
}

/** 设置行：左侧标题+说明，右侧控件。 */
export function SettingRow({ title, description, control }: { title: React.ReactNode; description?: React.ReactNode; control: React.ReactNode }) {
  return <div className="mist-setting-row"><div><b>{title}</b>{description && <small>{description}</small>}</div>{control}</div>;
}

export { toneAttr };
