# Agent 能力分层 L0-L6 (Agent Capability Layering Model)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | Bambook Agent OS 能力成熟度模型——将 Agent 能力从 L0 基础对话到 L6 自主决策划分为 7 个层级，定义每层的核心能力、技术实现、激活条件与升级路径，作为 Agent 能力评估与演进的权威基线 |
| **入口** | 能力层通过 `agentLoop` 配置 + `availableTools` 白名单 + `approvalPolicy` 三值 + `processSpec` 组合激活；当前生产环境稳定运行在 L0-L5，L6 部分能力已落地 |
| **核心角色** | 所有层级共享 RBAC；高层级（L3+）的审批权仅超级管理员（老板，原 owner）、系统管理员（总领导，原 admin）、销售主管（部门管理职责，原 manager） |
| **范式** | 能力模型型文档（分层定义 + 技术映射 + 激活条件 + 评估维度 + 演进路径） |
| **优先级** | P0 |
| **实现状态** | ✅ L0-L4 全量落地 / ✅ L5 checkpoint 续传已落地（PrismaCheckpointManager） / ⚠️ L6 部分落地（复合流程已接入 15+，批量操作/定时任务/自主决策仍在演进）。具体：orchestrator(L0) + 74 工具(L1) + agentLoop 多步循环(L2) + 审批/表单 HITL(L3) + ProcessDraft 幂等 commit(L4) + AgentCheckpoint 断点续传(L5) + 复合流程 processSpec(L6 部分) |
| **关联 PRD 章节** | §6（Agent OS 能力矩阵）、§7（工具编排）、§9（权限与安全） |
| **关联代码** | 循环 [server/src/agent/agentLoop.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/agentLoop.ts) / 编排器 [server/src/agent/orchestrator.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/orchestrator.ts) / 工具注册 [server/src/agent/toolRegistry.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/toolRegistry.ts) / 检查点 [server/src/agent/checkpoint.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/checkpoint.ts) |

---

## §2 分层总览

```
L6  自主决策层     ── 复合流程编排 / 批量操作 / 定时任务 / 跨域事务
L5  断点续传层     ── checkpoint 持久化 / 崩溃恢复 / 长程任务
L4  幂等写操作层   ── ProcessDraft / commit 事务 / 防篡改 hash
L3  human-in-the-loop 层 ── 审批拦截 / 表单交互 / EventBus 挂起恢复
L2  多步规划层     ── agentLoop 循环 / LLM 驱动 plan→tool→observe→reflect
L1  工具增强检索层 ── 只读工具 / 结构化查询 / 实体消歧 / 上下文展开
L0  基础对话层     ── 单轮问答 / 知识检索 / 模型回答
```

| 层级 | 核心能力 | 技术载体 | 自主性 | 安全约束 |
|------|---------|---------|--------|---------|
| L0 | 单轮问答 | `orchestrator` | 无工具 | 知识 ACL |
| L1 | 工具检索 | 48 只读工具 | 只读 | 行级权限 |
| L2 | 多步循环 | `agentLoop` | LLM 自主规划 | 工具白名单 + 预算上限 |
| L3 | 人机协作 | `approvalEventBus` + `formEventBus` | 挂起等待人类 | high-risk 强制审批 |
| L4 | 幂等写入 | `ProcessDraft` + `commitTransaction` | 审批后自主提交 | hash 防篡改 + Serializable |
| L5 | 断点续传 | `AgentCheckpoint` | 崩溃可恢复 | conversationId 绑定 actor |
| L6 | 自主决策 | `processSpec` + `AgentJob` | 跨域编排 | 部分失败策略 + 回滚 |

> **设计原则**：层级是「能力叠加」而非「能力替代」——L2 循环仍可调用 L0 知识检索；L4 写操作仍需 L1 只读工具获取快照；L6 复合流程仍走 L3 审批。高层级包含低层级全部能力。

---

## §3 L0 基础对话层

### 3.1 能力定义

| 维度 | 说明 |
|------|------|
| **核心能力** | 单轮问答：用户提问 → 知识检索 → 模型回答 |
| **自主性** | 无工具调用，纯知识检索 + LLM 生成 |
| **激活条件** | `orchestrator.run()` 路径（非 agentLoop） |
| **安全约束** | 知识 ACL（`policy.canAccessKnowledge`）过滤检索结果 |

