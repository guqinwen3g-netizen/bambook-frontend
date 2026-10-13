# Seasons 季节展会模块设计 (Season & TradeShow Management)

## §1 元信息

| 项 | 值 |
|---|---|
| **模块定位** | 客户与开拓域的"周期节拍器"——季度（开发日历 + 季度回顾快照）/ 趋势（标签 + 关联面料）/ 展会（线索 + ROI）三维承载外贸服装业务的季节性周期；线索转化链路是开拓域的"上游入口" |
| **模块边界** | 季度 Season CRUD + 开发日历 calendar + 季度回顾快照（reviewJson 可重生成）+ 趋势标签 TrendTag 4 类型封闭集 + TrendTagFabric 关联 + 展会 TradeShow CRUD + 展会线索 TradeShowLead 全生命周期 + 线索转化（事务一致写入）+ ROI 实时聚合；不含开发案 / 样衣 / 趋势 LLM 推断 |
| **核心角色** | 业务员（含展会线索录入、跟进、季度回顾快照生成、设计师工作：趋势 + 当季面料，宽泛容器含跟单）、销售主管（展会 ROI 评估，部门管理职责）、超级管理员（老板，绝密级可见：季度回顾只读） |
| **范式** | 范式 A（季度卡片列表）+ 范式 D（3 Tab 切换 seasons / trends / shows）+ 范式 E（展会 / 线索录入 Modal）三态切换 |
| **优先级** | P0（开拓周期） |
| **实现状态** | ✅ 已落地（3 Tab 全量功能 + 季度回顾服务端聚合快照 + 展会线索转化事务一致写入 + ROI 实时聚合 + 趋势标签 4 类型封闭集 + TrendTagFabric 关联表唯一约束 + 季度回顾 watchdog + V2 路由） |
| **关联 PRD 章节** | §5.7（季节性与趋势管理）、§14（季节性回顾 / 趋势 / 展会）、§19.16（季节性管理页详细设计）、§24.2（分组导航） |
| **关联代码** | [SeasonsManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/SeasonsManager.tsx) 桌面端主组件 / [seasonService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/seasons/seasonService.ts) 后端服务工厂 / [seasonRouteV2.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/seasons/seasonRouteV2.ts) V2 路由 / [seasonReviewWatchdog.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/scheduler/tasks/seasonReviewWatchdog.ts) 季度回顾扫描 / `server/prisma/schema.prisma` Season/TrendTag/TrendTagFabric/TradeShow/TradeShowLead 模型 |

---

## §2 模块边界与上下文

Seasons 模块在客户与开拓域中扮演"**周期节拍器 + 上游入口**"角色：

- **季度为周期坐标**：`Season.code`（如 `SS26` / `AW26`）是开发 / 订单 / 产品的季节性周期坐标，与 `Order.season` / `ProductAsset.season` 等值匹配（不区分大小写）；季度回顾按 code 等值聚合订单，真源实时聚合 + 快照落 `reviewJson` 可重生成。
- **趋势为开拓依据**：`TrendTag` 4 类型封闭集（fabric / color / craft / composition）承载当季趋势，`TrendTagFabric` 关联表把趋势标签与面料档案 `FabricProfile` 关联；推荐场景优先展示当季趋势面料。
- **展会为线索入口**：`TradeShow` + `TradeShowLead` 承载展会线索全生命周期，转化路径是"线索 → category=Customer 的 Relation → 订单归集 → ROI 归因"；线索转化必须走 `convertLead` 接口（事务一致写入，禁止直接修改 `convertedRelationId`）。
- **真源实时聚合**：季度回顾与展会 ROI 均为服务端实时聚合（订单真源 + 线索转化真源），快照仅落 `reviewJson`；可重生成（`generateSeasonReview` 事务内覆盖 `reviewJson + reviewedAt`）。
- **跨模块关联**：展会线索转化后 → Relations 模块的客户档案（category=Customer）→ 订单模块的 `customerRelationId` 反向归集 → ROI 归因订单金额。

---

## §3 模块范围与核心能力

### 3.1 范围内（In Scope）

