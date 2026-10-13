import React from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { AlertCircle, ChevronDown, CircleCheck, Search, X } from 'lucide-react';
import { useMistPortalTarget } from './shell';
import { EmptyState, Icon, IconButton, Kbd, Tile } from './primitives';

const modalStack: HTMLElement[] = [];
const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]';

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(el => {
    if (el.tabIndex < 0 || el.closest('[hidden], [inert]')) return false;
    for (let parent: HTMLElement | null = el; parent && parent !== container.parentElement; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }).sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
}

function ownedMenu(node: HTMLElement, target: Node | null) {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-mist-owner]'))
    .find(menu => menu.dataset.mistOwner === node.id && !!target && menu.contains(target));
}

/** 顶层浮层独占 Esc/焦点，关闭后回到触发器；允许自身的 portal 菜单。 */
function useModalFocus(open: boolean, onClose: () => void, ref: React.RefObject<HTMLElement | null>) {
  const target = useMistPortalTarget();
  const cb = React.useRef(onClose);
  cb.current = onClose;
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!open || !node) return;
    const prev = document.activeElement as HTMLElement | null;
    modalStack.push(node);
    const isTop = () => modalStack.at(-1) === node;
    const focusFirst = () => (focusableIn(node)[0] ?? node).focus();
    const h = (e: KeyboardEvent) => {
      if (!isTop() || ownedMenu(node, e.target as Node)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cb.current(); return; }
      if (e.key !== 'Tab') return;
      const items = focusableIn(node), first = items[0], last = items.at(-1);
      if (!first || (e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last) || !node.contains(document.activeElement)) {
        e.preventDefault(); (e.shiftKey ? last : first)?.focus();
        if (!first) node.focus();
      }
    };
    const onFocus = (e: FocusEvent) => { if (isTop() && !node.contains(e.target as Node) && !ownedMenu(node, e.target as Node)) focusFirst(); };
    document.addEventListener('keydown', h, true);
    document.addEventListener('focusin', onFocus);
    focusFirst();
    return () => {
      document.removeEventListener('keydown', h, true);
      document.removeEventListener('focusin', onFocus);
      const i = modalStack.indexOf(node); if (i >= 0) modalStack.splice(i, 1);
      if (prev?.isConnected) prev.focus();
    };
  }, [open, ref, target]);
}
/** 浮层统一挂到 .mist-root 内（保证 token 生效），没有则挂 body。 */
function Portal({ children }: { children: React.ReactNode }) {
  const target = useMistPortalTarget();
  return createPortal(children, target ?? document.body);
}

/* ───────────── Dialog ───────────── */
export type DialogProps = { open: boolean; onClose: () => void; title: React.ReactNode; description?: React.ReactNode; icon?: LucideIcon; tone?: 'accent' | 'bad' | 'warn' | 'ok'; children?: React.ReactNode; footer?: React.ReactNode; width?: number };
/** 居中弹窗：只用于需要打断的确认（删除、提交不可撤回操作）。普通编辑用 Drawer 或页内表单。 */
export function Dialog({ open, onClose, title, description, icon, tone = 'accent', children, footer, width }: DialogProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  useModalFocus(open, onClose, ref);
  if (!open) return null;
  return <Portal><div className="mist-scrim" onClick={onClose} />
    <div ref={ref} id={id} tabIndex={-1} className="mist-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined} style={width ? { width: `min(${width}px, 92vw)` } : undefined}>
      <div className="mist-dialog-h">{icon && <Tile icon={icon} tone={tone} />}<div style={{ flex: 1 }}><div id={`${id}-title`} className="mist-h2">{title}</div>{description && <p id={`${id}-description`}>{description}</p>}</div><IconButton icon={X} label="关闭" size="sm" onClick={onClose} /></div>
      {children && <div className="mist-dialog-body">{children}</div>}
      {footer && <div className="mist-dialog-foot">{footer}</div>}
    </div></Portal>;
}