### 3.2 技术实现

`orchestrator.ts` 的 `createAgentOrchestrator` 实现 L0：

```
identity.resolveActorContext(request)       // 身份解析
  → knowledge.search(retrievalQuery)         // 知识检索
  → policy.canAccessKnowledge(scopes 过滤)    // ACL 过滤
  → model.complete(message + context)        // LLM 回答
  → buildVisibleThinking(思考过程合成)         // 可视化思考
```

### 3.3 限制

- 无工具调用——无法查业务数据（订单/发票/出运等）
- 单轮——无法多步推理
- 上下文不足时只能说明不确定，不能主动补充查询

### 3.4 适用场景

- 知识库问答（SOP/政策/文档）
- 通用对话（无业务数据需求）
- agentLoop 降级 fallback（LLM 故障时）

---

## §4 L1 工具增强检索层

### 4.1 能力定义

| 维度 | 说明 |
|------|------|
| **核心能力** | 调用只读工具检索业务数据：query/get/search/expand |
| **自主性** | LLM 决定调什么工具，但每步独立（无循环） |
| **激活条件** | `availableTools` 含只读工具 + LLM 输出 `action='call_tool'` |
| **安全约束** | `policy.canUseTool`（scope + risk）+ 行级权限 `buildScopeWhere` |

### 4.2 工具体系

48 个只读工具覆盖 12 域（详见[只读业务工具集](./只读业务工具集.md)）：
- 产品域：`products.search`/`query`/`get`/`expand`/`describe_schema`
- 订单域：`orders.search`/`query`/`get`/`expand`/`list_by_status`/`get_timeline`/`kanban`
- 关系域：`relations.search`/`query`/`get`/`expand` + `entities.search`/`hydrate` + `links.query`/`expand_neighbors`
- 财务域：`finance.list_invoices`/`get_invoice`/`list_vouchers`/`get_voucher`/`query_outstanding`/`get_aging`/`get_statement`
- 出运域：`shipping.list_shipments`/`get_shipment`/`scan_delays`
- 报关域：`customs.query_lc`/`get_lc`
- 报价域：`quotations.query`/`get`
- 邮件/开发/生产/知识/模板域只读工具

### 4.3 实体消歧能力

`entities.search` + `entities.hydrate` 实现 Agent 实体消歧：
1. 用户提到"ABC 公司" → `entities.search` 返回候选（可能同时命中 organization/person/product）
2. LLM 判断候选唯一性 → `entities.hydrate` 获取详情
3. 唯一命中 → 继续 `get`/`expand`；ambiguous → 向用户澄清

### 4.4 上下文展开

`expand` 系列工具（`orders.expand`/`relations.expand`/`products.expand`）支持多维展开，让 Agent 一次性获取实体全链路上下文：
- `orders.expand` → summary/lines/parties/dates/invoices/samples/production/missingFields/currencies 九维
- `products.expand` → profile/pricing/certifications/composition/images/customerCodes/relations 七维

---

## §5 L2 多步规划层

### 5.1 能力定义

| 维度 | 说明 |
|------|------|
| **核心能力** | LLM 驱动的多步循环：plan → tool call → observe → reflect → ... → final_answer |
| **自主性** | LLM 自主决定每步调什么工具、何时收尾 |
| **激活条件** | `createAgentLoop(deps)` + `availableTools` 白名单 |
| **安全约束** | 工具白名单 + 预算上限 + 去重 + per-tool 超时 |

### 5.2 循环架构

`agentLoop.ts` 的 `createAgentLoop` 实现 L2：

```
for (step = 1; step <= maxSteps; step++) {
  ① 预算检查（totalBudgetMs / signal.aborted）
  ② planNextStep(LLM 决策) → { thought, action }
     ├─ action='final_answer' → 结束循环
     ├─ action='request_form' → L3 表单交互
     └─ action='call_tool' → ③
  ③ 执行工具（去重 + 超时）
  ④ observe 结果灌入 scratchpad
  ⑤ checkpoint 保存（L5）
}
⑥ 强制收尾（LLM 未主动 final 时）
```

