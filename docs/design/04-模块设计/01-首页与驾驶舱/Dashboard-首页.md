# Dashboard 首页 · 模块设计

## §1 元信息

| 项 | 值 |
|---|---|
| 定位 | 全景看板 / 今日工作台——订单/邮件/市场情报/AI 简报的「概览入口」。与经营驾驶舱（预警：AR/AP/敞口/毛利）、报表中心（明细与台账）定位分化，互不渗透 |
| 入口 | 桌面端导航 → 首页（`View.Dashboard`），App 层受控切换；移动端作为默认落地视图 |
| 角色 | 7 容器角色全量可见（业务员、销售主管、财务、QC、后勤、系统管理员（总领导）、超级管理员（老板）），不展示成本/利润等敏感字段（敏感字段在 Cockpit 内按 scope 遮罩） |
| 范式 | 范式 C — 信息聚合首页：HUD 网格 + 3D 地球底图 + 多卡片轮转；非工作台式 |
| 优先级 | P0（D1 全局工作台体验） |
| 实现状态 | ✅ 已落地（HUD 网格布局 + 3D 地球底图 + 市场行情 + AI 简报打字机 + 生产节流图 + 订单预警带 + 移动端双指捏合切换 cards/globe 视图）。⚠️ **现状冻结**——PRD §24.2 IA 收口明确「看板 UI 现状冻结，仅做专项设计优化，不在自动化批次改动范围内」；新增待办/最近订单快捷入口属于本设计前瞻，落地节奏由 IA 收口批次决定 |
| PRD 关联 | PRD §24.2 IA-1（首页与驾驶舱三件套定位分化） / §D1 全局工作台体验 / §9.6 角色权限矩阵 |
| 代码关联 | `components/Dashboard.tsx`（770+ 行核心 HUD 渲染真源） / `components/ui/MarketIntelligence.tsx`（`ExchangeScreen` 行情板） / `components/ui/ProductionGlobe.tsx`（3D 地球底图，frameloop='always' 与 vsync 相位锁定） / `components/ui/osCompiler/compiledSurfacePrimitives.ts`（`CompiledDashboardCard` 透明包裹器） / `services/marketService.ts`（行情数据 60s 真源刷新） / `services/authService.ts`（订阅当前用户显示名） / `types.ts` `Order/Email/Insight` 模型 |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 页面骨架（ASCII 线框）

```
┌────────────────────────────────────────────────────────────────────────────┐
│ [☰]  [🔍 全局搜索 ⌘K]                              [🔔 通知 3] [👤 用户名] │  ← 顶部条
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ╔══════════════════════════════════════════════════════════════════════╗ │
│  ║  3D 地球底图（ProductionGlobe，max-w-[1680px]）                        ║ │
│  ║                                                                        ║ │
│  ║  ┌─ HUD layer（pointer-events-none，z-10）────────────────────────┐  ║ │
│  ║  │  顶部 Header Card：晨/午/晚安问候 + 当前用户 + 未读邮件数       │  ║ │
│  ║  │  ↓ AI 简报（打字机）——「今日 3 单进入生产，2 单待验货」          │  ║ │
│  ║  ├──────────────────────────────────────────────────────────────┤  ║ │
│  ║  │  ┌─ Metric ─┐ ┌─ Velocity ─┐ ┌─ Pipeline ─┐ ┌─ Status ─┐   │  ║ │
│  ║  │  │ 待办事项  │ │ 周节流图   │ │ 区域分布   │ │ 订单状态 │   │  ║ │
│  ║  │  │ 12 待办   │ │ 13 周柱状 │ │ APAC 65%   │ │ 横向带状 │   │  ║ │
│  ║  │  │ ◐ 73%     │ │           │ │ EU 22%     │ │          │   │  ║ │
│  ║  │  └───────────┘ └───────────┘ └───────────┘ └──────────┘   │  ║ │
│  ║  ├──────────────────────────────────────────────────────────────┤  ║ │
│  ║  │  ┌─ Market 行情板（60s 刷新）─────────────────────────────┐  │  ║ │
│  ║  │  │  棉花 ¥18,200 ↑ 0.8%   美元指数 102.3 ↓ 0.2%          │  │  ║ │
│  ║  │  └────────────────────────────────────────────────────────┘  │  ║ │
│  ║  └──────────────────────────────────────────────────────────────┘  ║ │
│  ╚══════════════════════════════════════════════════════════════════════╝ │
└────────────────────────────────────────────────────────────────────────────┘

  移动端：双指捏合切换 cards / globe 焦点（pinch threshold 26px）
```

