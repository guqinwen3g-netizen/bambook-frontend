import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronLeft, ChevronRight, Loader2, Sparkles } from 'lucide-react'; // mist-allow: Button 的 loading 态是唯一允许的 spinner
import { cx, toneAttr, type Size, type Tone } from './types';
import { AssistantEyes } from './AssistantEyes';

/* ───────────── 长文本 ───────────── */
/** 取 ReactNode 中的纯文本（用于截断时的 title 完整文本）。 */
export function plainText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return plainText(node.props.children);
  return '';
}
/** 文字被省略号截断时，悬停补上 title 显示完整文本（data-full-text 提供原文）。 */
export function revealTruncatedTitle(e: React.PointerEvent<HTMLElement>) {
  const el = e.currentTarget, full = el.dataset.fullText;
  if (!full || el.title) return;
  const t = el.querySelector<HTMLElement>('.mist-btn-t') ?? el;
  if (t.scrollWidth > t.clientWidth + 1) el.title = full;
}

/* ───────────── Icon ───────────── */
export type IconProps = { icon: LucideIcon; size?: Exclude<Size, 'md'> | 'md'; className?: string; label?: string };
/** 统一图标：lucide 线性图标，描边 1.5。size: xs 13 / sm 15 / md 18(默认) / lg 22 */
export function Icon({ icon: I, size = 'md', className, label }: IconProps) {
  const Component = I === Sparkles ? AssistantEyes : I;
  return <Component className={cx('mist-icon', className)} data-size={size === 'md' ? undefined : size} aria-hidden={label ? undefined : true} aria-label={label} />;
}

/* ───────────── Button ───────────── */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'ai' | 'white' | 'glass';
export type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon; iconRight?: LucideIcon; block?: boolean; loading?: boolean; children?: React.ReactNode;
};
/**
 * 按钮。一屏只放一个 primary。
 * secondary = 浅填充（旧称 ghost），quiet = 无底文字按钮，white/glass 仅用于 Hero 大卡上。
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconRight, block, loading, children, className, type = 'button', disabled, ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={cx('mist-btn', className)} disabled={disabled}
      data-full-text={typeof children === 'string' ? children : undefined} onPointerEnter={revealTruncatedTitle}
      data-variant={variant === 'secondary' ? undefined : variant} data-size={size === 'md' ? undefined : size}
      data-block={block || undefined} data-loading={loading || undefined} aria-busy={loading || undefined} {...rest}
      {...(rest.onPointerEnter ? { onPointerEnter: (e: React.PointerEvent<HTMLButtonElement>) => { revealTruncatedTitle(e); rest.onPointerEnter!(e); } } : null)}>
      {loading ? <Icon icon={Loader2} size="sm" className="mist-spin" /* mist-allow */ /> : icon ? <Icon icon={icon} size="sm" /> : null}
      {typeof children === 'string' || typeof children === 'number' ? <span className="mist-btn-t">{children}</span> : children}
      {iconRight && <Icon icon={iconRight} size="sm" />}
    </button>
  );
});

export type IconButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { icon: LucideIcon; label: string; size?: 'sm' | 'md'; dot?: boolean };
/** 纯图标按钮。label 必填（无障碍 + tooltip）。dot = 右上角红点（未读通知）。 */
export function IconButton({ icon, label, size = 'md', dot, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button type={type} className={cx('mist-icon-btn', className)} aria-label={label} title={label} data-size={size === 'sm' ? 'sm' : undefined} {...rest}>
      <Icon icon={icon} size={size === 'sm' ? 'sm' : 'md'} />{dot && <span className="mist-pip" />}
    </button>
  );
}

export function TextLink({ icon, iconRight, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon; iconRight?: LucideIcon }) {
  return <button type="button" className="mist-link" {...rest}>{icon && <Icon icon={icon} size="xs" />}{children}{iconRight && <Icon icon={iconRight} size="xs" />}</button>;
}

