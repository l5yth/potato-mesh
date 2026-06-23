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
 * Default upper bound for in-flight ``/api/nodes/:id`` lookups while the
 * hydrator backfills sender metadata.  Matches the worker-pool size used by
 * ``node-page/role-index.js`` so a thundering herd of cold-load lookups
 * cannot overwhelm the server.
 */
export const MESSAGE_HYDRATION_CONCURRENCY = 4;

/**
 * Build a hydrator capable of attaching node metadata to chat messages.
 *
 * @param {{
 *   fetchNodeById?: ((nodeId: string) => Promise<object|null>)|null,
 *   applyNodeFallback: (node: object) => void,
 *   logger?: { warn?: (message?: any, ...optionalParams: any[]) => void },
 *   concurrency?: number
 * }} options Factory configuration.  ``fetchNodeById`` is **optional**: when
 *   omitted (the dashboard default) the hydrator runs in *map-only* mode,
 *   resolving senders purely from the supplied ``nodesById`` map and emitting an
 *   ``!id`` placeholder on a miss with zero network traffic. Supplying a fetcher
 *   re-enables the bounded per-node backfill (the opt-in batched path).
 *   ``concurrency`` overrides the default worker-pool size and is primarily
 *   intended for unit tests; callers should leave it unset in production.
 * @returns {{
 *   hydrate: (messages: Array<object>|null|undefined, nodesById: Map<string, object>) => Promise<Array<object>>
 * }} Hydrator API.
 */
