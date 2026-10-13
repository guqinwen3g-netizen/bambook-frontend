# Bambook Module Contract

> 一个"完整业务模块"在 Bambook 全栈里**必须**接入的所有契约点位。
> 这是 PR review 的勾选清单，也是 `scripts/scaffold-module.ts` 生成器（待开发）的 source of truth。

Last reviewed: 2026-06-15
Author: Bamboo（基于优先级 1 端到端联调踩坑沉淀）

---

## 0. 这份文档解决什么

2026-06-15 优先级 1 的端到端联调暴露了一类系统性问题：**「单元代码层面 OK ≠ 产品层面 OK」**。
具体踩坑：

- 加 11 个 MCP 工具，manifest 写了、toolRuntime 写了、tsc/build 全绿，
  但**漏注册到 `defaults.ts` 的 RBAC**，运行时 100% `TOOL_NOT_REGISTERED`。
- 加 `links.query` 工具，executor 期望 `{type, id}`，
  但 manifest schema 写的是 `{fromType, fromId}` —— **同一工具的入参契约自相矛盾**。
- 新增"开发管理"域，没有相应的 planner 触发规则，
  自然语言里说"Peerless 关联的开发单"会被路由到无关的 `entities.search`。
- demo seed 直接写 `EntityLink` 而不走 `sync.ts`，
  造成 link 和 reference 双轨、kind 不规范，审计统计正确但内部一致性崩溃。

根因都是**「同一概念散落在多处，加新东西时漏了某一处」**。
这份契约把所有点位收口、命名固定、依赖明确，
让"新增一个模块/工具/关系"变成一份**勾选清单**而不是**记忆游戏**。

---

## 1. 名词约定

| 名词 | 含义 |
|---|---|
| **业务模块** | 用户可见的产品域，例如"关系智库"、"数字档案"、"生产管理"、"开发管理"。一个模块 ≈ 一组核心实体 + 一组 API + 一组 MCP 工具 + 一个前端页面。 |
| **核心实体** | 模块对应的 Prisma 模型，例如 `Order`、`OrderLine`、`DevelopmentCase`、`Relation`。 |
| **MCP 工具** | Agent 可调用的能力单元，命名为 `{domain}.{verb}`，例如 `orders.query`、`development.update_stage`。 |
| **EntityLink** | 跨实体的有向关系（`fromType/fromId → toType/toId`，带 `linkKind`），是图谱查询的一等公民。 |
| **EntityReference** | 实体的字段级快照（`ownerType/ownerId/fieldKey → targetType/targetId` + 快照 JSON），用于"一键填充"和列表展示。 |
| **审批（Approval）** | 写类工具触发 `ApprovalRequest` 落库，前端走 `/approvals/:id/resolve` 决策，决策后下一轮 Agent 才真正执行。 |
| **同步双写** | 业务实体写入路径必须**同时**调用 `entities/sync.ts` 维护 EntityLink + EntityReference，二者 1:1 对齐。 |

---

## 2. 模块的八个契约层

一个完整业务模块 **必须** 接入这八层。少一层就是「半成品」。

```
                 ┌─────────────────────┐
                 │  L1 数据层（Prisma） │
                 └──────────┬──────────┘
                            │
                 ┌──────────┴──────────┐
                 │  L2 API 层（REST）   │
                 └──────────┬──────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
   ┌────────┴────────┐ ┌────┴────┐ ┌────────┴────────┐
   │ L3 同步层       │ │ L4 审批 │ │ L5 Agent 层     │
   │ entities/sync   │ │ Approval│ │ MCP 4 处同步    │
   └─────────────────┘ └─────────┘ └────────┬────────┘
                                            │
                                  ┌─────────┴─────────┐
                                  │ L6 Planner 触发    │
                                  └─────────┬─────────┘
                                            │
                                  ┌─────────┴─────────┐
                                  │ L7 测试层（E2E）   │
                                  └─────────┬─────────┘
                                            │
                                  ┌─────────┴─────────┐
                                  │ L8 前端注册 + UI  │
                                  └───────────────────┘
```

