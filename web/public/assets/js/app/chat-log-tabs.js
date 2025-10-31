/*
 * Copyright (C) 2025 l5yth
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
 * Highest channel index that should be represented within the tab view.
 * @type {number}
 */
export const MAX_CHANNEL_INDEX = 9;

/**
 * Build a data model describing the content for chat tabs.
 *
 * Entries outside the recent activity window, encrypted messages, and
 * channels above {@link MAX_CHANNEL_INDEX} are filtered out.
 *
 * @param {{
 *   nodes?: Array<Object>,
 *   messages?: Array<Object>,
 *   nowSeconds: number,
 *   windowSeconds: number,
 *   maxChannelIndex?: number
 * }} params Aggregation inputs.
 * @returns {{
 *   logEntries: Array<{ ts: number, node: Object }>,
 *   channels: Array<{ index: number, label: string, entries: Array<{ ts: number, message: Object }> }>
 * }} Sorted tab model data.
 */
export function buildChatTabModel({
  nodes = [],
  messages = [],
  telemetry = [],
  positions = [],
  neighbors = [],
  nowSeconds,
  windowSeconds,
  maxChannelIndex = MAX_CHANNEL_INDEX
}) {
  const cutoff = (Number.isFinite(nowSeconds) ? nowSeconds : 0) - (Number.isFinite(windowSeconds) ? windowSeconds : 0);
  const logEntries = [];
  const channelBuckets = new Map();
  const nodeLookup = buildNodeLookup(nodes);
  const includeEntry = entry => {
    if (!entry || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) {
      return;
    }
    if (entry.ts < cutoff) {
      return;
    }
    logEntries.push(entry);
  };

  for (const node of nodes || []) {
    if (!node) continue;
    const ts = resolveTimestampSeconds(node.first_heard ?? node.firstHeard, node.first_heard_iso ?? node.firstHeardIso);
    if (ts == null) continue;
    includeEntry({ ts, kind: 'node', node, record: node });
  }

  for (const entry of telemetry || []) {
    if (!entry || typeof entry !== 'object') continue;
    const ts = resolveLogTimestamp(entry, ['rx_time', 'rxTime', 'telemetry_time', 'telemetryTime'], [
      'rx_iso',
      'rxIso',
      'telemetry_time_iso',
      'telemetryTimeIso'
    ]);
    if (ts == null) continue;
    includeEntry({
      ts,
      kind: 'telemetry',
      record: entry,
      node: resolveNodeForRecord(entry, nodeLookup)
    });
  }

  for (const entry of positions || []) {
    if (!entry || typeof entry !== 'object') continue;
    const ts = resolveLogTimestamp(entry, ['rx_time', 'rxTime', 'position_time', 'positionTime'], [
      'rx_iso',
      'rxIso',
      'position_time_iso',
      'positionTimeIso'
    ]);
    if (ts == null) continue;
    includeEntry({
      ts,
      kind: 'position',
      record: entry,
      node: resolveNodeForRecord(entry, nodeLookup)
    });
  }

  for (const entry of neighbors || []) {
    if (!entry || typeof entry !== 'object') continue;
    const ts = resolveLogTimestamp(entry, ['rx_time', 'rxTime'], ['rx_iso', 'rxIso']);
    if (ts == null) continue;
    includeEntry({
      ts,
      kind: 'neighbor',
      record: entry,
      node: resolveNodeForRecord(entry, nodeLookup)
    });
  }

  logEntries.sort((a, b) => a.ts - b.ts);

  for (const message of messages || []) {
    if (!message || message.encrypted) continue;
    const ts = resolveTimestampSeconds(message.rx_time ?? message.rxTime, message.rx_iso ?? message.rxIso);
    if (ts == null || ts < cutoff) continue;

    const rawIndex = message.channel ?? message.channel_index ?? message.channelIndex;
    const channelIndex = normaliseChannelIndex(rawIndex);
    if (channelIndex != null && channelIndex > maxChannelIndex) {
      continue;
    }
    const safeIndex = channelIndex != null && channelIndex >= 0 ? channelIndex : 0;
    const bucketKey = safeIndex;
    let bucket = channelBuckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        index: safeIndex,
        label: String(safeIndex),
        entries: [],
        hasExplicitName: false
      };
      channelBuckets.set(bucketKey, bucket);
    }

    const channelName = normaliseChannelName(
      message.channel_name ?? message.channelName ?? message.channel_display ?? message.channelDisplay
    );
    if (channelName && !bucket.hasExplicitName) {
      bucket.label = channelName;
      bucket.hasExplicitName = true;
    }

    bucket.entries.push({ ts, message });
  }

  if (!channelBuckets.has(0)) {
    channelBuckets.set(0, {
      index: 0,
      label: '0',
      entries: [],
      hasExplicitName: false
    });
  }

  const channels = Array.from(channelBuckets.values()).sort((a, b) => a.index - b.index);
  for (const channel of channels) {
    channel.entries.sort((a, b) => a.ts - b.ts);
  }

  return { logEntries, channels };
}

