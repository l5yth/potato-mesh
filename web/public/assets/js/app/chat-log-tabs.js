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
 *   telemetry?: Array<Object>,
 *   positions?: Array<Object>,
 *   neighbors?: Array<Object>,
 *   nowSeconds: number,
 *   windowSeconds: number,
 *   maxChannelIndex?: number
 * }} params Aggregation inputs.
 * @returns {{
 *   logEntries: Array<{
 *     ts: number,
 *     kind: 'node' | 'telemetry' | 'position' | 'neighbor',
 *     node: ?Object,
 *     entry: Object
 *   }>,
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

  const { nodesById, nodesByNum } = buildNodeLookup(nodes);

  const selectNodeRecord = entry => {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const nodeId = typeof entry.node_id === 'string'
      ? entry.node_id
      : (typeof entry.nodeId === 'string' ? entry.nodeId : null);
    if (nodeId && nodesById.has(nodeId)) {
      return nodesById.get(nodeId);
    }
    const nodeNumRaw = entry.node_num ?? entry.nodeNum ?? entry.num;
    if (nodeNumRaw != null) {
      const nodeNum = typeof nodeNumRaw === 'number' ? nodeNumRaw : Number(nodeNumRaw);
      if (Number.isFinite(nodeNum) && nodesByNum.has(nodeNum)) {
        return nodesByNum.get(nodeNum);
      }
    }
    return null;
  };

  for (const node of nodes || []) {
    if (!node) continue;
    const ts = resolveTimestampSeconds(node.first_heard ?? node.firstHeard, node.first_heard_iso ?? node.firstHeardIso);
    if (ts == null || ts < cutoff) continue;
    logEntries.push({ ts, node, entry: node, kind: 'node' });
  }

  const telemetryEntries = Array.isArray(telemetry) ? telemetry : [];
  for (const telemetryEntry of telemetryEntries) {
    if (!telemetryEntry || typeof telemetryEntry !== 'object') continue;
    const ts = selectBestTimestamp([
      { numeric: telemetryEntry.rx_time ?? telemetryEntry.rxTime, iso: telemetryEntry.rx_iso ?? telemetryEntry.rxIso },
      {
        numeric: telemetryEntry.telemetry_time ?? telemetryEntry.telemetryTime,
        iso: telemetryEntry.telemetry_time_iso ?? telemetryEntry.telemetryTimeIso
      }
    ]);
    if (ts == null || ts < cutoff) continue;
    logEntries.push({
      ts,
      kind: 'telemetry',
      node: selectNodeRecord(telemetryEntry),
      entry: telemetryEntry
    });
  }

  const positionEntries = Array.isArray(positions) ? positions : [];
  for (const positionEntry of positionEntries) {
    if (!positionEntry || typeof positionEntry !== 'object') continue;
    const ts = selectBestTimestamp([
      { numeric: positionEntry.rx_time ?? positionEntry.rxTime, iso: positionEntry.rx_iso ?? positionEntry.rxIso },
      { numeric: positionEntry.position_time ?? positionEntry.positionTime, iso: positionEntry.position_time_iso ?? positionEntry.positionTimeIso }
    ]);
    if (ts == null || ts < cutoff) continue;
    logEntries.push({
      ts,
      kind: 'position',
      node: selectNodeRecord(positionEntry),
      entry: positionEntry
    });
  }

  const neighborEntries = Array.isArray(neighbors) ? neighbors : [];
  for (const neighborEntry of neighborEntries) {
    if (!neighborEntry || typeof neighborEntry !== 'object') continue;
    const ts = selectBestTimestamp([
      { numeric: neighborEntry.rx_time ?? neighborEntry.rxTime, iso: neighborEntry.rx_iso ?? neighborEntry.rxIso }
    ]);
    if (ts == null || ts < cutoff) continue;
    logEntries.push({
      ts,
      kind: 'neighbor',
      node: selectNodeRecord(neighborEntry),
      entry: neighborEntry
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
 * Construct lookup tables that map node identifiers and numeric references to
 * their corresponding node records.
 *
 * @param {Array<Object>} nodes Node payloads returned by the API.
 * @returns {{ nodesById: Map<string, Object>, nodesByNum: Map<number, Object> }}
 *   Aggregated lookup tables for ``node_id`` and ``node_num`` fields.
 */
function buildNodeLookup(nodes) {
  const nodesById = new Map();
  const nodesByNum = new Map();
  if (!Array.isArray(nodes)) {
    return { nodesById, nodesByNum };
  }
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const nodeId = typeof node.node_id === 'string'
      ? node.node_id
      : (typeof node.nodeId === 'string' ? node.nodeId : null);
    if (nodeId) {
      nodesById.set(nodeId, node);
    }
    const nodeNumRaw = node.node_num ?? node.nodeNum ?? node.num;
    if (nodeNumRaw != null) {
      const nodeNum = typeof nodeNumRaw === 'number' ? nodeNumRaw : Number(nodeNumRaw);
      if (Number.isFinite(nodeNum)) {
        nodesByNum.set(nodeNum, node);
      }
    }
  }
  return { nodesById, nodesByNum };
}

/**
 * Select the first valid timestamp from ``candidates`` using
 * {@link resolveTimestampSeconds} for conversion.
 *
 * @param {Array<{numeric: *, iso: *}>} candidates Timestamp value pairs.
 * @returns {?number} Timestamp in seconds when available.
 */
function selectBestTimestamp(candidates) {
  if (!Array.isArray(candidates)) {
    return null;
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const ts = resolveTimestampSeconds(candidate.numeric, candidate.iso);
    if (ts != null) {
      return ts;
    }
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
