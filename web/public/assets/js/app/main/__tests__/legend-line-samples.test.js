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
// for neighbor links, a dashed sample for traceroutes. The dashed sample uses
// `6 2` (not the map's `6 6`) so three whole dashes tile the 22 px line and
// ink both ends, matching the solid sample's length (audit follow-up 05).

import test from 'node:test';
import assert from 'node:assert/strict';

import { legendLineSampleSvg, legendWaypointSampleHtml } from '../legend-line-samples.js';
import { FALLBACK_GLYPH } from '../waypoint-layer.js';

test('neighbor sample is a solid 24px line', () => {
  const svg = legendLineSampleSvg('neighbor');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('width="24"'));
  assert.ok(!svg.includes('stroke-dasharray'), 'neighbor sample stays solid');
  assert.ok(svg.includes('aria-hidden="true"'), 'sample is decorative for AT');
});

test('trace sample is dashed 6 2 so it inks the full 22px sample', () => {
  const svg = legendLineSampleSvg('trace');
  assert.ok(
    svg.includes('stroke-dasharray="6 2"'),
    'trace sample tiles the 22px line exactly (6+2+6+2+6) rather than ending mid-gap',
  );
  assert.ok(!svg.includes('stroke-dasharray="6 6"'), 'the mid-gap 6 6 sample is gone');
});

test('unknown kinds fall back to the solid sample', () => {
  assert.equal(legendLineSampleSvg('mystery'), legendLineSampleSvg('neighbor'));
});

test('legendWaypointSampleHtml is a miniature of the on-map teardrop pin (1c-B)', () => {
  const html = legendWaypointSampleHtml();
  assert.match(html, /legend-waypoint-sample/);
  assert.match(html, /aria-hidden="true"/);
  // The sample mirrors the marker silhouette: dark chrome, three round corners
  // + one sharp tail corner, rotated with the glyph counter-rotated upright.
  assert.match(html, /background:#1c1c1c/);
  assert.match(html, /border-radius:50% 50% 50% 2px/);
  assert.match(html, /rotate\(-45deg\)/);
  assert.match(html, /rotate\(45deg\)/);
  // F2: the swatch is a 12px box with a 7px glyph (design 1e-A), legible next to
  // the 12px role dots — not the shipped 11px box / 6px smudge that sat 1px short.
  assert.match(html, /width:12px/);
  assert.match(html, /height:12px/);
  assert.match(html, /font-size:7px/);
  assert.doesNotMatch(html, /width:11px/);
  assert.doesNotMatch(html, /height:11px/);
  assert.doesNotMatch(html, /font-size:6px/);
  // F2: the swatch carries the layer's canonical marker glyph (📌), imported from
  // waypoint-layer.js so the key can never drift from the pins' fallback glyph.
  assert.ok(html.includes(FALLBACK_GLYPH), 'swatch uses the layer canonical glyph');
  assert.doesNotMatch(html, /✈/);
  // Regression guard: never the old square-chip radius.
  assert.doesNotMatch(html, /border-radius:3px/);
});
