# 组件 API（自动生成，勿手改）

> 由 `node scripts/gen-mist-docs.mjs` 用 TypeScript AST 从源码生成。通用组件从 `components/mist` 引入；生产适配层从 `components/mist/connected` 引入。Props 类型在所属文件同表列出。

## 外壳 / 页面框架 · `components/mist/shell.tsx`

| 导出 | 说明 | Props / 签名 |
|---|---|---|
| `useMistPortalTarget` | — | `()` |
| `MistRoot` | Mist 作用域根节点。所有 Mist 组件必须在它里面（token 只在此作用域生效）。 theme 不传 = 跟随宿主（html.dark / [data-theme=dark]）。 | `({ theme, children, className, style }: { theme?: ThemeMode; children: React.ReactNode; className?: string; style?: React.CSSProperties })` |
| `useHotkey` | 全局快捷键：useHotkey('k', open, { meta: true }) → ⌘K / Ctrl+K | `(key: string, handler: (e: KeyboardEvent) => void, opts: { meta?: boolean; shift?: boolean } = {})` |
| `NavItem` | — | `type NavItem = { id: string; label: string; icon: LucideIcon; count?: number };` |
| `NavSection` | — | `type NavSection = { id: string; label: string; items: NavItem[]; defaultClosed?: boolean };` |
| `SidebarPresentationProps` | — | `type SidebarPresentationProps = { sections: NavSection[]; activeId: string; onNavigate: (id: string) => void; collapsed: boolean; onToggleCollapsed: () => void; workspace?: { symbol: string; name: string; caption?: string; onClick?: () => void }; account: { name: string; caption?: string; avatarUrl?: string; onClick?: () => void }; onSearch?: () => void; assistant?: { title: string; text: React.ReactNode; onClick: () => void }; };` |
| `MistSidebarPresentation` | 侧栏（纯展示，无数据依赖）。生产环境用 MistSidebar（已接好模块注册表与权限）。 | `({ sections, activeId, onNavigate, collapsed, onToggleCollapsed, workspace, account, onSearch, assistant }: SidebarPresentationProps)` |
| `Crumb` | — | `type Crumb = { label: React.ReactNode; onClick?: () => void; mono?: boolean; hideOnMobile?: boolean };` |
| `MistTopbar` | — | `({ crumbs, scrolled, sync, theme, onToggleTheme, onSearch, notifications, onAsk, extra }: { crumbs: Crumb[]; scrolled?: boolean; sync?: { state?: 'ok' \| 'syncing' \| 'offline'; text: string }; theme?: ThemeMode; onToggleTheme?: () => void; onSearch?: () => void; notifications?: { unread: boolean; onClick: () => void }; onAsk?: () => void; extra?: React.ReactNode; })` |
| `MistAppShell` | 整站外壳：侧栏 + 圆角画布（顶栏 + 滚动区）。 children 放 <MistPage>。scrollKey 变化时滚动回顶部（切换页面时传 view id）。 | `({ sidebar, topbar, collapsed, children, scrollKey }: { sidebar: React.ReactNode; topbar: (scrolled: boolean) => React.ReactNode; collapsed?: boolean; children: React.ReactNode; scrollKey?: string })` |
| `MistPage` | 页面容器：最大宽 1240，入场动画。width='narrow' 用于表单/设置，'wide' 用于看板。 | `({ children, width }: { children: React.ReactNode; width?: 'narrow' \| 'wide' })` |
| `PageHeader` | 页头：eyebrow（所属分组）+ 标题 + 一句话说明 + 右侧操作（最多 1 个 primary）。 | `({ eyebrow, title, description, actions, variant }: { eyebrow?: React.ReactNode; title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; variant?: 'greeting' })` |
| `BackLink` | — | `({ children, onClick }: { children: React.ReactNode; onClick: () => void })` |
| `Toolbar` | — | `({ children, right }: { children?: React.ReactNode; right?: React.ReactNode })` |
| `MistSplash` | 启动画面（应用首次加载）。 | `({ visible }: { visible: boolean })` |

## 接入真实 App 的适配层 · `components/mist/connected.tsx`

