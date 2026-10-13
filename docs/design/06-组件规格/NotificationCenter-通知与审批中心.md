# NotificationCenter 组件规格 · 通知与审批中心

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `NotificationCenter` + `NotificationCenterTrigger` + `NotificationContext` |
| 定位 | 业务事件通知与审批中心——三视图抽屉（通知列表 / 审批中心 / 提醒偏好），铃铛按钮 + 未读徽章 + 轮询统计 + SSE 实时增量 + Electron 原生推送桥；审批中心支持待办/已办 Tab + 通过/驳回决策（驳回必填意见） |
| 文件路径 | `components/NotificationCenter.tsx`（1008 行） |
| 消费方 | `App.tsx`（挂载 `<NotificationCenter>` 包裹全局）+ `components/ui/PageHeader.tsx`（通过 `useNotificationCenter()` 消费 Context 渲染 Trigger）+ `components/Dashboard.tsx`（冻结区 Trigger） |
| 范式 | Context + Provider + Trigger + 抽屉——内部维护 `isOpen` / `stats` / `items` / `view` / `approvals` / `catalog` 等 state；乐观更新 + 失败回滚；ESC / 遮罩点击关闭 |
| 优先级 | P0（D2 主动提醒引擎 + PRD 19.21 业务审批中心，全局触达主干） |
| 实现状态 | ✅ 已落地（通知列表 + 审批中心 + 偏好面板 + SSE 实时增量 + 原生推送桥 + 转跟进 + 忽略必填原因 + 全部已读 + 删除 + 乐观更新回滚 + 401/403 降级） |
| PRD 关联 | PRD §7.1（忽略需填原因）/ §19.21（业务审批中心）/ D2（主动提醒引擎）/ §8.2（审批权限仅管理层） |
| 代码关联 | [NotificationCenter.tsx](../../components/NotificationCenter.tsx) / [apiService.ts](../../services/apiService.ts)（通知 + 审批 API）/ [types.ts](../../types.ts) `NotificationItem`（第 2967 行）/ `ApprovalRequestItem`（第 3004 行）/ `NotificationStats`（第 2980 行）/ `NotificationTypeCatalogItem`（第 2994 行）/ [bambookOsTokens.ts](../../components/ui/bambookOsTokens.ts) / [rdlBusinessStatusTokens.ts](../../components/rdlBusinessStatusTokens.ts) `statusSemanticClass` / `statusSemanticText` / `statusSemanticBg` / [PageHeader.tsx](../../components/ui/PageHeader.tsx)（Trigger 集成） |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架（Props 接口 + 渲染结构）

```ts
// ── Context ──
interface NotificationContextValue {
  isOpen: boolean;
  toggle: () => void;
  close: () => void;
  unreadCount: number;
  criticalCount: number;
  isDarkMode: boolean;
}
const NotificationContext = React.createContext<NotificationContextValue | null>(null);
export function useNotificationCenter(): NotificationContextValue | null { return React.useContext(NotificationContext); }

// ── Trigger（铃铛按钮）──
export interface NotificationCenterTriggerProps {
  className?: string;
  iconSize?: number;
  iconStrokeWidth?: number;
  /** default：56px 大圆角方块（Dashboard 冻结区沿用）；header：40px 圆形胶囊（PageHeader 标题栏节奏） */
  variant?: 'default' | 'header';
}

// ── 主组件 ──
export interface NotificationCenterProps {
  isDarkMode?: boolean;
  endpoint?: string;
  children?: React.ReactNode;
}

export function NotificationCenter({ isDarkMode = false, endpoint, children }: NotificationCenterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [stats, setStats] = useState<NotificationStats | null>(null);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [view, setView] = useState<'list' | 'prefs' | 'approvals'>('list');
  const [catalog, setCatalog] = useState<NotificationTypeCatalogItem[] | null>(null);
  const [approvalView, setApprovalView] = useState<'pending' | 'done'>('pending');
  const [approvals, setApprovals] = useState<ApprovalRequestItem[] | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState('');
  // ... 其他 state

  // 轮询统计（30s）+ SSE 实时增量 + 抽屉打开时获取列表
  // 乐观更新：标记已读 / 全部已读 / 删除 / 转跟进 / 忽略 / 审批决策

  return (
    <NotificationContext.Provider value={ctxValue}>
      {children}
      {isOpen && (
        <>
          <div className="overlay" onClick={close} />  {/* 遮罩 */}
          <div className="drawer">  {/* 抽屉主体 */}
            <Header />  {/* §6.1 */}
            {view === 'list' && <NotificationList />}     {/* §6.2 */}
            {view === 'approvals' && <ApprovalCenter />}  {/* §6.3 */}
            {view === 'prefs' && <PreferencePanel />}     {/* §6.4 */}
          </div>
        </>
      )}
    </NotificationContext.Provider>
  );
}
```

