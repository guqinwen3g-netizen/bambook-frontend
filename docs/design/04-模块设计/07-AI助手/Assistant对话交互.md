# Assistant 对话交互 (Assistant Conversation Interaction)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | Bambook Agent OS 的统一对话入口——承载消息流、工具调用展示、审批确认气泡、表单交互（human-in-the-loop）、可视化思考过程与工作区面板，是用户感知 Agent 能力的主界面 |
| **入口** | 侧边栏「Assistant」→ `Assistant.tsx`；支持会话历史（`/agent/sessions`）、全屏模式、工作区面板 |
| **核心角色** | 7 容器角色全量均可对话；high-risk 工具审批权仅超级管理员（老板，原 owner）、系统管理员（总领导，原 admin）、销售主管（部门管理职责，原 manager） |
| **范式** | 模块详设型文档（前端交互契约 + 后端事件流协议 + 状态机联动） |
| **优先级** | P0 |
| **实现状态** | ✅ 已落地（消息流 + 12 类 ResponseBlock + AgentWorkEvent 事件流 + 审批气泡 HITL + 表单交互 + 会话持久化 + TTS/STT + 工作区面板 + checkpoint resume；agentLoop 多步循环已上线，74 工具注册，ProcessDraft 六字段幂等 commit 已闭环）|
| **关联 PRD 章节** | §6（Agent OS）、§7（对话与工具）、§9.3（审批权限） |
| **关联代码** | 前端 [Assistant.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/Assistant.tsx) / 事件呈现 [agentEventPresentation.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/lib/agentEventPresentation.ts) / 后端事件 [server/src/agent/events.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/events.ts) / 循环 [server/src/agent/agentLoop.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/agentLoop.ts) |

---

## §2 三层架构总览

Assistant 对话交互自底向上分为三层，对应「数据真源 → 事件协议 → 前端渲染」：

| 层 | 位置 | 职责 | 真源 |
|----|------|------|------|
| **① 持久化层** | Mac Mini PostgreSQL | 会话/消息/工具运行/审批/检查点全量落库 | `AgentSession` / `AgentMessage` / `AgentToolRun` / `ApprovalRequest` / `AgentCheckpoint` |
| **② 事件流协议层** | 后端 `events.ts` + SSE | Agent 工作事件 → Block 流事件双向派生，驱动前端实时渲染 | `AgentWorkEvent`（18 phase）+ `AgentBlockStreamEvent`（5 事件） |
| **③ 前端渲染层** | `Assistant.tsx` + `AgentMessageCard` | 消息气泡、思考过程、工具卡、审批卡、表单卡、工作区 | `ChatMessage.blocks[]` + `assistantRuntimeStore` |

> **设计决策**：前端不直接调业务 REST API 做工具调用——所有工具执行走后端 agentLoop，前端只消费事件流。这保证了审计链完整、权限链在后端收口、前端不可绕过审批。

---

## §3 消息流模型

### 3.1 ChatMessage 结构

每条消息（用户或模型）在 `types.ts` 中定义为 `ChatMessage`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `role` | `'user' \| 'model'` | 发言方 |
| `text` | `string` | 纯文本回退（markdown 渲染） |
| `blocks` | `AgentResponseBlock[]` | 结构化内容块（12 类，见 §4） |
| `agentEvents` | `AgentWorkEvent[]` | 思考过程事件流（逐步推理轨迹） |
| `sources` | `GroundingSource[]` | 引用来源（知识库/工具结果） |
| `thoughtProcess` | `string` | 合成版「我的理解→做法→依据→结论」文本 |
| `attachments` | `ChatAttachment[]` | 用户附件（图片/PDF/文件） |
| `isTyping` | `boolean` | 流式生成中标记 |

### 3.2 消息生命周期

```
用户输入 → assistantRuntimeStore.set({isLoading:true})
  │ POST /api/ai/chat (SSE 流)
  ▼
后端 prepareChatRun → ensureSession + loadSessionHistory + createMessageIfNotDuplicate
  │ emit('agent_event', ...) × N     ← 思考/工具/审批事件
  │ emit('block_start', ...) × N     ← 结构化块
  │ emit('block_delta', ...) × N     ← 流式增量
  │ emit('block_end', ...) × N
  ▼
前端 reduceAgentBlocks(blocks) → ChatMessage.blocks[] 实时更新
  │
  ▼ 流结束 → saveAssistantMessage（落库 AgentMessage）→ isLoading:false
```

