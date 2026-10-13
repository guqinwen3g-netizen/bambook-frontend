# OrderLinesGrid 组件规格 · 成衣尺码分配编辑器（SizeBreakdownEditor）

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `SizeBreakdownEditor`（文档归档名 `OrderLinesGrid`） |
| 定位 | 成衣订单 `OrderLine.sizeBreakdown` 字段的专用渲染器——查阅态呈现柱状图（每尺码一列，柱高度按 `qty / maxQty` 比例），编辑态呈现尺码行列表（尺码名 + 数量 + 删除）+ 常用尺码快捷添加 + 自定义入口 + 实时柱状图预览 |
| 文件路径 | `components/order/SizeBreakdownEditor.tsx`（191 行） |
| 消费方 | `components/order/OrderLineFieldRenderer.tsx`（第 77 行，`field.type === 'jsonSizeBreakdown'` 时分发到此组件） |
| 范式 | 受控双态组件——查阅态纯展示，编辑态受控回写 `onChange`；无内部状态 |
| 优先级 | P1（成衣订单核心字段，尺码分配是生产排料的依据） |
| 实现状态 | ✅ 已落地（双态 + 常用尺码快捷 + 自定义 + 实时预览 + 重复 key 兜底）；⚠️ 当前为"尺码 → 数量"扁平字典，未支持"颜色 × 尺码"二维矩阵（GAP-1） |
| PRD 关联 | PRD §6.2（OrderLine 成衣扩展字段）/ §3.3（成衣订单录入流程）/ §7.4（尺码分配与生产排料联动） |
| 代码关联 | [SizeBreakdownEditor.tsx](../../components/order/SizeBreakdownEditor.tsx) / [OrderLineFieldRenderer.tsx](../../components/order/OrderLineFieldRenderer.tsx)（分发器，第 77 行）/ [orderUiSpec.ts](../../components/order/orderUiSpec.ts)（视觉配方真源）/ [types.ts](../../types.ts) `OrderLineLite.sizeBreakdown`（第 855 行）/ [OrderClusterBlock.md](./OrderClusterBlock.md)（行级字段簇容器） |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架（Props 接口 + 渲染结构）

```ts
interface SizeBreakdownEditorProps {
  /** 尺码分配字典，如 { S: 100, M: 200, L: 200, XL: 100 }；null/undefined 进入空态 */
  value: Record<string, number> | null | undefined;
  /** 深色模式标志，驱动 createOrderUiSpec(isDarkMode) 取配方 */
  isDarkMode?: boolean;
  /** 查阅态/编辑态切换；默认 true（查阅态） */
  readOnly?: boolean;
  /** 编辑态回写回调，回传完整字典（非 patch） */
  onChange?: (value: Record<string, number>) => void;
}

const SizeBreakdownEditor: React.FC<SizeBreakdownEditorProps> = ({
  value, isDarkMode = false, readOnly = true, onChange,
}) => {
  const spec = createOrderUiSpec(isDarkMode);
  const entries = value ? Object.entries(value).filter(([, qty]) => qty > 0) : [];

  // ── 查阅态：柱状图 ──
  if (readOnly) {
    if (entries.length === 0) return <空态文案 />;
    const maxQty = Math.max(...entries.map(([, qty]) => qty));
    return <柱状图 entries={entries} maxQty={maxQty} barHeight="h-16" />;
  }

  // ── 编辑态：行列表 + 实时预览 ──
  const allEntries = value ? Object.entries(value) : [];
  const updateEntry = (oldKey, newKey, newQty) => { /* §5.2 */ };
  const addEntry = (size = '') => { /* §5.3 */ };
  const removeEntry = (key) => { /* §5.4 */ };

  return (
    <div className="space-y-3">
      {/* 实时柱状图预览（entries.length > 0 时） */}
      {entries.length > 0 && <柱状图 barHeight="h-14" />}

      {/* 尺码行列表（allEntries.length === 0 时展示空态文案） */}
      <div className="space-y-2">
        {allEntries.map(([size, qty]) => (
          <div className="flex items-center gap-2">
            <input type="text" value={size} className="w-20 shrink-0 text-center" />
            <input type="number" value={qty} className="flex-1" min={0} />
            <button onClick={() => removeEntry(size)}><X /></button>
          </div>
        ))}
      </div>

      {/* 常用尺码快捷 + 自定义 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span>快捷添加：</span>
        {COMMON_SIZES.map(s => <button disabled={exists} onClick={() => addEntry(s)}>{s}</button>)}
        <button onClick={() => addEntry()}><Plus /> 自定义</button>
      </div>
    </div>
  );
};
```

