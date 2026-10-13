# AuditHistorySection 组件规格 · 审计 diff 展开面板

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `AuditHistorySection` |
| 定位 | 实体变更历史通用面板——给定 `(targetType, targetId)`,自取审计日志(最近 20 条倒序),字段级 diff 优先展示(`fieldPath: before → after`),否则回退 action 摘要。是订单/客户/产品等所有详情页的审计出口 |
| 文件路径 | `components/AuditHistorySection.tsx`(177 行) |
| 消费方 | `OrderManager.tsx`(targetType=`Order`)/ `DetailPanel.tsx`(targetType=`Relation`,组织与联系人共用) |
| 范式 | 自取数据型——`(targetType, targetId)` 由父注入;内部 `useEffect` 自取审计日志;`refreshKey` 由宿主 bump 触发重取(保存实体后刷新) |
| 优先级 | P1(阶段 D / D6 实体审计收口 + Phase 0 Sprint 1 字段级审计) |
| 实现状态 | ✅ 已落地(字段级 diff 优先 + action 回退 + 403 优雅降级 + 4 态规范 + orderUiSpec 统一材质);⚠️ 当前为单行摘要展示,未实现逐条展开折叠的 diff 详情视图(行内 `title` tooltip 兜底) |
| PRD 关联 | PRD §19.4(变更历史与审计)/ §6.1(客户 360° 档案审计)/ §12.3(全渠道沟通流水可追溯) |
| 代码关联 | [AuditHistorySection.tsx](../../components/AuditHistorySection.tsx) / [apiService.ts](../../services/apiService.ts) `getEntityAuditLogs` / [types.ts](../../types.ts) `EntityAuditLogItem` / [SidePanelContainer.tsx](../../components/ui/SidePanelContainer.tsx) / [OrderSectionHeader.tsx](../../components/order/OrderSectionHeader.tsx) `iconKey="audit"` / [orderUiSpec.ts](../../components/order/orderUiSpec.ts) `panelClass / rowPillSurface / textMuted / textSecondary / textPrimary / emptyText / bannerDanger` / [audit/route.ts](../../server/src/audit/route.ts) `GET /v1/audit/entity` / [audit/entityQuery.ts](../../server/src/audit/entityQuery.ts) `canReadEntityAudit / buildAuditLogQuery` / [audit/routeAudit.ts](../../server/src/audit/routeAudit.ts) `writeRouteAuditLog / writeFieldAuditLog` |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架(Props 接口 + 内部结构)

```ts
export interface AuditHistorySectionProps {
  /** AuditLog.targetType，如 "Order" / "Relation" / "Invoice" */
  targetType: string;
  /** AuditLog.targetId */
  targetId: string;
  /** 标题覆盖；默认 "变更历史" */
  title?: string;
  isDarkMode?: boolean;
  /** 宿主保存实体后 bump 触发重取 */
  refreshKey?: number;
}
```

### 渲染结构

