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
 * Stream lifecycle of a dashboard page (SPEC ST1-ST5, PS5, PS8).
 *
 * Owns the live stream (`event-stream.js`), the poll that backs it, the
 * stream's retries and the hidden-tab gate. While the stream streams, the poll
 * is the slow safety poll. When the server refuses the stream (the 503 at the
 * SSE subscriber cap, a proxy's 502 while the app restarts), the browser never
 * retries it: the page then polls at the REFRESH_MS cadence, retries the
 * stream with backoff and reads `polling` until a retry opens (ST1-ST4). A
 * page without a stream (live updates disabled, no `EventSource`) polls at
 * REFRESH_MS and reads `polling` too. A tab hidden past {@link HIDDEN_GRACE_MS}
 * closes its stream and stops its poll, so it holds no SSE slot; visible
 * again, it reopens them and resyncs once (ST5).
 *
 * The module touches neither the DOM nor the network itself: `main.js` passes
 * in the refresh, the ping and resync handlers and the label update.
 *
 * @module main/stream-lifecycle
 */

import { createEventStream } from './event-stream.js';

/**
 * Step, in ms, of the retry after the first refused stream since the last
 * open, and the shortest retry delay (SPEC ST3). Each further refusal doubles
 * the step up to {@link STREAM_RETRY_MAX_MS}, the ingestor's upload backoff
 * shape (UR3).
 *
 * @type {number}
 */
export const STREAM_RETRY_BASE_MS = 5000;

/**
 * Longest retry delay, in ms, the doubling reaches (SPEC ST3). A page whose
 * stream was refused polls at REFRESH_MS meanwhile.
 *
 * @type {number}
 */
export const STREAM_RETRY_MAX_MS = 60000;

/**
 * Range, as factors of the step, of the window each retry delay is drawn from
 * (SPEC ST3). The window is cut to {@link STREAM_RETRY_BASE_MS} and
 * {@link STREAM_RETRY_MAX_MS} before the draw, so no delay piles up on a
 * bound and the pages whose streams dropped together (an app restart, the
 * subscriber cap) do not retry in step.
 *
 * @type {ReadonlyArray<number>}
 */
export const STREAM_RETRY_JITTER = Object.freeze([0.8, 1.2]);

/**
 * How long, in ms, a tab may stay hidden before its stream and its poll stop
 * (SPEC ST5). A glance at another tab keeps them; a tab left hidden frees its
 * SSE slot (PS9) and makes no requests until it is visible again.
 *
 * @type {number}
 */
export const HIDDEN_GRACE_MS = 5000;

/**
 * The ambient timers, looked up when a timer is armed (tests replace them).
 *
 * @type {{ setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function }}
 */
const AMBIENT_TIMERS = Object.freeze({
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: handle => globalThis.clearInterval(handle),
});

/**
 * Delay before the next stream retry (SPEC ST3). The step is 5 s after the
 * first refusal since the last open, doubling per refusal to 60 s; the delay
 * is drawn uniformly from 0.8 to 1.2 times the step ({@link STREAM_RETRY_JITTER}),
 * that window cut to 5-60 s first: 5-6 s for the first retry, 48-60 s once
 * the step is capped.
 *
 * @param {number} failures Refusals since the last open (1 for the first).
 * @param {() => number} [random] Uniform source in [0, 1); `Math.random` by default.
 * @returns {number} The delay in whole ms.
 */
export function streamRetryDelayMs(failures, random = () => Math.random()) {
  const doublings = Math.max(0, Math.floor(failures) - 1);
  const step = Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** doublings);
  // Clamp the window, then draw inside it: clamping the draw instead put the
  // draws below 1.0 of the first step all on 5 s, and those above 1.0 of the
  // capped step all on 60 s.
  const [low, high] = STREAM_RETRY_JITTER;
  const from = Math.max(STREAM_RETRY_BASE_MS, step * low);
  const to = Math.min(STREAM_RETRY_MAX_MS, step * high);
  return Math.round(from + (to - from) * random());
}

/**
 * Let a timer handle never keep a Node process (the test runner) alive;
 * browser handles are numbers and have no `unref`.
 *
 * @param {*} handle Timer handle.
 * @returns {*} The same handle.
 */
