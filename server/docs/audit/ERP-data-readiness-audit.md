# ERP 数据就绪度审计报告

**Task**: task_mqxv9db3 (ERP-data-readiness-audit)
**审计日期**: 2026-06-28
**审计范围**: Prisma 数据模型 / Demo 种子 / PDML 面料库 / Agent 工具清单 / 实体同步逻辑
**性质**: 仅审计，未修改任何生产代码

---

## 1. 执行摘要

| 维度 | 就绪度 | 说明 |
|---|---|---|
| 数据模型完整性 | ⚠️ 中-高 | 55 个模型覆盖 ERP 全域，金额全 Decimal；但 OS 手动 route mutation（finance/shipping）的业务校验/AuditLog/状态机仍需补齐（route 注释明确'业务校验/字段白名单/审计需要人工补全'） |
| 实体图谱连通性 | ✅ 高 | sync.ts 7 owner × 13 linkKind，EntityReference+EntityLink 双写 |
| Demo 数据丰富度 | ✅ 高 | v2 脚本事务化/幂等/可回滚，保护 PDML 数据 |
| Agent 工具能力 | ⚠️ 中-高 | 57 manifest 工具覆盖 9 domain，但三套体系有漂移风险 |
| PDML 隔离性 | ✅ 高 | Agent 无 pdml.* 工具，写入完全由后端控制 |
| 写入审批治理（Agent 工具侧） | ✅ 高 | Agent high-risk 工具 approval=always + RBAC（owner/admin/manager）。注：OS 手动 route 侧不是同一审批链，不混称 |
| 已知 bug | ⚠️ 1 处 | Shipment sync 字段名不一致（carrier vs forwarder） |

**结论**：ERP 数据层基本就绪，可支撑 Agent flow 验证。建议优先修复 Shipment sync 字段名 bug，统一工具清单三套体系。

---

## 2. Prisma Schema 实体清单（55 models 总计，核心审计覆盖 ~20 个 ERP/Agent 相关模型）

### 2.1 核心 ERP 实体

| 模型 | status 字段 | 金额字段 | 关键 FK |
|---|---|---|---|
| **Order** | `status:String` (Pending/Production/Shipping/Delivered/Alert) | quoteAmount/totalNet?/totalActual? Decimal(18,4) | customerRelationId/millRelationId/billToRelationId (snapshot) |
| **OrderLine** | `status?:String @default("Pending")` | quantity/unitPrice?/netValue? Decimal(18,4) | orderId (Cascade) |
| **Invoice** | `status:String` (Draft/Issued/PartiallyPaid/Paid/Cancelled) | amount Decimal(18,4), currency, exchangeRate? | orderId?/customerRelationId? (snapshot) |
| **PaymentVoucher** | 无（用 type: Receipt/Disbursement） | amount/bankFee/appliedAmount? Decimal(18,4) | invoiceId?/orderId?/customerRelationId? (snapshot) |
| **Shipment** | `status:String` (Draft/Booked/Loading/Shipped/Arrived/Cleared/Delivered/Cancelled) | freightAmount?/insuranceAmount? Decimal(18,4) | orderId?/customerRelationId?/carrierRelationId? (snapshot) |
| **Relation** | 无（deletedAt 软删 + category/type） | creditLimit? Decimal(18,4) | parentId?/reportsToId? (自引用) |
| **DevelopmentCase** | `stage:String` (developing/shipping/feedback/revision/approved/cancelled) | 无（sampleQuantity:Float?） | customerRelationId?/supplierRelationId?/productAssetId? |

### 2.2 实体图谱（Entity Graph）

| 模型 | 角色 |
|---|---|
| **EntityReference** | owner→target 多对多快照引用（snapshot/confidence/source/status） |
| **EntityLink** | 双向关系图（from/to/linkKind/confidence/source/status） |
| **EntityAlias** | 别名归一化（normalized/confidence） |

### 2.3 Agent/审批/审计

| 模型 | 关键字段 |
|---|---|
| **ApprovalRequest** | status(pending/approved/rejected/modified)/risk/payload:Json/decisionNote |
| **AuditLog** | actorId/action/targetType?/targetId?/detail:Json |
| **AgentTool** | scope/risk/inputSchema:Json/status |
| **AgentToolRun** | status/risk/input:Json/output?/error?/approvalId? + actor 快照 |

### 2.4 关键观察
- 金额字段全部 `Decimal(18,4)` / `Decimal(12,3)`，**禁止 IEEE 754 浮点**铁律满足
- 业务实体 status 都是 `String`（应用层约束，非 Prisma enum）
- FK 大量采用 snapshot 风格（不加 `@relation`），避免级联删除

---

## 3. Demo 数据种子评估

### 3.1 v2 脚本（主推）`server/scripts/seed-demo-data-v2.ts`

