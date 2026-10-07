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
  REPAINT_SURFACES,
  SURFACE_INPUTS,
  createRepaintPlanner,
  keyedRowsChanged,
  nextChatRepaintAt,
  nextExpiryTextChangeAt,
  nextMapRepaintAt,
  recordsEqual,
  surfacesForCollections,
} from '../repaint-planner.js';
import { nodeAgeBucket } from '../age-bucket.js';
import { isWaypointExpired, waypointExpiryOpacity } from '../waypoint-layer.js';
import { buildChatTabModel } from '../../chat-log-tabs.js';
import { timeHum } from '../format-utils.js';

const NOW = 1_800_000_000;

test('recordsEqual compares data, not identity', () => {
  assert.equal(recordsEqual(1, 1), true);
  assert.equal(recordsEqual(NaN, NaN), true);
  assert.equal(recordsEqual(0, -0), true);
  assert.equal(recordsEqual(NaN, 1), false);
  assert.equal(recordsEqual('a', 'b'), false);
  assert.equal(recordsEqual(null, {}), false);
  assert.equal(recordsEqual({}, null), false);
  assert.equal(recordsEqual(1, { a: 1 }), false);
  assert.equal(recordsEqual([1, { a: [2] }], [1, { a: [2] }]), true);
  assert.equal(recordsEqual([1, 2], [1, 2, 3]), false);
  assert.equal(recordsEqual([1, 2], [1, 3]), false);
  assert.equal(recordsEqual([1], { 0: 1 }), false);
  assert.equal(recordsEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }), true);
  assert.equal(recordsEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(recordsEqual({ a: 1, b: undefined }, { a: 1, c: undefined }), false);
  assert.equal(recordsEqual({ a: { c: 2 } }, { a: { c: 3 } }), false);
  // Hidden bookkeeping (the aggregator's snapshot history) is never rendered.
  const withHistory = { a: 1 };
  Object.defineProperty(withHistory, 'snapshots', { value: [1, 2, 3], enumerable: false });
  assert.equal(recordsEqual(withHistory, { a: 1 }), true);
});

test('keyedRowsChanged finds an added, removed or edited row and ignores re-sent ones', () => {
  /** @param {Object} row Row. @returns {*} Its id. */
  const keyOf = row => row.id;
  const rows = [{ id: 1, v: 'a' }, { id: 2, v: 'b' }];
  assert.equal(keyedRowsChanged(rows, rows, keyOf), false, 'the same array');
  assert.equal(keyedRowsChanged(rows, [rows[0], { id: 2, v: 'b' }], keyOf), false, 'an overlap row re-sent unchanged');
  assert.equal(keyedRowsChanged(rows, [rows[0], { id: 2, v: 'c' }], keyOf), true, 'an edited row');
  assert.equal(keyedRowsChanged(rows, [rows[0], { id: 3, v: 'b' }], keyOf), true, 'a row swapped for a new one');
  assert.equal(keyedRowsChanged(rows, [...rows, { id: 3 }], keyOf), true, 'an added row');
  assert.equal(keyedRowsChanged(rows, [rows[0]], keyOf), true, 'a trimmed row');
  assert.equal(keyedRowsChanged(null, [], keyOf), false);
  assert.equal(keyedRowsChanged([], undefined, keyOf), false);
  assert.equal(keyedRowsChanged(undefined, [{ id: 1 }], keyOf), true);
  // Rows that moved are matched by key: the same rows reordered are no change,
  // reordered with an edit or a swapped row are.
  const reordered = [{ id: 2, v: 'b' }, { id: 1, v: 'a' }];
  assert.equal(keyedRowsChanged(rows, reordered, keyOf), false, 'the same rows in another order');
  assert.equal(keyedRowsChanged(rows, [{ id: 2, v: 'b' }, { id: 1, v: 'z' }], keyOf), true, 'moved and edited');
  assert.equal(keyedRowsChanged(rows, [{ id: 3, v: 'b' }, rows[0]], keyOf), true, 'moved and swapped');
});

