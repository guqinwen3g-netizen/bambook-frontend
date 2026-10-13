# CmdK 命令面板组件规格 · 全局工作台搜索与跳转

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `CommandPalette`（文档归档名 `CmdK-命令面板`） |
| 定位 | D1 全局工作台体验——Cmd/Ctrl+K 唤起的命令面板，提供两类能力：① 全局数据搜索（客户/订单/产品/发票/发货/知识/邮件 7 类业务实体，复用 App 层已加载 state 客户端过滤，零新增端点，离线可用，每类最多 5 条）；② 快捷指令（全部主导航视图跳转，权限过滤）；③ 跨模块跳转合约（订单记录直开详情，其余记录跳转到所属模块视图） |
| 文件路径 | `components/CommandPalette.tsx`（354 行）+ 测试 `CommandPalette.test.tsx` |
| 消费方 | `App.tsx`（第 1458 行挂载；第 779-789 行注册 Cmd/Ctrl+K 全局快捷键） |
| 范式 | 受控模态浮层——`open` prop 驱动挂载；内部维护 `query` / `activeIndex` 两个 state；ESC / 遮罩点击 / 执行后自动关闭 |
| 优先级 | P1（D1 全局工作台核心入口，跨模块跳转主干） |
| 实现状态 | ✅ 已落地（7 域搜索 + 视图跳转 + 订单直达详情 + 键盘导航 + 权限过滤 + 软删排除 + 测试覆盖）；⚠️ 客户端过滤依赖 App 层已加载数据，未加载的模块不参与搜索 |
| PRD 关联 | PRD §2.4（全局工作台 Cmd+K）/ §8.1（视图权限矩阵）/ §8.7（跨模块跳转合约） |
| 代码关联 | [CommandPalette.tsx](../../components/CommandPalette.tsx) / [App.tsx](../../App.tsx)（消费方，第 1458 行 + 第 779 行快捷键）/ [moduleRegistry.ts](../../components/moduleRegistry.ts) `getPrimaryNavigationModules` / [authService.ts](../../services/authService.ts) `canAccessView` / `hasRole` / [RDLPrimitives.tsx](../../components/ui/RDLPrimitives.tsx) `RdlSurface` / [types.ts](../../types.ts) `View` / `Relation` / `Order` 等 |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架（Props 接口 + 渲染结构）

```ts
/** 面板结果项（扁平化，键盘导航用） */
type PaletteItem =
  | { kind: 'view'; key: string; view: View; label: string; icon: LucideIcon }
  | { kind: 'record'; key: string; domain: RecordDomain; id: string; title: string; subtitle: string; icon: LucideIcon; order?: Order };

/** 数据域中文标签（分组标题 + 记录副标题） */
type RecordDomain = '客户' | '订单' | '产品' | '发票' | '发货' | '知识' | '邮件';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  isDarkMode?: boolean;
  /** 7 类业务实体数据（App 层 state 快照） */
  relations: Relation[];
  orders: Order[];
  products: ProductAsset[];
  invoices: Invoice[];
  shipments: Shipment[];
  knowledge: KnowledgeItem[];
  emails: Email[];
  /** 视图跳转回调 */
  onNavigate: (view: View) => void;
  /** 订单记录直开详情（App 受控 selectedOrder） */
  onOpenOrder: (order: Order) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open, onClose, isDarkMode = false,
  relations, orders, products, invoices, shipments, knowledge, emails,
  onNavigate, onOpenOrder,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 打开时重置并聚焦
  useEffect(() => { /* §5.1 */ }, [open]);

  // 视图指令（权限过滤）
  const viewItems = useMemo<PaletteItem[]>(() => { /* §5.2 */ }, [query]);

  // 数据记录搜索（纯函数 buildRecordGroups）
  const recordGroups = useMemo(
    () => buildRecordGroups(query, { relations, orders, products, invoices, shipments, knowledge, emails }),
    [query, relations, orders, products, invoices, shipments, knowledge, emails],
  );

  // 扁平化结果（键盘导航索引）
  const flatItems = useMemo<PaletteItem[]>(() => {
    const records = recordGroups.flatMap(g => g.items);
    return [...records, ...viewItems];
  }, [recordGroups, viewItems]);

  if (!open) return null;

  const execute = (item: PaletteItem) => { /* §5.4 */ };
  const handleKeyDown = (e: React.KeyboardEvent) => { /* §5.3 */ };

  return (
    <div className="overlay" onClick={onClose}>
      <RdlSurface tone="panel" onClick={stopPropagation}>
        <SearchInput />         {/* §6.1 */}
        <ResultList />          {/* §6.2 */}
        <FooterHints />         {/* §6.3 */}
      </RdlSurface>
    </div>
  );
};
```

