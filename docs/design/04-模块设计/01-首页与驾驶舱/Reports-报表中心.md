# Reports 报表中心 · 模块设计

## §1 元信息

| 项 | 值 |
|---|---|
| 定位 | 明细与台账入口——自助数据集查询 / 定义 / 运行 / 导出。与全景看板（全局概览，现状冻结）、经营驾驶舱（经营预警）定位分化，互不渗透 |
| 入口 | 桌面端导航 → 报表中心（`View.Reports`），三 tab：报表设计器 Designer / 我的报表 Saved / 运行历史 Runs |
| 角色 | 销售主管、财务、系统管理员（总领导）、超级管理员（老板）为主用户；业务员可读本人可见数据集范围 |
| 范式 | 范式 A — 三 tab 切换：Designer（设计器）+ Saved（定义列表）+ Runs（运行历史） |
| 优先级 | P1（阶段 A5 报表引擎前端） |
| 实现状态 | ✅ 已落地（设计器：数据集选择 → 维度/指标/过滤配置 → 临时预览 ≤500 行 → 保存为定义；我的报表：启停 / 定时周期 / 立即运行 / 编辑 / 删除；运行历史：状态 / 触发方式 / 行数 / 耗时 + 快照结果展开 + CSV 导出；A5d 下钻：聚合行 → 组成员实体明细抽屉 + 跨模块导航）；⚠️ 订阅推送（邮件/IM 推送）未实现，当前仅站内 Runs 列表查看 |
| PRD 关联 | PRD §24.2 IA-1（首页与驾驶舱三件套定位分化） / §A5 报表引擎 / §A5d 下钻联动 / §9.6 角色权限矩阵 |
| 代码关联 | `components/ReportCenter.tsx`（1300+ 行前端真源） / `services/reportService.ts`（`ReportDatasetSpec / ReportDefinition / ReportRun / ReportPreviewResult / ReportDrillResult` 类型 + API 封装） / `components/RelatedEntitiesPanel.tsx`（下钻抽屉关联实体） / `components/rdlBusinessStatusTokens.ts`（statusSemanticClass） / `components/ui/PageHeader.tsx` / 后端 `server/src/reports/` 数据集注册表 + 引擎 |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 页面骨架（ASCII 线框）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ PageHeader: 报表中心 / Report Center / Analytics              [刷新]        │
├──────────────────────────────────────────────────────────────────────────────┤
│ Tab 导航：[📊 报表设计器 Designer] [💾 我的报表 Saved (3)] [▶ 运行历史 Runs] │
├──────────────────────────────────────────────────────────────────────────────┤
│ 错误横幅（可选）：danger 红边框 + 错误文案 + [×]                            │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│ ▼ Designer tab                                                               │
│  ┌─ 设计器 ──────────────────────────────────────────────────────────────┐ │
│  │ 名称 [____]  描述 [____]  数据集 [orders ▼]  定时 [每日 ▼]            │ │
│  │ ── 维度（chips 多选）──                                                │ │
│  │ [poNumber] [customer] [status] [salesPerson] ...                      │ │
│  │ ── 指标（agg + field）──                                               │ │
│  │ [sum: quoteAmount] [count: *] [avg: quoteAmount]                      │ │
│  │ ── 过滤（field + op + value）──                                        │ │
│  │ [status eq Confirmed] [quoteAmount gte 10000]                         │ │
│  │ ── 预览（≤500 行）──  [预览]                                           │ │
│  │ ┌─ 结果表 ─────────────────────────────────────────────────────────┐ │ │
│  │ │ poNumber | customer | sum:quoteAmount | count:*  ← 行可下钻       │ │ │
│  │ └──────────────────────────────────────────────────────────────────┘ │ │
│  │ [保存为定义]                                                          │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ▼ Saved tab                                                                  │
│  ┌─ 定义卡片 ───────────────────────────────────────────────────────────┐ │
│  │ 报表名 · 数据集 · 维度/指标摘要  [启用●] [每日] [运行] [编辑] [删除]  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ▼ Runs tab                                                                   │
│  ┌─ 运行记录 ───────────────────────────────────────────────────────────┐ │
│  │ ▸ 报表名 · 状态[Success] · 手动 · 234 行 · 1.2s · 2026-08-15 14:30  │ │
│  │   展开：快照结果表 + [导出 CSV] [跳转实体模块]                       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘

  A5d 下钻抽屉（右侧滑出）：
  ┌──────────────────────────────┐
  │ 聚合行 → 组成员实体明细      │
  │ ─────                         │
  │ 实体列表（orders/invoices…）  │
  │ [跳转实体所属模块 →]          │
  └──────────────────────────────┘
