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
 * WP-A6 — waypoint map layer (SPEC W6, design 1c-A/1d-A): glyph chip
 * definition, expiry dimming ladder, expired/coordless exclusion, headless
 * layer rendering with click selection, and the detail-card lines.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WAYPOINT_MARKER_SIZE,
  WAYPOINT_Z_INDEX_OFFSET,
  buildWaypointOverlayLines,
  isWaypointExpired,
  renderWaypointsLayer,
  visibleWaypoints,
  waypointExpiryOpacity,
  waypointGlyph,
  waypointIconDefinition,
} from '../waypoint-layer.js';

const NOW = 1_700_000_000;

// ---------------------------------------------------------------------------
// waypointGlyph
// ---------------------------------------------------------------------------

test('waypointGlyph renders the payload codepoint', () => {
  assert.equal(waypointGlyph(0x2708), '✈');
  assert.equal(waypointGlyph(0x1f37b), '\u{1F37B}');
});

test('waypointGlyph falls back to 📌 for absent, invalid, or control codepoints', () => {
  assert.equal(waypointGlyph(null), '📌');
  assert.equal(waypointGlyph(0), '📌');
  assert.equal(waypointGlyph(-5), '📌');
  assert.equal(waypointGlyph('nope'), '📌');
  assert.equal(waypointGlyph(0x07), '📌', 'control characters render nothing useful');
  assert.equal(waypointGlyph(0x110000), '📌', 'out-of-range codepoints throw in fromCodePoint');
});

// ---------------------------------------------------------------------------
// isWaypointExpired / waypointExpiryOpacity
// ---------------------------------------------------------------------------

test('expire absent or zero means never expired', () => {
  assert.equal(isWaypointExpired(null, NOW), false);
  assert.equal(isWaypointExpired(0, NOW), false);
  assert.equal(waypointExpiryOpacity(null, NOW), 1);
});

test('a past expire is expired; a future one is not (W5)', () => {
  assert.equal(isWaypointExpired(NOW - 1, NOW), true);
  assert.equal(isWaypointExpired(NOW + 60, NOW), false);
});

test('the expiry ladder dims markers approaching their expiry', () => {
  assert.equal(waypointExpiryOpacity(NOW + 30 * 60, NOW), 0.4, '< 1 h remaining');
  assert.equal(waypointExpiryOpacity(NOW + 5 * 3600, NOW), 0.7, '< 24 h remaining');
  assert.equal(waypointExpiryOpacity(NOW + 3 * 86400, NOW), 1, '>= 24 h remaining');
});

// ---------------------------------------------------------------------------
// visibleWaypoints
// ---------------------------------------------------------------------------

test('visibleWaypoints keeps fresh coordinated rows and drops the rest', () => {
  const rows = [
    { id: 1, latitude: 52.5, longitude: 13.4 },
    { id: 2, latitude: 52.5, longitude: 13.4, expire: NOW - 10 },
    { id: 3, latitude: null, longitude: 13.4 },
    { id: 4 },
    null,
    'junk',
  ];
  assert.deepEqual(visibleWaypoints(rows, NOW).map(r => r.id), [1]);
  assert.deepEqual(visibleWaypoints(undefined, NOW), []);
});

// ---------------------------------------------------------------------------
// waypointIconDefinition
// ---------------------------------------------------------------------------