/* ───────────── Pill / Chip / Tile / Kbd ───────────── */
/** 状态标签（只读）。带圆点；plain 去掉圆点。tone 语义见 docs/03-components.md#状态色 */
export function Pill({ tone = 'neutral', plain, children }: { tone?: Tone; plain?: boolean; children: React.ReactNode }) {
  return <span className="mist-pill" data-tone={toneAttr(tone)} data-plain={plain || undefined} title={plainText(children) || undefined}><span className="mist-pill-t">{children}</span></span>;
}
/** 筛选芯片（可点击，打开下拉）。label 灰，value 加粗。 */
export function Chip({ label, value, icon, iconRight, pressed, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: React.ReactNode; value?: React.ReactNode; icon?: LucideIcon; iconRight?: LucideIcon; pressed?: boolean }) {
  return <button type="button" className="mist-chip" aria-pressed={pressed} {...rest}>{icon && <Icon icon={icon} size="sm" />}{label}{value != null && <b>{value}</b>}{iconRight && <Icon icon={iconRight} size="xs" />}</button>;
}
/** 图标底块（统计卡、关联列表、空状态用） */
export function Tile({ icon, tone, size, children }: { icon?: LucideIcon; tone?: Tone; size?: 'sm' | 'md'; children?: React.ReactNode }) {
  return <span className="mist-tile" data-tone={toneAttr(tone)} data-size={size === 'sm' ? 'sm' : undefined}>{icon ? <Icon icon={icon} size="sm" /> : children}</span>;
}
/** AI 紫藤色徽标 */
export function AIBadge({ icon = AssistantEyes, size }: { icon?: LucideIcon; size?: 'md' | 'lg' }) {
  return <span className="mist-badge" data-size={size === 'lg' ? 'lg' : undefined}><Icon icon={icon} size="sm" /></span>;
}
export const Kbd = ({ children }: { children: React.ReactNode }) => <kbd className="mist-kbd">{children}</kbd>;

