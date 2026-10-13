# RelatedEntitiesPanel 组件规格 · EntityLink 跨模块关联面板

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `RelatedEntitiesPanel` |
| 定位 | EntityLink 图谱邻居的通用「关联视图」面板——给定实体 `(type, id)`，自取图谱邻居并按 `linkKind` 分组渲染，每条邻居行可点击跳转。是订单/客户/产品/报价/出运/采购等所有详情页的跨模块关联出口 |
| 文件路径 | `components/RelatedEntitiesPanel.tsx`(189 行) |
| 消费方 | `OrderManager.tsx`(type=`order`)/ `DetailPanel.tsx`(type=`relation.organization`/`relation.contact`)/ `ShipmentManager.tsx` / `FinanceManager.tsx` / `CustomsManager.tsx` / `QuotationManager.tsx` / `CrmManager.tsx` / `ReportCenter.tsx` / `SuppliersManager.tsx` / `ProcurementManager.tsx` / `DevelopmentManager.tsx` |
| 范式 | 自取数据型——`(type, id)` 由父注入;内部 `useEffect` 并行拉取一个或多个 type code 的邻居并按 `linkKind` 合并;`onSelectNeighbor` 回调把导航决策权交还父组件 |
| 优先级 | P1(阶段 D / D1 主链路实体图谱收口) |
| 实现状态 | ✅ 已落地(多 type code 合并 + linkKind 分组 + 胶囊行点击跳转 + 4 态规范 + orderUiSpec 统一材质);⚠️ `onSelectNeighbor` 在多数消费方未传入(纯展示态),仅 `ReportCenter` 等场景接入了跨模块跳转 |
| PRD 关联 | PRD §19.4(实体关联图谱)/ §6.1(客户 360° 档案跨模块关联)/ §3.2(订单关联视图) |
| 代码关联 | [RelatedEntitiesPanel.tsx](../../components/RelatedEntitiesPanel.tsx) / [entityLinksService.ts](../../services/entityLinksService.ts) `getNeighbors / listLinks / LINK_KIND_LABELS / labelForLinkKind` / [apiService.ts](../../services/apiService.ts) `getAuthHeaders / buildApiUrl` / [SidePanelContainer.tsx](../../components/ui/SidePanelContainer.tsx) / [OrderSectionHeader.tsx](../../components/order/OrderSectionHeader.tsx) `iconKey="related"` / [orderUiSpec.ts](../../components/order/orderUiSpec.ts) `panelClass / rowPill / rowPillHover / rowPillSurface / emptyText / bannerDanger / kicker` |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架(Props 接口 + 内部结构)

```ts
export interface RelatedEntitiesPanelProps {
  /** EntityLink type code: e.g. "order", "development-case", "relation.organization", "product" */
  type: string;
  /** Entity id */
  id: string;
  /**
   * Additional type codes for the same entity (graph code aliasing).
   * 同一 Relation 行在图谱中可能挂多个 type code——
   * 联系人 owned 链接为 "relation.contact"，订单角色链接指向 "relation.person"。
   * 邻居按 linkKind 合并。
   */
  additionalTypes?: string[];
  /** Title override; defaults to "关联视图" */
  title?: string;
  /** Click handler — receives the neighbor row so the host can navigate. */
  onSelectNeighbor?: (n: NeighborRow) => void;
  /** Visual theme; defaults to light. */
  isDarkMode?: boolean;
  /** Max neighbors to fetch; defaults to 200. */
  limit?: number;
  /** Re-fetch trigger — bump this number whenever the host knows the graph may have changed. */
  refreshKey?: number;
}
```

### 渲染结构