下面逐层定义"新增模块要改什么、不能漏什么、如何验收"。

---

### L1 数据层（Prisma）

**目标**：核心实体的 Schema、迁移、Demo 数据。

| 必做项 | 文件 | 验收 |
|---|---|---|
| 1.1 Prisma 模型 | `server/prisma/schema.prisma` | `npx prisma generate` 通过 |
| 1.2 迁移 / DDL | `server/prisma/migrations/` 或 直接 DDL（shadow DB 受阻时） | 数据库实际有表 |
| 1.3 Demo 数据 | `server/scripts/seed-demo-data-v2.ts` 追加 | seed 跑完后实体数 ≥ 业务最小值 |
| 1.4 类型导出 | `types.ts`（前端镜像） | `tsc --noEmit` 无 error |

**硬规则**：

- **R1.1** 所有时间戳用 `BigInt`（项目惯例：`createdAt`/`updatedAt` = 毫秒数），不用 `DateTime`，避免时区/Prisma JSON 序列化坑。
- **R1.2** 实体 ID 用 string 显式生成（`{TYPE}__{shortId}`），不用 cuid 默认值——为了 sync 层的 `linkIdFor`/`referenceIdFor` 可重入。
- **R1.3** 关系字段必须**同时存** `*Name`（快照）+ `*RelationId`（外键），sync.ts 才能写 EntityReference 的 `snapshot.label`。
- **R1.4** 涉及枚举值（status/stage/type）不要落 Prisma `enum`，用 `String` + 常量数组，避免迁移阻塞。
- **R1.5** Demo 数据必须**通过路由层 / sync 层**写入，不允许 createMany 直插 EntityLink/Reference（2026-06-15 踩坑）。

---

### L2 API 层（REST）

**目标**：REST 路由 + zod/手写校验 + 错误码。

| 必做项 | 文件 | 验收 |
|---|---|---|
| 2.1 路由文件 | `server/src/{module}/route.ts` | 注册到 `index.ts` |
| 2.2 输入校验 | 同文件内的 schema/guard | 非法入参返回 400 + 错误码 |
| 2.3 错误码 | 与已有惯例对齐：`UNAUTHORIZED`/`FORBIDDEN`/`NOT_FOUND`/`VALIDATION_ERROR`/`{DOMAIN}_{REASON}` | grep `code:` 检查 |
| 2.4 路由顺序 | 单段字面量路径（如 `/kanban/summary`）放在 `/:id` 之前 | E2E 不命中错路由 |
| 2.5 写入路径调 sync | mutation 末尾调 `syncXxxEntityReferences()`，**失败不阻塞主流程**（`.catch(noop)`） | 写后 EntityLink/Reference 1:1 对齐 |

**硬规则**：

- **R2.1** **写不阻塞读**：sync.ts 调用必须 try/catch 吞掉异常，主返回码不受影响。日志要打。
- **R2.2** 输入字段白名单：mutation 路由用显式 pick，不用 `req.body` 整体透传——防止前端无意写入受保护字段（如 `id`/`createdAt`）。
- **R2.3** 状态变更类操作（`update_status` / `update_stage`）必须**同时**写审计表（`OrderStatusTransition` 等），不能只更新主记录。
- **R2.4** 路由命名遵循：`GET /:id`（详情）/`POST /`（创建）/`PUT /:id`（全量更新）/`PATCH /:id`（局部）/`POST /:id/{verb}`（业务动作，如 `convert`/`status-transition`）。

---

### L3 同步层（entities/sync.ts）

**目标**：跨实体关系写入 EntityLink + EntityReference 双向图谱。

