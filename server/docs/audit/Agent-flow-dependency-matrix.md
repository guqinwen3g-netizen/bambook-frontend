# Agent Flow 依赖矩阵

**Task**: task_mqxv9giu (Agent-flow-dependency-matrix)
**审计日期**: 2026-06-28
**性质**: 仅审计/矩阵，未修改任何生产代码
**输入引用**: [ERP-data-readiness-audit](./ERP-data-readiness-audit.md)（task_mqxv9db3）、P1-A/B/C/D 已验证结果、ERP 服务就绪度审计（§3）

---

## 1. 执行摘要

ERP OS 地基阻断优先于 Agent 泛化引擎。当前 6 个业务 flow 中，只有 order.confirm 就绪；其余均受 ERP 数据层/服务层/审计层阻断。Agent registry 泛化可作为技术前置，但不能压过 ERP readiness。

### 1.1 Flow 就绪度总览

| 业务 Flow | ERP 地基就绪度 | Agent 引擎就绪度 | 综合评级 | 阻断点 |
|---|---|---|---|---|
| **order.confirm** | 🟢 就绪 | 🟢 就绪（P1-A/B/C/D） | 🟢 **就绪** | 无 |
| **invoice.issue** | 🟡 部分 | 🔴 阻断 | 🟡 **部分** | route 层零校验/AuditLog；状态机无合法转移校验 |
| **payment.receive_and_reconcile** | 🔴 阻断 | 🔴 阻断 | 🔴 **阻断** | InvoiceAllocation 未实现；1:N 核销不可用 |
| **order.ship / shipping.dispatch** | 🔴 阻断 | 🔴 阻断 | 🔴 **阻断** | carrier/forwarder bug；Order↔Shipment 状态零联动 |
| **relation.onboard** | 🟡 部分 | 🟡 部分 | 🟡 **部分** | Agent 工具不 sync；route 零 AuditLog；无 status 生命周期 |
| **email.reply_and_send** | 🔴 阻断 | 🔴 阻断 | 🔴 **阻断** | email.send 幽灵工具；不持久化；无 reply |

---

## 2. order.confirm（基准，已就绪）

P1-A/B/C/D 已完整验证。依赖映射作为其他 flow 的对照基准。