| 实体 | 记录数 | 说明 |
|---|---|---|
| Relation（组织） | 10 | 3 Customer + 5 Supplier + 1 Agent + 1 Partner |
| Relation（联系人） | 25 | 派生自 contactDefinitions |
| FabricProduct | 8 | 含 Profile/Composition/CustomerCodes/Prices/Certs |
| GarmentProduct | 3 | Blazer/Chino/Bomber |
| TrimmingProduct | 3 | Zipper/Button/Label |
| Order | 10 | DEMO-PO-2601001~1010，覆盖全状态 |
| OrderLine | ~17 | 动态生成 |
| EntityLink | ~50+ | 跨模块关系 |
| DevelopmentCase | 5 | DEV-2026-* |
| Invoice | 6 | Receivable 4 + Payable 2 |
| PaymentVoucher | 4 | Receipt 3 + Disbursement 1 |
| Shipment | 4 | Delivered 2 + Shipped 1 + Loading 1 |
| Insight | 15 | DEMO-INS-* |

**事务与幂等性**：
- ✅ 使用 `prisma.$transaction`
- ✅ apply 前先 rollback 保证幂等
- ✅ 主表 upsert + 子表 createMany
- ✅ Rollback 按 `DEMO-` 前缀 + `tags has DEMO` 双条件
- ✅ **显式排除 PDML-* 记录**，保护面料库

### 3.2 Runbook `server/docs/demo-data-seed-runbook.md`

11 节标准流程：进入服务器 → 加载 env → **备份 PostgreSQL**（强制）→ migrate → dry-run → apply → 验证 → rollback（按需）。

**铁律**：不允许无备份 apply；不允许改 DEMO 前缀；不允许改随机 ID。

**注意**：Runbook dry-run 期望输出（L72-82）仍是 v1 规模，未同步 v2 扩展。

---

## 4. PDML 面料库只读边界

### 4.1 数据流
```
PDML 外部系统 (V_MLXX 视图)
  │ HTTPS POST select SQL (source.ts: fetchPdmlRawRows)
  ▼
PdmlRawFabric 表 (唯一写入点: syncPdmlRawFabricCache)
  │ mapPdmlRawFabricsToProducts
  ▼
ProductAsset + FabricProfile + FabricPriceHistory + ...
```

### 4.2 Agent 流读写边界
- ✅ **Agent 无 pdml.* 工具**——无法直接触发 PDML 同步/映射
- ✅ Agent 仅通过 `products.query/get` 读取**已映射**的面料（id 前缀 `PDML-FAB-*`）
- ✅ PdmlRawFabric 表对 Agent 完全不可读
- ✅ PDML 写入由后端 scheduler（15min）或 OPS 手动触发，与 Agent 运行时隔离

---

## 5. Agent 工具清单（57 manifest / 74 RBAC / 4 P0-B 权威）

### 5.1 三套体系（漂移风险）

| 文件 | 数量 | 角色 |
|---|---|---|
| `toolRegistry.ts` (P0B_TOOL_DEFINITIONS) | 4 | 权威切片（仲裁优先） |
| `mcp/manifest.ts` (ManifestSeed) | 57 | 能力清单（prompt 暴露） |
| `defaults.ts` (DEFAULT_AGENT_TOOLS) | 74 | RBAC（risk/roles/approval） |

**风险**：manifest 通过 `toolDefaults.get(seed.id)?.risk` 从 defaults 拉风险，若某 toolId 只在一边定义会漂移。

### 5.2 P0-B 权威工具（4 个）

| toolId | scope | risk | approval | 说明 |
|---|---|---|---|---|
| products.search | products | low | never | 只读 |
| knowledge.ingest | knowledge | medium | auto | 记 audit 不审批 |
| orders.update_status | orders | high | always | 强制审批 |
| **order.confirm** | orders | high | always | Flow: composedOf=[orders.update_status, finance.create_invoice] |

### 5.3 写入工具（high-risk，approval=always）

finance.create_invoice / finance.create_voucher / finance.apply_voucher_to_invoice / shipping.create_shipment / relations.create / development.convert_to_order / email.send / email.sync 等。

---

## 6. 实体同步逻辑（sync.ts）

### 6.1 覆盖矩阵（7 owner × 13 linkKind）

| sync 函数 | owner | linkKinds |
|---|---|---|
| syncOrderEntityReferences | order | orderedBy/suppliedBy/shipsTo/billTo/handledBy/merchandisedBy/supervisedBy |
| syncDevelopmentCaseReferences | development-case | developFor/developBy/aboutProduct |
| syncOrderLineEntityReferences | orderLine | aboutMaterial/aboutGarment |
| syncRelationEntityReferences | relation.contact | belongsTo |
| syncInvoiceReferences + buildInvoiceReferenceOps | invoice | aboutOrder/billTo |
| syncPaymentVoucherReferences | paymentVoucher | aboutOrder/settlesInvoice/billTo |
| syncShipmentReferences | shipment | aboutOrder/billTo/shipsVia |

