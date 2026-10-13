# Class Ownership

This table defines how Bambook visual classes should be interpreted during cleanup and debugging. It does not delete or deprecate anything by itself.

Last reviewed: 2026-06-11

## Ownership Levels

| Level | Meaning | Can define new visual language? |
| --- | --- | --- |
| Authority | Current source of truth for Bambook OS visual behavior. | Yes |
| Role | Semantic marker that selects authority-owned behavior. | No, it must map to authority rules |
| Recipe | Composed class string from tokens or primitives. | No, it should reference authority or role classes |
| Bridge | Still used by runtime but exists for migration compatibility. | No |
| Legacy | Historical or weak-mainline class. | No |
| Protected mechanism | Implementation detail that may look odd but owns real behavior. | No, but do not remove casually |

## Root Scopes

| Class / selector | Level | Owner | Notes |
| --- | --- | --- | --- |
| `.bambook-os-root` | Authority scope | `App.tsx`, `styles/os-vnext.css` | Main desktop app root. Debug main-product visual issues here first. |
| `.ui-lab-real-os-root` | Authority scope | `components/UiLab.tsx`, `styles/os-vnext.css` | UI Lab 1 root. Shared styles can affect main app because rules often target both roots. |
| `[data-ui-lab-2-root]` | Authority scope | `components/UiLab2.tsx`, compiler docs | UI Lab 2 compiler review surface. |
| `.is-electron` | Runtime scope | `electron/preload.ts`, `index.css` | Electron-only renderer class. Use for Electron shell differences only. |
| `body.bambook-device-phone` | Runtime scope | `pwa/deviceMode.ts`, `index.css` | Mobile/PWA runtime scope. Do not use for desktop fixes. |

## Active Material Roles

| Class / selector | Level | Owner | Use |
| --- | --- | --- | --- |
| `.os-material-frame-panel` | Role | `components/ui/osMaterial.ts`, `styles/os-vnext.css` | Level-1 panel/frame surfaces. Needs scoped CSS to become visual. |
| `.os-material-raised-card` | Role | `components/ui/osMaterial.ts`, `styles/os-vnext.css` | Raised child card surfaces. |
| `.os-material-inset-surface` | Role | `components/ui/osMaterial.ts`, `styles/os-vnext.css` | Inset or secondary content surfaces. |
| `.os-material-floating-overlay` | Role | `components/ui/osMaterial.ts`, `styles/os-vnext.css` | Floating overlay and menu surfaces. |
| `[data-os-shadow-role]` | Role | `SidePanelContainer`, `styles/os-vnext.css` | Shadow semantic role. Inspect this together with material role. |
| `[data-os-shadow-mode]` | Role | `SidePanelContainer`, `styles/os-vnext.css` | Attached vs ghost shadow behavior. |

Rule: an `os-material-*` class is not a full material by itself. The actual material comes from root-scoped rules in `styles/os-vnext.css`.

## Shared Primitives And Recipes

| Class / source | Level | Owner | Notes |
| --- | --- | --- | --- |
| `SidePanelContainer` | Authority primitive | `components/ui/SidePanelContainer.tsx` | Preferred panel primitive. Binds material role, spotlight, shadow, and edge-fade ownership. |
| `BAMBOOK_OS.material.*` | Recipe | `components/ui/bambookOsTokens.ts` | Semantic class recipes. Do not redefine equivalent values page-locally. |
| `BAMBOOK_OS.layout.*` | Recipe | `components/ui/bambookOsTokens.ts` | Page canvas, sidebar, title, panel geometry. |
| `BAMBOOK_OS.controls.*` | Recipe | `components/ui/bambookOsTokens.ts` | Buttons, toolbar, table, input, selected states. |
| `CompiledSurfacePanel` | Authority primitive | `components/ui/osCompiler/compiledSurfacePrimitives.tsx` | Compiler-facing panel primitive. Eventually should converge with `SidePanelContainer`. |
| `CompiledModuleTitleBar` | Authority primitive | `components/ui/osCompiler/compiledPrimitives.tsx` | Preferred title/header structure for compiler-aligned modules. |
| `CompiledTableShell` | Authority primitive | `components/ui/osCompiler/compiledPrimitives.tsx` | Preferred table shell for compiler-aligned modules. |

## Bridge Classes Still In Runtime

