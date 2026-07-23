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

// Regression guard for audit finding D-014 (SPEC UX7 / ACCEPTANCE UX-A5):
// the legend's line toggles must key the two edge encodings — a solid sample
// for neighbor links, a 6/6-dashed sample for traceroutes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { legendLineSampleSvg } from '../legend-line-samples.js';

test('neighbor sample is a solid 24px line', () => {
  const svg = legendLineSampleSvg('neighbor');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('width="24"'));
  assert.ok(!svg.includes('stroke-dasharray'), 'neighbor sample stays solid');
  assert.ok(svg.includes('aria-hidden="true"'), 'sample is decorative for AT');
});

test('trace sample is dashed to match the 6/6 polyline style', () => {
  const svg = legendLineSampleSvg('trace');
  assert.ok(svg.includes('stroke-dasharray="6 6"'), 'trace sample mirrors dashArray 6 6');
});

test('unknown kinds fall back to the solid sample', () => {
  assert.equal(legendLineSampleSvg('mystery'), legendLineSampleSvg('neighbor'));
});
