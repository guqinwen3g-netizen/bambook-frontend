# OrderLinesTable 组件规格 · 订单行明细表格

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `OrderLinesTable` |
| 定位 | 订单详情页"行明细"分区的只读表格渲染器——把 `Order.lines`（`OrderLineLite[]`）以 12 列宽表呈现，替代旧的"仅显示 line[0]"模式，避免多行 PO 在卡片中隐性丢失；与字典驱动的 `OrderClusterBlock` 配合形成"汇总表 + 行级字段簇"双视图 |
| 文件路径 | `components/order/OrderLinesTable.tsx`（143 行） |
| 消费方 | `components/OrderManager.tsx`（订单详情页 `#order-detail-lines` 锚点，第 1684 行；仅当 `selectedOrder.lines` 非空且未选中单行时渲染） |
| 范式 | 纯展示型——无内部状态、无副作用；入参 `lines` 为空数组或 undefined 时进入空态面板 |
| 优先级 | P1（订单详情页核心分区，多行 PO 必备） |
| 实现状态 | ✅ 已落地（只读查阅版）；⚠️ 当前不支持增删改/拖拽排序——这些能力归属 `OrderLineFieldRenderer` + 行级字段簇编辑路径，本表仅承担查阅态汇总展示；行级编辑通过 `OrderManager` 的 `selectedLineItem` 状态切换到单行详情面板 |
| PRD 关联 | PRD §3.2（订单详情页分区）/ §6.1（OrderLine 数据模型）/ §8.4（行级权限） |
| 代码关联 | [OrderLinesTable.tsx](../../components/order/OrderLinesTable.tsx) / [OrderManager.tsx](../../components/OrderManager.tsx)（消费方，第 1684 行）/ [OrderSectionHeader.tsx](../../components/order/OrderSectionHeader.tsx)（分区头复用）/ [SidePanelContainer.tsx](../../components/ui/SidePanelContainer.tsx)（玻璃面板外壳）/ [orderUiSpec.ts](../../components/order/orderUiSpec.ts)（文字层级配方）/ [bambookOsTokens.ts](../../components/ui/bambookOsTokens.ts)（table 控件配方）/ [types.ts](../../types.ts) `OrderLineLite`（第 825 行）/ [dateFormat.ts](../../lib/dateFormat.ts) `formatYmd` |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架（Props 接口 + 渲染结构）

```ts
interface OrderLinesTableProps {
  /** 订单行列表，来自 Order.lines（OrderLineLite[]）。undefined / 空数组进入空态 */
  lines: OrderLineLite[] | undefined;
  /** 深色模式标志，透传给 SidePanelContainer / OrderSectionHeader / orderUiSpec */
  isDarkMode?: boolean;
  /** 单价/小计列的货币单位提示（如 'USD' / 'CNY'），渲染于表头"单价"后括号 */
  currency?: string;
}

const OrderLinesTable: React.FC<OrderLinesTableProps> = ({ lines, isDarkMode = false, currency }) => {
  const orderSpec = createOrderUiSpec(isDarkMode);
  // 从 BAMBOOK_OS.controls.table 取表头/行 hover/单元格边框/弱化单元格配方
  // ...

  // 空态：SidePanelContainer + emptyText 提示
  if (!lines || lines.length === 0) { /* §7 空态 */ }

  // 非空：SidePanelContainer + OrderSectionHeader + 横向滚动 table
  return (
    <SidePanelContainer materialRole="raisedCard" spotlight edgeFadeItem ...>
      <header className="px-4 py-4 border-b {cellBorder}">
        <OrderSectionHeader iconKey="lines" kicker="Line Items" title="行明细"
          meta="{n} 行 · 总数量 {sum}" wrapClassName="flex items-end justify-between gap-4" />
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] table-fixed border-separate border-spacing-0 ...">
          <colgroup>{/* 12 列宽度分配 §5 */}</colgroup>
          <thead>{/* 12 列表头 §5 */}</thead>
          <tbody>{/* lines.map → 单行 12 列 §6 */}</tbody>
        </table>
      </div>
    </SidePanelContainer>
  );
};
```

### 渲染结构

