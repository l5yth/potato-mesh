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
 * Decide which dashboard surfaces a refresh repaints (SPEC DR4).
 *
 * Every refresh path (an SSE ping, the reconnect resync, the safety poll, the
 * cache seed, a backfill flush, a destinations page) merges rows into the
 * dashboard state and then repaints. Before DR4 that repaint rebuilt the nodes
 * table, the map and the chat whatever had changed, so a `messages` ping also
 * replaced every table row and every map layer. The planner records which
 * collections actually changed and maps them onto the surfaces that render
 * them ({@link SURFACE_INPUTS}): a `messages` ping that changes no node,
 * position or neighbour data repaints the chat alone, and a refresh that
 * changes nothing repaints nothing.
 *
 * Changes are found by comparing rows, not by trusting which collection a
 * refresh fetched: a delta fetch re-sends the rows of its one-second overlap,
 * and a `messages` ingest always publishes `nodes` as well, so "fetched" is
 * not "changed". User actions (filter, sort, role and protocol toggles, the
 * identity caret) change what every surface shows and mark all of them.
 *
 * The map and the chat also render the clock. On the map a marker's freshness
 * bucket (SPEC UX5/PD3) and a waypoint's expiry step (SPEC W6) change without
 * any data changing; in the chat an entry leaves the 7-day window and a
 * waypoint Log entry counts down to its expiry. {@link nextMapRepaintAt} and
 * {@link nextChatRepaintAt} give the first such moment after a render, and the
 * planner repaints that surface on the first refresh past it.
 *
 * @module main/repaint-planner
 */

import { AGE_BUCKET_LIVE_MAX_SECONDS, AGE_BUCKET_TODAY_MAX_SECONDS } from './age-bucket.js';
import { waypointKey } from './waypoint-layer.js';
import { resolveTimestampSeconds } from '../chat-log-tabs.js';
import { toFiniteNumber } from './format-utils.js';

/** The surfaces a refresh can repaint, in paint order. */
export const REPAINT_SURFACES = Object.freeze(['table', 'map', 'chat']);

/**
 * Collections each surface renders. `nodes` is the derived node record set
 * (nodes with their latest position and telemetry merged in), so a position or
 * telemetry row reaches the table and the map only when it changes a record;
 * the raw `positions` and `telemetry` rows feed the chat's Log tab. The table
 * also renders the Reticulum destinations (identity groups, SPEC RA1); the map
 * draws neighbour and trace lines and waypoint pins; the chat shows messages,
 * encrypted notices and a Log entry per packet of every other collection.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const SURFACE_INPUTS = Object.freeze({
  table: Object.freeze(['nodes', 'destinations']),
  map: Object.freeze(['nodes', 'neighbors', 'traces', 'waypoints']),
  chat: Object.freeze(['nodes', 'messages', 'encrypted', 'positions', 'telemetry', 'neighbors', 'traces', 'waypoints']),
});

/**
 * Row identity per collection: the key each collection merges on.
 *
 * @type {Readonly<Record<string, Function>>}
 */
const COLLECTION_KEYS = Object.freeze({
  nodes: row => row && row.node_id,
  positions: row => row && row.id,
  telemetry: row => row && row.id,
  neighbors: row => row && `${row.node_id}|${row.neighbor_id}`,
  traces: row => row && row.id,
  waypoints: row => waypointKey(row),
  messages: row => row && row.id,
  encrypted: row => row && row.id,
});

/**
 * A waypoint's opacity drops to 0.7 inside its last day and to 0.4 inside its
 * last hour (`waypointExpiryOpacity`); it leaves the map at `expire`.
 */
const WAYPOINT_EXPIRY_STEPS_SECONDS = Object.freeze([24 * 3600, 3600]);

/**
 * How far past a strict boundary (one that applies once it has passed) a
 * clock step is scheduled: a millisecond, the resolution of ``Date.now()``.
 */
const STEP_EPSILON_SECONDS = 0.001;

/**
 * Compare two values field by field: primitives with ``===`` (and ``NaN``
 * equal to itself), arrays element-wise, plain objects over their own
 * enumerable keys. Non-enumerable bookkeeping such as the snapshot history the
 * aggregator attaches is ignored, as it is never rendered.
 *
 * @param {*} a First value.
 * @param {*} b Second value.
 * @returns {boolean} Whether the two hold the same data.
 */
export function recordsEqual(a, b) {
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => recordsEqual(value, b[index]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && recordsEqual(a[key], b[key]));
}

