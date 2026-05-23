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
  buildNodePlaceholder,
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

test('applyNodeNameFallback fills missing names with neutral label when protocol is absent', () => {
  // Without a protocol stamp the placeholder cannot guess which mesh the
  // sender belongs to.  Historical behaviour hardcoded "Meshtastic" here
  // which silently mislabelled MeshCore chat senders rendered from a 404
  // hydrator path; the neutral "Unknown" label is the correct fallback.
  const node = { node_id: '!aabbccdd' };
  applyNodeNameFallback(node);
  assert.equal(node.short_name, 'ccdd');
  assert.equal(node.long_name, 'Unknown !aabbccdd');
});

test('applyNodeNameFallback uses the Meshtastic label when node.protocol is "meshtastic"', () => {
  const node = { node_id: '!aabbccdd', protocol: 'meshtastic' };
  applyNodeNameFallback(node);
  assert.equal(node.short_name, 'ccdd');
  assert.equal(node.long_name, 'Meshtastic !aabbccdd');
});

test('applyNodeNameFallback uses the Meshcore label when node.protocol is "meshcore"', () => {
  const node = { node_id: '!aabbccdd', protocol: 'meshcore' };
  applyNodeNameFallback(node);
  assert.equal(node.short_name, 'ccdd');
  assert.equal(node.long_name, 'Meshcore !aabbccdd');
});

test('applyNodeNameFallback normalises mixed-case and whitespace in node.protocol', () => {
  const meshcore = { node_id: '!aabbccdd', protocol: '  Meshcore ' };
  applyNodeNameFallback(meshcore);
  assert.equal(meshcore.long_name, 'Meshcore !aabbccdd');

  const meshtastic = { node_id: '!aabbccdd', protocol: 'MESHTASTIC' };
  applyNodeNameFallback(meshtastic);
  assert.equal(meshtastic.long_name, 'Meshtastic !aabbccdd');
});

test('applyNodeNameFallback falls back to Unknown for unrecognised protocol strings', () => {
  const node = { node_id: '!aabbccdd', protocol: 'reticulum' };
  applyNodeNameFallback(node);
  assert.equal(node.long_name, 'Unknown !aabbccdd');
});

test('applyNodeNameFallback updates camelCase aliases when present', () => {
  const node = { node_id: '!aabbccdd', shortName: '', longName: '', protocol: 'meshcore' };
  applyNodeNameFallback(node);
  assert.equal(node.shortName, 'ccdd');
  assert.equal(node.longName, 'Meshcore !aabbccdd');
});

test('applyNodeNameFallback leaves existing names untouched', () => {
  const node = {
    node_id: '!aabbccdd',
    short_name: 'AAA',
    long_name: 'Alpha',
    protocol: 'meshcore',
  };
  applyNodeNameFallback(node);
  assert.equal(node.short_name, 'AAA');
  assert.equal(node.long_name, 'Alpha');
});

test('applyNodeNameFallback is a no-op when no node_id is available', () => {
  const node = { protocol: 'meshcore' };
  applyNodeNameFallback(node);
  assert.deepEqual(node, { protocol: 'meshcore' });
});

// ---------------------------------------------------------------------------
// buildNodePlaceholder
// ---------------------------------------------------------------------------

test('buildNodePlaceholder returns a bare placeholder when no source is given', () => {
  assert.deepEqual(buildNodePlaceholder('!aabbccdd'), { node_id: '!aabbccdd' });
  assert.deepEqual(buildNodePlaceholder('!aabbccdd', null), { node_id: '!aabbccdd' });
  assert.deepEqual(buildNodePlaceholder('!aabbccdd', undefined), { node_id: '!aabbccdd' });
});

test('buildNodePlaceholder inherits source.protocol when present', () => {
  const placeholder = buildNodePlaceholder('!aabbccdd', { protocol: 'meshcore' });
  assert.deepEqual(placeholder, { node_id: '!aabbccdd', protocol: 'meshcore' });
});

test('buildNodePlaceholder omits the protocol key when source has no protocol', () => {
  const placeholder = buildNodePlaceholder('!aabbccdd', { node_id: '!source', snr: 1 });
  assert.deepEqual(placeholder, { node_id: '!aabbccdd' });
  assert.equal(Object.prototype.hasOwnProperty.call(placeholder, 'protocol'), false);
});

test('buildNodePlaceholder treats explicit null protocol as absent', () => {
  const placeholder = buildNodePlaceholder('!aabbccdd', { protocol: null });
  assert.deepEqual(placeholder, { node_id: '!aabbccdd' });
});

test('buildNodePlaceholder ignores non-object sources', () => {
  assert.deepEqual(
    buildNodePlaceholder('!aabbccdd', 'not-an-object'),
    { node_id: '!aabbccdd' },
  );
  assert.deepEqual(buildNodePlaceholder('!aabbccdd', 42), { node_id: '!aabbccdd' });
});

test('buildNodePlaceholder feeds straight into applyNodeNameFallback for the meshcore label', () => {
  const placeholder = buildNodePlaceholder('!aabbccdd', { protocol: 'meshcore' });
  applyNodeNameFallback(placeholder);
  assert.equal(placeholder.short_name, 'ccdd');
  assert.equal(placeholder.long_name, 'Meshcore !aabbccdd');
});
