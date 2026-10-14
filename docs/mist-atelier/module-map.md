# 全站模块迁移表（自动生成，勿手改）

> 由 `node scripts/gen-mist-docs.mjs` 从 `dev-ui-preview/mist-atelier/app/moduleMap.ts` 生成。**改映射请改 moduleMap.ts。**
> ☑ = 已在 `docs/mist-atelier/migrated.txt` 登记（入口文件路径，或 `view:<view>` 用于共用入口文件的模块）。
> 参考页地址：参考应用 `?view=<参考页>`，源码在 `dev-ui-preview/mist-atelier/app/pages/`。

## 模板

| 模板 | 参考页 view | 什么时候用 |
|---|---|---|
| T1 工作台 | `cockpit` | 个人首页 / 今日待办 / 焦点事项 |
| T2 列表 + 预览 | `development` | 对象有图片或需要快速预览（开发案、样品、产品） |
| T3 宽表列表 | `orders` | 纯数据记录、列多、需要排序（订单、采购单、发票） |
| T4 对象详情 | `development/detail` | 有阶段流转 + 决策 + 动态（开发案、样品、QC、索赔） |
| T5 单据详情 | `orders/detail` | 有金额、条目、履约流程（订单、报价、出运、报关） |
| T6 匹配核销 | `payment-vouchers` | 两侧数据对账（收款↔发票、装箱↔订单） |
| T7 档案详情 | `crm` | 客户 / 供应商 / 员工档案 |
| T8 看板 | `production-board` | 按状态列推进（生产、营销活动、验货任务） |
| T9 新建 / 编辑 | `development/new` | 所有新建与长表单编辑 |
| T10 设置 | `system-settings` | 系统/账号/模块配置、管理后台 |
| T11 分析报表 | `cockpit` | 统计卡 + 图表（报表中心、全景看板、利润）。图表用 recharts + toneColor() |
| T12 日历 | `cockpit` | 复用 WeekStrip + Agenda，月视图用 mist-card 网格 |
| T13 助手 | `cockpit` | 复用 AssistantDrawer 的消息/输入组件做整页 |
| 特殊可视化 | — | 地球/关系图等保留原可视化，只把外层容器换成 Card + PageHeader |

## Wave 1（6 个模块，579 行）

| ☐ | 模块 | view | 入口文件 | 行数 | 列表/主页模板 | 详情模板 | 新建 | 备注 |
|---|---|---|---|---|---|---|---|---|
| ☐ | 我的工作 | `cockpit` | `dev-ui-preview/mist-atelier/app/pages/HomePage.tsx` | 103 | T1 工作台 | — | — | 参考页即成品。数据来自 workbenchFocus / 待办接口 |
| ☐ | 开发与寻样 | `development` | `dev-ui-preview/mist-atelier/app/pages/DevListPage.tsx` | 100 | T2 列表 + 预览 | T4 对象详情 | T9 | 参考页即成品；面料寻样为第二个 Tab |
| ☐ | 样品仓库 | `samples` | `dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx` | 99 | T2 列表 + 预览 | T4 对象详情 | T9 |  |
| ☐ | 订单管理 | `orders` | `dev-ui-preview/mist-atelier/app/pages/OrderListPage.tsx` | 79 | T3 宽表列表 | T5 单据详情 | T9 | 面料订单/成衣订单用 Tabs |
| ☐ | QC 工作台 | `qc-workbench` | `dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx` | 99 | T8 看板 | T4 对象详情 | — | 验货任务=看板；报告=对象详情（MeasurementTable）；驻地/业务线配置=设置模板 |
| ☐ | 货运管理 | `shipments` | `dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx` | 99 | T3 宽表列表 | T5 单据详情 | T9 | 出运准备用 Checklist；装箱分配用 reconcile 模板 |

## Wave 2（6 个模块，423 行）

| ☐ | 模块 | view | 入口文件 | 行数 | 列表/主页模板 | 详情模板 | 新建 | 备注 |
|---|---|---|---|---|---|---|---|---|
| ☐ | 财务管理 | `payment-vouchers` | `dev-ui-preview/mist-atelier/app/pages/FinancePage.tsx` | 133 | T6 匹配核销 | T5 单据详情 | — | 收款核销=参考页；凭证列表=宽表 |
| ☐ | 发票管理 | `invoices` | `dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx` | 58 | T3 宽表列表 | T5 单据详情 | T9 |  |
| ☐ | 定价与利润 | `pricing` | `dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx` | 58 | T11 分析报表 | — | — | 计算器=表单(FormGrid)+右侧 SummaryBar；利润表/退税率/价格历史/佣金=宽表 Tabs |
| ☐ | 成本与利润核算 | `bom` | `dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx` | 58 | T3 宽表列表 | T5 单据详情 | T9 |  |
| ☐ | 风险管理与合规 | `risks` | `dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx` | 58 | T3 宽表列表 | T4 对象详情 | — | 风险等级用 Pill tone：bad/warn/ok |
| ☐ | 售后索赔 | `claims` | `dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx` | 58 | T3 宽表列表 | T4 对象详情 | T9 |  |

