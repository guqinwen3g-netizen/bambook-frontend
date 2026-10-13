# Cockpit 经营驾驶舱 · 模块设计

## §1 元信息

| 项 | 值 |
|---|---|
| 定位 | 经营预警入口——应收应付 / 毛利 / 汇率损益 / 交付 / 样品进度等「需要行动的信号」。与全景看板（全局概览，现状冻结）、报表中心（明细与台账）定位分化，互不渗透 |
| 入口 | 桌面端导航 → 经营驾驶舱（`View.Cockpit`），App 层受控切换；首屏默认本月区间（from=本月1日 / to=今日） |
| 角色 | 销售主管、财务、系统管理员（总领导）、超级管理员（老板）为主用户；业务员、QC、后勤可读本人可见范围 |
| 范式 | 范式 C — 信息聚合首页（9 区块网格 + KPI 行 + 区间过滤工具条） |
| 优先级 | P0（Phase C1 + B2 缺口补全） |
| 实现状态 | ✅ 已落地（9 区块全部实现：销售排行 / 客户贡献 / 订单毛利 / 状态分布 / 交付预警 / 样品进度 / 汇率走势 / AR/AP 预警 / 汇兑损益汇总 + KPI 行 + 区间过滤）；⚠️ **敏感字段（成本/利润）权限遮罩逻辑当前未实现**——后端 `getBusinessCockpit` 返回全量 margin/cost 数据，前端无 scope 过滤；按 PRD §9.6 行级权限要求，需补 profit:read scope 门禁，本设计 §8 / §14 记录该缺口 |
| PRD 关联 | PRD §24.2 IA-1（首页与驾驶舱三件套定位分化） / §6.2 订单利润分析 / §9.6 角色权限矩阵（profit:read scope） / §B2 aging 与 fx-gain-loss 缺口补全 |
| 代码关联 | `components/CockpitManager.tsx`（535 行前端真源） / `server/src/dashboard/dashboardService.ts`（`getBusinessCockpit` 聚合纯函数） / `server/src/dashboard/route.ts`（`/api/v1/dashboard/cockpit` 只读端点） / `components/ui/PageHeader.tsx` / `components/rdlBusinessStatusTokens.ts`（语义色） / `types.ts` `BusinessCockpit` 及 9 子类型（第 2611–2725 行） |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 页面骨架（ASCII 线框）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ PageHeader: 经营驾驶舱 / Business Cockpit / Sales · Margin · AR-AP · FX      │
├──────────────────────────────────────────────────────────────────────────────┤
│ 工具条：[统计区间 from─至 to] [查询]                       生成于 2026-08-15 │
├──────────────────────────────────────────────────────────────────────────────┤
│ KPI 行（4 卡，xl:grid-cols-4）：                                              │
│  ┌─汇兑净收益/损失─┐ ┌─应收逾期 USD─┐ ┌─应付逾期 CNY─┐ ┌─账龄预警─┐        │
│  │ +¥12,345.00     │ │ $5,000.00     │ │ ¥8,200.00     │ │ 无未清    │        │
│  │ 86 笔核销       │ │ 未收 $20,000  │ │ 未付 ¥15,000  │ │          │        │
│  └─────────────────┘ └───────────────┘ └───────────────┘ └──────────┘        │
├──────────────────────────────────────────────────────────────────────────────┤
│ 主体网格（xl:grid-cols-2，部分 col-span-full）：                              │
│  ┌─销售业绩排行────┐ ┌─客户贡献度────────┐                                    │
│  │ 业务员×币种×5列 │ │ 客户×币种 Top10    │                                    │
│  └─────────────────┘ └────────────────────┘                                    │
│  ┌─订单毛利表（col-span-full）────────────────────────────────────────────┐  │
│  │ 订单/客户×产品×收入×成本×毛利×毛利率×回款率×交期  + 合计行             │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│  ┌─订单状态分布─┐ ┌─汇率走势──────┐                                          │
│  └──────────────┘ └───────────────┘                                          │
│  ┌─交付预警─────┐ ┌─样品进度预警─┐                                          │
│  └──────────────┘ └───────────────┘                                          │
│  ┌─应收应付预警（col-span-full）──────────────────────────────────────────┐  │
│  │ 应收逾期 TOP5  │  应付逾期 TOP5                                          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## §3 区块逐块说明