| 必做项 | 文件 | 验收 |
|---|---|---|
| 3.1 sync 函数 | `server/src/entities/sync.ts` 新增 `syncXxxEntityReferences(prisma, entity, options)` | 函数被 mutation 路由调用 |
| 3.2 配置数组 | 同文件顶部 `XXX_RELATION_FIELDS = [{ fieldKey, relationIdKey, targetType, linkKind }]` | 每个跨实体字段都有一行 |
| 3.3 ID 生成器 | 复用 `linkIdFor()` / `referenceIdFor()`（已在 sync.ts 内） | 同一关系幂等 upsert |
| 3.4 双写 | 每条关系**同时**写一条 EntityReference（含 snapshot.label）和一条 EntityLink | DB 中 link/reference 数量 1:1 |
| 3.5 回填脚本 | `server/scripts/backfill-{module}-links.ts`（迁移历史数据时） | 回填后存量数据全量对齐 |

**硬规则**：

- **R3.1** **`linkKind` 命名表是封闭集合**，不允许业务方自创。当前的规范化 kind：

  | kind | 语义 | 例子 |
  |---|---|---|
  | `orderedBy` | 由 X 下单 | order → relation.organization |
  | `suppliedBy` | 由 X 供货 | order → relation.organization |
  | `shipsTo` | 发货给 X | order → relation.organization |
  | `billTo` | 账单到 X | order → relation.organization |
  | `handledBy` / `merchandisedBy` / `supervisedBy` | 由 X 跟单 | order → relation.person |
  | `developFor` | 为 X 客户开发 | development → relation.organization |
  | `developBy` | 由 X 供应商开发 | development → relation.organization |
  | `aboutProduct` | 关于产品 X | development → product |
  | `aboutMaterial` | 关于面料/SKU（fabric line） | orderLine → product |
  | `aboutGarment` | 关于成衣（garment line） | orderLine → product |
  | `belongsTo` | 隶属于（人 → 组织） | relation.person → relation.organization |
  | `aboutOrder` | 关于某个订单整体（区别于 aboutProduct 的单 SKU 语义） | invoice → order / paymentVoucher → order |
  | `settlesInvoice` | 凭证核销发票（资金动作 → 业务凭证） | paymentVoucher → invoice |

  新增 kind 必须先在本表登记，再实现。

  > **2026-06-15 增补**：`aboutOrder` / `settlesInvoice` 为 finance 模块新增。
  > - `aboutOrder`：发票或收付款凭证关联的是订单**整体**（PO 号、合同号），不是订单中某一行的 SKU。不要复用 `aboutProduct`（后者是 development → product 的 SKU 语义）。
  > - `settlesInvoice`：资金动作"销账"业务凭证。语义比 `belongsTo` 更精确——"销账"暗示有金额、可能 1:N、有 appliedAmount 概念，不是简单的"属于"。

- **R3.2** **不要按 type 字段大小写过滤**（schema 里 `type='Contact'` 大写，代码常误写小写）。
  应基于结构特征判定，例如 `isOrganization === false && parentId != null`。

- **R3.3** **绝不允许 demo seed 直接 createMany EntityLink/Reference**——一定通过 sync.ts。
  这是 2026-06-15 踩坑后立的铁律。

- **R3.4** sync 函数签名必须接受 `options.source: string`，方便审计追踪是 `seed`/`route:create`/`backfill-2026-06-15` 哪一路写入的。

---

### L4 审批层（Approval）

**目标**：写类工具触发 ApprovalRequest，前端走人工决策。

| 必做项 | 位置 | 验收 |
|---|---|---|
| 4.1 工具 risk 标注 | `defaults.ts` 的 `DEFAULT_AGENT_TOOLS[]` 中给写类工具标 `risk: 'high'` | manifest/defaults 一致 |
| 4.2 manifest safety | `manifest.ts` 中给写类工具加 `safety: { approval: 'risk_based', sideEffects: true, editableFields: [...] }` | runtime 能识别 |
| 4.3 editableFields | 列出审批方在"修改参数"时**允许**改的字段名 | 未列字段被 toolRuntime 拒绝 |
| 4.4 requesterId 真实 | 调用 `runAgentToolCalls` 的上层（API/E2E）必须传**真实存在**的 `UserAccount.id` | 落库不静默失败 |
| 4.5 审批落库验证 | E2E 测试用例覆盖 `status === 'approval_required'` 分支 | 数据库 `ApprovalRequest` 多一行 |