### 渲染结构

```
<div className="fixed inset-0 z-[90] bg-slate-950/20 backdrop-blur-sm flex items-start justify-center pt-[16vh] px-6"
     onClick={onClose} role="dialog" aria-label="全局搜索">  ← 遮罩层
  <RdlSurface tone="panel" className="w-full max-w-xl max-h-[60vh] flex flex-col" onClick={stopPropagation}>  ← 面板
    ├─ <div className="px-5 py-4 border-b">  ← 搜索输入区
    │   ├─ <Search size={17}>  ← 搜索图标
    │   ├─ <input ref={inputRef} placeholder="搜索客户、订单、产品、发票、知识、邮件，或前往模块…"
    │   │        onKeyDown={handleKeyDown} className="flex-1 bg-transparent outline-none text-[15px] font-light" />
    │   └─ <kbd>ESC</kbd>  ← ESC 键提示
    ├─ <div ref={listRef} className="flex-1 overflow-y-auto py-2">  ← 结果列表
    │   ├─ {flatItems.length === 0 && <空态文案>}  ← "未找到「{query}」相关结果"
    │   ├─ {recordGroups.map(group => (
    │   │     <div>
    │   │       <div className="px-5 pt-2 pb-1 text-[10px] uppercase tracking-widest">{group.domain}</div>  ← 分组标题
    │   │       {group.items.map(renderItem)}  ← 记录项
    │   │     </div>
    │   │   ))}
    │   └─ {viewItems.length > 0 && <div>模块分组 + 视图项</div>}
    └─ <div className="px-5 py-2.5 border-t">  ← 底部快捷键提示
        ├─ ↑↓ 导航
        ├─ ⏎ 打开
        └─ → 订单记录直达详情
  </RdlSurface>
</div>
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `open` | `boolean` | 是 | — | 是否打开；false 时组件返回 null |
| `onClose` | `() => void` | 是 | — | 关闭回调；触发场景：ESC / 遮罩点击 / 执行后自动调用 |
| `isDarkMode` | `boolean` | 否 | `false` | 深色模式标志（当前未直接使用，RdlSurface 内部通过 CSS 变量自适应） |
| `relations` | `Relation[]` | 是 | — | 客户/供应商/伙伴数据，App 层 state 快照 |
| `orders` | `Order[]` | 是 | — | 订单数据，App 层 state 快照 |
| `products` | `ProductAsset[]` | 是 | — | 产品数据，App 层 state 快照 |
| `invoices` | `Invoice[]` | 是 | — | 发票数据，App 层 state 快照 |
| `shipments` | `Shipment[]` | 是 | — | 发货数据，App 层 state 快照 |
| `knowledge` | `KnowledgeItem[]` | 是 | — | 知识库数据，App 层 state 快照 |
| `emails` | `Email[]` | 是 | — | 邮件数据，App 层 state 快照 |
| `onNavigate` | `(view: View) => void` | 是 | — | 视图跳转回调；执行 view item 或非订单 record item 时触发 |
| `onOpenOrder` | `(order: Order) => void` | 是 | — | 订单直开详情回调；执行订单 record item 时触发（App 受控 `selectedOrder`） |

**渲染门禁**：`!open` 时返回 null，不渲染任何 DOM。

**数据所有权**：组件不持有业务数据，所有数据通过 props 流入；仅维护 `query` 与 `activeIndex` 两个 UI state。

---

## §4 内部常量与辅助

### §4.1 数据域配置

```ts
type RecordDomain = '客户' | '订单' | '产品' | '发票' | '发货' | '知识' | '邮件';

