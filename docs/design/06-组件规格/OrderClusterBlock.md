# OrderClusterBlock 组件规格 · 字段簇字典驱动渲染块

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `OrderClusterBlock` |
| 定位 | 订单字段字典驱动的 cluster 渲染块——根据 `OrderClusterMeta`(cluster 元信息)+ `FieldMeta[]`(字段元信息)从 orderSchema 字典渲染一个卡片分区。支持 subGroup 分组(如 parties cluster 拆分为客户/工厂/收货人等子组)、Order 级与 OrderLine 级字段混合渲染、readOnly 只读态、density 紧凑密度 |
| 文件路径 | `components/order/OrderClusterBlock.tsx`(201 行) |
| 消费方 | `OrderManager.tsx`(订单详情页/录入表单) |
| 范式 | 字典驱动型——`cluster` + `fields` + `order` 由父组件注入;根据 fields 的 level/subGroup 分发到 OrderFieldInput 或 OrderLineFieldRenderer |
| 优先级 | P1(订单详情/录入核心渲染块) |
| 实现状态 | ✅ 已落地(cluster 卡片 + subGroup 子组嵌套 + Order/OrderLine 级字段分发 + readOnly 只读 + density 紧凑 + fieldSources 来源标记 + onRelationSelected 自动填充回调);✅ 视觉规范唯一真源 orderUiSpec.ts;⚠️ 无折叠/展开(由父组件 OrderManager 控制 cluster 显隐) |
| PRD 关联 | PRD §7.3(订单详情页分区结构)/ §7.4(订单字段字典驱动) |
| 代码关联 | [OrderClusterBlock.tsx](../../components/order/OrderClusterBlock.tsx) / [orderSchema.ts](../../lib/orderSchema.ts) `OrderClusterMeta / FieldMeta / PARTIES_SUBGROUPS / RoleFkTarget` / [OrderFieldInput.tsx](../../components/order/OrderFieldInput.tsx) / [OrderLineFieldRenderer.tsx](../../components/order/OrderLineFieldRenderer.tsx) / [OrderSectionHeader.tsx](../../components/order/OrderSectionHeader.tsx) / [SidePanelContainer.tsx](../../components/ui/SidePanelContainer.tsx) / [orderUiSpec.ts](../../components/order/orderUiSpec.ts) |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架(Props 接口 + 内部结构)

```ts
interface OrderClusterBlockProps {
  cluster: OrderClusterMeta;        // cluster 元信息(id/labelEn/labelZh)
  fields: FieldMeta[];              // 字段元信息数组
  order: Partial<Order>;            // 当前订单数据
  isDarkMode?: boolean;
  readOnly?: boolean;               // 只读模式(输入框 disabled)
  onChange: (patch: Partial<Order>) => void;           // Order 级字段变更
  relations?: Relation[];           // Relation 候选(供 FK 字段 combobox)
  onCreateRelation?: (typedName, fkTarget) => Promise<{id,name}|null> | {id,name} | null;  // 创建新档案
  density?: 'cozy' | 'compact';     // 紧凑密度(移动端录入 BottomSheet)
  onRelationSelected?: (fkField: string, relation: Relation) => void;  // 自动填充回调
  orderLine?: Partial<OrderLineLite> | null;           // OrderLine 级字段数据源
  onLineChange?: (patch: Partial<OrderLineLite>) => void;              // OrderLine 级字段变更
}

const OrderClusterBlock: React.FC<OrderClusterBlockProps> = ({ cluster, fields, order, ... }) => {
  if (fields.length === 0) return null;

  const spec = createOrderUiSpec(isDarkMode);
  const sources = (order.fieldSources ?? {}) as Record<string, 'pdf' | 'manual' | 'imported-then-edited'>;

  // 网格密度:compact 紧凑 / readOnly 松弛 / 编辑态默认
  const gridCls = density === 'compact'
    ? 'grid grid-cols-1 md:grid-cols-2 gap-3'
    : readOnly ? spec.gridRead : spec.gridEdit;

  // 统一分区头
  const headerEl = (
    <OrderSectionHeader iconKey={cluster.id} kicker={cluster.labelEn} title={cluster.labelZh} isDarkMode={isDarkMode} />
  );

  const renderField = (f: FieldMeta) => {
    if (f.level === 'line') {
      return <OrderLineFieldRenderer key={f.key} field={f} line={orderLine} ... />;
    }
    return <OrderFieldInput key={f.key} field={f} order={order} ... />;
  };

  // 无 subGroup:单一 OS 面板
  if (!fields.some(f => f.subGroup)) {
    return (
      <SidePanelContainer as="section" id={`section-${cluster.id}`} materialRole="raisedCard" edgeFadeItem spotlight ...>
        {headerEl}
        <div className={gridCls}>{fields.map(renderField)}</div>
      </SidePanelContainer>
    );
  }

  // 有 subGroup:分组渲染子卡
  // ...
};
```

