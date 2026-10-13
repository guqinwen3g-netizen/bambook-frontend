# MOQ 最小起订量规则

> **PRD 关联**：§9.1 MOQ 最小起订量（两档 + Capsule 豁免标记 + 分级豁免）
> **落地状态**：❌ 未接入（MOQ 阈值字段在 FabricProfile/GarmentProfile 中存在，但订单行/报价行保存路径未校验）
> **DR-003 关联**：Capsule 不是独立 MOQ 档位，而是服装订单的 MOQ 豁免标记（业务员可直接勾选，不要求理由或额外审批）

---

## §1 元信息与实现状态

| 维度 | 内容 |
|------|------|
| 定位 | 两档业务线 MOQ 校验（面料/成衣）+ Capsule MOQ 豁免标记（DR-003）+ 分级豁免审批链，防止低量接单侵蚀毛利 |
| 触发入口 | OrderLine 保存（新增/编辑）/ QuotationLine 保存（新增/编辑）/ Quotation→Order 转换（convertToOrder） |
| 角色（校验受影响） | 销售/跟单/运营/管理层/老板（豁免审批人链按等级） |
| 范式 | 规则型：§6 触发矩阵 |
| 优先级 | P1（非致命但影响业务健康，上线后首批接入） |
| **落地状态** | ❌ **未接入门禁** / ❌ **Capsule 豁免字段待新增**（Order 模型需新增 `capsuleExemption` Boolean 字段 + `capsuleExemptionBy` + `capsuleExemptionAt`） |
| 存在的字段真源 | `schema.prisma:627-629` FabricProfile.moqValue（面料）/ factoryMoqValue / sampleMoqValue；`schema.prisma:700` GarmentProfile.moq（成衣，String 需归一化）；`schema.prisma:760` TrimmingProfile.moq（辅料） |
| 未实现代码位置（缺口） | `server/src/quotations/quotationService.ts` createQuotation/updateQuotation/convertToOrder 三处 Line 写入未校验；OrderLine CRUD 路由未校验；前端 OrderManager/QuotationManager LineEditor 组件无 badge/block UI |
| PRD 关联 | §9.1 MOQ 三档 / §9.2 审批链框架（复用 ApprovalRequest 模型 schema.prisma:1807-1828） |

---

## §2 两档 MOQ 阈值（系统配置可调，非写死） + Capsule 豁免标记

### 2.1 MOQ 档位定义（配置真源：MoqThresholdConfig 模型，Admin 可在设置后台调整）

| 档位 | 业务线 businessLine | MOQ 阈值（seed 默认值，非写死） | 单位 | 取数真源说明 | 备注 |
|------|-------------------|-------------------------------|------|-------------|------|
| 面料档 | fabric | **fabricDefaultMoq**（seed 默认 800，可被 factoryMoqValue / 客户协议 / 行级 override 覆盖） | 米（M / meter） | MoqThresholdConfig.fabricDefaultMoq（Admin 可调）+ FabricProfile.moqValue（产品档案标准）+ factoryMoqValue（工厂合同特殊） | 面料散剪损耗大，低于面料档阈值工厂通常加价 15-20%（提示文案，不作为硬规则） |
| 成衣档 | garment | **garmentDefaultMoq**（seed 默认 200，可被 factoryMoqValue / 客户协议 / 行级 override 覆盖） | 件（PCS / PC） | MoqThresholdConfig.garmentDefaultMoq（Admin 可调）+ GarmentProfile.moq（产品档案标准） | 含首件 + 尺码套；低于成衣档阈值单件工费显著上升（提示文案，不作为硬规则） |
| Capsule 档（DR-003 豁免子集） | garment + capsuleExemption=true | **capsuleMoq**（seed 默认 20，Capsule 专用最低阈值，Admin 可调） | 件（PCS / PC） | MoqThresholdConfig.capsuleMoq（Admin 可调） | 勾选 Capsule 豁免后从成衣档降级为 Capsule 档，不是完全无 MOQ；低于 Capsule 档阈值仍需 MOQ 豁免审批 |

> **DR-003**：Capsule 不是独立 MOQ 档位。Capsule 与服装大货共用同一订单模型、字段、状态机、生产链和单据链；不得创建独立模块或独立流程。

### 2.2 Capsule MOQ 豁免标记（DR-003）

| 项 | 说明 |
|---|---|
| 本质 | Capsule 是服装订单的 MOQ 豁免标记（从成衣档阈值降级为 Capsule 档阈值），不是独立业务线或完全豁免无 MOQ |
| 操作 | 业务员在订单录入时直接勾选 `capsuleExemption`；不要求理由或额外审批 |
| 效果 | 勾选后该订单的 MOQ_effective 从 garmentDefaultMoq（默认200）降级为 capsuleMoq（默认20）；< capsuleMoq 仍需审批 |
| 审计 | 勾选须记录操作者（`capsuleExemptionBy`）与时间（`capsuleExemptionAt`） |
| 模型边界 | Capsule 订单与普通服装订单共用同一 Order 模型、状态机、生产链和单据链 |

### 2.3 MOQ 规则版本治理（配置变更留痕）

`MoqThresholdConfig` + `MoqThresholdConfigHistory`（append-only，无软删）双模型实现：
- 当前生效配置：`MoqThresholdConfig` 只保留 **1 条 isActive=true** 的记录（DB 层有唯一性约束：`@@unique([isActive]) WHERE isActive = true`），effectiveFrom 标记生效时间
- 历史配置：每次管理员调整时，旧 isActive=true 记录翻为 false + append 一条 `MoqThresholdConfigHistory`（记录 before/after/fabricDefaultMoq/garmentDefaultMoq/capsuleMoq/changedBy/changeReason/changedAt）
- **不追溯原则（默认 true）**：订单创建时写入 `Order.moqSnapshot`（writeOnce 不允许更新），已 Confirmed 订单按 snapshot 口径执行 MOQ，不受后续后台配置调整影响

### 2.4 MOQ 取数优先级（高→低，命中即返回）

