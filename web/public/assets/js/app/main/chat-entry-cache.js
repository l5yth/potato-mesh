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
 * Memoising cache for chat-log entry DOM nodes.
 *
 * The chat log re-renders on every refresh tick. Turning each entry's HTML
 * string into a DOM node (``element.innerHTML = …``) forces a synchronous parse
 * and is the dominant cost of a refresh (issue: chat-log render). This cache
 * keeps the built node and only re-parses when the entry's rendered HTML
 * actually changes — a new message, a renamed sender, a fresh telemetry value.
 * An idle re-render (nothing new) therefore performs zero parses and simply
 * re-appends the cached nodes.
 *
 * Entries are **namespaced per tab** because the same message renders in more
 * than one tab (the mixed Log feed and its channel tab) and a DOM node can live
 * in only one parent at a time, so each tab keeps its own node for a given key.
 *
 * @module main/chat-entry-cache
 */

/**
 * Create a chat-entry node cache.
 *
 * @param {{ documentRef?: Document }} [options] Optional document override; the
 *   ambient ``document`` is used when omitted. Primarily for unit tests.
 * @returns {{
 *   materialize: (namespace: string, key: string, className: string, html: string) => Object,
 *   prune: (namespace: string) => void,
 *   retainNamespaces: (activeNamespaces: Iterable<string>) => void,
 *   stats: () => { materialized: number },
 *   resetStats: () => void,
 *   size: (namespace?: string) => number
 * }} Cache API.
 */
export function createChatEntryCache({ documentRef } = {}) {
  const doc = documentRef ?? (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createChatEntryCache requires a document with createElement');
  }

  /** @type {Map<string, Map<string, { html: string, node: Object }>>} */
  const namespaces = new Map();
  /** @type {Map<string, Set<string>>} keys touched in the current build cycle. */
  const seen = new Map();
  let materialized = 0;

  /**
   * Resolve (creating if needed) the entry map for a namespace.
   *
   * @param {string} namespace Tab identifier.
   * @returns {Map<string, { html: string, node: Object }>} Entry map.
   */
  function nsMap(namespace) {
    let map = namespaces.get(namespace);
    if (!map) {
      map = new Map();
      namespaces.set(namespace, map);
    }
    return map;
  }

  /**
   * Resolve (creating if needed) the seen-key set for a namespace.
   *
   * @param {string} namespace Tab identifier.
   * @returns {Set<string>} Set of keys seen this cycle.
   */
  function seenSet(namespace) {
    let set = seen.get(namespace);
    if (!set) {
      set = new Set();
      seen.set(namespace, set);
    }
    return set;
  }

  /**
   * Return the cached node for ``(namespace, key)`` when its HTML is unchanged;
   * otherwise build, cache, and return a fresh node. Records the key as seen so
   * a later {@link prune} keeps it.
   *
   * @param {string} namespace Tab identifier.
   * @param {string} key Stable per-entry identity.
   * @param {string} className CSS class applied to the entry element.
   * @param {string} html Rendered entry HTML (also the cache-validity signature).
   * @returns {Object} The cached or freshly-built entry node.
   */
  function materialize(namespace, key, className, html) {
    const cache = nsMap(namespace);
    seenSet(namespace).add(key);
    const existing = cache.get(key);
    if (existing && existing.html === html) {
      return existing.node;
    }
    const node = doc.createElement('div');
    node.className = className;
    node.innerHTML = html;
    cache.set(key, { html, node });
    materialized += 1;
    return node;
  }

  /**
   * Drop cached entries in ``namespace`` that were not seen during the current
   * build cycle (messages that aged out of the window), then clear the cycle's
   * seen set so the next build starts fresh.
   *
   * @param {string} namespace Tab identifier.
   * @returns {void}
   */
  function prune(namespace) {
    const cache = namespaces.get(namespace);
    const set = seen.get(namespace);
    if (!cache) {
      return;
    }
    if (!set) {
      cache.clear();
      return;
    }
    for (const key of [...cache.keys()]) {
      if (!set.has(key)) {
        cache.delete(key);
      }
    }
    seen.delete(namespace);
  }

  /**
   * Forget every namespace not present in ``activeNamespaces`` so caches for
   * removed tabs (e.g. a channel that dropped out of the window) are released.
   *
   * @param {Iterable<string>} activeNamespaces Namespaces to keep.
   * @returns {void}
   */
  function retainNamespaces(activeNamespaces) {
    const keep = activeNamespaces instanceof Set ? activeNamespaces : new Set(activeNamespaces);
    for (const namespace of [...namespaces.keys()]) {
      if (!keep.has(namespace)) {
        namespaces.delete(namespace);
      }
    }
    for (const namespace of [...seen.keys()]) {
      if (!keep.has(namespace)) {
        seen.delete(namespace);
      }
    }
  }

  /**
   * Cumulative count of entries materialised (parsed) since the last reset.
   *
   * @returns {{ materialized: number }} Render statistics.
   */
  function stats() {
    return { materialized };
  }

  /**
   * Reset the materialisation counter (does not evict cached nodes).
   *
   * @returns {void}
   */
  function resetStats() {
    materialized = 0;
  }

  /**
   * Number of cached entries, for one namespace or across all of them.
   *
   * @param {string} [namespace] Tab identifier; omit for the grand total.
   * @returns {number} Cached entry count.
   */
  function size(namespace) {
    if (namespace === undefined) {
      let total = 0;
      for (const map of namespaces.values()) {
        total += map.size;
      }
      return total;
    }
    const map = namespaces.get(namespace);
    return map ? map.size : 0;
  }

  return { materialize, prune, retainNamespaces, stats, resetStats, size };
}
