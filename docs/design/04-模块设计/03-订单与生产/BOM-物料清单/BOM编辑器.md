# BOM 编辑器 (BOM Editor)

## §1 元信息

| 项 | 值 |
|---|---|
| **定位** | BOM 物料清单编辑器 — 物料行 + 成本估算项 + 实时成本汇总 + 利润分析 |
| **入口** | BOM 列表页「新建 BOM」按钮 → 弹窗表单 / BOM 卡片展开详情（只读 + 操作按钮） |
| **核心角色** | 业务员（含成本核算工作）、财务（宽泛容器不细分） |
| **范式** | 范式 C — 表单编辑器 (Form Editor)：弹窗表单 + 动态行列表 + 实时计算 |
| **优先级** | P1 |
| **实现状态** | ✅ 已落地（创建弹窗 + 物料行动态增删 + 成本估算项动态增删 + 实时成本汇总 + 利润分析 + 状态操作按钮 + 详情展开查看；多级树形/替代料为待补缺口） |
| **关联 PRD 章节** | §5.6（BOM 编号）、§19.8（BOM 页详细设计） |
| **关联代码** | [BomManager.tsx](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/BomManager.tsx) L541-L847（CreateBOMModal） / [bomService.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/bom/bomService.ts) `createBOM` / `updateBOM` |

---

## §2 页面骨架

### 2.1 创建 BOM 弹窗布局

```
┌──────────────────────────────────────────────────────────────────┐
│  bds-modal-mask（点击关闭）                                       │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ bds-modal (width: 56rem, maxHeight: 90vh, overflow-y:auto) │  │
│  │                                                            │  │
│  │ ┌── 新建 BOM ──────────────────────────────────── [×] ─┐   │  │
│  │ │ 基本信息：BOM编号* / 描述* / 币种 / 销售单价          │   │  │
│  │ ├──────────────────────────────────────────────────────┤   │  │
│  │ │ 物料明细：[添加行]                                    │   │  │
│  │ │ ┌─ 行1: 类型/品名*/编码/用量/单位/损耗%/单价 [删除] ─┐│   │  │
│  │ │ └────────────────────────────────────────────────────┘│   │  │
│  │ ├──────────────────────────────────────────────────────┤   │  │
│  │ │ 成本估算项（可选）：[添加成本项]                      │   │  │
│  │ │ ┌─ 项1: 类型/描述/金额 [删除] ──────────────────────┐│   │  │
│  │ │ └────────────────────────────────────────────────────┘│   │  │
│  │ ├──────────────────────────────────────────────────────┤   │  │
│  │ │ 实时成本汇总：物料合计/人工合计/费用合计/总成本/利润率│   │  │
│  │ ├──────────────────────────────────────────────────────┤   │  │
│  │ │ 备注                                                  │   │  │
│  │ ├──────────────────────────────────────────────────────┤   │  │
│  │ │                            [取消] [创建 BOM]          │   │  │
│  │ └──────────────────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 详情展开布局（列表卡片展开）

```
┌─ BOM 卡片（bds-card）─────────────────────────────────────────────┐
│ ┌─ ChevronDown ▼ ─ BOM编号 [badge状态] v1 ── 总成本 ── 利润率 ─┐│
│ └────────────────────────────────────────────────────────────────┘│
│ ┌─ 展开区（AnimatePresence height:auto）────────────────────────┐│
│ │  成本汇总 4 宫格：物料成本 / 人工成本 / 制造费用 / 总成本       ││
│ │  利润分析条：销售单价 / 利润额 / 利润率                         ││
│ │  物料明细表：#/类型/编码/品名/用量/损耗/实耗/单价/金额          ││
│ │  成本估算项列表：类型badge / 描述 / 金额                        ││
│ │  操作按钮：[确认BOM][重新计算][删除][归档]                     ││
│ │  RelatedEntitiesPanel                                          ││
│ └────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

### 2.3 视觉层级

| 区块 | 材质/样式 | 代码真源 |
|------|----------|---------|
| 弹窗遮罩 | `bds-modal-mask` | L657 |
| 弹窗主体 | `bds-modal` width:56rem | L658-L662 |
| 物料行容器 | `p-2 rounded-inset bg-[var(--bg-panel)]` | L711 |
| 成本汇总卡 | `p-3 rounded-card bg-[var(--bg-panel)]` | L794 |
| 利润分析条 | `p-2 rounded-inset bg-[var(--success-tint)]` | L382 |
| 物料明细表 | `bds-table` + `rounded-inset` | L408-L409 |

---

## §3 物料行（BOMLine）编辑

### 3.1 物料行字段

