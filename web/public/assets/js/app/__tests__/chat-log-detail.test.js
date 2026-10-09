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
 * The words of a Log line (SPEC LA2, LA3, design review rc4 L2 and L3):
 * `BADGE kind · detail`, a kind word for each entry type, telemetry as at
 * most three changed values without labels, a position at four decimals,
 * a waypoint with its own glyph, and the encrypted notice.
 *
 * @module __tests__/chat-log-detail
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_LOG_ENTRY_TYPES } from '../chat-log-tabs.js';
import * as detail from '../chat-log-detail.js';
import { resolvePositionCoordinates } from '../chat-log-highlights.js';
import { CHAT_LOG_BURST_TYPE } from '../chat-log-burst.js';

const {
  CHAT_LOG_KIND_WORDS,
  TELEMETRY_LOG_ORDER,
  attachTelemetryHistory,
  chatLogEntryText,
  encryptedNoticeTarget,
  formatChatLogText,
  formatBurstLogParts,
  formatChatKind,
  formatChatLogParts,
  formatEncryptedLogNotice,
  formatEntryLogPart,
  formatNodeInfoLogPart,
  formatPositionLogPart,
  formatRenderedLogPart,
  formatTelemetryLogPart,
  formatWaypointLogPart,
  telemetryLogValues,
} = detail;

/** 07:41:05 local time on 2026-10-08, Unix seconds. */
const T0 = Math.floor(new Date(2026, 9, 8, 7, 41, 5).getTime() / 1000);

/** A device-metrics packet: battery, voltage, both utilisations, uptime. */
const DEVICE = Object.freeze({
  battery_level: 61,
  voltage: 3.84,
  channel_utilization: 0.21,
  air_util_tx: 0.02,
  uptime_seconds: 3600,
});

/**
 * The detail text of a part, without its HTML escaping.
 *
 * @param {{ detailHtml?: string }} part Part.
 * @returns {string} The detail.
 */
function text(part) {
  return (part.detailHtml || '').replace(/&amp;/g, '&');
}

test('every Log entry type has a lowercase kind word (LA2)', () => {
  assert.deepEqual(CHAT_LOG_KIND_WORDS, {
    [CHAT_LOG_ENTRY_TYPES.NODE_NEW]: 'new node',
    [CHAT_LOG_ENTRY_TYPES.NODE_INFO]: 'node info',
    [CHAT_LOG_ENTRY_TYPES.TELEMETRY]: 'telemetry',
    [CHAT_LOG_ENTRY_TYPES.POSITION]: 'position',
    [CHAT_LOG_ENTRY_TYPES.NEIGHBOR]: 'neighbor',
    [CHAT_LOG_ENTRY_TYPES.WAYPOINT]: 'waypoint',
    [CHAT_LOG_ENTRY_TYPES.TRACE]: 'trace',
    [CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED]: 'encrypted',
  });
  assert.equal(formatChatKind('node info'), '<span class="chat-entry-kind">node info</span>');
});

test('a part reads "kind · detail", titled with what the detail leaves out (LA2, LA3)', () => {
  assert.equal(
    formatChatLogParts([{ kind: 'node info', detailHtml: 'advert' }]),
    '<span class="chat-entry-part"><span class="chat-entry-kind">node info</span> · advert</span>',
  );
  assert.equal(
    formatChatLogParts([{ kind: 'position', detailHtml: '1.0000, 2.0000', title: 'Alt: <5m>' }]),
    '<span class="chat-entry-part" title="Alt: &lt;5m&gt;"><span class="chat-entry-kind">position</span> · 1.0000, 2.0000</span>',
  );
  assert.equal(
    formatChatLogParts([{ kind: 'telemetry', detailHtml: '' }]),
    '<span class="chat-entry-part"><span class="chat-entry-kind">telemetry</span></span>',
    'no changed value: the kind alone',
  );
});

test('telemetry values read as units without labels, in the documented order (LA3)', () => {
  assert.deepEqual(TELEMETRY_LOG_ORDER.slice(0, 6), ['battery', 'voltage', 'channel', 'airUtil', 'current', 'temperature']);
  assert.ok(!TELEMETRY_LOG_ORDER.includes('uptime'), 'uptime always changes, so the Log never shows it');
  const values = telemetryLogValues({ ...DEVICE, temperature: 14.23, relative_humidity: 42.4, barometric_pressure: 1001.8 });
  assert.deepEqual(values.map(value => value.text), [
    '61%', '3.84 V', 'util 0.2%', 'air util 0.0%', '14.2 °C', '42.4% RH', '1001.8 hPa',
  ]);
  assert.deepEqual(values.map(value => value.label).slice(0, 3), ['Battery: 61%', 'Voltage: 3.84 V', 'Channel Util: 0.2%']);
  assert.deepEqual(
    telemetryLogValues({ iaq: 51, white_lux: 120, wind_gust: 5, rainfall_24h: 1.2, soil_temperature: 9 }).map(value => value.text),
    ['IAQ 51', 'white 120.0 lx', 'gust 5.0 m/s', 'rain 24h 1.20 mm', 'soil 9.0 °C'],
  );
  assert.deepEqual(telemetryLogValues({ voltage: 'n/a' }), [], 'an unreadable value is left out');
  assert.deepEqual(telemetryLogValues(undefined), [], 'an entry without a snapshot has no value');
  const snapshot = { battery_level: 50 };
  assert.strictEqual(telemetryLogValues(snapshot), telemetryLogValues(snapshot), 'memoised per snapshot');
  assert.ok(Object.isFrozen(telemetryLogValues(snapshot)));
});

