const STORAGE_PREFIX = 'split-panel:';

/**
 * Resizable split-panel layout. Lays out direct <split-panel> children along one
 * axis, adopts any author-supplied <split-divider> sitting between an adjacent
 * pair (generating one only where none was written), and keeps a sizes array
 * (percent shares summing to 100) as the single source of truth — rendered by
 * writing `--split-panel-size` on each panel.
 *
 * Structure is re-scanned whenever the group's children change, so panels and
 * dividers rendered by a framework can come and go at runtime.
 *
 * With an `id`, committed sizes persist to localStorage and restore on load.
 * @class SplitPanelGroup
 * @extends HTMLElement
 */
export class SplitPanelGroup extends HTMLElement {
	static observedAttributes = ['direction', 'disabled'];

	#panels = [];
	#dividers = [];
	#sizes = [];
	#initialSizes = [];
	#drag = null;
	#initialized = false;
	#visibleObserver = null;
	#childObserver = null;
	#scanning = false;
	// dividers this component created (the only ones it may remove) and the ones
	// it labelled — author-supplied dividers and author labels are never touched
	#generated = new Set();
	#labelled = new WeakSet();

	constructor() {
		super();
		const _ = this;
		_.handlers = {
			pointerDown: (e) => _.#handlePointerDown(e),
			pointerMove: (e) => _.#handlePointerMove(e),
			pointerEnd: (e) => _.#handlePointerEnd(e),
			doubleClick: (e) => _.#handleDoubleClick(e),
			keyDown: (e) => _.#handleKeyDown(e),
		};
	}

	connectedCallback() {
		// when the element is defined before the parser reaches its children
		// (e.g. a synchronous script in <head>), connectedCallback fires with
		// an empty subtree — defer initialization until parsing finishes
		if (!this.querySelector(':scope > split-panel') && document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => this.#init(), { once: true });
			return;
		}
		this.#init();
	}

	disconnectedCallback() {
		this.detachListeners();
		this.#visibleObserver?.disconnect();
		this.#visibleObserver = null;
		this.#childObserver?.disconnect();
		this.#childObserver = null;
	}

