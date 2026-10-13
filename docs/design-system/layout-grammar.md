# Layout Grammar

Layout is a contract, not a local design choice. A page must be generated from a page type, a shell, a panel row, and a content pattern before any component is placed.

## Layout Roles

Every visible layout must declare these roles:

- Page shell.
- Title bar.
- Panel row.
- Main panel or split workspace.
- Scroll viewport.
- Content pattern: toolbar, grid, detail stack, form stack, table, or empty state.

If a new page cannot pick one of these roles, the grammar is missing a role. Do not fill the gap with page-local spacing.

## Global Sidebar Shell

Use:

- `BAMBOOK_OS.layout.desktopSidebarShellClass`
- `SidePanelContainer surfaceRole="framePanel" shadowRole="sidebarShell" shadowMode="attached"`

Geometry:

- Left inset: `16px`.
- Top inset: `16px`.
- Bottom inset: `16px`.
- Width: `288px`.

Rules:

- Sidebar is persistent shell chrome, not a page panel.
- Sidebar shadow is larger than main frame shadow.
- Main panels must not copy sidebar top/bottom inset or shadow.
- Sidebar internal spacing belongs to Sidebar only; it is not a general panel recipe.

## Desktop Page Shell

Use:

- `BAMBOOK_OS.layout.desktopPageFrameClass`
- `BAMBOOK_OS.layout.desktopPageCanvasClass`

Geometry:

- Desktop canvas: `1180px`.
- Page frame: full height, centered, transparent, overflow visible.
- Page row horizontal inset: `16px` mobile/tablet fallback, `32px` desktop.

Rules:

- Dashboard, Relations, Products, and Settings share the same desktop canvas unless a new global token is approved.
- Do not create page-specific `max-w-*` values.
- Page shell owns overall width; child panels own only their internal content.

## Title Bar

Use:

- `BAMBOOK_OS.layout.desktopTitleBarWithInsetClass`
- `BAMBOOK_OS.controls.title`

Geometry:

- Height: `64px`.
- Horizontal inset: same as page row.
- Safe-left style: `BAMBOOK_OS.layout.desktopTitleSafeLeftStyle`, currently empty; do not add page-local dynamic left padding.
- Slight vertical lift: `translate-y-[2px]`.
- Main-area panels start after this `64px` chrome height with `0px` title-to-panel gap.

Rules:

- Title bar is page chrome, not a content toolbar.
- The title origin must match across Dashboard, Relations, Products, Settings, and backstage pages in both expanded and collapsed Sidebar states.
- Page identity appears first.
- Breadcrumb children use title breadcrumb grammar.
- View switches are allowed only when they save vertical space.
- Do not add English overlines, prototype labels, or explanatory copy above the title.
- Do not use `calc()` or viewport-width compensation in a single page title; if traffic-light avoidance is needed, update the shared title safe-left token and apply it to every page title.

## Main Area Insets

Use:

- `--ui-lab-main-title-bar-height`
- `--ui-lab-main-title-to-panel-gap`
- `--ui-lab-main-panel-top-inset`
- `--ui-lab-main-panel-bottom-inset`
- `--ui-lab-main-bottom-lift`

Geometry:

- Sidebar shell top inset: `16px`.
- Sidebar shell bottom inset: `16px`.
- Main title bar height: `64px`.
- Main title-to-panel gap: `0px`.
- Main panel top inset from viewport: `64px`.
- Main panel bottom inset from viewport: `26px`.
- Main panel bottom lift beyond Sidebar: `10px`.

Rules:

- Main-area containers must sit farther from the viewport bottom than Sidebar.
- Settings is the baseline; Relations, Products, Dashboard content panels, module backstage pages, and legacy single-panel pages follow it.
- Top spacing for large containers is derived from title chrome, not from page-local margin.
- Do not make a page-specific top or bottom inset unless it becomes a new grammar role.

## Panel Rows

Standard page row:

- `BAMBOOK_OS.layout.desktopPanelRowClass`
- `BAMBOOK_OS.layout.desktopPageCanvasClass`

Module backstage row:

- `BAMBOOK_OS.layout.desktopBackstagePanelRowClass`

Geometry:

- Row fills remaining page height.
- Top inset is `0px` after the `64px` title bar.
- Large panel bottom inset follows `--ui-lab-main-panel-bottom-inset`: `26px`.
- Table/work-list panel bottom inset follows `--ui-lab-table-panel-bottom-inset`: `40px`.
- Sibling panel gap: `16px`.
- Row overflow stays visible for shadow bleed.