| 导出 | 说明 | Props / 签名 |
|---|---|---|
| `MistSidebar` | — | `({ currentView, onViewChange, isCollapsed, setIsCollapsed, allowedViews, onOpenSearch, onOpenAssistant, onOpenAccount, workspace }: SidebarProps & { onOpenSearch?: () => void; onOpenAssistant?: () => void; onOpenAccount?: () => void; workspace?: { symbol: string; name: string; caption?: string }; })` |
| `getMistCrumbs` | 面包屑：[分组, 模块名, ...extra]。extra 用于详情页编号。 | `(view: View, extra: Crumb[] = [], onModuleClick?: () => void): Crumb[]` |
| `useMistEnabled` | 新外壳开关。默认开启；localStorage['bambook.mist'] = '0' 或 URL `?mist=0` 回到旧外壳（便于对比/回滚）。 全部模块迁移完成后删除开关与旧外壳分支。 | `(): boolean` |
| `MistAppFrameProps` | — | `type MistAppFrameProps = { currentView: View; onViewChange: (view: View) => void; isCollapsed: boolean; setIsCollapsed: (v: boolean) => void; isDarkMode: boolean; onToggleTheme: () => void; allowedViews?: SidebarProps['allowedViews']; onOpenSearch?: () => void; onOpenAssistant?: () => void; onOpenAccount?: () => void; topbarExtra?: React.ReactNode; notifications?: { unread: boolean; onClick: () => void }; extraCrumbs?: Crumb[]; onModuleCrumbClick?: () => void; sync?: { state?: 'ok' \| 'syncing' \| 'offline'; text: string }; workspace?: { symbol: string; name: string; caption?: string }; children: React.ReactNode; };` |
| `MistAppFrame` | 真实 App 的整站外壳：MistRoot + Toast + 侧栏 + 顶栏 + 滚动画布。 在 App.tsx 里用它包住「当前页面内容」，替换旧的 <Sidebar> + <main>。详见 docs/mist-atelier/05-migration-playbook.md。 主题跟随宿主：App 继续维护 html.dark，这里只把 isDarkMode 传给顶栏用于切换按钮图标。 // mist-allow: 适配旧 App 的主题状态 | `(p: MistAppFrameProps)` |

## 原子组件 · `components/mist/primitives.tsx`

