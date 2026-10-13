# BDS 组件族 7 规格总览 · x-input / x-select / x-data / x-list / x-feedback / x-overlay / x-ai

## §1 元信息

| 项 | 值 |
|---|---|
| 文档名 | `BDS组件族7规格` |
| 定位 | BDS（Bambook Design System）v2.1 Luna 七大原语族规格总览——将 77+ 个细粒度 BDS 组件类归纳为 7 个原语族（x-input / x-select / x-data / x-list / x-feedback / x-overlay / x-ai），提供族级设计契约、配方真源、消费纪律与跨族组合范式；新组件开发必须归入对应族，禁止跨族混用 |
| 文件路径 | 本文档归档于 `docs/design/06-组件规格/BDS组件族7规格.md`；族实现真源为 `styles/bds/components.css`（77+ 组件类）+ `styles/bds/tokens.css`（语义 token）+ `components/ui/RDLPrimitives.tsx`（React 封装）+ `components/ui/bambookOsTokens.ts`（OS 级配方）+ `components/ui/SidePanelContainer.tsx`（玻璃面板容器） |
| 消费方 | 全项目所有业务组件（`components/**/*.tsx`）通过 className 消费 BDS 类；React 封装由 `RDLPrimitives.tsx` 提供 |
| 范式 | CSS 类库 + React 封装——`class="bds-btn bds-btn-primary"` 基类 + 变体类组合；React 封装为 `<RdlSurface tone="panel">` 等函数组件 |
| 优先级 | P0（BDS 是全项目设计唯一真源，所有 UI 必须走 BDS 类） |
| 实现状态 | ✅ 已落地（77+ 组件类 + 7 族分类 + React 封装 + 主题透明 + flat 四特征 + 4 态完整）；⚠️ 部分组件仍需从手写 className 迁移到 BDS 类（如订单域 `orderUiSpec.ts` 配方与 BDS 类的双轨合并） |
| PRD 关联 | PRD §2.3（设计系统）/ §19.1（BDS 三层治理）/ D1（全局工作台）/ D2（主动提醒引擎） |
| 代码关联 | [components.css](../../styles/bds/components.css) / [tokens.css](../../styles/bds/tokens.css) / [RDLPrimitives.tsx](../../components/ui/RDLPrimitives.tsx) / [bambookOsTokens.ts](../../components/ui/bambookOsTokens.ts) / [SidePanelContainer.tsx](../../components/ui/SidePanelContainer.tsx) / [rdlBusinessStatusTokens.ts](../../components/rdlBusinessStatusTokens.ts) / [os-vnext.css](../../styles/os-vnext.css) / [flat-experimental.css](../../styles/flat-experimental.css) / [tailwind.config.js](../../tailwind.config.js) / [check-design-tokens.sh](../../scripts/check-design-tokens.sh) |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 七族分类总览

| 族 | 命名前缀 | 职责 | 包含组件类（components.css 章节） |
|---|---|---|---|
| **x-input** | `bds-input` / `bds-textarea` / `bds-capsuleinput` / `bds-linkedinput` / `bds-stepper` / `bds-slider` | 文本/数字/范围输入原语 | §2 Input / §34 Input 带图标 / §55 LinkedInput / §56 CapsuleInput / §60 Stepper / §61 CommandPalette(输入部分) / §1754 Slider |
| **x-select** | `bds-select`（已退役，见 §5） / `bds-combobox` / `bds-segment` / `bds-tabs` / `bds-togglebutton` / `bds-checkbox` / `bds-radio` / `bds-switch` | 选择/切换原语 | §2 Select / §54 Combobox / §7 Checkbox/Radio / §6 Switch / §8 Tabs / §9 Segment / §50 ToggleButton |
| **x-data** | `bds-table` / `bds-descriptionlist` / `bds-stat-inset` / `bds-progress` / `bds-circularprogress` / `bds-sparkline` / `bds-timeline` / `bds-accordion` / `bds-codeblock` | 数据展示原语 | §10 Table / §37 DescriptionList / §45 StatInset / §15 Progress / §46 CircularProgress / §2010 Sparkline / §1205 Timeline / §1240 Accordion / §1321 CodeBlock |
| **x-list** | `bds-listrows` / `bds-listrow` / `bds-card` / `bds-filterbar` / `bds-pagehead` / `bds-breadcrumb` / `bds-pagination` / `bds-tree`(未来) | 列表/卡片/布局原语 | §3 Card / §4 ListRow / §20 Pagehead / §21 Filterbar / §27 Pagination / §48 Breadcrumb / §49 Toolbar / §65 SidePanel |
| **x-feedback** | `bds-badge` / `bds-tag` / `bds-chip` / `bds-alert` / `bds-banner` / `bds-toast` / `bds-tooltip` / `bds-skeleton` / `bds-empty` / `bds-spinner` / `bds-statusdot` / `bds-countbadge` | 反馈/状态原语 | §5 Badge / §12 Toast / §13 Tooltip / §16 Skeleton / §17 Empty / §19 Tag / §31 Alert / §50 Banner / §40 Spinner / §41 CountBadge / §57 Chip / §1364 StatusDot |
| **x-overlay** | `bds-modal` / `bds-modal-mask` / `bds-popover` / `bds-dropdown` / `bds-sheet` / `bds-bottomsheet` / `bds-calendar` / `bds-steps` / `bds-upload` / `bds-formfield` / `bds-formsection` | 浮层/流程原语 | §11 Modal / §23 Popover/Dropdown / §24 Sheet / §26 BottomSheet / §25 Calendar / §26 Steps / §29 Upload / §42 FormSection / §53 FormField / §66 BottomSheet |
| **x-ai** | `bds-msg` / `bds-stream` / `bds-toolchip` / `bds-approvalcard` / `bds-artifactblock` / `bds-evidenceblock` / `bds-nextactions` / `bds-mermaidblock` / `bds-notificationitem` / `bds-contactitem` / `bds-detailpanel` / `bds-folder-tab` / `bds-spotlightcard` / `bds-scrolledgefade` | AI/Agent/业务复合原语 | §30 AI 消息气泡 / §62 NotificationItem / §63 ContactItem / §64 DetailPanel / §70 MermaidBlock / §71 EvidenceBlock / §72 NextActions / §73 ApprovalCard / §74 ArtifactBlock / §75 ScrollEdgeFade / §76 SpotlightCard / §77 FolderTab |

