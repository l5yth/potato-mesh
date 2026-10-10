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
 * SPEC DE1-DE3: the trailing-edge debounce behind the node filter box.
 *
 * Most tests run the module's default timers under `node:test` fake timers,
 * so `mock.timers.tick(ms)` is the only clock.
 *
 * @module main/__tests__/filter-debounce
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { FILTER_DEBOUNCE_MS, createFilterDebounce } from '../filter-debounce.js';

/**
 * Run `fn` with fake `setTimeout`/`clearTimeout`, restoring the real ones
 * afterwards.
 *
 * @param {function(): void} fn Test body.
 * @returns {void}
 */
function withFakeTimers(fn) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    fn();
  } finally {
    mock.timers.reset();
  }
}

/**
 * A debounce whose `apply` counts its runs.
 *
 * @param {Object} [options] Options for {@link createFilterDebounce}.
 * @returns {{ debounce: Object, runs: function(): number }} The debounce and its run count.
 */
function counted(options) {
  let runs = 0;
  const debounce = createFilterDebounce(() => {
    runs += 1;
  }, options);
  return { debounce, runs: () => runs };
}

test('FILTER_DEBOUNCE_MS is 200 ms, inside the decided 150-200 ms range (DE1)', () => {
  assert.equal(FILTER_DEBOUNCE_MS, 200);
  assert.ok(FILTER_DEBOUNCE_MS >= 150 && FILTER_DEBOUNCE_MS <= 200);
});

test('sixteen schedules 120 ms apart run apply once, one window after the last (DE1)', () => {
  withFakeTimers(() => {
    const { debounce, runs } = counted();
    for (let key = 1; key <= 16; key += 1) {
      debounce.schedule();
      assert.equal(runs(), 0, `schedule ${key}: nothing has run while they keep coming`);
      if (key < 16) mock.timers.tick(120);
    }
    mock.timers.tick(FILTER_DEBOUNCE_MS - 1);
    assert.equal(runs(), 0, 'one millisecond short of the window nothing has run');
    mock.timers.tick(1);
    assert.equal(runs(), 1, 'the window after the last schedule runs apply once');
    mock.timers.tick(10 * FILTER_DEBOUNCE_MS);
    assert.equal(runs(), 1, 'and never again');
    assert.equal(debounce.isPending(), false);
  });
});

test('schedules a whole window apart run apply once each (DE1)', () => {
  withFakeTimers(() => {
    const { debounce, runs } = counted();
    for (let key = 1; key <= 3; key += 1) {
      debounce.schedule();
      mock.timers.tick(FILTER_DEBOUNCE_MS);
      assert.equal(runs(), key);
    }
  });
});

test('flush runs a pending apply at once, and the window then runs nothing (DE2)', () => {
  withFakeTimers(() => {
    const { debounce, runs } = counted();
    debounce.schedule();
    mock.timers.tick(50);
    assert.equal(debounce.flush(), true, 'flush reports the pending apply it ran');
    assert.equal(runs(), 1, 'flush ran apply without waiting for the window');
    assert.equal(debounce.isPending(), false);
    mock.timers.tick(10 * FILTER_DEBOUNCE_MS);
    assert.equal(runs(), 1, 'the flushed window does not run apply a second time');
  });
});

test('flush with nothing pending runs nothing (DE2)', () => {
  withFakeTimers(() => {
    const { debounce, runs } = counted();
    assert.equal(debounce.flush(), false, 'before any schedule');
    debounce.schedule();
    mock.timers.tick(FILTER_DEBOUNCE_MS);
    assert.equal(runs(), 1);
    assert.equal(debounce.flush(), false, 'after the window ran apply');
    assert.equal(runs(), 1);
  });
});

test('cancel drops a pending apply and reports whether one was pending (DE2)', () => {
  withFakeTimers(() => {
    const { debounce, runs } = counted();
    assert.equal(debounce.cancel(), false, 'nothing to cancel yet');
    debounce.schedule();
    assert.equal(debounce.isPending(), true);
    assert.equal(debounce.cancel(), true, 'a pending apply was dropped');
    assert.equal(debounce.isPending(), false);
    mock.timers.tick(10 * FILTER_DEBOUNCE_MS);
    assert.equal(runs(), 0, 'the cancelled window never runs apply');
    assert.equal(debounce.cancel(), false);
  });
});

test('apply may schedule the next window from inside its own run', () => {
  withFakeTimers(() => {
    let runs = 0;
    const debounce = createFilterDebounce(() => {
      runs += 1;
      if (runs === 1) debounce.schedule();
    });
    debounce.schedule();
    mock.timers.tick(FILTER_DEBOUNCE_MS);
    assert.equal(runs, 1);
    assert.equal(debounce.isPending(), true, 'the window armed inside apply stays armed');
    mock.timers.tick(FILTER_DEBOUNCE_MS);
    assert.equal(runs, 2);
    assert.equal(debounce.isPending(), false);
  });
});

test('an apply that throws leaves nothing pending, from the window and from flush', () => {
  withFakeTimers(() => {
    const debounce = createFilterDebounce(() => {
      throw new Error('repaint failed');
    });
    debounce.schedule();
    assert.throws(() => mock.timers.tick(FILTER_DEBOUNCE_MS), /repaint failed/);
    assert.equal(debounce.isPending(), false, 'after the window');
    debounce.schedule();
    assert.throws(() => debounce.flush(), /repaint failed/);
    assert.equal(debounce.isPending(), false, 'after flush');
  });
});

test('injected timers get the window and the handle they returned', () => {
  const armed = [];
  const cleared = [];
  const { debounce, runs } = counted({
    delayMs: 50,
    setTimer: (callback, ms) => {
      armed.push({ callback, ms });
      return armed.length;
    },
    clearTimer: handle => cleared.push(handle),
  });
  debounce.schedule();
  debounce.schedule();
  assert.deepEqual(armed.map(entry => entry.ms), [50, 50], 'each schedule arms one 50 ms window');
  assert.deepEqual(cleared, [1], 'the second schedule cleared the first handle');
  armed[1].callback();
  assert.equal(runs(), 1);
  assert.equal(debounce.cancel(), false, 'the window that ran is no longer pending');
  assert.deepEqual(cleared, [1]);
});

test('the default timer is unref-ed where the handle allows, and a numeric handle (browsers) is kept as is', () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const cleared = [];
  let unrefs = 0;
  try {
    globalThis.clearTimeout = handle => cleared.push(handle);
    const nodeHandle = { unref: () => { unrefs += 1; } };
    globalThis.setTimeout = () => nodeHandle;
    const first = counted();
    first.debounce.schedule();
    assert.equal(unrefs, 1, 'a Node handle is unref-ed, so a pending window never holds the process open');
    assert.equal(first.debounce.cancel(), true);
    assert.deepEqual(cleared, [nodeHandle], 'cancel clears the handle setTimeout returned');

    globalThis.setTimeout = () => 7;
    const second = counted();
    second.debounce.schedule();
    assert.equal(second.debounce.isPending(), true, 'a numeric handle arms the window too');
    assert.equal(second.debounce.cancel(), true);
    assert.deepEqual(cleared, [nodeHandle, 7]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('createFilterDebounce rejects an apply that is not a function', () => {
  assert.throws(() => createFilterDebounce(), TypeError);
  assert.throws(() => createFilterDebounce('applyFilter'), TypeError);
});
