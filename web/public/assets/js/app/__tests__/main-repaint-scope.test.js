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
 * SPEC DR4 (#881): a refresh repaints only the surfaces whose data changed.
 *
 * Each test boots the dashboard with a nodes table, a map and a chat, lands
 * one refresh and counts what was rebuilt: `#nodes tbody` rebuilds, node
 * markers and lines the map created, and what the chat shows. Before DR4 every
 * refresh rebuilt all three, so a `messages` ping replaced every table row and
 * every map layer, and ten destination pages repainted the table ten times.
 *
 * @module app/__tests__/main-repaint-scope
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, runMapApp, settle } from './live-map-harness.js';

/**
 * Two meshtastic nodes with positions, one chat message, no neighbours.
 *
 * @returns {Object<string, *>} Stub-fetch responses a test may edit.
 */
function baseResponses() {
  return {
    'encrypted=true': [],
    '/api/nodes': [
      { node_id: '!a', short_name: 'A', long_name: 'Node A', role: 'CLIENT', protocol: 'meshtastic', last_heard: NOW - 30, latitude: 52.5, longitude: 13.4 },
      { node_id: '!b', short_name: 'B', long_name: 'Node B', role: 'ROUTER', protocol: 'meshtastic', last_heard: NOW - 60, latitude: 52.51, longitude: 13.42 },
    ],
    '/api/messages': [
      { id: 1, channel: 0, from_id: '!a', to_id: '^all', text: 'first message', rx_time: NOW - 20, protocol: 'meshtastic' },
    ],
    '/api/neighbors': [],
  };
}

/**
 * Snapshot what has been rebuilt so far: ``#nodes tbody`` rebuilds, node
 * markers and lines the map created, and the chat repaints the planner
 * handed out (read last, so a missing planner fails on the DOM counts first).
 *
 * @param {Object} ctx Harness context.
 * @returns {{ table: number, markers: number, lines: number, chat: (number|undefined) }}
 */
function rebuilt(ctx) {
  return {
    table: ctx.tableRepaints(),
    markers: ctx.leaflet._recorded.circleMarkers.length,
    lines: ctx.leaflet._recorded.polylines.length,
    chat: ctx.testUtils.getSurfaceRenderCounts?.().chat,
  };
}

/**
 * Assert what a refresh rebuilt since ``start``: the DOM counts first, then
 * the chat repaints.
 *
 * @param {Object} ctx Harness context.
 * @param {Object} start Snapshot from {@link rebuilt}.
 * @param {{ table: number, markers: number, lines: number, chat: number }} expected Deltas.
 * @param {string} [label] Assertion context.
 * @returns {void}
 */
function assertRebuilt(ctx, start, expected, label = '') {
  const now = rebuilt(ctx);
  const { chat, ...dom } = expected;
  assert.deepEqual(
    { table: now.table - start.table, markers: now.markers - start.markers, lines: now.lines - start.lines },
    dom,
    `${label} table rebuilds, map markers and lines created`,
  );
  assert.equal(now.chat - start.chat, chat, `${label} chat repaints`);
}

test('a messages ping that changes no node, position or neighbour data repaints the chat alone (DR4)', async () => {
  const responses = baseResponses();
  await runMapApp({ responses }, async ctx => {
    const start = rebuilt(ctx);
    responses['/api/messages'].push(
      { id: 2, channel: 0, from_id: '!a', to_id: '^all', text: 'second message', rx_time: NOW, protocol: 'meshtastic' },
    );
    // A message ingest publishes messages and nodes; the node rows come back unchanged.
    await ctx.ping('messages', 'nodes');

    assert.ok(ctx.chat.innerHTML.includes('second message'), 'the chat shows the new message');
    assertRebuilt(ctx, start, { table: 0, markers: 0, lines: 0, chat: 1 }, 'a messages-only refresh:');
    // The live feedback still lands on the elements already on screen (VF4).
    assert.deepEqual([...ctx.testUtils.getLastFlashedMessageIds()].sort(), ['1', '2']);
    assert.ok(ctx.testUtils.getLastFlashedNodeIds().includes('!a'));
  });
});