/**
 * Resolve the primary node metadata associated with an auxiliary record.
 *
 * @param {Object} record Telemetry, position, or neighbor record.
 * @param {{ byId: Map<string, Object>, byNum: Map<number, Object> }} lookup Node caches.
 * @returns {?Object} Matching node payload when available.
 */
function resolveNodeForRecord(record, lookup) {
  if (!record || typeof record !== 'object' || !lookup) {
    return null;
  }
  const idCandidates = [record.node_id, record.nodeId, record.id];
  for (const candidate of idCandidates) {
    if (typeof candidate === 'string' && candidate.length && lookup.byId.has(candidate)) {
      return lookup.byId.get(candidate);
    }
  }
  const numCandidates = [record.node_num, record.nodeNum, record.num];
  for (const candidate of numCandidates) {
    const numeric = typeof candidate === 'number' ? candidate : Number(candidate);
    if (Number.isFinite(numeric) && lookup.byNum.has(numeric)) {
      return lookup.byNum.get(numeric);
    }
  }
  return null;
}

/**
 * Construct lookup tables for nodes keyed by identifier and numeric index.
 *
 * @param {Array<Object>} nodes Node collection.
 * @returns {{ byId: Map<string, Object>, byNum: Map<number, Object> }}
 *   Node lookup maps.
 */
function buildNodeLookup(nodes) {
  const byId = new Map();
  const byNum = new Map();
  if (!Array.isArray(nodes)) {
    return { byId, byNum };
  }
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const idCandidates = [node.node_id, node.nodeId, node.id];
    for (const candidate of idCandidates) {
      if (typeof candidate === 'string' && candidate.length) {
        byId.set(candidate, node);
        break;
      }
    }
    const numCandidates = [node.node_num, node.nodeNum, node.num];
    for (const candidate of numCandidates) {
      const numeric = typeof candidate === 'number' ? candidate : Number(candidate);
      if (Number.isFinite(numeric)) {
        byNum.set(numeric, node);
        break;
      }
    }
  }
  return { byId, byNum };
}

/**
 * Determine the timestamp for a record prioritising receive time when present.
 *
 * @param {Object} record Data record containing time metadata.
 * @param {Array<string>} numericFields Ordered numeric timestamp candidates.
 * @param {Array<string>} isoFields Ordered ISO timestamp candidates.
 * @returns {?number} Timestamp in seconds.
 */
function resolveLogTimestamp(record, numericFields, isoFields) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const numeric = firstPresent(...numericFields.map(field => record[field]));
  const iso = firstPresent(...isoFields.map(field => record[field]));
  return resolveTimestampSeconds(numeric, iso);
}

/**
 * Return the first non-nullish, non-empty value from ``candidates``.
 *
 * @param {...*} candidates Candidate values ordered by preference.
 * @returns {*} First present value or ``null`` when all are blank.
 */
function firstPresent(...candidates) {
  for (const value of candidates) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'string' && value.trim().length === 0) {
      continue;
    }
    return value;
  }
  return null;
}

/**
 * Convert candidate values to timestamp seconds when possible.
 *
 * @param {*} numeric Numeric timestamp representation.
 * @param {*} isoString ISO timestamp fallback.
 * @returns {?number} Timestamp in seconds when parsing succeeds.
 */
export function resolveTimestampSeconds(numeric, isoString) {
  if (numeric !== null && numeric !== undefined && numeric !== '') {
    const numericValue = typeof numeric === 'number' ? numeric : Number(numeric);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }
  if (typeof isoString === 'string' && isoString.length) {
    const parsed = Date.parse(isoString);
    if (Number.isFinite(parsed)) {
      return parsed / 1000;
    }
  }
  return null;
}

/**
 * Sanitise channel identifiers into bounded integers.
 *
 * @param {*} value Raw channel index candidate.
 * @returns {?number} Non-negative integer when available.
 */
export function normaliseChannelIndex(value) {
  if (value == null || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return Math.trunc(parsed);
  }
  return null;
}

/**
 * Normalise channel names to trimmed display strings.
 *
 * @param {*} value Raw channel name candidate.
 * @returns {?string} Cleaned channel label when present.
 */
export function normaliseChannelName(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export const __test__ = {
  resolveTimestampSeconds,
  normaliseChannelIndex,
  normaliseChannelName
};
