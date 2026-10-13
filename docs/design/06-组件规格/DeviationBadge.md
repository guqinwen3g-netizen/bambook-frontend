# DeviationBadge 组件规格 · 双轨偏差提示标

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `DeviationBadge` |
| 定位 | 双轨偏差校验三态徽章——轨道 B 终价 USD vs 轨道 A 中位估算 USD 的偏差百分比展示，3 态色编码（ok 绿 / warn 橙 / block 红）+ 文案提示后续动作 |
| 文件路径 | `components/pricing/DeviationBadge.tsx`（77 行） |
| 消费方 | `PricingManager.tsx`（定价计算器 tab，双轨试算后展示） / `QuotationManager.tsx`（报价编辑器双轨面板，保存前展示） |
| 范式 | 纯展示型——无内部状态，无副作用；入参缺失/中位非正时返回 null（不渲染） |
| 优先级 | P1（阶段 P2 双轨联动校验） |
| 实现状态 | ✅ 已落地（3 态色 + 偏差百分比计算 + 单位提示 + 与 ApprovalRequest 联动文案）；✅ 阈值常量与后端 `trackAEstimator.ts` 同源（15% / 30%）；✅ 导出 `computePriceDeviation` 纯函数供前端复用 |
| PRD 关联 | PRD §8.6（双轨联动校验 + 偏差阈值）/ §9.2（报价低于成本价 → 管理层审批）/ §9.6（行级权限） |
| 代码关联 | [DeviationBadge.tsx](../../components/pricing/DeviationBadge.tsx) / [trackAEstimator.ts](../../server/src/pricing/trackAEstimator.ts)（`calculatePriceDeviation` 后端纯函数 + `DEVIATION_WARN_PERCENT=15` / `DEVIATION_BLOCK_PERCENT=30` 阈值同源） / [quotationService.ts](../../server/src/quotations/quotationService.ts)（`deviation.level !== 'ok'` 时自动生成 ApprovalRequest，第 124–152 行） / [rdlBusinessStatusTokens.ts](../../components/rdlBusinessStatusTokens.ts) `statusSemanticClass` / `types.ts` `PriceDeviationLevel`（第 4520 行） |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架（Props 接口 + 渲染结构）

```ts
export interface DeviationBadgeProps {
  /** 轨道 B 终价美元单价 */
  finalUsd: number | null;
  /** 轨道 A 中位估算美元单价 */
  medianUsd: number | null;
  /** 估算单位提示（如 PC / M） */
  medianUnit?: string;
  isDarkMode?: boolean;
}

// 内部无状态，纯计算 + 渲染
export function DeviationBadge({ finalUsd, medianUsd, medianUnit, isDarkMode }: DeviationBadgeProps) {
  const dev = computePriceDeviation(finalUsd, medianUsd);
  if (!dev) return null;   // 入参缺失/中位非正时不渲染
  // ... 3 态色 + 图标 + 文案
}
```

### 渲染结构

