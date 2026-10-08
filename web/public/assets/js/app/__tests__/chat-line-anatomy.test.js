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
 * The chat message line of the design review rc3 (C1, SPEC CD1-CD4): the
 * time leads in a 5ch column with seconds, frequency and preset in its title,
 * a tab whose lines share one radio drops their `[freq][preset]` tag and
 * protocol icon, the route follows the text as quiet text, and a reply reads
 * `↩ BADGE`. A tab that turns mixed rebuilds its lines once through the entry
 * cache. The node page keeps its date-bearing time.
 *
 * @module __tests__/chat-line-anatomy
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as chatFormat from '../chat-format.js';
import { buildChatTabModel } from '../chat-log-tabs.js';
import * as messageReplies from '../message-replies.js';
import { renderMessages } from '../node-page/messages.js';
import { escapeHtml } from '../utils.js';
import { innerHtml, withApp } from './main-app-test-helpers.js';
import { runLiveApp } from './sse-app-harness.js';
import { declarationsFor } from './base-css-rules.js';

/** 08:01:12 local time on 2026-10-08, Unix seconds. */
const RX_TIME = Math.floor(new Date(2026, 9, 8, 8, 1, 12).getTime() / 1000);

/** A Meshtastic line with a route (SPEC SC7) on 869 MHz, MediumFast. */
const LINE = Object.freeze({
  id: 7,
  text: 'hello mesh',
  rx_time: RX_TIME,
  lora_freq: 869,
  modem_preset: 'MediumFast',
  protocol: 'meshtastic',
  hops: 2,
  snr: 3.5,
  rssi: -92,
  node: { short_name: 'ALI', role: 'CLIENT', protocol: 'meshtastic' },
});

/** The time slot of {@link LINE}. */
const TIME = '<span class="chat-entry-time" title="08:01:12 · 869 MHz · MediumFast">08:01</span>';

/** The hidden unverified marker of SPEC SV3. */
const MARKER = '<span class="chat-sender-unverified" title="Sender not verified" hidden>unverified</span>';

/**
 * The body of a rendered line: the HTML after the time slot.
 *
 * @param {string} html Line HTML.
 * @returns {string} Contents of `.chat-entry-body`.
 */
function bodyOf(html) {
  const open = '<span class="chat-entry-body">';
  assert.ok(html.includes(open), html);
  assert.ok(html.endsWith('</span>'), html);
  return html.slice(html.indexOf(open) + open.length, -'</span>'.length);
}

/**
 * Badge renderer standing in for `renderShortHtml`.
 *
 * @param {string} short Short name.
 * @returns {string} Badge HTML.
 */
function badge(short) {
  return `<span class="short-name">${short}</span>`;
}

/** Now, Unix seconds: the dashboard lists only the last seven days. */
const NOW = Math.floor(Date.now() / 1000);

/**
 * A dashboard row from `!a` on 869 MHz MediumFast, received `100 - id`
 * seconds ago. Channel 0 is unnamed, any other channel is "Alpha".
 *
 * @param {number} id Message id.
 * @param {number} channel Channel index.
 * @param {string} text Message text.
 * @param {Object} [overrides] Fields to replace.
 * @returns {Object} Message row.
 */
function dashboardRow(id, channel, text, overrides = {}) {
  return {
    id,
    channel,
    channel_name: channel === 0 ? null : 'Alpha',
    from_id: '!a',
    to_id: '^all',
    text,
    rx_time: NOW - 100 + id,
    lora_freq: 869,
    modem_preset: 'MediumFast',
    protocol: 'meshtastic',
    ...overrides,
  };
}

/**
 * Boot the dashboard on `messages` through the shared live-app harness, which
 * settles the first load before `fn` and the refresh tails after it. The stub
 * fetch serves the array itself, so a row pushed onto it arrives with the
 * next refresh.
 *
 * @param {Array<Object>} messages Rows `/api/messages` answers with.
 * @param {function({ app: Object, bodiesOf: function(string): Array<string> }): Promise<void>} fn
 *   Test body. `app` is the app's `_testUtils`; `bodiesOf(text)` lists, in
 *   order, the bodies of the message lines whose HTML includes `text`.
 * @returns {Promise<void>} Settles once `fn` has and the app is torn down.
 */