/* ───────────── Segmented / Tabs ───────────── */
export type Option<V extends string> = { value: V; label?: React.ReactNode; icon?: LucideIcon; ariaLabel?: string; count?: number };
/** 分段器：2–4 个互斥视图（今天/本周、列表/看板）。 */
export function Segmented<V extends string>({ options, value, onChange, ariaLabel }: { options: Option<V>[]; value: V; onChange: (v: V) => void; ariaLabel?: string }) {
  return (
    <div className="mist-seg" role="group" aria-label={ariaLabel} data-mist-scroll="x">
      {options.map(o => (
        <button key={o.value} type="button" aria-pressed={o.value === value} aria-label={o.ariaLabel} onClick={() => onChange(o.value)}>
          {o.icon && <Icon icon={o.icon} size="sm" />}{o.label}
        </button>
      ))}
    </div>
  );
}
/** 页面级 Tabs（下划线指示）。用于同一模块内的子视图切换。 */
export function Tabs<V extends string>({ options, value, onChange }: { options: Option<V>[]; value: V; onChange: (v: V) => void }) {
  return (
    <div className="mist-tabs" role="tablist" data-mist-scroll="x">
      {options.map(o => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} onClick={() => onChange(o.value)}>
          {o.icon && <Icon icon={o.icon} size="sm" />}{o.label}{o.count != null && <span className="mist-tab-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ───────────── Avatar ───────────── */
export function Avatar({ name, src, tone, size }: { name: string; src?: string; tone?: Tone; size?: 'xs' | 'sm' | 'md' }) {
  const [failedSrc,setFailedSrc]=React.useState<string>();
  return (
    <span className="mist-avatar" data-tone={toneAttr(tone)} data-size={size && size !== 'md' ? size : undefined} title={name}>
      {src && failedSrc!==src ? <img onError={()=>setFailedSrc(src)} src={src} alt="" /> : name.slice(0, name.length > 1 && /^[A-Za-z]/.test(name) ? 2 : 1)}
    </span>
  );
}
export function AvatarStack({ people, size = 'sm', max = 4 }: { people: Array<{ name: string; tone?: Tone; src?: string }>; size?: 'xs' | 'sm'; max?: number }) {
  const shown = people.slice(0, max);
  return <span className="mist-stack">{shown.map((p, i) => <Avatar key={i} {...p} size={size} />)}{people.length > max && <Avatar name={`+${people.length - max}`} size={size} />}</span>;
}

/* ───────────── Card ───────────── */
export type CardProps = React.HTMLAttributes<HTMLElement> & { as?: 'article' | 'section' | 'div' | 'aside' | 'nav'; tone?: 'ai' | 'accent'; clip?: boolean; interactive?: boolean };
/** 卡片：纯白/深底面，无描边无阴影。interactive = 整卡可点（悬停变 card-2）。 */
export function Card({ as = 'article', tone, clip, interactive, className, children, ...rest }: CardProps) {
  const Tag = as as 'article';
  return <Tag className={cx('mist-card', className)} data-tone={tone} data-clip={clip || undefined} data-interactive={interactive || undefined} {...rest}>{children}</Tag>;
}
/** 卡片按钮版（统计卡等整卡可点击的场景） */
export function CardButton({ className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cx('mist-card', className)} data-interactive {...rest}>{children}</button>;
}
export function CardHeader({ title, sub, leading, tools, children }: { title: React.ReactNode; sub?: React.ReactNode; leading?: React.ReactNode; tools?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mist-card-h">
      {leading}
      <div style={{ minWidth: 0 }}><div className="mist-h2">{title}</div>{sub && <small className="mist-card-sub">{sub}</small>}</div>
      {children}
      {tools && <div className="mist-card-tools">{tools}</div>}
    </div>
  );
}
export const CardBody = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => <div className="mist-card-body" style={style}>{children}</div>;
export const CardFooter = ({ children }: { children: React.ReactNode }) => <div className="mist-card-foot">{children}</div>;

/* ───────────── Progress ───────────── */
/** 阶段进度条：total 段，current 为当前阶段（0 起）。 */
export function StageProgress({ total, current, label }: { total: number; current: number; label?: string }) {
  return <div className="mist-prog" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={current} aria-label={label}>
    {Array.from({ length: total }, (_, i) => <i key={i} data-s={i < current ? 'done' : i === current ? 'now' : undefined} />)}
  </div>;
}
/** 水平计量条，可叠加多段（例如 已QC + 生产中）。 */
export function Meter({ segments, caption }: { segments: Array<{ value: number; tone?: Tone }>; caption?: React.ReactNode }) {
  return <div className="mist-meter"><div className="mist-meter-track">{segments.map((s, i) => <i key={i} style={{ width: `${Math.max(0, Math.min(100, s.value))}%` }} data-tone={toneAttr(s.tone)} />)}</div>{caption && <span>{caption}</span>}</div>;
}

/* ───────────── KeyValue / Facts ───────────── */
export function KeyValue({ items }: { items: Array<{ label: React.ReactNode; value: React.ReactNode; mono?: boolean }> }) {
  return <dl className="mist-kv">{items.map((it, i) => <div key={i}><dt>{it.label}</dt><dd className={it.mono ? 'mist-mono' : undefined}>{it.value}</dd></div>)}</dl>;
}
export function Facts({ items, cols = 2 }: { items: Array<{ label: React.ReactNode; value: React.ReactNode }>; cols?: 2 | 3 | 4 }) {
  return <div className="mist-facts" data-cols={cols === 2 ? undefined : cols}>{items.map((it, i) => <div key={i}><small>{it.label}</small><b>{it.value}</b></div>)}</div>;
}

/* ───────────── Object (缩略图 + 名称 + 编号) ───────────── */
export function Thumb({ src, icon, size, alt = '' }: { src?: string; icon?: LucideIcon; size?: 'sm' | 'md' | 'lg'; alt?: string }) {
  return <span className="mist-thumb" data-size={size && size !== 'md' ? size : undefined}>{src ? <img src={src} alt={alt} /> : icon ? <Icon icon={icon} /> : null}</span>;
}
export function ObjectCell({ thumb, name, meta }: { thumb?: React.ReactNode; name: React.ReactNode; meta?: React.ReactNode }) {
  return <div className="mist-obj">{thumb}<div><div className="mist-obj-name">{name}</div>{meta && <div className="mist-obj-meta">{meta}</div>}</div></div>;
}
export const Mono = ({ children }: { children: React.ReactNode }) => <span className="mist-mono">{children}</span>;

/* ───────────── Empty / Skeleton / Banner ───────────── */
export function EmptyState({ icon, title, description, action, compact }: { icon?: LucideIcon; title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; compact?: boolean }) {
  return <div className="mist-empty" data-compact={compact || undefined}>{icon && <Tile icon={icon} />}<b>{title}</b>{description && <span>{description}</span>}{action}</div>;
}
export function Skeleton({ width = '100%', height = 12, radius }: { width?: number | string; height?: number; radius?: number }) {
  return <span className="mist-skel" style={{ width, height, borderRadius: radius }} aria-hidden />;
}
/** 内联提示条（页面内的提醒/错误/AI 建议），不是弹窗。 */
export function Banner({ tone = 'accent', icon, title, children, actions }: { tone?: Tone; icon?: LucideIcon; title: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode }) {
  return <div className="mist-banner" data-tone={toneAttr(tone)} role={tone === 'bad' ? 'alert' : 'status'}>{icon && <Icon icon={icon} />}<div><b>{title}</b>{children && <p>{children}</p>}</div>{actions && <div className="mist-banner-act">{actions}</div>}</div>;
}

/* ───────────── Pagination ───────────── */
export function Pagination({ page, pages, onChange }: { page: number; pages: number; onChange: (p: number) => void }) {
  return <span className="mist-tfoot-pg">
    <IconButton icon={ChevronLeft} label="上一页" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)} />
    <span className="mist-num">{page} / {pages}</span>
    <IconButton icon={ChevronRight} label="下一页" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)} />
  </span>;
}
