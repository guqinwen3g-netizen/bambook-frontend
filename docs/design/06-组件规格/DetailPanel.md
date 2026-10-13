# DetailPanel 组件规格 · 两栏详情面板

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `DetailPanel` |
| 定位 | CRM 客户/联系人详情主面板——组织与联系人双布局,玻璃面板 + 信息区块 + 跟进/品牌线/沟通日志内联表单 + RelatedEntitiesPanel 跨模块关联 + AuditHistorySection 变更历史。是 Relations 详情页的右侧主面板 |
| 文件路径 | `components/ui/DetailPanel.tsx`(723 行) |
| 消费方 | `RelationsManager.tsx`(详情视图右侧主面板) |
| 范式 | 受控+自取数据型——`data` / `organization` / `onEdit` / `onDelete` 由父组件注入;内部 `useEffect` 自取 followUps / brandLines / commLogs |
| 优先级 | P1(阶段 P3b 全渠道沟通流水 + 阶段 D 审计/关联) |
| 实现状态 | ✅ 已落地(组织/联系人双布局 + InfoSection/InfoItem 通用块 + 品牌线/沟通日志内联增删 + RelatedEntitiesPanel + AuditHistorySection 嵌入 + CompiledEdgeFade 滚动渐隐);⚠️ Detail Map 锚点导航为前瞻设计(当前以滚动浏览为主,未实现左侧锚点 TOC) |
| PRD 关联 | PRD §6.1(客户 360° 档案)/ §6.2(品牌线档案)/ §12.3(全渠道沟通流水)/ §19.4(变更历史与审计) |
| 代码关联 | [DetailPanel.tsx](../../components/ui/DetailPanel.tsx) / [RelatedEntitiesPanel.tsx](../../components/RelatedEntitiesPanel.tsx) / [AuditHistorySection.tsx](../../components/AuditHistorySection.tsx) / [crm/crmRelationSections.tsx](../../components/ui/crm/crmRelationSections.tsx)(CrmContactsSection/FollowUps/Opportunities/CreditLimit/CustomerTier) / [apiService.ts](../../services/apiService.ts) `listFollowUps / listBrandLines / listCommLogs / createBrandLine / deleteBrandLine / createCommLog / deleteCommLog` / [bambookOsTokens.ts](../../components/ui/bambookOsTokens.ts) `BAMBOOK_OS.material` / [CompiledSurfacePanel.tsx](../../components/ui/osCompiler/compiledSurfacePrimitives.tsx) |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架(Props 接口 + 内部结构)

```ts
interface DetailPanelProps {
  type: 'organization' | 'contact';      // 组织 / 联系人双布局
  data: Relation;                         // 当前 Relation 数据
  organization?: Relation;                // 联系人模式下传入所属组织
  onEdit: () => void;                     // 编辑按钮回调
  onDelete: () => void;                   // 删除按钮回调
  isDarkMode: boolean;
}

const DetailPanel: React.FC<DetailPanelProps> = ({ type, data, organization, onEdit, onDelete, isDarkMode }) => {
  const isOrg = type === 'organization';
  // 内部状态:跟进记录 / 品牌线 / 沟通日志 / 内联表单 / 错误
  const [followUps, setFollowUps] = useState<FollowUpRecord[] | null>(null);
  const [brandLines, setBrandLines] = useState<BrandLine[] | null>(null);
  const [commLogs, setCommLogs] = useState<CommunicationLog[] | null>(null);
  const [brandLineForm, setBrandLineForm] = useState({ name: '', code: '' });
  const [commLogForm, setCommLogForm] = useState({ type: 'Email' as CommunicationType, occurredAt: ..., summary: '' });
  // ...
};
```

### 渲染结构(组织布局)

