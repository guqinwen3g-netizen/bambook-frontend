# 轨道 A 系统估算器（Track A）

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | 系统推荐估算器——基于成本分解（面料/辅料/工费/加工费/包装/纱线/织造/染整）+ 行业基准 + 价格历史命中，输出估算售价区间（下限/中位/上限）。**仅内部使用**（PRD §8.4），作为轨道 B 终价的"标尺"，不对客户展示 |
| **入口** | ① PricingManager → 定价计算器 tab → TrackAPanel；② QuotationManager 报价编辑器双轨面板内嵌 TrackAPanel |
| **核心角色** | 业务员（含跟单，主用户）、销售主管（查阅估算依据，部门管理职责） |
| **范式** | 范式 B — 工作台式（输入栅格 + 成本拆解可调 + 估算区间三卡） |
| **优先级** | P2（阶段 P2 增补，PRD §8.1 明确 AI 校准学习属 Phase 4，当前为规则制） |
| **实现状态** | ✅ 已落地（calculateTrackA 纯函数 + TrackAPanel 共享组件 + track-a-preview API + 价格历史命中解析 + 逐项可调实时重算 + 数据命中度三级区间系数） |
| **关联 PRD 章节** | §8.1（系统推荐估算）、§8.4（仅内部使用）、§8.6（逐项可调实时重算 + 双轨偏差校验标尺） |
| **关联代码** | [trackAEstimator.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/pricing/trackAEstimator.ts) calculateTrackA / calculatePriceDeviation 纯函数 + INDUSTRY_BENCHMARKS 常量 / [pricingService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/pricing/pricingService.ts) estimateTrackA 价格历史命中解析 / [TrackAPanel.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/pricing/TrackAPanel.tsx) 前端共享组件 / [pricingRoute.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/pricing/pricingRoute.ts) POST /track-a-preview / [trackA.test.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/pricing/__tests__/trackA.test.ts) 单元测试 |

---

## §2 模块定位与边界

轨道 A 是双轨成本体系的"内部标尺"——它不直接产生对外报价（对外报价是轨道 B 的职责），而是回答："基于成本分解 + 行业基准，这件成衣 / 这米面料的合理售价区间是多少？" 这个区间作为轨道 B 终价的参照系，偏差超过 15% / 30% 触发审批 / 禁发门禁。

**核心特征**：
- **规则制**（PRD §8.1 明确）：当前为人工可调的行业基准常量，AI 校准学习属 Phase 4
- **纯函数**：`calculateTrackA` 无副作用、无 IO，便于单元测试与路由层 preview 复用
- **三级数据命中度**：price_history（价格历史命中）> manual（手工录入/工厂报价）> industry_benchmark（行业基准），命中度决定区间系数（±8% / ±12% / ±15%）
- **不落库**：试算口径与 track-b-preview 一致，仅内部使用，不持久化估算结果

**边界**：
- ✅ 在内：成本分解行构建、行业基准常量、价格历史命中、区间系数、USD 换算（有汇率时）
- ❌ 不在内：对外报价（轨道 B）、退税率查询（TaxRefundRate 模块）、汇率维护（ExchangeRate 模块，只读消费）

---

## §3 子模块导航

| # | 子能力 | 实现位置 |
|---|--------|----------|
| 1 | calculateTrackA 纯函数 | trackAEstimator.ts L156-L295 |
| 2 | INDUSTRY_BENCHMARKS 行业基准常量 | trackAEstimator.ts L93-L111 |
| 3 | CMT_COMPLEXITY_FACTOR / WEAVE_TYPE_FACTOR 系数表 | trackAEstimator.ts L113-L123 |
| 4 | SPREAD_BY_QUALITY 区间系数表 | trackAEstimator.ts L126-L130 |
| 5 | estimateTrackA 价格历史命中解析 | pricingService.ts L407-L432 |
| 6 | TrackAPanel 前端共享组件 | TrackAPanel.tsx |
| 7 | POST /track-a-preview API | pricingRoute.ts L159-L166 |

---

## §4 calculateTrackA 纯函数规格

### 4.1 输入（TrackAInput）

