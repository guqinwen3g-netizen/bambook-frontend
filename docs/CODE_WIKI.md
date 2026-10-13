# Bambook (竹衍) v0.8 — Code Wiki

> **查阅方式（2026-10-08 整理）**：本页用于按章节定位代码，不是每次开工的全文必读材料。下文版本、HEAD、能力计数及测试成绩分别对应所标日期，不能当作当前状态或继承的验收结果；当前入口按相关源码核验，业务要求按 `docs/README.md` 指向的有效规则与最新决策判断。

> 面向开发者的代码级知识库：整体架构、模块职责、关键类与函数、依赖关系与运行方式。
>
> 覆盖范围：桌面客户端（Electron + React）、Mac Mini 数据中心后端（Express + Prisma + Agent Runtime）、OPS 运维面板、部署脚本与设计系统。
>
> **版本口径重要更正**：当前推进版本为 **v0.8**（2026-08-21 当周交付目标，权威源见 [MILESTONE_v0.8.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/MILESTONE_v0.8.md)）。此前文档/界面中标注的 "V3.0 / 3.0.0" 是**早期过度自信的错误标注，并非真实版本演进**；npm `package.json` 工程版本号已同步更正为 `0.8.0`。
>
> 编写日期：2026-08-25 ｜ HEAD 基线：`165ff39`（最新为 `19d3eec`/`f23f34c`/`e243ba2`/`165ff39` 缺失功能优先级批次）

---

## 目录

