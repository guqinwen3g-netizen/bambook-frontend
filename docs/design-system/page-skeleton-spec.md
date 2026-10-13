# 页面骨架六区强制规格（Page Skeleton Spec）

> **版本**：v1.0 草案（2026-08-17，CD-007/CD-008/CD-009 落地）
> **地位**：BDS v2.2 页面层强制规格。tokens.css 管原子、components.css 管元件、
> component-application-spec.md 管语境选型、**本规格管页面骨架六区的强制构成**。
> **效力**：总控审定后生效，30 页逐页销号（W-PG）的唯一对照真源；
> 机器断言（check:tokens §10.3）与人工双轨验收均以本文为准。
> **关联**：纪律文档 §10.1/§10.2/§10.3；评审报告批 A-J 清单；W3-W4 任务书。

---

## §0 总则

### 0.1 适用范围
- 全部业务页面（30 页台账口径，`page-consistency-ledger.md` 逐页登记）。
- **compiled 双路径铁律**：Relations / Products / Settings 的实际渲染源是
  compiled 版本（compiledRelationsTemplates / compiledProductsTemplates / compiledSettingsTemplates），
  本规格收编动作只落 compiled 版本；Manager 文件仅作类型与逻辑参考。
- `CompiledMainModuleSlot` className="contents" 为透明包裹器，不算一区。

### 0.2 冻结与豁免（全会话禁碰）
- `App.tsx`（W5 S-ARCH 独占）、GarmentOrders 死代码（W5 移交）、移动端冻结区
  （`pwa/`、`md:hidden`、`isMobile` 分支、移动端卡片视图）。
- 豁免清单：3D 地球 WebGL / macOS 三色灯 / 品牌 SVG / 邮件与发票 HTML 模板 / PandaLab。
- 白名单：规格中标注「白名单注释豁免」的场景，须在同一行/相邻注释登记原因，
  格式见附录 B，机器断言据此放行；无注释白名单 = 违例。

### 0.3 术语
- **一区**：页面骨架的六个功能区域之一（标题/筛选/操作/表单控件/内容/弹层）。
- **主刀**：对单页面一次性完成六区全维收编的动作（非多点碎修）。
- **销号**：台账「验收状态」列由总控签字置为 ✅。

---

## §1 标题区（Page Title Zone）

| 项 | 强制标准 |
|---|---|
| 容器 | 统一 `PageHeader` 组件（`components/ui/PageHeader.tsx`）或 `bds-pagehead` 类 |
| 间距 | `px-7 pt-5 pb-4`，全部页面一致，禁止页面级自定义覆写 |
| 标题 | 中英双语：中文主标题 + `.en` 英文副标；`font-weight ≤300` |
| 截断 | 标题与状态文字**禁止换行**，超出 `truncate` 省略截断 |
| 面包屑 | 右置（`ph-side` 区），左上角只放标题 |
| 通知按钮 | Dashboard 同款大按钮：`h-14 w-14 rounded-card-lg`、Bell size=19 strokeWidth=1.3、数字气泡外扩 `-right-1 -top-1`；每页 ≤2 |
| 主操作 | 收进 PageHeader `actions` 区最右侧（H2 裁决）；无 PageHeader 页面放工具行左端 |
| center 槽 | **禁止在 PageHeader center 槽塞入 filterbar + toggle 形成双行结构**（点名问题②）；center 槽只允许单行内容，筛选控件一律下移到独立筛选区行 |

**机器断言**：每个 `*Manager.tsx` 必须含 `PageHeader` 或 `bds-pagehead`（清单断言）。

---

## §2 筛选区（Filter Zone）— filterbar 选型规则（已固化）

### 2.1 选型决策树（三选一，禁止第四形态）