const DOMAIN_ORDER: RecordDomain[] = ['客户', '订单', '产品', '发票', '发货', '知识', '邮件'];
const DOMAIN_LIMIT = 5;          // 每域最多展示条数
const VIEW_LIMIT_IDLE = 12;      // 空查询时最多展示视图指令数
```

- 7 个数据域按固定顺序展示，保证视觉稳定
- 每域最多 5 条，防止大列表淹没面板
- 空查询时仅展示视图指令（最多 12 个），不展示数据记录

### §4.2 文本规范化与匹配

```ts
const norm = (s: string) => s.toLowerCase().trim();

function matches(query: string, ...fields: Array<string | undefined | null>): boolean {
  const q = norm(query);
  if (!q) return true;
  return fields.some(f => f && norm(String(f)).includes(q));
}
```

- 大小写不敏感（`toLowerCase`）
- 首尾空白忽略（`trim`）
- 子串匹配（`includes`）——非模糊搜索，无编辑距离
- 空查询匹配所有字段（`return true`）

### §4.3 域 → 视图跳转映射

```ts
const target: Record<RecordDomain, View> = {
  客户: View.Relations,
  订单: View.Orders,
  产品: View.Products,
  发票: View.Invoices,
  发货: View.Shipments,
  知识: View.DataCenter,
  邮件: View.Emails,
};
```

- 非订单记录跳转到所属模块视图（视图内可继续模块级搜索）
- 订单记录特殊处理：直开详情（`onOpenOrder`）

---

## §5 内部逻辑

### §5.1 打开时重置并聚焦

```ts
useEffect(() => {
  if (open) {
    setQuery('');
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }
}, [open]);
```

- 每次打开都重置 query 与 activeIndex——保证干净状态
- `requestAnimationFrame` 等一帧确保 DOM 渲染完成再聚焦——避免 focus 失效

### §5.2 视图指令构建（权限过滤）

```ts
const viewItems = useMemo<PaletteItem[]>(() => {
  const modules = getPrimaryNavigationModules({ isAdmin: hasRole('owner', 'admin'), canAccessView });
  return modules
    .filter(m => matches(query, m.productLabel, m.internalName, m.id))
    .slice(0, norm(query) ? modules.length : VIEW_LIMIT_IDLE)
    .map(m => ({
      kind: 'view' as const,
      key: `view:${m.view}`,
      view: m.view,
      label: m.productLabel,
      icon: m.icon,
    }));
}, [query]);
```

- 从 `moduleRegistry` 取主导航模块，与侧边栏同口径
- `hasRole('owner', 'admin')` + `canAccessView` 双重权限过滤
- 空查询时仅展示 12 个视图指令；有查询时全部匹配的视图都展示

### §5.3 键盘导航

```ts
const handleKeyDown = (e: React.KeyboardEvent) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActiveIndex(i => Math.min(i + 1, flatItems.length - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActiveIndex(i => Math.max(i - 1, 0));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const item = flatItems[activeIndex];
    if (item) execute(item);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    onClose();
  }
};
```

- ↑↓ 跨分组扁平索引导航（不分组的全局索引）
- Enter 执行当前高亮项
- ESC 关闭
- 所有键都 `preventDefault`——避免触发其他快捷键

### §5.4 execute（执行项）

```ts
const execute = (item: PaletteItem) => {
  if (item.kind === 'view') {
    onNavigate(item.view);
  } else if (item.kind === 'record' && item.domain === '订单' && item.order) {
    onOpenOrder(item.order);   // 订单直开详情
  } else if (item.kind === 'record') {
    onNavigate(target[item.domain]);   // 其余记录跳转到所属模块视图
  }
  onClose();   // 执行后自动关闭
};
```

- view item → `onNavigate(view)`
- 订单 record item → `onOpenOrder(order)`（App 受控 selectedOrder）
- 其他 record item → `onNavigate(target[domain])`
- 所有执行后都调用 `onClose()`——单次交互模式

### §5.5 高亮项滚动可见

```ts
useEffect(() => {
  const el = listRef.current?.querySelector(`[data-palette-index="${activeIndex}"]`);
  el?.scrollIntoView({ block: 'nearest' });
}, [activeIndex]);
```

- activeIndex 变化时，自动滚动到高亮项
- `block: 'nearest'` 最小滚动量——避免剧烈跳动

### §5.6 查询变化重置高亮

```ts
useEffect(() => { setActiveIndex(0); }, [query]);
```

- 每次输入都重置高亮到第一项——避免高亮越界

### §5.7 buildRecordGroups（纯函数，可测）

```ts
export function buildRecordGroups(query: string, data: PaletteData): Array<{ domain: RecordDomain; items: PaletteItem[] }> {
  const q = norm(query);
  if (!q) return [];   // 空查询不返回数据记录
  const groups = [];
  const push = (domain, items) => {
    if (items.length > 0) groups.push({ domain, items: items.slice(0, DOMAIN_LIMIT) });
  };

  push('客户', data.relations
    .filter(r => !(r as any).deletedAt && matches(q, r.name, r.contactInfo, r.role))
    .map(r => ({ kind: 'record', domain: '客户', id: r.id, key: `relation:${r.id}`,
                 title: r.name, subtitle: r.contactInfo || '...', icon: Users })));

  push('订单', data.orders
    .filter(o => !(o as any).deletedAt && matches(q, o.poNumber, o.customer, o.product, o.id))
    .map(o => ({ kind: 'record', domain: '订单', id: o.id, key: `order:${o.id}`,
                 title: o.poNumber || o.id, subtitle: `${o.customer} · ${o.product}`,
                 icon: ShoppingBag, order: o })));

  // ... 产品/发票/发货/知识/邮件 同理

  return groups;
}
```

- 纯函数，导出供单元测试
- 软删记录排除（`!(r as any).deletedAt`）
- 每域最多 `DOMAIN_LIMIT=5` 条
- 订单记录携带 `order` 引用供直开详情
- 空查询返回空数组（空查询只展示视图指令）

---

## §6 渲染规则

### §6.1 搜索输入区

```
<div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border-c-subtle)]">
  <Search size={17} strokeWidth={1.5} className="text-[var(--text-tertiary)]" />
  <input placeholder="搜索客户、订单、产品、发票、知识、邮件，或前往模块…"
         className="flex-1 bg-transparent outline-none text-[15px] font-light
                    placeholder:font-light placeholder:text-[var(--text-tertiary)]" />
  <kbd className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--active-darken)]">ESC</kbd>
