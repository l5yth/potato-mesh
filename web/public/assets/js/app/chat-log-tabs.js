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
 * Discrete event types that can appear in the chat activity log.
 *
 * @type {{
 *   NODE_NEW: 'node-new',
 *   NODE_INFO: 'node-info',
 *   TELEMETRY: 'telemetry',
 *   POSITION: 'position',
 *   NEIGHBOR: 'neighbor'
 * }}
 */
export const CHAT_LOG_ENTRY_TYPES = Object.freeze({
  NODE_NEW: 'node-new',
  NODE_INFO: 'node-info',
  TELEMETRY: 'telemetry',
  POSITION: 'position',
  NEIGHBOR: 'neighbor',
  MESSAGE_ENCRYPTED: 'message-encrypted'
});

/**
 * Build a data model describing the content for chat tabs.
 *
 * Entries outside the recent activity window, encrypted messages, and
 * channels above {@link MAX_CHANNEL_INDEX} are filtered out.
 *
 * @param {{
 *   nodes?: Array<Object>,
 *   telemetry?: Array<Object>,
 *   positions?: Array<Object>,
 *   neighbors?: Array<Object>,
 *   messages?: Array<Object>,
 *   nowSeconds: number,
 *   windowSeconds: number,
 *   maxChannelIndex?: number
 * }} params Aggregation inputs.
 * @returns {{
 *   logEntries: Array<{ ts: number, type: string, nodeId?: string, nodeNum?: number }>,
 *   channels: Array<{ id: string, index: number, label: string, entries: Array<{ ts: number, message: Object }> }>
 * }} Sorted tab model data.
 */
export function buildChatTabModel({
  nodes = [],
  telemetry = [],
  positions = [],
  neighbors = [],
  messages = [],
  nowSeconds,
  windowSeconds,
  maxChannelIndex = MAX_CHANNEL_INDEX
}) {
  const cutoff = (Number.isFinite(nowSeconds) ? nowSeconds : 0) - (Number.isFinite(windowSeconds) ? windowSeconds : 0);
  const logEntries = [];
  const channelBuckets = new Map();

  for (const node of nodes || []) {
    if (!node) continue;
    const nodeId = normaliseNodeId(node);
    const nodeNum = normaliseNodeNum(node);
    const firstTs = resolveTimestampSeconds(node.first_heard ?? node.firstHeard, node.first_heard_iso ?? node.firstHeardIso);
    if (firstTs != null && firstTs >= cutoff) {
      logEntries.push({ ts: firstTs, type: CHAT_LOG_ENTRY_TYPES.NODE_NEW, node, nodeId, nodeNum });
    }
    const lastTs = resolveTimestampSeconds(node.last_heard ?? node.lastHeard, node.last_seen_iso ?? node.lastSeenIso);
    if (lastTs != null && lastTs >= cutoff) {
      logEntries.push({ ts: lastTs, type: CHAT_LOG_ENTRY_TYPES.NODE_INFO, node, nodeId, nodeNum });
    }
  }

  for (const telemetryEntry of telemetry || []) {
    if (!telemetryEntry) continue;
    const ts = resolveTimestampSeconds(
      telemetryEntry.rx_time ?? telemetryEntry.rxTime ?? telemetryEntry.telemetry_time ?? telemetryEntry.telemetryTime,
      telemetryEntry.rx_iso ?? telemetryEntry.rxIso ?? telemetryEntry.telemetry_time_iso ?? telemetryEntry.telemetryTimeIso
    );
    if (ts == null || ts < cutoff) continue;
    const nodeId = normaliseNodeId(telemetryEntry);
    const nodeNum = normaliseNodeNum(telemetryEntry);
    logEntries.push({ ts, type: CHAT_LOG_ENTRY_TYPES.TELEMETRY, telemetry: telemetryEntry, nodeId, nodeNum });
  }

  for (const positionEntry of positions || []) {
    if (!positionEntry) continue;
    const ts = resolveTimestampSeconds(
      positionEntry.rx_time ?? positionEntry.rxTime ?? positionEntry.position_time ?? positionEntry.positionTime,
      positionEntry.rx_iso ?? positionEntry.rxIso ?? positionEntry.position_time_iso ?? positionEntry.positionTimeIso
    );
    if (ts == null || ts < cutoff) continue;
    const nodeId = normaliseNodeId(positionEntry);
    const nodeNum = normaliseNodeNum(positionEntry);
    logEntries.push({ ts, type: CHAT_LOG_ENTRY_TYPES.POSITION, position: positionEntry, nodeId, nodeNum });
  }

  for (const neighborEntry of neighbors || []) {
    if (!neighborEntry) continue;
    const ts = resolveTimestampSeconds(neighborEntry.rx_time ?? neighborEntry.rxTime, neighborEntry.rx_iso ?? neighborEntry.rxIso);
    if (ts == null || ts < cutoff) continue;
    const nodeId = normaliseNodeId(neighborEntry);
    const nodeNum = normaliseNodeNum(neighborEntry);
    const neighborId = normaliseNeighborId(neighborEntry);
    logEntries.push({ ts, type: CHAT_LOG_ENTRY_TYPES.NEIGHBOR, neighbor: neighborEntry, nodeId, nodeNum, neighborId });
  }

  for (const message of messages || []) {
    if (!message) continue;
    const ts = resolveTimestampSeconds(message.rx_time ?? message.rxTime, message.rx_iso ?? message.rxIso);
    if (ts == null || ts < cutoff) continue;

    if (message.encrypted) {
      logEntries.push({ ts, type: CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED, message });
      continue;
    }

    const rawIndex = message.channel ?? message.channel_index ?? message.channelIndex;
    const channelIndex = normaliseChannelIndex(rawIndex);
    if (channelIndex != null && channelIndex > maxChannelIndex) {
      continue;
    }
    const channelName = normaliseChannelName(
      message.channel_name ?? message.channelName ?? message.channel_display ?? message.channelDisplay
    );
    const safeIndex = channelIndex != null && channelIndex >= 0 ? channelIndex : 0;
    const bucketKey = buildChannelBucketKey(safeIndex, channelName);
    let bucket = channelBuckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        key: bucketKey,
        id: buildChannelTabId(bucketKey),
        index: safeIndex,
        label: channelName || String(safeIndex),
        entries: [],
        hasExplicitName: Boolean(channelName),
        isPrimaryFallback: bucketKey === '0'
      };
      channelBuckets.set(bucketKey, bucket);
    } else if (channelName && !bucket.hasExplicitName) {
      bucket.label = channelName;
      bucket.hasExplicitName = true;
    }

    bucket.entries.push({ ts, message });
  }

  logEntries.sort((a, b) => a.ts - b.ts);

  let hasPrimaryBucket = false;
  for (const bucket of channelBuckets.values()) {
    if (bucket.index === 0) {
      hasPrimaryBucket = true;
      break;
    }
  }
  if (!hasPrimaryBucket) {
    const bucketKey = '0';
    channelBuckets.set(bucketKey, {
      key: bucketKey,
      id: buildChannelTabId(bucketKey),
      index: 0,
      label: '0',
      entries: [],
      hasExplicitName: false,
      isPrimaryFallback: true
    });
  }

  const channels = Array.from(channelBuckets.values()).sort((a, b) => {
    if (a.index !== b.index) {
      return a.index - b.index;
    }
    return a.label.localeCompare(b.label);
  });
  for (const channel of channels) {
    channel.entries.sort((a, b) => a.ts - b.ts);
  }

  return { logEntries, channels };
}

