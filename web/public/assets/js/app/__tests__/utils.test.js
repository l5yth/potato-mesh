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

import { escapeHtml, normalizeString } from '../utils.js';

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

test('escapeHtml replaces ampersand', () => {
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
});

test('escapeHtml replaces less-than', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
});

test('escapeHtml replaces double-quote', () => {
  assert.equal(escapeHtml('"hello"'), '&quot;hello&quot;');
});

test('escapeHtml replaces single-quote', () => {
  assert.equal(escapeHtml("it's"), 'it&#39;s');
});

test('escapeHtml handles XSS payload', () => {
  const xss = '<img src=x onerror="alert(\'xss\')">';
  const escaped = escapeHtml(xss);
  assert.ok(!escaped.includes('<'), 'no raw angle brackets');
  assert.ok(!escaped.includes('"'), 'no raw double-quotes after escaping');
  assert.ok(escaped.includes('&lt;'), 'angle bracket encoded');
});

test('escapeHtml coerces non-string input via String()', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), 'null');
  assert.equal(escapeHtml(undefined), 'undefined');
});

test('escapeHtml returns empty string unchanged', () => {
  assert.equal(escapeHtml(''), '');
});

test('escapeHtml preserves text without special characters', () => {
  assert.equal(escapeHtml('hello world'), 'hello world');
});

test('escapeHtml escapes all five special characters in a single string', () => {
  const all = '& < > " \'';
  assert.equal(escapeHtml(all), '&amp; &lt; &gt; &quot; &#39;');
});

// ---------------------------------------------------------------------------
// normalizeString
// ---------------------------------------------------------------------------

test('normalizeString returns null for null', () => {
  assert.equal(normalizeString(null), null);
});

test('normalizeString returns null for undefined', () => {
  assert.equal(normalizeString(undefined), null);
});

test('normalizeString trims whitespace from strings', () => {
  assert.equal(normalizeString('  hello  '), 'hello');
});

test('normalizeString returns null for blank strings', () => {
  assert.equal(normalizeString('   '), null);
  assert.equal(normalizeString(''), null);
});

test('normalizeString converts finite numbers to strings', () => {
  assert.equal(normalizeString(42), '42');
  assert.equal(normalizeString(3.14), '3.14');
  assert.equal(normalizeString(0), '0');
  assert.equal(normalizeString(-5), '-5');
});

test('normalizeString returns null for non-finite numbers', () => {
  assert.equal(normalizeString(Infinity), null);
  assert.equal(normalizeString(-Infinity), null);
  assert.equal(normalizeString(NaN), null);
});

test('normalizeString returns null for objects', () => {
  assert.equal(normalizeString({}), null);
  assert.equal(normalizeString([]), null);
});

test('normalizeString returns null for booleans', () => {
  assert.equal(normalizeString(true), null);
  assert.equal(normalizeString(false), null);
});

test('normalizeString preserves non-empty strings after trimming', () => {
  assert.equal(normalizeString('a'), 'a');
  assert.equal(normalizeString('  x  '), 'x');
});
