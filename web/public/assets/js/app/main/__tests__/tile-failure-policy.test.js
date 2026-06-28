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

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTileFailurePolicy,
  DEFAULT_ERROR_THRESHOLD,
} from '../tile-failure-policy.js';

test('a successful tile load latches the basemap alive and never triggers fallback', () => {
  const policy = createTileFailurePolicy();
  assert.equal(policy.isAlive(), false);
  assert.equal(policy.recordTileLoad(), false);
  assert.equal(policy.isAlive(), true);
});

test('an isolated tile error after a success does not trigger the fallback', () => {
  const policy = createTileFailurePolicy();
  policy.recordTileLoad();
  // Many subsequent errors are tolerated once the basemap is alive.
  for (let i = 0; i < DEFAULT_ERROR_THRESHOLD + 5; i += 1) {
    assert.equal(policy.recordTileError(), false);
  }
  assert.equal(policy.hasActivatedOffline(), false);
});

test('errors below the threshold with no success do not trigger the fallback', () => {
  const policy = createTileFailurePolicy();
  for (let i = 0; i < DEFAULT_ERROR_THRESHOLD - 1; i += 1) {
    assert.equal(policy.recordTileError(), false);
  }
  assert.equal(policy.hasActivatedOffline(), false);
});

test('reaching the error threshold with zero successes triggers the fallback exactly once', () => {
  const policy = createTileFailurePolicy();
  let triggered = false;
  for (let i = 0; i < DEFAULT_ERROR_THRESHOLD; i += 1) {
    triggered = policy.recordTileError() || triggered;
  }
  assert.equal(triggered, true);
  assert.equal(policy.hasActivatedOffline(), true);
  // Latched: further errors never re-trigger.
  assert.equal(policy.recordTileError(), false);
});

test('a custom error threshold is honored', () => {
  const policy = createTileFailurePolicy({ errorThreshold: 2 });
  assert.equal(policy.recordTileError(), false);
  assert.equal(policy.recordTileError(), true);
});

test('non-positive or non-finite thresholds fall back to the default', () => {
  for (const bad of [0, -3, Number.NaN, Infinity, 'x', undefined]) {
    const policy = createTileFailurePolicy({ errorThreshold: bad });
    for (let i = 0; i < DEFAULT_ERROR_THRESHOLD - 1; i += 1) {
      assert.equal(policy.recordTileError(), false);
    }
    // Still not triggered one below the default → default threshold is in effect.
    assert.equal(policy.recordTileError(), true);
  }
});

test('a null options argument is tolerated (defaults apply)', () => {
  const policy = createTileFailurePolicy(null);
  for (let i = 0; i < DEFAULT_ERROR_THRESHOLD - 1; i += 1) {
    policy.recordTileError();
  }
  assert.equal(policy.recordTileError(), true);
});

test('layer load with zero successes but at least one error triggers the fallback once', () => {
  const policy = createTileFailurePolicy();
  policy.recordTileError();
  assert.equal(policy.recordLayerLoad(), true);
  assert.equal(policy.hasActivatedOffline(), true);
  // Latched: a second layer-load never re-triggers.
  assert.equal(policy.recordLayerLoad(), false);
});

test('layer load with no tiles attempted (zero successes, zero errors) does not trigger', () => {
  const policy = createTileFailurePolicy();
  assert.equal(policy.recordLayerLoad(), false);
  assert.equal(policy.hasActivatedOffline(), false);
});

test('layer load after any success does not trigger the fallback', () => {
  const policy = createTileFailurePolicy();
  policy.recordTileError();
  policy.recordTileLoad();
  assert.equal(policy.recordLayerLoad(), false);
  assert.equal(policy.hasActivatedOffline(), false);
});

test('a success after the fallback already activated keeps it latched (no re-trigger)', () => {
  const policy = createTileFailurePolicy();
  policy.recordTileError();
  assert.equal(policy.recordLayerLoad(), true);
  // Even if a tile somehow loads afterwards, the one-shot stays latched.
  policy.recordTileLoad();
  assert.equal(policy.recordLayerLoad(), false);
});
