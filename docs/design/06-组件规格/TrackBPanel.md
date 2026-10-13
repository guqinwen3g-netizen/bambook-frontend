# TrackBPanel 组件规格 · 轨道 B 退税美元定价面板

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `TrackBPanel` |
| 定位 | 轨道 B 退税美元定价共享组件——采购成本 → 退税 → 净 USD 成本 → 利润 → 佣金 → 最终 USD 单价。外贸口径的「对外报价真源」，派生值一律服务端重算，前端不做本地计算 |
| 文件路径 | `components/pricing/TrackBPanel.tsx`（269 行） |
| 消费方 | `PricingManager.tsx`（定价计算器 tab，含保存定价记录 actions + 数量/备注 children） / `QuotationManager.tsx`（报价编辑器双轨面板） |
| 范式 | 受控回传型 + 可扩展 children/actions——通过 `onResultChange` / `onInputsChange` 回传父组件，自身不落库；通过 `children` / `actions` 注入额外字段与按钮 |
| 优先级 | P1（阶段 P1 退税定价 + P2 佣金规则） |
| 实现状态 | ✅ 已落地（采购成本/HS Code/退税率/汇率/利润率/佣金 6 输入 + HS 最长前缀命中退税率 + 最新汇率一键带入 + 佣金选择 4 口径 + 试算预览 4 卡 + 有效输入 useMemo 校验）；⚠️ 佣金仅管理层+财务可见的权限约束由页面层控制（组件内不重复实现） |
| PRD 关联 | PRD §8.2（轨道 B 退税美元定价）/ §8.5（退税率/佣金规则配置）/ §8.6（双轨联动校验）/ §9.6（行级权限） |
| 代码关联 | [TrackBPanel.tsx](../../components/pricing/TrackBPanel.tsx) / [pricingService.ts](../../server/src/pricing/pricingService.ts)（`calculateTrackB` 纯函数） / [commissionService.ts](../../server/src/pricing/commissionService.ts)（佣金规则中间人命中） / [pricingRoute.ts](../../server/src/pricing/pricingRoute.ts)（`/v1/pricing/track-b/preview`） / [apiService.ts](../../services/apiService.ts) `previewTrackB / lookupTaxRefundRate / getLatestFxRates / listCommissionRules` / `types.ts` `TrackBResult / TrackBInput / CommissionRule / PricingCalculation`（第 4508–4645 行） |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架（Props 接口 + 内部结构）

```ts
export interface TrackBValidInputs {
  purchaseCostCny: number;
  refundRate: number;
  exchangeRate: number;
  profitMargin: number;
  commissionRate: number;
  commissionRuleId: string | null;
  hsCode: string;            // trim 后，可能为空串
}

export interface TrackBPanelProps {
  title?: string;                                                    // 默认「轨道 B 试算（退税美元定价）」
  /** 试算结果变化（含输入变更导致的清空） */
  onResultChange?: (result: TrackBResult | null) => void;
  /** 有效输入变化（保存定价记录 / 偏差校验用） */
  onInputsChange?: (inputs: TrackBValidInputs | null) => void;
  /** 额外输入字段（渲染于输入栅格末尾，如数量 / 备注） */
  children?: React.ReactNode;
  /** 额外操作按钮（渲染于「试算预览」右侧，如保存定价记录） */
  actions?: React.ReactNode;
}

// 内部状态
const [purchaseCostCny, setPurchaseCostCny] = useState('');
const [hsCode, setHsCode] = useState('');
const [refundRate, setRefundRate] = useState('');
const [exchangeRate, setExchangeRate] = useState('');
const [profitMargin, setProfitMargin] = useState('');
const [commissionRate, setCommissionRate] = useState('0');
const [commissionRuleId, setCommissionRuleId] = useState<string | null>(null);
const [commissionRules, setCommissionRules] = useState<CommissionRule[]>([]);

const [preview, setPreview] = useState<TrackBResult | null>(null);
const [previewing, setPreviewing] = useState(false);
const [lookupHint, setLookupHint] = useState<string | null>(null);
```

