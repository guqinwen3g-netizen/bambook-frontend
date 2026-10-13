# CRM 客户跟进模块设计 (CRM Customer Relationship Management)

## §1 元信息

| 项 | 值 |
|---|---|
| **模块定位** | 客户与开拓域的"操作面板"——以客户（Relation）为坐标，承载跟进时间线 / 商机管线 / 客户分层 / 信用额度 / 联系人视图五大维度；客户身份真源在 Relations 模块，本模块只对客户做"跟进层"行为写入 |
| **模块边界** | 商机 6 阶段流转、跟进记录 CRUD + 逾期检测、客户分层评定、信用额度设置与状态变更、联系人只读视图；不含联系人档案编辑（写路径收口在 Relations DetailPanel）、不含客户身份创建/合并/去重 |
| **核心角色** | 业务员（含跟进、商机推进，日活最高）、销售主管（信用额度审批、分层评定，部门管理职责）、超级管理员（老板，绝密级可见：管线汇总、客户关联视图）、财务（含信用额度只读，宽泛容器不细分） |
| **范式** | 范式 A（顶部客户选择器）+ 范式 D（Tab 切换 5 维度）+ 范式 E（录入 Modal）三态切换 |
| **优先级** | P0（开拓核心） |
| **实现状态** | ✅ 已落地（5 Tab 全量功能 + 跨模块 RelatedEntitiesPanel 客户关联视图 + 逾期提醒顶部红色徽章 + 商机阶段流转状态机 + 信用超额 / 商机成交 / 分层评定 3 类业务事件发布 + crmFollowUpWatchdog 每日 09:30 逾期扫描） |
| **关联 PRD 章节** | §5.4（客户关系管理）、§9.4（信用控制 60 天逾期冻结）、§19.6（CRM 页详细设计）、§24.2（分组导航） |
| **关联代码** | [CrmManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/CrmManager.tsx) 桌面端主组件 / [crmService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/crm/crmService.ts) 后端服务工厂 / [crmRouteV2.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/crm/crmRouteV2.ts) V2 路由 + 行级 scope 守卫 / [crmFollowUpWatchdog.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/scheduler/tasks/crmFollowUpWatchdog.ts) 逾期扫描任务 / `server/prisma/schema.prisma` Contact/CreditLimit/FollowUpRecord/Opportunity/CustomerTier 模型 |

---

## §2 模块边界与上下文

CRM 模块在客户与开拓域中的位置可概括为"**身份在 Relations，跟进在 CRM**"：

- **身份真源**：客户 / 供应商 / 代理商等 7 类组织档案的唯一权威源是 `Relation`（详见 [Relations-联系人.md](./Relations-联系人.md)）。CRM 顶部客户选择器直接复用 `apiService.listRelations()`，不重复维护客户档案。
- **联系人写路径收口**：联系人 `Contact` 的 CRUD 真源在 Relations 模块的 DetailPanel 联系人名片区块；CRM 的"联系人"Tab 仅渲染只读卡片，编辑按钮调用 `primeRelationsOrgDetailPreview(orgId) + onNavigate(View.Relations)` 跨模块跳转，避免双写路径造成数据不一致。
- **跟进层数据**：跟进记录 `FollowUpRecord` / 商机 `Opportunity` / 客户分层 `CustomerTier` / 信用额度 `CreditLimit` 四类实体均挂在 `relationId` 之下，与客户身份一一对应，由本模块独立维护。
- **跨模块关联视图**：每个 Tab 底部嵌入 `RelatedEntitiesPanel`（type=`relation.organization`），通过 EntityLink 图谱横向聚合该客户名下的订单 / 报价 / 商机 / 开发案 / 发票等所有关联实体，形成"360° 客户画像"。

下游模块（订单 / 财务 / 报关）通过 `customerRelationId` 等 FK 反向归集客户业务数据；本模块不直接发起跨域写入，仅通过业务事件总线（`OpportunityClosedWon` / `CreditLimitExceeded` / `CustomerTierAssigned`）广播状态变化，由下游模块订阅响应。

---

## §3 模块范围与核心能力

### 3.1 范围内（In Scope）

