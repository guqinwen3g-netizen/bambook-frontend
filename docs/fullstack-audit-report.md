# Bambook 全栈审计报告

> 审计日期：2026-07-06
> 审计范围：后端数据层/API、前端模块/组件、Agent 架构、基础设施/部署
> 项目定位：羊毛面料外贸 ERP OS + AI Agent 桌面应用

---

## 〇、项目规模一览

| 维度 | 数量 | 说明 |
|------|------|------|
| 后端源码文件 | 232 个 .ts | server/src/ |
| 后端总行数 | ~55,253 行 | |
| 前端组件文件 | 158 个 .tsx/.ts | components/ |
| 前端总行数 | ~55,112 行 | |
| lib 工具层 | 19 个 .ts | |
| Prisma Model | 56 个 | |
| REST API 端点 | 173 个 | |
| MCP 工具注册 | 80 个 | manifest.ts |
| toolRuntime if 分支 | 108 个 | toolRuntime.ts |
| 测试文件 | 8 个（非 node_modules） | |
| 文档 | 46 个 .md | docs/ |
| process.env 引用 | 167 处 | |
| $transaction 使用 | 362 处 | 事务覆盖良好 |

---

## 一、后端数据层审计

### 1.1 数据模型（56 个 Model）

**按 domain 分布**：

| Domain | Model 数 | 核心 Model |
|--------|---------|-----------|
| Orders | 3 | Order, OrderLine, OrderStatusTransition |
| Products | 12 | ProductAsset, FabricProfile, GarmentProfile, TrimmingProfile, FabricCompositionLine, FabricCustomerCode, FabricPriceHistory, FabricCertification, ProductClassification, ProductClassificationLink, MaterialCompositionTerm, ProductImage |
| Relations | 1 | Relation（客户/供应商/联系人统一表） |
| Finance | 4 | Invoice, PaymentVoucher, InvoiceAllocation, Shipment |
| Shipping | 2 | Shipment, ShipmentLine |
| Development | 1 | DevelopmentCase |
| Knowledge | 6 | KnowledgeDocument, KnowledgeChunk, KnowledgeRelation, EntityReference, EntityAlias, EntityLink |
| Agent | 8 | AgentSession, AgentMessage, AgentMemory, AgentTool, AgentToolPermission, AgentToolRun, AgentJob, AgentSuggestion |
| Auth/System | 7 | UserAccount, Department, Role, UserRole, Permission, RolePermission, AgentPolicy |
| 审批/审计 | 3 | ApprovalRequest, AuditLog, RenderedDoc |
| 其他 | 9 | BusinessProfile, KnowledgeItem, Insight, ProjectMemory, SystemAsset, PdmlRawFabric 等 |

**关键发现**：

- ✅ **事务覆盖好**：362 处 `$transaction` 使用，业务写入有事务保护
- ⚠️ **时间戳不一致**：Order 表混用 BigInt（毫秒时间戳）和 DateTime，DevelopmentCase/Shipment 用 DateTime，Order 用 BigInt——跨模块 JOIN 和时间比较需要额外转换
- ⚠️ **生产管线数据空白**：无 ProductionStage / PreCutChecklist / InspectionReport model，10 阶段生产流程无数据载体
- ⚠️ **样衣分档缺失**：DevelopmentCase 无 sampleTier 字段，5A/普通样衣无法区分

### 1.2 API 路由（173 个端点 × 17 个路由模块）

