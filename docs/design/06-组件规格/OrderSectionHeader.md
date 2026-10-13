# OrderSectionHeader 组件规格 · 订单区块标题

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `OrderSectionHeader` |
| 定位 | 订单域统一分区头——所有面板/分区标题的唯一渲染器。结构固定为:icon + [kicker(EN) 上 / title(中文) 下] + 右侧 meta。与内容间距固定 mb-4。禁止调用方另写分区头变体(大编号/彩色竖条/行内英文等均已废除) |
| 文件路径 | `components/order/OrderSectionHeader.tsx`(51 行) |
| 消费方 | OrderClusterBlock / OrderLinesTable / RelatedEntitiesPanel / AuditHistorySection / ProductionPipeline / OrderContextSection 等 6+ 订单域组件 |
| 范式 | 纯展示型——无内部状态,无副作用;配方从 `createOrderUiSpec(isDarkMode)` 求值 |
| 优先级 | P0(订单域 UI 一致性地基) |
| 实现状态 | ✅ 已落地(iconKey 登记键 + icon 直接传 + kicker(EN)/title(中文) 双行 + meta 右侧 + wrapClassName 完整替换外壳);✅ 视觉规范唯一真源 orderUiSpec.ts;⚠️ 无折叠/展开功能(由 OrderClusterBlock 等容器层控制) |
| PRD 关联 | PRD §5.1(全局导航与分区头统一)/ §7.3(订单详情页分区结构) |
| 代码关联 | [OrderSectionHeader.tsx](../../components/order/OrderSectionHeader.tsx) / [orderUiSpec.ts](../../components/order/orderUiSpec.ts) `createOrderUiSpec / ORDER_SECTION_ICONS / OrderSectionIconKey` / [OrderClusterBlock.tsx](../../components/order/OrderClusterBlock.tsx) / [OrderLinesTable.tsx](../../components/order/OrderLinesTable.tsx) / [RelatedEntitiesPanel.tsx](../../components/RelatedEntitiesPanel.tsx) |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架(Props 接口 + 渲染结构)

```ts
interface OrderSectionHeaderProps {
  iconKey?: OrderSectionIconKey;   // 分区图标登记键(优先)
  icon?: LucideIcon;               // 直接传图标组件(登记键覆盖不到的场景)
  kicker: string;                  // 英文 overline(上位)
  title: string;                   // 中文标题(下位)
  meta?: React.ReactNode;          // 右侧元信息/统计(如 "3/10 阶段已完成")
  isDarkMode: boolean;
  wrapClassName?: string;          // 完整替换外壳类(默认 spec.headerWrap 含 mb-4)
}

const OrderSectionHeader: React.FC<OrderSectionHeaderProps> = ({
  iconKey, icon, kicker, title, meta, isDarkMode, wrapClassName,
}) => {
  const spec = createOrderUiSpec(isDarkMode);
  const Icon = icon ?? (iconKey ? ORDER_SECTION_ICONS[iconKey] : undefined);
  return (
    <div className={wrapClassName ?? spec.headerWrap}>
      <div className="flex items-center gap-2.5 min-w-0">
        {Icon && <Icon size={15} strokeWidth={1.5} className={`shrink-0 ${spec.headerIcon}`} />}
        <div className="min-w-0">
          <p className={spec.kicker}>{kicker}</p>
          <h3 className={`${spec.sectionTitle} truncate`}>{title}</h3>
        </div>
      </div>
      {meta != null && <div className={spec.headerMeta}>{meta}</div>}
    </div>
  );
};
```

### 渲染结构

