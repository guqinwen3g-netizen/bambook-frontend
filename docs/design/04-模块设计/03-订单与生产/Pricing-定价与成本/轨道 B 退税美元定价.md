# 轨道 B 退税美元定价（Track B）

## 元信息

| 项 | 值 |
|---|---|
| **定位** | 外贸出口对外报价真源——采购成本（CNY）→ 退税 → 净 USD 成本 → 利润 → 佣金 → 最终 USD 单价。派生值一律服务端重算，客户端不参与计算 |
| **入口** | ① PricingManager → 定价计算器 tab → TrackBPanel；② QuotationManager 报价编辑器双轨面板内嵌 TrackBPanel |
| **核心角色** | 业务员（试算主用户）、财务（含佣金可见、利润核对，宽泛容器不细分）、销售主管（偏差审批，部门管理职责） |
| **范式** | 范式 B — 工作台式（输入栅格 + 试算结果四卡 + 保存定价记录） |
| **优先级** | P1（阶段 P1 落地退税定价 + PricingCalculation 落库 + 默认值填充；阶段 P2 增补佣金规则快照） |
| **实现状态** | ✅ 已落地（calculateTrackB 纯函数 + TrackBPanel 共享组件 + track-b-preview API + PricingCalculation CRUD + HS Code 最长前缀命中退税率 + 最新 USD 汇率默认 + 佣金规则快照 + 状态流转 Draft→Confirmed→Archived） |
| **关联 PRD 章节** | §8.2（退税美元定价公式）、§8.5（退税率 / 佣金规则配置）、§8.6（双轨联动校验 + 派生值服务端重算）、§9.6（佣金字段权限） |
| **关联代码** | [pricingService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/pricing/pricingService.ts) calculateTrackB 纯函数 + resolveCalculationData 默认值填充 + createCalculation/listCalculations/updateCalculation/deleteCalculation / [TrackBPanel.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/pricing/TrackBPanel.tsx) 前端共享组件 / [pricingRoute.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/pricing/pricingRoute.ts) POST /track-b-preview + /calculations CRUD / `schema.prisma` PricingCalculation 模型 L3524 |

---

## 一、模块定位与边界

轨道 B 是双轨成本体系中"对外报价的真源"——它直接产生给客户报的 USD 单价。与轨道 A（仅内部估算标尺）不同，轨道 B 的计算结果会落库为 `PricingCalculation` 记录，并可关联到报价单（Quotation）作为偏差校验的对比方。

**核心特征**：
- **外贸口径**：考虑出口退税（退税率 0-16%），退税后净成本以 USD 计价
- **派生值服务端重算**：netUsdCost / profitAmount / commissionAmount / finalUnitPrice 一律由 `calculateTrackB` 在服务端计算，不接受客户端传入
- **默认值填充**：退税率缺省按 HS Code 最长前缀命中；汇率缺省取最新 USD 汇率；佣金率缺省 0（无佣金）
- **佣金规则快照**：commissionRuleId 提供时以规则值为快照（规则后续调整不回溯历史定价记录）

**边界**：
- ✅ 在内：退税试算、PricingCalculation CRUD、HS Code 查退税率（调用 TaxRefundRate）、最新汇率获取（调用 ExchangeRate）、佣金规则命中（调用 CommissionRule）
- ❌ 不在内：退税率表维护（TaxRefundRate 模块）、汇率维护（ExchangeRate 模块）、佣金规则配置（CommissionRule 模块）、偏差校验（calculatePriceDeviation 在 trackAEstimator.ts，由报价编辑器调用）

---

## 二、子模块导航

| # | 子能力 | 实现位置 |
|---|--------|----------|
| 1 | calculateTrackB 纯函数 | pricingService.ts L105-L122 |
| 2 | resolveCalculationData 默认值填充 + 重算 | pricingService.ts L246-L293 |
| 3 | createCalculation 落库 | pricingService.ts L295-L329 |
| 4 | updateCalculation 合并重算 | pricingService.ts L350-L387 |
| 5 | TrackBPanel 前端共享组件 | TrackBPanel.tsx |
| 6 | POST /track-b-preview 试算 API | pricingRoute.ts L172-L179 |
| 7 | /calculations CRUD API | pricingRoute.ts L181-L224 |

