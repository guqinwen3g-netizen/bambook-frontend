# FinanceManager 总览 (Finance Manager Overview)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | 财务与结算域统一入口——看板 KPI / 台账四联表（发票·收付款·增值税·报表）/ 核销闭环 / 外汇付汇结汇 / 预警面板，覆盖 AR/AP 全链路 |
| **入口** | 侧边栏「财务管理」→ FinanceManager；支持 `initialTab` deep-link（`invoices`/`vouchers`/`vatInvoices`/`reports`） |
| **核心角色** | 财务（含主操作、收付款凭证、审批/报表，宽泛容器不细分） |
| **范式** | 模块总览型文档（三大区块拆解 + tab 架构 + 数据流契约） |
| **优先级** | P0 |
| **实现状态** | ✅ 已落地（4 tab 完整接入：发票 / 收付款 / 增值税 / 报表；KPI 行 4 卡 + 跨币种聚合；核销/结汇/付汇/VAT 状态机全量接入；跨模块 prime 采购→应付发票已通；报表 tab 5 子视图全部落地）|
| **关联 PRD 章节** | §5.6（编号规则 INV/PAY）、§8（财务域）、§9.4（信用控制） |
| **关联代码** | 前端 [FinanceManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/FinanceManager.tsx) / 报表子面板 [FinanceReportsPanel.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/finance/FinanceReportsPanel.tsx) / 后端服务组 [server/src/finance/](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/finance/) |

---

## §2 三大区块定位

FinanceManager 自顶向下分为三大区块，对应「看懂现状 → 管好台账 → 抓住风险」的三层认知：

| 区块 | 位置 | 职责 | 数据源 |
|------|------|------|--------|
| **① 财务看板** | 顶部 KPI 行（4 卡） | 全量发票/凭证敞口聚合，一眼看懂应收/应付/待收/待付 | `invoices[]` + `vouchers[]` 本地派生（前端 `aggregateByCurrency`） |
| **② 台账四联表** | 中部 segment + 表格 | 发票 / 收付款 / 增值税 / 报表 四个 tab，单据级 CRUD + 核销 | 各服务 `listXxx` + 选中项 `allocations` |
| **③ 预警面板** | 右侧详情面板 / 报表 tab | 账龄五桶、未结汇余额、超期发票、核销状态指引 | `getAgingReport` / `getFxLedger` / 本地 `VOUCHER_STATUS_GUIDE` |

---

## §3 4 Tab 架构

```
┌─────────────────────────────────────────────────────────────┐
│  KPI 行：应收发票 │ 应付发票 │ 待收凭证 │ 待付凭证（4 卡）  │
├─────────────────────────────────────────────────────────────┤
│ [发票] [收付款] [增值税] [报表]   ← bds-segment 切换         │
├──────────────────────────────┬──────────────────────────────┤
│  左：单据列表（搜索+过滤）     │  右：选中详情 + 关联视图      │
│  （TABLE_GRID_CLASS 4 列）    │  + 核销明细 / 状态指引        │
│                               │ + RelatedEntitiesPanel       │
└──────────────────────────────┴──────────────────────────────┘
```

| Tab | id | 图标 | 主表 | 状态机 | 详情面板关键能力 |
|-----|----|------|------|--------|------------------|
| 发票 | `invoices` | FileText | Invoice | Draft→Issued→PartiallyPaid→Paid→Cancelled | 开票/编辑/作废/PI 转换/核销明细 |
| 收付款 | `vouchers` | CreditCard | PaymentVoucher | unreconciled→partially_reconciled→reconciled | 录入/编辑/结汇 modal/付汇 modal/核销明细 |
| 增值税 | `vatInvoices` | Receipt | VatInvoice | Received→Verified→Declared→RedFlushed/Cancelled | 收票/认证/申报/红冲/挂退税申报 |
| 报表 | `reports` | BarChart3 | — | — | 账龄/客户对账单/供应商对账单/汇率损益/外汇台账 |

---

## §4 财务看板（KPI 行）

KPI 行始终基于**全量** `invoices` + `vouchers` 派生（不受 tab 过滤影响），4 张卡：

