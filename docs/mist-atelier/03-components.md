# 03 · 组件

- **完整 API（每个导出的 Props）**：[`api/components.md`](./api/components.md)（自动生成）
- **活的示例**：参考应用 `?view=design-system` → 「组件」Tab；每个页面模板的源码 `dev-ui-preview/mist-atelier/app/pages/*.tsx`
- 引入方式（一律从 barrel 引入，不要深路径）：

```tsx
import { Button, Card, CardHeader, DataTable, Pill, useToast, type Column } from '../components/mist'; // 相对路径按文件位置调整
```

## 通用约定
- `tone`：只有 `'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'ai'`（见 01 原则 §4/§5）。
- 图标：`lucide-react` 组件直接作为 `icon` prop 传入（`icon={Plus}`），不要自己包 `<Plus size=…/>`；独立图标用 `<Icon icon={X} size="sm" />`。
- 变体用 props，不要加 className 改样式。确实需要排版微调只用 `className="mist-row" / "mist-grid" + "mist-col-n" / "mist-spacer" / "mist-muted" / "mist-section"` 这些工具类。
- 所有浮层（Dialog / Drawer / Dropdown / CommandPalette / Toast）自动 portal 到最近的 `MistRoot`，深色自动生效。
- Dialog/Drawer/CommandPalette 打开后管理焦点、Tab 循环，最上层处理 Esc，关闭后回到触发器。Dropdown 使用方向键/Home/End 导航，Esc 返回触发器，Tab 接续真实下一控件；在模态浮层内的 portal 菜单保留所属关系，不误关宿主。

## 选型速查：旧写法 → Mist 组件

| 场景 | 旧代码里常见的样子 | 用这个 |
|---|---|---|
| 页面标题区 | `<PageHeader>`（ui/）/ 自写 h1 + 按钮 | `PageHeader eyebrow title description actions` |
| 页面容器 | `div.p-6.max-w-…` | `MistPage`（表单/设置 `width="narrow"`，看板 `width="wide"`） |
| 主操作 | `bds-btn primary`、`bg-blue-600` | `Button variant="primary"`（一屏一个） |
| 次操作 / 文字操作 | `bds-btn ghost`、`text-blue-500 hover:underline` | `Button`（默认）/ `Button variant="quiet"` / `TextLink` |
| 图标按钮 | `<button><X/></button>` | `IconButton icon={X} label="关闭"`（label 必填，用于无障碍） |
| 白色卡片 | `bg-white rounded-xl shadow border` | `Card` + `CardHeader title sub tools` + `CardBody` / `CardFooter` |
| 状态标签 | 彩色 `span` | `Pill tone="ok"` |
| 可点筛选标签 | 自写 chip | `Chip` |
| 统计卡 | 自写数字卡 | `StatGrid` + `StatCard icon label value unit delta foot spark onClick` |
| 阶段计数筛选 | 自写 tab + 数字 | `Pipeline value onChange items` |
| 数据表 | `<table>`、`divide-y` | `DataTable columns rows rowKey selectedKey onRowClick onRowDoubleClick loading empty footer` |
| 搜索 + 筛选 | 自写 input + select | `Toolbar` 包 `SearchField` + `Dropdown`，右侧 `Segmented` 视图切换 |
| Tab | 自写 tab | `Tabs`（页面级）/ `Segmented`（区块内 2–4 选项） |
| 键值信息 | `grid` + label | `KeyValue`（竖排列表）/ `Facts`（2 列小网格） |
| 图片 / 款式缩略 | `img.rounded` | `Thumb`（列表）/ `ObjectStage`（大图预览）/ `ObjectCell`（表格首列：图 + 名称 + 编号） |
| 编号 | `font-mono text-xs` | `Mono` |
| 进度 | 自写 bar | `Meter`（数值）/ `StageProgress`（第 n/5 阶段） |
| 阶段流转 | 自写 steps | `Stepper`（横向，详情页顶部）/ `FlowSteps`（单据履约）/ `VerticalSteps`（向导侧栏） |
| 动态 / 日志 | 自写列表 | `Timeline events` |
| 待办 | 自写列表 | `TaskList`（首页）/ `Checklist`（出运准备等） |
| 关联单据 | 自写链接列表 | `RelatedList` |
| 版本切换 | 自写按钮组 | `VersionPicker` |
| 单据汇总 | 自写数字条 | `SummaryBar` / `SummaryNumbers` |
| 看板 | 自写列 | `Kanban columns itemKey renderCard onMove onOpen` |
| 表单 | `label + input` 各写各的 | `FormGrid` + `Field label required hint error full` + `TextInput / TextArea / Select / Checkbox / Switch / ChoiceCards / UploadZone`，长表单分 `FormSection` |
| 设置项 | 自写行 | `SettingRow title description control` |
| 提示条 | `bds-alert`、黄色 div | `Banner tone icon title actions` |
| AI 建议 | 紫色 div | `Banner tone="ai" icon={Sparkles}` + `Button variant="ai"`，或 `AIBrief` |
| 空状态 | 自写 | `EmptyState icon title description action` |
| 加载 | spinner | `DataTable loading` / `Skeleton` |
| 确认删除 | `window.confirm` | `Dialog` + `Button variant="danger"` |
| 侧边详情 / 编辑 | 自写抽屉 | `Drawer` |
| 成功提示 | `alert`、`bdsToast` | `const toast = useToast(); toast('已保存')`、`toast('失败', 'bad')` |
| 下拉菜单 | 自写 popover | `Dropdown` |
| 头像 | dicebear img | `Avatar name` / `AvatarStack` |
| 分页 | 自写 | `Pagination page pages onChange` |
| 快捷键提示 | — | `Kbd` |

