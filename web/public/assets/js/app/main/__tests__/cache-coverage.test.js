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
 * Unit tests for `main/cache-coverage.js` (SPEC CC2): the stored marker's
 * validation, the first refresh's walk plan, how refreshes and walks move a
 * coverage entry, and the tracker.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COVERAGE_COLLECTIONS,
  COVERAGE_CURSOR_FIELDS,
  normaliseCoverage,
  planCoverage,
  coverageAfterRefresh,
  coverageAfterWalkPage,
  coverageAfterWalk,
  createCoverageTracker,
} from '../cache-coverage.js';

/**
 * Rows whose `rx_time` values are `times`.
 *
 * @param {...number} times Sort values.
 * @returns {Array<Object>}
 */
const rows = (...times) => times.map((rx_time, id) => ({ id, rx_time }));

/** A page plan over `rx_time` with a cap of 3. */
const plan = (page) => planCoverage({ cap: 3, since: 0, field: 'rx_time', known: null, ...page });

test('the tracked collections and their sort columns match the routes (SPEC BP1)', () => {
  assert.deepEqual([...COVERAGE_COLLECTIONS], ['nodes', 'messages', 'positions', 'telemetry', 'neighbors', 'traces', 'waypoints']);
  for (const name of COVERAGE_COLLECTIONS) {
    assert.equal(COVERAGE_CURSOR_FIELDS[name], name === 'nodes' ? 'last_heard' : 'rx_time');
  }
});

test('normaliseCoverage keeps valid entries and rejects the rest', () => {
  assert.deepEqual(normaliseCoverage({ from: 7, to: 9, complete: true }), { from: 0, to: 9, complete: true });
  assert.deepEqual(normaliseCoverage({ from: 0, to: 0, complete: true }), { from: 0, to: 0, complete: true });
  assert.deepEqual(normaliseCoverage({ from: 4, to: 9, complete: false }), { from: 4, to: 9, complete: false });
  const invalid = [
    null, 'x', {}, { from: 1, to: 2 }, { from: 1, to: 2, complete: 'yes' },
    { from: 0, to: 9, complete: false }, // an incomplete entry needs a cursor to resume at
    { from: 5, to: 3, complete: false }, { from: 5, to: 3, complete: true },
    { from: -1, to: 3, complete: true }, { from: 1, to: -3, complete: true },
    { from: 1, to: Number.NaN, complete: false }, { from: '1', to: 3, complete: false },
    { from: 1, to: Infinity, complete: false },
  ];
  for (const value of invalid) assert.equal(normaliseCoverage(value), null, JSON.stringify(value));
});

test('a short newest page is the whole window: complete, no walk', () => {
  assert.deepEqual(plan({ rows: rows(30, 20) }), { coverage: { from: 0, to: 30, complete: true }, walk: null });
  assert.deepEqual(plan({ rows: [] }), { coverage: { from: 0, to: 0, complete: true }, walk: null });
  assert.deepEqual(plan({ rows: null }), { coverage: { from: 0, to: 0, complete: true }, walk: null });
});

test('a full newest page walks from its oldest row to the end of the window', () => {
  assert.deepEqual(plan({ rows: rows(30, 20, 10) }), {
    coverage: { from: 10, to: 30, complete: false },
    walk: { before: 10, until: 0, joins: null },
  });
});

test('a full page whose rows carry no sort value cannot be walked', () => {
  assert.deepEqual(plan({ rows: [{}, {}, {}] }), { coverage: null, walk: null });
});

test('a warm delta page that reaches complete cached rows needs no walk', () => {
  const known = { from: 0, to: 25, complete: true };
  // Short: it holds every row from since up, and since is at the cached top.
  assert.deepEqual(plan({ rows: rows(40, 30), since: 24, known }), { coverage: { from: 0, to: 40, complete: true }, walk: null });
  assert.deepEqual(plan({ rows: rows(40), since: 26, known }).walk, null, 'since one above the cached top still joins');
  assert.deepEqual(plan({ rows: [], since: 24, known }), { coverage: { from: 0, to: 25, complete: true }, walk: null });
  // Full: its oldest row is at or below the cached top.
  assert.deepEqual(plan({ rows: rows(40, 30, 25), since: 24, known }), { coverage: { from: 0, to: 40, complete: true }, walk: null });
});

test('a warm delta page that reaches cached rows stopping short of the window walks below them', () => {
  const known = { from: 12, to: 25, complete: false };
  assert.deepEqual(plan({ rows: rows(40, 30), since: 24, known }), {
    coverage: { from: 12, to: 40, complete: false },
    walk: { before: 12, until: 0, joins: null },
  });
});