test('a refresh that changes nothing repaints nothing: ping, safety poll, resync (DR4)', async () => {
  await runMapApp({ responses: baseResponses() }, async ctx => {
    const start = rebuilt(ctx);
    await ctx.ping('nodes');
    await ctx.ping('messages');
    await ctx.testUtils.refresh();
    ctx.stream.dispatch('open', {});
    await ctx.testUtils.flushLiveRefresh();
    await settle();
    assertRebuilt(ctx, start, { table: 0, markers: 0, lines: 0, chat: 0 }, 'four idle refreshes:');
  });
});

test('a node change repaints the table, the map and the chat (DR4)', async () => {
  const responses = baseResponses();
  await runMapApp({ responses }, async ctx => {
    const start = rebuilt(ctx);
    responses['/api/nodes'][0] = { ...responses['/api/nodes'][0], last_heard: NOW, battery_level: 77 };
    await ctx.ping('nodes');
    assertRebuilt(ctx, start, { table: 1, markers: 2, lines: 0, chat: 1 });
  });
});

test('a neighbour change repaints the map and the chat, not the table (DR4)', async () => {
  const responses = baseResponses();
  await runMapApp({ responses }, async ctx => {
    const start = rebuilt(ctx);
    responses['/api/neighbors'].push({ node_id: '!a', neighbor_id: '!b', snr: 4.5, rx_time: NOW });
    await ctx.ping('neighbors');
    assertRebuilt(ctx, start, { table: 0, markers: 2, lines: 1, chat: 1 });
  });
});

test('a filter edit repaints every surface without any new data (DR4)', async () => {
  let filterInput = null;
  /** Register the filter input before boot. @param {Object} env DOM environment. */
  const beforeBoot = env => {
    filterInput = env.createElement('input', 'filterInput');
    filterInput.value = '';
    env.registerElement('filterInput', filterInput);
  };
  await runMapApp({ responses: baseResponses(), beforeBoot }, async ctx => {
    const start = rebuilt(ctx);
    filterInput.value = 'node';
    for (const handler of filterInput._listeners.get('input')) handler({ type: 'input' });
    assertRebuilt(ctx, start, { table: 1, markers: 2, lines: 0, chat: 1 });
  });
});

test('the map repaints once the clock moves a marker into its next freshness bucket (DR4)', async () => {
  const realNow = Date.now;
  await runMapApp({ responses: baseResponses() }, async ctx => {
    const start = rebuilt(ctx);
    await ctx.testUtils.refresh();
    assertRebuilt(ctx, start, { table: 0, markers: 0, lines: 0, chat: 0 }, 'no bucket moved yet:');
    try {
      // Node A was heard 30 s before NOW; three hours on it leaves the live bucket.
      Date.now = () => (NOW + 3 * 3600) * 1000;
      await ctx.testUtils.refresh();
    } finally {
      Date.now = realNow;
    }
    assertRebuilt(ctx, start, { table: 0, markers: 2, lines: 0, chat: 0 }, 'three hours on:');
  });
});

