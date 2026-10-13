# TrackAPanel 组件规格 · 轨道 A 估算面板

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `TrackAPanel` |
| 定位 | 轨道 A 系统推荐估算器共享组件——基于成本分解（面料/辅料/工费/加工/包装/纱线/织造/染整）+ 行业基准 + 价格历史命中，输出估算售价区间（下限/中位/上限）。**仅内部使用**（PRD §8.4），不对客户展示，作为轨道 B 终价的「标尺」 |
| 文件路径 | `components/pricing/TrackAPanel.tsx`（381 行） |
| 消费方 | `PricingManager.tsx`（定价计算器 tab） / `QuotationManager.tsx`（报价编辑器双轨面板） |
| 范式 | 受控回传型——通过 `onMedianUsdChange` / `onInputsChange` 回传父组件，自身不落库 |
| 优先级 | P1（阶段 P2 轨道 A 估算器） |
| 实现状态 | ✅ 已落地（成衣/面料双 category + 拆解行失焦重算 + 价格历史命中 + 数据质量徽章 + 利润基准/汇率输入 + 最新汇率一键带入）；⚠️ 四态规范中的「无权限」态当前由父组件层控制（轨道 A 仅内部使用，权限约束在页面层） |
| PRD 关联 | PRD §8.1（轨道 A 系统估算）/ §8.4（仅内部使用）/ §8.6（双轨联动校验） |
| 代码关联 | [TrackAPanel.tsx](../../components/pricing/TrackAPanel.tsx) / [trackAEstimator.ts](../../server/src/pricing/trackAEstimator.ts)（`calculateTrackA` 纯函数 + `calculatePriceDeviation` 阈值同源） / [pricingRoute.ts](../../server/src/pricing/pricingRoute.ts)（`/v1/pricing/track-a/preview`） / [apiService.ts](../../services/apiService.ts) `previewTrackA / getLatestFxRates` / [rdlBusinessStatusTokens.ts](../../components/rdlBusinessStatusTokens.ts) `statusSemanticClass` / `types.ts` `TrackACategory / TrackASource / TrackACostLine / TrackADataQuality / TrackAInput / TrackAResult`（第 4517–4567 行） |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架（Props 接口 + 内部结构）

```ts
export interface TrackAPanelProps {
  /** 估算中位（USD）变化时回传，供报价编辑器偏差校验使用；无汇率/无结果时回传 null */
  onMedianUsdChange?: (medianUsd: number | null, unit?: 'PC' | 'M') => void;
  /** 有效输入变化时回传，供父组件收集 Track A 输入用于 applyTrackPricing */
  onInputsChange?: (input: TrackAInput | null) => void;
}

// 内部状态（无 props 受控输入，全部内部 state）
const [category, setCategory] = useState<TrackACategory>('garment');  // 'garment' | 'fabric'
// 成衣输入
const [fabricCode, setFabricCode] = useState('');                     // 命中 MaterialPriceHistory(fabric)
const [fabricPriceCny, setFabricPriceCny] = useState('');
const [fabricConsumptionM, setFabricConsumptionM] = useState('');
const [fabricLossRate, setFabricLossRate] = useState('');
const [trimmingCostCny, setTrimmingCostCny] = useState('');
const [cmtCostCny, setCmtCostCny] = useState('');
const [complexity, setComplexity] = useState<'simple'|'standard'|'complex'>('standard');
const [packagingCostCny, setPackagingCostCny] = useState('');
// 面料输入
const [yarnCode, setYarnCode] = useState('');                         // 命中 MaterialPriceHistory(yarn)
const [yarnPriceCnyPerKg, setYarnPriceCnyPerKg] = useState('');
const [weightGsm, setWeightGsm] = useState('');
const [widthM, setWidthM] = useState('');
const [weavingCostCny, setWeavingCostCny] = useState('');
const [weaveType, setWeaveType] = useState<'plain'|'twill'|'jacquard'>('twill');
const [dyeingCostCny, setDyeingCostCny] = useState('');
// 通用
const [profitBenchmark, setProfitBenchmark] = useState('');
const [exchangeRate, setExchangeRate] = useState('');
// 结果
const [result, setResult] = useState<TrackAResult | null>(null);
const [editedLines, setEditedLines] = useState<TrackACostLine[] | null>(null);
const [previewing, setPreviewing] = useState(false);
```

