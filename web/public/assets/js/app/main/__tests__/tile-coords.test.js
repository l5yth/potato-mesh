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

import { tileToLat, tileToLon } from '../tile-coords.js';

test('tileToLon zero tile at zoom 0 is -180', () => {
  assert.equal(tileToLon(0, 0), -180);
});

test('tileToLon centre tile at zoom 1 is 0', () => {
  assert.equal(tileToLon(1, 1), 0);
});

test('tileToLon last tile at zoom 2 is 90', () => {
  assert.equal(tileToLon(3, 2), 90);
});

test('tileToLat zero tile at zoom 0 is roughly 85.0511', () => {
  // Mercator clamp: northernmost projectable latitude.
  assert.ok(Math.abs(tileToLat(0, 0) - 85.0511287798066) < 1e-9);
});

test('tileToLat centre tile at zoom 1 is 0', () => {
  assert.equal(tileToLat(1, 1), 0);
});

test('tileToLat is symmetric around the equator at zoom 1', () => {
  // Tile y=0 (northern edge) and y=2 (southern edge) at zoom 1 should
  // be equal in magnitude with opposite signs.
  const north = tileToLat(0, 1);
  const south = tileToLat(2, 1);
  assert.ok(Math.abs(north + south) < 1e-9);
});
