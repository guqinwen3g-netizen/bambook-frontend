# 02 · Token

完整表（浅色 / 深色值）：[`api/tokens.md`](./api/tokens.md)（自动生成）。源文件：`styles/mist/tokens.css`。

## 作用域
- 所有 token 只在 `.mist-root` 内生效。`<MistRoot>` 渲染这个节点；`MistAppFrame` 已经包含它。
- 深色：`.mist-root[data-theme=dark]`，或宿主 `html.dark` / `[data-theme=dark]` 时自动跟随（App 现有的主题切换不用改）。

## 业务代码里怎么用
优先用组件。确实要写自定义样式时（例如图表、特殊可视化），只能这样：

```tsx
<div style={{ background: 'var(--mist-card)', borderRadius: 'var(--mist-r-card)', padding: 'var(--mist-card-pad-y) var(--mist-card-pad-x)' }} />
```

## 最常用的 token

| 用途 | Token |
|---|---|
| 页面外壳 / 画布 | `--mist-shell`、`--mist-canvas` |
| 卡片 / 次级卡片 | `--mist-card`、`--mist-card-2` |
| 填充（按钮、输入框）/ 凹陷（分段控件、标签） | `--mist-fill`、`--mist-fill-2`、`--mist-sunken` |
| 文字：主 / 次 / 弱 / 最弱 | `--mist-ink`、`--mist-ink-2`、`--mist-ink-3`、`--mist-ink-4` |
| 强调（品牌青蓝） | `--mist-accent`、`--mist-accent-ink`、`--mist-accent-tint`、`--mist-accent-tint-2`、`--mist-on-accent` |
| 状态 | `--mist-ok*`、`--mist-warn*`、`--mist-bad*` |
| AI | `--mist-ai`、`--mist-ai-tint`、`--mist-ai-badge`、`--mist-ai-badge-ink` |
| 分隔线 | `--mist-line` |
| 圆角 | `--mist-r-xs/sm/md/lg/card` |
| 字号 | `--mist-text-2xs … --mist-text-3xl` |
| 字重 | `--mist-fw-light`(300) `--mist-fw-regular`(400) `--mist-fw-medium`(500) |
| 字体 | `--mist-font`、`--mist-font-mono` |
| 动效 | `--mist-ease`、`--mist-dur-fast/dur/dur-slow` |

## 图表颜色
recharts 等图表用 `toneColor(tone)`（`components/mist/data.tsx`）拿 CSS 变量字符串，或直接 `var(--mist-accent)` / `var(--mist-ink-4)`。系列最多 4 色：accent、ok、warn、ink-3。

## 不要
- 写 hex / rgb / Tailwind 颜色类（`bg-white`、`text-slate-500`…）。
- 写 `box-shadow`、`border`、`ring`。
- 自己定义新的 `--mist-*`。需要新 token → 在 `tokens.css` 同时加浅色和深色值，并重新运行 `node scripts/gen-mist-docs.mjs`。