```
<SidePanelContainer materialRole="raisedCard" spotlight edgeFadeItem>  ← 玻璃面板外壳
  <header className="px-4 py-4 border-b">  ← 表头外壳（自带 border-b，故 OrderSectionHeader 去 mb）
    <OrderSectionHeader iconKey="lines" kicker="Line Items" title="行明细"
      meta="{n} 行 · 总数量 {sum.toLocaleString()}" />  ← 右侧统计
  </header>
  <div className="overflow-x-auto">  ← 窄屏横向滚动容器
    <table className="w-full min-w-[980px] table-fixed border-separate border-spacing-0">
      <colgroup>  ← 12 列固定百分比宽度（§5.1）
        5% / 10% / 10% / 16% / 11% / 7% / 7% / 8% / 8% / 8% / 8% / 5%
      </colgroup>
      <thead>  ← 表头行（§5.2）
        # | 客供品号 | 工厂品色号 | 描述/颜色 | 面料 | 门幅 | 克重 | 数量 | 单价(cur) | 小计 | 出厂日期 | 到港日期
      </thead>
      <tbody className="divide-y">  ← 数据行
        {lines.map(l => <tr key={l.id ?? l.lineNumber} className="hover:bg-white/28 ...">
          <td>{l.lineNumber}</td>           ← 行号（tabular-nums）
          <td>{l.materialCode || '—'}</td>  ← 客供品号（primary 文字）
          <td>{l.millQuality || '—'}</td>   ← 工厂品色号（secondary）
          <td>{l.description || '—'}</td>   ← 描述/颜色（secondary，truncate）
          <td>{l.cloth || '—'}</td>         ← 面料（secondary）
          <td>{l.width || '—'}</td>         ← 门幅（secondary）
          <td>{l.weight || '—'}</td>        ← 克重（secondary）
          <td className="text-right tabular-nums">{quantity.toLocaleString()} {unit}</td>
          <td className="text-right tabular-nums">{fmt(unitPrice)}</td>   ← §6 fmt()
          <td className="text-right tabular-nums">{fmt(netValue)}</td>    ← 小计
          <td>{formatYmd(l.exMillDate) || '—'}</td>      ← 出厂日期
          <td>{formatYmd(l.deliveryDate) || '—'}</td>    ← 到港日期
        </tr>)}
      </tbody>
    </table>
  </div>
</SidePanelContainer>
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `lines` | `OrderLineLite[] \| undefined` | 是 | — | 订单行列表，来自 `Order.lines`；undefined 或空数组触发空态面板（§7.1） |
| `isDarkMode` | `boolean` | 否 | `false` | 深色模式标志，透传给 `SidePanelContainer` / `OrderSectionHeader`；同时驱动 `createOrderUiSpec(isDarkMode)` 取文字层级配方与 `BAMBOOK_OS.controls.table.*` 主题变体 |
| `currency` | `string` | 否 | `undefined` | 单价列货币单位提示（如 `'USD'` / `'CNY'`）；提供时表头展示 `单价 (USD)`；不提供时仅展示 `单价`；不影响数值格式化（数值走 §6 `fmt()`） |

**渲染门禁**：`lines` 为 undefined 或空数组时进入空态面板（§7.1），不渲染表格主体。这避免在订单未关联行明细时展示空 tbody。

**无内部状态**：组件内不持有 `useState` / `useRef` / `useEffect`；所有数据由父级 `OrderManager` 通过 `selectedOrder.lines` 单向流入；行级编辑入口由父级 `selectedLineItem` 状态切换。

---

## §4 列宽与表头规范

### §4.1 12 列固定宽度配方

`<colgroup>` 中每列以百分比固定宽度，`min-w-[980px]` 保证窄屏不挤压：

| # | 列名 | 宽度 | 字段 | 文字层级 | 对齐 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `#` | 5% | `lineNumber` | muted | left | 行号，`tabular-nums` |
| 2 | 客供品号 | 10% | `materialCode` | primary | left | ZROH，`truncate` |
| 3 | 工厂品色号 | 10% | `millQuality` | secondary | left | Mill Quality，`truncate` |
| 4 | 描述/颜色 | 16% | `description` | secondary | left | BLACK SOLID 等，`truncate` |
| 5 | 面料 | 11% | `cloth` | secondary | left | `truncate` |
| 6 | 门幅 | 7% | `width` | secondary | left | `truncate` |
| 7 | 克重 | 7% | `weight` | secondary | left | `truncate` |
| 8 | 数量 | 8% | `quantity` + `unit` | primary | right | `tabular-nums` |
| 9 | 单价 | 8% | `unitPrice` | secondary | right | `tabular-nums`，表头带 `(currency)` |
| 10 | 小计 | 8% | `netValue` | primary | right | `tabular-nums` |
| 11 | 出厂日期 | 5% | `exMillDate` | secondary | left | `formatYmd`，`whitespace-nowrap` |
| 12 | 到港日期 | 5% | `deliveryDate` | secondary | left | `formatYmd`，`whitespace-nowrap` |

