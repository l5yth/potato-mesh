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

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderSatsInViewBadge, resolveSatsInView, __testUtils } from '../short-info-satellites.js';

const { toPositiveInteger } = __testUtils;

test('resolveSatsInView inspects aliases and nested payloads', () => {
  assert.equal(resolveSatsInView({ sats_in_view: '3.6' }), 4);
  assert.equal(resolveSatsInView({ position: { satsInView: 5 } }), 5);
  assert.equal(resolveSatsInView({ rawSources: { position: { sats_in_view: 9 } } }), 9);
  assert.equal(resolveSatsInView({ satsInView: 0 }), null);
  assert.equal(resolveSatsInView(null), null);
});

test('renderSatsInViewBadge returns markup only for positive counts', () => {
  const html = renderSatsInViewBadge({ satsInView: 6 });
  assert.match(html, /short-info-sats/);
  assert.ok(html.includes('satellite-icon.svg'));
  assert.match(html, />6</);

  assert.equal(renderSatsInViewBadge({ satsInView: 0 }), '');
  assert.equal(renderSatsInViewBadge({ position: { sats_in_view: -1 } }), '');
});

test('toPositiveInteger normalizes numeric values defensively', () => {
  assert.equal(toPositiveInteger('7.2'), 7);
  assert.equal(toPositiveInteger(''), null);
  assert.equal(toPositiveInteger(-3), null);
  assert.equal(toPositiveInteger(NaN), null);
});
