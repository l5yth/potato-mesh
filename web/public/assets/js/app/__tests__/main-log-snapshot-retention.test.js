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
 * Regression guard for the disappearing-log-entry bug (bugfix A1).
 *
 * ``rebuildNodeDerivedState`` used to store the *aggregated* snapshot arrays
 * back into the raw accumulators (``allTelemetryEntries`` / ``allPositionEntries``
 * / ``allNeighbors``), and those same variables are the merge targets for every
 * refresh.  Re-aggregating an already-aggregated array is lossy
 * (``aggregateSnapshots`` clones with ``{...snapshot}``, dropping the
 * non-enumerable ``snapshots`` history, and merges oldest-last so the stalest
 * reading's ``rx_time`` wins), so each per-node aggregate collapsed to
 * ``{stale-first, newest}``.  The visible effect: a telemetry/position log entry
 * appeared for one refresh tick and then vanished on the next — no scrolling
 * involved.  The accumulators must stay raw so every packet keeps a stable,
 * id-keyed Log entry across refreshes.
 *
 * @module app/__tests__/main-log-snapshot-retention
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';

/** Config with the auto-refresh timer off so the test drives every tick. */
const CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

const NOW = Math.floor(Date.now() / 1000);
const NODE_ID = '!00000001';

/** Yield to pending microtasks/timers so fire-and-forget work (stats) settles. */
function settle(ms = 60) {
  return new Promise(r => setTimeout(r, ms));
}

/** Count non-overlapping occurrences of ``needle`` in ``haystack``. */
function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

test('telemetry log entries survive successive refreshes (A1: no re-aggregation erosion)', async () => {
  // One node emits a fresh telemetry packet on each tick; all three timestamps
  // are within the recent window and must remain represented in the Log.
  let telemetryBody = [
    { id: 1, node_id: NODE_ID, node_num: 1, rx_time: NOW - 60, battery_level: 80 },
  ];
  const nodeBody = [
    { node_id: NODE_ID, node_num: 1, short_name: 'N1', long_name: 'Node One', role: 'CLIENT', last_heard: NOW },
  ];

  function stubFetch(url) {
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    if (url.startsWith('/api/nodes')) return jsonResponse(nodeBody);
    if (url.startsWith('/api/telemetry')) return jsonResponse(telemetryBody);
    return jsonResponse([]); // messages/positions/neighbors/traces/stats
  }

  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => stubFetch(url);
  try {
    const { _testUtils } = initializeApp(CONFIG);
    await _testUtils.initialLoad;
    await settle();

    // Two further refreshes, each delivering one new telemetry packet.
    telemetryBody = [{ id: 2, node_id: NODE_ID, node_num: 1, rx_time: NOW - 40, battery_level: 81 }];
    await _testUtils.refresh();
    await settle();
    telemetryBody = [{ id: 3, node_id: NODE_ID, node_num: 1, rx_time: NOW - 20, battery_level: 82 }];
    await _testUtils.refresh();
    await settle();

    // The raw accumulator must retain all three packets (the bug collapsed it to 1).
    assert.equal(
      _testUtils.getLoadedTelemetryCount(),
      3,
      `all three telemetry packets must remain loaded (saw ${_testUtils.getLoadedTelemetryCount()})`,
    );

    // The rendered Log must show all three telemetry entries (the bug dropped
    // the intermediate one, leaving 2).
    const chat = env.document.getElementById('chat');
    const html = chat ? chat.innerHTML : '';
    assert.equal(
      countOccurrences(html, 'Broadcasted telemetry'),
      3,
      `the Log must show all three telemetry entries (saw ${countOccurrences(html, 'Broadcasted telemetry')})`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

/** Build a resolved fetch-style response around a JSON body. */
function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}
