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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SCOPE_UNKNOWN,
  SCOPE_UNKNOWN_LABEL,
  SCOPE_UNSCOPED,
  formatChatRouteChip,
  formatRouteDetails,
  routeHopCount,
  routeScopeLabel,
  splitRoutePath,
} from '../chat-route-chip.js';
import { renderMessages } from '../node-page/messages.js';
import { withApp, innerHtml } from './main-app-test-helpers.js';

/** A MeshCore channel message with every route field (SPEC SC7). */
const ROUTED = Object.freeze({
  id: 765,
  text: 'Alice: hello scope',
  rx_time: 1_791_280_000,
  protocol: 'meshcore',
  hops: 3,
  path: 'f0bf44',
  scope: 'de-be',
  snr: 10,
  rssi: -96,
});

const DETAILS = 'Path f0 → bf → 44 · SNR 10 dB · RSSI -96 dBm';

// --- value helpers ---

test('routeHopCount accepts non-negative integers only', () => {
  for (const value of [null, undefined, '', true, false, -1, 1.5, 'x', Number.NaN]) {
    assert.equal(routeHopCount(value), null, `${String(value)} is not a hop count`);
  }
  assert.equal(routeHopCount(0), 0);
  assert.equal(routeHopCount(3), 3);
  assert.equal(routeHopCount('4'), 4);
});

test('routeScopeLabel names a region, says "scoped" for the unknown value, and hides unscoped', () => {
  assert.equal(SCOPE_UNSCOPED, '*');
  assert.equal(SCOPE_UNKNOWN, '?');
  assert.equal(SCOPE_UNKNOWN_LABEL, 'scoped');
  assert.equal(routeScopeLabel('de-be'), 'de-be');
  assert.equal(routeScopeLabel('?'), 'scoped');
  for (const value of ['*', '', null, undefined, 7]) {
    assert.equal(routeScopeLabel(value), null);
  }
});

test('splitRoutePath splits the route into per-repeater hashes in travel order', () => {
  assert.deepEqual(splitRoutePath('f0bf44', 3), ['f0', 'bf', '44']);
  assert.deepEqual(splitRoutePath('f0a1bf02', 2), ['f0a1', 'bf02']);
  assert.deepEqual(splitRoutePath('', 3), []);
  assert.deepEqual(splitRoutePath(null, 3), []);
});

test('splitRoutePath returns a route that does not divide into whole hashes unchanged', () => {
  for (const [route, hops] of [
    ['f0bf44', 2],
    ['f0bf4', 1],
    ['f0bf44', 4],
    ['f0bf', 0],
    ['f0bf', null],
    ['zzzz', 2],
  ]) {
    assert.deepEqual(splitRoutePath(route, hops), [route], `${route}/${hops}`);
  }
});

test('formatRouteDetails lists path hashes, then SNR, then RSSI', () => {
  assert.equal(formatRouteDetails(ROUTED), DETAILS);
  assert.equal(formatRouteDetails({ hops: 0, snr: 5.25, rssi: -50 }), 'SNR 5.25 dB · RSSI -50 dBm');
  assert.equal(formatRouteDetails({ hops: 2, path: 'f0bf' }), 'Path f0 → bf');
  assert.equal(formatRouteDetails({ snr: true, rssi: '', path: '' }), '');
  assert.equal(formatRouteDetails({ snr: 'x', rssi: Number.POSITIVE_INFINITY }), '');
  assert.equal(formatRouteDetails(null), '');
});

// --- formatChatRouteChip ---

test('formatChatRouteChip shows hops and the region name, with the route in title and aria-label', () => {
  assert.equal(
    formatChatRouteChip(ROUTED),
    ` <span class="chat-route-chip" role="group" title="${DETAILS}" aria-label="${DETAILS}">3 hops · de-be</span>`,
  );
});

test('formatChatRouteChip says "scoped" for the unknown region and nothing for unscoped', () => {
  assert.match(formatChatRouteChip({ ...ROUTED, scope: '?' }), />3 hops · scoped</);
  assert.match(formatChatRouteChip({ ...ROUTED, scope: '*' }), />3 hops</);
  assert.match(formatChatRouteChip({ ...ROUTED, scope: undefined }), />3 hops</);
});