> **注**：原 `#order-detail-lines` 容器宽度由 `OrderManager` 详情页布局决定，本表 `min-w-[980px]` 触发 `overflow-x-auto` 横向滚动而非强制父级变宽，避免破坏详情页主轴节奏。

### §4.2 表头视觉规范

- 表头底色：`BAMBOOK_OS.controls.table.header` = `bg-white/14 dark:bg-[rgb(var(--os-vnext-brand-blue-rgb)/0.018)]`（极淡蓝色膜）
- 表头边框：`BAMBOOK_OS.controls.table.cellBorder` = `border-white/24 dark:border-white/[0.030]`
- 表头文字：`orderSpec.textMuted`（弱化层级）+ `BAMBOOK_OS.typography.weight.tableHeader` + `BAMBOOK_OS.typography.tracking.label`
- 表头 padding：`px-4 py-3`，`whitespace-nowrap` 防折行

### §4.3 行 hover 与分隔

- 行 hover：`BAMBOOK_OS.controls.table.rowHover` = `hover:bg-white/28 dark:hover:bg-white/[0.035]`
- 行间分隔：`divide-y divide-slate-200/45 dark:divide-white/[0.045]`
  - **设计纪律**：亮色模式用 `slate-200/45` 而非 `white/45`——后者在浅色背景上不可见，是早期笔误的修正（代码注释已标注）
- 过渡：`transition-[background,color] duration-200`

---

## §5 内部逻辑

### §5.1 配方初始化

```ts
const orderSpec = createOrderUiSpec(isDarkMode);
const tableHeaderClass    = BAMBOOK_OS.controls.table.header;
const tableRowHoverClass  = BAMBOOK_OS.controls.table.rowHover;
const tableRowDividerClass = 'divide-slate-200/45 dark:divide-white/[0.045]';
const tableCellBorderClass = BAMBOOK_OS.controls.table.cellBorder;
const quietTextClass      = BAMBOOK_OS.tone.text.quiet;
const mutedCellClass      = BAMBOOK_OS.controls.table.cellMuted;
const primaryTextClass    = orderSpec.textPrimary;
const secondaryTextClass  = orderSpec.textSecondary;
```

所有视觉配方来自 `BAMBOOK_OS` 与 `createOrderUiSpec`——禁止在表格内手写颜色或圆角（BDS 基线纪律）。

### §5.2 空态门禁

```ts
if (!lines || lines.length === 0) {
  return <SidePanelContainer ...><div className={orderSpec.emptyText}>
    本订单暂无行明细 · 手动录入或自动导入后会出现在这里
  </div></SidePanelContainer>;
}
```

空态走 `SidePanelContainer` 同外壳，仅替换内容为 `emptyText` 提示文案，保证分区节奏一致。

### §5.3 求和与格式化辅助

```ts
function sum(xs: number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
```

- `sum`：聚合行数量到分区头 meta（`总数量 X`），用 `toLocaleString()` 千分位
- `fmt`：单价/小计数值统一格式化——`null/undefined/NaN` → `'—'`；否则 2-4 位小数 + 千分位
- 日期统一走 `formatYmd`（`lib/dateFormat.ts`），返回空字符串时以 `'—'` 占位

### §5.4 行 key 策略

```tsx
<tr key={l.id ?? l.lineNumber} ...>
```

- 优先用 `OrderLineLite.id`（后端生成的稳定 UUID）
- 兜底用 `lineNumber`（导入向导生成的临时行可能无 id）
- **风险**：若两临时行 `lineNumber` 重复会触发 React key 冲突——上游导入向导必须保证 `lineNumber` 唯一（已在 `lib/orderLineItems.ts` 校验）

