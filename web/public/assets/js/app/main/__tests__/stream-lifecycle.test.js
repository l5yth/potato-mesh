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
 * SPEC ST1-ST5 unit tests for the stream lifecycle: a refused stream drops to
 * the REFRESH_MS poll and retries with backoff, an open returns to the safety
 * poll, and a tab hidden past its grace holds neither the stream nor the poll
 * until it is visible again. Timers, the document and EventSource are fakes
 * driven by the test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStreamLifecycle,
  streamRetryDelayMs,
  HIDDEN_GRACE_MS,
  STREAM_RETRY_BASE_MS,
  STREAM_RETRY_MAX_MS,
  STREAM_RETRY_JITTER,
} from '../stream-lifecycle.js';

const REFRESH_MS = 60_000;
const SAFETY_POLL_MS = 300_000;
/** The grace of {@link make}'s lifecycles: apart from every retry delay, so a test tells them apart. */
const GRACE_MS = 7000;

/**
 * Timers that run only when the test fires them.
 *
 * @returns {Object} The timer functions, the armed timers by kind and `fire`.
 */
function manualTimers() {
  const armed = new Map();
  const arm = (kind) => (fn, ms) => {
    const handle = {
      unrefed: false,
      unref() {
        this.unrefed = true;
        return this;
      },
    };
    armed.set(handle, { kind, ms, fn });
    return handle;
  };
  const clear = (handle) => {
    armed.delete(handle);
  };
  return {
    setTimeout: arm('timeout'),
    clearTimeout: clear,
    setInterval: arm('interval'),
    clearInterval: clear,
    of(kind) {
      return [...armed.entries()].filter(([, t]) => t.kind === kind).map(([handle, t]) => ({ handle, ...t }));
    },
    fire(handle) {
      const timer = armed.get(handle);
      if (timer.kind === 'timeout') armed.delete(handle);
      timer.fn();
    },
  };
}

/**
 * A document whose visibility the test sets; `visibilitychange` reaches every listener.
 *
 * @param {boolean} [hidden=false] Visibility at creation.
 * @returns {Object} Fake document.
 */
function fakeDocument(hidden = false) {
  const listeners = new Set();
  return {
    hidden,
    addEventListener(type, fn) {
      if (type === 'visibilitychange') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'visibilitychange') listeners.delete(fn);
    },
    listenerCount: () => listeners.size,
    setHidden(value) {
      this.hidden = value;
      [...listeners].forEach((fn) => fn({ type: 'visibilitychange' }));
    },
  };
}

/**
 * A fake `EventSource` class with `readyState`, recording its instances.
 *
 * @param {{ throwOn?: number[] }} [options] Constructions (1-based) that throw.
 * @returns {Function} The class, with `instances`.
 */
function fakeEventSourceClass({ throwOn = [] } = {}) {
  let constructed = 0;
  class FakeEventSource {
    constructor(url) {
      constructed += 1;
      if (throwOn.includes(constructed)) throw new Error('blocked');
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      this.listeners = {};
      FakeEventSource.instances.push(this);
    }

    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }

    close() {
      this.closed = true;
      this.readyState = 2;
    }

    dispatch(type, event = {}) {
      (this.listeners[type] || []).forEach((fn) => fn(event));
    }

    /** The server answered 200 with an event stream. */
    open() {
      this.readyState = 1;
      this.dispatch('open');
    }

    /** A non-200 answer (the 503 at the cap, a proxy's 502): the browser gives up. */
    refuse() {
      this.readyState = 2;
      this.dispatch('error');
    }

    /** A dropped connection: the browser reconnects on its own. */
    drop() {
      this.readyState = 0;
      this.dispatch('error');
    }
  }
  FakeEventSource.instances = [];
  return FakeEventSource;
}

/**
 * Build one lifecycle over fakes, recording every callback.
 *
 * @param {{ hidden?: boolean, factory?: Object, options?: Object }} [overrides]
 * @returns {Object} The lifecycle, its fakes and the recorded calls.
 */