### 渲染结构(无 subGroup)

```
<SidePanelContainer as="section" id="section-{cluster.id}" materialRole="raisedCard" spotlight edgeFadeItem>
  <OrderSectionHeader iconKey={cluster.id} kicker={cluster.labelEn} title={cluster.labelZh} />
  <div className={gridCls}>
    {fields.map(renderField)}  ← OrderFieldInput 或 OrderLineFieldRenderer
  </div>
</SidePanelContainer>
```

### 渲染结构(有 subGroup,如 parties)

```
<SidePanelContainer as="section" id="section-{cluster.id}" materialRole="raisedCard" spotlight edgeFadeItem>
  <OrderSectionHeader iconKey={cluster.id} kicker={cluster.labelEn} title={cluster.labelZh} />
  <div className="space-y-4">
    {subGroupMap.entries().map(([subId, subFields]) => (
      <SidePanelContainer as="section" id="section-parties-{subId}" materialRole="insetSurface" materialTone="nested" shadowMode="ghost">
        <div className="flex items-center gap-2 mb-3">
          <span className="h-1 w-1 rounded-full {spec.subGroupDot}" />
          <h5 className={spec.subGroupTitle}>{meta?.labelZh ?? subId}</h5>
        </div>
        <div className={gridCls}>{subFields.map(renderField)}</div>
      </SidePanelContainer>
    ))}
    {noGroup.length > 0 && <div className={gridCls}>{noGroup.map(renderField)}</div>}
  </div>
</SidePanelContainer>
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `cluster` | `OrderClusterMeta` | 是 | — | cluster 元信息;含 `id`(如 'basic'/'parties'/'delivery')/ `labelEn` / `labelZh` |
| `fields` | `FieldMeta[]` | 是 | — | 字段元信息数组;每个 FieldMeta 含 `key` / `level`('order'\|'line') / `subGroup`(可选) / 类型/标签等 |
| `order` | `Partial<Order>` | 是 | — | 当前订单数据;含全部 Order 字段 + `fieldSources`(字段来源标记) |
| `isDarkMode` | `boolean` | 否 | `false` | 主题标志 |
| `readOnly` | `boolean` | 否 | `false` | 只读模式;输入框 disabled,网格密度松弛(spec.gridRead) |
| `onChange` | `(patch: Partial<Order>) => void` | 是 | — | Order 级字段变更回调;由 OrderFieldInput 触发 |
| `relations` | `Relation[]` | 否 | — | Relation 候选列表;供 FK 字段 RelationCombobox 渲染候选 |
| `onCreateRelation` | `(typedName, fkTarget) => Promise<{id,name}\|null>` | 否 | — | 创建新 Relation 回调;FK 字段 combobox 的「创建新档案」入口 |
| `density` | `'cozy' \| 'compact'` | 否 | `'cozy'`` | 紧凑密度;`'compact'` 用于移动端录入 BottomSheet(与桌面详情不共享密度) |
| `onRelationSelected` | `(fkField, relation) => void` | 否 | — | Relation 选中回调;父组件据此自动填充其他字段(选客户后填地址/付款条款等) |
| `orderLine` | `Partial<OrderLineLite> \| null` | 否 | — | OrderLine 级字段数据源;`lineScope='first'` 时取首行 |
| `onLineChange` | `(patch: Partial<OrderLineLite>) => void` | 否 | — | OrderLine 级字段变更回调;由 OrderLineFieldRenderer 触发 |

