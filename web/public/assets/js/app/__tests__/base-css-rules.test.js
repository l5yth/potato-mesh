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
 * Unit tests for the shared base.css reader (SPEC GF7).
 *
 * @module app/__tests__/base-css-rules.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_CSS,
  BASE_CSS_RULES,
  TOP_LEVEL_RULES,
  cssRules,
  cssValue,
  declarationsFor,
  resolveToken,
  rulesFor,
} from './base-css-rules.js';

test('BASE_CSS carries no comments', () => {
  assert.equal(BASE_CSS.includes('/*'), false);
});

test('the parsed rules keep their @media condition and split selector lists', () => {
  assert.ok(BASE_CSS_RULES.some(rule => rule.media !== null), 'some rule sits under @media');
  assert.ok(BASE_CSS_RULES.every(rule => rule.selectors.length > 0 && rule.selector === rule.selectors.join(', ')));
  assert.ok(TOP_LEVEL_RULES.length > 0 && TOP_LEVEL_RULES.every(rule => rule.media === null));
});

test('the parsed rules keep their @supports condition, outside the top-level rules', () => {
  const conditional = BASE_CSS_RULES.filter(rule => rule.supports !== null);
  assert.ok(conditional.length > 0, 'some rule sits under @supports');
  assert.ok(BASE_CSS_RULES.every(rule => rule.supports === null || typeof rule.supports === 'string'));
  assert.ok(TOP_LEVEL_RULES.every(rule => rule.supports === null));
  const [rule] = conditional;
  assert.doesNotMatch(rule.supports, /^@supports|\{/, 'the condition alone, without the at-keyword or the block');
  const options = { media: rule.media, supports: rule.supports };
  assert.ok(rulesFor(rule.selectors[0], options).includes(rule));
  assert.equal(rulesFor(rule.selectors[0], { media: rule.media }).includes(rule), false);
  assert.equal(TOP_LEVEL_RULES.includes(rule), false);
});

test('rulesFor and declarationsFor read a selector at the top level or under one condition', () => {
  assert.ok(rulesFor(':root').length > 0);
  assert.deepEqual(rulesFor('.no-such-selector'), []);
  assert.deepEqual(declarationsFor('.no-such-selector'), {});
  assert.equal(declarationsFor(':root')['--bg'], cssValue(':root', '--bg'));
  const nested = BASE_CSS_RULES.find(rule => rule.media !== null && rule.supports === null);
  assert.ok(rulesFor(nested.selectors[0], { media: nested.media }).includes(nested));
  assert.equal(rulesFor(nested.selectors[0], { media: nested.media }).every(rule => rule.media === nested.media), true);
});

test('cssRules matches a whole selector list and fails for an unknown one', () => {
  assert.ok(cssRules(':root').length > 0);
  assert.throws(() => cssRules('.no-such-selector'), /base\.css has a top-level \.no-such-selector rule/);
});

test('cssValue gives the last declaration of a property, or null', () => {
  assert.equal(cssValue(':root', 'no-such-property'), null);
  assert.equal(typeof cssValue(':root', '--bg'), 'string');
});

test('resolveToken follows var() through :root and fails for an undeclared token', () => {
  assert.equal(resolveToken('1px'), '1px');
  assert.equal(resolveToken('var(--bg)'), resolveToken(cssValue(':root', '--bg')));
  assert.throws(() => resolveToken('var(--no-such-token)'), /:root declares --no-such-token/);
});
