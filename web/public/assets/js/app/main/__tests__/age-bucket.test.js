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

// Regression guard for audit finding D-005 (SPEC UX5 / ACCEPTANCE UX-A3):
// node freshness must be an encoded state — a `live`/`today`/`stale` bucket
// stamped as row attributes, refreshed by the shared RT2 tick, and mapped to
// marker fill opacity.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGE_BUCKET_ATTRIBUTE,
  AGE_BUCKET_TS_ATTRIBUTE,
  AGE_BUCKET_LIVE_MAX_SECONDS,
  AGE_BUCKET_TODAY_MAX_SECONDS,
  nodeAgeBucket,
  ageBucketAttributes,
  updateAgeBucketElements,
  markerFillOpacityForBucket,
} from '../age-bucket.js';

const NOW = 1_700_000_000;

test('bucket thresholds: live < 3 h, today < 24 h, stale beyond', () => {
  assert.equal(AGE_BUCKET_LIVE_MAX_SECONDS, 3 * 3600);
  assert.equal(AGE_BUCKET_TODAY_MAX_SECONDS, 24 * 3600);
  assert.equal(nodeAgeBucket(NOW - 41, NOW), 'live');
  assert.equal(nodeAgeBucket(NOW - (3 * 3600 - 1), NOW), 'live');
  assert.equal(nodeAgeBucket(NOW - 3 * 3600, NOW), 'today');
  assert.equal(nodeAgeBucket(NOW - (24 * 3600 - 1), NOW), 'today');
  assert.equal(nodeAgeBucket(NOW - 24 * 3600, NOW), 'stale');
  assert.equal(nodeAgeBucket(NOW - 21 * 86400, NOW), 'stale');
});

test('invalid or missing timestamps classify as stale', () => {
  assert.equal(nodeAgeBucket(null, NOW), 'stale');
  assert.equal(nodeAgeBucket(undefined, NOW), 'stale');
  assert.equal(nodeAgeBucket('nope', NOW), 'stale');
  assert.equal(nodeAgeBucket(0, NOW), 'stale');
  assert.equal(nodeAgeBucket(Infinity, NOW), 'stale');
});

test('a timestamp in the future clamps to live', () => {
  assert.equal(nodeAgeBucket(NOW + 3600, NOW), 'live');
});

test('ageBucketAttributes emits both attributes for a finite timestamp', () => {
  const attrs = ageBucketAttributes(NOW - 60, NOW);
  assert.ok(attrs.includes(`${AGE_BUCKET_ATTRIBUTE}="live"`));
  assert.ok(attrs.includes(`${AGE_BUCKET_TS_ATTRIBUTE}="${NOW - 60}"`));
});

test('ageBucketAttributes yields an empty string without a timestamp', () => {
  assert.equal(ageBucketAttributes(null, NOW), '');
  assert.equal(ageBucketAttributes(0, NOW), '');
  assert.equal(ageBucketAttributes('x', NOW), '');
});

/**
 * Minimal element stub carrying attribute state for the scan pass.
 *
 * @param {Object<string, string>} attrs Initial attributes.
 * @returns {{getAttribute: Function, setAttribute: Function, attrs: Object}}
 */
function elementStub(attrs) {
  const state = { ...attrs };
  return {
    attrs: state,
    getAttribute: name => (name in state ? state[name] : null),
    setAttribute: (name, value) => {
      state[name] = String(value);
    },
  };
}

test('updateAgeBucketElements rewrites only elements whose bucket changed', () => {
  const fresh = elementStub({
    [AGE_BUCKET_TS_ATTRIBUTE]: String(NOW - 60),
    [AGE_BUCKET_ATTRIBUTE]: 'live',
  });
  const drifted = elementStub({
    [AGE_BUCKET_TS_ATTRIBUTE]: String(NOW - 4 * 3600),
    [AGE_BUCKET_ATTRIBUTE]: 'live',
  });
  const documentRef = {
    querySelectorAll: selector => {
      assert.ok(selector.includes(AGE_BUCKET_TS_ATTRIBUTE));
      return [fresh, drifted];
    },
  };
  const written = updateAgeBucketElements(documentRef, NOW);
  assert.equal(written, 1, 'only the drifted element is rewritten');
  assert.equal(fresh.attrs[AGE_BUCKET_ATTRIBUTE], 'live');
  assert.equal(drifted.attrs[AGE_BUCKET_ATTRIBUTE], 'today');
});

test('updateAgeBucketElements tolerates a missing document', () => {
  assert.equal(updateAgeBucketElements(null, NOW), 0);
  assert.equal(updateAgeBucketElements({}, NOW), 0);
});

test('marker fill opacity maps buckets to .85/.55/.30', () => {
  assert.equal(markerFillOpacityForBucket('live'), 0.85);
  assert.equal(markerFillOpacityForBucket('today'), 0.55);
  assert.equal(markerFillOpacityForBucket('stale'), 0.3);
  assert.equal(markerFillOpacityForBucket('unknown'), 0.3);
});
