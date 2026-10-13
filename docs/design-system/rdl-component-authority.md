# Bambook RDL Component Authority

Status: working authority for the RDL alignment pass.

## Source Boundary

Confirmed first-party implementation evidence:

- RonDesignLab public website CSS, regenerated on 2026-07-08 with `ron-design-lab/scripts/extract_site_css_evidence.mjs`.
- Evidence output: `/tmp/rdl-distill/site-css-analysis/site-css-evidence.md`.
- Local distillation records:
  - `/Users/qinwengu/软件开发/设计蒸馏工程/Ron Design Lab/materials/official-site-frosted/website-shell.json`
  - `/Users/qinwengu/软件开发/设计蒸馏工程/Ron Design Lab/library-consumption.json`

Boundary:

- Official website CSS is real code for website shell components: nav pills, floating search, category docks, gallery tags, arrow controls, pastel proof cards.
- Product case UI inside RonDesignLab pages is mostly static image/video evidence. It can guide product layout and material judgment, but it is not extractable production CSS unless a live product implementation is separately verified.
- Bambook must translate these values into its own tokens and components. Do not paste whole official CSS chunks into the product.

## Official Components Worth Adopting

### 1. Frosted / White Pill Controls

Use for: top-level actions, compact filters, selected tabs, global command/search, dashboard action chips.

Evidence:

- `cases__search`: white fill, flex-centered, transition `.3s`, responsive padding around `20px-42px` vertical and `26px-52px` horizontal.
- `cases-sort__button`: white fill, `font-weight: 600`, radius `20px-40px`, height `48px-100px`.
- `main__button`: white capsule, very generous padding, transition on background.

Bambook translation:

- Product-scale controls must be smaller than the website version.
- Use capsule radius for commands and filters, not normal rectangular buttons.
- Do not copy the website's heavier marketing weight into ERP controls. Bambook default control text is `font-light` or `font-normal`.
- Active state is primarily material opacity/contrast. Use the single accent only for clear command emphasis, not for every selected filter.
- Do not use multiple competing theme colors.

### 2. Floating Search Lens

Use for: global page search, command input, dense page toolbar search.

Evidence:

- Official `cases__search` is not a normal input box; it reads as a floating lens over content.
- It has large radius, white material, centered icon/text, and soft transitions.

Bambook translation:

- Search bars should be pill/lens controls with clear internal spacing.
- Avoid nested input panels or bordered rectangular search fields.
- On dense ERP pages, use a compact variant but keep the lens grammar.

### 3. Category Dock / Segmented Filter

Use for: module filters, status tabs, category switching, page-level segmented controls.

Evidence:

- `cases__category` uses high-radius item buttons and responsive padding.
- `cases-sort__button` uses centered flex, true state, and a chevron/control icon.
- Active state is clear and high-contrast.

Bambook translation:

- Filters should be a row of pill states, not small text links in arbitrary panels.
- Each filter control must have a visible state model: idle, active, hover, disabled.
- Use one icon grammar and one chevron treatment. Do not mix glyph arrows and SVG/lucide arrows.

### 4. Frosted Tags / Media Overlay Controls

Use for: low-density metadata chips, overlay actions, image/map/tool controls.

Evidence:

- `media-card__tag-link`: hover inverts to white fill and black text.
- `next-steps-slider__next/prev`: `background: rgba(0,0,0,.1)`, `backdrop-filter: blur(15px)`, radius `19px-60px`, SVG icon width `40%`.

Bambook translation:

- Overlay controls on map/dashboard should use frosted low-alpha fill and centered icon geometry.
- Use real icon components, not text glyphs.
- Hover/active state must be designed, not only opacity change.

### 5. Pastel / Matte Proof Card

Use for: sparse highlights, low-density proof/status modules, non-operational summary cards.

Evidence:

- `images-few-things__item`: `backdrop-filter: blur(15px)`, large radius `16px-60px`, pastel/translucent fills, no visible outer stroke.

Bambook translation:

- Ordinary ERP containers should not all become colored proof cards.
- Use this only where the card has low density and status/proof function.
- Operational tables, inboxes, finance lists, and form areas should use flatter neutral matte material.

## Product UI Rules For Bambook

1. Dashboard remains the strongest in-product reference.
   It already has the right direction: primary object/background plus overlaid instruments, high-radius matte cards, no visible rim.

2. The default Bambook surface is `default-lightfuture-flat-matte`.
   Normal containers are uniform fill, `border: 0`, `box-shadow: none`, moderate backdrop blur. Boundaries come from fill, tone, radius, spacing, and content hierarchy.

3. Visible lines need a semantic role.
   Allowed: table separators, chart ticks, progress tracks, route/path lines, selected/focus state. Disallowed: generic 1px card rims.

4. Layout should be bento/rail/object-record, not equal card grids.
   Each page needs a primary object or working field, then supporting rails or bands.

5. Do not keep deleting panels as a style strategy.
   The target is not "no cards"; it is fewer levels, clearer material roles, and RDL-shaped controls.

6. Container chrome is a shared primitive, not a page-local recipe.
   Normal product containers must inherit radius, fill, blur, gap, and padding from `RdlSurface` / `.rdl-surface` tokens. Page files should not invent new combinations of `rounded-*`, `bg-*`, `border-*`, `shadow-*`, and ad hoc padding for ordinary panels, cards, or floating overlays.

7. Surface padding is explicit.
   `RdlSurface` defaults to `padding="none"` for backward-safe migration. New or migrated containers should choose `compact`, `regular`, or `loose` instead of local `p-*` utilities when the padding is part of the container shape.

8. Legacy container names are compatibility aliases only.
   `glass-panel`, `glass-card`, `os-vnext-panel`, `os-vnext-card`, `bambook-selected-surface`, and old `os-material-*` classes may remain while pages are migrated, but their visual chrome must be bridged to the same RDL surface tokens. They are not independent style systems.

## Bambook Component Dialect

The next implementation pass should define or consolidate these primitives before more page work:

- `RdlSurface`: default matte/frosted card or panel, no rim, no shadow, tokenized radius/fill/padding.
- `RdlPill`: command, action, tab, filter, and segmented-control item.
- `RdlSearch`: pill/lens search field with icon, clear state, and compact/dense variants.
- `RdlToolbar`: horizontal command strip using pill controls, not a nested panel.
- `RdlDataRow`: transparent row with semantic separator and hover state, not a material card.
- `RdlMetricCard`: dashboard/bento metric module with uniform matte fill and strong internal hierarchy.
- `RdlOverlayIconButton`: map/dashboard floating icon button using frosted low-alpha fill.

## Implementation Order

1. Lock tokens and shared primitives first.
2. Migrate page shells to consume shared primitives.
3. Then revisit individual pages in this order:
   - dashboard preservation and token extraction;
   - finance as the first dense ERP sample;
   - digital archive as the object-record layout sample;
   - assistant last because chat bubbles, markdown, tool panels, and workspace rails need a separate grammar;
   - all remaining pages after the four-page sample set is accepted.
4. Avoid page-local CSS for material, shadow, border, search, pill, row, or card shapes.

## Failure Checks

Before accepting any page:

- No visible default card rim.
- No default container gradient.
- No drop shadow used to separate normal content.
- Search/filter/action controls share pill/lens grammar.
- Rows are rows; cards are cards; panels are not nested for no reason.
- Text is opaque and readable.
- Theme/wallpaper color is not stacked through multiple tint layers.
- Component shape is shared or documented; no one-off local shape.