### §3.1 KPI 行（4 卡）

| KPI | 数据源 | 显示 |
|---|---|---|
| 汇兑净收益/损失 | `fxSummary.totalGainLoss` + `baseCurrency` + `rowCount` | 正数 success 绿 + TrendingUp；负数 danger 红 + TrendingDown；副标「N 笔核销」 |
| 应收逾期（按币种） | `arApAlerts.receivable.totals[]`（每个 currency 一卡） | `overdue` 金额 + 「未收合计 total」 |
| 应付逾期（按币种） | `arApAlerts.payable.totals[]` | 同上 |
| 账龄预警兜底 | `arOverdue.length === 0 && apOverdue.length === 0` | 「无未清账款」+「应收/应付均已核销」 |

### §3.2 销售业绩排行（SalesLeaderboard）

| 字段 | 显示 |
|---|---|
| 列 | 业务员 / 币种 / 订单数 / 销售额 / 已回款 / 回款率 |
| 行键 | `${salesPerson}-${currency}`（同业务员多币种分行） |
| 回款率语义 | `>=0.8` success 绿 / `>=0.5` primary / `<0.5` warning 橙 |
| 空态 | 「该期间无订单」居中 + textFaint |
| 数据模型 | `SalesLeaderboardRow`：`{ salesPerson, currency, orderCount, salesAmount, collectedAmount, collectionRate: number\|null }` |

### §3.3 客户贡献度（CustomerContribution）

| 字段 | 显示 |
|---|---|
| 行 | 客户名（含「新客」badge）+ 销售额 + 同币种占比% + 占比条 + 「币种 · N 单 · 最近下单 日期」 |
| 截断 | Top 10（`.slice(0, 10)`） |
| 占比条 | `bds-progress` + `width: ${share*100}%`（封顶 100%） |
| 新客标记 | `isNewCustomer=true` 时显示 `bds-badge sm success`「新客」 |
| 数据模型 | `CustomerContributionRow`：`{ customer, customerRelationId, currency, orderCount, salesAmount, share: 0-1, isNewCustomer, lastOrderDate }` |

### §3.4 订单毛利表（OrderMargins，col-span-full）

| 字段 | 显示 |
|---|---|
| 列 | 订单/客户 / 产品 / 收入 / 成本 / 毛利 / 毛利率 / 回款率 / 交期 |
| 成本显示 | `cost==null` → 「—」；`crossCurrency=true` → 「跨币种」（title 提示「采销币种不一致，毛利不参与合计」） |
| 毛利语义 | `margin>=0` success 绿带 `+`；`margin<0` danger 红 |
| 毛利率语义 | `marginRate>=0` primary；`marginRate<0` danger 红 |
| 合计行 | 按币种分组：「CNY 合计：收入 X · 毛利 Y（毛利率%，N 单）」+ `excludedCount`「另 N 单跨币种/缺成本未计入」 |
| 排序 | 亏损订单靠前（margin 升序），无毛利数据排最后按收入降序——服务端 `dashboardService.ts:309` 实现 |
| 行数限制 | `marginRowLimit` 默认 100，可至 500（query param 控制） |
| **敏感字段** | ⚠️ 成本/毛利/毛利率属敏感字段——见 §8 权限遮罩逻辑（当前未实现，GAP-C1） |

### §3.5 订单状态分布（OrderStatus）

| 字段 | 显示 |
|---|---|
| 行 | status × currency 分桶 + 数量 + 销售额 + 横向占比条 |
| 状态色 token | Pending=`var(--text-quaternary)` / Confirmed·Production·Shipping=`var(--accent)` / Delivered=`var(--success)` / Alert=`var(--danger)` |
| 占比条 | `width: ${count/maxCount*100}%`，`background` 跟随状态色 |
| 空态 | 「该期间无订单」 |

### §3.6 交付预警（DeliveryAlerts）