0. **Order.capsuleExemption = true** → 从成衣档阈值降级为 Capsule 档阈值（capsuleMoq），但仍需与 Capsule 档比较（不是完全豁免）
1. Order/Quotation 行级 override（用户手工填 `moqOverride`，需审批人备注 + 权限 scope: `moq:line_override`）
2. Relation/Customer 级别 MOQ 协议（长期客户年框价约定的特殊 MOQ，存 CustomerTier.moqOverrideRatio 或独立 JSON blob，例：Platinum Tier 面料 MOQ 打 7 折）
3. 工厂 factoryMoqValue（面料厂/服装厂与我方签订的实际起订量，FabricProfile.factoryMoqValue / GarmentProfile.factoryMoqValue）
4. 产品档案标准 MOQ（FabricProfile.moqValue / GarmentProfile.moq）
5. **MoqThresholdConfig 系统配置档**（Admin 在设置→业务规则→MOQ阈值配置面板动态调整：fabricDefaultMoq / garmentDefaultMoq / capsuleMoq）
6. **兜底代码内写死常量**（仅当 MoqThresholdConfig 未初始化或 DB 故障时的 last resort：面料800 / 成衣200 / Capsule20；触发时 Toast「MOQ 配置加载失败，使用默认兜底阈值」并告警管理层）

> ⚠️ 第 5 步是 Admin 可配置的主入口，不是写死常量。800/200/20 仅为 seed 脚本初始化时的默认值，管理员随时可在后台改。

---

## §3 MOQ 豁免审批机制（决策点 3-A · DR-007 统一路由，缺口比例仅展示参考）

> 豁免 = 实际下单量 < MOQ_effective，但经有权审批人批准后可放行。豁免缺口比例 = (MOQ_effective - 实际量) / MOQ_effective。
>
> **决策点 3-A · DR-007 去阈值声明**：缺口比例仅作为视觉参考信息展示（黄/红 Badge 分层 + ApprovalRequest.payload 携带），**不决定审批人路由，也不影响审批人数（单人单次即通过）**。所有豁免单统一走 DR-007 服务端解析 reviewerId：豁免申请人所属部门主管 → 无主管/申请人属财务部/其他兜底条件 → 系统管理员（总领导 ADMIN）兜底。
>
> **DR-003 例外**：Capsule 豁免（勾选 `capsuleExemption`）不走本审批链——业务员直接勾选即可从成衣档阈值降级为 Capsule 档阈值，不要求理由或额外审批；仅须记录操作者与时间。降级后若实际量 < Capsule 档阈值（默认20件），此时**仍需走本 MOQ 豁免审批链**（不是完全无 MOQ）。

| 豁免缺口比例区间（仅视觉分层参考，不决定审批人） | UI 视觉分层 | 审批人（路由与比例无关，统一 DR-007） | 审批人数 |
|--------------------------------------------|-----------|-----------------------------------|---------|
| 0% ~ 50% 缺口（轻度，接近合规） | ⚠️ 黄 Badge | resolveReviewerByDepartment(申请人) = 部门主管 → 无则 ADMIN 总领导兜底 | **单人单次**（无需 S/D/老板三级区分，符合 DR-007） |
| 50% ~ 80% 缺口（中度，显著偏离） | 🔴 红 Badge | 同上（与 0-50% 审批人相同，DR-007 统一） | 同上 |
| >80% 缺口（重度，原则上不建议接单） | 🔴 深红 Badge + 弹窗二次确认提示「豁免比例极高，是否仍申请」 | 同上（与前两档审批人相同，DR-007 统一；如需老板特批，由部门主管手动转派或 escalate，非规则自动路由） | 同上 |

**审批单统一生成规则**（复用 ApprovalRequest，actionType = `order:moq-exemption` / `quotation:moq-exemption`）：
- policyKey = `'moq_exemption'`，hitConditions 数组携带命中信息：`['fabric_default_moq' | 'garment_default_moq' | 'capsule_moq', 'gap_lt50pct' | 'gap_50_80pct' | 'gap_gt80pct']`
- reviewerId **服务端解析**：`approvalService.createRequest` 中兜底 `resolveReviewerByDepartment(requesterId)`，前端不传 reviewerId（兼容期前端传了会覆盖；后续移除选择框）
- 单人单次：审批人 approve / reject 即可完结，无需多人会签

**Confirmed 门禁阻断时自动发起豁免审批单**（✅ 2026-08-19 收口，orderServiceV2.ts）：
- Order 状态推进至 Confirmed 时执行 `moqValidationService.validateCreate({..., autoCreateApproval: true, targetType: 'Order', targetId})`；低于 MOQ 且无 approved 豁免单 → 阻断同时**自动发起 MOQ 豁免审批单**（DR-007 单人单次），业务员无需另行寻找豁免入口
- 阻断错误消息携带审批单状态提示：自动发起成功 → 「豁免审批单 {id} 已自动发起，审批通过后重试」；发起失败 → 「请联系管理员」（fail-closed：门禁校验异常同样阻断推进，不静默放行）

**DR-007 单人单次防重（幂等）**（✅ 2026-08-19 收口，approvalCreateService.ts）：
- 同 requester + actionType + targetId 已存在 status=pending 的审批单 → **幂等返回既有单**，不再重复创建；修复前每次门禁重试都会建新单，导致同一豁免诉求出现多张挂起单
- 防重维度不含 targetType（actionType 已区分订单/报价豁免），approved/rejected 历史单不拦截新申请

---

## §4 UI 反馈规范

### 4.1 行级实时反馈（LineEditor 行内）

| 场景 | 视觉 | 交互 |
|------|------|------|
| 实际量 ≥ MOQ_effective | 默认态（无额外 badge） | — |
| Order.capsuleExemption = true | 行尾 ℹ️ 蓝 Badge：「Capsule 档 MOQ（实际取 capsuleMoq 系统配置值）」+ tooltip 显示操作者与时间；若当前数量仍 < Capsule 档阈值，自动叠加黄/红 Badge | 不可点击（仅信息展示），取消勾选后恢复成衣档 MOQ_effective 计算 |
| 实际量 < MOQ_effective 且缺口 ≤ 50%（轻度，仅视觉分层） | 行尾 ⚠️ 黄 Badge：「低于 MOQ（缺口 ××%），需审批豁免」 + tooltip 说明「审批人由服务端按组织归属 DR-007 解析」 | 点击 Badge → 弹出豁免申请 Sheet（预填缺口比例/原因占位，审批人字段只读展示解析结果或加载中占位，前端不可选） |
| 实际量 < MOQ_effective 且缺口 > 50%（中度及以上，仅视觉分层） | 行尾 🔴 红 Badge：「低于 MOQ（缺口 ××%），需审批豁免」 + 整单 block 逻辑（见 4.3） | 同上方黄 Badge（审批人与缺口比例无关，统一 DR-007；Badge 颜色仅视觉提示严重度） |
| 缺口 >80%（重度，仅视觉加弹窗二次确认） | 同红 Badge，文案尾部追加「⚠️ 豁免比例极高」 | 点击 Badge 申请 Sheet 弹出前追加一次确认：「该订单行 MOQ 豁免缺口 ××%（重度偏离），确认仍提交豁免申请？」确认后进入 Sheet；不改变审批人路由 |

