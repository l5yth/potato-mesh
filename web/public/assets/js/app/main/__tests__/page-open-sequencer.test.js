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
 * SPEC OR1-OR5 unit tests for the page-open sequencer: the seed, then the
 * first refresh, then the start; the bounds on the seed and on the first
 * refresh; a cancelled start; the network-rows latch. The bounds run on
 * injected fake timers, fired by the test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPageOpenSequencer, SEED_TIMEOUT_MS, START_TIMEOUT_MS } from '../page-open-sequencer.js';

/**
 * A promise with its resolve and reject exposed.
 *
 * @returns {{ promise: Promise<*>, resolve: Function, reject: Function }}
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Let queued promise callbacks run.
 *
 * @returns {Promise<void>}
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Fake timers: `setTimeout` records a handle the test fires or the sequencer
 * clears.
 *
 * @returns {{ timers: Object, armed: Array<Object>, live: () => Array<Object>, fire: (ms: number) => number }}
 *   The injectable timers, every handle armed, the handles neither cleared nor
 *   fired, and a firing function returning how many handles of `ms` fired.
 */
function fakeTimers() {
  const armed = [];
  const timers = {
    setTimeout(callback, ms) {
      const handle = {
        ms, callback, cleared: false, fired: false, unrefs: 0,
        unref() {
          this.unrefs += 1;
          return this;
        },
      };
      armed.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      handle.cleared = true;
    },
  };
  const live = () => armed.filter((h) => !h.cleared && !h.fired);
  const fire = (ms) => {
    const due = live().filter((h) => h.ms === ms);
    for (const h of due) {
      h.fired = true;
      h.callback();
    }
    return due.length;
  };
  return { timers, armed, live, fire };
}

/**
 * Build a sequencer whose seed and load wait on deferreds, recording each step,
 * over fake timers.
 *
 * @returns {{ sequencer: Object, steps: Array<string>, seed: Object, load: Object, clock: Object }}
 */
function recorded() {
  const steps = [];
  const seed = deferred();
  const load = deferred();
  const clock = fakeTimers();
  const sequencer = createPageOpenSequencer({
    seed: () => {
      steps.push('seed');
      return seed.promise;
    },
    load: () => {
      steps.push('load');
      return load.promise;
    },
    start: () => {
      steps.push('start');
    },
    timers: clock.timers,
  });
  return { sequencer, steps, seed, load, clock };
}

test('run calls the seed at once, the load once the seed settles and the start once the load settles (OR1)', async () => {
  const { sequencer, steps, seed, load } = recorded();
  const running = sequencer.run();
  assert.deepEqual(steps, ['seed'], 'the seed starts in the same task');
  await flush();
  assert.deepEqual(steps, ['seed'], 'no load while the seed runs');
  seed.resolve(true);
  await flush();
  assert.deepEqual(steps, ['seed', 'load']);
  await flush();
  assert.deepEqual(steps, ['seed', 'load'], 'no start while the load runs');
  load.resolve();
  await running;
  assert.deepEqual(steps, ['seed', 'load', 'start']);
});

test('isPending is false before run, true until the load settles, false after (OR1)', async () => {
  const { sequencer, seed, load } = recorded();
  assert.equal(sequencer.isPending(), false, 'nothing runs before run');
  const running = sequencer.run();
  assert.equal(sequencer.isPending(), true, 'pending while the seed runs');
  seed.resolve(false);
  await flush();
  assert.equal(sequencer.isPending(), true, 'pending while the load runs');
  load.resolve();
  await running;
  assert.equal(sequencer.isPending(), false, 'settled once the start ran');
});

test('run is one initial load per page open: a second call returns the same promise', async () => {
  const { sequencer, steps, seed, load } = recorded();
  const first = sequencer.run();
  const second = sequencer.run();
  assert.equal(second, first);
  seed.resolve(true);
  load.resolve();
  await first;
  assert.equal(sequencer.run(), first, 'a call after the load still returns it');
  assert.deepEqual(steps, ['seed', 'load', 'start'], 'each step ran once');
});

test('a rejected seed still loads and starts (a cold load follows)', async () => {
  const { sequencer, steps, seed, load } = recorded();
  const running = sequencer.run();
  seed.reject(new Error('cache read failed'));
  await flush();
  load.resolve();
  await running;
  assert.deepEqual(steps, ['seed', 'load', 'start']);
});

