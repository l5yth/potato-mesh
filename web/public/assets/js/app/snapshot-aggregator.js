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
 * Default number of historical entries to retain per snapshot group.
 *
 * @type {number}
 */
export const SNAPSHOT_DEPTH = 7;

/**
 * Determine whether a snapshot value should be considered meaningful when
 * merging historical records. Empty strings, nullish values, and empty
 * containers are treated as missing to avoid overwriting previously known
 * readings with gaps from newer packets.
 *
 * @param {*} value Candidate snapshot value.
 * @returns {boolean} True when the value should be merged into the aggregate.
 */
export function hasSnapshotValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return true;
}

/**
 * Merge snapshot records into a single aggregate representation while
 * retaining a bounded number of recent entries for each logical entity.
 *
 * Entries are grouped by the value returned from {@link options.keyFn}. For
 * each group the newest {@link options.depth} entries (as determined by
 * {@link options.timestampFn}) are retained. The resulting snapshots are then
 * processed from oldest to newest using {@link options.mergeStrategy} to build
 * the aggregate record. Missing values never overwrite previously observed
 * readings to ensure partial packets do not erase telemetry.
 *
 * @param {Array<Object>} entries Raw snapshot entries, typically ordered from
 *   newest to oldest by the caller.
 * @param {{
 *   depth?: number,
 *   keyFn: (entry: Object) => (string|null|undefined),
 *   timestampFn?: (entry: Object) => (number|null|undefined),
 *   mergeStrategy?: (snapshots: Array<Object>) => Object
 * }} options Aggregation behaviour overrides.
 * @returns {Array<{
 *   key: string,
 *   aggregate: Object,
 *   snapshots: Array<Object>,
 *   latestTimestamp: number
 * }>} Aggregated series for each logical key.
 */
export function aggregateSnapshotSeries(entries, options = {}) {
  const depth = Number.isInteger(options.depth) && options.depth > 0 ? options.depth : SNAPSHOT_DEPTH;
  const keyFn = typeof options.keyFn === 'function' ? options.keyFn : () => null;
  const timestampFn = typeof options.timestampFn === 'function' ? options.timestampFn : () => null;
  const mergeStrategy = typeof options.mergeStrategy === 'function' ? options.mergeStrategy : defaultMergeStrategy;

  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const buckets = new Map();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const key = keyFn(entry);
    if (key == null || key === '') continue;

    const timestampCandidate = timestampFn(entry);
    const timestamp = typeof timestampCandidate === 'number' && Number.isFinite(timestampCandidate)
      ? timestampCandidate
      : Number.NEGATIVE_INFINITY;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }

    bucket.push({ entry, timestamp });
    bucket.sort((a, b) => b.timestamp - a.timestamp);
    if (bucket.length > depth) {
      bucket.length = depth;
    }
  }

  const results = [];
  for (const [key, bucket] of buckets.entries()) {
    const sortedSnapshots = bucket
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(item => item.entry);

    const aggregate = mergeStrategy(sortedSnapshots);
    const latestTimestamp = bucket.reduce(
      (acc, item) => (item.timestamp > acc ? item.timestamp : acc),
      Number.NEGATIVE_INFINITY,
    );

    results.push({ key, aggregate, snapshots: sortedSnapshots, latestTimestamp });
  }

  return results;
}

/**
 * Default merge function used by {@link aggregateSnapshotSeries}. The oldest
 * snapshot provides the initial baseline while newer snapshots augment or
 * replace fields when the incoming values are considered meaningful.
 *
 * @param {Array<Object>} snapshots Ordered snapshots (oldest to newest).
 * @returns {Object} Shallow aggregate containing merged fields.
 */
function defaultMergeStrategy(snapshots) {
  const merged = {};
  if (!Array.isArray(snapshots)) {
    return merged;
  }
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== 'object') continue;
    for (const [field, value] of Object.entries(snapshot)) {
      if (!hasSnapshotValue(value)) continue;
      merged[field] = value;
    }
  }
  return merged;
}

export const __testUtils = { defaultMergeStrategy };