</div>
```

- `text-[15px]` 比常规 `text-sm` 略大——搜索输入是核心交互，视觉权重最高
- `placeholder:font-light` 保持占位文字也轻量
- 右侧 `<kbd>ESC</kbd>` 提示关闭方式

### §6.2 结果列表

- 分组标题：`px-5 pt-2 pb-1 text-[10px] font-light uppercase tracking-widest text-tertiary`
- 记录项：
  ```
  <button className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors {isActive ? activeClass : ''}">
    <Icon size={15} strokeWidth={1.5} />  ← 域图标
    <span className="flex-1 min-w-0">
      <span className="block truncate text-[13px] font-light text-primary">{title}</span>
      <span className="block truncate text-[11px] font-light text-tertiary">{subtitle}</span>
    </span>
    {kind === 'view' && <span>前往</span>}  ← 视图指令的"前往"标签
    {isActive && <CornerDownLeft size={13} />}  ← 高亮项的 Enter 提示
  </button>
  ```
- 高亮态：`bg-[var(--active-darken)]`
- hover 态：`onMouseEnter={() => setActiveIndex(idx)}`——鼠标与键盘同步

### §6.3 底部快捷键提示

```
<div className="flex items-center gap-4 px-5 py-2.5 border-t text-[10px] font-light text-tertiary">
  <span>↑↓ 导航</span>
  <span><CornerDownLeft size={10} /> 打开</span>
  <span className="flex-1" />
  <span><ArrowRight size={10} /> 订单记录直达详情</span>
