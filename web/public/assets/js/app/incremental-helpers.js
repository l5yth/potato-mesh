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
 * Extract the maximum timestamp from an array of API records.
 *
 * Inspects the specified fields on each record and returns the highest
 * value found.  Returns 0 when the array is empty or contains no valid
 * timestamps.
 *
 * @param {Array<Object>} records API response rows.
 * @param {Array<string>} [fields] Timestamp field names to inspect.
 * @returns {number} Maximum unix timestamp across all records.
 */
export function maxRecordTimestamp(records, fields = ['rx_time', 'last_heard']) {
  let max = 0;
  if (!Array.isArray(records)) return max;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    for (const field of fields) {
      const val = record[field];
      if (typeof val === 'number' && val > max) max = val;
    }
  }
  return max;
}

/**
 * Merge incremental rows into an existing collection, deduplicating by a
 * key field.  New rows replace existing entries with the same key.
 *
 * @param {Array<Object>} existing Previous full dataset.
 * @param {Array<Object>} incoming New incremental rows.
 * @param {string} keyField Property used for deduplication.
 * @returns {Array<Object>} Merged array.
 */
export function mergeById(existing, incoming, keyField) {
  if (!incoming || incoming.length === 0) return existing;
  const map = new Map();
  for (const item of existing) {
    const key = item[keyField];
    if (key != null) map.set(key, item);
  }
  for (const item of incoming) {
    const key = item[keyField];
    if (key != null) map.set(key, item);
  }
  return Array.from(map.values());
}

/**
 * Merge incremental rows using a composite key built from multiple fields.
 *
 * Behaves like {@link mergeById} but joins the values of several fields
 * into a single string key so records with a composite primary key (e.g.
 * ``node_id`` + ``neighbor_id``) are deduplicated correctly.
 *
 * @param {Array<Object>} existing Previous full dataset.
 * @param {Array<Object>} incoming New incremental rows.
 * @param {Array<string>} keyFields Properties whose values form the composite key.
 * @returns {Array<Object>} Merged array.
 */
export function mergeByCompositeKey(existing, incoming, keyFields) {
  if (!incoming || incoming.length === 0) return existing;

  function buildKey(item) {
    return keyFields.map(f => String(item[f] ?? '')).join('\0');
  }

  const map = new Map();
  for (const item of existing) {
    map.set(buildKey(item), item);
  }
  for (const item of incoming) {
    map.set(buildKey(item), item);
  }
  return Array.from(map.values());
}

/**
 * Trim an array to at most ``limit`` entries, keeping the ones with the
 * highest timestamp value.  Prevents unbounded growth from incremental
 * merges over a long-running browser tab.
 *
 * @param {Array<Object>} records Merged record array.
 * @param {number} limit Maximum number of entries to retain.
 * @param {string} [tsField] Timestamp field name used for sorting.
 * @returns {Array<Object>} Trimmed array (may be the same reference if
 *   already within the limit).
 */
export function trimToLimit(records, limit, tsField = 'rx_time') {
  if (!Array.isArray(records) || records.length <= limit) return records;
  const sorted = records.slice().sort((a, b) => (b[tsField] || 0) - (a[tsField] || 0));
  return sorted.slice(0, limit);
}