| 能力 | 说明 | 代码入口 |
|------|------|---------|
| 季度档案 | `code` SS26/AW26 格式校验（@unique 注册真源）+ `name` + `startDate/endDate` 区间校验 + `status` 3 态 + `notes` | `seasonService.createSeason` / `updateSeason` |
| 开发日历 | `calendar` JSON 数组（`[{ key, label, startDate, endDate, note? }]`）承载开发→打样→确认→下单→生产→出货里程碑 | `Season.calendar` 字段 |
| 季度回顾快照 | 服务端实时聚合（按 code 等值匹配订单）+ 快照落 `reviewJson` + `reviewedAt` 时间戳；可重生成 | `seasonService.computeSeasonReview` / `generateSeasonReview` |
| 趋势标签 | 4 类型封闭集（fabric/color/craft/composition）+ `name` + `description` + `source`（manual/trade_show）+ 关联季度 + 关联展会 | `seasonService.createTrendTag` |
| 趋势面料关联 | `TrendTagFabric` 关联表 `@@unique([trendTagId, fabricId])` 防重 + 硬删除（无软删字段）+ 当季趋势面料查询 | `seasonService.linkFabric` / `listTrendingFabrics` |
| 展会档案 | `name` + `location` + `startDate/endDate` + `boothNo` + `attendees` + `cost` + `currency` + `status` 4 态 + 关联季度 | `seasonService.createTradeShow` |
| 展会线索 | `customerName` + `company/country/email/phone/demand` + `status` 4 态 + `nextFollowUpAt` + 转化路径（`convertedRelationId` + `convertedAt`） | `seasonService.addLead` / `updateLead` |
| 线索转化 | 事务一致写入（status=Converted + convertedRelationId + convertedAt 同步）+ 禁止重复转化 + 目标必须 category=Customer | `seasonService.convertLead` |
| 展会 ROI | 实时聚合：`cost` + `leadsTotal/leadsConverted` + 转化客户订单 `orderCount/orderAmount` + `roi = orderAmount / cost`（无成本则 null） | `seasonService.getShowROI` |
| 软删除 | 季度 / 趋势 / 展会 / 线索均软删（`deletedAt` BigInt），TrendTagFabric 关联表硬删除 | 各 delete 函数 |

### 3.2 范围外（Out of Scope）

- ❌ 开发案 `DevelopmentCase` / 样衣 `SampleNode`（在 Development 模块，通过 `linkedSeasonId` 关联季度）
- ❌ 趋势 LLM 推断（PRD §14.2 P2 趋势 AI 推断，已知 P2 缺口）
- ❌ 展会订单归集的精细化分摊（当前按客户 relationId 全量归集，未区分展会专属订单）
- ❌ 季度回顾的看板可视化（数据已建，Dashboard 卡片未上）
- ❌ 趋势面料的 LLM 自动推荐（在 [Marketing-营销.md](./Marketing-营销.md) 的 FabricRecommendation 承载）

---

## §4 三维度矩阵

Seasons 模块以"季度 / 趋势 / 展会"三维度组织，每个 Tab 对应一个独立的状态机或类型封闭集：

| 维度 | Tab | 类型 / 状态集 | 语义徽章映射 |
|------|-----|--------------|-------------|
| 季度 Seasons | seasons | Planning / Active / Closed | info / active / neutral |
| 趋势 Trends | trends | fabric / color / craft / composition | 4 类型标签 |
| 展会 Trade Shows | shows | Planned / Ongoing / Completed / Cancelled | info / active / success / neutral |
| 展会线索 | （展会详情内） | New / Following / Converted / Lost | info / warning / success / neutral |

**状态机分层原则**：季度 `code` 创建后不可修改（关联真源，禁止改 code）；展会线索转化必须走 `convertLead` 接口，禁止直接 `updateLead` 修改 `convertedRelationId`（服务层抛错"convertedRelationId 不允许直接修改"）。

---

