//#region src/components/split-panel-group.js
var STORAGE_PREFIX = "split-panel:";
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
var SplitPanelGroup = class extends HTMLElement {
	static observedAttributes = ["direction", "disabled"];
	#panels = [];
	#dividers = [];
	#sizes = [];
	#initialSizes = [];
	#drag = null;
	#initialized = false;
	#visibleObserver = null;
	#childObserver = null;
	#scanning = false;
	#generated = /* @__PURE__ */ new Set();
	#labelled = /* @__PURE__ */ new WeakSet();
	constructor() {
		super();
		const _ = this;
		_.handlers = {
			pointerDown: (e) => _.#handlePointerDown(e),
			pointerMove: (e) => _.#handlePointerMove(e),
			pointerEnd: (e) => _.#handlePointerEnd(e),
			doubleClick: (e) => _.#handleDoubleClick(e),
			keyDown: (e) => _.#handleKeyDown(e)
		};
	}
	connectedCallback() {
		if (!this.querySelector(":scope > split-panel") && document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", () => this.#init(), { once: true });
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
		if (name === "direction") {
			this.#syncOrientation();
			this.#mirrorConstraints();
		}
		if (name === "disabled") this.#syncDisabled();
	}
	/** @returns {'horizontal' | 'vertical'} the layout axis */
	get direction() {
		return this.getAttribute("direction") === "vertical" ? "vertical" : "horizontal";
	}
	get disabled() {
		return this.hasAttribute("disabled");
	}
	set disabled(value) {
		this.toggleAttribute("disabled", Boolean(value));
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
		if (!(Array.isArray(sizes) && sizes.length === this.#panels.length && sizes.every((size) => Number.isFinite(size) && size >= 0))) return;
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
		this.#toggleListeners("addEventListener");
	}
	detachListeners() {
		this.#toggleListeners("removeEventListener");
	}
	#toggleListeners(method) {
		const _ = this;
		_[method]("pointerdown", _.handlers.pointerDown);
		_[method]("pointermove", _.handlers.pointerMove);
		_[method]("pointerup", _.handlers.pointerEnd);
		_[method]("pointercancel", _.handlers.pointerEnd);
		_[method]("lostpointercapture", _.handlers.pointerEnd);
		_[method]("dblclick", _.handlers.doubleClick);
		_[method]("keydown", _.handlers.keyDown);
	}
	#init() {
		if (!this.isConnected) return;
		this.#observeChildren();
		this.#syncStructure();
		if (this.#panels.length === 0) return;
		this.#resolveInitialSizes();
		this.#restoreSavedSizes();
		this.#syncOrientation();
		this.#syncDisabled();
		this.#mirrorConstraints();
		this.#applySizes();
		this.#trackVisible();
		this.attachListeners();
		this.#initialized = true;
		requestAnimationFrame(() => this.setAttribute("ready", ""));
	}
	#resolveInitialSizes() {
		const raw = this.#panels.map((panel) => panel.getAttribute("size"));
		const horizontal = this.direction === "horizontal";
		const dimension = horizontal ? "width" : "height";
		let freeGrow = 0;
		let extras = [];
		if (raw.some((value) => value && value.trim().endsWith("px"))) {
			const panelSpace = this.#panels.reduce((total, panel) => total + panel.getBoundingClientRect()[dimension], 0);
			extras = this.#panels.map((panel) => this.#panelExtra(panel, horizontal));
			freeGrow = panelSpace - extras.reduce((total, extra) => total + extra, 0);
		}
		const authored = raw.map((value, index) => this.#parseSize(value, extras[index] ?? 0, freeGrow));
		const authoredTotal = authored.reduce((total, size) => total + (size ?? 0), 0);
		const unsizedCount = authored.filter((size) => size === null).length;
		const share = unsizedCount > 0 ? Math.max(0, 100 - authoredTotal) / unsizedCount : 0;
		this.#initialSizes = this.#normalizeSizes(authored.map((size) => size ?? share));
		this.#sizes = [...this.#initialSizes];
	}
	#parseSize(raw, extra, freeGrow) {
		if (!raw) return null;
		const value = parseFloat(raw);
		if (!Number.isFinite(value) || value < 0) return null;
		if (raw.trim().endsWith("px")) return freeGrow > 0 ? Math.max(0, (value - extra) / freeGrow * 100) : null;
		return value;
	}
	#normalizeSizes(sizes) {
		const total = sizes.reduce((sum, size) => sum + size, 0);
		if (total <= 0) return sizes.map(() => Math.round(1e4 / sizes.length) / 100);
		return sizes.map((size) => Math.round(size / total * 1e4) / 100);
	}
	#syncStructure() {
		const _ = this;
		_.#scanning = true;
		const panels = [];
		const dividers = [];
		const wired = /* @__PURE__ */ new Set();
		let pending = null;
		for (const child of _.children) {
			const tag = child.localName;
			if (tag === "split-panel") {
				if (panels.length > 0) dividers[panels.length - 1] = pending;
				panels.push(child);
				pending = null;
			} else if (tag === "split-divider" && !pending) pending = child;
		}
		for (let index = 0; index < panels.length - 1; index += 1) {
			if (!dividers[index]) {
				const divider = document.createElement("split-divider");
				_.#generated.add(divider);
				panels[index].after(divider);
				dividers[index] = divider;
			}
			_.#wireDivider(dividers[index], index);
			wired.add(dividers[index]);
		}
		for (const divider of [..._.#generated]) {
			if (wired.has(divider)) continue;
			_.#generated.delete(divider);
			divider.remove();
		}
		for (const divider of _.#dividers) if (!wired.has(divider) && divider.isConnected) _.#unwireDivider(divider);
		_.#panels = panels;
		_.#dividers = dividers.slice(0, Math.max(0, panels.length - 1));
		_.#childObserver?.takeRecords();
		_.#scanning = false;
	}
	#wireDivider(divider, index) {
		divider.setAttribute("role", "separator");
		divider.setAttribute("aria-valuemin", "0");
		divider.setAttribute("aria-valuemax", "100");
		if (!this.#labelled.has(divider) && (divider.hasAttribute("aria-label") || divider.hasAttribute("aria-labelledby"))) return;
		this.#labelled.add(divider);
		divider.setAttribute("aria-label", `Resize panels ${index + 1} and ${index + 2}`);
	}
	#unwireDivider(divider) {
		for (const name of [
			"role",
			"tabindex",
			"aria-orientation",
			"aria-valuemin",
			"aria-valuemax",
			"aria-valuenow",
			"aria-disabled"
		]) divider.removeAttribute(name);
		if (this.#labelled.has(divider)) {
			divider.removeAttribute("aria-label");
			this.#labelled.delete(divider);
		}
	}
	#observeChildren() {
		if (this.#childObserver) return;
		this.#childObserver = new MutationObserver(() => this.#handleChildMutation());
		this.#childObserver.observe(this, { childList: true });
	}
	#handleChildMutation() {
		if (this.#scanning || !this.isConnected) return;
		if (!this.#initialized) {
			this.#init();
			return;
		}
		this.#rescan();
	}
	#rescan() {
		const _ = this;
		const committed = new Map(_.#panels.map((panel, index) => [panel, _.#sizes[index]]));
		_.#syncStructure();
		if (_.#drag && !_.#dividers.includes(_.#drag.divider)) {
			_.#drag = null;
			_.removeAttribute("dragging");
		}
		if (_.#panels.length === 0) {
			_.#sizes = [];
			_.#initialSizes = [];
			return;
		}
		_.#resolveInitialSizes();
		_.#sizes = _.#normalizeSizes(_.#panels.map((panel, index) => committed.get(panel) ?? _.#sizes[index]));
		_.#syncOrientation();
		_.#syncDisabled();
		_.#mirrorConstraints();
		_.#applySizes();
		_.#trackVisible();
	}
	#syncOrientation() {
		const orientation = this.direction === "vertical" ? "horizontal" : "vertical";
		for (const divider of this.#dividers) divider.setAttribute("aria-orientation", orientation);
	}
	#syncDisabled() {
		for (const divider of this.#dividers) {
			const disabled = this.disabled || divider.hasAttribute("disabled");
			divider.setAttribute("tabindex", disabled ? "-1" : "0");
			divider.setAttribute("aria-disabled", String(disabled));
		}
	}
	#mirrorConstraints() {
		const horizontal = this.direction === "horizontal";
		for (const panel of this.#panels) {
			const min = this.#formatConstraint(panel.getAttribute("min"));
			const max = this.#formatConstraint(panel.getAttribute("max"));
			panel.style.minWidth = horizontal ? min : "";
			panel.style.maxWidth = horizontal ? max : "";
			panel.style.minHeight = horizontal ? "" : min;
			panel.style.maxHeight = horizontal ? "" : max;
		}
	}
	#formatConstraint(raw) {
		if (!raw) return "";
		const trimmed = raw.trim();
		return /^[\d.]+$/.test(trimmed) ? `${trimmed}px` : trimmed;
	}
	#panelExtra(panel, horizontal) {
		const style = getComputedStyle(panel);
		return (horizontal ? [
			"paddingLeft",
			"paddingRight",
			"borderLeftWidth",
			"borderRightWidth"
		] : [
			"paddingTop",
			"paddingBottom",
			"borderTopWidth",
			"borderBottomWidth"
		]).reduce((total, side) => total + parseFloat(style[side]), 0);
	}
	#parseConstraint(raw, extra, flexSpace, fallback) {
		if (!raw) return fallback;
		const value = parseFloat(raw);
		if (!Number.isFinite(value)) return fallback;
		return raw.trim().endsWith("%") ? value : (value - extra) / flexSpace * 100;
	}
	#trackVisible() {
		this.#visibleObserver?.disconnect();
		this.#visibleObserver = null;
		const bounded = this.#panels.filter((panel) => panel.hasAttribute("max"));
		if (bounded.length === 0) return;
		this.#visibleObserver = new ResizeObserver((entries) => this.#applyVisible(entries));
		for (const panel of bounded) this.#visibleObserver.observe(panel);
	}
	#applyVisible(entries) {
		const _ = this;
		const horizontal = _.direction === "horizontal";
		const axisSpace = _.getBoundingClientRect()[horizontal ? "width" : "height"];
		for (const entry of entries) {
			const panel = entry.target;
			const box = entry.borderBoxSize?.[0];
			const size = box ? horizontal ? box.inlineSize : box.blockSize : panel.getBoundingClientRect()[horizontal ? "width" : "height"];
			const min = _.#constraintToPixels(panel.getAttribute("min"), axisSpace, 0);
			const range = _.#constraintToPixels(panel.getAttribute("max"), axisSpace, Infinity) - min;
			const visible = range > 0 ? Math.min(Math.max((size - min) / range, 0), 1) : 1;
			panel.style.setProperty("--split-panel-visible", Math.round(visible * 1e3) / 1e3);
		}
	}
	#constraintToPixels(raw, axisSpace, fallback) {
		if (!raw) return fallback;
		const value = parseFloat(raw);
		if (!Number.isFinite(value)) return fallback;
		return raw.trim().endsWith("%") ? value / 100 * axisSpace : value;
	}
	#applySizes() {
		this.#panels.forEach((panel, index) => {
			panel.style.setProperty("--split-panel-size", this.#sizes[index]);
		});
		this.#dividers.forEach((divider, index) => {
			divider.setAttribute("aria-valuenow", String(Math.round(this.#sizes[index])));
		});
	}
	/**
	* Measures the group's distributable space (panel rects minus each panel's
	* padding and border) and resolves the pair's min/max attributes into
	* percent-domain bounds on the previous panel. Constant for a whole gesture.
	*/
	#measurePair(index) {
		const _ = this;
		const horizontal = _.direction === "horizontal";
		const dimension = horizontal ? "width" : "height";
		const previousPanel = _.#panels[index];
		const nextPanel = _.#panels[index + 1];
		const flexSpace = _.#panels.reduce((total, panel) => total + panel.getBoundingClientRect()[dimension] - _.#panelExtra(panel, horizontal), 0);
		if (flexSpace <= 0) return null;
		const pairPercent = _.#sizes[index] + _.#sizes[index + 1];
		const previousExtra = _.#panelExtra(previousPanel, horizontal);
		const nextExtra = _.#panelExtra(nextPanel, horizontal);
		const clampToPair = (value) => Math.min(Math.max(value, 0), pairPercent);
		return {
			pairPercent,
			flexSpace,
			minPrevious: clampToPair(Math.max(_.#parseConstraint(previousPanel.getAttribute("min"), previousExtra, flexSpace, 0), pairPercent - _.#parseConstraint(nextPanel.getAttribute("max"), nextExtra, flexSpace, Infinity))),
			maxPrevious: clampToPair(Math.min(_.#parseConstraint(previousPanel.getAttribute("max"), previousExtra, flexSpace, Infinity), pairPercent - _.#parseConstraint(nextPanel.getAttribute("min"), nextExtra, flexSpace, 0)))
		};
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
		_.#dispatch("split-panel:resize", {
			sizes: _.sizes,
			divider: index
		});
		return true;
	}
	#resetPair(index) {
		const _ = this;
		const pairPercent = _.#sizes[index] + _.#sizes[index + 1];
		const initialPair = _.#initialSizes[index] + _.#initialSizes[index + 1];
		if (initialPair <= 0) return;
		const previousPercent = Math.round(_.#initialSizes[index] / initialPair * pairPercent * 100) / 100;
		_.#sizes[index] = previousPercent;
		_.#sizes[index + 1] = Math.round((pairPercent - previousPercent) * 100) / 100;
		_.#applySizes();
		_.#dispatch("split-panel:resize", {
			sizes: _.sizes,
			divider: index
		});
		_.#commit(index);
	}
	#restoreSavedSizes() {
		if (!this.id) return;
		try {
			const saved = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${this.id}`));
			if (Array.isArray(saved) && saved.length === this.#panels.length && saved.every((size) => Number.isFinite(size) && size >= 0)) this.#sizes = this.#normalizeSizes(saved);
		} catch {}
	}
	#persist() {
		if (!this.id) return;
		try {
			localStorage.setItem(`${STORAGE_PREFIX}${this.id}`, JSON.stringify(this.#sizes));
		} catch {}
	}
	#commit(dividerIndex) {
		this.#dispatch("split-panel:resize-end", {
			sizes: this.sizes,
			divider: dividerIndex
		});
		this.#persist();
	}
	#dispatch(type, detail) {
		this.dispatchEvent(new CustomEvent(type, {
			detail,
			bubbles: true,
			composed: true
		}));
	}
	#resolveDivider(event) {
		const divider = event.target.closest?.("split-divider");
		if (!divider || divider.parentElement !== this) return null;
		if (this.#dividers.indexOf(divider) === -1) return null;
		if (this.disabled || divider.hasAttribute("disabled")) return null;
		return divider;
	}
	#handlePointerDown(e) {
		const _ = this;
		const divider = _.#resolveDivider(e);
		if (!divider || _.#drag) return;
		if (e.pointerType === "mouse" && e.button !== 0) return;
		const index = _.#dividers.indexOf(divider);
		const measure = _.#measurePair(index);
		if (!measure) return;
		_.#drag = {
			pointerId: e.pointerId,
			divider,
			index,
			startCoordinate: _.direction === "vertical" ? e.clientY : e.clientX,
			startShare: _.#sizes[index],
			startSizes: [_.#sizes[index], _.#sizes[index + 1]],
			measure
		};
		_.setAttribute("dragging", "");
		_.#capturePointer(divider, e);
	}
	#capturePointer(divider, e) {
		if (e.pointerType === "touch") return;
		try {
			divider.setPointerCapture(e.pointerId);
		} catch {}
	}
	#handlePointerMove(e) {
		const _ = this;
		const drag = _.#drag;
		if (!drag || e.pointerId !== drag.pointerId) return;
		if (e.pointerType === "mouse" && e.buttons === 0) {
			_.#handlePointerEnd(e);
			return;
		}
		const deltaShare = ((_.direction === "vertical" ? e.clientY : e.clientX) - drag.startCoordinate) * 100 / drag.measure.flexSpace;
		_.#setPairSizes(drag.index, drag.startShare + deltaShare, drag.measure);
	}
	#handlePointerEnd(e) {
		const _ = this;
		const drag = _.#drag;
		if (!drag || e.pointerId !== drag.pointerId) return;
		_.#drag = null;
		_.removeAttribute("dragging");
		try {
			if (drag.divider.hasPointerCapture?.(e.pointerId)) drag.divider.releasePointerCapture(e.pointerId);
		} catch {}
		if (!(_.#sizes[drag.index] !== drag.startSizes[0] || _.#sizes[drag.index + 1] !== drag.startSizes[1])) return;
		const snapped = _.#snapShare(drag.index, drag.measure);
		if (snapped !== null) _.#setPairSizes(drag.index, snapped, drag.measure);
		_.#commit(drag.index);
	}
	#snapShare(index, measure) {
		const raw = this.getAttribute("snap");
		if (raw === null) return null;
		const parsed = raw.split(/[\s,]+/).map(Number).filter((point) => Number.isFinite(point) && point >= 0 && point <= 100);
		const points = parsed.length ? parsed : [
			0,
			50,
			100
		];
		const travel = measure.maxPrevious - measure.minPrevious;
		if (travel <= 0) return null;
		const fraction = (this.#sizes[index] - measure.minPrevious) / travel * 100;
		const nearest = points.reduce((best, point) => Math.abs(point - fraction) < Math.abs(best - fraction) ? point : best);
		return measure.minPrevious + nearest / 100 * travel;
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
		if (e.key === "Enter") {
			e.preventDefault();
			_.#resetPair(_.#dividers.indexOf(divider));
			return;
		}
		const index = _.#dividers.indexOf(divider);
		const measure = _.#measurePair(index);
		if (!measure) return;
		const vertical = _.direction === "vertical";
		const step = e.shiftKey ? 10 : 1;
		let targetShare;
		switch (e.key) {
			case vertical ? "ArrowUp" : "ArrowLeft":
				targetShare = _.#sizes[index] - step;
				break;
			case vertical ? "ArrowDown" : "ArrowRight":
				targetShare = _.#sizes[index] + step;
				break;
			case "Home":
				targetShare = measure.minPrevious;
				break;
			case "End":
				targetShare = measure.maxPrevious;
				break;
			default: return;
		}
		e.preventDefault();
		if (_.#setPairSizes(index, targetShare, measure)) _.#commit(index);
	}
};
if (!customElements.get("split-panel-group")) customElements.define("split-panel-group", SplitPanelGroup);
//#endregion
//#region src/components/split-panel.js
/**
* A single resizable panel inside a <split-panel-group>.
* Sizing (`--split-panel-size`) and min/max constraints are wired by the parent group.
* @class SplitPanel
* @extends HTMLElement
*/
var SplitPanel = class extends HTMLElement {};
/**
* Drag handle between two adjacent panels. <split-panel-group> generates one
* for any adjacent pair that has none, and adopts — wires, but never moves or
* removes — any the author wrote between two panels.
* @class SplitDivider
* @extends HTMLElement
*/
var SplitDivider = class extends HTMLElement {};
if (!customElements.get("split-panel")) customElements.define("split-panel", SplitPanel);
if (!customElements.get("split-divider")) customElements.define("split-divider", SplitDivider);
//#endregion
export { SplitDivider, SplitPanel, SplitPanelGroup };

//# sourceMappingURL=split-panel.esm.js.map