### 渲染结构（查阅态）

```
<div className="grid grid-cols-5 gap-2 sm:grid-cols-6 md:grid-cols-8">  ← 响应式列数
  {entries.map(([size, qty]) => (
    <div className="flex flex-col items-center gap-1.5">
      <span className="text-[10px] font-light tracking-wide {listRowSecondary}">{size}</span>
      <div className="h-16 w-full overflow-hidden rounded-control flex items-end {fieldSlotEmpty}">
        <div className="w-full rounded-t-md transition-all duration-500 {timelineDotActive}"
             style={{ height: `${ratio * 100}%` }} />  ← 柱高度按 qty/maxQty 比例
      </div>
      <span className="text-xs font-light {listRowPrimary}">{qty}</span>
    </div>
  ))}
</div>
```

### 渲染结构（编辑态）

```
<div className="space-y-3">
  ├─ 实时柱状图预览（entries.length > 0 时，barHeight=h-14，duration-300）
  ├─ 尺码行列表（space-y-2）
  │   ├─ [空态文案]（allEntries.length === 0 时）
  │   └─ {allEntries.map(([size, qty]) => (
  │       <div className="flex items-center gap-2">
  │         <input text value={size} w-20 shrink-0 text-center />  ← 尺码名
  │         <input number value={qty} flex-1 min={0} />            ← 数量
  │         <button onClick={removeEntry(size)} className={deleteBtn}>
  │           <X size={14} strokeWidth={1.5} />
  │         </button>
  │       </div>
  │   ))}
  └─ 快捷添加区（flex flex-wrap items-center gap-1.5）
      ├─ <span>快捷添加：</span>
      ├─ {COMMON_SIZES.map(s => <button disabled={exists} onClick={addEntry(s)}>{s}</button>)}
      │   ├─ 可用态：quickAddBtn
      │   └─ 已添加/禁用态：quickAddBtnDisabled
      └─ <button onClick={addEntry()} className={addBtn}><Plus size={11} /> 自定义</button>
</div>
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `value` | `Record<string, number> \| null \| undefined` | 是 | — | 尺码分配字典，key 为尺码名（如 `'S'` / `'M'` / `'XL'`），value 为数量；null/undefined 进入空态 |
| `isDarkMode` | `boolean` | 否 | `false` | 深色模式标志，透传给 `createOrderUiSpec(isDarkMode)` 取所有视觉配方 |
| `readOnly` | `boolean` | 否 | `true` | 查阅态/编辑态切换；true 时仅展示柱状图，false 时展示行列表 + 快捷添加 + 实时预览 |
| `onChange` | `(value: Record<string, number>) => void` | 否 | `undefined` | 编辑态回写回调；回传**完整字典**（非 patch），由父级 `OrderLineFieldRenderer` 通过 `onChangeLine({ [key]: v })` 写回 `OrderLine` |

**渲染门禁**：
- 查阅态 + `entries.length === 0`（即 value 为空或所有 qty 为 0）→ 空态文案
- 编辑态 + `allEntries.length === 0`（即 value 为空）→ 行列表空态文案 + 快捷添加区

**受控契约**：组件不持有内部状态，所有变更通过 `onChange` 回写父级；父级更新 `value` 后重新流入，组件重新渲染。这保证尺码分配与 `OrderLine` 主表始终一致。

---

## §4 内部常量与辅助

### §4.1 常用尺码列表

```ts
const COMMON_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
```

- 覆盖 90% 成衣订单的尺码范围
- 在快捷添加区以胶囊按钮形式展示；已存在的尺码置灰禁用（`quickAddBtnDisabled`）
- 不在列表中的尺码（如 `'4XL'` / `'Free'` / `'28'`）通过"自定义"按钮添加

### §4.2 entries 过滤策略

```ts
const entries = value ? Object.entries(value).filter(([, qty]) => qty > 0) : [];
```

- 查阅态与编辑态的柱状图预览都用 `entries`（过滤 qty > 0）
- 编辑态的行列表用 `allEntries`（保留 qty = 0 的项，允许用户先添加尺码再填数量）
- **设计纪律**：qty = 0 的尺码不进入柱状图（避免 0 高度柱干扰视觉），但在行列表中保留（允许渐进式录入）

---

## §5 内部逻辑

### §5.1 配方初始化

```ts
const spec = createOrderUiSpec(isDarkMode);
const inputCls = `${spec.subFieldInput} ${spec.subFieldFocus}`;
```

- `subFieldInput`：h-9 px-3 rounded-control border + recessedField.base（雕刻质感）
- `subFieldFocus`：focus 态 border + ring（主题色）
- 所有视觉配方来自 `orderUiSpec.ts`——禁止硬编码颜色（BDS 基线纪律）

### §5.2 updateEntry（更新尺码名或数量）

```ts
const updateEntry = (oldKey: string, newKey: string, newQty: number) => {
  const next = { ...(value ?? {}) };
  delete next[oldKey];
  if (newKey.trim()) {
    next[newKey.trim()] = newQty;
  }
  onChange?.(next);
};
```

- 用 spread 浅拷贝避免直接 mutation
- 删除旧 key 后写入新 key——支持尺码名重命名（如 `'S'` → `'Small'`）
- `newKey.trim()` 为空时不写入——避免空字符串 key 污染字典
- **风险**：若 `newKey` 与已有 key 重复，会覆盖已有项——未来需加重复校验（GAP-2）

### §5.3 addEntry（添加尺码）

```ts
const addEntry = (size: string = '') => {
  const next = { ...(value ?? {}) };
  let key = size || `尺码 ${allEntries.length + 1}`;
  while (next[key] !== undefined) {
    key = `${key}′`;
  }
  next[key] = 0;
  onChange?.(next);
};
```

- 快捷添加：`size` 参数为常用尺码名（如 `'S'`）
- 自定义添加：`size` 为空串时生成默认名 `尺码 N`（N = allEntries.length + 1）
- **重复 key 兜底**：若 `key` 已存在，追加 `'′`（prime 符号）直到唯一——避免覆盖已有项
- 新增项 `qty = 0`——用户需手动填数量；qty = 0 不进入柱状图（§4.2）

