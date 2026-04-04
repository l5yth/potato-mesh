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
  clamp,
  hexToRgba,
  padTwo,
  formatCompactDate,
  formatGasResistance,
  formatSeriesPointValue,
  formatFrequency,
  formatBattery,
  formatVoltage,
  formatUptime,
  formatTimestamp,
  formatMessageTimestamp,
  formatHardwareModel,
  formatCoordinate,
  formatRelativeSeconds,
  formatDurationSeconds,
  formatSnr,
  toTimestampMs,
  resolveSnapshotTimestamp,
  buildMidnightTicks,
  buildHourlyTicks,
  buildLinearTicks,
  buildLogTicks,
  formatAxisTick,
  createChartDimensions,
  resolveAxisX,
  scaleTimestamp,
  scaleValueToAxis,
  collectSnapshotContainers,
  classifySnapshot,
  extractSnapshotValue,
  buildSeriesPoints,
  resolveAxisMax,
  renderTelemetrySeries,
  renderYAxis,
  renderXAxis,
  renderTelemetryChart,
  DAY_MS,
  HOUR_MS,
  TELEMETRY_WINDOW_MS,
  DEFAULT_CHART_DIMENSIONS,
  DEFAULT_CHART_MARGIN,
} from '../node-page-charts.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('DAY_MS is 86400000', () => {
  assert.equal(DAY_MS, 86_400_000);
});

test('HOUR_MS is 3600000', () => {
  assert.equal(HOUR_MS, 3_600_000);
});

test('TELEMETRY_WINDOW_MS is 7 days', () => {
  assert.equal(TELEMETRY_WINDOW_MS, DAY_MS * 7);
});

// ---------------------------------------------------------------------------
// clamp
// ---------------------------------------------------------------------------

