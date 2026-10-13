# 营销模块设计 (Marketing)

## §1 元信息

| 项 | 值 |
|---|---|
| **模块定位** | 客户与开拓域的"加速器"——将产品档案（ProductAsset）+ 客户身份（Relation）+ 季节/展会（Season/TradeShow）三类真源编排为可对外输出的营销资产（电子画册 / 面料推荐）+ 可追溯的活动—线索漏斗（Campaign/Lead）+ 邮件模板库 + 中间人佣金规则；本身不持有客户身份或产品档案真源，仅做"快照 + 编排 + 命中" |
| **模块边界** | 电子画册 CRUD + 状态机 + 条目服务端快照；面料推荐确定性打分引擎 + criteria/results 落库；营销活动 Campaign CRUD + 行级 scope + ROI；营销线索 Lead CRUD + 状态流转 + 转化追踪；邮件模板 CRUD + 标准模板库 + AI 生成草稿 + 使用统计；中间人佣金规则 CRUD + 命中查找；不含客户档案编辑、不含产品档案编辑、不含邮件发送通道（由 email 模块 outbox 承载） |
| **核心角色** | 业务员（含画册发布、面料推荐查询、线索录入）、销售主管（活动预算、ROI 审阅、线索转化，部门管理职责）、超级管理员（老板，绝密级可见：活动 ROI 汇总）、财务（含佣金规则只读，宽泛容器不细分） |
| **范式** | 范式 A（顶部 Tab 切换）+ 范式 E（录入 Modal）双态切换；Campaign/Lead Tab 尚未接入客户端（见 §14） |
| **优先级** | P2（开拓增强；画册 / 推荐已落地，Campaign/Lead 为 P2 后端已就绪待前端补齐） |
| **实现状态** | 🟡 部分落地（画册全链路 + 面料推荐引擎 + 邮件模板库 + 佣金规则服务均已生产可用；Campaign/Lead 后端 V2 路由 + 服务 + 行级 scope 已就绪但前端 MarketingManager 未接入对应 Tab，是 P0 客户端缺口；CommissionRule 服务已就绪但路由 + 前端管理 UI 缺失） |
| **关联 PRD 章节** | §5.7（营销管理）、§6.2（电子画册 / 面料推荐 P2）、§7.2（面料推荐确定性打分）、§8.5（中间人佣金 E5/E10）、§12.1（业务邮件模板库）、§24.2（分组导航） |
| **关联代码** | [MarketingManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/MarketingManager.tsx) 桌面端主组件（2 Tab） / [marketingService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/marketing/marketingService.ts) Campaign/Lead 服务 / [marketingRouteV2.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/marketing/marketingRouteV2.ts) V2 路由 + 行级 scope / [lookbookService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/products/lookbookService.ts) 画册服务 / [fabricRecommendationService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/products/fabricRecommendationService.ts) 推荐引擎 / [templateRoute.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/email/templateRoute.ts) 邮件模板路由 / [commissionService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/pricing/commissionService.ts) 佣金规则服务 / `server/prisma/schema.prisma` MarketingCampaign/MarketingLead/LookbookCatalog/FabricRecommendation/EmailTemplate/CommissionRule 模型 |

---

## §2 模块边界与上下文

营销模块在客户与开拓域的位置可概括为"**身份在 Relations，产品在 Products，营销做编排**"：

- **客户身份真源**：Campaign/Lead 通过 `relationId` 反向引用客户档案；Lead 转化为 Converted 时写入 `convertedAt`，下游 CRM 模块的 `Opportunity` 通过 `relationId` 接续承接（详见 [CRM-客户跟进.md](./CRM-客户跟进.md)）。本模块不重复维护客户档案。
- **产品档案真源**：电子画册的条目 `LookbookItemSnapshot` 在服务端 `buildItemSnapshots` 中按 `productAssetId` 反查 `ProductAsset` + `ProductImage` 重取 sku/name/imageUrl，客户端仅提供选择依据（`productAssetId`）与展示参数（`price/currency/description/sortOrder`），防止客户端伪造产品名称或图片。
- **季节 / 展会真源**：Campaign 通过 `seasonId` / `tradeShowId` 双 FK 关联 Seasons 模块的 `Season` / `TradeShow`（详见 [Seasons-季节展会.md](./Seasons-季节展会.md)），用于活动—季节—展会三维归因。
- **邮件发送通道**：EmailTemplate 仅承载模板文本与 `{{var}}` 占位符清单，实际发送由 email 模块的 `emailOutboxMutationService` + `outboxSend` 通道承载（templateRoute 不直接发送邮件）。
- **中间人佣金命中**：CommissionRule 是佣金率的"配置真源"，由 `pricing` 模块的 `calculateTrackB` 在生成 Track B 退税美元定价时通过 `lookupCommissionRate(intermediaryRelationId)` 命中（精确命中优先 → 默认规则兜底 → 无命中返回 null）；本模块不参与佣金金额计算，仅维护规则配置。

下游模块（报价 / 订单 / 财务）通过 `commissionRuleId` / `commissionRate` snapshot FK 反向归集佣金成本；本模块不直接发起跨域写入。

---

## §3 模块范围与核心能力

### 3.1 范围内（In Scope）