| 卡片 | 计算口径 | 说明 |
|------|---------|------|
| 应收发票 | `type==='Receivable' && status∉{Paid,Cancelled}` | 未结清应收敞口 |
| 应付发票 | `type==='Payable' && status∉{Paid,Cancelled}` | 未结清应付敞口 |
| 待收凭证 | `type==='Receipt' && status!=='reconciled'` | 已到账未核销收款 |
| 待付凭证 | `type==='Disbursement' && status!=='reconciled'` | 已出账未核销付款 |

**跨币种聚合**（`formatCurrencyAggregate`）：
- 单币种：`¥金额 + N 笔`
- 多币种：主币种金额 + `N 笔 · 次币种1 / 次币种2`（按金额降序取 top 2）

> **设计决策**：看板不折算汇总——多币种并行展示，避免汇率假设污染敞口判断（与报表层 `getArApSummary` 同口径）。

---

## §5 台账四联表

### 5.1 共享表格契约

四个 tab 共享 `TABLE_GRID_CLASS`（4 列网格），但列含义随 tab 变化：

| Tab | 列1 | 列2 | 列3 | 列4 |
|-----|-----|-----|-----|-----|
| 发票 | 发票号 | 类型/状态 | 客户 | 金额 |
| 收付款 | 凭证号 | 类型/状态 | 交易对象 | 金额 |
| 增值税 | 发票号码 | 状态 | 购销方 | 价税合计 |

### 5.2 过滤器（bds-filterbar）

每个 tab 共享一套过滤逻辑（tab 切换时重置）：
- **搜索框**：发票号/凭证号/VAT 号 + 客户名模糊匹配
- **类型 chips**：发票(应收/应付/形式)·凭证(收款/付款)·增值税(进项/销项)
- **状态 chips**：发票 5 态·凭证 4 态·增值税 5 态
- **状态快统计**：工具栏右侧显示「已结清/已开票/部分销账」或「已核销/未核销/部分核销」计数

### 5.3 右侧详情面板

选中行后右侧展开详情：
- **基础信息**：编号/金额/币种/日期/汇率/状态徽章 + 状态指引（`VOUCHER_STATUS_GUIDE` / `VAT_STATUS_GUIDE`）
- **核销明细**：发票/凭证加载 `InvoiceAllocation[]`（增值税 tab 跳过——无核销语义）
- **关联视图**：`RelatedEntitiesPanel` 展示 EntityLink 图谱（settlesInvoice / aboutOrder / billTo）

---

## §6 预警与状态指引

### 6.1 状态指引文案（消费后端稳定枚举）

前端**不猜字符串**，所有状态说明消费后端返回的稳定枚举：

| 实体 | 指引表 | 示例 |
|------|--------|------|
| 凭证 | `VOUCHER_STATUS_GUIDE` | `unreconciled` →「该凭证尚未核销任何发票。可在发票模块关联核销，或等待 Agent 自动匹配。」 |
| 增值税 | `VAT_STATUS_GUIDE` | `Received` →「发票已登记收票。下一步：勾选认证」 |

### 6.2 报表层预警

报表 tab（FinanceReportsPanel）承载结构化预警：

| 子视图 | 预警维度 | 视觉 |
|--------|---------|------|
| 账龄分析 | 90 天以上桶 | `text-red-400` 红色高亮 |
| 外汇台账 | 未结汇余额 > 0 | `text-amber-400` 琥珀色 + 未结汇凭证清单 |
| 汇率损益 | 净损益正负 | 收益 `text-emerald-400` / 损失 `text-red-400` |

### 6.3 内联错误（bds-alert danger）

所有 modal 内操作失败均以 `bds-alert danger` 内联展示（非 window.alert），保留用户输入：
- `invoiceError` / `voucherError` / `vatError` / `allocError` / `settlementError` / `remittanceError` / `vatTransitionError`

---

## §7 数据流与状态真源

### 7.1 单据列表数据流

```
App.tsx (顶层 state: invoices[], vouchers[])
  │ props 下发
  ▼
FinanceManager (本地派生 KPI + filteredInvoices/Vouchers)
  │ tab 激活时按需加载
  ▼
增值税 tab: vatInvoiceService.listVatInvoices() → 本地 state vatInvoices[]
报表 tab: FinanceReportsPanel 自包含加载
```