### 3.3 会话持久化策略

- **会话历史**：后端 `loadSessionHistory` 从 `AgentMessage` 取最近 32 条（`AGENT_LOOP_LIMITS.historyWindowSize=8` 轮），前端 `IndexedDB` + `localStorage` 双缓存
- **去重**：`createMessageIfNotDuplicate` 比对最后一条同 role 消息内容，避免重复落库
- **标题**：首条用户消息前 32 字符自动生成；用户可 `PATCH /sessions/:id` 改名
- **软删**：`DELETE /sessions/:id` 写 `deletedAt`，不物理删除

---

## §4 ResponseBlock 12 类块体系

前端消息内容不是纯文本，而是由结构化 Block 组合渲染。`AgentResponseBlock` 联合类型覆盖 12 类：

| Block 类型 | 触发来源 | 渲染形态 | 交互 |
|------------|----------|----------|------|
| `markdown` | LLM final_answer / answer_delta | Markdown 正文（`MarkdownRenderer`） | 复制/展开 |
| `table` | 工具结果含 `items[]`/`rows[]` | 结构化表格（前 8 行 + "共 N 条"） | 列排序 |
| `metric` | 聚合工具结果 | 指标卡 | — |
| `evidence` | `tool_call_end` + complete | 依据卡（工具标签 + 摘要 + 置信度） | 点击锚定工具卡 |
| `next_actions` | LLM 建议后续动作 | 动作按钮列表 | 点击发起下一轮 |
| `diagram` | 架构图/流程图 | 图形渲染 | 缩放 |
| `chart` | 统计数据 | 图表 | — |
| `mermaid` | Mermaid 语法 | Mermaid 图 | — |
| `artifact` | 产物（PDF/HTML/代码） | 工作区产物卡 | 在工作区打开 |
| `tool` | `tool_call_start`/`tool_call_end` | 工具生命周期卡（running/succeeded/failed/blocked） | 展开入参/出参 |
| `approval` | `status=blocked` + `approvalId` | 审批气泡（见 §6） | 批准/拒绝/修改 |
| `form` | `action=request_form` | 表单卡（见 §7） | 填写提交 |

### 4.1 Block 派生机制（events.ts）

后端 `emitAgentWorkEvent` 在发射 `AgentWorkEvent` 的同时，自动派生对应的 Block 流事件：

```
emitAgentWorkEvent(emit, {phase, status, toolId, metadata})
  │
  ├─ phase ∈ {tool_call, tool_call_start, tool_result, tool_call_end}
  │   → emitToolLifecycleBlock (tool block: running→succeeded/failed/blocked)
  │
  ├─ phase ∈ {tool_result, tool_call_end} && status==='complete'
  │   → emitEvidenceBlock (evidence block: 依据卡)
  │   → emitTableBlockFromOutput (table block: 若 output 含 rows)
  │
  ├─ status==='blocked' && (metadata.approvalId || metadata.risk==='high')
  │   → emitApprovalBlock (approval block: 审批气泡)
  │
  └─ phase==='form_request' && metadata.formId
      → emitFormBlock (form block: 表单卡)
```

> **设计决策**：Block 由事件派生而非独立发射——保证「思考过程事件」与「结构化块」始终一致，前端重连/回放时只需重放事件即可重建 Block。

---

## §5 工具调用展示（Tool Lifecycle Block）

### 5.1 工具卡四态

| `lifecycleStatus` | 触发条件 | 视觉 |
|--------------------|----------|------|
| `running` | `tool_call_start` | 转圈 + 工具人话标题（如"正在检索客户档案"） |
| `succeeded` | `tool_call_end` + `ok:true` | 绿色勾 + 结果摘要（如"找到 3 条匹配记录"） |
| `failed` | `tool_call_end` + `ok:false` | 红色叉 + 错误码 + `userAction` 指引 |
| `blocked` | `status=blocked` + approvalId | 琥珀色锁 + "等待审批确认" |

### 5.2 工具人话映射

`events.ts` 内置 `TOOL_LABEL_MAP` / `humanizeToolLabel`，把机械 toolId 翻译成自然语言：

| toolId | 人话标签 |
|--------|---------|
| `relations.query` | 检索客户/供应商档案 |
| `orders.get` | 读取订单详情 |
| `products.search` | 检索产品档案 |
| `finance.list_invoices` | 检索发票 |
| `shipping.list_shipments` | 检索发货记录 |
| `knowledge.search` | 搜索知识库 |

