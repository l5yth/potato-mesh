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
 * Keyed reconciliation of table rows (#881, SPEC DR1 and DR5).
 *
 * `renderTable` used to build every row of `#nodes tbody` from scratch and
 * swap the whole set in with `replaceChildren`, about once a second on a busy
 * mesh. Every swap removed every row, so focus fell to `<body>`, a text
 * selection collapsed, an open `+` disclosure closed, an overlay anchored to
 * a badge lost its anchor and the row under a page-scrolled reader changed.
 *
 * The reconciler keeps the element of every row whose rendered content did
 * not change. Each render describes its rows as specs: a key that names the
 * row across renders, a signature (the rendered content minus anything that
 * changes with the clock alone) and a factory. A row whose key and signature
 * both match the previous render keeps its element; a changed or new row gets
 * a fresh element; a row that left the render is removed. Rows then move into
 * render order with the fewest moves: the kept rows that already sit in a
 * longest increasing run of their old positions stay put, the rest move, so
 * one node sorting to the top moves its own rows and nothing else.
 *
 * Children the reconciler did not create (the server-rendered waiting row,
 * SPEC UX4) are never touched; their owner keeps managing them.
 *
 * @module main/keyed-rows
 */

/**
 * Clock reading, in unix seconds, at which a row signature stamps its
 * relative-time cells.
 *
 * A relative-time cell ("4m 10s", SPEC RT1) is a pure function of its
 * `data-ts-ago` timestamp and the clock, and the shared ticker rewrites its
 * text in place every second (RT2). Building the signature's copy of those
 * cells at one fixed instant removes the clock and keeps the timestamp, so a
 * row is rebuilt when its timestamp changes, never because time passed.
 *
 * @type {number}
 */
export const SIGNATURE_CLOCK_SECONDS = 0;

/**
 * One row of a keyed render.
 *
 * @typedef {Object} KeyedRowSpec
 * @property {string} key Names the row across renders, e.g. `node:!a1b2c3d4`.
 *   A key repeated within one render is made unique by its occurrence count.
 * @property {string} signature Everything the factory renders into the
 *   element, minus clock-dependent text and the state `sync` owns. Equal
 *   signatures mean the kept element still shows the right content.
 * @property {function(): Element} create Build a fresh element for the row.
 * @property {function(Element): void} [sync] Write the per-render state that
 *   is not part of the signature (zebra stripe, age bucket, disclosure state)
 *   onto the element, kept or fresh. Runs before a fresh element is inserted
 *   and must write only what differs.
 */

/**
 * Outcome of one {@link KeyedRowReconciler#reconcile} pass.
 *
 * @typedef {Object} KeyedRowsResult
 * @property {Map<string, Element>} elements The element of every key, in
 *   render order.
 * @property {number} created Rows built fresh: new keys and changed rows.
 * @property {number} kept Rows whose element survived.
 * @property {number} removed Elements taken out: rows that left the render
 *   and the previous element of every changed row.
 * @property {number} moved Kept rows moved into render order.
 */

/**
 * Positions, in `sequence`, of one longest strictly increasing run of its
 * non-negative entries (patience sorting with back-links, O(n log n)).
 *
 * Negative entries mark rows with no previous position and never belong to
 * the run.
 *
 * @param {Array<number>} sequence Previous position per row, in render order,
 *   or `-1` for a fresh row.
 * @returns {Set<number>} Indexes into `sequence` of the run's members.
 */
export function longestIncreasingRun(sequence) {
  // tails[k] is the index of the smallest last value of any increasing run
  // of length k + 1 seen so far; back[i] links each entry to its predecessor.
  const tails = [];
  const back = new Array(sequence.length).fill(-1);
  for (let i = 0; i < sequence.length; i += 1) {
    const value = sequence[i];
    if (value < 0) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (sequence[tails[mid]] < value) low = mid + 1;
      else high = mid;
    }
    if (low > 0) back[i] = tails[low - 1];
    tails[low] = i;
  }
  const members = new Set();
  for (let i = tails.length > 0 ? tails[tails.length - 1] : -1; i >= 0; i = back[i]) {
    members.add(i);
  }
  return members;
}

/**
 * Detach an element from its parent.
 *
 * @param {Element} parent The parent holding `element`.
 * @param {Element} element Child to remove.
 * @returns {void}
 */
function removeRow(parent, element) {
  if (typeof element.remove === 'function') {
    element.remove();
  } else {
    parent.removeChild(element);
  }
}