| 字段 | 显示 |
|---|---|
| 行 | poNumber / customer·product / 剩余天数 / dueDate·orderAmount |
| 截断 | Top 10 |
| 天数语义 | `<0` danger 红「逾期 N 天」/ `<=3` warning 橙「N 天」/ `>3` secondary |
| 空态 | 「7 天内无交付预警」 |
| 数据模型 | `DeliveryAlert`：`{ orderId, poNumber, customer, product, dueDate, status, daysUntilDue, currency, orderAmount }` |

### §3.7 样品进度预警（SampleProgressAlerts）

| 字段 | 显示 |
|---|---|
| 行 | caseCode·caseName / customer·product·第N轮（urgent 加「紧急」danger 红） / 逾期天数 / 目标日期 |
| 截断 | Top 10 |
| 紧急标记 | `priority==='urgent'` 显示「紧急」danger 红 |
| 空态 | 「无逾期样衣案件」 |
| 数据模型 | `SampleProgressAlert`：`{ caseId, caseCode, caseName, stage, priority, customerName, productName, currentRound, targetDate, daysOverdue, pendingSampleLevel, pendingSampleStatus }` |

### §3.8 汇率走势趋势（FxTrend）

| 字段 | 显示 |
|---|---|
| 数据 | `fxTrend.points[]`，按 currency 分组，每组折线图 |
| 折线 | SVG path，`strokeWidth=0.8` + `vectorEffect=non-scaling-stroke`；上升 success 绿 / 下降 danger 红 |
| 副标 | `currency/CNY` + 最新汇率 + 涨跌额 + 起止 effectiveDate |
| 空态 | 「暂无汇率数据」 |
| 高度 | 固定 `h` px，`preserveAspectRatio="none"` 拉伸适配 |

### §3.9 应收应付预警（ArApAlerts，col-span-full）

| 字段 | 显示 |
|---|---|
| 左右分栏 | 应收逾期 TOP5 / 应付逾期 TOP5 |
| 行 | customerName / 「90 天以上 N」或「币种 · N 张未清」 / 逾期合计（danger 红） |
| 逾期计算 | `overdue = buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90plus` |
| 90 天以上语义 | `buckets.d90plus > 0` 时副标 danger 红「90 天以上 N」 |
| 空态 | 「无逾期」 |
| 数据模型 | `AgingRow` + `AgingBuckets`（d1_30 / d31_60 / d61_90 / d90plus） |

---

## §4 模式切换

| 模式 | 触发 | 布局 |
|---|---|---|
| 默认网格 | `xl:grid-cols-2` | 销售排行 / 客户贡献 两列；毛利表 / AR/AP 预警 `col-span-full` |
| 窄屏回退 | `< xl` | `grid-cols-1`，所有区块单列堆叠 |
| 加载态 | `loading=true` | 居中 `Loader2` 旋转 + textFaint |
| 错误态 | `error!=null` | 居中 `AlertCircle` + danger 红 + 错误文案 |
| 区间变更 | 用户改 from/to 后点「查询」 | `load()` 重新拉取，loading → ready |

**区间默认值**：`from = firstDayOfMonth()`（本月1日）/ `to = today()`（今日 ISO 日期）。`useEffect(() => { load(); }, [])` 仅首载，区间变更走「查询」按钮显性触发，避免每次输入抖动重拉。

---

## §5 状态机（数据加载）

```
   mount → load() ──► loading ──success──► ready
                         │                    │
                         │ fail               │ 改 from/to + 点查询
                         ▼                    ▼
                       error ◄──────────  loading (重新拉取)
                         │
                         │ 重试（用户点查询）
                         ▼
                      loading
```

| 状态 | 字段 | 视觉 |
|---|---|---|
| `loading` | `loading=true` | 居中 `Loader2` size=18 + `animate-spin` |
| `error` | `error=String(e.message)` | `AlertCircle` size=18 + danger 红 + 错误文案 |
| `ready` | `data!=null && !loading && !error` | 9 区块网格 + KPI 行 |
| `empty` | `ready && data.*.length === 0` | 各区块内独立空态文案 |

---

## §6 数据模型（BusinessCockpit）

真源：`types.ts:2709-2725`

