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

import { extractModemMetadata } from './node-modem-metadata.js';

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
 *   NEIGHBOR: 'neighbor',
 *   TRACE: 'trace'
 * }}
 */
export const CHAT_LOG_ENTRY_TYPES = Object.freeze({
  NODE_NEW: 'node-new',
  NODE_INFO: 'node-info',
  TELEMETRY: 'telemetry',
  POSITION: 'position',
  NEIGHBOR: 'neighbor',
  TRACE: 'trace',
  MESSAGE_ENCRYPTED: 'message-encrypted'
});

/**
 * Resolve the chronological snapshots associated with an aggregated entry.
 *
 * @param {*} entry Candidate snapshot or aggregate.
 * @returns {Array<Object>} Chronologically ordered snapshots.
 */
function resolveSnapshotList(entry) {
  if (!entry || typeof entry !== 'object') {
    return [];
  }
  const snapshots = entry.snapshots;
  if (Array.isArray(snapshots) && snapshots.length > 0) {
    return snapshots;
  }
  return [entry];
}

/**
 * Build a data model describing the content for chat tabs.
 *
 * Entries outside the recent activity window, encrypted messages, and
 * channels above {@link MAX_CHANNEL_INDEX} are filtered out. Channel
 * buckets are only created when messages are present for that channel.
 *
 * @param {{
 *   nodes?: Array<Object>,
 *   telemetry?: Array<Object>,
 *   positions?: Array<Object>,
 *   neighbors?: Array<Object>,
 *   traces?: Array<Object>,
 *   messages?: Array<Object>,
 *   logOnlyMessages?: Array<Object>,
 *   nowSeconds: number,
 *   windowSeconds: number,
 *   maxChannelIndex?: number,
 *   primaryChannelFallbackLabel?: string|null
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
  traces = [],
  messages = [],
  logOnlyMessages = [],
  nowSeconds,
  windowSeconds,
  maxChannelIndex = MAX_CHANNEL_INDEX,
  primaryChannelFallbackLabel = null
}) {
  const cutoff = (Number.isFinite(nowSeconds) ? nowSeconds : 0) - (Number.isFinite(windowSeconds) ? windowSeconds : 0);
  const logEntries = [];
  const channelBuckets = new Map();
  const primaryChannelEnvLabel = normalisePrimaryChannelEnvLabel(primaryChannelFallbackLabel);

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
    const snapshots = resolveSnapshotList(telemetryEntry);
    for (const snapshot of snapshots) {
      if (!snapshot) continue;
      const ts = resolveTimestampSeconds(
        snapshot.rx_time ?? snapshot.rxTime ?? snapshot.telemetry_time ?? snapshot.telemetryTime,
        snapshot.rx_iso ?? snapshot.rxIso ?? snapshot.telemetry_time_iso ?? snapshot.telemetryTimeIso
      );
      if (ts == null || ts < cutoff) continue;
      const nodeId = normaliseNodeId(snapshot);
      const nodeNum = normaliseNodeNum(snapshot);
      logEntries.push({ ts, type: CHAT_LOG_ENTRY_TYPES.TELEMETRY, telemetry: snapshot, nodeId, nodeNum });
    }
  }

  for (const positionEntry of positions || []) {
    const snapshots = resolveSnapshotList(positionEntry);
    for (const snapshot of snapshots) {
      if (!snapshot) continue;
      const ts = resolveTimestampSeconds(
        snapshot.rx_time ?? snapshot.rxTime ?? snapshot.position_time ?? snapshot.positionTime,
        snapshot.rx_iso ?? snapshot.rxIso ?? snapshot.position_time_iso ?? snapshot.positionTimeIso
      );
      if (ts == null || ts < cutoff) continue;
      const nodeId = normaliseNodeId(snapshot);
      const nodeNum = normaliseNodeNum(snapshot);
      logEntries.push({ ts, type: CHAT_LOG_ENTRY_TYPES.POSITION, position: snapshot, nodeId, nodeNum });
    }
  }

  for (const neighborEntry of neighbors || []) {
    const snapshots = resolveSnapshotList(neighborEntry);
    for (const snapshot of snapshots) {
      if (!snapshot) continue;
      const ts = resolveTimestampSeconds(snapshot.rx_time ?? snapshot.rxTime, snapshot.rx_iso ?? snapshot.rxIso);
      if (ts == null || ts < cutoff) continue;
      const nodeId = normaliseNodeId(snapshot);
      const nodeNum = normaliseNodeNum(snapshot);
      const neighborId = normaliseNeighborId(snapshot);
      logEntries.push({ ts, type: CHAT_LOG_ENTRY_TYPES.NEIGHBOR, neighbor: snapshot, nodeId, nodeNum, neighborId });
    }
  }

  for (const trace of traces || []) {
    if (!trace) continue;
    const ts = resolveTimestampSeconds(trace.rx_time ?? trace.rxTime, trace.rx_iso ?? trace.rxIso);
    if (ts == null || ts < cutoff) continue;
    const path = buildTracePath(trace);
    if (path.length < 2) continue;
    const firstHop = path[0] || {};
    const traceLabels = path
      .map(hop => {
        if (!hop || typeof hop !== 'object') return null;
        const candidates = [hop.id, hop.raw];
        if (Number.isFinite(hop.num)) {
          candidates.push(String(hop.num));
        }
        return candidates.find(val => val != null && String(val).trim().length > 0) ?? null;
      })
      .filter(value => value != null && value !== '');
    logEntries.push({
      ts,
      type: CHAT_LOG_ENTRY_TYPES.TRACE,
      trace,
      tracePath: path,
      traceLabels,
      nodeId: firstHop.id ?? null,
      nodeNum: firstHop.num ?? null
    });
  }

  const encryptedLogEntries = [];
  const encryptedLogKeys = new Set();

  for (const message of messages || []) {
    if (!message) continue;
    const ts = resolveTimestampSeconds(message.rx_time ?? message.rxTime, message.rx_iso ?? message.rxIso);
    if (ts == null || ts < cutoff) continue;

    if (message.encrypted) {
      const key = buildEncryptedMessageKey(message);
      if (!encryptedLogKeys.has(key)) {
        encryptedLogKeys.add(key);
        encryptedLogEntries.push({ ts, type: CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED, message });
      }
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
    const modemPreset = safeIndex === 0 ? extractModemMetadata(message).modemPreset : null;
    const labelInfo = resolveChannelLabel({
      index: safeIndex,
      channelName,
      modemPreset,
      envFallbackLabel: primaryChannelEnvLabel
    });
    const nameBucketKey = safeIndex > 0 ? buildSecondaryNameBucketKey(labelInfo) : null;
    const primaryBucketKey = safeIndex === 0 && labelInfo.label !== '0' ? buildPrimaryBucketKey(labelInfo.label) : '0';

    let bucketKey = safeIndex === 0 ? primaryBucketKey : nameBucketKey ?? String(safeIndex);
    let bucket = channelBuckets.get(bucketKey);

    if (!bucket && safeIndex > 0) {
      const existingBucketKey = findExistingBucketKeyByIndex(channelBuckets, safeIndex);
      if (existingBucketKey) {
        bucketKey = existingBucketKey;
        bucket = channelBuckets.get(existingBucketKey);
      }
    }

    if (bucket && nameBucketKey && bucket.key !== nameBucketKey) {
      channelBuckets.delete(bucket.key);
      bucket.key = nameBucketKey;
      bucket.id = buildChannelTabId(nameBucketKey);
      channelBuckets.set(nameBucketKey, bucket);
      bucketKey = nameBucketKey;
    }

    if (!bucket) {
      bucket = {
        key: bucketKey,
        id: buildChannelTabId(bucketKey),
        index: safeIndex,
        label: labelInfo.label,
        entries: [],
        labelPriority: labelInfo.priority,
        isPrimaryFallback: bucketKey === '0'
      };
      channelBuckets.set(bucketKey, bucket);
    } else {
      const existingPriority = bucket.labelPriority ?? CHANNEL_LABEL_PRIORITY.INDEX;
      if ((labelInfo.priority ?? CHANNEL_LABEL_PRIORITY.INDEX) > existingPriority) {
        bucket.label = labelInfo.label;
        bucket.labelPriority = labelInfo.priority;
      }
      if (Number.isFinite(safeIndex)) {
        bucket.index = Math.min(bucket.index ?? safeIndex, safeIndex);
      }
    }

    bucket.entries.push({ ts, message });
  }

  const extraLogMessages = Array.isArray(logOnlyMessages) ? logOnlyMessages : [];
  for (const message of extraLogMessages) {
    if (!message || !message.encrypted) continue;
    const ts = resolveTimestampSeconds(message.rx_time ?? message.rxTime, message.rx_iso ?? message.rxIso);
    if (ts == null || ts < cutoff) continue;
    const key = buildEncryptedMessageKey(message);
    if (encryptedLogKeys.has(key)) {
      continue;
    }
    encryptedLogKeys.add(key);
    encryptedLogEntries.push({ ts, type: CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED, message });
  }

  if (encryptedLogEntries.length > 0) {
    logEntries.push(...encryptedLogEntries);
  }

  logEntries.sort((a, b) => a.ts - b.ts);

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
 * Build a stable key for encrypted message de-duplication when merging feeds.
 *
 * @param {?Object} message Chat message payload.
 * @returns {string} Stable deduplication key.
 */