| 维度 | 评级 | 依据 |
|---|---|---|
| 手动路径校验/AuditLog | 🟢 | commitTransaction 内 AuditLog（[commitTransaction.ts L330](../../src/agent/commitTransaction.ts#L330)） |
| 数据模型 | 🟢 | Order/Invoice/OrderStatusTransition 就绪 |
| 状态机 | 🟢 | Pending→Confirmed，有 OrderStatusTransition 审计轨迹 |
| EntityLink sync | 🟢 | buildInvoiceReferenceOps 事务内（aboutOrder + billTo） |
| 失败恢复 rollback | 🟢 | $transaction 全回滚 |
| Agent 引擎（draft/commit/feedback） | 🟢 | P1-A/B/C/D 完整 |
| 前端可见性 | 🟢 | outputPreview/errorPreview/errorFeedback（P1-C/D 验证） |

---

## 3. invoice.issue（部分就绪）

### 3.1 七维度依赖映射

| 维度 | 评级 | 现状 | 阻断点 |
|---|---|---|---|
| 手动路径（finance route） | 🟡 partial | [finance/route.ts L102-114](../../src/finance/route.ts#L102) POST 仅 pickFields 白名单，无 amount>0/orderId 存在性校验 | 业务校验需补 |
| 数据模型 | 🟢 ready | Invoice schema 完整（amount Decimal/currency/status） | 无 |
| 状态机 | 🔴 blocked | schema 声明 Draft\|Issued\|PartiallyPaid\|Paid\|Cancelled，但 route PATCH 可任意改 status，无合法转移校验；route 创建默认 Draft，commitTransaction 跳过 Draft 直接 Issued，两路径不一致 | 需统一状态机 + 转移校验 |
| AuditLog | 🟡 partial | route/toolRuntime 零 AuditLog；仅 commitTransaction 写 | route+tool 层需补 AuditLog |
| EntityLink sync | 🟢 ready | syncInvoiceReferences 三处调用（route L108/L193, tool L3542）+ commitTransaction 内 buildInvoiceReferenceOps | 无 |
| 失败恢复 | 🟡 partial | commitTransaction 事务原子；route POST 不在事务内，sync 失败致孤儿数据 | route 层需事务化 |
| 前端可见性 | 🟡 partial | toolRuntime 返回 invoice，但无结构化 outputPreview（P1-C feedbackContract 是 order.confirm 专属） | 需 FlowErrorCode 泛化 |

### 3.2 阻断顺序
1. route 层补 amount>0 + orderId/customerRelationId 存在性校验
2. route/toolRuntime 层补 AuditLog
3. 统一状态机（Draft→Issued 合法转移，禁止任意 PATCH status）
4. route POST 事务化（含 syncInvoiceReferences）

---

## 4. payment.receive_and_reconcile（阻断）

### 4.1 七维度依赖映射

| 维度 | 评级 | 现状 | 阻断点 |
|---|---|---|---|
| 手动路径（finance route） | 🔴 blocked | [route.ts L150-175](../../src/finance/route.ts#L150) voucher PATCH 只机械更新，不触发 invoice status 重算（一致性 bug） | 需核销重算逻辑 |
| 数据模型 | 🔴 blocked | **InvoiceAllocation 模型不存在**（schema L1265 注释"1:N 销账暂不支持"）；appliedAmount 只支持 1:1 | **最硬阻断**：需中间表 |
| 状态机 | 🟡 partial | Invoice status 有重算（toolRuntime L3574-3631 汇总 appliedAmount）；但 PaymentVoucher **无 status 字段**，无法表达核销状态；route PATCH 不重算 | Voucher 需加 status |
| AuditLog | 🔴 blocked | route/toolRuntime voucher 端点零 AuditLog；核销是高风险财务操作 | 审计完全缺失 |
| EntityLink sync | 🟢 ready | syncPaymentVoucherReferences（aboutOrder/settlesInvoice/billTo） | 无 |
| 失败恢复 | 🟡 partial | toolRuntime apply_voucher 用 $transaction（L3583）；但 syncPaymentVoucherReferences 在事务外（L3621），link 失败致不一致；route PATCH 无事务 | 需 buildPaymentVoucherReferenceOps（事务内版） |
| 前端可见性 | 🔴 blocked | 无 processDraft/commit/feedback | 需新建 flow |

### 4.2 阻断顺序
1. **P0 数据层**：InvoiceAllocation 中间表（1:N 销账）——最硬阻断
2. **P0 数据层**：PaymentVoucher 加 status 字段（unreconciled/partially_reconciled/reconciled）
3. **P1 服务层**：route PATCH voucher 触发 invoice status 重算（修一致性 bug）
4. **P1 服务层**：route/tool 补 AuditLog
5. **P1 Agent 引擎**：buildPaymentVoucherReferenceOps（事务内版）+ draft/commit/feedback

---

## 5. order.ship / shipping.dispatch（阻断）

### 5.1 七维度依赖映射

| 维度 | 评级 | 现状 | 阻断点 |
|---|---|---|---|
| 手动路径（shipping route） | 🟡 partial | [shipping/route.ts L130-182](../../src/shipping/route.ts#L130) POST/PATCH 通用，零业务校验 | 校验需补 |
| 数据模型 | 🟡 partial | Shipment schema 就绪，但 **carrier vs forwarder 字段名 bug**：schema/route/toolRuntime 用 `carrierRelationId/carrierName`，sync.ts 用 `forwarderRelationId/forwarderName`（[sync.ts L625](../../src/entities/sync.ts#L625)）→ **shipsVia EntityLink 永不创建** | 字段名统一 |
| 状态机 | 🔴 blocked | Order↔Shipment 状态**零联动**：创建 Shipment 不触发 Order→Shipping；两状态机完全解耦，无桥接逻辑 | 需 Order→Shipping 状态串联 |
| AuditLog | 🔴 blocked | shipping/route/toolRuntime 零 AuditLog；发货状态变更全无审计 | 审计完全缺失 |
| EntityLink sync | 🟡 partial | syncShipmentReferences 调用，但 shipsVia（forwarderRelationId）死链；aboutOrder/billTo 正常 | 3 linkKind 中 1 个死链 |
| 失败恢复 | 🟡 partial | route/tool 非事务化，sync 在事务外 | 需事务化 + buildShipmentReferenceOps |
| 前端可见性 | 🔴 blocked | 无 processDraft/commit/feedback | 需新建 flow |

### 5.2 阻断顺序
1. **P0 服务层**：修复 sync.ts 字段名 bug（forwarder→carrier）——shipsVia link 恢复
2. **P0 服务层**：Order→Shipping 状态联动（创建 Shipment 触发 Order→Shipping，可选双向）
3. **P1 服务层**：route/tool 补 AuditLog
4. **P1 服务层**：Shipment 状态合法转移校验
5. **P1 Agent 引擎**：buildShipmentReferenceOps + draft/commit/feedback

---

## 6. relation.onboard（部分就绪）

### 6.1 七维度依赖映射

| 维度 | 评级 | 现状 | 阻断点 |
|---|---|---|---|
| 手动路径（relations route） | 🟡 partial | [relations/route.ts L146-186](../../src/relations/route.ts#L146) POST/PUT 仅校验 id/name 非空，category 缺失默认 'Other'，**无 7 选 1 枚举校验**；Agent 工具有校验（L3643）但 route 没有——契约不一致 | route 层需补 category 枚举校验 |
| 数据模型 | 🟢 ready | Relation schema 完整（category/type/creditLimit） | 无 |
| 状态机 | 🔴 blocked | Relation **无 status 字段**，仅 deletedAt 软删；无"潜在→活跃→dormant→归档"生命周期 | 需加 status 生命周期 |
| AuditLog | 🔴 blocked | route/tool 零 AuditLog；客商建档是高风险操作（信用额度/付款条件） | 审计完全缺失 |
| EntityLink sync | 🔴 blocked | **Agent 工具 handleRelationCreate 不调用 syncRelationEntityReferences**（[toolRuntime.ts L3637-3695](../../src/agent/toolRuntime.ts#L3637)）——通过 Agent 建档的客商不进实体图谱；route 调用 sync（L159）但组织建档不产生 link（设计如此） | Agent 工具需补 sync 调用 |
| 失败恢复 | 🟡 partial | route sync 失败被 .catch 吞掉（L159-161 console.error），静默不一致；Agent upsert 不 sync | 需事务化或显式错误传播 |
| 前端可见性 | 🟡 partial | tool 返回 relation，无结构化 outputPreview | 需 FlowErrorCode 泛化 |

### 6.2 阻断顺序
1. **P0 Agent 引擎**：handleRelationCreate 补 syncRelationEntityReferences 调用（通过 Agent 建档进图谱）
2. **P1 服务层**：route 补 category 7 选 1 枚举校验（与 Agent 工具对齐）
3. **P1 服务层**：route/tool 补 AuditLog
4. **P2 数据层**：Relation 加 status 生命周期（可选）

---

## 7. email.reply_and_send（阻断）

### 7.1 七维度依赖映射

| 维度 | 评级 | 现状 | 阻断点 |
|---|---|---|---|
| email.send 工具实现 | 🔴 blocked | **幽灵工具**：[defaults.ts L240](../../src/agent/defaults.ts#L240) 声明 email.send，但 [toolRuntime.ts L908-912](../../src/agent/toolRuntime.ts#L908) dispatcher **无 handler** → throw 'Tool handler not implemented' | 需实现 handler |
| 发送持久化 | 🔴 blocked | [email/route.ts L459-478](../../src/email/route.ts#L459) /send 直接 SMTP，**不创建 Email DB 记录**，发出邮件在系统"消失" | 需持久化 Email 记录 |
| 回复（reply）能力 | 🔴 blocked | 无 reply 端点；/send 不设 In-Reply-To/References/threadId，无法实现邮件线索 | 需 reply 端点 + thread 关联 |
| P1-A scope 边界 | 🟢 ready | toolRegistry 明确排除 email/postCommitHooks；order.confirm 不触碰 email | 边界正确，保持 |
| AuditLog | 🔴 blocked | email route /send /sync 零 AuditLog | 审计缺失 |
| EntityLink sync | 🔴 blocked | syncEmailReferences（sentBy/aboutOrder/aboutInvoice）声明但：/sync 创建 Email 不调用；/send 不创建 Email 自然不调用；仅 link_to_order 工具调用 | 自动同步路径全缺失 |
| 失败恢复 | 🔴 blocked | /send SMTP 失败无重试/无持久化 | 需 EmailQueue |

### 7.2 阻断顺序
1. **P0 服务层**：/send 持久化 Email 记录（sent 文件夹）
2. **P0 服务层**：email.send Agent 工具实现 handler（或从 manifest 移除避免幽灵工具）
3. **P1 服务层**：reply 端点（In-Reply-To/References/threadId）
4. **P1 服务层**：syncEmailReferences 在创建 Email 时自动调用
5. **P2 Agent 引擎**：email.reply_and_send composed flow（需评估 P1-A scope 是否扩展）

> ⚠️ **scope 决策**：email.reply_and_send 需要 postCommitHook（EmailQueue），与 P1-A "无 email/hooks" 边界冲突。需产品决策是否扩展 scope。

---

## 8. 跨流程系统性问题（ERP OS 地基阻断）

> 这些是影响多个 flow 的系统性缺口，优先级高于单个 flow 的 Agent 泛化。

| # | 系统性问题 | 影响范围 | 阻断等级 |
|---|---|---|---|
| 1 | **业务路由层 AuditLog 全线缺失** | finance/shipping/relations/email route + toolRuntime（除 commitTransaction） | 🔴 P0 |
| 2 | **carrier/forwarder 字段名 bug**（sync.ts vs schema/route） | shipping.dispatch（shipsVia 死链） | 🔴 P0 |
| 3 | **Agent 工具 vs 路由层契约不对齐** | relation（category 校验/sync）、email（幽灵工具）、invoice（状态机） | 🟡 P1 |
| 4 | **状态机审计轨迹不统一** | Order 有 OrderStatusTransition，Invoice/Shipment/Relation 无等价物 | 🟡 P1 |
| 5 | **EntityLink sync 不在事务内**（除 commitTransaction） | 所有 route 层 sync 调用，link 失败致孤儿数据 | 🟡 P1 |
| 6 | **InvoiceAllocation 1:N 销账未实现** | payment.receive_and_reconcile | 🔴 P0（硬阻断） |

---

## 9. 阻断优先级总序（ERP OS 地基优先）

> 原则：先 ERP OS 地基阻断（数据/服务/审计），再 Agent registry 泛化引擎。

### Tier 0 — ERP 数据/服务地基（硬阻断，必须先解决）
1. **InvoiceAllocation 中间表**（payment 1:N 销账）← 解锁 payment.receive_and_reconcile
2. **carrier/forwarder 字段名统一**（sync.ts）← 恢复 shipsVia link
3. **业务路由层 AuditLog 补齐**（finance/shipping/relations/email）← 跨流程审计基础
4. **PaymentVoucher 加 status 字段** ← 核销状态可见

### Tier 1 — 状态机/校验/恢复（重要阻断）
5. **Order↔Shipment 状态联动** ← order.ship 流程串联
6. **Invoice/Shipment 状态合法转移校验**（禁止任意 PATCH status）
7. **route/tool 契约对齐**（category 枚举/sync 调用/幽灵工具清理）
8. **EntityLink sync 事务化**（buildXxxReferenceOps for PaymentVoucher/Shipment）
9. **email.send 持久化 + handler**（或从 manifest 移除）

### Tier 2 — Agent registry 泛化引擎（技术前置，不压过 ERP readiness）
10. **CommitStrategy registry**（commitTransaction 按 flowType 分派）
11. **draftBuilder registry**（移除 draftPhase 硬编码守卫 id==='order.confirm'）
12. **feedbackContract 提升为 FlowErrorCode**（通用码 + per-flow 扩展）
13. **buildXxxReferenceOps 事务内版**（PaymentVoucher/Shipment/Email）

### Tier 3 — 业务 flow 实现（按优先级，依赖 Tier 0-2）
14. invoice.issue（依赖 Tier 1 #5-7）
15. relation.onboard（依赖 Tier 1 #7-8）
16. payment.receive_and_reconcile（依赖 Tier 0 #1,#4 + Tier 1 #8）
17. order.ship（依赖 Tier 0 #2 + Tier 1 #5,#8）
18. email.reply_and_send（依赖 Tier 1 #9 + scope 产品决策）

---

## 10. 结论

### 10.1 当前能力边界
- ✅ **order.confirm 完整就绪**（P1-A/B/C/D 验证，唯一可生产的 composed flow）
- 🟡 **invoice.issue / relation.onboard 部分就绪**（数据模型在，但 route 校验/AuditLog/sync 有缺口）
- 🔴 **payment / shipping / email 阻断**（数据层 InvoiceAllocation 缺失 / 字段名 bug / 幽灵工具）

### 10.2 关键决策点
- **Agent registry 泛化 vs ERP OS 地基**：泛化引擎是技术前置，但不能压过 ERP readiness。建议 Tier 0-1 优先，Tier 2 可并行但不阻塞 Tier 0。
- **email scope**：email.reply_and_send 需要 postCommitHook，与 P1-A scope 冲突，需产品决策。
- **InvoiceAllocation**：是 payment flow 最硬阻断，1:N 销账是外贸常见场景，必须实现中间表。

### 10.3 下一步
不启动任何 P0 实现代码。按 §9 Tier 0-1 优先级，等 operator 确认实现顺序后逐 flow 推进。