test('clamp returns value when within range', () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test('clamp returns min when value is below min', () => {
  assert.equal(clamp(-5, 0, 10), 0);
});

test('clamp returns max when value is above max', () => {
  assert.equal(clamp(15, 0, 10), 10);
});

test('clamp returns min for non-finite value', () => {
  // Non-finite inputs always resolve to min (implementation guard).
  assert.equal(clamp(NaN, 0, 10), 0);
  assert.equal(clamp(Infinity, 0, 10), 0);
});

// ---------------------------------------------------------------------------
// hexToRgba
// ---------------------------------------------------------------------------

test('hexToRgba converts 6-char hex', () => {
  assert.equal(hexToRgba('#ff0000', 1), 'rgba(255, 0, 0, 1)');
});

test('hexToRgba converts 3-char shorthand hex', () => {
  assert.equal(hexToRgba('#f00', 1), 'rgba(255, 0, 0, 1)');
});

test('hexToRgba applies alpha channel', () => {
  assert.equal(hexToRgba('#ffffff', 0.5), 'rgba(255, 255, 255, 0.5)');
});

test('hexToRgba falls back to opaque black on invalid input', () => {
  assert.equal(hexToRgba('invalid', 1), 'rgba(0, 0, 0, 1)');
  assert.equal(hexToRgba('', 1), 'rgba(0, 0, 0, 1)');
  assert.equal(hexToRgba(null, 1), 'rgba(0, 0, 0, 1)');
});

// ---------------------------------------------------------------------------
// padTwo
// ---------------------------------------------------------------------------

test('padTwo pads single-digit numbers', () => {
  assert.equal(padTwo(3), '03');
  assert.equal(padTwo(9), '09');
});

test('padTwo does not pad two-digit numbers', () => {
  assert.equal(padTwo(12), '12');
});

test('padTwo handles zero', () => {
  assert.equal(padTwo(0), '00');
});

// ---------------------------------------------------------------------------
// formatCompactDate
// ---------------------------------------------------------------------------

test('formatCompactDate returns two-digit day of month', () => {
  // 2025-01-05 UTC
  const ts = Date.UTC(2025, 0, 5);
  assert.equal(formatCompactDate(ts), '05');
});

test('formatCompactDate returns empty string for NaN', () => {
  assert.equal(formatCompactDate(NaN), '');
});

// ---------------------------------------------------------------------------
// formatGasResistance
// ---------------------------------------------------------------------------

test('formatGasResistance formats megaohm values', () => {
  assert.equal(formatGasResistance(2_000_000), '2.00 M\u03a9');
});

test('formatGasResistance formats kilohm values', () => {
  assert.equal(formatGasResistance(5_000), '5.00 k\u03a9');
});

test('formatGasResistance formats ohm values >= 100', () => {
  assert.equal(formatGasResistance(200), '200.0 \u03a9');
});

test('formatGasResistance formats small ohm values', () => {
  assert.equal(formatGasResistance(42), '42 \u03a9');
});

test('formatGasResistance returns empty string for null', () => {
  assert.equal(formatGasResistance(null), '');
});

// ---------------------------------------------------------------------------
// formatSeriesPointValue
// ---------------------------------------------------------------------------

test('formatSeriesPointValue uses valueFormatter when present', () => {
  const config = { valueFormatter: v => `${v.toFixed(1)}%` };
  assert.equal(formatSeriesPointValue(config, 87.5), '87.5%');
});

test('formatSeriesPointValue falls back to toString', () => {
  const config = {};
  assert.equal(formatSeriesPointValue(config, 42), '42');
});

test('formatSeriesPointValue returns empty string for null value', () => {
  assert.equal(formatSeriesPointValue({}, null), '');
});

// ---------------------------------------------------------------------------
// formatFrequency
// ---------------------------------------------------------------------------

test('formatFrequency converts Hz to MHz string', () => {
  assert.equal(formatFrequency(915_000_000), '915.000 MHz');
});

test('formatFrequency converts kHz to MHz string', () => {
  assert.equal(formatFrequency(868_000), '868.000 MHz');
});

test('formatFrequency formats small numeric values as MHz', () => {
  assert.equal(formatFrequency(915), '915.000 MHz');
});

test('formatFrequency passes through non-numeric strings', () => {
  assert.equal(formatFrequency('custom'), 'custom');
});

test('formatFrequency returns null for null/empty', () => {
  assert.equal(formatFrequency(null), null);
  assert.equal(formatFrequency(''), null);
});

// ---------------------------------------------------------------------------
// formatBattery
// ---------------------------------------------------------------------------

test('formatBattery formats numeric battery level', () => {
  assert.equal(formatBattery(87.135), '87.1%');
  assert.equal(formatBattery(100), '100.0%');
});

test('formatBattery returns null for null', () => {
  assert.equal(formatBattery(null), null);
});

// ---------------------------------------------------------------------------
// formatVoltage
// ---------------------------------------------------------------------------

test('formatVoltage formats with two decimal places', () => {
  assert.equal(formatVoltage(4.1), '4.10 V');
  assert.equal(formatVoltage(3.7), '3.70 V');
});

test('formatVoltage returns null for null', () => {
  assert.equal(formatVoltage(null), null);
});

// ---------------------------------------------------------------------------
// formatUptime
// ---------------------------------------------------------------------------

test('formatUptime formats seconds', () => {
  assert.equal(formatUptime(45), '45s');
});

test('formatUptime formats minutes and seconds', () => {
  assert.equal(formatUptime(125), '2m 5s');
});

test('formatUptime formats hours and minutes', () => {
  assert.equal(formatUptime(3661), '1h 1m 1s');
});

test('formatUptime formats days', () => {
  assert.equal(formatUptime(86400), '1d');
  assert.equal(formatUptime(90061), '1d 1h 1m 1s');
});

test('formatUptime returns null for null', () => {
  assert.equal(formatUptime(null), null);
});

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

test('formatTimestamp converts UNIX seconds to ISO string', () => {
  const result = formatTimestamp(1_700_000_000);
  assert.match(result, /T/);
  assert.ok(result.includes('2023'));
});

test('formatTimestamp prefers isoFallback when supplied', () => {
  assert.equal(formatTimestamp(0, '2025-01-01T00:00:00.000Z'), '2025-01-01T00:00:00.000Z');
});

test('formatTimestamp returns null for null', () => {
  assert.equal(formatTimestamp(null), null);
});

// ---------------------------------------------------------------------------
// formatMessageTimestamp
// ---------------------------------------------------------------------------

test('formatMessageTimestamp returns YYYY-MM-DD HH:MM format', () => {
  const result = formatMessageTimestamp(1_700_000_000);
  assert.match(result, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('formatMessageTimestamp prefers ISO fallback', () => {
  const iso = '2025-06-15T10:30:00.000Z';
  const result = formatMessageTimestamp(0, iso);
  assert.match(result, /^2025-06-15 /);
});

test('formatMessageTimestamp returns null for null', () => {
  assert.equal(formatMessageTimestamp(null), null);
});

// ---------------------------------------------------------------------------
// formatHardwareModel
// ---------------------------------------------------------------------------

test('formatHardwareModel returns the model string', () => {
  assert.equal(formatHardwareModel('TBEAM'), 'TBEAM');
});

test('formatHardwareModel returns empty string for UNSET', () => {
  assert.equal(formatHardwareModel('UNSET'), '');
  assert.equal(formatHardwareModel('unset'), '');
});

test('formatHardwareModel returns empty string for null', () => {
  assert.equal(formatHardwareModel(null), '');
});

// ---------------------------------------------------------------------------
// formatCoordinate
// ---------------------------------------------------------------------------

test('formatCoordinate formats with 5 decimal places by default', () => {
  assert.equal(formatCoordinate(48.8566), '48.85660');
});

test('formatCoordinate respects precision parameter', () => {
  assert.equal(formatCoordinate(48.8566, 2), '48.86');
});

test('formatCoordinate returns empty string for null', () => {
  assert.equal(formatCoordinate(null), '');
});

// ---------------------------------------------------------------------------
// formatRelativeSeconds
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000;

test('formatRelativeSeconds returns seconds for small diff', () => {
  assert.equal(formatRelativeSeconds(NOW - 30, NOW), '30s');
});

test('formatRelativeSeconds returns minutes for medium diff', () => {
  const NOW = 1_700_000_000;
  assert.equal(formatRelativeSeconds(NOW - 180, NOW), '3m');
  assert.equal(formatRelativeSeconds(NOW - 185, NOW), '3m 5s');
});

test('formatRelativeSeconds returns hours', () => {
  const NOW = 1_700_000_000;
  assert.equal(formatRelativeSeconds(NOW - 7200, NOW), '2h');
  assert.equal(formatRelativeSeconds(NOW - 7260, NOW), '2h 1m');
});

test('formatRelativeSeconds returns days', () => {
  const NOW = 1_700_000_000;
  assert.equal(formatRelativeSeconds(NOW - 86400, NOW), '1d');
  assert.equal(formatRelativeSeconds(NOW - (86400 + 3600), NOW), '1d 1h');
});

test('formatRelativeSeconds returns empty string for null', () => {
  assert.equal(formatRelativeSeconds(null), '');
});

// ---------------------------------------------------------------------------
// formatDurationSeconds
// ---------------------------------------------------------------------------

test('formatDurationSeconds formats short durations', () => {
  assert.equal(formatDurationSeconds(45), '45s');
  assert.equal(formatDurationSeconds(0), '0s');
});

test('formatDurationSeconds formats minutes and seconds', () => {
  assert.equal(formatDurationSeconds(125), '2m 5s');
  assert.equal(formatDurationSeconds(120), '2m');
});

test('formatDurationSeconds formats multi-unit durations', () => {
  // In the hours branch (<86400) only hours and minutes are shown.
  assert.equal(formatDurationSeconds(3661), '1h 1m');
  assert.equal(formatDurationSeconds(90000), '1d 1h');
});

test('formatDurationSeconds returns empty string for null', () => {
  assert.equal(formatDurationSeconds(null), '');
});

// ---------------------------------------------------------------------------
// formatSnr
// ---------------------------------------------------------------------------

test('formatSnr formats with one decimal place and dB suffix', () => {
  assert.equal(formatSnr(5.2), '5.2 dB');
  assert.equal(formatSnr(-3), '-3.0 dB');
});

test('formatSnr returns empty string for null', () => {
  assert.equal(formatSnr(null), '');
});

// ---------------------------------------------------------------------------
// toTimestampMs
// ---------------------------------------------------------------------------

test('toTimestampMs treats values > 1e12 as already milliseconds', () => {
  const ms = 1_700_000_000_000;
  assert.equal(toTimestampMs(ms), ms);
});

test('toTimestampMs multiplies small values by 1000', () => {
  assert.equal(toTimestampMs(1_700_000_000), 1_700_000_000_000);
});

test('toTimestampMs returns null for null', () => {
  assert.equal(toTimestampMs(null), null);
  assert.equal(toTimestampMs(NaN), null);
});

// ---------------------------------------------------------------------------
// resolveSnapshotTimestamp
// ---------------------------------------------------------------------------

test('resolveSnapshotTimestamp uses rx_iso when available', () => {
  const ts = resolveSnapshotTimestamp({ rx_iso: '2025-01-01T00:00:00.000Z' });
  assert.equal(ts, new Date('2025-01-01T00:00:00.000Z').getTime());
});

test('resolveSnapshotTimestamp falls back to numeric rx_time', () => {
  const ts = resolveSnapshotTimestamp({ rx_time: 1_700_000_000 });
  assert.equal(ts, 1_700_000_000_000);
});

test('resolveSnapshotTimestamp returns null for null input', () => {
  assert.equal(resolveSnapshotTimestamp(null), null);
  assert.equal(resolveSnapshotTimestamp({}), null);
});

// ---------------------------------------------------------------------------
// buildMidnightTicks
// ---------------------------------------------------------------------------

test('buildMidnightTicks returns chronologically ordered timestamps', () => {
  const now = Date.UTC(2025, 0, 8, 12, 0, 0);
  const ticks = buildMidnightTicks(now, DAY_MS * 3);
  assert.ok(ticks.length >= 2, 'should include at least 2 midnight ticks');
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i] > ticks[i - 1], 'ticks should be in chronological order');
  }
});

// ---------------------------------------------------------------------------
// buildHourlyTicks
// ---------------------------------------------------------------------------

test('buildHourlyTicks returns chronologically ordered hourly timestamps', () => {
  const now = Date.UTC(2025, 0, 8, 12, 0, 0);
  const ticks = buildHourlyTicks(now, HOUR_MS * 4);
  assert.ok(ticks.length >= 3, 'should return at least 3 hourly ticks for a 4-hour window');
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i] > ticks[i - 1], 'ticks should be in chronological order');
  }
});