### 布局常量（真源：`Dashboard.tsx` 第 52–90 行）

| 常量 | 值 | 用途 |
|---|---|---|
| `DASHBOARD_MARKET_TICK_MS` | 60000 | 行情真源刷新间隔 |
| `DASHBOARD_GLOBE_MAX_WIDTH_PX` | 1680 | 地球底图最大宽度 |
| `DASHBOARD_HUD_TOP_INSET_CLASS` | `pt-[116px]` | HUD 顶部内边距（避开 Header Card） |
| `DASHBOARD_MOBILE_PINCH_THRESHOLD_PX` | 26 | 移动端捏合识别阈值 |
| `DASHBOARD_EXPANDED_MAX_WIDTH_PX` | 1130 | 无地球底图时 HUD 最大宽度（紧凑模式） |
| `DASHBOARD_CARD_RADIUS_CLASS` | `!rounded-panel` | 卡片圆角（BDS） |

---

## §3 区块逐块说明

### §3.1 顶部 Header Card（问候 + 用户身份）

| 属性 | 说明 |
|---|---|
| 数据来源 | `getAuthState().user` + `subscribe` 订阅；`authUser.displayName \|\| authUser.email \|\| 'Bambook Team'` |
| 显示内容 | 晨/午/晚安问候 + 用户名 + 未读邮件数（`emails.filter(e => !e.isRead).length`） |
| 视觉 | `CompiledDashboardCard` 透明包裹器 + adaptive 渐隐蒙版（`data-glass-edge-mask`） |
| 边缘渐隐 | `DASHBOARD_HEADER_CARD_FADE_FEATHER_PX=30` / `DASHBOARD_HEADER_CARD_FADE_OFFSET_PX=10` 控制顶部 feather 渐隐 |

### §3.2 AI 简报（打字机效果）

| 属性 | 说明 |
|---|---|
| 组件 | `TypewriterText`（Dashboard 内联，speed=45ms/字） |
| 数据来源 | 父组件传入 `briefing?: string` + `isBriefingLoading?: boolean` + `onRefreshBriefing?: () => void` |
| 实现要点 | `indexRef.current` 跨 setInterval 闭包追踪，避免字符丢弃；DIAG_FREEZE_DASHBOARD 开关可冻结全文 |
| 刷新 | 用户点击刷新图标触发 `onRefreshBriefing`；服务端 LLM 重新生成简报 |
| 失败降级 | `isBriefingLoading=false && !briefing` 时显示占位文案「暂无简报」 |

### §3.3 待办事项 Metric 卡（DashboardProgressRing）

| 属性 | 说明 |
|---|---|
| 组件 | `DashboardProgressRing`（Dashboard 内联，半径 27px） |
| 显示值 | `cognitionView === 'nodes' ? insightsCount : highInsightCount` |
| 比例 | `memoryPercent = min(insightsCount / 100, 100)` —— 100 条 insight = 100% 满 |
| 视图切换 | `cognitionView` 在 `'nodes' / 'efficiency'` 之间切换，展示「全部洞察」或「高重要性洞察」 |
| 视觉 | SVG 双圆环：底环 `rgba(120,139,162,0.24)` + 进度环 `var(--os-vnext-brand-blue)`，dashoffset 1000ms ease-out 过渡 |

### §3.4 生产节流图 Velocity Chart（13 周柱状）

| 属性 | 说明 |
|---|---|
| 数据源 | `buildVelocityWeeks(orders, kind)` 按 `'fabric' / 'garment'` 切分；近 13 个自然周（周一 00:00 至周日 23:59:59 本地时区） |
| 字段优先级 | event time: `orderDate → poDate → clientDate → updatedAt`；qty: `header.quantity \|\| lines.reduce` |
| 视觉矫正 | `normalizeVelocityChartData` 用 `pow(weekly, 0.85)` 压缩大值差异 + 30px 基线偏移，避免小周柱不可见 |
| 切换 | `activeVelocity` state 在 fabric/garment 间切换；切换时 `useEffect` 重算 `fabricData / garmentData` |
| 图表 | Recharts `ComposedChart` + `RenderTacticalBar`（自定义 flat 柱 + 顶部高光线，inline gradient id） |