test('surfacesForCollections maps each collection onto the surfaces that render it (DR4)', () => {
  /** @param {Array<string>} collections Changed collections. @returns {Array<string>} Surfaces, in order. */
  const as = collections => [...surfacesForCollections(collections)];
  assert.deepEqual(as(['messages']), ['chat']);
  assert.deepEqual(as(['encrypted']), ['chat']);
  assert.deepEqual(as(['positions']), ['chat']);
  assert.deepEqual(as(['telemetry']), ['chat']);
  assert.deepEqual(as(['nodes']), ['table', 'map', 'chat']);
  assert.deepEqual(as(['destinations']), ['table']);
  assert.deepEqual(as(['neighbors']), ['map', 'chat']);
  assert.deepEqual(as(['traces']), ['map', 'chat']);
  assert.deepEqual(as(['waypoints']), ['map', 'chat']);
  assert.deepEqual(as(['messages', 'destinations']), ['table', 'chat']);
  assert.deepEqual(as([]), []);
  assert.deepEqual(REPAINT_SURFACES, ['table', 'map', 'chat']);
  assert.equal(Object.isFrozen(SURFACE_INPUTS.chat), true);
});

test('nextMapRepaintAt finds the next freshness-bucket crossing of a drawn marker', () => {
  const heardRecently = NOW - 100;
  assert.equal(nextMapRepaintAt([{ last_heard: heardRecently }], [], NOW), heardRecently + 3 * 3600);
  const heardHoursAgo = NOW - 4 * 3600;
  assert.equal(nextMapRepaintAt([{ last_heard: heardHoursAgo }], [], NOW), heardHoursAgo + 24 * 3600);
  assert.equal(nextMapRepaintAt([{ last_heard: NOW - 25 * 3600 }], [], NOW), Infinity, 'a stale marker never moves');
  assert.equal(nextMapRepaintAt([{ last_heard: null }, null, { last_heard: 'x' }], null, NOW), Infinity);
  assert.equal(nextMapRepaintAt(null, undefined, NOW), Infinity, 'nothing drawn, nothing ages');
  assert.equal(
    nextMapRepaintAt([{ last_heard: NOW - 4 * 3600 }, { last_heard: NOW - 100 }], [], NOW),
    NOW - 100 + 3 * 3600,
    'the earliest crossing wins',
  );
  // The moment returned is where the bucket really changes.
  const at = nextMapRepaintAt([{ last_heard: heardRecently }], [], NOW);
  assert.notEqual(nodeAgeBucket(heardRecently, at), nodeAgeBucket(heardRecently, at - 0.5));
});

test('nextMapRepaintAt finds the next waypoint dimming step or expiry, matching the layer', () => {
  /**
   * Walk the repaint moments of one waypoint and check each is a visible change.
   *
   * @param {number} expire Expiry, unix seconds.
   * @returns {Array<number>} Each moment relative to the expiry.
   */
  const steps = expire => {
    const seen = [];
    let now = NOW;
    for (let at = nextMapRepaintAt([], [{ expire }], now); at !== Infinity; at = nextMapRepaintAt([], [{ expire }], now)) {
      seen.push(Math.round((at - expire) * 1000) / 1000);
      // Each moment is a real change of what the pin layer draws, and the
      // change is no older than 2 ms when the moment comes.
      const before = [waypointExpiryOpacity(expire, at - 0.002), isWaypointExpired(expire, at - 0.002)];
      const after = [waypointExpiryOpacity(expire, at), isWaypointExpired(expire, at)];
      assert.notDeepEqual(after, before, `no visible change at expire${at - expire}`);
      now = at;
    }
    return seen;
  };
  assert.deepEqual(steps(NOW + 3 * 24 * 3600), [-24 * 3600 + 0.001, -3600 + 0.001, 0]);
  assert.deepEqual(steps(NOW + 1800), [0], 'inside the last hour only expiry is left');
  assert.equal(nextMapRepaintAt([], [{ expire: NOW - 10 }], NOW), Infinity, 'an expired pin is gone already');
  assert.equal(nextMapRepaintAt([], [{ expire: 0 }, { expire: null }, null, { expire: -5 }], NOW), Infinity);
});

