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
 * SPEC MT1: tooltip content that Leaflet builds when the tooltip opens. The
 * content functions render their badges only when called, return what the
 * eager builders return, and are ``null`` exactly where those builders
 * return ``''``, so a line that had no tooltip still gets none.
 *
 * Non-ASCII short names make every badge run one grapheme segmentation, which
 * the segmenter spy counts.
 *
 * @module main/__tests__/tooltip-html-lazy
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { installSegmenterSpy } from '../../__tests__/segmenter-spy.js';
import {
  buildNeighborTooltipHtml,
  buildTraceTooltipHtml,
  neighborTooltipContent,
  traceTooltipContent,
} from '../tooltip-html.js';

// Installed before any badge renders; put back when the file ends.
const spy = installSegmenterSpy();
after(() => spy.restore());

const NODE_A = { node_id: '!a', short_name: 'Ä1', long_name: 'Node A', role: 'CLIENT', protocol: 'meshtastic', hw_model: 'T-Beam', battery_level: 80 };
const NODE_B = { node_id: '!b', short_name: '⚡', long_name: 'Node B', role: 'ROUTER', protocol: 'meshtastic' };
const NODE_C = { node_id: '!c', short_name: '日本', long_name: 'Node C', role: 'COMPANION', protocol: 'meshcore' };

/**
 * A neighbour segment as ``renderMap`` hands it to the tooltip builders.
 *
 * @param {Object} source Source node.
 * @param {Object} target Target node.
 * @returns {Object} Segment descriptor.
 */
function segmentOf(source, target) {
  return {
    sourceId: source.node_id,
    targetId: target.node_id,
    sourceShortName: source.short_name,
    sourceRole: source.role,
    targetShortName: target.short_name,
    targetRole: target.role,
    sourceNode: source,
    targetNode: target,
  };
}

test('neighbour tooltip content renders its two badges only when called (SPEC MT1)', () => {
  const segment = segmentOf(NODE_A, NODE_B);
  const before = spy.counts.segmented;
  const content = neighborTooltipContent(segment);
  assert.equal(typeof content, 'function');
  assert.equal(spy.counts.segmented - before, 0, 'binding renders no badge');
  // Leaflet calls the content with the layer; the HTML does not depend on it.
  const html = content({ layer: true });
  assert.equal(spy.counts.segmented - before, 2, 'opening renders both badges');
  assert.equal(html, buildNeighborTooltipHtml(segment));
  assert.equal(content(), html, 'every opening shows the same HTML');
});

test('trace tooltip content renders the path badges only when called (SPEC MT1)', () => {
  const pathNodes = [NODE_A, NODE_C, NODE_B];
  const before = spy.counts.segmented;
  const content = traceTooltipContent(pathNodes);
  assert.equal(typeof content, 'function');
  assert.equal(spy.counts.segmented - before, 0, 'binding renders no badge');
  const html = content();
  assert.equal(spy.counts.segmented - before, 3, 'opening renders the three hops');
  assert.equal(html, buildTraceTooltipHtml(pathNodes));
});

test('tooltip content is null exactly where the eager builders return an empty string (SPEC MT1)', () => {
  const blank = { ...NODE_B, short_name: '   ' };
  const unnamed = { node_id: '!e', role: 'CLIENT' };
  const camel = { nodeId: '!f', shortName: 'Fx', longName: 'Camel F' };
  const noId = { long_name: 'No id', node_id: 42 };
  const segments = [
    null,
    undefined,
    {},
    segmentOf(NODE_A, NODE_B),
    segmentOf(NODE_A, blank),
    segmentOf(blank, NODE_A),
    { ...segmentOf(NODE_A, blank), targetShortName: '' },
    { ...segmentOf(NODE_A, NODE_B), sourceShortName: '' },
    { ...segmentOf(NODE_A, NODE_B), sourceShortName: '  ', targetShortName: null },
    { sourceShortName: 'X', targetShortName: 'Y' },
    { sourceShortName: 'X', targetNode: unnamed },
    { sourceNode: unnamed, targetNode: camel },
    { sourceNode: noId, targetNode: NODE_B },
    { sourceShortName: 'X', targetNode: noId },
    { sourceNode: camel, targetNode: { ...camel, shortName: '' } },
  ];
  for (const [index, segment] of segments.entries()) {
    const eager = buildNeighborTooltipHtml(segment);
    const content = neighborTooltipContent(segment);
    if (eager === '') {
      assert.equal(content, null, `segment ${index} binds no tooltip`);
    } else {
      assert.equal(typeof content, 'function', `segment ${index} binds content`);
      assert.equal(content(), eager, `segment ${index} shows the eager HTML`);
    }
  }

  const sparse = [NODE_A];
  sparse[2] = NODE_B;
  const paths = [
    null,
    undefined,
    {},
    'ab',
    [],
    [NODE_A],
    [NODE_A, NODE_B],
    [null, NODE_A],
    [NODE_A, 'x'],
    [null, undefined],
    ['x', 1, false],
    [[], null],
    new Array(3),
    sparse,
    [NODE_A, NODE_C, NODE_B, blank, unnamed],
  ];
  for (const [index, pathNodes] of paths.entries()) {
    const eager = buildTraceTooltipHtml(pathNodes);
    const content = traceTooltipContent(pathNodes);
    if (eager === '') {
      assert.equal(content, null, `path ${index} binds no tooltip`);
    } else {
      assert.equal(typeof content, 'function', `path ${index} binds content`);
      assert.equal(content(), eager, `path ${index} shows the eager HTML`);
    }
  }
});
