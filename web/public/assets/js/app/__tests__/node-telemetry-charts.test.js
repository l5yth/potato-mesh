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

const { createScatterChart, buildStaticTimeAxis, generateLogTicks, scaleLogarithmic } = __testUtils;

test('normalizeTelemetryRecords filters records outside the lookback window and sorts chronologically', () => {
  const now = Date.UTC(2024, 0, 15, 12, 0, 0);
  const recent = Math.floor(now / 1_000) - 60;
  const slightlyOlder = Math.floor(now / 1_000) - 3600;
  const stale = Math.floor(now / 1_000) - (7 * 24 * 60 * 60) - 10;
  const records = [
    { rx_time: recent, battery_level: 90, gas_resistance: 10_000 },
    { telemetry_time: slightlyOlder, battery_level: '85.5', gas_resistance: '1250', rx_time: null },
    { rx_time: stale, battery_level: 10 },
    null,
  ];

  const points = normalizeTelemetryRecords(records, { now });
  assert.equal(points.length, 2);
  assert.ok(points[0].time < points[1].time);
  assert.equal(points[0].battery, 85.5);
  assert.equal(points[1].battery, 90);
  assert.equal(points[0].gasResistance, 1_250);
  assert.equal(points[1].gasResistance, 10_000);
});

test('buildStaticTimeAxis yields midnight-aligned ticks for seven-day span', () => {
  const nowSeconds = Math.floor(Date.UTC(2024, 0, 15, 12, 0, 0) / 1_000);
  const { domain, ticks } = buildStaticTimeAxis(nowSeconds);

  assert.equal(domain.min, Math.floor(Date.UTC(2024, 0, 8, 12, 0, 0) / 1_000));
  assert.equal(domain.max, Math.floor(Date.UTC(2024, 0, 15, 12, 0, 0) / 1_000));
  assert.equal(ticks.length, 7);
  assert.equal(ticks[0].label, '2024-01-09');
  assert.equal(ticks[ticks.length - 1].label, '2024-01-15');
});

test('generateLogTicks returns endpoints and decade markers', () => {
  const ticks = generateLogTicks(50, 50_000, value => value.toFixed(0));
  assert.deepEqual(
    ticks.map(tick => tick.value),
    [50, 100, 1_000, 10_000, 50_000],
  );
});

test('scaleLogarithmic clamps non-positive values to the lower bound', () => {
  const scale = scaleLogarithmic({ min: 0, max: 500_000 }, { min: 0, max: 100 });
  const baseline = scale(500);
  assert.equal(scale(0), baseline);
  const top = scale(500_000);
  assert.ok(top > baseline);
  assert.ok(Math.abs(top - 100) < 1e-6);
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
  assert.equal(sections.length, 4);
  assert.equal(sections[0].includes('data-chart="power"'), true);
  assert.equal(sections[1].includes('data-chart="channel"'), true);
  assert.equal(sections[2].includes('data-chart="environment"'), true);
  assert.equal(sections[3].includes('data-chart="pressure"'), true);
  assert.equal(sections[0].includes('Battery level (%)'), true);
  assert.equal(sections[1].includes('Utilisation (%)'), true);
  assert.equal(sections[2].includes('data-series="humidity"'), true);
  assert.equal(sections[2].includes('Humidity (%)'), true);
  assert.equal(sections[3].includes('Pressure (hPa)'), true);
  assert.equal(sections[3].includes('Gas resistance (Ω, log scale)'), false);
  assert.equal(sections[3].includes('data-series="gas-resistance"'), false);
  assert.equal(sections[0].includes('2024-01-09'), true);
});

test('createScatterChart renders points with single-axis datasets', () => {
  const svg = createScatterChart({
    id: 'single-axis',
    description: 'Single axis test',
    xLabel: 'Date',
    series: [
      {
        id: 'left-series',
        label: 'Left series',
        color: '#123456',
        axis: 'left-axis',
        points: [
          { time: 1_000, value: 10 },
          { time: 2_000, value: 12 },
        ],
        line: { opacity: 0.5, width: 1 },
      },
    ],
    axes: [
      {
        id: 'left-axis',
        position: 'left',
        label: 'Left axis',
        formatter: value => value.toFixed(0),
      },
    ],
  });

  assert.equal(svg.includes('telemetry-chart__svg'), true);
  assert.equal((svg.match(/<circle/g) ?? []).length, 2);
  assert.equal((svg.match(/r="2"/g) ?? []).length, 2);
  assert.equal(svg.includes('fill="#123456"'), true);
  assert.equal(svg.includes('stroke="none"'), true);
  assert.equal(svg.includes('Left axis'), true);
  assert.equal(svg.includes('telemetry-chart__axis-label--right'), false);
  assert.equal((svg.match(/stroke-opacity="0.5"/g) ?? []).length >= 1, true);
});

