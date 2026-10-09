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
 * The Log line of the design review rc4 (L1-L6, SPEC LA1-LA6): every Log
 * line takes the message grid, a kind word replaces the colour emoji, every
 * announcement reads `BADGE kind · detail`, a line that needs a radio tag
 * shows the preset code alone while the badge's shape carries the protocol,
 * and a new node's long name underlines only on hover or focus.
 *
 * @module __tests__/chat-log-anatomy
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as chatFormat from '../chat-format.js';
import { CHAT_LOG_ENTRY_TYPES, NODE_INFO_REASONS, buildChatTabModel } from '../chat-log-tabs.js';
import { renderShortHtml } from '../main/short-html-renderer.js';
import { renderRoleAwareBadge } from '../node-page/badge.js';
import { innerHtml, withApp } from './main-app-test-helpers.js';
import { runLiveApp } from './sse-app-harness.js';
import { ROOT_TOKENS, declarationsFor, resolveToken } from './base-css-rules.js';
import { visibleText as words } from './visible-text.js';

const { NODE_NEW, NODE_INFO, TELEMETRY, POSITION, NEIGHBOR, WAYPOINT, TRACE } = CHAT_LOG_ENTRY_TYPES;

/** 07:41:05 local time on 2026-10-08, Unix seconds. */
const T0 = Math.floor(new Date(2026, 9, 8, 7, 41, 5).getTime() / 1000);

/** Now, Unix seconds: the dashboard lists only the last seven days. */
const NOW = Math.floor(Date.now() / 1000);

/** A Meshtastic router on 869 MHz, MediumFast. */
const GATE = Object.freeze({
  node_id: '!0000ga7e',
  short_name: 'GATE',
  long_name: 'Gate router',
  role: 'ROUTER',
  protocol: 'meshtastic',
  lora_freq: 869,
  modem_preset: 'MediumFast',
});

/** A Meshtastic client, the neighbour and a trace hop. */
const CAMP = Object.freeze({ ...GATE, node_id: '!0000ca4e', short_name: 'CAMP', long_name: 'Camp repeater', role: 'CLIENT' });

/** A MeshCore companion on 869.525 MHz, EU/UK Narrow. */
const SPTR = Object.freeze({
  node_id: '!0000c0de',
  short_name: 'SPTR',
  long_name: 'Spotter',
  role: 'COMPANION',
  protocol: 'meshcore',
  lora_freq: 869.525,
  modem_preset: 'SF8/BW62/CR8',
});

/** A placeholder the server creates for an unheard trace hop: no radio. */
const PLACEHOLDER = Object.freeze({
  node_id: '!adbeadbe',
  short_name: 'ADBE',
  long_name: 'Meshtastic ADBE',
  role: 'CLIENT_HIDDEN',
  protocol: 'meshtastic',
});

/** The time slot of a line at {@link T0} on {@link GATE}'s radio. */
const TIME = '<span class="chat-entry-time" title="07:41:05 · 869 MHz · MediumFast">07:41</span>';

/** The radio code of {@link GATE}'s radio. */
const MF = '<span class="chat-entry-radio" title="869 MHz · MediumFast · Meshtastic">MF</span>';

/**
 * The body of a rendered line: the HTML after the time slot.
 *
 * @param {string} html Line HTML.
 * @returns {string} Contents of `.chat-entry-body`.
 */
function bodyOf(html) {
  const open = '<span class="chat-entry-body">';
  assert.ok(html.includes(open), html);
  return html.slice(html.indexOf(open) + open.length, -'</span>'.length);
}

/**
 * The line's HTML after its badge: the parts, or a message's text. It reads
 * a line with or without the body span of SPEC LA1, so a test of the words
 * fails on the words.
 *
 * @param {string} html Line HTML.
 * @returns {string} HTML after the first badge's closing tag and one space,
 *   without the body span's closing tag.
 */