### 渲染结构

```
<NotificationContext.Provider value={ctxValue}>
  {children}  ← 全局子树（PageHeader 等通过 useNotificationCenter() 消费 Context）

  {isOpen && (
    <>
      {/* 背景遮罩（点击关闭） */}
      <div className="fixed inset-0 z-[85] bg-black/10 backdrop-blur-[1px]" onClick={close} />

      {/* 抽屉主体（右侧滑出，磨砂玻璃材质） */}
      <div className="fixed right-0 top-0 z-[90] h-full w-[420px] flex flex-col
                      rounded-l-panel border-l backdrop-blur-2xl bg-card
                      transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
           style={{ backdropFilter: 'blur(32px) saturate(1.4)' }}>
        ├─ <Header px-6 pb-4 pt-7>  ← 头部
        │   ├─ 通知/审批 Tab（list ↔ approvals 切换）
        │   ├─ 未读计数（{n} 条未读）
        │   └─ 操作按钮（全部已读 / 偏好设置 / 关闭）
        ├─ {view === 'list' && <NotificationList>}  ← 通知列表（§6.2）
        │   ├─ loading / error / empty 三态
        │   └─ items.map(通知项)
        │       ├─ 未读标记条 + 类型图标
        │       ├─ 标题 + 正文（line-clamp-2） + 相对时间
        │       ├─ 转跟进行内反馈
        │       ├─ 忽略原因行内输入（必填）
        │       └─ hover 操作按钮（转跟进 / 标记已读 / 忽略 / 删除）
        ├─ {view === 'approvals' && <ApprovalCenter>}  ← 审批中心（§6.3）
        │   ├─ 待办/已办 子视图 Tab
        │   ├─ loading / error / empty 三态
        │   └─ approvals.map(审批卡片)
        │       ├─ 标题行（上下文摘要 + 风险徽章）
        │       ├─ 双轨偏差详情（若 isPriceDeviation）
        │       ├─ 申请人 + 相对时间 + 决策意见（已办）
        │       └─ 待办操作区（通过 / 驳回展开意见输入）
        └─ {view === 'prefs' && <PreferencePanel>}  ← 偏好面板（§6.4）
            ├─ 引导文案
            └─ catalog.map(类型项)
                ├─ 类型图标 + 标签 + 已收到条数
                └─ 启用/静音开关
  )}
</NotificationContext.Provider>
```

---

## §3 Props 逐项说明

### §3.1 NotificationCenterProps

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `isDarkMode` | `boolean` | 否 | `false` | 深色模式标志，驱动 `ui` 配方集与 `statusSemanticClass` 深浅变体 |
| `endpoint` | `string` | 否 | `undefined` | API 端点覆盖（用于多实例或测试）；不传时用 `apiService` 默认端点 |
| `children` | `React.ReactNode` | 否 | — | 全局子树；`NotificationCenterTrigger` 通过 Context 消费状态，可放在任意子组件中 |

### §3.2 NotificationCenterTriggerProps

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `className` | `string` | 否 | — | 自定义类名（追加到默认类之后） |
| `iconSize` | `number` | 否 | `variant === 'header' ? 16 : 19` | 铃铛图标尺寸 |
| `iconStrokeWidth` | `number` | 否 | `1.3` | 铃铛图标描边宽度 |
| `variant` | `'default' \| 'header'` | 否 | `'default'` | `default`：56px 大圆角方块（Dashboard 冻结区）；`header`：40px 圆形胶囊（PageHeader 标题栏） |

**Trigger 渲染门禁**：`!ctx`（未在 NotificationCenter 内）时返回 null。

**徽章逻辑**：
- `unreadCount > 0` → 展示未读徽章（`criticalCount > 0` 时升级为 danger 实心灰阶 + ring）
- `unreadCount > 99` → 展示 `99+`
- `criticalCount > 0 && !isOpen` → 额外展示 `animate-ping` 脉冲圆点

---

## §4 内部常量与辅助

### §4.1 通知类型 → 图标映射（TYPE_ICON_MAP）

26 种通知类型映射到 Lucide 图标，覆盖：
- 订单：`order_confirmed` / `order_status_changed`
- 生产：`production_stage_advanced` / `production_completed`
- 出运：`shipment_created` / `shipment_status_changed` / `shipment_completed`
- 发票：`invoice_issued` / `invoice_cancelled`
- 收款：`payment_voucher_created` / `payment_received` / `payment_overdue`
- 库存：`stock_low` / `allocation_reconciled`
- Agent：`agent_message` / `briefing`
- 卡滞检测：`stuck_order` / `stuck_shipment` / `stuck_invoice` / `stuck_voucher`
- LC/退税到期：`lc_expiry` / `lc_shipment_deadline` / `lc_presentation_deadline` / `tax_refund_deadline`
- 出运延误：`shipment_delay`
- 工作流审批：`workflow_pending` / `workflow_approved` / `workflow_rejected`

