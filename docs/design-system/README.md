# Bambook OS Design Grammar V1

当前入口（2026-10-07）：[前端设计交接与视觉验收提案](前端设计交接与视觉验收门槛-2026-10-07.md) · [全局 UI/UX 执行方案](全局UIUX收敛执行方案-2026-10-01.md) · [规则权威与内容契约](BDS规则权威与内容契约-2026-10-01.md) · [子界面覆盖台账](uiux-surface-inventory-2026-10-01.csv)。唯一设计改造豁免是 Dashboard；共享变更仍须保护它。

## Source Of Truth

按职责区分来源，不再把互相叠加的实现都称为“唯一真源”：

| 职责 | 当前入口 | 边界 |
|---|---|---|
| 新业务内容的数值与材质 | `styles/bds/tokens.css` | 现行数值；冲突见规则权威表，源码不等于视觉认可 |
| BDS 元件与布局实现 | `styles/bds/components.css`、`styles/bds/layout.css`、`components/ui/primitives/layoutPrimitives.tsx` | 优先复用，缺失语义在共享层补齐，不在页面发明样式 |
| 语境、角色与组合 | `component-application-spec.md` + 本轮规则权威与内容契约 + [前端设计交接与视觉验收门槛](前端设计交接与视觉验收门槛-2026-10-07.md) | 旧值冲突按裁决表执行；候选配方仍需运行验证；coding agent 开工必须收到逐页视觉规格 |
| 现有外壳与 compiled 轨 | `os-vnext.css`、`bambookOsTokens.ts`、`osMaterial.ts`、现有 compiler/primitives | 保持现役职责，迁移单独核对；不扩散到新业务页，也不绕过 compiler 造同类组件 |
| 滚动与浮层行为 | `SidePanelContainer.tsx`、`ScrollEdgeFades.tsx` 等已有共享组件 | 行为契约保留，不借视觉整改删除 |
| 组件索引 | `bambookDesignSystem.ts` | 实现登记，不覆盖最新用户要求或 BDS 裁决 |
| 新版场景展示 | `dev-ui-preview/showcase.html`，开发地址 `/dev-ui-preview/showcase.html` | 2026-10-09 八个综合场景的候选展厅，包含可操作演示与深浅色；当前交互/视觉待用户验收。旧 `styles/bds/showcase.html` 保留为历史元件参考，不覆盖用户最新裁决 |

`styles/flat-experimental.css` 是现役兼容覆盖，不能作为新增风格依据。旧 OS 文档在其既有作用域内用于维护，不适用于跨域创建新视觉体系。历史 `styles/design-system.css` 已退役，不再作为运行来源。

## Working Rule

Every new visible UI must answer three questions before styling:

1. Material role: what physical surface is this?
2. State model: does it have idle, hover, press, active, focus, or selected behavior?
3. Layout role: is it chrome, content, scrolling content, overlay, or inline metadata?

If a design cannot answer those questions, it is not ready to become a new UI pattern.

For new pages, answer four additional inputs before layout:

1. Page type.
2. Primary task.
3. Information density.
4. Dominant content model.

The grammar should then derive the page shell, material levels, component states, adaptive color roles, and content language. If two visual outcomes remain possible, the missing input must be named instead of solved with local styling.

## Deliverables

V1 consists of four code-backed artifacts:

- Final design tokens: CSS custom properties and TypeScript recipes.
- Design grammar: this directory plus `components/ui/bambookDesignSystem.ts`.
- Material library: UI Lab should render every category listed in `BAMBOOK_MATERIAL_LIBRARY_CATEGORIES`.
- Migration rules: tests and audit scripts prevent new page-local visual values.

## Documents

- `component-application-spec.md`: **BDS v2.2 应用层真源** — 语境 × 元素决策矩阵（高度规格、搜索/工具条/按钮/下拉/容器/列表范式、页面骨架、落地判定流程）。
- `design-constitution.md`: principles that cannot be violated.
- `tokens.md`: primitive, semantic, and decision token layers.
- `layout-grammar.md`: page shell, sidebar shell, split workspace, toolbar, grid, detail, form, table, spacing, canvas, density, and structural rules.
- `material-grammar.md`: material levels, lighting, shadow, fade, mask, and ghost shadow.
- `flat-material-authority.md`: flat material ownership, migration shield boundaries, and forbidden local material patterns.
- `rdl-component-authority.md`: RonDesignLab official-site component evidence, Bambook transfer boundaries, and shared pill/search/filter/card dialect.
- `component-grammar.md`: component families and state matrices.
- `content-language.md`: interface language, labels, empty states, and missing values.
- `page-generation.md`: how to derive a new page into one valid shape.
- `design-compiler.md`: compiler-level fidelity, provenance, slots, and no page-local visual output.
- `governance.md`: migration order, audit rules, review gates, and legacy boundaries.
- `class-ownership.md`: current ownership map for authority, role, recipe, bridge, legacy, and protected visual classes.
- `known-rendering-issues.md`: confirmed rendering-level issues and debugging order for low-level material bugs.

## Retired Documents

These older design notes are no longer active grammar:

- `material-levels.md`: merged into `material-grammar.md`.
- `component-rules.md`: merged into `component-grammar.md`.
- `migration.md`: replaced by `governance.md`.
- `bambook-ui-spec.md`: archived historical Command Center / Neural UI spec.
- `docs/Bambook-OS-UI-Guidelines.md`: archived intermediate UI guideline.
- `docs/UI_AUDIT_REPORT.md`: archived historical UI audit.

Do not cite retired documents for new UI. If a retired document conflicts with this directory or `components/ui/bambookDesignSystem.ts`, use the current responsibility table and explicit conflict decisions above; the registry is not an override.

## Non-Negotiables

- Do not create page-local glass colors, shadows, selected fills, input rims, or hover materials.
- Do not treat `styles/flat-experimental.css` as a design authority. Route durable changes through the existing owner for the affected surface; new BDS business content uses the BDS layers above.
- Do not stack blue-white film inside blue-white film. Level 1 may use shared glass; nested levels must use nested or derived material.
- Do not use selected styling for hover-only controls.
- Do not put edge fade on the wrong node. The scroll viewport owns fade timing; the glass surface owns mask fidelity; ghost siblings own outward shadow when needed.
- Do not introduce a fourth-level surface by guessing a new color. Derive it from the level system.
- Do not add instructional or marketing copy inside operational UI.
- Do not add a new page without declaring material role, state model, layout role, and content role for every visible element.
- UI Lab 2.0 is the compiler review surface. Current UI Lab references are source material, but only `accepted` compiler outputs become standards.
