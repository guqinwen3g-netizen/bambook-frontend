# PageHeader 组件规格 · 统一页面标题栏

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `PageHeader` |
| 定位 | 全桌面端页面共用的统一标题栏——一处修改全页面联动：左侧中英混排主标题、中间视图切换槽、右侧面包屑+上下文标注+操作按钮+通知铃铛。BDS v2.1 起内部收敛到 `bds-pagehead` 原语,对主题透明 |
| 文件路径 | `components/ui/PageHeader.tsx`(83 行) |
| 消费方 | 全部 16 个 Manager 页面(OrderManager / QuotationManager / CrmManager / ShipmentManager / FinanceManager / DevelopmentManager / ProcurementManager / InventoryManager / BomManager / CustomsManager / MarketingManager / SeasonsManager / RisksManager / SuppliersManager / QcWorkbenchManager / MesManager) |
| 范式 | 受控展示型——无内部状态,所有内容通过 props 注入,内部固定渲染 `NotificationCenterTrigger` |
| 优先级 | P0(全页面统一头部,UI 一致性地基) |
| 实现状态 | ✅ 已落地(bds-pagehead 单写自适应 + NotificationCenterTrigger 内嵌 + center 视图切换槽 + safeLeftStyle 避让 macOS 红绿灯);✅ isDarkMode prop v2.1 起不再消费,仅为调用方兼容保留;⚠️ 无折叠/响应式收缩(移动端走独立 PWA 导航) |
| PRD 关联 | PRD §5.1(全局导航与标题栏统一)/ §5.4(通知中心入口) |
| 代码关联 | [PageHeader.tsx](../../components/ui/PageHeader.tsx) / [NotificationCenter.tsx](../../components/NotificationCenter.tsx) `NotificationCenterTrigger` / [styles/bds/components.css §20](../../styles/bds/components.css) `.bds-pagehead` / [styles/bds/tokens.css](../../styles/bds/tokens.css) `--text-tertiary` / `--font-xs` |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架(Props 接口 + 渲染结构)

```ts
export interface PageHeaderProps {
  title: string;                       // 中文主标题
  subtitle?: string;                   // 英文副标题(中英混排,主标题右侧)
  contextLabel?: string;               // 右侧英文上下文标注(如 "Invoice Desk")
  actions?: React.ReactNode;           // 右侧操作按钮区
  breadcrumb?: React.ReactNode;        // 面包屑节点(渲染于操作区左侧)
  center?: React.ReactNode;            // 标题栏中间槽(视图切换等少数场景)
  isDarkMode?: boolean;                // v2.1 起不再消费,仅为兼容保留
  hidden?: boolean;                    // 全屏编辑器场景隐藏
  safeLeftStyle?: React.CSSProperties; // 安全左偏移(避让 macOS 红绿灯)
  className?: string;
  style?: React.CSSProperties;
}

export const PageHeader: React.FC<PageHeaderProps> = ({ title, subtitle, ... }) => {
  return (
    <header data-ui-lab-wallpaper-contrast="primary"
      className={cx('bds-pagehead shrink-0', hidden && 'hidden', className)}
      style={{ ...safeLeftStyle, ...style }}>
      <div className="ph-main">
        <h1 className="ph-title">
          {title}
          {subtitle && <span className="en">{subtitle}</span>}
        </h1>
      </div>
      {center && <div className="mx-4 flex min-w-0 flex-1 items-center justify-center">{center}</div>}
      <div className="ph-side">
        {breadcrumb}
        {contextLabel && <span className="bds-text-xs" style={{ color: 'var(--text-tertiary)' }}>{contextLabel}</span>}
        {actions}
        <NotificationCenterTrigger variant="header" />
      </div>
    </header>
  );
};
```

### 渲染结构

