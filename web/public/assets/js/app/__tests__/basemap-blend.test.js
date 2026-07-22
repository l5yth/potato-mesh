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

/**
 * Regression guard: basemap provider blend (chess-pattern fix).
 *
 * The dashboard/federation basemap renders primary HOT tiles and per-tile CARTO
 * fallback tiles in the same viewport. When the two providers looked different —
 * HOT dark-filtered vs a natively-dark, *unfiltered* CARTO Dark Matter tile — a
 * viewport mixing both (routine, because HOT is slow and the fallback timeout was
 * aggressive) rendered as a light/dark **checkerboard**. This suite locks the fix
 * so the defect cannot silently return:
 *
 * 1. **Graceful timeout** — the per-tile HOT deadline is 2500 ms (was 1000 ms),
 *    so a slow-but-arriving HOT tile beats the deadline and fallback returns to
 *    the rare safety net it was designed to be.
 * 2. **Colored fallback** — the CARTO source is the *colored* Voyager raster
 *    basemap (not the natively-dark Dark Matter), so the same dark filter that
 *    greys HOT applies meaningfully to it too.
 * 3. **Shared filter (the blend)** — ``.map-tiles-fallback`` carries the *same*
 *    ``grayscale/invert`` dark filter as ``.map-tiles-hot`` (no longer
 *    ``filter: none``), so HOT and CARTO tiles converge to one coherent dark look
 *    instead of a checkerboard.
 *
 * @module __tests__/basemap-blend
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CARTO_TILE_URL, FALLBACK_TIMEOUT_MS } from '../basemap-config.js';

/** Absolute path to the shared stylesheet carrying the tile filter rules. */
const BASE_CSS_PATH = fileURLToPath(new URL('../../../styles/base.css', import.meta.url));

/**
 * Return the declaration body of the first CSS rule whose selector mentions
 * ``className``. Whitespace-tolerant so the assertions do not depend on the exact
 * selector formatting (single rule vs. comma-grouped selectors both work).
 * Comments are stripped first so a class name *mentioned in a comment* above an
 * unrelated rule cannot be mistaken for that rule's selector.
 *
 * @param {string} css Full stylesheet text.
 * @param {string} className Class name to locate in a selector (without the dot).
 * @returns {string|null} The rule's declaration body, or ``null`` when absent.
 */
function ruleBodyFor(css, className) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of withoutComments.split('}')) {
    const braceIdx = block.indexOf('{');
    if (braceIdx === -1) continue;
    const selector = block.slice(0, braceIdx);
    if (selector.includes(className)) return block.slice(braceIdx + 1).trim();
  }
  return null;
}

/**
 * Extract the standalone ``filter:`` value from a CSS declaration body, ignoring
 * the ``-webkit-filter:`` vendor twin.
 *
 * @param {string|null} ruleBody Declaration body from {@link ruleBodyFor}.
 * @returns {string|null} The filter value (e.g. ``grayscale(1) …``), or ``null``.
 */
function filterValueOf(ruleBody) {
  if (!ruleBody) return null;
  for (const decl of ruleBody.split(';')) {
    const trimmed = decl.trim();
    if (trimmed.startsWith('filter:')) return trimmed.slice('filter:'.length).trim();
  }
  return null;
}

test('the per-tile HOT fallback timeout is graceful (2500 ms)', () => {
  assert.equal(FALLBACK_TIMEOUT_MS, 2500);
});

test('the CARTO fallback uses a colored basemap (Voyager), not Dark Matter', () => {
  assert.match(CARTO_TILE_URL, /basemaps\.cartocdn\.com\/rastertiles\/voyager/);
  assert.doesNotMatch(CARTO_TILE_URL, /dark_all/);
});

test('CARTO fallback tiles share the same dark filter as HOT tiles (blend)', () => {
  const css = readFileSync(BASE_CSS_PATH, 'utf8');
  const hotFilter = filterValueOf(ruleBodyFor(css, 'map-tiles-hot'));
  const fallbackFilter = filterValueOf(ruleBodyFor(css, 'map-tiles-fallback'));

  assert.match(hotFilter, /grayscale\(1\) invert\(1\)/);
  // The fallback is no longer exempt (`filter: none`); it carries HOT's filter.
  assert.notEqual(fallbackFilter, 'none');
  assert.equal(fallbackFilter, hotFilter);
});