```ts
interface BusinessCockpit {
  from: string | null;
  to: string | null;
  generatedAt: string;                    // 服务端生成时间戳
  salesLeaderboard: SalesLeaderboardRow[];
  customerContribution: CustomerContributionRow[];
  orderMargins: {
    rows: OrderMarginRow[];
    totals: OrderMarginTotal[];
    excludedCount: number;                // 跨币种/缺成本未计入合计的订单数
  };
  orderStatusDistribution: OrderStatusBucket[];
  deliveryAlerts: DeliveryAlert[];
  sampleProgressAlerts: SampleProgressAlert[];
  fxTrend: FxTrend;
  arApAlerts: {
    receivable: { rows: AgingRow[]; totals: ArApAlertBucket[] };
    payable: { rows: AgingRow[]; totals: ArApAlertBucket[] };
  };
  fxSummary: { baseCurrency: string; totalGainLoss: number; rowCount: number };
}
```

**关键派生口径**（服务端 `dashboardService.ts`）：
- 跨币种订单 `margin=null`（采销币种不一致，避免汇率假设污染报表）
- 毛利行排序：亏损靠前暴露问题（margin 升序），无毛利数据排最后按收入降序
- AR/AP aging buckets：d1_30 / d31_60 / d61_90 / d90plus 四档
- fxSummary：核销口径净损益（baseCurrency 归一化），rowCount = 区间内核销笔数

---

## §7 API 端点清单

| 端点 | 方法 | 用途 | 参数 | 权限 |
|---|---|---|---|---|
| `/api/v1/dashboard/cockpit` | GET | 9 区块聚合数据 | `from` / `to`（YYYY-MM-DD）/ `marginRowLimit`（1-500，默认 100） | `dashboard:read`（当前未细化到 profit:read，见 GAP-C1） |

**响应**：`BusinessCockpit` JSON。**无 mutation**——纯只读聚合端点。

**鉴权**：`createModuleAuthGuard({ requireAuth, apiKeys })` 与其他 ERP 模块一致（JWT 或 API key），无角色级数据范围过滤（GAP-C1）。

---

## §8 权限矩阵（敏感字段遮罩逻辑）

> ⚠️ **当前未实现**——本节为 PRD §9.6 行级权限的设计合约，需后端补 profit:read scope 门禁。

| 角色 | 销售排行 | 客户贡献 | 订单毛利（成本/毛利/毛利率） | AR/AP 预警 | 汇兑损益 |
|---|---|---|---|---|---|
| Sales | ✅ 本人订单 | ✅ 本人客户 | ❌ 遮罩为「—」 | ❌ 不可见 | ❌ 不可见 |
| SalesManager | ✅ 本团队 | ✅ 本团队客户 | ✅ 本团队订单 | ⚠️ 仅本团队客户 | ❌ 不可见 |
| Finance | ✅ | ✅ | ❌ 遮罩为「—」 | ✅ 全公司 | ✅ |
| FinanceManager | ✅ 全公司 | ✅ 全公司 | ✅ 全公司 | ✅ 全公司 | ✅ |
| Admin / SuperAdmin | ✅ | ✅ | ✅ | ✅ | ✅ |
| Operations / Warehouse | ✅ | ❌ | ❌ | ❌ | ❌ |

**遮罩实现合约**（待落地）：
1. 后端 `getBusinessCockpit(prisma, params, authContext)` 增 `authContext` 参数，按 `profit:read` scope 决定 `orderMargins.rows[].cost/margin/marginRate` 是否返回 null
2. 前端无需改动——`cost==null` 已显示「—」，`margin==null` 已显示「—」，遮罩与缺数据共用同一渲染分支
3. 合计行同步按可见行重算 `totals`，避免遮罩行被计入合计泄漏
4. AR/AP 预警按 `ar:read` / `ap:read` scope 过滤；fxSummary 按 `fx:read` scope 过滤
5. 审计：遮罩决策写入 `auditLog`，记录「user X 访问 cockpit，margin 字段被遮罩 N 行」

**当前临时口径**：所有有 `dashboard:read` scope 的角色看到全量数据，敏感字段未遮罩——GAP-C1 必须在生产上线前修复。

