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
 * SPEC OR5: no step of the page open can hold the page. Drives `initializeApp`
 * over the page-open harness with a cache open that another tab blocks, a
 * cache open that never answers, and a first `/api/nodes` that never answers,
 * with the page-open bound timers captured so the test fires them. Expected:
 * a blocked cache runs the page network-only (FC7); a seed that never answers
 * holds the first refresh only until `SEED_TIMEOUT_MS`; a hung first refresh
 * holds the stream and the poll only until `START_TIMEOUT_MS`, and when it
 * answers late it merges into the rows loaded since; and a pause or resume
 * while the initial load is pending takes effect.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as sequencer from '../main/page-open-sequencer.js';
import { createFakeIndexedDb } from './fake-indexeddb.js';
import {
  COLD_NODES, boot, settle, waitFor, finishInitialLoad, releaseExcept,
} from './page-open-harness.js';

/** The bounds, read through the namespace so this file loads before SPEC OR5. */
const SEED = sequencer.SEED_TIMEOUT_MS;
const START = sequencer.START_TIMEOUT_MS;

/**
 * Count the cold (first-load) `/api/nodes` fetches.
 *
 * @param {Array<{ url: string }>} calls Recorded fetch calls.
 * @returns {number}
 */
const coldNodes = (calls) => calls.filter((c) => COLD_NODES.test(c.url)).length;

/**
 * Wait until the first refresh has asked for the nodes, then answer every
 * other held GET and leave that one hanging.
 *
 * @param {Array<Object>} calls Recorded fetch calls.
 * @returns {Promise<Object>} The hanging `/api/nodes` call.
 */
async function hangFirstNodes(calls) {
  await waitFor(() => coldNodes(calls) === 1);
  const hung = calls.find((c) => COLD_NODES.test(c.url));
  releaseExcept(calls, hung);
  await settle();
  return hung;
}

test('OR5: a cache open blocked by another tab runs the page network-only (FC7)', async () => {
  const fake = createFakeIndexedDb();
  fake.setOpenMode('blocked'); // another tab holds the cache at an older version
  const { u, calls, FakeEventSource, teardown } = await boot({ indexedDB: fake.factory });
  try {
    await finishInitialLoad(u, calls, 'the initial load settled with the cache blocked');
    assert.equal(u.getLoadedNodeCount(), 2, 'the network rows are shown');
    assert.equal(coldNodes(calls), 1, 'one cold load');
    assert.equal(FakeEventSource.instances.length, 1, 'the stream opened after the load');
    assert.equal(u.getAutoRefreshIntervalMs(), 300_000, 'the safety poll is armed');
    assert.deepEqual(u.getPageOpenBounds(), { seed: false, start: false }, 'no bound was needed');
    fake.unblock(); // the other tab closes; the open now succeeds, after it was given up
    await settle();
    assert.equal(fake.closedCount(), 1, 'the late handle was closed');
  } finally {
    await teardown();
  }
});

test('OR5: a cache open that never answers holds the first refresh only until the seed bound', async () => {
  const fake = createFakeIndexedDb();
  fake.setOpenMode('never');
  const { u, calls, FakeEventSource, bounds, teardown } = await boot({
    indexedDB: fake.factory, captureBounds: true, flushCache: false,
  });
  try {
    await settle();
    assert.equal(calls.filter((c) => /^\/api\/nodes\?/.test(c.url)).length, 0, 'no refresh while the seed waits');
    assert.equal(bounds.fire(SEED), 1, 'the seed bound was armed');
    await finishInitialLoad(u, calls, 'the initial load settled after the seed bound');
    assert.equal(u.getLoadedNodeCount(), 2, 'the network rows are shown');
    assert.equal(FakeEventSource.instances.length, 1, 'the stream opened after the load');
    assert.equal(u.getAutoRefreshIntervalMs(), 300_000, 'the safety poll is armed');
    assert.deepEqual(u.getPageOpenBounds(), { seed: true, start: false });
  } finally {
    await teardown();
  }
});