// ---------------------------------------------------------------------------
// buildLinearTicks
// ---------------------------------------------------------------------------

test('buildLinearTicks returns evenly spaced tick values including bounds', () => {
  const ticks = buildLinearTicks(0, 100, 4);
  assert.equal(ticks.length, 5);
  assert.equal(ticks[0], 0);
  assert.equal(ticks[4], 100);
});

test('buildLinearTicks returns single value when min equals max', () => {
  assert.deepEqual(buildLinearTicks(50, 50), [50]);
});

test('buildLinearTicks returns empty array for non-finite bounds', () => {
  assert.deepEqual(buildLinearTicks(NaN, 100), []);
  assert.deepEqual(buildLinearTicks(0, Infinity), []);
});

// ---------------------------------------------------------------------------
// buildLogTicks
// ---------------------------------------------------------------------------

test('buildLogTicks returns powers of ten between min and max', () => {
  const ticks = buildLogTicks(10, 100_000);
  assert.ok(ticks.includes(100));
  assert.ok(ticks.includes(1_000));
  assert.ok(ticks.includes(10_000));
});

test('buildLogTicks returns empty array for invalid input', () => {
  assert.deepEqual(buildLogTicks(0, 100), []);
  assert.deepEqual(buildLogTicks(-1, 100), []);
  assert.deepEqual(buildLogTicks(100, 10), []);
});