| 能力 | 说明 | 代码入口 |
|------|------|---------|
| 商机管线 | 6 阶段 Kanban（Prospecting → Qualification → Proposal → Negotiation → ClosedWon/ClosedLost）+ 流转下拉 + 管线汇总（商机数 / 管线总额 / 已成交金额） | `OpportunitiesTab` + `crmService.transitionOpportunityStage` |
| 跟进记录 | 6 类型（拜访 / 电话 / 邮件 / 微信 / 会议 / 其他）+ 关联联系人 + 关联商机 + 下次跟进 + 逾期提醒红色面板 | `FollowUpsTab` + `crmService.createFollowUp/listOverdueFollowUps` |
| 联系人视图 | 只读卡片网格（主联系人 / 决策人徽章 + 在职 / 离职状态）+ 跨模块跳转编辑 | `ContactsTab` + `primeRelationsOrgDetailPreview` |
| 信用额度 | 总额度 / 已用 / 可用三栏 + 用量进度条（success/warning/danger 三档）+ 冻结 / 撤销状态变更 + 历史记录 | `CreditLimitTab` + `crmService.setCreditLimit/updateCreditLimitStatus` |
| 客户分层 | Bronze / Silver / Gold / Platinum / VIP 5 等级 + 折扣率 / 账期 / 信用优先级三权益 + 评定依据 + 有效期 + 历史 | `CustomerTierTab` + `crmService.assignCustomerTier` |
| 客户关联视图 | 跨模块 EntityLink 图谱聚合（订单 / 报价 / 商机 / 发票 / 开发案等） | `RelatedEntitiesPanel` type=`relation.organization` |
| 逾期提醒 | 每日 09:30 调度扫描 `nextFollowUpAt < today` 的跟进记录 + warning / critical 双档预警 + RiskAlert dedupKey 幂等 | `crmFollowUpWatchdog` + `riskService.raiseAlert` |
| 业务事件发布 | `CreditLimitExceeded` / `OpportunityClosedWon` / `OpportunityClosedLost` / `OpportunityStageChanged` / `CustomerTierAssigned` 五类事件 fire-and-forget | `publishBusinessEvent` |

### 3.2 范围外（Out of Scope）

- ❌ 客户身份创建 / 合并 / 去重（由 Relations 模块 + EntityAlias 图谱承载，详见 [Relations-联系人.md](./Relations-联系人.md)）
- ❌ 联系人档案编辑（写路径收口在 Relations DetailPanel，本模块只读展示）
- ❌ 营销活动 Campaign / 营销线索 Lead 管理（由 Marketing 模块承载，详见 [Marketing-营销.md](./Marketing-营销.md)）
- ❌ 展会线索转化（由 Seasons 模块的 TradeShowLead 承载，详见 [Seasons-季节展会.md](./Seasons-季节展会.md)）
- ❌ 信用超额自动冻结订单创建门禁（PRD §9.4，已知 P0 缺口，目前仅发布事件未阻断下单）

---

## §4 五维度矩阵

CRM 模块以"客户—跟进—商机—信用—分层"五维度组织，每个 Tab 对应一个独立的状态机或类型封闭集：

| 维度 | Tab | 类型 / 状态集 | 语义徽章映射 |
|------|-----|--------------|-------------|
| 商机管线 | Opportunities | Prospecting / Qualification / Proposal / Negotiation / ClosedWon / ClosedLost | neutral / info / info / warning / success / danger |
| 跟进记录 | Follow-ups | Visit / Call / Email / WeChat / Meeting / Other + 逾期徽章 | 逾期 = danger；类型 = neutral |
| 联系人 | Contacts | Active / Inactive / Left + 主联系人 / 决策人双徽章 | Active = info；主联系人 = success；决策人 = neutral |
| 信用额度 | Credit | Active / Frozen / Expired / Revoked + 用量进度 success/warning/danger | Active = success；其余 = neutral |
| 客户分层 | Tier | Bronze / Silver / Gold / Platinum / VIP | neutral / info / warning / active / success |

**状态机分层原则**：商机阶段流转严格按 `STAGE_TRANSITION_TARGETS` 矩阵执行（前端下拉只渲染合法目标 + 后端 `validateOpportunityTransition` 二次校验），终态 `ClosedWon/ClosedLost` 不允许再流转；信用额度的状态变更（Frozen/Revoked）由 V2 路由的 `PATCH /credit-limit/:id/status` 接收，`Active → Frozen/Revoked` 单向流转，恢复需要重新设置新额度（旧记录永久 Expired）。

---