| 导出 | 说明 | Props / 签名 |
|---|---|---|
| `IconProps` | — | `type IconProps = { icon: LucideIcon; size?: Exclude<Size, 'md'> \| 'md'; className?: string; label?: string };` |
| `Icon` | 统一图标：lucide 线性图标，描边 1.5。size: xs 13 / sm 15 / md 18(默认) / lg 22 | `({ icon: I, size = 'md', className, label }: IconProps)` |
| `ButtonVariant` | — | `type ButtonVariant = 'primary' \| 'secondary' \| 'quiet' \| 'danger' \| 'ai' \| 'white' \| 'glass';` |
| `ButtonProps` | — | `type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { variant?: ButtonVariant; size?: 'sm' \| 'md' \| 'lg'; icon?: LucideIcon; iconRight?: LucideIcon; block?: boolean; loading?: boolean; children?: React.ReactNode; };` |
| `Button` | 按钮。一屏只放一个 primary。 secondary = 浅填充（旧称 ghost），quiet = 无底文字按钮，white/glass 仅用于 Hero 大卡上。 | `forwardRef<HTMLButtonElement, ButtonProps>` |
| `IconButtonProps` | — | `type IconButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { icon: LucideIcon; label: string; size?: 'sm' \| 'md'; dot?: boolean };` |
| `IconButton` | 纯图标按钮。label 必填（无障碍 + tooltip）。dot = 右上角红点（未读通知）。 | `({ icon, label, size = 'md', dot, className, type = 'button', ...rest }: IconButtonProps)` |
| `TextLink` | — | `({ icon, iconRight, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon; iconRight?: LucideIcon })` |
| `Pill` | 状态标签（只读）。带圆点；plain 去掉圆点。tone 语义见 docs/03-components.md#状态色 | `({ tone = 'neutral', plain, children }: { tone?: Tone; plain?: boolean; children: React.ReactNode })` |
| `Chip` | 筛选芯片（可点击，打开下拉）。label 灰，value 加粗。 | `({ label, value, icon, iconRight, pressed, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: React.ReactNode; value?: React.ReactNode; icon?: LucideIcon; iconRight?: LucideIcon; pressed?: boolean })` |
| `Tile` | 图标底块（统计卡、关联列表、空状态用） | `({ icon, tone, size, children }: { icon?: LucideIcon; tone?: Tone; size?: 'sm' \| 'md'; children?: React.ReactNode })` |
| `AIBadge` | AI 紫藤色徽标 | `({ icon = AssistantEyes, size }: { icon?: LucideIcon; size?: 'md' \| 'lg' })` |
| `Kbd` | — | `({ children }: { children: React.ReactNode })` |
| `Option` | — | `type Option<V extends string> = { value: V; label?: React.ReactNode; icon?: LucideIcon; ariaLabel?: string; count?: number };` |
| `Segmented` | 分段器：2–4 个互斥视图（今天/本周、列表/看板）。 | `({ options, value, onChange, ariaLabel }: { options: Option<V>[]; value: V; onChange: (v: V) => void; ariaLabel?: string })` |
| `Tabs` | 页面级 Tabs（下划线指示）。用于同一模块内的子视图切换。 | `({ options, value, onChange }: { options: Option<V>[]; value: V; onChange: (v: V) => void })` |
| `Avatar` | — | `({ name, src, tone, size }: { name: string; src?: string; tone?: Tone; size?: 'xs' \| 'sm' \| 'md' })` |
| `AvatarStack` | — | `({ people, size = 'sm', max = 4 }: { people: Array<{ name: string; tone?: Tone; src?: string }>; size?: 'xs' \| 'sm'; max?: number })` |
| `CardProps` | — | `type CardProps = React.HTMLAttributes<HTMLElement> & { as?: 'article' \| 'section' \| 'div' \| 'aside' \| 'nav'; tone?: 'ai' \| 'accent'; clip?: boolean; interactive?: boolean };` |
| `Card` | 卡片：纯白/深底面，无描边无阴影。interactive = 整卡可点（悬停变 card-2）。 | `({ as = 'article', tone, clip, interactive, className, children, ...rest }: CardProps)` |
| `CardButton` | 卡片按钮版（统计卡等整卡可点击的场景） | `({ className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>)` |
| `CardHeader` | — | `({ title, sub, leading, tools, children }: { title: React.ReactNode; sub?: React.ReactNode; leading?: React.ReactNode; tools?: React.ReactNode; children?: React.ReactNode })` |
| `CardBody` | — | `({ children, style }: { children: React.ReactNode; style?: React.CSSProperties })` |
| `CardFooter` | — | `({ children }: { children: React.ReactNode })` |
| `StageProgress` | 阶段进度条：total 段，current 为当前阶段（0 起）。 | `({ total, current, label }: { total: number; current: number; label?: string })` |
| `Meter` | 水平计量条，可叠加多段（例如 已QC + 生产中）。 | `({ segments, caption }: { segments: Array<{ value: number; tone?: Tone }>; caption?: React.ReactNode })` |
| `KeyValue` | — | `({ items }: { items: Array<{ label: React.ReactNode; value: React.ReactNode; mono?: boolean }> })` |
| `Facts` | — | `({ items, cols = 2 }: { items: Array<{ label: React.ReactNode; value: React.ReactNode }>; cols?: 2 \| 3 \| 4 })` |
| `Thumb` | — | `({ src, icon, size, alt = '' }: { src?: string; icon?: LucideIcon; size?: 'sm' \| 'md' \| 'lg'; alt?: string })` |
| `ObjectCell` | — | `({ thumb, name, meta }: { thumb?: React.ReactNode; name: React.ReactNode; meta?: React.ReactNode })` |
| `Mono` | — | `({ children }: { children: React.ReactNode })` |
| `EmptyState` | — | `({ icon, title, description, action, compact }: { icon?: LucideIcon; title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; compact?: boolean })` |
| `Skeleton` | — | `({ width = '100%', height = 12, radius }: { width?: number \| string; height?: number; radius?: number })` |
| `Banner` | 内联提示条（页面内的提醒/错误/AI 建议），不是弹窗。 | `({ tone = 'accent', icon, title, children, actions }: { tone?: Tone; icon?: LucideIcon; title: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode })` |
| `Pagination` | — | `({ page, pages, onChange }: { page: number; pages: number; onChange: (p: number) => void })` |