	attributeChangedCallback(name, previousValue, currentValue) {
		if (previousValue === currentValue || !this.#initialized) return;
		if (name === 'direction') {
			this.#syncOrientation();
			this.#mirrorConstraints();
		}
		if (name === 'disabled') {
			this.#syncDisabled();
		}
	}

	/** @returns {'horizontal' | 'vertical'} the layout axis */
	get direction() {
		return this.getAttribute('direction') === 'vertical' ? 'vertical' : 'horizontal';
	}

	get disabled() {
		return this.hasAttribute('disabled');
	}

	set disabled(value) {
		this.toggleAttribute('disabled', Boolean(value));
	}

	/** @returns {number[]} current panel sizes (percent shares summing to 100) */
	get sizes() {
		return [...this.#sizes];
	}

	/**
	 * Sets panel sizes programmatically and commits (dispatches
	 * `split-panel:resize-end`, persists). Values are normalized to sum to 100.
	 * @param {number[]} sizes - one non-negative number per panel
	 */
	setSizes(sizes) {
		const valid =
			Array.isArray(sizes) &&
			sizes.length === this.#panels.length &&
			sizes.every((size) => Number.isFinite(size) && size >= 0);
		if (!valid) return;
		this.#sizes = this.#normalizeSizes(sizes);
		this.#applySizes();
		this.#commit(null);
	}

	/** Restores every panel to its initial authored size. */
	resetSizes() {
		this.setSizes([...this.#initialSizes]);
	}

	/** Re-reads the group's direct children, adopting or generating dividers. */
	queryDOM() {
		this.#syncStructure();
	}

	attachListeners() {
		this.#toggleListeners('addEventListener');
	}

	detachListeners() {
		this.#toggleListeners('removeEventListener');
	}

	#toggleListeners(method) {
		const _ = this;
		_[method]('pointerdown', _.handlers.pointerDown);
		_[method]('pointermove', _.handlers.pointerMove);
		_[method]('pointerup', _.handlers.pointerEnd);
		_[method]('pointercancel', _.handlers.pointerEnd);
		_[method]('lostpointercapture', _.handlers.pointerEnd);
		_[method]('dblclick', _.handlers.doubleClick);
		_[method]('keydown', _.handlers.keyDown);
	}

	#init() {
		const previousPanels = this.#panels;
		const previousSizes = this.#sizes;
		if (!this.isConnected) return;
		this.#observeChildren();
		this.#syncStructure();
		// no panels yet — stay uninitialized; the child observer retries when some arrive
		if (this.#panels.length === 0) return;

		// Frameworks move nodes: a group that is re-connected with the very same
		// panels is not a new layout, so its committed sizes stand. Only a first
		// connect or a changed panel set re-resolves the authored/saved sizes.
		const sameLayout =
			previousSizes.length === this.#panels.length &&
			this.#panels.every((panel, index) => panel === previousPanels[index]);
		if (sameLayout) {
			this.#sizes = [...previousSizes];
		} else {
			this.#resolveInitialSizes();
			this.#restoreSavedSizes();
		}
		this.#syncOrientation();
		this.#syncDisabled();
		this.#mirrorConstraints();
		this.#applySizes();
		this.#trackVisible();
		this.attachListeners();
		this.#initialized = true;
		// enable size transitions only after the authored layout has painted,
		// so opting into animation doesn't animate the initial sizes in
		requestAnimationFrame(() => this.setAttribute('ready', ''));
	}

	#resolveInitialSizes() {
		const raw = this.#panels.map((panel) => panel.getAttribute('size'));
		const horizontal = this.direction === 'horizontal';
		const dimension = horizontal ? 'width' : 'height';

		// A px `size` maps to a grow weight through the space grow actually
		// distributes: panel rects (invariant of distribution) minus each panel's
		// padding+border, which flexbox reserves before growing (same basis the
		// drag math uses). Only measured when a px size is present.
		let freeGrow = 0;
		let extras = [];
		if (raw.some((value) => value && value.trim().endsWith('px'))) {
			const panelSpace = this.#panels.reduce(
				(total, panel) => total + panel.getBoundingClientRect()[dimension],
				0
			);
			extras = this.#panels.map((panel) => this.#panelExtra(panel, horizontal));
			freeGrow = panelSpace - extras.reduce((total, extra) => total + extra, 0);
		}

		const authored = raw.map((value, index) =>
			this.#parseSize(value, extras[index] ?? 0, freeGrow)
		);
		const authoredTotal = authored.reduce((total, size) => total + (size ?? 0), 0);
		const unsizedCount = authored.filter((size) => size === null).length;
		const share = unsizedCount > 0 ? Math.max(0, 100 - authoredTotal) / unsizedCount : 0;
		this.#initialSizes = this.#normalizeSizes(authored.map((size) => size ?? share));
		this.#sizes = [...this.#initialSizes];
	}

	// `size` accepts `30` / `30%` (percent share) or `250px` (mapped through the
	// grow space). Returns a percent share, or null when unset/invalid.
	#parseSize(raw, extra, freeGrow) {
		if (!raw) return null;
		const value = parseFloat(raw);
		if (!Number.isFinite(value) || value < 0) return null;
		if (raw.trim().endsWith('px')) {
			return freeGrow > 0 ? Math.max(0, ((value - extra) / freeGrow) * 100) : null;
		}
		return value;
	}

