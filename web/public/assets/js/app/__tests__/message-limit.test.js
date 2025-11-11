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

import { MESSAGE_LIMIT, normaliseMessageLimit } from '../message-limit.js';

test('normaliseMessageLimit defaults to the message limit for invalid input', () => {
  assert.equal(normaliseMessageLimit(undefined), MESSAGE_LIMIT);
  assert.equal(normaliseMessageLimit(null), MESSAGE_LIMIT);
  assert.equal(normaliseMessageLimit(''), MESSAGE_LIMIT);
  assert.equal(normaliseMessageLimit('abc'), MESSAGE_LIMIT);
  assert.equal(normaliseMessageLimit(-100), MESSAGE_LIMIT);
  assert.equal(normaliseMessageLimit(0), MESSAGE_LIMIT);
  assert.equal(normaliseMessageLimit(Number.POSITIVE_INFINITY), MESSAGE_LIMIT);
});

test('normaliseMessageLimit clamps numeric input to the upper bound', () => {
  assert.equal(normaliseMessageLimit(MESSAGE_LIMIT + 1), MESSAGE_LIMIT);
  assert.equal(normaliseMessageLimit(MESSAGE_LIMIT * 2), MESSAGE_LIMIT);
});

test('normaliseMessageLimit accepts positive finite values', () => {
  assert.equal(normaliseMessageLimit(250), 250);
  assert.equal(normaliseMessageLimit('750'), 750);
  assert.equal(normaliseMessageLimit(42.9), 42);
});
