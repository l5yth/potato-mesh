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
 * Child-list reconciliation for the chat (#881, SPEC DR1).
 *
 * A live refresh hands each chat container the children it should hold: the
 * tab strip its buttons, the panel wrapper its panels, a panel its day
 * dividers and entries. The caller reuses the node of everything that did not
 * change, so a node's identity is its key. This module brings a container's
 * child list in line with the wanted one while touching as few nodes as it
 * can: an unchanged list costs no DOM operation, unwanted children are
 * removed, new nodes are inserted, and of the children that stay only those
 * outside one longest in-order run are moved.
 *
 * Moving a node removes it from the document for an instant. The browser then
 * drops focus inside it and collapses a text selection in it, so a node that
 * keeps its place must not be re-inserted, not even at the same position.
 *
 * @module chat-reconcile
 */

/**
 * Indices of one longest strictly increasing subsequence of ``values``
 * (patience sorting with predecessor links, O(n log n)). Among runs of equal
 * length it keeps the one that ends lowest, so of two swapped neighbours the
 * earlier one is the one reported as out of order.
 *
 * @param {Array<number>} values Sequence to scan.
 * @returns {Array<number>} Ascending indices into ``values`` forming the run.
 */
export function longestIncreasingSubsequence(values) {
  // tails[k]: index of the lowest last value of any increasing run of length k + 1.
  const tails = [];
  const previous = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]] < values[index]) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    previous[index] = low > 0 ? tails[low - 1] : -1;
    tails[low] = index;
  }
  const run = [];
  for (let index = tails.length > 0 ? tails[tails.length - 1] : -1; index >= 0; index = previous[index]) {
    run.push(index);
  }
  return run.reverse();
}

/**
 * The child list a container should end up with. Falsy entries are dropped,
 * and a node listed twice keeps only its last place, which is where appending
 * it twice would leave it.
 *
 * @param {Array<?Node>} nodes Wanted children, in order.
 * @returns {Array<Node>} Distinct wanted children, in order.
 */
function distinctNodes(nodes) {
  const lastIndex = new Map();
  nodes.forEach((node, index) => lastIndex.set(node, index));
  return nodes.filter((node, index) => Boolean(node) && lastIndex.get(node) === index);
}

/**
 * Make ``parent``'s children exactly ``nodes``, in order, with the fewest DOM
 * operations. A child that is wanted and already in order with the others is
 * left untouched; see the module notes for why that matters.
 *
 * A host without ``insertBefore`` and ``removeChild`` (minimal DOM stand-ins)
 * gets a single ``replaceChildren`` call instead, and only when its children
 * differ from the wanted list.
 *
 * @param {Node} parent Container whose children are reconciled.
 * @param {Array<?Node>} nodes Wanted children, in order; falsy entries are skipped.
 * @returns {{ inserted: number, moved: number, removed: number }} DOM operations
 *   performed: new nodes inserted, kept children moved, children removed. A
 *   ``replaceChildren`` host reports every wanted node as inserted and every
 *   previous child as removed.
 */
export function reconcileChildNodes(parent, nodes) {
  const wanted = distinctNodes(Array.isArray(nodes) ? nodes : []);
  const current = Array.from(parent.childNodes || []);
  const counts = { inserted: 0, moved: 0, removed: 0 };
  if (current.length === wanted.length && current.every((node, index) => node === wanted[index])) {
    return counts;
  }
  if (typeof parent.insertBefore !== 'function' || typeof parent.removeChild !== 'function') {
    parent.replaceChildren(...wanted);
    counts.inserted = wanted.length;
    counts.removed = current.length;
    return counts;
  }

  const position = new Map(wanted.map((node, index) => [node, index]));
  const kept = [];
  for (const node of current) {
    if (position.has(node)) {
      kept.push(node);
    } else {
      parent.removeChild(node);
      counts.removed += 1;
    }
  }
  const keptSet = new Set(kept);
  const inOrder = new Set(longestIncreasingSubsequence(kept.map(node => position.get(node))).map(index => kept[index]));

  // Walk from the end so each node is placed before its already-placed
  // successor; nodes of the in-order run are already where they belong.
  let successor = null;
  for (let index = wanted.length - 1; index >= 0; index -= 1) {
    const node = wanted[index];
    if (!inOrder.has(node)) {
      parent.insertBefore(node, successor);
      if (keptSet.has(node)) {
        counts.moved += 1;
      } else {
        counts.inserted += 1;
      }
    }
    successor = node;
  }
  return counts;
}