### 5.3 预算治理（AGENT_LOOP_LIMITS）

| 参数 | 值 | 说明 |
|------|-----|------|
| `maxSteps` | 8 | 单次循环最多步数 |
| `maxToolsPerStep` | 3 | 单步内工具调用上限 |
| `perToolTimeoutMs` | 30,000 | 单工具超时 |
| `totalBudgetMs` | 90,000 | 总预算 |
| `llmRepairRetries` | 1 | LLM JSON 解析失败重试 |
| `historyWindowSize` | 8 | 历史窗口 |
| `observationCharLimit` | 6,000 | 单工具输出截断 |
| `scratchpadCharBudget` | 24,000 | scratchpad 总字符预算 |

### 5.4 去重机制

同一 `toolId` + 同一 `input`（稳定 JSON 序列化）不重复执行：
```
signature = `${call.toolId}:${stableStringify(call.input)}`
if (seenSignatures.has(signature)) → skip + emit 'deduped'
```

### 5.5 LLM 决策协议

`llmPlanner.ts` 构造 system prompt，LLM 输出三态 JSON：

| action | 必填字段 | 说明 |
|--------|---------|------|
| `call_tool` | `thought` + `toolCalls[]` | 调用工具（1-3 个） |
| `final_answer` | `thought` + `finalAnswer` | 给最终回答 |
| `request_form` | `thought` + `formTitle` + `fields[]` | 发起表单（L3） |

> **防侵蚀红线**：system prompt 只写「能力描述」（你有这些工具/action），禁止写「行为规则触发条件」（如"当用户说X时必须用Y"）——后者是规则化 planner 思维，会退化 LLM 自主决策能力。

---

## §6 L3 human-in-the-loop 层

### 6.1 能力定义

| 维度 | 说明 |
|------|------|
| **核心能力** | Agent 执行中挂起等待人类输入：审批确认 + 表单收集 |
| **自主性** | 挂起期间不推进；人类输入后继续 |
| **激活条件** | high-risk 工具（approvalPolicy=always）或 LLM 主动 request_form |
| **安全约束** | 审批权 RBAC + 15 分钟超时 + EventBus 进程内通信 |

### 6.2 双通道

| 通道 | 触发 | EventBus | 恢复 |
|------|------|----------|------|
| 审批 | high-risk 工具执行 | `approvalEventBus` | `POST /approvals/:id/resolve` → emit |
| 表单 | LLM `request_form` | `formEventBus` | `POST /forms/:id/submit` → emit |

### 6.3 挂起-恢复机制

agentLoop 在循环内用 Promise 挂起，EventBus 唤醒：
- 审批通过 → 重跑工具（`skipApprovalCheck:true` + `approvalId`）
- 审批拒绝 → 记录错误，继续下一工具
- 表单提交 → 灌入 observation，继续循环
- 超时 → 灌入"未提交"observation，强制收尾

详见 [审批与 human-in-the-loop](./审批与human-in-the-loop.md)。

---

## §7 L4 幂等写操作层

### 7.1 能力定义

| 维度 | 说明 |
|------|------|
| **核心能力** | 审批通过后原子提交写操作：ProcessDraft → commit 事务 |
| **自主性** | 审批后自主提交，无需人类再次确认 |
| **激活条件** | `approvalPolicy=always` + `processSpec` 注册 + 审批通过 |
| **安全约束** | hash 防篡改 + 语义校验 + Serializable 隔离 + AgentCommitReceipt 幂等 |

### 7.2 三阶段闭环

```
draftPhase: 生成 ProcessDraft（六字段）→ 落库 ApprovalRequest.payload
  ↓
approvalPhase: 人类审批（L3）
  ↓
commitTransaction: 从 payload 恢复 draft → hash 校验 → 语义校验 → $transaction 原子提交
```

### 7.3 防篡改链