```typescript
interface TrackAInput {
  category: 'garment' | 'fabric';
  // ── 成衣输入（¥/件口径）──
  fabricPriceCny?: number;       // 面料单价 ¥/米；缺省行业基准 55
  fabricConsumptionM?: number;   // 单件用量 米/件；缺省 1.5
  fabricLossRate?: number;       // 损耗率 %；缺省 3
  trimmingCostCny?: number;      // 辅料 ¥/件；缺省 8
  cmtCostCny?: number;           // CMT 加工费 ¥/件；缺省 35 × 复杂度系数
  complexity?: 'simple' | 'standard' | 'complex';  // 缺省 standard
  packagingCostCny?: number;     // 包装 ¥/件；缺省 3
  // ── 面料输入（¥/米口径）──
  yarnPriceCnyPerKg?: number;    // 纱线价 ¥/kg；缺省 180
  weightGsm?: number;            // 克重 g/m²；缺省 280
  widthM?: number;               // 幅宽 m；缺省 1.5
  weavingCostCny?: number;       // 织造费 ¥/米；缺省 8 × 织法系数
  weaveType?: 'plain' | 'twill' | 'jacquard';  // 缺省 twill
  dyeingCostCny?: number;        // 染整费 ¥/米；缺省 6
  // ── 通用 ──
  profitBenchmark?: number;      // 行业利润基准 %；缺省 garment 25 / fabric 15
  exchangeRate?: number;         // CNY per USD；提供时输出美元估算区间
  quantity?: number;             // 数量（仅透传展示，不参与单价计算）
  lines?: TrackACostLine[];      // 逐项覆盖：提供时以 lines 为真源重算合计
  sources?: Partial<Record<'fabric' | 'yarn', TrackASource>>;  // 服务层命中价格历史后注入
}
```

### 4.2 输出（TrackAResult）

```typescript
interface TrackAResult {
  category: 'garment' | 'fabric';
  unit: 'PC' | 'M';              // 件（成衣）/ 米（面料）
  lines: TrackACostLine[];       // 成本拆解（不含利润）
  costTotalCny: number;          // 成本合计（中位）¥
  profitBenchmark: number;       // 实际采用的利润基准 %
  priceMedianCny: number;        // 估算售价中位 ¥（含行业利润基准）
  priceLowCny: number;           // 下限 = 中位 × (1 - spread%)
  priceHighCny: number;          // 上限 = 中位 × (1 + spread%)
  priceMedianUsd: number | null; // 有汇率时输出
  priceLowUsd: number | null;
  priceHighUsd: number | null;
  spreadPercent: number;         // 区间系数（8 / 12 / 15）
  dataQuality: 'full_history' | 'partial' | 'benchmark_only';
}
```

### 4.3 计算流程

```
1. 校验输入（assertPositive / assertNonNegative）
2. 构建成本拆解行 lines：
   - 若 input.lines 非空 → 逐项覆盖模式（PRD §8.6 逐项可调）
   - 否则按 category 构建：
     garment: fabric / trimming / cmt / packaging（4 行）
     fabric:  yarn / weaving / dyeing（3 行）
   - 每行标注 source（price_history / industry_benchmark / manual）+ adjusted
3. 合计 costTotalCny = Σ lines.amountCny（round4）
4. 判定数据命中度 dataQuality：
   - 主材行（fabric/yarn）source ≠ industry_benchmark → full_history
   - 全部 source = industry_benchmark → benchmark_only
   - 其余 → partial
5. spreadPercent = SPREAD_BY_QUALITY[dataQuality]（8 / 12 / 15）
6. priceMedianCny = costTotalCny × (1 + profitBenchmark/100)
7. priceLowCny = priceMedianCny × (1 - spreadPercent/100)
   priceHighCny = priceMedianCny × (1 + spreadPercent/100)
8. 有汇率时换算 USD（round4）
```

### 4.4 行业基准常量（INDUSTRY_BENCHMARKS）

| 品类 | 字段 | 默认值 | 单位 |
|------|------|--------|------|
| garment | fabricPriceCnyPerM | 55 | ¥/米（羊毛精纺面料基准价） |
| garment | fabricConsumptionM | 1.5 | 米/件（西服类单件用量） |
| garment | fabricLossRate | 3 | % |
| garment | trimmingCostCny | 8 | ¥/件（拉链/纽扣/衬布/线/吊牌/包装袋） |
| garment | cmtBaseCny | 35 | ¥/件（裁剪+缝制+整烫） |
| garment | packagingCostCny | 3 | ¥/件 |
| garment | profitBenchmark | 25 | %（与轨道 B 默认利润率一致） |
| fabric | yarnPriceCnyPerKg | 180 | ¥/kg（羊毛精纺纱线基准价） |
| fabric | weightGsm | 280 | g/m² |
| fabric | widthM | 1.5 | m |
| fabric | weavingBaseCny | 8 | ¥/米 |
| fabric | dyeingCostCny | 6 | ¥/米 |
| fabric | profitBenchmark | 15 | % |

