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
 * Regression guard: stacked-basemap provider blend (no checkerboard).
 *
 * The basemap is two always-on layers — a CARTO Voyager base under an opaque HOT
 * overlay — instead of the earlier per-tile timeout-and-swap. A viewport can mix
 * an already-arrived HOT tile with a not-yet-arrived cell (where the CARTO base
 * shows through), so the two providers must look identical or the map reads as a
 * light/dark checkerboard. This suite locks the blend so the defect cannot
 * silently return:
 *
 * 1. **Colored source** — the CARTO base is the *colored* Voyager raster basemap
 *    (not the natively-dark Dark Matter), so the same dark filter that greys HOT
 *    applies meaningfully to it too.
 * 2. **Shared filter (the blend)** — ``.map-tiles-fallback`` (CARTO base) carries
 *    the *same* ``grayscale/invert`` dark filter as ``.map-tiles-hot`` (HOT
 *    overlay), on the per-layer containers, so both providers converge to one
 *    coherent dark look.
 * 3. **Single pane veil** — dimming is one ``#map .leaflet-tile-pane`` opacity
 *    rule (``0.5625``); the layers are opaque and the old per-tile ``.map-tiles``
 *    opacity rule is gone, so brightness is independent of the layer count and
 *    the stack composites to the pre-stack look.
 *
 * @module __tests__/basemap-blend
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CARTO_TILE_URL } from '../basemap-config.js';

/** Absolute path to the shared stylesheet carrying the tile filter rules. */
const BASE_CSS_PATH = fileURLToPath(new URL('../../../styles/base.css', import.meta.url));

/**
 * Return the declaration body of the first CSS rule whose selector mentions
 * ``selectorFragment``. Whitespace-tolerant so the assertions do not depend on
 * the exact selector formatting (single rule vs. comma-grouped selectors both
 * work). Comments are stripped first so a class name *mentioned in a comment*
 * above an unrelated rule cannot be mistaken for that rule's selector.
 *
 * @param {string} css Full stylesheet text.
 * @param {string} selectorFragment Substring to locate in a selector.
 * @returns {string|null} The rule's declaration body, or ``null`` when absent.
 */
function ruleBodyFor(css, selectorFragment) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of withoutComments.split('}')) {
    const braceIdx = block.indexOf('{');
    if (braceIdx === -1) continue;
    const selector = block.slice(0, braceIdx);
    if (selector.includes(selectorFragment)) return block.slice(braceIdx + 1).trim();
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

/**
 * Extract the ``opacity:`` value from a CSS declaration body.
 *
 * @param {string|null} ruleBody Declaration body from {@link ruleBodyFor}.
 * @returns {string|null} The opacity value (e.g. ``0.5625``), or ``null``.
 */
function opacityValueOf(ruleBody) {
  if (!ruleBody) return null;
  for (const decl of ruleBody.split(';')) {
    const trimmed = decl.trim();
    if (trimmed.startsWith('opacity:')) return trimmed.slice('opacity:'.length).trim();
  }
  return null;
}

test('the CARTO base uses a colored basemap (Voyager), not the natively-dark style', () => {
  // A positive match on the colored Voyager raster style also proves the source
  // is not the old natively-dark CARTO style (which the shared filter could not
  // meaningfully grey), so no separate negative assertion is needed.
  assert.match(CARTO_TILE_URL, /basemaps\.cartocdn\.com\/rastertiles\/voyager/);
});

test('CARTO base tiles share the same dark filter as HOT overlay tiles (blend)', () => {
  const css = readFileSync(BASE_CSS_PATH, 'utf8');
  const hotFilter = filterValueOf(ruleBodyFor(css, 'map-tiles-hot'));
  const fallbackFilter = filterValueOf(ruleBodyFor(css, 'map-tiles-fallback'));

  assert.match(hotFilter, /grayscale\(1\) invert\(1\)/);
  // The CARTO base is not exempt (`filter: none`); it carries HOT's filter.
  assert.notEqual(fallbackFilter, 'none');
  assert.equal(fallbackFilter, hotFilter);
});

test('the filter sits on the per-layer container, not individual tiles', () => {
  const css = readFileSync(BASE_CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // With no per-tile swap, Leaflet stamps the className on the layer container
  // (`.leaflet-layer`), so the filter selector targets that, not `.leaflet-tile`.
  assert.ok(css.includes('.leaflet-layer.map-tiles-hot'));
  assert.ok(css.includes('.leaflet-layer.map-tiles-fallback'));
});

test('dimming is a single pane veil (0.5625); no per-tile map-tiles opacity remains', () => {
  const css = readFileSync(BASE_CSS_PATH, 'utf8');
  // One veil over the whole tile pane composites the stacked layers to the
  // pre-stack brightness (0.75 × 0.75), independent of layer count.
  assert.equal(opacityValueOf(ruleBodyFor(css, 'leaflet-tile-pane')), '0.5625');
  // The old bare per-tile container opacity rule is gone (only `-hot`/`-fallback`
  // per-layer classes remain; `.leaflet-tile.map-tiles` no longer appears).
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!withoutComments.includes('.leaflet-tile.map-tiles'));
});