### §3.5 区域分布 Pipeline（按 quoteAmount 加权）

| 属性 | 说明 |
|---|---|
| 计算 | `pipelineRegionsByAmount(orders)`：按工厂 lat/lon 分桶 APAC/EU/AMER/其他；无坐标归「其他/未标」 |
| 加权口径 | 按 `quoteAmount` 加权，非订单数 |
| 视图切换 | `pipelineView` state 在 `'total' / 'region'` 之间切换；region 显示 Top3 区域占比条 |
| 空态 | `totalAmt <= 0` 返回空数组，卡片渲染「—」 |

### §3.6 订单状态带 Status Strip

| 属性 | 说明 |
|---|---|
| 数据源 | `liveOrders = orders.filter(o => !o.deletedAt)`，按 `status` 分桶 |
| 关键指标 | `alertCount`（Alert 状态）+ `activeCount`（Production 状态）+ `uniqueProductionFactories`（去重 millName） |
| 视图切换 | `criticalView` state 在 `'production' / 'logistics' / 'market'` 间切换；production 显示产中工厂数、logistics 显示 Pending 订单数、market 显示未读邮件数 |
| 风险百分比 | `risksPercent = alertCount / liveOrders.length * 100`；`outputPercent = activeCount / liveOrders.length * 100` |

### §3.7 市场行情板 Market Hub（60s 真源刷新）

| 属性 | 说明 |
|---|---|
| 组件 | `DashboardMarketHub`（`React.memo`，避免无关 re-render）→ 复用 `ExchangeScreen` |
| 数据源 | `marketService.init() → getTickers()`；60s `setInterval` 调 `refreshCommodities()` |
| 变体 | `variant='compact'`（紧凑）/ `variant='expanded'`（展开，min-width 460px） |
| 数值真源 | **数值仅随真源更新**——无前端随机抖动轮询；展示值即后端真源值 |
| 卸载 | `cancelled` 标志位 + `clearInterval` 双保险，避免 setState on unmounted |

### §3.8 快捷入口（前瞻设计，当前未实现）

> **状态**：⚠️ 待落地——本节为 PRD §24.2 IA-1 收口前瞻设计，当前 Dashboard 无显性快捷入口网格，仅 HUD 卡片本身承担导航职责（点击卡片头部触发 `onNavigate(view)`）。

| 入口 | 目标 View | 触发条件 |
|---|---|---|
| 新建报价单 | `View.Quotations`（prime 创建态） | Sales / SalesManager 角色 |
| 新建订单 | `View.Orders`（创建态） | Sales / SalesManager 角色 |
| 待审批 | `View.Dashboard`（通知抽屉展开） | 任意有 approve scope 的角色 |
| 创建发货 | `View.Shipments`（prime 创建态） | Operations / Warehouse 角色 |
| 录入发票 | `View.Invoices`（创建态） | Finance / FinanceManager 角色 |
| QC 任务 | `View.QcWorkbench` | QC 角色 |

### §3.9 最近订单（前瞻设计，当前未实现）

> **状态**：⚠️ 待落地——当前 Dashboard 不直接展示「最近 5 单」列表，最近订单入口由 CommandPalette（`Cmd+K`）承担。本节为 IA 收口后的扩展设计。

### §3.10 数据概览卡片（已实现的 4 卡 Metric Grid）

HUD 主网格 4 张卡片：Metric（待办环）/ Velocity（13 周节流）/ Pipeline（区域分布）/ Status（订单状态带）。每张卡片支持子视图切换（`cognitionView / activeVelocity / pipelineView / criticalView`），轮转周期 `DASHBOARD_CARD_ROTATION_MS=16000` / `DASHBOARD_VELOCITY_ROTATION_MS=20000`。

---

## §4 模式切换

| 模式 | 触发条件 | 布局差异 |
|---|---|---|
| Globe 模式（默认） | `hasGlobeUnderlay=true && !isMobileSpatial` | HUD 网格在 3D 地球之上，`DASHBOARD_GLOBE_HUD_FRAME_CLASS`（max-w 1680px） |
| Expanded 模式（无地球） | `!hasGlobeUnderlay && !isMobileSpatial` | HUD 网格独占，`DASHBOARD_EXPANDED_HUD_FRAME_CLASS`（max-w 1130px），gridTemplateRows 切换为 `minmax(0,1fr) minmax(168px,0.38fr)` |
| Mobile Spatial 模式 | `isMobileSpatial=true` | 双指捏合切换 `mobileSpatialMode: 'cards' \|\| 'globe'`；触发 `bambook-mobile-dashboard-spatial` className |