---

## 三、calculateTrackB 纯函数规格

### 3.1 输入（TrackBInput）

```typescript
interface TrackBInput {
  purchaseCostCny: number;    // 采购成本（CNY 单价，工厂采购价）
  refundRate: number;         // 退税率 %（0-16）
  exchangeRate: number;       // 汇率 CNY per USD（¥/$）
  profitMargin: number;       // 利润率 %
  commissionRate?: number;    // 佣金率 %（0=无 / 5=E5 / 10=E10）
}
```

### 3.2 输出（TrackBResult）

```typescript
interface TrackBResult {
  netUsdCost: number;         // 退税后美元成本
  profitAmount: number;       // 利润额
  commissionAmount: number;   // 佣金额
  finalUnitPrice: number;     // 终价美元单价
}
```

### 3.3 计算公式（PRD §8.2）

```
netUsdCost       = purchaseCostCny × (1 - refundRate/100) ÷ exchangeRate
profitAmount     = netUsdCost × profitMargin/100
commissionAmount = netUsdCost × commissionRate/100
finalUnitPrice   = netUsdCost + profitAmount + commissionAmount
```

**等价表达**：
```
finalUnitPrice = netUsdCost × (1 + profitMargin/100 + commissionRate/100)
```

所有派生值 `round4`（保留 4 位小数）。

### 3.4 校验规则

| 字段 | 校验 | 错误消息 |
|------|------|----------|
| purchaseCostCny | 必须大于 0 | 「采购价必须大于 0」 |
| refundRate | 0-16 之间 | 「退税率必须在 0-16% 之间」 |
| exchangeRate | 必须大于 0 | 「汇率必须大于 0」 |
| profitMargin | 非负 | 「利润率非法」 |
| commissionRate | 仅允许 0 / 5 / 10 | 「佣金率仅允许 0（无）/ 5（E5）/ 10（E10）」 |

**常量**：
- `REFUND_RATE_MIN = 0` / `REFUND_RATE_MAX = 16`
- `COMMISSION_RATES = [0, 5, 10]`

### 3.5 计算示例

```
输入：purchaseCostCny=32.50, refundRate=13, exchangeRate=7.10, profitMargin=15, commissionRate=5
netUsdCost       = 32.50 × (1 - 0.13) ÷ 7.10 = 32.50 × 0.87 ÷ 7.10 = 3.9824
profitAmount     = 3.9824 × 0.15 = 0.5974
commissionAmount = 3.9824 × 0.05 = 0.1991
finalUnitPrice   = 3.9824 + 0.5974 + 0.1991 = 4.7789
```

---

## 四、resolveCalculationData 默认值填充与重算

`pricingService.resolveCalculationData(input)` 在创建/更新 PricingCalculation 时执行：

```
1. 校验 purchaseCostCny > 0, profitMargin >= 0
2. 退税率填充：
   if refundRate 未提供:
     if hsCode 未提供 → throw "退税率缺失且未提供 HS Code"
     hit = lookupRefundRate(hsCode)  // 最长前缀命中
     if !hit → throw "HS Code ${hsCode} 无退税率映射，请人工指定退税率"
     refundRate = hit.rate
3. 汇率填充：
   if exchangeRate 未提供:
     latest = latestUsdRate()  // ExchangeRate 最新 USD
     if !latest → throw "汇率缺失且无最新 USD 汇率记录"
     exchangeRate = latest
4. 佣金率填充：
   if commissionRuleId 提供:
     rule = find CommissionRule
     if !rule || !rule.isActive → throw "佣金规则非法或已停用"
     commissionRate = rule.rate  // 规则值快照
   else:
     commissionRate = input.commissionRate ?? 0
5. derived = calculateTrackB({ purchaseCostCny, refundRate, exchangeRate, profitMargin, commissionRate })
6. status 校验（若提供）：Draft | Confirmed | Archived
7. 返回 { hsCode, refundRate, exchangeRate, commissionRate, commissionRuleId, derived }
```

**关键原则**：不信任客户端派生值——即使客户端传了 netUsdCost / finalUnitPrice，服务端也会用 calculateTrackB 重算覆盖。

---

## 五、TrackBPanel 组件规格

### 5.1 Props