1. [项目概述](#1-项目概述)
2. [技术栈全景](#2-技术栈全景)
3. [整体架构](#3-整体架构)
4. [仓库顶层结构](#4-仓库顶层结构)
5. [前端架构（Electron + React）](#5-前端架构electron--react)
   - 5.1 应用入口与路由
   - 5.2 业务模块注册表（32 模块）
   - 5.3 页面 / Manager 组件清单
   - 5.4 前端服务层（services/）
   - 5.5 前端公共库（lib/）
   - 5.6 设计系统与样式
   - 5.7 Electron 主进程与预加载
   - 5.8 PWA / 移动端
6. [后端架构（Express + Prisma）](#6-后端架构express--prisma)
   - 6.1 服务启动与中间件
   - 6.2 路由注册总览
   - 6.3 数据模型（197 个 Prisma Model）
   - 6.4 认证与权限体系
   - 6.5 事件驱动与跨模块联动（L1–L10）
   - 6.6 关键业务模块说明
   - 6.7 AI 基础设施（LLM / TTS / 知识库）
7. [Agent 运行时](#7-agent-运行时)
   - 7.1 ReAct 主循环
   - 7.2 工具注册表与审批策略
   - 7.3 MCP 协议层
   - 7.4 工具族清单（111+ 种子条目）
   - 7.5 Flow 流程模式
   - 7.6 记忆 / 任务 / 事件 / 作业
   - 7.7 政策与身份（RBAC）
8. [基础设施与部署](#8-基础设施与部署)
   - 8.1 Ops Panel 运维面板
   - 8.2 部署脚本体系
   - 8.3 CI 流水线
   - 8.4 知识库 API（Python）
   - 8.5 本机启动辅助（.command）
9. [关键类与函数索引](#9-关键类与函数索引)
10. [依赖关系](#10-依赖关系)
11. [运行方式](#11-运行方式)
12. [测试体系](#12-测试体系)
13. [开发约定与铁律](#13-开发约定与铁律)
14. [相关文档索引](#14-相关文档索引)
15. [附录 A：走查差异登记](#附录-a走查差异登记)

---

## 1. 项目概述

Bambook（竹衍）是 **Panda Clothing（纺织服装外贸公司）** 的企业智能代理操作系统（Enterprise Agent OS）。系统以**人机协同**为核心，覆盖跟单、报价、订单、财务核销、样品管理、报关退税等外贸全链路业务，内置 Agent Runtime 实现自然语言驱动的业务操作与审批流。

- 官方定位：融合 **Electron 桌面端 + 全栈 API + 本地部署的 Agent 运行时**。
- 一句话架构：**桌面客户端负责展示与交互，Mac Mini 数据中心持有全部业务真源**（两端分离）。
- **当前推进版本：v0.8**（交付目标 2026-08-21 当周）。V3.0/3.0.0 为早期过度标注，产品语义一律以 v0.8 为准。

### 1.1 V0.8 交付口径（权威源 [MILESTONE_v0.8.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/MILESTONE_v0.8.md) + [2026-08-21-v0.8交付验收剧本.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/design/09-路线图与技术债务/2026-08-21-v0.8交付验收剧本.md)）

- **目标**：实现全部基础业务功能的完整、全面交付，甲方能立刻投入真实业务使用；验收以「人工能跑通」为准。
- **交付范围 = 21 个业务板块全部完整交付**：Cockpit、报表中心、关系智库、CRM、供应商管理、数字档案、开发管理、报价管理、订单管理、生产跟单、采购管理、库存管理、QC 工作台、货运管理、外贸与报关、单据中心、财务管理、定价与利润、BOM 成本核算、人事管理、后台管理。
  - 验收剧本口径：上述 19 板块「基础完整功能」围绕**面料出口单 + 成衣出口单两条主链**闭环（S1 主链闭环 / S2 数据可追溯 / S3 角色权限正确三条铁律走查）；Cockpit / 报表中心**占位暂停**；营销/季节/风险/智能邮箱/数据中心/业务工具/MES 不在本版验收范围。
- **随 v0.8 一并交付的基础架构**：登录/权限/角色（RBAC）、数据导入导出（含历史数据迁移入口）、操作留痕/审计（人工操作也记录）、基础 UI 骨架与导航（严格 BDS，不做设计打磨）。
- **v0.8 明确「先不处理」的内容（后续版本更新）**：
  - **AI Agent 原生接入 = 纯占位**：智能体对话、自动规划、MCP 工具智能调用、Agent 中栏渲染等 v0.8 阶段仅保留入口/占位，不做真实能力，推迟到 **2026 年 9 月下一阶段目标**（第一轮以业务员人工驱动业务跑通，Agent 自动化是第二波）。
  - 质量红线（不可降级）：功能完整性 / 数据正确性（金额、汇率、米·码·公斤单位换算）/ 数据不丢不串 / 操作留痕；UI 仅要求按现有 BDS，不做精修。

---

## 2. 技术栈全景

| 层 | 技术 |
| :--- | :--- |
| 桌面客户端 | Electron 41 + React 19 + Vite 6 + electron-vite |
| 样式 | Tailwind CSS 3.4、PostCSS、自研设计系统（os-vnext.css / flat-experimental.css） |
| 动画/可视化 | framer-motion、three.js / react-three-fiber、recharts、maplibre-gl、mermaid |
| 客户端 AI | sherpa-onnx（本地离线 STT）、本地 IndexedDB 缓存 |
| 后端 | Node.js + Express + TypeScript（`server/` 独立工程，`panda-sovereign-server`，Prisma 5 + ts-node/tsx） |
| ORM / 数据库 | Prisma + PostgreSQL 16 — **正式数据库位于公司后端 Mac Mini（`panda_hub_local`）**；本机 `pandahub` 仅供开发/测试 |
| 本地缓存 | better-sqlite3（Electron asarUnpack） |
| Agent | 自研 ReAct 循环 + MCP 2.0 风格工具协议 + JsonSchema 工具注册表 |
| LLM 网关 | **自研链路（后端无 openai/ai-sdk 依赖）**：原生 fetch 直连火山 Ark（默认 base `https://ark.cn-beijing.volces.com/api/coding/v3`，默认模型 `ark-code-latest`）；provider 链主（ARK key 链）→ backup → backup2，请求级失败转移 |
| TTS | melo（预热）/ edge_tts / sensevoice（Python 伴生服务） |
| 知识库向量 | `server/knowledge_api`（Python FastAPI + 向量嵌入） |
| 日志 | winston + winston-daily-rotate-file（后端） |
| 测试 | Vitest（前端 + 后端）、Playwright（验收）、JSDOM |
| 部署 | push-based：Ops Panel（对接 Mac Mini）+ shell 脚本 + Cloudflare Tunnel |
| 运维面板 | `server/ops-panel`（独立子项目，:8088，20 个白名单脚本动作 + DevJob 远程执行 + webapp 增量部署） |

---

## 3. 整体架构

### 3.1 两端分离（真实主架构）

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 桌面客户端 (Electron 41 + React 19) — 任意员工设备，可重装/换机           │
│   UI 展示 / 用户交互 / 本地 STT (sherpa-onnx) / 本地缓存 (IndexedDB)      │
│   不持业务真源；HTTP → https://jiangsupanda.com/bambook/api/v1/*          │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ HTTPS over Cloudflare Tunnel
┌──────────────────────────────▼──────────────────────────────────────────┐
│ Mac Mini 数据中心（公司机房，公网域 jiangsupanda.com）                    │
├─────────────────────────────────────────────────────────────────────────┤
│  Bambook Agent OS  ── manifest / defaults / toolRuntime / planner        │
│   ├─ Planner（正则+LLM 规划）   ├─ Defaults（角色矩阵）                    │
│   ├─ Sandbox（审批拦截）        └─ MCP 工具集（manifest 111+ seeds）        │
├─────────────────────────────────────────────────────────────────────────┤
│  主数据 API (Express + Prisma)  ── launchctl com.bambook.main-data-api   │
│  PostgreSQL (panda_hub_local)   ── 业务真源，定时备份                     │
│  Ops Panel (独立子项目, ops.jiangsupanda.com) ── 白名单运维脚本一键面板    │
├─────────────────────────────────────────────────────────────────────────┤
│  语音/推理外部网关：自研 provider 链（火山 Ark 主 + backup/backup2 备用）  │
└─────────────────────────────────────────────────────────────────────────┘

离线 fallback：客户端探活失败时由 electron/main.ts startEmbeddedServer()
              以 `npx ts-node` 启动 server/src/index.ts（PORT=8081、NODE_ENV=production），
              非日常运行路径（连本机开发库，只读兜底体验）。
```

### 3.2 核心概念

- **业务真源在 Mac Mini**：客户端所有账号/业务数据读写都必须走数据中心 API。
- **数据库归属**：**正式数据库在公司后端的 Mac Mini**（`panda_hub_local`，业务真源 + 定时备份）；**本机/开发机的 `pandahub` 只是开发测试用库**，可随时重置，任何对它的写入都不影响生产。
- **Agent 是人机协同的中枢**：UI 与 Agent 共享同一套 REST API 与数据模型；Agent 高风险的写操作需经过审批卡（ApprovalRequest）人工决策。
- **开发/生产严格隔离**：Dev（localhost:3000 / Electron / Local Panda Hub）与 Prod（bambook.jiangsupanda.com / Mac Mini 正式库）物理隔离，禁止互写。

---

## 4. 仓库顶层结构

```text
apps/Bambook/
├── App.tsx / index.tsx / appTheme.ts       # 前端入口与主布局
├── components/                              # 前端业务组件（扁平结构）
│   ├── *.tsx                               # 各业务 Manager / Center 页面
│   ├── moduleRegistry.ts                   # 业务模块注册表（单一事实源）
│   ├── ui/                                 # 自研 BDS 设计系统组件
│   ├── order/ finance/ hr/ qc/ …           # 业务子组件
│   └── dev/  mascot/  email/  tools/ …     # 专项组件
├── services/                               # 前端 REST API 请求层
├── lib/                                    # 前端公共纯逻辑（权限/状态/格式化）
├── styles/                                 # 全局样式与设计 token（CSS 变量）
├── electron/                               # Electron 主进程 main.ts / preload.ts
├── pwa/                                    # 移动端 PWA 适配
├── server/                                 # 后端（独立工程，见 §6）
│   ├── src/                                # Express + Agent + AI + 业务模块
│   ├── prisma/schema.prisma                # 197 个数据模型
│   ├── ops-panel/                          # 运维面板（独立子项目）
│   ├── knowledge_api/                      # Python FastAPI 知识库服务
│   └── scripts/                            # 数据/运维脚本 + 测试脚本
├── scripts/                                # 开发/部署/审计/验收脚本
├── deploy/macmini/                         # Mac Mini 初始化与数据导入
├── docs/                                   # 设计/架构/规则文档中心
├── dist-electron/                          # electron-builder 产物
├── electron.vite.config.ts                 # electron-vite 配置
├── tailwind.config.js                      # 语义化设计 token 映射
└── package.json                            # 前端/桌面端工程清单
```

---

## 5. 前端架构（Electron + React）

### 5.1 应用入口与路由

- [index.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/index.tsx)：根据设备模式（`deviceMode`）动态导入 `App`（桌面/网页）或 `MobileWebApp`（移动端），`ReactDOM.createRoot` 挂载。
- [App.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/App.tsx)：单页主壳。`activeView` 状态驱动，条件渲染各业务 Manager 组件；负责登录态、侧边栏导航、跨模块跳转（`handleViewChange` / `handleReportNavigate` / `handleOpenOrderById`）、通知链接解析、全局浮层（命令面板、通知中心、AI 助手）。
- [components/Sidebar.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/Sidebar.tsx)：依据 `moduleRegistry` 生成五组一级导航。
- [appTheme.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/appTheme.ts)：主题解析（`resolveInitialDarkMode`：system 配置 dark/light/system + 存储偏好 + 系统偏好三级决策）。
- [lib/modulePermissions.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/lib/modulePermissions.ts)：视图权限策略定义（`ViewPermissionPolicy`）。
- 视图枚举 `View` 定义于顶层 [types](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/types.ts)。

### 5.2 业务模块注册表（32 模块）

[components/moduleRegistry.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/moduleRegistry.ts) 定义 `BAMBOOK_MODULES`（32 个模块），是业务模块**识别/导航/权限/编译面**的单一事实源；视图枚举 `View` 共 **34 个值**（多出 `account-settings` / `system-settings` / `ui-lab` 三个非模块视图）：

```ts
type BambookNavGroup = 'overview' | 'customer' | 'fulfillment' | 'finance' | 'platform'
// order 组段分配：overview 10-19 / customer 20-39 / fulfillment 40-69 / finance 70-89 / platform 90-119
// nav.primary: true 进入一侧导航；false 仅通过内部 tab/入口访问
```

**真实导航分组（来自 moduleRegistry.ts 实际定义，按 order 排序）**：

| overview（10-19） | customer（20-39） | fulfillment（40-69） | finance（70-89） | platform（90-119） |
| :--- | :--- | :--- | :--- | :--- |
| dashboard（全景看板 10） | relations（关系智库 20） | products（数字档案 40） | payment-vouchers（付款凭证 70） | assistant（AI 助手 90） |
| cockpit（经营驾驶舱 12） | crm（客户管理 22） | development（开发管理 42） | invoices（发票管理 71，primary:false） | data-center（数据中心 92） |
| reports（报表中心 14） | suppliers（供应商 24） | quotations（报价管理 44） | pricing（成本定价 72） | hr（人事管理 94） |
| | emails（智能邮箱 26） | orders（订单管理 46） | bom（BOM 管理 74） | business-tools（业务工具 96） |
| | seasons（季节管理 28） | production-board（生产跟单 47） | risks（风险预警 76） | mes（生产执行 97，primary:false） |
| | marketing（市场营销 30） | procurement（采购管理 48） | | admin（管理后台 110，adminOnly） |
| | | inventory（库存管理 50） | | settings（设置 118，primary:false） |
| | | qc-workbench（质检工作台 52） | | |
| | | shipments（货运管理 54） | | |
| | | customs（报关管理 56） | | |
| | | document-center（单据中心 57） | | |

> 对照注意事项（易混淆）：`bom / pricing / risks` 属 **finance** 组（不是 fulfillment）；`mes` 属 platform 且不在一级导航；`data-center` 属 platform（customer 组无它）；`settings` 不在一级导航，经 subViews 拆为 `account` / `system`（View.AccountSettings / View.SystemSettings）；`orders` 含 subViews `fabric-orders` / `garment-orders`。

**渲染映射**（App.tsx 真实挂载，`View.Invoices` / `View.PaymentVouchers` 共用 FinanceManager 按 initialTab 区分，其余一一对应）：

```ts
// App.tsx（节选，L1460-L1670）
{activeView === View.Dashboard          && <Dashboard />}
{activeView === View.Assistant         && <Assistant />}
{activeView === View.Relations         && <RelationsManager />}
{activeView === View.Products          && <ProductsManager />}
{activeView === View.Development       && <DevelopmentManager />}
{(activeView === View.Invoices || activeView === View.PaymentVouchers) &&
  <FinanceManager initialTab={activeView === View.Invoices ? 'invoices' : 'vouchers'} />}
{activeView === View.Reports           && <ReportCenter />}
{activeView === View.Shipments         && <ShipmentManager />}
{activeView === View.Quotations        && <QuotationManager />}
{activeView === View.Procurement       && <ProcurementManager />}
{activeView === View.Inventory         && <InventoryManager />}
{activeView === View.BOM               && <BomManager />}
{activeView === View.CRM               && <CrmManager />}
{activeView === View.Suppliers         && <SuppliersManager />}
{activeView === View.Seasons           && <SeasonsManager />}
{activeView === View.Risks             && <RisksManager />}
{activeView === View.QcWorkbench       && <QcWorkbenchManager />}
{activeView === View.Pricing           && <PricingManager />}
{activeView === View.Marketing         && <MarketingManager />}
{activeView === View.MES               && <MesManager />}
{activeView === View.Customs           && <CustomsManager />}
{activeView === View.DocumentCenter    && <DocumentCenter />}
{activeView === View.ProductionBoard   && <ProductionBoard />}
{activeView === View.DataCenter        && <DataCenter />}
{activeView === View.Orders            && <OrderManager />}
{activeView === View.Emails            && <EmailManager />}
{activeView === View.BusinessTools     && <BusinessTools />}
{activeView === View.AdminPanel        && <AdminPanel />}
{activeView === View.HR                && <HRManager />}
{activeView === View.Cockpit           && <CockpitManager />}
// 未认证时渲染 Login / Register；启动 loading 阶段渲染 SplashScreen（SPLASH_MIN_VISIBLE_MS）
```

> 说明：部分模块含 `subViews`（如 orders 的 fabric-orders / garment-orders）；`compiler` 字段仍记录编译面与 provenance（`accepted` / `provisional` / `legacy-only`），但 **2026-08-18 起渲染路径已统一为 Manager 文件，compiler 元数据不参与渲染选择**（详见 §13 铁律 1）。

### 5.3 页面 / Manager 组件清单

所有业务页面为顶层扁平组件（`components/*.tsx`），主要 Manager 组件与职责：

| 组件 | 职责 |
| :--- | :--- |
| Dashboard.tsx | 全景看板：核心 KPI、趋势图、任务流 |
| CockpitManager.tsx | 经营驾驶舱：经营指标分析（**v0.8 验收剧本口径：占位暂停**，不进入交付范围） |
| OrderManager.tsx | 订单管理主界面（列表/详情/编辑/状态流） |
| QuotationManager.tsx | 报价管理（报价单 CRUD、版本、接受转单） |
| ProductsManager.tsx | 数字档案（面料/成衣/辅料档案、分类、规格） |
| RelationsManager.tsx | 关系智库（客户/供应商/工厂档案、联系人、信用） |
| CrmManager.tsx | 客户管理（线索/商机/跟进/客户分层） |
| SuppliersManager.tsx | 供应商管理（采购/来料/库存协作） |
| ProcurementManager.tsx | 采购管理 |
| InventoryManager.tsx | 库存管理（仓库/库存/出入库流水） |
| BomManager.tsx | BOM 管理 |
| QcWorkbenchManager.tsx | 质检工作台（验货任务/测试报告） |
| DevelopmentManager.tsx | 开发管理（开发案例/打样节点，含 TechPack） |
| CustomsManager.tsx | 报关管理（报关单/HS编码/退税/信用证） |
| MesManager.tsx | 生产执行（工站/计划/工时/计件/外发） |
| ShipmentManager.tsx | 货运管理（提单/装箱/运输事件/海运批次） |
| FinanceManager.tsx | 财务中心：发票、凭证、核销、催款、报表（多 tab） |
| EmailManager.tsx | 邮件中心（同步/分类/回复/模板/签名） |
| HRManager.tsx | 人事（员工档案/考勤/薪酬/绩效/培训/团队） |
| DataCenter.tsx | 数据中心（实体关系图谱/审计） |
| ReportCenter.tsx | 报表中心（报表定义/运行/导出）（**v0.8 验收剧本口径：占位暂停**） |
| KnowledgeBase.tsx | 知识库（文档/知识图谱/SOP 模板） |
| Settings.tsx | 系统设置（用户/角色/权限/系统配置/MOQ） |
| AdminPanel.tsx | 系统管理（审计日志/运维/字典） |
| Assistant.tsx | AI 助手聊天界面（会话/审批卡/工具运行详情） |
| ProductionBoard.tsx / ProductionPipeline.tsx / ProductionAlerts.tsx | 生产 10 阶段泳道看板 / 管线 / 告警 |
| BusinessTools.tsx | 业务工具聚合 |
| WorkflowPanel.tsx / TraceabilityPanel.tsx / AuditHistorySection.tsx | 工作流/追溯/审计面板 |

共享 UI 与基础设施组件（`components/ui/`）：`BdsDialog`、`BottomSheet`、`CapsuleDateInput`、`CustomSelect`、`ToggleSwitch`、`PageHeader`、`DetailPanel`、`UserAvatar`、`UserCombobox`、`SidePanelContainer`、`SpotlightCard`、`MarketIntelligence` 等（BDS 设计系统组件族）。

**全局/横向机制（2026-08-25 核实）**：`CommandPalette`（Cmd/Ctrl+K 唤起，7 类业务实体客户端过滤 + 订单直开详情，App 顶层渲染）；`NotificationCenter`（`apiService.getNotificationStats` 30s 轮询 + `subscribeToNotifications` SSE 增量，带 link 通知点击走 `onOpenLink` 路由）；`AgentLiveStatusBar`（**纯 props 展示组件**，接收 `events: AgentWorkEvent[]`，由父级 SSE 事件流驱动，不自行轮询；空闲/完成不渲染）；`AgentProcessPanel`/`AgentPetWindow`/`AgentMessageCard` 为 Assistant 会话渲染族。

**组件位置注意**：`components/order/RelationCombobox.tsx` 仅为 **re-export 兼容壳**，真实实现在 `components/ui/RelationCombobox.tsx`（改代码改 ui/ 版本）；`components/order/ui/…` 同理。`DesignTuner`（dev 设计调试器）由 App 顶层 `import.meta.env.DEV && showDesignTuner` 条件渲染（`Cmd/Ctrl+Shift+T` 唤起，生产不打包）。

### 5.4 前端服务层（services/）

统一走 [services/apiBase.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/services/apiBase.ts) 的 API 根地址解析（优先级：`VITE_API_BASE_URL` → 设置页 cloudEndpoint → 兜底 `https://jiangsupanda.com/bambook`）。
[services/apiService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/services/apiService.ts) 为通用 HTTP 封装：`buildApiUrl` + `requestJson`（默认 30s 超时），认证头双轨——`getApiKey()`（`X-Bambook-API-Key` SDK Key）与 `jwtAuthHeaders()`（会话 JWT）；对外统一暴露 `apiService` 大对象。

核心服务文件（按域划分）：

| 服务文件 | 对应后端 |
| :--- | :--- |
| apiService.ts | 通用 SDK 封装 |
| authService.ts | /api/auth |
| orderLineService.ts, orderContextService.ts, orderChangeService.ts | /api/v1/orders, /api/v1/order-lines, /api/v1/order-changes |
| financeV2Service.ts, invoiceService.ts, paymentVoucherService.ts, allocationService.ts, fxSettlementService.ts, outwardRemittanceService.ts, vatInvoiceService.ts, reportService.ts | /api/v(1|2)/finance 系 |
| crm 相关（marketService） | /api/v2/crm, /api/v2/marketing |
| shipmentService.ts, orderShipmentBatchService.ts | /api/v1/shipping |
| importService.ts, devOptionsService.ts | /api/v1/import, /api/v1/development |
| emailSyncService.ts, emailOutboxService.ts, emailIntelligenceService.ts | /api/v1/email 系 |
| qcService.ts, creditService.ts, moqService.ts, exceptionService.ts, handoverService.ts, internalTradeService.ts, traceabilityService.ts, knowledgeApiService.ts, llmService.ts, ttsService.ts, assistantSessionService.ts, reportService.ts | 对应 v1 域 |
| deviceDataCache.ts | IndexedDB 本地缓存 |

### 5.5 前端公共库（lib/）

| 文件 | 职责 |
| :--- | :--- |
| entityRegistry.ts | 实体注册与图谱查询基础 |
| rolePermissionMatrix.ts | 角色→权限矩阵（与后端保持同源） |
| modulePermissions.ts | 视图权限策略 |
| orderSchema.ts / orderLineItems.ts / orderConfirmFeedback.ts / orderStatusVisuals.ts | 订单领域纯逻辑（校验/状态视觉/确认反馈） |
| departmentTree.ts | 部门树构造 |
| dateFormat.ts | 日期格式化 |
| useStickyScroll.ts | 粘性滚动 Hook |
| agentBlockStream.ts / agentEventPresentation.ts / agentManifest.ts | Agent 流式响应解析与事件呈现 |
| storage/json-db.ts | JSON 存储 |

**登录态与本地缓存（2026-08-25 核实）**：登录后 token 同时写入 `localStorage` + `sessionStorage`（key：`bambook_auth_token` / `bambook_auth_user`，项目在 [authService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/services/authService.ts)），启动时 `checkAuth()` 恢复会话；注册走邮箱验证码（`/auth/send-code`，purpose=register）+ 审批等待页。IndexedDB 设备缓存 `BambookDeviceDataCache` v3，实体 store 共 **9 类**（orders/relations/products/productCategories/pdmlRawFabrics/invoices/paymentVouchers/shipments/developmentCases），`dataHubService.pullSnapshot` 聚合 10 数据源 → `applyDataHubSnapshot` 过滤 `deletedAt` 后持久化；`storageService` 统一 localStorage key 分类（account/config/personalization/email-cache/business-cache）。

### 5.6 设计系统与样式

- **权威 token 源**：[styles/os-vnext.css](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/styles/os-vnext.css)（320 个 CSS 变量）。
- **实际渲染准源**：`styles/flat-experimental.css`（flat 设计：无阴影/无 rim/大圆角 22–34px/半透明磨砂膜 blur+saturate）。
- **加载链（index.css）**：`os-vnext.css`（权威 token 源）→ `flat-experimental.css`（flat 覆盖层）→ BDS token/component/layout（`index.tsx` 显式再引 flat-experimental）；`styles/design-system.css` **已退役**（不再作为运行时载体）。Tailwind `darkMode: 'class'`。
- **BDS 组件规范**：[docs/design-system](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/design-system/README.md)（tokens.md、material-grammar.md、layout-grammar.md、governance.md 等）。
- [components/ui/bambookOsTokens.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/ui/bambookOsTokens.ts)（`BAMBOOK_OS`，light/dark 双写已坍缩为自适应 + `dark:` variant）/ `osVNext.ts`（`OS_VNEXT` cssVars 明暗主题）/ `osMaterial.ts`（Material role：framePanel/raisedCard/insetSurface/floatingOverlay）/ `osAdaptiveContrast.ts` / `relationsFormStyles.ts`（组合 BAMBOOK_OS + OS_MATERIAL 的表单样式）。
- **Tailwind 语义类**（[tailwind.config.js](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/tailwind.config.js)）：`rounded-panel/card/card-lg/inset/floating/control/field/compact`；`bg-deep/text-link/border-action` 等。
- **防回退**：`scripts/check-design-tokens.sh` 基线系列（`BASELINE_ROUNDED / BRACKET_HEX / BARE_RADIUS / FONT_WEIGHT / DARK_VARIANT / IS_DARK_TERNARY` 等计数，只减不增）+ `scripts/os-vnext-audit.mjs`（扫 OSPrimitives/osVNext 等文件的 arbitrary/hex/rgba 回归，`os-vnext-audit-baseline.json` 含已删 compiled 模板的**历史基线条目**，无害）。
- 字体：urbanist（@fontsource，打包进项目）、Inter、harmonyos-sans-sc（拆分字体）。

### 5.7 Electron 主进程与预加载

- [electron/main.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/electron/main.ts)：
  - BrowserWindow 创建与 macOS 生命周期；
  - **本地 STT**：`loadSherpaOnnx()` 加载 `models/stt/paraformer-zh-en-int8` 模型（encoder/decoder/tokens），在线语音识别（`localSttSessions` Map）。模型文件**存在但被 .gitignore 排除**（`.onnx/.bin/gguf/safetensors`、`models/stt/`），不随 Git 分发，需按 `models/stt/paraformer-zh-en-int8/README.md` 单独放置；electron-builder 通过 `extraResources` 将其打进 dmg（`models/ggml-tiny.bin`/`ggml-small.bin` 亦在工作区）；
  - **离线 fallback**：客户端探活失败时 `startEmbeddedServer()` 以 `npx ts-node` 启动 `server/src/index.ts`（固定 `PORT=8081`、`NODE_ENV=production`），再经 `/api/health` 探测连通（**非"只读 Express"，而是本地完整后端兜底**，连本机开发库）；
  - IPC：窗口控制、Agent 状态、原生通知（`ipcMain.handle`）。
- [electron/preload.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/electron/preload.ts)：`contextBridge` 暴露只读版本信息、窗口控制、PDF 保存、`bambookNotification`、`bambookLocalSTT`。
- electron-vite 三入口（[electron.vite.config.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/electron.vite.config.ts)）：main→`out/main/main.js`、preload→`out/preload/preload.js`（均 CJS，嵌套 package.json 标记 `type:commonjs`）、renderer 复用 `vite.config.ts` → `out/renderer`（`base:'./'`、端口 3000 / UI Lab 3100、HMR 显式配置）。

### 5.8 PWA / 移动端

- [pwa/deviceMode.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/pwa/deviceMode.ts)：设备模式判定（桌面/移动）。
- `pwa/mobile/MobileWebApp.tsx`、`MobileWebNavigation.tsx`：移动端壳与导航。
- `pwa/pageZoomGuard.ts`：页面缩放保护。

---

## 6. 后端架构（Express + Prisma）

后端为独立工程 `server/`，TypeScript + ts-node 运行。

### 6.1 服务启动与中间件

入口：[server/src/index.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/index.ts)

- 环境变量加载（`.env.local`，含 `DATABASE_URL`、`JWT_SECRET`、`BAMBOOK_SDK_KEY`、`BAMBOOK_AGENT_API_KEY_ACTOR_ID`、`BAMBOOK_MODEL_BASE_URL`、`BAMBOOK_TTS_PROVIDER` 等，模板见 `server/.env.example`）；
- **端口**：`const PORT = process.env.PORT || 8081`（`server/src/index.ts:248`），`app.listen(PORT)` 启动；
- 全局中间件：CORS → JSON/raw → account-status guard → request timing → `/bambook` 前缀剥离（Cloudflare Tunnel 入口）；SDK 认证中间件 `sdkAuth`（API Key）；
- 序列化：`BigInt` / `Prisma.Decimal` → JSON number；
- `GET /api/health`：健康检查（含数据库连通性与 TTS 预热状态）；
- `publishDataChange`（dirtyCacheService）：数据变更发布（SSE/脏缓存标记）；
- 静态托管：`/api/app`（webapp SPA + fallback，`BAMBOOK_WEBAPP_DIR`）、`/api/uploads`（上传目录 `UPLOAD_DIR`，默认 `server/uploads`）；
- AI 运行时路由：`/api/ai`（createAiRouter，AI 会话/流式/指标）；
- SSE 实时通道：`GET /api/v1/events`（EventSource + sdkAuth，`addRealtimeClient`）——`publishDataChange`（dirtyCacheService）推送数据变更；
- 启动时注册：Agent 工具、事件联动（`registerAllLinkages`）、通知绑定、业务流水号（BusinessSequence）。
- 数据源：`server/src/dataSource.ts`。

### 6.2 路由注册总览

`index.ts` 中集中 `app.use(...)` 挂载，模式统一为 `createXxxRouter({ prisma, requireAuth, apiKeys, onDataChange, uploadDir? })`。主要分组：

| 前缀 | 模块 |
| :--- | :--- |
| /api/auth | 认证（登录/注册/验证码/邮箱验证）[auth/] |
| /api/admin | 系统管理路由 |
| /api/hr | 人事（员工/考勤/薪酬/绩效/培训） |
| /api/agent | Agent 会话/运行/审批/表单/工具运行/MCP manifest+run（§7） |
| /api/v1/approvals, /api/v1/approvals-kernel | 业务审批中心 + 审批内核（委派/BOSS 兜底） |
| /api/v1/import | PDF 订单导入（multipart，parse-only） |
| /api/v1/orders, /api/v2/orders, /api/v1/order-lines, /api/v1/order-changes | 订单/订单行/订单变更 |
| /api/v1/relations, /api/v2/relations | 关系智库（客户/联系人/信用） |
| /api/v1/products, /api/v1/lookbooks, /api/v1/fabric-recommendations | 数字档案/电子画册/面料推荐 |
| /api/v1/development, /api/v1/samples | 开发管理/样品 |
| /api/v1/finance, /api/v2/finance | 财务（发票/凭证/核销/催款/汇兑/退税） |
| /api/v1/reports | 报表引擎（数据集白名单） |
| /api/v1/shipping, /api/v2/trace | 出运 + 追溯 |
| /api/v1/dashboard, /api/v1/production, /api/v2/production | 看板 + 生产 |
| /api/v1/quotations | 报价 |
| /api/v1/moq | MOQ 阈值与校验 |
| /api/v1/exceptions, /api/v1/credit, /api/v1/internal-trade, /api/v1/payment-requests | 受控例外/信用/内部交易/付款申请 |
| /api/v1/audit | 实体级审计查询 |
| /api/v1/procurement, /api/v1/inventory, /api/v1/bom | 采购/库存/BOM |
| /api/v1/crm, /api/v2/crm, /api/v2/marketing | CRM + 营销 |
| /api/v1/mes | 生产执行 |
| /api/v1/suppliers, /api/v2/suppliers | 供应商 |
| /api/v1/data-migration | 历史数据迁移 |
| /api/v1/seasons, /api/v2/seasons | 季节/趋势 |
| /api/v1/risk | 风险预警 |
| /api/v1/business-lines | 业务线 |
| /api/v1/qc | QC 工作台 |
| /api/v1/pricing | 成本定价（退税率/利润表/原料价格） |
| /api/v1/customs, /api/v2/customs, /api/v1/document-templates, /api/v1/templates | 报关 + 单据模板 |
| /api/v1/system-assets, /api/v1/pdml, /api/v1/entities | 系统资源/PDML/实体图谱 |
| /api/v1/business-profiles | 企业档案 |
| /api/v1/notifications, /api/v1/config（系统配置）, /api/v1/automation, /api/v1/workflow（工作流引擎） | 通知/系统配置/自动化/工作流 |
| /api/v1/email, /api/v1/email-templates, /api/v1/email-signatures, /api/email（legacy 兼容） | 邮件（同步/模板/签名，legacy IMAP proxy） |
| /api/v1/finance 内子路径 | `/vouchers` `/allocations` `/fx-settlements` `/outward-remittances` `/vat-invoices` `/dunning` `/reports/{aging|statement|cash-calendar|fx-gain-loss|consolidated-profit}`；v2 另含 `/quotations/:id/apply-pricing` `/invoices/:id/convert-to-receivable` 等 |
| /api/v1/inventory 内子路径 | `/warehouses` `/items` `/movements` `/alerts/low-stock`（无独立前缀） |
| /api/v1/knowledge, /api/v1/knowledge-documents | 知识库（文档 CRUD/SOP/图谱，`knowledge-documents` 为文档管理独立路由） |
| /api/v2/handover | 离职一键交接 |
| /api/v1/tools/fabric-calculator | 面料计算器（纯函数） |
| /api/v1/data-dictionary | 数据字典 |

**非路由工厂的直挂端点（`index.ts` 中直接 `app.get/post` 定义，真实存在）**：

| 端点 | 说明 |
| :--- | :--- |
| `GET /api/search` | DuckDuckGo HTML 版搜索代理（切源/限 8 条/模拟浏览器 UA，15s 超时） |
| `GET /api/fetch-url` | CORS 绕过 URL 内容代理 |
| `GET /api/market/cotton` / `GET /api/market/wool` | 大宗商品行情代理（Yahoo Finance：棉花期货 CT=F / 羊毛 EMI，含估算兜底） |
| `GET /api/v1/events` | SSE 实时事件订阅（sdkAuth） |
| `POST /api/shipping-notice/generate` / `GET /api/shipping-notice/download` | 装运通知（Shipping Notice）生成与下载（合同结构化参数） |
| `POST /api/orders/search` | 订单搜索（legacy sdkAuth） |
| `app.all('/api/orders' …)` | **Legacy sync 直挂**（handleSync upsert 双写 + publishDataChange）：`/api/dev-memory`、`/api/orders`、`/api/knowledge`、`/api/relations`、`/api/products`、`/api/product-categories`、`/api/insights` |
| ~~/api/sdk/*~~ | **已删除**（index.ts:1640 `[DELETED]`），无前端调用方 |

### 6.3 数据模型（197 个 Prisma Model）

[schema.prisma](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/prisma/schema.prisma) 共 **197 个 Model**，按业务域分组：

| 域 | 代表模型 |
| :--- | :--- |
| 底座/账号 | `UserAccount`、`Department`、`Role`、`UserRole`、`Permission`、`RolePermission`、`AgentPolicy`、`UserPermissionOverrides`、`BusinessSequence`、`SequenceRegister`、`VoidedNumber`、`SystemConfig`(+History)、`DataDictionary`(+History) |
| Agent | `AgentSession`、`AgentMessage`、`AgentMemory`、`AgentTool`、`AgentToolPermission`、`AgentToolRun`、`AgentCommitReceipt`、`AgentJob`、`AgentSuggestion`、`AgentCheckpoint`、`ApprovalRequest` |
| 关系/客户 | `Relation`、`Contact`、`CreditLimit`(+History)、`FollowUpRecord`、`Opportunity`、`CustomerTier`、`BrandLine`、`CommunicationLog` |
| 产品档案 | `ProductAsset`、`FabricProfile`、`GarmentProfile`、`TrimmingProfile`、`ProductClassification`(+Link)、`FabricCompositionLine`、`FabricCustomerCode`、`FabricPriceHistory`、`FabricCertification`、`PdmlRawFabric`、`ProductImage`、`MaterialCompositionTerm` |
| 订单/生产 | `Order`、`OrderLine`、`OrderStatusTransition`、`ProductionStage`、`PreCutChecklist`、`WorkStation`、`ProductionPlan`、`WorkHour`、`PieceRateRule`(+Record)、`OutsourcingOrder`(+Line)、`OrderProcessNode`、`OrderChangeRequest`、`OrderInternalTransfer`、`InspectionReport`、`TestRequest`(+ReportFile/CorrectiveAction)、`FabricShipmentSample`、`SampleColorBatch`、`ColorCard`、`EarlyProductionSample`、`FactoryDelayRecord` |
| 开发/样品 | `DevelopmentCase`、`SampleNode`、`SampleCardItem`、`SampleCardLoan`、`TechPack`(见 order/orders) |
| 报价/成本 | `Quotation`(+Version/Line)、`CostEstimate`、`PricingCalculation`、`OrderProfitSheet`、`MaterialPriceHistory`、`CommissionRule`、`MoqThresholdConfig`(+History) |
| 采购/库存 | `PurchaseOrder`(+Line)、`MaterialReceipt`、`MaterialReturn`、`SupplierInquiry`、`Warehouse`、`InventoryItem`、`StockMovement`、`BOM`(+Line) |
| 出运/报关 | `Shipment`(+Line/OrderAllocation/Carton/CartonItem/Event)、`OrderShipmentBatch`、`CustomsDeclaration`(+Line)、`HsCode`、`LetterOfCredit`(+Event)、`TaxRefund`、`TradeDocument`、`DocumentTemplate`(+Version) |
| 财务 | `Invoice`、`InvoiceOrderAllocation`、`InvoiceAllocation`、`PaymentVoucher`、`PaymentRequest`、`FxSettlement`、`FxRateLock`、`OutwardRemittance`、`VatInvoice`、`DunningRecord`(+Profile)、`TaxRefundRate`、`BankruptcyProceeding`(+Action) |
| 供应商/工厂 | `FactoryProfile`、`FactoryEvaluation`、`FactoryCertification`、`FactoryCapacity`、`TcCertificate` |
| 营销/季节 | `MarketingCampaign`、`MarketingLead`、`Season`、`TrendTag`(+Fabric)、`TradeShow`(+Lead)、`LookbookCatalog`、`FabricRecommendation` |
| 知识/审计 | `KnowledgeItem`、`KnowledgeDocument`(+Chunk/Relation/Acl)、`SopTemplate`、`EntityLink`、`EntityReference`、`EntityAlias`、`AuditLog`、`Notification`(+Template/Preference)、`RenderedDoc`、`ImportBatch`、`HandoverRecord`、`DirtyCacheMarker` |
| 项目管理 | `Project`(+Member)、`Team`(+Member/DataGrant)、`WorkAssignment`、`JobPosition`、`EmployeeProfile`、`EmploymentEvent`、`AttendanceRecord`、`LeaveRequest`、`SalaryStructure`、`PayrollRun`(+Item)、`PerformanceCycle`(+Review)、`TrainingCourse`(+Enrollment) |

**v0.8 两条验收主链的数据模型穿透（schema 字段级核实，2026-08-25）**：

| 主链环节 | 字段/关系（schema.prisma） |
| :--- | :--- |
| 客户→订单 | `Relation`(contacts/opportunities/creditLimits) ← `Order.customerRelationId`；`OrderLine.orderId`（materialCode/styleNo） |
| 报价→订单 | `Quotation(+Version/Line)`，`QuotationLine` 快照；订单侧 `Order.quotationId?` 承接 |
| 订单→采购 | `PurchaseOrder.orderId?`（关联销售订单）+ `quotationId?` / `bomId?`；`PurchaseLine.purchaseOrderId` |
| 采购→入库 | `MaterialReceipt.purchaseOrderId` → `StockMovement` / `InventoryItem` |
| 出运 | `ShipmentOrderAllocation{shipmentId, orderId, orderLineId}`（物理票视角）；`OrderShipmentBatch{orderId, shipmentId}`（订单批次/结算视角）；`ShipmentLine/Carton.shipmentId` |
| 财务 | `Invoice.orderId?`(aboutOrder)；`InvoiceOrderAllocation{invoiceId, orderId, poNumber}`（多订单分配）；`PaymentVoucher.invoiceId?/orderId?`（核销）；`FxSettlement/OutwardRemittance/VatInvoice.orderId?` |
| 质检 | `InspectionReport.orderId? + shipmentId?`（终期验货对应出运批次）；`TestRequest.orderId`（挂订单全类型）；`PreCutChecklist.orderId @unique` |
| 单据/报关 | `TradeDocument` ↔ `CustomsDeclaration`；`DocumentTemplate(+Version)` |
| 开发/样品 | `SampleNode.developmentCaseId`；`FabricShipmentSample/EarlyProductionSample` 走 `qcChainService` 关联 |
| 受控例外 | `Dr013ExceptionRequest.orderId`（挂订单全类型）+ `exceptionGate` 门禁 |
| BOM/成本 | `BOM(+BOMLine)`；`PurchaseOrder.bomId?`；`CostEstimate` / `OrderProfitSheet` 成本口径 |

> 结论：主链 A/B 的 14 环节在数据模型层已全部接通（字段级核实），无断链模型。

### 6.4 认证与权限体系

- [server/src/auth/](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/auth)：
  - `middleware.ts`：导出 `requireAuth` / `optionalAuth` / `requireRole` / `extractActorFromRequest`；JWT 从 `Authorization: Bearer` 或 cookie 解析；
  - `permissionGuard.ts` / `permissionService.ts`：`requirePermission(...)` 权限点（scope）判定，支持用户级覆盖（`UserPermissionOverrides`）；**写/审批类 scope 强制要求 JWT，API Key 不可**（否则 403 `INSUFFICIENT_SCOPE`）；
  - `moduleGuard.ts`：模块级读权限门禁；
  - `accountStatusGuard.ts`：账号状态（禁用等）拦截；
  - `email.ts` / `verification.ts`：邮箱验证。
- **双轨认证**：JWT（人类用户）+ API Key（`BAMBOOK_SDK_KEY`，机器集成，`x-bambook-api-key` 头或 `query.apiKey`），由 `SDK_CONFIG.requireAuth`（`BAMBOOK_REQUIRE_AUTH`/production 强制）控制开关。
- **角色**：RBAC 种子（Ops `/api/admin/seed-rbac` 直写）内置 **8 角色**（`role_owner / role_admin / role_manager / role_merchandiser / role_sales / role_finance / role_agent_operator / role_viewer`）与 **28 权限点**（`users:read/write/delete`、`orders:read/write/delete`、`products:*`、`relations:*`、`knowledge:read/write/admin`、`tools:execute/admin`、`finance:*`、`ai:chat/agent`、`emails:*`、`settings:*`、`audit:read`、`approvals:read/write` 等）；无角色活跃用户自动赋 `viewer`；API Key 调用方由 `BAMBOOK_AGENT_API_KEY_ACTOR_ID` 指定 actor 身份（详见 [ops-panel/index.ts seedRbacDirect](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/ops-panel/src/index.ts)）。
- 前端侧角色矩阵：[lib/rolePermissionMatrix.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/lib/rolePermissionMatrix.ts)（与后端同源）。

### 6.5 事件驱动与跨模块联动（L1–L10）

[events/linkages/index.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/events/linkages/index.ts) 注册到 `businessEventBus`，**联动失败不阻断业务（fire-and-forget）+ 幂等（processedKeys）**：

| 联动 | 触发事件 → 动作 |
| :--- | :--- |
| L1 | OrderConfirmed → initProductionStages（初始化生产管线） |
| L2 | ProductionCompleted → createShipmentDraft（发货草稿） |
| L3 | ShipmentCompleted → createInvoiceDraft（应收发票草稿） |
| L5 | PaymentVoucherCreated → autoAllocate（自动核销） |
| L6 | OrderConfirmed → createBOMDraft（从模板复制 BOM） |
| L7 | BOMConfirmed → createProcurement（采购需求草稿） |
| L8 | MaterialReceived → autoStockIn（自动入库） |
| L9 | QuotationAccepted → convertToOrderDraft（转订单草稿） |
| L10 | CustomsCleared → createTaxRefundDraft（退税核算草稿） |

- `events/businessEventBus.ts`：领域事件总线（发布/订阅，幂等去重）。
- `events/dirtyCacheService.ts`：脏缓存标记 + SSE 数据变更推送（`publishDataChange`）。

### 6.6 关键业务模块说明

| 模块目录 | 职责与关键文件 |
| :--- | :--- |
| auth/ | 认证/权限（见 §6.4） |
| orders/ | `orderServiceV2.ts`、`query.ts`、`orderLifecycleService.ts`、`orderLineMutationService.ts`、`orderLineWritable.ts` — 订单 CRUD/状态机/订单行写 |
| orderChanges/ | `orderChangeRequestService.ts` — 变更/取消/暂停审批链（DR-010） |
| finance/ | `financeServiceV2.ts`、`invoiceMutationService.ts`、`allocationService.ts`、`fxSettlementService.ts`、`outwardRemittanceService.ts`、`vatInvoiceService.ts`、`dunningService.ts`、`reportService.ts` — 发票/核销/汇兑/催款 |
| crm/ | `crmService.ts`、`brandLineService.ts` — 客户/营销 |
| relations/（通过关系路由） | 关系智库（客户/联系人/信用额度占用） |
| products/（通过产品路由） | 数字档案（面料/成衣/辅料） |
| development/ | `convertService.ts`、`sampleNodeService.ts`、`developmentCaseMutationService.ts` |
| customs/ | `customsService.ts`、`compositeDocumentService.ts`、`tradeDocumentLifecycleService.ts`、`documentTemplateService.ts` |
| mes/ | `mesService.ts`、`processChainService.ts` — 工艺链/工站 |
| moq/ | `moqConfigService.ts`、`moqValidationService.ts`、`moqResolutionService.ts` — MOQ 软校验 |
| credit/ | `creditService.ts`、`bankruptcyService.ts` — 信用冻结/解冻/占用 + 破产预警 |
| email/ | `emailSyncService.ts`、`emailClassificationService.ts`、`outboxSend.ts`、`aiExtract.ts`、`emailFollowUpService.ts`、`emailLinkService.ts` |
| import/ | `parseOrderPdf.ts`、`persistOrders.ts`、`detectCustomer.ts`、`extractText.ts`、`registry.ts`、parsers/peerless.ts — PDF 订单导入 |
| approvals/ | `approvalCreateService.ts`、`approvalRoutingService.ts`、`approvalKernelRoute.ts` |
| exceptions/ | `exceptionGate.ts`、`exceptionService.ts` — 受控例外（DR-013） |
| internalTrade/ | `internalTransferService.ts` — 内部交易（DR-005/033） |
| handover/ | `handoverService.ts` — 离职一键交接（DR-056） |
| entities/ | `registry.ts`、`sync.ts`、`search.ts`、`subEntityKeys.ts` — 实体图谱双写同步 |
| audit/ | `auditService.ts`、`createAuditMiddleware.ts` — 全写入审计 |
| notifications/ | `notificationService.ts`、`notificationTemplateEngine.ts`、`eventBindings.ts` |
| dashboard/ | `dashboardService.ts` |
| briefing/ | `briefingService.ts` |
| dictionaries/ | `dataDictionaryService.ts` |
| marketing/ | `marketingService.ts`、`marketingRouteV2.ts` |
| migration/ | `dataMigrationService.ts` |
| admin/ | 系统管理/审计日志/运维动作 |
| businessLines/ | `businessLineService.ts` |
| bom/ | `bomPluginEngine.ts`、`bomService.ts` |
| knowledge/ | `knowledgeGraphService.ts`、`sopTemplateService.ts` |
| hr/ | `hrService.ts` |
| config/ | `systemConfigService.ts`、`automationConfig.ts` |
| _shared/ | `rolePermissionMatrix.ts`、`_typesView.ts` |

**四条核心管线速览（2026-08-25 源码级核实）**：

| 管线 | 机制 |
| :--- | :--- |
| **邮件**（email/） | IMAP 同步（imap-simple，INBOX，`limit=100`/批，按 `messageId` 去重）→ 分类（`emailClassificationService`：规则层关键词 + AI 增强层合并，只增不删、保留人工标签）→ AI 抽取（`aiExtract`：intent/products/quantities/prices/deadlines/poNumbers，ARK json_mode，结果写回 `aiExtractedJson`）→ 自动关联（`emailLinkService`：inbound 用 fromAddress / outbound 用 toAddress 匹配 relation；subject/snippet 含 PO 号匹配订单，已有引用不覆盖）+ 批量回填 → 跟进（`emailFollowUpService`：complaint/urgent 自动建 FollowUpRecord）→ 发送（`outboxSend.ts`：nodemailer SMTP，成功写 `Sent/sentAt/messageId`，失败保持 Outbox） |
| **PDF 订单导入**（import/） | `parseOrderPdf`：extractPdfText → `detectCustomer`（公司名/税号/联系人/PO 正则加权计分，现规则主要匹配 peerless）→ `parsersByCustomer` 分派（`parsers/peerless.ts` 解析 PO/联系人/币种/交期/付款/行明细）→ `persistOrders` 按 `poNumber` upsert（`orderLine` 按 `orderId_itemNo` upsert + 删除 PDF 中已移除的旧行）；解析失败返回 `error` 字段不抛错 |
| **审批中心**（approvals/） | `approvalCreateService` 建 `ApprovalRequest`（快照 payload + reviewerId）→ `approvalRoutingService` 路由：`DEPT_HEAD → FALLBACK_DEPT_HEAD_VACANT → FALLBACK_SELF_APPLY_SUPERVISOR → FALLBACK_ADMIN`；`/api/v1/approvals` 待办/已办（**排除 agent/tool 审批**）；`POST /:id/decide` 禁止重复决策与自审；`approvals-kernel`（委派/BOSS 兜底/只读审计解析） |
| **通知与例外** | 通知：`notificationTemplateEngine` 变量渲染（`{poNumber}/{customerName}/{orderId}`）→ `eventBindings` 订阅 OrderCreated/OrderConfirmed/ShipmentCreated 等业务事件触发；例外（exceptions/）：`exceptionGate` DR-013 门禁（正常资格放行 / `passedVia='exception'` / 无例外抛 `GateBlockedError`），例外审批链 `actionType='order:dr013-exception'` + `validUntil/maxUses` 生效约束 |
| **报表引擎**（reporting/） | `ReportDefinition` 只存 `datasetKey` + 字段名；`reportEngine` 运行时按**数据集白名单**校验维度/指标/过滤字段与操作符（防客户端注入任意表）；端点 `GET /datasets` `GET|POST|PATCH /definitions` `POST /preview` `POST /drill` `POST /definitions/:id/run` `GET /runs`；`runReport` 幂等键去重 + 快照行列 |
| **单证模板渲染**（templates/ + customs/） | `DocumentTemplate`（CI/PL/CO/BL/INS/InspectionCert 等类型 + Version）创建时 `extractTemplateVariables(content)` 自动提取变量集；渲染纯函数 `data→html` → `saveRenderedDoc` 落库（`X-Rendered-Doc-Id`）；`render-pdf` 生成 A4 PDF（`pdfSha`/`pdfPath`）；服务端模板注册表 `renderServerDocument`；贸易单据编号前缀 CI/PL/CO/BL/INS/IR/Contract；Agent `template.render/render_pdf` 复用同一管线 |

### 6.7 AI 基础设施（LLM / TTS / 知识库）

- [server/src/ai/](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/ai)（挂载 `/api/ai`，端点：`GET /metrics`、`POST /chat`、`POST /tts/speech`）：
  - `llmProviders.ts`：**自研 LLM Provider 链**（原生 fetch，无 openai/ai-sdk 依赖）。默认 `https://ark.cn-beijing.volces.com/api/coding/v3` + `ark-code-latest`；key 链 `ARK_API_KEY → VOLCENGINE_API_KEY → TENCENT_API_KEY → ZHIPU_API_KEY`；备用 provider 由 `BAMBOOK_LLM_BACKUP_URL/KEY/MODEL`、`BAMBOOK_LLM_BACKUP2_*` 声明式配置；**请求级失败转移**（网络错误/非 2xx/流中断切换到下一 provider；AbortError 不转移）；**流式优先、失败降级非流式**，SSE `data:` 解析 `choices[0].delta.content` 走 `onDelta` 增量；全链失败抛 `LLM_ALL_PROVIDERS_FAILED`；
  - `runner.ts`：Agent 工具 surface 与调用契约（`AGENT_LOOP_TOOL_DESCRIPTORS` 白名单：memory/products/orders/relations/finance/knowledge.search…）；
  - `runtime.ts`：AI 运行时（Semaphore 并发控制三 lane：model/search/heavy，对应 `BAMBOOK_AI_MODEL_CONCURRENCY` 等 env；按 sessionId 活跃会话/超时/abort；`getMetrics()`）；
  - `tts.ts`：TTS 服务与**进程级熔断器**（失败计数→open→冷却半开重试→成功关闭，避免反复超时等待）；`BAMBOOK_TTS_PROVIDER=melo`（默认，Melo HTTP :8765 `synthesizeMeloWithService` + `prewarmMeloTts`）或 edge_tts / sensevoice；
  - `volcKnowledge.ts`：火山知识库 API 封装。
- `server/knowledge_api/`：Python FastAPI 服务（文档向量化嵌入/检索，`BAMBOOK_KNOWLEDGE_BASE_URL` 默认 `http://127.0.0.1:8800`），由后端 `knowledgeApiService` 调用；支持 RAG 直连（`BAMBOOK_RAG_*`）双通道。
- 语音伴生服务（Python）：`melo_tts_service.py`（默认链）、`edge_tts_server.py`、`sensevoice_server.py`。

---

## 7. Agent 运行时

> **v0.8 交付口径提示**：按 [MILESTONE_v0.8.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/MILESTONE_v0.8.md) 约定，**AI Agent 原生接入（智能体对话/自动规划/MCP 智能调用/Agent 中栏渲染）在 v0.8 仅做占位与入口保留，不做真实能力验收**，推进目标为 2026 年 9 月后一阶段。本章描述的是仓库内**已实现的 Agent 运行时真实代码**（供继续开发与评估使用），不代表 v0.8 交付范围。

后端核心差异化能力，位于 [server/src/agent/](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent)。

### 7.1 ReAct 主循环

- [agentLoop.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/agentLoop.ts)：多步 ReAct 循环。
  - 初始化 scratchpad / iterations / checkpoint resume（支持崩溃恢复）；
  - 每步：LLM 决策 → 解析 `final_answer` 或工具调用 → `call_tool` 分支（去重、超时、**审批拦截**、checkpoint 保存 pending approval、等待审批结果）；
  - 终止条件：`stopReason`、`maxSteps`、`totalBudgetMs` 超时。
- [agentLoopTypes.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/agentLoopTypes.ts)：`LLMTurnResult`、`PlannedLLMToolCall`、`ToolDescriptor`、`ToolExecutionRecord`、`Scratchpad`、`IterationTrace`、`AgentLoopConfig`。
- [defaults.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/defaults.ts)：`AGENT_LOOP_LIMITS`（maxSteps / maxToolsPerStep / perToolTimeoutMs / totalBudgetMs / llmRepairRetries / 字符预算）。
- [llmPlanner.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/llmPlanner.ts)：系统提示词构造 + 对话消息序列化（history/attachments/scratchpad 合并）。
- [runtime.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/runtime.ts)：运行上下文解析（actor、session、历史、run state）。
- [orchestrator.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/orchestrator.ts)：旧版单轮编排路径（identity → planning/retrieval → assessment/policy → final answer）。
- [loopController.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/loopController.ts)：循环控制器（并发放/配额）。
- [jobs.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/jobs.ts)：后台作业持久化。
- [checkpoint.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/checkpoint.ts)：`AgentCheckpoint` 保存/加载/清理。
- [commitTransaction.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/commitTransaction.ts)：审批通过后的 Prisma 事务提交入口。

### 7.2 工具注册表与审批策略

- [toolRegistry.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/toolRegistry.ts)：
  - `ToolDefinition`：散集 ToolDescriptor 的超集，含 `inputSchema/outputSchema`（JSON Schema）、`approvalPolicy`（`never | auto | always`）、`risk`（`low|medium|high`）、`processSpec`；
  - `ProcessDraft`（六字段必填）：`subOperations`、`beforeAfterDiff`、`impactScope`、`irreversible`、`postCommitHooks`、`idempotencyKey`；
  - `ProcessSpec`：draft 阶段 → 审批卡 → commit 事务 → postCommitHooks（queue_retry）→ 部分失败策略（abort_no_approval / rollback / queue_retry）；
  - `P0B_TOOL_DEFINITIONS`：四切片示例（products.search / knowledge.ingest / orders.update_status / order.confirm）。
- [toolRuntime.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/toolRuntime.ts)：工具实际执行运行时。
- [toolDispatchRegistry.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/toolDispatchRegistry.ts)：工具 ID → 执行器分发；`registerTool/getToolHandler/getRegisteredToolIds` + **`registerCommitTool`**（复合流程 commit 工具统一走审批 boilerplate，idempotencyKey = `commit:{toolId}:{approvalId}` 去重）。
- [commitTransaction.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/commitTransaction.ts) + flow 内 `verify*DraftHash`：审批后从 payload **恢复 ProcessDraft**（`recoverProcessDraftFromPayload`）、**重算 hash 比对**（`verifyProcessDraftHash`）、事务内提交 + 写 outbox email + 审计；hash/idempotencyKey 为防篡改不变量。
- 真实注册点：`toolRuntime.ts`（~L3063+）调用 `registerOrderChangesFlowTools / registerQuotationFlowTools` 等批注册 Phase 2 写工具 flow，`knowledge.ingest` 等走 `registerCommitTool`。
- [newDomainQueryTools.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/newDomainQueryTools.ts)：新域只读查询工具（MOQ/变更单/样品/QC/例外/信用/内部交易/付款申请/采购/BOM/退税/报关/核销分配等 16+ 工具）。
- [tools.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/tools.ts)：旧 ToolRegistry（register/run/getRuns/stats）。
- [agent/route.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/route.ts) 暴露端点：
  - `GET /status`、`GET/POST /sessions`、`GET/POST /sessions/:id/messages`、`PATCH/DELETE /sessions/:id`
  - `GET /tool-runs/:id`
  - `POST /approvals/:id/resolve`（owner/admin/manager）
  - `POST /forms/:id/submit`
  - `GET /mcp/manifest`、`POST /mcp/run`

### 7.3 MCP 协议层

- [mcp/manifest.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/mcp/manifest.ts)：工具能力清单（源码 111 个 seed 条目），含 `READ_ONLY_SAFETY` 只读安全策略；前端发现同源协议。
- [mcp/executor.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/mcp/executor.ts)：MCP 2.0 执行路径——`AgentPlan.steps` → `PlannedToolCall`（≤6 步）→ `runAgentToolCalls`。
- [mcp/types.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/mcp/types.ts)：协议类型。

### 7.2.1 审批策略分布（2026-08-25 源码统计）

**双体系并存（决策仲裁规则）**：

| 体系 | 字段 | 取值 | 优先级 |
| :--- | :--- | :--- | :--- |
| P0-B 工具注册表 | `ToolDefinition.approvalPolicy` | `never` / `auto` / `always` | **优先**（`resolveApprovalDecision` 先查） |
| MCP manifest（旧） | `ToolManifestSafety.approval` | `never` / `risk_based` / `always` | 未注册工具回退（fail-closed） |

`evaluateApprovalPolicy(policy, risk)` 语义（toolRegistry.ts:992）：
- `never` → 不审批、不审计；
- `auto` → low 放行（不审计）/ medium 放行+审计 / **high 升级为审批+审计**；
- `always` → 必审批+审计。

**manifest 分布（源码计数）**：
- `approval: 'always'` × **62** —— 全部写操作/流程工具（draft→approval→commit）；
- `approval: 'never'` × **2** —— `READ_ONLY_SAFETY` 定义 + `memory.*` 记忆写入（记忆不审批）；
- `READ_ONLY_SAFETY` 引用 × **26** —— 全部只读查询工具（*.query/get/list/search/expand/hydrate/manifest 等）；
- 未注册工具 **fail-closed 默认 `{approval:'always', sideEffects:true}`**。

**写工具（always，按域）**：关系 `relation.update/delete/onboard`、`relations.create`；知识/开发 `knowledge.ingest`、`development.create/update_stage/convert_to_order`、`product_asset.create/update/delete`；订单 `orders.update_status/batch_status`、`order.line_update/status_transition/delete`、`order.confirm`、`order.ship`、`order_changes.create/withdraw`；财务 `invoice.issue/cancel/delete`、`finance.create_invoice/create_voucher/apply_voucher_to_invoice`、`payment_voucher.create/update/delete`、`payment.receive_and_reconcile`、`statement.send`、`payment_requests.create/cancel`、`credit.freeze/thaw`；物流 `shipping.create_shipment/update_tracking_status`；邮件 `email.send/reply_and_send/sync`；样品/QC `samples.create_round/submit_to_customer/register_customer_confirmation`、`qc.review_garment_sample/review_fabric_sample/sign_report`；交易/采购/库存 `internal_trade.create/confirm`、`procurement.create/update_status`、`inventory.adjust_stock`、`quotation.create/update`、`customs.register_lc/update_declaration`、`garment.update_size_breakdown/update_production_steps`。

**三层拦截判据**（toolRuntime 执行路径）：
1. `policy.requiresApproval`（actor 角色 × 风险矩阵）；2. `manifest.approval === 'always'`（写动作强制）；3. `manifest.approval === 'risk_based'` 且 risk ∈ {high, critical}。

**拦截→审批→commit 闭环**：拦截后走 `ApprovalRequestCreateService` 落库审批卡（含 risk / editableFields / 完整 ProcessDraft 快照）→ `runAgentToolCalls` emit `blocked + approval block` 等人工决策（`POST /approvals/:id/resolve`，owner/admin/manager 角色）→ 下一轮 Agent 调用以 `approvalId` 恢复执行 → **commit 工具强校验**（`APPROVAL_ID_MISSING` / `APPROVAL_NOT_FOUND` / `APPROVAL_PENDING` / `APPROVAL_MODIFIED_UNSUPPORTED`），满足 `what-you-approve-is-what-you-commit`（恢复 ProcessDraft + 重算 hash 比对）后事务提交。

> 结论：写操作 100% 审批化（always 或 auto-high 升级）；只读 100% 不审批；`memory.*` 是唯一"有副作用但不审批"的例外（用户私人记忆，不入审计）。

### 7.4 工具族清单（111+ 种子条目）

工具来源分三处（有重叠去重）：[mcp/manifest.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/mcp/manifest.ts) 中 **111 个** seed 条目（`^\s+id: '` 源码计数）、[newDomainQueryTools.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/newDomainQueryTools.ts) 中 **13 个**新域查询工具（其中多数亦在 manifest 重复注册）、P0-B 四切片（tools.search/ingest/orders.update_status/order.confirm）。按命名空间：

| 命名空间 | 代表性工具 |
| :--- | :--- |
| memory | memory.recall / memory.write |
| products | products.query / get / expand / describe_schema |
| relations | relations.query / get / expand、relation.update / delete / onboard、relations.create |
| orders | orders.query / get / expand / list_by_status / update_status / batch_status / get_timeline / kanban、order.line_update / status_transition / delete / ship |
| garment | garment.update_size_breakdown / update_production_steps |
| links / entities | links.query / expand_neighbors、entities.search / hydrate |
| finance | finance.list_invoices / get_invoice / list_vouchers / get_voucher / query_outstanding / get_aging / get_statement / query_allocations、finance.create_invoice / create_voucher / apply_voucher_to_invoice、fin审计ance.soft_delete 等 |
| invoice / payment_voucher | invoice.issue / cancel / delete、payment_voucher.create / update / delete、payment.receive_and_reconcile |
| shipping | shipping.list_shipments / get_shipment / create_shipment / update_tracking_status / scan_delays |
| email | email.send / list / get / search / sync / reply_and_send / link_to_order / ai_extract |
| template | template.list / render / render_pdf |
| knowledge | knowledge.search / ingest |
| development | development.query / get / update_stage / convert_to_order / create |
| quotations | quotations.query / get、quotation.create / update |
| customs | customs.query_lc / get_lc / query_tax_refunds / query_declarations / register_lc / update_declaration |
| statement | statement.send |
| moq / order_changes | moq.query_config、order_changes.query / create / withdraw |
| samples / qc | samples.query / create_round / submit_to_customer / register_customer_confirmation、qc.query_reports / review_garment_sample / review_fabric_sample / sign_report |
| exceptions / credit | exceptions.query、credit.query_status / freeze / thaw |
| procurement / inventory / bom | procurement.create / update_status、inventory.adjust_stock、bom.query |
| 新域查询（newDomainQueryTools） | samples.query / bom.query / exceptions.query / credit.query_status / internal_trade.query / payment_requests.query / purchase_orders.query / customs.query_tax_refunds / customs.query_declarations / finance.query_allocations / order_changes.query / moq.query_config / qc.query_reports |

### 7.5 Flow 流程模式

每个高风险写操作对应一个 `*Flow.ts`：**execute（构造 ProcessDraft）→ request（生成审批卡）→ commit（事务提交）** 三段式。

已实现类别（~30 个）：

`orderLifecycleFlow`、`quotationFlow`、`orderChangesFlow`、`orderShipFlow`、`orderLineUpdateFlow`、`invoiceIssueFlow`、`invoiceCancelFlow`、`invoiceMutationFlow`、`creditFlow`、`statementSendFlow`、`emailReplySendFlow`、`emailSendOutboxFlow`、`emailSyncFlow`、`procurementFlow`、`inventoryFlow`、`qcFlow`、`samplesFlow`、`customsFlow`、`internalTradeFlow`、`reconcileFlow`、`paymentRequestsFlow`、`paymentVoucherMutationFlow`、`relationOnboardFlow`、`relationMutationFlow`、`productAssetMutationFlow`、`developmentCreateFlow`、`developmentConvertFlow`、`financeSoftDeleteFlow`、`knowledgeIngestFlow`、`commitTransaction`（通用提交内核）等，每个均配套 `__tests__/*.test.ts`。

各 flow 复用业务服务层（如 `orderShipFlowReuseService`），避免 Agent 与 REST 双实现漂移。

### 7.6 记忆 / 任务 / 事件 / 作业

- [memory.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/memory.ts)：AgentMemory 读写（偏好/流程/规则/事实，scope 隔离）。
- [taskFrame.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/taskFrame.ts)：任务框架。
- [events.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/events.ts)：Agent 事件定义与发射（SSE 流式 `emit`）。**双代 phase**：legacy（start/planning/tool_call/tool_result/final）+ agent-loop（iteration_start/thought/plan/tool_call_start/tool_call_end/final_answer/approval_resume…）；`AgentWorkEvent` payload 含 phase/status/title/message/toolId/stepId/summary/metadata；**前端 block 流协议五事件**：`block_start / block_delta / block_patch / block_end / block_error`（type：tool/evidence/table/approval/form；lifecycleStatus：running/blocked/failed/succeeded），由 `lib/agentBlockStream.ts` 归约、`lib/agentEventPresentation.ts` 映射中文叙述。
- [feedbackContract.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/feedbackContract.ts)：审批反馈契约。
- [knowledge.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/knowledge.ts)：Agent 侧知识检索入口。

### 7.7 政策与身份（RBAC）

- [policy.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/policy.ts)：`createPolicyService().canUseTool(actor, toolId, risk)`（toolScopes 判定；high risk 且非审批角色 → requiresApproval）；`HIGH_RISK_APPROVERS = {owner, admin, manager}`。
- [identity.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/identity.ts)：`ROLE_SCOPES` 定义每个 AgentRole 的 permissions/knowledge/tools 范围，`resolveActorContext()` 按角色+部门聚合出四类 scope（permission/memory/knowledge/tool）。
- [defaults.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/defaults.ts)：`AGENT_LOOP_LIMITS`（maxSteps/maxToolsPerStep/perToolTimeoutMs/totalBudgetMs/llmRepairRetries/observationCharLimit/scratchpadCharBudget）+ `DEFAULT_AGENT_ROLES`（8 角色权限矩阵）+ `DEFAULT_AGENT_TOOLS`（scope/risk/allowedRoles）。

---

## 8. 基础设施与部署

### 8.1 Ops Panel 运维面板

[server/ops-panel](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/ops-panel)（独立子项目，独立 node_modules，入口 [src/index.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/ops-panel/src/index.ts)）：

- 访址：`https://ops.jiangsupanda.com/ops`；本机端口 `BAMBOOK_OPS_PORT`（默认 **8088**），生产要求 `BAMBOOK_OPS_ADMIN_TOKEN`。
- **白名单脚本动作（20 个，`ACTIONS` 字典）**：healthcheck、publicProbe、restartCloudflare、restartMainApi、backupPostgres、**deployMainApi（面板内置「拉取 GitHub 部署」路径）**、deployPanel、demoSeedDryRun、demoSeedRollback、seedRbac、Melo 系列（setupMeloTts / installMeloTtsService / ensureMeloNltk / restartMeloTtsService / testMeloTts / stopMeloTtsService / startMeloTtsSetup / restartMeloTtsSetup / stopMeloTtsSetup）。动作分组 `routine / deploy / danger`，带锁（lockKey）与确认口令。
- **HTTP 端点**：`GET /api/status`、`/api/datamap`（datamap）、`/api/logs`、`/api/admin/webapp-manifest`；`POST /api/admin/seed-rbac`（数据库直连写 RBAC 种子：8 角色 + 28 权限点 + legacy id 迁移 + 无角色用户自动赋 viewer）、`/api/admin/token`、`/api/admin/model-key`、`/api/admin/require-auth`、`/api/admin/email-key`、`/api/admin/deploy-package`（gzip/octet-stream，**200mb** 上限）、`/api/admin/deploy-webapp` + `deploy-webapp-chunk`（500kb 分片）+ `deploy-webapp-finalize`（增量 manifest 部署）；`POST /api/actions/:id`（执行白名单动作）。
- **DevJob 子系统**：`/api/dev/jobs`（CRUD + cancel，可在 server/repo/opsPanel cwd 执行任意命令，输出 320KB 上限、超时控制、锁保护、history 持久化）+ `/api/dev/files`（读/diff/写/backup/rollback/upload，dev 文件备份目录）——构成面板内嵌的开发机远程操作能力。
- **部署方式双轨**：开发机日常走 **push-based**（`scripts/ops-upload-package.sh` / `ops-upload-webapp.sh` 上传 tarball → 面板 `/api/admin/deploy-package`）；面板内同时保留「拉 GitHub 部署」动作作为备用路径（与 project_rules「Mac Mini 不拉 GitHub」并存，开发机 push 为主）。

### 8.2 部署脚本体系

| 脚本 | 职责 |
| :--- | :--- |
| scripts/ops-upload-package.sh | 打包 server + 上传 Ops Panel `/api/admin/deploy-package` 部署主 API |
| scripts/ops-upload-webapp.sh | 打包前端 dist，按远端 manifest 增量跳过，上传 webapp（支持 light/subdomain 变体） |
| npm run deploy:web / deploy:server / deploy:all | 一键部署入口（Ops Token 从 macOS Keychain 自动读取） |
| scripts/dev-stack.sh / dev-backend.sh / restart_dev.sh / reload-electron.sh | 本地开发/重启 |
| scripts/check-design-tokens.sh | 设计 token 防回退基线检查 |
| scripts/audit-os-vnext.mjs / audit-page.mjs / audit-assistant.mjs | 设计/页面审计 |
| scripts/acceptance-*.mjs | 验收回归测试 |
| scripts/e2e-*.mjs / e2e-sse-sim.mjs | E2E 前端 + SSE 模拟 |
| scripts/agent-runtime-status.mjs / agent-local-stack.sh | Agent 运行时状态/本地起栈 |
| deploy/macmini/setup.sh | Mac Mini 初始化（Postgres 安装/建库/写 .env.local） |
| deploy/macmini/import-data.sh | pg_dump/psql 数据导入导出 |
| server/scripts/ops/* | 面板侧脚本（部署面板/健康检查/公网探针/RBAC 种子） |
| server/scripts/seed-*.ts | 演示数据/SOP/字典/系统配置/RBAC/MOQ/流水号种子 |

### 8.3 CI 流水线

[.github/workflows/ci.yml](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/.github/workflows/ci.yml)：触发 `push main` / `pull_request main` / `workflow_dispatch`；jobs：**typecheck**（根 + server TypeScript）、**prisma-check**（schema 校验）、**build**（vite/electron/server）、**test**（Postgres test DB + vitest）。

### 8.4 知识库 API（Python）

[server/knowledge_api](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/knowledge_api)：FastAPI + 向量嵌入（`app/embed.py` / `app/db.py` / `app/main.py`），提供 RAG 检索与文档入库，由后端 `knowledgeApiService` 集成；独立 `requirements.txt`。

### 8.5 本机启动辅助（.command）

根目录提供 macOS 双击启动脚本：`Bambook-Electron桌面端.command`、`Bambook-全栈开发.command`、`Bambook-部署后端.command`、`Bambook-部署网页版.command`、`Bambook-一键全量部署.command`、`Bambook-Preview生产模式.command`、`Bambook-UI Lab Electron.command`。

---

## 9. 关键类与函数索引

### 前端关键符号

| 符号 | 位置 | 说明 |
| :--- | :--- | :--- |
| `BAMBOOK_MODULES` | components/moduleRegistry.ts | 32 个业务模块注册表（导航/权限/编译面） |
| `getModuleByView` / `getPrimaryNavigationModules` / `groupPrimaryNavigationModules` | components/moduleRegistry.ts | 视图→模块解析、一级导航分组 |
| `App`（activeView 分发） | App.tsx | 主壳路由分发 |
| `Sidebar` | components/Sidebar.tsx | 五组一级导航渲染 |
| `getApiBaseUrl` / `normalizeDataCenterEndpoint` / `withApiSuffix` | services/apiBase.ts | API 根地址解析 |
| `apiService` | services/apiService.ts | 通用 SDK 封装 |
| `View` 枚举 | types.ts | 视图标识 |
| `ViewPermissionPolicy` | lib/modulePermissions.ts | 视图权限策略 |

### 后端关键符号

| 符号 | 位置 | 说明 |
| :--- | :--- | :--- |
| `createXxxRouter({ prisma, requireAuth, apiKeys, onDataChange })` | 各模块 route.ts | 统一路由工厂模式 |
| `SDK_CONFIG` | server/src/index.ts | JWT/SDK Key 认证配置 |
| `publishDataChange` | server/src/events/dirtyCacheService.ts | 数据变更发布 |
| `registerAllLinkages` | server/src/events/linkages/index.ts | L1–L10 联动注册 |
| `businessEventBus` | server/src/events/businessEventBus.ts | 领域事件总线 |
| `createAuditMiddleware` / `auditService` | server/src/audit/ | 全写入审计 |
| `permissionService` / `requireRole` | server/src/auth/ | 权限判定 |

### Agent 关键符号

| 符号 | 位置 | 说明 |
| :--- | :--- | :--- |
| `runAgentLoop` / `agentLoop` | server/src/agent/agentLoop.ts | ReAct 主循环 |
| `AGENT_LOOP_LIMITS` | server/src/agent/defaults.ts | 循环边界 |
| `ToolDefinition` / `ApprovalPolicy` / `ProcessDraft` / `ProcessSpec` | server/src/agent/toolRegistry.ts | 工具注册表契约 |
| `runAgentToolCalls` | server/src/agent/toolRuntime.ts | 工具执行运行时 |
| `buildLLMSystemPrompt` / `buildConversationMessages` | server/src/agent/llmPlanner.ts | Planner 提示词/消息构造 |
| `AgentManifest`/`MCP_TOOL_MANIFEST` | server/src/agent/mcp/manifest.ts | 工具能力清单（100+ seeds） |
| `executePlan` | server/src/agent/mcp/executor.ts | MCP 执行（≤6 步） |
| `checkpoint.save/load/cleanup` | server/src/agent/checkpoint.ts | 崩溃恢复 |
| `policy.evaluate` | server/src/agent/policy.ts | 审批风险判定 |
| `*Flow` 三件套（execute/request/commit） | server/src/agent/`*Flow.ts` | 写操作流程化 |

---

## 10. 依赖关系

### 10.1 包依赖

**前端/桌面端（根 package.json）**：react 19、react-dom、framer-motion、lucide-react、three/@react-three/*、recharts、maplibre-gl、mermaid、react-markdown、sherpa-onnx、better-sqlite3、axios、xlsx、zod、uuid、date-fns、dompurify、@fontsource/urbanist。dev：vite、electron 41、electron-vite、electron-builder、tailwindcss、vitest、playwright、jsdom、typescript。

**后端（server/package.json）**：express、prisma/@prisma/client、jsonwebtoken、cors、multer、nodemailer、pdf-parse、xlsx、openai/ai、winston(+rotate)、dotenv、zod 等。

### 10.2 模块间依赖与数据流

```
React 页面(components/) ──services/*.ts──▶ REST /api/v1/* ◀── route.ts ──▶ service.ts ──▶ Prisma ◀─▶ PostgreSQL
      │                                         │
      │                                         └─◀─ publishDataChange → dirtyCache / SSE
      ▼                                         │
   Assistant.tsx ──/api/agent/sessions──▶ Agent route ─▶ agentLoop ─▶ llmPlanner ─▶ LLM 网关
                                               │            │
                                               │            ├─ toolRegistry / mcp.manifest ─▶ toolRuntime ─▶ *Flow(审批) ─▶ commitTransaction ─▶ Prisma
                                               │            └─ policy(权限) / checkpoint / memory / events(SSE)
                                               ▼
                               businessEventBus ◀── 业务写入触发 ── Linkages L1–L10 生成下游 Draft
```

- **双向约束**：Agent 工具与 REST 路由共享同一套业务服务层与 Prisma 模型，避免双实现漂移；
- **安全链**：前端 JWT/SDK Key → route guard → moduleGuard → tool policy → 高风险写操作审批卡 → 事务提交 → 审计日志；
- **跨层同步**：实体图谱（entities/sync.ts）对 relation/order 等关键表双写 EntityLink/EntityReference。

### 10.3 部署依赖（外部服务）

| 外部依赖 | 用途 | 备注 |
| :--- | :--- | :--- |
| PostgreSQL 16 | 业务真源 | **正式库在公司后端（Mac Mini），`panda_hub_local`**；本机 `pandahub`（docker-compose）仅 dev 测试用 |
| Cloudflare Tunnel | 公网入口 | jiangsupanda.com / ops.jiangsupanda.com（/bambook 前缀剥离） |
| 火山 Ark LLM | 对话/推理（默认 coding/v3） | 自研 provider 链：primary key 链 + backup/backup2 备用，无 openai 依赖 |
| 火山知识库/向量 + RAG | RAG | knowledge_api（:8800）+ knowledgeApiService |
| 邮箱 SMTP / IMAP / Resend | 邮件收发 | nodemailer / imap-simple / mailparser / resend |
| Melo TTS（本地 Python） | 语音合成 | :8765，markdown 预热 + 熔断 |
| macOS Keychain | Ops Token 存储 | 部署脚本读取 |

---

## 11. 运行方式

### 11.1 本地开发

```bash
# 0) 环境变量（必做）：根目录 .env.development → 复制为 .env.local
#    server 目录同理（server/.env.example → server/.env.local，必配 DATABASE_URL/JWT_SECRET/BAMBOOK_SDK_KEY）
#    本机 pandahub 仅开发测试用；正式数据在公司后端 Mac Mini

# 1) 后端（本机 Postgres 可用时，端口默认 8081）
cd server && npm i && npx prisma migrate dev && npm run dev   # ts-node src/index.ts，:8081

# 2) 前端网页版
npm run dev            # vite，:3000（VITE_UI_MODE=mobile 时为 :3001）
npm run dev:desktop    # 桌面模式 UI（:3000）
#    vite 已内置代理（vite.config.ts）：
#      /api        → http://localhost:8081     （本地后端，配合 VITE_API_BASE_URL=/api）
#      /api/zhipu  → https://open.bigmodel.cn/api/paas/v4
#      /api/openai → http://127.0.0.1:8045/v1  （本地 OpenAI 兼容服务）
#      /api/searx  → https://searx.be

# 3) 一键开发栈（scripts/dev-stack.sh）
npm run dev:stack     # 注意：只启动前端 :3000 并连接数据中心 API，不启动本地后端

# 4) Electron 桌面端完整开发
npm run electron:dev  # electron-vite dev（renderer :3000，UI Lab 旗标下 :3100；含本地 STT 模型加载）
npm run electron:agent-local   # 本地 Agent 栈 + Electron

# 5) UI 实验室（Panda UI Lab）
npm run dev:panda-lab  # :3105/dev-panda-lab.html（BAMBOOK_UI_LAB_DEV=1）
```

> **端口速查（真实实现）**：后端 `8081`（`process.env.PORT || 8081`）；vite dev `3000`（mobile `3001`）、preview `4173`；electron renderer `3000`（UI Lab electron `3100`）；UI Lab web `3105`；Melo TTS `8765`；knowledge_api `8800`；本地 OpenAI 兼容网关 `8045`。

### 11.2 构建与打包

```bash
npm run build               # 前端产物 dist/
npx tsc --noEmit --skipLibCheck        # 前端类型检查
cd server && npx tsc --noEmit --skipLibCheck   # 后端类型检查
npx electron-vite build     # Electron renderer+preload+main
npm run electron:dist       # electron-builder 出 dmg（dist-electron/）
npm run check:tokens        # 设计 token 防回退
```

### 11.3 部署（push-based，走 Ops Panel）

```bash
npm run check:tokens && npm test && cd server && npx tsc --noEmit --skipLibCheck && cd ..   # 三绿门禁
npm run deploy:server              # 打包后端 → Ops Panel 部署主 API
npm run deploy:web                 # 打包前端 → Ops Panel 部署 webapp
npm run deploy:web:subdomain       # 部署到独立子域（bambook.jiangsupanda.com）
npm run deploy:all                 # server + web
# Ops Token：macOS Keychain 自动读取；Mac Mini 不拉 GitHub
```

### 11.4 前后端桩切换（联调）

- 前端默认指向 `https://jiangsupanda.com/bambook`（生产）；本地联调通过 `VITE_API_BASE_URL=/api` 时走 vite 代理到 `http://localhost:8081`。
- Agent Runtime 默认指向数据中心；`getAgentRuntimeApiBaseUrl()` 支持切换（`apiBase.ts` 的解析优先级：env → 设置页 cloudEndpoint → 兜底公网端点）。

---

## 12. 测试体系

| 套件 | 命令 | 规模 |
| :--- | :--- | :--- |
| 前端 Vitest | `npm test` | 2644 通过 + 6 视觉基线 quarantine，117 文件（2026-08-25 基线快照）★ **2026-09-25 更正**：当前根域实测 `用例=3942 失败=0 跳过=8`（★ v3.79 复读同一格：口径＝`gate-summary.mjs` 机取，非手抄）；`rdlEmailFlatGuard` 的隔离已由 6 条解到 **1 条**（`#2563EB`，现量 3 处命中）⇒ 唯一口径见 `docs/降范围决策登记-2026-09-20.md` 第 47 条；本仓 CI **从未跑过 s0 分支**，"以最新 CI 为准"那句在本分支不成立 |
| 后端 Vitest | `cd server && npx vitest run` | 4467/4467 全通过，316 文件（基线同上；含出运批次门禁/催款分级穿透/专属面料四入口/退换货状态机回归） |
| Ops Panel | `cd server/ops-panel && npx tsc --noEmit` | 独立 tsconfig + 独立 node_modules |
| 验收系列 | `node scripts/acceptance-*.mjs` | Playwright 驱动的 UI 验收 |
| E2E | `node scripts/e2e-frontend-test.mjs` | 前端全链路 |

重点覆盖域：安全（auth/ZAP）、幂等、并发、KB CRUD、MOQ 双触发、交期锁死、DR-013 门禁、QA-SEC 权限收口、DR-016 合票分配、Agent flow 全量回归。

`requirements`: 提交前必须 `tsc 零错误 + 构建通过 + check:tokens 通过 + 前端 npm test 全绿`。

---

## 13. 开发约定与铁律

1. **渲染路径**：Relations/Products/Settings 的 compiled 双路径已于 **2026-08-18 UI 纪律重建中删除**（`App.tsx` 已无 `CompiledMainModuleSlot` / `Compiled*Page` 渲染分支，`App.test.ts` 断言「26 个非双路径模块已废弃透明包裹器」确认）。**渲染源统一为各 Manager 文件本身**（RelationsManager.tsx / ProductsManager.tsx / Settings.tsx）；`moduleRegistry` 中残留的 `compiler` 元数据仅作信息记录，不参与渲染选择。<br>（注：`.trae/rules/project_rules.md` 中的「渲染路径铁律」条目尚未同步更新，请以本 Wiki 与 `App.tsx`/`App.test.ts` 为准。）
2. **设计纪律**：tsx 中禁止硬编码 `rounded-[Npx]`、hex 颜色、`box-shadow`；只用 BDS tokens 与 Tailwind 语义类；`scripts/check-design-tokens.sh` 防回退（基线只减不增）。
3. **模块契约**：新增模块/工具时遵循 [docs/MODULE_CONTRACT.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/MODULE_CONTRACT.md) 与 `.github/pull_request_template.md` 自查清单（数据层/API层/Agent层三点位同步）。
4. **权限链**：任何写接口必须过权限门禁；Agent 高风险写操作必须走审批卡（`approvalPolicy: always`）。
5. **多会话协同**：`App.tsx` 冻结至 W5（FR-004 独占）；`schema.prisma`、check 脚本、package.json 各有单写者；各会话不得跨分工边界改文件。
6. **提交门禁**：tsc 零错误 + 构建通过 + check:tokens 通过 + 前端测试全绿；commit message 风格见 Git 工作流（feat/fix/chore/test + 域标注）。
7. **Dev/Prod 隔离**：本地永远只连 Local Panda Hub；生产写入即真实业务数据。
8. **ETL 单向**：Mac Mini 不拉 GitHub，统一 push-based 部署。

---

## 14. 相关文档索引

| 文档 | 内容 |
| :--- | :--- |
| [docs/MILESTONE_v0.8.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/MILESTONE_v0.8.md) | **v0.8 验收范围唯一权威源**（21 板块交付 + AI Agent 纯占位） |
| [docs/design/09-路线图与技术债务/2026-08-21-v0.8交付验收剧本.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/design/09-路线图与技术债务/2026-08-21-v0.8交付验收剧本.md) | v0.8 交付验收剧本（S1/S2/S3 铁律 + 面料/成衣两条主链走查） |
| [docs/README.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/README.md) | 官文档索引地图（首选入口） |
| [docs/ARCHITECTURE.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/ARCHITECTURE.md) | 系统架构（⚠️ 部分二级章节内容过时，如 `:4000` 端口、44 seeds、LLM_PROVIDER 切换等表述，以本 Wiki 的代码核实为准） |
| [docs/Bambook-Agent-OS-使用说明书.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/Bambook-Agent-OS-使用说明书.md) | Agent OS 用户视角（权威） |
| [docs/AGENT_RUNTIME_ARCHITECTURE.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/AGENT_RUNTIME_ARCHITECTURE.md) | Agent 运行时架构 |
| [docs/MODULE_CONTRACT.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/MODULE_CONTRACT.md) | 八层全栈模块契约 |
| [docs/BUSINESS_CAPABILITY_MATRIX.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/BUSINESS_CAPABILITY_MATRIX.md) | 业务能力矩阵（自述"单一事实源"，**⚠️ 2026-07-20 v1.0 已明显过时**：引用已删的 compiledProductsTemplates、Truth Baseline 测试数 3281 vs 实际 4467、HEAD 停留旧 commit——建议按本 Wiki/代码重新生成） |
| [docs/design-system/README.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/design-system/README.md) | 设计系统 |
| [docs/P0B-TOOL-REGISTRY-SCHEMA.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/P0B-TOOL-REGISTRY-SCHEMA.md) | 工具注册表 Schema |
| [docs/PROJECT_CLEANUP_MAP.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/PROJECT_CLEANUP_MAP.md) | 清理映射 |
| [server/BACKEND_GUIDE.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/BACKEND_GUIDE.md) | 后端开发与运维指南 |
| [server/docs/macmini-data-center.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/docs/macmini-data-center.md) | Mac Mini 数据中心运维（权威） |
| [server/docs/ops-panel-runbook.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/docs/ops-panel-runbook.md) | Ops Panel 手册 |
| [docs/DEPLOY_SOP.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/DEPLOY_SOP.md) | 部署 SOP |
| [.trae/rules/project_rules.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/.trae/rules/project_rules.md) | 项目规则（Git/部署/设计系统基线） |

---

## 附录 A：走查差异登记（2026-08-25 两轮全面走查，文档 vs 真实实现）

> 登记走查中发现的「项目文档/规则与代码真实现状不一致」项。✅ = 本 Wiki 已按实现修正；⚠️ = 需相关文档/rules 同步；💤 = 死配置待决策。

| # | 主题 | 文档/规则原表述 | 真实实现（代码核实） | 状态 |
|---|---|---|---|---|
| 1 | 后端端口 | 旧文档/本 Wiki 首版写 `:4000` | `const PORT = process.env.PORT \|\| 8081`（index.ts:248）；vite 代理 → `localhost:8081` | ✅ |
| 2 | LLM 网关 | 旧文档「按 LLM_PROVIDER 切换（ai-sdk/openai）」 | 自研 fetch provider 链：Ark coding/v3 默认 + backup/backup2，后端无 openai 依赖 | ✅ |
| 3 | 模块导航 | bom/pricing 误归 fulfillment、mes 归 fulfillment | bom(74)/pricing(72)/risks(76) 属 **finance**；mes(97) 属 platform 且 `primary:false`；data-center(92) 属 platform | ✅ |
| 4 | Agent 工具数 | `MCP 2.0 工具集 (44 seeds)`（Master Spec/ARCHITECTURE） | manifest.ts 源码 **111** 个 seed 条目 + 新域查询 13 个 + P0-B 四切片 | ✅ |
| 5 | /api/sdk/* | 旧架构文档暗示存在 | index.ts:1640 `[DELETED]`，无前端调用方；保留 legacy sync（/api/orders 等 handleSync） | ✅ |
| 6 | compiled 双路径 | `.trae/rules/project_rules.md`「渲染路径铁律：只改 compiled 版本」 | **2026-08-18 UI 纪律重建已删除**：App.tsx 无 CompiledMainModuleSlot/Compiled*Page，App.test.ts 断言废弃包裹器；渲染源=Manager 文件 | ✅ 已修（rules 已同步 2026-08-25） |
| 7 | config/router-rules.json | 旧基准手册称「意图路由热更新」 | 当前**无任何代码 import**（legacy 死配置）；实际路由由 llmProviders provider 链承担 | ✅ 已删除（2026-08-25） |
| 8 | Mac Mini 部署叙事 | project_rules「Mac Mini 不拉 GitHub」 | 开发机 push-based 为主路径 ✅；但 Ops Panel 仍内置 `deployMainApi`（拉 GitHub 部署）动作与 `com.bambook.ops-panel-auto` 自动轮询，属并存备用路径 | ✅ 已在 §8.1 注明双轨 |
| 9 | 产品版本 | 文档/UI 标注 `V3.0 / 3.0.0` | 实际推进 **v0.8**（2026-08-21 当周交付）；V3.0 系过度标注；npm 已对齐 `0.8.0`；UI/Settings 文案已改 | ✅ |
| 10 | 白皮书（Master Spec / BUSINESS_CAPABILITY_MATRIX） | Master Spec 仍有「MCP 44 seeds」「3.5 财经前端页面待开发」「mcp/planner.ts 引用」等过时表述 | 工具 manifest 111+；财务前端已交付（FinanceManager）；`mcp/planner.ts` 不存在（规划实为 llmPlanner.ts + agentLoop） | ✅ 关键过时点已修（2026-08-25），仍建议白皮书整体通读 |
| 11 | 测试基线 | project_rules（旧）：前端 2447/103、后端 3887/269 | 最新（2026-08-25 rules）：前端 **2644+6 quarantine、117 文件**；后端 **4467/4467、316 文件** | ✅ |
| 12 | RBAC 角色 | 旧文档列 11+ 角色 | RBAC 种子内置 **8 角色**（role_owner→role_viewer，`role_xxx` 前缀）+ 28 权限点；`logistics/production_manager/factory` 等为 AgentRole 类型级而非种子角色 | ✅ |
| 13 | Ops Panel 能力 | 旧「21 个白名单脚本」模糊描述 | 实际 `ACTIONS` 20 个（含 Melo 系列 9 个）+ DevJob 执行器 + dev 文件管理 + webapp 增量分片部署 + seed-rbac 直写；端口 8088 | ✅ |
| 14 | SSE 实时通道 | 文档未明确 | `GET /api/v1/events`（sdkAuth，addRealtimeClient）由 publishDataChange 推送 | ✅ |

**待办进展**：① project_rules 渲染路径铁律已同步（2026-08-25）；② router-rules.json 已删除（2026-08-25）；③ Master Spec 关键过时点已修正（44 seeds→111+、3.5 财务已交付、删除不存在的 mcp/planner.ts 引用）。剩余建议：Master Spec / BUSINESS_CAPABILITY_MATRIX 整体通读校准。

---

*Code Wiki 由代码仓库**实读核实**生成（非仅转写项目内文档），随代码演进保持更新。**事实优先级**：源码（`index.ts` / `moduleRegistry.ts` / `schema.prisma` / `agent/*` / 配置文件）> 本 Wiki > 项目内既有文档；如与 [ARCHITECTURE.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/ARCHITECTURE.md) 等旧文档不一致，一律以源码为准。*