</div>
```

- 左侧：导航与打开快捷键
- 右侧：订单直达详情的特殊合约提示

---

## §7 四态规范

### §7.1 空态（empty）

- **空查询**：仅展示视图指令（"模块"分组），不展示数据记录
- **无结果**：`flatItems.length === 0` 时展示 `未找到「{query}」相关结果`（`px-5 py-10 text-center text-[13px] font-light text-tertiary`）

### §7.2 加载态（loading）

- **不适用**：客户端过滤，无异步操作；数据由 App 层预加载，面板打开时已是就绪状态
- **未来扩展**：若接入服务端搜索，需在输入区右侧展示 Loader2 旋转图标

### §7.3 错误态（error）

- **不适用**：纯客户端过滤，无错误场景
- **数据缺失兜底**：某域数据未加载时，该域返回空数组（不展示分组），不影响其他域

### §7.4 交互态（interactive）

| 交互 | 触发 | 反馈 |
|---|---|---|
| 输入查询 | input `onChange` | `setQuery` → 重新计算 `recordGroups` + `viewItems` → 重置 `activeIndex` |
| ↓ 键 | `handleKeyDown` ArrowDown | `activeIndex` +1（上限 `flatItems.length - 1`） |
| ↑ 键 | `handleKeyDown` ArrowUp | `activeIndex` -1（下限 0） |
| Enter | `handleKeyDown` Enter | `execute(flatItems[activeIndex])` → 关闭 |
| ESC | `handleKeyDown` Escape / 全局快捷键 | `onClose` |
| 鼠标 hover | `onMouseEnter` | `setActiveIndex(idx)`——与键盘同步 |
| 点击项 | `onClick` | `execute(item)` → 关闭 |
| 点击遮罩 | 遮罩 `onClick` | `onClose` |
| Cmd/Ctrl+K | 全局 `keydown` | `setPaletteOpen(current => !current)`——切换打开/关闭 |

---

## §8 联动

### §8.1 上游：App.tsx（全局宿主）

- 快捷键注册：`App.tsx` 第 779-789 行，`Cmd/Ctrl+K` → `setPaletteOpen(toggle)`
- 数据流入：App 层 7 类业务实体 state（`relations` / `orders` / `products` / `invoices` / `shipments` / `knowledge` / `emails`）→ 本组件 props
- 回写链路：
  - `onNavigate(view)` → `setPaletteOpen(false)` + `handleViewChange(view)`
  - `onOpenOrder(order)` → `setPaletteOpen(false)` + `setSelectedOrder(order)` + `handleViewChange(View.Orders)`

### §8.2 同级：moduleRegistry（视图权限过滤）

- `getPrimaryNavigationModules({ isAdmin, canAccessView })` 返回当前用户可访问的主导航模块
- 与侧边栏同口径——保证命令面板与侧边栏展示的视图一致

### §8.3 同级：authService（角色判断）

- `hasRole('owner', 'admin')` 判断是否为管理员
- `canAccessView` 判断当前用户是否可访问某视图

### §8.4 下游：各业务模块视图

- 订单记录 → `View.Orders` + `selectedOrder`（订单详情页直开）
- 客户记录 → `View.Relations`
- 产品记录 → `View.Products`
- 发票记录 → `View.Invoices`
- 发货记录 → `View.Shipments`
- 知识记录 → `View.DataCenter`
- 邮件记录 → `View.Emails`

### §8.5 横向：Sidebar（侧边栏）

- 视图指令与侧边栏主导航同源（`getPrimaryNavigationModules`）
- 命令面板是侧边栏的"搜索版"——支持模糊查找视图

---

## §9 状态机

### §9.1 主状态机

```
[closed] --Cmd/Ctrl+K--> [open]
[open] --ESC / 遮罩点击 / 执行项 / Cmd/Ctrl+K--> [closed]
```

### §9.2 内部交互状态机

```
[open, query='']
  ├─ viewItems 展示 12 个视图指令
  ├─ recordGroups 为空
  └─ activeIndex=0 高亮第一个视图指令