| 路由模块 | 挂载前缀 | 功能 |
|---------|---------|------|
| ai/route.ts | /api/ai | AI 对话/搜索/TTS |
| auth/route.ts | /api/auth | 注册/登录/验证 |
| admin/route.ts | /api/admin | 用户/角色/审批/审计 |
| agent/route.ts | /api/agent | Agent 工具调用/审批 |
| import/route.ts | /api/v1/import | PDF 订单导入 |
| orders/route.ts | /api/v1/orders | 订单 CRUD+生命周期 |
| orders/orderLinesRoute.ts | /api/v1/order-lines | 订单行 |
| relations/route.ts | /api/v1/relations | 关系智库 |
| products/route.ts | /api/v1/products | 产品档案 |
| development/route.ts | /api/v1/development | 开发管理 |
| finance/route.ts | /api/v1/finance | 发票/凭证 |
| shipping/route.ts | /api/v1/shipping | 货运 |
| templates/route.ts | /api/v1/templates | 模板系统 |
| email/route.ts | /api/v1/email | 邮件 |
| entities/route.ts | /api/v1/entities | 实体注册表 |
| pdml/route.ts | /api/v1/pdml | 面料数据同步 |
| system-assets/route.ts | /api/v1/system-assets | 系统资产 |

**关键发现**：

- ✅ **Service 层分离较好**：orders/development/shipping 都有独立 MutationService + LifecycleService
- ⚠️ **无 `/api/v1/production` 路由**：生产管线无 API 暴露
- ⚠️ **products/route.ts 过大**：1109 行单文件，应拆分
- ⚠️ **无 API 文档**：无 OpenAPI/Swagger，46 个 docs 全是 .md 设计文档

### 1.3 业务逻辑状态机

| 模块 | 状态机定义 | 状态值 | 评价 |
|------|----------|--------|------|
| Order | ✅ VALID_ORDER_STATUSES | 6 个 | Pending→Confirmed→Production→Shipping→Delivered→Alert |
| Shipment | ✅ VALID_SHIPMENT_STATUS | 8 个 | Draft→Booked→Loading→Shipped→Arrived→Cleared→Delivered |
| DevelopmentCase | ✅ VALID_STAGES | 6 个 | developing→shipping→feedback→revision→approved→cancelled |
| **Production** | ❌ 无 | — | **核心缺口** |
| **Inspection** | ❌ 无 | — | **核心缺口** |
| **PreCutCheck** | ❌ 无 | — | **核心缺口** |

### 1.4 安全审计

