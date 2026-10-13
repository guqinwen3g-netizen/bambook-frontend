# RelationCombobox 组件规格 · 关联选择器+自动填充

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `RelationCombobox` |
| 定位 | Relations 表的可搜索 combobox——为订单客户/工厂/收货人/账单方等 FK 字段提供搜索+选择+自由录入+创建新档案能力。同时存储 Relation FK(用于 join)与 name 快照(避免重命名静默改写历史订单 party 名) |
| 文件路径 | `components/ui/RelationCombobox.tsx`(180 行) + `components/order/RelationCombobox.tsx`(订单域封装) |
| 消费方 | `OrderFieldInput.tsx`(订单 FK 字段)/ `OrderLineFieldRenderer.tsx`(订单行 FK 字段)/ `CrmManager.tsx`(客户搜索) |
| 范式 | 受控+回传型——`value` / `relationId` / `relations` 由父组件注入;`onChange` / `onCreateNew` 回传选择结果 |
| 优先级 | P1(订单 FK 字段核心交互) |
| 实现状态 | ✅ 已落地(模糊搜索 + category 过滤 + Internal 特殊处理 + 自由录入 + 创建新档案 + FK 关联提示 + click-outside 关闭 + inputClassName 覆盖);✅ 兜底输入框配方与全局胶囊字段同源(recessedField);⚠️ 无键盘导航(↑↓/Enter),仅鼠标选择 |
| PRD 关联 | PRD §6.1(客户 360° 关联)/ §7.2(订单 party 字段 FK + name 快照) |
| 代码关联 | [RelationCombobox.tsx](../../components/ui/RelationCombobox.tsx) / [order/RelationCombobox.tsx](../../components/order/RelationCombobox.tsx) / [OrderFieldInput.tsx](../../components/order/OrderFieldInput.tsx) / [bambookOsTokens.ts](../../components/ui/bambookOsTokens.ts) `BAMBOOK_OS.controls.recessedField` / [types.ts](../../types.ts) `Relation / RelationCategory` |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架(Props 接口 + 内部结构)

```ts
interface RelationComboboxProps {
  value: string;                            // 当前 name 快照
  relationId?: string;                      // 可选 FK 快照——锁定显示名到匹配 Relation
  relations: Relation[];                    // 候选列表(由父组件注入,已加载)
  filterCategories?: RelationCategory[];    // 按 category 过滤下拉
  isDarkMode?: boolean;
  placeholder?: string;
  required?: boolean;
  inputClassName?: string;                  // 覆盖输入框类(与 OrderFieldInput 胶囊同源)
  onChange: (next: { name: string; relationId?: string; relation?: Relation }) => void;
  onCreateNew?: (typedName: string) => Promise<{id, name} | null> | {id, name} | null;  // 创建新档案回调
}

const RelationCombobox: React.FC<RelationComboboxProps> = ({ value, relationId, relations, ... }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value || '');
  const wrapRef = useRef<HTMLDivElement>(null);

  // value 变化时同步 query
  useEffect(() => { setQuery(value || ''); }, [value]);

  // click-outside 关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const candidates = useMemo(() => { /* 模糊搜索 + category 过滤 */ }, [relations, filterCategories, query]);
  const exactMatch = candidates.find(r => r.name.toLowerCase() === query.trim().toLowerCase());
  const showCreateOption = !!onCreateNew && query.trim().length > 0 && !exactMatch;
  // ...
};
```

### 渲染结构

