/*
 * Copyright © 2025-26 l5yth & contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Keep the reader's place in a keyed table across a live refresh (#881,
 * SPEC DR1).
 *
 * A keyed render ({@link module:main/keyed-rows}) keeps every unchanged row,
 * so focus, selection and overlay anchors inside those rows survive on their
 * own. A changed row is rebuilt, and three things anchored to its old element
 * would be lost with it. This module snapshots them before the reconcile and
 * carries them over afterwards:
 *
 * - **focus** moves to the same control of the replacement row (the same
 *   element again when a kept row was moved by a plain insert, which drops
 *   focus); it is restored with `preventScroll`, so it never scrolls;
 * - **an open short-info overlay** anchored to a badge in the row is
 *   re-anchored to the same badge of the replacement, the LD-A3 pattern map
 *   markers use; overlays whose row left the table are left for
 *   `cleanupOrphans` to close;
 * - **the row under a page-scrolled reader** keeps its viewport offset. CSS
 *   scroll anchoring does this natively once rows are kept (measured in
 *   Chromium 153: the adjustment lands during the reconcile's own layout), so
 *   the manual correction runs only where `overflow-anchor` is unsupported,
 *   and only once the table's top has scrolled out of view; while it is in
 *   view the reader may be reading what sits above it, which must not move.
 *
 * "The same control" is located structurally: the index of its cell in the
 * row, then its tag, class and ordinal among same-tag, same-class elements of
 * that cell. A control that no longer exists in the new row is not replaced
 * by a guess.
 *
 * @module main/reader-place
 */

/**
 * Where a control sits inside its row.
 *
 * @typedef {Object} ControlLocator
 * @property {number} cell Index of the control's cell among the row's
 *   element children, or `-1` for the row itself.
 * @property {string} tagName The control's tag name.
 * @property {string} className The control's `class` attribute.
 * @property {number} ordinal Position among the cell's descendants with the
 *   same tag and class, or `-1` for the cell itself.
 */

/**
 * Everything one reconcile could take away from the reader.
 *
 * @typedef {Object} ReaderPlace
 * @property {?{element: Element, key: string, locator: ControlLocator}} focus
 *   The focused control, when it sits in a keyed row.
 * @property {Array<{anchor: Element, key: string, locator: ControlLocator}>} overlays
 *   Open overlays anchored inside keyed rows.
 * @property {?Array<{row: Element, top: number}>} anchor Viewport offsets of
 *   the visible rows, top first; `null` when no manual anchoring is needed.
 */

/**
 * Inclusive-descendant test that tolerates a root without `contains`.
 *
 * @param {?Element} root Container.
 * @param {*} node Candidate node.
 * @returns {boolean} Whether `node` is `root` or below it.
 */
function holds(root, node) {
  return Boolean(root && node) && typeof root.contains === 'function' && root.contains(node);
}

/**
 * Element children of a node, as an array.
 *
 * @param {Element} node Parent.
 * @returns {Array<Element>} Its element children.
 */
function elementChildren(node) {
  return Array.from(node.children);
}

/**
 * The `class` attribute of an element (SVG-safe, unlike `className`).
 *
 * @param {Element} element Element.
 * @returns {string} Its class attribute, or `''`.
 */
function classOf(element) {
  return element.getAttribute('class') || '';
}

/**
 * Descendants of `cell` that look like `probe`: same tag and class, in
 * document order.
 *
 * @param {Element} cell Cell to search.
 * @param {string} tagName Tag name to match.
 * @param {string} className Class attribute to match.
 * @returns {Array<Element>} Matching descendants.
 */
function lookalikes(cell, tagName, className) {
  const found = [];
  /**
   * Collect matching descendants of `node`, depth first.
   *
   * @param {Element} node Subtree root.
   * @returns {void}
   */
  const visit = node => {
    for (const child of elementChildren(node)) {
      if (child.tagName === tagName && classOf(child) === className) found.push(child);
      visit(child);
    }
  };
  visit(cell);
  return found;
}

/**
 * The child of `root` that holds `element` (its row).
 *
 * @param {Element} root Rows' parent, e.g. `#nodes tbody`.
 * @param {?Element} element A row or a node inside one.
 * @returns {?Element} The row, or `null` when `element` is not below `root`.
 */
