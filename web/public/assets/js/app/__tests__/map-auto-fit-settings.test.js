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

import { resolveAutoFitBoundsConfig, __testUtils } from '../map-auto-fit-settings.js';

const { MINIMUM_AUTO_FIT_RANGE_KM, AUTO_FIT_PADDING_FRACTION } = __testUtils;

test('resolveAutoFitBoundsConfig returns defaults without a distance limit', () => {
  const config = resolveAutoFitBoundsConfig({ hasDistanceLimit: false, maxDistanceKm: null });
  assert.equal(config.paddingFraction, AUTO_FIT_PADDING_FRACTION);
  assert.equal(config.minimumRangeKm, MINIMUM_AUTO_FIT_RANGE_KM);
});

test('resolveAutoFitBoundsConfig constrains minimum range by the limit radius', () => {
  const config = resolveAutoFitBoundsConfig({ hasDistanceLimit: true, maxDistanceKm: 2 });
  assert.equal(config.paddingFraction, AUTO_FIT_PADDING_FRACTION);
  assert.ok(config.minimumRangeKm >= MINIMUM_AUTO_FIT_RANGE_KM);
  assert.ok(config.minimumRangeKm <= 2);
});

test('resolveAutoFitBoundsConfig respects small distance limits', () => {
  const config = resolveAutoFitBoundsConfig({ hasDistanceLimit: true, maxDistanceKm: 0.1 });
  assert.equal(config.paddingFraction, AUTO_FIT_PADDING_FRACTION);
  assert.equal(config.minimumRangeKm, 0.1);
});

test('resolveAutoFitBoundsConfig tolerates invalid input', () => {
  const config = resolveAutoFitBoundsConfig({ hasDistanceLimit: true, maxDistanceKm: -5 });
  assert.equal(config.paddingFraction, AUTO_FIT_PADDING_FRACTION);
  assert.equal(config.minimumRangeKm, MINIMUM_AUTO_FIT_RANGE_KM);
});
