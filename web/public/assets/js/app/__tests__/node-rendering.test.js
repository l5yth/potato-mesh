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

import {
  normalizeNodeNameValue,
  buildNodeDetailHref,
  canonicalNodeIdentifier,
  renderNodeLongNameLink,
} from '../node-rendering.js';

// ---------------------------------------------------------------------------
// normalizeNodeNameValue
// ---------------------------------------------------------------------------

test('normalizeNodeNameValue trims whitespace', () => {
  assert.equal(normalizeNodeNameValue('  Alice  '), 'Alice');
});

test('normalizeNodeNameValue returns empty string for null', () => {
  assert.equal(normalizeNodeNameValue(null), '');
});

test('normalizeNodeNameValue returns empty string for undefined', () => {
  assert.equal(normalizeNodeNameValue(undefined), '');
});

test('normalizeNodeNameValue returns empty string for blank string', () => {
  assert.equal(normalizeNodeNameValue('   '), '');
});

test('normalizeNodeNameValue coerces non-string values via String()', () => {
  assert.equal(normalizeNodeNameValue(42), '42');
});

// ---------------------------------------------------------------------------
// buildNodeDetailHref
// ---------------------------------------------------------------------------

test('buildNodeDetailHref returns canonical path for identifier without prefix', () => {
  assert.equal(buildNodeDetailHref('aabbccdd'), '/nodes/!aabbccdd');
});

test('buildNodeDetailHref strips existing ! prefix before rebuilding path', () => {
  assert.equal(buildNodeDetailHref('!aabbccdd'), '/nodes/!aabbccdd');
});

test('buildNodeDetailHref returns null for null identifier', () => {
  assert.equal(buildNodeDetailHref(null), null);
});

test('buildNodeDetailHref returns null for blank identifier', () => {
  assert.equal(buildNodeDetailHref('   '), null);
});

test('buildNodeDetailHref returns null for empty string', () => {
  assert.equal(buildNodeDetailHref(''), null);
});

test('buildNodeDetailHref returns null when identifier is just "!"', () => {
  assert.equal(buildNodeDetailHref('!'), null);
});

test('buildNodeDetailHref percent-encodes special characters', () => {
  const href = buildNodeDetailHref('node/with spaces');
  assert.ok(href != null);
  assert.ok(!href.includes(' '), 'spaces should be encoded');
});

// ---------------------------------------------------------------------------
// canonicalNodeIdentifier
// ---------------------------------------------------------------------------

test('canonicalNodeIdentifier prepends ! when missing', () => {
  assert.equal(canonicalNodeIdentifier('aabbccdd'), '!aabbccdd');
});

test('canonicalNodeIdentifier preserves existing ! prefix', () => {
  assert.equal(canonicalNodeIdentifier('!aabbccdd'), '!aabbccdd');
});

test('canonicalNodeIdentifier returns null for null', () => {
  assert.equal(canonicalNodeIdentifier(null), null);
});

test('canonicalNodeIdentifier returns null for blank string', () => {
  assert.equal(canonicalNodeIdentifier('  '), null);
});

test('canonicalNodeIdentifier trims surrounding whitespace', () => {
  assert.equal(canonicalNodeIdentifier('  abc  '), '!abc');
});

// ---------------------------------------------------------------------------
// renderNodeLongNameLink
// ---------------------------------------------------------------------------

test('renderNodeLongNameLink returns empty string when longName is empty', () => {
  assert.equal(renderNodeLongNameLink('', '!abc'), '');
  assert.equal(renderNodeLongNameLink(null, '!abc'), '');
});

test('renderNodeLongNameLink renders anchor when identifier is present', () => {
  const html = renderNodeLongNameLink('Alice', '!aabbccdd');
  assert.ok(html.includes('<a'), 'should produce an anchor element');
  assert.ok(html.includes('href="/nodes/!aabbccdd"'), 'href should be set');
  assert.ok(html.includes('Alice'), 'long name should appear');
});

test('renderNodeLongNameLink renders meshtastic icon for null protocol', () => {
  const html = renderNodeLongNameLink('Alice', '!aabbccdd', { protocol: null });
  assert.ok(html.includes('meshtastic.svg'), 'meshtastic icon should be shown for null protocol');
});

test('renderNodeLongNameLink renders meshtastic icon when protocol is absent', () => {
  const html = renderNodeLongNameLink('Alice', '!aabbccdd');
  assert.ok(html.includes('meshtastic.svg'));
});

test('renderNodeLongNameLink omits meshtastic icon for meshcore protocol', () => {
  const html = renderNodeLongNameLink('Eve', '!aabbccdd', { protocol: 'meshcore' });
  assert.ok(!html.includes('meshtastic.svg'), 'no meshtastic icon for meshcore protocol');
});

test('renderNodeLongNameLink renders plain text when identifier is null', () => {
  const html = renderNodeLongNameLink('Alice', null);
  assert.ok(!html.includes('<a'), 'should not produce anchor without identifier');
  assert.ok(html.includes('Alice'), 'name should still appear');
});

test('renderNodeLongNameLink HTML-escapes the long name', () => {
  const html = renderNodeLongNameLink('<script>', '!abc');
  assert.ok(!html.includes('<script>'), 'raw script tag should not appear');
  assert.ok(html.includes('&lt;script&gt;'), 'should be escaped');
});

test('renderNodeLongNameLink applies default class attribute', () => {
  const html = renderNodeLongNameLink('Alice', '!abc');
  assert.ok(html.includes('class="node-long-link"'));
});

test('renderNodeLongNameLink respects custom className option', () => {
  const html = renderNodeLongNameLink('Alice', '!abc', { className: 'my-class' });
  assert.ok(html.includes('class="my-class"'));
});

test('renderNodeLongNameLink omits link class attribute when className is falsy', () => {
  const html = renderNodeLongNameLink('Alice', '!abc', { className: '' });
  assert.ok(!html.includes('class="node-long-link"'), 'default node-long-link class should not appear when className is empty');
});

test('renderNodeLongNameLink sets data-node-detail-link and data-node-id attributes', () => {
  const html = renderNodeLongNameLink('Alice', 'aabbccdd');
  assert.ok(html.includes('data-node-detail-link="true"'));
  assert.ok(html.includes('data-node-id="!aabbccdd"'));
});