### 渲染结构

```
<div className="bg-surface-elevated rounded-card p-5">
  ├─ Header：标题 + category 切换（成衣/面料）
  ├─ 输入栅格（grid-cols-2 gap-3）：
  │   ├─ garment 分支：8 字段（fabricCode/Price/Consumption/LossRate/trimming/cmt/complexity/packaging）
  │   ├─ fabric 分支：7 字段（yarnCode/Price/weightGsm/widthM/weaving/weaveType/dyeing）
  │   └─ 通用：profitBenchmark + exchangeRate（含「最新」按钮）
  ├─ 操作行：[估算] 按钮 + 数据质量徽章
  └─ 结果区（result!=null 时）：
      ├─ 成本拆解卡（rounded-inset）：逐行可编辑 input + source 标签 + 成本合计
      └─ 估算区间三卡（grid-cols-3）：下限 / 中位（border-action 强调）/ 上限
</div>
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `onMedianUsdChange` | `(medianUsd: number \| null, unit?: 'PC' \| 'M') => void` | 否 | — | 估算中位 USD 变化时回传；`result?.priceMedianUsd ?? null` + `result?.unit`；供父组件传给 `DeviationBadge` 做偏差校验 |
| `onInputsChange` | `(input: TrackAInput \| null) => void` | — | — | 有效输入变化时回传；`buildInput()` 返回 `TrackAInput`；供父组件收集用于 `applyTrackPricing` |

**回传时机**：
- `onMedianUsdChange`：`useEffect([result, onMedianUsdChange])`，result 变化即回传
- `onInputsChange`：`useEffect([category, exchangeRate, profitBenchmark, fabricCode, ..., editedLines, onInputsChange])`，任一输入变化即回传

**无受控输入**：TrackAPanel 不接受外部受控值——所有输入内部 state 管理，父组件仅通过回调被动接收。这是产品意图：轨道 A 估算输入不持久化，每次进入页面重新输入。

---

## §4 内部状态管理

### §4.1 状态分类

| 类别 | 字段 | 用途 |
|---|---|---|
| category 切换 | `category` | 'garment' / 'fabric'，切换时 `resetResult()` 清空结果 |
| 成衣输入（8） | `fabricCode / fabricPriceCny / fabricConsumptionM / fabricLossRate / trimmingCostCny / cmtCostCny / complexity / packagingCostCny` | 仅 category='garment' 时渲染 |
| 面料输入（7） | `yarnCode / yarnPriceCnyPerKg / weightGsm / widthM / weavingCostCny / weaveType / dyeingCostCny` | 仅 category='fabric' 时渲染 |
| 通用输入（2） | `profitBenchmark / exchangeRate` | 两 category 共用 |
| 结果 | `result: TrackAResult \| null` | 服务端 `previewTrackA` 返回 |
| 编辑态 | `editedLines: TrackACostLine[] \| null` | 用户改过拆解行后的临时覆盖；重算完成后置 null（result.lines 已含 adjusted 行） |
| 加载态 | `previewing: boolean` | 估算/重算进行中 |

### §4.2 输入变化 → resetResult

每个输入字段 onChange 时调用 `resetResult()`（`setResult(null); setEditedLines(null);`），强制用户重新点「估算」——避免展示过期结果与当前输入不匹配。

### §4.3 buildInput 构建逻辑

```ts
function buildInput(): TrackAInput {
  const fx = parseNum(exchangeRate);
  const pb = parseNum(profitBenchmark);
  // 逐项覆盖模式：用户改过拆解行后以 lines 为真源重算
  if (editedLines) {
    return { category, lines: editedLines,
      ...(fx !== null ? { exchangeRate: fx } : {}),
      ...(pb !== null ? { profitBenchmark: pb } : {}) };
  }
  // 否则按字段构建
  const input: TrackAInput = { category };
  if (fx !== null) input.exchangeRate = fx;
  if (pb !== null) input.profitBenchmark = pb;
  if (category === 'garment') {
    if (fabricCode.trim()) input.fabricCode = fabricCode.trim();
    // ... 6 个数值字段映射
    input.complexity = complexity;
  } else {
    if (yarnCode.trim()) input.yarnCode = yarnCode.trim();
    // ... 5 个数值字段映射
    input.weaveType = weaveType;
  }
  return input;
}
```

**关键纪律**：
- 空字符串字段不写入 input（`parseNum` 返回 null 时跳过），让服务端用基准值兜底
- `editedLines` 优先级最高——用户改过拆解行后，原字段输入被忽略，以 lines 为真源

---

## §5 实时计算逻辑（handleLineCommit → calculateTrackA）

### §5.1 估算预览 handlePreview

```
用户点「估算」
  ↓
