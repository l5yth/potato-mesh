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
 * The Reticulum host's position reaches the map and the node page (SPEC RP7).
 *
 * The map and the spec sheet are protocol-neutral, so no renderer changed:
 * these tests pin that the host the ingestor positions from its RNS config is
 * drawn with Reticulum's hexagon (RD6, no longer a reserved slot) and gains a
 * Position group by RA6's rule, while a peer keeps neither.
 *
 * @module __tests__/reticulum-host-position
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withAppAndLeaflet } from './main-app-leaflet-stub.js';
import { renderSingleNodeTable } from '../node-page/single-node-table.js';

const NOW = 1_791_000_000;

/** The host as `/api/nodes` serves it once its report carried a position. */
const HOST = Object.freeze({
  node_id: '!27716218',
  short_name: '2771',
  long_name: 'Department of Decentralization',
  role: 'NODE',
  protocol: 'reticulum',
  latitude: 52.5029,
  longitude: 13.4042,
  altitude: 34,
  position_time: NOW - 60,
  location_source: 'LOC_MANUAL',
  last_heard: NOW - 60,
  first_heard: NOW - 86_400,
});

/** A peer as `/api/nodes` serves it: an announce carries no position. */
const PEER = Object.freeze({
  node_id: '!aabbccdd',
  short_name: 'aabb',
  long_name: 'Remote Peer',
  role: 'PEER',
  protocol: 'reticulum',
  last_heard: NOW - 30,
  first_heard: NOW - 3_600,
});

/** The host's destinations, as `/api/destinations` serves them. */
const DESTINATIONS = Object.freeze([
  {
    id: '9c59da5e1516745d74cc908243e0ba2b', node_id: '!27716218',
    identity_hash: '27716218762cfd2864141ef286c39940', aspect: 'nomadnetwork.node',
    role: 'NODE', name: 'Department of Decentralization',
    interface: 'LocalInterface[rns/default]', first_heard: NOW - 86_400, last_heard: NOW - 60,
  },
]);

/**
 * List the group titles a rendered spec sheet carries, in order.
 *
 * @param {string} html Spec-sheet markup.
 * @returns {Array<string>} Group titles.
 */
function groupTitles(html) {
  return [...html.matchAll(/<h3 class="node-detail-sheet__group-title">([^<]+)<\/h3>/g)].map(m => m[1]);
}

test('the Reticulum host reaches the map as a hexagon; a peer stays off it (RD6)', () => {
  withAppAndLeaflet(({ testUtils, leaflet }) => {
    leaflet._map._setZoom(12);
    leaflet._recorded.circleMarkers.length = 0;
    leaflet._recorded.markers.length = 0;
    testUtils.renderMap([HOST, PEER], NOW);
    // Only the host has coordinates, and Reticulum's shape is a divIcon chip.
    assert.equal(leaflet._recorded.circleMarkers.length, 0);
    assert.equal(leaflet._recorded.markers.length, 1);
    const marker = leaflet._recorded.markers[0];
    assert.deepEqual(marker._latLng, [52.5029, 13.4042]);
    assert.match(marker.options.icon.options.html, /node-marker-chip__fill--hexagon/);
  });
});

test('the host node page renders its Position group (RA5 by RA6)', () => {
  const html = renderSingleNodeTable(HOST, () => '', NOW, { destinations: DESTINATIONS });
  assert.deepEqual(groupTitles(html), ['Identity', 'Activity', 'Position']);
  assert.match(html, /<dt>Latitude<\/dt><dd>52\.50290<\/dd>/);
  assert.match(html, /<dt>Longitude<\/dt><dd>13\.40420<\/dd>/);
  assert.match(html, /<dt>Altitude<\/dt>/);
  assert.match(html, /<dt>Last Position<\/dt>/);
});

test('a peer node page renders no Position group', () => {
  const html = renderSingleNodeTable(PEER, () => '', NOW, { destinations: [] });
  assert.deepEqual(groupTitles(html), ['Activity']);
  assert.doesNotMatch(html, /Latitude/);
});
