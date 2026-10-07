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

// The map legend's column and group skeleton (SPEC LS1/LS2): two columns,
// MeshCore stacked over Reticulum in the first, Meshtastic in the second.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDomEnvironment } from '../../__tests__/dom-environment.js';
import { LEGEND_STACK_PROTOCOLS, buildLegendColumns, legendStackInView } from '../legend-columns.js';

/**
 * Build the skeleton into a fresh container inside a stub DOM.
 *
 * @returns {{container: Object, legend: Object, cleanup: function(): void}}
 *   The container, what {@link buildLegendColumns} returned, and a handle
 *   that restores the globals.
 */
function buildSkeleton() {
  const env = createDomEnvironment();
  const container = env.document.createElement('div');
  return { container, legend: buildLegendColumns(container), cleanup: () => env.cleanup() };
}

/**
 * Assert an element's children by identity and in order.
 *
 * @param {Object} element Parent element.
 * @param {Array<Object>} expected Expected children.
 * @param {string} message Assertion message.
 * @returns {void}
 */
function assertChildren(element, expected, message) {
  assert.equal(element.childNodes.length, expected.length, message);
  expected.forEach((child, index) => assert.equal(element.childNodes[index], child, message));
}

test('buildLegendColumns builds two columns: the stack, then Meshtastic (LS1)', () => {
  const { container, legend, cleanup } = buildSkeleton();
  try {
    assertChildren(container, [legend.stack, legend.meshtasticColumn], 'two columns, the stack first');
    assert.equal(legend.stack.className, 'legend-column legend-column--stack');
    assert.equal(legend.meshtasticColumn.className, 'legend-column', 'the Meshtastic column keeps its classes');
  } finally {
    cleanup();
  }
});

test('buildLegendColumns stacks the MeshCore group over the Reticulum group (LS1)', () => {
  const { legend, cleanup } = buildSkeleton();
  try {
    assertChildren(legend.stack, [legend.meshcoreGroup, legend.reticulumGroup], 'MeshCore first, Reticulum below');
    assert.equal(legend.meshcoreGroup.className, 'legend-group');
    assert.equal(legend.reticulumGroup.className, 'legend-group');
    assert.deepEqual(LEGEND_STACK_PROTOCOLS, ['meshcore', 'reticulum'], 'the stack protocols, top to bottom');
  } finally {
    cleanup();
  }
});

test('each group and the Meshtastic column open with their protocol header (LS2)', () => {
  const { legend, cleanup } = buildSkeleton();
  try {
    for (const [element, protocol, label] of [
      [legend.meshcoreGroup, 'meshcore', 'Meshcore'],
      [legend.reticulumGroup, 'reticulum', 'Reticulum'],
      [legend.meshtasticColumn, 'meshtastic', 'Meshtastic'],
    ]) {
      assert.equal(element.childNodes.length, 1, `${label}: the header only; main.js appends the role filters`);
      const [header] = element.childNodes;
      assert.equal(header.className, 'legend-column-header');
      assert.equal(header.childNodes.length, 3, `${label}: tile, label, count`);
      const [icon, title, count] = header.childNodes;
      assert.equal(icon.className, `protocol-icon protocol-icon--${protocol}`);
      assert.equal(title.textContent, label);
      assert.equal(count, legend.counts[protocol], `${label}: the count span is returned`);
      assert.equal(count.className, 'legend-protocol-count');
      assert.equal(count.textContent, '', `${label}: the count starts empty`);
    }
  } finally {
    cleanup();
  }
});

test('legendStackInView keeps the stack while either of its groups is in view (LS1)', () => {
  assert.equal(legendStackInView(new Set(['meshcore', 'meshtastic', 'reticulum'])), true);
  assert.equal(legendStackInView(new Set(['meshcore'])), true, 'MeshCore alone keeps it');
  assert.equal(legendStackInView(new Set(['reticulum', 'meshtastic'])), true, 'Reticulum alone keeps it');
  assert.equal(legendStackInView(new Set(['meshtastic'])), false, 'both groups out of view: it leaves the row');
  assert.equal(legendStackInView(new Set()), false, 'nothing in view');
});