| 能力 | 说明 | 代码入口 |
|------|------|---------|
| 电子画册 | Draft → Published → Archived 状态机 + 条目服务端档案真源快照 + 单画册条目上限 200 + 重复 productAssetId 校验 + 软删除 | `LookbooksPanel` + `lookbookService` |
| 面料推荐 | 确定性打分纯函数 `scoreFabricCandidate`（季节 +30 / 预算 +30 / 成分 +10/个至多 3 / 克重 +20 / 花型 +10 / 现货 +5）+ criteria/results 快照落库 + 历史可回看 | `FabricRecommendPanel` + `fabricRecommendationService.recommend` |
| 营销活动 | Campaign CRUD + Sequence 编号（MKT-YYYY-NNNN）+ 预算 / 实际花费 + 类型 / 状态 / 目标客户群 + seasonId/tradeShowId 双 FK + 行级 scope | `marketingService.listCampaigns/createCampaign/updateCampaign/deleteCampaign` |
| 活动 ROI | 转化率 = ConvertedLeads / TotalLeads + ROI = (totalActualValue - actualCost) / actualCost + 预算 / 实际花费 / 估价值 / 实际转化值聚合 | `marketingService.getCampaignROI` |
| 营销线索 | Lead CRUD + 5 状态（New/Contacted/Qualified/Converted/Lost）+ 转化时间戳 `convertedAt` + 关联客户 `relationId` + 来源 / 联系人 / 估价值 | `marketingService.listLeads/createLead/updateLead/deleteLead` |
| 邮件模板 | 6 类型（quote/payment_reminder/delivery_notice/inspection_report/greeting/general）+ `{{var}}` 自动解析 + 标准模板库幂等播种 + 使用统计（usageCount/lastUsedAt）+ 软删除 | `templateRoute` + `seedStandardEmailTemplates` |
| AI 模板草稿 | 按场景描述 LLM 生成草稿（不落库，用户确认后走 POST / 保存）+ 严格 JSON 输出 + variables 自动解析 | `templateRoute` POST `/ai-generate` |
| 佣金规则 | E5/E10 双档率（5/10）+ 中间人精确命中优先 + 默认规则兜底 + 占位唯一（同中间人或默认仅一条启用）+ 软删除 | `commissionService` |

### 3.2 范围外（Out of Scope）

- ❌ 客户身份创建 / 合并 / 去重（由 Relations 模块 + EntityAlias 图谱承载，详见 [Relations-联系人.md](./Relations-联系人.md)）
- ❌ 产品档案编辑 / 图片上传（由 Products 模块承载；画册仅做快照重取）
- ❌ 邮件实际发送通道 / 邮件同步 / 邮件分类（由 email 模块的 outbox/sync/classification 承载）
- ❌ 报价单据生成 / 单据模板（由 Quotations / DocumentTemplate 承载，详见 [Quotations-报价/模块概述.md](./Quotations-报价/模块概述.md)）
- ❌ 佣金金额计算 / 利润表 Track B 实际应用（由 Pricing 模块 `calculateTrackB` 承载，本模块仅维护规则配置）
- ❌ 展会线索 ROI 直接转化（Seasons 模块 TradeShowLead 已有自己的状态机；本模块的 Campaign Lead 与 TradeShowLead 是两条并行线索流，需 P2 级别统一编排，目前未打通）

---

## §4 营销能力矩阵

营销模块以"**画册—推荐—活动—线索—模板—佣金**"六维度组织，分别对应不同状态机或类型封闭集：

| 维度 | 入口 | 类型 / 状态集 | 语义徽章映射 |
|------|-----|--------------|-------------|
| 电子画册 | Lookbooks Tab | Draft / Published / Archived | Draft = neutral；Published = success；Archived = neutral |
| 面料推荐 | Fabric Recommend Tab | 推荐分数 ≥60 success / 30-59 warning / <30 neutral | 三档徽章按 score 自动切换 |
| 营销活动 | （后端就绪，前端未接入） | Draft / Active / Paused / Completed / Cancelled | 待 UI 接入后定义映射 |
| 营销线索 | （后端就绪，前端未接入） | New / Contacted / Qualified / Converted / Lost | 待 UI 接入后定义映射 |
| 邮件模板 | email-templates 路由 + 邮件编辑器调用 | quote / payment_reminder / delivery_notice / inspection_report / greeting / general | 不展示状态徽章（按 type 分类） |
| 佣金规则 | commissionService（路由 + UI 未上） | E5 (rate=5) / E10 (rate=10) + 默认规则（intermediaryRelationId 空）| 待 UI 接入后定义映射 |

**状态机分层原则**：画册状态机严格按 `Draft → Published（须 ≥1 条目，写 publishedAt）→ Archived` 流转，Published 可回退 Draft（清 publishedAt），Archived 为终态不可再修改条目；Lead 状态流转至 Converted 时自动写入 `convertedAt` 时间戳；CommissionRule 的 `isActive` 切换需重新校验占位唯一（同中间人或默认仅允许一条启用）。

---