### §4.2 通知级别 → 颜色映射

```ts
const levelColorFor = (level, dark) => {
  if (level === 'critical') return statusSemanticText('danger', dark);
  if (level === 'warning') return statusSemanticText('warning', dark);
  return 'text-link';   // info 保留品牌 accent 蓝
};

const levelBgFor = (level, dark) => {
  if (level === 'critical' || level === 'warning') return 'bg-[var(--recessed-bg)]';
  return dark ? 'bg-[rgb(var(--bambook-brand-link-rgb)/0.08)]' : 'bg-[rgb(var(--bambook-brand-link-rgb)/0.06)]';
};
```

- `critical` → danger 语义色 + recessed 底色
- `warning` → warning 语义色 + recessed 底色
- `info` → accent 蓝色 + 极淡蓝膜

### §4.3 相对时间格式化

```ts
function formatRelativeTime(isoString: string): string {
  // <1 分钟 → '刚刚'
  // <60 分钟 → 'X 分钟前'
  // <24 小时 → 'X 小时前'
  // <7 天 → 'X 天前'
  // ≥7 天 → toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}
```

### §4.4 ui 配方集

组件内集中声明 `ui` 对象（第 478-518 行），统一收口：
- 文字层级：`title` / `primary` / `body` / `muted` / `faint` / `ghost` / `iconEmpty`
- 已读态：`readTitle` / `readBody`
- 行 hover：`rowHover` / `rowHoverUnread`
- 卡片表面：`card` / `chipSurface`
- Tab 胶囊：`tabPillActive` / `tabPillIdle`
- 按钮：`iconBtn` / `iconBtnRow` / `textBtn` / `ghostBtn` / `semanticBtnHover`
- 输入：`input`
- 开关：`switchOff`

---

## §5 内部逻辑

### §5.1 数据获取

- **统计轮询**：`fetchStats` 每 30 秒调用 `apiService.getNotificationStats(endpoint)`；静默失败（不展示错误）
- **列表获取**：`fetchItems` 在抽屉打开时调用 `apiService.listNotifications({ limit: 50, endpoint })`
- **审批列表**：`fetchApprovals` 在 `view === 'approvals'` 时调用 `apiService.listApprovals({ status: approvalView, endpoint })`；401/403 降级为"当前账号无业务审批权限"
- **偏好目录**：`getNotificationTypeCatalog` 在 `view === 'prefs'` 时加载

### §5.2 SSE 实时增量

```ts
useEffect(() => {
  const unsubscribe = apiService.subscribeToNotifications(endpoint, (sseEvent) => {
    // 1. 增量更新统计
    setStats(prev => ({ ...prev, total: prev.total + 1, unread: prev.unread + 1, ... }));
    // 2. 桌面原生推送（warning/critical + 文档隐藏 + Electron 桥存在时）
    if (sseEvent.level !== 'info' && document.hidden && window.bambookNotification) {
      window.bambookNotification.showNative({ title, body, link });
    }
    // 3. 抽屉已打开时增量插入列表头部
    if (isOpenRef.current) {
      setItems(prev => [newItem, ...prev]);
    }
  });
  return unsubscribe;
}, [endpoint]);
```

- 用 `isOpenRef` 跟踪抽屉状态，避免 SSE 订阅因 `isOpen` 变化而重建连接
- 原生推送仅在 `document.hidden` 时触发——窗口可见时应用内徽章已足够，避免双重打扰
- Web 环境下 `window.bambookNotification` 不存在，自动跳过

### §5.3 原生推送点击回跳

```ts
useEffect(() => {
  if (!window.bambookNotification) return;
  return window.bambookNotification.onOpenLink((link) => {
    if (link) window.location.hash = link;
  });
}, []);
```

- Electron 主进程聚焦窗口后回发 link，此处执行 hash 路由跳转

### §5.4 乐观更新 + 失败回滚

所有操作都采用"乐观更新 + 失败回滚"模式：

```ts
// 标记已读
const handleMarkAsRead = useCallback(async (id) => {
  setItems(prev => prev.map(n => n.id === id ? { ...n, readAt: new Date().toISOString() } : n));
  setStats(prev => prev ? { ...prev, unread: Math.max(0, prev.unread - 1) } : prev);
  try {
    await apiService.markNotificationAsRead(id, endpoint);
  } catch {
    // 回滚
    setItems(prev => prev.map(n => n.id === id ? { ...n, readAt: null } : n));
    setStats(prev => prev ? { ...prev, unread: prev.unread + 1 } : prev);
  }
}, [endpoint]);
```

同样模式应用于：`handleMarkAllRead` / `handleDelete` / `handleTogglePreference` / `handleDismiss` / `handleDecideApproval`。

### §5.5 转跟进（幂等）