```typescript
interface TrackBPanelProps {
  title?: string;
  onResultChange?: (result: TrackBResult | null) => void;
  onInputsChange?: (inputs: TrackBValidInputs | null) => void;
  children?: React.ReactNode;   // 额外输入字段（如数量/备注），渲染于输入栅格末尾
  actions?: React.ReactNode;    // 额外操作按钮（如保存定价记录），渲染于「试算预览」右侧
}

interface TrackBValidInputs {
  purchaseCostCny: number;
  refundRate: number;
  exchangeRate: number;
  profitMargin: number;
  commissionRate: number;
  commissionRuleId: string | null;
  hsCode: string;
}
```

### 5.2 输入项

| 字段 | 校验 | 默认值 | 辅助 |
|------|------|--------|------|
| 采购成本（CNY 单价） | `> 0` | — | inputMode=decimal |
| HS Code（可查退税率） | trim 后可空 | — | 「查税率」按钮调 lookupTaxRefundRate |
| 退税率（%） | 0-16 | — | inputMode=decimal |
| 汇率（CNY/USD） | `> 0` | — | 「最新」按钮调 getLatestFxRates 带入 USD |
| 利润率（%） | 非负 | — | inputMode=decimal |
| 佣金 | 0 / 5 / 10 / 规则快照 | 0（无佣金） | select 下拉：无/E5/E10/规则列表 |

### 5.3 佣金选择口径

```
handleCommissionSelect(value):
  ''              → commissionRuleId=null, commissionRate=0
  'E5'            → commissionRuleId=null, commissionRate=5
  'E10'           → commissionRuleId=null, commissionRate=10
  rule.id         → commissionRuleId=rule.id, commissionRate=rule.rate  // 规则快照
```

佣金规则列表在组件挂载时调 `apiService.listCommissionRules()` 加载。

### 5.4 试算结果展示（四卡）

| 卡片 | 字段 | 高亮 |
|------|------|------|
| 退税后美元成本 | `netUsdCost.toFixed(4)` | — |
| 利润额 | `profitAmount.toFixed(4)` | — |
| 佣金额 | `commissionAmount.toFixed(4)` | — |
| 终价美元单价 | `finalUnitPrice.toFixed(4)` | `border border-border-action` 高亮 |

每卡 `bg-surface-primary rounded-inset p-3`，主数据 `text-lg font-medium`。

### 5.5 交互流程

1. 用户填写采购成本 / HS Code / 退税率 / 汇率 / 利润率 / 佣金
2. 可选：点击「查税率」按 HS Code 最长前缀命中退税率自动填入
3. 可选：点击「最新」带入最新 USD 汇率
4. `validInput` useMemo 实时计算（4 个必填项齐全且合法时非 null）
5. 点击「试算预览」→ 调 `apiService.previewTrackB(validInput)` → 服务端 calculateTrackB → 返回 TrackBResult
6. onResultChange / onInputsChange 回传父组件，供偏差校验与保存定价记录

---

## 六、状态机

### 6.1 试算状态

```
[无试算] ──点击「试算预览」──→ [试算中 previewing] ──成功──→ [有试算 preview]
                              │                            │
                              └──失败──→ alert + 回到 [无试算] │
                                                           │
                              ┌──修改任何输入──→ setPreview(null) ──┘
                              │
                              └──切换佣金──→ setPreview(null) + handleCommissionSelect
```

### 6.2 PricingCalculation 状态流转

```
Draft ──PATCH status=Confirmed──→ Confirmed
  │                                  │
  ├──PATCH status=Archived──→ Archived（终态，不可修改）
  │
  └──DELETE──→ 软删（deletedAt）
```

**约束**：
- `Archived` 状态不可修改（updateCalculation 抛「已归档计算不可修改」）
- 状态变更需 PATCH /calculations/:id with `{ status: 'Confirmed' | 'Archived' }`

---

## 七、数据模型与字段全量清单