Rules:

- Panel rows own outer page padding and sibling gap.
- Child panels must not add extra page-level margins.
- Main-area bottom spacing follows Settings main-panel baseline, not Sidebar bottom inset.
- Table/work-list surfaces are intentionally shorter than large panels. Use the table bottom role for organization tables, product tables, and sub-classification index tables.
- Accepted large card grids keep their existing card rhythm and do not inherit the table bottom role unless the cards become a table/work-list surface.

## Split Workspace

Use for Settings and module backstage configuration:

- `BAMBOOK_OS.layout.desktopSplitNavPanelClass`
- `BAMBOOK_OS.layout.desktopSplitNavContentClass`
- `BAMBOOK_OS.layout.desktopSplitMainPanelClass`
- `BAMBOOK_OS.layout.desktopSplitMainContentClass`

Geometry:

- Left navigation panel width: `w-52 md:w-56`.
- Nav panel content: full height, `p-2`, `gap-1`.
- Main panel: `flex-1 min-h-0`.
- Main content: full height, min-height zero, column layout.

Rules:

- The nav panel and main panel are sibling level-1 panels.
- Do not put a nav area and a main area inside one larger frame panel.
- The left panel is for stable category switching only.
- The right panel is the work surface and owns scrolling.
- Complex module settings use progressive drill-in inside this split pattern.

## Scroll Viewport

Use:

- `BAMBOOK_OS.layout.desktopMainScrollViewportClass`
- `BAMBOOK_OS.layout.panelShadowViewportClass` when shadow bleed is needed.
- `ScrollEdgeFades`

Geometry:

- Full available panel height.
- `overflow-y-auto`.
- Hidden/native custom scrollbar depending on surface.
- Internal padding: `p-6 md:p-8`.

Rules:

- Header chrome stays fixed.
- Scroll fade bounds attach to the real scroll viewport.
- Ghost shadow is used when masking would clip outward shadow.
- Glass panels inside the viewport receive masks on the real material layer and the ghost shadow layer; parent panels do not fake top/bottom fades.

## Toolbar Row

Use:

- `BAMBOOK_OS.layout.desktopToolbarRowClass`
- `BAMBOOK_OS.controls.toolbar`

Order:

- Search first.
- Sort/select second.
- View toggle third.
- Compact actions last.

Rules:

- Toolbar lives directly above the list/grid/table viewport.
- Toolbar is one compact glass row.
- Do not create a row of independent card-like controls.
- Search and filters stay inside the toolbar rhythm, not in title chrome unless they are global page switches.

## Card Grid

Use:

- `BAMBOOK_OS.layout.desktopCardGridClass`
- `BAMBOOK_OS.layout.desktopTwoColumnGridClass`
- `BAMBOOK_OS.layout.relationsCardColumnWidth`
- `BAMBOOK_OS.layout.relationsCardColumnGap`

Rules:

- Card grids may reserve shadow bleed.
- Card gaps are grid-level decisions.
- Cards do not add outer page margins.
- Tables and form rows must not borrow card-grid shadow bleed.

## Detail Stack

Use:

- `BAMBOOK_OS.layout.desktopDetailStackClass`
- Level-2 surfaces for sections.

## Relations Detail Workspace

Use:

- `BAMBOOK_OS.layout.desktopPageCanvasClass`
- `BAMBOOK_OS.layout.relationsDetailListShellClass`
- `BAMBOOK_OS.layout.relationsDetailListPanelClass`
- `BAMBOOK_OS.layout.relationsDetailMainShellClass`

Geometry:

- Workspace canvas: `1180px`, centered by `desktopPageCanvasClass`.
- Contact list panel: fixed `280px`.
- Contact detail panel: remaining width inside the `1180px` canvas.
- Organization chart panel: one main panel using the same remaining-main shell rhythm, without the `280px` list sibling.
- Outer bottom edge: `26px`, owned by the detail workspace parent.
- Internal bottom padding: `0px`; do not add a second bottom inset inside the child panel shell.

Rules:

- Relations detail width is a page-canvas split, not a local panel decision.
- The contact list plus detail panel must always fit inside the same `1180px` main canvas.
- The organization-chart view uses the same main panel width logic as the contact detail side, not a separate max width.
- Do not introduce local `w-[...]`, `max-w-[...]`, or extra bottom padding in Contacts, DetailPanel, or OrgChart wrappers.
- Level-3 surfaces for inline records.

Rules:

