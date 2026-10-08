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
 * One grey family on the colour tokens (SPEC GF1-GF6).
 *
 * The page chrome painted a neutral grey family (#222, #333, #444, #eee and
 * kin) beside the blue-black `:root` palette. The rules checked here now take
 * their colours from `:root`: raised surfaces from `--panel`, hairlines from
 * `--line-strong`, controls from `--input-bg`, secondary text from
 * `--fg-soft`. The map overlays and the chat line anatomy convert in their
 * own changes, so only the rules this change owns are checked for greys.
 *
 * @module app/__tests__/base-css-palette
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ROOT_TOKENS, TOP_LEVEL_RULES, cssRules, cssValue, resolveToken } from './base-css-rules.js';

/** The neutral greys of the old palette (design review rc3, finding G1). */
const NEUTRAL_GREY = /#(?:222|333|444|1a1a1a|1c1c1c|eee|ddd|bbb|ccc|999|aaa|888)\b/gi;

/** The tokens this change adds or changes, with their values (SPEC GF1). */
const TOKENS = Object.freeze({
  '--panel': '#151c22',
  '--line-strong': 'rgba(255, 255, 255, 0.14)',
  '--fg-soft': '#c9d1d9',
  '--overlay-bg': 'color-mix(in srgb, var(--panel) 92%, transparent)',
  '--overlay-line': 'var(--line-strong)',
  '--table-head-bg': '#1c2226',
});

/**
 * Selector of the global button reset, or of its hover rule. Both open with
 * this prefix; the map change extends their `:not()` chains.
 *
 * @param {boolean} hover Whether to return the hover rule's selector.
 * @returns {string} The selector list as base.css writes it.
 */
function buttonReset(hover) {
  const prefix = 'button:not(.chat-tab):not(.sort-button)';
  const rule = TOP_LEVEL_RULES.find(
    candidate => candidate.selector.startsWith(prefix) && candidate.selector.endsWith(':hover') === hover,
  );
  assert.ok(rule, `base.css has the button reset${hover ? ' hover rule' : ''}`);
  return rule.selector;
}

/** The global button reset (SPEC GF2). */
const RESET = buttonReset(false);

/** The global button reset's hover rule (SPEC GF2). */
const RESET_HOVER = buttonReset(true);

/** Top-level rules whose colours this change owns (SPEC GF2). */
const OWN_RULES = Object.freeze([
  '.pill',
  '#map',
  'th',
  'thead th',
  '.chat-panel',
  '.chat-tablist-wrapper',
  '.chat-tab',
  '.chat-tab.is-active',
  '.chat-empty',
  '.chat-entry-msg',
  '.short-info-overlay',
  '.node-detail-overlay__dialog',
  RESET,
  RESET_HOVER,
  '.protocol-toggle-btn',
  '.protocol-toggle-btn[aria-pressed="true"]',
  '.protocol-toggle-btn:hover',
  'label',
  '.app-footer',
  '.federation-page__map-row',
  '.federation-page__map-row #map',
  '.nodes-group-header th',
  '.node-extra-toggle, .identity-disclosure',
  '.node-extra-toggle:hover, .identity-disclosure:hover',
]);

/**
 * The swapped declarations as `[selector, property, value]`. A `null` value
 * is a colour longhand that overrode the shorthand before it in the same
 * rule; it is folded into the shorthand and must be gone (SPEC GF2, GF3).
 */