## §5 核心业务流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│  营销活动 Campaign (MKT-YYYY-NNNN)                                   │
│  ├─ type: exhibition / digitalAd / email / socialMedia / printAd /   │
│  │        referral / other                                           │
│  ├─ status: Draft → Active → Paused → Completed / Cancelled          │
│  ├─ budget / actualCost / targetSegment (JSON)                       │
│  ├─ seasonId ──▶ Season (Seasons 模块)                               │
│  └─ tradeShowId ─▶ TradeShow (Seasons 模块)                          │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────────┐                                                │
│  │  营销线索 Lead   │                                                │
│  │  New → Contacted │                                                │
│  │  → Qualified     │                                                │
│  │  → Converted     │── convertedAt + actualValue                    │
│  │  → Lost          │                                                │
│  └────┬─────────────┘                                                │
│       │ relationId                                                   │
│       ▼                                                              │
│  ┌──────────────────┐                                                │
│  │ Relation 客户    │──▶ CRM Opportunity (承接线索转化)               │
│  │ (Relations 模块) │                                                │
│  └──────────────────┘                                                │
│                                                                      │
│  活动 ROI = (Σ Converted.actualValue - actualCost) / actualCost      │
│  转化率 = ConvertedLeads / TotalLeads                                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  电子画册 LookbookCatalog (LB__xxxxxx)                               │
│  Draft ──publish(≥1 item)──▶ Published ──unpublish──▶ Draft           │
│  Draft / Published ──archive──▶ Archived (终态)                       │
│  items: 服务端从 ProductAsset + ProductImage 重取快照                │
│         [{ productAssetId, sku, name, imageUrl, price, currency,     │
│            description, sortOrder }]                                 │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  面料推荐 FabricRecommendation (FR__xxxxxx)                          │
│  criteria: { season, budgetMin/Max, currency, compositionKeywords,  │
│              weightMin/Max, pattern, limit }                        │
│         │                                                            │
│         ▼ 装配候选集（FabricProfile + 最新同币种价格 + 成分行）       │
│  ┌──────────────────────────────────────────┐                        │
│  │ scoreFabricCandidate (纯函数，可解释)    │                        │
│  │  季节匹配        +30                     │                        │
│  │  预算内          +30（边界外 20% 内 +15）│                        │
│  │  成分关键词      +10/个 至多 3 个         │                        │
│  │  克重范围        +20                     │                        │
│  │  花型匹配        +10                     │                        │
│  │  现货            +5                      │                        │
│  └────────────────┬─────────────────────┘                        │
│                   │ filter score > 0 + sort desc + slice limit       │
│                   ▼                                                  │
│  results: [{ productAssetId, sku, name, score, reasons,             │
│              season, latestPrice, priceCurrency, weightValue,       │
│              weightUnit, pattern, millName }]                       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  邮件模板 EmailTemplate (EMTPL__xxxxxx)                              │
│  6 type × {{var}} 自动解析 + 标准模板库（5 封）幂等播种               │
│  ├─ quote / payment_reminder / delivery_notice /                    │
│  │  inspection_report / greeting / general                          │
│  ├─ usageCount / lastUsedAt (C8 使用统计)                            │
│  └─ AI 生成草稿 → 用户确认 → POST / 保存                             │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  佣金规则 CommissionRule (CR__xxxxxx)                                │
│  rate: 5 (E5) | 10 (E10)                                            │
│  intermediaryRelationId:                                              │
│    ├─ 精确命中（isActive）──▶ 返回 { ruleId, rate }                  │
│    ├─ 为空时默认规则兜底 ──▶ 返回默认 { ruleId, rate }                │
│    └─ 均无命中 ─▶ null（无佣金，commissionRate=0）                    │
│  占位唯一：同中间人 / 默认仅允许一条 isActive=true                   │
└─────────────────────────────────────────────────────────────────────┘
```

**关联双轨制**：
1. **直接 FK 关联**：`Campaign.seasonId` / `Campaign.tradeShowId` / `Lead.campaignId` / `Lead.relationId` / `CommissionRule.intermediaryRelationId` 五处直接 FK。
2. **快照真源重取**：画册条目 SKU/名称/主图在每次 `setLookbookItems` 时服务端按 `productAssetId` 反查 ProductAsset + ProductImage 重取快照，客户端无法伪造。

---

## §6 数据模型概要

营销模块持久化真源由 6 个核心模型组成（分布在 marketing/products/email/pricing 四个 Prisma 域）：

| 模型 | 角色 | 关键约束 |
|------|------|---------|
| `MarketingCampaign` | 营销活动（行级 scope：ownerId/departmentId） | `code` Sequence 唯一 / `status` 5 态 / `type` 7 类 / `budget/actualCost` Decimal / `targetSegment` JSON / `seasonId/tradeShowId` 双 FK / `ownerId/departmentId` 行级权限 |
| `MarketingLead` | 营销线索（多对一 Campaign + 可选 Relation） | `@@index([campaignId])` / `status` 5 态（New/Contacted/Qualified/Converted/Lost）/ `convertedAt` 转化时间戳 / `estimatedValue/actualValue` Decimal / 软删 |
| `LookbookCatalog` | 电子画册（条目为 JSON 快照数组） | `id` 前缀 LB__ / `status` 3 态 / `items` Json 默认 `[]` / `publishedAt` 发布时间戳 / `@@index([status])` / 软删 |
| `FabricRecommendation` | 面料推荐记录（criteria + results 双 JSON 快照） | `id` 前缀 FR__ / `criteria/results` Json / `createdBy` 操作者 / 软删 / `@@index([createdAt])` |
| `EmailTemplate` | 邮件模板（6 类型 × `{{var}}` 自动解析） | `id` 前缀 EMTPL__ / `type` 6 类 / `variables` String[] / `usageCount/lastUsedAt` C8 使用统计 / `isActive` / 软删 / `@@index([type])` / `@@index([isActive])` |
| `CommissionRule` | 中间人佣金规则（E5/E10 配置真源） | `id` 前缀 CR__ / `rate` Decimal(8,4) 仅允许 5/10 / `intermediaryRelationId` 空=默认规则 / `intermediaryName` 名称快照 / `isActive` 占位唯一 / 软删 / `@@index([intermediaryRelationId, isActive])` |

**关键统计口径**：
- Campaign ROI（`getCampaignROI`）：`conversionRate = convertedLeads.length / totalLeads.length`；`roi = (totalActualValue - actualCost) / actualCost`（actualCost 为 0 时 roi=0）。`totalEstimatedValue` / `totalActualValue` 通过 `leads.reduce` 累加，BigInt 统一 `.toString()` 后 `Number()` 转换。
- 画册条目排序：`buildItemSnapshots` 内按 `sortOrder` 升序排序后写回，客户端 drafts 数组顺序即 sortOrder（未指定时取 index）。
- 面料推荐候选装配：`loadCandidates` 一次性 `_findMany` 所有未删 FabricProfile + ProductAsset（含 fabricPrices + compositionLines），同币种价格优先取最新（`orderBy updatedAt desc`），无同币种回退取最新一条。
- 佣金规则命中：`lookupCommissionRate` 先按 `intermediaryRelationId` 精确 `findFirst`，再按 `intermediaryRelationId: null` 默认兜底，均无命中返回 `null`。

---

## §7 字段词典与类型契约

营销模块的 TypeScript 类型契约集中在 [types.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/types.ts) §4624-§4715，与 Prisma 模型字段一一对应：

- **佣金规则**：`CommissionRule` / `CommissionRuleInput`（含 `rate` 仅允许 5/10 / `intermediaryRelationId` 空为默认 / `intermediaryName` 快照）/ `CommissionRulePatch = Partial<CommissionRuleInput>`
- **电子画册**：`LookbookStatus = 'Draft' | 'Published' | 'Archived'` 联合类型 / `LookbookItemSnapshot`（含 `productAssetId/sku/name/imageUrl/description/price/currency/sortOrder`）/ `LookbookItemInput`（客户端仅提供 `productAssetId/price/currency/description/sortOrder`，SKU/name/imageUrl 由服务端重取）/ `LookbookCatalog`
- **面料推荐**：`RecommendCriteria`（含 `season/budgetMin/Max/currency/compositionKeywords/weightMin/Max/pattern/limit`）/ `RecommendResultItem`（含 `score/reasons/season/latestPrice/priceCurrency/weightValue/weightUnit/pattern/millName`）/ `FabricRecommendation`
- **邮件模板**：Prisma 模型直接消费（type/name/subject/body/variables/usageCount/lastUsedAt/isActive），无独立 TS interface
- **营销活动 / 线索**：Prisma 模型直接消费（MarketingCampaign/MarketingLead），服务层 `CampaignInput`/`LeadInput` interface 在 `marketingService.ts` 内定义（不导出至全局 types.ts）

前端常量真源在 [MarketingManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/MarketingManager.tsx) §44-§96，包括 `MODULE_TABS`（2 Tab：lookbooks/fabricRecommend）、`LOOKBOOK_STATUS_LABELS`（3 态中文映射）、`LOOKBOOK_STATUS_BADGE`（3 态 → bds-badge 变体映射：Draft=neutral / Published=success / Archived=neutral）、`summarizeCriteria`（推荐条件概要文本生成，用于历史列表展示）。

后端常量真源：
- `fabricRecommendationService.ts` §50-§53：`MAX_LIMIT=50` / `DEFAULT_LIMIT=10` / `MAX_KEYWORDS=3` / `BUDGET_NEAR_TOLERANCE=0.2`（边界外 20% 内给半分 15 分）
- `lookbookService.ts` §44：`LOOKBOOK_STATUSES = ['Draft','Published','Archived']`
- `commissionService.ts` §32：`ALLOWED_RATES = [5, 10]`
- `templateRoute.ts` §34：`TEMPLATE_TYPES = ['quote','payment_reminder','delivery_notice','inspection_report','greeting','general']`

---

## §8 API 端点概要

营销模块的 API 路由分布在 4 个挂载点：

### 8.1 营销活动 V2 路由（挂载于 `/api/v2/marketing`，requirePermission + 行级 scope 双校验）

| 方法 | 路径 | 守卫 | 说明 |
|------|------|------|------|
| GET | `/campaigns` | marketing:read | 活动列表（status/type/search 筛选 + 行级 scope） |
| POST | `/campaigns` | marketing:write | 创建活动（Sequence 编号 MKT-YYYY-NNNN） |
| GET | `/campaigns/:id` | marketing:read | 活动详情（含 leads） |
| PUT | `/campaigns/:id` | marketing:write | 更新活动 |
| DELETE | `/campaigns/:id` | marketing:write | 软删除活动 |
| GET | `/campaigns/:id/roi` | marketing:read | 活动 ROI 聚合 |
| GET | `/campaigns/:id/leads` | marketing:read | 活动线索列表（先校验 campaign 在 scope 内） |
| POST | `/campaigns/:id/leads` | marketing:write | 创建线索（campaignId 来自路径） |
| PUT | `/leads/:id` | marketing:write | 更新线索（含 Converted → convertedAt 自动写入） |
| DELETE | `/leads/:id` | marketing:write | 软删除线索 |

行级 Scope 校验在 `buildScopeWhere`：先 `permSvc.getDataScopeResolver(actor, 'marketing')`，再按 `kind=all/self/department` 三档过滤；Lead 写操作额外校验所属 campaign 的 `ownerId` 在 actor scope 内。

### 8.2 电子画册路由（挂载于 `/api/v1/lookbooks`，详见 lookbookRoute.ts）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 画册列表（status 筛选 + 分页） |
| POST | `/` | 新建画册（status=Draft, items=[]） |
| GET | `/:id` | 画册详情 |
| PUT | `/:id` | 更新画册（Archived 不可改） |
| PUT | `/:id/items` | 整表替换条目（服务端重取快照，幂等） |
| POST | `/:id/publish` | 发布（须 ≥1 条目，写 publishedAt） |
| POST | `/:id/unpublish` | 回退为 Draft（清 publishedAt） |
| POST | `/:id/archive` | 归档（终态） |
| DELETE | `/:id` | 软删除 |

### 8.3 面料推荐路由（挂载于 `/api/v1/fabric-recommendations`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/recommend` | 执行推荐（criteria 校验 + 落库 + 返回完整记录） |
| GET | `/` | 历史列表（分页） |
| GET | `/:id` | 单条详情 |
| DELETE | `/:id` | 软删除 |