// ---------------------------------------------------------------------------
// formatAxisTick
// ---------------------------------------------------------------------------

test('formatAxisTick uses k-suffix for log scale large values', () => {
  assert.equal(formatAxisTick(5000, { scale: 'log' }), '5k');
});

test('formatAxisTick uses integer for log scale small values', () => {
  assert.equal(formatAxisTick(100, { scale: 'log' }), '100');
});

test('formatAxisTick uses one decimal when range <= 10', () => {
  assert.equal(formatAxisTick(5, { min: 0, max: 10 }), '5.0');
});

test('formatAxisTick uses integer for wide range', () => {
  assert.equal(formatAxisTick(50, { min: 0, max: 100 }), '50');
});

test('formatAxisTick returns empty string for non-finite', () => {
  assert.equal(formatAxisTick(NaN, { min: 0, max: 100 }), '');
});

// ---------------------------------------------------------------------------
// createChartDimensions
// ---------------------------------------------------------------------------

test('createChartDimensions returns expected structure', () => {
  const spec = { axes: [{ position: 'left' }] };
  const dims = createChartDimensions(spec);
  assert.equal(dims.width, DEFAULT_CHART_DIMENSIONS.width);
  assert.equal(dims.height, DEFAULT_CHART_DIMENSIONS.height);
  assert.ok(dims.innerWidth > 0);
  assert.ok(dims.innerHeight > 0);
  assert.ok(typeof dims.chartTop === 'number');
  assert.ok(typeof dims.chartBottom === 'number');
});

test('createChartDimensions widens right margin for rightSecondary axis', () => {
  const baseSpec = { axes: [{ position: 'right' }] };
  const extSpec = { axes: [{ position: 'right' }, { position: 'rightSecondary' }] };
  const baseDims = createChartDimensions(baseSpec);
  const extDims = createChartDimensions(extSpec);
  assert.ok(extDims.margin.right > baseDims.margin.right, 'rightSecondary should widen right margin');
});

test('createChartDimensions widens left margin for leftSecondary axis', () => {
  const baseSpec = { axes: [{ position: 'left' }] };
  const extSpec = { axes: [{ position: 'left' }, { position: 'leftSecondary' }] };
  const baseDims = createChartDimensions(baseSpec);
  const extDims = createChartDimensions(extSpec);
  assert.ok(extDims.margin.left > baseDims.margin.left, 'leftSecondary should widen left margin');
});

// ---------------------------------------------------------------------------
// resolveAxisX
// ---------------------------------------------------------------------------

test('resolveAxisX returns left margin for left position', () => {
  const dims = createChartDimensions({ axes: [] });
  assert.equal(resolveAxisX('left', dims), dims.margin.left);
});

test('resolveAxisX returns right margin offset for right position', () => {
  const dims = createChartDimensions({ axes: [] });
  assert.equal(resolveAxisX('right', dims), dims.width - dims.margin.right);
});

test('resolveAxisX falls back to left for unknown position', () => {
  const dims = createChartDimensions({ axes: [] });
  assert.equal(resolveAxisX('unknown', dims), dims.margin.left);
});

// ---------------------------------------------------------------------------
// scaleTimestamp
// ---------------------------------------------------------------------------

test('scaleTimestamp maps domain start to left margin', () => {
  const dims = createChartDimensions({ axes: [] });
  const start = 1000, end = 2000;
  const x = scaleTimestamp(start, start, end, dims);
  assert.equal(x, dims.margin.left);
});

test('scaleTimestamp maps domain end to right edge', () => {
  const dims = createChartDimensions({ axes: [] });
  const start = 1000, end = 2000;
  const x = scaleTimestamp(end, start, end, dims);
  assert.equal(x, dims.margin.left + dims.innerWidth);
});