```
<div className={BAMBOOK_OS.layout.relationsDetailMainShellClass}>
<CompiledSurfacePanel compilerRole="relation-detail-main-panel">
  ├─ Header(shrink-0 p-5 border-b)
  │   ├─ 图标(Building2 / User)
  │   ├─ 基本信息(name + type/Tier 或 role/department + tags)
  │   └─ [编辑] 按钮
  ├─ CompiledEdgeFade(滚动渐隐,top=64 bottom=72)
  ├─ 滚动区(flex-1 overflow-y-auto px-5 pt-5 pb-8 space-y-3)
  │   ├─ InfoSection 联系方式(website / email / phone)
  │   ├─ InfoSection 地址信息(official / billing / shipping / factory[] / warehouse / coordinates)
  │   ├─ InfoSection 财务信息(paymentTerms / preference / currency / taxId / creditLimit)
  │   ├─ InfoSection 备注与偏好(preferences)
  │   ├─ CrmContactsSection(联系人名片列表)
  │   ├─ CrmFollowUpsSection(跟进管理)
  │   ├─ CrmOpportunitiesSection(商机)
  │   ├─ CrmCreditLimitSection(信用额度)
  │   ├─ CrmCustomerTierSection(客户分层)
  │   ├─ brandLinesSection(品牌线 + 内联增删表单)
  │   ├─ commLogsSection(沟通日志 + 内联增删表单)
  │   ├─ p3bErrorSection(操作错误行内提示)
  │   ├─ relatedEntitiesSection(RelatedEntitiesPanel 跨模块关联)
  │   └─ auditHistorySection(AuditHistorySection 变更历史)
  └─ [删除组织] 按钮(w-full h-9)
</CompiledSurfacePanel>
</div>
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `type` | `'organization' \| 'contact'` | 是 | — | 布局模式;`'organization'` 渲染组织信息(联系方式/地址/财务/CRM 区块/品牌线),`'contact'` 渲染联系人信息(所属组织/联系方式/个人信息/AI 标签) |
| `data` | `Relation` | 是 | — | 当前 Relation 数据;含 name / type / rating / tags / contactInfo / phone / email / addresses / creditLimit / preferences 等全部字段 |
| `organization` | `Relation` | 否 | — | 联系人模式下传入所属组织;仅在 `type='contact'` 时渲染「所属组织」InfoSection |
| `onEdit` | `() => void` | 是 | — | 编辑按钮回调;触发父组件打开编辑表单 |
| `onDelete` | `() => void` | 是 | — | 删除按钮回调;底部「删除组织/联系人」按钮触发 |
| `isDarkMode` | `boolean` | 是 | — | 主题标志;传给 CompiledSurfacePanel / InfoSection / RelatedEntitiesPanel / AuditHistorySection |

---

## §4 InfoSection / InfoItem 通用块

### §4.1 InfoSection 信息区块

```tsx
const InfoSection: React.FC<{
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  isDarkMode: boolean;
}> = ({ title, icon, children }) => (
  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="relative">
    <CompiledSurfacePanel as="section" materialRole="insetSurface" materialTone="nested"
      className="p-3.5 !rounded-inset" contentClassName="relative z-10"
      compilerRole="relation-detail-section-panel" source="DetailPanel.InfoSection">
      <div className="flex items-center gap-2 mb-2.5 pb-2 border-b {sectionDividerClass}">
        <span className="text-[var(--text-secondary)]">{icon}</span>
        <h4 className="text-[11px] font-light uppercase tracking-[0.18em] text-[var(--text-primary)]">{title}</h4>
      </div>
      <div className="space-y-0.5">{children}</div>
    </CompiledSurfacePanel>
  </motion.div>
);
```

**特征**:
- `motion.div` 入场动画(opacity 0→1, y 10→0)
- `CompiledSurfacePanel materialRole="insetSurface" materialTone="nested"` 嵌套玻璃面板
- 标题:11px font-light uppercase tracking-0.18em(英文 overline 风格)
- 分隔线:`BAMBOOK_OS.tone.divider.section`

### §4.2 InfoItem 信息项

```tsx
const InfoItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string | number | undefined;
  isDarkMode: boolean;
  isLink?: boolean;
}> = ({ icon, label, value, isLink }) => {
  if (!value && value !== 0) return null;  // 空值不渲染
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="mt-0.5 text-[var(--text-tertiary)]">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-light uppercase tracking-[0.18em] mb-0.5 text-[var(--text-tertiary)]">{label}</p>
        {isLink ? <a href={...} className="text-sm font-light hover:underline {brandTextClass}">{value}</a>
          : <p className="text-sm font-light whitespace-pre-line text-[var(--text-primary)]">{value}</p>}
      </div>
    </div>
  );
};
```

**渲染门禁**:`!value && value !== 0` 时返回 null——空值不渲染,避免展示无意义占位。

---

## §5 内部状态管理

### §5.1 状态分类

| 类别 | 字段 | 数据源 | 用途 |
|---|---|---|---|
| 跟进记录 | `followUps` | `apiService.listFollowUps(data.id, {limit:5, includeCompleted:true})` | 互动历史 InfoSection |
| 品牌线 | `brandLines` | `apiService.listBrandLines(data.id)`(仅组织布局) | 品牌线 InfoSection |
| 沟通日志 | `commLogs` | `apiService.listCommLogs(data.id, {limit:10})` | 沟通日志 InfoSection(全渠道流水) |
| 品牌线表单 | `brandLineForm` | 内部 state | 内联添加品牌线(name + code) |
| 沟通日志表单 | `commLogForm` | 内部 state | 内联添加沟通日志(type + occurredAt + summary) |
| 加载态 | `brandLineBusy / commLogBusy` | 内部 state | 防重复提交 + Loader2 旋转 |
| 错误 | `p3bError` | 内部 state | 品牌线/沟通日志操作错误行内提示 |

### §5.2 useEffect 数据拉取

```ts
// 互动历史:每次 data.id 变化重新拉取
useEffect(() => {
  let cancelled = false;
  setFollowUps(null);
  apiService.listFollowUps(data.id, { limit: 5, includeCompleted: true })
    .then(items => { if (!cancelled) setFollowUps(items); })
    .catch(() => { if (!cancelled) setFollowUps([]); });
  return () => { cancelled = true; };
}, [data.id]);