test('a new planner paints every surface once, then only what is marked', () => {
  const planner = createRepaintPlanner();
  assert.deepEqual([...planner.pending()], ['table', 'map', 'chat'], 'every surface starts unpainted');
  assert.deepEqual([...planner.take(NOW)], ['table', 'map', 'chat']);
  assert.deepEqual([...planner.take(NOW)], [], 'nothing changed since');
  planner.markCollections(['messages']);
  assert.deepEqual([...planner.take(NOW)], ['chat']);
  planner.markAllSurfaces();
  assert.deepEqual([...planner.take(NOW)], ['table', 'map', 'chat']);
  assert.deepEqual(planner.renderCounts(), { table: 2, map: 2, chat: 3 });
  const pending = planner.pending();
  pending.add('table');
  assert.deepEqual([...planner.pending()], [], 'pending() hands out a copy');
});

test('noteRows marks the surfaces of a collection only when its rows changed', () => {
  const planner = createRepaintPlanner();
  planner.take(NOW);
  const node = { node_id: '!a', last_heard: NOW, short_name: 'A' };
  assert.equal(planner.noteRows('nodes', [node], [{ ...node }]), false, 'a re-derived but equal record');
  assert.deepEqual([...planner.take(NOW)], []);
  assert.equal(planner.noteRows('nodes', [node], [{ ...node, last_heard: NOW + 5 }]), true);
  assert.deepEqual([...planner.take(NOW)], ['table', 'map', 'chat']);
  const waypoint = { id: 9, protocol: 'meshtastic', name: 'POI' };
  assert.equal(planner.noteRows('waypoints', [waypoint], [{ ...waypoint, name: 'Moved' }]), true);
  assert.deepEqual([...planner.take(NOW)], ['map', 'chat']);
  planner.noteCollections(
    { neighbors: [], messages: [{ id: 1 }], positions: [] },
    { neighbors: [], messages: [{ id: 1 }, { id: 2 }], positions: [] },
  );
  assert.deepEqual([...planner.take(NOW)], ['chat'], 'only the collection that changed counts');
  planner.noteCollections({}, { neighbors: [{ node_id: '!a', neighbor_id: '!b' }], traces: [{ id: 4 }] });
  assert.deepEqual([...planner.take(NOW)], ['map', 'chat']);
  planner.noteCollections({ telemetry: [], encrypted: [] }, { telemetry: [{ id: 3 }], encrypted: [] });
  assert.deepEqual([...planner.take(NOW)], ['chat']);
});

test('expireAt repaints a surface on the first take at or after its moment', () => {
  const planner = createRepaintPlanner();
  planner.take(NOW);
  planner.expireAt('map', NOW + 10);
  assert.deepEqual([...planner.take(NOW + 9)], []);
  assert.deepEqual([...planner.take(NOW + 10)], ['map']);
  assert.deepEqual([...planner.take(NOW + 20)], [], 'a repaint clears the schedule');
  planner.expireAt('map', NOW + 30);
  planner.expireAt('map', Infinity);
  assert.deepEqual([...planner.take(NOW + 40)], [], 'Infinity clears it too');
});

test('noteRows keys each collection by the key it merges on', () => {
  const rows = {
    nodes: [{ node_id: '!a', v: 1 }, { node_id: '!b', v: 1 }],
    positions: [{ id: 1, v: 1 }, { id: 2, v: 1 }],
    telemetry: [{ id: 1, v: 1 }, { id: 2, v: 1 }],
    neighbors: [{ node_id: '!a', neighbor_id: '!b', v: 1 }, { node_id: '!b', neighbor_id: '!a', v: 1 }],
    traces: [{ id: 1, v: 1 }, { id: 2, v: 1 }],
    waypoints: [{ id: 1, protocol: 'meshtastic', v: 1 }, { id: 1, protocol: 'meshcore', v: 1 }],
    messages: [{ id: 1, v: 1 }, { id: 2, v: 1 }],
    encrypted: [{ id: 1, v: 1 }, { id: 2, v: 1 }],
  };
  for (const [collection, before] of Object.entries(rows)) {
    const planner = createRepaintPlanner();
    planner.take(NOW);
    // The same rows re-sent in the other order are no change...
    const resent = before.map(row => ({ ...row })).reverse();
    assert.equal(planner.noteRows(collection, before, resent), false, `${collection}: re-sent rows`);
    // ... an edit to one of them is.
    const edited = [before[0], { ...before[1], v: 2 }];
    assert.equal(planner.noteRows(collection, before, edited), true, `${collection}: an edited row`);
  }
});

