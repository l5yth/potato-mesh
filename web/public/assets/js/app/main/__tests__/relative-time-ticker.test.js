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
  TICK_TIMESTAMP_ATTRIBUTE,
  TICK_FORMAT_ATTRIBUTE,
  TICK_FORMAT_AGO,
  TICK_FORMAT_AGO_SUFFIXED,
  TICK_FORMAT_RELATIVE,
  TICK_INTERVAL_MS,
  TICK_SELECTOR,
  formatTickingAge,
  tickAttributes,
  updateTickingElements,
  startRelativeTimeTicker,
} from '../relative-time-ticker.js';
import { timeAgo, timeAgoSuffixed } from '../format-utils.js';
import { formatRelativeSeconds } from '../../node-page-charts/display-formatters.js';

/**
 * Build a fake tickable field: tracked `textContent` writes plus attributes.
 *
 * @param {*} ts Timestamp attribute value (omitted when null).
 * @param {{format?: string, text?: string}} [options] Variant + initial text.
 * @returns {Object} Fake element.
 */
function fakeField(ts, { format, text = '' } = {}) {
  const attrs = new Map();
  if (ts != null) attrs.set(TICK_TIMESTAMP_ATTRIBUTE, String(ts));
  if (format) attrs.set(TICK_FORMAT_ATTRIBUTE, format);
  let current = text;
  const el = { writes: 0, connected: true, attrs };
  Object.defineProperty(el, 'textContent', {
    get: () => current,
    set: (value) => {
      current = value;
      el.writes += 1;
    },
  });
  el.getAttribute = (name) => (attrs.has(name) ? attrs.get(name) : null);
  return el;
}

/**
 * Build a fake document: `querySelectorAll` faithfully matches only connected
 * elements that carry the timestamp attribute, and visibility listeners are
 * captured for manual dispatch.
 *
 * @param {Array<Object>} elements Candidate elements.
 * @param {{hidden?: boolean}} [options] Initial visibility.
 * @returns {Object} Fake document.
 */