**硬规则**：

- **R4.1** **写类工具一定走 `risk_based`，不要用 `always`**（`always` 是给将来"哪怕 low 也强审批"留的位）。
- **R4.2** ApprovalRequest schema 没有原生 `sessionId`/`toolId` 字段。
  约定：`actionType = 'tool:{toolId}'`，`payload.sessionId` / `payload.toolId` / `payload.input` 塞 JSON。
  查询时按 `actionType` 前缀 + `requesterId` 过滤。
- **R4.3** **executeAgentTool（简化版）会直接拒绝任何走审批的工具**（S2 阶段未实现 approval 闭环）。
  E2E 测 mutation 必须用 `runAgentToolCalls`（完整版）才能拿到 `approvalPending`。
- **R4.4** approval 失败的两种情况要区分清楚：
  - `requesterId` 找不到对应 UserAccount → 静默 `null`，应提前 upsert 防御
  - manifest 不要求审批但 risk 是 high → runtime 仍会拦截（`risk_based` 兜底）

---

### L5 Agent 层（MCP 4 处同步）

**目标**：每个 MCP 工具的 4 个登记点位**全部**写齐。

> 这是 2026-06-15 P0 问题的直接来源——少一处就 100% 失败。

| 点位 | 文件 | 角色 |
|---|---|---|
| **5.1 manifest** | `server/src/agent/mcp/manifest.ts` 的 `MANIFEST_SEEDS[]` | LLM 看到的工具说明（description / inputHint / example） |
| **5.2 defaults（RBAC）** | `server/src/agent/defaults.ts` 的 `DEFAULT_AGENT_TOOLS[]` | RBAC 注册：哪些 role 能调；不写就 `TOOL_NOT_REGISTERED` |
| **5.3 toolRuntime（dispatch + impl）** | `server/src/agent/toolRuntime.ts` | 真正的执行函数 + dispatch case |
| **5.4 e2e 用例** | `server/scripts/e2e-agent-test.ts` | 端到端跑过一次，证明四处一致 |

**新增工具的 PR Checklist**：

```
[ ] manifest.ts 增加 MANIFEST_SEEDS 一项（id/name/domain/description/inputHint/example/safety）
[ ] defaults.ts 增加 DEFAULT_AGENT_TOOLS 一项（id/name/scope/risk/allowedRoles）
[ ] toolRuntime.ts 实现 executor 函数 + dispatch case
[ ] toolRuntime.ts 入参 schema 与 manifest.inputHint 一致（同 shape，不要 fromX vs X 双轨）
[ ] e2e-agent-test.ts 新增至少 1 个用例
[ ] 跑 npx tsx server/scripts/e2e-agent-test.ts，确认 status === 'success' 或 'approval_required'
[ ] 如果是 mutation：safety.approval = 'risk_based' + risk = 'high' + editableFields 列出
```

**硬规则**：

- **R5.1** **入参 shape 必须在 manifest / toolRuntime / planner 三处一致**。
  `links.query` 之前坑过：planner 给 `{type, id}`，executor 期望 `{fromType, fromId}`。
  解法：executor 兼容多种 shape（`{type,id}` / `{fromType,fromId}` / `{toType,toId}`），但 manifest 必须把所有合法 shape 都写在 description 里。
- **R5.2** 工具 ID 命名：`{domain}.{verb}`，verb 用蛇形：`query` / `get` / `list_by_status` / `update_status` / `expand_neighbors`。
  禁止：camelCase verb、复数动词、不在 manifest domain 列表里的新 domain。
- **R5.3** 当前合法 domain：`products` / `orders` / `relations` / `entities` / `development` / `knowledge`。
  注意：工具 ID 的前缀**不**等于 domain。例如 `links.query` 归属 `entities` domain（图谱属于实体层），
  `garment.update_size_breakdown` 归属 `orders` domain（成衣是订单子类）。
  新增 domain 必须先更新本契约 + planner.ts 触发规则，再加工具。

