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
 * Unit coverage for the cold-load boot prefetch (initial-load latency fix).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coldLoadUrls,
  startBootPrefetch,
  runBootPrefetch,
  maybeBootstrap,
  BOOT_CACHE_FLAG,
  BOOT_GLOBAL,
} from '../boot-prefetch.js';

/** Build a recording fetch stub returning a resolved Response-like value. */
function recordingFetch() {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  };
  return { fn, calls };
}

test('coldLoadUrls includes all seven collections with chat enabled', () => {
  const urls = coldLoadUrls({ chatEnabled: true });
  assert.deepEqual(urls, {
    nodes: '/api/nodes?limit=1000',
    positions: '/api/positions?limit=1000',
    telemetry: '/api/telemetry?limit=1000',
    neighbors: '/api/neighbors?limit=1000',
    traces: '/api/traces?limit=200',
    messages: '/api/messages?limit=1000',
    encryptedMessages: '/api/messages?limit=1000&encrypted=true',
  });
});

test('coldLoadUrls omits message endpoints when chat is disabled (private mode)', () => {
  const urls = coldLoadUrls({ chatEnabled: false });
  assert.deepEqual(Object.keys(urls).sort(), ['neighbors', 'nodes', 'positions', 'telemetry', 'traces']);
});

test('coldLoadUrls defaults to chat enabled', () => {
  assert.ok('messages' in coldLoadUrls());
});

test('startBootPrefetch fires every cold URL with high priority and returns the map', () => {
  const { fn, calls } = recordingFetch();
  const boot = startBootPrefetch({ storage: null, fetchFn: fn, chatEnabled: true });
  assert.equal(calls.length, 7);
  assert.ok(calls.every(c => c.init && c.init.priority === 'high'));
  assert.deepEqual(Object.keys(boot).sort(), ['encryptedMessages', 'neighbors', 'nodes', 'positions', 'telemetry', 'traces'].concat('messages').sort());
});

test('startBootPrefetch skips entirely on a warm load (cache-present marker)', () => {
  const { fn, calls } = recordingFetch();
  const storage = { getItem: key => (key === BOOT_CACHE_FLAG ? '1' : null) };
  const boot = startBootPrefetch({ storage, fetchFn: fn, chatEnabled: true });
  assert.equal(boot, null);
  assert.equal(calls.length, 0, 'no prefetch on a warm load');
});

test('startBootPrefetch treats a throwing storage as a cold load', () => {
  const { fn, calls } = recordingFetch();
  const storage = { getItem: () => { throw new Error('blocked'); } };
  const boot = startBootPrefetch({ storage, fetchFn: fn, chatEnabled: false });
  assert.ok(boot, 'returns a boot map despite storage error');
  assert.equal(calls.length, 5, 'cold prefetch (no messages, chat disabled)');
});

test('startBootPrefetch returns null when fetch is unavailable', () => {
  assert.equal(startBootPrefetch({ storage: null, fetchFn: null }), null);
});

test('startBootPrefetch with no argument is a no-op (no env to prefetch with)', () => {
  // Exercises the ``= {}`` default — no storage, no fetch ⇒ nothing prefetched.
  assert.equal(startBootPrefetch(), null);
});

test('startBootPrefetch skips a collection whose fetch throws synchronously, keeping the rest', () => {
  const calls = [];
  const fn = (url) => {
    calls.push(url);
    if (url.startsWith('/api/nodes')) throw new Error('boom');
    return Promise.resolve({ ok: true });
  };
  const boot = startBootPrefetch({ storage: null, fetchFn: fn, chatEnabled: false });
  assert.ok(!('nodes' in boot), 'the throwing collection is omitted');
  assert.ok('positions' in boot, 'other collections still prefetch');
});

test('runBootPrefetch reads chat flag from the boot tag and stashes the map on the window', () => {
  const { fn, calls } = recordingFetch();
  const tag = { getAttribute: name => (name === 'data-pm-chat' ? 'false' : null) };
  const doc = { querySelector: sel => (sel === 'script[data-pm-prefetch]' ? tag : null) };
  const win = { localStorage: null, fetch: fn };
  const boot = runBootPrefetch(doc, win);
  assert.equal(calls.length, 5, 'private mode: no message prefetch');
  assert.equal(win[BOOT_GLOBAL], boot, 'boot map stashed on the window global');
});