| 防线 | 机制 |
|------|------|
| ① 语义校验 | `validateProcessDraftSemantics`（业务规则：status 必须 Pending→Confirmed + invoice 必须 Issued） |
| ② hash 校验 | `verifyProcessDraftHash`（重算 djb2 hash 比对 idempotencyKey） |
| ③ 状态校验 | `order.status !== previousStatus` → STATUS_DRIFT |
| ④ 幂等表 | `AgentCommitReceipt.idempotencyKey @unique` → P2002 重放返回原结果 |
| ⑤ 隔离级别 | `Serializable` → SSI 中止并发方（P2034 可重试） |

### 7.4 已接入的 commit 流程

26 个写操作工具中，15+ 已接入完整 commit 闭环（详见[写操作工具集](./写操作工具集.md)）：
- `commitOrderConfirm` / `commitPaymentReceiveAndReconcile` / `commitOrderShip`
- `commitEmailReplySend` / `commitEmailSendOutbox` / `commitEmailSync`
- `commitRelationOnboard` / `commitRelationUpdate` / `commitRelationDelete`
- `commitInvoiceIssue` / `commitInvoiceCreate` / `commitInvoiceUpdate` / `commitInvoiceCancel` / `commitInvoiceDelete`
- `commitPaymentVoucherCreate` / `commitPaymentVoucherUpdate` / `commitPaymentVoucherDelete`
- `commitProductAssetCreate` / `commitProductAssetUpdate` / `commitProductAssetDelete`
- `commitDevCreate` / `commitDevConvert` / `commitStatementSend`
- `commitOrderStatusTransition` / `commitOrderDelete` / `commitOrderLineUpdate`
- `commitKnowledgeIngest`

---

## §8 L5 断点续传层

### 8.1 能力定义

| 维度 | 说明 |
|------|------|
| **核心能力** | 循环状态持久化 + 崩溃后恢复 |
| **自主性** | 进程崩溃后可从最后 checkpoint 恢复 |
| **激活条件** | `checkpointManager` 注入 agentLoop + `conversationId` 绑定 |
| **安全约束** | `conversationId = sha256(sessionId + actor scope)`，防跨 actor 恢复 |

### 8.2 checkpoint 生命周期

```
agentLoop.run() 开始
  ↓
checkpointManager.load(conversationId)  // 尝试恢复
  ├─ 有 checkpoint → resumeStep = ckpt.step + 1 → emit 'checkpoint_resumed'
  └─ 无 checkpoint → resumeStep = 1
  ↓
for (step = resumeStep; ...) {
  执行步
  ↓
  checkpointManager.save({               // 每步后保存
    conversationId, step, message,
    scratchpad: { thoughts, toolCalls },
    iterations
  })
}
  ↓
正常完成 → checkpointManager.clear(conversationId)  // 清理
```

### 8.3 conversationId 安全绑定

`createCheckpointConversationId` 把 sessionId 绑定到 actor + department scope：

```typescript
const scope = { version:1, userId, departmentIds:[...].sort(), sessionId };
return `ckpt_v1_${sha256(JSON.stringify(scope))}`;
```

> **安全决策**：浏览器 session token 是路由提示，不是授权边界。绑定到 actor 后，相同 client sessionId 无法恢复另一个 actor 的 scratchpad。

### 8.4 AgentCheckpoint 模型

```prisma
model AgentCheckpoint {
  id             String   @id
  conversationId String   @unique
  step           Int
  message        String
  scratchpad     Json     // { thoughts: [], toolCalls: [] }
  iterations     Json     // IterationTrace[]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}
```

### 8.5 当前限制

- 审批 EventBus 的 Promise 无法跨进程恢复（进程崩溃后审批通过无人消费）
- 生产环境需配合 AgentJob 队列实现跨进程审批恢复

---

## §9 L6 自主决策层

### 9.1 能力定义

| 维度 | 说明 |
|------|------|
| **核心能力** | 跨域复合流程编排 + 批量操作 + 定时任务 + 自主决策 |
| **自主性** | Agent 自主编排多工具组合，处理部分失败 |
| **激活条件** | `processSpec.composedOf` 多工具组合 + `AgentJob` 队列 |
| **安全约束** | 部分失败策略（draftFail/transactionFail/postCommitFail）+ 回滚策略 |

### 9.2 复合流程编排

`processSpec.composedOf` 定义复合流程的子操作组合：

