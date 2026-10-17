/** Business page kit: Mist compositions shared by module pages (list + detail, reasoned actions). */
import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button, Card, Drawer } from '../../../../../components/mist';

const COMPACT_QUERY = '(max-width: 1180px)';
/** The sticky preview column is hidden by Mist CSS at ≤1180px; detail then opens in a drawer. */
export function useCompactLayout() {
  const query = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_QUERY).matches;
  const [compact, setCompact] = React.useState(query);
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(COMPACT_QUERY), update = () => setCompact(media.matches);
    update(); media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return compact;
}

const DetailSurface = React.createContext<'card' | 'drawer'>('card');
/** Where a detail renders: the sticky preview card or the compact drawer (which already shows the title). */
export const useDetailSurface = () => React.useContext(DetailSurface);
/** Detail body: card padding in the preview column, plain column inside the drawer. */
export function DetailBody({ heading, children, ...rest }: { heading?: React.ReactNode; children: React.ReactNode } & Omit<React.HTMLAttributes<HTMLDivElement>, "title">) {
  const surface = useDetailSurface();
  return <div className={surface === 'drawer' ? 'mist-col' : 'mist-preview-b'} {...rest}>{surface === "card" && heading}{children}</div>;
}

/** T2 list + sticky detail card. On compact layouts the same detail opens in a drawer after an explicit pick. */
export function ListDetail({ list, detail, drawerTitle, drawerSub, drawerOpen, onDrawerClose }: {
  list: React.ReactNode; detail: React.ReactNode; drawerTitle: React.ReactNode; drawerSub?: React.ReactNode; drawerOpen: boolean; onDrawerClose: () => void;
}) {
  const compact = useCompactLayout();
  return <div className="mist-split" data-list-detail="">
    {list}
    {!compact && <Card as="aside" className="mist-preview">{detail}</Card>}
    {compact && <Drawer open={drawerOpen} onClose={onDrawerClose} title={drawerTitle} sub={drawerSub} size="lg"><DetailSurface.Provider value="drawer">{detail}</DetailSurface.Provider></Drawer>}
  </div>;
}

export type ReasonedAction = { label: string; icon?: LucideIcon; onClick: () => void; primary?: boolean; reason?: string | false; hidden?: boolean };
/** Every unavailable action stays visible with the concrete reason, never a silent grey button. */
export function ActionBar({ actions, busy }: { actions: ReasonedAction[]; busy?: boolean }) {
  const visible = actions.filter(action => !action.hidden);
  if (!visible.length) return null;
  const blocked = visible.filter(action => action.reason);
  return <div className="mist-col">
    <div className="mist-row mist-module-actions">
      {visible.map(action => <Button key={action.label} icon={action.icon} variant={action.primary ? 'primary' : undefined} disabled={busy || !!action.reason} title={action.reason || undefined} onClick={action.onClick}>{action.label}</Button>)}
    </div>
    {blocked.length > 0 && <div className="mist-col" data-action-reasons>{blocked.map(action => <span key={action.label} className="mist-note">{action.label}：{action.reason}</span>)}</div>}
  </div>;
}

/** A titled block inside a detail card. */
export function DetailBlock({ title, aside, children }: { title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  return <section className="mist-col" data-detail-block>
    <div className="mist-row"><span className="mist-eyebrow">{title}</span><span className="mist-spacer" />{aside}</div>
    {children}
  </section>;
}

export const isoDay = (value: string) => (value || '').slice(0, 10);
export const todayIso = () => new Date().toISOString().slice(0, 10);
/** 应用业务时区（与服务端 BUSINESS_TIME_ZONE、platformBusinessDate、审批中心同口径）。 */
export const BUSINESS_TZ = 'Asia/Shanghai';
/** 时刻（ISO 时间戳）所在的业务日；纯日期原样返回。不能直接截取 UTC 字符串，否则北京时间 0–8 点会落到前一天。 */
export const businessDay = (value: string) => {
  const raw = value || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) return isoDay(raw);
  const at = new Date(raw); if (!Number.isFinite(at.getTime())) return isoDay(raw);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (k: string) => parts.find(p => p.type === k)?.value || '';
  return get('year') + '-' + get('month') + '-' + get('day');
};
/** 完整时刻，按业务时区显示（操作记录等）。 */
export const businessWhen = (value: string) => { const at = new Date(value); return Number.isFinite(at.getTime()) ? at.toLocaleString('zh-CN', { timeZone: BUSINESS_TZ }) : '—'; };
export const shortWhen = (value: string) => { const day = businessDay(value); return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(5).replace('-', '/') : '—'; };