**渲染门禁**:`fields.length === 0` 时返回 null——空 cluster 不渲染。

---

## §4 字段分发(Order 级 vs OrderLine 级)

### §4.1 renderField 分发逻辑

```ts
const renderField = (f: FieldMeta) => {
  // OrderLine 级字段(如成衣生产跟单:styleNo/sizeBreakdown/productionSteps/bomItems)
  if (f.level === 'line') {
    return (
      <OrderLineFieldRenderer
        key={f.key}
        field={f}
        line={orderLine}
        isDarkMode={isDarkMode}
        readOnly={readOnly}
        onChangeLine={onLineChange}
        relations={relations}
        onCreateRelation={onCreateRelation}
        onRelationSelected={onRelationSelected}
        sourceTag={sources[f.key as string]}
      />
    );
  }
  // Order 级字段:走标准 OrderFieldInput
  return (
    <OrderFieldInput
      key={f.key}
      field={f}
      order={order}
      isDarkMode={isDarkMode}
      readOnly={readOnly}
      onChange={onChange}
      relations={relations}
      onCreateRelation={onCreateRelation}
      onRelationSelected={onRelationSelected}
      sourceTag={sources[f.key as string]}
    />
  );
};
```

**分发依据**:`FieldMeta.level`——`'line'` 走 OrderLineFieldRenderer,其他走 OrderFieldInput。

### §4.2 fieldSources 来源标记

```ts
const sources = (order.fieldSources ?? {}) as Record<string, 'pdf' | 'manual' | 'imported-then-edited'>;
// 传给 OrderFieldInput / OrderLineFieldRenderer 的 sourceTag prop
sourceTag={sources[f.key as string]}
```

**来源标记**:
- `pdf`:PDF 导入自动识别
- `manual`:手工录入
- `imported-then-edited`:导入后手工修改

由 OrderFieldInput 在字段标签旁展示来源 chip。

---

## §5 subGroup 分组渲染

### §5.1 分组逻辑

```ts
// 有 subGroup:分组渲染子卡
const subGroupMap = new Map<string, FieldMeta[]>();
const noGroup: FieldMeta[] = [];
for (const f of fields) {
  if (f.subGroup) {
    const list = subGroupMap.get(f.subGroup) ?? [];
    list.push(f);
    subGroupMap.set(f.subGroup, list);
  } else {
    noGroup.push(f);
  }
}

const subGroupMeta = (id: string) => PARTIES_SUBGROUPS.find(s => s.id === id);
```

**分组依据**:`FieldMeta.subGroup`——有 subGroup 的字段按 subGroup 分组,无 subGroup 的字段归入 noGroup。

### §5.2 子卡渲染

```tsx
{[...subGroupMap.entries()].map(([subId, subFields]) => {
  const meta = subGroupMeta(subId);
  return (
    <SidePanelContainer key={subId} as="section" id={`section-parties-${subId}`}
      materialRole="insetSurface" materialTone="nested" shadowMode="ghost"
      isDarkMode={isDarkMode} className={spec.insetPadding} contentClassName={spec.panelContentClass}>
      {/* 子组头:小圆点前缀 + 中文标题(去掉 EN,避免与字段标签的 EN kicker 重复) */}
      <div className="flex items-center gap-2 mb-3">
        <span className={`h-1 w-1 shrink-0 rounded-full ${spec.subGroupDot}`} />
        <h5 className={spec.subGroupTitle}>{meta?.labelZh ?? subId}</h5>
      </div>
      <div className={gridCls}>{subFields.map(renderField)}</div>
    </SidePanelContainer>
  );
})}
```

**子组头特征**:
- 小圆点前缀(`h-1 w-1 rounded-full ${spec.subGroupDot}`)
- 仅中文标题(去掉 EN,避免与字段标签的 EN kicker 重复)
- `spec.subGroupTitle` 配方

### §5.3 PARTIES_SUBGROUPS 元信息

```ts
// orderSchema.ts
const PARTIES_SUBGROUPS = [
  { id: 'customer', labelZh: '客户方', ... },
  { id: 'factory', labelZh: '工厂方', ... },
  { id: 'consignee', labelZh: '收货人', ... },
  { id: 'billTo', labelZh: '账单方', ... },
  // ...
];
```