function buildEncryptedMessageKey(message) {
  if (!message || typeof message !== 'object') {
    return 'encrypted:unknown';
  }
  const rawId = pickFirstPropertyValue(message, ['id', 'packet_id', 'packetId']);
  if (rawId != null && rawId !== '') {
    const id = String(rawId).trim();
    if (id) {
      return `encrypted:id:${id}`;
    }
  }
  const rx = pickFirstPropertyValue(message, ['rx_time', 'rxTime', 'rx_iso', 'rxIso']);
  const fromId = pickFirstPropertyValue(message, ['from_id', 'fromId']);
  const toId = pickFirstPropertyValue(message, ['to_id', 'toId']);
  const replyId = pickFirstPropertyValue(message, ['reply_id', 'replyId']);
  return `encrypted:fallback:${String(rx ?? '')}|${String(fromId ?? '')}|${String(toId ?? '')}|${String(replyId ?? '')}`;
}

/**
 * Retrieve the first present property value from the provided source object.
 *
 * @param {?Object} source Candidate data source.
 * @param {Array<string>} keys Preferred property order.
 * @returns {*|null} First matching property value, otherwise null.
 */
function pickFirstPropertyValue(source, keys) {
  if (!source || typeof source !== 'object' || !Array.isArray(keys)) {
    return null;
  }
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    const value = source[key];
    if (value == null || value === '') {
      continue;
    }
    return value;
  }
  return null;
}

