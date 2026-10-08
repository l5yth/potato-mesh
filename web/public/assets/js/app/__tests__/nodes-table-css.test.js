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
 * Nodes-table stylesheet rules from design review rc3 (SPEC DV1, DV2, DV9):
 * the muted header unit, the long-name underline scoped to row hover and
 * keyboard focus, and the phone density that keeps the table inside its
 * column without making its wrapper a scroll container.
 *
 * @module app/__tests__/nodes-table-css
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_CSS_RULES, cssRules, cssValue } from './base-css-rules.js';

/** The selector list of the phone density rule. */
const PHONE_CELLS = '#nodes thead th, #nodes tbody td, #nodes .nodes-group-header th';

/** The row-hover and keyboard-focus selector list of the long-name underline. */
const LINK_SHOWN = '#nodes tbody tr:hover .node-long-link, #nodes .node-long-link:focus-visible';

test('the unit in a numeric column header is muted (DV1)', () => {
  assert.equal(cssValue('#nodes .nodes-col__unit', 'color'), 'var(--muted)');
});

test('a table long name is underlined only on row hover or keyboard focus (DV2)', () => {
  assert.equal(cssValue('#nodes .node-long-link', 'text-decoration-line'), 'none');
  assert.equal(cssValue(LINK_SHOWN, 'text-decoration-line'), 'underline');
  // Longhands only: the shorthand would also reset the 1px / 2px thickness
  // the shared rules give the link at rest and on its own hover.
  assert.equal(cssValue('#nodes .node-long-link', 'text-decoration'), null);
  assert.equal(cssValue(LINK_SHOWN, 'text-decoration'), null);
  assert.equal(cssValue('.node-long-link', 'text-decoration'), 'underline', 'long names outside the table stay underlined');
});

test('at <= 659px the table cells take 4px inline padding, after the density rules they override (DV9)', () => {
  const phone = BASE_CSS_RULES.find(rule => rule.media === '(max-width: 659px)' && rule.selector === PHONE_CELLS);
  assert.ok(phone, `a (max-width: 659px) block holds ${PHONE_CELLS}`);
  assert.equal(phone.declarations['padding-inline'], '4px');
  // Equal specificity: the phone rule wins only by coming later.
  for (const selector of ['#nodes thead th', '#nodes tbody td', '#nodes .nodes-group-header th']) {
    const [density] = cssRules(selector);
    assert.ok(BASE_CSS_RULES.indexOf(density) < BASE_CSS_RULES.indexOf(phone), `${selector} precedes the phone rule`);
  }
});

test('the nodes-table wrapper never becomes a scroll container (FU10, DR-A8)', () => {
  // A scrolling or clipping wrapper would become the sticky header's
  // scrollport, so the header rows would stop pinning to the window, and it
  // would take the page scroll the reader-place fallback adjusts.
  const wrapperRules = BASE_CSS_RULES.filter(rule => rule.selectors.includes('.nodes-table-wrapper'));
  assert.ok(wrapperRules.length > 0, 'base.css styles .nodes-table-wrapper');
  for (const rule of wrapperRules) {
    for (const property of ['overflow', 'overflow-x', 'overflow-y']) {
      assert.equal(property in rule.declarations, false, `.nodes-table-wrapper sets no ${property}`);
    }
  }
});