test('OR5: a first /api/nodes that never answers holds the stream and the poll only until the start bound', async () => {
  const { u, calls, FakeEventSource, es, bounds, teardown } = await boot({ captureBounds: true });
  try {
    const hung = await hangFirstNodes(calls);
    assert.equal(FakeEventSource.instances.length, 0, 'no stream while the first refresh runs');
    assert.equal(bounds.fire(START), 1, 'the start bound was armed');
    await settle();
    assert.equal(FakeEventSource.instances.length, 1, 'the stream opened at the bound');
    assert.equal(u.isLiveActive(), true);
    assert.equal(u.getAutoRefreshIntervalMs(), 300_000, 'the safety poll is armed');
    es().dispatch('open', {}); // the stream's resync loads the page again
    await waitFor(() => coldNodes(calls) === 2);
    releaseExcept(calls, hung);
    await waitFor(() => u.getLoadedNodeCount() === 2);
    assert.equal(u.getLoadedMessageCount() > 0, true, 'the messages are shown');
    assert.deepEqual(u.getPageOpenBounds(), { seed: false, start: true });
  } finally {
    await teardown();
  }
});

test('OR5: a hung first refresh that answers after the resync loaded the page keeps the backfilled history', async () => {
  const { u, calls, es, bounds, teardown } = await boot({ captureBounds: true });
  try {
    const hung = await hangFirstNodes(calls);
    assert.equal(bounds.fire(START), 1, 'the start bound was armed');
    await settle();
    es().dispatch('open', {}); // the stream's resync loads the page
    await waitFor(() => coldNodes(calls) === 2);
    releaseExcept(calls, hung);
    await waitFor(() => u.getLoadedNodeCount() === 2);
    await u.flushBackfill(); // the chat backfill pages the older history in
    assert.equal(u.getLoadedMessageCount(), 2000, 'the resync and the backfill loaded the history');
    hung.release(); // the first refresh finally answers
    await settle();
    assert.equal(u.getLoadedMessageCount(), 2000, `messages after the late first refresh: ${u.getLoadedMessageCount()}`);
    assert.equal(u.getLoadedNodeCount(), 2);
  } finally {
    await teardown();
  }
});

test('OR5: a pause and a resume while the first refresh hangs start the stream at the bound', async () => {
  const { u, calls, FakeEventSource, click, bounds, teardown } = await boot({ withToggle: true, captureBounds: true });
  try {
    await hangFirstNodes(calls);
    click(); // pause
    click(); // resume, while the initial load is pending
    await settle();
    assert.equal(coldNodes(calls), 1, 'the resume issued no second cold load');
    assert.equal(bounds.fire(START), 1, 'the start bound was armed');
    await settle();
    assert.equal(FakeEventSource.instances.length, 1, 'the resumed stream opened at the bound');
    assert.equal(u.isLiveActive(), true);
    assert.equal(u.getAutoRefreshIntervalMs(), 300_000);
  } finally {
    await teardown();
  }
});

test('OR5: a pause while the first refresh hangs keeps the stream off past the bound; a resume then loads at once', async () => {
  const { u, calls, FakeEventSource, click, bounds, teardown } = await boot({ withToggle: true, captureBounds: true });
  try {
    const hung = await hangFirstNodes(calls);
    click(); // pause, while the initial load is pending
    assert.equal(bounds.fire(START), 1, 'the start bound was armed');
    await settle();
    assert.equal(u.isAutorefreshPaused(), true);
    assert.equal(FakeEventSource.instances.length, 0, 'no stream while paused');
    assert.equal(u.getAutoRefreshIntervalMs(), 0, 'no poll while paused');
    click(); // resume
    await settle();
    assert.equal(FakeEventSource.instances.length, 1, 'the resume opened the stream');
    assert.equal(coldNodes(calls), 2, 'the resume loaded the page again');
    releaseExcept(calls, hung);
    await waitFor(() => u.getLoadedNodeCount() === 2);
  } finally {
    await teardown();
  }
});