| 检查项 | 状态 | 说明 |
|--------|------|------|
| API 认证中间件 | ✅ 有 | /api/v1/* 有 auth guard |
| SQL 注入风险 | ✅ 低 | 仅 1 处 $queryRaw/$executeRaw |
| API Key 校验 | ✅ 有 | X-Bambook-API-Key header |
| Rate Limiting | ❌ 无 | **无任何限流** |
| 环境变量管理 | ⚠️ | 167 处 process.env，无 schema 校验 |

---

## 二、前端审计

### 2.1 页面/视图（17 个 View × 12 个侧边栏模块）

| View | 组件 | 状态 |
|------|------|------|
| Dashboard | Dashboard / CompiledDashboardPage | ✅ 含 3D 地球 |
| Assistant | Assistant.tsx (3228行) | ✅ |
| Relations | RelationsManager.tsx (2111行) | ✅ |
| Products | ProductsManager.tsx (3150行) | ✅ |
| Emails | EmailManager.tsx (1859行) | ✅ |
| Orders | OrderManager + GarmentOrders | ✅ |
| Invoices | FinanceManager | ✅ 通过财务 Tab |
| PaymentVouchers | FinanceManager | ✅ |
| Shipments | ShipmentManager | ✅ |
| Development | DevelopmentManager | ✅ |
| KnowledgeBase | DataTwinCenter.tsx (1597行) | ✅ |
| Settings | Settings.tsx (1596行) ×3 mode | ✅ |
| BusinessTools | BusinessTools | ✅ |
| UiLab | dev-panda-lab | ✅ 开发用 |
| AdminPanel | AdminPanel.tsx | ✅ 6 Tab RBAC |

**孤儿视图**：无。所有 View 枚举都有渲染分支。

### 2.2 最大文件（重构候选 Top 10）

| 文件 | 行数 | 问题 |
|------|------|------|
| compiledProductsTemplates.tsx | 4217 | 编译产物，应考虑源码分离 |
| Assistant.tsx | 3228 | **过大**，AI 对话+工具展示+表单全在一个文件 |
| ProductsManager.tsx | 3150 | **过大**，面料/成衣/辅料/图片全在一起 |
| compiledRelationsTemplates.tsx | 2227 | 编译产物 |
| RelationsManager.tsx | 2111 | **过大** |
| EmailManager.tsx | 1859 | **过大** |
| RelationsManager.test.tsx | 1636 | 测试文件 |
| compiledSettingsTemplates.tsx | 1619 | 编译产物 |
| DataTwinCenter.tsx | 1597 | **过大** |
| Settings.tsx | 1596 | 含 8 个 Tab，可拆分 |

### 2.3 代码质量

| 指标 | 数值 | 评价 |
|------|------|------|
| TODO/FIXME/HACK | 15 个文件 | 可控 |
| inline style (style={{}}) | 36 个文件 | 偏多，应抽 CSS class |
| 测试文件 | 8 个 | **严重不足**（158 个组件只覆盖 5%） |
| osCompiler 编译模板 | 3 个文件 >6000 行 | 应评估是否需要保留编译产物在源码中 |

### 2.4 导航一致性

- View enum（17 项）与 moduleRegistry（12 个 primary）**一致**
- AdminPanel 6 Tab RBAC 体系完整
- Sidebar 展开态（270px）/折叠态（64px）双形态正常

---

## 三、Agent 架构审计

### 3.1 Agent 循环

| 组件 | 文件 | 行数 | 状态 |
|------|------|------|------|
| 主循环 | agentLoop.ts | 780 | ✅ 有 while + 三重边界（maxSteps=8/budget=90s/timeout=30s） |
| LLM 决策 | llmPlanner.ts | ~600 | ✅ JSON 解析+修复重试 |
| 旧编排器 | orchestrator.ts | ~400 | ⚠️ 退化为 fallback |
| 循环判定 | loopController.ts | ~400 | ⚠️ 旧路径专用 |

### 3.2 工具体系

| 指标 | 数值 | 说明 |
|------|------|------|
| Manifest 注册工具 | 80 个 | ✅ 有 name/inputHint/safety/risk/domain |
| toolRuntime if 分支 | 108 个 | 🔴 **开闭原则严重违反** |
| ToolRegistry P0-B | ~25 个 | ✅ draft→approval→commit 三阶段 |
| 工具按 risk 分布 | low:40+ / medium:5+ / high:30+ | |
| 工具按 domain 分布 | orders/products/relations/finance/shipping/development/knowledge/email/templates | 8 个 domain |

**关键发现**：

- 🔴 **toolRuntime.ts 5474 行**：全项目最大文件，108 个 `if(call.toolId === 'xxx')`，新增工具必须改这个文件
- ⚠️ **孤儿工具风险**：manifest 注册 80 个但 toolRuntime 分支 108 个，存在 manifest 新增但无实现 或 实现有但未注册的可能
- ✅ **ToolManifest schema 成熟**：name/inputHint/inputSchema/safety/risk/domain/examples 字段完整

### 3.3 审批体系

| 组件 | 状态 | 说明 |
|------|------|------|
| ApprovalRequest model | ✅ | requester/reviewer/actionType/risk/payload/status |
| 审批拦截 | ✅ | toolRuntime 执行前检查 policy + safety.approval |
| 审批挂起 | ✅ | agentLoop 中 `approvalEventBus.on('resolved')` |
| 审批路由 | ✅ | POST /approvals/:id/resolve |
| 审批总线 | ⚠️ | **EventEmitter 单进程**，重启丢失 |
| 三方联动 | ✅ | 拦截→挂起→唤醒 闭环 |

### 3.4 记忆和会话

| 能力 | 状态 | 说明 |
|------|------|------|
| AgentSession | ✅ | 会话持久化 |
| AgentMessage | ✅ | 消息存储 |
| AgentMemory | ✅ | scope: personal/department/company/system |
| 记忆抽取 | ✅ | memoryExtractor，stopReason=final_answer 时触发 |
| 记忆检索 | ✅ | recall by confidence, minConfidence 0.7 |

### 3.5 Agent 能力成熟度

| 能力 | 状态 | 评价 |
|------|------|------|
| 多步循环 | ✅ 已有 | maxSteps=8 |
| 工具调用 | ✅ 已有 | 80 个工具 |
| 审批拦截 | ✅ 已有 | 三方联动 |
| 记忆体系 | ✅ 已有 | scope 分层 |
| **流式输出** | ❌ 缺失 | stream:false 硬编码，思考黑箱 |
| **Checkpoint/Resume** | ❌ 缺失 | 无中间态持久化 |
| **Sub-Agent** | ❌ 缺失 | 单 Agent 单线程 |
| **评测体系** | ⚠️ 雏形 | 有 evaluation.test.ts 但覆盖不足 |
| **工具注册表** | ❌ 缺失 | 108 个 if 分支替代 |
| **上下文管理** | ⚠️ 粗糙 | history.slice(-8) 硬编码 |

---

## 四、基础设施审计

### 4.1 技术栈

| 层 | 技术 | 版本/配置 |
|----|------|---------|
| 前端 | React + TypeScript + Vite | Electron 桌面端 |
| 后端 | Express + TypeScript | 1072 行 index.ts |
| 数据库 | PostgreSQL + Prisma ORM | 56 model |
| AI | Volcengine Ark API | stream:false |
| 部署 | Mac Mini + Cloudflare Tunnel | launchd KeepAlive |
| 桌面 | Electron | better-sqlite3 native |

### 4.2 部署能力

| 能力 | 状态 | 说明 |
|------|------|------|
| 后端打包部署 | ✅ | `deploy:server` → ops-upload-package.sh |
| 前端打包部署 | ✅ | `deploy:web` → ops-upload-webapp.sh |
| 一键全量部署 | ✅ | `deploy:all` |
| 远端自动编译 | ✅ | Mac Mini 上 tsc 编译 |
| Electron 构建 | ✅ | `electron:build` |
| 生产预览 | ✅ | Bambook-Preview生产模式.command |
| Docker | ❌ | 无 Dockerfile |
| CI/CD | ❌ | 无 .github/workflows |
| 自动更新 | ❌ | 无 auto-update |

### 4.3 运维

| 能力 | 状态 | 说明 |
|------|------|------|
| 服务自启动 | ✅ | launchd KeepAlive |
| 远程命令 | ✅ | OPS Jobs API |
| 远程文件 | ✅ | OPS Files API |
| 健康检查 | ✅ | /api/health |
| 实时推送 | ✅ | SSE /api/v1/events |
| 日志系统 | ⚠️ | console 为主，无结构化日志 |
| 监控告警 | ❌ | 无 |

### 4.4 开发脚本

| 脚本 | 用途 |
|------|------|
| dev:stack | 全栈开发（前后端一起） |
| dev:agent-local | Agent 本地栈 |
| dev:panda-lab | UI 实验室（端口 3105） |
| electron:dev | Electron 开发模式 |
| audit:os-vnext | OS 设计系统审计 |
| agent:status | Agent 运行时状态检查 |
| restart:dev | 重启开发环境 |
| reload | 热重载 Electron |

---

## 五、各维度成熟度评分

> 评分标准：★☆☆☆☆(缺失) ~ ★★★★★(成熟)

### ERP OS 业务模块

| 模块 | 成熟度 | 说明 |
|------|--------|------|
| 订单管理（面料） | ★★★★☆ | 数据/API/UI 完整，缺生产管线 |
| 订单管理（成衣） | ★★★☆☆ | 有 productionSteps 但太简陋 |
| 关系智库 CRM | ★★★★★ | 字段丰富，组织+联系人双层 |
| 数字档案 PLM | ★★★★☆ | 面料/成衣/辅料 profile 完整 |
| 财务管理 | ★★★★☆ | 发票+凭证+核销完整 |
| 货运管理 | ★★★★☆ | 状态机完善 |
| 开发/样品管理 | ★★★☆☆ | 有阶段流转，缺 5A 分档 |
| **生产管线** | ★☆☆☆☆ | **核心空白** |
| 邮件管理 | ★★★★☆ | IMAP+AI 抽取 |
| 知识库/RAG | ★★★★☆ | 文档+分块+ACL |
| RBAC 权限 | ★★★★☆ | 完整但缺生产角色 |
| 审批/审计 | ★★★★☆ | 三方联动 |

### Agent 系统

| 能力 | 成熟度 | 说明 |
|------|--------|------|
| 循环架构 | ★★★★☆ | 骨架正确 |
| 工具覆盖 | ★★★★☆ | 80 个工具，8 domain |
| 工具注册 | ★☆☆☆☆ | 108 个 if 是最大债 |
| 审批体系 | ★★★★☆ | 模式正确，实现需升级 |
| 记忆体系 | ★★★★☆ | scope 分层完善 |
| 流式输出 | ★☆☆☆☆ | stream:false |
| Checkpoint | ★☆☆☆☆ | 无 |
| Sub-Agent | ★☆☆☆☆ | 无 |
| 评测体系 | ★★☆☆☆ | 雏形 |

### 基础设施

| 能力 | 成熟度 | 说明 |
|------|--------|------|
| 部署流水线 | ★★★★☆ | OPS API 完善 |
| 桌面打包 | ★★★★☆ | Electron 全流程 |
| 远程运维 | ★★★★☆ | Jobs + Files API |
| CI/CD | ★☆☆☆☆ | 无 |
| 测试覆盖 | ★☆☆☆☆ | 8 个测试文件 / 158 个组件 |
| 日志/监控 | ★★☆☆☆ | console 为主 |
| API 文档 | ★☆☆☆☆ | 无 OpenAPI |

### 前端工程

| 能力 | 成熟度 | 说明 |
|------|--------|------|
| 模块组织 | ★★★★☆ | moduleRegistry 统一管理 |
| 设计系统 | ★★★★☆ | osCompiler/osVNext 原语体系 |
| 组件拆分 | ★★☆☆☆ | 多个 >2000 行巨型组件 |
| 测试覆盖 | ★☆☆☆☆ | 极低 |
| 样式管理 | ★★★☆☆ | 有 index.css + inline 混用 |

---

## 六、关键风险清单

### 🔴 高风险（必须优先解决）

| # | 风险 | 影响 | 所在文件 |
|---|------|------|---------|
| R1 | **toolRuntime 108 个 if 分支** | 新增工具风险集中，开闭原则违反 | toolRuntime.ts (5474行) |
| R2 | **生产管线数据层空白** | 核心业务流程无法系统化 | schema.prisma |
| R3 | **stream:false 硬编码** | Agent 思考黑箱，用户体验差 | runner.ts:506 |
| R4 | **测试覆盖极低** | 158 组件仅 8 个测试，回归风险高 | 全局 |
| R5 | **审批 EventEmitter 单进程** | 重启丢失挂起审批 | events.ts |

### 🟡 中风险（需要规划）

| # | 风险 | 影响 |
|---|------|------|
| R6 | 前端多个 >2000 行巨型组件 | 维护困难，Assistant/Products/Relations |
| R7 | 时间戳 BigInt/DateTime 混用 | 跨模块时间比较需转换 |
| R8 | 无 Rate Limiting | API 可被滥用 |
| R9 | 无 CI/CD | 依赖手动部署 |
| R10 | 无 API 文档 | 前后端协作靠口头 |
| R11 | history.slice(-8) 硬编码 | 长对话上下文丢失 |
| R12 | 无结构化日志 | 生产问题排查困难 |

### 🟢 低风险（技术债）

| # | 风险 | 影响 |
|---|------|------|
| R13 | 36 个文件用 inline style | 样式管理不统一 |
| R14 | 15 个文件有 TODO/FIXME | 可控范围内 |
| R15 | osCompiler 编译产物在源码中 | 增加 repo 体积 |
| R16 | 167 处 process.env 无 schema | 配置管理松散 |

---

## 七、改造优先级建议

### 第一优先级：补齐业务核心（ERP OS）

| 改造 | 对应风险 | 工期估 |
|------|---------|--------|
| 生产管线数据层（3 model + 角色扩展） | R2 | 2-3 天 |
| 生产管线状态机+门禁引擎 | R2 | 2-3 天 |
| 生产管线前端 UI | R2 | 2-3 天 |
| 样衣 5A 分档增强 | R2 | 1 天 |

### 第二优先级：Agent 系统能力升级

| 改造 | 对应风险 | 工期估 |
|------|---------|--------|
| 流式 Harness（stream:true + 增量 JSON） | R3 | 3 天 |
| ToolRegistry 抽象（卸载 108 个 if） | R1 | 3 天 |
| History/Observation 策略升级 | R11 | 2 天 |
| 审批持久化（PostgreSQL LISTEN/NOTIFY） | R5 | 2 天 |

### 第三优先级：工程基础设施

| 改造 | 对应风险 | 工期估 |
|------|---------|--------|
| 测试体系搭建（先覆盖核心 service 层） | R4 | 持续 |
| 前端巨型组件拆分（Assistant/Products） | R6 | 3-5 天 |
| CI/CD 基础（GitHub Actions） | R9 | 1-2 天 |
| API 文档（OpenAPI 自动生成） | R10 | 1-2 天 |
| Rate Limiting | R8 | 0.5 天 |

### 第四优先级：长期能力

| 改造 | 对应风险 | 工期估 |
|------|---------|--------|
| Checkpoint/Resume | — | 3-5 天 |
| Sub-Agent / TaskFrame | — | 5-7 天 |
| 评测体系完善 | — | 持续 |
| 结构化日志（pino/winston） | R12 | 1-2 天 |

---

## 八、已有设计亮点（必须保留）

1. **ToolManifest schema 体系**：name/inputHint/safety/risk/domain/examples，是工具注册+审批+前端展示的同源数据源
2. **审批三方联动**：toolRuntime 拦截 → agentLoop 挂起 → route 唤醒，架构模式正确
3. **Memory scope 分层**：personal/department/company/system，干净可扩展
4. **Shipment 状态机**：8 状态 + 合法转移规则，是最完善的状态机
5. **moduleRegistry 统一导航**：12 个模块集中注册，权限驱动显示
6. **AdminPanel RBAC**：6 Tab 完整的用户/角色/权限/审批/审计/工具管理
7. **OS 设计系统**：osCompiler/osVNext 原语体系，统一设计语言
8. **事务覆盖**：362 处 $transaction，业务写入有保护
9. **OPS 远程运维**：Jobs + Files API，支持远程部署和调试
10. **fail-closed 安全默认**：getToolManifestSafety 缺省返回 approval='always'

---

## 九、总结

**Bambook 是一个架构骨架正确、业务模块成熟度不均匀的系统。**

- **交易链（订单→发货→收款）已经跑通**：数据/API/UI/状态机四位一体，财务/货运/邮件/知识库各就各位
- **生产链是核心缺口**：从面辅料到验货发货的 10 阶段流程没有系统化载体
- **Agent 有骨架但缺肌肉**：循环/工具/审批/记忆都有，但流式/注册表/checkpoint/评测都缺
- **工程基础设施可用但粗糙**：部署/运维/远程命令完善，测试/CI/CD/文档/监控缺失
- **最大单点风险是 toolRuntime.ts**：5474 行 + 108 个 if 分支，是所有 Agent 升级的前置阻塞

**建议推进路径**：先补生产管线（ERP OS 核心）→ 再升级 Agent Harness（流式+注册表）→ 最后补工程基础设施（测试+CI+文档）。三条线可部分并行。