test('a seed that throws at once still loads and starts', async () => {
  const steps = [];
  const sequencer = createPageOpenSequencer({
    seed: () => {
      throw new Error('no cache');
    },
    load: () => {
      steps.push('load');
      return Promise.resolve();
    },
    start: () => steps.push('start'),
    timers: fakeTimers().timers,
  });
  await sequencer.run();
  assert.deepEqual(steps, ['load', 'start']);
});

test('a rejected load still starts, so the stream and the poll retry it', async () => {
  const { sequencer, steps, seed, load } = recorded();
  const running = sequencer.run();
  seed.resolve(false);
  await flush();
  load.reject(new Error('network down'));
  await running;
  assert.deepEqual(steps, ['seed', 'load', 'start']);
  assert.equal(sequencer.isPending(), false);
});

test('cancelStart while the load runs makes the start a no-op; the load still settles (OR3)', async () => {
  const { sequencer, steps, seed, load } = recorded();
  const running = sequencer.run();
  seed.resolve(true);
  await flush();
  sequencer.cancelStart();
  load.resolve();
  await running;
  assert.deepEqual(steps, ['seed', 'load'], 'the deferred start never ran');
  assert.equal(sequencer.isPending(), false, 'the load settled');
});

test('cancelStart before run leaves the seed and the load running and the start off (OR3)', async () => {
  const { sequencer, steps, seed, load } = recorded();
  sequencer.cancelStart();
  const running = sequencer.run();
  seed.resolve(true);
  load.resolve();
  await running;
  assert.deepEqual(steps, ['seed', 'load']);
});

test('cancelStart after the start changes nothing', async () => {
  const { sequencer, steps, seed, load } = recorded();
  const running = sequencer.run();
  seed.resolve(true);
  load.resolve();
  await running;
  sequencer.cancelStart();
  await flush();
  assert.deepEqual(steps, ['seed', 'load', 'start'], 'the start ran once and stays done');
});

test('markNetworkLoaded latches hasNetworkData for the page (OR2)', () => {
  const { sequencer } = recorded();
  assert.equal(sequencer.hasNetworkData(), false, 'no network rows at page open');
  sequencer.markNetworkLoaded();
  assert.equal(sequencer.hasNetworkData(), true);
  sequencer.markNetworkLoaded();
  assert.equal(sequencer.hasNetworkData(), true, 'stays set');
});

test('the bounds are SEED_TIMEOUT_MS on the seed and START_TIMEOUT_MS on the first refresh, armed unref-ed (OR5)', async () => {
  assert.equal(SEED_TIMEOUT_MS, 3000);
  assert.equal(START_TIMEOUT_MS, 20000);
  const { sequencer, seed, load, clock } = recorded();
  const running = sequencer.run();
  assert.deepEqual(clock.live().map((h) => h.ms), [SEED_TIMEOUT_MS], 'the seed bound is armed with the seed');
  seed.resolve(true);
  await flush();
  assert.deepEqual(clock.live().map((h) => h.ms), [START_TIMEOUT_MS], 'the seed bound cleared, the start bound armed');
  load.resolve();
  await running;
  assert.deepEqual(clock.live(), [], 'no bound is left once the start ran');
  assert.deepEqual(clock.armed.map((h) => h.unrefs), [1, 1], 'neither bound keeps a Node process alive');
  assert.deepEqual(sequencer.boundsHit(), { seed: false, start: false }, 'no bound fired');
});

test('a seed that never settles holds the first refresh only until its bound (OR5)', async () => {
  const { sequencer, steps, load, clock } = recorded();
  const running = sequencer.run();
  await flush();
  assert.deepEqual(steps, ['seed'], 'the first refresh waits on the seed');
  assert.equal(clock.fire(SEED_TIMEOUT_MS), 1);
  await flush();
  assert.deepEqual(steps, ['seed', 'load'], 'the first refresh runs at the seed bound');
  load.resolve();
  await running;
  assert.deepEqual(steps, ['seed', 'load', 'start']);
  assert.deepEqual(sequencer.boundsHit(), { seed: true, start: false });
});