test('a node\'s first telemetry line shows its first three values, the full set in the title (LA3)', () => {
  const part = formatTelemetryLogPart(DEVICE);
  assert.equal(part.kind, 'telemetry');
  assert.equal(text(part), '61% · 3.84 V · util 0.2%');
  assert.equal(part.title, 'Battery: 61% · Voltage: 3.84 V · Channel Util: 0.2% · Air Util Tx: 0.0%');
});

test('a later telemetry line shows only the values that changed, at most three (LA3)', () => {
  const previous = new Map(telemetryLogValues(DEVICE).map(value => [value.key, value.text]));
  assert.equal(text(formatTelemetryLogPart({ ...DEVICE, voltage: 3.83, air_util_tx: 0.4 }, previous)), '3.83 V · air util 0.4%');
  assert.equal(text(formatTelemetryLogPart({ ...DEVICE, channel_utilization: 0.24 }, previous)), '', 'a change below the shown precision is no change');
  const everything = { battery_level: 60, voltage: 3.8, channel_utilization: 1, air_util_tx: 1, temperature: 20 };
  assert.equal(text(formatTelemetryLogPart(everything, previous)), '60% · 3.8 V · util 1.0%', 'three of five changed values');
});

test('attachTelemetryHistory hands each telemetry entry its node\'s earlier values, per metric (LA3)', () => {
  const entry = (ts, nodeId, telemetry, extra = {}) => ({ type: CHAT_LOG_ENTRY_TYPES.TELEMETRY, ts, nodeId, telemetry, ...extra });
  const device = entry(1, '!a', DEVICE);
  const environment = entry(2, '!a', { temperature: 14.2 });
  const other = entry(3, '!b', DEVICE);
  const nodeInfo = { type: CHAT_LOG_ENTRY_TYPES.NODE_INFO, ts: 4, nodeId: '!a' };
  const again = entry(5, '!a', { ...DEVICE, voltage: 3.8 });
  const byNumber = entry(6, null, DEVICE, { nodeNum: 7 });
  const byNumberAgain = entry(7, null, DEVICE, { nodeNum: 7 });
  const anonymous = entry(8, null, DEVICE);
  const input = [device, environment, other, nodeInfo, again, byNumber, byNumberAgain, anonymous];
  const out = attachTelemetryHistory(input);

  assert.equal(out[0].previousTelemetryValues, null, 'a node\'s first telemetry has no history');
  assert.equal(out[1].previousTelemetryValues.get('voltage'), '3.84 V');
  assert.equal(out[2].previousTelemetryValues, null, 'another node keeps its own history');
  assert.equal(out[3], nodeInfo, 'other entries pass through as themselves');
  // The environment packet did not report a voltage, so the device line
  // compares with the earlier device line, metric by metric.
  assert.equal(text(formatTelemetryLogPart(out[4].telemetry, out[4].previousTelemetryValues)), '3.8 V');
  assert.equal(out[5].previousTelemetryValues, null);
  assert.equal(out[6].previousTelemetryValues.get('battery'), '61%', 'a node known by number only');
  assert.equal(out[7].previousTelemetryValues, null, 'a telemetry entry without a node has no history');
  assert.ok(input.every(item => !('previousTelemetryValues' in item)), 'the raw entries are left as they are');
});

test('a position reads lat, lon at four decimals, the rest in the title (LA3)', () => {
  const part = formatPositionLogPart({ latitude: 38.0249012, longitude: -123.0131987, altitude: 161, sats_in_view: 4, satellites: 7 });
  assert.equal(part.kind, 'position');
  assert.equal(text(part), '38.0249, -123.0132');
  assert.equal(part.title, 'Alt: 161m · Sats: 7');
  assert.equal(text(formatPositionLogPart({ latitude_i: 38024901, longitude_i: -123013199 })), '38.0249, -123.0132', 'scaled as the highlights scale it');
  assert.equal(text(formatPositionLogPart({ lat: 52.5 })), '52.5000', 'one coordinate alone');
  assert.equal(formatPositionLogPart({}).detailHtml, '', 'no coordinates');
  assert.deepEqual(resolvePositionCoordinates({ position: { latitude: 1, longitude: 2 } }), { latitude: 1, longitude: 2 });
  assert.deepEqual(resolvePositionCoordinates(null), { latitude: null, longitude: null });
});

