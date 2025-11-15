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
  fetchAggregatedTelemetry,
  initializeChartsPage,
  buildMovingAverageSeries,
} from '../charts-page.js';

function createResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test('fetchAggregatedTelemetry requests the latest 1000 telemetry entries', async () => {
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    return createResponse(200, [{ rx_time: 1_700_000_000, node_id: '!demo' }]);
  };
  const snapshots = await fetchAggregatedTelemetry({ fetchImpl });
  assert.equal(requests.length, 1);
  assert.equal(requests[0], '/api/telemetry?limit=1000');
  assert.equal(Array.isArray(snapshots), true);
  assert.equal(snapshots[0].node_id, '!demo');
});

test('fetchAggregatedTelemetry validates fetch availability and response codes', async () => {
  await assert.rejects(() => fetchAggregatedTelemetry({ fetchImpl: null }), /fetch implementation/i);
  const fetchImpl = async () => createResponse(503, []);
  await assert.rejects(() => fetchAggregatedTelemetry({ fetchImpl }), /Failed to fetch telemetry/);
});

test('initializeChartsPage renders the telemetry charts when snapshots are available', async () => {
  const container = { innerHTML: '' };
  const documentStub = {
    getElementById(id) {
      return id === 'chartsPage' ? container : null;
    },
  };
  const fetchImpl = async () => createResponse(200, [{ rx_time: 1_700_000_000, temperature: 22.5 }]);
  let receivedOptions = null;
  const renderCharts = (node, options) => {
    receivedOptions = options;
    return '<section class="node-detail__charts">Charts</section>';
  };
  const result = await initializeChartsPage({ document: documentStub, fetchImpl, renderCharts });
  assert.equal(result, true);
  assert.equal(container.innerHTML.includes('node-detail__charts'), true);
  assert.ok(receivedOptions);
  assert.equal(receivedOptions.chartOptions.windowMs, 86_400_000);
  assert.equal(typeof receivedOptions.chartOptions.lineReducer, 'function');
  const average = receivedOptions.chartOptions.lineReducer(
    [
      { timestamp: 0, value: 0 },
      { timestamp: 1_800_000, value: 10 },
      { timestamp: 3_600_000, value: 20 },
    ],
  );
  assert.equal(Array.isArray(average), true);
});

test('initializeChartsPage shows an error message when fetching fails', async () => {
  const container = { innerHTML: '' };
  const documentStub = {
    getElementById() {
      return container;
    },
  };
  const fetchImpl = async () => {
    throw new Error('network');
  };
  const renderCharts = () => '<section>unused</section>';
  const result = await initializeChartsPage({ document: documentStub, fetchImpl, renderCharts });
  assert.equal(result, false);
  assert.equal(container.innerHTML.includes('Failed to load telemetry charts.'), true);
});

test('initializeChartsPage handles missing containers and empty telemetry snapshots', async () => {
  const documentMissing = { getElementById() { return null; } };
  const noneResult = await initializeChartsPage({ document: documentMissing });
  assert.equal(noneResult, false);

  const container = { innerHTML: '' };
  const documentStub = {
    getElementById() {
      return container;
    },
  };
  const fetchImpl = async () => createResponse(200, []);
  const renderCharts = () => '';
  const result = await initializeChartsPage({ document: documentStub, fetchImpl, renderCharts });
  assert.equal(result, true);
  assert.equal(container.innerHTML.includes('Telemetry snapshots are unavailable.'), true);
});

test('initializeChartsPage shows a status when rendering produces no markup', async () => {
  const container = { innerHTML: '' };
  const documentStub = {
    getElementById() {
      return container;
    },
  };
  const fetchImpl = async () => createResponse(200, [{ rx_time: 1_700_000_000 }]);
  const renderCharts = () => '';
  const result = await initializeChartsPage({ document: documentStub, fetchImpl, renderCharts });
  assert.equal(result, true);
  assert.equal(container.innerHTML.includes('Telemetry snapshots are unavailable.'), true);
});

test('initializeChartsPage validates the document contract', async () => {
  await assert.rejects(() => initializeChartsPage({ document: {} }), /getElementById/);
});

test('buildMovingAverageSeries computes a rolling mean across the window', () => {
  const points = [
    { timestamp: 0, value: 0 },
    { timestamp: 30 * 60 * 1000, value: 30 },
    { timestamp: 60 * 60 * 1000, value: 60 },
    { timestamp: 90 * 60 * 1000, value: 90 },
  ];
  const averages = buildMovingAverageSeries(points, 60 * 60 * 1000);
  assert.equal(averages.length, points.length);
  assert.equal(Math.round(averages[0].value), 0);
  assert.equal(Math.round(averages[1].value), 15);
  assert.equal(Math.round(averages[2].value), 30);
  assert.equal(Math.round(averages[3].value), 60);
});