### 4.2 Capsule 豁免勾选（订单录入表单）

| 项 | 说明 |
|---|---|
| 位置 | 订单录入表单头部区域，紧邻业务线选择 |
| 控件 | Checkbox：「Capsule 订单（MOQ 降级为 Capsule 档）」 |
| 交互 | 勾选后 MOQ_effective 从 garmentDefaultMoq（默认200件）降级为 capsuleMoq（默认20件）；行级 Badge 自动重算；降级后仍 < capsuleMoq 需按本文件走 MOQ 豁免审批（不是完全无 MOQ）；取消勾选恢复成衣档标准 MOQ_effective 计算 |
| 审计 | 勾选/取消勾选均记录操作者与时间（`capsuleExemptionBy` / `capsuleExemptionAt`） |

### 4.3 整单 block 规则

- **Quotation**：任意一行处于红/黄 Badge 且无 status=approved 的对应豁免审批单 → `sendQuotation`（Draft→Sent）按钮禁用
- **Order**：任意一行处于红/黄 Badge 且无 status=approved 的对应豁免审批单 → Order Confirmed 状态转换按钮禁用；必须先完成豁免审批（DR-007 单人单次审批通过即可）

---

## §6 触发矩阵（触发条件 × 动作 × 门禁 × 异常分支）

| # | 触发条件 | 动作 | 门禁（Gate） | 异常分支（Fail-Closed） |
|---|---------|------|-------------|----------------------|
| 0 | Order.capsuleExemption 变更（勾选/取消勾选） | 记录 `capsuleExemptionBy` + `capsuleExemptionAt` + AuditLog | 仅成衣订单（businessLine=garment）可勾选；面料订单无此字段 | 非成衣订单尝试勾选 → 403 拒绝 + Toast「Capsule 豁免仅适用于服装订单」 |
| 1 | OrderLine 保存（新增/编辑）：quantity < MOQ_effective 且 Order.capsuleExemption ≠ true | ① 行级黄/红 Badge ② 计算缺口比例 ③ 按比例插入 ApprovalRequest | 缺口 >50% 且无对应 ApprovalRequest.status=approved → 整单保存按钮 block | 审批请求创建失败（DB 事务异常）→ 回滚行保存 + Toast 「MOQ 校验失败，请重试或联系管理员」 |
| 2 | QuotationLine 保存（新增/编辑）：quantity < MOQ_effective | 同上 | 缺口 >50% 且无批准 → sendQuotation 门禁阻断（类似价格偏差 block） | 同上 |
| 3 | convertToOrder：QuotationLine→OrderLine 转移，源行已有 approved MOQ 豁免 | 复制 approval 引用至 Order 行快照（JSON blob：moqExemptionApprovalId），**不重复触发审批** | 源行豁免审批过期/被撤销 → convertToOrder 抛出异常中止转换 | 审批人离职/权限被回收 → 原豁免失效，需重新申请 |
| 4 | MOQ 豁免申请发起（任意缺口比例） | 创建 ApprovalRequest（policyKey='moq_exemption'，payload 携带缺口比例仅参考）→ reviewerId 服务端 DR-007 解析 → 单人 approve/reject 完结 | 审批人 resolveReviewerByDepartment 返回空 → fallback ADMIN 总领导兜底；并发冲突报错 | ApprovalRequest 审批 72h 未处理 → 管理层 Toast 提醒（不自动升级审批人，符合 DR-007 单人单次原则） |
| 5 | DR-007 解析审批人批准/驳回 | reviewerId 对 ApprovalRequest 做 approved/rejected → 解锁/驳回豁免申请 | 审批人权限校验（scope: `approvals:act:moq_exemption` 且当前用户 ID === reviewerId）→ 403 拒绝 | 审批人离职/权限被回收 → 管理员手动重新指派 reviewerId 或 申请人重提（不走自动 escalate） |
| 6 | 重度缺口 >80% 二次确认 | 前端点击 Badge 申请 → 弹窗二次确认（「缺口比例极高，确认提交？」）→ 确认后与其他缺口走同一流程 | 用户取消二次确认 → 不发起审批 | 已发起审批单不因缺口比例变更而自动取消（订单变更后缺口变化场景由 §X MOQ 变更后重算联动处理） |
| 7 | MOQ_effective 变更（产品档案 MOQ 事后修改） | **不追溯**（已确认订单/已发送报价按原 MOQ 快照执行），仅影响新创建的行 | 已 Confirmed 订单行被修改 MOQ → AuditLog 高风险标记 + 管理层通知 | 追溯策略误触发（把老订单按新 MOQ block）→ 由开关 `MOQ_GRAND_FATHER_ENABLED` 控制，默认 true 不追溯 |
| 8 | Order 状态推进至 Confirmed（服务端门禁，✅ 已落地） | validateCreate 携带 `autoCreateApproval: true` → 低于 MOQ 且无 approved 豁免单时自动发起 MOQ 豁免审批单（DR-007 防重幂等），错误消息携带审批单提示 | Confirmed 推进被阻断（MOQ_VIOLATION），豁免审批通过后重试放行 | 门禁校验自身异常（DB/服务故障）→ fail-closed 同样阻断推进，不静默放行 |

---

## §X MOQ 变更后重算（订单变更门禁 · 决策点 6-A fail-closed）

> **决策点 6-A（fail-closed）**：订单确认后（status=Confirmed 及以上）的数量变更必须重新校验 MOQ。数量减少导致跌破 MOQ 阈值时，**fail-closed 阻断保存**，自动生成 MOQ 豁免审批单；审批通过后方可写入。三档均适用（面料系统配置值（seed 默认 800）/ 成衣系统配置值（seed 默认 200）/ Capsule 系统配置值（seed 默认 20））。

### X.1 触发条件

| 触发项 | 规则 |
|--------|------|
| 变更字段 | `OrderLine.qty` 或 `Order.totalQty` 发生变更（无论通过 `OrderPatch` 还是 `Order.update` 路由） |
| 订单状态前置条件 | 变更后 `Order.status ∈ {Confirmed, Production, Shipping}` 任一（草稿/已取消订单不触发） |
| Capsule 豁免 | `Order.capsuleExemption = true` → 成衣档 MOQ 跳过，但仍需校验 Capsule 档阈值（§2.1 第三行）；本段逻辑对 Capsule 档**同样生效**（即 Capsule 数量变更 < Capsule 档阈值时仍触发豁免） |
| 校验取数逻辑 | 与「§2.4 优先级 0→6」一致；**优先使用 Order.moqSnapshot**（同单变更不重新拉配置，保证同一订单生命周期内 MOQ 口径一致）；仅当 Order.moqSnapshot 缺失（兼容旧单）时回退当前 MoqThresholdConfig |