```

---

## §3 区块逐块说明

### §3.1 报表设计器 Designer

| 区块 | 说明 |
|---|---|
| 元信息 | 名称 / 描述 / 数据集（dropdown，来自 `reportService.listDatasets()`）/ 定时周期（'' / daily / weekly / monthly） |
| 维度选择 | chips 多选，来自当前数据集的 `dimensions` 字段元数据 |
| 指标配置 | agg（sum/avg/min/max/count）+ field，可添加多条 |
| 过滤配置 | field + op（eq/ne/in/gte/lte/contains）+ value；op 由 `opsForField(field.type)` 引导（number/date→eq/ne/gte/lte；enum→eq/ne/in；其他→eq/ne/in/contains） |
| 临时预览 | 调 `reportService.previewReport(input)` 返回 `ReportPreviewResult`，**≤500 行**防止大结果集卡顿 |
| 行下钻 | 聚合结果行点击触发 `handleDrill`，提取维度组约束打开下钻抽屉 |
| 保存 | 调 `reportService.createDefinition` 或 `updateDefinition`，回写 definitions 列表 + 重置 designer |

### §3.2 我的报表 Saved

| 操作 | 说明 |
|---|---|
| 启停 | `handleToggleEnabled` → `updateDefinition({ enabled: !def.enabled })`；停用后定时任务不触发 |
| 定时周期 | 显示 `SCHEDULE_LABELS[def.schedule]`（每日/每周/每月） |
| 立即运行 | `handleRunDefinition` → `runDefinition(def.id)`；完成后刷新 definitions + runs |
| 编辑 | `handleEditDefinition` 载入设计器（`setActiveTab('designer')`） |
| 删除 | `handleDeleteDefinition` 二次确认（`window.confirm`）→ `deleteDefinition`；历史运行记录保留 |
| 新建 | 「新建报表」按钮 → 重置 designer + 切到 designer tab |
| 数量徽章 | tab 标签显示 `definitions.length`（saved tab 专属） |

### §3.3 运行历史 Runs

| 字段 | 说明 |
|---|---|
| 列表项 | 报表名 · 状态 · 触发方式 · 行数 · 耗时 · 时间戳 |
| 状态 | Running（info 蓝）/ Success（success 绿）/ Failed（danger 红）—— `RUN_STATUS_SEMANTIC` 映射 |
| 触发方式 | manual（手动）/ schedule（定时）—— `TRIGGER_LABELS` 映射 |
| 展开 | 展开查看快照结果表 + 导出 CSV + 跳转实体模块（A5d 下钻） |
| 导出 CSV | `reportService.exportRunCsv(runId)` 下载 |
| 刷新 | 按 definitionId 过滤刷新（`listRuns(definitionId, 100)`） |
| 上限 | 100 条最近运行 |

### §3.4 A5d 下钻抽屉 DrillDrawer

| 属性 | 说明 |
|---|---|
| 触发 | Designer 预览结果行点击 / Runs 快照结果行点击 |
| 输入 | `DrillRequest { input: 报表查询规格, group: 维度组约束 }` |
| 维度组提取 | `groupFromRow(dimensions, row)`：维度列缺失/undefined 归一为 null，与服务端 groupBy 空值组口径一致 |
| 数据源 | `reportService.drillDown(input, group)` 返回 `ReportDrillResult` |
| 关联实体 | `RelatedEntitiesPanel` 展示组成员关联实体 |
| 跨模块导航 | `DATASET_NAV_TARGETS` 映射数据集 → View + tab：orders→Orders / invoices→Invoices·invoices / paymentVouchers→PaymentVouchers·vouchers / shipments→Shipments / vatInvoices→Invoices·vatInvoices / outwardRemittances→PaymentVouchers·vouchers / taxRefunds→Customs·taxRefunds |
| 关闭 | 遮罩点击 / Esc / 关闭按钮 |

### §3.5 订阅推送（前瞻设计，未实现）

> **状态**：⚠️ 待落地——当前定时报表仅在服务端 Runs 表生成记录，用户需主动进 Runs tab 查看；邮件/IM 推送未实现。

| 推送渠道 | 触发 | 状态 |
|---|---|---|
| 站内 Runs 列表 | 定时任务完成后自动刷新（用户主动进 tab） | ✅ |
| 邮件推送 | 定时任务完成 + 报表定义绑定邮箱 | ❌ 未实现 |
| 飞书 IM 推送 | 定时任务完成 + 报表定义绑定飞书群 | ❌ 未实现 |
| 通知中心 | 定时任务完成生成 Notification | ❌ 未实现 |

---

## §4 模式切换

| 模式 | 触发 | 行为 |
|---|---|---|
| Designer | `activeTab='designer'` | 设计器面板，含元信息 + 维度/指标/过滤配置 + 预览 + 保存 |
| Saved | `activeTab='saved'` | 定义列表，含启停 / 运行 / 编辑 / 删除 |
| Runs | `activeTab='runs'` | 运行历史列表，含展开快照 + 导出 CSV + 下钻 |
| 编辑模式 | Saved tab 点「编辑」 | 载入定义到 designer + 切到 designer tab |
| 新建模式 | Saved tab 点「新建报表」 | 重置 designer（保留 datasetKey）+ 切到 designer tab |
| 下钻模式 | 任意 tab 触发行点击 | 右侧抽屉滑出，显示组成员明细 |

Tab 切换通过 `setActiveTab(id)` 实现，定义列表数量徽章实时同步。

---

## §5 状态机（运行 + 定时）

### §5.1 报表运行流

```
   idle ──点运行──► Running ──成功──► Success (含快照)
                       │
                       │ 失败
                       ▼
                    Failed (含错误信息)