/**
 * Move a kept row before `next`. `moveBefore` keeps focus and running
 * animations (the live-update fade, SPEC LV1) where the engine has it; it
 * throws for a disconnected parent, and then a plain insert does the move.
 *
 * @param {Element} parent The parent holding `element`.
 * @param {Element} element Kept row to move.
 * @param {?Element} next Row that must follow it, or `null` for the end.
 * @returns {void}
 */
function moveRow(parent, element, next) {
  if (typeof parent.moveBefore === 'function') {
    try {
      parent.moveBefore(element, next);
      return;
    } catch (err) {
      // A disconnected parent cannot move state-preservingly; insert instead.
    }
  }
  parent.insertBefore(element, next);
}

/**
 * Make every key of one render unique, in render order.
 *
 * @param {Array<KeyedRowSpec>} specs Row specs.
 * @returns {Array<{key: string, spec: KeyedRowSpec}>} Specs with unique keys.
 */
function uniqueKeys(specs) {
  const seen = new Map();
  return specs.map(spec => {
    const base = String(spec.key);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return { key: count === 0 ? base : `${base}#${count}`, spec };
  });
}

/**
 * Keyed row reconciler for one parent element.
 *
 * @typedef {Object} KeyedRowReconciler
 * @property {function(Element, Array<KeyedRowSpec>): KeyedRowsResult} reconcile
 *   Bring the parent's keyed children in line with one render.
 * @property {function(?Element): ?string} keyOf The key a row was rendered
 *   under, or `null` for an element this reconciler did not create.
 */

/**
 * Create a reconciler. Each instance remembers the key and signature of the
 * elements it created in a `WeakMap`, so the rows carry no extra attributes
 * and a dropped row is garbage-collected with its record.
 *
 * @returns {KeyedRowReconciler} The reconciler.
 */
export function createKeyedRowReconciler() {
  const records = new WeakMap();

  /**
   * @param {?Element} element Candidate row.
   * @returns {?string} Its key, or `null` when this reconciler did not build it.
   */
  function keyOf(element) {
    const record = element ? records.get(element) : undefined;
    return record ? record.key : null;
  }

  /**
   * Bring `parent`'s keyed children in line with `specs`.
   *
   * Kept rows are synced in place, changed and new rows are built and synced
   * before they are inserted, rows that left the render are removed, and the
   * result is ordered with the fewest moves. A parent without `insertBefore`
   * (the shared Node test mock) gets the final order in one `replaceChildren`
   * call, which also drops children the reconciler does not own, exactly as
   * the pre-#881 render did; the identity of kept rows holds there as well.
   *
   * @param {Element} parent The rows' parent, e.g. `#nodes tbody`.
   * @param {Array<KeyedRowSpec>} specs Rows of this render, in order.
   * @returns {KeyedRowsResult} What changed.
   */
  function reconcile(parent, specs) {
    const result = { elements: new Map(), created: 0, kept: 0, removed: 0, moved: 0 };
    const current = Array.from(parent.children || []).filter(element => records.has(element));
    const previous = new Map();
    current.forEach((element, index) => previous.set(records.get(element).key, { element, index }));

    const stale = new Set(current);
    const rows = [];
    const positions = [];
    for (const { key, spec } of uniqueKeys(Array.isArray(specs) ? specs : [])) {
      const before = previous.get(key);
      let element;
      if (before && records.get(before.element).signature === spec.signature) {
        element = before.element;
        stale.delete(element);
        positions.push(before.index);
        result.kept += 1;
      } else {
        element = spec.create();
        records.set(element, { key, signature: spec.signature });
        positions.push(-1);
        result.created += 1;
      }
      if (typeof spec.sync === 'function') spec.sync(element);
      rows.push(element);
      result.elements.set(key, element);
    }

    result.removed = stale.size;
    if (typeof parent.insertBefore !== 'function') {
      parent.replaceChildren(...rows);
      return result;
    }
    for (const element of stale) removeRow(parent, element);

    // Walk backwards so every row is placed before an already-placed
    // successor; rows on the longest increasing run are already in order.
    const stay = longestIncreasingRun(positions);
    let next = null;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const element = rows[i];
      if (!stay.has(i)) {
        if (positions[i] >= 0) {
          moveRow(parent, element, next);
          result.moved += 1;
        } else {
          parent.insertBefore(element, next);
        }
      }
      next = element;
    }
    return result;
  }

  return { reconcile, keyOf };
}