---

## §6 单元格渲染规则

### §6.1 数值列

| 列 | 渲染逻辑 |
|---|---|
| `#` | `{l.lineNumber}` 直接输出，`tabular-nums` + `mutedCellClass` |
| 数量 | `{Number(l.quantity \|\| 0).toLocaleString()} {l.unit \|\| ''}`，右对齐 + tabular-nums + primary 文字；`unit` 缺失时不展示单位后缀 |
| 单价 | `fmt(l.unitPrice)`（§5.3），右对齐 + secondary 文字 |
| 小计 | `fmt(l.netValue)`，右对齐 + primary 文字（与单价形成主次对比） |

### §6.2 文本列（truncate 兜底）

| 列 | 字段 | 缺省值 |
|---|---|---|
| 客供品号 | `l.materialCode` | `'—'` |
| 工厂品色号 | `l.millQuality` | `'—'` |
| 描述/颜色 | `l.description` | `'—'` |
| 面料 | `l.cloth` | `'—'` |
| 门幅 | `l.width` | `'—'` |
| 克重 | `l.weight` | `'—'` |

所有文本列均加 `truncate`，超出列宽时以省略号截断；hover 不展开（详情查看出入口在单行详情面板）。

### §6.3 日期列

```tsx
<td className="px-4 py-3 whitespace-nowrap {secondaryTextClass}">
  {formatYmd(l.exMillDate) || '—'}
</td>
```

- `formatYmd` 把 ISO 字符串转 `YYYY-MM-DD`；返回空串时降级为 `'—'`
- `whitespace-nowrap` 防日期被截断

---

## §7 四态规范

### §7.1 空态（empty）

- 触发：`!lines || lines.length === 0`
- 视觉：`SidePanelContainer` 玻璃面板 + `orderSpec.emptyText` 文案
- 文案：`本订单暂无行明细 · 手动录入或自动导入后会出现在这里`
- 出口：无操作按钮；引导文案指向"手动录入"（`OrderClusterBlock` 行级字段簇）与"自动导入"（`ImportWizard`）

### §7.2 加载态（loading）

- **当前未实现**：组件无 loading prop；加载态由父级 `OrderManager` 在 `selectedOrder` 未就绪时不渲染本表（条件 `selectedOrder.lines && selectedOrder.lines.length > 0`）
- 后续若需要骨架屏，应在父级处理，本表保持纯展示范式

### §7.3 错误态（error）

- **当前未实现**：错误态由父级 `OrderManager` 在订单查询失败时展示全局错误横幅；本表不感知错误
- 若 `lines` 数组中某行字段缺失（如 `quantity` 为 NaN），单元格以 `'—'` 占位（§6 fmt 兜底），不抛错

### §7.4 交互态（interactive）

- **hover**：行背景变 `bg-white/28 dark:bg-white/[0.035]`，过渡 200ms
- **点击**：当前未实现——行级编辑入口由父级 `selectedLineItem` 状态切换；本表仅承担查阅态展示
- 后续若需点击行进入单行详情，应在 `OrderManager` 暴露 `onLineClick(line)` 回调，由本表透传

---

## §8 联动

### §8.1 上游：OrderManager（详情页主控）

- 数据流：`OrderManager.selectedOrder.lines` → 本表 `lines` prop
- 锚点：父级用 `<div id="order-detail-lines">` 包裹，配合详情页 Detail Map 锚点导航跳转
- 渲染条件：`!selectedLineItem && selectedOrder.lines && selectedOrder.lines.length > 0`——当选中单行时本表让位给单行详情面板
- 货币透传：`currency={selectedOrder.salesCurrency || 'USD'}`——与订单主表 `salesCurrency` 同源

### §8.2 同级：OrderSectionHeader（分区头复用）

- 通过 `iconKey="lines"` 取 `List` 图标
- `meta` 文案实时聚合行数与总数量：`{n} 行 · 总数量 {sum}`
- `wrapClassName="flex items-end justify-between gap-4"` 使 meta 右对齐
- 表头自带 `border-b`，故 `OrderSectionHeader` 不再补 `mb-4`（去 mb 协议）

### §8.3 同级：OrderClusterBlock（行级字段簇编辑）

