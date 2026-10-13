# 04 · 页面模板配方（T1–T13）

全站只有这 13 种页面。**先在 [`module-map.md`](./module-map.md) 查模块用哪个模板，再打开对应参考页源码照抄结构**，只替换数据与字段。
参考页源码：`dev-ui-preview/mist-atelier/app/pages/`。打开参考应用对照：`bambook-mist-atelier-reference.html?intro=0&view=<view>`。

> 布局类（只用这些，不要自己写 grid/flex 布局 CSS）：
> `mist-grid` + `mist-col-4/6/8/12`（12 栏）、`mist-split`（表格 | 吸顶预览 340）、`mist-detail` + `mist-detail-rail`（详情三栏 292 / 自适应 / 296）、
> `mist-wizard`（步骤 240 | 表单）、`mist-section`（区块间距）、`mist-row`（横排居中）/ `mist-spacer`（推到右侧）。两栏详情用 `<div className="mist-detail" data-layout="main-rail">`。

---

## T1 工作台 · `HomePage.tsx` · `?view=cockpit`
**结构**：`PageHeader variant="greeting"`（日期 eyebrow + 问候 + 一句今日概况 + 右侧 Segmented 今天/本周 + 新建）→ `StatGrid` 4 × `StatCard`（整卡可点跳列表）→ `mist-grid`：`HeroFocus`（8 栏，当前最重要的一件事 + 阶段条 + 主按钮）| `AIBrief`（4 栏）→ `TaskList`（8 栏，接着完成）| `WeekStrip` + `Agenda`（4 栏）。
**改造要点**：问候用登录用户名；HeroFocus 取「最紧急的 1 条」；StatCard 的 `onClick` 跳到对应模块并带筛选。
**用于**：我的工作、业务工具（入口卡片版）。

## T2 列表 + 预览 · `DevListPage.tsx` · `?view=development`
**结构**：`PageHeader`（1 个 primary 新建）→ `Tabs`（同模块的子对象）→ `Toolbar`（`SearchField` + `Dropdown`×n，右侧 `Segmented` 列表/看板）→ `Pipeline`（阶段计数筛选）→ `mist-split`：`Card > DataTable`（`selectedKey`、单击预览、双击打开、`empty`、`footer` 含导出+分页）| `Card.mist-preview`（`ObjectStage` 大图 + 标题 + `Facts` + 「打开 xx」primary block 按钮）。
**看板切换**：同一份数据给 `Kanban`，`onMove` 改阶段 + toast。
**用于**：开发与寻样、样品仓库、数字档案、关系智库、单据中心、智能邮箱（预览=邮件正文）。

## T3 宽表列表 · `OrderListPage.tsx` · `?view=orders`
**结构**：`PageHeader`（导出 + 新建）→ 可选 `StatGrid` 汇总 → `Tabs` → `Toolbar` → `Card > DataTable`（全宽，首列 `ObjectCell`，金额右对齐，进度 `Meter`，状态 `Pill`，末列 `mist-go` 箭头）。
**交互**：单击行 = 打开详情（T5/T4）。列多时给 `minWidth` 横向滚动，次要列 `hideOnMobile`。
**用于**：订单、采购、货运、发票、BOM、报价、风险、索赔、CRM 客户列表、供应商、库存、报关、人事、历史加工记录。

## T4 对象详情 · `DevDetailPage.tsx` · `?view=development/detail`
**结构**：`BackLink` → `IdentityHeader`（缩略图 + meta 编号 + 标题 + facts：负责人/日期/状态 + `IconButton` 更多）→ `Card > Stepper`（阶段，当前 `now`）→ `mist-detail` 三栏：
- 左 292：`ObjectStage` + `VersionPicker` + `KeyValue`（对象事实）+ 目标说明卡
- 中：「当前阶段要做的决定」卡：eyebrow + 大标题 + 证据（`Pill`/`Mono` 链接）+ `ChoiceCards`（认可/需修改/不采用）+ `FormGrid` 字段 + `CardFooter`（草稿 + primary 保存）；下方证据卡（`MeasurementTable` / `SummaryNumbers`）
- 右 `mist-detail-rail`：`Timeline` 动态 + `RelatedList` 关联
**确认**：提交类操作弹 `Dialog`。
**用于**：开发案、样品、QC 报告、索赔、风险、库存条目、营销活动详情。

## T5 单据详情 · `OrderDetailPage.tsx` · `?view=orders/detail`
**结构**：`BackLink` → `PageHeader`（标题 = `Mono` 编号，description = 客户·批次·条目数·负责人，actions：次要文档按钮 + primary 下一步）→ `SummaryBar`（金额/数量/交期/进度）→ `Card > FlowSteps`（履约节点）→ `mist-grid`：条目 `DataTable`（8 栏）| `Checklist` 准备事项 + `Donut` 收款（4 栏）。
**用于**：订单、报价单、出运单、报关单、采购单、发票、BOM、生产单详情。

