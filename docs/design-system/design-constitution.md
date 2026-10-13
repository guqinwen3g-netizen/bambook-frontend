# Design Constitution

Bambook OS is a quiet operational workbench. The interface must feel like a coherent desktop surface, not a set of independent SaaS screens.

## Law 1: Code Is The Source

Exact values live in code:

- `styles/os-vnext.css`
- `components/ui/bambookOsTokens.ts`
- `components/ui/bambookDesignSystem.ts`

Documents explain usage. They do not override tokens.

## Law 2: Every Visible Thing Has A Role

Before styling any visible UI, assign:

- Material role.
- State model.
- Layout role.
- Content role.

If a piece of UI cannot be classified, it should not get a new style.

## Law 3: Levels Generate Surfaces

Containers are generated from level logic:

- Level 1 owns shared glass.
- Level 2 nests without shared blue-white film.
- Level 3 is inline and selected-rim derived in light mode.
- Level 4 is derived only and must not invent a new material.

## Law 4: State Is Not Decoration

Hover, press, focus, selected, disabled, loading, error, and empty are different states. They must not borrow each other's visual language.

## Law 5: Layout Is Grammar

Canvas, padding, gaps, density, title bars, scroll viewports, and bottom insets are part of the design system. They are not page-level taste.

## Law 6: Adaptive Color Has A Narrow Job

Adaptive color exists to maintain contrast over wallpaper and ambient surfaces. It does not replace semantic status, selected state, or field state.

## Law 7: Content Is UI

The system voice is precise, calm, and operational. Labels, empty states, missing values, button verbs, and bilingual handling are design primitives.

## Law 8: New Pages Must Be Derivable

A new page should have one valid shape after its page type, primary task, density, navigation depth, and content model are known. If multiple shapes seem valid, the grammar is missing an input.