- 本表承担"汇总查阅"，`OrderClusterBlock` 承担"行级字段编辑"
- 切换出口：父级 `selectedLineItem` 状态——本表让位，单行字段簇面板接管
- 字段同源：`OrderLineLite` 类型是双方共同契约（types.ts 第 825 行）

### §8.4 下游：SidePanelContainer（玻璃面板外壳）

- `materialRole="raisedCard"` + `spotlight` + `edgeFadeItem` 三件套
- `contentClassName="relative z-10 flex min-w-0 flex-col"`——`min-w-0` 防止 flex 子项撑爆父级
- `className="overflow-hidden"` 配合 `overflow-x-auto` 形成圆角裁剪

### §8.5 横向：ImportWizard（自动导入入口）

- 导入向导生成的临时 `OrderLineLite[]` 通过 `OrderManager` 写入 `selectedOrder.lines`，本表自动呈现
- `lineNumber` 由导入向导保证唯一（`lib/orderLineItems.ts`）

---

## §9 状态机

本组件无内部状态机。完整生命周期由父级 `OrderManager` 控制：

```
[OrderManager.selectedOrder.lines 为空]
  ↓ 父级条件渲染跳过
[本表不挂载]
  ↓ OrderManager 拉取订单详情成功，lines 非空
[本表挂载 → 空态门禁 false → 渲染表格]
  ↓ 用户点击某行（未来扩展）
[父级 selectedLineItem = line → 本表让位 → 单行详情面板挂载]
  ↓ 用户返回
[父级 selectedLineItem = null → 本表重新挂载]
```

未来若加入行选交互，状态机扩展为：

```
idle → rowHover → rowSelected → idle
              ↓                 ↑
              └─ onLineClick ──┘
```

---

## §10 数据模型

### §10.1 OrderLineLite（types.ts 第 825-870 行）

```ts
export type OrderLineStatus = 'Pending' | 'Confirmed' | 'Production' | 'Shipping' | 'Delivered' | 'Alert';

export interface OrderLineLite {
  id: string;
  orderId?: string;
  lineNumber: number;
  itemNo?: string | null;
  materialCode?: string | null;   // 客供品号 (ZROH)
  millQuality?: string | null;    // 工厂品色号 (Mill Quality)
  description?: string | null;    // 颜色/描述（BLACK SOLID 等）
  width?: string | null;
  exMillDate?: string | null;     // 出厂日期
  deliveryDate?: string | null;   // 到港日期
  quantity: number;
  unit?: string | null;
  unitPrice?: number | null;
  netValue?: number | null;
  cloth?: string | null;          // 面料
  weight?: string | null;
  status?: OrderLineStatus | null;
  productionBatch?: string | null;
  shippingDate?: string | null;
  shippingMethod?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  shipmentQuantity?: number | null;
  shipmentAmount?: number | null;
  actualPaymentDate?: string | null;
  // ... 其余字段
}
```

### §10.2 本表消费的字段（12 列映射）

| 字段 | 用途 | 缺省 |
|---|---|---|
| `id` | React key 优先值 | 兜底 `lineNumber` |
| `lineNumber` | `#` 列 + key 兜底 | 必填 |
| `materialCode` | 客供品号列 | `'—'` |
| `millQuality` | 工厂品色号列 | `'—'` |
| `description` | 描述/颜色列 | `'—'` |
| `cloth` | 面料列 | `'—'` |
| `width` | 门幅列 | `'—'` |
| `weight` | 克重列 | `'—'` |
| `quantity` | 数量列（`Number \|\| 0`） | 0 |
| `unit` | 数量列单位后缀 | 空串 |
| `unitPrice` | 单价列（`fmt()`） | `'—'` |
| `netValue` | 小计列（`fmt()`） | `'—'` |
| `exMillDate` | 出厂日期列（`formatYmd`） | `'—'` |
| `deliveryDate` | 到港日期列（`formatYmd`） | `'—'` |

### §10.3 未消费但保留的字段

`status` / `productionBatch` / `shippingDate` / `shippingMethod` / `invoiceNumber` / `invoiceDate` / `shipmentQuantity` / `shipmentAmount` / `actualPaymentDate` —— 这些字段属于"行级履约视图"，未来扩展时可增加状态 chip 列或履约进度列，但当前 12 列已覆盖核心查阅需求。

---

