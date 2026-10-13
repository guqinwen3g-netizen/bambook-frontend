# 审批与 human-in-the-loop (Approval & HITL)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | Agent OS 人机协作安全层——定义 high-risk 工具的审批拦截机制、ApprovalRequest 状态机、AssistantResolveFlow 前端联动、表单交互（form interaction）与审批事件总线，确保 Agent 自主决策中的人类控制权 |
| **入口** | agentLoop 检测 `approvalRequired` → 挂起 → 前端审批气泡 → `POST /agent/approvals/:id/resolve` → `approvalEventBus` 恢复循环 |
| **核心角色** | 审批权：超级管理员（老板，原 owner）、系统管理员（总领导，原 admin）、销售主管（部门管理职责，原 manager）（requireRole 守卫）；发起权：所有非 viewer 角色（7 容器）可触发 draft |
| **范式** | 机制详设型文档（状态机 + 事件总线 + 前后端联动协议 + 审计链） |
| **优先级** | P0 |
| **实现状态** | ✅ 已落地（ApprovalRequest 模型 + 三态决议 approved/rejected/modified + approvalEventBus 进程内通信 + 15 分钟超时 + 前端乐观 patch + AuditLog 审计链 + 表单交互 formEventBus + resolve 路由 requireRole 守卫；agentLoop 审批挂起/恢复闭环已验证）|
| **关联 PRD 章节** | §6.4（审批策略）、§7.3（HITL 交互）、§9.3（审批权限矩阵） |
| **关联代码** | 审批路由 [server/src/agent/route.ts L351-L428](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/route.ts#L351-L428) / 事件总线 [server/src/agent/events.ts L451-L453](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/events.ts#L451-L453) / 循环挂起 [server/src/agent/agentLoop.ts L361-L543](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/agentLoop.ts#L361-L543) / 前端 [Assistant.tsx L754-L810](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/Assistant.tsx#L754-L810) |

---

## §2 HITL 双通道架构

Agent OS 的 human-in-the-loop 有两个独立通道，覆盖不同场景：

| 通道 | 触发条件 | 机制 | 挂起恢复 | 场景 |
|------|----------|------|----------|------|
| **审批通道（Approval）** | high-risk 工具执行 | `approvalEventBus` + `ApprovalRequest` | agentLoop 挂起 → resolve → 重跑 | 写操作（create/update/delete/transition） |
| **表单通道（Form）** | LLM 主动 `request_form` | `formEventBus` + 临时 formId | agentLoop 挂起 → submit → 灌入 observation | 信息收集（建档前补全字段） |

> **设计决策**：两个通道共用「挂起-恢复」架构（EventBus + Promise + 15min 超时），但语义不同——审批是「确认 Agent 的决策」，表单是「补充 Agent 缺失的信息」。前者是安全控制，后者是交互增强。

---

## §3 ApprovalRequest 状态机

### 3.1 模型定义

```prisma
model ApprovalRequest {
  id           String    @id
  requesterId  String              // 发起人（Agent 代理的用户）
  reviewerId   String?             // 审批人
  actionType   String              // 动作类型（如 'order_confirm'）
  targetType   String              // 目标实体类型（如 'orders'）
  targetId     String?             // 目标实体 ID
  status       String    @default("pending")  // pending→approved/rejected/modified
  risk         String    @default("high")      // medium/high/critical
  payload      Json                // 含 processDraft + resolution
  decisionNote String?             // 审批备注
  createdAt    DateTime  @default(now())
  decidedAt    DateTime?           // 决议时间
}
```

### 3.2 状态流转

```
                    ┌─────────┐
        创建 ──────▶│ pending │
                    └────┬────┘
                         │ POST /approvals/:id/resolve
            ┌────────────┼────────────┐
            ▼            ▼            ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐
      │ approved │ │ rejected │ │ modified │
      └──────────┘ └──────────┘ └──────────┘
         终态          终态          终态
```

| 转换 | 守卫 | 后续动作 |
|------|------|---------|
| pending → approved | `requireRole('owner','admin','manager')` + `status==='pending'` | emit `resolved` → agentLoop 重跑（`skipApprovalCheck:true`） |
| pending → rejected | 同上 | emit `resolved` → agentLoop 记录 `APPROVAL_REJECTED` |
| pending → modified | 同上 + `modifiedInput` 非空 | emit `resolved` → agentLoop 用 `modifiedInput` 重跑 |
| *→ pending | ❌ 不可逆 | `APPROVAL_ALREADY_RESOLVED` (409) |

### 3.3 幂等性

- 同一 approvalId 重复 resolve → `409 APPROVAL_ALREADY_RESOLVED` + 返回当前状态
- 已决议的 approval 不可再改（终态）

---

## §4 审批事件总线（approvalEventBus）

### 4.1 机制

`events.ts` 导出全局 `EventEmitter`：

```typescript
export const approvalEventBus = new EventEmitter();

// agentLoop 挂起处：
const resolution = await new Promise((resolve, reject) => {
  const handler = (id: string, res: any) => {
    if (id === approvalId) {
      approvalEventBus.off('resolved', handler);
      resolve(res);
    }
  };
  approvalEventBus.on('resolved', handler);
  // 15 分钟超时 + abort 监听
});

// resolve 路由处：
approvalEventBus.emit('resolved', approval.id, {
  decision, decisionNote, modifiedInput
});
```

### 4.2 设计意义

旧架构下审批完成后需要「切分对话」——用户审批后发一条新消息触发 Agent 继续。这破坏了对话连续性，且 Agent 上下文丢失。

EventBus 实现「一轮流内挂起等待」：
- agentLoop 在同一轮循环内挂起（Promise pending）
- 审批通过后 EventBus 唤醒 Promise
- agentLoop 继续执行，scratchpad 保持完整
- 前端看到的是一条连续的流式消息（审批气泡 → 工具卡变绿 → 最终回答）

### 4.3 超时与中止

| 场景 | 行为 |
|------|------|
| 15 分钟超时 | Promise reject → agentLoop 记录 `等待审批超时` → 强制收尾 |
| 用户中止（abort） | `input.signal.aborted` → reject → `stopReason='aborted'` |

---

## §5 审批拦截全流程（agentLoop 视角）

### 5.1 拦截检测

agentLoop 执行工具时，`toolRuntime.executeAgentTool` 对 high-risk 工具不直接执行，而是返回拦截信号：

```typescript
const output = await deps.toolExecutor({ toolId, input, actor, signal });
if (output.approvalRequired) {
  // 拦截！不执行，生成审批
}
```

### 5.2 拦截处理序列

```
① emitAgentWorkEvent({
     phase: 'tool_call',
     status: 'blocked',
     metadata: { approvalId, risk, input, editableFields }
   })
   → events.ts 派生 emitApprovalBlock → 前端审批气泡

② await approvalEventBus.on('resolved')  // 挂起

③ 收到 resolution:
   ├─ decision='rejected' → 记录 APPROVAL_REJECTED → continue 下一工具
   ├─ decision='approved' → 重跑 toolExecutor(skipApprovalCheck:true, approvalId)
   └─ decision='modified' → 重跑 toolExecutor(input=modifiedInput, skipApprovalCheck:true, approvalId)

④ 重跑成功 → emit tool_call_end(complete) → 前端工具卡变绿
   重跑失败 → emit tool_call_end(failed) + errorFeedback
```

### 5.3 skipApprovalCheck 机制

审批通过后重跑时，`toolExecutor` 收到 `skipApprovalCheck:true` + `approvalId`：
- `toolRuntime` 跳过审批检查（不再创建新 ApprovalRequest）
- `commitTransaction` 从 `ApprovalRequest.payload.processDraft` 恢复已审批的 draft
- 保证「审批什么就提交什么」（what-you-approve-is-what-you-commit）

---

## §6 AssistantResolveFlow（前端联动）

### 6.1 前端审批卡接收

前端 `reduceAgentBlocks` 收到 `block_start` (type='approval') 时，创建 `AgentApprovalBlock`：

```typescript
{
  type: 'approval',
  approvalId: 'ar_xxx',
  risk: 'high',
  proposedAction: '确认订单',
  toolId: 'order.confirm',
  input: { poNumber: 'PO-001' },
  editableFields: ['confirmNote'],
  approvalStatus: 'pending',
  processDraft: { /* 六字段 */ }
}
```

### 6.2 会话状态切换

审批卡出现时，前端 `patchAgentSessionContext`：

```typescript
{
  status: 'blocked_for_approval',
  inputMode: 'approval_comment',      // 输入框变为审批备注
  pendingApprovalId: 'ar_xxx',
  pendingAction: {
    kind: 'approve',
    targetId: 'ar_xxx',
    risk: 'high',
    payload: { approvalId: 'ar_xxx' },
    editableFields: ['confirmNote'],
  }
}
```

### 6.3 resolveAgentApproval 函数

前端 `resolveAgentApproval` 执行三步：

| 步骤 | 操作 | 说明 |
|------|------|------|
| ① 乐观 patch | `blocks.map(b => b.approvalId===id ? {...b, approvalStatus} : b)` | 立即更新 UI，不等网络 |
| ② POST resolve | `fetch('/agent/approvals/:id/resolve', {decision, decisionNote, modifiedInput})` | 落库 + 触发 EventBus |
| ③ 服务端确认 | 读取 `data.approval.status` 校验 | 若不一致则回退乐观 patch |

### 6.4 三种决议的前端行为

| decision | inputMode | 用户操作 | 前端动作 |
|----------|-----------|---------|---------|
| `approved` | `approval_comment` | 输入备注 → 点批准 | 乐观 patch `approved` + POST |
| `rejected` | `approval_comment` | 输入拒绝理由 → 点拒绝 | 乐观 patch `rejected` + POST |
| `modified` | `approval_parameter_edit` | 修改入参字段 → 提交 | 切换输入模式 → 用户改参数 → 提交触发 POST `modified` |

### 6.5 modified 流程特殊处理

`modified` 不直接落库——它由 chat 提交流程消费：
1. 用户选"修改" → `inputMode='approval_parameter_edit'`
2. 用户在输入框修改参数 → 作为新消息提交
3. 前端重建 approval block（用 modifiedInput）+ POST resolve `modified`
4. 后端 emit → agentLoop 用 `modifiedInput` 重跑

---

## §7 表单交互（Form HITL）

### 7.1 触发条件

agentLoop 中 LLM 输出 `action='request_form'`：

```json
{
  "thought": "我需要知道客户的公司全称和联系人才能建档...",
  "action": "request_form",
  "formTitle": "客户档案信息",
  "fields": [
    { "key": "companyName", "label": "公司全称", "type": "text", "required": true },
    { "key": "customerType", "label": "客户类型", "type": "select", "options": ["Customer","Supplier","Carrier"], "required": true }
  ]
}
```

### 7.2 表单卡渲染

前端收到 `block_start` (type='form')，创建 `AgentFormBlock`：

```typescript
{
  type: 'form',
  formId: 'form_xxx',
  title: '客户档案信息',
  fields: [...],
  submitLabel: '提交',
  formStatus: 'pending'
}
```

### 7.3 提交流程

```
用户填写 → POST /agent/forms/:id/submit { values }
  │
  ▼
formEventBus.emit('submitted', formId, values)
  │
  ▼
agentLoop 灌入 observation:
  scratchpad.thoughts.push("[用户通过表单提交了以下信息]\n公司全称: ABC Trading...")
  scratchpad.toolCalls.push({ toolId:'user_form_input', input:values, ok:true })
  │
  ▼
continue 循环 → LLM 用新 observation 决策
```

### 7.4 超时处理

表单 15 分钟超时不报错——agentLoop 把"用户未提交"作为 observation 灌入：
```
[表单交互超时，用户未提交]
```
LLM 用已有信息收尾，而非死等。

---

## §8 审批决策仲裁

### 8.1 resolveApprovalDecision（toolRegistry.ts）

`toolRuntime` 用 `resolveApprovalDecision` 仲裁是否需要审批：

| 优先级 | 来源 | 规则 |
|--------|------|------|
| ① P0-B 注册 | `getToolDefinition(toolId)` | `approvalPolicy`: never→不审批 / auto→按 risk / always→审批 |
| ② manifest 回退 | `manifestRequiresApproval` | fail-closed always（未注册工具强制审批） |

### 8.2 evaluateApprovalPolicy 三值

| approvalPolicy | risk=low | risk=medium | risk=high |
|----------------|----------|-------------|-----------|
| `never` | 不审批 | 不审批 | 不审批 |
| `auto` | 不审批 | 不审批+审计 | 审批+审计 |
| `always` | 审批+审计 | 审批+审计 | 审批+审计 |

### 8.3 policy.canUseTool（RBAC 仲裁）

```typescript
function canUseTool(actor, target) {
  if (!actor.toolScopes.includes(target.scope))
    return { allowed: false, reason: 'ROLE_NOT_ALLOWED' };
  if (target.risk === 'high' && !HIGH_RISK_APPROVERS.has(actor.roles))
    return { allowed: true, requiresApproval: true, reason: 'APPROVAL_REQUIRED' };
  return { allowed: true, requiresApproval: false };
}
```

---

## §9 审计链

### 9.1 审批审计（ApprovalRequest 落库）

每次 resolve 都创建 `AuditLog`：

```typescript
{
  actorId: reviewerId,
  action: `agent_approval_${decision}`,   // agent_approval_approved/rejected/modified
  targetType: approval.targetType,
  targetId: approval.targetId,
  detail: {
    approvalId, actionType, risk, decision, decisionNote,
    modifiedInput, reviewerActor
  }
}
```

### 9.2 工具运行审计（AgentToolRun）

每次工具执行（含审批拦截）都落 `AgentToolRun`：

| 字段 | 说明 |
|------|------|
| `approvalId` | 关联的审批 ID（若有） |
| `status` | `success`/`failed`/`approval_required` |
| `input`/`output` | 完整入参出参 |
| `risk` | 工具风险等级 |
| `idempotencyKey` | 幂等键（写操作） |
| `actorId`/`actorDisplayName`/`actorRoles` | 执行身份 |

### 9.3 commit 审计（commitTransaction）

commit 成功后写 `AuditLog`（action=`order_confirm_committed`），含：
- transactionId / approvalId / idempotencyKey
- previousStatus / newStatus
- invoiceCreated / subOperationsSummary / impactScope / irreversible

---

## §10 路由守卫

### 10.1 resolve 路由权限

```typescript
router.post('/approvals/:id/resolve',
  guard,
  requireRole('owner', 'admin', 'manager'),  // 仅审批权角色
  asyncHandler(...)
);
```

### 10.2 校验链

| 校验 | 失败响应 |
|------|---------|
| 认证（JWT/API-Key） | 401 UNAUTHORIZED |
| 角色（owner/admin/manager） | 403 |
| approval 存在 | 404 NOT_FOUND |
| approval 状态为 pending | 409 APPROVAL_ALREADY_RESOLVED |
| decision 合法 | 400 VALIDATION_FAILED |

---

## §11 前端状态恢复

### 11.1 重连/刷新场景

用户刷新页面后，前端通过 `GET /agent/sessions/:id/messages` 重载历史消息。若最后一条消息含 pending approval block：

- `agentSessionContext.pendingApprovalId` 从消息 metadata 恢复
- 前端重建审批卡（`approvalStatus='pending'`）
- 用户可继续审批（POST resolve）

> **限制**：若 agentLoop 进程已超时退出（15min），审批通过后无法恢复循环——用户需重新发起对话。checkpoint 机制（§12）可缓解此问题。

---

## §12 Checkpoint 与审批恢复

### 12.1 检查点机制

agentLoop 每步执行后保存 checkpoint 到 `AgentCheckpoint` 表：

```typescript
{
  conversationId,   // sha256(sessionId + actor scope)
  step,             // 当前步数
  message,          // 用户消息
  scratchpad,       // { thoughts[], toolCalls[] }
  iterations,       // 完整轨迹
}
```

### 12.2 审批挂起时的 checkpoint

审批挂起时，checkpoint 已保存（挂起前的最后一步）。若进程崩溃：
- 用户审批通过 → agentLoop 已不在 → 审批落库但无人消费
- 用户重新发消息 → agentLoop 检测 checkpoint → `checkpoint_resumed` 事件 → 从挂起步恢复

> **当前限制**：checkpoint resume 恢复的是 scratchpad/iterations，但审批 Eventbus 的 Promise 无法跨进程恢复。生产环境需配合任务队列（AgentJob）实现跨进程审批恢复。

---

## §13 设计系统约束

| 约束 | 合规说明 |
|------|---------|
| 审批气泡 | 琥珀色边框 + `bds-card` + risk 徽章 |
| 批准按钮 | `bds-button` primary 色 |
| 拒绝按钮 | `bds-button` danger 色 |
| 修改按钮 | `bds-button` neutral 色 |
| 备注输入 | `bds-input` + placeholder "审批备注（可选）" |
| 变更清单 | `beforeAfterDiff` 渲染为 before→after 对比，不可逆项加锁图标 |
| 表单卡 | `bds-input`/`bds-select`/`bds-button` 控件组合 |

---

## §14 DR-007 审批按组织归属解析验收场景（reviewerId 服务端解析 + 前端不传）

> **决策来源**：[DR-007](../../10-评审与决策/2026-08-16-设计评审决策记录.md#dr-007-报价审批权限按组织归属解析)
>
> **核心原则（本章节所有验收的 fail-closed 真源）**：
> 1. 前端绝对不能自行设置 reviewerId（提交审批请求时若携带，后端必须忽略或拒绝，不能直接存入 ApprovalRequest）。
> 2. reviewerId 由服务端 `resolveReviewerByDepartment(applicantUserId, actionType)` 函数单一真源解析。
> 3. 通用容器角色=销售主管，不新增硬编码"服装主管 / 面料主管"；服装/面料业务归属由部门+申请人归属判定。
> 4. 单次审批=单人单次通过（单人有效审批人 + DR-041 兜底系统管理员总领导跨团队权，再兜底超级管理员老板）。
> 5. 总领导（系统管理员容器 DR-041）拥有业务审批 scope：approvals:dept_fallback 兜底，不依赖技术超级管理员身份。

### 14.1 reviewerId 服务端解析 resolveReviewerByDepartment 链路验收（前端不传）

| 验收编号 | 场景描述 | 前置条件 | 执行步骤 | 期望结果 | 失败路径（fail-closed 必须拦截） |
|---------|---------|---------|---------|---------|------------------------------|
| DR7-A1 | 业务员（销售部 / 张主管为部门主管）申请 MOQ 豁免 → reviewerId 自动=张主管（销售主管容器用户，同一部门 head） | 1. 业务员甲 user.departmentId=DEPT__SALES；2. Department.headId=张主管（张主管容器=销售主管 DR-041）；3. 甲构造审批请求时**未传 reviewerId 字段**（前端合规）；4. actionType=order:moq-exemption | 1. `POST /approvals`（payload 无 reviewerId）；2. 后端 `resolveReviewerByDepartment(甲.id, 'order:moq-exemption')` 解析 | 1. ApprovalRequest.reviewerId = 张主管；2. 张主管审批列表出现该待办；3. 解析日志记录 applicant=甲、dept=DEPT__SALES、route=DEPT_HEAD、resolved=张主管；4. ApprovalRequest.policyKey='moq_exemption'，status=PENDING | 前端不传 reviewerId 但后端报错 → 兼容性失败；reviewerId 为空或=甲自己（self-assign）→ 流程断裂 |
| DR7-A2 | 前端恶意或误传 reviewerId=自己（甲自审批）——后端必须忽略传入值，仍按组织归属解析 | 1. 与 A1 相同；2. 前端故意在 body 里填 reviewerId=甲的 userId（想自批） | 1. 发送带 reviewerId=甲 的 POST /approvals | 1. 后端行为（二选一严格执行其一）：① 忽略 reviewerId 字段，仍按 A1 结果=张主管（更宽松）；② 直接 400 INVALID_PAYLOAD_FIELD「reviewerId 不得由客户端指定，请移除」；2. 任一路径中 ApprovalRequest.reviewerId ≠ 甲；3. 审计日志写入 APPROVAL_CLIENT_REVIEWERID_IGNORED_ATTEMPT（若忽略）或 APPROVAL_CLIENT_REVIEWERID_REJECTED（若拒绝） | 后端直接使用前端传入 reviewerId=甲 → 严重漏洞：自审批通过绕过组织归属解析（本验收 fail-closed 必须拦截） |
| DR7-A3 | 服装订单价格审批（服装部 / 李主管为服装部 head）→ reviewerId=李主管；面料订单价格审批（面料部 / 王主管为面料部 head）→ reviewerId=王主管（不新增硬编码服装主管/面料主管角色，相同容器=销售主管，通过组织归属路由） | 1. 两单：① Order.type=Garment + owner=服装部业务员小孙；② Order.type=Fabric + owner=面料部业务员小周；2. Department(服装部).headId=李、Department(面料部).headId=王；3. 李 / 王两个 User 相同容器=销售主管（DR-041 无服装/面料硬编码） | 1. 分别发 2 个价格审批 actionType=order:price-adjust | 1. 服装批 reviewerId=李主管；面料批 reviewerId=王主管；2. 李/王 Role 均=销售主管（无「服装主管」Role.code 值）；3. 审批详情页展示「按组织归属解析：服装部 head 李主管 / 面料部 head 王主管」；4. 服装部订单绝不会被面料部主管王看到在自己审批列表里（数据范围也对齐部门归属，不越权漏数据） | 错误新增 Role.code=garment_supervisor / fabric_supervisor → 违反 DR-007（禁止硬编码服装/面料主管）；李主管看到面料部小周的审批待办 → 数据范围泄露 |
| DR7-A4 | 申请人所属部门 head 空缺（无人 / 离职 / 部门 headId 为空）→ 兜底 reviewerId=系统管理员（总领导，DR-041），而不是随机指派或不指派（阻塞） | 1. 服装部 head 李离职，department.headId=NULL；2. 服装部小孙提交 MOQ 审批 | 1. resolveReviewerByDepartment 路由：① DEPT_HEAD 查找 → NULL → ② 升级 FALLBACK_SCOPE=approvals:dept_fallback → 匹配拥有该 scope 的系统管理员（总领导 DR-041，User Z 容器=系统管理员） | 1. reviewerId=Z（总领导）；2. 审批列表 Z 看到「服装部 head 空缺，兜底转总领导」提示 + 跳转部门设置入口（管理员可补 head）；3. 不出现 reviewerId=NULL（会卡死审批链）；4. 路由记录 route=FALLBACK_DEPT_HEAD_VACANT | reviewerId=NULL 导致审批单无人可批 → 流程死锁（fail-closed 必须走兜底） |
| DR7-A5 | 申请人本人=部门主管（张主管自己做订单并提交 MOQ 豁免审批）→ 自审批阻断，向上找系统管理员（总领导）兜底 reviewerId | 1. 张主管自己下订单（order.ownerId=张）；2. 张改数量 < MOQ 需申请豁免；3. 张发起审批 | 1. resolveReviewerByDepartment 检查：若 applicant=DEPT_HEAD → self-approve 不允许 → 走 FALLBACK_DEPT_HEAD_SELF_APPLY → reviewerId=Z（系统管理员总领导，跨团队兜底权，DR-007 第 3 款总领导拥有跨团队兜底权） | 1. reviewerId=Z（不是张自己）；2. 张尝试点「审批」自己的审批单 → CANNOT_SELF_APPROVE 错误码；3. Z 总领导可审批通过；4. 路由记录 route=FALLBACK_SELF_APPLY_SUPERVISOR | 张主管自批通过 → 权责分离失败（必须 fail-closed）；兜底找了另一个销售主管（跨部门，无权限）→ 也失败，必须由系统管理员（总领导）或更高（老板）兜底 |
| DR7-A6 | 总领导（系统管理员容器）审批权来源于业务 scope（approvals:dept_fallback + approvals:cross_dept_business），**不依赖技术超级管理员身份**（DR-007 技术边界）；超级管理员（老板，绝密级）拥有全部兜底最终 | 1. 用户 Z：容器=系统管理员，scopes=[approvals:dept_fallback, approvals:cross_dept_business, settings:system_read]；2. 用户 BOSS：容器=超级管理员，scopes=[*全通配符* 或 approvals:boss_final_bypass + permission:system_admin] | 1. 测试 Z 审批（非设置，纯业务兜底）；2. 测试 BOSS 审批；3. 测试删除 Z 的 approvals:cross_dept_business 后再试（反证） | 1. Z：审批 A4/A5 兜底场景通过；但 Z 不可访问「角色与权限配置」的写端点（settings:roles:write 无 scope）；2. BOSS：无论任何部门任何审批，可最终兜底特批；3. 删除 Z 的 approvals:cross_dept_business 后 → A4/A5 兜底场景报错 403 SCOPE_DENIED（证明审批权真正来源于 scope，不是 admin 容器标签） | Z 因容器=系统管理员就可以审批，而删除 scope 仍可审批 → 违反 DR-007「总领导业务审批权不得依赖技术超级管理员身份」（必须来自 scope+组织） |

### 14.2 单人单次审批原则 + 审批链复用（5 类豁免统一走 DR-007）验收

| 验收编号 | 场景描述 | 前置条件 | 执行步骤 | 期望结果 | 失败路径 |
|---------|---------|---------|---------|---------|---------|
| DR7-B1 | 5 类豁免 actionType（MOQ / 价格 / 订单变更 / 出运放行 / DR-013 例外）均走同一 resolveReviewerByDepartment 解析，审批人只有 1 位，批准 1 次即通过（非 S→D→老板 3 级） | 1. 同一张 Garment 订单下，5 类审批各 1 张；2. 申请人=甲（销售部 / 张主管 head） | 1. 分别提交 5 个 actionType：order:moq-exemption / order:price-adjust / order:change-request / shipment:release-approve / order:dr013-exception；2. 每个审批单 reviewerId 解析；3. 张主管批准 1 次；4. 查询 ApprovalRequest | 1. 5 张单 reviewerId 均=张主管（resolveReviewerByDepartment 统一解析）；2. 5 张单在张主管 Appprove 操作后 status=APPROVED（各仅需 1 次）；3. 未出现 reviewerId 2=D 主管 / reviewerId 3=BOSS 的多人串行链路；4. route 日志各 5 条，均 route=DEPT_HEAD | 某类 actionType 被硬编码 2 级审批（先 D 再老板）或 reviewerId 不同（如例外强制 BOSS）→ 与 DR-007「单人单次统一」冲突（例外若确需更严可在审批 payload 里标记，但审批人路由仍用 resolveReviewerByDepartment 解析 + 在审批意见中强要求 BOSS 手动转派，非系统自动多级） |
| DR7-B2 | 审批人转派（主管临时请假，委托 D 审批）→ 转派必须是审批人主动操作 + 审计 + 保留原审批人链；系统不得在 DR-007 路由阶段自动转派 | 1. A1 场景（张主管=reviewerId）；2. 张主管出差 2 周；3. 在审批详情页张主管点「委托给同事 W（销售主管 B）」；4. W 审批通过 | 1. 张主管操作 ApprovalRequest.reviewerId 从=张改为=W，且记录 delegatedBy=张、delegatedAt、delegateReason；2. W 审批通过后 status=APPROVED；3. 审计链包含「reviewerResolver 初派=张 → 张主动委托给 W → W 批准」；4. 委托人必须是原 reviewerId 本人（容器=销售主管或以上）；业务员甲不可发起委托（甲方可申请无委托权） | 业务员甲把审批从张主管转给 W → 严重；系统在 resolveReviewerByDepartment 阶段自动「张主管有休假记录，改派 W」→ 破坏 DR-007 单一解析真源（路由必须确定性不可自动改派；休假改派是人工主动动作） |
| DR7-B3 | 5 类 actionType 不同部门的审批人都仅由部门归属解析（服装→服装部 head；面料→面料部 head；内部面料结算价 DR-006 审批=申请方所在部门 head + 总领导跨团队兜底） | 1. 服装部小孙（内部采购申请发起方）提交内部面料结算价审批 actionType=order:internal-fabric-settle-price；2. 服装部 head=李；3. 面料部 head=王；4. 对方面料部无审批权（不是申请人归属） | 1. resolveReviewerByDepartment(孙, 'order:internal-fabric-settle-price')；2. 系统生成审批单 | 1. reviewerId=李（孙归属服装部 head）；2. 面料部 head 王不在 reviewerId（因为审批人路由统一走"申请人归属部门 head"，而面料部对内部结算价的业务确认可在审批 payload 中要求"对面料部业务确认"，或作为审批前附条件，不走审批人链）；3. 若李本人就是内部交易申请方（自批风险）→ 复用 A5 逻辑升级系统管理员总领导兜底 | 内部面料结算价默认双方主管双签 → 违反 DR-007 单人单次；若业务需双方确认，在"审批前置条件"中要求"面料部业务确认"字段，而非双人审批链 |
| DR7-B4 | 拒绝审批（Rejected）——任何人（申请人或其他人）不可绕过拒绝结果，必须走新一轮审批或绑定 DR-013 例外；例外审批走 resolveReviewerByDepartment（系统管理员总领导兜底 + 超级管理员老板最终） | 1. 订单变更申请被张主管 Rejected（理由=数量变更影响采购排期）；2. 业务员甲仍希望执行但找不到主管改意见 | 1. 甲尝试直接修改状态为 APPROVED（越权）；2. 甲转而提交 DR-013 例外单（actionType=order:dr013-exception，拟绕过的原审批拒绝、原因、风险、补救） | 1. 步骤 1：越权 403；原审批单仍=REJECTED；2. 步骤 2：resolveReviewerByDepartment(甲, 'dr013-exception') → 兜底系统管理员总领导 Z（跨团队兜底）→ Z 审批后才可绕过原拒绝；若 Z 也拒 → 再走超级管理员 BOSS 做最终（审批 payload 带 bypassedBossApproval 强制 30 字以上理由）；3. 例外通过后，原动作（订单变更）才可生效，且 ApprovalRequest 关联 exceptionId 与原被拒审批 | 申请方绕过被拒审批，直接生效 → 控制失效；例外单跳过系统管理员直接到老板 → 日常流程过重（应双层：DEPT_HEAD → 总领导兜底 → 老板最终，而非一步） |

### 14.3 越权守卫（谁可审批 vs 谁只可查看自己的审批）

| 验收编号 | 场景描述 | 前置条件 | 执行步骤 | 期望结果 | 越权失败路径 |
|---------|---------|---------|---------|---------|------------|
| DR7-C1 | 审批列表只有本人是 reviewerId 或本人拥有 approvals:cross_dept_business（系统管理员总领导）才可看到审批待办；业务员只看自己发起的申请 | 1. 7 容器账号（DR-041）；2. 30 条各类审批待办（申请人、reviewerId 各不同）；3. 每个账号登录查看「待我审批」+「我发起的审批」 | 1. 业务员：我发起的审批=自己申请的列表；待我审批=空；2. 销售主管张：待我审批=我的部门的申请人归属我的那批（不含面料部归属王的那批）；3. 系统管理员 Z：待我审批=本人 reviewerId 的 + 跨团队兜底那批；4. 财务 / QC / 后勤：我发起的审批=空（正常，非本范围申请）；待我审批=空；5. 超级管理员 BOSS：待我审批=全部可看或按配置可看（绝密级），且 boss_final_bypass 操作可用 | 任何红容器（财务/QC/后勤）出现待审批；业务员看到他人审批待办 → 越权守卫失败（数据范围 fail-closed 必须） |
| DR7-C2 | 非 reviewerId 尝试 Approve/Reject 一个审批单 | 1. 审批单 reviewerId=张主管；2. 服装部业务员甲登录（非 reviewerId）；3. 构造 Approve 请求 | 1. POST /approvals/:id/approve；2. 后端守卫审批 | 1. 返回 403 NOT_THE_REVIEWER；2. 审批单状态不变；3. 越权审计日志写入 OPERATOR_NOT_ASSIGNED_REVIEWER | 允许非 reviewer 审批通过 → 核心权限漏洞；只前端灰显但后端直接通过 → UI 守卫不足（fail-closed 必须后端守卫） |
| DR7-C3 | 财务 / QC / 后勤（DR-041 容器）被前端绕过构造审批请求 Approve 某个业务审批单 → 全部 403 | 1. 财务 F 账号；2. 审批单 reviewerId=张主管（MOQ 豁免业务审批）；3. F 构造 5 类业务审批 Approve 接口请求 | 1. 发送 5 条请求 | 1. 全部 403 SCOPE_DENIED（无 approvals:business_approve scope）；2. 财务只拥有自己的 approvals:finance_* 范围（到账/核销类审批，见 DR-041 财务不入业务审批链）；3. QC 只有 approvals:qc_*；后勤 approvals:logistics_*；三条互不侵入业务审批链 | 财务能批 MOQ / 出运放行 → DR-041 财务不入业务审批链直接违反（DR-007 与 DR-041 联动守卫） |

---

## §15 DR-013 受控例外全流程验收（类型矩阵 + DR-007 路由 + BOSS 兜底 + 越权 + 审计）

> **决策来源**：[DR-013 全局业务门禁的受控例外推进](../../10-评审与决策/2026-08-16-设计评审决策记录.md#dr-013-全局业务门禁的受控例外推进)
>
> **核心原则（验收必须全链路 fail-closed）**：
> 1. 所有门禁默认不可直接绕过；系统不得以隐藏开关、状态直写、临时脚本静默规避规则。
> 2. 例外必须走 **Dr013ExceptionRequest（P1-15）+ ApprovalRequest.bypassedApprovalId（P0-15）** 双模型留痕。
> 3. 审批权仍走 DR-007（部门主管→总领导 Z→BOSS 最终兜底，reviewerId 仍由 resolveReviewerByDepartment 解析）。
> 4. 例外批准后 **只对指定订单、指定动作、指定时点** 开放；不改变原门禁状态；不自动复制到其他订单。

### 15.1 受控例外 8 大类型矩阵（Dr013ExceptionRequest.exceptionCategory × 越过多门禁清单）

| 验收编号 | exceptionCategory（枚举） | 子分类 subCategory | 被越过的门禁（bypassedApprovalIds 或 门清单） | DR 对应 |
|---------|---------------------------|-------------------|------------------------------------------|--------|
| DR013-A1（出货 3 条件缺） | shipment_release（出运放行） | without_qc_passed | 大货QC通过 | DR-014 QC 门禁 |
| DR013-A2 | shipment_release | without_ss_confirmed | S/S 客户确认 | DR-012/014 S/S 门禁 |
| DR013-A3 | shipment_release | without_rc_confirmed | RC（匹头样）客户确认 | DR-014 RC 门禁 |
| DR013-A4 | shipment_release | without_multiple_gates | ≥2 个门禁同时缺失（例：QC未过 + S/S未确认） | DR-014/015 多重门禁 |
| DR013-A5 | order_approval（订单批准） | without_confirmation_doc | 缺少有效确认订单依据（PO邮件/客户签章/预付款任一缺） | DR-033 单据门禁 |
| DR013-A6 | qc_fault（QC 瑕疵） | defect_rate_over_limit | 缺陷率超标或 QC=Fail，仍希望推进（出运/投产） | DR-029 QC 责任闭环 |
| DR013-A7 | moq_exemption / price_deviation / order_change（5 类审批被拒后） | bypass_rejected_approval | 原 MOQ/价格/变更审批单 APP-1001=REJECTED，申请绕过主管拒绝 | DR-003/007/010 审批链 |
| DR013-A8 | document_issue（单据签发） | missing_mandatory_fields | 最终对外版本模板必填字段缺；强行签发 | DR-033 单据完整性 |

### 15.2 DR-013 × DR-007 审批路由 + 例外不改变原规则 + 指定动作时点 + 不自动复制（端到端验收）

| 验收编号 | 场景描述 | 前置条件 | 执行步骤 | 期望结果 | 失败路径 |
|---------|---------|---------|---------|---------|---------|
| DR013-B1 | 业务员申请 shipment_release without_ss_confirmed（S/S 客户 10 天未回复，临近 ETD=2 天）；仍走 DR-007 路由（销售部→张主管） | 1. 申请人=孙（销售部 head=张）；2. Shipment-20260901-003：QC 通过、RC 通过、但 S/S customerStatus=pending 未确认；3. 正常路径放行→拦截 SHIP_SS_NOT_CONFIRMED，并提供「发起受控例外」按钮 | 1. 点按钮自动填 exceptionCategory=shipment_release / subCategory=without_ss_confirmed / bypassedApprovalIds=[]（无前序审批被拒，直接越过门禁而非被拒审批）/ exceptionReason=≥30字 / customerCommitment=客户电话承诺今日内回复邮件 + 截图附件 / riskMitigationPlan=如客户最终拒绝我方承担退运/折扣；2. 提交 | 1. Dr013ExceptionRequest 创建成功；2. ApprovalRequest 同单创建，reviewerId=张主管（resolveReviewerByDepartment 销售部申请人 head 解析正确；reviewerResolverRoute=DEPT_HEAD）；3. 张主管待办出现【受控例外】标签的申请；4. 前端明确【仅对 Shipment-20260901-003 的出运放行动作，在 2026-09-05 前有效】的指定动作时点边界 | 例外 reviewerId 不按组织归属（比如直接找 Z 或 BOSS）→ DR-007 统一路由违反；例外没有标注指定动作/时点/订单边界 → 与"默认所有门禁都可绕过"等价（违反DR-013只开放指定动作的原则） |
| DR013-B2 | 例外审批通过后：**不改变原门禁状态**（S/S customerStatus 仍=pending，仍显示红色未确认，未通过；仅 Shipment 级 releaseReady=true 绑定本 EXC） | 1. DR013-B1：张主管 Approved；2. 订单/出运页面查看 | 1. 刷新 Shipment-20260901-003 releaseReady；2. 刷新 S/S 船样 FabricShipmentSample.customerStatus；3. 刷新其他 Shipment（Shipment-20260901-004 同一订单下另一出运单）releaseReady | 1. Shipment-003 releaseReady=true + 显示"受控例外 EXC-20260825-001 放行"徽标 + 链接 EXC；2. S/S 仍=pending 未确认（门禁状态未被静默修改为 approved）；3. Shipment-004 releaseReady=false（不自动复制 EXC 到其他出运单）；4. Order.status 其他下游门禁（如交单收款）仍按原规则执行 | S/S customerStatus 被静默改成 approved，后续 S/S 客户正式回复无法入库 → 数据污染；其他 Shipment 也自动被放掉 → DR-013"不自动复制其他订单"违反 |
| DR013-B3 | 张主管 Rejected 例外申请 → 申请人再向 Z（总领导）申请 → Z 仍 Rejected → BOSS 最终兜底（reviewerResolverRoute=BOSS_FINAL_BYPASS；bypass reason≥30 字 + bypassedApprovalId 绑定被拒 2 张审批） | 1. B1 的 EXC：张主管 Rejected（理由"S/S 未确认风险过高，不建议放行"）；2. 孙不接受，重新提交新 EXC-20260825-002 绑定 bypassedApprovalIds=[张主管Rejected的ApprId]；3. EXC-002 reviewerId=Z（申请人孙自申请张被拒→新申请 reviewerId=总领导 DR-007 FALLBACK？——此处仍走 DR-007，reviewerId 仍=Z 跨团队兜底 scope）；4. Z 再次 Rejected（理由"风险不可控"）；5. 孙再 EXC-003 → BOSS 最终兜底 | 1. BOSS 打开 EXC-003；2. 写 bossFinalBypassReason=≥30 字；3. Appprove | 1. EXC-003.bossFinalBypassBy/At/Reason 全写入 ApprovalRequest.bossFinalBypass*；2. bypassedApprovalIds=[EXC001RejectedApprId, EXC002RejectedApprId]；3. 每张被 Rejected 的审批单 ApprovalRequest.bypassedApprovalId=EXC-003.approvalRequestId（反链完整，BASE-39-B3）；4. Shipment-003 releaseReady=true + 徽标「BOSS 最终兜底放行」+ 链接 EXC-003 | BOSS 兜底未要求 ≥30 字理由 → 审计不透明（fail-closed ≥30 字）；被拒审批单没有 bypassedApprovalId 反链 → 无法回溯"绕过的是哪两张被拒审批" |
| DR013-B4 | **隐藏开关/静默绕过尝试：** 后端 POST /shipments/:id/release 直接在 body 加 `forceBypass: true`（非 DR-013 入口，想绕过门禁）；或数据库手动 `UPDATE Shipment SET releaseReady=true` | 1. 后端 Shipment.release 接口在非 DR-013 入口被构造 forceBypass；2. DBA 手动 UPDATE Shipment；3. 两种场景 | 1. 发送 forceBypass 请求；2. 手动 UPDATE（通过审计触发器检测） | 1. 接口：forceBypass 参数被忽略或 400 INVALID_PARAMETER（未实现的参数不允许使用）；后端依然走原门禁校验 → SHIP_SS_NOT_CONFIRMED，拒绝；2. 手动 UPDATE：PostgreSQL 触发器或服务端校验（下次读 Shipment 时重新校验门禁 + DR-013 绑定）→ 发现 releaseReady=true 但无对应门通过 + 无 Dr013ExceptionRequest 绑定 → 自动回滚为 false 并生成 CRITICAL 级 AuditLog：SHIPMENT_RELEASE_READY_WITHOUT_GATE_OR_EXCEPTION，并通知 BOSS + Z；3. 任何隐藏开关都无法放行 | 接口存在 `forceBypass` 或 `adminOverride` 参数并生效 → 违反 DR-013 第 1 条"不得以隐藏开关、直接改状态或临时脚本规避规则"（严重违反 fail-closed） |
| DR013-B5 | **指定时点过期失效：** B1 例子的 EXC 有效期=2026-09-05 前（ETD=2026-09-08，给 3 天提前放行窗口）；2026-09-06（有效期已过）业务员再次尝试用同 EXC 放行 | 1. EXC-20260825-001.validUntil=2026-09-05（在 Dr013ExceptionRequest JSON 扩展字段或模型新增字段）；2. 系统时间=2026-09-06 00:01；3. 业务员再次对 Shipment-003 点"用原例外放行"（Shipment 先被回滚回未放行，模拟 ETD 调整需重新申请） | 1. Shipment.release 接口用 EXC-001 绑定请求；2. 后端校验 validUntil | 1. 返回 EXCEPTION_EXPIRED；2. Shipment releaseReady=false（不因旧 EXC 被放行）；3. 提示"例外已过期，请重新申请 DR-013 例外"；4. 过期 EXC 状态自动=Expired | EXC 永久有效，一年后仍可用于任何出运 → 与"只在指定时点开放"原则直接矛盾（fail-closed：validUntil 必须服务端校验，不得前端控制） |

### 15.3 越权守卫 + 审计完整性 + 业务员/财务/QC 不可越权批准受控例外

| 验收编号 | 场景描述 | 前置条件 | 执行步骤 | 期望结果 | 失败路径 |
|---------|---------|---------|---------|---------|---------|
| DR013-C1 | 业务员本人自己 Approve 自己发起的 DR-013 例外（自审批风险同 DR-007） | 1. 孙发起 EXC-001 reviewerId=张主管；2. 孙构造 EXC-001 Approve 请求 | 1. 发送请求 | 1. 403 NOT_THE_REVIEWER + CANNOT_SELF_APPROVE_EXCEPTION；2. EXC 状态不变；3. 审计日志写 SELF_APPROVE_EXCEPTION_ATTEMPT | 孙可自己批准例外 → 业务员变成可以绕过任何门禁的超级权限（严重 fail-closed） |
| DR013-C2 | 财务 F / QC Q / 后勤 L（DR-041 容器）越权 Approve DR-013 shipment_release 例外 | 1. EXC 审批单 reviewerId=张主管；2. 财务 F / QC Q / 后勤 L 分别构造 Approve 接口请求 | 1. 每个账号发送请求 | 1. 全部 403 SCOPE_DENIED（无 approvals:dr013_exception_approve 业务审批 scope；财务/QC/后勤容器不持有）；2. 财务只可审批 finance 类 PaymentRequest/核销，不入业务例外链；QC 只可写 InspectionReport，不可批出运例外 | 财务或 QC 能批出运例外 → DR-041 容器边界违反（DR-007 × DR-041 联动守卫同 DR7-C3） |
| DR013-C3 | **例外必须 5 字段完整：拟越过的门禁 + 原因 + 风险 + 受影响对象 + 补救/跟进责任人**（缺任一即 400 拒绝） | 1. 业务员孙提交 EXC：exceptionReason=空 / riskMitigationPlan=空 / responsibleOwner=空（缺 3 项必填）；2. 另一提交：仅写原因=「客户急」（3 字不足） | 1. 两次提交 | 1. 缺字段=400 MISSING_MANDATORY_EXCEPTION_FIELDS，返回缺哪 5 项清单；2. reason≤29 字=400 EXCEPTION_REASON_TOO_SHORT（≥30 字 fail-closed）；3. Dr013ExceptionRequest 未创建成功；4. 前端提示红色必填标记 | 只有原因，其他 4 项（门禁/风险/对象/补救+责任人）缺也能创建 → 例外申请形同虚设，后续审计与风险不可追踪（违反 DR-013 第 2 条"至少说明拟越过的门禁、原因、风险、受影响对象和补救/跟进责任人"） |
| DR013-C4 | **审计完整性：** EXC 批准后必须写入 ≥6 条事件 AuditLog（申请、提交、审批拒绝、再申请、Z 拒绝、BOSS 兜底），每条包含申请人、批准人、时间、理由、越过规则、原状态、后续结果 | 1. DR013-B3 完整链（张 Rej → Z Rej → BOSS Approve）；2. 查询 AuditLog | 1. 筛选 entity=Dr013ExceptionRequest / entityId=EXC-003；2. 核对字段 | 1. AuditLog 至少 6 条对应每一步；2. 每条含 operatorId（谁操作）+ action（CREATE/ SUBMIT/ APPROVE/ REJECT/ BOSS_BYPASS）+ payload 包含被越门禁、理由、风险、责任人、补救、BOSS兜底≥30字理由、bypassedApprovalIds=2 张被拒审批 ID；3. 任何审计字段缺失 → fail-closed（审批被拒绝落地直到审计写成功） | EXC 批准成功但 AuditLog 因 DB 故障只写了 1 条 → 批准动作必须和写 AuditLog 同事务（PostgreSQL 事务原子；若审计写失败批准就回滚：DR-013 第 4 条"必须记录；未获批准保持原门禁"一致性必须） |
| DR013-C5 | **角色容器审批权来源：** 与 DR7-A6 一致——审批权来自 scope，不是来自「例外页面可见」或容器标签 | 1. 系统管理员 Z 拥有 approvals:dept_fallback scope；2. 删除 Z 的 approvals:dr013_exception_cross_dept（受控例外跨部门兜底 scope）；3. Z 尝试审批某跨部门 DR-013 例外（=面料部归属，Z 非面料部 head 但原跨团队兜底） | 1. 删除 Z 对应 scope；2. Z 审批 EXC | 1. 删除后→403 SCOPE_DENIED：Z 即使被标签为"系统管理员/总领导"也无法审批；2. 证明 DR-013 审批权=scopes 细粒度来源（approvals:dr013_exception_approve + approvals:dept_fallback 组合），不是容器标签粗粒度 | Z 仍可审批 → 与 DR7-A6 一样的身份型漏洞（违背权限来自 scope，而非身份标签的原则） |

### 15.4 DR-013 例外核销时机统一口径（2026-08-17 产品负责人裁决，S-BE W6 队列实施）

**规范条文（核销唯一出口 = 业务动作事务）：**

1. **门禁判定层永远不核销**：`assertFabricShipmentGate`（samples 域）与 `evaluateShipmentReleaseGate`（shipping 域）只做「判定 + 例外查询」，不调用 `consumeException`；samples 域无业务写入口 → 天然无核销点，两域同一口径。
2. **核销时机（shipping 域）**：`createShipment` / `updateShipment` 目标状态 Shipped 写库成功后、事务提交前，**同事务**对本次放行依赖的每张例外 `usedCount+1`（合票 M 张例外核销 M 张，例外 ID 由门禁 outcome `via='exception'` 摘要带出，零新增查询）；核销失败（并发已被核销/刚过期）→ 出运事务整体回滚（fail-closed，例外与业务写入同生死，绝不出现"出运成功但例外未核销"的重复可用窗口）。
3. **生效语义（裁决）**：`validUntil` 为主生效约束——**同订单窗口期内可多票出运复用同一例外**（分批出运无需逐票重申请）；`maxUses` 为上限保护（申请时按预计批次设定，耗尽即 CONSUMED）；**每次进入 Shipped（含回退后再次进入）均核销一次**——每次进 Shipped 都是独立动作时点。
4. **TOCTOU 自洽**：门禁评估→事务提交之间例外失效 → `consumeException` 返 409（ALREADY_CONSUMED/EXPIRED）→ 事务回滚 → 调用方重试时门禁重新评估自然得到 GATE_BLOCKED；无需加锁。
5. **Agent 直写路径**：`exceptionChecker=null`（无例外通道）→ 无例外可核销，登记说明即可。
6. **改造面**：`consumeException` 支持注入 tx（当前自开 `$transaction`，改为"传入 tx 则直接用、否则自开"）；`shipmentMutationService` 两处在 Shipped 写入后收集核销；测试 4 类（核销成功 / 并发已核销回滚 / 合票多例外 / 出运失败回滚不烧例外）。

| 验收编号 | 场景描述 | 前置条件 | 执行步骤 | 期望结果 | 失败路径 |
|---------|---------|---------|---------|---------|---------|
| DR013-C6 | **核销与出运同事务：** 例外放行的出运单 Shipped 写库成功 → 例外 usedCount+1；出运写库失败回滚 → 例外不被"烧" | 1. EXC-001 生效中（usedCount=0/maxUses=3/validUntil 未过）；2. 订单 S/S 未确认（原门禁不通过） | 1. 创建出运单直建 Shipped（门禁经例外放行）；2. 模拟出运写库失败（约束冲突）重放场景 | 1. 成功路径：出运单落库 + EXC usedCount=1 + 审计 dr013_exception_consumed 与出运审计同一事务可查；2. 失败路径：出运回滚 + EXC usedCount 仍=0（例外不烧） | 核销与出运分离两事务 → 出运失败但例外已核销，用户业务没办成例外没了（违反"审计写入与状态变更同事务"铁律） |
| DR013-C7 | **窗口期内复用 + maxUses 上限保护：** 同订单分批出运，validUntil 内第二票无需新例外；maxUses 耗尽 → 阻断 | 1. EXC-002 生效中（maxUses=2/validUntil=T+7）；2. 同订单第一票已 Shipped（usedCount=1） | 1. 第二票出运（validUntil 内）；2. 第三票出运（usedCount 将达 3 > maxUses=2） | 1. 第二票：例外放行 + usedCount=2（窗口期复用成立）；2. 第三票：EXCEPTION_ALREADY_CONSUMED → GATE_BLOCKED，提示重新申请 | maxUses=1 硬编码导致第二票被误杀（分批出运业务断裂）；或 maxUses 失效无限复用（一次性名存实亡） |
| DR013-C8 | **回退再进 Shipped 再核销：** 出运单 Shipped → 回退 Booked → 再 Shipped，第二次进入仍核销 | 1. EXC-003 生效中（usedCount=1/maxUses=3）；2. 出运单已由例外放行 Shipped 一次 | 1. 状态回退 Booked；2. 再次 Shipped | 1. 第二次进 Shipped：门禁重评（原门禁仍不通过 → 查例外仍生效）→ 放行 + usedCount=2；2. 审计含两条 dr013_exception_consumed（各带 consumedAt） | 同单号跳过二次核销 → 状态修正成为免费通道（每次进 Shipped 都是独立风险事件，必须独立计次） |

---

## §16 审批生命周期增强（2026-08-18 A1 深化裁决，S-BE 排期实施）

> **裁决来源**：2026-08-18 全局审计（后端 ≈85%）后 A1 审批域深化讨论，产品负责人六项裁决，统一消除 §17 全部六项缺口。
> **核心架构转变**：审批等待从「进程内 Promise」升级为「DB 状态机 + EventBus 快路径」双层模型——DB 为持久真源，EventBus 仅为同进程低延迟通道。

### 16.1 挂起状态机化（裁决 1：方案 B）

**规范条文：**

1. **先持久化后等待**：agentLoop 检测 `approvalRequired` 后、挂起等待**前**，将 `pendingApprovalId` + `blockedStep` + `blockedCallId` 写入 checkpoint（AgentCheckpoint schema 扩展三字段）——杜绝「等待中崩溃 → 孤儿 pending 单」窗口。
2. **双层等待模型**：
   - **快路径（同进程）**：现状 EventBus `resolved` 监听保留，审批人秒批秒回，UX 不变。
   - **持久路径（跨进程）**：15 分钟交互超时到达 → **不再判 APPROVAL_FAILED**，转为 detached 等待：任务标记 `awaiting_approval`，SSE 回合友好结束（前端展示"审批待决，决议后自动继续"）；进程重启不丢失。
3. **双路径唤醒**：resolve 路由完成状态翻转后 → ① EventBus emit（有进程内监听者时秒回）；② 无监听者（`listenerCount===0`）→ 触发内部 resume 调度，从 checkpoint 恢复 agentLoop。
4. **resume 幂等**：恢复时先查 `pendingApprovalId` 对应 ApprovalRequest 现状——approved/modified → 带 resolution 重跑 blockedStep（skipApprovalCheck）；rejected/expired → 作为 observation 喂回 LLM；仍 pending → 重新进入等待（不重建审批单）。ApprovalRequest 创建前按 `conversationId + step + callId` 查重，已存在则复用不重发。
5. **启动孤儿扫描**：服务启动时扫描「checkpoint 含 pendingApprovalId 且审批单仍 pending」的会话 → 保持等待标记；「审批单已决议但任务停摆」→ 立即调度 resume。该扫描与 §16.2 的 ApprovalLifecycleSweeper 合并为同一组件。

### 16.2 超时口径统一（裁决 2：expired 终态 + 策略表）

**规范条文：**

1. **分层语义**：L0 交互层 = 15min 进程内等待 → detached（§16.1，零业务后果）；L1 业务层 = ApprovalRequest 生命周期策略（本条）。
2. **新终态 `expired`**：状态机扩展为 `pending → approved / rejected / modified / expired`。"无人处理"（expired）与"被否决"（rejected）语义分离；expired **不触发** rejected 的业务联动（如报价回滚）；expired 后发起人可重新发起（原单不重开，终态不可逆原则不变）。
3. **默认策略表（policyKey 驱动，禁止硬编码）**：

| 节点 | 动作 |
|---|---|
| createdAt + 24h | 提醒审批人（站内通知） |
| createdAt + 48h | 二次提醒 + 抄送发起人 |
| createdAt + 72h | 置 `expired`（终态） |

   各 actionType 可经审批策略配置覆盖默认值；MOQ「不自动升级」归并为策略行 `moq_exemption: { remind: 72h, escalate: never, expire: 72h }`——「不升级审批层级」与「超时过期」不再矛盾。价格审批规则.md §3 的「72h auto-reject」口径由本条收编为 `expired`（该文档同步修订为引用本条）。
4. **执行器**：scheduler 域新增 `ApprovalLifecycleSweeper` 周期扫描 pending 单按策略执行提醒/过期；与 §16.1-5 启动扫描同组件。
5. **expired 后 agent 侧语义**：detached 等待中审批单被置 expired → resume 时作为工具执行结果（observation）喂回 LLM，由 LLM 决定重新发起/换方案/放弃——与 rejected 现有处理范式一致，不硬终止任务。

### 16.3 modified 决议断链修复（裁决 3：重生成 draft）

**规范条文：**

1. **重生成而非直传**：resolve 路由收到 modified 决议时，服务端以 `modifiedInput` 重新调用**同一 draft 生成函数**（与创建时同一入口）→ 生成新 ProcessDraft + 新 hash 替换 `payload.processDraft` → 同事务翻转状态为 modified → 唤醒重跑 commit。
2. **安全链完整**：`approvalId + modifiedInput hash + newDraftHash` 三层绑定；`payload.resolution` 记录 before/after（原 input vs modifiedInput、原 draftHash vs newDraftHash）。
3. **原子性与失败处理**：重生成 + 状态翻转同事务；重生成失败（modifiedInput 不合法 / 引用实体已变更）→ 409 退回审批人附原因，单保持 pending 不污染。
4. **工程纪律**：draft 生成函数必须纯函数化（输入 → draft，可重入）；个别无法重生成的工具在工具注册声明 `supportsModified: false`，resolve 路由对这类工具 400 拒绝 modified（清单制，非特例补丁）。
5. **与恢复路径共享入口**：modified 重跑与 §16.1 的 resume 重跑共用「带 resolution 重跑 blockedStep」入口，不另开路径。

### 16.4 审批人触达（裁决 4：三触点站内通知）

**规范条文：**

1. **三触点统一走 notifications 域（NotificationCenter 站内）**：
   - 触点① 审批单创建 → 通知 reviewerId（DR-007 服务端解析结果）；
   - 触点② §16.2 Sweeper 24/48h 提醒 → 同通道；
   - 触点③ 决议完成（approved/rejected/modified/expired）→ 通知发起人。
2. **接入点**：`approvalCreateService.createBusinessApproval` 与 agent 审批创建点统一注入 notificationService，禁止各域自行拼通知。
3. **邮件渠道缓行**：后续经通知偏好扩展，本期不做。

### 16.5 委托/转交补齐（裁决 5：复用内核 + 销号）

**规范条文：**

1. agent 审批路由（`server/src/agent/route.ts`）补 `POST /agent/approvals/:id/delegate` 端点，**复用业务审批内核同一 delegate 服务函数**（approvalKernelRoute.ts:58 已落地），禁止另写一套。
2. 委托沿用 DR7-B2 纪律：主动转派 + 审计（delegatedBy/At/Reason 三字段）+ 禁止自动改派。
3. 前端审批气泡加转交入口。
4. 本条落地后 §17 #3 销号。

### 16.6 批量审批（裁决 6：带护栏实现）

**规范条文：**

1. **准入护栏**：仅同 `actionType` 且 risk ≠ critical 的 pending 单可批量 approve；modified / reject 不支持批量（批量否决误伤面大）。
2. **逐单审计**：批量中每张单独立写决议记录 + `batchId` 关联（可审计、可追溯、可单条回查）；批量操作本身记一条 batch 审计。
3. **失败隔离**：批量内单张失败（如已被决议）不阻断其余，结果逐单返回。

### 16.7 验收矩阵

| 验收编号 | 场景描述 | 前置条件 | 执行步骤 | 期望结果 | 失败路径 |
|---------|---------|---------|---------|---------|---------|
| A1-E1 | **崩溃恢复零丢失：** 审批挂起中服务重启，审批人重启后 approve → 任务自动 resume 完成 | 1. agent 任务触发 high-risk 工具挂起（checkpoint 已含 pendingApprovalId）；2. 服务重启 | 1. 审批人调 resolve approve；2. 观察任务 | 任务经跨进程唤醒 resume，带 resolution 重跑 blockedStep 完成 commit；全程无新 ApprovalRequest | 无 pendingApprovalId 持久化 → 重启后任务永久停摆；或 resume 重复建单（一单变两单） |
| A1-E2 | **detached 等待转续：** 审批超过 15min 未决 → 转 detached；2h 后 approve → 自动继续 | 任务挂起，SSE 在线 | 1. 等待 15min；2. 2h 后审批人 approve | 15min 时 SSE 友好结束（状态 awaiting_approval，无 APPROVAL_FAILED 记录）；approve 后任务自动 resume | 超时即 APPROVAL_FAILED 写记录 continue（旧口径回退）→ LLM 误判审批失败乱决策 |
| A1-E3 | **resume 幂等防重单：** 同 step 恢复时不重复创建 ApprovalRequest | checkpoint 含 pendingApprovalId（单仍 pending） | 触发 resume | 检测到既有 pending 单 → 重新挂等，ApprovalRequest 计数不变 | 每次 resume 新建一单 → 审批中心被重复单刷屏 |
| A1-E4 | **超时过期 expire：** pending 单 72h 未决 → Sweeper 置 expired → agent 侧喂回 LLM | 1. 审批单 pending 72h（测试时钟注入）；2. 任务 detached 等待中 | 1. Sweeper 扫描执行；2. 观察任务 | 单置 expired（非 rejected）；24/48h 提醒通知已发；任务 resume 后 LLM 收到"审批已过期"observation 并决策 | expired 误触 rejected 联动（报价被错误回滚）；或硬终止任务用户需手工重发 |
| A1-E5 | **modified 重生成闭环：** 审批人改参 modified → commit 执行的是新 draft | order.confirm 挂起（原 qty=100） | 审批人 modified qty=80 → resolve | payload.processDraft 为新 draft（qty=80）+ 新 hash；commit 落库 qty=80；审计含 before/after（100→80、hash 前后值） | 直传 modifiedInput 复用旧 draft → commit 落 qty=100（执行的并非批准的，一致性漏洞） |
| A1-E6 | **modified 失败退回：** modifiedInput 不合法 → 409 单不污染 | 同上 | 审批人 modified qty=-5 | resolve 409 附原因，单保持 pending，payload 无变化 | 部分写入（状态翻转了但 draft 没换）→ 数据不一致 |
| A1-E7 | **三触点通知：** 创建/提醒/决议三点通知到位 | 审批策略生效 | 1. 发起审批；2. 时钟推进 24h；3. 审批人 approve | ① reviewerId 收到待办通知；② 24h 收到提醒；③ 发起人收到决议通知 | 通知绑错角色（通知发起人而非审批人）；或 Sweeper 重复发提醒 |
| A1-E8 | **委托转交：** agent 审批单 delegate 给上级 → 新审批人可决议 | 单 pending（reviewerId=主管） | 主管 delegate → 老板；老板 approve | 委托审计三字段落库；老板 resolve 成功；原主管不再可决议 | agent 路由 404（端点缺失）；或委托后两人都能批（双审批权） |
| A1-E9 | **批量护栏：** 同 actionType 非 critical 批量 approve；混入 critical 被拒 | 3 单 pending（2 普通 + 1 critical） | 批量 approve 全选 | 护栏拦截 critical 单，提示剔除后可批量；2 普通单 approve + batchId 关联审计 | 批量含 critical 放行（红标业务被批量放水）；或批量内一单失败全部回滚（可用性差） |

---

## §17 待补缺口

| # | 缺口 | 优先级 | 落点 | 状态 |
|---|------|-------|------|------|
| 1 | 跨进程审批恢复（AgentJob 队列消费 approvalEventBus） | P1 | §12 / §16.1 | ✅ 已裁决（2026-08-18 §16.1 方案 B 挂起状态机化，S-BE 排期实施） |
| 2 | 审批超时自动拒绝（当前静默超时，无通知） | P2 | §4 / §16.2 | ✅ 已裁决（§16.2 expired 终态 + 24/48/72h 策略表） |
| 3 | 审批委托/转交（manager 转给 owner） | P2 | §3 / §16.5 | ✅ 已裁决（§16.5 复用内核补 agent 端点，落地后销号） |
| 4 | 批量审批（一次审批多个同类操作） | P3 | §3 / §16.6 | ✅ 已裁决（§16.6 带护栏实现） |
| 5 | 审批通知（飞书/邮件推送 pending 审批） | P2 | §4 / §16.4 | ✅ 已裁决（§16.4 三触点站内通知；飞书/邮件渠道缓行） |
| 6 | modified 流程的 ProcessDraft 重新生成（当前 modifiedInput 直接传，未重新 hash） | P1 | §6 / §16.3 | ✅ 已裁决（§16.3 重生成 draft + 重 hash） |

---

## §18 交叉链接

1. [写操作工具集](./写操作工具集.md) — 审批拦截的 high-risk 工具规格 + ProcessDraft 契约
2. [Assistant 对话交互](./Assistant对话交互.md) — 审批气泡渲染 + 会话状态机 + inputMode 切换
3. [只读业务工具集](./只读业务工具集.md) — 只读工具不触发审批（approvalPolicy=never）
4. [Agent 能力分层 L0-L6](./Agent能力分层L0-L6.md) — 审批对应 L3 human-in-the-loop 层
5. [订单状态机](../03-订单与生产/Orders-订单管理/订单状态机.md) — order.confirm 审批触发的状态流转
6. [偏差校验与审批链](../03-订单与生产/Pricing-定价与成本/偏差校验与审批链.md) — 定价偏差审批链（业务层审批）
7. [财务域模型组](../../02-数据模型/财务域模型组.md) — ApprovalRequest/AgentToolRun/AgentCommitReceipt 模型
8. [前端组件真源](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/Assistant.tsx) — `resolveAgentApproval` 函数

---

## §19 相关文档索引

| 文档 | 路径 |
|------|------|
| 审批路由 | [server/src/agent/route.ts L351-L428](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/route.ts#L351-L428) |
| 事件总线 | [server/src/agent/events.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/events.ts) |
| 审批决策仲裁 | [server/src/agent/toolRegistry.ts L780-L800](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/toolRegistry.ts#L780-L800) |
| 权限策略 | [server/src/agent/policy.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/policy.ts) |
| commit 事务引擎 | [server/src/agent/commitTransaction.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/commitTransaction.ts) |
| 检查点续传 | [server/src/agent/checkpoint.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/agent/checkpoint.ts) |
| ApprovalRequest 模型 | [schema.prisma L1807-L1828](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/prisma/schema.prisma#L1807-L1828) |
| 前端审批处理 | [Assistant.tsx L754-L810](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/Assistant.tsx#L754-L810) |