---

## §9 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 空态：无订单 | 各区块 `length === 0` | 居中 + textFaint | 销售排行「该期间无订单」/ 交付「7 天内无交付预警」/ 样品「无逾期样衣案件」/ AR/AP「无逾期」 |
| 加载中 | `loading=true` | 居中 `Loader2` size=18 + `animate-spin` + textFaint | 不显示文案 |
| 错误 | `error!=null` | 居中 `AlertCircle` size=18 + danger 红 + textSecondary | `${error}`（直接展示后端错误 message） |
| 无权限 | 无 `dashboard:read` scope | 由 App 层路由拦截，Cockpit 不渲染 | 「您无权访问经营驾驶舱」 |

---

## §10 移动端设计

| 行为 | 实现 |
|---|---|
| 网格回退 | `xl:grid-cols-2` → `grid-cols-1`，所有区块单列堆叠 |
| KPI 行回退 | `xl:grid-cols-4` → `grid-cols-2`，4 卡变 2×2 |
| 区间选择器 | date input 原生触发，移动端友好 |
| 区块高度 | `min-h-[180px]` / `min-h-[200px]` / `min-h-[260px]` 保证最小可读高度 |
| 滚动 | `overflow-y-auto overscroll-contain`，区块内独立滚动避免整页抖动 |
| 触摸目标 | 表格行 `py-2` / 按钮 `bds-btn sm`，符合 44px 最小触摸目标 |

---

## §11 业务规则关联

| 规则 | 关联 | 说明 |
|---|---|---|
| 全局交互规范 | `01-产品总览/5. 全局交互规范.md` | Cmd+K 唤起命令面板；通知铃铛推送 AR/AP 逾期 |
| 信用控制规则 | `03-业务规则/信用控制规则.md` | AR aging buckets d1_30/d31_60/d61_90/d90plus 与信用控制 4 档口径一致 |
| 价格审批规则 | `03-业务规则/价格审批规则.md` | 订单毛利表暴露亏损订单，触发管理层审批关注 |
| 三件套定位分化 | `01-产品总览/1. 产品定位与愿景.md` §24.2 | Cockpit（预警）/ Dashboard（概览）/ Reports（明细）互不渗透 |
| 角色权限矩阵 | `01-产品总览/6. 角色与权限矩阵.md` | profit:read / ar:read / ap:read / fx:read scope 分档 |
| B2 aging 与 fx-gain-loss | `server/src/dashboard/dashboardService.ts` | 复用 B2 阶段的 aging 4 档与核销口径 fx 损益计算 |

---

## §12 可访问性

| 快捷键 / 行为 | 状态 |
|---|---|
| 区间 date input `aria-label` | ✅ 「开始日期」/「结束日期」 |
| 表格行键盘焦点 | ⚠️ 当前 `div` 模拟表格，未用 `<table>` 语义，屏幕阅读器无法识别为表格 |
| KPI 卡片 `aria-live` | ⚠️ 未补，区间变更后数值变化不会被朗读 |
| 高对比度 | ✅ `text-[var(--text-primary)]` 等语义 token 自适应 |
| 数字对齐 | ✅ `tabular-nums` + `bds-tnum` 全程启用 |

---

## §13 设计系统约束

