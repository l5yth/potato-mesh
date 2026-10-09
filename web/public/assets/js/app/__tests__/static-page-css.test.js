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
 * Static page (`/pages/*`) stylesheet rules from design review rc3: page code
 * uses the app's one monospace stack (SPEC DV7), and the page fills its column
 * so a wide `pre` scrolls inside it instead of widening the page (SPEC DV8).
 * From the rc4 phone-overflow fix: inline code may break anywhere (SPEC PO2),
 * and a table wider than the column scrolls inside its own wrapper (SPEC PO3).
 *
 * @module app/__tests__/static-page-css
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_CSS, BASE_CSS_RULES, cssRules, cssValue, declarationsFor } from './base-css-rules.js';

test('markdown code uses the app monospace stack and no other stack is left (DV7)', () => {
  assert.equal(cssValue('.markdown-body code', 'font-family'), cssValue('.mono', 'font-family'));
  assert.equal(cssValue('.markdown-body code', 'font-family'), 'ui-monospace, Menlo, Consolas, monospace');
  assert.doesNotMatch(BASE_CSS, /SF Mono|Fira Code|Cascadia Code/);
});

test('a static page fills its column, padding included, and its pre scrolls inside (DV8)', () => {
  const sized = cssRules('.static-page').filter(rule => 'width' in rule.declarations);
  assert.equal(sized.length, 1, 'one .static-page rule sets the width');
  assert.equal(sized[0].declarations.width, '100%');
  assert.equal(sized[0].declarations['box-sizing'], 'border-box');
  assert.equal(cssValue('.markdown-body pre', 'overflow-x'), 'auto');
});

test('inline code may break anywhere, while a pre keeps white-space: pre and its own scroll (PO2)', () => {
  assert.equal(cssValue('.markdown-body code', 'overflow-wrap'), 'anywhere');
  // overflow-wrap acts only where white-space lets a line wrap: no static-page
  // rule changes white-space, so the code in a pre keeps one line per source
  // line and the pre scrolls inside (DV8).
  const markdown = BASE_CSS_RULES.filter(rule => rule.selectors.some(selector => selector.startsWith('.markdown-body')));
  assert.equal(markdown.some(rule => 'white-space' in rule.declarations), false, 'no .markdown-body rule sets white-space');
  assert.equal(cssValue('.markdown-body pre', 'overflow-x'), 'auto');
});

test('a static-page table scrolls inside its own wrapper and keeps its table display (PO3)', () => {
  // pages.rb wraps every table; the wrapper takes the table's margin and font
  // size and the sideways scroll, so the table still fills the column at 100%.
  assert.deepEqual(declarationsFor('.markdown-body .markdown-table-wrapper'), {
    margin: '1em 0',
    'font-size': '0.9em',
    'overflow-x': 'auto',
  });
  const table = declarationsFor('.markdown-body table');
  assert.equal(table.width, '100%');
  for (const property of ['display', 'overflow', 'overflow-x', 'max-width', 'margin', 'font-size']) {
    assert.equal(property in table, false, `.markdown-body table sets no ${property}`);
  }
});
