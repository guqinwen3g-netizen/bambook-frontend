---
name: bambook-ui
description: Bambook 可见界面的 Mist Atelier 设计、实现与审阅入口。修改 components、styles、页面、表单、浮层或交互时使用；复用 Mist 组件与 token，并以真实业务和渲染证据验收。
---

# Bambook UI · Mist Atelier

Mist Atelier 是项目唯一运行前端与完整设计依据。旧 BDS、Bencho、历史视觉裁决与本 skill 的旧 references 不再规定新界面的字号、字重、布局、材质、图标或组件。业务规则、权限和数据事实仍按当前有效决策核实。

用户已明确认可这一版成果：原交接包的参考页面、token、材质、排版、几何与动效是锁定视觉基准。保护现成设计，优先真实业务接线和必要行为工程修复；不要借补缺口重设已有组件造型或做未经具体指示的视觉微调。扩展同类组件时对照同状态的参考页。

## 开工入口

- 先读 [业务驱动的设计协作原则](../../../docs/design/global/2026-10-06/08-2026-10-06-对话设计决策总账.md#business-driven-design)，沿真实角色核对首页入口、操作、数据/状态、权限、跨模块交接、回程及实际分支。区分确认规则、当前实现、缺口和待决定项，不从模板臆造业务。
- 设计真源从 [Mist README](../../../docs/mist-atelier/README.md) 和 [原则](../../../docs/mist-atelier/01-principles.md) 进入；实际数值以 `styles/mist/tokens.css` 为准，组件以 `components/mist` 为准。
- 当前从现成 Mist 前端继续开发：唯一入口为 `dev-ui-preview/mist-atelier/app/main.tsx` → `ReferenceApp.tsx` → `pages/*`，根 Web/Electron 入口只导入同一 main。3001 与 3131 共用它。旧 `App.tsx`/Manager 页面不再是宿主或改造对象；已有 services/数据/权限与必要控制逻辑经独立业务适配器接入。进度及未接线范围记在 [迁移手册](../../../docs/mist-atelier/05-migration-playbook.md)。这项授权不等于 35 个模块已经完成。

## 按任务取证

| 当前任务 | 补读 |
|---|---|
| 组件、表单、浮层或状态 | [组件用法](../../../docs/mist-atelier/03-components.md)、[API](../../../docs/mist-atelier/api/components.md)，随后核对对应源码类型 |
| 页面、列表、详情、录入、设置 | [页面配方](../../../docs/mist-atelier/04-page-recipes.md) 的对应 T1–T13、[模块映射](../../../docs/mist-atelier/module-map.md) 的当前模块及对应参考页源码 |
| 主题、字体、图表或特殊可视化 | [Token 用法](../../../docs/mist-atelier/02-tokens.md)、[Token 表](../../../docs/mist-atelier/api/tokens.md) 及实际 CSS 定义 |
| 外壳、账号、导航或接真实数据 | 迁移手册当前检查点、Mist `ReferenceApp.tsx`/`nav.tsx` 与真实服务/权限契约；`connected.tsx` 只按具体适配需要取用 |

只读本次命中的材料；不默认加载旧 references、历史登记册或全站模块实现。参考应用为 `dev-ui-preview/mist-atelier/bambook-mist-atelier-reference.html`，可维护源码在同目录 `app/`。

## 实施边界

不在 Mist 外壳挂旧页面，不继续重塑旧 Manager 作为新前端，不用隐藏/占位冒充交付。原前端仅用于核实必要业务事实；适配器不得带入旧 JSX/CSS/UI 组件。

1. 新界面优先消费 Mist 组件和 `var(--mist-*)`。相同角色从共享层复用；确实缺项时从 Mist 同类组件延伸，补 API、主题及行为证据，不引入第二套视觉体系。
2. 静态面零描边/零投影，层级用填充；浮层、细分隔线和键盘焦点遵循 Mist 组件的明确例外。每屏最多一个 primary；状态色按 tone，紫色仅用于 AI。字重采用 Mist 的 300/400/500。
3. 主题由 MistRoot/token 处理，不在业务 JSX 写视觉深色分支。保留宿主兼容 prop 只为接线，不能借此写第二套样式。
4. 新界面可重新组织展示与前端交互状态，真实身份、权限、业务对象、服务、数据/事件与来源回程必须接续。不能删字段/操作、伪造成功、把演示数据当真实数据或凭模板改业务规则。当前 MVP 不含邮箱/未读邮件；未来邮箱接入“我的工作”。
5. 普通 UI 改动不自动授权后端重构、部署或范围外页面迁移。按用户当前授权继续完成已明确的本地工作，不用历史视觉要求制造重复审批。
6. 浮层提供可访问名称、首次焦点、Tab 交接、Escape 和关闭后的焦点回归；portal 保持 Mist 主题，嵌套时只处理最上层。窄屏隐藏预览时必须保留可完成任务的真实入口与反馈。

## 工作与完成证据（E15）

明确当前对象和最重要操作 → 查真实业务与对应 Mist 配方 → 实现并接线 → 用实际数据/适用状态验证。未知可查事实自行核实；确需业务决策的缺口明确记录，不臆造。

完成报告分开列出：

- **功能**：真实数据来源、可执行操作、权限、保存/失败和跨模块回程的验证结果。
- **交互**：点击/键盘、焦点、加载/空/无结果/失败/无权限、长内容与窄宽度的实际验证；只测业务存在的状态。
- **视觉**：附实际渲染截图，写清主题、视口、页面/展开范围；遵循 [QA 清单](../../../docs/mist-atelier/06-qa-checklist.md) 的浅/深 1440、1180、390，并按任务裁剪合理验证范围。数据页面包含正常与空态，同配方跨页需对照。

源码合规、测试通过或 token 扫描都不能代替渲染。没有实际截图写“功能已实现，视觉待验”；列明未验范围。自检结果也不等于用户已认可审美。

提交前运行适用的 `node scripts/check-mist.mjs` 与针对性行为测试；新增/修改组件或 token 后运行 `node scripts/gen-mist-docs.mjs`。不得削弱守门规则来通过检查，也不因导入组件库就登记整模块完成。
