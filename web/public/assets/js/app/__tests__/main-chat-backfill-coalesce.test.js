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
 * SPEC BK1, BK2: the chat history backfill (issue #802) folds its pages into
 * the backfill's coalesced idle repaint, the one the bulk-collection backfill
 * uses (FP-A2), instead of rendering the chat once per page, and flushes that
 * repaint once when the walk ends.
 *
 * Each test boots `initializeApp` with a `#chat`, a newest message page and
 * older pages the test releases one at a time. A queued
 * `requestIdleCallback` (`installIdleQueue` in `async-helpers.js`) stands in
 * for the browser's idle time, so the test decides when the coalesced repaint
 * may run. The chat renders are counted
 * on `#chat` itself: `renderChatTabs` marks the active tab there
 * (`dataset.activeTab`) once per render.
 *
 * @module __tests__/main-chat-backfill-coalesce
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { deferred, installIdleQueue } from './async-helpers.js';
import { initializeApp } from '../main.js';
import { MESSAGE_LIMIT } from '../message-limit.js';

const NOW = Math.floor(Date.now() / 1000);

/** Dashboard config with no refresh timer and no live stream. */
const BASE_CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

/** A valid `/api/stats` answer: one active Meshtastic node. */
const STATS = Object.freeze({
  total: { nodes: { hour: 1, day: 1, week: 1, month: 1 } },
  meshtastic: { nodes: { hour: 1, day: 1, week: 1, month: 1 } },
});

/** The one sender every message names. */
const NODE = Object.freeze({
  node_id: '!0000aabb', short_name: 'AB', long_name: 'Node AB', role: 'CLIENT', protocol: 'meshtastic', last_heard: NOW,
});

/**
 * One page of primary-channel messages, newest first, as `/api/messages`
 * serves it.
 *
 * @param {string} label Text prefix naming the page.
 * @param {number} count Rows on the page.
 * @param {number} age Age in seconds of the page's newest row.
 * @param {number} firstId Id of the page's newest row.
 * @returns {Array<Object>} Message rows.
 */
function messagePage(label, count, age, firstId) {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    rx_time: NOW - age - index,
    from_id: NODE.node_id,
    to_id: '^all',
    channel: 0,
    portnum: 'TEXT_MESSAGE_APP',
    text: `${label} line ${index}`,
    protocol: 'meshtastic',
  }));
}

/**
 * Let the promise chains of a released page run to their end.
 *
 * @returns {Promise<void>}
 */
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Count the chat renders: `renderChatTabs` writes `dataset.activeTab` on
 * `#chat` once per render.
 *
 * @param {Object} chat The `#chat` element.
 * @returns {{ count: function(): number, reset: function(): void }} The counter.
 */
function countChatRenders(chat) {
  let renders = 0;
  chat.dataset = new Proxy({}, {
    set(target, key, value) {
      if (key === 'activeTab') renders += 1;
      target[key] = value;
      return true;
    },
  });
  return {
    count: () => renders,
    reset: () => {
      renders = 0;
    },
  };
}

/**
 * Boot the dashboard on a newest message page, with each older page held
 * until the test releases it, run `fn`, then tear everything down.
 *
 * @param {{ newest: Array<Object>, olderPages: number }} setup The newest page
 *   and how many older pages the walk may request.
 * @param {function(Object): Promise<void>} fn Test body. Its context holds
 *   `testUtils`, `chat`, `renders`, `idle`, `release(index, rows)`,
 *   `fail(index, error)`, `requested()` and `warnings`.
 * @returns {Promise<void>}
 */
