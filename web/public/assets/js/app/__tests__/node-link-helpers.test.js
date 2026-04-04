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
  escapeHtml,
  normalizeNodeNameValue,
  buildNodeDetailHref,
  canonicalNodeIdentifier,
  renderNodeLongNameLink,
} from '../main.js';

// --- escapeHtml ---

test('escapeHtml escapes & < > " and single-quote', () => {
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
});

test('escapeHtml coerces non-strings', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), 'null');
});

// --- normalizeNodeNameValue ---

test('normalizeNodeNameValue returns empty string for null/undefined', () => {
  assert.equal(normalizeNodeNameValue(null), '');
  assert.equal(normalizeNodeNameValue(undefined), '');
});

test('normalizeNodeNameValue trims whitespace', () => {
  assert.equal(normalizeNodeNameValue('  Alice  '), 'Alice');
});

test('normalizeNodeNameValue returns empty string for whitespace-only', () => {
  assert.equal(normalizeNodeNameValue('   '), '');
});

// --- buildNodeDetailHref ---

test('buildNodeDetailHref returns null for null/undefined', () => {
  assert.equal(buildNodeDetailHref(null), null);
  assert.equal(buildNodeDetailHref(undefined), null);
});

test('buildNodeDetailHref returns null for empty/whitespace string', () => {
  assert.equal(buildNodeDetailHref(''), null);
  assert.equal(buildNodeDetailHref('  '), null);
});

test('buildNodeDetailHref strips leading ! before encoding', () => {
  assert.equal(buildNodeDetailHref('!abc123'), '/nodes/!abc123');
});

test('buildNodeDetailHref adds ! prefix when absent', () => {
  assert.equal(buildNodeDetailHref('abc123'), '/nodes/!abc123');
});

// --- canonicalNodeIdentifier ---

test('canonicalNodeIdentifier returns null for null/undefined', () => {
  assert.equal(canonicalNodeIdentifier(null), null);
  assert.equal(canonicalNodeIdentifier(undefined), null);
});

test('canonicalNodeIdentifier preserves existing ! prefix', () => {
  assert.equal(canonicalNodeIdentifier('!abc123'), '!abc123');
});

test('canonicalNodeIdentifier adds ! prefix when absent', () => {
  assert.equal(canonicalNodeIdentifier('abc123'), '!abc123');
});

// --- renderNodeLongNameLink ---

test('renderNodeLongNameLink returns empty string for null/empty longName', () => {
  assert.equal(renderNodeLongNameLink(null, '!abc123'), '');
  assert.equal(renderNodeLongNameLink('', '!abc123'), '');
  assert.equal(renderNodeLongNameLink('   ', '!abc123'), '');
});

test('renderNodeLongNameLink shows no icon for null protocol', () => {
  const html = renderNodeLongNameLink('Alice', '!abc123', { protocol: null });
  assert.ok(!html.includes('meshtastic.svg'), 'no meshtastic icon for null protocol');
  assert.ok(!html.includes('meshcore.svg'), 'no meshcore icon for null protocol');
  assert.ok(html.includes('Alice'), 'should include the name');
});

test('renderNodeLongNameLink prepends Meshtastic icon for "meshtastic" protocol', () => {
  const html = renderNodeLongNameLink('Alice', '!abc123', { protocol: 'meshtastic' });
  assert.ok(html.includes('meshtastic.svg'), 'should include meshtastic icon');
});

test('renderNodeLongNameLink shows no icon for absent protocol (default)', () => {
  const html = renderNodeLongNameLink('Alice', '!abc123');
  assert.ok(!html.includes('meshtastic.svg'), 'no meshtastic icon when protocol is absent');
  assert.ok(!html.includes('meshcore.svg'), 'no meshcore icon when protocol is absent');
});

test('renderNodeLongNameLink does not prepend icon for "meshcore" protocol', () => {
  const html = renderNodeLongNameLink('Alice', '!abc123', { protocol: 'meshcore' });
  assert.ok(!html.includes('meshtastic.svg'), 'should not include meshtastic icon for meshcore');
  assert.ok(html.includes('Alice'), 'should still include the name');
});

test('renderNodeLongNameLink does not prepend icon for unknown protocol', () => {
  const html = renderNodeLongNameLink('Alice', '!abc123', { protocol: 'reticulum' });
  assert.ok(!html.includes('meshtastic.svg'), 'should not include meshtastic icon for unknown protocol');
});

test('renderNodeLongNameLink renders anchor with href when identifier is present', () => {
  const html = renderNodeLongNameLink('Alice', '!abc123', { protocol: null });
  assert.ok(html.startsWith('<a '), 'should be an anchor element');
  assert.ok(html.includes('href="/nodes/!abc123"'), 'should include correct href');
  assert.ok(html.includes('class="node-long-link"'), 'should include CSS class');
  assert.ok(html.includes('data-node-detail-link="true"'), 'should include detail link attribute');
  assert.ok(html.includes('data-node-id="!abc123"'), 'should include node id attribute');
});

test('renderNodeLongNameLink renders plain text (no icon) when no identifier and null protocol', () => {
  const html = renderNodeLongNameLink('Alice', null, { protocol: null });
  assert.ok(!html.startsWith('<a '), 'should not be an anchor');
  assert.ok(html.includes('Alice'), 'should include the name');
  assert.ok(!html.includes('meshtastic.svg'), 'no meshtastic icon for null protocol');
  assert.ok(!html.includes('meshcore.svg'), 'no meshcore icon for null protocol');
});

test('renderNodeLongNameLink escapes HTML in long name', () => {
  const html = renderNodeLongNameLink('<evil>', '!abc123', { protocol: 'meshcore' });
  assert.ok(html.includes('&lt;evil&gt;'), 'should escape < and >');
  assert.ok(!html.includes('<evil>'), 'should not include raw HTML');
});

test('renderNodeLongNameLink uses custom className', () => {
  const html = renderNodeLongNameLink('Alice', '!abc123', { className: 'custom-class', protocol: null });
  assert.ok(html.includes('class="custom-class"'), 'should use the provided class');
});

test('renderNodeLongNameLink omits class attribute on anchor when className is empty', () => {
  const html = renderNodeLongNameLink('Alice', '!abc123', { className: '', protocol: null });
  // Extract just the opening <a> tag to avoid matching the icon's own class attribute.
  const aTag = html.match(/^<a([^>]*)>/)?.[1] ?? '';
  assert.ok(!aTag.includes('class='), 'anchor should have no class attribute when className is empty');
});