### X.2 正向场景（数量减少，可能跌破 MOQ）→ fail-closed 阻断

**判定公式**：`变更前数量 > MOQ_effective ≥ 变更后数量`

| 动作 | 说明 |
|------|------|
| ① 阻断保存 | `orderService.validatePatch` 返回 `{ blocked: true, approvalRequestId: 'APR_xxx' }`，写库操作**不执行**（fail-closed） |
| ② 自动生成 ApprovalRequest | `policyKey='moq_exemption'`，`reason='qty_change_below_moq'`，`payload={ beforeQty, afterQty, moqEffective, businessLine, hitGap: '正向跌破', snapshotRef: Order.moqSnapshot.configId }` |
| ③ reviewerId 解析 | 服务端 `resolveReviewerByDepartment(变更发起人userId)`（DR-007：部门主管 → 无则 ADMIN 总领导兜底；单次一位即可） |
| ④ 前端 UI 引导 | 前端弹窗「变更后数量 {xxx} 低于 {businessLine} MOQ {yyy}（取 snapshot 值），需 MOQ 豁免审批」并内嵌审批卡片（支持一键跳转审批详情） |
| ⑤ 审批通过后行为 | ApprovalRequest.status=approved → 回调重新调用 Order.update/Patch → 本次变更**正式写入** DB + AuditLog 留痕 |

### X.3 反向场景（数量增加，变为合规）→ 自动取消挂起的 MOQ 审批单

**判定条件**：变更前该订单挂着 `ApprovalRequest.status='Pending'` 且 `policyKey='moq_exemption'` 且 `reason='qty_change_below_moq'`（= 因之前数量减下来挂起的豁免单）

| 动作 | 说明 |
|------|------|
| ① 自动取消审批单 | `ApprovalRequest.deletedAt = now()`（软删）+ `ApprovalRequest.status = 'Cancelled'` |
| ② 变更直接写入 | 本次数量增加变更**直接写入** DB（不再需要审批，因为数量变多更合规） |
| ③ 已 Approved 不回退 | 若审批单已经是 `Approved` 状态 → **不回退**，保留留痕（审计轨迹不逆向删除） |

### X.4 三档均适用（与业务线解耦）

本 §X 逻辑对三档 MOQ 全部生效：

| 档位 | businessLine | MOQ_effective | 备注 |
|------|-------------|--------------|------|
| 面料档 | fabric | 系统配置值（seed 默认 800m，取 Order.moqSnapshot.fabricDefaultMoq，可被 factoryMoqValue/CustomerTier 协议覆盖） | |
| 成衣档 | garment | 系统配置值（seed 默认 200 件，取 Order.moqSnapshot.garmentDefaultMoq，可被 factoryMoqValue/CustomerTier 协议覆盖） | |
| Capsule 档 | garment + capsuleExemption=true | 系统配置值（seed 默认 20 件，取 Order.moqSnapshot.capsuleMoq） | 勾选 capsuleExemption 后从成衣档降级为 Capsule 档，仍走本段变更重算；< Capsule 档阈值仍需豁免审批 |

### X.5 服务端实现位置（落点）

| 模块 | 函数/位置 | 触发时序 | 返回契约 |
|------|----------|---------|---------|
| `orderService.validatePatch` | MOQ 校验子模块（**在 validateAccess 之后、写库之前触发**） | OrderLine/Order 更新路由进入写事务前 | `{ blocked: boolean, approvalRequestId?: string }`；blocked=true 时前端弹窗引导审批 |
| 复用函数 | `calculateEffectiveMoqByLine(orderLineId)` → 取数优先级 0→6 层（同 §2.4，优先 Order.moqSnapshot） | 重算 MOQ_effective 时调用 | `{ moqValue, unit, sourceTier, capsuleActive, snapshotRef }` |
| 联动函数 | `cancelPendingMoqExemptionIfAny(orderId)` | 反向场景（数量增加）时调用 | `{ cancelledCount: number }` |

---

## §11 业务规则关联（与 22 条规则交集）

| 规则 | 关联点 |
|------|--------|
| §9.2 价格审批-低于成本价 | MOQ 豁免通常伴随加价（豁免后工厂加 15-20%），加价后单价仍低于成本价 → 叠加触发价格审批 ④ |
| §9.7 订单变更-数量 | 变更后 quantity 跨 MOQ 阈值（原本 ≥MOQ 变 <MOQ，或豁免比例升级）→ 按变更后量级重新走 MOQ 豁免审批 |
| §9.4 信用控制-Tier 权益 | Platinum/VIP Tier 客户可配置 MOQ 打 7 折（如面料 800m→560m），在 MOQ 取数优先级第 2 步 Customer Tier 协议层生效 |

---

## §14 待补设计缺口（当前全部 ❌）