**系数表**：
- CMT_COMPLEXITY_FACTOR: simple=0.85 / standard=1.0 / complex=1.3
- WEAVE_TYPE_FACTOR: plain=1.0 / twill=1.15 / jacquard=1.4
- SPREAD_BY_QUALITY: full_history=8 / partial=12 / benchmark_only=15

**面料用纱量公式**：`yarnConsumptionKgPerM = (weightGsm × widthM) / 1000`

---

## §5 价格历史命中解析（estimateTrackA）

`pricingService.estimateTrackA(input)` 在纯函数输入上扩展价格历史命中：

```
若 category=garment 且 fabricPriceCny 未提供 且 fabricCode 非空：
  → 查 MaterialPriceHistory(materialType=fabric, materialCode=fabricCode) 最新价
  → 命中 → resolved.fabricPriceCny = hit.price, sources.fabric = 'price_history'

若 category=fabric 且 yarnPriceCnyPerKg 未提供 且 yarnCode 非空：
  → 查 MaterialPriceHistory(materialType=yarn, materialCode=yarnCode) 最新价
  → 命中 → resolved.yarnPriceCnyPerKg = hit.price, sources.yarn = 'price_history'

调用 calculateTrackA(resolved)
```

**命中优先级**：显式价格（manual）> 价格历史命中（price_history）> 行业基准（industry_benchmark）。

---

## §6 TrackAPanel 组件规格

### 6.1 Props

```typescript
interface TrackAPanelProps {
  onMedianUsdChange?: (medianUsd: number | null, unit?: 'PC' | 'M') => void;
  onInputsChange?: (input: TrackAInput | null) => void;
}
```

- `onMedianUsdChange`：估算中位 USD 变化时回传，供父组件（PricingManager / QuotationManager）做偏差校验
- `onInputsChange`：有效输入变化时回传，供父组件收集 Track A 输入用于 applyTrackPricing

### 6.2 交互流程

1. 用户选择品类（成衣 / 面料）→ 切换输入栅格
2. 填写输入项（面料编号 / 单价 / 用量 / 损耗率 / 辅料 / CMT / 复杂度 / 包装 / 利润基准 / 汇率）
3. 点击「估算」→ 调 `apiService.previewTrackA(buildInput())` → 服务端 estimateTrackA → 返回 TrackAResult
4. 估算结果展示：
   - 成本拆解行（逐项可调，改后失焦重算）
   - 估算区间三卡（下限 / 中位含利润 / 上限，CNY + USD 双币种）
   - 数据命中度徽章（full_history=success / partial=warning / benchmark_only=neutral）

### 6.3 逐项可调实时重算（PRD §8.6）

```
handleLineCommit(key, raw):
  1. 解析 raw 为数字 n
  2. next = result.lines.map(l => l.key === key ? { ...l, amountCny: n, source: 'manual', adjusted: true } : l)
  3. setEditedLines(next)
  4. 调 previewTrackA({ category, lines: next, exchangeRate, profitBenchmark })
  5. setResult(r); setEditedLines(null)  // 重算完成，result.lines 已含 adjusted 行
```

**关键规则**：手工改过的行标记 `adjusted: true + source: 'manual'`，重算仅更新未调整项（已调整行原样保留）。

### 6.4 数据展示

| 区块 | 展示内容 | 组件 |
|------|----------|------|
| 品类切换 | 成衣 / 面料 双段按钮 | `bg-surface-primary ring-1 ring-border-action` |
| 输入栅格 | 8-10 个 Field（按品类） | `grid-cols-2 gap-3` |
| 利润基准 / 汇率 | 通用 Field + 「最新」按钮带入 USD 汇率 | actionButtonClass |
| 估算按钮 | 「估算」+ 数据命中度徽章 | `bg-surface-primary border-border-action` |
| 成本拆解 | 逐行 label + input + source 标签 + 合计 | `bg-surface-primary rounded-inset` |
| 估算区间 | 三卡（下限 / 中位 / 上限），中位卡 `border-border-action` 高亮 | `grid-cols-3 gap-3` |