function make({ hidden = false, factory = {}, options = {} } = {}) {
  const timers = manualTimers();
  const doc = fakeDocument(hidden);
  const FakeEventSource = fakeEventSourceClass(factory);
  const calls = { poll: 0, resync: 0, modes: [], stops: 0, changes: [], errors: [] };
  let lifecycle = null;
  lifecycle = createStreamLifecycle({
    enabled: true,
    path: '/api/events',
    refreshMs: REFRESH_MS,
    safetyPollMs: SAFETY_POLL_MS,
    poll: () => {
      calls.poll += 1;
    },
    onChange: (collection) => calls.changes.push(collection),
    onResync: () => {
      calls.resync += 1;
    },
    onError: (message) => calls.errors.push(message),
    onModeChange: () => calls.modes.push(lifecycle.mode()),
    onStop: () => {
      calls.stops += 1;
    },
    documentRef: doc,
    eventSourceFactory: FakeEventSource,
    timers,
    random: () => 0.5,
    graceMs: GRACE_MS,
    ...options,
  });
  return {
    lifecycle,
    timers,
    doc,
    FakeEventSource,
    calls,
    es: (i) => FakeEventSource.instances[i],
    polls: () => timers.of('interval'),
    retries: () => timers.of('timeout').filter((t) => t.ms !== GRACE_MS),
    graces: () => timers.of('timeout').filter((t) => t.ms === GRACE_MS),
  };
}

// ---------------------------------------------------------------------------
// Backoff (ST3)
// ---------------------------------------------------------------------------

test('the retry step is 5 s after the first refusal, doubling to 60 s; the delay is drawn from 0.8-1.2 of it within 5-60 s (ST3)', () => {
  assert.equal(STREAM_RETRY_BASE_MS, 5000);
  assert.equal(STREAM_RETRY_MAX_MS, 60_000);
  assert.deepEqual([...STREAM_RETRY_JITTER], [0.8, 1.2]);
  const mid = () => 0.5;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 40].map((n) => streamRetryDelayMs(n, mid)), [5500, 10_000, 20_000, 40_000, 54_000, 54_000, 54_000]);
  assert.equal(streamRetryDelayMs(1, () => 0), 5000, 'never below 5 s');
  assert.equal(streamRetryDelayMs(1, () => 0.999), 5999);
  assert.equal(streamRetryDelayMs(4, () => 0), 32_000);
  assert.equal(streamRetryDelayMs(4, () => 0.999), 47_984);
  assert.equal(streamRetryDelayMs(5, () => 0), 48_000);
  assert.equal(streamRetryDelayMs(5, () => 0.999), 59_988, 'never above 60 s');
  assert.equal(streamRetryDelayMs(0, mid), 5500, 'a count below one waits the first step');
});

test('the jitter is drawn after the clamp: first and capped delays vary, none piled on a bound (ST3)', () => {
  const draws = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.999];
  const first = draws.map((r) => streamRetryDelayMs(1, () => r));
  const capped = draws.map((r) => streamRetryDelayMs(5, () => r));
  assert.equal(new Set(first).size, draws.length, `first delays vary: ${first}`);
  assert.equal(new Set(capped).size, draws.length, `capped delays vary: ${capped}`);
  assert.ok(first.every((ms) => ms >= STREAM_RETRY_BASE_MS && ms <= 6000), `first within 5-6 s: ${first}`);
  assert.ok(capped.every((ms) => ms >= 48_000 && ms <= STREAM_RETRY_MAX_MS), `capped within 48-60 s: ${capped}`);
  assert.equal(capped.filter((ms) => ms === STREAM_RETRY_MAX_MS).length, 0, 'no capped delay sits on the 60 s bound');
  assert.equal(first.filter((ms) => ms === STREAM_RETRY_BASE_MS).length, 1, 'only the bottom draw sits on the 5 s bound');
});

test('the default jitter reads Math.random when the retry is armed', () => {
  const original = Math.random;
  Math.random = () => 0.75;
  try {
    assert.equal(streamRetryDelayMs(1), 5750);
  } finally {
    Math.random = original;
  }
});

test('the hidden-tab grace is 5 s (ST5)', () => {
  assert.equal(HIDDEN_GRACE_MS, 5000);
});

// ---------------------------------------------------------------------------
// Streaming and polling (ST1, ST2)
// ---------------------------------------------------------------------------

test('start opens the stream and arms the safety poll; the page streams (ST2)', () => {
  const { lifecycle, FakeEventSource, polls, calls } = make();
  assert.equal(lifecycle.mode(), 'live');
  assert.equal(lifecycle.isStreaming(), false, 'nothing streams before start');
  lifecycle.start();
  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(FakeEventSource.instances[0].url, '/api/events');
  assert.equal(lifecycle.isStreaming(), true);
  assert.equal(lifecycle.intervalMs(), SAFETY_POLL_MS);
  assert.deepEqual(polls().map((t) => t.ms), [SAFETY_POLL_MS]);
  assert.deepEqual(calls.modes, [], 'the mode did not change');
});