// 品牌线:仅组织布局拉取
useEffect(() => {
  if (!isOrg) return;
  // ... listBrandLines
}, [data.id, isOrg]);

// 沟通日志:组织/联系人布局共用
useEffect(() => {
  // ... listCommLogs
}, [data.id]);
```

**cancelled 守卫**:每个 useEffect 用 `cancelled` 标志防止组件卸载后 setState(避免内存泄漏警告)。

---

## §6 内联增删表单(品牌线 / 沟通日志)

### §6.1 品牌线增删(P3b)

```ts
const handleAddBrandLine = async () => {
  const name = brandLineForm.name.trim();
  if (!name || brandLineBusy) return;
  setBrandLineBusy(true);
  try {
    const item = await apiService.createBrandLine(data.id, { name, code: brandLineForm.code.trim() || undefined });
    setBrandLines(prev => [item, ...(prev ?? [])]);  // 头部插入
    setBrandLineForm({ name: '', code: '' });         // 清空表单
  } catch (e) {
    setP3bError(`品牌线添加失败:${e?.message || e}`);
  } finally {
    setBrandLineBusy(false);
  }
};

const handleDeleteBrandLine = async (id) => {
  // 乐观删除 + 失败回滚
};
```

**内联表单布局**:`flex items-center gap-1.5 mt-2`——name 输入(flex-1)+ code 输入(w-20)+ 添加按钮(h-6 w-6 圆形)。

### §6.2 沟通日志增删(P3b 全渠道流水)

```ts
const handleAddCommLog = async () => {
  const summary = commLogForm.summary.trim();
  if (!summary || !commLogForm.occurredAt || commLogBusy) return;
  // ... createCommLog
};
```

**表单字段**:
- `type`:select 下拉(Email / Call / WeChat / Visit / Meeting / Other 6 类)
- `occurredAt`:date 输入(默认今天)
- `summary`:文本输入(flex-1)

**COMM_TYPE_LABELS 映射**:Email→邮件 / Call→电话 / WeChat→微信 / Visit→拜访 / Meeting→会议 / Other→其他。

### §6.3 错误行内提示

```tsx
const p3bErrorSection = p3bError ? (
  <p className="text-xs text-os-adaptive-danger">{p3bError}</p>
) : null;
```

轻量行内提示,不阻塞其他 InfoSection 渲染。

---

## §7 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 加载中 | `followUps/brandLines/commLogs === null` | `加载中…`(text-xs text-tertiary) | 「加载中…」 |
| 空态 | 数据拉取完成但 length===0 | `暂无跟进记录,可在 CRM 模块添加` / `暂无品牌线档案` / `暂无沟通记录` | 各自空态文案 |
| 错误 | API 抛异常 | `p3bError` 行内提示(text-os-adaptive-danger) | `品牌线添加失败:${e.message}` |
| 删除按钮加载 | `brandLineBusy / commLogBusy === true` | 删除按钮 `Loader2 animate-spin` + disabled | — |
| 添加按钮加载 | 同上 | 添加按钮 `Loader2 animate-spin` + disabled | — |
| 无权限 | 父组件层控制(Relations 模块 read scope) | 父组件不渲染 DetailPanel | — |

---

## §8 联动(RelatedEntitiesPanel / AuditHistorySection / CRM 区块)

### §8.1 RelatedEntitiesPanel 跨模块关联

```tsx
const relatedEntitiesSection = (
  <RelatedEntitiesPanel
    type={isOrg ? 'relation.organization' : 'relation.contact'}
    additionalTypes={isOrg ? undefined : ['relation.person']}  // 联系人双码合并
    id={data.id}
    isDarkMode={isDarkMode}
    title="关联视图"
  />
);
```

**联系人双码合并**:联系人 owned 链接挂在 `relation.contact`,订单角色链接指向 `relation.person`——通过 `additionalTypes=['relation.person']` 合并两个 type code 的邻居。

### §8.2 AuditHistorySection 变更历史

```tsx
const auditHistorySection = (
  <AuditHistorySection targetType="Relation" targetId={data.id} isDarkMode={isDarkMode} title="变更历史" />
);
```

**targetType 统一为 'Relation'**:组织与联系人共用 Relation 实体,审计日志 targetType 统一。

### §8.3 CRM 结构化区块(组织布局)

```tsx
<CrmContactsSection relationId={data.id} isDarkMode={isDarkMode} />
<CrmFollowUpsSection relationId={data.id} isDarkMode={isDarkMode} />
<CrmOpportunitiesSection relationId={data.id} isDarkMode={isDarkMode} />
<CrmCreditLimitSection relationId={data.id} isDarkMode={isDarkMode} />
<CrmCustomerTierSection relationId={data.id} isDarkMode={isDarkMode} />
```

5 个 CRM 区块各自独立拉取数据,组织布局专属。

---

## §9 状态机(数据拉取 + 内联操作)

```
组件 mount / data.id 变化
  ↓
  setFollowUps(null) / setBrandLines(null) / setCommLogs(null)
  ↓
  并行拉取 3 个 API
  ↓
  ├─ 成功 → setState(items) → 渲染列表
  └─ 失败 → setState([]) → 渲染空态