### §5.4 removeEntry（删除尺码）

```ts
const removeEntry = (key: string) => {
  const next = { ...(value ?? {}) };
  delete next[key];
  onChange?.(next);
};
```

- 直接 delete key——无确认弹窗（行级操作可撤销，且确认弹窗会打断录入节奏）
- 删除后父级 `value` 更新，组件重新渲染，行列表自动收缩

### §5.5 柱状图比例计算

```ts
const maxQty = Math.max(...entries.map(([, qty]) => qty));
const ratio = maxQty > 0 ? qty / maxQty : 0;
// style={{ height: `${ratio * 100}%` }}
```

- 以最大 qty 为 100% 基准——所有柱按相对比例渲染
- `maxQty === 0` 时 ratio = 0（理论上不会发生，因为 `entries` 已过滤 qty > 0）
- 编辑态预览用 `Math.max(...entries.map(([, q]) => q), 1)`——加 1 兜底防 `Math.max()` 返回 `-Infinity`

---

## §6 渲染规则

### §6.1 柱状图（查阅态 + 编辑态预览）

| 元素 | 查阅态 | 编辑态预览 |
|---|---|---|
| 容器列数 | `grid-cols-5 sm:grid-cols-6 md:grid-cols-8` | 同左 |
| 柱高度容器 | `h-16` | `h-14`（略矮，避免预览喧宾夺主） |
| 过渡动效 | `transition-all duration-500` | `transition-all duration-300`（更快反馈） |
| 柱颜色 | `spec.timelineDotActive` | 同左 |
| 柱底容器 | `spec.fieldSlotEmpty`（弱底色档案感） | 同左 |
| 尺码名 | `text-[10px] font-light tracking-wide spec.listRowSecondary` | 同左 |
| 数量 | `text-xs font-light spec.listRowPrimary` | 同左 |

### §6.2 行列表（编辑态）