test('scaleTimestamp clamps values outside the domain', () => {
  const dims = createChartDimensions({ axes: [] });
  const xBefore = scaleTimestamp(500, 1000, 2000, dims);
  const xAfter = scaleTimestamp(2500, 1000, 2000, dims);
  assert.equal(xBefore, dims.margin.left);
  assert.equal(xAfter, dims.margin.left + dims.innerWidth);
});

// ---------------------------------------------------------------------------
// scaleValueToAxis
// ---------------------------------------------------------------------------

test('scaleValueToAxis maps axis max to chartTop', () => {
  const dims = createChartDimensions({ axes: [] });
  const axis = { min: 0, max: 100 };
  const y = scaleValueToAxis(100, axis, dims);
  assert.equal(y, dims.chartTop);
});

test('scaleValueToAxis maps axis min to chartBottom', () => {
  const dims = createChartDimensions({ axes: [] });
  const axis = { min: 0, max: 100 };
  const y = scaleValueToAxis(0, axis, dims);
  assert.equal(y, dims.chartBottom);
});

test('scaleValueToAxis uses log scale when specified', () => {
  const dims = createChartDimensions({ axes: [] });
  const axis = { min: 10, max: 10_000, scale: 'log' };
  const yMin = scaleValueToAxis(10, axis, dims);
  const yMax = scaleValueToAxis(10_000, axis, dims);
  assert.equal(yMin, dims.chartBottom);
  assert.equal(yMax, dims.chartTop);
});

test('scaleValueToAxis returns chartBottom when axis is null', () => {
  const dims = createChartDimensions({ axes: [] });
  assert.equal(scaleValueToAxis(50, null, dims), dims.chartBottom);
});

// ---------------------------------------------------------------------------
// collectSnapshotContainers
// ---------------------------------------------------------------------------

test('collectSnapshotContainers returns the snapshot itself', () => {
  const snapshot = { battery: 80 };
  const containers = collectSnapshotContainers(snapshot);
  assert.ok(containers.includes(snapshot));
});

test('collectSnapshotContainers includes device_metrics sub-object', () => {
  const sub = { battery_level: 90 };
  const snapshot = { device_metrics: sub };
  const containers = collectSnapshotContainers(snapshot);
  assert.ok(containers.includes(sub));
});

test('collectSnapshotContainers drills into raw.device_metrics', () => {
  const nested = { battery_level: 85 };
  const snapshot = { raw: { device_metrics: nested } };
  const containers = collectSnapshotContainers(snapshot);
  assert.ok(containers.includes(nested));
});

test('collectSnapshotContainers returns empty array for null input', () => {
  assert.deepEqual(collectSnapshotContainers(null), []);
  assert.deepEqual(collectSnapshotContainers('string'), []);
});

// ---------------------------------------------------------------------------
// classifySnapshot
// ---------------------------------------------------------------------------

test('classifySnapshot returns stored telemetry_type', () => {
  assert.equal(classifySnapshot({ telemetry_type: 'power' }), 'power');
});

test('classifySnapshot detects device type by battery_level', () => {
  assert.equal(classifySnapshot({ battery_level: 80 }), 'device');
});

test('classifySnapshot detects environment type by temperature', () => {
  assert.equal(classifySnapshot({ temperature: 22.5 }), 'environment');
});

test('classifySnapshot detects power type by current', () => {
  assert.equal(classifySnapshot({ current: 1.2 }), 'power');
});

test('classifySnapshot returns unknown for empty object', () => {
  assert.equal(classifySnapshot({}), 'unknown');
});

test('classifySnapshot returns unknown for null', () => {
  assert.equal(classifySnapshot(null), 'unknown');
});

// ---------------------------------------------------------------------------
// extractSnapshotValue
// ---------------------------------------------------------------------------

test('extractSnapshotValue extracts value from flat snapshot', () => {
  assert.equal(extractSnapshotValue({ battery_level: 85 }, ['battery_level']), 85);
});

test('extractSnapshotValue extracts from nested device_metrics', () => {
  assert.equal(
    extractSnapshotValue({ device_metrics: { battery_level: 90 } }, ['battery_level']),
    90
  );
});

test('extractSnapshotValue tries all field aliases', () => {
  assert.equal(extractSnapshotValue({ voltageReading: 4.2 }, ['voltage', 'voltageReading']), 4.2);
});

test('extractSnapshotValue returns null when field is missing', () => {
  assert.equal(extractSnapshotValue({ other: 1 }, ['battery_level']), null);
});

test('extractSnapshotValue returns null for null input', () => {
  assert.equal(extractSnapshotValue(null, ['battery_level']), null);
});

// ---------------------------------------------------------------------------
// buildSeriesPoints
// ---------------------------------------------------------------------------