async function runBackfillApp({ newest, olderPages }, fn) {
  const env = createDomEnvironment({ includeBody: true });
  const chat = env.createElement('div', 'chat');
  env.registerElement('chat', chat);
  const renders = countChatRenders(chat);
  const idle = installIdleQueue();
  const pages = Array.from({ length: olderPages }, () => deferred());
  let requested = 0;
  const response = body => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
  const originalFetch = globalThis.fetch;
  const originalIdb = globalThis.indexedDB;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  globalThis.indexedDB = undefined;
  globalThis.fetch = url => {
    if (url.startsWith('/api/messages')) {
      if (url.includes('encrypted=true')) return Promise.resolve(response([]));
      if (url.includes('before=')) {
        const page = pages[requested];
        requested += 1;
        return page ? page.promise.then(response) : Promise.resolve(response([]));
      }
      return Promise.resolve(response(newest));
    }
    if (url.startsWith('/api/nodes')) return Promise.resolve(response([NODE]));
    if (url.startsWith('/api/stats')) return Promise.resolve(response(STATS));
    return Promise.resolve(response([]));
  };
  let testUtils = null;
  try {
    ({ _testUtils: testUtils } = initializeApp(BASE_CONFIG));
    await testUtils.initialLoad;
    await settle();
    renders.reset();
    await fn({
      testUtils,
      chat,
      renders,
      idle,
      warnings,
      requested: () => requested,
      release: (index, rows) => pages[index].resolve(rows),
      fail: (index, error) => pages[index].reject(error),
    });
  } finally {
    for (const page of pages) page.resolve([]);
    if (testUtils) {
      await testUtils.flushBackfill();
      testUtils.stopAutoRefresh();
    }
    globalThis.fetch = originalFetch;
    globalThis.indexedDB = originalIdb;
    console.warn = originalWarn;
    idle.restore();
    env.cleanup();
  }
}

/**
 * The table, map and chat repaints the planner handed out since `start`.
 *
 * @param {Object} testUtils The app's test hooks.
 * @param {{ table: number, map: number, chat: number }} start Earlier counts.
 * @returns {{ table: number, map: number, chat: number }} Repaints since.
 */
function surfacesSince(testUtils, start) {
  const now = testUtils.getSurfaceRenderCounts();
  return { table: now.table - start.table, map: now.map - start.map, chat: now.chat - start.chat };
}

test('the chat backfill folds its pages into the idle repaint and flushes once when it ends (BK1)', async () => {
  const newest = messagePage('newest', 5, 0, 100_000);
  await runBackfillApp({ newest, olderPages: 3 }, async ({ testUtils, chat, renders, idle, release }) => {
    const start = testUtils.getSurfaceRenderCounts();
    assert.ok(chat.innerHTML.includes('newest line 0'), 'the newest page is on screen');

    release(0, messagePage('first older', MESSAGE_LIMIT, 100, 200_000));
    await settle();
    assert.equal(testUtils.getLoadedMessageCount(), 5 + MESSAGE_LIMIT, 'page 1 is merged as it lands (PL-A1)');
    assert.equal(renders.count(), 0, 'page 1: the chat is not rendered per page');
    assert.ok(!chat.innerHTML.includes('first older line 0'), 'page 1 waits for the idle repaint');
    assert.equal(idle.pending(), 1, 'page 1 queued one idle repaint');

    release(1, messagePage('second older', MESSAGE_LIMIT, 100 + MESSAGE_LIMIT, 300_000));
    await settle();
    assert.equal(testUtils.getLoadedMessageCount(), 5 + 2 * MESSAGE_LIMIT, 'page 2 is merged as it lands');
    assert.equal(renders.count(), 0, 'page 2: still no chat render');
    assert.equal(idle.pending(), 1, 'page 2 joined the repaint page 1 queued');

    assert.equal(idle.run(), 1);
    assert.equal(renders.count(), 1, 'one idle repaint renders both pages');
    assert.ok(chat.innerHTML.includes('first older line 0') && chat.innerHTML.includes('second older line 0'));

    release(2, messagePage('third older', 3, 100 + 2 * MESSAGE_LIMIT, 400_000));
    await testUtils.flushBackfill();
    assert.equal(testUtils.getLoadedMessageCount(), 5 + 2 * MESSAGE_LIMIT + 3);
    assert.equal(renders.count(), 2, 'the walk ends with one flush that paints the last page at once');
    assert.ok(chat.innerHTML.includes('third older line 2'));
    assert.equal(idle.pending(), 0, 'the final flush took the queued repaint');
    assert.equal(idle.cancelled.length, 1, 'and cancelled its idle callback');
    assert.deepEqual(surfacesSince(testUtils, start), { table: 0, map: 0, chat: 2 },
      'both repaints went through the planner and repainted the chat alone (DR4)');
  });
});