### 6.2 设计模式
- 确定性 ID（referenceIdFor/linkIdFor）保证幂等
- upsert 包在 `prisma.$transaction`
- `buildInvoiceReferenceOps` 拆 ops 数组供 commitTransaction 事务内执行（避免嵌套）

---

## 6.5 数据源边界明确区分（审计口径）

> 审计需严格区分三类数据源，不混边界。引用真实入口文件：

| 数据源 | 性质 | 真实入口 | Agent 可见性 | 写入边界 |
|---|---|---|---|---|
| **Demo seed 数据** | 测试注入（可重建） | [seed-demo-data-v2.ts](../../scripts/seed-demo-data-v2.ts)、[seed-demo-data.ts](../../scripts/seed-demo-data.ts) | ✅ Agent 可读写（DEMO-PO-* / DEV-2026-* / INV/PAY 记录） | v2 脚本 apply/rollback，事务化幂等，**排除 PDML-*** |
| **PDML 面料库** | 真实公司数据（只读/受控） | [source.ts](../../src/pdml/source.ts)（fetchPdmlRawRows）、[route.ts](../../src/pdml/route.ts)（syncPdmlRawFabricCache/mapPdmlRawFabricsToProducts）、[pdml-fabric-import.mjs](../../../scripts/pdml-fabric-import.mjs)（离线工具） | ⚠️ 仅已映射的 ProductAsset（PDML-FAB-*）可读；PdmlRawFabric 表不可读 | 后端 scheduler(15min) 或 OPS 手动触发，**Agent 无 pdml.* 工具** |
| **样品发票模板** | 真实业务参考（渲染参考，非数据源） | [invoice/fabric-sample.ts](../../src/templates/invoice/fabric-sample.ts)、[invoice/pdas-sample.ts](../../src/templates/invoice/pdas-sample.ts)、[render.ts](../../src/templates/render.ts)、[route.ts](../../src/templates/route.ts) | ✅ Agent 可通过 template.render/render_pdf 调用 | 纯函数渲染（data→html），不写 DB；store.ts 持久化 RenderedDoc |

**关键区分**：
1. **Demo seed** = 测试用可注入数据，v2 脚本覆盖 10 订单/6 发票/4 凭证/4 运单/5 开发单，**可随时 rollback 重建**
2. **PDML 面料库** = 真实公司面料数据，Agent **只读**已映射部分，原始数据（PdmlRawFabric）对 Agent 不可见，写入完全由后端控制
3. **样品发票模板** = fabric-sample（面料商业发票）+ pdas-sample，是**渲染模板参考**（真实业务发票格式），不是数据源——Agent 通过 template.render 生成文档，不修改模板本身

---

## 7. ⚠️ 已知问题与建议

### 7.1 BUG: Shipment sync 字段名不一致
- **位置**: [sync.ts L625](../../src/entities/sync.ts#L625) vs [schema.prisma Shipment L1408-1409](../../prisma/schema.prisma#L1408-L1409)
- **问题**: `syncShipmentReferences` 使用 `forwarderRelationId/forwarderName`，但 Prisma schema Shipment 模型字段是 `carrierRelationId/carrierName`（schema.prisma L1408-1409）
- **影响**: shipsVia link 可能永远不生成
- **建议**: 修复 sync.ts 字段名，或确认 Shipment 路由写入时是否做了字段映射

### 7.2 工具清单三套体系漂移风险
- **问题**: toolRegistry(4) / manifest(57) / defaults(74) 三套，manifest 从 defaults 拉 risk 可能漂移
- **建议**: 建立 toolId 单一真源，或加 CI 校验三套一致性

### 7.3 Runbook 未同步 v2 规模
- **问题**: demo-data-seed-runbook.md dry-run 期望输出仍是 v1 规模
- **建议**: 更新 runbook 的期望输出数字

### 7.4 InvoiceAllocation 未实现
- **现状**: schema 注释提到 1:N 销账暂不支持，PaymentVoucher.appliedAmount 只表达单笔
- **建议**: 后续 payment.receive_and_reconcile flow 需评估是否需中间表

---

## 8. 结论

ERP 数据层**基本就绪**，可支撑 Agent flow 验证：
- ✅ 数据模型覆盖较全（55 models，金额 Decimal）；但 OS 手动 mutation 的业务校验/AuditLog/状态机仍需补齐
- ✅ 实体图谱连通（7 owner × 13 linkKind）
- ✅ Demo 数据丰富（v2 事务化/幂等/可回滚）
- ✅ PDML 完全隔离（Agent 无写入能力）
- ⚠️ 需修复 Shipment sync 字段名 bug
- ⚠️ 需统一工具清单三套体系

**下一步**：Agent-flow-dependency-matrix（task_mqxv9giu）将梳理 Agent flow 对数据的依赖关系。