切换实现：`useExpandedDashboardLayout = !hasGlobeUnderlay && !isMobileSpatial`，控制 `dashboardRootClass` / `dashboardRootStyle` / `dashboardStageClass` 三处分支。

---

## §5 状态机（数据加载与简报）

```
                mount                       briefing ready
   ┌─────────┐ ───────► ┌──────────┐ ──────────────► ┌──────────┐
   │ init    │           │ loading  │                 │ ready    │
   └─────────┘           └──────────┘                 └──────────┘
                              │ fail                       ▲ refresh
                              ▼                            │
                        ┌──────────┐   retry ┌─────────┐   │
                        │  error   │ ◄────── │ retry   │ ──┘
                        └──────────┘         └─────────┘
```

| 状态 | 触发 | 视觉 |
|---|---|---|
| `init` | 组件挂载 | 行情卡片空态 + `Loader2` 旋转 |
| `loading` | `marketService.init()` 或 `onRefreshBriefing()` | 骨架屏 / 打字机空白 |
| `ready` | 数据到位 | 卡片填充 + 简报打字机开始 |
| `error` | 网络失败 | `AlertCircle` + 上一帧缓存值（不闪空） |

行情板失败时**保留上一帧值**，不闪空——通过 `setMarketData(prev => [...tickers])` 仅在 tickers 非空时更新实现。

---

## §6 数据模型（Dashboard 用到的核心类型）

真源：`types.ts`

```ts
interface DashboardProps {
  orders: Order[];        // 含 status / quoteAmount / factoryLat/Lon / millName / quantity / lines
  emails: Email[];        // 含 isRead
  insights: Insight[];    // 含 importance: 'High'|'Medium'|'Low' / isPinned
  onNavigate: (view: View) => void;
  briefing?: string;
  isBriefingLoading?: boolean;
  isCloudConnected?: boolean;
  isDarkMode?: boolean;
  onRefreshBriefing?: () => void;
  isMobileSpatial?: boolean;
  hasGlobeUnderlay?: boolean;
}

interface Insight {
  id: string;
  fact: string;
  importance: 'High' | 'Medium' | 'Low';
  timestamp: number;
  isPinned?: boolean;
  deletedAt?: number;
}
```

**派生指标**（均在 `useMemo` 内计算，避免每次 render 重算）：
- `liveOrders = orders.filter(o => !o.deletedAt)`
- `liveInsights = insights.filter(i => !i.deletedAt)`
- `insightsCount` / `highInsightCount`（importance='High'）
- `alertCount`（status='Alert'）/ `activeCount`（status='Production'）/ `unreadEmailCount`
- `uniqueProductionFactories`（millName 去重 Set.size）
- `totalValue = liveOrders.reduce((acc, o) => acc + (o.quoteAmount||0), 0)`
- `regionBreakdown = pipelineRegionsByAmount(orders)`

---

## §7 API 端点清单

| 端点 | 方法 | 用途 | 调用方 |
|---|---|---|---|
| `/v1/market/tickers` | GET | 行情数据初始化 + 60s 轮询 | `marketService.init() / refreshCommodities()` |
| `/v1/insights` | GET | AI 简报洞察列表（App 层预加载传入 Dashboard） | App 层 |
| `/v1/ai/briefing` | POST | LLM 生成今日简报（按用户角色定制） | `onRefreshBriefing` 触发 |
| `/v1/notifications/stream` | SSE | 实时增量推送（NotificationCenter 独立消费，Dashboard 不直接消费） | NotificationCenter |

**注意**：Dashboard 不直接发起订单/邮件/Insight 列表请求——这些数据由 App 层预加载后通过 props 传入，Dashboard 仅做派生指标计算与展示。

---

## §8 权限矩阵