/**
 * Whether a collection's rows changed between two snapshots: a row added,
 * removed (a window trim) or carrying different data. Rows the merge kept are
 * the same objects and cost one identity check.
 *
 * @param {?Array<Object>} before Rows before the merge.
 * @param {?Array<Object>} after Rows after the merge.
 * @param {Function} keyOf Row to merge key.
 * @returns {boolean} ``true`` when anything a surface could render differs.
 */
export function keyedRowsChanged(before, after, keyOf) {
  if (before === after) return false;
  const previous = Array.isArray(before) ? before : [];
  const next = Array.isArray(after) ? after : [];
  if (previous.length !== next.length) return true;
  // The merges keep surviving rows in place, so compare position by position
  // first; only rows that moved need the keyed lookup below.
  let aligned = true;
  for (let index = 0; index < next.length; index += 1) {
    const old = previous[index];
    const row = next[index];
    if (old === row) continue;
    if (keyOf(old) !== keyOf(row)) {
      aligned = false;
      break;
    }
    if (!recordsEqual(old, row)) return true;
  }
  if (aligned) return false;
  const byKey = new Map();
  for (const row of previous) byKey.set(keyOf(row), row);
  for (const row of next) {
    const key = keyOf(row);
    if (!byKey.has(key)) return true;
    const old = byKey.get(key);
    if (old !== row && !recordsEqual(old, row)) return true;
  }
  return false;
}

/**
 * The surfaces that render any of ``collections``.
 *
 * @param {Iterable<string>} collections Changed collection names.
 * @returns {Set<string>} Surfaces to repaint, from {@link REPAINT_SURFACES}.
 */
export function surfacesForCollections(collections) {
  const changed = new Set(collections);
  const surfaces = new Set();
  for (const surface of REPAINT_SURFACES) {
    if (SURFACE_INPUTS[surface].some(collection => changed.has(collection))) surfaces.add(surface);
  }
  return surfaces;
}

/**
 * First moment after ``nowSec`` at which the map drawn at ``nowSec`` goes
 * stale without any data changing: a marker crossing a freshness bucket (3 h,
 * 24 h after it was last heard; SPEC UX5/PD3), or a waypoint stepping down its
 * expiry ladder or expiring (SPEC W6).
 *
 * @param {?Array<Object>} nodes Node records the map drew.
 * @param {?Array<Object>} waypoints Waypoint rows the map was given.
 * @param {number} nowSec Render time, unix seconds.
 * @returns {number} Unix seconds of the next clock-driven change, or
 *   ``Infinity`` when nothing on the map ages.
 */
export function nextMapRepaintAt(nodes, waypoints, nowSec) {
  const moments = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const heard = Number(node && node.last_heard);
    // An unknown age reads as stale for good (nodeAgeBucket); it never moves.
    if (!heard || !Number.isFinite(heard)) continue;
    moments.push(heard + AGE_BUCKET_LIVE_MAX_SECONDS, heard + AGE_BUCKET_TODAY_MAX_SECONDS);
  }
  for (const waypoint of Array.isArray(waypoints) ? waypoints : []) {
    const expire = Number(waypoint && waypoint.expire);
    if (!expire || !Number.isFinite(expire) || expire <= 0) continue;
    // A dim step applies as soon as its boundary passes (strictly after it),
    // so repaint a millisecond in; expiry itself is inclusive
    // (isWaypointExpired).
    for (const step of WAYPOINT_EXPIRY_STEPS_SECONDS) moments.push(expire - step + STEP_EPSILON_SECONDS);
    moments.push(expire);
  }
  let next = Infinity;
  for (const at of moments) {
    if (at > nowSec && at < next) next = at;
  }
  return next;
}

/**
 * The per-packet snapshots the chat model walks for one row: the aggregator's
 * hidden ``snapshots`` history when present, otherwise the row itself. Mirrors
 * ``resolveSnapshotList`` in ``chat-log-tabs.js``.
 *
 * @param {Object} row Collection row ({@link nextChatRepaintAt} skips non-objects).
 * @returns {Array<Object>} Snapshots to read timestamps from.
 */
function chatSnapshots(row) {
  const { snapshots } = row;
  const list = Array.isArray(snapshots) && snapshots.length > 0 ? snapshots : [row];
  // The model skips an empty snapshot (``if (!snapshot) continue``).
  return list.filter(Boolean);
}

/**
 * Timestamps the chat renders an entry at, per source, with the field
 * precedence ``buildChatTabModel`` uses: a node yields its first-heard
 * ("new node") and last-heard ("node info") entries; telemetry,
 * positions and neighbours one entry per snapshot; waypoints, traces and
 * messages one entry per row; the encrypted list only its encrypted rows.
 *
 * @type {Readonly<Record<string, (row: Object) => Array<?number>>>}
 */