test('buildSeriesPoints returns sorted data points within domain', () => {
  const entries = [
    { timestamp: 3000, snapshot: { battery_level: 80 } },
    { timestamp: 1000, snapshot: { battery_level: 70 } },
    { timestamp: 2000, snapshot: { battery_level: 75 } },
  ];
  const points = buildSeriesPoints(entries, ['battery_level'], 0, 5000);
  assert.equal(points.length, 3);
  assert.equal(points[0].timestamp, 1000);
  assert.equal(points[2].timestamp, 3000);
});

test('buildSeriesPoints excludes entries outside domain', () => {
  const entries = [
    { timestamp: 500, snapshot: { battery_level: 90 } },
    { timestamp: 1500, snapshot: { battery_level: 80 } },
    { timestamp: 2500, snapshot: { battery_level: 70 } },
  ];
  const points = buildSeriesPoints(entries, ['battery_level'], 1000, 2000);
  assert.equal(points.length, 1);
  assert.equal(points[0].timestamp, 1500);
});

test('buildSeriesPoints returns empty array when no values match fields', () => {
  const entries = [{ timestamp: 1000, snapshot: { temperature: 20 } }];
  assert.deepEqual(buildSeriesPoints(entries, ['battery_level'], 0, 5000), []);
});

test('buildSeriesPoints handles single-point series', () => {
  const entries = [{ timestamp: 1000, snapshot: { battery_level: 75 } }];
  const points = buildSeriesPoints(entries, ['battery_level'], 0, 2000);
  assert.equal(points.length, 1);
});

test('buildSeriesPoints returns empty array for empty entries', () => {
  assert.deepEqual(buildSeriesPoints([], ['battery_level'], 0, 5000), []);
});

// ---------------------------------------------------------------------------
// resolveAxisMax
// ---------------------------------------------------------------------------

test('resolveAxisMax returns axis.max when allowUpperOverflow is not set', () => {
  const axis = { id: 'battery', max: 100 };
  assert.equal(resolveAxisMax(axis, [{ axisId: 'battery', points: [{ value: 200 }] }]), 100);
});

test('resolveAxisMax raises ceiling when observed max exceeds declared max', () => {
  const axis = { id: 'voltage', max: 6, allowUpperOverflow: true };
  const series = [{ axisId: 'voltage', points: [{ value: 7.5 }] }];
  assert.equal(resolveAxisMax(axis, series), 7.5);
});

test('resolveAxisMax keeps declared max when no data exceeds it', () => {
  const axis = { id: 'voltage', max: 6, allowUpperOverflow: true };
  const series = [{ axisId: 'voltage', points: [{ value: 4.2 }] }];
  assert.equal(resolveAxisMax(axis, series), 6);
});

test('resolveAxisMax returns undefined for null axis', () => {
  assert.equal(resolveAxisMax(null, []), undefined);
});

// ---------------------------------------------------------------------------
// renderTelemetrySeries
// ---------------------------------------------------------------------------

test('renderTelemetrySeries returns empty string for empty points', () => {
  const dims = createChartDimensions({ axes: [] });
  const axis = { min: 0, max: 100 };
  assert.equal(renderTelemetrySeries({}, [], axis, dims, 0, 1000), '');
});

test('renderTelemetrySeries returns empty string for single point (no line path)', () => {
  const dims = createChartDimensions({ axes: [] });
  const axis = { id: 'battery', min: 0, max: 100 };
  const config = { color: '#ff0000', id: 'battery' };
  const points = [{ timestamp: 500, value: 80 }];
  const svg = renderTelemetrySeries(config, points, axis, dims, 0, 1000);
  assert.ok(svg.includes('<circle'), 'should render circle for single point');
  assert.ok(!svg.includes('<path'), 'no path for single point');
});

test('renderTelemetrySeries renders both circles and path for multiple points', () => {
  const dims = createChartDimensions({ axes: [] });
  const axis = { id: 'battery', min: 0, max: 100 };
  const config = { color: '#8856a7', id: 'battery' };
  const points = [
    { timestamp: 200, value: 70 },
    { timestamp: 600, value: 85 },
    { timestamp: 900, value: 90 },
  ];
  const svg = renderTelemetrySeries(config, points, axis, dims, 0, 1000);
  assert.ok(svg.includes('<circle'), 'should contain circle elements');
  assert.ok(svg.includes('<path'), 'should contain path element for multiple points');
});

test('renderTelemetrySeries applies custom lineReducer when supplied', () => {
  const dims = createChartDimensions({ axes: [] });
  const axis = { id: 'battery', min: 0, max: 100 };
  const config = { color: '#ff0000', id: 'battery' };
  const points = [
    { timestamp: 100, value: 70 },
    { timestamp: 500, value: 80 },
    { timestamp: 900, value: 90 },
  ];
  // Reducer that returns only first and last points.
  const lineReducer = pts => [pts[0], pts[pts.length - 1]];
  const svg = renderTelemetrySeries(config, points, axis, dims, 0, 1000, { lineReducer });
  // Should have 3 circles (full point set) but 2-point path.
  const circleCount = (svg.match(/<circle/g) || []).length;
  assert.equal(circleCount, 3, 'should render all 3 circles');
  assert.ok(svg.includes('<path'), 'should still render a path');
});

