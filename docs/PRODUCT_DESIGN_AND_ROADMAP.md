# Bambook ERP OS — 产品设计与 Roadmap 总规划（深度版）

> 版本：v2.0（深度版）
> 日期：2026-07-20
> 作者：BAMBOOK 项目总设计师
> 状态：规划基线（Mainline HEAD `e36be6f` 之后）
> 数据来源：全仓库盘点（Prisma schema 1892 行 / 200 API 端点 / 83 Agent 工具 / 18 Manager 组件 / 1340 测试用例 / 49 份文档）

---

## 目录

- [第零部分 执行摘要](#第零部分-执行摘要)
- [第一部分 产品定位与愿景](#第一部分-产品定位与愿景)
- [第二部分 用户与场景](#第二部分-用户与场景)
- [第三部分 产品架构](#第三部分-产品架构)
- [第四部分 核心业务流程](#第四部分-核心业务流程)
- [第五部分 Agent 内核架构](#第五部分-agent-内核架构)
- [第六部分 前端 UI 现状](#第六部分-前端-ui-现状)
- [第七部分 测试与质量](#第七部分-测试与质量)
- [第八部分 现状盘点](#第八部分-现状盘点)
- [第九部分 Roadmap](#第九部分-roadmap)
- [第十部分 风险评估](#第十部分-风险评估)
- [第十一部分 度量指标](#第十一部分-度量指标)
- [第十二部分 立即行动](#第十二部分-立即行动)

---

## 第零部分 执行摘要

Bambook ERP OS 是面向中小型纺织服装出口企业的 **Agent-原生 ERP 操作系统**。截至 2026-07-15，项目已达到**高度可用**状态：

| 维度 | 数值 |
|------|------|
| 后端业务域 | 21 个（Orders/Production/Finance/Relations/Products/Shipping/Email/Development/HR/Admin/Auth/Import/Templates/Entities/PDML/AI/Agent/BusinessProfiles/SystemAssets/Audit/Realtime） |
| Prisma 数据模型 | 56+ 个 model |
| HTTP API 端点 | 200 个（GET 74 / POST 82 / PUT 6 / PATCH 24 / DELETE 20） |
| Agent 工具 | 83 个（58 simple + 25 commit，覆盖 12 个业务域） |
| 前端 Manager 组件 | 18 个（**全部对接真实 API**，无 mock 残留） |
| 设计系统 | 5 层架构 + 13 项守门员测试 |
| 测试用例 | server 端 1340 + 前端 186 = **1526 个** |
| 文档 | 49 份（含 13 份设计系统文档） |
| Agent 能力评分 | 3.55/5（权限控制 4.5 / 记忆知识 2.0 为最大短板） |

**核心结论**：
1. **骨架与内核已完成**——订单/生产/财务/关系/产品/货运/邮件/开发 8 大业务域全部落地，Agent 83 工具注册表 + checkpoint + RBAC 11 角色 + commit 审批机制就绪。
2. **三大缺口阻碍"完整 ERP"**——采购/仓库/关务/成本核算 4 大模块缺失；Agent 记忆/知识检索仍是 stub；移动端几乎为零。
3. **下一步关键是"落地"而非"堆功能"**——生产管线前端接数据 + Agent 对话窗口打磨 + Prisma 7 迁移 + CI 自动化。

---

## 第一部分 产品定位与愿景

### 1.1 一句话定位

> **Bambook ERP OS 是面向中小型纺织服装出口企业的"Agent-原生"ERP 操作系统**，以"订单交付"为主线，将业务、生产、采购、财务、关务、物流打通，并通过嵌入式 AI Agent 让系统从"记录工具"升级为"执行伙伴"。

### 1.2 市场切片

| 维度 | 选择 |
|------|------|
| 行业 | 纺织服装出口（梭织/针织/家纺/面料） |
| 规模 | 50–500 人，年营收 5000 万 – 10 亿人民币 |
| 地域 | 以张家港/苏州/宁波/绍兴为基地，面向全球买家 |
| 现状 | 多数仍在用 Excel + 邮件 + 微信协同，少量上了传统 ERP 但"水土不服" |
| 痛点 | 订单交付过程黑盒、生产进度靠催、文档散落邮件、财务对账滞后、新人上手周期长 |

### 1.3 愿景三阶

1. **短期（6 个月，至 2027-01）**：成为企业的**单一事实源（SSOT）**——订单、生产、财务、物流数据全部沉淀在 Bambook，告别 Excel 并存。
2. **中期（12 个月，至 2027-07）**：成为企业的**执行伙伴**——Agent 能在自然语言指令下完成"建单 / 推进生产 / 开票 / 发货 / 对账"等闭环动作，人只做审批。
3. **长期（24 个月，至 2028-01）**：成为行业的**协作网络节点**——上下游工厂、买家、货代通过 Bambook Network 安全交换订单状态与单据。

### 1.4 差异化能力（相对传统 ERP）

| 能力 | 传统 ERP | Bambook |
|------|---------|---------|
| 交互形态 | 表单驱动，需培训 | 自然语言 + 表单双轨，Agent 代填代发 |
| 生产管控 | MRPII 重计划，落地难 | 10 阶段门禁引擎，贴合纺织实际作业节奏 |
| 知识沉淀 | 依赖老员工脑中经验 | 邮件/文档/对话自动入 RAG，新人可问可查 |
| 部署形态 | B/S 或本地 C/S，升级重 | Electron 桌面端 + 本地 Prisma，离线可用 + 数据自持 |
| 跨企业协作 | 几乎不可能 | 基于 MCP 标准协议，原生支持跨企业消息与审批 |
| 审计可追溯 | 后补日志 | AuditLog 同事务原子写入，fail-closed |

---

## 第二部分 用户与场景

### 2.1 用户角色矩阵（11 个 AgentRole）

| 角色 | 主要职责 | 在 Bambook 的核心动作 | permissions | tools scope |
|------|---------|---------------------|-------------|-------------|
| **owner** 老板 | 经营决策、资金调度 | 看仪表盘、看订单利润、审批大额支出 | admin, knowledge:manage, tool:approve, memory:company:write | admin, finance, orders, relations, products, knowledge, automation |
| **admin** 管理员 | 系统维护、权限 | 用户管理、审计日志、Agent 工具授权 | admin, knowledge:manage, tool:approve | 同 owner |
| **manager** 经理 | 团队管理、审批 | 审批 high-risk 工具、团队 read | team:read, tool:approve | orders, relations, products, knowledge, automation |
| **merchandiser** 跟单员 | 订单执行全程协调 | 推进生产阶段、记录面辅料状态、产前样确认 | orders:read, orders:draft | orders, relations, products |
| **finance** 财务 | 开票、收款、对账 | 开票、收款凭证、银企对账 | finance:read, invoice:draft | finance, orders, products |
| **sales** 业务员 | 接单、客户维护、出货跟进 | 建订单、查客户档案、发邮件、对账 | sales:read, customer:draft | orders, relations, products |
| **viewer** 查看者 | 只读 | 浏览数据 | read | read, products |
| **agent_operator** 自动化操作员 | 运行自动化 | 触发自动化任务 | automation:run | automation, read, products |
| **logistics** 物流 | 出入库、装运 | 装运单管理、物流跟踪 | read, shipping:read, shipping:write | read, products, shipping |
| **production_manager** 生产主管 | 排产、车间协调、质量把控 | 签字产前样、推进生产阶段、验货报告 | production:read, production:write, production:sign | production, orders, products |
| **factory** 工厂端 | 实际生产 | 仅可读生产进度、上报产能与异常 | production:read, production:write | production, products |

**RBAC 策略执行**（policy.ts）：
- `canAccessKnowledge(actor, target)`：scope 在 actor.knowledgeScopes 或 departmentIds 中 → 允许，否则拒绝。
- `canUseTool(actor, target)`：scope 不在 toolScopes → 拒绝；risk=high 且无 owner/admin/manager 角色 → 需审批；否则直接允许。
- **fail-closed**：scope 不在白名单直接拒绝，无 fallback。

### 2.2 三条核心业务闭环

#### 闭环 A：订单交付闭环（主线）

```
买家询盘 → 报价 → 建订单 → 面辅料确认 → 生产计划 → 面辅料到厂
→ 裁剪前检查 → 产前样双签 → 大货生产 → 成品确认 → 验货发货 → 对账收款
```

这是 Bambook 的**生命线**，生产管线 10 阶段门禁引擎直接服务于此闭环。

#### 闭环 B：资金闭环

```
订单确立 → 预收款 → 采购付款 → 生产成本归集 → 开票 → 尾款回收 → 利润核算
```

财务模块（invoice/paymentVoucher/allocation）支撑此闭环。当前缺口：成本归集（料工费）+ 银企对账自动化。

#### 闭环 C：知识沉淀闭环

```
邮件收发 → IMAP 同步 → RAG 入库 → 询盘/订单/异常时被检索 → 反哺业务决策
```

AI/RAG 模块 + 邮件同步流程支撑此闭环。当前缺口：Agent 内核的 knowledge.ts 仍是进程内 stub，需接入真实 Prisma KnowledgeDocument/KnowledgeChunk + embedding。

### 2.3 关键场景走查

**场景 1：业务员接单到发货**
1. 业务员收到买家邮件（IMAP 同步进系统）
2. Agent AI 抽取邮件结构化字段（intent/products/quantities/prices）
3. 业务员用 Agent 对话"帮我把这个询盘建成订单"
4. Agent 起草订单 + 行项目 → 审批 → 订单确认
5. 跟单员推进生产阶段（10 阶段门禁）
6. 验货合格 → 发货（装运单 + 订单状态联动）
7. 财务开票 → 收款 → 核销

**场景 2：老板看经营**
1. 老板打开 Dashboard → 看订单看板（按状态分组）
2. 点开异常订单 → 看生产预警（阶段超期）
3. 问 Agent："这个月哪些订单利润低于 10%？"
4. Agent 调 finance.list_invoices + orders.query → 聚合分析 → 回答

**场景 3：新跟单员上手**
1. 新人问 Agent："客户 ABC 上一单的面料规格是什么？"
2. Agent 调 orders.query + orders.expand + knowledge.search
3. RAG 检索历史邮件/文档 → 返回完整答案
4. 新人再问："产前样需要谁签字？"
5. Agent 调 knowledge.search → 返回业务规定 → 引导签字流程

---

## 第三部分 产品架构

### 3.1 分层架构

```
┌─────────────────────────────────────────────────────────────────┐
│  交互层  Electron Shell + React UI + Agent 对话窗口              │
│         18 Manager 组件 + 19 Agent 响应渲染器 + 5 层设计系统      │
├─────────────────────────────────────────────────────────────────┤
│  Agent 层  规划器 / 83 工具注册表 / Checkpoint / RBAC 11 角色     │
│           agentLoop / commitTransaction / fail-closed 审批       │
├─────────────────────────────────────────────────────────────────┤
│  业务域层  21 个域：Orders / Production / Finance / Relations     │
│           Products / Shipping / Email / Development / HR / Admin │
│           Auth / Import / Templates / Entities / PDML / AI /     │
│           Agent / BusinessProfiles / SystemAssets / Audit / Realtime │
├─────────────────────────────────────────────────────────────────┤
│  能力层  RAG 知识库 / AI Runner / TTS / 状态机 / 审计 / 实体图    │
├─────────────────────────────────────────────────────────────────┤
│  数据层  Prisma + PostgreSQL/SQLite + 文件存储 + IndexedDB       │
│         56+ model，Decimal-first 金额，BigInt 时间戳              │
├─────────────────────────────────────────────────────────────────┤
│  协议层  MCP 标准协议（跨企业消息/审批/任务图）+ MCP Manifest      │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 模块矩阵（前端 16 模块 + 后端 21 域）

#### 前端 16 个导航模块（moduleRegistry.ts）

| # | 模块 ID | 产品标签 | 图标 | nav.order | 权限 | Compiler 状态 | 入口组件 |
|---|---------|---------|------|-----------|------|--------------|---------|
| 1 | dashboard | 全景看板 | LayoutDashboard | 10 | 全员 | accepted | Dashboard.tsx |
| 2 | assistant | AI 助手 | Sparkles | 20 | 全员 | provisional | Assistant.tsx |
| 3 | relations | 关系智库 | Users | 30 | 全员 | accepted | RelationsManager.tsx |
| 4 | products | 数字档案 | Library | 40 | 全员 | accepted | ProductsManager.tsx |
| 5 | orders | 生产管理 | Factory | 50 | 全员 | provisional | OrderManager.tsx / GarmentOrders.tsx |
| 6 | invoices | 发票管理 | FileText | 52 | 全员 | provisional | FinanceManager.tsx |
| 7 | payment-vouchers | 财务管理 | CreditCard | 54 | 全员 | provisional | FinanceManager.tsx |
| 8 | shipments | 货运管理 | Truck | 58 | 全员 | provisional | ShipmentManager.tsx |
| 9 | development | 开发管理 | ClipboardList | 60 | 全员 | provisional | DevelopmentManager.tsx |
| 10 | emails | 智能邮箱 | Mail | 46 | 全员 | provisional | EmailManager.tsx |
| 11 | data-center | 数据中心 | Database | 80 | 全员 | provisional | DataCenter.tsx |
| 12 | settings | 设置 | Shield | 90 | 全员 | accepted | Settings.tsx |
| 13 | business-tools | 业务工具 | Wrench | 100 | 全员 | provisional | BusinessTools.tsx |
| 14 | admin | 管理后台 | Shield | 110 | owner/admin | provisional | AdminPanel.tsx |
| 15 | hr | 人事管理 | UserCog | 105 | owner/admin | provisional | HRManager.tsx |
| 16 | (knowledgeBase) | (合并到 data-center) | — | — | — | — | — |

**子视图**：
- orders: fabric-orders（面料订单）/ garment-orders（成衣订单）
- products: module-settings（数字档案设置）
- settings: account（账号设置）/ system（系统设置）
- hr: personnel / teams / projects / assignments

#### 后端 21 个业务域

| 业务域 | 模型数 | API 端点数 | Agent 工具数 | 测试用例数 | 状态 |
|--------|-------|-----------|-------------|-----------|------|
| Orders | 3 (Order/OrderLine/OrderStatusTransition) | 15 | 16 | 43 | ✅ 完整 |
| Production | 3 (ProductionStage/PreCutChecklist/InspectionReport) | 7 | 6 | 25 | ✅ 完整 |
| Finance | 3 (Invoice/PaymentVoucher/InvoiceAllocation) | 16 | 17 | 106 | ✅ 完整 |
| Relations | 1 (Relation, 40+ 字段) | 7 | 12 | 33 | ✅ 完整 |
| Products | 10+ (ProductAsset/FabricProfile/GarmentProfile/TrimmingProfile/...) | 10 | 11 | 32 | ✅ 完整 |
| Shipping | 2 (Shipment/ShipmentLine) | 5 | 4 | 53 | ✅ 完整 |
| Email | 2 (Email/EmailAttachment) | 17 | 8 | 67 | ✅ 完整 |
| Development | 1 (DevelopmentCase, 30+ 字段) | 7 | 4 | 40 | ✅ 完整 |
| HR | 5 (UserAccount/Department/Role/UserRole/Permission/RolePermission/JobPosition/Team/TeamMember/Project/ProjectMember/WorkAssignment) | 20 | 0 | 0 | 🟡 仅 UI |
| Admin | 3 (AuditLog/ApprovalRequest/AgentToolPermission) | 28 | 0 | 16 | 🟡 仅路由 |
| Auth | 1 (UserAccount) | 8 | 0 | 4 | 🟡 基础 |
| Import | — | 1 | 0 | 27 | ✅ 完整 |
| Templates | 1 (RenderedDoc) | 4 | 3 | 0 | 🟡 仅工具 |
| Entities | 3 (EntityReference/EntityAlias/EntityLink) | 6 | 4 | 14 | ✅ 完整 |
| PDML | 1 (PdmlRawFabric) | 4 | 0 | 2 | 🟡 半成品 |
| AI/RAG | 4 (KnowledgeDocument/KnowledgeChunk/KnowledgeRelation/KnowledgeAcl) | 7 | 2 | 15 | 🟡 基础 |
| Agent | 8 (AgentSession/AgentMessage/AgentMemory/AgentTool/AgentToolPermission/AgentToolRun/AgentJob/AgentSuggestion/ApprovalRequest/AgentCheckpoint) | 13 | — | 646 | ✅ 完整 |
| BusinessProfiles | 1 (BusinessProfile) | 3 | 0 | 0 | 🟡 基础 |
| SystemAssets | 1 (SystemAsset) | 5 | 0 | 0 | 🟡 基础 |
| Audit | 1 (AuditLog) | — | — | 19 | ✅ 完整 |
| Realtime | — | 1 (SSE) | — | — | ✅ 完整 |

### 3.3 数据模型总览（56+ Prisma model）

#### 核心业务模型（按业务域分组）

**Orders 域**（3 model）：
- `Order`（200+ 字段）：订单主表，含 PO header / 角色快照（customer/mill/consignee/billTo/salesPerson/merchandiser/supervisor）/ 合同 / 生产交期 / 面料规格 / 销售收款 / 装运发票 / 船样 / 匹头样 / 采购付款 / 生产管线截止日期
- `OrderLine`（30+ 字段）：订单行，含尺寸/工序/BOM 等成衣扩展字段
- `OrderStatusTransition`：状态流转审计

**Production 域**（3 model）：
- `ProductionStage`：10 阶段状态 + 双签字段（signedByProduction/signedByBusiness）
- `PreCutChecklist`：裁剪前 4 项检查（grading/consumption/pattern/preProductionMeeting）
- `InspectionReport`：验货报告（totalUnits/passedUnits/approvedByBusiness）

**Finance 域**（3 model）：
- `Invoice`：发票（Receivable/Payable，5 状态，含汇率快照）
- `PaymentVoucher`：收付款凭证（Receipt/Disbursement，3 状态核销）
- `InvoiceAllocation`：1:N 核销中间表（硬删除，调整=delete+insert）

**Relations 域**（1 model，40+ 字段）：
- `Relation`：统一关系档案，含组织（chineseName/creditLimit/factoryAddresses/coordinates）/ 联系人（email/phone/wechat/whatsapp）/ 偏好（paymentTerms/currency/timezone）

**Products 域**（10+ model）：
- `ProductAsset`：产品主档（sku/mainCategory/season/cost）
- `FabricProfile`：面料档案（articleNo/construction/yarnCount/weight/width/MOQ）
- `GarmentProfile`：成衣档案（80+ 字段，styleNo/silhouette/fit/sizeSpec/gradingRule/...）
- `TrimmingProfile`：辅料档案
- `ProductClassification` / `ProductClassificationLink`：分类树
- `MaterialCompositionTerm` / `FabricCompositionLine`：成分
- `FabricCustomerCode`：客户码
- `FabricPriceHistory`：价格历史
- `FabricCertification`：认证
- `ProductImage`：产品图片
- `PdmlRawFabric`：PDML 原始面料

**Shipping 域**（2 model）：
- `Shipment`（40+ 字段）：运单（type/status/shippingMethod/日期/运输信息/重量体积/费用/报关）
- `ShipmentLine`：装箱明细行（关联 OrderLine）

**Email 域**（2 model）：
- `Email`（30+ 字段）：邮件（direction/status/发件收件/内容/IMAP元数据/关联/AI抽取）
- `EmailAttachment`：附件（含 OCR 提取文本）

**Development 域**（1 model，30+ 字段）：
- `DevelopmentCase`：开发案（type/stage/priority/owner/customer/supplier/sampleCategory/reviewStatus/sampleDetails/conversion）

**Agent OS 域**（10 model）：
- `UserAccount` / `Department` / `Role` / `UserRole` / `Permission` / `RolePermission`：RBAC
- `AgentPolicy`：Agent 策略
- `AgentSession` / `AgentMessage`：会话
- `AgentMemory`：记忆（scope-based 权限隔离）
- `KnowledgeDocument` / `KnowledgeChunk` / `KnowledgeRelation` / `KnowledgeAcl`：知识库
- `EntityReference` / `EntityAlias` / `EntityLink`：实体图
- `AgentTool` / `AgentToolPermission` / `AgentToolRun`：工具注册与运行
- `AgentJob` / `AgentSuggestion`：后台任务与建议
- `ApprovalRequest`：审批
- `JobPosition` / `Team` / `TeamMember` / `Project` / `ProjectMember` / `WorkAssignment`：HR
- `AgentCheckpoint`：断点续传
- `AuditLog`：审计日志
- `RenderedDoc`：模板渲染产物

**其他**：
- `ProjectMemory` / `BusinessProfile` / `KnowledgeItem` / `Insight` / `SystemAsset`：杂项

#### 数据模型设计原则

1. **Decimal-first 金额**：所有金额字段 `Decimal @db.Decimal(18,4)`（Phase 3 完成全库迁移）
2. **BigInt 时间戳**：`BigInt epoch ms`（与 Order/DevelopmentCase 一致）
3. **String 业务日期**：`YYYY-MM-DD`（issueDate/dueDate/paymentDate）
4. **Snapshot FK 风格**：Relation 关联用 `*RelationId` + `*Name` 冗余快照，不加 `@relation`，避免归档级联
5. **软删除**：`deletedAt BigInt?`（Finance/Shipping/Email/Products/Relations/Development）
6. **审计日志同事务**：`AuditLog` 在 `$transaction` 内写入，失败回滚

### 3.4 API 端点总览（200 个）

#### 按方法分布

| HTTP 方法 | 数量 |
|-----------|------|
| GET | 74 |
| POST | 82 |
| PUT | 6 |
| PATCH | 24 |
| DELETE | 20 |
| ALL（多方法） | 7 |

#### 按模块分布（Top 10）

| 模块 | 端点数 | 鉴权策略 |
|------|-------|---------|
| Admin | 28 | owner/admin 全约束 |
| HR | 20 | owner/admin 全约束 |
| Email | 17 | 双挂载（DB + legacy IMAP 代理） |
| 顶层 index.ts | 17 | sdkAuth + 公开（market/search/health） |
| Finance | 16 | 读 API Key/JWT，写 HIGH_RISK_ROLES |
| Agent | 13 | 三种自定义鉴权（auth/requireAgentActor/authActorOrApiKey） |
| Orders | 11 | router 级 API Key |
| Products | 10 | 读 API Key，写 JWT |
| Auth | 8 | 公开（login/register/send-code）+ JWT |
| AI/RAG | 7 | API Key/JWT |

#### 鉴权分布

| 鉴权类别 | 端点数 |
|---------|-------|
| 公开端点 | 14（health/search/fetch-url/market × 3/auth × 3/Templates × 4） |
| SDK Auth | 11 |
| 模块 router 级 API Key/JWT | 117 |
| owner/admin 全约束 | 48（Admin 28 + HR 20） |
| JWT actor 必需 | 6（Agent sessions） |
| JWT actor 或 API Key | 6（Agent tool-runs/approvals/forms/MCP） |
| Auth 已登录用户 | 5 |
| 写操作额外 HIGH_RISK_ROLES | ~21（嵌套） |

**关键发现**：
- `requireAuth` 全局开关：`BAMBOOK_REQUIRE_AUTH=true` 或 `NODE_ENV=production` 触发；本地 dev 默认关闭
- **Templates 模块未启用 router 级 auth guard**——潜在安全风险
- **Knowledge Documents 下载**用 token 查询参数代替 middleware 鉴权
- **遗留 `app.all` 同步端点**（/api/orders 等 7 个）接受所有 HTTP 方法

### 3.5 Agent 工具总览（83 个）

#### 按注册类型

| 注册类型 | 数量 | 占比 |
|---------|-----|------|
| `registerTool`（simple） | 58 | 69.9% |
| `registerCommitTool`（commit） | 25 | 30.1% |

#### 按审批要求

| 审批要求 | 数量 | 占比 |
|---------|-----|------|
| 需要审批 | 42 | 50.6% |
| 不需审批 | 41 | 49.4% |

**42 个需审批工具分解**：
- Commit 工具（内置 7 步 approvalId 校验）：25 个
- Simple mutation + approvalRoles 显式设置：13 个
- Simple mutation + risk=high 但 approvalRoles 未设：4 个（production 域，靠 manifest fail-closed 兜底）

#### 按业务域

| 业务域 | 总数 | simple | commit | 只读 | 需审批 |
|-------|-----|--------|--------|------|--------|
| Products | 11 | 8 | 3 | 8 | 3 |
| Orders | 16 | 11 | 5 | 7 | 9 |
| Relations | 12 | 8 | 4 | 7 | 5 |
| Finance | 17 | 8 | 9 | 5 | 12 |
| Shipping | 4 | 4 | 0 | 2 | 2 |
| Email | 8 | 5 | 3 | 3 | 5 |
| Development | 4 | 3 | 1 | 2 | 2 |
| Knowledge | 2 | 1 | 1 | 1 | 1 |
| Templates | 3 | 3 | 0 | 3 | 0 |
| Production | 6 | 6 | 0 | 2 | 4 |

#### 工具清单（精选）

**Production 域 6 个工具**（10 阶段门禁引擎）：
- `production.get_pipeline`（只读）：查 10 阶段状态
- `production.advance_stage`（审批）：推进下一阶段（自动跑门禁）
- `production.save_checklist`（审批）：裁剪前 4 项检查
- `production.save_inspection`（审批）：验货报告
- `production.sign_stage`（审批）：产前样双签
- `production.scan_alerts`（只读）：扫描生产预警

**Finance 域 17 个工具**（资金闭环）：
- 只读 5 个：list_invoices / get_invoice / list_vouchers / get_voucher / query_outstanding
- Simple mutation 3 个：create_invoice / create_voucher / apply_voucher_to_invoice
- Commit 9 个：invoice.create/update/issue/cancel/delete + payment_voucher.create/update/delete + payment.receive_and_reconcile

**关键发现**：
- `invoice.generate_draft` 在 DEFAULT_AGENT_TOOLS 有 RBAC 配置，但 toolDispatchRegistry 中无 handler（迁移不完整）(已修复 2026-07-21：从 DEFAULT_AGENT_TOOLS 移除)
- 21 个 commit 工具注册了 handler 但未进 DEFAULT_AGENT_TOOLS（默认不授予角色）
- 4 个 production high-risk mutation 用 `registerTool`（simple）且 `approvalRoles` 未设，与 commit 工具的强制 7 步审批不一致

---

## 第四部分 核心业务流程

### 4.1 订单交付主流程（10 阶段门禁引擎）

```
①业务下单 ─②面辅料确认 ─③生产计划 ─④货期管理 ─⑤面辅料到厂
                                                      │
                                                      ▼
⑥裁剪前检查 ─⑦产前样确认 ─⑧生产过程 ─⑨成品确认 ─⑩验货发货
   [门禁A]      [门禁B]                    [门禁C]
```

#### 门禁 A（裁剪前检查 pre_cut_checked）

PreCutChecklist 四项全 true：
- `gradingConfirmed` 推码确认
- `consumptionConfirmed` 耗料确认
- `patternConfirmed` 样板确认
- `preProductionMeeting` 产前会议

错误码：`PRECUT_CHECKLIST_INCOMPLETE`

#### 门禁 B（产前样确认 pp_sample_approved）

生产部 + 业务部双签：
- `signedByProduction` 生产部签字
- `signedByBusiness` 业务部签字

错误码：`PP_SAMPLE_NOT_SIGNED`

#### 门禁 C（验货发货 qc_shipped）

三项全满足：
- 合格率 `passRate = passedUnits / totalUnits >= 0.90`
- 不合格率 `defectRate = (totalUnits - passedUnits) / totalUnits <= 0.03`
- 业务部批准 `approvedByBusiness === true`

错误码：`INSPECTION_NOT_QUALIFIED` / `BUSINESS_APPROVAL_REQUIRED`

#### 门禁引擎执行流程（advanceStage）

```
1. 校验 stageKey 有效
2. $transaction 内：
   a. 查 Order（deletedAt: null）
   b. 查 ProductionStage（orderId + stageKey）
   c. 校验 stage.status !== 'done'
   d. 查前置阶段（stageSeq < current），校验全部 done
   e. 门禁检查（pre_cut_checked / pp_sample_approved / qc_shipped）
   f. update ProductionStage（status='done', doneAt, operator, note）
   g. writeRouteAuditLog（actor/source/operation/target/before/after）
3. 返回 { ok: true, data: { stage, auditId } } 或 { ok: false, error: { code, message } }
```

### 4.2 资金闭环

#### 发票状态机

```
Draft（草稿）→ Issued（已开票）→ PartiallyPaid（部分销账）→ Paid（已结清）
                ↓
            Cancelled（已作废）
```

#### 凭证核销状态机

```
unreconciled（未核销）→ partially_reconciled（部分核销）→ reconciled（已核销）
```

#### 1:N 核销机制（InvoiceAllocation）

- 一笔 PaymentVoucher 可核销多张 Invoice
- 一张 Invoice 可被多笔 Voucher 核销
- `InvoiceAllocation` 中间表（硬删除，调整 = delete + insert）
- `PaymentVoucher.appliedAmount` 保留作为"主核销"快照，向后兼容

### 4.3 知识沉淀闭环

```
邮件收发 → IMAP 同步（emailSyncService）→ AI 抽取（aiExtract）
    │                   │
    ▼                   ▼
关联到现有订单      RAG 入库（knowledgeIngestService）
    │                   │
    ▼                   ▼
跟单员在订单详情页看到   Agent 检索（knowledge.search）
"买家确认"事件              │
                            ▼
                        反哺业务决策
```

#### 三层广告过滤（RAG 入库）

- **A 层 内容特征**：<200 字 + 推广词 → 拒绝
- **B 层 结构过滤**：trafilatura 抽取正文 <100 字 → 判图片广告（需人工抽检校准）
- **C 层 LLM 判断**：prompt 使用能力描述式，判断是否为纺织专业知识内容

### 4.4 Agent 驱动的执行示例

**用户**："把订单 O-2026-001 推进到产前样，我跟老王都签了"

**Agent 执行链**（agentLoop 迭代）：

```
Step 1: thought="需要先查订单当前阶段"
        action=call_tool
        toolCalls=[
          { toolId: 'production.get_pipeline', input: { orderId: 'O-2026-001' } }
        ]
        observation: { pipeline: { stages: [...], currentStage: 'pre_cut_checked' } }

Step 2: thought="当前在裁剪前检查，需推进到产前样。先签字"
        action=call_tool
        toolCalls=[
          { toolId: 'production.sign_stage', input: { orderId, stageKey: 'pp_sample_approved', signType: 'production', signerId: '老王' } },
          { toolId: 'production.sign_stage', input: { orderId, stageKey: 'pp_sample_approved', signType: 'business', signerId: '我' } }
        ]
        → 审批拦截（high-risk）→ emit 'blocked' → 用户审批 → approved

Step 3: thought="双签完成，推进阶段"
        action=call_tool
        toolCalls=[
          { toolId: 'production.advance_stage', input: { orderId, stageKey: 'pp_sample_approved' } }
        ]
        → 审批拦截 → approved → 门禁通过 → done

Step 4: thought="任务完成"
        action=final_answer
        finalAnswer: "已推进到产前样确认，下一步是大货生产"
```

---

## 第五部分 Agent 内核架构

### 5.1 Agent Loop（agentLoop.ts，823 行）

#### 入口

```ts
createAgentLoop(deps: {
  llm: LLMCompleter;
  toolExecutor: ToolExecutor;
  availableTools: ToolDescriptor[];
  checkpointManager?: CheckpointManager;
}): { run(input: AgentLoopInput): Promise<AgentLoopResult> }
```

#### 迭代流程

```
for (let step = resumeStep; step <= config.maxSteps; step++) {
  1. 预算检查（totalBudgetMs / signal.aborted）
  2. emit 'iteration_start'
  3. 构建 user messages（message + history + attachmentContext + scratchpad）
  4. LLM 决策（planNextStep）→ call_tool / final_answer / request_form
  5. 持久化 thought → emit 'thought' + 'thought_end'
  6. 分支：
     A. final_answer → 写 finalText, stopReason='final_answer', break
     B. request_form → emit 'form_request' → 挂起 15 分钟 → 灌入 observation
     C. call_tool:
        - 去重检查（seenSignatures Set）
        - runWithTimeout(toolExecutor, 30s)
        - 审批拦截（output.approvalRequired）→ emit 'blocked' → 挂起 → 三态（rejected/modified/approved）
        - modified 时用 finalInput 重跑
        - approved 时用 skipApprovalCheck + approvalId 重跑
  7. push IterationTrace → emit 'iteration_end'
  8. checkpointManager.save
  9. 审批拦截早退 → break
}
```

#### 循环限制（AGENT_LOOP_LIMITS）

| 参数 | 值 | 说明 |
|------|-----|------|
| maxSteps | 8 | 含强制收尾步 |
| maxToolsPerStep | 3 | 单步最多 3 个工具并行 |
| perToolTimeoutMs | 30,000 | 单工具超时 30 秒 |
| totalBudgetMs | 90,000 | 总预算 90 秒 |
| llmRepairRetries | 1 | JSON 解析失败重试 1 次 |
| historyWindowSize | 8 | 取最近 8 轮历史 |
| observationCharLimit | 6,000 | observation 硬截断 |
| scratchpadCharBudget | 24,000 | scratchpad 字符预算 |

#### stopReason 7 态

`final_answer / max_steps / budget_exhausted / aborted / llm_failure / approval_blocked / form_blocked`

#### Scratchpad 结构

```ts
type Scratchpad = {
  thoughts: Array<{ step: number; content: string }>;
  toolCalls: ToolExecutionRecord[];
};
```

每步由 `groupScratchpadByStep` 重组成 `{thought, calls}` 对，注入下一轮 prompt 的 `assistant`（thought+plan JSON） + `user`（`[OBSERVATION step=N]` 块）双消息对。

#### 错误处理

- **LLM 层**：1 + repairRetries 次尝试，第 2 次带修复提示
- **工具层**：runWithTimeout 包装 Promise + setTimeout
- **强制收尾**：finalText == null 时调 `forceFinalAnswer`（不要求 JSON）
- **降级兜底**：固定串"本轮 Agent 未能完成有效推理；请检查 Agent 日志或更换提问方式后重试。"

### 5.2 Checkpoint/Resume（checkpoint.ts，109 行）

#### 接口

```ts
interface CheckpointManager {
  save(checkpoint: AgentCheckpoint): Promise<void>;
  load(conversationId: string): Promise<AgentCheckpoint | null>;
  clear(conversationId: string): Promise<void>;
}
```

#### 双实现

| 实现 | 用途 | 存储位置 |
|------|------|---------|
| InMemoryCheckpointManager | 开发/测试 | 进程内 `Map<string, AgentCheckpoint>` |
| PrismaCheckpointManager | 生产 | Prisma `AgentCheckpoint` model（upsert by conversationId） |

#### AgentCheckpoint 结构

```ts
{
  id: string;                  // ckp_<base36>_<random>
  conversationId: string;
  step: number;                // 已完成的最后一步
  message: string;            // 原始用户消息
  scratchpad: { thoughts, toolCalls };
  iterations: IterationTrace[];
  createdAt: string;
}
```

#### 恢复流程

```
agentLoop.run() 启动时：
1. 若 checkpointManager && conversationId 存在 → load(conversationId)
2. 若 ckpt && ckpt.step >= 1：
   - scratchpad.thoughts = ckpt.scratchpad.thoughts
   - scratchpad.toolCalls = ckpt.scratchpad.toolCalls
   - resumeStep = ckpt.step + 1
   - emit 'checkpoint_resumed'
3. 主循环 for (let step = resumeStep; ...) 从断点继续
4. 每步结尾 save
5. 正常完成后 clear
```

**设计原则**：轻量（最小状态）/ 可选（不传 checkpointManager 行为不变）/ 幂等（resume 从 step+1）

### 5.3 RBAC 身份权限

#### 11 角色权限矩阵（详见 §2.1）

#### policy.ts 策略执行

```ts
canAccessKnowledge(actor, target):
  - target.scopes 默认 ['company']
  - 任一 scope 在 actor.knowledgeScopes 或 actor.departmentIds → 允许
  - 否则拒绝

canUseTool(actor, target):
  - target.scope 不在 actor.toolScopes → { allowed: false, reason: 'ROLE_NOT_ALLOWED' }
  - risk=high 且无 owner/admin/manager → { allowed: true, requiresApproval: true }
  - 否则 { allowed: true, requiresApproval: false }
```

**fail-closed**：scope 不在白名单直接拒绝，无 fallback。

#### HIGH_RISK_APPROVERS

`['owner', 'admin', 'manager']` —— high-risk 工具必须由这三个角色之一审批。

### 5.4 Commit 审批机制（commitTransaction.ts，412 行）

#### ProcessDraft 结构

```ts
{
  subOperations: Array<{
    toolId: string;
    action: string;
    entityId: string;
    before: { ... };
    after: { status, amount, currency, type, customerRelationId, ... };
  }>;
  impactScope: string[];       // ['orders', 'invoices']
  irreversible: boolean;
  postCommitHooks: Array<...>;  // 必须 []
  beforeAfterDiff: ...;
  idempotencyKey: string;       // "pd:<hash>" 或 "order.confirm:PO-001:pd:<hash>"
}
```

#### 三道防线

1. **shape 校验**（validateProcessDraft）：payload.processDraft 存在且结构正确
2. **语义校验**（validateProcessDraftSemantics）：subOperations 符合业务规则（如 order.confirm 必须含 orders.update_status + finance.create_invoice）
3. **hash 校验**（verifyProcessDraftHash）：覆盖 `subOperations + impactScope + irreversible + postCommitHooks + beforeAfterDiff`，任何字段篡改 → fail-closed

#### commit 流程（以 order.confirm 为例）

```
1. recoverProcessDraftFromPayload(payload) → 恢复审批时 draft
2. validateProcessDraft → shape 校验
3. validateProcessDraftSemantics → 语义校验
4. verifyProcessDraftHash → hash 校验
5. 找 update_status subOp → 拿 poNumber + before/after status
6. 查 approval.requesterId → 用于 auditLog actorId
7. Prisma $transaction 原子提交：
   a. 查 Order（status === previousStatus，防 STATUS_DRIFT）
   b. 写 OrderStatusTransition
   c. 更新 Order.status
   d. 创建 Invoice（status='Issued'）
   e. 同步 EntityLink（aboutOrder + billTo）
   f. 写 AuditLog（同事务闭环，失败回滚）
8. 返回 CommitResult（含 entityLinks + postCommitQueue=[] + audit 摘要）
9. catch 任何异常 → 返回 errorFeedback + audit 摘要
```

#### what-you-approve-is-what-you-commit

- 审批时把完整 ProcessDraft snapshot 写入 `ApprovalRequest.payload.processDraft`
- commit 时**不从工具入参重读**，而是 `recoverProcessDraftFromPayload(payload)` 恢复审批时的 draft
- hash 校验保证 draft 在审批后未被篡改
- 重跑时（agentLoop）通过 `skipApprovalCheck: true + approvalId` 携带审批 ID

#### fail-closed 全链路

| 失败点 | 处理 |
|--------|------|
| payload 缺 processDraft | `PROCESS_DRAFT_MISSING`，不执行 |
| shape 校验失败 | `PROCESS_DRAFT_MISSING`，不执行 |
| 语义校验失败 | `SEMANTIC_VALIDATION_FAILED`，不执行 |
| hash 不匹配 | `PROCESS_DRAFT_HASH_MISMATCH`，不执行 |
| Order 不存在/已删除 | $transaction 抛 `ORDER_NOT_FOUND`，回滚 |
| Status 并发漂移 | $transaction 抛 `STATUS_DRIFT`，回滚 |
| Invoice 金额 ≤ 0 | $transaction 抛 `INVOICE_AMOUNT_INVALID`，回滚 |
| Currency 缺失 | $transaction 抛 `INVOICE_CURRENCY_MISSING`，回滚 |
| AuditLog 写入失败 | $transaction 抛错，回滚（不再 catch non-fatal） |
| 任何异常 | `COMMIT_TRANSACTION_FAILED`，事务已回滚 |

### 5.5 LLM 规划器（llmPlanner.ts，514 行）

#### prompt 构造

`buildAgentSystemPrompt(input)` —— 单一权威 system prompt：
- 身份声明："Bambook Enterprise Agent OS" + actor 信息
- 工作循环描述：每步二选一（call_tool / final_answer），外加 request_form 第三种
- 输出格式（严格 JSON，三种形态 A/B/C）：
  - A: `{thought, action:'call_tool', toolCalls:[{toolId, input, why}]}`
  - B: `{thought, action:'final_answer', finalAnswer}`
  - C: `{thought, action:'request_form', formTitle, fields, submitLabel}`
- 行为规则：必须基于工具结果、不编造、同 toolId+input 不重复调
- 创建/写入规则：先 query 查重 → 再 create
- 可用工具清单：`toolsBlock` 含每个工具的 id/name/scope/risk/description/inputHint

#### 工具选择策略

**完全交给 LLM**。system prompt 只描述能力，不写"当用户说 X 时必须用 Y"规则（防侵蚀红线）。例外：客观业务契约（category 7 选 1、金额用 Decimal）属于事实陈述，写在工具描述里。

#### 输出解析

`parseAndValidate(raw, options)`：
1. `stripCodeFences`：去掉 ```json ``` 包裹
2. 截取第一个 `{` 到最后一个 `}`
3. `JSON.parse(slice)`
4. 校验 `thought` 非空（限 2000 字符）
5. 按 `action` 分支校验
6. `slice(0, maxToolsPerStep)` 限制单步工具数

#### 流式输出

`createIncrementalFieldExtractor`：从 LLM delta 流增量解析 `thought` / `finalAnswer` 字段值，按字符 emit `onThoughtDelta` / `onAnswerDelta`。

### 5.6 记忆与知识（memory.ts + knowledge.ts）

#### 当前实现（stub）

| 服务 | 实现 | 缺口 |
|------|------|------|
| `createMemoryService()` | 进程内数组 `MemoryRecord[]` | 无持久化 / 无向量化 |
| `createKnowledgeService()` | 进程内 chunks 数组 + 关键词子串匹配 | 无 embedding / 无 BM25 / 无 reranking |

#### scope-based 权限隔离

四层 memoryScopes：
- `personal:<userId>`
- `role:<role>`
- `department:<id>`
- `company`

#### 与真实 RAG 的关系

`KnowledgeService` 接口允许替换为真实实现（Prisma `KnowledgeDocument/KnowledgeChunk` + embedding + vector search），但 `knowledge.ts` 本身只是参考实现。

### 5.7 事件与反馈（events.ts + feedbackContract.ts）

#### 19 种 AgentWorkEventPhase

- **旧 orchestrator phase**：start / identity / planning / tool_call / tool_result / assessment / final / error
- **新 agentLoop phase**：iteration_start / thought / plan / tool_call_start / tool_call_end / iteration_end / final_answer
- **流式 phase**：thought_delta / thought_end / answer_delta / answer_end
- **form 交互**：form_request / form_resolved
- **checkpoint/resume**：checkpoint_resumed

#### Block 派生

`emitBlocksForAgentWorkEvent` 派生 4 种 block：
- **form_request** → `emitFormBlock`
- **tool_call_start/end** → `emitToolLifecycleBlock`（running/failed/blocked/succeeded）
- **tool_result complete** → `emitEvidenceBlock` + `emitTableBlockFromOutput`（自动推断列，限 6 列 × 8 行）
- **blocked + high-risk** → `emitApprovalBlock`（pending 状态，等用户决策）

#### 全局事件总线

```ts
export const approvalEventBus = new EventEmitter();
export const formEventBus = new EventEmitter();
```

agentLoop 挂起等待审批/表单提交结果，超时 15 分钟。

### 5.8 任务图（taskFrame.ts + taskGraph.ts）

#### TaskFrame 结构

```ts
type AgentTaskFrame = {
  objective: string;                    // 紧凑化目标（限 240 字符）
  domains: AgentTaskDomain[];          // relations/products/orders/knowledge/entities
  intents: AgentTaskIntent[];          // list/count/schema/lookup/fullProfile/...
  subject?: AgentTaskSubject;          // {kind, value, confidence}
  evidenceRequired: string[];
  completionCriteria: string[];
  shouldContinueAfterFirstHit: boolean;
};
```

#### TaskGraph 结构

```ts
type AgentTaskGraph = {
  id: string;                  // task_<stableHash(query)>
  objective: string;
  taskFrame: AgentTaskFrame;
  planner: 'rules' | 'model-json' | 'fallback';
  degraded: boolean;
  completionPolicy: string[];
  steps: AgentTaskGraphStep[]; // 含 dependsOn + expectedEvidence
};
```

#### 条件后续步（conditionalFollowUpSteps）

- `relations.query + followUp.getFullProfile` → 串行派发 `relations.get` + `relations.expand`
- `products.get + followUp.expand` → 派发 `products.expand`
- `orders.get + followUp.expand` → 派发 `orders.expand`

### 5.9 MCP 集成（mcp/ 子目录）

| 文件 | 行数 | 职责 |
|------|------|------|
| `manifest.ts` | 848 | Tool Manifest 协议（50+ 工具能力清单 + safety 元数据） |
| `planner.ts` | 697 | **已废弃**——旧关键词正则规划路径，仅在 `BAMBOOK_AGENT_LOOP=0` 时 fallback |
| `executor.ts` | 47 | 把 AgentPlan 转为 PlannedToolCall[] 委托 runAgentToolCalls |
| `types.ts` | 57 | ToolManifestSafety / ToolManifest / AgentPlanStep / AgentPlan 类型 |

#### ToolManifestSafety

```ts
type ToolManifestSafety = {
  approval: 'never' | 'risk_based' | 'always';
  sideEffects: boolean;
  editableFields?: string[];
  failClosed?: boolean;
  failClosedCode?: string;
};
```

`getToolManifestSafety(toolId)` 未注册的默认 `{approval:'always', sideEffects:true}` —— **fail-closed**。

#### 外部 MCP 对接

**当前没有真正对接外部 MCP 服务器**。manifest 是内置的 tool capability registry，executor 调的是本地 `toolRuntime.runAgentToolCalls`。架构上预留了 MCP 协议形态但尚未接入 stdio/HTTP MCP server transport。

### 5.10 能力评分与差距

| 维度 | 评分 | 关键强项 | 关键差距 |
|---|---:|---|---|
| 任务理解 | 3.5 | LLM-driven + TaskFrame | intent 推断仍依赖正则 |
| 规划能力 | 4.0 | LLM 自主规划 + TaskGraph | maxSteps=8 / 无 plan 持久化 |
| 工具编排 | 3.5 | 单步多工具 + scratchpad 注入 | 无 DAG 调度 / 无并行资源管理 |
| 执行循环 | 4.0 | plan→tool→observe→reflect + checkpoint | 无结构化反思 / 无智能压缩 |
| 结果评估 | 3.0 | loopController evidence-based | 生产路径不调用 / 无 self-evaluation |
| 权限控制 | 4.5 | RBAC + ProcessDraft + hash + 原子事务 | 无字段级 / 行级权限 / 无审批委派 |
| 记忆/知识 | 2.0 | scope-based 权限隔离 | **进程内 stub / 无向量检索**（最大短板） |
| 完成标准 | 3.0 | stopReason 7 态 + thoughtProcess | completionCriteria 不被消费 |
| 可审计性 | 4.0 | 全链路事件 + AuditLog 同事务 | 无 token/cost 审计 / 无决策树可视化 |
| 多场景评估 | 4.0 | 646 测试 / 17 业务 flow | 无对抗性 / 并发 / 长任务测试 |

**总体评分：3.55 / 5**

**最大改进方向**（按优先级）：
1. 真实 knowledge/memory 实现：替换 stub 为 Prisma + embedding + vector search
2. 结果评估自动化：把 loopController 的 evidence-based 评估提升为生产路径的 gap detector
3. 长任务支持：maxSteps 可配置 + TaskGraph 持久化 + 跨 session resume
4. 字段级 RBAC：扩展到字段粒度（如 merchandiser 能看订单但不能看成本价）
5. LLM 输出 self-evaluation schema：要求 `{confidence, evidence_coverage, missing_evidence}`

---

## 第六部分 前端 UI 现状

### 6.1 18 个 Manager 组件状态

| 组件 | 行数 | 数据来源 | 完成度 | 缺口 |
|------|------|---------|--------|------|
| Dashboard.tsx | 1363 | 真实 API + 全球球图 | 高 | 保留调试标志 |
| OrderManager.tsx | 1554 | 真实 API + importService + llmService | 高 | 无审批分支 |
| GarmentOrders.tsx | 401 | 真实 API | 中-高 | 与 OrderManager 重叠 |
| RelationsManager.tsx | 2096 | 真实 API + geoResolveService | 高 | 表单复杂 |
| ProductsManager.tsx | 3137 | 真实 API + storageService | 高 | 全项目最大组件 |
| FinanceManager.tsx | 1327 | 真实 API（invoice/voucher/allocation） | 高 | — |
| ShipmentManager.tsx | 769 | 真实 API | 中-高 | 无报关单据/装箱单生成 |
| EmailManager.tsx | 1873 | 真实 API + IndexedDB | 高 | react-virtuoso 虚拟列表 |
| DevelopmentManager.tsx | 912 | 真实 API | 中-高 | 缺寄样追踪 |
| HRManager.tsx | 1364 | apiService HR 通道 | 中-高 | 组织架构/团队/项目/分配 |
| AdminPanel.tsx | 1258 | 真实 API | 高 | 完整 RBAC |
| KnowledgeBase.tsx | 281 | 真实 API | 中 | handleEditSave 未走 API |
| DataCenter.tsx | 1801 | 真实 API + localStorage | 中 | 双 tab：数据看板（RAG 问答）+ 数字孪生 |
| ProductionPipeline.tsx | 293 | 真实 API | 高 | 嵌入式组件 |
| ProductionAlerts.tsx | 97 | 真实 API（60 秒轮询） | 中 | 仅显示无操作 |
| Settings.tsx | 1596 | 真实 API | 高 | 8 tab |
| BusinessTools.tsx | 262 | 真实组件 + 跳转卡 | 中 | 4 制单组件 + 6 收编跳转卡 |
| Assistant.tsx | 3221 | 真实 API + STT/TTS | 高 | 全项目最大文件 |

**结论：18 个 Manager 全部对接真实 API，无 mock 数据残留**。

### 6.2 Agent UI 组件

| 组件 | 行数 | 功能 | 完成度 |
|------|------|------|--------|
| AgentProcessPanel.tsx | 190 | 工作过程折叠面板（live/summary） | 高 |
| AgentLiveStatusBar.tsx | 63 | 实时状态条 | 高 |
| AgentMessageCard.tsx | 494 | 消息卡片 + 工作流序列化 + 编辑重发 | 高 |
| AgentTimeline.tsx | 502 | S3 工作流可视化（ThoughtCard→PlanCard→ToolCallCard[]） | 高 |
| AgentPetWindow.tsx | 564 | 桌面浮窗熊猫 + 7 状态切换 | 中-高 |
| BambookPandaAgent.tsx | 550 | 熊猫吉祥物 RIG（14 关节 × 3 skin × 7 state） | 高 |
| PandaLab.tsx | 202 | Panda Sandbox | 中 |

**额外发现**：`components/agent-response/` 子目录共 19 个文件，构成完整的 Agent 响应渲染体系：
- AgentDocumentRenderer / AgentResponseRenderer
- 12 个 block 渲染器：Markdown/Table/Chart/Mermaid/Diagram/Form/Artifact/ToolLifecycle/Evidence/Approval/NextActions/Metric/Unsupported
- AgentTimelineGroup / AgentToolCatalogRail / AgentBlockErrorBoundary / SettingsDrawer / agentResponseTone

### 6.3 设计系统（5 层架构）

| 层 | 文件 | 职责 |
|---|------|------|
| 1. 权威源注册表 | bambookDesignSystem.ts (763 行) | 12 个权威源文件清单 |
| 2. 语义配方 | bambookOsTokens.ts (454 行) | materialRoles / stateModels / layoutRoles / brand / tone / material / controls / spotlight / layout / typography |
| 3. Material 注册表 | osMaterial.ts (28 行) | 4 个 material role + 7 个 shadow role（已退役，强制 'none'） |
| 4. VNext token | osVNext.ts (88 行) | 10 个 role + 完整 CSS 变量集 + 9 个 primitive recipe |
| 5. Design Compiler | osCompiler.ts (530 行) | 12 个视觉系统 + 7 类页面 + 13 个禁止逃逸口 |

#### 13 项守门员测试

- `rdlEmailFlatGuard` / `rdlSettingsFlatGuard` / `rdlProductsBatch3Guard` / `rdlGlobalBatch1Guard` / `rdlLowResidueUIGuard` / `rdlAdminPanelDangerGuard` / `rdlAgentResponseToneGuard`：禁彩色语义 / 禁硬编码 hex / 禁 shadow / Typography 守门
- `rdlContainerContract` / `rdlSharedUIMicroGuard` / `rdlStatusTokenContractGuard` / `rdlVisualBaseline`：容器契约 / 共享 UI / 状态 token / 视觉基线
- `assistantRdlFlatAcceptance` / `digitalArchiveRdlFlatAcceptance`：RDL 验收

### 6.4 业务专用组件

#### components/order/（4 个）
- OrderClusterBlock.tsx (223 行)：订单字段聚类 block，基于 orderSchema cluster 元数据
- OrderFieldInput.tsx (324 行)：通用字段渲染器（8 种 type）
- OrderLinesTable.tsx (136 行)：订单行明细表
- RelationCombobox.tsx (177 行)：可搜索关系 combobox，双值设计（FK + name 快照）

#### components/email/（2 个）
- EmailEditor.tsx (28 行)：纯文本编辑器（与发送管道 bodyText 对齐；react-quill 死引用已移除）
- EmailList.tsx (164 行)：react-virtuoso 虚拟列表

#### components/import/（4 个 ImportWizard 流程）
- ImportWizard.tsx (320 行)：3 步骤向导（Upload → Preview → Confirm）
- StepUpload.tsx (188 行)：拖拽上传 PDF
- StepPreview.tsx (315 行)：解析结果预览 + 行级编辑
- StepConfirm.tsx (115 行)：导入摘要 + 按币种合计

#### components/tools/（5 个）
- ExchangeRateTool.tsx (408 行)：退税核算汇率 = 实时汇率 × 1.13 / (1.13 − 13%)
- SampleInvoiceGenerator.tsx (662 行)：样品发票生成器
- ShippingNoticeGenerator.tsx (614 行)：发货通知 Excel
- FabricSampleInvoiceGenerator.tsx (1499 行)：面料样品发票生成器（最大工具组件）
- sampleInvoiceTemplate.ts (407 行)：发票模板逻辑

### 6.5 UI 现状缺口

| 缺口 | 现状 | 影响 |
|------|------|------|
| **采购管理** | 仅客户 PO 导入，无供应商采购单 | 资金闭环不完整 |
| **仓库管理** | 无入库/出库/盘点/库位 | 库存黑盒 |
| **关务管理** | Shipment 有 'Cleared' 状态但无单据 | 报关手工 |
| **成本核算** | 仅汇率退税工具，无订单成本归集 | 利润不可见 |
| **生产排程** | 仅 10 阶段门禁，无产能排程 | 排产靠经验 |
| **质检管理** | 仅 final inspection，无来料/过程质检 | 质量分散 |
| **报表中心** | Dashboard 少量卡片 | 老板难看全局 |
| **审批中心** | AdminPanel 有权限定义但无独立页面 | 审批散落 |
| **移动端** | 仅 7/18 Manager 有 isMobile prop | 工厂端无法用 |
| **离线模式** | 仅 EmailManager 用 IndexedDB | 断网不可用 |
| **遗留不一致** | FolderTabCard / EmailEditor dead import / HRManager 直接 fetch / OS_SHADOW 死代码 | 维护成本 |

---

## 第七部分 测试与质量

### 7.1 测试覆盖

#### 总计

| 维度 | 数量 |
|------|------|
| Server 端 .test.ts 文件 | 117（105 `__tests__/` + 12 同级散落） |
| Server 端用例总数 | **~1340** |
| 前端 .test.tsx 文件 | 17 |
| 前端 .test.ts 文件（lib/） | 6 |
| 前端用例总数 | **186** |
| E2E 脚本 | 4（2 Playwright + 1 Node SSE + 1 Agent runtime） |
| 部署冒烟脚本 | 5+ |

#### Server 端按目录（Top 10）

| 目录 | 测试文件数 | 用例数 | 覆盖场景 |
|------|-----------|-------|---------|
| agent/__tests__/ | 53 | 626 | Agent Runtime 全栈 |
| __tests__/ | 5 | 99 | 跨模块冒烟 + statusTransition + routeAuthGuard |
| finance/__tests__/ | 6 | 106 | 发票 + 凭证 + 核销 + 作废 |
| shipping/__tests__/ | 3 | 53 | orderLink + shipment + routeAudit |
| email/__tests__/ | 6 | 67 | sync + outbox + route |
| orders/__tests__/ | 4 | 43 | lifecycle + lineMutation + route + query |
| development/__tests__/ | 2 | 40 | mutation + convert |
| import/__tests__/ | 9 | 27 | PDF 解析 + 客户识别 |
| relations/__tests__/ | 4 | 33 | routeAudit + mutation + route + query |
| products/__tests__/ | 3 | 32 | assetAudit + imageAudit + route |

#### 覆盖良好的模块

- **Agent Runtime**：53 文件 / 626 用例，覆盖 commitTransaction(53) / toolRegistry(47) / 所有 flow + executeTool 双层测试
- **Finance**：6 文件 / 106 用例，route + mutation + data-model 三层完整覆盖
- **Email**：6 文件 / 67 用例，route + service + sync + outbox 完整覆盖
- **Shipping**：3 文件 / 53 用例，orderLink(25) 深度覆盖

#### 覆盖不足的模块

| 模块 | 缺口 |
|------|------|
| **Auth** | 仅 2 文件 / 6 用例，与身份权限关键性严重不匹配 |
| **Admin** | 2 文件 / 16 用例，RBAC / 用户管理覆盖薄 |
| **Production** | 仅 2 文件 / 25 用例，10 阶段未充分覆盖 |
| **Import** | 9 文件但仅 27 用例，平均每文件 3 用例 |
| **Audit** | 1 文件 / 19 用例，无 service 层测试 |

### 7.2 CI/CD 现状

#### .github/ 目录

**仅有一份文件：`.github/pull_request_template.md`**

- **没有 GitHub Actions**
- **没有 CI 自动化测试 / lint / typecheck / build**
- PR 模板内容详尽（8 节），强制引用 MODULE_CONTRACT.md

#### 实际 CI/CD 替代方案

- **自动部署**：Mac mini 上 `com.bambook.ops-panel-auto` LaunchAgent 每分钟轮询 GitHub main，有新提交即自动触发部署
- **公网探针**：`com.bambook.public-probe` 每 5 分钟打公网探针
- **代码质量把关完全依赖开发者本地**：`npx tsc --noEmit --skipLibCheck` + `npx electron-vite build` + `npx tsx scripts/e2e-agent-test.ts` + `npm test`

### 7.3 文档体系

#### 49 份文档分类

| 类别 | 数量 | 代表文档 |
|------|------|---------|
| 核心权威 | 21 | ARCHITECTURE / AGENT_RUNTIME_ARCHITECTURE / Bambook_Master_Specification / MODULE_CONTRACT / PRODUCT_DESIGN_AND_ROADMAP |
| 审计快照 | 3 | audit-2026-06-15/CODE_TRUTH / PROJECT_STATE / MANIFEST_DIFF |
| 设计系统 | 13 | design-system/README / design-constitution / tokens / material-grammar / layout-grammar / component-grammar / content-language / page-generation / design-compiler / governance / class-ownership / flat-material-authority / rdl-component-authority |
| STALE/SUPERSEDED | 3 | ERP-CORE-READINESS-AUDIT / ERP-FRONTEND-MANUAL-PATH-AUDIT / task.md |
| 归档 | 9 | archive/superpowers-specs / superpowers-plans / design-history / legacy |

#### 部署脚本

| 脚本 | 作用 |
|------|------|
| Bambook-一键全量部署.command | 顺序部署后端 + 网页端 |
| Bambook-部署后端.command | 仅部署后端到 Mac mini |
| Bambook-部署网页版.command | 仅部署网页端到 jiangsupanda.com |
| Bambook-全栈开发.command | 启动 API + 前端 dev stack |
| Bambook-Electron桌面端.command | 启动 Electron dev |
| Bambook-Preview生产模式.command | 启动已 build 的 Electron Preview |
| Bambook-UI Lab Electron.command | 启动 UI Lab Electron dev |
| deploy/macmini/setup.sh | Mac mini 数据中心一键部署 |
| deploy/macmini/import-data.sh | 数据库 export/import |

---

## 第八部分 现状盘点

### 8.1 已完成（可用）

- ✅ 订单全生命周期管理（建/改/删/状态转移，200+ 字段）
- ✅ 生产管线 10 阶段门禁引擎（3 道业务门禁 + 双签 + 验货阈值）
- ✅ 财务开票/收款/作废/分摊/1:N 核销
- ✅ 客户/供应商档案（40+ 字段）+ 地理可视化
- ✅ 产品档案（面料/成衣/辅料 10+ model）+ 图片资产
- ✅ 装运单（40+ 字段）+ 订单关联 + 8 状态流转
- ✅ 邮件 IMAP 双向同步 + AI 抽取 + 草稿/发件箱
- ✅ RAG 知识库（三层广告过滤 + rerank）
- ✅ Agent 内核（83 工具 + checkpoint + RBAC 11 角色 + commit 审批）
- ✅ Agent E2E 测试（10 场景覆盖 3 道门禁）
- ✅ PDF 订单解析导入（Peerless 解析器）
- ✅ 审计日志（所有财务写入同事务落盘）
- ✅ 设计系统（5 层架构 + 13 项守门员测试）
- ✅ Agent 对话窗口（Assistant.tsx 3221 行 + 19 个响应渲染器）
- ✅ HR 模块（人员/部门/岗位/团队/项目/工作分配）
- ✅ Admin 模块（用户/角色/权限/审批/审计/工具权限）
- ✅ 生产管线前端（OrderManager 内嵌 ProductionPipeline，读 `/api/v1/production/:orderId` 真实阶段数据）
- ✅ 出运制单（ShipmentDocumentGenerator 读真实运单生成 CI/PL/CO/BL 成套单据；4 个制单小组件接真实订单/关系数据）
- ✅ 数据中心业务强化（DataCenter.tsx 双 tab：数据看板为主——RAG 智能问答（向量检索引用 + LLM 流式回答 + 一键归档回语料）；数字孪生布局编辑器保留为次 tab）

### 8.2 进行中 / 半成品

- 🟡 KnowledgeBase.tsx：handleEditSave 仅本地修改未走 API（移动端 PWA 组件，按交付优先级推迟）

### 8.3 缺失 / 未开工

| 模块 | 影响 | 优先级 |
|------|------|--------|
| 采购管理（独立采购单 + 供应商对账） | 资金闭环不完整 | 高 |
| 仓库管理（出入库 + 盘点 + 库位） | 库存黑盒 | 高 |
| 银企对账自动导入（银行流水文件解析 + 自动匹配核销） | 对账全靠手工 | 中 |
| 关务管理（报关单据 + 退税） | 报关手工 | 中 |
| 成本核算（订单级成本归集 + 利润分析） | 利润不可见 | 高 |
| 生产排程（产能日历 + 工序排产） | 排产靠经验 | 中 |
| 质量管理（独立 QC 模块） | 质量分散 | 中 |
| 报表中心（标准财务/销售/库存/生产报表） | 老板难看全局 | 中 |
| 审批中心（独立审批流页面） | 审批散落 | 中 |
| 移动端（工厂端扫码上报） | 工厂端无法用 | 低 |
| 多公司/多账套 | 单法人限制 | 低 |
| Bambook Network（跨企业协作） | 供应链断点 | 低 |

### 8.4 技术债

| 技术债 | 影响 | 优先级 |
|--------|------|--------|
| Prisma 7 兼容性（schema url → config.ts） | 影响 migrate CLI | 中 |
| worktree node_modules 符号链接 | tsc 模块解析差异 | 低 |
| 预存 implicit any（agent/route.ts 等） | 类型安全 | 低 |
| 工具注册表与旧 toolRegistry 并存 | 维护成本 | 中 |
| 4 个 production high-risk mutation 用 simple 注册且 approvalRoles 未设 | 审批 enforcement 不一致 | 高 |
| Templates 模块未启用 router 级 auth guard | 安全风险 | 高 |
| 零 GitHub Actions CI | 质量靠自觉 | 中 |
| E2E 不体系化（Playwright 散落脚本） | 无 fixture/config | 中 |
| 测试组织不一致（105 `__tests__/` + 12 同级散落） | 维护混乱 | 低 |
| Agent memory/knowledge 是 stub | Agent 能力受限 | 高 |
| STALE 文档仍在 active 区 | 误导新成员 | 低 |

---

## 第九部分 Roadmap

### 9.1 阶段划分

| 阶段 | 时间 | 主题 | 目标 |
|------|------|------|------|
| **P0 收尾** | 2026-07 ~ 2026-08 | 主线收拢 + 生产管线落地 | worktree 全部 merge；生产管线前端接数据；Agent 对话窗口可用 |
| **P1 补齐** | 2026-09 ~ 2026-10 | 采购 + 仓库 + 成本 | 闭环 B（资金）完整；订单成本可核算 |
| **P2 智能化** | 2026-11 ~ 2026-12 | Agent 能力深化 + 单证自动化 | 自然语言建单/对账/发货；单证一键生成 |
| **P3 网络化** | 2027-01 ~ 2027-03 | Bambook Network 试点 | 1–2 家上下游通过 MCP 标准协议交换订单状态 |
| **P4 规模化** | 2027-04 ~ 2027-07 | 多公司 + 移动端 + 行业模板 | 支持多账套；工厂端扫码；行业模板可复制 |

### 9.2 P0 收尾（2026-07 ~ 2026-08）— 当前

**目标**：让已有能力真正"用起来"，完成主线收尾。

| 任务 | 交付物 | 验收标准 | 优先级 |
|------|-------|---------|--------| 高 |
| Prisma 7 迁移 | prisma.config.ts + migrate 可用 | `npx prisma migrate status` 无报错 | 高 |
| ~~生产管线前端接数据~~ ✅ 已完成（内嵌 OrderManager，productionService 真实 API） | ProductionPipeline 组件读真实订单 | 老板能看到任一订单的 10 阶段进度 | 高 |
| ~~Agent 对话窗口 MVP~~ ✅ 已完成（Assistant.tsx 3221 行 + 19 渲染器） | 完整对话 UI + 工具调用可视化 | 用户可用自然语言推进订单阶段 | 高 |
| 生产预警接入 | ProductionAlerts 读真实数据 | 阶段超期自动报警 | 高 |
| 修复 4 个 production 工具审批 enforcement | approvalRoles 设置或改 commit 注册 | 审批一致 | 高 |
| Templates 模块加 auth guard | router.use(guard) | 模板端点需鉴权 | 高 |
| 旧 toolRegistry 清理 | 仅保留 toolDispatchRegistry | 代码减少 ≥500 行 | 中 |
| 测试基线固化 | CI 跑全量 vitest | 1526 用例全绿 | 中 |
| 移除 e2e-sse-sim.mjs 硬编码 API Key | 改用 env | 无硬编码密钥 | 高 |
| 真实 knowledge/memory 实现 | Prisma + embedding + vector search | 替换 stub | 中 |

### 9.3 P1 补齐（2026-09 ~ 2026-10）

**目标**：补齐采购、仓库、成本三大缺口，让资金闭环完整。

| 模块 | 核心功能 | 数据模型 | 优先级 |
|------|---------|---------|--------|
| 采购 | 采购单 CRUD / 供应商对账 / 入库关联 | PurchaseOrder / PurchaseLine / SupplierInvoice | 高 |
| 仓库 | 出入库 / 库存查询 / 盘点 / 预警 | StockMovement / StockSnapshot / Warehouse | 高 |
| 成本核算 | 订单成本归集（料+工+费）/ 利润分析 | CostEntry / CostAllocation / ProfitReport | 高 |
| 关务 | 报关单据 / 退税单据 | CustomsDeclaration / DrawbackDoc | 中 |
| 单证生成 | 商业发票 / 装箱单 / 提单草稿 | 复用 RenderedDoc | 中 |

**里程碑**：一个订单从接单到收款，所有成本可归集到订单级，老板能看到单订单利润。

### 9.4 P2 智能化（2026-11 ~ 2026-12）

**目标**：Agent 从"能调用工具"升级到"能完成闭环任务"。

| 能力 | 描述 | 优先级 |
|------|------|--------|
| 自然语言建单 | "客户 ABC 下单 5000 件外套，单价 15 美金，10 月交期" → Agent 起草订单 + 行项目 + 审批 | 高 |
| 自动对账 | 拉取银行流水 → AI 匹配订单 → 生成对账建议 | 高 |
| 单证一键生成 | 订单数据 → 商业发票 / 装箱单 / 提单草稿 | 高 |
| 异常主动通知 | 阶段超期 / 面辅料延迟 / 验货不合格 → Agent 主动推消息 | 中 |
| 邮件智能起草 | 买家来邮 → Agent 起草回复 + 关联订单 | 中 |
| Agent 结果评估自动化 | loopController evidence-based 评估提升为生产路径 gap detector | 中 |
| LLM self-evaluation schema | final_answer 附带 `{confidence, evidence_coverage, missing_evidence}` | 中 |
| 字段级 RBAC | merchandiser 能看订单但不能看成本价 | 中 |
| 长任务支持 | maxSteps 可配置 + TaskGraph 持久化 + 跨 session resume | 低 |

**里程碑**：一个跟单员一天能管理的订单数提升 2 倍。

### 9.5 P3 网络化（2027-01 ~ 2027-03）

**目标**：从"企业内部 ERP"走向"供应链协作节点"。

| 能力 | 描述 |
|------|------|
| Bambook Network 协议 | 基于 MCP 标准协议的跨企业消息/审批/单据交换协议 |
| 上下游协同 | 工厂上报生产进度 → 买家在 Bambook 看到 |
| 单据电子交换 | 商业发票 / 装箱单 / 提单结构化传输 |
| 权限沙箱 | 跨企业可见字段精细控制 |
| 外部 MCP 服务器对接 | 接入 stdio/HTTP MCP server transport |

**里程碑**：1–2 家上下游真实通过 Bambook Network 交换订单状态，不再靠微信/邮件催进度。

### 9.6 P4 规模化（2027-04 ~ 2027-07）

**目标**：从"单一企业定制"走向"行业可复制"。

| 能力 | 描述 |
|------|------|
| 多公司/多账套 | 一个 Bambook 实例支持多法人主体 |
| 移动端 | 工厂端扫码上报进度、QC 扫码验货 |
| 行业模板 | 梭织/针织/家纺差异化模板 |
| 应用市场 | 第三方可发布 Bambook 插件 |
| 云端可选 | 提供 Cloud Edition（数据上云）作为 Desktop 的补充 |
| 报表中心 | 标准财务/销售/库存/生产报表 |
| 审批中心 | 独立审批流页面 + 审批委派 + 超时升级 |

**里程碑**：3 家不同规模的纺织企业采用 Bambook，平均上手周期 < 2 周。

---

## 第十部分 风险评估

### 10.1 产品风险

| 风险 | 等级 | 缓解策略 |
|------|------|---------|
| Agent 误操作导致财务数据错误 | 高 | fail-closed + 审批 + 审计日志 + 不可逆操作二次确认 |
| 用户接受度低（习惯 Excel） | 高 | 渐进式迁移：先做 Excel 的"增强版"，再逐步替代 |
| 行业模板不够通用 | 中 | 先做深 1 家，提炼共性，再做模板 |
| 移动端开发成本高 | 中 | P4 才启动，先用 PWA + 扫码 |
| 4 个 production 工具审批 enforcement 不一致 | 高 | P0 修复（approvalRoles 设置或改 commit 注册） |
| Templates 模块无 auth guard | 高 | P0 修复 |
| Agent memory/knowledge 是 stub | 高 | P0/P1 替换为真实实现 |

### 10.2 技术依赖

| 依赖 | 状态 | 备注 |
|------|------|------|
| Prisma 7 | 待迁移 | schema url 不再支持，需迁 config.ts |
| Electron + Vite | 稳定 | HMR 偶有断连，有重启 SOP |
| RAG 引擎（rerank） | 稳定 | 初次加载高延迟，后续快 |
| 本地 SQLite / PostgreSQL | 稳定 | 小企业 SQLite，大企业 PostgreSQL |

### 10.3 组织依赖

| 依赖 | 说明 |
|------|------|
| 种子客户 | 需 1–2 家愿意共创的纺织企业，提供真实业务场景 |
| 行业顾问 | 纺织生产流程需行业老手校准（门禁阈值、工序定义） |
| 测试设备 | Mac mini 部署 + 张家港真实建筑 GeoJSON 已就绪 |

---

## 第十一部分 度量指标

### 11.1 产品指标

| 指标 | 当前 | 6 个月目标 | 12 个月目标 |
|------|------|-----------|-----------|
| 活跃企业数 | 1（自用） | 3 | 10 |
| Agent 工具数 | 83 | 100 | 130 |
| Agent 自主完成闭环任务占比 | 0% | 20% | 40% |
| 订单从建到收款的平均周期 | 60 天 | 50 天 | 45 天 |
| 单订单管理工时（跟单员） | 8 小时 | 5 小时 | 3 小时 |
| API 端点数 | 200 | 230 | 260 |
| Prisma model 数 | 56+ | 65+ | 75+ |

### 11.2 技术指标

| 指标 | 当前 | 目标 |
|------|------|------|
| 测试用例数 | 1526 | 2000 |
| tsc 错误（agent 目录） | 0 | 0（全仓） |
| Agent E2E 场景覆盖 | 10 | 30 |
| Prisma migration 应用率 | 80% | 100% |
| CI 自动化 | 0% | 100% |
| GitHub Actions | 无 | test + lint + typecheck + build |

### 11.3 体验指标

| 指标 | 当前 | 目标 |
|------|------|------|
| 冷启动时间 | ~3s | <2s |
| Agent 对话首响应 | ~2s | <1s |
| 生产管线页面加载 | 未测 | <500ms |
| 新人上手周期（能独立建单） | 未测 | <1 天 |

### 11.4 Agent 能力指标

| 维度 | 当前评分 | 12 个月目标 |
|------|---------|-----------|
| 任务理解 | 3.5 | 4.5 |
| 规划能力 | 4.0 | 4.5 |
| 工具编排 | 3.5 | 4.5 |
| 执行循环 | 4.0 | 4.5 |
| 结果评估 | 3.0 | 4.0 |
| 权限控制 | 4.5 | 5.0 |
| 记忆/知识 | 2.0 | 4.0 |
| 完成标准 | 3.0 | 4.0 |
| 可审计性 | 4.0 | 4.5 |
| 多场景评估 | 4.0 | 4.5 |
| **总体** | **3.55** | **4.35** |

---

## 第十二部分 立即行动

### 12.1 本周（P0 高优先级）

1. **Prisma 7 迁移** — 创建 `server/prisma.config.ts`，迁移 schema `url` 到配置文件，恢复 `migrate status` 可用
2. ~~生产管线前端接数据~~ ✅ 已完成 — [ProductionPipeline.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/ProductionPipeline.tsx) 内嵌 OrderManager，调用 `/api/v1/production/:orderId` 展示真实订单阶段
3. ~~Agent 对话窗口 MVP~~ ✅ 已完成 — [Assistant.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/Assistant.tsx) 完整对话 UI + 工具调用可视化（19 个响应渲染器）
4. **修复 4 个 production 工具审批 enforcement** — `production.advance_stage / save_checklist / save_inspection / sign_stage` 的 approvalRoles 设置或改 commit 注册
5. **Templates 模块加 auth guard** — `createTemplatesRouter` 内调用 `router.use(guard)`

### 12.2 本月（P0 中优先级）

1. **清理旧 toolRegistry** — 移除 [toolRegistry.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/toolRegistry.ts) deprecated 代码
2. **扩展 Agent E2E 场景** — signStage 双签流程、savePreCutChecklist 流程、get_pipeline 全量字段断言
3. **真实 knowledge/memory 实现** — 替换 [knowledge.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/knowledge.ts) + [memory.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/memory.ts) stub 为 Prisma + embedding + vector search
4. **CI 自动化** — 添加 GitHub Actions（test + lint + typecheck + build）

### 12.3 下月（P0 收尾 → P1 启动）

1. **采购模块设计** — PurchaseOrder / PurchaseLine / SupplierInvoice 数据模型 + API + Agent 工具
2. **仓库模块设计** — StockMovement / StockSnapshot / Warehouse 数据模型
3. **成本核算设计** — CostEntry / CostAllocation / ProfitReport 数据模型
4. **单证生成接入订单数据** — 复用 [templates/](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/templates) 模块

---

## 附录 A：关键文档索引

| 文档 | 路径 |
|------|------|
| 技术架构 | [docs/ARCHITECTURE.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/ARCHITECTURE.md) |
| Agent 运行时架构 | [docs/AGENT_RUNTIME_ARCHITECTURE.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/AGENT_RUNTIME_ARCHITECTURE.md) |
| 主规范 | [docs/Bambook_Master_Specification.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/Bambook_Master_Specification.md) |
| 模块契约 | [docs/MODULE_CONTRACT.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/MODULE_CONTRACT.md) |
| 工具注册表 Schema | [docs/P0B-TOOL-REGISTRY-SCHEMA.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/P0B-TOOL-REGISTRY-SCHEMA.md) |
| 业务规则分析 | [docs/erp-business-rules-analysis.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/erp-business-rules-analysis.md) |
| ERP 升级计划 | [docs/erp-upgrade-plan.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/erp-upgrade-plan.md) |
| 横向闭环验证矩阵 | [docs/ERP-OS-CROSS-MODULE-SMOKE-MATRIX.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/ERP-OS-CROSS-MODULE-SMOKE-MATRIX.md) |
| 全栈审计报告 | [docs/fullstack-audit-report.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/fullstack-audit-report.md) |
| 设计系统 | [docs/design-system/](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/design-system) |
| 代码事实快照 | [docs/audit-2026-06-15/CODE_TRUTH.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/audit-2026-06-15/CODE_TRUTH.md) |
| 阶段总结 | [PROJECT_SUMMARY.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/PROJECT_SUMMARY.md) |
| Agent OS 使用说明书 | [docs/Bambook-Agent-OS-使用说明书.md](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/docs/Bambook-Agent-OS-使用说明书.md) |

## 附录 B：阶段 Commit 里程碑

| Commit | 里程碑 |
|--------|-------|
| `e36be6f` | 项目阶段总结文档（本基线） |
| `f6cb617` | Merge worktree 47 commit 到 main — 主线收拢 |
| `1dd723d` | Agent E2E 10 场景全通过（3 道门禁覆盖） |
| `4da26c2` | Agent 目录 tsc 零错误 |
| `81f524b` | toolDispatchRegistry — 83 工具注册表成型 |
| `33b6c51` | Agent checkpoint/resume 能力 |
| `5a2923e` | RBAC 11 角色（含 production_manager/factory） |
| `70d2119` | 生产管线 10 阶段门禁引擎 + 14 单元测试 |

---

**结语**：Bambook ERP OS 已完成"骨架 + 内核"阶段——21 个业务域 / 56+ 数据模型 / 200 API 端点 / 83 Agent 工具 / 18 Manager 组件 / 1526 测试用例全部就绪。下一步的关键不是堆功能，而是**让已有能力真正被用起来 + 补齐资金闭环三大缺口 + 替换 Agent 记忆/知识 stub**。P0 收尾后，再进入 P1 补齐采购/仓库/成本，让资金闭环完整。智能化与网络化是中长期差异化，但必须建立在"企业内部 SSOT 真正落地"的基础之上。