```
<SidePanelContainer materialRole="raisedCard" edgeFadeItem spotlight>
  ├─ OrderSectionHeader(iconKey="audit", kicker="Audit Trail", title, meta=`${logs.length} 条记录`)
  ├─ loading → Loader2 spin + "加载变更记录…"
  ├─ forbidden(403) → "当前角色无权限查看该模块的变更记录"(italic emptyText)
  ├─ error → bannerDanger「变更记录加载失败：{error}」
  ├─ empty(logs.length===0)→ "暂无变更记录"(italic emptyText)
  └─ 有数据(logs.length>0)
      └─ 日志行列表(div.flex.flex-col.gap-1.5)
          └─ per log:
              ├─ 时间(shrink-0 tabular-nums 11px muted, formatTime)
              ├─ 操作人(shrink-0 textSecondary, actor.displayName/email/id)
              └─ 摘要(flex-1 truncate textPrimary, title=summaryOf 全文)
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `targetType` | `string` | 是 | — | AuditLog.targetType;实体类型标识。常见值:`Order` / `Relation` / `Invoice` / `Shipment` / `Quotation` / `ProductionStage`。决定模块读权限门禁(详见 §12) |
| `targetId` | `string` | 是 | — | AuditLog.targetId;实体 id。与 `targetType` 共同定位审计记录 |
| `title` | `string` | 否 | `变更历史` | 面板标题;消费方可覆盖(如 OrderManager 传 `订单变更历史`) |
| `isDarkMode` | `boolean` | 否 | `false` | 主题标志;传给 SidePanelContainer / OrderSectionHeader / orderUiSpec |
| `refreshKey` | `number` | 否 | `0` | 重取触发器;宿主保存实体后 bump 此值触发审计重拉,确保最新变更立即可见 |

---

## §4 摘要生成(actionLabel / valueText / summaryOf)

### §4.1 actionLabel——动作可读化

通用前缀规则(非逐 action 字典),覆盖 `create_` / `update_` / `delete_` / `cancel_` 四类:

```ts
function actionLabel(action: string): string {
  if (action.startsWith('create_')) return `创建 · ${action.slice(7)}`;
  if (action.startsWith('update_')) return `更新 · ${action.slice(7)}`;
  if (action.startsWith('delete_')) return `删除 · ${action.slice(7)}`;
  if (action.startsWith('cancel_')) return `作废 · ${action.slice(7)}`;
  return action;  // 无前缀的 action 原样返回
}
```

**设计意图**:不在前端维护 action→中文 的逐条字典——action 命名遵循 `动词_对象` 约定,前缀规则可覆盖绝大多数场景,新 action 无需前端改字典。

### §4.2 valueText——值可读化

```ts
function valueText(v: unknown): string {
  if (v === null || v === undefined) return '—';       // 空值显示破折号
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);                         // 对象/数组序列化
    return s.length > 40 ? s.slice(0, 40) + '…' : s;    // 超 40 字符截断
  } catch { return String(v); }
}
```

### §4.3 summaryOf——字段级 diff 优先

```ts
function summaryOf(log: EntityAuditLogItem): string {
  if (log.fieldPath) {
    return `${log.fieldPath}: ${valueText(log.beforeValue)} → ${valueText(log.afterValue)}`;
  }
  return actionLabel(log.action);  // 无 fieldPath 回退 action
}
```

**优先级**:字段级审计(`fieldPath` + `beforeValue` + `afterValue`)优先展示精确 diff;无字段级信息时回退 action 摘要。这是 Phase 0 Sprint 1 字段级审计的展示层落点。

### §4.4 formatTime——时间格式化

```ts
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;  // 非法时间原样返回
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
```

输出 `YYYY-MM-DD HH:mm`(无秒),匹配审计记录的阅读粒度。

---

## §5 内部状态管理

| 类别 | 字段 | 数据源 | 用途 |
|---|---|---|---|
| 审计日志 | `logs` | `apiService.getEntityAuditLogs(targetType, targetId)`(GET `/v1/audit/entity`,limit 20 倒序) | 行列表渲染 |
| 加载态 | `loading` | 内部 state | Loader2 旋转 + 加载文案 |
| 错误 | `error` | 内部 state | bannerDanger 行内提示 |
| 无权限 | `forbidden` | 内部 state(403/FORBIDDEN 触发) | 优雅降级提示,非报错 |

### useEffect 数据拉取

```ts
useEffect(() => {
  if (!targetType || !targetId) return;
  let cancelled = false;
  setLoading(true); setError(null); setForbidden(false);
  apiService.getEntityAuditLogs(targetType, targetId)
    .then(items => { if (!cancelled) setLogs(items); })
    .catch((err: any) => {
      if (cancelled) return;
      const msg = String(err?.message ?? err ?? '');
      if (msg.includes('403') || msg.includes('FORBIDDEN')) {
        setForbidden(true);          // 403 → 优雅降级,不报错
      } else {
        setError(msg || '加载失败');
      }
    })
    .finally(() => { if (!cancelled) setLoading(false); });
  return () => { cancelled = true; };
}, [targetType, targetId, refreshKey]);
```

**关键设计**:
- 403 不走 `error` 分支,而是 `forbidden`——权限不足是预期态,非系统错误
- `cancelled` 守卫——防止组件卸载后 setState
- `refreshKey` 依赖——宿主保存实体后 bump 触发重取

---

## §6 字段级审计与 action 审计双轨

### §6.1 AuditLog 模型(schema.prisma 真源)

```prisma
model AuditLog {
  id            String   @id
  actorId       String
  action        String
  targetType    String?
  targetId      String?
  detail        Json?
  ip            String?
  // Phase 0 Sprint 1: 字段级审计(before/after 单字段追踪)
  operationType String? // create / update / delete / transition / link / unlink
  fieldPath     String? // 如 "status" 或 "lines[0].quantity"
  beforeValue   Json?
  afterValue    Json?
  transactionId String? // 关联 OrderStatusTransition / BusinessEvent id，串联同一业务操作
  createdAt     DateTime @default(now())

  actor UserAccount @relation(fields: [actorId], references: [id])

  @@index([actorId])
  @@index([action])
  @@index([createdAt])
  @@index([targetType, targetId])
  @@index([transactionId])
}
```

### §6.2 双轨写入

- **`writeRouteAuditLog`**(路由级)——记录整次操作的 `action` + `detail`(JSON),无字段级 diff。适用于「创建了订单」「推进了阶段」等操作级审计
- **`writeFieldAuditLog`**(字段级)——记录单字段 `fieldPath` + `beforeValue` + `afterValue` + `operationType`。适用于「status: Pending → Confirmed」「amount: 1000 → 1200」等字段级 diff

### §6.3 展示层优先级

`summaryOf` 优先消费字段级信息:`fieldPath` 存在时展示 `fieldPath: before → after`;否则回退 `actionLabel(action)`。同一次业务操作可能产生多条字段级日志(通过 `transactionId` 串联),面板按时间倒序平铺展示。

### §6.4 EntityAuditLogItem 前端类型

```ts
export interface EntityAuditLogItem {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  operationType: string | null;   // create / update / delete / transition / link / unlink
  fieldPath: string | null;        // 如 "status" 或 "lines[0].quantity"
  beforeValue: unknown;
  afterValue: unknown;
  detail: unknown;
  createdAt: string;
  actor: { id: string; displayName: string | null; email: string | null };
}
```

---

## §7 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 加载中 | `loading === true` | `Loader2 size=14 animate-spin` + emptyText | 「加载变更记录…」 |
| 无权限 | `forbidden === true && !loading` | emptyText + italic | 「当前角色无权限查看该模块的变更记录」 |
| 错误 | `error !== null && !loading && !forbidden` | `bannerDanger`(statusSemanticClass danger 中性色) | 「变更记录加载失败:{error}」 |
| 空态 | `!loading && !error && !forbidden && logs.length === 0` | emptyText + italic | 「暂无变更记录」 |
| 有数据 | `!loading && !error && !forbidden && logs.length > 0` | 日志行列表 + meta=`${logs.length} 条记录` | 行:`{时间} {操作人} {摘要}` |

---

## §8 联动(refreshKey / targetType 统一)

### §8.1 OrderManager 接入

```tsx
<div id="order-detail-audit">
  <AuditHistorySection
    targetType="Order"
    targetId={selectedOrder.id}
    isDarkMode={isDarkMode}
    title="订单变更历史"
  />
