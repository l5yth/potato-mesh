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
  parseMeshcoreSenderPrefix,
  findNodeByLongName,
  extractLeadingMentionAsReply,
} from '../meshcore-chat-helpers.js';

// ---------------------------------------------------------------------------
// parseMeshcoreSenderPrefix
// ---------------------------------------------------------------------------

test('parseMeshcoreSenderPrefix: typical message', () => {
  const result = parseMeshcoreSenderPrefix('T114-Zeh: Hello world');
  assert.deepEqual(result, { senderName: 'T114-Zeh', bodyText: 'Hello world' });
});

test('parseMeshcoreSenderPrefix: trims whitespace around sender and body', () => {
  const result = parseMeshcoreSenderPrefix('  Alice : body text  ');
  assert.deepEqual(result, { senderName: 'Alice', bodyText: 'body text' });
});

test('parseMeshcoreSenderPrefix: empty body after colon', () => {
  const result = parseMeshcoreSenderPrefix('Sender:');
  assert.deepEqual(result, { senderName: 'Sender', bodyText: '' });
});

test('parseMeshcoreSenderPrefix: no colon returns null', () => {
  assert.equal(parseMeshcoreSenderPrefix('No colon here'), null);
});

test('parseMeshcoreSenderPrefix: empty string returns null', () => {
  assert.equal(parseMeshcoreSenderPrefix(''), null);
});

test('parseMeshcoreSenderPrefix: null input returns null', () => {
  assert.equal(parseMeshcoreSenderPrefix(null), null);
});

test('parseMeshcoreSenderPrefix: undefined input returns null', () => {
  assert.equal(parseMeshcoreSenderPrefix(undefined), null);
});

test('parseMeshcoreSenderPrefix: non-string input returns null', () => {
  assert.equal(parseMeshcoreSenderPrefix(42), null);
});

test('parseMeshcoreSenderPrefix: colon first (empty sender) returns null', () => {
  assert.equal(parseMeshcoreSenderPrefix(':body'), null);
});

test('parseMeshcoreSenderPrefix: whitespace-only sender returns null', () => {
  assert.equal(parseMeshcoreSenderPrefix('   : body'), null);
});

test('parseMeshcoreSenderPrefix: only first colon separates sender from body', () => {
  const result = parseMeshcoreSenderPrefix('A:B:C');
  assert.deepEqual(result, { senderName: 'A', bodyText: 'B:C' });
});

test('parseMeshcoreSenderPrefix: colons in body are preserved intact', () => {
  const result = parseMeshcoreSenderPrefix('BGruenauBot/OBS+: ack @[T114-Zeh] | 80,42,68 (3 hops) | 62.6km');
  assert.deepEqual(result, {
    senderName: 'BGruenauBot/OBS+',
    bodyText: 'ack @[T114-Zeh] | 80,42,68 (3 hops) | 62.6km',
  });
});

test('parseMeshcoreSenderPrefix: sender with slash and plus preserved', () => {
  const result = parseMeshcoreSenderPrefix('mEDI | Linux: Pong! T114-Zeh');
  assert.deepEqual(result, { senderName: 'mEDI | Linux', bodyText: 'Pong! T114-Zeh' });
});

// ---------------------------------------------------------------------------
// findNodeByLongName
// ---------------------------------------------------------------------------

/** Shared single-entry map used across the findNodeByLongName tests below. */
function makeAliceMap(nodeOverride = {}) {
  const node = { node_id: '!aabbccdd', long_name: 'Alice', ...nodeOverride };
  return { node, map: new Map([['!aabbccdd', node]]) };
}

test('findNodeByLongName: exact match on snake_case long_name', () => {
  const { node, map } = makeAliceMap();
  assert.equal(findNodeByLongName('Alice', map), node);
});

test('findNodeByLongName: exact match on camelCase longName', () => {
  const node = { node_id: '!aabbccdd', longName: 'Alice', role: 'CLIENT' };
  const map = new Map([['!aabbccdd', node]]);
  assert.equal(findNodeByLongName('Alice', map), node);
});

test('findNodeByLongName: no match returns null', () => {
  const { map } = makeAliceMap();
  assert.equal(findNodeByLongName('Unknown', map), null);
});

test('findNodeByLongName: null longName returns null', () => {
  const { map } = makeAliceMap();
  assert.equal(findNodeByLongName(null, map), null);
});

test('findNodeByLongName: undefined longName returns null', () => {
  const { map } = makeAliceMap();
  assert.equal(findNodeByLongName(undefined, map), null);
});

test('findNodeByLongName: empty string longName returns null', () => {
  const { map } = makeAliceMap();
  assert.equal(findNodeByLongName('', map), null);
});

test('findNodeByLongName: non-Map nodesById returns null', () => {
  assert.equal(findNodeByLongName('Alice', {}), null);
});

test('findNodeByLongName: array nodesById returns null', () => {
  assert.equal(findNodeByLongName('Alice', []), null);
});

test('findNodeByLongName: empty Map returns null', () => {
  assert.equal(findNodeByLongName('Alice', new Map()), null);
});

test('findNodeByLongName: case-sensitive — lowercase mismatch returns null', () => {
  const { map } = makeAliceMap();
  assert.equal(findNodeByLongName('alice', map), null);
});

test('findNodeByLongName: multiple nodes — returns correct one', () => {
  const nodeA = { node_id: '!11111111', long_name: 'Alpha' };
  const nodeB = { node_id: '!22222222', long_name: 'Beta' };
  const map = new Map([['!11111111', nodeA], ['!22222222', nodeB]]);
  assert.equal(findNodeByLongName('Beta', map), nodeB);
  assert.equal(findNodeByLongName('Alpha', map), nodeA);
});

