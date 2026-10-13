# Bambook Project Cleanup Map

This document is the working map for periodic Bambook cleanup. It is not a deletion list by itself. Use it to decide where to inspect first, which source is authoritative, and what must be marked or migrated before removal.

Last reconciled: 2026-07-24

> Historical context is retained below, but it is not a current file inventory. The old UI Lab 1/2 source entries and the legacy candidates listed in §6 were removed before this reconciliation. For current workspace rules, use [WORKSPACE_HYGIENE.md](./WORKSPACE_HYGIENE.md).

## 1. Operating Rule

Before fixing or reorganizing anything, identify the target surface:

1. Main desktop app: `/`, Electron or browser, root `.bambook-os-root`.
2. Panda UI Lab: `/dev-panda-lab.html`, dev-only review surface.
3. Historical UI Lab 1/2: retired source entries; do not use as runtime targets.
4. Mobile/PWA: phone gate in `index.tsx`, current app is `pwa/mobile/MobileWebApp.tsx`.
5. Backend API: `server/src/index.ts`, default local port `8081`.
6. Ops panel: `server/ops-panel/src/index.ts`, default local port `8088`.

Do not infer behavior from a neighboring surface. Shared CSS and shared components can make UI Lab, Electron, browser, and PWA look related while using different entry contracts.

## 2. Current Authority

### Visual System

Primary authority:

- `styles/os-vnext.css`: runtime material rendering, root scopes, glass variables, shadows, borders, filters.
- `components/ui/bambookOsTokens.ts`: semantic recipes, layout geometry, typography, controls, module shell classes.
- `components/ui/osMaterial.ts`: material role names.
- `components/ui/SidePanelContainer.tsx`: shared panel primitive, material role binding, spotlight, shadow ownership.
- `components/ui/osCompiler/*`: compiler-owned templates and primitives for accepted or provisional compiler surfaces.
- `components/ui/bambookDesignSystem.ts`: registry tying design rules, docs, tests, and source ownership together.

Legacy or bridge layers:

- `index.css`: still active, but many blocks are bridge or historical runtime support. Treat it as "must inspect", not as a new design source.
- `styles/design-system.css`: historical Command Center stylesheet. Do not add new Bambook OS material values here.
- `components/ui/osVNext.ts` and `components/ui/OSPrimitives.tsx`: early primitive layer. Treat as weak-mainline unless a current surface proves otherwise.

### Module System

The main app has no independent router. `App.tsx` conditionally renders by `activeView === View.*`.

Module metadata now starts in:

- `components/moduleRegistry.ts`

The registry owns the first shared read model for:

- product label
- icon
- primary navigation visibility/order
- permission requirement metadata through `lib/modulePermissions.ts`
- compiler surface query/localStorage key
- settings sub-view mode

The first migrated call sites are:

- `components/Sidebar.tsx`
- `components/ui/osCompiler/compiledSidebarTemplates.tsx`
- `App.tsx` settings mode and compiler surface key lookup
- `services/authService.ts` view permission lookup

Remaining cleanup target:

- `View`
- entry component
- page render registry, if it ever becomes worth the risk

## 3. Entry Map

| Surface | Entry | Notes |
| --- | --- | --- |
| Browser desktop app | `index.html` -> `index.tsx` -> `App.tsx` | Real app root is `.bambook-os-root`. |
| Electron desktop app | `electron/main.ts`, `electron/preload.ts`, renderer app | Adds `.is-electron`, IPC, zoom lock, frameless chrome, local capabilities. |
| Mobile/PWA | `index.tsx` device gate -> `pwa/mobile/MobileWebApp.tsx` | Do not chase old `MobilePwaApp` unless explicitly auditing legacy. |
| Panda UI Lab | `dev-panda-lab.html` -> `dev-panda-lab.tsx` | Current dev-only review surface. |
| Historical UI Lab 1/2 | Removed | Do not use as a runtime or cleanup target. |
| API server | `server/src/index.ts` | Local server only when the stack starts it. |
| Ops panel | `server/ops-panel/src/index.ts` | Deployment/ops control surface, separate from product app. |

## 4. Module Map

| Product label | Current `View` | Current entry | State |
| --- | --- | --- | --- |
| 全景看板 | `Dashboard` | `CompiledDashboardPage` / `Dashboard` | Accepted compiler surface with legacy fallback. |
| AI 助手 | `Assistant` | `Assistant` in compiler slot | Provisional slot, page still owns many details. |
| 关系智库 | `Relations` | `CompiledRelationsPage` / `RelationsManager` | Accepted compiler surface with legacy fallback. |
| 数字档案 | `Products` | `CompiledProductsPage` / `ProductsManager` | Accepted compiler surface, mixed with product settings workspace. |
| 生产管理 | `Orders` | `OrderManager` / `GarmentOrders` | Provisional, uses internal `orderType`. |
| 开发管理 | `Development` | `DevelopmentManager` | (Completed) Renamed from Samples / SampleManager in June 2026. |
| 智能邮箱 | `Emails` | `EmailManager` | Provisional slot. |
| 数据中心 | `KnowledgeBase` | `DataTwinCenter` | Naming mismatch; old `KnowledgeBase.tsx` remains. |
| 设置 | `Settings`, `AccountSettings`, `SystemSettings` | `CompiledSettingsPage` / `Settings` | Accepted compiler surface, mode-based sub-view. |
| 业务工具 | `BusinessTools` | `BusinessTools` | Provisional slot. |
| 管理后台 | `AdminPanel` | `AdminPanel` | Provisional slot; permission/nav mismatch risk. |

## 5. Known Drift And Confusion Points

### Visual Naming Drift

