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
 * The map overlay token has a literal for engines without `color-mix()`
 * (SPEC SR3).
 *
 * `--overlay-bg` mixes `--panel` at 92% with `color-mix()`. An engine without
 * it (Chrome < 111, Safari < 16.2, Firefox < 113) keeps the custom property,
 * which is valid at parse time, and every `var(--overlay-bg)` is then invalid
 * at computed-value time, so the overlays paint their initial transparent
 * background. A second `:root` declaration in front of the first cannot help:
 * both are valid custom-property values and the later one wins. The fallback
 * is an `@supports not` block after `:root`. Chromium supports the condition,
 * so a browser check sees the mix, never the literal (ACCEPTANCE SR-A3).
 *
 * @module app/__tests__/overlay-bg-fallback
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_CSS_RULES, ROOT_TOKENS, cssRules, rulesFor } from './base-css-rules.js';

/** The `@supports` condition that selects engines without `color-mix()`. */
const NO_COLOR_MIX = 'not (color: color-mix(in srgb, #000 50%, transparent))';

/**
 * The channels of a `#rrggbb` colour.
 *
 * @param {string} hex Six-digit hex colour.
 * @returns {Array<number>} Red, green and blue, 0 to 255.
 */
function hexChannels(hex) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  assert.ok(match, `${hex} is a six-digit hex colour`);
  return match.slice(1).map(channel => Number.parseInt(channel, 16));
}

/**
 * The `:root` rule of the fallback block.
 *
 * @returns {import('./base-css-rules.js').CssRule} The one `:root` rule under
 *   {@link NO_COLOR_MIX} outside every `@media`; the assertion fails when
 *   base.css has none or several.
 */
function fallbackRoot() {
  const rules = rulesFor(':root', { supports: NO_COLOR_MIX });
  assert.equal(rules.length, 1, `base.css has one :root rule under @supports ${NO_COLOR_MIX}`);
  return rules[0];
}

test('engines without color-mix() take one literal --overlay-bg from an @supports block (SR3)', () => {
  const block = BASE_CSS_RULES.filter(rule => rule.supports === NO_COLOR_MIX);
  assert.deepEqual(
    block.map(rule => [rule.media, rule.selector]),
    [[null, ':root']],
    `@supports ${NO_COLOR_MIX} holds :root alone, outside every @media`,
  );
  assert.deepEqual(Object.keys(fallbackRoot().declarations), ['--overlay-bg'], 'it sets the overlay token alone');
});

test('the fallback literal is --panel at alpha 0.92, the colour the mix computes (SR3)', () => {
  const value = fallbackRoot().declarations['--overlay-bg'];
  const literal = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(value);
  assert.ok(literal, `${value} is an rgba() literal`);
  assert.deepEqual(literal.slice(1, 4).map(Number), hexChannels(ROOT_TOKENS.get('--panel')));
  assert.equal(Number(literal[4]), 0.92);
  assert.equal(ROOT_TOKENS.get('--overlay-bg'), 'color-mix(in srgb, var(--panel) 92%, transparent)');
});

test('the fallback block follows :root, so it wins where it applies (SR3)', () => {
  const [root] = cssRules(':root');
  assert.ok(BASE_CSS_RULES.indexOf(fallbackRoot()) > BASE_CSS_RULES.indexOf(root), 'the @supports :root comes after :root');
});

test('hexChannels reads a six-digit hex colour and rejects anything else (local helper)', () => {
  assert.deepEqual(hexChannels('#151c22'), [21, 28, 34]);
  assert.deepEqual(hexChannels('#FFffFF'), [255, 255, 255]);
  assert.throws(() => hexChannels('#fff'), /#fff is a six-digit hex colour/);
});