function fakeDocument(elements = [], { hidden = false } = {}) {
  const listeners = new Map();
  return {
    hidden,
    elements,
    listeners,
    querySelectorAll(selector) {
      // The module must query with its own exported selector.
      if (selector !== TICK_SELECTOR) return [];
      return this.elements.filter(
        (el) =>
          el.connected !== false &&
          typeof el.getAttribute === 'function' &&
          el.getAttribute(TICK_TIMESTAMP_ATTRIBUTE) != null,
      );
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    dispatchVisibility() {
      const fn = listeners.get('visibilitychange');
      if (fn) fn();
    },
  };
}

test('cadence and selector constants match the RT2 contract', () => {
  assert.equal(TICK_INTERVAL_MS, 1000);
  assert.equal(TICK_SELECTOR, `[${TICK_TIMESTAMP_ATTRIBUTE}]`);
  assert.equal(TICK_TIMESTAMP_ATTRIBUTE, 'data-ts-ago');
  assert.equal(TICK_FORMAT_ATTRIBUTE, 'data-ts-format');
});

test('formatTickingAge reproduces the existing formatters verbatim (RT4)', () => {
  const now = 1_000_000;
  const ts = now - 300; // 5 minutes
  assert.equal(formatTickingAge(ts, null, now), timeAgo(ts, now));
  assert.equal(formatTickingAge(ts, null, now), '5m 0s'); // timeAgo keeps the zero remainder
  assert.equal(formatTickingAge(ts, TICK_FORMAT_AGO, now), '5m 0s');
  assert.equal(formatTickingAge(ts, TICK_FORMAT_RELATIVE, now), formatRelativeSeconds(ts, now));
  assert.equal(formatTickingAge(ts, TICK_FORMAT_RELATIVE, now), '5m'); // relative omits it
});

test('the ago-suffixed variant reproduces the federation format verbatim (RT4)', () => {
  const now = 1_000_000;
  const ts = now - 300;
  assert.equal(formatTickingAge(ts, TICK_FORMAT_AGO_SUFFIXED, now), timeAgoSuffixed(ts, now));
  assert.equal(formatTickingAge(ts, TICK_FORMAT_AGO_SUFFIXED, now), '5m ago'); // coarse, suffixed
  assert.equal(formatTickingAge(0, TICK_FORMAT_AGO_SUFFIXED, now), '');
  assert.equal(
    tickAttributes(123, TICK_FORMAT_AGO_SUFFIXED),
    'data-ts-ago="123" data-ts-format="ago-suffixed"',
  );
});

test('formatTickingAge falls back to the ago variant and to empty strings', () => {
  const now = 1_000_000;
  assert.equal(formatTickingAge(now - 4, 'bogus-variant', now), '4s');
  assert.equal(formatTickingAge(null, null, now), '');
  assert.equal(formatTickingAge('not-a-number', null, now), '');
  assert.equal(formatTickingAge('not-a-number', TICK_FORMAT_RELATIVE, now), '');
});

test('tickAttributes emits opt-in markup only for usable timestamps', () => {
  assert.equal(tickAttributes(1712345678), 'data-ts-ago="1712345678"');
  assert.equal(tickAttributes('1712345678'), 'data-ts-ago="1712345678"');
  assert.equal(tickAttributes(1712345678, TICK_FORMAT_AGO), 'data-ts-ago="1712345678"');
  assert.equal(
    tickAttributes(1712345678, TICK_FORMAT_RELATIVE),
    'data-ts-ago="1712345678" data-ts-format="relative"',
  );
  // Nothing to count -> no attributes: the field stays a static empty cell.
  assert.equal(tickAttributes(null), '');
  assert.equal(tickAttributes(0), '');
  assert.equal(tickAttributes('nope'), '');
  assert.equal(tickAttributes(Infinity), '');
});

test('updateTickingElements writes only fields whose string changed (RT2)', () => {
  const now = 2_000_000;
  const young = fakeField(now - 4);
  const old = fakeField(now - (3 * 86_400 + 4 * 3_600 + 1_800)); // "3d 4h"
  const doc = fakeDocument([young, old]);

  assert.equal(updateTickingElements(doc, now), 2);
  assert.equal(young.textContent, '4s');
  assert.equal(old.textContent, '3d 4h');

  // Same instant again: nothing changed, nothing written.
  assert.equal(updateTickingElements(doc, now), 0);
  assert.equal(young.writes, 1);
  assert.equal(old.writes, 1);

  // One second later: the young field ticks, the day-old field text is
  // identical and must not be rewritten.
  assert.equal(updateTickingElements(doc, now + 1), 1);
  assert.equal(young.textContent, '5s');
  assert.equal(old.writes, 1);
});

test('updateTickingElements honours the per-field formatter variant', () => {
  const now = 2_000_000;
  const agoField = fakeField(now - 300);
  const relativeField = fakeField(now - 300, { format: TICK_FORMAT_RELATIVE });
  const doc = fakeDocument([agoField, relativeField]);
  updateTickingElements(doc, now);
  assert.equal(agoField.textContent, '5m 0s');
  assert.equal(relativeField.textContent, '5m');
});

test('a removed element or attribute stops its writes; junk is skipped safely', () => {
  const now = 2_000_000;
  const field = fakeField(now - 10);
  const junk = { textContent: '' }; // no getAttribute -> must be skipped
  const doc = fakeDocument([field, junk]);

  assert.equal(updateTickingElements(doc, now), 1);
  field.connected = false; // detached from the DOM
  assert.equal(updateTickingElements(doc, now + 1), 0);

  field.connected = true;
  field.attrs.delete(TICK_TIMESTAMP_ATTRIBUTE); // opt-out
  assert.equal(updateTickingElements(doc, now + 2), 0);
  assert.equal(field.writes, 1);
});

test('updateTickingElements is a no-op without a usable document', () => {
  assert.equal(updateTickingElements(null), 0);
  assert.equal(updateTickingElements({}), 0);
});

test('updateTickingElements defaults its clock to the wall clock', () => {
  // 1d 1h 1m 1s ago is stable at "1d 1h" for any plausible test runtime.
  const field = fakeField(Date.now() / 1000 - 90_061);
  const doc = fakeDocument([field]);
  assert.equal(updateTickingElements(doc), 1);
  assert.equal(field.textContent, '1d 1h');
});

test('startRelativeTimeTicker snaps immediately, then ticks on the interval (RT1/RT2)', () => {
  let nowValue = 3_000_000;
  const field = fakeField(nowValue - 4);
  const doc = fakeDocument([field]);
  const scheduled = [];
  const cancelled = [];
  const ticker = startRelativeTimeTicker({
    documentRef: doc,
    now: () => nowValue,
    setIntervalFn: (cb, delay) => {
      scheduled.push({ cb, delay });
      return `interval-${scheduled.length}`;
    },
    clearIntervalFn: (handle) => cancelled.push(handle),
  });

  // Immediate snap pass on start; interval armed at the shared cadence.
  assert.equal(field.textContent, '4s');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, TICK_INTERVAL_MS);
  assert.equal(ticker.running(), true);

  nowValue += 1;
  scheduled[0].cb();
  assert.equal(field.textContent, '5s');

  // The handle's manual tick reports the write count.
  nowValue += 1;
  assert.equal(ticker.tick(), 1);
  assert.equal(field.textContent, '6s');
  assert.equal(cancelled.length, 0);
});