/**
 * Extract a canonical node identifier from a payload when available.
 *
 * @param {*} value Arbitrary payload candidate.
 * @returns {?string} Canonical node identifier.
 */
function coerceFiniteNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('!')) {
      const hex = trimmed.slice(1);
      if (!/^[0-9A-Fa-f]+$/.test(hex)) return null;
      const parsedHex = Number.parseInt(hex, 16);
      return Number.isFinite(parsedHex) ? parsedHex >>> 0 : null;
    }
    if (/^0[xX][0-9A-Fa-f]+$/.test(trimmed)) {
      const parsedHex = Number.parseInt(trimmed, 16);
      return Number.isFinite(parsedHex) ? parsedHex >>> 0 : null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalNodeIdFromNumeric(ref) {
  if (!Number.isFinite(ref)) return null;
  const unsigned = ref >>> 0;
  const hex = unsigned.toString(16).padStart(8, '0');
  return `!${hex}`;
}

function normaliseNodeId(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return canonicalNodeIdFromNumeric(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const canonicalFromNumeric = canonicalNodeIdFromNumeric(coerceFiniteNumber(trimmed));
    return canonicalFromNumeric ?? trimmed;
  }
  if (typeof value !== 'object') return null;
  const rawId = value.node_id ?? value.nodeId ?? null;
  if (rawId != null) {
    const canonical = normaliseNodeId(rawId);
    if (canonical) return canonical;
  }
  const numericRef = value.node_num ?? value.nodeNum ?? value.num;
  const numericId = canonicalNodeIdFromNumeric(coerceFiniteNumber(numericRef));
  if (numericId) return numericId;
  return null;
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
 * Build an ordered trace path of node identifiers and numeric references.
 *
 * @param {Object} trace Trace payload.
 * @returns {Array<{id: ?string, num: ?number, raw: *}>} Ordered hop descriptors.
 */
function buildTracePath(trace) {
  const path = [];
  const append = value => {
    if (value == null || value === '') return;
    const id = normaliseNodeId(value);
    const num = normaliseNodeNum({ num: value });
    path.push({ id, num, raw: value });
  };
  append(trace.src ?? trace.source ?? trace.from);
  const hops = Array.isArray(trace.hops) ? trace.hops : [];
  for (const hop of hops) {
    append(hop);
  }
  append(trace.dest ?? trace.destination ?? trace.to);
  return path;
}

/**
 * Extract a finite node number from a payload when available.
 *
 * @param {*} value Arbitrary payload candidate.
 * @returns {?number} Canonical numeric identifier.
 */
function normaliseNodeNum(value) {
  if (Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const fromObject = value && typeof value === 'object'
    ? coerceFiniteNumber(value.node_num ?? value.nodeNum ?? value.num)
    : null;
  if (fromObject != null) {
    return Math.trunc(fromObject);
  }
  const parsed = coerceFiniteNumber(value);
  return parsed != null ? Math.trunc(parsed) : null;
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

function buildPrimaryBucketKey(primaryChannelLabel) {
  if (primaryChannelLabel) {
    const trimmed = primaryChannelLabel.trim();
    if (trimmed.length > 0 && trimmed !== '0') {
      return `0::${trimmed.toLowerCase()}`;
    }
  }
  return '0';
}

function buildSecondaryNameBucketKey(labelInfo) {
  const label = labelInfo?.label ?? null;
  const priority = labelInfo?.priority ?? CHANNEL_LABEL_PRIORITY.INDEX;
  if (priority !== CHANNEL_LABEL_PRIORITY.NAME || !label) {
    return null;
  }
  const trimmedLabel = label.trim().toLowerCase();
  if (!trimmedLabel.length) {
    return null;
  }
  return `secondary::${trimmedLabel}`;
}

function findExistingBucketKeyByIndex(channelBuckets, targetIndex) {
  if (!channelBuckets || !Number.isFinite(targetIndex) || targetIndex <= 0) {
    return null;
  }
  const normalizedTarget = Math.trunc(targetIndex);
  for (const [key, bucket] of channelBuckets.entries()) {
    if (!bucket || !Number.isFinite(bucket.index)) {
      continue;
    }
    if (Math.trunc(bucket.index) !== normalizedTarget) {
      continue;
    }
    if (bucket.index === 0) {
      continue;
    }
    return key;
  }
  return null;
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

const CHANNEL_LABEL_PRIORITY = Object.freeze({
  INDEX: 0,
  ENV: 1,
  MODEM: 2,
  NAME: 3
});

function resolveChannelLabel({ index, channelName, modemPreset, envFallbackLabel }) {
  const safeIndex = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  if (safeIndex === 0) {
    if (channelName) {
      return { label: channelName, priority: CHANNEL_LABEL_PRIORITY.NAME };
    }
    if (modemPreset) {
      return { label: modemPreset, priority: CHANNEL_LABEL_PRIORITY.MODEM };
    }
    if (envFallbackLabel) {
      return { label: envFallbackLabel, priority: CHANNEL_LABEL_PRIORITY.ENV };
    }
    return { label: '0', priority: CHANNEL_LABEL_PRIORITY.INDEX };
  }
  if (channelName) {
    return { label: channelName, priority: CHANNEL_LABEL_PRIORITY.NAME };
  }
  return { label: String(safeIndex), priority: CHANNEL_LABEL_PRIORITY.INDEX };
}

function normalisePrimaryChannelEnvLabel(value) {
  const trimmed = normaliseChannelName(value);
  if (!trimmed) {
    return null;
  }
  const withoutHash = trimmed.replace(/^#+/, '').trim();
  return withoutHash.length > 0 ? withoutHash : null;
}

export const __test__ = {
  resolveTimestampSeconds,
  normaliseChannelIndex,
  normaliseChannelName
};