---

## §3 七族通用契约

### §3.1 三层治理对齐

| 层 | 文件 | 通用契约 |
|---|---|---|
| 宪法 | `styles/os-vnext.css` | 320 个 CSS 变量——所有颜色/圆角/字重/空间/动效/阴影 token 唯一声明；不允许业务代码覆盖 |
| 契约 | `styles/flat-experimental.css` + `styles/bds/components.css` | flat 四特征（无阴影/无 rim/大圆角/半透明膜色）+ 77+ 组件类实现 |
| 基线 | `tailwind.config.js` + `scripts/check-design-tokens.sh` | Tailwind 语义类映射 + 提交时自动扫描硬编码（hex/px 圆角/box-shadow） |

### §3.2 flat 设计四特征（全族共用）

1. **无阴影（Shadowless）**：静态面零 `box-shadow`；仅浮层（modal/toast/segment 激活面/switch knob）使用 `--bds-shadow-*`
2. **无 rim（Rimless）**：无边框包裹；靠膜色与模糊分层（`backdrop-blur` + `saturate`）
3. **大圆角（Large Radius）**：`rounded-panel` / `rounded-card` / `rounded-card-lg` / `rounded-control` / `rounded-floating` / `rounded-pill`
4. **半透明膜色（Translucent Film）**：`bg-white/X` / `bg-deep/X` + `backdrop-blur` + `backdrop-saturate`

### §3.3 主题透明

- **无 `dark:` 分支**——所有 BDS 类不写 `dark:` 前缀；暗色由 `tokens.css` 的 `[data-theme="dark"]` / `.dark` 选择器统一覆盖
- **无 `isDarkMode` 三元**——组件内不写 `dark ? 'A' : 'B'`；主题切换靠 CSS 变量自适应

### §3.4 字重纪律

- 全局字重 ≤ 300——`font-extralight`（200）/ `font-light`（300）/ `font-normal`（400，仅未读标题等极少场景）
- 禁止 `font-medium`（500）及以上

### §3.5 发光纪律

- **控件不发光**——button / switch / checkbox / radio / input 无 `box-shadow` 发光
- **仅小型彩色状态元素发光**——badge tint + dot LED / progress fill / toast 图标使用 `--glow-*` 自发光层
- focus 环用 `--focus-ring` / `--focus-ring-strong`，不属于发光范畴

### §3.6 4 态完整

所有交互组件必须实现 4 态：
- `default`：默认态
- `hover`：悬停态（`hover:bg-hover-darken` 或 `hover:bg-recessed-bg-hover`）
- `active`：按下态（`active:bg-active-darken` + `transform: translateY(1px)`）
- `disabled`：禁用态（`opacity: 0.4` + `cursor: not-allowed` + `pointer-events: none`）
- `loading`：加载态（`color: transparent` + `::after` spinner）

---

## §4 x-input 族 · 输入原语

### §4.1 族职责

文本/数字/范围输入的原语集合——玻璃上凹槽填充（`--recessed-*` 墨洗），无边框，focus 态显示 accent 描边 + focus ring。

### §4.2 包含组件

| 组件类 | 章节 | 用途 |
|---|---|---|
| `.bds-input` | §2 | 标准文本输入（h-10 + recessed-bg + focus accent） |
| `.bds-textarea` | §2 | 多行文本（min-h-88px + resize-vertical） |
| `.bds-input` 带 `.sm` / `.lg` | §2 | 尺寸变体 |
| `.bds-input` 带图标前缀/后缀 | §34 | 搜索/货币符号等 |
| `.bds-capsuleinput` | §56 | 胶囊输入（rounded-pill） |
| `.bds-linkedinput` | §55 | 关联输入（前缀 + 主输入 + 后缀联动） |
| `.bds-stepper` | §60 | 数字步进（- input +） |
| `.bds-slider` | §59 | 滑块（range input） |

