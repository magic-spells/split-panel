# Split Panel

Resizable split-panel layout web component. Draggable dividers between panels, horizontal or vertical splits, nesting, pixel/percent min/max constraints, keyboard accessibility, and optional localStorage persistence. 3.7 kB JS gzip, 0.7 kB CSS gzip, zero dependencies, no Shadow DOM.

[**Demo**](https://magic-spells.github.io/split-panel/demo/)

## Install

```bash
npm install @magic-spells/split-panel
```

```js
import '@magic-spells/split-panel';
import '@magic-spells/split-panel/css';
```

Or via CDN:

```html
<link
	rel="stylesheet"
	href="https://unpkg.com/@magic-spells/split-panel/dist/split-panel.min.css" />
<script src="https://unpkg.com/@magic-spells/split-panel"></script>
```

## Usage

```html
<split-panel-group>
	<split-panel size="30" min="200px">Sidebar</split-panel>
	<split-panel>Main</split-panel>
</split-panel-group>
```

The group lays out its direct `<split-panel>` children with flexbox and puts a draggable `<split-divider>` between each adjacent pair — dividers are generated when you omit them, or you can author `<split-divider>` between panels to control them from a template or framework. Any number of panels works; each divider resizes only its two neighbors.

The group fills its container (`width: 100%; height: 100%`), so give the container an explicit size.

### Authored dividers

Write the dividers yourself and the group **adopts** them — it wires the same drag, keyboard, and ARIA behaviour onto your elements rather than replacing them, so a template that owns the markup keeps ownership. Mix and match freely: a pair with no divider between it gets a generated one.

```html
<split-panel-group>
	<split-panel size="30">Sidebar</split-panel>
	<split-divider></split-divider>
	<split-panel size="40">Main</split-panel>
	<!-- no divider here — one is generated -->
	<split-panel size="30">Inspector</split-panel>
</split-panel-group>
```

An authored divider is never moved or removed; only generated ones are cleaned up when a neighbouring panel goes away. A stray divider — before the first panel, after the last, or a second one in a row — is left alone and simply not wired.

### Runtime changes

The group watches its own child list, so panels and dividers added, removed, or reordered after mount are re-scanned and re-wired on the next microtask. Sizes renormalize to 100, and every panel that is still there keeps the size it was last committed to (panels are matched by element identity, not index). A newly added panel takes its authored `size`.

```js
const group = document.querySelector('split-panel-group');
group.append(document.createElement('split-panel')); // divider appears, sizes renormalize
```

### Vertical

```html
<split-panel-group direction="vertical">
	<split-panel>Top</split-panel>
	<split-panel>Bottom</split-panel>
</split-panel-group>
```

### Nested

A panel can contain another group. Each group only manages its own direct children:

```html
<split-panel-group>
	<split-panel size="35">Sidebar</split-panel>
	<split-panel size="65">
		<split-panel-group direction="vertical">
			<split-panel size="60">Editor</split-panel>
			<split-panel size="40">Console</split-panel>
		</split-panel-group>
	</split-panel>
</split-panel-group>
```

### Saved positions

Give a group an `id` and committed sizes persist to localStorage (key `split-panel:<id>`) and restore on load:

```html
<split-panel-group id="workspace">
	<split-panel>…</split-panel>
	<split-panel>…</split-panel>
</split-panel-group>
```

## Attributes

### `<split-panel-group>`

| Attribute   | Description                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direction` | `horizontal` (default) — side-by-side columns; `vertical` — stacked rows                                                                                                                              |
| `disabled`  | Locks all resizing — divider handles are hidden and stop responding to pointer/keyboard                                                                                                               |
| `snap`      | On release, settle the divider to the nearest listed point. Space/comma-separated percentages of the divider's travel (`0` = previous panel at its min, `100` = at its max). Bare `snap` = `0 50 100` |
| `id`        | Opts into localStorage persistence                                                                                                                                                                    |

### `<split-panel>`

| Attribute | Description                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `size`    | Initial size — a percent (`30` or `30%`) or a pixel value (`250px`). Panels without a size split the remainder equally |
| `min`     | Minimum size — `200px` or a bare number for pixels; `15%` for a percent                                                |
| `max`     | Maximum size — same formats as `min`                                                                                   |

### `<split-divider>`

Generated for any adjacent pair you leave one out of; write your own between two panels and it is adopted instead.

| Attribute  | Description                                |
| ---------- | ------------------------------------------ |
| `disabled` | Locks just this divider — hides its handle |

## Methods

| Method            | Description                                                                    |
| ----------------- | ------------------------------------------------------------------------------ |
| `sizes`           | Getter — current sizes as an array of percentages summing to 100               |
| `setSizes(array)` | Sets sizes programmatically (one number per panel, normalized to 100), commits |
| `resetSizes()`    | Restores the initial authored sizes                                            |
| `disabled`        | Getter/setter reflecting the `disabled` attribute                              |

## Events

Both are dispatched on the group, and both bubble and are composed (they cross a shadow boundary).

| Event                    | When                                                             | `detail`                                       |
| ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------- |
| `split-panel:resize`     | Live, on every applied change during a drag or key press         | `{ sizes: number[], divider: number }`         |
| `split-panel:resize-end` | Commit — drag end, each key press, reset, or programmatic change | `{ sizes: number[], divider: number \| null }` |

## Keyboard

Dividers are focusable `role="separator"` elements (WAI-ARIA window-splitter pattern).

| Key                                            | Action                                              |
| ---------------------------------------------- | --------------------------------------------------- |
| `←` / `→` (horizontal) or `↑` / `↓` (vertical) | Resize by 1%                                        |
| `Shift` + arrow                                | Resize by 10%                                       |
| `Home` / `End`                                 | Previous panel to its minimum / maximum             |
| `Enter`                                        | Reset the pair to initial sizes (like double-click) |

## Styling

| Custom property                      | Default       | Description                                                                                                      |
| ------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--split-panel-gap`                  | `0.5rem`      | Gutter width (the divider itself)                                                                                |
| `--split-panel-divider-color`        | `#ddd`        | Divider line                                                                                                     |
| `--split-panel-divider-hover-color`  | `#bbb`        | Divider line on hover                                                                                            |
| `--split-panel-divider-active-color` | `#4299e1`     | Divider line while dragging                                                                                      |
| `--split-panel-divider-line`         | `0.125rem`    | Visual line thickness                                                                                            |
| `--split-panel-divider-length`       | `100%`        | Visual line length — shorten (e.g. `60%` or `2.5rem`) for a centered handle/tab; the full gutter stays draggable |
| `--split-panel-divider-radius`       | `0.0625rem`   | Visual line corner radius                                                                                        |
| `--split-panel-focus-ring-color`     | `#4299e1`     | Keyboard focus ring                                                                                              |
| `--split-panel-transition-duration`  | `120ms`       | Divider color transition                                                                                         |
| `--split-panel-animate-duration`     | `0s`          | Ease duration for programmatic/snap/keyboard size changes (live dragging stays instant)                          |
| `--split-panel-animate-easing`       | `ease-in-out` | Timing function for the size transition                                                                          |

Panels are sized by a `--split-panel-size` custom property the group writes (`flex: var(--split-panel-size, 1) 1 0%`). For zero-flash first paint with authored sizes, you can set it inline yourself: `<split-panel size="30" style="--split-panel-size: 30">`.

### `--split-panel-visible` (reveal effects)

Any panel with a `max` also gets a read-only `--split-panel-visible` custom property — a `0`→`1` value tracking where the panel sits in its `min`/`max` range (`1` at max, `0` at min). It updates live during drags, on window resize, and inside nested groups, so you can drive fade/scale/blur effects as a panel shrinks toward hidden:

```css
split-panel[max] .content {
	opacity: var(--split-panel-visible, 1);
	transform: scale(calc(0.8 + 0.2 * var(--split-panel-visible, 1)));
	filter: blur(calc((1 - var(--split-panel-visible, 1)) * 6px));
}
```

To let a panel collapse all the way to nothing, keep its padding on an inner wrapper (a padded panel can't shrink below its own padding). Most useful with pixel `min`/`max`.

### Animating size changes

Set `--split-panel-animate-duration` to ease programmatic (`setSizes`/`resetSizes`), snap, and keyboard changes. Live dragging is always instant, and the authored layout is never animated in on first load:

```css
split-panel-group {
	--split-panel-animate-duration: 320ms;
	--split-panel-animate-easing: ease-in-out;
}
```

Combined with `snap`, releasing a drag glides to the nearest snap point — and because `--split-panel-visible` updates throughout the transition, any fade/scale effect rides along with it.

## License

MIT

---

<p align="center">
  Made by <a href="https://github.com/coryschulz">Cory Schulz</a>
</p>