---

## §6 网格密度三档

### §6.1 density='compact'(移动端录入)

```ts
const gridCls = density === 'compact'
  ? 'grid grid-cols-1 md:grid-cols-2 gap-3'
  : ...
```

**用途**:移动端录入 BottomSheet——单列(mobile)/双列(md+)紧凑布局。

### §6.2 readOnly 松弛(查阅态)

```ts
const gridCls = ... : readOnly ? spec.gridRead : ...
```

**用途**:查阅态松弛网格——档案节奏,字段间距更大,适合只读浏览。

### §6.3 编辑态默认

```ts
const gridCls = ... : spec.gridEdit;
```

**用途**:编辑态紧凑网格——录入节奏,字段间距适中,适合快速录入。

**纪律**:compact 仅用于移动端录入 BottomSheet,**与桌面详情不共享密度**——桌面详情用 gridRead/gridEdit。

---

## §7 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 编辑态 | `readOnly=false` | `spec.gridEdit` 紧凑网格 + OrderFieldInput 可编辑 | cluster.labelZh + 字段标签 |
| 只读态 | `readOnly=true` | `spec.gridRead` 松弛网格 + OrderFieldInput disabled | 同上 |
| 紧凑态 | `density='compact'` | 单列/双列紧凑网格(移动端) | 同上 |
| 无 subGroup | `fields` 无 subGroup 字段 | 单一 OS 面板(raisedCard) | cluster.labelZh |
| 有 subGroup | `fields` 含 subGroup 字段 | 主面板 + 子组嵌套子卡(insetSurface nested) | cluster.labelZh + subGroup.labelZh |
| 空 cluster | `fields.length === 0` | `return null`(不渲染) | — |
| 无权限 | 父组件层控制 | 父组件不渲染 OrderClusterBlock | — |

---

## §8 联动(OrderFieldInput / OrderLineFieldRenderer / onRelationSelected)

### §8.1 与 OrderFieldInput 的联动

```
OrderClusterBlock
  ↓
fields.map(renderField) → <OrderFieldInput field={f} order={order} onChange={onChange} ... />
  ↓
用户编辑字段 → OrderFieldInput 调 onChange({[f.key]: value})
  ↓
OrderClusterBlock 透传 onChange(patch) → 父组件 OrderManager 更新 order state
```

### §8.2 与 RelationCombobox 的联动(FK 字段)

```
OrderFieldInput(field.fkTarget='customer')
  ↓
渲染 <RelationCombobox relations={...} filterCategories={['Customer']}
  onCreateNew={(name) => onCreateRelation(name, 'customer')} />
  ↓
用户选择候选 → onChange({name, relationId, relation})
  ↓
OrderFieldInput 调 onRelationSelected(fkField, relation)
  ↓
OrderClusterBlock 透传 onRelationSelected → 父组件自动填充
```

### §8.3 onRelationSelected 自动填充

**父组件职责**:接收 `onRelationSelected(fkField, relation)` 后,根据完整 Relation 对象自动填充订单的其他字段:
- 选客户 → 自动填充 billingAddress / shippingAddress / paymentTerms / currency / taxId / creditLimit
- 选工厂 → 自动填充工厂地址
- 选收货人 → 自动填充收货地址

**纪律**:自动填充是产品意图——减少手工录入,但用户可后续手动修改填充值。

---

## §9 状态机

OrderClusterBlock 无内部状态,无状态机。所有内容由 props 驱动,字段分发由 `FieldMeta.level` / `FieldMeta.subGroup` 决定。

```
props 输入(cluster + fields + order)
  ↓
fields.length === 0? → return null
  ↓
求值 gridCls(compact / gridRead / gridEdit)
  ↓
fields 有 subGroup?
  ├─ 否 → 单一 SidePanelContainer(raisedCard)+ headerEl + gridCls(fields.map(renderField))
  └─ 是 → 主 SidePanelContainer(raisedCard)+ headerEl + subGroupMap.entries().map(子卡 insetSurface nested)
           + noGroup.length > 0? → gridCls(noGroup.map(renderField))
  ↓
renderField 分发:
  ├─ f.level === 'line' → OrderLineFieldRenderer
  └─ 其他 → OrderFieldInput
```