setPreviewing(true)
  ↓
apiService.previewTrackA(buildInput())   ← POST /v1/pricing/track-a/preview
  ↓
setResult(r)                              ← 服务端 calculateTrackA 返回
setEditedLines(null)                      ← 新估算以服务端拆解为基线
  ↓
setPreviewing(false)
  ↓
useEffect 触发 onMedianUsdChange(r.priceMedianUsd, r.unit)
```

### §5.2 拆解行失焦重算 handleLineCommit（PRD 8.6 逐项可调）

```
用户改某拆解行 input → onBlur 触发
  ↓
parseNum(raw) === null || n < 0 → return（无效输入不重算）
parseNum(raw) === line.amountCny → return（值未变不重算）
  ↓
next = result.lines.map(l => l.key === key
  ? { ...l, amountCny: n, source: 'manual', adjusted: true }  ← 标记 adjusted + manual
  : l)
  ↓
setEditedLines(next)
setPreviewing(true)
  ↓
apiService.previewTrackA({ category, lines: next,
  exchangeRate: fx, profitBenchmark: pb })   ← 以 lines 为真源重算
  ↓
setResult(r)                                  ← 新结果含 adjusted 行
setEditedLines(null)                          ← 重算完成，result.lines 已是最新
  ↓
setPreviewing(false)
```

**关键纪律**：
- 派生值（成本合计/估算区间/美元换算）**一律以后端 `calculateTrackA` 返回为准**——前端不做本地计算
- 拆解行失焦重算标记 `source='manual' + adjusted=true`，区分用户改过的行与服务端基准行
- 重算完成后 `editedLines` 置 null，下次 `buildInput` 走 `result.lines` 分支（已含 adjusted 行）

### §5.3 服务端 calculateTrackA 真源

| 输入 | 输出 |
|---|---|
| `TrackAInput`（category + 字段 + lines + exchangeRate + profitBenchmark） | `TrackAResult`（lines + costTotalCny + priceLow/Median/High Cny/USD + profitBenchmark + spreadPercent + dataQuality） |

**数据质量分级**：
- `full_history`：数据充分 ±8%（success 绿）
- `partial`：部分基准 ±12%（warning 橙）
- `benchmark_only`：行业基准 ±15% 无历史校准（neutral 中性）

---

## §6 价格历史查询

### §6.1 命中机制

| 字段 | category | 命中真源 |
|---|---|---|
| `fabricCode` | garment | `MaterialPriceHistory(fabric)` 最新价 |
| `yarnCode` | fabric | `MaterialPriceHistory(yarn)` 最新价 |

**命中后行为**：服务端 `calculateTrackA` 用命中价格覆盖用户输入的 `fabricPriceCny` / `yarnPriceCnyPerKg`，并在 `result.lines` 中对应行标记 `source='price_history'`。

### §6.2 source 标签展示

| source 值 | 标签文案 |
|---|---|
| `price_history` | 价格历史 |
| `industry_benchmark` | 行业基准 |
| `manual` | 手工·已调整（用户改过时追加） |

### §6.3 最新汇率一键带入

```
用户点「最新」按钮
  ↓