export function rowOfControl(root, element) {
  let node = element;
  while (node && node.parentNode !== root) node = node.parentNode;
  return node || null;
}

/**
 * Describe where `element` sits inside `row`.
 *
 * @param {Element} row The row holding `element`.
 * @param {Element} element The row itself or a node inside it.
 * @returns {ControlLocator} Its locator.
 */
export function describeControl(row, element) {
  if (element === row) {
    return { cell: -1, tagName: element.tagName, className: classOf(element), ordinal: -1 };
  }
  let cell = element;
  while (cell.parentNode !== row) cell = cell.parentNode;
  const index = elementChildren(row).indexOf(cell);
  const ordinal = element === cell
    ? -1
    : lookalikes(cell, element.tagName, classOf(element)).indexOf(element);
  return { cell: index, tagName: element.tagName, className: classOf(element), ordinal };
}

/**
 * Find the control a locator describes in a (rebuilt) row.
 *
 * @param {?Element} row Row to search.
 * @param {?ControlLocator} locator From {@link describeControl}.
 * @returns {?Element} The control, or `null` when the row has no such control.
 */
export function locateControl(row, locator) {
  if (!row || !locator) return null;
  if (locator.cell < 0) return row;
  const cell = elementChildren(row)[locator.cell];
  if (!cell) return null;
  if (locator.ordinal < 0) {
    return cell.tagName === locator.tagName && classOf(cell) === locator.className ? cell : null;
  }
  return lookalikes(cell, locator.tagName, locator.className)[locator.ordinal] || null;
}

/**
 * Whether the engine anchors scrolling natively (CSS `overflow-anchor`).
 *
 * @param {?Window} windowRef Window to probe.
 * @returns {boolean} `true` when `overflow-anchor: auto` is supported.
 */
export function supportsNativeScrollAnchoring(windowRef) {
  const css = windowRef ? windowRef.CSS : null;
  return Boolean(css && typeof css.supports === 'function' && css.supports('overflow-anchor', 'auto'));
}

/**
 * Snapshot the focused control, when it sits in a keyed row.
 *
 * @param {Element} tbody Rows' parent.
 * @param {function(?Element): ?string} keyOf Row key lookup.
 * @param {?Document} documentRef Document whose focus to read.
 * @returns {?{element: Element, key: string, locator: ControlLocator}} The focus entry.
 */
function captureFocus(tbody, keyOf, documentRef) {
  const active = documentRef ? documentRef.activeElement : null;
  if (!holds(tbody, active)) return null;
  const row = rowOfControl(tbody, active);
  const key = keyOf(row);
  return key ? { element: active, key, locator: describeControl(row, active) } : null;
}

/**
 * Snapshot the open overlays anchored inside keyed rows.
 *
 * @param {Element} tbody Rows' parent.
 * @param {function(?Element): ?string} keyOf Row key lookup.
 * @param {?{getOpenOverlays: Function}} overlayStack Short-info overlay stack.
 * @returns {Array<{anchor: Element, key: string, locator: ControlLocator}>} Overlay entries.
 */
function captureOverlays(tbody, keyOf, overlayStack) {
  if (!overlayStack || typeof overlayStack.getOpenOverlays !== 'function') return [];
  const entries = [];
  for (const { anchor } of overlayStack.getOpenOverlays()) {
    if (!holds(tbody, anchor)) continue;
    const row = rowOfControl(tbody, anchor);
    const key = keyOf(row);
    if (key) entries.push({ anchor, key, locator: describeControl(row, anchor) });
  }
  return entries;
}

/**
 * Snapshot the viewport offsets of the visible rows, top first, when the
 * page is scrolled and the engine does not anchor scrolling itself.
 *
 * @param {Element} tbody Rows' parent.
 * @param {?Window} windowRef Window whose scroll to read.
 * @returns {?Array<{row: Element, top: number}>} Visible rows, or `null`.
 */