test('node info reads its reason, and a rendered part keeps its HTML (LA3)', () => {
  assert.deepEqual(formatNodeInfoLogPart(' advert '), { kind: 'node info', detailHtml: 'advert', detailText: 'advert' });
  assert.deepEqual(formatNodeInfoLogPart(undefined), { kind: 'node info', detailHtml: '', detailText: '' });
  assert.deepEqual(formatNodeInfoLogPart('<b>'), { kind: 'node info', detailHtml: '&lt;b&gt;', detailText: '<b>' });
  assert.deepEqual(formatRenderedLogPart(CHAT_LOG_ENTRY_TYPES.TRACE, '<b>A</b>'), { kind: 'trace', detailHtml: '<b>A</b>' });
});

test('a waypoint keeps its own glyph and drops the 📌 fallback; latitude and longitude go in the title (LA3, W7)', () => {
  const now = 1_000_000;
  const camp = { icon: 0x1f3d5, name: 'Dome', latitude: 38.0291, longitude: -123.0199, expire: now + 2 * 86400 + 4 * 3600 + 30 };
  assert.deepEqual(formatWaypointLogPart(camp, { nowSeconds: now }), {
    kind: 'waypoint',
    detailHtml: `${String.fromCodePoint(0x1f3d5)} Dome · expires 2d 4h`,
    detailText: `${String.fromCodePoint(0x1f3d5)} Dome · expires 2d 4h`,
    title: 'Lat: 38.02910 · Lon: -123.01990',
  });
  assert.equal(formatWaypointLogPart({ name: ' ' }, { nowSeconds: now }).detailHtml, 'Waypoint · expires never', 'no glyph of its own');
  assert.equal(
    formatWaypointLogPart({ icon: 0x1f4cc, name: 'Pin' }, { nowSeconds: now }).detailHtml,
    `${String.fromCodePoint(0x1f4cc)} Pin · expires never`,
    'a 📌 the user chose stays',
  );
  assert.equal(formatWaypointLogPart({ name: 'Old', expire: now - 5 }, { nowSeconds: now }).detailHtml, 'Old · expired');
  assert.equal(formatWaypointLogPart({ name: '<i>', latitude: 1 }, { nowSeconds: now }).detailHtml, '&lt;i&gt; · expires never');
  assert.equal(formatWaypointLogPart({ name: 'x', latitude: 1 }, { nowSeconds: now }).title, 'Lat: 1.00000');
});

test('the encrypted notice reads "encrypted · channel <label>" or "encrypted · to <badge>" (LA2)', () => {
  const kind = '<span class="chat-entry-kind">encrypted</span>';
  assert.equal(formatEncryptedLogNotice({ channelLabel: '1' }), `${kind} · channel 1`);
  assert.equal(formatEncryptedLogNotice({ channelLabel: '<x>' }), `${kind} · channel &lt;x&gt;`);
  assert.equal(formatEncryptedLogNotice({ recipientHtml: '<span class="short-name">GATE</span>' }), `${kind} · to <span class="short-name">GATE</span>`);
  assert.equal(formatEncryptedLogNotice({}), `${kind} · unknown channel`);
});

test('a folded burst lists "kind · detail · kind detail", each part titled with its own time (LA4)', () => {
  const parts = [
    { type: CHAT_LOG_ENTRY_TYPES.NODE_INFO, ts: T0, reason: 'advert' },
    { type: CHAT_LOG_ENTRY_TYPES.POSITION, ts: T0 + 1, position: { latitude: 38.0249, longitude: -123.0132, altitude: 12 } },
    { type: CHAT_LOG_ENTRY_TYPES.TELEMETRY, ts: T0 + 4, telemetry: DEVICE },
  ];
  assert.deepEqual(parts.map(entry => formatEntryLogPart(entry).kind), ['node info', 'position', 'telemetry']);
  const html = formatBurstLogParts(parts);
  assert.equal(
    html,
    '<span class="chat-entry-part" title="07:41:05"><span class="chat-entry-kind">node info</span> · advert</span>'
      + ' · <span class="chat-entry-part" title="07:41:06 · Alt: 12m"><span class="chat-entry-kind">position</span> 38.0249, -123.0132</span>'
      + ' · <span class="chat-entry-part" title="07:41:09 · Battery: 61% · Voltage: 3.84 V · Channel Util: 0.2% · Air Util Tx: 0.0%">'
      + '<span class="chat-entry-kind">telemetry</span> 61% · 3.84 V · util 0.2%</span>',
  );
  assert.equal(
    html.replace(/<[^>]+>/g, ''),
    'node info · advert · position 38.0249, -123.0132 · telemetry 61% · 3.84 V · util 0.2%',
    'the line reads as the design shows it',
  );
});

