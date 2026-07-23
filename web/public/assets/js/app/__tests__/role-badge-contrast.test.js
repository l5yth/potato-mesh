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

// Regression guard for audit finding D-008 (SPEC UX2 / ACCEPTANCE UX-A1):
// every short-name badge must carry an inline text colour that reaches WCAG
// 2.1 AA contrast (>= 4.5:1) against its role-coloured background, for every
// role of both protocol palettes and for the unknown-short fallback badge.

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderShortHtml } from '../main/short-html-renderer.js';
import { roleColors, meshcoreRoleColors } from '../role-helpers.js';

/**
 * Convert one sRGB channel (0-255) to its linear-light value.
 *
 * @param {number} channel Channel value in the 0-255 range.
 * @returns {number} Linearised channel per WCAG 2.x.
 */
function linearChannel(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Compute WCAG relative luminance for a hex colour.
 *
 * @param {string} hex Colour in `#rgb` or `#rrggbb` form.
 * @returns {number} Relative luminance in [0, 1].
 */
function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map(ch => ch + ch).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/**
 * Compute the WCAG contrast ratio between two hex colours.
 *
 * @param {string} a First colour.
 * @param {string} b Second colour.
 * @returns {number} Contrast ratio (>= 1).
 */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Extract the inline `background` and `color` declarations from a badge.
 *
 * @param {string} html Badge markup produced by {@link renderShortHtml}.
 * @returns {{background: ?string, color: ?string}} Parsed inline colours.
 */
function parseBadgeColors(html) {
  const style = /style="([^"]*)"/.exec(html);
  const decls = style ? style[1] : '';
  const background = /background:\s*([^;"]+)/.exec(decls);
  const color = /(?:^|;)\s*color:\s*([^;"]+)/.exec(decls);
  return {
    background: background ? background[1].trim() : null,
    color: color ? color[1].trim() : null,
  };
}

const PALETTES = [
  { protocol: 'meshtastic', palette: roleColors },
  { protocol: 'meshcore', palette: meshcoreRoleColors },
];

for (const { protocol, palette } of PALETTES) {
  for (const [role, expectedBackground] of Object.entries(palette)) {
    test(`badge text meets AA contrast for ${protocol} ${role}`, () => {
      const html = renderShortHtml('ABCD', role, 'Long Name', { protocol });
      const { background, color } = parseBadgeColors(html);
      assert.equal(
        background?.toLowerCase(),
        expectedBackground.toLowerCase(),
        'badge background must stay the role colour',
      );
      assert.ok(color, `badge for ${protocol}/${role} must carry an inline text colour`);
      const ratio = contrast(color, background);
      assert.ok(
        ratio >= 4.5,
        `text ${color} on ${background} is ${ratio.toFixed(2)}:1 — below the 4.5:1 AA floor`,
      );
    });
  }
}

test('unknown-short fallback badge meets AA contrast', () => {
  const html = renderShortHtml(null, 'CLIENT', null, { protocol: 'meshtastic' });
  const { background, color } = parseBadgeColors(html);
  assert.ok(background, 'fallback badge keeps its background');
  assert.ok(color, 'fallback badge must carry an inline text colour');
  assert.ok(contrast(color, background) >= 4.5, 'fallback badge text must reach 4.5:1');
});
