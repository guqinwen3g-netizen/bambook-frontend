# Component Grammar

Components are generated from material role plus state model.

## Button

Families:

- Action button: idle, hover, press.
- State button: idle, hover, press, selected.
- Icon button: same states, icon-only when the symbol is familiar.

Use:

- `BAMBOOK_OS.controls.actionControl` for one-shot actions.
- `BAMBOOK_OS.controls.stateControl` for controls with persistent state.
- `bambook-selected-surface` plus light or dark variant for selected state.
- `BAMBOOK_OS.controls.selectedSurface` is the only code entry for the accepted selected button material.

Rules:

- Selected styling is persistent only.
- Hover must not look selected.
- Press may compress or move by a small amount.
- Buttons should use lucide icons when a standard icon exists.
- Selected light mode uses the shared selected-light token family.
- Do not compose a selected button from `stateControl.baseLight/baseDark` alone. The accepted selected state must include `selectedSurface.light` or `selectedSurface.dark`.

## Navigation Row And Drill Button

Navigation rows are buttons with a fixed component rhythm, not local cards.

Use:

- `BAMBOOK_OS.controls.navigationRow.base` for category rows.
- `BAMBOOK_OS.controls.navigationRow.compact` for drill-in rows.
- Idle rows use `BAMBOOK_OS.controls.actionControl`.
- Selected rows use `BAMBOOK_OS.controls.selectedSurface`.

Rules:

- Height, radius, padding, transition, and selected effect come from the navigation row and selected-surface tokens.
- Do not create page-local classes such as independent `rounded-*`, `px-*`, `py-*`, background, border, or shadow recipes for module navigation buttons.
- Category rows use bare icons, label, and optional short description.
- Drill-in rows stay compact and do not use tertiary container material as a button substitute.

## Title Bar And Breadcrumb

Title bars are page chrome, not content headers.

Use:

- `BAMBOOK_OS.layout.desktopTitleBarWithInsetClass` for title placement.
- `BAMBOOK_OS.controls.title.textButton` for the root module title.
- `BAMBOOK_OS.controls.title.separator` with the shared chevron for breadcrumb separators.
- `BAMBOOK_OS.controls.title.pageLabel` for child labels.
- `BAMBOOK_OS.controls.title.backButton` for title back navigation.

Rules:

- Four-character Chinese module names split 2+2 when brand color is used.
- Child labels stay as breadcrumb labels and do not join the brand-colored title.
- The title back icon uses the same chevron family and sizing as existing navigation pages.
- Section headers inside a panel must not reuse page-title size.

## Icon

Icons are part of content rhythm, not automatic decorative objects.

Rules:

- Category cards, navigation rows, panel headers, and detail sections use bare lucide icons by default.
- Do not wrap every icon in a circular or rounded square container.
- Icon wells are allowed only for accepted component families that already use them, such as title icon buttons, empty states, avatar-like account surfaces, or existing Settings option rows.
- A new icon container requires a component role. It cannot be added as decoration.
- Icon stroke stays light and quiet; the surrounding material surface provides hierarchy.

## Input And Select

Inputs are recessed.

Use:

- `BAMBOOK_OS.controls.recessedField`
- `BAMBOOK_OS.controls.select.toolbar*` for toolbar select triggers.

Rules:

- Text input, date input, textarea, and select trigger share the recessed family.
- Focus is a subtle pressed/inset state.
- Placeholder text is quieter than value text.
- Error state adds semantic feedback without changing the material family.
- Single-line fields use the `h-9`, `text-xs`, rounded field language already in the token recipes.
- Select triggers and text inputs should visually belong to the same recessed family.
- Text inputs, date inputs, and textareas need both the shared `recessedField` recipe and an actual `border` width class.
- Native date controls must keep their calendar indicator aligned with field text color.

## Switch

Switches use iOS-like thumb geometry:

- Thumb is wider than half the track.
- Track carries state.
- Thumb carries the main highlight.

Rules:

- Do not replace a binary switch with segmented control styling.
- Off state is still an interactive control, not disabled.

## Chip And Badge

Chips are metadata. Badges are semantic status.

Use:

- `BAMBOOK_OS.tone.chip`
- `BAMBOOK_OS.tone.status`

Rules:

- Metadata chips stay quiet.
- Semantic badges may use color only when color communicates state.
- Decorative color is forbidden.

## Table

Tables are dense operational components.

Use:

- `BAMBOOK_OS.controls.table`

Rules:

- Header is fixed when body scrolls.
- Row hover is not card hover.
- Table highlight spans row content width and should not use card shadow bleed.
- Row hover/highlight must span the full table content width and use squared row edges inside the table flow.
- Table rows inside a level-1 table panel are transparent rows with separators. Do not apply `raisedCard`, `insetSurface`, or card shadows to each row.
- Row separators are inner hairlines inside the masked row element, not `border-b` on a separate visual edge. They must fade with the row at scroll boundaries.
- Dense table row masks use bottom zone activation, so row separators fade as soon as they enter the bottom boundary fade area instead of waiting until the row crosses the viewport edge.
- Dense tables may use the ghost-shadow edge-fade primitive: the real glass node keeps `data-glass-edge-mask`, the outward shadow layer keeps `data-glass-edge-mask-shadow-caster`, and `useGlassSurfaceEdgeMasks` applies the table viewport boundary.
- Fullscreen form stacks with multiple large panels use the same surface-level ghost-shadow edge fade as tables: `useGlassSurfaceEdgeMasks` masks each real glass node and its ghost shadow caster, never the scroll ancestor.
- UI Lab zoom must not change the visual fade size. Edge-fade utilities normalize DOMRect coordinates and fade distances against `--ui-lab-app-scale`.
- Do not use `ScrollEdgeFades` or `mask-image` on the fullscreen form scroll ancestor; masking the ancestor can drop child `backdrop-filter` materials.
- Row actions use small action controls.
- Empty table state lives inside the table surface.

## Modal, Popover, Toast

Overlays use floating material.

Rules:

- Modal: blocking decision or focused task.
- Popover: contextual choices.
- Toast: short status feedback.
- All overlays need dismiss behavior and focus return.
- Overlays do not introduce new glass families.
- Drawers are for lightweight contextual inspection or short actions only.
- Complex module administration must open a main-area workspace; do not compress backstage configuration into a drawer.

## Empty, Loading, Error

These are content states inside an existing material.

Rules:

- Empty state gives one cause and at most one primary next action.
- Loading state is quiet and does not create a new surface.
- Error state uses semantic danger but keeps the parent material.

## Scroll Fade

Use:

- `ScrollEdgeFades` for scroll viewport boundaries.
- `SidePanelContainer edgeFadeItem` or `GlassEdgeFadeShadow` when masked glass still needs outward shadow.

Rules:

- Fade bounds are measured from the real scroll viewport.
- The glass node and its ghost shadow caster receive paired masks.
- Ghost shadow siblings may carry outward shadow but must not add visible content, blur, or pointer behavior.
