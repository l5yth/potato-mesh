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
 * Two-tier cache lifetime policy (SPEC FC3, FC5).
 *
 * The cache distinguishes **staleness** from **eviction**:
 *
 *  - *Staleness* — "is our cached copy out of date, so prefer a fresh fetch?" —
 *    is measured from when the entry was cached (`cachedAt`). Nodes go stale
 *    after 24 h because their metadata mutates; observational rows after 7 d
 *    (or 28 d for traces/neighbors).
 *  - *Eviction* — "is the underlying row outside the server's visibility window,
 *    so delete it?" — is measured from the record's own domain timestamp
 *    (`last_heard` / `rx_time`). Windows: nodes & messages & positions &
 *    telemetry 7 d; traces & neighbors 28 d. Because the minimum window is 7 d,
 *    nothing whose event is younger than 7 days is ever evicted — so an inactive
 *    node stays cached and displayed (stale yet retained) instead of vanishing
 *    at its 24 h staleness.
 *
 * All times are unix **seconds** (matching the API's timestamp fields and the
 * cache's `cachedAt` stamp).
 *
 * @module main/cache-lifetime
 */

/** Seconds in one day. */
const DAY = 24 * 60 * 60;
/** Seven-day window (matches the server's bulk visibility floor). */
const WEEK = 7 * DAY;
/** Twenty-eight-day window (matches `four_weeks_seconds` / trace max age). */
const FOUR_WEEKS = 28 * DAY;

/**
 * Per-collection **staleness** TTL in seconds (how long a cached copy is trusted
 * before a fresh fetch is preferred). Unlisted collections use {@link DEFAULT_TTL}.
 *
 * @type {Readonly<Object<string, number>>}
 */
export const CACHE_STALENESS_SECONDS = Object.freeze({
  nodes: DAY,
  messages: WEEK,
  encrypted: WEEK,
  positions: WEEK,
  telemetry: WEEK,
  neighbors: FOUR_WEEKS,
  traces: FOUR_WEEKS,
});

/**
 * Per-collection **eviction** (retention) window in seconds (how old a row's event
 * may be before it is deleted). Unlisted collections use {@link DEFAULT_TTL}.
 *
 * @type {Readonly<Object<string, number>>}
 */
export const CACHE_RETENTION_SECONDS = Object.freeze({
  nodes: WEEK,
  messages: WEEK,
  encrypted: WEEK,
  positions: WEEK,
  telemetry: WEEK,
  neighbors: FOUR_WEEKS,
  traces: FOUR_WEEKS,
});

/** Fallback TTL/retention for an unrecognised collection (the 7-day floor). */
const DEFAULT_TTL = WEEK;

/**
 * Domain-timestamp field candidates per collection (snake_case and camelCase),
 * tried in order. The first finite, positive value wins.
 *
 * @type {Readonly<Object<string, ReadonlyArray<string>>>}
 */
const TIMESTAMP_FIELDS = Object.freeze({
  nodes: ['last_heard', 'lastHeard', 'position_time', 'positionTime', 'first_heard', 'firstHeard'],
  messages: ['rx_time', 'rxTime'],
  encrypted: ['rx_time', 'rxTime'],
  positions: ['rx_time', 'rxTime', 'position_time', 'positionTime'],
  telemetry: ['rx_time', 'rxTime', 'telemetry_time', 'telemetryTime'],
  neighbors: ['rx_time', 'rxTime'],
  traces: ['rx_time', 'rxTime'],
});

/** Timestamp fields used for an unrecognised collection. */
const DEFAULT_TIMESTAMP_FIELDS = Object.freeze(['rx_time', 'rxTime', 'last_heard', 'lastHeard']);

/**
 * Coerce a value to a finite positive number, or return ``null``.
 *
 * @param {*} value Candidate value.
 * @returns {?number} The number, or null when not a positive finite value.
 */
function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve a record's domain timestamp (unix seconds) for the given collection,
 * trying the collection's candidate fields in order.
 *
 * @param {string} collection Collection name.
 * @param {*} record Cached record value (the stored API row).
 * @returns {?number} Timestamp in seconds, or null when none is usable.
 */
export function recordTimestampSeconds(collection, record) {
  if (!record || typeof record !== 'object') return null;
  const fields = TIMESTAMP_FIELDS[collection] ?? DEFAULT_TIMESTAMP_FIELDS;
  for (const field of fields) {
    const ts = positiveNumber(record[field]);
    if (ts != null) return ts;
  }
  return null;
}

/**
 * Whether a cached entry is **stale** (its cached copy is older than the
 * collection's staleness TTL and a fresh fetch is preferred). An entry with no
 * usable `cachedAt` is treated as stale so it is refetched.
 *
 * @param {string} collection Collection name.
 * @param {{ cachedAt?: number }} entry Cache entry (as returned by the store).
 * @param {number} nowSeconds Current time, unix seconds.
 * @returns {boolean} True when the entry should be considered stale.
 */
export function isStale(collection, entry, nowSeconds) {
  const ttl = CACHE_STALENESS_SECONDS[collection] ?? DEFAULT_TTL;
  const cachedAt = positiveNumber(entry && entry.cachedAt);
  if (cachedAt == null) return true;
  return nowSeconds - cachedAt > ttl;
}

/**
 * Whether a cached entry is **expired** (the underlying row's event is older
 * than the collection's retention window and the entry should be evicted). An
 * entry whose record carries no usable domain timestamp is retained (eviction
 * cannot judge its age; FC5 bounds the store by row caps instead).
 *
 * @param {string} collection Collection name.
 * @param {{ value?: * }} entry Cache entry (as returned by the store).
 * @param {number} nowSeconds Current time, unix seconds.
 * @returns {boolean} True when the entry should be evicted.
 */
export function isExpired(collection, entry, nowSeconds) {
  const window = CACHE_RETENTION_SECONDS[collection] ?? DEFAULT_TTL;
  const ts = recordTimestampSeconds(collection, entry && entry.value);
  if (ts == null) return false;
  return nowSeconds - ts > window;
}