/* ───────────── Drawer ───────────── */
export type DrawerProps = { open: boolean; onClose: () => void; title: React.ReactNode; sub?: React.ReactNode; leading?: React.ReactNode; tone?: 'ai'; size?: 'md' | 'lg'; children: React.ReactNode; footer?: React.ReactNode; bodyless?: boolean };
/** 右侧抽屉：快速查看/编辑记录、AI 助手。不离开当前列表。 */
export function Drawer({ open, onClose, title, sub, leading, tone, size, children, footer, bodyless }: DrawerProps) {
  const ref = React.useRef<HTMLElement>(null);
  const id = React.useId();
  useModalFocus(open, onClose, ref);
  if (!open) return null;
  return <Portal><div className="mist-scrim" onClick={onClose} />
    <aside ref={ref} id={id} tabIndex={-1} className="mist-drawer" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={sub ? `${id}-description` : undefined} data-size={size === 'lg' ? 'lg' : undefined}>
      <div className="mist-drawer-h" data-tone={tone}>{leading}<div><b id={`${id}-title`}>{title}</b>{sub && <small id={`${id}-description`}>{sub}</small>}</div><IconButton icon={X} label="关闭" onClick={onClose} /></div>
      {bodyless ? children : <div className="mist-drawer-body">{children}</div>}
      {footer && <div className="mist-drawer-foot">{footer}</div>}
    </aside></Portal>;
}

/* ───────────── Command Palette ───────────── */
export type CommandItem = { id: string; group: string; label: string; hint?: string; hintMono?: boolean; icon?: LucideIcon; image?: string; keywords?: string; run: () => void };
/** ⌘K 命令面板：搜索跳转 + 操作。↑↓ 选择，↵ 执行，Esc 关闭。 */
export function CommandPalette({ open, onClose, items, query, onQueryChange, placeholder = '搜索开发案、订单、客户，或输入命令…' }: { open: boolean; onClose: () => void; items: CommandItem[]; query?: string; onQueryChange?: (query: string) => void; placeholder?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  const [internalQuery, setInternalQuery] = React.useState('');
  const queryChanged = React.useRef(onQueryChange); queryChanged.current = onQueryChange;
  const q = query ?? internalQuery;
  const setQ = (next: string) => { setInternalQuery(next); queryChanged.current?.(next); };
  const [active, setActive] = React.useState(0);
  useModalFocus(open, onClose, ref);
  React.useEffect(() => { if (open) { setQ(''); setActive(0); } }, [open]);
  const filtered = React.useMemo(() => { const s = q.trim().toLowerCase(); return items.filter(x => !s || `${x.label} ${x.hint ?? ''} ${x.keywords ?? ''}`.toLowerCase().includes(s)); }, [q, items]);
  const groups = [...new Set(filtered.map(x => x.group))];
  const flat = groups.flatMap(g => filtered.filter(x => x.group === g).slice(0, 6));
  if (!open) return null;
  const exec = (it?: CommandItem) => { if (!it) return; onClose(); it.run(); };
  return <Portal><div className="mist-scrim" onClick={onClose} />
    <div ref={ref} id={id} tabIndex={-1} className="mist-palette" role="dialog" aria-modal="true" aria-label="搜索">
      <div className="mist-palette-q"><Icon icon={Search} /><input autoFocus value={q} placeholder={placeholder} aria-label={placeholder}
        onChange={e => { setQ(e.target.value); setActive(0); }}
        onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(flat.length - 1, a + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); } else if (e.key === 'Enter') exec(flat[active]); }} /><Kbd>ESC</Kbd></div>
      <div className="mist-palette-list">
        {flat.length ? groups.map(g => <div key={g} className="mist-palette-grp"><small>{g}</small>
          {filtered.filter(x => x.group === g).slice(0, 6).map(it => { const idx = flat.indexOf(it); return (
            <button key={it.id} type="button" className="mist-palette-it" data-active={idx === active || undefined} onMouseEnter={() => setActive(idx)} onClick={() => exec(it)}>
              <span className="mist-tile">{it.image ? <img src={it.image} alt="" /> : it.icon && <Icon icon={it.icon} size="sm" />}</span>{it.label}{it.hint && <small className={it.hintMono ? 'mist-mono' : undefined}>{it.hint}</small>}
            </button>); })}
        </div>) : <EmptyState icon={Search} title={`没有找到「${q}」`} description="换个关键词，或输入编号试试" compact />}
      </div>
      <div className="mist-palette-ft"><span>↑↓ 选择</span><span>↵ 打开</span><span>⌘K 随时唤起</span></div>
    </div></Portal>;
}