function afterBadge(html) {
  const start = html.indexOf('<span class="short-name"');
  assert.ok(start >= 0, html);
  const rest = html.slice(html.indexOf('</span>', start) + '</span> '.length);
  return html.includes('<span class="chat-entry-body">') ? rest.slice(0, -'</span>'.length) : rest;
}

/**
 * Render a Log entry about {@link GATE} with the app's builders.
 *
 * @param {Object} t The app's `_testUtils`.
 * @param {string} type Entry type.
 * @param {Object} [extra] More entry fields.
 * @param {Object} [options] Builder options, such as `{ uniform: true }`.
 * @returns {{ className: string, html: string }} Entry parts.
 */
function logLine(t, type, extra = {}, options = {}) {
  return t.buildChatLogEntryParts({ type, ts: T0, node: GATE, nodeId: GATE.node_id, ...extra }, options);
}

// --- L1: one grid ---

test('a Log announcement leads with HH:MM in the message grid, titled with seconds, frequency and preset (LA1)', () => {
  withApp((t) => {
    const line = logLine(t, NODE_INFO, { reason: NODE_INFO_REASONS.ADVERT });
    assert.equal(line.className, 'chat-entry-node');
    assert.ok(line.html.startsWith(`${TIME} <span class="chat-entry-body">`), line.html);
    assert.ok(!line.html.includes('[07:41:05]') && !line.html.includes('[869]'), 'no [HH:MM:SS][freq][preset] prefix');
  });
  assert.equal('formatNodeAnnouncementPrefix' in chatFormat, false, 'the announcement prefix is retired');
});

test('base.css lays a Log announcement out in the message grid, with no hang, and keeps both colours (LA1)', () => {
  const announcement = declarationsFor('.chat-entry-node');
  const message = declarationsFor('.chat-entry-msg');
  for (const property of ['display', 'grid-template-columns', 'column-gap', 'overflow-wrap']) {
    assert.equal(announcement[property], message[property], `${property} as a message line`);
  }
  assert.equal(announcement['grid-template-columns'], '5ch minmax(0, 1fr)');
  assert.equal(announcement['padding-left'], undefined, 'no 19ch hang');
  assert.equal(announcement['text-indent'], undefined);
  assert.equal(announcement.color, 'var(--muted)', 'announcements stay muted');
  assert.equal(message.color, 'var(--fg-soft)', 'messages keep --fg-soft');
});

test('the Log drops every radio tag while its lines share one radio, and tags each line once they do not (LA1, CD2)', async () => {
  const meshtastic = { node_id: '!a', short_name: 'ALI', long_name: 'Alice', role: 'CLIENT', protocol: 'meshtastic', lora_freq: 869, modem_preset: 'MediumFast', first_heard: NOW - 90, last_heard: NOW - 80 };
  const nodes = [meshtastic];
  const encrypted = { id: 7, channel: 1, from_id: '!a', to_id: '^all', encrypted: true, text: 'q83vEjRWeJA=', rx_time: NOW - 70, protocol: 'meshtastic', lora_freq: 869, modem_preset: 'MediumFast' };
  const responses = { '/api/messages': [encrypted], '/api/nodes': nodes };
  await runLiveApp({ responses }, async ({ testUtils }) => {
    const logLines = () => globalThis.document.getElementById('chat').children[1].children[0].children
      .filter(node => /^chat-entry-(node|msg)$/.test(node.className))
      .map(node => innerHtml(node));
    assert.equal(logLines().length, 3, 'new node, node info and the encrypted line');
    assert.ok(logLines().every(html => !html.includes('chat-entry-radio')), 'one radio: no line carries a tag');

    nodes.push({ ...SPTR, node_id: '!c', first_heard: NOW - 60, last_heard: NOW - 50 });
    await testUtils.refresh();
    const lines = logLines();
    assert.equal(lines.length, 5);
    assert.ok(lines.slice(0, 3).every(html => bodyOf(html).startsWith(`${MF} <span class="short-name"`)), lines.join('\n'));
    assert.ok(
      lines.slice(3).every(html => bodyOf(html).startsWith('<span class="chat-entry-radio" title="869.525 MHz · EU/UK Narrow · MeshCore">NA</span> ')),
      lines.join('\n'),
    );
  });
});