```
<div className="flex items-start gap-2 px-3 py-2 rounded-inset text-xs {statusSemanticClass}">
  ├─ 图标（3 态切换）：
  │   ├─ ok      → <CheckCircle2>  绿色
  │   ├─ warn    → <AlertTriangle> 橙色
  │   └─ block   → <AlertCircle>   红色
  └─ <span> 文案：
      双轨偏差校验：轨道 B 终价 $X.XXXX vs 轨道 A 中位 $Y.YYYY（$/单位），
      偏差 ±Z.Z%
      [ok]    （≤15%，区间内）
      [warn]  （>15%，保存将触发审批）
      [block] （>30%，禁止直接发送）
</div>
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `finalUsd` | `number \| null` | 是 | — | 轨道 B 终价美元单价；来自 `TrackBResult.finalUnitPrice`；null 时不渲染 |
| `medianUsd` | `number \| null` | 是 | — | 轨道 A 中位估算美元单价；来自 `TrackAResult.priceMedianUsd`；null 时不渲染 |
| `medianUnit` | `string` | 否 | `undefined` | 估算单位提示（`'PC'` / `'M'`）；提供时展示 `（$/件）` / `（$/米）`；不提供时不展示单位后缀 |
| `isDarkMode` | `boolean` | 否 | `false` | 深色模式标志，传给 `statusSemanticClass` 控制语义色深浅变体 |

**渲染门禁**：`computePriceDeviation(finalUsd, medianUsd)` 返回 null 时，组件返回 null（不渲染任何 DOM）。这避免在双轨未齐备时展示无意义徽章。

---

## §4 3 态展示规范

### §4.1 三态色编码

| 级别 | level 值 | 触发条件 | 语义色 | 图标 | StatusSemantic |
|---|---|---|---|---|---|
| ok（绿） | `'ok'` | `\|deviation\| <= 15%` | success 绿 | `<CheckCircle2>` | `'success'` |
| warn（橙） | `'warn'` | `15% < \|deviation\| <= 30%` | warning 橙 | `<AlertTriangle>` | `'warning'` |
| block（红） | `'block'` | `\|deviation\| > 30%` | danger 红 | `<AlertCircle>` | `'danger'` |

### §4.2 三态文案

| 级别 | 文案后缀 |
|---|---|
| ok | `（≤15%，区间内）` |
| warn | `（>15%，保存将触发审批）` |
| block | `（>30%，禁止直接发送）` |

### §4.3 完整文案模板

```
双轨偏差校验：轨道 B 终价 $${finalUsd.toFixed(4)} vs 轨道 A 中位 $${medianUsd.toFixed(4)}（$/单位），
偏差 ${sign}${deviationPercent}%${后缀}
```

- `sign`：正偏差 `+`，负偏差空串（数字本身带 `-`）
- 单位后缀：`medianUnit === 'PC'` → `$/件` / `medianUnit === 'M'` → `$/米` / 不提供 → 无后缀
- 美元单价精度 `toFixed(4)`，与 TrackBPanel 保持一致

### §4.4 LEVEL_SEMANTIC 映射

```ts
const LEVEL_SEMANTIC: Record<PriceDeviationLevel, StatusSemantic> = {
  ok: 'success',
  warn: 'warning',
  block: 'danger',
};
```

通过 `statusSemanticClass(LEVEL_SEMANTIC[dev.level], isDarkMode)` 获取语义色 className，统一走 BDS 语义色系统。

---

## §5 偏差百分比计算公式

### §5.1 computePriceDeviation 纯函数（前端展示用）

```ts
export const PRICE_DEVIATION_WARN_PERCENT = 15;
export const PRICE_DEVIATION_BLOCK_PERCENT = 30;