```
<SidePanelContainer materialRole="raisedCard" edgeFadeItem spotlight>
  ├─ OrderSectionHeader(iconKey="related", kicker="Entity Links", title, meta=`${total} 条关联`)
  ├─ loading → Loader2 spin + "加载关联…"
  ├─ error → bannerDanger「关联加载失败：{error}」
  ├─ empty(groupKeys.length===0)→ "暂无关联"(italic emptyText)
  └─ groups(groupKeys 升序)
      └─ per linkKind:
          ├─ 分组头(labelForLinkKind(kind) + `× {items.length}`)
          └─ 邻居行列表(button.rowPill)
              ├─ {n.label || n.id}(truncate 13px font-light)
              └─ {n.type} · {direction==='out'?'指向':'被指向'} + ExternalLink(仅 onSelectNeighbor 存在时)
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `type` | `string` | 是 | — | EntityLink 图谱 type code;决定邻居查询的主锚点。常见值:`order` / `relation.organization` / `relation.contact` / `product` / `development-case` / `quotation` / `shipment` / `invoice` / `procurement` |
| `id` | `string` | 是 | — | 实体 id;与 `type` 共同定位图谱节点 |
| `additionalTypes` | `string[]` | 否 | — | 同一实体的图谱别名 type code 列表;邻居从所有 type code 拉取后按 `linkKind` 合并(详见 §6) |
| `title` | `string` | 否 | `关联视图` | 面板标题;消费方可覆盖(如 OrderManager 传 `订单关联视图`) |
| `onSelectNeighbor` | `(n: NeighborRow) => void` | 否 | — | 邻居行点击回调;接收完整 `NeighborRow`,父组件据此导航(打开目标模块/滚动到记录)。未传入时行不可点击(`cursor-default`,无 hover 高亮、无 ExternalLink 图标) |
| `isDarkMode` | `boolean` | 否 | `false` | 主题标志;传给 SidePanelContainer / OrderSectionHeader / orderUiSpec |
| `limit` | `number` | 否 | `200` | 单次 type code 拉取邻居上限;多 type code 时每个 code 各取 `limit` 条 |
| `refreshKey` | `number` | 否 | `0` | 重取触发器;宿主保存实体后 bump 此值触发图谱重拉 |

---

## §4 邻居分组与 linkKind 字典

### §4.1 分组规则

邻居按 `linkKind` 分组,`groupKeys = Object.keys(groups).sort()` 升序排列。每个分组渲染:

```
分组头:kicker 样式 + labelForLinkKind(kind) + `× {items.length}`(textFaint)
邻居行:button.rowPill,label 截断 + type·direction 元信息
```

### §4.2 LINK_KIND_LABELS 字典(真源 `entityLinksService.ts`)

| linkKind | 中文标签 | 语义 |
|---|---|---|
| `orderedBy` | 下单客户 | 订单 → 客户 |
| `suppliedBy` | 供应工厂 | 订单/产品 → 供应商 |
| `shipsTo` | 收货方 | 订单/出运 → 收货客户 |
| `billTo` | 结算方 | 订单/发票 → 结算客户 |
| `handledBy` | 负责销售 | 订单 → 销售 Relation |
| `merchandisedBy` | 跟单 | 订单 → 跟单员 |
| `supervisedBy` | 主管 | 订单 → 主管 |
| `developFor` | 开发客户 | 开发案 → 客户 |
| `developBy` | 开发供应商 | 开发案 → 供应商 |
| `aboutProduct` | 关联产品 | 订单/开发 → 产品 |
| `sentBy` | 往来邮件 | 实体 → 邮件 |
| `aboutOrder` | 关联订单 | 邮件/发票 → 订单 |
| `aboutInvoice` | 发票邮件 | 邮件 → 发票 |
| `quotedFor` | 报价客户 | 报价 → 客户 |
| `convertedToOrder` | 转化订单 | 报价 → 订单 |
| `forOrder` | 所属订单 | 行项/出运 → 订单 |
| `fromQuotation` | 来源报价 | 订单 → 报价 |
| `purchasedFrom` | 采购供应商 | 采购 → 供应商 |
| `fromBom` | 来源 BOM | 采购 → BOM |
| `clearsShipment` | 清关出运 | 报关 → 出运 |
| `declaredFor` | 报关客户 | 报关 → 客户 |
| `refundsDeclaration` | 退税报关单 | 退税 → 报关单 |
| `refundTo` | 退税客户 | 退税 → 客户 |
| `opportunityFor` | 商机客户 | 商机 → 客户 |
| `producedFor` | 所属客户 | 产品 → 客户 |
| `manufacturedBy` | 生产工厂 | 产品 → 工厂 |
| `outsourcedTo` | 外协加工厂 | 订单 → 外协厂 |

**兜底规则**:`labelForLinkKind(kind) = LINK_KIND_LABELS[kind] ?? kind`——服务端新增 linkKind 时前端不报错,直接显示原始 key,保证可用性。

---

## §5 内部状态管理

| 类别 | 字段 | 数据源 | 用途 |
|---|---|---|---|
| 邻居数据 | `data` | `entityLinksService.getNeighbors({type, id, limit})`(每个 type code 一次,Promise.all 并行) | 分组渲染 |
| 加载态 | `loading` | 内部 state | Loader2 旋转 + 加载文案 |
| 错误 | `error` | 内部 state | bannerDanger 行内提示 |

### useEffect 数据拉取

```ts
const additionalTypesKey = (additionalTypes ?? []).join('|');