// --- L2: kind words replace the emoji ---

test('each announcement follows its badge with a lowercase kind word, never an emoji (LA2)', () => {
  withApp((t) => {
    t.rebuildNodeIndex([GATE, CAMP]);
    const lines = {
      'new node': t.buildChatLogEntryParts({ type: NODE_NEW, ts: T0, node: GATE, nodeId: GATE.node_id }),
      'node info': logLine(t, NODE_INFO, { reason: 'advert' }),
      telemetry: logLine(t, TELEMETRY, { telemetry: { battery_level: 61 } }),
      position: logLine(t, POSITION, { position: { latitude: 38.0249, longitude: -123.0132 } }),
      neighbor: logLine(t, NEIGHBOR, { neighborId: CAMP.node_id }),
      waypoint: logLine(t, WAYPOINT, { waypoint: { icon: 0x1f3d5, name: 'Dome' } }),
      trace: logLine(t, TRACE, { tracePath: [{ id: GATE.node_id }, { id: CAMP.node_id }] }),
    };
    for (const [kind, line] of Object.entries(lines)) {
      assert.match(afterBadge(line.html), new RegExp(`^<span class="chat-entry-part"( title="[^"]*")?><span class="chat-entry-kind">${kind}</span> · `), line.html);
      assert.ok(!line.html.includes('chat-entry-emoji'), `${kind}: no emoji span`);
      assert.doesNotMatch(words(line.html), /[☀💾🔋📍🏘📌👣🔒]/u, `${kind}: no type emoji`);
    }
    assert.ok(words(lines.waypoint.html).includes(`waypoint · ${String.fromCodePoint(0x1f3d5)} Dome`), 'the waypoint keeps its own glyph');
  });
  assert.equal(declarationsFor('.chat-entry-kind').color, 'var(--muted)');
});

test('an encrypted message reads "encrypted · channel <label>", or "encrypted · to <badge>" for a direct one (LA2)', () => {
  withApp((t) => {
    t.rebuildNodeIndex([GATE]);
    const base = { id: 9, from_id: GATE.node_id, encrypted: true, text: 'q83vEjRWeJA=', rx_time: T0, node: GATE, protocol: 'meshtastic' };
    const channel = innerHtml(t.createMessageChatEntry({ ...base, to_id: '^all', channel: 1 }, { uniform: true }));
    assert.equal(afterBadge(channel), '<span class="chat-entry-kind">encrypted</span> · channel 1');
    const direct = innerHtml(t.createMessageChatEntry({ ...base, to_id: GATE.node_id }, { uniform: true }));
    assert.match(afterBadge(direct), /^<span class="chat-entry-kind">encrypted<\/span> · to <span class="short-name" data-protocol="meshtastic"[^>]*>GATE<\/span>$/);
    const unknown = innerHtml(t.createMessageChatEntry({ ...base, to_id: '!0000beef' }, { uniform: true }));
    assert.equal(afterBadge(unknown), '<span class="chat-entry-kind">encrypted</span> · to !0000beef');
  });
});

// --- L3: one sentence shape ---

