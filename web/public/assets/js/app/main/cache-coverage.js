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
 * Cache coverage: which window of each collection the cache holds in full
 * (SPEC CC2, CC3).
 *
 * Every collection pages newest first by its sort column (SPEC BP1), and a
 * page holds at most the route's cap. A short page reaches its floor; a full
 * one may stop short of it, so the rows below it must be paged in with
 * `before=` (#832). A **coverage** entry records the window a collection's
 * rows hold without a gap: every row whose sort value `c` has
 * `from < c <= to`, and, when `complete`, every row of the server's window up
 * to `to`. A backward walk resumes at `before = from` (inclusive).
 *
 * The first refresh of a page open plans each collection's walk from its page
 * and the coverage the cache recorded ({@link planCoverage}): a cold page
 * that came back full walks to the window's end; a warm delta page that came
 * back full walks the gap down to the cached rows, asking only for rows at
 * or above the newest cached one (`since=`, SPEC BP2); a cache whose coverage
 * stops short of the window walks on below its rows; a cache without a
 * coverage entry is walked once. Later refreshes and the walk's pages move
 * the entry ({@link coverageAfterRefresh}, {@link coverageAfterWalkPage},
 * {@link coverageAfterWalk}), and the cache write-back stores it with the
 * rows, so the next load knows what the cache holds.
 *
 * Pure functions plus one stateful tracker; no DOM, network or storage.
 *
 * @module main/cache-coverage
 */

import { maxRecordTimestamp, minRecordTimestamp } from '../incremental-helpers.js';

/**
 * The collections whose coverage is tracked: the ones the dashboard pages
 * backward (SPEC BP1; the chat, #802; the bulk collections, #832).
 *
 * @type {ReadonlyArray<string>}
 */
export const COVERAGE_COLLECTIONS = Object.freeze([
  'nodes',
  'messages',
  'positions',
  'telemetry',
  'neighbors',
  'traces',
  'waypoints',
]);

/**
 * The sort column of each collection's route (`ORDER BY ... DESC`), which the
 * `since` and `before` cursors bound.
 *
 * @type {Readonly<Object<string, string>>}
 */
export const COVERAGE_CURSOR_FIELDS = Object.freeze({
  nodes: 'last_heard',
  messages: 'rx_time',
  positions: 'rx_time',
  telemetry: 'rx_time',
  neighbors: 'rx_time',
  traces: 'rx_time',
  waypoints: 'rx_time',
});

/**
 * @typedef {Object} Coverage
 * @property {number} from Lower bound, exclusive: every row above it, up to
 *   `to`, is held; a walk resumes at `before = from`. 0 when `complete`.
 * @property {number} to Upper bound, inclusive: the newest sort value held.
 * @property {boolean} complete Whether nothing older is in the server's window.
 */

/**
 * @typedef {Object} WalkPlan
 * @property {number} before Inclusive cursor the walk starts at.
 * @property {number} until Stop cursor and lower bound: the walk asks only
 *   for rows at or above it and ends once a page reaches it, where the cached
 *   rows begin; 0 walks to the end of the window.
 * @property {?Coverage} joins The cached coverage the walk reaches at
 *   `until`, or null when it walks to the end.
 */

/**
 * Whether `value` is a finite number at or above `min`.
 *
 * @param {*} value Candidate.
 * @param {number} min Lower bound.
 * @returns {boolean}
 */
const atLeast = (value, min) => typeof value === 'number' && Number.isFinite(value) && value >= min;

/**
 * Validate a stored coverage entry. A complete entry needs `to >= 0`; an
 * incomplete one needs `0 < from <= to`, so a walk can resume at `from`.
 *
 * @param {*} value Candidate entry, as read from the cache.
 * @returns {?Coverage} A fresh, valid entry, or null when `value` is not one.
 */
export function normaliseCoverage(value) {
  if (!value || typeof value !== 'object' || typeof value.complete !== 'boolean') return null;
  const { from, to, complete } = value;
  if (!atLeast(to, 0) || !atLeast(from, 0) || from > to) return null;
  if (complete) return { from: 0, to, complete: true };
  return from > 0 ? { from, to, complete: false } : null;
}

/**
 * Plan one collection's backward walk from the first refresh's page.
 *
 * @param {{ rows: Array<Object>, cap: number, since: number, field: string, known: ?Coverage, horizon?: number }} page
 *   The page's rows, the route's row cap, the `since` it was asked with (0
 *   for a newest page), the sort column, the coverage the cache recorded
 *   for the rows this refresh merged into (null on a cold load or a cache
 *   without an entry), and an optional horizon: the newest sort value of
 *   another page this refresh read from the same route with the same `since`
 *   (the chat's encrypted page), up to which this page is complete as well.
 * @returns {{ coverage: ?Coverage, walk: ?WalkPlan }} The collection's
 *   coverage once the page is merged, and the walk to run, or null when the
 *   rows already hold the window. A full page whose rows carry no sort value
 *   cannot be walked: coverage and walk are then null.
 */
export function planCoverage({ rows, cap, since, field, known, horizon = 0 }) {
  const list = Array.isArray(rows) ? rows : [];
  const newest = Math.max(maxRecordTimestamp(list, [field]), horizon);
  const oldest = minRecordTimestamp(list, [field]);
  const full = list.length >= cap;
  // A short newest page is the whole window.
  if (!full && !(since > 0)) return { coverage: { from: 0, to: newest, complete: true }, walk: null };
  // The page reaches into the cached rows: a short page holds every row from
  // `since` up, a full one every row above its oldest.
  const joined = known && (full ? oldest > 0 && oldest <= known.to : since <= known.to + 1);
  if (joined) {
    const coverage = { from: known.from, to: Math.max(newest, known.to), complete: known.complete };
    return { coverage, walk: known.complete ? null : { before: known.from, until: 0, joins: null } };
  }
  // A gap below the page, or rows nobody vouched for: walk from the page's
  // oldest row (from `since` when it is empty), down to complete cached rows
  // or to the window's end.
  const before = oldest > 0 ? oldest : since - 1;
  if (full && !(oldest > 0)) return { coverage: null, walk: null };
  if (!(before > 0)) return { coverage: { from: 0, to: newest, complete: true }, walk: null };
  const joins = known && known.complete ? known : null;
  return {
    coverage: { from: before, to: Math.max(newest, before), complete: false },
    walk: { before, until: joins ? joins.to : 0, joins },
  };
}

/**
 * Move a coverage entry after a later refresh merged its page. A short delta
 * page that reaches `to` extends `to`; a short newest page (`since` 0, a late
 * first refresh) is the whole window. A full page may leave a gap above `to`,
 * so the entry stays as it is: the next load walks that gap.
 *
 * @param {?Coverage} coverage The entry before the refresh.
 * @param {{ rows: Array<Object>, cap: number, since: number, field: string, horizon?: number }} page
 *   The refresh's page and its horizon ({@link planCoverage}).
 * @returns {?Coverage} The entry after it.
 */
export function coverageAfterRefresh(coverage, { rows, cap, since, field, horizon = 0 }) {
  if (!coverage) return coverage;
  const list = Array.isArray(rows) ? rows : [];
  if (list.length >= cap) return coverage;
  const newest = Math.max(coverage.to, maxRecordTimestamp(list, [field]), horizon);
  if (!(since > 0)) return { from: 0, to: newest, complete: true };
  return since <= coverage.to + 1 ? { ...coverage, to: newest } : coverage;
}

/**
 * Move a coverage entry after a walk committed one page: the rows above the
 * page's oldest row are now held.
 *
 * @param {?Coverage} coverage The entry before the page.
 * @param {{ rows: Array<Object>, field: string }} page The committed rows.
 * @returns {?Coverage} The entry after it.
 */
export function coverageAfterWalkPage(coverage, { rows, field }) {
  if (!coverage || coverage.complete) return coverage;
  const oldest = minRecordTimestamp(rows, [field]);
  return oldest > 0 && oldest < coverage.from ? { ...coverage, from: oldest } : coverage;
}

/**
 * Close a coverage entry when its walk ends. `'exhausted'` (a short or empty
 * page: the window has no older row) completes it; `'reached'` (a page at or
 * below the plan's `until`) joins it with the cached coverage it reached; any
 * other end (a walk that stalled, hit its page limit or failed) leaves it as
 * the committed pages moved it.
 *
 * @param {?Coverage} coverage The entry before the end.
 * @param {{ reason: ?string, walk: WalkPlan }} end Why the walk ended and its plan.
 * @returns {?Coverage} The entry after it.
 */
export function coverageAfterWalk(coverage, { reason, walk }) {
  if (!coverage) return coverage;
  if (reason === 'exhausted') return { from: 0, to: coverage.to, complete: true };
  if (reason === 'reached' && walk.joins) {
    return { from: walk.joins.from, to: Math.max(coverage.to, walk.joins.to), complete: walk.joins.complete };
  }
  return coverage;
}

/**
 * Create the page's coverage tracker: the coverage the cache recorded, the
 * coverage of the rows in memory, and the planned walks.
 *
 * @returns {{
 *   seed: (marker: *) => void,
 *   known: (name: string) => ?Coverage,
 *   plan: (name: string, page: { rows: Array<Object>, cap: number, since: number, warm: boolean, horizon?: number }) => ?WalkPlan,
 *   refreshed: (name: string, page: { rows: Array<Object>, cap: number, since: number, horizon?: number }) => void,
 *   walkOf: (name: string) => ?WalkPlan,
 *   pages: (name: string, before: number, open: (until: number, onEnd: (reason: string) => void) => AsyncIterable<Array<Object>>) => AsyncGenerator<Array<Object>>,
 *   snapshot: () => Object<string, Coverage>,
 * }} The tracker. `seed` takes the stored marker (entries are validated,
 *   unknown collections ignored); `plan` plans a collection from the first
 *   refresh's page, using the stored entry only for a warm delta (`warm`);
 *   `refreshed` moves an entry after a later refresh; `pages` wraps a walk's
 *   pager so the committed pages and the walk's end move the entry; and
 *   `snapshot` is the marker the cache write-back stores.
 */
export function createCoverageTracker() {
  /** @type {Map<string, Coverage>} What the cache recorded at the seed. */
  const stored = new Map();
  /** @type {Map<string, ?Coverage>} The coverage of the rows in memory. */
  const current = new Map();
  /** @type {Map<string, ?WalkPlan>} The planned walks. */
  const walks = new Map();

  /**
   * Run `next` over a collection's current entry and keep what it returns.
   *
   * @param {string} name Collection name.
   * @param {(coverage: ?Coverage) => ?Coverage} next The move.
   * @returns {void}
   */
  function move(name, next) {
    if (current.has(name)) current.set(name, next(current.get(name)));
  }

  return {
    /**
     * Take the coverage marker the cache stored; only valid entries of the
     * tracked collections are kept.
     *
     * @param {*} marker The stored marker, or null.
     * @returns {void}
     */
    seed(marker) {
      stored.clear();
      for (const name of COVERAGE_COLLECTIONS) {
        const entry = normaliseCoverage(marker && typeof marker === 'object' ? marker[name] : null);
        if (entry) stored.set(name, entry);
      }
    },

    /**
     * @param {string} name Collection name.
     * @returns {?Coverage} The entry the cache stored for it, or null.
     */
    known: name => stored.get(name) || null,

    /**
     * Plan a collection's walk from the first refresh's page ({@link planCoverage})
     * and take the coverage it yields; the stored entry counts only for a warm
     * delta, merged into the seeded rows.
     *
     * @param {string} name Collection name.
     * @param {{ rows: Array<Object>, cap: number, since: number, warm: boolean, horizon?: number }} page The page.
     * @returns {?WalkPlan} The walk to run, or null.
     */
    plan(name, { rows, cap, since, warm, horizon }) {
      const field = COVERAGE_CURSOR_FIELDS[name];
      const known = warm ? stored.get(name) || null : null;
      const { coverage, walk } = planCoverage({ rows, cap, since, field, known, horizon });
      current.set(name, coverage);
      walks.set(name, walk);
      return walk;
    },

    /**
     * Move a planned collection's entry after a later refresh merged its page
     * ({@link coverageAfterRefresh}); an unplanned collection is left alone.
     *
     * @param {string} name Collection name.
     * @param {{ rows: Array<Object>, cap: number, since: number, horizon?: number }} page The page.
     * @returns {void}
     */
    refreshed(name, { rows, cap, since, horizon }) {
      move(name, coverage => coverageAfterRefresh(coverage, { rows, cap, since, horizon, field: COVERAGE_CURSOR_FIELDS[name] }));
    },

    /**
     * @param {string} name Collection name.
     * @returns {?WalkPlan} The planned walk, or null.
     */
    walkOf: name => walks.get(name) || null,

    /**
     * Wrap a walk's pager: `open(until, onEnd)` builds it, with the plan's
     * stop cursor when the walk is the planned one (it starts at the plan's
     * `before`), else 0. Each page counts once the caller has committed it,
     * and the walk's end moves the entry ({@link coverageAfterWalk}).
     *
     * @param {string} name Collection name.
     * @param {number} before The cursor the walk starts at.
     * @param {(until: number, onEnd: (reason: string) => void) => AsyncIterable<Array<Object>>} open
     *   Builds the pager.
     * @returns {AsyncGenerator<Array<Object>>} The pager's pages.
     */
    pages(name, before, open) {
      const walk = walks.get(name) || null;
      // Only the planned walk moves the entry: it starts where the rows held
      // end, so its pages extend them without a gap.
      const tracked = Boolean(walk) && walk.before === before;
      let reason = null;
      const inner = open(tracked ? walk.until : 0, end => {
        reason = end;
      });
      const field = COVERAGE_CURSOR_FIELDS[name];
      return (async function* trackWalk() {
        try {
          for await (const batch of inner) {
            yield batch;
            // The caller committed the page before asking for the next one.
            if (tracked) move(name, coverage => coverageAfterWalkPage(coverage, { rows: batch, field }));
          }
        } finally {
          // A walk that failed, or whose caller stopped it, has no reason.
          if (tracked) move(name, coverage => coverageAfterWalk(coverage, { reason, walk }));
        }
      })();
    },

    /**
     * @returns {Object<string, Coverage>} A copy of every known entry, the
     *   marker the cache write-back stores.
     */
    snapshot() {
      const marker = {};
      for (const [name, coverage] of current) {
        if (coverage) marker[name] = { ...coverage };
      }
      return marker;
    },
  };
}