用户点添加品牌线/沟通日志
  ↓
  setBusy(true)
  ↓
  API 调用
  ↓
  ├─ 成功 → setState(prev => [item, ...prev]) + 清空表单
  └─ 失败 → setP3bError(msg)

用户点删除品牌线/沟通日志
  ↓
  setBusy(true)
  ↓
  API 调用
  ↓
  ├─ 成功 → setState(prev => prev.filter(...))
  └─ 失败 → setP3bError(msg)
```

---

## §10 数据模型

真源:`types.ts` Relation / FollowUpRecord / BrandLine / CommunicationLog / CommunicationType

```ts
interface Relation {
  id: string;
  name: string;
  type: string;              // Customer / Supplier / Partner / Internal
  category: RelationCategory;
  isOrganization: boolean;
  rating?: string;           // Tier A/B/C
  tags?: string[];
  // 联系方式
  contactInfo?: string;
  phone?: string;
  email?: string;
  mobile?: string;
  wechat?: string;
  whatsapp?: string;
  website?: string;
  otherContacts?: Array<{type: string; value: string}>;
  // 地址
  officialAddress?: string;
  billingAddress?: string;
  shippingAddress?: string;
  factoryAddresses?: string[];
  warehouseAddress?: string;
  coordinates?: {lat: number; lng: number};
  // 财务
  paymentTerms?: string;
  paymentPreference?: string;
  currency?: string;
  taxId?: string;
  creditLimit?: number;
  // 个人
  role?: string;
  department?: string;
  birthday?: string;
  language?: string;
  timezone?: string;
  personalNote?: string;
  preferences?: string;
  lastInteraction: string;   // ISO 时间戳
  deletedAt?: string | null;
}

