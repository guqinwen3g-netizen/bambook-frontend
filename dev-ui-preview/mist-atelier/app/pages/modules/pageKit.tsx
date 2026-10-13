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
  return <div className="mist-split">
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
export const shortWhen = (value: string) => { const day = isoDay(value); return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(5).replace('-', '/') : '—'; };