test('hidden tab idles the ticker; visibility snaps and re-arms (RT3)', () => {
  let nowValue = 3_000_000;
  const field = fakeField(nowValue - 10);
  const doc = fakeDocument([field]);
  const scheduled = [];
  const cancelled = [];
  const ticker = startRelativeTimeTicker({
    documentRef: doc,
    now: () => nowValue,
    setIntervalFn: (cb, delay) => {
      scheduled.push({ cb, delay });
      return `interval-${scheduled.length}`;
    },
    clearIntervalFn: (handle) => cancelled.push(handle),
  });
  assert.equal(field.textContent, '10s');

  // Hide: the interval is torn down entirely (no background work).
  doc.hidden = true;
  doc.dispatchVisibility();
  assert.deepEqual(cancelled, ['interval-1']);
  assert.equal(ticker.running(), false);

  // Two minutes pass while hidden; nothing is written.
  nowValue += 120;
  assert.equal(field.writes, 1);

  // Visible again: one snap pass to the correct value, interval re-armed.
  doc.hidden = false;
  doc.dispatchVisibility();
  assert.equal(field.textContent, '2m 10s');
  assert.equal(scheduled.length, 2);
  assert.equal(ticker.running(), true);

  // A redundant visible dispatch must not arm a second interval.
  doc.dispatchVisibility();
  assert.equal(scheduled.length, 2);
});

test('a ticker started while hidden stays idle until the tab is shown', () => {
  let nowValue = 3_000_000;
  const field = fakeField(nowValue - 4);
  const doc = fakeDocument([field], { hidden: true });
  const scheduled = [];
  const ticker = startRelativeTimeTicker({
    documentRef: doc,
    now: () => nowValue,
    setIntervalFn: (cb) => {
      scheduled.push(cb);
      return 'interval';
    },
    clearIntervalFn: () => {},
  });
  assert.equal(field.writes, 0);
  assert.equal(ticker.running(), false);

  doc.hidden = false;
  doc.dispatchVisibility();
  assert.equal(field.textContent, '4s');
  assert.equal(ticker.running(), true);
});

test('stop() disarms, unsubscribes, and is idempotent', () => {
  const doc = fakeDocument([fakeField(1_000)]);
  const cancelled = [];
  const ticker = startRelativeTimeTicker({
    documentRef: doc,
    now: () => 1_000,
    setIntervalFn: () => 'interval-1',
    clearIntervalFn: (handle) => cancelled.push(handle),
  });
  assert.equal(doc.listeners.size, 1);

  ticker.stop();
  assert.deepEqual(cancelled, ['interval-1']);
  assert.equal(doc.listeners.size, 0, 'visibility listener removed');
  assert.equal(ticker.running(), false);

  ticker.stop(); // second stop: no further cancels, no throw
  assert.deepEqual(cancelled, ['interval-1']);
});

test('stopping a never-armed (hidden) ticker is safe', () => {
  const doc = fakeDocument([], { hidden: true });
  const cancelled = [];
  const ticker = startRelativeTimeTicker({
    documentRef: doc,
    now: () => 1_000,
    setIntervalFn: () => 'interval-1',
    clearIntervalFn: (handle) => cancelled.push(handle),
  });
  ticker.stop();
  assert.deepEqual(cancelled, []);
});