async function withDashboard(messages, fn) {
  const responses = {
    '/api/messages': messages,
    '/api/nodes': [{ node_id: '!a', short_name: 'ALI', long_name: 'Alice', role: 'CLIENT', last_heard: NOW, protocol: 'meshtastic' }],
  };
  await runLiveApp({ responses }, async ({ testUtils: app }) => {
    const bodiesOf = text => globalThis.document.getElementById('chat').children[1].children
      .flatMap(panel => panel.children.filter(node => node.className === 'chat-entry-msg'))
      .map(node => innerHtml(node))
      .filter(html => html.includes(text))
      .map(html => bodyOf(html));
    await fn({ app, bodiesOf });
  });
}

// --- the dashboard line ---

test('a line on a one-radio tab leads with HH:MM, its title carrying seconds, frequency and preset (CD1, CD2)', () => {
  withApp((t) => {
    const html = innerHtml(t.createMessageChatEntry(LINE, { uniform: true }));
    assert.ok(html.startsWith(`${TIME} <span class="chat-entry-body"><span class="short-name"`), html);
    const body = bodyOf(html);
    assert.ok(!body.includes('[869]') && !body.includes('[MF]'), 'no radio tag');
    assert.ok(!body.includes('protocol-icon'), 'no protocol icon');
  });
});

test('a Log or mixed-tab line keeps its radio tag and protocol icon at the start of its body (CD2, RL3)', () => {
  withApp((t) => {
    const html = innerHtml(t.createMessageChatEntry(LINE));
    assert.ok(html.startsWith(`${TIME} <span class="chat-entry-body">[869][MF] <img `), html);
    assert.match(bodyOf(html), /^\[869\]\[MF\] <img [^>]*protocol-icon--meshtastic[^>]*> <span class="short-name"/);
  });
});

test('the route follows the message text, and "??" keeps its own "unknown scope" span (CD3, SC7)', () => {
  withApp((t) => {
    const html = innerHtml(t.createMessageChatEntry({
      ...LINE,
      protocol: 'meshcore',
      to_id: '^all',
      scope: '?',
      node: { short_name: 'SPTR', role: 'COMPANION', protocol: 'meshcore' },
    }));
    const body = bodyOf(html);
    assert.ok(body.indexOf('class="chat-route-chip"') > body.indexOf('hello mesh'), 'route after the text');
    assert.ok(body.endsWith('>2 hops · <span title="unknown scope">??</span></span>'), body);
  });
});

test('the hidden unverified marker still sits right after the sender badge (SV3)', () => {
  withApp((t) => {
    const html = innerHtml(t.createMessageChatEntry({
      ...LINE,
      protocol: 'meshcore',
      to_id: '^all',
      sender_verified: false,
      node: { short_name: 'SPTR', role: 'COMPANION', protocol: 'meshcore' },
    }, { uniform: true }));
    const badgeEnd = html.indexOf('</span>', html.indexOf('class="short-name"')) + '</span>'.length;
    assert.equal(html.indexOf(MARKER), badgeEnd, html);
    assert.ok(html.includes(`${MARKER} hello mesh <span class="chat-route-chip"`), html);
  });
});

test('a leading-mention reply reads "↩ BADGE" and keeps "in reply to" for assistive technology (CD4)', () => {
  withApp((t) => {
    const html = innerHtml(t.createMessageChatEntry({
      id: 9,
      text: 'Bob: @[Alice] thanks!',
      rx_time: RX_TIME,
      protocol: 'meshcore',
      to_id: '^all',
      node: { short_name: 'BOB', role: 'COMPANION', protocol: 'meshcore' },
    }));
    assert.ok(!html.includes('[in reply to'), html);
    assert.match(
      html,
      /<span class="chat-entry-reply" title="in reply to Alice"><span class="visually-hidden">in reply to <\/span><span aria-hidden="true">↩<\/span> <span class="short-name"[^>]*>[^<]*<\/span><\/span> thanks!/,
    );
  });
});