[open, query='xxx']
  ├─ viewItems 按 query 过滤
  ├─ recordGroups 按 query 过滤 7 域数据
  ├─ flatItems = [...records, ...viewItems]
  └─ activeIndex=0 高亮第一个记录（若有）

键盘导航：
  [activeIndex=N] --↓--> [activeIndex=N+1]（上限 flatItems.length-1）
  [activeIndex=N] --↑--> [activeIndex=N-1]（下限 0）
  [activeIndex=N] --Enter--> execute(flatItems[N]) → [closed]

鼠标交互：
  [hover item idx] --> setActiveIndex(idx) → 同步键盘高亮
  [click item] --> execute(item) → [closed]
```

---

## §10 数据模型

### §10.1 PaletteItem（联合类型）

```ts
type PaletteItem =
  | { kind: 'view'; key: string; view: View; label: string; icon: LucideIcon }
  | { kind: 'record'; key: string; domain: RecordDomain; id: string;
      title: string; subtitle: string; icon: LucideIcon; order?: Order };
```

- `kind: 'view'`：视图指令，执行时调用 `onNavigate(view)`
- `kind: 'record'`：数据记录，执行时根据 domain 决定调用 `onOpenOrder`（订单）还是 `onNavigate`（其他）
- `order?: Order`：仅订单记录携带，供直开详情

### §10.2 PaletteData（数据快照）

```ts
export interface PaletteData {
  relations: Relation[];
  orders: Order[];
  products: ProductAsset[];
  invoices: Invoice[];
  shipments: Shipment[];
  knowledge: KnowledgeItem[];
  emails: Email[];
}
```

- 7 类业务实体的数组，由 App 层 state 流入
- `buildRecordGroups` 纯函数消费此结构

### §10.3 7 域字段映射

| 域 | 类型 | 搜索字段 | 图标 | 跳转目标 |
|---|---|---|---|---|
| 客户 | `Relation` | `name` / `contactInfo` / `role` | `Users` | `View.Relations` |
| 订单 | `Order` | `poNumber` / `customer` / `product` / `id` | `ShoppingBag` | `onOpenOrder(order)` |
| 产品 | `ProductAsset` | `name` / `sku` | `Package` | `View.Products` |
| 发票 | `Invoice` | `invoiceNumber` / `customerName` | `Receipt` | `View.Invoices` |
| 发货 | `Shipment` | `shipmentNumber` | `Ship` | `View.Shipments` |
| 知识 | `KnowledgeItem` | `title` / `content` | `BookOpen` | `View.DataCenter` |
| 邮件 | `Email` | `subject` / `sender` | `Mail` | `View.Emails` |

---

## §11 API

本组件不直接调用 API。数据来源是 App 层预加载的 state：

```
App.tsx 拉取各业务模块数据（relations/orders/products/...）
  ↓ setState
App.tsx 渲染 <CommandPalette relations={relations} orders={orders} ... />
  ↓ 客户端过滤
buildRecordGroups(query, data)
  ↓ 返回分组结果
