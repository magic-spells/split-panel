# @magic-spells/split-panel

## Purpose

Resizable split-panel layout web component. `<split-panel-group>` lays out its direct `<split-panel>` children along one axis with flexbox and auto-generates a draggable `<split-divider>` between each adjacent pair. Supports N panels, horizontal/vertical direction, nesting groups inside panels, px/% min/max constraints, keyboard resizing (ARIA window-splitter pattern), double-click/Enter reset, `setSizes()`/`resetSizes()`, a `disabled` lock, and localStorage persistence when the group has an `id`. No dependencies, no Shadow DOM.

## Key files

- `src/components/split-panel-group.js` — `SplitPanelGroup`, the root orchestrator; all state, sizing, pointer, keyboard, and persistence logic lives here
- `src/components/split-panel.js` — `SplitPanel` + `SplitDivider`, thin structural classes; behavior is wired by the group
- `src/styles/split-panel.css` — all styling; `--split-panel-*` custom properties on `:root`
- `src/index.js` — entry: imports CSS, named re-exports of the three classes
- `demo/index.html` — manual test page (served on port 3000 in dev)
- `scripts/build.mjs` — Vite + Rolldown build (matches color-picker/tarot pattern)

## Architecture

1. **Sizes array is the single source of truth**: `#sizes` holds one float per panel, summing to 100 — each panel's percent share of the *panel space* (group content box minus the fixed gutters dividers occupy). The only render path is `#applySizes()`, which writes `--split-panel-size` on each panel; CSS does `flex: var(--split-panel-size, 1) 1 0%`.
2. **Flex-grow weights, not flex-basis percentages**: with `flex-basis: 0%`, grow weights natively distribute the space left after the fixed-basis dividers — no `calc()`, container resizes keep proportions with zero JS (no ResizeObserver anywhere), and nested groups need nothing special. The `, 1` fallback gives an equal split before upgrade.
3. **The divider IS the gap**: `split-divider { flex: 0 0 var(--split-panel-gap) }` — a real flex item filling the gutter, visual line via `::before`, enlarged hit target via `::after`. No flexbox `gap` property, so no position math. The visual line is decoupled from the hit target: `--split-panel-divider-length` (default `100%`) shortens just the `::before` into a centered handle while the whole gutter stays draggable.
4. **Drag math lives in the percent domain, with bounds precomputed at pointerdown**: `#measurePair()` measures the group's *distributable* space once (panel rects minus each panel's padding+border via `#panelExtra` — those sit outside what flex-grow distributes and would otherwise skew the mapping) and resolves all four min/max attributes into percent bounds on the previous panel. Every move converts the pixel delta through `flexSpace` (`deltaShare = deltaPx * 100 / flexSpace`) and clamps. Keyboard reuses the exact same `#measurePair` → `#setPairSizes` path with flat 1/10-point steps.
5. **Pointer handling is delegated on the group** (one stable `handlers` object, `attachListeners`/`detachListeners`): `setPointerCapture` on the **divider** for mouse/pen only — never touch (implicit capture; explicit re-capture fires spurious `pointercancel` on some mobile engines), and never the group (capture retargets the composed `click`/`dblclick` too, which would break double-click reset). Move/end handlers key off `#drag` + pointerId, not `e.target`. A `[dragging]` attribute drives cursor, `user-select`, and `iframe { pointer-events: none }`.
6. **Nesting isolation is two checks**: `queryDOM()` uses `:scope > split-panel`, and every delegated handler resolves `e.target.closest('split-divider')` and requires `divider.parentElement === this`.
7. **Constraints are enforced twice, deliberately**: JS clamps during interaction; `#mirrorConstraints()` also mirrors `min`/`max` to inline `min-width`/`max-width` (or `-height`) once so the browser holds pixel floors during container resizes.
7b. **`--split-panel-visible` is an optional reveal readout** (`#trackVisible`/`#applyVisible`): panels with a `max` get a `0`→`1` var reflecting their rendered size within `[min, max]`. This is the *one* place a `ResizeObserver` is used — layout is still pure flex; the RO only reads rendered size to keep the var correct across drags, window resizes, and nested groups. Setting the var only affects opacity/transform/filter (non-layout), so there's no RO feedback loop. No observer is created for a group with no bounded panels.
8. **Persistence hangs solely off `#commit()`** (drag end / key press / reset / programmatic — never per move): key `split-panel:${id}`, JSON sizes array, try/catch both ways, restored + re-normalized in `#init()` only if the panel count matches.
9. **Deferred init**: if the element upgrades before its children are parsed (synchronous script in `<head>`), `connectedCallback` waits for `DOMContentLoaded` (color-picker pattern).
10. **Snap** (`#snapShare`, in `#handlePointerEnd`): on release (only if the divider actually moved), settle to the nearest `snap` point. Points are percentages of the divider's *travel* (`minPrevious`..`maxPrevious` from the pointerdown `measure`), so they respect min/max automatically. `[dragging]` is removed before the snap is applied, so it eases when animation is on.
11. **Animation** is opt-in via `--split-panel-animate-duration` (default `0s`) on `transition: flex-grow`. Two `transition: none` guards keep it honest: `[dragging] > split-panel` (live drag is instant) and `:not([ready]) > split-panel` (the authored layout isn't animated in — `#init` adds `ready` in a `requestAnimationFrame` after the first paint).
12. **px `size`/`min`/`max` account for padding+border** (`#panelExtra`): flexbox reserves each panel's padding+border before distributing grow space, so a px value maps to a weight through `panelSpace − Σextra`, not the raw panel space. `#resolveInitialSizes` (px→weight) and `#measurePair` (drag clamps) share this basis.

## API

- **Group attributes**: `direction="horizontal|vertical"` (observed — re-syncs divider `aria-orientation` + constraint mirroring), `disabled` (observed — syncs divider tabindex/`aria-disabled`; CSS hides the handle via `[disabled] > split-divider::before`), `snap` (space/comma list of travel-percentages; bare = `0 50 100`), `id` (opts into persistence)
- **Panel attributes**: `size` (initial size — `30`/`30%` percent share, or `250px` mapped through the grow space; unsized panels split the remainder, whole array normalized to 100), `min`/`max` (`200px`, `15%`, bare number = px; read fresh at interaction time)
- **Divider attribute**: `disabled` (per-divider lock, checked at interaction time)
- **Properties/methods**: `sizes` getter (copy), `setSizes(array)` (validates, normalizes to 100, commits), `resetSizes()`, `disabled` getter/setter
- **Read-only CSS var**: `--split-panel-visible` (`0`→`1`) written on any panel with a `max` — for driving fade/scale/blur reveal effects
- **Events** (bubble, on the group): `split-panel:resize` `{sizes, divider}` live; `split-panel:resize-end` `{sizes, divider|null}` on commit
- **Keyboard**: axis arrows = 1%, Shift = 10%, Home/End = clamp bounds, Enter = reset pair (same as double-click)

## Conventions

- `handlers = {}` object of bound handler refs; `attachListeners()`/`detachListeners()` symmetric via `#toggleListeners`; `queryDOM()` holds all querySelector calls
- `const _ = this` alias when a method references `this` 4+ times
- Registration guard `if (!customElements.get(...))`, named exports only, no Shadow DOM
- Events namespaced `split-panel:*`, `bubbles: true`
- State via attributes (`[dragging]`, `[disabled]`, `[direction]`), styling via `--split-panel-*` vars, rem units

## Gotchas

- **`aria-orientation` is inverted on purpose**: per ARIA, it describes the separator line itself — a horizontal group has `aria-orientation="vertical"` dividers.
- **The group needs an externally-sized container** (`width/height: 100%`) — an auto-height parent gives a zero-height vertical group.
- **Percent `min`/`max` use the same units as `size`** (shares of the distributable space), not "percent of the group's pixel width." Pixel values refer to the panel's rendered box. The mirrored CSS percent `min-width` resolves against the full group box instead — slightly stricter, negligible. Documented, not handled.
- **A panel's own padding/border are part of its rendered size but outside the flex-distributed space** — `#measurePair` accounts for this (a panel can never render smaller than padding+border, even at size 0).
- **Don't dispatch or listen for `resize` per-frame work that must run once per gesture** — use `resize-end`; persistence already works this way.
- `sizes` percentages are shares of panel space, not of the group's full width — converting to pixels requires subtracting the gutters.
- **A panel's padding/border is a flex floor**: with `flex-basis: 0%`, flexbox still reserves each panel's padding+border before growing, so grow only distributes `panelSpace − Σextra`. This is why `size="250px"` on a panel next to a heavily-padded one needs the `#panelExtra` correction, and why a padded panel can't collapse below its padding (move padding to an inner wrapper for a true fade-to-zero).
- **`snap` and persistence interact**: a snapped release persists the *snapped* sizes. A group meant to always start at an authored size (e.g. a demo that starts "full") should not also have an `id`, or the restored layout wins over `size`.

## Commands

- `npm run dev` — watch build to `demo/dist/`, Vite dev server at `http://localhost:3020` with live reload (3000 is used by other projects)
- `npm run build` — production build to `dist/` (ESM + minified UMD + CSS + min CSS)
- `npm run lint` / `npm run format`