test('each poll tick runs the poll', () => {
  const { lifecycle, timers, polls, calls } = make();
  lifecycle.start();
  timers.fire(polls()[0].handle);
  timers.fire(polls()[0].handle);
  assert.equal(calls.poll, 2);
});

test('pings and opens reach the caller; an open resyncs', () => {
  const { lifecycle, es, calls } = make();
  lifecycle.start();
  es(0).dispatch('change', { data: JSON.stringify({ collection: 'messages' }) });
  es(0).open();
  es(0).open();
  assert.deepEqual(calls.changes, ['messages']);
  assert.equal(calls.resync, 2);
});

test('a refused stream drops to the REFRESH_MS poll, stops streaming and arms one retry (ST1-ST3)', () => {
  const { lifecycle, es, polls, retries, calls } = make();
  lifecycle.start();
  es(0).refuse();
  assert.equal(lifecycle.isStreaming(), false);
  assert.equal(lifecycle.mode(), 'polling');
  assert.deepEqual(calls.modes, ['polling']);
  assert.equal(lifecycle.intervalMs(), REFRESH_MS);
  assert.deepEqual(polls().map((t) => t.ms), [REFRESH_MS], 'the safety poll was replaced');
  assert.deepEqual(retries().map((t) => t.ms), [5500]);
  assert.equal(retries()[0].handle.unrefed, true, 'the retry never keeps a Node process alive');
  assert.equal(lifecycle.failures(), 1);
  assert.equal(calls.poll, 0, 'a refusal alone runs no refresh');
});

test('a dropped connection the browser retries keeps the stream and the safety poll (ST1)', () => {
  const { lifecycle, es, polls, retries, calls } = make();
  lifecycle.start();
  es(0).open();
  es(0).drop();
  assert.equal(lifecycle.isStreaming(), true);
  assert.equal(lifecycle.mode(), 'live');
  assert.deepEqual(polls().map((t) => t.ms), [SAFETY_POLL_MS]);
  assert.equal(retries().length, 0);
  assert.deepEqual(calls.modes, []);
});

test('the retry opens a new stream, which stays polling until it opens; the open restores the safety poll (ST2, ST3)', () => {
  const { lifecycle, timers, es, FakeEventSource, polls, retries, calls } = make();
  lifecycle.start();
  es(0).refuse();
  timers.fire(retries()[0].handle);
  assert.equal(FakeEventSource.instances.length, 2, 'the retry opened a second stream');
  assert.equal(lifecycle.mode(), 'polling', 'a retry reads polling until it opens');
  assert.equal(lifecycle.isStreaming(), false);
  assert.deepEqual(polls().map((t) => t.ms), [REFRESH_MS]);
  es(1).open();
  assert.equal(lifecycle.mode(), 'live');
  assert.equal(lifecycle.isStreaming(), true);
  assert.deepEqual(calls.modes, ['polling', 'live']);
  assert.deepEqual(polls().map((t) => t.ms), [SAFETY_POLL_MS]);
  assert.equal(lifecycle.intervalMs(), SAFETY_POLL_MS);
  assert.equal(calls.resync, 1, 'the open resyncs once');
  assert.equal(lifecycle.failures(), 0, 'an open resets the backoff');
});

test('a retry refused again doubles the step (ST3)', () => {
  const { lifecycle, timers, es, retries } = make();
  lifecycle.start();
  es(0).refuse();
  timers.fire(retries()[0].handle);
  es(1).refuse();
  assert.deepEqual(retries().map((t) => t.ms), [2 * STREAM_RETRY_BASE_MS]);
  timers.fire(retries()[0].handle);
  es(2).refuse();
  assert.deepEqual(retries().map((t) => t.ms), [4 * STREAM_RETRY_BASE_MS]);
  assert.equal(lifecycle.failures(), 3);
});

test('a retry refused again keeps the REFRESH_MS poll in its phase, so it still fires between retries (ST2)', () => {
  const { lifecycle, timers, es, polls, retries, calls } = make();
  lifecycle.start();
  es(0).refuse();
  const poll = polls()[0].handle;
  for (let n = 1; n <= 6; n += 1) {
    timers.fire(retries()[0].handle);
    es(n).refuse();
  }
  assert.equal(polls().length, 1);
  assert.equal(polls()[0].handle, poll, 'the refusals did not restart the poll');
  timers.fire(poll);
  assert.equal(calls.poll, 1);
});