| 工具 | composedOf | 说明 |
|------|-----------|------|
| `order.confirm` | `['orders.update_status', 'finance.create_invoice']` | 订单确认 + 开发票 |
| `invoice.issue` | `['finance.create_invoice', 'email.reply_and_send']` | 开发票 + 发邮件 |
| `payment.receive_and_reconcile` | `['finance.apply_voucher_to_invoice']` | 收款 + N 笔核销 |
| `order.ship` | `['shipping.create_shipment']` | 发货 + 订单状态联动 |
| `relation.onboard` | `['relations.create']` | 建档 + EntityLink sync |

### 9.3 部分失败策略

```typescript
partialFailurePolicy: {
  draftFail: 'abort_no_approval',   // draft 失败 → 不创建审批
  transactionFail: 'rollback',       // 事务失败 → 全回滚
  postCommitFail: 'queue_retry',     // 后置钩子失败 → 入队重试
}
```

### 9.4 AgentJob 队列

```prisma
model AgentJob {
  id          String    @id
  jobType     String
  status      String    @default("queued")  // queued→running→completed/failed
  priority    Int       @default(5)
  payload     Json
  result      Json?
  error       String?
  scheduledAt DateTime  @default(now())
  startedAt   DateTime?
  completedAt DateTime?
}
```

`jobs.ts` 的 `createJobService` 提供 `enqueue` + `stats`，支持：
- 定时任务（`scheduledAt`）
- 优先级队列（`priority`）
- 重试（postCommitHooks `queue_retry`）

### 9.5 loopController 证据跟踪

`loopController.ts` 的 `assessAgentLoopStep` 实现证据驱动的循环控制：

| 决策 | 条件 | 说明 |
|------|------|------|
| `continue` | 有可执行的下一步工具 | 候选唯一命中 → 自动展开 |
| `complete` | 证据充分 | 无缺失证据 |
| `blocked` | 候选 ambiguous/not_found + 有缺失证据 | 需用户澄清 |

`CONTINUATION_RULES` 定义自动 follow-up 规则：
- `relations.query` → 唯一命中 → 自动 `relations.get` + `relations.expand`
- `products.get` → 唯一命中 → 自动 `products.expand`
- `orders.get` → 唯一命中 → 自动 `orders.expand`
- `dictionary.query` → 唯一命中 → 自动 `records.query`

### 9.6 L6 未完整落地能力

| 能力 | 状态 | 说明 |
|------|------|------|
| 复合流程编排 | ✅ 已落地 | 15+ processSpec 已接入 |
| 部分失败策略 | ✅ 已落地 | partialFailurePolicy 三态 |
| 批量操作 | ⚠️ 部分 | `orders.batch_status` 有 manifest，无 commit 闭环 |
| 定时任务 | ⚠️ 框架就绪 | AgentJob 模型已有，调度器未接入 |
| 自主决策 | ⚠️ 演进中 | loopController 证据跟踪已实现，自主决策阈值待定义 |
| 跨进程审批恢复 | ❌ 未落地 | 需 AgentJob 消费 approvalEventBus |

---

## §10 层级激活矩阵

| 层级 | 激活方式 | 当前状态 | 典型场景 |
|------|---------|---------|---------|
| L0 | `orchestrator.run()` | ✅ 生产 | 知识问答 / agentLoop 降级 |
| L1 | `availableTools` 含只读工具 | ✅ 生产 | "查一下 ABC 公司的订单" |
| L2 | `createAgentLoop()` | ✅ 生产 | "ABC 公司有多少未付发票" |
| L3 | high-risk 工具 / `request_form` | ✅ 生产 | "帮我确认订单 PO-001" |
| L4 | `processSpec` + 审批通过 | ✅ 生产 | "创建发票并发出" |
| L5 | `checkpointManager` 注入 | ✅ 生产 | 长程任务崩溃恢复 |
| L6 | `composedOf` 多工具 | ⚠️ 部分 | "确认订单并发送通知邮件" |

---

## §11 能力评估维度

Agent 能力评估不以单个成功示例评判，需跨多维度评估：