test('a reply_id reply reads "↩ BADGE", titled with the parent sender\'s name (CD4)', () => {
  const html = messageReplies.resolveReplyPrefix({
    message: { id: 2, reply_id: 1 },
    messagesById: new Map([['1', { id: 1, node: { short_name: 'GATE', long_name: 'Gate Router', role: 'ROUTER' } }]]),
    nodesById: new Map(),
    renderShortHtml: badge,
    escapeHtml,
  });
  assert.equal(
    html,
    '<span class="chat-entry-reply" title="in reply to Gate Router"><span class="visually-hidden">in reply to </span>'
      + '<span aria-hidden="true">↩</span> <span class="short-name">GATE</span></span>',
  );
  const unnamed = messageReplies.resolveReplyPrefix({
    message: { id: 3, reply_id: 4 },
    messagesById: new Map([['4', { id: 4, from_id: '!0000beef' }]]),
    nodesById: new Map(),
    renderShortHtml: badge,
    escapeHtml,
  });
  assert.ok(unnamed.startsWith('<span class="chat-entry-reply" title="in reply to BEEF">'), unnamed);
});

test('a reply without a sender name is titled "in reply to", and a name is escaped (CD4)', () => {
  const { formatReplyPrefixHtml } = messageReplies;
  assert.equal(typeof formatReplyPrefixHtml, 'function', 'message-replies.js exports formatReplyPrefixHtml');
  const badgeHtml = badge('GATE');
  const reply = title => `<span class="chat-entry-reply" title="${title}"><span class="visually-hidden">in reply to </span>`
    + '<span aria-hidden="true">↩</span> <span class="short-name">GATE</span></span>';
  assert.equal(formatReplyPrefixHtml({ badgeHtml, escapeHtml }), reply('in reply to'));
  assert.equal(formatReplyPrefixHtml({ badgeHtml, name: '', escapeHtml }), reply('in reply to'), 'an empty name is none');
  assert.equal(
    formatReplyPrefixHtml({ badgeHtml, name: 'Gate "Router" <1>', escapeHtml }),
    reply('in reply to Gate &quot;Router&quot; &lt;1&gt;'),
  );
});

// --- the line's helpers ---

test('formatChatEntryTime titles what the line knows and nothing else (CD1)', () => {
  const { formatChatEntryTime } = chatFormat;
  assert.equal(typeof formatChatEntryTime, 'function', 'chat-format.js exports formatChatEntryTime');
  assert.equal(formatChatEntryTime({ timestamp: '08:01:12' }), '<span class="chat-entry-time" title="08:01:12">08:01</span>');
  assert.equal(
    formatChatEntryTime({ timestamp: '08:01:12', frequency: '869.525', preset: null }),
    '<span class="chat-entry-time" title="08:01:12 · 869.525 MHz">08:01</span>',
  );
  assert.equal(
    formatChatEntryTime({ timestamp: '--:--:--', preset: 'EU/UK <Narrow>' }),
    '<span class="chat-entry-time" title="--:--:-- · EU/UK &lt;Narrow&gt;">--:--</span>',
  );
});

test('extractChatMessageMetadata names the preset for the time title (CD1)', () => {
  assert.equal(chatFormat.extractChatMessageMetadata({ modem_preset: 'MediumFast' }).presetName, 'MediumFast');
  assert.equal(
    chatFormat.extractChatMessageMetadata({ lora_freq: 869, modem_preset: 'SF8/BW62/CR8' }).presetName,
    'EU/UK Narrow',
  );
  assert.equal(chatFormat.extractChatMessageMetadata({ lora_freq: 869 }).presetName, null);
});

test('chatRadioKey is equal for lines that render the same radio tag and protocol icon (CD2)', () => {
  const { chatRadioKey } = chatFormat;
  assert.equal(typeof chatRadioKey, 'function', 'chat-format.js exports chatRadioKey');
  const key = chatRadioKey(LINE);
  assert.equal(chatRadioKey({ ...LINE, id: 8, text: 'other' }), key);
  assert.equal(chatRadioKey({ ...LINE, modem_preset: 'MEDIUM_FAST' }), key, 'same MF tag');
  assert.equal(chatRadioKey({ ...LINE, protocol: undefined }), key, 'protocol from the node');
  assert.notEqual(chatRadioKey({ ...LINE, lora_freq: 868 }), key);
  assert.notEqual(chatRadioKey({ ...LINE, modem_preset: 'LongFast' }), key);
  assert.notEqual(chatRadioKey({ ...LINE, protocol: 'meshcore', node: null }), key);
  assert.equal(chatRadioKey({ text: 'a' }), chatRadioKey({ text: 'b', protocol: ' ' }), 'neither knows its radio');
});