- `glass-panel` is an old entry class. Inside `.bambook-os-root` and `.ui-lab-real-os-root`, `os-vnext.css` overrides its real material.
- `bambook-dashboard-glass-color` sounds Dashboard-specific but now acts as a general glass film class through `BAMBOOK_OS.material.glassColor`.
- `os-material-*` is a material role, not a complete visual. The final look also depends on scoped CSS and `data-os-shadow-*`.
- `bambook-blue-white-light` and `bambook-blue-white-surface` are film or color modifiers, not panel hierarchy.
- `bambook-outer-panel` is frame/shadow semantics, not the material itself.

### Module Naming Drift

- `View.Samples` / `SampleManager` was renamed to `View.Development` / `DevelopmentManager` in the codebase.
- `View.KnowledgeBase` currently opens "数据中心" through `DataTwinCenter`.
- `Products` means "数字档案" in product language.
- `Orders` means "生产管理", while fabric/garment order state lives inside page state.

### Runtime Drift

- Compiler switches can persist through URL or localStorage and change which surface is rendered.
- Electron adds `.is-electron`, preload bridge, window controls, and local capabilities.
- Vite proxy and API-base resolution can disagree; inspect actual runtime API base before debugging data.
- Historical docs may describe older Zhipu/Chroma paths that no longer match current server/AI provider wiring.

## 6. High-Confidence Legacy Candidates

**Reconciled 2026-07-24:** the paths below no longer exist in this checkout. This section is retained only as a completion record; do not re-open them as live deletion work.

1. Old mobile PWA shell:
   - `pwa/mobile/MobilePwaApp.tsx`
   - `MobilePwaDashboard`
   - `MobilePwaDock`
   - `MobilePwaRelationsView`
   - old `.bambook-pwa-mobile` CSS blocks
2. Classic assistant/panda window:
   - `components/AgentPetWindowClassic.tsx`
   - `components/mascot/BambookPandaAgentClassic.tsx`
3. Unused old brand components:
   - `components/PandaIcon.tsx`
   - `components/BambookLogo.tsx`
   - `components/Logo.tsx`
4. Outdated cleanup notes:
   - `server/prisma/PHASE6_CLEANUP_NOTES.md`
5. Stale config references:
   - `vite.config.ts` still ignoring old `components/mobile/**`

## 7. Do Not Delete Casually

- `styles/design-system.css`: legacy, but still imported.
- `components/ui/osCompiler/*`: duplicated with real pages, but still used by the main application; do not remove without a dedicated render-path audit.
- `bambook-shadow-sibling-stack`, `data-glass-edge-mask`, `GlassEdgeFadeShadow`: current edge-fade shadow mechanism.
- Backend legacy sync routes during deployment cutover.
- `server/ops-panel` and `server/scripts/ops/*`: deployment and operations may call them without frontend imports.
- Database migrations and migration scripts.

## 8. Cleanup Phases

### Phase 0: Freeze The Map

Output:

- This document.
- Class ownership table.
- Module registry plan.
- Runtime entry rules.

No deletion.

### Phase 1: Module Registry

Create a single module registry for app modules.

Status: first pass complete. `Sidebar.tsx`, `compiledSidebarTemplates.tsx`, Settings mode resolution, and compiler key lookup now read from `components/moduleRegistry.ts`.

Target ownership:

- view id
- product label
- icon
- permission
- compiled surface key
- fallback component
- sub-view model
- navigation visibility

Risk: medium. It touches routing-like behavior, permissions, and navigation.

### Phase 2: Visual Ownership Table

Document and then enforce class ownership:

- old entry classes
- active material roles
- semantic token recipes
- compiler primitives
- page-local bridges

Risk: low if documentation only; medium when replacing classes.

### Phase 3: Mark Legacy

Add explicit deprecation markers or cleanup notes for high-confidence legacy candidates. Do not remove yet.

Risk: low.

### Phase 4: Migrate Bridges

Start with low-risk surfaces:

- new pages should use `BAMBOOK_OS + SidePanelContainer + osCompiler`.
- Sample/Development page can be used as a cleaner reference.
- Avoid changing Dashboard first because it combines globe, HUD, pointer events, and edge fade.

Risk: medium.

### Phase 5: Remove Dead Paths

Only after references, manual entry points, and deployment scripts are checked:

- old PWA shell
- classic assistant/panda window
- unused brand components
- stale cleanup docs
- stale config ignores

Risk: medium, because some paths may be manual/dev-only.

## 9. Investigation Rules

Use this order when debugging:

1. Confirm target surface and runtime.
2. Confirm root scope.
3. Confirm whether compiler surface is active.
4. Confirm actual rendered component, not just similarly named file.
5. For visual bugs, inspect active material role and scoped CSS before old `index.css`.
6. For data/auth bugs, inspect API base and server route before assuming local dev state.
7. For Electron-only bugs, inspect preload, `.is-electron`, IPC, and window shell first.

## 10. Immediate Next Actions

Recommended next work:

1. Keep `components/moduleRegistry.ts` as a read-only metadata source until navigation, permissions, compiler switching, and rendering are migrated in separate phases. See `docs/MODULE_REGISTRY_PLAN.md`.
2. Use `docs/design-system/class-ownership.md` before changing shared visual classes.
3. Use `docs/design-system/known-rendering-issues.md` before changing low-level material rendering.
4. Use `docs/LEGACY_CLEANUP_INVENTORY.md` before marking or deleting legacy files.
5. Decide code-level rename targets:
   - `Samples` -> (Completed) Renamed to development domain naming in June 2026.
   - `KnowledgeBase` -> data center / data twin naming.
6. Add a short "How to debug Bambook surfaces" section to project docs.
