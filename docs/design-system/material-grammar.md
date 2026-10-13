# Material Grammar

Material grammar defines how surface, color, light, border, shadow, fade, and mask work together.

The active product direction is flat material: matte or frosted surfaces without container-level depth shadow, visible rim, or raised-card illusion by default. Existing shadow and rim roles in this document are compatibility vocabulary for legacy migration unless a role is explicitly re-approved in `flat-material-authority.md` and rendered through `styles/os-vnext.css`.

## Surface Layers

Every material is a stack. In flat mode, layers 3-5 are normally disabled or transparent:

1. Base film.
2. Background gradient.
3. Border or rim.
4. Top highlight.
5. Depth shadow.
6. Optional spotlight.
7. Optional edge fade or ghost shadow.

Pages cannot add one of these layers locally unless the grammar has a role for it. New UI should prefer base film, blur, color contrast, spacing, and typography before adding any rim or depth layer.

## Surface And Shadow Are Separate

Container material and depth shadow are separate contracts. In the current flat direction, `shadowRole` should resolve to no outward depth for normal containers.

Code roles:

- `surfaceRole` / `materialRole`: chooses the visible film, rim, backdrop blur, and background sampling.
- `shadowRole`: chooses the depth token.
- `shadowMode`: chooses how the shadow is attached.

Allowed shadow roles:

- `sidebarShell`: global sidebar shell only.
- `frame`: normal level-1 main panel.
- `raised`: level-2 raised section.
- `secondary`: level-2 inset or quieter section.
- `floating`: popover, menu, modal, and root-level overlay.
- `selected`: selected-light family and selected-like inline surface.
- `none`: explicit no-shadow surface.

Allowed shadow modes:

- `attached`: the surface carries its own shadow.
- `ghost`: a sibling shadow caster carries outward shadow while the real glass node can be masked for scroll fade.
- `none`: no outward depth.

Rules:

- Do not infer shadow size from container class alone.
- Do not create new shadow-bearing containers. Treat non-`none` shadow roles as legacy compatibility unless a current flat-material exception names them.
- `edgeFadeItem` is compatibility shorthand for `shadowMode="ghost"`.
- Use ghost shadow only when a scroll mask or edge fade would clip required outward shadow.
- Do not wrap outer frame panels in ghost shadow just to get depth; use `shadowRole="frame"` with `shadowMode="attached"`.
- Sidebar must be explicit: `surfaceRole="framePanel"` plus `shadowRole="sidebarShell"` plus `shadowMode="attached"`.

## Shared Glass

Shared blue-white glass belongs to level 1 only.

Use:

- Frame panels.
- Sidebar panel.
- Primary app surfaces.
- Floating overlays when they are root-level surfaces.

Do not use shared glass inside a panel.

### Shell: Sidebar Frame

The sidebar is the highest persistent shell surface.

Use for the global sidebar only.

Code:

- `SidePanelContainer surfaceRole="framePanel" shadowRole="sidebarShell" shadowMode="attached"` inside `Sidebar`
- `--ui-lab-panel-shared-glass-background`
- `--ui-lab-panel-sidebar-shadow`

Rules:

- Sidebar sits above main-area panels on the Z axis.
- Sidebar shadow is intentionally larger than main level-1 frame shadow.
- Do not reuse sidebar shadow for normal main panels.

### Level 1: Frame Panel

Use for main app containers, settings main surfaces, and primary detail shells.

Code:

- `SidePanelContainer materialRole="framePanel" materialTone="panel"`
- default `shadowRole="frame"`
- `OS_MATERIAL.framePanel`
- `--ui-lab-panel-shared-glass-background`
- `--ui-lab-panel-frame-shadow`

Rules:

- This is the only normal container level allowed to carry the shared blue-white glass film.
- It may own major page structure and scroll viewport chrome.
- Fullscreen add/edit form panels and Form Map panels use level-1 frame material because they sit directly on the page background.
- It must not be nested repeatedly inside another level-1 panel.
- Its shadow is smaller than sidebar shell shadow.

## Nested Glass

Nested surfaces use a quieter background without the blue-white film.

Use:

- Sections.
- Detail blocks.
- Nested groups inside form panels.

Nested glass must not look like a second level-1 panel.

### Level 2: Nested Raised Or Inset Surface

Use for sections inside a level-1 panel.

Code:

- `SidePanelContainer materialRole="raisedCard" materialTone="nested"`
- `SidePanelContainer materialRole="insetSurface" materialTone="nested"`
- default `shadowRole="raised"` for raised card and `shadowRole="secondary"` for inset surface
- `--ui-lab-panel-nested-glass-background`
- `--ui-lab-panel-raised-shadow`
- `--ui-lab-panel-secondary-shadow`

Rules:

- No blue-white shared film.
- Use raised when the section needs physical separation.
- Use inset when the section reads as grouped content carved into the parent.
- Shadow must not bleed so far that it changes the color of the next container.
- Do not use level-2 material for fullscreen add/edit form panels that sit directly on wallpaper/background.

## Tertiary Surface

Level 3 surfaces are small inline containers.

Light mode uses the selected button rim/highlight family. Dark mode keeps the accepted tertiary gradient.

This creates a consistent logic: the deeper the level, the more it behaves like a controlled inline surface instead of a new panel.

### Level 3: Tertiary Inline Surface