---

## §10 数据模型

真源:`lib/orderSchema.ts`

```ts
interface OrderClusterMeta {
  id: string;              // 'basic' / 'parties' / 'delivery' / 'fabric' / 'sales' / ...
  labelEn: string;         // 英文 overline
  labelZh: string;         // 中文标题
}

interface FieldMeta {
  key: string;             // 字段键(如 'poNumber' / 'customerId')
  level: 'order' | 'line'; // 字段层级
  subGroup?: string;       // 子组 id(如 'customer' / 'factory')
  type: string;            // 字段类型(text/number/date/select/fk/...)
  labelEn?: string;
  labelZh: string;
  required?: boolean;
  fkTarget?: RoleFkTarget; // FK 目标(如 'customer' / 'factory')
  // ... 其他字段元信息
}

type RoleFkTarget = 'customer' | 'factory' | 'consignee' | 'billTo' | 'sales' | 'merchandiser' | ...;

// PARTIES_SUBGROUPS(parties cluster 的子组元信息)
const PARTIES_SUBGROUPS: Array<{ id: string; labelZh: string }> = [
  { id: 'customer', labelZh: '客户方' },
  { id: 'factory', labelZh: '工厂方' },
  // ...
];

// Order.fieldSources(字段来源标记)
interface Order {
  // ...
  fieldSources?: Record<string, 'pdf' | 'manual' | 'imported-then-edited'>;
}
```

---

## §11 API 端点清单

OrderClusterBlock 本身**不调用 API**——字段渲染委托 OrderFieldInput / OrderLineFieldRenderer,数据变更通过 onChange/onLineChange 回传父组件。

| 关联端点 | 方法 | 用途 | 调用方 |
|---|---|---|---|
| `/v1/orders/:id` | PATCH | Order 级字段变更 | 父组件 OrderManager(收集 onChange 后批量提交) |
| `/v1/orders/:id/lines/:lid` | PATCH | OrderLine 级字段变更 | 父组件 OrderManager |
| `/v1/relations` | POST | 创建新 Relation(FK 字段) | 父组件 onCreateRelation 实现 |

---

## §12 权限与可见性

| 角色 | 可见 OrderClusterBlock | 可编辑字段 | 可见佣金字段 | 可创建新 Relation |
|---|---|---|---|---|
| Sales / SalesManager | ✅ | ✅ | ⚠️ 仅管理层 | ✅ |
| Finance / FinanceManager | ✅ | ✅ | ✅ | ✅ |
| Admin / SuperAdmin | ✅ | ✅ | ✅ | ✅ |
| Operations / Warehouse | ⚠️ 仅查看(部分 cluster) | ❌ | ❌ | ❌ |

> **铁律**:OrderClusterBlock 跟随父组件 OrderManager 渲染门禁。字段级权限(如佣金字段仅管理层可见)由 OrderFieldInput 内部按 FieldMeta.scope 控制;cluster 级权限由父组件控制是否渲染该 cluster。

---

## §13 设计系统约束(BDS)

- **主容器**:`SidePanelContainer as="section" materialRole="raisedCard" spotlight edgeFadeItem` + `spec.panelClass` / `spec.panelContentClass`
- **子组容器**:`SidePanelContainer as="section" materialRole="insetSurface" materialTone="nested" shadowMode="ghost"` + `spec.insetPadding`
- **分区头**:`OrderSectionHeader iconKey={cluster.id}`(统一唯一渲染器)
- **子组头**:小圆点(`h-1 w-1 rounded-full ${spec.subGroupDot}`)+ `spec.subGroupTitle`(仅中文,去 EN)
- **网格**:`spec.gridEdit`(编辑态紧凑)/ `spec.gridRead`(只读态松弛)/ `'grid grid-cols-1 md:grid-cols-2 gap-3'`(compact 移动端)
- **圆角**:由 SidePanelContainer 材质驱动(raisedCard / insetSurface),禁止硬编码
- **颜色**:全部走 `spec.*` 配方(由 orderUiSpec 求值),禁止硬编码
- **字重**:font-light(300,子组标题)/ font-extralight(200,字段标签)
- **间距**:mb-4(分区头与内容)/ space-y-4(子组间距)/ gap-3(字段网格)
- **防回退**:`scripts/check-design-tokens.sh` 扫描硬编码;配方必须从 orderUiSpec 取

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-OCB1 | **无折叠/展开功能**(由父组件控制) | 调用方需自行实现折叠,可能不一致 | P3(设计意图,非缺口) |
| GAP-OCB2 | 无字段级加载态(仅 OrderFieldInput 内部 disabled) | 批量保存时用户无全局反馈 | P3 |
| GAP-OCB3 | subGroup 无「全部折叠/展开」批量操作 | 子组多时逐个折叠繁琐 | P3 |
| GAP-OCB4 | 无字段排序拖拽(字段顺序由 orderSchema 字典固定) | 用户无法自定义字段顺序 | P3(设计意图,非缺口) |
| GAP-OCB5 | fieldSources 来源标记无「批量改为 manual」入口 | 导入后逐字段改来源繁琐 | P3 |
| GAP-OCB6 | 无字段级权限提示(无权限字段仅 disabled,无 tooltip 说明) | 用户不知道为何不能编辑 | P3 |

