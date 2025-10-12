/*
 * Copyright (C) 2025 l5yth
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
  computeBoundingBox,
  computeBoundsForPoints,
  haversineDistanceKm,
  __testUtils
} from '../map-bounds.js';

const { clampLatitude, clampLongitude, normaliseRange } = __testUtils;

function approximatelyEqual(actual, expected, epsilon = 1e-3) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

test('clamp helpers bound invalid coordinates', () => {
  assert.equal(clampLatitude(120), 90);
  assert.equal(clampLatitude(-95), -90);
  assert.equal(clampLatitude(Number.POSITIVE_INFINITY), 90);
  assert.equal(clampLatitude(Number.NEGATIVE_INFINITY), -90);

  assert.equal(clampLongitude(200), 180);
  assert.equal(clampLongitude(-220), -180);
  assert.equal(clampLongitude(Number.POSITIVE_INFINITY), 180);
  assert.equal(clampLongitude(Number.NEGATIVE_INFINITY), -180);
});


test('normaliseRange enforces minimum distance for invalid inputs', () => {
  assert.equal(normaliseRange(-1, 2), 2);
  assert.equal(normaliseRange(Number.NaN, 3), 3);
  assert.equal(normaliseRange(0, 1), 1);
  assert.equal(normaliseRange(4, 2), 4);
});


test('computeBoundingBox returns null for invalid centres', () => {
  assert.equal(computeBoundingBox(null, 10), null);
  assert.equal(computeBoundingBox({ lat: 'x', lon: 0 }, 5), null);
  assert.equal(computeBoundingBox({ lat: 0, lon: NaN }, 5), null);
});


test('computeBoundingBox returns symmetric bounds for mid-latitude centre', () => {
  const bounds = computeBoundingBox({ lat: 0, lon: 0 }, 10);
  assert.ok(bounds);
  const [[south, west], [north, east]] = bounds;
  approximatelyEqual(north, -south, 1e-4);
  approximatelyEqual(east, -west, 1e-4);
  assert.ok(north > 0 && east > 0);
});


test('computeBoundingBox clamps longitude span near the poles', () => {
  const bounds = computeBoundingBox({ lat: 89.9, lon: 45 }, 2000);
  assert.ok(bounds);
  const [[south, west], [north, east]] = bounds;
  approximatelyEqual(south, 72.0, 1e-1);
  assert.equal(west, -180);
  assert.equal(east, 180);
  assert.equal(north, 90);
});


test('haversineDistanceKm matches known city distance', () => {
  // Approximate distance between Paris (48.8566, 2.3522) and Berlin (52.52, 13.4050)
  const distance = haversineDistanceKm(48.8566, 2.3522, 52.52, 13.405);
  approximatelyEqual(distance, 878.8, 2);
});


test('computeBoundsForPoints returns null when no valid points exist', () => {
  assert.equal(computeBoundsForPoints([]), null);
  assert.equal(computeBoundsForPoints([[Number.NaN, 0]]), null);
});


test('computeBoundsForPoints expands bounds with padding and minimum radius', () => {
  const bounds = computeBoundsForPoints(
    [
      [38.0, -27.1],
      [38.05, -27.08]
    ],
    { paddingFraction: 0.2, minimumRangeKm: 2 }
  );
  assert.ok(bounds);
  const [[south, west], [north, east]] = bounds;
  assert.ok(north > 38.05);
  assert.ok(south < 38.0);
  assert.ok(east > -27.08);
  assert.ok(west < -27.1);
});


test('computeBoundsForPoints respects the configured minimum range for single points', () => {
  const bounds = computeBoundsForPoints([[12.34, 56.78]], { minimumRangeKm: 5 });
  assert.ok(bounds);
  const [[south], [north]] = bounds;
  assert.ok(north - south > 0.05);
});