## T6 匹配核销 · `FinancePage.tsx` · `?view=payment-vouchers`
**结构**：`PageHeader`（导入 + 导出）→ `SummaryBar` → `Banner tone="ai"`（AI 匹配建议 + 全部采纳）→ `Tabs` → `mist-detail`：左 `DataTable`（待匹配的一侧，选中行）| 右「匹配到…」卡：候选列表（单选卡片，AI 置信度 `Pill tone="ai"`）+ 差额提示 + `CardFooter` 确认核销。
**用于**：收款核销、付款凭证匹配、装箱分配（订单 ↔ 箱单）、对账。

## T7 档案详情 · `CustomerPage.tsx` · `?view=crm`
**结构**：`IdentityHeader`（字母头像 Thumb + 地区/类型/编号 + 名称 + 客户经理/等级 + 写邮件 + primary 新建）→ `Tabs`（概览/订单/开发/联系人/文件）→ `StatGrid` → `Banner tone="ai"` 洞察 → `mist-detail`：主栏（订单表、进行中的开发表）| `mist-detail-rail`（`KeyValue` 档案事实、联系人列表、`Timeline`）。
**用于**：客户、供应商、关系智库人物、员工档案。

## T8 看板 · `ProductionPage.tsx` · `?view=production-board`
**结构**：`PageHeader`（`Segmented` 本周/本月 + 甘特图入口）→ 风险 `Banner tone="warn"` → `Toolbar` → `Kanban`（列 = 工序/状态；卡片：Thumb + 名称 + `Mono` 编号 + `Meter` + 工厂 + 日期 + 风险 `Pill`；`onMove` 拖拽改状态）。`MistPage width="wide"`。
**用于**：生产进度、QC 工作台、营销推广。

## T9 新建 / 编辑 · `DevCreatePage.tsx` · `?view=development/new`
**结构**：`BackLink` → `PageHeader`（右上「存为草稿」quiet）→ `mist-wizard`：左 `VerticalSteps`（240，可点跳转，完成项打勾）| 右 `Card`：可选 AI 自动填写 `Banner tone="ai"` → 每步一个 `FormSection` + `FormGrid` + `Field` → `mist-sticky-foot`（第 n/N 步 · 上一步 · primary 下一步/提交）。
**校验**：必填 `Field required`，错误 `Field error="…"`，点下一步时校验本步；最后一步 `KeyValue` 汇总确认。
**用于**：全站所有「新建 xx」与长表单编辑。≤3 个字段的快速新建用 `Dialog` + `FormGrid cols={1}`。

## T10 设置 · `SettingsPage.tsx` · `?view=system-settings`
**结构**：`PageHeader` → `mist-wizard`：左 `VerticalSteps mode="page"`（分区）| 右 `Card`：`FormSection` + `SettingRow`（标题 + 说明 + 右侧 `Switch`/`Select`/`ChoiceCards`）→ `mist-sticky-foot`（自动保存提示 + 完成）。危险项（删除工作空间）`Dialog tone="bad"`。`MistPage width="narrow"`。
**用于**：设置、管理后台、各模块配置子页。

## T11 分析报表（无独立参考页）
照 T1 的骨架：`PageHeader`（时间范围 `Segmented` + 导出）→ `StatGrid` → `mist-grid` 若干 `Card`（`CardHeader title sub tools`）内放图表 → 明细 `DataTable`。
```tsx
<Card><CardHeader title="月度下单额" sub="USD · 近 12 个月" />
  <CardBody><ResponsiveContainer height={240}><AreaChart data={d}>
    <Area dataKey="v" stroke="var(--mist-accent)" fill="var(--mist-accent-tint)" strokeWidth={1.5} />
    <XAxis dataKey="m" tick={{ fill: 'var(--mist-ink-3)', fontSize: 11 }} axisLine={false} tickLine={false} />
    <Tooltip contentStyle={{ background: 'var(--mist-card)', border: 0, borderRadius: 12 }} /> {/* mist-allow: recharts 需要 border:0 去掉默认描边 */}
  </AreaChart></ResponsiveContainer></CardBody></Card>
```
图表规则：无网格线或只留横向 `var(--mist-line)`；系列 ≤4 色（`toneColor`）；坐标轴文字 `--mist-ink-3`。
**用于**：报表中心、数据中心、定价与利润、季节性与趋势。

## T12 日历（无独立参考页）
周视图直接用 `WeekStrip` + `Agenda`（同 T1 右下）。月视图：`Card` 内 7 列 `mist-grid`，每格日期数字 + 最多 3 个事件 `Pill`，「+n」用 `TextLink` 打开当日 `Drawer`。

## T13 助手（无独立参考页）
整页版 `AssistantDrawer`：用 `MistPage width="narrow"`，消息与输入样式复用 `components/mist/ai.tsx` 的类（`mist-msg`、`mist-composer`）。打开方式保持 ⌘J 抽屉为主，整页为辅。

## 特殊可视化
全景看板（地球）、关系图谱等保留原可视化组件，只把外层换成 `MistPage` + `PageHeader` + `Card`，把可视化内部的颜色改成读取 CSS 变量（`getComputedStyle(el).getPropertyValue('--mist-accent')`）。

---

## 通用：状态页 · `StatesPage.tsx` · `?view=states`
加载、空、无结果、无权限、出错、离线、toast 的标准写法。每个模块都要覆盖。
## 通用：登录 · `LoginPage.tsx` · `?view=login`
`mist-auth` 左品牌右表单；「保持登录」默认勾选。
