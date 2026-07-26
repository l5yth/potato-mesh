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
  fetchActivityChartBuckets,
  renderMeshActivityChart,
} from '../mesh-activity-chart.js';

const NOW = 1_700_000_000_000; // milliseconds
const TWO_HOURS = 7200;

function bucketsFixture() {
  const startSec = Math.floor(NOW / 1000) - 4 * TWO_HOURS;
  return [
    { bucket_start: startSec, bucket_end: startSec + TWO_HOURS, total: 30, meshtastic: 20, meshcore: 10 },
    { bucket_start: startSec + TWO_HOURS, bucket_end: startSec + 2 * TWO_HOURS, total: 50, meshtastic: 30, meshcore: 20 },
  ];
}

test('fetchActivityChartBuckets requests the 7d/2h series and returns the array', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return { ok: true, async json() { return bucketsFixture(); } };
  };
  const buckets = await fetchActivityChartBuckets({ fetchImpl });
  assert.equal(buckets.length, 2);
  assert.match(calls[0], /\/api\/stats\/activity\?window_seconds=604800&bucket_seconds=7200/);
});

test('fetchActivityChartBuckets fails soft to [] on non-OK, error, and non-array', async () => {
  assert.deepEqual(
    await fetchActivityChartBuckets({ fetchImpl: async () => ({ ok: false, status: 500 }) }),
    []
  );
  assert.deepEqual(
    await fetchActivityChartBuckets({ fetchImpl: async () => { throw new Error('down'); } }),
    []
  );
  assert.deepEqual(
    await fetchActivityChartBuckets({
      fetchImpl: async () => ({ ok: true, async json() { return { not: 'array' }; } }),
    }),
    []
  );
});

test('renderMeshActivityChart draws a per-protocol figure with the Activity axis label', () => {
  const html = renderMeshActivityChart(bucketsFixture(), NOW);
  assert.match(html, /<h4>Mesh activity<\/h4>/);
  assert.match(html, /Activity \(pkt\/h\)/); // y-axis label (per the note)
  assert.match(html, /Meshtastic/);
  assert.match(html, /MeshCore/);
  assert.match(html, /#8856a7/); // meshtastic colour
  assert.match(html, /#3182bd/); // meshcore colour
  assert.match(html, /node-detail__chart-trend/); // a trend line path
  assert.match(html, /node-detail__chart-legend/);
});

test('renderMeshActivityChart returns empty string when there is no usable data', () => {
  assert.equal(renderMeshActivityChart([], NOW), '');
  assert.equal(renderMeshActivityChart(null, NOW), '');
  // Buckets present but no finite per-protocol values → no lines.
  assert.equal(renderMeshActivityChart([{ bucket_start: 'x', meshtastic: 'y' }], NOW), '');
});

test('renderMeshActivityChart still renders when the whole series is zero', () => {
  const startSec = Math.floor(NOW / 1000) - TWO_HOURS;
  const html = renderMeshActivityChart(
    [
      { bucket_start: startSec, meshtastic: 0, meshcore: 0 },
      { bucket_start: startSec + TWO_HOURS, meshtastic: 0, meshcore: 0 },
    ],
    NOW
  );
  // maxValue 0 → axis.max falls back to 1; the figure and its lines still draw.
  assert.match(html, /<h4>Mesh activity<\/h4>/);
  assert.match(html, /node-detail__chart-trend/);
});
