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
 * Legend line-style samples (SPEC UX7, audit D-014).
 *
 * The map draws two edge encodings — solid neighbor links and `6 6`-dashed
 * traceroutes — but the legend never keyed them. These 24 px inline SVG
 * samples decorate the existing neighbor/trace toggle buttons so the key and
 * the control are one element.
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
  const dash = kind === 'trace' ? ' stroke-dasharray="6 6"' : '';
  return (
    '<svg class="legend-line-sample" width="24" height="8" viewBox="0 0 24 8" ' +
    'aria-hidden="true" focusable="false">' +
    `<line x1="1" y1="4" x2="23" y2="4" stroke="currentColor" stroke-width="2"${dash} />` +
    '</svg>'
  );
}