### 7.2 Mutation 后真源刷新策略

所有写操作（create/update/delete/transition）成功后采用**服务端返回为真源**刷新：

| 操作 | 刷新方式 |
|------|---------|
| 发票 create/update | `setInvoices(prev => [created, ...prev])` 或 `map(i => i.id===updated.id ? {...i, ...updated} : i)` |
| PI 转换 | `invoiceService.listInvoices()` 全量重拉 + `setSelectedId(newInvoice.id)` |
| 凭证 create/update | `setVouchers(prev => [created, ...prev])` 或 `map` |
| 结汇/付汇 create/delete | `loadSettlementSummary(voucherId)` / `loadRemittanceSummary(voucherId)` 重拉摘要 |
| 增值税 transition | 本地 `setVatInvoices(prev => map(...))` 更新状态 |

> **反模式规避**：mutation 成功后不乐观更新本地状态（除直接消费后端返回），避免口径漂移。结汇/付汇的 `cnyAmount` 由服务端计算，客户端传入一律拒绝。

---

## §8 跨模块 prime（采购→应付发票）

FinanceManager 支持从采购模块 prime 一个应付发票创建：

```
ProcurementManager → primeFinanceInvoiceCreate({ supplierRelationId, supplierName, currency, amount, notes })
  │ sessionStorage 暂存（key: bambook_finance_invoice_prime）
  ▼
FinanceManager mount → readFinanceInvoicePrime() → clearFinanceInvoicePrime()
  │ 预填 form: type='Payable', customerName=supplierName, amount, currency
  ▼
setActiveTab('invoices') + setShowInvoiceModal(true)  // 直接打开新建 modal
```

**设计**：sessionStorage 传递（与 ProcurementCreatePrime 同模式），失败静默忽略（跨模块连续性 only）。

---

## §9 后端服务分层

| 层 | 文件 | 职责 |
|----|------|------|
| mutation 真源 | `invoiceMutationService.ts` | 发票 create/update（事务 + 状态校验 + 审计 + 事件） |
| mutation 真源 | `paymentVoucherMutationService.ts` | 凭证 create/update（status 禁手动 PATCH） |
| mutation 真源 | `allocationMutationService.ts` | 核销 create/update/delete（Serializable 隔离） |
| 核销纯函数 | `allocationService.ts` | `recalcInvoiceStatus` / `recalcVoucherStatus` / `applyAllocation` |
| 结汇 | `fxSettlementService.ts` | 结汇水单 create/delete + 台账聚合 |
| 付汇 | `outwardRemittanceService.ts` | 付汇水单 create/delete + 摘要 |
| 增值税 | `vatInvoiceService.ts` | VAT 全生命周期 + 退税联动硬校验 |
| 形式发票 | `proformaInvoiceService.ts` | PI 从报价单生成 + 转正式应收 |
| 作废/软删 | `voidDeleteService.ts` | Invoice cancel/softDelete + Voucher cancel/softDelete |
| 报表 | `reportService.ts` | 账龄/客户对账单/供应商对账单/汇率损益（只读） |
| 统一服务 | `financeServiceV2.ts` | list/get/create/update/delete + AR/AP 看板 + 行级权限 |
| 路由 | `routeV2.ts` | REST 端点 + 权限守卫 |

---

## §10 编号规则

| 单据 | 序列类型 | 格式 | 生成时机 |
|------|---------|------|---------|
| 发票 | `invoice` | `INV-YYYY-NNNN` | create 时服务端 `nextBusinessNumber`（传入优先） |
| 凭证 | `voucher` | `PV-YYYY-NNNN` | create 时服务端生成 |
| 结汇水单 | — | `FXS-YYYYMMDD-XXXX` | `generateSettlementNumber(settleDate)` |
| 付汇水单 | — | `OWR-YYYYMMDD-XXXX` | `generateRemittanceNumber(remitDate)` |
| 增值税 | — | `VAT__${shortId}` | `generateId('VAT')` |
| 核销明细 | — | `ALLOC__${invoiceId}__${voucherId}` | 复合主键（@@unique） |

---

## §11 权限矩阵

