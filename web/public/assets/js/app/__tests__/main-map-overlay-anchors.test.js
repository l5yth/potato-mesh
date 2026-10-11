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
 * SPEC DR2 (#881): the map may rebuild, but every open overlay or tooltip
 * moves to its rebuilt anchor, keyed by node id, segment key or waypoint key.
 *
 * Each test opens something on the map, lands a live refresh that changes
 * node data (so the map really rebuilds: every marker, line and pin is a new
 * layer with a new element, and the old elements leave the document), and
 * checks that what the reader opened is still open on the new layer. Before
 * DR2 only marker overlays survived (LD-A3): a neighbour-line overlay, a line
 * tooltip and a waypoint card closed, the close button of a moved marker
 * overlay did nothing, and node details that arrived after a rebuild never
 * replaced "Loading…".
 *
 * @module app/__tests__/main-map-overlay-anchors
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, clickLayer, drawnLines, runMapApp, settle } from './live-map-harness.js';

/**
 * Two positioned nodes, a neighbour link and a trace between them, and one
 * waypoint.
 *
 * @returns {Object<string, *>} Stub-fetch responses a test may edit.
 */
function mapResponses() {
  return {
    'encrypted=true': [],
    '/api/nodes': [
      { node_id: '!a', short_name: 'A', long_name: 'Node A', role: 'CLIENT', protocol: 'meshtastic', last_heard: NOW - 30, latitude: 52.5, longitude: 13.4 },
      { node_id: '!b', short_name: 'B', long_name: 'Node B', role: 'ROUTER', protocol: 'meshtastic', last_heard: NOW - 60, latitude: 52.51, longitude: 13.42 },
    ],
    '/api/messages': [],
    '/api/neighbors': [{ node_id: '!a', neighbor_id: '!b', snr: 6.5, rx_time: NOW - 40 }],
    '/api/traces': [{ id: 77, src: '!a', dest: '!b', hops: [], rx_time: NOW - 50 }],
    '/api/waypoints': [
      { id: 5, protocol: 'meshtastic', name: 'Probe POI', node_id: '!a', latitude: 52.52, longitude: 13.41, expire: 0, rx_time: NOW - 45 },
    ],
  };
}

/**
 * Change node B so the next nodes ping rebuilds the map.
 *
 * @param {Object<string, *>} responses Stub-fetch responses.
 * @param {number} battery New battery level.
 * @returns {void}
 */
function touchNodeB(responses, battery) {
  responses['/api/nodes'][1] = { ...responses['/api/nodes'][1], battery_level: battery };
}

/**
 * The newest node marker drawn at ``lat``/``lon``.
 *
 * @param {Object} leaflet Leaflet stub.
 * @param {number} lat Latitude.
 * @param {number} lon Longitude.
 * @returns {Object} Stub circle marker.
 */
function newestMarkerAt(leaflet, lat, lon) {
  return leaflet._recorded.circleMarkers.filter(marker => marker._latLng[0] === lat && marker._latLng[1] === lon).at(-1);
}

/**
 * The newest waypoint pin (pins stack above node markers with offset 500).
 *
 * @param {Object} leaflet Leaflet stub.
 * @returns {Object} Stub marker.
 */
function newestPin(leaflet) {
  return leaflet._recorded.markers.filter(marker => marker.options.zIndexOffset === 500).at(-1);
}

/**
 * Press an overlay's close (×) button.
 *
 * @param {Object} overlay Tracked overlay element.
 * @returns {void}
 */
function pressClose(overlay) {
  for (const handler of overlay.closeButton.listeners) handler({ preventDefault() {}, stopPropagation() {} });
}

const NEIGHBOR_LINE = 'neighbor-connection-line';
const TRACE_LINE = 'neighbor-connection-line trace-connection-line';