interface BrandLine {
  id: string;
  name: string;
  code?: string;
  isActive: boolean;
}

interface CommunicationLog {
  id: string;
  type: CommunicationType;
  summary: string;
  occurredAt: string;
  direction?: 'Inbound' | 'Outbound';
}

type CommunicationType = 'Email' | 'Call' | 'WeChat' | 'Visit' | 'Meeting' | 'Other';
```

---

## §11 API 端点清单

| 端点 | 方法 | 用途 | 调用方 |
|---|---|---|---|
| `/v1/relations/:id/follow-ups` | GET | 互动历史(latest 5,含已完成) | `listFollowUps` |
| `/v1/relations/:id/brand-lines` | GET | 品牌线列表(组织布局) | `listBrandLines` |
| `/v1/relations/:id/brand-lines` | POST | 添加品牌线 | `createBrandLine` |
| `/v1/relations/:id/brand-lines/:bid` | DELETE | 删除品牌线 | `deleteBrandLine` |
| `/v1/relations/:id/comm-logs` | GET | 沟通日志(latest 10) | `listCommLogs` |
| `/v1/relations/:id/comm-logs` | POST | 添加沟通日志 | `createCommLog` |
| `/v1/relations/:id/comm-logs/:lid` | DELETE | 删除沟通日志 | `deleteCommLog` |
| `/v1/entity-links/neighbors` | GET | 跨模块关联(RelatedEntitiesPanel) | `entityLinksService.getNeighbors` |
| `/v1/audit/entity` | GET | 变更历史(AuditHistorySection) | `getEntityAuditLogs` |

---

## §12 权限与可见性

| 角色 | 可见 DetailPanel | 可编辑(品牌线/沟通日志) | 可见信用额度 | 可见变更历史 |
|---|---|---|---|---|
| Sales / SalesManager | ✅ | ✅ | ⚠️ 仅管理层 | ✅ |
| Finance / FinanceManager | ✅ | ✅ | ✅ | ✅ |
| Admin / SuperAdmin | ✅ | ✅ | ✅ | ✅ |
| Operations / Warehouse | ❌(父组件层不渲染 Relations 详情) | — | — | — |

> **铁律**:DetailPanel 是 Relations 详情主面板,需 `relations:read` scope。信用额度等敏感字段由 CRM 区块(CrmCreditLimitSection)内部按 scope 控制可见性;变更历史 403 时 AuditHistorySection 优雅降级为「无权限查看」提示。

---

## §13 设计系统约束(BDS)

- **主容器**:`CompiledSurfacePanel compilerRole="relation-detail-main-panel"` + `BAMBOOK_OS.layout.relationsDetailMainShellClass`
- **InfoSection**:`CompiledSurfacePanel materialRole="insetSurface" materialTone="nested"` + `p-3.5 !rounded-inset`
- **标题**:11px font-light uppercase tracking-0.18em(英文 overline 风格)
- **InfoItem 标签**:10px font-light uppercase tracking-0.18em text-tertiary
- **InfoItem 值**:text-sm font-light text-primary(普通)/ brandEmphasis(链接)
- **滚动渐隐**:`CompiledEdgeFade variant="subtle" topHeight=64 bottomHeight=72 zIndex=12`
- **滚动区**:`flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pt-5 pb-8 space-y-3`
- **分隔线**:`BAMBOOK_OS.tone.divider.section` / `BAMBOOK_OS.tone.divider.panel`
- **图标**:lucide-react,size=14 strokeWidth=1.5
- **内联表单输入**:`bg-[var(--recessed-bg)] border-[var(--border-c-default)] rounded-control text-xs font-light`
- **添加按钮**:`h-6 w-6 rounded-control bg-[var(--recessed-bg)] hover:bg-[var(--active-darken)]`
- **chip**:`BAMBOOK_OS.tone.chip.data`(数据 chip)/ `BAMBOOK_OS.tone.chip.accent`(AI 标签 chip)
- **防回退**:`scripts/check-design-tokens.sh` 扫描硬编码

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-DP1 | **Detail Map 锚点导航未实现**——当前以滚动浏览为主,无左侧 TOC 锚点跳转 | 长详情页(组织布局含 10+ InfoSection)用户需手动滚动定位 | P2 |
| GAP-DP2 | 品牌线/沟通日志删除无确认弹窗(直接删除) | 误删风险 | P3 |
| GAP-DP3 | 沟通日志 direction(Inbound/Outbound)未在表单中暴露 | 全渠道流水缺少方向维度 | P3 |
| GAP-DP4 | 工厂地址列表无编辑入口(仅展示) | 工厂地址变更需跳转编辑表单 | P3 |
| GAP-DP5 | 标签(tags)展示限制 4 个,超出仅显示 `+N` | 标签多的客户无法查看完整列表 | P3 |
| GAP-DP6 | 无「复制邮箱/电话」快捷操作 | 用户需手动选中复制 | P3 |

---

## §15 相关文档索引

- [../00-索引.md](../00-索引.md) — 设计文档真源总索引
- [../04-模块设计/02-客户与开拓/Relations-联系人.md](../04-模块设计/02-客户与开拓/Relations-联系人.md) — Relations 模块概述 + 详情页设计
- [../04-模块设计/02-客户与开拓/CRM-客户跟进.md](../04-模块设计/02-客户与开拓/CRM-客户跟进.md) — CRM 跟进/商机/信用额度区块
- [RelatedEntitiesPanel.md](./RelatedEntitiesPanel.md) — EntityLink 跨模块关联面板
- [AuditHistorySection.md](./AuditHistorySection.md) — 审计 diff 展开面板
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板容器(InfoSection 底层)
- [PageHeader.md](./PageHeader.md) — 详情页顶部标题栏
- [BDS组件族7规格.md](./BDS组件族7规格.md) — CompiledSurfacePanel 原语规格
- [../01-产品总览/5. 全局交互规范.md](../01-产品总览/5.%20全局交互规范.md) — 详情页交互规范

---

## §16 补充说明

1. **双布局铁律**:DetailPanel 通过 `type='organization'|'contact'` 切换组织/联系人布局——两者共用 Header / 滚动区 / RelatedEntitiesPanel / AuditHistorySection,但 InfoSection 内容不同。组织布局含联系方式/地址/财务/CRM 区块/品牌线;联系人布局含所属组织/联系方式/个人信息/AI 标签/互动历史
2. **内联增删表单设计**:品牌线与沟通日志采用内联表单(非弹窗)——`flex items-center gap-1.5 mt-2` 紧贴列表底部,用户无需跳转即可快速添加。这是产品意图,降低全渠道流水录入门槛
3. **cancelled 守卫**:每个 useEffect 用 `cancelled` 标志防止组件卸载后 setState——避免 React 内存泄漏警告。这是 React 异步数据拉取的标准模式
4. **CompiledEdgeFade 滚动渐隐**:`variant="subtle" topHeight=64 bottomHeight=72`——滚动区顶部 64px、底部 72px 渐隐遮罩,营造内容「浮入浮出」玻璃面板的视觉感
5. **联系人双码合并**:联系人 owned 链接挂在 `relation.contact`,订单角色链接指向 `relation.person`——通过 `additionalTypes=['relation.person']` 合并两个 type code 的邻居,确保关联视图完整
6. **targetType 统一为 'Relation'**:组织与联系人共用 Relation 实体,审计日志 targetType 统一为 `'Relation'`——避免 targetType 分裂导致审计断裂
7. **Detail Map 锚点导航前瞻**:当前以滚动浏览为主,左侧 TOC 锚点跳转属于前瞻设计(GAP-DP1)。未来实现时建议复用 `OrderSectionHeader` 的 `id={section-${cluster.id}}` 锚点模式