### 渲染结构

```
<div className="bg-surface-elevated rounded-card p-5">
  ├─ Header：title（默认「轨道 B 试算（退税美元定价）」）
  ├─ 输入栅格（grid-cols-2 gap-3）：
  │   ├─ 采购成本（CNY 单价）
  │   ├─ HS Code（含「查税率」按钮）
  │   ├─ 退税率（%）
  │   ├─ 汇率（CNY/USD，含「最新」按钮）
  │   ├─ 利润率（%）
  │   ├─ 佣金选择（无 / E5 / E10 / 规则快照 dropdown）
  │   └─ {children}  ← 父组件注入额外字段（如数量/备注）
  ├─ lookupHint 提示（命中/未命中/查询失败）
  ├─ 操作行：[试算预览] 按钮 + {actions}  ← 父组件注入额外按钮（如保存定价记录）
  └─ 结果区（preview!=null 时）：4 卡 grid-cols-2
      ├─ 退税后美元成本 netUsdCost
      ├─ 利润额 profitAmount
      ├─ 佣金额 commissionAmount
      └─ 终价美元单价 finalUnitPrice（border-action 强调）
</div>
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `title` | `string` | 否 | `'轨道 B 试算（退税美元定价）'` | 面板标题，父组件可自定义 |
| `onResultChange` | `(result: TrackBResult \| null) => void` | 否 | — | 试算结果变化时回传；输入变更导致清空时回传 null；供父组件传给 `DeviationBadge` |
| `onInputsChange` | `(inputs: TrackBValidInputs \| null) => void` | 否 | — | 有效输入变化时回传；输入不全时回传 null；供父组件保存定价记录 |
| `children` | `React.ReactNode` | 否 | — | 额外输入字段，渲染于输入栅格末尾；PricingManager 注入「数量」「备注」字段 |
| `actions` | `React.ReactNode` | 否 | — | 额外操作按钮，渲染于「试算预览」右侧；PricingManager 注入「保存定价记录」按钮 |

**回传时机**：
- `onResultChange`：`useEffect([preview, onResultChange])`，preview 变化即回传
- `onInputsChange`：`useEffect([validInput, onInputsChange])`，validInput 变化即回传

**可扩展设计**：`children` / `actions` 是产品意图——TrackBPanel 仅承担试算本体，业务定制（数量/备注/保存按钮）由父组件注入，避免组件膨胀。

---

## §4 佣金选择口径（含佣/不含佣）

### §4.1 四口径选择

| 口径 | 值 | 含义 | commissionRuleId | commissionRate |
|---|---|---|---|---|
| 无佣金 | `''` | 0% 佣金 | null | '0' |
| E5 手工口径 | `'E5'` | 5% 佣金 | null | '5' |
| E10 手工口径 | `'E10'` | 10% 佣金 | null | '10' |
| 规则快照 | `rule.id` | 命中 CommissionRule 配置 | rule.id | String(rule.rate) |

### §4.2 handleCommissionSelect 逻辑

```ts
function handleCommissionSelect(value: string) {
  setPreview(null);                          // 切换口径清空试算结果
  if (value === '') {
    setCommissionRuleId(null);
    setCommissionRate('0');
  } else if (value === 'E5' || value === 'E10') {
    setCommissionRuleId(null);
    setCommissionRate(value === 'E5' ? '5' : '10');
  } else {
    const rule = commissionRules.find(r => r.id === value);
    if (!rule) return;
    setCommissionRuleId(rule.id);            // 落库时 commissionRate 为规则值快照
    setCommissionRate(String(rule.rate));
  }
}
```

### §4.3 dropdown value 反推

```ts
value={commissionRuleId ?? (commissionRate === '5' ? 'E5' : commissionRate === '10' ? 'E10' : '')}
```

- `commissionRuleId != null` → 显示规则 id（规则快照态）
- `commissionRate === '5'` → 显示 'E5'（手工 5% 态）
- `commissionRate === '10'` → 显示 'E10'（手工 10% 态）
- 否则 → 显示 ''（无佣金态）

### §4.4 佣金规则加载

```
组件 mount
  ↓
