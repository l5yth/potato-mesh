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
 * Node detail and chart stylesheet rules from design review rc3. The node page,
 * the dashboard's node overlay and /charts share these classes. One gutter
 * (SPEC DV4): the node page's own padding is the shell's 16px, and no block
 * inside it adds another; the chart `figure` loses the browser's 40px margin.
 * Chart HTML text runs at the app's sizes (SPEC DV6); the SVG axis text is
 * the restyle RD8 defers.
 *
 * @module app/__tests__/node-detail-css
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cssValue } from './base-css-rules.js';

/** Blocks inside the node detail view that used to add a 20px inline gutter. */
const INNER_BLOCKS = [
  '.node-detail__header',
  '.node-detail__charts',
  '.node-detail__content',
  '.node-detail__status, .node-detail__error, .node-detail__noscript',
];

test('the node page pads itself with the shell gutter, inside its width (DV4)', () => {
  assert.equal(cssValue('.node-detail', 'padding'), '24px var(--pad) 40px');
  assert.equal(cssValue('.node-detail', 'box-sizing'), 'border-box', 'width: 100% plus padding would overflow by 32px');
});

test('no block inside the node detail view adds an inline gutter of its own (DV4)', () => {
  for (const selector of INNER_BLOCKS) {
    assert.equal(cssValue(selector, 'padding-inline'), '0', selector);
    assert.equal(cssValue(selector, 'padding'), null, `${selector} declares no padding shorthand`);
  }
});

test('a chart figure has no margin of its own (DV4)', () => {
  assert.equal(cssValue('.node-detail__chart', 'margin'), '0');
});

test('chart HTML text runs at the app sizes; the SVG axis keeps its size for RD8 (DV6)', () => {
  assert.equal(cssValue('.node-detail__chart-header h4', 'font-size'), '15px');
  assert.equal(cssValue('.node-detail__chart-header span', 'font-size'), '12px');
  assert.equal(cssValue('.node-detail__chart-legend-item', 'font-size'), '12px');
  assert.equal(cssValue('.node-detail__chart-axis text, .node-detail__chart-axis-label', 'font-size'), '0.95rem');
});