// --- the tab model ---

test('buildChatTabModel marks a tab uniform when every line shares frequency, preset and protocol (CD2)', () => {
  const now = RX_TIME + 60;
  const message = (id, channel, overrides = {}) => ({
    id,
    channel,
    channel_name: `ch${channel}`,
    from_id: '!a',
    to_id: '^all',
    text: `m${id}`,
    rx_time: RX_TIME + id,
    lora_freq: 869,
    modem_preset: 'MediumFast',
    protocol: 'meshtastic',
    ...overrides,
  });
  const { channels } = buildChatTabModel({
    messages: [
      message(1, 1),
      message(2, 1),
      message(3, 2),
      message(4, 2, { modem_preset: 'LongFast' }),
      message(5, 3),
      message(6, 3, { protocol: 'meshcore' }),
      message(7, 4, { lora_freq: 868 }),
    ],
    nowSeconds: now,
    windowSeconds: 3600,
  });
  const uniform = Object.fromEntries(channels.map(channel => [channel.label, channel.uniform]));
  assert.deepEqual(uniform, { ch1: true, ch2: false, ch3: false, ch4: true });
});

test('the dashboard drops the radio tag on a one-radio tab and keeps it on a mixed tab and in the Log (CD2)', async () => {
  const messages = [
    dashboardRow(1, 0, 'one radio a'),
    dashboardRow(2, 0, 'one radio b'),
    dashboardRow(3, 1, 'mixed a'),
    dashboardRow(4, 1, 'mixed b', { modem_preset: 'LongFast' }),
    dashboardRow(5, 2, 'q83vEjRWeJA=', { encrypted: true }),
  ];
  await withDashboard(messages, async ({ bodiesOf }) => {
    const lineWith = text => {
      const [body] = bodiesOf(text);
      assert.ok(body !== undefined, `a line shows "${text}"`);
      return body;
    };
    assert.ok(lineWith('one radio a').startsWith('<span class="short-name"'), 'one radio: no tag, no icon');
    assert.ok(lineWith('one radio b').startsWith('<span class="short-name"'));
    assert.ok(lineWith('mixed a').startsWith('[869][MF] <img '), 'mixed tab keeps the tag and icon');
    assert.ok(lineWith('mixed b').startsWith('[869][LF] <img '));
    assert.ok(lineWith('encrypted message').startsWith('[869][MF] <img '), 'the Log keeps the tag and icon');
  });
});

test('a tab that turns from one radio to mixed rebuilds its lines once, tagged, and an idle re-render builds none (CD2, CR-A1)', async () => {
  const messages = [1, 2, 3].map(id => dashboardRow(id, 1, `alpha ${id}`));
  await withDashboard(messages, async ({ app, bodiesOf }) => {
    assert.equal(bodiesOf('alpha').length, 3);
    assert.ok(bodiesOf('alpha').every(body => body.startsWith('<span class="short-name"')), 'one radio: no tag');

    messages.push(dashboardRow(4, 1, 'alpha 4', { modem_preset: 'LongFast' }));
    app.resetChatRenderStats();
    await app.refresh();
    assert.deepEqual(
      bodiesOf('alpha').map(body => body.slice(0, '[869][MF]'.length)),
      ['[869][MF]', '[869][MF]', '[869][MF]', '[869][LF]'],
      'the tab is mixed, so every line carries its tag',
    );
    assert.equal(app.getChatRenderStats().materialized, 5, 'the 3 lines rebuilt once, the new line and its Log entry');

    app.resetChatRenderStats();
    app.rerenderChatLog();
    assert.equal(app.getChatRenderStats().materialized, 0, 'an idle re-render builds no entry (CR-A1)');
  });
});

// --- the node page ---

