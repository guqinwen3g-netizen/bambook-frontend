# Governance

> 2026-10-01 作用域说明：下文 OS/compiled 治理用于该既有轨的维护。全局新业务内容与最新豁免范围按 [README 职责表](README.md)、[内容契约](BDS规则权威与内容契约-2026-10-01.md) 和 [执行方案](全局UIUX收敛执行方案-2026-10-01.md)；不得把下文来源列表扩大为所有页面的唯一真源。

Bambook OS grammar is enforced by code, tests, audit, and review discipline. The goal is not to restyle every old surface at once. The goal is to prevent new independent visual systems while moving old surfaces into the contract.

## Active Sources

Within the existing OS/compiled surface scope, these files own its visual language:

- `styles/os-vnext.css`
- `components/ui/bambookOsTokens.ts`
- `components/ui/osMaterial.ts`
- `components/ui/bambookDesignSystem.ts`
- Shared primitives named by the registry, such as `SidePanelContainer` and `ScrollEdgeFades`.

`styles/design-system.css` remains runtime legacy only. It may support old Command Center UI, but it must not receive new Bambook OS material values.

## Migration Order

1. Keep current accepted visuals unchanged.
2. Identify repeated page-local values.
3. Move stable values into `styles/os-vnext.css` or `components/ui/bambookOsTokens.ts`.
4. Replace callers with semantic recipes or primitives.
5. Add a contract test.
6. Remove the old local style.

## Allowed Local Styling

Page files may own:

- Layout grid.
- Data-driven size constraints.
- Content spacing when no system primitive exists.
- Semantic business color only when tied to status.

Page files may not own:

- New glass films.
- New material shadows.
- New material or layout variants.
- New selected styles.
- New hover or press materials.
- New input focus rims.
- New scroll fade logic.
- New title geometry.
- New toolbar structure.
- New z-index layer stacks.
- New portal roots or overlay placement rules.
- New data formatting for missing values, dates, numbers, currency, percentages, status text, or source identifiers.
- Product-facing entries to material libraries, token samples, or audit panels.

## Internal References

Material libraries and design-system sample pages are internal reference surfaces. They may exist in UI Lab or documentation, but only behind explicit dev-only routes or parameters. They must not be mounted as floating controls on product-like pages because that makes the reference surface look like part of Bambook itself.

## Audit

Use:

- `npm run audit:os-vnext`
- Targeted Vitest tests around the touched primitive.
- `npm run build` before broad UI library changes.

If the audit catches a new value, either move it into the design system or add a deliberate migration note with a test.

The audit is a gate, not the full contract. UI Lab 2.0 and compiler-owned pages must also reject page-local:

- Material, shadow, radius, and color.
- Layout shell, page canvas, title position, and toolbar structure.
- Hover, selected, focus, disabled, loading, and error visuals.
- Motion, z-index, portal, overlay, and responsive profile behavior.
- Dev-only reference surfaces mounted in product-like pages.

Historical violations must stay visible through a baseline or migration note until removed. Do not hide new violations by widening a baseline without naming the migration reason.

## Review Gate

A UI change is not complete until every visible element can name:

- Material role.
- State model.
- Layout role.
- Content role.

If the answer depends on taste, the grammar is missing an input and must be extended before implementation.

## Compiler Fidelity Gate

For UI Lab 2.0 and future compiler-owned pages, review also requires:

- The product-like surface is reachable from `dev-ui-lab-2.html`.
- Compiler reference and fidelity surfaces are reachable from `dev-ui-lab-2-reference.html`.
- The product-like UI Lab 2.0 entry must not mount compiler reference overlays, fidelity panels, or audit cards that block normal review of the project interface.
- Product-like entries must not mount compiler reference overlays.
- Every reusable visual is produced by the compiler or marked as a provisional bridge.
- Legacy or partially migrated surfaces are marked `provisionalBridge` and cannot define accepted output.
- The fidelity report exposes `accepted`, `provisional`, `experimental`, or `retired` provenance.
- Any visual drift from current UI Lab is named as either a compiler correction or a review item.
- No page-local layout, material, shadow, motion, state, typography, icon, slot structure, z-index layer, overlay behavior, data formatting, or responsive profile is introduced.

## Compiler Uniformity Gate

A compiler-owned page passes only when these answers come from `components/ui/bambookDesignSystem.ts` and compiler output, not page styling:

- Semantic input schema.
- Primitive variant grammar.
- Slot grammar.
- Layer stack.
- Overflow, mask, radius, material, shadow, and separator ownership.
- Action hierarchy.
- Data formatting.
- Portal and overlay contract.
- Focus and accessibility states.
- Responsive profile.
- Visual provenance.
- Reference snapshot.
- CI or audit gate.