/**
 * Extract a canonical node identifier from a payload when available.
 *
 * @param {*} value Arbitrary payload candidate.
 * @returns {?string} Canonical node identifier.
 */
function normaliseNodeId(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = value.node_id ?? value.nodeId ?? null;
  return typeof raw === 'string' && raw.trim().length ? raw.trim() : null;
}

/**
 * Extract a canonical neighbour identifier from a payload when available.
 *
 * @param {*} value Arbitrary payload candidate.
 * @returns {?string} Canonical neighbour identifier.
 */
function normaliseNeighborId(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = value.neighbor_id ?? value.neighborId ?? null;
  if (typeof raw === 'string' && raw.trim().length) {
    return raw.trim();
  }
  return null;
}

/**
 * Extract a finite node number from a payload when available.
 *
 * @param {*} value Arbitrary payload candidate.
 * @returns {?number} Canonical numeric identifier.
 */
function normaliseNodeNum(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = value.node_num ?? value.nodeNum ?? value.num;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
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

function buildChannelBucketKey(index, channelName) {
  const safeIndex = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  if (safeIndex === 0 && channelName) {
    return `0::${channelName.toLowerCase()}`;
  }
  return String(safeIndex);
}

function buildChannelTabId(bucketKey) {
  if (bucketKey === '0') {
    return 'channel-0';
  }
  const slug = slugify(bucketKey);
  if (slug) {
    if (slug !== '0') {
      return `channel-${slug}`;
    }
    return `channel-${slug}-${hashChannelKey(bucketKey)}`;
  }
  return `channel-${hashChannelKey(bucketKey)}`;
}

function slugify(value) {
  if (value == null) return '';
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hashChannelKey(value) {
  const input = String(value ?? '');
  if (!input) {
    return '0';
  }
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  if (hash < 0) {
    hash = (hash * -1) >>> 0;
  }
  return hash.toString(36);
}

export const __test__ = {
  resolveTimestampSeconds,
  normaliseChannelIndex,
  normaliseChannelName
};