```
<div ref={wrapRef} className="relative">
  <div className="relative">
    <input value={query} onChange={...} onFocus={() => setOpen(true)}
      className={resolvedInputCls} placeholder={placeholder} required={required} />
    <button onClick={() => setOpen(o => !o)} aria-label="Toggle dropdown">
      <ChevronDown size={14} />
    </button>
  </div>
  {relationId && <div className="mt-1 flex items-center gap-1 text-[9px] text-tertiary">
    <Link2 size={10} /> 已关联关系档案
  </div>}
  {open && <div className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-card border bg-[var(--recessed-bg)]">
    {candidates.length === 0 && !showCreateOption && <空匹配提示>}
    {candidates.map(r => <button onClick={select(r)}>{r.name} <span>{r.category}</span></button>)}
    {showCreateOption && <button onClick={createNew}>+ 创建新档案 "{query}"</button>}
  </div>}
</div>
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `value` | `string` | 是 | — | 当前 name 快照;渲染到 input 的 value;父组件更新时通过 useEffect 同步到 query |
| `relationId` | `string` | 否 | — | 可选 FK 快照;设置时显示「已关联关系档案」提示(Link2 图标);不锁定输入但仍提示关联状态 |
| `relations` | `Relation[]` | 是 | — | 候选列表;由父组件注入(已加载的 Relations 数据);组件内不做 API 拉取 |
| `filterCategories` | `RelationCategory[]` | 否 | — | 按 category 过滤下拉;如订单客户字段传 `['Customer']`,工厂字段传 `['Supplier','Factory']` |
| `isDarkMode` | `boolean` | 否 | `false` | 主题标志(当前未直接消费,材质类由 recessedField 配方驱动) |
| `placeholder` | `string` | 否 | — | input placeholder |
| `required` | `boolean` | 否 | — | input required 属性 |
| `inputClassName` | `string` | 否 | — | 覆盖输入框类;OrderFieldInput 传胶囊字段配方使 combobox 与兄弟文本输入像素一致;省略时用 legacy standalone 样式 |
| `onChange` | `(next: {name, relationId?, relation?}) => void` | 是 | — | 选择/录入回传;自由录入时 `relationId=undefined`,选择候选时携带完整 Relation |
| `onCreateNew` | `(typedName) => Promise<{id,name}\|null> \| {id,name} \| null` | 否 | — | 创建新档案回调;提供时显示「+ 创建新档案」选项;父组件打开创建流程并回传新 Relation |

**回传时机**:
- 自由录入(input onChange):立即回传 `{name: e.target.value, relationId: undefined}`(清空 FK,因为不再确定匹配)
- 选择候选(button onClick):回传 `{name: r.name, relationId: r.id, relation: r}`(携带完整 Relation 供父组件自动填充)
- 创建新档案:回传 `{name: created.name, relationId: created.id, relation: undefined}`

---

## §4 模糊搜索 + category 过滤

### §4.1 candidates 计算逻辑

```ts
const candidates = useMemo(() => {
  const cats = filterCategories && filterCategories.length > 0 ? new Set(filterCategories) : null;
  const isInternal = cats?.has('Internal');
  const lower = query.trim().toLowerCase();
  return relations
    .filter((r) => !r.deletedAt)                                          // 排除软删
    .filter((r) => (isInternal ? true : r.isOrganization))                 // Internal 不过滤 isOrganization
    .filter((r) => (cats ? cats.has(r.category) : true))                   // category 过滤
    .filter((r) => (lower ? r.name.toLowerCase().includes(lower) : true))  // 模糊搜索
    .slice(0, 12);                                                          // 最多 12 条
}, [relations, filterCategories, query]);
```

**过滤规则**:
- 排除软删记录(`deletedAt` 非空)
- `Internal` category 特殊处理:不强制 `isOrganization`(内部联系人也可作为 party)
- category 过滤:仅在 `filterCategories` 非空时生效
- 模糊搜索:`name.toLowerCase().includes(query)`,大小写不敏感
- 最多 12 条候选(防大列表淹没下拉)

### §4.2 Internal 特殊处理

```ts
const isInternal = cats?.has('Internal');
// ...
.filter((r) => (isInternal ? true : r.isOrganization))
```

**意图**:`Internal`(内部联系人)category 不强制 `isOrganization`——内部联系人可能是个人(非组织),但仍可作为订单 party(如内部跟单员)。

### §4.3 exactMatch 与 showCreateOption

```ts
const exactMatch = candidates.find(r => r.name.toLowerCase() === query.trim().toLowerCase());
const showCreateOption = !!onCreateNew && query.trim().length > 0 && !exactMatch;
```

**创建选项显示条件**:
- `onCreateNew` 已提供(父组件支持创建)
- query 非空
- 无精确匹配(避免重复创建已有档案)

---

## §5 自由录入 + FK 清空纪律

### §5.1 自由录入回传

```ts
onChange={(e) => {
  setQuery(e.target.value);
  setOpen(true);
  // 自由录入立即回传 name 快照,FK 清空(不再确定匹配)
  onChange({ name: e.target.value, relationId: undefined });
}}
```

**纪律**:自由录入时 `relationId=undefined`——因为不再确定输入文本匹配哪个 Relation。父组件据此决定是否提示用户「该名称未关联档案,是否创建?」。

### §5.2 选择候选回传

```ts
onClick={() => {
  setQuery(r.name);
  setOpen(false);
  onChange({ name: r.name, relationId: r.id, relation: r });  // 携带完整 Relation
}}
```

**携带完整 Relation**:选择候选时回传完整 `relation` 对象——父组件可据此自动填充其他字段(如选客户后自动填充地址/付款条款/信用额度)。

### §5.3 FK + name 快照双存储

> 同时存储 Relation FK(用于 join/analytics)与 name 快照(避免重命名静默改写历史订单 party 名)。

**意图**:Relations 表的 name 可能被重命名,但历史订单的 party 名不应被静默改写——因此订单同时存储 `customerId`(FK)+ `customerName`(快照)。RelationCombobox 的 `onChange` 回传 `{name, relationId}` 正好对应这两个字段。

---

## §6 创建新档案(onCreateNew)

### §6.1 创建流程

```ts
onClick={async () => {
  const created = await onCreateNew!(query.trim());
  if (created) {
    setQuery(created.name);
    onChange({ name: created.name, relationId: created.id, relation: undefined });
  }
  setOpen(false);
}}
```

**流程**:
1. 用户输入名称,无精确匹配时显示「+ 创建新档案 "query"」
2. 用户点击 → 调用 `onCreateNew(query)`(父组件打开创建流程)
3. 父组件创建 Relation 后回传 `{id, name}`
4. combobox 设置 query 为新名称,回传 `{name, relationId: created.id, relation: undefined}`
5. 关闭下拉

### §6.2 父组件职责

`onCreateNew` 由父组件实现,典型逻辑:
- 打开 Relation 创建表单(弹窗/抽屉)
- 预填 name = typedName
- 用户补充其他字段后提交
- 返回 `{id, name}` 或 `null`(取消时)

**异步支持**:`onCreateNew` 返回 `Promise<{id,name}|null>`,支持异步创建(等待 API 响应)。

---

## §7 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 默认态 | `open=false` | input + ChevronDown 按钮 | placeholder |
| 下拉打开 | `open=true`(focus 或点击 ChevronDown) | input + 下拉面板(候选列表) | 候选 name + category |
| 有候选 | `candidates.length > 0` | 候选按钮列表(最多 12 条) | name + category 标签 |
| 无候选 | `candidates.length === 0 && !showCreateOption` | `<Search>` + 「无匹配的关系档案」 | 空匹配提示 |
| 可创建 | `showCreateOption === true` | 「+ 创建新档案 "query"」按钮(border-t 分隔) | 创建提示 |
| 已关联 FK | `relationId !== undefined` | input 下方「已关联关系档案」提示(Link2 图标) | 关联提示 |
| 无权限 | 父组件层控制 | 父组件不渲染 RelationCombobox | — |

---

## §8 联动(OrderFieldInput 自动填充)

### §8.1 与 OrderFieldInput 的联动

```
OrderFieldInput(field.fkTarget='customer')
  ↓