useEffect(() => {
  if (!type || !id) return;
  let cancelled = false;
  setLoading(true); setError(null);
  const typeCodes = [type, ...(additionalTypes ?? [])];
  Promise.all(typeCodes.map(t => entityLinksService.getNeighbors({ type: t, id, limit })))
    .then(responses => {
      if (cancelled) return;
      // 多 type code 结果按 linkKind 合并
      const merged: Record<string, NeighborRow[]> = {};
      let total = 0;
      for (const res of responses) {
        total += res.total ?? 0;
        for (const [kind, rows] of Object.entries(res.neighbors ?? {})) {
          merged[kind] = [...(merged[kind] ?? []), ...rows];
        }
      }
      setData({ ok: true, type, id, total, neighbors: merged });
    })
    .catch(err => { if (!cancelled) setError(err?.message ?? String(err)); })
    .finally(() => { if (!cancelled) setLoading(false); });
  return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [type, id, limit, refreshKey, additionalTypesKey]);
```

**关键设计**:
- `additionalTypesKey` 作为依赖项字符串化——避免数组引用变化导致重复拉取
- `cancelled` 守卫——防止组件卸载后 setState
- `type || id` 空值守卫——父组件未传入时不发请求

---

## §6 多 type code 合并(图谱别名)

### §6.1 问题背景

EntityLink 图谱历史上对同一 Relation 行使用多个 type code:
- 联系人 **owned** 链接挂在 `relation.contact`(联系人作为图谱节点 own 的链接)
- 订单 **角色** 链接指向 `relation.person`(订单的 sales/merchandiser 角色字段指向同一联系人行)

若只查 `relation.contact`,会漏掉订单角色侧的入向邻居;若只查 `relation.person`,会漏掉联系人 own 的出向链接。

### §6.2 合并策略

```tsx
// DetailPanel 联系人布局
<RelatedEntitiesPanel
  type={isOrg ? 'relation.organization' : 'relation.contact'}
  additionalTypes={isOrg ? undefined : ['relation.person']}
  id={data.id}
  isDarkMode={isDarkMode}
  title="关联视图"
/>
```

- `type` 为主锚点,`additionalTypes` 为别名列表
- `[type, ...additionalTypes]` 逐个 `getNeighbors`,Promise.all 并行
- 结果按 `linkKind` 合并:`merged[kind] = [...(merged[kind] ?? []), ...rows]`
- `total` 累加所有 type code 的 total

**组织布局**无需别名——`relation.organization` 是唯一 type code。

---

## §7 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 加载中 | `loading === true` | `Loader2 size=14 animate-spin` + emptyText | 「加载关联…」 |
| 错误 | `error !== null && !loading` | `bannerDanger`(statusSemanticClass danger 中性色) | 「关联加载失败:{error}」 |
| 空态 | `!loading && !error && groupKeys.length === 0` | emptyText + italic | 「暂无关联」 |
| 有数据 | `!loading && !error && groupKeys.length > 0` | 分组 + 胶囊行 | 分组头 `{label} × {count}` |
| 行可点击 | `onSelectNeighbor` 存在 | `rowPillHover`(hover border/text 变 accent)+ ExternalLink 图标 | — |
| 行不可点击 | `onSelectNeighbor` 未传 | `cursor-default`,无 hover 高亮,无 ExternalLink | — |

---

## §8 联动(onSelectNeighbor 跳转导航)

### §8.1 被动设计哲学

RelatedEntitiesPanel **保持被动**——它不加载目标实体本身,只渲染图谱指针(`NeighborRow`)。点击邻居后做什么(打开目标模块、滚动到记录、弹出详情)由父组件 `onSelectNeighbor` 决定。

### §8.2 NeighborRow 结构

```ts
export interface NeighborRow {
  direction: LinkDirection;  // 'out' | 'in'
  type: string;              // 邻居实体 type code
  id: string;                // 邻居实体 id
  linkKind: string;          // 关联种类
  updatedAt?: number;
  label?: string;            // 人类可读标签(由 EntityReference snapshot 解析)
}
```

### §8.3 OrderManager 接入(纯展示)

```tsx
<RelatedEntitiesPanel
  type="order"
  id={selectedOrder.id}
  isDarkMode={isDarkMode}
  title="订单关联视图"
/>
```

未传 `onSelectNeighbor`——行不可点击,仅展示关联全景(客户/供应商/收货方/销售/跟单等)。

### §8.4 ReportCenter 接入(跨模块跳转)

```tsx
// ReportCenter.tsx:报表聚合行 → 组成员实体 → RelatedEntitiesPanel 图谱 → 所属模块
<RelatedEntitiesPanel
  type={...}
  id={...}
  onSelectNeighbor={(n) => onNavigate?.(n.type, n.id)}  // 跳转到邻居所属模块
  ...
/>
```

---

## §9 状态机

```
组件 mount / (type,id,refreshKey,additionalTypesKey) 变化
  ↓
  type||id 空值? → 不发请求,保持初始态
  ↓
  setLoading(true) / setError(null)
  ↓
  Promise.all(typeCodes.map(getNeighbors))  // 并行多 type code
  ↓
  ├─ 成功 → 按 linkKind 合并 → setData({neighbors: merged, total}) → 渲染分组
  ├─ 失败 → setError(message) → 渲染 bannerDanger
  └─ 卸载 → cancelled=true,丢弃结果

用户点邻居行(onSelectNeighbor 存在)
  ↓
  onSelectNeighbor(NeighborRow) → 父组件导航
```

---

## §10 数据模型

真源:`services/entityLinksService.ts`

```ts
export type LinkDirection = 'out' | 'in';

export interface EntityLinkRow {
  id: string;
  fromType: string; fromId: string;
  toType: string;   toId: string;
  linkKind: string;
  source?: string | null;
  status?: string;
  updatedAt?: number;
  createdAt?: number;
}

export interface NeighborRow {
  direction: LinkDirection;
  type: string;
  id: string;
  linkKind: string;
  updatedAt?: number;
  label?: string;  // 由 EntityReference snapshot 解析的人类可读标签
}

export interface NeighborsResponse {
  ok: boolean;
  type: string;
  id: string;
  total: number;
  /** keyed by linkKind (e.g. orderedBy, suppliedBy, developFor, aboutProduct) */
  neighbors: Record<string, NeighborRow[]>;
}

export interface LinksResponse {
  ok: boolean;
  total: number;
  links: EntityLinkRow[];
  /** key is `<type>::<id>` of either side */
  snapshots?: Record<string, Record<string, unknown> | null>;
}
```

**两个端点分工**:
- `getNeighbors`——按 `linkKind` 分组 + label 已解析,**适合侧边栏关联卡片**(本组件使用)
- `listLinks`——返回原始 EntityLink 行 + 可选 snapshot,适合需要 from/to 双向详情的场景

---

## §11 API 端点清单

| 端点 | 方法 | 用途 | 调用方 |
|---|---|---|---|
| `/v1/entities/neighbors?type=&id=&limit=` | GET | 按 linkKind 分组的邻居(含 label 快照) | `entityLinksService.getNeighbors` |
| `/v1/entities/links?type=&id=&linkKind=&limit=&expand=1` | GET | 原始 EntityLink 行(可选 snapshot) | `entityLinksService.listLinks`(本组件未直接用,供其他详情场景) |

**请求头**:复用 `apiService.getAuthHeaders()`(JWT / API-Key)。
**base 解析**:`apiService.getStoredConfig().cloudEndpoint` 或 `params.endpoint` 覆盖。

---

## §12 权限与可见性

| 场景 | 可见 RelatedEntitiesPanel | 可点击跳转 |
|---|---|---|
| 订单详情(OrderManager) | 需 `orders:read` | 默认未接 onSelectNeighbor(纯展示) |
| 客户详情(DetailPanel) | 需 `relations:read` | 默认未接 onSelectNeighbor |
| 报表中心(ReportCenter) | 需对应模块读权限 | ✅ onSelectNeighbor 跨模块跳转 |
| 出运/采购/报价/财务/报关详情 | 需对应模块 `:read` | 视消费方接入 |

> **铁律**:RelatedEntitiesPanel 不在前端做权限预判——它被动渲染服务端返回的邻居。若当前角色对某模块无读权限,服务端邻居查询本身就不会返回该模块的链接(图谱写入受模块写权限门禁)。`onSelectNeighbor` 跳转后目标模块自行做二次权限校验。

---

## §13 设计系统约束(BDS)

- **主容器**:`SidePanelContainer materialRole="raisedCard" edgeFadeItem spotlight`——与详情页所有面板同构(非手写 div)
- **面板配方**:`createOrderUiSpec(isDarkMode)` 一次求值,取 `panelClass` / `panelContentClass`
- **分区头**:`OrderSectionHeader iconKey="related" kicker="Entity Links"`——图标取 `ORDER_SECTION_ICONS.related`(Network 图标)
- **分组头**:`spec.kicker`(11px font-light uppercase tracking-0.22em)+ `× {count}`(textFaint)
- **邻居行**:`spec.rowPill`(flex justify-between rounded-full border px-4 py-2 13px font-light)+ `spec.rowPillHover`(hover border/text 变 accent)
- **行材质(非 justify-between 布局)**:`spec.rowPillSurface`——border + bg + 默认文字色,供其他行复用同一材质
- **行元信息**:`text-[10px] font-light textMuted` + `ExternalLink size=12 strokeWidth=1.5`(仅 onSelectNeighbor 存在)
- **状态色**:遵守 RDL 中性契约(statusSemanticClass),禁 emerald/red/amber 彩色;accent 蓝仅用于 hover 锚点
- **字重**:仅 font-extralight / font-light / font-normal,禁 medium+
- **防回退**:`scripts/check-design-tokens.sh` 扫描硬编码

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-REP1 | **多数消费方未接 `onSelectNeighbor`**——OrderManager/DetailPanel 等仅纯展示,用户无法点击跳转到关联实体 | 跨模块导航需手动切模块搜索 | P2 |
| GAP-REP2 | 邻居行无 `updatedAt` 时间展示 | 无法判断关联新鲜度 | P3 |
| GAP-REP3 | 分组无折叠——linkKind 多时面板冗长 | 订单关联 8+ 分组时滚动疲劳 | P3 |
| GAP-REP4 | 无「在图谱中查看」入口(知识图谱可视化) | 关联全景仅列表,无图结构感知 | P3 |
| GAP-REP5 | 邻居 label 依赖服务端 snapshot 解析,缺 label 时仅显示 id | 部分历史链接可读性差 | P3 |

---

## §15 相关文档索引

- [../00-索引.md](../00-索引.md) — 设计文档真源总索引
- [DetailPanel.md](./DetailPanel.md) — Relations 详情主面板(RelatedEntitiesPanel 主要消费方之一)
- [AuditHistorySection.md](./AuditHistorySection.md) — 审计 diff 展开面板(同属阶段 D 详情页通用面板族)
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板容器(本组件底层材质)
- [BDS组件族7规格.md](./BDS组件族7规格.md) — CompiledSurfacePanel / SidePanelContainer 原语规格
- [../../components/RelatedEntitiesPanel.tsx](../../components/RelatedEntitiesPanel.tsx) — 组件源码
- [../../services/entityLinksService.ts](../../services/entityLinksService.ts) — EntityLink 图谱服务(LINK_KIND_LABELS 字典真源)
- [../04-模块设计/02-客户与开拓/Relations-联系人.md](../04-模块设计/02-客户与开拓/Relations-联系人.md) — Relations 模块(联系人双码合并场景)

---

## §16 补充说明

1. **被动设计铁律**:RelatedEntitiesPanel 只渲染图谱指针(`NeighborRow`),绝不加载目标实体本身。导航决策权交还父组件 `onSelectNeighbor`——这是为了保持组件通用性,避免与目标模块的数据获取/权限/状态机耦合
2. **多 type code 合并**:联系人图谱别名(`relation.contact` + `relation.person`)通过 `additionalTypes` 合并,按 `linkKind` 去重式聚合。这是图谱历史 type code 分裂的兼容层,新实体应尽量用单一 type code
3. **linkKind 字典兜底**:`labelForLinkKind` 对未知 kind 回退原始 key——服务端新增 linkKind 时前端不报错、不空白,保证可用性。字典补全属于持续维护项,见 `entityLinksService.ts` LINK_KIND_LABELS
4. **`additionalTypesKey` 依赖字符串化**:数组 `additionalTypes` 直接作为 useEffect 依赖会因引用变化触发重复拉取,故用 `.join('|')` 字符串化作为依赖——这是 React 数组依赖的标准规避模式
5. **`limit=200` 默认值**:单 type code 最多拉 200 条邻居,覆盖绝大多数实体关联规模;超大关联图谱(如报表中心聚合)可由消费方传入更大 limit
6. **与 OrderContextSection 分工**:OrderManager 同时渲染 RelatedEntitiesPanel(`type="order"`,EntityLink 图谱邻居)与 OrderContextSection(全链路:报价→开发→BOM→采购→生产→外协→出运→财务)。前者是图谱指针,后者是业务链路聚合——两者数据源不同,互补不重叠
7. **行可点击态由 `onSelectNeighbor` 驱动**:`rowCls = rowPill + (onSelectNeighbor ? rowPillHover : 'cursor-default')`——未传回调时行不可点击、无 hover 高亮、无 ExternalLink 图标,避免误导用户