```ts
const handleConvertToFollowUp = useCallback(async (item) => {
  setFollowUpFeedback(prev => ({ ...prev, [item.id]: '创建中...' }));
  try {
    const result = await apiService.convertNotificationToFollowUp(item.id, endpoint);
    setFollowUpFeedback(prev => ({
      ...prev,
      [item.id]: result.reused ? '已建过跟进任务' : `已创建跟进（${result.nextFollowUpAt ?? '明天'}再跟进）`,
    }));
  } catch (e) {
    setFollowUpFeedback(prev => ({ ...prev, [item.id]: String(e?.message || '转跟进失败') }));
  }
}, [endpoint]);
```

- 仅当 `metadata.relationId || orderId || entityId` 存在时显示转跟进按钮
- 幂等：`result.reused` 标识已建过，行内提示"已建过跟进任务"

### §5.6 忽略（必填原因）

```ts
const handleDismiss = useCallback(async (item) => {
  const reason = dismissReason.trim();
  if (!reason) { setDismissError('请填写忽略原因'); return; }
  // 乐观移除 + 失败回滚
  // ...
  await apiService.dismissNotification(item.id, reason, endpoint);
}, [items, stats, dismissReason, endpoint]);
```

- 必填原因——用于优化推送准确率
- 行内输入框 + 确认/取消按钮 + Enter/Esc 快捷键

### §5.7 审批决策

```ts
const handleDecideApproval = useCallback(async (item, status) => {
  const note = status === 'rejected' ? rejectNote.trim() : '';
  if (status === 'rejected' && !note) return;  // 双保险
  setDecidingId(item.id);
  try {
    await apiService.decideApproval(item.id, status, note || undefined, endpoint);
    setRejectingId(null); setRejectNote('');
    fetchApprovals();  // 刷新列表
  } catch (e) {
    setApprovalsError(String(e?.message || '决策失败'));
  } finally {
    setDecidingId(null);
  }
}, [rejectNote, endpoint, fetchApprovals]);
```

- 通过：直接决策，无需意见
- 驳回：必填意见（服务端强制），展开 textarea 输入
- 决策中：`decidingId` 跟踪，按钮展示 Loader2 旋转

---

## §6 渲染规则

### §6.1 头部

- 通知/审批 Tab：`text-lg tracking-tight font-light`，选中态 `ui.title`，未选中态 `ui.tabIdle`
- 偏好面板返回按钮：`ArrowLeft` 图标 + `ui.iconBtn`
- 未读计数：`text-xs font-light ui.muted` `{n} 条未读`
- 操作按钮：全部已读（`CheckCheck`）/ 偏好设置（`Settings2`）/ 关闭（`X`），统一 `ui.iconBtn` 或 `ui.textBtn`

### §6.2 通知列表

- **loading**：`加载中...`（`ui.faint`）
- **error**：AlertTriangle 图标 + 错误信息 + 重试按钮
- **empty**：Bell 图标 + `暂无通知`
- **通知项**：
  - 容器：`rounded-control px-4 py-3.5` + 未读态 `levelBg + rowHoverUnread` / 已读态 `rowHover`
  - 未读标记条：左侧 1.5px 圆点（critical → danger，其他 → accent 蓝）
  - 类型图标：`TYPE_ICON_MAP[item.type]`，未读态 `levelColor`，已读态 `ui.ghost`
  - 标题：未读 `font-normal ui.title`，已读 `ui.readTitle`
  - 正文：`line-clamp-2 text-xs`，未读 `ui.body`，已读 `ui.readBody`
  - 相对时间：`text-[10px] font-light ui.ghost`
  - hover 操作按钮：`opacity-0 group-hover:opacity-100`——转跟进 / 标记已读 / 忽略 / 删除

### §6.3 审批中心

- **待办/已办 Tab**：`rounded-control px-3 py-1.5 text-xs font-light`，选中态 `ui.tabPillActive`，未选中态 `ui.tabPillIdle`
- **审批卡片**：`rounded-card px-4 py-3.5 ui.card`
- **标题行**：上下文摘要 + 风险徽章（`statusSemanticClass`）
  - 双轨偏差审批：展示报价单号 + 轨道 A 中位 + 轨道 B 终价 + 偏差百分比（block → danger，warn → warning）
  - 其他审批：展示 `actionType` + `targetType` + `targetId`
- **元信息**：申请人 + 相对时间 + 决策者（已办）
- **决策意见**（已办）：`rounded-control ui.chipSurface` 展示 `decisionNote`
- **待办操作区**：
  - 默认：通过按钮（`statusSemanticClass('success')`）+ 驳回按钮（`recessed-bg`）
  - 驳回展开：textarea（必填）+ 确认驳回（`statusSemanticClass('danger')`）+ 取消

### §6.4 偏好面板