test('a failed page ends the walk with one flush that paints the pages before it (BK1)', async () => {
  const newest = messagePage('newest', 5, 0, 100_000);
  await runBackfillApp({ newest, olderPages: 2 }, async ({ testUtils, chat, renders, idle, release, fail, warnings }) => {
    release(0, messagePage('first older', MESSAGE_LIMIT, 100, 200_000));
    await settle();
    assert.equal(renders.count(), 0, 'page 1 waits for the idle repaint');
    assert.equal(idle.pending(), 1);

    fail(1, new Error('page 2 failed'));
    await testUtils.flushBackfill();
    assert.equal(renders.count(), 1, 'the flush at the end of the walk painted page 1');
    assert.ok(chat.innerHTML.includes('first older line 0'));
    assert.ok(chat.innerHTML.includes('newest line 0'), 'the newest page stays on screen');
    assert.equal(idle.pending(), 0);
    assert.ok(warnings.some(args => String(args[0]).includes('chat history backfill failed')),
      'the failure is logged, not rethrown');
  });
});

test('a page that changes no message queues and repaints nothing (BK1, DR4)', async () => {
  const newest = messagePage('newest', 5, 0, 100_000);
  await runBackfillApp({ newest, olderPages: 1 }, async ({ testUtils, renders, idle, release, requested }) => {
    const start = testUtils.getSurfaceRenderCounts();
    const idleRequests = idle.requested.length;
    // The server sends the newest rows again, unchanged, as one short page.
    release(0, JSON.parse(JSON.stringify(newest)));
    await testUtils.flushBackfill();
    assert.equal(requested(), 1, 'the walk requested its one page');
    assert.equal(testUtils.getLoadedMessageCount(), 5);
    assert.equal(renders.count(), 0, 'nothing changed, so nothing was rendered');
    assert.equal(idle.requested.length, idleRequests, 'the unchanged page queued no idle callback');
    assert.equal(idle.pending(), 0);
    assert.deepEqual(surfacesSince(testUtils, start), { table: 0, map: 0, chat: 0 });
  });
});

test('a reader scrolled up in a channel keeps their offset while the backfill paints above them (BK2, DR3)', async () => {
  const newest = messagePage('newest', 40, 0, 100_000);
  await runBackfillApp({ newest, olderPages: 2 }, async ({ testUtils, chat, renders, idle, release }) => {
    const panel = chat.children[1].children.find(candidate => candidate.hidden === false);
    assert.ok(panel, 'the primary channel panel is shown');
    // Layout for this panel: 20 px per row (an entry or a day divider) in a
    // 300 px viewport, with the offset clamped to the scroll range. Every
    // write is recorded.
    const rows = () => panel.childNodes.filter(node => String(node.className || '').includes('chat-entry')).length;
    const messages = () => panel.childNodes.filter(node => Boolean(node.dataset && node.dataset.messageId)).length;
    const range = () => Math.max(0, rows() * 20 - 300);
    let offset = 0;
    const writes = [];
    Object.defineProperty(panel, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, get: () => Math.max(300, rows() * 20) });
    Object.defineProperty(panel, 'scrollTop', {
      configurable: true,
      get: () => Math.min(offset, range()),
      set: value => {
        writes.push(value);
        offset = Math.min(Math.max(Number(value) || 0, 0), range());
      },
    });
    panel.scrollTop = 120; // the reader scrolls up to read history
    writes.length = 0;

    release(0, messagePage('first older', MESSAGE_LIMIT, 100, 200_000));
    await settle();
    idle.run();
    release(1, messagePage('second older', 30, 100 + MESSAGE_LIMIT, 300_000));
    await testUtils.flushBackfill();
    assert.equal(renders.count(), 2, 'one idle repaint and the final flush');
    assert.equal(messages(), 40 + MESSAGE_LIMIT + 30, 'every page is on screen');
    assert.deepEqual(writes, [], 'no repaint wrote the offset of the reader scrolled up');
    assert.equal(panel.scrollTop, 120, 'the reader was not pinned to the newest entry');
  });
});
