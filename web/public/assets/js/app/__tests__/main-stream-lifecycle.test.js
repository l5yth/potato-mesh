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
 * SPEC ST1-ST5 on the dashboard: drives `initializeApp` over a fake
 * `EventSource`, a stub `fetch`, a `#autorefreshToggle` and a document whose
 * visibility the test sets. A stream the server refuses (the 503 at the SSE
 * cap, a proxy's 502 while the app restarts) leaves the page polling at
 * REFRESH_MS with the toggle reading polling, and is retried with backoff; a
 * dashboard hidden past its grace closes its stream and stops its poll until
 * it is visible again, then resyncs once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { buildStubFetch, makeFakeEventSource, SSE_BASE_CONFIG, DEFAULT_RESPONSES } from './sse-app-harness.js';
import { settle } from './page-open-harness.js';
import { START_TIMEOUT_MS } from '../main/page-open-sequencer.js';
import { initializeApp } from '../main.js';

/** `EventSource.CLOSED`: a refused connection the browser will not retry. */
const CLOSED = 2;
/** `EventSource.CONNECTING`: a dropped connection the browser retries. */
const CONNECTING = 0;
/** Accessible names of the toggle states (SPEC CT4, ST4). */
const LIVE = 'live, pause auto-refresh';
const POLLING = 'polling, pause auto-refresh';

/**
 * Give the mock document one listener list per event type and a `hidden`
 * flag the test sets, so the ticker's and the stream's `visibilitychange`
 * listeners both run, as in a browser.
 *
 * @param {Object} document The mock document of `createDomEnvironment`.
 * @returns {(hidden: boolean) => void} Sets the visibility and dispatches the event.
 */
function visibleDocument(document) {
  const listeners = new Map();
  document.hidden = false;
  document.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  };
  document.removeEventListener = (type, fn) => {
    if (listeners.has(type)) listeners.get(type).delete(fn);
  };
  document.dispatchEvent = (event) => {
    const type = typeof event === 'string' ? event : event.type;
    for (const fn of [...(listeners.get(type) || [])]) fn(event);
  };
  return (hidden) => {
    document.hidden = hidden;
    document.dispatchEvent({ type: 'visibilitychange' });
  };
}

/**
 * Hold every `setTimeout` of 4 s or more but the page-open start bound (SPEC
 * OR5), so the test fires the stream's retries and the hidden-tab grace.
 *
 * @returns {{ pending: () => Array<Object>, fire: (timer: Object) => void, restore: () => void }}
 */
function holdLongTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const held = [];
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (!(ms >= 4000) || ms === START_TIMEOUT_MS) return realSet(fn, ms, ...args);
    const timer = {
      fn,
      ms,
      cleared: false,
      fired: false,
      unref() {
        return this;
      },
    };
    held.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (handle) => {
    if (held.includes(handle)) handle.cleared = true;
    else realClear(handle);
  };
  return {
    pending: () => held.filter((t) => !t.cleared && !t.fired),
    fire(timer) {
      timer.fired = true;
      timer.fn();
    },
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

/**
 * Boot one dashboard with the toggle, held long timers and a settable
 * visibility, and await its initial load (SPEC OR1).
 *
 * @param {{ withEventSource?: boolean, configOverrides?: Object }} [options]
 * @returns {Promise<Object>} The test utils, fetch calls, streams, toggle, timers and teardown.
 */
async function bootDashboard({ withEventSource = true, configOverrides = {} } = {}) {
  const env = createDomEnvironment({ includeBody: true });
  const setHidden = visibleDocument(env.document);
  env.registerElement('chat', env.createElement('div', 'chat'));
  const toggle = env.createElement('button', 'autorefreshToggle');
  toggle.ownerDocument = env.document; // the control state builds its action span here
  const clicks = [];
  toggle.addEventListener = (type, fn) => {
    if (type === 'click') clicks.push(fn);
  };
  env.registerElement('autorefreshToggle', toggle);
  const timers = holdLongTimers();
  const saved = { fetch: globalThis.fetch, es: globalThis.EventSource, idb: globalThis.indexedDB, random: Math.random };
  Math.random = () => 0.75; // the retry's jitter factor reads 1.1
  const stub = buildStubFetch({ ...DEFAULT_RESPONSES });
  globalThis.fetch = stub.fetch;
  globalThis.indexedDB = undefined; // no persistent cache: a clean cold path
  const FakeEventSource = makeFakeEventSource();
  if (withEventSource) globalThis.EventSource = FakeEventSource;
  else delete globalThis.EventSource;
  const { _testUtils: u } = initializeApp({ ...SSE_BASE_CONFIG, ...configOverrides });
  const initialLabel = toggle.getAttribute('aria-label');
  await u.initialLoad;
  await u.flushBackfill();
  await settle();
  return {
    u,
    calls: stub.calls,
    FakeEventSource,
    timers,
    toggle,
    initialLabel,
    setHidden,
    es: (i) => FakeEventSource.instances[i],
    label: () => toggle.getAttribute('aria-label'),
    click: () => clicks.forEach((fn) => fn({ type: 'click' })),
    /** GETs of `/api/nodes` issued since `from` (one per refresh). */
    nodeGets: (from) => stub.calls.slice(from).filter((c) => /^\/api\/nodes\?/.test(c.url)),
    async teardown() {
      await u.flushCacheWrites();
      await settle(3);
      u.stopAutoRefresh();
      timers.restore();
      Math.random = saved.random;
      globalThis.fetch = saved.fetch;
      if (saved.es === undefined) delete globalThis.EventSource;
      else globalThis.EventSource = saved.es;
      globalThis.indexedDB = saved.idb;
      env.cleanup();
    },
  };
}

/**
 * Answer one stream's connection: `CLOSED` as a refusal, `CONNECTING` as a drop.
 *
 * @param {Object} source A fake EventSource.
 * @param {number} readyState The state the error leaves it in.
 * @returns {void}
 */
function fail(source, readyState) {
  source.readyState = readyState;
  source.dispatch('error', {});
}

test('M15 cap: a refused stream polls at REFRESH_MS, reads polling and is retried; the open streams again (ST1-ST4)', async () => {
  const d = await bootDashboard();
  try {
    assert.equal(d.label(), LIVE);
    fail(d.es(0), CLOSED); // the 503 at the subscriber cap
    assert.equal(d.u.isLiveActive(), false, 'a refused stream is not live');
    assert.equal(d.u.getAutoRefreshIntervalMs(), 60_000, 'the page polls at REFRESH_MS');
    assert.equal(d.label(), POLLING);
    assert.equal(d.toggle.childNodes[0], '↻ polling');
    assert.equal(d.timers.pending().length, 1, 'one retry is armed');
    const before = d.calls.length;
    d.timers.fire(d.timers.pending()[0]);
    assert.equal(d.FakeEventSource.instances.length, 2, 'the retry opened a new stream');
    assert.equal(d.label(), POLLING, 'the retry reads polling until it opens');
    d.es(1).dispatch('open', {});
    await settle();
    assert.equal(d.u.isLiveActive(), true);
    assert.equal(d.u.getAutoRefreshIntervalMs(), 300_000, 'the safety poll is back');
    assert.equal(d.label(), LIVE);
    const resync = d.nodeGets(before);
    assert.equal(resync.length, 1, 'the open resyncs once');
    assert.ok(resync[0].url.includes('since='), `the resync is a delta: ${resync[0].url}`);
  } finally {
    await d.teardown();
  }
});

test('M15 restart: a dropped stream stays live; refused on reconnect it polls, backs off further, and streams once it opens (ST1, ST3)', async () => {
  const d = await bootDashboard();
  try {
    d.es(0).dispatch('open', {});
    await settle();
    fail(d.es(0), CONNECTING); // the app went away; the browser reconnects
    assert.equal(d.u.isLiveActive(), true);
    assert.equal(d.label(), LIVE);
    assert.equal(d.timers.pending().length, 0, 'the browser retries a drop itself');
    fail(d.es(0), CLOSED); // its reconnect got a 502 from the proxy
    assert.equal(d.u.isLiveActive(), false);
    assert.equal(d.label(), POLLING);
    const [first] = d.timers.pending();
    d.timers.fire(first);
    fail(d.es(1), CLOSED); // still restarting
    const [second] = d.timers.pending();
    assert.ok(second.ms > first.ms, `the second retry waits longer: ${first.ms}, ${second.ms}`);
    d.timers.fire(second);
    d.es(2).dispatch('open', {});
    await settle();
    assert.equal(d.u.isLiveActive(), true);
    assert.equal(d.label(), LIVE);
    const before = d.calls.length;
    d.es(2).dispatch('change', { data: JSON.stringify({ collection: 'messages' }) });
    await d.u.flushLiveRefresh();
    assert.ok(
      d.calls.slice(before).some((c) => c.url.startsWith('/api/messages?') && c.url.includes('since=')),
      'pings reach the page again',
    );
  } finally {
    await d.teardown();
  }
});

test('a pause while polling cancels the retry and the poll; a resume tries the stream at once (ST3, UX6)', async () => {
  const d = await bootDashboard();
  try {
    fail(d.es(0), CLOSED);
    d.click(); // pause
    assert.ok(d.label().startsWith('paused'), d.label());
    assert.equal(d.timers.pending().length, 0, 'no retry while paused');
    assert.equal(d.u.getAutoRefreshIntervalMs(), 0, 'no poll while paused');
    d.click(); // resume
    assert.equal(d.FakeEventSource.instances.length, 2, 'the resume tried the stream at once');
    assert.equal(d.label(), POLLING, 'polling until the stream opens');
    assert.equal(d.u.getAutoRefreshIntervalMs(), 60_000);
    d.es(1).dispatch('open', {});
    await settle();
    assert.equal(d.label(), LIVE);
  } finally {
    await d.teardown();
  }
});

test('M16: a dashboard hidden past the grace closes its stream and stops its poll; visible again it reopens them and resyncs once (ST5)', async () => {
  const d = await bootDashboard();
  try {
    d.es(0).dispatch('open', {});
    await settle();
    d.setHidden(true);
    assert.equal(d.timers.pending().length, 1, 'the grace is armed');
    assert.equal(d.es(0).closed, undefined, 'the stream is kept during the grace');
    d.timers.fire(d.timers.pending()[0]);
    assert.equal(d.es(0).closed, true, 'a hidden tab holds no SSE slot');
    assert.equal(d.u.isLiveActive(), false);
    assert.equal(d.u.getAutoRefreshIntervalMs(), 0, 'no poll while hidden');
    const before = d.calls.length;
    d.setHidden(false);
    assert.equal(d.FakeEventSource.instances.length, 2, 'visible again, the stream reopens');
    assert.equal(d.u.getAutoRefreshIntervalMs(), 300_000);
    assert.equal(d.nodeGets(before).length, 0, 'the resync waits for the open');
    d.es(1).dispatch('open', {});
    await settle();
    const resync = d.nodeGets(before);
    assert.equal(resync.length, 1, 'one resync');
    assert.ok(resync[0].url.includes('since='), `the resync is a delta: ${resync[0].url}`);
    assert.equal(d.u.isLiveActive(), true);
    assert.equal(d.label(), LIVE);
  } finally {
    await d.teardown();
  }
});

test('a ping still waiting for its debounce when the grace ends runs no refresh (ST5)', async () => {
  const d = await bootDashboard();
  try {
    d.es(0).dispatch('open', {});
    await settle();
    d.setHidden(true);
    const before = d.calls.length;
    d.es(0).dispatch('change', { data: JSON.stringify({ collection: 'messages' }) });
    assert.equal(d.timers.pending().length, 1, 'the grace is armed');
    d.timers.fire(d.timers.pending()[0]); // the grace ends inside the 250 ms debounce
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    assert.equal(d.calls.length, before, `no fetch once the tab is suspended: ${d.calls.slice(before).map((c) => c.url)}`);
  } finally {
    await d.teardown();
  }
});

test('a dashboard hidden for less than the grace keeps its stream and its poll (ST5)', async () => {
  const d = await bootDashboard();
  try {
    d.setHidden(true);
    d.setHidden(false);
    assert.equal(d.timers.pending().length, 0, 'the grace was cleared');
    assert.equal(d.FakeEventSource.instances.length, 1);
    assert.equal(d.es(0).closed, undefined);
    assert.equal(d.u.isLiveActive(), true);
    assert.equal(d.u.getAutoRefreshIntervalMs(), 300_000);
  } finally {
    await d.teardown();
  }
});

test('without EventSource the dashboard reads polling; hidden past the grace it stops, visible it refreshes once (ST4, ST5)', async () => {
  const d = await bootDashboard({ withEventSource: false });
  try {
    assert.equal(d.label(), POLLING);
    assert.equal(d.u.isLiveActive(), false);
    assert.equal(d.u.getAutoRefreshIntervalMs(), 60_000);
    d.setHidden(true);
    d.timers.fire(d.timers.pending()[0]);
    assert.equal(d.u.getAutoRefreshIntervalMs(), 0, 'no poll while hidden');
    const before = d.calls.length;
    d.setHidden(false);
    await settle();
    const resync = d.nodeGets(before);
    assert.equal(resync.length, 1, 'one refresh at once');
    assert.ok(resync[0].url.includes('since='), `the refresh is a delta: ${resync[0].url}`);
    assert.equal(d.u.getAutoRefreshIntervalMs(), 60_000);
  } finally {
    await d.teardown();
  }
});

test('live updates disabled by config read polling from the first apply (ST4)', async () => {
  const d = await bootDashboard({ configOverrides: { liveUpdatesEnabled: false } });
  try {
    assert.equal(d.initialLabel, POLLING);
    assert.equal(d.label(), POLLING);
    assert.equal(d.FakeEventSource.instances.length, 0);
  } finally {
    await d.teardown();
  }
});