---

### L6 Planner 触发层

**目标**：自然语言→工具的路由规则。

| 必做项 | 文件 | 验收 |
|---|---|---|
| 6.1 域关键词 | `server/src/agent/mcp/planner.ts` 加正则触发块 | 自然语言能命中 |
| 6.2 子动词关键词 | 同上，区分 query / update / convert | E2E 用例选对工具 |
| 6.3 task frame 域（可选） | `server/src/agent/taskFrame.ts` 的 `AgentTaskDomain` 加新域 | `hasTaskDomain(frame, 'finance')` 工作 |
| 6.4 反例屏蔽 | 已有 exact-match 屏蔽（exactProductArchiveQuery / exactOrderTask） | 不会跨域抢调 |

**硬规则**：

- **R6.1** **新增 domain 必须先加触发规则**，否则 planner 会把请求路由到无关工具（如 `entities.search`）。
- **R6.2** 触发规则的正则必须是中英对照（`/(开发单|development|sample)/i`），适应中英混合的实际查询。
- **R6.3** 同一查询可能命中多个 domain（"客户 A 的订单和开发单"），planner 用 `pushStep` + `seen` 去重，不用 if/else 互斥。
- **R6.4** **`AgentTaskDomain` 类型不是必加**——目前只有 `relations/products/orders/knowledge/entities` 5 个。
  `development` 是纯正则触发的反例，证明对**简单的领域可以不进 taskFrame**。
  只有需要做"intent × domain 矩阵推理"的复杂域才有必要扩 `AgentTaskDomain`。

---

### L7 测试层（E2E）

**目标**：端到端证明"代码 OK"也是"产品 OK"。

| 必做项 | 文件 | 验收 |
|---|---|---|
| 7.1 Executor 用例 | `server/scripts/e2e-agent-test.ts` 增加 `runOne(prisma, caseId, call)` | 显式工具调用通过 |
| 7.2 Planner 用例 | 同文件 | 自然语言→正确工具 |
| 7.3 Mutation 用例 | 至少 1 个 mutation 走 approval | 落库一行 ApprovalRequest |
| 7.4 数据 fixture | upsert 真实 UserAccount + 关键 demo 数据 | 不依赖外部状态 |

**硬规则**：

- **R7.1** **`tsc --noEmit` 和 `vite build` 不能证明 Agent 通**。
  代码层面 OK ≠ 契约一致性 OK ≠ RBAC 注册 OK ≠ planner 触发 OK。
  E2E 是唯一能同时检测这四层的方式。
- **R7.2** E2E 脚本可独立运行：`npx tsx server/scripts/e2e-agent-test.ts`。
  不依赖 server 已经启动，直接 `new PrismaClient()`。
- **R7.3** 写类工具的 E2E 用例 success 标准是 `status === 'approval_required'`，**不是** `success`——这才说明 approval 链工作。
- **R7.4** **每次新增工具都要补 E2E 用例**，否则下次回归发现不了 4 处脱节。

---

### L8 前端注册 + UI

**目标**：前端能看到模块、能跨模块跳转。

| 必做项 | 文件 | 验收 |
|---|---|---|
| 8.1 前端类型镜像 | `types.ts` 添加 entity 类型 | 与后端 schema 字段一致 |
| 8.2 API service | `services/{module}Service.ts` | 调用真实 REST 端点 |
| 8.3 主组件 | `components/{Module}Manager.tsx` | 双栏列表+详情布局（项目惯例） |
| 8.4 关联面板 | 复用 `<RelatedEntitiesPanel type={...} id={...} />`（type-agnostic 通用组件） | 详情面板能看到 EntityLink 关联 |
| 8.5 注册到 `moduleRegistry` | `components/moduleRegistry.ts`（参见 `MODULE_REGISTRY_PLAN.md`） | Sidebar 自动出现 |
| 8.6 权限策略 | `lib/modulePermissions.ts` 加一行 | 非授权用户看不到 |

**硬规则**：