function unref(handle) {
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

/**
 * Create the stream lifecycle of one page.
 *
 * @param {Object} [options] Configuration and callbacks.
 * @param {boolean} [options.enabled=false] Whether the server offers the live
 *   stream (`liveUpdatesEnabled`); without it the page only polls.
 * @param {string} [options.path] SSE endpoint path (`/api/events`).
 * @param {number} [options.refreshMs=0] Poll cadence while the page does not
 *   stream; 0 arms no poll.
 * @param {number} [options.safetyPollMs=0] Poll cadence while it streams; 0
 *   arms no poll.
 * @param {() => void} [options.poll] One refresh: each poll tick, and the
 *   resync of a tab made visible again whose stream does not open.
 * @param {(collection: string, hint: ?number) => void} [options.onChange] A
 *   change ping of the stream.
 * @param {() => void} [options.onResync] Every open of the stream (PS5).
 * @param {(message: string, error: ?Object) => void} [options.onError]
 *   Diagnostic sink of the stream.
 * @param {() => void} [options.onModeChange] The page went from streaming to
 *   polling or back; {@link mode} reads the new state.
 * @param {() => void} [options.onStop] The stream and the poll were torn down
 *   (a stop, or a tab hidden past its grace).
 * @param {?Object} [options.documentRef] Document whose `hidden` flag and
 *   `visibilitychange` event gate the stream; the global `document` by
 *   default, and none leaves the gate off.
 * @param {Function} [options.eventSourceFactory] `EventSource` override (tests).
 * @param {{ setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function }} [options.timers]
 *   Timer functions, the ambient ones by default (tests).
 * @param {() => number} [options.random] Uniform source of the retry jitter.
 * @param {number} [options.graceMs] Hidden-tab grace, {@link HIDDEN_GRACE_MS} by default.
 * @returns {{
 *   start: () => void,
 *   stop: () => void,
 *   dispose: () => void,
 *   isStreaming: () => boolean,
 *   mode: () => ('live'|'polling'),
 *   intervalMs: () => number,
 *   isSuspended: () => boolean,
 *   failures: () => number,
 * }} The lifecycle handle.
 */
export function createStreamLifecycle(options = {}) {
  const {
    enabled = false,
    path,
    refreshMs = 0,
    safetyPollMs = 0,
    poll,
    onChange,
    onResync,
    onError,
    onModeChange,
    onStop,
    eventSourceFactory,
    timers = AMBIENT_TIMERS,
    random = () => Math.random(),
    graceMs = HIDDEN_GRACE_MS,
  } = options;
  const documentRef = options.documentRef !== undefined
    ? options.documentRef
    : (typeof document !== 'undefined' ? document : null);
  const stream = enabled
    ? createEventStream({ path, onChange, onResync: handleOpen, onClosed: handleClosed, onError, eventSourceFactory })
    : null;

  /** Whether the caller wants the stream and the poll (a start without a later stop). */
  let running = false;
  /** Whether a tab hidden past its grace has torn the stream and the poll down (ST5). */
  let suspended = false;
  /** Whether the page polls: no stream, or one refused and not opened since (ST2, ST4). */
  let down = !stream;
  /** Refusals since the last open: the backoff exponent (ST3). */
  let failureCount = 0;
  /** Whether a tab made visible again still waits for its one resync (ST5). */
  let resyncPending = false;
  let pollHandle = null;
  let pollMs = 0;
  let retryHandle = null;
  let graceHandle = null;

  /**
   * Call an optional callback.
   *
   * @param {Function} [callback] The callback, if any.
   * @returns {void}
   */
  function call(callback) {
    if (typeof callback === 'function') callback();
  }

  /** @returns {boolean} true while the document reports the tab hidden. */
  function isHidden() {
    return Boolean(documentRef) && documentRef.hidden === true;
  }

  /** @returns {void} Clears the poll; the cadence then reads 0. */
  function clearPoll() {
    if (pollHandle !== null) {
      timers.clearInterval(pollHandle);
      pollHandle = null;
    }
    pollMs = 0;
  }

  /**
   * Arm the poll at the cadence of the stream's state: the safety poll while
   * it streams, REFRESH_MS while the page polls (ST2). Replaces an armed poll.
   *
   * @returns {void}
   */
  function armPoll() {
    clearPoll();
    const ms = down ? refreshMs : safetyPollMs;
    if (ms > 0) {
      pollMs = ms;
      pollHandle = timers.setInterval(() => call(poll), ms);
    }
  }

  /** @returns {void} Cancels a pending stream retry. */
  function clearRetry() {
    if (retryHandle !== null) {
      timers.clearTimeout(retryHandle);
      retryHandle = null;
    }
  }

  /**
   * Arm the next stream retry after the backoff of the refusals so far (ST3).
   * A retry whose stream cannot be built counts as one more refusal.
   *
   * @returns {void}
   */
  function scheduleRetry() {
    clearRetry();
    retryHandle = unref(timers.setTimeout(() => {
      retryHandle = null;
      if (stream.start()) return;
      failureCount += 1;
      scheduleRetry();
    }, streamRetryDelayMs(failureCount, random)));
  }

  /**
   * Record whether the page polls, and report a change (the label, ST4).
   *
   * @param {boolean} value true while the page polls.
   * @returns {void}
   */
  function setDown(value) {
    if (down === value) return;
    down = value;
    call(onModeChange);
  }

  /**
   * Run the pending resync of a tab made visible again, once (ST5).
   *
   * @returns {void}
   */
  function runPendingResync() {
    if (!resyncPending) return;
    resyncPending = false;
    call(poll);
  }

  /**
   * Open the stream, unless one is open or a retry waits for its delay, and
   * arm the poll at the cadence of the stream's state. A stream that opens
   * resyncs (PS5); without one, a pending resync runs at once.
   *
   * @returns {void}
   */
  function engage() {
    if (stream && !stream.isActive() && retryHandle === null && !stream.start()) {
      // EventSource missing, or construction threw: poll, with nothing to retry.
      setDown(true);
    }
    armPoll();
    if (!stream || !stream.isActive()) runPendingResync();
  }

  /**
   * Tear the stream, the poll and a pending retry down.
   *
   * @returns {void}
   */
  function disengage() {
    clearPoll();
    clearRetry();
    if (stream) stream.stop();
    call(onStop);
  }

  /**
   * The stream opened: the page streams, the backoff resets and the caller
   * resyncs (PS5); that resync is also the one of a tab made visible (ST5).
   *
   * @returns {void}
   */
  function handleOpen() {
    failureCount = 0;
    resyncPending = false;
    if (down) {
      setDown(false);
      armPoll();
    }
    call(onResync);
  }

  /**
   * The server refused the stream and the browser gave up on it (ST1): poll
   * at REFRESH_MS and retry with backoff. Only the first refusal re-arms the
   * poll: a retry refused again leaves it in its phase, or retries that come
   * less than REFRESH_MS apart would restart it before it ever fired. A tab
   * made visible again whose stream is refused resyncs now, by one refresh.
   *
   * @returns {void}
   */
  function handleClosed() {
    failureCount += 1;
    if (!down) {
      setDown(true);
      armPoll();
    }
    scheduleRetry();
    runPendingResync();
  }

  /**
   * Hidden: arm the grace. Visible: clear it, and restart a page the grace
   * suspended, with one resync (ST5).
   *
   * @returns {void}
   */
  function handleVisibility() {
    if (isHidden()) {
      if (graceHandle === null && !suspended) {
        graceHandle = unref(timers.setTimeout(suspend, graceMs));
      }
      return;
    }
    if (graceHandle !== null) {
      timers.clearTimeout(graceHandle);
      graceHandle = null;
    }
    if (!suspended) return;
    suspended = false;
    if (!running) return;
    resyncPending = true;
    engage();
  }

  /**
   * The tab stayed hidden past its grace: stop the stream and the poll (ST5).
   *
   * @returns {void}
   */
  function suspend() {
    graceHandle = null;
    suspended = true;
    if (running) disengage();
  }

  /**
   * Start (or restart) the stream and the poll. A second call keeps an open
   * stream and re-arms the poll; while a retry waits, it keeps waiting. In a
   * tab hidden past its grace, nothing opens until it is visible again.
   *
   * @returns {void}
   */
  function start() {
    running = true;
    if (suspended) return;
    engage();
  }

  /**
   * Stop the stream, the poll and a pending retry (a pause, a teardown). The
   * polling state is kept for the label; a later start tries the stream at
   * once.
   *
   * @returns {void}
   */
  function stop() {
    running = false;
    resyncPending = false;
    disengage();
  }

  /**
   * Stop, clear the grace and remove the visibility listener (teardown). The
   * gate is off afterwards, so a later start opens the stream at once.
   *
   * @returns {void}
   */
  function dispose() {
    stop();
    suspended = false;
    if (graceHandle !== null) {
      timers.clearTimeout(graceHandle);
      graceHandle = null;
    }
    if (documentRef && typeof documentRef.removeEventListener === 'function') {
      documentRef.removeEventListener('visibilitychange', handleVisibility);
    }
  }

  if (documentRef && typeof documentRef.addEventListener === 'function') {
    documentRef.addEventListener('visibilitychange', handleVisibility);
    // A tab hidden from the start (opened in the background) arms its grace now.
    handleVisibility();
  }

  return {
    start,
    stop,
    dispose,

    /**
     * @returns {boolean} true while the stream drives the page: started, not
     *   suspended, and a stream open or connecting that was not refused (ST2).
     */
    isStreaming() {
      return running && !suspended && !down && stream.isActive();
    },

    /**
     * @returns {'live'|'polling'} `polling` while the page has no stream, or
     *   its stream was refused and has not opened since (ST4); kept across a
     *   stop and a suspension.
     */
    mode() {
      return down ? 'polling' : 'live';
    },

    /** @returns {number} The poll cadence armed now, in ms; 0 when none. */
    intervalMs() {
      return pollMs;
    },

    /** @returns {boolean} true while a tab hidden past its grace holds nothing (ST5). */
    isSuspended() {
      return suspended;
    },

    /** @returns {number} Refusals since the last open (ST3). */
    failures() {
      return failureCount;
    },
  };
}