| # | 字段 | 类型 | 必填 | 控件 |
|---|------|------|------|------|
| 1 | materialType | MaterialType | ✅ | select（8 类） |
| 2 | description | string | ✅ | input |
| 3 | materialCode | string | ❌ | input |
| 4 | quantity | number | ✅ | input number |
| 5 | unit | string | ✅ | select（YD/M/KG/PC/SET） |
| 6 | wastagePercent | number | ❌ | input number（默认 0） |
| 7 | unitCost | number | ✅ | input number |
| 8 | notes | string | ❌ | —（API 支持，UI 当前未展示） |

### 3.2 物料类型 8 类

| materialType | 中文 | badge 语义色 |
|-------------|------|-------------|
| Main | 主料 | info |
| Contrast | 对比料 | info |
| Lining | 里布 | neutral |
| Pocketing | 口袋布 | neutral |
| Trimmings | 辅料 | warning |
| Thread | 缝纫线 | warning |
| Packaging | 包装 | neutral |
| Other | 其他 | neutral |

### 3.3 单位 5 类

`UNITS = ['YD', 'M', 'KG', 'PC', 'SET']`

### 3.4 行操作

| 操作 | 触发 | 行为 |
|------|------|------|
| 添加行 | 「添加行」按钮 | `setLines([...lines, { materialType: 'Main', ... }])` |
| 删除行 | 行尾「删除」按钮 | `setLines(lines.filter((_, i) => i !== index))` |
| 修改字段 | 任一字段 onChange | `handleLineChange(index, field, value)` |

### 3.5 行布局（12 列 grid）

```
col-span-2 类型 | col-span-3 品名* | col-span-2 编码 |
col-span-1 用量 | col-span-1 单位 | col-span-1 损耗% | col-span-1 单价 |
col-span-1 [删除]
```

---

## §4 成本估算项（CostEstimate）编辑

### 4.1 成本估算项字段

| # | 字段 | 类型 | 必填 | 控件 |
|---|------|------|------|------|
| 1 | costType | CostType | ✅ | select（4 类） |
| 2 | description | string | ✅ | input（如：裁剪人工 / 缝纫人工 / 厂房折旧） |
| 3 | amount | number | ✅ | input number |
| 4 | notes | string | ❌ | —（API 支持，UI 当前未展示） |

### 4.2 成本类型 4 类

| costType | 中文 | badge 语义色 | 汇总归属 |
|---------|------|-------------|---------|
| Material | 物料成本 | info | totalMaterialCost |
| Labor | 人工成本 | warning | totalLaborCost |
| Overhead | 制造费用 | neutral | totalOverheadCost |
| Other | 其他 | neutral | totalOverheadCost |

### 4.3 行操作

| 操作 | 触发 | 行为 |
|------|------|------|
| 添加成本项 | 「添加成本项」按钮 | `setCostEstimates([...costEstimates, { costType: 'Labor', ... }])` |
| 删除成本项 | 行尾「删除」按钮 | `setCostEstimates(costEstimates.filter((_, i) => i !== index))` |
| 修改字段 | 任一字段 onChange | `handleCostChange(index, field, value)` |

---

## §5 耗料公式与成本计算

### 5.1 耗料公式（核心单真源）

代码真源：`bomService.ts` L114-L121

```typescript
/** 实际用量 = quantity * (1 + wastage%) */
export function calcEffectiveQty(quantity: number, wastagePercent: number): number {
  return round4(quantity * (1 + wastagePercent / 100));
}

/** 行金额 = effectiveQty * unitCost */
export function calcLineAmount(effectiveQty: number, unitCost: number): number {
  return round4(effectiveQty * unitCost);
}
```

**精度**：`round4(n) = Math.round(n * 10000) / 10000`（4 位小数）

### 5.2 成本汇总公式

代码真源：`bomService.ts` `aggregateCosts()` L142-L166

```
lineMaterialCost = Σ(calcLineAmount(calcEffectiveQty(qty, wastage), unitCost))  // 所有 BOMLine
extraMaterialCost = Σ(CostEstimate where costType=Material)
totalMaterialCost = lineMaterialCost + extraMaterialCost

totalLaborCost = Σ(CostEstimate where costType=Labor)
totalOverheadCost = Σ(CostEstimate where costType=Overhead or Other)
totalCost = totalMaterialCost + totalLaborCost + totalOverheadCost
```

### 5.3 利润分析公式

```
profitAmount = sellingPrice - totalCost
profitMargin = (profitAmount / sellingPrice) × 100   (sellingPrice > 0 时)
```

### 5.4 前端实时计算（useMemo）

代码真源：`BomManager.tsx` L561-L575