apiService.listCommissionRules()   ← GET /v1/pricing/commission-rules
  ↓
setCommissionRules(rules)          ← 渲染到 dropdown options
```

失败时 `console.error('[TrackBPanel] listCommissionRules failed', e)`，不阻断其他输入。

### §4.5 佣金权限约束

> ⚠️ **由页面层控制**——佣金仅管理层+财务可见。TrackBPanel 组件内不重复实现权限态；父组件（PricingManager / QuotationManager）按 `commission:read` scope 决定是否渲染佣金 Field。

---

## §5 实时计算逻辑（calculateTrackB）

### §5.1 有效输入校验 validInput（useMemo）

```ts
const validInput = useMemo<TrackBValidInputs | null>(() => {
  const cost = parseNum(purchaseCostCny);
  const refund = parseNum(refundRate);
  const fx = parseNum(exchangeRate);
  const margin = parseNum(profitMargin);
  if (cost === null || cost <= 0) return null;      // 采购成本必填且 > 0
  if (refund === null || refund < 0) return null;   // 退税率必填且 >= 0
  if (fx === null || fx <= 0) return null;          // 汇率必填且 > 0
  if (margin === null) return null;                 // 利润率必填
  return {
    purchaseCostCny: cost,
    refundRate: refund,
    exchangeRate: fx,
    profitMargin: margin,
    commissionRate: parseNum(commissionRate) ?? 0,  // 佣金率缺省 0
    commissionRuleId,
    hsCode: hsCode.trim(),
  };
}, [purchaseCostCny, refundRate, exchangeRate, profitMargin,
    commissionRate, commissionRuleId, hsCode]);
```

**校验规则**：
- 采购成本 / 退税率 / 汇率 / 利润率 4 项必填，缺一返回 null
- 采购成本 > 0 / 退税率 >= 0 / 汇率 > 0（业务合理性）
- 佣金率缺省 0（无佣金时）
- hsCode trim 后允许空串（不强制要求 HS Code）

### §5.2 试算预览 handlePreview

```
用户点「试算预览」
  ↓
validInput === null → alert('请完整填写采购成本 / 退税率 / 汇率 / 利润率') + return
  ↓
setPreviewing(true)
  ↓
apiService.previewTrackB({
  purchaseCostCny: validInput.purchaseCostCny,
  refundRate: validInput.refundRate,
  exchangeRate: validInput.exchangeRate,
  profitMargin: validInput.profitMargin,
  commissionRate: validInput.commissionRate,
})                                  ← POST /v1/pricing/track-b/preview
  ↓
setPreview(result)                  ← 服务端 calculateTrackB 返回
  ↓
setPreviewing(false)
  ↓