- **容器**：`bds-card` + `style={{ padding: 0 }}`（区块内自定义 padding）+ `bds-filterbar`（工具条）
- **圆角**：`rounded-control`（行）/ `rounded-card`（区块），禁止硬编码 `rounded-[Npx]`
- **颜色**：`var(--text-primary/tertiary/quaternary)` / `var(--success-text)` / `var(--danger-text)` / `var(--accent)` / `var(--gauge-track)` / `var(--bg-panel)` / `var(--border-c-subtle)` 全部走 token
- **字重**：`font-light` 铁律（数值 `tabular-nums`），`text-[10px] tracking-[0.14em]` 用于 overline 标签
- **图表**：SVG path 折线 + `vectorEffect=non-scaling-stroke`；状态分布用 `var(--success/danger/accent/text-quaternary)` 语义色，禁止 hex
- **数字格式**：`formatAmount` 按 currency 加 ¥/$/€ 前缀 + `toLocaleString('zh-CN', {min:2, max:2})`；`formatPct` 返回 `—` 或 `(rate*100).toFixed(1)%`
- **防回退**：`scripts/check-design-tokens.sh` 扫描硬编码，新增违规阻断提交

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-C1 | **敏感字段（成本/利润）权限遮罩未实现**——后端返回全量 margin/cost，前端无 scope 过滤 | 无 profit:read scope 的角色看到成本数据，违反 PRD §9.6 行级权限 | **P0**（生产上线前必修） |
| GAP-C2 | 区块用 `<div>` 模拟表格，未用 `<table>` 语义 | 屏幕阅读器无法识别为表格，无障碍体验差 | P2 |
| GAP-C3 | KPI 卡片无 `aria-live` | 区间变更后数值变化不被朗读 | P2 |
| GAP-C4 | AR/AP aging buckets 无下钻到发票明细 | 用户需跳转 Finance 模块才能看到具体发票 | P2 |
| GAP-C5 | 汇率走势折线图无 hover tooltip | 用户无法看到具体日期的汇率值 | P3 |
| GAP-C6 | 订单毛利表无导出 CSV | 用户需手动复制，财务对账不便 | P2 |

---

## §15 相关文档索引

- [../00-索引.md](../../00-索引.md) — 设计文档真源总索引
- [../../01-产品总览/5. 全局交互规范.md](../../01-产品总览/5.%20全局交互规范.md) — Cmd+K / 通知铃铛 / prime 跳转
- [../../01-产品总览/6. 角色与权限矩阵.md](../../01-产品总览/6.%20角色与权限矩阵.md) — profit:read / ar:read / ap:read scope
- [../../03-业务规则/信用控制规则.md](../../03-业务规则/信用控制规则.md) — aging 4 档口径
- [../../03-业务规则/价格审批规则.md](../../03-业务规则/价格审批规则.md) — 亏损订单审批联动
- [Dashboard-首页.md](./Dashboard-首页.md) — 全景看板（与本页定位分化）
- [Reports-报表中心.md](./Reports-报表中心.md) — 明细与台账入口
- [../../04-模块设计/03-订单与生产/Pricing-定价与成本/模块概述.md](../03-订单与生产/Pricing-定价与成本/模块概述.md) — 订单利润表四维聚合口径

---

## §16 补充说明

1. **三件套定位分化铁律**：Cockpit 只展示「需要行动的信号」（预警、逾期、亏损），不展示明细行——明细行去 Reports；不展示概览指标——概览指标去 Dashboard。三者数据源不同：Cockpit 走 `/v1/dashboard/cockpit` 聚合端点，Reports 走 `/v1/reports/*` 数据集查询，Dashboard 走 App 层预加载 state
2. **跨币种订单毛利 null 口径**：`crossCurrency=true` 时 `margin=null`，避免汇率假设污染报表——这是产品铁律，与 B2 阶段 aging 口径一致。前端显示「跨币种」并 title 提示「采销币种不一致，毛利不参与合计」，合计行 `excludedCount` 透明披露未计入的订单数
3. **亏损订单靠前排序**：服务端 `dashboardService.ts:309` 按 margin 升序排序，亏损订单（margin<0）排在最前暴露问题；无毛利数据（margin=null）排最后按收入降序——这是经营预警的产品意图，让管理层第一时间看到亏损
4. **区间默认本月**：`from = firstDayOfMonth()` / `to = today()`，覆盖本月经营全貌；用户可改区间后点「查询」显性重拉，避免输入抖动重拉
5. **marginRowLimit 防爆**：默认 100 行，可至 500 行，超过 500 行的订单毛利不展示——大客户场景需走 Reports 数据集查询导出全量
6. **敏感字段遮罩临时口径风险**：当前所有有 `dashboard:read` scope 的角色看到全量 margin/cost 数据，包括 Sales 角色看到全公司成本——这是 PRD §9.6 行级权限的违反，必须在生产上线前修复（GAP-C1）。修复方案见 §8 遮罩实现合约