## 常见组合（直接复制）

### 卡片 + 表格
```tsx
<Card>
  <CardHeader title="条目" tools={<TextLink onClick={…}>全部订单</TextLink>} />
  <DataTable ariaLabel="条目" columns={columns} rows={rows} rowKey={r => r.id}
    onRowClick={r => open(r)} loading={loading}
    empty={<EmptyState icon={SearchX} title="没有符合条件的记录" description="试试清除筛选" />}
    footer={<span>{rows.length} 条</span>} />
</Card>
```

### 列定义
```tsx
const columns: Column<Order>[] = [
  { key: 'obj', header: '订单', width: 'minmax(220px,2fr)', sortValue: o => o.id,
    render: o => <ObjectCell thumb={<Thumb src={o.img} />} name={<Mono>{o.id}</Mono>} meta={`${o.customer} · ${o.season}`} /> },
  { key: 'amt', header: '金额', width: '110px', align: 'right', sortValue: o => o.amount,
    render: o => <><b className="mist-cell-strong">{fmt(o.amount)}</b><span className="mist-cell-sub">{o.currency}</span></> },
  { key: 'state', header: '状态', width: '110px', render: o => <Pill tone={o.tone}>{o.state}</Pill> },
];
```

### 危险操作确认
```tsx
<Dialog open={open} onClose={() => setOpen(false)} tone="bad" icon={Trash2} title="删除这个开发案？" description="删除后无法恢复。"
  footer={<><Button onClick={() => setOpen(false)}>取消</Button><Button variant="danger" onClick={doDelete}>删除</Button></>} />
```

### 加载失败
```tsx
<Banner tone="bad" icon={AlertTriangle} title="数据加载失败" actions={<Button size="sm" icon={RefreshCw} onClick={retry}>重试</Button>}>
  {error.message}
</Banner>
```

## 业务状态 → tone 对照（全站统一）

| 业务状态 | tone |
|---|---|
| 已完成 / 已通过 / 已核销 / 已出运 / 已签收 / 已留档 | `ok` |
| 待确认 / 待评审 / 待复验 / 临近交期 / 部分完成 | `warn` |
| 逾期 / 不通过 / 未认领 / 风险高 / 失败 / 缺资料 | `bad` |
| 进行中 / 生产中 / 当前阶段 | `accent` |
| AI 建议 / AI 匹配 | `ai` |
| 草稿 / 未开始 / 已取消 / 其它 | `neutral` |

把各模块已有的状态枚举映射成上表，写成一个 `xxxTone(status): Tone` 函数放在模块目录里，不要散落在 JSX 里。