test('a document without listener support still ticks and stops cleanly', () => {
  const field = fakeField(500);
  const doc = {
    hidden: false,
    querySelectorAll: (selector) => (selector === TICK_SELECTOR ? [field] : []),
  };
  const ticker = startRelativeTimeTicker({
    documentRef: doc,
    now: () => 1_000,
    setIntervalFn: () => 'interval-1',
    clearIntervalFn: () => {},
  });
  assert.equal(field.textContent, timeAgo(500, 1_000));
  ticker.stop();
});

test('a missing document yields an inert, safe handle', () => {
  // Node has no global `document`, so the default lookup lands on null...
  const defaulted = startRelativeTimeTicker();
  assert.equal(defaulted.tick(), 0);
  assert.equal(defaulted.running(), false);
  defaulted.stop();
  // ...and an explicit null / unusable document behaves identically.
  const explicit = startRelativeTimeTicker({ documentRef: null });
  assert.equal(explicit.tick(), 0);
  explicit.stop();
  const unusable = startRelativeTimeTicker({ documentRef: {} });
  assert.equal(unusable.running(), false);
});

test('default interval scheduler arms a real (unref-ed) interval', () => {
  const doc = fakeDocument([fakeField(1_000)]);
  const ticker = startRelativeTimeTicker({ documentRef: doc });
  assert.equal(ticker.running(), true);
  ticker.stop();
  assert.equal(ticker.running(), false);
});

test('null or getAttribute-less entries returned by a lax DOM are skipped', () => {
  // A faithful querySelectorAll never yields these, but the module guards
  // against lax/stubbed DOMs; feed them straight through to cover the guard.
  const field = fakeField(990);
  const doc = {
    querySelectorAll: (selector) => (selector === TICK_SELECTOR ? [null, { textContent: 'junk' }, field] : []),
  };
  assert.equal(updateTickingElements(doc, 1_000), 1);
  assert.equal(field.textContent, '10s');
});

test('an explicit intervalMs overrides the shared cadence', () => {
  const doc = fakeDocument([]);
  const delays = [];
  const ticker = startRelativeTimeTicker({
    documentRef: doc,
    intervalMs: 250,
    now: () => 1_000,
    setIntervalFn: (cb, delay) => {
      delays.push(delay);
      return 'interval-1';
    },
    clearIntervalFn: () => {},
  });
  assert.deepEqual(delays, [250]);
  ticker.stop();
});

test('the default document lookup finds a global document when present', () => {
  const field = fakeField(996);
  globalThis.document = fakeDocument([field]);
  try {
    const ticker = startRelativeTimeTicker({
      now: () => 1_000,
      setIntervalFn: () => 'interval-1',
      clearIntervalFn: () => {},
    });
    assert.equal(field.textContent, '4s');
    ticker.stop();
  } finally {
    delete globalThis.document;
  }
});

test('default scheduler tolerates interval handles without unref (or none at all)', () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  try {
    // A handle with no unref method: the unref guard's false side.
    globalThis.setInterval = () => ({});
    globalThis.clearInterval = () => {};
    const withPlainHandle = startRelativeTimeTicker({ documentRef: fakeDocument([]) });
    assert.equal(withPlainHandle.running(), true);
    withPlainHandle.stop();
    // A falsy handle: the guard's short-circuit side.
    globalThis.setInterval = () => undefined;
    const withFalsyHandle = startRelativeTimeTicker({ documentRef: fakeDocument([]) });
    withFalsyHandle.stop();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test('a stale visibility event after stop() cannot re-arm the ticker', () => {
  const doc = fakeDocument([]);
  // Simulate a lax DOM whose removeEventListener does not actually detach.
  doc.removeEventListener = () => {};
  const scheduled = [];
  const ticker = startRelativeTimeTicker({
    documentRef: doc,
    now: () => 1_000,
    setIntervalFn: (cb) => {
      scheduled.push(cb);
      return `interval-${scheduled.length}`;
    },
    clearIntervalFn: () => {},
  });
  assert.equal(scheduled.length, 1);
  ticker.stop();
  doc.dispatchVisibility(); // stale listener fires post-stop
  assert.equal(scheduled.length, 1, 'stopped ticker must not re-arm');
  assert.equal(ticker.running(), false);
});