### 5.3 结果摘要人话化

`humanizeOutputSummary` 把 `total/count=0` 等机械输出翻译为：

- `count=0` → "查询完成，没有找到匹配记录"
- `count=1` → "查询完成，找到 1 条匹配记录"
- `found=true` → "找到匹配记录"

### 5.4 可展开详情

工具卡 `expandable=true` 时（`metadata.input` 或 `metadata.output` 非空），用户可展开查看：
- **入参预览**（`inputPreview`，前 8 字段）
- **出参预览**（`outputPreview`，前 8 字段 + count/total）
- **错误详情**（`error.code` + `error.message` + `error.userAction`）
- **耗时**（`durationMs`，从 `startedAt`/`completedAt` 计算）

---

## §6 审批确认气泡（Approval Block / HITL）

### 6.1 触发条件

当 agentLoop 执行 high-risk 工具时，`toolRuntime.executeAgentTool` 返回 `{ approvalRequired: true, approvalId, risk }` 而非直接执行。agentLoop 检测到后：

1. `emitAgentWorkEvent({ phase:'tool_call', status:'blocked', metadata:{ approvalId, risk, input, editableFields } })`
2. `events.ts` 派生 `emitApprovalBlock` → 前端收到 `block_start` (type='approval')
3. agentLoop 挂起等待 `approvalEventBus.on('resolved')`（15 分钟超时）

### 6.2 审批卡字段

| 字段 | 来源 | 说明 |
|------|------|------|
| `approvalId` | `ApprovalRequest.id` | 审批主键，resolve 路由用 |
| `risk` | tool manifest | `medium`/`high`/`critical` |
| `proposedAction` | 事件 title | 人话动作描述 |
| `toolId` | 事件 toolId | 关联工具 |
| `input` | metadata.input | 候选执行入参（用户可改） |
| `editableFields` | `ToolManifestSafety.editableFields` | 可编辑字段白名单 |
| `approvalStatus` | 实时 patch | `pending`→`approved`/`rejected`/`modified` |
| `processDraft` | P0-B ProcessDraft | 写操作的六字段变更预览（subOperations/beforeAfterDiff/impactScope/irreversible/postCommitHooks/idempotencyKey） |

### 6.3 三种审批决议

前端 `resolveAgentApproval` 调用 `POST /agent/approvals/:id/resolve`：

| decision | 前端行为 | 后端行为 |
|----------|----------|----------|
| `approved` | 乐观 patch `approvalStatus=approved` | `approvalEventBus.emit('resolved', id, {decision:'approved'})` → agentLoop 继续执行（`skipApprovalCheck:true`） |
| `rejected` | 乐观 patch `approvalStatus=rejected` | emit → agentLoop 记录 `APPROVAL_REJECTED` 错误，继续下一工具 |
| `modified` | 进入 `approval_parameter_edit` 模式，用户改入参后重新提交 | emit `{decision:'modified', modifiedInput}` → agentLoop 用 `modifiedInput` 重跑 |

> **设计决策**：审批通过后 agentLoop 用原 `approvalId` 重跑工具（`skipApprovalCheck:true` + `approvalId`），`commitTransaction` 从 `ApprovalRequest.payload.processDraft` 恢复已审批的 ProcessDraft——保证「审批什么就提交什么」（what-you-approve-is-what-you-commit）。

---

## §7 表单交互（Form Block / Human Input）

### 7.1 触发条件

agentLoop 中 LLM 输出 `action='request_form'` 时，`llmPlanner` 返回 `{ formTitle, fields, submitLabel }`。agentLoop：

1. `emitAgentWorkEvent({ phase:'form_request', status:'blocked', metadata:{ formId, fields, submitLabel } })`
2. `events.ts` 派生 `emitFormBlock` → 前端收到 `block_start` (type='form')
3. agentLoop 挂起等待 `formEventBus.on('submitted')`（15 分钟超时）

### 7.2 表单字段类型

| `type` | 渲染 | 说明 |
|--------|------|------|
| `text` | 单行输入 | 带 placeholder |
| `textarea` | 多行输入 | 长文本 |
| `select` | 下拉选择 | `options[]` |
| `multiselect` | 多选 | `options[]` |

每字段含 `key`/`label`/`required`/`placeholder`/`helpText`。

### 7.3 提交流程