export function computePriceDeviation(
  finalUsd: number | null,
  medianUsd: number | null,
): PriceDeviationInfo | null {
  // 入参校验：缺失/中位非正/终价非有限数 → 返回 null（不渲染）
  if (finalUsd === null || medianUsd === null || medianUsd <= 0 || !Number.isFinite(finalUsd)) {
    return null;
  }
  // 偏差百分比 = (轨道 B 终价 − 轨道 A 中位估算) / 轨道 A 中位估算 × 100
  // 四舍五入到 2 位小数（×10000 / 100）
  const deviationPercent = Math.round(((finalUsd - medianUsd) / medianUsd) * 10000) / 100;
  const abs = Math.abs(deviationPercent);
  const level: PriceDeviationLevel =
    abs > PRICE_DEVIATION_BLOCK_PERCENT ? 'block'
    : abs > PRICE_DEVIATION_WARN_PERCENT ? 'warn'
    : 'ok';
  return { deviationPercent, level };
}
```

### §5.2 与后端 calculatePriceDeviation 口径一致性

| 维度 | 前端 `computePriceDeviation` | 后端 `calculatePriceDeviation` |
|---|---|---|
| 公式 | `(finalUsd - medianUsd) / medianUsd * 100` | 同 |
| 阈值 | `WARN=15 / BLOCK=30` | `DEVIATION_WARN_PERCENT=15 / DEVIATION_BLOCK_PERCENT=30` |
| 入参校验 | null / `<=0` / `!isFinite` → 返回 null | `<=0` / `!isFinite` → 抛 Error |
| 精度 | `Math.round(x*10000)/100`（2 位小数） | `round4(x)`（4 位小数） |
| 用途 | 前端展示用，不参与落库 | 后端落库用，参与审批触发 |

> **关键纪律**：前端 `computePriceDeviation` 与后端 `calculatePriceDeviation` 公式与阈值**完全一致**——阈值常量双边同步（`PRICE_DEVIATION_WARN_PERCENT` / `PRICE_DEVIATION_BLOCK_PERCENT` ↔ `DEVIATION_WARN_PERCENT` / `DEVIATION_BLOCK_PERCENT`），改动需双边同步。前端仅用于实时展示，**不参与落库**；后端在报价单创建时重新计算并落库，作为审批触发的真源。

### §5.3 负偏差处理

> 低估（负偏差）同样分级：报价显著低于估算意味着亏损风险（PRD §9.2 报价低于成本价 → 管理层审批）。

- `deviationPercent < 0`：轨道 B 终价低于轨道 A 中位估算，可能亏损
- `|deviationPercent| > 15%` → warn（触发审批）
- `|deviationPercent| > 30%` → block（禁止直接发送）

`Math.abs(deviationPercent)` 取绝对值分级，正负偏差同等对待——这是产品铁律，避免低价报价绕过审批。

---

## §6 点击展开详情（前瞻设计，当前未实现）

> **状态**：⚠️ 待落地——当前 DeviationBadge 是纯展示型组件，无交互；点击展开详情属于前瞻设计。

### §6.1 前瞻交互设计

| 交互 | 触发 | 展示内容 |
|---|---|---|
| 点击徽章 | `onClick` | 展开 Popover 显示：① 偏差计算公式（含具体数值代入） ② 轨道 A 估算区间（下限/中位/上限） ③ 轨道 B 试算明细（netUsdCost / profitAmount / commissionAmount / finalUnitPrice） ④ 审批状态（如有 ApprovalRequest） ⑤ 「发起审批」/「调整价格」操作按钮 |

### §6.2 当前替代方案

当前用户需通过以下方式查看详情：
- 轨道 A 估算区间：直接看 TrackAPanel 结果区三卡（下限/中位/上限）
- 轨道 B 试算明细：直接看 TrackBPanel 结果区四卡（netUsdCost / profitAmount / commissionAmount / finalUnitPrice）
- 审批状态：保存报价单后在通知中心查看 ApprovalRequest

---

## §7 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 不渲染 | `finalUsd === null \|\| medianUsd === null \|\| medianUsd <= 0 \|\| !Number.isFinite(finalUsd)` | `return null`（无 DOM） | — |
| ok 态 | `\|deviation\| <= 15%` | success 绿 + `<CheckCircle2>` | `偏差 ±X%（≤15%，区间内）` |
| warn 态 | `15% < \|deviation\| <= 30%` | warning 橙 + `<AlertTriangle>` | `偏差 ±X%（>15%，保存将触发审批）` |
| block 态 | `\|deviation\| > 30%` | danger 红 + `<AlertCircle>` | `偏差 ±X%（>30%，禁止直接发送）` |
| 无权限 | 无独立权限态（DeviationBadge 跟随父组件渲染门禁） | — | — |

> **无权限态说明**：DeviationBadge 是纯展示组件，无独立 scope 控制。组件跟随父组件（PricingManager / QuotationManager）的渲染门禁——无 `pricing:read` scope 的角色不渲染父组件，自然不渲染 DeviationBadge。

---

## §8 与 ApprovalRequest 的联动

### §8.1 联动数据流

```
前端（用户试算）：
  TrackAPanel.onMedianUsdChange(usd, unit) + TrackBPanel.onResultChange(result)
    ↓
  DeviationBadge { finalUsd, medianUsd, medianUnit }
    ↓
  computePriceDeviation() → { deviationPercent, level: ok|warn|block }  ← 前端展示用
    ↓
  用户看到 3 态徽章 + 文案提示后续动作