面板渲染
```

**零新增端点**：复用 App 层已加载 state，不增加后端负担；离线可用（fallback 模式下仍可搜索已加载数据）。

---

## §12 权限

### §12.1 视图权限

- 视图指令通过 `canAccessView` 过滤——与侧边栏同口径
- 管理员（`hasRole('owner', 'admin')`）可见所有视图
- 非管理员仅可见有权限的视图

### §12.2 数据权限

- **当前未实现**：数据记录不做行级权限过滤——所有加载到 App 层的数据都可被搜索
- **风险**：若 App 层加载了超出当前用户权限的数据（如销售看到其他销售的客户），命令面板会暴露
- **推荐方案**：App 层数据拉取时应做行级权限过滤，命令面板仅搜索已加载的数据（不额外做权限校验）

### §12.3 软删排除

- 所有域都过滤 `!(item as any).deletedAt`——软删记录不参与搜索
- 邮件域除外（`Email` 类型无 `deletedAt` 字段）

---

## §13 BDS 设计系统对齐

### §13.1 三层治理

| 层 | 文件 | 本组件消费点 |
|---|---|---|
| 宪法 | `styles/os-vnext.css` | `--text-primary` / `--text-tertiary` / `--border-c-subtle` / `--active-darken` |
| 契约 | `styles/flat-experimental.css` | flat 四特征——无阴影（RdlSurface 无 box-shadow）、无 rim（border 极淡）、大圆角（RdlSurface tone="panel"）、半透明膜色（`bg-slate-950/20 backdrop-blur-sm` 遮罩） |
| 基线 | `tailwind.config.js` + `check-design-tokens.sh` | 无硬编码颜色/圆角/阴影 |

### §13.2 配方来源

| 配方 | 来源 | 用途 |
|---|---|---|
| `RdlSurface tone="panel"` | `RDLPrimitives.tsx` | 面板容器（flat 玻璃表面） |
| `text-[var(--text-primary)]` / `-tertiary` | CSS 变量 | 文字两层级（标题/弱化） |
| `border-[var(--border-c-subtle)]` | CSS 变量 | 边框（输入区/底部/分组间） |
| `bg-[var(--active-darken)]` | CSS 变量 | 高亮态背景 + `<kbd>` 底色 |
| `bg-slate-950/20 backdrop-blur-sm` | Tailwind 任意值 | 遮罩层（半透明 + 模糊） |
| `animate-in fade-in duration-200` / `zoom-in duration-200` | Tailwind 动画 | 入场动效（遮罩淡入 + 面板缩放） |

### §13.3 设计纪律

- ❌ 禁止硬编码颜色——所有颜色走 CSS 变量 `var(--*)`
- ❌ 禁止 `box-shadow`——flat 设计无阴影
- ❌ 禁止 `rounded-[Npx]`——RdlSurface 内部处理圆角
- ✅ 字重仅 `font-light`（300）——所有文字统一 `font-light`
- ✅ 入场动效用 Tailwind `animate-in` 插件（`fade-in` + `zoom-in`），与全局动效一致
- ✅ 遮罩 `bg-slate-950/20` 比 ImportWizard 的 `bg-black/70` 更淡——命令面板是轻量级浮层，不需要强遮罩

### §13.4 视觉特征

- **遮罩**：`bg-slate-950/20 backdrop-blur-sm`——极淡半透明 + 背景模糊
- **面板**：`max-w-xl max-h-[60vh]` + `pt-[16vh]` 顶部偏上定位——与 macOS Spotlight 一致
- **入场动效**：遮罩 `fade-in` + 面板 `zoom-in`，各 200ms
- **搜索输入**：`text-[15px]` 略大字号 + `placeholder:font-light` 轻量占位
- **结果项**：图标 + 标题 + 副标题三列布局；高亮态 `bg-active-darken` + 右侧 CornerDownLeft 提示
- **底部提示**：快捷键说明 + 订单直达详情合约提示

---

## §14 缺口与后续

### §14.1 已知缺口

| ID | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-1 | 仅客户端过滤，无法搜索未加载数据 | App 层未加载的模块数据不可搜索（如分页加载的订单） | P2 |
| GAP-2 | 无模糊搜索 | 子串匹配，无法处理拼写错误或中文分词 | P3 |
| GAP-3 | 无搜索历史 | 无法快速重复搜索 | P3 |
| GAP-4 | 无快捷指令（如"新建订单"） | 仅支持跳转视图，不支持触发操作 | P2 |
| GAP-5 | 非订单记录无直达详情 | 客户/产品等记录仅跳转到模块视图，不直开详情 | P2 |
| GAP-6 | 无键盘快捷键提示 | 底部仅提示 ↑↓/Enter/ESC，未提示 Cmd+K 唤起 | P3 |
| GAP-7 | `isDarkMode` prop 未使用 | 深色模式靠 CSS 变量自适应，prop 冗余 | P3 |

### §14.2 推荐扩展方向

1. **服务端搜索**：当客户端数据不足时，回退到服务端搜索（`GET /api/search?q=xxx`），展示 Loader2 旋转图标
2. **模糊搜索**：引入 Fuse.js 或类似库，支持编辑距离匹配
3. **快捷指令**：增加 `kind: 'action'` 类型，支持"新建订单"/"导入订单"/"导出报表"等操作
4. **直达详情扩展**：所有记录都支持直达详情（客户 → 客户详情面板，产品 → 产品详情面板）
5. **搜索历史**：localStorage 存储最近 5 条搜索，空查询时展示
6. **Cmd+K 提示**：底部增加"按 Cmd+K 随时唤起"提示

### §14.3 不推荐扩展

- ❌ 不在本组件内做数据加载——保持纯客户端过滤范式，数据由 App 层注入
- ❌ 不在本组件内做权限校验——视图权限由 `canAccessView` 过滤，数据权限由 App 层拉取时保证
- ❌ 不在本组件内做复杂布局——保持单列列表 + 分组标题的简洁结构

---

## §15 索引

### §15.1 交叉链接

- [PageHeader.md](./PageHeader.md) — 页面头部组件，命令面板是 PageHeader 之外的全局导航补充
- [DetailPanel.md](./DetailPanel.md) — 详情面板，订单记录直开详情的目标
- [ImportWizard.md](./ImportWizard.md) — 导入向导，未来可作为快捷指令接入
- [NotificationCenter-通知与审批中心.md](./NotificationCenter-通知与审批中心.md) — 通知中心，命令面板可快捷跳转到待办
- [BDS组件族7规格.md](./BDS组件族7规格.md) — x-overlay 浮层原语，命令面板的模态浮层配方源头
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板容器，RdlSurface 与之同源
- [OrderLinesTable.md](./OrderLinesTable.md) — 订单行表格，订单记录直开详情后展示

### §15.2 代码真源

- 实现：[components/CommandPalette.tsx](../../components/CommandPalette.tsx)
- 测试：[components/CommandPalette.test.tsx](../../components/CommandPalette.test.tsx)
- 消费方：[App.tsx](../../App.tsx)（第 1458 行挂载 + 第 779 行快捷键注册）
- 依赖：[components/moduleRegistry.ts](../../components/moduleRegistry.ts) `getPrimaryNavigationModules` / [services/authService.ts](../../services/authService.ts) `canAccessView` / `hasRole` / [components/ui/RDLPrimitives.tsx](../../components/ui/RDLPrimitives.tsx) `RdlSurface`
- 类型：[types.ts](../../types.ts) `View` / `Relation` / `Order` / `ProductAsset` / `Invoice` / `Shipment` / `KnowledgeItem` / `Email`

### §15.3 设计文档关联

- [01-产品总览/4. 设计系统规范.md](../01-产品总览/4.%20设计系统规范.md) — BDS 三层治理 + flat 四特征
- [01-产品总览/1. 产品架构.md](../01-产品总览/1.%20产品架构.md) — 全局工作台 D1 体验定位