test('a retry whose stream cannot be built counts as a refusal and waits for the next step (ST3)', () => {
  const { lifecycle, timers, es, FakeEventSource, retries, calls } = make({ factory: { throwOn: [2] } });
  lifecycle.start();
  es(0).refuse();
  timers.fire(retries()[0].handle);
  assert.equal(FakeEventSource.instances.length, 1, 'the second construction threw');
  assert.ok(calls.errors.some((message) => message.includes('failed to open')));
  assert.deepEqual(retries().map((t) => t.ms), [2 * STREAM_RETRY_BASE_MS]);
  timers.fire(retries()[0].handle);
  assert.equal(FakeEventSource.instances.length, 2);
  es(1).open();
  assert.equal(lifecycle.mode(), 'live');
});

test('a second start reuses the stream and re-arms one poll', () => {
  const { lifecycle, FakeEventSource, polls } = make();
  lifecycle.start();
  const first = polls()[0].handle;
  lifecycle.start();
  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(polls().length, 1);
  assert.notEqual(polls()[0].handle, first, 'the poll was re-armed');
});

test('a start while a retry waits opens no second attempt', () => {
  const { lifecycle, es, FakeEventSource, retries, polls } = make();
  lifecycle.start();
  es(0).refuse();
  lifecycle.start();
  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(retries().length, 1);
  assert.deepEqual(polls().map((t) => t.ms), [REFRESH_MS]);
});

test('stop closes the stream and clears the poll and the retry; the mode is kept (ST3)', () => {
  const { lifecycle, es, polls, retries, calls } = make();
  lifecycle.start();
  es(0).refuse();
  lifecycle.stop();
  assert.equal(polls().length, 0);
  assert.equal(retries().length, 0);
  assert.equal(lifecycle.intervalMs(), 0);
  assert.equal(lifecycle.isStreaming(), false);
  assert.equal(lifecycle.mode(), 'polling', 'the label keeps the last known state');
  assert.equal(calls.stops, 1);
  lifecycle.start();
  assert.equal(es(1).url, '/api/events', 'a start after a stop tries the stream at once');
  assert.equal(lifecycle.mode(), 'polling', 'and reads polling until it opens');
  es(1).open();
  assert.equal(lifecycle.mode(), 'live');
});

test('stop closes an open stream', () => {
  const { lifecycle, es } = make();
  lifecycle.start();
  lifecycle.stop();
  assert.equal(es(0).closed, true);
  assert.equal(lifecycle.isStreaming(), false);
});

test('without EventSource the page polls at REFRESH_MS and reads polling (ST2, ST4)', () => {
  const original = globalThis.EventSource;
  delete globalThis.EventSource;
  try {
    const { lifecycle, polls, retries, calls } = make({ options: { eventSourceFactory: undefined } });
    lifecycle.start();
    assert.equal(lifecycle.mode(), 'polling');
    assert.deepEqual(calls.modes, ['polling']);
    assert.equal(lifecycle.isStreaming(), false);
    assert.deepEqual(polls().map((t) => t.ms), [REFRESH_MS]);
    assert.equal(retries().length, 0, 'nothing to retry');
    lifecycle.start();
    assert.deepEqual(calls.modes, ['polling'], 'a second start reports no second change');
  } finally {
    if (original !== undefined) globalThis.EventSource = original;
  }
});

test('live updates disabled: polling from the start, no stream, no mode change (ST4)', () => {
  const { lifecycle, FakeEventSource, polls, calls } = make({ options: { enabled: false } });
  assert.equal(lifecycle.mode(), 'polling');
  lifecycle.start();
  assert.equal(FakeEventSource.instances.length, 0);
  assert.deepEqual(polls().map((t) => t.ms), [REFRESH_MS]);
  assert.deepEqual(calls.modes, []);
});

test('a zero cadence arms no poll', () => {
  const { lifecycle, polls } = make({ options: { refreshMs: 0, safetyPollMs: 0 } });
  lifecycle.start();
  assert.equal(polls().length, 0);
  assert.equal(lifecycle.intervalMs(), 0);
});