## Wave 3（7 个模块，640 行）

| ☐ | 模块 | view | 入口文件 | 行数 | 列表/主页模板 | 详情模板 | 新建 | 备注 |
|---|---|---|---|---|---|---|---|---|
| ☐ | 客户关系管理 | `crm` | `dev-ui-preview/mist-atelier/app/pages/CustomerPage.tsx` | 118 | T3 宽表列表 | T7 档案详情 | T9 | 客户详情=参考页 |
| ☐ | 供应商管理 | `suppliers` | `dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx` | 87 | T3 宽表列表 | T7 档案详情 | T9 |  |
| ☐ | 关系智库 | `relations` | `dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx` | 87 | T2 列表 + 预览 | T7 档案详情 | — |  |
| ☐ | 季节性与趋势 | `seasons` | `dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx` | 87 | T11 分析报表 | — | — |  |
| ☐ | 营销推广 | `marketing` | `dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx` | 87 | T8 看板 | T4 对象详情 | — | 营销活动=看板；线索=宽表；电子画册=列表+预览 |
| ☐ | 报价管理 | `quotations` | `dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx` | 87 | T3 宽表列表 | T5 单据详情 | T9 |  |
| ☐ | 数字档案 | `products` | `dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx` | 87 | T2 列表 + 预览 | T4 对象详情 | T9 | 体量最大，先迁列表与详情，模块设置页最后 |

## Wave 4（5 个模块，470 行）

| ☐ | 模块 | view | 入口文件 | 行数 | 列表/主页模板 | 详情模板 | 新建 | 备注 |
|---|---|---|---|---|---|---|---|---|
| ☐ | 生产进度 | `production-board` | `dev-ui-preview/mist-atelier/app/pages/ProductionPage.tsx` | 74 | T8 看板 | T5 单据详情 | — | 看板=参考页 |
| ☐ | 采购管理 | `procurement` | `dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx` | 99 | T3 宽表列表 | T5 单据详情 | T9 |  |
| ☐ | 库存与仓储 | `inventory` | `dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx` | 99 | T3 宽表列表 | T4 对象详情 | — |  |
| ☐ | 外贸与报关 | `customs` | `dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx` | 99 | T3 宽表列表 | T5 单据详情 | — |  |
| ☐ | 单据中心 | `document-center` | `dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx` | 99 | T2 列表 + 预览 | T5 单据详情 | — | 预览区放单据 PDF 缩略图 |

## Wave 5（11 个模块，3,031 行）

| ☐ | 模块 | view | 入口文件 | 行数 | 列表/主页模板 | 详情模板 | 新建 | 备注 |
|---|---|---|---|---|---|---|---|---|
| ☐ | 日历 | `calendar` | `dev-ui-preview/mist-atelier/app/pages/CalendarPage.tsx` | 96 | T12 日历 | — | — |  |
| ☐ | 智能邮箱 | `emails` | `components/EmailManager.tsx` | 2326 | T2 列表 + 预览 | — | — | 右侧预览=邮件正文；AI 摘要用 Banner tone=ai |
| ☐ | 全景看板 | `dashboard` | `dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx` | 58 | 特殊可视化 | — | — | 使用 Mist 统计卡与订单履约聚合，不恢复旧可视化页面 |
| ☐ | 报表中心 | `reports` | `dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx` | 58 | T11 分析报表 | — | — |  |
| ☐ | 数据中心 | `data-center` | `dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx` | 58 | T11 分析报表 | — | — | 当前工作空间的数据关联质量、记录汇总与来源入口 |
| ☐ | AI 助手 | `assistant` | `dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx` | 58 | T13 助手 | — | — |  |
| ☐ | 人事管理 | `hr` | `dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx` | 58 | T3 宽表列表 | T7 档案详情 | — | 7 个子视图用 Tabs；组织架构保留树形，外层 Card |
| ☐ | 业务工具 | `business-tools` | `dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx` | 58 | T1 工作台 | — | — | 工具入口用 CardButton 网格 |
| ☐ | 管理后台 | `admin-panel` | `dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx` | 58 | T10 设置 | — | — |  |
| ☐ | 设置 | `settings` | `dev-ui-preview/mist-atelier/app/pages/SettingsPage.tsx` | 104 | T10 设置 | — | — | 设置=参考页 |
| ☐ | 历史加工记录 | `mes` | `dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx` | 99 | T3 宽表列表 | — | — |  |