```
行内除搜索外是否还有其他功能控件（下拉/分段/日期/按钮组）？
├─ 无 → 【单层搜索】.bds-search + .bds-input（凹槽填充，自身即容器）
│        禁为用而用套组合 bar（点名问题③：QuotationManager 违例已登记）
├─ 有 → 【组合嵌套 bar】.bds-filterbar（frosted pill 玻璃容器）
│        搜索与 ≥1 筛选共组一条 bar 时唯一合法形态
└─ 外壳页头 → 【rdl-search】pill（40px 白雾洗，全局页头/外壳层专属，内容区禁用）
```

### 2.2 组合嵌套 bar（bds-filterbar）强制规格

| 项 | 标准 |
|---|---|
| 输入框 | `bds-input sm`（34px，`--h-input-sm`） |
| 按钮 | `bds-btn-ghost`（40px，`--h-btn-md`）；6px 高度差为官方设计，禁止拉平 |
| 下拉 | CustomSelect（surface="form" size="compact"，34px 等高） |
| 行数 | **单行不换行**；控件过多时收敛进「更多筛选」弹层，禁止折行 |
| 容器高度 | 禁止 `h-` 任意值撑高容器；内部控件只允许 34/40 两档（机器断言） |
| 页面位置 | filterbar 是内容区**顶层**工具条，独立成行；禁止嵌入卡片内部，禁止上塞 PageHeader center 槽 |
| 页面上边距 | 禁止任何元素撑高筛选行导致页面上边距异常（点名问题② 根因条款） |

### 2.3 搜索框构造

- **搜索 icon 必须在输入框内部**（leading icon：输入框 `pl-9` + 绝对定位 icon），
  **禁止外挂框外**（点名问题④：Relations 违例已登记）。
- placeholder 用 `text-tertiary`，禁止暖色。

### 2.4 基准实现

**开发管理（DevelopmentManager）/ 货运管理（ShipmentManager）/ 财务管理（FinanceManager）**
的功能 bar 为唯一基准范式（一搜索 + 两筛选，长度与尺寸比例）；逐页主刀时对照对齐，
禁止在页面局部发明新的 bar 形态。

---

## §3 操作区（Action Zone）

### 3.1 按钮层级与尺寸

| 层级 | 类 | 高度 | 纪律 |
|---|---|---|---|
| 主操作 | `bds-btn bds-btn-primary` | 40px 默认 | 每视图/任务区唯一；位置见 §1 |
| 次操作 | `bds-btn-secondary` / `bds-btn-outline` | 40px | 同行 ≤2 |
| 三级 | `bds-btn-ghost` | 40px | 工具行次级操作 |
| 危险 | `bds-btn-danger` | 40px | 不与主操作相邻 |
| 图标按钮 | `bds-btn-icon` | 40px | 仅全民熟悉符号 |
| 行内操作 | `bds-btn-sm`（32px） | **仅表格行内操作白名单**（`// bds-sm-ok:` 注释豁免），其余禁用（点名问题①：DocumentCenter small buttons 尺寸不统一，全部改 bds-btn 默认 40px） |
| 页面级大按钮 | 56px Dashboard 款 | `h-14 w-14 rounded-card-lg` | 每页 ≤2 |

**默认从标准 button（40px）起步；小号 button 除非白名单场景一律禁用。**

### 3.2 toggle 组 active 态（禁实心黑）

- **禁止用 `bds-btn-dark`（`--invert-bg` 实心黑填充）表达 toggle active 态**——
  浅色雾面环境中实心黑突兀（点名问题⑤：OrderManager.tsx:977-984 列表视图 toggle 违例已登记）。
- 合规表达（按 toggle 形态二选一）：
  - **图标型视图切换** → `.bds-toggle` 范式：active = `background: var(--accent-tint)` + `color: var(--accent-text)`（冷墨洗 tint）。
  - **文字分段胶囊** → `.bds-segment .seg` 范式：active = `background: var(--bg-raised)` 浮面 + `color: var(--text-primary)`。
- 自定义 toggle 的 active 配方（仅当上述两组件不适用时）：
  `bg-[var(--active-darken)]` 或 `accent-tint` 底 + `text-[var(--text-primary)]` 字 + hairline inset 描边；
  **禁止任何 `--invert-bg` / 实心黑 / 高饱和实色填充**。
