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
 *
 * @module app/__tests__/static-page-css
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_CSS, cssRules, cssValue } from './base-css-rules.js';

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
