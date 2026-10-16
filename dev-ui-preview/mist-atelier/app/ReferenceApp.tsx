import React from 'react';
import { Bell, ClipboardList, Component, KeyRound, Layers, LogOut, Moon, Search, Settings2, ShieldCheck, Sparkles, SquareDashed } from 'lucide-react';

import {
  AssistantDrawer, Banner, Button, Card, CardHeader, CommandPalette, Drawer, EmptyState, Field, KeyValue, TextInput, MistAppShell, MistPage, MistRoot, MistSidebarPresentation, MistTopbar, ToastProvider, MistDensityContext, useHotkey, useToast,
  type ChatMessage, type CommandItem, type Crumb, type NavSection, type ThemeMode,
} from '../../../components/mist';
import { getModuleByView, getPrimaryNavigationModules, groupPrimaryNavigationModules } from '../../../components/moduleRegistry';
import { View } from '../../../types';
import { MODULE_MAP } from './moduleMap';
import { Nav, type Route, type RouteTarget } from './nav';
import { MistSessionProvider, useMistSession } from './runtime/auth';
import { LegacyStartup } from '../../../components/mist/LegacyStartup';
import { MistWorkspaceProvider, useMistWorkspace } from './runtime/workspace';
import { MistVersionInfo } from './runtime/version';
import { HomePage } from './pages/HomePage';
import { DevListPage } from './pages/DevListPage';
import { DevDetailPage } from './pages/DevDetailPage';
import { DevCreatePage } from './pages/DevCreatePage';
import { OrderListPage } from './pages/OrderListPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { OrderCreatePage } from './pages/OrderCreatePage';
import { CalendarPage } from './pages/CalendarPage';
import { FinancePage } from './pages/FinancePage';
import { CustomerPage } from './pages/CustomerPage';
import { ProductionPage } from './pages/ProductionPage';
import { SettingsPage } from './pages/SettingsPage';
import { StatesPage } from './pages/StatesPage';
import { DesignSystemPage } from './pages/DesignSystemPage';
import { LoginPage } from './pages/LoginPage';
import { ForcedPasswordChangePage } from './pages/ChangePassword';
import { FULFILLMENT_PAGES } from './pages/modules/FulfillmentPages';
import { MARKET_PAGES } from './pages/modules/MarketPages';
import { PLATFORM_PAGES } from './pages/modules/PlatformPages';
import { LocalAdminPanel } from './pages/modules/LocalAdminPanel';
import { LocalMesPage } from './pages/modules/LocalMesPage';
import { EmailsPage } from './pages/modules/EmailsPage';
import { MistReviewButton, MistReviewProvider } from './runtime/reviews';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { workspaceSearchRecords } from './runtime/search';
import { SearchPage } from './pages/SearchPage';
import { apiService } from '../../../services/apiService';
import { platformBusinessDate } from '../../../server/src/shared/mistPlatform';
import { visibleMistNotifications, mistDailyDigest } from './runtime/notificationPreferences';
const SEARCH_ICONS: Record<string, typeof Layers> = { 开发案: Layers, 订单: ClipboardList };

const PAGES: Record<string, React.FC> = {
  ...FULFILLMENT_PAGES,...MARKET_PAGES,...PLATFORM_PAGES,
  emails: EmailsPage, cockpit: HomePage, development: DevListPage, 'development/detail': DevDetailPage, 'development/new': DevCreatePage,
  orders: OrderListPage, 'orders/detail': OrderDetailPage, 'orders/new': OrderCreatePage, calendar: CalendarPage, 'payment-vouchers': FinancePage, crm: CustomerPage,
  'production-board': ProductionPage, 'system-settings': SettingsPage, settings: SettingsPage, 'workspace-settings': SettingsPage, approvals: ApprovalsPage, notifications: NotificationsPage, search: SearchPage, states: StatesPage, 'design-system': DesignSystemPage,
};
const LIVE_VIEWS = new Set(['emails','cockpit','development','development/detail','development/new','orders','orders/detail','orders/new','payment-vouchers','crm','production-board','calendar','system-settings','settings','workspace-settings','approvals','notifications','search']);
const ROUTE_KEYS = ['view','id','versionId','batchId','section','customerId','orderLineId','productionId','detail'] as const;
const LABELS: Record<string, string> = { 'design-system': '设计系统', states: '空 / 加载 / 错误', 'system-settings': '系统设置', settings: '系统设置', 'workspace-settings': '工作空间设置', approvals: '审批与放行', search: '搜索结果', notifications: '通知中心' };
const GROUPS: Record<string, string> = { overview: '我的事务', customer: '客户与市场', fulfillment: '订单履约', finance: '财务与成本', platform: '平台' };