</div>
```

### §8.2 DetailPanel 接入(组织/联系人共用)

```tsx
<AuditHistorySection
  targetType="Relation"   // 组织与联系人共用 Relation 实体,targetType 统一
  targetId={data.id}
  isDarkMode={isDarkMode}
  title="变更历史"
/>
```

**targetType 统一铁律**:组织与联系人在数据层共用 `Relation` 实体,审计日志 `targetType` 统一为 `'Relation'`——避免 targetType 分裂导致审计断裂。

### §8.3 refreshKey 触发重取

宿主保存实体后 bump `refreshKey`,AuditHistorySection 重新拉取审计日志,确保最新变更(如刚更新的字段)立即可见。当前 OrderManager / DetailPanel 未显式传 `refreshKey`,依赖组件 mount/`targetId` 变化触发拉取。

---

## §9 状态机

```
组件 mount / (targetType, targetId, refreshKey) 变化
  ↓
  targetType||targetId 空值? → 不发请求
  ↓
  setLoading(true) / setError(null) / setForbidden(false)
  ↓
  GET /v1/audit/entity?targetType&targetId
  ↓
  ├─ 200 → setLogs(items) → 渲染行列表
  ├─ 403(FORBIDDEN)→ setForbidden(true) → 渲染「无权限」提示
  ├─ 其他错误 → setError(msg) → 渲染 bannerDanger
  └─ 卸载 → cancelled=true,丢弃结果