```
<header className="bds-pagehead shrink-0">
  ├─ .ph-main(flex:1 min-w-0)
  │   └─ h1.ph-title(nowrap + truncate)
  │       ├─ {title}(中文主标题)
  │       └─ span.en {subtitle}(英文副标题,字号更小、对比度更低)
  ├─ center?(mx-4 flex-1 justify-center)— 视图切换等少数场景
  └─ .ph-side
      ├─ {breadcrumb}
      ├─ contextLabel?(bds-text-xs, var(--text-tertiary))
      ├─ {actions}(按钮区,由父组件注入)
      └─ <NotificationCenterTrigger variant="header" />(固定最右)
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `title` | `string` | 是 | — | 中文主标题;`h1.ph-title` nowrap + truncate,顶栏文字禁止换行 |
| `subtitle` | `string` | 否 | — | 英文副标题;渲染于主标题右侧 `.en` 子元素,字号更小、对比度更低,中英混排节奏 |
| `contextLabel` | `string` | 否 | — | 右侧英文上下文标注(如 "Invoice Desk");`bds-text-xs` + `var(--text-tertiary)` |
| `actions` | `React.ReactNode` | 否 | — | 右侧操作按钮区;父组件注入(如「新建报价」「导出 Excel」「导入订单」) |
| `breadcrumb` | `React.ReactNode` | 否 | — | 面包屑节点;渲染于操作区左侧,由父组件构建(如 `订单 / PO-2026-001`) |
| `center` | `React.ReactNode` | 否 | — | 标题栏中间槽;少数页面有视图切换需求(如订单列表/详情切换 Tab) |
| `isDarkMode` | `boolean` | 否 | `false` | **v2.1 起不再消费**——bds-pagehead 单写自适应,暗色由 tokens.css `[data-theme]/.dark` 统一覆盖。仅为调用方兼容保留 |
| `hidden` | `boolean` | 否 | `false` | 全屏编辑器场景隐藏整个 header(`hidden` class) |
| `safeLeftStyle` | `React.CSSProperties` | 否 | — | 安全左偏移样式,避让 macOS 红绿灯窗口控件 |
| `className` | `string` | 否 | — | 额外 className,merge 到 `bds-pagehead` 之后 |
| `style` | `React.CSSProperties` | 否 | — | 额外 style,与 safeLeftStyle 合并 |

**铁律**:`NotificationCenterTrigger` 由组件内部固定渲染——调用方**不需要也不应该**在 actions 中再放通知按钮,避免重复。

---

## §4 内部无状态纪律

PageHeader 是**纯展示型组件**,无 `useState` / `useEffect` / `useMemo`——所有内容由 props 注入,内部唯一固定逻辑是渲染 `NotificationCenterTrigger`。

```ts
const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');
```

`cx` 是组件内仅有的辅助函数,用于条件合并 className(`hidden && 'hidden'`)。

---

## §5 中英混排节奏

### §5.1 主副标题字号对比

通过 `styles/bds/components.css §20` 的 `.bds-pagehead .ph-title` 与 `.ph-title .en` 定义:

| 元素 | 字号 | 字重 | 对比度 |
|---|---|---|---|
| `.ph-title`(中文主标题) | 较大(由 `--font-lg` 驱动) | `font-thin`(300) | text-primary |
| `.ph-title .en`(英文副标题) | 较小(0.6em 量级) | `font-light`(300) | text-tertiary |

**节奏意图**:中文主标题承载识别语义,英文副标题承载国际化辅助——主副字号差异 + 对比度差异共同构建层次感,避免中英等大等重造成的「双主标题」歧义。

### §5.2 nowrap + truncate

`ph-main` 与 `ph-title` 均 `min-width:0 + nowrap + truncate`——顶栏文字**禁止换行**,过长时以省略号截断,保证 actions 区始终可见。

---

## §6 NotificationCenterTrigger 内嵌

### §6.1 固定最右渲染

```tsx
<div className="ph-side">
  {breadcrumb}
  {contextLabel && <span>...</span>}
  {actions}
  <NotificationCenterTrigger variant="header" />  ← 固定最右
</div>
```

**纪律**:通知铃铛是全局入口,**不应**通过 actions 注入——组件内部固定渲染,确保所有页面通知入口位置一致。

### §6.2 variant="header" 节奏

`NotificationCenterTrigger` 的 `variant` prop 决定铃铛尺寸:

| variant | 尺寸 | 圆角 | 用途 |
|---|---|---|---|
| `'default'` | `h-14 w-14` | `rounded-card-lg` | Dashboard 冻结区大圆角方块 |
| `'header'` | `h-10 w-10` | `rounded-full` | **PageHeader 标题栏节奏**(本组件固定使用) |

`variant="header"` 的圆形胶囊与 actions 区按钮高度(h-10)对齐,视觉节奏统一。

### §6.3 未读徽章联动

铃铛右上角未读徽章由 `NotificationCenter` 的 Context 提供:
- `unreadCount > 0` → 显示徽章(品牌 accent 蓝)
- `criticalCount > 0` → 徽章升级为 RDL danger 实心 + ring-2 强调
- `criticalCount > 0 && !isOpen` → 额外 `animate-ping` 红点

详见 [NotificationCenter-通知与审批中心.md](./NotificationCenter-通知与审批中心.md) §4。

---

## §7 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 默认态 | 正常渲染 | `bds-pagehead` 完整布局 + 通知铃铛 | title + subtitle + contextLabel |
| 隐藏态 | `hidden === true` | `hidden` class(整个 header 不渲染) | — |
| 全屏编辑器态 | 父组件传 `hidden={true}` | 同隐藏态;父组件用全屏编辑器替代 | — |
| 通知有未读 | `NotificationCenter` Context `unreadCount > 0` | 铃铛右上角徽章(accent 蓝 / danger 红) | 徽章数字(99+) |
| 通知 critical | `criticalCount > 0 && !isOpen` | 徽章升级 + `animate-ping` 红点 | — |
| 无权限 | 父组件层控制(无独立 scope) | 父组件不渲染 PageHeader | — |

> **无权限态说明**:PageHeader 是全局骨架,无独立 scope 控制——所有可见角色的页面都渲染 PageHeader;具体页面的可见性由路由层 + `canAccessView` 控制。

---

## §8 与 NotificationCenter 的联动

### §8.1 Context 数据流

```
App.tsx 挂载 <NotificationCenter isDarkMode={...}>
  ↓
