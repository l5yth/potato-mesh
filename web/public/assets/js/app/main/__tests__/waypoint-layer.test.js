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
 * WP-A6 — waypoint map layer (SPEC W6 as re-rolled, design 1c-B/1d-C):
 * teardrop-pin definition, expiry dimming ladder, expired/coordless
 * exclusion, headless layer rendering with click selection and the marker
 * registry, and the minimal detail-card lines.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WAYPOINT_ICON_ANCHOR,
  WAYPOINT_ICON_SIZE,
  WAYPOINT_MARKER_SIZE,
  WAYPOINT_Z_INDEX_OFFSET,
  buildWaypointOverlayLines,
  formatWaypointExpiry,
  isWaypointExpired,
  renderWaypointsLayer,
  visibleWaypoints,
  waypointExpiryOpacity,
  waypointGlyph,
  waypointIconDefinition,
  waypointKey,
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

test('waypointIconDefinition builds the 24px teardrop pin (1c-B)', () => {
  const def = waypointIconDefinition({ icon: 0x2708, expire: NOW + 3 * 86400 }, NOW);
  assert.equal(def.className, '');
  assert.deepEqual(def.iconSize, [...WAYPOINT_ICON_SIZE]);
  // The anchor sits on the pin tip so the tail points at the coordinate.
  assert.deepEqual(def.iconAnchor, [...WAYPOINT_ICON_ANCHOR]);
  assert.match(def.html, /waypoint-pin/);
  assert.match(def.html, new RegExp(`width:${WAYPOINT_MARKER_SIZE}px`));
  assert.match(def.html, /background:#1c1c1c/);
  // Teardrop silhouette: three round corners, one sharp tail corner, rotated.
  assert.match(def.html, /border-radius:50% 50% 50% 2px/);
  assert.match(def.html, /rotate\(-45deg\)/);
  // The glyph counter-rotates so it reads upright inside the rotated body.
  assert.match(def.html, /rotate\(45deg\)/);
  assert.match(def.html, /opacity:1/);
  assert.match(def.html, /✈/);
});

test('the whole pin fits inside its icon box so the crown stays clickable (F3)', () => {
  // A 24px square rotated 45° spans 24*√2 ≈ 33.94px. The box must contain the
  // full rotated silhouette (34×34, body inset 5px on both axes) so no part of
  // the visible pin — the crown especially — falls outside the marker's
  // clickable hit area, and the tail tip stays anchored on the coordinate.
  assert.deepEqual([...WAYPOINT_ICON_SIZE], [34, 34]);
  assert.deepEqual([...WAYPOINT_ICON_ANCHOR], [17, 34]);
  const def = waypointIconDefinition({ icon: 0x2708, expire: 0 }, NOW);
  assert.match(def.html, /height:34px/); // outer box is square (was 34×30)
  assert.match(def.html, /left:5px; top:5px/); // body inset both axes (was top:0)
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

test('buildWaypointOverlayLines renders the minimal 1d-C card (title, body, meta)', () => {
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
    },
  );
  // Exactly three lines — coords, wpt id, and locked-to live on the node page (W11).
  assert.equal(lines.length, 3);
  assert.match(lines[0], /<strong>✈ Tempelhofer Feld<\/strong>/);
  assert.match(lines[1], /no other place/);
  assert.match(lines[2], /waypoint-card-meta/);
  assert.match(lines[2], /in 4d 6h · by<\/span> <span class="short-name">b133<\/span>/);
  const joined = lines.join('');
  assert.doesNotMatch(joined, /wpt 41206/);
  assert.doesNotMatch(joined, /52\.47516/);
  assert.doesNotMatch(joined, /Locked to/);
});

test('buildWaypointOverlayLines omits the body when absent and reads never honestly', () => {
  const lines = buildWaypointOverlayLines(
    { id: 9, name: 'Bare pin', node_id: '!3769b133' },
    { nowSeconds: NOW },
  );
  // Title + meta only; without a badge the canonical author id anchors "by".
  assert.equal(lines.length, 2);
  assert.match(lines[1], /never · by<\/span> <span class="mono">!3769b133<\/span>/);
});

test('buildWaypointOverlayLines drops the author clause when no author resolves', () => {
  const lines = buildWaypointOverlayLines({ id: 9, name: 'Orphan pin' }, { nowSeconds: NOW });
  assert.equal(lines.length, 2);
  assert.match(lines[1], /waypoint-card-meta">never<\/span>/);
  assert.doesNotMatch(lines[1], /· by/);
});

test('formatWaypointExpiry covers the in/expired/never states', () => {
  assert.equal(formatWaypointExpiry(NOW + 4 * 86400 + 6 * 3600, NOW), 'in 4d 6h');
  assert.equal(formatWaypointExpiry(NOW - 10, NOW), 'expired');
  assert.equal(formatWaypointExpiry(null, NOW), 'never');
  assert.equal(formatWaypointExpiry(0, NOW), 'never');
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
  assert.doesNotMatch(lines[1], /<img/i);
  assert.match(lines[1], /&lt;img/);
});

test('waypointKey composes protocol|id and rejects id-less rows', () => {
  assert.equal(waypointKey({ id: 41206, protocol: 'meshtastic' }), 'meshtastic|41206');
  assert.equal(waypointKey({ id: 7 }), '|7');
  assert.equal(waypointKey({ protocol: 'meshtastic' }), null);
  assert.equal(waypointKey(null), null);
});

test('renderWaypointsLayer fills the caller-owned marker registry per render', () => {
  const { leaflet, layer, markers } = makeFakeLeaflet();
  const registry = new Map([['stale|1', { old: true }]]);
  renderWaypointsLayer({
    waypoints: [{ id: 41206, protocol: 'meshtastic', latitude: 52.5, longitude: 13.4 }],
    layer,
    leaflet,
    nowSeconds: NOW,
    markerRegistry: registry,
  });
  // The registry is cleared and repopulated each render (W8 re-roll flash).
  assert.equal(registry.size, 1);
  assert.equal(registry.get('meshtastic|41206'), markers[0]);
});

test('buildWaypointOverlayLines returns no lines for a non-object', () => {
  assert.deepEqual(buildWaypointOverlayLines(null, { nowSeconds: NOW }), []);
  assert.deepEqual(buildWaypointOverlayLines('junk', { nowSeconds: NOW }), []);
});

test('the minimal card falls back to the Waypoint title when the name is absent', () => {
  const lines = buildWaypointOverlayLines({ id: 3 }, { nowSeconds: NOW });
  assert.match(lines[0], /<strong>📌 Waypoint<\/strong>/);
});