- 行容器：`flex items-center gap-2`
- 尺码输入框：`w-20 shrink-0 text-center` + `inputCls`（subFieldInput + subFieldFocus）
- 数量输入框：`flex-1` + `inputCls` + `type="number" min={0}`
- 删除按钮：`spec.deleteBtn`（h-9 w-9 方形，ghost → hover 变红）+ `<X size={14} strokeWidth={1.5} />`

### §6.3 快捷添加区（编辑态）

- 容器：`flex flex-wrap items-center gap-1.5`
- 引导文字：`mr-1 text-[10px] font-light spec.listRowSecondary` `快捷添加：`
- 常用尺码按钮：
  - 可用态：`spec.quickAddBtn`（`rounded-full border px-2.5 py-1 text-[10px] font-light`，hover 变深）
  - 禁用态（已存在）：`spec.quickAddBtnDisabled`（极淡 + `cursor-not-allowed`）
- 自定义按钮：`ml-1 spec.addBtn`（`rounded-full border border-dashed px-3 py-1.5 text-[11px] font-light`，hover 变 accent）+ `<Plus size={11} strokeWidth={1.5} />`

---

## §7 四态规范

### §7.1 空态（empty）

**查阅态空态**：
- 触发：`readOnly === true && entries.length === 0`
- 视觉：`rounded-inset px-4 py-6 text-center text-xs font-light spec.fieldReadOnlyEmpty`
- 文案：`未设置尺码分配`

**编辑态行列表空态**：
- 触发：`readOnly === false && allEntries.length === 0`
- 视觉：`rounded-inset px-4 py-4 text-center text-xs font-light spec.fieldReadOnlyEmpty`
- 文案：`尚未添加尺码，点击下方按钮开始`
- 出口：下方快捷添加区始终可见，用户可立即添加

### §7.2 加载态（loading）

- **不适用**：组件无异步操作，所有数据由 `value` prop 同步流入

### §7.3 错误态（error）

- **当前未实现**：组件不感知错误
- 输入兜底：
  - 数量输入 `Number(e.target.value) || 0`——NaN 兜底为 0
  - 尺码名 `newKey.trim()` 为空时不写入——避免空字符串 key
- 未来若需校验（如"尺码名不能重复"/"数量必须为正整数"），应在 `onChange` 前校验并展示错误提示（GAP-3）

### §7.4 交互态（interactive）

| 交互 | 触发 | 反馈 |
|---|---|---|
| 尺码名输入 | 编辑态尺码 input `onChange` | `updateEntry(size, e.target.value, qty)` → 实时回写 + 柱状图预览更新 |
| 数量输入 | 编辑态数量 input `onChange` | `updateEntry(size, size, Number(e.target.value) \|\| 0)` → 实时回写 + 柱高度过渡 |
| 删除尺码 | 点击删除按钮 | `removeEntry(size)` → 行消失 + 柱状图重排 |
| 快捷添加 | 点击常用尺码按钮（可用态） | `addEntry(s)` → 新行追加（qty=0） + 按钮置灰 |
| 自定义添加 | 点击"自定义"按钮 | `addEntry()` → 新行追加（默认名"尺码 N"，qty=0） |

---

## §8 联动

### §8.1 上游：OrderLineFieldRenderer（字段分发器）

- 分发条件：`field.type === 'jsonSizeBreakdown'`（`lib/orderSchema.ts` 中 `sizeBreakdown` 字段的 type）
- 数据流：`line?.[key]` → 本组件 `value` prop
- 回写链路：`onChange(v)` → `onChangeLine?.({ [key]: v })` → 父级 `OrderClusterBlock` 的 `onLineChange` → `OrderManager` 的 `selectedOrder.lines[i].sizeBreakdown` 更新

### §8.2 同级：OrderClusterBlock（行级字段簇容器）

- 本组件作为 `OrderClusterBlock` 的字段渲染器之一，嵌入行级字段簇面板
- `readOnly` prop 由 `OrderClusterBlock` 根据 `order.status` 与当前用户角色决定（如订单已发货则强制 readOnly）

### §8.3 同级：ProductionStepsEditor / BomItemsEditor（同类 JSON 字段渲染器）

- 同属 `OrderLineFieldRenderer` 的 `json*` 分支
- 视觉配方共享 `orderUiSpec.ts`（`subFieldInput` / `subFieldFocus` / `deleteBtn` / `addBtn` 等）
- 范式一致：受控双态 + 行列表 + 快捷添加 + 实时预览