/** The chat's window, as the dashboard passes it (7 days). */
const WEEK = 7 * 24 * 3600;

/**
 * The moment ``buildChatTabModel`` stops showing its earliest entry: the first
 * whole second past ts + window, found by asking the model itself.
 *
 * @param {Object} sources Chat inputs by collection.
 * @param {number} nowSec Render time, unix seconds.
 * @returns {number} Unix seconds, or Infinity when the model shows nothing.
 */
function modelLeavesAt(sources, nowSec) {
  const model = buildChatTabModel({
    nodes: sources.nodes,
    telemetry: sources.telemetry,
    positions: sources.positions,
    neighbors: sources.neighbors,
    traces: sources.traces,
    waypoints: sources.waypoints,
    messages: sources.messages,
    logOnlyMessages: sources.encrypted,
    nowSeconds: Math.floor(nowSec),
    windowSeconds: WEEK,
  });
  const times = [
    ...model.logEntries.map(entry => entry.ts),
    ...model.channels.flatMap(channel => channel.entries.map(entry => entry.ts)),
  ];
  if (!times.length) return Infinity;
  const leavesAt = Math.floor(Math.min(...times) + WEEK) + 1;
  // Cross-check the moment against the model: still shown a second before it,
  // gone at it.
  const shownAt = at => {
    const later = buildChatTabModel({
      nodes: sources.nodes, telemetry: sources.telemetry, positions: sources.positions,
      neighbors: sources.neighbors, traces: sources.traces, waypoints: sources.waypoints,
      messages: sources.messages, logOnlyMessages: sources.encrypted,
      nowSeconds: Math.floor(at), windowSeconds: WEEK,
    });
    return later.logEntries.length + later.channels.reduce((sum, channel) => sum + channel.entries.length, 0);
  };
  assert.ok(shownAt(leavesAt) < shownAt(leavesAt - 1), 'the earliest entry leaves at that moment');
  return leavesAt;
}

test('nextChatRepaintAt matches the chat model for every Log and channel entry source (DR4)', () => {
  const now = NOW;
  const old = now - WEEK + 50;
  const isoOf = ts => new Date(ts * 1000).toISOString();
  const telemetryWithHistory = { id: 3, node_id: '!t', rx_time: now - 10 };
  Object.defineProperty(telemetryWithHistory, 'snapshots', {
    value: [{ node_id: '!t', telemetry_time: old + 7 }, { node_id: '!t', rx_time: now - 10 }],
    enumerable: false,
  });
  const cases = {
    nodes: [{ node_id: '!n', first_heard: old + 1, last_heard: now - 5 }],
    'nodes (last heard, ISO)': [{ node_id: '!n', last_seen_iso: isoOf(old + 2) }],
    telemetry: [telemetryWithHistory],
    positions: [{ id: 4, node_id: '!p', position_time: old + 3 }],
    neighbors: [{ node_id: '!a', neighbor_id: '!b', rx_iso: isoOf(old + 4) }],
    traces: [{ id: 5, src: '!a', dest: '!b', hops: [], rx_time: old + 5 }],
    waypoints: [{ id: 6, protocol: 'meshtastic', node_id: '!w', rx_time: old + 6, expire: 0 }],
    messages: [{ id: 7, channel: 0, from_id: '!m', text: 'hi', rx_time: old + 8 }],
    encrypted: [{ id: 8, encrypted: 'AbC=', from_id: '!e', rx_time: old + 9 }, { id: 9, rx_time: old }],
  };
  for (const [label, rows] of Object.entries(cases)) {
    const collection = label.split(' ')[0];
    const sources = { [collection]: rows };
    const expected = modelLeavesAt(sources, now);
    assert.ok(Number.isFinite(expected), `${label}: the model shows the entry`);
    assert.equal(nextChatRepaintAt(sources, now, WEEK), expected, label);
  }
  // All together, the earliest entry wins: the node's first heard.
  const all = Object.fromEntries(Object.entries(cases).filter(([label]) => !label.includes(' ')));
  assert.equal(nextChatRepaintAt(all, now, WEEK), modelLeavesAt(all, now));
  assert.equal(nextChatRepaintAt(all, now, WEEK), Math.floor(old + 1 + WEEK) + 1);
});