- **R8.1** **不要在新页面里硬编码导航/图标/标签**——通过 `moduleRegistry` 派生。
  Phase 2/3 已经把 Sidebar/CompiledSidebar/authService 收口到这里。
- **R8.2** **跨模块跳转必须通过 `View` 枚举 + `setSelectedXxxId` 传参**，不要靠 URL 字符串拼接。
- **R8.3** 详情面板**必须**接入 `<RelatedEntitiesPanel>`，让用户看到这条记录在图谱里的位置。
  这是 EntityLink 价值兑现的最后一公里。
- **R8.4** 列表组件加载状态、错误状态、空状态三态必须显式处理（项目惯例）。

---

## 3. 新增模块的端到端 Checklist

把上面 8 层折叠成一份 PR 模板。复制到 PR description 里逐条勾选。

```markdown
### 数据层
- [ ] L1.1 Prisma 模型 + generate
- [ ] L1.2 迁移或 DDL 已应用到本地 panda_hub_local
- [ ] L1.3 seed-demo-data-v2.ts 增加 demo 数据
- [ ] L1.4 types.ts 镜像类型

### API 层
- [ ] L2.1 server/src/{module}/route.ts + 注册到 index.ts
- [ ] L2.2 输入校验（白名单 + 错误码）
- [ ] L2.3 状态变更类操作写审计表
- [ ] L2.4 单段路径前置于 /:id（防路由顺序坑）
- [ ] L2.5 mutation 末尾调 sync.ts（try/catch 不阻塞）

### 同步层
- [ ] L3.1 entities/sync.ts 新增 syncXxxEntityReferences
- [ ] L3.2 配置数组列出所有跨实体字段
- [ ] L3.3 复用 linkIdFor / referenceIdFor（幂等）
- [ ] L3.4 写入路径同时维护 EntityLink + EntityReference
- [ ] L3.5 历史数据有回填脚本（如适用）
- [ ] R3.1 linkKind 在登记表里（不自创）

### 审批层
- [ ] L4.1 defaults.ts 标 risk=high
- [ ] L4.2 manifest safety: risk_based + sideEffects + editableFields
- [ ] L4.4 调用方传真实 UserAccount.id
- [ ] L4.5 E2E 覆盖 approval_required 分支

### Agent 4 处同步（最容易漏！）
- [ ] L5.1 manifest.ts MANIFEST_SEEDS
- [ ] L5.2 defaults.ts DEFAULT_AGENT_TOOLS（RBAC 注册）
- [ ] L5.3 toolRuntime.ts executor + dispatch
- [ ] L5.4 e2e-agent-test.ts 用例
- [ ] R5.1 manifest / toolRuntime / planner 入参 shape 一致
- [ ] R5.2 工具 ID 命名 = {domain}.{verb_snake}

### Planner
- [ ] L6.1 planner.ts 加域关键词触发块
- [ ] L6.2 中英对照正则
- [ ] L6.3 taskFrame.ts 加 TASK_DOMAINS（如新域）

### 测试
- [ ] L7.1 至少 1 个 executor 用例
- [ ] L7.2 至少 1 个 planner 用例
- [ ] L7.3 mutation 走 approval（如有写工具）
- [ ] R7.1 不只看 tsc/build，必须跑 E2E

### 前端
- [ ] L8.1-3 types + service + Manager 组件
- [ ] L8.4 详情面板接入 <RelatedEntitiesPanel>
- [ ] L8.5 注册到 moduleRegistry
- [ ] L8.6 modulePermissions 加权限策略
```

---

## 4. 跨实体关系新增 Checklist（轻量版）

只新增一对实体之间的关系（不开新模块），用这个迷你 checklist：

```markdown
- [ ] entities/sync.ts 配置数组加一行
- [ ] linkKind 在 §L3 R3.1 登记表里（不在则先扩表）
- [ ] 写入路径（POST/PUT 路由）调用 sync 函数
- [ ] 回填脚本处理存量数据（如有）
- [ ] planner.ts 加触发规则（如新关系暴露给 LLM 查询）
- [ ] E2E links.query 用例验证双向可查
```

