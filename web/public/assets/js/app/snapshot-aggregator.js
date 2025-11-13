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
 * Number of snapshots to merge for each entity when aggregating records.
 *
 * @type {number}
 */
export const SNAPSHOT_WINDOW = 7;

/**
 * Determine whether a candidate behaves like an object.
 *
 * @param {*} value Candidate value to inspect.
 * @returns {boolean} ``true`` when the value is a non-null object.
 */
function isObject(value) {
  return value != null && typeof value === 'object';
}

/**
 * Convert a raw identifier into a trimmed canonical string.
 *
 * @param {*} value Raw identifier.
 * @returns {string|null} Normalised identifier or ``null`` when blank.
 */
function normaliseId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Convert a raw numeric identifier into a finite number.
 *
 * @param {*} value Raw numeric identifier.
 * @returns {number|null} Finite number or ``null`` when coercion fails.
 */
function normaliseNum(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Merge snapshot fields into the destination object, skipping ``null`` values.
 *
 * @param {Object} target Destination object mutated in-place.
 * @param {Object} snapshot Snapshot payload merged into ``target``.
 * @returns {void}
 */
function mergeSnapshotFields(target, snapshot) {
  if (!isObject(target) || !isObject(snapshot)) return;
  for (const key of Object.keys(snapshot)) {
    const value = snapshot[key];
    if (value == null) continue;
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    target[key] = value;
  }
}

/**
 * Build a key resolver that keeps node identifiers and numeric references
 * associated with a single aggregate key.
 *
 * @returns {(entry: Object) => string|null} Key resolver function.
 */
function createNodeKeyResolver() {
  const byId = new Map();
  const byNum = new Map();
  return entry => {
    if (!isObject(entry)) return null;
    const nodeId = normaliseId(entry.node_id ?? entry.nodeId);
    const nodeNum = normaliseNum(entry.node_num ?? entry.nodeNum ?? entry.num);
    if (nodeId && byId.has(nodeId)) {
      const key = byId.get(nodeId);
      if (nodeNum != null && !byNum.has(nodeNum)) {
        byNum.set(nodeNum, key);
      }
      return key;
    }
    if (nodeNum != null && byNum.has(nodeNum)) {
      const key = byNum.get(nodeNum);
      if (nodeId) byId.set(nodeId, key);
      return key;
    }
    let key = null;
    if (nodeId) {
      key = `id:${nodeId}`;
    } else if (nodeNum != null) {
      key = `num:${nodeNum}`;
    }
    if (key) {
      if (nodeId) byId.set(nodeId, key);
      if (nodeNum != null) byNum.set(nodeNum, key);
    }
    return key;
  };
}

/**
 * Ensure a property is attached to the aggregate object without exposing it
 * through enumeration.
 *
 * @param {Object} target Destination aggregate object.
 * @param {string} key Property name to assign.
 * @param {*} value Property value.
 * @returns {void}
 */
function defineHiddenProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

/**
 * Aggregate a collection of snapshots by key, merging up to
 * {@link SNAPSHOT_WINDOW} entries for each logical entity.
 *
 * The supplied ``keySelector`` determines which entries belong to the same
 * aggregate. Snapshots are merged in chronological order (oldest to newest),
 * allowing recent values to override stale ones while retaining older data for
 * fields that may be absent in the latest packet.
 *
 * @template T
 * @param {Array<Object>} entries Raw snapshot entries.
 * @param {{
 *   keySelector: (entry: Object) => string|null,
 *   limit?: number,
 *   merge?: (target: Object, snapshot: Object) => void,
 *   baseFactory?: (snapshot: Object) => T
 * }} options Aggregation behaviour overrides.
 * @returns {Array<T>} Aggregated snapshots.
 */
export function aggregateSnapshots(entries, {
  keySelector,
  limit = SNAPSHOT_WINDOW,
  merge = mergeSnapshotFields,
  baseFactory = () => ({}),
} = {}) {
  if (typeof keySelector !== 'function') {
    throw new TypeError('aggregateSnapshots requires a keySelector function');
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }
  const groups = new Map();
  const maxSnapshots = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SNAPSHOT_WINDOW;
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const key = keySelector(entry);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    if (group.length >= maxSnapshots) continue;
    group.push(entry);
  }
  const aggregates = [];
  for (const group of groups.values()) {
    if (!Array.isArray(group) || group.length === 0) continue;
    const baseSnapshot = group[group.length - 1];
    const target = baseFactory(isObject(baseSnapshot) ? { ...baseSnapshot } : {});
    const orderedSnapshots = [];
    for (let idx = group.length - 1; idx >= 0; idx -= 1) {
      const snapshot = group[idx];
      if (!isObject(snapshot)) continue;
      const clone = { ...snapshot };
      orderedSnapshots.push(clone);
      merge(target, clone);
    }
    defineHiddenProperty(target, 'snapshots', orderedSnapshots);
    defineHiddenProperty(target, 'latestSnapshot', orderedSnapshots[orderedSnapshots.length - 1] ?? null);
    aggregates.push(target);
  }
  return aggregates;
}

