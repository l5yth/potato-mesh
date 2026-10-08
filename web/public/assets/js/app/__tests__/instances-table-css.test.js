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
 * The federation table's density (SPEC DV5, design review rc3 F1): the
 * nodes table's 12px type with 5px 8px cells. Zebra rows already come from
 * the shared `tbody` rule, so no `.row-alt` rule is added.
 *
 * @module app/__tests__/instances-table-css
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_CSS_RULES, cssValue } from './base-css-rules.js';

test('the federation table runs at 12px with 5px 8px cells (DV5)', () => {
  assert.equal(cssValue('#instances', 'font-size'), '12px');
  assert.equal(cssValue('#instances th, #instances td', 'padding'), '5px 8px');
});

test('federation zebra rows come from the shared tbody rule; #instances has no .row-alt rule (DV5)', () => {
  assert.equal(cssValue('tbody tr:nth-child(even) td', 'background'), 'var(--row-alt)');
  // `.row-alt` is the nodes table's own stripe (its hidden disclosure rows
  // break nth-child); the federation renderer never stamps it.
  const instancesRowAlt = BASE_CSS_RULES.filter(rule =>
    rule.selectors.some(selector => selector.startsWith('#instances') && selector.includes('.row-alt')));
  assert.deepEqual(instancesRowAlt, []);
});