## §5 核心业务流程图

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  线索     │───▶│  跟进     │───▶│  商机     │───▶│  成交    │
│ (来源:   │    │  FollowUp│    │ Opportunity│   │ ClosedWon│
│  展会/   │    │ (6 类型) │    │ (6 阶段) │   │         │
│  转介绍/ │    └────┬─────┘    └────┬─────┘    └────┬─────┘
│  主动开发)│         │               │               │
└──────────┘         │               │               │
                     │               │               ▼
                     │               │       ┌──────────┐
                     │               │       │  订单     │
                     │               │       │  Order   │
                     │               │       │ (FK oppId)│
                     │               │       └──────────┘
                     │               │
                     │               ▼
                     │       ┌──────────────────────┐
                     │       │ 客户分层 CustomerTier │
                     │       │ Bronze → VIP          │
                     │       │ (折扣 / 账期 / 优先级)│
                     │       └──────────────────────┘
                     │
                     ▼
       ┌────────────────────────────────────┐
       │ 信用额度 CreditLimit               │
       │ 总额度 - 已用 = 可用               │
       │ 已用 = ∑ 未付款 Receivable 发票  │
       │ 超额 → CreditLimitExceeded 事件   │
       └────────────────────────────────────┘

逾期提醒（异步调度）：
  每日 09:30 crmFollowUpWatchdog 扫描 nextFollowUpAt < today
    ├─ today > nextFollowUpAt          → warning（刚逾期）
    └─ today > nextFollowUpAt + 7 天    → critical（严重逾期）
  RiskAlert dedupKey = crm_followup:${fuId}:${nextFollowUpAt}:${tier}
  tier 升级会形成预警升级轨迹（旧 dedupKey 保持 Open，新 dedupKey 触发 critical）