test('nextChatRepaintAt ignores what has left the window, unrendered rows and bad input (DR4)', () => {
  const now = NOW;
  assert.equal(nextChatRepaintAt(null, now, WEEK), Infinity);
  assert.equal(nextChatRepaintAt({ nodes: 'x', messages: [null, 7, {}] }, now, WEEK), Infinity);
  // Out of the window already, or an unencrypted row in the encrypted list.
  assert.equal(nextChatRepaintAt({ messages: [{ id: 1, rx_time: now - WEEK - 5 }] }, now, WEEK), Infinity);
  assert.equal(nextChatRepaintAt({ encrypted: [{ id: 2, rx_time: now - 10 }] }, now, WEEK), Infinity);
  // A fractional (ISO) timestamp leaves at the next whole second past ts + window.
  assert.equal(nextChatRepaintAt({ traces: [{ id: 3, rx_time: now - WEEK + 9.5 }] }, now, WEEK), now + 10);
});

test('nextExpiryTextChangeAt finds the next change of the Log\'s "Expires" text (DR4)', () => {
  /**
   * The Log's expiry text, as buildWaypointChatEntryParts writes it.
   *
   * @param {number} expire Expiry, unix seconds.
   * @param {number} at Render time, unix seconds.
   * @returns {string} Remaining time, or "expired".
   */
  const text = (expire, at) => {
    const remaining = Math.floor(expire - at);
    return remaining > 0 ? timeHum(remaining) : 'expired';
  };
  for (const remaining of [1, 30, 59, 60, 61, 3599, 3600, 3661, 7200, 86399, 86400, 90061, 3 * 86400]) {
    const expire = NOW + remaining;
    const at = nextExpiryTextChangeAt(expire, NOW);
    assert.notEqual(text(expire, at), text(expire, NOW), `${remaining} s left: changes at the moment`);
    assert.equal(text(expire, at - 0.002), text(expire, NOW), `${remaining} s left: not 2 ms earlier`);
  }
  // At NOW + 0.4 the Log shows 29 s; that changes as soon as NOW + 1 passes.
  assert.ok(Math.abs(nextExpiryTextChangeAt(NOW + 30, NOW + 0.4) - (NOW + 1.001)) < 1e-6);
  assert.equal(nextExpiryTextChangeAt(0, NOW), Infinity, 'never expires');
  assert.equal(nextExpiryTextChangeAt(null, NOW), Infinity);
  assert.equal(nextExpiryTextChangeAt('', NOW), Infinity);
  assert.equal(nextExpiryTextChangeAt(NOW, NOW), Infinity, 'expired already');
  assert.equal(nextExpiryTextChangeAt(NOW - 60, NOW), Infinity);
});

test('nextChatRepaintAt counts a waypoint entry down only while the Log shows it (DR4)', () => {
  const now = NOW;
  const shown = { id: 1, protocol: 'meshtastic', rx_time: now - 60, expire: now + 7230 };
  // "2h 0m" left until fewer than 7200 s remain, long before the entry
  // leaves the window.
  assert.ok(Math.abs(nextChatRepaintAt({ waypoints: [shown] }, now, WEEK) - (now + 30.001)) < 1e-6);
  // Past the window the entry is gone, and so is its countdown.
  const gone = { ...shown, rx_time: now - WEEK - 60 };
  assert.equal(nextChatRepaintAt({ waypoints: [gone] }, now, WEEK), Infinity);
  // Expired: only the window is left.
  const expired = { ...shown, expire: now - 1 };
  assert.equal(nextChatRepaintAt({ waypoints: [expired] }, now, WEEK), Math.floor(now - 60 + WEEK) + 1);
});