## 表单 · `components/mist/form.tsx`

| 导出 | 说明 | Props / 签名 |
|---|---|---|
| `FormGrid` | 表单栅格：默认两列；字段加 full 占满一行。 | `({ cols = 2, children, style }: { cols?: 1 \| 2 \| 3; children: React.ReactNode; style?: React.CSSProperties })` |
| `FieldProps` | — | `type FieldProps = { label: React.ReactNode; required?: boolean; hint?: React.ReactNode; error?: React.ReactNode; full?: boolean; children: React.ReactNode; htmlFor?: string };` |
| `Field` | 字段外框：标签 + 控件 + 提示/错误。error 存在时整个输入底变红色 tint。 | `({ label, required, hint, error, full, children, htmlFor }: FieldProps)` |
| `TextInput` | 单行输入。外层是填充底（无描边），聚焦变强调色浅底。 | `forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & InputBase>` |
| `TextArea` | — | `forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & InputBase>` |
| `Select` | 原生下拉（保证可访问性与移动端体验）。options 可为字符串或 {value,label}。 | `({ icon, options, placeholder, disabled, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & InputBase & { options: Array<string \| { value: string; label: string }>; placeholder?: string })` |
| `SearchField` | — | `({ value, onChange, placeholder = '搜索', autoFocus, style }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; style?: React.CSSProperties })` |
| `Checkbox` | — | `({ checked, onChange, label, tone, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode; tone?: 'ok'; disabled?: boolean })` |
| `Switch` | — | `({ checked, onChange, label, disabled, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode; disabled?: boolean; ariaLabel?: string })` |
| `Choice` | — | `type Choice<V extends string> = { value: V; title: React.ReactNode; description?: React.ReactNode; icon?: LucideIcon };` |
| `ChoiceCards` | 选择卡（大单选）：用于「认可 / 需修改 / 不采用」这类关键决策。 | `({ options, value, onChange, cols = 3, ariaLabel, disabled }: { options: Choice<V>[]; value: V; onChange: (v: V) => void; cols?: number; ariaLabel?: string; disabled?: boolean })` |
| `UploadZone` | 上传区：点击或拖拽。onFiles 拿到 File[]。 | `({ title = '拖拽文件到这里，或点击上传', hint, accept, multiple = true, onFiles }: { title?: React.ReactNode; hint?: React.ReactNode; accept?: string; multiple?: boolean; onFiles: (files: File[]) => void })` |
| `FormSection` | 表单分节（创建/编辑页）：标题 + 说明 + 内容，节与节之间 1px 分隔。 | `({ id, title, description, children }: { id?: string; title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode })` |

## 数据展示 · `components/mist/data.tsx`