- 引导文案：`关闭的类型将不再为你生成通知（不影响其他成员）`
- 类型项：`rounded-control px-4 py-3` + `rowHover`
  - 类型图标 + 标签 + 已收到条数
  - 启用/静音开关：`h-5.5 w-10 rounded-full`，启用 `bg-link/70`，关闭 `ui.switchOff`

---

## §7 四态规范

### §7.1 空态（empty）

| 视图 | 触发 | 展示 |
|---|---|---|
| 通知列表 | `items.length === 0` | Bell 图标 + `暂无通知` |
| 审批-待办 | `approvalView === 'pending' && approvals.length === 0` | Stamp 图标 + `暂无待办审批` |
| 审批-已办 | `approvalView === 'done' && approvals.length === 0` | Stamp 图标 + `暂无已办记录` |
| 偏好面板 | `!catalog || catalog.length === 0` | Bell 图标 + `暂无通知类型` |

### §7.2 加载态（loading）

| 视图 | 触发 | 展示 |
|---|---|---|
| 通知列表 | `loading && items.length === 0` | `加载中...`（`ui.faint`） |
| 审批中心 | `approvalsLoading && !approvals` | `加载中...` |
| 偏好面板 | `prefsLoading && !catalog` | `加载中...` |
| 审批决策中 | `decidingId === item.id` | 按钮内 Loader2 旋转图标 |

### §7.3 错误态（error）

| 视图 | 触发 | 展示 |
|---|---|---|
| 通知列表 | `error` 非空 | AlertTriangle + 错误信息 + 重试按钮 |
| 审批中心 | `approvalsError` 且 `!approvals` | Stamp 图标 + 错误文案（401/403 → `当前账号无业务审批权限`） |
| 忽略校验 | `!dismissReason.trim()` | `请填写忽略原因`（danger 文字） |
| 统计轮询 | `fetchStats` 失败 | 静默失败——通知不可用不应影响主界面 |

### §7.4 交互态（interactive）

| 交互 | 触发 | 反馈 |
|---|---|---|
| 点击 Trigger | `toggle()` | 抽屉滑出/收起 |
| 点击遮罩 | `setIsOpen(false)` | 抽屉关闭 |
| ESC | `keydown` | 抽屉关闭 |
| 切换 Tab | 点击"通知"/"审批" | `setView('list' / 'approvals')` |
| 进入偏好 | 点击齿轮 | `setView('prefs')` |
| 返回列表 | 偏好面板返回按钮 | `setView('list')` |
| 点击通知项 | `handleItemClick` | 标记已读 + hash 路由跳转 + 关闭抽屉 |
| 标记已读 | hover 按钮 | 乐观更新 + 失败回滚 |
| 全部已读 | 头部按钮 | 乐观更新 + 失败回滚 + fetchStats/Items 兜底 |
| 删除 | hover 按钮 | 乐观移除 + 失败回滚 |
| 转跟进 | hover 按钮（有 relationId/orderId/entityId 时） | 行内反馈"创建中... → 已创建/已建过/失败" |
| 忽略 | hover 按钮 → 展开输入 | 必填原因 + 确认/取消 |
| 审批通过 | 待办按钮 | `decideApproval(approved)` + 刷新列表 |
| 审批驳回 | 待办按钮 → 展开意见输入 | 必填意见 + 确认驳回/取消 |
| 偏好开关 | 点击开关 | 乐观更新 + 失败回滚 |

---

## §8 联动

### §8.1 上游：App.tsx（全局挂载）

- `<NotificationCenter isDarkMode={isDarkMode}>{children}</NotificationCenter>` 包裹全局子树
- `children` 内的 `PageHeader` / `Dashboard` 通过 `useNotificationCenter()` 消费 Context，渲染 `NotificationCenterTrigger`

### §8.2 同级：PageHeader / Dashboard（Trigger 集成）

- `PageHeader`：`variant="header"`，40px 圆形胶囊，融入标题栏节奏
- `Dashboard`：`variant="default"`，56px 大圆角方块（冻结区沿用）

### §8.3 下游：apiService（通知 + 审批 API）

- `getNotificationStats` / `listNotifications` / `markNotificationAsRead` / `markAllNotificationsAsRead` / `deleteNotification` / `dismissNotification` / `convertNotificationToFollowUp`
- `getNotificationTypeCatalog` / `upsertNotificationPreference`
- `listApprovals` / `decideApproval`
- `subscribeToNotifications`（SSE 订阅）

### §8.4 下游：Electron 原生推送桥

- `window.bambookNotification.showNative({ title, body, link })`——Electron preload.ts exposeInMainWorld
- `window.bambookNotification.onOpenLink(cb)`——主进程聚焦窗口后回发 link
- Web 环境下不存在，自动降级为仅应用内提醒

### §8.5 横向：CRM 跟进任务（转跟进）