test('nextChatRepaintAt reads every timestamp field the chat model reads (DR4)', () => {
  const now = NOW;
  const at = now - WEEK + 40;
  const iso = new Date(at * 1000).toISOString();
  // One field per row, so each fallback the model follows is exercised alone.
  const fields = {
    nodes: ['first_heard', 'firstHeard', 'last_heard', 'lastHeard', ['first_heard_iso', iso], ['firstHeardIso', iso], ['last_seen_iso', iso], ['lastSeenIso', iso]],
    telemetry: ['rx_time', 'rxTime', 'telemetry_time', 'telemetryTime', ['rx_iso', iso], ['rxIso', iso], ['telemetry_time_iso', iso], ['telemetryTimeIso', iso]],
    positions: ['rx_time', 'rxTime', 'position_time', 'positionTime', ['rx_iso', iso], ['rxIso', iso], ['position_time_iso', iso], ['positionTimeIso', iso]],
    neighbors: ['rx_time', 'rxTime', ['rx_iso', iso], ['rxIso', iso]],
    waypoints: ['rx_time', 'rxTime', ['rx_iso', iso], ['rxIso', iso]],
    traces: ['rx_time', 'rxTime', ['rx_iso', iso], ['rxIso', iso]],
    messages: ['rx_time', 'rxTime', ['rx_iso', iso], ['rxIso', iso]],
    encrypted: ['rx_time', 'rxTime', ['rx_iso', iso], ['rxIso', iso]],
  };
  const base = {
    nodes: { node_id: '!n' },
    telemetry: { id: 1, node_id: '!t' },
    positions: { id: 2, node_id: '!p' },
    neighbors: { node_id: '!a', neighbor_id: '!b' },
    waypoints: { id: 3, protocol: 'meshtastic', node_id: '!w' },
    traces: { id: 4, src: '!a', dest: '!b', hops: [] },
    messages: { id: 5, channel: 0, from_id: '!m', text: 'hi' },
    encrypted: { id: 6, encrypted: 'AbC=', from_id: '!e' },
  };
  for (const [collection, list] of Object.entries(fields)) {
    for (const field of list) {
      const [name, value] = Array.isArray(field) ? field : [field, at];
      const sources = { [collection]: [{ ...base[collection], [name]: value }] };
      const expected = modelLeavesAt(sources, now);
      assert.equal(expected, Math.floor(at + WEEK) + 1, `${collection}.${name}: the model shows the entry`);
      assert.equal(nextChatRepaintAt(sources, now, WEEK), expected, `${collection}.${name}`);
    }
  }
});

test('a refresh half a second after an Expires or dimming step is past its moment (DR4)', () => {
  // The Log's text changes as soon as the step's boundary passes.
  assert.ok(nextExpiryTextChangeAt(NOW + 120, NOW) <= NOW + 0.5, '2m 0s reads 1m 59s at NOW + 0.5');
  assert.ok(nextExpiryTextChangeAt(NOW + 7200, NOW) <= NOW + 0.5, '2h 0m reads 1h 59m at NOW + 0.5');
  // So does the pin's opacity: 0.7 until 3600 s remain, then 0.4.
  const expire = NOW + 3600 + 10;
  assert.equal(waypointExpiryOpacity(expire, NOW + 10.5), 0.4);
  assert.ok(nextMapRepaintAt([], [{ expire }], NOW) <= NOW + 10.5, 'the pin dims at NOW + 10.5');
});

test('nextChatRepaintAt skips a null snapshot, as the chat model does (DR4)', () => {
  const row = { id: 1, node_id: '!t', rx_time: NOW - 10 };
  Object.defineProperty(row, 'snapshots', {
    value: [null, { node_id: '!t', rx_time: NOW - WEEK + 30 }],
    enumerable: false,
  });
  const sources = { telemetry: [row] };
  assert.equal(nextChatRepaintAt(sources, NOW, WEEK), modelLeavesAt(sources, NOW));
  assert.equal(nextChatRepaintAt(sources, NOW, WEEK), NOW + 31);
});
