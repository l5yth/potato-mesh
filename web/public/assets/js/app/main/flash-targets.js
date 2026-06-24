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
 * Pure helpers that derive *what to flash* from the rows an SSE-ping refresh
 * fetched (SPEC VF3). Kept free of DOM/Leaflet so they unit-test trivially; the
 * actual highlighting lives in {@link module:main/flash}.
 *
 * @module main/flash-targets
 */

/**
 * Collect the canonical node ids touched by one or more delta row arrays.
 *
 * Each `nodes` / `positions` / `telemetry` row carries a `node_id`; this
 * flattens them into a de-duplicated set so the caller can flash each affected
 * node's table row and map marker exactly once. Non-array inputs and rows
 * without a string `node_id` are ignored.
 *
 * @param {...(Array<Object>|*)} rowArrays One or more delta row arrays.
 * @returns {Set<string>} de-duplicated canonical node ids.
 */
export function collectNodeIds(...rowArrays) {
  const ids = new Set();
  for (const rows of rowArrays) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const id = row && typeof row.node_id === 'string' ? row.node_id : null;
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * Collect message ids touched by one or more delta row arrays (the plaintext
 * and encrypted message deltas), as strings so they match `data-message-id`.
 *
 * @param {...(Array<Object>|*)} rowArrays One or more message delta arrays.
 * @returns {Set<string>} de-duplicated message ids.
 */
export function collectMessageIds(...rowArrays) {
  const ids = new Set();
  for (const rows of rowArrays) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const id = row && (row.id ?? row.message_id ?? row.messageId);
      if (id != null && id !== '') ids.add(String(id));
    }
  }
  return ids;
}

/**
 * Derive the message id carried by a rendered chat-log entry, as a string.
 *
 * Channel-tab entries wrap the message as `entry.item`; Log-tab message entries
 * carry it as `entry.message`. Non-message entries (node/position/telemetry/…)
 * have neither and yield null, so only message rows get tagged for flashing.
 *
 * @param {?Object} entry A chat-render entry.
 * @returns {?string} the message id, or null when the entry is not a message.
 */
export function entryMessageId(entry) {
  const message = entry && (entry.item || entry.message);
  if (!message || typeof message !== 'object') return null;
  const id = message.id ?? message.message_id ?? message.messageId;
  return id != null && id !== '' ? String(id) : null;
}