export function createMessageNodeHydrator({
  fetchNodeById = null,
  applyNodeFallback,
  logger = console,
  concurrency = MESSAGE_HYDRATION_CONCURRENCY,
}) {
  // ``fetchNodeById`` is optional — its presence switches the hydrator between
  // map-only mode (no network) and the per-node backfill mode.
  const networkEnabled = typeof fetchNodeById === 'function';
  if (typeof applyNodeFallback !== 'function') {
    throw new TypeError('applyNodeFallback must be a function');
  }
  // Treat any non-positive or non-finite value as "fall back to default".  This
  // keeps the hydrator robust against accidental misconfiguration without
  // degrading to unbounded parallelism.
  const workerCap =
    Number.isFinite(concurrency) && concurrency > 0
      ? Math.floor(concurrency)
      : MESSAGE_HYDRATION_CONCURRENCY;

  /** @type {Map<string, Promise<object|null>>} */
  const inflightLookups = new Map();

  // Negative-result cache shared across all ``hydrate()`` invocations on
  // this hydrator instance.  Without it, every refresh tick would re-issue
  // ``/api/nodes/:id`` for senders that the server has already returned
  // 404 for once — turning a single dead participant in a busy chat into a
  // perpetual per-minute fetch.  The set is consulted *after* the fresh
  // ``nodesById`` lookup, so a node that registers later (and therefore
  // appears in the bulk /api/nodes refresh) immediately wins over a stale
  // missing entry without any explicit invalidation.
  /** @type {Set<string>} */
  const missingNodeIds = new Set();

  /**
   * Normalise potential node identifiers into canonical strings.
   *
   * @param {*} value Raw node identifier value.
   * @returns {string} Trimmed identifier or empty string when invalid.
   */
  function normalizeNodeId(value) {
    if (value == null) return '';
    const source = typeof value === 'string' ? value : String(value);
    const trimmed = source.trim();
    return trimmed.length > 0 ? trimmed : '';
  }

  /**
   * Resolve the node metadata for the provided identifier.
   *
   * @param {string} nodeId Canonical node identifier.
   * @param {Map<string, object>} nodesById Existing node cache.
   * @returns {Promise<object|null>} Resolved node or null when unavailable.
   */
  async function resolveNode(nodeId, nodesById) {
    const id = normalizeNodeId(nodeId);
    if (!id) return null;
    if (nodesById instanceof Map && nodesById.has(id)) {
      return nodesById.get(id);
    }
    if (missingNodeIds.has(id)) {
      return null;
    }
    if (inflightLookups.has(id)) {
      return inflightLookups.get(id);
    }

    const promise = Promise.resolve()
      .then(() => fetchNodeById(id))
      .then(node => {
        if (node && typeof node === 'object') {
          applyNodeFallback(node);
          if (nodesById instanceof Map) {
            nodesById.set(id, node);
          }
          return node;
        }
        missingNodeIds.add(id);
        return null;
      })
      .catch(error => {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('message node lookup failed', { nodeId: id, error });
        }
        missingNodeIds.add(id);
        return null;
      })
      .finally(() => {
        inflightLookups.delete(id);
      });

    inflightLookups.set(id, promise);
    return promise;
  }

  /**
   * Attach an ``!id`` placeholder node to a message whose sender could not be
   * resolved from the bulk map (and, in network mode, was not found via lookup).
   * The message's protocol is copied onto the placeholder so the fallback label
   * and badge palette match the channel the sender appeared in; without this
   * hint ``applyNodeFallback`` would default to the neutral ``Unknown`` label,
   * even for MeshCore chats whose messages explicitly carry
   * ``protocol: "meshcore"``.
   *
   * @param {object} message Message whose ``node`` is being assigned.
   * @param {string} targetId Canonical sender identifier.
   * @returns {void}
   */
  function assignPlaceholder(message, targetId) {
    const placeholder = { node_id: targetId };
    const messageProtocol = message && message.protocol;
    if (messageProtocol != null) {
      placeholder.protocol = messageProtocol;
    }
    applyNodeFallback(placeholder);
    message.node = placeholder;
  }

  /**
   * Attach node information to the provided message collection.
   *
   * Messages whose sender is already in ``nodesById`` are bound synchronously
   * and incur no network traffic.  In **map-only** mode (no ``fetchNodeById``)
   * every remaining miss becomes an ``!id`` placeholder with no requests at all.
   * When a fetcher is supplied, misses are instead pushed onto a shared queue
   * and drained by a fixed worker pool so the number of in-flight
   * ``/api/nodes/:id`` requests never exceeds {@link workerCap} — capping the
   * cold-load thundering-herd that would otherwise issue one request per unique
   * sender in parallel.
   *
   * @param {Array<object>|null|undefined} messages Message payloads from the API.
   * @param {Map<string, object>} nodesById Lookup table of known nodes.
   * @returns {Promise<Array<object>>} Hydrated message entries.
   */
  async function hydrate(messages, nodesById) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return Array.isArray(messages) ? messages : [];
    }

    const queue = [];
    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        continue;
      }

      const explicitId = normalizeNodeId(message.node_id ?? message.nodeId ?? '');
      const fallbackId = normalizeNodeId(message.from_id ?? message.fromId ?? '');
      const targetId = explicitId || fallbackId;

      if (!targetId) {
        message.node = null;
        continue;
      }

      message.node_id = targetId;
      const existing = nodesById instanceof Map ? nodesById.get(targetId) : null;
      if (existing) {
        message.node = existing;
        continue;
      }

      queue.push({ message, targetId });
    }

    if (queue.length === 0) {
      return messages;
    }

    // Map-only mode: with no fetcher there is nothing to look up, so every miss
    // resolves to an ``!id`` placeholder synchronously — no worker pool, no
    // network requests.
    if (!networkEnabled) {
      for (const entry of queue) {
        assignPlaceholder(entry.message, entry.targetId);
      }
      return messages;
    }

    // Workers share a monotonically advancing index instead of mutating the
    // queue with ``shift()`` — ``Array#shift`` is O(n) and would turn a
    // large hydration burst into O(n²).  Single-threaded JS makes the
    // post-increment atomic with respect to other workers, so no lock or
    // existence check is needed.
    let cursor = 0;
    const workerCount = Math.min(workerCap, queue.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < queue.length) {
        const entry = queue[cursor++];
        // eslint-disable-next-line no-await-in-loop
        const node = await resolveNode(entry.targetId, nodesById);
        if (node) {
          entry.message.node = node;
        } else {
          assignPlaceholder(entry.message, entry.targetId);
        }
      }
    });
    await Promise.all(workers);

    return messages;
  }

  return { hydrate };
}