test('an open neighbour-line overlay and its tooltip follow the rebuilt line (DR2)', async () => {
  const responses = mapResponses();
  await runMapApp({ responses }, async ctx => {
    const line = drawnLines(ctx.leaflet, NEIGHBOR_LINE).at(-1);
    clickLayer(line);
    await settle();
    const [overlay] = ctx.overlays();
    assert.ok(overlay, 'clicking the line opens its overlay');
    assert.equal(line.isTooltipOpen(), true, 'and its tooltip');

    touchNodeB(responses, 55);
    await ctx.ping('nodes');

    const rebuiltLine = drawnLines(ctx.leaflet, NEIGHBOR_LINE).at(-1);
    assert.notEqual(rebuiltLine, line, 'the map rebuilt the line');
    assert.equal(line.getElement().__connected(), false, 'the old line left the document');
    assert.equal(ctx.overlays().length, 1, 'the overlay stays open');
    assert.equal(ctx.overlays()[0], overlay, 'the same overlay, not a new one');
    assert.equal(rebuiltLine.isTooltipOpen(), true, 'the tooltip reopens on the rebuilt line');
    assert.deepEqual(rebuiltLine.getTooltip().latLng, line.getTooltip().latLng, 'where it stood');
    // The overlay is anchored to the rebuilt line: clicking it toggles it shut.
    clickLayer(rebuiltLine);
    assert.equal(ctx.overlays().length, 0, 'clicking the rebuilt line toggles its overlay shut');
  });
});

test('an open trace-line tooltip follows its rebuilt hop line (DR2)', async () => {
  const responses = mapResponses();
  await runMapApp({ responses }, async ctx => {
    const line = drawnLines(ctx.leaflet, TRACE_LINE).at(-1);
    clickLayer(line);
    assert.equal(line.isTooltipOpen(), true);
    touchNodeB(responses, 56);
    await ctx.ping('nodes');
    const rebuiltLine = drawnLines(ctx.leaflet, TRACE_LINE).at(-1);
    assert.notEqual(rebuiltLine, line);
    assert.equal(rebuiltLine.isTooltipOpen(), true, 'the trace tooltip reopens on the rebuilt hop');
  });
});

test('an open waypoint card follows the rebuilt pin (DR2)', async () => {
  const responses = mapResponses();
  await runMapApp({ responses }, async ctx => {
    const pin = newestPin(ctx.leaflet);
    clickLayer(pin);
    await settle();
    const [card] = ctx.overlays();
    assert.ok(card && card.content.innerHTML.includes('Probe POI'), 'clicking the pin opens its card');

    touchNodeB(responses, 57);
    await ctx.ping('nodes');

    const rebuiltPin = newestPin(ctx.leaflet);
    assert.notEqual(rebuiltPin, pin, 'the map rebuilt the pin');
    assert.equal(ctx.overlays().length, 1, 'the card stays open');
    assert.equal(ctx.overlays()[0], card, 'the same card, not a new one');
    clickLayer(rebuiltPin);
    assert.equal(ctx.overlays().length, 0, 'clicking the rebuilt pin toggles its card shut');
  });
});

test('node details that arrive after a rebuild land on the moved marker overlay (DR2, LD-A3)', async () => {
  const responses = mapResponses();
  let release;
  const held = new Promise(resolve => {
    release = resolve;
  });
  /** Hold the marker's node lookup until after the rebuild. @param {string} url Request URL. */
  const fetchOverride = url => (String(url).startsWith('/api/nodes/!a')
    ? held.then(() => ({ ok: true, status: 200, json: () => Promise.resolve([{ ...responses['/api/nodes'][0] }]) }))
    : undefined);
  await runMapApp({ responses, fetchOverride }, async ctx => {
    const marker = newestMarkerAt(ctx.leaflet, 52.5, 13.4);
    clickLayer(marker);
    await settle();
    assert.match(ctx.overlays()[0].content.innerHTML, /Loading/);

    touchNodeB(responses, 58);
    await ctx.ping('nodes');
    assert.notEqual(newestMarkerAt(ctx.leaflet, 52.5, 13.4), marker, 'the map rebuilt the marker');
    assert.equal(ctx.overlays().length, 1, 'LD-A3 keeps the loading overlay open');

    release();
    await settle(60);
    const open = ctx.overlays();
    assert.equal(open.length, 1);
    assert.doesNotMatch(open[0].content.innerHTML, /Loading/, 'the details replaced "Loading…"');
    assert.match(open[0].content.innerHTML, /Node A/);
    // ... on the rebuilt marker, in its freshness pane (PD3).
    const rebuiltMarker = newestMarkerAt(ctx.leaflet, 52.5, 13.4);
    assert.equal(rebuiltMarker.options.pane, 'markers-live');
    clickLayer(rebuiltMarker);
    assert.equal(ctx.overlays().length, 0, 'clicking the rebuilt marker toggles its overlay shut');
  });
});