test('missing callbacks and options are tolerated', () => {
  const timers = manualTimers();
  const FakeEventSource = fakeEventSourceClass();
  const lifecycle = createStreamLifecycle({
    enabled: true,
    path: '/api/events',
    refreshMs: REFRESH_MS,
    safetyPollMs: SAFETY_POLL_MS,
    eventSourceFactory: FakeEventSource,
    timers,
    documentRef: null,
  });
  lifecycle.start();
  assert.equal(timers.of('interval').length, 1);
  timers.of('interval').forEach((t) => timers.fire(t.handle));
  FakeEventSource.instances[0].refuse();
  timers.of('timeout').forEach((t) => timers.fire(t.handle));
  FakeEventSource.instances[1].open();
  lifecycle.stop();
  lifecycle.dispose();
  assert.equal(lifecycle.intervalMs(), 0);
  assert.deepEqual(createStreamLifecycle().mode(), 'polling', 'no options: no stream');
});

// ---------------------------------------------------------------------------
// Hidden-tab gate (ST5)
// ---------------------------------------------------------------------------

test('a tab hidden for less than the grace keeps its stream and its poll (ST5)', () => {
  const { lifecycle, doc, es, graces, polls, calls } = make();
  lifecycle.start();
  doc.setHidden(true);
  assert.deepEqual(graces().map((t) => t.ms), [GRACE_MS]);
  assert.equal(graces()[0].handle.unrefed, true);
  doc.setHidden(true); // a second hidden event arms no second grace
  assert.equal(graces().length, 1);
  doc.setHidden(false);
  assert.equal(graces().length, 0, 'the grace was cleared');
  assert.equal(es(0).closed, false);
  assert.deepEqual(polls().map((t) => t.ms), [SAFETY_POLL_MS]);
  assert.equal(calls.resync, 0);
  assert.equal(calls.poll, 0);
});

test('a tab hidden past the grace closes its stream and stops its poll (ST5)', () => {
  const { lifecycle, timers, doc, es, graces, polls, calls } = make();
  lifecycle.start();
  doc.setHidden(true);
  timers.fire(graces()[0].handle);
  assert.equal(es(0).closed, true, 'the hidden tab holds no SSE slot');
  assert.equal(polls().length, 0);
  assert.equal(lifecycle.intervalMs(), 0);
  assert.equal(lifecycle.isStreaming(), false);
  assert.equal(lifecycle.isSuspended(), true);
  assert.equal(lifecycle.mode(), 'live', 'the label keeps its state while hidden');
  assert.equal(calls.stops, 1);
});

test('visible again, the tab reopens the stream and the poll and resyncs once when it opens (ST5)', () => {
  const { lifecycle, timers, doc, es, FakeEventSource, graces, polls, calls } = make();
  lifecycle.start();
  doc.setHidden(true);
  timers.fire(graces()[0].handle);
  doc.setHidden(false);
  assert.equal(lifecycle.isSuspended(), false);
  assert.equal(FakeEventSource.instances.length, 2, 'a new stream');
  assert.deepEqual(polls().map((t) => t.ms), [SAFETY_POLL_MS]);
  assert.equal(calls.resync, 0, 'the resync waits for the open');
  es(1).open();
  assert.equal(calls.resync, 1);
  assert.equal(calls.poll, 0, 'one resync, not two');
  assert.equal(lifecycle.isStreaming(), true);
});

test('visible again with the stream refused before it opens, the poll runs once at once as the resync (ST5)', () => {
  const { lifecycle, timers, doc, es, graces, polls, retries, calls } = make();
  lifecycle.start();
  doc.setHidden(true);
  timers.fire(graces()[0].handle);
  doc.setHidden(false);
  es(1).refuse();
  assert.equal(calls.poll, 1, 'the resync of the visible tab');
  assert.deepEqual(polls().map((t) => t.ms), [REFRESH_MS]);
  assert.equal(retries().length, 1);
  timers.fire(retries()[0].handle);
  es(2).refuse();
  assert.equal(calls.poll, 1, 'a later refusal runs no refresh');
  timers.fire(retries()[0].handle);
  es(3).open();
  assert.equal(calls.resync, 1);
});

test('a stream refused before the tab hid retries at once when it is visible again (ST3, ST5)', () => {
  const { lifecycle, timers, doc, es, FakeEventSource, graces, retries } = make();
  lifecycle.start();
  es(0).refuse();
  doc.setHidden(true);
  timers.fire(graces()[0].handle);
  assert.equal(retries().length, 0, 'the hidden tab cancelled the retry');
  doc.setHidden(false);
  assert.equal(FakeEventSource.instances.length, 2);
  assert.equal(lifecycle.mode(), 'polling');
  es(1).open();
  assert.equal(lifecycle.mode(), 'live');
});