```

**关联双轨制**：
1. **直接 FK 关联**：`Opportunity.relationId` / `FollowUpRecord.relationId` / `CreditLimit.relationId` / `CustomerTier.relationId` 四实体均直接挂客户。
2. **EntityLink 图谱关联**：商机创建 / 更新 / 流转时通过 `syncOpportunityReferences` 双写 `EntityReference + EntityLink`，软删时调 `deactivateEntityLinks` 失效发出的关联，保证客户关联视图实时聚合。

---

## §6 数据模型概要

CRM 模块持久化真源由 5 个核心模型组成（全部挂在 `relationId` 下）：

| 模型 | 角色 | 关键约束 |
|------|------|---------|
| `Contact` | 联系人（多对一 Relation） | `@@index([relationId])` / `@@index([isPrimary])` / 软删 / 主联系人单点（事务内清除其他 primary） |
| `CreditLimit` | 信用额度（多对一 Relation，按时间序历史） | `@@index([relationId])` / `status Active|Frozen|Expired|Revoked` / 设置新额度时旧 Active 批量 Expired |
| `FollowUpRecord` | 跟进记录（多对一 Relation + 可选 Contact / Opportunity / Order） | `@@index([relationId])` / 软删 / 下次跟进日期驱动逾期 |
| `Opportunity` | 商机（多对一 Relation + 可选 Order） | `stage` 6 态 + `probability` 默认按阶段映射 + `closedAt` 终态时间戳 |
| `CustomerTier` | 客户分层（多对一 Relation，按评定时间序历史） | `level` 5 等级 + `discountRate` / `paymentTermsDays` / `creditPriority` 三权益 |

**关键统计口径**：
- `usedAmount`（已用信用额度）= 该 Relation 作为客户关联的未付款 Receivable 发票总额（`Invoice.aggregate _sum amount WHERE status NOT IN ['Paid','Cancelled','Void'] AND type='Receivable' AND order.customerRelationId=relationId`），在 `setCreditLimit` 事务内实时重算。
- 管线汇总（`getOpportunityPipelineSummary`）按 `stage` 分组 `_sum amount`，前端 Kanban 卡片头部直接渲染。
- 联系人列表排序：`isPrimary desc, createdAt desc`（主联系人置顶）。

---

## §7 字段词典与类型契约

CRM 模块的所有 TypeScript 类型契约集中在 [types.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/types.ts) §3089-§3268，与 Prisma 模型字段一一对应：

- 联系人：`Contact` / `ContactInput`（含 `isPrimary` / `isDecisionMaker` / `status Active|Inactive|Left`）
- 信用额度：`CreditLimit` / `CreditLimitInput`（含 `totalLimit` / `usedAmount` / `validFrom` / `validTo` 空表示长期 / `approvedBy` + `approvedAt`）
- 跟进记录：`FollowUpRecord` / `FollowUpInput`（含 `type` 6 类型 / `nextFollowUpAt` + `nextFollowUpTopic` 驱动逾期 / `opportunityId` + `orderId` + `contactId` 三向关联）
- 商机：`Opportunity` / `OpportunityInput` / `OpportunityStage` 6 阶段联合类型 / `probability` 0-100
- 客户分层：`CustomerTier` / `CustomerTierInput` / `CustomerTierLevel` 5 等级联合类型
- 聚合：`CrmOverview`（一次性返回客户名下 5 维全量数据，供前端 `loadCrmData` Promise.all 调用）

前端常量真源在 [CrmManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/CrmManager.tsx) §67-§134，包括 `TABS`（5 Tab）、`OPPORTUNITY_STAGES`（6 阶段 + 语义映射）、`STAGE_TRANSITION_TARGETS`（合法流转矩阵）、`FOLLOWUP_TYPES`（6 类型）、`TIER_LEVELS`（5 等级 + 语义映射）、`CREDIT_STATUS_LABELS`、`SEMANTIC_BADGE_VARIANT`（StatusSemantic → bds-badge 变体映射，active 归并 info，destructive 归并 danger）。

---

## §8 API 端点概要

V2 路由（挂载于 `/api/v2/crm`，全量 requirePermission + relation scope 双校验）：

| 方法 | 路径 | 守卫 | 说明 |
|------|------|------|------|
| GET | `/:relationId/contacts` | crm:read | 联系人列表 |
| POST | `/:relationId/contacts` | crm:write | 创建联系人（事务 + 审计） |
| GET | `/contacts/:id` | crm:read | 单联系人（含 scope 反查） |
| PUT | `/contacts/:id` | crm:write | 更新联系人 |
| DELETE | `/contacts/:id` | crm:write | 软删联系人 |
| GET | `/:relationId/credit-limit` | crm:read | 当前生效信用额度 |
| GET | `/:relationId/credit-limit/history` | crm:read | 历史记录 |
| POST | `/:relationId/credit-limit` | crm:write | 设置新额度（旧 Active → Expired） |
| PATCH | `/credit-limit/:id/status` | crm:write | 状态变更（Frozen/Revoked） |
| GET | `/:relationId/follow-ups` | crm:read | 跟进列表 |
| POST | `/:relationId/follow-ups` | crm:write | 创建跟进（事务 + 审计） |
| GET | `/follow-ups/overdue` | crm:read | 全局逾期列表（按 scope 过滤） |
| GET/PUT/DELETE | `/follow-ups/:id` | crm:read / write | 跟进 CRUD |
| GET/POST | `/:relationId/opportunities` | crm:read / write | 商机列表 / 创建（含 EntityLink 同步） |
| GET/PUT/DELETE | `/opportunities/:id` | crm:read / write | 商机 CRUD |
| POST | `/opportunities/:id/transition` | crm:write | 阶段流转（状态机校验 + 业务事件） |
| GET | `/opportunities/pipeline-summary` | crm:read | 管线汇总（按 stage 分组 count + amount） |
| GET/POST | `/:relationId/customer-tier` | crm:read / write | 当前分层 / 评定新分层 |
| GET | `/:relationId/customer-tier/history` | crm:read | 分层历史 |
| DELETE | `/customer-tier/:id` | crm:write | 软删分层 |
| GET | `/:relationId/overview` | crm:read | CRM 总览（5 维聚合，单次调用） |

行级 Scope 校验在 `checkRelationScope`：先 `permSvc.getDataScopeResolver(actor, 'relations')`，再按 `kind=all/self/department` 三档过滤；逾期列表全局查询后再按 scope 二次过滤。

---

## §9 权限矩阵与行级 Scope

| 角色 | 客户列表可见 | 跟进 / 商机读写 | 信用额度 | 客户分层 |
|------|---------|---------|---------|---------|
| admin / manager | 全部 | ✅ 全部 | ✅ 设置 + 状态变更 | ✅ 评定 + 删除 |
| sales | ownerId=me | ✅ 仅自己的客户 | ⚠️ 仅设置（需审批） | ⚠️ 仅评定 |
| merchandiser | 同部门 | ✅ 同部门客户 | ❌ 只读 | ❌ 只读 |
| finance | 全部 | ❌ 只读 | ✅ 设置 + 状态变更 | ❌ 只读 |
| agent（API Key） | 全部 | ❌ 只读 | ❌ 只读 | ❌ 只读 |

行级 Scope 真源在 `permissionService.getDataScopeResolver(actor, 'relations')`，规则三档：
- `kind=all` → 不过滤（admin / manager）
- `kind=self` → `OR [{ ownerId: actor.userId }, { salesRepIds: { has: actor.userId } }]`
- `kind=department` → `OR [{ ownerId: { in: userIds } }, { salesRepIds: { hasSome: userIds } }, { departmentId: { in: deptIds } }]`

写入守卫顺序：`createModuleAuthGuard → requireJwtForWrite → requirePermission('crm:write') → requireRelationScope`。

---

## §10 设计系统约束

本模块遵循 BDS v2.1 中性契约（与 OrderManager / SeasonsManager 同口径）：

- **组件族**：`bds-card / bds-btn / bds-input / bds-select / bds-modal / bds-tabs / bds-tab / bds-badge / bds-progress / bds-empty / bds-overline / bds-tnum`
- **主题透明**：组件对 `isDarkMode` 透明，暗色由 `tokens.css [data-theme]` 统一覆盖；`isDarkMode` 仅保留在 props 签名兼容调用方
- **徽章语义映射**：`SEMANTIC_BADGE_VARIANT` 把 `StatusSemantic`（8 态）映射到 `bds-badge`（5 变体），其中 `active → info`、`destructive → danger`、`rebate → info` 三处归并
- **用量进度条**：`bds-progress` 三档（success / warning / danger）按 `usedAmount / totalLimit` 比例切换：>80% warning、超额度 danger
- **逾期面板**：`rounded-card + var(--danger-tint) + var(--danger-text)`，顶部 AlertCircle + 红色 Clock 图标
- **空态**：`bds-empty` + Lucide 图标（无吉祥物 / 无插画），与全局空态契约一致

---

## §11 业务规则接入状态

| 规则 | 接入状态 | 备注 |
|------|---------|------|
| §9.4 信用控制 60 天逾期冻结 | ⚠️ 仅 `CreditLimitExceeded` 事件发布，未阻断订单创建 | P0 缺口 |
| 商机阶段流转状态机 | ✅ 前端下拉只渲染合法目标 + 后端 `validateOpportunityTransition` 二次校验 + 终态 `closedAt` 时间戳 | — |
| 信用额度重算 | ✅ 设置新额度时事务内调 `calculateUsedCredit` 重算 usedAmount | — |
| 客户分层权益继承 | ⚠️ 折扣率 / 账期字段已建，订单 / 报价模块未读取应用 | P1 缺口 |
| 跟进逾期双档预警 | ✅ warning / critical + dedupKey 幂等 + tier 升级轨迹 | — |
| EntityLink 图谱同步 | ✅ 商机创建 / 更新 / 流转 / 软删四节点双写 EntityReference + EntityLink | — |
| 业务事件 fire-and-forget | ✅ 5 类事件发布失败不阻断业务（仅 logger.error） | — |

---

## §12 状态机与生命周期

### 12.1 商机阶段流转矩阵（`STAGE_TRANSITION_TARGETS`）

| 当前阶段 | 合法流转目标 | 默认概率 |
|---------|------------|---------|
| Prospecting | Qualification / ClosedLost | 10% |
| Qualification | Proposal / ClosedLost | 25% |
| Proposal | Negotiation / ClosedLost | 50% |
| Negotiation | ClosedWon / ClosedLost | 75% |
| ClosedWon | （终态） | 100% |
| ClosedLost | （终态） | 0% |

流转时若目标为 `ClosedWon / ClosedLost`，自动写入 `closedAt` 时间戳；`probability` 自动重置为 `STAGE_DEFAULT_PROBABILITY`。

### 12.2 信用额度生命周期

```
新建（Active）─┬─→ Frozen（冻结，可解冻回 Active 通过新设置）
              ├─→ Revoked（撤销，不可恢复，需新建）
              └─→ Expired（被新设置覆盖，永久不可恢复）