test('destination pages coalesce into one table repaint, then refresh the counts (DR4)', async () => {
  const identity = '!27716218';
  const responses = baseResponses();
  responses['/api/nodes'].push({
    node_id: identity, short_name: '2771', long_name: 'Department of Decentralization', role: 'NODE',
    protocol: 'reticulum', last_heard: NOW - 90,
  });
  /** One destination row of the identity. @param {number} i Row index. @returns {Object} Row. */
  const destination = i => ({
    id: `d${i}`, node_id: identity, aspect: 'lxmf.delivery', role: 'PEER', name: null, last_heard: NOW - 100 - i,
  });
  // Two full pages and a short one: the walk takes all three, then stops.
  const pages = [
    Array.from({ length: 250 }, (_, i) => destination(i)),
    Array.from({ length: 250 }, (_, i) => destination(250 + i)),
    Array.from({ length: 10 }, (_, i) => destination(500 + i)),
  ];
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let served = 0;
  /** Serve the destination pages, held until released. @param {string} url Request URL. */
  const fetchOverride = url => {
    if (!String(url).startsWith('/api/destinations')) return undefined;
    const page = pages[served] || [];
    served += 1;
    return gate.then(() => ({ ok: true, status: 200, json: () => Promise.resolve(page) }));
  };
  let toggleCount = null;
  /** Register the Reticulum toggle count before boot. @param {Object} env DOM environment. */
  const beforeBoot = env => {
    toggleCount = env.createElement('span', 'protocolToggleReticulumCount');
    env.registerElement('protocolToggleReticulumCount', toggleCount);
  };
  await runMapApp({ responses, fetchOverride, beforeBoot }, async ctx => {
    const start = rebuilt(ctx);
    release();
    await settle(120);
    assert.equal(served, 3, 'the walk fetched all three pages');
    assertRebuilt(ctx, start, { table: 1, markers: 0, lines: 0, chat: 0 }, 'three destination pages:');
    // The coalesced flush still refreshes the stats-driven counts, from the
    // complete index (SPEC RA3).
    assert.match(toggleCount.textContent, /\(510\)$/);
  });
});

test('each MS-A4 refresh path still repaints the chat when its data changed, and keeps the select (DR4, MS-A4)', async () => {
  const responses = baseResponses();
  /**
   * The first ``<select>`` under ``node`` (the channel select; the mock DOM
   * has no tag selectors).
   *
   * @param {Object} node Mock element.
   * @returns {?Object} The select, or ``null``.
   */
  const findSelect = node => {
    if (!node || typeof node !== 'object') return null;
    if (node.tagName === 'SELECT') return node;
    for (const child of node.childNodes || []) {
      const found = findSelect(child);
      if (found) return found;
    }
    return null;
  };
  await runMapApp({ responses }, async ctx => {
    /** @returns {?Object} The channel select now in the chat. */
    const select = () => findSelect(ctx.chat);
    const original = select();
    assert.ok(original, 'the chat renders its channel select');
    let next = 10;
    /** Queue one more channel-0 message for the next fetch. */
    const addMessage = () => {
      next += 1;
      responses['/api/messages'].push({
        id: next, channel: 0, from_id: '!a', to_id: '^all', text: `path message ${next}`, rx_time: NOW + next, protocol: 'meshtastic',
      });
      return `path message ${next}`;
    };
    const paths = [
      ['a messages ping', () => ctx.ping('messages')],
      ['a (re)connect resync', async () => {
        ctx.stream.dispatch('open', {});
        await ctx.testUtils.flushLiveRefresh();
      }],
      ['the safety poll', () => ctx.testUtils.refresh()],
    ];
    for (const [label, run] of paths) {
      const text = addMessage();
      const chatBefore = ctx.testUtils.getSurfaceRenderCounts().chat;
      await run();
      assert.ok(ctx.chat.innerHTML.includes(text), `${label} shows the new message`);
      assert.equal(ctx.testUtils.getSurfaceRenderCounts().chat - chatBefore, 1, `${label} repaints the chat once`);
      assert.equal(select(), original, `${label} keeps the select element`);
    }
    // A nodes ping repaints the chat when a node it shows changed.
    responses['/api/nodes'][0] = { ...responses['/api/nodes'][0], long_name: 'Node A renamed' };
    const chatBefore = ctx.testUtils.getSurfaceRenderCounts().chat;
    await ctx.ping('nodes');
    assert.equal(ctx.testUtils.getSurfaceRenderCounts().chat - chatBefore, 1, 'a node change repaints the chat');
    assert.equal(select(), original, 'a nodes ping keeps the select element');
  });
});

