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
 * Canonical persistent-cache keys for dashboard records (SPEC FC1).
 *
 * @module main/cache-keys
 */

/**
 * Derive the cache key for a record in ``collection``:
 *
 *  - ``nodes`` key on the canonical node id (``node_id``);
 *  - ``neighbors`` on the composite ``node_id|neighbor_id`` (a directed edge);
 *  - every other collection on the record ``id``.
 *
 * Both snake_case and camelCase field spellings are accepted.
 *
 * @param {string} collection Cache collection name.
 * @param {?Object} record API record.
 * @returns {?string} The cache key, or null when the record lacks the field(s).
 */
export function cacheKeyFor(collection, record) {
  if (!record || typeof record !== 'object') return null;
  if (collection === 'neighbors') {
    const nodeId = record.node_id ?? record.nodeId;
    const neighborId = record.neighbor_id ?? record.neighborId;
    return nodeId != null && neighborId != null ? `${nodeId}|${neighborId}` : null;
  }
  if (collection === 'nodes') {
    const id = record.node_id ?? record.nodeId;
    return id != null ? String(id) : null;
  }
  const id = record.id ?? record.message_id ?? record.messageId;
  return id != null ? String(id) : null;
}