test('formatChatRouteChip shows for any protocol with hops, Meshtastic included', () => {
  assert.equal(
    formatChatRouteChip({ protocol: 'meshtastic', hops: 1, snr: -7.5, rssi: -110 }),
    ' <span class="chat-route-chip" role="group" title="SNR -7.5 dB · RSSI -110 dBm"'
      + ' aria-label="SNR -7.5 dB · RSSI -110 dBm">1 hop</span>',
  );
  assert.equal(formatChatRouteChip({ hops: 0 }), ' <span class="chat-route-chip">0 hops</span>');
});

test('formatChatRouteChip renders nothing without a hop count', () => {
  assert.equal(formatChatRouteChip({ ...ROUTED, hops: null }), '');
  assert.equal(formatChatRouteChip({ text: 'legacy' }), '');
  assert.equal(formatChatRouteChip(null), '');
});

test('formatChatRouteChip escapes the untrusted scope and path', () => {
  const html = formatChatRouteChip({ hops: 1, scope: '<b>x</b>', path: '"><i>' });
  assert.ok(!html.includes('<b>') && !html.includes('<i>'), html);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /title="Path &quot;&gt;&lt;i&gt;"/);
});

// --- shared by the dashboard and the node page ---

/**
 * Render a message through the node page's chat log.
 *
 * @param {Object} message Message payload.
 * @returns {string} The rendered HTML.
 */
function nodePageHtml(message) {
  const node = { shortName: 'ALI', longName: 'Alice', role: 'COMPANION', nodeId: '!aabbccdd', protocol: 'meshcore' };
  return renderMessages(
    [{ ...message, node: { short_name: 'ALI', role: 'COMPANION', protocol: 'meshcore' } }],
    (short) => `<span class="short-name">${short}</span>`,
    node,
  );
}

test('the dashboard chat line carries the chip after the sender badge, outside the prefix', () => {
  withApp((t) => {
    const html = innerHtml(
      t.createMessageChatEntry({ ...ROUTED, node: { short_name: 'ALI', role: 'COMPANION', protocol: 'meshcore' } }),
    );
    const chip = html.indexOf('class="chat-route-chip"');
    assert.ok(chip > html.indexOf('short-name'), 'chip follows the sender badge');
    assert.ok(chip < html.indexOf('hello scope'), 'chip precedes the message text');
    assert.match(html, /^\[[^\]]*\]\[[^\]]*\]\[[^\]]*\] /, 'the bracketed 19ch prefix is unchanged');
    assert.ok(html.includes('>3 hops · de-be</span>'));
  });
});

test('the dashboard chat line has no chip without hops', () => {
  withApp((t) => {
    const html = innerHtml(t.createMessageChatEntry({ text: 'hello', rx_time: 1000, node: { short_name: 'ALI' } }));
    assert.ok(!html.includes('chat-route-chip'), html);
  });
});

test('the node page renders the same chip after the sender badge', () => {
  const html = nodePageHtml(ROUTED);
  const chip = html.indexOf(formatChatRouteChip(ROUTED));
  assert.ok(chip > html.indexOf('short-name'), 'chip follows the sender badge');
  assert.ok(chip < html.indexOf('hello scope'), 'chip precedes the message text');
  assert.ok(!nodePageHtml({ ...ROUTED, hops: undefined }).includes('chat-route-chip'));
});

test('base.css keeps the chip out of the hanging indent', () => {
  const cssPath = fileURLToPath(new URL('../../../styles/base.css', import.meta.url));
  const rule = readFileSync(cssPath, 'utf8').match(/\.chat-route-chip \{[^}]*\}/);
  assert.ok(rule, '.chat-route-chip rule exists');
  assert.match(rule[0], /text-indent: 0;/);
  assert.match(rule[0], /display: inline-block;/);
  assert.doesNotMatch(rule[0], /white-space: nowrap/, 'a long region name may wrap (LC3)');
});