| 角色 | 首页可见 | 敏感字段（成本/利润） | AI 简报内容 |
|---|---|---|---|
| Sales / SalesManager | ✅ | ❌（不展示） | 业务员视角（个人订单 + 团队订单） |
| Finance / FinanceManager | ✅ | ❌（在 Dashboard 不展示，仅 Cockpit 按 scope 展示） | 财务视角（回款 / AR/AP 预警） |
| Admin / SuperAdmin | ✅ | ❌（同上） | 全公司视角 |
| Operations / Warehouse | ✅ | ❌ | 履约视角（生产进度 / 发货预警） |

> **铁律**：Dashboard 默认不展示成本/利润/毛利等敏感字段——这些字段唯一真源在 Cockpit 经营驾驶舱，按 `scope: profit:read` 等数据范围 scope 控制。Dashboard 仅展示订单状态、数量、金额（quoteAmount 不属敏感字段，是公开的报价金额）。

---

## §9 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 空态：无订单 | `liveOrders.length === 0` | 居中插画 + `text-os-adaptive-subtitle` | 「暂无订单，点击新建第一单」 |
| 空态：无邮件 | `emails.length === 0` | 邮件卡片空态 + `Loader2` 隐藏 | 「邮箱未连接」 |
| 加载中 | 首次拉取 / 简报生成中 | `Loader2` 旋转 + 打字机空白 | 不显示文案 |
| 错误 | 网络失败 / 行情服务 503 | `AlertCircle` + 上一帧缓存值（不闪空） | 「行情数据获取失败，已显示上次更新值」 |
| 无权限 | 无 `dashboard:read` scope | 锁图标 + `text-disabled` | 「您无权访问首页」（由 App 层路由拦截，Dashboard 内不渲染） |

---

## §10 移动端设计

| 行为 | 实现 |
|---|---|
| 双指捏合切换 | `touchstart` / `touchmove` / `touchend` 监听；pinch delta > 26px 触发；向内捏 → `cards` 焦点，向外张 → `globe` 焦点 |
| 单次捏合防抖 | `pinchResolvedRef.current` 标志位，一次捏合只触发一次切换 |
| 触摸事件 passive | `touchstart`/`touchend` 为 passive=true，`touchmove` 为 passive=false（需 preventDefault 阻止页面滚动） |
| 卸载清理 | `useEffect` 返回函数移除 4 个事件监听 |
| 布局自适应 | `isMobileSpatial=true` 时 `effectiveMobileSpatialMode` 控制布局类；无 globe 时回退 `cards` |

---

## §11 业务规则关联

| 规则 | 关联 | 说明 |
|---|---|---|
| 全局交互规范 | `01-产品总览/5. 全局交互规范.md` | Cmd+K 命令面板从首页任意位置唤起；通知铃铛 30s 轮询 + SSE 增量 |
| 信息架构与导航 | `01-产品总览/3. 信息架构与导航.md` | 首页为 36 View 中的默认落地视图，主导航首项 |
| 三件套定位分化 | `01-产品总览/1. 产品定位与愿景.md` §24.2 | Dashboard（概览）/ Cockpit（预警）/ Reports（明细）三件套互不渗透 |
| 角色权限矩阵 | `01-产品总览/6. 角色与权限矩阵.md` | dashboard:read scope 起步；敏感字段在 Cockpit 内单独 scope |
| 市场行情真源 | `services/marketService.ts` | 行情数据 60s 真源刷新，无前端随机抖动 |

---

## §12 可访问性

| 快捷键 / 行为 | 状态 |
|---|---|
| `Cmd/Ctrl+K` | ✅ 唤起命令面板（首页任意位置可用） |
| 卡片键盘焦点 | ⚠️ HUD 卡片当前未实现 Tab 焦点环（pointer-events-none 影响） |
| 屏幕阅读器 | ⚠️ 3D 地球 Canvas 无 ARIA 描述；行情数值需补 `aria-live="polite"` |
| 高对比度 | ✅ `os-adaptive-*` 类已自适应深浅模式 |
| 减少动画 | ⚠️ 未响应 `prefers-reduced-motion`（DIAG_FREEZE_DASHBOARD 是调试开关，非无障碍开关） |

---

## §13 设计系统约束