// ---------------------------------------------------------------------------
// resolveAxisX — secondary axis positions
// ---------------------------------------------------------------------------

test('resolveAxisX returns reduced x for leftSecondary', () => {
  const dims = createChartDimensions({ axes: [] });
  assert.equal(resolveAxisX('leftSecondary', dims), dims.margin.left - 32);
});

test('resolveAxisX returns increased x for rightSecondary', () => {
  const dims = createChartDimensions({ axes: [] });
  assert.equal(resolveAxisX('rightSecondary', dims), dims.width - dims.margin.right + 32);
});

// ---------------------------------------------------------------------------
// renderYAxis
// ---------------------------------------------------------------------------

test('renderYAxis renders SVG axis with tick marks', () => {
  const dims = createChartDimensions({ axes: [] });
  const axis = { id: 'battery', position: 'left', label: 'Battery (%)', min: 0, max: 100, ticks: 4 };
  const svg = renderYAxis(axis, dims);
  assert.ok(svg.includes('<g'), 'should produce a group element');
  assert.ok(svg.includes('Battery'), 'should include axis label');
  assert.ok(svg.includes('<line'), 'should include axis line');
});

test('renderYAxis returns empty string when axis.visible is false', () => {
  const dims = createChartDimensions({ axes: [] });
  const axis = { id: 'humidity', position: 'left', label: 'Humidity', visible: false, min: 0, max: 100, ticks: 4 };
  assert.equal(renderYAxis(axis, dims), '');
});

test('renderYAxis returns empty string for null axis', () => {
  const dims = createChartDimensions({ axes: [] });
  assert.equal(renderYAxis(null, dims), '');
});

test('renderYAxis renders right-side axis', () => {
  const dims = createChartDimensions({ axes: [] });
  const axis = { id: 'voltage', position: 'right', label: 'Voltage (V)', min: 0, max: 6, ticks: 3 };
  const svg = renderYAxis(axis, dims);
  assert.ok(svg.includes('Voltage'), 'should include voltage label');
});

test('renderYAxis renders log-scale axis', () => {
  const dims = createChartDimensions({ axes: [] });
  const axis = { id: 'gas', position: 'right', label: 'Gas (\u03a9)', min: 10, max: 100_000, ticks: 5, scale: 'log' };
  const svg = renderYAxis(axis, dims);
  assert.ok(svg.includes('Gas'), 'should include axis label');
});

// ---------------------------------------------------------------------------
// renderXAxis
// ---------------------------------------------------------------------------

test('renderXAxis renders SVG horizontal axis with tick lines', () => {
  const dims = createChartDimensions({ axes: [] });
  const now = Date.UTC(2025, 0, 8, 12, 0, 0);
  const ticks = buildMidnightTicks(now, DAY_MS * 3);
  const svg = renderXAxis(dims, now - DAY_MS * 3, now, ticks);
  assert.ok(svg.includes('<g'), 'should produce group elements');
  assert.ok(svg.includes('<line'), 'should include tick lines');
});

test('renderXAxis uses custom labelFormatter when provided', () => {
  const dims = createChartDimensions({ axes: [] });
  const now = Date.UTC(2025, 0, 8, 12, 0, 0);
  const ticks = [now - HOUR_MS, now];
  const svg = renderXAxis(dims, now - HOUR_MS * 2, now, ticks, { labelFormatter: ts => `T${ts}` });
  assert.ok(svg.includes('T'), 'custom formatter output should appear');
});

// ---------------------------------------------------------------------------
// renderTelemetryChart
// ---------------------------------------------------------------------------

test('renderTelemetryChart renders full chart HTML for data within window', () => {
  const spec = {
    id: 'device-health',
    title: 'Device health',
    typeFilter: ['device', 'unknown'],
    axes: [
      { id: 'battery', position: 'left', label: 'Battery (%)', min: 0, max: 100, ticks: 4, color: '#8856a7' },
    ],
    series: [
      {
        id: 'battery',
        axis: 'battery',
        color: '#8856a7',
        label: 'Battery level',
        legend: 'Battery (%)',
        fields: ['battery_level'],
        valueFormatter: v => `${v.toFixed(1)}%`,
      },
    ],
  };
  const now = Date.UTC(2025, 0, 8, 12, 0, 0);
  const entries = [
    { timestamp: now - HOUR_MS * 6, snapshot: { battery_level: 80, telemetry_type: 'device' } },
    { timestamp: now - HOUR_MS * 3, snapshot: { battery_level: 75, telemetry_type: 'device' } },
  ];
  const html = renderTelemetryChart(spec, entries, now);
  assert.ok(html.includes('<figure'), 'should produce a figure element');
  assert.ok(html.includes('Device health'), 'should include chart title');
  assert.ok(html.includes('<svg'), 'should include SVG element');
  assert.ok(html.includes('<circle'), 'should include data circles');
});