const CHAT_ENTRY_TIMESTAMPS = Object.freeze({
  nodes: node => [
    resolveTimestampSeconds(node.first_heard ?? node.firstHeard, node.first_heard_iso ?? node.firstHeardIso),
    resolveTimestampSeconds(node.last_heard ?? node.lastHeard, node.last_seen_iso ?? node.lastSeenIso),
  ],
  telemetry: row => chatSnapshots(row).map(snapshot => resolveTimestampSeconds(
    snapshot.rx_time ?? snapshot.rxTime ?? snapshot.telemetry_time ?? snapshot.telemetryTime,
    snapshot.rx_iso ?? snapshot.rxIso ?? snapshot.telemetry_time_iso ?? snapshot.telemetryTimeIso,
  )),
  positions: row => chatSnapshots(row).map(snapshot => resolveTimestampSeconds(
    snapshot.rx_time ?? snapshot.rxTime ?? snapshot.position_time ?? snapshot.positionTime,
    snapshot.rx_iso ?? snapshot.rxIso ?? snapshot.position_time_iso ?? snapshot.positionTimeIso,
  )),
  neighbors: row => chatSnapshots(row).map(snapshot => resolveTimestampSeconds(
    snapshot.rx_time ?? snapshot.rxTime,
    snapshot.rx_iso ?? snapshot.rxIso,
  )),
  waypoints: row => [resolveTimestampSeconds(row.rx_time ?? row.rxTime, row.rx_iso ?? row.rxIso)],
  traces: row => [resolveTimestampSeconds(row.rx_time ?? row.rxTime, row.rx_iso ?? row.rxIso)],
  messages: row => [resolveTimestampSeconds(row.rx_time ?? row.rxTime, row.rx_iso ?? row.rxIso)],
  encrypted: row => (row.encrypted
    ? [resolveTimestampSeconds(row.rx_time ?? row.rxTime, row.rx_iso ?? row.rxIso)]
    : []),
});

/**
 * First moment after ``nowSec`` at which a waypoint Log entry's
 * "Expires: <remaining>" text changes. The Log shows ``timeHum`` of the whole
 * seconds left, or "expired": hours while a day or more remains, minutes
 * while an hour or more remains, seconds in the last hour.
 *
 * @param {*} expire Raw ``expire`` unix timestamp (absent or 0: never).
 * @param {number} nowSec Render time, unix seconds.
 * @returns {number} Unix seconds of the next text change, or ``Infinity``
 *   for "never" and "expired", which do not change.
 */
export function nextExpiryTextChangeAt(expire, nowSec) {
  const at = toFiniteNumber(expire);
  if (at == null || at <= 0) return Infinity;
  const remaining = Math.floor(at - nowSec);
  if (remaining <= 0) return Infinity;
  let unit = 3600;
  if (remaining < 3600) unit = 1;
  else if (remaining < 86400) unit = 60;
  // The text changes once fewer whole seconds remain than its shown amount,
  // that is as soon as the boundary passes; repaint a millisecond after it,
  // as for the map's dim steps. The next boundary is never earlier than the
  // paint, so the schedule cannot loop.
  return at - Math.floor(remaining / unit) * unit + STEP_EPSILON_SECONDS;
}

/**
 * First moment after ``nowSec`` at which the chat painted at ``nowSec`` goes
 * stale without any data changing: an entry leaving the window (the chat
 * keeps entries no older than ``windowSeconds``, counted in whole seconds),
 * or a waypoint Log entry's expiry text changing.
 *
 * @param {Object<string, ?Array<Object>>} sources Chat inputs by collection:
 *   ``nodes``, ``telemetry``, ``positions``, ``neighbors``, ``waypoints``,
 *   ``traces``, ``messages`` and ``encrypted``.
 * @param {number} nowSec Time the paint started, unix seconds.
 * @param {number} windowSeconds The chat's window (7 days).
 * @returns {number} Unix seconds of the next clock-driven change, or
 *   ``Infinity`` when nothing in the chat ages.
 */