- `bds-btn-dark` 全站计数基线只减不增；确需深色实心的新场景须 `// bds-dark-ok:` 白名单注释。

---

## §4 表单控件（Form Controls）— 一律 BDS 化，禁原生渲染

| 控件 | 唯一合法形态 | 规格 |
|---|---|---|
| 下拉选择 | CustomSelect（surface="field" 40px pill，filterbar 内）/ surface="form" 36px（表单内） | 禁任何原生 `<select>`（M4 守卫零容忍） |
| 日期输入 | `CapsuleDateInput`（`components/ui/CapsuleDateInput.tsx` 为基准实现，已落地 OrderFieldInput / ProductionPipeline / FinanceReportsPanel） | 禁 `<input type="date">` 原生渲染 |
| 下拉浮层 | `bds-combobox` / CustomSelect（外壳存量不再扩散） | 选项 >10 或需搜索时用 combobox |
| 文本输入 | `bds-input`（40）/ `bds-input sm`（34） | 高度按语境规格表 |

- **清零口径**：原生 `<select>` + `type="date"` 存量 58 文件 **321 处**（grep 基线已量化，
  test 文件除外），逐页主刀时该页清零；机器断言基线只减不增（点名问题⑥）。
- 高度对齐：同一行/同一条 bar 内控件严格等高（§2.2 / §3.1 行内混档即违例）。

---

## §5 内容区（Content Zone）

| 项 | 标准 |
|---|---|
| 容器 | `bds-surface` 家族（面板/卡片）；嵌套层 `bds-inset`（`--recessed-bg` 冷墨洗，色温连续） |
| 间距 | 统一间距 token；卡片内边距与 §1 标题区间距呼应，禁止页面级魔数 |
| 分隔 | hairline 发丝分隔（`--border-c-subtle` / `divide-[var(--border-c-subtle)]`），禁粗分隔条 |
| 实心色块 | 禁止嵌套实心色块拼层（批 C 已收编）；玻璃容器内只允许 recessed/inset 蚀刻分层 |
| 表格 | 斑马纹用 `bg-[var(--recessed-bg)]`；行选中走 `.bds-rowsel` 配方（accent-tint-strong + inset 引导脊） |

---

## §6 弹层区（Overlay Zone）

- 模态：`bds-modal`；确认/提示：`bds-toast`。
- W4 alert 收敛（BdsDialog/bdsToast 组件）完成后为全站唯一入口；
  原生 `alert()`/`confirm()` 存量 161 处随逐页主刀一并清零。
- 弹层阴影合法（浮层语义），静态面阴影非法；toast/tooltip 不做深浅调转，
  用主题内表面（light=白底深字 / dark=深底浅字），浮层区分仅靠阴影。

---

## §7 全局纪律（六区通用）

1. 字重 ≤300：`font-light` 唯一写法（font-medium/semibold/bold/black 违例）。
2. 圆角仅 BDS 刻度：`rounded-panel/card/card-lg/inset/floating/control/field/compact`
   + `rounded-bds-*`；禁 `rounded-[Npx]` 与裸 Tailwind 刻度（rounded-xs/sm/md/lg/xl）。
3. 无阴影无 rim（静态面）；阴影仅属浮层。
4. 主题透明：组件内禁 `dark:` 分支、禁 `isDarkMode` 三元（spotlight/图表数值型除外）；
   暗色由 tokens.css `[data-theme]` 覆盖承载（批 G 口径，逐页清零）。
5. 语义色：raw 语义色（emerald/amber/rose/sky…）→ BDS 语义 token
   （`--success-text/--warning-text/--danger-text/--accent-text`）；
   业务分类编码走 §4.5 雾化分类色板 mask-*（14 色白名单，禁作语义状态色）。
6. accent 填充上文字禁 `text-white` 直用，走 `--on-accent`。

---

## §8 机器断言映射（check:tokens §10.3 扩展规格）

