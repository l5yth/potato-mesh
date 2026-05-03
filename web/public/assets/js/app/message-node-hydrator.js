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
 *   fetchNodeById: (nodeId: string) => Promise<object|null>,
 *   applyNodeFallback: (node: object) => void,
 *   logger?: { warn?: (message?: any, ...optionalParams: any[]) => void },
 *   concurrency?: number
 * }} options Factory configuration.  ``concurrency`` overrides the default
 *   worker-pool size and is primarily intended for unit tests; callers
 *   should leave it unset in production.
 * @returns {{
 *   hydrate: (messages: Array<object>|null|undefined, nodesById: Map<string, object>) => Promise<Array<object>>
 * }} Hydrator API.
 */
export function createMessageNodeHydrator({
  fetchNodeById,
  applyNodeFallback,
  logger = console,
  concurrency = MESSAGE_HYDRATION_CONCURRENCY,
}) {
  if (typeof fetchNodeById !== 'function') {
    throw new TypeError('fetchNodeById must be a function');
  }
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
        return null;
      })
      .catch(error => {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('message node lookup failed', { nodeId: id, error });
        }
        return null;
      })
      .finally(() => {
        inflightLookups.delete(id);
      });

    inflightLookups.set(id, promise);
    return promise;
  }

  /**
   * Attach node information to the provided message collection.
   *
   * Messages whose sender is already in ``nodesById`` are bound synchronously
   * and incur no network traffic.  Misses are pushed onto a shared queue and
   * drained by a fixed worker pool so the number of in-flight
   * ``/api/nodes/:id`` requests never exceeds {@link workerCap}.  This caps
   * the cold-load thundering-herd that would otherwise issue one request per
   * unique sender in parallel.
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

    const workerCount = Math.min(workerCap, queue.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry) return;
        // eslint-disable-next-line no-await-in-loop
        const node = await resolveNode(entry.targetId, nodesById);
        if (node) {
          entry.message.node = node;
        } else {
          const placeholder = { node_id: entry.targetId };
          applyNodeFallback(placeholder);
          entry.message.node = placeholder;
        }
      }
    });
    await Promise.all(workers);

    return messages;
  }

  return { hydrate };
}