test('a first refresh that never settles holds the start only until its bound (OR5)', async () => {
  const { sequencer, steps, seed, clock } = recorded();
  const running = sequencer.run();
  seed.resolve(true);
  await flush();
  assert.equal(sequencer.isPending(), true);
  assert.equal(clock.fire(START_TIMEOUT_MS), 1);
  await running;
  assert.deepEqual(steps, ['seed', 'load', 'start'], 'the start runs at its bound');
  assert.equal(sequencer.isPending(), false, 'no longer pending: a resume now acts at once');
  assert.deepEqual(sequencer.boundsHit(), { seed: false, start: true });
});

test('cancelStart clears the armed bound, and no bound is armed after it (OR3, OR5)', async () => {
  const { sequencer, steps, seed, load, clock } = recorded();
  const running = sequencer.run();
  sequencer.cancelStart();
  assert.deepEqual(clock.live(), [], 'the seed bound is cleared');
  seed.resolve(true);
  await flush();
  assert.deepEqual(steps, ['seed', 'load'], 'the load still runs once the seed settles');
  assert.deepEqual(clock.live(), [], 'no start bound after a stop');
  load.resolve();
  await running;
  assert.deepEqual(steps, ['seed', 'load'], 'the start stays off');
  assert.deepEqual(sequencer.boundsHit(), { seed: false, start: false });
});

test('cancelStart while the first refresh hangs clears its bound; the start never runs (OR3, OR5)', async () => {
  const { sequencer, steps, seed, clock } = recorded();
  sequencer.run();
  seed.resolve(true);
  await flush();
  assert.deepEqual(clock.live().map((h) => h.ms), [START_TIMEOUT_MS]);
  sequencer.cancelStart();
  assert.deepEqual(clock.live(), [], 'the start bound is cleared');
  await flush();
  assert.deepEqual(steps, ['seed', 'load']);
  assert.equal(sequencer.isPending(), true, 'the hung refresh never settles; nothing restarts it');
});

test('the ambient timers arm and clear the bounds by default', async () => {
  const steps = [];
  const sequencer = createPageOpenSequencer({
    seed: () => Promise.resolve(false),
    load: () => Promise.resolve(),
    start: () => steps.push('start'),
  });
  await sequencer.run();
  assert.deepEqual(steps, ['start']);
  assert.deepEqual(sequencer.boundsHit(), { seed: false, start: false });
});

test('a start that throws rejects the initial load, which is then no longer pending', async () => {
  const sequencer = createPageOpenSequencer({
    seed: () => false,
    load: () => undefined,
    start: () => {
      throw new Error('stream refused');
    },
    timers: fakeTimers().timers,
  });
  await assert.rejects(() => sequencer.run(), /stream refused/);
  assert.equal(sequencer.isPending(), false);
});

test('browser timers (numeric handles without unref) arm and clear the bounds', async () => {
  const armed = new Map();
  let next = 0;
  const timers = {
    setTimeout(callback, ms) {
      next += 1;
      armed.set(next, ms);
      return next;
    },
    clearTimeout(handle) {
      armed.delete(handle);
    },
  };
  const steps = [];
  const sequencer = createPageOpenSequencer({
    seed: () => Promise.resolve(true),
    load: () => Promise.resolve(),
    start: () => steps.push('start'),
    timers,
  });
  await sequencer.run();
  assert.deepEqual(steps, ['start']);
  assert.equal(next, 2, 'both bounds were armed');
  assert.equal(armed.size, 0, 'and both were cleared');
});

test('a step that settles after its bound fired runs nothing twice (OR5)', async () => {
  const { sequencer, steps, seed, load, clock } = recorded();
  const running = sequencer.run();
  assert.equal(clock.fire(SEED_TIMEOUT_MS), 1);
  await flush();
  seed.resolve(true); // the seed finishes late; the first refresh already runs
  await flush();
  assert.equal(clock.fire(START_TIMEOUT_MS), 1);
  await running;
  load.resolve(); // the first refresh finishes late; the start already ran
  await flush();
  assert.deepEqual(steps, ['seed', 'load', 'start'], 'each step ran once');
  assert.deepEqual(sequencer.boundsHit(), { seed: true, start: true });
});