useEffect 触发 onResultChange(result)
```

### §5.3 输入变更清空结果

每个输入字段 onChange 时 `setPreview(null)`，强制用户重新点「试算预览」——避免展示过期结果与当前输入不匹配。

### §5.4 服务端 calculateTrackB 真源

| 输入 | 输出 |
|---|---|
| `TrackBInput { purchaseCostCny, refundRate, exchangeRate, profitMargin, commissionRate? }` | `TrackBResult { netUsdCost, profitAmount, commissionAmount, finalUnitPrice }` |

**计算公式**（服务端纯函数，前端不重复）：
- `netUsdCost = (purchaseCostCny * (1 - refundRate/100)) / exchangeRate`
- `profitAmount = netUsdCost * profitMargin / 100`
- `commissionAmount = (netUsdCost + profitAmount) * commissionRate / 100`
- `finalUnitPrice = netUsdCost + profitAmount + commissionAmount`

**关键纪律**：派生值（netUsdCost / profitAmount / commissionAmount / finalUnitPrice）**一律以后端 `calculateTrackB` 返回为准**，前端不做本地计算——避免前后端口径不一致。

---

## §6 输入控件详述

### §6.1 采购成本（CNY 单价）

| 属性 | 值 |
|---|---|
| placeholder | `如 32.50` |
| inputMode | `decimal` |
| onChange | `setPurchaseCostCny + setPreview(null)` |
| 校验 | `parseNum != null && > 0` 才计入 validInput |

### §6.2 HS Code（可查退税率）

| 属性 | 值 |
|---|---|
| placeholder | `如 5407520000` |
| 附加按钮 | 「查税率」`<Search>` 图标 + `actionButtonClass` |
| 查询逻辑 | `handleLookupRate` 调 `apiService.lookupTaxRefundRate(code)` |
| 命中提示 | `lookupHint = '命中 HS ${hit.hsCode}，退税率 ${hit.rate}%'` + `setRefundRate(String(hit.rate))` |
| 未命中 | `lookupHint = '未命中退税率，请手工录入'` |
| 查询失败 | `lookupHint = '查询失败，请手工录入'` |
| 最长前缀命中 | 服务端按 HS Code 最长前缀匹配 TaxRefundRate 表 |

### §6.3 退税率（%）

| 属性 | 值 |
|---|---|
| placeholder | `如 13` |
| inputMode | `decimal` |
| onChange | `setRefundRate + setPreview(null)` |
| 校验 | `parseNum != null && >= 0` 才计入 validInput |

### §6.4 汇率（CNY/USD）

| 属性 | 值 |
|---|---|
| placeholder | `如 7.10` |
| inputMode | `decimal` |
| 附加按钮 | 「最新」`<RefreshCw>` 图标 + `actionButtonClass` |
| 最新逻辑 | `handleFetchLatestFx` 调 `apiService.getLatestFxRates()` → 找 USD → `setExchangeRate(String(usd.rate))` |
| 校验 | `parseNum != null && > 0` 才计入 validInput |

### §6.5 利润率（%）

| 属性 | 值 |
|---|---|
| placeholder | `如 15` |
| inputMode | `decimal` |
| onChange | `setProfitMargin + setPreview(null)` |
| 校验 | `parseNum != null` 才计入 validInput（允许 0% 利润率） |

### §6.6 佣金选择（无 / E5 / E10 / 规则快照）

| 属性 | 值 |
|---|---|
| 控件 | `<select>` dropdown |
| options | 无佣金（0%）/ E5（5%）/ E10（10%）/ 动态规则列表 `commissionRules.map(r => '规则：${r.name}（${r.rate}% · ${r.intermediaryName ?? '默认'}）')` |
| onChange | `handleCommissionSelect(e.target.value)` |
| 权限 | ⚠️ 佣金可见性由父组件层控制（`commission:read` scope） |

---

## §7 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 空态：未试算 | `preview === null && !previewing` | 仅输入栅格 + 「试算预览」按钮 | 「试算预览」按钮 disabled（`!validInput`） |
| 加载中 | `previewing === true` | 「试算预览」按钮内 `Loader2` + `animate-spin` + disabled | 不显示文案 |
| 错误 | `previewTrackB` 抛异常 | `alert('试算失败: ${e.message}')` + console.error | 弹窗显示错误信息 |
| 无权限 | 父组件层控制（佣金字段单独 scope） | 父组件不渲染佣金 Field | — |
| 试算完成 | `preview !== null` | 4 卡结果区（grid-cols-2） | 退税后美元成本 / 利润额 / 佣金额 / 终价美元单价 |
| 输入不全 | `validInput === null` | 「试算预览」按钮 disabled | 用户点时 alert「请完整填写采购成本 / 退税率 / 汇率 / 利润率」 |
| 查税率命中 | `lookupHint != null && 命中` | textTertiary 提示 | `命中 HS ${hsCode}，退税率 ${rate}%` |
| 查税率未命中 | `lookupHint != null && 未命中` | textTertiary 提示 | `未命中退税率，请手工录入` |

> **无权限态说明**：佣金字段仅管理层+财务可见（`commission:read` scope），由父组件（PricingManager / QuotationManager）控制是否渲染佣金 Field；组件内不重复实现权限态。

---

## §8 数据流与父组件联动

```
TrackBPanel
  ├─ onResultChange(result)   ──► 父组件 setTrackBResult(result)
  ├─ onInputsChange(inputs)   ──► 父组件 setTrackBInputs(inputs)  ← 保存定价记录用
  ├─ children                 ──► 父组件注入「数量」「备注」Field
  └─ actions                  ──► 父组件注入「保存定价记录」按钮