渲染 <RelationCombobox relations={...} filterCategories={['Customer']}
  inputClassName={胶囊字段配方} onCreateNew={(name) => openCreateRelation(name, 'customer')} />
  ↓
用户选择候选 → onChange({name, relationId, relation})
  ↓
OrderFieldInput 调用 onRelationSelected(fkField, relation)
  ↓
OrderClusterBlock.onRelationSelected → 父组件自动填充
  ↓
自动填充:billingAddress / shippingAddress / paymentTerms / currency / taxId / creditLimit
```

**自动填充意图**:选择客户后,父组件根据完整 Relation 对象自动填充订单的其他 party 字段(账单地址/发货地址/付款条款等),减少手工录入。

### §8.2 inputClassName 覆盖

```ts
const baseInputCls = BAMBOOK_OS.controls.recessedField.base;
const resolvedInputCls = inputClassName ?? `w-full pl-3 pr-9 py-3 border rounded-control outline-none text-xs font-light ${baseInputCls}`;
```

**纪律**:OrderFieldInput 传 `inputClassName` 使 combobox 输入框与兄弟文本输入像素一致(胶囊字段配方)。省略时用 legacy standalone 样式。这是组件复用与视觉一致的取舍。

---

## §9 状态机

```
init(open=false, query=value)
  ↓
  ├─ input focus / ChevronDown 点击 → open=true
  ├─ input onChange → query 更新 + open=true + onChange 回传(name, relationId=undefined)
  └─ 候选 button onClick → query=r.name + open=false + onChange 回传(name, relationId, relation)
       ↓
       ├─ click-outside → open=false
       ├─ ESC → (当前未实现)
       └─ 创建新档案 onClick → onCreateNew(query) → query=created.name + open=false + onChange 回传