### PricingCalculation 模型（schema.prisma L3524）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | String @id | 格式：PRC__${shortId} |
| **输入项** | | |
| purchaseCostCny | Decimal(18,4) | 人民币成本单价（工厂采购价） |
| refundRate | Decimal(8,4) | 退税率百分比（0-16） |
| exchangeRate | Decimal(18,8) | CNY per USD（¥/$） |
| profitMargin | Decimal(8,4) | 利润率百分比 |
| commissionRate | Decimal(8,4) @default(0) | 中间人佣金率（0=无 / 5=E5 / 10=E10） |
| **派生项（服务端重算）** | | |
| netUsdCost | Decimal(18,4) | = purchaseCostCny × (1 - refundRate%) ÷ exchangeRate |
| profitAmount | Decimal(18,4) | = netUsdCost × profitMargin% |
| commissionAmount | Decimal(18,4) | = netUsdCost × commissionRate% |
| finalUnitPrice | Decimal(18,4) | = netUsdCost + profit + commission |
| **关联（snapshot FK）** | | |
| orderId | String? | 关联订单 |
| quotationId | String? | 关联报价单 |
| productAssetId | String? | 关联产品档案 |
| hsCode | String? | 退税率来源 HS Code（追溯） |
| fxLockId | String? | 使用锁定汇率时关联 FxRateLock |
| commissionRuleId | String? | 佣金率来源 CommissionRule（追溯；rate 已落库为快照） |
| quantity | Decimal?(18,4) | 数量（前端算总额用，不参与单价推导） |
| status | String @default("Draft") | Draft / Confirmed / Archived |
| notes | String? | 备注 |
| createdBy | String? | 创建人 |
| createdAt | BigInt | |
| updatedAt | BigInt | |
| deletedAt | BigInt? | 软删标记 |

**索引**：orderId / quotationId / status

---

## 八、API 端点清单

### POST /v1/pricing/track-b-preview

**守卫**：读（JWT 或 API-Key）

**请求体**（TrackBInput）：
```json
{
  "purchaseCostCny": 32.50,
  "refundRate": 13,
  "exchangeRate": 7.10,
  "profitMargin": 15,
  "commissionRate": 5
}
```

**响应**（TrackBResult）：
```json
{
  "netUsdCost": 3.9824,
  "profitAmount": 0.5974,
  "commissionAmount": 0.1991,
  "finalUnitPrice": 4.7789
}
```

### POST /v1/pricing/calculations

**守卫**：写（JWT）

**请求体**（PricingCalculationInput）：
```json
{
  "purchaseCostCny": 32.50,
  "hsCode": "5407520000",
  "profitMargin": 15,
  "commissionRuleId": "CR__ABCDE123",
  "quantity": 800,
  "notes": "试单定价"
}
```
（refundRate / exchangeRate / commissionRate 缺省时由 resolveCalculationData 填充）

**响应**：201 + `{ ok: true, item: PricingCalculation }`

### GET /v1/pricing/calculations

**查询参数**：?orderId=&quotationId=&status=&limit=&offset=

**响应**：`{ items: PricingCalculation[], total: number }`

### PATCH /v1/pricing/calculations/:id

**守卫**：写（JWT）

**请求体**（PricingCalculationPatch）：任意输入项子集；任何输入变化都会传导到终价（合并现有值 + patch 重算）

**错误**：404（不存在）/ 400（已归档不可修改）

### DELETE /v1/pricing/calculations/:id

**守卫**：写（JWT）— 软删

---

## 九、权限矩阵

| 角色 | 试算预览 | 定价记录 CRUD | 佣金字段可见 |
|------|----------|---------------|--------------|
| 业务员 | ✅ | ✅（自己创建的） | ❌（佣金字段隐藏） |
| 跟单员 | ✅ | ✅ | ❌ |
| 财务 | ✅ | ✅ | ✅ |
| 管理层 | ✅ | ✅ | ✅ |
| QC | ❌ | ❌ | — |

**佣金可见性约束**（PRD §9.6）：佣金字段（commissionRate / commissionAmount）涉管理层 + 财务可见域。pricingRoute 不做字段级过滤——模块整体由前端 `modulePermissions` 的 `finance:read` 权限门控。无 finance:read 角色的用户不渲染 PricingManager 模块入口。

---

## 十、四态规范

| 状态 | 表现 | 实现路径 |
|------|------|----------|
| **空态** | 试算预览按钮 `disabled={!validInput}`；无结果区 | TrackBPanel.tsx validInput useMemo |
| **加载态** | 「试算预览」按钮内 `Loader2 animate-spin` + `disabled={previewing}` | L233-L240 |
| **错误态** | `alert(试算失败: ${message})`；路由层 400/500 按消息关键字映射 | L173-L177 |
| **无权限** | 前端 modulePermissions 拦截，不渲染 TrackBPanel；佣金字段对无 finance:read 角色隐藏 | 全局权限门控 |