后端（用户保存报价单）：
  quotationService.createQuotation(input)
    ↓
  input.trackAMedianUsd + input.trackBFinalUsd 齐备？
    ↓ 是
  calculatePriceDeviation(trackBFinalUsd, trackAMedianUsd)  ← 后端落库用
    ↓
  deviation.level !== 'ok'？
    ↓ 是（warn / block）
  解析 requester（actor → UserAccount，fallback owner）
    ↓
  approvalId = `ar_${now}_${random6}`
    ↓
  prisma.$transaction 内创建 ApprovalRequest（同事务）
    ↓
  Quotation.priceApprovalId = approvalId  ← 关联审批 ID
```

### §8.2 审批触发条件

| 偏差级别 | 是否触发审批 | 后续动作 |
|---|---|---|
| ok（≤15%） | ❌ 不触发 | 报价单可直接发送 |
| warn（>15%） | ✅ 触发 | 保存时自动生成 ApprovalRequest（pending 态）；报价单需审批通过后才能发送 |
| block（>30%） | ✅ 触发 | 保存时自动生成 ApprovalRequest；**发送门禁 fail-closed**——即使审批未完成也禁止发送 |

### §8.3 fail-closed 原则

> 无法解析 requester 时不阻断创建：快照照常落库，priceApprovalId 置空；**发送门禁对 block 仍 fail-closed**——即 block 级偏差无审批 ID 时，下游门禁拒绝放行。

来源：`quotationService.ts:132-134` 注释。

**含义**：
- warn 级偏差无 approvalId 时（requester 解析失败）：报价单可创建但需补审批
- block 级偏差无 approvalId 时：报价单可创建但**禁止发送**——发送接口返回 409 拒绝

### §8.4 ApprovalRequest 模型关键字段

| 字段 | 值（价格偏差场景） |
|---|---|
| `actionType` | `'quotation.price_deviation'` |
| `targetType` | `'Quotation'` |
| `targetId` | 报价单 ID |
| `status` | `'pending'`（初始） |
| `risk` | `'high'`（默认） |
| `payload` | `{ deviationPercent, level, trackAMedianUsd, trackBFinalUsd, ... }` |
| `requesterId` | 发起人 UserAccount ID |
| `reviewerId` | null（pending 时未分配） |

---

## §9 状态机（偏差级别）

```
   双轨未齐备 ──► 不渲染（return null）
       │
       │ 双轨齐备
       ▼
   computePriceDeviation()
       │
       ├─ |dev| <= 15% ──► ok（绿，区间内）
       ├─ 15% < |dev| <= 30% ──► warn（橙，保存触发审批）
       └─ |dev| > 30% ──► block（红，禁止直接发送）
```

| 级别 | 触发 | 用户动作 | 后端动作 |
|---|---|---|---|
| 不渲染 | finalUsd/medianUsd 缺失或非正 | — | — |
| ok | `|dev| <= 15%` | 可直接保存并发送 | 不生成 ApprovalRequest |
| warn | `15% < |dev| <= 30%` | 保存后等待审批 | 生成 ApprovalRequest（pending） |
| block | `|dev| > 30%` | 保存后等待审批，禁止发送 | 生成 ApprovalRequest + 发送门禁 fail-closed |

---

## §10 数据模型

真源：`types.ts:4520` + `DeviationBadge.tsx`

```ts
// 偏差级别（3 态）
type PriceDeviationLevel = 'ok' | 'warn' | 'block';