```

| 状态 | 字段 | 行为 |
|---|---|---|
| `closed` | `open=false` | 仅显示 input |
| `open` | `open=true` | 显示下拉面板(候选 + 创建选项) |
| `selected` | 选择候选后 | query=name, relationId=r.id, open=false |
| `free-typed` | 自由录入后 | query=text, relationId=undefined, open=true(继续输入) |
| `created` | 创建新档案后 | query=created.name, relationId=created.id, open=false |

---

## §10 数据模型

```ts
interface Relation {
  id: string;
  name: string;
  type: string;              // Customer / Supplier / Partner / Internal
  category: RelationCategory;
  isOrganization: boolean;
  contactInfo?: string;
  // ... 其他字段(地址/财务/标签等)
  deletedAt?: string | null;
}

type RelationCategory = 'Customer' | 'Supplier' | 'Partner' | 'Internal' | ...;

// onChange 回传类型
interface RelationComboboxChange {
  name: string;              // name 快照(落库到订单 partyName 字段)
  relationId?: string;       // FK(落库到订单 customerId 等字段);自由录入时 undefined
  relation?: Relation;       // 完整 Relation 对象(供父组件自动填充);创建新档案时 undefined
}
```

---

## §11 API 端点清单

RelationCombobox 本身**不调用 API**——候选列表由父组件注入(`relations` prop)。创建新档案通过 `onCreateNew` 回调委托父组件。

| 关联端点 | 方法 | 用途 | 调用方 |
|---|---|---|---|
| `/v1/relations` | GET | 拉取候选列表 | 父组件(注入 `relations` prop) |
| `/v1/relations` | POST | 创建新档案 | 父组件 `onCreateNew` 实现 |

---

## §12 权限与可见性

| 角色 | 可见 RelationCombobox | 可选择候选 | 可创建新档案 |
|---|---|---|---|
| Sales / SalesManager | ✅ | ✅ | ✅ |
| Finance / FinanceManager | ✅ | ✅ | ✅ |
| Admin / SuperAdmin | ✅ | ✅ | ✅ |
| Operations / Warehouse | ❌(父组件层不渲染订单 FK 字段) | — | — |

> **铁律**:RelationCombobox 跟随父组件(OrderFieldInput)渲染门禁。创建新档案需 `relations:write` scope,由父组件 `onCreateNew` 实现层控制。

---

## §13 设计系统约束(BDS)

- **input**:`BAMBOOK_OS.controls.recessedField.base` 兜底配方;`inputClassName` 覆盖时与 OrderFieldInput 胶囊字段同源
- **ChevronDown 按钮**:`absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]`
- **FK 关联提示**:`mt-1 flex items-center gap-1 text-[9px] text-[var(--text-tertiary)]` + Link2 size=10
- **下拉面板**:`absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-card border bg-[var(--recessed-bg)] border-[var(--border-c-default)]`
- **候选按钮**:`w-full text-left px-3 py-2 text-[11px] flex items-center justify-between gap-3 hover:bg-[var(--hover-darken)] text-[var(--text-primary)]`
- **category 标签**:`shrink-0 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)]`
- **空匹配提示**:`px-3 py-3 text-[11px] flex items-center gap-2 text-[var(--text-tertiary)]` + Search size=12
- **创建选项**:`w-full text-left px-3 py-2 text-[11px] flex items-center gap-2 border-t border-[var(--border-c-subtle)] text-[var(--text-secondary)] hover:bg-[var(--hover-darken)]` + Plus size=12
- **圆角**:`rounded-control`(input)/ `rounded-card`(下拉面板)/ `rounded-full`(ChevronDown 按钮),禁止硬编码
- **颜色**:全部走 BDS 语义 token,禁止 hex 硬编码
- **防回退**:`scripts/check-design-tokens.sh` 扫描硬编码

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-RC1 | **无键盘导航**(↑↓ 选择 / Enter 确认 / ESC 关闭) | 用户必须鼠标点击,键盘流中断 | P2 |
| GAP-RC2 | 无高亮匹配文本(query 在 name 中的匹配片段不加粗) | 用户难以快速识别匹配点 | P3 |
| GAP-RC3 | 无候选数量提示(如「12 条匹配,显示前 12 条」) | 大量匹配时用户不知道是否被截断 | P3 |
| GAP-RC4 | 创建新档案无 category 预填(onCreateNew 仅传 name) | 父组件需自行推断 category,可能不准确 | P3 |
| GAP-RC5 | 无「最近选择」记忆 | 高频客户每次都需搜索 | P3 |
| GAP-RC6 | relationId 提示仅文字,无「点击查看档案」跳转 | 用户需手动跳转 Relations 模块查看 | P3 |

---

## §15 相关文档索引

- [../00-索引.md](../00-索引.md) — 设计文档真源总索引
- [../04-模块设计/02-客户与开拓/Relations-联系人.md](../04-模块设计/02-客户与开拓/Relations-联系人.md) — Relations 模块 + Relation 实体
- [../04-模块设计/03-订单与生产/Orders-订单管理/订单录入表单.md](../04-模块设计/03-订单与生产/Orders-订单管理/订单录入表单.md) — 订单 party 字段 FK + name 快照
- [OrderClusterBlock.md](./OrderClusterBlock.md) — 字段簇块(消费 RelationCombobox via OrderFieldInput)
- [OrderSectionHeader.md](./OrderSectionHeader.md) — 订单分区头(cluster 容器)
- [DetailPanel.md](./DetailPanel.md) — Relations 详情面板(创建新档案的入口)
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板容器(下拉面板材质)
- [BDS组件族7规格.md](./BDS组件族7规格.md) — recessedField 配方规格
- [../01-产品总览/6. 角色与权限矩阵.md](../01-产品总览/6.%20角色与权限矩阵.md) — relations:read / relations:write scope

---

## §16 补充说明

1. **FK + name 快照双存储铁律**:订单同时存储 `customerId`(FK,用于 join)与 `customerName`(快照,避免重命名静默改写历史)。RelationCombobox 的 `onChange` 回传 `{name, relationId}` 正好对应这两个字段——这是外贸业务铁律,历史订单的 party 名必须保持创建时的快照
2. **自由录入清空 FK 纪律**:自由录入时 `relationId=undefined`——因为不再确定输入文本匹配哪个 Relation。父组件据此决定是否提示用户「该名称未关联档案,是否创建?」。避免自由录入的文本被误认为已关联 FK
3. **Internal category 特殊处理**:`Internal`(内部联系人)category 不强制 `isOrganization`——内部联系人可能是个人(非组织),但仍可作为订单 party(如内部跟单员)。这是产品意图,避免 Internal 联系人被过滤掉
4. **最多 12 条候选**:candidates.slice(0, 12) 防大列表淹没下拉。用户需更精确搜索时,继续输入 query 缩小范围
5. **inputClassName 覆盖设计**:OrderFieldInput 传 `inputClassName` 使 combobox 输入框与兄弟文本输入像素一致(胶囊字段配方)。省略时用 legacy standalone 样式。这是组件复用与视觉一致的取舍——既支持独立使用,又支持嵌入订单字段网格
6. **onCreateNew 异步支持**:`onCreateNew` 返回 `Promise<{id,name}|null>`,支持异步创建(等待 API 响应)。父组件可打开创建表单,用户补充字段后提交,返回新 Relation。这是「combobox + 创建流」的标准联动模式
7. **无键盘导航(已知缺口)**:当前仅鼠标选择,无 ↑↓/Enter/ESC 键盘导航(GAP-RC1)。CommandPalette 已实现完整键盘导航,未来可复用其模式增强 RelationCombobox