export function nextChatRepaintAt(sources, nowSec, windowSeconds) {
  const moments = [];
  for (const [collection, timestampsOf] of Object.entries(CHAT_ENTRY_TIMESTAMPS)) {
    const rows = sources && Array.isArray(sources[collection]) ? sources[collection] : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const ts of timestampsOf(row)) {
        if (ts == null) continue;
        // The model keeps ts >= floor(now) - window, so the entry leaves the
        // first whole second past ts + window.
        const leavesAt = Math.floor(ts + windowSeconds) + 1;
        moments.push(leavesAt);
        if (collection === 'waypoints' && leavesAt > nowSec) {
          moments.push(nextExpiryTextChangeAt(row.expire, nowSec));
        }
      }
    }
  }
  let next = Infinity;
  for (const at of moments) {
    if (at > nowSec && at < next) next = at;
  }
  return next;
}

/**
 * Create the planner one dashboard instance uses.
 *
 * Every surface starts dirty, so the first repaint paints all of them.
 *
 * @returns {{
 *   markCollections: (collections: Iterable<string>) => void,
 *   markAllSurfaces: () => void,
 *   noteRows: (collection: string, before: ?Array<Object>, after: ?Array<Object>) => boolean,
 *   noteCollections: (before: Object<string, ?Array<Object>>, after: Object<string, ?Array<Object>>) => void,
 *   expireAt: (surface: string, at: number) => void,
 *   take: (nowSec: number) => Set<string>,
 *   pending: () => Set<string>,
 *   renderCounts: () => { table: number, map: number, chat: number },
 * }} Planner handle.
 */
export function createRepaintPlanner() {
  const dirty = new Set(REPAINT_SURFACES);
  const expiries = new Map();
  const counts = { table: 0, map: 0, chat: 0 };

  /**
   * Mark every surface that renders one of ``collections``.
   *
   * @param {Iterable<string>} collections Changed collection names.
   * @returns {void}
   */
  function markCollections(collections) {
    for (const surface of surfacesForCollections(collections)) dirty.add(surface);
  }

  /**
   * Mark every surface, for a user action that changes what each one shows.
   *
   * @returns {void}
   */
  function markAllSurfaces() {
    for (const surface of REPAINT_SURFACES) dirty.add(surface);
  }

  /**
   * Compare one collection's rows and mark its surfaces when they changed.
   *
   * @param {string} collection Collection name (a {@link COLLECTION_KEYS} key).
   * @param {?Array<Object>} before Rows before the merge.
   * @param {?Array<Object>} after Rows after the merge.
   * @returns {boolean} Whether the collection changed.
   */
  function noteRows(collection, before, after) {
    const changed = keyedRowsChanged(before, after, COLLECTION_KEYS[collection]);
    if (changed) markCollections([collection]);
    return changed;
  }

  /**
   * {@link noteRows} for each collection named in ``after``.
   *
   * @param {Object<string, ?Array<Object>>} before Collection name to rows before.
   * @param {Object<string, ?Array<Object>>} after Collection name to rows after.
   * @returns {void}
   */
  function noteCollections(before, after) {
    for (const collection of Object.keys(after)) noteRows(collection, before[collection], after[collection]);
  }

  /**
   * Repaint ``surface`` on the first {@link take} at or after ``at``.
   *
   * @param {string} surface Surface name.
   * @param {number} at Unix seconds; ``Infinity`` clears the schedule.
   * @returns {void}
   */
  function expireAt(surface, at) {
    if (Number.isFinite(at)) expiries.set(surface, at);
    else expiries.delete(surface);
  }

  /**
   * Hand out the surfaces due for a repaint and clear them. The caller must
   * repaint every surface returned; each is counted as repainted.
   *
   * @param {number} nowSec Current time, unix seconds.
   * @returns {Set<string>} Surfaces to repaint, in paint order.
   */
  function take(nowSec) {
    const due = new Set();
    for (const surface of REPAINT_SURFACES) {
      const expiry = expiries.get(surface);
      if (dirty.has(surface) || (expiry !== undefined && nowSec >= expiry)) due.add(surface);
    }
    for (const surface of due) {
      dirty.delete(surface);
      expiries.delete(surface);
      counts[surface] += 1;
    }
    return due;
  }

  /**
   * The surfaces currently marked for a repaint (diagnostics and tests).
   *
   * @returns {Set<string>} A copy of the marked set.
   */
  function pending() {
    return new Set(dirty);
  }

  /**
   * How many repaints {@link take} has handed out per surface (the DR4
   * instrumentation tests assert on).
   *
   * @returns {{ table: number, map: number, chat: number }} A copy of the counts.
   */
  function renderCounts() {
    return { ...counts };
  }

  return {
    markCollections,
    markAllSurfaces,
    noteRows,
    noteCollections,
    expireAt,
    take,
    pending,
    renderCounts,
  };
}