---

## 5. 新增 MCP 工具 Checklist（最常用）

加一个新工具（不开新模块、不开新关系），用这个最迷你的 checklist：

```markdown
- [ ] manifest.ts MANIFEST_SEEDS 一项
- [ ] defaults.ts DEFAULT_AGENT_TOOLS 一项（**最容易漏！**）
- [ ] toolRuntime.ts executor + dispatch
- [ ] e2e-agent-test.ts 至少 1 个用例
- [ ] 入参 shape 三处一致（manifest description / toolRuntime parser / planner pushStep）
- [ ] 写工具：safety + risk + editableFields
```

把这五行写进项目根的 `.workbuddy/memory/MEMORY.md`，每次开 PR 自查。

---

## 6. 反模式（绝对不允许）

下面这些做法在 2026-06-15 以前都犯过，立此存照：

| 反模式 | 出现位置 | 危害 | 正解 |
|---|---|---|---|
| seed 直接写 EntityLink/Reference | `seed-demo-data.ts`（旧） | linkKind 不规范，与 sync 双轨 | 通过路由层或 `syncXxx()` 写 |
| 加工具不注册 defaults | 上一轮 11 个新工具 | TOOL_NOT_REGISTERED | 4 处同步 PR checklist |
| executor 入参 shape 与 manifest 不一致 | `links.query` | 调用静默失败或 schema 报错 | manifest 写全，executor 兼容 |
| 按 `type` 字段大小写过滤 | sync.ts 的 contact 同步 | 永远不匹配 | 用结构特征判定（`isOrganization === false`） |
| executeAgentTool 测 mutation | 早期 e2e 草稿 | 直接拒绝，看不到 approval 链 | 用 `runAgentToolCalls` |
| ApprovalRequest 用 sessionId 字段 | schema 没这字段 | tsc 报错 | actionType + payload JSON |
| 路由 `/:id` 在前，单段字面量在后 | orders 早期 | `/kanban/summary` 被吃掉 | 字面量前置 |
| tsc/build 通过就当完成 | 上一轮上线 | 4 个真问题没暴露 | 必须跑 E2E |
| 新页面硬编码 nav/icon/label | 各页面早期 | 改一处忘改另一处（label drift） | moduleRegistry 派生 |
| **金额字段使用 Float（IEEE 754 浮点）** | 全库历史金额字段 | `0.1+0.2!==0.3`，核销后账面对不齐 | **禁止使用 Float。所有金额及数量字段已于 2026-06-15 完成全量 Decimal 迁移，新模型开发必须采用 `Decimal @db.Decimal(18,4)`**。 |

---

## 7. 当前 4 个模块的契约符合度（基线）

> 以本契约为标尺反向 audit 现有模块。**这是优先级 2 后续要补的债**。

| 模块 | L1 数据 | L2 API | L3 同步 | L4 审批 | L5 Agent | L6 Planner | L7 E2E | L8 前端 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 关系智库（relations） | ✅ | ✅ | ✅ | – | ✅ | ✅ | ✅ | ✅ |
| 数字档案（products） | ✅ | ✅ | ✅ | – | ✅ | ✅ | ✅ | ✅ |
| 生产管理（orders） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 开发管理（development） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 关系图谱（entities/links） | ✅ | ✅ | n/a | – | ✅ | ✅ | ✅ | ✅（嵌入式 RelatedEntitiesPanel） |

**待补**：

- **garment** 子工具（`garment.update_size_breakdown` / `garment.update_production_steps`）的 E2E 用例尚未覆盖。

---

## 8. 与其他文档的关系