| 导出 | 说明 | Props / 签名 |
|---|---|---|
| `MistDensityContext` | — | — |
| `Column` | — | `type Column<T> = { key: string; header: React.ReactNode; width?: string; align?: 'left' \| 'right'; render: (row: T, index: number) => React.ReactNode; sortValue?: (row: T) => string \| number; hideOnMobile?: boolean; };` |
| `DataTableProps` | — | `type DataTableProps<T> = { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; selectedKey?: string \| null; onRowClick?: (row: T) => void; onRowDoubleClick?: (row: T) => void; density?: 'compact' \| 'default' \| 'comfy'; empty?: React.ReactNode; footer?: React.ReactNode; loading?: boolean; minWidth?: number; ariaLabel?: string; };` |
| `DataTable` | 通用数据表（div grid 实现，行可整行点击）。 - 选中行 = 强调色浅底 + 左侧 3px 指示条（不是描边）。 - 行之间唯一 1px 分隔线。 | `({ columns, rows, rowKey, selectedKey, onRowClick, onRowDoubleClick, density: explicitDensity, empty, footer, loading, minWidth, ariaLabel }: DataTableProps<T>)` |
| `Sparkline` | — | `({ points, width = 96, height = 28, tone = 'accent' }: { points: number[]; width?: number; height?: number; tone?: 'accent' \| 'ok' \| 'warn' \| 'bad' })` |
| `StatCardProps` | — | `type StatCardProps = { icon: LucideIcon; label: React.ReactNode; value: React.ReactNode; unit?: React.ReactNode; delta?: { text: string; dir: 'up' \| 'down' \| 'bad' }; foot?: React.ReactNode; spark?: number[]; onClick?: () => void };` |
| `StatCard` | 统计卡：大数字用 light 字重。整卡可点 → 跳到对应列表。 | `({ icon, label, value, unit, delta, foot, spark, onClick }: StatCardProps)` |
| `StatGrid` | — | `({ cols = 4, children }: { cols?: number; children: React.ReactNode })` |
| `PipelineItem` | — | `type PipelineItem<V extends string \| number> = { value: V; label: React.ReactNode; count: number; color: string };` |
| `Pipeline` | 阶段漏斗筛选：一排卡片显示每个阶段的数量，点击筛选。color 用 token，如 'var(--mist-warn)' | `({ items, value, onChange }: { items: PipelineItem<V>[]; value: V; onChange: (v: V) => void })` |
| `DonutSlice` | — | `type DonutSlice = { label: React.ReactNode; value: number; color: string; display?: React.ReactNode };` |
| `Donut` | 环形占比图 + 图例。第一段为主值，中心显示其百分比。 | `({ slices, centerLabel, caption }: { slices: DonutSlice[]; centerLabel?: string; caption?: React.ReactNode })` |
| `toneColor` | — | `(t: Tone)` |

## 业务模式 · `components/mist/patterns.tsx`