```typescript
const costSummary = useMemo(() => {
  const materialCost = lines.reduce((sum, l) => {
    const eff = l.quantity * (1 + (l.wastagePercent ?? 0) / 100);
    return sum + eff * l.unitCost;
  }, 0);
  const extraMaterial = costEstimates.filter(c => c.costType === 'Material').reduce(...);
  const laborCost = costEstimates.filter(c => c.costType === 'Labor').reduce(...);
  const overheadCost = costEstimates.filter(c => c.costType === 'Overhead' || c.costType === 'Other').reduce(...);
  const totalMaterial = materialCost + extraMaterial;
  const totalCost = totalMaterial + laborCost + overheadCost;
  const sp = sellingPrice ? parseFloat(sellingPrice) : 0;
  const profitAmount = sp ? sp - totalCost : 0;
  const profitMargin = sp > 0 ? (profitAmount / sp) * 100 : 0;
  return { totalMaterial, laborCost, overheadCost, totalCost, profitAmount, profitMargin };
}, [lines, costEstimates, sellingPrice]);
```

**设计原则**：前端实时计算与后端 `aggregateCosts()` 公式完全对齐（单真源），保存时后端再算一次（防篡改）。

---

## §6 实时成本汇总卡

### 6.1 5 格汇总（创建弹窗内）

| 位置 | 指标 | 数据源 |
|------|------|--------|
| 1 | 物料合计 | `costSummary.totalMaterial` |
| 2 | 人工合计 | `costSummary.laborCost` |
| 3 | 费用合计 | `costSummary.overheadCost` |
| 4 | 总成本 | `costSummary.totalCost`（字号 text-base 强调） |
| 5 | 利润率 | `costSummary.profitMargin`（有售价时 success/danger 色；无售价时"填入售价"） |

### 6.2 详情展开的 4 宫格 + 利润条

| 区块 | 字段 |
|------|------|
| 4 宫格 | 物料成本 / 人工成本 / 制造费用 / 总成本 |
| 利润条 | 销售单价 / 利润额 / 利润率（success-tint 背景） |

---

## §7 物料明细表（详情展开）

### 7.1 表列定义

| # | 列标题 | 字段 | 对齐 |
|---|--------|------|------|
| 1 | # | `line.lineNumber` | 左 |
| 2 | 类型 | `line.materialType` → badge | 左 |
| 3 | 物料编码 | `line.materialCode` | 左（bds-mono） |
| 4 | 品名 | `line.description` | 左 |
| 5 | 用量 | `line.quantity` + `line.unit` | 右（num） |
| 6 | 损耗 | `line.wastagePercent`% | 右（num） |
| 7 | 实耗 | `line.effectiveQty` | 右（num） |
| 8 | 单价 | `formatCurrency(line.unitCost)` | 右（num） |
| 9 | 金额 | `formatCurrency(line.amount)` | 右（num，bds-tnum 强调） |

### 7.2 表样式

- `bds-table` + `rounded-inset overflow-hidden overflow-x-auto`
- 背景 `var(--bg-panel)`
- 表头 `<thead><tr><th>` 标准 bds-table 头

---

## §8 状态操作按钮

### 8.1 按状态显示的操作

代码真源：`BomManager.tsx` L468-L507

| 当前状态 | 可用按钮 |
|---------|---------|
| Draft | [确认 BOM] [重新计算] [删除] [归档] |
| Confirmed | [归档] |
| Archived | （无操作） |

### 8.2 操作行为

| 按钮 | API 调用 | 成功后 |
|------|---------|--------|
| 确认 BOM | `apiService.confirmBOM(id)` | 更新本地状态 → Confirmed |
| 重新计算 | `apiService.recalculateBOMCost(id)` | 更新详情缓存 + 列表项 |
| 删除 | `apiService.deleteBOM(id)` | 从列表移除 + 关闭展开 |
| 归档 | `apiService.archiveBOM(id)` | 更新本地状态 → Archived |

---

## §9 多级树形结构（待补）

### 9.1 当前状态

当前 BOM 为扁平物料行列表（所有 BOMLine 平级，仅 lineNumber 区分顺序），不支持嵌套树形结构。

### 9.2 设计方案（待实现）

```
BOM
├─ 主料组
│  ├─ 面料 A (Main)
│  │  ├─ 纱线 (子项)
│  │  └─ 染料 (子项)
│  └─ 里布 (Lining)
├─ 辅料组
│  ├─ 拉链 (Trimmings)
│  └─ 纽扣 (Trimmings)
└─ 包装组
   └─ 包装袋 (Packaging)
```

**数据模型变更**：BOMLine 增加 `parentId String?` 字段，支持递归查询。

**UI 变更**：物料明细表改为树形展开/折叠视图。

---

## §10 替代料管理（待补）

### 10.1 当前状态

当前无替代料字段，一个物料行只能指定一种物料。

