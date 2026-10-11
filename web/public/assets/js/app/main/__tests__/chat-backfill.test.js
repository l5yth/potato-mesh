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
 * SPEC BK1: the walk of the chat history backfill. Each page is committed
 * before the next one is requested, and the walk flushes the coalesced
 * repaint once when it ends, after its last page or after a failure.
 *
 * @module main/__tests__/chat-backfill
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deferred } from '../../__tests__/async-helpers.js';
import { createChatBackfill } from '../chat-backfill.js';

/**
 * A walk whose pages, commits, flushes and warnings land in one event list.
 *
 * @param {Array<Array<Object>>} batches Pages the walk yields, in order.
 * @param {{ failAfter?: number, failCommitAt?: number, gate?: Promise<void> }} [options]
 *   ``failAfter``: the page request after that many pages rejects;
 *   ``failCommitAt``: the commit of that page (1-based) throws;
 *   ``gate``: the first page waits for it.
 * @returns {{ backfill: Object, events: Array<string>, cursors: Array<number>, warnings: Array<Array<*>> }}
 *   The runner and what it did.
 */
function recordedWalk(batches, { failAfter = Infinity, failCommitAt = 0, gate = null } = {}) {
  const events = [];
  const cursors = [];
  const warnings = [];
  const backfill = createChatBackfill({
    pages: async function* pages(before) {
      cursors.push(before);
      if (gate) await gate;
      for (let index = 0; index < batches.length; index += 1) {
        if (index >= failAfter) throw new Error(`page ${index + 1} failed`);
        events.push(`request ${index + 1}`);
        yield batches[index];
      }
    },
    commit: async batch => {
      const page = batches.indexOf(batch) + 1;
      events.push(`commit ${page} start`);
      // A commit awaits its hydration before the page is merged.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (page === failCommitAt) throw new Error(`commit ${page} failed`);
      events.push(`commit ${page} end`);
    },
    flush: () => events.push('flush'),
    logger: { warn: (...args) => warnings.push(args) },
  });
  return { backfill, events, cursors, warnings };
}

test('each page is committed before the next is requested, and the walk flushes once after the last (BK1)', async () => {
  const { backfill, events, cursors, warnings } = recordedWalk([[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]]);
  await backfill.run(1_700_000_000);
  assert.deepEqual(cursors, [1_700_000_000], 'the walk pages backward from the given cursor');
  assert.deepEqual(events, [
    'request 1', 'commit 1 start', 'commit 1 end',
    'request 2', 'commit 2 start', 'commit 2 end',
    'request 3', 'commit 3 start', 'commit 3 end',
    'flush',
  ]);
  assert.deepEqual(warnings, []);
});

test('a walk with no pages still flushes once when it ends (BK1)', async () => {
  const { backfill, events } = recordedWalk([]);
  await backfill.run(42);
  assert.deepEqual(events, ['flush']);
});

test('a failed page ends the walk: earlier pages stay committed, the failure is logged, the flush runs once (BK1)', async () => {
  const { backfill, events, warnings } = recordedWalk([[{ id: 1 }], [{ id: 2 }]], { failAfter: 1 });
  await backfill.run(42);
  assert.deepEqual(events, ['request 1', 'commit 1 start', 'commit 1 end', 'flush']);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'chat history backfill failed; showing the most recent page only');
  assert.equal(warnings[0][1].message, 'page 2 failed');
});

test('a commit that throws ends the walk like a failed page (BK1)', async () => {
  const { backfill, events, warnings } = recordedWalk([[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]], { failCommitAt: 2 });
  await backfill.run(42);
  assert.deepEqual(events, ['request 1', 'commit 1 start', 'commit 1 end', 'request 2', 'commit 2 start', 'flush']);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1].message, 'commit 2 failed');
});

test('with no cursor to page from the walk requests nothing and flushes nothing (PL-A1)', async () => {
  const { backfill, events, cursors } = recordedWalk([[{ id: 1 }]]);
  for (const before of [0, -5, Number.NaN, undefined, null]) {
    await backfill.run(before);
  }
  assert.deepEqual(cursors, []);
  assert.deepEqual(events, []);
});

test('a run while a walk is in flight returns at once; a run after it walks again (BK1)', async () => {
  const gate = deferred();
  const { backfill, events, cursors } = recordedWalk([[{ id: 1 }]], { gate: gate.promise });
  const first = backfill.run(10);
  await backfill.run(20);
  assert.deepEqual(cursors, [10], 'the second run made no request while the first was in flight');
  assert.deepEqual(events, []);
  gate.resolve();
  await first;
  assert.deepEqual(events, ['request 1', 'commit 1 start', 'commit 1 end', 'flush']);
  await backfill.run(30);
  assert.deepEqual(cursors, [10, 30], 'the guard is released when the walk ends');
});

test('a flush that throws when the walk ends is logged like a failed page, not rethrown (BK1)', async () => {
  const commits = [];
  const warnings = [];
  let flushes = 0;
  const backfill = createChatBackfill({
    pages: async function* pages() {
      yield [{ id: 1 }];
    },
    commit: batch => {
      commits.push(batch);
    },
    flush: () => {
      flushes += 1;
      throw new Error('render failed');
    },
    logger: { warn: (...args) => warnings.push(args) },
  });
  await backfill.run(42);
  assert.equal(commits.length, 1, 'the page was committed before the flush');
  assert.equal(flushes, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'chat history backfill failed; showing the most recent page only');
  assert.equal(warnings[0][1].message, 'render failed');
  await backfill.run(43);
  assert.equal(commits.length, 2, 'the guard is released after a failed flush');
});

test('without a logger the failure goes to console.warn (BK1)', async () => {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    let flushes = 0;
    const backfill = createChatBackfill({
      pages: async function* pages() {
        throw new Error('no page');
      },
      commit: () => {},
      flush: () => {
        flushes += 1;
      },
    });
    await backfill.run(1);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][1].message, 'no page');
    assert.equal(flushes, 1);
  } finally {
    console.warn = original;
  }
});