## §5 核心业务流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Season 周期坐标                                  │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                                │
│  │ SS26 │ │ AW26 │ │ SS27 │ │ AW27 │ ...  (code @unique 注册真源)   │
│  └───┬──┘ └───┬──┘ └──────┘ └──────┘                                │
│      │         │                                                     │
│      │  ┌──────┘                                                     │
│      ▼  ▼                                                            │
│  ┌────────────────────────────┐                                      │
│  │ calendar 开发日历里程碑     │                                       │
│  │ 开发→打样→确认→下单→生产→出货│                                       │
│  └────────────────────────────┘                                      │
│                                                                      │
│  季度回顾（服务端聚合，可重生成）：                                     │
│    订单真源（Order.season == code，不区分大小写）                       │
│      ├─ 接单量 orderCount                                            │
│      ├─ 出货量 shippedCount                                          │
│      ├─ 收入 revenue = ∑ contractAmount|quoteAmount                   │
│      ├─ 成本 cost = ∑ supplierInvoiceAmount                          │
│      ├─ 毛利 grossProfit = revenue - cost                             │
│      └─ topCustomers（按 revenue 排序前 5）                           │
│    → 落 reviewJson + reviewedAt                                       │
└─────────────────────────────────────────────────────────────────────┘
              │                              │
              │ 季度关联                     │ 展会关联
              ▼                              ▼
┌──────────────────────────┐    ┌──────────────────────────┐
│ TrendTag 趋势标签         │    │ TradeShow 展会           │
│ (4 类型封闭集)            │    │ (4 态状态机)             │
│  fabric / color /         │    │  Planned → Ongoing →     │
│  craft / composition      │    │  Completed / Cancelled  │
│                           │    └────────────┬─────────────┘
│  + TrendTagFabric 关联表  │                 │
│    @@unique([tag, fabric])│                 ▼
│  + 当季趋势面料查询       │    ┌──────────────────────────┐
└──────────────────────────┘    │ TradeShowLead 展会线索    │
                                │ (4 态状态机)              │
                                │  New → Following →        │
                                │  Converted / Lost         │
                                └────────────┬─────────────┘
                                             │
                                             │ 转化（事务一致）
                                             ▼
                                ┌──────────────────────────┐
                                │ Relation (category=       │
                                │  Customer)                │
                                │  → Order.customerRelationId│
                                │  → ROI 归因 orderAmount   │
                                └──────────────────────────┘
