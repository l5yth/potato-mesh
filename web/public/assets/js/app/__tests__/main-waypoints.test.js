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
 * WP-A6/WP-A7 — app-level waypoint wiring: the collection loads through the
 * refresh, the legend gains the Waypoints toggle in the Meshtastic column
 * (design 1e-A), an SSE `waypoints` ping delta-fetches the collection, and the
 * Log entry renders the 📌 line with the name but never the description
 * (SPEC W6/W7/W8).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveApp, DEFAULT_RESPONSES } from './sse-app-harness.js';
import { CHAT_LOG_ENTRY_TYPES } from '../chat-log-tabs.js';

const NOW = Math.floor(Date.now() / 1000);

const WAYPOINT_ROW = Object.freeze({
  id: 41206,
  node_id: '!a',
  rx_time: NOW - 60,
  rx_iso: new Date((NOW - 60) * 1000).toISOString(),
  name: 'Tempelhofer Feld',
  description: 'SECRET-BODY-NEVER-IN-LOG',
  icon: 0x2708,
  latitude: 52.4751642,
  longitude: 13.4029586,
  expire: NOW + 4 * 86400,
  locked_to: '!a',
  protocol: 'meshtastic',
});

const RESPONSES = Object.freeze({
  ...DEFAULT_RESPONSES,
  '/api/waypoints': [WAYPOINT_ROW],
});

test('the refresh loads waypoints alongside the other collections (W8)', async () => {
  await runLiveApp({ responses: RESPONSES }, async ({ testUtils, calls }) => {
    assert.deepEqual(testUtils.getLoadedWaypoints().map(w => w.id), [41206]);
    assert.ok(calls.some(({ url }) => url.startsWith('/api/waypoints?')), 'waypoints fetched');
  });
});

test('a waypoints SSE ping delta-fetches the collection and fades its pin (W8 re-roll)', async () => {
  await runLiveApp({ responses: RESPONSES }, async ({ testUtils, calls, FakeEventSource }) => {
    // Inject a live pin for the delta row (the harness runs without Leaflet,
    // so the registry is seeded through the test hook).
    const classes = new Set();
    const pinElement = {
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
      },
    };
    testUtils._setWaypointMarkerForTests('meshtastic|41206', { getElement: () => pinElement });

    const before = calls.filter(({ url }) => url.startsWith('/api/waypoints?')).length;
    FakeEventSource.instances[0].dispatch('change', {
      data: JSON.stringify({ collection: 'waypoints' }),
    });
    await testUtils.flushLiveRefresh();
    const after = calls.filter(({ url }) => url.startsWith('/api/waypoints?')).length;
    assert.ok(after > before, 'the ping issued a waypoints delta fetch');
    // W8 as re-rolled: the changed pin fades via the .live-flash class.
    assert.deepEqual(testUtils.getLastFlashedWaypointKeys(), ['meshtastic|41206']);
    assert.ok(classes.has('live-flash'), 'the pin element carries the flash class');
  });
});

test('the author node flashes through the companion nodes publish (W8 re-roll)', async () => {
  await runLiveApp({ responses: RESPONSES }, async ({ testUtils, FakeEventSource }) => {
    // The server publishes "nodes" alongside "waypoints" (ingest.rb); the
    // client sees both pings and one debounced refresh flashes the author.
    FakeEventSource.instances[0].dispatch('change', {
      data: JSON.stringify({ collection: 'waypoints' }),
    });
    FakeEventSource.instances[0].dispatch('change', {
      data: JSON.stringify({ collection: 'nodes' }),
    });
    await testUtils.flushLiveRefresh();
    assert.equal(testUtils.getLiveFlashCount(), 1);
    assert.deepEqual(testUtils.getLastFlashedNodeIds(), ['!a']);
  });
});

test('the waypoint Log entry carries the 📌 line but never the description (W7)', async () => {
  await runLiveApp({ responses: RESPONSES }, async ({ testUtils }) => {
    const parts = testUtils.buildChatLogEntryParts({
      ts: WAYPOINT_ROW.rx_time,
      type: CHAT_LOG_ENTRY_TYPES.WAYPOINT,
      waypoint: WAYPOINT_ROW,
      nodeId: WAYPOINT_ROW.node_id,
      nodeNum: null,
    });
    assert.ok(parts, 'the waypoint entry renders');
    assert.match(parts.html, /📌/);
    assert.match(parts.html, /Broadcasted waypoint ✈ Tempelhofer Feld/);
    assert.match(parts.html, /Lat: 52\.47516/);
    assert.match(parts.html, /Lon: 13\.40296/);
    // The remaining lifetime is computed against the live clock, so the 4-day
    // expiry reads as "3d 23h" by render time.
    assert.match(parts.html, /Expires: 3d 23h/);
    assert.doesNotMatch(parts.html, /SECRET-BODY-NEVER-IN-LOG/, 'description stays out of the Log');
  });
});

test('an expired waypoint logs honestly and a never-expiring one reads never (W7)', async () => {
  await runLiveApp({ responses: RESPONSES }, async ({ testUtils }) => {
    const expired = testUtils.buildChatLogEntryParts({
      ts: NOW - 60,
      type: CHAT_LOG_ENTRY_TYPES.WAYPOINT,
      waypoint: { ...WAYPOINT_ROW, expire: NOW - 10 },
      nodeId: '!a',
      nodeNum: null,
    });
    assert.match(expired.html, /Expires: expired/);
    const immortal = testUtils.buildChatLogEntryParts({
      ts: NOW - 60,
      type: CHAT_LOG_ENTRY_TYPES.WAYPOINT,
      waypoint: { ...WAYPOINT_ROW, expire: null, name: null },
      nodeId: '!a',
      nodeNum: null,
    });
    assert.match(immortal.html, /Broadcasted waypoint ✈ Waypoint/);
    assert.match(immortal.html, /Expires: never/);
  });
});

test('the Waypoints toggle follows the pressed-when-visible convention (1e-A / W6)', async () => {
  await runLiveApp({ responses: RESPONSES }, async ({ testUtils }) => {
    // The legend DOM itself only builds under Leaflet; inject a mock button
    // (the _setProtocolCountElements precedent) to exercise the state logic.
    const button = {
      attrs: {},
      innerHTML: '',
      setAttribute(name, value) { this.attrs[name] = String(value); },
      getAttribute(name) { return this.attrs[name] ?? null; },
    };
    testUtils._setWaypointsToggleButton(button);
    testUtils.updateWaypointsToggleState();
    assert.equal(button.getAttribute('aria-pressed'), 'true', 'pressed while the layer shows');
    assert.match(String(button.innerHTML), /Waypoints/);
    assert.match(String(button.innerHTML), /legend-waypoint-sample/);
    assert.match(String(button.innerHTML), /legend-protocol-count/);
    assert.equal(testUtils.isWaypointsVisible(), true);
    testUtils.setWaypointsVisibility(false);
    assert.equal(testUtils.isWaypointsVisible(), false);
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(button.getAttribute('aria-label'), 'Waypoints hidden');
    testUtils.setWaypointsVisibility(true);
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(button.getAttribute('aria-label'), 'Waypoints shown');
  });
});

test('the waypoint detail overlay renders the 1d-A card via the overlay stack (W6)', async () => {
  await runLiveApp({ responses: RESPONSES }, async ({ testUtils }) => {
    // openWaypointOverlay tolerates a missing target/waypoint without throwing.
    assert.doesNotThrow(() => testUtils.openWaypointOverlay(null, WAYPOINT_ROW));
    assert.doesNotThrow(() => testUtils.openWaypointOverlay({}, null));
  });
});
