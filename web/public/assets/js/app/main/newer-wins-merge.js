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
 * Newer-wins merges of network rows into the dashboard state (SPEC CC6).
 *
 * `mergeById` lets the incoming row win every key collision. A response that
 * lands late can then carry an older version of a row than the one already
 * shown: a first refresh that hung past its bound and answers after the
 * stream's resync (SPEC OR5), or a backward page asked for before the row was
 * updated. That older version stayed until the row changed again. These
 * merges keep, on a collision, the row whose own time is newer: `last_heard`
 * for nodes, `rx_time` for the rest. The incoming row still wins a tie and
 * whenever either time is missing, as before, so a delta's one-second overlap
 * still refreshes the rows it re-sends. Surviving rows keep their place and
 * their object, which the repaint planner relies on (SPEC DR4).
 *
 * @module main/newer-wins-merge
 */

/**
 * A row's own time, or NaN when it has none.
 *
 * @param {Object} row Row.
 * @param {string} timeField Time column.
 * @returns {number}
 */
const timeOf = (row, timeField) => {
  const value = row[timeField];
  return typeof value === 'number' ? value : Number.NaN;
};

/**
 * Merge `incoming` into `existing` by `keyOf`, the newer row winning.
 *
 * @param {Array<Object>} existing Rows held.
 * @param {Array<Object>} incoming Rows that arrived.
 * @param {(row: Object) => *} keyOf Row key; a row whose key is null or
 *   undefined is dropped.
 * @param {string} timeField The rows' own time column.
 * @returns {Array<Object>} The merged rows: `existing` itself when nothing
 *   arrived, else a new array with every held key in its place, then the new
 *   keys in arrival order.
 */
export function mergeNewer(existing, incoming, keyOf, timeField) {
  if (!incoming || incoming.length === 0) return existing;
  const map = new Map();
  for (const item of existing) {
    const key = keyOf(item);
    if (key != null) map.set(key, item);
  }
  for (const item of incoming) {
    const key = keyOf(item);
    if (key == null) continue;
    const held = map.get(key);
    // Only a strictly older time loses; NaN compares false, so a row without
    // a time still replaces as mergeById did.
    if (held !== undefined && timeOf(item, timeField) < timeOf(held, timeField)) continue;
    map.set(key, item);
  }
  return Array.from(map.values());
}

/**
 * {@link mergeNewer} keyed on one field, the newer-wins form of `mergeById`.
 *
 * @param {Array<Object>} existing Rows held.
 * @param {Array<Object>} incoming Rows that arrived.
 * @param {string} keyField Key column.
 * @param {string} timeField The rows' own time column.
 * @returns {Array<Object>} The merged rows.
 */
export function mergeNewerById(existing, incoming, keyField, timeField) {
  return mergeNewer(existing, incoming, row => row[keyField], timeField);
}

/**
 * {@link mergeNewer} keyed on several fields, the newer-wins form of
 * `mergeByCompositeKey` (missing fields read as empty, so no row is dropped).
 *
 * @param {Array<Object>} existing Rows held.
 * @param {Array<Object>} incoming Rows that arrived.
 * @param {Array<string>} keyFields Key columns.
 * @param {string} timeField The rows' own time column.
 * @returns {Array<Object>} The merged rows.
 */
export function mergeNewerByCompositeKey(existing, incoming, keyFields, timeField) {
  return mergeNewer(existing, incoming, row => keyFields.map(field => String(row[field] ?? '')).join('\0'), timeField);
}