### §4.3 视觉契约

```css
.bds-input {
  height: var(--h-input);           /* 40px */
  padding: var(--p-input);
  border-radius: var(--r-input);
  border: 1px solid transparent;    /* 无边框（rimless） */
  background: var(--recessed-bg);   /* 凹槽墨洗 */
  font-size: var(--text-sm);
  color: var(--text-primary);
  transition: all var(--duration-fast) var(--ease-default);
}
.bds-input:hover { background: var(--recessed-bg-hover); }
.bds-input:focus {
  outline: none;
  background: var(--bg-card);       /* focus 时升起为卡片底色 */
  border-color: var(--accent);      /* accent 描边 */
  box-shadow: var(--focus-ring);    /* focus ring（非发光） */
}
.bds-input:disabled { background: var(--recessed-bg); color: var(--text-tertiary); cursor: not-allowed; }
.bds-input::placeholder { color: var(--text-tertiary); }
```

### §4.4 消费纪律

- ✅ 用 `class="bds-input"` + 尺寸/变体类组合
- ❌ 禁止手写 `border` / `background` / `box-shadow`——走 BDS 类
- ❌ 禁止 `rounded-[Npx]`——用 `var(--r-input)` 或 Tailwind `rounded-control`
- ✅ focus 态由 CSS 自动处理——组件内不写 `onFocus`/`onBlur` 样式逻辑

---

## §5 x-select 族 · 选择/切换原语

### §5.1 族职责

选择/切换的原语集合——包括下拉选择、分段控件、开关、复选/单选、Tab 页签等。

### §5.2 包含组件

| 组件类 | 章节 | 用途 |
|---|---|---|
| ~~`select.bds-select`~~ | §2 | ~~原生 select 填充式 + 自绘箭头~~ **已退役（2026-08-31 W4 收编）：选择器族已删除，下拉唯一真源 CustomSelect** |
| `.bds-combobox` | §54 | 组合选择器（input + dropdown） |
| `.bds-segment` | §9 | 分段控制器（pill 容器 + pill 激活面） |
| `.bds-tabs` | §8 | 下划线式页签 |
| `.bds-togglebutton` | §50 | 切换按钮组 |
| `.bds-checkbox` / `.bds-radio` | §7 | 复选/单选 |
| `.bds-switch` | §6 | 开关（40×24 pill + 20px knob） |

### §5.3 视觉契约（以 switch 为例）

```css
.bds-switch {
  position: relative;
  width: 40px; height: 24px;
  border-radius: var(--radius-pill);
  background: var(--recessed-bg-strong);  /* 关闭态凹槽 */
  cursor: pointer;
  border: none;
  transition: background var(--duration-fast) var(--ease-default);
}
.bds-switch::after {
  content: "";
  position: absolute;
  top: 2px; left: 2px;
  width: 20px; height: 20px;
  border-radius: 50%;
  background: var(--on-accent);            /* 恒白 knob */
  box-shadow: var(--bds-shadow-xs);        /* knob 允许微阴影 */
  transition: transform var(--duration-fast) var(--ease-default);
}
.bds-switch[aria-checked="true"] {
  background: var(--accent);               /* 开启态 accent */
}
.bds-switch[aria-checked="true"]::after {
  transform: translateX(16px);
}
```

### §5.4 消费纪律

- ❌ 原生 select 已全站退役（2026-08-31 W4 收编），下拉唯一真源 CustomSelect（见 design-system/component-application-spec.md §5）
- ✅ switch 用 `<button role="switch" aria-checked={enabled} class="bds-switch">`
- ✅ segment 用 `.bds-segment` 容器 + `.bds-segment-item` + `.active` 变体
- ❌ 禁止手写 `border-radius` / `background`——走 BDS 类
- ✅ 开关 knob 恒白（`--on-accent`）——不随主题反转

---

## §6 x-data 族 · 数据展示原语

### §6.1 族职责

结构化数据展示的原语集合——表格、描述列表、统计块、进度条、时间线、手风琴等。

### §6.2 包含组件

| 组件类 | 章节 | 用途 |
|---|---|---|
| `.bds-table` | §10 | 表格（hairline 分隔 + hover 整行浮底） |
| `.bds-descriptionlist` | §37 | 描述列表（key-value 网格） |
| `.bds-stat-inset` | §45 | 凹槽统计块（原 MetricBlock 并入） |
| `.bds-progress` | §15 | 进度条（fill 允许发光） |
| `.bds-circularprogress` / `.arc` | §46 | 环形进度（全环 + 半圆仪表） |
| `.bds-sparkline` | §2010 | 迷你折线 |
| `.bds-timeline` | §1205 | 时间线 |
| `.bds-accordion` | §1240 | 手风琴 |
| `.bds-codeblock` | §1321 | 代码块 |

