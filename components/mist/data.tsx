import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { CardButton, EmptyState, Icon, Tile } from './primitives';
import { toneAttr, type Tone } from './types';

export const MistDensityContext = React.createContext<'compact'|'default'|'comfy'>('default');

/* ───────────── DataTable ───────────── */
export type Column<T> = {
  key: string;
  header: React.ReactNode;
  /** CSS grid 宽度，如 'minmax(200px,2fr)'、'112px'。默认 '1fr' */
  width?: string;
  align?: 'left' | 'right';
  render: (row: T, index: number) => React.ReactNode;
  /** 提供则表头可点击排序 */
  sortValue?: (row: T) => string | number;
  /** 窄屏(≤760)或表格自身放不下全部列时优先隐藏该列（次要列） */
  hideOnMobile?: boolean;
};
export type DataTableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  selectedKey?: string | null;
  onRowClick?: (row: T) => void;
  onRowDoubleClick?: (row: T) => void;
  density?: 'compact' | 'default' | 'comfy';
  empty?: React.ReactNode;
  footer?: React.ReactNode;
  loading?: boolean;
  /** 表格最小宽度，超出横向滚动 */
  minWidth?: number;
  ariaLabel?: string;
};
/**
 * 通用数据表（div grid 实现，行可整行点击）。
 * - 选中行 = 强调色浅底 + 左侧 3px 指示条（不是描边）。
 * - 行之间唯一 1px 分隔线。
 */
export function DataTable<T>({ columns, rows, rowKey, selectedKey, onRowClick, onRowDoubleClick, density: explicitDensity, empty, footer, loading, minWidth, ariaLabel }: DataTableProps<T>) {
  const inheritedDensity = React.useContext(MistDensityContext);
  const density = explicitDensity ?? inheritedDensity;
  const [sort, setSort] = React.useState<{ key: string; dir: 1 | -1 } | null>(null);
  const cols = columns.map(c => fitTrack(c.width)).join(' ');
  const tableRef = React.useRef<HTMLDivElement>(null);
  // 自适应：按表格自身宽度（而非视口）判断能否放下全部列。放不下 → 先隐藏次要列 → 仍放不下 → 卡片式堆叠。
  // 只改 data-fit 属性，不触发 React 重渲染；minWidth 表格是设计好的表内横向滚动，不参与。
  React.useLayoutEffect(() => {
    const el = tableRef.current;
    if (!el || minWidth) return;
    let lastWidth = -1;
    const fit = () => {
      const width = el.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      el.dataset.fit = 'full';
      markHidden(el, new Set());
      if (!tableOverflows(el)) return;
      // 次要列从右往左逐列隐藏，放得下就停：尽量保留信息，而不是一次隐藏全部次要列。
      const hideable = columns.map((c, i) => c.hideOnMobile ? i : -1).filter(i => i >= 0).reverse();
      const hidden = new Set<number>();
      if (hideable.length) el.dataset.fit = 'compact';
      for (const index of hideable) {
        hidden.add(index);
        el.style.setProperty('--mist-cols-fit', columns.filter((_, i) => !hidden.has(i)).map(c => fitTrack(c.width)).join(' '));
        markHidden(el, hidden);
        if (!tableOverflows(el)) return;
      }
      el.dataset.fit = 'stack';
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  });
  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const col = columns.find(c => c.key === sort.key);
    if (!col?.sortValue) return rows;
    return [...rows].sort((a, b) => { const x = col.sortValue!(a), y = col.sortValue!(b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
  }, [rows, sort, columns]);
  const style = { ['--mist-cols' as string]: cols } as React.CSSProperties;
  const body = (
    <div ref={tableRef} className="mist-table" role="table" aria-label={ariaLabel} style={style}>
      <div className="mist-thead" role="row">
        {columns.map((c, ci) => c.sortValue
          ? <button key={c.key} type="button" role="columnheader" className={c.align === 'right' ? 'mist-cell-r' : undefined} data-hide-sm={c.hideOnMobile || undefined} data-col={ci}
              onClick={() => setSort(s => s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 })}>
              {c.header}<Icon icon={sort?.key === c.key ? (sort.dir === 1 ? ArrowUp : ArrowDown) : ChevronsUpDown} size="xs" />
            </button>
          : <span key={c.key} role="columnheader" className={c.align === 'right' ? 'mist-cell-r' : undefined} data-hide-sm={c.hideOnMobile || undefined} data-col={ci}>{c.header}</span>)}
      </div>
      {loading ? Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="mist-tr" role="row">{columns.map((c, ci) => <span key={c.key} data-hide-sm={c.hideOnMobile || undefined} data-col={ci}><span className="mist-skel" style={{ width: '70%' }} /></span>)}</div>
      )) : sorted.length === 0 ? (empty ?? <EmptyState title="暂无数据" compact />) : sorted.map((r, i) => {
        const k = rowKey(r);
        return (
          <div key={k} className="mist-tr" role="row" data-density={density === 'default' ? undefined : density}
            data-clickable={onRowClick ? true : undefined} aria-selected={selectedKey != null ? k === selectedKey : undefined}
            tabIndex={onRowClick ? 0 : undefined}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(r) : undefined}
            onKeyDown={onRowClick ? e => { if (e.key === 'Enter') (onRowDoubleClick ?? onRowClick)(r); } : undefined}>
            {columns.map((c, ci) => <div key={c.key} role="cell" className={c.align === 'right' ? 'mist-cell-r' : undefined} data-hide-sm={c.hideOnMobile || undefined} data-col={ci} style={{ minWidth: 0 }}>{c.render(r, i)}</div>)}
          </div>
        );
      })}
      {footer && <div className="mist-tfoot">{footer}</div>}
    </div>
  );
  return minWidth ? <div className="mist-table-scroll" data-mist-scroll="x" style={{ ['--mist-table-min' as string]: `${minWidth}px` }}>{body}</div> : body;
}