const SWAPS = Object.freeze([
  ['.pill', 'background', 'var(--line-strong)'],
  ['#map', 'border', '1px solid var(--line-strong)'],
  ['#map', 'border-color', null],
  ['th', 'background', 'var(--panel)'],
  ['.chat-panel', 'border', '1px solid var(--line-strong)'],
  ['.chat-panel', 'border-color', null],
  ['.chat-panel', 'background', 'var(--panel)'],
  ['.chat-panel', 'color', 'var(--fg)'],
  ['.chat-tablist-wrapper', 'border-bottom', '1px solid var(--line-strong)'],
  ['.chat-tablist-wrapper', 'border-bottom-color', null],
  ['.chat-tab', 'color', 'var(--fg)'],
  ['.chat-tab.is-active', 'background', 'var(--panel)'],
  ['.chat-empty', 'color', 'var(--muted)'],
  ['.chat-entry-msg', 'color', 'var(--fg-soft)'],
  ['.short-info-overlay', 'background', 'var(--panel)'],
  ['.short-info-overlay', 'color', 'var(--fg)'],
  ['.short-info-overlay', 'border', '1px solid var(--line-strong)'],
  ['.short-info-overlay', 'border-color', null],
  [RESET, 'border', '1px solid var(--line-strong)'],
  [RESET, 'border-color', null],
  [RESET, 'background', 'var(--input-bg)'],
  [RESET, 'color', 'var(--fg)'],
  [RESET_HOVER, 'background', 'var(--line-strong)'],
  ['.protocol-toggle-btn', 'border', '1px solid var(--line-strong)'],
  ['.protocol-toggle-btn', 'border-color', null],
  ['.protocol-toggle-btn', 'background', 'var(--input-bg)'],
  ['.protocol-toggle-btn:hover', 'background', 'var(--line-strong)'],
  ['label', 'color', 'var(--fg)'],
  ['.app-footer', 'background', 'var(--panel)'],
  ['.app-footer', 'border-top', '1px solid var(--line-strong)'],
  ['.app-footer', 'color', 'var(--fg)'],
  ['.node-extra-toggle, .identity-disclosure', 'border', '1px solid var(--line-strong)'],
  ['.node-extra-toggle, .identity-disclosure', 'background', 'var(--input-bg)'],
  ['.node-extra-toggle, .identity-disclosure', 'color', 'var(--fg)'],
  ['.node-extra-toggle:hover, .identity-disclosure:hover', 'background', 'var(--line-strong)'],
]);

test(':root declares the grey-family tokens (GF1)', () => {
  const declared = Object.fromEntries(Object.keys(TOKENS).map(name => [name, ROOT_TOKENS.get(name)]));
  assert.deepEqual(declared, TOKENS);
});

test('no neutral grey literal is left in the rules this change owns (GF2)', () => {
  const hits = OWN_RULES.flatMap(selector =>
    cssRules(selector).flatMap(rule => (rule.body.match(NEUTRAL_GREY) || []).map(hex => `${selector}: ${hex}`)),
  );
  assert.deepEqual(hits, []);
});

test('each swapped declaration names its token, with no colour longhand after a shorthand (GF2, GF3)', () => {
  const declared = SWAPS.map(([selector, property]) => [selector, property, cssValue(selector, property)]);
  assert.deepEqual(declared, SWAPS);
});

test('both nodes-table header rows share one opaque background (GF4)', () => {
  assert.equal(cssValue('thead th', 'background'), 'var(--table-head-bg)');
  assert.equal(cssValue('.nodes-group-header th', 'background'), 'var(--table-head-bg)');
  assert.match(
    resolveToken('var(--table-head-bg)'),
    /^#[0-9a-f]{6}$/i,
    'a translucent sticky header shows the rows scrolled beneath it',
  );
});

test('the node detail dialog is a border-box panel with a hairline edge (GF5)', () => {
  const dialog = '.node-detail-overlay__dialog';
  assert.equal(cssValue(dialog, 'box-sizing'), 'border-box', 'its 90vw and 90vh include padding and border');
  assert.equal(cssValue(dialog, 'background'), 'var(--panel)');
  assert.equal(cssValue(dialog, 'border'), '1px solid var(--line-strong)');
});

test('the federation map row is 50vh tall, at least 320px, and draws the only border (GF6)', () => {
  const row = '.federation-page__map-row';
  assert.equal(cssValue(row, 'height'), '50vh');
  assert.equal(cssValue(row, 'min-height'), '320px');
  assert.equal(cssValue(row, 'border'), '1px solid var(--line-strong)');
  assert.equal(cssValue(`${row} #map`, 'border'), '0', 'the map inside the row draws no second border');
  assert.equal(cssValue(`${row} #map`, 'border-radius'), '0');
});

test('#map counts its border inside its width, so /map does not scroll sideways (GF6)', () => {
  assert.equal(cssValue('#map', 'box-sizing'), 'border-box');
  assert.equal(cssValue('.chat-panel', 'box-sizing'), 'border-box', 'the chat panel beside the map keeps its bottom edge level');
});