### 8.4 邮件模板路由（挂载于 `/api/v1/email-templates`，读 JWT/API-Key，写必须 JWT）

| 方法 | 路径 | 守卫 | 说明 |
|------|------|------|------|
| GET | `/` | 读 | 模板列表（type 筛选 + includeInactive + sort=usage） |
| POST | `/` | 写 | 新建（variables 自动从 subject/body 解析） |
| PATCH | `/:id` | 写 | 更新（改 subject/body 时重解析 variables） |
| POST | `/:id/use` | 读 | C8 使用统计上报（usageCount++ + lastUsedAt） |
| POST | `/ai-generate` | 写 | C8 AI 生成草稿（不落库，返回 draft） |
| DELETE | `/:id` | 写 | 软删除 |
| POST | `/seed` | 写 | 幂等播种 5 封标准业务模板（同 type+name 已存在则跳过） |

### 8.5 佣金规则路由

⚠️ **路由未上**：`commissionService.ts` 已就绪（createCommissionRule/listCommissionRules/updateCommissionRule/deleteCommissionRule/lookupCommissionRate），但 `pricingRoute.ts` 暂未暴露佣金规则管理端点；`lookupCommissionRate` 当前仅由 `pricing` 模块内部 `calculateTrackB` 直接调用。**P1 缺口**：佣金规则路由 + 前端管理 UI 需补齐。