test('a full warm delta page walks the gap down to complete cached rows', () => {
  const known = { from: 0, to: 25, complete: true };
  assert.deepEqual(plan({ rows: rows(60, 50, 40), since: 24, known }), {
    coverage: { from: 40, to: 60, complete: false },
    walk: { before: 40, until: 25, joins: known },
  });
});

test('a full warm delta page walks to the end when the cached rows stop short of the window', () => {
  const known = { from: 12, to: 25, complete: false };
  assert.deepEqual(plan({ rows: rows(60, 50, 40), since: 24, known }).walk, { before: 40, until: 0, joins: null });
});

test('a short delta page above a stale coverage entry walks the unverified rows', () => {
  const known = { from: 0, to: 25, complete: true };
  // The cached rows reach 50, but the entry vouches only up to 25.
  assert.deepEqual(plan({ rows: rows(60, 55), since: 49, known }), {
    coverage: { from: 55, to: 60, complete: false },
    walk: { before: 55, until: 25, joins: known },
  });
  assert.deepEqual(plan({ rows: [], since: 49, known }), {
    coverage: { from: 48, to: 48, complete: false },
    walk: { before: 48, until: 25, joins: known },
  }, 'an empty page walks from just below since');
});

test('a warm delta page over rows without a coverage entry walks them once to the end', () => {
  assert.deepEqual(plan({ rows: rows(60, 55), since: 49 }), {
    coverage: { from: 55, to: 60, complete: false },
    walk: { before: 55, until: 0, joins: null },
  });
  assert.deepEqual(plan({ rows: [], since: 1 }), { coverage: { from: 0, to: 0, complete: true }, walk: null },
    'nothing lies below a since of 1');
});

test('coverageAfterRefresh extends a short delta page that reaches the top, and keeps the entry otherwise', () => {
  const coverage = { from: 12, to: 25, complete: false };
  const page = (list, since) => coverageAfterRefresh(coverage, { rows: list, cap: 3, since, field: 'rx_time' });
  assert.deepEqual(page(rows(40, 30), 24), { from: 12, to: 40, complete: false });
  assert.deepEqual(page(rows(20), 24), coverage, 'an older row does not lower the top');
  assert.deepEqual(page(rows(40), 30), coverage, 'a gap above the top keeps the entry');
  assert.equal(page(rows(60, 50, 40), 24), coverage, 'a full page may leave a gap');
  assert.deepEqual(page(rows(40), 0), { from: 0, to: 40, complete: true }, 'a short newest page is the whole window');
  assert.deepEqual(coverageAfterRefresh(coverage, { rows: null, cap: 3, since: 24, field: 'rx_time' }), coverage);
  assert.equal(coverageAfterRefresh(null, { rows: rows(1), cap: 3, since: 0, field: 'rx_time' }), null);
});

test('coverageAfterWalkPage lowers from to the committed page\'s oldest row', () => {
  const coverage = { from: 40, to: 60, complete: false };
  assert.deepEqual(coverageAfterWalkPage(coverage, { rows: rows(39, 31), field: 'rx_time' }), { from: 31, to: 60, complete: false });
  assert.equal(coverageAfterWalkPage(coverage, { rows: rows(45), field: 'rx_time' }), coverage, 'a page above from moves nothing');
  assert.equal(coverageAfterWalkPage(coverage, { rows: [{}], field: 'rx_time' }), coverage, 'a page without a sort value moves nothing');
  const done = { from: 0, to: 60, complete: true };
  assert.equal(coverageAfterWalkPage(done, { rows: rows(1), field: 'rx_time' }), done);
  assert.equal(coverageAfterWalkPage(null, { rows: rows(1), field: 'rx_time' }), null);
});

test('coverageAfterWalk completes an exhausted walk, joins a reached one and keeps the rest', () => {
  const coverage = { from: 31, to: 60, complete: false };
  const joins = { from: 0, to: 25, complete: true };
  assert.deepEqual(coverageAfterWalk(coverage, { reason: 'exhausted', walk: { joins: null } }), { from: 0, to: 60, complete: true });
  assert.deepEqual(coverageAfterWalk(coverage, { reason: 'reached', walk: { joins } }), { from: 0, to: 60, complete: true });
  assert.deepEqual(
    coverageAfterWalk({ from: 31, to: 20, complete: false }, { reason: 'reached', walk: { joins } }),
    { from: 0, to: 25, complete: true },
    'the joined top is the higher of the two',
  );
  assert.equal(coverageAfterWalk(coverage, { reason: 'reached', walk: { joins: null } }), coverage);
  for (const reason of ['stalled', 'max', null]) {
    assert.equal(coverageAfterWalk(coverage, { reason, walk: { joins } }), coverage, String(reason));
  }
  assert.equal(coverageAfterWalk(null, { reason: 'exhausted', walk: { joins: null } }), null);
});