apiService.getLatestFxRates()   ← GET /v1/exchange-rates/latest
  ↓
rates.find(r => r.currency === 'USD')
  ↓
setExchangeRate(String(usd.rate))
  ↓
resetResult()                    ← 清空过期估算
```

失败时 `alert('获取最新汇率失败')` + console.error。

---

## §7 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 空态：未估算 | `result === null && !previewing` | 仅输入栅格 + 「估算」按钮 | 「估算」按钮可点击 |
| 加载中 | `previewing === true` | 「估算」按钮内 `Loader2` + `animate-spin` + disabled | 不显示文案 |
| 错误 | `previewTrackA` 抛异常 | `alert('估算失败: ${e.message}')` + console.error | 弹窗显示错误信息 |
| 无权限 | 父组件层控制（轨道 A 仅内部使用，无独立 scope） | 父组件不渲染 TrackAPanel | — |
| 估算完成 | `result !== null` | 成本拆解卡 + 估算区间三卡 + 数据质量徽章 | 数据质量徽章显示分级 |
| 拆解行已调整 | `line.adjusted === true` | source 标签追加「·已调整」 | 「手工·已调整」 |

> **无权限态说明**：轨道 A 估算器**仅内部使用**（PRD §8.4），不对客户展示。权限约束在页面层（PricingManager / QuotationManager）控制——无 `pricing:read` scope 的角色不渲染本组件，组件内不重复实现权限态。

---

## §8 数据流与父组件联动

```
TrackAPanel
  ├─ onMedianUsdChange(usd, unit) ──► 父组件 setTrackAMedian({usd, unit})
  └─ onInputsChange(input)         ──► 父组件收集（用于 applyTrackPricing）

父组件 PricingManager 联动：
  TrackAPanel.onMedianUsdChange + TrackBPanel.onResultChange
    ↓
  DeviationBadge { finalUsd: trackBResult.finalUnitPrice,
                   medianUsd: trackAMedian.usd,
                   medianUnit: trackAMedian.unit }
    ↓
  computePriceDeviation() → { deviationPercent, level: ok|warn|block }
```

---

## §9 状态机（估算 + 拆解重算）

```
   init ──点估算──► previewing ──成功──► ready (result)
                       │                     │
                       │ fail                │ 改拆解行 onBlur
                       ▼                     ▼
                    error (alert)      previewing (重算) ──成功──► ready (新 result)
                                             │
                                             │ fail
                                             ▼
                                          error (console.error，不 alert)
```

| 状态 | 字段 | 行为 |
|---|---|---|
| `init` | `result=null, previewing=false` | 输入栅格可编辑，「估算」可点击 |
| `previewing` | `previewing=true` | 「估算」按钮 disabled + Loader2 旋转 |
| `ready` | `result!=null, previewing=false` | 显示结果区，拆解行可编辑 |
| `error` | `previewTrackA` 抛异常 | 估算失败 alert；拆解重算失败 console.error（不 alert 避免打扰） |

---

## §10 数据模型（TrackA* 类型族）

真源：`types.ts:4517-4567`

```ts
type TrackACategory = 'garment' | 'fabric';
type TrackASource = 'price_history' | 'industry_benchmark' | 'manual';
type TrackADataQuality = 'full_history' | 'partial' | 'benchmark_only';

interface TrackACostLine {
  key: string;            // fabric | trimming | cmt | packaging | yarn | weaving | dyeing
  label: string;
  amountCny: number;
  source: TrackASource;
  adjusted?: boolean;     // 用户改过时 true
}

