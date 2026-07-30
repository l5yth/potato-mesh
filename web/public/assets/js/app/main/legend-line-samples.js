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

import { FALLBACK_GLYPH } from './waypoint-layer.js';

/**
 * Legend line-style samples (SPEC UX7, audit D-014).
 *
 * The map draws two edge encodings — solid neighbor links and dashed
 * traceroutes — but the legend never keyed them. These 24 px inline SVG
 * samples decorate the existing neighbor/trace toggle buttons so the key and
 * the control are one element.
 *
 * The sample line spans x=1→23 (22 px of ink). The map traces stay `6 6`, but
 * `6 6` over 22 px ends mid-gap (ink stops at 19 px), so the dashed key looks
 * 4 px shorter than the solid one. The sample uses `6 2` instead, which tiles
 * 22 px exactly (6+2+6+2+6) — three full dashes inking both ends — so the two
 * toggles read as the same length (audit follow-up 05). The 24 px sample is a
 * key, not a scale model, so the on-map dash cadence is unaffected.
 *
 * @module main/legend-line-samples
 */

/**
 * Build the inline SVG sample for one line kind.
 *
 * @param {string} kind `'trace'` for the dashed traceroute sample; anything
 *   else yields the solid neighbor sample.
 * @returns {string} Decorative inline SVG markup (aria-hidden).
 */
export function legendLineSampleSvg(kind) {
  const dash = kind === 'trace' ? ' stroke-dasharray="6 2"' : '';
  return (
    '<svg class="legend-line-sample" width="24" height="8" viewBox="0 0 24 8" ' +
    'aria-hidden="true" focusable="false">' +
    `<line x1="1" y1="4" x2="23" y2="4" stroke="currentColor" stroke-width="2"${dash} />` +
    '</svg>'
  );
}

/**
 * Build the miniature waypoint-pin sample decorating the Waypoints layer
 * toggle (design 1e-A, marker per the 1c-B re-roll): a 12 px scale model of
 * the on-map dark **teardrop pin** — three round corners, one sharp tail
 * corner, rotated −45° with the glyph (📌, the layer's canonical marker) counter-
 * rotated upright — so the key and the control are one element, mirroring the
 * line samples above.
 *
 * @returns {string} Decorative inline-styled pin markup (aria-hidden).
 */
export function legendWaypointSampleHtml() {
  return (
    '<span class="legend-waypoint-sample" aria-hidden="true" ' +
    'style="display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box; ' +
    'flex:0 0 auto; width:12px; height:12px; margin:0 2px 2px; ' +
    'border:1px solid rgba(230,235,240,0.55); border-radius:50% 50% 50% 2px; background:#1c1c1c; ' +
    'transform:rotate(-45deg); font-size:7px; line-height:1">' +
    `<span style="display:block; transform:rotate(45deg)">${FALLBACK_GLYPH}</span>` +
    '</span>'
  );
}