// 偏差信息（前端展示用）
interface PriceDeviationInfo {
  deviationPercent: number;       // 带符号，正=高估 / 负=低估
  level: PriceDeviationLevel;
}

// 阈值常量（与后端 trackAEstimator.ts 同源）
export const PRICE_DEVIATION_WARN_PERCENT = 15;
export const PRICE_DEVIATION_BLOCK_PERCENT = 30;

// 后端 PriceDeviation（落库用，含异常抛出）
interface PriceDeviation {
  deviationPercent: number;
  level: DeviationLevel;          // 'ok' | 'warn' | 'block'
}
```

---

## §11 API 端点清单

DeviationBadge 是纯展示组件，**不直接调用任何 API**。偏差计算在前端完成（`computePriceDeviation`），审批触发在后端 `quotationService.createQuotation` 内完成。

| 关联端点 | 方法 | 用途 | 调用方 |
|---|---|---|---|
| `/v1/quotations` | POST | 创建报价单（后端触发审批） | `QuotationManager` 保存按钮 |
| `/v1/quotations/:id/send` | POST | 发送报价单（block 级 fail-closed 门禁） | `QuotationManager` 发送按钮 |
| `/v1/approvals/:id/decide` | POST | 审批决策（approve/reject） | `NotificationCenter` 审批项 |

---

## §12 权限与可见性

| 角色 | 可见 DeviationBadge | 可看偏差百分比 | 可审批 |
|---|---|---|---|
| Sales | ✅（试算时展示） | ✅ | ❌ |
| SalesManager | ✅ | ✅ | ✅ 报价偏差审批 |
| Finance / FinanceManager | ✅ | ✅ | ✅ 价格变更审批 |
| Admin / SuperAdmin | ✅ | ✅ | ✅ 全部 |
| Operations / Warehouse | ❌（父组件不渲染） | — | — |

> **铁律**：DeviationBadge 跟随父组件渲染门禁。偏差百分比本身不属敏感字段（它是比值非绝对值），所有有 `pricing:read` scope 的角色可见。审批决策权按 `actionType='quotation.price_deviation'` 的 approve scope 分档。

---

## §13 设计系统约束（BDS）

- **容器**：`flex items-start gap-2 px-3 py-2 rounded-inset text-xs` + `statusSemanticClass(level, isDarkMode)` 语义色
- **圆角**：`rounded-inset`（内嵌提示），禁止硬编码 `rounded-[Npx]`
- **颜色**：3 态语义色走 `statusSemanticClass('success'|'warning'|'danger', isDarkMode)`，禁止 hex 硬编码
- **图标**：lucide-react `CheckCircle2` / `AlertTriangle` / `AlertCircle`，size=3.5 + `mt-0.5 shrink-0`
- **字重**：`text-xs`（继承父级字重）
- **数字格式**：`toFixed(4)` 美元单价 + 偏差百分比带符号（`+` / 空）
- **防回退**：`scripts/check-design-tokens.sh` 扫描硬编码；阈值常量与后端同源，禁止前端硬编码 15/30

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-DB1 | **点击展开详情未实现**（前瞻设计见 §6） | 用户需跨 TrackAPanel/TrackBPanel/NotificationCenter 三处查看详情 | P2 |
| GAP-DB2 | 无「发起审批」/「调整价格」操作按钮 | 用户需保存报价单后才能触发审批，无法在试算阶段主动调整 | P2 |
| GAP-DB3 | 无 ApprovalRequest 状态联动展示 | 审批通过/拒绝后徽章不更新（需用户手动刷新） | P2 |
| GAP-DB4 | 前端 `computePriceDeviation` 与后端 `calculatePriceDeviation` 精度不一致（2 位 vs 4 位小数） | 极端边界值可能前端显示 ok 但后端落库 warn | P3 |
| GAP-DB5 | 无 ARIA `role="alert"` 用于 warn/block 态 | 屏幕阅读器无法及时获知偏差警告 | P2 |

---

## §15 相关文档索引

- [../00-索引.md](../00-索引.md) — 设计文档真源总索引
- [../04-模块设计/03-订单与生产/Pricing-定价与成本/偏差校验与审批链.md](../04-模块设计/03-订单与生产/Pricing-定价与成本/偏差校验与审批链.md) — calculatePriceDeviation + ApprovalRequest 自动生成 + 409 发送门禁
- [../04-模块设计/03-订单与生产/Pricing-定价与成本/轨道 A 系统估算器.md](../04-模块设计/03-订单与生产/Pricing-定价与成本/轨道%20A%20系统估算器.md) — 轨道 A 中位 USD 真源
- [../04-模块设计/03-订单与生产/Pricing-定价与成本/轨道 B 退税美元定价.md](../04-模块设计/03-订单与生产/Pricing-定价与成本/轨道%20B%20退税美元定价.md) — 轨道 B 终价 USD 真源
- [../04-模块设计/03-订单与生产/Pricing-定价与成本/模块概述.md](../04-模块设计/03-订单与生产/Pricing-定价与成本/模块概述.md) — Pricing 模块总览
- [TrackAPanel.md](./TrackAPanel.md) — 轨道 A 估算面板（提供 medianUsd）
- [TrackBPanel.md](./TrackBPanel.md) — 轨道 B 退税定价面板（提供 finalUsd）
- [../01-产品总览/5. 全局交互规范.md](../01-产品总览/5.%20全局交互规范.md) — ApprovalRequest 审批流 + 通知中心
- [../03-业务规则/价格审批规则.md](../03-业务规则/价格审批规则.md) — 双轨偏差触发审批规则

---

## §16 补充说明

1. **阈值常量双边同源铁律**：前端 `PRICE_DEVIATION_WARN_PERCENT=15` / `PRICE_DEVIATION_BLOCK_PERCENT=30` 与后端 `trackAEstimator.ts` 的 `DEVIATION_WARN_PERCENT=15` / `DEVIATION_BLOCK_PERCENT=30` **必须完全一致**——改动需双边同步，避免前端显示 ok 但后端落库 warn 的不一致。当前双边均为 15/30，由 `trackA.test.ts:168-169` 测试守护
2. **前端展示 vs 后端落库分离**：前端 `computePriceDeviation` 仅用于实时展示，**不参与落库**；后端 `calculatePriceDeviation` 在报价单创建时重新计算并落库，作为审批触发的真源。这避免前端被篡改绕过审批
3. **负偏差同等分级铁律**：低估（负偏差）同样按 `|deviationPercent|` 分级——`|dev| > 15%` 触发审批，`|dev| > 30%` 禁止发送。这是产品铁律，避免低价报价绕过审批（PRD §9.2 报价低于成本价 → 管理层审批）
4. **入参缺失不渲染纪律**：`computePriceDeviation` 在 `finalUsd === null || medianUsd === null || medianUsd <= 0 || !Number.isFinite(finalUsd)` 时返回 null，组件返回 null（不渲染）——避免在双轨未齐备时展示无意义徽章或 NaN
5. **fail-closed 原则**：block 级偏差无 approvalId 时（requester 解析失败），发送门禁仍拒绝放行——这是产品铁律，确保 block 级偏差无法绕过审批直接发送。详见 `quotationService.ts:132-134` 注释
6. **精度差异容忍**：前端 `Math.round(x*10000)/100`（2 位小数）vs 后端 `round4(x)`（4 位小数）——极端边界值（如 15.005%）可能前端显示 ok 但后端落库 warn。这是已知容忍（GAP-DB4），实际业务中偏差很少精确到 4 位小数边界
7. **纯展示无副作用**：DeviationBadge 是纯展示组件，无内部状态、无副作用、无 API 调用——所有数据通过 props 传入，偏差计算在前端完成。这使得组件可独立测试、可复用于任何需要展示双轨偏差的场景