/* ───────────── Dropdown (Chip + Menu) ───────────── */
/** 筛选下拉：portal 菜单；方向键/Home/End 导航，Esc 回到触发器，Tab 接续下一控件。 */
export function Dropdown<V extends string>({ label, value, options, onChange }: { label: React.ReactNode; value: V; options: Array<{ value: V; label: string }>; onChange: (v: V) => void }) {
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [position, setPosition] = React.useState<React.CSSProperties>({ left: 0, top: 0 });
  const trigger = React.useRef<HTMLButtonElement>(null);
  const menu = React.useRef<HTMLDivElement>(null);
  const target = useMistPortalTarget();
  const id = React.useId();
  const close = (restoreFocus = true) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  const show = () => { setActive(Math.max(0, options.findIndex(o => o.value === value))); setOpen(true); };
  const moveTo = (index: number) => { setActive(index); menu.current?.querySelectorAll<HTMLButtonElement>('button')[index]?.focus(); };
  React.useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(Math.max(200, anchor.width), Math.max(0, window.innerWidth - 16));
      const height = menu.current?.getBoundingClientRect().height ?? 0;
      const below = anchor.bottom + 6;
      setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)), top: below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - height - 6), minWidth: width, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    menu.current?.querySelectorAll<HTMLButtonElement>('button')[active]?.focus();
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, target]);
  React.useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!trigger.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const current = options.find(o => o.value === value);
  return (
    <div className="mist-menu-wrap">
      <button ref={trigger} id={`${id}-trigger`} type="button" className="mist-chip" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => open ? close() : show()} onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show(); } }}>{label}<b>{current?.label}</b><Icon icon={ChevronDown} size="xs" /></button>
      {open && <Portal><div ref={menu} id={id} className="mist-menu" role="menu" aria-labelledby={`${id}-trigger`} style={position}
        data-mist-owner={trigger.current?.closest('[role="dialog"]')?.id || undefined}
        onKeyDown={e => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            if (options.length) moveTo(next);
          } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
          else if (e.key === 'Tab') {
            const modal = trigger.current?.closest<HTMLElement>('[role="dialog"]');
            const scope = modal ?? document.body;
            const items = focusableIn(scope).filter(el => !menu.current?.contains(el));
            const index = trigger.current ? items.indexOf(trigger.current) : -1;
            const next = items[index + (e.shiftKey ? -1 : 1)] ?? (modal ? e.shiftKey ? items.at(-1) : items[0] : undefined);
            if (next) { e.preventDefault(); close(false); next.focus(); }
            else { close(); }
          }
        }}>
        {options.map((o, index) => <button key={o.value} type="button" role="menuitemradio" tabIndex={index === active ? 0 : -1} aria-checked={o.value === value}
          onFocus={() => setActive(index)} onClick={() => { onChange(o.value); close(); }}>{o.label}</button>)}
      </div></Portal>}
    </div>
  );
}

/* ───────────── Toast ───────────── */
type ToastState = { id: number; text: string; tone?: 'ok' | 'bad' } | null;
const ToastCtx = React.createContext<(text: string, tone?: 'ok' | 'bad') => void>(() => {});
/** 在 MistRoot 内包一层即可，任何组件 useToast()('已保存') */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [t, setT] = React.useState<ToastState>(null);
  const timer = React.useRef<number | undefined>(undefined);
  const show = React.useCallback((text: string, tone?: 'ok' | 'bad') => {
    window.clearTimeout(timer.current); setT({ id: Date.now(), text, tone });
    timer.current = window.setTimeout(() => setT(null), 2600);
  }, []);
  return <ToastCtx.Provider value={show}>{children}{t && <Portal><div key={t.id} className="mist-toast" role="status" data-tone={t.tone === 'bad' ? 'bad' : undefined}><Icon icon={t.tone === 'bad' ? AlertCircle : CircleCheck} size="sm" />{t.text}</div></Portal>}</ToastCtx.Provider>;
}
export const useToast = () => React.useContext(ToastCtx);

/** Keep feedback from unconnected reference pages visibly scoped as a preview. */
export function ToastScope({ children, prefix }: { children: React.ReactNode; prefix?: string }) {
  const show = React.useContext(ToastCtx);
  const scoped = React.useCallback((text: string, tone?: 'ok' | 'bad') => show(prefix ? `${prefix}：${text}` : text, tone), [show, prefix]);
  return <ToastCtx.Provider value={scoped}>{children}</ToastCtx.Provider>;
}