---

## §7 状态机

TrackAPanel 无独立状态机——估算结果有/无二态：

```
[无估算] ──点击「估算」──→ [估算中 previewing] ──成功──→ [有估算 result]
                              │                              │
                              └──失败──→ alert + 回到 [无估算] │
                                                             │
                              ┌──修改输入──→ resetResult() ──┘
                              │
                              └──修改拆解行──→ handleLineCommit ──→ [有估算 result（含 adjusted 行）]
```

**resetResult 触发条件**：品类切换 / 任何输入项变更（fabricCode / fabricPriceCny / fabricConsumptionM / fabricLossRate / trimmingCostCny / cmtCostCny / complexity / packagingCostCny / yarnCode / yarnPriceCnyPerKg / weightGsm / widthM / weavingCostCny / weaveType / dyeingCostCny / profitBenchmark / exchangeRate）。

---

## §8 数据模型与字段全量清单

轨道 A 不落库，但消费 MaterialPriceHistory 做价格历史命中：

| 字段 | 类型 | 用途 |
|------|------|------|
| materialType | String (yarn/fabric/trimming) | 命中查询过滤 |
| materialCode | String? | fabricCode / yarnCode 精确匹配 |
| price | Decimal(18,4) | 命中后注入 fabricPriceCny / yarnPriceCnyPerKg |
| priceDate | String (YYYY-MM-DD) | 排序依据（最新价） |
| createdAt | BigInt | priceDate 同日时次序兜底 |

**TrackACostLine 结构**（运行时对象，不落库）：
```typescript
{
  key: 'fabric' | 'trimming' | 'cmt' | 'packaging' | 'yarn' | 'weaving' | 'dyeing';
  label: string;
  amountCny: number;
  source: 'price_history' | 'industry_benchmark' | 'manual';
  adjusted?: boolean;
}
```

---

## §9 API 端点清单

### POST /v1/pricing/track-a-preview

**守卫**：读（JWT 或 API-Key）

**请求体**（TrackAPreviewInput extends TrackAInput）：
```json
{
  "category": "garment",
  "fabricCode": "FB-1001",
  "fabricPriceCny": 55,
  "fabricConsumptionM": 1.5,
  "fabricLossRate": 3,
  "trimmingCostCny": 8,
  "cmtCostCny": 35,
  "complexity": "standard",
  "packagingCostCny": 3,
  "profitBenchmark": 25,
  "exchangeRate": 7.10,
  "lines": null
}
```

**响应**（TrackAResult）：
```json
{
  "category": "garment",
  "unit": "PC",
  "lines": [
    { "key": "fabric", "label": "面料成本", "amountCny": 84.975, "source": "manual", "adjusted": true },
    { "key": "trimming", "label": "辅料成本", "amountCny": 8, "source": "industry_benchmark" },
    { "key": "cmt", "label": "CMT 加工费", "amountCny": 35, "source": "industry_benchmark" },
    { "key": "packaging", "label": "包装成本", "amountCny": 3, "source": "industry_benchmark" }
  ],
  "costTotalCny": 130.975,
  "profitBenchmark": 25,
  "priceMedianCny": 163.7188,
  "priceLowCny": 150.6213,
  "priceHighCny": 176.8163,
  "priceMedianUsd": 23.0584,
  "priceLowUsd": 21.2157,
  "priceHighUsd": 24.9011,
  "spreadPercent": 8,
  "dataQuality": "full_history"
}
```

**错误码**：400（非法品类 / 必须大于 0 / 非法） / 500（其他）

---

## §10 权限矩阵

| 角色 | 估算预览 | 逐项可调 | 价格历史命中 |
|------|----------|----------|--------------|
| 业务员 | ✅ | ✅ | ✅（按 fabricCode/yarnCode 命中） |
| 跟单员 | ✅ | ✅ | ✅ |
| 管理层 | ✅ | ✅ | ✅ |
| 财务 | ✅ | ✅ | ✅ |
| QC | ❌（无 Pricing 模块权限） | — | — |

轨道 A 估算无独立权限门控——只要能进入 PricingManager 或 QuotationManager 即可使用。佣金字段不在轨道 A 出现（佣金是轨道 B 专属）。

---

## §11 四态规范