```

---

## §10 数据模型

真源:`server/prisma/schema.prisma` AuditLog 模型 + `types.ts` EntityAuditLogItem

### §10.1 AuditLog 字段语义

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `String @id` | 审计日志主键 |
| `actorId` | `String` | 操作人 UserAccount id(外键) |
| `action` | `String` | 动作标识,遵循 `动词_对象` 约定(如 `create_order` / `update_relation` / `advance_production_stage`) |
| `targetType` | `String?` | 目标实体类型(如 `Order` / `Relation` / `ProductionStage`) |
| `targetId` | `String?` | 目标实体 id |
| `detail` | `Json?` | 操作详情(JSON,路由级审计载体) |
| `ip` | `String?` | 请求来源 IP |
| `operationType` | `String?` | 字段级审计操作类型:`create` / `update` / `delete` / `transition` / `link` / `unlink` |
| `fieldPath` | `String?` | 变更字段路径,如 `status` / `amount` / `lines[0].quantity` |
| `beforeValue` | `Json?` | 变更前值 |
| `afterValue` | `Json?` | 变更后值 |
| `transactionId` | `String?` | 事务 id,关联 OrderStatusTransition / BusinessEvent,串联同一业务操作产生的多条字段级日志 |
| `createdAt` | `DateTime` | 创建时间(默认 now) |
| `actor` | `UserAccount` | 操作人关联(include select id/displayName/email) |

### §10.2 索引设计

- `@@index([targetType, targetId])`——实体审计查询主索引(本组件查询路径)
- `@@index([actorId])`——按操作人查询
- `@@index([action])`——按动作类型查询
- `@@index([createdAt])`——按时间范围查询
- `@@index([transactionId])`——按事务串联查询

---

## §11 API 端点清单

| 端点 | 方法 | 用途 | 调用方 |
|---|---|---|---|
| `/v1/audit/entity?targetType=&targetId=` | GET | 实体审计日志(强制两参,limit 20 倒序,模块读权限门禁) | `apiService.getEntityAuditLogs` |
| `/admin/audit-logs` | GET | 全局审计查询(owner/admin,支持 action/actor/date 过滤) | 管理后台(非本组件) |

**实体审计端点约束**(`audit/route.ts`):
- **强制两参**:`targetType` + `targetId` 均必填,防全表扫描
- **固定 limit 20**:`ENTITY_AUDIT_LIMIT = 20`,倒序(`orderBy: createdAt desc`)取最近
- **模块读权限门禁**:`canReadEntityAudit(actorRoles, targetType)` 角色映射,fail closed
- **认证**:JWT 或 API-Key(复用 `createModuleAuthGuard`)
- **响应**:`{ ok, logs: EntityAuditLogItem[] }`,actor include `{ id, displayName, email }`

---

## §12 权限与可见性

### §12.1 模块读权限映射(`canReadEntityAudit`,fail closed)

| targetType | 允许角色 | 语义 |
|---|---|---|
| `Order` | owner / admin / manager / merchandiser / finance / sales | 订单审计 |
| `Relation` | owner / admin / manager / merchandiser / sales | 客户审计(组织+联系人) |
| `Invoice` / 财务类 | owner / admin / manager / finance / sales / merchandiser | 财务审计 |
| `Shipment` / 出运类 | owner / admin / manager / finance / sales / merchandiser / logistics | 出运审计 |
| `Quotation` | owner / admin / manager / sales / merchandiser | 报价审计 |
| 未映射 targetType | owner / admin / manager(fail closed) | 兜底 |

### §12.2 403 优雅降级

```tsx
{forbidden && !loading && (
  <div className={`${spec.emptyText} italic`}>
    当前角色无权限查看该模块的变更记录
  </div>
)}
```

权限不足不报错、不阻塞详情页其他面板渲染——仅审计面板降级为「无权限」提示。这是与 RelatedEntitiesPanel 一致的被动设计哲学。

### §12.3 审计写入权限

审计日志写入由服务端路由在业务操作事务内自动完成(`writeRouteAuditLog` / `writeFieldAuditLog`),前端不直接写审计——确保审计不可绕过、不可篡改。

---

## §13 设计系统约束(BDS)

- **主容器**:`SidePanelContainer materialRole="raisedCard" edgeFadeItem spotlight`——与详情页所有面板同构
- **面板配方**:`createOrderUiSpec(isDarkMode)` 一次求值,取 `panelClass` / `panelContentClass`
- **分区头**:`OrderSectionHeader iconKey="audit" kicker="Audit Trail"`——图标取 `ORDER_SECTION_ICONS.audit`(History 图标),meta=`${logs.length} 条记录`
- **日志行**:`rowPillSurface` 材质(border + bg + 默认文字色,与 RelatedEntitiesPanel 关联行同一材质 + 对齐布局)——`flex items-center gap-3 rounded-full border px-4 py-2 text-left text-[13px] font-light`
- **时间**:`shrink-0 whitespace-nowrap tabular-nums text-[11px] textMuted`——等宽数字保证时间列对齐
- **操作人**:`shrink-0 whitespace-nowrap textSecondary`
- **摘要**:`min-w-0 flex-1 truncate textPrimary` + `title={summaryOf(log)}` tooltip 兜底(截断时悬停看全文)
- **状态色**:遵守 RDL 中性契约(statusSemanticClass),禁 emerald/red/amber 彩色
- **字重**:仅 font-extralight / font-light / font-normal,禁 medium+
- **防回退**:`scripts/check-design-tokens.sh` 扫描硬编码

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-AHS1 | **未实现逐条展开折叠的 diff 详情视图**——当前为单行摘要 + tooltip 兜底,字段级 diff 复杂对象截断后不可读 | 复杂变更(如 `lines` 数组改动)摘要截断,需 tooltip 看部分 | P2 |
| GAP-AHS2 | 无 `transactionId` 串联分组——同一业务操作的多条字段级日志平铺,无法折叠为一次操作 | 操作粒度感知差,日志条目多时冗长 | P2 |
| GAP-AHS3 | 无「按字段过滤」能力 | 无法快速定位某字段的变更历史 | P3 |
| GAP-AHS4 | 固定 limit 20,无分页/加载更多 | 变更频繁的实体历史不完整 | P3 |
| GAP-AHS5 | 无操作人头像/角色标识 | 操作人仅文字,辨识度低 | P3 |
| GAP-AHS6 | `operationType` 未在 UI 中显式区分(transition/link/unlink 等) | 操作类型仅靠 action 文本推断 | P3 |

---

## §15 相关文档索引

- [../00-索引.md](../00-索引.md) — 设计文档真源总索引
- [DetailPanel.md](./DetailPanel.md) — Relations 详情主面板(AuditHistorySection 主要消费方,targetType=Relation)
- [RelatedEntitiesPanel.md](./RelatedEntitiesPanel.md) — EntityLink 跨模块关联面板(同属阶段 D 详情页通用面板族,同被动设计哲学)
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板容器(本组件底层材质)
- [BDS组件族7规格.md](./BDS组件族7规格.md) — CompiledSurfacePanel / SidePanelContainer 原语规格
- [../../components/AuditHistorySection.tsx](../../components/AuditHistorySection.tsx) — 组件源码
- [../../server/src/audit/route.ts](../../server/src/audit/route.ts) — 实体审计路由(权限门禁 + limit 20)
- [../../server/src/audit/entityQuery.ts](../../server/src/audit/entityQuery.ts) — canReadEntityAudit 角色映射真源

---

## §16 补充说明

1. **被动设计铁律**:AuditHistorySection 与 RelatedEntitiesPanel 共享同一设计哲学——只渲染服务端返回的审计记录,不在前端做权限预判。403 优雅降级为「无权限查看」提示而非报错,确保审计面板失败不影响详情页其他面板
2. **字段级 diff 优先**:`summaryOf` 优先消费 `fieldPath` + `beforeValue` + `afterValue`,展示精确的 `fieldPath: before → after`;无字段级信息时回退 `actionLabel(action)`。这是 Phase 0 Sprint 1 字段级审计的展示层落点,路由级审计(无 fieldPath)自然降级为 action 摘要
3. **action 前缀规则而非字典**:`actionLabel` 用 `create_`/`update_`/`delete_`/`cancel_` 前缀规则覆盖,不维护逐 action 字典——新 action 遵循命名约定即自动可读,前端无需改代码
4. **targetType 统一铁律**:组织与联系人在数据层共用 `Relation` 实体,审计 `targetType` 统一为 `'Relation'`。DetailPanel 在组织/联系人双布局下均传 `targetType="Relation"`,避免 targetType 分裂导致审计断裂
5. **rowPillSurface 同源**:审计行与 RelatedEntitiesPanel 关联行使用同一 `rowPillSurface` 材质 + 对齐的 `flex items-center gap-3` 布局——视觉上两个面板的行元素完全同构,降低用户认知负担
6. **固定 limit 20 倒序**:`ENTITY_AUDIT_LIMIT = 20` 由路由强制(`audit/route.ts`),前端不可调。这是实体审计的防全表扫描约束——全局审计查询走 `/admin/audit-logs`(owner/admin,支持分页与过滤)
7. **transactionId 串联前瞻**:同一业务操作(如订单状态迁移)可能产生多条字段级日志,通过 `transactionId` 串联。当前面板按时间倒序平铺,未做 transactionId 分组折叠(GAP-AHS2)——未来实现时可按 transactionId 聚合为可展开的操作组