```
<div className={wrapClassName ?? spec.headerWrap}>  ← 默认含 mb-4
  <div className="flex items-center gap-2.5 min-w-0">
    {Icon && <Icon size={15} strokeWidth={1.5} className={spec.headerIcon} />}
    <div className="min-w-0">
      <p className={spec.kicker}>{kicker}</p>           ← 英文 overline(上位,小字)
      <h3 className={`${spec.sectionTitle} truncate`}>{title}</h3>  ← 中文标题(下位,大字)
    </div>
  </div>
  {meta != null && <div className={spec.headerMeta}>{meta}</div>}
</div>
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `iconKey` | `OrderSectionIconKey` | 否 | — | 分区图标登记键;优先级高于 `icon`;保证全域图标唯一来源(ORDER_SECTION_ICONS 映射) |
| `icon` | `LucideIcon` | 否 | — | 直接传图标组件;仅当 `iconKey` 覆盖不到时使用(自定义场景) |
| `kicker` | `string` | 是 | — | 英文 overline(上位);如 `'Line Items'` / `'Production Pipeline'` / `'Audit Trail'` |
| `title` | `string` | 是 | — | 中文标题(下位);如 `'行明细'` / `'生产管线'` / `'变更历史'` |
| `meta` | `React.ReactNode` | 否 | — | 右侧元信息/统计;如 `'3/10 阶段已完成'` / `'12 条关联'` / `'5 条记录'` |
| `isDarkMode` | `boolean` | 是 | — | 主题标志;传给 `createOrderUiSpec(isDarkMode)` 求值配方 |
| `wrapClassName` | `string` | 否 | — | 完整替换外壳类;默认 `spec.headerWrap`(含 mb-4);表格头等自带边框场景传无 mb 变体 |

**图标优先级**:`icon ?? (iconKey ? ORDER_SECTION_ICONS[iconKey] : undefined)`——`icon` 直接传优先,`iconKey` 登记键次之,两者都无时不渲染图标。

---

## §4 ORDER_SECTION_ICONS 登记键

### §4.1 图标映射表(真源:orderUiSpec.ts)

```ts
export const ORDER_SECTION_ICONS = {
  // 固定分区
  summary: Activity,
  timeline: Activity,
  fulfillment: Zap,
  related: Network,
  context: Ship,
  audit: History,
  pipeline: Factory,
  lines: List,
  lineItem: Tag,
  // 字段 cluster(orderSchema.ORDER_CLUSTERS)
  basic: Hash,
  parties: Users,
  delivery: Calendar,
  fabric: Layers,
  sales: CircleDollarSign,
  shipment: Ship,
  sampleShipment: Package,
  sampleFabric: Scissors,
  purchase: ShoppingCart,
  instructions: ClipboardList,
  garmentProduction: Scissors,
  sampleGarment: Shirt,
} satisfies Record<string, LucideIcon>;

export type OrderSectionIconKey = keyof typeof ORDER_SECTION_ICONS;
```

### §4.2 登记键分类

| 类别 | 登记键 | 用途 |
|---|---|---|
| 固定分区 | summary / timeline / fulfillment / related / context / audit / pipeline / lines / lineItem | 订单详情页固定区块 |
| 字段 cluster | basic / parties / delivery / fabric / sales / shipment / sampleShipment / sampleFabric / purchase / instructions / garmentProduction / sampleGarment | orderSchema.ORDER_CLUSTERS 字段簇 |

**纪律**:新增分区必须先在 `ORDER_SECTION_ICONS` 登记图标——禁止调用方直接传 `icon` prop 绕过登记(破坏图标唯一来源)。

---

## §5 双行标题节奏(英文 overline + 中文)

### §5.1 kicker(英文 overline)在上

```
<p className={spec.kicker}>{kicker}</p>
```

- 字号:10px font-light uppercase tracking-wider(英文 overline 风格)
- 对比度:text-tertiary(辅助)
- 用途:国际化辅助 + 视觉层次上位

### §5.2 title(中文)在下

```
<h3 className={`${spec.sectionTitle} truncate`}>{title}</h3>
```

- 字号:较大(spec.sectionTitle 驱动)
- 字重:font-light(300)
- 对比度:text-primary(主)
- `truncate`:过长时省略号截断

**节奏意图**:英文 overline 在上 + 中文在下——承载识别语义的是中文,英文仅作国际化辅助。这与 PageHeader 的中英混排节奏一致(中文主、英文辅)。

---

## §6 wrapClassName 外壳替换

### §6.1 默认外壳(spec.headerWrap)

```ts
// orderUiSpec.ts
headerWrap: 'mb-4 flex items-end justify-between gap-4',  // 默认含 mb-4
```

**默认布局**:`flex items-end justify-between gap-4`——左侧 icon+标题,右侧 meta,底部对齐(items-end),mb-4 与内容间距。

### §6.2 表格头场景(无 mb 变体)

```tsx
// OrderLinesTable.tsx
<OrderSectionHeader
  iconKey="lines"
  kicker="Line Items"
  title="行明细"
  meta={`${lines.length} 行 · 总数量 ${sum(...).toLocaleString()}`}
  isDarkMode={isDarkMode}
  wrapClassName="flex items-end justify-between gap-4"  ← 无 mb(表格头自带 border-b)