```

### 12.3 客户分层生命周期

`assignCustomerTier` 时事务内将所有未过期的旧分层 `validUntil = evaluatedAt` 强制过期，新分层为唯一生效；删除走软删（`deletedAt`）。

### 12.4 联系人状态

`Active`（在职）→ `Inactive`（非活跃）→ `Left`（离职）；软删时 `isPrimary` 强制置 false，避免主联系人引用失效。

---

## §13 待补的设计缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | 信用超额自动冻结订单创建门禁（§9.4） | P0 | 订单录入 / 状态推进 |
| 2 | 客户分层权益（折扣率 / 账期）在订单 / 报价模块读取应用 | P1 | Pricing / Quotation |
| 3 | CRM 概览面板未上 Dashboard 首页 | P1 | Dashboard |
| 4 | 商机成交 → 订单 FK 双向绑定（`Opportunity.orderId` 已建，未自动填充） | P1 | Opportunity → Order 联动 |
| 5 | 跟进记录与邮件 / 微信通信日志双向关联（`attachments` JSON 已建，无 UI） | P2 | Email 模块联动 |
| 6 | 客户 360° 画像聚合接口（`getRelationCrmOverview` 已有，无独立 Dashboard 卡片） | P2 | CRM 总览页 |

---

## §14 实现状态总览

| 子能力 | 状态 | 真源 |
|--------|------|------|
| 5 Tab + 客户选择器 + 跨模块跳转 | ✅ | `CrmManager` L158-L548 |
| 商机 6 阶段 Kanban + 流转 + 管线汇总 | ✅ | `OpportunitiesTab` + `crmService.transitionOpportunityStage` |
| 跟进记录 CRUD + 逾期提醒红色面板 | ✅ | `FollowUpsTab` + `listOverdueFollowUps` |
| 联系人只读 + 跳转 Relations 编辑 | ✅ | `ContactsTab` + `primeRelationsOrgDetailPreview` |
| 信用额度三栏 + 进度条 + 状态变更 + 历史 | ✅ | `CreditLimitTab` + `setCreditLimit` |
| 客户分层 5 等级 + 三权益 + 历史 | ✅ | `CustomerTierTab` + `assignCustomerTier` |
| 客户关联视图（EntityLink 图谱） | ✅ | `RelatedEntitiesPanel` type=`relation.organization` |
| 跟进逾期 watchdog（每日 09:30 + warning/critical 双档） | ✅ | `crmFollowUpWatchdog` + `riskService.raiseAlert` |
| 5 类业务事件发布 | ✅ | `publishBusinessEvent` |
| V2 路由行级 Scope + requirePermission 双守卫 | ✅ | `crmRouteV2` + `checkRelationScope` |
| 信用超额冻结订单门禁 | ⚠️ 缺口 | 订单创建 / 推进未校验 |
| 分层权益下游应用 | ⚠️ 缺口 | Pricing / Quotation |

---

## §15 交叉链接

1. [Relations-联系人](./Relations-联系人.md) — 客户身份真源 / 联系人档案写路径 / EntityAlias 合并去重图谱
2. [Seasons-季节展会](./Seasons-季节展会.md) — 展会线索 → Relation 转化 → CRM 商机归集
3. [Marketing-营销](./Marketing-营销.md) — 营销活动线索 / 佣金规则（与客户分层权益联动）
4. [订单管理 模块概述](../03-订单与生产/Orders-订单管理/模块概述.md) — 订单 `customerRelationId` 反向归集 + 信用超额门禁落点
5. [定价与成本 模块概述](../03-订单与生产/Pricing-定价与成本/模块概述.md) — 客户分层折扣率 / 账期应用落点
6. [信用控制规则](../../03-业务规则/信用控制规则.md) — §9.4 信用控制 60 天逾期冻结业务规则真源
7. [实体关系总览](../../02-数据模型/实体关系总览.md) — Relation / Contact / EntityAlias / EntityLink 模型关系图

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| 前端组件真源 | [components/CrmManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/CrmManager.tsx) |
| 后端服务真源 | [server/src/crm/crmService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/crm/crmService.ts) |
| V2 路由 + 行级 scope | [server/src/crm/crmRouteV2.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/crm/crmRouteV2.ts) |
| 逾期扫描任务 | [server/src/scheduler/tasks/crmFollowUpWatchdog.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/scheduler/tasks/crmFollowUpWatchdog.ts) |
| 商机 EntityLink 同步 | [server/src/entities/sync.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/entities/sync.ts) `syncOpportunityReferences` |
| Prisma 模型真源 | [server/prisma/schema.prisma](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/prisma/schema.prisma) Contact/CreditLimit/FollowUpRecord/Opportunity/CustomerTier |
| 前端类型定义 | [types.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/types.ts) §3089-§3268 |
| 跨模块跳转 helper | [components/RelationsManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/RelationsManager.tsx) `primeRelationsOrgDetailPreview` |