function captureScrollAnchor(tbody, windowRef) {
  if (!windowRef || typeof windowRef.scrollBy !== 'function' || supportsNativeScrollAnchoring(windowRef)) return null;
  // At the top of the page the reader has scrolled to no place worth
  // keeping; CSS anchoring stands down there too, and so does the fallback.
  if (!((Number(windowRef.scrollY) || 0) > 0)) return null;
  // While the table's top is in view, the reader can see what sits above it
  // (the chat on the dashboard), and CSS anchoring would anchor that, so a row
  // landing in the table must not move the page. Anchor only once the reader
  // has scrolled into the rows.
  if (!(tbody.getBoundingClientRect().top < 0)) return null;
  const viewportHeight = Number(windowRef.innerHeight) || 0;
  const visible = [];
  for (const row of elementChildren(tbody)) {
    const rect = row.getBoundingClientRect();
    if (rect.top >= viewportHeight) break;
    if (rect.height > 0 && rect.bottom > 0) visible.push({ row, top: rect.top });
  }
  return visible;
}

/**
 * Snapshot what a reconcile of `tbody` could take away from the reader.
 * Call it after building the render's specs and before reconciling.
 *
 * @param {Object} options Inputs.
 * @param {Element} options.tbody Rows' parent.
 * @param {function(?Element): ?string} options.keyOf Row key lookup of the
 *   reconciler that will render `tbody`.
 * @param {?Document} [options.documentRef] Document holding focus.
 * @param {?Object} [options.overlayStack] Short-info overlay stack.
 * @param {?Window} [options.windowRef] Window for page scroll.
 * @returns {ReaderPlace} The snapshot.
 */
export function captureReaderPlace({ tbody, keyOf, documentRef = null, overlayStack = null, windowRef = null }) {
  return {
    focus: captureFocus(tbody, keyOf, documentRef),
    overlays: captureOverlays(tbody, keyOf, overlayStack),
    anchor: captureScrollAnchor(tbody, windowRef),
  };
}

/**
 * Carry a {@link ReaderPlace} over to the reconciled rows.
 *
 * @param {ReaderPlace} place Snapshot from {@link captureReaderPlace}.
 * @param {Object} options Inputs.
 * @param {Element} options.tbody Rows' parent.
 * @param {Map<string, Element>} options.elements Row element per key after
 *   the reconcile ({@link module:main/keyed-rows~KeyedRowsResult}).
 * @param {?Document} [options.documentRef] Document holding focus.
 * @param {?Object} [options.overlayStack] Short-info overlay stack.
 * @param {?Window} [options.windowRef] Window for page scroll.
 * @param {boolean} [options.rowsShifted] Whether the reconcile inserted,
 *   moved or removed rows. Kept rows below such a change move with it, and an
 *   overlay on a kept badge follows only when it is repositioned: a scroll
 *   repositions overlays, but where no anchoring scroll happens nothing else
 *   would.
 * @returns {{refocused: boolean, reanchored: number, scrolledBy: number, repositioned: boolean}}
 *   What was restored.
 */
export function restoreReaderPlace(place, {
  tbody, elements, documentRef = null, overlayStack = null, windowRef = null, rowsShifted = false,
}) {
  const restored = { refocused: false, reanchored: 0, scrolledBy: 0, repositioned: false };

  for (const entry of place.overlays) {
    if (holds(tbody, entry.anchor)) continue;
    const target = locateControl(elements.get(entry.key), entry.locator);
    if (target && overlayStack.reanchor(entry.anchor, target)) restored.reanchored += 1;
  }

  const focus = place.focus;
  const active = documentRef ? documentRef.activeElement : null;
  // Refocus only when the reconcile dropped focus; never steal it from a
  // control the reader (or other code) focused since.
  if (focus && active !== focus.element && (!active || active === documentRef.body)) {
    const target = holds(tbody, focus.element)
      ? focus.element
      : locateControl(elements.get(focus.key), focus.locator);
    if (target) {
      target.focus({ preventScroll: true });
      restored.refocused = true;
    }
  }

  const kept = place.anchor ? place.anchor.find(entry => holds(tbody, entry.row)) : null;
  if (kept) {
    const delta = kept.row.getBoundingClientRect().top - kept.top;
    if (delta !== 0) {
      windowRef.scrollBy(0, delta);
      restored.scrolledBy = delta;
    }
  }

  if (rowsShifted && overlayStack) {
    overlayStack.positionAll();
    restored.repositioned = true;
  }
  return restored;
}