## §11 API

本组件不直接调用 API。数据来源链路：

```
后端 GET /api/orders/:id
  ↓ 返回 Order { lines: OrderLineLite[] }
OrderManager.fetchOrderDetail()
  ↓ setState selectedOrder
OrderManager 渲染 <OrderLinesTable lines={selectedOrder.lines} />
```

后端服务：`server/src/orders/orderService.ts`（`getOrderById` 含 `lines` 关联查询）

---

## §12 权限

### §12.1 行级权限（PRD §8.4）

- 当前 `OrderLineLite` 不携带行级权限标签；本表对所有角色一视同仁展示
- 未来若引入"销售仅看自己客户订单行"，应在后端 `orderService` 过滤 `lines` 数组，前端不做客户端裁剪（避免数据泄露）

### §12.2 字段级权限

- `unitPrice` / `netValue` 属于"成本/价格"字段——根据 PRD §9.6，仅管理层 + 财务可见
- **当前未实现**：本表对所有角色展示价格列；后续应在 `OrderManager` 根据当前用户角色决定是否传递 `currency` prop（不传则表头不展示货币单位，但仍展示数值——需配合字段级权限方案彻底隐藏）
- 推荐方案：增加 `hidePriceColumns?: boolean` prop，由父级根据权限矩阵传入；为 true 时折叠单价/小计两列

### §12.3 操作权限

- 本表为纯查阅态，不涉及增删改——无操作权限校验
- 行级编辑入口（`OrderClusterBlock`）的权限由其自身处理

---

## §13 BDS 设计系统对齐

### §13.1 三层治理

| 层 | 文件 | 本表消费点 |
|---|---|---|
| 宪法 | `styles/os-vnext.css` | `--os-vnext-brand-blue-rgb`（表头底色）/ `--text-secondary`（弱化单元格） |
| 契约 | `styles/flat-experimental.css` | flat 设计四特征——无阴影（表格无 box-shadow）、无 rim（无 border 包裹）、大圆角（`SidePanelContainer` 外壳）、半透明膜色（`bg-white/14` 表头膜） |
| 基线 | `tailwind.config.js` + `check-design-tokens.sh` | `rounded-inset`（空态）/ `tabular-nums` / `whitespace-nowrap` / `truncate` 等语义类 |

### §13.2 配方来源

| 配方 | 来源 | 用途 |
|---|---|---|
| `BAMBOOK_OS.controls.table.header` | `bambookOsTokens.ts` 第 257 行 | 表头底色 + 边框 |
| `BAMBOOK_OS.controls.table.rowHover` | 第 258 行 | 行 hover 背景 |
| `BAMBOOK_OS.controls.table.cellBorder` | 第 259 行 | 单元格边框 |
| `BAMBOOK_OS.controls.table.cellMuted` | 第 261 行 | 弱化单元格（行号列） |
| `BAMBOOK_OS.typography.weight.tableHeader` | `bambookOsTokens.ts` | 表头字重 |
| `BAMBOOK_OS.typography.weight.body` | `bambookOsTokens.ts` | 表体字重 |
| `BAMBOOK_OS.typography.tracking.label` | `bambookOsTokens.ts` | 表头字间距 |
| `orderSpec.textPrimary` / `textSecondary` / `textMuted` / `emptyText` | `orderUiSpec.ts` | 文字层级 |
| `SidePanelContainer` `materialRole="raisedCard"` + `spotlight` + `edgeFadeItem` | `SidePanelContainer.tsx` | 玻璃面板外壳 |

### §13.3 设计纪律

- ❌ 禁止在表格内手写 `bg-white/X` / `border-slate-Y` 等颜色——必须走 `BAMBOOK_OS.controls.table.*`
- ❌ 禁止手写 `rounded-[Npx]` / `box-shadow` —— flat 设计四特征
- ❌ 禁止 emerald/red/amber 等彩色状态——状态色走 `statusSemanticClass`（本表当前未引入状态列，未来若加需遵守）
- ✅ 字重仅 `font-extralight` / `font-light` / `font-normal`（400）—— 表头 `tableHeader` 字重 + 表体 `body` 字重
- ✅ 行分隔用 `divide-slate-200/45 dark:divide-white/[0.045]`——亮色模式 `slate-200/45` 修正了 `white/45` 笔误