**lookupHint 状态**：HS Code 查税率结果提示（命中 / 未命中 / 查询失败），`text-xs text-text-tertiary`。

---

## 十一、业务规则 §8.2 / §8.5 / §8.6 关联项

| 规则 | 落地 |
|------|------|
| §8.2 退税美元定价公式 | calculateTrackB 纯函数 |
| §8.2 派生值服务端重算 | resolveCalculationData + createCalculation/updateCalculation 不信任客户端派生值 |
| §8.5 退税率缺省按 HS Code 最长前缀命中 | resolveCalculationData 调 lookupRefundRate |
| §8.5 汇率缺省取最新 USD | resolveCalculationData 调 latestUsdRate |
| §8.5 佣金规则配置真源 | commissionRuleId 提供时以规则值为快照 |
| §8.6 派生值不信任客户端 | calculateTrackB 在服务端执行，结果覆盖任何客户端传入 |
| §9.6 佣金字段权限 | 前端 modulePermissions finance:read 门控 |

---

## 十二、可访问性 & 交互细节

- **HS Code 查税率**：「查税率」按钮调 `lookupTaxRefundRate(hsCode)`，命中自动填退税率 + 显示 `lookupHint`（命中 HS XXXX，退税率 XX% / 未命中，请手工录入 / 查询失败）
- **最新汇率**：「最新」按钮调 `getLatestFxRates()`，找到 USD 自动填入汇率框
- **佣金选择**：select 下拉含「无佣金（0%）/ E5（5%）/ E10（10%）/ 规则：{name}（{rate}% · {intermediaryName}）」四类选项
- **试算预览按钮**：`Calculator` 图标 + 「试算预览」文字；`disabled={previewing || !validInput}`
- **试算结果四卡**：每卡 `text-lg font-medium` 主数据 + `text-xs text-text-tertiary` 标签；终价卡 `border border-border-action` 高亮
- **数字输入**：`inputMode="decimal"` 移动端数字键盘；`parseNum` 容错空串
- **金额格式化**：`toFixed(4)` 保留 4 位小数（USD 单价精度需求）

---

## 十三、设计系统约束

- **BDS 语义类**：`bg-surface-elevated rounded-card p-5`（面板表面）/ `bg-surface-primary rounded-inset p-3`（试算结果卡）/ `text-text-primary/tertiary`
- **token 类优先**：使用 `border-border-action` / `bg-surface-primary` 等 tailwind 语义类，不硬编码 hex / rounded-[Npx]
- **主题透明**：TrackBPanel 无 isDarkMode 分支，暗色由 tokens.css `[data-theme]` 统一覆盖
- **共享组件复用**：TrackBPanel 在 PricingManager 与 QuotationManager 双处复用，通过 `children` / `actions` props 灵活扩展

---

## 十四、移动端适配

- 输入栅格 `grid-cols-2` 在窄屏自动降级为单列
- 试算结果四卡 `grid-cols-2` 在窄屏保持两列
- 「查税率」「最新」辅助按钮在窄屏可能拥挤，可考虑窄屏仅显示图标（当前未做特殊处理）

---

## 十五、相关文档索引（交叉链接）

- [模块概述.md](./模块概述.md) — Pricing 模块总览与子文档索引
- [轨道 A 系统估算器.md](./轨道%20A%20系统估算器.md) — 轨道 A 中位估算（偏差校验的标尺）
- [偏差校验与审批链.md](./偏差校验与审批链.md) — 轨道 B 终价参与偏差校验，warn/block 触发审批
- [退税率表维护.md](./退税率表维护.md) — TaxRefundRate 最长前缀命中（轨道 B 退税率缺省来源）
- [../Orders-订单管理/订单详情页.md](../Orders-订单管理/订单详情页.md) — 订单详情页（PricingCalculation 关联 orderId）
- [../../../03-业务规则/价格审批规则.md](../../../03-业务规则/价格审批规则.md) — 价格审批规则（偏差审批的业务规则真源）
