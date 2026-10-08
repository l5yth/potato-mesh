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
 * The legend's quiet default (SPEC ML1): a shown role chip is plain text, a
 * hidden one is muted and struck through, and Clear filters turns accent
 * while a filter is active.
 *
 * The generic button reset outranked every chip rule since #900, so the CSS
 * half is checked on base.css; the DOM half checks that the legend sets the
 * attributes those rules key on.
 *
 * @module app/__tests__/legend-pressed-cascade
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_CSS_RULES, declarationsFor, rulesFor } from './base-css-rules.js';
import { bootLegendApp } from './legend-app-harness.js';

/**
 * The generic button reset and its hover rule.
 *
 * @returns {Array<Object>} Both rules, from {@link BASE_CSS_RULES}.
 */
const resetRules = () =>
  BASE_CSS_RULES.filter(rule => rule.selectors.some(selector => selector.startsWith('button:not(.chat-tab)')));

test('the generic button reset leaves the legend chips to their own rules (ML1, LC2)', () => {
  const rules = resetRules();
  assert.equal(rules.length, 2, 'the reset and its :hover');
  for (const rule of rules) {
    assert.ok(rule.selectors.every(selector => selector.includes(':not(.legend-item)')), rule.selectors.join(', '));
  }
});

test('a shown chip is plain: no fill or border colour, weight 400 (ML1)', () => {
  const rules = rulesFor('button.legend-item[aria-pressed="true"]');
  assert.equal(rules.length, 1, 'one shown-chip rule');
  assert.deepEqual(rules[0].declarations, { 'font-weight': '400' });
});

test('a hidden chip is muted and struck through, its swatch faded to 0.35 (ML1)', () => {
  const hidden = declarationsFor('button.legend-item[aria-pressed="false"]');
  assert.equal(hidden.color, 'var(--muted)');
  assert.equal(hidden['text-decoration'], 'line-through');
  assert.equal(declarationsFor('button.legend-item[aria-pressed="false"] .legend-swatch').opacity, '0.35');
});

test('Clear filters takes the accent colour while a filter is active (ML1)', () => {
  assert.equal(declarationsFor('#mapLegend[data-has-active-filters] .legend-reset').color, 'var(--accent)');
});

test('the legend sets the attributes the chip rules key on, and Clear filters keeps its label (ML1, LP1)', async () => {
  const app = await bootLegendApp({ leaflet: true });
  try {
    const chip = app.protocolElements.meshtastic.children.find(child => child.dataset.role === 'ROUTER');
    const reset = app.legend.children.find(child => child.className === 'legend-toggle').children[0];
    assert.equal(reset.className, 'legend-item legend-reset');
    assert.equal(chip.getAttribute('aria-pressed'), 'true', 'a shown role is pressed');
    assert.equal(app.legend.getAttribute('data-has-active-filters'), null, 'nothing filtered');
    await app.clickRoleChip('meshtastic', 'ROUTER');
    assert.equal(chip.getAttribute('aria-pressed'), 'false', 'a hidden role is not pressed');
    assert.equal(app.legend.getAttribute('data-has-active-filters'), 'true', 'the panel marks the active filter');
    assert.equal(reset.textContent, 'Clear filters');
    await app.clickClearFilters();
    assert.equal(chip.getAttribute('aria-pressed'), 'true');
    assert.equal(app.legend.getAttribute('data-has-active-filters'), null);
  } finally {
    await app.cleanup();
  }
});