- `convertNotificationToFollowUp` 创建 CRM FollowUpRecord
- 幂等：重复调用返回 `reused: true`
- 关联：`metadata.relationId` / `orderId` / `entityId` 决定是否显示转跟进按钮

### §8.6 横向：报价双轨偏差审批

- `actionType === 'quotation:price-deviation'` 的审批卡片展示双轨偏差详情
- 与 `DeviationBadge` 组件共享 `trackAEstimator.ts` 阈值常量（15% / 30%）
- 后端 `quotationService.ts` 在 `deviation.level !== 'ok'` 时自动生成 ApprovalRequest

---

## §9 状态机

### §9.1 抽屉主状态机

```
[closed] --toggle/Trigger click--> [open]
[open] --ESC/遮罩点击/toggle--> [closed]
[open] --执行通知项跳转--> [closed]（hash 路由跳转）
```

### §9.2 视图切换状态机

```
[view='list'] --点击"审批"--> [view='approvals']
[view='list'] --点击齿轮--> [view='prefs']
[view='approvals'] --点击"通知"--> [view='list']
[view='prefs'] --点击返回--> [view='list']
```

### §9.3 审批子视图状态机

```
[approvalView='pending'] --点击"已办"--> [approvalView='done']
[approvalView='done'] --点击"待办"--> [approvalView='pending']
切换时自动 fetchApprovals()
```

### §9.4 审批决策状态机

```
[空闲] --点击"驳回"--> [展开意见输入]
[展开意见输入] --输入 + 确认--> [decidingId=item.id] --API 成功--> [刷新列表] → [空闲]
[展开意见输入] --取消--> [空闲]
[空闲] --点击"通过"--> [decidingId=item.id] --API 成功--> [刷新列表] → [空闲]
```

### §9.5 通知项操作状态机

```
[已读/未读] --标记已读--> [已读]（乐观 + 回滚）
[任意] --删除--> [移除]（乐观 + 回滚）
[任意] --忽略--> [展开原因输入] --确认--> [移除]（乐观 + 回滚）
[有 relationId/orderId] --转跟进--> [行内反馈：创建中 → 已创建/已建过/失败]
[未读 + 有 link] --点击--> [标记已读 + 跳转 + 关闭抽屉]
```

### §9.6 SSE 增量状态机

```
[SSE 事件到达]
  ├─ 统计增量（total +1, unread +1, critical 若是则 +1, byType[type] +1）
  ├─ 若 level !== 'info' && document.hidden && Electron 桥存在 → 原生推送
  └─ 若抽屉已打开 → 列表头部插入新项
```

---

## §10 数据模型

### §10.1 NotificationItem（types.ts 第 2967 行）

```ts
export interface NotificationItem {
  id: string;
  userId: string;
  type: string;              // TYPE_ICON_MAP 中的 key
  title: string;
  body: string;
  level: NotificationLevel;  // 'info' | 'warning' | 'critical'
  link: string | null;       // 点击跳转的 hash 路由
  metadata: Record<string, unknown> | null;  // relationId / orderId / entityId 等
  readAt: string | null;     // null 表示未读
  createdAt: string;
}
```

### §10.2 NotificationStats（types.ts 第 2980 行）

```ts
export interface NotificationStats {
  total: number;
  unread: number;
  critical: number;
  byType: Record<string, number>;
}
```

### §10.3 NotificationTypeCatalogItem（types.ts 第 2994 行）

```ts
export interface NotificationTypeCatalogItem {
  type: string;
  label: string;
  isEnabled: boolean;
  seenCount: number;
}
```

### §10.4 ApprovalRequestItem（types.ts 第 3004 行）

```ts
export type ApprovalRequestStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequestItem {
  id: string;
  requesterId: string;
  reviewerId?: string | null;
  actionType: string;        // 如 'quotation:price-deviation'
  targetType: string;        // 如 'Quotation'
  targetId?: string | null;
  status: ApprovalRequestStatus;
  risk: string;              // 'low' | 'medium' | 'high'
  payload: Record<string, any>;  // 双轨偏差详情等
  decisionNote?: string | null;
  createdAt: string;
  decidedAt?: string | null;
  requester?: { displayName?: string; email?: string };
  reviewer?: { displayName?: string; email?: string };
}
```

### §10.5 双轨偏差 payload 字段

| 字段 | 说明 |
|---|---|
| `quotationNumber` | 报价单号 |
| `trackAMedianUsd` | 轨道 A 中位估算 USD |
| `trackAUnit` | 估算单位（PC/M） |
| `trackBFinalUsd` | 轨道 B 终价 USD |
| `deviationPercent` | 偏差百分比 |
| `level` | 偏差级别（`'warn'` / `'block'`） |

---

## §11 API

### §11.1 通知 API