```
用户填写 → POST /agent/forms/:id/submit { values }
  │
  ▼
formEventBus.emit('submitted', formId, values)
  │
  ▼
agentLoop 把 values 作为 observation 灌入 scratchpad
  └ scratchpad.thoughts.push({ step, content: "[用户通过表单提交了以下信息]\n公司全称: ABC Trading..." })
  └ scratchpad.toolCalls.push({ toolId:'user_form_input', input:values, ok:true })
  │
  ▼
continue 循环 → LLM 基于新 observation 决定下一步
```

> **设计决策**：表单超时不报错——agentLoop 把"用户未提交"作为 observation 灌入，让 LLM 用已有信息收尾，而非死等。

---

## §8 可视化思考过程

### 8.1 AgentWorkEvent 18 Phase

| Phase 类 | Phase | 触发时机 |
|----------|-------|---------|
| **循环骨架** | `iteration_start` / `iteration_end` | 每步开始/结束 |
| **思考流** | `thought` / `thought_delta` / `thought_end` | LLM 本步思考（完整 + 流式增量 + 段结束） |
| **计划** | `plan` | LLM 决定调用的工具列表 |
| **工具生命周期** | `tool_call_start` / `tool_call` / `tool_result` / `tool_call_end` | 工具开始/拦截/结果/结束 |
| **回答流** | `final_answer` / `answer_delta` / `answer_end` | 最终回答（完整 + 流式增量 + 段结束） |
| **交互** | `form_request` / `form_resolved` | 表单发起/解决 |
| **恢复** | `checkpoint_resumed` | 从断点恢复 |
| **旧路径** | `start` / `identity` / `planning` / `assessment` / `final` / `error` | orchestrator 兼容 |

### 8.2 前端呈现

前端 `agentEventPresentation.ts` 提供工具函数：
- `getAgentLiveStatusText(events)` → 实时状态文案（如"正在检索客户档案…"）
- `getAgentRunStatusText(result)` → 运行结果状态
- `buildAgentThoughtProcessText(result)` → 合成"我的理解→做法→依据→结论"
- `describeAgentTool(toolId)` → 工具人话描述
- `finalizeAgentEvents(events)` → 流结束后清洗事件序列

### 8.3 thoughtProcess 合成文本

`agentLoop.buildThoughtProcess` 在循环结束时合成四段式文本：

```
我理解你想做的是：<message 摘要>

我做了以下操作：
- 检索客户档案（120ms）
- 读取档案（85ms）→ 需要审批确认

有一个操作需要你审批后才能继续，请在审批面板确认。
```

---

## §9 会话状态机

### 9.1 AgentSessionState

| 状态 | 触发 | inputMode | 说明 |
|------|------|-----------|------|
| `idle` | 初始 / 完成 | `normal` | 等待用户输入 |
| `running` | 发送消息 | `normal` | agentLoop 执行中 |
| `streaming` | 收到 `answer_delta` | `normal` | LLM 流式生成回答 |
| `blocked_for_approval` | 收到 approval block | `approval_comment` | 等待用户审批 |
| `editing_artifact` | 工作区编辑产物 | `artifact_instruction` | （Phase 4） |
| `awaiting_user_input` | 收到 form block | `clarification` | 等待用户填表 |
| `completed` | 流结束 | `normal` | 回答完成 |
| `failed` | 错误 | `normal` | 执行失败 |

### 9.2 inputMode 切换

- 审批气泡出现 → `inputMode='approval_comment'`（输入框变为审批备注）
- 用户选"修改" → `inputMode='approval_parameter_edit'`（输入框变为参数编辑）
- 表单卡出现 → `inputMode='clarification`
- 回到正常 → `inputMode='normal'`

---

## §10 工作区面板（Workspace）

### 10.1 工作区项类型

`AssistantWorkspaceItemKind`：`image` / `pdf` / `file` / `browser` / `terminal` / `review` / `reference` / `artifact`

### 10.2 工作区能力

| 能力 | 说明 |
|------|------|
| **实体搜索** | 搜索 Relation/Product/Order，命中后可 hydrate 详情 + 填充 patch |
| **引用锚定** | `AgentReferenceAnchor` 锚定到工具结果/知识来源 |
| **产物查看** | 工具生成的 PDF/HTML 产物在工作区预览 |
| **工具运行详情** | `AgentToolRunDetail` 展示完整入参/出参/耗时/审批 |
| **宽度记忆** | `localStorage` 持久化工作区宽度 + 展开/折叠状态 |

### 10.3 实体类型标签

