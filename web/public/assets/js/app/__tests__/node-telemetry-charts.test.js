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

import { renderTelemetryChartSections, normalizeTelemetryRecords, __testUtils } from '../node-telemetry-charts.js';

const { createScatterChart } = __testUtils;

test('normalizeTelemetryRecords filters records outside the lookback window and sorts chronologically', () => {
  const now = Date.UTC(2024, 0, 15, 12, 0, 0);
  const recent = Math.floor(now / 1_000) - 60;
  const slightlyOlder = Math.floor(now / 1_000) - 3600;
  const stale = Math.floor(now / 1_000) - (7 * 24 * 60 * 60) - 10;
  const records = [
    { rx_time: recent, battery_level: 90 },
    { telemetry_time: slightlyOlder, battery_level: '85.5', rx_time: null },
    { rx_time: stale, battery_level: 10 },
    null,
  ];

  const points = normalizeTelemetryRecords(records, { now });
  assert.equal(points.length, 2);
  assert.ok(points[0].time < points[1].time);
  assert.equal(points[0].battery, 85.5);
  assert.equal(points[1].battery, 90);
});

test('renderTelemetryChartSections returns chart markup for available metrics', () => {
  const now = Date.UTC(2024, 0, 15, 12, 0, 0);
  const timestamp = Math.floor(now / 1_000) - 120;
  const sections = renderTelemetryChartSections(
    [
      {
        rx_time: timestamp,
        battery_level: 72,
        voltage: 4.05,
        channel_utilization: 11.5,
        air_util_tx: 0.35,
        temperature: 22.5,
        relative_humidity: 58,
        barometric_pressure: 1_012.4,
      },
    ],
    { now },
  );

  assert.equal(Array.isArray(sections), true);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].includes('data-chart="power"'), true);
  assert.equal(sections[1].includes('data-chart="channel"'), true);
  assert.equal(sections[2].includes('data-chart="environment"'), true);
});

test('createScatterChart renders points with single-axis datasets', () => {
  const svg = createScatterChart({
    id: 'single-axis',
    description: 'Single axis test',
    xLabel: 'Time',
    leftLabel: 'Left axis',
    series: [
      {
        id: 'left-series',
        label: 'Left series',
        color: '#123456',
        axis: 'left',
        points: [
          { time: 1_000, value: 10 },
          { time: 2_000, value: 12 },
        ],
      },
    ],
    leftTickFormatter: value => value.toFixed(0),
  });

  assert.equal(svg.includes('telemetry-chart__svg'), true);
  assert.equal((svg.match(/<circle/g) ?? []).length, 2);
  assert.equal((svg.match(/r="2"/g) ?? []).length, 2);
  assert.equal(svg.includes('fill="#123456"'), true);
  assert.equal(svg.includes('stroke="none"'), true);
  assert.equal(svg.includes('Left axis'), true);
  assert.equal(svg.includes('telemetry-chart__axis-label--right'), false);
});

test('createScatterChart renders dual axis plots when both series are present', () => {
  const svg = createScatterChart({
    id: 'dual-axis',
    description: 'Dual axis test',
    xLabel: 'Time',
    leftLabel: 'Left axis',
    rightLabel: 'Right axis',
    series: [
      {
        id: 'left',
        label: 'Left',
        color: '#abcdef',
        axis: 'left',
        points: [
          { time: 1_000, value: 5 },
          { time: 2_000, value: 6 },
        ],
      },
      {
        id: 'right',
        label: 'Right',
        color: '#fedcba',
        axis: 'right',
        points: [
          { time: 1_000, value: 1.5 },
          { time: 2_000, value: 1.8 },
        ],
      },
    ],
    leftTickFormatter: value => value.toFixed(1),
    rightTickFormatter: value => value.toFixed(2),
  });

  assert.equal(svg.includes('telemetry-chart__axis-label--right'), true);
  assert.equal(svg.includes('data-series="right"'), true);
  assert.equal(svg.includes('fill="#fedcba"'), true);
});