export function readMistRoute(): Route {
  const qs = new URLSearchParams(location.search);
  const view = qs.get('view') || 'cockpit', id = qs.get('id') || undefined;
  const saved = history.state?.mistRoute;
  const scopeMatches = saved?.view === view && saved?.id === id && ROUTE_KEYS.slice(2).every(key => saved[key] === (qs.get(key) || undefined));
  return {
    ...(scopeMatches ? saved : {}),
    view, id, ...Object.fromEntries(ROUTE_KEYS.slice(2).map(key => [key, qs.get(key) || undefined])),
  };
}
export function writeMistRoute(route: Route) {
  const url = new URL(location.href);
  for (const key of ROUTE_KEYS) {
    if (route[key]) url.searchParams.set(key, route[key]!); else url.searchParams.delete(key);
  }
  history.pushState({ ...history.state, mistRoute: route }, '', url);
}
function useSections(): NavSection[] {
  const session = useMistSession(), {state} = useMistWorkspace();
  const counts:Record<string,number> = {cockpit:state?.tasks.filter(t=>!t.done).length||0,development:state?.devs.length||0,orders:state?.orders.length||0,'payment-vouchers':state?.receipts.filter(r=>r.remaining>0).length||0};
  return React.useMemo(() => {
    const modules = getPrimaryNavigationModules({ isAdmin: session.hasRole('owner', 'admin'), canAccessView: session.canAccessView });
    const real = groupPrimaryNavigationModules(modules).map(g => ({
      id: g.group, label: g.label, defaultClosed: !['overview', 'fulfillment'].includes(g.group),
      items: g.modules.map(m => ({ id: String(m.view), label: m.productLabel.replace('（开发中）', ''), icon: m.icon, count: counts[String(m.view)] })),
    }));
    return [...real, { id: 'handoff', label: '设计系统', items: [
      { id: 'design-system', label: '设计系统', icon: Component }, { id: 'states', label: '空 / 加载 / 错误', icon: SquareDashed },
      { id: 'login', label: '登录页', icon: KeyRound }, { id: 'system-settings', label: '系统设置', icon: Settings2 },
    ].filter(item => (item.id !== 'login' || !session.localMode) && (item.id !== 'system-settings' || session.canAccessView(View.SystemSettings))) }];
  }, [session.sessionKey, session.status, session.hasRole, session.canAccessView, state]);
}
function crumbsFor(route: Route, go: (view: string, id?: string) => void, objectLabel?: string, versionLabel?: string): Crumb[] {
  const base = route.view.split('/')[0], mod = getModuleByView(base as View);
  const label = mod?.productLabel ?? LABELS[base] ?? base;
  const crumbs: Crumb[] = [{ label: mod ? GROUPS[mod.nav.group] : base === 'workspace-settings' || base === 'approvals' || base === 'notifications' || base === 'search' ? '我的事务' : '设计系统', hideOnMobile: true }];
  if (route.view.includes('/')) {
    crumbs.push({ label, onClick: () => go(base) });
    crumbs.push(route.view.endsWith('/new') ? { label: base === 'orders' ? '新建订单' : '新建开发案' } : { label: objectLabel || route.id || '未指定对象', mono: true });
    if (route.versionId) crumbs.push({ label: versionLabel || route.versionId, mono: true });
  } else crumbs.push({ label });
  return crumbs;
}
function AppInner({ theme, setTheme }: { theme: ThemeMode; setTheme: (theme: ThemeMode) => void }) {
  const session = useMistSession(), toast = useToast(), workspace = useMistWorkspace();
  const {state} = workspace;
  const visibleNotifications=visibleMistNotifications(state,view=>session.canAccessView(view as View));
  const dailyDigest=mistDailyDigest(state,platformBusinessDate(new Date()),view=>session.canAccessView(view as View));
  const canDevelopment=session.canAccessView('development' as View), canOrders=session.canAccessView('orders' as View), canCustomers=session.canAccessView('crm' as View), canProduction=session.canAccessView('production-board' as View);
  const [route, setRoute] = React.useState<Route>(readMistRoute);
  const [collapsed, setCollapsed] = React.useState(false);
  const [palette, setPalette] = React.useState(false), [query, setQuery] = React.useState('');
  const [ai, setAI] = React.useState(false), [account, setAccount] = React.useState(false);
  const [notifications, setNotifications] = React.useState(false), [spaces, setSpaces] = React.useState(false), [spaceName, setSpaceName] = React.useState('');
  const [msgs, setMsgs] = React.useState<ChatMessage[]>([]);
  const [aiBusy,setAiBusy]=React.useState(false),[aiUseRouteSource,setAiUseRouteSource]=React.useState(false);
  const aiScope=session.sessionKey+':'+(workspace.workspace?.id??'');
  const aiCurrent=React.useRef(aiScope);aiCurrent.current=aiScope;
  const aiMounted=React.useRef(true),aiController=React.useRef<AbortController|null>(null),aiRun=React.useRef<symbol|null>(null);
  const aiHistory=React.useRef<Array<{role:'user'|'assistant';content:string}>>([]);
  React.useEffect(()=>{aiMounted.current=true;return()=>{aiMounted.current=false;aiController.current?.abort();aiRun.current=null;};},[]);
  React.useEffect(()=>{aiController.current?.abort();aiController.current=null;aiRun.current=null;aiHistory.current=[];setAiBusy(false);setAiUseRouteSource(false);},[aiScope]);
  React.useEffect(()=>setAiUseRouteSource(false),[route.view,route.id]);
  const sections = useSections();
  const go = React.useCallback((view: string, id?: string, target: RouteTarget = {}) => {
    const next = { view, id, ...target };
    setRoute(next); writeMistRoute(next); setPalette(false); setAI(false); setNotifications(false);
    if (view === 'cockpit') window.dispatchEvent(new CustomEvent('bambook:mist-workbench-refresh'));
  }, [toast]);
  React.useEffect(() => {
    const back = () => { const next = readMistRoute(); setRoute(next); setPalette(false); setAI(false); if (next.view === 'cockpit') window.dispatchEvent(new CustomEvent('bambook:mist-workbench-refresh')); };
    window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back);
  }, []);
  React.useEffect(() => { setPalette(false); setAI(false); setAccount(false); setNotifications(false); setSpaces(false); setMsgs([]); }, [session.sessionKey, workspace.workspace?.id]);
  const previousLocalActor = React.useRef<string|undefined>(undefined);
  React.useEffect(() => {
    if (!session.localMode || session.status !== 'authenticated') return;
    if (route.view === 'login' || previousLocalActor.current && previousLocalActor.current !== session.user?.id) go('cockpit');
    previousLocalActor.current = session.user?.id;
  }, [session.localMode, session.status, session.user?.id, route.view, go]);
  const previousSpace = React.useRef<{session:string;id?:string}>({session:session.sessionKey});
  React.useEffect(()=>{
    const id=workspace.workspace?.id, previous=previousSpace.current;
    if(previous.session!==session.sessionKey){previousSpace.current={session:session.sessionKey,id};return;}
    if(id){if(previous.id&&previous.id!==id)go('cockpit');previousSpace.current={session:session.sessionKey,id};}
  },[session.sessionKey,workspace.workspace?.id,go]);
  React.useEffect(() => {
    if (!state) return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setTheme(state.settings.theme === 'system' ? media.matches ? 'dark' : 'light' : state.settings.theme);
    sync(); media.addEventListener?.('change', sync);
    const root = document.querySelector<HTMLElement>('.mist-root');
    for (const key of ['--mist-dur-fast','--mist-dur','--mist-dur-slow']) {
      if (state.settings.reducedMotion) root?.style.setProperty(key, '0s'); else root?.style.removeProperty(key);
    }
    return () => media.removeEventListener?.('change', sync);
  }, [state?.settings.theme, state?.settings.reducedMotion, setTheme]);
  const report = (failure: unknown) => toast(failure instanceof Error ? failure.message : '操作未完成', 'bad');
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    if (state && workspace.workspace?.access?.role !== 'member') void workspace.run({type:'settings.update',payload:{theme:next}}).catch(report);
    else setTheme(next);
  };
  const routeBase=route.view.split('/')[0];
  const currentAiSource=route.id&&routeBase==='orders'&&canOrders&&session.hasPermission('orders:read')
    ?state?.orders.find(row=>row.id===route.id)
      ?{id:'orders:'+route.id,label:state.orders.find(row=>row.id===route.id)!.code,view:'orders/detail',entityId:route.id}:null
    :route.id&&routeBase==='invoices'&&session.hasPermission('invoices:read')
      ?state?.invoices.find(row=>row.id===route.id)
        ?{id:'invoices:'+route.id,label:state.invoices.find(row=>row.id===route.id)!.code,view:'invoices',entityId:route.id}:null
      :route.id&&routeBase==='risks'&&session.hasPermission('risk:read')
        ?state?.platform?.risks.find(row=>row.id===route.id)
          ?{id:'risks:'+route.id,label:state.platform.risks.find(row=>row.id===route.id)!.title,view:'risks',entityId:route.id}:null
        :null;
  const overview = (): ChatMessage => {
    if (!state) return {role:'assistant',content:'工作空间尚未读取，请稍后再试。'};
    const visibleDevs=canDevelopment?state.devs:[],visibleOrders=canOrders?state.orders:[],visibleTasks=state.tasks.filter(t=>session.canAccessView(t.target.view.split('/')[0] as View));
    const devs=visibleDevs.filter(d=>d.stage<4).slice(0,4),late=(canProduction?state.productions:[]).filter(p=>p.col!=='done'&&p.due<platformBusinessDate(new Date()));
    return {role:'assistant',content:<div><p>当前工作空间有 {visibleDevs.length} 个可见开发案、{visibleOrders.length} 张订单；{visibleTasks.filter(t=>!t.done).length} 项待办未完成，{late.length} 项生产已过交期。</p>{devs.map(d=><p key={d.id}><Button variant="quiet" onClick={()=>go('development/detail',d.id,{versionId:d.currentVersionId||undefined})}>{d.code} · {d.name} · {d.state}</Button></p>)}<p>以上为本地记录查询，未执行修改。发送问题时，仅提供你选中的来源及已授权模块的数量概况。</p></div>,sources:['当前工作空间 · 版本 '+workspace.workspace?.revision],actions:<><Button disabled={!session.hasPermission('ai:chat')} onClick={()=>go('assistant')}>进入完整助手</Button>{currentAiSource?<Button aria-pressed={aiUseRouteSource} disabled={aiBusy} onClick={()=>setAiUseRouteSource(value=>!value)}>{aiUseRouteSource?'取消引用：':'引用当前来源：'}{currentAiSource.label}</Button>:<span className="mist-note">当前页面没有可引用的订单、发票或风险记录。</span>}</>};
  };
  const send = async (question:string,retrySources?:string[]) => {
    const content=question.trim();if(!content)return;
    const sourceIds=retrySources??(aiUseRouteSource&&currentAiSource?[currentAiSource.id]:[]);
    const available=()=>aiMounted.current&&aiCurrent.current===aiScope;
    if(!available())return;
    const errorMessage=(message:string):ChatMessage=>({role:'assistant',content:<p>{message}</p>,actions:<Button onClick={()=>void send(content,sourceIds)}>重试此问题</Button>});
    if(aiRun.current){setMsgs(items=>[...items,{role:'user',text:content},errorMessage('上一个问题仍在处理。内容已保留，请等待完成后重试。')]);return;}
    if(!workspace.workspace?.id||workspace.loading){setMsgs(items=>[...items,{role:'user',text:content},errorMessage('工作空间尚未读取，请完成读取后重试。')]);return;}
    if(!session.hasPermission('ai:chat')){setMsgs(items=>[...items,{role:'user',text:content},{role:'assistant',content:'当前账号无模型助手权限，仍可查看上方本地概况。'}]);return;}
    if(content.length>4000){setMsgs(items=>[...items,{role:'user',text:content},{role:'assistant',content:'问题超过4000个字符，请缩短后重试。'}]);return;}
    const token=Symbol('assistant-run'),controller=new AbortController();aiRun.current=token;aiController.current=controller;setAiBusy(true);setMsgs(items=>[...items,{role:'user',text:content}]);
    try{
      const response=await fetch('/api/mist/workspaces/'+encodeURIComponent(workspace.workspace.id)+'/assistant',{method:'POST',headers:{...apiService.getAuthHeaders(),'Content-Type':'application/json'},credentials:'include',signal:controller.signal,body:JSON.stringify({message:content,history:aiHistory.current.slice(-8).map(m=>({...m,content:m.content.slice(0,2000)})),sourceIds})});
      const result=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(result?.error?.message??'模型请求未完成，请重试');
      if(result?.mode!=='read_only'||typeof result.text!=='string'||!result.text.trim()||!Number.isSafeInteger(result.revision)||!Array.isArray(result.sources)||result.sources.some((source:any)=>!source||!sourceIds.includes(source.id)||typeof source.label!=='string'||typeof source.entityId!=='string'||!['orders/detail','invoices','risks'].includes(source.view)||source.id!==(source.view==='orders/detail'?'orders':source.view)+':'+source.entityId))throw new Error('助手响应格式无效，请重试');
      if(!available()||aiRun.current!==token)return;
      aiHistory.current=[...aiHistory.current,{role:'user',content},{role:'assistant',content:result.text}];
      setMsgs(items=>[...items,{role:'assistant',content:<><p style={{whiteSpace:'pre-wrap'}}>{result.text}</p>{result.truncated&&<p className="mist-note">回复过长，已截断；可缩小问题范围继续询问。</p>}<p className="mist-note">模型建议 · 未执行业务操作 · 工作空间版本 {result.revision}</p></>,actions:<>{result.sources.map((source:any)=><Button key={source.id} variant="quiet" onClick={()=>go(source.view,source.entityId)}>{source.label}</Button>)}<Button onClick={()=>go('assistant')}>进入完整助手</Button></>}]);
    }catch(error){if(available()&&aiRun.current===token&&!(error instanceof Error&&error.name==='AbortError'))setMsgs(items=>[...items,errorMessage(error instanceof Error?error.message:'模型服务暂不可用，请重试')]);}
    finally{if(available()&&aiRun.current===token){aiRun.current=null;aiController.current=null;setAiBusy(false);}}
  };
  const openAI = (prompt?: string) => {setAI(true);setPalette(false);if(prompt)void send(prompt);};
  useHotkey('k', () => { if (session.status === 'authenticated') setPalette(value => !value); }, { meta: true });
  useHotkey('j', () => { if (session.status === 'authenticated') openAI(); }, { meta: true });
  const commands: CommandItem[] = [
    ...(state ? workspaceSearchRecords(state, view => session.canAccessView(view as View)).map(r => ({ id: r.view + '-' + r.id, group: r.group, label: r.label, hint: r.hint, keywords: r.keywords, icon: SEARCH_ICONS[r.group], run: () => go(r.view, r.id, r.target) })) : []),
    ...sections.flatMap(section => section.items.map(item => ({ id: 'go-' + item.id, group: '跳转', label: item.label, hint: section.label, icon: item.icon, run: () => go(item.id) }))),
    ...(canDevelopment?[{id:'new-dev',group:'操作',label:'新建开发案',run:()=>go('development/new')}]:[]),
    { id: 'approvals', group: '操作', label: '审批与放行', keywords: '审批 待我审批 放行 付款申请', icon: ClipboardList, run: () => go('approvals') },
    { id: 'notifications', group: '操作', label: '通知中心', keywords: '通知 提醒 未读 消息', icon: Bell, run: () => go('notifications') },
    { id: 'theme', group: '操作', label: '切换深浅色', icon: Moon, run: toggleTheme },
    { id: 'ai', group: '操作', label: '问小竹', hint: '⌘ J', icon: Sparkles, run: ()=>openAI() },
    ...(query.trim() ? [{ id: 'search-all', group: '搜索', label: '打开搜索结果页查看全部', keywords: query.trim(), icon: Search, run: () => go('search', undefined, { section: query.trim() }) }] : []),
  ];
  const nav = { route, go, theme, toggleTheme, openPalette: () => setPalette(true), openAI };
  if (session.status === 'loading') return null;
  if (session.status === 'anonymous' && session.localMode) return <MistPage width="narrow"><Card><CardHeader title="工作区连接待核对" sub="本地工作身份由本机服务提供，无需输入旧账号密码。"/><div className="mist-card-body"><p>{session.error||'暂时无法读取本地工作身份，请重新连接。'}</p><Button variant="primary" loading={session.refreshing} onClick={()=>void session.refresh()}>重新进入本地工作区</Button></div></Card></MistPage>;
  if (session.status === 'anonymous' || route.view === 'login') {
    const loginGo = (view: string, id?: string) => {
      if (view === 'cockpit' && route.view !== 'login') go(route.view, route.id, route); else go(view, id);
    };
    return <Nav.Provider value={{ ...nav, go: loginGo }}><LoginPage /></Nav.Provider>;
  }
  if (!session.localMode && session.user?.mustChangePassword) return <ForcedPasswordChangePage />;
  const base = route.view.split('/')[0], module = getModuleByView(base as View);
  // 空间设置只处理当前空间；不能为此授予系统设置/后台管理权限。
  const permitted = route.view === 'workspace-settings' ? !!workspace.workspace : !module || session.canAccessView(base as View), live = LIVE_VIEWS.has(route.view) || !!FULFILLMENT_PAGES[route.view] || !!MARKET_PAGES[route.view] || !!PLATFORM_PAGES[route.view];
  const Page = session.localMode && route.view === 'admin-panel' ? LocalAdminPanel
    : session.localMode && route.view === 'mes' ? LocalMesPage
    : PAGES[route.view] ?? null;
  const user = session.user!;
  const workspaceProfileName = state?.settings.profileName?.trim() || '';
  const name = (workspace.workspace?.ownerId === user.id ? workspaceProfileName : '') || user.displayName || user.email;
  const roles = user.roleLabels?.map(role => role.name).join(' · ') || user.roles.map(role => ({ owner: '负责人', admin: '管理员', manager: '管理者', merchandiser: '业务员', finance: '财务', sales: '业务员', viewer: '查看人员', agent_operator: '助手操作员' })[role]).join(' · ');
  return (
    <Nav.Provider value={nav}><MistReviewProvider><MistDensityContext.Provider value={state?.settings.density||'default'}>
      <MistAppShell collapsed={collapsed} scrollKey={route.view + (route.id ?? '')}
        sidebar={<MistSidebarPresentation sections={sections} activeId={base === 'development' ? 'development' : base}
          onNavigate={id => go(id)} collapsed={collapsed} onToggleCollapsed={() => setCollapsed(value => !value)}
          workspace={{ symbol: (workspace.workspace?.name || name).slice(0,1), name: workspace.workspace?.name || '我的工作空间', caption: state?.settings.demoSeed ? '演示工作空间 · 示例数据' : '当前工作空间', onClick:()=>setSpaces(true) }}
          account={{ name, caption: roles, avatarUrl: user.avatarUrl ?? undefined, onClick: () => setAccount(true) }}
          onSearch={() => setPalette(true)}
          assistant={{ title: '小竹', text: '查询当前工作空间的进展', onClick: ()=>openAI() }} />}
        topbar={scrolled => <MistTopbar scrolled={scrolled} crumbs={crumbsFor(route, go, state?.devs.find(d=>d.id===route.id)?.code || state?.orders.find(o=>o.id===route.id)?.code, state?.versions.find(v=>v.id===route.versionId)?.label)}
          sync={{ state: workspace.error ? 'offline' : workspace.loading||workspace.saving ? 'syncing' : 'ok', text: workspace.saving ? '正在保存' : workspace.loading ? '读取工作空间' : workspace.error ? '需要核对同步状态' : live ? '已保存 · 工作空间' : '设计组件展示' }}
          theme={theme} onToggleTheme={toggleTheme} onSearch={() => setPalette(true)}
          extra={<MistReviewButton/>} notifications={{ unread: visibleNotifications.some(n=>!n.readAt), onClick:()=>setNotifications(true) }} onAsk={()=>openAI()} />}
      >
        {workspace.pendingCreate && !workspace.saving && <Banner tone="warn" title="新工作空间的创建结果需要核对" actions={<Button onClick={()=>void workspace.createWorkspace(workspace.pendingCreate!.name,workspace.pendingCreate!.seed).catch(report)}>核对创建结果</Button>}>{workspace.pendingCreate.name}：将查询并继续同一次创建。</Banner>}
        {workspace.pending && !workspace.saving && !(workspace.pending.kind==='mail-send'&&route.view==='emails') && <Banner tone="warn" title="上次操作的结果需要核对" actions={<Button loading={workspace.saving} onClick={()=>void workspace.recover().catch(report)}>核对原请求</Button>}>核对前会保留原请求，避免重复保存。{workspace.pending.kind==='upload'?'如尚未上传成功，请在原页面重新选择同一附件。':workspace.pending.kind==='mail-send'?'上次邮件发送未收到服务器回执；核对时使用原发送请求，已登记的不会重复投递。':''}</Banner>}
        {workspace.error && <Banner tone="bad" title={workspace.error} actions={<Button onClick={()=>void workspace.refresh()}>重新读取</Button>} />}
        {!permitted ? <EmptyState icon={ShieldCheck} title="没有查看权限" description="当前账号无法访问此业务。" action={<Button onClick={() => go('cockpit')}>返回我的工作</Button>} />
          : Page ? <Page key={session.sessionKey + ':' + workspace.workspace?.id + ':' + (FULFILLMENT_PAGES[route.view]||MARKET_PAGES[route.view]||PLATFORM_PAGES[route.view]?route.view:JSON.stringify(route))} />
          : <EmptyState title="没有找到此页面" action={<Button onClick={() => go('cockpit')}>返回我的工作</Button>} />}
      </MistAppShell>
      <CommandPalette open={palette} onClose={() => setPalette(false)} query={query} onQueryChange={setQuery} items={commands} />
      <AssistantDrawer key={aiScope} open={ai} onClose={() => setAI(false)} messages={[overview(),...msgs,...(aiBusy?[{role:'typing'} as ChatMessage]:[])]} onSend={question=>void send(question)} sub={aiBusy?'正在生成只读建议':'基于选定来源回答 · 不执行业务操作'} suggestions={aiBusy?[]:['根据当前事实建议下一步','哪些信息还需要核实']} />
      <Drawer open={notifications} onClose={()=>setNotifications(false)} title="通知" sub="来自当前工作空间的操作记录"
        footer={<><Button variant="quiet" onClick={()=>{setNotifications(false);go('notifications');}}>查看全部通知</Button><Button disabled={!visibleNotifications.some(n=>!n.readAt)} loading={workspace.saving} onClick={()=>void workspace.run({type:'notification.readAll',payload:{}}).catch(report)}>全部标为已读</Button></>}>
        {state?.settings.notifications.digest&&<Card><CardHeader title="今日工作摘要" sub="按当前记录生成 · 不发送邮件"/><div className="mist-card-body">{dailyDigest.length?dailyDigest.map(item=><p key={item.id}><Button variant="quiet" onClick={()=>go(item.target.view,item.target.id,item.target)}>{item.label} · {item.detail}</Button></p>):<p>今天没有待处理事项。</p>}</div></Card>}
        {visibleNotifications.length?visibleNotifications.slice().reverse().map(n=><Card key={n.id}><CardHeader title={n.title} sub={new Date(n.at).toLocaleString()} tools={<Button variant="quiet" onClick={()=>{void (n.readAt?Promise.resolve():workspace.run({type:'notification.read',payload:{id:n.id}})).then(()=>{if(n.target)go(n.target.view,n.target.id,n.target);}).catch(report);}}>{n.readAt?'查看':'阅读'}</Button>} /><p className="mist-card-body">{n.detail}</p></Card>):<EmptyState title="暂无通知" />}
      </Drawer>
      <Drawer open={spaces} onClose={()=>setSpaces(false)} title="工作空间" sub="切换后只查看对应空间中的记录" footer={<Button onClick={()=>setSpaces(false)}>完成</Button>}>
        {workspace.workspaces.map(w=><p key={w.id}><Button disabled={workspace.loading||!!workspace.pending} variant={w.id===workspace.workspace?.id?'primary':'secondary'} onClick={()=>void workspace.switchWorkspace(w.id).catch(report)}>{w.name}{w.shared?' · 被授权':''}</Button></p>)}
        {workspace.workspaces.some(w=>w.shared)&&<p className="mist-note">“被授权”的空间由其所有者授权你进入；能看到和办理的内容仍按你本人岗位权限决定。</p>}
        {workspace.workspace&&<Button disabled={workspace.loading} onClick={()=>{setSpaces(false);go('workspace-settings');}}>工作空间设置与授权</Button>}
        {state?.settings.demoSeed&&<p className="mist-note">当前是演示工作空间：其中的客户、订单、样品、质检、采购、库存、出运等示例记录都按真实业务流程逐步生成，附件为标注了演示用途的示例 PDF。可以放心试用，不影响其他工作空间。</p>}
        <Field label="新工作空间名称"><TextInput value={spaceName} onChange={e=>setSpaceName(e.target.value)} /></Field>
        <div className="mist-row">
          <Button disabled={!spaceName.trim()||workspace.loading||!!workspace.pending} onClick={()=>void workspace.createWorkspace(spaceName.trim(),'empty').then(()=>setSpaceName('')).catch(report)}>创建空白工作空间</Button>
          <Button disabled={!spaceName.trim()||workspace.loading||!!workspace.pending} onClick={()=>void workspace.createWorkspace(spaceName.trim(),'demo').then(()=>setSpaceName('')).catch(report)}>创建演示工作空间</Button>
        </div>
        <p className="mist-note">演示工作空间会带上一套完整的示例业务数据，便于了解各页面；空白工作空间用于正式记录。</p>
      </Drawer>
      <Drawer open={account} onClose={() => setAccount(false)} title={session.localMode?'本地工作区':'账号'} sub={name}
        footer={session.localMode?<Button loading={session.refreshing} onClick={()=>void session.refresh()}>重新进入本地工作区</Button>:<Button icon={LogOut} loading={session.signingOut} onClick={() => { void session.logout().catch(failure => toast(failure instanceof Error ? failure.message : '退出失败', 'bad')); }}>退出登录</Button>}>
        {session.localMode&&<><p className="mist-note">选择本地工作身份；权限和名称由本机服务提供。</p><div className="mist-row">{session.localProfiles?.map(profile=><Button key={profile.id} aria-pressed={profile.id===user.id} disabled={session.signingIn} variant={profile.id===user.id?'primary':'secondary'} onClick={()=>void session.selectLocalProfile?.(profile.id).catch(failure=>toast(failure instanceof Error?failure.message:'身份切换未完成','bad'))}>{profile.name}</Button>)}</div></>}
        <Button onClick={()=>{setAccount(false);setSpaces(true);}}>切换工作空间</Button>
        {workspace.workspace&&<Button onClick={()=>{setAccount(false);go('workspace-settings');}}>工作空间设置与授权</Button>}
        <KeyValue items={[{ label: '当前工作身份', value: user.displayName || user.email }, { label: '工作区显示名', value: workspaceProfileName || '未设置' }, { label: '工作邮箱', value: user.email }, { label: '职责', value: roles || '未设置' }, { label: '部门', value: user.department || '未设置' }]} />
        {account&&<MistVersionInfo demoSeed={state?.settings.demoSeed} />}
      </Drawer>
    </MistDensityContext.Provider></MistReviewProvider></Nav.Provider>
  );
}

function StartupGate() {
  const session = useMistSession();
  return <LegacyStartup ready={session.status !== 'loading'} />;
}

export function ReferenceApp() {
  const qs = new URLSearchParams(location.search);
  const [theme, setTheme] = React.useState<ThemeMode>(() => (qs.get('theme') as ThemeMode) || (document.documentElement.dataset.mistBootTheme as ThemeMode) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  React.useEffect(() => { try { localStorage.setItem('bambook.mist.boot-theme', theme); } catch {} document.documentElement.style.colorScheme = theme; document.body.style.background = theme === 'dark' ? '#101C35' : '#7FA3B3'; }, [theme]); // mist-allow: original outer-body background outside MistRoot
  return (
    <MistRoot theme={theme}>
      <ToastProvider>
        <MistSessionProvider>
          {qs.get('intro') !== '0' && <StartupGate />}
          <MistWorkspaceProvider><AppInner theme={theme} setTheme={setTheme} /></MistWorkspaceProvider>
        </MistSessionProvider>
      </ToastProvider>
    </MistRoot>
  );
}