---

## §15 相关文档索引

- [../00-索引.md](../00-索引.md) — 设计文档真源总索引
- [../04-模块设计/03-订单与生产/Orders-订单管理/订单录入表单.md](../04-模块设计/03-订单与生产/Orders-订单管理/订单录入表单.md) — 订单字段字典 + cluster 结构
- [../04-模块设计/03-订单与生产/Orders-订单管理/订单详情页.md](../04-模块设计/03-订单与生产/Orders-订单管理/订单详情页.md) — 订单详情页分区结构
- [OrderSectionHeader.md](./OrderSectionHeader.md) — 分区头(直接消费)
- [RelationCombobox.md](./RelationCombobox.md) — FK 字段 combobox(via OrderFieldInput)
- [OrderLinesTable.md](./OrderLinesTable.md) — 订单行表格(与 cluster 并列)
- [OrderLinesGrid.md](./OrderLinesGrid.md) — 尺码网格(via OrderLineFieldRenderer)
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板容器(直接消费)
- [BDS组件族7规格.md](./BDS组件族7规格.md) — orderUiSpec 配方规格
- [../01-产品总览/6. 角色与权限矩阵.md](../01-产品总览/6.%20角色与权限矩阵.md) — orders:read / orders:write scope

---

## §16 补充说明

1. **字典驱动渲染铁律**:OrderClusterBlock 根据 `OrderClusterMeta` + `FieldMeta[]` 从 orderSchema 字典渲染——字段顺序、类型、标签、FK 目标全部由字典定义,组件不硬编码任何字段。这是订单域可扩展性地基(新增字段只需改字典,无需改组件)
2. **字段分发依据 FieldMeta.level**:`'line'` 走 OrderLineFieldRenderer(成衣生产跟单等行级字段),其他走 OrderFieldInput(Order 级字段)。这避免了 Order 与 OrderLine 字段混渲染的混乱
3. **subGroup 分组渲染**:parties cluster 含客户/工厂/收货人/账单方等多个子组——通过 `FieldMeta.subGroup` 分组,每组渲染为 insetSurface nested 子卡。子组头仅中文(去 EN,避免与字段标签的 EN kicker 重复)
4. **density 三档密度**:compact(移动端录入 BottomSheet)/ gridRead(查阅态松弛)/ gridEdit(编辑态紧凑)。compact 与桌面详情不共享密度——移动端单列/双列,桌面详情多列
5. **fieldSources 来源标记**:每个字段可携带来源标记(pdf/manual/imported-then-edited),由 OrderFieldInput 在字段标签旁展示来源 chip。这帮助用户识别哪些字段是导入的、哪些是手工录入的
6. **onRelationSelected 自动填充**:选客户后自动填充地址/付款条款/信用额度等——减少手工录入。这是产品意图,但用户可后续手动修改填充值
7. **无折叠态设计意图**:OrderClusterBlock 本身无折叠/展开功能——由父组件 OrderManager 控制 cluster 显隐。这是职责分离:OrderClusterBlock 仅负责字段渲染,父组件负责 cluster 折叠交互