| 方法 | 端点 | 用途 |
|---|---|---|
| `getNotificationStats` | `GET /api/notifications/stats` | 统计（total/unread/critical/byType） |
| `listNotifications` | `GET /api/notifications?limit=50` | 列表 |
| `markNotificationAsRead` | `POST /api/notifications/:id/read` | 标记已读 |
| `markAllNotificationsAsRead` | `POST /api/notifications/read-all` | 全部已读 |
| `deleteNotification` | `DELETE /api/notifications/:id` | 删除 |
| `dismissNotification` | `POST /api/notifications/:id/dismiss` | 忽略（需 reason） |
| `convertNotificationToFollowUp` | `POST /api/notifications/:id/convert-followup` | 转跟进（幂等） |
| `subscribeToNotifications` | `SSE /api/notifications/stream` | 实时订阅 |
| `getNotificationTypeCatalog` | `GET /api/notifications/catalog` | 类型目录 |
| `upsertNotificationPreference` | `PUT /api/notifications/preferences/:type` | 偏好开关 |

### §11.2 审批 API

| 方法 | 端点 | 用途 |
|---|---|---|
| `listApprovals` | `GET /api/v1/approvals?status=pending\|done` | 列表 |
| `decideApproval` | `POST /api/v1/approvals/:id/decide` | 决策（approved/rejected + note） |

### §11.3 鉴权

- 通知 API：JWT 鉴权（`apiService` 自动携带 token）
- 审批 API：JWT 鉴权 + 角色校验（仅管理层可访问）；401/403 降级为"当前账号无业务审批权限"

---

## §12 权限

### §12.1 通知权限

- 所有登录用户都可接收通知——通知类型由后端按角色推送
- 偏好面板允许用户静音某类通知（仅影响自己，不影响其他成员）

### §12.2 审批权限

- **仅管理层可访问审批中心**——后端 `/api/v1/approvals` 校验角色
- 401/403 降级为友好文案"当前账号无业务审批权限"，不展示重试按钮
- 审批决策（通过/驳回）由后端二次校验——前端不绕过

### §12.3 数据权限

- 通知仅返回当前用户的通知——后端按 `userId` 过滤
- 审批仅返回当前用户可见的审批——后端按角色 + 数据域过滤

---

## §13 BDS 设计系统对齐

### §13.1 三层治理

| 层 | 文件 | 本组件消费点 |
|---|---|---|
| 宪法 | `styles/os-vnext.css` | `--text-primary` / `-secondary` / `-tertiary` / `-quaternary` / `--bg-card` / `--border-c-default` / `--border-c-strong` / `--recessed-bg` / `-hover` / `-strong` / `--hover-darken` / `--active-darken` / `--bambook-bg-deep-rgb` / `--bambook-brand-link-rgb` / `--os-vnext-brand-blue` / `--accent` |
| 契约 | `styles/flat-experimental.css` | flat 四特征——无阴影 / 无 rim / 大圆角（`rounded-l-panel` 抽屉 + `rounded-card` 卡片 + `rounded-control` 行/按钮）/ 半透明膜色（`backdrop-blur-2xl` + `blur(32px) saturate(1.4)`） |
| 基线 | `tailwind.config.js` + `check-design-tokens.sh` | `rounded-l-panel` / `rounded-card` / `rounded-card-lg` / `rounded-control` / `rounded-full` 语义类 |

### §13.2 配方来源

| 配方 | 来源 | 用途 |
|---|---|---|
| `BAMBOOK_OS.controls.actionControl.base` | `bambookOsTokens.ts` | Trigger 按钮底色 |
| `statusSemanticClass(level, dark)` | `rdlBusinessStatusTokens.ts` | 语义色类（success/danger/warning） |
| `statusSemanticText(level, dark)` | 同上 | 语义文字色 |
| `statusSemanticBg(level, dark)` | 同上 | 语义背景色 |
| `bg-[var(--bg-card)]` / `dark:bg-[rgb(var(--bambook-bg-deep-rgb)/0.82)]` | CSS 变量 | 抽屉底色（亮膜/深膜） |
| `backdrop-blur-2xl` + `blur(32px) saturate(1.4)` | Tailwind + inline style | 磨砂玻璃材质 |
| `bg-link/70` | Tailwind 任意值 | 开关启用态轨道 |
| `ui.*` 配方集 | 组件内集中声明 | 文字/按钮/卡片/输入等统一收口 |

### §13.3 设计纪律

- ❌ 禁止硬编码颜色——所有颜色走 CSS 变量 `var(--*)` 或 `statusSemanticClass` / `statusSemanticText` / `statusSemanticBg`
- ❌ 禁止 `box-shadow`——flat 设计无阴影
- ❌ 禁止 `rounded-[Npx]`——用 `rounded-l-panel` / `rounded-card` / `rounded-control` / `rounded-full` 语义类
- ✅ 字重仅 `font-light`（300）/ `font-normal`（400）——未读标题用 `font-normal` 形成视觉锚点，其余统一 `font-light`
- ✅ 磨砂玻璃材质用 `backdrop-blur-2xl` + `blur(32px) saturate(1.4)`——与全局玻璃面板一致
- ✅ 抽屉过渡用 `cubic-bezier(0.22, 1, 0.36, 1)`——自然减速曲线