/** The chat's Log window: entries older than this leave the chat (7 days). */
const CHAT_WINDOW_SECONDS = 7 * 24 * 3600;

/**
 * Run ``fn`` with ``Date.now`` pinned to ``atSeconds``.
 *
 * @param {number} atSeconds Unix seconds the clock should read.
 * @param {() => Promise<void>} fn Body.
 * @returns {Promise<void>}
 */
async function withClockAt(atSeconds, fn) {
  const realNow = Date.now;
  Date.now = () => atSeconds * 1000;
  try {
    await fn();
  } finally {
    Date.now = realNow;
  }
}

/**
 * Count the occurrences of ``needle`` in the chat's markup.
 *
 * @param {Object} ctx Harness context.
 * @param {string} needle Text to count.
 * @returns {number} Occurrences.
 */
function chatCount(ctx, needle) {
  return ctx.chat.innerHTML.split(needle).length - 1;
}

test('a Log entry the clock moves out of the 7-day window leaves the chat on the next refresh (DR4)', async () => {
  const responses = baseResponses();
  responses['/api/messages'] = [];
  // 6 d 23 h 58 min old: inside the chat's window and inside the 28-day trim,
  // so no merge removes it; only the clock does.
  responses['/api/neighbors'] = [{ node_id: '!a', neighbor_id: '!b', snr: 4.5, rx_time: NOW - CHAT_WINDOW_SECONDS + 120 }];
  await runMapApp({ responses }, async ctx => {
    assert.equal(chatCount(ctx, 'Broadcasted neighbor info'), 1, 'setup: the neighbour Log entry is shown');
    const start = rebuilt(ctx);
    // Ten minutes on the entry is 7 d + 8 min old.
    await withClockAt(NOW + 600, () => ctx.testUtils.refresh());
    assert.equal(chatCount(ctx, 'Broadcasted neighbor info'), 0, 'the aged-out entry left the Log');
    assertRebuilt(ctx, start, { table: 0, markers: 0, lines: 0, chat: 1 }, 'a clock-only chat change:');
  });
});

test('a waypoint Log entry updates its Expires text on the next refresh (DR4)', async () => {
  const responses = baseResponses();
  responses['/api/messages'] = [];
  responses['/api/waypoints'] = [
    { id: 5, protocol: 'meshtastic', name: 'Probe POI', node_id: '!a', from_id: '!a', latitude: 52.52, longitude: 13.41, expire: NOW + 120, rx_time: NOW - 45 },
  ];
  await runMapApp({ responses }, async ctx => {
    assert.equal(chatCount(ctx, 'expired'), 0, 'setup: the waypoint has not expired');
    const start = rebuilt(ctx);
    // Ten minutes on: past its expiry.
    await withClockAt(NOW + 600, () => ctx.testUtils.refresh());
    assert.equal(chatCount(ctx, 'expired'), 1, 'the Log labels the broadcast expired');
    assertRebuilt(ctx, start, { table: 0, markers: 2, lines: 0, chat: 1 }, 'the pin expired too:');
  });
});