### §8.4 下游：生产排料（未来扩展）

- `sizeBreakdown` 是生产排料的依据——未来与 `ProductionPipeline` 联动时，各尺码数量将驱动排料计算
- 当前未实现联动，`sizeBreakdown` 仅作为订单数据存储

---

## §9 状态机

本组件无内部状态机。完整生命周期由父级 `readOnly` prop 控制：

```
[readOnly=true] 查阅态
  ├─ entries.length === 0 → 空态文案
  └─ entries.length > 0   → 柱状图

[readOnly=false] 编辑态
  ├─ allEntries.length === 0 → 空态文案 + 快捷添加区
  └─ allEntries.length > 0   → 实时预览 + 行列表 + 快捷添加区

状态切换由父级 OrderClusterBlock 控制：
  order.status === 'Draft'      → readOnly=false（可编辑）
  order.status === 'Confirmed'  → readOnly=false（可编辑，但触发审计）
  order.status === 'Production' → readOnly=true（生产中锁定）
  order.status === 'Shipped'    → readOnly=true（已发货锁定）
```

编辑态内部交互流：

```
idle → inputFocus → inputChange → onChange → 父级 re-render → value 流入 → 柱状图过渡
                              ↓
                         addEntry/removeEntry → 同上
```

---

## §10 数据模型

### §10.1 OrderLineLite.sizeBreakdown（types.ts 第 855 行）

```ts
export interface OrderLineLite {
  // ...
  sizeBreakdown?: Record<string, number> | null;   // { S: 100, M: 200, L: 200, XL: 100 }
  // ...
}
```

- 类型：`Record<string, number> | null`
- key：尺码名（字符串，如 `'S'` / `'M'` / `'XL'` / `'28'` / `'Free'`）
- value：数量（正整数；0 表示"已添加但未填数量"，不进入柱状图）
- null：未设置尺码分配
- 空对象 `{}`：已清空所有尺码

### §10.2 后端存储

- Prisma schema：`sizeBreakdown Json?`（`server/prisma/schema.prisma` 中 `OrderLine` 模型）
- PostgreSQL：JSONB 列，支持结构化查询
- 序列化：前端 `Record<string, number>` 直接 JSON.stringify，后端 Prisma 自动序列化

### §10.3 数据契约

- **入参契约**：`value` 为 `Record<string, number> | null | undefined`；组件不做类型校验，依赖上游保证
- **出参契约**：`onChange` 回传完整 `Record<string, number>`（非 patch，非 null）——即使所有尺码被删除，也回传 `{}` 而非 null
- **边界**：
  - `value = null` → 查阅态空态 / 编辑态行列表空态
  - `value = {}` → 查阅态空态（entries 过滤后为空）/ 编辑态行列表空态
  - `value = { S: 0 }` → 查阅态空态（entries 过滤 qty > 0 后为空）/ 编辑态行列表展示 1 行（qty=0）

---

## §11 API

本组件不直接调用 API。数据来源链路：

```
后端 GET /api/orders/:id
  ↓ 返回 Order { lines: [{ sizeBreakdown: { S: 100, M: 200 } }] }
OrderManager.fetchOrderDetail()
  ↓ setState selectedOrder
OrderClusterBlock 渲染行级字段簇
  ↓ OrderLineFieldRenderer 分发到 SizeBreakdownEditor
  ↓ value = line.sizeBreakdown

编辑回写：
SizeBreakdownEditor.onChange(v)
  ↓ OrderLineFieldRenderer.onChangeLine({ sizeBreakdown: v })
  ↓ OrderClusterBlock.onLineChange({ sizeBreakdown: v })
  ↓ OrderManager.setState selectedOrder.lines[i].sizeBreakdown = v
  ↓ （保存时）PUT /api/orders/:id { lines: [...] }
```

后端服务：`server/src/orders/orderService.ts`（`updateOrder` 含 `lines.sizeBreakdown` JSONB 更新）

---

## §12 权限

### §12.1 字段级权限

- `sizeBreakdown` 不属于"成本/价格"字段——无字段级权限限制
- 所有角色（销售/跟单/生产/管理层/财务）均可查阅

### §12.2 编辑权限