test('findNodeByLongName: prefers snake_case when both properties exist', () => {
  const node = { node_id: '!aabbccdd', long_name: 'Alice', longName: 'Different' };
  const map = new Map([['!aabbccdd', node]]);
  // long_name takes precedence via the ?? chain; should match 'Alice'
  assert.equal(findNodeByLongName('Alice', map), node);
  assert.equal(findNodeByLongName('Different', map), null);
});

test('findNodeByLongName: node with null long_name is skipped', () => {
  const node = { node_id: '!aabbccdd', long_name: null };
  const map = new Map([['!aabbccdd', node]]);
  assert.equal(findNodeByLongName('Alice', map), null);
});

// ---------------------------------------------------------------------------
// findNodeByLongName — whitespace trimming and emoji-prefix fallback (#727)
// ---------------------------------------------------------------------------

test('findNodeByLongName: trims trailing whitespace in input', () => {
  const node = { node_id: '!deadbeef', long_name: 'T-deck NK' };
  const map = new Map([['!deadbeef', node]]);
  assert.equal(findNodeByLongName('T-deck NK ', map), node);
});

test('findNodeByLongName: trims leading whitespace in input', () => {
  const node = { node_id: '!deadbeef', long_name: 'Alice' };
  const map = new Map([['!deadbeef', node]]);
  assert.equal(findNodeByLongName(' Alice', map), node);
});

test('findNodeByLongName: trims whitespace from candidate long_name', () => {
  const node = { node_id: '!deadbeef', long_name: '  T-deck NK  ' };
  const map = new Map([['!deadbeef', node]]);
  assert.equal(findNodeByLongName('T-deck NK', map), node);
});

test('findNodeByLongName: matches when candidate has leading emoji prefix', () => {
  const node = { node_id: '!6aee769f', long_name: '\u{1F4FA} Timo +' };
  const map = new Map([['!6aee769f', node]]);
  // "Timo +" (from @[Timo +]) should match "\u{1F4FA} Timo +" via the
  // leading-non-letter-stripping fallback pass.
  assert.equal(findNodeByLongName('Timo +', map), node);
});

test('findNodeByLongName: emoji-prefix fallback combined with trimming', () => {
  const node = { node_id: '!6aee769f', long_name: '\u{1F4FA} Timo +' };
  const map = new Map([['!6aee769f', node]]);
  assert.equal(findNodeByLongName(' Timo +', map), node);
});

test('findNodeByLongName: emoji-prefix fallback preserves exact-match precedence', () => {
  // When both a prefixed and non-prefixed node match, the exact match wins.
  const prefixed = { node_id: '!11111111', long_name: '\u{1F4FA} Alice' };
  const exact = { node_id: '!22222222', long_name: 'Alice' };
  const map = new Map([['!11111111', prefixed], ['!22222222', exact]]);
  assert.equal(findNodeByLongName('Alice', map), exact);
});

test('findNodeByLongName: whitespace-only input returns null', () => {
  const { map } = makeAliceMap();
  assert.equal(findNodeByLongName('   ', map), null);
});

// ---------------------------------------------------------------------------
// extractLeadingMentionAsReply — MeshCore leading-mention detection (#727)
// ---------------------------------------------------------------------------

test('extractLeadingMentionAsReply: single leading mention with body', () => {
  assert.deepEqual(
    extractLeadingMentionAsReply('@[Alice] hello world'),
    { mentionName: 'Alice', remainingText: 'hello world' },
  );
});

test('extractLeadingMentionAsReply: single leading mention with no body', () => {
  assert.deepEqual(
    extractLeadingMentionAsReply('@[Alice]'),
    { mentionName: 'Alice', remainingText: null },
  );
});

test('extractLeadingMentionAsReply: trims mention name whitespace', () => {
  assert.deepEqual(
    extractLeadingMentionAsReply('@[ Timo +] hello'),
    { mentionName: 'Timo +', remainingText: 'hello' },
  );
});

test('extractLeadingMentionAsReply: trims trailing whitespace in mention name', () => {
  assert.deepEqual(
    extractLeadingMentionAsReply('@[T-deck NK ] some text'),
    { mentionName: 'T-deck NK', remainingText: 'some text' },
  );
});

test('extractLeadingMentionAsReply: mention not at start returns null', () => {
  assert.equal(extractLeadingMentionAsReply('hello @[Alice]'), null);
});

test('extractLeadingMentionAsReply: multiple mentions returns null', () => {
  assert.equal(extractLeadingMentionAsReply('@[Alice] hi @[Bob]'), null);
});

test('extractLeadingMentionAsReply: empty string returns null', () => {
  assert.equal(extractLeadingMentionAsReply(''), null);
});

test('extractLeadingMentionAsReply: null input returns null', () => {
  assert.equal(extractLeadingMentionAsReply(null), null);
});

test('extractLeadingMentionAsReply: non-string input returns null', () => {
  assert.equal(extractLeadingMentionAsReply(42), null);
  assert.equal(extractLeadingMentionAsReply({}), null);
});

test('extractLeadingMentionAsReply: plain text returns null', () => {
  assert.equal(extractLeadingMentionAsReply('just a plain message'), null);
});

test('extractLeadingMentionAsReply: empty mention name returns null', () => {
  assert.equal(extractLeadingMentionAsReply('@[  ] body'), null);
});

test('extractLeadingMentionAsReply: leading whitespace before mention is allowed', () => {
  assert.deepEqual(
    extractLeadingMentionAsReply('   @[Alice] hello'),
    { mentionName: 'Alice', remainingText: 'hello' },
  );
});