父组件 PricingManager 联动：
  TrackAPanel.onMedianUsdChange + TrackBPanel.onResultChange
    ↓
  DeviationBadge { finalUsd: trackBResult.finalUnitPrice,
                   medianUsd: trackAMedian.usd }
    ↓
  computePriceDeviation() → { deviationPercent, level: ok|warn|block }

父组件保存定价记录：
  trackBInputs（有效输入）+ 数量 + 备注
    ↓
  apiService.createPricingCalculation({
    ...trackBInputs,
    quantity, notes,
    status: 'Draft',
  })
    ↓
  服务端 calculateTrackB 重算派生值（不接受客户端传入）
```

---

## §9 状态机（试算 + 输入校验）

```
   init ──输入不全──► invalid (validInput=null, 试算按钮 disabled)
     │
     │ 输入齐全
     ▼
   valid (validInput!=null, 试算按钮 enabled)
     │
     │ 点试算预览
     ▼
   previewing ──成功──► ready (preview!=null)
     │                     │
     │ fail                │ 改任一输入
     ▼                     ▼
   error (alert)      invalid/valid (preview=null, 重新试算)
```

| 状态 | 字段 | 行为 |
|---|---|---|
| `init` | `validInput=null, preview=null, previewing=false` | 输入栅格可编辑，「试算预览」disabled |
| `invalid` | `validInput=null` | 同 init，「试算预览」disabled；用户点击时 alert 提示 |
| `valid` | `validInput!=null, preview=null` | 「试算预览」enabled |
| `previewing` | `previewing=true` | 「试算预览」disabled + Loader2 旋转 |
| `ready` | `preview!=null, previewing=false` | 显示 4 卡结果区 |
| `error` | `previewTrackB` 抛异常 | alert 错误信息 |

---

## §10 数据模型（TrackB* 类型族）

真源：`types.ts:4508-4645`

```ts
interface TrackBResult {
  netUsdCost: number;        // 退税后美元成本
  profitAmount: number;      // 利润额
  commissionAmount: number;  // 佣金额
  finalUnitPrice: number;    // 终价美元单价
}

interface TrackBInput {
  purchaseCostCny: number;
  refundRate: number;
  exchangeRate: number;
  profitMargin: number;
  commissionRate?: number;   // 0=无 | 5=E5 | 10=E10
}

interface CommissionRule {
  id: string;
  name: string;
  rate: number;              // 5 = E5 | 10 = E10
  intermediaryRelationId?: string | null;  // 空 = 默认规则
  intermediaryName?: string | null;
  isActive: boolean;
  notes?: string | null;
  createdAt: number;
  updatedAt: number;
}