- `readOnly` prop 由父级 `OrderClusterBlock` 根据 `order.status` + 当前用户角色决定
- 推荐规则：
  - `order.status === 'Draft'` → 销售/跟单可编辑
  - `order.status === 'Confirmed'` → 跟单可编辑（触发审计日志）
  - `order.status === 'Production'` 及以后 → 仅管理层可编辑（紧急调整）
- 当前未实现角色级权限——`readOnly` 仅由 `order.status` 决定

### §12.3 数据权限

- 尺码分配不涉及客户敏感数据——无行级权限过滤
- 后端 `orderService` 返回 `sizeBreakdown` 时不做字段级裁剪

---

## §13 BDS 设计系统对齐

### §13.1 三层治理

| 层 | 文件 | 本组件消费点 |
|---|---|---|
| 宪法 | `styles/os-vnext.css` | `--os-vnext-brand-blue-rgb`（柱状图 active 色）/ `--text-secondary`（弱化文字） |
| 契约 | `styles/flat-experimental.css` | flat 四特征——无阴影（柱状图无 box-shadow）、无 rim（无 border 包裹）、大圆角（`rounded-control` 柱底容器）、半透明膜色（`fieldSlotEmpty` 弱底色） |
| 基线 | `tailwind.config.js` + `check-design-tokens.sh` | `rounded-inset`（空态）/ `rounded-control`（柱底 + 输入框）/ `rounded-full`（快捷按钮） |

### §13.2 配方来源

| 配方 | 来源 | 用途 |
|---|---|---|
| `spec.fieldReadOnlyEmpty` | `orderUiSpec.ts` 第 369 行 | 空态文案文字色（italic 极淡） |
| `spec.fieldSlotEmpty` | 第 371 行 | 柱状图底容器弱底色 |
| `spec.timelineDotActive` | 第 394 行 | 柱状图 active 柱色（accent 雾青 + ring 光晕） |
| `spec.listRowPrimary` | 第 376 行 | 数量文字色（primary） |
| `spec.listRowSecondary` | 第 378 行 | 尺码名文字色（secondary） |
| `spec.subFieldInput` | 第 497 行 | 输入框基础样式（h-9 + recessedField） |
| `spec.subFieldFocus` | 第 500 行 | 输入框 focus 态（主题色 ring） |
| `spec.deleteBtn` | 第 503 行 | 删除按钮（h-9 w-9 ghost → hover 变红） |
| `spec.addBtn` | 第 508 行 | 自定义添加按钮（dashed border 胶囊） |
| `spec.quickAddBtn` | 第 513 行 | 常用尺码按钮可用态 |
| `spec.quickAddBtnDisabled` | 第 518 行 | 常用尺码按钮禁用态 |

### §13.3 设计纪律

- ❌ 禁止硬编码颜色——所有颜色走 `spec.*` 配方
- ❌ 禁止硬编码 `rounded-[Npx]`——用 `rounded-inset` / `rounded-control` / `rounded-full` 语义类
- ❌ 禁止 `box-shadow`——flat 设计无阴影；柱状图的"光晕"由 `ring-4 ring-accent/15` 实现（属于 focus ring 范畴，允许）
- ✅ 字重仅 `font-light`（300）——所有文字（尺码名/数量/引导文字）统一 `font-light`
- ✅ 柱状图过渡用 `transition-all duration-500`（查阅态）/ `duration-300`（编辑态预览）——编辑态更快反馈
- ✅ 输入框用 `recessedField.base`（雕刻质感）——与 `OrderClusterBlock` 主字段同源

### §13.4 视觉特征

- **柱状图**：每尺码一列，柱高度按 `qty / maxQty` 比例；柱色 `timelineDotActive`（accent 雾青 + ring 光晕）；底容器 `fieldSlotEmpty`（弱底色档案感）
- **行列表**：尺码输入框 `w-20` 固定窄宽 + 数量输入框 `flex-1` 自适应 + 删除按钮 `h-9 w-9` 方形
- **快捷添加**：胶囊按钮 `rounded-full px-2.5 py-1 text-[10px]`；可用态 hover 变深，禁用态极淡 + `cursor-not-allowed`
- **自定义按钮**：dashed border 胶囊，与快捷按钮形成视觉区分（虚线暗示"非预设"）

---

## §14 缺口与后续

