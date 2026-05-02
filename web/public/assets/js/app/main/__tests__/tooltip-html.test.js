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

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNeighborTooltipHtml, buildTraceTooltipHtml } from '../tooltip-html.js';

// ---------------------------------------------------------------------------
// buildTraceTooltipHtml
// ---------------------------------------------------------------------------

test('buildTraceTooltipHtml returns empty string for non-arrays', () => {
  assert.equal(buildTraceTooltipHtml(null), '');
  assert.equal(buildTraceTooltipHtml(undefined), '');
  assert.equal(buildTraceTooltipHtml({}), '');
});

test('buildTraceTooltipHtml returns empty string when fewer than two hops are supplied', () => {
  assert.equal(buildTraceTooltipHtml([]), '');
  assert.equal(buildTraceTooltipHtml([{ short_name: 'A', node_id: '!a' }]), '');
});

test('buildTraceTooltipHtml emits a content fragment with arrows between hops', () => {
  const html = buildTraceTooltipHtml([
    { short_name: 'AAA', node_id: '!a' },
    { short_name: 'BBB', node_id: '!b' },
  ]);
  assert.ok(html.includes('trace-tooltip__content'));
  assert.ok(html.includes('trace-tooltip__arrow'));
  // One arrow between two badges.
  const arrowCount = (html.match(/trace-tooltip__arrow/g) || []).length;
  assert.equal(arrowCount, 1);
});

test('buildTraceTooltipHtml falls back to node_id when short name is missing', () => {
  const html = buildTraceTooltipHtml([
    { node_id: '!a' },
    { node_id: '!b' },
  ]);
  // The badge should reference the node_id.
  assert.ok(html.includes('!a'));
  assert.ok(html.includes('!b'));
});

test('buildTraceTooltipHtml filters out malformed entries', () => {
  const html = buildTraceTooltipHtml([
    null,
    { short_name: 'AAA', node_id: '!a' },
    'not an object',
    { short_name: 'BBB', node_id: '!b' },
  ]);
  // Two valid entries → exactly one arrow.
  const arrowCount = (html.match(/trace-tooltip__arrow/g) || []).length;
  assert.equal(arrowCount, 1);
});

test('buildTraceTooltipHtml returns empty string when every entry is malformed', () => {
  assert.equal(buildTraceTooltipHtml([null, 'x', 1]), '');
});

// ---------------------------------------------------------------------------
// buildNeighborTooltipHtml
// ---------------------------------------------------------------------------

test('buildNeighborTooltipHtml returns empty string for falsy segments', () => {
  assert.equal(buildNeighborTooltipHtml(null), '');
  assert.equal(buildNeighborTooltipHtml(undefined), '');
});

test('buildNeighborTooltipHtml emits source → target HTML', () => {
  const html = buildNeighborTooltipHtml({
    sourceShortName: 'AAA',
    targetShortName: 'BBB',
    sourceNode: { node_id: '!a', long_name: 'Alpha' },
    targetNode: { node_id: '!b', long_name: 'Beta' },
    sourceRole: 'CLIENT',
    targetRole: 'CLIENT',
  });
  assert.ok(html.includes('trace-tooltip__content'));
  assert.ok(html.includes('trace-tooltip__arrow'));
  assert.ok(html.includes('Alpha'));
  assert.ok(html.includes('Beta'));
});

test('buildNeighborTooltipHtml falls back to node short_name fields', () => {
  const html = buildNeighborTooltipHtml({
    sourceNode: { short_name: 'AAA', node_id: '!a' },
    targetNode: { short_name: 'BBB', node_id: '!b' },
  });
  assert.ok(html.includes('trace-tooltip__arrow'));
});

test('buildNeighborTooltipHtml falls back to node_id when no short name is present', () => {
  const html = buildNeighborTooltipHtml({
    sourceNode: { node_id: '!a' },
    targetNode: { node_id: '!b' },
  });
  assert.ok(html.includes('!a'));
  assert.ok(html.includes('!b'));
});

test('buildNeighborTooltipHtml returns empty string when either side has no short name', () => {
  assert.equal(buildNeighborTooltipHtml({ sourceNode: { node_id: '!a' } }), '');
  assert.equal(buildNeighborTooltipHtml({ targetNode: { node_id: '!b' } }), '');
});