| 导出 | 说明 | Props / 签名 |
|---|---|---|
| `HeroFocus` | 焦点大卡：首页/工作台「当前最该做的一件事」。一页最多一个。 | `({ tag = '当前焦点', meta, title, description, media, steps, actions, className }: { tag?: React.ReactNode; meta?: React.ReactNode[]; title: React.ReactNode; description?: React.ReactNode; media?: { src: string; alt: string }; steps?: Array<{ label: string; state: StepState }>; actions?: React.ReactNode; className?: string; })` |
| `AIBrief` | AI 今日简报：小竹总结的 3–5 条要点 + 提问入口。 | `({ icon, title = '今日简报', sub, items, onAsk, askPlaceholder = '问问这些事的来龙去脉…', className }: { icon: LucideIcon; title?: React.ReactNode; sub?: React.ReactNode; className?: string; items: Array<{ strong: React.ReactNode; text: React.ReactNode; onClick?: () => void }>; onAsk?: () => void; askPlaceholder?: string; })` |
| `TaskItem` | — | `type TaskItem = { id: string; when: string; urgent?: boolean; title: React.ReactNode; meta?: React.ReactNode; status?: { tone: Tone; label: string }; people?: Array<{ name: string; tone?: Tone }> };` |
| `TaskList` | 待办列表：时间 / 标题+来源 / 状态 / 参与人 / 箭头。 | `({ items, onOpen }: { items: TaskItem[]; onOpen: (t: TaskItem) => void })` |
| `WeekStrip` | 周条 | `({ days, value, onChange }: { days: Array<{ key: string; weekday: string; day: number; dots: number }>; value: string; onChange: (k: string) => void })` |
| `Agenda` | 日程列表。tone: 默认强调色 / ai 紫藤 / mute 灰 / warn 黄 | `({ events }: { events: Array<{ time: string; title: React.ReactNode; meta?: React.ReactNode; tone?: 'ai' \| 'mute' \| 'warn' }> })` |
| `IdentityHeader` | 详情页身份行：缩略图 + 元信息 + 大标题 + 右侧关键人/日期/状态。 | `({ thumb, meta, title, facts, actions }: { thumb?: React.ReactNode; meta?: React.ReactNode[]; title: React.ReactNode; facts?: Array<{ label: React.ReactNode; value: React.ReactNode }>; actions?: React.ReactNode })` |
| `Stepper` | 阶段步进条（横向）：done 浅色勾、now 实心强调色、todo 灰、blocked 红。 | `({ steps, onSelect }: { steps: Array<{ label: string; state: StepState; caption?: string }>; onSelect?: (index: number) => void })` |
| `VerticalSteps` | 竖向步骤（创建向导、设置分区导航）。 | `({ steps, current, onSelect, mode = 'step' }: { steps: Array<{ id: string; label: string; done?: boolean; icon?: LucideIcon }>; current: string; onSelect: (id: string) => void; mode?: 'step' \| 'page' })` |
| `FlowSteps` | 流程节点（订单履约 / 出运 / 审批链）。 | `({ nodes }: { nodes: Array<{ label: string; caption?: string; icon: LucideIcon; state: StepState }> })` |
| `TimelineEvent` | — | `type TimelineEvent = { who: string; tone?: Tone; avatar?: string; when: string; text: React.ReactNode; attachment?: { icon: LucideIcon; name: string } };` |
| `Timeline` | 动态时间线（操作日志、沟通记录）。 | `({ events }: { events: TimelineEvent[] })` |
| `Checklist` | 核对清单（出运准备、上线检查）。note 可标红（tone='bad'）。 | `({ items, onToggle }: { items: Array<{ label: React.ReactNode; done: boolean; note?: React.ReactNode; noteTone?: 'bad' }>; onToggle?: (index: number) => void })` |
| `Measurement` | — | `type Measurement = { point: string; standard: number; actual: number; tolerance: number };` |
| `MeasurementTable` | QC 测量事实：标准 / 实测 / 公差条 / 偏差；超半公差提示关注，超出提示偏差。支持零公差和逐行不同公差；不推导总体 QC 结论。 | `({ rows, unit = 'cm' }: { rows: Measurement[]; unit?: string })` |
| `SummaryNumbers` | — | `({ items }: { items: Array<{ label: React.ReactNode; value: React.ReactNode; tone?: Tone }> })` |
| `RelatedList` | 关联对象列表（详情页右栏）。 | `({ items }: { items: Array<{ icon: LucideIcon; title: React.ReactNode; sub?: React.ReactNode; onClick?: () => void }> })` |
| `VersionPicker` | 版本选择（R1-A-1 / R2-A-2…）。 | `({ versions, value, onChange }: { versions: string[]; value: string; onChange: (v: string) => void })` |
| `ObjectStage` | 商品展台（抠图 + 浅色舞台）。 | `({ src, alt, size, topLeft, topRight, caption }: { src: string; alt: string; size?: 'md' \| 'lg'; topLeft?: React.ReactNode; topRight?: React.ReactNode; caption?: React.ReactNode })` |
| `SummaryBar` | 单据汇总条（订单/发票/核销页顶部的 3–4 个大数字）。 | `({ items }: { items: Array<{ label: React.ReactNode; value: React.ReactNode; unit?: React.ReactNode; hint?: React.ReactNode; hintTone?: Tone }> })` |
| `KanbanColumn` | — | `type KanbanColumn<T> = { id: string; title: string; color: string; items: T[] };` |
| `Kanban` | 看板：支持拖拽改列（onMove）。renderCard 只渲染卡片内部内容。 | `({ columns, itemKey, renderCard, onMove, onOpen }: { columns: KanbanColumn<T>[]; itemKey: (t: T) => string; renderCard: (t: T) => React.ReactNode; onMove?: (key: string, toColumn: string) => void; onOpen?: (t: T) => void })` |
| `SettingRow` | 设置行：左侧标题+说明，右侧控件。 | `({ title, description, control }: { title: React.ReactNode; description?: React.ReactNode; control: React.ReactNode })` |

## 浮层 · `components/mist/overlays.tsx`