### §14.1 已知缺口

| ID | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-1 | 不支持"颜色 × 尺码"二维矩阵 | 成衣订单常见"同款多色，每色多尺码"场景无法承载，需拆成多个 OrderLine | P1 |
| GAP-2 | 尺码名重复校验缺失 | `updateEntry` 时若 `newKey` 与已有 key 重复会静默覆盖 | P2 |
| GAP-3 | 无输入校验 | 数量可为负数（`min={0}` 仅限制 input，不限制程序化写入）；尺码名可为任意字符串 | P2 |
| GAP-4 | 无总数量汇总 | 用户需手动求和；父级 `OrderLine.quantity` 与 `sizeBreakdown` 各尺码之和可能不一致 | P2 |
| GAP-5 | 无批量操作 | 无法批量清零/批量删除/复制尺码分配 | P3 |
| GAP-6 | 无导入导出 | 无法从 Excel 粘贴尺码分配 | P3 |
| GAP-7 | 无历史对比 | 修改尺码分配后无法查看变更前后对比 | P3 |

### §14.2 推荐扩展方向

1. **二维矩阵**：扩展 `value` 类型为 `Record<string, Record<string, number>>`（颜色 → 尺码 → 数量），渲染为颜色行 × 尺码列的矩阵表格；保留当前扁平字典作为"单色"兼容模式
2. **重复校验**：`updateEntry` 时检查 `newKey` 是否与已有 key（除 `oldKey` 外）重复，重复时展示错误提示且不写入
3. **总数量汇总**：在快捷添加区上方展示"总数量：{sum} 件"，与 `OrderLine.quantity` 联动（自动同步或提示差异）
4. **批量操作**：增加"清零全部"/"删除全部"/"复制到其他行"按钮
5. **导入导出**：支持从剪贴板粘贴 Excel 表格（TSV 格式）→ 自动解析为尺码分配

### §14.3 不推荐扩展

- ❌ 不在本组件内做权限校验——保持纯渲染范式，权限由父级 `OrderClusterBlock` 决定 `readOnly`
- ❌ 不在本组件内做数据持久化——保持受控组件范式，所有变更通过 `onChange` 回写
- ❌ 不在本组件内做跨行联动——跨行操作（如"复制尺码分配到其他行"）应由父级 `OrderManager` 编排

---

## §15 索引

### §15.1 交叉链接

- [OrderClusterBlock.md](./OrderClusterBlock.md) — 行级字段簇容器，本组件的宿主
- [OrderLinesTable.md](./OrderLinesTable.md) — 订单行明细表格，与本组件共同构成"行汇总 + 行内尺码分配"双视图
- [OrderSectionHeader.md](./OrderSectionHeader.md) — 分区头复用范式
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板外壳规范
- [BDS组件族7规格.md](./BDS组件族7规格.md) — x-input/x-data 原语，本组件的输入框与柱状图配方源头
- [DetailPanel.md](./DetailPanel.md) — 详情面板范式，本组件的双态切换与之一致
- [ImportWizard.md](./ImportWizard.md) — 导入向导，成衣尺码分配可从 Excel 导入（未来扩展）

### §15.2 代码真源

- 实现：[components/order/SizeBreakdownEditor.tsx](../../components/order/SizeBreakdownEditor.tsx)
- 分发器：[components/order/OrderLineFieldRenderer.tsx](../../components/order/OrderLineFieldRenderer.tsx)（第 77 行）
- 类型：[types.ts](../../types.ts) `OrderLineLite.sizeBreakdown`（第 855 行）
- 配方：[components/order/orderUiSpec.ts](../../components/order/orderUiSpec.ts)（`subFieldInput` / `timelineDotActive` / `fieldSlotEmpty` 等）
- Schema：[lib/orderSchema.ts](../../lib/orderSchema.ts)（`sizeBreakdown` 字段元数据，`type: 'jsonSizeBreakdown'`）

### §15.3 设计文档关联

- [01-产品总览/4. 设计系统规范.md](../01-产品总览/4.%20设计系统规范.md) — BDS 三层治理 + flat 四特征
- [04-模块设计/03-订单与生产/Orders-订单管理/订单详情页.md](../04-模块设计/03-订单与生产/Orders-订单管理/订单详情页.md) — 订单详情页行级字段分区