test('runBootPrefetch defaults to chat enabled when the boot tag is absent', () => {
  const { fn, calls } = recordingFetch();
  const doc = { querySelector: () => null };
  const win = { localStorage: null, fetch: fn };
  runBootPrefetch(doc, win);
  assert.equal(calls.length, 7, 'no tag: prefetch messages too');
});

test('runBootPrefetch stashes nothing when prefetch is skipped', () => {
  const doc = { querySelector: () => null };
  const win = { localStorage: null, fetch: null };
  assert.equal(runBootPrefetch(doc, win), null);
  assert.ok(!(BOOT_GLOBAL in win));
});

test('maybeBootstrap runs the prefetch only when the boot tag is present', () => {
  const { fn, calls } = recordingFetch();
  const tag = { getAttribute: () => 'true' };
  const docWithTag = { querySelector: sel => (sel === 'script[data-pm-prefetch]' ? tag : null) };
  const win = { localStorage: null, fetch: fn };
  const boot = maybeBootstrap(docWithTag, win);
  assert.ok(boot, 'runs when the tag is present');
  assert.equal(calls.length, 7);
  assert.equal(win[BOOT_GLOBAL], boot);
});

test('maybeBootstrap is a no-op when the boot tag is absent', () => {
  const { fn, calls } = recordingFetch();
  const docNoTag = { querySelector: () => null };
  assert.equal(maybeBootstrap(docNoTag, { fetch: fn }), null);
  assert.equal(calls.length, 0);
});

test('maybeBootstrap is a no-op without a usable document (e.g. non-browser)', () => {
  assert.equal(maybeBootstrap(null, null), null);
  assert.equal(maybeBootstrap({}, null), null); // no querySelector
});

test('startBootPrefetch treats a present-but-unset store as a cold load', () => {
  const { fn, calls } = recordingFetch();
  const boot = startBootPrefetch({ storage: { getItem: () => null }, fetchFn: fn, chatEnabled: true });
  assert.ok(boot);
  assert.equal(calls.length, 7);
});

test('runBootPrefetch sources localStorage and fetch from the window', () => {
  const { fn, calls } = recordingFetch();
  const doc = { querySelector: () => null };
  const win = { localStorage: { getItem: () => null }, fetch: fn };
  runBootPrefetch(doc, win);
  assert.equal(calls.length, 7, 'present-but-empty window storage is a cold load');
});

test('runBootPrefetch defaults document and window to the globals', () => {
  const { fn, calls } = recordingFetch();
  const tag = { getAttribute: () => 'true' };
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { querySelector: sel => (sel === 'script[data-pm-prefetch]' ? tag : null) };
  globalThis.window = { localStorage: null, fetch: fn };
  try {
    const boot = runBootPrefetch(); // no args → exercises the doc=document / win=window defaults
    assert.ok(boot);
    assert.equal(calls.length, 7);
  } finally {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  }
});

test('runBootPrefetch with a tag but no window prefetches nothing and stashes nothing', () => {
  const tag = { getAttribute: () => 'true' };
  const doc = { querySelector: sel => (sel === 'script[data-pm-prefetch]' ? tag : null) };
  // win = null exercises the `win && …` short-circuits for storage and fetch.
  assert.equal(runBootPrefetch(doc, null), null);
});

test('maybeBootstrap defaults to the global document/window when called with no args', () => {
  const { fn, calls } = recordingFetch();
  const tag = { getAttribute: () => 'true' };
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { querySelector: sel => (sel === 'script[data-pm-prefetch]' ? tag : null) };
  globalThis.window = { localStorage: null, fetch: fn };
  try {
    const boot = maybeBootstrap();
    assert.ok(boot, 'uses the global document/window defaults');
    assert.equal(calls.length, 7);
  } finally {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  }
});