test('the close button closes a marker overlay that a rebuild moved (DR2)', async () => {
  const responses = mapResponses();
  await runMapApp({ responses }, async ctx => {
    const marker = newestMarkerAt(ctx.leaflet, 52.5, 13.4);
    clickLayer(marker);
    await settle(60);
    touchNodeB(responses, 59);
    await ctx.ping('nodes');
    assert.notEqual(newestMarkerAt(ctx.leaflet, 52.5, 13.4), marker, 'the map rebuilt the marker');
    const [overlay] = ctx.overlays();
    assert.ok(overlay, 'the marker overlay survived the rebuild (LD-A3)');
    pressClose(overlay);
    assert.equal(ctx.overlays().length, 0, 'the × closes it where it now stands');
  });
});

test('an overlay on a fanned-out colocated marker follows the rebuilt member (DR2)', async () => {
  const responses = mapResponses();
  // B joins A's coordinate: a two-node colocated group behind a hub badge.
  responses['/api/nodes'][1] = { ...responses['/api/nodes'][1], latitude: 52.5, longitude: 13.4 };
  await runMapApp({ responses }, async ctx => {
    const hub = ctx.leaflet._recorded.markers.filter(marker => marker.options.bubblingMouseEvents === false).at(-1);
    clickLayer(hub);
    const fanned = ctx.leaflet._recorded.circleMarkers.slice(-2);
    assert.equal(fanned.length, 2, 'the expanded hub fans both members out');
    const member = fanned[0];
    clickLayer(member);
    await settle(60);
    assert.equal(ctx.overlays().length, 1);

    touchNodeB(responses, 60);
    await ctx.ping('nodes');
    const rebuiltMembers = ctx.leaflet._recorded.circleMarkers.slice(-2);
    assert.notEqual(rebuiltMembers[0], member, 'the members were rebuilt, still fanned out');
    assert.equal(ctx.overlays().length, 1, 'the overlay followed its member');
    const rebuiltSame = rebuiltMembers.find(marker => marker.options.fillColor === member.options.fillColor);
    clickLayer(rebuiltSame);
    assert.equal(ctx.overlays().length, 0, 'clicking the rebuilt member toggles its overlay shut');
  });
});

test('an overlay on a line the rebuild drops is closed (DR2)', async () => {
  const responses = mapResponses();
  await runMapApp({ responses }, async ctx => {
    clickLayer(drawnLines(ctx.leaflet, NEIGHBOR_LINE).at(-1));
    await settle();
    assert.equal(ctx.overlays().length, 1);
    // B moves out of reach of any line: the neighbour row stays but its
    // target loses its position, so the line is not drawn again.
    responses['/api/nodes'][1] = { ...responses['/api/nodes'][1], latitude: null, longitude: null };
    await ctx.ping('nodes');
    assert.equal(ctx.overlays().length, 0, 'nothing to anchor to: cleanupOrphans closes it');
  });
});

test('the live-flash wave starts from the rebuilt marker (DR2, LV5)', async () => {
  const responses = mapResponses();
  await runMapApp({ responses }, async ctx => {
    const marker = newestMarkerAt(ctx.leaflet, 52.51, 13.42);
    touchNodeB(responses, 61);
    await ctx.ping('nodes');
    const rebuilt = newestMarkerAt(ctx.leaflet, 52.51, 13.42);
    assert.notEqual(rebuilt, marker, 'the map rebuilt the marker');
    const waves = ctx.leaflet._recorded.markers.filter(
      layer => layer.options.icon && layer.options.icon.options.className === 'live-flash-wave-icon',
    );
    assert.ok(waves.some(wave => wave.getLatLng() === rebuilt.getLatLng()), 'a wave rises from the rebuilt marker');
  });
});