test('neighbour and trace hops are named by their badges, the hops joined by → (LA3)', () => {
  withApp((t) => {
    t.rebuildNodeIndex([GATE, CAMP]);
    const neighbor = logLine(t, NEIGHBOR, { neighborId: CAMP.node_id });
    assert.match(afterBadge(neighbor.html), /· <span class="short-name" data-protocol="meshtastic"[^>]*>CAMP<\/span><\/span>$/);
    assert.ok(!neighbor.html.includes('Camp repeater</span>'), 'not the long name');
    const trace = logLine(t, TRACE, { tracePath: [{ id: GATE.node_id }, { id: CAMP.node_id }, { id: '!0000beef' }] });
    assert.equal(words(afterBadge(trace.html)), 'trace · GATE → CAMP → !0000beef');
    assert.equal((afterBadge(trace.html).match(/class="short-name"/g) || []).length, 2, 'known hops are badges');
    assert.equal(words(afterBadge(logLine(t, NEIGHBOR, { neighborId: '!0000beef' }).html)), 'neighbor · !0000beef', 'an unknown neighbour by id');
    assert.equal(words(afterBadge(logLine(t, NEIGHBOR).html)), 'neighbor', 'no neighbour id, no detail');

    // A node record in camelCase is badged too; a trace about no known node
    // titles its badge with the first hop, or "Traceroute" without one.
    t.rebuildNodeIndex([{ nodeId: '!0000ca4e', shortName: 'CAMP', longName: 'Camp repeater', role: 'CLIENT', protocol: 'meshcore' }]);
    const camel = logLine(t, NEIGHBOR, { neighborId: '!0000ca4e' });
    assert.match(afterBadge(camel.html), /<span class="short-name" data-protocol="meshcore"[^>]* title="Camp repeater"[^>]*>CAMP<\/span>/);
    const anonymous = t.buildChatLogEntryParts({ type: TRACE, ts: T0, tracePath: [{ id: '!0000beef' }, { id: '!0000f00d' }] });
    assert.match(bodyOf(anonymous.html), /^<span class="short-name"[^>]* title="!0000beef"/);
    const pathless = t.buildChatLogEntryParts({ type: TRACE, ts: T0, tracePath: [{}, {}] });
    assert.match(bodyOf(pathless.html), /^<span class="short-name"[^>]* title="Traceroute"/);
    assert.equal(words(afterBadge(pathless.html)), 'trace', 'no hop to name');
  });
});

test('a telemetry line names only what changed since the node\'s earlier telemetry in the Log (LA3)', async () => {
  const node = { ...GATE, node_id: '!a', last_heard: NOW - 400 };
  const telemetry = [
    { id: 1, node_id: '!a', rx_time: NOW - 300, battery_level: 61, voltage: 3.84, channel_utilization: 0.21, air_util_tx: 0.02 },
    { id: 2, node_id: '!a', rx_time: NOW - 200, battery_level: 61, voltage: 3.83, channel_utilization: 0.21, air_util_tx: 0.02 },
  ];
  await runLiveApp({ responses: { '/api/telemetry': telemetry, '/api/nodes': [node] } }, async () => {
    const parts = globalThis.document.getElementById('chat').children[1].children[0].children
      .map(entry => innerHtml(entry))
      .filter(html => /telemetry/i.test(words(html)))
      .map(html => words(afterBadge(html)));
    assert.deepEqual(parts, ['telemetry · 61% · 3.84 V · util 0.2%', 'telemetry · 3.83 V']);
  });
});

test('a telemetry line names the same changed values whatever the search keeps (LA3)', async () => {
  const node = { ...GATE, node_id: '!a', last_heard: NOW - 400 };
  const telemetry = [
    { id: 1, node_id: '!a', rx_time: NOW - 300, battery_level: 61, voltage: 3.84, channel_utilization: 0.21, air_util_tx: 0.02 },
    { id: 2, node_id: '!a', rx_time: NOW - 200, battery_level: 61, voltage: 3.83, channel_utilization: 0.21, air_util_tx: 0.02 },
  ];
  await runLiveApp({ responses: { '/api/telemetry': telemetry, '/api/nodes': [node] } }, async ({ testUtils }) => {
    const shown = () => globalThis.document.getElementById('chat').children[1].children[0].children
      .map(entry => innerHtml(entry))
      .filter(html => /telemetry/i.test(words(html)))
      .map(html => words(afterBadge(html)));
    testUtils.rerenderChatLog('3.83');
    assert.deepEqual(shown(), ['telemetry · 3.83 V'], 'the second packet still compares with the first');
    testUtils.rerenderChatLog('');
    assert.deepEqual(shown(), ['telemetry · 61% · 3.84 V · util 0.2%', 'telemetry · 3.83 V']);
  });
});