interface TrackAInput {
  category: TrackACategory;
  fabricPriceCny?: number;
  fabricConsumptionM?: number;
  fabricLossRate?: number;
  trimmingCostCny?: number;
  cmtCostCny?: number;
  complexity?: 'simple' | 'standard' | 'complex';
  packagingCostCny?: number;
  yarnPriceCnyPerKg?: number;
  weightGsm?: number;
  widthM?: number;
  weavingCostCny?: number;
  weaveType?: 'plain' | 'twill' | 'jacquard';
  dyeingCostCny?: number;
  profitBenchmark?: number;
  exchangeRate?: number;
  quantity?: number;
  lines?: TrackACostLine[];          // 逐项覆盖模式真源
  fabricCode?: string;               // 命中 MaterialPriceHistory(fabric)
  yarnCode?: string;                 // 命中 MaterialPriceHistory(yarn)
}

interface TrackAResult {
  category: TrackACategory;
  unit: 'PC' | 'M';                  // PC=成衣件 / M=面料米
  lines: TrackACostLine[];
  costTotalCny: number;
  profitBenchmark: number;
  priceMedianCny: number;
  priceLowCny: number;
  priceHighCny: number;
  priceMedianUsd: number | null;     // 无汇率时 null
  priceLowUsd: number | null;
  priceHighUsd: number | null;
  spreadPercent: number;             // 区间展开幅度
  dataQuality: TrackADataQuality;
}
```

---

## §11 API 端点清单

| 端点 | 方法 | 用途 | 调用方 |
|---|---|---|---|
| `/v1/pricing/track-a/preview` | POST | 估算预览（含拆解行重算） | `apiService.previewTrackA(buildInput())` |
| `/v1/exchange-rates/latest` | GET | 最新汇率一键带入 | `apiService.getLatestFxRates()` |

**响应**：`TrackAResult` JSON。**无 mutation**——纯计算端点，不落库。

---

## §12 权限与可见性

| 角色 | 可见 TrackAPanel | 可编辑拆解行 | 可见价格历史命中 |
|---|---|---|---|
| Sales / SalesManager | ✅（内部使用，不对客户展示） | ✅ | ✅ |
| Finance / FinanceManager | ✅ | ✅ | ✅ |
| Admin / SuperAdmin | ✅ | ✅ | ✅ |
| Operations / Warehouse | ❌（父组件层不渲染） | — | — |

> **铁律**：轨道 A 估算**仅内部使用**（PRD §8.4），不对客户展示。父组件（PricingManager / QuotationManager）控制渲染门禁；组件内不重复实现权限态。

---

## §13 设计系统约束（BDS）

- **容器**：`bg-surface-elevated rounded-card p-5`
- **输入框**：`inputClass = "w-full bg-surface-primary text-text-primary text-sm rounded-control px-3 py-2 border border-border-subtle outline-none focus:border-border-action"`
- **操作按钮**：`actionButtonClass = "flex items-center gap-1 px-2.5 py-1 text-xs rounded-control bg-surface-elevated text-text-secondary hover:text-text-primary hover:ring-1 hover:ring-border-action transition-all disabled:opacity-50"`
- **估算按钮**：`bg-surface-primary text-text-primary border border-border-action hover:bg-surface-secondary`
- **圆角**：`rounded-card`（容器）/ `rounded-control`（输入/按钮）/ `rounded-inset`（结果卡），禁止硬编码 `rounded-[Npx]`
- **颜色**：`bg-surface-primary/elevated` / `text-text-primary/secondary/tertiary` / `border-border-subtle/action` 全部走 BDS 语义类
- **数据质量徽章**：`statusSemanticClass(TRACKA_QUALITY_SEMANTIC[dataQuality])` → success/warning/neutral 语义色
- **字重**：`text-sm font-medium`（标题）/ `text-xs`（标签）/ `text-base font-medium`（数值）
- **数字对齐**：`formatMoney` 用 `toLocaleString('zh-CN', {min:2, max:4})`
- **防回退**：`scripts/check-design-tokens.sh` 扫描硬编码

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-TA1 | 拆解行重算失败仅 console.error，用户无感知 | 用户以为已重算但实际失败 | P2 |
| GAP-TA2 | 无 loading 骨架屏（仅按钮 Loader2） | 重算期间结果区闪空 | P3 |
| GAP-TA3 | 拆解行 input 用 `defaultValue` + `key={line.key-amountCny}` 强制重渲染，用户输入光标位置可能丢失 | 长数字输入体验受影响 | P3 |
| GAP-TA4 | 无「重置拆解」按钮（撤销所有 adjusted 行） | 用户改过后无法回到服务端基准 | P2 |
| GAP-TA5 | 价格历史命中无显性提示（仅 source 标签变化） | 用户不知道命中了哪条历史记录 | P2 |

---

## §15 相关文档索引

- [../00-索引.md](../00-索引.md) — 设计文档真源总索引
- [../04-模块设计/03-订单与生产/Pricing-定价与成本/轨道 A 系统估算器.md](../04-模块设计/03-订单与生产/Pricing-定价与成本/轨道%20A%20系统估算器.md) — calculateTrackA 纯函数 + 服务端口径
- [../04-模块设计/03-订单与生产/Pricing-定价与成本/偏差校验与审批链.md](../04-模块设计/03-订单与生产/Pricing-定价与成本/偏差校验与审批链.md) — 双轨偏差阈值
- [../04-模块设计/03-订单与生产/Pricing-定价与成本/模块概述.md](../04-模块设计/03-订单与生产/Pricing-定价与成本/模块概述.md) — Pricing 模块总览
- [TrackBPanel.md](./TrackBPanel.md) — 轨道 B 退税美元定价面板（双轨联动对侧）
- [DeviationBadge.md](./DeviationBadge.md) — 双轨偏差校验徽章（消费 TrackA 中位 USD）
- [../01-产品总览/5. 全局交互规范.md](../01-产品总览/5.%20全局交互规范.md) — prime 跳转 / 状态徽章
- [../03-业务规则/价格审批规则.md](../03-业务规则/价格审批规则.md) — 双轨偏差触发审批规则

---

## §16 补充说明

1. **逐项覆盖模式铁律**：用户改过拆解行后，`editedLines` 优先级最高——原字段输入被忽略，以 lines 为真源重算。这避免「用户改了面料行但 fabricPriceCny 字段还是旧值」的不一致
2. **失焦重算 vs 实时重算**：选择失焦（onBlur）而非实时（onChange）重算，避免每次按键都触发服务端请求；同时 `parseNum(raw) !== line.amountCny` 守卫避免值未变时无谓重算
3. **数据质量分级口径**：`full_history ±8%` / `partial ±12%` / `benchmark_only ±15%`——这三个区间是服务端 `calculateTrackA` 根据 MaterialPriceHistory 命中数量与行业基准覆盖度计算的，前端仅展示
4. **估算仅内部使用**：轨道 A 估算结果**不对客户展示**（PRD §8.4），仅作为轨道 B 终价的「标尺」与偏差校验基准。父组件渲染时需确保不将 TrackAResult 暴露到客户可见的报价单 PDF / 邮件中
5. **defaultValue + key 强制重渲染**：拆解行 input 用 `defaultValue={String(line.amountCny)}` + `key={line.key-amountCny}`，当 result.lines 更新时 key 变化强制 React 重建 input——这是非受控 input 同步服务端值的常用模式，但代价是用户输入光标位置可能丢失（GAP-TA3）
6. **空字段不写入 input**：`parseNum` 返回 null 时跳过该字段，让服务端用基准值兜底——这是产品意图，用户只需填写已知字段，未知字段由服务端补全
