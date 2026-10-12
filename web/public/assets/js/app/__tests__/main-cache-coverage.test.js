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
 * SPEC CC1-CC3 (security and performance review, M23): a warm load shows
 * every row a cold load shows. Drives `initializeApp` over a fake mesh API
 * that pages like the server and a fake IndexedDB that outlives each visit.
 * Expected: the cache is written back when each backfill ends, so a short
 * first visit leaves every backfilled row stored; a warm load backfills a
 * collection whose delta page came back full down to the cached rows, and
 * below the cached rows when the coverage marker says they stop short of the
 * window; a cache without a marker is walked once; and a warm load whose
 * delta pages are short and whose cache is complete requests no backward
 * page, the chat included (FC-A2).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDb } from './fake-indexeddb.js';
import { createFakeMeshApi, makeRows, DAY } from './fake-mesh-api.js';
import {
  COUNTED, visit, shownCounts, storedCounts, seedCache, backwardCursors,
} from './cache-visit-harness.js';

const NOW = Math.floor(Date.now() / 1000);
/** The newest row of the first visit's data, an hour before the newer rows. */
const BASE = NOW - 4000;

/**
 * The first visit's rows: every collection has more than one page.
 *
 * @returns {Object<string, Array<Object>>} Rows per collection.
 */
function baseRows() {
  return {
    nodes: makeRows('nodes', { count: 1200, newest: BASE, step: 400 }),
    messages: makeRows('messages', { count: 2100, newest: BASE, step: 240 }),
    positions: makeRows('positions', { count: 2200, newest: BASE, step: 230 }),
    telemetry: makeRows('telemetry', { count: 1100, newest: BASE, step: 450 }),
    neighbors: makeRows('neighbors', { count: 1050, newest: BASE, step: 1600 }),
    traces: makeRows('traces', { count: 260, newest: BASE, step: 6000 }),
  };
}

/**
 * 1,500 rows newer than every base row, 2 s apart.
 *
 * @param {string} name Collection name.
 * @returns {Array<Object>} The newer rows.
 */
const newerRows = name => makeRows(name, { count: 1500, newest: NOW - 10, step: 2, first: 10_000 });

/**
 * A fake mesh API serving `rows`.
 *
 * @param {Object<string, Array<Object>>} rows Rows per collection.
 * @returns {Object} The fake API.
 */
function meshWith(rows) {
  const api = createFakeMeshApi();
  for (const [name, list] of Object.entries(rows)) api.upsert(name, list);
  return api;
}

/**
 * A complete coverage entry for rows whose newest sort value is `to`.
 *
 * @param {number} to Newest cursor held.
 * @returns {{ from: number, to: number, complete: boolean }}
 */
const complete = to => ({ from: 0, to, complete: true });

test('CC1: a short first visit stores every row its backfills paged in', async () => {
  const rows = { ...baseRows(), waypoints: makeRows('waypoints', { count: 1050, newest: BASE, step: 480 }) };
  const api = meshWith(rows);
  const idb = createFakeIndexedDb();
  const shown = await visit({ fetch: api.fetch, idb }, shownCounts);
  const expected = Object.fromEntries(COUNTED.map(name => [name, rows[name].length]));
  assert.deepEqual(shown, expected, 'the visit loaded every row');
  assert.deepEqual(await storedCounts(idb), expected, 'the cache stores every row the visit loaded');
});

test('CC2: a warm load after 1,500 newer rows shows every row a cold load shows, with no middle gap', async () => {
  const api = meshWith(baseRows());
  const idb = createFakeIndexedDb();
  await visit({ fetch: api.fetch, idb });
  for (const name of ['messages', 'positions']) api.upsert(name, newerRows(name));
  const warm = await visit({ fetch: api.fetch, idb }, shownCounts);
  const cold = await visit({ fetch: api.fetch, idb: createFakeIndexedDb() }, shownCounts);
  assert.deepEqual(warm, cold, 'the warm load shows what a cold load shows');
  assert.equal(warm.nodes, 1200, 'nodes past the first page (#832)');
  assert.equal(warm.positions, 3700, 'positions without a middle gap');
  assert.equal(warm.messages, 3600, 'messages without a middle gap');
});

test('CC2: a warm load whose delta page came back full walks the gap down to the cached rows only', async () => {
  const cached = { messages: baseRows().messages, positions: baseRows().positions };
  const api = meshWith(cached);
  for (const name of ['messages', 'positions']) api.upsert(name, newerRows(name));
  const idb = createFakeIndexedDb();
  await seedCache(idb, { rows: cached, coverage: { messages: complete(BASE), positions: complete(BASE) } });
  const shown = await visit({ fetch: api.fetch, idb }, shownCounts);
  assert.equal(shown.positions, 3700, `positions shown: ${shown.positions}`);
  assert.equal(shown.messages, 3600, `messages shown: ${shown.messages}`);
  for (const name of ['messages', 'positions']) {
    const cursors = backwardCursors(api.calls, name);
    assert.equal(cursors.length, 1, `${name}: one backward page bridges the gap: ${cursors}`);
    assert.ok(cursors[0] > BASE, `${name}: the walk starts above the cached rows`);
    const [gap] = api.calls.filter(c => c.name === name && c.before > 0);
    assert.equal(gap.since, BASE, `${name}: the page asks only for rows down to the newest cached one`);
    assert.equal(gap.served, 502, `${name}: the 500 rows of the gap and the boundary row at each end, no other cached row`);
  }
});

