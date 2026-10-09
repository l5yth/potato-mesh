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
 * Adaptive fit of the nodes table (SPEC PO1).
 *
 * One long name or hardware model without a break opportunity can make the
 * auto-layout table wider than its column, and the page then scrolls
 * sideways. The stylesheet lets those cells break inside a word only while
 * `#nodes` carries {@link SQUEEZED_CLASS}. This module decides the class after
 * each render and when the table's column resizes: it measures the table
 * without the class against its own column, the `.nodes-table-wrapper` it
 * sits in, so nothing else on the page can flip it. A table that fits
 * unbroken never gets the class and keeps every column width.
 *
 * @module main/nodes-table-fit
 */

/** Class on `#nodes` while its identifier cells may break inside a word. */
export const SQUEEZED_CLASS = 'nodes-table--squeezed';

/**
 * Slack in px: a table at most this much wider than its column still fits,
 * so sub-pixel rounding between the two widths never flips the class.
 */
export const FIT_TOLERANCE_PX = 0.5;

/**
 * Decide the class from widths measured without it.
 *
 * @param {number} tableWidth Width of the table with its words unbroken.
 * @param {number} columnWidth Width of the table's column.
 * @returns {?boolean} `true` when the table is wider than its column,
 *   `false` when it fits, and `null` when a width is unusable (not finite, or
 *   a column of no width, as for a hidden table): no decision, the class stays.
 */
export function decideSqueezed(tableWidth, columnWidth) {
  if (!Number.isFinite(tableWidth) || !Number.isFinite(columnWidth) || columnWidth <= 0) return null;
  return tableWidth > columnWidth + FIT_TOLERANCE_PX;
}

/**
 * Width of an element's border box.
 *
 * @param {?Element} element Element to measure.
 * @returns {number} The width, or `NaN` without a measurable element.
 */
function boxWidth(element) {
  if (!element || typeof element.getBoundingClientRect !== 'function') return Number.NaN;
  return element.getBoundingClientRect().width;
}

/**
 * The table header's markup: a cheap signature of what in the header can
 * change the table's width, such as the sort arrow, a label or a colspan.
 *
 * @param {Element} table The `#nodes` table.
 * @returns {string} The header's markup, or `''` without one.
 */
function headerMarkup(table) {
  const head = typeof table.querySelector === 'function' ? table.querySelector('thead') : null;
  return head ? head.innerHTML : '';
}

/**
 * Set or clear {@link SQUEEZED_CLASS} for the table's current rows and column.
 *
 * A table without the class is measured as it is. A table with it has the
 * class removed, is measured, and gets it back only if it still overflows;
 * removal, measurement and the decision run in one synchronous task, so the
 * unbroken state never paints. A fitting table without the class is only
 * read, never written.
 *
 * @param {Element} table The `#nodes` table.
 * @param {?Element} column The element whose width the table may take.
 * @returns {boolean} Whether the class changed.
 */
export function fitNodesTable(table, column) {
  const had = table.classList.contains(SQUEEZED_CLASS);
  if (had) table.classList.remove(SQUEEZED_CLASS);
  const decision = decideSqueezed(boxWidth(table), boxWidth(column));
  const squeezed = decision === null ? had : decision;
  if (squeezed) table.classList.add(SQUEEZED_CLASS);
  return squeezed !== had;
}

/**
 * Keep {@link SQUEEZED_CLASS} right while the table renders and its column
 * resizes.
 *
 * `check` decides at once; the dashboard calls it after every render of the
 * table with the reconcile's counts, once the header is final. A render that
 * created, moved and removed no row, while the header kept its markup and
 * the column its width, keeps the last decision without measuring: the
 * unbroken table cannot have changed, and measuring would lay the table out
 * twice. A resize of the column (a `ResizeObserver`
 * on it, or window resizes where there is none) schedules one measured check
 * in the next animation frame, at most one per frame; a notification that
 * changes only the column's height, as when squeezed rows re-wrap, schedules
 * none.
 *
 * @param {?Element} table The `#nodes` table, or `null` on a view without it.
 * @param {Object} [options] Wiring.
 * @param {?Element} [options.column] The table's column: its parent by default.
 * @param {?Window} [options.windowRef] Window providing `ResizeObserver`,
 *   animation frames and resize events: the global window by default.
 * @returns {{check: function(?{created: number, moved: number, removed: number}=): boolean, disconnect: function(): void}}
 *   `check` decides now and reports whether the class changed; `disconnect`
 *   stops watching. Without a table, a class list or a column both are inert.
 */
export function watchNodesTableFit(table, {
  column = table ? table.parentElement || table.parentNode || null : null,
  windowRef = typeof window === 'undefined' ? null : window,
} = {}) {
  if (!table || !table.classList || !column) return { check: () => false, disconnect: () => {} };
  const win = windowRef || {};
  let frame = null;
  let stopped = false;
  let lastColumnWidth = null;
  let lastHeader = null;
  /**
   * Decide the class, measuring only when the decision can have changed: on
   * the first check, after a render that created, moved or removed a row,
   * when the header's markup or the column's width differs from the last
   * measurement, and whenever no counts are given, as on a resize.
   *
   * @param {?{created: number, moved: number, removed: number}} [rows] The
   *   render's reconcile counts ({@link module:main/keyed-rows}).
   * @returns {boolean} Whether the class changed.
   */
  const check = rows => {
    const header = headerMarkup(table);
    const sameRows = rows != null && rows.created + rows.moved + rows.removed === 0;
    if (sameRows && lastColumnWidth !== null && header === lastHeader && boxWidth(column) === lastColumnWidth) return false;
    const changed = fitNodesTable(table, column);
    lastColumnWidth = boxWidth(column);
    lastHeader = header;
    return changed;
  };
  /**
   * Check in the next animation frame, once however many resizes land first;
   * at once where the window has no animation frames.
   *
   * @returns {void}
   */
  const schedule = () => {
    if (typeof win.requestAnimationFrame !== 'function') {
      check();
      return;
    }
    if (frame !== null) return;
    frame = win.requestAnimationFrame(() => {
      frame = null;
      if (!stopped) check();
    });
  };
  let observer = null;
  let listening = false;
  if (typeof win.ResizeObserver === 'function') {
    let lastWidth = null;
    observer = new win.ResizeObserver(entries => {
      const { width } = entries[entries.length - 1].contentRect;
      if (width === lastWidth) return;
      lastWidth = width;
      schedule();
    });
    observer.observe(column);
  } else if (typeof win.addEventListener === 'function') {
    win.addEventListener('resize', schedule);
    listening = true;
  }
  /**
   * Stop the resize source this watcher started: the observer, or the window
   * listener where there is no observer.
   *
   * @returns {void}
   */
  const stopWatching = () => {
    if (observer) observer.disconnect();
    else if (listening) win.removeEventListener('resize', schedule);
  };
  return {
    check,
    /**
     * Stop watching: no resize schedules a check any more, and a pending
     * frame is cancelled or, where the window cannot cancel it, decides
     * nothing.
     *
     * @returns {void}
     */
    disconnect() {
      stopped = true;
      stopWatching();
      if (frame !== null && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