---

## §9 权限矩阵与行级 Scope

### 9.1 Campaign/Lead 行级 Scope（marketing 域）

| 角色 | 活动可见 | 活动 / 线索读写 | ROI 查看 |
|------|---------|---------|---------|
| admin / manager | 全部 | ✅ 全部 | ✅ |
| sales | ownerId=me | ✅ 仅自己的活动 | ✅ |
| merchandiser | 同部门 | ⚠️ 同部门只读 | ⚠️ |
| finance | 全部 | ❌ 只读 | ✅ |
| agent（API Key） | 全部 | ❌ 只读 | ❌ |

行级 Scope 真源在 `permissionService.getDataScopeResolver(actor, 'marketing')`，规则三档：
- `kind=all` → 不过滤（admin / manager）
- `kind=self` → `{ ownerId: actor.userId }`
- `kind=department` → `OR [{ ownerId: { in: userIds } }, { departmentId: { in: deptIds } }]`

写入守卫顺序：`createModuleAuthGuard → requireJwtForWrite → requirePermission('marketing:write') → buildScopeWhere`。

### 9.2 画册 / 推荐权限

- 画册 / 推荐路由当前未接入 `requirePermission` 守卫，仅 `createModuleAuthGuard` + `requireJwtForWrite` 双层守卫（读 JWT 或 API-Key，写必须 JWT）。**P1 缺口**：画册发布 / 推荐执行应接入 `marketing:write` 权限位。
- 画册的 `createdBy` 字段记录创建者，但当前未做行级 scope 过滤（所有认证用户可见全部画册）。

### 9.3 邮件模板权限

- 读：JWT 或 API-Key 任一通过 `createModuleAuthGuard` 即可（与 email 模块同口径）。
- 写（新建 / 更新 / 删除 / 播种 / AI 生成）：必须 JWT（`requireJwtForWrite`），无 `requirePermission` 守卫。**P1 缺口**：邮件模板管理应接入 `marketing:write` 或 `email:write` 权限位。

