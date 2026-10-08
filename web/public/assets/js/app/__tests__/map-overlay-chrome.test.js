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
 * One overlay chrome on every map (SPEC ML2, ML5): the Leaflet zoom control,
 * the toolbar, the legend and its toggle, the activity card, the status pill
 * and the popups all paint `--overlay-bg` with a `--overlay-line` hairline.
 *
 * leaflet.css loads after base.css, so a base.css rule at Leaflet's own
 * specificity loses; the Leaflet rules here are scoped under `#map`. The DOM
 * stub lays nothing out, so the rules are checked on base.css.
 *
 * @module app/__tests__/map-overlay-chrome
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_CSS_RULES, declarationsFor, rulesFor } from './base-css-rules.js';

/** The neutral grey literals the colour tokens replace (G1). */
const NEUTRAL_LITERAL = /#(222|333|444|1a1a1a|1c1c1c|eee|ddd|bbb|ccc|999|aaa|888)\b/i;

/** Selectors of the map overlay rules: the panels, their controls and the Leaflet chrome. */
const OVERLAY_SELECTOR = /^(\.legend|\.map-activity-card|\.map-toolbar button|#map \.(leaflet-|legend-toggle-button|map-status-message|map-placeholder-message))/;

test('the zoom control is a 36 px overlay pill on every map (ML2)', () => {
  const bar = declarationsFor('#map .leaflet-bar');
  assert.equal(bar.border, '1px solid var(--overlay-line)');
  assert.equal(bar['border-radius'], '999px');
  assert.equal(bar.overflow, 'hidden');
  const button = declarationsFor('#map .leaflet-bar a');
  assert.equal(button['background-color'], 'var(--overlay-bg)');
  assert.equal(button.color, 'var(--fg)');
  assert.equal(button['border-bottom-color'], 'var(--overlay-line)');
  assert.equal(button.width, '36px');
  assert.equal(button.height, '36px');
  assert.equal(button.font, '600 18px/36px system-ui');
});

test('a coarse pointer gets 44 px zoom buttons (ML2)', () => {
  const coarse = declarationsFor('#map .leaflet-bar a', { media: '(pointer: coarse)' });
  assert.equal(coarse.width, '44px');
  assert.equal(coarse.height, '44px');
  assert.equal(coarse['line-height'], '44px');
});

test('the zoom focus ring sits inside the pill, and a disabled button is muted (ML2)', () => {
  const focus = declarationsFor('#map .leaflet-bar a:focus-visible');
  assert.equal(focus.outline, '2px solid var(--accent)');
  assert.equal(focus['outline-offset'], '-3px', 'the pill clips an outward ring');
  assert.equal(declarationsFor('#map .leaflet-bar a.leaflet-disabled').color, 'var(--muted)');
});

test('base.css styles the zoom bar and the popups only under #map, where they outrank leaflet.css (ML2, ML5)', () => {
  const selectors = BASE_CSS_RULES.flatMap(rule => rule.selectors).filter(selector => /\.leaflet-(bar|popup)/.test(selector));
  assert.ok(selectors.length > 0, 'base.css styles the zoom bar and the popups');
  for (const selector of selectors) assert.match(selector, /^#map /);
});

test('every map overlay paints var(--overlay-bg) (ML5)', () => {
  const fills = {
    '.legend': 'background',
    '.map-activity-card': 'background',
    '#map .legend-toggle-button': 'background',
    '.map-toolbar button': 'background',
    '#map .map-status-message': 'background',
    '#map .leaflet-bar a': 'background-color',
    '#map .leaflet-popup-content-wrapper': 'background',
  };
  for (const [selector, property] of Object.entries(fills)) {
    assert.equal(declarationsFor(selector)[property], 'var(--overlay-bg)', selector);
  }
});

test('every bordered map overlay draws the --overlay-line hairline (ML5)', () => {
  for (const selector of ['.legend', '.map-activity-card', '.map-toolbar button', '#map .map-status-message']) {
    assert.equal(declarationsFor(selector).border, '1px solid var(--overlay-line)', selector);
  }
  assert.equal(declarationsFor('#map .legend-toggle-button')['border-color'], 'var(--overlay-line)');
});

test('the toolbar is one pill rule, out of the generic button reset (ML5)', () => {
  assert.equal(rulesFor('.map-toolbar button').length, 1, 'the dead light pair is gone');
  assert.equal(rulesFor('.map-toolbar button:hover').length, 1);
  const pill = declarationsFor('.map-toolbar button');
  assert.equal(pill['border-radius'], '999px');
  assert.equal(pill.cursor, 'pointer', 'the reset no longer gives it a pointer');
  const reset = BASE_CSS_RULES.filter(rule => rule.selectors.some(selector => selector.startsWith('button:not(.chat-tab)')));
  assert.equal(reset.length, 2, 'the reset and its :hover');
  for (const rule of reset) {
    assert.ok(rule.selectors.every(selector => selector.includes(':not(.map-toolbar button)')), rule.selector);
  }
});

test('a popup link keeps the accent colour on the dark popup (ML5)', () => {
  assert.equal(declarationsFor('#map .leaflet-popup-content a').color, 'var(--accent)');
});

test('the map overlays carry no neutral grey literal (ML5)', () => {
  const overlays = BASE_CSS_RULES.filter(rule => rule.selectors.some(selector => OVERLAY_SELECTOR.test(selector)));
  assert.ok(overlays.length > 20, 'the overlay rules are found');
  for (const rule of overlays) {
    for (const [property, value] of Object.entries(rule.declarations)) {
      assert.doesNotMatch(value, NEUTRAL_LITERAL, `${rule.selector} { ${property}: ${value} }`);
    }
  }
});