| 导出 | 说明 | Props / 签名 |
|---|---|---|
| `DialogProps` | — | `type DialogProps = { open: boolean; onClose: () => void; title: React.ReactNode; description?: React.ReactNode; icon?: LucideIcon; tone?: 'accent' \| 'bad' \| 'warn' \| 'ok'; children?: React.ReactNode; footer?: React.ReactNode; width?: number };` |
| `Dialog` | 居中弹窗：只用于需要打断的确认（删除、提交不可撤回操作）。普通编辑用 Drawer 或页内表单。 | `({ open, onClose, title, description, icon, tone = 'accent', children, footer, width }: DialogProps)` |
| `DrawerProps` | — | `type DrawerProps = { open: boolean; onClose: () => void; title: React.ReactNode; sub?: React.ReactNode; leading?: React.ReactNode; tone?: 'ai'; size?: 'md' \| 'lg'; children: React.ReactNode; footer?: React.ReactNode; bodyless?: boolean };` |
| `Drawer` | 右侧抽屉：快速查看/编辑记录、AI 助手。不离开当前列表。 | `({ open, onClose, title, sub, leading, tone, size, children, footer, bodyless }: DrawerProps)` |
| `CommandItem` | — | `type CommandItem = { id: string; group: string; label: string; hint?: string; hintMono?: boolean; icon?: LucideIcon; image?: string; keywords?: string; run: () => void };` |
| `CommandPalette` | ⌘K 命令面板：搜索跳转 + 操作。↑↓ 选择，↵ 执行，Esc 关闭。 | `({ open, onClose, items, query, onQueryChange, placeholder = '搜索开发案、订单、客户，或输入命令…' }: { open: boolean; onClose: () => void; items: CommandItem[]; query?: string; onQueryChange?: (query: string) => void; placeholder?: string })` |
| `Dropdown` | 筛选下拉：portal 菜单；方向键/Home/End 导航，Esc 回到触发器，Tab 接续下一控件。 | `({ label, value, options, onChange }: { label: React.ReactNode; value: V; options: Array<{ value: V; label: string }>; onChange: (v: V) => void })` |
| `ToastProvider` | 在 MistRoot 内包一层即可，任何组件 useToast()('已保存') | `({ children }: { children: React.ReactNode })` |
| `useToast` | — | `()` |
| `ToastScope` | Keep feedback from unconnected reference pages visibly scoped as a preview. | `({ children, prefix }: { children: React.ReactNode; prefix?: string })` |

## AI · `components/mist/ai.tsx`

| 导出 | 说明 | Props / 签名 |
|---|---|---|
| `ChatMessage` | — | `type ChatMessage = \| { role: 'user'; text: string } \| { role: 'assistant'; html?: string; content?: React.ReactNode; sources?: string[]; actions?: React.ReactNode } \| { role: 'typing' };` |
| `AssistantDrawer` | 小竹抽屉。只负责展示；消息状态与发送逻辑由调用方管理（接真实 Agent 接口）。 html 字段仅用于可信的内部模板；来自模型的文本请用 content（React 节点）渲染。 | `({ open, onClose, messages, onSend, suggestions = [], title = '小竹', sub = '基于当前工作空间的业务数据回答', icon = AssistantEyes }: { open: boolean; onClose: () => void; messages: ChatMessage[]; onSend: (text: string) => void; suggestions?: string[]; title?: string; sub?: string; icon?: LucideIcon; })` |

## 品牌 · `components/mist/MistMark.tsx`

| 导出 | 说明 | Props / 签名 |
|---|---|---|
| `MistMark` | Bambook 六叶标志。颜色跟随 currentColor（浅色主题白色、深色主题品牌青）。 | `({ className = 'mist-brand-mark', title }: { className?: string; title?: string })` |
| `MistWordmark` | 标志 + 文字「Bambook 竹衍」 | `()` |

## 公共类型与工具 · `components/mist/types.ts`

| 导出 | 说明 | Props / 签名 |
|---|---|---|
| `Tone` | Mist Atelier 公共类型。所有组件的 tone 只允许这几种。 | `type Tone = 'neutral' \| 'accent' \| 'ok' \| 'warn' \| 'bad' \| 'ai';` |
| `Size` | — | `type Size = 'xs' \| 'sm' \| 'md' \| 'lg';` |
| `StepState` | — | `type StepState = 'done' \| 'now' \| 'todo' \| 'blocked';` |
| `ThemeMode` | — | `type ThemeMode = 'light' \| 'dark';` |
| `toneAttr` | 把 neutral 转为 undefined，避免多余 data-tone 属性 | `(tone?: Tone)` |
| `cx` | — | `(...parts: Array<string \| false \| null \| undefined>)` |


共 124 个导出声明（94 个组件/函数/值，30 个类型）。重导出别名不重复计数。