/**
 * An async pager over fixed pages that reports `reason` once it has yielded
 * them all.
 *
 * @param {Array<Array<Object>>} pages Pages to yield.
 * @param {?string} reason End reason, or null for none.
 * @returns {(until: number, onEnd: Function) => AsyncGenerator<Array<Object>>} The pager factory.
 */
function pagerOf(pages, reason) {
  return (until, onEnd) => (async function* fixedPages() {
    for (const page of pages) yield page;
    if (reason) onEnd(reason);
  })();
}

/**
 * Drain an async iterable, committing nothing.
 *
 * @param {AsyncIterable<*>} iterable Pages.
 * @returns {Promise<Array<*>>} What it yielded.
 */
async function drain(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('the tracker seeds only valid entries of tracked collections', () => {
  const tracker = createCoverageTracker();
  tracker.seed({ positions: { from: 0, to: 9, complete: true }, nodes: { from: 0, to: 9, complete: false }, encrypted: { from: 0, to: 9, complete: true } });
  assert.deepEqual(tracker.known('positions'), { from: 0, to: 9, complete: true });
  assert.equal(tracker.known('nodes'), null, 'an invalid entry is dropped');
  assert.equal(tracker.known('encrypted'), null, 'an untracked collection is ignored');
  tracker.seed(null);
  assert.equal(tracker.known('positions'), null, 'a later seed replaces the earlier one');
  tracker.seed('garbage');
  assert.equal(tracker.known('positions'), null);
});

test('the tracker plans with the stored entry only for a warm delta', () => {
  const tracker = createCoverageTracker();
  tracker.seed({ positions: { from: 0, to: 25, complete: true } });
  const page = { rows: rows(60, 50, 40).concat(rows(35)), cap: 3, since: 24 };
  assert.deepEqual(tracker.plan('positions', { ...page, warm: true }), { before: 35, until: 25, joins: { from: 0, to: 25, complete: true } });
  assert.deepEqual(tracker.walkOf('positions'), { before: 35, until: 25, joins: { from: 0, to: 25, complete: true } });
  assert.deepEqual(tracker.plan('positions', { ...page, warm: false }), { before: 35, until: 0, joins: null }, 'a cold page ignores the cache');
  assert.equal(tracker.plan('messages', { rows: [], cap: 3, since: 0, warm: true }), null);
  assert.equal(tracker.walkOf('messages'), null);
  assert.equal(tracker.walkOf('traces'), null, 'an unplanned collection has no walk');
  assert.deepEqual(tracker.snapshot(), {
    positions: { from: 35, to: 60, complete: false },
    messages: { from: 0, to: 0, complete: true },
  });
});

test('the tracker moves an entry on later refreshes and leaves unplanned collections alone', () => {
  const tracker = createCoverageTracker();
  tracker.plan('nodes', { rows: [{ last_heard: 30 }], cap: 3, since: 0, warm: false });
  tracker.refreshed('nodes', { rows: [{ last_heard: 50 }], cap: 3, since: 29 });
  tracker.refreshed('traces', { rows: rows(5), cap: 3, since: 0 });
  assert.deepEqual(tracker.snapshot(), { nodes: { from: 0, to: 50, complete: true } });
  tracker.plan('telemetry', { rows: [{}, {}, {}], cap: 3, since: 0, warm: false });
  tracker.refreshed('telemetry', { rows: rows(5), cap: 3, since: 0 });
  assert.deepEqual(Object.keys(tracker.snapshot()), ['nodes'], 'a collection without coverage is left out');
});

test('the planned walk\'s committed pages and its end move the entry', async () => {
  const tracker = createCoverageTracker();
  tracker.seed({ positions: { from: 0, to: 25, complete: true } });
  const walk = tracker.plan('positions', { rows: rows(60, 50, 40), cap: 3, since: 24, warm: true });
  const untils = [];
  const pages = tracker.pages('positions', walk.before, (until, onEnd) => {
    untils.push(until);
    return pagerOf([rows(40, 33, 30), rows(30, 22)], 'reached')(until, onEnd);
  });
  const seen = [];
  for await (const page of pages) {
    seen.push(page.length);
    if (seen.length === 1) {
      assert.deepEqual(tracker.snapshot().positions, { from: 40, to: 60, complete: false }, 'a page counts once committed');
    }
  }
  assert.deepEqual(untils, [25], 'the walk stops where the cached rows begin');
  assert.deepEqual(seen, [3, 2]);
  assert.deepEqual(tracker.snapshot().positions, { from: 0, to: 60, complete: true });
});

test('a walk that ends exhausted completes the entry', async () => {
  const tracker = createCoverageTracker();
  const walk = tracker.plan('messages', { rows: rows(60, 50, 40), cap: 3, since: 0, warm: false });
  await drain(tracker.pages('messages', walk.before, pagerOf([rows(40, 20)], 'exhausted')));
  assert.deepEqual(tracker.snapshot().messages, { from: 0, to: 60, complete: true });
});

test('a walk that fails or stalls keeps the entry at its last committed page', async () => {
  const tracker = createCoverageTracker();
  const walk = tracker.plan('traces', { rows: rows(60, 50, 40), cap: 3, since: 0, warm: false });
  const failing = () => (async function* failingPages() {
    yield rows(40, 35);
    throw new Error('page failed');
  })();
  await assert.rejects(() => drain(tracker.pages('traces', walk.before, failing)), /page failed/);
  assert.deepEqual(tracker.snapshot().traces, { from: 35, to: 60, complete: false });
  await drain(tracker.pages('traces', walk.before, pagerOf([rows(35, 30)], 'stalled')));
  assert.deepEqual(tracker.snapshot().traces, { from: 30, to: 60, complete: false });
});

test('a page the caller fails to commit does not count', async () => {
  const tracker = createCoverageTracker();
  const walk = tracker.plan('neighbors', { rows: rows(60, 50, 40), cap: 3, since: 0, warm: false });
  await assert.rejects(async () => {
    // eslint-disable-next-line no-unused-vars
    for await (const _ of tracker.pages('neighbors', walk.before, pagerOf([rows(40, 20)], 'exhausted'))) {
      throw new Error('commit failed');
    }
  }, /commit failed/);
  assert.deepEqual(tracker.snapshot().neighbors, { from: 40, to: 60, complete: false });
});

test('a walk the plan did not start moves nothing and walks to the end', async () => {
  const tracker = createCoverageTracker();
  const walk = tracker.plan('waypoints', { rows: rows(60, 50, 40), cap: 3, since: 0, warm: false });
  const untils = [];
  await drain(tracker.pages('waypoints', walk.before + 5, (until, onEnd) => {
    untils.push(until);
    return pagerOf([rows(20)], 'exhausted')(until, onEnd);
  }));
  await drain(tracker.pages('nodes', 99, pagerOf([[{ last_heard: 3 }]], 'exhausted')));
  assert.deepEqual(untils, [0]);
  assert.deepEqual(tracker.snapshot(), { waypoints: { from: 40, to: 60, complete: false } });
});

test('the snapshot is a copy', () => {
  const tracker = createCoverageTracker();
  tracker.plan('nodes', { rows: [{ last_heard: 30 }], cap: 3, since: 0, warm: false });
  tracker.snapshot().nodes.to = 999;
  assert.equal(tracker.snapshot().nodes.to, 30);
});

test('a horizon from the same refresh raises the top the page vouches for', () => {
  // The chat's encrypted page shares its `since`: the plaintext page is
  // complete up to that page's newest row as well.
  assert.deepEqual(plan({ rows: rows(30, 20), horizon: 45 }), { coverage: { from: 0, to: 45, complete: true }, walk: null });
  assert.deepEqual(plan({ rows: rows(30, 20, 10), horizon: 45 }).coverage, { from: 10, to: 45, complete: false });
  const known = { from: 0, to: 45, complete: true };
  assert.deepEqual(plan({ rows: [], since: 44, known }), { coverage: { from: 0, to: 45, complete: true }, walk: null },
    'a since lifted by the horizon still joins the cached top');
  const coverage = { from: 12, to: 25, complete: false };
  assert.deepEqual(coverageAfterRefresh(coverage, { rows: rows(30), cap: 3, since: 24, field: 'rx_time', horizon: 50 }),
    { from: 12, to: 50, complete: false });
  assert.equal(coverageAfterRefresh(coverage, { rows: rows(60, 50, 40), cap: 3, since: 24, field: 'rx_time', horizon: 70 }), coverage,
    'a full page still leaves the entry');
});

test('the tracker passes the horizon to the plan and to later refreshes', () => {
  const tracker = createCoverageTracker();
  tracker.plan('messages', { rows: rows(30), cap: 3, since: 0, warm: false, horizon: 40 });
  tracker.refreshed('messages', { rows: rows(41), cap: 3, since: 39, horizon: 55 });
  assert.deepEqual(tracker.snapshot().messages, { from: 0, to: 55, complete: true });
});
