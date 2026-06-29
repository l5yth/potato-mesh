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
 * Cold-load data prefetch (initial-load latency fix).
 *
 * The dashboard's first `/api/*` fetch otherwise waits for the whole ES-module
 * graph to download, parse, and boot — so on a real connection data does not
 * paint for seconds. This module, loaded as an early `<script type="module"
 * async>`, fires the first-load API requests **in parallel with** the module
 * graph and stashes the in-flight `Response` promises on a window global; the
 * app then consumes them on its first refresh instead of issuing its own
 * network requests.
 *
 * It runs **only on cold loads**: when the persistent cache already holds data
 * (a warm revisit) the FC2 seed-then-delta path is faster, so a synchronous
 * `localStorage` marker suppresses the prefetch entirely, leaving the warm path
 * untouched. Message endpoints are skipped in private mode (the server marks the
 * boot tag), mirroring the `/api/messages` 404 (Invariant II / SPEC PS6). The
 * prefetch is purely a performance pre-warm: an absent or rejected prefetch
 * degrades to the app's own fetch, so it is never load-bearing (FC7).
 *
 * @module main/boot-prefetch
 */

import { NODE_LIMIT, TRACE_LIMIT, BOOT_CACHE_FLAG } from './constants.js';
import { MESSAGE_LIMIT } from '../message-limit.js';

// Re-exported so consumers/tests can reference the marker from the boot module.
export { BOOT_CACHE_FLAG };

/** Window property the stashed boot `Response` promises live on. */
export const BOOT_GLOBAL = '__PM_BOOT__';

/**
 * Build the cold-load (``since=0``) API URLs keyed by collection, mirroring the
 * URLs the dashboard's data-fetchers request on a first load so the prefetched
 * responses match. Message endpoints are omitted when chat is disabled (private
 * mode), since the server 404s them.
 *
 * @param {{ chatEnabled?: boolean }} [options] Whether chat (messages) is enabled.
 * @returns {Object<string, string>} Collection key → request URL.
 */
export function coldLoadUrls({ chatEnabled = true } = {}) {
  const urls = {
    nodes: `/api/nodes?limit=${NODE_LIMIT}`,
    positions: `/api/positions?limit=${NODE_LIMIT}`,
    telemetry: `/api/telemetry?limit=${NODE_LIMIT}`,
    neighbors: `/api/neighbors?limit=${NODE_LIMIT}`,
    traces: `/api/traces?limit=${TRACE_LIMIT}`,
  };
  if (chatEnabled) {
    urls.messages = `/api/messages?limit=${MESSAGE_LIMIT}`;
    urls.encryptedMessages = `/api/messages?limit=${MESSAGE_LIMIT}&encrypted=true`;
  }
  return urls;
}

/**
 * Issue the cold-load fetches and return a map of in-flight `Response` promises
 * keyed by collection — or `null` when the prefetch should be skipped (a warm
 * load signalled by the `localStorage` marker). Each fetch is marked
 * `priority: 'high'` so it out-prioritises the parallel module-graph preloads.
 *
 * @param {{ storage?: Storage|null, fetchFn?: Function|null, chatEnabled?: boolean }} env
 *   Injectable environment: the `localStorage`-like store (read synchronously),
 *   the `fetch` implementation, and the chat-enabled flag.
 * @returns {Object<string, Promise<Response>>|null} Boot map, or `null` when
 *   skipped (warm load) or impossible (no `fetch`).
 */
export function startBootPrefetch({ storage = null, fetchFn = null, chatEnabled = true } = {}) {
  try {
    // Warm load: the persistent cache will seed + delta-fetch faster (FC2). Any
    // storage error falls through to a cold prefetch (the safe default).
    if (storage && storage.getItem(BOOT_CACHE_FLAG) === '1') return null;
  } catch (error) {
    /* localStorage blocked (e.g. partitioned storage) — treat as a cold load. */
  }
  if (typeof fetchFn !== 'function') return null;
  const boot = {};
  for (const [key, url] of Object.entries(coldLoadUrls({ chatEnabled }))) {
    try {
      boot[key] = fetchFn(url, { priority: 'high', cache: 'default' });
    } catch (error) {
      /* A synchronous fetch throw skips just this collection; the app re-fetches. */
    }
  }
  return boot;
}

/**
 * DOM entry point: read the boot tag's config, run {@link startBootPrefetch},
 * and stash the result on the window global the app consumes. Safe to call when
 * the environment is incomplete (missing tag / fetch) — it simply prefetches
 * less or nothing.
 *
 * @param {Document} [doc=document] Document to read the boot tag from.
 * @param {Window} [win=window] Window to read `localStorage`/`fetch` from and
 *   stash the boot map on.
 * @returns {Object<string, Promise<Response>>|null} The stashed boot map, or `null`.
 */
export function runBootPrefetch(doc = document, win = window) {
  const tag = doc && typeof doc.querySelector === 'function'
    ? doc.querySelector('script[data-pm-prefetch]')
    : null;
  // Default to chat-enabled when the tag is absent; the server sets
  // data-pm-chat="false" only in private mode.
  const chatEnabled = tag ? tag.getAttribute('data-pm-chat') !== 'false' : true;
  const boot = startBootPrefetch({
    storage: win && win.localStorage ? win.localStorage : null,
    fetchFn: win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null,
    chatEnabled,
  });
  if (boot && win) win[BOOT_GLOBAL] = boot;
  return boot;
}

/**
 * Run the prefetch only when the boot tag is present — so importing this module
 * without the tag (a unit test, or a page that does not opt in) never fires a
 * request. Invoked once at module load with the live globals (a no-op outside a
 * browser), and directly callable in tests.
 *
 * @param {Document|null} [doc] Document to look for the boot tag in.
 * @param {Window|null} [win] Window to prefetch against / stash the map on.
 * @returns {Object<string, Promise<Response>>|null} The boot map, or `null` when skipped.
 */
export function maybeBootstrap(
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null,
) {
  if (!doc || typeof doc.querySelector !== 'function' || !doc.querySelector('script[data-pm-prefetch]')) {
    return null;
  }
  return runBootPrefetch(doc, win);
}

// Auto-run on load; a no-op unless a browser document carries the boot tag.
maybeBootstrap();