### §6.3 视觉契约（以 table 为例）

```css
.bds-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.bds-table th {
  text-align: left;
  font-weight: 300;                       /* ≤300 */
  font-size: var(--text-xs);
  letter-spacing: var(--tracking-wider);
  text-transform: uppercase;
  color: var(--text-tertiary);
  padding: 10px var(--space-5);
  border-bottom: var(--border-default);
  white-space: nowrap;
}
.bds-table td {
  padding: 13px var(--space-5);
  border-bottom: var(--border-subtle);    /* hairline */
  vertical-align: middle;
}
.bds-table tbody tr:hover td { background: var(--hover-darken); }
.bds-table td.num, .bds-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
```

### §6.4 消费纪律

- ✅ 表格用 `<table class="bds-table">` + `<th class="num">` 数字列
- ✅ 进度条 fill 允许 `--glow-*` 发光（小型彩色状态元素例外）
- ❌ 禁止手写 `border-bottom` / `padding`——走 BDS 类
- ✅ 数字列用 `tabular-nums`——对齐千分位

---

## §7 x-list 族 · 列表/卡片/布局原语

### §7.1 族职责

列表/卡片/页面布局的原语集合——主容器玻璃面、列表行、页头、筛选条、面包屑、分页等。

### §7.2 包含组件

| 组件类 | 章节 | 用途 |
|---|---|---|
| `.bds-card` | §3 | 卡片（rimless 无边框零阴影，主容器玻璃面） |
| `.bds-listrows` / `.bds-listrow` | §4 | 列表行（hairline 分隔 + hover 浮底） |
| `.bds-pagehead` | §20 | 页头（中英混排标题 + breadcrumb 槽位） |
| `.bds-filterbar` | §21 | 筛选条（pill 工具条，与 bds-card 同材质） |
| `.bds-breadcrumb` | §48 | 面包屑（原 crumb 已并入） |
| `.bds-pagination` | §27 | 分页 |
| `.bds-toolbar` | §49 | 工具条 |
| `.bds-sidepanel` | §65 | 侧边面板 |

### §7.3 视觉契约（以 card 为例）

```css
.bds-card {
  background: var(--bg-card);             /* 主容器玻璃面 */
  backdrop-filter: blur(var(--frosted-blur)) saturate(var(--frosted-saturate));
  -webkit-backdrop-filter: blur(var(--frosted-blur)) saturate(var(--frosted-saturate));
  border-radius: var(--r-card);           /* 大圆角 */
  border: none;                           /* rimless */
  box-shadow: none;                       /* shadowless */
  padding: var(--p-card);
}
```

### §7.4 消费纪律

- ✅ 主容器用 `.bds-card` 或 `SidePanelContainer`（React 封装）
- ✅ 页头用 `.bds-pagehead`——中英混排标题 + 右侧 breadcrumb
- ✅ 筛选条用 `.bds-filterbar`——与主容器同材质，不手动拼接
- ❌ 禁止手写 `box-shadow` / `border` / `rounded-[Npx]`
- ✅ 列表行用 `.bds-listrow`——hairline 分隔由 `+ .bds-listrow` 自动处理

---

## §8 x-feedback 族 · 反馈/状态原语

### §8.1 族职责

状态反馈与提示的原语集合——徽章、标签、Toast、Alert、Skeleton、Empty、Spinner 等。

### §8.2 包含组件

| 组件类 | 章节 | 用途 |
|---|---|---|
| `.bds-badge` | §5 | 徽章（pill + 语义对齐 rdlBusinessStatusTokens） |
| `.bds-tag` | §19 | 标签（pill caps） |
| `.bds-chip` | §57 | 可移除标签 |
| `.bds-alert` | §31 | 内联通告（表单/列表错误横幅） |
| `.bds-banner` | §50 | 页面级通告 |
| `.bds-toast` | §12 | 轻提示（pill + 图标发光） |
| `.bds-tooltip` | §13 | 提示（invert-bg + invert-text） |
| `.bds-skeleton` | §16 | 骨架屏 |
| `.bds-empty` | §17 | 空状态 |
| `.bds-spinner` | §40 | 加载指示器 |
| `.bds-statusdot` | §44 | 状态点 |
| `.bds-countbadge` | §41 | 数字徽章 |

### §8.3 视觉契约（以 badge 为例）