/**
 * Aggregate node records into enriched snapshots keyed by identifier.
 *
 * @param {Array<Object>} entries Node records fetched from the API.
 * @param {{ limit?: number }} [options] Aggregation options.
 * @returns {Array<Object>} Aggregated node payloads.
 */
export function aggregateNodeSnapshots(entries, { limit = SNAPSHOT_WINDOW } = {}) {
  const resolveKey = createNodeKeyResolver();
  return aggregateSnapshots(entries, { keySelector: resolveKey, limit });
}

/**
 * Aggregate telemetry packets for each node.
 *
 * @param {Array<Object>} entries Telemetry payloads.
 * @param {{ limit?: number }} [options] Aggregation options.
 * @returns {Array<Object>} Aggregated telemetry data.
 */
export function aggregateTelemetrySnapshots(entries, { limit = SNAPSHOT_WINDOW } = {}) {
  const resolveKey = createNodeKeyResolver();
  return aggregateSnapshots(entries, { keySelector: resolveKey, limit });
}

/**
 * Aggregate position packets for each node.
 *
 * @param {Array<Object>} entries Position payloads.
 * @param {{ limit?: number }} [options] Aggregation options.
 * @returns {Array<Object>} Aggregated position data.
 */
export function aggregatePositionSnapshots(entries, { limit = SNAPSHOT_WINDOW } = {}) {
  const resolveKey = createNodeKeyResolver();
  return aggregateSnapshots(entries, { keySelector: resolveKey, limit });
}

/**
 * Aggregate neighbour packets for each node pair.
 *
 * @param {Array<Object>} entries Neighbour payloads.
 * @param {{ limit?: number }} [options] Aggregation options.
 * @returns {Array<Object>} Aggregated neighbour data.
 */
export function aggregateNeighborSnapshots(entries, { limit = SNAPSHOT_WINDOW } = {}) {
  const resolveSourceKey = createNodeKeyResolver();
  const resolveNeighborKey = createNodeKeyResolver();
  return aggregateSnapshots(entries, {
    limit,
    keySelector: entry => {
      if (!isObject(entry)) return null;
      const sourceKey = resolveSourceKey(entry);
      const neighborId = entry.neighbor_id ?? entry.neighborId;
      const neighborNum = entry.neighbor_num ?? entry.neighborNum;
      const neighborKey = resolveNeighborKey({ node_id: neighborId, node_num: neighborNum });
      if (!sourceKey || !neighborKey) return null;
      return `${sourceKey}->${neighborKey}`;
    },
  });
}

export const __testUtils = {
  isObject,
  normaliseId,
  normaliseNum,
  mergeSnapshotFields,
  createNodeKeyResolver,
  defineHiddenProperty,
};
