/**
 * 已接线的生产组件：直接替换 App.tsx 里的旧组件即可。
 *   - <MistSidebar>  与 components/Sidebar.tsx 的 SidebarProps 完全一致
 *   - getMistCrumbs(view) 由模块注册表生成面包屑
 *   - <MistAppFrame>  整站外壳（Wave 0），useMistEnabled() 新旧外壳开关
 */
import React from 'react';
import { View } from '../../types';
import { canAccessView, getAuthState, hasRole, subscribe } from '../../services/authService';
import { BAMBOOK_NAV_GROUP_LABELS, getModuleByView, getPrimaryNavigationModules, groupPrimaryNavigationModules } from '../moduleRegistry';
import type { SidebarProps } from '../Sidebar'; // mist-allow: 仅复用旧侧栏的 Props 类型，保证可一行替换
import { useAccountIdentity } from '../ui/useAccountIdentity';
import { MistAppShell, MistRoot, MistSidebarPresentation, MistTopbar, type Crumb, type NavSection } from './shell';
import { ToastProvider } from './overlays';

/** 「我的事务」默认展开，其余分组若不含当前页则默认折叠（与 Demo 一致）。 */
const OPEN_BY_DEFAULT = new Set(['overview', 'fulfillment']);

export function MistSidebar({ currentView, onViewChange, isCollapsed, setIsCollapsed, allowedViews, onOpenSearch, onOpenAssistant, onOpenAccount, workspace }: SidebarProps & {
  onOpenSearch?: () => void; onOpenAssistant?: () => void; onOpenAccount?: () => void; workspace?: { symbol: string; name: string; caption?: string };
}) {
  const [authUser, setAuthUser] = React.useState(() => getAuthState().user);
  React.useEffect(() => subscribe(next => setAuthUser(next.user)), []);
  const { label } = useAccountIdentity(authUser);
  const sections: NavSection[] = React.useMemo(() => {
    const modules = getPrimaryNavigationModules({ isAdmin: hasRole('owner', 'admin'), canAccessView, allowedViews });
    return groupPrimaryNavigationModules(modules).map(g => ({
      id: g.group, label: g.label, defaultClosed: !OPEN_BY_DEFAULT.has(g.group),
      items: g.modules.map(m => ({ id: String(m.view), label: m.productLabel, icon: m.icon })),
    }));
  }, [allowedViews, authUser]);
  return (
    <MistSidebarPresentation
      sections={sections}
      activeId={String(currentView)}
      onNavigate={id => onViewChange(id as unknown as View)}
      collapsed={isCollapsed}
      onToggleCollapsed={() => setIsCollapsed(!isCollapsed)}
      workspace={workspace}
      account={{ name: label, caption: authUser?.email, avatarUrl: authUser?.avatarUrl ?? undefined, onClick: onOpenAccount }}
      onSearch={onOpenSearch}
      assistant={onOpenAssistant ? { title: '小竹', text: '问问今天的待办、QC 与订单动态', onClick: onOpenAssistant } : undefined}
    />
  );
}

/** 面包屑：[分组, 模块名, ...extra]。extra 用于详情页编号。 */
export function getMistCrumbs(view: View, extra: Crumb[] = [], onModuleClick?: () => void): Crumb[] {
  const m = getModuleByView(view);
  if (!m) return extra;
  return [
    { label: BAMBOOK_NAV_GROUP_LABELS[m.nav.group], hideOnMobile: true },
    { label: m.productLabel, onClick: extra.length ? onModuleClick : undefined },
    ...extra,
  ];
}

/* ═════════ Wave 0：整站外壳一键接入 ═════════ */

const MIST_FLAG_KEY = 'bambook.mist';

/**
 * 新外壳开关。默认开启；localStorage['bambook.mist'] = '0' 或 URL `?mist=0` 回到旧外壳（便于对比/回滚）。
 * 全部模块迁移完成后删除开关与旧外壳分支。
 */
export function useMistEnabled(): boolean {
  return React.useMemo(() => {
    if (typeof window === 'undefined') return true;
    const q = new URLSearchParams(window.location.search).get('mist');
    if (q === '0' || q === '1') { try { localStorage.setItem(MIST_FLAG_KEY, q); } catch { /* ignore */ } return q === '1'; }
    try { return localStorage.getItem(MIST_FLAG_KEY) !== '0'; } catch { return true; }
  }, []);
}

export type MistAppFrameProps = {
  currentView: View;
  onViewChange: (view: View) => void;
  isCollapsed: boolean;
  setIsCollapsed: (v: boolean) => void;
  isDarkMode: boolean; // mist-allow: 适配旧 App 的主题状态
  onToggleTheme: () => void;
  allowedViews?: SidebarProps['allowedViews'];
  /** 打开全局搜索（App 里的 setPaletteOpen(true)） */
  onOpenSearch?: () => void;
  /** 打开 AI 助手（没有就不传，侧栏/顶栏会隐藏入口） */
  onOpenAssistant?: () => void;
  /** 打开真实账号菜单（设置、退出等由宿主管理） */
  onOpenAccount?: () => void;
  /** 宿主回程等补充操作，保持真实导航历史 */
  topbarExtra?: React.ReactNode;
  /** 通知：有未读时显示红点 */
  notifications?: { unread: boolean; onClick: () => void };
  /** 详情页在面包屑末尾追加编号等 */
  extraCrumbs?: Crumb[];
  onModuleCrumbClick?: () => void;
  sync?: { state?: 'ok' | 'syncing' | 'offline'; text: string };
  workspace?: { symbol: string; name: string; caption?: string };
  children: React.ReactNode;
};

/**
 * 真实 App 的整站外壳：MistRoot + Toast + 侧栏 + 顶栏 + 滚动画布。
 * 在 App.tsx 里用它包住「当前页面内容」，替换旧的 <Sidebar> + <main>。详见 docs/mist-atelier/05-migration-playbook.md。
 * 主题跟随宿主：App 继续维护 html.dark，这里只把 isDarkMode 传给顶栏用于切换按钮图标。 // mist-allow: 适配旧 App 的主题状态
 */
export function MistAppFrame(p: MistAppFrameProps) {
  return (
    <MistRoot className="mist-frame-root">
      <ToastProvider>
        <MistAppShell collapsed={p.isCollapsed} scrollKey={String(p.currentView)}
          sidebar={<MistSidebar currentView={p.currentView} onViewChange={p.onViewChange} isCollapsed={p.isCollapsed} setIsCollapsed={p.setIsCollapsed}
            allowedViews={p.allowedViews} onOpenSearch={p.onOpenSearch} onOpenAssistant={p.onOpenAssistant} onOpenAccount={p.onOpenAccount} workspace={p.workspace} isDarkMode={p.isDarkMode} onToggleTheme={p.onToggleTheme} />} // mist-allow: 适配旧 App 的主题状态
          topbar={scrolled => <MistTopbar scrolled={scrolled} crumbs={getMistCrumbs(p.currentView, p.extraCrumbs, p.onModuleCrumbClick)} sync={p.sync}
            theme={p.isDarkMode ? 'dark' : 'light'} /* mist-allow */ onToggleTheme={p.onToggleTheme} onSearch={p.onOpenSearch} notifications={p.notifications} onAsk={p.onOpenAssistant} extra={p.topbarExtra} />}>
          {p.children}
        </MistAppShell>
      </ToastProvider>
    </MistRoot>
  );
}