```css
.bds-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: var(--p-badge);
  border-radius: var(--r-badge);
  font-size: var(--text-xs);
  font-weight: 300;
  line-height: 1.4;
  white-space: nowrap;
}
.bds-badge .dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; box-shadow: 0 0 6px currentColor; }

/* 语义徽章 — tint 底 + soft 荧光外晕 */
.bds-badge.success { background: var(--success-tint); color: var(--success-text); box-shadow: var(--glow-success-soft); }
.bds-badge.warning { background: var(--warning-tint); color: var(--warning-text); box-shadow: var(--glow-warning-soft); }
.bds-badge.danger  { background: var(--danger-tint);  color: var(--danger-text);  box-shadow: var(--glow-danger-soft); }
.bds-badge.info    { background: var(--accent-tint);  color: var(--accent-text);  box-shadow: var(--glow-accent-soft); }
.bds-badge.neutral { background: var(--recessed-bg-strong); color: var(--text-secondary); }

/* Outline 变体 — 去填充，hairline 描边 */
.bds-badge.outline { background: transparent; border: 1px solid color-mix(in srgb, currentColor 40%, transparent); box-shadow: none; }
```

### §8.4 消费纪律

- ✅ 徽章用 `.bds-badge.success/warning/danger/info/neutral`
- ✅ Toast 图标允许 `--glow-*` 发光（小型彩色状态元素例外）
- ✅ Tooltip 不做深浅调转——`invert-bg` + `invert-text`（light=深底浅字 / dark=浅底深字）
- ❌ 禁止 emerald/red/amber 等 Tailwind 彩色——走 `--success`/`--warning`/`--danger` 语义 token
- ✅ 语义对齐 `rdlBusinessStatusTokens.ts` 的 `statusSemanticClass`

---

## §9 x-overlay 族 · 浮层/流程原语

### §9.1 族职责

模态浮层与多步流程的原语集合——Modal、Popover、Sheet、Calendar、Steps、Upload、FormField 等。

### §9.2 包含组件

| 组件类 | 章节 | 用途 |
|---|---|---|
| `.bds-modal-mask` / `.bds-modal` | §11 | 模态框（mask blur + card 浮层） |
| `.bds-popover` / `.bds-dropdown` | §23 | 浮层/下拉 |
| `.bds-sheet` | §24 | 右滑详情抽屉 |
| `.bds-bottomsheet` | §66 | 底部弹层 |
| `.bds-calendar` | §25 | 日历浮层 |
| `.bds-steps` | §26 | 步骤条（向导/导入流程） |
| `.bds-upload` | §29 | 上传区（拖拽 + 文件列表） |
| `.bds-formfield` | §53 | 表单字段（label + input + hint + error） |
| `.bds-formsection` | §42 | 表单分组 |

### §9.3 视觉契约（以 modal 为例）

```css
.bds-modal-mask {
  position: fixed; inset: 0; z-index: var(--z-modal);
  background: var(--mask-bg);
  backdrop-filter: blur(var(--frosted-blur)) saturate(var(--frosted-saturate));
  -webkit-backdrop-filter: blur(var(--frosted-blur)) saturate(var(--frosted-saturate));
  display: grid;
  place-items: center;
  padding: var(--space-4);
}
.bds-modal {
  width: 440px;
  max-width: calc(100vw - 48px);
  background: var(--bg-card);
  border-radius: var(--r-modal);          /* 大圆角 */
  padding: var(--p-modal);
  box-shadow: var(--bds-shadow-md);       /* 浮层允许阴影 */
}
```

### §9.4 消费纪律

- ✅ 浮层（modal/toast/sheet）允许 `--bds-shadow-*`——浮层需要阴影分层
- ✅ 遮罩用 `backdrop-filter: blur + saturate`——与全局玻璃面一致
- ❌ 禁止手写 `z-index`——用 `var(--z-modal)` / `var(--z-toast)` 等 token
- ✅ 步骤条用 `.bds-steps`——向导/导入流程统一范式

---

## §10 x-ai 族 · AI/Agent/业务复合原语

### §10.1 族职责

AI 消息、Agent 执行轨迹、业务复合卡片的原语集合——这是 BDS v2.1 为 Bambook AI 能力新增的族。

### §10.2 包含组件

| 组件类 | 章节 | 用途 |
|---|---|---|
| `.bds-msg` / `.bds-stream` | §30 | AI 消息气泡 + 流式光标 |
| `.bds-toolchip` | §30 | 工具调用 chip（Agent 执行轨迹） |
| `.bds-approvalcard` | §73 | 审批卡 |
| `.bds-artifactblock` | §74 | 文件产物 |
| `.bds-evidenceblock` | §71 | 证据块 |
| `.bds-nextactions` | §72 | 下一步操作 |
| `.bds-mermaidblock` | §70 | Mermaid 图表块 |
| `.bds-notificationitem` | §62 | 通知条目 |
| `.bds-contactitem` | §63 | 联系人条目 |
| `.bds-detailpanel` | §64 | 内联详情面板 |
| `.bds-spotlightcard` | §76 | 光斑卡片 |
| `.bds-scrolledgefade` | §75 | 滚动边缘渐变 |
| `.bds-folder-tab` | §77 | 文件夹标签 |

### §10.3 视觉契约（以 msg 为例）