/>
```

**场景**:表格头自带 `border-b`,无需 mb-4 间距——传 `wrapClassName` 完整替换外壳,去掉 mb。

---

## §7 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 默认态 | 正常渲染 | icon + kicker(EN) + title(中文) + meta | kicker + title + meta |
| 无图标 | `iconKey` 与 `icon` 均未传 | 仅 kicker + title + meta(无图标占位) | — |
| 无 meta | `meta === null \|\| undefined` | 仅左侧 icon + 标题(右侧不渲染) | — |
| 表格头 | `wrapClassName` 传无 mb 变体 | 同默认但无 mb-4 间距 | — |
| 无权限 | 父组件层控制 | 父组件不渲染 OrderSectionHeader | — |

> **无折叠态说明**:OrderSectionHeader 本身无折叠/展开功能——折叠由容器层(OrderClusterBlock 等)控制。OrderSectionHeader 仅负责标题渲染,不承担交互。

---

## §8 联动(orderUiSpec 配方求值)

### §8.1 createOrderUiSpec 求值

```ts
const spec = createOrderUiSpec(isDarkMode);
// spec.headerWrap / spec.headerIcon / spec.kicker / spec.sectionTitle / spec.headerMeta
```

**求值时机**:每次组件渲染时求值(无 useMemo 缓存)。`createOrderUiSpec` 是纯函数,根据 isDarkMode 返回配方对象。

### §8.2 与消费方的联动

```
OrderClusterBlock
  ↓
<OrderSectionHeader iconKey={cluster.id} kicker={cluster.labelEn} title={cluster.labelZh} />
  ↓
渲染统一分区头
  ↓
下方渲染 fields.map(renderField) 字段网格
```

**典型消费方**:
- OrderClusterBlock:iconKey=cluster.id, kicker=cluster.labelEn, title=cluster.labelZh
- OrderLinesTable:iconKey='lines', kicker='Line Items', title='行明细', meta=`${lines.length} 行 · 总数量 ...`
- RelatedEntitiesPanel:iconKey='related', kicker='Entity Links', title='关联视图', meta=`${data.total} 条关联`
- AuditHistorySection:iconKey='audit', kicker='Audit Trail', title='变更历史', meta=`${logs.length} 条记录`
- ProductionPipeline:iconKey='pipeline', kicker='Production Pipeline', title='生产管线', meta=`${doneCount}/${stages.length} 阶段已完成`

---

## §9 状态机

OrderSectionHeader 无内部状态,无状态机。所有内容由 props 驱动,配方由 `createOrderUiSpec(isDarkMode)` 求值。

---

## §10 数据模型

```ts
import type { LucideIcon } from 'lucide-react';
import { ORDER_SECTION_ICONS, type OrderSectionIconKey } from './orderUiSpec';

interface OrderSectionHeaderProps {
  iconKey?: OrderSectionIconKey;
  icon?: LucideIcon;
  kicker: string;
  title: string;
  meta?: React.ReactNode;
  isDarkMode: boolean;
  wrapClassName?: string;
}

