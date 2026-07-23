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
 * Live relative-time ticker (SPEC RT1–RT4).
 *
 * Makes every rendered relative-time field ("last seen 4s", "last update
 * 3m 12s") count up in real time between data refreshes. Fields opt in by
 * carrying {@link TICK_TIMESTAMP_ATTRIBUTE} (the unix timestamp in seconds);
 * one shared ~1 s interval rescans them, recomputes the age string with the
 * *unchanged* existing formatters, and writes `textContent` **only when the
 * string changed** (RT2) — so the tick never re-renders rows, markers, or
 * chat entries and cannot restart a live-flash fade, reset scroll, or close
 * an open overlay.
 *
 * The attribute-scan design is deliberate: rows are re-materialised wholesale
 * on data refresh, so an element registry would need per-render bookkeeping —
 * a scan is self-healing (a replaced row simply carries a fresh attribute; a
 * removed row is no longer matched).
 *
 * The ticker is a pure presentation clock: it performs no fetch, never
 * consults the auto-refresh play/pause toggle (RT3 — the toggle pauses
 * *data*, not the clock), and idles while the document is hidden, snapping
 * every field to its correct value the moment the tab becomes visible again.
 *
 * @module main/relative-time-ticker
 */

import { timeAgo, timeAgoSuffixed } from './format-utils.js';
import { formatRelativeSeconds } from '../node-page-charts/display-formatters.js';

/** Attribute holding a field's unix timestamp (seconds); its presence opts the element in. */
export const TICK_TIMESTAMP_ATTRIBUTE = 'data-ts-ago';

/** Optional attribute selecting the formatter variant (see {@link TICK_FORMAT_RELATIVE}). */
export const TICK_FORMAT_ATTRIBUTE = 'data-ts-format';

/** Default formatter variant: `timeAgo` (dashboard/federation style, e.g. "5m 0s"). */
export const TICK_FORMAT_AGO = 'ago';

/** Formatter variant for `formatRelativeSeconds` (node-detail style, e.g. "5m"). */
export const TICK_FORMAT_RELATIVE = 'relative';

/** Formatter variant for `timeAgoSuffixed` (federation style, e.g. "5m ago"). */
export const TICK_FORMAT_AGO_SUFFIXED = 'ago-suffixed';

/** Tick cadence in milliseconds (RT2: one shared ~1 s interval). */
export const TICK_INTERVAL_MS = 1000;

/** Selector matching every opted-in field. */
export const TICK_SELECTOR = `[${TICK_TIMESTAMP_ATTRIBUTE}]`;

/**
 * Formatter registry keyed by {@link TICK_FORMAT_ATTRIBUTE} value. Both
 * functions are the pre-existing formatters, imported untouched (RT4: the
 * output format does not change — only *when* it is recomputed).
 */
const FORMATTERS = {
  [TICK_FORMAT_AGO]: timeAgo,
  [TICK_FORMAT_RELATIVE]: formatRelativeSeconds,
  [TICK_FORMAT_AGO_SUFFIXED]: timeAgoSuffixed,
};

/**
 * Compute the age string for one field using its declared formatter variant.
 *
 * An unknown or missing variant falls back to {@link TICK_FORMAT_AGO}; a
 * missing/invalid timestamp yields the same empty string the formatters
 * already produce today (RT4).
 *
 * @param {*} timestampValue Raw timestamp attribute value (seconds since epoch).
 * @param {?string} formatName Formatter variant attribute value.
 * @param {number} nowSec Reference "now" in seconds since the epoch.
 * @returns {string} The formatted age string.
 */
export function formatTickingAge(timestampValue, formatName, nowSec) {
  const format = FORMATTERS[formatName] || FORMATTERS[TICK_FORMAT_AGO];
  return format(Number(timestampValue), nowSec);
}

/**
 * Build the HTML attribute string that opts a template-rendered field into
 * ticking, e.g. `data-ts-ago="1712345678"` or
 * `data-ts-ago="1712345678" data-ts-format="relative"`.
 *
 * Returns an empty string for a missing/zero/non-finite timestamp so a field
 * with nothing to count stays a plain static (empty) cell — exactly today's
 * rendering (RT4).
 *
 * @param {*} unixSec Timestamp in seconds since the epoch.
 * @param {string} [formatName] Formatter variant; omitted for the default.
 * @returns {string} Attribute string for interpolation into a template literal.
 */
export function tickAttributes(unixSec, formatName = TICK_FORMAT_AGO) {
  const numeric = Number(unixSec);
  if (!numeric || !Number.isFinite(numeric)) return '';
  const formatAttr =
    formatName && formatName !== TICK_FORMAT_AGO ? ` ${TICK_FORMAT_ATTRIBUTE}="${formatName}"` : '';
  return `${TICK_TIMESTAMP_ATTRIBUTE}="${numeric}"${formatAttr}`;
}

/**
 * Run one tick pass: rescan the document for opted-in fields, recompute each
 * age, and write `textContent` only where the string changed (RT2).
 *
 * Comparing against the element's current text (rather than a cached value)
 * is self-correcting: a row re-rendered by a data refresh is simply observed
 * at its new text on the next pass.
 *
 * @param {?{querySelectorAll: Function}} documentRef Document (or root) to scan.
 * @param {number} [nowSec] Reference "now" in seconds; defaults to wall clock.
 * @returns {number} Count of fields whose text was rewritten.
 */
export function updateTickingElements(documentRef, nowSec = Date.now() / 1000) {
  if (!documentRef || typeof documentRef.querySelectorAll !== 'function') return 0;
  let written = 0;
  for (const element of documentRef.querySelectorAll(TICK_SELECTOR)) {
    if (!element || typeof element.getAttribute !== 'function') continue;
    const next = formatTickingAge(
      element.getAttribute(TICK_TIMESTAMP_ATTRIBUTE),
      element.getAttribute(TICK_FORMAT_ATTRIBUTE),
      nowSec,
    );
    if (element.textContent !== next) {
      element.textContent = next;
      written += 1;
    }
  }
  return written;
}

/**
 * Default interval scheduler (real `setInterval`). Injectable so tests stay
 * deterministic; the handle is `unref`ed so a running ticker never keeps a
 * Node process alive (tests).
 *
 * @param {Function} callback Tick callback.
 * @param {number} delay Interval in ms.
 * @returns {*} The interval handle.
 */
function defaultSetInterval(callback, delay) {
  const handle = setInterval(callback, delay);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

/**
 * Default interval canceller (pairs with {@link defaultSetInterval}).
 *
 * @param {*} handle Interval handle returned by the scheduler.
 * @returns {void}
 */
function defaultClearInterval(handle) {
  clearInterval(handle);
}

/**
 * Start the shared ticker: an immediate snap pass, then one ~1 s interval
 * driving {@link updateTickingElements} (RT1/RT2).
 *
 * While the document is hidden the interval is torn down entirely (RT3: no
 * background work); on `visibilitychange` back to visible the ticker snaps
 * every field in one immediate pass and re-arms the interval. Deliberately
 * independent of the auto-refresh play/pause toggle (RT3).
 *
 * @param {Object} [options] Overrides, primarily for tests.
 * @param {?Object} [options.documentRef] Document to scan/listen on; defaults
 *   to the global `document`, and a missing document yields an inert handle.
 * @param {number} [options.intervalMs] Tick cadence; defaults to {@link TICK_INTERVAL_MS}.
 * @param {Function} [options.now] Clock returning seconds since the epoch.
 * @param {Function} [options.setIntervalFn] Interval scheduler (tests inject this).
 * @param {Function} [options.clearIntervalFn] Interval canceller (tests inject this).
 * @returns {{tick: Function, stop: Function, running: Function}} Handle:
 *   `tick()` forces one pass (returns the write count), `stop()` tears the
 *   ticker down (idempotent), `running()` reports whether an interval is armed.
 */
export function startRelativeTimeTicker(options = {}) {
  const documentRef =
    options.documentRef !== undefined
      ? options.documentRef
      : typeof document !== 'undefined'
        ? document
        : null;
  const intervalMs = typeof options.intervalMs === 'number' ? options.intervalMs : TICK_INTERVAL_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now() / 1000;
  const schedule = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : defaultSetInterval;
  const cancel = typeof options.clearIntervalFn === 'function' ? options.clearIntervalFn : defaultClearInterval;
  // No document (e.g. a non-browser context): return an inert, safe handle.
  if (!documentRef || typeof documentRef.querySelectorAll !== 'function') {
    return { tick: () => 0, stop: () => {}, running: () => false };
  }

  let handle = null;
  let stopped = false;

  const tick = () => updateTickingElements(documentRef, now());
  const hidden = () => documentRef.hidden === true;

  /** Arm the interval unless already armed, stopped, or hidden. */
  const arm = () => {
    if (stopped || hidden() || handle != null) return;
    handle = schedule(tick, intervalMs);
  };

  /** Tear the interval down (RT3: a hidden tab does no background work). */
  const disarm = () => {
    if (handle == null) return;
    cancel(handle);
    handle = null;
  };

  /** Hidden → idle; visible → snap every field once, then resume ticking. */
  const onVisibilityChange = () => {
    if (hidden()) {
      disarm();
    } else {
      tick();
      arm();
    }
  };

  if (typeof documentRef.addEventListener === 'function') {
    documentRef.addEventListener('visibilitychange', onVisibilityChange);
  }
  // Initial snap + arm, honouring a tab that is already hidden at start.
  onVisibilityChange();

  return {
    tick,
    stop: () => {
      if (stopped) return;
      stopped = true;
      disarm();
      if (typeof documentRef.removeEventListener === 'function') {
        documentRef.removeEventListener('visibilitychange', onVisibilityChange);
      }
    },
    running: () => handle != null,
  };
}