### §13.4 视觉特征

- **抽屉**：右侧滑出，`w-[420px] h-full rounded-l-panel`，`backdrop-blur-2xl` 磨砂玻璃
- **遮罩**：`bg-black/10 backdrop-blur-[1px]`——极淡半透明 + 微模糊
- **未读标记条**：左侧 1.5px 圆点，critical → danger，其他 → accent 蓝
- **hover 操作按钮**：`opacity-0 group-hover:opacity-100`——hover 时浮现，避免常态干扰
- **审批卡片**：`rounded-card ui.card`——二级表面层级
- **风险徽章**：`rounded-full border px-2 py-0.5` + `statusSemanticClass`——胶囊形语义色

---

## §14 缺口与后续

### §14.1 已知缺口

| ID | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-1 | 通知列表仅加载 50 条，无分页/无限滚动 | 超过 50 条历史通知不可见 | P2 |
| GAP-2 | 无通知分类筛选 | 无法按类型/级别筛选通知 | P2 |
| GAP-3 | 审批中心无批量操作 | 无法批量通过/驳回 | P3 |
| GAP-4 | 偏好面板无级别筛选 | 无法按 info/warning/critical 筛选 | P3 |
| GAP-5 | SSE 断线无自动重连 | 网络抖动时 SSE 订阅丢失，需等下次轮询 | P2 |
| GAP-6 | 无通知静默时段 | 夜间推送可能打扰 | P3 |
| GAP-7 | Trigger 的 `isDarkMode` 通过 Context 传递，但 `NotificationCenter` 的 `isDarkMode` prop 可能与全局不同步 | 主题切换时 Trigger 徽章色可能滞后 | P3 |

### §14.2 推荐扩展方向

1. **无限滚动**：通知列表底部触底加载更多（`IntersectionObserver`）
2. **分类筛选**：头部增加类型/级别筛选 chips
3. **批量审批**：审批卡片增加多选 checkbox + 批量通过/驳回按钮
4. **SSE 自动重连**：`subscribeToNotifications` 内部增加断线重连逻辑（指数退避）
5. **静默时段**：偏好面板增加"勿扰时段"设置（如 22:00-08:00 仅 critical 推送）

### §14.3 不推荐扩展

- ❌ 不在本组件内做通知生成逻辑——通知生成在后端 scheduler/watchdog
- ❌ 不在本组件内做审批规则引擎——审批规则在后端 `approvalService`
- ❌ 不在本组件内做原生通知权限管理——Electron 端权限由 `preload.ts` 处理

---

## §15 索引

### §15.1 交叉链接

- [PageHeader.md](./PageHeader.md) — 页面头部组件，集成 NotificationCenterTrigger
- [CmdK-命令面板.md](./CmdK-命令面板.md) — 全局命令面板，可快捷跳转到通知中心
- [ImportWizard.md](./ImportWizard.md) — 导入向导，导入完成后可触发通知
- [DetailPanel.md](./DetailPanel.md) — 详情面板，通知点击跳转后的目标之一
- [BDS组件族7规格.md](./BDS组件族7规格.md) — x-overlay 抽屉原语，通知抽屉的模态浮层配方源头
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板容器，抽屉材质与之同源
- [DeviationBadge.md](./DeviationBadge.md) — 双轨偏差徽章，与审批中心的 `quotation:price-deviation` 联动

### §15.2 代码真源

- 实现：[components/NotificationCenter.tsx](../../components/NotificationCenter.tsx)
- 消费方：[App.tsx](../../App.tsx)（挂载）/ [components/ui/PageHeader.tsx](../../components/ui/PageHeader.tsx)（Trigger 集成）/ [components/Dashboard.tsx](../../components/Dashboard.tsx)（冻结区 Trigger）
- 服务：[services/apiService.ts](../../services/apiService.ts)（通知 + 审批 API）
- 类型：[types.ts](../../types.ts) `NotificationItem`（第 2967 行）/ `NotificationStats`（第 2980 行）/ `NotificationTypeCatalogItem`（第 2994 行）/ `ApprovalRequestItem`（第 3004 行）
- 配方：[components/ui/bambookOsTokens.ts](../../components/ui/bambookOsTokens.ts) / [components/rdlBusinessStatusTokens.ts](../../components/rdlBusinessStatusTokens.ts)

### §15.3 设计文档关联

- [01-产品总览/4. 设计系统规范.md](../01-产品总览/4.%20设计系统规范.md) — BDS 三层治理 + flat 四特征
- [01-产品总览/1. 产品架构.md](../01-产品总览/1.%20产品架构.md) — D2 主动提醒引擎定位