| 文档 | 关注层 | 与本契约的关系 |
|---|---|---|
| `docs/ARCHITECTURE.md` | 整体架构（三级记忆/Cognitive Router/Skill Registry） | 是本契约的上位框架；本契约只覆盖业务模块层 |
| `docs/MODULE_REGISTRY_PLAN.md` | 前端模块注册表（View/Compiler/Nav/Permission 单一来源） | 是本契约 **L8 前端注册** 的详细规范 |
| `docs/AGENT_RUNTIME_ARCHITECTURE.md` | Agent 主循环、planner、approval 机制 | 是本契约 **L4/L5/L6** 的底层实现说明 |
| `docs/Bambook-Agent-OS-使用说明书.md` | Agent OS 用户视角 | 不约束本契约，但功能落地后要更新 |
| `.workbuddy/memory/2026-06-15.md` | 当日工作日志 | 本契约的踩坑素材源头 |

---

## 9. 维护责任

- **本契约文件改动**必须经过 PR review，因为它是其他工程动作的"宪法"。
- **新踩坑必须沉淀**：发现新的"加 X 时漏了 Y"的 case，PR 中同步更新 `§6 反模式`。
- **scaffold-module.ts 生成器**（待开发）必须以本契约为输入，产出的脚手架文件应**自带 §3 checklist 注释**。

---

## 10. 待办（生成器设计输入）

下一步要写 `server/scripts/scaffold-module.ts`，它的输入应该是一份 module spec YAML：

```yaml
# 示例：开新板块"财务"
moduleId: finance
productLabel: 财务管理
domain: finance
entities:
  - name: Invoice
    idPrefix: INVOICE
    fields:
      - { name: amount, type: Decimal }
      - { name: currency, type: String }
      - { name: orderRelationId, type: String, ref: Order }
    relations:
      - { fieldKey: customer, relationIdKey: customerRelationId, targetType: relation.organization, linkKind: orderedBy }
mcpTools:
  - { id: finance.query, verb: query, risk: low }
  - { id: finance.create_invoice, verb: create_invoice, risk: high, editableFields: [amount, currency] }
plannerTriggers:
  - /(发票|invoice|账单|应收|应付)/i
e2eCases:
  - { id: finance-query-1, query: "本月所有未付款发票", expect: finance.query }
permissions:
  required: 'finance:read'
```

生成器读完这份 spec 后，**至少**要产出：

1. `server/prisma/schema.prisma` 追加片段（仅打印到 stdout，不直接改文件——避免破坏现有 schema）
2. `server/src/finance/route.ts` 骨架文件
3. `server/src/entities/sync.ts` 中要插入的 `syncInvoiceEntityReferences` 函数（打印 + 提示插入位置）
4. `server/src/agent/mcp/manifest.ts` 中要追加的 `MANIFEST_SEEDS` 项（打印）
5. `server/src/agent/defaults.ts` 中要追加的 `DEFAULT_AGENT_TOOLS` 项（打印）
6. `server/src/agent/toolRuntime.ts` 中 executor + dispatch case 模板（打印）
7. `server/src/agent/mcp/planner.ts` 中要追加的 trigger block（打印）
8. `server/scripts/e2e-agent-test.ts` 中要追加的用例（打印）
9. **末尾输出 §3 全量 checklist + 待手动补全的 TODO 列表**（人工/PR 兜底）

设计原则（本契约第 9 条延伸）：

- **生成器只生成"独立新文件"，不直接 patch 已存在文件**——这是反 yeoman/plop 的有意选择。
  原因：sync.ts / manifest.ts / defaults.ts / toolRuntime.ts 都是高频改动文件，生成器若强行 AST 改动，
  日后 merge conflict 会频繁出现。改为**打印片段 + 高亮插入位置**，由开发者复制粘贴。
- **生成完跑一次 `tsc --noEmit`** 自检独立新文件部分。
- **不依赖外部模板引擎**（Handlebars 也不要）—— 用 TS 模板字符串就够，零新依赖。
- **生成的文件头自带 §3 checklist 注释**，方便 PR 时逐条核对。

具体的 generator 设计将在下一份文档 `MODULE_SCAFFOLD_DESIGN.md` 展开（待 Kevin review 本契约后再写）。

---

_本契约文件由 Bamboo 起草，2026-06-15。每次新踩坑请追加到 §6 反模式。_