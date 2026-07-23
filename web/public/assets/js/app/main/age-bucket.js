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
 * Node freshness buckets (SPEC UX5, audit D-005).
 *
 * A node's "last heard" age is classified into one of three preattentive
 * buckets — `live` (< 3 h), `today` (< 24 h), `stale` (older, or unknown) —
 * stamped as row attributes at render time and kept honest between data
 * refreshes by the shared relative-time tick (an explicit extension of SPEC
 * RT2: the tick may rewrite the bucket *attribute*, still write-on-change,
 * never re-rendering the row). Map markers translate the same bucket into
 * fill opacity at render time only (the UX5 boundary).
 *
 * @module main/age-bucket
 */

/** Upper bound (exclusive) of the `live` bucket, in seconds. */
export const AGE_BUCKET_LIVE_MAX_SECONDS = 3 * 3600;

/** Upper bound (exclusive) of the `today` bucket, in seconds. */
export const AGE_BUCKET_TODAY_MAX_SECONDS = 24 * 3600;

/** Attribute carrying the computed bucket (`live` | `today` | `stale`). */
export const AGE_BUCKET_ATTRIBUTE = 'data-age';

/** Attribute carrying the bucket's source timestamp (unix seconds). */
export const AGE_BUCKET_TS_ATTRIBUTE = 'data-age-ts';

/** Marker fill opacity per bucket (SPEC UX5). */
const BUCKET_FILL_OPACITY = Object.freeze({
  live: 0.85,
  today: 0.55,
  stale: 0.3,
});

/**
 * Classify a "last heard" timestamp into its freshness bucket.
 *
 * Missing, zero, or non-finite timestamps classify as `stale` — an unknown
 * age must read as silence, not life. A timestamp ahead of `nowSec` (clock
 * skew between ingestors) clamps to `live`.
 *
 * @param {*} unixSec Last-heard timestamp in seconds since the epoch.
 * @param {number} nowSec Reference "now" in seconds since the epoch.
 * @returns {'live' | 'today' | 'stale'} Freshness bucket.
 */
export function nodeAgeBucket(unixSec, nowSec) {
  const ts = Number(unixSec);
  if (!ts || !Number.isFinite(ts)) return 'stale';
  const age = Math.max(0, nowSec - ts);
  if (age < AGE_BUCKET_LIVE_MAX_SECONDS) return 'live';
  if (age < AGE_BUCKET_TODAY_MAX_SECONDS) return 'today';
  return 'stale';
}

/**
 * Build the attribute string stamping a row with its bucket and timestamp,
 * e.g. `data-age="live" data-age-ts="1712345678"`.
 *
 * Returns an empty string for a missing/non-finite timestamp so unknown ages
 * carry no bucket markup (they fall to the CSS default appearance).
 *
 * @param {*} unixSec Last-heard timestamp in seconds since the epoch.
 * @param {number} nowSec Reference "now" in seconds since the epoch.
 * @returns {string} Attribute string for template interpolation.
 */
export function ageBucketAttributes(unixSec, nowSec) {
  const ts = Number(unixSec);
  if (!ts || !Number.isFinite(ts)) return '';
  return `${AGE_BUCKET_ATTRIBUTE}="${nodeAgeBucket(ts, nowSec)}" ${AGE_BUCKET_TS_ATTRIBUTE}="${ts}"`;
}

/**
 * Re-classify every stamped element and rewrite its bucket attribute only
 * where the bucket changed (the RT2 write-on-change discipline).
 *
 * @param {?{querySelectorAll: Function}} documentRef Document (or root) to scan.
 * @param {number} nowSec Reference "now" in seconds since the epoch.
 * @returns {number} Count of elements whose bucket was rewritten.
 */
export function updateAgeBucketElements(documentRef, nowSec) {
  if (!documentRef || typeof documentRef.querySelectorAll !== 'function') return 0;
  let written = 0;
  for (const element of documentRef.querySelectorAll(`[${AGE_BUCKET_TS_ATTRIBUTE}]`)) {
    if (!element || typeof element.getAttribute !== 'function') continue;
    const next = nodeAgeBucket(element.getAttribute(AGE_BUCKET_TS_ATTRIBUTE), nowSec);
    if (element.getAttribute(AGE_BUCKET_ATTRIBUTE) !== next) {
      element.setAttribute(AGE_BUCKET_ATTRIBUTE, next);
      written += 1;
    }
  }
  return written;
}

/**
 * Map a freshness bucket to the marker fill opacity encoding it (SPEC UX5).
 *
 * Unknown buckets render at the stale opacity — the conservative reading.
 *
 * @param {string} bucket Bucket name from {@link nodeAgeBucket}.
 * @returns {number} Leaflet `fillOpacity` for the marker.
 */
export function markerFillOpacityForBucket(bucket) {
  return BUCKET_FILL_OPACITY[bucket] ?? BUCKET_FILL_OPACITY.stale;
}