/** 列宽 → grid 轨道。fr 列允许收缩但保留可读的最小宽度（放不下时由 DataTable 降级为隐藏次要列/堆叠，而不是撑宽页面）。 */
export function fitTrack(width?: string) {
  const w = (width || '1fr').trim();
  return /^\d*\.?\d+fr$/.test(w) ? `minmax(var(--mist-col-min, 96px), ${w})` : w;
}
/** 给被隐藏列的表头/单元格打 data-fit-hidden（按 data-col 序号）。 */
function markHidden(el: HTMLElement, hidden: Set<number>) {
  el.querySelectorAll<HTMLElement>(':scope > :is(.mist-thead, .mist-tr) > [data-col]').forEach(cell => {
    if (hidden.has(Number(cell.dataset.col))) cell.setAttribute('data-fit-hidden', ''); else cell.removeAttribute('data-fit-hidden');
  });
}
function tableOverflows(el: HTMLElement) {
  for (const row of Array.from(el.children) as HTMLElement[]) {
    if (!row.classList.contains('mist-thead') && !row.classList.contains('mist-tr')) continue;
    if (row.offsetParent === null) continue;
    if (row.scrollWidth > row.clientWidth + 1) return true;
  }
  return false;
}

/* ───────────── Sparkline ───────────── */
export function Sparkline({ points, width = 96, height = 28, tone = 'accent' }: { points: number[]; width?: number; height?: number; tone?: 'accent' | 'ok' | 'warn' | 'bad' }) {
  const id = React.useId().replace(/:/g, '');
  if (points.length < 2) return null;
  const max = Math.max(...points), min = Math.min(...points);
  const xy = points.map((p, i) => [i * (width / (points.length - 1)), height - 3 - ((p - min) / (max - min || 1)) * (height - 8)]);
  const d = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const color = `var(--mist-${tone})`;
  return (
    <svg className="mist-spark" viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <defs><linearGradient id={`sg${id}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".22" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={`${d} L${width} ${height} L0 ${height}Z`} fill={`url(#sg${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/* ───────────── StatCard ───────────── */
export type StatCardProps = { icon: LucideIcon; label: React.ReactNode; value: React.ReactNode; unit?: React.ReactNode; delta?: { text: string; dir: 'up' | 'down' | 'bad' }; foot?: React.ReactNode; spark?: number[]; onClick?: () => void };
/** 统计卡：大数字用 light 字重。整卡可点 → 跳到对应列表。 */
export function StatCard({ icon, label, value, unit, delta, foot, spark, onClick }: StatCardProps) {
  return (
    <CardButton className="mist-stat" onClick={onClick}>
      <div className="mist-stat-top"><Tile icon={icon} size="sm" />{label}{delta && <span className="mist-stat-delta" data-dir={delta.dir}>{delta.text}</span>}</div>
      <div className="mist-stat-v">{value}{unit && <small>{unit}</small>}</div>
      <div className="mist-stat-foot"><span>{foot}</span>{spark && <Sparkline points={spark} />}</div>
    </CardButton>
  );
}
export function StatGrid({ cols = 4, children }: { cols?: number; children: React.ReactNode }) {
  return <section className="mist-stats" style={{ ['--mist-stat-cols' as string]: cols }}>{children}</section>;
}

/* ───────────── Pipeline (阶段筛选) ───────────── */
export type PipelineItem<V extends string | number> = { value: V; label: React.ReactNode; count: number; color: string };
/** 阶段漏斗筛选：一排卡片显示每个阶段的数量，点击筛选。color 用 token，如 'var(--mist-warn)' */
export function Pipeline<V extends string | number>({ items, value, onChange }: { items: PipelineItem<V>[]; value: V; onChange: (v: V) => void }) {
  return (
    <div className="mist-pipeline" style={{ ['--mist-pipe-cols' as string]: items.length }}>
      {items.map(it => <button key={String(it.value)} type="button" aria-pressed={it.value === value} onClick={() => onChange(it.value)}><small><i style={{ background: it.color }} />{it.label}</small><b>{it.count}</b></button>)}
    </div>
  );
}

/* ───────────── Donut ───────────── */
export type DonutSlice = { label: React.ReactNode; value: number; color: string; display?: React.ReactNode };
/** 环形占比图 + 图例。第一段为主值，中心显示其百分比。 */
export function Donut({ slices, centerLabel, caption }: { slices: DonutSlice[]; centerLabel?: string; caption?: React.ReactNode }) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  let offset = 25;
  const main = Math.round((slices[0]?.value || 0) / total * 100);
  return (
    <div className="mist-donut">
      <svg viewBox="0 0 42 42" role="img" aria-label={`${centerLabel ?? ''} ${main}%`}>
        <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--mist-sunken)" strokeWidth="5" />
        {slices.map((s, i) => {
          const pct = s.value / total * 100;
          const el = <circle key={i} cx="21" cy="21" r="15.9" fill="none" stroke={s.color} strokeWidth="5" strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset={offset} strokeLinecap={i === 0 ? 'round' : undefined} />;
          offset -= pct;
          return s.color === 'transparent' ? null : el;
        })}
        <text x="21" y="22.5" textAnchor="middle" fontSize="7" fill="var(--mist-ink)" fontFamily="Urbanist" fontWeight="300">{main}%</text>
        {centerLabel && <text x="21" y="28" textAnchor="middle" fontSize="2.8" fill="var(--mist-ink-3)">{centerLabel}</text>}
      </svg>
      <div className="mist-legend">
        {slices.map((s, i) => <div key={i}><i style={{ background: s.color === 'transparent' ? 'var(--mist-fill-2)' : s.color }} />{s.label}<b>{s.display ?? s.value.toLocaleString()}</b></div>)}
        {caption && <div className="mist-muted" style={{ fontSize: 12 }}>{caption}</div>}
      </div>
    </div>
  );
}

/* ───────────── Tone → CSS 色（图表用）───────────── */
export const toneColor = (t: Tone) => t === 'neutral' ? 'var(--mist-ink-4)' : `var(--mist-${t})`;
export { toneAttr };