// PricingCalculation 落库记录（extends TrackBResult）
interface PricingCalculation extends TrackBResult {
  id: string;
  purchaseCostCny: number;
  refundRate: number;
  exchangeRate: number;
  profitMargin: number;
  commissionRate: number;
  orderId?: string | null;
  quotationId?: string | null;
  productAssetId?: string | null;
  hsCode?: string | null;
  fxLockId?: string | null;
  commissionRuleId?: string | null;  // 佣金率来源规则（P2）；提供时 commissionRate 为规则值快照
  quantity?: number | null;
  status: 'Draft' | 'Confirmed' | 'Archived';
  notes?: string | null;
  createdBy?: string | null;
  createdAt: number;
  updatedAt: number;
}
```

---

## §11 API 端点清单

| 端点 | 方法 | 用途 | 调用方 |
|---|---|---|---|
| `/v1/pricing/track-b/preview` | POST | 试算预览（calculateTrackB 纯函数） | `apiService.previewTrackB(validInput)` |
| `/v1/pricing/tax-refund-rates/lookup` | GET | HS Code 最长前缀命中退税率 | `apiService.lookupTaxRefundRate(code)` |
| `/v1/exchange-rates/latest` | GET | 最新汇率一键带入 | `apiService.getLatestFxRates()` |
| `/v1/pricing/commission-rules` | GET | 佣金规则列表（dropdown options） | `apiService.listCommissionRules()` |
| `/v1/pricing/calculations` | POST | 保存定价记录（父组件调用） | `apiService.createPricingCalculation(input)` |

**响应**：`TrackBResult` JSON（试算）/ `PricingCalculation` JSON（保存）。**试算无 mutation**——纯计算端点；保存为 mutation。

---

## §12 权限与可见性

| 角色 | 可见 TrackBPanel | 可见佣金 Field | 可保存定价记录 | 可查退税率 |
|---|---|---|---|---|
| Sales / SalesManager | ✅ | ⚠️ 仅管理层（Sales 不可见佣金） | ✅ | ✅ |
| Finance / FinanceManager | ✅ | ✅ | ✅ | ✅ |
| Admin / SuperAdmin | ✅ | ✅ | ✅ | ✅ |
| Operations / Warehouse | ❌（父组件层不渲染） | — | — | — |

> **铁律**：佣金仅管理层+财务可见（PRD §9.6 行级权限）。父组件（PricingManager / QuotationManager）按 `commission:read` scope 决定是否渲染佣金 Field；组件内不重复实现权限态。保存定价记录需 `pricing:write` scope。

---

## §13 设计系统约束（BDS）

- **容器**：`bg-surface-elevated rounded-card p-5`
- **输入框**：`inputClass = "w-full bg-surface-primary text-text-primary text-sm rounded-control px-3 py-2 border border-border-subtle outline-none focus:border-border-action"`
- **操作按钮**：`actionButtonClass = "flex items-center gap-1 px-2.5 py-1 text-xs rounded-control bg-surface-elevated text-text-secondary hover:text-text-primary hover:ring-1 hover:ring-border-action transition-all disabled:opacity-50"`
- **试算按钮**：`bg-surface-primary text-text-primary border border-border-action hover:bg-surface-secondary`
- **圆角**：`rounded-card`（容器）/ `rounded-control`（输入/按钮）/ `rounded-inset`（结果卡），禁止硬编码 `rounded-[Npx]`
- **颜色**：`bg-surface-primary/elevated` / `text-text-primary/secondary/tertiary` / `border-border-subtle/action` 全部走 BDS 语义类
- **结果卡强调**：终价美元单价卡 `border border-border-action` 突出展示
- **字重**：`text-sm font-medium`（标题）/ `text-xs`（标签）/ `text-lg font-medium`（数值）
- **数字格式**：`toFixed(4)` 保留 4 位小数（美元单价精度需求）
- **lookupHint**：`text-xs text-text-tertiary mb-3`
- **防回退**：`scripts/check-design-tokens.sh` 扫描硬编码

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-TB1 | 佣金 Field 权限态未在组件内实现（依赖父组件层控制） | 组件复用时需父组件重复实现权限逻辑 | P2 |
| GAP-TB2 | 试算失败仅 alert，无 inline 错误展示 | 用户关闭弹窗后无法回顾错误 | P2 |
| GAP-TB3 | 无「重置」按钮（清空所有输入） | 用户需逐字段清空 | P3 |
| GAP-TB4 | HS Code 查税率无 loading 态（仅同步等待） | 查询期间用户无反馈 | P3 |
| GAP-TB5 | 佣金规则 dropdown 无「+ 新建规则」入口 | 用户需跳转 Commission Rules tab 新建 | P3 |
| GAP-TB6 | 汇率无历史趋势提示（仅最新值带入） | 用户无法判断当前汇率是否处于高位 | P3 |

---

## §15 相关文档索引

- [../00-索引.md](../00-索引.md) — 设计文档真源总索引
- [../04-模块设计/03-订单与生产/Pricing-定价与成本/轨道 B 退税美元定价.md](../04-模块设计/03-订单与生产/Pricing-定价与成本/轨道%20B%20退税美元定价.md) — calculateTrackB 纯函数 + PricingCalculation 落库
- [../04-模块设计/03-订单与生产/Pricing-定价与成本/偏差校验与审批链.md](../04-模块设计/03-订单与生产/Pricing-定价与成本/偏差校验与审批链.md) — 双轨偏差阈值
- [../04-模块设计/03-订单与生产/Pricing-定价与成本/退税率表维护.md](../04-模块设计/03-订单与生产/Pricing-定价与成本/退税率表维护.md) — HS Code 最长前缀命中
- [../04-模块设计/03-订单与生产/Pricing-定价与成本/模块概述.md](../04-模块设计/03-订单与生产/Pricing-定价与成本/模块概述.md) — Pricing 模块总览
- [TrackAPanel.md](./TrackAPanel.md) — 轨道 A 估算面板（双轨联动对侧）
- [DeviationBadge.md](./DeviationBadge.md) — 双轨偏差校验徽章（消费 TrackB 终价 USD）
- [../01-产品总览/6. 角色与权限矩阵.md](../01-产品总览/6.%20角色与权限矩阵.md) — commission:read / pricing:write scope
- [../03-业务规则/价格审批规则.md](../03-业务规则/价格审批规则.md) — 双轨偏差触发审批规则

---

## §16 补充说明

1. **派生值服务端重算铁律**：`netUsdCost / profitAmount / commissionAmount / finalUnitPrice` 一律以后端 `calculateTrackB` 返回为准，前端不做本地计算——避免前后端口径不一致。保存定价记录时，派生值同样服务端重算，不接受客户端传入
2. **佣金选择 4 口径设计**：无/E5/E10/规则快照——前三个是手工口径（commissionRuleId=null），第四个是规则快照（commissionRuleId=rule.id）。落库时若提供 commissionRuleId，commissionRate 为规则值快照（即使规则后续被修改，历史定价记录不受影响）
3. **HS Code 最长前缀命中**：服务端按 HS Code 最长前缀匹配 TaxRefundRate 表（如 `5407520000` 命中 `5407` 的退税率）——这是外贸行业标准做法，避免用户手工查表
4. **输入变更清空结果纪律**：每个输入字段 onChange 时 `setPreview(null)`，强制用户重新点「试算预览」——避免展示过期结果与当前输入不匹配；HS Code 例外，改 HS Code 不清空 preview（因为 HS Code 不直接参与试算，仅用于查退税率）
5. **可扩展 children/actions 设计**：`children` / `actions` 是产品意图——TrackBPanel 仅承担试算本体（6 输入 + 4 卡结果），业务定制（数量/备注/保存按钮）由父组件注入。这避免组件膨胀，同时保证 PricingManager 与 QuotationManager 复用同一试算逻辑
6. **佣金权限页面层控制**：佣金仅管理层+财务可见（PRD §9.6 行级权限）。TrackBPanel 组件内不重复实现权限态——父组件按 `commission:read` scope 决定是否渲染佣金 Field。这是组件复用与权限解耦的设计取舍
7. **试算预览 toFixed(4) 精度**：美元单价用 `toFixed(4)` 保留 4 位小数（如 `$1.2345`）——外贸美元单价精度需求，避免 2 位小数四舍五入丢失利润