| 角色 | 发票 | 凭证 | 增值税 | 报表 | 核销 |
|------|------|------|--------|------|------|
| owner/admin | ✅ 全部 | ✅ 全部 | ✅ 全部 | ✅ 全部 | ✅ |
| finance | ✅ 全部 | ✅ 全部 | ✅ 全部 | ✅ 全部 | ✅ |
| sales | ⚠️ 自己的 | ❌ | ❌ | ⚠️ 行级 scope | ❌ |
| manager | ⚠️ 部门 scope | ⚠️ 部门 | ⚠️ 部门 | ⚠️ 部门 | ⚠️ 部门 |

**行级权限**（`buildScopeWhere`）：`finance` 数据域解析 `getDataScopeResolver` → `all` / `self` / `department+user` 三种规则，作用于 list/get/create/update/delete 全链路。

---

## §12 设计系统约束

| 约束 | 合规说明 |
|------|---------|
| 状态徽章 | Finance 页面**禁用语义色族**，统一 `bds-badge sm neutral`；终态（作废/红冲）降透明度 `opacity-60` |
| KPI 卡片 | `bds-card` + `bds-tnum`（tabular-nums 数字对齐） |
| 报表 RDL 原语 | `RdlMetricCard` / `RdlSurface` / `RdlToolbar` / `RdlPill`（flat 无阴影） |
| 表单控件 | `bds-input sm` / `bds-select` / `bds-segment` / `bds-filterbar` |
| 错误提示 | `bds-alert danger`（非硬编码颜色） |
| 金额格式 | `formatAmount` 币种符号前缀 + `toLocaleString('zh-CN', 2位小数)` |

---

## §13 待补缺口

| # | 缺口 | 优先级 | 落点 |
|---|------|-------|------|
| 1 | 客户逾期 60 天冻结门禁（与订单状态机联动） | P0 | §6 |
| 2 | 付款凭证审批流（≤5万/>5万/首单+1级）尚未接入 Agent 审批 | P1 | 凭证管理 |
| 3 | KPI 行汇率折算汇总（当前多币种不折算） | P2 | §4 |
| 4 | 报表 tab 下钻联动到单据（A5d 部分接入） | P1 | §5 |

---

## §14 交互规范

- **tab 切换**：`bds-segment`，过滤 state 随 tab 切换重置（`searchTerm` / `selectedType` / `selectedStatus`）
- **选中态**：列表行 `active` 高亮；右侧详情面板自动加载 `allocations`
- **modal 交互**：create/edit 共用 modal；失败保留输入 + `bds-alert danger` 内联错误
- **确认操作**：作废/删除/PI 转换使用 `window.confirm` 二次确认；结汇/付汇删除使用 `window.confirm` 带水单号

---

## §15 交叉链接

1. [发票管理](./发票管理.md) — 发票 CRUD + 状态机 + PI 转换
2. [付款凭证管理](./付款凭证管理.md) — 凭证录入 + 核销 + 结汇/付汇入口
3. [应收账龄与核销](./应收账龄与核销.md) — 账龄五桶 + InvoiceAllocation 核销机制
4. [外汇结汇与差异损益](./外汇结汇与差异损益.md) — FxSettlement 结汇闭环
5. [增值税发票台账](./增值税发票台账.md) — VAT 全生命周期
6. [财务域模型组](../../02-数据模型/财务域模型组.md) — Invoice/PaymentVoucher/InvoiceAllocation 等全量字段
7. [前端组件真源](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/FinanceManager.tsx) — `FinanceManager` 主组件
8. [报表子面板真源](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/finance/FinanceReportsPanel.tsx) — `FinanceReportsPanel`

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| 后端财务服务组 | [server/src/finance/](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/finance/) |
| 路由 V2 | [server/src/finance/routeV2.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/finance/routeV2.ts) |
| 业务事件总线 | [server/src/events/businessEventBus.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/events/businessEventBus.ts) |
| 状态转移校验 | [server/src/statusTransition.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/statusTransition.ts) |
| 类型定义 | [types.ts L2316-L2609](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/types.ts#L2316-L2609) |
| 信用控制规则 | [../../03-业务规则/信用控制规则.md](../../03-业务规则/信用控制规则.md) |
