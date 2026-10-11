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
 * SPEC OR1-OR3: one initial load per page open. Drives `initializeApp` over a
 * fake `EventSource` and a stub `fetch` whose collection GETs are held until
 * the test releases them (`page-open-harness.js`), so a stream that opens, or
 * a ping that lands, while the cache seed and the first refresh are still
 * running can be modelled.
 * Expected: one cold `/api/nodes` fetch per page open (EF-A2), a first resync
 * that is a delta (PS5), backfilled history that survives it, a seed that
 * never overwrites network rows, and no start after a stop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDb } from './fake-indexeddb.js';
import {
  NOW, HELD, COLD_NODES, gatedFactory, settle, waitFor, finishInitialLoad, boot,
} from './page-open-harness.js';
import { createIndexedDbBackend } from '../main/data-cache-idb.js';
import { CACHE_SCHEMA_VERSION } from '../main/data-cache.js';

test('H6: the stream opening during the initial load issues no second cold load (EF-A2)', async () => {
  const { calls, es, teardown } = await boot();
  try {
    if (es()) es().dispatch('open', {}); // the SSE response landed before the first refresh finished
    await settle();
    for (const c of calls) c.release(); // the initial load completes
    await settle();
    if (es()) es().dispatch('open', {}); // a stream opened after the load resyncs too
    await settle();
    const cold = calls.filter((c) => COLD_NODES.test(c.url));
    assert.equal(cold.length, 1, `cold /api/nodes fetches: ${cold.length}`);
  } finally {
    await teardown();
  }
});

test('H6: a resync that started before the first load finished keeps the backfilled history', async () => {
  const { u, calls, es, teardown } = await boot();
  try {
    if (es()) es().dispatch('open', {});
    await settle();
    const firstSet = calls.filter((c) => !c.released); // resync refresh's GETs, then the initial refresh's
    const half = firstSet.length > 8 ? firstSet.length / 2 : firstSet.length;
    for (const c of firstSet.slice(0, half)) c.release(); // one refresh completes first
    await settle();
    await u.flushBackfill(); // the chat backfill pages OLDER in
    const afterBackfill = u.getLoadedMessageCount();
    for (const c of firstSet.slice(half)) c.release(); // the other refresh lands last
    await settle();
    if (es()) es().dispatch('open', {}); // stream (re)opens after the load
    await settle();
    for (const c of calls) c.release();
    await settle();
    assert.equal(afterBackfill, 2000, 'backfill merged the older page');
    assert.equal(u.getLoadedMessageCount(), 2000, `messages after the late refresh: ${u.getLoadedMessageCount()}`);
  } finally {
    await teardown();
  }
});

test('H6: a change ping during the initial load issues no second cold load', async () => {
  const { calls, es, teardown } = await boot();
  try {
    if (es()) es().dispatch('change', { data: JSON.stringify({ collection: 'messages' }) });
    await new Promise((resolve) => setTimeout(resolve, 300)); // past the 250 ms live debounce
    await settle();
    for (const c of calls) c.release();
    await settle();
    const cold = calls.filter((c) => COLD_NODES.test(c.url));
    assert.equal(cold.length, 1, `cold /api/nodes fetches after one messages ping: ${cold.length}`);
  } finally {
    await teardown();
  }
});

test('OR1: no stream and no poll until the initial load settles; the first resync is a delta (PS5)', async () => {
  const { u, calls, FakeEventSource, es, teardown } = await boot();
  try {
    await settle();
    assert.equal(FakeEventSource.instances.length, 0, 'no stream while the initial load runs');
    assert.equal(u.isLiveActive(), false);
    assert.equal(u.getAutoRefreshIntervalMs(), 0, 'no poll while the initial load runs');
    await finishInitialLoad(u, calls);
    assert.equal(FakeEventSource.instances.length, 1, 'one stream once the load has settled');
    assert.equal(u.isLiveActive(), true);
    assert.equal(u.getAutoRefreshIntervalMs(), 300_000, 'the safety poll is armed with it');
    await u.flushBackfill(); // the chat backfill's backward pages are not part of the resync
    const before = calls.length;
    es().dispatch('open', {});
    await settle();
    const resync = calls.slice(before).filter((c) => /^\/api\/(nodes|messages)\?/.test(c.url));
    assert.equal(resync.length, 3, `nodes, messages and encrypted messages resync: ${resync.map((c) => c.url).join(', ')}`);
    assert.ok(
      resync.every((c) => c.url.includes('since=')),
      `the first resync is a delta: ${resync.map((c) => c.url).join(', ')}`,
    );
  } finally {
    await teardown();
  }
});