	#normalizeSizes(sizes) {
		const total = sizes.reduce((sum, size) => sum + size, 0);
		if (total <= 0) return sizes.map(() => Math.round(10000 / sizes.length) / 100);
		return sizes.map((size) => Math.round((size / total) * 10000) / 100);
	}

	// Reads the group's direct children in document order and pairs each panel
	// with the divider that follows it. An author-supplied <split-divider>
	// between two panels is ADOPTED — wired exactly like a generated one, never
	// removed. A divider is generated only where an adjacent pair has none.
	// Strays (a divider before the first panel, after the last, or a second one
	// in a row) are left alone and unwired rather than moved or deleted.
	#syncStructure() {
		const _ = this;
		_.#scanning = true;

		const panels = [];
		const dividers = [];
		const wired = new Set();
		let pending = null;

		for (const child of _.children) {
			const tag = child.localName;
			if (tag === 'split-panel') {
				if (panels.length > 0) dividers[panels.length - 1] = pending;
				panels.push(child);
				pending = null;
			} else if (tag === 'split-divider' && !pending) {
				// only the first divider after a panel is a candidate; a second
				// one in a row stays a stray
				pending = child;
			}
		}

		// generate the missing ones — a fresh divider goes directly after its panel
		for (let index = 0; index < panels.length - 1; index += 1) {
			if (!dividers[index]) {
				const divider = document.createElement('split-divider');
				_.#generated.add(divider);
				panels[index].after(divider);
				dividers[index] = divider;
			}
			_.#wireDivider(dividers[index], index);
			wired.add(dividers[index]);
		}

		// drop dividers this component generated that no longer sit between a
		// pair (their neighbour panel went away); un-wire adopted ones that
		// became strays, leaving the element itself in place
		for (const divider of [..._.#generated]) {
			if (wired.has(divider)) continue;
			_.#generated.delete(divider);
			divider.remove();
		}
		for (const divider of _.#dividers) {
			if (!wired.has(divider) && divider.isConnected) _.#unwireDivider(divider);
		}

		_.#panels = panels;
		_.#dividers = dividers.slice(0, Math.max(0, panels.length - 1));
		// discard the records our own insertions/removals just queued
		_.#childObserver?.takeRecords();
		_.#scanning = false;
	}

	#wireDivider(divider, index) {
		divider.setAttribute('role', 'separator');
		divider.setAttribute('aria-valuemin', '0');
		divider.setAttribute('aria-valuemax', '100');
		// respect an author's own accessible name; only ever rewrite our own
		const authorNamed =
			!this.#labelled.has(divider) &&
			(divider.hasAttribute('aria-label') || divider.hasAttribute('aria-labelledby'));
		if (authorNamed) return;
		this.#labelled.add(divider);
		divider.setAttribute('aria-label', `Resize panels ${index + 1} and ${index + 2}`);
	}

	#unwireDivider(divider) {
		for (const name of [
			'role',
			'tabindex',
			'aria-orientation',
			'aria-valuemin',
			'aria-valuemax',
			'aria-valuenow',
			'aria-disabled',
		]) {
			divider.removeAttribute(name);
		}
		if (this.#labelled.has(divider)) {
			divider.removeAttribute('aria-label');
			this.#labelled.delete(divider);
		}
	}

	#observeChildren() {
		if (this.#childObserver) return;
		// child list only — a panel's own subtree is none of the group's business
		this.#childObserver = new MutationObserver(() => this.#handleChildMutation());
		this.#childObserver.observe(this, { childList: true });
	}

	// MutationObserver already batches to one callback per microtask, so this
	// runs at most once per turn no matter how many children were touched
	#handleChildMutation() {
		if (this.#scanning || !this.isConnected) return;
		if (!this.#initialized) {
			this.#init();
			return;
		}
		this.#rescan();
	}

	// Re-reads the structure after a child mutation, keeping committed sizes for
	// every panel that is still here (matched by element identity) and giving a
	// newly added panel its authored share (or an equal one when it has no
	// `size`). A structural change during a drag ENDS the drag: the gesture's
	// index and measured bounds describe a layout that no longer exists.
	#rescan() {
		const _ = this;
		const committed = new Map(_.#panels.map((panel, index) => [panel, _.#sizes[index]]));
		_.#syncStructure();

		// dropped when the dragged divider went away, or when it now sits between
		// a different pair — either way its index and measure are stale
		if (_.#drag && _.#dividers.indexOf(_.#drag.divider) !== _.#drag.index) {
			_.#drag = null;
			_.removeAttribute('dragging');
		}
		if (_.#panels.length === 0) {
			_.#sizes = [];
			_.#initialSizes = [];
			return;
		}

		// #resolveInitialSizes re-reads the authored attributes (and reseeds
		// #initialSizes, which `resetSizes` and double-click restore to)
		_.#resolveInitialSizes();
		_.#sizes = _.#clampSizes(_.#mergeSizes(committed));

		_.#syncOrientation();
		_.#syncDisabled();
		_.#mirrorConstraints();
		// a live drag owns the rendered sizes — writing here would discard the
		// in-flight delta; the next pointermove renders
		if (!_.#drag) _.#applySizes();
		_.#trackVisible();
	}

	// Merges committed sizes (by element identity) with the shares for panels
	// that are new. A new panel's share is read at FULL scale — an authored
	// `size="25"` means 25% of the whole once the others make room, not 25% of
	// a slice that then gets normalized again — and an unsized new panel takes
	// an equal share (100 / panel count). The panels that stayed are scaled
	// proportionally into whatever is left.
	#mergeSizes(committed) {
		const _ = this;
		const equalShare = 100 / _.#panels.length;
		const fresh = _.#panels.map((panel) =>
			committed.has(panel) ? null : (_.#authoredShare(panel) ?? equalShare)
		);
		const freshTotal = fresh.reduce((total, size) => total + (size ?? 0), 0);
		const keptTotal = _.#panels.reduce((total, panel) => total + (committed.get(panel) ?? 0), 0);
		// nothing new, or the new panels alone claim everything — fall back to a
		// plain normalization of what we have
		if (freshTotal <= 0 || freshTotal >= 100 || keptTotal <= 0) {
			return _.#normalizeSizes(
				_.#panels.map((panel, index) => committed.get(panel) ?? fresh[index] ?? 0)
			);
		}
		const keptScale = (100 - freshTotal) / keptTotal;
		return _.#panels.map((panel, index) =>
			fresh[index] === null
				? Math.round(committed.get(panel) * keptScale * 100) / 100
				: Math.round(fresh[index] * 100) / 100
		);
	}

	// A panel's authored `size` as a percent of the WHOLE — unnormalized, which
	// is what a panel arriving into a settled layout should claim. Percent forms
	// pass straight through; a px form maps through the distributable space, the
	// same basis #resolveInitialSizes and the drag math use.
	#authoredShare(panel) {
		const raw = panel.getAttribute('size');
		if (!raw) return null;
		if (!raw.trim().endsWith('px')) return this.#parseSize(raw, 0, 0);
		const horizontal = this.direction === 'horizontal';
		const dimension = horizontal ? 'width' : 'height';
		const freeGrow = this.#panels.reduce(
			(total, item) =>
				total + item.getBoundingClientRect()[dimension] - this.#panelExtra(item, horizontal),
			0
		);
		return this.#parseSize(raw, this.#panelExtra(panel, horizontal), freeGrow);
	}

	// Pulls a sizes array inside every panel's min/max, in the same percent
	// domain the drag math uses, then hands the leftover to the panels that
	// still have room. Without this a panel can hold a model size its `min`
	// will not render, and every neighbour calculation is skewed by the gap.
	#clampSizes(sizes) {
		const _ = this;
		const horizontal = _.direction === 'horizontal';
		const dimension = horizontal ? 'width' : 'height';
		const flexSpace = _.#panels.reduce(
			(total, panel) =>
				total + panel.getBoundingClientRect()[dimension] - _.#panelExtra(panel, horizontal),
			0
		);
		if (flexSpace <= 0) return sizes;

		const bounds = _.#panels.map((panel) => {
			const extra = _.#panelExtra(panel, horizontal);
			return {
				min: Math.max(0, _.#parseConstraint(panel.getAttribute('min'), extra, flexSpace, 0)),
				max: _.#parseConstraint(panel.getAttribute('max'), extra, flexSpace, Infinity),
			};
		});
		const clamp = (size, index) => Math.min(Math.max(size, bounds[index].min), bounds[index].max);

		let result = sizes.map(clamp);
		// clamping moves the total off 100 — give the difference to the panels
		// that can still take it, a few passes to settle
		for (let pass = 0; pass < 4; pass += 1) {
			const residual = 100 - result.reduce((total, size) => total + size, 0);
			if (Math.abs(residual) < 0.01) break;
			const eligible = result.map((size, index) =>
				residual > 0 ? size < bounds[index].max : size > bounds[index].min
			);
			const count = eligible.filter(Boolean).length;
			if (count === 0) break;
			const step = residual / count;
			result = result.map((size, index) => (eligible[index] ? clamp(size + step, index) : size));
		}
		return result.map((size) => Math.round(size * 100) / 100);
	}

	#syncOrientation() {
		// per ARIA, the separator's orientation describes the line itself —
		// a horizontal group has vertical divider lines, and vice versa
		const orientation = this.direction === 'vertical' ? 'horizontal' : 'vertical';
		for (const divider of this.#dividers) {
			divider.setAttribute('aria-orientation', orientation);
		}
	}

	#syncDisabled() {
		for (const divider of this.#dividers) {
			const disabled = this.disabled || divider.hasAttribute('disabled');
			divider.setAttribute('tabindex', disabled ? '-1' : '0');
			divider.setAttribute('aria-disabled', String(disabled));
		}
	}

	// mirror min/max to inline CSS so the browser enforces constraints
	// natively during container resizes — no ResizeObserver needed
	#mirrorConstraints() {
		const horizontal = this.direction === 'horizontal';
		for (const panel of this.#panels) {
			const min = this.#formatConstraint(panel.getAttribute('min'));
			const max = this.#formatConstraint(panel.getAttribute('max'));
			panel.style.minWidth = horizontal ? min : '';
			panel.style.maxWidth = horizontal ? max : '';
			panel.style.minHeight = horizontal ? '' : min;
			panel.style.maxHeight = horizontal ? '' : max;
		}
	}

	#formatConstraint(raw) {
		if (!raw) return '';
		const trimmed = raw.trim();
		return /^[\d.]+$/.test(trimmed) ? `${trimmed}px` : trimmed;
	}

	// padding + border sit outside the flex-distributed space — panels can't
	// shrink below them, and they offset the percent <-> pixel mapping
	#panelExtra(panel, horizontal) {
		const style = getComputedStyle(panel);
		const sides = horizontal
			? ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
			: ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'];
		return sides.reduce((total, side) => total + parseFloat(style[side]), 0);
	}

	// resolves a min/max attribute to the same percent units as `size` —
	// % values pass through, px values map through the distributable space
	#parseConstraint(raw, extra, flexSpace, fallback) {
		if (!raw) return fallback;
		const value = parseFloat(raw);
		if (!Number.isFinite(value)) return fallback;
		return raw.trim().endsWith('%') ? value : ((value - extra) / flexSpace) * 100;
	}

	// Optional readout for effects: expose `--split-panel-visible` (0 at min, 1
	// at max) on any panel that has a `max`. Layout stays pure flex — this is a
	// cosmetic reflection of rendered size, so it needs a ResizeObserver to stay
	// correct across drags, window resizes, and nested groups.
	#trackVisible() {
		this.#visibleObserver?.disconnect();
		this.#visibleObserver = null;
		const bounded = this.#panels.filter((panel) => panel.hasAttribute('max'));
		if (bounded.length === 0) return;
		this.#visibleObserver = new ResizeObserver((entries) => this.#applyVisible(entries));
		for (const panel of bounded) this.#visibleObserver.observe(panel);
	}

	#applyVisible(entries) {
		const _ = this;
		const horizontal = _.direction === 'horizontal';
		const axisSpace = _.getBoundingClientRect()[horizontal ? 'width' : 'height'];
		for (const entry of entries) {
			const panel = entry.target;
			const box = entry.borderBoxSize?.[0];
			const size = box
				? horizontal
					? box.inlineSize
					: box.blockSize
				: panel.getBoundingClientRect()[horizontal ? 'width' : 'height'];
			const min = _.#constraintToPixels(panel.getAttribute('min'), axisSpace, 0);
			const max = _.#constraintToPixels(panel.getAttribute('max'), axisSpace, Infinity);
			const range = max - min;
			const visible = range > 0 ? Math.min(Math.max((size - min) / range, 0), 1) : 1;
			panel.style.setProperty('--split-panel-visible', Math.round(visible * 1000) / 1000);
		}
	}

	#constraintToPixels(raw, axisSpace, fallback) {
		if (!raw) return fallback;
		const value = parseFloat(raw);
		if (!Number.isFinite(value)) return fallback;
		return raw.trim().endsWith('%') ? (value / 100) * axisSpace : value;
	}

	#applySizes() {
		this.#panels.forEach((panel, index) => {
			panel.style.setProperty('--split-panel-size', this.#sizes[index]);
		});
		this.#dividers.forEach((divider, index) => {
			divider.setAttribute('aria-valuenow', String(Math.round(this.#sizes[index])));
		});
	}

	/**
	 * Measures the group's distributable space (panel rects minus each panel's
	 * padding and border) and resolves the pair's min/max attributes into
	 * percent-domain bounds on the previous panel. Constant for a whole gesture.
	 */
	#measurePair(index) {
		const _ = this;
		const horizontal = _.direction === 'horizontal';
		const dimension = horizontal ? 'width' : 'height';
		const previousPanel = _.#panels[index];
		const nextPanel = _.#panels[index + 1];
		const flexSpace = _.#panels.reduce(
			(total, panel) =>
				total + panel.getBoundingClientRect()[dimension] - _.#panelExtra(panel, horizontal),
			0
		);
		if (flexSpace <= 0) return null;
		const pairPercent = _.#sizes[index] + _.#sizes[index + 1];
		const previousExtra = _.#panelExtra(previousPanel, horizontal);
		const nextExtra = _.#panelExtra(nextPanel, horizontal);

		const clampToPair = (value) => Math.min(Math.max(value, 0), pairPercent);
		const minPrevious = clampToPair(
			Math.max(
				_.#parseConstraint(previousPanel.getAttribute('min'), previousExtra, flexSpace, 0),
				pairPercent -
					_.#parseConstraint(nextPanel.getAttribute('max'), nextExtra, flexSpace, Infinity)
			)
		);
		const maxPrevious = clampToPair(
			Math.min(
				_.#parseConstraint(previousPanel.getAttribute('max'), previousExtra, flexSpace, Infinity),
				pairPercent - _.#parseConstraint(nextPanel.getAttribute('min'), nextExtra, flexSpace, 0)
			)
		);

		return { pairPercent, flexSpace, minPrevious, maxPrevious };
	}

	/**
	 * Clamps a target percent share for the previous panel against the pair's
	 * bounds, writes both neighbors, renders, and dispatches a live resize event.
	 * @returns {boolean} whether the sizes actually changed
	 */
	#setPairSizes(index, previousShare, measure) {
		const _ = this;
		const clamped = Math.min(Math.max(previousShare, measure.minPrevious), measure.maxPrevious);
		const previousPercent = Math.round(clamped * 100) / 100;
		const nextPercent = Math.round((measure.pairPercent - previousPercent) * 100) / 100;
		if (previousPercent === _.#sizes[index] && nextPercent === _.#sizes[index + 1]) return false;
		_.#sizes[index] = previousPercent;
		_.#sizes[index + 1] = nextPercent;
		_.#applySizes();
		_.#dispatch('split-panel:resize', { sizes: _.sizes, divider: index });
		return true;
	}

	// redistribute the pair's current total in the pair's initial ratio — a
	// pair-local reset that keeps the full array summing to 100 even after
	// other dividers have moved
	#resetPair(index) {
		const _ = this;
		const pairPercent = _.#sizes[index] + _.#sizes[index + 1];
		const initialPair = _.#initialSizes[index] + _.#initialSizes[index + 1];
		if (initialPair <= 0) return;
		const previousPercent =
			Math.round((_.#initialSizes[index] / initialPair) * pairPercent * 100) / 100;
		_.#sizes[index] = previousPercent;
		_.#sizes[index + 1] = Math.round((pairPercent - previousPercent) * 100) / 100;
		_.#applySizes();
		_.#dispatch('split-panel:resize', { sizes: _.sizes, divider: index });
		_.#commit(index);
	}

	#restoreSavedSizes() {
		if (!this.id) return;
		try {
			const saved = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${this.id}`));
			const valid =
				Array.isArray(saved) &&
				saved.length === this.#panels.length &&
				saved.every((size) => Number.isFinite(size) && size >= 0);
			if (valid) this.#sizes = this.#normalizeSizes(saved);
		} catch {
			// localStorage unavailable or corrupted — keep initial sizes
		}
	}

	#persist() {
		if (!this.id) return;
		try {
			localStorage.setItem(`${STORAGE_PREFIX}${this.id}`, JSON.stringify(this.#sizes));
		} catch {
			// localStorage unavailable — persistence is best-effort
		}
	}

	#commit(dividerIndex) {
		this.#dispatch('split-panel:resize-end', { sizes: this.sizes, divider: dividerIndex });
		this.#persist();
	}

	#dispatch(type, detail) {
		// composed so a group inside a shadow root still reports to its host page
		this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
	}

	// resolves an event to one of this group's own wired dividers — the
	// parentElement check keeps nested groups from driving each other's panels,
	// and the index check ignores strays (unpaired author-supplied dividers)
	#resolveDivider(event) {
		const divider = event.target.closest?.('split-divider');
		if (!divider || divider.parentElement !== this) return null;
		if (this.#dividers.indexOf(divider) === -1) return null;
		if (this.disabled || divider.hasAttribute('disabled')) return null;
		return divider;
	}

	#handlePointerDown(e) {
		const _ = this;
		const divider = _.#resolveDivider(e);
		if (!divider || _.#drag) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;

		const index = _.#dividers.indexOf(divider);
		const measure = _.#measurePair(index);
		if (!measure) return;

		_.#drag = {
			pointerId: e.pointerId,
			divider,
			index,
			startCoordinate: _.direction === 'vertical' ? e.clientY : e.clientX,
			startShare: _.#sizes[index],
			startSizes: [_.#sizes[index], _.#sizes[index + 1]],
			measure,
		};
		_.setAttribute('dragging', '');
		_.#capturePointer(divider, e);
	}

	// capture on the divider (not the group) so the composed click/dblclick
	// events still target it — capture retargets those too
	#capturePointer(divider, e) {
		// touch has implicit capture; explicit re-capture fires spurious
		// pointercancel on some mobile engines
		if (e.pointerType === 'touch') return;
		try {
			divider.setPointerCapture(e.pointerId);
		} catch {
			// capture is best-effort
		}
	}

	#handlePointerMove(e) {
		const _ = this;
		const drag = _.#drag;
		if (!drag || e.pointerId !== drag.pointerId) return;
		if (e.pointerType === 'mouse' && e.buttons === 0) {
			// missed pointerup (e.g. released outside a frame) — self-heal
			_.#handlePointerEnd(e);
			return;
		}
		const coordinate = _.direction === 'vertical' ? e.clientY : e.clientX;
		const deltaShare = ((coordinate - drag.startCoordinate) * 100) / drag.measure.flexSpace;
		_.#setPairSizes(drag.index, drag.startShare + deltaShare, drag.measure);
	}

	#handlePointerEnd(e) {
		const _ = this;
		const drag = _.#drag;
		if (!drag || e.pointerId !== drag.pointerId) return;
		_.#drag = null;
		_.removeAttribute('dragging');
		try {
			if (drag.divider.hasPointerCapture?.(e.pointerId)) {
				drag.divider.releasePointerCapture(e.pointerId);
			}
		} catch {
			// release is best-effort
		}
		const moved =
			_.#sizes[drag.index] !== drag.startSizes[0] ||
			_.#sizes[drag.index + 1] !== drag.startSizes[1];
		if (!moved) return;
		// [dragging] is already off, so snapping/settling eases if animation is on
		const snapped = _.#snapShare(drag.index, drag.measure);
		if (snapped !== null) _.#setPairSizes(drag.index, snapped, drag.measure);
		_.#commit(drag.index);
	}

	// On release, settle the divider onto the nearest `snap` point. Points are
	// percentages of the divider's travel (0 = previous panel at its minimum,
	// 100 = at its maximum); bare `snap` defaults to 0/50/100. Returns the
	// snapped share, or null when snapping is off or there is no travel.
	#snapShare(index, measure) {
		const raw = this.getAttribute('snap');
		if (raw === null) return null;
		const parsed = raw
			.split(/[\s,]+/)
			.map(Number)
			.filter((point) => Number.isFinite(point) && point >= 0 && point <= 100);
		const points = parsed.length ? parsed : [0, 50, 100];
		const travel = measure.maxPrevious - measure.minPrevious;
		if (travel <= 0) return null;
		const fraction = ((this.#sizes[index] - measure.minPrevious) / travel) * 100;
		const nearest = points.reduce((best, point) =>
			Math.abs(point - fraction) < Math.abs(best - fraction) ? point : best
		);
		return measure.minPrevious + (nearest / 100) * travel;
	}

	#handleDoubleClick(e) {
		const divider = this.#resolveDivider(e);
		if (!divider) return;
		this.#resetPair(this.#dividers.indexOf(divider));
	}

	#handleKeyDown(e) {
		const _ = this;
		const divider = _.#resolveDivider(e);
		if (!divider) return;

		if (e.key === 'Enter') {
			e.preventDefault();
			_.#resetPair(_.#dividers.indexOf(divider));
			return;
		}

		const index = _.#dividers.indexOf(divider);
		const measure = _.#measurePair(index);
		if (!measure) return;

		const vertical = _.direction === 'vertical';
		const step = e.shiftKey ? 10 : 1;
		let targetShare;
		switch (e.key) {
			case vertical ? 'ArrowUp' : 'ArrowLeft':
				targetShare = _.#sizes[index] - step;
				break;
			case vertical ? 'ArrowDown' : 'ArrowRight':
				targetShare = _.#sizes[index] + step;
				break;
			case 'Home':
				targetShare = measure.minPrevious;
				break;
			case 'End':
				targetShare = measure.maxPrevious;
				break;
			default:
				return;
		}
		e.preventDefault();
		if (_.#setPairSizes(index, targetShare, measure)) {
			_.#commit(index);
		}
	}
}

if (!customElements.get('split-panel-group')) {
	customElements.define('split-panel-group', SplitPanelGroup);
}