test('the Log search finds the kind words and details the lines show, and keeps a folded line whole (LA3, LA4)', async () => {
  const node = { ...GATE, node_id: '!a', first_heard: NOW - 400, last_heard: NOW - 300 };
  const telemetry = [{ id: 1, node_id: '!a', rx_time: NOW - 290, battery_level: 61, voltage: 3.84, channel_utilization: 0.21 }];
  const positions = [{ id: 1, node_id: '!a', rx_time: NOW - 295, latitude: 38.0249, longitude: -123.0132 }];
  await runLiveApp({ responses: { '/api/telemetry': telemetry, '/api/positions': positions, '/api/nodes': [node] } }, async ({ testUtils }) => {
    const shown = query => {
      testUtils.rerenderChatLog(query);
      return globalThis.document.getElementById('chat').children[1].children[0].children
        .filter(entry => /^chat-entry-(node|msg)$/.test(entry.className))
        .map(entry => words(afterBadge(innerHtml(entry))));
    };
    const burst = 'node info · advert · position 38.0249, -123.0132 · telemetry 61% · 3.84 V · util 0.2%';
    assert.deepEqual(shown(''), ['new node · Gate router', burst]);
    assert.deepEqual(shown('node info'), [burst], 'the kind word of a folded part');
    assert.deepEqual(shown('3.84 V'), [burst], 'a telemetry value as the line shows it');
    assert.deepEqual(shown('position 38.0249'), [burst]);
    assert.deepEqual(shown('new node'), ['new node · Gate router']);
    assert.deepEqual(shown('node-new'), ['new node · Gate router'], 'the type token still matches');
  });
});

test('node info reads its reason, and a position its coordinates at four decimals (LA3)', () => {
  withApp((t) => {
    assert.equal(words(afterBadge(logLine(t, NODE_INFO, { reason: 'message' }).html)), 'node info · message');
    assert.equal(words(afterBadge(logLine(t, NODE_INFO).html)), 'node info', 'no reason, no detail');
    const position = logLine(t, POSITION, { position: { latitude: 38.02490123, longitude: -123.0132, altitude: 161 } });
    assert.equal(words(afterBadge(position.html)), 'position · 38.0249, -123.0132');
    assert.ok(position.html.includes('<span class="chat-entry-part" title="Alt: 161m">'), 'altitude in the title');
  });
});

// --- L5: a quiet radio tag; the badge carries the protocol ---

test('a line that needs a radio tag leads with the preset code alone, with no protocol icon (LA5)', () => {
  withApp((t) => {
    const message = innerHtml(t.createMessageChatEntry({
      id: 3, text: 'hello mesh', rx_time: T0, lora_freq: 869, modem_preset: 'MediumFast', protocol: 'meshtastic',
      node: { short_name: 'ALI', role: 'CLIENT', protocol: 'meshtastic' },
    }));
    assert.ok(bodyOf(message).startsWith(`${MF} <span class="short-name" data-protocol="meshtastic"`), message);
    const announcement = logLine(t, NODE_INFO, { reason: 'advert' });
    assert.ok(bodyOf(announcement.html).startsWith(`${MF} <span class="short-name" data-protocol="meshtastic"`), announcement.html);
    for (const html of [announcement.html, message]) {
      assert.ok(!html.includes('protocol-icon'), 'the 12px protocol icon left the line');
      assert.ok(!html.includes('[869]') && !html.includes('[MF]'), 'no bracketed tag');
    }
    assert.ok(!bodyOf(logLine(t, NODE_INFO, {}, { uniform: true }).html).includes('chat-entry-radio'), 'a one-radio Log drops it');
  });
});