- Detail pages stack sections with stable vertical rhythm.
- Section titles are content labels, not page titles.
- Inline records do not create new page panels.

## Relations Table Workspace

Use:

- `BAMBOOK_OS.layout.relationsTableViewportClass`
- `BAMBOOK_OS.layout.relationsTablePanelClass`
- `BAMBOOK_OS.layout.relationsTablePanelContentClass`
- `BAMBOOK_OS.layout.relationsTableHeaderTableClass`
- `BAMBOOK_OS.layout.relationsTableHeaderCellClass`
- `BAMBOOK_OS.layout.relationsTableBodyViewportClass`
- `BAMBOOK_OS.layout.relationsTableColumnWidthClasses`
- `BAMBOOK_OS.layout.relationsTableColumnTemplateClass`

Geometry:

- Workspace canvas: the same `1180px` main canvas as Relations title, cards, and detail pages.
- Outer viewport: `-64px` title overlap recovery, `80px` top padding, and the shared `40px` table bottom edge.
- Horizontal inset: shared page inset `16px / 32px`, never a table-local max width.
- Header columns: `27% / 22% / 27% / 17% / 7%`.
- Body rows: CSS grid using the same column template as the header.

Rules:

- The table header and every row share one column contract.
- Header, body viewport, and row grid are table workspace grammar, not ad hoc component classes.
- Do not introduce local `<col className="w-[...]">`, local `grid-cols-[...]`, local `min-w-[...]`, or page-local table padding.
- Table rows remain operational rows. Inside a level-1 table panel they are transparent rows with separators and hover state only; they must not apply level-2 or level-3 material classes.

## Form Stack

Use:

- `BAMBOOK_OS.layout.desktopFormStackClass`
- `BAMBOOK_OS.layout.desktopFormGridClass`
- `BAMBOOK_OS.controls.recessedField`

Rules:

- Forms use standard density.
- Field groups use `gap-4`.
- Inline utility controls use compact gaps.
- Buttons live in title actions or a bottom action row, not arbitrary local positions.

## Table Viewport

Use:

- `BAMBOOK_OS.layout.desktopTableViewportClass`
- `BAMBOOK_OS.controls.table`

Rules:

- Table header stays fixed when body scrolls.
- Row hover spans row width and remains table-like.
- Table rows do not become cards.
- Empty state lives inside the table surface.

## Density

Compact:

- Toolbar controls.
- Table rows.
- Metadata.
- Utility actions.

Standard:

- Settings.
- Module backstage configuration.
- Forms.
- Detail sections.

Spacious:

- Dashboard summaries.
- Primary navigation cards.
- Empty states.

Rules:

- Density changes spacing, not material hierarchy.
- Do not use large spacing to imply a higher container level.
- Do not use tight spacing to hide a missing structure.

## Page Type Mapping

Dashboard:

- Page shell.
- Title bar.
- Main panel or dashboard canvas.
- Spacious card grid.

Relations:

- Page shell.
- Title bar.
- Main panel.
- Toolbar row for search/sort/view.
- Card grid, table viewport, or detail stack depending on current mode.

Products / Digital Archive:

- Page shell.
- Title bar.
- Main panel.
- Toolbar row for search/filter/view.
- Card grid or table viewport for content.
- Module backstage configuration uses split workspace.

Settings:

- Page shell.
- Title bar.
- Split workspace.
- Left nav panel.
- Right scroll viewport with settings/form stack.

Fullscreen Entry Form:

- Page shell.
- Title breadcrumb.
- Form canvas uses the shared `1180px` main canvas.
- Left Form Map starts at the form row top and stays `self-start`.
- Right primary form scroll viewport uses `-96px` top recovery with `64px` top content padding, so the first main input panel sits `32px` higher than Form Map.
- The right primary form owns edge fades and shadow viewport behavior; Form Map is a navigation aid and must not define the main form height.
- Form Map and primary form panels use level-1 `framePanel` material. Repeatable child rows inside them use level-2 `raisedCard`.

Module Backstage Configuration:

- Workspace frame.
- Title breadcrumb.
- Backstage panel row.
- Split workspace.
- Left nav panel.
- Right scroll viewport with detail stack and drill-in rows.

## Forbidden

- Page-local `max-w-*` values.
- Page-local split panel widths.
- A nav panel and main panel nested inside a larger visual panel.
- Toolbars built from independent cards.
- Search/filter controls placed randomly between title and panel.
- Tables using card-grid shadow bleed.
- Detail sections using page-title typography.
- Scroll fade bounds measured from anything other than the real scroll viewport.
