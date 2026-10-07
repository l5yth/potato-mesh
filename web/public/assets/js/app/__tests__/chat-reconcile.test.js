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
 * Unit tests for the chat child-list reconciler (#881, SPEC DR1). The local
 * node model has one parent per node, so inserting an attached node moves it,
 * and it counts every time a node leaves its parent, a move included: that is
 * the event that costs a browser the focus and selection inside the node.
 *
 * @module __tests__/chat-reconcile
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { longestIncreasingSubsequence, reconcileChildNodes } from '../chat-reconcile.js';

/** A node with one parent at a time that counts how often it was removed. */
class Node {
  /**
   * @param {string} name Label used in assertions.
   */
  constructor(name) {
    this.name = name;
    this.parentNode = null;
    this.childNodes = [];
    this.removals = 0;
  }

  /**
   * Detach this node from its parent, counting the removal.
   *
   * @returns {void}
   */
  leaveParent() {
    const parent = this.parentNode;
    if (!parent) return;
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
    this.parentNode = null;
    this.removals += 1;
  }

  /**
   * Insert ``node`` before ``ref`` (append when ``ref`` is null), moving it.
   *
   * @param {Node} node Node to insert.
   * @param {?Node} ref Reference child.
   * @returns {Node} The inserted node.
   */
  insertBefore(node, ref) {
    node.leaveParent();
    const index = ref === null ? this.childNodes.length : this.childNodes.indexOf(ref);
    if (index < 0) throw new Error('reference node is not a child');
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  /**
   * Remove a child.
   *
   * @param {Node} node Child to remove.
   * @returns {Node} The removed node.
   */
  removeChild(node) {
    if (node.parentNode !== this) throw new Error('not a child');
    node.leaveParent();
    return node;
  }
}

/**
 * A parent holding ``names`` as children.
 *
 * @param {...string} names Child labels.
 * @returns {{ parent: Node, nodes: Object<string, Node> }} Parent and children by label.
 */
function parentWith(...names) {
  const parent = new Node('parent');
  const nodes = {};
  for (const name of names) {
    nodes[name] = new Node(name);
    parent.insertBefore(nodes[name], null);
  }
  return { parent, nodes };
}

/**
 * Child labels of ``parent``, in order.
 *
 * @param {Node} parent Parent node.
 * @returns {Array<string>} Labels.
 */
function names(parent) {
  return parent.childNodes.map(node => node.name);
}

test('longestIncreasingSubsequence finds one longest increasing run', () => {
  assert.deepEqual(longestIncreasingSubsequence([]), []);
  assert.deepEqual(longestIncreasingSubsequence([7]), [0]);
  assert.deepEqual(longestIncreasingSubsequence([0, 1, 2, 3]), [0, 1, 2, 3]);
  assert.equal(longestIncreasingSubsequence([3, 2, 1, 0]).length, 1);
  assert.deepEqual(longestIncreasingSubsequence([3, 0, 1, 2]), [1, 2, 3]);
  // Of two swapped neighbours the earlier one is left out of the run.
  assert.deepEqual(longestIncreasingSubsequence([0, 1, 3, 2]), [0, 1, 3]);
  assert.deepEqual(longestIncreasingSubsequence([2, 5, 1, 8, 3, 9]), [0, 1, 3, 5]);
});

test('reconcileChildNodes leaves an unchanged list alone (DR1, #881)', () => {
  const { parent, nodes } = parentWith('a', 'b', 'c');
  const counts = reconcileChildNodes(parent, [nodes.a, nodes.b, nodes.c]);
  assert.deepEqual(counts, { inserted: 0, moved: 0, removed: 0 });
  assert.deepEqual(names(parent), ['a', 'b', 'c']);
  assert.deepEqual([nodes.a, nodes.b, nodes.c].map(node => node.removals), [0, 0, 0]);
});

test('reconcileChildNodes appends a new node and touches no other', () => {
  const { parent, nodes } = parentWith('a', 'b');
  const fresh = new Node('c');
  const counts = reconcileChildNodes(parent, [nodes.a, nodes.b, fresh]);
  assert.deepEqual(counts, { inserted: 1, moved: 0, removed: 0 });
  assert.deepEqual(names(parent), ['a', 'b', 'c']);
  assert.equal(nodes.a.removals + nodes.b.removals, 0);
});

test('reconcileChildNodes inserts before the first child and in the middle', () => {
  const { parent, nodes } = parentWith('b', 'd');
  const counts = reconcileChildNodes(parent, [new Node('a'), nodes.b, new Node('c'), nodes.d]);
  assert.deepEqual(counts, { inserted: 2, moved: 0, removed: 0 });
  assert.deepEqual(names(parent), ['a', 'b', 'c', 'd']);
  assert.equal(nodes.b.removals + nodes.d.removals, 0);
});

test('reconcileChildNodes removes children that are no longer wanted', () => {
  const { parent, nodes } = parentWith('old', 'a', 'b');
  const counts = reconcileChildNodes(parent, [nodes.a, nodes.b]);
  assert.deepEqual(counts, { inserted: 0, moved: 0, removed: 1 });
  assert.deepEqual(names(parent), ['a', 'b']);
  assert.equal(nodes.old.parentNode, null);
  assert.equal(nodes.a.removals + nodes.b.removals, 0);
});

test('reconcileChildNodes swaps in a replacement at the same place', () => {
  const { parent, nodes } = parentWith('a', 'b', 'c');
  const rebuilt = new Node('b2');
  const counts = reconcileChildNodes(parent, [nodes.a, rebuilt, nodes.c]);
  assert.deepEqual(counts, { inserted: 1, moved: 0, removed: 1 });
  assert.deepEqual(names(parent), ['a', 'b2', 'c']);
  assert.equal(nodes.a.removals + nodes.c.removals, 0);
});

test('reconcileChildNodes moves only the nodes outside the longest in-order run', () => {
  const { parent, nodes } = parentWith('log', 'primary', 'alpha', 'bravo');
  // Bravo overtakes Alpha: one of the two has to move, the others stay.
  const counts = reconcileChildNodes(parent, [nodes.log, nodes.primary, nodes.bravo, nodes.alpha]);
  assert.deepEqual(counts, { inserted: 0, moved: 1, removed: 0 });
  assert.deepEqual(names(parent), ['log', 'primary', 'bravo', 'alpha']);
  assert.equal(nodes.alpha.removals, 1, 'the earlier of the swapped pair moved');
  assert.equal(nodes.log.removals + nodes.primary.removals + nodes.bravo.removals, 0);

  const reversed = parentWith('a', 'b', 'c', 'd');
  const flipped = reconcileChildNodes(reversed.parent, ['d', 'c', 'b', 'a'].map(name => reversed.nodes[name]));
  assert.equal(flipped.moved, 3, 'a reversal keeps one node and moves three');
  assert.deepEqual(names(reversed.parent), ['d', 'c', 'b', 'a']);
});

test('reconcileChildNodes adopts a node from another parent', () => {
  const { parent } = parentWith();
  const other = parentWith('x');
  const counts = reconcileChildNodes(parent, [other.nodes.x]);
  assert.deepEqual(counts, { inserted: 1, moved: 0, removed: 0 });
  assert.deepEqual(names(parent), ['x']);
  assert.deepEqual(names(other.parent), []);
});

test('reconcileChildNodes skips falsy entries and keeps a repeated node at its last place', () => {
  const { parent, nodes } = parentWith('a', 'b');
  const counts = reconcileChildNodes(parent, [nodes.a, null, nodes.b, undefined, nodes.a]);
  assert.deepEqual(names(parent), ['b', 'a']);
  assert.deepEqual(counts, { inserted: 0, moved: 1, removed: 0 });
  assert.equal(nodes.b.removals, 0);
});

test('reconcileChildNodes treats a missing list as empty', () => {
  const { parent } = parentWith('a', 'b');
  assert.deepEqual(reconcileChildNodes(parent, null), { inserted: 0, moved: 0, removed: 2 });
  assert.deepEqual(names(parent), []);
  const bare = { childNodes: undefined, replaceChildren() {} };
  assert.deepEqual(reconcileChildNodes(bare, []), { inserted: 0, moved: 0, removed: 0 });
});

test('reconcileChildNodes falls back to one replaceChildren call on a host without insertBefore', () => {
  const calls = [];
  const host = {
    childNodes: ['a', 'b'],
    replaceChildren(...nodes) {
      calls.push(nodes);
      this.childNodes = nodes;
    }
  };
  assert.deepEqual(reconcileChildNodes(host, ['a', 'b']), { inserted: 0, moved: 0, removed: 0 });
  assert.equal(calls.length, 0, 'an unchanged list makes no call');

  assert.deepEqual(reconcileChildNodes(host, ['a', 'b', 'c']), { inserted: 3, moved: 0, removed: 2 });
  assert.deepEqual(calls, [['a', 'b', 'c']]);

  const removeOnly = { childNodes: ['a'], removeChild() {}, replaceChildren(...nodes) { this.childNodes = nodes; } };
  reconcileChildNodes(removeOnly, []);
  assert.deepEqual(removeOnly.childNodes, [], 'removeChild alone is not enough to reconcile in place');
});
