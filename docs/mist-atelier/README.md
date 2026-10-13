# Mist Atelier · Bambook 竹衍前端设计系统（Flat Frost）

> **从这里开始。** 这是全站新 UI 的唯一依据：设计规则、token、组件、页面模板、35 个模块的迁移表、验收清单都在这里。
> 编码 Agent 请先读 [`AGENT_BRIEF.md`](./AGENT_BRIEF.md)。

## 一句话

雾蓝渐变外壳 + 一张圆角画布；画布里**没有描边、没有投影**，层级只靠「半透明填充 + 模糊」。每屏只有一个主按钮，颜色只用来表达状态，紫色只属于 AI。

## 交付物在哪里

| 东西 | 路径 | 说明 |
|---|---|---|
| **可交互参考应用** | `dev-ui-preview/mist-atelier/bambook-mist-atelier-reference.html` | 单文件，双击即开。13 个完整页面 + 设计系统页 + 35 个模块的模板页。⌘K 搜索、⌘J 竹衍助手、右上角切换深浅色 |
| 参考应用源码 | `dev-ui-preview/mist-atelier/app/` | 每个页面就是一个「可照抄的模板」，见 `pages/*.tsx` |
| Token（CSS 变量） | `styles/mist/tokens.css` | 所有颜色/字号/间距/圆角/动效；浅色 + 深色 |
| 组件样式 | `styles/mist/components.css`、`patterns.css`、入口 `mist.css` | 业务代码**不要**新增 CSS，优先用组件 |
| React 组件 | `components/mist/`（`index.ts` 统一导出） | 通用组件与类型，API 见 [`api/components.md`](./api/components.md)；生产连接层单独引入 |
| 接入真实 App | `components/mist/connected.tsx` | `MistAppFrame`（整站外壳）、`MistSidebar`（接注册表与权限）、`getMistCrumbs`、`useMistEnabled` |
| 迁移守门脚本 | `scripts/check-mist.mjs` | 禁止描边/阴影/硬编码颜色/isDarkMode/旧 BDS |
| 文档生成 | `scripts/gen-mist-docs.mjs` | 从源码生成 `api/*.md` 与 `module-map.md` |

## 文档目录

1. [`01-principles.md`](./01-principles.md) — Flat Frost 设计规则（必须遵守）
2. [`02-tokens.md`](./02-tokens.md) — token 用法；完整表见 [`api/tokens.md`](./api/tokens.md)
3. [`03-components.md`](./03-components.md) — 组件选型与用法；完整 API 见 [`api/components.md`](./api/components.md)
4. [`04-page-recipes.md`](./04-page-recipes.md) — T1–T13 页面模板配方（照抄）
5. [`05-migration-playbook.md`](./05-migration-playbook.md) — 迁移步骤：Wave 0 外壳 → Wave 1–5 模块
6. [`06-qa-checklist.md`](./06-qa-checklist.md) — 每个模块合入前的验收清单
7. [`07-frontend-page-inventory.md`](./07-frontend-page-inventory.md) — 当前施工清单：前端先行，全站每页内容、交互与批次（含智能邮箱）
7. [`module-map.md`](./module-map.md) — 35 个模块 → 模板 → 批次（进度勾选表）
8. [`AGENT_BRIEF.md`](./AGENT_BRIEF.md) — 给编码 Agent 的完整指令

## 常用命令

完整本地应用：`npm run dev` 或 `npm run dev:mist`，自动启动独立本地服务并在3001提供Mist前端，无需旧库账号。参考同源入口：`npm run mist:ref`（3131）。还可用 `mist:ref:build` / `mist:check` / `mist:docs` / `mist:shots`。

```bash
# 参考应用（热更新，端口 3130）
npx vite --config dev-ui-preview/mist-atelier/app/vite.config.ts
# 打包成单文件 HTML
node dev-ui-preview/mist-atelier/app/build-single.mjs
# 规则检查（默认检查 Mist 自身 + docs/mist-atelier/migrated.txt 登记的文件）
node scripts/check-mist.mjs
node scripts/check-mist.mjs components/OrderManager.tsx
# 改了组件/token/moduleMap 之后重新生成文档
node scripts/gen-mist-docs.mjs
```

参考应用 URL 参数：`?intro=0`（跳过开场动画）`&view=orders/detail&id=SO-G-2026-018&theme=dark&palette=1&ai=1`。

## 当前实施基准（2026-10-13）

用户最终明确：**项目只有 Mist Atelier 这一套前端，从这个已经完成的起点继续开发。** 原前端退役，仅按需查阅业务功能和控制逻辑。唯一运行源码是 `app/main.tsx` → `ReferenceApp.tsx` → `pages/*`；3001、3131、根 Web 构建和 Electron renderer 都导入同一份 Mist main。旧 `App.tsx` 与 Manager 页面不再是宿主或改造对象。

字重采用 Mist 的 300 / 400 / 500；原页面、token、布局、材质和交互为锁定基线。在 Mist 页面的数据和动作槽位接业务适配器。当前34个MVP业务入口已注册实际页面并接独立本地持久化；智能邮箱已于 2026-10-13 晚重新纳入，按 `07-frontend-page-inventory.md` 建设。初始样例仍是交接包演示数据，不能作为真实客户业务。功能、交互、渲染及外部服务边界分别记录，推进方式和当前证据见 [`05-migration-playbook.md`](./05-migration-playbook.md)。
