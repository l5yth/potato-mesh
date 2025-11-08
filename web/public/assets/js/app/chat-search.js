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

import { CHAT_LOG_ENTRY_TYPES } from './chat-log-tabs.js';
import { formatPositionHighlights, formatTelemetryHighlights } from './chat-log-highlights.js';

const BASE_SEARCH_KEYS = Object.freeze([
  'node_id',
  'nodeId',
  'id',
  'node_num',
  'nodeNum',
  'num',
  'short_name',
  'shortName',
  'long_name',
  'longName',
  'name',
  'role',
  'hw_model',
  'hwModel',
  'neighbor_id',
  'neighborId'
]);

const MESSAGE_EXTRA_KEYS = Object.freeze([
  'text',
  'emoji',
  'channel',
  'channel_index',
  'channelIndex',
  'channel_name',
  'channelName',
  'channel_display',
  'channelDisplay',
  'from_id',
  'fromId',
  'to_id',
  'toId',
  'reply_id',
  'replyId'
]);

/**
 * Normalise arbitrary input into a comparable, lower-cased string.
 *
 * @param {*} value User-supplied input.
 * @returns {string} Trimmed, lower-cased query string.
 */
export function normaliseChatFilterQuery(value) {
  if (value == null) {
    return '';
  }
  const text = String(value).trim().toLowerCase();
  return text;
}

/**
 * Apply chat filtering to log entries and channel buckets.
 *
 * @param {{ logEntries?: Array<Object>, channels?: Array<Object> }} model Chat tab model.
 * @param {*} query Filter query supplied by the user.
 * @returns {{ logEntries: Array<Object>, channels: Array<Object> }} Filtered model.
 */
export function filterChatModel(model = {}, query) {
  const logEntries = Array.isArray(model.logEntries) ? model.logEntries : [];
  const channels = Array.isArray(model.channels) ? model.channels : [];
  const normalisedQuery = normaliseChatFilterQuery(query);
  if (!normalisedQuery) {
    return { logEntries, channels };
  }
  const filteredLogs = logEntries.filter(entry => chatLogEntryMatchesQuery(entry, normalisedQuery));
  const filteredChannels = channels.map(channel => ({
    ...channel,
    entries: Array.isArray(channel.entries)
      ? channel.entries.filter(item => chatMessageMatchesQuery(item?.message, normalisedQuery))
      : []
  }));
  return { logEntries: filteredLogs, channels: filteredChannels };
}

/**
 * Determine whether a structured chat log entry matches the query.
 *
 * @param {?Object} entry Chat log entry.
 * @param {string} query Normalised filter query.
 * @returns {boolean} True when the entry should remain visible.
 */
export function chatLogEntryMatchesQuery(entry, query) {
  if (!query) return true;
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  const candidates = [];
  candidates.push(...collectSearchValues(entry.node));
  candidates.push(...collectSearchValues(entry.telemetry));
  candidates.push(...collectSearchValues(entry.position));
  candidates.push(...collectSearchValues(entry.neighbor));
  candidates.push(...collectSearchValues(entry.neighborNode));
  if (entry.nodeId) candidates.push(entry.nodeId);
  if (entry.nodeNum != null && entry.nodeNum !== '') candidates.push(entry.nodeNum);
  if (entry.neighborId) candidates.push(entry.neighborId);
  if (entry.type) candidates.push(entry.type);

  if (entry.type === CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED) {
    if (entry.message && chatMessageMatchesQuery(entry.message, query)) {
      return true;
    }
  } else if (entry.type === CHAT_LOG_ENTRY_TYPES.TELEMETRY) {
    const telemetryHighlights = formatTelemetryHighlights(entry.telemetry || {});
    candidates.push(...highlightsToStrings(telemetryHighlights));
  } else if (entry.type === CHAT_LOG_ENTRY_TYPES.POSITION) {
    const positionHighlights = formatPositionHighlights(entry.position || {});
    candidates.push(...highlightsToStrings(positionHighlights));
  } else if (entry.type === CHAT_LOG_ENTRY_TYPES.NEIGHBOR) {
    if (entry.neighbor && entry.neighbor.neighbor_id) {
      candidates.push(entry.neighbor.neighbor_id);
    }
  }

  return candidates.some(value => valueIncludesQuery(value, query));
}

/**
 * Determine whether a mesh message matches the active query.
 *
 * @param {?Object} message Chat message payload.
 * @param {string} query Normalised filter query.
 * @returns {boolean} True when the message should be shown.
 */
export function chatMessageMatchesQuery(message, query) {
  if (!query) return true;
  if (!message || typeof message !== 'object') {
    return false;
  }
  const candidates = [
    ...collectSearchValues(message, MESSAGE_EXTRA_KEYS),
    ...collectSearchValues(message.node),
  ];
  return candidates.some(value => valueIncludesQuery(value, query));
}

function highlightsToStrings(highlights) {
  if (!Array.isArray(highlights)) {
    return [];
  }
  return highlights
    .map(entry => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const label = entry.label != null ? String(entry.label).trim() : '';
      const value = entry.value != null ? String(entry.value).trim() : '';
      return `${label} ${value}`.trim();
    })
    .filter(Boolean);
}

function collectSearchValues(source, extraKeys = []) {
  if (!source || typeof source !== 'object') {
    return [];
  }
  const values = [];
  const keys = extraKeys.length ? [...BASE_SEARCH_KEYS, ...extraKeys] : BASE_SEARCH_KEYS;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    const value = source[key];
    if (value == null || value === '') {
      continue;
    }
    if (typeof value === 'object') {
      continue;
    }
    values.push(value);
  }
  return values;
}

function valueIncludesQuery(value, query) {
  if (!query) return true;
  if (value == null) {
    return false;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return false;
    }
    return String(value).toLowerCase().includes(query);
  }
  if (typeof value === 'boolean') {
    return (value ? 'true' : 'false').includes(query);
  }
  const text = String(value).trim();
  if (!text) {
    return false;
  }
  return text.toLowerCase().includes(query);
}

export default {
  normaliseChatFilterQuery,
  filterChatModel,
  chatLogEntryMatchesQuery,
  chatMessageMatchesQuery
};