| 状态 | 表现 | 实现路径 |
|------|------|----------|
| **空态** | 估算按钮可见但无结果区；输入项为空时 `parseNum` 返回 null，buildInput 仍可构造（缺省走行业基准） | TrackAPanel.tsx 初始 state |
| **加载态** | 「估算」按钮内 `Loader2 animate-spin` + `disabled={previewing}` | L312-L318 |
| **错误态** | `alert(估算失败: ${message})`；路由层 400/500 按消息关键字映射 | L178-L181 |
| **无权限** | 前端 modulePermissions 拦截，不渲染 TrackAPanel | 全局权限门控 |

---

## §12 业务规则 §8.1 / §8.6 关联项

| 规则 | 落地 |
|------|------|
| §8.1 成本分解 + 行业基准 + 区间系数 | calculateTrackA + INDUSTRY_BENCHMARKS + SPREAD_BY_QUALITY |
| §8.1 AI 校准学习属 Phase 4 | 当前为规则制常量，未基于历史成交价自动校准 |
| §8.4 仅内部使用 | TrackAPanel 标题「仅内部」+ 不出现在客户可见的报价单 PDF |
| §8.6 逐项可调实时重算 | handleLineCommit + adjusted 标记 + lines 覆盖模式 |
| §8.6 任何一项被手动改过后标记已调整，重算仅更新未调整项 | lines.map 保留 adjusted 行原样 |
| §8.6 双轨偏差校验标尺 | onMedianUsdChange 回传中位 USD 给父组件做偏差校验 |

---

## §13 可访问性 & 交互细节

- **品类切换**：双段按钮（成衣 / 面料），active 段 `ring-1 ring-border-action`
- **输入项**：所有 `bds-input` 原生 focus ring；`inputMode="decimal"` 移动端数字键盘
- **最新汇率按钮**：`actionButtonClass` 紧贴汇率输入框右侧，`RefreshCw` 图标 + 「最新」文字
- **估算按钮**：`Calculator` 图标 + 「估算」文字；previewing 时 `Loader2` 替换图标
- **数据命中度徽章**：`statusSemanticClass` 映射 success/warning/neutral，与 rdlBusinessStatusTokens 同源
- **成本拆解行**：label 固定 `w-24`，input 自适应 `flex-1`，source 标签固定 `w-16` 右对齐
- **估算区间三卡**：中位卡 `border border-border-action` 高亮，三卡均含 CNY 主数据 + USD 副数据

---

## §14 设计系统约束

- **BDS 语义类**：`bg-surface-elevated rounded-card p-5`（面板表面）/ `bg-surface-primary rounded-inset p-3`（拆解区与区间卡）/ `text-text-primary/secondary/tertiary`
- **token 类优先**：使用 `border-border-action` / `bg-surface-primary` 等 tailwind 语义类，不硬编码 hex / rounded-[Npx]
- **主题透明**：TrackAPanel 无 isDarkMode 分支，暗色由 tokens.css `[data-theme]` 统一覆盖
- **数字格式化**：`formatMoney` 使用 `toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })`；`bds-tnum` 等宽数字类

---

## §15 移动端适配

- 输入栅格 `grid-cols-2` 在窄屏（< 640px）自动降级为单列（依赖 tailwind responsive）
- 估算区间三卡 `grid-cols-3` 在窄屏保持三列（卡片内容自适应缩短）
- 成本拆解行在窄屏 label / input / source 三段可能拥挤，可考虑窄屏隐藏 source 标签（当前未做特殊处理）

---

## §16 相关文档索引（交叉链接）

- [模块概述.md](./模块概述.md) — Pricing 模块总览与子文档索引
- [轨道 B 退税美元定价.md](./轨道%20B%20退税美元定价.md) — 轨道 B 终价计算（偏差校验的对比方）
- [偏差校验与审批链.md](./偏差校验与审批链.md) — calculatePriceDeviation 使用 Track A 中位 USD 作为标尺
- [退税率表维护.md](./退税率表维护.md) — 退税率查询（轨道 A 不直接用，但轨道 B 命中后影响偏差对比）
- [../Orders-订单管理/订单详情页.md](../Orders-订单管理/订单详情页.md) — 订单详情页（轨道 A 估算的下游消费方之一）
- [../../../03-业务规则/价格审批规则.md](../../../03-业务规则/价格审批规则.md) — 价格审批规则（偏差阈值的业务规则真源）
