/**
 * A single resizable panel inside a <split-panel-group>.
 * Sizing (`--split-panel-size`) and min/max constraints are wired by the parent group.
 * @class SplitPanel
 * @extends HTMLElement
 */
export class SplitPanel extends HTMLElement {}

/**
 * Drag handle between two adjacent panels. <split-panel-group> generates one
 * for any adjacent pair that has none, and adopts — wires, but never moves or
 * removes — any the author wrote between two panels.
 * @class SplitDivider
 * @extends HTMLElement
 */
export class SplitDivider extends HTMLElement {}

if (!customElements.get('split-panel')) {
	customElements.define('split-panel', SplitPanel);
}

if (!customElements.get('split-divider')) {
	customElements.define('split-divider', SplitDivider);
}