test('CC2: a warm load whose coverage marker stops short of the window walks below the cached rows', async () => {
  const all = baseRows();
  const cached = { messages: all.messages.slice(0, 1000), positions: all.positions.slice(0, 1000) };
  const oldest = name => cached[name][cached[name].length - 1].rx_time;
  const api = meshWith({ messages: all.messages, positions: all.positions });
  const idb = createFakeIndexedDb();
  await seedCache(idb, {
    rows: cached,
    coverage: {
      messages: { from: oldest('messages'), to: BASE, complete: false },
      positions: { from: oldest('positions'), to: BASE, complete: false },
    },
  });
  const shown = await visit({ fetch: api.fetch, idb }, shownCounts);
  assert.equal(shown.positions, 2200, `positions shown: ${shown.positions}`);
  assert.equal(shown.messages, 2100, `messages shown: ${shown.messages}`);
  for (const name of ['messages', 'positions']) {
    const cursors = backwardCursors(api.calls, name);
    assert.equal(cursors[0], oldest(name), `${name}: the walk starts at the oldest cached row: ${cursors}`);
    assert.equal(cursors.length, 2, `${name}: two backward pages below the cached rows: ${cursors}`);
  }
});

test('CC2: a cache without a coverage marker is walked once, which fills its middle gap', async () => {
  const all = baseRows().positions;
  // An older visit's cache: the newest 1,000 rows and the oldest 500, not the 700 between.
  const cached = [...all.slice(0, 1000), ...all.slice(1700)];
  const api = meshWith({ positions: all });
  const idb = createFakeIndexedDb();
  await seedCache(idb, { rows: { positions: cached } });
  const shown = await visit({ fetch: api.fetch, idb }, shownCounts);
  assert.equal(shown.positions, 2200, `positions shown: ${shown.positions}`);
  assert.equal(await storedCounts(idb).then(c => c.positions), 2200, 'the cache now stores every row');
});

test('CC3: a warm load from a complete cache with short delta pages requests no backward page (FC-A2)', async () => {
  const rows = baseRows();
  const api = meshWith(rows);
  const idb = createFakeIndexedDb();
  const cursorOf = name => (name === 'nodes' ? 'last_heard' : 'rx_time');
  const names = Object.keys(rows);
  await seedCache(idb, {
    rows,
    coverage: Object.fromEntries(names.map(name => [name, complete(rows[name][0][cursorOf(name)])])),
  });
  const shown = await visit({ fetch: api.fetch, idb }, shownCounts);
  assert.deepEqual(shown, Object.fromEntries(COUNTED.map(name => [name, rows[name] ? rows[name].length : 0])), 'every cached row is shown');
  const backward = api.calls.filter(c => c.before > 0).map(c => c.url);
  assert.deepEqual(backward, [], 'no cached row was requested again, the chat included');
  const deltas = api.calls.filter(c => c.since > 0).map(c => c.name);
  assert.ok(deltas.includes('messages') && deltas.includes('positions'), 'the warm load fetched the deltas');
});

test('CC2: a warm load bridges a gap of several pages and stops at the cached rows', async () => {
  // The cache is two days old; the server holds 2,500 newer rows, so the
  // delta page and two backward pages lie above the cached rows.
  const old = makeRows('positions', { count: 300, newest: NOW - 2 * DAY, step: 600 });
  const newer = makeRows('positions', { count: 2500, newest: NOW - 10, step: 30, first: 20_000 });
  const api = meshWith({ positions: [...newer, ...old] });
  const idb = createFakeIndexedDb();
  await seedCache(idb, { rows: { positions: old }, coverage: { positions: complete(old[0].rx_time) } });
  const shown = await visit({ fetch: api.fetch, idb }, shownCounts);
  assert.equal(shown.positions, 2800, `positions shown: ${shown.positions}`);
  const cursors = backwardCursors(api.calls, 'positions');
  assert.ok(cursors.every(before => before > old[0].rx_time), `no backward page below the cached rows: ${cursors}`);
});

test('CC2: a marker written under another store generation vouches for nothing (CC4)', async () => {
  // A tab wrote this marker before another tab emptied the store and gave it
  // a new generation; the rows it describes are gone.
  const all = baseRows().positions;
  const api = meshWith({ positions: all });
  const idb = createFakeIndexedDb();
  await seedCache(idb, {
    rows: { positions: all.slice(0, 20) },
    coverage: { positions: complete(all[0].rx_time) },
    generation: 'after-the-wipe',
    markerGeneration: 'before-the-wipe',
  });
  const shown = await visit({ fetch: api.fetch, idb }, shownCounts);
  assert.equal(shown.positions, 2200, `positions shown: ${shown.positions}`);
  assert.ok(backwardCursors(api.calls, 'positions').length > 0, 'the cached rows were walked');
});

test('CC3: a warm load whose newest message is encrypted requests no backward chat page', async () => {
  const api = meshWith({ messages: makeRows('messages', { count: 300, newest: BASE, step: 600 }) });
  // The newest message overall is encrypted; it moves the messages `since`
  // above the newest plaintext row.
  api.upsert('encrypted', [{ id: 9_000_001, rx_time: BASE + 3000, from_id: '!00010001', to_id: '^all', channel: 1, encrypted: 'ZW5j', protocol: 'meshtastic' }]);
  const idb = createFakeIndexedDb();
  await visit({ fetch: api.fetch, idb });
  api.calls.length = 0;
  const shown = await visit({ fetch: api.fetch, idb }, shownCounts);
  assert.equal(shown.messages, 300);
  assert.deepEqual(backwardCursors(api.calls, 'messages'), [], 'no backward chat page on the warm load');
});