test('the text of a Log line is its kind words and details, folded as the line folds them (LA3, LA4)', () => {
  assert.equal(formatChatLogText([{ kind: 'node info', detailText: 'advert' }]), 'node info · advert');
  assert.equal(formatChatLogText([{ kind: 'telemetry', detailText: '' }]), 'telemetry');
  assert.equal(
    formatChatLogText([{ kind: 'node info', detailText: 'advert' }, { kind: 'position', detailText: '1.0000, 2.0000' }], { folded: true }),
    'node info · advert · position 1.0000, 2.0000',
  );
  const T = CHAT_LOG_ENTRY_TYPES;
  const now = 1_000_000;
  const text = entry => chatLogEntryText(entry, { nowSeconds: now });
  assert.equal(text({ type: T.NODE_NEW, node: { long_name: 'Gate router' } }), 'new node · Gate router');
  assert.equal(text({ type: T.NODE_NEW, nodeId: '!a' }), 'new node · !a', 'no record: the id');
  assert.equal(text({ type: T.NODE_NEW }), 'new node');
  assert.equal(text({ type: T.NEIGHBOR, neighborNode: { short_name: 'CAMP' } }), 'neighbor · CAMP');
  assert.equal(text({ type: T.NEIGHBOR, neighborId: '!c' }), 'neighbor · !c');
  assert.equal(text({ type: T.NEIGHBOR }), 'neighbor');
  assert.equal(text({ type: T.TRACE, hopLabels: ['a', 'b'], traceLabels: ['!1', '!2'] }), 'trace · a → b');
  assert.equal(text({ type: T.TRACE, traceLabels: ['!1', '!2'] }), 'trace · !1 → !2');
  assert.equal(text({ type: T.TRACE }), 'trace');
  assert.equal(text({ type: T.WAYPOINT, waypoint: { name: 'Dome' } }), 'waypoint · Dome · expires never');
  assert.equal(text({ type: T.WAYPOINT }), 'waypoint · Waypoint · expires never');
  assert.equal(text({ type: T.MESSAGE_ENCRYPTED, message: { channel: 1, to_id: '^all' } }), 'encrypted · channel 1');
  assert.equal(text({ type: T.MESSAGE_ENCRYPTED, message: { to_id: '!0000beef' } }), 'encrypted · to !0000beef');
  assert.equal(text({ type: T.MESSAGE_ENCRYPTED, message: {} }), 'encrypted · unknown channel');
  assert.equal(text({ type: T.MESSAGE, message: { text: 'hi' } }), '', 'a message has no Log kind of its own');
  assert.equal(
    text({ type: CHAT_LOG_BURST_TYPE, parts: [{ type: T.NODE_INFO, reason: 'advert' }, { type: T.TELEMETRY, telemetry: { battery_level: 61 } }] }),
    'node info · advert · telemetry 61%',
  );
  // 2 h 0 m 30 s ahead: the default clock reads 2h 0m however long the call takes.
  assert.equal(chatLogEntryText({ type: T.WAYPOINT, waypoint: { name: 'x', expire: Date.now() / 1000 + 7230 } }), 'waypoint · x · expires 2h 0m', 'the clock defaults to now');
});

test('encryptedNoticeTarget names a direct message\'s recipient, else its channel as written (LA2)', () => {
  assert.deepEqual(encryptedNoticeTarget({ to_id: ' !0000beef ' }), { recipient: '!0000beef', channelLabel: null });
  assert.deepEqual(encryptedNoticeTarget({ toId: '^ALL', channel: 2.4 }), { recipient: null, channelLabel: '2' });
  assert.deepEqual(encryptedNoticeTarget({ channel_index: ' 7 ' }), { recipient: null, channelLabel: '7' });
  assert.deepEqual(encryptedNoticeTarget({ channel: 'LongFast' }), { recipient: null, channelLabel: 'LongFast' });
  assert.deepEqual(encryptedNoticeTarget({ channel: true }), { recipient: null, channelLabel: 'true' });
  assert.deepEqual(encryptedNoticeTarget({ channel: Number.NaN, channel_name: 'Ops' }), { recipient: null, channelLabel: 'NaN' });
  assert.deepEqual(encryptedNoticeTarget({ channel_name: ' Ops ' }), { recipient: null, channelLabel: 'Ops' });
  assert.deepEqual(encryptedNoticeTarget({}), { recipient: null, channelLabel: null });
  assert.deepEqual(encryptedNoticeTarget(null), { recipient: null, channelLabel: null });
});
