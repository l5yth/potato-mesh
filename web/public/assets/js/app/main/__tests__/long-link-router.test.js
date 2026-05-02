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

import {
  applyNodeNameFallback,
  extractIdentifierFromHref,
  getNodeDisplayNameForOverlay,
  getNodeIdentifierFromLink,
  shouldHandleNodeLongLink,
} from '../long-link-router.js';

// ---------------------------------------------------------------------------
// shouldHandleNodeLongLink
// ---------------------------------------------------------------------------

test('shouldHandleNodeLongLink rejects null and undefined', () => {
  assert.equal(shouldHandleNodeLongLink(null), false);
  assert.equal(shouldHandleNodeLongLink(undefined), false);
});

test('shouldHandleNodeLongLink rejects elements without a dataset', () => {
  assert.equal(shouldHandleNodeLongLink({}), false);
});

test('shouldHandleNodeLongLink honours an explicit nodeDetailLink=false opt-out', () => {
  const link = { dataset: { nodeDetailLink: 'false' } };
  assert.equal(shouldHandleNodeLongLink(link), false);
});

test('shouldHandleNodeLongLink accepts elements with a permissive dataset', () => {
  assert.equal(shouldHandleNodeLongLink({ dataset: {} }), true);
  assert.equal(shouldHandleNodeLongLink({ dataset: { nodeDetailLink: 'true' } }), true);
});

// ---------------------------------------------------------------------------
// extractIdentifierFromHref
// ---------------------------------------------------------------------------

test('extractIdentifierFromHref returns empty string for non-string and empty input', () => {
  assert.equal(extractIdentifierFromHref(null), '');
  assert.equal(extractIdentifierFromHref(undefined), '');
  assert.equal(extractIdentifierFromHref(''), '');
  assert.equal(extractIdentifierFromHref(42), '');
});

test('extractIdentifierFromHref returns empty string when no /nodes/!… segment is present', () => {
  assert.equal(extractIdentifierFromHref('/about'), '');
  assert.equal(extractIdentifierFromHref('https://example.com/'), '');
});

test('extractIdentifierFromHref returns the canonical node id for /nodes/!… URIs', () => {
  assert.equal(extractIdentifierFromHref('/nodes/!aabbccdd'), '!aabbccdd');
  // canonicalNodeIdentifier preserves case; it only ensures the leading "!".
  assert.equal(
    extractIdentifierFromHref('https://example.com/nodes/!AABBCCDD?ref=1'),
    '!AABBCCDD',
  );
});

test('extractIdentifierFromHref tolerates URI-encoded ! prefixes', () => {
  // %21 is the URL-encoded form of !.  decodeURIComponent should restore it.
  assert.equal(extractIdentifierFromHref('/nodes/%21aabbccdd'), '');
  // Not all encodings return a node — '!aabbccdd' encoded as a literal also works.
  assert.equal(extractIdentifierFromHref('/nodes/!aabbccdd#anchor'), '!aabbccdd');
});

test('extractIdentifierFromHref falls back to the raw match when decoding throws', () => {
  // A bare "%" tail is malformed UTF-8 percent encoding and makes
  // decodeURIComponent raise URIError.  The catch branch should still
  // canonicalise the un-decoded match.
  assert.equal(
    extractIdentifierFromHref('/nodes/!aabbccdd%E0'),
    '!aabbccdd%E0',
  );
});

// ---------------------------------------------------------------------------
// getNodeIdentifierFromLink
// ---------------------------------------------------------------------------

test('getNodeIdentifierFromLink returns empty string for falsy input', () => {
  assert.equal(getNodeIdentifierFromLink(null), '');
  assert.equal(getNodeIdentifierFromLink(undefined), '');
});

test('getNodeIdentifierFromLink prefers dataset.nodeId when canonical', () => {
  const link = { dataset: { nodeId: '!aabbccdd' } };
  assert.equal(getNodeIdentifierFromLink(link), '!aabbccdd');
});

test('getNodeIdentifierFromLink falls back to getAttribute("href") when dataset is absent', () => {
  const link = {
    getAttribute(name) {
      return name === 'href' ? '/nodes/!aabbccdd' : null;
    },
  };
  assert.equal(getNodeIdentifierFromLink(link), '!aabbccdd');
});

test('getNodeIdentifierFromLink falls back to the .href property when getAttribute is absent', () => {
  const link = { href: '/nodes/!aabbccdd' };
  assert.equal(getNodeIdentifierFromLink(link), '!aabbccdd');
});

test('getNodeIdentifierFromLink returns empty string when nothing parses', () => {
  assert.equal(getNodeIdentifierFromLink({}), '');
});

// ---------------------------------------------------------------------------
// getNodeDisplayNameForOverlay
// ---------------------------------------------------------------------------

test('getNodeDisplayNameForOverlay returns empty string for non-objects', () => {
  assert.equal(getNodeDisplayNameForOverlay(null), '');
  assert.equal(getNodeDisplayNameForOverlay(42), '');
});

test('getNodeDisplayNameForOverlay prefers long_name', () => {
  const node = { long_name: 'Alpha Long', short_name: 'A', node_id: '!a' };
  assert.equal(getNodeDisplayNameForOverlay(node), 'Alpha Long');
});

test('getNodeDisplayNameForOverlay falls back to short_name', () => {
  const node = { short_name: 'A', node_id: '!a' };
  assert.equal(getNodeDisplayNameForOverlay(node), 'A');
});

test('getNodeDisplayNameForOverlay falls back to node_id when names are absent', () => {
  assert.equal(getNodeDisplayNameForOverlay({ node_id: '!a' }), '!a');
});

test('getNodeDisplayNameForOverlay reads camelCase keys too', () => {
  assert.equal(getNodeDisplayNameForOverlay({ longName: 'L' }), 'L');
  assert.equal(getNodeDisplayNameForOverlay({ shortName: 'S' }), 'S');
});

// ---------------------------------------------------------------------------
// applyNodeNameFallback
// ---------------------------------------------------------------------------

test('applyNodeNameFallback is a no-op for non-objects', () => {
  // Just ensure no throw.
  applyNodeNameFallback(null);
  applyNodeNameFallback(undefined);
});

test('applyNodeNameFallback fills missing names from node_id', () => {
  const node = { node_id: '!aabbccdd' };
  applyNodeNameFallback(node);
  assert.equal(node.short_name, 'ccdd');
  assert.equal(node.long_name, 'Meshtastic !aabbccdd');
});

test('applyNodeNameFallback updates camelCase aliases when present', () => {
  const node = { node_id: '!aabbccdd', shortName: '', longName: '' };
  applyNodeNameFallback(node);
  assert.equal(node.shortName, 'ccdd');
  assert.equal(node.longName, 'Meshtastic !aabbccdd');
});

test('applyNodeNameFallback leaves existing names untouched', () => {
  const node = { node_id: '!aabbccdd', short_name: 'AAA', long_name: 'Alpha' };
  applyNodeNameFallback(node);
  assert.equal(node.short_name, 'AAA');
  assert.equal(node.long_name, 'Alpha');
});

test('applyNodeNameFallback is a no-op when no node_id is available', () => {
  const node = {};
  applyNodeNameFallback(node);
  assert.deepEqual(node, {});
});