NotificationContext.Provider value={{ isOpen, toggle, close, unreadCount, criticalCount, isDarkMode }}
  ↓
PageHeader 内部 <NotificationCenterTrigger variant="header" />
  ↓
useContext(NotificationContext) → 读取 unreadCount / criticalCount
  ↓
渲染铃铛 + 未读徽章
  ↓
用户点击 → ctx.toggle() → NotificationCenter 抽屉打开
```

### §8.2 联动纪律

- **PageHeader 不直接持有通知状态**——所有状态由 `NotificationCenter` 顶层 Provider 提供
- **Trigger 仅渲染 + 触发 toggle**——不调 API,不管理抽屉开合
- **Context 隔离 re-render**——`ctxValue` 用 `useMemo` 包裹,仅暴露 Trigger 所需最小状态(`isOpen / toggle / close / unreadCount / criticalCount / isDarkMode`),避免 stats 轮询导致 PageHeader 全局 re-render

---

## §9 状态机

PageHeader 无内部状态,无状态机。唯一的状态流转发生在 `NotificationCenterTrigger` 与 `NotificationCenter` 之间(抽屉开合),由 Context 驱动。

```
NotificationCenter.isOpen=false ──Trigger 点击──► isOpen=true(抽屉滑出)
       ↑                                              │
       │ ESC / 遮罩点击 / 关闭按钮                      │
       └──────────────────────────────────────────────┘
```

---

## §10 数据模型

PageHeader 无独立数据模型。关联类型:

```ts
// NotificationCenterTrigger 的 Props(由 PageHeader 固定传 variant="header")
interface NotificationCenterTriggerProps {
  className?: string;
  iconSize?: number;           // header variant 默认 16
  iconStrokeWidth?: number;    // 默认 1.3
  variant?: 'default' | 'header';  // PageHeader 固定 'header'
}