```
relation.organization → 关系智库
relation.person       → 联系人
product.asset         → 数字档案
product.fabricProfile → 面料档案
product.customerCode  → 客户编码
order.line            → 订单行
```

---

## §11 语音与多模态

| 能力 | 实现 | 说明 |
|------|------|------|
| **TTS 朗读** | `ttsService` + 后端分段合成 | 回答流式生成时分段合成音频，支持语速调节 |
| **本地 STT** | `localSttService` (sherpa-onnx) | 客户端本地语音转文字，不上传音频 |
| **附件** | `ChatAttachment` | 图片/PDF/文件，后端 `attachmentContext` 转为 KnowledgeHit 灌入检索 |
| **模型选择** | `MODELS` 枚举 | 用户可在设置选择主对话模型 + 温度 |

---

## §12 后端事件总线

### 12.1 进程内 EventBus

`events.ts` 导出两个全局 `EventEmitter`：

| EventBus | 事件 | 消费方 |
|----------|------|--------|
| `approvalEventBus` | `resolved` (id, {decision, decisionNote, modifiedInput}) | agentLoop 审批挂起处 |
| `formEventBus` | `submitted` (id, values) | agentLoop 表单挂起处 |

### 12.2 设计意义

旧架构下审批完成后需要"切分对话"（新发一条消息触发继续），破坏了对话连续性。EventBus 实现「一轮流内挂起等待」的长程思考架构——agentLoop 在同一轮内挂起、恢复、继续，前端看到的是一条连续的流式消息。

---

## §13 设计系统约束

| 约束 | 合规说明 |
|------|---------|
| 消息气泡 | flat 无阴影，`rounded-card` 圆角，用户/模型左右区分用背景膜色 |
| 工具卡 | `bds-card` + 状态色（绿/红/琥珀通过 `lifecycleStatus` 语义类） |
| 审批卡 | 琥珀色边框 + 风险徽章（`risk` 映射 `bds-badge`） |
| 表单卡 | `bds-input` / `bds-select` 控件 + `bds-button` 提交 |
| 思考过程 | 折叠面板，默认收起，`ChevronDown` 展开 |
| 流式光标 | `motion` 动画 + 闪烁光标 |
| 工作区 | 可拖拽分隔条 + `PanelLeftClose`/`PanelRightClose` |

---

## §14 待补缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | `editing_artifact` 状态未接入（工作区实时编辑指令） | P2 | §9 |
| 2 | `awaiting_user_input` 非 approval 澄清请求未实现 | P2 | §9 |
| 3 | 消息编辑/重发（用户修改已发消息重新生成） | P1 | §3 |
| 4 | 多消息并行流（同一会话多轮并发） | P3 | §3 |
| 5 | 工作区 browser/terminal 类型未完整接入 | P2 | §10 |

---

## §15 交叉链接

1. [审批与 human-in-the-loop](./审批与human-in-the-loop.md) — ApprovalRequest 状态机 + AssistantResolveFlow 联动
2. [只读业务工具集](./只读业务工具集.md) — 工具卡展示的只读工具规格
3. [写操作工具集](./写操作工具集.md) — 审批卡展示的 ProcessDraft 写操作工具规格
4. [Agent 能力分层 L0-L6](./Agent能力分层L0-L6.md) — 对话交互对应 L0-L2 能力层
5. [订单状态机](../03-订单与生产/Orders-订单管理/订单状态机.md) — order.confirm 审批触发的状态流转
6. [财务域模型组](../../02-数据模型/财务域模型组.md) — AgentSession/AgentMessage/AgentToolRun 等全量字段
7. [前端组件真源](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/Assistant.tsx) — `Assistant` 主组件
8. [后端事件真源](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/events.ts) — `emitAgentWorkEvent` + Block 派生

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| Agent 循环真源 | [server/src/agent/agentLoop.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/agentLoop.ts) |
| LLM 决策层 | [server/src/agent/llmPlanner.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/llmPlanner.ts) |
| 运行时服务 | [server/src/agent/runtime.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/runtime.ts) |
| Agent 路由 | [server/src/agent/route.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/route.ts) |
| 前端事件呈现 | [lib/agentEventPresentation.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/lib/agentEventPresentation.ts) |
| Block 流归约 | [lib/agentBlockStream.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/lib/agentBlockStream.ts) |
| 类型定义 | [types.ts L1499-L1586](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/types.ts#L1499-L1586) |
| 检查点续传 | [server/src/agent/checkpoint.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/checkpoint.ts) |