| 维度 | L0 | L1 | L2 | L3 | L4 | L5 | L6 |
|------|----|----|----|----|----|----|-----|
| 任务理解 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 任务建模 | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 规划 | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 工具选择 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 工具编排 | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 执行循环 | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 观察/状态跟踪 | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 结果评估 | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 差距检测 | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 延续决策 | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 权限控制 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 记忆/知识检索 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 完成标准 | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 可审计性 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 多场景评估 | ⚠️ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |

---

## §12 演进路径

### 12.1 短期（已完成）

- L0→L1：orchestrator → toolRuntime 工具接入
- L1→L2：toolRuntime 关键词规划 → agentLoop LLM 驱动循环
- L2→L3：直接执行 → 审批拦截 + 表单交互
- L3→L4：审批通过直接执行 → ProcessDraft 幂等 commit

### 12.2 中期（进行中）

- L4→L5：单进程循环 → checkpoint 持久化 + 崩溃恢复
- L5→L6：单工具 commit → 复合流程 processSpec 编排

### 12.3 长期（规划中）

- L6 完善：批量操作 commit 闭环 + 定时任务调度器 + 跨进程审批恢复
- 自主决策阈值：定义 Agent 何时可自主跳过审批（基于历史信任度 + 风险评估）
- 多 Agent 协作：多个 agentLoop 实例协作完成跨域大任务

---

## §13 设计系统约束

本层为能力模型文档，无直接 UI 渲染约束。关联 UI 约束见：
- 审批卡 UI → [审批与 human-in-the-loop](./审批与human-in-the-loop.md) §13
- 工具卡 UI → [Assistant 对话交互](./Assistant对话交互.md) §13

---

## §14 待补缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | L6 批量操作 commit 闭环（orders.batch_status） | P1 | §9 |
| 2 | L6 定时任务调度器（AgentJob consumer） | P1 | §9 |
| 3 | L6 跨进程审批恢复（EventBus → AgentJob） | P1 | §9 |
| 4 | L6 自主决策阈值定义（信任度模型） | P2 | §9 |
| 5 | L5 checkpoint 压缩策略（scratchpad 超预算时） | P2 | §8 |
| 6 | L2 循环评估指标（步数/工具数/收尾率） | P2 | §5 |
| 7 | 多 Agent 协作协议 | P3 | §12 |

---

## §15 交叉链接

1. [Assistant 对话交互](./Assistant对话交互.md) — L0-L2 的前端呈现（消息流 + 工具卡 + 思考过程）
2. [只读业务工具集](./只读业务工具集.md) — L1 工具增强检索层的工具规格
3. [写操作工具集](./写操作工具集.md) — L4 幂等写操作层 + L6 复合流程的工具规格
4. [审批与 human-in-the-loop](./审批与human-in-the-loop.md) — L3 human-in-the-loop 层的完整机制
5. [订单状态机](../03-订单与生产/Orders-订单管理/订单状态机.md) — L4/L6 写操作触发的状态流转
6. [订单 360° 全链路](../03-订单与生产/Orders-订单管理/订单360°全链路.md) — L1 expand 工具对应的全链路视图
7. [财务域模型组](../../02-数据模型/财务域模型组.md) — AgentSession/AgentToolRun/AgentCheckpoint/AgentJob 模型
8. [后端循环真源](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/agentLoop.ts) — L2-L5 的核心循环实现

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| L0 编排器 | [server/src/agent/orchestrator.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/orchestrator.ts) |
| L2 循环 | [server/src/agent/agentLoop.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/agentLoop.ts) |
| L2 LLM 决策 | [server/src/agent/llmPlanner.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/llmPlanner.ts) |
| L2 循环控制 | [server/src/agent/loopController.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/loopController.ts) |
| L4 工具注册 | [server/src/agent/toolRegistry.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/toolRegistry.ts) |
| L4 事务引擎 | [server/src/agent/commitTransaction.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/commitTransaction.ts) |
| L5 检查点 | [server/src/agent/checkpoint.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/checkpoint.ts) |
| L6 任务队列 | [server/src/agent/jobs.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/jobs.ts) |
| 循环边界常量 | [server/src/agent/defaults.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/defaults.ts) |
| AgentCheckpoint 模型 | [schema.prisma L2785-L2797](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/prisma/schema.prisma#L2785-L2797) |