test('the node page keeps its date-bearing time and leads the body with frequency, preset and channel (CD1)', () => {
  const node = { shortName: 'ALI', longName: 'Alice', role: 'CLIENT', nodeId: '!a', protocol: 'meshtastic' };
  const html = renderMessages([{ ...LINE, channel: 0 }], badge, node);
  assert.match(
    html,
    /<div class="chat-entry-msg"><span class="chat-entry-time">\[2026-10-08 08:01\]<\/span> <span class="chat-entry-body">\[869\]\[MF\]\[0\] <img [^>]*protocol-icon--meshtastic[^>]*> <span class="short-name">ALI<\/span> hello mesh <span class="chat-route-chip"[^>]*>2 hops<\/span><\/span><\/div>/,
  );
  assert.match(
    renderMessages([{ ...LINE, channel: 0, rx_time: null }], badge, node),
    /<div class="chat-entry-msg"><span class="chat-entry-time">\[\]<\/span> <span class="chat-entry-body">\[869\]\[MF\]\[0\] /,
    'a message with no time keeps an empty time slot',
  );
});

test('the node page renders a reply as "↩ BADGE" and the route after the text (CD3, CD4)', () => {
  const node = { shortName: 'BOB', longName: 'Bob', role: 'COMPANION', nodeId: '!b', protocol: 'meshcore' };
  const html = renderMessages([{
    id: 11,
    text: 'Bob: @[Alice] thanks!',
    rx_time: RX_TIME,
    protocol: 'meshcore',
    to_id: '^all',
    hops: 1,
    scope: 'de-be',
    node: { short_name: 'BOB', role: 'COMPANION', protocol: 'meshcore' },
  }], badge, node);
  assert.ok(!html.includes('[in reply to'), html);
  assert.ok(html.includes('<span aria-hidden="true">↩</span> <span class="short-name">'), html);
  assert.ok(html.indexOf('class="chat-route-chip"') > html.indexOf('thanks!'), 'route after the text');
});

// --- the stylesheet ---

test('base.css lays a message line out as a 5ch time column and one body column (CD1)', () => {
  const line = declarationsFor('.chat-entry-msg');
  assert.equal(line.display, 'grid');
  assert.equal(line['grid-template-columns'], '5ch minmax(0, 1fr)');
  assert.equal(line['column-gap'], '8px');
  assert.equal(line['padding-left'], undefined, 'no hanging indent on a message line');
  assert.equal(line['text-indent'], undefined);
  assert.equal(line['overflow-wrap'], 'anywhere', 'long tokens still wrap (LC3)');
  const time = declarationsFor('.chat-entry-time');
  assert.equal(time.color, 'var(--muted)');
  assert.equal(time['white-space'], 'nowrap');
  assert.equal(
    declarationsFor('.chat-panel--node-detail .chat-entry-msg')['grid-template-columns'],
    '18ch minmax(0, 1fr)',
    'the node page sizes its column for [YYYY-MM-DD HH:MM]',
  );
  const announcement = declarationsFor('.chat-entry-node');
  assert.equal(announcement['padding-left'], '19ch', 'a Log announcement keeps its 19ch hang (FU9)');
  assert.equal(announcement['text-indent'], '-19ch');
  assert.equal(announcement['overflow-wrap'], 'anywhere');
});

test('base.css renders the route as quiet --muted text after a middle dot (CD3, UX2)', () => {
  const chip = declarationsFor('.chat-route-chip');
  assert.equal(chip.color, 'var(--muted)');
  assert.equal(chip.border, '0');
  assert.equal(chip.padding, '0');
  assert.equal(chip.display, 'inline-block');
  assert.equal(chip['text-indent'], '0');
  assert.equal(chip['white-space'], undefined, 'a long region name may wrap (LC3)');
  assert.equal(declarationsFor('.chat-route-chip::before').content, '"· " / ""');
});

test('base.css keeps the reply quiet and its hidden label inside the line (CD4)', () => {
  const reply = declarationsFor('.chat-entry-reply');
  assert.equal(reply.position, 'relative', 'contains the absolutely positioned .visually-hidden label');
  assert.equal(reply.color, 'var(--muted)');
  assert.equal(reply['font-style'], undefined, 'the reply badge is not italic');
});