```

| 状态 | 字段值 | 触发 | 后续 |
|---|---|---|---|
| `Running` | `status='Running'` | 手动「立即运行」/ 定时任务触发 | 引擎异步执行 |
| `Success` | `status='Success'` | 引擎完成 + 快照落库 | 进 Runs 列表，可展开 / 导出 / 下钻 |
| `Failed` | `status='Failed'` | 引擎异常 / 数据集不可用 | 进 Runs 列表，显示错误信息 |

### §5.2 定义生命周期

```
   create ──► enabled=true ──停用──► enabled=false ──启用──► enabled=true
                  │                                                │
                  │ 删除                                           │ 删除
                  ▼                                                ▼
              deleted (历史 runs 保留)                    deleted (历史 runs 保留)
```

---

## §6 数据模型

真源：`services/reportService.ts` + `types.ts`

```ts
type ModuleTab = 'designer' | 'saved' | 'runs';

// 数据集元数据（服务端注册表）
interface ReportDatasetSpec {
  key: string;              // orders / invoices / paymentVouchers / shipments / vatInvoices / outwardRemittances / taxRefunds
  label: string;
  fields: ReportFieldSpec[]; // 维度 + 指标字段
}

interface ReportFieldSpec {
  key: string;
  label: string;
  type: 'number' | 'date' | 'enum' | 'string';
  allowedOps: ReportFilterOp[];
}