| Class / selector | Level | Owner | Current interpretation |
| --- | --- | --- | --- |
| `.glass-panel` | Bridge | `index.css`, overridden by `styles/os-vnext.css` in OS roots | Old entry class. In `.bambook-os-root` or `.ui-lab-real-os-root`, inspect `os-vnext.css` before `index.css`. |
| `.bambook-panel-glass` | Bridge | `index.css`, `styles/os-vnext.css` | Panel glass bridge. Treat like `.glass-panel`. |
| `.bambook-dashboard-glass-color` | Bridge recipe | `BAMBOOK_OS.material.glassColor`, `styles/os-vnext.css` | Despite the name, this is now a common glass film marker, not Dashboard-only. |
| `.liquid-glass-card` | Bridge | `index.css`, Dashboard | Historical card material. Still used by Dashboard selectors and edge-fade logic. |
| `.bambook-blue-white-light` | Bridge modifier | `index.css`, `bambookOsTokens.ts` | Color/film modifier. Not a material level. |
| `.bambook-blue-white-surface` | Bridge modifier | `index.css`, `bambookOsTokens.ts` | Surface film modifier. Not a panel hierarchy marker. |
| `.bambook-outer-panel` | Bridge/role | `SidePanelContainer`, `index.css`, `styles/os-vnext.css` | Frame/shadow semantic marker. Material still depends on `os-material-*` and root CSS. |
| `.bambook-settings-*` | Page bridge | `Settings.tsx`, `index.css` | Settings-specific bridge styles. Do not generalize without moving into tokens. |

Rule: bridge classes may remain while pages migrate. Do not use them as proof that `index.css` is the active material source.

## Protected Mechanisms

| Class / selector | Level | Owner | Why protected |
| --- | --- | --- | --- |
| `.bambook-shadow-sibling-stack` | Protected mechanism | `GlassEdgeFadeShadow`, `index.css` | Supports ghost shadow while allowing masked scroll edges. |
| `.bambook-sibling-shadow-caster` | Protected mechanism | `GlassEdgeFadeShadow`, `index.css` | Shadow proxy for masked panels. |
| `[data-glass-edge-mask]` | Protected mechanism | `useGlassSurfaceEdgeMasks`, `index.css`, `styles/os-vnext.css` | Receives dynamic masks for scroll fade. |
| `[data-glass-edge-mask-shadow-caster]` | Protected mechanism | `GlassEdgeFadeShadow`, `styles/os-vnext.css` | Separate shadow caster; should not render glass material. |
| `.ui-lab-scroll-edge-shadow-layer` | Protected mechanism | `styles/os-vnext.css`, compiler primitives | Scroll edge shadow layer. |

Rule: these can look redundant. Do not delete or simplify them until a specific edge-fade/shadow audit proves the replacement.

## Legacy Or Weak-Mainline Classes

| Class / source | Level | Owner | Cleanup posture |
| --- | --- | --- | --- |
| `.os-vnext-panel`, `.os-vnext-card`, `.os-vnext-button`, etc. | Legacy/weak-mainline | `styles/os-vnext.css`, `components/ui/osVNext.ts` | Early primitive layer. Confirm live usage before extending. |
| `styles/design-system.css` classes | Legacy | `styles/design-system.css` | Runtime legacy only. Do not add new Bambook OS material values. |
| `.bambook-pwa-mobile` | Legacy/mobile bridge | old mobile PWA shell | Tied to old `MobilePwa*` path. Mark before deleting. |
| classic pet/window files | Legacy | `AgentPetWindowClassic`, classic mascot | File-level candidate only. Do not mark the shared `bambook-agent-pet-*` class family as legacy; the current non-classic pet window still uses it. |

## Debugging Order For Visual Classes

When a visual bug mentions a class:

1. Identify the rendered root: `.bambook-os-root`, `.ui-lab-real-os-root`, UI Lab 2, or mobile.
2. Check whether the class is role, recipe, bridge, legacy, or protected mechanism.
3. If inside `.bambook-os-root` or `.ui-lab-real-os-root`, inspect `styles/os-vnext.css` scoped overrides before `index.css`.
4. Inspect `BAMBOOK_OS` recipes only after confirming the class string actually comes from a token.
5. Inspect page-local classes last unless the element is not using shared primitives.
6. If a bridge class is still needed, migrate by introducing a semantic token or primitive first, then replace call sites.

## Migration Rules

1. New UI should prefer `SidePanelContainer`, `BAMBOOK_OS`, and compiler primitives.
2. Do not introduce new page-local glass films, shadows, selected fills, hover materials, input rims, or scroll fade logic.
3. Do not add new values to `styles/design-system.css`.
4. Do not add new broad overrides to `index.css` unless they are explicitly marked as bridge/runtime compatibility.
5. Do not remove bridge classes until all call sites and runtime surfaces are mapped.
6. Do not replace protected mechanisms with simpler CSS without checking scroll, mask, shadow, and Electron rendering.

## Cleanup Targets

First-pass targets for marking, not deletion:

- old `MobilePwa*` class families and `.bambook-pwa-mobile` CSS.
- classic assistant/panda window files. Do not include the shared `bambook-agent-pet-*` class family in this target.
- unused brand component classes from old logo/icon paths.
- stale config references to removed `components/mobile/**`.

Second-pass targets for migration:

- Dashboard uses of `.glass-panel` / `.liquid-glass-card`.
- Product and relation bridge classes that can become pure `os-material-*` plus token recipes.
- Settings page-local controls that can become `BAMBOOK_OS.controls.*`.

Last-pass targets for deletion:

- old PWA shell CSS after no manual entry remains.
- classic assistant window files after no manual/dev entry remains.
- stale docs and config once replacement docs are linked.