test('formatChatRadioCode titles what the line knows, and a radio without a preset code gets none (LA5)', () => {
  const { formatChatRadioCode, extractChatMessageMetadata } = chatFormat;
  assert.equal(typeof formatChatRadioCode, 'function', 'chat-format.js exports formatChatRadioCode');
  assert.equal(formatChatRadioCode(extractChatMessageMetadata(GATE), 'meshtastic'), MF);
  assert.equal(
    formatChatRadioCode(extractChatMessageMetadata(SPTR), 'meshcore'),
    '<span class="chat-entry-radio" title="869.525 MHz · EU/UK Narrow · MeshCore">NA</span>',
  );
  assert.equal(
    formatChatRadioCode(extractChatMessageMetadata({ modem_preset: 'LongFast' }), 'reticulum'),
    '<span class="chat-entry-radio" title="LongFast · Reticulum">LF</span>',
  );
  assert.equal(formatChatRadioCode({ frequency: null, presetCode: 'mf' }), '<span class="chat-entry-radio">MF</span>');
  assert.equal(formatChatRadioCode({ frequency: '869', presetCode: 'X', presetName: 'X' }, 'constructor'),
    '<span class="chat-entry-radio" title="869 MHz · X · constructor">X</span>', 'an unknown protocol reads as written');
  assert.equal(formatChatRadioCode({ frequency: '869', presetCode: null }), '', 'no preset code: no tag');
  assert.equal(formatChatRadioCode({ frequency: '869', presetCode: ' ' }), '');
});

test('the Log\'s radio key reads an announcement\'s node record, and sharesOneRadio ignores lines that name no radio (LA1)', () => {
  const { chatRadioKey, sharesOneRadio } = chatFormat;
  assert.equal(chatRadioKey(GATE, 'meshtastic'), chatRadioKey({ ...GATE, text: 'x' }), 'a node record keys like a message on its radio');
  assert.notEqual(chatRadioKey(GATE, 'meshcore'), chatRadioKey(GATE), 'the line\'s protocol overrides the record\'s');
  assert.equal(chatRadioKey(PLACEHOLDER), null, 'a record without a preset code names no radio');
  assert.equal(chatRadioKey({ lora_freq: 869, protocol: 'meshtastic' }), null, 'a frequency alone renders no code either');
  assert.equal(chatRadioKey({ ...GATE, lora_freq: null }), chatRadioKey(GATE), 'the frequency only titles the code');
  assert.equal(sharesOneRadio([GATE, { ...CAMP, lora_freq: null }, { ...CAMP, lora_freq: 868 }], chatRadioKey), true);
  assert.equal(sharesOneRadio([GATE, CAMP], chatRadioKey), true);
  assert.equal(sharesOneRadio([GATE, PLACEHOLDER, CAMP], chatRadioKey), true, 'a line naming no radio does not count');
  assert.equal(sharesOneRadio([GATE, SPTR, CAMP], chatRadioKey), false);
  assert.equal(sharesOneRadio([PLACEHOLDER], chatRadioKey), true, 'no two lines name different radios');
  assert.equal(sharesOneRadio([], chatRadioKey), true);
});

test('a Log with an unheard placeholder node keeps the one-radio rule: no line carries a code (LA1)', async () => {
  const nodes = [
    { node_id: '!a', short_name: 'ALI', long_name: 'Alice', role: 'CLIENT', protocol: 'meshtastic', lora_freq: 869, modem_preset: 'MediumFast', first_heard: NOW - 90, last_heard: NOW - 80 },
    { ...PLACEHOLDER, first_heard: NOW - 70, last_heard: NOW - 60 },
  ];
  const encrypted = { id: 8, channel: 1, from_id: '!a', to_id: '^all', encrypted: true, text: 'q83vEjRWeJA=', rx_time: NOW - 50, protocol: 'meshtastic', lora_freq: 869, modem_preset: 'MediumFast' };
  await runLiveApp({ responses: { '/api/messages': [encrypted], '/api/nodes': nodes } }, async () => {
    const lines = globalThis.document.getElementById('chat').children[1].children[0].children
      .filter(node => /^chat-entry-(node|msg)$/.test(node.className))
      .map(node => innerHtml(node));
    assert.equal(lines.length, 5, 'two nodes\' new-node and node-info lines and the encrypted line');
    assert.ok(lines.some(html => html.includes('>ADBE<')), 'the placeholder has its lines');
    assert.ok(lines.every(html => !html.includes('chat-entry-radio') && !html.includes('[869]')), lines.join('\n'));
  });
});