```

**关键口径**：
- 季度回顾按 `Order.season` 字段（自由文本）与 `Season.code`（注册真源）等值匹配，不区分大小写。
- 已出运口径：`shipmentDate` 非空，或订单状态进入 `Shipped/Invoiced/PartiallyPaid/Paid/Closed`。
- ROI 归因：`leads.filter(status=Converted).convertedRelationId` → 查该 relationId 关联的订单累计金额。
- 线索转化事务：`tx.tradeShowLead.findUnique` → 校验未转化 → 校验目标 Relation 存在 + category=Customer → 同事务内更新 `status/convertedRelationId/convertedAt`。

---

## §6 数据模型概要

Seasons 模块持久化真源由 5 个核心模型组成：

| 模型 | 角色 | 关键约束 |
|------|------|---------|
| `Season` | 季度档案（开发日历 + 回顾快照） | `code` `@unique` 注册真源 / `status` 3 态 / `calendar` JSON 里程碑数组 / `reviewJson` + `reviewedAt` 快照 / 软删 |
| `TrendTag` | 趋势标签（4 类型封闭集） | `type` fabric/color/craft/composition / `seasonId` 可空（null=跨季趋势） / `tradeShowId` 可空 / 软删 |
| `TrendTagFabric` | 趋势 ↔ 面料档案关联表 | `@@unique([trendTagId, fabricId])` 防重 / 无软删字段，硬删除 |
| `TradeShow` | 展会档案 | `seasonId` 可空 / `status` 4 态 / `cost Decimal` ROI 分母 / `currency` / `attendees` 数组 / 软删 |
| `TradeShowLead` | 展会线索 | `tradeShowId` FK Cascade / `status` 4 态 / `convertedRelationId` + `convertedAt` 转化路径 / 软删 |

**关键关联**：
- `Season` 1:N `TrendTag`（`onDelete: SetNull`，删季度保留趋势为跨季）。
- `Season` 1:N `TradeShow`（`onDelete: SetNull`，删季度保留展会无季度归属）。
- `TrendTag` 1:N `TrendTagFabric`（`onDelete: Cascade`，删趋势级联删关联）。
- `TradeShow` 1:N `TradeShowLead`（`onDelete: Cascade`，删展会级联软删线索）。
- `TradeShowLead.convertedRelationId` 弱关联（无 FK 约束，目标 Relation 软删后线索保留历史）。

---

## §7 字段词典与类型契约

Seasons 模块的 TypeScript 类型契约集中在 [types.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/types.ts) §3390-§3567：

- `SeasonStatus` 联合类型：`'Planning' | 'Active' | 'Closed'`。
- `TrendTagType` 联合类型：`'fabric' | 'color' | 'craft' | 'composition'`。
- `TradeShowStatus` 联合类型：`'Planned' | 'Ongoing' | 'Completed' | 'Cancelled'`。
- `TradeShowLeadStatus` 联合类型：`'New' | 'Following' | 'Converted' | 'Lost'`。
- `Season` / `SeasonInput` / `SeasonPatch`（`code` 创建后不可改，patch 类型 `Omit<SeasonInput, 'code'>`）。
- `SeasonCalendarItem`：`{ key, label, startDate, endDate }` 里程碑节点。
- `SeasonReview` / `SeasonReviewTopCustomer`：服务端聚合快照。
- `TrendTag` / `TrendTagInput` / `TrendTagPatch` / `TrendTagFabricLink` / `TrendingFabricItem`。
- `TradeShow` / `TradeShowInput` / `TradeShowPatch` / `TradeShowLead` / `TradeShowLeadInput` / `TradeShowLeadPatch` / `TradeShowROI`。

前端常量真源在 [SeasonsManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/SeasonsManager.tsx) §59-§136，包括 `MODULE_TABS`（3 Tab）、`SEASON_STATUS_LABELS` / `SEASON_STATUS_SEMANTIC`、`TREND_TYPE_LABELS`、`SHOW_STATUS_LABELS` / `SHOW_STATUS_SEMANTIC`、`LEAD_STATUS_LABELS` / `LEAD_STATUS_SEMANTIC`、`SEMANTIC_BADGE_VARIANT`（StatusSemantic → bds-badge 变体映射）、`SEMANTIC_TINT_STYLE`（非 badge 结构的 tint/text token 样式）。

---

## §8 API 端点概要

V2 路由（挂载于 `/api/v2/seasons`，全量 requirePermission）：

| 方法 | 路径 | 守卫 | 说明 |
|------|------|------|------|
| GET | `/seasons` | seasons:read | 季度列表（status/search 筛选 + 分页） |
| POST | `/seasons` | seasons:write | 创建季度（code @unique 校验 + 日期区间校验） |
| GET | `/seasons/:id` | seasons:read | 季度详情（含 trendTags / tradeShows） |
| PATCH | `/seasons/:id` | seasons:write | 更新（code 不可改 + 日期区间与现存值合并校验） |
| DELETE | `/seasons/:id` | seasons:write | 软删 |
| POST | `/seasons/:id/review` | seasons:write | 生成季度回顾快照（事务覆盖 reviewJson + reviewedAt） |
| GET | `/seasons/:id/review` | seasons:read | 实时计算季度回顾（不落快照） |
| GET/POST/PATCH/DELETE | `/trend-tags/...` | seasons:read/write | 趋势标签 CRUD |
| POST/DELETE | `/trend-tags/:id/fabrics/:fabricId` | seasons:write | 关联 / 解除关联面料（防重 + 硬删） |
| GET | `/trending-fabrics?seasonId=` | seasons:read | 当季趋势面料查询 |
| GET/POST/PATCH/DELETE | `/trade-shows/...` | seasons:read/write | 展会 CRUD |
| POST | `/trade-shows/:id/leads` | seasons:write | 添加线索 |
| GET/PATCH/DELETE | `/trade-shows/leads/:id` | seasons:read/write | 线索 CRUD（patch 禁止改 convertedRelationId） |
| POST | `/trade-shows/leads/:id/convert` | seasons:write | 线索转化（事务一致 + 禁止重复） |
| GET | `/trade-shows/:id/roi` | seasons:read | 展会 ROI 实时聚合 |

行级 scope 暂未接入（开拓域数据默认全员可见，scope 规则待补）。

---

## §9 权限矩阵与行级 Scope

| 角色 | 季度 / 趋势 / 展会可见 | 线索读写 | 季度回顾生成 | ROI 查询 |
|------|---------|---------|---------|---------|
| admin / manager | 全部 | ✅ | ✅ | ✅ |
| sales | 全部 | ✅ 仅自己展会 | ❌ | ✅ 仅自己展会 |
| merchandiser | 全部 | ⚠️ 同部门展会 | ❌ | ✅ 同部门 |
| designer | 全部（趋势读写） | ❌ 只读 | ❌ | ❌ 只读 |
| agent（API Key） | 全部只读 | ❌ | ❌ | ✅ 只读 |

行级 scope 待补（当前开拓域数据默认全员可见，与 Relations / CRM 的 `relation` scope 规则不同；P1 缺口接入 `seasons` scope）。

---

## §10 设计系统约束

本模块遵循 BDS v2.1 中性契约（与 CRM / Marketing 同口径）：

- **组件族**：`bds-tabs / bds-tab / bds-card / bds-badge / bds-table / bds-input / bds-modal / bds-empty / bds-overline / bds-tnum / bds-segment`
- **主题透明**：组件对 `isDarkMode` 透明，暗色由 `tokens.css [data-theme]` 统一覆盖；`isDarkMode` 仅保留在 props 签名兼容调用方
- **徽章语义映射**：`SEMANTIC_BADGE_VARIANT` 把 `StatusSemantic`（8 态）映射到 `bds-badge`（5 变体），与 CRM / Marketing 共享同一常量
- **非 badge 结构 tint 样式**：`SEMANTIC_TINT_STYLE` 为 ROI 指标卡 / 线索状态下拉等非 badge 结构提供 tint/text token 样式（如 `var(--accent-tint) + var(--accent-text)`）
- **空态**：`bds-empty` + Lucide 图标（CalendarRange / TrendingUp / Store），无吉祥物 / 无插画
- **Tab 切换重挂载**：`AnimatePresence mode="wait"` + `key={activeTab}`，保证数据新鲜

---

## §11 业务规则接入状态

| 规则 | 接入状态 | 备注 |
|------|---------|------|
| 季度 code @unique 注册真源 | ✅ 创建时校验 dup（含已软删） | code 创建后不可修改（关联真源） |
| 季度回顾服务端实时聚合 + 快照可重生成 | ✅ `computeSeasonReview` + `generateSeasonReview` 事务覆盖 | 真源为订单，快照仅落 reviewJson |
| 趋势标签 4 类型封闭集 | ✅ `TREND_TYPES` 常量 + 服务层校验 | fabric/color/craft/composition |
| TrendTagFabric 防重 | ✅ `@@unique([trendTagId, fabricId])` + 服务层 dup 校验 | 关联表无软删字段，硬删 |
| 展会线索转化事务一致 | ✅ 事务内 status/convertedRelationId/convertedAt 同步写入 | 禁止直接修改 convertedRelationId |
| 线索转化禁止重复 | ✅ 事务内校验 status !== 'Converted' | — |
| 线索转化目标必须 category=Customer | ✅ 事务内校验 `relation.category === 'Customer'` | — |
| 展会 ROI 实时聚合 | ✅ 转化客户 relationId → 订单累计金额 | 无成本则 roi=null |
| 季度回顾 watchdog | ✅ 季度结束后定时触发生成快照 | `seasonReviewWatchdog` |
| 软删（季度 / 趋势 / 展会 / 线索） | ✅ `deletedAt` BigInt | TrendTagFabric 关联表硬删 |
| 行级 scope | ⚠️ 待补 | P1 缺口，开拓域默认全员可见 |

---

## §12 状态机与生命周期

### 12.1 季度状态机

```
Planning（规划中）─→ Active（进行中）─→ Closed（已收官）
```

单向流转，无回退；`Closed` 后回顾快照可重生成（`reviewedAt` 更新）。

### 12.2 展会状态机

```
Planned（已计划）─┬─→ Ongoing（进行中）─┬─→ Completed（已完成）
                  │                      │
                  └─→ Cancelled（已取消） └─→ Cancelled（已取消）
