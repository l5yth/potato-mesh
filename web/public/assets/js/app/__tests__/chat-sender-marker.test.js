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
  SENDER_UNVERIFIED_LABEL,
  SENDER_UNVERIFIED_TEXT,
  formatChatSenderMarker,
  isSenderUnverified,
} from '../chat-sender-marker.js';
import { renderMessages } from '../node-page/messages.js';
import { withApp, innerHtml } from './main-app-test-helpers.js';

/** A MeshCore channel line as ``GET /api/messages`` serves it (SPEC SV2). */
const NAMED = Object.freeze({
  id: 401,
  text: 'Alice: see you at the hut',
  rx_time: 1_791_280_000,
  protocol: 'meshcore',
  to_id: '^all',
  from_id: '!a11ce001',
  node_id: '!a11ce001',
  hops: 2,
  sender_verified: false,
});

/** A Meshtastic line: its sender comes from the packet, so no flag. */
const MESHTASTIC = Object.freeze({
  id: 402,
  text: 'Alice: hello',
  rx_time: 1_791_280_000,
  protocol: 'meshtastic',
  to_id: '^all',
  from_id: '!0badc0de',
  node_id: '!0badc0de',
  hops: 1,
});

/** The hydrated sender node the dashboard attaches to a line. */
const ALICE_NODE = Object.freeze({ short_name: 'ALCE', role: 'COMPANION', protocol: 'meshcore' });

const MARKER = ' <span class="chat-sender-unverified" title="Sender not verified">unverified</span>';

/**
 * Badge renderer standing in for the dashboard's ``renderShortHtml``.
 *
 * @param {string} short Short name.
 * @returns {string} Badge HTML.
 */
function badge(short) {
  return `<span class="short-name">${short}</span>`;
}

// --- the module ---

test('the marker shows "unverified", titled "Sender not verified"', () => {
  assert.equal(SENDER_UNVERIFIED_TEXT, 'unverified');
  assert.equal(SENDER_UNVERIFIED_LABEL, 'Sender not verified');
});

test('isSenderUnverified is true only for sender_verified false or a badge named from the text', () => {
  assert.equal(isSenderUnverified(NAMED), true);
  assert.equal(isSenderUnverified(MESHTASTIC), false);
  for (const value of [undefined, null, true, 0, '', 'false']) {
    assert.equal(isSenderUnverified({ ...NAMED, sender_verified: value }), false, `${String(value)} is not the flag`);
  }
  for (const value of [null, undefined, 'x', 42]) {
    assert.equal(isSenderUnverified(value), false, `${String(value)} is no message`);
  }
  assert.equal(isSenderUnverified({ ...MESHTASTIC }, { senderFromText: true }), true);
  assert.equal(isSenderUnverified(MESHTASTIC, { senderFromText: false }), false);
  assert.equal(isSenderUnverified(MESHTASTIC, {}), false);
});

test('formatChatSenderMarker renders a titled "unverified" chip with a leading space', () => {
  assert.equal(formatChatSenderMarker(NAMED), MARKER);
  assert.equal(formatChatSenderMarker(MESHTASTIC, { senderFromText: true }), MARKER);
});

test('formatChatSenderMarker renders nothing for a sender from an id the packet carries', () => {
  assert.equal(formatChatSenderMarker(MESHTASTIC), '');
  assert.equal(formatChatSenderMarker({ ...NAMED, sender_verified: undefined }), '');
  assert.equal(formatChatSenderMarker(null), '');
});

// --- the dashboard chat line ---

test('the dashboard chat line marks the sender after the badge and before the route chip, outside the prefix', () => {
  withApp((t) => {
    const html = innerHtml(t.createMessageChatEntry({ ...NAMED, node: ALICE_NODE }));
    const marker = html.indexOf(MARKER);
    assert.ok(marker > html.indexOf('short-name'), 'marker follows the sender badge');
    assert.ok(marker < html.indexOf('class="chat-route-chip"'), 'marker precedes the route chip');
    assert.ok(marker < html.indexOf('see you at the hut'), 'marker precedes the text');
    assert.match(html, /^\[[^\]]*\]\[[^\]]*\]\[[^\]]*\] /, 'the bracketed 19ch prefix is unchanged');
  });
});

test('the dashboard chat line has no marker for a Meshtastic sender or an unflagged MeshCore line', () => {
  withApp((t) => {
    const meshtastic = innerHtml(t.createMessageChatEntry({ ...MESHTASTIC, node: { short_name: 'BOB' } }));
    assert.ok(!meshtastic.includes('chat-sender-unverified'), meshtastic);
    const unflagged = innerHtml(
      t.createMessageChatEntry({ ...NAMED, sender_verified: undefined, node: ALICE_NODE }),
    );
    assert.ok(!unflagged.includes('chat-sender-unverified'), unflagged);
  });
});

test('the dashboard marks a MeshCore channel line whose badge it named from the text itself', () => {
  withApp((t) => {
    // An ingestor before 0.6.0 posts a channel line with no sender id; the
    // renderer then names the badge from the "Alice:" prefix on its own.
    const html = innerHtml(t.createMessageChatEntry({
      id: 403,
      text: 'Alice: no sender id',
      rx_time: 1_791_280_000,
      protocol: 'meshcore',
      to_id: '^all',
      node: null,
    }));
    assert.ok(html.indexOf(MARKER) > html.indexOf('short-name'), html);
  });
});

// --- the node page ---

test('the node page marks the sender after the badge and before the route chip', () => {
  const node = { shortName: 'ALCE', longName: 'Alice', role: 'COMPANION', nodeId: '!a11ce001', protocol: 'meshcore' };
  const html = renderMessages([{ ...NAMED, node: ALICE_NODE }], badge, node);
  const marker = html.indexOf(MARKER);
  assert.ok(marker > html.indexOf('short-name'), 'marker follows the sender badge');
  assert.ok(marker < html.indexOf('class="chat-route-chip"'), 'marker precedes the route chip');
  assert.ok(marker < html.indexOf('see you at the hut'), 'marker precedes the text');
  // The node page names a MeshCore channel badge from the text when the line
  // carries no hydrated node; that badge is marked too.
  const fromText = renderMessages([{ ...NAMED, sender_verified: undefined }], badge, node);
  assert.ok(fromText.indexOf(MARKER) > fromText.indexOf('short-name'), fromText);
});

test('the node page has no marker for a Meshtastic sender', () => {
  const node = { shortName: 'BOB', longName: 'Bob', role: 'CLIENT', nodeId: '!0badc0de', protocol: 'meshtastic' };
  const html = renderMessages([{ ...MESHTASTIC, node: { short_name: 'BOB' } }], badge, node);
  assert.ok(html.includes('short-name') && !html.includes('chat-sender-unverified'), html);
});

// --- the stylesheet ---

test('base.css keeps the marker out of the hanging indent and lets the line wrap', () => {
  const cssPath = fileURLToPath(new URL('../../../styles/base.css', import.meta.url));
  const rule = readFileSync(cssPath, 'utf8').match(/\.chat-sender-unverified \{[^}]*\}/);
  assert.ok(rule, '.chat-sender-unverified rule exists');
  assert.match(rule[0], /text-indent: 0;/);
  assert.match(rule[0], /display: inline-block;/);
  assert.doesNotMatch(rule[0], /white-space: nowrap/, 'the line may wrap (LC3)');
});