| # | 断言 | 口径 | 白名单 |
|---|---|---|---|
| M1 | 每个 `*Manager.tsx` 必含 `PageHeader` 或 `bds-pagehead` | 24 文件清单断言 | 无 |
| M2 | `bds-btn-sm` 计数基线只减不增 | `rg -o 'bds-btn-sm'` | `// bds-sm-ok: <原因>` |
| M3 | filterbar 内禁任何手写 `h-` 高度覆盖，仅 `h-10` 白名单（总控校准 2026-08-17） | `bds-filterbar` 所在行 `(min-h/max-h/h)-` 后接非 `10` 值即违例（行数口径） | 无 |
| M4 | 原生 `<select`（无 bds-select 类）+ `type="date"` 计数只减不增 | `rg -o` 计数，test 文件除外；粗口径 321（全仓 `<select` 213 + `type="date"` 108，无法感知 BDS 化进展）→ 入库精确口径 281（components/src 作用域 · 豁免集生效 · 剔除已 bds-select 化 33 处） | 无 |
| M5 | `bds-btn-dark` 计数基线只减不增 | `rg -o 'bds-btn-dark'` | `// bds-dark-ok: <原因>` |

既有基线（dark: 7 / raw 语义色 19 / 遮罩 3 / 裸 rounded 5 / 手写主按钮 22 /
text-white 33 / 字重 3）全部只减不增，随逐页主刀下降即更新。

---

## §9 人工验收规程（CD-008 双轨）

1. 每页主刀前/后各截**浅色 + 深色双主题**截图，对照六区规格逐区走查。
2. 关键 4 页（DocumentCenter / OrderManager / QuotationManager / Relations）
   由产品负责人亲自截图验收；其余 26 页机器断言 + 总控对照规格走查。
3. 4 页销号后**暂停放量**，产品负责人校准通过后（CD-009）再推进其余 26 页。
4. 验收通过 → 台账「验收状态」列总控签字销号；任一区违例 → 打回重刀。

---

## 附录 A：基准实现索引

| 基准 | 文件 | 用途 |
|---|---|---|
| 功能 bar | DevelopmentManager / ShipmentManager / FinanceManager | filterbar 组合条唯一范式（一搜索+两筛选） |
| 日期组件 | components/ui/CapsuleDateInput.tsx | date 输入 BDS 化基准 |
| 标题区 | components/ui/PageHeader.tsx + `.bds-pagehead` | 标题区唯一容器 |
| toggle active | `.bds-toggle.active` / `.bds-segment .seg.active`（components.css） | 冷墨洗 tint / 浮面两种合规表达 |
| 行选中 | `.bds-rowsel`（components.css） | 列表/表格行选中配方 |

## 附录 B：白名单注释格式

| 注释 | 放行断言 | 示例 |
|---|---|---|
| `// bds-sm-ok: <原因>` | M2 | `// bds-sm-ok: 订单行内状态转换操作` |
| `// bds-dark-ok: <原因>` | M5 | `// bds-dark-ok: 打印预览深色工具条` |
| `// dark-exception: <原因>` | dark: 变体 | `// dark-exception: spotlight 数值型高光` |

## 附录 C：点名问题→规格条款映射（2026-08-17 首批）

| # | 问题 | 规格条款 |
|---|---|---|
| ① | DocumentCenter 操作区 small buttons 不统一 | §3.1 行内操作白名单 + 默认 40px |
| ② | OrderManager filterbar 双行撑高 header | §1 center 槽禁令 + §2.2 单行/禁撑高 |
| ③ | QuotationManager 纯单搜索套组合 bar | §2.1 决策树（单层搜索） |
| ④ | Relations 搜索 icon 外挂框外 | §2.3 leading icon 强制 |
| ⑤ | OrderManager toggle active 实心黑 | §3.2 禁 bds-btn-dark + 冷墨洗替代 |
| ⑥ | 原生控件 321 处未 BDS 化 | §4 清零口径 + M4 断言 |