```css
.bds-msg { display: flex; gap: var(--space-3); }
.bds-msg .bbl {
  max-width: 72%;
  padding: 12px var(--space-4);
  border-radius: var(--radius-lg);
  font-size: var(--text-sm);
  line-height: 1.6;
}
.bds-msg.ai .bbl {
  background: var(--bg-card);
  color: var(--text-primary);
  border-top-left-radius: var(--radius-xs);   /* AI 气泡左上尖角 */
}
.bds-msg.user { flex-direction: row-reverse; }
.bds-msg.user .bbl {
  background: var(--accent-tint);
  color: var(--accent-text);
  border-top-right-radius: var(--radius-xs);  /* 用户气泡右上尖角 */
}

/* 流式光标 — 跟随最后字符闪烁 */
.bds-stream::after {
  content: "";
  display: inline-block;
  width: 7px; height: 14px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--accent);
  animation: bds-caret 0.9s steps(2) infinite;
}
@keyframes bds-caret { 50% { opacity: 0; } }

/* 工具调用 chip — Agent 执行轨迹 */
.bds-toolchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  background: var(--recessed-bg-strong);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
.bds-toolchip .dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; box-shadow: 0 0 6px currentColor; }
.bds-toolchip.run .dot { color: var(--warning); }
.bds-toolchip.done .dot { color: var(--success); }
.bds-toolchip.fail .dot { color: var(--danger); }
```

### §10.4 消费纪律

- ✅ AI 消息用 `.bds-msg.ai` / `.bds-msg.user`——左/右气泡 + 尖角差异
- ✅ 流式态用 `.bds-stream`——光标闪烁跟随最后字符
- ✅ 工具调用 chip 用 `.bds-toolchip.run/done/fail`——三态色编码
- ✅ 审批卡用 `.bds-approvalcard`——与 `NotificationCenter` 审批中心同源
- ❌ 禁止手写气泡 `border-radius` / `background`——走 BDS 类

---

## §11 跨族组合范式

### §11.1 表单字段组合（x-input + x-feedback + x-overlay）

```tsx
<div className="bds-formfield">
  <label className="bds-formfield-label">客户名称</label>
  <input className="bds-input" />
  <p className="bds-formfield-hint">请填写客户全称</p>
  {error && <div className="bds-alert danger">{error}</div>}
</div>
```

- x-overlay 的 `.bds-formfield` 容器 + x-input 的 `.bds-input` + x-feedback 的 `.bds-alert`

### §11.2 列表页组合（x-list + x-data + x-feedback）

```tsx
<div className="bds-card">
  <div className="bds-pagehead">
    <h1>订单管理 / Orders</h1>
    <nav className="bds-breadcrumb">...</nav>
  </div>
  <div className="bds-filterbar">
    <button className="bds-btn bds-btn-secondary">筛选</button>
  </div>
  <table className="bds-table">
    <thead>...</thead>
    <tbody>
      {items.map(item => (
        <tr>
          <td>{item.poNumber} <span className="bds-badge success">已确认</span></td>
          ...
        </tr>
      ))}
    </tbody>
  </table>
  {items.length === 0 && <div className="bds-empty">暂无订单</div>}
  <div className="bds-pagination">...</div>
</div>
```

- x-list 的 `.bds-card` + `.bds-pagehead` + `.bds-filterbar` + `.bds-pagination`
- x-data 的 `.bds-table`
- x-feedback 的 `.bds-badge` + `.bds-empty`

### §11.3 AI 对话组合（x-ai + x-overlay + x-feedback）

```tsx
<div className="bds-card">
  <div className="bds-msg ai">
    <div className="bbl bds-stream">正在分析订单数据...</div>
  </div>
  <div className="bds-toolchip run"><span className="dot" />query_orders</div>
  <div className="bds-msg user">
    <div className="bbl">帮我查上周的订单</div>
  </div>
  {error && <div className="bds-alert danger">工具调用失败</div>}
</div>
```

- x-ai 的 `.bds-msg` + `.bds-stream` + `.bds-toolchip`
- x-list 的 `.bds-card` 容器
- x-feedback 的 `.bds-alert`

### §11.4 审批中心组合（x-ai + x-select + x-feedback）

```tsx
<div className="bds-sheet">
  <div className="bds-tabs">
    <button className="bds-tab active">待办</button>
    <button className="bds-tab">已办</button>
  </div>
  <div className="bds-approvalcard">
    <h4>报价单 QT-2026-001 双轨偏差审批</h4>
    <span className="bds-badge warning">偏差 18%</span>
    <p>轨道 A 中位 $0.0235 · 轨道 B 终价 $0.0278</p>
    <div className="flex gap-2">
      <button className="bds-btn bds-btn-success">通过</button>
      <button className="bds-btn bds-btn-danger">驳回</button>
    </div>
  </div>
</div>
```

- x-overlay 的 `.bds-sheet` + `.bds-tabs`
- x-ai 的 `.bds-approvalcard`
- x-feedback 的 `.bds-badge`
- x-select 的 `.bds-tabs`（Tab 切换）