```

`Planned → Ongoing` 启动展会；`Ongoing → Completed` 结束展会进入 ROI 评估；任意阶段可 `Cancelled`。

### 12.3 线索状态机

```
New（新线索）─┬─→ Following（跟进中）─┬─→ Converted（已转化，事务一致写入）
              │                       │
              └────────────────────────┴─→ Lost（已流失）
```

`Converted` 为终态（不可回退，禁止重复转化）；`Lost` 可逆回 `Following`（重新激活线索）。

### 12.4 趋势标签生命周期

```
创建（manual 或 trade_show 来源）─→ 更新（name/description/seasonId/type）
                                  └─→ 软删（deletedAt，级联删 TrendTagFabric 关联）
```

---

## §13 待补的设计缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | 行级 scope 接入（seasons scope 规则） | P1 | V2 路由 |
| 2 | 趋势 LLM 推断（PRD §14.2 P2，AI 自动推荐趋势面料） | P2 | Trends Tab |
| 3 | 季度回顾 Dashboard 卡片可视化 | P1 | Dashboard |
| 4 | 展会订单归集精细化分摊（当前按客户全量归集，未区分展会专属订单） | P2 | ROI 聚合 |
| 5 | 季度回顾历史快照对比（保留多版本 reviewJson） | P2 | Season 详情 |
| 6 | 趋势标签 WGSN / Pantone 等外部数据源集成 | P2 | Trends Tab |

---

## §14 实现状态总览

| 子能力 | 状态 | 真源 |
|--------|------|------|
| 3 Tab（季度 / 趋势 / 展会）+ Tab 切换重挂载 | ✅ | `SeasonsManager` + `MODULE_TABS` |
| 季度 CRUD + code @unique 校验 + 日期区间 | ✅ | `seasonService.createSeason` / `updateSeason` |
| 开发日历 calendar JSON 里程碑 | ✅ | `Season.calendar` 字段 |
| 季度回顾实时聚合 + 快照可重生成 | ✅ | `computeSeasonReview` / `generateSeasonReview` |
| 趋势标签 4 类型封闭集 + CRUD | ✅ | `createTrendTag` / `listTrendTags` |
| TrendTagFabric 关联表防重 + 硬删 | ✅ | `linkFabric` / `unlinkFabric` |
| 当季趋势面料查询 | ✅ | `listTrendingFabrics` |
| 展会 CRUD + 4 态状态机 | ✅ | `createTradeShow` / `updateTradeShow` |
| 展会线索 CRUD + 4 态状态机 | ✅ | `addLead` / `updateLead` |
| 线索转化事务一致 + 禁止重复 + 目标校验 | ✅ | `convertLead` |
| 展会 ROI 实时聚合 | ✅ | `getShowROI` |
| 季度回顾 watchdog | ✅ | `seasonReviewWatchdog` |
| V2 路由 + requirePermission | ✅ | `seasonRouteV2` |
| 行级 scope | ⚠️ 缺口 | 开拓域默认全员可见 |
| 趋势 LLM 推断 | ⚠️ 缺口 | PRD §14.2 P2 |
| 季度回顾 Dashboard 卡片 | ⚠️ 缺口 | Dashboard |

---

## §15 交叉链接

1. [CRM-客户跟进](./CRM-客户跟进.md) — 转化后的客户 Relation 在 CRM 维护跟进 / 商机 / 信用
2. [Relations-联系人](./Relations-联系人.md) — 线索转化目标 category=Customer 的 Relation 真源
3. [Marketing-营销](./Marketing-营销.md) — 营销活动关联 seasonId / tradeShowId + 趋势面料与面料推荐联动
4. [订单管理 模块概述](../03-订单与生产/Orders-订单管理/模块概述.md) — Order.season 与 Season.code 等值匹配 + 季度回顾订单归集
5. [实体关系总览](../../02-数据模型/实体关系总览.md) — Season/TrendTag/TradeShow/TradeShowLead 模型关系图
6. [业务规则总览](../../03-业务规则/业务规则总览.md) — 季度回顾与展会 ROI 业务规则口径
7. [10条事件联动（L1-L10）与事件总线](../../03-业务规则/10条事件联动（L1-L10）与事件总线.md) — 线索转化事件总线接入

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| 前端组件真源 | [components/SeasonsManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/SeasonsManager.tsx) |
| 后端服务真源 | [server/src/seasons/seasonService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/seasons/seasonService.ts) |
| V2 路由 | [server/src/seasons/seasonRouteV2.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/seasons/seasonRouteV2.ts) |
| 季度回顾 watchdog | [server/src/scheduler/tasks/seasonReviewWatchdog.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/scheduler/tasks/seasonReviewWatchdog.ts) |
| Prisma 模型真源 | [server/prisma/schema.prisma](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/prisma/schema.prisma) Season/TrendTag/TrendTagFabric/TradeShow/TradeShowLead |
| 前端类型定义 | [types.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/types.ts) §3390-§3567 |
