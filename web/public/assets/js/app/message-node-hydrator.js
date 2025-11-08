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
 * Build a hydrator capable of attaching node metadata to chat messages.
 *
 * @param {{
 *   fetchNodeById: (nodeId: string) => Promise<object|null>,
 *   applyNodeFallback: (node: object) => void,
 *   logger?: { warn?: (message?: any, ...optionalParams: any[]) => void }
 * }} options Factory configuration.
 * @returns {{
 *   hydrate: (messages: Array<object>|null|undefined, nodesById: Map<string, object>) => Promise<Array<object>>
 * }} Hydrator API.
 */
export function createMessageNodeHydrator({ fetchNodeById, applyNodeFallback, logger = console }) {
  if (typeof fetchNodeById !== 'function') {
    throw new TypeError('fetchNodeById must be a function');
  }
  if (typeof applyNodeFallback !== 'function') {
    throw new TypeError('applyNodeFallback must be a function');
  }

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
   * @param {Array<object>|null|undefined} messages Message payloads from the API.
   * @param {Map<string, object>} nodesById Lookup table of known nodes.
   * @returns {Promise<Array<object>>} Hydrated message entries.
   */
  async function hydrate(messages, nodesById) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return Array.isArray(messages) ? messages : [];
    }

    const tasks = [];
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

      const task = resolveNode(targetId, nodesById).then(node => {
        if (node) {
          message.node = node;
        } else {
          const placeholder = { node_id: targetId };
          applyNodeFallback(placeholder);
          message.node = placeholder;
        }
      });
      tasks.push(task);
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }

    return messages;
  }

  return { hydrate };
}