---

## §12 React 封装（RDLPrimitives.tsx）

`components/ui/RDLPrimitives.tsx` 提供 5 个 React 封装组件：

| 组件 | Props | 用途 |
|---|---|---|
| `RdlSurface` | `tone: 'panel' \| 'card' \| 'inset' \| 'floating'` / `padding` | 玻璃表面容器（x-list 族） |
| `RdlToolbar` | `density: 'regular' \| 'compact'` | 工具条（x-list 族） |
| `RdlPill` | `active` / `tone: 'neutral' \| 'accent' \| 'danger'` | 胶囊按钮（x-select 族） |
| `RdlSearch` | `density` / `inputClassName` | 搜索输入（x-input 族） |
| `RdlDataRow` | `interactive` / `selected` | 数据行（x-data 族） |
| `RdlMetricCard` | — | 统计卡（x-data 族） |
| `RdlOverlayIconButton` | — | 浮层图标按钮（x-overlay 族） |

### 使用示例

```tsx
import { RdlSurface, RdlSearch, RdlDataRow } from './ui/RDLPrimitives';

<RdlSurface tone="panel" padding="regular">
  <RdlSearch placeholder="搜索..." />
  <RdlDataRow interactive selected>
    <span>订单 #001</span>
  </RdlDataRow>
</RdlSurface>
```

---

## §13 BDS 设计系统对齐

### §13.1 三层治理

| 层 | 文件 | 七族消费点 |
|---|---|---|
| 宪法 | `styles/os-vnext.css` | 所有 `--*` token（颜色/圆角/字重/空间/动效/阴影） |
| 契约 | `styles/bds/components.css` + `styles/bds/tokens.css` | 77+ 组件类实现 + BDS 专用 token |
| 基线 | `tailwind.config.js` + `scripts/check-design-tokens.sh` | Tailwind 语义类映射 + 硬编码扫描 |

### §13.2 配方来源

| 配方 | 来源 | 用途 |
|---|---|---|
| `--recessed-bg` / `-hover` / `-strong` | `tokens.css` | 凹槽墨洗（x-input / x-select / x-list） |
| `--accent` / `-tint` / `-text` / `-hover` / `-active` | `tokens.css` | accent 强调色 |
| `--success` / `--warning` / `--danger` + `-tint` / `-text` | `tokens.css` | 语义色 |
| `--glow-success-soft` / `-warning-soft` / `-danger-soft` / `-accent-soft` | `tokens.css` | soft 荧光外晕（x-feedback 徽章） |
| `--bds-shadow-xs` / `-sm` / `-md` / `-lg` | `tokens.css` | 浮层阴影（x-overlay） |
| `--focus-ring` / `--focus-ring-strong` / `--focus-ring-danger` | `tokens.css` | focus 环 |
| `--mask-bg` / `--frosted-blur` / `--frosted-saturate` | `tokens.css` | 遮罩 + 磨砂玻璃 |
| `--r-input` / `--r-card` / `--r-modal` / `--r-toast` / `--r-badge` / `--radius-pill` | `tokens.css` | 圆角 token |
| `--h-input` / `--h-btn-md` / `--h-btn-sm` / `--h-btn-lg` | `tokens.css` | 高度 token |
| `--text-xs` / `--text-sm` / `--text-base` / `--text-lg` | `tokens.css` | 字号 token |
| `--tracking-wider` | `tokens.css` | 字间距 token |
| `--z-modal` / `--z-toast` / `--z-tooltip` | `tokens.css` | z-index token |
| `--duration-fast` / `--ease-default` | `tokens.css` | 动效 token |

### §13.3 设计纪律（全族共用）

- ❌ 禁止硬编码颜色——所有颜色走 `var(--*)` token
- ❌ 禁止 `box-shadow` 字面值——走 `var(--bds-shadow-*)` 或 `var(--glow-*-soft)`
- ❌ 禁止 `rounded-[Npx]`——走 `var(--r-*)` 或 Tailwind 语义类
- ❌ 禁止 `dark:` 分支——主题由 `tokens.css` 的 `[data-theme="dark"]` 统一覆盖
- ❌ 禁止 `isDarkMode` 三元——组件内不写主题判断
- ❌ 禁止 `font-medium`（500）及以上——全局字重 ≤ 300
- ✅ 4 态完整——default / hover / active / disabled + loading
- ✅ 主题透明——CSS 变量自适应
- ✅ flat 四特征——无阴影 / 无 rim / 大圆角 / 半透明膜色
- ✅ 发光仅限小型彩色状态元素——徽章 / 进度条 / toast 图标

---

## §14 缺口与后续

### §14.1 已知缺口