Use for small inline status groups, chips, and compact metadata rows that must read quieter than a nested panel.

Code:

- `bambook-tertiary-surface`
- Light mode: `--bambook-selected-light-background`, `--bambook-selected-light-shadow`, `--bambook-selected-light-border-color`
- Dark mode: accepted dark tertiary gradient in `index.css`

Rules:

- Light mode must use the selected-button rim and highlight family.
- Dark mode keeps the accepted dark tertiary material and is not reduced further by light-mode tuning.
- It is quieter than level 2 and must not become a separate blue-white surface.
- Structured form rows, address blocks, and repeatable sub-record panels use level-2 `raisedCard`, not tertiary surface.

### Level 4: Derived Micro Surface

There is no current rendered level-4 container. The grammar still defines how one must be derived if a future UI proves it is necessary.

Derivation rules:

- Start from level 3.
- Reduce fill strength instead of adding brightness.
- Keep the same rim/highlight family.
- Default to inset-only shadow.
- Do not add outward depth unless the element truly floats above its parent.
- Prefer spacing, typography, dividers, or content grouping before creating a visible fourth surface.

Forbidden:

- New color family.
- New blue glow.
- Heavier shadow than level 3.
- A second selected-like system.

## Shadows

Shadow must match material role:

- Level 1 frame: frame shadow.
- Sidebar shell: sidebar shadow, larger than frame shadow.
- Level 2 raised: raised shadow.
- Level 2 inset: secondary shadow.
- Floating overlay: floating shadow.
- Selected and selected-like tertiary: selected-light shadow in light mode, selected-dark shadow in dark mode.

Rule: a shadow should clarify hierarchy, not recolor the next sibling.

If a surface is masked for scroll fade, outward shadow must be carried by `GlassEdgeFadeShadow` or `SidePanelContainer edgeFadeItem`, which maps to `shadowMode="ghost"`.

Ghost shadow casters may only render depth tokens:

- Frame ghost: `--ui-lab-panel-frame-depth-shadow`.
- Sidebar ghost: `--ui-lab-panel-sidebar-depth-shadow`.
- Raised ghost: `--ui-lab-panel-raised-depth-shadow`.
- Secondary ghost: `--ui-lab-panel-secondary-depth-shadow`.
- Floating ghost: `--ui-lab-panel-floating-depth-shadow`.

They must never render full shadow tokens that include inset rim or highlight. The real glass node owns inset rim/highlight; the ghost sibling owns only outbound depth.

Ghost shadow casters participate in edge fade. A masked scrolling panel must fade its real glass node and its ghost caster together, otherwise content disappears while the outer shadow remains visible.

Fullscreen form stacks are the exception: do not mask the scroll ancestor. Each large panel keeps its own real glass node plus ghost shadow caster, and the form viewport uses fixed overlay fades above the stack. This preserves child `backdrop-filter` material under UI Lab scaling.

Ghost shadow caster DOM contract:

- The caster element may use only `bambook-sibling-shadow-caster` plus data role attributes.
- It must not use `bambook-outer-panel`.
- It must not use any `os-material-*` class.
- It must not use `data-glass-edge-mask`; real glass nodes and ghost casters are selected through separate attributes.
- It must expose `data-glass-edge-mask-shadow-caster` so mask utilities can identify it and apply the same edge fade without treating it as a real glass surface.

## Spotlight

Spotlight is a material response, not decoration.

Use:

- Main panels.
- Major cards.
- Interactive surfaces that already have a material role.

Do not add spotlight to every child inside a panel.

Spotlight clipping:

- The tracking-light mask must inherit the host surface radius.
- The tracking-light scope is the host border box. The rim and border must receive the same spotlight response as the panel interior.
- The tracking-light layer sits on the top z-plane above panel content and border; do not create a second independent border light.
- The layer may bleed outward by the system border width to include the visible rim.
- Do not inset the light layer away from the rim with `inset-px` or a padding-box-only mask.
- Do not use fixed-radius clip paths such as `round 1.5rem` inside `SpotlightCard`; fixed clipping drifts when a surface uses another material radius and creates corner gaps.
- The host material owns the visible corner geometry. The spotlight layer only follows it.

## Fade And Mask

Rules:

- Scroll fade bounds belong to the scroll viewport.
- The glass surface owns mask fidelity when backdrop sampling matters.
- Masked surfaces cannot carry their own outward shadow reliably.
- Use `GlassEdgeFadeShadow` or `SidePanelContainer edgeFadeItem` so the real glass layer and ghost shadow layer receive paired masks.
- Do not use ghost shadow on non-scrolling frame panels; it creates an unnecessary outer projection layer.

## Layer Isolation

A glass surface must sample the pixel layers beneath it. If a transparent parent creates an isolated rendering layer, nested glass surfaces will sample empty transparency and render as flat, dead colors.

Rules:

- Do not apply persistent CSS animations or structural transitions (e.g., Tailwind `animate-in`, `fade-in`) directly to transparent parent wrappers.
- Do not combine `overflow-hidden` with `z-index` on a transparent wrapper that houses glass surfaces.
- Use Framer Motion (`motion.div`) for entry animations, as it can clear layout transforms upon completion, preventing permanent stacking context isolation.
- If a deep-level surface suddenly loses its glass material fidelity, audit its parent tree for stray opacity or transform overrides.
