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

// Regression guard for audit findings D-026/D-027 (SPEC UX11 / ACCEPTANCE
// UX-A9): the vital-sign line promotes the day count in plain words, and the
// federation nav count explains itself with a tooltip.

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatActiveNodeStatsText, formatActiveNodeStatsHtml } from '../stats.js';
import { __test__ as instanceSelectorTest, wireInstanceSelectorToggle } from '../instance-selector.js';

test('the stats line reads as words, day count first', () => {
  const stats = { hour: 12, day: 249, week: 1000, month: 1000 };
  assert.equal(formatActiveNodeStatsText({ stats }), '249 nodes today · 1000 this week');
});

test('the stats html emphasises the day figure', () => {
  const stats = { day: 249, week: 1000 };
  const html = formatActiveNodeStatsHtml({ stats });
  assert.ok(html.includes('meta-active-nodes__today'), 'day segment is styleable');
  assert.ok(html.includes('249 nodes today'));
  assert.ok(html.includes('1000 this week'));
});

test('zero and missing stats degrade to zeros', () => {
  assert.equal(
    formatActiveNodeStatsText({ stats: null }),
    '0 nodes today · 0 this week',
  );
});

test('the region toggle reveals and hides the select on demand (SPEC UX11)', () => {
  let clickHandler = null;
  const attrs = {};
  const toggle = {
    addEventListener: (event, handler) => {
      if (event === 'click') clickHandler = handler;
    },
    setAttribute: (name, value) => {
      attrs[name] = value;
    },
  };
  let focused = 0;
  const select = { hidden: true, focus: () => { focused += 1; } };
  const doc = { getElementById: id => (id === 'instanceSelectToggle' ? toggle : null) };
  wireInstanceSelectorToggle(doc, select);
  assert.equal(typeof clickHandler, 'function');
  clickHandler();
  assert.equal(select.hidden, false, 'first activation reveals the select');
  assert.equal(attrs['aria-expanded'], 'true');
  assert.equal(focused, 1, 'the revealed select receives focus');
  clickHandler();
  assert.equal(select.hidden, true, 'second activation hides it again');
  assert.equal(attrs['aria-expanded'], 'false');
});

test('the region toggle wiring tolerates missing elements', () => {
  assert.doesNotThrow(() => wireInstanceSelectorToggle(null, {}));
  assert.doesNotThrow(() => wireInstanceSelectorToggle({ getElementById: () => null }, {}));
  assert.doesNotThrow(() =>
    wireInstanceSelectorToggle({ getElementById: () => ({}) }, { hidden: true }));
});

test('the federation nav count carries an explanatory tooltip', () => {
  const attrs = {};
  const link = {
    dataset: { federationLabel: 'Federation' },
    textContent: 'Federation',
    setAttribute: (name, value) => {
      attrs[name] = value;
    },
  };
  const documentObject = {
    querySelectorAll: () => [link],
  };
  instanceSelectorTest.updateFederationNavCount({ documentObject, count: 20 });
  assert.equal(link.textContent, 'Federation (20)');
  assert.equal(attrs.title, '20 federated instances');
});