| ID | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-1 | `orderUiSpec.ts` 配方与 BDS 类双轨并存 | 订单域部分组件走 `orderSpec.*` 而非 `bds-*` 类，需逐步合并 | P2 |
| GAP-2 | `bambookOsTokens.ts` 配方与 BDS token 部分重复 | OS 级配方与 BDS token 存在重叠，需统一收口 | P2 |
| GAP-3 | x-ai 族组件类已定义但 React 封装缺失 | `.bds-msg` / `.bds-toolchip` 等无 React 封装，业务组件手写 className | P3 |
| GAP-4 | x-list 族缺 `.bds-tree` 树形列表 | 知识库目录树等场景无 BDS 类可用 | P3 |
| GAP-5 | x-overlay 族缺 `.bds-drawer` 通用抽屉 | `NotificationCenter` 抽屉手写 className，未走 BDS 类 | P3 |
| GAP-6 | check-design-tokens.sh 未覆盖 rgba 任意值绕过 | `StepUpload` 等用 `rgba()` 绕开 flat-experimental 护栏，基线扫描不报警 | P3 |
| GAP-7 | BDS showcase 未覆盖全部 77+ 组件 | 部分组件无视觉验收基线 | P3 |

### §14.2 推荐扩展方向

1. **双轨合并**：将 `orderUiSpec.ts` 的配方逐步迁移到 BDS 类，消除双轨
2. **x-ai React 封装**：为 `.bds-msg` / `.bds-toolchip` / `.bds-approvalcard` 等提供 React 封装
3. **x-list 树形列表**：新增 `.bds-tree` + `.bds-tree-item` 支持知识库目录树
4. **x-overlay 通用抽屉**：新增 `.bds-drawer` 统一抽屉范式（NotificationCenter / SidePanelContainer 合并）
5. **BDS showcase 补全**：为 77+ 组件提供完整的视觉验收基线
6. **check-design-tokens.sh 增强**：扫描 `rgba()` 任意值绕过，强制走 BDS 类

### §14.3 不推荐扩展

- ❌ 不在 BDS 之外新建组件类——所有 UI 必须走 BDS 类
- ❌ 不在业务组件内覆盖 BDS 类的样式——`!important` 仅限 `flat-experimental.css`
- ❌ 不引入第三方 UI 库——BDS 是唯一组件真源

---

## §15 索引

### §15.1 交叉链接

- [PageHeader.md](./PageHeader.md) — 页面头部组件，消费 `.bds-pagehead` + `.bds-breadcrumb`
- [DetailPanel.md](./DetailPanel.md) — 详情面板，消费 `.bds-card` + `.bds-listrow`
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板容器，x-list 族的 React 封装
- [RelationCombobox.md](./RelationCombobox.md) — 关联选择器，x-select 族的业务封装
- [OrderSectionHeader.md](./OrderSectionHeader.md) — 订单区块标题，x-list 族的业务封装
- [OrderClusterBlock.md](./OrderClusterBlock.md) — 字段簇块，x-input + x-select + x-data 跨族组合
- [OrderLinesTable.md](./OrderLinesTable.md) — 订单行表格，x-data 族的 `.bds-table` 消费方
- [OrderLinesGrid.md](./OrderLinesGrid.md) — 尺码网格，x-data + x-input 跨族组合
- [ImportWizard.md](./ImportWizard.md) — 导入向导，x-overlay 族的 `.bds-modal` + `.bds-steps` + `.bds-upload`
- [CmdK-命令面板.md](./CmdK-命令面板.md) — 命令面板，x-overlay 族的浮层 + x-list 族的列表
- [NotificationCenter-通知与审批中心.md](./NotificationCenter-通知与审批中心.md) — 通知中心，x-overlay 抽屉 + x-ai 通知条目 + x-feedback 徽章

### §15.2 代码真源

- 组件类：[styles/bds/components.css](../../styles/bds/components.css)（77+ 组件类，78 个章节）
- BDS token：[styles/bds/tokens.css](../../styles/bds/tokens.css)
- React 封装：[components/ui/RDLPrimitives.tsx](../../components/ui/RDLPrimitives.tsx)（5 个组件）
- OS 级配方：[components/ui/bambookOsTokens.ts](../../components/ui/bambookOsTokens.ts)
- 玻璃面板：[components/ui/SidePanelContainer.tsx](../../components/ui/SidePanelContainer.tsx)
- 语义色：[components/rdlBusinessStatusTokens.ts](../../components/rdlBusinessStatusTokens.ts) `statusSemanticClass` / `statusSemanticText` / `statusSemanticBg`
- 宪法：[styles/os-vnext.css](../../styles/os-vnext.css)（320 token）
- 契约：[styles/flat-experimental.css](../../styles/flat-experimental.css)
- 基线：[tailwind.config.js](../../tailwind.config.js) + [scripts/check-design-tokens.sh](../../scripts/check-design-tokens.sh)
- 视觉验收：[styles/bds/showcase.html](../../styles/bds/showcase.html)

### §15.3 设计文档关联

- [01-产品总览/4. 设计系统规范.md](../01-产品总览/4.%20设计系统规范.md) — BDS 三层治理 + flat 四特征（本文档的族级细化）
