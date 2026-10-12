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
 * Live-update Server-Sent Events client.
 *
 * Subscribes to the server's `GET /api/events` stream and turns each thin
 * "this collection changed" event into an `onChange(collection, hint)` callback
 * — the caller then runs its existing delta fetch (SPEC.md PS3/PS5). This module
 * owns *only* the SSE connection: it never fetches, caches, or renders, and it
 * holds no timer. The slow safety poll and the actual refresh wiring live in the
 * caller (`main.js`), so this stays pure and fully unit-testable.
 *
 * Robustness (PS8): if `EventSource` is unavailable or construction throws, the
 * client reports inactive so the caller can fall back to polling. The browser's
 * `EventSource` reconnects on its own after a transient error; every (re)connect
 * fires `onResync` so the caller can recover any change missed during the gap.
 * A connection the server refuses (any answer but a 200 event stream, such as
 * the 503 at the subscriber cap or a proxy's 502 while the app restarts) ends
 * `CLOSED`, and the browser never retries it: the client drops that source and
 * reports `onClosed`, so the caller can poll and retry (SPEC ST1).
 *
 * @module main/event-stream
 */

/**
 * Collections a change event may name. An event naming anything else is ignored
 * so a malformed or future payload can never mis-route a fetch.
 *
 * @type {ReadonlyArray<string>}
 */
export const LIVE_COLLECTIONS = Object.freeze([
  'nodes',
  'messages',
  'positions',
  'telemetry',
  'neighbors',
  'traces',
  'waypoints',
]);

/**
 * `EventSource.readyState` of a connection the browser has given up on: it
 * fires one `error` and never reconnects (SPEC ST1).
 *
 * @type {number}
 */
export const EVENT_SOURCE_CLOSED = 2;

/**
 * Resolve the `EventSource` constructor to use.
 *
 * @param {Function} [factory] Explicit constructor (used by tests).
 * @returns {?Function} The constructor, or null when SSE is unsupported.
 */
function resolveEventSourceFactory(factory) {
  if (typeof factory === 'function') return factory;
  if (typeof globalThis.EventSource === 'function') return globalThis.EventSource;
  return null;
}

/**
 * Parse a `change` event payload into a validated `{ collection, hint }`.
 *
 * @param {string} data Raw SSE `data:` field (JSON).
 * @returns {?{collection: string, hint: ?number}} Parsed change, or null when
 *   the payload is malformed or names an unknown collection.
 */
export function parseChangeEvent(data) {
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const { collection } = payload;
  if (typeof collection !== 'string' || !LIVE_COLLECTIONS.includes(collection)) {
    return null;
  }
  const hint = typeof payload.hint === 'number' ? payload.hint : null;
  return { collection, hint };
}

/**
 * Create a live-update SSE client.
 *
 * @param {Object} options Configuration.
 * @param {string} options.path SSE endpoint path (e.g. `/api/events`).
 * @param {(collection: string, hint: ?number) => void} options.onChange
 *   Invoked once per change event with the changed collection and optional hint.
 * @param {() => void} [options.onResync] Invoked on every (re)connect so the
 *   caller can run a full delta resync.
 * @param {(message: string, error: ?Object) => void} [options.onError]
 *   Optional diagnostic sink for stream errors and malformed payloads.
 * @param {() => void} [options.onClosed] Invoked when the server refused the
 *   connection and the browser gave up on it; the source is already dropped,
 *   so `isActive()` reads false and the next `start` opens a new one (ST1).
 * @param {Function} [options.eventSourceFactory] `EventSource` constructor
 *   override (used by tests); defaults to `globalThis.EventSource`.
 * @returns {{start: () => boolean, stop: () => void, isActive: () => boolean}}
 *   Lifecycle handle. `start` returns false when SSE is unavailable so the
 *   caller can fall back to polling.
 */
export function createEventStream(options = {}) {
  const { path, onChange, onResync, onError, onClosed, eventSourceFactory } = options;
  const Factory = resolveEventSourceFactory(eventSourceFactory);
  let source = null;

  const report = (message, error) => {
    if (typeof onError === 'function') onError(message, error || null);
  };

  const handleOpen = () => {
    if (typeof onResync === 'function') onResync();
  };

  const handleChange = (event) => {
    const change = parseChangeEvent(event && event.data);
    if (!change) {
      report('discarded malformed change event', null);
      return;
    }
    if (typeof onChange === 'function') onChange(change.collection, change.hint);
  };

  const handleError = (instance, event) => {
    report('sse connection error', event);
    // A dropped connection leaves the source CONNECTING: the browser reconnects
    // on its own, so keep it. A refused one leaves it CLOSED for good: drop it
    // and tell the caller (SPEC ST1). A source already stopped is not ours.
    if (instance !== source || instance.readyState !== EVENT_SOURCE_CLOSED) return;
    source = null;
    if (typeof onClosed === 'function') onClosed();
  };

  return {
    /**
     * Open the stream. No-op (returns true) when already active.
     *
     * @returns {boolean} true when a stream is active, false when SSE is
     *   unavailable or construction failed (caller should poll instead).
     */
    start() {
      if (source) return true;
      if (!Factory || typeof path !== 'string' || path.length === 0) return false;
      try {
        source = new Factory(path);
      } catch (error) {
        report('failed to open sse stream', error);
        source = null;
        return false;
      }
      const instance = source;
      source.addEventListener('open', handleOpen);
      source.addEventListener('change', handleChange);
      source.addEventListener('error', (event) => handleError(instance, event));
      return true;
    },

    /**
     * Close the stream if open. Safe to call when inactive.
     *
     * @returns {void}
     */
    stop() {
      if (!source) return;
      try {
        source.close();
      } finally {
        source = null;
      }
    },

    /**
     * @returns {boolean} true while a stream is open or reconnecting; false
     *   once stopped or refused (ST1).
     */
    isActive() {
      return source !== null;
    },
  };
}