// 报表定义
interface ReportDefinition {
  id: string;
  name: string;
  description?: string;
  datasetKey: string;
  dimensions: string[];
  metrics: ReportMetricSpec[];      // { field, agg }
  filters?: ReportFilterSpec[];     // { field, op, value }
  schedule?: ReportSchedule;        // daily / weekly / monthly
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// 运行记录
interface ReportRun {
  id: string;
  definitionId: string;
  status: 'Running' | 'Success' | 'Failed';
  trigger: 'manual' | 'schedule';
  rowCount?: number;
  durationMs?: number;
  snapshot?: Record<string, string | number | null>[];  // 快照结果
  error?: string;
  startedAt: number;
  finishedAt?: number;
}
```

**字段元数据铁律**：所有字段元数据来自服务端数据集注册表（`/datasets`），**前端不硬编码字段清单**——这是产品铁律，确保新增数据集无需前端发版。

**聚合口径铁律**：聚合口径以后端为准，**前端不做任何数值计算**（仅展示）——避免前后端口径不一致。

---

## §7 API 端点清单

| 端点 | 方法 | 用途 | 权限 |
|---|---|---|---|
| `/v1/reports/datasets` | GET | 数据集注册表（字段元数据） | `reports:read` |
| `/v1/reports/definitions` | GET / POST | 定义列表 / 创建定义 | `reports:read` / `reports:write` |
| `/v1/reports/definitions/:id` | GET / PATCH / DELETE | 查 / 改 / 删定义 | `reports:read` / `reports:write` |
| `/v1/reports/definitions/:id/run` | POST | 立即运行定义 | `reports:run` |
| `/v1/reports/preview` | POST | 临时预览（≤500 行） | `reports:read` |
| `/v1/reports/runs` | GET | 运行历史列表（可按 definitionId 过滤） | `reports:read` |
| `/v1/reports/runs/:id` | GET | 运行详情（含快照） | `reports:read` |
| `/v1/reports/runs/:id/export` | GET | 导出 CSV | `reports:read` |
| `/v1/reports/drill` | POST | A5d 下钻（聚合行 → 组成员明细） | `reports:read` |

---

## §8 权限矩阵

| 角色 | 看定义 | 创建/编辑定义 | 立即运行 | 看运行历史 | 导出 CSV | 下钻 |
|---|---|---|---|---|---|---|
| Sales | ✅ 本人创建的 | ✅ | ✅ | ✅ 本人创建的 | ✅ | ✅（数据范围受限） |
| SalesManager | ✅ 本团队 | ✅ | ✅ | ✅ 本团队 | ✅ | ✅（本团队数据） |
| Finance / FinanceManager | ✅ 全公司 | ✅ | ✅ | ✅ 全公司 | ✅ | ✅ |
| Admin / SuperAdmin | ✅ 全公司 | ✅ | ✅ | ✅ 全公司 | ✅ | ✅ |
| Operations / Warehouse | ✅ 履约相关数据集 | ⚠️ 仅履约 | ✅ | ✅ 履约相关 | ✅ | ✅（履约数据） |

> **铁律**：数据范围按角色 scope 过滤——Sales 只看本人订单数据，SalesManager 看本团队，Finance 看全公司财务数据。下钻跳转实体模块时同样受目标模块的 scope 限制。

---

## §9 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 空态：无定义 | `definitions.length === 0`（Saved tab） | 居中插画 + textSecondary + 「新建报表」按钮 | 「暂无报表定义，点击新建第一份」 |
| 空态：无运行 | `runs.length === 0`（Runs tab） | 居中插画 + textSecondary | 「暂无运行记录」 |
| 空态：无预览 | `designer` 未点预览 | 占位 + textSecondary | 「配置维度与指标后点击预览」 |
| 加载中 | `loading=true`（首载） | 居中 `Loader2` size=16 + `animate-spin` + textSecondary | 「加载报表元数据…」 |
| 错误 | `error != null` | 顶部 danger 红边框 + 错误文案 + [×] 关闭 | `${error}`（如「运行失败：xxx」） |
| 无权限 | 无 `reports:read` scope | 由 App 层路由拦截 | 「您无权访问报表中心」 |
| 运行中 | `run.status='Running'` | info 蓝徽章 + `Loader2` | 「运行中」 |
| 运行成功 | `run.status='Success'` | success 绿徽章 | 「成功」+ 行数 + 耗时 |
| 运行失败 | `run.status='Failed'` | danger 红徽章 | 「失败」+ 错误信息 |

---

## §10 移动端设计

| 行为 | 实现 |
|---|---|
| Tab 导航 | `flex-wrap` 自适应换行，窄屏堆叠 |
| 设计器表单 | `grid grid-cols-2` → 窄屏 `grid-cols-1` |
| 预览结果表 | ⚠️ 当前未做横向滚动，窄屏列会挤压 |
| 定义卡片 | 单列堆叠，操作按钮 `flex-wrap` |
| 运行历史展开 | 展开/折叠用 `ChevronDown` / `ChevronRight` 切换 |
| 下钻抽屉 | ⚠️ 当前右侧抽屉在窄屏会挤占主区，需改为底部 Sheet |

---

## §11 业务规则关联

| 规则 | 关联 | 说明 |
|---|---|---|
| 全局交互规范 | `01-产品总览/5. 全局交互规范.md` | 下钻抽屉跨模块导航复用 prime 跳转模式 |
| 三件套定位分化 | `01-产品总览/1. 产品定位与愿景.md` §24.2 | Reports（明细）/ Dashboard（概览）/ Cockpit（预警）互不渗透 |
| 角色权限矩阵 | `01-产品总览/6. 角色与权限矩阵.md` | reports:read / reports:write / reports:run scope |
| 数据集注册表 | `services/reportService.ts` | 字段元数据服务端真源，前端不硬编码 |
| 聚合口径 | 后端引擎 | 聚合以后端为准，前端仅展示，不做本地计算 |

---

## §12 可访问性

| 快捷键 / 行为 | 状态 |
|---|---|
| Tab 键焦点 | ✅ tab 按钮 / chips / 表单元素原生可聚焦 |
| 预览结果表 `<table>` 语义 | ✅ 用 `<table>` 标签，屏幕阅读器可识别 |
| 下钻抽屉 Esc 关闭 | ⚠️ 未补焦点陷阱 + Esc 监听 |
| 错误横幅 `role="alert"` | ⚠️ 未补 |
| 行下钻 `aria-label` | ⚠️ 未补，仅靠点击行为 |

---

## §13 设计系统约束

- **容器**：`cardClass = 'rounded-card border border-[var(--border-c-subtle)] bg-[var(--hover-darken)]'`
- **圆角**：`rounded-card`（卡片）/ `rounded-control`（表单）/ `rounded-full`（tab 按钮 / chips）/ `rounded-inset`（错误横幅 / 展开区），禁止硬编码
- **颜色**：`var(--text-primary/tertiary/secondary)` / `var(--border-c-subtle/default)` / `var(--bg-card)` / `var(--hover-darken)` / `var(--recessed-bg)` / `var(--os-vnext-brand-blue)` / `var(--active-darken)` 全部走 token；状态色走 `statusSemanticClass` 语义映射
- **字重**：`font-light` 铁律；overline `text-[10px] tracking-[0.14em]`
- **tab 按钮**：选中态 `bg-[var(--os-vnext-brand-blue)] text-white`；非选中 `bg-[var(--recessed-bg)] text-[var(--text-secondary)] hover:bg-[var(--active-darken)]`
- **chips**：选中态同 tab 按钮；非选中 `border-[var(--border-c-default)] text-[var(--text-tertiary)] hover:bg-[var(--recessed-bg-hover)]`
- **数字对齐**：`tabular-nums` 用于行数 / 耗时等数值列
- **防回退**：`scripts/check-design-tokens.sh` 扫描硬编码

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-R1 | **订阅推送未实现**（邮件 / 飞书 IM / 通知中心） | 定时报表需用户主动进 tab 查看，错过时效 | P1 |
| GAP-R2 | 下钻抽屉无 Esc 关闭 + 焦点陷阱 | 键盘导航体验不完整 | P2 |
| GAP-R3 | 预览结果表窄屏未做横向滚动 | 移动端多列报表挤压不可读 | P2 |
| GAP-R4 | 下钻抽屉窄屏未改为底部 Sheet | 移动端抽屉挤占主区 | P2 |
| GAP-R5 | 错误横幅无 `role="alert"` | 屏幕阅读器无法及时获知错误 | P2 |
| GAP-R6 | 行下钻无 `aria-label` | 屏幕阅读器无法识别下钻意图 | P2 |
| GAP-R7 | 定时任务时区未显性配置 | 跨时区团队定时触发时间歧义 | P3 |

---

## §15 相关文档索引

- [../00-索引.md](../../00-索引.md) — 设计文档真源总索引
- [../../01-产品总览/5. 全局交互规范.md](../../01-产品总览/5.%20全局交互规范.md) — prime 跳转模式（下钻跨模块导航复用）
- [../../01-产品总览/6. 角色与权限矩阵.md](../../01-产品总览/6.%20角色与权限矩阵.md) — reports:read / write / run scope
- [../../01-产品总览/1. 产品定位与愿景.md](../../01-产品总览/1.%20产品定位与愿景.md) — 三件套定位分化
- [Dashboard-首页.md](./Dashboard-首页.md) — 全景看板
- [Cockpit-经营驾驶舱.md](./Cockpit-经营驾驶舱.md) — 经营预警入口
- [DataCenter-数据中心.md](./DataCenter-数据中心.md) — 知识库看板与数字孪生
- [../../04-模块设计/03-订单与生产/Pricing-定价与成本/模块概述.md](../03-订单与生产/Pricing-定价与成本/模块概述.md) — 订单利润表四维聚合口径（与报表中心数据集互补）

---

## §16 补充说明

1. **三件套定位分化铁律**：Reports 只展示「明细与台账」，不展示概览指标（去 Dashboard）、不展示预警信号（去 Cockpit）。数据源不同：Reports 走 `/v1/reports/*` 数据集查询引擎，Dashboard 走 App 层 state，Cockpit 走 `/v1/dashboard/cockpit` 聚合端点
2. **字段元数据服务端真源**：所有字段元数据来自服务端数据集注册表（`/datasets`），前端不硬编码字段清单——这是产品铁律，确保新增数据集无需前端发版。`opsForField` 仅做客户端引导，服务端 `fieldAllowedOps` fail-closed 兜底
3. **聚合口径后端为准**：聚合以后端引擎为准，前端不做任何数值计算（仅展示）——避免前后端口径不一致。预览 ≤500 行防止大结果集卡顿，全量数据需走 Runs 导出 CSV
4. **下钻空值组口径**：`groupFromRow` 将维度列缺失/undefined 归一为 null，与服务端 groupBy 空值组口径一致——避免下钻时维度值 null 与 undefined 分裂成两组
5. **跨模块导航映射**：`DATASET_NAV_TARGETS` 硬编码 7 个数据集 → View+tab 映射，新增数据集需同步补充映射（GAP-R7 关联）
6. **历史运行记录保留**：删除定义时不删除历史 Runs 记录——审计需求，确保已生成的报表快照可追溯
7. **定时任务未做时区配置**：当前定时任务按服务端时区触发，跨时区团队需显性配置时区（GAP-R7）
