# Flat Material Authority

This document defines where Bambook flat material decisions live.

The product direction is flat, matte, low-rim UI. Containers should read as material and blur, not as raised cards. New surfaces must not rely on page-local shadow, rim, or ad hoc glass color.

## Authority

Long-term authority lives in code-backed system files:

- `styles/os-vnext.css`: CSS variables, material class rendering, mode-specific material values, and root app scopes.
- `components/ui/osMaterial.ts`: material and shadow role names used by React primitives.
- `components/ui/bambookOsTokens.ts`: semantic recipes, component roles, layout, typography, motion, and allowed composition language.
- `components/ui/osCompiler/compiledPrimitives.tsx`: compiler-level primitive consumption for generated or migrated UI.

These files decide what a material role means. Pages and feature components consume roles; they do not define new material systems.

## Migration Shield

`styles/flat-experimental.css` is a migration compatibility shield.

It may temporarily neutralize legacy shadows, rims, highlights, and depth artifacts while old surfaces are migrated. It is not allowed to become the permanent source of truth.

Acceptable use:

- Suppress legacy `box-shadow`, `drop-shadow`, inset rim, and highlight effects during migration.
- Protect the flat direction while ownership is moved into tokens and material roles.
- Provide short-lived compatibility for old class names.

Unacceptable use:

- Define a new visual language.
- Add new page-specific material values.
- Become the only place where a role renders correctly.
- Hide unresolved ownership conflicts indefinitely.

## Prohibited New Patterns

Do not add new instances of:

- Page-local `.glass-panel`, `.glass-card`, or one-off glass class families.
- Page-local `shadow-*`, `drop-shadow-*`, or custom `box-shadow`.
- Container rim, highlight, or border values that are not token-backed.
- New blue-white films outside the approved material roles.
- Hardcoded blur/color/radius combinations that duplicate material roles.
- Local overrides that make light, dark, or wallpaper mode diverge from the mode contract.

## Migration Order

When a visual surface needs cleanup:

1. Identify the component's material role.
2. If the role does not exist, add or revise it in `osMaterial.ts` and `bambookOsTokens.ts`.
3. Render the role in `styles/os-vnext.css`.
4. Migrate compiler output through `compiledPrimitives.tsx` if the surface comes from generated UI.
5. Migrate handwritten page components to consume the role.
6. Remove the corresponding override from `flat-experimental.css`.

Do not start by adding another local class to a page component.

## Definition Of Done

A flat material migration is complete only when:

- The rendered material is controlled by `os-vnext.css` and role tokens.
- The component consumes a named material role.
- Light mode is white material with dark text.
- Dark mode is dark material with white text.
- Wallpaper/map mode uses grey or neutral frosted material with solid white or dark text as specified by the mode, not transparent text.
- No container-level shadow, rim, or fake depth remains unless explicitly approved as a role-level exception.
- `flat-experimental.css` has no unique rule required for the migrated surface to look correct.