| P | 缺口 | 细化位置 |
|---|------|---------|
| P0 | Order 模型新增 `capsuleExemption` Boolean + `capsuleExemptionBy` String + `capsuleExemptionAt` DateTime 字段（DR-003） | server/prisma/schema.prisma Order 模型 |
| P0 | Order/Quotation 模型新增 `moqSnapshot` Json 字段（非空 `@default('{}')`，服务端创建时 writeOnce 填充：{ fabricDefaultMoq, garmentDefaultMoq, capsuleMoq, snapshotAt, configId }） | server/prisma/schema.prisma Order + Quotation 模型 |
| P0 | 新增 Prisma 模型 **MoqThresholdConfig**（主键 `MOQCFG__${shortId}`，isActive+effectiveFrom 索引）+ **MoqThresholdConfigHistory**（append-only 无软删，主键 `MOQHIST__${shortId}`） | server/prisma/schema.prisma 底座域（与 SystemConfig 同组） |
| P0 | 部署脚本 seed 一条初始 MoqThresholdConfig（fabricDefaultMoq=800 / garmentDefaultMoq=200 / capsuleMoq=20，isActive=true） | server/prisma/seed.ts 或独立 seed 脚本 |
| P0 | MOQ 校验服务 moqService.ts（含取数优先级 0→6 层 + Capsule 豁免第 0 层降级到 Capsule 档阈值 + 优先 Order.moqSnapshot 不重新拉配置） | server/src/orders/ 下新增（或 server/src/shared/moqService.ts 供订单/报价双向复用） |
| P0 | OrderLine/QuotationLine 保存路由接入 MOQ 门禁（fail-closed，含 Capsule 降级检查 + Order.moqSnapshot 创建时 writeOnce 写入） | quotationService.ts createQuotation/updateQuotation/convertToOrder + Order CRUD route |
| P0 | Settings 后台「MOQ阈值配置」Tab：3 个配置项 X-Input + 保存弹窗（changeReason 必填 5 字以上）+ 变更历史表格 + `requireRole('SUPER_ADMIN','ADMIN')` 守卫（scope: settings:moq:write / read） | 后端：`server/src/routes/moqConfig.ts`；前端：`components/Settings.tsx` 新增 `moqThresholds` Tab 子组件 |
| P1 | 前端 LineEditor 行级 Badge（黄/红仅视觉分层，不决定审批人）+ 豁免申请 Sheet UI（审批人不可选，由服务端解析）+ Capsule 勾选框（勾选后 < Capsule 档阈值仍 block） | components/OrderManager/* + components/QuotationManager/* |
| P1 | ApprovalRequest actionType 扩展 `order:moq-exemption` / `quotation:moq-exemption`；policyKey = `moq_exemption`；reviewerId 统一走 `resolveReviewerByDepartment`（DR-007），前端不传 | server/src/approvals/ approvalPolicy（当前 manual always，需升级为规则驱动的 DR-007 解析器） |
| P2 | 不追溯开关 + 事后产品档案/MoqThresholdConfig 变更 AuditLog 高风险通知（管理层 Toast 推送）+ 审批超时 72h Toast 提醒（不升级审批人） | 配置项 DataDictionary.business_rule_flags；复用 RiskAlert 或独立通知 |

---

## §15 MOQ 全链路验收场景矩阵（MoqThresholdConfig 可调 + DR-003 Capsule 豁免 + DR-041 角色权限）

> **决策来源**：[DR-003](../10-评审与决策/2026-08-16-设计评审决策记录.md#dr-003-capsule-是服装订单的-moq-豁免) / [DR-041](../10-评审与决策/2026-08-16-设计评审决策记录.md#dr-041-业务权限采用-7-宽泛容器角色-技术与业务边界清晰)

### 15.1 MoqThresholdConfig 配置可调验收（Admin 写配置 + seed 初始化 + 历史留痕）

| 验收编号 | 场景描述 | 前置条件 | 执行步骤 | 期望结果 | 失败路径 / 约束 |
|---------|---------|---------|---------|---------|----------------|
| MOQ-CFG-A1 | 系统首次部署 seed 初始化一条 isActive=true 的 MoqThresholdConfig | 1. 空数据库（或无 MoqThresholdConfig 数据）；2. 执行部署 seed 脚本 | 1. 运行 `prisma db seed` 或独立初始化脚本；2. 查询 MoqThresholdConfig 表 | 1. 有且仅有 1 条 `isActive=true`；2. fabricDefaultMoq=800 / garmentDefaultMoq=200 / capsuleMoq=20；3. effectiveFrom ≈ now；changedBy='SYSTEM_SEED'；changeReason='初始部署默认值' | 若重复运行 seed → 不得创建重复 isActive=true 行，`@@unique([isActive]) WHERE isActive=true` 唯一约束应拦截，idempotency 需保证 |
| MOQ-CFG-A2 | 管理员（系统管理员 / 超级管理员容器，DR-041）调整 MOQ 阈值并留痕 | 1. 当前 isActive 记录存在；2. 登录角色=系统管理员（总领导）或超级管理员（老板）；3. Settings 后台 MOQ 阈值配置面板可用 | 1. 修改 fabricDefaultMoq 为 900、garmentDefaultMoq 为 250、capsuleMoq 为 25；2. changeReason 填写「根据二季度客户反馈调整」（≥5 字）；3. 点保存 | 1. 旧 isActive=true 行 → isActive=false，effectiveTo=now；2. 新增 1 条 MoqThresholdConfig（isActive=true，新 3 值 + effectiveFrom=now）；3. 新增 1 条 MoqThresholdConfigHistory（before/after 对比 + changedBy=当前用户 ID + changeReason + changedAt）；4. 前端 Toast「MOQ 阈值已更新，对未 Confirmed 订单自下次保存生效（不追溯）」 | changeReason 不足 5 字 → 拒绝保存；非 DR-041 管理员容器 → 403 scope:settings:moq:write 拦截 |
| MOQ-CFG-A3 | 非管理员容器角色（业务员、销售主管、财务、QC、后勤）访问 MOQ 配置写端点被 DR-041 守卫拦截 | 1. 登录角色分别为业务员/销售主管/财务/QC/后勤（6 容器中任一个非管角色）；2. 对 Settings 后台 `POST /settings/moq-thresholds` 发起请求 | 1. 构造请求修改阈值；2. 发送至后端 | 1. 返回 403 Forbidden，错误码=SCOPE_DENIED；2. MoqThresholdConfig 无变更；3. 审计日志记录越权尝试（角色、ID、路径、时间） | 不得以任何 UI 灰显作为唯一防线（服务端守卫 fail-closed） |
| MOQ-CFG-A4 | MOQ 阈值调整后：已 Confirmed 订单按 snapshot 口径（不追溯），Pending 订单下次保存按新配置 | 1. 有订单 A（Confirmed，已写 moqSnapshot={garmentDefaultMoq:200}）；2. 有订单 B（Pending，已有 moqSnapshot 写旧 garmentDefaultMoq=200）；3. 管理员将 garmentDefaultMoq 改为 250（A2 场景）；4. 业务员编辑订单 B 的 OrderLine | 1. 对订单 A 查询 MOQ_effective；2. 保存订单 B 的 OrderLine 触发 MOQ 校验 | 1. 订单 A MOQ_effective=200（快照不变，不追溯）；2. 订单 B moqSnapshot 为 writeOnce，不得被覆盖；但 MOQ 校验使用当前配置（新 250）并显示「MOQ 配置于 YYYY-MM-DD 已变更，本单仍为 Pending 将按新口径校验，Confirmed 后才冻结」；或按§2.3 约定 Pending 也写 snapshot——结果需在文档与实现一致（建议：Pending 未冻结允许下次保存用新值，保持"订单确认时 snapshot writeOnce"） | 已 Confirmed 订单任何时候不得重算 moqSnapshot；写入 moqSnapshot 后更新路径 fail-closed 拒绝变更 |
| MOQ-CFG-A5 | MoqThresholdConfig 表为空（DB 故障/未初始化）→ 兜底常量（last resort）触发告警 | 1. 人为清空 MoqThresholdConfig；2. 业务员创建新订单保存 | 1. 创建 Order 并保存；2. 查询 Order.moqSnapshot；3. 查看系统告警 | 1. 保存不失败（兜底常量生效）；2. moqSnapshot.configId=null，并写入 `fallback: true, fabricDefaultMoq:800, garmentDefaultMoq:200, capsuleMoq:20`；3. Trigger 高优先级告警给超级管理员（老板）+ 系统管理员（总领导），Toast 给当前用户「MOQ 配置加载失败，使用默认兜底阈值，请联系管理员」 | 不得将兜底常量作为常态路径；兜底触发必须审计且可观测 |

### 15.2 MOQ 取数优先级 0→6 层与 Capsule 豁免（DR-003）验收

| 验收编号 | 场景描述 | 前置条件 | 执行步骤 | 期望结果 | 失败路径 / 约束 |
|---------|---------|---------|---------|---------|----------------|
| MOQ-DR3-B1 | 成衣订单未勾选 Capsule → MOQ_effective=garmentDefaultMoq（默认 200），按 200 校验 < 200 拦截并触发豁免审批入口 | 1. Order.type=Garment，capsuleExemption 未勾选；2. OrderLine 数量=150 PCS；3. 无行级 override / 客户协议 / 工厂特殊 MOQ | 1. 保存 OrderLine | 1. 校验失败（150 < 200）；2. 前端弹出「低于 MOQ，需申请豁免」入口（Badge 缺口 25% 黄色）；3. 无法直接推进到 Order.status=Confirmed，必须先申请并通过豁免审批 | Order.status=Confirmed 路径 fail-closed：无豁免审批单已通过 → 拦截 |
| MOQ-DR3-B2 | 成衣订单勾选 Capsule → MOQ 从 garmentDefaultMoq（200）降级为 Capsule 档（20），无需审批即可勾选本身（DR-003 业务员直接勾） | 1. Order.type=Garment；2. 登录=业务员（DR-041 业务员容器，含跟单）；3. 订单数量=30 PCS | 1. 业务员在订单录入表单勾选 Capsule 豁免；2. 保存订单（非 Confirmed） | 1. capsuleExemption=true；capsuleExemptionBy=当前用户 ID；capsuleExemptionAt=now；2. MOQ_effective 降级为 20；3. 30 ≥ 20，MOQ 合规，无 Badge 无豁免审批；4. 未要求理由或额外审批（DR-003） | 勾选 Capsule 后 MOQ_effective 仍为 200 或仍弹出豁免 → 判定失败（0→6 优先级第 0 层失效） |
| MOQ-DR3-B3 | 勾选 Capsule 后数量 < Capsule 档阈值（20）——DR-003 不是完全豁免，仍需走 MOQ 豁免审批 | 1. 勾选 capsuleExemption=true（B2）；2. OrderLine 数量=5 PCS | 1. 保存 OrderLine；2. 尝试推进 Confirmed | 1. MOQ_effective=20，5 < 20 缺口 75%（红 Badge）；2. 拦截推进 Confirmed；3. 出现「申请 MOQ 豁免」入口（审批人路由走 DR-007） | 将 Capsule 当作"无 MOQ"直接放行 → 严重违反 DR-003，必须 fail-closed 拦截 |
| MOQ-DR3-B4 | 客户长期协议（CustomerTier Platinum 面料 MOQ 7 折）覆盖系统档（800→560） | 1. Order.type=Fabric；2. Relation.customerTier=Platinum，moqOverrideRatio=0.7；3. 订单行数量=650 M；4. 无工厂 factoryMoq、无行级 override、无 Capsule | 1. 取数优先级 0→6：第 0 层无 Capsule → 第 1 层无行级 override → 第 2 层客户协议命中 → MOQ_effective=800×0.7=560；2. 保存 650 | 1. 650 ≥ 560 → MOQ 合规；2. Badge 显示「Tier 协议 MOQ=560」来源标识；3. 历史可追溯来源（configId + customerTier 记录） | 优先级错误：系统档或产品档先于 Tier 协议 → 失败；来源标识可审计必须留痕 |
| MOQ-DR3-B5 | 工厂 factoryMoqValue 高于系统档 → 取 factoryMoqValue（保护我方不违约） | 1. 某面料 FabricProfile.factoryMoqValue=1200（工厂合同特殊要求）；2. 系统 MoqThresholdConfig.fabricDefaultMoq=900；3. 订单数量=1000 | 1. 取数优先级：0→1→2（无）→3 工厂 factoryMoqValue=1200 命中 | 1. MOQ_effective=1200；2. 1000 < 1200 → 缺口 16.7%（黄 Badge）；3. 显示「工厂合同要求 MOQ=1200」来源 | 优先级错误取系统档 900，导致 1000 被误判合规 → 工厂违约风险（失败） |
| MOQ-DR3-B6 | 同时设置行级 override（最高优先级第 1 层，需 scope:moq:line_override 权限） | 1. 业务员（无 override 权限）尝试在行上填 moqOverride=50；2. 后换销售主管（DR-041 容器，拥有该 scope）再次尝试 | 1. 业务员保存；2. 销售主管保存（附带备注理由） | 1. 业务员：后端 403，moqOverride 不生效，MOQ 按第 2-6 层正常取；2. 销售主管：保存成功，MOQ_effective=50；写入 overrideBy/overrideAt/overrideReason；审计事件=MOQ_LINE_OVERRIDE | 未授权角色不得写行级 override；需备注/留痕缺失 → 拒绝 |
| MOQ-DR3-B7 | Capsule 豁免审计链条可追溯（capsuleExemptionBy / capsuleExemptionAt 完整） | 1. 订单 A：业务员甲勾选 Capsule；2. 订单 B：业务员乙 2 天后也勾选；3. 30 天后审计报表 | 1. 查 `Order WHERE capsuleExemption=true ORDER BY capsuleExemptionAt DESC`；2. JOIN User 显示姓名/部门 | 1. 每行能回放到勾选人（非 NULL）、时间（精确到秒）、订单 ID；2. 允许按人/部门/时间筛选；3. 能对应到是否后续走了 < Capsule 档阈值的 MOQ 豁免审批 | 字段为 NULL 或时间不准确 → 审计失败（违反 DR-003 §4 审计要求） |

### 15.3 DR-041 容器角色 × MOQ 权限链验收（谁可调配置 / 谁可勾选 / 谁可审批 / 谁可 override）

| 验收编号 | 场景描述 | 前置条件 | 执行步骤 | 期望结果（7 容器） | 越权失败路径 |
|---------|---------|---------|---------|------------------|------------|
| MOQ-ROLE-C1 | 角色容器权限矩阵（DR-041）：MOQ 配置/勾选/审批/override 四项能力映射 | 1. 7 容器全量账号：业务员、销售主管、财务、QC、后勤、系统管理员（总领导）、超级管理员（老板）；2. 四个能力端点：① settings:moq:write（调配置）② order:capsule:toggle（勾 Capsule）③ approvals:moq-exemption:approve（批豁免）④ moq:line_override（行级 override） | 1. 每个容器逐个登录；2. 分别调用 4 个端点；3. 记录 28 次（7×4）返回码 | **允许（绿）/禁止（红）矩阵真源**：① 写配置=系统管理员/超级管理员（其余全红）② 勾 Capsule=业务员 + 销售主管（其余全红，财务/QC/后勤/系统管理不碰业务勾选）③ 批豁免=销售主管 + 系统管理员（总领导兜底 DR-007）+ 超级管理员；业务员只可申请，不可批自己；财务/QC/后勤红 ④ 行级 override=销售主管 + 系统管理员 + 超级管理员；业务员/其余红 | 任何红的端点返回 2xx → DR-041 边界违规（必须 fail-closed） |
| MOQ-ROLE-C2 | 业务员勾选 Capsule（B2 权限），审批豁免必须走 DR-007 服务端解析 reviewerId（非前端传） | 1. 业务员甲（销售部张主管下属）创建豁免单；2. 前端不传 reviewerId（按 DR-007 约定）；3. 提交 | 1. POST /approvals（actionType=order:moq-exemption，payload 含缺口）；2. 后端 `resolveReviewerByDepartment(申请人甲)` 解析；3. 写入 ApprovalRequest.reviewerId | 1. reviewerId 自动="张主管"（销售主管容器 id）；2. 张主管登录审批列表 → 可见该待办；3. 若张主管不存在（无部门主管）→ 兜底=系统管理员（总领导）id | 前端传 reviewerId=自己或任意用户 → 后端必须忽略或拒绝；reviewerId 解析走 DR-007 单一真源 |
| MOQ-ROLE-C3 | QC/后勤/财务容器触碰 MOQ 相关写端点全部 403 | 1. 财务、QC、后勤容器账号；2. 尝试：勾 Capsule / 改配置 / 行 override / 批豁免 4 个能力 | 1. 逐一调用；2. 后端返回 | 1. 全部 403（SC_DENIED）；2. 审计日志越权 12 条（3 容器 × 4 项）；3. 数据层 0 行变更 | 财务不小心批了 MOQ 豁免（业务不该财务介入，DR-041 明确财务不入业务审批链）→ 严重失败 |
| MOQ-ROLE-C4 | 销售主管批掉自己发起的豁免申请？——不允许（审批回避 DR-041 兜底） | 1. 销售主管李自己下单填 150 PCS < MOQ；2. 李发起豁免申请 | 1. 豁免申请 reviewerId 解析：若申请人=销售主管 → 无法 self-approve，找"上一级系统管理员（总领导）"兜底；2. 李尝试审批自己的申请 | 1. 审批人≠李本人（自审批阻断）；2. reviewerId=系统管理员（总领导）；3. 李点审批 → 返回 CANNOT_SELF_APPROVE 错误码 | Self-approve 漏防 → 违反审批权责分离（fail-closed 必须） |
| MOQ-ROLE-C5 | 超级管理员（老板，绝密级）=最终兜底：可审批、可改配置、可 override，但不日常批，有独立审计 | 1. 某豁免被系统管理员（总领导）Rejected；2. 业务极度特殊需要老板兜底；3. 老板（超级管理员容器 DR-041）登录 | 1. 老板在详情页点「兜底特批」（或直接审批接口带 role 校验：BYPASS_REJECTED + 强制补理由）；2. Order 推进 Confirmed | 1. 审批通过，但记录 `bypassedBy=老板user_id, bypassedReason=xxxx`；2. 审计事件=MOQ_EXEMPTION_BOSS_BYPASS 级别=CRITICAL；3. 报表显示「兜底审批数」给老板自检 | 普通角色能调 bypass → 0day 漏洞（fail-closed）；无强制补理由 → 审计失败 |

---

## §16 DR-013 受控例外 × MOQ 门禁验收（原 MOQ 审批被拒 / 不满足任何豁免条件的业务紧急场景）

> **决策来源**：[DR-013](../../10-评审与决策/2026-08-16-设计评审决策记录.md#dr-013-全局业务门禁的受控例外推进)
>
> **适用场景（仅当 MOQ 豁免审批 REJECTED / 不满足 Capsule / Tier / 客户协议任一条时才启动 EXC）**：不改变 MOQ 取数优先级 0-6 层，只在动作接口（Order.create Confirmed / Quotation.send 等）内部临时放行一次。

### 16.1 MOQ 例外 3 类场景验收

| 验收编号 | 场景 | 前置条件 | 执行步骤 | 期望结果（DR-013 fail-closed + 双模型留痕 + 不复制） | 失败路径 |
|---------|------|---------|---------|-------------------------------------------------|---------|
| MOQ-EXC-1 | 面料订单数量=500 M，系统档=800，客户 Tier=Bronze 不享受 Tier 折扣，无客户协议 MOQ，又无行级 override 权限；业务员提交 MOQ 豁免审批被主管 Rejected（理由「客户新客未达历史合作门槛，不建议豁免」） | 1. Order.type=Fabric，quantity=500，MOQ_effective=800，缺口 37.5%；2. 销售主管审批单 APP-2001=REJECTED；3. 业务员收到主管拒绝通知 | 1. 业务员点击 MOQ 缺口 Badge 的「发起受控例外申请」入口；2. exceptionCategory=moq_exemption / subCategory=bypass_rejected_approval；bypassedApprovalIds=[APP-2001]；exceptionReason=≥30字「客户下季度已承诺 3000M 返单+本次承担空运加急费+书面补偿函附件」；riskMitigationPlan=「客户承担一半空运费，剩余风险销售主管李跟进确认补偿」；责任人=「销售跟单-小王跟进补偿函签署」 | 1. Dr013ExceptionRequest 创建成功（EXC-20260825-100）；2. ApprovalRequest 关联创建，reviewerId=销售主管张（DR-007 申请人归属）；3. bypassedApprovalIds=[APP-2001]；4. APP-2001.bypassedApprovalId=EXC-100.approvalRequestId（反链正确）；5. 若张主管 Approve EXC → 下次保存 Order 推进 Confirmed 时 MOQ 校验允许绑定 EXC-100，不再拦截缺口 37.5%（**临时放行一次**） | EXC 批准后，Order.moqSnapshot 被静默覆盖写入 moqOverride=500（伪造行级 override 绕过）→ 彻底污染 MOQ 取数真源（必须保持 moqSnapshot 不变，MOQ 校验只在动作接口临时放行；反链 audit 可见该 EXC 为放行依据，不是真的 MOQ 达标） |
| MOQ-EXC-2 | 成衣订单 150 PCS（系统档 200），客户拒绝勾选 Capsule（不是小批量/上新需求），但又不能取消；业务员走正常 MOQ 豁免审批被拒，启动 DR-013 例外（非审批被拒，而是"不满足所有豁免条件"的门禁场景） | 1. Order.type=Garment，quantity=150，capsuleExemption=false（客户拒绝），GarmentProfile.moqValue=200，CustomerTier=Silver 无 MOQ 折扣；2. Order.create 时 MOQ 校验 MOQ_VIOLATION 直接拒绝，不允许提交审批；3. 页面只提供一个「DR-013 例外申请」入口（不提供豁免审批，因为无任何豁免依据——Capsule/Override/Tier/协议均不满足） | 1. 点例外入口；2. exceptionCategory=moq_exemption；subCategory=moq_violation_without_approval；bypassedApprovalIds=[]（无前序被拒审批）；3. exceptionReason=「客户为新签 A 类经销商战略试单，150 为首批量评估尺寸与质量，合同承诺 6 个月累计订单 ≥ 1000 PCS 补偿 MOQ 缺口（≥30 字）」；4. customerCommitment=客户盖章的战略试单协议扫描件（附件） | 1. EXC 创建；2. reviewerId=张主管（DR-007）；3. 张主管若 Approve → Order 可推进 Confirmed；但 **MOQ 缺口的 50 PCS 差值仍在系统报表「MOQ 受控例外清单」长期显示（与正常达标订单区分）**；4. 6 个月后 Order 关联的累计订单量未达 1000 → 自动生成风险预警（风险模块），责任人=原申请人孙与主管张 | 批准 EXC 后 MOQ 缺口被隐藏，报表与正常订单无区别 → 风险跟踪断裂（DR-013 例外必须可事后审计与风险追控） |
| MOQ-EXC-3 | MOQ EXC 批准后：**不复制到其他订单**；同一客户同一订单类型下其他新订单仍按 MOQ 规则严格校验，不得因某单 EXC 就默认放行整客户的 MOQ | 1. MOQ-EXC-1 中 EXC-100 已批准，面料订单 FAB-0001 quantity=500 < 800 已推进 Confirmed；2. 同一客户下 FAB-0002（新订单 1 个月后，数量=480M）创建 | 1. 业务员创建 FAB-0002 保存；2. MOQ 校验；3. 尝试推进 Confirmed 不提交新 EXC 也不申请新豁免 | 1. FAB-0002 MOQ_effective=800，480<800 → MOQ_VIOLATION 正常拦截；2. 不自动关联 FAB-0001 的 EXC-100；3. 明确提示「该订单不享受任何已批准 MOQ 受控例外，请重新申请 MOQ 豁免或 DR-013 受控例外」；4. EXC-100 指定动作=订单 ID=FAB-0001；指定时点=创建后 7 天内有效；过期 EXPIRED 且无法再次用于任何订单 | 客户维度：只要有过 MOQ EXC，该客户所有订单就自动放行 6 个月 → DR-013"不自动复制其他订单/指定动作时点"被严重违反（fail-closed，EXC 的 entity 绑定必须是 Order.id 级） |

---

## §17 相关文档索引（交叉链接）

| 文档 | 链接 | 关联要点 |
|------|------|---------|
| 业务规则总览 | [业务规则总览.md](./业务规则总览.md) | 22 条规则索引 §6 条款号 §9.1-1/2/3 与本文件对应 |
| 价格审批规则 | [价格审批规则.md](./价格审批规则.md) | 复用 ApprovalRequest 模型 + 审批人链分级框架；MOQ 豁免叠加低于成本价场景 |
| 订单变更规则 | [订单变更规则.md](./订单变更规则.md) | quantity 变更触发 MOQ 重新校验 + 与 L1-L3 审批链叠加 |
| 信用控制规则 | [信用控制规则.md](./信用控制规则.md) | CustomerTier 权益对 MOQ 的折扣（Platinum 7 折等） |
| 10 条事件联动与事件总线 | [10条事件联动（L1-L10）与事件总线.md](./10条事件联动（L1-L10）与事件总线.md) | MOQ 豁免审批通过事件 → 解锁 OrderConfirmed/L2 事件联动 |
| 数据模型总览 | [02-数据模型/实体关系总览.md](../02-数据模型/实体关系总览.md) | FabricProfile/GarmentProfile/TrimmingProfile MOQ 字段 × OrderLine/QuotationLine × ApprovalRequest 关联 × Order.capsuleExemption（DR-003） |
| 评审决策记录 | [10-评审与决策/2026-08-16-设计评审决策记录.md](../10-评审与决策/2026-08-16-设计评审决策记录.md) | DR-003：Capsule 是服装订单的 MOQ 豁免标记；DR-013：全局业务门禁的受控例外推进 |
| 产品总览-业务编号规则 | [01-产品总览/业务编号规则.md](../01-产品总览/业务编号规则.md) | ApprovalRequest 编号前缀 APR-YYYY-NNNN / Dr013ExceptionRequest 编号前缀 EXC-YYYY-NNN |
| 审批与 human-in-the-loop §15 | [04-模块设计/07-AI助手/审批与human-in-the-loop.md](../04-模块设计/07-AI助手/审批与human-in-the-loop.md#dr-013-受控例外全流程验收类型矩阵--dr-007路由--boss-兜底--越权--审计) | DR-013 通用验收 18 条 + 双模型留痕 + BOSS 兜底 ≥30 字校验 |
| Prisma 缺口清单 §9 P1-15 / P0-15 | [02-数据模型/Prisma缺口清单与迁移方案.md](../02-数据模型/Prisma缺口清单与迁移方案.md#p1-15新增-dr013exceptionrequestdr-013-受控例外被拒审批后申请例外审计链完整) | Dr013ExceptionRequest + ApprovalRequest.bypassedApprovalId 字段规格 |
| 订单详情页（模块） | [04-模块设计/订单管理/订单详情页.md](../04-模块设计/订单管理/订单详情页.md) | 行级 Badge / 豁免审批弹窗 / block 态保存按钮位置规范 |