test('createScatterChart renders dual axis plots when both series are present', () => {
  const svg = createScatterChart({
    id: 'dual-axis',
    description: 'Dual axis test',
    xLabel: 'Date',
    series: [
      {
        id: 'left',
        label: 'Left',
        color: '#abcdef',
        axis: 'left-axis',
        points: [
          { time: 1_000, value: 5 },
          { time: 2_000, value: 6 },
        ],
      },
      {
        id: 'right',
        label: 'Right',
        color: '#fedcba',
        axis: 'right-axis',
        points: [
          { time: 1_000, value: 1.5 },
          { time: 2_000, value: 1.8 },
        ],
      },
    ],
    axes: [
      {
        id: 'left-axis',
        position: 'left',
        label: 'Left axis',
        formatter: value => value.toFixed(1),
      },
      {
        id: 'right-axis',
        position: 'right',
        label: 'Right axis',
        formatter: value => value.toFixed(2),
      },
    ],
  });

  assert.equal(svg.includes('telemetry-chart__axis-label--right'), true);
  assert.equal(svg.includes('data-series="right"'), true);
  assert.equal(svg.includes('fill="#fedcba"'), true);
});

test('createScatterChart applies explicit time ticks and domains', () => {
  const svg = createScatterChart({
    id: 'explicit',
    description: 'Explicit domain test',
    xLabel: 'Date',
    xDomain: { min: 0, max: 10 },
    xTicks: [
      { value: 0, label: 'Day 0' },
      { value: 5, label: 'Day 5' },
      { value: 10, label: 'Day 10' },
    ],
    series: [
      {
        id: 'series',
        label: 'Series',
        color: '#abcdef',
        axis: 'axis',
        points: [
          { time: 2, value: 1 },
          { time: 8, value: 2 },
        ],
        line: { opacity: 0.5, width: 1 },
      },
    ],
    axes: [
      {
        id: 'axis',
        position: 'left',
        label: 'Axis',
        formatter: value => value.toFixed(0),
        domain: { min: 0, max: 5 },
      },
    ],
  });

  assert.equal(svg.includes('Day 0'), true);
  assert.equal(svg.includes('Day 5'), true);
  assert.equal(svg.includes('Day 10'), true);
});

test('environment and pressure charts expose fixed domains with overlays', () => {
  const now = Date.UTC(2024, 0, 15, 12, 0, 0);
  const timestamp = Math.floor(now / 1_000) - 120;
  const sections = renderTelemetryChartSections(
    [
      {
        rx_time: timestamp,
        battery_level: 80,
        voltage: 4.0,
        channel_utilization: 10,
        air_util_tx: 6,
        temperature: 21.5,
        relative_humidity: 55,
        barometric_pressure: 1_010.2,
        gas_resistance: 125_000,
      },
      {
        rx_time: timestamp - 3_600,
        battery_level: 79,
        voltage: 3.98,
        channel_utilization: 12,
        air_util_tx: 8,
        temperature: 21.0,
        relative_humidity: 58,
        barometric_pressure: 1_008.5,
        gas_resistance: 12_500,
      },
    ],
    { now },
  );

  const environment = sections.find(section => section.includes('data-chart="environment"'));
  assert.ok(environment);
  assert.equal(environment.includes('Humidity (%)'), true);
  assert.equal(environment.includes('data-series="humidity"'), true);
  const humidityDotCount = (environment.match(/data-series="humidity"/g) ?? []).length;
  assert.ok(humidityDotCount >= 2);
  assert.equal(environment.includes('data-series="pressure"'), false);

  const pressureChart = sections.find(section => section.includes('data-chart="pressure"'));
  assert.ok(pressureChart);
  const pressureLineCount = (pressureChart.match(/stroke-opacity="0.5"/g) ?? []).length;
  assert.ok(pressureLineCount >= 2);
  assert.equal(pressureChart.includes('Pressure (hPa)'), true);
  assert.equal(pressureChart.includes('Gas resistance (Ω, log scale)'), true);
  assert.equal(pressureChart.includes('data-series="gas-resistance"'), true);
  assert.equal(pressureChart.includes('fill="#c51b8a"'), true);
  assert.equal(pressureChart.includes('fill="#fa9fb5"'), true);

  const channel = sections.find(section => section.includes('data-chart="channel"'));
  assert.ok(channel);
  const utilisationAxisCount = (channel.match(/Utilisation \(%\)/g) ?? []).length;
  assert.equal(utilisationAxisCount, 1);
  assert.ok(channel.includes('0.0'));
});