test('a message without a frequency of its own keeps a one-radio tab and the Log free of codes (LA1, CD2)', async () => {
  const nodes = [{ ...GATE, node_id: '!a', first_heard: NOW - 90, last_heard: NOW - 80 }];
  const message = (id, overrides = {}) => ({
    id, channel: 1, channel_name: 'Alpha', from_id: '!a', to_id: '^all', text: `alpha ${id}`, rx_time: NOW - 50 + id,
    protocol: 'meshtastic', lora_freq: 869, modem_preset: 'MediumFast', ...overrides,
  });
  // The review's case: one of six lines carries no frequency or preset, so it
  // takes MF from its node's record and no frequency; the Log gets one too.
  const bare = { lora_freq: null, modem_preset: null };
  const messages = [1, 2, 3, 4, 5].map(id => message(id)).concat(
    message(6, bare),
    message(7, { ...bare, channel: 2, encrypted: true, text: 'q83vEjRWeJA=' }),
  );
  await runLiveApp({ responses: { '/api/messages': messages, '/api/nodes': nodes } }, async () => {
    const [log, ...tabs] = globalThis.document.getElementById('chat').children[1].children;
    const linesOf = panel => panel.children
      .filter(node => /^chat-entry-(node|msg)$/.test(node.className))
      .map(node => innerHtml(node));
    const alpha = tabs.flatMap(linesOf).filter(html => html.includes('alpha '));
    const logLines = linesOf(log);
    assert.equal(alpha.length, 6, 'the one-radio tab shows six lines');
    assert.ok(logLines.some(html => html.includes('>encrypted<')), 'the Log shows the encrypted line');
    assert.ok(alpha.some(html => html.includes('title="') && !html.includes('MHz')), 'one line\'s titles name no frequency');
    for (const html of [...alpha, ...logLines]) assert.ok(!/chat-entry-radio|\[MF\]/.test(html), html);
  });
});

test('a channel whose messages include one that names no radio stays one radio (LA1, CD2)', () => {
  const message = (id, overrides = {}) => ({
    id, channel: 1, channel_name: 'Alpha', from_id: '!a', to_id: '^all', text: `m${id}`, rx_time: T0 + id,
    lora_freq: 869, modem_preset: 'MediumFast', protocol: 'meshtastic', ...overrides,
  });
  const { channels } = buildChatTabModel({
    messages: [message(1, { lora_freq: null, modem_preset: null }), message(2), message(3)],
    nowSeconds: T0 + 60,
    windowSeconds: 3600,
  });
  assert.equal(channels[0].uniform, true);
});