- **容器**：HUD 卡片用 `CompiledDashboardCard`（透明包裹器，`className="contents"`）+ `OS_MATERIAL.raisedCard` / `insetSurface` / `floatingOverlay` 三态
- **圆角**：`!rounded-panel`（卡片），禁止硬编码 `rounded-[Npx]`
- **颜色**：`var(--os-vnext-brand-blue)`（进度环主色）/ `text-os-adaptive-primary` / `text-os-adaptive-subtitle` / `text-os-adaptive-brand` 全部走 token
- **字重**：HUD 卡片 `font-normal tracking-[0.04em]`，metric 数值 `font-light tabular-nums`
- **3D 渲染**：`ProductionGlobe` 用 R3F + frameloop='always'（已修复与 vsync 不同步问题，见 Dashboard.tsx:14-25 诊断注释）
- **防回退**：`scripts/check-design-tokens.sh` 扫描硬编码圆角/hex/阴影；新增违规阻断提交
- **膜色**：HUD 背景 `backdrop-filter: blur(24px) saturate(180%)`，深浅模式自适应 spotlightColor

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-D1 | 快捷入口网格（新建报价/订单/发货等 6 入口）未实现 | 用户需多次点击主导航才能到达创建态 | P1 |
| GAP-D2 | 「最近 5 单」订单列表未在首页展示 | 用户快速回到上次操作的订单需走 Cmd+K | P2 |
| GAP-D3 | HUD 卡片无 Tab 键焦点环（pointer-events-none 影响） | 键盘用户无法聚焦卡片触发 onNavigate | P2 |
| GAP-D4 | 3D 地球 Canvas 无 ARIA 描述 + 行情数值无 `aria-live` | 屏幕阅读器用户无法获取动态行情 | P2 |
| GAP-D5 | 未响应 `prefers-reduced-motion` | 前庭觉敏感用户体验受损 | P3 |
| GAP-D6 | AI 简报按用户角色定制内容尚未上线（当前全公司同源简报） | Sales 看不到个人订单简报 | P1 |

---

## §15 相关文档索引

- [../00-索引.md](../../00-索引.md) — 设计文档真源总索引
- [../../01-产品总览/5. 全局交互规范.md](../../01-产品总览/5.%20全局交互规范.md) — Cmd+K / 通知铃铛 / prime 跳转
- [../../01-产品总览/3. 信息架构与导航.md](../../01-产品总览/3.%20信息架构与导航.md) — 36 View 枚举与首页落地
- [../../01-产品总览/4. 设计系统规范.md](../../01-产品总览/4.%20设计系统规范.md) — BDS flat / os-adaptive 类
- [../../01-产品总览/6. 角色与权限矩阵.md](../../01-产品总览/6.%20角色与权限矩阵.md) — dashboard:read 与敏感字段 scope
- [Cockpit-经营驾驶舱.md](./Cockpit-经营驾驶舱.md) — 经营预警入口（与本页定位分化）
- [DataCenter-数据中心.md](./DataCenter-数据中心.md) — 知识库看板与数字孪生
- [Reports-报表中心.md](./Reports-报表中心.md) — 明细与台账入口

---

## §16 补充说明

1. **现状冻结背景**：Dashboard 当前 UI 已稳定运行，PRD §24.2 IA 收口明确「不在自动化批次改动范围内」。本设计文档记录现状 + 前瞻缺口（§14），落地节奏由 IA 收口批次决定，非本批次立即实施
2. **3D 地球 vsync 修复史**：Dashboard 曾出现「地球卡顿但 Orders 页不卡顿」的诡异 bug，经 extensive bisection 排除 DOM 重量因素，根因是 `frameloop='demand' + setInterval(invalidate, 16ms)` 与浏览器合成器 vsync 不同步（Dashboard 的 backdrop-filter 玻璃面板把合成时间推过 16ms）。修复在 `ProductionGlobe.tsx` 改为 `frameloop='always'`，让 R3F 内部 RAF 与 vsync 相位锁定。详见 `Dashboard.tsx:14-25` 注释块
3. **打字机闭包修复**：`TypewriterText` 早期版本用闭包内 `index` 变量导致字符丢弃，修复后改用 `indexRef.current` 跨 setInterval 闭包追踪，确保长简报不丢字
4. **行情真源纪律**：行情数值**仅随真源更新**，无前端随机抖动轮询——这是产品铁律，避免用户误以为行情在跳动但实际未刷新
5. **HUD pointer-events 设计**：HUD layer 整体 `pointer-events-none`，仅卡片内部交互元素显性 `pointer-events-auto`，避免 HUD 遮挡 3D 地球的拖拽交互