// Context 暴露给 Trigger 的最小状态
interface NotificationContextValue {
  isOpen: boolean;
  toggle: () => void;
  close: () => void;
  unreadCount: number;
  criticalCount: number;
  isDarkMode: boolean;
}
```

---

## §11 API 端点清单

PageHeader 本身**不调用任何 API**。通知统计由 `NotificationCenter` 顶层负责:

| 关联端点 | 方法 | 用途 | 调用方 |
|---|---|---|---|
| `/v1/notifications/stats` | GET | 未读统计(30s 轮询) | `NotificationCenter.fetchStats` |
| `/v1/notifications` | GET | 通知列表(抽屉打开时) | `NotificationCenter.fetchItems` |
| `/v1/notifications/sse` | SSE | 实时增量推送 | `apiService.subscribeToNotifications` |

---

## §12 权限与可见性

| 角色 | 可见 PageHeader | 可见通知铃铛 | 可见 actions |
|---|---|---|---|
| 所有已登录角色 | ✅ | ✅(未读数随角色通知过滤) | 按父组件 actions 注入逻辑(各页面自行控制 scope) |
| 未登录 | ❌(路由层不渲染任何页面) | — | — |

> **铁律**:PageHeader 是全局骨架,所有已登录角色可见。具体页面的 actions 按钮(如「新建报价」「导出 Excel」)由父组件按 scope 控制是否注入——PageHeader 本身不做权限过滤。

---

## §13 设计系统约束(BDS)

- **容器**:`bds-pagehead` 原语(`styles/bds/components.css §20`),内部布局由 `.ph-main` / `.ph-side` 子类承载
- **主题透明**:`bds-pagehead` 单写自适应——暗色由 `tokens.css [data-theme]/.dark` 统一覆盖,`isDarkMode` prop v2.1 起不再消费
- **圆角**:PageHeader 本身无圆角(顶栏全宽);`NotificationCenterTrigger variant="header"` 用 `rounded-full`
- **颜色**:全部走 BDS token——`var(--text-tertiary)`(contextLabel)/ `var(--text-primary)`(title)/ `var(--os-vnext-brand-blue)`(铃铛未读徽章)
- **字重**:`font-thin`(300,主标题)/ `font-light`(300,副标题)/ `bds-text-xs`(contextLabel)
- **字号**:主标题由 `--font-lg` 驱动;副标题 `.en` 字号更小(0.6em 量级)
- **nowrap + truncate**:`ph-main` 与 `ph-title` 均 `min-width:0 + nowrap + truncate`,顶栏文字禁止换行
- **防回退**:`scripts/check-design-tokens.sh` 扫描硬编码;禁止在 tsx 中写 `text-[#xxx]` / `rounded-[Npx]`
- **safeLeftStyle**:避让 macOS 红绿灯窗口控件,父组件按需传入 `paddingLeft` 偏移

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-PH1 | 无响应式收缩(窄屏时 actions 区可能溢出) | 小屏 / 分屏场景 actions 被截断 | P2 |
| GAP-PH2 | breadcrumb 无统一组件(各页面手写) | 面包屑样式与交互不统一 | P3 |
| GAP-PH3 | contextLabel 无国际化(硬编码英文) | 多语言场景需逐页面改造 | P3 |
| GAP-PH4 | 无「返回上一级」统一按钮(依赖浏览器后退) | 深层详情页返回体验不一致 | P3 |
| GAP-PH5 | isDarkMode prop 已废弃但仍保留,调用方可能误传 | 新调用方可能错误依赖该 prop | P3(下一版清理) |

---

## §15 相关文档索引

- [../00-索引.md](../00-索引.md) — 设计文档真源总索引
- [../01-产品总览/4. 设计系统规范.md](../01-产品总览/4.%20设计系统规范.md) — BDS v2.1 Luna 三层治理 + 320 token
- [../01-产品总览/3. 信息架构与导航.md](../01-产品总览/3.%20信息架构与导航.md) — 全局导航与标题栏统一规范
- [../01-产品总览/5. 全局交互规范.md](../01-产品总览/5.%20全局交互规范.md) — 通知中心入口 + prime 跳转
- [NotificationCenter-通知与审批中心.md](./NotificationCenter-通知与审批中心.md) — 通知铃铛 + 抽屉 + 审批 Tab
- [CmdK-命令面板.md](./CmdK-命令面板.md) — Cmd+K 全局搜索(与 PageHeader 互补的全局入口)
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板容器(PageHeader 之下的内容区容器)
- [BDS组件族7规格.md](./BDS组件族7规格.md) — bds-pagehead 原语规格

---

## §16 补充说明

1. **bds-pagehead 单写自适应铁律**:v2.1 起 `bds-pagehead` 内部不再区分 dark/light 双写——由 `tokens.css [data-theme]/.dark` 统一覆盖。`isDarkMode` prop 仅为调用方兼容保留,组件内部不消费。新调用方无需传该 prop
2. **NotificationCenterTrigger 固定内嵌纪律**:通知铃铛由 PageHeader 内部固定渲染于 `.ph-side` 最右——调用方**不应**在 actions 中再放通知按钮。这是产品铁律,确保所有页面通知入口位置一致
3. **中英混排节奏**:中文主标题 + 英文副标题的字号/对比度差异是设计意图——承载识别语义的是中文,英文仅作国际化辅助。禁止将中英等大等重渲染(会破坏层次感)
4. **nowrap + truncate 铁律**:顶栏文字禁止换行——`ph-main` 与 `ph-title` 均 `min-width:0 + nowrap + truncate`,过长时以省略号截断。这保证 actions 区始终可见,不被长标题挤压
5. **safeLeftStyle 避让 macOS 红绿灯**:Electron 桌面端窗口左上角有 macOS 红绿灯控件,父组件按需传入 `paddingLeft` 偏移避让。Web 浏览器场景无需传该 prop
6. **全页面共用一处修改全联动**:PageHeader 是所有 16 个 Manager 页面的统一头部——padding / 标题字号 / 副标题间距 / 右侧布局 一处修改,全页面联动。这是 BDS 一致性地基,禁止任何页面绕过 PageHeader 手写标题栏