test('every short-name badge names its protocol in data-protocol, also the fallback (LA5)', () => {
  const badge = node => renderShortHtml(node.short_name, node.role, node.long_name, node);
  assert.match(badge(SPTR), /^<span class="short-name" data-protocol="meshcore" style=/);
  assert.match(badge({ ...SPTR, protocol: 'reticulum' }), /^<span class="short-name" data-protocol="reticulum" style=/);
  assert.match(badge({ ...SPTR, protocol: null }), /^<span class="short-name" data-protocol="meshtastic" style=/, 'the palette\'s default');
  assert.match(renderShortHtml(null, null, null, SPTR), /^<span class="short-name" data-protocol="meshcore" style="background:#ccc/);
  assert.match(renderShortHtml('GATE', 'ROUTER', 'Gate'), /^<span class="short-name" data-protocol="meshtastic" /, 'no node data');
  assert.equal(
    renderRoleAwareBadge(null, { shortName: 'SPTR', source: { protocol: 'meshcore' } }),
    '<span class="short-name" data-protocol="meshcore">SPTR</span>',
  );
  assert.equal(
    renderRoleAwareBadge(null, { identifier: '!0000c0de', source: { protocol: 'meshcore' } }),
    '<span class="short-name" data-protocol="meshcore">C0DE</span>',
    'the fallback short name from the id',
  );
});

test('a MeshCore line whose sender has no node record names meshcore on its ? badge, which opens nothing (LA5)', () => {
  withApp((t) => {
    const html = innerHtml(t.createMessageChatEntry({ id: 6, text: 'hi', rx_time: T0, protocol: 'meshcore' }, { uniform: true }));
    assert.ok(bodyOf(html).startsWith('<span class="short-name" data-protocol="meshcore" style="background:#ccc'), html);
    assert.ok(!html.includes('data-node-info'), 'no node to open');
  });
  assert.match(renderShortHtml('AB', 'COMPANION', 'x', { node_id: '!a' }, { protocol: 'meshcore' }), /^<span class="short-name" data-protocol="meshcore" style="background:#164A88/);
  assert.match(renderShortHtml('AB', null, 'x', { protocol: 'reticulum' }, { protocol: 'meshcore' }), /data-protocol="reticulum"/, 'the record\'s own protocol wins');
});

test('a chat badge takes the line\'s protocol when its node record has none (LA5)', () => {
  withApp((t) => {
    const message = innerHtml(t.createMessageChatEntry({
      id: 4, text: 'hi', rx_time: T0, protocol: 'meshcore', node: { short_name: 'SPTR', role: 'COMPANION' },
    }, { uniform: true }));
    assert.match(message, /<span class="short-name" data-protocol="meshcore"/);
    const announcement = t.buildChatLogEntryParts({
      type: TELEMETRY, ts: T0, nodeId: '!0000c0de', telemetry: { node_id: '!0000c0de', protocol: 'meshcore', battery_level: 50 },
    }, { uniform: true });
    assert.match(announcement.html, /<span class="short-name" data-protocol="meshcore"/);
  });
});

test('base.css draws a MeshCore badge near-square and the radio code in a faint token that meets UX2 (LA5)', () => {
  assert.equal(declarationsFor('.short-name[data-protocol="meshcore"]')['border-radius'], '1px');
  assert.equal(declarationsFor('.short-name')['border-radius'], '4px', 'other badges keep their corners');
  assert.equal(declarationsFor('.chat-entry-radio').color, 'var(--fg-faint)');
  assert.ok(ROOT_TOKENS.has('--fg-faint'), ':root declares --fg-faint');
  const luminance = hex => {
    const channel = value => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = [1, 3, 5].map(index => channel(parseInt(hex.slice(index, index + 2), 16)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const faint = resolveToken('var(--fg-faint)');
  const panel = resolveToken('var(--panel)');
  assert.match(faint, /^#[0-9a-f]{6}$/);
  const ratio = (luminance(faint) + 0.05) / (luminance(panel) + 0.05);
  assert.ok(ratio >= 4.5, `--fg-faint on --panel is ${ratio.toFixed(2)}:1`);
  assert.ok(luminance(faint) < luminance(resolveToken('var(--muted)')), 'fainter than --muted');
});

// --- L6: one click affordance ---

test('a new node\'s long name in the chat underlines only on hover or keyboard focus (LA6, DV2)', () => {
  assert.equal(declarationsFor('.chat-panel .node-long-link')['text-decoration-line'], 'none');
  for (const selector of ['.chat-panel .node-long-link:hover', '.chat-panel .node-long-link:focus-visible']) {
    assert.equal(declarationsFor(selector)['text-decoration-line'], 'underline', selector);
  }
  withApp((t) => {
    const line = t.buildChatLogEntryParts({ type: NODE_NEW, ts: T0, node: GATE, nodeId: GATE.node_id });
    assert.match(afterBadge(line.html), /^<span class="chat-entry-part"><span class="chat-entry-kind">new node<\/span> · <a [^>]*class="node-long-link"[^>]*>Gate router<\/a><\/span>$/);
  });
});
