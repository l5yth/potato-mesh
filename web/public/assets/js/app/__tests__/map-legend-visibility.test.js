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

import { resolveLegendVisibility } from '../map-legend-visibility.js';

test('resolveLegendVisibility hides when a default collapse is requested', () => {
  assert.equal(resolveLegendVisibility({ defaultCollapsed: true, mediaQueryMatches: false }), false);
  assert.equal(resolveLegendVisibility({ defaultCollapsed: true, mediaQueryMatches: true }), false);
});

test('resolveLegendVisibility always hides on the cramped dashboard', () => {
  assert.equal(
    resolveLegendVisibility({ defaultCollapsed: false, mediaQueryMatches: false, viewMode: 'dashboard' }),
    false
  );
});

// SPEC UX8 (audit D-011): the dedicated map view honours the template default
// — expanded on desktop, collapsed on small viewports.
test('resolveLegendVisibility expands the map view on desktop', () => {
  assert.equal(
    resolveLegendVisibility({ defaultCollapsed: false, mediaQueryMatches: false, viewMode: 'map' }),
    true
  );
  assert.equal(
    resolveLegendVisibility({ defaultCollapsed: false, mediaQueryMatches: true, viewMode: 'map' }),
    false
  );
});

test('resolveLegendVisibility follows the media query when not forced', () => {
  assert.equal(resolveLegendVisibility({ defaultCollapsed: false, mediaQueryMatches: false }), true);
  assert.equal(resolveLegendVisibility({ defaultCollapsed: false, mediaQueryMatches: true }), false);
});
