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
 * Unit tests for {@link legendProtocolsInView} (SPEC LP1).
 *
 * @module app/__tests__/map-legend-protocols
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { legendProtocolsInView } from '../map-legend-protocols.js';

/** Stats with 7-day activity on all three protocols. */
const ALL_ACTIVE = Object.freeze({
  meshcore: { week: 4 },
  meshtastic: { week: 12 },
  reticulum: { week: 3 },
});

/** One node per protocol, matched by long name. */
const NODES = Object.freeze([
  { node_id: '!aa000001', long_name: 'Alpha Tower', protocol: 'meshtastic', role: 'ROUTER' },
  { node_id: '!bb000002', long_name: 'Bravo Repeater', protocol: 'meshcore', role: 'REPEATER' },
  { node_id: '!cc000003', long_name: 'Charlie Peer', protocol: 'reticulum', role: 'PEER' },
]);

/**
 * Text filter stub: case-insensitive substring on the long name.
 *
 * @param {Object} node Node record.
 * @param {string} query Normalised query.
 * @returns {boolean} Whether the node matches.
 */
const matchesText = (node, query) => String(node.long_name || '').toLowerCase().includes(query);

/**
 * Protocol filter stub that shows every node.
 *
 * @returns {boolean} Always true.
 */
const showAll = () => true;

/**
 * Run {@link legendProtocolsInView} with defaults and return the listed
 * protocols in column order.
 *
 * @param {Object} overrides Parameters to replace.
 * @returns {Array<string>} Listed protocols.
 */
function listed(overrides = {}) {
  return [
    ...legendProtocolsInView({
      stats: ALL_ACTIVE,
      hiddenProtocols: new Set(),
      nodes: NODES,
      query: '',
      matchesText,
      matchesProtocol: showAll,
      ...overrides,
    }),
  ];
}

test('legendProtocolsInView lists every active protocol, in column order, with nothing hidden or filtered (LP1)', () => {
  assert.deepEqual(listed(), ['meshcore', 'meshtastic', 'reticulum']);
  // Without a text filter the loaded nodes are not consulted at all.
  assert.deepEqual(listed({ nodes: [] }), ['meshcore', 'meshtastic', 'reticulum']);
  assert.deepEqual(listed({ query: undefined, nodes: undefined }), ['meshcore', 'meshtastic', 'reticulum']);
});

test('legendProtocolsInView drops a protocol without 7-day activity (LP1)', () => {
  assert.deepEqual(listed({ stats: { meshcore: { week: 0 }, meshtastic: { week: 12 } } }), ['meshtastic']);
  assert.deepEqual(listed({ stats: { week: 5 } }), [], 'no per-protocol data reads as no activity');
  assert.deepEqual(listed({ stats: null }), []);
});

test('legendProtocolsInView drops a protocol hidden with its meta-row toggle (LP1)', () => {
  assert.deepEqual(listed({ hiddenProtocols: new Set(['meshcore']) }), ['meshtastic', 'reticulum']);
  assert.deepEqual(listed({ hiddenProtocols: new Set(['meshcore', 'meshtastic', 'reticulum']) }), []);
});

test('legendProtocolsInView keeps only protocols with a node passing the text filter while one is set (LP1)', () => {
  const calls = [];
  const recordingText = (node, query) => {
    calls.push(query);
    return matchesText(node, query);
  };
  assert.deepEqual(listed({ query: 'alpha', matchesText: recordingText }), ['meshtastic']);
  assert.ok(calls.length > 0 && calls.every(query => query === 'alpha'), 'the text filter sees the query');
  assert.deepEqual(listed({ query: 'r' }), ['meshcore', 'meshtastic', 'reticulum'], 'every protocol has a match');
  assert.deepEqual(listed({ query: 'zz-no-such-node-zz' }), [], 'no match lists no protocol');
});

test('legendProtocolsInView also requires the node to pass the protocol filter (LP1)', () => {
  const hideMeshcoreNodes = node => node.protocol !== 'meshcore';
  assert.deepEqual(listed({ query: 'bravo', matchesProtocol: hideMeshcoreNodes }), []);
  assert.deepEqual(listed({ query: 'e', matchesProtocol: hideMeshcoreNodes }), ['meshtastic', 'reticulum']);
});

test('legendProtocolsInView counts a node without a protocol as Meshtastic (LP1)', () => {
  const legacy = [{ node_id: '!dd000004', long_name: 'Legacy Box', protocol: null }];
  assert.deepEqual(listed({ query: 'legacy', nodes: legacy }), ['meshtastic']);
});

test('legendProtocolsInView skips empty node slots and a missing node list (LP1)', () => {
  assert.deepEqual(listed({ query: 'charlie', nodes: [null, undefined, NODES[2]] }), ['reticulum']);
  assert.deepEqual(listed({ query: 'charlie', nodes: undefined }), [], 'nothing loaded, nothing matches');
});

test('legendProtocolsInView never lists a match whose protocol is inactive or toggled off (LP1)', () => {
  assert.deepEqual(listed({ query: 'bravo', stats: { meshcore: { week: 0 }, meshtastic: { week: 12 } } }), []);
  assert.deepEqual(listed({ query: 'bravo', hiddenProtocols: new Set(['meshcore']) }), []);
});
