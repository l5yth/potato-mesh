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
  compareNumber,
  compareString,
  hasNumberValue,
  hasStringValue,
} from '../sort-comparators.js';

// ---------------------------------------------------------------------------
// hasStringValue
// ---------------------------------------------------------------------------

test('hasStringValue returns true for non-empty strings', () => {
  assert.equal(hasStringValue('hi'), true);
  assert.equal(hasStringValue('  text  '), true);
});

test('hasStringValue returns false for null, undefined, and blank input', () => {
  assert.equal(hasStringValue(null), false);
  assert.equal(hasStringValue(undefined), false);
  assert.equal(hasStringValue(''), false);
  assert.equal(hasStringValue('   '), false);
});

test('hasStringValue treats numbers as their string form', () => {
  assert.equal(hasStringValue(0), true);
  assert.equal(hasStringValue(42), true);
});

// ---------------------------------------------------------------------------
// hasNumberValue
// ---------------------------------------------------------------------------

test('hasNumberValue accepts finite numbers', () => {
  assert.equal(hasNumberValue(42), true);
  assert.equal(hasNumberValue(-1.5), true);
  assert.equal(hasNumberValue(0), true);
});

test('hasNumberValue rejects null, undefined, and empty string', () => {
  assert.equal(hasNumberValue(null), false);
  assert.equal(hasNumberValue(undefined), false);
  assert.equal(hasNumberValue(''), false);
});

test('hasNumberValue rejects non-finite numbers and unparseable strings', () => {
  assert.equal(hasNumberValue(Number.NaN), false);
  assert.equal(hasNumberValue(Number.POSITIVE_INFINITY), false);
  assert.equal(hasNumberValue('abc'), false);
});

test('hasNumberValue accepts numeric strings', () => {
  assert.equal(hasNumberValue('42'), true);
  assert.equal(hasNumberValue(' -1.5 '), true);
});

// ---------------------------------------------------------------------------
// compareString
// ---------------------------------------------------------------------------

test('compareString sorts non-empty values lexicographically', () => {
  assert.ok(compareString('alpha', 'beta') < 0);
  assert.ok(compareString('beta', 'alpha') > 0);
  assert.equal(compareString('alpha', 'alpha'), 0);
});

test('compareString trims surrounding whitespace before comparing', () => {
  assert.equal(compareString('  alpha  ', 'alpha'), 0);
});

test('compareString sorts blank values to the end', () => {
  assert.ok(compareString('alpha', '') < 0);
  assert.ok(compareString('', 'alpha') > 0);
});

test('compareString returns 0 when both values are blank', () => {
  assert.equal(compareString(null, ''), 0);
  assert.equal(compareString('', '   '), 0);
});

test('compareString uses numeric collation for digit-bearing strings', () => {
  // localeCompare with { numeric: true } orders "node-2" before "node-10".
  assert.ok(compareString('node-2', 'node-10') < 0);
});

// ---------------------------------------------------------------------------
// compareNumber
// ---------------------------------------------------------------------------

test('compareNumber sorts ascending for finite values', () => {
  assert.ok(compareNumber(1, 2) < 0);
  assert.ok(compareNumber(2, 1) > 0);
  assert.equal(compareNumber(1, 1), 0);
});

test('compareNumber accepts numeric strings', () => {
  assert.ok(compareNumber('1', '2') < 0);
  assert.ok(compareNumber('2', '1') > 0);
});

test('compareNumber pushes invalid values after valid ones', () => {
  assert.ok(compareNumber(5, 'not-a-number') < 0);
  assert.ok(compareNumber('not-a-number', 5) > 0);
});

test('compareNumber returns 0 when both inputs are unparseable', () => {
  assert.equal(compareNumber('abc', 'def'), 0);
  // Note: Number(null) === 0, so null is *finite* under this comparator.
  assert.equal(compareNumber(undefined, 'abc'), 0);
});