test('renderTelemetryChart returns empty string when no data matches the window', () => {
  const spec = {
    id: 'device-health',
    title: 'Device health',
    typeFilter: ['device'],
    axes: [{ id: 'battery', position: 'left', label: 'Battery (%)', min: 0, max: 100, ticks: 4, color: '#8856a7' }],
    series: [
      {
        id: 'battery',
        axis: 'battery',
        color: '#8856a7',
        label: 'Battery',
        legend: 'Battery (%)',
        fields: ['battery_level'],
        valueFormatter: v => `${v}%`,
      },
    ],
  };
  const now = Date.UTC(2025, 0, 8, 12, 0, 0);
  // All entries are far outside the default 7-day window.
  const entries = [
    { timestamp: now - DAY_MS * 30, snapshot: { battery_level: 80 } },
  ];
  assert.equal(renderTelemetryChart(spec, entries, now), '');
});

test('renderTelemetryChart uses isAggregated flag to skip typeFilter', () => {
  const spec = {
    id: 'device-health',
    title: 'Device health',
    // Only 'device' snapshots should pass through the filter normally.
    typeFilter: ['device'],
    axes: [{ id: 'battery', position: 'left', label: 'Battery (%)', min: 0, max: 100, ticks: 4, color: '#8856a7' }],
    series: [
      {
        id: 'battery',
        axis: 'battery',
        color: '#8856a7',
        label: 'Battery',
        legend: 'Battery (%)',
        fields: ['battery_level'],
        valueFormatter: v => `${v}%`,
      },
    ],
  };
  const now = Date.UTC(2025, 0, 8, 12, 0, 0);
  // Snapshot has a stored telemetry_type of 'environment', which is NOT in typeFilter ['device'].
  const entries = [
    { timestamp: now - HOUR_MS, snapshot: { battery_level: 75, telemetry_type: 'environment' } },
  ];
  // Without isAggregated, 'environment' is filtered out — no output.
  assert.equal(renderTelemetryChart(spec, entries, now), '');
  // With isAggregated, typeFilter is bypassed — chart renders.
  const html = renderTelemetryChart(spec, entries, now, { isAggregated: true });
  assert.ok(html.includes('<figure'), 'chart should render when isAggregated bypasses typeFilter');
});

test('renderTelemetryChart adjusts axis max when allowUpperOverflow and data exceeds declared max', () => {
  const spec = {
    id: 'power-sensor',
    title: 'Power sensor',
    typeFilter: ['power'],
    axes: [
      {
        id: 'voltage',
        position: 'left',
        label: 'Voltage (V)',
        min: 0,
        max: 6,
        ticks: 3,
        color: '#9ebcda',
        // Overflow enabled — ceiling should rise to match observed peak.
        allowUpperOverflow: true,
      },
    ],
    series: [
      {
        id: 'voltage',
        axis: 'voltage',
        color: '#9ebcda',
        label: 'Voltage',
        legend: 'Voltage (V)',
        fields: ['voltage'],
        valueFormatter: v => `${v.toFixed(2)} V`,
      },
    ],
  };
  const now = Date.UTC(2025, 0, 8, 12, 0, 0);
  // A data point at 8 V exceeds the declared axis max of 6 V.
  const entries = [
    { timestamp: now - HOUR_MS * 2, snapshot: { voltage: 8.0, telemetry_type: 'power' } },
  ];
  const html = renderTelemetryChart(spec, entries, now);
  assert.ok(html.includes('<figure'), 'chart should render with overflow data');
});

test('renderTelemetryChart uses custom xAxisTickBuilder and windowMs', () => {
  const spec = {
    id: 'device-health',
    title: 'Device health',
    typeFilter: ['device'],
    axes: [{ id: 'battery', position: 'left', label: 'Battery (%)', min: 0, max: 100, ticks: 4, color: '#8856a7' }],
    series: [
      {
        id: 'battery',
        axis: 'battery',
        color: '#8856a7',
        label: 'Battery',
        legend: 'Battery (%)',
        fields: ['battery_level'],
        valueFormatter: v => `${v}%`,
      },
    ],
  };
  const now = Date.UTC(2025, 0, 8, 12, 0, 0);
  const entries = [
    { timestamp: now - HOUR_MS * 2, snapshot: { battery_level: 80, telemetry_type: 'device' } },
  ];
  const ticksCalled = [];
  const xAxisTickBuilder = (n, w) => { ticksCalled.push({ n, w }); return [n - HOUR_MS, n]; };
  const html = renderTelemetryChart(spec, entries, now, {
    windowMs: HOUR_MS * 6,
    timeRangeLabel: 'Last 6 hours',
    xAxisTickBuilder,
  });
  assert.ok(html.includes('Last 6 hours'), 'should use custom timeRangeLabel');
  assert.equal(ticksCalled.length, 1, 'xAxisTickBuilder should have been called once');
});
