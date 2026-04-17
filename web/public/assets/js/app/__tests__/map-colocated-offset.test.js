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
  buildRenderableEntries,
  computeColocatedOffsets,
  isOffsetSignificant,
  refreshSpiderPositions,
  __testUtils
} from '../map-colocated-offset.js';

const {
  DEFAULT_PRECISION,
  DEFAULT_BASE_RADIUS_PX,
  DEFAULT_RADIUS_GROWTH_PX,
  MAX_PRECISION,
  OFFSET_EPSILON_PX,
  coordinateKey,
  normalisePrecision,
  normalisePositive
} = __testUtils;

/**
 * Build a canonical entry shape for tests.
 *
 * @param {string} id Node identifier used for stable ordering.
 * @param {number} lat Latitude in degrees.
 * @param {number} lon Longitude in degrees.
 * @returns {{node: {node_id: string}, lat: number, lon: number}} Entry record.
 */
function makeEntry(id, lat, lon) {
  return { node: { node_id: id }, lat, lon };
}

/**
 * Assert that two floating-point numbers are within a small epsilon.
 *
 * @param {number} actual Observed value.
 * @param {number} expected Reference value.
 * @param {number} [epsilon=1e-9] Permitted absolute difference.
 * @returns {void}
 */
function approximatelyEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${actual} is not within ${epsilon} of ${expected}`
  );
}

test('returns empty array for empty/invalid input', () => {
  assert.deepEqual(computeColocatedOffsets([]), []);
  assert.deepEqual(computeColocatedOffsets(null), []);
  assert.deepEqual(computeColocatedOffsets(undefined), []);
  assert.deepEqual(computeColocatedOffsets('not-an-array'), []);
});

test('singleton group passes through with zero offset', () => {
  const entries = [makeEntry('a', 52.5, 13.4)];
  const result = computeColocatedOffsets(entries);
  assert.equal(result.length, 1);
  assert.equal(result[0].entry, entries[0]);
  assert.equal(result[0].dx, 0);
  assert.equal(result[0].dy, 0);
});

test('two co-located entries get opposite offsets at base radius', () => {
  const entries = [makeEntry('a', 1.23456, 4.56789), makeEntry('b', 1.23456, 4.56789)];
  const result = computeColocatedOffsets(entries);
  assert.equal(result.length, 2);
  for (const slot of result) {
    const magnitude = Math.hypot(slot.dx, slot.dy);
    approximatelyEqual(magnitude, DEFAULT_BASE_RADIUS_PX);
  }
  // Two slots, 180° apart → dx values are negatives of each other (and dy too).
  approximatelyEqual(result[0].dx + result[1].dx, 0);
  approximatelyEqual(result[0].dy + result[1].dy, 0);
});

test('three+ co-located entries are evenly spaced on a single circle', () => {
  const entries = [
    makeEntry('a', 10, 20),
    makeEntry('b', 10, 20),
    makeEntry('c', 10, 20)
  ];
  const result = computeColocatedOffsets(entries);
  // Group of 3 → radius grows by one growth step beyond the base ring.
  const expectedRadius = DEFAULT_BASE_RADIUS_PX + DEFAULT_RADIUS_GROWTH_PX;
  for (const slot of result) {
    approximatelyEqual(Math.hypot(slot.dx, slot.dy), expectedRadius);
  }
  // Sum of vectors at evenly spaced angles should cancel to (≈0, ≈0).
  const sumX = result.reduce((acc, slot) => acc + slot.dx, 0);
  const sumY = result.reduce((acc, slot) => acc + slot.dy, 0);
  approximatelyEqual(sumX, 0, 1e-9);
  approximatelyEqual(sumY, 0, 1e-9);
});

test('groups of five or more grow the offset radius by radiusGrowthPx per extra node', () => {
  const entries = [];
  for (let i = 0; i < 5; i += 1) {
    entries.push(makeEntry(`n${i}`, 0, 0));
  }
  const result = computeColocatedOffsets(entries);
  const expectedRadius = DEFAULT_BASE_RADIUS_PX + DEFAULT_RADIUS_GROWTH_PX * 3;
  for (const slot of result) {
    approximatelyEqual(Math.hypot(slot.dx, slot.dy), expectedRadius);
  }
});

test('entries at distinct coordinates are not offset', () => {
  const entries = [
    makeEntry('a', 10, 20),
    makeEntry('b', 11, 20),
    makeEntry('c', 10, 21)
  ];
  const result = computeColocatedOffsets(entries);
  for (const slot of result) {
    assert.equal(slot.dx, 0);
    assert.equal(slot.dy, 0);
  }
});

test('precision option controls bucket granularity', () => {
  const closeEntries = [makeEntry('a', 1.000001, 2.000001), makeEntry('b', 1.000002, 2.000002)];
  const closeResult = computeColocatedOffsets(closeEntries);
  // At default precision (5dp) these round to identical keys → both offset.
  assert.notEqual(closeResult[0].dx, 0);
  assert.notEqual(closeResult[1].dx, 0);

  const farEntries = [makeEntry('a', 1.0001, 2.0001), makeEntry('b', 1.0009, 2.0001)];
  const farResult = computeColocatedOffsets(farEntries);
  // At default precision the 4th decimal differs → distinct buckets, no offset.
  for (const slot of farResult) {
    assert.equal(slot.dx, 0);
    assert.equal(slot.dy, 0);
  }
});

test('custom baseRadiusPx and radiusGrowthPx override defaults', () => {
  const entries = [
    makeEntry('a', 0, 0),
    makeEntry('b', 0, 0),
    makeEntry('c', 0, 0),
    makeEntry('d', 0, 0)
  ];
  const result = computeColocatedOffsets(entries, { baseRadiusPx: 20, radiusGrowthPx: 10 });
  // 4 entries → radius = 20 + 10 * (4 - 2) = 40.
  for (const slot of result) {
    approximatelyEqual(Math.hypot(slot.dx, slot.dy), 40);
  }
});

test('custom precision overrides default bucketing', () => {
  // At precision=5 these are distinct buckets (no offset); at precision=2
  // both round to "1.00,2.00" and merge into a single co-located group.
  const entries = [makeEntry('a', 1.001, 2.001), makeEntry('b', 1.004, 2.004)];
  const defaultResult = computeColocatedOffsets(entries);
  for (const slot of defaultResult) {
    assert.equal(slot.dx, 0);
    assert.equal(slot.dy, 0);
  }
  const coarseResult = computeColocatedOffsets(entries, { precision: 2 });
  assert.notEqual(coarseResult[0].dx, 0);
  assert.notEqual(coarseResult[1].dx, 0);
});

test('invalid option values fall back to defaults', () => {
  // NaN / negative values must not corrupt geometry — fall back to defaults.
  const entries = [makeEntry('a', 0, 0), makeEntry('b', 0, 0)];
  const result = computeColocatedOffsets(entries, {
    baseRadiusPx: Number.NaN,
    radiusGrowthPx: -3,
    precision: -1
  });
  for (const slot of result) {
    approximatelyEqual(Math.hypot(slot.dx, slot.dy), DEFAULT_BASE_RADIUS_PX);
  }
});

test('angular slot assignment is stable across input shuffles', () => {
  const baseA = makeEntry('a', 5, 5);
  const baseB = makeEntry('b', 5, 5);
  const baseC = makeEntry('c', 5, 5);
  const orderedResult = computeColocatedOffsets([baseA, baseB, baseC]);
  const shuffledResult = computeColocatedOffsets([baseC, baseA, baseB]);
  // Build a node_id → offset map for both calls and ensure they match.
  const orderedOffsets = new Map(orderedResult.map(slot => [slot.entry.node.node_id, slot]));
  const shuffledOffsets = new Map(shuffledResult.map(slot => [slot.entry.node.node_id, slot]));
  for (const id of ['a', 'b', 'c']) {
    approximatelyEqual(orderedOffsets.get(id).dx, shuffledOffsets.get(id).dx);
    approximatelyEqual(orderedOffsets.get(id).dy, shuffledOffsets.get(id).dy);
  }
});

test('result order matches input order', () => {
  const entries = [
    makeEntry('z', 1, 1),
    makeEntry('a', 0, 0),
    makeEntry('m', 1, 1),
    makeEntry('b', 0, 0)
  ];
  const result = computeColocatedOffsets(entries);
  assert.equal(result.length, entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    assert.equal(result[i].entry, entries[i]);
  }
});

test('entries without node_id still receive deterministic slots', () => {
  // Missing node_id falls back to '' in the comparator — ensure no exception
  // is thrown and both entries still get base-radius offsets.
  const entries = [
    { node: {}, lat: 0, lon: 0 },
    { node: null, lat: 0, lon: 0 }
  ];
  const result = computeColocatedOffsets(entries);
  for (const slot of result) {
    approximatelyEqual(Math.hypot(slot.dx, slot.dy), DEFAULT_BASE_RADIUS_PX);
  }
});

test('coordinateKey formats lat/lon at requested precision', () => {
  assert.equal(coordinateKey(1.234567, 7.654321, 3), '1.235,7.654');
  assert.equal(coordinateKey(0, 0, DEFAULT_PRECISION), '0.00000,0.00000');
});

test('normalisePrecision sanitises invalid inputs', () => {
  assert.equal(normalisePrecision(3), 3);
  assert.equal(normalisePrecision(0), 0);
  assert.equal(normalisePrecision(2.7), 2);
  assert.equal(normalisePrecision(-1), DEFAULT_PRECISION);
  assert.equal(normalisePrecision(Number.NaN), DEFAULT_PRECISION);
  // Above MAX_PRECISION the value is clamped so toFixed cannot throw.
  assert.equal(normalisePrecision(MAX_PRECISION + 50), MAX_PRECISION);
  assert.doesNotThrow(() => (0).toFixed(normalisePrecision(1e6)));
});

test('entries sharing identical node_id fall back to input index for ordering', () => {
  // Repeated calls with the same input must produce identical offsets even
  // when ids tie — the secondary index tie-break makes this independent of
  // the host engine's sort stability guarantees.
  const entries = [
    { node: { node_id: 'dup' }, lat: 0, lon: 0 },
    { node: { node_id: 'dup' }, lat: 0, lon: 0 },
    { node: { node_id: 'dup' }, lat: 0, lon: 0 }
  ];
  const first = computeColocatedOffsets(entries);
  const second = computeColocatedOffsets(entries);
  for (let i = 0; i < entries.length; i += 1) {
    approximatelyEqual(first[i].dx, second[i].dx);
    approximatelyEqual(first[i].dy, second[i].dy);
  }
  // The first entry by index should land at angle 0 (dy ≈ 0, dx > 0).
  approximatelyEqual(first[0].dy, 0);
  assert.ok(first[0].dx > 0);
});

test('normalisePositive sanitises invalid inputs', () => {
  assert.equal(normalisePositive(5, 10), 5);
  assert.equal(normalisePositive(0, 10), 0);
  assert.equal(normalisePositive(-1, 10), 10);
  assert.equal(normalisePositive(Number.NaN, 10), 10);
});

test('buildRenderableEntries returns empty for null/undefined/non-iterable input', () => {
  assert.deepEqual(buildRenderableEntries(null), []);
  assert.deepEqual(buildRenderableEntries(undefined), []);
  assert.deepEqual(buildRenderableEntries(42), []);
  assert.deepEqual(buildRenderableEntries('string'), []);
});

test('buildRenderableEntries parses lat/lon and skips invalid nodes', () => {
  const nodes = [
    { latitude: '10', longitude: '20' },
    null,
    { latitude: null, longitude: '5' },
    { latitude: '', longitude: '' },
    { latitude: 'NaN', longitude: '3' },
    { latitude: 30, longitude: 40 }
  ];
  const result = buildRenderableEntries(nodes);
  assert.equal(result.length, 2);
  assert.equal(result[0].lat, 10);
  assert.equal(result[0].lon, 20);
  assert.equal(result[0].node, nodes[0]);
  assert.equal(result[1].lat, 30);
  assert.equal(result[1].lon, 40);
  assert.equal(result[1].node, nodes[5]);
});

test('buildRenderableEntries respects maxDistanceKm', () => {
  const nodes = [
    { latitude: 1, longitude: 2, distance_km: 5 },
    { latitude: 3, longitude: 4, distance_km: 15 },
    { latitude: 5, longitude: 6 } // no distance → always included
  ];
  const result = buildRenderableEntries(nodes, { maxDistanceKm: 10 });
  assert.equal(result.length, 2);
  assert.equal(result[0].lat, 1);
  assert.equal(result[1].lat, 5);
});

test('buildRenderableEntries ignores maxDistanceKm when zero/negative/non-finite', () => {
  const nodes = [
    { latitude: 1, longitude: 2, distance_km: 1000 }
  ];
  assert.equal(buildRenderableEntries(nodes, { maxDistanceKm: 0 }).length, 1);
  assert.equal(buildRenderableEntries(nodes, { maxDistanceKm: -5 }).length, 1);
  assert.equal(buildRenderableEntries(nodes, { maxDistanceKm: NaN }).length, 1);
  assert.equal(buildRenderableEntries(nodes).length, 1);
});

test('isOffsetSignificant reports true for real offsets and false near zero', () => {
  // Strict equality would treat radius * sin(π) (~1.7e-15) as non-zero;
  // the hypotenuse-based check rejects values below OFFSET_EPSILON_PX.
  assert.equal(isOffsetSignificant(0, 0), false);
  assert.equal(isOffsetSignificant(OFFSET_EPSILON_PX / 2, OFFSET_EPSILON_PX / 2), false);
  assert.equal(isOffsetSignificant(14, 0), true);
  assert.equal(isOffsetSignificant(0, -14), true);
  assert.equal(isOffsetSignificant(14 * Math.cos(Math.PI), 14 * Math.sin(Math.PI)), true);
});

test('refreshSpiderPositions ignores empty / non-array / missing-projector input', () => {
  // Should not throw and should not mutate anything when there is no work
  // to do.  The marker stub asserts `setLatLng` is never invoked.
  let setLatLngCalls = 0;
  const stubMarker = { setLatLng() { setLatLngCalls += 1; } };
  refreshSpiderPositions([], () => [0, 0]);
  refreshSpiderPositions(null, () => [0, 0]);
  refreshSpiderPositions([{ marker: stubMarker, lat: 0, lon: 0, dx: 1, dy: 1 }], null);
  refreshSpiderPositions([{ marker: stubMarker, lat: 0, lon: 0, dx: 1, dy: 1 }], 'not-a-fn');
  assert.equal(setLatLngCalls, 0);
});

test('refreshSpiderPositions invokes projector and updates marker + line', () => {
  const projectorCalls = [];
  const project = (lat, lon, dx, dy) => {
    projectorCalls.push([lat, lon, dx, dy]);
    return [lat + dx / 1000, lon + dy / 1000];
  };
  const markerCalls = [];
  const lineCalls = [];
  const state = [
    {
      marker: { setLatLng(latLng) { markerCalls.push(latLng); } },
      line: { setLatLngs(latLngs) { lineCalls.push(latLngs); } },
      lat: 10,
      lon: 20,
      dx: 5,
      dy: -7
    }
  ];
  refreshSpiderPositions(state, project);
  assert.deepEqual(projectorCalls, [[10, 20, 5, -7]]);
  assert.deepEqual(markerCalls, [[10.005, 19.993]]);
  assert.deepEqual(lineCalls, [[[10, 20], [10.005, 19.993]]]);
});

test('refreshSpiderPositions tolerates missing marker / line / item', () => {
  // The renderer may legitimately skip the spider line for some entries
  // (e.g. when spiderLinesLayer is absent at init time).  The helper must
  // not throw when `marker` or `line` is missing or lacks the expected
  // setter, and must skip falsy entries entirely.
  const sink = [];
  const state = [
    null,
    { lat: 0, lon: 0, dx: 1, dy: 1 }, // no marker, no line
    { marker: {}, line: {}, lat: 0, lon: 0, dx: 1, dy: 1 }, // wrong shape
    {
      marker: { setLatLng(value) { sink.push(['marker', value]); } },
      line: null,
      lat: 1,
      lon: 2,
      dx: 3,
      dy: 4
    },
    {
      marker: null,
      line: { setLatLngs(value) { sink.push(['line', value]); } },
      lat: 5,
      lon: 6,
      dx: 7,
      dy: 8
    }
  ];
  assert.doesNotThrow(() => refreshSpiderPositions(state, (lat, lon) => [lat, lon]));
  assert.deepEqual(sink, [
    ['marker', [1, 2]],
    ['line', [[5, 6], [5, 6]]]
  ]);
});