---

## §14 缺口与后续

### §14.1 已知缺口

| ID | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-1 | 不支持行级增删改 | 行级编辑必须切到 `OrderClusterBlock` 单行详情面板，体验割裂 | P2 |
| GAP-2 | 不支持拖拽排序 | `lineNumber` 顺序由后端或导入向导决定，前端无法调整 | P3 |
| GAP-3 | 不支持行多选批量操作 | 无法批量删除/合并行 | P3 |
| GAP-4 | 无行状态 chip 列 | `OrderLineStatus` 字段未展示，履约进度不可见 | P2 |
| GAP-5 | 无字段级权限隐藏 | 价格列对所有角色可见，违反 PRD §9.6 | P1 |
| GAP-6 | 无加载骨架屏 | 父级 `selectedOrder` 未就绪时本表不挂载，无视觉反馈 | P3 |
| GAP-7 | 无横向滚动指示器 | 12 列在窄屏横向滚动时用户不知有溢出列 | P3 |

### §14.2 推荐扩展方向

1. **行选交互**：增加 `onLineClick?: (line: OrderLineLite) => void` prop，点击行触发父级 `selectedLineItem` 切换；行 hover 增加点击态视觉（`cursor-pointer` + 编辑图标浮现）
2. **行状态列**：在 `#` 列后增加状态 chip 列，用 `statusSemanticClass` 渲染 `OrderLineStatus`，宽度 7%
3. **字段级权限**：增加 `hidePriceColumns?: boolean`，为 true 时折叠单价/小计两列，`colgroup` 重排
4. **加载骨架屏**：父级 `isLoading` 时渲染 5 行骨架行（`animate-pulse` + 灰色块）
5. **横向滚动指示器**：在 `overflow-x-auto` 容器左右加渐变遮罩，提示有溢出列

### §14.3 不推荐扩展

- ❌ 不在本表内做行级编辑——保持纯展示范式，编辑走 `OrderClusterBlock`
- ❌ 不在本表内做行级审批——审批走 `NotificationCenter` + `ApprovalRequest`
- ❌ 不在本表内做行级履约进度——履约进度走 `ProductionPipeline`

---

## §15 索引

### §15.1 交叉链接

- [OrderClusterBlock.md](./OrderClusterBlock.md) — 行级字段簇编辑路径，与本表形成"汇总查阅 + 行级编辑"双视图
- [OrderSectionHeader.md](./OrderSectionHeader.md) — 分区头复用，`iconKey="lines"` 取 List 图标
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板外壳，`materialRole="raisedCard"` + `spotlight` + `edgeFadeItem`
- [DetailPanel.md](./DetailPanel.md) — 详情面板范式，本表的玻璃面板外壳与之一致
- [ImportWizard.md](./ImportWizard.md) — 自动导入入口，生成的 `OrderLineLite[]` 流入本表
- [BDS组件族7规格.md](./BDS组件族7规格.md) — x-list 表格族原语，本表的 `BAMBOOK_OS.controls.table.*` 配方源头
- [PageHeader.md](./PageHeader.md) — 页面头部组件，与本表共同构成订单详情页骨架

### §15.2 代码真源

- 实现：[components/order/OrderLinesTable.tsx](../../components/order/OrderLinesTable.tsx)
- 消费方：[components/OrderManager.tsx](../../components/OrderManager.tsx)（第 1684 行）
- 类型：[types.ts](../../types.ts) `OrderLineLite`（第 825 行）/ `OrderLineStatus`（第 823 行）
- 配方：[components/order/orderUiSpec.ts](../../components/order/orderUiSpec.ts) / [components/ui/bambookOsTokens.ts](../../components/ui/bambookOsTokens.ts)（第 256-266 行 `table` 配方）
- 工具：[lib/dateFormat.ts](../../lib/dateFormat.ts) `formatYmd`

### §15.3 设计文档关联

- [01-产品总览/4. 设计系统规范.md](../01-产品总览/4.%20设计系统规范.md) — BDS 三层治理 + flat 四特征
- [04-模块设计/03-订单与生产/Orders-订单管理/订单详情页.md](../04-模块设计/03-订单与生产/Orders-订单管理/订单详情页.md) — 订单详情页 16 大节，本表属于"行明细"分区