test('node first/last-heard, trace and encrypted Log entries leave the chat as the clock passes them (DR4)', async () => {
  const responses = baseResponses();
  responses['/api/messages'] = [];
  // Node B: first heard, then last heard, inside the window by 100 s and 400 s.
  responses['/api/nodes'][1] = {
    ...responses['/api/nodes'][1],
    first_heard: NOW - CHAT_WINDOW_SECONDS + 100,
    last_heard: NOW - CHAT_WINDOW_SECONDS + 400,
  };
  responses['/api/traces'] = [{ id: 9, src: '!a', dest: '!b', hops: [], rx_time: NOW - CHAT_WINDOW_SECONDS + 200 }];
  responses['encrypted=true'] = [
    { id: 77, encrypted: 'c2VjcmV0', from_id: '!a', to_id: '^all', channel: 0, rx_time: NOW - CHAT_WINDOW_SECONDS + 300, protocol: 'meshtastic' },
  ];
  await runMapApp({ responses }, async ctx => {
    const seen = () => ({
      newNode: chatCount(ctx, 'New node:'),
      trace: chatCount(ctx, 'Caught trace'),
      encrypted: chatCount(ctx, 'encrypted message'),
      adverts: chatCount(ctx, 'Updated node info (advert)'),
    });
    assert.deepEqual(seen(), { newNode: 1, trace: 1, encrypted: 1, adverts: 2 }, 'setup: every entry is shown');
    const start = rebuilt(ctx);
    const steps = [
      [150, { newNode: 0, trace: 1, encrypted: 1, adverts: 2 }],
      [250, { newNode: 0, trace: 0, encrypted: 1, adverts: 2 }],
      [350, { newNode: 0, trace: 0, encrypted: 0, adverts: 2 }],
      [450, { newNode: 0, trace: 0, encrypted: 0, adverts: 1 }],
    ];
    for (const [offset, expected] of steps) {
      await withClockAt(NOW + offset, () => ctx.testUtils.refresh());
      assert.deepEqual(seen(), expected, `${offset} s on`);
    }
    assertRebuilt(ctx, start, { table: 0, markers: 0, lines: 0, chat: 4 }, 'four clock-only chat changes:');
  });
});

test('with the chat turned off, the clock schedules no chat repaint (DR4)', async () => {
  const responses = baseResponses();
  responses['/api/messages'] = [];
  // Node B's last heard would leave a chat's window 100 s from now.
  responses['/api/nodes'][1] = { ...responses['/api/nodes'][1], last_heard: NOW - CHAT_WINDOW_SECONDS + 100 };
  await runMapApp({ responses, configOverrides: { chatEnabled: false } }, async ctx => {
    const start = rebuilt(ctx);
    await withClockAt(NOW + 200, () => ctx.testUtils.refresh());
    assertRebuilt(ctx, start, { table: 0, markers: 0, lines: 0, chat: 0 }, 'chat off:');
  });
});

/**
 * Boot the dashboard with ``Date.now`` pinned to ``startSec`` and hand the
 * body a setter that moves the pinned clock.
 *
 * @param {number} startSec Unix seconds the clock reads at boot.
 * @param {Object} options Options for {@link runMapApp}.
 * @param {(ctx: Object, setClock: (sec: number) => void) => Promise<void>} fn Body.
 * @returns {Promise<void>}
 */
async function runWithPinnedClock(startSec, options, fn) {
  const realNow = Date.now;
  let clock = startSec;
  Date.now = () => clock * 1000;
  try {
    await runMapApp(options, ctx => fn(ctx, sec => {
      clock = sec;
    }));
  } finally {
    Date.now = realNow;
  }
}

for (const [unit, left, before, after] of [['seconds', 120, '2m 0s', '1m 59s'], ['minutes', 7200, '2h 0m', '1h 59m']]) {
  test(`a refresh half a second after the Expires text changes repaints the chat (${unit}, DR4)`, async () => {
    const responses = baseResponses();
    responses['/api/messages'] = [];
    responses['/api/waypoints'] = [
      { id: 5, protocol: 'meshtastic', name: 'Probe POI', node_id: '!a', from_id: '!a', latitude: 52.52, longitude: 13.41, expire: NOW + left, rx_time: NOW - 45 },
    ];
    await runWithPinnedClock(NOW, { responses }, async (ctx, setClock) => {
      assert.equal(chatCount(ctx, `Expires: ${before}`), 1, `setup: the Log reads ${before}`);
      const chatBefore = ctx.testUtils.getSurfaceRenderCounts().chat;
      setClock(NOW + 0.5);
      await ctx.testUtils.refresh();
      assert.equal(chatCount(ctx, `Expires: ${after}`), 1, `the Log reads ${after}`);
      assert.equal(ctx.testUtils.getSurfaceRenderCounts().chat - chatBefore, 1, 'one chat repaint');
    });
  });
}
