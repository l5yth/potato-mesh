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

import { numberOrNull, stringOrNull } from '../value-helpers.js';

// ---------------------------------------------------------------------------
// numberOrNull
// ---------------------------------------------------------------------------

test('numberOrNull passes through finite numbers unchanged', () => {
  assert.equal(numberOrNull(42), 42);
  assert.equal(numberOrNull(-3.14), -3.14);
  assert.equal(numberOrNull(0), 0);
});

test('numberOrNull returns null for non-finite numbers', () => {
  assert.equal(numberOrNull(Number.NaN), null);
  assert.equal(numberOrNull(Number.POSITIVE_INFINITY), null);
  assert.equal(numberOrNull(Number.NEGATIVE_INFINITY), null);
});

test('numberOrNull returns null for null, undefined, and empty string', () => {
  assert.equal(numberOrNull(null), null);
  assert.equal(numberOrNull(undefined), null);
  assert.equal(numberOrNull(''), null);
});

test('numberOrNull coerces numeric strings into numbers', () => {
  assert.equal(numberOrNull('42'), 42);
  assert.equal(numberOrNull(' -1.5 '), -1.5);
  assert.equal(numberOrNull('0'), 0);
});

test('numberOrNull rejects non-numeric strings', () => {
  assert.equal(numberOrNull('not a number'), null);
  assert.equal(numberOrNull('1.2.3'), null);
});

test('numberOrNull rejects objects and arrays', () => {
  assert.equal(numberOrNull({}), null);
  assert.equal(numberOrNull([]), 0); // Array#toString of [] is '' which Number('') is 0
  assert.equal(numberOrNull([1, 2]), null);
});

test('numberOrNull treats booleans as their numeric coercion', () => {
  // Number(true) === 1, Number(false) === 0; documented contract is that any
  // value Number() resolves to a finite number passes through.
  assert.equal(numberOrNull(true), 1);
  assert.equal(numberOrNull(false), 0);
});

// ---------------------------------------------------------------------------
// stringOrNull
// ---------------------------------------------------------------------------

test('stringOrNull returns trimmed strings for non-empty input', () => {
  assert.equal(stringOrNull('hello'), 'hello');
  assert.equal(stringOrNull('  spaced  '), 'spaced');
});

test('stringOrNull returns null for null and undefined', () => {
  assert.equal(stringOrNull(null), null);
  assert.equal(stringOrNull(undefined), null);
});

test('stringOrNull returns null for the empty string and whitespace-only input', () => {
  assert.equal(stringOrNull(''), null);
  assert.equal(stringOrNull('   '), null);
  assert.equal(stringOrNull('\t\n'), null);
});

test('stringOrNull stringifies non-string inputs', () => {
  assert.equal(stringOrNull(42), '42');
  assert.equal(stringOrNull(0), '0');
  assert.equal(stringOrNull(true), 'true');
});