### 9.4 佣金规则权限

- `commissionService` 内无 actor 校验（所有方法接收 actorId 用于审计日志，但不做 scope 过滤）。**P1 缺口**：佣金规则属财务敏感配置，应接入 `finance:write` 权限位 + 行级 scope（finance 可写，sales 只读）。

---

## §10 设计系统约束

本模块遵循 BDS v2.1 中性契约（与 CrmManager / SeasonsManager 同口径）：

- **组件族**：`bds-card / bds-btn / bds-input / bds-select / bds-modal / bds-tabs / bds-tab / bds-badge / bds-segment / bds-empty / bds-overline / bds-tnum`
- **主题透明**：组件对 `isDarkMode` 透明（MarketingManager 在 props 签名保留 `isDarkMode` 兼容调用方，组件内不再使用），暗色由 `tokens.css [data-theme]` 统一覆盖
- **画册徽章映射**：`LOOKBOOK_STATUS_BADGE` 把 3 态映射到 `bds-badge`（Draft=neutral / Published=success / Archived=neutral）
- **推荐分数徽章**：≥60 → `success`、30-59 → `warning`、<30 → `neutral`，按 `r.score` 自动切换
- **画册状态机按钮**：Published 显示撤回（RotateCcw）+ 归档（Archive）；Draft 显示发布（Upload）+ 归档；Archived 终态仅显示删除；按钮统一 `bds-btn-ghost bds-btn-icon sm` + Lucide 图标
- **条目编辑器**：整表替换式（本地维护 drafts 数组，保存时 `setLookbookItems` 整表 PUT），服务端按档案真源重取快照；产品选择器为 `bds-select` 下拉，已选产品自动从可选项中过滤
- **推荐条件网格**：4 列 grid 布局，季节 / 预算下限 / 预算上限 / 预算币种 / 成分关键词 / 克重下限 / 克重上限 / 花型 8 字段 + 返回条数 + 执行按钮（带 `Wand2` 图标）
- **空态**：`bds-empty` + 中文提示（"暂无画册，点击「新建画册」开始" / "无候选命中，请放宽条件" / "暂无推荐记录"），与全局空态契约一致

---

## §11 业务规则接入状态

| 规则 | 接入状态 | 备注 |
|------|---------|------|
| §5.7 营销活动 5 状态机 | ⚠️ 后端 service + route 已就绪，前端未接入 Tab | P0 客户端缺口 |
| §5.7 线索 5 状态机 + 转化追踪 | ⚠️ 后端 `convertedAt` 自动写入已实现，前端未接入 | P0 客户端缺口 |
| §6.2 电子画册状态机（Draft → Published → Archived） | ✅ `lookbookService` 完整实现 + Published 须 ≥1 条目校验 + Archived 终态不可改 | — |
| §6.2 画册条目服务端档案真源快照 | ✅ `buildItemSnapshots` 服务端反查 ProductAsset + ProductImage 重取 sku/name/imageUrl | — |
| §6.2 单画册条目上限 200 | ✅ `buildItemSnapshots` 内 `if (items.length > 200) throw` | — |
| §6.2 画册条目不可重复 | ✅ `seen.has(assetId)` 校验 | — |
| §7.2 面料推荐确定性打分（6 维度） | ✅ `scoreFabricCandidate` 纯函数 + 每项命中写入 `reasons` 数组 + 边界外 20% 内半分 15 分 | — |
| §7.2 推荐候选装配（同币种价格优先） | ✅ `loadCandidates` 一次性装配 FabricProfile + 最新同币种 fabricPrice + compositionLines | — |
| §7.2 推荐结果 score > 0 过滤 + sort desc + slice limit | ✅ | — |
| §8.5 中间人佣金 E5/E10 双档 | ✅ `ALLOWED_RATES = [5, 10]` + `assertRate` 校验 | — |
| §8.5 中间人精确命中优先 + 默认规则兜底 | ✅ `lookupCommissionRate` 两段式查找 | — |
| §8.5 占位唯一（同中间人 / 默认仅一条启用） | ✅ `assertNoActiveDuplicate` 在 create + update（变启用时）二次校验 | — |
| §8.5 佣金率仅允许 5/10（与 TrackB 0/5/10 口径一致） | ✅ | — |
| §12.1 邮件模板 6 类型 + `{{var}}` 自动解析 | ✅ `extractTemplateVariables` 在 create + update（改文本时）自动解析 | — |
| §12.1 标准业务模板库 5 封幂等播种 | ✅ `seedStandardEmailTemplates` 服务启动自动播种 + POST /seed 手动触发 | — |
| §12.1 邮件模板 C8 使用统计 | ✅ `POST /:id/use` 上报 usageCount++ + lastUsedAt | — |
| §12.1 邮件模板 C8 AI 生成草稿 | ✅ `POST /ai-generate` 严格 JSON 输出 + 不落库 + 用户确认后走 POST / | — |

---

## §12 状态机与生命周期

### 12.1 电子画册状态机