test('visible again without a stream, the poll runs once at once and is re-armed (ST5)', () => {
  const { lifecycle, timers, doc, graces, polls, calls } = make({ options: { enabled: false } });
  lifecycle.start();
  doc.setHidden(true);
  timers.fire(graces()[0].handle);
  assert.equal(polls().length, 0);
  doc.setHidden(false);
  assert.equal(calls.poll, 1);
  assert.deepEqual(polls().map((t) => t.ms), [REFRESH_MS]);
});

test('a stopped (paused) tab hidden past the grace reopens nothing when visible (ST5)', () => {
  const { lifecycle, timers, doc, FakeEventSource, graces, polls, calls } = make();
  lifecycle.start();
  lifecycle.stop();
  doc.setHidden(true);
  timers.fire(graces()[0].handle);
  assert.equal(calls.stops, 1, 'nothing more to stop');
  doc.setHidden(false);
  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(polls().length, 0);
  assert.equal(calls.poll, 0);
});

test('a start while hidden past the grace opens nothing until the tab is visible (ST5)', () => {
  const { lifecycle, timers, doc, es, FakeEventSource, graces, polls, calls } = make({ hidden: true });
  assert.deepEqual(graces().map((t) => t.ms), [GRACE_MS], 'a tab hidden at creation arms its grace');
  timers.fire(graces()[0].handle);
  lifecycle.start();
  assert.equal(FakeEventSource.instances.length, 0);
  assert.equal(polls().length, 0);
  doc.setHidden(false);
  assert.equal(FakeEventSource.instances.length, 1);
  es(0).open();
  assert.equal(calls.resync, 1);
  assert.equal(calls.stops, 0, 'nothing ran to stop');
});

test('dispose stops, clears the grace and removes the listener', () => {
  const { lifecycle, doc, es, graces } = make();
  lifecycle.start();
  doc.setHidden(true);
  lifecycle.dispose();
  assert.equal(es(0).closed, true);
  assert.equal(graces().length, 0);
  assert.equal(doc.listenerCount(), 0);
  lifecycle.dispose();
});

test('a start after dispose opens the stream, also in a tab disposed while suspended', () => {
  const { lifecycle, timers, doc, FakeEventSource, graces } = make();
  lifecycle.start();
  doc.setHidden(true);
  timers.fire(graces()[0].handle);
  lifecycle.dispose();
  lifecycle.start();
  assert.equal(FakeEventSource.instances.length, 2, 'the gate is off after dispose');
  assert.equal(lifecycle.isStreaming(), true);
});

test('numeric timer handles without unref (browsers) are accepted', () => {
  let next = 0;
  const handles = [];
  const timers = {
    setTimeout: () => {
      next += 1;
      handles.push(next);
      return next;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  const doc = fakeDocument(true);
  const FakeEventSource = fakeEventSourceClass();
  const lifecycle = createStreamLifecycle({ enabled: true, path: '/e', eventSourceFactory: FakeEventSource, timers, documentRef: doc });
  lifecycle.start();
  FakeEventSource.instances[0].refuse();
  assert.equal(handles.length, 2, 'the grace and the retry were armed');
});

test('the ambient timers are used by default', () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const seen = [];
  globalThis.setTimeout = (fn, ms) => {
    seen.push(['timeout', ms]);
    return { unref() {} };
  };
  globalThis.clearTimeout = () => seen.push(['clearTimeout']);
  globalThis.setInterval = (fn, ms) => {
    seen.push(['interval', ms]);
    return 7;
  };
  globalThis.clearInterval = () => seen.push(['clearInterval']);
  try {
    const FakeEventSource = fakeEventSourceClass();
    const lifecycle = createStreamLifecycle({
      enabled: true,
      path: '/e',
      refreshMs: REFRESH_MS,
      safetyPollMs: SAFETY_POLL_MS,
      eventSourceFactory: FakeEventSource,
      documentRef: fakeDocument(true),
    });
    lifecycle.start();
    lifecycle.stop();
    lifecycle.dispose();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
  assert.deepEqual(seen, [['timeout', HIDDEN_GRACE_MS], ['interval', SAFETY_POLL_MS], ['clearInterval'], ['clearTimeout']]);
});

test('the global document is the default visibility source', () => {
  const original = globalThis.document;
  const doc = fakeDocument(false);
  globalThis.document = doc;
  try {
    const lifecycle = createStreamLifecycle({ enabled: false, timers: manualTimers() });
    assert.equal(doc.listenerCount(), 1);
    lifecycle.dispose();
    assert.equal(doc.listenerCount(), 0);
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});