### 10.2 设计方案（待实现）

BOMLine 增加 `substituteMaterialId String?` + `substituteMaterialCode String?`，标记替代料。

UI 在物料行编辑区增加"替代料"字段（可选），详情表增加替代料列。

---

## §11 数据模型

### 11.1 BOMLine 字段（编辑器消费）

详见 [模块概述.md](./模块概述.md) §5.2。

编辑器核心字段：materialType / materialCode / description / category / specification / supplierId / quantity / unit / wastagePercent / effectiveQty(自动) / unitCost / amount(自动) / currency / notes

### 11.2 CostEstimate 字段（编辑器消费）

详见 [模块概述.md](./模块概述.md) §5.3。

编辑器核心字段：costType / description / amount / currency / notes

### 11.3 BOM 创建输入（CreateBOMInput）

代码真源：`types.ts` L2299-L2310

```typescript
interface CreateBOMInput {
  bomNumber: string;        // 可选，服务端可自动生成
  description: string;      // 必填
  productAssetId?: string;
  orderId?: string;
  quotationId?: string;
  currency?: string;        // 默认 CNY
  sellingPrice?: number;    // 可选，利润分析用
  notes?: string;
  lines: BOMLineInput[];    // 必填，至少 1 行
  costEstimates?: CostEstimateInput[];
}
```

---

## §12 API 端点

| 方法 | 路径 | 编辑器用途 |
|------|------|-----------|
| POST | `/api/v1/bom` | 创建 BOM |
| GET | `/api/v1/bom/:id` | 获取详情（展开时） |
| PUT | `/api/v1/bom/:id` | 更新 BOM（仅 Draft） |
| POST | `/api/v1/bom/:id/confirm` | 确认 BOM |
| POST | `/api/v1/bom/:id/archive` | 归档 BOM |
| POST | `/api/v1/bom/:id/recalculate` | 重新计算成本（仅 Draft） |
| DELETE | `/api/v1/bom/:id` | 软删除（仅 Draft） |

---

## §13 权限矩阵

| 角色 | 创建 | 编辑 | 确认 | 归档 | 删除 | 重新计算 |
|------|------|------|------|------|------|---------|
| owner / admin / manager | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| sales | ✅ | ✅（Draft） | ❌ | ❌ | ✅（Draft） | ✅（Draft） |
| finance | ✅ | ✅（Draft） | ✅ | ❌ | ❌ | ✅（Draft） |
| qc | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## §14 待补的设计缺口

| # | 缺口 | 优先级 | 建议 |
|---|------|--------|------|
| 1 | 多级 BOM 树形结构 | P1 | BOMLine 增加 parentId，UI 改树形视图 |
| 2 | 替代料管理 | P1 | BOMLine 增加 substituteMaterialId |
| 3 | 耗料公式编辑器（自定义公式） | P2 | 支持按面积/重量等自定义计算 |
| 4 | 编辑现有 BOM 的弹窗（当前仅创建弹窗） | P1 | 复用 CreateBOMModal 改为 EditBOMModal |
| 5 | 物料编码从物料档案选择（当前手动输入） | P1 | 接入 Products 模块的物料选择器 |
| 6 | 供应商从 Relations 选择（当前 supplierId API 支持但 UI 未展示） | P2 | 物料行增加供应商下拉 |
| 7 | 批量导入物料行（Excel） | P2 | 增加 Excel 导入功能 |
| 8 | notes 字段 UI 展示（API 支持但创建弹窗未展示行级 notes） | P2 | 物料行/成本项增加 notes 输入 |

---

## §15 交叉链接

| 文档 | 相对路径 |
|------|---------|
| BOM 模块概述 | `./模块概述.md` |
| BOM 版本管理 | `./BOM版本管理.md` |
| 开发模块概述 | `../Development-开发/模块概述.md` |
| 订单详情页 | `../Orders-订单管理/订单详情页.md` |
| 全局交互规范 | `../../01-产品总览/5. 全局交互规范.md` |

---

## §16 相关文档索引

| 文档 | 路径 |
|------|------|
| 模块概述 | `./模块概述.md` |
| BOM 版本管理 | `./BOM版本管理.md` |
| 创建弹窗代码真源 | [BomManager.tsx L541-L847](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/components/BomManager.tsx#L541-L847) |
| 成本计算服务真源 | [bomService.ts `aggregateCosts`](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/bom/bomService.ts#L142-L166) |
| 插件化成本模型引擎 | [bomPluginEngine.ts](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/src/bom/bomPluginEngine.ts) |
| 字段类型定义 | [types.ts L2213-L2314](file:///Users/qinwengu/WorkBuddy/Claw/apps/Bambook/types.ts#L2213-L2314) |