// OrderUiSpec 配方片段(真源:orderUiSpec.ts)
interface OrderUiSpec {
  headerWrap: string;      // 'mb-4 flex items-end justify-between gap-4'
  headerIcon: string;      // 图标颜色类
  kicker: string;          // 英文 overline 配方
  sectionTitle: string;    // 中文标题配方
  headerMeta: string;      // 右侧 meta 配方
  // ... 其他配方
}
```

---

## §11 API 端点清单

OrderSectionHeader 是纯展示组件,**不调用任何 API**。

---

## §12 权限与可见性

OrderSectionHeader 无独立权限态——可见性由父组件控制。所有角色的页面只要父组件渲染了 OrderSectionHeader,标题本身对主题透明,无 scope 过滤。

---

## §13 设计系统约束(BDS)

- **外壳**:`spec.headerWrap`(默认 `mb-4 flex items-end justify-between gap-4`),可由 `wrapClassName` 完整替换
- **图标**:lucide-react,size=15 strokeWidth=1.5,`shrink-0 ${spec.headerIcon}` 颜色类
- **kicker(英文 overline)**:`spec.kicker` 配方(10px font-light uppercase tracking-wider text-tertiary)
- **title(中文)**:`spec.sectionTitle` 配法(较大字号 font-light text-primary) + `truncate`
- **meta(右侧)**:`spec.headerMeta` 配方
- **圆角**:无(分区头本身无圆角)
- **颜色**:全部走 `spec.*` 配方(由 orderUiSpec 求值),禁止硬编码
- **字重**:font-light(300,kicker 与 title 均为 300,符合全局 ≤300 铁律)
- **间距**:mb-4(默认与内容间距),表格头场景去 mb
- **防回退**:`scripts/check-design-tokens.sh` 扫描硬编码;配方必须从 orderUiSpec 取

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-OSH1 | **无折叠/展开功能**(由容器层控制) | 调用方需自行实现折叠逻辑,可能不一致 | P3(设计意图,非缺口) |
| GAP-OSH2 | 无「跳转到此分区」锚点链接 | Detail Map 锚点导航无法定位 | P3 |
| GAP-OSH3 | meta 无统一组件(各调用方手写 ReactNode) | meta 样式可能不一致 | P3 |
| GAP-OSH4 | icon 直接传(`icon` prop)绕过登记键的场景无守护 | 调用方可能滥用 icon prop 破坏图标唯一来源 | P3 |
| GAP-OSH5 | 无响应式收缩(窄屏时 meta 可能溢出) | 小屏 / 分屏场景 meta 被截断 | P3 |

---

## §15 相关文档索引

- [../00-索引.md](../00-索引.md) — 设计文档真源总索引
- [../04-模块设计/03-订单与生产/Orders-订单管理/订单详情页.md](../04-模块设计/03-订单与生产/Orders-订单管理/订单详情页.md) — 订单详情页分区结构
- [OrderClusterBlock.md](./OrderClusterBlock.md) — 字段簇块(直接消费 OrderSectionHeader)
- [OrderLinesTable.md](./OrderLinesTable.md) — 订单行表格(直接消费 OrderSectionHeader)
- [RelatedEntitiesPanel.md](./RelatedEntitiesPanel.md) — 关联面板(直接消费 OrderSectionHeader)
- [AuditHistorySection.md](./AuditHistorySection.md) — 审计面板(直接消费 OrderSectionHeader)
- [ProductionPipeline.md](./ProductionPipeline.md) — 生产管线(直接消费 OrderSectionHeader)
- [PageHeader.md](./PageHeader.md) — 页面头部(中英混排节奏同源)
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板容器(分区头父容器)
- [BDS组件族7规格.md](./BDS组件族7规格.md) — orderUiSpec 配方规格

---

## §16 补充说明

1. **统一分区头唯一渲染器铁律**:OrderSectionHeader 是订单域所有面板/分区标题的唯一渲染器——结构固定为 icon + [kicker(EN) 上 / title(中文) 下] + 右侧 meta。禁止调用方另写分区头变体(大编号/彩色竖条/行内英文等均已废除)。这是订单域 UI 一致性地基
2. **图标登记键优先铁律**:`iconKey` 登记键优先于 `icon` 直接传——新增分区必须先在 `ORDER_SECTION_ICONS` 登记图标,保证全域图标唯一来源。`icon` prop 仅用于登记键覆盖不到的自定义场景
3. **双行标题节奏(英文 overline + 中文)**:kicker(英文)在上 + title(中文)在下——承载识别语义的是中文,英文仅作国际化辅助。这与 PageHeader 的中英混排节奏一致(中文主、英文辅)
4. **mb-4 固定间距铁律**:默认 `spec.headerWrap` 含 `mb-4`——分区头与内容的唯一间距。表格头等自带边框场景传 `wrapClassName` 去掉 mb,但布局结构(flex items-end justify-between gap-4)保持一致
5. **配方从 orderUiSpec 求值**:所有视觉配方(headerWrap / headerIcon / kicker / sectionTitle / headerMeta)从 `createOrderUiSpec(isDarkMode)` 求值——禁止在 tsx 中硬编码颜色/字重/字号。这是订单域配方统一真源
6. **无折叠态设计意图**:OrderSectionHeader 本身无折叠/展开功能——折叠由容器层(OrderClusterBlock 等)控制。这是职责分离:OrderSectionHeader 仅负责标题渲染,容器负责折叠交互
7. **全订单域 6+ 组件共用**:OrderClusterBlock / OrderLinesTable / RelatedEntitiesPanel / AuditHistorySection / ProductionPipeline / OrderContextSection 等 6+ 组件均直接消费 OrderSectionHeader——一处修改,全订单域联动。这是 BDS 一致性地基