test('OR3: a stop during the initial load cancels the deferred start; an explicit restart still starts', async () => {
  const { u, calls, FakeEventSource, teardown } = await boot();
  try {
    await settle(); // the first refresh has issued its (held) GETs
    u.stopAutoRefresh(); // the page is torn down before its first load settles
    await finishInitialLoad(u, calls);
    await settle();
    assert.equal(FakeEventSource.instances.length, 0, 'no stream opened after the stop');
    assert.equal(u.isLiveActive(), false, 'the stream stays closed after the stop');
    assert.equal(u.getAutoRefreshIntervalMs(), 0, 'no poll re-armed after the stop');
    u.restartAutoRefresh();
    assert.equal(FakeEventSource.instances.length, 1, 'an explicit restart opens the stream');
    assert.equal(u.getAutoRefreshIntervalMs(), 300_000);
  } finally {
    await teardown();
  }
});

test('OR2: a seed that finishes after a refresh loaded network rows leaves them in place', async () => {
  const fake = createFakeIndexedDb();
  // A warm cache: one node and one message the network no longer serves.
  const cache = createIndexedDbBackend({ indexedDB: fake.factory, databaseName: 'potato-mesh-cache' });
  await cache.write('meta', 'meta', { schemaVersion: CACHE_SCHEMA_VERSION, instanceId: '' });
  await cache.write('nodes', '!c', {
    value: { node_id: '!c', short_name: 'C', long_name: 'Node C', last_heard: NOW - 60, protocol: 'meshtastic' },
    cachedAt: NOW,
  });
  await cache.write('messages', '9000', {
    value: { id: 9000, channel: 0, from_id: '!c', to_id: '^all', text: 'cached', rx_time: NOW - 60, protocol: 'meshtastic' },
    cachedAt: NOW,
  });
  const gate = gatedFactory(fake.factory);
  const { u, calls, teardown } = await boot({ indexedDB: gate.factory });
  try {
    // The cache is still opening, so the seed waits; a refresh loads the
    // network rows meanwhile (before SPEC OR1, a resync racing the seed).
    const network = u.refresh();
    for (const c of calls) c.release();
    await network;
    await u.flushBackfill(); // the refresh's chat backfill pages OLDER in
    assert.equal(u.getLoadedNodeCount(), 2, 'the refresh loaded the network nodes');
    assert.equal(u.getLoadedMessageCount(), 2000, 'the refresh and its backfill loaded the network messages');
    const held = calls.length;
    gate.release(); // the seed's cache reads now finish, after the network rows
    // Once the seed has finished, the initial refresh issues its (held) GETs.
    await waitFor(() => calls.slice(held).some((c) => HELD.test(c.url) && !c.released));
    assert.equal(u.getLoadedNodeCount(), 2, 'the late seed left the network nodes in place');
    assert.equal(u.getLoadedMessageCount(), 2000, 'the late seed left the network messages in place');
    assert.ok(
      calls.slice(held).filter((c) => /^\/api\/nodes\?/.test(c.url)).every((c) => c.url.includes('since=')),
      'the initial refresh after the network rows is a delta',
    );
  } finally {
    gate.release();
    await teardown();
  }
});

test('OR1: a pause and resume during the initial load start one stream, after the load, with no second cold load', async () => {
  const { u, calls, FakeEventSource, click, teardown } = await boot({ withToggle: true });
  try {
    click(); // pause while the first load runs
    click(); // resume, still during the first load
    await settle();
    assert.equal(FakeEventSource.instances.length, 0, 'no stream while the initial load runs');
    await finishInitialLoad(u, calls);
    await settle();
    assert.equal(FakeEventSource.instances.length, 1, 'the resumed stream opens once the load has settled');
    assert.equal(u.isLiveActive(), true);
    const cold = calls.filter((c) => COLD_NODES.test(c.url));
    assert.equal(cold.length, 1, `the resume issued no second cold load: ${cold.length}`);
  } finally {
    await teardown();
  }
});

test('OR1: a pause during the initial load keeps the stream and the poll off once it settles', async () => {
  const { u, calls, FakeEventSource, click, teardown } = await boot({ withToggle: true });
  try {
    click(); // pause while the first load runs
    await finishInitialLoad(u, calls);
    await settle();
    assert.equal(u.isAutorefreshPaused(), true);
    assert.equal(FakeEventSource.instances.length, 0, 'no stream opened while paused');
    assert.equal(u.isLiveActive(), false);
    assert.equal(u.getAutoRefreshIntervalMs(), 0, 'no poll armed while paused');
  } finally {
    await teardown();
  }
});

test('OR1: a pause and resume after the initial load refresh at once and reopen the stream', async () => {
  const { u, calls, FakeEventSource, click, teardown } = await boot({ withToggle: true });
  try {
    await finishInitialLoad(u, calls);
    click(); // pause
    assert.equal(u.isLiveActive(), false, 'the pause closed the stream');
    const before = calls.length;
    click(); // resume
    assert.equal(FakeEventSource.instances.length, 2, 'the resume reopened the stream');
    assert.equal(u.isLiveActive(), true);
    const resumed = calls.slice(before).filter((c) => /^\/api\/nodes\?/.test(c.url));
    assert.equal(resumed.length, 1, 'the resume refreshed at once');
    assert.ok(resumed[0].url.includes('since='), `the resume refresh is a delta: ${resumed[0].url}`);
  } finally {
    await teardown();
  }
});