```
Draft ──publish(≥1 item, 写 publishedAt)──▶ Published
Published ──unpublish(清 publishedAt)──▶ Draft
Draft / Published ──archive──▶ Archived（终态，不可再修改条目或基础字段）
任意非 Archived 状态 ──delete──▶ 软删除（deletedAt）
```

幂等：`publishLookbook` 对已 Published 直接返回 row；`archiveLookbook` 对已 Archived 直接返回 row。

### 12.2 面料推荐记录生命周期

- `recommend` 一次性完成"装配候选 → 打分 → 过滤 → 排序 → 切片 → 落库"全流程，criteria + results 双 JSON 快照永久保留（可审计追溯）。
- 软删除走 `deleteRecommendation`（`deletedAt`），不物理删除。
- 无状态流转——每条推荐记录是一次性的"criteria + results 快照"，不可修改，只能新建或软删。

### 12.3 营销活动状态机

```
Draft ──▶ Active ──▶ Paused ──▶ Completed
                  └──▶ Cancelled（终态）
```

⚠️ 当前 `marketingService.updateCampaign` 接受任意 status patch，未做流转合法性校验（如 Draft 不可直接跳 Completed）。**P2 缺口**：应增加 `validateCampaignTransition` 二次校验矩阵。

### 12.4 营销线索状态机

```
New ──▶ Contacted ──▶ Qualified ──▶ Converted（自动写 convertedAt + actualValue）
                                  └──▶ Lost（终态）
```

⚠️ 当前 `marketingService.updateLead` 接受任意 status patch，仅对 `Converted` 自动写 `convertedAt`，其他流转未做合法性校验。**P2 缺口**：应增加 `validateLeadTransition` 二次校验矩阵（如 Lost 不可回退 Converted）。

### 12.5 佣金规则生命周期

- 创建 / 更新时若 `isActive=true`，需通过 `assertNoActiveDuplicate` 校验占位唯一（同中间人或默认仅允许一条启用）。
- 软删除走 `deleteCommissionRule`（`deletedAt`），不物理删除。
- `isActive` 可任意切换，但切换为 true 时需重新校验占位唯一。

### 12.6 邮件模板生命周期

- 创建 / 更新时自动从 `subject + body` 解析 `{{var}}` 占位符清单写入 `variables` 字段。
- 软删除走 `DELETE /:id`（`deletedAt`），不物理删除。
- `isActive` 可任意切换（默认 true），不影响 `usageCount/lastUsedAt` 历史。
- 服务启动时自动播种 5 封标准模板（同 type+name 已存在则跳过，幂等）。

---

## §13 待补的设计缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | Campaign/Lead 前端 Tab 接入（MarketingManager 当前仅 2 Tab，缺活动 / 线索 / 模板 / 佣金 4 Tab） | P0 | MarketingManager.tsx + apiService |
| 2 | 佣金规则管理路由（pricingRoute 未暴露 CRUD 端点） | P1 | pricingRoute.ts + pricing/commissionRoute.ts 新增 |
| 3 | 佣金规则前端管理 UI | P1 | MarketingManager 新增 Tab 或独立 Settings 入口 |
| 4 | 画册 / 推荐路由接入 `requirePermission('marketing:write')` 守卫 | P1 | lookbookRoute.ts + fabricRecommendationRoute.ts |
| 5 | 邮件模板管理 UI（当前仅 email 编辑器内调用，无独立管理页） | P1 | MarketingManager 新增 Tab 或 EmailComposer 内嵌 |
| 6 | 画册行级 scope（当前所有认证用户可见全部画册） | P2 | lookbookService 引入 ownerId + buildScopeWhere |
| 7 | 营销活动状态机流转合法性校验（`validateCampaignTransition`） | P2 | marketingService |
| 8 | 营销线索状态机流转合法性校验（`validateLeadTransition`，如 Lost 不可回退） | P2 | marketingService |
| 9 | 展会线索 TradeShowLead ↔ Campaign Lead 双线索流统一编排 | P2 | marketingService + seasonsService 联动 |
| 10 | Lead 转化为 Converted 时自动创建 CRM Opportunity（双向 FK 绑定） | P2 | marketingService + crmService 联动 |
| 11 | 画册对外 Web 预览 / 打印 PDF 渲染（当前仅档案管理，无对外展示页） | P2 | 新增 /api/v1/lookbooks/:id/preview + 前端预览页 |
| 12 | 面料推荐 criteria 历史复用（一键回填条件重新执行） | P3 | FabricRecommendPanel 增加重填按钮 |

---

## §14 实现状态总览