test('waypointIconDefinition builds the 22px dark glyph chip (1c-A)', () => {
  const def = waypointIconDefinition({ icon: 0x2708, expire: NOW + 3 * 86400 }, NOW);
  assert.equal(def.className, '');
  assert.deepEqual(def.iconSize, [WAYPOINT_MARKER_SIZE, WAYPOINT_MARKER_SIZE]);
  assert.deepEqual(def.iconAnchor, [WAYPOINT_MARKER_SIZE / 2, WAYPOINT_MARKER_SIZE / 2]);
  assert.match(def.html, /waypoint-chip/);
  assert.match(def.html, /background:#1c1c1c/);
  assert.match(def.html, /border-radius:6px/);
  assert.match(def.html, /opacity:1/);
  assert.match(def.html, /✈/);
});

test('waypointIconDefinition escapes a markup-shaped glyph and applies dimming', () => {
  // Codepoint 60 is "<" — it must arrive escaped, never as markup.
  const def = waypointIconDefinition({ icon: 60, expire: NOW + 30 * 60 }, NOW);
  assert.match(def.html, /&lt;/);
  assert.match(def.html, /opacity:0\.4/);
});

// ---------------------------------------------------------------------------
// renderWaypointsLayer
// ---------------------------------------------------------------------------

/** Minimal fake Leaflet namespace + layer recording marker construction. */
function makeFakeLeaflet() {
  const markers = [];
  const leaflet = {
    divIcon: def => ({ __icon: def }),
    marker(latlng, options) {
      const marker = {
        latlng,
        options,
        handlers: {},
        element: { id: `el-${markers.length}` },
        on(eventName, handler) {
          this.handlers[eventName] = handler;
          return this;
        },
        getElement() {
          return this.element;
        },
        addTo(layer) {
          layer.added.push(this);
          return this;
        },
      };
      markers.push(marker);
      return marker;
    },
  };
  const layer = { added: [], cleared: 0, clearLayers() { this.cleared += 1; this.added = []; } };
  return { leaflet, layer, markers };
}

test('renderWaypointsLayer clears, renders visible rows, and reports the count', () => {
  const { leaflet, layer, markers } = makeFakeLeaflet();
  const waypoints = [
    { id: 1, latitude: 52.5, longitude: 13.4, icon: 0x2708 },
    { id: 2, latitude: 52.6, longitude: 13.5, expire: NOW - 5 }, // expired — dropped
  ];
  const count = renderWaypointsLayer({ waypoints, layer, leaflet, nowSeconds: NOW });
  assert.equal(count, 1);
  assert.equal(layer.cleared, 1);
  assert.equal(layer.added.length, 1);
  assert.deepEqual(markers[0].latlng, [52.5, 13.4]);
  assert.equal(markers[0].options.zIndexOffset, WAYPOINT_Z_INDEX_OFFSET);
  assert.equal(markers[0].options.keyboard, false);
  assert.match(markers[0].options.icon.__icon.html, /✈/);
});

test('renderWaypointsLayer wires the selection callback to the marker element', () => {
  const { leaflet, layer, markers } = makeFakeLeaflet();
  const selections = [];
  const waypoint = { id: 7, latitude: 1, longitude: 2 };
  renderWaypointsLayer({
    waypoints: [waypoint],
    layer,
    leaflet,
    nowSeconds: NOW,
    onSelect: (row, el) => selections.push({ row, el }),
  });
  let prevented = 0;
  let stopped = 0;
  markers[0].handlers.click({
    originalEvent: {
      preventDefault: () => { prevented += 1; },
      stopPropagation: () => { stopped += 1; },
    },
  });
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(selections.length, 1);
  assert.equal(selections[0].row, waypoint);
  assert.equal(selections[0].el, markers[0].element);
});

test('renderWaypointsLayer tolerates a bare click event and a missing getElement', () => {
  const { leaflet, layer, markers } = makeFakeLeaflet();
  const selections = [];
  renderWaypointsLayer({
    waypoints: [{ id: 8, latitude: 1, longitude: 2 }],
    layer,
    leaflet,
    nowSeconds: NOW,
    onSelect: (row, el) => selections.push(el),
  });
  markers[0].getElement = undefined;
  markers[0].handlers.click({});
  assert.deepEqual(selections, [null]);
});

test('renderWaypointsLayer is a 0-count no-op without a layer or leaflet', () => {
  const { leaflet, layer } = makeFakeLeaflet();
  assert.equal(renderWaypointsLayer({ waypoints: [], layer: null, leaflet, nowSeconds: NOW }), 0);
  assert.equal(renderWaypointsLayer({ waypoints: [], layer, leaflet: null, nowSeconds: NOW }), 0);
});

// ---------------------------------------------------------------------------
// buildWaypointOverlayLines (design 1d-A: full record, node-overlay line order)
// ---------------------------------------------------------------------------

test('buildWaypointOverlayLines renders every payload field in card order', () => {
  const lines = buildWaypointOverlayLines(
    {
      id: 41206,
      icon: 0x2708,
      name: 'Tempelhofer Feld',
      description: 'There is no other place in Berlin to see further. : )',
      latitude: 52.4751642,
      longitude: 13.4029586,
      expire: NOW + 4 * 86400 + 6 * 3600,
      locked_to: '!3769b133',
      node_id: '!3769b133',
      rx_time: NOW - 724,
    },
    {
      nowSeconds: NOW,
      authorBadgeHtml: '<span class="short-name">b133</span>',
      lockedBadgeHtml: '<span class="short-name">b133</span>',
    },
  );
  assert.equal(lines.length, 8);
  assert.match(lines[0], /<strong>✈ Tempelhofer Feld<\/strong>/);
  assert.match(lines[1], /wpt 41206/);
  assert.match(lines[1], /waypoint-kind-chip/);
  assert.match(lines[2], /no other place/);
  assert.match(lines[3], /52\.47516, 13\.40296/);
  assert.match(lines[4], /Expires: <span>in 4d 6h<\/span>/);
  assert.match(lines[5], /Locked to <span class="short-name">b133<\/span>/);
  assert.match(lines[6], /By <span class="short-name">b133<\/span> <span class="mono">!3769b133<\/span>/);
  assert.match(lines[7], /Heard: 12m 4s/);
});

test('buildWaypointOverlayLines omits absent fields and reads never-expiring honestly', () => {
  const lines = buildWaypointOverlayLines({ id: 9, name: 'Bare pin' }, { nowSeconds: NOW });
  // Title, id chip, and the Expires line only — no description/coords/lock/author/heard.
  assert.equal(lines.length, 3);
  assert.match(lines[2], /Expires: <span>never<\/span>/);
});

test('buildWaypointOverlayLines escapes user-authored name and description (W3)', () => {
  const lines = buildWaypointOverlayLines(
    { id: 1, name: '<script>x</script>', description: '<img onerror=1>' },
    { nowSeconds: NOW },
  );
  // Case-insensitive prefix match (CodeQL js/bad-tag-filter): the assertion
  // must itself be a sound tag check — an exact lowercase `<script>` pattern
  // would pass even if a variant tag leaked through.
  assert.doesNotMatch(lines[0], /<script/i);
  assert.match(lines[0], /&lt;script&gt;/);
  assert.doesNotMatch(lines[2], /<img/i);
  assert.match(lines[2], /&lt;img/);
});

test('buildWaypointOverlayLines returns no lines for a non-object', () => {
  assert.deepEqual(buildWaypointOverlayLines(null, { nowSeconds: NOW }), []);
  assert.deepEqual(buildWaypointOverlayLines('junk', { nowSeconds: NOW }), []);
});