| 子能力 | 状态 | 真源 |
|--------|------|------|
| 电子画册 CRUD + 状态机 + 条目快照 | ✅ | `LookbooksPanel` + `lookbookService` + `lookbookRoute` |
| 面料推荐确定性打分 + criteria/results 快照 | ✅ | `FabricRecommendPanel` + `fabricRecommendationService` + `fabricRecommendationRoute` |
| 营销活动 Campaign CRUD + Sequence 编号 + 行级 scope | ✅（后端） | `marketingService` + `marketingRouteV2` |
| 营销活动 ROI 聚合 | ✅（后端） | `marketingService.getCampaignROI` |
| 营销线索 Lead CRUD + Converted 时间戳 | ✅（后端） | `marketingService` + `marketingRouteV2` |
| 邮件模板 6 类型 + `{{var}}` 自动解析 + 标准模板库播种 | ✅ | `templateRoute` + `seedStandardEmailTemplates` |
| 邮件模板 C8 使用统计 + AI 生成草稿 | ✅ | `templateRoute` POST `/:id/use` + POST `/ai-generate` |
| 中间人佣金规则 E5/E10 + 命中查找 | ✅（服务） | `commissionService.createCommissionRule/lookupCommissionRate` |
| MarketingManager Campaign/Lead Tab | ❌ 缺口 | 前端未接入 |
| MarketingManager 邮件模板 Tab | ❌ 缺口 | 前端未接入 |
| MarketingManager 佣金规则 Tab | ❌ 缺口 | 前端未接入 |
| 佣金规则管理路由 | ❌ 缺口 | pricingRoute 未暴露 CRUD |
| 营销活动状态机流转校验 | ⚠️ 缺口 | 无 `validateCampaignTransition` |
| 营销线索状态机流转校验 | ⚠️ 缺口 | 无 `validateLeadTransition` |
| 画册行级 scope | ⚠️ 缺口 | 当前所有认证用户可见全部画册 |
| 画册对外 Web 预览 / PDF 渲染 | ⚠️ 缺口 | 仅档案管理，无对外展示页 |

---

## §15 交叉链接

1. [Relations-联系人](./Relations-联系人.md) — Lead `relationId` 客户身份真源 + CommissionRule `intermediaryRelationId` 中间人档案真源
2. [CRM-客户跟进](./CRM-客户跟进.md) — Lead 转化为 Converted 后由 CRM Opportunity 承接 + Campaign ROI 反查客户业务数据
3. [Seasons-季节展会](./Seasons-季节展会.md) — Campaign `seasonId/tradeShowId` 双 FK + 展会线索 TradeShowLead 与 Campaign Lead 双线索流统一编排
4. [报价 模块概述](./Quotations-报价/模块概述.md) — 报价单据模板与邮件模板的 `{{var}}` 占位符同口径 + 画册条目展示价格与报价 Track B 联动
5. [订单管理 模块概述](../03-订单与生产/Orders-订单管理/模块概述.md) — 订单 `customerRelationId` 反向归集营销线索转化后的客户业务数据
6. [定价与成本 模块概述](../03-订单与生产/Pricing-定价与成本/模块概述.md) — CommissionRule `lookupCommissionRate` 命中后由 `calculateTrackB` 应用佣金率 + 与 Track B 0/5/10 口径一致
7. [实体关系总览](../../02-数据模型/实体关系总览.md) — MarketingCampaign/MarketingLead/LookbookCatalog/FabricRecommendation/EmailTemplate/CommissionRule 模型关系图
8. [产品档案 模块概述](../05-平台域/Products-产品档案/模块概述.md) — 画册条目 `buildItemSnapshots` 服务端反查 ProductAsset + ProductImage 重取快照真源

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| 前端组件真源 | [components/MarketingManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/MarketingManager.tsx) |
| Campaign/Lead 服务真源 | [server/src/marketing/marketingService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/marketing/marketingService.ts) |
| Campaign/Lead V2 路由 + 行级 scope | [server/src/marketing/marketingRouteV2.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/marketing/marketingRouteV2.ts) |
| 画册服务真源 | [server/src/products/lookbookService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/products/lookbookService.ts) |
| 画册路由 | [server/src/products/lookbookRoute.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/products/lookbookRoute.ts) |
| 面料推荐引擎真源 | [server/src/products/fabricRecommendationService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/products/fabricRecommendationService.ts) |
| 面料推荐路由 | [server/src/products/fabricRecommendationRoute.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/products/fabricRecommendationRoute.ts) |
| 邮件模板路由 + 标准模板库 | [server/src/email/templateRoute.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/email/templateRoute.ts) |
| 邮件模板变量解析 | [server/src/lib/templateVariables.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/lib/templateVariables.ts) `extractTemplateVariables` |
| 佣金规则服务真源 | [server/src/pricing/commissionService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/pricing/commissionService.ts) |
| 佣金规则单元测试 | [server/src/pricing/__tests__/commissionRule.test.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/pricing/__tests__/commissionRule.test.ts) |
| 画册单元测试 | [server/src/products/__tests__/lookbook.test.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/products/__tests__/lookbook.test.ts) |
| 面料推荐单元测试 | [server/src/products/__tests__/fabricRecommendation.test.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/products/__tests__/fabricRecommendation.test.ts) |
| 邮件模板路由测试 | [server/src/email/__tests__/emailTemplateRoute.test.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/email/__tests__/emailTemplateRoute.test.ts) |
| Prisma 模型真源 | [server/prisma/schema.prisma](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/prisma/schema.prisma) MarketingCampaign/MarketingLead/LookbookCatalog/FabricRecommendation/EmailTemplate/CommissionRule |
| 前端类型定义 | [types.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/types.ts) §4624-§4715 |
| 路由挂载真源 | [server/src/index.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/index.ts) `/api/v1/lookbooks` + `/api/v1/fabric-recommendations` + `/api/v2/marketing` + `/api/v1/email-templates` |
